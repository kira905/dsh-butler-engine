// dsh-butler / lib/attentions.mjs —— 「Attention（待人工决定）」的**唯一口径**
//
// 为什么有这一层（卡 C10 · 2026-11-02）：
//   以前 `standup.mjs` 用 `/待拍板/.test(卡面 description)` 判「有没有事在等人」，
//   于是**卡面里顺手写三个字就把收敛线虚增**（C6 那张卡自己踩过一次，the operator亲手清过）。
//   真源口径（`docs/` §3 第 1 条）：
//   「等人工决定」必须是**结构化字段**，不是自由文本。
//
// 本模块 = 三件事的单一实现，standup.mjs（读）与 steward.mjs（写）都从这里取：
//   ① 读侧规范化 `normalizeAttentions()` —— 老 state 没这个字段 / 字段不是数组 / 文件不存在 ⇒ 空数组，**不抛**
//   ② 写侧纯函数 `addAttention()` / `answerAttention()` —— 幂等（同 cardId 不产生重复条目）
//   ③ 关联账本 `pendingFromAttentions()` —— 只把**未答**条目算成「要主人拍的」，卡面文本一律不参与
//
// 条目形状（卡面原文，一个字都不多）：
//   { cardId, question, options: [], askedAt, answeredAt: null|ISO }
//
// ⚠️ 不改看板 schema、不扫卡面、不追补存量卡（卡 C10 三条红线）。
import fs from 'node:fs';

/** state 里承载它的字段名（`steward-state.json` 顶层）。 */
export const ATTENTIONS_FIELD = 'attentions';
/** 状态文件名（与 steward.mjs 的 STEWARD_STATE_FILE 同值；这里独立定义避免循环 import）。 */
export const ATTENTION_STATE_FILE = 'steward-state.json';

const isIsoLike = (v) => typeof v === 'string' && v.length >= 10;

/**
 * 读侧规范化：**永不抛**。
 * @param {any} state 解析后的 state 对象（可以是 null / 老 state / 形状不对的对象）
 * @returns {Array<{cardId:string, question:string, options:string[], askedAt:string|null, answeredAt:string|null}>}
 */
export function normalizeAttentions(state) {
  const raw = state && typeof state === 'object' && !Array.isArray(state) ? state[ATTENTIONS_FIELD] : null;
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const cardId = String(x.cardId ?? '').trim();
    if (!cardId) continue;                       // 没卡 id 的条目 = 无法销账，丢弃（写入口本来就不会产生）
    if (seen.has(cardId)) continue;              // 防御性去重：读侧也不许把 N 算虚
    seen.add(cardId);
    out.push({
      cardId,
      question: String(x.question ?? ''),
      options: Array.isArray(x.options) ? x.options.map((v) => String(v)).filter((v) => v !== '') : [],
      askedAt: isIsoLike(x.askedAt) ? String(x.askedAt) : null,
      answeredAt: x.answeredAt ? String(x.answeredAt) : null,
    });
  }
  return out;
}

/** 未答 = `answeredAt` 为空（null / undefined / 空串）。 */
export const isUnattended = (a) => !a || !a.answeredAt;

/** 只取「还在等人答」的条目（已按 cardId 去重）。 */
export function unattendedAttentions(state) {
  return normalizeAttentions(state).filter(isUnattended);
}

/** 把条目列表塞回 state（保留其余字段原样；state 坏形状 ⇒ 从新对象起）。 */
function withAttentions(prev, list) {
  const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  return { ...base, [ATTENTIONS_FIELD]: list };
}

/**
 * 登记一条（纯函数，**幂等**）。
 * 同 cardId 重复登记：不新增条目 / **askedAt 保留原值** / question 与 options 按本次更新 /
 * 若原来已答 ⇒ `answeredAt` 归 null（重新开问，返回 `reopened:true`）。
 * @returns {{ok:boolean, action?:'added'|'updated', reopened?:boolean, entry?:object, state?:object, error?:string}}
 */
export function addAttention(prev, { cardId, question, options = [], now = Date.now() } = {}) {
  const id = String(cardId ?? '').trim();
  if (!id) return { ok: false, error: '缺卡 id（--card）' };
  const q = String(question ?? '').trim();
  if (!q) return { ok: false, error: '缺一句话问题（--question）—— 空问题登记不了 Attention' };
  const opts = (Array.isArray(options) ? options : [options]).map((v) => String(v ?? '').trim()).filter(Boolean);
  const at = new Date(now).toISOString();
  const list = normalizeAttentions(prev);
  const i = list.findIndex((x) => x.cardId === id);
  if (i >= 0) {
    const prevEntry = list[i];
    const reopened = Boolean(prevEntry.answeredAt);
    list[i] = {
      ...prevEntry,
      question: q,
      options: opts.length ? opts : prevEntry.options,
      answeredAt: null,
    };
    return { ok: true, action: 'updated', reopened, entry: list[i], state: withAttentions(prev, list) };
  }
  const entry = { cardId: id, question: q, options: opts, askedAt: at, answeredAt: null };
  list.push(entry);
  return { ok: true, action: 'added', reopened: false, entry, state: withAttentions(prev, list) };
}

/**
 * 销账（纯函数，**幂等**）：写 `answeredAt`。
 * 同一张卡重复销账 ⇒ `action:'already'`，**时间不变**（不刷成新时间）。
 * 没有这条 Attention ⇒ 拒绝（`ok:false`）—— 不凭空销账，也不顺手创建。
 * @returns {{ok:boolean, action?:'answered'|'already', entry?:object, state?:object, error?:string}}
 */
export function answerAttention(prev, { cardId, now = Date.now() } = {}) {
  const id = String(cardId ?? '').trim();
  if (!id) return { ok: false, error: '缺卡 id（--card）' };
  const list = normalizeAttentions(prev);
  const i = list.findIndex((x) => x.cardId === id);
  if (i < 0) return { ok: false, error: `attentions 里没有这张卡（${id}）—— 不凭空销账` };
  const entry = list[i];
  if (entry.answeredAt) return { ok: true, action: 'already', entry, state: withAttentions(prev, list) };
  list[i] = { ...entry, answeredAt: new Date(now).toISOString() };
  return { ok: true, action: 'answered', entry: list[i], state: withAttentions(prev, list) };
}

/**
 * 容错读 state 文件（**只读**，不抛）。
 * @returns {{ok:boolean, exists:boolean, state:object|null, path:string, reason?:string, error?:string}}
 */
export function readAttentionState(statePath) {
  const p = String(statePath ?? '');
  if (!p) return { ok: false, exists: false, state: null, path: p, error: '没给 state 路径' };
  if (!fs.existsSync(p)) {
    return { ok: true, exists: false, state: null, path: p, reason: 'state 文件不存在（按空数组）' };
  }
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); }
  catch (e) { return { ok: false, exists: true, state: null, path: p, error: `state 读不到：${e && e.message ? e.message : e}` }; }
  let j;
  try { j = JSON.parse(txt); }
  catch (e) { return { ok: false, exists: true, state: null, path: p, error: `state 不是合法 JSON：${e && e.message ? e.message : e}` }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { ok: false, exists: true, state: null, path: p, error: 'state 顶层不是对象（拒绝按空账覆盖）' };
  }
  const reason = Array.isArray(j[ATTENTIONS_FIELD]) ? null : `老 state 没有 ${ATTENTIONS_FIELD}[]（按空数组）`;
  return { ok: true, exists: true, state: j, path: p, reason };
}

/** 派生式「这条 Attention 属于哪条线/什么状态」——**卡不在账本时也给出可读兜底**。 */
function describe(card, a) {
  const line = card ? (card.line || card.mainline || card.mainLine || '(无主线)') : '(无主线)';
  const status = card ? String(card.status ?? 'unknown') : 'unknown';
  const title = card ? String(card.title ?? '') : '';
  return {
    id: a.cardId,
    title: title || (a.question || '(无标题)'),
    line,
    status,
    question: a.question,
    askedAt: a.askedAt,
    options: Array.isArray(a.options) ? a.options : [],
    cardInLedger: Boolean(card),
  };
}

/**
 * 从 state 的未答条目算「今天要您拍的」。
 * **卡面文本一律不参与**（这就是卡 C10 的灵魂）；账本只用来补 title / line / status / ageDays。
 * 排序：① failed ② review ③ running ④ 其它；同权重按 askedAt 升序（等得久的先上桌）；最后 id 字典序（可重放）。
 * @param {{state:any, cardsById?:Map<string,object>, ageDaysOf?:(card:object|null)=>number|null, topN?:number}} arg
 * @returns {{total:number, items:Array<object>, all:Array<object>}}
 */
export function pendingFromAttentions({ state, cardsById = new Map(), ageDaysOf = () => null, topN = 3 } = {}) {
  const map = cardsById instanceof Map ? cardsById : new Map();
  const all = unattendedAttentions(state).map((a) => {
    const card = map.get(a.cardId) || null;
    return { ...describe(card, a), ageDays: card ? (ageDaysOf(card) ?? null) : null };
  });
  const weight = (t) => (t.status === 'failed' ? 3 : t.status === 'review' ? 2 : t.status === 'running' ? 1 : 0);
  all.sort((x, y) => (weight(y) - weight(x))
    || String(x.askedAt ?? '').localeCompare(String(y.askedAt ?? ''))
    || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
  const n = Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : 3;
  return { total: all.length, items: all.slice(0, n), all };
}
