// dsh-butler / lib/handoff-window.mjs —— 「交接窗口」单一真相（P9 H4 管家接入）
//
// 存在理由（2026-09-28 · 卡 H4）：
//   H4 要求五条联动（P2 事件 / 日报段 / 面板卡 / P5 联动 / P0 互斥），五条都要回答同三个问题：
//     ① 交接器**现在是不是正在跑**？（P5 暂停磁盘层审计 / P0 闸门回 busy）
//     ② 这次交接**是成功还是失败/分叉**？（P2 事件 / 面板红条）
//     ③ 哪些会话是**被交接出去的**、不该被 P2 判成"被打断"？（§5.6 抑制窗口）
//   若每条各自读一遍交接单、各自定阈值 ⇒ 又造 5 份真相。本模块 = **一处判定、零 IO 判据**，
//   五处调用方只做 IO 采集与渲染。
//
// 口径来源（不另立阈值）：
//   · 交接进行中 TTL 30 分钟 —— 方案 §17.2 T8（"交接启动先写 running 状态再分发；running 状态加
//     TTL（如 30 分钟），超时自动恢复审计 + 🟡"）。**超时必须自动恢复，不许永久暂停**。
//   · 会话抑制窗口 24h —— 方案 §5.6 / §5.7 时间语义表「交接会话 P2 抑制窗口」。
//   · 交接单字段（role / startedAt / finishedAt / result / handedOffSessions）—— §5.4 字段白名单。
//
// ⚠️ 现状登记（2026-09-28 读源码核实，**卡面订正要求如实登记**）：
//   · `handedOffSessions[]` 字段在 `handoff-record.schema.json` 与 `handoff-core.emptyRecord()` 里
//     **都在册**，但 `handoff.mjs` 全篇**没有任何写入点**（Depart 未实现 §5.6 的会话标记写入）⇒
//     本模块的抑制判定**必须**在它为空时退化为「按时间窗推导」（见 judgeSessionSuppression）。
//   · `~/.dsh/butler-handoff-imported.json` 从未生成 ⇒ 本模块按 §5.6 生成它，但生成者 = **管家侧**
//     （本卡红线：不改交接器核心 H1a/H1b，故不在 handoff.mjs 里写）。
//
// 纪律：本模块**只判定不动作**（除 readImportedMark/writeImportedMark 这对显式 IO 助手）——
//   不写生产文件、不发网络、不弹窗；动作由调用方按自己的失败分档执行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { COMPONENT_ROOT } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { readJson, writeTextAtomic } from './store.mjs';
import { writeStateText } from './dual-write.mjs';

/** 读 JSON（不存在 / 坏 / 版本不符 → null，绝不抛）。 */
function readJsonSafe(file, fallback = null) {
  try {
    const v = readJson(file, { defaultValue: fallback });
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export const HANDOFF_WINDOW_VERSION = '0.1.0';

/** 交接进行中 TTL（§17.2 T8：超时自动恢复审计，绝不永久暂停）。 */
export const HANDOFF_RUNNING_TTL_MS = 30 * 60 * 1000;
/** 会话交接抑制窗口（§5.6 / §5.7：窗口内降级"被打断"判定）。 */
export const HANDOFF_SUPPRESS_MS = 24 * 3600 * 1000;

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-handoff*.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: handoffHome(opts) }).path; }

export const HANDOFF_RECORD_NAME = 'butler-handoff.json';
export const HANDOFF_IMPORTED_NAME = 'butler-handoff-imported.json';
/** 交接锁（`butler-locks/tick-handoff.lock`）—— 交接器**真的会持**它（`handoff.mjs` 的 `acquireTickLock('handoff')`）。 */
export const HANDOFF_LOCK_NAME = 'handoff';

/** DSH 数据根（口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh，与 butler-write-paths 同源）。 */
export function handoffHome(opts = {}) {
  return opts.home
    ?? process.env.BUTLER_DSH_HOME
    ?? process.env.DSH_HOME
    ?? path.join(os.homedir(), '.dsh');
}

export function handoffRecordPath(opts = {}) {
  return opts.recordFile ?? stateFileOf(HANDOFF_RECORD_NAME, opts);
}

export function handoffImportedPath(opts = {}) {
  return opts.importedFile ?? stateFileOf(HANDOFF_IMPORTED_NAME, opts);
}

/** 时间戳（ISO 串 / 数字 / Date）→ 毫秒 epoch；取不到 → null（**不判、不告警**）。 */
export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** 读本机交接单（不存在 / 坏 → null，绝不抛）。 */
export function readHandoffRecord(opts = {}) {
  try {
    const j = readJsonSafe(handoffRecordPath(opts), null);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * 读交接锁（`butler-locks/tick-handoff.lock`）——**"交接进行中"的现成权威标记**。
 *
 * 为什么必须用它（2026-09-28 读源码实测，本卡最重要的订正）：
 *   T8 要求「**先写 running 状态再分发**」。但交接器现状（H1a/H1b 定稿，**本卡红线不改**）是：
 *   `handoff.mjs` 的 `cmdArrive()` **只在收尾（:2163）与几个失败分支才 `writeLocalRecord()`**，
 *   A6 分发（:1789）/ A6b 漏网分发段期间**本机交接单还是上一轮的旧内容** ⇒ 拿交接单 startedAt
 *   判 running 在分发窗口内**恒为 false**，暂停态落不了地。
 *   而交接器**确实**在开跑时就抢了 `tick-handoff.lock`（`handoff.mjs:2292` `acquireTickLock('handoff',
 *   {ttlMs: 60min})`，Depart / 热采 / 接机四入口共用同一把）——它才是"交接正在跑"的第一手证据，
 *   且自带 TTL（超时自动失效 ⇒ 天然满足 T8 的"不是永久暂停"）。
 *   `lib/handoff-version-gate.mjs:288` 早已把这条口径写死（"交接窗口的唯一权威信号 = 交接器自己持有的 tick 锁"），
 *   本模块复用同一信号，**不另立一把锁、不另造一个开关文件**。
 *
 * @param {{home?:string, lockFile?:string}} [opts]
 * @returns {{present:boolean, holder:object|null, startedAtMs:number|null, ttlMs:number|null,
 *            ageMs:number|null, expiresInMs:number|null, expired:boolean, alive:boolean|null, file:string}}
 */
export function readHandoffLock(opts = {}) {
  const file = opts.lockFile ?? path.join(handoffHome(opts), 'butler-locks', `tick-${HANDOFF_LOCK_NAME}.lock`);
  const out = { present: false, holder: null, startedAtMs: null, ttlMs: null, ageMs: null, expiresInMs: null, expired: false, alive: null, file };
  let holder = null;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return out;
    holder = JSON.parse(raw);
  } catch {
    return out; // 不存在 / 坏 → 视为无锁（fail-safe：不暂停审计）
  }
  if (!holder || typeof holder !== 'object') return out;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const startedAtMs = toMs(holder.startedAt);
  const ttlMs = Number.isFinite(Number(holder.ttl)) && Number(holder.ttl) > 0 ? Number(holder.ttl) : null;
  const ageMs = startedAtMs === null ? null : now - startedAtMs;
  const expired = ttlMs === null || ageMs === null ? true : ageMs > ttlMs;
  return {
    present: true, holder, startedAtMs, ttlMs, ageMs,
    expiresInMs: (ttlMs !== null && ageMs !== null) ? Math.max(0, ttlMs - ageMs) : null,
    expired, alive: isPidAlive(holder.pid), file,
  };
}

/** pid 是否存活（与 butler-locks / handoff-version-gate 同语义：kill(pid,0) 或 EPERM = 活）。 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * 交接器是否**正在跑**（P5 暂停磁盘层审计 / P0 闸门互斥 / 面板卡 的唯一判据）。
 *
 * 双信号（**取并集，任一成立即窗口内**；两者都不成立 = 不在窗口）：
 *   ① 交接锁存活且未过期且**年龄 ≤ TTL**（默认 30 分钟）⇒ running（source='lock'）。
 *      年龄 > TTL（但锁自身 TTL 未到）⇒ **判超时**：active=false + timedOut=true
 *      ⇒ 调用方**必须自动恢复审计**并留 🟡（T8：暂停态绝不许永久残留）。
 *   ② 交接单 `finishedAt` 为空 且 `startedAt` 有效 且 年龄 ≤ TTL ⇒ running（source='record'）。
 *      —— 覆盖"锁已释放但交接单异常未收尾"的残局。
 *
 * @param {object|null} record 交接单
 * @param {{now?:number, ttlMs?:number, lock?:object|null, skipLock?:boolean, isAlive?:Function}} [opts]
 * @returns {{active:boolean, mode:'absent'|'running'|'finished'|'interrupted'|'over-ttl',
 *            source:'lock'|'record'|null, startedAtMs:number|null, finishedAtMs:number|null,
 *            ageMs:number|null, timedOut:boolean, ttlMs:number, lock:object|null, reason:string}}
 */
export function judgeHandoffRun(record, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : HANDOFF_RUNNING_TTL_MS;
  const base = {
    active: false, mode: 'absent', source: null, startedAtMs: null, finishedAtMs: null,
    ageMs: null, timedOut: false, ttlMs, lock: null, reason: '',
  };
  const rec = record && typeof record === 'object' ? record : null;
  const finishedAtMs = toMs(rec?.finishedAt);
  const recStartedAtMs = toMs(rec?.startedAt);

  // ---- ① 交接锁（第一手证据）
  let lock = null;
  if (opts.skipLock !== true) {
    lock = opts.lock !== undefined ? opts.lock : readHandoffLock({ ...opts, now });
  }
  if (lock && lock.present === true && lock.expired !== true) {
    const alive = typeof opts.isAlive === 'function' ? opts.isAlive(lock.holder?.pid) : lock.alive;
    // 持有者已死但锁未过期 → 保守判窗口内（宁可多暂停一轮，不可撞上正在收尾的交接）
    const withinTtl = lock.ageMs !== null && lock.ageMs <= ttlMs;
    if (withinTtl) {
      return {
        ...base, active: true, mode: 'running', source: 'lock',
        startedAtMs: lock.startedAtMs, finishedAtMs, ageMs: lock.ageMs, lock,
        reason: `交接进行中（锁 tick-${HANDOFF_LOCK_NAME}.lock${alive === false ? '·持有者已退出' : `·pid=${lock.holder?.pid}`}，已持 ${Math.round((lock.ageMs ?? 0) / 1000)}s ≤ TTL ${Math.round(ttlMs / 60000)}min）`,
      };
    }
    return {
      ...base, mode: 'over-ttl', source: 'lock', timedOut: true,
      startedAtMs: lock.startedAtMs, finishedAtMs, ageMs: lock.ageMs, lock,
      reason: `交接锁仍在但已超 TTL ${Math.round(ttlMs / 60000)}min（已持 ${((lock.ageMs ?? 0) / 60000).toFixed(1)}min）⇒ 视为中断，**暂停态自动恢复**（§17.2 T8）；锁自身上限 ${lock.ttlMs ? Math.round(lock.ttlMs / 60000) + 'min' : '未知'} 到期后自然消失`,
    };
  }

  // ---- ② 交接单
  if (!rec) {
    return { ...base, lock, reason: '无交接单且无交接锁 → 不在交接窗口' };
  }
  if (finishedAtMs !== null) {
    return { ...base, mode: 'finished', startedAtMs: recStartedAtMs, finishedAtMs, ageMs: now - finishedAtMs, lock, reason: `交接已收尾（finishedAt 已写，role=${rec.role ?? '?'}）→ 不在窗口内` };
  }
  if (recStartedAtMs === null) {
    return { ...base, lock, reason: 'startedAt 取不到（坏/缺字段）→ 不判 running（fail-safe：不暂停审计）' };
  }
  const ageMs = now - recStartedAtMs;
  if (ageMs <= ttlMs) {
    return { ...base, active: true, mode: 'running', source: 'record', startedAtMs: recStartedAtMs, ageMs, lock, reason: `交接单显示进行中（role=${rec.role ?? '?'}，已跑 ${Math.round(ageMs / 1000)}s ≤ TTL ${Math.round(ttlMs / 60000)}min；无锁）` };
  }
  return {
    ...base, mode: 'interrupted', source: 'record', timedOut: true, startedAtMs: recStartedAtMs, ageMs, lock,
    reason: `交接**中断**（startedAt 距今 ${(ageMs / 60000).toFixed(1)}min > TTL ${Math.round(ttlMs / 60000)}min，finishedAt 未写）→ 暂停态已超时自动恢复（§17.2 T8）`,
  };
}

/** 便捷：读交接单 + 判 running（调用方只想问"现在能不能动"时用）。 */
export function handoffRunning(opts = {}) {
  return judgeHandoffRun(opts.record ?? readHandoffRecord(opts), opts);
}

/**
 * §5.6 会话交接抑制窗口判定。
 *
 * 触发条件 = **刚跑完一次完整交接**（finishedAt 有效且距今 ≤ windowMs）：
 *   · `role='depart'` ⇒ 本机把"回合未闭合的会话"交出去（对方接机后不该把它们判成它自己的被打断）；
 *   · `role='arrive'` ⇒ 本机刚导入对方会话（同理，本机也不该刷"被打断"噪声）。
 * 抑制对象：
 *   · 若交接单 `handedOffSessions[]` 非空 → **权威**（用它）；
 *   · 为空（现状：交接器未写该字段）→ `byTime=true`，由调用方按"会话最后活动 ≤ 交接完成时刻"推导
 *     （见 isSessionSuppressed）。**如实登记推导来源，不假装是清单。**
 *
 * @param {object|null} record
 * @param {{now?:number, windowMs?:number}} [opts]
 * @returns {{inWindow:boolean, sinceMs:number|null, untilMs:number|null, source:'depart'|'arrive'|null,
 *            sessionIds:string[]|null, byTime:boolean, windowMs:number, reason:string}}
 */
export function judgeSessionSuppression(record, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : HANDOFF_SUPPRESS_MS;
  const out = { inWindow: false, sinceMs: null, untilMs: null, source: null, sessionIds: null, byTime: false, windowMs, reason: '' };
  if (!record || typeof record !== 'object') return { ...out, reason: '无交接单 → 不抑制' };
  const finishedAtMs = toMs(record.finishedAt);
  if (finishedAtMs === null) return { ...out, reason: '交接未收尾（finishedAt 空）→ 不抑制' };
  const age = now - finishedAtMs;
  if (age < 0 || age > windowMs) {
    return { ...out, reason: `上次交接距今 ${(age / 3600000).toFixed(1)}h > 窗口 ${Math.round(windowMs / 3600000)}h → 不抑制` };
  }
  const role = record.role === 'depart' ? 'depart' : (record.role === 'arrive' ? 'arrive' : null);
  if (!role) return { ...out, reason: `role=${record.role ?? '?'} 不可识别 → 不抑制` };
  const ids = Array.isArray(record.handedOffSessions) ? record.handedOffSessions.map(String).filter(Boolean) : [];
  const byTime = ids.length === 0;
  return {
    inWindow: true,
    sinceMs: finishedAtMs,
    untilMs: finishedAtMs + windowMs,
    source: role,
    sessionIds: byTime ? null : ids,
    byTime,
    windowMs,
    reason: byTime
      ? `窗口内（${role} 收尾于 ${new Date(finishedAtMs).toISOString()}）·字段 handedOffSessions 为空 ⇒ 按时间窗推导`
      : `窗口内（${role}）·清单 ${ids.length} 个会话`,
  };
}

/**
 * 单个会话是否落在这轮交接的抑制范围内。
 * ⚠️ 调用方**只应对"回合未闭合"的会话调用本函数**（正常收尾的会话本来就不算被打断）。
 * @param {string} sessionId
 * @param {number|null} lastActivityMs 会话最后活动时刻（尾部事件 time，缺失才退 mtime）
 * @param {object} sup judgeSessionSuppression 的结果
 */
export function isSessionSuppressed(sessionId, lastActivityMs, sup) {
  if (!sup || sup.inWindow !== true) return false;
  if (Array.isArray(sup.sessionIds)) return sup.sessionIds.includes(String(sessionId));
  // byTime 推导：会话在"交接完成那一刻"之前就已经停住 ⇒ 它是被交出去的那批
  if (!Number.isFinite(lastActivityMs)) return false;
  return lastActivityMs <= sup.sinceMs;
}

/** 读 §5.6 标记文件（不存在 / 坏 → null）。 */
export function readImportedMark(opts = {}) {
  try {
    const j = readJsonSafe(handoffImportedPath(opts), null);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * 写 §5.6 标记文件（幂等：同一 finishedAt 已登记过 → 原样返回，不重写）。
 *
 * 为什么由管家写（而非交接器）：本卡红线「不改交接器核心（H1a/H1b 已定稿）」⇒ 标记生成搬到
 * 观测侧；语义不变（会话 id + 来源主机 + 导入时间），调用方 = watch tick / 日报。
 *
 * @param {object|null} record 交接单
 * @param {{home?:string, importedFile?:string, now?:number, sessionIds?:string[]|null, dryRun?:boolean}} [opts]
 */
export function writeImportedMark(record, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const file = handoffImportedPath(opts);
  if (!record || typeof record !== 'object') return { ok: false, file, written: false, reason: 'no-record' };
  const finishedAtMs = toMs(record.finishedAt);
  if (finishedAtMs === null) return { ok: false, file, written: false, reason: 'not-finished' };
  const role = record.role === 'depart' ? 'depart' : (record.role === 'arrive' ? 'arrive' : null);
  if (!role) return { ok: false, file, written: false, reason: 'unknown-role' };
  const ids = Array.isArray(opts.sessionIds)
    ? opts.sessionIds.map(String).filter(Boolean)
    : (Array.isArray(record.handedOffSessions) ? record.handedOffSessions.map(String).filter(Boolean) : []);
  const prev = readImportedMark(opts);
  const stamp = new Date(finishedAtMs).toISOString();
  if (prev && prev.finishedAt === stamp && prev.role === role) {
    return { ok: true, file, written: false, reason: 'idempotent（同一轮交接已登记）', mark: prev };
  }
  const mark = {
    schemaVersion: 1,
    generatedBy: `dsh-butler/lib/handoff-window.mjs ${HANDOFF_WINDOW_VERSION}`,
    importedAt: new Date(now).toISOString(),
    sourceHost: record.host ?? null,
    role,
    finishedAt: stamp,
    suppressWindowMs: HANDOFF_SUPPRESS_MS,
    suppressUntil: new Date(finishedAtMs + HANDOFF_SUPPRESS_MS).toISOString(),
    handedOffSessions: ids,
    derivedByTime: ids.length === 0,
    note: ids.length === 0
      ? '交接单 handedOffSessions[] 为空（交接器未实现该字段写入）⇒ 抑制判定按时间窗推导，本清单为空'
      : '来自交接单 handedOffSessions[]',
  };
  if (opts.dryRun === true) return { ok: true, file, written: false, reason: 'dry-run', mark };
  try {
    const dw = writeStateText(HANDOFF_IMPORTED_NAME, JSON.stringify(mark, null, 2) + '\n', {
      home: handoffHome(opts), write: (p, t) => writeTextAtomic(p, t),
    });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
    return { ok: true, file, written: true, mark };
  } catch (e) {
    return { ok: false, file, written: false, reason: `写标记失败：${e?.message ?? e}`, mark };
  }
}

export { COMPONENT_ROOT };
