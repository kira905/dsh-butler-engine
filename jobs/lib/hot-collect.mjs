// dsh-butler / lib/hot-collect.mjs —— 热采（30 分钟档）逐文件增量快照
//
// 来源：docs\管家v2.5-P9会交接与云中继方案-20260910.md
//   §8 热采逐文件快照方式表 + 统一纪律（v3.1 · R1）
//   §5.7 时间语义（热采 30min；`lastHeartbeatAt` = 任一成功 push 即更新）
//   §17.2 T4（双开嫌疑期间禁止热采，fail-closed）
//   假设 A12（本卡登记）：被 abort / 被打断的会话算不算「闭合」→ 结论见 isClosedForHot
//
// 定位（写死的边界）：
//   · 热采 = **生产 → 仓1/仓3 工作副本 → push**，**绝不向生产分发**（分发只属 Arrive）；
//   · 不推 memory.db（§8 写死）；不做语义合并（H2）；不碰 P2 判定（H4）。
//   · 任何一项「有锁 / 校验不过」→ 跳过该项并记 `skipped`，**绝不中断整轮、绝不推撕裂快照**（§8 统一纪律）。
//
// 为什么是独立模块而不是塞进 handoff.mjs：
//   handoff.mjs 是 60KB 的手动交接器且底部有 isMain 守卫（不可安全 import）。
//   热采是**独立进程**（tickd job / 手工一键），只管「搬到工作副本 + 提交 + push」，
//   故单独成库，接口面极小（collectHot），便于单测与沙箱构造。
import fs from 'node:fs';
import { workspaceRoot } from './ws-root.mjs';
import { gitBackupRoot } from './ws-root.mjs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { writeStateText } from '../../src/dsh-butler/lib/dual-write.mjs';
import { readJsonSafe, hashFile, measureRepoVolume } from '../../src/dsh-butler/lib/handoff-core.mjs';
// 体积阈值 / Gitee 配额口径 —— **单一真源**（2026-09-16 拷问 P1：原先与 handoff.mjs 各抄一份）
import { VOLUME_THRESHOLDS, judgeRepoVolume, measureGitVolume, pushVolumeHistory, estimateGrowth } from '../../src/dsh-butler/lib/repo-volume-thresholds.mjs';
export { VOLUME_THRESHOLDS, judgeRepoVolume, measureGitVolume, pushVolumeHistory, estimateGrowth };
import { decodeZstdFrames, discoverSessionFiles } from '../../src/dsh-butler/lib/pitfall-scan.mjs';
import { classifyTail } from '../../src/dsh-butler/lib/restart.mjs';
import { judgeSyncSafety } from '../../src/dsh-butler/lib/push-guard.mjs';
// 内容级兜底（仅"无同步基准"时才跑）：与 dsh-backup-sync.ps1 -Push 的挡推门**同一份判据**（不另造一套）
import { checkRepo } from '../../src/lib/repo-superset.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../src/lib/production-guard.mjs';

/** 唯一删口（R-065）：dry-run 是本函数**第一条**可执行语句；被拒 ⇒ 返回 false（调用方按「没删」处理）。 */
function removeGuarded(target, { whitelist, reason = null, dryRun = false, allowReparse = false, op = '删文件' } = {}) {
  if (dryRun === true) return false;
  const g = gateDestructive({
    targets: [{ path: target, label: reason }], whitelist, op, scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return false;
  try { fs.rmSync(target, { force: true }); return true; } catch { return false; }
}

/** 唯一搬移口（R-065）：同卷 rename 的**原子替换**语义。dry-run 同样是第一条可执行语句。 */
function renameGuarded(from, to, { whitelist, reason = null, dryRun = false, allowReparse = false } = {}) {
  if (dryRun === true) return { ok: true, dryRun: true, code: 'dry-run', reason: 'dry-run（零动作）' };
  const g = gateDestructive({
    targets: [{ path: from, label: 'src' }, { path: to, label: 'dst' }], whitelist, op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return { ok: false, code: g.code, reason: g.reason };
  try { fs.renameSync(from, to); return { ok: true, code: null, reason: g.reason }; }
  catch (e) { return { ok: false, code: 'fs-error', reason: String(e?.message ?? e) }; }
}


export const HOT_COLLECT_VERSION = '0.2.0';

/** 体积阈值（§5.4 R6）—— 定义已迁到 `lib/repo-volume-thresholds.mjs`（单一真源，顶部 import + re-export）。
 *  2026-09-16 拷问 P1 修复：原先与 `handoff.mjs` 各抄一份阈值表；且口径（全树 vs `.git`）没写清——
 *  实测 dsh-sessions 全树 1003.5MB / `.git` 仅 596.8MB，按全树算会提前误报。
 *  现判据 = `.git` 大小（与 Gitee 1024MB 配额同量纲）+ 配额余量比两层。 */


/** Host API 只读导出（§8 表：账本走 Host API，不复制文件）。 */
export const HOST_BASE = 'http://localhost:3080';

// ---------------------------------------------------------------- 热采对象清单

/**
 * 热采对象条目。两种形态：
 *   { kind:'file', repo, src, repoPath }                —— 单文件
 *   { kind:'tree', repo, srcDir, repoDir, filter? }     —— 目录递归（tree 用 filter 决定收哪些）
 *
 * ⚠️ **本清单 = 热采口径的单一数据源**。它与 handoff-manifest.json（Arrive 分发清单）**不是同一张表**：
 *    Arrive 关心「哪些要往生产写」，热采关心「哪些要从生产读」。两张表都只写锚点 + 相对路径。
 */
export const HOT_SPECS_ALL = [
  // —— 仓1（dsh-core）：~/.dsh 稳态小文件 ——
  // ⚠️ **本机 butler-handoff.json 刻意不进仓**：state-files 登记它是 `sync:false` 的**单机时间窗口状态**
  //    （双机共享会互相压制告警），跨机可见的是仓内副本 `dsh/butler-handoff/<host>.json`（下面 tree 那条）。
  { kind: 'file', repo: 'dsh-core', src: 'butler-version.json', repoPath: 'dsh/butler-version.json', sync: true },
  // 交接版本门文件（§5.3 第 1 条）：本机那份权威、仓内那份供对端读 minSupported → 必须热采过去
  { kind: 'file', repo: 'dsh-core', src: 'handoff-version.json', repoPath: 'dsh/handoff-version.json', sync: true },

  // —— 看板账本（唯一权威 = Host API 只读导出，**不在本清单里**，见 exportLedgerSnapshot）——

  // 坑库 / 坑库学习状态 / 候选池：跨机共享语义（§4.3 A 类），三份都是 host 分叉单机文件
  { kind: 'file', repo: 'dsh-core', src: 'butler-pitfalls.json', repoPath: 'dsh/butler-pitfalls.json', sync: true },
  { kind: 'file', repo: 'dsh-core', src: 'butler-p4-candidates.json', repoPath: 'dsh/butler-p4-candidates.json', sync: true },
  // 交接单跨机副本（§5.4：仓内 dsh/butler-handoff/<host>.json，不加密、无绝对路径）
  { kind: 'tree', repo: 'dsh-core', srcDir: 'butler-handoff', repoDir: 'dsh/butler-handoff', sync: true, exts: ['.json'] },
  // P5 审计流水（逐行 JSONL）：**行边界校验**，末行半行只采完整前缀（§8 表）
  { kind: 'tree', repo: 'dsh-core', srcDir: 'butler-audit', repoDir: 'dsh/butler-audit', sync: true, exts: ['.jsonl'], auditLineBoundary: true },
  // 技能（persona 属 P5 A 层保护区，热采**只读搬运**不做分发；磁盘层审计只看生产写入，故本项安全）
  { kind: 'tree', repo: 'dsh-core', srcDir: 'skills', repoDir: 'dsh/skills', sync: true, exts: ['.md', '.json', '.yml', '.yaml', '.txt'] },
  { kind: 'tree', repo: 'dsh-core', srcDir: '.agent-presets', repoDir: 'dsh/.agent-presets', sync: true, exts: ['.yml', '.yaml', '.md', '.json'] },

  // —— 仓3（dsh-workspace）：<workspace> 文档类 ——
  // 管家报告只搬**近 7 天**（P6 的探源要读它；全历史搬会一路增肥仓3 —— §5.4 R6 的成因之一）
  { kind: 'tree', repo: 'dsh-workspace', srcDir: 'docs/坑库', repoDir: 'docs/坑库', exts: ['.md'] },
  { kind: 'tree', repo: 'dsh-workspace', srcDir: 'docs/管家报告', repoDir: 'docs/管家报告', exts: ['.md', '.json'], maxAgeDays: 7 },
];

// ---------------------------------------------------------------- 仓退役开关（2026-10-27）
//
// 真源：`docs\方案-仓退役与隧道常驻-20261027.md` §3 批 1（主人 2026-10-27 11:20 令 ·
//   plan-gate pass round=1 sha 6c5142bd71b2）。本卡 = 批 1 的 1-2 / 1-1 / 1-4 三格。
//
// 🔴 **为什么在采集侧停、而不是 `git config` 层面停**（方案 §6 红线原话）：
//   "别把停推送写成 git config 层面的停用（否则本地仓库继续膨胀）" —— 写进 git config 只是把
//   「推不上去」变成「看不见它在长」（仓1 已 3.7 GB / 238 待推）。**采集侧停才是真止血。**
//
// 🔴 一键回滚两条路：
//   ① 整件回原件 —— `_archive\repo-retire-20261027\restore-hot-collect.mjs --apply`
//   ② 只回一格 —— 把下面三个常量改回 `true / true / false`（本文件零依赖，改完下一轮即生效；
//      `hot` 是 tickd 每轮 spawn 的短命进程，**不需要重启 dsh**）。
//
// 逐格说明：
//   · **COLLECT_REPO1 = false** —— 仓1 `dsh-core` 停热采（1-2）。
//       2026-10-27 仓退役，配置整包改走冷盘（见方案 §3 1-3：
//       `<冷盘根>\dsh-config-snapshot\<YYYYMMDD-HHmm>\`，HOST_A 现落 `<cold>\dsh-config-snapshot\`）。
//       ⚠️ **连带**：仓1 停采后**账本导出也停**（见 collectHot 的 2) 段 `!COLLECT_REPO1` 分支）——
//       账本是走 Host API 单独导出、落 `dsh-core/dsh/task-board/ledger-v2.json` 的**独立段**，
//       它不在这张清单里；不停它的话仓1 每天仍会多一个提交，"停采"就不成立。
//   · **COLLECT_REPO3 = true** —— 仓3 `dsh-workspace` **暂不停采**（1-4 实测定，理由写死防被"顺手停掉"）：
//       ① 覆盖度实测：20 份 `docs` 抽样与 HOST_B 侧同路径 sha256 比对 = **一致 0 / 不一致 20**
//          （18 份 HOST_B 侧根本无此文件；HOST_B `<workspace>\docs` 只有 5 文件 85,946 B，HOST_A 侧 3,376 份）；
//       ② **结构性否决**：`text-sync` 的传输载体**就是仓3**（`text-sync.mjs` SPECS.docs 的
//          `repo: 'dsh-workspace'`）⇒ 停采仓3 等于把 text-sync 也一起废，不是"替代"而是"同断"。
//       ⇒ 判定 = **保持不停采**（卡面「有差异 ⇒ 保持不停采」的保守分支）。真源 = 交付报告 §3。
//   · **SKIP_REPO2 = true** —— 仓2 `dsh-sessions` **永不采集硬守卫**（1-1）。
//       把"靠 job 参数 `--skip-sessions` 临时挡"升级成"清单/代码层硬挡"：不带该参数的调用方
//       （手工 `node hot-collect.mjs` / 单测 / 以后的新入口）同样被挡 ⇒ **不再依赖调用参数**。
//       仍可用 `opts.allowRepo2 = true` 显式越过（单测与应急用；生产没有入口传它）。
export const COLLECT_REPO1 = false;
export const COLLECT_REPO3 = true;
export const SKIP_REPO2 = true;

/** 仓退役口径一句话（CLI 打印 / 报告 / 单测共用，避免三处文案漂移）。 */
export const REPO_RETIRE_NOTE = '2026-10-27 仓退役：仓1 停采（配置整包改走冷盘 · 方案 §3 1-3）；仓2 永不采集（硬守卫）；仓3 保持采集（text-sync 覆盖不足 · 报告 1-4）';

/**
 * 按开关过滤热采清单（**纯函数**：不改入参、不读模块常量 ⇒ 单测直接喂参数断言）。
 * 过滤只按 `repo` 字段判，**不动条目内任何字段**（消费者读的是同引用）。
 *
 * @param {Array<object>} allSpecs 全量清单（`HOT_SPECS_ALL`）
 * @param {{repo1?:boolean, repo3?:boolean}} [flags] 缺省 = true（不过滤）
 * @returns {Array<object>}
 */
export function filterHotSpecs(allSpecs, flags = {}) {
  const repo1 = flags.repo1 !== false;
  const repo3 = flags.repo3 !== false;
  return (allSpecs ?? []).filter((s) => {
    if (!s || typeof s !== 'object') return false;
    if (s.repo === 'dsh-core' && !repo1) return false;
    if (s.repo === 'dsh-workspace' && !repo3) return false;
    return true;
  });
}

/**
 * 生效清单（**所有消费者读这一个**）：已按三个仓开关过滤。
 * ⚠️ 想拿"全量清单"（含已退役仓）请用 `HOT_SPECS_ALL`，别绕过开关自己复刻一份。
 */
export const HOT_SPECS = filterHotSpecs(HOT_SPECS_ALL, { repo1: COLLECT_REPO1, repo3: COLLECT_REPO3 });

/** 全量清单的只读别名（诊断/对账用；**不参与采集**）。 */
export const HOT_SPECS_RETIRED_VIEW = HOT_SPECS_ALL;

/** 明确**不搬**的对象（写在这里是给人看的，且单测会断言它们不在清单里）。 */
export const HOT_NEVER = [
  'memory.db（§8 写死：热采一律跳过，只走 Depart 冷采 + Arrive-A 合并）',
  '看板账本 ledger-v2.json（**只走 Host API 导出**，绝不复制文件；§8 表）',
  'sessions/ 未闭合会话（只搬已闭合，见 isClosedForHot）',
  '_archived-sessions/（归档会话不热采，由 P8/归档机制处理）',
];

// ---------------------------------------------------------------- 账本：Host API 导出

/**
 * 通过 Host API **只读**导出一致性快照（带 revision）。
 * 判据（实测 2026-09-14）：`GET /api/task-board/state` 必须带 `origin` 头，否则 403。
 * 失败（Host 未起 / 超时）→ `{ ok:false, reason }`，调用方**跳过本轮、不算失败、整仓采集不中断**。
 */
export async function exportLedgerSnapshot(opts = {}) {
  const base = opts.base ?? HOST_BASE;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/task-board/state`, {
      method: 'GET',
      headers: { origin: base, 'sec-fetch-site': 'same-origin' },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const json = await res.json();
    if (!json || typeof json !== 'object' || !Number.isFinite(Number(json.revision))) {
      return { ok: false, reason: 'bad-payload' };
    }
    return { ok: true, revision: Number(json.revision), tasks: Array.isArray(json.tasks) ? json.tasks.length : null, payload: json };
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message ?? String(e));
    return { ok: false, reason: String(reason).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 账本写盘判据（档 A · 2026-10-13）

/** 账本顶层「易变字段」清单（**只列能给出理由的**）。
 *
 *  由来（真源 `docs\方案-热采治本与dsh-core换仓-20261013.md` §2 / §4 档 A）：
 *    账本经 Host API 导出后**每轮都判 changed=true**（旧判据 = 字节级 `!prev.equals(buf)`）
 *    ⇒ 每 30 分钟写一份 11.2 MB 新版本 ⇒ `dsh/task-board/ledger-v2.json` 累计 204 版、
 *    占 dsh-core 历史对象 55.1%（1,124 MB），单这一项把仓库顶到 Gitee 配额的 180%。
 *    根因不是"内容变了"，而是导出体里夹着**纯心跳字段**。
 *
 *  实测依据（2026-10-13 本工具只读复核）：拿工作副本里 02:57 那份旧账本（6.6 MB / 1125 张卡）
 *    与当前导出（11.2 MB / 1131 张卡）逐卡比对 —— **1125 张共有卡 changedCardCount = 0**，
 *    即"没人动看板"时卡内容逐字节稳定，变化只落在下面三个字段：
 *
 *    · `revision`               —— 看板写动作计数器：任何人建卡/移卡/改卡都 +1（实测 8340→8350）。
 *                                  它表示"改过几次"，不表示"内容是什么"；跨机读者要的是后者。
 *    · `scheduler.lastTickAt`   —— 看板调度器 tick 心跳（实测 1791860255369→1791864621594，每 tick 刷新）。
 *    · `power.runningSessions`  —— 当前在跑会话数（实测 0→3）＝运行态观测值，与账本内容无关，随时在变。
 *
 *  ⚠️ **刻意不剥**（写清理由，免得后人"顺手扩大"）：
 *    · 各卡 `updatedAt` / `status` / `executions` 等 —— 实测共有卡 0 变化 ⇒ 它们只在卡**真变**时才动，
 *      必须继续参与比对（剥了 = 卡改了却不进仓 = 丢数据，比多写一版严重得多）。
 *    · `scheduler.timeZone` / `ledgerId`、`power.platform/phase/enabled/armedSchedules/sessionStateKnown`
 *      —— 属配置态而非心跳：变了说明真有状态变化，**该写**。
 *      （`power.phase` 若在 `enabled=true` 下出现高频抖动，另案评估，不在本卡。）
 *
 *  ⚠️ 改这张表 = 改"什么算未变"的判据 ⇒ 必须同批补夹具演练 + 报告里写明理由。
 */
export const LEDGER_VOLATILE_PATHS = ['revision', 'scheduler.lastTickAt', 'power.runningSessions'];

/** 剥掉易变字段（**纯函数**，不改入参）。只对涉及的父节点做浅拷贝 —— `tasks`（11 MB 数组）按引用共享，不复制。 */
export function stripVolatile(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out = { ...payload };
  for (const dotted of LEDGER_VOLATILE_PATHS) {
    const segs = dotted.split('.');
    let cur = out;
    for (let i = 0; i < segs.length - 1 && cur; i++) {
      const v = cur[segs[i]];
      if (!v || typeof v !== 'object' || Array.isArray(v)) { cur = null; break; }
      cur[segs[i]] = { ...v };         // 只拷这一层：保证不动物件本体
      cur = cur[segs[i]];
    }
    if (cur) delete cur[segs[segs.length - 1]];
  }
  return out;
}

/** 稳定指纹（**纯函数**）：键序无关（对象键排序、数组保序）+ 流式喂 hash（不拼 11 MB 大字符串）。 */
export function stableFingerprint(payload) {
  const h = crypto.createHash('sha256');
  const feed = (v) => {
    if (v === null || typeof v !== 'object') { h.update(JSON.stringify(v) ?? 'null'); return; }
    if (Array.isArray(v)) {
      h.update('[');
      for (let i = 0; i < v.length; i++) { if (i) h.update(','); feed(v[i]); }
      h.update(']');
      return;
    }
    const keys = Object.keys(v).sort();
    h.update('{');
    for (let i = 0; i < keys.length; i++) {
      if (i) h.update(',');
      h.update(JSON.stringify(keys[i]));
      h.update(':');
      feed(v[keys[i]]);
    }
    h.update('}');
  };
  feed(stripVolatile(payload));
  return h.digest('hex');
}

/**
 * 账本写盘判据（**档 A**）：先"语义级"，**解析失败才回落字节级**。
 *
 * 方向写死（fail-safe）：语义级判"相等"必须建立在"两边都解析成功"之上；任何一侧解析失败
 *   ⇒ 退回 `prev.equals(next)` 字节比对 —— **绝不反过来**（反过来 = 解析不了就当成"未变"
 *   ⇒ 该写的没写，卡改动静默丢失，比多写一版严重得多）。
 *
 * @param {Buffer|null} prevBuf 工作副本里现有的账本（无 ⇒ 视为 changed）
 * @param {Buffer} nextBuf 本轮导出的账本
 * @returns {{changed:boolean, mode:'no-prev'|'semantic'|'bytes-fallback', reason:string,
 *   fingerprint?:string, prevFingerprint?:string}}
 */
export function judgeLedgerChange(prevBuf, nextBuf) {
  if (!prevBuf || !prevBuf.length) return { changed: true, mode: 'no-prev', reason: '工作副本里还没有账本 ⇒ 写' };
  let prevJson; let nextJson;
  try {
    prevJson = JSON.parse(prevBuf.toString('utf8'));
    nextJson = JSON.parse(nextBuf.toString('utf8'));
  } catch (e) {
    return {
      changed: !prevBuf.equals(nextBuf), mode: 'bytes-fallback',
      reason: `账本 JSON 解析失败（${String(e?.message ?? e).slice(0, 80)}）⇒ 保守回落字节比对`,
    };
  }
  const prevFingerprint = stableFingerprint(prevJson);
  const fingerprint = stableFingerprint(nextJson);
  return {
    changed: prevFingerprint !== fingerprint, mode: 'semantic',
    fingerprint, prevFingerprint,
    reason: prevFingerprint === fingerprint ? '剥掉易变字段后指纹一致 ⇒ 语义未变' : '剥掉易变字段后指纹不同 ⇒ 内容确有变化',
  };
}

// ---------------------------------------------------------------- 账本导出节流（档 C · 2026-10-13）

/** 账本导出最小间隔（毫秒）—— **档 C**（方案 §4；先例 = 每日 1 次的 `memory-snapshot`）。
 *
 *  为什么：账本导出一次 = 11.2 MB 全量（1125+ 张卡，其中 920 张已归档）；按 30 分钟一轮算
 *    一天 48 版 ⇒ 单这一项就把 dsh-core 撑到配额 180%。
 *  代价（**已知并接受**）：跨机（仓1 里那份）看到的看板账本**最多滞后 ≤1 天**；本机永远最新。
 *    另一台机若拿仓里账本当"权威"做判据，看到的最多是一天前的板面 —— 需知情。
 *  覆盖入口（回退用）：`opts.ledgerExportIntervalMs` 或环境变量 `DSH_HOT_LEDGER_EXPORT_INTERVAL_MS`；
 *    **置 0 = 关闭节流（回到"每轮都导出"的旧行为）**（与 `DSH_HOT_SESSION_THROTTLE_MS` 同款惯例）。
 */
export const LEDGER_EXPORT_INTERVAL_MS = 24 * 3600_000;

// ---------------------------------------------------------------- 会话闭合判据（A12）

/**
 * 「已闭合」判据（§8 + §17.3 T11，**本卡登记为假设 A12**）。
 *
 * 口径（写死，别再各自解释）：
 *   · `closed`      → 闭合（尾部是正常 turn/end 或 session/end-seed）
 *   · `interrupted` → **也算闭合**（尾部 turn/end 的 reason.kind ∈ interrupted/aborted/error）
 *       理由：这类会话的回合已经结束了，只是"没干完"。若把它们当未闭合，就会落进
 *       「永不热采」集合——而 09-10 00:15 的那次被 abort 的会话恰恰是**最容易丢的那批**，
 *       RPO 会悄悄退化成 Depart（T11 原文）。对"文件是否还在被写"而言，interrupted 与 closed 等价。
 *   · `open`        → **未闭合**（在跑，绝不碰：既避开半截 zstd 帧，也避免推中间版本）
 *   · `empty` / `unknown` → **不搬**（判据不足；fail-safe：宁可少搬一轮，也不推可能撕裂的快照）
 *
 * @param {{state:string}} cls classifyTail 的结构判定结果
 * @returns {{closed:boolean, state:string, why:string}}
 */
export function isClosedForHot(cls) {
  const state = cls?.state ?? 'unknown';
  if (state === 'closed') return { closed: true, state, why: '尾部为正常 turn/end 或 session/end-seed' };
  if (state === 'interrupted') return { closed: true, state, why: '回合已结束（被打断/abort）→ 视为闭合，否则永久不入仓（A12）' };
  if (state === 'open') return { closed: false, state, why: '回合未闭合（正在跑）→ 本轮不碰' };
  return { closed: false, state, why: `判据不足（${state}）→ fail-safe 不搬` };
}

// ---------------------------------------------------------------- 工具

function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readBufSafe(file) { try { return fs.readFileSync(file); } catch { return null; } }
function nowIso(now = Date.now()) { return new Date(now).toISOString(); }

/** 该文件旁是否有"正在写"的迹象（原子写临时文件 / 锁文件）。 */
export function looksBusy(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const probes = [`${file}.lock`, `${file}.tmp`, path.join(dir, `${base}.lock`)];
  for (const p of probes) if (fs.existsSync(p)) return p;
  // butler-store 原子写 = 同目录 <name>.tmp-* / .<name>.swp
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === base) continue;
      if (f.startsWith(`${base}.tmp`) || f.startsWith(`${base}.new`)) return path.join(dir, f);
    }
  } catch { /* 目录不可读：不判忙 */ }
  return null;
}

/** JSONL 行边界校验：末行不完整 → 只保留完整行前缀。 */
export function auditCompletePrefix(text) {
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const last = lines[lines.length - 1];
  let droppedTail = false;
  const complete = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (!line.trim()) continue;
    let ok = true;
    try { JSON.parse(line); } catch { ok = false; }
    if (!ok) {
      if (isLast && !endsWithNewline) droppedTail = true;   // 半行：留到下轮
      else droppedTail = true;                              // 中间坏行：同样不采（宁可少推一行）
      continue;
    }
    complete.push(line);
  }
  return { text: complete.length ? complete.join('\n') + '\n' : '', completeLines: complete.length, droppedTail };
}

/** 递归列目录（同步、只收指定后缀、跳过噪声目录；可选 maxAgeDays 只收近 N 天改动的文件）。 */
export function listFiles(dir, exts = null, { maxAgeDays = null, now = Date.now() } = {}) {
  const out = [];
  const skip = new Set(['node_modules', '.git', '_archive', '_tmp', 'generated', 'logs', 'snapshots', 'backups']);
  const cutoff = maxAgeDays ? now - maxAgeDays * 24 * 3600 * 1000 : null;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(full); continue; }
      if (!e.isFile()) continue;
      if (/\.(bak|tmp|orig|old|before-restore|corrupt-.+)$/i.test(e.name)) continue;
      if (exts && !exts.some((x) => e.name.toLowerCase().endsWith(x))) continue;
      if (cutoff !== null) {
        try { if (fs.statSync(full).mtimeMs < cutoff) continue; } catch { continue; }
      }
      out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** 工作副本 git 封装（只读/提交/推送；绝不 rebase / clean）。
 *  ⚠️ 唯一写例外：pull-first 的 `git merge --ff-only`（判据见 judgePullFirst，只在"落后 ∧ 工作树干净
 *     ∧ 无本地未推提交"时调用）—— 2026-10-10 卡「多端线·本机小件四件」S-14 之前本封装零 merge。 */
export function git(dir, args, { timeout = 120_000 } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: r.status === 0, code: r.status,
    out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(),
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

// ---------------------------------------------------------------- pull-first（采集前对齐远端）

/**
 * pull-first 快进判据 —— **纯函数**（可单测；不 spawn、不读盘、不取当前时间）。
 *
 * 为什么需要（2026-10-10 · 卡「多端线·本机小件四件」S-14；设计真源 = `docs\仓1跨机同步-回灌与合并设计-20260910.md` §6.1）：
 *   热采原顺序是「判门 → 采集 → commit → push」，**采集前不 pull** ⇒ 对端刚推的新提交还没进工作副本，
 *   本机就可能拿生产版把工作副本盖掉（恢复要人去翻 git 历史），且"内容级体检"看的也是**旧**内容。
 *   设计要求的顺序是：`fetch → 若落后：pull（快进）→ 合并/回灌检查 → 采集 → commit → 推送`。
 *
 * 判据与 `dsh-backup-sync.ps1#Invoke-PreCollectSync`（`-Sync` 的同名改造）**逐条对应** ——
 * **同一个门不许有两套判据**：
 *   落后(remoteAhead>0) ∧ 工作树干净(worktreeDirty===0) ∧ 无本地未推提交(localAhead===0)
 *   ⇒ 可安全 `git merge --ff-only`（纯快进：不会丢本地改动、不会造 merge commit / 分叉）。
 * 其余一律**不快进**（fail-safe）：fetch 失败 / 探测量取不到 / 工作树脏 / 本地已领先（分叉形态）。
 *
 * @param {{remoteAhead?:number, localAhead?:number|null, worktreeDirty?:number|null,
 *          fetched?:boolean, fetchError?:string|null}} input
 * @returns {{action:'advance'|'skip', reason:string}}
 */
export function judgePullFirst(input = {}) {
  const { remoteAhead = 0, localAhead = null, worktreeDirty = null, fetched = false, fetchError = null } = input;
  if (fetchError || fetched === false) return { action: 'skip', reason: 'fetch-failed' };
  if (!(Number(remoteAhead) > 0)) return { action: 'skip', reason: 'not-behind' };
  if (localAhead === null || localAhead === undefined || !Number.isFinite(Number(localAhead))) {
    return { action: 'skip', reason: 'local-ahead-unknown' };
  }
  if (worktreeDirty === null || worktreeDirty === undefined || !Number.isFinite(Number(worktreeDirty))) {
    return { action: 'skip', reason: 'worktree-unknown' };
  }
  if (Number(worktreeDirty) > 0) return { action: 'skip', reason: `worktree-dirty(${Number(worktreeDirty)})` };
  if (Number(localAhead) > 0) return { action: 'skip', reason: `local-ahead(${Number(localAhead)})` };
  return { action: 'advance', reason: `behind ${Number(remoteAhead)}` };
}

/**
 * pull-first 的**动作**部分：只读探测 +（可快进形态下）一次 `git merge --ff-only`。
 * **永不 throw** —— 任何失败都只返回记录，由调用方记 warn 并继续（fail-open，绝不静默）。
 * dry-run：只探测 + 报结论（`action:'would-advance'`），**绝不写工作副本**。
 *
 * @param {string} dir 工作副本
 * @param {string} repo 仓名（报告用）
 * @param {object} gate 采集前门的结论（judgeSyncSafety 的返回；取 remoteAhead/fetched/fetchError）
 * @returns {{repo:string, action:string, reason:string, advanced:boolean, localAhead:number|null,
 *   worktreeDirty:number|null, headBefore:string|null, headAfter:string|null, dryRun?:boolean,
 *   error?:string, detail?:string, rejudged?:boolean}}
 */
export function tryPullFirst(dir, repo, gate, { branch = 'master', dryRun = false, timeoutMs = 120_000 } = {}) {
  const remoteRef = `origin/${branch}`;
  const headBefore = git(dir, ['rev-parse', 'HEAD'], { timeout: 30_000 }).out || null;
  const aheadRaw = git(dir, ['rev-list', '--count', `refs/remotes/${remoteRef}..HEAD`], { timeout: timeoutMs });
  const localAhead = aheadRaw.ok ? (Number(aheadRaw.out) || 0) : null;
  const dirtyRaw = git(dir, ['status', '--porcelain'], { timeout: timeoutMs });
  const worktreeDirty = dirtyRaw.ok ? dirtyRaw.out.split('\n').filter((l) => l.trim()).length : null;

  const verdict = judgePullFirst({
    remoteAhead: gate?.remoteAhead ?? 0,
    localAhead, worktreeDirty,
    fetched: gate?.fetched !== false,
    fetchError: gate?.fetchError ?? null,
  });

  const base = {
    repo, action: verdict.action, reason: verdict.reason,
    advanced: false, localAhead, worktreeDirty, headBefore, headAfter: headBefore,
  };
  if (verdict.action !== 'advance') return base;
  if (dryRun) return { ...base, action: 'would-advance', dryRun: true };

  const m = git(dir, ['merge', '--ff-only', remoteRef], { timeout: timeoutMs });
  if (!m.ok) return { ...base, action: 'advance-failed', error: (m.err || m.out || 'unknown').slice(0, 200) };
  const headAfter = git(dir, ['rev-parse', 'HEAD'], { timeout: 30_000 }).out || null;
  return { ...base, advanced: true, headAfter, detail: (m.out || '').slice(0, 200) };
}

// ---------------------------------------------------------------- 主流程

/**
 * 跑一轮热采。**纯本地 + git 写，不向生产写任何文件。**
 *
 * @param {{
 *   home?:string, dshRoot?:string, gitBackup?:string, host?:string,
 *   now?:number, dryRun?:boolean, skipLedger?:boolean, skipSessions?:boolean,
 *   maxSessions?:number, sessionTailBytes?:number, repoFilter?:string[]|null,
 *   fetchState?:boolean, push?:boolean, fetchLedger?:(o:object)=>Promise<object>,
 *   pullFirst?:boolean, pullFirstTimeoutMs?:number
 * }} [opts]
 *
 * pullFirst（默认 true · 2026-10-10 S-14）：采集前先 `git merge --ff-only` 把工作副本对齐远端
 *   （判据 judgePullFirst，与 dsh-backup-sync.ps1 -Sync 同源）；false = 回到旧行为（CLI --no-pull-first）。
 * @returns {Promise<{ok:boolean, result:'ok'|'deferred'|'failed'|'dry-run', startedAt:string, finishedAt:string,
 *   files:{copied:number, unchanged:number, skipped:object[]}, sessions:{closed:number, moved:number, skipped:number, openSkipped:number},
 *   ledger:object|null, volumes:object[], commits:object, pushed:object, alerts:object[], deferred:string[]}>}
 */
export async function collectHot(opts = {}) {
  const t0 = Date.now();
  const home = opts.home ?? dshHome();
  const dshRoot = opts.dshRoot ?? process.env.BUTLER_HANDOFF_ROOT ?? workspaceRoot();
  const gitBackup = opts.gitBackup ?? process.env.BUTLER_HANDOFF_GITBACKUP ?? gitBackupRoot();
  const host = String(opts.host ?? process.env.COMPUTERNAME ?? os.hostname() ?? 'unknown').toLowerCase();
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const sessionsDir = opts.sessionsDir ?? path.join(home, 'sessions');
  // 本轮"仓格局"（2026-10-27 · 卡「批1停热采」）：缺省走模块常量（生产路径），
  //   `opts.repo1Collect` / `opts.repo3Collect` 是**夹具注入点**（单测要能分别测"采"与"停"两条分支，
  //   否则仓1 采集逻辑一旦停用就再无回归覆盖，回滚时没人证明它还活着）。生产入口不传这两个参数。
  const collectRepo1 = opts.repo1Collect !== undefined ? opts.repo1Collect === true : COLLECT_REPO1;
  const collectRepo3 = opts.repo3Collect !== undefined ? opts.repo3Collect === true : COLLECT_REPO3;
  const specsThisRun = filterHotSpecs(HOT_SPECS_ALL, { repo1: collectRepo1, repo3: collectRepo3 });

  const out = {
    ok: false, result: 'failed', host, mode: 'hot', startedAt: nowIso(now), finishedAt: null,
    files: { copied: 0, unchanged: 0, skipped: [] },
    sessions: { closed: 0, moved: 0, skipped: 0, openSkipped: 0, throttled: 0 },
    ledger: null, volumes: [], commits: {}, pushed: {},
    alerts: [], deferred: [],
    gates: null,
    // 仓退役口径（2026-10-27 · 卡「批1停热采」）：把"这一轮按哪个格局跑的"写进结果，
    //   CLI / 状态文件 / 日报 / 单测都能一眼看出"仓1 是不是真停了"，不用去读源码常量。
    repoRetire: {
      repo1Collect: collectRepo1,
      repo2NeverCollect: SKIP_REPO2,
      repo3Collect: collectRepo3,
      specsThisRun: specsThisRun.length,
      note: REPO_RETIRE_NOTE,
    },
  };

  // 0.4) 统一开关「仓2 推/停」判据（**S1b 接线** · 真源 v2 §5.2 / §5.4-① / §5.5）
  //
  // 首期动作 = **一致性检查**（v2 §5.4-① 原文：「**不接线、只加一致性检查**」）：读唯一开关文件，
  //   与 job 参数（`butler-tickd.mjs` 的 `hot.args = ['--skip-sessions']`）比对；不一致 ⇒
  //   **取更严（停推优先）+ 打印告警**（v2 §5.2 第 5 行 / §5.5 冲突裁决）。
  // 🔴 **执行面刻意不落**（本卡实测决定，见下方"为什么只读"）：
  //   ① §5.4-① 首期动作明写"不接线"；② 生产上 job **恒带** `--skip-sessions` ⇒ 无论开关取值，
  //   执行面都零收益（停推已是现行为）；③ 实测真落执行面会**真回归既有测试**。
  //   推送段（`if (opts.push !== false)` 循环）同理不动：它的现行为是"把本机已有但未推的提交推上去"
  //   （见其上方"只要 ahead>0 就推"的积压教训注释），改它会改变「开关关」下的既有兜底语义。
  // 为什么「存在性判定 + 动态 import」：`lib/sync-topology.mjs` 是 S1 新增件，跨机分发可能滞后；
  //   静态 import 会让**每 30 分钟一轮的热采**在缺件时直接崩 —— 同款处置先例见 `handoff.mjs`
  //   对 `tools/attachments-audit.mjs` 的注释（"存在性判定 + 子进程执行，工具不在就降级"）。
  // 为什么只读不写行为（2026-10-11 S1b 卡实测）：真接上「取更严 ⇒ 在会话循环里短路采集」后，
  //   `_test\test-hot-collect.mjs` 的 §④b（会话级节流）当场红：`ENOENT …sessions\s-throttle\<会话日志>`
  //   —— 因为**任何不带 `--skip-sessions` 的调用方**（手工 `node hot-collect.mjs`、
  //   单测、以后的新调用方）都会被开关静默改掉采集行为 = "静默变行为"（v2 §5.2 最怕的那一种）。
  //   ⇒ 撤掉执行面，只留"读 + 判 + 打印/记账"（判定结果见 `out.topology`，`enforced:false` 明示）。
  //   ⚠️ 本文件**禁出现会话日志文件名常量**（判据真源 = `lib/pitfall-scan.mjs#discoverSessionFiles`；
  //   `_test\test-v3-adapt-session-file-name.mjs` ⑤ 段有静态断言）—— 写注释也别写那两个字面量。
  const topoUrl = new URL('./sync-topology.mjs', import.meta.url);
  let topoNotice = null;
  let repo2 = { push: !opts.skipSessions, fromFile: false, stopped: !opts.skipSessions, notices: [] };
  let repo2Raw = { present: false, value: undefined };
  let topoEvidence = { reader: topoUrl.pathname, available: false, path: null, source: null, reason: null };
  try {
    if (fs.existsSync(topoUrl)) {
      const topo = await import(topoUrl.href);
      topoNotice = topo.NOTICES ?? null;
      const t = topo.readTopology();
      repo2 = topo.mergeRepo2Push(t, { currentPush: !opts.skipSessions, jobSkipSessions: opts.skipSessions });
      // 文件里的**原值**（区别于 merge 后的生效值：冲突取更严时二者会不同）
      const raw = topo.getKey(t.data, 'repo2.push', 'boolean');
      repo2Raw = { present: raw.present, value: raw.value };
      topoEvidence = { reader: topoUrl.pathname, available: true, path: t.path, source: t.source, reason: t.reason ?? null };
    } else {
      repo2.notices.push(`同步拓扑读取器未分发到本机（${topoUrl.pathname}）⇒ 未读到开关，按现值执行`);
    }
  } catch (e) {
    repo2.notices.push(`同步拓扑读取统一失败（按现值执行）：${String(e?.message ?? e).slice(0, 120)}`);
  }
  out.topology = {
    ...topoEvidence,
    repo2PushFromFile: repo2Raw.present ? repo2Raw.value : null,
    repo2PushEffective: repo2.push,
    stopped: repo2.stopped === true,     // 「判定」= 本轮按停推口径（首期仅供观测，不落执行面）
    enforced: false,                     // 🔴 执行面未接线（v2 §5.4-① 首期动作 + 本卡实测理由见上）
    notices: [...repo2.notices],
  };
  // 打印（v2 §5.2「无论走哪边都打印」）：进 alerts ⇒ CLI 控制台 + 热采状态文件都看得见。
  //   例外（2026-10-27 · 本卡 1-1 升级）：**仓2 已升级成"永不采集"硬守卫**（`SKIP_REPO2` 常量）。
  //   此时仓2 的拓扑 notices 全是**例行背景**（"已按总开关跳过仓2" / "缺文件按现值执行" 之类），
  //   每 30 分钟刷一遍是纯噪音、会掩盖真告警 ⇒ **只留痕在 `out.topology.notices`，不进 alerts**。
  //   改判据的理由（卡面要求"SKIP_REPO2 那条告警不再每轮刷"）：挡它的东西已经从"调用参数"变成
  //   "代码常量"，而常量每轮都是同一个值 ⇒ 它不再是"本轮发生了什么"，不该按轮告警。
  //   为免"看不见仓2 为什么不动"，仍发一条 **info 级**（CLI 用 `·` 打，不占 `!!`），只在**挡着时**发。
  for (const n of repo2.notices) {
    if (SKIP_REPO2) continue;                                   // 硬守卫期：仓2 拓扑一律只留痕
    if (topoNotice && n === topoNotice.SKIP_REPO2) continue;    // 开关正常工作的例行句
    out.alerts.push({ level: 'warn', code: 'topology-repo2', message: n });
  }
  if (SKIP_REPO2) {
    out.alerts.push({ level: 'info', code: 'repo2-never-collect', message: '仓2 dsh-sessions：永不采集（SKIP_REPO2 代码层硬守卫，与调用参数无关）' });
  }

  const repos = {
    'dsh-core': path.join(gitBackup, 'dsh-core'),
    'dsh-sessions': path.join(gitBackup, 'dsh-sessions'),
    'dsh-workspace': path.join(gitBackup, 'dsh-workspace'),
  };

  // 0) 仓库可用性
  //   仓1/仓3 是**必需**（小文件与文档的落地目标）→ 缺了整轮失败；
  //   仓2 是**可选**（无会话要搬 / 未配置会话仓时不该让整轮失败）→ 缺了只记 warn 并跳过会话段。
  //   ⚠️ 2026-10-27（卡「批1停热采」）：**"必需"跟着仓退役开关走** —— 停采的仓缺了不该再让整轮失败
  //      （例如仓1 退役后主人把工作副本挪走，`hot` 不该整轮 failed；反过来还在采的仓缺了仍必须 failed）。
  const required = [];
  if (collectRepo1) required.push('dsh-core');
  if (collectRepo3) required.push('dsh-workspace');
  for (const name of required) {
    const dir = repos[name];
    if (!fs.existsSync(path.join(dir, '.git'))) { out.alerts.push({ level: 'alert', code: 'repo-missing', message: `${name}: 工作副本不存在（${dir}）` }); out.result = 'failed'; out.finishedAt = nowIso(); return out; }
  }
  const sessionsRepoReady = fs.existsSync(path.join(repos['dsh-sessions'], '.git'));
  if (!sessionsRepoReady) out.alerts.push({ level: 'warn', code: 'repo2-missing', message: `dsh-sessions: 工作副本不存在 → 本轮不搬会话（${repos['dsh-sessions']}）` });

  // 0.5) 推前安全门 · **采集前**判定（2026-09-15 卡：hot-collect 推前安全门）
  //
  // 为什么必须挡在采集之前（已复现的风险链，夹具见 <offsync>\DSH-test\fixtures\hot-collect-guard）：
  //   ① 对端把新成果推到 Gitee（commit B）；② 本机某次 -Pull / arrive 把 B 拉进工作副本（工作副本 = B）；
  //   ③ 本机生产仍是旧版 A；热采采集用 A 覆盖 B → commit C（parent = B）；
  //   ④ push 是 B 的 fast-forward（**git 不会拒绝**）⇒ 远端 B 的内容被抹掉。
  //   挡在采集前：不覆盖、不 commit、工作副本保持 B 原样（人可以从工作副本把它分发回生产）。
  //
  // 判定口径见 lib/push-guard.mjs 顶部（提交级为主 + 本机同步基准；无基准时才走内容级兜底，
  //   后者复用 tools/lib/repo-superset.mjs = dsh-backup-sync.ps1 -Push 的同一份判据）。
  const snapFile = resolveStatePath('butler-handoff-hot.json', { home }).path;
  const snap = readJsonSafe(snapFile, null) ?? { schemaVersion: 1, sessions: {} };
  const sessions = snap.sessions ?? {};

  const guardEnabled = opts.pushGuard !== false;
  const allowDivergence = opts.allowDivergence === true;
  const guardRepos = opts.pushGuardRepos ?? ['dsh-core', 'dsh-workspace'];
  const guardBranch = opts.pushGuardBranch ?? 'master';
  // pull-first（S-14 · 2026-10-10）：默认开，逃生舱 = opts.pullFirst === false（CLI --no-pull-first）
  const pullFirstEnabled = opts.pullFirst !== false;
  const pullFirstTimeoutMs = opts.pullFirstTimeoutMs ?? opts.pushGuardTimeoutMs ?? 120_000;
  const lastSynced = snap.repos ?? {};
  const gates = {
    enabled: guardEnabled, allowDivergence, branch: guardBranch, repos: guardRepos,
    pullFirstEnabled, preCollect: {}, pullFirst: {}, prePush: {}, blockedRepos: [], blocked: [],
  };
  out.gates = gates;

  /** 内容级兜底体检（仅在"无同步基准"时由 push-guard 调用）：复用 repo-superset 判据。 */
  const contentProbeFor = (repoName, dir) => () => {
    const prodRoot = repoName === 'dsh-workspace' ? dshRoot : home;
    const rep = checkRepo(repoName, { root: dir, prod: prodRoot });
    if (rep?.error) return { risky: true, reason: `内容体检不可用（${rep.error}）` };
    const files = (rep.uniqueLines ?? []).map((u) => u.rel);
    return {
      risky: files.length > 0, files,
      reason: `工作副本独有行 ${files.length} 个文件 / 疑似改写 ${rep.rewriteLines?.length ?? 0} 个（fixture 口径同 check-repo-superset）`,
    };
  };

  if (guardEnabled) {
    if (allowDivergence) {
      out.alerts.push({ level: 'warn', code: 'push-guard-bypassed', message: '推前安全门被 --allow-divergence 显式跳过（本轮不判定远端分叉，风险自担）' });
    } else {
      /** 采集前门判定（判据真源 = lib/push-guard.mjs；pull-first 前后各调用一次）。 */
      const runPreGuard = (name, dir) => judgeSyncSafety({
        dir, repo: name, host, branch: guardBranch,
        lastSyncedSha: lastSynced?.[name]?.lastSyncedSha ?? null,
        fetch: opts.pushGuardFetch !== false,
        timeoutMs: opts.pushGuardTimeoutMs ?? 120_000,
        contentProbe: contentProbeFor(name, dir),
      });

      for (const name of guardRepos) {
        const dir = repos[name];
        if (!dir || !fs.existsSync(path.join(dir, '.git'))) continue;   // 仓缺失由上面 0) 段处理
        let g = runPreGuard(name, dir);

        // 0.6) pull-first（S-14 · 2026-10-10）：**先拉平工作副本，再消费门的结论**。
        //   为什么顺序是这个（与 dsh-backup-sync.ps1#Invoke-PreCollectSync 逐条同源）：
        //     push-guard 把"本机落后"归 hard（处置 = 停采集）；而落后的正确处置是**把它拉平**
        //     （拉平即不落后）—— 拿旧内容判"会不会抹掉对端内容"，判的其实不是真相。
        //   判据 = judgePullFirst（落后 ∧ 工作树干净 ∧ 无本地未推提交 ⇒ 可安全快进）。
        //   fail-open：fetch 失败 / 工作树脏 / 分叉 / 快进失败 ⇒ 只记一条，采集照常走原门结论。
        if (pullFirstEnabled) {
          const pf = tryPullFirst(dir, name, g, { branch: guardBranch, dryRun, timeoutMs: pullFirstTimeoutMs });
          if (pf.advanced) { g = runPreGuard(name, dir); pf.rejudged = true; }
          gates.pullFirst[name] = pf;
          if (pf.action === 'advance-failed') {
            out.alerts.push({ level: 'warn', code: 'pull-first-failed', message: `${name}: pull-first 快进失败（${pf.error ?? '-'}）→ 采集照常（fail-open），工作副本仍缺对端内容` });
          } else if (pf.action === 'would-advance') {
            out.alerts.push({ level: 'info', code: 'pull-first-dry-run', message: `${name}: dry-run —— 本机落后（${pf.reason}），真跑会先快进；本轮不写工作副本` });
          } else if (pf.advanced) {
            out.alerts.push({ level: 'info', code: 'pull-first-advanced', message: `${name}: 采集前已快进到 ${String(pf.headAfter).slice(0, 8)}（${pf.reason}）→ 下面的门结论是**快进后复判**` });
          } else if (pf.reason !== 'not-behind') {
            out.alerts.push({ level: 'info', code: 'pull-first-skipped', message: `${name}: 本机落后但不自动快进（${pf.reason}）→ 工作副本保持原状，等人工裁决` });
          }
        }

        gates.preCollect[name] = g;
        if (g.safe) continue;
        if (g.hard) {
          gates.blockedRepos.push(name);
          gates.blocked.push({ stage: 'pre-collect', repo: name, code: g.code, hard: g.hard, reason: g.reason, foreignCommits: g.foreignCommits, contentFiles: g.contentFiles });
          out.files.skipped.push({ repo: name, rel: '(整仓跳过)', reason: `push-guard:${g.code}` });
          out.alerts.push({ level: 'alert', code: 'push-guard-blocked', message: `${name} 本轮不采集（${g.code}）：${g.reason}` });
          out.deferred.push(`${name}: 推前安全门拦截（${g.code}）`);
        } else {
          // 软挡（网络类：fetch 失败）→ 本地采集继续（本地版本控制仍有价值），但推送段会拒绝推送
          out.alerts.push({ level: 'warn', code: 'push-guard-soft', message: `${name} 远端状态未知（${g.code}）：${g.reason} → 本轮采集继续、禁止推送` });
        }
      }
    }
  }

  // 1) 逐对象搬运
  const copyOne = (repoName, srcFile, dstFile, { auditLineBoundary = false } = {}) => {
    const repoDir = repos[repoName];
    const rel = path.relative(repoDir, dstFile);
    const busy = looksBusy(srcFile);
    if (busy) { out.files.skipped.push({ repo: repoName, rel, reason: 'locked', probe: path.basename(busy) }); return 'skipped'; }
    const srcBuf = readBufSafe(srcFile);
    if (!srcBuf) { out.files.skipped.push({ repo: repoName, rel, reason: 'unreadable' }); return 'skipped'; }

    let buf = srcBuf;
    if (auditLineBoundary) {
      const res = auditCompletePrefix(srcBuf.toString('utf8'));
      if (res.droppedTail) {
        out.files.skipped.push({ repo: repoName, rel, reason: 'audit-partial-tail', dropped: true });
        // ⚠️ 不中断：只采完整行前缀（§8 表）
        if (!res.completeLines) return 'skipped';
      }
      buf = Buffer.from(res.text, 'utf8');
    }

    const prev = fs.existsSync(dstFile) ? readBufSafe(dstFile) : null;
    if (prev && prev.equals(buf)) { out.files.unchanged++; return 'unchanged'; }
    if (dryRun) { out.files.copied++; return 'would-copy'; }
    fs.mkdirSync(path.dirname(dstFile), { recursive: true });
    // 原子写（先写临时文件再 rename）：避免半截文件进仓
    const tmp = `${dstFile}.hottmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    const gr = renameGuarded(tmp, dstFile, { whitelist: [repoDir], reason: `热采集落仓 ${repoName}` });
    if (!gr.ok) throw new Error(`热采集落仓被三件套拒绝（${gr.code}）：${gr.reason}`);
    out.files.copied++;
    return 'copied';
  };

  for (const spec of specsThisRun) {
    if (opts.repoFilter && !opts.repoFilter.includes(spec.repo)) continue;
    if (gates.blockedRepos.includes(spec.repo)) continue;   // 推前安全门 hard 挡：整仓不覆盖（见 0.5 段）
    const repoDir = repos[spec.repo];
    if (!repoDir) continue;
    if (spec.kind === 'file') {
      if (spec.sync === false) { out.files.skipped.push({ repo: spec.repo, rel: spec.repoPath, reason: 'sync-false' }); continue; }
      // 2c：清单里的名字是**数据**（人读 + 与 state-files.mjs 的 sync 口径逐条对），
      //     真路径构造在这里过解析层 —— legacy 期解析结果 == 拼出来的旧路径（行为零变化）
      const srcFile = resolveStatePath(spec.src, { home }).path;
      if (!fs.existsSync(srcFile)) { out.files.skipped.push({ repo: spec.repo, rel: spec.repoPath, reason: 'missing' }); continue; }
      copyOne(spec.repo, srcFile, path.join(repoDir, spec.repoPath.split('/').join(path.sep)));
    } else if (spec.kind === 'tree') {
      // srcDir 可能是 ~/.dsh 下的相对路径，也可能是 <workspace> 下的相对路径（docs/…）
      const c1 = resolveStatePath(spec.srcDir, { home }).path;
      const c2 = path.join(dshRoot, spec.srcDir);
      const srcDir = fs.existsSync(c1) ? c1 : c2;
      if (!fs.existsSync(srcDir)) { out.files.skipped.push({ repo: spec.repo, rel: spec.repoDir, reason: 'missing-dir' }); continue; }
      const files = listFiles(srcDir, spec.exts ?? null, { maxAgeDays: spec.maxAgeDays ?? null, now });
      for (const f of files) {
        const rel = path.relative(srcDir, f);
        copyOne(spec.repo, f, path.join(repoDir, spec.repoDir.split('/').join(path.sep), rel), { auditLineBoundary: spec.auditLineBoundary });
      }
    }
  }

  // 2) 账本：Host API 只读导出（不复制文件）
  //
  // 档 C（2026-10-13）：**先过节流门** —— 未到点就本轮不导出（连 Host 都不打），只记账；到点才走原逻辑。
  //   节流键 = 快照里的 `snap.ledgerExportedAt`（毫秒，与 volumeHistory.at / sessions.pushedAt 同风格），
  //   **只在真导出那一轮写**：导出失败 / 被节流 / 被跳过都不写 ⇒ 下轮仍会重试（失败不会被拖成 24h 空窗）。
  //   间隔来源：opts.ledgerExportIntervalMs ?? env DSH_HOT_LEDGER_EXPORT_INTERVAL_MS ?? 缺省 24h；**0 = 关闭节流**。
  const ledgerIntervalRaw = opts.ledgerExportIntervalMs ?? process.env.DSH_HOT_LEDGER_EXPORT_INTERVAL_MS ?? LEDGER_EXPORT_INTERVAL_MS;
  const ledgerIntervalNum = Number(ledgerIntervalRaw);
  const ledgerIntervalMs = (Number.isFinite(ledgerIntervalNum) && ledgerIntervalNum >= 0) ? ledgerIntervalNum : LEDGER_EXPORT_INTERVAL_MS;
  if (!Number.isFinite(ledgerIntervalNum) || ledgerIntervalNum < 0) {
    out.alerts.push({ level: 'warn', code: 'ledger-interval-invalid', message: `账本导出间隔取值非法（${String(ledgerIntervalRaw)}）⇒ 回落缺省 ${LEDGER_EXPORT_INTERVAL_MS}ms` });
  }
  const ledgerLastAt = Number(snap.ledgerExportedAt ?? 0) || 0;
  let ledgerExported = false;      // 供 5.5 段写节流键（dry-run 不写快照 ⇒ 无副作用）
  if (opts.skipLedger) {
    out.ledger = { ok: false, reason: 'skipped-by-flag' };
  } else if (!collectRepo1) {
    // 2026-10-27（卡「批1停热采」1-2）：**仓1 停采 ⇒ 账本导出连带停**。
    // 为什么必须连带（否则"仓1 停采"是假的）：账本不走 HOT_SPECS，它是下面这段**独立**的
    //   Host API 导出 + 写 `dsh-core/dsh/task-board/ledger-v2.json`（档 C 节流 24h ⇒ 每天仍会
    //   产生一个仓1 提交）。不关它，判据「跑一轮后 dsh-core 末次提交哈希不变」当天就会被打脸。
    // 代价（已知并接受）：仓1 里那份跨机可读的看板账本停在 2026-10-27；本机权威账本不受影响
    //   （Host API 永远是本机最新的那份），跨机读者改走冷盘整包（方案 §3 1-3 的 config-snapshot）。
    // 回滚：把 `COLLECT_REPO1` 改回 true 即恢复（含账本）。
    out.ledger = { ok: false, reason: 'repo1-retired', detail: '仓1 停采（COLLECT_REPO1=false）⇒ 账本导出连带停；跨机改走冷盘整包' };
  } else if (gates.blockedRepos.includes('dsh-core')) {
    out.ledger = { ok: false, reason: 'push-guard-blocked' };
  } else if (ledgerIntervalMs > 0 && ledgerLastAt > 0 && (now - ledgerLastAt) < ledgerIntervalMs) {
    // 未到点 ⇒ **不导出**（Host 不被打、零写入、零提交）；lastAt/intervalMs 供 CLI 与日报算"下次何时到点"
    out.ledger = { ok: true, skipped: 'throttled', lastAt: ledgerLastAt, intervalMs: ledgerIntervalMs };
  } else {
    const exporter = opts.fetchLedger ?? exportLedgerSnapshot;
    const res = await exporter({});
    if (!res.ok) {
      out.ledger = { ok: false, reason: res.reason };
      // §8 表：导出失败（Host 不可达 / 未起）→ 跳过本轮、**不算失败**
      out.files.skipped.push({ repo: 'dsh-core', rel: 'dsh/task-board/ledger-v2.json', reason: `ledger-host-api:${res.reason}` });
    } else {
      const dst = path.join(repos['dsh-core'], 'dsh', 'task-board', 'ledger-v2.json');
      const buf = Buffer.from(JSON.stringify(res.payload, null, 2) + '\n', 'utf8');
      const prev = fs.existsSync(dst) ? readBufSafe(dst) : null;
      // 档 A（2026-10-13）：判据从「字节相等才跳过」升级为「**剥掉易变字段后指纹相等**就跳过」
      //   判据真源 = judgeLedgerChange（含"解析失败 ⇒ 回落字节比对"的 fail-safe 方向，见其注释）。
      const verdict = judgeLedgerChange(prev, buf);
      const changed = verdict.changed;
      if (changed && !dryRun) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
      if (changed) out.files.copied++;
      else out.files.unchanged++;      // 语义未变 = 与其他文件的 unchanged 同口径（零写入、零提交、零推送）
      ledgerExported = true;
      out.ledger = {
        ok: true, revision: res.revision, tasks: res.tasks, changed,
        authority: 'snapshot', compare: verdict.mode,
        ...(changed ? {} : { skipped: 'semantic-unchanged' }),
      };
    }
  }

  // 3) 会话：只搬「已闭合」（A12 判据）
  //    （snapFile / snap / sessions 已在 0.5 段读取：推前安全门要用 snap.repos 的同步基准）
  //
  // 🔴 2026-10-27（本卡 1-1 · 仓2 收口）：**「永不采集」硬守卫**。
  //   旧挡法 = tickd job 参数 `--skip-sessions`（`butler-tickd.mjs` 的 `hot.args`）—— 那是"临时挡"：
  //   手工 `node hot-collect.mjs`、单测、以及以后任何新增入口都会绕过去（2026-10-23 补卡的老毛病）。
  //   现在挡在**代码层**（`SKIP_REPO2` 常量）：**连会话目录都不扫**（省 IO），并在 `out.repoRetire` 留明账。
  //   逃生舱 = `opts.allowRepo2 === true`（只有单测 / 应急会传；生产四个入口都不传）。
  const repo2Allowed = SKIP_REPO2 !== true || opts.allowRepo2 === true;
  let sessionFiles = [];
  if (!repo2Allowed) {
    out.sessions.repo2Guard = 'SKIP_REPO2';
    out.sessions.repo2Note = '仓2 永不采集（代码层硬守卫）：会话目录未扫描 / 未搬运 / 未写会话快照';
  } else {
    try { sessionFiles = discoverSessionFiles(home).filter((f) => f.root === 'sessions'); } catch (e) {
      out.alerts.push({ level: 'warn', code: 'session-scan-failed', message: `会话扫描失败：${String(e?.message ?? e).slice(0, 120)}` });
    }
  }
  const tailBytes = opts.sessionTailBytes ?? 256 * 1024;
  // 会话级节流（2026-09-16 拷问 P1b·主人拍板 C）：同一会话两次进仓的最短间隔。
  //   为什么：zstd 压缩流无法 delta ⇒ 同一会话每变一次就是一个全新 blob（实测单会话一天 5~11 版、
  //   单文件累计 18MB），仓2 换仓后 14 小时涨 420MB、直逼 Gitee 1024MB 配额。
  //   为什么安全：未闭合会话本来就不搬；已闭合会话最长延迟 N 小时必然进仓（最终一致），
  //   节流不改写/不删除任何数据。**置 0 = 关闭节流（回到旧行为）**。
  //   覆盖入口：`opts.sessionThrottleMs`（单测/调用方）或环境变量 DSH_HOT_SESSION_THROTTLE_MS。
  const throttleMs = Math.max(0, Number(opts.sessionThrottleMs ?? process.env.DSH_HOT_SESSION_THROTTLE_MS ?? 6 * 3600_000) || 0);
  const maxSessions = opts.maxSessions ?? 400;
  const warnOnCap = opts.warnOnCap !== false;   // 显式传 --limit 时由调用方置 false（那是用户自己要限量，不是异常）
  let considered = 0;
  for (const f of sessionFiles) {
    // ⚠️ 这里**刻意没有**叠加统一开关判据（首期动作 = v2 §5.4-① 明写的「**不接线**、只加一致性检查」）。
    //   实测证据（2026-10-11 · S1b 卡）：真加上「取更严 ⇒ 短路采集」后，`_test\test-hot-collect.mjs`
    //   的 §④b 会话节流用例当场真回归（`ENOENT …sessions\s-throttle\<会话日志>`）——
    //   因为**任何不带 `--skip-sessions` 的调用方**（手工 `node hot-collect.mjs`、单测）都会被开关
    //   静默改掉采集行为，而生产上 job 恒带 `--skip-sessions` ⇒ 执行面**零收益、纯风险**。
    //   ⇒ 本卡只落"读 + 判 + 打印/记账"（判定结果见 `out.topology`）；要不要真落执行面 = 主人一句话。
    if (!repo2Allowed) break;   // 双保险：硬守卫期连循环都不进（sessionFiles 本已为空）
    if (opts.skipSessions) break;
    if (considered >= maxSessions) { if (warnOnCap) out.alerts.push({ level: 'warn', code: 'session-cap', message: `本轮会话数超过上限 ${maxSessions}，其余下轮再搬` }); break; }
    const prevSnap = sessions[f.sessionId];
    const metaSame = prevSnap && prevSnap.bytes === f.bytes && prevSnap.mtimeMs === f.mtimeMs;
    if (metaSame) { out.sessions.skipped++; continue; }   // 已搬过该周期且没变 → 不读尾部、不重搬（省 IO）
    considered++;
    let cls;
    try { cls = classifyTail(readTailEvents(f.file, tailBytes)); } catch (e) {
      out.sessions.skipped++; out.alerts.push({ level: 'warn', code: 'session-tail-failed', message: `${f.sessionId}: 尾部读取失败（${String(e?.message ?? e).slice(0, 80)}）` });
      continue;
    }
    const verdict = isClosedForHot(cls);
    if (!verdict.closed) { out.sessions.openSkipped++; if (verdict.state === 'open') out.sessions.skipped++; continue; }
    out.sessions.closed++;
    // 会话级节流（P1b）：距上次进仓不足 throttleMs ⇒ 本轮不搬，也**不更新** sessions[id]（下轮再判）。
    //   放在「已闭合」之后：未闭合会话本来就不搬，节流只作用于"闭合后又被继续用"的反复变化会话。
    const prevRec = sessions[f.sessionId];
    const lastPushMs = Number(prevRec?.pushedAt ?? 0) || (prevRec?.movedAt ? Date.parse(prevRec.movedAt) : 0) || 0;
    if (throttleMs > 0 && lastPushMs && (now - lastPushMs) < throttleMs) {
      out.sessions.throttled++;
      out.sessions.skipped++;
      continue;
    }
    // 仓2 不可用（未配置）→ 只统计不搬；**不写快照**，否则下轮会被"元数据未变"永久跳过
    if (!sessionsRepoReady) { out.sessions.skipped++; continue; }
    // zstd 帧完整性校验：不完整 → 丢弃等下轮
    const intact = frameIntact(f.file);
    if (!intact.ok) { out.sessions.skipped++; out.files.skipped.push({ repo: 'dsh-sessions', rel: f.sessionId, reason: `zstd-${intact.reason}` }); continue; }
    const dst = path.join(gitBackup, 'dsh-sessions', 'sessions', path.relative(sessionsDir, f.file));
    const buf = readBufSafe(f.file);
    if (!buf) { out.sessions.skipped++; continue; }
    const prev = fs.existsSync(dst) ? readBufSafe(dst) : null;
    if (!prev || !prev.equals(buf)) {
      if (!dryRun) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
      out.sessions.moved++;
    }
    sessions[f.sessionId] = { bytes: f.bytes, mtimeMs: f.mtimeMs, state: verdict.state, movedAt: nowIso(now), pushedAt: now };
  }
  // 快照落盘已挪到 push 之后（同一份文件另存「远端同步基准」snap.repos，见文末）

  // 4) 体积（§5.4 R6）—— 2026-09-16 拷问 P1 修：口径改 `.git`（与 Gitee 1024MB 配额同量纲），
  //    两层判据（绝对阈值 + 配额余量比）；采样同时追加进运行键 volumeHistory，供日报算增速/预计撞线。
  const volumeSamples = [];
  for (const [name, dir] of Object.entries(repos)) {
    if (!fs.existsSync(dir)) { out.volumes.push({ repo: name, sizeBytes: null, files: null, gitBytes: null, thresholdBytes: VOLUME_THRESHOLDS[name] ?? null, overThreshold: false, level: 'ok', missing: true }); continue; }
    const vol = measureRepoVolume(dir);
    const gv = measureGitVolume(dir);
    const vj = judgeRepoVolume({ repo: name, gitBytes: gv.bytes, treeBytes: vol.sizeBytes });
    out.volumes.push({ repo: name, sizeBytes: vol.sizeBytes, gitBytes: gv.bytes, files: vol.files, thresholdBytes: vj.thresholdBytes, overThreshold: vj.overThreshold, quotaRatio: vj.quotaRatio, remainBytes: vj.remainBytes, level: vj.level });
    volumeSamples.push({ repo: name, gitBytes: gv.bytes, treeBytes: vol.sizeBytes });
    if (vj.level === 'red') out.alerts.push({ level: 'alert', code: 'volume-quota', message: `${name} .git ${(gv.bytes / 1048576).toFixed(1)}MB / 配额占用 ${(vj.quotaRatio * 100).toFixed(1)}% · 余量 ${(vj.remainBytes / 1048576).toFixed(1)}MB —— 随时可能被 Gitee 硬拒` });
    else if (vj.level === 'yellow') out.alerts.push({ level: 'warn', code: 'volume-over', message: `${name} ${vj.why}` });
  }

  // 5) 提交 + push（无变化不提交 —— §8 "git 检测空变更即跳过"）
  for (const [name, dir] of Object.entries(repos)) {
    if (dryRun) { out.commits[name] = { ok: true, dryRun: true }; continue; }
    if (gates.blockedRepos.includes(name)) { out.commits[name] = { ok: false, blocked: true, error: 'push-guard-blocked' }; continue; }
    const st = git(dir, ['status', '--porcelain']);
    if (!st.ok) { out.commits[name] = { ok: false, error: 'status-failed' }; out.deferred.push(`${name}: git status 失败`); continue; }
    if (!st.out) { out.commits[name] = { ok: true, committed: false, reason: 'no-changes' }; continue; }
    git(dir, ['add', '-A']);
    const msg = `${stamp(new Date(now))} ${host.toUpperCase()} hot-collect (auto)`;
    const c = git(dir, ['commit', '-m', msg]);
    out.commits[name] = { ok: c.ok, committed: c.ok, message: msg, error: c.ok ? null : (c.err || c.out).slice(0, 200) };
    if (!c.ok) out.deferred.push(`${name}: commit 失败`);
  }
  const newBaseline = {};
  if (opts.push !== false) {
    for (const [name, dir] of Object.entries(repos)) {
      if (dryRun) { out.pushed[name] = { ok: true, dryRun: true, skipped: 'dry-run' }; continue; }
      if (gates.blockedRepos.includes(name)) { out.pushed[name] = { ok: false, blocked: true, code: 'push-guard-blocked' }; continue; }

      // ---- 推前安全门（G2 · 候选 A 的落点）：采集期间远端可能被对端推进 → 推之前再判一次 ----
      if (guardEnabled && !allowDivergence && guardRepos.includes(name)) {
        const g2 = judgeSyncSafety({
          dir, repo: name, host, branch: guardBranch,
          lastSyncedSha: lastSynced?.[name]?.lastSyncedSha ?? null,
          fetch: opts.pushGuardFetch !== false,
          timeoutMs: opts.pushGuardTimeoutMs ?? 120_000,
          contentProbe: contentProbeFor(name, dir),
        });
        gates.prePush[name] = g2;
        if (!g2.safe) {
          out.pushed[name] = { ok: false, blocked: true, code: g2.code, reason: g2.reason };
          if (!gates.blockedRepos.includes(name)) gates.blockedRepos.push(name);
          gates.blocked.push({ stage: 'pre-push', repo: name, code: g2.code, hard: g2.hard, reason: g2.reason, foreignCommits: g2.foreignCommits, contentFiles: g2.contentFiles });
          out.deferred.push(`${name}: 推前安全门拦截（${g2.code}）`);
          out.alerts.push({ level: 'alert', code: 'push-guard-blocked', message: `${name}: 拒绝推送（${g2.code}）：${g2.reason}` });
          continue;
        }
      }

      // 判定"要不要 push"看的是 **ahead**（本地有未推送提交），不是"本轮刚提交"：
      //   实测坑（2026-09-14）：某轮采集在 `--no-push` / 推送失败后留下了本地提交，
      //   下一轮因为没有新改动 → `committed=false` → 若按"本轮没提交就跳过 push"，
      //   那些提交会**永久积压在本机**（别人永远看不到，且没人会去手工推）。
      //   所以只要 ahead>0 就推 —— 这是幂等的，没有未推提交时 push 本身也是空操作。
      const ab = git(dir, ['rev-list', '--count', `origin/${guardBranch}..HEAD`]);
      const ahead = ab.ok ? Number(ab.out) || 0 : 0;
      if (ahead === 0) {
        out.pushed[name] = { ok: true, skipped: 'nothing-to-push' };
      } else {
        const p = git(dir, ['push', 'origin', guardBranch], { timeout: 300_000 });
        out.pushed[name] = { ok: p.ok, ahead, error: p.ok ? null : (p.err || p.out).slice(0, 200) };
        if (!p.ok) { out.deferred.push(`${name}: push 失败`); out.alerts.push({ level: 'warn', code: 'push-failed', message: `${name}: push 失败（deferred）` }); }
      }
      // 推完（成功或"无需推送"）→ 把**本机已确认的远端状态**记为下一轮的同步基准
      if (out.pushed[name]?.ok && guardRepos.includes(name)) {
        const ref = git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${guardBranch}`]);
        if (ref.ok) newBaseline[name] = ref.out;
      }
    }
  }

  // 5.5) 会话快照 + 远端同步基准落盘（只在非 dry-run；基准是**单机状态**，不进仓）
  if (!dryRun) {
    snap.schemaVersion = 1;
    // 档 C（2026-10-13）：账本导出的节流键 —— **只在真导出那一轮写**（见 2) 段的 ledgerExported）
    if (ledgerExported) snap.ledgerExportedAt = now;
    snap.host = host;
    snap.updatedAt = nowIso(now);
    snap.sessions = sessions;
    // 体积历史（2026-09-16 拷问 P1）：每轮 append 一条采样、每仓保留 96 条（≈2 天），
    // 日报据此算「MB/小时」与「预计 N 小时撞 80% 配额线」——避免"撞线后才知道"。
    if (Array.isArray(volumeSamples) && volumeSamples.length) {
      snap.volumeHistory = snap.volumeHistory ?? {};
      for (const s of volumeSamples) {
        snap.volumeHistory[s.repo] = pushVolumeHistory(snap.volumeHistory[s.repo], { at: now, gitBytes: s.gitBytes, treeBytes: s.treeBytes });
      }
    }
    if (Object.keys(newBaseline).length) {
      snap.repos = { ...(snap.repos ?? {}) };
      for (const [n, sha] of Object.entries(newBaseline)) {
        snap.repos[n] = { lastSyncedSha: sha, lastSyncedAt: nowIso(now) };
      }
    }
    fs.mkdirSync(path.dirname(snapFile), { recursive: true });
    const dw = writeStateText('butler-handoff-hot.json', JSON.stringify(snap, null, 2) + '\n', {
      home, write: (p, t) => fs.writeFileSync(p, t, 'utf8'),
    });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  }

  // hard 挡（内容可能被抹）→ blocked；soft 挡（远端状态未知，只禁推送）→ 走 deferred（可重试）
  const hardBlocked = (gates.blocked ?? []).some((b) => b.hard !== false);
  out.result = dryRun
    ? 'dry-run'
    : (hardBlocked ? 'blocked' : (out.deferred.length ? 'deferred' : 'ok'));
  out.ok = out.result === 'ok';
  out.finishedAt = nowIso();
  out.durationMs = Date.now() - t0;
  return out;
}

/** 会话 zstd 帧完整性（首帧 magic + 逐帧解不抛错）。 */
export function frameIntact(file) {
  const buf = readBufSafe(file);
  if (!buf) return { ok: false, reason: 'unreadable' };
  if (!buf.length) return { ok: false, reason: 'empty' };
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  if (!buf.subarray(0, 4).equals(magic)) return { ok: false, reason: 'bad-magic' };
  const dec = decodeZstdFrames(buf);
  if (dec.frameErrors?.length) return { ok: false, reason: `frame-errors:${dec.frameErrors.length}` };
  if (!dec.frames) return { ok: false, reason: 'no-frames' };
  return { ok: true, frames: dec.frames };
}

/** 读会话尾部事件（只读尾部 N 字节 + 逐帧解 zstd + JSON 行解析）。 */
export function readTailEvents(file, tailBytes = 256 * 1024) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - tailBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const dec = decodeZstdFrames(buf);
  const events = [];
  for (const line of dec.text.split('\n')) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line); if (ev && typeof ev.type === 'string') events.push(ev); } catch { /* 尾部半行正常 */ }
  }
  events.sort((a, b) => Number(a?.seq ?? 0) - Number(b?.seq ?? 0));
  return events;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export { dshHome, hashFile, sha256Buf };
