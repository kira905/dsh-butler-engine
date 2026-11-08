#!/usr/bin/env node
// ============================================================================
// dsh-butler / handoff.mjs —— P9 H1a 手动交接器（Depart / Arrive / Status）
//
// 定位（卡 H1a 边界，写死）：**人手一键交接**，替代 dsh-sync-all.ps1 + 手工 SOP。
//   不做：不接 P2 事件 / 不做 P5 审计豁免 / 不接面板 / 不挂关机开机自动钩子（全属 H1b）；
//         不做语义合并（H2）；不做 C 类（插件实体 / 计划任务 / 桌面入口）bootstrap（H3）；
//         不做 30 分钟热采（H1b）。
//
// 用法：
//   node tools/dsh-butler/handoff.mjs --status [--json]
//   node tools/dsh-butler/handoff.mjs --depart --dry-run [--skip-sessions] [--json]
//   node tools/dsh-butler/handoff.mjs --depart [--skip-sessions] [--force]
//   node tools/dsh-butler/handoff.mjs --arrive --dry-run [--json]
//   node tools/dsh-butler/handoff.mjs --arrive [--confirm-diverged] [--adopt-unrecorded] [--force]
//
// 方案：docs\大管家v2.5-P9会交接与云中继方案-20260910.md
//   §4.2 落地层五动作 · §5.1 Arrive A1–A7 · §5.2 Depart 5 步 · §5.3 技术强制
//   §5.4 交接单字段白名单 · §5.5 失败与降级 · §5.7 时间语义 · §17.1 T3（Arrive 对偶门）
//
// 铁律（实现层强制，不靠人记）：
//   1. **禁镜像语义**：本文件不发起任何"镜像 / 删除目标端"的采集动作（不 purge、不删目标端多余文件）；
//      采集一律复用既有脚本的增量语义：robocopy 增量开关 + 显式 /R:2 /W:2 重试参数（见 dsh-backup-*.ps1）。
//   2. **Arrive 分发前过对偶门（T3）**：目标生产文件当前 hash ≠ 上一次交接单基线 → 跳过 + 告警。
//   3. **交接单绝不写生产绝对路径 / 密钥 / 会话内容**（写盘前 assertWritableRecord 硬校验）。
//   4. **推前超集体检 fail-closed**：远端有本机没有的提交、或仓里有生产没有的内容 → 中止本次采集。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { dshHome, ensureDir, COMPONENT_ROOT } from './lib/paths.mjs';
// 数据区根 / 工作副本根的口径全在 host-config（env > 兜底），本文件不写死任何盘符。
import { dshRoot, repoRoot } from '../lib/host-config.mjs';
import { resolveStatePath } from './lib/state-paths.mjs';
import { desktopEntryDir } from './lib/desktop-entry.mjs';
import { readJson, updateJson, writeJsonAtomic, writeTextAtomic, acquireTickLock } from './lib/store.mjs';
import { updateStateJson } from './lib/dual-write-store.mjs';
import { appendAudit } from './lib/audit.mjs';
import { alert as writeAlert } from './lib/alert.mjs';
// ③ 包 C-4（落地卡 ③-3 · 2026-09-20）：`_archive\handoff-*` 桶 GC 的**唯一实现**搬进 lib——
//   三约束（先摘凭据 → 逐文件校验字节 → 再删桶）/ 射程写死（只覆盖标准命名）/ 删桶必留痕 + 可见。
//   本文件只留"什么时候跑 + 怎么打印"这一层：判定、删除、审计、保留区全在库里 ⇒
//   沙箱与单测可注入根路径跑真流程（生产侧 dry-run 亦然），不必复制任何逻辑。
import { runGc, KEEP_DIR_NAME } from './lib/handoff-gc.mjs';
import * as core from './lib/handoff-core.mjs';
import { checkVersionGate, ensureLocalVersionFile, readVersionFile, localVersionPath, HANDOFF_TOOL_VERSION } from './lib/handoff-version.mjs';
// 体积阈值 / Gitee 配额口径 —— **单一真源**（2026-09-16 拷问 P1：原先与 lib/hot-collect.mjs 各抄一份）
import { VOLUME_THRESHOLDS, judgeRepoVolume, measureGitVolume } from './lib/repo-volume-thresholds.mjs';
import { compareVersionTables, CRITICAL_PLUGINS, pickCriticalPluginVersions, judgeDualActiveTransition } from './lib/handoff-version-gate.mjs';
import { computeClockSkew as computeClockSkewCore } from './lib/handoff-clock.mjs';
// T6 降级路径（§17.2）：时钟门拒绝时"一次自动校时"。**默认 dry-run**（只探测权限 + Time 服务状态），
// 仅 DSH_HANDOFF_RESYNC=1 才真跑系统命令；无权限/服务未启动 → 明确转人工（绝不许静默失败）。
import { runTimeResync, resyncEnabled } from './lib/time-resync.mjs';
import { acquirePitfallGuard, probePitfallWriter, judgeMemoryWindow, memoryWalBytes } from './lib/single-writer.mjs';
// 采集失败归因（2026-10-14 · 拍板「R5-Q2」/ 真源 R5 报告 §8-R6）：超时后自动区分
//   「空转（M-2：活干完了、调用没返回）」与「真没干完（预算不足/真慢）」。纯函数、零 IO，
//   两次 HEAD 由本文件只读取后注入；判定**不改变 fail-open 语义**（仍记 warn + deferred、不阻断）。
import { classifyCollectFailure, describeVerdict, COLLECT_VERDICT } from './lib/handoff-collect-verdict.mjs';
import { SQLITE_MAGIC } from './lib/merge-memory.mjs';
// 判据分工（2026-09-16 卡「修 Depart 前置超集体检假阳性」；同日卡「push-gate 对齐」收口）：
//   · `hasBlockingRisk` = 「真内容独有行」里**判不出可回退**的那部分 → **唯一挡推判据**：
//     本文件（Depart 前置体检）与 `dsh-backup-*.ps1 -Push` 门**共用**（后者经 CLI `--blocking-only`）；
//   · `hasRealRisk`（严格档，uniqueLines 非空即挡）仍留在 lib 里，供人工体检 / 回归锚点用。
import { checkRepo, hasBlockingRisk, isLocalBacklog } from '../lib/repo-superset.mjs';
// R-067（2026-10-16）：`--force-collect` 的统一绕过留痕。
//   为什么：R-053 超集体检门「形态学误报」是**本条(R-067)的头号实证** —— 每次 Depart 都要走强推口子、
//   形成死循环 ⇒ "这个门到底被绕过多少次"必须有可聚合的读数（原状：只有交接单告警 + 强推审计，没有次数视角）。
//   fail-open：台账写失败不影响采集/推送（见 tools\lib\bypass-ledger.mjs 头注）。
import { recordBypass } from '../lib/bypass-ledger.mjs';
// A6b 漏网文件分发（卡 AT12 · 2026-09-16）：候选集构造在 lib 里（纯函数，AT1 阶段 2 复用）；
//   写盘一律复用本文件既有的 executeDispatch/writeRestoreAssets（= A6 同一套门与备份）。
//   AT17（同日晚）补三处治本：分发锚（积压重扫）/ 仓侧门去死锁 / 写盘后自举重入。
import {
  buildAdoptCandidates, formatAdoptReport, resolveAdoptMode, ADOPT_STATE_NAME,
  readAdoptAnchor, resolveAdoptSince, judgeAnchorAdvance,
} from './lib/handoff-adopt.mjs';

export const HANDOFF_VERSION = core.HANDOFF_CORE_VERSION;
export const SCHEMA_VERSION = core.HANDOFF_SCHEMA_VERSION;

// ---------------------------------------------------------------- 路径与预算

/** 数据区根。优先级 BUTLER_HANDOFF_ROOT > BUTLER_DSH_ROOT > $DSH_WORKSPACE > ~/DSH（见 lib/host-config）。 */
const DSH_ROOT = process.env.BUTLER_HANDOFF_ROOT || dshRoot();
/** 三仓工作副本根（盘外，绝不进同步目录）。 */
const GIT_BACKUP = process.env.BUTLER_HANDOFF_GITBACKUP || repoRoot();
/** 交接期备份根（_archive 下，不进仓3）。 */
const ARCHIVE_ROOT = process.env.BUTLER_HANDOFF_ARCHIVE || path.join(DSH_ROOT, '_archive');

const REPOS = {
  'dsh-core': { dir: path.join(GIT_BACKUP, 'dsh-core'), script: path.join(DSH_ROOT, 'tools', 'dsh-backup-sync.ps1'), label: '仓1 .dsh 稳态' },
  'dsh-sessions': { dir: path.join(GIT_BACKUP, 'dsh-sessions'), script: path.join(DSH_ROOT, 'tools', 'dsh-backup-sessions.ps1'), label: '仓2 会话' },
  'dsh-workspace': { dir: path.join(GIT_BACKUP, 'dsh-workspace'), script: path.join(DSH_ROOT, 'tools', 'dsh-backup-workspace.ps1'), label: '仓3 数据区工具链' },
};
const REPO_ORDER = ['dsh-core', 'dsh-sessions', 'dsh-workspace'];

/** 体积阈值（§5.4 R6）—— 定义已迁到 `lib/repo-volume-thresholds.mjs`（单一真源，顶部 import）。 */
//  2026-09-16 拷问 P1 修复：原先本文件与 `lib/hot-collect.mjs` 各抄一份阈值表，
//  「保持同口径」只靠注释维系；且**口径从没写清**（全树 vs `.git` 差 40%+）。
//  现在判据 = `.git` 大小（与 Gitee 配额同量纲）+ 配额余量比两层，见 judgeRepoVolume()。

/** 超时预算（§5.7：一切超时用子进程级 timeout 兜底，不用墙钟计时）。
 *  sessionMergeMs（2026-09-12 新增）：A5 会话落地预算。实测幂等 6.3~9.5s、首次全量 20s 级；
 *  取 120s（v1 草案的 300s 偏大——一次异常会把接机整体挂住 5 分钟）。
 *  mergeMs / mergeTotalMs / arriveTotalMs（2026-09-15 · H2 接线）：A5b 离线语义合并预算。
 *  实测坑库/记忆库合并 <10s，单步取 60s；A5b 整段上限 120s，但**不得超过 §5.7 的 Arrive 内部总预算**
 *  （fetch 60 + pull 120 + 合并分发 120 = 300s；外层硬超时 330s）—— 故 A5b 实际可用预算 =
 *  min(mergeTotalMs, arriveTotalMs − 已用时长)，前面步骤吃掉的预算会实时从 A5b 扣除，保证不会把
 *  整段推过 300s 而撞上钩子的 330s 硬超时（dsh-start.ps1 的 WaitForExit）。 */
const BUDGET = {
  fetchMs: 60_000, pullMs: 120_000, collectMs: 600_000, pushMs: 900_000, gitMs: 30_000,
  sessionMergeMs: 120_000, mergeMs: 60_000, mergeTotalMs: 120_000, arriveTotalMs: 300_000,
};

const HANDOFF_FILE = path.join(dshHome(), core.HANDOFF_STATE_NAME);
const HANDOFF_VERSION_FILE = path.join(dshHome(), 'handoff-version.json');
// 桶 GC 的保留策略（20 份 / 30 天）与整套 GC 实现已一并迁到 `lib/handoff-gc.mjs`
//   （③ 包 C-4 · 落地卡 ③-3 · 2026-09-20）：**单一真源** = 该文件的 `GC_KEEP_MAX` / `GC_KEEP_DAYS`，
//   不要再在本文件里另立一份常量（旧副本已删除；验收断言同步指向新真源）。

// ---------------------------------------------------------------- 小工具

const OUT = { json: null, lines: [] };
/** 当前持有的「交接单例锁」（AT17 自举重入：必须先显式释放，新进程才抢得到锁）。 */
let ACTIVE_LOCK = null;
function log(msg = '') { OUT.lines.push(msg); process.stdout.write(msg + '\n'); }
function section(title) { log(''); log(`── ${title} ─────────────────────────────────`); }
function warn(msg) { log(`    !! ${msg}`); }
function ok(msg) { log(`    OK  ${msg}`); }
function bad(msg) { log(`    XX  ${msg}`); }

function git(dir, args, { timeout = BUDGET.gitMs } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024 });
  const err = `${r.stderr ?? ''}${r.error ? ' ' + r.error.message : ''}`.trim();
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout ?? '').trim(),
    err,
    timedOut: r.error?.code === 'ETIMEDOUT' || /timed? ?out/i.test(err),
  };
}

/**
 * 只读取某仓的 HEAD（③ 采集前后各取一次，供失败归因用）。
 * 【2026-10-14 · R5 §8-R6】零副作用：仓目录不存在 / 不是 git 仓 / git 调用失败 ⇒ 一律返回 null（=「未知」，绝不猜）。
 * @returns {string|null}
 */
function repoHead(dir) {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const r = git(dir, ['rev-parse', 'HEAD'], { timeout: BUDGET.gitMs });
    return r.ok && r.out ? r.out.trim() || null : null;
  } catch { return null; }
}

/**
 * 跑备份/推送脚本（③ 采集 600s / ④ push 900s 共用）。
 *
 * 【2026-10-14 · 拍板「R5-R1」】stdio 由「管道捕获」改为「**重定向到日志文件**」：
 *   ① 根治「长命孙进程继承 stdout 句柄 ⇒ spawnSync 白等到 timeout」这一类形态
 *      （= 本库 M-2 家族的官方修法，2026-09-29 修 `dsh-maintenance.mjs` 用的是同一招）；
 *   ② 完整 stdout/stderr 落盘 ⇒ 下次超时/失败能直接回放定位（此前全被吞进内存、事后无从回放，
 *      2026-10-14 那次 600s 超时就是为此绕一大圈才定性的；见 docs\交付报告-愿景核查-R5-Depart采集超时归因-20261014.md §8-R1）。
 * ⚠️ 因此**不再捕获输出**：`out` 恒为 ''（调用方本就不消费它），`err` 改为「错误摘要 + 日志路径」。
 *   超时行为 / deferred 语义 / 退出码契约**一律不变**。
 */
function ps1(script, args, { timeout, tag = 'handoff' }) {
  if (!fs.existsSync(script)) return { ok: false, code: -1, out: '', err: `脚本不存在：${path.basename(script)}`, timedOut: false, logPath: null };
  const logDir = path.join(DSH_ROOT, 'logs');
  let logPath = null;
  let fd = 'ignore';
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    fd = fs.openSync(logPath, 'w');
  } catch { fd = 'ignore'; logPath = null; }
  let r;
  try {
    r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      stdio: fd === 'ignore' ? 'ignore' : ['ignore', fd, fd],
      timeout, windowsHide: true,
    });
  } finally {
    if (fd !== 'ignore') { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  const hint = logPath ? `（完整输出见 ${logPath}）` : '';
  const err = r.error ? `${r.error.message}${hint}` : (r.status === 0 ? '' : hint);
  return { ok: r.status === 0, code: r.status, out: '', err, timedOut: r.error?.code === 'ETIMEDOUT', logPath };
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)}${u[i]}`;
}

/** DSH 是否在跑（只读探测；用于提示"热/冷"交接的知情，不参与任何判定）。 */
function dshRunning() {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).some((l) => /:3080\s/.test(l) && /LISTENING/i.test(l));
}

// ---- 附件对账 / 取回（卡 AT1 · 2026-09-16）--------------------------------------
// 为什么走 spawnSync 而不是静态 import：`tools/attachments-audit.mjs` 是本卡**新增**的工具，
//   对端若还没同步到它（tools/** 跨机分发滞后），静态 import 会让整个 handoff 直接
//   `Cannot find module` 崩掉（AT12 实测过同款：连「治工具」本身都送不到对端）。
//   ⇒ 一律「存在性判定 + 子进程执行」，工具不在就降级为一行 warn，绝不阻断交接主链。
function attachToolPath(name) { return path.join(DSH_ROOT, 'tools', name); }

/** 只读对账：会话引用的附件 sha256 vs 本机对象实体（退出码 3 = 有缺失，属正常结论）。 */
function runAttachAudit() {
  const script = attachToolPath('attachments-audit.mjs');
  if (!fs.existsSync(script)) return { ok: false, reason: `工具不存在（${path.basename(script)} 未同步到本机）` };
  const r = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', timeout: 900_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: `执行失败：${r.error.message}` };
  if (r.status !== 0 && r.status !== 3) return { ok: false, reason: `退出码 ${r.status}：${(r.stderr ?? '').trim().slice(0, 200)}` };
  try { return { ok: true, summary: JSON.parse(r.stdout) }; } catch (e) { return { ok: false, reason: `输出解析失败：${e?.message ?? e}` }; }
}

/** 从对端路径/介质目录按需取回缺失附件（退出码 0=全补齐 / 3=仍有缺失 / 4=有失败）。 */
function runAttachFetch(fromPath, reportPath) {
  const script = attachToolPath('attachments-fetch.mjs');
  if (!fs.existsSync(script)) return { ok: false, reason: `工具不存在（${path.basename(script)} 未同步到本机）` };
  const r = spawnSync(process.execPath, [script, '--all-missing', '--from', fromPath, '--verify', '--quiet', '--report', reportPath], {
    encoding: 'utf8', timeout: 900_000, maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) return { ok: false, reason: `执行失败：${r.error.message}` };
  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* 报告缺失不致命 */ }
  return { ok: r.status === 0, code: r.status, report, err: (r.stderr ?? '').trim().slice(0, 200) };
}

/**
 * 把「本机被引用的图片附件对象」导出成中转包（Depart `--attach-export <dir>` 的落点）。
 * 为什么存在（卡 AT1 · 缺口 C4）：附件实体不进任何仓 ⇒ 换机时附件不会自己跟过去；
 *   取回侧（Arrive A7b `--attach-fetch-from`）早已接好，**导出侧**此前只有提示文本没有人接线。
 * 落点与语义全部在 `tools/attachments-fetch.mjs --export`（不另造一套）：
 *   `<dir>/objects/<2>/<sha>` + `<dir>/manifest.json`；退出码 0=出包 / 3=有缺失源 / 4=写盘失败。
 * dryRun ⇒ 透传 `--dry-run`（工具只统计、**零写盘**），因此 dry-run 下本段也可安全跑。
 */
function runAttachExport(outDir, { dryRun = false } = {}) {
  const script = attachToolPath('attachments-fetch.mjs');
  if (!fs.existsSync(script)) return { ok: false, reason: `工具不存在（${path.basename(script)} 未同步到本机）` };
  const args = [script, '--export', outDir, '--json'];
  if (dryRun) args.push('--dry-run');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 900_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: `执行失败：${r.error.message}` };
  // 工具 --json 输出单行 compact JSON；从后往前找首个可解析行（兼容历史多行输出，同 ②c 口径）
  const lines = String(r.stdout ?? '').trim().split('\n').map((s) => s.trim()).filter(Boolean);
  let summary = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { summary = JSON.parse(lines[i]); break; } catch { /* 不是 JSON 行，继续往前找 */ }
  }
  if (r.status !== 0 && r.status !== 3) {
    return { ok: false, code: r.status, summary, reason: `退出码 ${r.status}：${(r.stderr ?? '').trim().slice(0, 200)}` };
  }
  return { ok: r.status === 0, code: r.status, summary };
}

function ctx() {
  return { workDirs: Object.fromEntries(REPO_ORDER.map((n) => [n, REPOS[n].dir])), dshHome: dshHome(), dshRoot: DSH_ROOT };
}

function repoOrder(o) {
  return o.skipSessions ? REPO_ORDER.filter((n) => n !== 'dsh-sessions') : REPO_ORDER.slice();
}

function tsStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readDshVersion() {
  const file = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  return core.readJsonSafe(file, null)?.version ?? null;
}

/**
 * 读关键插件版本（§5.3 R10）。
 * 口径（2026-09-14 实测）：**优先读 profile 里 node_modules 的实体 package.json**，
 * 读不到再退回 `profiles/web/package.json` 的声明值 —— 实测存在"声明 1.0.0、实体 1.1.0"的
 * 半升级态（board-merge.mjs 也踩过），只看声明值会误判版本门。
 */
function readPluginVersions() {
  const webRoot = path.join(dshHome(), 'profiles', 'web');
  const decl = core.readJsonSafe(path.join(webRoot, 'package.json'), null);
  const deps = decl?.dependencies ?? {};
  const out = {};
  for (const [k, v] of Object.entries(deps)) {
    if (!/task-board|butler|imagegen|ecosystem|archive-sessions/i.test(k)) continue;
    out[k] = String(v);
  }
  // 实体版本覆盖（实体读不到就保留声明值）
  for (const name of Object.keys(out)) {
    const pkg = core.readJsonSafe(path.join(webRoot, 'node_modules', ...name.split('/'), 'package.json'), null);
    if (pkg?.version) out[name] = String(pkg.version);
  }
  return out;
}

function repoHeads(dir) {
  const localHead = git(dir, ['rev-parse', '--short', 'HEAD']).out || null;
  const remoteHead = git(dir, ['rev-parse', '--short', 'origin/master']).out || null;
  const ab = git(dir, ['rev-list', '--left-right', '--count', 'HEAD...origin/master']);
  let ahead = null, behind = null;
  if (ab.ok && /\d+\s+\d+/.test(ab.out)) {
    const [a, b] = ab.out.split(/\s+/).map((x) => Number(x));
    ahead = a; behind = b;
  }
  const dirty = (git(dir, ['status', '--porcelain']).out || '').split('\n').filter(Boolean).length;
  return { localHead, remoteHead, ahead, behind, dirty };
}

// ---------------------------------------------------------------- 交接单读写

// 合并时钟门阈值（§5.7 R3）的单一真相 = lib/handoff-clock.mjs 的 CLOCK_SKEW_LIMIT_MS（120s），
// 判定与阈值都在那里；本文件只调用 computeClockSkewCore，不再自己声明一份。

/**
 * 读热采状态（`~/.dsh/butler-handoff-hot.json`）→ 交接单 `hotCollect` 字段（白名单字段，全部可空）。
 * 读不到（热采还没跑过）→ 全 null，不报错。
 */
function readHotStatus() {
  const st = core.readJsonSafe(resolveStatePath('butler-handoff-hot.json', { home: dshHome() }).path, null);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    at: st?.updatedAt ?? null,
    result: st?.lastResult ?? null,
    copiedFiles: n(st?.files?.copied),
    movedSessions: n(st?.sessions?.moved),
    openSkipped: n(st?.sessions?.openSkipped),
    ledgerRevision: n(st?.ledger?.revision),
  };
}

// ---------------------------------------------------------------- 权威时刻取数（判据① 的参照）
// 背景（2026-09-15 13:16 生产实测）：判据① 原口径「now − 本机自己最新提交的 git 时间，绝对值超 120s 即拒」
// **恒误拒** —— Arrive 之前必然有一次 hot-collect 提交（本次 13:10:31 vs Arrive 13:16 ⇒ selfSkewMs=316215）。
// 修法 = 引入**权威时刻**（HTTP `Date` 响应头）当参照；取不到再回退 A 档（只挡负向偏差）。口径见 lib/handoff-clock.mjs。
/** 权威时刻源（可用 env 覆盖；`off`/`none`/`0` = 不取 → 回退 A 档）。 */
const HANDOFF_TIME_URL = String(process.env.DSH_HANDOFF_TIME_URL ?? 'https://www.gitee.com');
/** 取数硬超时（**必须 ≤3s**：Arrive 挂在开机链路、guard 尚未接管，网络可能没就绪 —— 任何情况下不得阻塞开机）。 */
const TIME_FETCH_TIMEOUT_MS = 3_000;
/** 正向大间隔升级为 🟡 告警的门槛（1h）：热采刚提交是常态（分钟级），不该每次都刷告警。 */
const CLOCK_POSITIVE_WARN_MS = 3_600_000;

let httpTimeFetched = false;
let httpTimeMs = null;

/**
 * 取权威时刻（毫秒 epoch）——**一次交接只取一次**（memo；交接单填写与 A5b 门④ 共用同一次结果），
 * 失败 / 超时 / 异常一律返回 `null`（**绝不抛**给 Arrive 主流程）。
 * 实现：`curl -I` 读 HEAD 的 `Date:` 响应头（IMF-fixdate，秒精度 —— 相对 120s 阈值可忽略）。
 * ⚠️ 这里是**唯一**发网络请求的地方，且只在网络已就绪时才可能成功；任何失败都只是"回退 A 档"。
 * 导出仅为**只读复现/测试**（`_archive\handoff-clock-fix-*\evidence\` 会真跑它取证；交接主流程不受影响）。
 */
export function fetchHttpTimeMs() {
  if (httpTimeFetched) return httpTimeMs;
  httpTimeFetched = true;
  httpTimeMs = null;
  const url = HANDOFF_TIME_URL.trim();
  if (!url || /^(off|none|0|false|disabled?)$/i.test(url)) {
    log(`    时钟校准：DSH_HANDOFF_TIME_URL=${url || '(空)'} → 不取权威时刻（回退 A 档：只挡负向偏差）`);
    return null;
  }
  try {
    const r = spawnSync('curl.exe', ['-sSI', '--max-time', '3', '--connect-timeout', '2', url],
      { encoding: 'utf8', timeout: TIME_FETCH_TIMEOUT_MS + 1_000, maxBuffer: 1024 * 1024 });
    const m = `${r.stdout ?? ''}`.match(/^date:\s*(.+)$/im);
    const ms = m ? Date.parse(m[1].trim()) : NaN;
    if (!Number.isFinite(ms)) {
      const why = r.status === null ? (r.error?.code ?? 'spawn-failed') : `curl exit ${r.status}`;
      log(`    时钟校准：取权威时刻失败（${why}）→ 回退 A 档（fail-open）`);
      return null;
    }
    httpTimeMs = ms;
    log(`    时钟校准：权威时刻 ${new Date(ms).toISOString()}（源 ${url}）`);
    return httpTimeMs;
  } catch (e) {
    log(`    时钟校准：取权威时刻异常（${e?.message ?? e}）→ 回退 A 档（fail-open）`);
    return null;
  }
}

/**
 * 时钟偏差（§5.7 R3 · 对时校验）：**判定逻辑在 `lib/handoff-clock.mjs`（纯函数）**，
 * 本函数只提供 IO（git 调用 + 读仓内对端交接单 + 权威时刻取数）—— 单测与生产共用同一份判定口径。
 * 导出仅为**只读复现/测试**（生产入口仍走 isMain 守卫）。
 */
export function computeClockSkew() {
  const skewHost = core.currentHost();
  const skewRepoDir = REPOS['dsh-core'].dir;
  const skewSub = core.HANDOFF_REPO_SUBDIR;
  return computeClockSkewCore({
    host: skewHost,
    fetchTimeMs: fetchHttpTimeMs,
    repos: REPO_ORDER.map((n) => ({ name: n, dir: REPOS[n]?.dir })).filter((r) => r.dir && fs.existsSync(path.join(r.dir, '.git'))),
    gitLog: (dir, args) => { const r = git(dir, args); return r.ok ? r.out : null; },
    readPeerRecord: () => {
      try {
        const ls = git(skewRepoDir, ['ls-tree', '--name-only', 'origin/master', `${skewSub}/`]);
        const names = ls.ok ? ls.out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.json')) : [];
        for (const full of names) {
          const base = path.basename(full).replace(/\.json$/, '');
          if (base === skewHost) continue;
          const raw = git(skewRepoDir, ['show', `origin/master:${full}`]);
          if (!raw.ok) continue;
          let rec = null;
          try { rec = JSON.parse(raw.out); } catch { continue; }
          return { host: base, record: rec, repoDir: skewRepoDir, repoPath: full };
        }
      } catch { /* 取不到就不判 */ }
      return null;
    },
  });
}

/**
 * 把「热采快照 + 时钟门（§5.7 R3）」写进交接单（Depart / Arrive 共用，避免两处口径漂移）。
 * 时钟偏差超阈值 → 记 warn 告警，并在末尾把"要求人工对时"这件事说清（真正的拒绝合并属 H2）。
 *
 * A 档（2026-09-15）：正向大间隔（如热采刚提交过）**只告警不挡**，且只有超过 CLOCK_POSITIVE_WARN_MS（1h）
 * 才升级为 🟡 —— 否则"每次接机都刷一条 warn"就又变成噪音了。
 */
function fillHotAndClock(record) {
  record.hotCollect = readHotStatus();
  const skew = computeClockSkew();
  record.clockSkew = { selfSkewMs: skew.selfSkewMs, peerSkewMs: skew.peerSkewMs, limitMs: skew.limitMs, ok: skew.ok };
  log(`    时钟门（§5.7 R3）：${skew.reason}`);
  if (skew.ok === false) {
    record.alerts.push({ level: 'warn', code: 'clock-skew', message: `时钟偏差超阈值（${skew.reason}）→ 合并前要求人工对时（R3；合并器接线属 H2）` });
  } else if (skew.warnings?.length) {
    for (const w of skew.warnings) log(`    ~~ ${w}`);
    if (Number.isFinite(skew.selfSkewMs) && skew.selfSkewMs > CLOCK_POSITIVE_WARN_MS) {
      record.alerts.push({ level: 'warn', code: 'clock-skew-positive', message: `本机钟 vs 自身提交时刻为正偏差且超 1h（${skew.reason}）→ 不挡合并（A 档），仅供参考`.slice(0, 300) });
    }
  }
  return skew;
}

function readLocalRecord() {
  return readJson(HANDOFF_FILE, { defaultValue: null });
}

/** 写本机交接单（butler-store 原子写 + RMW 锁 + schema 白名单 + 无绝对路径硬校验）。 */
function writeLocalRecord(record) {
  const check = core.assertWritableRecord(record);
  if (!check.ok) {
    throw new Error(`交接单校验失败，拒绝写入（${check.errors.length} 条）：\n  - ${check.errors.slice(0, 10).join('\n  - ')}`);
  }
  updateStateJson(core.HANDOFF_STATE_NAME, HANDOFF_FILE, () => record, { schemaVersion: SCHEMA_VERSION, defaultValue: null });
  return check;
}

/** 读对端交接单：优先远端 ref（origin/master 上的最新），退回工作副本。 */
function readPeerRecords(host) {
  const out = [];
  const repoDir = REPOS['dsh-core'].dir;
  const sub = core.HANDOFF_REPO_SUBDIR;
  const ls = git(repoDir, ['ls-tree', '--name-only', 'origin/master', `${sub}/`]);
  const names = ls.ok ? ls.out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.json')) : [];
  for (const full of names) {
    const base = path.basename(full);
    const peerHost = base.replace(/\.json$/, '');
    if (peerHost === host) continue;
    const raw = git(repoDir, ['show', `origin/master:${full}`]);
    if (!raw.ok) continue;
    try {
      out.push({ host: peerHost, record: JSON.parse(raw.out), source: 'origin/master' });
    } catch { /* 坏 JSON 跳过，不猜 */ }
  }
  if (!out.length) {
    const dir = path.join(repoDir, sub.replace(/\//g, path.sep));
    for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
      if (!f.endsWith('.json')) continue;
      const peerHost = f.replace(/\.json$/, '');
      if (peerHost === host) continue;
      const rec = core.readJsonSafe(path.join(dir, f), null);
      if (rec) out.push({ host: peerHost, record: rec, source: 'worktree' });
    }
  }
  return out;
}

/** 把交接单同步到仓1 工作副本 `dsh/butler-handoff/<host>.json` 并单独提交（不 push）。 */
function stageRepoCopy(record) {
  const repoDir = REPOS['dsh-core'].dir;
  const dir = path.join(repoDir, core.HANDOFF_REPO_SUBDIR.replace(/\//g, path.sep));
  ensureDir(dir);
  const file = path.join(dir, `${record.host}.json`);
  writeJsonAtomic(file, record, {});
  git(repoDir, ['add', '--', `${core.HANDOFF_REPO_SUBDIR}/${record.host}.json`]);
  const st = git(repoDir, ['status', '--porcelain', '--', core.HANDOFF_REPO_SUBDIR]);
  if (!st.out) return { ok: true, committed: false, file };
  const msg = `${tsStamp()} ${record.host.toUpperCase()} handoff record (${record.role})`;
  const c = git(repoDir, ['commit', '-m', msg]);
  return { ok: c.ok, committed: true, file, message: msg, err: c.err };
}

/** 挡推逃生舱审计（§17.2 T9：绕过护栏必须留痕）。 */
function logForcePush(repo, reason, risky) {
  const script = path.join(COMPONENT_ROOT, 'forcepush-log.mjs');
  if (!fs.existsSync(script)) return { ok: false, error: 'forcepush-log.mjs 不存在' };
  const args = [script, '--repo', repo, '--reason', reason || 'handoff --force-collect（人工裁决后方可弃/本机为超集）'];
  if (risky?.length) args.push('--risky', risky.slice(0, 20).join('; '));
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), error: (r.stderr ?? '').trim() };
}

function pushRepo(name, { force = false, reason = '', risky = [] } = {}) {
  if (force) logForcePush(name, reason, risky);
  return ps1(REPOS[name].script, force ? ['-Push', '-ForcePush'] : ['-Push'], { timeout: BUDGET.pushMs, tag: `push-${name}` });
}

// ---- 统一开关一致检查（**S1b 接线** · 真源 v2 §5.2 / §5.4-②）---------------------------------
// 首期动作 = **不接线、只做一致性检查**（v2 §5.4-② 原文）：读唯一开关文件的 `repo2.push`，与本轮
//   Depart 的 `skipSessions`（默认 true；`--with-sessions` 反向覆盖）比对，不一致就打印告警。
//   **不改变任何行为** —— 既有默认已停仓2；`--with-sessions` 是 CLI 显式参数（v2 §5.2 读取优先级
//   「CLI 显式参数 > 开关文件」的第一段）⇒ 保留。
// 为什么走子进程而不是 import：读取器是 S1 新增件，跨机分发可能滞后；静态 import 会让整个交接器
//   在缺件时 `Cannot find module` 崩掉 —— 同款处置见本文件 `attachToolPath` 段（AT12 先例）。
const TOPOLOGY_READER = path.join(COMPONENT_ROOT, 'lib', 'sync-topology.mjs');

function checkRepo2Topology(o) {
  if (o.mode !== 'depart') return null;              // 只有 Depart 会推仓2（Arrive 是只读拉取侧）
  if (!fs.existsSync(TOPOLOGY_READER)) {
    log('    [topology] 同步拓扑读取器未分发到本机 ⇒ 未读到开关，按现值执行');
    return null;
  }
  let r = null;
  try { r = spawnSync(process.execPath, [TOPOLOGY_READER, '--get', 'repo2.push'], { encoding: 'utf8', timeout: 30_000 }); } catch { r = null; }
  const rc = r?.status ?? null;
  for (const l of String(r?.stderr ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) log(`    [topology] ${l}`);
  const val = String(r?.stdout ?? '').trim();
  const fromFile = rc === 0 && (val === 'true' || val === 'false');
  const willPush = !o.skipSessions;                  // 不接线 ⇒ 行为仍由既有参数决定
  if (!fromFile) {
    log(`    [topology] 未读到 repo2.push（rc=${rc ?? '-'}）⇒ 按现值执行（${willPush ? '本次会推仓2' : '本轮不推仓2'}）`);
    return null;
  }
  if (val === 'true' && !willPush) log('    [topology] topology 与 job 参数不一致：repo2.push=true 但本轮带 skipSessions ⇒ 按停仓2 执行（取更严）');
  else if (val === 'false' && willPush) log('    [topology] topology 与开关文件不一致：repo2.push=false 但本轮会推仓2 —— 显式 CLI 参数优先（v2 §5.2 优先级），属已知口径');
  else log(`    [topology] repo2.push=${val} 与本轮「${o.skipSessions ? 'skipSessions（不推仓2）' : '会推仓2'}」一致`);
  return { fromFile: true, value: val === 'true' };
}

// ---------------------------------------------------------------- 备份 / 恢复脚本

const RESTORE_MJS = `#!/usr/bin/env node
// 交接期一键恢复（由 handoff.mjs 生成；只恢复本次 Arrive 覆盖/新增的文件 + 上一版本机交接单）
//
// 用法：node restore.mjs [--dry-run] [--keep-new]
//   --dry-run   只打印将恢复的内容
//   --keep-new  保留本次新增的文件（不删除）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DSH_ROOT = process.env.BUTLER_DSH_ROOT || process.env.BUTLER_HANDOFF_ROOT || path.join(os.homedir(), 'DSH');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const keepNew = argv.includes('--keep-new');

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'backup-manifest.json'), 'utf8'));
const anchorRoot = (a) => (a === 'dsh' ? DSH_HOME : a === 'ws' ? DSH_ROOT : null);

let restored = 0, removed = 0, failed = 0;
for (const e of manifest.entries) {
  const root = anchorRoot(e.anchor);
  if (!root) { console.log('skip: unknown anchor ' + e.anchor); failed++; continue; }
  const dst = path.join(root, e.prodRel.split('/').join(path.sep));
  if (e.existed) {
    const src = path.join(HERE, 'files', e.anchor, e.prodRel.split('/').join(path.sep));
    if (!fs.existsSync(src)) { console.log('MISS backup: ' + e.key); failed++; continue; }
    if (dryRun) { console.log('would restore ' + e.key); restored++; continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log('restored ' + e.key);
    restored++;
  } else if (!keepNew && fs.existsSync(dst)) {
    if (dryRun) { console.log('would remove (new) ' + e.key); removed++; continue; }
    fs.rmSync(dst, { force: true });
    console.log('removed (new) ' + e.key);
    removed++;
  }
}
const prev = path.join(HERE, 'butler-handoff.prev.json');
if (fs.existsSync(prev)) {
  const target = path.join(DSH_HOME, 'butler-handoff.json');
  if (dryRun) console.log('would restore handoff record baseline');
  else { fs.copyFileSync(prev, target); console.log('restored handoff record baseline'); }
}
console.log('---- done: restored=' + restored + ' removed=' + removed + ' failed=' + failed + (dryRun ? ' (dry-run)' : ''));
process.exit(failed ? 1 : 0);
`;

function writeRestoreAssets(archiveDir, entries, prevRecord) {
  ensureDir(path.join(archiveDir, 'files'));
  writeJsonAtomic(path.join(archiveDir, 'backup-manifest.json'), { generatedAt: new Date().toISOString(), entries }, {});
  if (prevRecord) writeJsonAtomic(path.join(archiveDir, 'butler-handoff.prev.json'), prevRecord, {});
  writeTextAtomic(path.join(archiveDir, 'restore.mjs'), RESTORE_MJS, {});

  // 恢复脚本落点：桌面<恢复入口目录>\（2026-09-11 定：DSH 的东西统一收纳，桌面根只留三件套快捷方式）
  const entryDir = desktopEntryDir();
  const cmd = [
    '@echo off',
    'REM dsh-butler handoff restore (generated by tools\\dsh-butler\\handoff.mjs)',
    `REM archive: ${archiveDir}`,
    `node "${path.join(archiveDir, 'restore.mjs')}" %*`,
    'echo.',
    'pause',
    '',
  ].join('\r\n');
  writeTextAtomic(path.join(archiveDir, 'restore-handoff.cmd'), cmd, {});
  if (!entryDir) return { desktopFile: null, error: '恢复入口目录不可用（无可写桌面基目录）' };
  const entryFile = path.join(entryDir, 'restore-handoff.cmd');
  try {
    writeTextAtomic(entryFile, cmd, {});
  } catch (e) {
    return { desktopFile: null, error: e?.message ?? String(e) };
  }
  return { desktopFile: entryFile, error: null };
}

/**
 * §5.7 R12 + ③ 包 C-4（卡 ③-3）：`_archive\handoff-*` 的 GC —— **本进程是这条动作的唯一真删入口**。
 *
 * 实现全部在 `lib/handoff-gc.mjs`（本函数只做注入）：
 *   · 三约束 = 先摘凭据（`_archive\handoff-keep\<桶>\`）→ 逐文件字节+sha256 校验 → 再删桶主体；
 *   · 射程写死 = 只覆盖 `^handoff-\d{8}-\d{6}$`，非标准 `handoff-*` 桶**永不删**（只列名可见）；
 *   · 留痕 = 每轮一条 `handoff-gc` summary 审计 + 每删一桶一条明细（2026-09-17 22:20 拍板
 *     「删桶必留痕 + 日报可见」，推翻 P9 §5.7 原口径「超期静默清理（属备份，不告警）」）。
 *   · fail-close = 保留区不可写 ⇒ **整轮不删**；单桶凭据复制/校验失败 ⇒ **该桶不删**（都发 alert）。
 * `--dry-run` 时只打印"将会删哪些桶、凭据摘哪些字节"，**不写审计、不复制、不删**。
 */
function gcArchives(o = {}) {
  const isDry = o.dryRun === true;
  return runGc({
    archiveRoot: ARCHIVE_ROOT,
    now: Date.now(),
    dryRun: isDry,
    audit: isDry ? null : (rec) => appendAudit(rec),
    alert: (a) => writeAlert(a),
  });
}

/** GC 结果日志（可见性：dry-run 逐桶列"将会删/将会摘"，真跑列"删了几个/摘了几份"）。 */
function logGcResult(gc) {
  const s = gc?.summary;
  if (!s) return;
  if (gc.dryRun) {
    log(`    _archive GC（dry-run，未删任何桶）：将会删 ${s.plannedDelete} 个 handoff 桶 · 将会摘凭据 ${s.plannedCredentials} 项（${s.plannedCredBytes}B）→ ${gc.keepRoot}`);
    for (const p of gc.planned) {
      log(`      - 将会删 \`${p.bucket}\`（${p.files} 文件 / ${p.bytes}B / ${p.reason}）· 凭据：${p.credentials.length ? p.credentials.join('、') : '（无）'}`);
    }
  } else if (s.deleted > 0) {
    log(`    _archive 清理：**删除 ${s.deleted} 个**过期 handoff-* 目录（凭据已摘 ${s.credentialsKept} 份 → ${KEEP_DIR_NAME}/；已写审计 handoff-gc）`);
  }
  if (s.nonStandard > 0) {
    log(`    非标准 handoff 桶 ${s.nonStandard} 个（不在 GC 射程，需人工清理）：${s.nonStandardNames.join('、')}${s.nonStandardTruncated ? ' …' : ''}`);
  }
  for (const k of s.skipped) warn(`GC 跳过 \`${k.bucket}\`：${k.reason}${k.detail ? `（${k.detail}）` : ''}`);
  if (s.aborted) bad(`GC 本轮中止（未删任何桶）：${s.aborted.reason}${s.aborted.detail ? ` — ${s.aborted.detail}` : ''}`);
}

// ---------------------------------------------------------------- 分发执行

function executeDispatch(plan, o, { archiveDir, ts }) {
  const backupEntries = [];
  let appliedCount = 0, failedCount = 0;
  for (const item of plan) {
    if (item.action !== 'applied') continue;
    const dstExists = fs.existsSync(item.dst);
    if (dstExists) {
      const backupRel = path.join('files', item.anchor, ...item.prodRel.split('/'));
      const target = path.join(archiveDir, backupRel);
      try {
        ensureDir(path.dirname(target));
        if (!o.dryRun) fs.copyFileSync(item.dst, target);
      } catch (e) {
        item.action = 'failed';
        item.reason = `备份失败：${e?.message ?? e}`;
        failedCount++;
        continue;
      }
      backupEntries.push({ key: item.key, anchor: item.anchor, prodRel: item.prodRel, existed: true });
    } else {
      backupEntries.push({ key: item.key, anchor: item.anchor, prodRel: item.prodRel, existed: false });
    }
    if (o.dryRun) { appliedCount++; continue; }
    try {
      ensureDir(path.dirname(item.dst));
      fs.copyFileSync(item.src, item.dst);
      // 写后读回校验（H3 · 2026-09-16）：.ps1 的 BOM 是**分发后必须仍然存在**的事实——
      // 源侧已在 planDispatch 过了 BOM 门，这里兜住"写盘/杀软/换行归一"等旁路把 BOM 弄丢的情况。
      if (core.bomRequired(item.dst)) {
        const chk = core.checkBomRequirement(item.dst);
        if (chk.risky) {
          item.action = 'failed';
          item.reason = '写后读回校验失败：目标 .ps1 含非 ASCII 字节却丢掉了 UTF-8 BOM（EF BB BF）';
          failedCount++;
          continue;
        }
      }
      appliedCount++;
    } catch (e) {
      item.action = 'failed';
      item.reason = `写入失败：${e?.message ?? e}`;
      failedCount++;
    }
  }
  return { backupEntries, appliedCount, failedCount };
}

function summarizePlan(plan) {
  const by = {};
  for (const p of plan) by[p.action] = (by[p.action] ?? 0) + 1;
  return by;
}

/**
 * AT17（2026-09-16）仓侧门「合法性」判据：该文件在工作副本相对 HEAD 是否**无未提交改动**。
 *   干净 ⇒ 工作副本内容 == HEAD 里那一版；门的前提是 HEAD 未前进（哈希没变）⇒ 仓里那份内容与上次
 *     交接时逐字节相同 ⇒「仓侧 sha ≠ 基线」不可能是本轮回退，只能是上次没分发成功的历史遗留 ⇒ 可放行。
 *   脏   ⇒ 内容不是 HEAD 的（谁把旧内容写回去过 / 手工改过）⇒ fail-closed 保持拦截（反向锚）。
 *   任何 git 异常（非 0 且非 1）一律返回 false（= 不干净 ⇒ 拦），绝不放行。
 */
function repoFileClean(dir, repoPath) {
  if (!dir || !repoPath || !fs.existsSync(path.join(dir, '.git'))) return false;
  const r = spawnSync('git', ['-C', dir, 'diff', '--quiet', 'HEAD', '--', repoPath], {
    encoding: 'utf8', timeout: BUDGET.gitMs, windowsHide: true,
  });
  return r.status === 0;
}

/**
 * A6b：仓 → 生产锚点映射（惰性求值 —— dshHome() 读 env，别在模块加载期固化）。
 * 仓1 的 `dsh/` 前缀对应 `~/.dsh/`；仓3 直接对应数据区根；仓2（会话）不属本通道。
 */
function adoptAnchorFor(repoName) {
  if (repoName === 'dsh-core') return { anchor: 'dsh', prodRoot: dshHome() };
  if (repoName === 'dsh-workspace') return { anchor: 'ws', prodRoot: DSH_ROOT };
  return null;
}

// ---------------------------------------------------------------- --status

function cmdStatus(o) {
  // 版本文件自举（H1b）：`--status` 是只读查询，但版本门文件是交接器的**元数据声明**
  //（不是业务数据），缺失时补一份才能让 `--status` 如实显示 self —— 否则用户以为没接线。
  let verFile = localVersionPath();
  try {
    const vs = ensureLocalVersionFile({ home: dshHome(), dshRoot: DSH_ROOT });
    if (vs.created) log(`    （已自举手交接版本文件 ${path.basename(vs.file)}：self=${vs.data.self}）`);
    verFile = vs.file;
  } catch (e) {
    warn(`版本文件自举失败：${String(e?.message ?? e).slice(0, 120)}`);
  }
  const cfg = ctx();
  const host = core.currentHost();
  const local = readLocalRecord();
  const manifest = core.loadManifest();
  const expanded = core.expandManifest(manifest, cfg);
  const baseline = core.baselineFromRecord(local);

  section(`交接状态 · 本机 ${host}`);
  if (!local) {
    warn('本机无交接单（尚未交接）');
  } else {
    log(`    上次交接：role=${local.role} result=${local.result}`);
    log(`    startedAt=${local.startedAt}  finishedAt=${local.finishedAt ?? '(未完成)'}`);
    log(`    心跳 lastHeartbeatAt=${local.lastHeartbeatAt ?? '(无)'}`);
    log(`    完整交接 lastSuccessfulHandoffAt=${local.lastSuccessfulHandoffAt ?? '(无)'}`);
    log(`    applied=${(local.applied ?? []).length} 条 / alerts=${(local.alerts ?? []).length} 条 / repos=${(local.repos ?? []).length} 个`);
  }

  section('对端交接单（仓内副本）');
  const peers = readPeerRecords(host);
  if (!peers.length) warn('未发现对端记录（新机 / 冷启动）');
  for (const p of peers) {
    const judge = core.judgeHeartbeat(p.record, { startedAtMs: Date.now() });
    log(`    [${p.host}] result=${p.record.result} finishedAt=${p.record.finishedAt ?? '(未完成)'}`);
    log(`       来源=${p.source}  lastHeartbeatAt=${p.record.lastHeartbeatAt ?? '(无)'}  lastSuccessfulHandoffAt=${p.record.lastSuccessfulHandoffAt ?? '(无)'}`);
    for (const r of judge.reasons) log(`       · ${r}`);
  }

  section('三仓（本地 ref，不联网）');
  for (const name of REPO_ORDER) {
    const info = REPOS[name];
    if (!fs.existsSync(path.join(info.dir, '.git'))) { warn(`${name}: 工作副本不存在`); continue; }
    const h = repoHeads(info.dir);
    log(`    ${name.padEnd(14)} HEAD=${h.localHead ?? '?'} origin=${h.remoteHead ?? '?'} ahead=${h.ahead ?? '?'} behind=${h.behind ?? '?'} dirty=${h.dirty}  [${info.label}]`);
  }

  section('分发清单');
  for (const entry of manifest.entries) {
    const on = entry.enabled === false ? 'off' : 'on ';
    const cnt = expanded.files.filter((f) => f.key === entry.key || f.key.startsWith(entry.key + '/')).length;
    log(`    [${on}] ${entry.key}  (${entry.type}, 展开 ${cnt} 个文件)  ${entry.note ?? ''}`);
  }
  if (expanded.errors.length) for (const e of expanded.errors) warn(e);

  section('对偶门预检（T3，只读）');
  const { plan, alerts } = core.planDispatch(expanded.files, baseline, {});
  const by = summarizePlan(plan);
  log(`    本机交接基线 ${Object.keys(baseline).length} 项；清单展开 ${expanded.files.length} 个文件`);
  for (const [k, v] of Object.entries(by)) log(`    ${k}: ${v}`);
  const risky = plan.filter((p) => p.action.startsWith('skipped'));
  for (const r of risky.slice(0, 30)) log(`      · ${r.key} — ${r.reason}`);
  if (risky.length > 30) log(`      ...共 ${risky.length} 项`);
  if (alerts.length) log(`    对偶门告警 ${alerts.length} 条`);

  OUT.json = {
    host, localRecord: local, peers: peers.map((p) => ({ host: p.host, source: p.source, record: p.record })),
    repos: REPO_ORDER.map((n) => ({ name: n, ...repoHeadsSafe(n) })),
    manifestEntries: manifest.entries.length,
    plannedFiles: expanded.files.length,
    planSummary: by,
    baselineKeys: Object.keys(baseline).length,
    alerts,
  };
  return 0;
}

function repoHeadsSafe(name) {
  const dir = REPOS[name].dir;
  if (!fs.existsSync(path.join(dir, '.git'))) return { missing: true };
  return repoHeads(dir);
}

// ---------------------------------------------------------------- --depart

function cmdDepart(o) {
  const cfg = ctx();
  const host = core.currentHost();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const record = core.emptyRecord(host, startedAt);
  record.role = 'depart';
  record.dshVersion = readDshVersion();
  record.pluginVersions = readPluginVersions();

  const prevRec = readLocalRecord();
  record.lastHeartbeatAt = prevRec?.lastHeartbeatAt ?? null;
  record.lastSuccessfulHandoffAt = prevRec?.lastSuccessfulHandoffAt ?? null;

  section(`Depart · 前置检查（主机 ${host}${o.dryRun ? ' · DRY-RUN' : ''}）`);
  const running = dshRunning();
  if (running === true) {
    warn('DSH 正在运行（3080 监听中）→ 本次是**热采集**：memory.db / 看板账本可能取到中间态（下次 -Sync 修正）；关机链冷采集见 §5.2');
    record.alerts.push({ level: 'info', code: 'hot-collect', message: 'Depart 在 DSH 运行中执行（热采集，非关机链冷采集）' });
  } else if (running === false) {
    ok('DSH 未运行（3080 无监听）→ 冷采集（关机链/D-档）');
  }

  // 版本门（§5.3 第 1 条）：Depart 侧同样先保证自举 + 读门禁，**拒绝执行**（fail-closed）
  const gate = checkVersionGate({ home: dshHome(), worktreeRoot: { 'dsh-core': REPOS['dsh-core'].dir } });
  try {
    const vs = ensureLocalVersionFile({ home: dshHome(), dshRoot: DSH_ROOT });
    if (vs.created) ok(`自举：已建立本机 handoff-version.json（self=${vs.data.self}）`);
  } catch (e) {
    warn(`本机版本文件读写失败：${String(e?.message ?? e).slice(0, 120)}`);
  }
  record.handoffVersion = gate.self ?? HANDOFF_TOOL_VERSION;
  record.minSupported = gate.minSupported ?? null;
  record.versionGate = {
    decision: gate.decision, reason: String(gate.reason).slice(0, 320), verdict: null,
    needHumanConfirm: false, peerHost: null, diffs: [],
  };
  if (gate.decision === 'reject') {
    bad(`版本门 fail-closed：${gate.reason}`);
    record.alerts.push({ level: 'alert', code: 'version-gate', message: `版本门拒绝执行：${gate.reason}` });
    if (!o.dryRun) {
      record.repos = [{ name: 'dsh-core', localHead: null, remoteHead: null, behind: null, ahead: null, pushed: false, sizeBytes: null }];
      record.result = 'failed';
      record.deferred = [`版本门拒绝：${gate.reason}`];
      record.applied = prevRec?.applied ?? [];
      record.finishedAt = new Date().toISOString();
      try { writeLocalRecord(record); } catch { /* 校验错误已抛 */ }
      appendAudit({ type: 'handoff', role: 'depart', host, result: 'failed', code: 'version-gate', reason: gate.reason });
      OUT.json = { role: 'depart', result: 'failed', reason: 'version-gate' };
      return 2;
    }
  } else if (gate.minSupported) {
    ok(`版本门放行：${gate.reason}`);
  } else {
    log(`    版本门：不设硬门（仓内未声明 minSupported；本机 self=${gate.self ?? '∅'}）`);
  }
  if (!prevRec) {
    warn('本机尚无交接单 → 本次 Depart 建立 T3 对偶门基线');
  } else {
    log(`    上次交接：role=${prevRec.role} result=${prevRec.result} finishedAt=${prevRec.finishedAt ?? '(未完成)'}`);
    if (prevRec.result === 'failed' && !o.force && !o.dryRun) {
      bad('上次交接 result=failed；确认可继续请加 --force');
      record.result = 'failed';
      record.alerts.push({ level: 'alert', code: 'prev-failed', message: '上次交接失败未确认，已中止本次 Depart' });
      record.finishedAt = new Date().toISOString();
      try { writeLocalRecord(record); } catch { /* 已在校验处报错 */ }
      return 2;
    }
  }

  // ① fetch
  section('Depart · ① git fetch 三仓');
  const fetched = {};
  for (const name of repoOrder(o)) {
    const dir = REPOS[name].dir;
    if (!fs.existsSync(path.join(dir, '.git'))) { warn(`${name}: 工作副本不存在，跳过`); fetched[name] = false; continue; }
    const r = git(dir, ['fetch', 'origin'], { timeout: BUDGET.fetchMs });
    fetched[name] = r.ok;
    if (r.ok) ok(`${name}: fetched`);
    else warn(`${name}: fetch 失败${r.timedOut ? '（超时）' : ''} → deferred，不阻断（§5.1 fail-open）`);
  }

  // ② 超集体检（fail-closed）
  section('Depart · ② 推前超集体检（远端 HEAD vs 本机生产文件）');
  const blockers = [];
  const volumes = [];
  const repoRows = [];
  const supersetReports = new Map(); // 供「本机积压未推」形态诊断（改动点 B）
  for (const name of repoOrder(o)) {
    const dir = REPOS[name].dir;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      repoRows.push({ name, localHead: null, remoteHead: null, behind: null, ahead: null, pushed: false, sizeBytes: null });
      volumes.push({ repo: name, sizeBytes: 0, files: 0, thresholdBytes: VOLUME_THRESHOLDS[name] ?? null, overThreshold: false });
      continue;
    }
    const h = repoHeads(dir);
    const vol = core.measureRepoVolume(dir);
    // 体积判定（2026-09-16 拷问 P1 修）：口径改为 `.git`（与 Gitee 1024MB 配额同量纲），
    // 工作树只作参考；两层判据（绝对阈值 + 配额余量比）见 lib/repo-volume-thresholds.mjs。
    const gv = measureGitVolume(dir);
    const vj = judgeRepoVolume({ repo: name, gitBytes: gv.bytes, treeBytes: vol.sizeBytes });
    if (vj.level === 'red') record.alerts.push({ level: 'alert', code: 'volume-quota', message: `${name} ${vj.why}（§5.4 R6）` });
    else if (vj.level === 'yellow') record.alerts.push({ level: 'warn', code: 'volume-over', message: `${name} ${vj.why}（§5.4 R6）` });
    volumes.push({ repo: name, sizeBytes: vol.sizeBytes, gitBytes: gv.bytes, files: vol.files, thresholdBytes: vj.thresholdBytes, overThreshold: vj.overThreshold, quotaRatio: vj.quotaRatio, remainBytes: vj.remainBytes, level: vj.level });
    repoRows.push({ name, localHead: h.localHead, remoteHead: h.remoteHead, behind: h.behind, ahead: h.ahead, pushed: false, sizeBytes: vol.sizeBytes, gitBytes: gv.bytes });
    log(`    ${name.padEnd(14)} HEAD=${h.localHead ?? '?'} origin=${h.remoteHead ?? '?'} ahead=${h.ahead ?? '?'} behind=${h.behind ?? '?'} 体积=${fmtBytes(vol.sizeBytes)}（.git ${fmtBytes(gv.bytes)} / 配额 ${(vj.quotaRatio * 100).toFixed(1)}%）`);

    if (h.behind !== null && h.behind > 0) {
      blockers.push({ repo: name, code: 'remote-ahead', files: [], message: `${name}: 远端有 ${h.behind} 个本机没有的提交 → 先跑 --arrive 拉取分发，再 Depart` });
    }
    let report = null;
    try {
      report = checkRepo(name);
    } catch (e) {
      warn(`${name}: 超集体检执行失败（${e?.message ?? e}）`);
    }
    if (report?.error) warn(`${name}: 超集体检跳过（${report.error}）`);
    if (report && !report.error) supersetReports.set(name, report);
    // ⚠️ 判据自 2026-09-16 起为 **hasBlockingRisk**（= uniqueLines 里判不出「可回退」的那部分）：
    //    本机改了生产文件还没 -Sync 时，仓里那份就是本机**已提交且已推送**的旧版本 ⇒ git 能找回，
    //    不该挡住整轮 Depart（实测 2026-09-16 被 7 项假阳性挡了一整轮）。真正会永久丢的只有
    //    「未提交的工作副本改动」与「未推送的本地提交」——那两类照旧 fail-closed。
    if (report && hasBlockingRisk(report)) {
      const files = (report.blockingLines ?? report.uniqueLines).map((u) => u.rel);
      blockers.push({ repo: name, code: 'repo-superset', files, message: `${name}: ${files.length} 个文件存在「仓里有、生产没有」且**无法从 git 找回**的真内容独有行 → 采集会覆盖丢内容` });
      for (const f of files.slice(0, 10)) warn(`       · ${f}`);
      if (files.length > 10) warn(`       ...共 ${files.length} 个文件`);
      const recInBlockedRepo = report.recoverableLines?.length ?? 0;
      if (recInBlockedRepo) log(`        （同仓另有 ${recInBlockedRepo} 项属「♻ 可回退旧版」，不在本次阻断范围）`);
    } else if (report) {
      const forked = (report.forkedLines?.length ?? 0) + (report.forkedBinary?.length ?? 0);
      if (forked) warn(`${name}: ${forked} 项「分叉类」单机状态文件（覆盖同样会丢仓方独有行，需人工知情）`);
      const rewritten = report.rewriteLines?.length ?? 0;
      if (rewritten) warn(`${name}: ${rewritten} 项「疑似改写」（两侧都有独有行但归一化后高度重合，疑为本机改写版本；不挡推）`);
      const rec = report.recoverableLines ?? [];
      if (rec.length) {
        const recLines = rec.reduce((a, u) => a + (u.n ?? 0), 0);
        ok(`${name}: 无**不可回退**的真内容独有行（${rec.length} 项 / ${recLines} 行属「本机已提交且已推送的旧版本」→ 采集覆盖后 git 可找回，不阻断 Depart）`);
        for (const u of rec.slice(0, 8)) log(`       ♻ ${u.rel}  (${u.n} 行 / 本机独有 ${u.localN} 行)`);
        if (rec.length > 8) log(`       ...共 ${rec.length} 项`);
        record.alerts.push({ level: 'info', code: 'superset-recoverable', message: `${name}: ${rec.length} 项仓侧独有行属「可回退旧版」（已提交且已推送，git 可找回），未阻断本次 Depart` });
      } else {
        ok(`${name}: 无真内容独有行`);
      }
    }
  }
  record.volumes = volumes;

  if (blockers.length && !o.forceCollect) {
    section('Depart · 中止（fail-closed）');
    for (const b of blockers) {
      bad(b.message);
      record.alerts.push({ level: 'alert', code: b.code, message: b.message });
    }
    // 形态诊断（2026-09-12 卡「超集门判定器改进」· 改动点 B）：
    //   blocker 全为「本机独有行 ≫ 仓独有行（≥3×）」或「仓独有行全部落在「疑似改写」降级栏」形态时，
    //   差异方向几乎必然是「本机新版 vs 仓内旧快照」（本机积压没推）⇒ 正确出口是**先 -Sync 归零**再正常 Depart；
    //   直接 --force-collect 是「人工声明仓内容可弃」的逃生舱，会写强推审计流水（本场合不该留这种痕迹）。
    const supersetBlockers = blockers.filter((b) => b.code === 'repo-superset');
    // 口径：**跨仓汇总**判定形态（不是逐仓 every）——实测 2026-09-12 22:0x 本机状态：
    //   dsh-workspace 本机独有 297 / 仓独有 77 = 3.86×（积压形态），但 dsh-core 是 2 vs 2 = 1.0×
    //   （persona 只改了两行）⇒ 逐仓 every 会被这个小差异一票否决、整体提示退回旧文案。
    //   汇总后 299/79 = 3.78× ≥ 3× ⇒ 命中（形态本来就该整体看）。
    // 有 remote-ahead（远端有本机没有的提交）时不判积压：那种情形要先 --arrive 拉取分发，出口不同。
    const hasRemoteAhead = blockers.some((b) => b.code === 'remote-ahead');
    const shapeReports = [...supersetReports.values()];
    const agg = shapeReports.reduce((a, r) => ({
      repoOnlyLines: a.repoOnlyLines + (r.repoOnlyLines ?? 0),
      localOnlyLines: a.localOnlyLines + (r.localOnlyLines ?? 0),
      rewriteLines: a.rewriteLines.concat(r.rewriteLines ?? []),
      uniqueLines: a.uniqueLines.concat(r.uniqueLines ?? []),
    }), { repoOnlyLines: 0, localOnlyLines: 0, rewriteLines: [], uniqueLines: [] });
    const backlogShape = !hasRemoteAhead && blockers.length > 0 && shapeReports.length > 0 && isLocalBacklog(agg);
    if (backlogShape) {
      log(`    形态诊断：**疑似「本机积压未推」**（跨仓汇总：本机独有 ${agg.localOnlyLines} 行 / 仓独有 ${agg.repoOnlyLines} 行`
        + `，或仓独有行全部落在「疑似改写」降级栏）`);
      log('      → 推荐先跑采集把工作副本归零，再正常 Depart（走正常路径，不留强推审计）：');
      for (const b of supersetBlockers) log(`        · ${b.repo}: ${path.basename(REPOS[b.repo].script)} -Sync`);
      log('      → 跑完复检（期望「不可回退的真内容独有行=0」）：node tools/check-repo-superset.mjs ' + supersetBlockers.map((b) => b.repo).join(' ') + ' --blocking-only');
      log('      → ⚠️ 不要直接用 --force-collect：那是「人工声明仓内容可弃」的逃生舱，会留强推审计流水；');
      log('        仅在 -Sync 因故不可用时才用它作次选（附 --force-reason 说明）。');
    } else {
      log('    人工裁决入口：逐项核对差异方向（生产是否确为超集），确认无内容可弃后加 --force-collect');
    }
    log('      · 差异方向诊断：node tools/check-repo-superset.mjs <repo> --json');
    record.repos = repoRows;
    record.result = 'failed';
    record.deferred = blockers.map((b) => b.message);
    // ⚠️ 失败分支也必须**保留上一次的 T3 基线**：否则一次被挡推的 Depart 会让基线清空，
    //    下次 Arrive 全部退化成 skipped(unrecorded)（2026-09-11 验收构造实测发现）。
    record.applied = prevRec?.applied ?? [];
    record.finishedAt = new Date().toISOString();
    if (!o.dryRun) {
      try { writeLocalRecord(record); ok('已写交接单（result=failed，未采集、未推送、远端未被改动）'); } catch (e) { bad(String(e?.message ?? e)); }
      appendAudit({ type: 'handoff', role: 'depart', host, result: 'failed', blockers: blockers.map((b) => b.code) });
    } else {
      warn('dry-run：不写交接单、不采集、不推送');
    }
    OUT.json = { role: 'depart', result: 'failed', blockers, repos: repoRows, dryRun: !!o.dryRun };
    return 1;
  }

  if (blockers.length && o.forceCollect) {
    section('Depart · ②b 人工裁决：绕过超集体检（--force-collect，会写审计流水）');
    for (const b of blockers) {
      warn(`${b.repo}: ${b.code} —— 人工裁决绕过（${o.forceReason || '未填理由'}）`);
      record.alerts.push({ level: 'warn', code: 'forced-collect', message: `${b.repo}: 超集体检经人工裁决绕过（--force-collect，已记审计）` });
    }
    // R-067：统一绕过台账（一条记录含全部被绕过的仓）。dry-run 不记 —— 演练不是绕过。
    if (!o.dryRun) {
      recordBypass({
        gate: 'force-collect',
        reason: o.forceReason || '(未填理由)',
        actor: 'handoff.mjs',
        target: blockers.map((b) => b.repo).slice(0, 8).join(' ; '),
        detail: { repos: blockers.map((b) => b.repo), codes: blockers.map((b) => b.code) },
      });
    }
  }

  // ②d 附件导出（`--attach-export <dir>`；卡 AT1 缺口 C4 · 2026-10-10 补齐）
  //   为什么：图片附件实体 `<home>/attachments/v1/objects/<2>/<sha256>` **不进任何仓**
  //     （仓1 白名单排除 attachments、仓2 只搬 sessions/**）⇒ 换机时附件不会自己跟过去，
  //     而对端的含图会话缺实体时续聊必报 TRANSPORT。取回侧（Arrive A7b `--attach-fetch-from`）
  //     早已接好，**导出侧**此前只有提示文本、没有人接线 —— 本段补的就是这一半。
  //   做法：把「本机会话引用的全部附件对象」导出成中转包（`<dir>/objects/<2>/<sha>` + `manifest.json`，
  //     语义全在 `tools/attachments-fetch.mjs --export`，不另造一套）；插到对端后即
  //     `--arrive --attach-fetch-from <该目录>`（或 `attachments-fetch.mjs --relay <该目录>`）取回。
  //   默认关：不传 `--attach-export` 就完全不走这一段。失败一律 deferred（不阻断关机）。
  //   ⚠️ 位置刻意在 `if (o.dryRun)` **之前**：下面那个 dry-run 块会 `return 0`（不采集/不推送），
  //     放它后面等于 dry-run 永远测不到这一段；dry-run 时透传工具的 `--dry-run` ⇒ 只统计、**零写盘**。
  if (o.attachExport) {
    section(`Depart · ②d 附件导出（--attach-export${o.dryRun ? ' · DRY-RUN' : ''}）`);
    const res = runAttachExport(o.attachExport, { dryRun: o.dryRun });
    if (res.reason) {
      warn(`附件导出不可用：${res.reason}（不阻断 Depart）`);
      record.alerts.push({ level: 'warn', code: 'attach-export-failed', message: `附件导出失败：${res.reason}`.slice(0, 300) });
      record.deferred.push(`附件导出：${res.reason}`.slice(0, 200));
    } else {
      const s = res.summary ?? {};
      const outDir = s.exportDir ?? o.attachExport;
      log(`    导出 ${s.copied ?? '?'} 个对象 → ${outDir}${s.dryRun ? '（dry-run，未写盘）' : ''}；本机也没有的 ${s.absent ?? '?'} 个`);
      if (s.dryRun) log('    （dry-run：只统计不写盘；真跑会写 objects/<2>/<sha> + manifest.json）');
      else ok(`附件中转包已出：${outDir}　对端取回：node handoff.mjs --arrive --attach-fetch-from "${outDir}"`);
      if (!res.ok && res.code === 3) {
        warn('导出器退出码 3（有对象在源侧缺失）→ 包已出，但缺的那部分对端同样取不回');
        record.deferred.push('附件导出：工具 rc=3（部分对象本机缺失）');
      }
      if (Number(s.absent ?? 0) > 0) {
        record.alerts.push({ level: 'warn', code: 'attach-export-absent', message: `附件导出：${s.absent} 个被引用对象本机也没有（对端同样无源可取，口径同 A7 差额报告）`.slice(0, 300) });
      }
    }
  }

  if (o.dryRun) {
    section('Depart · DRY-RUN 计划（不采集、不推送、不写交接单）');
    for (const name of repoOrder(o)) {
      log(`    ${name}: 将跑 ${path.basename(REPOS[name].script)} -Sync -BackupOnly 然后 -Push`);
    }
    const rows = collectBaselineRows(cfg);
    log(`    交接基线将记录 ${rows.length} 个文件（清单 enabled 条目展开）`);
    record.repos = repoRows;
    OUT.json = { role: 'depart', result: 'dry-run', repos: repoRows, volumes, baselineFiles: rows.length, plan: repoOrder(o) };
    return 0;
  }

  // ②c 看板快照导出（P9 H3 · 2026-09-15 换机实测缺口③）
  //   为什么必须在 ③ 采集**之前**：快照落 `<数据区>/tools/board-snapshots/`（在仓3 里），
  //     只有先出包、随后由 ③ 的采集一起带走，对端 board-merge 才有得并回。
  //   为什么在 DSH 运行中也安全：导出器是**纯只读**（读账本文件 + 写快照文件），不碰 Host、不改账本。
  //   失败一律降级 deferred（不阻断关机 / Depart）。
  section('Depart · ②c 看板快照导出（board-snapshot-export → 随仓3 过河）');
  // 导出器退出码契约（见 board-snapshot-export.mjs 头部，改那边必须同步改这里）：
  //   0 = 干净出包 / 3 = **体检命中但已出包**（待人工核验）/ 1 = 真失败（快照没出）
  const SNAP_EXIT_SENSITIVE = 3;
  if (o.skipBoardSnapshot) {
    log('    跳过（--skip-board-snapshot）');
  } else {
    const exporter = path.join(DSH_ROOT, 'tools', 'board-snapshot-export.mjs');
    if (!fs.existsSync(exporter)) {
      warn(`导出器不存在：${exporter} → 跳过（快照通道不可用）`);
      record.alerts.push({ level: 'warn', code: 'board-snapshot-missing', message: 'board-snapshot-export.mjs 不存在，本次未导出看板快照' });
    } else {
      const r = spawnSync(process.execPath, [exporter, '--label', 'depart', '--json'], {
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
        // ⚠️ 必须把本进程的 DSH_ROOT 传下去：导出器的落点 = `$DSH_ROOT/tools/board-snapshots`，
        //    不传的话隔离沙盒（BUTLER_HANDOFF_ROOT）里跑的交接会把快照写进**真实生产目录**
        //    （2026-09-16 单测实测踩到：沙盒跑的 Depart 在生产 board-snapshots/ 里留了一份假账本快照）。
        env: { ...process.env, DSH_ROOT },
      });
      // stdout 解析：导出器 --json 输出**单行 compact JSON**；从后往前找首个可解析行（兼容历史多行输出）
      const lines = String(r.stdout ?? '').trim().split('\n').map((s) => s.trim()).filter(Boolean);
      let info = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { info = JSON.parse(lines[i]); break; } catch { /* 不是 JSON 行，继续往前找 */ }
      }
      const hits = Array.isArray(info?.sensitiveHits) ? info.sensitiveHits : [];
      const sample = hits.slice(0, 3).map((h) => `${h.label}→${h.sample}`).join('；');
      const snapName = info?.outPath ? path.basename(String(info.outPath)) : '(摘要未含路径)';
      // 三态分流（双判据：退出码或摘要任一说命中 → 一律按「待人工核验」；
      //   红线：体检命中绝不静默放行、也绝不当"导出失败"——它其实已经出包了）
      if (r.status === SNAP_EXIT_SENSITIVE || hits.length) {
        warn(`快照已出：${snapName} —— 但敏感串体检命中 ${hits.length || '?'} 处 → deferred（待人工核验，过仓前请核验）`);
        if (sample) log(`       命中样例：${sample}`);
        record.deferred.push(`board-snapshot-export 体检命中 ${hits.length || '?'} 处（快照已出：${snapName}）→ 待人工核验`);
        record.alerts.push({ level: 'warn', code: 'board-snapshot-sensitive', message: `看板快照敏感串体检命中 ${hits.length || '?'} 处（快照已出：${snapName}），待人工核验；命中样例：${sample || '（摘要未含样例）'}` });
      } else if (r.status === 0 && info) {
        ok(`快照已出：${snapName}（卡 ${info.taskCount} / revision ${info.revision}）`);
      } else if (r.status === 0 && !info) {
        // 退出码说成功、摘要却不可解析 → 无法核对体检结果：保守按「待人工核验」，绝不静默放行
        warn(`快照已出但摘要不可解析（无法核对敏感串体检；stdout ${lines.length} 行）→ deferred（待人工核验）`);
        record.deferred.push('board-snapshot-export 摘要不可解析（无法核对体检结果）→ 待人工核验');
        record.alerts.push({ level: 'warn', code: 'board-snapshot-unverified', message: '看板快照导出摘要不可解析（stdout 尾行非单行 JSON），无法核对敏感串体检 → 待人工核验' });
        if (r.stderr) log(`       ${String(r.stderr).split('\n').slice(-3).join(' | ').slice(0, 240)}`);
      } else {
        warn(`导出真失败（rc=${r.status}${r.error ? ` ${r.error.message}` : ''}）→ deferred`);
        record.deferred.push(`board-snapshot-export 真失败 rc=${r.status}`);
        record.alerts.push({ level: 'warn', code: 'board-snapshot-failed', message: `看板快照导出真失败 rc=${r.status}（快照未出，deferred，不阻断）` });
        if (r.stderr) log(`       ${String(r.stderr).split('\n').slice(-3).join(' | ').slice(0, 240)}`);
      }
    }
  }

  // ③ 采集（禁镜像：-Sync -BackupOnly 走各脚本的 /E 语义，不 pull 不 merge）
  section('Depart · ③ 采集（-Sync -BackupOnly，禁镜像语义）');
  const collected = {};
  for (const name of repoOrder(o)) {
    // 【2026-10-14 · R5 §8-R6】采集前后各取一次 HEAD（只读）⇒ 失败时能**自动**判「空转（活干完了）」
    //   还是「真没干完」；2026-10-14 那次就是两者事后无从区分，才要绕台账 mtime + reflog + fsck 人工反推。
    const headBefore = repoHead(REPOS[name].dir);
    const r = ps1(REPOS[name].script, ['-Sync', '-BackupOnly'], { timeout: BUDGET.collectMs, tag: `collect-${name}` });
    collected[name] = r.ok;
    if (r.ok) ok(`${name}: 采集 + 提交完成`);
    else {
      const verdict = classifyCollectFailure({ timedOut: r.timedOut, headBefore, headAfter: repoHead(REPOS[name].dir) });
      const vTxt = describeVerdict(verdict);
      warn(`${name}: 采集失败（rc=${r.code}${r.timedOut ? ' 超时' : ''}）→ deferred ${vTxt}`);
      record.deferred.push(`${name}: 采集失败 ${r.timedOut ? '(timeout)' : `rc=${r.code}`} [${verdict}]`);
      record.alerts.push({ level: 'warn', code: 'collect-failed', message: `${name}: 采集失败（deferred，不阻断）${vTxt}` });
      if (verdict === COLLECT_VERDICT.TIMEOUT_BUT_DONE) {
        // 空转形态：提交已产生，但被杀的脚本后续步骤（pull / 收尾）确实没跑 ⇒ 仍按 deferred 处理，
        // 只是单独 alert 一条，好让下次一眼分辨「白等」与「真慢」。
        record.alerts.push({ level: 'warn', code: 'collect-timeout-but-done', message: `${name}: 采集超时但该仓提交已产生（空转形态/M-2）——产物已落仓，本次仍按 deferred 处置` });
      }
      if (r.err) log(`       ${r.err.split('\n').slice(-3).join(' | ').slice(0, 240)}`);
    }
  }

  // ④ push
  section('Depart · ④ push');
  const pushed = {};
  for (const name of repoOrder(o)) {
    if (!collected[name]) { warn(`${name}: 跳过 push（采集未成功）`); continue; }
    const blk = blockers.find((b) => b.repo === name);
    const r = pushRepo(name, { force: !!(o.forceCollect && blk), reason: o.forceReason, risky: blk?.files ?? [] });
    pushed[name] = r.ok;
    if (r.ok) ok(`${name}: pushed`);
    else {
      warn(`${name}: push 失败（rc=${r.code}）→ deferred（§5.2 失败不阻断关机）`);
      record.deferred.push(`${name}: push 失败 rc=${r.code}`);
      record.alerts.push({ level: 'warn', code: 'push-failed', message: `${name}: push 失败（deferred）` });
      if (r.err) log(`       ${r.err.split('\n').slice(-3).join(' | ').slice(0, 240)}`);
    }
  }

  // ⑤ 推后复核
  section('Depart · ⑤ 推后复核（远端 == 本机）');
  for (const row of repoRows) {
    const dir = REPOS[row.name].dir;
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const h = repoHeads(dir);
    row.localHead = h.localHead;
    row.remoteHead = h.remoteHead;
    row.ahead = h.ahead;
    row.behind = h.behind;
    row.pushed = pushed[row.name] === true;
    const same = h.localHead && h.remoteHead && h.localHead === h.remoteHead;
    if (row.pushed) (same ? ok : warn)(`${row.name}: HEAD=${h.localHead} vs origin=${h.remoteHead}${same ? '' : ' ← 不一致（deferred）'}`);
    if (row.pushed && !same) {
      record.alerts.push({ level: 'warn', code: 'post-push-mismatch', message: `${row.name}: 推后复核 HEAD != origin/master` });
      record.deferred.push(`${row.name}: 推后复核不一致`);
    }
  }
  record.repos = repoRows;

  // ⑥ 交接单（本机 + 仓内副本）
  section('Depart · ⑥ 写交接单');
  const baselineRows = collectBaselineRows(cfg);
  record.applied = baselineRows;
  record.finishedAt = new Date().toISOString();
  fillHotAndClock(record);
  const anyPushed = Object.values(pushed).some(Boolean);
  const allOk = repoOrder(o).every((n) => pushed[n] === true);
  record.result = allOk ? 'ok' : 'deferred';
  if (anyPushed) record.lastHeartbeatAt = record.finishedAt;              // §5.3：任一成功 push 更新
  if (record.result === 'ok') record.lastSuccessfulHandoffAt = record.finishedAt;  // 仅完整交接结束更新
  record.alerts.push({ level: 'info', code: 'depart-summary', message: `基线文件 ${baselineRows.length} 项；result=${record.result}` });

  let copy = { ok: false };
  try {
    writeLocalRecord(record);
    ok(`本机交接单已写：${path.basename(HANDOFF_FILE)}（基线 ${baselineRows.length} 项）`);
    copy = stageRepoCopy(record);
    if (copy.ok) ok(`仓内副本已提交：${core.HANDOFF_REPO_SUBDIR}/${host}.json${copy.committed ? '' : '（无变化）'}`);
    else warn('仓内副本提交失败');
    if (copy.ok && copy.committed) {
      const p = git(REPOS['dsh-core'].dir, ['push', 'origin', 'master'], { timeout: BUDGET.pushMs });
      if (p.ok) ok('仓内副本已推送（origin/master）');
      else {
        warn('仓内副本推送失败 → deferred');
        record.deferred.push('dsh-core: 交接单副本推送失败');
        record.lastHeartbeatAt = prevRec?.lastHeartbeatAt ?? null;
        record.result = 'deferred';
        writeLocalRecord(record);
      }
    }
  } catch (e) {
    bad(`交接单写入失败：${e?.message ?? e}`);
    return 1;
  }

  appendAudit({ type: 'handoff', role: 'depart', host, result: record.result, baselineFiles: baselineRows.length, pushed: Object.entries(pushed) });
  logGcResult(gcArchives({ dryRun: o.dryRun }));

  section(`Depart 完成：result=${record.result}`);
  log(`    心跳 lastHeartbeatAt=${record.lastHeartbeatAt ?? '(未更新)'}`);
  log(`    完整交接 lastSuccessfulHandoffAt=${record.lastSuccessfulHandoffAt ?? '(未更新)'}`);
  if (record.deferred.length) log(`    未完成项 ${record.deferred.length} 条：${record.deferred.join('；')}`);
  OUT.json = { role: 'depart', result: record.result, record, repos: repoRows, volumes, baselineFiles: baselineRows.length };
  return record.result === 'ok' ? 0 : 3;
}

/** Depart 基线 = 清单 enabled 条目对应的**本机生产文件**当前哈希（= 本次推给对端的版本）。 */
function collectBaselineRows(cfg) {
  const manifest = core.loadManifest();
  const expanded = core.expandManifest(manifest, cfg);
  const rows = [];
  for (const f of expanded.files) {
    const h = core.hashFile(f.dst);
    if (!h) continue;
    rows.push({ key: f.key, repoPath: f.repoPath, sha256: h.sha256, ok: true, status: 'collected', mode: 'depart-collect', bytes: h.bytes });
  }
  return rows;
}

// ---------------------------------------------------------------- A5 会话落地（2026-09-12）

/** 落地器 CLI（与 dsh-sync-all.ps1 -Pull 共用，单一权威入口）。 */
function sessionsLanderPath() {
  return path.join(DSH_ROOT, 'tools', 'dsh-sessions-land.mjs');
}

/**
 * 调落地器（spawn node），返回其 JSON 结果。
 * 一切异常都收敛成 { ok:false, reason }——A5 是补充接收，绝不阻断接机（fail-open）。
 */
function runSessionsLand(o) {
  const cli = sessionsLanderPath();
  if (!fs.existsSync(cli)) return { ok: false, reason: 'lander-missing' };
  const args = [cli, '--json'];
  // 隔离通道（测试/沙箱用；生产不设 env = 落地器走脚本默认路径）
  if (process.env.BUTLER_HANDOFF_SESSIONS_DIR) args.push('--sessions-dir', process.env.BUTLER_HANDOFF_SESSIONS_DIR);
  if (process.env.BUTLER_HANDOFF_ARCHIVE_DIR) args.push('--archive-dir', process.env.BUTLER_HANDOFF_ARCHIVE_DIR);
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync('node', args, { encoding: 'utf8', timeout: BUDGET.sessionMergeMs, windowsHide: true });
  } catch (e) {
    return { ok: false, reason: `lander-spawn-error:${String(e?.message ?? e).slice(0, 60)}` };
  }
  const out = String(r?.stdout ?? '');
  const idx = out.indexOf('---JSON---');
  let payload = null;
  if (idx >= 0) { try { payload = JSON.parse(out.slice(idx + 10)); } catch { payload = null; } }
  if (!payload) {
    const tail = `${out}\n${r?.stderr ?? ''}`.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 120);
    return { ok: false, reason: 'lander-json-unparsed', detail: tail, durationMs: Date.now() - t0 };
  }
  return { ...payload, durationMs: payload.durationMs ?? (Date.now() - t0) };
}

/**
 * 把落地器结果整形成交接单字段。**所有返回路径都必须走它**——schema 是
 * additionalProperties:false + required 白名单，缺字段会在 A7 写盘时 throw（整单落空）。
 */
function buildSessionField(res = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const reason = res.reason === null || res.reason === undefined ? null : String(res.reason).slice(0, 160);
  const head = res.repoHeadAfter ?? res.repoHead ?? null;
  return {
    ok: res.ok === true,
    reason,
    skipped: res.skipped === true,
    mergedCount: n(res.mergedCount),
    keptCount: n(res.keptCount),
    skippedArchivedCount: n(res.skippedArchivedCount),
    repoHead: head === null ? null : String(head).slice(0, 64),
    durationMs: n(res.durationMs),
  };
}

// ---------------------------------------------------------------- A5b 离线语义合并（H2 接线 · 2026-09-15）

/** A5b 单步合并结果的**固定形状**（schema 是 additionalProperties:false + required 白名单，必须字段齐全）。 */
function emptyMergeStep() {
  return {
    ok: false, skipped: false, reason: null, written: false,
    entries: null, sumCount: null, unionEntries: null, inserted: null, autoRenamed: null, durationMs: 0,
  };
}

/** 对端数据落点：仓1 工作副本（Depart 冷采写进去、本机 Arrive pull 拉到最新）。 */
function peerRepoFiles() {
  const root = REPOS['dsh-core'].dir;
  return {
    root,
    pitfalls: path.join(root, 'dsh', 'butler-pitfalls.json'),
    memoryDb: path.join(root, 'dsh', 'memory', 'memory.db'),
  };
}

/** 本机记忆库路径（与 merge-memory 的 localDbPath 同口径）。 */
function localMemoryDbPath() { return path.join(dshHome(), 'memory', 'memory.db'); }

/**
 * 合并器 CLI 目录。
 * 默认 = 数据区 `tools/dsh-butler`；**隔离测试**用 `DSH_HANDOFF_MERGE_CLI_DIR` 指向候选副本
 * （铁律：可注入的输出/依赖路径要显式做成参数或环境变量，别让测试去碰生产路径）。
 */
function mergeCliDir() {
  return process.env.DSH_HANDOFF_MERGE_CLI_DIR || path.join(DSH_ROOT, 'tools', 'dsh-butler');
}

/** 合并器 CLI 绝对路径。 */
function mergeCliPath(name) { return path.join(mergeCliDir(), name); }

// ---------------------------------------------------------------- 门⑥ 变更流水合并接线（B 组 · gap-1-55 · 2026-10-10）

/**
 * 接线闸文件（**默认关**）：`~/.dsh/butler-handoff-merge.json`
 *   `{"allowChangelog": true}` 才开；**缺文件 / 缺字段 / 脏值（非布尔）/ 解析失败 一律回退「关」**。
 *   ⇒ 默认态下门⑥ 只打一行日志，**不碰 record / 不跑子进程 = 零行为变化**。
 * 开闸入口：`node tools/dsh-butler/handoff-merge-cli.mjs on --apply`（默认 dry-run；`off --apply` 关回；`status` 只读）
 *           或手工把该文件写成 `{"allowChangelog":true}`。该文件**每次调用现读** ⇒ 改完不用重启 dsh/tickd。
 */
export const HANDOFF_MERGE_GATE_FILE = resolveStatePath('butler-handoff-merge.json', { home: dshHome() }).path;

export function readHandoffMergeGate(file = HANDOFF_MERGE_GATE_FILE) {
  const out = { allowChangelog: false, source: 'default', file, reason: null };
  try {
    if (!fs.existsSync(file)) { out.reason = '闸文件不存在'; return out; }
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.source = 'file';
    if (typeof j?.allowChangelog !== 'boolean') {
      out.reason = `allowChangelog 缺失或非布尔（${JSON.stringify(j?.allowChangelog) ?? 'undefined'}）`;
      return out;                       // fail-closed 到「关」
    }
    out.allowChangelog = j.allowChangelog === true;
    if (!out.allowChangelog) out.reason = 'allowChangelog=false';
    return out;
  } catch (e) {
    out.reason = `闸文件解析失败（${String(e?.message ?? e).slice(0, 100)}）`;
    return out;                         // 解析失败 = 关（绝不"读不了就当开"）
  }
}

/** 变更流水合并器 CLI（住在 `tools\` 根；测试用 `DSH_HANDOFF_CHANGELOG_CLI` 注入 stub）。 */
function changelogCliPath() {
  return process.env.DSH_HANDOFF_CHANGELOG_CLI || path.join(DSH_ROOT, 'tools', 'merge-changelog.mjs');
}

/**
 * 门⑥ 变更流水（文档条目）合并 —— §4.3「文档条目行」+ `tools\merge-changelog.mjs` 接线。
 *
 * 与坑库/记忆库**同款口径**：fail-open（失败只留痕，绝不阻断 Arrive）+ 留痕（record.alerts / deferred）+ 归档（mergeArchive）。
 * 与另两条链的**差异（有意为之，不是漏）**：
 *   · **不进 `record.merge`**：`handoff-record.schema.json#merge` 是 `additionalProperties:false`，
 *     塞 `changelog` 子字段会让 A7 写盘整单 throw（同 `buildMergeField` 注释里那条教训）⇒ 本轮只走 alerts/deferred。
 *   · **不加单写者护栏**：坑库抢 P4 tick 锁、记忆库要停机窗口；变更流水靠 `merge-changelog.mjs` 自己抢
 *     **与 `changelog-add.mjs` 同一把 RMW 锁**（`lib/store.mjs#acquireRmwLock`，按目标 basename 命名）
 *     ⇒ 并发 append 不会丢更新，**不需要**"DSH 停着"这种启发式。
 *
 * @returns {{status:'off'|'skipped'|'applied'|'nochange'|'failed', reason:string|null, durationMs:number, payload:object|null}}
 */
export function runChangelogStep({
  pulled, record, mergeArchive, stepBudgetLeft, timeoutMs,
  gateFile = HANDOFF_MERGE_GATE_FILE, logFn = log, warnFn = warn,
} = {}) {
  const t0 = Date.now();
  const step = { status: 'off', reason: null, durationMs: 0, payload: null };
  const gate = readHandoffMergeGate(gateFile);
  if (!gate.allowChangelog) {
    step.reason = `闸关（${path.basename(gateFile)}#allowChangelog≠true；${gate.reason ?? '默认'}）`;
    logFn(`    门⑥ 变更流水合并：闸关（默认）→ 跳过（零行为变化；开闸见 tools\\dsh-butler\\handoff-merge-cli.mjs）`);
    step.durationMs = Date.now() - t0;
    return step;                          // 闸关 ⇒ 不碰 record、不跑子进程
  }
  /** 开闸后的跳过（可见、fail-open、不阻断）——这是唯一会写 record 的跳过形态。 */
  const skip = (reason) => {
    step.status = 'skipped'; step.reason = String(reason).slice(0, 240);
    warnFn(`变更流水合并跳过：${step.reason}`);
    record.alerts.push({ level: 'info', code: 'merge-changelog-skipped', message: `变更流水合并跳过：${step.reason}`.slice(0, 300) });
    record.deferred.push(`变更流水合并：跳过（${step.reason.slice(0, 100)}）`);
    step.durationMs = Date.now() - t0;
    return step;
  };

  if (pulled?.['dsh-workspace'] !== true) return skip('dsh-workspace（仓3）pull 未成功 → 对端流水可能不是最新');
  if (typeof stepBudgetLeft === 'function' && stepBudgetLeft() <= 5_000) return skip('A5b 段预算已耗尽');

  const peerRoot = REPOS['dsh-workspace'].dir;
  const month = new Date().toISOString().slice(0, 7);
  const peerFile = path.join(peerRoot, 'docs', '变更流水', `${month}.md`);
  if (!fs.existsSync(peerFile)) return skip(`对端当月流水不存在（${peerFile}）`);

  logFn(`    门⑥ 变更流水合并：闸开 → 对端 ${peerFile}`);
  const r = runMergeCli('merge-changelog.mjs',
    ['--json', '--apply', '--from', peerRoot, '--month', month, '--archive-dir', mergeArchive('changelog')],
    { timeoutMs, cli: changelogCliPath() });
  step.payload = r.payload ?? null;
  step.durationMs = Date.now() - t0;
  const reason = String(step.payload?.reason ?? r.reason ?? `exit ${r.code ?? '?'}`).slice(0, 200);

  if (r.ok && step.payload?.written === true) {
    step.status = 'applied';
    const st = step.payload.stats ?? {};
    record.alerts.push({ level: 'info', code: 'merge-changelog-applied', message: `变更流水已并入：对端独有 ${st.onlyRemote ?? '?'} 条 / 本机独有 ${st.onlyLocal ?? '?'} 条保留（备份 ${path.basename(String(step.payload.archiveDir ?? '-'))}）`.slice(0, 300) });
    return step;
  }
  if (r.ok) {
    step.status = 'nochange'; step.reason = '两侧一致（无需合并）';
    record.alerts.push({ level: 'info', code: 'merge-changelog-nochange', message: '变更流水：两侧一致，无需合并（未写盘）' });
    return step;
  }
  if (/lock-busy|LOCK_CONTENTION/.test(reason) || /lock-busy/.test(String(r.reason ?? ''))) {
    return skip(`RMW 锁被占（changelog-add 正在写，稍后重跑）· ${reason}`);
  }
  step.status = 'failed'; step.reason = reason;
  warnFn(`变更流水合并失败（fail-open，不阻断交接）：${reason}`);
  record.alerts.push({ level: 'warn', code: 'merge-changelog-failed', message: `变更流水合并失败（fail-open）：${reason}`.slice(0, 300) });
  record.deferred.push(`变更流水合并：失败（${reason.slice(0, 100)}）`);
  return step;
}

/** 整数字段容错（非数字 → null）。 */
function intOrNull(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }

/**
 * 门③ 解密自检（§4.3）：仓1 副本必须是**明文**。
 * git-crypt 未解锁时坑库是二进制密文（JSON.parse 必失败）、记忆库不是 SQLite 魔数 ⇒
 * 本门把它变成「整段跳过 + 告警」，绝不拿密文去 merge / 更不拿去写生产。
 */
function checkDecryptGate(peer) {
  const out = { ok: true, reasons: [], pitfalls: 'missing', memory: 'missing' };
  if (fs.existsSync(peer.pitfalls)) {
    let plain = false;
    try { JSON.parse(fs.readFileSync(peer.pitfalls, 'utf8')); plain = true; } catch { plain = false; }
    out.pitfalls = plain ? 'ok' : 'encrypted';
    if (!plain) { out.ok = false; out.reasons.push('坑库副本不是明文 JSON（git-crypt 未解锁？）'); }
  }
  if (fs.existsSync(peer.memoryDb)) {
    let sqlite = false;
    try {
      const fd = fs.openSync(peer.memoryDb, 'r');
      const buf = Buffer.alloc(SQLITE_MAGIC.length);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      sqlite = read === buf.length && buf.toString('latin1') === SQLITE_MAGIC;
    } catch { sqlite = false; }
    out.memory = sqlite ? 'ok' : 'encrypted';
    if (!sqlite) { out.ok = false; out.reasons.push('记忆库副本不是 SQLite（git-crypt 未解锁？）'); }
  }
  return out;
}

/**
 * 调合并器 CLI（`--json`：stdout 整体就是报告 JSON）。一切异常收敛成 `{ok:false, reason}`，
 * 绝不抛（A5b 是增益动作，不许把 Arrive 带崩）。
 */
function runMergeCli(name, args, { timeoutMs, cli: cliOverride = null }) {
  // 2026-10-10（B 组 · gap-1-55）：新增**可选** `cli` —— 变更流水合并器住在 `tools\merge-changelog.mjs`
  //   （不在 mergeCliDir = `tools\dsh-butler\`），必须能显式传路径；不传 ⇒ 行为与改造前逐字节一致。
  const cli = cliOverride || mergeCliPath(name);
  if (!fs.existsSync(cli)) return { ok: false, reason: `merge-cli-missing:${name}`, durationMs: 0 };
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync('node', [cli, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    return { ok: false, reason: `merge-spawn-error:${String(e?.message ?? e).slice(0, 80)}`, durationMs: Date.now() - t0 };
  }
  const durationMs = Date.now() - t0;
  const out = String(r?.stdout ?? '');
  const i = out.indexOf('{');
  let payload = null;
  if (i >= 0) { try { payload = JSON.parse(out.slice(i)); } catch { payload = null; } }
  if (!payload) {
    const tail = `${out}\n${r?.stderr ?? ''}`.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200);
    return { ok: false, code: r?.status ?? -1, reason: `merge-json-unparsed:${tail}`, timedOut: r?.error?.code === 'ETIMEDOUT', durationMs };
  }
  return {
    ok: r?.status === 0 && payload.ok !== false,
    code: r?.status ?? 0,
    payload,
    timedOut: r?.error?.code === 'ETIMEDOUT',
    durationMs,
  };
}

/** 坑库 CLI 报告 → `merge.pitfalls`（字段名取自 merge-pitfalls 的 stats）。 */
function pitfallStepFrom(r) {
  const step = emptyMergeStep();
  step.durationMs = Number(r?.durationMs ?? 0);
  step.ok = r?.ok === true;
  step.reason = step.ok ? null : String(r?.reason ?? `exit ${r?.code ?? '?'}`).slice(0, 200);
  const p = r?.payload?.objects?.pitfalls ?? null;
  step.written = r?.payload?.written === true;
  if (p) {
    const st = p.stats ?? {};
    step.entries = intOrNull(st.localN);
    step.unionEntries = intOrNull(st.union);
    step.sumCount = intOrNull(st.sumMerged);
    step.inserted = intOrNull(st.onlyRemote);
    if (p.skipped === true) { step.skipped = true; step.reason = String(p.reason ?? 'skipped').slice(0, 200); }
  }
  return step;
}

/** 记忆库 CLI 报告 → `merge.memory`。 */
function memoryStepFrom(r) {
  const step = emptyMergeStep();
  step.durationMs = Number(r?.durationMs ?? 0);
  step.ok = r?.ok === true;
  step.reason = step.ok ? null : String(r?.reason ?? `exit ${r?.code ?? '?'}`).slice(0, 200);
  const pl = r?.payload ?? null;
  step.written = pl?.written === true;
  if (pl) {
    const st = pl.stats ?? {};
    step.entries = intOrNull(pl.result?.rows) ?? intOrNull(pl.local?.rows);
    step.unionEntries = intOrNull(st.union);
    step.inserted = intOrNull(st.onlyRemote);
    step.autoRenamed = intOrNull(st.autoRenamed);
    if (pl.idempotency?.skipped === true) {
      step.skipped = true;
      step.reason = String(pl.idempotency.reason ?? 'skipped').slice(0, 200);
    }
  }
  return step;
}

/**
 * 运行时结果 → 交接单 `merge` 字段。
 * **所有返回路径都必须走它**：schema 是 additionalProperties:false + required 白名单，
 * 缺字段会在 A7 写盘时 throw（整单落空）——与 `buildSessionField` 同一条教训。
 */
export function buildMergeField(res = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const s = (v, max) => (v === null || v === undefined ? null : String(v).slice(0, max));
  const boolOrNull = (v) => (v === null || v === undefined ? null : v === true);
  const step = (r = {}) => ({
    ok: r.ok === true,
    skipped: r.skipped === true,
    reason: s(r.reason, 200),
    written: r.written === true,
    entries: n(r.entries),
    sumCount: n(r.sumCount),
    unionEntries: n(r.unionEntries),
    inserted: n(r.inserted),
    autoRenamed: n(r.autoRenamed),
    durationMs: n(r.durationMs) ?? 0,
  });
  return {
    enabled: res.enabled !== false,
    skipped: res.skipped === true,
    reason: s(res.reason, 300),
    clockOk: boolOrNull(res.clockOk),
    decryptOk: boolOrNull(res.decryptOk),
    writers: {
      held: res.writers?.held === true,
      active: res.writers?.active === true,
      reasons: s(res.writers?.reasons, 300),
      waitedMs: n(res.writers?.waitedMs) ?? 0,
    },
    pitfalls: step(res.pitfalls),
    memory: step(res.memory),
    durationMs: n(res.durationMs) ?? 0,
    budgetMs: n(res.budgetMs) ?? 0,
  };
}

/**
 * A5b 离线语义合并：坑库（含候选池）+ 记忆库（H2 语义合并器接线）。
 *
 * **位置铁律**（H2 两份文档 §7 第 1 条）：必须在 **A4 pull 成功之后** ——
 * 对端数据此刻才在仓1 工作副本里就位（Depart 冷采写进仓、本机 pull 拉到最新）。
 *
 * 门（顺序固定，任一不过 → 整段跳过并如实记录，**绝不半跑**）：
 *   ① 总开关 `DSH_HANDOFF_ENABLE=0`            → 整段不跑（H1b 已有的 kill switch）；
 *   ② `dsh-core` pull 未成功                    → 跳过（对端数据可能不是最新）；
 *   ③ **解密自检门**：仓1 副本必须明文           → 坑库须是可解析 JSON、记忆库须是 SQLite 魔数；
 *   ④ **时钟门**（§5.7 R3，2026-09-15 **A 档**）：优先用**权威时刻**（HTTP `Date`）判 |本机钟 − 权威| > 120s；
 *      取不到权威时刻 ⇒ 回退只挡**负向**偏差（本机钟落后/被回拨），正向大间隔只告警（热采刚提交是常态）；
 *      对端 `finishedAt` vs 提交时刻仍双向硬挡。判据全在 `lib/handoff-clock.mjs`（取不到 = null → 不判、放行）。
 *   ⑤ **单写者护栏**（§17.1 T2，本卡硬前置）：坑库合并前先抢 P4 tick 那把锁
 *      （`tick-p4-pitfall.lock`）——抢到 ⇒ tick 本轮被自己的锁拒掉（跳过，不排队），
 *      合并期间不可能有第二个写者；抢不到 ⇒ **拒合并 + 告警**。
 *      记忆库另有窗口判据（§4.3：只在 DSH 停止时执行 + WAL 必须为空）。
 *
 * 失败一律 **fail-open**（跳过 + alerts + deferred）：调度上 Arrive 是「接收」，
 * 合并只是增益动作，绝不因为它把接机整体挡掉（§5.1 fail-open/fail-closed 分档）。
 *
 * （导出仅为**隔离测试**与后续复用：`_test/test-arrive-merge.mjs` 直接调它覆盖
 *   「DSH 已停 → 记忆库可合并」这类生产现场造不出来的分支。）
 */
export function runOfflineMerge(o, { running, pulled, record, startedMs = null }) {
  const t0 = Date.now();
  // A5b 可用预算 = min(整段上限, Arrive 总预算 − 已用时长)：前面的 fetch/pull/会话落地吃掉多少，
  // 这里就实时扣多少（防止整段撞上钩子 330s 硬超时；§5.7）。
  const usedMs = Number.isFinite(startedMs) ? Math.max(0, t0 - startedMs) : 0;
  const budgetMs = Math.max(0, Math.min(BUDGET.mergeTotalMs, BUDGET.arriveTotalMs - usedMs));
  const res = {
    enabled: true, skipped: false, reason: null, clockOk: null, decryptOk: null,
    writers: { held: false, active: false, reasons: null, waitedMs: 0 },
    pitfalls: emptyMergeStep(), memory: emptyMergeStep(),
    durationMs: 0, budgetMs,
  };
  const done = () => { res.durationMs = Date.now() - t0; return res; };
  /** 整段跳过（带告警 + deferred 记账）。 */
  const skipAll = (reason, { level = 'warn', code = 'merge-skipped', audit = true } = {}) => {
    res.skipped = true;
    res.reason = String(reason).slice(0, 300);
    warn(`离线语义合并整段跳过：${res.reason}`);
    if (audit) record.alerts.push({ level, code, message: `离线语义合并跳过：${res.reason}`.slice(0, 300) });
    if (audit) record.deferred.push(`语义合并：跳过（${String(reason).slice(0, 100)}）`);
    return done();
  };

  // 门① 总开关
  if (String(process.env.DSH_HANDOFF_ENABLE ?? '') === '0') {
    res.enabled = false;
    log('    门① DSH_HANDOFF_ENABLE=0 → 整段不跑');
    return skipAll('DSH_HANDOFF_ENABLE=0（开关关闭）', { level: 'info', audit: false });
  }
  // 门② 仓1 pull
  if (pulled?.['dsh-core'] !== true) {
    return skipAll('dsh-core pull 未成功 → 对端数据可能不是最新（不做合并）');
  }
  // 门③ 解密自检
  const peer = peerRepoFiles();
  const dec = checkDecryptGate(peer);
  res.decryptOk = dec.ok;
  if (!dec.ok) {
    return skipAll(`解密自检门未过：${dec.reasons.join('；')}`, { level: 'alert', code: 'merge-decrypt-gate' });
  }
  if (dec.pitfalls === 'missing' && dec.memory === 'missing') {
    return skipAll('仓1 工作副本里既无坑库也无记忆库副本（对端未推过）', { level: 'info', audit: false });
  }
  // 门④ 时钟门（A 档，2026-09-15：优先用权威时刻；无权威时刻时只挡负向偏差；对端维持双向硬挡）
  const skew = computeClockSkew();
  res.clockOk = skew.ok === null || skew.ok === undefined ? null : skew.ok === true;
  if (skew.warnings?.length) for (const w of skew.warnings) warn(`时钟门告警（不挡）：${w}`);
  if (skew.ok === false) {
    const out = skipAll(`时钟门未过（${skew.reason}）→ 拒绝合并，先对时`, { level: 'alert', code: 'merge-clock-gate' });
    // ---- T6 降级路径（方案 §17.2 T6 · 2026-09-15 落地）---------------------------------
    //   问题原文：时钟门 fail-closed ⇒ 合并被永久拒绝、操作者只看到 🔴、交接功能**实际瘫痪**且静默。
    //   三条降级（全部在**不碰生产数据**的前提下）：
    //     ① **只读交接照常**：本函数 fail-open —— skipAll 只把"语义合并"整段记账后返回，
    //        Arrive 的 A6 分发 / A5 会话落地等**照常继续**（回归断言见 _test/test-arrive-merge.mjs）；
    //     ② **拒绝态可见**：alerts 记 `merge-clock-gate`（🔴）+ 本节新增 `merge-clock-resync`，
    //        由 lib/handoff-health.mjs 聚合成日报「📡 同步健康」段的行（不再"只写进 JSON 没人看"）；
    //     ③ **一次自动校时**：默认 **dry-run**（只探测"有没有管理员权限 / Time 服务在不在"，
    //        **绝不执行系统命令**）；`DSH_HANDOFF_RESYNC=1` 才真跑一次 `w32tm /resync`。
    //        任何结果（成功/无权限/服务未启动/失败）都**必须**落 alerts + 日志 —— 不许静默失败。
    try {
      const rs = runTimeResync({ apply: resyncEnabled(process.env), reason: skew.reason });
      record.alerts.push({
        level: rs.level === 'alert' ? 'alert' : (rs.level === 'warn' ? 'warn' : 'info'),
        code: 'merge-clock-resync',
        message: String(rs.message).slice(0, 300),
      });
      if (rs.hint) record.deferred.push(`自动校时：${String(rs.hint).slice(0, 120)}`);
      log(`    T6 降级：${rs.message}`);
      log(`    只读交接照常（本次仅"语义合并"整段跳过）· 自动校时：${rs.command} · ${rs.dryRun ? 'dry-run（未执行）' : (rs.attempted ? `已执行 exit=${rs.exitCode}` : '未执行')}`);
    } catch (e) {
      record.alerts.push({ level: 'warn', code: 'merge-clock-resync', message: `自动校时模块异常（已吞，不阻断交接）：${String(e?.message ?? e).slice(0, 200)}` });
    }
    return out;
  }

  // 门⑤-a 坑库：单写者护栏（抢 P4 tick 的锁）
  const mergeTs = tsStamp();
  const mergeArchive = (obj) => path.join(ARCHIVE_ROOT, `handoff-merge-${mergeTs}`, obj);
  const stepBudgetLeft = () => budgetMs - (Date.now() - t0);
  if (stepBudgetLeft() <= 5_000) {
    return skipAll('A5b 段预算已耗尽（跳过余下合并）');
  }
  const guard = acquirePitfallGuard({ home: dshHome() });
  res.writers = {
    held: guard.ok === true,
    active: guard.probe?.active === true,
    reasons: guard.probe?.reasons?.length ? guard.probe.reasons.join('；').slice(0, 300) : null,
    waitedMs: Number(guard.waitedMs ?? 0),
  };
  if (!guard.ok) {
    res.pitfalls = { ...emptyMergeStep(), skipped: true, reason: guard.reason.slice(0, 200) };
    bad(`单写者护栏：抢不到 P4 tick 锁 → 本次不做坑库合并（${guard.reason.slice(0, 120)}）`);
    record.alerts.push({ level: 'warn', code: 'merge-writer-active', message: `坑库合并被单写者护栏拒（写者活跃）：${guard.reason.slice(0, 240)}` });
    record.deferred.push('语义合并：坑库被单写者护栏拒（tick 在写）');
  } else {
    log(`    单写者护栏：已持有 tick-${'p4-pitfall'} 锁（tick 本轮将被拒=跳过，不并发写）`);
    try {
      const r = runMergeCli('merge-pitfalls.mjs',
        ['--from', peer.root, '--apply', '--allow-production', '--json', '--top', '5',
          '--archive-dir', mergeArchive('pitfalls')],
        { timeoutMs: Math.min(BUDGET.mergeMs, Math.max(5_000, stepBudgetLeft())) });
      res.pitfalls = pitfallStepFrom(r);
      if (r.timedOut) record.deferred.push('语义合并：坑库合并超时（fail-open）');
    } finally {
      const rel = guard.release();
      res.writers.released = rel === true;   // 仅用于日志；schema 不写该字段（见 buildMergeField）
    }
  }

  // 门⑤-b 记忆库：窗口判据（DSH 停止 + WAL 空）→ 再合并
  if (stepBudgetLeft() <= 5_000) {
    res.memory = { ...emptyMergeStep(), skipped: true, reason: 'A5b 段预算已耗尽' };
    record.deferred.push('语义合并：记忆库因段预算耗尽跳过');
  } else if (dec.memory === 'missing') {
    res.memory = { ...emptyMergeStep(), skipped: true, reason: '仓1 无记忆库副本' };
  } else {
    const localDb = localMemoryDbPath();
    const win = judgeMemoryWindow({ dshRunning: running === true, walBytes: memoryWalBytes(localDb) });
    if (!win.ok) {
      res.memory = { ...emptyMergeStep(), skipped: true, reason: win.reasons.join('；').slice(0, 200) };
      warn(`记忆库合并跳过（窗口判据）：${win.reasons.join('；')}`);
      record.alerts.push({ level: 'warn', code: 'memory-merge-window', message: `记忆库合并跳过：${win.reasons.join('；')}`.slice(0, 300) });
      record.deferred.push('语义合并：记忆库未在停机窗口（跳过）');
    } else {
      const r = runMergeCli('merge-memory.mjs',
        ['--from', peer.root, '--apply', '--allow-production', '--json', '--top', '5',
          '--archive-dir', mergeArchive('memory')],
        { timeoutMs: Math.min(BUDGET.mergeMs, Math.max(5_000, stepBudgetLeft())) });
      if (r.timedOut) record.deferred.push('语义合并：记忆库合并超时（fail-open）');
      res.memory = memoryStepFrom(r);
    }
  }

  // 门⑥ 变更流水（文档条目 · B 组 gap-1-55 · 2026-10-10 接线）：**默认关**（闸文件缺省 = 关 ⇒ 零行为变化）。
  //   位置：**排在坑库/记忆库之后** —— 不改这两条链的顺序/参数/超时/结果处理；闸关时只打一行日志。
  //   留痕走 record.alerts（不进 record.merge，见 runChangelogStep 注释：schema additionalProperties:false）。
  res.changelog = runChangelogStep({
    pulled, record,
    mergeArchive,
    stepBudgetLeft,
    timeoutMs: Math.min(BUDGET.mergeMs, Math.max(5_000, stepBudgetLeft())),
    logFn: log, warnFn: warn,
  });
  return done();
}

// ---------------------------------------------------------------- --arrive

function cmdArrive(o) {
  const cfg = ctx();
  const host = core.currentHost();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const record = core.emptyRecord(host, startedAt);
  record.role = 'arrive';
  record.dshVersion = readDshVersion();
  record.pluginVersions = readPluginVersions();
  const prevRec = readLocalRecord();
  record.lastHeartbeatAt = prevRec?.lastHeartbeatAt ?? null;
  record.lastSuccessfulHandoffAt = prevRec?.lastSuccessfulHandoffAt ?? null;

  const manifest = core.loadManifest();

  // A1 版本门（§5.3 第 1 条 · **H1b 起强校验 fail-closed**）
  //   数据源：本机 ~/.dsh/handoff-version.json（权威）+ 仓内 dsh/handoff-version.json（发布方写）
  //   判据：仓内 minSupported > 本机 self → **拒绝执行**（旧脚本读新数据＝事故 3 成因）
  //   ⚠️ 比较一律走 compareVersions（按数字段）；**字符串比较会把 0.9.0 判成大于 0.10.0**（实测教训）
  section(`Arrive · A1 版本门（主机 ${host}${o.dryRun ? ' · DRY-RUN' : ''}）`);
  const running = dshRunning();
  if (running === true) {
    warn('DSH 正在运行（3080 监听中）→ 本次 Arrive 为**热 Arrive**（只做拉取+分发，不碰运行中的账本/记忆库；离线语义合并属 H2）');
  } else if (running === false) {
    ok('DSH 未运行（3080 无监听）→ 冷 Arrive');
  }
  // 前置：确保本机版本文件存在（自举；不覆盖已有 minSupported）。fail-closed 的前提是 self 可读。
  let verFileState = null;
  try {
    verFileState = ensureLocalVersionFile({ home: dshHome(), dshRoot: DSH_ROOT });
    if (verFileState.created) log(`    自举：已建立本机 ${path.basename(verFileState.file)}（self=${verFileState.data.self}）`);
  } catch (e) {
    warn(`本机版本文件读写失败：${String(e?.message ?? e).slice(0, 120)}`);
  }
  const gate = checkVersionGate({ home: dshHome(), worktreeRoot: { 'dsh-core': REPOS['dsh-core'].dir } });
  log(`    本机 handoff-version.json：${gate.localData ? `self=${gate.localData.self ?? '-'} minSupported=${gate.localData.minSupported ?? '-'}` : '(缺 → fail-closed)'}`);
  log(`    仓内 handoff-version.json：${gate.repoData ? `minSupported=${gate.repoData.minSupported ?? '-'}` : '(未发布 → 不设硬门)'}`);
  record.handoffVersion = gate.self ?? null;
  record.minSupported = gate.minSupported ?? null;
  record.versionGate = {
    decision: gate.decision, reason: String(gate.reason).slice(0, 320), verdict: null,
    needHumanConfirm: false, peerHost: null, diffs: [],
  };
  if (gate.decision === 'reject') {
    bad(`版本门 fail-closed：${gate.reason}`);
    record.alerts.push({ level: 'alert', code: 'version-gate', message: `版本门拒绝执行：${gate.reason}` });
    if (!o.dryRun) {
      record.result = 'failed';
      record.applied = prevRec?.applied ?? [];   // 失败分支保留 T3 基线（同 Depart）
      record.finishedAt = new Date().toISOString();
      try { writeLocalRecord(record); } catch { /* 校验错误已抛 */ }
      appendAudit({ type: 'handoff', role: 'arrive', host, result: 'failed', code: 'version-gate', reason: gate.reason });
    }
    OUT.json = { role: 'arrive', result: 'failed', reason: 'version-gate', gate: { ...gate, localData: undefined, repoData: undefined } };
    return 2;
  }
  if (gate.minSupported) ok(`版本门放行：${gate.reason}`);
  else log('    版本门：不设硬门（仓内未声明 minSupported）');

  // A2 fetch + 心跳
  section('Arrive · A2 fetch 三仓 + 心跳检查');
  for (const name of repoOrder(o)) {
    const dir = REPOS[name].dir;
    if (!fs.existsSync(path.join(dir, '.git'))) { warn(`${name}: 工作副本不存在，跳过`); continue; }
    const r = git(dir, ['fetch', 'origin'], { timeout: BUDGET.fetchMs });
    if (r.ok) ok(`${name}: fetched`);
    else {
      warn(`${name}: fetch 失败${r.timedOut ? '（超时）' : ''} → fail-open（不挡启动，本次跳过该仓拉取）`);
      record.alerts.push({ level: 'warn', code: 'fetch-failed', message: `${name}: fetch 失败（fail-open）` });
      record.deferred.push(`${name}: fetch 失败`);
    }
  }

  const peers = readPeerRecords(host);
  for (const p of peers) {
    const judge = core.judgeHeartbeat(p.record, { startedAtMs: startedMs });
    log(`    [${p.host}] ${judge.reasons.join('；') || '无异常'}`);
    if (judge.dualActive) {
      // 保留窄窗口判据（本机 Arrive 期间对端心跳动了）作为**加分证据**，但**不单独据此中止**：
      //   旧口径在 30 分钟热采周期下检测率太低（方案 §17.2 T4 实测结论），故放宽为下面 A2b 的 T4 判据。
      record.alerts.push({ level: 'warn', code: 'dual-active-narrow', message: `双开嫌疑（窄窗口）：对端 ${p.host} 心跳在本次 Arrive 进行中被更新` });
    }
    if (judge.handoffStale) {
      record.alerts.push({ level: 'warn', code: 'peer-handoff-stale', message: `对端 ${p.host} 上次完整交接超 24h（可能崩在半路）` });
    }
  }
  if (!peers.length) log('    对端无记录（新机 / 冷启动）→ 放行');

  // A2b 双开嫌疑（§17.2 T4 放宽口径，**H1 硬条款**）
  //   判据 = 「`lastHeartbeatAt` 显著新于 `lastSuccessfulHandoffAt`」= 对端在最后一次完整交接之后仍在活动。
  //   为什么不用"Arrive 进行中被更新"那条：那要求心跳恰好落在本机这几秒窗口内，30 分钟热采周期下
  //   检测率极低（T4 原文），等于把唯一强防线推给 H5 云中继租约 —— 本卡按 T4 把它落到 H1。
  //   误伤校验：正常 Depart→Arrive 流程里两个字段同刻更新，差值≈0，不会误报。
  let dualActive = false;
  for (const p of peers) {
    const t4 = judgeDualActiveTransition(p.record, { now: startedMs });
    log(`    [双开判定·T4] ${p.host}：${t4.reason}`);
    if (t4.suspected === true) {
      dualActive = true;
      record.alerts.push({ level: 'alert', code: 'dual-active', message: `双开嫌疑（T4）：对端 ${p.host} ${t4.reason}` });
    }
  }
  // ⚠️ dualActive 只作局部变量使用：**不许挂到 record 上** —— 交接单 schema 是
  //    additionalProperties:false 的白名单，多一个字段就会整单写入失败（写盘前硬校验）。

  // A2c 主包 + 关键插件版本比对（§5.3 R10）
  //   口径：**不自动拒绝**（正常灰度升级不该被卡死），但必须让人看见，且**合并前要求人工确认**。
  //   合并器属 H2，这里只负责"记录 + 告警 + 明确要求"，绝不在本卡里替人拍板。
  if (peers.length) {
    const peerRec = peers[0].record;
    const cmp = compareVersionTables({
      self: { host, dshVersion: record.dshVersion, pluginVersions: pickCriticalPluginVersions(record.pluginVersions), handoffVersion: gate.self },
      peer: { host: peers[0].host, dshVersion: peerRec.dshVersion, pluginVersions: pickCriticalPluginVersions(peerRec.pluginVersions), handoffVersion: peerRec.handoffVersion },
    });
    record.versionGate.verdict = cmp.verdict;
    record.versionGate.needHumanConfirm = cmp.needHumanConfirm;
    record.versionGate.peerHost = peers[0].host;
    record.versionGate.diffs = cmp.diffs.map((d) => ({ key: d.key, self: d.self ?? null, peer: d.peer ?? null, verdict: d.verdict })).slice(0, 16);
    log(`    [版本比对] ${cmp.summaryLine}`);
    for (const d of cmp.diffs) {
      if (d.verdict === 'exact' || d.verdict === 'not-applicable') continue;
      warn(`      · ${d.label}: 本机 ${d.self ?? '∅'} / 对端 ${d.peer ?? '∅'}（${d.reason}）`);
    }
    if (cmp.needHumanConfirm) {
      record.alerts.push({ level: 'warn', code: 'version-forked', message: `版本门：${cmp.summaryLine}（R10：合并前需人工确认）` });
    }
  }

  if (dualActive && !o.force && !o.dryRun) {
    bad('双开嫌疑（fail-closed）：禁止分发。确认对端已停可加 --force');
    record.result = 'failed';
    record.applied = prevRec?.applied ?? [];
    record.finishedAt = new Date().toISOString();
    try { writeLocalRecord(record); } catch { /* ignore */ }
    return 2;
  }

  // A3 分叉检测
  section('Arrive · A3 分叉检测（本机未推送提交）');
  const forks = [];
  const repoRows = [];
  for (const name of repoOrder(o)) {
    const dir = REPOS[name].dir;
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const h = repoHeads(dir);
    repoRows.push({ name, localHead: h.localHead, remoteHead: h.remoteHead, behind: h.behind, ahead: h.ahead, pushed: false, sizeBytes: core.measureRepoVolume(dir).sizeBytes });
    if (h.ahead !== null && h.ahead > 0) {
      forks.push(`${name}: 本机有 ${h.ahead} 个未推送提交`);
      warn(`${name}: ahead=${h.ahead}（未推送提交）`);
    } else ok(`${name}: 无未推送提交`);
  }
  record.repos = repoRows;
  if (forks.length) {
    bad('fail-closed：本机有未推送提交 → 先跑 --depart，再 Arrive（§5.1 A3）');
    for (const f of forks) record.alerts.push({ level: 'alert', code: 'local-ahead', message: f });
    record.result = 'failed';
    record.applied = prevRec?.applied ?? [];
    record.finishedAt = new Date().toISOString();
    if (!o.dryRun) { try { writeLocalRecord(record); } catch { /* ignore */ } }
    OUT.json = { role: 'arrive', result: 'failed', reason: 'local-ahead', repos: repoRows };
    return 1;
  }

  if (o.dryRun) {
    section('Arrive · DRY-RUN 计划（不 pull、不分发、不写交接单）');
    for (const name of repoOrder(o)) {
      const dir = REPOS[name].dir;
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      const h = repoHeads(dir);
      log(`    ${name}: 将 git pull --ff-only（behind=${h.behind ?? '?'}）`);
    }
    if (!o.skipSessions) log('    A5 会话落地：将调用 dsh-sessions-land.mjs（仓2 → 本机 sessions，只补缺；dry-run 只预览不执行）');
    log(`    A5b 离线语义合并：将在 A4 pull 之后合并坑库 + 记忆库（门：开关/pull/解密自检/时钟门；护栏：抢 p4-pitfall tick 锁；单步 ≤${Math.round(BUDGET.mergeMs / 1000)}s、整段 ≤${Math.round(BUDGET.mergeTotalMs / 1000)}s；dry-run 只预览不执行）`);
    const expanded = core.expandManifest(manifest, cfg);
    const baseline = core.baselineFromRecord(prevRec);
    const { plan, alerts } = core.planDispatch(expanded.files, baseline, { confirmDiverged: o.confirmDiverged, adoptUnrecorded: o.adoptUnrecorded });
    log(`    清单 ${expanded.files.length} 个文件；基线 ${Object.keys(baseline).length} 项`);
    for (const [k, v] of Object.entries(summarizePlan(plan))) log(`      ${k}: ${v}`);
    for (const p of plan.filter((x) => x.action.startsWith('skipped')).slice(0, 30)) log(`      · ${p.key} — ${p.reason}`);
    OUT.json = { role: 'arrive', result: 'dry-run', repos: repoRows, planSummary: summarizePlan(plan), plan, alerts, peers: peers.map((p) => p.host) };
    return 0;
  }

  // A4 pull --ff-only
  section('Arrive · A4 git pull --ff-only（禁 merge / rebase）');
  const pulled = {};
  for (const name of repoOrder(o)) {
    const dir = REPOS[name].dir;
    if (!fs.existsSync(path.join(dir, '.git'))) { pulled[name] = false; continue; }
    const r = git(dir, ['pull', '--ff-only', 'origin', 'master'], { timeout: BUDGET.pullMs });
    pulled[name] = r.ok;
    if (r.ok) ok(`${name}: pulled`);
    else {
      warn(`${name}: pull --ff-only 失败${r.timedOut ? '（超时）' : ''} → 该仓跳过分发（fail-open）`);
      record.alerts.push({ level: 'warn', code: 'pull-failed', message: `${name}: pull --ff-only 失败（本次不分发该仓）` });
      record.deferred.push(`${name}: pull 失败`);
      log(`       ${(r.err || r.out).split('\n').slice(-2).join(' | ').slice(0, 240)}`);
    }
  }

  // A5 会话落地（仓2，2026-09-12 新增）
  //   背景：A4 只把仓2 拉到最新，而 sessions/** 不在 handoff-manifest.json 里 → 会话从不落地，
  //   接机后 UI 看不到对端会话（2026-09-12 实测：对端推的 21 个会话在仓里、本机看不见）。
  //   判定与安全边界全在落地器内（tools/dsh-sessions-land.mjs）：解锁前置（密文绝不落地）
  //   + 三判据（退出码 / 降级串 / HEAD 与落盘自证）+ non-ff 检测。
  section('Arrive · A5 会话落地（仓2：仓 → 本机 sessions，只补缺）');
  if (o.skipSessions) {
    record.sessions = buildSessionField({ ok: true, skipped: true, reason: 'skip-sessions' });
    log('    --skip-sessions：跳过仓2 会话落地');
  } else if (pulled['dsh-sessions'] !== true) {
    record.sessions = buildSessionField({ ok: false, skipped: true, reason: 'repo2-pull-failed' });
    warn('仓2 pull 未成功 → 本次不做会话落地（fail-open）');
    record.alerts.push({ level: 'warn', code: 'sessions-not-landed', message: '仓2 pull 未成功 → 会话未落地（fail-open）' });
    record.deferred.push('dsh-sessions: pull 未成功，会话未落地');
  } else {
    const landed = runSessionsLand(o);
    record.sessions = buildSessionField(landed);
    if (landed.ok && landed.skipped && landed.reason === 'skipped-unchanged') {
      // D4（卡 A2 · 2026-09-17）：仓2 HEAD 未变 + 上次已成功落地 ⇒ 落地器省掉一次 git pull。
      // 不区分的话这里会打印 "merged 0 / kept 0 / skipped-archived 0"，看着像失败。
      ok(`会话落地：跳过（${landed.skipDecision ?? landed.reason}；仓2 未动，上次已成功落地）`);
    } else if (landed.ok) {
      ok(`会话落地：merged ${landed.mergedCount} / kept ${landed.keptCount} / skipped-archived ${landed.skippedArchivedCount}`);
    } else {
      const reason = String(landed.reason ?? 'unknown');
      warn(`会话落地未完成：${reason}（fail-open，接机继续）`);
      record.alerts.push({
        level: reason === 'repo-not-unlocked' ? 'alert' : 'warn',
        code: 'sessions-not-landed',
        message: `会话未落地：${reason.slice(0, 200)}`,
      });
      record.deferred.push(`dsh-sessions: 会话未落地（${reason.slice(0, 100)}）`);
    }
  }

  // A5b 离线语义合并（H2 接线 · 2026-09-15）
  //   **位置铁律**：A4 pull 成功之后 —— 对端数据此刻才在仓1 工作副本里就位。
  //   门（开关 / pull / 解密自检 / 时钟门）+ 单写者护栏见 runOfflineMerge；
  //   一切失败 fail-open（跳过 + 告警 + deferred），绝不阻断 Arrive。
  section('Arrive · A5b 离线语义合并（坑库 + 记忆库 · §4.3 / §17.1 T1·T2）');
  const mergeRes = runOfflineMerge(o, { running, pulled, record, startedMs });
  record.merge = buildMergeField(mergeRes);
  if (mergeRes.skipped) {
    log(`    结果：整段跳过（${mergeRes.reason ?? '-'}）`);
  } else {
    log(`    坑库：${mergeRes.pitfalls.ok ? 'ok' : (mergeRes.pitfalls.skipped ? 'skipped' : 'failed')}`
      + `${mergeRes.pitfalls.inserted !== null ? ` · 新增 ${mergeRes.pitfalls.inserted} 条` : ''}`
      + `${mergeRes.pitfalls.written ? ' · 已写库' : ''}（${mergeRes.pitfalls.durationMs}ms）`);
    log(`    记忆库：${mergeRes.memory.ok ? 'ok' : (mergeRes.memory.skipped ? 'skipped' : 'failed')}`
      + `${mergeRes.memory.inserted !== null ? ` · 补缺 ${mergeRes.memory.inserted} 条` : ''}`
      + `${mergeRes.memory.written ? ' · 已写库' : ''}（${mergeRes.memory.durationMs}ms）`);
    log(`    单写者护栏：${mergeRes.writers.held ? '已持锁（tick 本轮被拒=跳过，不并发写）'
      : (mergeRes.writers.active ? '探测到写者活跃 → 拒合并' : '未持锁（已跳过）')}${mergeRes.writers.waitedMs ? ` 等待 ${mergeRes.writers.waitedMs}ms` : ''}`);
    // 门⑥ 变更流水（B 组 · gap-1-55）：闸关时已在 runChangelogStep 里打过一行，这里不重复。
    if (mergeRes.changelog && mergeRes.changelog.status !== 'off') {
      const lb = { applied: '已并入', nochange: '无需合并', skipped: '跳过', failed: '失败' }[mergeRes.changelog.status] ?? mergeRes.changelog.status;
      log(`    变更流水：${lb}${mergeRes.changelog.payload?.stats ? ` · 对端独有 ${mergeRes.changelog.payload.stats.onlyRemote} 条 / 本机独有 ${mergeRes.changelog.payload.stats.onlyLocal} 条保留` : ''}`
        + `${mergeRes.changelog.reason ? `（${mergeRes.changelog.reason}）` : ''}（${mergeRes.changelog.durationMs}ms）`);
    }
  }
  if (mergeRes.pitfalls.ok && mergeRes.pitfalls.inserted) {
    record.alerts.push({ level: 'info', code: 'merge-pitfalls-applied', message: `坑库合并：新增 ${mergeRes.pitfalls.inserted} 条（并集 ${mergeRes.pitfalls.unionEntries ?? '?'}）` });
  }
  if (mergeRes.memory.ok && mergeRes.memory.autoRenamed) {
    record.alerts.push({ level: 'info', code: 'merge-memory-renamed', message: `记忆库 id 撞车自动并存 ${mergeRes.memory.autoRenamed} 条（D2=② 高位段显示 id）` });
  }
  if (mergeRes.pitfalls.reason && !mergeRes.pitfalls.ok && !mergeRes.pitfalls.skipped) {
    record.alerts.push({ level: 'warn', code: 'merge-pitfalls-failed', message: `坑库合并未完成（fail-open）：${String(mergeRes.pitfalls.reason).slice(0, 200)}` });
    record.deferred.push(`语义合并：坑库未完成（${String(mergeRes.pitfalls.reason).slice(0, 80)}）`);
  }
  if (mergeRes.memory.reason && !mergeRes.memory.ok && !mergeRes.memory.skipped) {
    record.alerts.push({ level: 'warn', code: 'merge-memory-failed', message: `记忆库合并未完成（fail-open）：${String(mergeRes.memory.reason).slice(0, 200)}` });
    record.deferred.push(`语义合并：记忆库未完成（${String(mergeRes.memory.reason).slice(0, 80)}）`);
  }

  // A6 对偶门 + 分发
  section('Arrive · A6 落地分发（清单 + 规范化 sha256 + T3 对偶门）');
  const expanded = core.expandManifest(manifest, cfg);
  if (expanded.errors.length) for (const e of expanded.errors) warn(e);
  const baseline = core.baselineFromRecord(prevRec);
  const filesFromOkRepos = expanded.files.filter((f) => pulled[f.repo] === true);
  const skippedRepos = expanded.files.length - filesFromOkRepos.length;
  if (skippedRepos) warn(`    ${skippedRepos} 个文件因所属仓 pull 未成功而本次不分发`);
  const { plan, alerts } = core.planDispatch(filesFromOkRepos, baseline, {
    confirmDiverged: o.confirmDiverged, adoptUnrecorded: o.adoptUnrecorded,
  });
  for (const a of alerts) {
    (a.level === 'alert' ? bad : warn)(`${a.code}: ${a.message}`);
    record.alerts.push(a);
  }
  // ---- T3 对称补齐 · 仓侧门（2026-09-11 实测事故后新增）------------------------
  // 事故：工作副本某文件是旧版、而本仓自上次交接以来**没有任何新提交**（HEAD 未前进），
  //   此时「基线 == 生产当前」会判 applied，于是把工作副本旧版**反向覆盖**到生产（本次实测命中
  //   tools/dsh-butler/lib/restart.mjs：生产 20692B 被旧版 19851B 覆盖，已从交接期备份恢复）。
  // 判据：仓库 HEAD 未前进（无新提交）却出现 src != 基线 → 内容不可能来自对端 → 拒绝分发。
  //   若 HEAD 前进过（对端推了新提交），则按正常流程（那是 Arrive 的本职）。
  const prevHeads = Object.fromEntries((prevRec?.repos ?? []).map((r) => [r.name, r.localHead]));
  const curHeads = Object.fromEntries(repoRows.map((r) => [r.name, r.localHead]));
  let driftSkipped = 0;
  let driftResolved = 0;
  for (const p of plan) {
    if (p.action !== 'applied') continue;
    const meta = expanded.files.find((f) => f.key === p.key);
    const repo = meta?.repo;
    if (!repo || !prevHeads[repo] || curHeads[repo] !== prevHeads[repo]) continue;
    const base = baseline[p.key]?.sha256;
    if (!base || base === p.sha256) continue;
    if (o.force) {
      record.alerts.push({ level: 'warn', code: 'repo-drift-forced', message: `仓侧漂移经 --force 放行：${p.key}` });
      continue;
    }
    // ---- AT17 解死锁（2026-09-16）------------------------------------------------
    // 「HEAD 未前进 + 仓侧 sha ≠ 基线」**不等于**本地回退：基线只在 applied/unchanged 时更新，
    //   skipped-* 会保留更早的旧值 ⇒ 上一轮没分发成功的内容，本轮天然满足该形态（现场：
    //   depart 紧接着 arrive，curHead == prevHeads 恒成立 ⇒ handoff.mjs 自己都被永久拦）。
    //   放行判据：该文件在工作副本相对 HEAD **无未提交改动** ⇒ 工作副本内容 == HEAD 里那一版；
    //   而 HEAD 哈希没变 ⇒ 仓里那份与上次交接时逐字节相同 ⇒ 该差异不可能是本轮回退造成的。
    //   ⚠️ 脏文件（本地写过/回退过）**照旧拦**（反向锚）；`--strict-repo-drift` 整体回到旧行为。
    if (!o.strictRepoDrift && repoFileClean(REPOS[repo]?.dir, meta?.repoPath)) {
      driftResolved++;
      record.alerts.push({
        level: 'info', code: 'repo-drift-resolved',
        message: `仓侧门放行（该文件无未提交改动 ⇒ 内容来自已提交版本，非本地回退）：${p.key}`.slice(0, 300),
      });
      continue;
    }
    driftSkipped++;
    p.action = 'skipped-repo-drift';
    p.reason = '工作副本内容与上次交接基线不符，且本仓自上次交接以来无新提交 → 疑似工作副本被本地回退，拒绝分发';
    record.alerts.push({ level: 'alert', code: 'repo-drift', message: `仓侧漂移（工作副本 ≠ 基线且仓未前进），已跳过不覆盖：${p.key}` });
  }
  if (driftSkipped) bad(`仓侧门命中 ${driftSkipped} 个文件（skipped-repo-drift）`);
  if (driftResolved) ok(`仓侧门放行 ${driftResolved} 个文件（内容来自已提交版本 ⇒ 上次未分发成功的历史遗留，非本地回退）`);

  // ---- A6b 漏网文件分发（卡 AT12 · 2026-09-16）----------------------------------
  // 为什么需要：A6 是**逐条枚举**的清单（enabled 9 条），新增的 tools/**、docs/**、skills/**
  //   文件永远进不去 ⇒ 对端生产永远拿不到新版 ⇒ 下一次 Depart 的采集用旧生产覆盖工作副本、
  //   新版被顶掉（2026-09-16 同一件事咬了三次）。方案：docs\A6分发清单缺口治本-方案-20260916.md。
  // 口径：本次交接 diff（prevHead..HEAD）∩ 白名单 − 排除项 − A6 已覆盖项 − 本机独有内容；
  //   写盘复用本文件既有的 planDispatch/executeDispatch（T3 对偶门 + .ps1 BOM 门 + 逐个备份
  //   + 只覆盖不删除），**不另造一套**。
  // 默认 **report-only**（只报告不写盘）；放行 = ~/.dsh/butler-handoff-adopt.json 的 mode="apply"
  //   或单轮 --adopt-apply（⚠️ 单轮覆盖绝不写回持久配置）。
  let adoptReport = null;
  const adoptStateFile = path.join(dshHome(), ADOPT_STATE_NAME);
  if (o.skipAdopt) {
    log('    A6b 漏网文件分发：按 --skip-adopt 跳过');
  } else {
    section('Arrive · A6b 漏网文件分发（仓侧 diff ∩ 白名单 · 默认 report-only）');
    const adoptMode = resolveAdoptMode({ cliFlag: o.adoptMode, stateFile: adoptStateFile });
    // AT17 分发锚：diff 起点 = --adopt-since（单轮） > lastAdoptHead（上次成功的进度） > 交接单 HEAD（回落）。
    //   为什么不能只吃交接单 HEAD：arrive/depart 都会把记录推到 HEAD ⇒ 上一轮没分发成功的积压永远捡不回。
    const anchorRead = readAdoptAnchor(adoptStateFile);
    if (anchorRead.reason && anchorRead.reason !== 'no-state-file') warn(`A6b 锚文件读取异常：${anchorRead.reason}（回落交接单口径）`);
    const sincePicks = new Map();
    const coveredKeys = new Set(expanded.files.map((f) => f.key));
    const adopt = buildAdoptCandidates({
      repos: repoOrder(o)
        .map((n) => ({ n, a: adoptAnchorFor(n) }))
        .filter((x) => x.a)
        .map(({ n, a }) => {
          const pick = resolveAdoptSince({
            cliSince: o.adoptSince,
            anchorHead: anchorRead.lastAdoptHead?.[n] ?? null,
            fallbackPrevHead: prevRec?.repos?.find((r) => r.name === n)?.localHead ?? null,
          });
          sincePicks.set(n, pick);
          return {
            name: n,
            dir: REPOS[n].dir,
            anchor: a.anchor,
            prodRoot: a.prodRoot,
            // diff 起点（见上：锚优先，锚缺失才回落「上一次交接单记录的 HEAD」）
            prevHead: pick.since,
            pulled: pulled[n] === true,
            coveredKeys,
          };
        }),
    });
    for (const [n, pick] of sincePicks) adopt.notes.unshift(`${n}: diff 起点 ${pick.since ?? '(不可用)'}（来源 ${pick.source}）`);
    for (const line of formatAdoptReport(adopt, { mode: adoptMode.mode })) log(line);
    if (adopt.candidates.length) {
      const judged = core.planDispatch(adopt.candidates, baseline, {
        // lib 内的 F2b 门已要求「本机生产那份内容能从仓 git 历史找回」才进候选 ⇒ 覆盖可回退，
        //   故允许无基线项放行（否则每次新增文件都要人工 --adopt-unrecorded，等于没治本）。
        adoptUnrecorded: true,
        confirmDiverged: false,
      });
      for (const [k, v] of Object.entries(summarizePlan(judged.plan))) log(`    A6b 门判定 ${k}: ${v}`);
      adoptReport = {
        at: new Date().toISOString(), mode: adoptMode.mode, modeSource: adoptMode.source,
        since: Object.fromEntries([...sincePicks].map(([n, p]) => [n, { since: p.since, source: p.source }])),
        stats: adopt.stats,
        candidates: adopt.candidates.map((c) => ({ key: c.key, repoPath: c.repoPath, bytes: c.bytes, adoptNew: c.adoptNew, gitRecoverRev: c.gitRecoverRev })),
        plan: judged.plan.map((p) => ({ key: p.key, action: p.action, reason: p.reason ?? null })),
        localUncommitted: adopt.skipped.filter((s) => s.reason.startsWith('local-content-not-in-git')),
        notes: adopt.notes, errors: adopt.errors,
      };
      if (adoptMode.mode === 'apply') {
        // 并入 A6 的同一个 plan ⇒ 一次 executeDispatch（备份 / 恢复脚本 / applied 基线一并处理）
        for (const p of judged.plan) plan.push(p);
        for (const a of judged.alerts) { (a.level === 'alert' ? bad : warn)(`A6b: ${a.code}: ${a.message}`); record.alerts.push(a); }
        ok(`A6b 已并入本轮分发计划：${judged.plan.filter((p) => p.action === 'applied').length} 项将写盘`);
      } else {
        warn('A6b 为 report-only：以上候选**未写盘**；确认清单干净后把 ~/.dsh/butler-handoff-adopt.json 的 mode 改成 "apply"（或单轮 --adopt-apply）');
      }
      record.alerts.push({
        level: 'info', code: 'adopt-candidates',
        message: `A6b 漏网文件：候选 ${adopt.candidates.length} 项（mode=${adoptMode.mode}/${adoptMode.source}；A6 已覆盖 ${adopt.stats.coveredByA6} / 排除 ${adopt.stats.excluded} / 白名单外 ${adopt.stats.notWhitelisted}）`.slice(0, 300),
      });
      if (adopt.stats.localUncommitted) {
        record.alerts.push({
          level: 'warn', code: 'adopt-local-uncommitted',
          message: `A6b：${adopt.stats.localUncommitted} 项因「本机生产内容不在仓历史」（疑似未采集的本地改动）被跳过，未覆盖`.slice(0, 300),
        });
        record.deferred.push(`A6b：${adopt.stats.localUncommitted} 项本机独有内容未分发（需人工裁决）`);
      }
    } else {
      log('    A6b：本次交接无漏网文件（0 项）——不写盘、不产生告警');
    }

    // —— AT17 分发锚推进（治「只吃本次 diff、积压捡不回」）--------------------------
    //   推进条件：apply 且本轮**没有**被跳过/失败项（否则保留旧锚 ⇒ 下一轮用同一锚重扫 = 积压自动重试）；
    //   只推进「本轮真被扫过的仓」（未扫 = 起点不可用 / pull 失败 ⇒ 推进会把积压永久丢掉）。
    const verdict = judgeAnchorAdvance({ mode: adoptMode.mode, plan: adoptReport?.plan ?? [], forced: o.adoptAdvanceAnchor });
    const scanned = new Set(adopt.stats.scannedRepos ?? []);
    const advanceHeads = {};
    if (verdict.advance) {
      for (const n of scanned) {
        if (!sincePicks.get(n)?.since) continue;
        const h = git(REPOS[n].dir, ['rev-parse', 'HEAD']);
        if (h.ok && h.out) advanceHeads[n] = h.out;
      }
    }
    if (Object.keys(advanceHeads).length) {
      try {
        updateStateJson(ADOPT_STATE_NAME, adoptStateFile, (cur) => {
          const base = (cur && typeof cur === 'object') ? cur : {};
          return {
            ...base,
            lastAdoptHead: { ...(base.lastAdoptHead ?? {}), ...advanceHeads },
            anchorUpdatedAt: new Date().toISOString(),
          };
        }, { home: dshHome(), audit: false });
        log(`    A6b 分发锚已推进：${Object.entries(advanceHeads).map(([n, h]) => `${n}=${h.slice(0, 8)}`).join(' ')}（${verdict.reason}）`);
        record.alerts.push({
          level: 'info', code: 'adopt-anchor-advanced',
          message: `A6b 分发锚推进（${verdict.reason}）：${Object.keys(advanceHeads).join(', ')}`.slice(0, 300),
        });
      } catch (e) {
        warn(`A6b 锚推进失败：${e?.message ?? e}（不影响本轮分发）`);
      }
    } else {
      const why = verdict.advance ? '（无可用起点 ⇒ 无可推进的仓）' : verdict.reason;
      log(`    A6b 分发锚未推进：${why}${verdict.blocked ? `（被拦 ${verdict.blocked} 项 ⇒ 下轮用同一锚重扫）` : ''}`);
    }
  }

  // ---- A7 附件差额报告（卡 AT1 · 2026-09-16）-------------------------------------
  // 为什么需要：图片附件实体 `<home>/attachments/v1/objects/<2>/<sha256>` **不进任何仓**
  //   （仓1 白名单明确排除 attachments；仓2 只搬 sessions/**）⇒ 从对端同步来的「含图会话」
  //   在本机续聊必报 `DeepSeek API stream ... failed` / code=TRANSPORT —— 那不是网络故障：
  //   每轮请求都会扫**全部历史消息**里的图片引用，缺实体时抛普通 Error 被兜底 catch 归成 TRANSPORT。
  //   本段只做**只读对账**（缺哪些对象 / 影响哪些会话 / 怎么补），异常一律不阻断 Arrive（同 A6b 口径）。
  //   真补齐 = `--attach-fetch-from <对端 .dsh\attachments 路径 | 中转介质目录>`（本轮内取回并校验 sha256）。
  let attachReport = null;
  if (o.skipAttach) {
    log('    A7 附件差额：按 --skip-attach 跳过');
  } else {
    section('Arrive · A7 附件差额报告（只读；缺附件 ⇒ 含图会话续聊必 TRANSPORT）');
    const audit = runAttachAudit();
    if (!audit.ok) {
      warn(`附件对账不可用：${audit.reason}（不阻断 Arrive）`);
    } else {
      const s = audit.summary;
      log(`    会话 ${s.sessionFiles}（含图 ${s.sessionsWithImages}）· 本机附件对象 ${s.objectFiles} · 被引用对象 ${s.distinctSha} 个`);
      if (s.missingObjects === 0) {
        ok('本机被引用的图片附件全部在位（无缺口）');
      } else {
        warn(`缺失附件对象 ${s.missingObjects} 个（约 ${(s.missingBytesEstimate / 1048576).toFixed(2)} MB）· 受影响会话 ${s.affectedSessions}`);
        for (const a of s.affected.slice(0, 5)) log(`      ${String(a.missing.length).padStart(3)} 个  ${a.rel}`);
        if (s.affected.length > 5) log(`      … 另 ${s.affected.length - 5} 个会话（完整清单见报告 JSON）`);
        log(`    补齐（对端在场）：node ${attachToolPath('attachments-fetch.mjs')} --all-missing --from <对端 .dsh\\attachments 路径>`);
        log(`    补齐（介质中转）：先 --export <介质目录>，再在对端 --relay <介质目录>；或本轮加 --attach-fetch-from <路径>`);
        record.alerts.push({
          level: 'warn', code: 'attach-missing',
          message: `附件差额：缺 ${s.missingObjects} 个对象 / 影响 ${s.affectedSessions} 个会话（这些含图会话续聊会报 TRANSPORT）`.slice(0, 300),
        });
        record.deferred.push(`附件差额：${s.missingObjects} 个对象缺失（${s.affectedSessions} 个含图会话受影响，需带介质或对端在场时取回）`);
        attachReport = {
          at: new Date().toISOString(),
          dshHome: s.dshHome, objectsRoot: s.objectsRoot,
          sessionFiles: s.sessionFiles, sessionsWithImages: s.sessionsWithImages,
          objectFiles: s.objectFiles, distinctSha: s.distinctSha,
          missingObjects: s.missingObjects, missingBytesEstimate: s.missingBytesEstimate,
          affectedSessions: s.affectedSessions,
          affected: s.affected.slice(0, 100),
          missing: s.missing.slice(0, 200).map((m) => ({ sha: m.sha, refs: m.refs, sessionCount: m.sessionCount, sample: m.sample })),
          fixHint: `node ${attachToolPath('attachments-fetch.mjs')} --all-missing --from <对端 .dsh\\attachments> | --relay <介质目录>`,
        };
      }
    }
  }

  const byAction = summarizePlan(plan);
  for (const [k, v] of Object.entries(byAction)) log(`    ${k}: ${v}`);

  const ts = tsStamp();
  const archiveDir = path.join(ARCHIVE_ROOT, `handoff-${ts}`);
  const exec = executeDispatch(plan, o, { archiveDir, ts });
  if (o.dryRun) {
    log('    （dry-run 不会走到这里）');
  } else {
    ok(`分发完成：写入 ${exec.appliedCount} 个文件，失败 ${exec.failedCount} 个`);
  }

  // 备份资产 + 一键恢复脚本（只在本轮真的动过生产文件时生成）
  if (exec.backupEntries.length) {
    if (!o.dryRun) {
      const r = writeRestoreAssets(archiveDir, exec.backupEntries, prevRec);
      if (r.error) warn(`恢复脚本写入失败：${r.error}`);
      else ok(`交接期备份：${path.relative(DSH_ROOT, archiveDir)}（${exec.backupEntries.length} 项）；恢复脚本 ${r.desktopFile ? '桌面\\' + path.basename(path.dirname(r.desktopFile)) + '\\' + path.basename(r.desktopFile) : '(未生成)'}`);
    }
  }
  // A6b 报告（**有候选才写**：无候选不产文件 = 无噪音；与「备份资产」同处，便于一并回滚）
  if (adoptReport && !o.dryRun) {
    try {
      ensureDir(archiveDir);
      writeJsonAtomic(path.join(archiveDir, 'adopt-report.json'), adoptReport, {});
      log(`    A6b 报告：${path.relative(DSH_ROOT, path.join(archiveDir, 'adopt-report.json'))}（mode=${adoptReport.mode}）`);
    } catch (e) { warn(`A6b 报告写入失败：${e?.message ?? e}`); }
  }
  // A7 报告（**有缺失才写**）+ 可选本轮取回（--attach-fetch-from）
  if (attachReport && !o.dryRun) {
    try {
      ensureDir(archiveDir);
      writeJsonAtomic(path.join(archiveDir, 'attach-report.json'), attachReport, {});
      log(`    A7 报告：${path.relative(DSH_ROOT, path.join(archiveDir, 'attach-report.json'))}`);
    } catch (e) { warn(`A7 报告写入失败：${e?.message ?? e}`); }
  }
  if (o.attachFetchFrom && !o.dryRun) {
    section('Arrive · A7b 附件取回（--attach-fetch-from）');
    if (!attachReport) {
      log('    本机无附件缺失（A7 对账为 0），跳过取回');
    } else {
      const res = runAttachFetch(o.attachFetchFrom, path.join(archiveDir, 'attach-fetch.json'));
      if (res.reason) {
        warn(`取回不可用：${res.reason}`);
      } else {
        const c = res.report?.counts ?? {};
        log(`    源 ${o.attachFetchFrom} → 取回 ${c.fetched ?? 0} · 已在位 ${c.skipped ?? 0} · 源中无 ${c.missing ?? 0} · 失败 ${c.failed ?? 0}`);
        if ((c.fetched ?? 0) > 0) ok(`已把 ${c.fetched} 个附件对象补进本机（sha256 逐个校验）`);
        if ((c.missing ?? 0) > 0) warn(`${c.missing} 个对象在该源里没有 —— 确认 --attach-fetch-from 是否指向对端 .dsh\\attachments（或含 objects 的中转目录）`);
        if ((c.failed ?? 0) > 0) {
          record.alerts.push({ level: 'alert', code: 'attach-fetch-failed', message: `A7b：${c.failed} 个附件对象取回失败（详见 attach-fetch.json）`.slice(0, 300) });
          record.deferred.push(`附件取回：${c.failed} 个对象失败`);
        }
      }
    }
  }

  // ---- P9 自举：本轮更新了交接器自身 ⇒ 用**新代码**重跑一次（卡 AT17 ① · 2026-09-16）------------
  // 为什么需要：A6/A6b 能把新版 `handoff.mjs` 写到磁盘，但**当前进程加载的还是旧代码** ⇒ 用户此刻
  //   仍看到旧行为（现场：A6 把新版送到了对端，她跑 `--adopt-apply` 仍报「未知参数」）。
  // 做法：写盘（含备份/恢复脚本/报告）完成后**释放交接锁** → spawn 一次**同一命令**的 arrive
  //   （env 标记防重入；第二轮追加 --skip-sessions/--skip-attach 免重复劳动），第一轮不写交接单
  //   （留给第二轮）⇒ 全程只落一份记录。异常一律 fail-open（只告警，不阻断；生产文件已更新）。
  // 边界：旧代码不认识自举 ⇒「还没有自举逻辑的版本 → 有自举的版本」这一跳仍需一次人工 arrive
  //   （但不再需要 --force —— 仓侧门死锁已修）。
  const SELF_BOOTSTRAP_KEYS = new Set([
    'ws:tools/dsh-butler/handoff.mjs',
    'ws:tools/dsh-butler/lib/handoff-adopt.mjs',
    'ws:tools/dsh-butler/lib/handoff-core.mjs',
  ]);
  const selfUpdated = plan.filter((p) => p.action === 'applied' && SELF_BOOTSTRAP_KEYS.has(p.key)).map((p) => p.key);
  if (selfUpdated.length && !o.noSelfReexec && !o.dryRun && !process.env.DSH_HANDOFF_SELF_REEXEC) {
    section('Arrive · 自举（本轮更新了交接器自身 → 用新代码重跑一次）');
    log(`    本轮写盘：${selfUpdated.join(' · ')}`);
    record.alerts.push({
      level: 'info', code: 'handoff-self-reexec',
      message: `本轮更新了交接器自身（${selfUpdated.join(', ')}）→ 用新代码自动重跑一轮 Arrive`.slice(0, 300),
    });
    // 重跑用的脚本路径：默认 = 用户这次调用的那个文件（process.argv[1]，保持 junction/别名原样）；
    // `DSH_HANDOFF_SELF_SCRIPT` 是**测试注入点**（夹具里指向沙箱生产的"新版"桩），生产绝不设。
    const selfPath = process.env.DSH_HANDOFF_SELF_SCRIPT || process.argv[1] || fileURLToPath(import.meta.url);
    const childArgs = [...process.argv.slice(2), '--skip-sessions', '--skip-attach'];
    try { ACTIVE_LOCK?.release?.(); } catch { /* release 幂等，忽略 */ }
    o.json = false;   // 第一轮不输出 JSON 块（避免与第二轮混在一起）
    // 把第一轮的审计痕迹落档并交给重跑那一轮：像「仓侧门放行」这类告警**只在这一轮成立**
    //   （第二轮该文件已是最新 ⇒ 判 unchanged），不并回去就等于审计断链。
    let carryFile = null;
    try {
      ensureDir(archiveDir);
      carryFile = path.join(archiveDir, 'arrive-round1.json');
      writeJsonAtomic(carryFile, {
        at: new Date().toISOString(), reason: 'self-reexec-round1', selfUpdated,
        alerts: record.alerts,
        appliedRound1: plan.filter((p) => p.action === 'applied').map((p) => ({ key: p.key, bytes: p.bytes ?? 0 })),
      }, {});
    } catch (e) { warn(`第一轮审计痕迹落档失败：${e?.message ?? e}（不影响重跑）`); }
    log(`    → 重跑：node ${selfPath} ${childArgs.join(' ')}`);
    const childEnv = { ...process.env, DSH_HANDOFF_SELF_REEXEC: '1' };
    if (carryFile) childEnv.DSH_HANDOFF_SELF_CARRY = carryFile;
    const rr = spawnSync(process.execPath, [selfPath, ...childArgs], { stdio: 'inherit', env: childEnv });
    const code = Number.isInteger(rr.status) ? rr.status : 1;
    if (rr.error) bad(`自举重跑未能启动：${rr.error.message}（生产文件已更新，手动再跑一次 Arrive 即可）`);
    else log(`    自举重跑结束：exit=${code}`);
    return code;
  }
  if (selfUpdated.length && !o.dryRun) {
    log(`    （交接器自身本轮被更新：${selfUpdated.join(' · ')}；按 --no-self-reexec 或防重入标记跳过自动重跑）`);
  }

  // A7 交接单
  for (const row of repoRows) {
    const dir = REPOS[row.name].dir;
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const h = repoHeads(dir);
    row.localHead = h.localHead;
    row.remoteHead = h.remoteHead;
    row.ahead = h.ahead;
    row.behind = h.behind;
    row.pushed = pulled[row.name] === true;
  }
  // AT17 自举重跑轮：把第一轮告警并回来（「仓侧门放行」这类只在第一轮成立的痕迹，否则审计断链）。
  const carryPath = process.env.DSH_HANDOFF_SELF_CARRY;
  if (carryPath) {
    try {
      const c = JSON.parse(fs.readFileSync(carryPath, 'utf8'));
      let merged = 0;
      for (const a of c?.alerts ?? []) {
        if (!a || typeof a.code !== 'string' || typeof a.message !== 'string') continue;
        if (record.alerts.some((x) => x.code === a.code && x.message === a.message)) continue;
        record.alerts.push(a); merged++;
      }
      if (merged) log(`    自举重跑：已并回第一轮告警 ${merged} 条`);
    } catch (e) {
      warn(`自举重跑：第一轮告警读取失败（${e?.message ?? e}）`);
    }
  }
  record.applied = core.toAppliedRows(plan, 'arrive-distribute');
  const failedRows = record.applied.filter((r) => r.status === 'failed').length;
  record.finishedAt = new Date().toISOString();
  fillHotAndClock(record);
  record.result = failedRows ? 'deferred' : 'ok';
  record.lastSuccessfulHandoffAt = record.finishedAt;   // 完整 Arrive 结束才更新（§5.3 第 6 条）
  // 数组长度上限护栏（schema maxItems）
  if (record.alerts.length > 500) record.alerts = record.alerts.slice(-500);
  try {
    writeLocalRecord(record);
    ok(`本机交接单已写：applied=${record.applied.length} 项，alerts=${record.alerts.length} 条`);
  } catch (e) {
    bad(`交接单写入失败：${e?.message ?? e}`);
    OUT.json = { role: 'arrive', result: 'failed', error: String(e?.message ?? e), planSummary: byAction };
    return 1;
  }
  appendAudit({ type: 'handoff', role: 'arrive', host, result: record.result, applied: record.applied.length, skipped: byAction['skipped-diverged'] ?? 0 });

  logGcResult(gcArchives({ dryRun: o.dryRun }));

  section(`Arrive 完成：result=${record.result}`);
  const skippedDiv = byAction['skipped-diverged'] ?? 0;
  const skippedUn = byAction['skipped-unrecorded'] ?? 0;
  if (skippedDiv) log(`    🔴 本机改动被保护：${skippedDiv} 个文件 skipped(diverged)（未覆盖；人工裁决后才可强制）`);
  if (skippedUn) log(`    🟡 无基线未覆盖：${skippedUn} 个文件 skipped(unrecorded)（可用 --adopt-unrecorded 人工确认后分发）`);
  log(`    完整交接 lastSuccessfulHandoffAt=${record.lastSuccessfulHandoffAt}`);
  OUT.json = { role: 'arrive', result: record.result, record, planSummary: byAction, plan, archiveDir: exec.backupEntries.length ? archiveDir : null };
  return record.result === 'ok' ? 0 : 3;
}

// ---------------------------------------------------------------- CLI

const USAGE = [
  'dsh-handoff —— P9 H1a 手动交接器（Depart 交出本机状态 / Arrive 接收对端状态）',
  '',
  '  node handoff.mjs --status [--json]',
  '  node handoff.mjs --depart --dry-run [--skip-sessions] [--json]',
  '  node handoff.mjs --depart [--skip-sessions] [--force]',
  '  node handoff.mjs --arrive --dry-run [--json]',
  '  node handoff.mjs --arrive [--skip-sessions] [--confirm-diverged] [--adopt-unrecorded] [--force]',
  '',
  '  --dry-run            只体检 + 打印计划，不写任何文件、不采集、不推送、不分发',
  '  --force              跳过"上次失败 / 双开嫌疑 / 版本门"的人工确认门（记审计）',
  '  --force-collect      人工裁决：超集体检不合格时仍继续采集 + 推（走 -ForcePush，必写审计流水）',
  '  --force-reason "..."  --force-collect 的理由（写进审计与交接单告警）',
  '  --confirm-diverged   人工确认：允许覆盖"本机在两次交接之间改过"的文件（默认跳过）',
  '  --adopt-unrecorded   人工确认：允许覆盖"无交接基线"的文件（默认跳过）',
  '  --adopt-apply         A6b 漏网文件分发：本**轮**真写生产（默认 report-only 只报告）',
  '  --adopt-report        A6b 漏网文件分发：本**轮**强制 report-only（覆盖持久开关）',
  '  --adopt-since <sha>   A6b 的 diff 起点（本**轮**生效、**绝不写回锚**）：补扫历史积压用',
  '  --adopt-advance-anchor  本轮结束后强制把分发锚推进到 HEAD（默认只在 apply 且无跳过项时推进）',
  '  --skip-adopt          本次 Arrive 跳过 A6b 漏网文件分发段（排障用）',
  '  --strict-repo-drift   仓侧门回到旧判据（仓未前进 + 仓侧 sha ≠ 基线 ⇒ 一律拦；排障/回归对照用）',
  '  --no-self-reexec      本轮若更新了交接器自身，**不**用新代码自动重跑（排障用）',
  '  --skip-attach         本次 Arrive 跳过 A7 附件差额报告段（只读对账，排障/提速用）',
  '  --attach-fetch-from <path>',
  '                        A7b：把「本机缺的图片附件对象」从该路径取回（对端 .dsh\\attachments，',
  '                        或含 objects/ 的中转目录），逐个校验 sha256；源里没有的会明确列出',
  '                        （附件不进仓 ⇒ 跨机不会自动带过来，缺附件时含图会话续聊必报 TRANSPORT）',
  '  --attach-export <dir>',
  '                        Depart ②d：把「本机被引用的图片附件对象」导出成中转包到该目录',
  '                        （<dir>/objects/<2>/<sha> + manifest.json；**默认关**）。插到对端后即',
  '                        --arrive --attach-fetch-from <该目录> 取回；dry-run 只统计不写盘',
  '  --skip-sessions      Depart/Arrive 跳过仓2（含 Arrive 的 A5 会话落地；会话量大时用）',
  '  --with-sessions      反向覆盖「Depart 默认跳过仓2」（2026-09-23 仓2 停冷采口径；救援/手工用）',
  '  --skip-board-snapshot  Depart 跳过看板快照导出（②c；默认导出，产物随仓3 过河）',
  '  --json               stdout 只输出 JSON（末尾追加）',
].join('\n');

function parseArgs(argv) {
  const o = {
    mode: null, dryRun: false, json: false, force: false, forceCollect: false, forceReason: '',
    confirmDiverged: false, adoptUnrecorded: false, skipSessions: false, withSessions: false, help: false, unknown: null,
    lockWaitMs: null, skipBoardSnapshot: false,
    // A6b 漏网文件分发（卡 AT12）：adoptMode = 单轮覆盖（'apply'|'report'|null=跟随持久开关）
    adoptMode: null, skipAdopt: false,
    // AT17（2026-09-16）：分发锚 / 仓侧门 / 自举
    adoptSince: null, adoptAdvanceAnchor: false, strictRepoDrift: false, noSelfReexec: false,
    // A7 附件差额（卡 AT1）：skipAttach = 跳过只读对账；attachFetchFrom = 本轮取回源路径
    // attachExport（2026-10-10 · 缺口 C4）= Depart ②d 导出中转包的落点目录；默认关（null = 不走）
    skipAttach: false, attachFetchFrom: null, attachExport: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--depart') o.mode = 'depart';
    else if (a === '--arrive') o.mode = 'arrive';
    else if (a === '--status') o.mode = 'status';
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--force') o.force = true;
    else if (a === '--force-collect') o.forceCollect = true;
    else if (a === '--force-reason') o.forceReason = argv[++i] ?? '';
    else if (a === '--confirm-diverged') o.confirmDiverged = true;
    else if (a === '--adopt-unrecorded') o.adoptUnrecorded = true;
    else if (a === '--adopt-apply') o.adoptMode = 'apply';
    else if (a === '--adopt-report') o.adoptMode = 'report';
    else if (a === '--skip-adopt') o.skipAdopt = true;
    else if (a === '--adopt-since') o.adoptSince = argv[++i] ?? null;
    else if (a === '--adopt-advance-anchor') o.adoptAdvanceAnchor = true;
    else if (a === '--strict-repo-drift') o.strictRepoDrift = true;
    else if (a === '--no-self-reexec') o.noSelfReexec = true;
    else if (a === '--skip-attach') o.skipAttach = true;
    else if (a === '--attach-fetch-from') o.attachFetchFrom = argv[++i] ?? null;
    else if (a === '--attach-export') o.attachExport = argv[++i] ?? null;
    else if (a === '--skip-sessions') o.skipSessions = true;
    else if (a === '--with-sessions') o.withSessions = true;
    else if (a === '--skip-board-snapshot') o.skipBoardSnapshot = true;
    else if (a === '--lock-wait-ms') o.lockWaitMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else o.unknown = a;
  }
  // 【2026-09-23 拍板 · 仓2 停冷采】仓2（dsh-sessions）已越 Gitee **单仓**硬配额
  //   （实测 `.git` = 1043.7 MiB = 101.9%）⇒ **Depart 流程默认跳过仓2**（采集 / 推送 / 拉取都不做）。
  //   · **Arrive 流程不受影响**：接机仍会 pull 仓2 + 走 A5 会话落地，救命链在只读侧保留。
  //   · 反向覆盖：显式加 `--with-sessions` 即恢复原行为（救援 / 手工核对用）。
  //   · 只读检查（体积 / HEAD，见 L688/L715 附近）不走 repoOrder ⇒ 仓2 的体积告警仍然可见。
  //   · 真源：内部方案档（2026-09-23 15:47 拍板）。
  if (o.mode === 'depart' && !o.withSessions) o.skipSessions = true;
  return o;
}

export function run(argv = process.argv.slice(2), io = { log }) {
  const o = parseArgs(argv);
  if (o.help || (!o.mode && !o.unknown)) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (o.unknown) {
    process.stderr.write(`❌ 未知参数：${o.unknown}\n\n${USAGE}\n`);
    return 2;
  }
  if (o.mode === 'status' && o.dryRun) {
    process.stderr.write('❌ --status 与 --dry-run 不能同时用\n');
    return 2;
  }

  // S1b 接线（v2 §5.4-②）：Depart 前做一次「统一开关 ↔ 本轮 skipSessions」一致性检查（只打印，不改行为）
  try { checkRepo2Topology(o); } catch (e) { log(`    [topology] 检查失败（不影响交接）：${String(e?.message ?? e).slice(0, 120)}`); }

  // 交接单例互斥（§5.3 第 6 条：Arrive/Depart 不许并发）
  //   **drain 语义（H1b）**：关机钩 Depart / 开机钩 Arrive 撞上正在跑的热采 tick 时
  //   **等它结束**（上限 = 剩余预算），而不是立刻失败 —— 否则"热采恰好在这一秒跑"就让交接整轮落空。
  //   tick 类触发（热采自己、tickd 的 hot job）**保持 waitMs=0**：抢不到就跳过本轮，绝不排队。
  let lock = null;
  if (o.mode !== 'status') {
    const drainWaitMs = Number.isFinite(o.lockWaitMs) ? o.lockWaitMs : (o.mode === 'hot' ? 0 : 120_000);
    if (drainWaitMs > 0) log(`  （交接单例锁：抢不到将最多等 ${Math.round(drainWaitMs / 1000)}s，等正在跑的热采 tick 结束）`);
    lock = acquireTickLock('handoff', { ttlMs: 60 * 60 * 1000, waitMs: drainWaitMs });
    if (!lock.ok) {
      process.stderr.write(`❌ 已有交接在进行中（${lock.reason}），等它结束再跑\n`);
      OUT.json = { blocked: true, reason: lock.reason, holder: lock.holder ?? null };
      if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify(OUT.json, null, 2) + '\n');
      return 3;
    }
    if (lock.waited) log(`  （等待了 ${Math.round((lock.waitedMs ?? 0) / 1000)}s 后拿到交接锁 —— 上一轮交接已结束）`);
    ACTIVE_LOCK = lock;   // AT17：自举重入前用它显式释放
  }
  try {
    let code = 0;
    if (o.mode === 'status') code = cmdStatus(o);
    else if (o.mode === 'depart') code = cmdDepart(o);
    else if (o.mode === 'arrive') code = cmdArrive(o);
    if (o.json && OUT.json) process.stdout.write('\n---JSON---\n' + JSON.stringify(OUT.json, null, 2) + '\n');
    else if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify({ mode: o.mode, lines: OUT.lines }, null, 2) + '\n');
    return code;
  } finally {
    if (lock && typeof lock.release === 'function') lock.release();
    ACTIVE_LOCK = null;
  }
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  try {
    process.exit(run());
  } catch (e) {
    process.stderr.write(`\n❌ 交接器异常：${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
