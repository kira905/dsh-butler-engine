// dsh-butler / lib/disposition.mjs —— 「每条东西的去向」的**唯一口径**（卡 C12-D · 2026-11-02）
//
// 为什么有这一层（真源 `docs/` §A-3 / §A-4）：
//   原型把「一条事件现在到哪了」记成**一张表、每 trigger 一行**（007 :457），它同时回答三件事：
//   ① 这条为什么没被处理（filtered 的原因码）② 这条到了哪些卡 ③ 这条事件的一生。
//   我们的 `instructions[]` 只回答"投给谁、accepted"，回答不了「这条为什么没处理」。
//
// 本模块 = 四件事的单一实现（`steward.mjs` 甲层收尾只调它，自己不算一遍）：
//   ① 行形状 `buildRow()` / `validateRow()` —— `{at, kind, cardId?, reason, detail?, runId}`，六个 kind 封闭词表
//   ② 从甲层这一屏算出所有去向 `buildDispositions()` —— **每条候选 / 每条被挡下的各一行**
//   ③ **只增不改**地追写 `appendRows()` —— 单次 appendFileSync，**没有任何清空 / 截断 / 覆盖入口**
//   ④ 读侧 `readRows()` / `summarizeRows()` —— 只读，坏行跳过并计数（**永不抛**）
//
// 六值（kind）与本件的分工 —— 这是 §A-3 的"先只做带副作用的两个"：
//   evaluated  进上桌线（Top N）        —— 记录
//   ignored    过了筛但上桌线已满       —— 记录（"排不上"也是去向）
//   filtered   被规则挡下（本线自举 / 生命周期失效）—— 记录 + 原因码
//   blocked    执行会话报 blocked       —— **副作用**：自动登记 attentions[]
//   failed     看板卡状态 = failed      —— **副作用**：自动登记 attentions[]
//   fanned-out C12-B 扇出（本件不产生） —— 记录（留给扇出段，本卡只把词表留好）
//
// ⚠️ 红线（卡 C12-D）：不碰看板 schema / 不碰 host-runner / 不改 attentions[] 字段语义 /
//   行流**只增不改**（本文件里没有 unlink、没有 writeFileSync、没有 truncate，夹具按源码验一条）。
import fs from 'node:fs';
import path from 'node:path';

/** `~/.dsh` 下的行流文件名（与 steward.mjs 的 DISPOSITION_STATE_FILE 同值；这里独立定义避免循环 import）。 */
export const DISPOSITION_FILE = 'steward-disposition.jsonl';

/** 六个 kind（**封闭词表**：拼错的 kind 一律拒收，否则统计会被野值污染）。 */
export const DISPOSITION_KINDS = Object.freeze(['evaluated', 'filtered', 'ignored', 'fanned-out', 'blocked', 'failed']);

/** 唯二**带副作用**的 kind（其余四个只是记录）—— §A-3「先只做有副作用的两个」。 */
export const SIDE_EFFECT_KINDS = Object.freeze(['blocked', 'failed']);

export const isDispositionKind = (k) => DISPOSITION_KINDS.includes(String(k ?? ''));

export const isSideEffectKind = (k) => SIDE_EFFECT_KINDS.includes(String(k ?? ''));

/**
 * 原因码表（**机器读字段**，`detail` 才是给人看的那半）。
 * 新增码 = 改这张表 + 加一条夹具，否则 `summarizeRows().unknownReasons` 会把野码点出来。
 */
export const REASON_CODES = Object.freeze({
  'raised-top': '进了上桌线（Top N），乙层会给建议',
  'over-top-n': '过了筛但上桌线已满 ⇒ 这一轮排不上（不是没值）',
  'self-line': '本线（协调线）自举排除：自己的卡不占主人注意力',
  'dead-status': '生命周期已失效（done / archived / running）⇒ 待拍板自动作废',
  'card-status-failed': '看板卡状态 = failed（六值里带副作用的两个之一）',
  'executor-report-blocked': '执行会话报 blocked（`--disposition-add` 登记）',
  'thread-fanout': 'C12-B 扇出（本件不产生，留给扇出段）',
});
const KNOWN_REASONS = new Set(Object.keys(REASON_CODES));

const REASON_CODE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DETAIL_MAX = 240;

const clip = (v, max = DETAIL_MAX) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * 造一行（纯函数）。**不合法就返回 `{ok:false}`** —— 调用方决定是丢还是抛。
 * @param {{kind:string, cardId?:string, reason:string, detail?:string, runId:string, now?:number}} arg
 * @returns {{ok:boolean, row?:object, error?:string}}
 */
export function buildRow({ kind, cardId = '', reason, detail = '', runId, now = Date.now() } = {}) {
  const k = String(kind ?? '').trim();
  if (!isDispositionKind(k)) return { ok: false, error: `kind 不在六值词表里：${JSON.stringify(kind)}（允许：${DISPOSITION_KINDS.join(' / ')}）` };
  const r = String(reason ?? '').trim();
  if (!REASON_CODE_RE.test(r)) return { ok: false, error: `reason 不是合法原因码：${JSON.stringify(reason)}（小写 + 连字符）` };
  const run = String(runId ?? '').trim();
  if (!run) return { ok: false, error: '缺 runId（没有它就没法把一次跑的几行归到一起）' };
  const id = String(cardId ?? '').trim();
  const row = {
    at: new Date(now).toISOString(),
    kind: k,
    ...(id ? { cardId: id } : {}),
    reason: r,
    ...(clip(detail) ? { detail: clip(detail) } : {}),
    runId: run,
  };
  return { ok: true, row };
}

/**
 * 行校验（读侧 / 写侧共用）。**永不抛**。
 * @returns {{ok:boolean, error?:string}}
 */
export function validateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, error: '行不是对象' };
  if (!isDispositionKind(row.kind)) return { ok: false, error: `kind 不在六值词表里：${JSON.stringify(row.kind)}` };
  if (!REASON_CODE_RE.test(String(row.reason ?? ''))) return { ok: false, error: `reason 不是合法原因码：${JSON.stringify(row.reason)}` };
  if (!String(row.runId ?? '').trim()) return { ok: false, error: '缺 runId' };
  if (!String(row.at ?? '').trim()) return { ok: false, error: '缺 at' };
  if (row.cardId !== undefined && typeof row.cardId !== 'string') return { ok: false, error: 'cardId 不是字符串' };
  if (row.detail !== undefined && typeof row.detail !== 'string') return { ok: false, error: 'detail 不是字符串' };
  return { ok: true };
}

/** 原因码是否在表里（未知码只提示、不拒收 —— 行流是流水，不许因为码新了就丢一行）。 */
export const isKnownReason = (code) => KNOWN_REASONS.has(String(code ?? ''));

/**
 * 从甲层这一屏（`computeReport()` 的返回值）算出**这一轮的全部去向**。
 * 纯函数、零 IO ⇒ 夹具直接喂 report。
 *
 * 覆盖判据（夹具按它验"每条都有去向"）：`pendingTop` 里每张卡，其 id **至少**出现在一行里。
 * 一张 failed 卡会有**两行**（评估去向 + 副作用去向），这是有意的：两件事都得能追问。
 *
 * @param {object} report computeReport 的返回值
 * @param {{runId:string, now?:number}} arg
 * @returns {Array<object>} 合法行（不合法的直接丢，且不抛）
 */
export function buildDispositions(report, { runId, now = Date.now() } = {}) {
  const out = [];
  const push = (args) => {
    const r = buildRow({ ...args, runId, now });
    if (r.ok) out.push(r.row);      // 不合法 = 静默丢（行流不许因为一条野值整轮不落）
  };
  const rep = report && typeof report === 'object' ? report : {};
  const raised = Array.isArray(rep.raised) ? rep.raised : [];
  const allPending = Array.isArray(rep.allPending) ? rep.allPending : [];
  const selfCards = Array.isArray(rep.excluded?.selfCardsDetail) ? rep.excluded.selfCardsDetail : [];
  const deadCards = Array.isArray(rep.excluded?.deadDetail) ? rep.excluded.deadDetail : [];
  // 🔴 口径（2026-11-02 起 · 真源 `docs/` §2）：
  //    `failedLedger` 已是**在板口径** —— 甲层算它的时候就把「已归档」与「本线（协调线自己）」
  //    两类都摘掉了（各记一个数：`failedArchivedExcluded` / `failedSelfExcluded`，不进数组）。
  //    ⇒ 这里读 `failedLedger` = 读到"真要人管的失败卡"，与晨报 / 乙层 / 车况同一个数；
  //    `rep.failed` 是候选口径（只含 standup.pendingTop 里的 failed 卡），仅作老 state 的回落用。
  const failedCards = Array.isArray(rep.failedLedger) ? rep.failedLedger
    : (Array.isArray(rep.failed) ? rep.failed : []);
  const topN = Number.isFinite(rep.convergence?.raised) ? rep.convergence.raised : raised.length;
  const raisedIds = new Set(raised.map((x) => String(x?.id ?? '')));

  // ① 上桌线：kind=evaluated（"这条被评估过，会出建议"）
  raised.forEach((item, i) => {
    push({
      kind: 'evaluated', cardId: item?.id, reason: 'raised-top',
      detail: `rank=${i + 1}/${topN} · status=${item?.status ?? 'unknown'} · ageDays=${item?.ageDays ?? '?'} · line=${item?.line ?? '(无主线)'}`,
    });
  });

  // ② 过了筛但排不上：kind=ignored（"不是没值，是这一轮排不上"）
  allPending.forEach((item, i) => {
    const id = String(item?.id ?? '');
    if (raisedIds.has(id)) return;
    push({
      kind: 'ignored', cardId: id, reason: 'over-top-n',
      detail: `rank=${i + 1} > Top ${topN} · status=${item?.status ?? 'unknown'} · ageDays=${item?.ageDays ?? '?'} · line=${item?.line ?? '(无主线)'}`,
    });
  });

  // ③ 被规则挡下的：kind=filtered（两种原因码分开记）
  for (const item of selfCards) {
    push({ kind: 'filtered', cardId: item?.id, reason: 'self-line', detail: `line=${item?.line ?? '(无主线)'}` });
  }
  for (const item of deadCards) {
    push({ kind: 'filtered', cardId: item?.id, reason: 'dead-status', detail: `status=${item?.status ?? 'unknown'}` });
  }

  // ④ 带副作用的那个：kind=failed（另外一半 blocked 由 `--disposition-add` 产生）
  for (const item of failedCards) {
    push({
      kind: 'failed', cardId: item?.id, reason: 'card-status-failed',
      detail: `title=${item?.title ?? '(无标题)'} · line=${item?.line ?? '(无主线)'} · ageDays=${item?.ageDays ?? '?'}`,
    });
  }
  return out;
}

/** 从 report 里抽 `cardId → title`（副作用那半要用标题写问题；抽不到就用卡 id）。 */
export function titlesOf(report) {
  const m = new Map();
  const rep = report && typeof report === 'object' ? report : {};
  const buckets = [rep.raised, rep.allPending, rep.failedLedger, rep.failed,
    rep.excluded?.selfCardsDetail, rep.excluded?.deadDetail];
  for (const b of buckets) {
    if (!Array.isArray(b)) continue;
    for (const it of b) {
      const id = String(it?.id ?? '').trim();
      if (!id || m.has(id)) continue;
      m.set(id, String(it?.title ?? ''));
    }
  }
  return m;
}

/**
 * **只增不改**地追写（单次 `appendFileSync`，不读旧内容 ⇒ 结构上不可能截断既有行）。
 * 🔴 本函数是行流的**唯一写口**；本文件里刻意没有 unlink / writeFileSync / truncate。
 * @returns {{ok:boolean, appended:number, bytes:number, path:string, error?:string}}
 */
export function appendRows(file, rows = []) {
  const p = String(file ?? '');
  if (!p) return { ok: false, appended: 0, bytes: 0, path: p, error: '没给行流路径' };
  const valid = [];
  let rejected = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (validateRow(row).ok) valid.push(row); else rejected++;
  }
  if (!valid.length) return { ok: true, appended: 0, bytes: 0, path: p, rejected };
  const text = valid.map((r) => JSON.stringify(r)).join('\n') + '\n';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, text, 'utf8');
  } catch (e) {
    return { ok: false, appended: 0, bytes: 0, path: p, rejected, error: `追写失败：${e && e.message ? e.message : e}` };
  }
  return { ok: true, appended: valid.length, bytes: Buffer.byteLength(text, 'utf8'), path: p, rejected };
}

/**
 * 读行流（**只读**，永不抛）：坏行跳过并计数（不许因为一行坏就整本读不出）。
 * @param {string} file
 * @param {{tail?:number}} [opts] tail>0 ⇒ 只回最后 N 条合法行（`total` 仍是全量合法行数）
 * @returns {{ok:boolean, path:string, exists:boolean, total:number, bad:number, rows:object[], error?:string}}
 */
export function readRows(file, { tail = 0 } = {}) {
  const p = String(file ?? '');
  if (!p) return { ok: false, path: p, exists: false, total: 0, bad: 0, rows: [], error: '没给行流路径' };
  if (!fs.existsSync(p)) return { ok: true, path: p, exists: false, total: 0, bad: 0, rows: [] };
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); }
  catch (e) { return { ok: false, path: p, exists: true, total: 0, bad: 0, rows: [], error: `读不到：${e && e.message ? e.message : e}` }; }
  const all = [];
  let bad = 0;
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let j;
    try { j = JSON.parse(s); } catch { bad++; continue; }
    if (!validateRow(j).ok) { bad++; continue; }
    all.push(j);
  }
  const n = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 0;
  return { ok: true, path: p, exists: true, total: all.length, bad, rows: n ? all.slice(-n) : all };
}

/** 汇总（kind / reason 两个维度的分布 + 未知原因码点名）。 */
export function summarizeRows(rows = []) {
  const byKind = {};
  const byReason = {};
  const unknownReasons = new Set();
  const cardIds = new Set();
  let bad = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!validateRow(row).ok) { bad++; continue; }
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
    if (!isKnownReason(row.reason)) unknownReasons.add(row.reason);
    if (row.cardId) cardIds.add(row.cardId);
  }
  return {
    total: Object.values(byKind).reduce((a, b) => a + b, 0),
    byKind, byReason, unknownReasons: [...unknownReasons], cardIds: [...cardIds], bad,
  };
}

/**
 * 副作用那一半：这一行该不该自动登记一条「等主人决定」，登记时问什么。
 * 只有 `blocked` / `failed` 返回东西，其余四个 kind 一律 `null`（= 只是记录）。
 *
 * 🔴 卡名的**唯一真源 = 行里的 `detail`**（`title=…`），不是调用方给的 map。
 *    为什么（2026-11-02 实测踩到）：同一张 failed 卡会同时出现在「候选」与「账本级 failed」两处，
 *    两侧标题措辞可能不同（standup 会截断）⇒ 从 map 取标题会让**问法一天一变**，
 *    每次跑都被判成 `updated`（白写一次 state、行流统计也看不出是同一件事）。
 * @returns {null | {cardId:string, question:string, options:string[]}}
 */
export function attentionRequestFor(row, { title = '' } = {}) {
  const r = row && typeof row === 'object' ? row : null;
  if (!r || !isSideEffectKind(r.kind)) return null;
  const cardId = String(r.cardId ?? '').trim();
  if (!cardId) return null;                                   // 没卡 id 的条目无法销账 ⇒ 不登记（同 attentions 口径）
  const detailRaw = String(r.detail ?? '');
  const fromDetail = /(?:^|·\s*)title=([^·]*)/.exec(detailRaw);
  const name = clip(fromDetail ? fromDetail[1] : title, 60) || cardId;
  const why = clip(detailRaw.replace(/(?:^|·\s*)title=[^·]*/, '').replace(/^\s*·\s*/, ''), 120);
  if (r.kind === 'failed') {
    return {
      cardId,
      question: `卡「${name}」执行失败（failed）—— 重试、归档，还是先放着？`,
      options: ['重试', '归档', '先放着'],
    };
  }
  return {
    cardId,
    question: `卡「${name}」报 blocked${why ? `（${why}）` : ''}—— 谁接手？`,
    options: ['the operator接着干', '等主人', '先放着'],
  };
}
