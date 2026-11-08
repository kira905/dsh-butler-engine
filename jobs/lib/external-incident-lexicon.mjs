// dsh-butler / lib/external-incident-lexicon.mjs —— P6 故障语义词表 + 分级纯函数（R-048）
//
// 为什么需要它（2026-10-15 真实事故）：
//   status.deepseek.com 是**自建 Next.js**（/api/v2/status.json → 404 RouteNotFound，非 statuspage 标准接口）
//   ⇒ 只能 page-diff；而当时口径写死「只提示有变化，不解析内容」⇒ 正文里明明写着
//   「We're currently experiencing issues … 影响 对话服务(Chatservice)、DeepSeek V4.1 Flash API 及另外 1 个组件」，
//   系统一字不读，事件只判 🟡「外部页面更新」⇒ 两次都没喊到人。本模块补的正是「读懂正文里的故障语义」。
//
// 职责边界：**只做「正文文本 → 故障档」**，不碰采集 / 不碰冷却 / 不碰通知 / 不碰 IO。
//   · 采集层（external-collect.mjs）在归一化正文上跑一次，把结果作为 `signals` 存进快照（**不存全文**）
//   · 判定层（external-diff.mjs）读 `signals` → 决定事件级别（故障/降级 ⇒ 🔴 才走推送）
//
// 三条设计口径：
//   ① **词表集中此处**（同义词只在这一个文件里维护；改词表不动判定逻辑、不动采集逻辑）
//   ② **降误报靠上下文，不靠缩词**：命中点周围窗口内有「解除词」（resolved/已恢复…）⇒ 该次命中作废；
//      命中点**前**窗口内有「否定词」（no / 暂无…）⇒ 该次命中作废（状态页常见 "No incidents reported today"）
//   ③ **只取最高档**：major > minor > none；**每条词最多记 2 处命中**（防单页堆词导致证据爆炸）

export const LEXICON_VERSION = '0.1.0';

/** 档位（数值越大越严重；取 max 聚合）。 */
export const INCIDENT_TIERS = { none: 0, minor: 1, major: 2 };
export const INCIDENT_TIER_LABEL = { none: '正常', minor: '降级/异常', major: '故障/中断' };
/** 事件标题里用的档位名（判定层展示）。 */
export const INCIDENT_TIER_TITLE = { minor: '外部服务降级', major: '外部服务故障' };

/**
 * 故障关键词表（**唯一真源**：同义词只在这里加）。
 * tier：major = 中断/不可用/严重 · minor = 降级/异常/部分影响
 * 匹配一律大小写不敏感；`\b` 只对英文有效（汉字之间不存在词边界 —— 2026-08 踩过，别给中文加 `\b`）。
 */
export const INCIDENT_TERMS = [
  // ── major：中断 / 不可用 / 严重 ─────────────────────────────────────────
  { tier: 'major', id: 'outage', re: /\boutages?\b/i, note: '服务中断（statuspage 惯用 outage）' },
  { tier: 'major', id: 'disruption', re: /\b(?:major|service|significant|widespread)\s+disruption\b/i, note: '服务中断（disruption）' },
  { tier: 'major', id: 'is-down', re: /\b(?:is|are|was|were|been|be)\s+(?:fully\s+|completely\s+|currently\s+)?down\b/i, note: '服务已宕（X is/are down）' },
  { tier: 'major', id: 'unavailable', re: /\b(?:service|services|system|systems|api|platform|site|portal|dashboard)s?\s+(?:(?:is|are|was|were|remains?)\s+)?(?:currently\s+|temporarily\s+)?unavailable\b/i, note: '服务不可用（含无系动词的 "Service unavailable"）' },
  { tier: 'major', id: 'major-incident', re: /\b(?:major|critical|severe)\s+(?:incident|outage|issue|failure|error)s?\b/i, note: '重大/严重级别事件' },
  { tier: 'major', id: 'critical-status', re: /\b(?:status|indicator)\s*[:：]\s*critical\b/i, note: '状态页标 critical' },
  { tier: 'major', id: 'zh-interrupt', re: /服务中断|服务不可用|全部不可用|完全不可用|全网不可用|全线(?:故障|中断|不可用)/, note: '中文：服务中断/不可用' },
  { tier: 'major', id: 'zh-major', re: /(?:重大|严重|大面积|大规模)(?:故障|事故|中断|异常|不可用)/, note: '中文：重大/严重故障' },

  // ── minor：降级 / 异常 / 部分影响 ───────────────────────────────────────
  { tier: 'minor', id: 'experiencing-issues', re: /experiencing\s+(?:some\s+|an?\s+)?(?:issues?|problems?|difficulties|errors?|failures?|disruptions?)/i, note: '“正在经历问题”（DeepSeek 自建站 2026-10-15 原句）' },
  { tier: 'minor', id: 'degraded', re: /\bdegraded\b/i, note: '“降级”（statuspage indicator 亦用 degraded）' },
  { tier: 'minor', id: 'degradation', re: /\bdegradations?\b/i, note: '“退化/降级”（Partial System Degradation）' },
  { tier: 'minor', id: 'incident', re: /\bincidents?\b/i, note: '“事件”（有 incident 在跟进）' },
  { tier: 'minor', id: 'elevated', re: /\b(?:elevated|increased|higher(?:\s+than\s+normal)?|spikes?\s+in)\s+(?:error|errors|error\s+rates?|latenc(?:y|ies)|failure\s+rates?|response\s+times?|timeouts?)\b/i, note: '错误率/延迟异常升高' },
  { tier: 'minor', id: 'degraded-perf', re: /\b(?:degraded|impaired|reduced|slow)\s+(?:performance|service|availability|responses?)\b/i, note: '性能/服务降级' },
  { tier: 'minor', id: 'intermittent', re: /\bintermittent(?:ly)?\s+(?:errors?|failures?|timeouts?|issues?|problems?)\b/i, note: '间歇性错误/超时' },
  { tier: 'minor', id: 'partial-issue', re: /\bpartial\s+(?:service\s+|system\s+)?(?:issues?|degradation|failure|outage)/i, note: '部分影响（Partial …）' },
  { tier: 'minor', id: 'investigating', re: /\b(?:investigating|under\s+investigation)\b/i, note: '“正在排查”（事件跟进中）' },
  { tier: 'minor', id: 'zh-degraded', re: /服务降级|性能降级|能力降级|降级(?:中|状态)|性能下降|响应(?:缓慢|变慢|超时)|异常升高|部分(?:异常|不可用|用户)|间歇性(?:错误|失败|超时|异常)|波动(?:较|明显)/, note: '中文：降级/性能下降/部分影响' },
];

/**
 * 解除词（**窗口 ±N** 内出现 ⇒ 该次命中作废）。
 * 用途：状态页会把**历史条目**留在正文里（"API outage (resolved)"）⇒ 不做窗口过滤就是天天误报。
 * ⚠️ 故意**不含 monitoring** —— "we are monitoring the situation" 仍处于故障中，收它会把真故障吃掉。
 */
export const RELIEF_TERMS = [
  { id: 'resolved', re: /\bresolved\b/i },
  { id: 'restored', re: /\brestored\b/i },
  { id: 'fixed', re: /\bfixed\b/i },
  { id: 'recovered', re: /\brecovered\b/i },
  { id: 'back-normal', re: /\bback\s+to\s+normal\b/i },
  { id: 'all-operational', re: /\ball\s+systems?\s+(?:are\s+)?(?:operational|running)/i },
  { id: 'zh-resolved', re: /已恢复|已修复|已解决|恢复正常|恢复完成/ },
];

/**
 * 否定词（**仅前缀窗口** `-[N, 0)` 内出现 ⇒ 该次命中作废）。
 * 用途：状态页惯用语 "No incidents reported today." / "暂无故障"。
 * ⚠️ 中文只收**多字组合**（单字「无」在 32 字窗口里会把「服务降级，无计费影响」这类真故障挡掉）。
 */
export const NEGATION_PREFIX_TERMS = [
  { id: 'no', re: /\bno\b/i },
  { id: 'none', re: /\bnone\b/i },
  { id: 'zero', re: /\bzero\b/i },
  { id: 'without', re: /\bwithout\b/i },
  { id: 'zh-none', re: /暂无|未发生|未出现|无故障|无异常|无中断|没有(?:故障|异常|中断|问题)/ },
];

/** 缺省参数（可被单轮 opts 覆盖；不写进源注册表、不落盘）。 */
export const LEXICON_DEFAULTS = {
  contextWindow: 60,   // 解除词窗口：命中点前后各 N 字符
  prefixWindow: 32,    // 否定词窗口：命中点前 N 字符
  maxContext: 120,     // 证据片段最长字符数
  maxHits: 8,          // 返回的命中最多条数
  maxPerTerm: 2,       // 单条词最多记几处命中
};

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

const withGlobal = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);

/**
 * 正文 → 故障档（**纯函数**，无 IO、无时间依赖、可单测）。
 *
 * @param {string} text 归一化后的正文字符串（也可以是任意片段）
 * @param {{contextWindow?:number, prefixWindow?:number, maxContext?:number, maxHits?:number, maxPerTerm?:number,
 *          terms?:Array, reliefTerms?:Array, negationTerms?:Array}} [opts]
 * @returns {{level:'none'|'minor'|'major', tier:number, reason:string, hits:Array, suppressed:Array,
 *            chars:number, version:string, window:object}}
 */
export function classifyIncidentText(text, opts = {}) {
  const raw = String(text ?? '');
  const win = Number(opts.contextWindow ?? LEXICON_DEFAULTS.contextWindow);
  const prefixWin = Number(opts.prefixWindow ?? LEXICON_DEFAULTS.prefixWindow);
  const maxCtx = Number(opts.maxContext ?? LEXICON_DEFAULTS.maxContext);
  const maxHits = Number(opts.maxHits ?? LEXICON_DEFAULTS.maxHits);
  const perTerm = Number(opts.maxPerTerm ?? LEXICON_DEFAULTS.maxPerTerm);
  const terms = Array.isArray(opts.terms) ? opts.terms : INCIDENT_TERMS;
  const relief = Array.isArray(opts.reliefTerms) ? opts.reliefTerms : RELIEF_TERMS;
  const negation = Array.isArray(opts.negationTerms) ? opts.negationTerms : NEGATION_PREFIX_TERMS;

  const hits = [];
  const suppressed = [];

  for (const t of terms) {
    const re = withGlobal(t.re);
    let m;
    let kept = 0;
    while ((m = re.exec(raw)) !== null) {
      if (m[0] === '') { re.lastIndex += 1; continue; }   // 空匹配防线（词表不该有，但别死循环）
      const at = m.index;
      const end = at + m[0].length;
      const ctx = raw.slice(Math.max(0, at - win), Math.min(raw.length, end + win));
      const prefix = raw.slice(Math.max(0, at - prefixWin), at);
      const reliefHit = relief.find((r) => r.re.test(ctx));
      const negHit = negation.find((r) => r.re.test(prefix));
      if (reliefHit) {
        suppressed.push({ tier: t.tier, id: t.id, matched: m[0], at, by: `relief:${reliefHit.id}`, context: clip(ctx, maxCtx) });
        continue;
      }
      if (negHit) {
        suppressed.push({ tier: t.tier, id: t.id, matched: m[0], at, by: `negation:${negHit.id}`, context: clip(ctx, maxCtx) });
        continue;
      }
      if (kept >= perTerm) continue;
      kept += 1;
      hits.push({ tier: t.tier, id: t.id, matched: m[0], at, note: t.note ?? null, context: clip(ctx, maxCtx) });
    }
  }

  const level = hits.some((h) => h.tier === 'major') ? 'major' : (hits.length ? 'minor' : 'none');
  const majorHits = hits.filter((h) => h.tier === 'major').length;
  const reason = level === 'none'
    ? (suppressed.length
      ? `未命中故障词（${suppressed.length} 处命中被解除词/否定词过滤：${[...new Set(suppressed.map((s) => s.by))].join('、')}）`
      : '未命中任何故障词')
    : `命中 ${hits.length} 处故障词（同为最高档 ${level} 的 ${majorHits || hits.length} 处）→ 判 ${INCIDENT_TIER_LABEL[level]}`;

  return {
    level,
    tier: INCIDENT_TIERS[level] ?? 0,
    reason,
    hits: hits.slice(0, maxHits),
    hitCount: hits.length,
    suppressed: suppressed.slice(0, maxHits),
    suppressedCount: suppressed.length,
    chars: raw.length,
    version: LEXICON_VERSION,
    window: { context: win, prefix: prefixWin },
  };
}

/**
 * 快照里存的那份信号（**裁剪版**：只存命中证据，绝不存全文）。
 * 采集层调它 → 写进 page-diff 快照的 `signals` 字段；判定层直接读，不再接触全文。
 */
export function snapshotSignals(text, opts = {}) {
  const r = classifyIncidentText(text, opts);
  const base = { level: r.level, tier: r.tier, version: r.version, chars: r.chars, reason: r.reason };
  if (r.level === 'none') return base;
  return { ...base, hits: r.hits, hitCount: r.hitCount, suppressedCount: r.suppressedCount };
}

/** 词表规模（`--status` / 文档 / 单测用；只读）。 */
export function summarizeLexicon() {
  const byTier = { major: 0, minor: 0 };
  for (const t of INCIDENT_TERMS) byTier[t.tier] = (byTier[t.tier] ?? 0) + 1;
  return {
    version: LEXICON_VERSION,
    terms: INCIDENT_TERMS.length, byTier,
    reliefTerms: RELIEF_TERMS.length, negationTerms: NEGATION_PREFIX_TERMS.length,
    defaults: { ...LEXICON_DEFAULTS },
  };
}
