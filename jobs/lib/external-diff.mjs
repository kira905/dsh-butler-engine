// dsh-butler / lib/external-diff.mjs —— P6 判定层（纯函数：快照 diff → 事件）
//
// 职责边界：只做「上一份快照 vs 这一份快照 → 事件列表」，**不碰时间窗口/冷却/上限/免打扰**
//   （那是 P2 的 watch-policy 状态机）、不碰通知（watch-notify）、不碰 IO。
//
// 事件对象与 P2 watch-events 的输出契约一致：
//   { id, title, level, deliverable, category, detail, value, worseWhen?, evidence?, url? }
//   · value 是「可比较的稳定状态串」——policy 用它实现「只报状态变化」与冷却去重
//   · 因此 id **必须与具体值无关**（如 ext.page-change.<src>，而不是把 hash 拼进 id），
//     否则每次变化都成了"新事件"，冷却/去重全部失效（这是本设计的核心不变量，单测有断言）。
//
// 三类源（方案 §4 P6）：
//   models-api  → 下限 🔴 / 新增 🟡 / 字段变化 🟡（全自动，影响 DSH 配置与推荐链）
//   status-json → 故障 🔴 / 部分 🟡 / 恢复 🟢（恢复自动解除）
//   page-diff   → 正文 hash 变化 🟡 附链接；24h 同源只提示一次；
//                 被标误报后连续 3 次仍有变化 → 自动降为「只存档不提示」
//                 【R-048 · 2026-10-15】正文命中故障词（词表唯一真源 = lib/external-incident-lexicon.mjs）
//                   ⇒ 升 🔴 走推送：故障/中断 → 「外部服务故障」· 降级/异常 → 「外部服务降级」；
//                     普通公告（不含故障词）仍是原行为 🟡 只进报告
// 另有一条**跨源聚合**判据（R-048 ②）：同一轮 ≥N 个源同时采集失败 ⇒ 🔴「外部源批量采集失败」
//   （见 judgeBatchFetchFailure；N = DEFAULTS.batchFailMinSources，缺省 2）
// 以及一条**单源长期失败**判据（R-048 B 补遗 · 2026-10-15）：某个源**连续**失败达 N 次 ⇒ 🔴「外部源长期失败」
//   （见 judgePersistentFetchFailure；N = DEFAULTS.singleFailMinCount，缺省 3）
//   —— 补的是「第二个哑火面」：只有一个源挂掉（例：某状态页一条线挂 3 天）时，此前只产 🟡、按 P2 口径只进报告、不喊人。
//      既有的逐源 🟡 事件（applyFetchFailure）**级别一字未改**；本判据另出一个 🔴 事件，
//      走同一套送达（4h 冷却 / 日上限 10 / 免打扰复用 applyPolicy，**不另建限流**）。

import { LEVEL, DELIVER } from './watch-events.mjs';
import { STATUS_LEVELS } from './external-collect.mjs';
import { DEFAULTS } from './external-sources.mjs';
import { INCIDENT_TIER_TITLE, INCIDENT_TIER_LABEL } from './external-incident-lexicon.mjs';
import crypto from 'node:crypto';

export const EXTERNAL_DIFF_VERSION = '0.1.0';

/**
 * 【R-049③ · 2026-10-21】模型 / 计费台账 = **单一真源**（`docs\API资产与定价.md`）。
 * 复核触发器两条（缺一不可）：
 *   ① **变化驱动（主路）**：P6 每天在拉 `*-models` 源 ⇒ 模型下线/新增/字段变化时，事件 detail 里**点名**
 *      「去复核台账」，不再只是"报个变化"。
 *   ② **14 天兜底（本文件 judgeLedgerReview）**：防 P6 自身漏报（被降噪/被关/冷却吞掉/判定 bug）——
 *      到期没复核过 ⇒ 出一条 🟡 提醒，并带上「自上次复核以来清单指纹是否变化」。
 * 需求真源 = `docs\管家V3.0.0-需求收集-20260929.md` §4 R-049③。
 */
export const LEDGER = {
  doc: 'docs\\API资产与定价.md',
  intervalDays: 14,
  hint: '复核台账 docs\\API资产与定价.md（R-049③ 变化驱动）',
};

const setValue = (arr) => [...new Set(arr.map(String))].sort().join('|');
const cap = (arr, n = 5) => arr.slice(0, n);
/** 本地时间（YYYY-MM-DD HH:mm:ss）——日志/状态里给人看，不用 UTC（否则 +8 时区看起来像"慢了 8 小时"）。 */
const ts = (v) => {
  const t = Number(v);
  if (!Number.isFinite(t) || t <= 0) return '?';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 事件 id（稳定，不含值）。 */
export const EV = {
  modelsDown: (src) => `ext.models-down.${src}`,
  modelsNew: (src) => `ext.models-new.${src}`,
  modelsField: (src) => `ext.models-field.${src}`,
  status: (src) => `ext.status.${src}`,
  statusRecovered: (src) => `ext.status-recovered.${src}`,
  pageChange: (src) => `ext.page-change.${src}`,
  fetchFail: (src) => `ext.fetch-fail.${src}`,
  /** R-048 ②：同一轮多源同时失败（跨源聚合，**不带源 id** —— 它代表"本机观测面失效"）。 */
  fetchFailBatch: () => 'ext.fetch-fail-batch',
  /** R-048 B 补遗：单源**连续**失败达阈值（带源 id；🔴 需送达）。
   *  ⚠️ 前缀刻意**不用** `ext.fetch-fail`：既有验收/回归里有 `startsWith('ext.fetch-fail')` 这种**无点号**判据
   *  （_test\verify-acceptance-p6.mjs L156/L158「单次失败静默」），换前缀可避免新事件被误算进那些断言。 */
  persistentFail: (src) => `ext.persistent-fail.${src}`,
  autoMuted: (src) => `ext.auto-muted.${src}`,
  /** R-049③：模型/计费台账 14 天兜底复核到期（跨源聚合，**不带源 id** —— 它管的是"台账这一份文档"）。 */
  ledgerReview: () => 'ext.ledger-review',
};

// ------------------------------------------------------------------ 模型清单 diff

/**
 * 模型清单 diff（R 回归第 1 项）。
 * @param {{ids?:string[], fields?:Record<string,Record<string,string>>}|null} prev
 * @param {{ids?:string[], fields?:Record<string,Record<string,string>>}} cur
 * @param {{trackedFields?:string[]}} [opts]
 * @returns {{first:boolean, added:string[], removed:string[], changed:Array<{id:string,field:string,from:any,to:any}>, count:number}}
 */
export function diffModels(prev, cur, opts = {}) {
  const curIds = [...new Set((cur?.ids ?? []).map(String))].sort();
  if (!prev || !Array.isArray(prev.ids)) {
    return { first: true, added: [], removed: [], changed: [], count: curIds.length };
  }
  const prevIds = [...new Set(prev.ids.map(String))].sort();
  const pSet = new Set(prevIds);
  const cSet = new Set(curIds);
  const added = curIds.filter((x) => !pSet.has(x));
  const removed = prevIds.filter((x) => !cSet.has(x));
  const tracked = opts.trackedFields ?? DEFAULTS.trackedModelFields;
  const changed = [];
  for (const id of curIds) {
    if (!pSet.has(id)) continue;
    const a = prev.fields?.[id] ?? {};
    const b = cur.fields?.[id] ?? {};
    for (const f of tracked) {
      const from = a[f] ?? null;
      const to = b[f] ?? null;
      if (from !== to) changed.push({ id, field: f, from, to });
    }
  }
  return { first: false, added, removed, changed, count: curIds.length };
}

// ------------------------------------------------------------------ 状态页映射

/**
 * statuspage indicator → 告警档（R 回归第 2 项）。
 * @returns {{order:number, label:string, level:'red'|'yellow'|null, known:boolean}}
 */
export function mapStatusLevel(indicator) {
  const key = String(indicator ?? '').trim().toLowerCase();
  const spec = STATUS_LEVELS[key];
  if (!spec) {
    // 未知值：按最保守档（🟡）处理 —— 宁可多看一眼，不可当正常
    return { order: 2, label: `未知状态(${key || '?'})`, level: LEVEL.YELLOW, known: false };
  }
  if (key === 'none') return { order: spec.order, label: spec.label, level: null, known: true };
  if (key === 'major' || key === 'critical') return { order: spec.order, label: spec.label, level: LEVEL.RED, known: true };
  return { order: spec.order, label: spec.label, level: LEVEL.YELLOW, known: true };
}

// ------------------------------------------------------------------ 各类源 → 事件

function srcUrl(src) { return src?.url ?? null; }

/** models-api 判定。 */
export function judgeModels(src, prev, cur, ctx = {}) {
  const events = [];
  const notes = [];
  const d = diffModels(prev, cur, ctx);
  if (d.first) {
    notes.push(`首轮建立基线：${d.count} 个模型（只记录，不提示新增/下线）`);
    return { events, notes };
  }
  if (d.removed.length) {
    events.push({
      id: EV.modelsDown(src.id), title: '模型下线', level: LEVEL.RED, deliverable: DELIVER.IMMEDIATE,
      category: 'external', url: srcUrl(src),
      value: setValue(d.removed),
      detail: `${src.label} 少了 ${d.removed.length} 个模型：${cap(d.removed).join(', ')}（影响现有配置 / 推荐链，去核对）`,
      evidence: { source: src.id, removed: cap(d.removed, 20), count: d.count },
    });
  }
  if (d.added.length) {
    events.push({
      id: EV.modelsNew(src.id), title: '模型新增', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
      category: 'external', url: srcUrl(src), worseWhen: 'increase',
      value: setValue(d.added),
      detail: `${src.label} 新增 ${d.added.length} 个模型：${cap(d.added).join(', ')}`,
      evidence: { source: src.id, added: cap(d.added, 20), count: d.count },
    });
  }
  if (d.changed.length) {
    const desc = d.changed.map((c) => `${c.id}.${c.field}: ${c.from ?? '(无)'} → ${c.to ?? '(无)'}`);
    events.push({
      id: EV.modelsField(src.id), title: '模型字段变化', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
      category: 'external', url: srcUrl(src), worseWhen: 'increase',
      value: setValue(desc),
      detail: `${src.label} 有 ${d.changed.length} 处字段变化：${cap(desc, 3).join('；')}`,
      evidence: { source: src.id, changed: cap(desc, 20), trackedFields: ctx.trackedFields ?? DEFAULTS.trackedModelFields },
    });
  }
  if (!events.length) notes.push(`模型清单无变化（${d.count} 个）`);
  // R-049③ 主路：清单有变化 ⇒ 事件里**点名**去复核台账（detail 会进 P6 报告与推送，不是只写在这里）
  for (const ev of events) {
    ev.ledger = LEDGER.doc;
    ev.detail = `${ev.detail}；⇒ ${LEDGER.hint}`;
  }
  return { events, notes };
}

// ------------------------------------------------------------------ 模型/计费台账 14 天兜底（R-049③）

const pad2 = (n) => String(n).padStart(2, '0');
const dayOf = (t) => {
  const d = new Date(Number(t));
  if (!Number.isFinite(Number(t)) || Number(t) <= 0) return '?';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * 模型清单指纹（**只依赖内容**：排序后的 id + 被跟踪字段的值）。
 * 用途：记住"上次复核台账时清单长什么样"，兜底提醒时才能回答"这 14 天里到底变没变"。
 * @param {string[]} ids
 * @param {Record<string,Record<string,string>>|null} fields
 * @param {string[]} [trackedFields]
 */
export function modelsFingerprint(ids = [], fields = null, trackedFields = DEFAULTS.trackedModelFields) {
  const list = [...new Set((ids ?? []).map(String))].sort();
  const parts = list.map((id) => {
    if (!fields) return id;
    const f = fields[id] ?? {};
    return `${id}@${(trackedFields ?? []).map((k) => `${k}=${f[k] ?? ''}`).join(',')}`;
  });
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

/**
 * R-049③ ②：台账 14 天兜底复核（纯函数，零 IO）。
 * 语义：
 *   · **首次调用 = 建立基线**（`baseline:true`，**不出事件** —— 与 models-api 首轮建基线同风格，避免上线当天喊人）；
 *   · 距上次复核 < intervalDays ⇒ 静默（`due:false`）；
 *   · 到期 ⇒ 出 🟡 事件，detail 点名台账 + 附「自上次复核以来清单指纹有无变化」（防"P6 报了但没人更新"）；
 *   · `next` 只在到期时把 `lastAt` 推到 now（不提前重置计时器）。
 * @param {{now?:number, ledgerReview?:{lastAt?:number, modelFp?:string|null}|null,
 *          models?:Array<{id:string, fp:string|null, count?:number|null}>, intervalDays?:number}} [opts]
 * @returns {{baseline:boolean, due:boolean, drift:boolean|null, event:object|null,
 *            next:{lastAt:number, modelFp:string|null}, notes:string[]}}
 */
export function judgeLedgerReview(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const days = Math.max(1, Number(opts.intervalDays ?? LEDGER.intervalDays) || LEDGER.intervalDays);
  const intervalMs = days * 86_400_000;
  const models = Array.isArray(opts.models) ? opts.models.filter((m) => m && m.id) : [];
  // 只用**指纹已知**的源参与比对：没采过的源（fp=null）不进基线，免得把 `'?'` 存成基线、
  // 14 天后误报"清单有变化"。等价口径 = "已知指纹的源全体一致才算无变化；新出现的源算一次变化"。
  const known = models.filter((m) => m.fp);
  const unknownSources = models.filter((m) => !m.fp).map((m) => m.id);
  const currentFp = known.length
    ? known.map((m) => `${m.id}:${m.fp}`).sort().join('|')
    : null;
  const baseFp = opts.ledgerReview?.modelFp ?? null;
  const baseAt = Number(opts.ledgerReview?.lastAt ?? 0);
  const notes = [];

  // 每源指纹对比（回答"变没变"）
  const baseMap = new Map();
  for (const tok of String(baseFp ?? '').split('|')) {
    const i = tok.indexOf(':');
    if (i > 0) baseMap.set(tok.slice(0, i), tok.slice(i + 1));
  }
  const drifted = known.filter((m) => baseMap.has(m.id) && baseMap.get(m.id) !== String(m.fp)).map((m) => m.id);
  const newSources = baseFp ? known.filter((m) => !baseMap.has(m.id)).map((m) => m.id) : [];
  const drift = currentFp && baseFp ? (currentFp !== baseFp) : null;   // null = 缺基线，判不了

  // 一条指纹都没有（模型源一次都还没成功采集）⇒ **先不建基线**（没东西可比）。
  const usable = known.length > 0;
  if (!usable) {
    notes.push('台账复核暂不可评估：模型源还没有可用指纹（等一次成功采集后再建基线）');
    return { baseline: false, due: false, drift: null, event: null, next: { lastAt: baseAt, modelFp: baseFp }, notes };
  }

  if (!baseAt) {
    notes.push(`台账复核基线已建立：下次到期 ${dayOf(now + intervalMs)}（${days} 天）`);
    return { baseline: true, due: false, drift, event: null, next: { lastAt: now, modelFp: currentFp ?? baseFp }, notes };
  }
  if (now - baseAt < intervalMs) {
    notes.push(`台账复核未到期（上次 ${dayOf(baseAt)} · 每 ${days} 天）`);
    return { baseline: false, due: false, drift, event: null, next: { lastAt: baseAt, modelFp: baseFp ?? currentFp }, notes };
  }

  const driftText = drift === null
    ? '缺基线指纹，无法判断清单是否变过（照常复核一次即可补上）'
    : drift
      ? `自上次复核以来**清单有变化**：${cap([...drifted, ...newSources].map(String), 5).join(', ') || '(指纹变了但源清单对不上)'}`
      : '自上次复核以来清单未见变化（本次属"到点复核"，不是"有新变化"）';
  const skipText = unknownSources.length ? `（未采过的源不参与比对：${cap(unknownSources, 5).join(', ')}）` : '';
  const event = {
    id: EV.ledgerReview(), title: `台账复核到期（${days} 天兜底）`, level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'external', value: dayOf(now),
    detail: `模型 / 计费台账已 ${days} 天未复核（上次 ${dayOf(baseAt)}）⇒ 复核 ${LEDGER.doc}（R-049③ 兜底扫描；主路 = 模型清单变化联动）。${driftText}${skipText}`,
    ledger: LEDGER.doc,
    evidence: {
      doc: LEDGER.doc, lastAt: baseAt, lastAtLabel: dayOf(baseAt), intervalDays: days,
      drift, drifted, newSources, unknownSources, modelSources: models.map((m) => m.id),
    },
  };
  notes.push(`台账复核到期（上次 ${dayOf(baseAt)} · ${days} 天）⇒ 已出提醒`);
  return { baseline: false, due: true, drift, event, next: { lastAt: now, modelFp: currentFp ?? baseFp }, notes };
}

/** status-json 判定（含恢复解除）。 */
export function judgeStatusJson(src, prev, cur, ctx = {}) {
  const events = [];
  const notes = [];
  const recovered = [];
  const curMap = mapStatusLevel(cur?.indicator);
  const prevIndicator = prev?.indicator ?? null;
  const prevMap = prevIndicator === null ? null : mapStatusLevel(prevIndicator);
  const wasOk = prevMap === null || prevMap.level === null;
  const isOk = curMap.level === null;

  if (prev === null) {
    notes.push(`首轮建立基线：${curMap.label}（${cur?.indicator ?? '?'}）`);
    if (!isOk) {
      // 首轮就是异常态 → 照样报（否则「本来就挂着」会永远静默）
      events.push({
        id: EV.status(src.id), title: '外部服务异常', level: curMap.level, deliverable: DELIVER.IMMEDIATE,
        category: 'external', url: srcUrl(src),
        value: String(cur?.indicator ?? 'unknown'),
        detail: `${src.label} 当前 ${curMap.label}：${cur?.description || '(无描述)'}`,
        evidence: { source: src.id, indicator: cur?.indicator ?? null, description: cur?.description ?? null, pageUpdatedAt: cur?.pageUpdatedAt ?? null },
      });
    }
    return { events, notes, recovered };
  }

  if (!isOk) {
    // 值没变就不产生事件（"只报状态变化"在判定层也表达一次；policy 的 value 机制是第二道闸）
    if (prevIndicator === cur?.indicator) {
      notes.push(`状态未变（${curMap.label}）`);
      return { events, notes, recovered };
    }
    events.push({
      id: EV.status(src.id), title: '外部服务异常', level: curMap.level, deliverable: DELIVER.IMMEDIATE,
      category: 'external', url: srcUrl(src),
      value: String(cur?.indicator ?? 'unknown'),
      detail: `${src.label} ${prevMap?.label ?? '?'} → ${curMap.label}：${cur?.description || '(无描述)'}`,
      evidence: { source: src.id, indicator: cur?.indicator ?? null, description: cur?.description ?? null, prevIndicator },
    });
  } else if (!wasOk) {
    // 🟢 恢复：既发一条「已恢复」（只进报告），又解除原告警（不再升级、不再置顶）
    recovered.push(EV.status(src.id));
    events.push({
      id: EV.statusRecovered(src.id), title: '外部服务恢复', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
      category: 'external', url: srcUrl(src),
      value: `${prevIndicator}->none@${ctx.now ?? Date.now()}`,
      detail: `${src.label} 已恢复正常（${prevMap?.label ?? prevIndicator} → 正常）`,
      evidence: { source: src.id, prevIndicator, indicator: cur?.indicator ?? null },
    });
  } else {
    notes.push(`状态未变（${curMap.label}）`);
  }
  return { events, notes, recovered };
}

/** page-diff 判定（24h 门 + 误报降噪）。 */
export function judgePageDiff(src, prev, cur, ctx = {}) {
  const events = [];
  const notes = [];
  const suppressed = [];
  const eventId = EV.pageChange(src.id);
  if (prev === null) {
    notes.push('首轮建立基线（只记录 hash，不提示）');
    return { events, notes, suppressed };
  }
  if (prev.hash === cur.hash) {
    notes.push('正文无变化');
    return { events, notes, suppressed };
  }

  // 自动降噪：被标过误报 + 其后连续 3 次仍有变化 → 只存档不提示（方案 §4 P6）。
  // 计数与置位由 tick 负责（bumpMuteStreak + makeAutoMutedEvent），本层只读 muted 标志。
  if (ctx.state?.sources?.[src.id]?.muted === true) {
    notes.push('该源已自动降为「只存档不提示」（本次变化仅存档）');
    return { events, notes, suppressed: [{ id: eventId, reason: 'auto-muted' }], muted: true };
  }

  // 24h 门：同源 24h 内只提示一次（后续变化照样推进快照）
  const gate = ctx.gates?.[eventId];
  const minGap = Number(src.minNotifyIntervalMs ?? DEFAULTS.pageMinNotifyMs);
  const lastAt = Number(gate?.lastNotifiedAt ?? 0);
  if (minGap > 0 && lastAt && (ctx.now ?? Date.now()) - lastAt < minGap) {
    notes.push(`距上次提示 ${Math.round(((ctx.now ?? Date.now()) - lastAt) / 3600000)}h，未满 ${Math.round(minGap / 3600000)}h → 本次只存档`);
    return { events, notes, suppressed: [{ id: eventId, reason: 'page-gate-24h' }] };
  }

  // R-048 ①：正文故障语义分级（采集层已把 signals 算好放进快照）
  //   档位语义：major = 故障/中断 · minor = 降级/异常 · none = 普通公告（原文案不变）
  //   为什么故障档要判 🔴：P2 的送达口径是「🔴 推送 / 🟡 只进报告」（lib/watch-policy.mjs:149）
  //   ⇒ 只有判到 🔴 才会真的喊到人（2026-10-15 事故：两次都判 🟡 ⇒ 推送 0）。
  const sig = cur?.signals ?? null;
  const incident = sig && (sig.level === 'major' || sig.level === 'minor') ? sig : null;
  const hits = incident?.hits ?? [];
  const brief = cap(hits.map((h) => h.matched).filter(Boolean), 3).join('、');
  const evidenceText = String(hits[0]?.context ?? cur.excerpt ?? '').slice(0, 200);
  const sigEvidence = sig
    ? {
      level: sig.level, version: sig.version ?? null, reason: sig.reason ?? null, hitCount: sig.hitCount ?? 0,
      matches: incident ? cap(hits.map((h) => ({ tier: h.tier, id: h.id, matched: h.matched })), 5) : [],
    }
    : null;

  events.push({
    id: eventId,
    title: incident ? (INCIDENT_TIER_TITLE[incident.level] ?? '外部服务异常') : '外部页面更新',
    level: incident ? LEVEL.RED : LEVEL.YELLOW,
    deliverable: DELIVER.IMMEDIATE,
    category: 'external', url: srcUrl(src),
    // value：故障态带档位前缀 —— 档位变化（普通更新 → 故障）必须被 policy 视为"变了"才会推
    value: incident ? `${incident.level}@${cur.hash}` : String(cur.hash),
    detail: incident
      ? `${src.label} 正文判定为「${INCIDENT_TIER_LABEL[incident.level] ?? incident.level}」（命中 ${hits.length} 处：${brief || '—'}）：${evidenceText}`
      : `${src.label} 正文有变化（只提示有变化，不解析内容）：「${String(cur.excerpt ?? '').slice(0, 120)}」`,
    evidence: {
      source: src.id, hash: String(cur.hash ?? '').slice(0, 16), prevHash: String(prev.hash ?? '').slice(0, 16),
      textLen: cur.textLen ?? null, excerpt: String(cur.excerpt ?? '').slice(0, 300), kinds: 'page-diff',
      signals: sigEvidence,
    },
  });
  return { events, notes, suppressed };
}

/**
 * 自动降噪计数（纯函数，由 tick 调用并落盘）。
 * 规则：该源的 page 事件被标过误报（falsePositiveAt）之后，每再检测到一次「有变化」就 +1；
 *      累计到 3 → 该源降为「只存档不提示」。未被标过误报 → 计数归零（不会误伤正常源）。
 * @returns {{streak:number, muted:boolean, justMuted:boolean, markedFalsePositive:boolean}}
 */
export function bumpMuteStreak(state, sourceId, eventId, opts = {}) {
  const threshold = Number(opts.threshold ?? 3);
  const srcState = state?.sources?.[sourceId] ?? {};
  const muted = srcState.muted === true;
  const fpAt = Number(state?.policy?.events?.[eventId]?.falsePositiveAt ?? 0);
  const streak = muted ? Number(srcState.muteStreak ?? 0) : (fpAt > 0 ? Number(srcState.muteStreak ?? 0) + 1 : 0);
  return { streak, muted, justMuted: !muted && streak >= threshold, markedFalsePositive: fpAt > 0, threshold };
}

/** 降噪事件（一次性；tick 在 justMuted 时加入事件流）。 */
export function makeAutoMutedEvent(src, streak, now = Date.now(), opts = {}) {
  return {
    id: EV.autoMuted(src.id), title: '外部源已自动降噪', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
    category: 'external', url: srcUrl(src),
    value: `muted@${now}`,
    detail: `${src.label} 连续 ${streak} 次「有变化」都被标误报 → 已自动降为只存档不提示（阈值 ${opts.threshold ?? 3}；恢复：node <pkg>/src/dsh-butler/butler-external.mjs --unmute ${src.id}）`,
    evidence: { source: src.id, streak },
  };
}

/** 统一分派：按 kind 判定。 */
export function judgeSource(src, prev, cur, ctx = {}) {
  if (src.kind === 'models-api') return judgeModels(src, prev, cur, ctx);
  if (src.kind === 'status-json') return judgeStatusJson(src, prev, cur, ctx);
  if (src.kind === 'page-diff') return judgePageDiff(src, prev, cur, ctx);
  return { events: [], notes: [`未知 kind：${src.kind}`] };
}

// ------------------------------------------------------------------ 失败计数 / 恢复解除

/**
 * R-048 ②：同一轮「≥N 个源同时采集失败」⇒ 单独立一个 🔴 事件（跨源聚合）。
 *
 * 为什么需要（2026-10-15 真实事故）：08:07 tick 上三个状态页（DeepSeek / OpenAI / 智谱）**同时 `fetch failed`** ——
 *   恰是「最该喊人」的时刻，但此时每源才**第 1 次**失败，逐源判据还在「连续失败计数（默认 3）」的静默期里
 *   ⇒ 报告只有一行「⚠️ 采集失败（3）」、**推送 0**。本函数补的就是「多源同时瞎 ⇒ 眼睛被蒙上了」这个信号。
 *
 * 语义边界（文案要说清，别让人误读成"供应商挂了"）：这是**本机观测面**的失效告警。
 *   · 单源失败 / 未达阈值 ⇒ **不出事件**（单源抖动是常态，仍走原逐源连续失败判据，行为不变）
 *   · 只统计**本轮真跑了且失败**的源（`skipped` 未到期的源不算分母）
 *
 * @param {Array<{id:string, ok?:boolean, skipped?:boolean, reason?:string, error?:string}>} results runTick 的本轮结果
 * @param {{minSources?:number}} [opts]
 * @returns {{event:object|null, count:number, threshold:number, sources:string[], reason:string}}
 */
export function judgeBatchFetchFailure(results, opts = {}) {
  const threshold = Math.max(2, Number(opts.minSources ?? DEFAULTS.batchFailMinSources ?? 2));
  const failed = (Array.isArray(results) ? results : []).filter((r) => r && r.ok === false && !r.skipped);
  const ids = failed.map((r) => String(r.id)).sort();
  if (failed.length < threshold) {
    return {
      event: null, count: failed.length, threshold, sources: ids,
      reason: `本轮失败源 ${failed.length} 个（未达批量阈值 ${threshold}，仍走逐源连续失败判据）`,
    };
  }
  return {
    event: {
      id: EV.fetchFailBatch(), title: '外部源批量采集失败', level: LEVEL.RED, deliverable: DELIVER.IMMEDIATE,
      category: 'external', url: null, worseWhen: 'increase',
      value: ids.join('|'),
      detail: `同一轮有 ${failed.length} 个源全部采集失败（阈值 ${threshold}）：${ids.join('、')} —— 多为本机网络 / 上游同时不可达；此期间外部信号是盲区，先核对网络，再判断是不是大面积故障`,
      evidence: {
        sources: ids, count: failed.length, threshold,
        errors: cap(failed.map((r) => ({ id: r.id, reason: r.reason ?? null, error: String(r.error ?? '').slice(0, 160) })), 6),
      },
    },
    count: failed.length, threshold, sources: ids,
    reason: `本轮 ${failed.length} 个源失败（≥ 阈值 ${threshold}）→ 升级为「需送达」事件`,
  };
}

/**
 * 【R-048 B 补遗 · 2026-10-15】单源**长期失败** ⇒ 需送达事件（🔴）。
 *
 * 补的哑火面（原卡 §4.1 第 1 条登记的范围内未做项）：08:07 那次是「多源同时瞎」（已由 judgeBatchFetchFailure 兜住），
 *   但**只有一个源挂掉**时（例：status.deepseek.com 一条线挂 3 天）此前只产 🟡「外部源连续拉取失败」，
 *   按 P2 口径（lib/watch-policy.mjs:149「🔴 推送 / 🟡 只进报告」）⇒ **只进报告、不喊人**。
 *
 * 判断依据（**不自造字段**）：`state.sources[<id>].failCount` —— 由 applyFetchFailure 维护的「连续失败计数」，
 *   采集成功时由 applyFetchSuccess 归零。`results` 只用来确定「本轮真跑过且失败」的源集合
 *   （`skipped` 未到期的源不算，与 judgeBatchFetchFailure 同口径）。
 *
 * 语义边界：
 *   · 与跨源聚合判据**并列、互不替代**：本品管「一个源持续瞎」，那条管「同时瞎一片」；两者可同时成立、各出各的事件。
 *   · 既有逐源 🟡 事件**级别未改** —— 本品是**新增**的一条 🔴，不是把 🟡 改红（不回归：单源新逻辑不改变多源场景）。
 *   · 只对「本轮仍在失败」的源出事件：采集恢复后 failCount 归零，本事件由 runTick 走 releaseEvents 一并解除。
 *
 * @param {Array<{id:string, ok?:boolean, skipped?:boolean, reason?:string, error?:string, failCount?:number, label?:string}>} results runTick 的本轮结果
 * @param {{sources?:Record<string,{failCount?:number, failFirstAt?:number, lastError?:string, lastFailReason?:string}>}} state 状态文件内容（failCount 的**权威来源**）
 * @param {{minFailures?:number, registry?:Array<{id:string,label?:string,url?:string}>}} [opts]
 * @returns {{events:Array, count:number, threshold:number, sources:string[], hits:Array, reason:string}}
 */
export function judgePersistentFetchFailure(results, state, opts = {}) {
  const threshold = Math.max(2, Number(opts.minFailures ?? DEFAULTS.singleFailMinCount ?? 3));
  const failed = (Array.isArray(results) ? results : []).filter((r) => r && r.ok === false && !r.skipped);
  const byId = new Map((Array.isArray(opts.registry) ? opts.registry : []).map((s) => [String(s?.id ?? ''), s]));
  const events = [];
  const hits = [];
  for (const r of failed) {
    const id = String(r.id);
    const rt = state?.sources?.[id] ?? {};
    // 权威计数 = state（applyFetchFailure 写的连续失败计数）；r.failCount 只作兜底（老调用方不传 state 时）
    const count = Number(rt.failCount ?? r.failCount ?? 0);
    if (!(count >= threshold)) {
      hits.push({ source: id, failCount: count, fired: false });
      continue;
    }
    const src = byId.get(id);
    const since = Number(rt.failFirstAt ?? 0);
    const label = src?.label ?? r.label ?? id;
    const lastError = String(rt.lastError ?? r.error ?? '未知错误').slice(0, 160);
    hits.push({ source: id, failCount: count, fired: true });
    events.push({
      id: EV.persistentFail(id),
      title: '外部源长期失败',
      level: LEVEL.RED,                 // 需送达：P2 口径「🔴 推送 / 🟡 只进报告」
      deliverable: DELIVER.IMMEDIATE,
      category: 'external',
      url: src?.url ?? null,
      worseWhen: 'increase',
      // value 随次数变化（照 applyFetchFailure 体例）：冷却窗（4h）过后仍会再提醒一次 ——
      //   否则夜间/日上限被挡掉的那一次被记进 lastValue 后，就再也不会响（持续故障等于静默）。
      value: String(count),
      detail: `${label} 已连续 ${count} 次采集失败（阈值 ${threshold}，自 ${ts(since)} 起）：${lastError}`
        + ' —— 单点长期瞎意味着这条线的外部信号一直是盲区，先核对它是不是真挂了',
      evidence: {
        source: id, failCount: count, threshold, since: since || null,
        lastError: rt.lastError ?? null, lastFailReason: rt.lastFailReason ?? r.reason ?? null,
      },
    });
  }
  const fired = hits.filter((h) => h.fired);
  return {
    events, count: fired.length, threshold, sources: fired.map((h) => h.source).sort(), hits,
    reason: fired.length
      ? `${fired.length} 个源连续失败 ≥ ${threshold} 次（${fired.map((h) => `${h.source}×${h.failCount}`).join('、')}）→ 升级为「需送达」事件`
      : `本轮没有源连续失败达 ${threshold} 次（逐源 🟡 判据不变）`,
  };
}

/**
 * 连续失败计数（R 回归第 4 项）：单次失败静默；连续 ≥ 阈值才产生 🟡 事件。
 * auth 类失败（401/403/凭证缺失）不是网络抖动，首即提示。
 * @returns {{sources:object, event:object|null, needNotify:boolean, count:number, reason:string}}
 */
export function applyFetchFailure(state, src, failure, opts = {}) {

  const now = opts.now ?? Date.now();
  const threshold = Number(opts.failThreshold ?? DEFAULTS.failThreshold);
  const sources = { ...(state?.sources ?? {}) };
  const cur = { ...(sources[src.id] ?? {}) };
  const authLike = failure?.reason === 'credential' || failure?.status === 401 || failure?.status === 403;
  cur.failCount = Number(cur.failCount ?? 0) + 1;
  cur.failFirstAt = cur.failFirstAt || now;
  cur.lastFailAt = now;
  cur.lastError = String(failure?.error ?? 'unknown').slice(0, 300);
  cur.lastFailReason = failure?.reason ?? null;
  sources[src.id] = cur;
  const effectiveThreshold = authLike ? 1 : threshold;
  if (cur.failCount < effectiveThreshold) {
    return { sources, event: null, needNotify: false, count: cur.failCount, reason: `连续失败 ${cur.failCount} 次（未达阈值 ${effectiveThreshold}，静默跳过）` };
  }
  const detailBits = [`${src.label} 连续 ${cur.failCount} 次拉取失败`, `最后一次：${cur.lastError}`];
  if (authLike) detailBits.push('（凭证/鉴权类失败，不是网络抖动 → 立即提示）');
  return {
    sources, count: cur.failCount, needNotify: true,
    reason: `连续失败 ${cur.failCount} 次（阈值 ${effectiveThreshold}）`,
    event: {
      id: EV.fetchFail(src.id), title: '外部源连续拉取失败', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
      category: 'external', url: src?.url ?? null, worseWhen: 'increase',
      value: String(cur.failCount),
      detail: detailBits.join(' · '),
      evidence: { source: src.id, failCount: cur.failCount, since: cur.failFirstAt, lastError: cur.lastError, reason: cur.lastFailReason },
    },
  };
}

/** 采集成功：清失败计数；若此前处于失败态 → 生成恢复事件 + 解除原告警。 */
export function applyFetchSuccess(state, src, opts = {}) {
  const now = opts.now ?? Date.now();
  const sources = { ...(state?.sources ?? {}) };
  const cur = { ...(sources[src.id] ?? {}) };
  const wasFailing = Number(cur.failCount ?? 0) > 0 && Boolean(cur.failNotifiedAt);
  cur.failCount = 0;
  cur.failFirstAt = 0;
  cur.lastError = null;
  cur.lastOkAt = now;
  cur.failNotifiedAt = 0;
  sources[src.id] = cur;
  const events = [];
  const recovered = [];
  if (wasFailing) {
    recovered.push(EV.fetchFail(src.id));
    events.push({
      id: `${EV.fetchFail(src.id)}.recovered`, title: '外部源恢复', level: LEVEL.YELLOW, deliverable: DELIVER.IMMEDIATE,
      category: 'external', url: src?.url ?? null,
      value: `recovered@${now}`,
      detail: `${src.label} 已恢复正常采集`,
      evidence: { source: src.id },
    });
  }
  return { sources, events, recovered };
}

/**
 * 恢复解除：把已恢复的事件从告警态里摘掉（ack + 清 deferred），
 * 这样「未确认 >4h 就升级」不会对已恢复的故障反复升级。纯函数。
 */
export function releaseEvents(policyState, eventIds, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!policyState || !Array.isArray(eventIds) || !eventIds.length) return { state: policyState, released: [] };
  const events = { ...(policyState.events ?? {}) };
  const released = [];
  for (const id of eventIds) {
    if (events[id] && !events[id].ackedAt) {
      events[id] = { ...events[id], ackedAt: now, releasedAt: now, releasedReason: opts.reason ?? 'recovered' };
      released.push(id);
    } else if (events[id]) {
      events[id] = { ...events[id], releasedAt: now, releasedReason: opts.reason ?? 'recovered' };
    }
  }
  const deferred = (policyState.deferred ?? []).filter((d) => !eventIds.includes(d?.id));
  return { state: { ...policyState, events, deferred }, released };
}

/** 汇总一次 tick 的采集结果（供 digest / 状态输出）。 */
export function summarizeTick(results, now = Date.now()) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const unstable = results.filter((r) => r.unstable).length;
  return { at: new Date(now).toISOString(), total: results.length, ok, failed, skipped, unstable };
}

export { ts as formatTs };
