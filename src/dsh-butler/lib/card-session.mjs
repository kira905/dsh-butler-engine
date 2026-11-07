// dsh-butler / lib/card-session.mjs —— 「看板卡执行会话」判定（**唯一判据源**）
//
// 由来（主人 2026-09-23 拍板两条）：
//   ① **卡执行会话「一路做完」**：上下文涨到自动压缩阈值（`dsh-compaction-basic` DEFAULT_THRESHOLD_RATIO=0.8）时
//      由主包自己压缩，**不靠提醒移交** ⇒ `ctx-guard` 不得对卡执行会话发软限/硬限提醒（无论卡是否结算）。
//   ② **重启旁路通知**（`selectStaleWaitSessions` / D17）不得发给「已结算的卡执行会话」——
//      那类会话的活已经闭环（卡进 done/review/failed），再发一条「你在等的东西可能失效了」是纯噪声。
//
// 【为什么单独抽一份】判据此前散在 `restart.mjs#extractRunningCardSessions`（只认 running 卡，服务活跃判定）。
//   本卡要问的是**另外两个问题**（"是不是卡执行会话" / "它的卡结算了没"），旧函数答不了。
//   家规：判定唯一源 ⇒ 两个问题的解析口径（账本字段名 / sessionId 归一化 / 取最新执行）只此一处实现，
//   `restart.mjs` 与 `ctx-guard.mjs` 一律从这里问，不许各写一套。
//
// 【fail-open 铁律】账本读不到 / 解析失败 / 调用方没给索引 ⇒ `ok:false` ⇒ `isCardSession()` 恒 false
//   ⇒ **不排除任何会话**（保持改动前的语义：宁多通知，不可静默少通知）。本模块**永不抛**。
//
// 【数据源】`<dsh-home>/task-board/ledger-v2.json` 的 `tasks[].executions[].sessionId`
//   （字段实测：`{id, sessionId, startedAt, endedAt, result}`）+ `tasks[].status`。
//   ⚠️ 只读：本模块绝不写账本（账本写入只走 Host API，见 task-board 技能）。
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from './paths.mjs';

export const CARD_SESSION_VERSION = '0.1.0';

/**
 * 索引**方向**（2026-09-24 · 卡【加急档·A1】判据层；D-1 = b「一处判据 + 方向参数」的落地）。
 *   · `fail-open`（**默认，原语义**）：读不到账本 ⇒ `isCardSession()` 恒 false ⇒ **不排除任何人**
 *     （通知面 / ctx-guard 用：宁可多通知，不可静默少通知）。
 *   · `fail-safe`：读不到账本 ⇒ `isCardSession()` 恒 **true** ⇒ **一律判为卡执行会话**
 *     （重启闸门加急档用：宁可多等一分钟，也不打断真在跑的卡 ⇒ 不制造假结算）。
 * ⚠️ 方向**只在索引不可用（`ok:false`）时**才影响判定；`ok:true` 时有数据可依，两方向判定一致。
 */
export const CARD_SESSION_DIRECTIONS = Object.freeze(['fail-open', 'fail-safe']);
const DEFAULT_CARD_SESSION_DIRECTION = 'fail-open';

export function normCardSessionDirection(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return CARD_SESSION_DIRECTIONS.includes(s) ? s : DEFAULT_CARD_SESSION_DIRECTION;
}

/** 已结算的卡状态（卡执行会话的活已闭环）。真源口径见卡 prompt §三.1。 */
export const SETTLED_CARD_STATUSES = Object.freeze(['done', 'review', 'failed']);
const SETTLED = new Set(SETTLED_CARD_STATUSES);

/**
 * sessionId 归一化（trim；空 → null）。
 * ⚠️ 与 `restart.mjs#normSessionId` **同口径**，此处重复 3 行是为了**避免循环依赖**
 *   （restart.mjs 要 import 本模块；本模块若回头 import restart.mjs 就成环）。
 */
export function normCardSessionId(id) {
  const s = String(id ?? '').trim();
  return s || null;
}

/** 该状态是否算「已结算」。未知状态一律算未结算（保守：不排除）。 */
export function isSettledStatus(status) {
  return SETTLED.has(String(status ?? '').trim());
}

/**
 * 从账本提取**全部**卡执行会话（纯函数，单测入口）。
 *
 * 与 `restart.mjs#extractRunningCardSessions` 的关系：那是"正在执行的卡"（只认 `status==='running'`，
 * 服务活跃判据）；本函数**不筛状态**，因为本卡要问的是"是不是卡执行会话"与"结算了没"。
 * 同一 sessionId 出现在多条执行记录时，取 `startedAt` 最大的一条（与既有函数同口径）。
 *
 * @param {object|Array} ledger ledger-v2.json 内容（`{tasks:[...]}` 或裸数组）
 * @returns {Map<string, {sessionId:string, cardId:string|null, title:string, status:string|null,
 *          settled:boolean, startedAt:number, endedAt:number|null, result:unknown}>}
 */
export function extractCardSessions(ledger) {
  const tasks = Array.isArray(ledger) ? ledger : (ledger?.tasks ?? []);
  const out = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t) continue;
    const status = t.status === undefined || t.status === null ? null : String(t.status);
    for (const e of Array.isArray(t.executions) ? t.executions : []) {
      const id = normCardSessionId(e?.sessionId);
      if (!id) continue;
      const startedAt = Number(e?.startedAt) || 0;
      const prev = out.get(id);
      if (prev && startedAt < prev.startedAt) continue;
      out.set(id, {
        sessionId: id,
        cardId: t.id === undefined || t.id === null ? null : String(t.id),
        title: String(t.title ?? ''),
        status,
        settled: isSettledStatus(status),
        startedAt,
        endedAt: Number.isFinite(Number(e?.endedAt)) ? Number(e.endedAt) : null,
        result: e?.result ?? null,
      });
    }
  }
  return out;
}

/**
 * 空索引（`ok:false` ⇒ 判定由**方向**决定；方向语义的唯一载体）。
 *   · 默认 `fail-open`（原语义）⇒ 一切判定为 false ⇒ **不排除任何人**；
 *   · `fail-safe` ⇒ `isCardSession()` 恒 true（一律判卡执行会话）、`isSettledCardSession()` 恒 false
 *     （不可知 ⇒ 不当作"已结算"）。见文件头 `CARD_SESSION_DIRECTIONS`。
 */
export function emptyCardSessionIndex(reason = 'no-index', extra = {}) {
  const bySession = new Map();
  const direction = normCardSessionDirection(extra.direction);
  const failSafe = direction === 'fail-safe';
  return {
    ok: false,
    error: reason,
    direction,
    file: extra.file ?? null,
    source: extra.source ?? 'none',
    count: 0,
    settledCount: 0,
    statusCounts: {},
    bySession,
    settledIds: new Set(),
    isCardSession: () => failSafe,
    isSettledCardSession: () => false,
    note: extra.note ?? (failSafe
      ? 'fail-safe：索引不可用 ⇒ 一律判为卡执行会话（不打断）'
      : 'fail-open：无索引 ⇒ 不排除任何会话（保持改动前语义）'),
  };
}

/**
 * 由 Map 建索引（纯函数）。
 * @param {Map<string, object>} bySession
 */
export function makeCardSessionIndex(bySession, meta = {}) {
  const map = bySession instanceof Map ? bySession : new Map();
  const settledIds = new Set([...map.values()].filter((v) => v?.settled === true).map((v) => v.sessionId));
  const statusCounts = {};
  for (const v of map.values()) {
    const k = v?.status ?? '(none)';
    statusCounts[k] = (statusCounts[k] ?? 0) + 1;
  }
  const at = (id) => {
    const sid = normCardSessionId(id);
    return sid ? (map.get(sid) ?? null) : null;
  };
  return {
    ok: true,
    error: null,
    direction: normCardSessionDirection(meta.direction),
    file: meta.file ?? null,
    source: meta.source ?? 'ledger',
    count: map.size,
    settledCount: settledIds.size,
    statusCounts,
    bySession: map,
    settledIds,
    isCardSession: (id) => at(id) !== null,
    isSettledCardSession: (id) => {
      const info = at(id);
      return info !== null && info.settled === true;
    },
    note: meta.note ?? null,
  };
}

/**
 * 读账本 → 卡执行会话索引（**只读**；永不抛）。
 *
 * @param {{home?:string, ledger?:object|Array, ledgerPath?:string, source?:string}} opts
 *        `ledger` 直接给对象（测试 / 调用方已读过）；否则按 `ledgerPath ?? <home>/task-board/ledger-v2.json` 读。
 * @returns 索引对象（读不到 → {@link emptyCardSessionIndex}，`ok:false`）
 */
export function loadCardSessionIndex(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.ledgerPath ?? path.join(home, 'task-board', 'ledger-v2.json');
  let ledger = opts.ledger;
  if (ledger === undefined || ledger === null) {
    try {
      ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return emptyCardSessionIndex(e?.code ?? e?.message ?? String(e), {
        file, source: 'ledger', direction: opts.direction,
        note: normCardSessionDirection(opts.direction) === 'fail-safe'
          ? `fail-safe：账本不可读（${e?.code ?? e?.message ?? e}）⇒ 一律判为卡执行会话（不打断）`
          : `fail-open：账本不可读（${e?.code ?? e?.message ?? e}）⇒ 不排除任何会话`,
      });
    }
  }
  try {
    return makeCardSessionIndex(extractCardSessions(ledger), { file, source: opts.source ?? 'ledger', direction: opts.direction });
  } catch (e) {
    return emptyCardSessionIndex(e?.message ?? String(e), { file, source: 'ledger', direction: opts.direction });
  }
}

/**
 * 把任意"索引样"输入归一化成索引对象（宽容：方便单测/调用方传 Map / Set / 数组 / `{index}` / `{home}`）。
 * 不认识的输入 → `emptyCardSessionIndex`（**不排除**，fail-open）。
 */
export function asCardSessionIndex(input, opts = {}) {
  if (!input) return emptyCardSessionIndex('no-index', { direction: opts.direction });
  // 1) 已是索引对象
  if (typeof input.isCardSession === 'function' && input.bySession instanceof Map) return input;
  // 2) { index: ... } 包装
  if (input.index && input.index !== input) return asCardSessionIndex(input.index, opts);
  // 3) Map<id, info> / Map<id, status>
  if (input instanceof Map) {
    const out = new Map();
    for (const [k, v] of input) {
      const sid = normCardSessionId(k);
      if (!sid) continue;
      if (v && typeof v === 'object') {
        const status = v.status === undefined || v.status === null ? null : String(v.status);
        out.set(sid, {
          sessionId: sid, cardId: v.cardId ?? null, title: String(v.title ?? ''), status,
          settled: v.settled === true || isSettledStatus(status),
          startedAt: Number(v.startedAt) || 0, endedAt: v.endedAt ?? null, result: v.result ?? null,
        });
      } else {
        const status = v === undefined || v === null ? null : String(v);
        out.set(sid, {
          sessionId: sid, cardId: null, title: '', status,
          settled: isSettledStatus(status), startedAt: 0, endedAt: null, result: null,
        });
      }
    }
    return makeCardSessionIndex(out, { source: 'injected-map', direction: opts.direction });
  }
  // 4) Set / 数组（元素 = sessionId 字符串 或 执行记录对象 `{sessionId, status?}`）
  if (input instanceof Set || Array.isArray(input)) {
    const rows = [...input].map((x) => (x && typeof x === 'object' ? x : { sessionId: x }));
    return makeCardSessionIndex(extractCardSessions({ tasks: rows.map((r) => ({ status: r.status ?? null, executions: [r] })) }), { source: 'injected-list', direction: opts.direction });
  }
  // 5) {home} / {ledger} / {ledgerPath}
  if (input.home || input.ledger || input.ledgerPath) return loadCardSessionIndex({ ...input, direction: opts.direction ?? input.direction });
  return emptyCardSessionIndex('unrecognized-index', { direction: opts.direction });
}

/** 取卡执行会话条目（拿不到 → null）。 */
export function lookupCardSession(sessionId, indexOrOpts) {
  const idx = asCardSessionIndex(indexOrOpts);
  if (!idx.ok) return null;
  const sid = normCardSessionId(sessionId);
  if (!sid) return null;
  return idx.bySession.get(sid) ?? null;
}

/**
 * 该会话是否为**看板卡执行会话**（不看卡状态）。
 * fail-open：索引不可用 ⇒ false（不排除）。
 */
export function isCardSession(sessionId, indexOrOpts) {
  const idx = asCardSessionIndex(indexOrOpts);
  const sid = normCardSessionId(sessionId);
  if (!sid) return false;
  // ⚠️ 走索引方法（不自己判 ok）——方向语义（fail-open / fail-safe）**只**在 emptyCardSessionIndex 一处实现。
  return idx.isCardSession(sid) === true;
}

/**
 * 该会话是否为**已结算的卡执行会话**（卡 status ∈ `SETTLED_CARD_STATUSES`）。
 * fail-open：索引不可用 ⇒ false（不排除）。
 */
export function isSettledCardSession(sessionId, indexOrOpts) {
  const idx = asCardSessionIndex(indexOrOpts);
  const sid = normCardSessionId(sessionId);
  if (!sid) return false;
  return idx.isSettledCardSession(sid) === true;
}
