// dsh-butler / lib/relay-handoff-watch.mjs —— 【G1G2 候选 C】「标了没交棒」巡检（判据 + 计划）
//
// 要解决什么（一句话）：`session-mark --handed` 成功 = 改标题 + 写一个**没人读**的标记文件；
//   「标了交接」≠「交了棒」，而系统对这个差别零感知（2026-09-25 第 6 棒因此断链 9.5 小时）。
//   本库 = 把这件事变成**可巡检、可告警**（只告警，不自动补跑；自动补跑 = 候选 C+，需主人拍板）。
//
// 口径真源：`docs/` §5.1（判据）/ §5.2（落点）/ §5.3（测与回滚）
//   过审：`docs/` §0 = ✅ 构成合格证（限 Q-1~Q-5）
//
// ── 三条硬边界（§5.1 · 一条不许省）─────────────────────────────────────────
//   ① **主判据 = 标记文件存在**（`~/.dsh/butler-relay.handed/<sid>`）；**标题只作佐证**
//      —— 标题判据已实测**丢轴一次**（ff84dd1f 01:27:59 标上、11:06:07 已丢）⇒ 不能当主键。
//   ② **窗口 = 标记文件的 `mtimeMs`（数字毫秒）在 24h 内**；⛔ **严禁**拿标记 JSON 里的 `markedAt`
//      （**ISO 字符串**，`session-mark.mjs:191`）参与比较 —— 跨类型比较恒 `false`
//      ⇒「无法判定」永不成立 ⇒ **老标记全部误报**。唯一允许的换算方向 = 数字 → 展示层。
//   ③ **台账 `chains` 有 `.slice(-100)` 硬上限**（`session-relay.mjs:1608`）：`mtime < min(chains[].at)`
//      ⇒ 该标记对应的接力已滚出台账窗口 ⇒ 判「**无法判定 ⇒ 静默**」，**绝不许当断链**
//      （否则第 101 次接力起必然长期误报）。
//
// ── 空态四例（§5.1 ⏱ 块 ③ · 任一条成立 ⇒ 该候选「无法判定 ⇒ 静默 + 只落只读档」）──
//   (i) `chains` 为空数组   (ii) 台账不存在 / 读不到 / `schemaVersion > 1`
//   (iii) `mtime < min(chains[].at)`   (iv) 标记的 `sid` 不在会话面快照里（`running` 非布尔）
//   ⇒ 只读档记 `候选数 = 无法判定数`（让「静默」可见 —— 照 `queue-watch.mjs:1762-1766` 既有口径：
//      「静默必须可见，否则看起来像机制不存在」）。
//
// ── 断链判据（§5.1 判据式）────────────────────────────────────────────────
//   候选       = 标记文件存在 且 `now - mtime <= 24h`
//   已交棒     = 第一路 chain 时间窗（`at >= mtime - 5min`，同一次交接的语义）
//              | 第二路 `pendingHandoff.sourceSessionId === sid`（在途，已有 30min TTL 覆盖）
//              | 第三路 该 sid 的 chain 条目**存在且 `at <= mtime`** 且其 `newSessionId` 在会话面里
//   无法判定   = 空态 (i)~(iv)
//   断链       = 候选 && !已交棒 && !无法判定 && `(now - mtime) >= 15min` && `running === false`
//
// ── 两条纪律（persona 三红线 ① / 方案 Q-4①）───────────────────────────────
//   · **只读档不消费配额**：计划函数带 `emit` 开关，`emit === false` ⇒ 只算不落 `warnedKeys/warnedAt`
//     （也绝不投递）。任何「只读观测」用途必须传 `emit:false`。
//   · **投递门禁**：`dryRun === true` **或** `mode === 'observe'` ⇒ 只算不投（不 say / 不 alert /
//     不进日报事件段），且**幂等键不落** —— 照 `queue-watch.mjs:1735` / `:1771` 既有先例。
//     ⚠️ 这与上一条「配额」是**两件事**，两条都要过。
//
// ── 本库的 IO 边界（为什么是零依赖）───────────────────────────────────────
//   判据与计划 = **纯函数**（不读时钟、不读文件、不发通知）。IO 只有三处、全部显式传参：
//     ① 输入（marks / ledgerRead / sessions / pending）**由调用方注入**（`queue-watch.mjs` 编排层
//        —— 它已持有会话面快照，并用既有 `loadRelayModule()` 取 `listHandedMarks()` / `readLedger()`）。
//        ⚠️ 本库**不自己 import `session-relay.mjs`**：读 `chains` 是纯读，本卡**不新增 relay 台账写者**。
//     ② 豁免名单 `~/.dsh/butler-relay-handoff-warn.json`（`loadRelayHandoffWarnState()`，**只读**）。
//     ③ 只读观察档 `docs/`（`writeObserveDoc()`，**整段替换**）。
//   ⚠️ **标记文件的唯一删除者 = `session-relay --selfcheck` 的 `consumeHandedMarks()`** ——
//      本库与 queue job **一律只读不删**（§5.1 保留策略）。
//
// ⚠️ 本文件当前处于**候选态**：生产放行前不得替换 `<butler-root>\tools\` 下的实体（见交付报告）。

import fs from 'node:fs';
import path from 'node:path';

// 【改动 1 · 2026-09-29】主线名归一化**唯一真源**（`tools\lib\mainline.mjs`，方案 §4.2 K-5）——
//   断链看门狗按主线名聚合会话、判「同一主线最后成功接力」，必须与 relay 闸门 2/3 用同一个函数
//   （否则一个尾随空格就足以让同一主线被当成两条 ⇒ 看门狗与闸门口径分叉）。
import { normalizeMainline } from '../../lib/mainline.mjs';
// 【impl-2 · 2026-10-08】§2.2 档级标记（唯一权威源）——本档（`relaywatch` 族）盖章用：
import { firstH1Index, insertAtFor, stampDocMark } from '../../lib/generated-docs.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../lib/production-guard.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { writeStateText } from './dual-write.mjs';

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


export const RELAY_HANDOFF_WATCH_VERSION = '0.1.0';

/** 候选窗口：只对 24h 内的新标记判「断链」（硬边界 ②）。 */
export const CANDIDATE_WINDOW_MS = 24 * 3600 * 1000;
/** 断链宽限：标完 15 分钟内不说话（给「刚标完、正准备跑 relay」留时间）。 */
export const DANGLING_GRACE_MS = 15 * 60 * 1000;
/** 第一路「同一次交接」容差：链 `at` 落在标记 mtime 前 5 分钟内即视为同一次（对齐 §5.1 判据式）。 */
export const SAME_HANDOFF_SLACK_MS = 5 * 60 * 1000;
/** 单日告警上限（兜底；幂等键已保证「每标记每 mtime 只喊一次」）。 */
export const DEFAULT_DAILY_MAX = 20;
/** `warnedKeys` 保留上限（防无限增长；超出丢最老）。 */
export const WARNED_KEYS_MAX = 500;
/** 只读观察档文件名前缀（登记见方案 §13）。 */
export const OBSERVE_DOC_PREFIX = 'relay-handoff-watch-';
/** 队列台账 `stats` 里的幂等键名（🔴 **不是** `butler-relay.json` —— 那个文件没有 `stats` 段）。 */
export const WARN_STATS_KEY = 'relayHandoffWarn';
/** 【2c-B2】状态路径统一入口（home 必传；legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, home) {
  return resolveStatePath(name, { home }).path;
}
/** 豁免名单文件（人工维护；缺文件 = 无豁免）。 */
export const EXEMPT_FILE_NAME = 'butler-relay-handoff-warn.json';

/** 判定标签（写死；只读档与单测都认这几个字面量）。 */
export const VERDICT = Object.freeze({
  DANGLING: 'dangling',        // 断链 ⇒ 告警
  HANDED: 'handed',            // 已交棒 ⇒ 静默
  UNDECIDABLE: 'undecidable',  // 无法判定（空态四例）⇒ 静默
  GRACE: 'grace',              // 宽限内（<15min）⇒ 静默
  RUNNING: 'running',          // 源会话仍在跑 ⇒ 静默（还没停手就不算断链）
  EXEMPT: 'exempt',            // 人工豁免 ⇒ 静默
  OUT_OF_WINDOW: 'out-of-window', // 24h 外 ⇒ 不进候选面
});

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 本地日期键 `YYYY-MM-DD`（与 `queue-watch.mjs#dayKey` 同形态；调用方一般直接传 `dateKey` 以免分叉）。 */
export function dayKeyOf(now = Date.now()) {
  const d = new Date(num(now, Date.now()));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 幂等键：同一标记（sid + mtime）只喊一次；标记被同名覆盖重写（新 mtime）⇒ 新键 ⇒ 允许再喊一次。 */
export function handoffWarnKey(item) {
  const sid = String(item?.sid ?? '');
  const mtime = Number(item?.mtime);
  return Number.isFinite(mtime) ? `${sid}|${mtime}` : `${sid}|?`;
}

// ---------------------------------------------------------------- 输入归一

/**
 * 台账输入归一（**只认 `readLedger()` 的返回值**，不自己读文件）。
 * 空态 (i)/(ii) 都归到 `ok:false`（处置相同 = 无法判定），但保留 `reason` 以便只读档区分观测。
 * @param {{ledgerRead?:object}} input
 */
function normalizeLedgerRead(ledgerRead) {
  if (!ledgerRead || typeof ledgerRead !== 'object') return { ok: false, reason: 'no-ledger-read' };
  if (ledgerRead.ok !== true) return { ok: false, reason: `ledger-unreadable:${ledgerRead.reason ?? 'unknown'}` };
  if (ledgerRead.exists === false) return { ok: false, reason: 'ledger-missing' };            // 空态 (ii)
  const chains = ledgerRead.data?.chains;
  if (!Array.isArray(chains)) return { ok: false, reason: 'chains-not-array' };
  if (!chains.length) return { ok: false, reason: 'chains-empty' };                            // 空态 (i)
  return { ok: true, chains: chains.filter((c) => c && typeof c === 'object') };
}

const sessExists = (sessions, sid) => !!sid && sessions.some((s) => String(s?.sessionId ?? '') === String(sid));

// ---------------------------------------------------------------- 判据（纯函数）

/**
 * 判据主函数（**纯函数**：不读文件、不读时钟、不发通知）。
 *
 * @param {object} input
 * @param {Array<{sid:string,file:string,mtime:number}>} [input.marks] 标记文件目录（`listHandedMarks()` 结果）
 * @param {object|null} [input.ledgerRead]                             `session-relay#readLedger()` 的返回值
 * @param {Array<{sessionId:string,running:boolean,title?:string,updatedAt?:number}>|null} [input.sessions] 会话面快照
 * @param {{sourceSessionId:string,newSessionId:string}|null} [input.pending] `readHandoffSnapshot().pending`（同一轮取）
 * @param {string[]} [input.exempt]                                    豁免 sid（`butler-relay-handoff-warn.json#exempt`）
 * @param {number}   [input.now]
 * @returns {{counts:object, items:Array, danglingKeys:string[]}}
 */
export function judgeDanglingHandoffs(input = {}) {
  const now = num(input.now, Date.now());
  const candidateWindowMs = num(input.candidateWindowMs, CANDIDATE_WINDOW_MS);
  const graceMs = num(input.graceMs, DANGLING_GRACE_MS);
  const slackMs = num(input.sameHandoffSlackMs, SAME_HANDOFF_SLACK_MS);
  const marks = Array.isArray(input.marks) ? input.marks : [];
  const sessions = Array.isArray(input.sessions) ? input.sessions : null;
  const exempt = (Array.isArray(input.exempt) ? input.exempt : []).map((s) => String(s ?? '')).filter(Boolean);
  const isExempt = (sid) => exempt.some((e) => (e.length >= 8 ? (sid === e || sid.startsWith(e)) : sid === e));
  const ledger = normalizeLedgerRead(input.ledgerRead);
  const pending = input.pending && typeof input.pending === 'object' ? input.pending : null;
  const chains = ledger.ok ? ledger.chains : [];
  const chainAts = chains.map((c) => Number(c?.at)).filter((n) => Number.isFinite(n));
  const minChainAt = chainAts.length ? Math.min(...chainAts) : null;

  const counts = {
    marks: marks.length, candidates: 0, dangling: 0, undecidable: 0, handed: 0,
    exempt: 0, grace: 0, running: 0, outOfWindow: 0, badMark: 0,
  };
  const items = [];

  for (const m of marks) {
    const sid = String(m?.sid ?? '');
    // ⚠️ 类型守门前置：`null` / `undefined` / `''` / 布尔 一律视为「非数字」——
    //    **绝不能靠裸 `Number()`**：`Number(null) === 0` ⇒ null 会被当成 1970 年的 mtime
    //    ⇒ 落进「窗口外」而不是「无法判定」（单测实测踩过）。
    const mtimeRaw = m?.mtime;
    const mtime = (mtimeRaw === null || mtimeRaw === undefined || mtimeRaw === ''
      || typeof mtimeRaw === 'boolean') ? NaN : Number(mtimeRaw);
    const it = { sid, mtime: Number.isFinite(mtime) ? mtime : null, ageMs: null, verdict: null, reason: null, route: null, running: null };

    // 类型守门（硬边界 ②）：mtime 必须是**有限数字**。喂 ISO 字符串（`markedAt`）⇒ 一律「无法判定」，
    // 绝不静默地参与比较（'…Z' - now = NaN ⇒ 比较恒 false ⇒ 老标记全落断链 = 就是那个坑）。
    if (!sid || !Number.isFinite(mtime)) {
      it.verdict = VERDICT.UNDECIDABLE; it.reason = 'bad-mark（缺 sid 或 mtime 非有限数字）';
      counts.undecidable++; counts.badMark++;
      items.push(it); continue;
    }
    it.ageMs = now - mtime;

    // 硬边界 ②：24h 外的老标记**不进候选面**（既不告警也不计入无法判定）。
    if (it.ageMs > candidateWindowMs) {
      it.verdict = VERDICT.OUT_OF_WINDOW; it.reason = `age>24h（${Math.round(it.ageMs / 3600_000)}h）`;
      counts.outOfWindow++; items.push(it); continue;
    }
    counts.candidates++;

    if (isExempt(sid)) {
      it.verdict = VERDICT.EXEMPT; it.reason = 'exempt（人工豁免名单）';
      counts.exempt++; items.push(it); continue;
    }

    // 空态 (i)(ii)：台账不可用 ⇒ 无法判定 ⇒ 静默。
    if (!ledger.ok) {
      it.verdict = VERDICT.UNDECIDABLE; it.reason = ledger.reason;
      counts.undecidable++; items.push(it); continue;
    }
    // 空态 (iii)：标记早于台账窗口下界 ⇒ 那条接力已滚出 `chains`（`.slice(-100)`）⇒ 无法判定，**不许当断链**。
    if (minChainAt === null || mtime < minChainAt) {
      it.verdict = VERDICT.UNDECIDABLE;
      it.reason = minChainAt === null ? 'chains-no-at' : `mtime<min(chains.at)（标记早于台账窗口 ${Math.round((minChainAt - mtime) / 60000)} 分钟）`;
      counts.undecidable++; items.push(it); continue;
    }
    // 空态 (iv)：会话面缺失 / 该 sid 不在快照里（已被 24h 自动归档搬走）/ `running` 非布尔。
    if (!sessions) {
      it.verdict = VERDICT.UNDECIDABLE; it.reason = 'no-session-snapshot';
      counts.undecidable++; items.push(it); continue;
    }
    const sess = sessions.find((s) => String(s?.sessionId ?? '') === sid) ?? null;
    if (!sess) {
      it.verdict = VERDICT.UNDECIDABLE; it.reason = 'sid-not-in-snapshot（会话可能已被 24h 自动归档搬走）';
      counts.undecidable++; items.push(it); continue;
    }
    if (typeof sess.running !== 'boolean') {
      it.verdict = VERDICT.UNDECIDABLE; it.reason = 'running-not-boolean';
      counts.undecidable++; items.push(it); continue;
    }
    it.running = sess.running;
    it.title = sess.title ?? null;

    // 已交棒三路（§5.1；第三路定义唯一真源 = 方案 §3.1.2 列表第 3 条）
    let route = null;
    if (chains.some((c) => String(c?.sourceSessionId ?? '') === sid && Number(c?.at) >= mtime - slackMs)) {
      route = 'chain-window';                       // 第一路（有时间窗）
    } else if (pending && String(pending.sourceSessionId ?? '') === sid) {
      route = 'pending-handoff';                    // 第二路（在途）
    } else if (chains.some((c) => String(c?.sourceSessionId ?? '') === sid && Number(c?.at) <= mtime && sessExists(sessions, c?.newSessionId))) {
      route = 'chain-entry';                        // 第三路（无时间窗，但必须 at <= mtime）
    }
    if (route) {
      it.verdict = VERDICT.HANDED; it.route = route; it.reason = `已交棒（${route}）`;
      counts.handed++; items.push(it); continue;
    }

    // 宽限 / 仍在跑 ⇒ 静默（都不算断链）
    if (it.ageMs < graceMs) {
      it.verdict = VERDICT.GRACE; it.reason = `宽限内（${Math.round(it.ageMs / 60000)}min < 15min）`;
      counts.grace++; items.push(it); continue;
    }
    if (sess.running === true) {
      it.verdict = VERDICT.RUNNING; it.reason = '源会话仍在运行（running=true）';
      counts.running++; items.push(it); continue;
    }

    it.verdict = VERDICT.DANGLING;
    it.reason = `标了没交棒：标记 ${Math.round(it.ageMs / 60000)} 分钟前落、会话已停手（running=false）、三路均无接力记录`;
    counts.dangling++;
    items.push(it);
  }

  counts.silent = counts.candidates - counts.dangling;
  const danglingKeys = items.filter((i) => i.verdict === VERDICT.DANGLING).map(handoffWarnKey);
  return { counts, items, danglingKeys };
}

// ---------------------------------------------------------------- 计划（纯函数）

/**
 * 计划函数（**纯函数**）：判「本轮要不要喊 / 喊哪些 / 落什么幂等键」。
 *
 * @param {object} input
 * @param {object} [input.judged]      `judgeDanglingHandoffs()` 的结果（缺省则用本函数入参现算）
 * @param {object|null} [input.warnState] `ledger.stats.relayHandoffWarn`（上轮落盘的幂等键与当日计数）
 * @param {boolean} [input.emit]       ⚠️ `false` ⇒ **只算不落**（不投递、不写幂等键）——
 *                                     persona 三红线 ①：只读观察档不得消费去重/冷却配额。
 * @param {string}  [input.mode]       队列档位（observe / report / notify）
 * @param {boolean} [input.dryRun]
 * @param {number}  [input.dailyMax]
 * @param {string}  [input.dateKey]    本地日期键（同源传 `queue-watch#dayKey(now)`）
 */
export function planRelayHandoffWatch(input = {}) {
  const judged = input.judged ?? judgeDanglingHandoffs(input);
  const now = num(input.now, Date.now());
  const emit = input.emit !== false;
  const mode = String(input.mode ?? 'observe');
  const dryRun = input.dryRun === true;
  const gateOpen = !dryRun && mode !== 'observe';          // 投递门禁（照 queue-watch.mjs:1735/:1771）
  const dailyMax = num(input.dailyMax, DEFAULT_DAILY_MAX);
  const dateKey = String(input.dateKey ?? dayKeyOf(now));
  const prev = input.warnState && typeof input.warnState === 'object' ? input.warnState : {};
  const warned = new Set((Array.isArray(prev.warnedKeys) ? prev.warnedKeys : []).map(String));
  const dayCount = (prev.day && String(prev.day.dateKey ?? '') === dateKey) ? num(prev.day.count, 0) : 0;

  const dangling = judged.items.filter((i) => i.verdict === VERDICT.DANGLING);
  const fresh = dangling.filter((i) => !warned.has(handoffWarnKey(i)));

  const out = {
    due: dangling.length > 0,
    fire: false,
    emit, gateOpen, mode, dryRun,
    allKeys: dangling.map(handoffWarnKey),
    freshKeys: fresh.map(handoffWarnKey),
    keys: [],
    skippedByCap: 0,
    suppressed: null,
    dayCount, dailyMax,
    text: null,
    patch: null,
    counts: judged.counts,
  };

  if (!dangling.length) { out.suppressed = 'no-dangling'; return out; }
  if (!fresh.length) { out.suppressed = 'already-warned'; return out; }   // 幂等：本标记已喊过
  if (!emit) { out.suppressed = 'emit-off'; return out; }                // 只读观测：只算不落
  if (!gateOpen) { out.suppressed = dryRun ? 'dry-run' : 'mode-observe'; return out; }
  const room = Math.max(0, dailyMax - dayCount);
  if (room <= 0) { out.suppressed = 'daily-cap'; return out; }

  const picked = fresh.slice(0, room);
  out.skippedByCap = fresh.length - picked.length;
  out.fire = true;
  out.keys = picked.map(handoffWarnKey);
  out.text = renderWarnText(picked, { now });
  out.patch = {
    warnedKeys: [...warned, ...out.keys].slice(-WARNED_KEYS_MAX),
    warnedAt: now,
    day: { dateKey, count: dayCount + picked.length },
  };
  return out;
}

/** 告警文案：**自带可照抄的下一步命令**（§5.1「看到之后做什么」）。 */
export function renderWarnText(items, opts = {}) {
  const now = num(opts.now, Date.now());
  const head = items.length === 1
    ? `⚠️ 标了没交棒：源会话 \`${String(items[0].sid).slice(0, 30)}…\` ⬅ ${Math.round((now - items[0].mtime) / 60000)} 分钟前标了【已交接】，但没有任何接力记录`
    : `⚠️ 标了没交棒：**${items.length}** 个源会话标了【已交接】却没有任何接力记录（${items.map((i) => String(i.sid).slice(0, 18)).join(' / ')}）`;
  return `${head}`
    + ' ⇒ 现在不会有人接手。'
    + ' 正确动作：`node <butler-root>\\tools\\session-relay.mjs --handoff "<交接档绝对路径>"`；'
    + ' 若本就不必接力（人工决定）⇒ 把 sid 加进接力告警豁免清单的 exempt 段（状态目录下，文件名见状态文件登记表）。'
    + ' （每个标记只喊一次；本告警不进 report/escalate 通道）';
}

// ---------------------------------------------------------------- 豁免名单（只读）

/**
 * 读豁免名单 `~/.dsh/butler-relay-handoff-warn.json`（**只读、容错**）。
 * 形态：`{ "schemaVersion": 1, "exempt": ["session-xxxx", "短id前缀"], "note": "…" }`
 * 缺文件 / 坏 JSON / `schemaVersion > 1` ⇒ **无豁免**（返回空名单 + `warning`，绝不抛）。
 */
export function loadRelayHandoffWarnState(opts = {}) {
  const home = opts.home ?? process.env.BUTLER_DSH_HOME ?? process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh');
  const file = opts.file ?? stateFileOf(EXEMPT_FILE_NAME, home);
  try {
    if (!fs.existsSync(file)) return { ok: true, exists: false, file, exempt: [], warning: null };
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sv = num(j?.schemaVersion, 1);
    if (sv > 1) return { ok: true, exists: true, file, exempt: [], warning: `schemaVersion=${sv} > 1 ⇒ 按无豁免处理` };
    const exempt = (Array.isArray(j?.exempt) ? j.exempt : []).map((s) => String(s ?? '')).filter(Boolean);
    return { ok: true, exists: true, file, exempt, warning: null };
  } catch (e) {
    return { ok: false, exists: true, file, exempt: [], warning: `读不到豁免名单（${e?.message ?? e}）⇒ 按无豁免处理` };
  }
}

// ---------------------------------------------------------------- 只读观察档

/** 只读观察档路径（`docs/`）。 */
export function observeDocPath(now = Date.now(), opts = {}) {
  const docsRoot = opts.docsRoot ?? path.join('<butler-root>', 'docs', 'reports');
  return path.join(docsRoot, `${OBSERVE_DOC_PREFIX}${opts.dateKey ?? dayKeyOf(now)}.md`);
}

/**
 * 渲染只读观察档（纯函数）。四计数明细 + 静默分解 + 逐条判定。
 * 「候选数 = 无法判定数」= 本轮**整体静默**的可见性判据（账本/会话面缺失时唯一的信号）。
 */
export function renderObserveDoc(payload = {}, opts = {}) {
  const judged = payload.judged ?? { counts: {}, items: [] };
  const planned = payload.planned ?? null;
  const c = judged.counts ?? {};
  const hh = (t) => { const d = new Date(num(t, Date.now())); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
  const lines = [];
  lines.push(`# 接力交接巡检（只读观察档）· ${opts.dateKey ?? dayKeyOf(payload.now ?? Date.now())}`);
  lines.push('');
  lines.push('> 由 `butler-queue-tick.mjs` 每 1 分钟刷新（**只读**：不删标记、不改 relay 台账、**不消费去重/冷却配额**）。');
  lines.push('> 口径真源：`docs/` §5.1；本档只记计数，**本身不投递**。');
  lines.push('');
  lines.push(`- 刷新时刻：${hh(payload.now)} · 档位 **${payload.mode ?? '-'}** · dryRun=${payload.dryRun === true} · emit=${planned ? planned.emit : '-'} · 投递门禁=${planned ? (planned.gateOpen ? '开' : '关') : '-'}`);
  lines.push(`- **候选数 = ${c.candidates ?? 0}**（24h 内标记）· **命中数（断链）= ${c.dangling ?? 0}** · **无法判定数 = ${c.undecidable ?? 0}** · **已交棒数 = ${c.handed ?? 0}**`);
  lines.push(`- 标记总数 ${c.marks ?? 0} · 窗口外（>24h）${c.outOfWindow ?? 0} · 豁免 ${c.exempt ?? 0} · 宽限内 ${c.grace ?? 0} · 仍在跑 ${c.running ?? 0}`);
  if ((c.candidates ?? 0) > 0 && (c.candidates ?? 0) === (c.undecidable ?? 0)) {
    lines.push('- 🟡 **本轮整体静默**：候选数 = 无法判定数（`chains` 空 / 台账缺失或不可读 / 标记 sid 不在会话面快照）⇒ 判据输入缺失，**不是零命中**。');
  }
  if (planned && planned.due) {
    lines.push(`- 本轮计划：断链 ${c.dangling ?? 0} · 新键 ${planned.freshKeys.length} · 实投 ${planned.keys.length}`
      + `${planned.fire ? ' ⇒ **已告警**' : `（未投递：${planned.suppressed ?? '-'}）`}${planned.skippedByCap ? ` · 超单日上限跳过 ${planned.skippedByCap}` : ''}`);
  }
  lines.push('');
  lines.push('## 逐条判定（最多 50 条）');
  lines.push('');
  lines.push('| sid | 标记 mtime | 年龄 | 判定 | running | 依据 |');
  lines.push('|---|---|---|---|---|---|');
  const items = (judged.items ?? []).slice(0, 50);
  if (!items.length) lines.push('| — | — | — | （无标记文件） | — | — |');
  for (const it of items) {
    const age = it.ageMs === null ? '-' : `${Math.round(it.ageMs / 60000)}min`;
    const mt = it.mtime ? new Date(it.mtime).toISOString().replace('T', ' ').slice(0, 19) : '-';
    lines.push(`| \`${String(it.sid).slice(0, 26)}\` | ${mt} | ${age} | **${it.verdict}** | ${it.running === null ? '-' : it.running} | ${String(it.reason ?? '').replace(/\|/g, '/')} |`);
  }
  lines.push('');
  lines.push(`> 判定标签：dangling 断链（唯一会告警的）· handed 已交棒 · undecidable 无法判定（静默）· grace 宽限内 · running 源会话仍在跑 · exempt 人工豁免 · out-of-window 24h 外。`);
  lines.push('');
  // §2.2 档级标记（`relaywatch` 族 · 方案 §3.1）：插入点由权威源 `insertAtFor()` 按文档真实 H1 定（落点 L2）
  const docBody = lines.join('\n') + '\n';
  return stampDocMark(docBody, 'relaywatch', insertAtFor(firstH1Index(docBody)));
}

/**
 * 写只读观察档（整段替换、内容相同则跳过）。
 * ⚠️ `dryRun === true` ⇒ **零写盘**（守 queue job 既有 `--dry-run` 契约；方案对 dry-run 是否写只读档留白，
 * 本实现取保守侧 —— 见交付报告「与方案的偏差登记」）。
 */
export function writeObserveDoc(file, content, opts = {}) {
  if (opts.dryRun === true) return { ok: true, action: 'dry-run', file };
  if (opts.write === false) return { ok: true, action: 'disabled', file };
  try {
    let prev = null;
    try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 不存在即首次写 */ }
    if (prev === content) return { ok: true, action: 'unchanged', file };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return { ok: true, action: prev === null ? 'created' : 'updated', file };
  } catch (e) {
    return { ok: false, action: 'error', file, error: e?.message ?? String(e) };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 【改动 1 · 断链看门狗（2026-09-29）】链静止判定 + 自动重投计划 + 状态文件
//
// 口径真源：`docs/` §0 / §1（判定三条 + 动作两档 + 节流）
//   实测依据：`docs/` §0 / §4.3（缺口 G8：历史 33 个
//   「停 ≥25 分钟」窗口内零闸门记录 = 该干活的那一棒没干活、且没有任何机制知道）
//
// ── 与上面【候选 C】的分工（**两件事，别混**）─────────────────────────────────
//   · 候选 C（`judgeDanglingHandoffs`）= 「**标了没交棒**」：主判据 = 标记文件，窗口 24h，
//     只告警、**不动作**；它管的是「源会话标了【已交接】却没交棒」。
//   · 本段 = 「**链静止**」：主判据 = 台账 `chains` 尾条 + 会话面，窗口 = 30 分钟，
//     默认只报警、**可配置自动重投**；它管的是「接手会话被唤醒后没继续干活」（= G8 实测形态）。
//   ⚠️ 本段是**纯新增**：上面所有既有函数**一行未改**（卡面「只加分支与纯函数」）；
//      `judgeChainSilence()` 只是**调用**既有的 `judgeDanglingHandoffs()`（输入域与语义不变）。
//
// ── 三条判据（同时成立才动手 · 方案 §1）─────────────────────────────────────
//   ① 同一主线「最后一次成功接力」距今 > 30 分钟（`lastSuccessAt` + `wakeAt` 取大者为锚点）；
//   ② 存在「被唤醒但没交棒」的会话 —— 两形态：
//        · `chain-tail`：该主线 `chains` 里 `at` 最大的那条的 `newSessionId` 会话，
//          它**不是任何 chain 的 `sourceSessionId`**（= 没有续棒）；
//        · `mark-dangling`：既有候选 C 判定的「标了没交棒」（标记文件为准、标题作佐证）。
//        （方案原文写的「`pendingHandoff` 指向它」与 `chain-tail` 是**同一时刻的同一件事**：
//          `pendingHandoff` 与 `chains` 尾条在同一次 RMW 里写、指向同一个 `newSessionId`，
//          而 `pendingHandoff` 有 30 分钟 TTL 会先被清 ⇒ 以 `chains` 为载体的 `chain-tail`
//          是它的**超集**，故不另造第三形态。）
//   ③ 该主线**没有**其他在跑会话（防止误伤正常长跑棒）。
//
// ── 防误伤第四条（本卡自决 · 交付报告登记）─────────────────────────────────
//   「链正常结束」（主人收工）与「链断了」在判据 ①~③ 上**长得一样**（接手会话也是 running=false）。
//   ⇒ 增加：接手会话的标题必须是**未完结态**（【续】/【运行】/【已交接】），
//     或 `running === true`；标题是【完成】⇒ 判 `settled` 静默（**宁可漏报不误报**）。
//
// ── 防误伤第五条（2026-09-29【待续】误报修复）───────────────────────────────
//   现象：主线**有意**停在【待续】（= 操作者主动标记「收手但没闭环，等主人拍板 / 等外部条件」）
//     时，原标题分类把【待续】算成 `unfinished` ⇒ 被每 30 分钟误报一次断链（`rehandoff:true` 还会误重投）。
//     实测：2026-09-29 11:4x 驾照 v4 主线停在【待续】期间操作者被该看门狗喊过。
//   ⇒ 修法：新增 `PAUSED_TITLE_PREFIXES = ['【待续】']` + `titleStateOf` 返回 `paused`
//     + `CHAIN_VERDICT.PAUSED`，判定**紧接 `settled` 之后短路**（与静默时长无关）。
//   ⇒ 红线：本判定**不消耗节流配额**（不写 `lastNotifiedAt` / 不写状态文件 `chains[chainKey]`）
//     —— 实现层面天然满足：`planChainWatchdog()` 只把 `SILENT` 项变成 actions，
//     而状态写入只发生在 actions 执行之后（`applyWatchdogOutcome`）。
//     单测对此有专门的负向断言（见 `_test\test-relay-chain-watchdog.mjs` G 段）。
//   ⇒ 边界：**只认候选会话自己的标题**。同主线别的会话标了【待续】、而候选会话仍是【运行】
//     ⇒ 照旧判断链（宁可漏报面窄一点，也不引入「一条主线只要有人喊停就永久静默」的哑火面）。
//
// ── 防误伤第六条（2026-10-08 · 标题缺失/判不出 ⇒ 静默）───────────────────
//   现象：链正常收尾、接手会话**从未标三态**（`title` 为空）时，被判 `silent-chain` 连发报警。
//     实测：2026-09-29 11:25:14→11:31:30 主线「整夜接力四改」（sid `<session-id>…`）
//     6 条 alert，相邻间隔恒 ≈75 秒；该会话归档头**无 title 字段**（= 空标题）。
//   根因：`finish()` 里的保守门写成 `titleState !== 'unfinished' && running !== true`（**AND**）
//     ⇒ 会话 `running === true` 时整条件为 false ⇒ 绕过保守门 ⇒ 标题 `unknown` 也落 SILENT。
//   修法：标题判据改**硬前置** —— `titleState !== 'unfinished'` ⇒ `undecidable` 静默，与 `running` 无关
//     （标题缺失 = 判不出「还没干完」；宁可漏报，不误报 —— 与判据④同一原则）。
//   ⇒ 影响面：只**收窄候选面**（`unknown` 一律静默），不新增任何动作；正常链的接手会话标题是
//     `【续】<主线名>`（relay 建的），仍在候选面内 ⇒ 机制不失能。
//
// ── 防误伤第七条（2026-10-10 · N18 · 主人拍板 (b)「改判据」）──────────────
//   现象（**14/14 实证**）：链尾会话**仍在干活**（长棒连干 >30 分钟是整夜模式常态）时，
//     旧判据只看「接力后 30 分钟没交棒 + 标题未完结」⇒ 每棒必然误报一次「接力链断了」，
//     且零动作（`rehandoff-disabled 只报警`）。实测：2026-10-10 全库 14 条主线各报 1 次，
//     当次报警的「V2.9.X冲刺600-第12棒」链在报警后 38 分钟**正常交棒**（台账 chain 完整）。
//     真源：`docs/` §4.2 · 晨报第 5 棒 §8.4 第 5 条 ·
//           `docs/` §二 N18。
//   ⇒ 修法：**链尾仍活跃 ⇒ 不判断链**（新判定 `CHAIN_VERDICT.ACTIVE`，静默 + 零配额）。
//     「仍活跃」= 下列任一（纯函数 `chainTailActivity()`，输入只取**会话面快照**已有字段）：
//       · `running === true`（该会话此刻有 turn 在跑 ⇒ 明确在干活）；
//       · 最后活动 `updatedAt` 距今 `<= activeWindowMs`（缺省 `WATCHDOG_ACTIVE_MS` = 30 分钟）。
//     ⚠️ **真断链照报**（红线）：链尾**已停**（`running === false` 且最后活动已超窗口）⇒
//       判据与改动前逐字相同 ⇒ 仍落 `silent-chain` + 报警。
//     ⚠️ **两个信号都拿不到**（`running !== true` 且 `updatedAt` 缺失/非数字）⇒
//       **判不出活跃 ⇒ 不静默**（宁可漏报面不动，也不引入「会话面缺字段就永久哑火」）。
//     ⚠️ 已知代价：真断链的报警**最多晚一个 `activeWindowMs`**（会话停手后要等窗口过期才报）
//       —— 这是「不误报」与「不漏报」的取舍，主人 2026-10-10 拍板取前者。
//     ⚠️ 位置：在 `titleState` 检查**之后**、判据③之前 ⇒ `settled` / `paused` / `undecidable`
//       三态语义与优先级**逐字不变**（既有单测断言不受影响）。
//
// ── 节流（主人令 · 2026-10-08 修正）───────────────────────────────────────
//   · 同链 **30 分钟**内最多 **1 次动作**（不论重投还是报警）—— 判据 = `lastNotifiedAt`
//     （任何一次**真投递**都推进它；旧状态没有该字段 ⇒ 回退取 `lastAttemptAt`）。
//     ⚠️ 0.1.1 及以前只认 `lastAttemptAt`，而它**只在重投时写** ⇒ 「只报警」形态下节流判据恒 false
//     ⇒ 节流失效、每 tick 一条 alert（实测 6 条 / 75 秒间隔，见缺陷 ①）。
//   · 累计最多 **3** 次重投（`WATCHDOG_MAX_ATTEMPTS`），第 4 次起改**升级报警**；
//   · 连续失败 **2** 次停招（`WATCHDOG_FAIL_STREAK_MAX`，与 relay 默认 `maxConsecutiveFailures` 同值）；
//   · 同链同轮最多 1 条动作（`planChainWatchdog` 内按 `chainKey` 去重 ⇒ 不会重复建会话）；
//   · 次数与时刻**落状态文件** `~/.dsh/butler-relay-watchdog.json`（可复核、重启不丢）。
//
// ── 默认关（**本卡红线**）────────────────────────────────────────────────
//   `enabled !== true` ⇒ `planChainWatchdog()` 直接返回 `suppressed:'disabled'`、零动作；
//   生产 `butler-autonomy-limits.json` **没有** `relayWatchdog` 键 ⇒ 缺省即关。
//   放行 = 加键（乙档，等主人拍板），**不是**改代码。
// ══════════════════════════════════════════════════════════════════════════════

export const CHAIN_WATCHDOG_VERSION = '0.1.3';   // 0.1.3 = 2026-10-10 N18「链尾仍活跃 ⇒ 静默」（`CHAIN_VERDICT.ACTIVE`）
                                                 // 0.1.2 = 2026-10-08 两缺陷修复（节流覆盖全部动作；标题缺失 ⇒ 静默）
                                                 // 0.1.1 = 2026-09-29【待续】误报修复（paused 判定）

/** 判据①：链静止多久才算「断了」（主人令 30 分钟）。 */
export const SILENT_GAP_MS = 30 * 60 * 1000;
/** 【0.1.3 · N18】链尾「仍活跃」窗口：会话面 `updatedAt` 距今不超过它 ⇒ 视为仍在干活 ⇒ 不判断链。
 *  缺省与 `SILENT_GAP_MS` 同值（30 分钟）；可比配置 `relayWatchdog.activeWindowMs` 覆盖。 */
export const WATCHDOG_ACTIVE_MS = 30 * 60 * 1000;
/** 时钟抖动容差：`updatedAt` 比 `now` 略晚（跨机/时钟漂移）仍算「新鲜」，超过它按不新鲜处理。 */
export const WATCHDOG_ACTIVE_SKEW_MS = 5 * 60 * 1000;
/** 节流：同链两次重投的最小间隔（主人令 30 分钟）。 */
export const WATCHDOG_THROTTLE_MS = 30 * 60 * 1000;
/** 累计重投上限；第 `WATCHDOG_MAX_ATTEMPTS + 1` 次起不再重投 ⇒ 升级报警。 */
export const WATCHDOG_MAX_ATTEMPTS = 3;
/** 连续失败停招阈值（与 `session-relay` 的 `maxConsecutiveFailures` 默认值同源）。 */
export const WATCHDOG_FAIL_STREAK_MAX = 2;
/** 升级 / 停招 报警的重复间隔（同链同一状态每 6 小时最多报一次，防每分钟一轮刷屏）。 */
export const WATCHDOG_ESCALATE_REPEAT_MS = 6 * 3600 * 1000;
/** 【2c-B2】看门狗状态路径（统一入口；legacy 期 = 旧名）。 */
function watchdogStateFileOf(home) {
  return resolveStatePath(WATCHDOG_STATE_NAME, { home }).path;
}
/** 状态文件（`~/.dsh/butler-relay-watchdog.json`）。 */
export const WATCHDOG_STATE_NAME = 'butler-relay-watchdog.json';
/** 只读观察档文件名前缀（`docs/`）。 */
export const WATCHDOG_DOC_PREFIX = 'relay-watchdog-';
/** 每链历史保留条数。 */
export const WATCHDOG_HISTORY_MAX = 20;
/** 状态里沉寂链的保留期（超期且已升级 ⇒ 清理，防状态文件无限增长）。 */
export const WATCHDOG_CHAIN_KEEP_MS = 14 * 24 * 3600 * 1000;
/** 找交接档：`mtime` 允许比链时间早多少（档是在交棒**之前**写的）。 */
export const HANDOFF_DOC_LOOKBACK_MS = 24 * 3600 * 1000;
/** 找交接档：`mtime` 允许比链时间晚多少（时钟抖动余量）。 */
export const HANDOFF_DOC_LOOKAHEAD_MS = 5 * 60 * 1000;

/** 标题前缀：命中 ⇒ 该会话「还没干完 / 还没交棒」⇒ 是断链候选。 */
export const UNFINISHED_TITLE_PREFIXES = Object.freeze(['【续】', '【运行】', '【已交接】', '【交接】']);
/** 标题前缀：命中 ⇒ 该会话是**有意停手**（等主人拍板 / 等外部条件）⇒ **不作**断链候选。
 *  ⚠️ 2026-09-29 修复：`【待续】` 原先误列进 `UNFINISHED_TITLE_PREFIXES`，导致「主线有意停在
 *  【待续】等主人拍板」被每 30 分钟误报成断链（`rehandoff:true` 时还会误重投）。
 *  会话标题三态里【待续】= 操作者主动标记的「收手但没闭环」⇒ 语义上就是「别催」。 */
export const PAUSED_TITLE_PREFIXES = Object.freeze(['【待续】']);
/** 标题前缀：命中 ⇒ 该会话已明确收工 ⇒ **不作**断链候选（防「链正常结束」误报）。 */
export const SETTLED_TITLE_PREFIXES = Object.freeze(['【完成】']);

/** 候选形态（只读档与单测都认这几个字面量）。 */
export const CHAIN_FORM = Object.freeze({
  TAIL: 'chain-tail',      // 链尾接手会话没续棒（G8 实测形态）
  MARK: 'mark-dangling',   // 标了【已交接】却没交棒（候选 C 的形态）
});

/** 判定标签。 */
export const CHAIN_VERDICT = Object.freeze({
  SILENT: 'silent-chain',       // 三条判据成立 ⇒ 待动作
  WITHIN_GAP: 'within-gap',     // 静默时长未到 30 分钟 ⇒ 静默
  OTHER_RUNNING: 'other-running', // 同主线还有别的会话在跑 ⇒ 静默（防误伤）
  HANDED: 'handed',             // 已续棒 ⇒ 静默
  SETTLED: 'settled',           // 标题显示已收工（【完成】）⇒ 静默
  PAUSED: 'paused',             // 标题【待续】= 有意停手（等主人/等外部条件）⇒ 静默，**零动作零配额**
  ACTIVE: 'active-tail',        // 【0.1.3 · N18】链尾**仍活跃**（在跑 turn / 最近还有活动）⇒ 静默，**零动作零配额**
  UNDECIDABLE: 'undecidable',   // 输入缺失 / 标题判不出 ⇒ 静默
});

/** 动作类型。 */
export const CHAIN_ACTION = Object.freeze({
  REHANDOFF: 'rehandoff',   // 自动重投（乙档动作；需开关 + 档位门禁）
  ALERT: 'alert',           // 只报警（开关关 / 档位门禁关 / 找不到档 等）
  ESCALATE: 'escalate',     // 重投用满 3 次 ⇒ 升级报警给主人
  HALTED: 'halted',         // 连续失败 2 次 ⇒ 停招（只报警）
  THROTTLED: 'throttled',   // 30 分钟节流内 ⇒ 静默
});

// ---------------------------------------------------------------- 标题解析（纯函数）

/**
 * 标题 → 主线名候选：剥掉前导 `【…】` 标记（最多 3 层）后归一化。
 * 例：`【续】整夜接力可靠性四条` ⇒ `整夜接力可靠性四条`；`【已交接】A B` ⇒ `A B`。
 */
export function parseMainlineFromTitle(title) {
  let rest = String(title ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const m = rest.match(/^【[^】]*】\s*/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return normalizeMainline(rest);
}

/**
 * 标题三/四态：`unfinished`（候选）/ `settled`（已收工）/ `paused`（有意停手，等主人拍板）
 * / `unknown`（判不出 ⇒ 保守静默）。
 */
export function titleStateOf(title) {
  const t = String(title ?? '').trim();
  if (SETTLED_TITLE_PREFIXES.some((p) => t.startsWith(p))) return 'settled';
  if (PAUSED_TITLE_PREFIXES.some((p) => t.startsWith(p))) return 'paused';
  if (UNFINISHED_TITLE_PREFIXES.some((p) => t.startsWith(p))) return 'unfinished';
  return 'unknown';
}

// ---------------------------------------------------------------- 判定（纯函数）

/**
 * 【0.1.3 · N18】链尾「仍活跃」判据（**纯函数**：不读文件、不读时钟、不发通知）。
 *
 * 输入只取**会话面快照**里已有的两个字段（`queue-watch.mjs#readSessions()` 已带回）：
 *   · `sess.running`   —— 该会话此刻是否有 turn 在跑；
 *   · `sess.updatedAt` —— 该会话最后活动时刻（毫秒）。
 * ⇒ 任一命中即「仍活跃」；两者都拿不到 ⇒ **判不出活跃**（`active:false`）⇒ 调用方照旧判断链。
 *
 * @param {{sess?:object|null, now?:number, activeWindowMs?:number}} input
 * @returns {{active:boolean, signal:'running'|'fresh'|null, freshMs:number|null, detail:string}}
 */
export function chainTailActivity(input = {}) {
  const now = num(input.now, Date.now());
  const windowMs = num(input.activeWindowMs, WATCHDOG_ACTIVE_MS);
  const sess = input.sess && typeof input.sess === 'object' ? input.sess : null;
  const running = sess?.running === true;
  const updatedAtRaw = Number(sess?.updatedAt);
  const freshMs = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? now - updatedAtRaw : null;
  // 新鲜 = 距今不超过窗口（允许 `WATCHDOG_ACTIVE_SKEW_MS` 的时钟抖动：`updatedAt` 略晚于 now 也算新鲜）
  const fresh = freshMs !== null && freshMs <= windowMs && freshMs >= -WATCHDOG_ACTIVE_SKEW_MS;
  const min = (ms) => Math.round(ms / 60000);
  if (running) {
    return {
      active: true, signal: 'running', freshMs,
      detail: `链尾会话仍在跑 turn（running=true${fresh === true && freshMs !== null ? `，最后活动 ${min(freshMs)} 分钟前` : ''}）`,
    };
  }
  if (fresh) {
    return {
      active: true, signal: 'fresh', freshMs,
      detail: `${min(freshMs)} 分钟前仍有活动（< ${min(windowMs)} 分钟窗口）`,
    };
  }
  return {
    active: false, signal: null, freshMs,
    detail: freshMs === null ? '无近端活动信号（`updatedAt` 缺失）' : `最后活动已是 ${min(freshMs)} 分钟前（≥ ${min(windowMs)} 分钟窗口）`,
  };
}

/**
 * 链静止判定（**纯函数**：不读文件、不读时钟、不发通知）。
 *
 * @param {object} input
 * @param {Array} [input.chains]       台账 `chains`（有 `mainline` / `at` / `sourceSessionId` / `newSessionId`）
 * @param {object|null} [input.ledgerRead] `session-relay#readLedger()` 返回值（给 `chains` 用；两者都给时以 `chains` 为准）
 * @param {Array|null} [input.sessions] 会话面快照
 * @param {Array} [input.marks]         标记文件目录（`listHandedMarks()` 结果）
 * @param {object|null} [input.pending] `pendingHandoff`（透传给候选 C 判据）
 * @param {string[]} [input.exempt]     豁免 sid
 * @param {object|null} [input.danglingJudged] 编排层已算好的候选 C 结果（复用，省一次计算）
 * @param {number} [input.now]
 * @param {number} [input.silentGapMs]
 * @param {number} [input.activeWindowMs] 【0.1.3 · N18】链尾「仍活跃」窗口（缺省 `WATCHDOG_ACTIVE_MS`）
 */
export function judgeChainSilence(input = {}) {
  const now = num(input.now, Date.now());
  const gapMs = num(input.silentGapMs, SILENT_GAP_MS);
  const activeWindowMs = num(input.activeWindowMs, WATCHDOG_ACTIVE_MS);
  const candidateWindowMs = num(input.candidateWindowMs, CANDIDATE_WINDOW_MS);
  const sessions = Array.isArray(input.sessions) ? input.sessions : null;
  const marks = Array.isArray(input.marks) ? input.marks : [];
  const pending = input.pending && typeof input.pending === 'object' ? input.pending : null;
  // ⚠️ 入参两条路：① 调用方给 `ledgerRead`（生产路径 = `session-relay#readLedger()` 的返回值，含「读不到」空态）
  //   ② 调用方只给 `chains`（纯函数用法 / 单测）⇒ 视为「台账可用」并把它交给候选 C 判据，
  //   否则只给 `chains` 的调用方会看到「形态二永远判不出」这种静默失效。
  const chainsGiven = Array.isArray(input.chains) ? input.chains.filter((c) => c && typeof c === 'object') : null;
  const ledgerRead = input.ledgerRead !== undefined
    ? input.ledgerRead
    : (chainsGiven ? { ok: true, exists: true, file: null, data: { schemaVersion: 1, chains: chainsGiven } } : undefined);
  const chains = chainsGiven ?? (normalizeLedgerRead(ledgerRead).chains ?? []);

  const counts = {
    chains: 0, candidates: 0, silent: 0, withinGap: 0, otherRunning: 0, handed: 0,
    settled: 0, paused: 0, active: 0, undecidable: 0, markHits: 0, tailHits: 0, dedupDropped: 0,
  };
  const items = [];

  const sessOf = (s) => (sessions ? (sessions.find((x) => String(x?.sessionId ?? '') === String(s)) ?? null) : null);

  // 主线 → 尾条（`at` 最大者）；会话 → 主线（台账优先、标题兜底）
  const byMainline = new Map();
  const sessMainline = new Map();
  for (const c of chains) {
    const m = normalizeMainline(c?.mainline);
    if (!m) continue;
    const src = String(c?.sourceSessionId ?? '');
    const nid = String(c?.newSessionId ?? '');
    if (src && !sessMainline.has(src)) sessMainline.set(src, m);
    if (nid && !sessMainline.has(nid)) sessMainline.set(nid, m);
    const at = Number(c?.at);
    if (!Number.isFinite(at)) continue;
    const cur = byMainline.get(m);
    if (!cur || at > cur.at) {
      byMainline.set(m, { mainline: m, at, chainId: c?.chainId ?? null, sourceSessionId: src, newSessionId: nid });
    }
  }
  counts.chains = byMainline.size;
  if (sessions) {
    for (const s of sessions) {
      const sid = String(s?.sessionId ?? '');
      if (!sid || sessMainline.has(sid)) continue;
      const m = parseMainlineFromTitle(s?.title);
      if (m) sessMainline.set(sid, m);
    }
  }
  /** 该会话是不是「某条 chain 的源」= 它交过棒。 */
  const handedBy = new Set(chains.map((c) => String(c?.sourceSessionId ?? '')).filter(Boolean));
  /** 判据③：同主线**除候选自己**之外仍在跑的会话。 */
  const othersRunning = (mainline, selfSid) => (!sessions || !mainline ? [] : sessions.filter((s) => {
    const sid = String(s?.sessionId ?? '');
    if (!sid || sid === String(selfSid)) return false;
    if (sessMainline.get(sid) !== mainline) return false;
    return s?.running === true;
  }).map((s) => String(s.sessionId)));

  const finish = (base) => {
    const it = {
      ...base, silentMs: now - Number(base.wakeAt), othersRunning: [],
      running: null, title: null, titleState: null, verdict: null, reason: null,
    };
    if (!sessions) { it.verdict = CHAIN_VERDICT.UNDECIDABLE; it.reason = 'no-session-snapshot'; return items.push(it); }
    const sess = sessOf(it.sid);
    if (!sess) { it.verdict = CHAIN_VERDICT.UNDECIDABLE; it.reason = 'sid-not-in-snapshot（会话可能已被 24h 自动归档搬走）'; return items.push(it); }
    it.running = sess.running === true;
    it.title = String(sess.title ?? '');
    it.titleState = titleStateOf(it.title);
    // 判据②的防误伤：标题显示已收工 ⇒ 静默（链正常结束与断链在这一层长得一样）
    if (it.titleState === 'settled') { it.verdict = CHAIN_VERDICT.SETTLED; it.reason = '标题【完成】⇒ 链正常收工（非断链）'; return items.push(it); }
    // 【2026-09-29 修复】标题【待续】= **有意停手**（操作者主动标记的「收手但没闭环，等主人/等外部条件」）
    //   ⇒ 静默。位置在 `settled` 之后、静默时长判据之前：与时长无关（有意停 5 分钟还是 5 小时都别催）。
    //   后续影响面 = 零：`planChainWatchdog()` 只对 `SILENT` 项动作 ⇒ 本判定既不报警、不重投，
    //   也不写状态文件（**不消耗 30 分钟节流配额、不落 `lastNotifiedAt`**）。
    if (it.titleState === 'paused') { it.verdict = CHAIN_VERDICT.PAUSED; it.reason = '标题【待续】⇒ 有意停手（等主人拍板/等外部条件），不是断链'; return items.push(it); }
    // 判据①：静默时长
    if (!(it.silentMs >= gapMs)) {
      it.verdict = CHAIN_VERDICT.WITHIN_GAP;
      it.reason = `静默 ${Math.round(it.silentMs / 60000)}min < ${Math.round(gapMs / 60000)}min`;
      return items.push(it);
    }
    // 【2026-10-08 修复 · 误报 ②】标题判据是**硬前置**，不再让 `running` 绕过它 ——
    //   只有**明确未完结**（【续】/【运行】/【已交接】/【交接】）才是断链候选；
    //   标题缺失 / 判不出（`titleState === 'unknown'`）⇒ 一律静默（宁可漏报不误报）。
    //   ⚠️ 原实现写成 `it.titleState !== 'unfinished' && it.running !== true`（**AND**）⇒
    //   只要该会话 `running === true` 就能把整条件置 false ⇒ 绕过保守门 ⇒ 标题为空（从未标三态）
    //   的会话被判 `silent-chain` 并**连发报警**。实测：2026-09-29 11:25:14→11:31:30
    //   主线「整夜接力四改」（sid `<session-id>…`）6 条 alert，相邻间隔恒 75 秒，
    //   而该会话归档头**无 title 字段**（= 空标题）⇒ 它只可能从 `running === true` 这条路漏出去。
    if (it.titleState !== 'unfinished') {
      it.verdict = CHAIN_VERDICT.UNDECIDABLE;
      it.reason = `title-not-unfinished（标题「${String(it.title || '').slice(0, 20) || '（空）'}」判不出「还没干完」，running=${it.running}）⇒ 保守静默`;
      return items.push(it);
    }
    // ── 【0.1.3 · N18 · 2026-10-10】防误伤第七条：**链尾仍活跃 ⇒ 不判断链**（治 14/14 误报）──
    //   位置：`settled` / `paused` / `undecidable` 之后、判据③之前 ⇒ 那三态语义与优先级逐字不变。
    //   判据 = `chainTailActivity()`（`running === true` 或最后活动在窗口内）；两者都拿不到 ⇒ 不静默。
    //   ⚠️ 本判定**不消耗节流配额**（不写状态、不落 `lastNotifiedAt`）：`planChainWatchdog()` 只对
    //     `SILENT` 项动作 ⇒ 与 `paused` / `undecidable` 同一条零配额通道。
    const act = chainTailActivity({ sess, now, activeWindowMs });
    if (act.active) {
      it.verdict = CHAIN_VERDICT.ACTIVE;
      it.activeSignal = act.signal;
      it.activeMs = act.freshMs;
      it.reason = `链尾仍活跃：${act.detail} ⇒ 不判断链（长棒常态，不是断链）`;
      return items.push(it);
    }
    // 判据③：同主线还有别的会话在跑 ⇒ 静默（防误伤正常长跑棒）
    it.othersRunning = othersRunning(it.mainline, it.sid);
    if (it.othersRunning.length) {
      it.verdict = CHAIN_VERDICT.OTHER_RUNNING;
      it.reason = `同主线另有 ${it.othersRunning.length} 个会话在跑 ⇒ 不判断链`;
      return items.push(it);
    }
    it.verdict = CHAIN_VERDICT.SILENT;
    it.reason = `链静止 ${Math.round(it.silentMs / 60000)} 分钟：${it.form === CHAIN_FORM.TAIL ? '接力后的接手会话没有续棒' : '标了【已交接】却没有接力记录'}`;
    return items.push(it);
  };

  // ── 形态一：链尾静默（每主线一条）────────────────────────────────────────
  for (const tail of byMainline.values()) {
    counts.tailHits++;
    const base = {
      form: CHAIN_FORM.TAIL, chainKey: tail.mainline, mainline: tail.mainline,
      sid: tail.newSessionId, chainId: tail.chainId, sourceSessionId: tail.sourceSessionId,
      wakeAt: tail.at, lastSuccessAt: tail.at,
    };
    if (!tail.newSessionId) {
      items.push({ ...base, silentMs: null, othersRunning: [], running: null, title: null, titleState: null, verdict: CHAIN_VERDICT.UNDECIDABLE, reason: 'chain-newSessionId-missing' });
      continue;
    }
    if (handedBy.has(tail.newSessionId)) {
      items.push({ ...base, silentMs: now - tail.at, othersRunning: [], running: null, title: null, titleState: null, verdict: CHAIN_VERDICT.HANDED, reason: '该会话已续棒（是某条 chain 的源）' });
      continue;
    }
    finish(base);
  }

  // ── 形态二：标了没交棒（沿用候选 C 的判定，本段只借它的结果）──────────────
  let danglingJudged = input.danglingJudged ?? null;
  if (!danglingJudged) {
    danglingJudged = judgeDanglingHandoffs({
      marks, ledgerRead, sessions, pending,
      exempt: input.exempt, now, candidateWindowMs,
    });
  }
  for (const d of (danglingJudged.items ?? []).filter((i) => i.verdict === VERDICT.DANGLING)) {
    counts.markHits++;
    const sid = String(d.sid);
    const mainline = sessMainline.get(sid) ?? '';
    const lastSuccessAt = mainline && byMainline.has(mainline) ? byMainline.get(mainline).at : null;
    const wakeAt = Number(d.mtime);
    const base = {
      form: CHAIN_FORM.MARK, chainKey: mainline || `?${sid}`, mainline, sid, chainId: null,
      sourceSessionId: sid, wakeAt, lastSuccessAt: Number.isFinite(Number(lastSuccessAt)) ? Number(lastSuccessAt) : null,
    };
    if (!mainline) {
      items.push({ ...base, silentMs: now - wakeAt, othersRunning: [], running: null, title: null, titleState: null, verdict: CHAIN_VERDICT.UNDECIDABLE, reason: 'mainline-unknown（台账与标题都取不到主线名）' });
      continue;
    }
    finish(base);
  }

  // ── 去重（同一 sid 只留一条，优先级：silent > within-gap > 其它）──────────
  const rank = (v) => (v === CHAIN_VERDICT.SILENT ? 4 : v === CHAIN_VERDICT.WITHIN_GAP ? 3
    : v === CHAIN_VERDICT.OTHER_RUNNING ? 2 : v === CHAIN_VERDICT.UNDECIDABLE || v === CHAIN_VERDICT.ACTIVE ? 1 : 0);
  const dedup = new Map();
  for (const it of items) {
    const k = String(it.sid || `${it.form}|${it.chainKey}`);
    const prev = dedup.get(k);
    if (!prev) { dedup.set(k, it); continue; }
    counts.dedupDropped++;
    if (rank(it.verdict) > rank(prev.verdict)) dedup.set(k, it);
  }
  const finalItems = [...dedup.values()];
  counts.candidates = finalItems.length;
  for (const it of finalItems) {
    if (it.verdict === CHAIN_VERDICT.SILENT) counts.silent++;
    else if (it.verdict === CHAIN_VERDICT.WITHIN_GAP) counts.withinGap++;
    else if (it.verdict === CHAIN_VERDICT.OTHER_RUNNING) counts.otherRunning++;
    else if (it.verdict === CHAIN_VERDICT.HANDED) counts.handed++;
    else if (it.verdict === CHAIN_VERDICT.SETTLED) counts.settled++;
    else if (it.verdict === CHAIN_VERDICT.PAUSED) counts.paused++;
    else if (it.verdict === CHAIN_VERDICT.ACTIVE) counts.active++;
    else if (it.verdict === CHAIN_VERDICT.UNDECIDABLE) counts.undecidable++;
  }
  return { counts, items: finalItems, silentKeys: finalItems.filter((i) => i.verdict === CHAIN_VERDICT.SILENT).map((i) => i.chainKey) };
}

// ---------------------------------------------------------------- 状态文件（IO）

/** 状态文件路径（`~/.dsh/butler-relay-watchdog.json`）。 */
export function watchdogStatePath(opts = {}) {
  const home = opts.home ?? process.env.BUTLER_DSH_HOME ?? process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh');
  return opts.file ?? watchdogStateFileOf(home);
}

/** 状态归一（坏字段一律归零，**绝不抛**）。 */
export function normalizeWatchdogState(state) {
  const src = state && typeof state === 'object' ? state : {};
  const chainsIn = src.chains && typeof src.chains === 'object' && !Array.isArray(src.chains) ? src.chains : {};
  const out = { schemaVersion: 1, updatedAt: num(src.updatedAt, 0) || null, chains: {} };
  for (const k of Object.keys(chainsIn)) {
    const v = chainsIn[k];
    if (!v || typeof v !== 'object') continue;
    out.chains[String(k)] = {
      mainline: String(v.mainline ?? k),
      attempts: Math.max(0, num(v.attempts, 0)),
      consecutiveFailures: Math.max(0, num(v.consecutiveFailures, 0)),
      lastAttemptAt: num(v.lastAttemptAt, 0) || null,
      // 【2026-10-08 修复 · 缺陷 ①】最后一次**真投递的动作**时刻（重投 / 报警 / 升级 / 停招都算）——
      //   30 分钟节流判据以它为准；旧状态没有该字段 ⇒ 判据回退到 `lastAttemptAt`（见 `planChainWatchdog`）。
      lastNotifiedAt: num(v.lastNotifiedAt, 0) || null,
      lastResult: v.lastResult ?? null,
      lastReason: v.lastReason ?? null,
      lastDocPath: v.lastDocPath ?? null,
      firstSeenAt: num(v.firstSeenAt, 0) || null,
      lastSeenAt: num(v.lastSeenAt, 0) || null,
      escalateNotifiedAt: num(v.escalateNotifiedAt, 0) || null,
      haltedNotifiedAt: num(v.haltedNotifiedAt, 0) || null,
      history: Array.isArray(v.history) ? v.history.filter((x) => x && typeof x === 'object').slice(-WATCHDOG_HISTORY_MAX) : [],
    };
  }
  return out;
}

/** 读状态文件（**只读、容错**；坏 JSON / schema > 1 ⇒ 空状态 + `warning`，绝不抛）。 */
export function loadWatchdogState(opts = {}) {
  const file = watchdogStatePath(opts);
  try {
    if (!fs.existsSync(file)) return { ok: true, exists: false, file, state: normalizeWatchdogState(null), warning: null };
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sv = num(j?.schemaVersion, 1);
    if (sv > 1) return { ok: true, exists: true, file, state: normalizeWatchdogState(null), warning: `schemaVersion=${sv} > 1 ⇒ 按空状态处理（绝不猜旧结构）` };
    return { ok: true, exists: true, file, state: normalizeWatchdogState(j), warning: null };
  } catch (e) {
    return { ok: false, exists: true, file, state: normalizeWatchdogState(null), warning: `读不到看门狗状态（${e?.message ?? e}）⇒ 按空状态处理` };
  }
}

/** 写状态文件（`dryRun` 零写盘；同目录 tmp + rename ⇒ 同卷原子替换）。 */
export function saveWatchdogState(state, opts = {}) {
  const file = watchdogStatePath(opts);
  if (opts.dryRun === true) return { ok: true, action: 'dry-run', file };
  if (opts.write === false) return { ok: true, action: 'disabled', file };
  try {
    const body = JSON.stringify(normalizeWatchdogState(state), null, 2) + '\n';
    const r = writeStateText(WATCHDOG_STATE_NAME, body, {
      home: opts.file ? path.dirname(file) : opts.home,
      write: (p, t) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = `${p}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, t, 'utf8');
        const gr = renameGuarded(tmp, p, { whitelist: [path.dirname(p)], reason: '写看门狗状态（原子替换）' });
        if (!gr.ok) throw new Error(`看门狗状态写入被三件套拒绝（${gr.code}）：${gr.reason}`);
      },
    });
    if (!r.ok) throw new Error(`双写失败（${r.kind ?? 'unknown'}）：${(r.failures?.[0] ?? {}).error ?? 'unknown'}`);
    return { ok: true, action: 'written', file };
  } catch (e) {
    return { ok: false, action: 'error', file, error: e?.message ?? String(e) };
  }
}

/** 清理沉寂链（已升级 + 超期 ⇒ 删，防状态文件无限增长）。 */
export function pruneWatchdogState(state, opts = {}) {
  const now = num(opts.now, Date.now());
  const keepMs = num(opts.keepMs, WATCHDOG_CHAIN_KEEP_MS);
  const next = normalizeWatchdogState(state);
  const dropped = [];
  for (const k of Object.keys(next.chains)) {
    const c = next.chains[k];
    const last = num(c.lastSeenAt, 0) || num(c.lastAttemptAt, 0) || num(c.firstSeenAt, 0);
    if (last && now - last > keepMs && c.attempts >= WATCHDOG_MAX_ATTEMPTS) { delete next.chains[k]; dropped.push(k); }
  }
  return { state: next, dropped };
}

// ---------------------------------------------------------------- 计划（纯函数）

/**
 * 计划函数（**纯函数**）：判「本轮的每条断链链做什么动作」。
 * ⚠️ 只算不投：文件解析（找档）与真动作在编排层（`queue-watch.mjs` 2f）完成。
 */
export function planChainWatchdog(input = {}) {
  const judged = input.judged ?? judgeChainSilence(input);
  const now = num(input.now, Date.now());
  const enabled = input.enabled === true;
  const mode = String(input.mode ?? 'observe');
  const dryRun = input.dryRun === true;
  const gateOpen = !dryRun && mode !== 'observe';
  const rehandoffEnabled = input.rehandoffEnabled === true;
  const throttleMs = num(input.throttleMs, WATCHDOG_THROTTLE_MS);
  const maxAttempts = num(input.maxAttempts, WATCHDOG_MAX_ATTEMPTS);
  const failStreakMax = num(input.failStreakMax, WATCHDOG_FAIL_STREAK_MAX);
  const escalateRepeatMs = num(input.escalateRepeatMs, WATCHDOG_ESCALATE_REPEAT_MS);
  const state = normalizeWatchdogState(input.state);

  const out = {
    enabled, mode, dryRun, gateOpen, rehandoffEnabled,
    due: false, fire: false, suppressed: null,
    counts: judged.counts, actions: [], alertActions: [],
    throttleMs, maxAttempts, failStreakMax,
    state, statePatch: null,
  };

  const silentItems = (judged.items ?? []).filter((i) => i.verdict === CHAIN_VERDICT.SILENT);
  out.due = silentItems.length > 0;
  if (!silentItems.length) { out.suppressed = 'no-silent-chain'; return out; }
  if (!enabled) { out.suppressed = 'disabled'; return out; }

  // 防抖：同链同轮最多 1 条动作（取静默最久的那条会话）
  const best = new Map();
  for (const it of silentItems) {
    const k = String(it.chainKey || it.mainline || it.sid);
    const prev = best.get(k);
    if (!prev || num(it.silentMs, 0) > num(prev.silentMs, 0)) best.set(k, it);
  }

  for (const [chainKey, it] of best) {
    const st = state.chains[chainKey] ?? null;
    const rec = {
      chainKey, mainline: it.mainline ?? chainKey, sid: it.sid, form: it.form, chainId: it.chainId ?? null,
      wakeAt: it.wakeAt ?? null, lastSuccessAt: it.lastSuccessAt ?? null,
      silentMs: num(it.silentMs, 0), silentMin: Math.round(num(it.silentMs, 0) / 60000),
      attempts: st ? st.attempts : 0, maxAttempts,
      consecutiveFailures: st ? st.consecutiveFailures : 0, failStreakMax,
      lastAttemptAt: st ? st.lastAttemptAt : null,
      lastNotifiedAt: st ? st.lastNotifiedAt : null,
      kind: null, alert: false, reason: null, needDoc: false, throttleRemainMs: null,
    };
    // 【2026-10-08 修复 · 缺陷 ①】节流判据**覆盖所有动作**、且是**第一道分支**（在 attempts / failStreak 之前）：
    //   · 用 `lastNotifiedAt`（任何一次真投递的动作——重投 / 报警 / 升级 / 停招——都推进它）；
    //     旧状态只有 `lastAttemptAt` ⇒ 取二者较大值兼容（不改 `attempts` 语义）。
    //   · ⚠️ 原实现把节流放在 `attempts` / `failStreak` 之后、且**只认 `lastAttemptAt`**，
    //     而 `lastAttemptAt` 只在 `kind === REHANDOFF` 时被 `applyWatchdogOutcome` 写
    //     ⇒「只报警」形态（`rehandoff` 关 / 档位门禁关）下判据 `Number.isFinite(null)` 恒 false
    //     ⇒ **节流完全失效**，每轮 tick 都出一条 alert。实测：2026-09-29 11:25:14→11:31:30
    //     6 条 alert，相邻间隔恒 ≈75 秒（= tick 周期），而 `escalateNotifiedAt` 恒为 null。
    //   · 目标（卡面验收判据 ①）：**同一条链在 30 分钟窗口内最多出一次动作**；
    //     窗口取值仍由 `throttleMs`（缺省 `WATCHDOG_THROTTLE_MS`）控制，可注入以便单测。
    const lastAct = Math.max(num(st?.lastNotifiedAt, 0) || 0, num(st?.lastAttemptAt, 0) || 0);
    if (lastAct > 0 && now - lastAct < throttleMs) {
      rec.kind = CHAIN_ACTION.THROTTLED;
      rec.reason = `节流内：本轮不出动作（同链 ${Math.round(throttleMs / 60000)} 分钟内最多 1 次，还剩 ${Math.ceil((throttleMs - (now - lastAct)) / 60000)} 分钟）`;
      rec.throttleRemainMs = throttleMs - (now - lastAct);
      out.actions.push(rec);
      continue;
    }
    if (rec.attempts >= maxAttempts) {
      rec.kind = CHAIN_ACTION.ESCALATE; rec.alert = true; rec.reason = 'attempts-exhausted';
      const last = st?.escalateNotifiedAt ?? null;
      if (Number.isFinite(Number(last)) && now - Number(last) < escalateRepeatMs) {
        rec.alert = false; rec.reason = 'attempts-exhausted（已升级过，6 小时内不重复）';
      }
    } else if (rec.consecutiveFailures >= failStreakMax) {
      rec.kind = CHAIN_ACTION.HALTED; rec.alert = true; rec.reason = 'fail-streak-halted';
      const last = st?.haltedNotifiedAt ?? null;
      if (Number.isFinite(Number(last)) && now - Number(last) < escalateRepeatMs) {
        rec.alert = false; rec.reason = 'fail-streak-halted（已报警过，6 小时内不重复）';
      }
    } else if (!gateOpen) {
      rec.kind = CHAIN_ACTION.ALERT; rec.alert = true; rec.reason = dryRun ? 'dry-run' : 'mode-observe';
    } else if (!rehandoffEnabled) {
      rec.kind = CHAIN_ACTION.ALERT; rec.alert = true; rec.reason = 'rehandoff-disabled（只报警：自动重投未放行）';
    } else {
      rec.kind = CHAIN_ACTION.REHANDOFF; rec.alert = true; rec.reason = 'silent-chain'; rec.needDoc = true;
    }
    out.actions.push(rec);
  }
  out.alertActions = out.actions.filter((a) => a.alert === true);
  out.fire = out.alertActions.length > 0 || out.actions.some((a) => a.kind === CHAIN_ACTION.REHANDOFF);
  return out;
}

/**
 * 动作结果合并进状态（纯函数；编排层在动作**执行后**调用，再 `saveWatchdogState`）。
 * @param {object} outcomes `[{chainKey, mainline, sid, kind, result:'ok'|'failed'|'skipped', reason, docPath, maxAttempts}]`
 */
export function applyWatchdogOutcome(state, outcomes, opts = {}) {
  const now = num(opts.now, Date.now());
  const next = normalizeWatchdogState(state);
  next.updatedAt = now;
  const hist = (cur, row) => [...cur.history, row].slice(-WATCHDOG_HISTORY_MAX);
  for (const o of (Array.isArray(outcomes) ? outcomes : [])) {
    if (!o || !o.chainKey) continue;
    const cur = next.chains[o.chainKey] ?? {
      mainline: String(o.mainline ?? o.chainKey), attempts: 0, consecutiveFailures: 0,
      lastAttemptAt: null, lastNotifiedAt: null, lastResult: null, lastReason: null, lastDocPath: null,
      firstSeenAt: now, lastSeenAt: now, escalateNotifiedAt: null, haltedNotifiedAt: null, history: [],
    };
    cur.lastSeenAt = now;
    if (!cur.firstSeenAt) cur.firstSeenAt = now;
    if (o.kind === CHAIN_ACTION.REHANDOFF) {
      cur.attempts += 1;
      cur.lastAttemptAt = now;
      cur.lastNotifiedAt = now;          // 【修复 ①】重投也是一次「出了动作」
      cur.lastResult = o.result === 'ok' ? 'ok' : 'failed';
      cur.lastReason = o.reason ?? null;
      cur.lastDocPath = o.docPath ?? null;
      cur.consecutiveFailures = o.result === 'ok' ? 0 : cur.consecutiveFailures + 1;
      cur.history = hist(cur, { at: now, kind: 'rehandoff', result: cur.lastResult, reason: cur.lastReason, sid: o.sid ?? null, docPath: cur.lastDocPath });
    } else if (o.alert === true) {
      // 【2026-10-08 修复 · 缺陷 ①】只有**真投递出去**的动作才推进节流窗口、才记「已报过」时刻。
      //   ⚠️ 原条件是 `o.alert === true || kind === ESCALATE || kind === HALTED` ⇒ 静默轮
      //   （6 小时内已升级过、`alert:false` 的 ESCALATE/HALTED）也会把 `escalateNotifiedAt` /
      //   `haltedNotifiedAt` 刷成 now ⇒ **升级/停招报警被自己按死、永不重报**；修 ① 之后
      //   这类静默轮还会不停推进 `lastNotifiedAt` ⇒ 把后续轮次的动作一起节流掉。
      //   现在静默轮除 `lastSeenAt`（prune 用）外**不写任何字段、不推 history**（= 不消费节流配额）。
      cur.lastNotifiedAt = now;
      if (o.kind === CHAIN_ACTION.ESCALATE) cur.escalateNotifiedAt = now;
      if (o.kind === CHAIN_ACTION.HALTED) cur.haltedNotifiedAt = now;
      cur.history = hist(cur, { at: now, kind: o.kind ?? 'alert', reason: o.reason ?? null, sid: o.sid ?? null });
    }
    next.chains[o.chainKey] = cur;
  }
  return next;
}

// ---------------------------------------------------------------- 交接档定位（纯函数 + 一处只读 IO）

/**
 * 纯函数：从目录清单里挑「这份断链该重跑的那份交接档」。
 * 规则：文件名形如 `交接-<主线>-<YYYYMMDD>.md`；主线名**先精确、后包含**匹配；
 *      `mtime` 必须落在 `[at - 24h, at + 5min]`；命中多份取 `mtime` 最接近 `at` 的。
 * 取不到 ⇒ `null`（编排层据此**降级为只报警**，绝不瞎猜一份档去建会话）。
 */
export function pickHandoffDocPath(files, opts = {}) {
  const mainline = normalizeMainline(opts.mainline);
  const at = num(opts.at, NaN);
  const lookbackMs = num(opts.lookbackMs, HANDOFF_DOC_LOOKBACK_MS);
  const lookaheadMs = num(opts.lookaheadMs, HANDOFF_DOC_LOOKAHEAD_MS);
  if (!mainline) return null;
  const rows = (Array.isArray(files) ? files : [])
    .map((f) => {
      const name = String(f?.name ?? '');
      const m = name.match(/^交接-(.+)\.md$/);
      if (!m) return null;
      // 去掉尾部日期段 / 棒号段（`-20260929` / `-20260929-3` / `-第3棒`）
      const stem = normalizeMainline(m[1].replace(/(-\d{8}(-\d+)?)+$/, '').replace(/-第\d+棒$/, ''));
      const mtimeMs = num(f?.mtimeMs, NaN);
      if (!stem || !Number.isFinite(mtimeMs)) return null;
      const exact = stem === mainline;
      const loose = stem.includes(mainline) || mainline.includes(stem);
      return { name, path: f?.path ?? null, mtimeMs, exact, loose };
    })
    .filter(Boolean);
  const inWindow = (r) => (!Number.isFinite(at) ? true : (r.mtimeMs >= at - lookbackMs && r.mtimeMs <= at + lookaheadMs));
  const pool = rows.filter((r) => r.exact && inWindow(r));
  const fallback = pool.length ? pool : rows.filter((r) => r.loose && inWindow(r));
  if (!fallback.length) return null;
  const pick = fallback.slice().sort((a, b) => (Number.isFinite(at) ? Math.abs(a.mtimeMs - at) - Math.abs(b.mtimeMs - at) : b.mtimeMs - a.mtimeMs))[0];
  return { path: pick.path, name: pick.name, mtimeMs: pick.mtimeMs };
}

/** 列交接档目录（只读；目录不存在 ⇒ 空数组，绝不抛）。`opts.docsDir` 为准，`opts.dir` 是别名。 */
export function listHandoffDocs(opts = {}) {
  const docsDir = opts.docsDir ?? opts.dir ?? path.join('<butler-root>', 'docs');
  try {
    const names = fs.readdirSync(docsDir);
    const out = [];
    for (const name of names) {
      if (!/^交接-.*\.md$/.test(name)) continue;
      const p = path.join(docsDir, name);
      try { out.push({ name, path: p, mtimeMs: fs.statSync(p).mtimeMs }); } catch { /* 读不到就跳过 */ }
    }
    return { ok: true, dir: docsDir, files: out };
  } catch (e) {
    return { ok: false, dir: docsDir, files: [], error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------- 文案与只读档

/** 告警文案（自带可照抄的下一步命令）。`actions` = 带 `alert === true` 的动作列表。 */
export function renderWatchdogText(actions, opts = {}) {
  const list = (Array.isArray(actions) ? actions : []).filter((a) => a && a.alert !== false);
  if (!list.length) return '';
  const one = list.length === 1 ? list[0] : null;
  const head = one
    ? (one.kind === CHAIN_ACTION.REHANDOFF
      ? (one.result === 'failed'
        ? `⚠️ 接力链断了：主线「${one.mainline}」静默 ${one.silentMin} 分钟 ⇒ 自动重投**失败**（第 ${one.attempts + 1}/${one.maxAttempts} 次，${one.reason ?? 'unknown'}）`
        : `⚠️ 接力链断了：主线「${one.mainline}」静默 ${one.silentMin} 分钟 ⇒ 已自动重投第 ${one.attempts + 1}/${one.maxAttempts} 次`)
      : one.kind === CHAIN_ACTION.ESCALATE
        ? `⏫ 接力链断了且**自动重投已用满 ${one.maxAttempts} 次**：主线「${one.mainline}」⇒ **需要人来接手**`
        : one.kind === CHAIN_ACTION.HALTED
          ? `⏫ 接力链断了且自动重投**连续失败 ${one.consecutiveFailures} 次**（已停招）：主线「${one.mainline}」`
          : `⚠️ 接力链断了（只报警）：主线「${one.mainline}」静默 ${one.silentMin} 分钟`)
    : `⚠️ 接力链断了 **${list.length}** 条：${list.map((a) => `「${a.mainline}」${a.silentMin}min`).join(' / ')}`;
  const tail = one
    ? ` 源会话 \`${String(one.sid).slice(0, 30)}…\`（${one.form === CHAIN_FORM.TAIL ? '接力后没续棒' : '标了【已交接】却没交棒'}）`
      + ` ⇒ 正确动作：\`node <butler-root>\\tools\\session-mark.mjs --handed --relay "<交接档绝对路径>"\`。`
      + `${one.attempts >= one.maxAttempts ? '（自动重投已停，请人工接棒或终止这条链）' : ''}`
    : '';
  return `${head}。${tail}`;
}

/** 只读观察档路径（`docs/`）。 */
export function watchdogDocPath(now = Date.now(), opts = {}) {
  const docsRoot = opts.docsRoot ?? path.join('<butler-root>', 'docs', 'reports');
  return path.join(docsRoot, `${WATCHDOG_DOC_PREFIX}${opts.dateKey ?? dayKeyOf(now)}.md`);
}

/** 渲染只读观察档（纯函数）。 */
export function renderWatchdogDoc(payload = {}, opts = {}) {
  const judged = payload.judged ?? { counts: {}, items: [] };
  const planned = payload.planned ?? null;
  const c = judged.counts ?? {};
  const hh = (t) => { const d = new Date(num(t, Date.now())); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
  const L = [];
  L.push(`# 断链看门狗（只读观察档）· ${opts.dateKey ?? dayKeyOf(payload.now ?? Date.now())}`);
  L.push('');
  L.push('> 由 `butler-queue-tick.mjs` 刷新（**默认关**：`relayWatchdog.enabled !== true` ⇒ 连判定都不跑）。');
  L.push('> 口径真源：`docs/` §0/§1；本档只记判定，**本身不投递**。');
  L.push('');
  L.push(`- 刷新时刻：${hh(payload.now)} · 档位 **${payload.mode ?? '-'}** · 总开关 ${planned ? (planned.enabled ? '开' : '**关**') : '-'} · 重投开关 ${planned ? (planned.rehandoffEnabled ? '开' : '关') : '-'} · 投递门禁 ${planned ? (planned.gateOpen ? '开' : '关') : '-'}`);
  L.push(`- 主线数 ${c.chains ?? 0} · 候选 ${c.candidates ?? 0} · **断链 ${c.silent ?? 0}** · 未到 30min ${c.withinGap ?? 0} · 已在跑 ${c.otherRunning ?? 0} · 已续棒 ${c.handed ?? 0} · 已收工 ${c.settled ?? 0} · 有意停【待续】 ${c.paused ?? 0} · 链尾仍活跃 ${c.active ?? 0} · 无法判定 ${c.undecidable ?? 0}`);
  if (planned && planned.due) {
    L.push(`- 本轮动作：${planned.actions.map((a) => `「${a.mainline}」=${a.kind}${a.alert ? '(报警)' : ''}`).join(' · ') || '（无）'}` + `${planned.suppressed ? `（未动作：${planned.suppressed}）` : ''}`);
  }
  L.push('');
  L.push('## 逐条判定（最多 50 条）');
  L.push('');
  L.push('| 主线 | 会话（截断） | 形态 | 静默 | running | 判定 | 依据 |');
  L.push('|---|---|---|---|---|---|---|');
  const items = (judged.items ?? []).slice(0, 50);
  if (!items.length) L.push('| — | — | — | — | — | （无候选） | — |');
  for (const it of items) {
    L.push(`| ${String(it.mainline || '-').slice(0, 24)} | \`${String(it.sid).slice(0, 26)}\` | ${it.form} | ${it.silentMs === null ? '-' : `${Math.round(it.silentMs / 60000)}min`} | ${it.running === null ? '-' : it.running} | **${it.verdict}** | ${String(it.reason ?? '').replace(/\|/g, '/')} |`);
  }
  L.push('');
  L.push('> 判定标签：silent-chain 断链（唯一会动作的）· within-gap 未到 30 分钟 · other-running 同主线另有会话在跑 · handed 已续棒 · settled 标题【完成】· paused 标题【待续】（有意停手）· **active-tail 链尾仍活跃**（在跑 turn / 最近还有活动 ⇒ 不判断链）· undecidable 判不出（静默）。');
  L.push('');
  return L.join('\n') + '\n';
}
