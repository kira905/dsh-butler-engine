#!/usr/bin/env node
// ============================================================================
// dsh-butler / lib/handoff-adopt.mjs —— A6b「漏网文件分发」候选集构造（2026-09-16 · 卡 AT12）
//
// 定位：`handoff.mjs --arrive` 的 A6（清单分发）**覆盖不到**的文件（`tools/**`、`docs/**`、
//   `dsh/skills/**` 里新增/改版但清单没枚举的那些）**永远到不了本机生产** ⇒ 下一次 Depart 的采集
//   会用旧生产覆盖工作副本 ⇒ 新版被顶掉（今天同一件事咬了三次：卡 AT12 §3.3）。
//
// 本模块只做**只读**的候选集构造与判定；写盘、备份、恢复脚本一律复用 handoff.mjs 既有的
//   `executeDispatch` / `writeRestoreAssets`（= A6 同一套门与安全设计），绝不另造一套。
//
// 候选口径（与方案文档 §3.2 一致）：
//   候选 = git diff --diff-filter=d -z <prevHead>..HEAD       （本次交接 pull 进来的改动）
//        ∩ 路径白名单（tools/** · docs/** · dsh/skills/**）
//        − 排除项（_test · 生成物 · host 专属产物 · 备份件 · 分叉类）
//        − A6 清单已覆盖的 key                                （避免双通道双写）
//        − 内容一致 / 目标不存在但……（内容一致 = 无需分发）
//
// 三个硬约束：
//   1. **只覆盖不删除**：只处理 diff 的 A/C/M/R 类（`--diff-filter=d` 排除删除），永不删生产文件；
//   2. **本文档不写盘**：任何写操作都由 handoff.mjs 的 executeDispatch 执行（它自带逐个备份）；
//   3. **判不出就不分发**（fail-closed）：`prevHead` 不可用、git 报错、本机那份内容无法从仓历史
//      找回 ⇒ 一律剔出候选（不猜、不静默放行）。
//
// 复用（拍板 ⑤「与 AT1 阶段 2 共用同一分发机制」）：本模块的 `collectRepoDiff` /
//   `isAdoptAllowed` / `gitRecoverable` / `buildAdoptCandidates` 都是与「A6b」解耦的纯函数，
//   AT1（attachments 分发）只换白名单与生产映射即可复用同一条管线。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashFile } from './handoff-core.mjs';
import { dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { isForked } from '../../lib/repo-superset.mjs';

export const ADOPT_VERSION = '1.1.0';

/** 持久开关文件（默认 report-only；放行需人工改这一份，或用单轮 CLI `--adopt-apply`）。
 *  AT17（2026-09-16）起，同一份文件还承载 **分发锚** `lastAdoptHead`（见 `readAdoptAnchor`）。 */

/** 开关文件路径：统一入口（legacy 期 = `<home>\butler-handoff-adopt.json`）。 */
export function adoptStatePath(home = dshHome()) { return resolveStatePath(ADOPT_STATE_NAME, { home }).path; }

export const ADOPT_STATE_NAME = 'butler-handoff-adopt.json';

/** 白名单：仓相对路径 → 允许分发到本机生产。新增目录在这里加一行即可（清单只作目录白名单用）。 */
export const ADOPT_ALLOW = [
  /^tools\//,        // 仓3：工具链（今天是重灾区）
  /^docs\//,         // 仓3：文档
  /^dsh\/skills\//,  // 仓1：技能（SKILL.md 属 A 层保护区，由 handoff 的窗口豁免覆盖）
];

/**
 * 排除项（命中即不分发）。分四类，理由都来自 2026-09-16 的实测数据（方案 §1.2）：
 *   · 测试夹具 / 生成物      —— 拍板 ① 明写排除 _test/fixtures 与临时物
 *   · host 专属产物          —— 每机各写自己那份，分发到对端只是污染（且与 FORKED_PATTERNS 同源）
 *   · 备份/临时件            —— `*.bak-*` 之类
 *   · 采集排除的盘外大目录    —— _archive/generated/logs/snapshots
 * ⚠️ 判断顺序：先命中排除即出局（白名单不再兜）。
 */
export const ADOPT_EXCLUDE = [
  /^tools\/_test\//,
  /^tools\/board-snapshots\//,
  /^docs\/坑库\//,                    // P4 渲染物（host 分文件；含 README-<host>.md）
  /^docs\/踩坑大全-/,                  // 同上（带 host 后缀的旧名单份）
  /^docs\/管家报告\/(watch-|external-|shadow-)/,   // P2/P6 每机自写报告
  /^docs\/管家报告\/\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*\.md$/,   // 日报 <date>-<host>.md
  /^rollback-points\//,
  /^_archive\//, /^generated\//, /^logs\//, /^snapshots\//, /^backups\//,
  /\.bak([.\-]|$)/i, /\.tmp$/i, /\.orig$/i, /\.rej$/i, /~$/,
];

/** 判定一条仓相对路径能否进候选（repoName 参与仓1/仓3 的差异判断）。 */
export function isAdoptAllowed(rel, _repoName = '') {
  const r = String(rel).replace(/\\/g, '/');
  for (const re of ADOPT_EXCLUDE) if (re.test(r)) return { ok: false, reason: `excluded:${re.source.slice(0, 24)}` };
  for (const re of ADOPT_ALLOW) if (re.test(r)) {
    if (isForked(r)) return { ok: false, reason: 'forked-pattern' };
    return { ok: true, reason: 'allow' };
  }
  return { ok: false, reason: 'not-in-whitelist' };
}

/** 仓相对路径 → 生产相对路径（仓1 的 `dsh/` 前缀要去掉；仓3 原样）。不认识的仓 → null。 */
export function repoToProdRel(repoName, rel) {
  const r = String(rel).replace(/\\/g, '/');
  if (repoName === 'dsh-core') return r.startsWith('dsh/') ? r.slice(4) : null;
  if (repoName === 'dsh-workspace') return r;
  return null;   // dsh-sessions：会话不属本通道
}

/**
 * 本次交接 pull 进来的改动文件（仓相对路径）。
 * ⚠️ 必须 `-z`：`git diff --name-only` 对非 ASCII 路径输出 C 风格八进制转义 + 双引号
 *    （实测 `"docs/\345\235\221\345\272\223/..."`）⇒ 白名单/正则匹配会静默失效（方案 §1.2 发现③）。
 * ⚠️ `--diff-filter=d`（小写 = 排除）保证「只覆盖不删除」。
 */
export function collectRepoDiff({ dir, prevHead, maxFiles = 5000, timeoutMs = 60_000 } = {}) {
  if (!prevHead) return { ok: false, reason: 'no-prev-head', files: [] };
  if (!fs.existsSync(path.join(dir ?? '', '.git'))) return { ok: false, reason: 'not-a-git-repo', files: [] };
  const chk = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${prevHead}^{commit}`], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  if (chk.status !== 0) return { ok: false, reason: 'prev-head-not-in-history', files: [] };
  const r = spawnSync('git', ['-C', dir, 'diff', '--name-only', '--diff-filter=d', '-z', `${prevHead}..HEAD`], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) return { ok: false, reason: `git-diff-failed:${r.status}`, files: [] };
  const files = String(r.stdout ?? '').split('\0').map((s) => s.trim()).filter(Boolean);
  if (files.length > maxFiles) return { ok: false, reason: `too-many-files:${files.length}`, files: [] };
  return { ok: true, reason: null, files };
}

/**
 * 「本机生产那份内容能否从仓 git 历史找回」——A6b 无基线项的放行依据（方案 §3.3 的 F2b）。
 *
 * 为什么需要：T3 对偶门对「无基线」的文件一律 skipped-unrecorded（保守）。而 `tools/**`、`docs/**`、
 *   `skills/**` 里的**新文件**从来没有过基线 ⇒ 若不放行，第一次总得人工介入（= 没治本）。
 *   判据换一个角度问同一个问题：**覆盖会不会永久丢内容？**
 *     · 本机生产内容能在仓历史里找到（哪怕很旧的版本）⇒ 覆盖后仍可 `git show <rev>:<path>` 找回 ⇒ 安全；
 *     · 找不到（= 本机独有的未采集改动）⇒ **剔出候选**，绝不覆盖。
 * 判据只看内容字节相等，不做启发式；git 报错/取不到历史 ⇒ recoverable=false（fail-closed）。
 */
export function gitRecoverable({ dir, rel, dstPath, maxRevs = 20, timeoutMs = 30_000 } = {}) {
  let dstBuf;
  try { dstBuf = fs.readFileSync(dstPath); } catch (e) { return { recoverable: false, rev: null, checked: 0, reason: `dst-unreadable:${e?.code ?? e}` }; }
  const log = spawnSync('git', ['-C', dir, 'log', `-n${maxRevs}`, '--format=%H', '--', rel], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  if (log.status !== 0) return { recoverable: false, rev: null, checked: 0, reason: `git-log-failed:${log.status}` };
  const revs = String(log.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  let checked = 0;
  for (const rev of revs) {
    const show = spawnSync('git', ['-C', dir, 'show', `${rev}:${rel}`], { timeout: timeoutMs, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
    if (show.status !== 0 || !show.stdout) continue;
    checked++;
    if (Buffer.isBuffer(show.stdout) && show.stdout.equals(dstBuf)) return { recoverable: true, rev: rev.slice(0, 12), checked, reason: null };
  }
  return { recoverable: false, rev: null, checked, reason: revs.length ? 'not-found-in-history' : 'no-history' };
}

/**
 * 构造 A6b 候选集（只读）。
 * @param {{repos:Array<{name:string,dir:string,anchor:string,prodRoot:string,head:string|null,prevHead:string|null,pulled:boolean,coveredKeys?:Set<string>}>, maxRevs?:number, target='both'}} ctx
 * @returns {{candidates:Array<object>, stats:object, skipped:Array<{rel:string,reason:string}>, errors:Array<string>, notes:Array<string>}}
 */
export function buildAdoptCandidates({ repos = [], maxRevs = 20 } = {}) {
  const candidates = [];
  const skipped = [];
  const errors = [];
  const notes = [];
  const stats = { repos: 0, repoDiffFiles: 0, candidates: 0, same: 0, coveredByA6: 0, excluded: 0, notWhitelisted: 0, localUncommitted: 0, srcMissing: 0, anchorUnknown: 0, scannedRepos: [] };

  for (const repo of repos) {
    if (!repo?.pulled) { notes.push(`${repo?.name ?? '?'}: pull 未成功 → 跳过 A6b`); continue; }
    const diff = collectRepoDiff({ dir: repo.dir, prevHead: repo.prevHead });
    if (!diff.ok) {
      notes.push(`${repo.name}: 跳过（${diff.reason}）`);
      if (diff.reason !== 'no-prev-head') errors.push(`${repo.name}: ${diff.reason}`);
      continue;
    }
    stats.repos++;
    stats.repoDiffFiles += diff.files.length;
    stats.scannedRepos.push(repo.name);   // AT17：只有真扫过的仓才允许推进分发锚
    for (const rel of diff.files) {
      const allow = isAdoptAllowed(rel, repo.name);
      if (!allow.ok) {
        if (allow.reason === 'not-in-whitelist') stats.notWhitelisted++;
        else stats.excluded++;
        skipped.push({ rel, reason: allow.reason });
        continue;
      }
      const prodRel = repoToProdRel(repo.name, rel);
      if (!prodRel) { stats.anchorUnknown++; skipped.push({ rel, reason: 'anchor-unknown' }); continue; }
      const key = `${repo.anchor}:${prodRel}`;
      if (repo.coveredKeys?.has(key)) { stats.coveredByA6++; skipped.push({ rel, reason: 'covered-by-a6' }); continue; }
      const src = path.join(repo.dir, rel);
      if (!fs.existsSync(src)) { stats.srcMissing++; skipped.push({ rel, reason: 'src-missing' }); continue; }
      const srcH = hashFile(src);
      if (!srcH) { stats.srcMissing++; skipped.push({ rel, reason: 'src-unhashable' }); continue; }
      const dst = path.join(repo.prodRoot, prodRel.replace(/\//g, path.sep));
      const dstH = hashFile(dst);
      if (dstH && dstH.sha256 === srcH.sha256) { stats.same++; skipped.push({ rel, reason: 'same-content' }); continue; }
      let recover = null;
      if (dstH) {
        // 目标已存在且内容不同 ⇒ 必须证明「本机那份内容能找回」才允许覆盖（否则可能永久丢本机未采集改动）
        recover = gitRecoverable({ dir: repo.dir, rel, dstPath: dst, maxRevs });
        if (!recover.recoverable) {
          stats.localUncommitted++;
          skipped.push({ rel, reason: `local-content-not-in-git:${recover.reason ?? 'unknown'}` });
          continue;
        }
      }
      stats.candidates++;
      candidates.push({
        key, repo: repo.name, repoPath: rel, prodRel, anchor: repo.anchor,
        src, dst, sha256: srcH.sha256, bytes: srcH.bytes,
        adoptNew: !dstH, gitRecoverRev: recover?.rev ?? null,
      });
    }
  }
  return { candidates, stats, skipped, errors, notes };
}

/** 候选集 → 人类可读报告行（handoff.mjs 直接打印）。 */
export function formatAdoptReport(res, { mode = 'report', limit = 40 } = {}) {
  const lines = [];
  const s = res.stats ?? {};
  lines.push(`    模式=${mode === 'apply' ? 'APPLY（会写生产）' : 'report-only（只报告，不写盘）'} · 仓 ${s.repos ?? 0} 个 · 本次 diff ${s.repoDiffFiles ?? 0} 个文件`);
  lines.push(`    候选 ${res.candidates.length} 项（内容一致 ${s.same ?? 0} / A6 已覆盖 ${s.coveredByA6 ?? 0} / 白名单外 ${s.notWhitelisted ?? 0} / 排除项 ${s.excluded ?? 0} / 本机独有内容 ${s.localUncommitted ?? 0} / 源缺失 ${s.srcMissing ?? 0}）`);
  for (const n of res.notes ?? []) lines.push(`    · ${n}`);
  for (const e of res.errors ?? []) lines.push(`    !! ${e}`);
  for (const c of res.candidates.slice(0, limit)) {
    lines.push(`    → ${c.repoPath}  (${c.bytes} B)${c.adoptNew ? ' [新增]' : ` [覆盖 · 旧版可从 git ${c.gitRecoverRev} 找回]`}`);
  }
  if (res.candidates.length > limit) lines.push(`    ...共 ${res.candidates.length} 项`);
  const notable = (res.skipped ?? []).filter((s2) => s2.reason.startsWith('local-content-not-in-git'));
  for (const s2 of notable.slice(0, 10)) lines.push(`    !! 跳过（本机内容不在仓历史，覆盖会永久丢）：${s2.rel}`);
  if (notable.length > 10) lines.push(`    !! ...共 ${notable.length} 项「本机内容不在仓历史」被跳过`);
  return lines;
}

/**
 * 解析本轮模式：**默认 report**（拍板 ①「首次以 report-only 起步」）。
 * 优先级：单轮 CLI（handoff 传入）> 持久配置 > 默认 report。
 * ⚠️ 单轮 CLI **绝不写回**持久配置（防「单轮覆盖静默改掉默认口径」）。
 */
export function resolveAdoptMode({ cliFlag = null, stateFile = null } = {}) {
  if (cliFlag === 'apply' || cliFlag === 'report') return { mode: cliFlag, source: 'cli' };
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (j?.mode === 'apply') return { mode: 'apply', source: 'state' };
      if (j?.mode === 'report') return { mode: 'report', source: 'state' };
      return { mode: 'report', source: 'state-invalid' };
    } catch { return { mode: 'report', source: 'state-unreadable' }; }
  }
  return { mode: 'report', source: 'default' };
}

// ============================================================================
// 分发锚（卡 AT17 · 2026-09-16）—— 治「A6b 只吃本次交接 diff」的退化
//
// 问题：候选集的 diff 起点原本取「上次交接单记录的 HEAD」，而**arrive/depart 都会把记录推到 HEAD**
//   ⇒ 上一轮 arrive 结束时记录 = HEAD ⇒ 本轮 arrive 的 diff 恒为 0 ⇒ 「上一轮因为门/模式/版本没
//   分发成功」的那批文件永远捡不回（现场只能手工把 localHead 退回旧 sha 才触发分发）。
//
// 治本：A6b 用**自己的进度锚** `lastAdoptHead[<repo>]`（持久在既有开关文件里，**不进交接单** ⇒ schema 零改动）：
//   · 起点优先级：`--adopt-since <sha>`（单轮，绝不写回） > 锚 > 交接单 HEAD（锚缺失/不可用的回落）；
//   · 锚只在 **apply 且本轮没有被跳过/失败项** 时推进 ⇒ 被门拦下的项**下轮自动重试**（= 历史积压扫描）；
//   · report 模式不推进（没写盘就不算处理过）。
// 安全边界不变：它只改「从哪个提交开始看」，不扩白名单、不做全量 onlyInRepo 扫描。
// ============================================================================

/** 读分发锚（fail-safe：读不到 / 格式不对 = 无锚，回落交接单口径）。 */
export function readAdoptAnchor(stateFile = null) {
  if (!stateFile || !fs.existsSync(stateFile)) return { lastAdoptHead: {}, reason: 'no-state-file' };
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const raw = j?.lastAdoptHead;
    const out = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && /^[0-9a-fA-F]{7,40}$/.test(v.trim())) out[k] = v.trim();
      }
    }
    return { lastAdoptHead: out, reason: null };
  } catch (e) {
    return { lastAdoptHead: {}, reason: `state-unreadable:${e?.code ?? e}` };
  }
}

/**
 * 本轮 A6b 的 diff 起点。
 * @returns {{since:string|null, source:'cli'|'anchor'|'handoff-record'|'none'}}
 */
export function resolveAdoptSince({ cliSince = null, anchorHead = null, fallbackPrevHead = null } = {}) {
  if (cliSince) return { since: String(cliSince).trim(), source: 'cli' };
  if (anchorHead) return { since: String(anchorHead).trim(), source: 'anchor' };
  if (fallbackPrevHead) return { since: String(fallbackPrevHead).trim(), source: 'handoff-record' };
  return { since: null, source: 'none' };
}

/** 锚能否推进到当前 HEAD（被拦项/失败项必须留给下一轮重试，否则积压被永久丢弃）。 */
export function judgeAnchorAdvance({ mode = 'report', plan = [], forced = false } = {}) {
  if (forced) return { advance: true, reason: 'forced-by-cli（--adopt-advance-anchor）', blocked: 0 };
  if (mode !== 'apply') return { advance: false, reason: 'report-only（未写盘 ⇒ 不算处理过）', blocked: 0 };
  const blocked = (plan ?? []).filter((p) => p.action === 'failed' || (typeof p.action === 'string' && p.action.startsWith('skipped'))).length;
  if (blocked) return { advance: false, reason: `有 ${blocked} 项被跳过/失败（留给下一轮重试）`, blocked };
  return { advance: true, reason: 'apply 且无被跳过项', blocked: 0 };
}
