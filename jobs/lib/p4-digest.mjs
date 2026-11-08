// dsh-butler / lib/p4-digest.mjs —— D 点：S3 夜间提炼 job 顺带消化 P4 新增坑（方案 §6）
//
// 在 `distill-job.mjs` 的 **同一 job 里加一个独立 phase**（方案 §D.2-7 选「加 phase」）：
//   `phase = 'distill' | 'p4-digest'`；两段各自独立 `try/catch`、各自出口写进同一 `summary`；
//   **P4 段失败不得把整个 job 记成失败**（§D.5 的 gate 顺序断言）。
//
// 硬边界（照方案原文）：
//   ① §9-D3 已拍 = **不外送第三方 LLM**（「不外送，大肥鱼自己提炼」）；本模块**默认不调 LLM**，
//      只跑规则部分（选新增坑 + 建议形态 + 族/判据引用），产物一律标「待主人确认」；
//   ② 产出**只写 `butler-p4-triage.json` 的 `llm` 段**（§D.1 落点：与 B 点同文件、分 advisory/llm 两段）；
//      **候选池 status/decision 零变化**（§D.6-3 不越权）；
//   ③ 去重 = `pitfallId + textHash`（§D.6-1 幂等；同日重跑不重复产出）；
//   ④ 成本闸 = ≤20 次/日、≤150K token/日，超限即停 + 不重试（§D.6-2）；
//   ⑤ **默认关**：闸文件 `~/.dsh/butler-p4-digest.json` 的 `enabled`；读不到/损坏 ⇒ 判关（fail-safe）。
//
// 【V3.0.0 地基 · 技术债 D-7 / D-9（2026-10-19 卡「V3地基-P4收口」）】
//   ⑥ D-9 修法 = **同日重跑合并而非覆盖**：写回时以「已有 `llm.suggestions` + 本轮新建议」按
//      `pitfallId + textHash` 先到先得合并 ⇒ 历史结论不清零，且去重记录不丢（旧实现覆盖后，
//      下一轮会把已消化过的坑重新产出）。✅ 改动面 = 本文件的合并逻辑一处（`mergeLlmSuggestions`）。
//   ⑦ D-7 修法 = **job 写 state、日报从 state 渲染**（照 `distill-health.mjs` 既有形态；**不在 job 里
//      直接 append 日报** —— 04:10 跑时当天日报还不存在，append 会静默丢）。落点 =
//      `~/.dsh/butler-p4-digest.json` 的 `digest` 段（`asOf` / `count` 结论条数 / `source` 来源）；
//      读取与渲染也由本文件出口（`readP4DigestState` / `p4DigestDailyLine`），日报只调用不复制口径。
//
// 【V3.0.0 地基 · 技术债 D-8 / D-10（2026-10-19 卡「D-8+D-10」）】
//   ⑧ D-8 = **接线自家链 LLM**：注入点 `llmCall` 由 `lib/p4-llm-call.mjs` 适配 `llm-client.mjs#llmText`
//      （缺省接、显式 `null` 才关）；子开关 `gate.llm.enabled`（缺省 true）可一键关回纯规则；
//      同源族一轮只调一次（`generatedBy:'llm-family'`）；建议文本上限 200 → 400 字。
//   ⑨ D-10 = **补 L0 降档闸**：`checkAutonomyAllowed` 非 normal ⇒ `status:'blocked'`、`ok:true`、
//      零调用零花费（与 distill 段同规格；闸位在 enabled 之后、坑库判定之前）。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, statePath } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { acquireTickLock, readJson, writeTextAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../../src/dsh-butler/lib/dual-write.mjs';
import { selectNewPitfalls, buildLlmPrompt, triageTextHash, VERDICT_LABELS } from './pitfall-triage.mjs';
// 【V3.0.0 地基 · D-10（2026-10-19）】L0 降档闸：与 distill 段同规格（`checkAutonomyAllowed`）。
//   接线前 P4 段在降档态照跑 `ok` ⇒ 闸门不对称；接线 LLM 后降档拦不住花钱 ⇒ 必须先补这道闸。
import { checkAutonomyAllowed } from '../../src/dsh-butler/lib/autonomy-state.mjs';
import { loadPitfallView } from './pitfall-source.mjs';

export const P4_DIGEST_VERSION = '0.1.0';

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-p4-digest.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

export const P4_DIGEST_GATE_FILE = 'butler-p4-digest.json';
export const P4_DIGEST_SCHEMA = 1;
/** 与记忆提炼同档的成本闸（方案 §D.4 引 D8 口径） */
export const P4_COST_LIMITS = Object.freeze({ callsPerDay: 20, tokensPerDay: 150000 });
/** 写 `butler-p4-triage.json` 用的互斥锁名（与 `pitfall-triage-tick.mjs` **同一个锁**⇒ 两处不会同时写） */
export const TRIAGE_LOCK_NAME = 'tick-pitfall-triage';

export function emptyGate() {
  return { schemaVersion: P4_DIGEST_SCHEMA, enabled: false, updatedAt: null, why: '默认关（未放行）', cost: { day: null, calls: 0, tokens: 0 } };
}

/**
 * 闸读取（**fail-safe**：文件缺失/损坏/字段不认 ⇒ **判关**）。
 * 唯一权威层 = `~/.dsh/butler-p4-digest.json#enabled`（改开关不改代码）。
 */
export function readP4DigestGate(home = dshHome()) {
  const file = stateFileOf(P4_DIGEST_GATE_FILE, { home });
  if (!fs.existsSync(file)) {
    return { enabled: false, file, source: 'missing', reason: '闸文件不存在 ⇒ 判关（默认关是设计，不是故障）', gate: emptyGate() };
  }
  let gate;
  try {
    gate = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { enabled: false, file, source: 'corrupt', reason: `闸文件损坏 ⇒ 判关：${String(e && e.message ? e.message : e)}`, gate: emptyGate() };
  }
  if (gate?.enabled !== true) {
    return { enabled: false, file, source: 'file', reason: `显式关（enabled=${JSON.stringify(gate?.enabled)}${gate?.why ? `: ${gate.why}` : ''}）`, gate };
  }
  return { enabled: true, file, source: 'file', reason: '放行', gate };
}

/**
 * LLM 子开关（`gate.llm`）：**缺省 enabled=true**（= 接线即生效，与方案 §3-① 一致）。
 * `{enabled:false}` = 一键关回纯规则（**此时即使传了 `llmCall` 也不调**）。
 * 为什么缺省 true 而不是像 `enabled` 那样缺省关：总闸（`enabled`）已经是 fail-safe 关；
 *   子开关只承担「出问题时不必改代码、翻一下即回纯规则」的 kill switch 职责（方案 §8 行业惯例表）。
 * @returns {{enabled:boolean, model:string|null, source:'default'|'file'}}
 */
export function readLlmGate(gate) {
  const raw = gate?.llm;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: true, model: null, source: 'default' };
  }
  return {
    enabled: raw.enabled !== false,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    source: 'file',
  };
}

// ───────────────────────── D-9：同日重跑**合并**而非覆盖 ─────────────────────────
/**
 * 合并 `llm` 段建议：**保留已有（先到先得）+ 只 append 新键**。
 * 键 = `pitfallId + textHash`（与 `selectNewPitfalls` 的去重键**同一口径**）。
 * 为什么保留旧条目：① 当日结论不清零；② 去重记录不丢（否则下一轮会把已消化的坑重新产出）。
 * @param {Array} prev 文件里已有的建议（可为段对象/数组的合法内容）
 * @param {Array} next 本轮新产出的建议
 * @returns {Array} 合并后的建议列表
 */
export function mergeLlmSuggestions(prev, next) {
  const out = [];
  const indexOf = new Map();
  const listOf = (v) => (Array.isArray(v) ? v : (Array.isArray(v?.suggestions) ? v.suggestions : []));
  const keyOf = (s) => `${String(s.pitfallId ?? '')}\u0000${String(s.pitfallTextHash ?? '')}`;
  const isLlm = (s) => String(s?.generatedBy ?? '').startsWith('llm') || s?.rejudged === 'neutral';

  // ① 先放已有（保持原顺序）
  for (const s of listOf(prev)) {
    if (!s || typeof s !== 'object') continue;
    const key = keyOf(s);
    if (indexOf.has(key)) continue;
    indexOf.set(key, out.length);
    out.push(s);
  }

  // ② 再合并本轮新条目：
  //    · 新键 ⇒ append（D-9 原语义：历史不清零、去重记录不丢）
  //    · 同键且「旧的只是规则模板、新的是模型结论」⇒ **原地升级**（2026-10-19 实测缺陷：
  //      早先纯规则跑出的 137 条占了键 ⇒ 12 条真 LLM 结论被"先到先得"整批丢掉，
  //      `merge {previous:147, added:12, total:147}`，回判一条都没落盘）
  //    · 其余同键 ⇒ 保持旧条目（先到先得，幂等）
  for (const s of listOf(next)) {
    if (!s || typeof s !== 'object') continue;
    const key = keyOf(s);
    const at = indexOf.get(key);
    if (at === undefined) {
      indexOf.set(key, out.length);
      out.push(s);
      continue;
    }
    const old = out[at];
    // ① 规则模板 → 模型结论：升级覆盖
    if (!isLlm(old) && isLlm(s)) { out[at] = s; continue; }
    // ② 显式重判（`--only` / `rejudge.at` 更新）⇒ **覆盖旧模型结论**
    //    （2026-10-19 实测：族级复用收紧后重判 13 条，因"先到先得"全被旧 llm 结论挡掉 ⇒ 一条没生效）
    const tNew = Date.parse(String(s?.rejudge?.at ?? '')) || 0;
    const tOld = Date.parse(String(old?.rejudge?.at ?? '')) || 0;
    if (tNew && tNew > tOld) out[at] = s;
  }
  return out;
}

// ───────────────────────── 族级复用判据（2026-10-19 收紧）────────────────────────
/**
 * 族级复用判据（**收紧版**，2026-10-19）：只有「小族 + 文本高度相近」才允许族内共用一条结论。
 *
 * 为什么收紧：按向量聚出来的大族会把**不同成因**的坑揉在一起，族内共用 ⇒ 错误扩散。
 * 实测（58 条人工抽评，`docs\验收-P4回判结论人工抽评-20261019.md`）：
 *   · 编辑族 `c-5830ea60`（460 条）把「read_image 只收 PNG/JPEG」也吞进来 ⇒ 答成"编辑前没重读文件"；
 *   · 浏览器族 `c-76537086`（34 条）把 5 类不同报错揉一起 ⇒ 全答成"Job Object 拦截"。
 *
 * @param {object|null} cluster 同源族（需 `size`）
 * @param {string} memberNormText 当前条目的归一化文本
 * @param {string} firstNormText 该族首条（产出结论那条）的归一化文本
 * @returns {boolean} 允许复用
 */
export const P4_FAMILY_REUSE_MAX_SIZE = 5;
export const P4_FAMILY_REUSE_MIN_PREFIX = 0.6;
export function canReuseFamily(cluster, memberNormText, firstNormText) {
  const size = Number(cluster?.size ?? 0);
  if (!(size > 1) || size > P4_FAMILY_REUSE_MAX_SIZE) return false;
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const a = norm(firstNormText);
  const b = norm(memberNormText);
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i >= Math.ceil(n * P4_FAMILY_REUSE_MIN_PREFIX);
}

// ───────────────────────── D-7：state 落点 + 日报渲染 ─────────────────────────
export const P4_DIGEST_STATE_SCHEMA = 1;

/**
 * 读 `digest` 段（**只读 + fail-soft**）。
 * 判据：闸文件不存在 / `enabled !== true` / 无 `digest` 段 / schema 不认 ⇒ `ok:false` ⇒ 日报**不渲染**。
 * （"没跑过"与"跑过 0 条"必须能分开：后者 `ok:true, state.count === 0`。）
 */
export function readP4DigestState(home = dshHome()) {
  const gate = readP4DigestGate(home);
  const file = gate.file;
  // 成本闸读数（`cost` 段在**闸文件根部**，不在 `digest` 段里 —— 由 `recordP4Cost` 记）
  const cost = gate.gate?.cost ?? null;
  if (!gate.enabled) {
    return { ok: false, reason: gate.reason, source: gate.source, enabled: false, file, state: null, cost };
  }
  const d = gate.gate?.digest;
  if (!d || typeof d !== 'object') {
    return { ok: false, reason: 'digest-missing（放行但还没跑过一轮）', source: 'state-missing', enabled: true, file, state: null, cost };
  }
  if (Number(d.schemaVersion ?? -1) !== P4_DIGEST_STATE_SCHEMA) {
    return { ok: false, reason: `digest schema-mismatch:${d.schemaVersion}`, source: 'state', enabled: true, file, state: null, cost };
  }
  return { ok: true, reason: 'ok', source: 'state', enabled: true, file, state: d, cost };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 成本记账用的「当日」口径（**UTC** —— 与 `recordP4Cost` / `checkCostBudget` 的 `day` 同源，别用本地日期） */
export const p4CostDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * 【R-055 · 2026-10-22】成本闸读数一段（拼在日报那行末尾）。
 *
 * 判据三条（核心是「不许造假」）：
 *   ① `cost` 缺失 / `day` 为 `null`（放行但一轮都没花过钱）⇒ 写「无当日读数」，
 *      **绝不**渲染成 `0 次 / 0 token` —— 0 会被读成"跑了但没花钱"，与"没跑过 / 没记过账"是两件事；
 *   ② `day` == 当日（UTC）⇒ 报当日真账；
 *   ③ `day` ≠ 当日 ⇒ **标明是旧账**（带上日期），不把昨天的数冒充今天。
 * @param {{day?:string|null, calls?:number, tokens?:number}|null} cost 闸文件根部 `cost` 段
 * @returns {string} 形如 ` · 成本闸 当日 3 次 / 1200 token`
 */
export function p4CostSegment(cost, now = Date.now()) {
  if (!cost || typeof cost !== 'object' || !cost.day) return ' · 成本闸 无当日读数';
  const calls = Number(cost.calls);
  const tokens = Number(cost.tokens);
  if (!Number.isFinite(calls) && !Number.isFinite(tokens)) return ' · 成本闸 无当日读数';
  const c = Number.isFinite(calls) ? calls : 0;
  const t = Number.isFinite(tokens) ? tokens : 0;
  const day = String(cost.day);
  if (day === p4CostDay(now)) return ` · 成本闸 当日 ${c} 次 / ${t} token`;
  return ` · 成本闸 旧账 ${day}（非当日）${c} 次 / ${t} token`;
}

/**
 * 日报一行（`report.mjs` 直接用）。**无 state / enabled=false / 坏档 ⇒ 返回 `null`（不渲染、不造假行）**。
 * @returns {string|null}
 */
export function p4DigestDailyLine({ home = dshHome(), now = Date.now() } = {}) {
  const r = readP4DigestState(home);
  if (!r.ok) return null;
  const d = r.state;
  const t = Date.parse(String(d.asOf ?? ''));
  const stamp = Number.isFinite(t)
    ? `${pad2(new Date(t).getMonth() + 1)}-${pad2(new Date(t).getDate())} ${pad2(new Date(t).getHours())}:${pad2(new Date(t).getMinutes())}`
    : '—';
  const age = Number.isFinite(t) ? `（${Math.max(0, (Number(now) - t) / 3600000).toFixed(1)}h 前）` : '';
  const status = d.status ? ` · 状态 ${d.status}` : '';
  return `- 🧪 P4 消化：最近一轮 ${stamp}${age} · 结论 **${Number(d.count) || 0}** 条`
    + `（本轮新增 ${Number(d.added) || 0}）· 来源 ${d.source ?? '?'}${status}`
    + ' · 数据：P4 摘要状态文件#digest'
    + p4CostSegment(r.cost, now);
}

/**
 * 落 `digest` 段（**只动 `digest`，保留 `enabled` / `why` / `cost`**）。
 * 只在闸文件 `enabled === true` 时写（关着 = 不跑 = 不落点）。
 * @returns {boolean} 是否写入
 */
export function recordP4DigestState(home, digest) {
  const file = stateFileOf(P4_DIGEST_GATE_FILE, { home });
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cur = null; }
  if (cur?.enabled !== true) return false;
  const dw = writeStateText(P4_DIGEST_GATE_FILE, JSON.stringify({
    ...cur,
    digest: { schemaVersion: P4_DIGEST_STATE_SCHEMA, ...digest },
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return true;
}

/** 当日成本闸判定（超限 ⇒ 停，不重试） */
export function checkCostBudget(gate, { day, callsPerDay = P4_COST_LIMITS.callsPerDay, tokensPerDay = P4_COST_LIMITS.tokensPerDay } = {}) {
  const c = gate?.cost ?? {};
  const sameDay = String(c.day ?? '') === String(day ?? '');
  const calls = sameDay ? Number(c.calls) || 0 : 0;
  const tokens = sameDay ? Number(c.tokens) || 0 : 0;
  if (calls >= callsPerDay) return { ok: false, reason: `当日调用数 ${calls}/${callsPerDay} 已达上限 ⇒ 停（不重试）`, calls, tokens };
  if (tokens >= tokensPerDay) return { ok: false, reason: `当日 token ${tokens}/${tokensPerDay} 已达上限 ⇒ 停（不重试）`, calls, tokens };
  return { ok: true, calls, tokens };
}

/**
 * 成本记账（**同一份账** = 闸文件的 `cost` 段；D 点 job 与 `p4-rejudge-neutral` CLI 共用本函数）。
 * 口径：**同日累加、跨日归零**（与 `checkCostBudget` 的 `sameDay` 判据一致 —— 否则跨日后旧计数
 * 会把新一天的额度提前吃光，等于永久停摆）。
 * @returns {{ok:boolean, cost:object|null, reason:string|null}}
 */
export function recordP4Cost(home, { gate = null, day, calls = 0, tokens = 0, now = Date.now() } = {}) {
  if (!calls && !tokens) return { ok: true, cost: null, reason: null };
  const g = gate ? { enabled: true, gate } : readP4DigestGate(home);
  if (!g.enabled) return { ok: false, cost: null, reason: '闸未放行 ⇒ 不记账' };
  const doc = g.gate ?? emptyGate();
  const c = doc.cost ?? {};
  const sameDay = String(c.day ?? '') === String(day ?? '');
  const next = {
    ...doc,
    cost: {
      day,
      calls: (sameDay ? Number(c.calls) || 0 : 0) + Number(calls || 0),
      tokens: (sameDay ? Number(c.tokens) || 0 : 0) + Number(tokens || 0),
    },
    updatedAt: new Date(now).toISOString(),
  };
  try {
    const dw = writeStateText(P4_DIGEST_GATE_FILE, JSON.stringify(next, null, 2) + '\n', {
      home: g.file ? path.dirname(g.file) : home, write: (p, t) => writeTextAtomic(p, t),
    });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
    return { ok: true, cost: next.cost, reason: null };
  } catch (e) {
    return { ok: false, cost: null, reason: String(e && e.message ? e.message : e) };
  }
}

/** 规则部分的「建议形态」模板（不调 LLM 时用；有 triage/族引用则带上） */
export function ruleSuggestion(p, { triage = null, cluster = null } = {}) {
  const form = p.suggested || 'check';
  const where = triage?.top1Policy ? `（疑似落地处：${triage.top1Policy}）` : '';
  const fam = cluster ? `同源族「${cluster.theme}」共 ${cluster.size} 条；` : '';
  return `${fam}按「${form}」形态处置：先看 ${String(p.code || p.name || '该坑')} 的复发条件，把纪律写进${form === 'persona' ? ' persona（须走 persona-maintain + P5 审计）' : form === 'skill' ? ' 相关技能' : '检查项'}${where}。**待主人确认**。`;
}

/**
 * 跑一轮 P4 消化（**纯规则，不调 LLM**；LLM 走可注入 `llmCall`，缺省不调、不发外网）。
 *
 * @returns {{ok:boolean, status:string, reason:string|null, detail:object, summary:string, suggestions:Array, written:boolean}}
 */
export async function runP4Digest({
  home = dshHome(),
  now = Date.now(),
  dryRun = true,
  minCount = 2,
  triageFile = null,
  pitfallsFile = null,
  clustersFile = null,
  llmCall = null,
  maxCalls = P4_COST_LIMITS.callsPerDay,
  maxTokens = P4_COST_LIMITS.tokensPerDay,
  lock = true,
} = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const gate = readP4DigestGate(home);
  const tfile = triageFile || resolveStatePath('butler-p4-triage.json', { home }).path;
  const pfile = pitfallsFile || resolveStatePath('butler-pitfalls.json', { home }).path;
  const cfile = clustersFile || resolveStatePath('butler-p4-clusters.json', { home }).path;
  const detail = { home, dryRun, gate: { enabled: gate.enabled, source: gate.source, reason: gate.reason, file: gate.file }, triageFile: tfile, pitfallsFile: pfile, clustersFile: cfile, minCount };

  // ① 闸门：未放行 ⇒ 安全跳过（**不计失败**，§D.5：P4 段只影响自己那段）
  if (!gate.enabled) {
    return { ok: true, status: 'skipped-disabled', reason: gate.reason, detail, summary: 'p4-digest：skipped-disabled（默认关 ⇒ 安全跳过）', suggestions: [], written: false };
  }
  // ② L0 降档闸（D-10 · 2026-10-19）：与 distill 段同规格。**零花费、不算 job 失败**（ok:true）。
  //    位置写死：闸文件 enabled 之后、坑库存在判定之前（方案 §4 闸门顺序）。
  const l0 = checkAutonomyAllowed({ home, kind: 'p4-digest' });
  detail.l0 = { allowed: l0.allowed === true, level: l0.level, reason: l0.reason, file: l0.file };
  if (!l0.allowed) {
    return {
      ok: true,
      status: 'blocked',
      reason: `L0 降档中（level=${l0.level}）：${l0.reason}`,
      detail: { ...detail, blockedBy: 'l0' },
      summary: `p4-digest：blocked（L0 降档中 level=${l0.level}，零调用、零花费）`,
      suggestions: [],
      written: false,
    };
  }
  // LLM 子开关（`gate.llm`）：缺省 enabled=true；false = 一键关回纯规则（即使传了 llmCall 也不调）
  const llmGate = readLlmGate(gate.gate);
  const useLlm = Boolean(llmCall) && llmGate.enabled;
  detail.llmGate = { ...llmGate, injected: Boolean(llmCall), useLlm };
  if (!fs.existsSync(pfile)) {
    return { ok: true, status: 'skipped-missing-pitfalls', reason: `坑库不存在：${pfile}`, detail, summary: 'p4-digest：skipped-missing-pitfalls', suggestions: [], written: false };
  }
  // 【A 案 Q3（2026-11-05）· 读侧合一的可观测面】本段是**判定**（产出 triage 建议），原料必须是
  //   `count / score / stage` 这类**只存在于聚类态**的字段 ⇒ 仍读缓存 json（合规：Q3 规则 1「json 只用于聚类态/次数」）。
  //   但「md 为准」侧的现状要如实进 detail：真冲突数 / 手写条目数 / 缓存健康 / 滞后数 —— 冲突**不静默**。
  try {
    const view = loadPitfallView({ pitfallsFile: pfile, now });
    detail.pitfallSource = {
      source: view.source,
      mdUnique: view.md.unique,
      manualOnly: view.conflicts.manualOnly.length,
      conflicts: view.conflicts.total,
      conflictsByKey: view.conflicts.byKey,
      skew: view.conflicts.skew.total,
      cacheOk: view.cache.ok,
      cacheReason: view.cache.reason,
      note: 'md=权威真源 · json=派生缓存（Q3 写侧合一）；本段用缓存算 score/stage，冲突以 md 为准并在此如实报出',
    };
  } catch (e) {
    detail.pitfallSource = { error: String(e?.message ?? e) };
  }

  // ② 取数（全部只读）
  const pitfalls = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(pfile, 'utf8'));
      return Array.isArray(raw) ? raw : raw?.pitfalls ?? [];
    } catch { return []; }
  })();
  let triageDoc = null;
  try { triageDoc = JSON.parse(fs.readFileSync(tfile, 'utf8')); } catch { triageDoc = null; }
  let clustersDoc = null;
  try { clustersDoc = JSON.parse(fs.readFileSync(cfile, 'utf8')); } catch { clustersDoc = null; }

  // ③ 选「该消化的新增坑」（pitfallId + textHash 去重 ⇒ 幂等）
  const fresh = selectNewPitfalls({ pitfalls, triageState: triageDoc, minCount: Number(minCount) || 2 });
  const advisoryById = new Map((triageDoc?.advisory ?? []).map((a) => [String(a.id), a]));
  const clusterOfId = new Map();
  for (const c of clustersDoc?.clusters ?? []) for (const m of c.memberIds) clusterOfId.set(String(m), c);
  detail.selected = fresh.length;
  detail.gateCost = checkCostBudget(gate.gate, { day, callsPerDay: maxCalls, tokensPerDay: maxTokens });

  // ④ 逐条出建议（默认纯规则；LLM 受子开关 + 成本闸；**同族一轮只调一次**）
  const suggestions = [];
  const familyCache = new Map(); // clusterId → { action }（族级复用：省 ~10× 调用）
  let calls = 0;
  let tokens = 0;
  let llmFamilyReused = 0;
  let stopping = null;
  for (const p of fresh) {
    const tri = advisoryById.get(String(p.id)) ?? null;
    const cluster = clusterOfId.get(String(p.id)) ?? null;
    const familyKey = cluster ? String(cluster.clusterId) : null;
    let action = ruleSuggestion(p, { triage: tri, cluster });
    let generatedBy = 'rules';
    if (useLlm) {
      const cached = familyKey ? familyCache.get(familyKey) : null;
      if (cached && canReuseFamily(cluster, p.normText, cached.normText)) {
        // 同族第二次起复用首条结论（**收紧后**：仅小族 + 文本高度相近才复用）
        action = cached.action;
        generatedBy = 'llm-family';
        llmFamilyReused += 1;
      } else {
        const budget = checkCostBudget({ cost: { day, calls: detail.gateCost.calls + calls, tokens: detail.gateCost.tokens + tokens } }, { day, callsPerDay: maxCalls, tokensPerDay: maxTokens });
        if (!budget.ok) { stopping = budget.reason; break; }
        try {
          const r = await llmCall({ prompt: buildLlmPrompt({ pitfall: p, triage: tri, cluster }), meta: { category: p.category ?? null, clusterId: familyKey } });
          calls += 1;
          tokens += Number(r?.tokens ?? 0) || 0;
          if (r?.ok && r.text) {
            action = String(r.text).slice(0, 400); // 建议文本上限 200 → 400（D-8）
            generatedBy = 'llm';
            if (familyKey) familyCache.set(familyKey, { action, normText: p.normText });
          } else if (r && r.ok === false) {
            // 适配器把异常收敛成 {ok:false} ⇒ 同样回退规则模板（不抛、不阻断）
            stopping = stopping ?? `LLM 返回失败：${String(r.reason ?? 'unknown')}`;
          }
        } catch (e) {
          // LLM 不可用 ⇒ 该条退回规则模板，**不阻断**（§D.6-5）
          stopping = stopping ?? `LLM 调用失败：${String(e && e.message ? e.message : e)}`;
        }
      }
    }
    suggestions.push({
      pitfallId: String(p.id),
      pitfallTextHash: p.pitfallTextHash ?? triageTextHash(p.normText ?? ''),
      category: p.category ?? null,
      count: Number(p.count) || 0,
      sessions: Array.isArray(p.sessions) ? p.sessions.length : 0,
      normText: String(p.normText ?? '').slice(0, 200),
      suggestedForm: p.suggested ?? null,
      sameFamily: cluster ? { clusterId: cluster.clusterId, theme: cluster.theme, size: cluster.size, representativeId: cluster.representativeId } : null,
      suspectedLanded: tri ? { verdict: tri.verdict, verdictLabel: VERDICT_LABELS[tri.verdict] ?? tri.verdict, top1Policy: tri.top1Policy ?? null, score: tri.top1Score ?? null } : null,
      action,
      generatedBy,
      disclaimer: '待主人确认',
      advisementOnly: true,
    });
  }

  detail.calls = calls;
  detail.tokens = tokens;
  detail.familyReuse = llmFamilyReused;
  detail.stopping = stopping;

  const section = {
    generatedAt: new Date(now).toISOString(),
    asOf: new Date(now).toISOString(),
    version: P4_DIGEST_VERSION,
    advisoryOnly: true,
    notice: '⚠️ 本段是**建议**（规则模板 / 本工具自家链产出），不得据此自动改候选池或 persona/技能；人工点一次才算。',
    selection: {
      minCount: Number(minCount) || 2,
      selected: fresh.length,
      llm: useLlm,
      llmEnabled: llmGate.enabled,
      llmModel: llmGate.model,
      familyReuse: llmFamilyReused,
    },
    cost: { calls, tokens, day, limits: { callsPerDay: maxCalls, tokensPerDay: maxTokens } },
    stopping: stopping ?? null,
    suggestions,
  };

  // D-7：state 基线（成功/空跑/被锁都要留一行可核的落盘物；dry-run 不落）
  const prevLlm = Array.isArray(triageDoc?.llm?.suggestions)
    ? triageDoc.llm.suggestions
    : (Array.isArray(triageDoc?.llm) ? triageDoc.llm : []);
  const digestBase = {
    asOf: new Date(now).toISOString(),
    count: prevLlm.length,
    added: 0,
    source: useLlm ? 'job+llm' : 'job+rules',
    job: 'memory-distill/p4-digest',
    selected: fresh.length,
  };
  let writtenSection = section;

  if (!suggestions.length && !triageDoc) {
    // 没东西可写、也没有 B 点的文件可合并 ⇒ 不凭空造文件；但**成功路径必须留 state**（D-7）
    const stateWritten = dryRun ? false : recordP4DigestState(home, { ...digestBase, status: 'ok-empty', count: 0 });
    return { ok: true, status: dryRun ? 'dry-run' : 'ok-empty', reason: '无新增坑且无 B 点判定文件', detail, summary: `p4-digest：${dryRun ? 'dry-run' : 'ok'} · 新增坑 0 条`, suggestions, written: false, stateWritten, section };
  }

  if (dryRun) {
    return { ok: true, status: 'dry-run', reason: null, detail, summary: `p4-digest：dry-run · 拟产出 ${suggestions.length} 条建议`, suggestions, written: false, section };
  }

  // ⑤ 写回（**与 B 点同文件、分 llm 段**；先拿同一个锁 ⇒ 与 triage CLI 不并发写）
  let lk = { ok: true, release: () => {} };
  if (lock) {
    lk = acquireTickLock(TRIAGE_LOCK_NAME, { home, ttlMs: 10 * 60_000 });
    if (!lk.ok) {
      // 被锁：不写 triage，但仍留 state（日报据此显示"最近一轮被锁"，不静默）
      try { recordP4DigestState(home, { ...digestBase, status: 'locked', reason: String(lk.reason ?? '').slice(0, 200) }); } catch { /* state 失败不阻断 */ }
      return { ok: true, status: 'locked', reason: `另一实例持锁（${lk.reason}）⇒ 本轮不写`, detail, summary: 'p4-digest：locked（另一实例在写判定文件）', suggestions, written: false, section };
    }
  }
  let merged = prevLlm;
  try {
    const base = triageDoc && typeof triageDoc === 'object'
      ? triageDoc
      : { schemaVersion: 1, advisoryOnly: true, notice: '⚠️ advisoryOnly：B 点未跑过，本文件由 D 点首次创建。', generatedAt: new Date(now).toISOString(), advisory: [], llm: [] };
    // D-9：**合并**（保留已有建议 + 只 append 新键），不再整段覆盖
    merged = mergeLlmSuggestions(prevLlm, suggestions);
    writtenSection = {
      ...section,
      suggestions: merged,
      merge: { previous: prevLlm.length, added: suggestions.length, total: merged.length },
    };
    const doc = { ...base, llm: writtenSection, updatedAt: new Date(now).toISOString() };
    const dw = writeStateText('butler-p4-triage.json', JSON.stringify(doc, null, 2) + '\n', {
      home: triageFile ? path.dirname(tfile) : home, write: (p, t) => writeTextAtomic(p, t),
    });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
    detail.merged = { previous: prevLlm.length, added: suggestions.length, total: merged.length };
  } finally {
    lk.release();
  }

  // 成本记账回写（**只动 cost 字段**，不覆盖 enabled）—— 必须在 state 之前：
  //   `recordP4DigestState` 会重读现文件再写，放后面才不会被这份旧快照抹掉 digest。
  if (calls || tokens) {
    try {
      const rec = recordP4Cost(home, { gate: gate.gate, day, calls, tokens, now });
      if (!rec.ok) detail.costError = rec.reason;
    } catch (e) {
      detail.costError = String(e && e.message ? e.message : e);
      /* 记账失败不阻断主流程 */
    }
  }

  // D-7：落 state（`enabled` / `why` / `cost` 一律保留；失败不阻断但要在 detail 里留痕）
  let stateWritten = false;
  try {
    stateWritten = recordP4DigestState(home, {
      ...digestBase,
      status: stopping ? 'stopped' : 'ok',
      count: merged.length,
      added: suggestions.length,
      stopping: stopping ?? null,
    });
  } catch (e) {
    detail.stateError = String(e && e.message ? e.message : e);
  }

  return {
    ok: true,
    status: stopping ? 'stopped' : 'ok',
    reason: stopping,
    detail,
    summary: `p4-digest：${stopping ? 'stopped' : 'ok'} · 产出 ${suggestions.length} 条建议 · 历史累计 ${merged.length} 条 · 当日调用 ${calls}/${maxCalls}`
      + (stopping ? ` · 停机：${stopping}` : ''),
    suggestions,
    written: true,
    stateWritten,
    section: writtenSection,
  };
}

/** 一键开关（供 CLI 用；默认 dry-run） */
export function setP4DigestGate(home, enabled, { why = null, dryRun = true } = {}) {
  const file = stateFileOf(P4_DIGEST_GATE_FILE, { home });
  const cur = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return emptyGate(); } })();
  const next = { ...emptyGate(), ...cur, schemaVersion: P4_DIGEST_SCHEMA, enabled: Boolean(enabled), why: why ?? (enabled ? '已放行' : '默认关（未放行）'), updatedAt: new Date().toISOString() };
  if (dryRun) return { dryRun: true, file, before: cur, after: next };
  const dw = writeStateText(P4_DIGEST_GATE_FILE, JSON.stringify(next, null, 2) + '\n', {
    home, write: (p, t) => writeTextAtomic(p, t),
  });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return { dryRun: false, file, before: cur, after: next };
}
