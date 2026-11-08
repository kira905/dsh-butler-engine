// dsh-butler / lib/card-watchdog.mjs —— 看板卡「假结算 / 假 running」常驻巡检（tickd job `card-watchdog`）
//
// 【为什么有它】外部打断（DSH 重启 / 人为 abort）会让**看板卡状态撒谎**，历史上两类都真实发生过：
//   ① 假结算：卡显示 `review`（待验收），执行会话其实**还在跑** —— [Q3] 已修 runner 不结算 running 卡，
//      但重启批量恢复路径仍会留下这种组合；queue tick 已按 `isExecutionAlive` 兜住「不叫醒」。
//   ② 假 running（僵尸卡）：卡显示 `running`，执行会话**早死了**；而且**无法自愈**
//      ——`running` 是 runner 独占态，`rerun` 报 `task is already running or missing`、`move` 被拒。
//      这一类**至今没有任何巡检覆盖**（queue tick 只看 review 卡），只能靠人肉盯。
//   2026-09-16 主会话实证：盯卡把验收会话拴住、单轮 toolMs 704s、上下文暴涨 → 本模块把「人肉盯卡」
//   换成「机器巡检 + 主动通知」。
//
// 【职责边界（本卡交付纪律）】
//   · **只巡检 + 通知**，绝不自动改卡状态（不 confirm / 不 move / 不 rerun / 不写账本）；
//   · **不复制** `isExecutionAlive`（判据唯一真源在 lib/queue-watch.mjs，本模块直接 import 复用）；
//   · 通知通道复用既有 queue 通道：三档 observe/report/notify（**默认 observe** = 零对外副作用，
//     升档只能显式动作：CLI `--mode` 或配置文件；可选 `followQueue:true` 跟随 butler-queue.json 档位）、
//     目标降级链（卡级绑定 → 主线 owner → 标题【运行】唯一）、桌宠 /whale/say、会话 queue 模式注入、alert。
//
// 【判据（保守：拿不准就不报）】
//   假结算 = status==='review' 且 isExecutionAlive().alive === true（执行会话仍在跑）
//   假 running = status==='running' 且执行会话**已死**：
//       · `session-not-running`：会话在 session.list 里但 running=false
//       · `session-missing`：会话在本机 session.list 里找不到（被归档/清理，或跨机来的卡）
//       · `running-without-execution-record`：卡 running 但既无 executions 也无 sessionId，
//         且已超过 `noExecGraceMs`（默认 15 分钟）—— 真「无主僵尸」
//   **宽限**（防误报，见 DEFAULT_CONFIG）：执行会话最后一次活动距今 < graceMs 不判；
//   正常 running（会话活着）/ done / failed / todo / backlog 一律不算异常。
//
// 【防重复通知】假结算这一类 queue tick 也会看到（它在 review 卡上已按 `execAlive` 标记并升级过）。
//   本模块**只读** queue 台账（~/.dsh/butler-queue-notify.json）：若该卡已被 queue 通知/升级过，
//   本模块只记台账 + 落日报段，**不再重复注入会话**（reason = `deduped-with-queue`）。
//
// 用法（tickd 默认入口 = 无参数跑一轮）：
//   node butler-card-watchdog-tick.mjs [--dry-run] [--json] [--status] [--mode observe|report|notify]
//
// 复用底座（禁止另起一套）：lib/store.mjs（原子写 / RMW / tick 锁）、lib/paths.mjs、
//   lib/queue-watch.mjs（isExecutionAlive / lastExecution / readBoard / readSessions / pickNotifier /
//   pickTarget / resolveBinding / sessionIndex / dailyReportPath — 判据与目标解析的唯一真源）、
//   lib/queue-bindings.mjs（绑定表）、lib/watch-notify.mjs（桌宠 / 会话注入）、lib/alert.mjs。

import fs from 'node:fs';
import path from 'node:path';

import { dshHome, ensureDir } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { readJson, writeTextAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../../src/dsh-butler/lib/dual-write.mjs';
import { updateStateJson } from '../../src/dsh-butler/lib/dual-write-store.mjs';
import { alert as sendAlert } from '../../src/dsh-butler/lib/alert.mjs';
import { sayWhale, notifySession } from '../../src/dsh-butler/lib/watch-notify.mjs';
import { loadBindings, resolveCardBinding, resolveLineOwner, bindingsPath } from '../../src/dsh-butler/lib/queue-bindings.mjs';
import {
  DEFAULT_BASE_URL, RUN_MARK, loadConfig as loadQueueConfig, configPath as queueConfigPath,
  ledgerPath as queueLedgerPath,
  isExecutionAlive, lastExecution, readBoard, readSessions,
  pickNotifier, pickTarget, resolveBinding, sessionIndex, dailyReportPath, deviceName,
} from '../../src/dsh-butler/lib/queue-watch.mjs';

export const CARD_WATCHDOG_VERSION = '0.1.0';
export const WATCHDOG_SCHEMA = 1;
export const WATCHDOG_COMPONENT = 'card-watchdog';

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-card-watchdog.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

export const LEDGER_NAME = 'butler-card-watchdog.json';
export const LOCK_NAME = 'card-watchdog';
export const MODES = ['observe', 'report', 'notify'];
export const KINDS = ['fake-settled', 'fake-running'];

const LOG_MAX_BYTES = 1024 * 1024;
const MAX_DAY_EVENTS = 50;
const MAX_ENTRIES = 500;

/** 默认参数（可被 CLI 覆盖）。 */
export const DEFAULT_CONFIG = {
  schemaVersion: WATCHDOG_SCHEMA,
  // ⚠️ 默认 **observe**（零对外副作用）—— 交付纪律见卡 description「默认关 / observe 档」：
  //   即使有人误开了调度层 job，也只写台账 + 日志，不会打扰任何会话。
  //   要跟随 queue 档位（通知通道同源）请显式 `followQueue: true`。
  mode: 'observe',
  followQueue: false,
  graceMs: 2 * 60_000,        // 假 running 宽限：执行会话最后活动距今 < 2 分钟不判（runner 刚起/刚重启的中间态）
  noExecGraceMs: 15 * 60_000, // running 卡「无 execution 记录」宽限（run 卡到登记会话之间有延迟）
  checkExecutionAlive: true,  // false = 退回「只看 status」（排障用，默认别关）
  dailyReport: true,
  kinds: { 'fake-settled': true, 'fake-running': true },
  dedupeWithQueue: true,      // 假结算已被 queue 通知过 → 本模块不再重复注入
  updatedAt: null,
  updatedBy: null,
};

export const LEDGER_DEFAULT = {
  schemaVersion: WATCHDOG_SCHEMA,
  entries: {},
  day: { day: null, events: [] },
  stats: {
    ticks: 0, fakeSettled: 0, fakeRunning: 0, notified: 0, reported: 0, escalated: 0, cleaned: 0,
    lastTickAt: null, lastMode: null, lastNotify: null, lastError: null,
    byKind: { 'fake-settled': 0, 'fake-running': 0 },
  },
};

// ---------------------------------------------------------------- 小工具

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function hhmm(now = Date.now()) {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function pickNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** 最近活动时刻（多个候选取最大；全无效 → null）。宽限判定用它，不用「第一个有效值」。 */
function pickMax(...vals) {
  let best = null;
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n;
  }
  return best;
}

function minsOf(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  return Math.max(0, Math.round(Number(ms) / 60_000));
}

/** 日志文件（<tmp>，不占 .dsh 状态、不进备份；DSH_CARD_WATCHDOG_LOG 可覆盖）。 */
export function logFile() {
  const tmp = process.env.TEMP || process.env.TMP || '';
  return process.env.DSH_CARD_WATCHDOG_LOG || path.join(tmp || '.', 'dsh-butler-card-watchdog.log');
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

export function ledgerPath(home = dshHome()) {
  return stateFileOf(LEDGER_NAME, { home });
}

// ---------------------------------------------------------------- 配置 / 台账

/**
 * 读配置（缺失 → 默认 observe；显式 `followQueue:true` 才跟随 queue 档位）。
 * 档位口径：**默认最保守**，升档只能显式动作（CLI `--mode` 或配置文件），与 queue 同纪律。
 */
export function loadConfig(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = resolveStatePath('butler-card-watchdog-config.json', { home }).path;
  let raw = null;
  try {
    raw = readJson(file, { schemaVersion: WATCHDOG_SCHEMA, home, defaultValue: null });
  } catch (e) {
    logLine(`⚠️ 读配置失败，回落默认：${e?.message ?? e}`, { quiet: opts.quiet });
  }
  const cfg = {
    ...DEFAULT_CONFIG,
    ...(raw ?? {}),
    kinds: { ...DEFAULT_CONFIG.kinds, ...((raw && raw.kinds) ?? {}) },
    file, exists: Boolean(raw),
  };
  cfg.modeSource = raw && MODES.includes(raw.mode) ? 'file' : 'default';
  if (cfg.followQueue === true && !(raw && MODES.includes(raw.mode))) {
    // 可选：跟随 queue 的档位（通知通道同源；放行一次两个巡检一起升档）
    const q = loadQueueConfig({ home, quiet: true });
    if (MODES.includes(q.mode)) { cfg.mode = q.mode; cfg.modeSource = 'queue'; }
    cfg.queueConfigFile = queueConfigPath(home);
  }
  if (MODES.includes(opts.mode)) { cfg.mode = opts.mode; cfg.modeSource = 'cli'; }
  return cfg;
}

/** 写配置（原子写；CLI `--mode` 用）。 */
export function saveConfig(patch, opts = {}) {
  const home = opts.home ?? dshHome();
  const file = resolveStatePath('butler-card-watchdog-config.json', { home }).path;
  let cur = {};
  try { cur = readJson(file, { schemaVersion: WATCHDOG_SCHEMA, home, defaultValue: {} }) ?? {}; } catch { cur = {}; }
  const next = {
    ...cur, ...patch, schemaVersion: WATCHDOG_SCHEMA,
    updatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    updatedBy: opts.actor ?? process.env.DSH_SESSION_ID ?? 'cli',
  };
  const dw = writeStateText('butler-card-watchdog-config.json', JSON.stringify(next, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return { ok: true, file, config: next };
}

/** 设置档位（跳档 observe→notify 需显式 allowSkipStage，与 queue 同纪律）。 */
export function setMode(mode, opts = {}) {
  if (!MODES.includes(mode)) return { ok: false, error: `mode 必须是 ${MODES.join('|')}` };
  const cur = loadConfig({ home: opts.home, quiet: true });
  if (mode === 'notify' && cur.mode === 'observe' && opts.allowSkipStage !== true) {
    return { ok: false, error: '分档放权路径不许跳档（observe → report → notify）：确认无误后加 --allow-skip-stage', current: cur.mode };
  }
  const r = saveConfig({ mode }, opts);
  return { ok: true, mode, previous: cur.mode, file: r.file };
}

export function loadLedger(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = ledgerPath(home);
  let data = null;
  try {
    data = readJson(file, { schemaVersion: WATCHDOG_SCHEMA, home, defaultValue: null });
  } catch (e) {
    logLine(`⚠️ 读台账失败（按空台账继续）：${e?.message ?? e}`, { quiet: opts.quiet });
  }
  if (!data) return { ...structuredClone(LEDGER_DEFAULT), file, exists: false };
  return {
    ...structuredClone(LEDGER_DEFAULT),
    ...data,
    entries: { ...(data.entries ?? {}) },
    day: { ...LEDGER_DEFAULT.day, ...(data.day ?? {}) },
    stats: { ...LEDGER_DEFAULT.stats, ...(data.stats ?? {}), byKind: { ...LEDGER_DEFAULT.stats.byKind, ...((data.stats ?? {}).byKind ?? {}) } },
    file, exists: true,
  };
}

export function saveLedger(ledger, opts = {}) {
  const home = opts.home ?? dshHome();
  const file = ledgerPath(home);
  const now = opts.now ?? Date.now();
  // 条目上限（超出按 lastSeenAt 升序淘汰最旧；异常卡通常个位数，纯保险）
  let entries = ledger.entries ?? {};
  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) {
    const sorted = keys.sort((a, b) => Number(entries[a]?.lastSeenAt ?? 0) - Number(entries[b]?.lastSeenAt ?? 0));
    const drop = new Set(sorted.slice(0, keys.length - MAX_ENTRIES));
    entries = Object.fromEntries(Object.entries(entries).filter(([k]) => !drop.has(k)));
  }
  const next = {
    schemaVersion: WATCHDOG_SCHEMA,
    device: deviceName(),
    updatedAt: new Date(now).toISOString(),
    entries,
    day: ledger.day ?? LEDGER_DEFAULT.day,
    stats: ledger.stats ?? LEDGER_DEFAULT.stats,
  };
  if (opts.dryRun) return { ok: true, file, dryRun: true };
  updateStateJson(LEDGER_NAME, file, () => next, { schemaVersion: WATCHDOG_SCHEMA, home, defaultValue: next });
  return { ok: true, file };
}

// ---------------------------------------------------------------- 判定（纯函数，单测主战场）

/**
 * 单卡分类（**纯函数**）。
 *
 * @param {object} card 看板卡（需 status / executions / archivedAt / updatedAt）
 * @param {Array} sessions `readSessions().items`（可注入夹具）
 * @param {{now?:number, cfg?:object}} [opts]
 * @returns {{id,title,seq,line,status,kind,reason,sessionId,alive,known,startedAt,endedAt,ageMs,result}}
 *   kind ∈ null | 'fake-settled' | 'fake-running'（null = 正常或不该看的状态）
 */
export function classifyCard(card, sessions, opts = {}) {
  const now = opts.now ?? Date.now();
  const cfg = { ...DEFAULT_CONFIG, ...(opts.cfg ?? {}) };
  const out = {
    id: String(card?.id ?? ''), title: String(card?.title ?? ''), seq: card?.seq ?? null, line: card?.line ?? null,
    status: card?.status ?? null, kind: null, reason: 'unknown', sessionId: null,
    alive: null, known: null, startedAt: null, endedAt: null, ageMs: null, result: null,
  };
  if (!card || !out.id) return { ...out, reason: 'no-card' };
  if (card.archivedAt) return { ...out, reason: 'archived' };
  if (out.status !== 'review' && out.status !== 'running') return { ...out, reason: 'status-not-watched' };

  const alive = isExecutionAlive(card, sessions, { enabled: cfg.checkExecutionAlive !== false, listTrusted: opts.listTrusted });
  // 【2026-09-16 拷问 1.8】`known:false` 有**两个来源**，必须分开对待（旧代码混在一起 ⇒ 空名单被当僵尸）：
  //   · `list-untrusted` = 名单本身不可信（采集异常 / 空列表 / 索引未就绪）⇒ **拿不准，什么都不判**
  //     （既不判假结算也不判僵尸；调用方本来就该整轮跳过，这里再兜一层，防"半可信"路径漏进来）；
  //   · `no-execution`   = 卡自己没有 execution 记录 ⇒ 属"卡数据缺失"，宽限后可判僵尸（原语义保留）。
  if (alive.reason === 'list-untrusted') {
    return { ...out, alive: false, known: false, sessionId: alive.sessionId ?? null, reason: 'list-untrusted' };
  }
  const ex = lastExecution(card);
  out.sessionId = alive.sessionId ?? null;
  out.alive = alive.alive === true;
  out.known = alive.known === true;
  out.startedAt = ex?.startedAt ?? null;
  out.endedAt = ex?.endedAt ?? null;
  out.result = ex?.result ?? null;

  const idx = sessionIndex(sessions);
  const s = out.sessionId ? (idx.get(String(out.sessionId)) ?? null) : null;
  // 「最后活动」= 执行维度最近时刻（会话 updatedAt / execution.endedAt / startedAt 取最大）；
  // 执行维度全无（如 session-missing 且无 execution 时间）才回落到卡记录 updatedAt。
  // ⚠️ 刻意**不把 card.updatedAt 混进 max**：改卡 description 会刷新它，那不该让"僵尸"看起来刚活着。
  const activity = pickMax(s?.updatedAt, out.endedAt, out.startedAt);
  const lastActivity = activity ?? pickNum(Number(card?.updatedAt ?? 0));
  out.ageMs = lastActivity ? Math.max(0, now - lastActivity) : null;

  if (out.status === 'review') {
    if (out.known && out.alive) return { ...out, kind: 'fake-settled', reason: 'review-but-exec-running' };
    return { ...out, reason: out.known ? 'review-ok' : 'review-no-exec-data' };
  }

  // status === 'running'
  if (!out.known) {
    // 无 execution / 无 sessionId：run 卡到登记会话之间有延迟 → 宽限内不判
    if (out.ageMs === null || out.ageMs < Number(cfg.noExecGraceMs)) return { ...out, reason: 'running-no-record-grace' };
    return { ...out, kind: 'fake-running', reason: 'running-without-execution-record' };
  }
  if (out.alive) return { ...out, reason: 'running-ok' };
  if (out.ageMs !== null && out.ageMs < Number(cfg.graceMs)) return { ...out, reason: 'running-dead-grace' };
  return {
    ...out,
    kind: 'fake-running',
    reason: alive.reason === 'session-missing' ? 'session-missing' : 'session-not-running',
  };
}

/**
 * 全量扫描（**纯函数**）：返回两类异常清单 + 统计。
 * @param {{tasks?:Array, sessions?:Array, now?:number, cfg?:object, listTrusted?:boolean}} input
 *   `listTrusted:false`（列表不可信）⇒ 逐卡判 `known:false`，**不产任何异常**（拷问 1.8）
 */
export function detectAnomalies(input = {}) {
  const now = input.now ?? Date.now();
  const cfg = { ...DEFAULT_CONFIG, ...(input.cfg ?? {}) };
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const out = {
    scanned: tasks.length, watched: 0, ok: 0, byStatus: {}, byReason: {},
    fakeSettled: [], fakeRunning: [], all: [],
  };
  for (const card of tasks) {
    const c = classifyCard(card, sessions, { now, cfg, listTrusted: input.listTrusted });
    out.byReason[c.reason] = (out.byReason[c.reason] ?? 0) + 1;
    if (c.status === 'review' || c.status === 'running') {
      out.watched++;
      out.byStatus[c.status] = (out.byStatus[c.status] ?? 0) + 1;
    }
    if (c.kind === 'fake-settled' && cfg.kinds?.['fake-settled'] !== false) out.fakeSettled.push(c);
    else if (c.kind === 'fake-running' && cfg.kinds?.['fake-running'] !== false) out.fakeRunning.push(c);
    else out.ok++;
    out.all.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- 目标解析（复用 queue 的降级链）

/**
 * 逐卡解析通知目标（**纯函数**；复用 queue 的降级链：卡级绑定 → 主线 owner → 标题【运行】唯一）。
 * @returns {{anomaly:object, target:object}}
 */
export function resolveTargets(input = {}) {
  const bindings = input.bindings ?? null;
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const idx = sessionIndex(sessions);
  const notifier = input.notifier ?? pickNotifier(sessions, { targetPrefix: RUN_MARK });
  const rows = [];
  for (const a of [...(input.fakeSettled ?? []), ...(input.fakeRunning ?? [])]) {
    const binding = bindings ? resolveBinding(resolveCardBinding(bindings, a.id), idx, { source: 'binding' }) : null;
    const lineOwner = bindings ? resolveBinding(resolveLineOwner(bindings, a.line), idx, { source: 'line-owner' }) : null;
    rows.push({ anomaly: a, target: pickTarget({ binding, lineOwner, notifier }) });
  }
  return { notifier, rows };
}

// ---------------------------------------------------------------- 台账条目 / 动作判定

export function newEntry(a, now) {
  return {
    cardId: a.id, title: a.title, seq: a.seq ?? null, line: a.line ?? null,
    kind: a.kind, reason: a.reason, status: a.status,
    sessionId: a.sessionId ?? null, startedAt: a.startedAt ?? null, ageMs: a.ageMs ?? null,
    firstSeenAt: now, lastSeenAt: now,
    notifiedAt: null, notifiedTo: null, notifyMode: null, targetSource: null,
    reportedAt: null, escalatedAt: null, dedupeReason: null,
  };
}

/**
 * 判定（**纯函数**）：给定台账条目 + 异常 + 目标 + queue 台账条目 + 档位 → 一个动作。
 *
 * action ∈ cleanup | observe | report | notify | escalate | skip
 *   cleanup  异常消失（或卡不再被巡检）→ 删台账条目
 *   observe  observe 档首见（只记台账 + 日志，零对外副作用）
 *   report   report 档首见（日报段 + 桌宠，不注入会话）
 *   notify   notify 档 + 有可用且空闲的目标 → 注入会话
 *   escalate 通知不出去（无目标 / 目标在跑 / 与 queue 重复）→ 桌宠 + 日报段 + alert
 *   skip     无事可做（已通知过 / 目标在跑排队）
 */
export function decide(input) {
  const { entry, anomaly, target = null, queueEntry = null, now, mode = 'observe', cfg = DEFAULT_CONFIG } = input;
  if (!anomaly) {
    return entry ? { action: 'cleanup', remove: true, reason: 'anomaly-gone' } : { action: 'skip', reason: 'nothing' };
  }
  const st = entry ? { ...entry } : newEntry(anomaly, now);
  st.title = anomaly.title;
  st.seq = anomaly.seq ?? st.seq ?? null;
  st.line = anomaly.line ?? st.line ?? null;
  st.kind = anomaly.kind;
  st.reason = anomaly.reason;
  st.status = anomaly.status;
  st.sessionId = anomaly.sessionId ?? null;
  st.ageMs = anomaly.ageMs ?? null;
  st.lastSeenAt = now;
  const t = target ?? { source: 'none', kind: 'none', count: 0, sessionId: null, running: null, candidates: [] };
  st.targetSource = t.source;

  // 已投递过 → 只更新现场，不再刷屏（异常消失后重新出现才是新事件）
  if (st.notifiedAt || st.reportedAt || st.escalatedAt) {
    return { action: 'skip', reason: 'already-notified', patch: st, detail: { target: t } };
  }

  // 与 queue 去重：假结算已被 queue 通知/升级过 → 本模块只记台账，不重复注入
  const dedupe = cfg.dedupeWithQueue !== false && anomaly.kind === 'fake-settled'
    && queueEntry && (queueEntry.notifiedAt || queueEntry.escalatedAt);
  if (dedupe) {
    return {
      action: 'observe', reason: 'deduped-with-queue',
      patch: { ...st, dedupeReason: 'queue-already-notified' },
      detail: { target: t, queueEntry: { notifiedAt: queueEntry.notifiedAt ?? null, escalatedAt: queueEntry.escalatedAt ?? null } },
    };
  }

  if (mode === 'observe') {
    return entry
      ? { action: 'skip', reason: 'observed', patch: st, detail: { target: t } }
      : { action: 'observe', reason: 'first-seen', patch: st, detail: { target: t } };
  }

  if (mode === 'report') {
    return { action: 'report', reason: 'report-mode', patch: { ...st, reportedAt: now }, detail: { target: t } };
  }

  // notify 档
  if (t.source === 'none' || !t.sessionId) {
    return {
      action: 'escalate', reason: t.kind === 'ambiguous' ? 'ambiguous-target' : 'no-target',
      patch: { ...st, escalatedAt: now }, detail: { target: t },
    };
  }
  if (t.running === true) {
    // 目标在跑 → 绝不注入（发消息 = 打断当前回合）；留在台账，下轮再看（不升级、不重复）
    return { action: 'skip', reason: 'target-busy', patch: st, detail: { target: t } };
  }
  return {
    action: 'notify', reason: 'target-idle',
    patch: { ...st, notifiedAt: now, notifiedTo: t.sessionId, notifyMode: mode },
    detail: { target: t },
  };
}

/** 整轮判定（纯函数）：异常清单 + 台账 + 目标 → 动作计划。 */
export function planTick(input = {}) {
  const { anomalies, entries = {}, targets = { rows: [], notifier: null }, queueEntries = {}, now, mode, cfg } = input;
  const plan = [];
  const seen = new Set();
  for (const row of targets.rows ?? []) {
    const a = row.anomaly;
    seen.add(a.id);
    plan.push({
      anomaly: a, target: row.target, entry: entries[a.id] ?? null,
      decision: decide({
        entry: entries[a.id] ?? null, anomaly: a, target: row.target,
        queueEntry: queueEntries[a.id] ?? null, now, mode, cfg,
      }),
    });
  }
  for (const [cardId, entry] of Object.entries(entries)) {
    if (seen.has(cardId)) continue;
    plan.push({ anomaly: null, target: null, entry, decision: decide({ entry, anomaly: null, now, mode, cfg }) });
  }
  return plan;
}

// ---------------------------------------------------------------- 通知文案

export function kindLabel(kind) {
  return kind === 'fake-settled' ? '假结算（卡在待验收、执行会话仍在跑）' : '假 running（卡在进行中、执行会话已死）';
}

export function reasonLabel(reason) {
  return {
    'review-but-exec-running': '执行会话仍在运行',
    'session-not-running': '执行会话已结束（running=false）',
    'session-missing': '执行会话在本机 session.list 中不存在（被归档/清理，或跨机卡）',
    'running-without-execution-record': '没有 executions 记录 / 没有 sessionId（无主僵尸）',
  }[reason] ?? reason;
}

/** 会话注入文案（notify 档）。 */
export function formatNotifyText(ctx) {
  const { anomaly, now } = ctx;
  const head = anomaly.kind === 'fake-settled'
    ? '🐳 管家盯卡巡检：疑似**假结算**'
    : '🐳 管家盯卡巡检：疑似**假 running（僵尸卡）**';
  const age = minsOf(anomaly.ageMs);
  const lines = [
    head,
    '',
    `- 卡：「${anomaly.title}」${anomaly.seq ? `（${anomaly.seq}）` : ''}${anomaly.line ? ` · 主线 ${anomaly.line}` : ''}`,
    `- 看板状态：**${anomaly.status === 'review' ? '待验收' : '进行中'}** · 判据：${reasonLabel(anomaly.reason)}`,
    `- 执行会话：\`${anomaly.sessionId ?? '（无）'}\`${age === null ? '' : ` · 最后活动约 ${age} 分钟前`}`,
  ];
  if (anomaly.kind === 'fake-settled') {
    lines.push('- 建议：先核实该执行会话是否真结束、交付是否完整，**不要直接 confirm**。');
  } else {
    lines.push('- 建议：卡会卡在「进行中」且**无法自愈**（rerun 报 already running、move 被拒）→ 需要人工处置（或另开卡放行自动收口）。');
  }
  lines.push(`- 巡检时刻：${hhmm(now)} · 管家**只巡检不自动改卡状态**（confirm/move/run 一律不碰）。`);
  lines.push('');
  lines.push('> 这是管家自动提醒，非主人发言；忽略本条即可。');
  return lines.join('\n');
}

/** 桌宠一句话。 */
export function formatSayText(anomaly) {
  const kind = anomaly.kind === 'fake-settled' ? '假结算' : '假 running';
  const short = String(anomaly.title ?? '').slice(0, 24);
  return `🐳 盯卡巡检：${kind} —— ${short}`;
}

export function formatEscalateText(ctx) {
  const { anomaly, target, reason, now } = ctx;
  const why = {
    'no-target': '没有可投递的目标会话（卡级绑定/主线 owner 都没有，标题【运行】的会话 = 0）',
    'ambiguous-target': '目标会话不唯一（标题【运行】的会话 ≥2）→ 宁可不发',
    'target-busy': '目标会话正在跑（不打断），下轮重试',
    'deduped-with-queue': 'queue tick 已就同一张卡通知过（不重复注入）',
  }[reason] ?? reason;
  return `🐳⏫ 盯卡巡检升级：${kindLabel(anomaly.kind)} —— 卡「${anomaly.title}」${anomaly.seq ? `（${anomaly.seq}）` : ''}`
    + ` · 执行会话 ${anomaly.sessionId ?? '（无）'} · ${hhmm(now)} 未能注入提醒（${why}）→ 请主人/推进者处置`;
}

// ---------------------------------------------------------------- 日报段

/**
 * 刷新日报里的「## 🐕 盯卡巡检」段（幂等整段替换；**不碰**其他段）。
 * 位置口径与 queue 段一致：找自己段名替换；没有则追加到文件末尾。
 */
export function refreshWatchdogSection(file, payload, opts = {}) {
  const now = opts.now ?? Date.now();
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const mode = payload?.mode ?? 'observe';
  const eolProbe = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = eolProbe.includes('\r\n') ? '\r\n' : '\n';
  const block = [];
  block.push('## 🐕 盯卡巡检（管家 · 自动）');
  block.push('');
  block.push(`- 档位：**${mode}**（${payload?.modeSource ?? 'default'}） · 最近刷新 ${hhmm(now)} · 设备 ${opts.device ?? deviceName()}`);
  block.push(`- 本轮：扫 ${payload?.scanned ?? 0} 张卡（review ${payload?.byStatus?.review ?? 0} / running ${payload?.byStatus?.running ?? 0}）`
    + ` → 假结算 **${payload?.fakeSettled ?? 0}** · 假 running **${payload?.fakeRunning ?? 0}**`);
  const st = payload?.stats ?? {};
  block.push(`- 累计：tick ${st.ticks ?? 0} · 注入 ${st.notified ?? 0} · 日报 ${st.reported ?? 0} · 升级 ${st.escalated ?? 0}`
    + `（fake-settled ${st.byKind?.['fake-settled'] ?? 0} / fake-running ${st.byKind?.['fake-running'] ?? 0}）`);
  if (payload?.lastNotify) {
    const ln = payload.lastNotify;
    block.push(`- 上次投递：${hhmm(Number(ln.at) || now)} ${ln.kind}${ln.ok === false ? '（**失败**）' : ''}`
      + `${ln.title ? `：**${ln.title}**` : ''}${ln.sessionId ? ` → \`${String(ln.sessionId).slice(0, 28)}…\`` : ''} · 来源 ${ln.source ?? 'none'}`);
  } else {
    block.push('- 上次投递：（暂无记录）');
  }
  if (!rows.length) block.push('- 本轮无异常（假结算 0 / 假 running 0）。');
  else {
    for (const r of rows.slice(0, 20)) {
      const icon = r.kind === 'fake-settled' ? '🧾' : '🧟';
      block.push(`- ${hhmm(Number(r.at) || now)} ${icon} ${r.kind}：**${r.title}**${r.seq ? `（${r.seq}）` : ''}`
        + ` · ${reasonLabel(r.reason)} · 执行会话 \`${String(r.execSessionId ?? '（无）').slice(0, 28)}\``
        + ` · 处置 ${r.action}${r.targetSessionId ? ` → \`${String(r.targetSessionId).slice(0, 28)}\`` : ''}${r.detail ? `（${r.detail}）` : ''}`);
    }
  }
  block.push('');
  block.push('> 由 `<pkg>/jobs/butler-card-watchdog-tick.mjs` 巡检（tickd job `card-watchdog`，**默认关**）。');
  block.push('> **只巡检 + 通知，绝不自动改卡状态**；判据 = `lib/queue-watch.mjs` 的 `isExecutionAlive`（与 queue tick 同源）。');

  if (opts.dryRun) return { ok: true, action: 'dry-run', file };

  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) {
      const header = [
        `# 管家日报 · ${dayKey(now)}`,
        '',
        `> 由 \`butler-card-watchdog-tick.mjs\` 于 ${hhmm(now)} 创建（原日报未生成时的兜底）。`,
        '',
      ].join(eol);
      fs.writeFileSync(file, header, 'utf8');
    }
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = lines.findIndex((l) => /^##\s*🐕\s*盯卡巡检/.test(l));
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

// ---------------------------------------------------------------- tick 主流程

/**
 * 跑一轮（依赖全部可注入，便于单测断言「零注入 / 零副作用」）。
 *
 * @param {object} opts
 *   home / baseUrl / now / mode / dryRun / json
 *   board / sessions      直接注入夹具数据（单测 / 隔离演练用，跳过 HTTP）
 *   boardFile / sessionsFile  从 JSON 文件读夹具（隔离环境用）
 *   docsRoot              日报根（隔离演练用；默认 <workspace>\docs\管家报告）
 *   cfgOverride           临时覆盖配置（不落盘）
 *   deps { readBoard, readSessions, inject, say, alert, writeDaily, loadBindings }
 */
export async function runTick(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? dshHome();
  const cfg = { ...loadConfig({ home, mode: opts.mode }), ...(opts.cfgOverride ?? {}) };
  const mode = MODES.includes(opts.mode) ? opts.mode : (MODES.includes(cfg.mode) ? cfg.mode : 'observe');
  const dryRun = opts.dryRun === true;
  const deps = {
    readBoard: opts.deps?.readBoard ?? readBoard,
    readSessions: opts.deps?.readSessions ?? readSessions,
    inject: opts.deps?.inject ?? ((sid, text, o) => notifySession(sid, text, { baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL, ...o })),
    say: opts.deps?.say ?? ((text, o) => sayWhale(text, { baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL, ...o })),
    alert: opts.deps?.alert ?? ((entry, o) => sendAlert(entry, { home, ...o })),
    writeDaily: opts.deps?.writeDaily ?? refreshWatchdogSection,
    loadBindings: opts.deps?.loadBindings ?? loadBindings,
  };
  const calls = { inject: 0, say: 0, alert: 0, daily: 0, notifyTargets: [] };
  const result = {
    ok: true, mode, modeSource: cfg.modeSource ?? null, dryRun, now, home,
    ledgerFile: ledgerPath(home), bindingsFile: bindingsPath(home), docsRoot: opts.docsRoot ?? null,
    anomalies: null, actions: [], entries: 0, calls, daily: null, error: null,
  };

  try {
    // 1) 采集（HTTP 或夹具）
    let tasks = null;
    let sessions = null;
    if (Array.isArray(opts.board)) tasks = opts.board;
    else if (opts.boardFile) tasks = JSON.parse(fs.readFileSync(opts.boardFile, 'utf8'))?.tasks ?? JSON.parse(fs.readFileSync(opts.boardFile, 'utf8'));
    if (Array.isArray(opts.sessions)) sessions = opts.sessions;
    else if (opts.sessionsFile) {
      const j = JSON.parse(fs.readFileSync(opts.sessionsFile, 'utf8'));
      sessions = Array.isArray(j) ? j : (j.items ?? []);
    }
    if (tasks === null) {
      const b = await deps.readBoard({ baseUrl: opts.baseUrl });
      if (!b.ok) {
        result.ok = false; result.action = 'collect-failed'; result.error = `看板采集失败：${b.error}`;
        result.board = { ok: false, error: b.error };
        return result;
      }
      tasks = b.tasks;
      result.board = { ok: true, revision: b.revision ?? null, tasks: tasks.length };
    } else {
      result.board = { ok: true, source: opts.boardFile ? 'file' : 'inject', tasks: tasks.length };
    }
    if (sessions === null) {
      const s = await deps.readSessions({ baseUrl: opts.baseUrl });
      // 【2026-09-16 拷问 1.8】空列表 = 列表不可信（索引未就绪 / 采集半途）：**整轮跳过**，
      //   绝不拿"名单里没有"当"会话不在了" —— notify 档下那会把一批卡误判僵尸并逐条注入。
      //   夹具路径（`opts.sessions` 显式注入）不受此判：注入即"已知且可信"，空数组也不拦。
      const empty = s.ok === true && Array.isArray(s.items) && s.items.length === 0;
      if (!s.ok || empty) {
        const why = empty ? 'empty-list（会话列表为空 = 不可信，宁可不巡检）' : s.error;
        result.ok = false; result.action = 'collect-failed'; result.error = `会话列表采集失败：${why}`;
        result.sessions = { ok: false, error: why, trusted: false };
        return result;
      }
      sessions = s.items;
      result.sessions = { ok: true, items: sessions.length, trusted: true };
    } else {
      result.sessions = { ok: true, source: opts.sessionsFile ? 'file' : 'inject', items: sessions.length };
    }

    // 2) 判定
    const anomalies = detectAnomalies({ tasks, sessions, now, cfg });
    result.anomalies = {
      scanned: anomalies.scanned, watched: anomalies.watched, ok: anomalies.ok, byStatus: anomalies.byStatus, byReason: anomalies.byReason,
      fakeSettled: anomalies.fakeSettled, fakeRunning: anomalies.fakeRunning,
    };

    // 3) 目标解析（复用 queue 降级链）
    const bindings = deps.loadBindings({ home });
    const targets = resolveTargets({ fakeSettled: anomalies.fakeSettled, fakeRunning: anomalies.fakeRunning, bindings, sessions });
    result.notifier = { kind: targets.notifier.kind, count: targets.notifier.count };

    // 4) 台账 + queue 台账（只读，去重用）
    const ledger = opts.ledger ?? loadLedger({ home });
    let queueEntries = {};
    if (opts.queueLedger === undefined) {
      try {
        const ql = readJson(queueLedgerPath(home), { schemaVersion: 1, home, defaultValue: null });
        queueEntries = (ql && typeof ql === 'object' && ql.entries && typeof ql.entries === 'object') ? ql.entries : {};
      } catch { queueEntries = {}; }
    } else {
      queueEntries = opts.queueLedger?.entries ?? {};
    }

    // 5) 判定 + 执行动作
    const plan = planTick({ anomalies, entries: ledger.entries ?? {}, targets, queueEntries, now, mode, cfg });
    const entries = { ...(ledger.entries ?? {}) };
    const day = ledger.day?.day === dayKey(now) ? { ...ledger.day, events: [...(ledger.day?.events ?? [])] } : { day: dayKey(now), events: [] };
    const stats = {
      ...LEDGER_DEFAULT.stats, ...(ledger.stats ?? {}),
      byKind: { ...LEDGER_DEFAULT.stats.byKind, ...((ledger.stats ?? {}).byKind ?? {}) },
      ticks: Number(ledger.stats?.ticks ?? 0) + 1,
      lastTickAt: new Date(now).toISOString(), lastMode: mode,
      fakeSettled: anomalies.fakeSettled.length, fakeRunning: anomalies.fakeRunning.length,
    };

    for (const row of plan) {
      const { entry, anomaly, target, decision } = row;
      const cardId = anomaly?.id ?? entry?.cardId;
      const event = {
        at: now, cardId, kind: anomaly?.kind ?? entry?.kind ?? null, reason: decision.reason,
        title: anomaly?.title ?? entry?.title ?? null, seq: anomaly?.seq ?? entry?.seq ?? null,
        action: decision.action, detail: decision.detail?.target?.source ?? null,
      };
      if (decision.action === 'skip' || decision.action === 'report' || decision.action === 'escalate') {
        // 这三个动作也可能带 patch（现场更新 / 标记），照常落台账
      }
      if (decision.remove) {
        delete entries[cardId];
        stats.cleaned = Number(stats.cleaned ?? 0) + 1;
      } else if (decision.patch) {
        entries[cardId] = decision.patch;
      }
      if (anomaly) stats.byKind[anomaly.kind] = Number(stats.byKind[anomaly.kind] ?? 0) + 1;

      // 执行对外动作（dry-run / observe 一律零副作用）
      if (decision.action === 'notify' && !dryRun) {
        const text = formatNotifyText({ anomaly, entry: decision.patch, now, cfg });
        const r = await safeCall(() => deps.inject(decision.patch.notifiedTo, text), { ok: false, error: 'inject-threw' });
        calls.inject++;
        calls.notifyTargets.push(decision.patch.notifiedTo);
        const ok = r?.ok !== false;
        stats.notified = Number(stats.notified ?? 0) + (ok ? 1 : 0);
        stats.lastNotify = { at: now, kind: 'notify', ok, sessionId: decision.patch.notifiedTo, source: target?.source ?? 'none', title: anomaly.title, seq: anomaly.seq ?? null };
        if (!ok) entries[cardId] = { ...entries[cardId], notifiedAt: null, lastError: String(r?.error ?? 'notify-failed').slice(0, 200) };
        event.action = ok ? 'notify' : 'notify-failed';
        event.detail = `${target?.source ?? 'none'}${ok ? '' : ` · ${r?.error ?? ''}`}`;
        day.events.push(event);
      } else if (decision.action === 'report' && !dryRun) {
        const say = await safeCall(() => deps.say(formatSayText(anomaly)), { ok: false });
        calls.say++;
        // 【2026-10-21 · V3 功能面 C 段】桌宠通道**默认关**（`lib\watch-notify.mjs#resolveWhaleChannel`）；
        //   关掉时 `say` 回 `{ ok:false, skipped:true }` —— 那是**设计如此**，不是失败：
        //   台账必须把「通道关」与「发送失败」分开记，否则每天几十条"桌宠（失败）"变成假故障噪声。
        const saySkipped = say?.skipped === true;
        const ok = say?.ok !== false;
        stats.reported = Number(stats.reported ?? 0) + (ok ? 1 : 0);
        if (saySkipped) stats.saySkipped = Number(stats.saySkipped ?? 0) + 1;
        stats.lastNotify = { at: now, kind: 'report', ok, skipped: saySkipped, sessionId: null, source: target?.source ?? 'none', title: anomaly.title, seq: anomaly.seq ?? null };
        event.detail = saySkipped ? '桌宠（通道关 · 默认）' : `桌宠${ok ? '' : '（失败）'}`;
        day.events.push(event);
      } else if (decision.action === 'escalate' && !dryRun) {
        const text = formatEscalateText({ anomaly, target: decision.detail?.target, reason: decision.reason, now });
        const say = await safeCall(() => deps.say(text), { ok: false });
        calls.say++;
        await safeCall(() => deps.alert({ level: 'warn', source: 'card-watchdog', message: text, detail: { cardId, kind: anomaly.kind, reason: anomaly.reason, target: decision.detail?.target ?? null } }, { silent: true }), null);
        calls.alert++;
        stats.escalated = Number(stats.escalated ?? 0) + 1;
        stats.lastNotify = { at: now, kind: 'escalate', ok: say?.ok !== false, skipped: say?.skipped === true, sessionId: target?.sessionId ?? null, source: target?.source ?? 'none', title: anomaly.title, seq: anomaly.seq ?? null };
        event.detail = decision.reason;
        day.events.push(event);
      } else if (decision.action === 'observe') {
        event.detail = decision.reason;
        day.events.push(event);
      }

      result.actions.push({
        action: event.action, reason: decision.reason, cardId,
        title: anomaly?.title ?? entry?.title ?? null, seq: anomaly?.seq ?? entry?.seq ?? null,
        kind: anomaly?.kind ?? entry?.kind ?? null, targetSource: target?.source ?? null,
        execSessionId: anomaly?.sessionId ?? entry?.sessionId ?? null,
        targetSessionId: decision.patch?.notifiedTo ?? target?.sessionId ?? null,
        ok: event.action === 'notify-failed' ? false : undefined,
        detail: event.detail,
      });
    }

    // 6) 落盘（dry-run 不落）
    day.events = day.events.slice(-MAX_DAY_EVENTS);
    ledger.entries = entries;
    ledger.day = day;
    ledger.stats = stats;
    result.entries = Object.keys(entries).length;
    result.stats = stats;
    result.plan = plan.map((p) => ({
      cardId: p.anomaly?.id ?? p.entry?.cardId, kind: p.anomaly?.kind ?? null,
      action: p.decision.action, reason: p.decision.reason, targetSource: p.target?.source ?? null,
    }));
    const saved = saveLedger(ledger, { home, now, dryRun });
    result.ledger = { ok: saved.ok, dryRun: Boolean(saved.dryRun), file: saved.file, entries: result.entries };
    result.ledgerFile = saved.file;

    // 7) 日报段（report / notify 档；observe 档只写台账 + 日志，与 queue 同纪律）
    if (cfg.dailyReport !== false && mode !== 'observe') {
      const rows = result.actions.filter((a) => a.action !== 'skip' && a.detail !== 'already-notified').map((a) => ({
        at: now, kind: a.kind, title: a.title, seq: a.seq, reason: a.reason,
        execSessionId: a.execSessionId, targetSessionId: a.targetSessionId, action: a.action, detail: a.detail,
      }));
      const file = opts.dailyFile ?? dailyReportPath(now, { docsRoot: opts.docsRoot });
      const r = deps.writeDaily(file, {
        mode, modeSource: cfg.modeSource ?? 'default', scanned: anomalies.scanned, byStatus: anomalies.byStatus,
        fakeSettled: anomalies.fakeSettled.length, fakeRunning: anomalies.fakeRunning.length,
        rows, stats, lastNotify: stats.lastNotify ?? null,
      }, { now, dryRun: dryRun || opts.noDaily === true });
      result.daily = r;
      calls.daily = 1;
    }

    logLine(`tick ${mode}${dryRun ? '(dry-run)' : ''}：扫 ${anomalies.scanned} 张 → 假结算 ${anomalies.fakeSettled.length} / 假 running ${anomalies.fakeRunning.length}`
      + ` · 动作 ${result.actions.filter((a) => a.action !== 'skip').length} 条`, { now });
    return result;
  } catch (e) {
    result.ok = false;
    result.error = e?.message ?? String(e);
    try { logLine(`⚠️ tick 异常：${e?.stack ?? e}`, { now }); } catch { /* ignore */ }
    return result;
  }
}

async function safeCall(fn, fallback) {
  try { return await fn(); } catch (e) { return { ok: false, error: e?.message ?? String(e), ...(fallback ?? {}) }; }
}

// ---------------------------------------------------------------- 汇总（--status）

export function summarize(ledger, opts = {}) {
  const now = opts.now ?? Date.now();
  const entries = Object.entries(ledger?.entries ?? {});
  const rows = entries.map(([cardId, e]) => ({
    cardId, title: e.title ?? null, seq: e.seq ?? null, line: e.line ?? null, kind: e.kind ?? null,
    reason: e.reason ?? null, status: e.status ?? null, sessionId: e.sessionId ?? null,
    firstSeenAt: e.firstSeenAt ?? null, lastSeenAt: e.lastSeenAt ?? null,
    ageMin: e.firstSeenAt ? Math.round(Math.max(0, now - Number(e.firstSeenAt)) / 60_000) : null,
    notifiedAt: e.notifiedAt ?? null, notifiedTo: e.notifiedTo ?? null, targetSource: e.targetSource ?? null,
    reportedAt: e.reportedAt ?? null, escalatedAt: e.escalatedAt ?? null, dedupeReason: e.dedupeReason ?? null,
  })).sort((a, b) => Number(b.lastSeenAt ?? 0) - Number(a.lastSeenAt ?? 0));
  return {
    entries: rows.length, rows,
    kindCounts: rows.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {}),
    stats: ledger?.stats ?? LEDGER_DEFAULT.stats,
    day: ledger?.day ?? LEDGER_DEFAULT.day,
  };
}
