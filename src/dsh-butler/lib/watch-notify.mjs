// dsh-butler / lib/watch-notify.mjs —— P2 通知通道适配器（DSH 会话 / 报告文件 / 可选桌宠）
//
// 方案：docs/ §4 P2（行 544-548）
//   通道优先级：①桌宠（A9 补丁后可用 POST /whale/say）②DSH 会话（守护鱼 notify 目标，
//   宁可不发也不发错）③报告文件（兜底，永远写）。
//
// 【2026-10-21 · V3 功能面 C 段「桌宠不再背告警」】通道顺序**改了**（原顺序作废，仅留作沿革）：
//   主通道 = ①DSH 会话 queue（P2 会盯人，真能喊到人）②报告文件（永远写）③独立告警日志（lib\alert.mjs → ops-alert.log）；
//   桌宠 `/whale/say` 降为**可选、默认关**——它只是"好看的一眼"，不承担告警责任（单条 180 字符，
//   主人不看屏幕就收不到，且会在前台刷屏）。
//   · 开关载体 = `butler-autonomy-limits.json` 的 `watchChannels.whale`（**零新增状态文件**，
//     与 `ctxGuard.steer` 同款：该文件已登记 persistent，语义正是"主人设定的护栏"）。
//   · **未配置 = 关**（判据：封口清单 §1 第 6 条前半"桌宠不再背告警"）。
//   · 一键开回 / 关回 = `node <butler-root>\tools\dsh-butler\butler-watch-channels.mjs on|off --apply`
//     （默认 dry-run；`--json` 机读；`status` 只读）。
//   · 闸放在 `sayWhale()` 内 ⇒ **所有自动出话口**（P2 告警 / 卡死提醒 / 队列提示 / 收纳摘要）
//     一并受管，不会出现"主链关了、别处还在刷屏"的半覆盖状态。
// 【2026-10-21 · V3 功能面 C2「会话通道心跳目标」】会话通道另有一条**兜底目标**：
//   缺口 = `<DSH>\logs\guard-session.id` 只在「从会话内触发重启」时写一次（`dsh-restart.ps1:585`），
//     守护鱼只读不写 ⇒ dsh 连续运行超 15 分钟后，会话通道**结构性不可达**（取证见
//     `docs/` §4）。
//   修法 = 只读侧兜底（**不动任何写者**）：P2 每轮把「最近活跃会话 id + 活动时间（会话文件 mtime）」
//     写进**已登记**的 `butler-watch-state.json#sessionHeartbeat`（零新增状态文件），
//     本模块在 `guard-session.id` 全部陈旧时读它 —— **心跳自己也过同一个 15 分钟新鲜窗**
//     （`at` 是真实活动时间、不是 `now` ⇒ 不会偷偷放宽 TTL）。
//   开关 = `butler-autonomy-limits.json#watchChannels.sessionHeartbeat.enabled`，**缺省开**
//     （这是修"喊不到人"的 bug，不是新能力）；关回 = `butler-watch-channels.mjs heartbeat off --apply`。
//   判不出来 ⇒ 仍回 `source:'none'` 并带 `reason`（宁可不发也不发错）。
// 【2026-10-21 · V3 功能面 C 补「外部通道腿」】通道再加**第 ④ 路 = 外部通道**（`lib\alert-hub.mjs`）：
//   走 <peer> 上那条已持有的 hub 长连接（`POST /push` · `x-hub-token` · 只发主人本人单聊），
//   通路 = 告警时**按需**起一条 `ssh -N -L 18080` 转发、发完即关（<peer> 零改动、零常驻端口）。
//   开关 = `butler-alert.json#channels.alert`（或单轮 `alertChannel` 覆盖），**代码缺省关**
//     （本卡施工时按主人 16:55 拍板显式开）；关回 = `butler-watch-channels.mjs alert off --apply`。
//   失败语义：缺令牌 / 隧道不通 / hub 4xx 一律 `ok:false` + `stage` 归因 + 本地队列留痕（**不静默**、不伪造送达）。
// 本模块只负责「送」，不做冷却/上限判断（那是 watch-policy），也不抛错给调用方。

import fs from 'node:fs';
import { hostRpc, hostRpcJson } from '../../lib/dsh-host-rpc.mjs';
import path from 'node:path';
import os from 'node:os';

import { dshHome, ensureDir, COMPONENT_ROOT } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { writeTextAtomic } from './store.mjs';
import { appendStateText } from './dual-write.mjs';
import { hostTag } from './host-tag.mjs';
import { firstH1Index, insertAtFor, stampDocMark } from '../../lib/generated-docs.mjs'; // §2.2 权威源（档级标记）
// 【2026-10-10 · 冲刺600·补可观测 B3】告警四段式校验（gap-1-12）：
//   出口侧「缺段 ⇒ 降级为 info + 留痕」。校验器是纯函数（lib\alert-template.mjs），
//   留痕写既有审计流水（lib\audit.mjs，append-only + 哈希链）—— 不新增状态文件、不改任何投递能力。
import { gateAlertTemplates, ALERT_TEMPLATE_SOURCE } from './alert-template.mjs';
import { appendAudit } from './audit.mjs';
// 【2026-10-21 · C 段】桌宠通道开关的载体读取（护栏配置，已登记；与 lib\steer-gate.mjs 同款用法）
import { readLimits, limitsPath } from './autonomy-actions.mjs';
// 【2026-10-21 · C 补】第四路出口 = 外部通道（hub 长连接）。开关 / 通路 / 留痕全在 alert-hub.mjs，
//   本文件只负责"每轮告警时调它一次、把结果如实记进 results"（协议一行不碰）。
import { resolveAlertChannel, sayAlert } from './notify.mjs';

export const WATCH_NOTIFY_VERSION = '0.3.0';

const LEVEL_ICON = { red: '🔴', yellow: '🟡' };
const MAX_SAY_CHARS = 180;

// ───────────────────────────────────────────── 桌宠通道开关（唯一判据源）
// 载体：`butler-autonomy-limits.json` → `watchChannels.whale`（形状 `{ schemaVersion:1, enabled:boolean, updatedAt?, by?, why? }`）
export const WATCH_CHANNEL_LIMITS_KEY = 'watchChannels';
export const WHALE_CHANNEL_SUBKEY = 'whale';
/** 缺省值：**关**（= 判据"桌宠不再背告警"；未配置就等同于关，连配置文件都不必动）。 */
export const WHALE_CHANNEL_DEFAULT_ENABLED = false;
/** 判定 reason 取值域（CLI / 报告 / 审计共用一套字面量）。 */
export const WHALE_CHANNEL_REASONS = Object.freeze([
  'explicit-override', 'enabled', 'default-off', 'shape-unrecognized', 'read-failed',
]);

/** reason → 人话（只翻译，不改判定）。 */
export const WHALE_CHANNEL_REASON_TEXT = Object.freeze({
  'explicit-override': '调用方显式指定（单轮覆盖，不读配置）',
  enabled: '配置里明确开了 ⇒ 桌宠参与自动出话',
  'default-off': '未配置 / 值非 true ⇒ 默认关（桌宠不背告警）',
  'shape-unrecognized': '载体形状不认 ⇒ fail-safe：按关处理',
  'read-failed': '载体读取失败 ⇒ fail-safe：按关处理（判不出就不打扰）',
});

// ───────────────────────────────────────────── 会话通道心跳兜底（C2 · 2026-10-21）
// 心跳载体 = `butler-watch-state.json#sessionHeartbeat`（P2 tick 每轮写；**已登记状态文件，零新增**）
// 形状：`{ schemaVersion:1, sessionId, at, writtenAt, source:'session-file-mtime', file? }`
//   · `at` = **会话文件 mtime**（真实活动时间），**绝不写 now** —— 否则心跳永不陈旧 = 偷偷放宽 TTL。
//   · 读侧只需 `sessionId` + `at`；缺键/坏 JSON/坏形状 ⇒ `source:'none'`（**不抛**，宁可不发也不发错）。
export const WATCH_STATE_NAME = 'butler-watch-state.json';
export const SESSION_HEARTBEAT_KEY = 'sessionHeartbeat';
/** 开关子键（与 whale 同父：`watchChannels.sessionHeartbeat.enabled`）。 */
export const SESSION_HEARTBEAT_SUBKEY = 'sessionHeartbeat';
/** 缺省值：**开**（这是修"喊不到人"的 bug，不是新增能力）。 */
export const SESSION_HEARTBEAT_DEFAULT_ENABLED = true;
/** 判定 reason 取值域。 */
export const SESSION_HEARTBEAT_REASONS = Object.freeze([
  'explicit-override', 'enabled', 'disabled', 'default-on', 'shape-unrecognized', 'read-failed',
]);
export const SESSION_HEARTBEAT_REASON_TEXT = Object.freeze({
  'explicit-override': '调用方显式指定（单轮覆盖，不读配置）',
  enabled: '配置里明确开了 ⇒ guard-session.id 陈旧时用心跳目标兜底',
  disabled: '配置里明确关了 ⇒ 只认 guard-session.id（关回 = 回到纯 mtime 判据）',
  'default-on': '未配置 ⇒ 默认开（缺省即修复态；主人要关就写 enabled:false）',
  'shape-unrecognized': '载体形状不认 ⇒ 按缺省（开）处理，判定本身仍受 15 分钟新鲜窗约束',
  'read-failed': '载体读取失败 ⇒ 按缺省（开）处理，判定本身仍受 15 分钟新鲜窗约束',
});

/**
 * 心跳兜底开关是否生效（纯读，永不抛）。
 * 判定顺序：① 显式覆盖 `opts.channels.sessionHeartbeat` / `opts.sessionHeartbeatChannel`
 *   ② 载体读失败 → 按缺省（开） ③ 键缺失 → 按缺省（开） ④ 形状不认 → 按缺省（开） ⑤ `enabled` 真假。
 * @param {{home?:string, channels?:object, sessionHeartbeatChannel?:unknown, limits?:object}} [opts]
 */
export function resolveSessionHeartbeatChannel(opts = {}) {
  const override = normOverride(opts.sessionHeartbeatChannel ?? opts.channels?.sessionHeartbeat);
  if (override !== null) {
    return {
      enabled: override, reason: 'explicit-override', configured: true, source: 'override',
      file: opts.limits?._file ?? limitsPath({ home: opts.home }),
      note: SESSION_HEARTBEAT_REASON_TEXT['explicit-override'],
    };
  }
  const limits = opts.limits ?? readLimits({ home: opts.home });
  const file = limits?._file ?? limitsPath({ home: opts.home });
  const source = String(limits?._source ?? 'unknown');
  if (source === 'fallback') {
    return { enabled: SESSION_HEARTBEAT_DEFAULT_ENABLED, reason: 'read-failed', configured: false, source, file, note: SESSION_HEARTBEAT_REASON_TEXT['read-failed'] };
  }
  const raw = limits?.[WATCH_CHANNEL_LIMITS_KEY]?.[SESSION_HEARTBEAT_SUBKEY];
  if (raw === undefined || raw === null) {
    return { enabled: SESSION_HEARTBEAT_DEFAULT_ENABLED, reason: 'default-on', configured: false, source, file, note: SESSION_HEARTBEAT_REASON_TEXT['default-on'] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw) || (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')) {
    return { enabled: SESSION_HEARTBEAT_DEFAULT_ENABLED, reason: 'shape-unrecognized', configured: true, source, file, note: SESSION_HEARTBEAT_REASON_TEXT['shape-unrecognized'] };
  }
  if (raw.enabled === false) {
    return { enabled: false, reason: 'disabled', configured: true, source, file, note: SESSION_HEARTBEAT_REASON_TEXT.disabled };
  }
  return { enabled: true, reason: 'enabled', configured: true, source, file, note: SESSION_HEARTBEAT_REASON_TEXT.enabled };
}

/**
 * 读心跳（**只读、永不抛**）。判据 = `sessionId` 非空 + `at` 有限正数；其余一律 `ok:false` + reason。
 * @param {{home?:string, watchStateFile?:string}} [opts]
 * @returns {{ok:boolean, reason:string, file:string, sessionId?:string, at?:number, source?:string|null, writtenAt?:number|null}}
 */
export function readSessionHeartbeat(opts = {}) {
  const home = opts.home ?? dshHome();
  let file;
  try {
    file = opts.watchStateFile ?? resolveStatePath(WATCH_STATE_NAME, { home }).path;
  } catch (e) {
    return { ok: false, reason: 'state-path-failed', file: null, error: e?.message ?? String(e) };
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'state-missing', file }; }
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, reason: 'state-corrupt', file }; }
  const hb = j?.[SESSION_HEARTBEAT_KEY];
  if (!hb || typeof hb !== 'object' || Array.isArray(hb)) return { ok: false, reason: 'heartbeat-missing', file };
  const sessionId = typeof hb.sessionId === 'string' ? hb.sessionId.trim() : '';
  const at = Number(hb.at);
  if (!sessionId || !Number.isFinite(at) || at <= 0) return { ok: false, reason: 'heartbeat-invalid', file, heartbeat: hb };
  return {
    ok: true, reason: 'ok', file, sessionId, at,
    source: typeof hb.source === 'string' ? hb.source : null,
    writtenAt: Number.isFinite(Number(hb.writtenAt)) ? Number(hb.writtenAt) : null,
  };
}

/**
 * 从会话采集结果里造心跳对象（**纯函数**；写侧 = `dsh-butler-watch.mjs` tick 收尾）。
 *
 * 入参两种形态：
 *   · `collectSessionsLight()` 的结果（读 `latestActive`）—— 生产路径；
 *   · 会话文件数组（`{sessionId, mtimeMs, file, root}`）—— 夹具/其它调用方。
 * 取 `mtimeMs` 最大者；`at` **原样用 mtime**（= 真实活动时间，不是 now）。
 * 判不出来（没有会话 / 字段不全）⇒ `null`（调用方保留上一轮心跳，由 15 分钟窗判死）。
 * @param {{latestActive?:object}|object[]} input
 * @param {{now?:number}} [opts]
 * @returns {{schemaVersion:number, sessionId:string, at:number, writtenAt:number, source:string, file:string|null}|null}
 */
export function buildSessionHeartbeat(input, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  let latest = null;
  if (Array.isArray(input)) {
    for (const x of input) {
      const m = Number(x?.mtimeMs ?? x?.mtime);
      if (!x?.sessionId || !Number.isFinite(m)) continue;
      if (!latest || m > latest.mtime) latest = { sessionId: String(x.sessionId), mtime: m, file: x.file ?? null };
    }
  } else if (input && typeof input === 'object') {
    const la = input.latestActive;
    const m = Number(la?.mtimeMs ?? la?.mtime);
    if (la?.sessionId && Number.isFinite(m)) latest = { sessionId: String(la.sessionId), mtime: m, file: la.file ?? null };
  }
  if (!latest) return null;
  const writtenAt = Number.isFinite(now) ? now : Date.now();
  // 【2026-10-21 实测修正】快照采集要几十秒，会话文件 mtime 可能**晚于** tick 起点 `now`
  //   ⇒ 读侧把"未来时间戳"一律拒收（时钟错位防线）会把这十几秒的告警窗口白白关掉。
  //   两条处置：① 小幅超前（≤1 分钟，正常采集序）⇒ 钳到 `now`（`at` 永不晚于 `writtenAt`）；
  //            ② 大幅超前（>1 分钟 = 真时钟错位）⇒ **不写心跳**（宁可不发也不发错）。
  const skewMs = latest.mtime - writtenAt;
  if (skewMs > 60_000) return null;
  return {
    schemaVersion: 1,
    sessionId: latest.sessionId,
    at: Math.min(latest.mtime, writtenAt),
    writtenAt,
    source: 'session-file-mtime',
    file: latest.file,
  };
}

/**
 * 归一显式覆盖值：`true/'on'/1` ⇒ true；`false/'off'/0` ⇒ false；其余 ⇒ null（= 没给，读配置）。
 * @param {unknown} v
 */
function normOverride(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'on' || s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'off' || s === 'false' || s === '0' || s === 'no') return false;
  return null;
}

/**
 * 桌宠通道是否参与自动出话（**唯一判据源**；纯读，永不抛）。
 *
 * 判定顺序（先到先判）：
 *   ① `opts.channels?.whale` / `opts.whaleChannel` 显式覆盖（夹具 / 单轮实验；**不读配置、不落盘**）
 *   ② 载体不可读（`readLimits` 的 fallback）→ fail-safe **关**（reason `read-failed`）
 *   ③ 键缺失 ⇒ **关**（reason `default-off`；这是本版的缺省值）
 *   ④ 形状不认（非对象 / array / enabled 非布尔）→ fail-safe **关**（reason `shape-unrecognized`）
 *   ⑤ `enabled === true` ⇒ 开
 *
 * @param {{home?:string, channels?:object, whaleChannel?:unknown, limits?:object}} [opts]
 * @returns {{enabled:boolean, reason:string, configured:boolean, source:string, file:string, note:string}}
 */
export function resolveWhaleChannel(opts = {}) {
  const override = normOverride(opts.whaleChannel ?? opts.channels?.whale);
  if (override !== null) {
    return {
      enabled: override, reason: 'explicit-override', configured: true,
      source: 'override', file: opts.limits?._file ?? limitsPath({ home: opts.home }),
      note: WHALE_CHANNEL_REASON_TEXT['explicit-override'],
    };
  }
  const limits = opts.limits ?? readLimits({ home: opts.home });
  const file = limits?._file ?? limitsPath({ home: opts.home });
  const source = String(limits?._source ?? 'unknown');
  if (source === 'fallback') {
    return { enabled: false, reason: 'read-failed', configured: false, source: 'fallback', file, note: WHALE_CHANNEL_REASON_TEXT['read-failed'] };
  }
  const raw = limits?.[WATCH_CHANNEL_LIMITS_KEY]?.[WHALE_CHANNEL_SUBKEY];
  if (raw === undefined || raw === null) {
    return { enabled: false, reason: 'default-off', configured: false, source, file, note: WHALE_CHANNEL_REASON_TEXT['default-off'] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false, reason: 'shape-unrecognized', configured: true, source, file, note: WHALE_CHANNEL_REASON_TEXT['shape-unrecognized'] };
  }
  if (raw.enabled === true) {
    return { enabled: true, reason: 'enabled', configured: true, source, file, note: WHALE_CHANNEL_REASON_TEXT.enabled };
  }
  return { enabled: false, reason: 'default-off', configured: true, source, file, note: WHALE_CHANNEL_REASON_TEXT['default-off'] };
}

/** 人读行（CLI `status` / 报告 / 日报段用；判定不在此处重算）。 */
export function whaleChannelLines(ch) {
  const c = ch ?? { enabled: false, reason: 'default-off', source: 'unknown', file: '?' };
  const L = [];
  L.push(`🐳 桌宠（/whale/say）自动出话通道：${c.enabled ? '✅ 已开' : '⛔ 关（默认）'}`);
  L.push(`   载体：\`${c.file ?? '?'}\` · \`${WATCH_CHANNEL_LIMITS_KEY}.${WHALE_CHANNEL_SUBKEY}.enabled\` · 来源 ${c.source ?? '?'} · reason ${c.reason ?? '?'}`);
  L.push(`   说明：${c.note ?? WHALE_CHANNEL_REASON_TEXT[c.reason] ?? ''}`);
  if (!c.enabled) L.push('   关时自动出话口改走：DSH 会话 queue → 报告文件 → 独立告警日志（ops-alert.log）。');
  return L;
}

/**
 * 写计划的**纯函数**部分（CLI 落盘前先算 before/after；默认 dry-run）。
 * @param {{limits?:object, enabled?:boolean, why?:string, by?:string, now?:number}} input
 */
export function planWhaleChannelWrite(input = {}) {
  const limits = input.limits ?? {};
  const before = resolveWhaleChannel({ limits });
  const prevRaw = limits?.[WATCH_CHANNEL_LIMITS_KEY]?.[WHALE_CHANNEL_SUBKEY];
  const enabled = input.enabled === true;
  const now = Number(input.now ?? Date.now());
  const next = {
    schemaVersion: 1,
    enabled,
    updatedAt: now,
    by: input.by !== undefined ? String(input.by) : 'butler-watch-channels CLI',
    why: input.why !== undefined ? String(input.why) : (prevRaw?.why ?? undefined),
  };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const same = (prevRaw?.enabled === true) === enabled;
  return { before, after: next, changed: !same, idempotent: same };
}

/**
 * 落盘（**只在 CLI `--apply` 路径调用**；默认 dry-run 不落）。
 * 用 `updateStateJson`（带锁 + 原子写 + schemaVersion 校验），只改 `watchChannels.whale` 一个键。
 * @param {{home?:string, file?:string, enabled?:boolean, why?:string, by?:string, now?:number}} opts
 */
export async function applyWhaleChannelWrite(opts = {}) {
  const { updateStateJson } = await import('./dual-write-store.mjs');
  const { LIMITS_FILE } = await import('./autonomy-actions.mjs');
  const file = opts.file ?? limitsPath({ home: opts.home });
  const limits = readLimits({ home: opts.home });
  const plan = planWhaleChannelWrite({ limits, enabled: opts.enabled, why: opts.why, by: opts.by, now: opts.now });
  if (plan.idempotent) {
    return {
      ok: true, changed: false, file, ...plan,
      afterRead: { enabled: plan.before.enabled, reason: plan.before.reason, configured: plan.before.configured },
    };
  }
  updateStateJson(LIMITS_FILE, file, (cur) => {
    const base = cur && typeof cur === 'object' ? cur : {};
    const parent = base[WATCH_CHANNEL_LIMITS_KEY] && typeof base[WATCH_CHANNEL_LIMITS_KEY] === 'object' ? base[WATCH_CHANNEL_LIMITS_KEY] : {};
    return { ...base, schemaVersion: base.schemaVersion ?? 1, [WATCH_CHANNEL_LIMITS_KEY]: { ...parent, [WHALE_CHANNEL_SUBKEY]: plan.after } };
  }, { schemaVersion: 1, home: opts.home, audit: false });
  // 写后回读（不信自己写的）
  const rt = resolveWhaleChannel({ home: opts.home, limits: readLimits({ home: opts.home }) });
  const ok = rt.enabled === plan.after.enabled && rt.reason !== 'read-failed' && rt.reason !== 'shape-unrecognized';
  return { ok, changed: true, file, ...plan, afterRead: { enabled: rt.enabled, reason: rt.reason, configured: rt.configured } };
}

/** 人读行（心跳开关；`butler-watch-channels.mjs heartbeat status` 用）。 */
export function sessionHeartbeatChannelLines(ch) {
  const c = ch ?? { enabled: SESSION_HEARTBEAT_DEFAULT_ENABLED, reason: 'default-on', source: 'unknown', file: '?' };
  const L = [];
  L.push(`💓 会话通道心跳兜底（guard-session.id 陈旧时用最近活跃会话）：${c.enabled ? '✅ 已开' : '⛔ 关（只认 guard-session.id）'}`);
  L.push(`   载体：\`${c.file ?? '?'}\` · \`${WATCH_CHANNEL_LIMITS_KEY}.${SESSION_HEARTBEAT_SUBKEY}.enabled\` · 来源 ${c.source ?? '?'} · reason ${c.reason ?? '?'}`);
  L.push(`   说明：${c.note ?? SESSION_HEARTBEAT_REASON_TEXT[c.reason] ?? ''}`);
  return L;
}

/** 写计划的**纯函数**部分（心跳开关；默认 dry-run）。 */
export function planSessionHeartbeatWrite(input = {}) {
  const limits = input.limits ?? {};
  const before = resolveSessionHeartbeatChannel({ limits });
  const prevRaw = limits?.[WATCH_CHANNEL_LIMITS_KEY]?.[SESSION_HEARTBEAT_SUBKEY];
  const enabled = input.enabled === true;
  const now = Number(input.now ?? Date.now());
  const next = {
    schemaVersion: 1,
    enabled,
    updatedAt: now,
    by: input.by !== undefined ? String(input.by) : 'butler-watch-channels CLI',
    why: input.why !== undefined ? String(input.why) : (prevRaw?.why ?? undefined),
  };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  // 缺省 = 开 ⇒ 幂等判据必须看**显式值**（键缺失时即便 enabled 相同也写一次，留下痕迹）
  const same = Boolean(prevRaw) && typeof prevRaw === 'object' && !Array.isArray(prevRaw) && prevRaw.enabled === enabled;
  return { before, after: next, changed: !same, idempotent: same };
}

/** 落盘（**只在 CLI `--apply` 路径调用**）；只改 `watchChannels.sessionHeartbeat` 一个键。 */
export async function applySessionHeartbeatWrite(opts = {}) {
  const { updateStateJson } = await import('./dual-write-store.mjs');
  const { LIMITS_FILE } = await import('./autonomy-actions.mjs');
  const file = opts.file ?? limitsPath({ home: opts.home });
  const limits = readLimits({ home: opts.home });
  const plan = planSessionHeartbeatWrite({ limits, enabled: opts.enabled, why: opts.why, by: opts.by, now: opts.now });
  if (plan.idempotent) {
    return {
      ok: true, changed: false, file, ...plan,
      afterRead: { enabled: plan.before.enabled, reason: plan.before.reason, configured: plan.before.configured },
    };
  }
  updateStateJson(LIMITS_FILE, file, (cur) => {
    const base = cur && typeof cur === 'object' ? cur : {};
    const parent = base[WATCH_CHANNEL_LIMITS_KEY] && typeof base[WATCH_CHANNEL_LIMITS_KEY] === 'object' ? base[WATCH_CHANNEL_LIMITS_KEY] : {};
    return { ...base, schemaVersion: base.schemaVersion ?? 1, [WATCH_CHANNEL_LIMITS_KEY]: { ...parent, [SESSION_HEARTBEAT_SUBKEY]: plan.after } };
  }, { schemaVersion: 1, home: opts.home, audit: false });
  const rt = resolveSessionHeartbeatChannel({ home: opts.home, limits: readLimits({ home: opts.home }) });
  const ok = rt.enabled === plan.after.enabled && rt.reason !== 'read-failed' && rt.reason !== 'shape-unrecognized';
  return { ok, changed: true, file, ...plan, afterRead: { enabled: rt.enabled, reason: rt.reason, configured: rt.configured } };
}


/**
 * 候选位解析：env 之外的 `guard-session.id` 候选顺序（**C2 起另有心跳兜底，见 `resolveNotifySession()`**）。
 *
 * 目标解析全序（2026-10-21 C2 后）：env → 新鲜 guard-session.id（≤15min）→ 新鲜心跳（≤15min）→ 不发。
 *
 * ⚠️【2026-10-10 · 冲刺600·剩余域扫尾 · **读路径修正**】原实现只找 `~/.dsh/guard-session.id`，
 *   而生产该文件**从来不存在** ⇒ 「DSH 会话」通道自 2026-09 起**结构性不可达**（10 月 `channels.session=true` **0 次**）。
 *   · 写者权威位置 = `<DSH>\logs\guard-session.id`：`guard.mjs:66 SESSION_ID_FILE = path.join(LOGS_DIR,'guard-session.id')`；
 *     `dsh-restart.ps1:401 Join-Path $stateDir 'guard-session.id'`（`$stateDir` 缺省 = 生产 `<butler-root>\logs`）。
 *   · 现改「**候选顺序 + 首个新鲜者胜**」：`<home>/guard-session.id` → `<DSH>\logs\guard-session.id`
 *     → `%TEMP%\dsh-guard\guard-session.id`；`opts.sessionIdFile` 仍是显式单点（给了就只认它）。
 *   · 新鲜窗收紧为 **[now-TTL, now]**：mtime 晚于 now（时钟错位 / 夹具固定时刻）**一律不认** ——
 *     守「宁可不发也不发错」，同时保证隔离单测（固定 now）不被生产 marker 干扰。
 *   · 退出口：`opts.includeGuardPaths === false` 只认 home（= 回归旧行为）。
 */
export function resolveSessionIdCandidates(opts = {}) {
  if (opts.sessionIdFile) return [opts.sessionIdFile];
  const home = opts.home ?? dshHome();
  const list = [path.join(home, 'guard-session.id')];
  if (opts.includeGuardPaths !== false) {
    const dshRoot = opts.dshRoot ?? path.resolve(COMPONENT_ROOT, '..', '..'); // <DSH>（本组件位于 <DSH>\tools\dsh-butler）
    list.push(path.join(opts.logsDir ?? path.join(dshRoot, 'logs'), 'guard-session.id'));
    list.push(path.join(os.tmpdir(), 'dsh-guard', 'guard-session.id'));
  }
  return list;
}

/**
 * 目标会话解析（**唯一判据源**；纯读，永不抛）。
 *
 * 判定顺序（先到先判；先赢者直接返回）：
 *   ① `DSH_GUARD_SESSION_ID` / `opts.envSessionId` ⇒ `source:'env'`
 *   ② 新新鲜 guard 候选（`resolveSessionIdCandidates()` 顺序，窗 `[now-TTL, now]`）⇒ `source:'file'`
 *   ③ **心跳兜底（C2 · 2026-10-21）**：`butler-watch-state.json#sessionHeartbeat`
 *      —— 只在「①② 都没新鲜目标 + 开关开 + 心跳自己也新鲜」时生效 ⇒ `source:'heartbeat'`
 *   ④ 都判不出来 ⇒ `source:'none'` + `reason`（**宁可不发也不发错**）
 *
 * 【C2 语义边界（写死在测试里）】
 *   · `opts.sessionIdFile` = **显式单点**：给了就只认它，**不走心跳兜底**（否则"显式"会被悄悄改语义）；
 *   · `opts.heartbeat === false` = 调用方单轮关掉兜底（夹具/实验）；
 *   · 心跳 `at` 用**会话文件 mtime**，不吃 `now` ⇒ 停手超过 TTL 后心跳照样判死；
 *   · 开关载体坏/缺键 ⇒ 按缺省（开），但新鲜窗一击照旧。
 *
 * @param {{now?:number, maxAgeMs?:number, home?:string, logsDir?:string, dshRoot?:string,
 *          sessionIdFile?:string, includeGuardPaths?:boolean, envSessionId?:string,
 *          heartbeat?:boolean, watchStateFile?:string, limits?:object,
 *          channels?:{sessionHeartbeat?:boolean|'on'|'off'}, sessionHeartbeatChannel?:unknown}} [opts]
 * @returns {{sessionId:string|null, source:'env'|'file'|'heartbeat'|'none', reason?:string,
 *            file?:string, ageMs?:number, stale?:Array<{file:string,ageMs:number}>,
 *            heartbeat?:object, heartbeatReason?:string}}
 */
export function resolveNotifySession(opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 15 * 60_000;
  const envId = String(opts.envSessionId ?? process.env.DSH_GUARD_SESSION_ID ?? '').trim();
  if (envId) return { sessionId: envId, source: 'env' };
  const stale = [];
  for (const file of resolveSessionIdCandidates(opts)) {
    try {
      const st = fs.statSync(file);
      const ageMs = now - st.mtimeMs;
      if (ageMs < 0 || ageMs > maxAgeMs) { stale.push({ file, ageMs }); continue; }
      const id = fs.readFileSync(file, 'utf8').trim();
      if (id) return { sessionId: id, source: 'file', file, ageMs, stale };
    } catch { /* 该候选没有文件 = 没有目标 */ }
  }
  // ── ③ 心跳兜底 ─────────────────────────────────────────────
  // 显式 sessionIdFile 是**单点语义**：陈旧也不改用心跳（否则"显式"名不副实）。
  if (opts.sessionIdFile) return { sessionId: null, source: 'none', reason: 'explicit-session-id-stale', stale };
  if (opts.heartbeat === false) return { sessionId: null, source: 'none', reason: 'heartbeat-disabled-by-caller', stale };
  const hbChannel = resolveSessionHeartbeatChannel(opts);
  if (!hbChannel.enabled) {
    return { sessionId: null, source: 'none', reason: 'heartbeat-off', heartbeatReason: hbChannel.reason, stale };
  }
  const hb = readSessionHeartbeat(opts);
  if (!hb.ok) {
    return {
      sessionId: null, source: 'none', reason: `heartbeat-${hb.reason}`, heartbeatReason: hbChannel.reason,
      heartbeat: { file: hb.file, readReason: hb.reason }, stale,
    };
  }
  const hbAgeMs = now - hb.at;
  if (hbAgeMs < 0 || hbAgeMs > maxAgeMs) {
    return {
      sessionId: null, source: 'none', reason: 'heartbeat-stale', heartbeatReason: hbChannel.reason,
      heartbeat: { sessionId: hb.sessionId, at: hb.at, ageMs: hbAgeMs, file: hb.file, source: hb.source }, stale,
    };
  }
  return {
    sessionId: hb.sessionId, source: 'heartbeat', file: hb.file, ageMs: hbAgeMs,
    heartbeat: { sessionId: hb.sessionId, at: hb.at, ageMs: hbAgeMs, file: hb.file, source: hb.source, writtenAt: hb.writtenAt },
    heartbeatReason: hbChannel.reason, stale,
  };
}

/**
 * 桌宠说话（A9 补丁路由；未打补丁 → 404，自动降级）。
 *
 * 【2026-10-21 · C 段】**函内第一道门 = 通道开关**（`resolveWhaleChannel()`）：
 *   默认关 ⇒ **连一个 HTTP 都不发**，直接回 `{ ok:false, skipped:true, reason:'channel-off' }`。
 *   ⇒ 所有自动出话口（P2 告警 / 卡死提醒 / 队列提示 / 收纳摘要）一并受管，不必逐处改。
 *   主人显式要桌宠开口走 `channels:{whale:'on'}` / `whaleChannel:'on'` 或 CLI `on --apply`。
 * `fetchImpl` 可注入（**只用于测试夹具**；不传 = 全局 fetch，行为不变）。
 */
export async function sayWhale(text, opts = {}) {
  const channel = resolveWhaleChannel(opts);
  if (!channel.enabled) {
    return {
      ok: false, skipped: true, status: 0, error: 'channel-off',
      channel: WHALE_CHANNEL_SUBKEY, channelEnabled: false, reason: channel.reason, gate: channel,
    };
  }
  const baseUrl = opts.baseUrl ?? 'http://127.0.0.1:3080';
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  try {
    const r = await fetchImpl(`${baseUrl}/whale/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, MAX_SAY_CHARS), state: opts.state ?? undefined }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok && j?.ok !== false, status: r.status, error: r.ok ? null : (j?.error ?? `HTTP ${r.status}`), channelEnabled: true, reason: channel.reason };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e), channelEnabled: true, reason: channel.reason };
  }
}

/**
 * 投递方式取值域（0.1.5 契约 `SessionPromptRequest.mode`）。
 *
 * 【2026-09-24 · 卡「夜批03 · 投递分级实现」】本函数原先**写死** `mode:'queue'` ⇒ 现在按档位取值：
 *   · `'queue'`（默认）= 排队等当前回合结束由 agent 读到，**不打断**（旧行为，逐字节等价）；
 *   · `'steer'` = **在当前 step 跑完时插话**（进 `next-step`）—— **不 abort 进行中的工具**，
 *     也不是"立刻打断"。真机实测（`docs/` §2.2/§8.2）：
 *     40 秒的 `Start-Sleep` 在 steer 升格后**完整跑完**（`tool/result` 正常返回），step 边界才被取走注入。
 *   ⚠️ 语义边界：`steer` 只影响"这条提醒什么时候被读到"，**不影响**任何会话数据、不取消任何工具调用。
 *     真需要打断回合的是 `session/cancel`（`turn/end.reason.kind='aborted'`）—— 本模块**绝不**调用它。
 */
export const PROMPT_MODES = Object.freeze(['queue', 'steer']);

/** 投递方式归一（不认识的值 / 缺省 ⇒ `'queue'`；**默认必须是最保守的那个**）。 */
export function normalizePromptMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return PROMPT_MODES.includes(m) ? m : 'queue';
}

/** 会话内消息（client-request RPC 信封，2026-09-09 实测口径）。 */
export async function notifySession(sessionId, text, opts = {}) {
  const baseUrl = opts.baseUrl ?? 'http://127.0.0.1:3080';
  // 【2026-09-24】投递方式由调用方按档位给（默认 `queue` ⇒ 与交付前逐字节相同）。
  const mode = normalizePromptMode(opts.mode);
  const body = {
    type: 'client-request',
    method: 'session.prompt',
    rpcId: `butler-watch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    // 0.1.5 契约：SessionPromptRequest 必填 requestId（旧形状没有）——缺了报 gateway/input-invalid（2026-09-22 实测）。
    payload: {
      requestId: `butler-watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId, mode, content: [{ type: 'text', text }],
    },
  };
  try {
    // 0.1.5 换线（2026-09-22）：走适配层（新端点 /api/session/prompt + cookie；旧主包自动回落）
    // 【2026-09-24】`fetchImpl` 可注入（**只用于测试夹具**；不传 = 全局 fetch，行为不变）。
    const r = await hostRpc(baseUrl, 'session.prompt', body.payload, { timeoutMs: opts.timeoutMs ?? 8000, fetchImpl: opts.fetchImpl });
    const j = r.body;
    const ok = r.status === 200 && j?.result?.ok === true;
    return { ok, status: r.status, error: ok ? null : (j?.result?.error?.code ?? j?.result?.error?.message ?? `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  }
}

/** 推送文案（桌宠一句话 / 会话一段话）。 */
export function formatPushText(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const head = list.length === 1
    ? `${LEVEL_ICON[list[0].level] ?? ''} ${list[0].title}：${list[0].detail}`
    : `🐳 管家发现 ${list.length} 条异常：\n` + list.map((x) => `- ${LEVEL_ICON[x.level] ?? ''} ${x.title}：${x.detail}`).join('\n');
  const tokens = list.map((x) => x.ackToken).filter(Boolean);
  const tail = tokens.length
    ? `\n（确认：node <butler-root>\\tools\\dsh-butler\\dsh-butler-watch.mjs --ack ${tokens[0]}${tokens.length > 1 ? ' | --ack all' : ''}）`
    : '';
  return head + tail;
}

/**
 * 投递一批推送：会话 + 报告文件为主通道，桌宠**可选（默认关）**。
 *
 * 【2026-10-21 · C 段「桌宠不再背告警」】原顺序「①桌宠 → ②会话 → ③报告」作废：
 *   桌宠降为"可选、默认关"（开关见 `resolveWhaleChannel()`），主通道 = 会话 queue + 报告文件 + 独立告警日志。
 *   ❗为什么不是"删掉桌宠"：主人喜欢它偶尔开口（`on --apply` 一键开回）；但**告警责任**不能压在
 *     一条 180 字符、看不见屏幕就收不到的通道上。
 *
 * 【2026-10-10 · B3】出口加**告警四段式闸**：文案自称四段式（含 `现象：/影响：/建议动作：/依据：` 标记）
 *   却缺段 ⇒ 该条**不推**、`level` 改写成 `info` 并回给调用方（`results.downgraded`），
 *   同时往审计流水写一行 `type:'alert-template'` 留痕（dry-run 时只算不写）。
 *   ⚠️ 短告警（一条段标记都没有）**默认不降级** —— 理由见 `lib\alert-template.mjs` 文件头 ②：
 *     降它们等于用"格式合规"掐掉告警能力，那是改能力不是补观测。
 *   模式只走**单轮参数** `opts.templateGateMode`（off/family/strict，默认 family），**不读也不写配置**。
 *
 * @param {Array} items policy 的 push 列表（含 ackToken）
 * @param {{baseUrl?:string, home?:string, now?:number, docsRoot?:string, dryRun?:boolean,
 *          channels?:{whale?:boolean|'on'|'off'}, whaleChannel?:boolean|'on'|'off',
 *          templateGateMode?:string, silent?:boolean}} [opts]
 *   `channels.whale` / `whaleChannel` = **单轮显式覆盖**（夹具 / 实验用；给了就不读配置、不落盘）。
 */
export async function deliverPush(items, opts = {}) {
  const all = Array.isArray(items) ? items : [];
  const now = opts.now ?? Date.now();
  const results = { whale: null, alert: null, session: null, report: null, channel: null, items: [], downgraded: [], templateGate: null };
  // 四段式闸（纯计算，不落盘）
  const gate = gateAlertTemplates(all, { mode: opts.templateGateMode });
  const list = gate.keep;
  results.templateGate = {
    mode: gate.mode,
    checked: gate.checked,
    downgraded: gate.downgraded.length,
    fourSectionPassed: gate.passed.length,
    shortAlerts: gate.shortAlerts.length,
    source: ALERT_TEMPLATE_SOURCE,
  };
  results.downgraded = gate.downgraded.map((x) => ({
    id: x.id, level: x.level, title: x.title, missing: x.downgrade?.missing ?? [], mode: gate.mode,
  }));
  // 【2026-10-21 · C 段】桌宠通道读数（**每轮只读一次配置**，随后透传给 sayWhale 复判，避免双份 IO）。
  //   `results.channel.whale` = 通道现状（调用方/报告/审计可读，不依赖"发没发出去"倒推）。
  const limits = opts.limits ?? readLimits({ home: opts.home });
  const whaleChannel = resolveWhaleChannel({ home: opts.home, channels: opts.channels, whaleChannel: opts.whaleChannel, limits });
  // 告警通道读数（同款：每轮只读一次，透传给 sayAlert 复判）。通道由**注入点**提供，本包不带具体实现。
  const alertChannel = resolveAlertChannel({ home: opts.home, channels: opts.channels, alertChannel: opts.alertChannel, limits });
  results.channel = { whale: whaleChannel, alert: alertChannel };
  // ⚠️ 顺序铁律：下面两块**必须在「list 为空就返回」之前** ——
  //   ① dry-run 占位：否则"本批全被降级"时调用方读到 whale/session = null（分不清"没发"与"没算"）；
  //   ② 降级留痕：降级项可能正好是本批唯一一条 ⇒ list 为空，但留痕照样要落（否则降级成了黑盒）。
  if (opts.dryRun === true) {
    results.whale = { ok: false, dryRun: true, channelEnabled: whaleChannel.enabled, reason: whaleChannel.reason };
    results.alert = { ok: false, dryRun: true, channelEnabled: alertChannel.enabled, reason: alertChannel.reason };
    results.session = { ok: false, dryRun: true };
  }
  // 实际推出去的那批（= 过了四段式闸的 keep）—— 调用方写报告/台账/状态时必须用它，
  //   否则会出现"报告说推了 N 条、实际只推 M 条"的显示偏差。
  results.pushAllEffective = list;
  if (opts.dryRun !== true && gate.downgraded.length) {
    try {
      appendAudit({
        type: 'alert-template', action: 'downgrade', mode: gate.mode,
        count: gate.downgraded.length,
        items: gate.downgraded.map((x) => ({ id: x.id, title: x.title ?? null, missing: x.downgrade?.missing ?? [] })),
        note: '四段式不全 ⇒ 降级为 info（只进报告，不推桌宠/会话）；短告警不在此列',
      }, { home: opts.home, silent: opts.silent });
    } catch { /* 留痕失败不影响投递结果（告警能力优先） */ }
  }
  if (!list.length) return results;
  const text = formatPushText(list, opts);

  if (opts.dryRun !== true) {
    // 【2026-10-21 · C 段】**桌宠降为可选**：默认关时 `sayWhale` 内部直接返回 skipped，
    //   一个 HTTP 都不发；主通道（会话 queue + 报告文件 + 独立日志）照旧落地。
    results.whale = await sayWhale(text, { ...opts, limits });
    // **第四路 = 注入的告警通道**：默认关时 `sayAlert` 内部第一道门就返回 `skipped`（一个字节都不发）；
    //   关着不会被下游误报成故障。正文 = 时间 + 事项 + 去向（"手机上一眼能看出啥事、哪台机"）。
    results.alert = await sayAlert(
      [
        `🐳 管家告警 · ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
        '',
        text,
        '',
        `（来自 ${hostTag()} · 自动告警 · 回复可当指令）`,
      ].join('\n'),
      { ...opts, limits },
    );
    // 透传本轮已读的 limits（避免心跳开关二次读同一个文件；调用方的单轮覆盖仍在 `opts.channels` 里优先）
    const target = resolveNotifySession({ ...opts, limits });
    if (target.sessionId) {
      const body = [
        `🐳 管家主动告警（${new Date(now).toLocaleString('zh-CN', { hour12: false })}）`,
        '',
        ...list.map((x) => `- ${LEVEL_ICON[x.level] ?? ''} **${x.title}**：${x.detail}${x.ackToken ? `（ack ${x.ackToken}）` : ''}`),
        '',
        '确认收到：`node <butler-root>\\tools\\dsh-butler\\dsh-butler-watch.mjs --ack all`',
        '标误报：`node <butler-root>\\tools\\dsh-butler\\dsh-butler-watch.mjs --false-positive all --note "原因"`',
      ].join('\n');
      // C2：`target` 记**命中哪条判据**（file / heartbeat / env），`targetId` 记投给谁 ——
      //   状态/审计里能直接看出"这轮是心跳兜底救的"还是"guard-session.id 新鲜"。
      results.session = {
        target: target.source, targetId: target.sessionId, targetAgeMs: target.ageMs ?? null,
        ...(await notifySession(target.sessionId, body, opts)),
      };
    } else {
      results.session = { ok: false, error: 'no-target-session', target: 'none', targetReason: target.reason ?? null, targetId: null };
    }
  }
  for (const x of list) results.items.push({ id: x.id, level: x.level, ackToken: x.ackToken ?? null, whale: results.whale?.ok ?? false, alert: results.alert?.ok ?? false, session: results.session?.ok ?? false });
  return results;
}

/**
 * 报告文件路径（每天一个 + 主机短码，人类可读兜底）。
 *
 * 【host 分文件（2026-09-11）】P2 每 5 分钟 tick，两台机同名 `watch-<date>.md` 必然分叉
 *   （本文件是 append 式，两边各追加自己的节）→ 每次 depart 都会被推前超集门挡。
 *   根治：`watch-<date>-<host>.md`（照 butler-barewatch 先例）；旧名文件不再写、不再删
 *   （本机升级前仍写旧名）。详情 docs/。
 */
export function reportPath(now = Date.now(), docsRoot = process.env.BUTLER_REPORT_DIR || path.join(os.homedir(), 'dsh', 'docs', 'reports')) {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(docsRoot, `watch-${day}-${hostTag()}.md`);
}

/**
 * 落报告（追加一节；无内容时不写）。
 * @param {{now?:number, docsRoot?:string, tick?:number, device?:string, push?:Array, reportOnly?:Array,
 *          deferred?:Array, escalated?:Array, suppressed?:Array, cooling?:Array, skipped?:Array,
 *          preflight?:Array, extra?:Array}} input
 */
export function writeReport(input = {}) {
  const now = input.now ?? Date.now();
  const file = reportPath(now, input.docsRoot);
  const push = input.push ?? [];
  const reportOnly = input.reportOnly ?? [];
  const deferred = input.deferred ?? [];
  const escalated = input.escalated ?? [];
  const suppressed = input.suppressed ?? [];
  const cooling = input.cooling ?? [];
  const skipped = input.skipped ?? [];
  const preflight = input.preflight ?? [];
  const extra = input.extra ?? [];
  const hasContent = push.length || reportOnly.length || deferred.length || escalated.length || suppressed.length || extra.length;
  if (!hasContent) return { ok: true, file, written: false, reason: 'no-events' };

  const t = new Date(now);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const lines = [];
  lines.push(`## ${hhmm} · tick #${input.tick ?? '?'} · ${input.device ?? os.hostname()}`);
  lines.push('');
  const row = (x) => `- ${LEVEL_ICON[x.level] ?? '⚪'} **${x.title}**（\`${x.id}\`）：${x.detail}${x.ackToken ? ` · ack \`${x.ackToken}\`` : ''}`;
  if (push.length) { lines.push(`**🔴 已推送（${push.length}）**`); push.forEach((x) => lines.push(row(x))); lines.push(''); }
  if (escalated.length) { lines.push(`**⏫ 升级（未确认 >4h，${escalated.length}）**`); escalated.forEach((x) => lines.push(`${row(x)} · ${x.reason}`)); lines.push(''); }
  if (reportOnly.length) { lines.push(`**🟡 只进报告（${reportOnly.length}）**`); reportOnly.forEach((x) => lines.push(row(x))); lines.push(''); }
  if (deferred.length) { lines.push(`**⏸ 穿透免打扰（置顶次日首句，${deferred.length}）**`); deferred.forEach((x) => lines.push(row(x))); lines.push(''); }
  if (suppressed.length) { lines.push(`**🚫 被抑制（${suppressed.length}）**`); suppressed.forEach((x) => lines.push(`- \`${x.event.id}\` ← 根因 \`${x.by}\`（${x.why}）`)); lines.push(''); }
  if (cooling.length) { lines.push(`**⏳ 冷却中（${cooling.length}）**：${cooling.map((x) => x.id).join(', ')}`); lines.push(''); }
  if (skipped.length) { lines.push(`**➖ 状态未变（${skipped.length}）**：${skipped.map((x) => x.id).join(', ')}`); lines.push(''); }
  if (extra.length) { extra.forEach((x) => lines.push(String(x))); lines.push(''); }
  if (preflight.length) { lines.push('**🛠 开工预检（信息）**'); preflight.forEach((x) => lines.push(`- ${x}`)); lines.push(''); }

  const body = lines.join('\n');
  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) {
      // §2.2 档级标记（`watch` 族 · 方案 §3.1）：**仅首次建模板时写一次**（本档纯追加，已发布行不动）；
      //   ⚠️ `watch` 的 `exemptEligible = false` ⇒ 有标记也**不豁免**（§4.4-6 负向判据）
      const headerBody = [
        `# 管家 watch 告警报告 ${new Date(now).getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
        '',
        '> 由 `<butler-root>\\tools\\dsh-butler\\dsh-butler-watch.mjs` 每 5 分钟自动追加（仅在有事件时写）。',
        '> 事件分级：🔴 主动推（桌宠 + 会话）· 🟡 只进本报告 · ⏸ 穿透免打扰（次日开机首句）。',
        '',
      ].join('\n');
      const header = stampDocMark(headerBody, 'watch', insertAtFor(firstH1Index(headerBody)));
      fs.writeFileSync(file, header, 'utf8');
    }
    fs.appendFileSync(file, body, 'utf8');
    return { ok: true, file, written: true, bytes: Buffer.byteLength(body, 'utf8') };
  } catch (e) {
    return { ok: false, file, written: false, error: e?.message ?? String(e) };
  }
}

/** 误报反馈落盘（append-only JSONL，进 P5 干预统计）。 */
export function appendFalsePositive(record, opts = {}) {
  const file = opts.file ?? resolveStatePath('butler-falsepositives.jsonl', { home: opts.home ?? dshHome() }).path;
  try {
    ensureDir(path.dirname(file));
    appendStateText('butler-falsepositives.jsonl', JSON.stringify(record) + '\n', {
      home: opts.file ? path.dirname(file) : (opts.home ?? dshHome()),
      write: (p, t) => fs.appendFileSync(p, t, 'utf8'),
    });
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, error: e?.message ?? String(e) };
  }
}

/** 原子写一行文本（报告头部/自检用）。 */
export function writeText(file, text) {
  return writeTextAtomic(file, text, {});
}
