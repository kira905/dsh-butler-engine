#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dsh-butler / butler-memory-vectors-tick.mjs —— 记忆引擎 v2 · S2c「向量同步调度形态」
//
// 方案依据：`docs\P2-记忆引擎升级-方案-20260916.md`
//   · §3.1 编码通道契约「谁起」：桥由 **tickd job `memory-vectors` 幂等启动**（已在跑则跳过）
//   · §3.1 同步策略：每小时增量同步（`cli/sync.mjs`）+ **每周兜底 hash 段轮转**（`cli/sweep.mjs`，按 id 段）
//   · §3.5 第 5 条：源码 JOBS **不写死 `enabled:false`**；默认关的唯一权威层 = `butler-autonomy.json` 的 jobs 段
//   · §4 宿主迁移契约：**不引入与机器绑定的路径常量** ⇒ 库路径全部参数化
//       （`--memory-db` / `--vectors-db` / `--model-dir` / `--home`，或 `MEMORY_ENGINE_*` 环境变量）
//
// 本 job 做三件事（顺序即语义）：
//   ⓪ **宿主闸（fail-closed）**：本机主机名不在**显式声明的宿主**里 ⇒ **让路**（exit 3，什么都不干）
//        —— 一期宿主 = HOST_B 单机自持；**未声明任何宿主时一律让路**（宁可不动，不瞎跑）。
//        声明方式：`--allow-host <name[,name...]>` 或环境变量 `MEMORY_ENGINE_VECTORS_HOST`（`,` 分隔，支持 `*`）。
//        ⚠️ 这道闸是 2026-09-21 补件加的：原先只按"记忆库存在与否"判宿主，
//        而 HOST_A 也有生产 `memory.db` ⇒ 在 HOST_A 放行会真跑一轮全量、并在 HOST_A 建向量库（实测 626 条 / 102s）。
//   ① **库存在性闸**：目标记忆库不存在 / 不可读 ⇒ **安全跳过**（exit 3，让路语义）
//        —— 不启动桥、不建向量库、不建任何目录，只在自己 state 里记一行。
//   ② 幂等启动编码桥（`cli/serve-start.mjs`：先探活，在跑就跳过）—— 失败**不阻断同步**（记一行）
//   ③ 增量同步（每小时）+ 兜底 sweep（每周 1 段，ISO 周判据）
//
// 退出码：0 = 正常 / 3 = **安全跳过（让路）**（JOBS 里已声明 `benignExitCodes:[3]` ⇒ 不计 failures）
//         1 = 真失败（引擎目录缺失 / 同步自己报错）/ 2 = 用法错
//
// 【V3 功能面 · 起服召回空窗（2026-10-22）】新增 `--bridge-only` = **只保桥**模式：
//   过了两道闸（宿主 / 引擎 / 记忆库）后只跑 ②幂等起桥，然后立刻收工 ——
//   **不跑同步 / 不跑 sweep / 不跑坑源钩子 / 不写 tick 状态**（runs 与 lastRunAt 一律不动）。
//   为什么单独加一个开关而不是复用 `--dry-run`：`--dry-run` 会写一条 `status='dry-run'` 的状态记录
//   （污染每小时 job 的历史），且它的语义是"演练"，将来任何人把它收紧成"零副作用"时，
//   起服补桥就会**静默失效** —— 起服补桥需要的是自己的、写死语义的入口。
//
// 用法：
//   node butler-memory-vectors-tick.mjs [--memory-db P] [--vectors-db P] [--model-dir P]
//        [--home D] [--engine-dir P] [--port-file P] [--state-file P] [--allow-host H[,H...]]
//        [--no-bridge] [--bridge-only] [--skip-sweep] [--force-sweep] [--dry-run] [--json] [--help]
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStateText } from '../src/dsh-butler/lib/dual-write.mjs';
// 【R-065 三件套 · 锁6-E1（2026-10-19）】删除 / 搬移唯一口：dry-run 第一道门 + reparse 拒删 + 白名单拒跑。
//   共享闸 = 动态 import（可选依赖）：本文件在 tools 目录损坏时也要能跑；加载失败 ⇒ 拒动作（fail-closed），绝不裸删。
const PG_DESTRUCTIVE = await import('../src/lib/production-guard.mjs').catch(() => null);
function guardedDestructive({ targets, whitelist, op = '删', reason, dryRun = false, action }) {
  const list = targets.map((t) => (typeof t === 'string' ? { path: t, label: reason } : t));
  if (dryRun === true) { try { console.log('[plan] ' + op + ' ' + list.map((t) => t.path).join(' ; ')); } catch {} return false; }
  if (!PG_DESTRUCTIVE) throw new Error('R-065 闸不可用（production-guard.mjs 加载失败）⇒ 拒绝' + op);
  const g = PG_DESTRUCTIVE.gateDestructive({
    targets: list, whitelist, op, scope: ['file'], requires: ['file'], dryRun: false,
    allowProduction: true, allowReparse: false, ledgerBypass: false, reason,
  });
  if (!g.ok) throw new Error('R-065 拒' + op + '（' + (g.code ?? 'blocked') + '）：' + String(g.reason).split('\n')[0]);
  if (typeof action === 'function') action();
  return true;
}

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';

// 0.1.3（2026-10-22 · V3 功能面「起服召回空窗」）：新增 `--bridge-only`（只保桥、不写 state）。
export const MEMORY_VECTORS_TICK_VERSION = '0.1.3';

const HERE = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try { return fs.realpathSync(here); } catch { return path.resolve(here); }
})();

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, DEFER: 3 };
const STATE_SCHEMA = 1;
const HISTORY_MAX = 20;
const SYNC_TIMEOUT_MS = 20 * 60 * 1000;   // 首次全量编码 570 条实测 42s；给足余量
const SWEEP_TIMEOUT_MS = 10 * 60 * 1000;
const BRIDGE_WAIT_MS = 30_000;
const PITFALL_HOOK_TIMEOUT_MS = 5 * 60 * 1000;   // 坑源增量（229 条实测 ~2s）；给足余量
/** 坑源脏标记消费的**放行闸位**（`butler-autonomy.json#modules[...]`；缺键 = 关 = 与接线前行为逐字等价） */
export const PITFALL_HOOK_MODULE = 'pitfall-vector-hook';

// ---------------------------------------------------------------- 参数

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[body] = next; i += 1; continue; }
    flags[body] = true;
  }
  return flags;
}

// ---------------------------------------------------------------- 宿主闸（fail-closed）

/** 本机主机名（小写；取不到就返回空串 ⇒ 一律不让路成立，宁可不动）。 */
export function currentHostname() {
  try { return String(os.hostname() || '').trim().toLowerCase(); } catch { return ''; }
}

/** 允许宿主列表：`--allow-host`（逗号分隔）> 环境变量 `MEMORY_ENGINE_VECTORS_HOST` > 空（= 谁都不放行）。 */
export function resolveAllowedHosts(flags = {}, env = process.env) {
  const raw = flags['allow-host'] !== undefined && flags['allow-host'] !== true
    ? flags['allow-host']
    : env.MEMORY_ENGINE_VECTORS_HOST;
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 本机是否被显式声明为宿主（`*` = 任意主机，仅供本地实测/沙箱用）。 */
export function isHostAllowed({ allowed = [], hostname = currentHostname() } = {}) {
  if (!allowed.length) return false;
  if (allowed.includes('*')) return true;
  if (!hostname) return false;
  return allowed.includes(hostname);
}

/** ISO 周键（每周兜底 sweep 的判据；跨年周号用 ISO 口径，避免 12/31 与 1/1 同周被判成两周）。 */
export function isoWeekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 解析路径（显式参数 > 环境变量 > 默认；**默认值全部经 dshHome()，不写死本机盘符**）。 */
export function resolvePaths(flags = {}, env = process.env) {
  const home = flags.home ? path.resolve(String(flags.home)) : dshHome();
  const engineDir = path.resolve(String(
    flags['engine-dir'] || env.DSH_MEMORY_ENGINE_DIR || path.join(HERE, '..', 'memory-engine'),
  ));
  const vectorsDir = path.resolve(String(
    flags['vectors-dir'] || env.MEMORY_ENGINE_VECTORS_DIR || path.join(home, 'memory-vectors'),
  ));
  return {
    home,
    engineDir,
    memoryDb: path.resolve(String(flags['memory-db'] || env.MEMORY_ENGINE_MEMORY_DB || path.join(home, 'memory', 'memory.db'))),
    vectorsDb: path.resolve(String(flags['vectors-db'] || env.MEMORY_ENGINE_VECTORS_DB || path.join(vectorsDir, 'vectors.db'))),
    vectorsDir,
    modelDir: flags['model-dir'] || env.MEMORY_ENGINE_MODEL_DIR || null,
    portFile: flags['port-file'] ? path.resolve(String(flags['port-file'])) : path.join(vectorsDir, 'bridge-port.json'),
    bridgeLog: path.join(vectorsDir, 'bridge.log'),
    stateFile: flags['state-file'] ? path.resolve(String(flags['state-file'])) : resolveStatePath('butler-memory-vectors-state.json', { home }).path,
    syncScript: path.join(engineDir, 'cli', 'sync.mjs'),
    sweepScript: path.join(engineDir, 'cli', 'sweep.mjs'),
    serveStartScript: path.join(engineDir, 'cli', 'serve-start.mjs'),
  };
}

// ---------------------------------------------------------------- state

export function readState(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;   // 缺失/损坏一律当"首次运行"（state 是可重建载体）
  }
}

export function writeState(file, obj) {
  try {
    const dw = writeStateText(path.basename(file), JSON.stringify(obj, null, 2) + '\n', {
      home: path.dirname(file),
      write: (p, t) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = `${p}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, t, 'utf8');
        guardedDestructive({ targets: [{ path: tmp, label: 'vectors state tmp' }, { path: p, label: 'vectors state' }], whitelist: [path.dirname(p)], op: '搬移', reason: 'memory-vectors: write state atomically', action: () => fs.renameSync(tmp, p) });
      },
    });
    return dw.ok;
  } catch {
    return false;
  }
}

function pushHistory(prev, entry) {
  const hist = Array.isArray(prev?.history) ? prev.history.slice(-(HISTORY_MAX - 3)) : [];
  hist.push(entry);
  while (hist.length > HISTORY_MAX) hist.shift();
  return hist;
}

// ---------------------------------------------------------------- 子步骤

/** ② 幂等启动桥（子进程调用；失败只记一行，**不阻断同步**）。 */
export function ensureBridge({ paths, flags, log, env = process.env }) {
  if (flags['no-bridge']) return { skipped: true, reason: '--no-bridge', ok: false, started: false, port: null };
  if (!fs.existsSync(paths.serveStartScript)) {
    return { skipped: true, reason: `serve-start.mjs 不存在：${paths.serveStartScript}`, ok: false, started: false, port: null };
  }
  const args = [paths.serveStartScript, '--json', '--port-file', paths.portFile, '--log', paths.bridgeLog,
    '--wait-ms', String(BRIDGE_WAIT_MS)];
  if (flags.port) args.push('--port', String(flags.port));
  if (paths.modelDir) args.push('--model-dir', paths.modelDir);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: BRIDGE_WAIT_MS + 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    env: { ...env, DSH_HOME: paths.home },
  });
  if (r.error) return { ok: false, started: false, port: null, error: `spawn 失败：${r.error.message}` };
  let body = null;
  try { body = JSON.parse(String(r.stdout || '').trim()); } catch { /* 非 JSON：下面按退出码判 */ }
  if (body) {
    return {
      ok: body.ok === true, started: body.started === true, port: body.port ?? null,
      pid: body.pid ?? null, ready: body.ready === true,
      error: body.error ?? null, exitCode: r.status,
    };
  }
  return { ok: r.status === 0, started: false, port: null, exitCode: r.status,
    error: `非 JSON 输出（exit ${r.status}）：${String(r.stdout || r.stderr || '').slice(0, 200)}` };
}

/**
 * ④b 的**放行闸**（fail-safe = 关）—— 方案 §A.2 第 10 行「消费方亦可由 `memory-vectors` job 定时扫」的开关面。
 *   载体 = `~/.dsh/butler-autonomy.json` 的 `modules['pitfall-vector-hook']`（与 `memory-recall` 同一种闸位）。
 *   缺文件 / 缺键 / `enabled !== true` ⇒ **判关**（本步不跑 = 与接线前行为逐字等价）。
 *   放行 / 关回 = `node tools\dsh-butler\butler-autonomy-cli.mjs module on|off pitfall-vector-hook --why "…"`。
 */
export function readPitfallHookGate(home, { readFileSync = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const file = resolveStatePath('butler-autonomy.json', { home }).path;
  let obj = null;
  try { obj = JSON.parse(readFileSync(file)); } catch { return { enabled: false, reason: 'autonomy-unreadable', file }; }
  const m = obj && obj.modules ? obj.modules[PITFALL_HOOK_MODULE] : null;
  if (!m) return { enabled: false, reason: 'module-unset', file };
  return m.enabled === true
    ? { enabled: true, reason: 'module-on', file, why: m.why ?? null }
    : { enabled: false, reason: 'module-off', file, why: m.why ?? null };
}

/**
 * ④b 坑源脏标记消费（方案 §A.2 第 10 行 · **默认关**）。
 *   形态 = 子进程调 `cli/pitfall-hook.mjs --run --apply`（脚本自带「有标记才跑 / 成功才清标记 / 失败保留标记」语义，
 *   且带坑源守卫）。本步**不阻断主链**：失败只记日志一行 + state 摘要，不改 `sync.ok` 的成败判定。
 */
export function runPitfallHookStep({ paths, log, env = process.env }) {
  const script = path.join(paths.engineDir, 'cli', 'pitfall-hook.mjs');
  if (!fs.existsSync(script)) return { ok: false, skipped: 'no-script', error: `pitfall-hook.mjs 不存在：${script}` };
  const args = [script, '--run', '--apply', '--json', '--dsh-home', paths.home, '--vectors-db', paths.vectorsDb];
  if (paths.modelDir) args.push('--model-dir', paths.modelDir);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: PITFALL_HOOK_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...env, DSH_HOME: paths.home },
  });
  if (r.error) return { ok: false, exitCode: -1, error: `spawn 失败：${r.error.message}` };
  let body = null;
  try { body = JSON.parse(String(r.stdout || '').trim()); } catch { /* 解析失败走 error 分支 */ }
  if (!body) return { ok: false, exitCode: r.status, error: `pitfall-hook 输出非 JSON（exit ${r.status}）`, stderr: String(r.stderr || '').slice(-400) };
  const hook = body.hook ?? null;
  return {
    ok: body.ok === true && (hook ? hook.ok !== false : true),
    exitCode: r.status,
    skipped: hook?.skipped ?? null,
    scanned: hook?.stats?.scanned ?? null,
    encoded: hook?.stats?.encoded ?? null,
    vectorsBefore: hook?.stats?.vectorsBefore ?? null,
    vectorsAfter: hook?.stats?.vectorsAfter ?? null,
    elapsedMs: hook?.stats?.elapsedMs ?? null,
    cleared: hook?.cleared?.cleared ?? null,
    counts: body.countsAfter ?? body.counts ?? null,
    error: body.error ?? null,
  };
}

/** ③a 增量同步（子进程调用 `cli/sync.mjs`）。 */
export function runSync({ paths, flags, log, dryRun, env = process.env }) {
  const args = [paths.syncScript, '--json', '--memory-db', paths.memoryDb, '--vectors-db', paths.vectorsDb];
  if (paths.modelDir) args.push('--model-dir', paths.modelDir);
  if (dryRun) args.push('--dry-run');
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: SYNC_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    env: { ...env, DSH_HOME: paths.home },
  });
  if (r.error) return { ok: false, exitCode: -1, error: `spawn 失败：${r.error.message}`, stderr: '' };
  let body = null;
  try { body = JSON.parse(String(r.stdout || '').trim()); } catch { /* 解析失败走 error 分支 */ }
  if (!body) {
    return { ok: false, exitCode: r.status, error: `sync 输出非 JSON（exit ${r.status}）`, stderr: String(r.stderr || '').slice(-800) };
  }
  return {
    ok: body.ok === true, exitCode: r.status,
    mode: body.mode ?? null, reasons: body.reasons ?? [],
    scanned: body.scanned ?? null, encoded: body.encoded ?? null, skippedSameHash: body.skippedSameHash ?? null,
    vectorsBefore: body.vectorsBefore ?? null, vectorsAfter: body.vectorsAfter ?? null,
    watermarkStart: body.watermarkStart ?? null, watermarkEnd: body.watermarkEnd ?? null,
    elapsedMs: body.elapsedMs ?? null, error: body.error ?? null,
  };
}

/** ③b 兜底 hash 段轮转（每周 1 段；`--force-sweep` / `--skip-sweep` 可覆盖）。 */
export function runSweep({ paths, flags, log, dryRun, env = process.env }) {
  const args = [paths.sweepScript, '--json', '--memory-db', paths.memoryDb, '--vectors-db', paths.vectorsDb, '--rounds', '1'];
  if (paths.modelDir) args.push('--model-dir', paths.modelDir);
  if (dryRun) args.push('--dry-run');
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: SWEEP_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...env, DSH_HOME: paths.home },
  });
  if (r.error) return { ok: false, exitCode: -1, error: `spawn 失败：${r.error.message}` };
  let body = null;
  try { body = JSON.parse(String(r.stdout || '').trim()); } catch { /* 解析失败走 error 分支 */ }
  if (!body) return { ok: false, exitCode: r.status, error: `sweep 输出非 JSON（exit ${r.status}）`, stderr: String(r.stderr || '').slice(-800) };
  return {
    ok: body.ok === true, exitCode: r.status, range: body.range ?? null,
    cursorStart: body.cursorStart ?? null, cursorEnd: body.cursorEnd ?? null,
    scanned: body.scanned ?? null, fixed: body.fixed ?? null, missing: body.missing ?? null,
    mismatched: body.mismatched ?? null, completedFullSweep: body.completedFullSweep === true,
    elapsedMs: body.elapsedMs ?? null, error: body.error ?? null,
  };
}

// ---------------------------------------------------------------- 主流程

/**
 * 跑一轮（纯编排；所有外部依赖可注入 ⇒ 单测零副作用）。
 * @returns {Promise<{ok:boolean, exitCode:number, status:string, state:object, lines:string[]}>}
 */
export async function runOnce({ flags = {}, env = process.env, now = () => Date.now(),
  deps = {} } = {}) {
  const paths = resolvePaths(flags, env);
  const lines = [];
  const log = (m) => lines.push(String(m));
  const dryRun = Boolean(flags['dry-run']);
  const readStateFn = deps.readState ?? readState;
  const writeStateFn = deps.writeState ?? writeState;
  const ensureBridgeFn = deps.ensureBridge ?? ensureBridge;
  const runSyncFn = deps.runSync ?? runSync;
  const runSweepFn = deps.runSweep ?? runSweep;
  const runPitfallHookFn = deps.runPitfallHook ?? runPitfallHookStep;
  const gateFn = deps.readPitfallHookGate ?? readPitfallHookGate;
  const existsFn = deps.existsSync ?? ((p) => fs.existsSync(p));

  const prev = readStateFn(paths.stateFile) ?? {};
  const base = {
    ...prev,
    schemaVersion: STATE_SCHEMA,
    engineDir: paths.engineDir,
    memoryDb: paths.memoryDb,
    vectorsDb: paths.vectorsDb,
    runs: (prev.runs ?? 0) + 1,
  };

  const finish = (status, extra = {}) => {
    const state = { ...base, lastRunAt: new Date(now()).toISOString(), lastStatus: status, ...extra };
    state.history = pushHistory(prev, { at: state.lastRunAt, status, detail: extra.detail ?? null });
    writeStateFn(paths.stateFile, state);
    return { state, lines };
  };

  // ⓪ 宿主闸（fail-closed）——**未显式声明本机为宿主 ⇒ 让路**（什么都不做）
  const allowedHosts = resolveAllowedHosts(flags, env);
  const hostname = deps.hostname ?? currentHostname();
  if (!isHostAllowed({ allowed: allowedHosts, hostname })) {
    const visibleHost = hostname || 'unknown';
    log(`[memory-vectors] 让路：本机 ${visibleHost} 未被声明为宿主`
      + `（allow-host=${allowedHosts.length ? allowedHosts.join(',') : '（未声明）'}）⇒ 安全跳过`
      + '（不启动桥 / 不建向量库 / 不建任何目录）；声明方式 --allow-host <本机名> 或 MEMORY_ENGINE_VECTORS_HOST');
    const { state } = finish('skipped-host-not-allowed', {
      host: visibleHost,
      allowedHosts,
      skips: (prev.skips ?? 0) + 1,
      lastSkipReason: `host-not-allowed:${visibleHost}`,
      detail: 'host-not-allowed',
    });
    return { ok: true, exitCode: EXIT.DEFER, status: 'skipped-host-not-allowed', state, lines };
  }
  base.host = hostname;
  base.allowedHosts = allowedHosts;

  // ① 引擎目录闸
  if (!existsFn(paths.syncScript)) {
    log(`[memory-vectors] 让路：引擎入口不存在 ${paths.syncScript}（--engine-dir 未指向本机引擎）⇒ 不启动桥、不建库`);
    const { state } = finish('skipped-no-engine', {
      skips: (prev.skips ?? 0) + 1,
      lastSkipReason: `engine-missing:${paths.engineDir}`,
      detail: 'engine-missing',
    });
    return { ok: true, exitCode: EXIT.DEFER, status: 'skipped-no-engine', state, lines };
  }

  // ② 记忆库闸 —— **本卡的核心安全语义**：库不存在 = 这台机不是宿主 ⇒ 什么都不做
  if (!existsFn(paths.memoryDb)) {
    log(`[memory-vectors] 让路：记忆库不存在 ${paths.memoryDb} ⇒ 安全跳过（不启动桥 / 不建向量库 / 不建任何目录）`);
    const { state } = finish('skipped-missing-db', {
      skips: (prev.skips ?? 0) + 1,
      lastSkipReason: `missing-memory-db:${paths.memoryDb}`,
      detail: 'missing-memory-db',
    });
    return { ok: true, exitCode: EXIT.DEFER, status: 'skipped-missing-db', state, lines };
  }

  // ③ 幂等启动桥（失败不阻断：同步用进程内编码器，桥是召回侧通道）
  const bridge = ensureBridgeFn({ paths, flags, log, env });
  if (bridge.ok) {
    log(`[memory-vectors] 编码桥 OK：port=${bridge.port} pid=${bridge.pid ?? '?'} ${bridge.started ? '（本轮拉起）' : '（已在跑，跳过）'}`);
  } else {
    log(`[memory-vectors] ⚠️ 编码桥未就绪：${bridge.error ?? bridge.reason ?? 'unknown'}（不阻断同步，调用方 fail-open）`);
  }

  // ③b 只保桥模式（**起服补跑入口** · V3 功能面 2026-10-22）：
  //     **只**起桥 —— 不跑同步 / sweep / 坑源钩子，且**不写 tick 状态**（runs / lastRunAt 一律不动，
  //     免得把每小时 job 的节奏与历史搅浑，也避免与正在跑的那一轮并发写同一份 state）。
  //     ⚠️ 必须在本轮任何 state 写入**之前**返回：此处 `base` 只是内存对象，尚未落盘。
  if (flags['bridge-only']) {
    const bridgeOnlyOk = bridge.ok === true;
    log(`[memory-vectors] --bridge-only：${bridgeOnlyOk ? '桥就绪' : '桥未就绪'}`
      + `（不跑同步/轮转/坑源钩子，不写 tick 状态）`);
    return {
      ok: bridgeOnlyOk,
      exitCode: bridgeOnlyOk ? EXIT.OK : EXIT.FAIL,
      status: bridgeOnlyOk ? 'bridge-only' : 'bridge-only-failed',
      state: null, lines,
      bridge: {
        ok: bridgeOnlyOk, started: bridge.started === true, port: bridge.port ?? null,
        pid: bridge.pid ?? null, ready: bridge.ready ?? null,
        error: bridge.error ?? bridge.reason ?? null,
      },
    };
  }

  if (dryRun) {
    log('[memory-vectors] --dry-run：只探库与探桥，不跑同步/轮转');
    const { state } = finish('dry-run', { lastBridge: bridge, lastError: null, detail: 'dry-run' });
    return { ok: true, exitCode: EXIT.OK, status: 'dry-run', state, lines };
  }

  // ④ 增量同步（每小时）
  const sync = runSyncFn({ paths, flags, log, dryRun: false, env });
  const syncBrief = { ok: sync.ok, mode: sync.mode, scanned: sync.scanned, encoded: sync.encoded,
    vectorsBefore: sync.vectorsBefore, vectorsAfter: sync.vectorsAfter, elapsedMs: sync.elapsedMs, error: sync.error ?? null };
  if (sync.ok) {
    log(`[memory-vectors] 增量同步 OK：${sync.mode} 扫描 ${sync.scanned} / 编码 ${sync.encoded}`
      + ` · 向量 ${sync.vectorsBefore}→${sync.vectorsAfter} · ${sync.elapsedMs}ms`);
  } else {
    log(`[memory-vectors] ❌ 增量同步失败（exit ${sync.exitCode}）：${sync.error ?? 'unknown'}${sync.stderr ? ` | ${String(sync.stderr).slice(-300)}` : ''}`);
  }

  // ④b 坑源脏标记消费（方案 §A.2 第 10 行；**默认关** ⇒ 接线本身零行为变更）
  const gate = gateFn(paths.home);
  let pitfallHook = null;
  let pitfallHookGate = { enabled: gate.enabled, reason: gate.reason };
  if (!gate.enabled) {
    log(`[memory-vectors] 坑源脏标记消费：闸关（${gate.reason}）⇒ 跳过（= 接线前行为）`);
  } else if (flags['no-pitfall-hook']) {
    pitfallHookGate = { ...pitfallHookGate, skipped: '--no-pitfall-hook' };
    log('[memory-vectors] 坑源脏标记消费：--no-pitfall-hook ⇒ 跳过');
  } else {
    pitfallHook = runPitfallHookFn({ paths, log, env });
    if (pitfallHook.skipped === 'no-marker') log('[memory-vectors] 坑源脏标记消费：无标记 ⇒ 跳过（坑库无变更）');
    else if (pitfallHook.ok) log(`[memory-vectors] 坑源脏标记消费 OK：扫 ${pitfallHook.scanned} / 编码 ${pitfallHook.encoded}`
      + ` · 向量 ${pitfallHook.vectorsBefore}→${pitfallHook.vectorsAfter} · 清标记=${pitfallHook.cleared} · ${pitfallHook.elapsedMs}ms`);
    else log(`[memory-vectors] ⚠️ 坑源脏标记消费未成功（**不阻断主链**）：${pitfallHook.error ?? pitfallHook.skipped ?? 'unknown'}`);
  }
  const pitfallHookBrief = pitfallHook ? { ...pitfallHook, at: new Date(now()).toISOString() } : (prev.lastPitfallHook ?? null);

  // ⑤ 兜底 sweep（每周 1 段）
  const week = isoWeekKey(new Date(now()));
  const lastWeek = prev.lastSweep?.week ?? null;
  const sweepDue = flags['skip-sweep'] ? false : (Boolean(flags['force-sweep']) || lastWeek !== week);
  let sweep = null;
  if (sweepDue) {
    sweep = runSweepFn({ paths, flags, log, dryRun: false, env });
    if (sweep.ok) {
      log(`[memory-vectors] 兜底轮转（周 ${week}）OK：段 ${sweep.range?.lo}-${sweep.range?.hi}`
        + ` · 游标 ${sweep.cursorStart}→${sweep.cursorEnd} · 扫描 ${sweep.scanned} / 重编码 ${sweep.fixed}`
        + ` · 一轮覆盖=${sweep.completedFullSweep ? '是' : '否'} · ${sweep.elapsedMs}ms`);
    } else {
      log(`[memory-vectors] ❌ 兜底轮转失败（exit ${sweep.exitCode}）：${sweep.error ?? 'unknown'}`);
    }
  } else {
    log(`[memory-vectors] 兜底轮转：本周（${week}）已跑过（上次 ${lastWeek}）⇒ 跳过`);
  }

  const sweepBrief = sweep ? { week, ok: sweep.ok, scanned: sweep.scanned, fixed: sweep.fixed,
    cursorEnd: sweep.cursorEnd, completedFullSweep: sweep.completedFullSweep, elapsedMs: sweep.elapsedMs,
    error: sweep.error ?? null } : (prev.lastSweep ?? null);

  const ok = sync.ok && (sweep ? sweep.ok : true);
  const { state } = finish(ok ? 'ok' : 'failed', {
    lastBridge: bridge,
    lastSync: syncBrief,
    lastSweep: sweepBrief,
    lastPitfallHook: pitfallHookBrief,
    pitfallHookGate,
    failures: (prev.failures ?? 0) + (ok ? 0 : 1),
    lastError: ok ? null : (sync.error ?? sweep?.error ?? 'unknown'),
    detail: ok ? 'ok' : 'failed',
  });
  return { ok, exitCode: ok ? EXIT.OK : EXIT.FAIL, status: ok ? 'ok' : 'failed', state, lines };
}

async function main() {
  const flags = parseArgs();
  if (flags.help) {
    process.stdout.write('用法：node butler-memory-vectors-tick.mjs [--memory-db P] [--vectors-db P] [--model-dir P] '
      + '[--home D] [--engine-dir P] [--allow-host H[,H...]] [--no-bridge] [--bridge-only] [--no-pitfall-hook] '
      + '[--skip-sweep] [--force-sweep] [--dry-run] [--json]\n');
    return EXIT.OK;
  }
  const r = await runOnce({ flags });
  if (flags.json) process.stdout.write(JSON.stringify({ ok: r.ok, status: r.status, exitCode: r.exitCode, state: r.state, bridge: r.bridge ?? null }, null, 2) + '\n');
  else for (const l of r.lines) process.stdout.write(l + '\n');
  return r.exitCode;
}

if (process.argv[1]) {
  let isMain = false;
  try { isMain = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { isMain = false; }
  if (isMain) process.exitCode = await main();
}
