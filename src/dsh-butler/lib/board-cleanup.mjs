// dsh-butler / lib/board-cleanup.mjs —— 看板「主线清账」判定引擎（P0 · 只读判定 + report 档通知）
//
// 方案：docs/（v2 复审修订版）
//   §3.1 判据（纯函数、零写）        §3.2 落点（复用 queue tick，插在 saveLedger **之后**）
//   §3.3 档位（observe/report/notify，首版默认 report）  §3.4 幂等/冷却/基线/上限/retention
//   §3.5 状态文件与三处登记          §6 验收 A1–A10        §7 回滚
//
// 一句话：某条主线（账本 `line` 分组）的在板卡**是否已全部完成** → 若是，按 report 档提示一条
//   **可复制的整线归档命令**（D3 `board-archive-line.mjs` 已交付）。**永不自动归档、永不自动恢复**。
//
// 硬边界（方案 §4 Non-goals + 主人拍板）：
//   · 不自动归档 / 不自动恢复归档卡（主人 21:50 拍：永不自动）
//   · P2 事件族：**2026-09-28 起已注册（K5b · 只注册执行类事件）** —— 见 P2_EVENTS_POLICY 常量 + 单测断言。
//     ⚠️ 原文「不注册 P2 事件族（裸跑期口径冻结）」是 2026-09-14 交付当刻的口径，已被下方常量取代
//     （只改这一段与那个常量，判定口径一字未动）。
//   · 不改看板插件、不改 report.mjs、不写账本 ledger-v2.json（只读 /state）、不新增 tickd job
//   · 唯一写口：本模块状态文件（走 lib/store.mjs 原子写/RMW 锁）+ 日报段（段级 RMW）+ 桌宠（瞬时）
//
// 判据（**不得自行放宽**，方案 §3.1 + 卡验收 A1/E7）：
//   分组：line.trim() 非空；**全等匹配**（禁 includes/startsWith —— 实测存在真前缀包含对
//         「插件自建与修复」⊂「插件自建与修复 · 看板归档与查重」）
//   live = 该组内 archivedAt === undefined 的卡
//   lastActivity(line) = max( 该线 live 卡 updatedAt, 各卡最后一条 executions[].endedAt（存在时） )
//        ⚠️ 卡级**没有** finishedAt/completedAt；executions[].endedAt 语义 = "执行结算"，
//           confirm 只盖 updatedAt（实测 97 张在板 done 卡里 endedAt > updatedAt 的 = 0 张）。
//           故取 max 即"最后一次动静"，**不采用"取不到就不提示"**（会让 19/97 张无执行记录的线永久沉默）。
//   候选 = live 全部 done（failed/running/review/todo/backlog 任一混入都不算）且：
//        · live >= 2 → 立即候选    · live === 1 → 需成熟：now - lastActivity >= MATURE_MS(24h)
//   未知状态（枚举漂移）→ fail-closed 当"未完成"，台账记 unknownStatus 计数。
//
// 三个键（方案 §3.4）：
//   事件键（去重键）= sha1(line + '|' + 该线 live 卡 id:status 排序串)
//   冷却键 = **线级** lines[line].lastNotifiedAt，COOLDOWN_DAYS=7
//            ⚠️ 键级冷却形同虚设（活跃线每次键变都是新键），故冷却必须挂线。
//   运行键 = lastCheckAt / lastRevision（节流与短路用，不参与去重）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { dshHome, ensureDir, statePath } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { readJson, writeTextAtomic } from './store.mjs';
import { writeStateText } from './dual-write.mjs';
import { updateStateJson } from './dual-write-store.mjs';
import { alert as sendAlert } from './alert.mjs';
import { sayWhale } from './watch-notify.mjs';
// K3：归档批次面的只读视图（`task-board/archive/<batchId>/cards.json`）。
import { readArchivedLineCountsSync } from '../../lib/board-archive-view.mjs';
// K5：J1 体积判据（取值 + 算式唯一真源；本模块只引用，不复制算式）。
import { J1, j1Check, fmtBytes, toFiniteOrNull } from '../../lib/board-j1-limits.mjs';

export const BOARD_CLEANUP_VERSION = '0.1.0';
export const COMPONENT = 'butler-board-cleanup';
export const PRODUCT = 'dsh-butler';

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-board-cleanup.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

export const STATE_NAME = 'butler-board-cleanup.json';
export const STATE_SCHEMA = 1;
export const BROKEN_BACKUP_DIR = 'butler-backups';

/** 三档（与 queue 同款语义；`notify` v1 **不开**，见 §3.3）。 */
export const MODES = ['observe', 'report', 'notify'];
/** 看板卡状态全集（tools\dsh-task-board-local\src\core\tasks.ts 的 ALL_STATUSES）。 */
export const KNOWN_STATUSES = ['backlog', 'todo', 'running', 'review', 'done', 'failed'];

export const MATURE_MS = 24 * 3600_000;          // 成熟期（**仅单卡线**）
export const COOLDOWN_DAYS = 7;                  // 线级冷却
export const THROTTLE_MS = 30 * 60_000;          // 模块内节流
export const MAX_ITEMS_PER_TICK = 8;             // 单次上限（超限按最早未提示优先）
export const MAX_EVENTS = 1000;                  // 事件台账上限（≥ 冷却窗口内最大键数）
export const CLOSED_RETENTION_DAYS = 180;        // closed 事件保留
export const KEY_HISTORY_CAP = 3;                // 每线保留最近 3 代事件键（D-3①）
export const MIN_LIVE = 1;                       // 单卡线也算（主人拍板）
export const STALL_ALERT_MS = 24 * 3600_000;     // 自检信号：lastCheckAt 连续 ≥24h 不推进 → warn
export const STALL_THRESHOLD_MS = 3 * THROTTLE_MS; // --status 判"停摆"的门槛（90 分钟）

/** D3（已交付）的整线归档命令；命令默认 dry-run，**自带可执行出口**（方案 §3.6）。 */
export const ARCHIVE_TOOL = 'node <butler-root>\\tools\\board-archive-line.mjs';
export const ARCHIVE_EXIT_CODES = 'exit 2=线名不存在、exit 5=命中 0 张、exit 4=有卡被跳过（非 done/failed）';

/**
 * P2 事件取舍（方案 §9 F-7 / R-7，照 butler-tidy-tick.mjs 先例落成**代码常量**）：
 * 原口径（2026-09-14 交付当刻）：裸跑期观测口径冻结 —— 新增 `board-*` 事件会抬高「累计告警」分母、
 * 且新判定必然带首批误报 ⇒ 本模块**不注册任何 P2 事件**，结论只落自身状态文件 + 日报段 + 桌宠；
 * 注册推迟到裸跑收尾报告落档后。
 *
 * 【2026-09-28 · K5b · 已注册（照 `docs/` §2② 候选原文）】
 *   · `registered: true`（裸跑收尾报告已落档，推迟事由消失）；
 *   · **注册范围 = 只注册执行类事件**（`kinds` 三项：真动手的留痕 + 真失败 + 被跳过的留痕）；
 *   · **候选提示类不注册**（"该清账了"这类**只读提示**不进告警分母 —— 它们是日报段 / 桌宠的信息面，
 *     不是告警）⇒ 本模块的 P2 事件面**不因新判定而产生首批误报分母**。
 *   ⚠️ 本常量是**声明**：判定口径（在板全完成 / 成熟期 / 冷却 / 基线）一字未改；改的只有"事件注册"这一个开关位。
 */
export const P2_EVENTS_POLICY = Object.freeze({
  registered: true,
  reason: 'bare-run-sample-pool-closed',                       // 裸跑收尾报告已落档
  deferTo: null,
  /** 注册范围（口径）：只注册**执行类**事件（真动手的留痕），候选提示类不注册 —— 只读提示不进告警分母。 */
  kinds: ['auto-action-executed', 'auto-action-failed', 'auto-action-skip'],
});

/** 配置默认值（首版默认 **report**：主人 2026-09-14 22:05 拍板）。 */
export const DEFAULT_CONFIG = Object.freeze({
  mode: 'report',
  minLive: MIN_LIVE,
  matureMs: MATURE_MS,
  cooldownDays: COOLDOWN_DAYS,
  throttleMs: THROTTLE_MS,
  settled: false,                              // failed 也算"已收工"？默认关（放开需重拍板）
  maxItems: MAX_ITEMS_PER_TICK,
  maxEvents: MAX_EVENTS,
  closedRetentionDays: CLOSED_RETENTION_DAYS,
});

export const EMPTY_STATS = Object.freeze({
  notified: 0,          // 累计：提示过几次（线·键）
  deferred: 0,          // 累计：被单次上限挤出
  suppressed: 0,        // 累计：被基线/冷却压制
  stale: 0,             // 当前：第三态线数（曾提示但不再候选且 live>0）
  unknownStatus: 0,     // 本轮：未知状态卡数（fail-closed 计数）
  noEndedAt: 0,         // 本轮：在板 done 卡里无可用 endedAt 的（实测 19 张）
  interruptedDone: 0,   // 本轮：在板 done 卡末条执行 result=interrupted 的（实测 6~7 张）
  baselines: 0,         // 累计：写入基线条目数
  closed: 0,            // 当前：在板归零（已整线归档）的线数
  evaluated: 0,         // 本轮：参与判定的线数
  eligibleLines: 0,     // 本轮：满足"在板全完成"（忽略成熟期）的线数
  candidateLines: 0,    // 本轮：通过成熟期、真正成候选的线数
  scans: 0,             // 累计：评估轮数（非节流跳过）
});

const EMPTY_LINE = Object.freeze({ lastNotifiedAt: null, closedAt: null, staleAt: null, keyHistory: [] });
const LOG_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------- 小工具

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stampText(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hhmm(now = Date.now()) {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function deviceName() {
  try { return os.hostname() || 'unknown-host'; } catch { return 'unknown-host'; }
}

/** 日志并入既有 queue 日志（方案 §3.5：不自建第二个日志文件，1 MB 轮转）。 */
export function logFile() {
  return process.env.DSH_QUEUE_LOG || path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-queue.log');
}

export function logLine(msg, opts = {}) {
  const line = `[${new Date(opts.now ?? Date.now()).toISOString()}] ${msg}`;
  try {
    const file = opts.file ?? logFile();
    ensureDir(path.dirname(file));
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > LOG_MAX_BYTES) fs.writeFileSync(file, '', 'utf8');
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch { /* 日志失败绝不影响主流程 */ }
  if (opts.quiet !== true) {
    try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// ---------------------------------------------------------------- 状态文件

export function stateFilePath(home = dshHome()) {
  return stateFileOf(STATE_NAME, { home });
}

export function emptyState() {
  return {
    schemaVersion: STATE_SCHEMA,
    product: PRODUCT,
    component: COMPONENT,
    version: BOARD_CLEANUP_VERSION,
    config: { ...DEFAULT_CONFIG },
    state: { lastCheckAt: null, lastRevision: null, lastResult: null, lastAlertAt: null, stats: { ...EMPTY_STATS } },
    lines: {},
    events: {},
    updatedAt: null,
    device: null,
  };
}

/** 补全（读到的旧文件缺字段也不崩：字段级合并，不做迁移）。 */
export function mergeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    config: { ...base.config, ...(raw.config && typeof raw.config === 'object' ? raw.config : {}) },
    state: {
      ...base.state,
      ...(raw.state && typeof raw.state === 'object' ? raw.state : {}),
      stats: { ...base.state.stats, ...(raw.state?.stats && typeof raw.state.stats === 'object' ? raw.state.stats : {}) },
    },
    lines: { ...(raw.lines && typeof raw.lines === 'object' ? raw.lines : {}) },
    events: { ...(raw.events && typeof raw.events === 'object' ? raw.events : {}) },
  };
}

/**
 * 读状态（A5 冷启动空态）：缺失 / 0 字节 / 损坏 / schemaVersion 不符 → 一律按**首跑**处理。
 * @returns {{state:object, exists:boolean, broken:boolean, reason:string|null, file:string}}
 */
export function loadState(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = stateFilePath(home);
  const empty = emptyState();
  if (!fs.existsSync(file)) return { state: empty, exists: false, broken: false, reason: 'missing', file };
  try {
    const raw = readJson(file, { schemaVersion: STATE_SCHEMA, home, defaultValue: null });
    if (!raw) return { state: empty, exists: false, broken: false, reason: 'empty-file', file };
    return { state: mergeState(raw), exists: true, broken: false, reason: null, file };
  } catch (e) {
    // CORRUPT_STATE / SCHEMA_MISMATCH：绝不误报（不拿半截台账去判冷却/基线），按首跑重建
    return { state: empty, exists: true, broken: true, reason: e?.message ?? String(e), file };
  }
}

/** 坏状态文件先另存（butler-backups/，已登记且不同步），再重建 → 不静默丢历史。 */
function backupBrokenState(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = stateFilePath(home);
  try {
    if (!fs.existsSync(file)) return null;
    const dir = path.join(home, BROKEN_BACKUP_DIR);
    ensureDir(dir);
    const dst = path.join(dir, `board-cleanup-broken-${new Date(opts.now ?? Date.now()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
    fs.copyFileSync(file, dst);
    return dst;
  } catch { return null; }
}

export function resolveConfig(opts = {}) {
  const src = opts.state?.config;
  const cli = opts.override ?? {};
  const cfg = { ...DEFAULT_CONFIG, ...(src && typeof src === 'object' ? src : {}) };
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (cli[k] !== undefined && cli[k] !== null) cfg[k] = cli[k];
  }
  // fail-safe 归一：非法值回落默认，绝不因为一个坏配置放大/缩小判定口径
  cfg.mode = MODES.includes(cfg.mode) ? cfg.mode : DEFAULT_CONFIG.mode;
  if (!(num(cfg.minLive) >= 1)) cfg.minLive = DEFAULT_CONFIG.minLive;
  if (!(num(cfg.matureMs) >= 0)) cfg.matureMs = DEFAULT_CONFIG.matureMs;
  if (!(num(cfg.cooldownDays) >= 0)) cfg.cooldownDays = DEFAULT_CONFIG.cooldownDays;
  if (!(num(cfg.throttleMs) >= 0)) cfg.throttleMs = DEFAULT_CONFIG.throttleMs;
  if (!(num(cfg.maxItems) >= 1)) cfg.maxItems = DEFAULT_CONFIG.maxItems;
  if (!(num(cfg.maxEvents) >= 1)) cfg.maxEvents = DEFAULT_CONFIG.maxEvents;
  if (!(num(cfg.closedRetentionDays) >= 0)) cfg.closedRetentionDays = DEFAULT_CONFIG.closedRetentionDays;
  cfg.settled = cfg.settled === true;
  cfg.minLive = Math.trunc(cfg.minLive);
  cfg.maxItems = Math.trunc(cfg.maxItems);
  cfg.maxEvents = Math.trunc(cfg.maxEvents);
  return cfg;
}

// ---------------------------------------------------------------- 判据（纯函数）

export function normalizeLine(line) {
  return line === undefined || line === null ? '' : String(line).trim();
}

/** 归档卡判据（`archivedAt === undefined`；null/0 都算已归档，与看板 `!task.archivedAt` 同口径）。 */
export function isArchivedCard(card) {
  const a = card?.archivedAt;
  return a !== undefined && a !== null;
}

/** 最后一条执行记录（字段名是 executions，不是 runs）。 */
export function lastExecutionOf(card) {
  const list = Array.isArray(card?.executions) ? card.executions : [];
  const ex = list.filter((e) => e && typeof e === 'object').slice(-1)[0];
  if (!ex) return null;
  return {
    id: ex.id ?? null,
    sessionId: ex.sessionId ?? null,
    startedAt: num(ex.startedAt),
    endedAt: num(ex.endedAt),
    result: ex.result ?? null,
  };
}

/** 成熟期基准：最后一次动静 = max(updatedAt, 最后一条 endedAt)（方案 §3.1 / R-1）。 */
export function lastActivityOf(cards) {
  let max = 0;
  for (const c of Array.isArray(cards) ? cards : []) {
    const u = num(c?.updatedAt);
    if (u) max = Math.max(max, u);
    const ex = lastExecutionOf(c);
    if (ex?.endedAt) max = Math.max(max, ex.endedAt);
  }
  return max || null;
}

/** 事件键（去重键）：sha1(line + '|' + live 卡 id:status 排序串)。 */
export function eventKeyOf(line, cards) {
  const parts = (Array.isArray(cards) ? cards : [])
    .map((c) => `${String(c?.id ?? '')}:${String(c?.status ?? '')}`)
    .sort();
  return createHash('sha1').update(`${normalizeLine(line)}|${parts.join(',')}`).digest('hex');
}

export function shortKey(key) {
  return typeof key === 'string' ? key.slice(0, 12) : '';
}

/**
 * K3 · 归档面的「按线计数」（物理归档后「另有归档 N 张」的唯一数据源）。
 *
 * 口径：直读 `$DSH_HOME/task-board/archive/<batchId>/cards.json`（**不经 Host** ⇒ 零 HTTP 负载、
 * 不压 dsh 主线程），按 `line` 归一化后计数。批次文件由 Host 单写者持有，读者可能撞上半完成批次
 * ⇒ 解析失败一律进 `errors`（**可见**），绝不静默当成"没有归档"。
 * 进程内缓存由 `board-archive-view.mjs` 负责（索引签名变化即失效），30 分钟一轮不会重复读 5 MB。
 * **只读，无副作用；永不抛**（异常统一收成 `source:'error'`，让调用方按"取不到数"处理）。
 *
 * @param {{home?:string, fresh?:boolean}} [opts]
 * @returns {{ok:boolean, source:'file'|'none'|'unavailable'|'error', reason:string,
 *            counts:Map<string,number>, cards:number, batches:number, errors:string[], home:string|null, cache:string}}
 */
export function readArchivedLineCountsSafe(opts = {}) {
  try {
    const view = readArchivedLineCountsSync(opts.home, opts.fresh === true ? { fresh: true } : {});
    const counts = new Map();
    for (const [raw, n] of view.byLine ?? new Map()) {
      const line = normalizeLine(raw);
      if (!line) continue;
      counts.set(line, (counts.get(line) ?? 0) + n);
    }
    return {
      ok: view.ok === true,
      source: view.source,
      reason: view.reason,
      counts,
      cards: view.count ?? 0,
      batches: view.batches ?? 0,
      errors: [...(view.errors ?? [])],
      home: view.home ?? null,
      cache: view.cache ?? 'bypass',
    };
  } catch (e) {
    return {
      ok: false, source: 'error', reason: `read-failed: ${e?.message ?? e}`,
      counts: new Map(), cards: 0, batches: 0, errors: [String(e?.message ?? e)], home: null, cache: 'bypass',
    };
  }
}

/**
 * K5 · 主账本体积读数（**只读** `stat`，不解析内容 —— 5 MB 级 JSON 每轮解析没必要）。
 * 口径 = 方案 §5 J1 的「主账本二进制字节」（`$DSH_HOME/task-board/ledger-v2.json`）。
 * 与在板卡数（来自 `/state` 的 `evaluateBoard().counts.liveCards`）合起来喂 `j1Check()`。
 * **永不抛**：取不到即 `ok:false`（观测项降级为"未取到"，绝不因此让整轮判定失败）。
 *
 * @param {{home?:string, ledgerPath?:string}} [opts]
 * @returns {{ok:boolean, file:string, bytes:number|null, mtimeMs:number|null, error:string|null}}
 */
export function readLedgerVolume(opts = {}) {
  const file = opts.ledgerPath ?? path.join(opts.home ?? dshHome(), 'task-board', 'ledger-v2.json');
  try {
    const st = fs.statSync(file);
    return { ok: true, file, bytes: st.size, mtimeMs: st.mtimeMs, error: null };
  } catch (e) {
    return { ok: false, file, bytes: null, mtimeMs: null, error: e?.message ?? String(e) };
  }
}

/**
 * K5 · 观测项（在板卡数 + 在板体积 + 整线归档建议）——**只读提示，非告警，非 P2 事件**。
 * 口径来源：方案 §6 表 2（体积阈值行）+ §11 P-8 推算块；判据算式走 `lib/board-j1-limits.mjs`。
 *
 * @param {{evaluation:object, volume:object}} input
 * @returns {{cards:number|null, ledgerBytes:number|null, relOk:boolean|null, absOk:boolean|null, overall:boolean|null,
 *            relLimitBytes:number|null, absLimitBytes:number, note:string,
 *            suggestion:{eligibleLines:number, eligibleCards:number, candidateLines:number, notifiedLines:number, notifiedCards:number}}}
 */
export function buildInBoardView(input = {}) {
  const ev = input.evaluation ?? {};
  const rows = Array.isArray(ev.lines) ? ev.lines : [];
  const cards = toFiniteOrNull(ev.counts?.liveCards);
  const bytes = toFiniteOrNull(input.volume?.bytes);
  const chk = j1Check({ liveCards: cards, ledgerBytes: bytes });
  const sum = (arr) => arr.reduce((a, r) => a + (Number(r?.live) || 0), 0);
  const eligible = rows.filter((r) => r.eligible);
  const candidate = rows.filter((r) => r.candidate);
  return {
    cards, ledgerBytes: bytes,
    relOk: chk.relOk, absOk: chk.absOk, overall: chk.overall,
    relLimitBytes: chk.relLimitBytes, absLimitBytes: chk.absLimitBytes,
    perCardBytes: J1.perCardBytes,
    note: chk.ok === true ? null : (chk.why ?? null),
    suggestion: {
      eligibleLines: eligible.length, eligibleCards: sum(eligible),
      candidateLines: candidate.length,
      notifiedLines: Number(input.notifiedLines ?? 0), notifiedCards: Number(input.notifiedCards ?? 0),
    },
  };
}

/**
 * K5 · 观测项的成段文案（纯函数；`inBoard` 缺失时返回空数组 = 向后兼容旧 payload）。
 * @param {object} inBoard `buildInBoardView()` 的返回值
 * @returns {string[]} markdown 行（不含段头）
 */
export function formatInBoardLines(inBoard) {
  if (!inBoard || typeof inBoard !== 'object') return [];
  const L = [];
  const cards = inBoard.cards;
  const vol = inBoard.ledgerBytes;
  const mark = (b) => (b === true ? '✅' : b === false ? '❌' : '？');
  L.push(`- 在板：**${cards === null ? 'n/a' : cards} 张** · 主账本 **${fmtBytes(vol)}** · `
    + `J1 相对项 ${mark(inBoard.relOk)}（≤ ${cards === null ? 'n/a' : cards} × 10 KB = ${fmtBytes(inBoard.relLimitBytes)}） · `
    + `绝对项 ${mark(inBoard.absOk)}（≤ ${fmtBytes(inBoard.absLimitBytes)}）`
    + `${inBoard.note ? ` · ⓘ ${inBoard.note}` : ''}`);
  const s = inBoard.suggestion ?? {};
  L.push(`- 整线归档建议（只读提示）：口径上可归档 **${s.eligibleLines ?? 0} 条线 / ${s.eligibleCards ?? 0} 张**`
    + `（本轮成候选 ${s.candidateLines ?? 0} 条 · 本轮已提示 ${s.notifiedLines ?? 0} 条 / ${s.notifiedCards ?? 0} 张）`
    + `；执行同一律走 \`--line\` 精确归档，**不自动执行**`);
  return L;
}

/**
 * 判据评估（**纯函数**，零写操作、不修改入参）。
 * @param {Array} tasks 看板 /state 的 tasks[]（全量含归档卡；live 视图则不含）
 * @param {{now?:number, revision?:number|string|null, cfg?:object, archivedLineCounts?:Map<string,number>|object}} [opts]
 *   `archivedLineCounts`（K3）：**本机归档批次**按线计数的外部读数（来自 `readArchivedLineCountsSafe`，
 *   由调用方注入以保持本函数纯粹）。与 `tasks` 内部的归档卡计数**逐线取 max**（同一张卡要么在
 *   主账本带 `archivedAt`、要么在批次里 ⇒ 两源是同一集合的两个视图，相加会双计）。
 */
export function evaluateBoard(tasks, opts = {}) {
  const now = opts.now ?? Date.now();
  const cfg = { ...DEFAULT_CONFIG, ...(opts.cfg ?? {}) };
  const list = Array.isArray(tasks) ? tasks : [];
  const groups = new Map();
  const archivedByLine = new Map();
  const counts = {
    tasks: list.length, liveCards: 0, archivedCards: 0, noLine: 0,
    lines: 0, allDoneLines: 0, eligibleLines: 0, candidateLines: 0, singleCardLines: 0,
    unknownStatus: 0, noEndedAt: 0, interruptedDone: 0, doneCards: 0,
    /** K3：来自归档批次的外部读数（与 `archivedCards` 是两个视图，别相加） */
    archivedCardsFromBatches: 0, archivedLinesFromBatches: 0,
  };

  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const rawLine = t.line === undefined || t.line === null ? '' : String(t.line);
    const line = normalizeLine(rawLine);
    const status = String(t.status ?? '');
    if (isArchivedCard(t)) {
      counts.archivedCards++;
      if (line) archivedByLine.set(line, (archivedByLine.get(line) ?? 0) + 1);
      continue;
    }
    counts.liveCards++;
    if (!KNOWN_STATUSES.includes(status)) counts.unknownStatus++;
    if (!line) { counts.noLine++; continue; }
    if (status === 'done') {
      counts.doneCards++;
      const ex = lastExecutionOf(t);
      if (!ex || !ex.endedAt) counts.noEndedAt++;
      if (ex && ex.result === 'interrupted') counts.interruptedDone++;
    }
    let g = groups.get(line);
    if (!g) { g = { line, rawLine, live: [] }; groups.set(line, g); }
    g.live.push(t);
  }

  // K3 · 合并**归档批次**的外部读数（逐线取 max，不相加：两源是同一集合的两个视图）
  const externalArchived = opts.archivedLineCounts instanceof Map
    ? opts.archivedLineCounts
    : new Map(Object.entries(opts.archivedLineCounts ?? {}));
  for (const [rawLine, n] of externalArchived) {
    const line = normalizeLine(rawLine);
    const num = Number(n);
    if (!line || !Number.isFinite(num) || num <= 0) continue;
    counts.archivedCardsFromBatches += num;
    counts.archivedLinesFromBatches += 1;
    archivedByLine.set(line, Math.max(archivedByLine.get(line) ?? 0, num));
  }

  const rows = [];
  for (const g of groups.values()) {
    const live = g.live.length;
    const statuses = g.live.map((c) => String(c?.status ?? ''));
    const allDone = statuses.every((s) => s === 'done');
    const allSettled = statuses.every((s) => s === 'done' || (cfg.settled === true && s === 'failed'));
    const lastActivity = lastActivityOf(g.live);
    const ageMs = lastActivity ? Math.max(0, now - lastActivity) : null;
    const eligible = allSettled && live >= cfg.minLive;
    // 成熟期**只作用于单卡线**（方案 §3.1/§3.4 + 验收 A6b）
    const mature = live >= 2 || ageMs === null || ageMs >= cfg.matureMs;
    rows.push({
      line: g.line,
      rawLine: g.rawLine,
      live,
      archivedCount: archivedByLine.get(g.line) ?? 0,
      statuses,
      unknownStatus: statuses.filter((s) => !KNOWN_STATUSES.includes(s)),
      allDone,
      allSettled,
      eligible,
      mature,
      candidate: eligible && mature,
      lastActivity,
      ageMs,
      eventKey: eventKeyOf(g.line, g.live),
      cardIds: g.live.map((c) => String(c?.id ?? '')).sort(),
      title: String(g.live[0]?.title ?? ''),
    });
  }
  rows.sort((a, b) => (a.ageMs ?? 0) - (b.ageMs ?? 0) || a.line.localeCompare(b.line));

  counts.lines = rows.length;
  counts.allDoneLines = rows.filter((r) => r.allDone).length;
  counts.eligibleLines = rows.filter((r) => r.eligible).length;
  counts.candidateLines = rows.filter((r) => r.candidate).length;
  counts.singleCardLines = rows.filter((r) => r.live === 1).length;

  return { now, revision: opts.revision ?? null, cfg, lines: rows, counts };
}

// ---------------------------------------------------------------- retention（纯函数）

/**
 * 台账淘汰（方案 §3.4）：① 先清超期 closed → ② 超上限时按 lastSeenAt 升序 → ③ stale 永不淘汰。
 * @returns {{events:object, removed:object}}
 */
export function applyRetention(events, lines, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxEvents = num(opts.maxEvents) ?? MAX_EVENTS;
  const closedDays = num(opts.closedRetentionDays) ?? CLOSED_RETENTION_DAYS;
  const src = events && typeof events === 'object' ? events : {};
  const out = {};
  let expiredClosed = 0;
  for (const [key, ev] of Object.entries(src)) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.closedAt && closedDays >= 0 && now - ev.closedAt > closedDays * 86400_000) { expiredClosed++; continue; }
    out[key] = ev;
  }
  const protectedKey = (key, ev) => {
    const rec = lines?.[ev?.line ?? ''];
    return Boolean(rec && rec.staleAt);
  };
  let byLastSeen = 0;
  const keys = Object.keys(out);
  if (keys.length > maxEvents) {
    const sorted = keys
      .map((k) => ({ k, seen: num(out[k]?.lastSeenAt) ?? 0 }))
      .sort((a, b) => a.seen - b.seen || a.k.localeCompare(b.k));
    for (const { k } of sorted) {
      if (Object.keys(out).length <= maxEvents) break;
      if (protectedKey(k, out[k])) continue;      // stale 永不淘汰
      delete out[k];
      byLastSeen++;
    }
  }
  const protectedCount = Object.values(out).filter((ev) => Boolean(lines?.[ev?.line ?? '']?.staleAt)).length;
  return { events: out, removed: { expiredClosed, byLastSeen, protectedCount } };
}

// ---------------------------------------------------------------- 计划（纯函数）

function emptyPlan() {
  return { items: [], deferred: [], suppressed: [], stale: [], closed: [], baselineCount: 0 };
}

/**
 * 判定 → 计划（**纯函数**）：给定评估结果 + 台账 → 下一步动作 + 新台账。
 * 所有闸门都在这里：首跑基线（含"成熟后仍静默"）、线级冷却、单次上限公平性、stale/closed 第三态。
 *
 * ⚠️ `emit`（= 档位是否真的对外输出）：**observe 档必须传 false**。
 *   否则"只观察"的一轮会把候选盖上 `lastNotifiedAt`（7 天线级冷却）+ 累计 notified —— 等于
 *   在没人看到提示的情况下**消费掉通知配额**（实测踩过：observe + --announce 跑到 4 条线被盖章，
 *   切回 report 后 7 天内一个提示都发不出来）。`emit:false` 时：items 照算（"若输出会提示谁"可见），
 *   但不写 lastNotifiedAt、不累加 notified。
 *
 * @param {{evaluation:object, state:object, cfg:object, now:number, firstRun?:boolean,
 *          announce?:boolean, emit?:boolean}} input
 * @returns {{next:object, items:Array, deferred:Array, suppressed:Array, stale:Array, closed:Array,
 *            baselineCount:number, stats:object, resultText:string}}
 */
export function planRun(input) {
  const { evaluation, cfg, now } = input;
  const cur = mergeState(input.state);
  const firstRun = input.firstRun === true;
  const announce = input.announce === true;
  const emit = input.emit !== false;
  const lines = { ...cur.lines };
  const events = { ...cur.events };
  const st = { ...cur.state, stats: { ...EMPTY_STATS, ...(cur.state?.stats ?? {}) } };
  const stats = { ...st.stats };
  const plan = emptyPlan();
  const seen = new Set();
  const cooldownMs = Math.max(0, cfg.cooldownDays) * 86400_000;

  // ① 逐线记账（在板有卡的线）
  for (const row of evaluation.lines) {
    seen.add(row.line);
    const rec = { ...EMPTY_LINE, ...(lines[row.line] ?? {}) };
    const kh = Array.isArray(rec.keyHistory) ? rec.keyHistory.slice() : [];

    if (row.eligible) {
      if (kh[kh.length - 1] !== row.eventKey) kh.push(row.eventKey);
      const prevEv = events[row.eventKey] ?? null;
      const ev = {
        line: row.line,
        firstSeenAt: prevEv?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastNotifiedAt: prevEv?.lastNotifiedAt ?? null,
        // 首跑基线：首次运行把这批"在板全完成"的线全部标基线，此后**成熟了也不输出**（D-2①）
        baseline: prevEv ? prevEv.baseline === true : firstRun,
        baselineMaturedAt: prevEv?.baselineMaturedAt ?? null,
        closedAt: null,
      };
      if (ev.baseline && !ev.baselineMaturedAt && row.ageMs !== null && row.ageMs >= cfg.matureMs) {
        ev.baselineMaturedAt = now;
      }
      events[row.eventKey] = ev;
      if (!prevEv && ev.baseline) plan.baselineCount++;

      if (row.candidate) {
        const onCooldown = Boolean(rec.lastNotifiedAt) && (now - rec.lastNotifiedAt) < cooldownMs;
        if (ev.baseline && !announce) {
          plan.suppressed.push({ line: row.line, key: row.eventKey, reason: 'baseline', since: ev.firstSeenAt });
        } else if (onCooldown) {
          // 冷却**不受 --announce 影响**（人工撤销/已提示是明确指令，announce 只用于"看首批基线"）
          const why = rec.dismissedAt && rec.dismissedAt >= rec.lastNotifiedAt ? 'dismissed' : 'cooldown';
          plan.suppressed.push({ line: row.line, key: row.eventKey, reason: why, lastNotifiedAt: rec.lastNotifiedAt });
          stats.suppressed++;
        } else {
          plan.items.push({
            line: row.line, rawLine: row.rawLine, live: row.live, archivedCount: row.archivedCount,
            statuses: row.statuses, eventKey: row.eventKey, lastActivity: row.lastActivity, ageMs: row.ageMs,
            allDone: row.allDone, isBaseline: ev.baseline === true,
            firstSeenAt: ev.firstSeenAt,
            sortAt: rec.lastNotifiedAt ?? ev.firstSeenAt,
          });
        }
      }
      rec.staleAt = null;
      rec.closedAt = null;
    } else if (rec.lastNotifiedAt && !rec.staleAt) {
      // 第三态：曾被提示、现已不满足候选条件但 live>0（主人只归档 done 时会落这里）
      rec.staleAt = now;
      plan.stale.push({ line: row.line, since: now, reason: 'no-longer-candidate', live: row.live, statuses: row.statuses });
    }

    rec.keyHistory = kh.slice(-KEY_HISTORY_CAP);
    lines[row.line] = rec;
  }

  // ② live 归零的线 → closed（在板卡被整线归档）
  for (const [line, prev] of Object.entries(lines)) {
    if (seen.has(line)) continue;
    const rec = { ...EMPTY_LINE, ...(prev ?? {}) };
    if (!rec.closedAt) { rec.closedAt = now; plan.closed.push({ line, hadNotifiedAt: rec.lastNotifiedAt ?? null }); }
    rec.staleAt = null;                      // 已归零 = 收工，不再算第三态
    lines[line] = rec;
    for (const ev of Object.values(events)) {
      if (ev && ev.line === line && !ev.closedAt) ev.closedAt = now;
    }
  }

  // ③ 单次上限：按"最早未提示优先"（未提示过的按 firstSeenAt），被挤出者记 deferred
  plan.items.sort((a, b) => (a.sortAt - b.sortAt) || a.line.localeCompare(b.line));
  const notify = plan.items.slice(0, Math.max(1, cfg.maxItems));
  for (const x of plan.items.slice(Math.max(1, cfg.maxItems))) {
    plan.deferred.push({ line: x.line, key: x.eventKey, live: x.live, reason: 'max-items', sortAt: x.sortAt });
    stats.deferred++;
  }
  plan.items = notify;

  for (const it of notify) {
    if (!emit) break;                 // observe 档：只算不消费（见函数头 emit 说明）
    const rec = { ...EMPTY_LINE, ...(lines[it.line] ?? {}) };
    rec.lastNotifiedAt = now;
    rec.staleAt = null;
    lines[it.line] = rec;
    const ev = events[it.eventKey];
    if (ev) ev.lastNotifiedAt = now;
    stats.notified++;
  }

  // ④ retention + 计数收口
  const ret = applyRetention(events, lines, { now, maxEvents: cfg.maxEvents, closedRetentionDays: cfg.closedRetentionDays });
  stats.stale = Object.values(lines).filter((r) => r && r.staleAt).length;
  stats.closed = Object.values(lines).filter((r) => r && r.closedAt).length;
  stats.evaluated = evaluation.lines.length;
  stats.baselines += plan.baselineCount;
  stats.eligibleLines = evaluation.lines.filter((r) => r.eligible).length;
  stats.candidateLines = evaluation.lines.filter((r) => r.candidate).length;
  stats.unknownStatus = evaluation.counts.unknownStatus;
  stats.noEndedAt = evaluation.counts.noEndedAt;
  stats.interruptedDone = evaluation.counts.interruptedDone;
  stats.scans += 1;

  // 结果串（`--status` 一眼可见）：首跑基线 / 本轮提示（observe 标 would-，表示"只算不消费"）
  const parts = [];
  if (firstRun && plan.baselineCount) parts.push(`first-run-baseline(${plan.baselineCount})`);
  if (plan.items.length) {
    parts.push(`${emit ? '' : 'would-'}notified:${plan.items.length}`
      + `${plan.deferred.length ? ` deferred:${plan.deferred.length}` : ''}`
      + `${plan.suppressed.length ? ` suppressed:${plan.suppressed.length}` : ''}`
      + `${plan.stale.length ? ` stale:${plan.stale.length}` : ''}`);
  }
  if (!parts.length) parts.push(evaluation.counts.eligibleLines ? 'eligible-but-silent' : 'none');
  const resultText = parts.join(' ');

  const next = {
    ...cur,
    schemaVersion: STATE_SCHEMA,
    product: PRODUCT,
    component: COMPONENT,
    version: BOARD_CLEANUP_VERSION,
    config: { ...cfg },
    state: {
      ...st,
      stats,
      lastCheckAt: now,
      lastRevision: evaluation.revision ?? st.lastRevision ?? null,
      lastResult: resultText,
    },
    lines,
    events: ret.events,
    updatedAt: new Date(now).toISOString(),
    device: deviceName(),
  };
  return { ...plan, next, stats, resultText, retention: ret.removed, suppressedCount: stats.suppressed };
}

// ---------------------------------------------------------------- 文案

/** 单条候选的两行命令（**线名从台账原值整行复制**，防前缀截断归档错线）。 */
export function formatCommandLines(item) {
  const name = item.rawLine ?? item.line;
  return [
    `dry-run：\`${ARCHIVE_TOOL} --line "${name}"\``,
    `归档：同命令 + \`--apply --emit-restore\`（自带逐卡回滚脚本）`,
  ];
}

/** 候选行的一行摘要（无 markdown 前缀，便于复用）。 */
export function formatItemBrief(item) {
  const n = item.live;
  const how = item.allDone === false ? '已完成/已失败（--settled 口径）' : '全部完成';
  return `${item.line} — 在板 ${n} 张${how}${item.archivedCount ? `（另有归档 ${item.archivedCount} 张）` : ''}`;
}

/**
 * 日报段（markdown 行数组，**幂等**：同输入逐字节一致）。
 * 段头必须带「评估于 <时间>」+ 标「只读提示，非 P2 事件」（方案 §3.3 / §9 F-7）。
 */
export function formatSectionLines(payload, opts = {}) {
  const now = opts.now ?? payload?.now ?? Date.now();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const cfg = { ...DEFAULT_CONFIG, ...(payload?.cfg ?? {}) };
  const mode = payload?.mode ?? cfg.mode;
  const L = [];
  L.push('## 🧾 待清账主线（只读提示，非 P2 事件）');
  L.push('');
  L.push(`- 档位：**${mode}** · 评估于 ${stampText(now)} · 设备 ${opts.device ?? deviceName()} · 命中 **${items.length}** 条`);
  const matureH = Math.round(cfg.matureMs / 3600_000 * 10) / 10;
  L.push(`- 口径：在板卡全部 \`done\` 才算（混入 todo/backlog/running/review/failed 一律不算）；多卡线立即提示，单卡线需成熟 ${matureH}h；线级冷却 ${cfg.cooldownDays} 天；**只提示，不自动归档**`);
  // K5 观测项（在板卡数 + 在板体积 + 整线归档建议）——只读提示；旧 payload 无该字段时整段省略
  for (const line of formatInBoardLines(payload?.inBoard)) L.push(line);
  if (!items.length) {
    const silent = payload?.counts ?? null;
    L.push(`- 本轮无待清账主线${silent?.eligibleLines ? `（在板全完成的线 ${silent.eligibleLines} 条仍在成熟期/冷却期/基线静默中）` : ''}。`);
  } else {
    const show = items.slice(0, 40);
    for (const it of show) {
      L.push(`- **${formatItemBrief(it)}**`);
      for (const c of formatCommandLines(it)) L.push(`  - ${c}`);
    }
    if (items.length > show.length) L.push(`- …另有 ${items.length - show.length} 条（跑 \`node <butler-root>\\tools\\dsh-butler\\butler-board-cleanup.mjs --status --json\` 看全）`);
  }
  const bits = [];
  if (payload?.deferred?.length) bits.push(`被上限挤出 ${payload.deferred.length}`);
  if (payload?.suppressed?.length) bits.push(`压制 ${payload.suppressed.length}（基线/冷却）`);
  if (payload?.stale?.length) bits.push(`第三态 ${payload.stale.length}`);
  if (payload?.baselineCount) bits.push(`新写基线 ${payload.baselineCount}`);
  if (payload?.stats?.stale) bits.push(`累计 stale ${payload.stats.stale}`);
  if (bits.length) L.push(`- 本轮其它：${bits.join(' · ')}`);
  L.push(`- ⓘ 若个别卡被跳过（非 done/failed），dry-run 会列出来；${ARCHIVE_EXIT_CODES}`);
  L.push('');
  L.push('> 由 `<butler-root>\\tools\\dsh-butler\\butler-board-cleanup.mjs`（queue tick 每 1 分钟巡检、模块内 30 分钟节流）写入；**只读提示，非 P2 事件**。');
  L.push('> 人工出口：`--dismiss <line>` 撤销提示 / `--reopen <line>` 重开 / `--mode observe` 转安静 / `--announce` 主动看首批。');
  return L;
}

export function dailyReportPath(now = Date.now(), opts = {}) {
  const docsRoot = opts.docsRoot ?? path.join('<butler-root>', 'docs', 'reports');
  return path.join(docsRoot, `${dayKey(now)}-${opts.device ?? deviceName()}.md`);
}

/**
 * 刷新日报段（**段级 RMW，幂等整段替换**；沿用 queue 的裸 writeFileSync，不改成整文件原子写）。
 * 与 queue 段互不干扰：只替换本段锚点之间的内容，插入位置固定在最末一个 `## ` 段之后。
 */
export function refreshBoardCleanupSection(file, payload, opts = {}) {
  const now = opts.now ?? payload?.now ?? Date.now();
  const eolProbe = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = eolProbe.includes('\r\n') ? '\r\n' : '\n';
  const block = formatSectionLines(payload, { now, device: opts.device });
  if (opts.dryRun) return { ok: true, action: 'dry-run', file, block };
  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) {
      const header = [
        `# 管家日报 · ${dayKey(now)}`,
        '',
        `> 由 \`butler-board-cleanup.mjs\` 于 ${hhmm(now)} 创建（原日报未生成时的兜底，面板 09:00 会重建）。`,
        '',
      ].join(eol);
      fs.writeFileSync(file, header, 'utf8');
    }
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = lines.findIndex((l) => /^##\s*🧾\s*待清账主线/.test(l));
    let next;
    if (start < 0) {
      const base = raw.endsWith('\n') || raw.endsWith('\r\n') ? raw : raw + eol;
      next = base + eol + block.join(eol) + eol;
    } else {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
      }
      next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join(eol);
      if (!next.endsWith(eol)) next += eol;
    }
    if (next === raw) return { ok: true, action: 'unchanged', file };
    fs.writeFileSync(file, next, 'utf8');
    return { ok: true, action: start < 0 ? 'appended' : 'updated', file };
  } catch (e) {
    return { ok: false, action: 'error', file, error: e?.message ?? String(e) };
  }
}

/** 段是否已存在（用于"无候选时只刷新已有段，不凭空空建日报"）。 */
export function hasSection(file) {
  try { return /^##\s*🧾\s*待清账主线/m.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}

/** 桌宠一句话（≤180 字，超长由 sayWhale 再截）。 */
export function formatWhaleText(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) return '';
  const shown = items.slice(0, 3).map((x) => `${x.line}(在板${x.live})`).join(' · ');
  const more = items.length > 3 ? ` 等 ${items.length} 条` : '';
  return `🐳 待清账主线 ${items.length} 条：${shown}${more} —— 已完成的主线可以整线归档了；日报里有可复制的命令（只提示，不自动归档）`;
}

// ---------------------------------------------------------------- 自检信号 / 依赖诊断

/**
 * 自检信号（A9）：`lastCheckAt` 连续 ≥24h 不推进 → 一条 warn（走 lib/alert.mjs，**不进 P2**）。
 * 24h 内只报一次（避免每次 tick 刷屏）。
 */
export function watchdogCheck(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? STALL_ALERT_MS;
  const st = state?.state ?? state ?? {};
  const last = num(st.lastCheckAt);
  if (!last) return { due: false, reason: 'never-run' };
  const ageMs = now - last;
  if (ageMs < staleMs) return { due: false, ageMs, reason: 'fresh' };
  const lastAlert = num(st.lastAlertAt);
  if (lastAlert && now - lastAlert < staleMs) return { due: false, ageMs, reason: 'alerted-recently' };
  return {
    due: true, ageMs, level: 'warn',
    message: `看板清账判定已停摆 ${Math.round(ageMs / 3600_000)}h（lastCheckAt=${new Date(last).toLocaleString('zh-CN', { hour12: false })}）`
      + '——多为依赖 job `queue` 被关或看板采集失败（readBoard 失败时本判定不会被调用）',
  };
}

/**
 * 停摆归因（**纯函数**，A8b）：cleanup 未被调用时，`--status` 靠它把"没提示"归因到具体环节。
 * 判据链：判定侧停摆 → 依赖 job 状态 → queue 台账是否也在停摆（采集失败时 runTick 早退，不写台账）。
 */
export function diagnoseStall(input = {}) {
  const now = input.now ?? Date.now();
  const thresholdMs = input.thresholdMs ?? STALL_THRESHOLD_MS;
  const lastCheckAt = num(input.lastCheckAt);
  const queueLastTickAt = num(input.queueLastTickAt);
  const job = input.tickdJob ?? null;
  const evidence = {
    lastCheckAt: lastCheckAt ? new Date(lastCheckAt).toISOString() : null,
    lastCheckAgeMin: lastCheckAt ? Math.round((now - lastCheckAt) / 60000) : null,
    queueLastTickAt: queueLastTickAt ? new Date(queueLastTickAt).toISOString() : null,
    queueAgeMin: queueLastTickAt ? Math.round((now - queueLastTickAt) / 60000) : null,
    tickdFound: job?.found === true, tickdLastStatus: job?.lastStatus ?? null, tickdFailures: job?.failures ?? null,
    thresholdMin: Math.round(thresholdMs / 60000),
  };
  if (!lastCheckAt) return { stalled: true, reason: 'never-run', evidence };
  if (now - lastCheckAt < thresholdMs) return { stalled: false, reason: 'fresh', evidence };
  if (job && job.found === false) return { stalled: true, reason: 'job-missing', evidence };
  if (job && job.found === true && job.lastStatus && !['ok', 'locked', 'busy', 'deferred', 'skipped-missing-src'].includes(job.lastStatus)) {
    // 【卡 AT19】'deferred' = tickd 按 job 声明的 benignExitCodes 记下的"让路/未完成"（当前仅 hot），
    //   与 locked/busy 同属"这一轮没干成但 job 没坏"，不算失败（否则会把停摆归因指错方向）。
    // 【B7】'skipped-missing-src' = tickd 三级解析没找到作业脚本 ⇒ "没装这件东西"，更不是失败。
    return { stalled: true, reason: 'job-failing', evidence };
  }
  if (!queueLastTickAt || now - queueLastTickAt >= thresholdMs) return { stalled: true, reason: 'collect-failed', evidence };
  return { stalled: true, reason: 'unknown-stall', evidence };
}

/** 依赖 job（queue）状态 —— 复用 tickd 自己的调度表 + 状态文件（单一数据源，只读）。 */
export async function dependencyStatus(opts = {}) {
  const jobId = opts.jobId ?? 'queue';
  try {
    const [{ JOBS, describeSchedule }, { readTickdState, judgeJob, probeTickdRunning, fmtLocalTime }] = await Promise.all([
      import('../butler-tickd.mjs'),
      import('./tickd-health.mjs'),
    ]);
    const job = (JOBS ?? []).find((j) => j.id === jobId) ?? null;
    const read = readTickdState(opts.dir ? { dir: opts.dir } : {});
    const st = read.state ?? null;
    const judge = job ? judgeJob(job, st?.jobs?.[jobId], opts.now ?? Date.now()) : null;
    let running = null;
    try { running = probeTickdRunning({ dir: read.dir, state: st, now: opts.now ?? Date.now() }); } catch (e) { running = { ok: false, reason: `probe-error:${e?.message ?? e}` }; }
    return {
      found: Boolean(job),
      jobId,
      // 【卡「冷盘窗」2026-09-20】展示复用 tickd 的 describeSchedule（days / window 也要看得见）
      every: job && typeof describeSchedule === 'function' ? describeSchedule(job) : null,
      script: job?.script ?? null,
      lastStatus: judge?.lastStatus ?? null,
      failures: judge?.failures ?? 0,
      runs: judge?.runs ?? 0,
      lastEndAt: judge?.lastEndAt ?? null,
      lastEndLocal: fmtLocalTime(judge?.lastEndAt ?? null),
      level: judge?.level ?? 'unknown',
      reason: judge?.reason ?? null,
      tickdRunning: running?.ok === true,
      tickdReason: running?.reason ?? null,
      stateFile: read.file,
      stateError: read.ok ? null : read.error,
    };
  } catch (e) {
    return { found: false, jobId, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------- 总览（--status / --json）

export function summarizeState(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const s = mergeState(state);
  const cfg = resolveConfig({ state: s });
  const lines = Object.entries(s.lines).map(([line, rec]) => ({
    line,
    lastNotifiedAt: rec?.lastNotifiedAt ?? null,
    closedAt: rec?.closedAt ?? null,
    staleAt: rec?.staleAt ?? null,
    dismissedAt: rec?.dismissedAt ?? null,
    keys: (rec?.keyHistory ?? []).length,
    ageMin: rec?.lastNotifiedAt ? Math.round((now - rec.lastNotifiedAt) / 60000) : null,
    state: rec?.closedAt ? 'closed' : (rec?.staleAt ? 'stale' : 'live'),
  })).sort((a, b) => (b.lastNotifiedAt ?? 0) - (a.lastNotifiedAt ?? 0));
  const events = Object.values(s.events);
  return {
    config: cfg,
    lastCheckAt: s.state.lastCheckAt ?? null,
    lastRevision: s.state.lastRevision ?? null,
    lastResult: s.state.lastResult ?? null,
    lastAlertAt: s.state.lastAlertAt ?? null,
    stats: s.state.stats,
    lines: lines.length,
    linesActive: lines.filter((x) => x.state === 'live').length,
    staleLines: lines.filter((x) => x.state === 'stale').map((x) => x.line),
    closedLines: lines.filter((x) => x.state === 'closed').length,
    events: events.length,
    baselineEvents: events.filter((e) => e?.baseline === true).length,
    rows: lines,
    device: s.device ?? null,
    updatedAt: s.updatedAt ?? null,
  };
}

// ---------------------------------------------------------------- 人工出口

export function setMode(mode, opts = {}) {
  if (!MODES.includes(mode)) return { ok: false, error: `mode 必须是 ${MODES.join('|')}` };
  const home = opts.home ?? dshHome();
  const loaded = loadState({ home });
  const cur = resolveConfig({ state: loaded.state });
  if (mode === 'notify' && cur.mode === 'observe' && opts.allowSkipStage !== true) {
    return { ok: false, error: '分档放权路径不许跳档（observe → report → notify）：确认无误后加 --allow-skip-stage', current: cur.mode };
  }
  if (mode === 'notify') {
    return {
      ok: false,
      error: 'notify 档 v1 **不开**（方案 §3.3：注入通道未实现，需主人拍板后另行交付）；可先停在 report',
      current: cur.mode,
    };
  }
  const now = opts.now ?? Date.now();
  const next = { ...loaded.state, config: { ...loaded.state.config, mode }, updatedAt: new Date(now).toISOString(), device: deviceName() };
  writeStateFile(next, { home, firstRun: !loaded.exists || loaded.broken, now });
  logLine(`档位变更 ${cur.mode} → ${mode}（actor=${opts.actor ?? 'cli'}）`, { now });
  return { ok: true, mode, previous: cur.mode, file: stateFilePath(home) };
}

/** `--dismiss <line>`：撤销提示 = 落 7 天线级冷却 + 留 dismissedAt 痕迹（不改看板、不动账本）。 */
export function dismissLine(line, opts = {}) {
  const home = opts.home ?? dshHome();
  const key = normalizeLine(line);
  if (!key) return { ok: false, error: '--dismiss 需要非空主线名' };
  const now = opts.now ?? Date.now();
  const loaded = loadState({ home });
  const exists = Boolean(loaded.state.lines[key]);
  if (!exists) return { ok: false, error: `台账里没有这条主线：${key}`, known: Object.keys(loaded.state.lines).slice(0, 20) };
  const rec = { ...EMPTY_LINE, ...(loaded.state.lines[key] ?? {}) };
  const lines = { ...loaded.state.lines, [key]: { ...rec, lastNotifiedAt: now, dismissedAt: now, dismissedBy: opts.actor ?? 'cli' } };
  const next = { ...loaded.state, lines, updatedAt: new Date(now).toISOString() };
  writeStateFile(next, { home, firstRun: !loaded.exists || loaded.broken, now });
  logLine(`🚫 人工撤销提示（dismiss）：${key}（actor=${opts.actor ?? 'cli'}）→ 7 天内不再提示`, { now });
  return { ok: true, action: 'dismissed', line: key, cooldownUntil: now + COOLDOWN_DAYS * 86400_000 };
}

/** `--reopen <line>`：清除冷却/关闭/第三态痕迹 + 删该线事件 → 下一轮可重新提示。 */
export function reopenLine(line, opts = {}) {
  const home = opts.home ?? dshHome();
  const key = normalizeLine(line);
  if (!key) return { ok: false, error: '--reopen 需要非空主线名' };
  const now = opts.now ?? Date.now();
  const loaded = loadState({ home });
  const rec = loaded.state.lines[key];
  if (!rec) return { ok: false, error: `台账里没有这条主线：${key}`, known: Object.keys(loaded.state.lines).slice(0, 20) };
  const lines = { ...loaded.state.lines, [key]: { ...EMPTY_LINE, ...rec, lastNotifiedAt: null, closedAt: null, staleAt: null, dismissedAt: null, keyHistory: [] } };
  const events = {};
  for (const [k, ev] of Object.entries(loaded.state.events)) if (ev?.line !== key) events[k] = ev;
  const next = { ...loaded.state, lines, events, updatedAt: new Date(now).toISOString() };
  writeStateFile(next, { home, firstRun: !loaded.exists || loaded.broken, now });
  logLine(`🔓 人工重开（reopen）：${key}（actor=${opts.actor ?? 'cli'}）→ 清除冷却/关闭/第三态痕迹`, { now });
  return { ok: true, action: 'reopened', line: key, removedEvents: Object.keys(loaded.state.events).length - Object.keys(events).length };
}

function writeStateFile(next, opts = {}) {
  const home = opts.home ?? dshHome();
  const file = stateFilePath(home);
  if (opts.firstRun) {
    const dw = writeStateText(STATE_NAME, JSON.stringify(next, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
    return { ok: true, file, via: 'atomic' };
  }
  updateStateJson(STATE_NAME, file, () => next, { schemaVersion: STATE_SCHEMA, home, defaultValue: next });
  return { ok: true, file, via: 'rmw' };
}

// ---------------------------------------------------------------- 一轮（tick 主入口）

/**
 * 跑一轮判定（**只读判定 + 台账**；对外副作用仅在 report/notify 档且非 dry-run）。
 *
 * ★K3（2026-09-24 · 看板瘦身/归档物理化 · 方案 §8 #8）：**恢复「另有归档 N 张」口径**。
 *   背景：queue tick 的看板读取（`lib\queue-watch.mjs#readBoard`）2026-09-24 起带
 *   `x-dsh-board-scope: live`（只拿在板卡，为的是不给 dsh 主线程加压）⇒ 归档卡不在 `tasks` 里
 *   ⇒ `evaluateBoard` 内部那份 `archivedByLine` 恒为 0 ⇒ 文案里的「另有归档 N 张」**失效**。
 *   物理归档之后更彻底：归档卡本来就住 `task-board/archive/<batchId>/cards.json`。
 *   现口径 = **按线统计归档批次里的卡数**（`readArchivedLineCountsSafe`，直读文件 ⇒ 零 Host 负载），
 *   与 `tasks` 内部的归档卡计数**取 max 合并**（同一张卡要么在主账本带 `archivedAt`、要么在批次里，
 *   两源是同一集合的两个视图 ⇒ 相加会双计，max 才是"该线共有多少张归档卡"）。
 *   ⚠️ 与方案 §8 #8 措辞的差异（如实登记 · 交付报告同批）：方案写"该批次数"，本实现按**卡数** ——
 *      批次不归属单条主线（一个批次可含多线卡），"该批次数"落不到"该线"上，而文案单位是"张"。
 *
 * ⚠️ 调用点铁律（方案 §3.2 / A-B2）：必须在 `lib/queue-watch.mjs` 的 `runTick()` 内、
 *   **第 ⑥ 步 saveLedger() 之后**、函数 return 之前，且用 `safeCall()` 包裹。
 *   插在 saveLedger 之前 → 抛错会跳过后台落盘、`result.ok=false`，把生产队列叫醒链拉红。
 *
 * @param {{tasks:Array, revision?:number|string|null, now?:number, home?:string, dryRun?:boolean,
 *          mode?:string, configOverride?:object, announce?:boolean, force?:boolean,
 *          reportPath?:string, deps?:{say?:Function, alert?:Function, log?:Function}, docsRoot?:string,
 *          readArchivedLineCounts?:Function}} opts
 *   `readArchivedLineCounts({home})` —— 可注入（单测/隔离环境给夹具）；缺省 = 直读本机归档批次。
 */
export async function boardCleanupTick(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? dshHome();
  const dryRun = opts.dryRun === true;
  const deps = {
    say: opts.deps?.say ?? ((text, o) => sayWhale(text, { state: 'idle', ...o })),
    alert: opts.deps?.alert ?? ((entry, o) => sendAlert(entry, { home, ...o })),
    log: opts.deps?.log ?? ((msg) => logLine(msg, { now })),
  };
  const result = {
    ok: true, dryRun, now, mode: null, effectiveMode: null, skipped: null,
    counts: null, items: [], deferred: [], suppressed: [], stale: [], closed: [],
    baselineCount: 0, stats: null, wrote: false, daily: null, say: null, watchdog: null,
    stateFile: stateFilePath(home), reportFile: null, error: null,
    /** K3：归档面读数（source/cards/batches/errors）—— 让"另有归档 N 张"可被溯源与断因。 */
    archivedLayer: null,
    /** K5：主账本体积只读读数（{ok,file,bytes,mtimeMs,error}）。 */
    volume: null,
    /** K5：观测项（在板卡数 + 在板体积 + 整线归档建议）—— 日报/面板/CLI 共用同一份。 */
    inBoard: null,
  };

  try {
    const loaded = loadState({ home });
    const cfg = resolveConfig({ state: loaded.state, override: opts.configOverride });
    const mode = MODES.includes(opts.mode) ? opts.mode : cfg.mode;
    result.mode = mode;
    // notify 档 v1 不开：档位可记录，但行为等价 report（不注入会话），并在结果里显式标注
    result.effectiveMode = mode === 'notify' ? 'report' : mode;
    const firstRun = !loaded.exists || loaded.broken;
    result.firstRun = firstRun;
    result.stateBroken = loaded.broken;
    result.stateReason = loaded.reason;

    // 自检信号（A9）：与节流无关地先算；24h 内只报一次
    const wd = watchdogCheck(loaded.state, { now });
    result.watchdog = wd;
    if (wd.due && !dryRun) {
      deps.alert({ level: wd.level, source: 'butler-board-cleanup', message: wd.message, detail: { ...wd, stateFile: result.stateFile, p2Events: P2_EVENTS_POLICY } }, { silent: true });
      // 抑制位落盘（24h 内只报一次）；dry-run 只报告不写
      loaded.state.state.lastAlertAt = now;
      result.watchdog.sent = true;
    }

    const force = opts.force === true || opts.announce === true || dryRun;
    if (!force) {
      const lastCheckAt = num(loaded.state.state.lastCheckAt);
      if (!firstRun && lastCheckAt && (now - lastCheckAt) < cfg.throttleMs) {
        result.skipped = 'throttle';
        return result;
      }
      const lastRev = loaded.state.state.lastRevision;
      if (!firstRun && lastRev !== null && lastRev !== undefined && opts.revision !== null && opts.revision !== undefined
        && String(lastRev) === String(opts.revision)) {
        // revision 未变 → 跳过重算，但**推进运行键**（否则 24h 内看板无变化会被自检信号误报停摆）
        result.skipped = 'revision-unchanged';
        const next = {
          ...loaded.state,
          state: { ...loaded.state.state, lastCheckAt: now, lastResult: 'revision-unchanged' },
          updatedAt: new Date(now).toISOString(),
          device: deviceName(),
        };
        writeStateFile(next, { home, firstRun: false, now });
        result.wrote = true;
        return result;
      }
    }

    // K3 · 归档面读数（「另有归档 N 张」的数据源；直读文件 ⇒ 零 Host 负载；可注入以便单测/隔离）
    //   韧性：**默认实现永不自抛**（`readArchivedLineCountsSafe` 内部已兜），但注入的实现可能抛
    //   ⇒ 这里再包一层，保证"取不到归档数"绝不升级成"整轮判定失败"（判定与文案是两个面）。
    const readArchivedLineCounts = typeof opts.readArchivedLineCounts === 'function'
      ? opts.readArchivedLineCounts
      : readArchivedLineCountsSafe;
    let archivedLayer;
    try {
      archivedLayer = readArchivedLineCounts({ home });
    } catch (e) {
      archivedLayer = {
        ok: false, source: 'error', reason: `read-failed: ${e?.message ?? e}`,
        counts: new Map(), cards: 0, batches: 0, errors: [String(e?.message ?? e)], home: null,
      };
    }
    result.archivedLayer = {
      ok: archivedLayer?.ok === true,
      source: archivedLayer?.source ?? 'error',
      reason: archivedLayer?.reason ?? '',
      cards: archivedLayer?.cards ?? 0,
      batches: archivedLayer?.batches ?? 0,
      lines: archivedLayer?.counts instanceof Map ? archivedLayer.counts.size : 0,
      errors: [...(archivedLayer?.errors ?? [])],
      home: archivedLayer?.home ?? null,
    };
    const evaluation = evaluateBoard(opts.tasks, { now, cfg, revision: opts.revision, archivedLineCounts: archivedLayer?.counts });
    result.counts = evaluation.counts;
    result.revision = evaluation.revision ?? null;

    // K5 · 主账本体积（只读 stat；注入点便于单测/隔离 home 不碰生产账本）
    const volume = typeof opts.readLedgerVolume === 'function'
      ? opts.readLedgerVolume({ home })
      : readLedgerVolume({ home, ledgerPath: opts.ledgerPath });
    result.volume = volume;

    const announce = opts.announce === true;
    // ⚠️ 抑制位（lastAlertAt）必须在 computePlan **内部**盖：RMW 分支会用"刚从磁盘读到的台账"
    //    重算一遍，若只改内存里的 loaded.state，重算会把这一笔盖掉（单测 A9 抓到过）。
    const computePlan = (stateLike) => {
      const merged = mergeState(stateLike);
      if (wd.due && !dryRun) merged.state.lastAlertAt = now;
      // emit：observe 档**不消费通知配额**（不写 lastNotifiedAt / 不累加 notified）
      const p = planRun({ evaluation, state: merged, cfg, now, firstRun, announce, emit: result.effectiveMode !== 'observe' });
      // ⚠️ 落盘的口径必须是**台账里那份**：`--mature-hours` / `configOverride` 是**单轮覆盖**，
      //    写回持久配置 = 静默改掉模块默认口径（实测踩过：throttleMs=0 的调试覆盖被写进生产配置）。
      p.next.config = { ...resolveConfig({ state: merged }) };
      return p;
    };
    let plan = computePlan(loaded.state);

    if (!dryRun) {
      if (firstRun) {
        // 首跑（含坏文件重建）：走原子写；损坏文件先另存 butler-backups/（不静默丢历史）
        if (loaded.broken) result.brokenBackup = backupBrokenState({ home, now });
        const dw = writeStateText(STATE_NAME, JSON.stringify(plan.next, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
        if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
        result.wrote = true;
      } else {
        // RMW：临界区内基于**最新台账**重算 → 与并发 CLI / 另一轮 tick 串行化，绝不覆盖别人刚写的状态
        let finalPlan = plan;
        updateStateJson(STATE_NAME, result.stateFile, (cur) => { finalPlan = computePlan(mergeState(cur)); return finalPlan.next; },
          { schemaVersion: STATE_SCHEMA, home, defaultValue: plan.next });
        plan = finalPlan;
        result.wrote = true;
      }
    }

    result.items = plan.items.map((x) => ({
      line: x.line, rawLine: x.rawLine, live: x.live, archivedCount: x.archivedCount,
      eventKey: x.eventKey, shortKey: shortKey(x.eventKey), lastActivity: x.lastActivity,
      ageHours: x.ageMs === null ? null : Math.round(x.ageMs / 3600_000 * 10) / 10,
      isBaseline: x.isBaseline, brief: formatItemBrief(x),
    }));
    // K5 观测项（在板卡数 + 在板体积 + 整线归档建议）：只读组装，日报/面板/CLI 共用同一份
    result.inBoard = buildInBoardView({
      evaluation, volume,
      notifiedLines: plan.items.length,
      notifiedCards: plan.items.reduce((a, x) => a + (Number(x.live) || 0), 0),
    });
    result.deferred = plan.deferred;
    result.suppressed = plan.suppressed;
    result.stale = plan.stale;
    result.closed = plan.closed;
    result.baselineCount = plan.baselineCount;
    result.stats = plan.stats;
    result.resultText = plan.resultText;
    result.retention = plan.retention;

    // ---- 对外输出（observe = 零对外；dry-run = 零写入）
    const reportFile = opts.reportPath ?? dailyReportPath(now, { docsRoot: opts.docsRoot });
    result.reportFile = reportFile;
    if (!dryRun && result.effectiveMode !== 'observe') {
      const payload = {
        now, mode, cfg, items: plan.items, deferred: plan.deferred, suppressed: plan.suppressed,
        stale: plan.stale, counts: evaluation.counts, baselineCount: plan.baselineCount, stats: plan.stats,
        inBoard: result.inBoard ?? null,
      };
      // K5b 观测小改（2026-09-28）：**无候选也写段** —— 本段的 K5 观测项（在板卡数 / 在板体积 / J1 判据）
      //   原先只在"本轮有候选"或"当日已有该段"时才落盘 ⇒ 没有候选的日子里，观测项在日报里**永远看不见**
      //   （K5 验收时发现）。加 `payload?.inBoard` 后，只要账本体积读得到就写段。
      //   ⚠️ 加 `!firstRun` 是**刻意的**：首跑（状态文件缺失/损坏/schema 不符）按设计"对外零输出、
      //     绝不误报"（单测 A5），字面照加会让冷启动那一轮也写段、当场推翻该契约 ⇒ 首跑仍静默，
      //     第二个 tick 起（生产常态）观测行必现。若主人要"冷启动也写段"，去掉 `!firstRun` 即可。
      const shouldWrite = plan.items.length > 0 || hasSection(reportFile) || (!firstRun && Boolean(payload?.inBoard));
      if (shouldWrite) {
        result.daily = refreshBoardCleanupSection(reportFile, payload, { now, device: deviceName() });
        if (result.daily?.ok) deps.log(`🧾 日报段 ${result.daily.action}：命中 ${plan.items.length} 条 → ${reportFile}`);
      }
      if (plan.items.length) {
        const text = formatWhaleText(payload);
        result.say = await Promise.resolve(deps.say(text, { state: 'idle' })).then((r) => r ?? { ok: true }).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
      }
      for (const it of plan.items) {
        deps.log(`🧾 待清账主线：${formatItemBrief(it)}（键 ${shortKey(it.eventKey)}）`);
      }
      for (const d of plan.deferred) deps.log(`⏳ 待清账主线被上限挤出（deferred）：${d.line}`);
      for (const s of plan.suppressed) deps.log(`🚫 待清账主线压制（${s.reason}）：${s.line}`);
    }
    if (firstRun && plan.baselineCount) {
      deps.log(`🧾 首跑基线：${plan.baselineCount} 条"在板全完成"的线已静默登记（成熟后也不输出，方案 D-2①；要主动看用 --announce）`);
    }
    return result;
  } catch (e) {
    // 失败隔离：本模块的异常绝不外抛（调用点用 safeCall 再兜一层）
    result.ok = false;
    result.error = e?.message ?? String(e);
    // logged 标记：调用点据此判断"这一行日志已由本模块写过"，避免同一失败被记两行
    result.logged = true;
    deps.log(`✘ 看板清账判定失败（已隔离，不影响 queue 台账落盘）：${result.error}`);
    return result;
  }
}

export default boardCleanupTick;
