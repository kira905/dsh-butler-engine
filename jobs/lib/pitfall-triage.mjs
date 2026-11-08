// dsh-butler / lib/pitfall-triage.mjs —— P4 落地判据（方案 §4 B 点 + §6 D 点共用判据库）
//
// 要替代的东西：2026-09-20 那一轮**纯人工**核对 59 条候选（「这条坑的防复发措施到底落地没有」）。
//   那次结论质量很好，但是一次性手工劳动 —— 候选池再涨到 100 条还得再来一遍。
//
// 改成：用候选的 `normText` 去 `source='policy'` 向量库（persona 铁律段 + 技能段）查相似度 ⇒
//   自动产出三分类的**建议**：`疑似已落地` / `确属新坑` / `中性（需人看）`。
//
// 铁的边界（方案 §4 B.1 写死）：**只产出建议**，不自动改候选池 status、不自动采纳、
//   永不自动改 persona/技能；文件里写死 `advisoryOnly: true`。
//
// 本模块是**纯函数层**（判据库无 IO）：可单测、可离线复算；写文件的只有 `pitfall-triage-tick.mjs`。
import crypto from 'node:crypto';

export const PITFALL_TRIAGE_VERSION = '0.1.0';
/** 判定建议（对外文案；id 用 ASCII，展示用中文） */
export const VERDICT_LABELS = {
  'landed-suspect': '疑似已落地',
  'new-pitfall': '确属新坑',
  neutral: '中性（需人看）',
};
export const DEFAULT_TAU = 0.62;
export const DEFAULT_MARGIN = 0.02;
/** 标定搜索空间（方案 §B.3-3） */
export const TAU_RANGE = [0.3, 0.95];
export const TAU_STEP = 0.01;

export function triageTextHash(s) {
  return crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
}

/** 余弦（policy 段向量与查询向量都经编码器 L2 归一化 ⇒ 点积即余弦；此处仍显式归一化以防夹具未归一） */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/**
 * 把 policy 段包成可查的判据库。
 * @param {Array<{refId:string, vec:ArrayLike<number>}>} entries
 * @param {Map<string,object>|object} [metaById] refId → `{docPath, section, text}`
 */
export function buildPolicyIndex(entries = [], metaById = null) {
  const meta = new Map(
    metaById instanceof Map ? [...metaById.entries()] : Object.entries(metaById || {}),
  );
  return {
    entries: entries.map((e) => ({ refId: String(e.refId), vec: e.vec })),
    meta,
    count: entries.length,
  };
}

/**
 * 对一条查询取 top-1 / top-2（**纯内存暴力**；百级条目毫秒级）。
 * @returns {{top1Score:number, top1RefId:string|null, top2Score:number, margin:number}}
 */
export function scoreAgainstPolicy(index, qvec, { entries = null } = {}) {
  const list = entries || index?.entries || [];
  if (!list.length || !qvec) return { top1Score: 0, top1RefId: null, top2Score: 0, margin: 0 };
  let s1 = -Infinity;
  let s2 = -Infinity;
  let r1 = null;
  for (const e of list) {
    const s = cosine(qvec, e.vec);
    if (s > s1) {
      s2 = s1;
      s1 = s;
      r1 = e.refId;
    } else if (s > s2) {
      s2 = s;
    }
  }
  if (!Number.isFinite(s1)) s1 = 0;
  if (!Number.isFinite(s2)) s2 = 0;
  return {
    top1Score: s1,
    top1RefId: r1,
    top2Score: s2,
    margin: s1 - s2,
  };
}

/** 分类（方案 §B.3-3：`s1 ≥ τ` 判「疑似已落地」，否则「确属新坑」；**同时要求 margin ≥ 0.02** 否则降级中性） */
export function classify(score, margin, { tau = DEFAULT_TAU, marginMin = DEFAULT_MARGIN } = {}) {
  const s = Number(score) || 0;
  const m = Number(margin) || 0;
  if (m < marginMin) return { verdict: 'neutral', confidence: Math.max(0, Math.min(1, s)) };
  if (s >= tau) return { verdict: 'landed-suspect', confidence: Math.max(0, Math.min(1, (s - tau) / Math.max(1e-9, 1 - tau))) };
  return { verdict: 'new-pitfall', confidence: Math.max(0, Math.min(1, (tau - s) / Math.max(1e-9, tau))) };
}

/**
 * 逐条判定（方案 §4 B.2 第 3 行签名：`triageCandidates({candidates, indexByPolicy, tau, margin})`）。
 *
 * @param {object} p
 * @param {Array} p.candidates 候选（用 `id` + `normText`；**只读**）
 * @param {object} p.indexByPolicy `buildPolicyIndex()` 的产物
 * @param {(c:object)=>Promise<ArrayLike<number>>} [p.encode] 查询编码器；缺省时用 `p.queries` 取现成向量
 * @param {object} [p.queries] id → 查询向量（离线/单测用，免编码器）
 * @returns {Promise<Array<{id, top1Score, top1Policy, verdict, confidence}>>}
 */
export async function triageCandidates({ candidates = [], indexByPolicy, tau = DEFAULT_TAU, margin = DEFAULT_MARGIN, encode = null, queries = null } = {}) {
  const out = [];
  for (const c of candidates) {
    const id = String(c.id);
    let qvec = queries ? queries[id] ?? queries[c.id] : null;
    if (!qvec && encode) qvec = await encode(c);
    const r = qvec
      ? scoreAgainstPolicy(indexByPolicy, qvec)
      : { top1Score: 0, top1RefId: null, top2Score: 0, margin: 0 };
    const cls = classify(r.top1Score, r.margin, { tau, marginMin: margin });
    const meta = r.top1RefId ? indexByPolicy?.meta?.get(r.top1RefId) ?? null : null;
    out.push({
      id,
      sigKey: c.sigKey ?? null,
      name: c.name ?? null,
      code: c.code ?? null,
      normText: c.normText ?? '',
      status: c.status ?? null,
      top1Score: Number(r.top1Score.toFixed(6)),
      top1RefId: r.top1RefId,
      // 「标注来源可追溯」（方案 §B.3 验收 2）：每条判定都带 top1Policy（文件路径 + 段号）
      top1Policy: meta ? `${meta.docPath}#${meta.section}` : null,
      top1Section: meta?.section ?? null,
      margin: Number(r.margin.toFixed(6)),
      verdict: cls.verdict,
      verdictLabel: VERDICT_LABELS[cls.verdict],
      confidence: Number(cls.confidence.toFixed(4)),
    });
  }
  return out;
}

/** 三分类计数（报告/摘要用） */
export function summarizeTriage(results = []) {
  const by = { 'landed-suspect': 0, 'new-pitfall': 0, neutral: 0 };
  for (const r of results) if (by[r.verdict] !== undefined) by[r.verdict] += 1;
  return { total: results.length, ...by };
}

/**
 * 标定（方案 §B.3-3）：在最优点上取 τ*。
 * 硬约束 1（安全侧）：正样本召回 **≥ 8/9**；硬约束 2（别太松）：负样本判「已落地」 **≤ 3/30**；
 * 满足两条约束的 τ 区间里取 **Youden 指数最大**者。
 *
 * @param {Array<{label:'landed'|'todo'|'third', score:number, margin:number}>} samples
 */
export function calibrate(samples = [], { marginMin = DEFAULT_MARGIN, minRecall = 8 / 9, maxFalsePositive = 3 } = {}) {
  const pos = samples.filter((s) => s.label === 'landed');
  const neg = samples.filter((s) => s.label === 'todo');
  const third = samples.filter((s) => s.label === 'third');
  const grid = [];
  for (let t = TAU_RANGE[0]; t <= TAU_RANGE[1] + 1e-9; t = Math.round((t + TAU_STEP) * 100) / 100) {
    let truePos = 0;
    let falsePos = 0;
    let thirdFlagged = 0;
    for (const s of pos) if (classify(s.score, s.margin, { tau: t, marginMin }).verdict === 'landed-suspect') truePos += 1;
    for (const s of neg) if (classify(s.score, s.margin, { tau: t, marginMin }).verdict === 'landed-suspect') falsePos += 1;
    for (const s of third) if (classify(s.score, s.margin, { tau: t, marginMin }).verdict === 'landed-suspect') thirdFlagged += 1;
    const recall = pos.length ? truePos / pos.length : 0;
    const specificity = neg.length ? (neg.length - falsePos) / neg.length : 0;
    grid.push({
      tau: Number(t.toFixed(2)),
      truePos,
      falsePos,
      thirdFlagged,
      recall: Number(recall.toFixed(4)),
      specificity: Number(specificity.toFixed(4)),
      youden: Number((recall + specificity - 1).toFixed(4)),
      passes: recall >= minRecall && falsePos <= maxFalsePositive,
    });
  }
  const feasible = grid.filter((g) => g.passes);
  const best = feasible.slice().sort((a, b) => b.youden - a.youden || a.tau - b.tau)[0] ?? null;
  return {
    samples: { total: samples.length, landed: pos.length, todo: neg.length, third: third.length },
    constraints: { minRecall, maxFalsePositive, marginMin },
    feasibleCount: feasible.length,
    tauStar: best ? best.tau : null,
    best,
    grid,
  };
}

/**
 * 留一法（方案 §B.3-4 / §10-V4「**验收主口径 = 留一法逐折预测结果**」）：
 * 每折用其余 n-1 条选 τ、判留出那 1 条，累计计分；
 * 返回稳定区间宽度（> 0.15 ⇒ 结论降级为「待更多样本」）。
 */
export function leaveOneOut(samples = [], opts = {}) {
  const { marginMin = DEFAULT_MARGIN, minRecallFrac = 8 / 9, maxFpFrac = 3 / 30 } = opts;
  const folds = [];
  for (let i = 0; i < samples.length; i += 1) {
    const train = samples.filter((_, j) => j !== i);
    const held = samples[i];
    // 逐折按「比例」重算硬约束阈值（留一后分母变了，用比例保持口径）
    const nPos = train.filter((s) => s.label === 'landed').length;
    const nNeg = train.filter((s) => s.label === 'todo').length;
    const cal = calibrate(train, {
      marginMin,
      minRecall: nPos ? Math.ceil(minRecallFrac * nPos) / nPos : 1,
      maxFalsePositive: nNeg ? Math.floor(maxFpFrac * nNeg) : 0,
    });
    const tau = cal.tauStar ?? DEFAULT_TAU;
    const v = classify(held.score, held.margin, { tau, marginMin }).verdict;
    folds.push({ index: i, label: held.label, tau, verdict: v });
  }
  const landed = folds.filter((f) => f.label === 'landed');
  const todo = folds.filter((f) => f.label === 'todo');
  const third = folds.filter((f) => f.label === 'third');
  const landedCorrect = landed.filter((f) => f.verdict === 'landed-suspect').length;
  const todoWrong = todo.filter((f) => f.verdict === 'landed-suspect').length;
  const thirdFlagged = third.filter((f) => f.verdict === 'landed-suspect').length;
  const taus = folds.map((f) => f.tau).sort((a, b) => a - b);
  const width = taus.length ? Number((taus[taus.length - 1] - taus[0]).toFixed(4)) : 0;
  return {
    folds,
    landed: { total: landed.length, correct: landedCorrect, need: Math.ceil(8 / 9 * landed.length) },
    todo: { total: todo.length, wrong: todoWrong, allowed: Math.ceil(3 / 30 * todo.length) },
    third: { total: third.length, flagged: thirdFlagged, allowed: 0 },
    tauRange: taus.length ? { lo: taus[0], hi: taus[taus.length - 1], width } : null,
    degraded: width > 0.15,
  };
}

// ─────────────────────────── D 点（§6）：新增坑筛选 + 提示词构造 ───────────────────────────

/**
 * 选「该由提炼 job 消化的新增坑」（方案 §D.1）：
 *   `source:'scan'` 且 `count ≥ minCount` 且**未被 triage 过**（用 `pitfallId + textHash` 去重，照 Z8 口径）。
 */
export function selectNewPitfalls({ pitfalls = [], triageState = null, minCount = 2 } = {}) {
  const done = new Set();
  // ⚠️ 两种形状都要收：`advisory` 恒为数组；`llm` 在文件里是**段对象**（`{generatedAt, suggestions[]}`），
  //    只有旧版/外部构造才会是数组。**只认数组会直接 `for...of` 抛 "object is not iterable"**
  //    ⇒ 第二次跑消化 job 必炸（本卡单测实测抓到）。
  const llmList = Array.isArray(triageState?.llm)
    ? triageState.llm
    : (Array.isArray(triageState?.llm?.suggestions) ? triageState.llm.suggestions : []);
  for (const a of triageState?.advisory ?? []) done.add(`${a.pitfallId ?? a.id}\u0000${a.pitfallTextHash ?? ''}`);
  for (const l of llmList) done.add(`${l.pitfallId ?? l.id}\u0000${l.pitfallTextHash ?? ''}`);
  const out = [];
  for (const p of pitfalls) {
    if (String(p.source || '') !== 'scan') continue;
    if (p.excluded) continue;
    if ((Number(p.count) || 0) < Number(minCount)) continue;
    const key = `${p.id}\u0000${triageTextHash(p.normText ?? '')}`;
    if (done.has(key)) continue;
    out.push({ pic: p, key });
  }
  return out.map((x) => ({ ...x.pic, pitfallTextHash: triageTextHash(x.pic.normText ?? '') }));
}

/**
 * D 点结论候选的提示词（方案 §D.1 模板）。
 * ⚠️ §9-D3 **已拍 = 不外送第三方 LLM**（「不外送，大肥鱼自己提炼」）⇒ 本函数的产出**只允许**喂给
 *    本工具自家链 / 本地模型；调用方（`llm-client.mjs`）自带硬闸，且 job 默认关。
 */
export function buildLlmPrompt({ pitfall, triage = null, cluster = null } = {}) {
  const p = pitfall || {};
  const lines = [];
  lines.push('[P4 待处置·建议]');
  lines.push(`分类：${p.category ?? '(未知)'} · count=${p.count ?? 0} · 会话 ${Array.isArray(p.sessions) ? p.sessions.length : 0}`);
  lines.push(`症状：${String(p.normText ?? '').slice(0, 400)}`);
  lines.push(`同源族：${cluster ? `${cluster.theme}（${cluster.size} 条，代表 ${cluster.representativeId}）` : '（C 点未上线）'}`);
  lines.push(`建议形态：${p.suggested ?? '(由 pitfall-form-map 推导)'}`);
  lines.push(`疑似落地处：${triage && triage.top1Policy ? `${triage.top1Policy}（s1=${triage.top1Score}，判定 ${triage.verdictLabel}）` : '无'}`);
  lines.push('请给出一句**可执行动作**（不超过 60 字），并说明它落在 persona / 技能 / 检查项 哪一类。');
  lines.push('⚠️ 输出仅是「待主人确认」的建议，不得自动改任何文件。');
  return lines.join('\n');
}
