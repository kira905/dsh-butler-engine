// dsh-butler / lib/tickd-metrics.mjs —— tick 调度观测口径的**单一真源**（2026-10-09 · 冲刺600 · 批4-3）
//
// 为什么存在（缺口 = v2 方案 §3.7「可观测性与 SLO」在生产只落地 1/8）：
//   ① 指标命名：方案 §3.7.2 定死口径「自定义指标前缀 `dsh.butler.*`（如
//      `dsh.butler.collector.duration_ms`、`dsh.butler.alert.count`）」，但全库**代码零命中**
//      —— 只有方案文档里那一行，没有任何承载物；
//   ② 开销预算：方案 §3.7.5 定死「单次 tick 耗时 轻量 <2 s / 重量 <10 s」为**硬指标（进验收）**，
//      可 tickd 只把"最后一次耗时"写进 state（`lastDurationMs`），**没有任何预算判定/超界记录**
//      ⇒ 预算没有载体、超了也看不见。
//   本模块 = 把这两件事的口径**写成常量 + 纯函数**：谁能读、叫什么名、预算多少、超了怎么算。
//   消费方（tickd 调度器 / 面板 / 日报 / 未来可观测后端）都从这里取，**不许各自再写一份**。
//
// 纪律三条：
//   ① **纯函数**（无 fs / 无网络 / 无 Date.now 默认值以外的副作用）—— 可单测、可注入时钟；
//   ② **不改业务行为**：预算超界只"记录 + 可见"，绝不自动降频/降档/跳 job（本文件不提供任何写开关的入口）；
//   ③ **不新建第二套状态**：产物由调用方落进**既有** tickd 状态文件（`%TEMP%\dsh-butler-tickd\state.json`），
//      本模块只负责"算什么"。
//
// 预算标定口径（**不是拍脑袋**）：`JOB_BUDGET_OVERRIDES` 的值来自 tickd 调度日志
//   `%TEMP%\dsh-butler-tickd.log` 的实测分布（2026-10-08T00:27 ~ 2026-10-09T08:11 · 约 32 小时 · 全量
//   `job <id>: <status> (<N>ms)` 行），取 `max(档位底线, ceil(p95 × 1.5 / 1000) × 1000)`：
//   —— ×1.5 留抖动余量（磁盘/杀软/机器忙时的正常抖动不该天天告警）；
//   —— 未观测过的 job **不拍脑袋**，回落档位缺省（见 `budgetForJob`），首跑实测后再回填。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TICKD_METRICS_VERSION = '1.0.0';

/** 命名前缀（v2 方案 §3.7.2 原文口径：`dsh.butler.*`，跟 OTel GenAI SemConv，不自造）。 */
export const METRIC_PREFIX = 'dsh.butler.';

/** 命名规则正则（三段式 `<prefix><domain>.<metric>`）—— 单测拿它断言"全表都合规"。 */
export const METRIC_NAME_RE = /^dsh\.butler\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** 口径出处（报告/文档引用时照抄这一行，别凭记忆转述）。 */
export const NAMING_SOURCE = '仓内命名规范：指标名前缀（§3.7.2）+ 耗时预算（§3.7.5）';

/**
 * 命名表 = 本卡**实际采用**的指标名（唯一真源）。
 *
 * 取值理由（逐条，防"自造第二套口径"的质疑）：
 *   · domain 只用方案里已经出现过的词：`collector`（方案 §3.7.2 原例 `dsh.butler.collector.duration_ms`
 *     + §3.7.1「各**采集器**最近成功时间」—— tick job 在方案里统称采集器）、`alert`（原例 `dsh.butler.alert.count`）；
 *   · metric 段用 OTel 惯例 `duration_ms` / `count`（方案原例的两个写法），**不引入 `_total` 等第二套后缀风格**；
 *   · job 维度走**标签**（不塞进指标名）—— 这样将来接任何后端，`by (job)` 聚合零改动。
 */
export const NAMED_METRICS = Object.freeze({
  // —— domain = collector（tick 采集/执行器）———————————————
  jobDurationMs: Object.freeze({
    name: 'dsh.butler.collector.duration_ms', unit: 'ms', labels: ['job', 'status', 'via'],
    desc: '单次 tick job 执行耗时（子进程 exit 时落值；口径 = v2 §3.7.5「单次 tick 耗时」）',
  }),
  jobBudgetMs: Object.freeze({
    name: 'dsh.butler.collector.budget_ms', unit: 'ms', labels: ['job', 'class'],
    desc: '该 job 的名义耗时预算（档位缺省或实测标定覆盖值；超界只记录不降档）',
  }),
  jobBudgetExceededCount: Object.freeze({
    name: 'dsh.butler.collector.budget_exceeded', unit: '1', labels: ['job'],
    desc: '累计超预算次数（计数型 · 人工回填观察口径；只看"有没有变多"就够）',
  }),
  jobRunsCount: Object.freeze({
    name: 'dsh.butler.collector.runs', unit: '1', labels: ['job'],
    desc: '累计执行次数（计数型；与 state.jobs.<id>.runs 同源，映射成指标名供聚合）',
  }),
  jobFailuresCount: Object.freeze({
    name: 'dsh.butler.collector.failures', unit: '1', labels: ['job'],
    desc: '累计失败次数（计数型；含 spawn-error / 非让路非 0 退出码）',
  }),
  jobBenignExitsCount: Object.freeze({
    name: 'dsh.butler.collector.benign_exits', unit: '1', labels: ['job'],
    desc: '累计"让路/未完成"退出次数（计数型；benignExitCodes，不计失败）',
  }),
  // —— domain = alert（告警通道）—————————————————————
  alertCount: Object.freeze({
    name: 'dsh.butler.alert.count', unit: '1', labels: ['source', 'level'],
    desc: '告警条数（本卡用于预算越界告警的累计计数；沿用 v2 §3.7.2 原例名）',
  }),
  // —— domain = action（SLI：自动动作成功率）———————
  // 【2026-10-10 · 冲刺600·补可观测（B3）】v2 方案 §3.7.1「SLI/SLO 清单 8 项」里，
  //   「自动动作成功率」是**数据已现成**的一项（`~\.dsh\butler-auto-actions.json#lastResults`），
  //   原判 3/8 里它一直缺席。本卡**只补这一项**（不铺 8 项 —— 其余七项缺的是采集面，不是命名）。
  autoActionSuccessRatio: Object.freeze({
    name: 'dsh.butler.action.success_ratio', unit: '1', labels: ['window', 'source'],
    desc: '自动动作成功率 = executed ÷(executed + failed)（窗口 = butler-auto-actions.json#lastResults 环形缓冲；dry-run 与未落 status 的行不计入分母）',
  }),
});

/**
 * token 侧命名表（**OTel GenAI SemConv**，2026-10-10 · B3 补 `gen_ai.*`）。
 *
 * 为什么单开一张表、不塞进 `NAMED_METRICS`：
 *   · 前缀不同（`gen_ai.` vs `dsh.butler.`）—— 混一张表会让"全表都合规三段式"的断言失效；
 *   · 依据不同（GenAI SemConv 是**上游约定**，不是本方案 §3.7.2 自定口径），出处要分开可核。
 * 与 `dsh.butler.*` **同一套纪律**：集中登记 + 正则断言 + 出处注释 + 不合规一律不落盘。
 *
 * ⚠️ `semconv` 字段 = 上游**原名**（点分四段，如 `gen_ai.client.token.usage`）。
 *   本机落盘名按项目既有三段式规整（`gen_ai.<domain>.<metric>`）—— 两名字都留着，
 *   将来真接 OTel SDK 导出时按 `semconv` 字段映射即可，**不靠记忆转述**。
 */
export const GENAI_METRIC_PREFIX = 'gen_ai.';

/** token 侧命名规则（三段式，与 `dsh.butler.*` 同款；四段原名只在 `semconv` 字段里出现）。 */
export const GENAI_METRIC_NAME_RE = /^gen_ai\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export const GENAI_METRICS_SOURCE = 'OTel GenAI Semantic Conventions（metrics：gen_ai.client.token.usage / gen_ai.client.operation.duration）';

export const GENAI_METRICS = Object.freeze({
  tokenUsage: Object.freeze({
    name: 'gen_ai.client.token_usage', unit: '1', labels: ['gen_ai.token.type', 'gen_ai.request.model'],
    semconv: 'gen_ai.client.token.usage',
    desc: 'LLM token 用量（`gen_ai.token.type` = input|output；口径 = GenAI SemConv，值来自 token 采集脚本的输出）',
  }),
  operationDuration: Object.freeze({
    name: 'gen_ai.client.operation_duration', unit: 'ms', labels: ['gen_ai.operation.name', 'gen_ai.request.model'],
    semconv: 'gen_ai.client.operation.duration',
    desc: 'LLM 调用耗时（口径 = GenAI SemConv；本机目前只有 token 侧有采集，此条为将来接耗时采集的**落位**，无数据时不产样本）',
  }),
});

/** 档位缺省预算（**方案原文口径**，不要改小：§3.7.5「轻量 <2 s / 重量 <10 s」）。 */
export const BUDGET_DEFAULTS = Object.freeze({ light: 2_000, heavy: 10_000 });

/**
 * per-job 实测标定覆盖值（ms）—— 见文件头「预算标定口径」。
 * ⚠️ 这些不是"业务阈值"，是**观测基线**：超了只记录一行，不改任何行为。回填时机 = 实测分布变了就重标。
 */
export const JOB_BUDGET_OVERRIDES = Object.freeze({
  'auto-heal': 60_000,        // p95 35.1s（自修复 60min 一档，真跑检查）
  'board-line-archive': 90_000, // p95 46.8s（含 exit-1 失败轮）
  'card-watchdog': 5_000,     // p95 2.8s
  'ctx-guard': 5_000,         // p95 2.9s
  daily: 180_000,             // 日报生成（p95 80.2s · 样本少，留足余量）
  'dup-cards-merge': 15_000,  // p95 8.6s
  'evidence-precheck': 15_000, // p95 8.8s
  external: 45_000,           // p95 28.2s（外部源 fetch）
  'memory-distill': 60_000,   // p95 30.8s
  'memory-snapshot': 180_000, // p95 99.0s（记忆库热采 + git）
  'memory-sync': 120_000,     // 跨机记忆同步（取快照+合并+投递+向量）：实测空转轮 7.6s / 并发撞锁轮 13.7s；
                              //   首次向量全量另计 ~102s（626 条基准）⇒ 按 class-default 的 10s 会天天误报
  'memory-vectors': 30_000,   // p95 16.4s（编码桥）
  'night-stop-audit': 10_000, // p95 5.0s
  'overnight-guard': 30_000,  // p95 14.4s
  'p0-auto-restart': 5_000,   // p95 2.0s
  'p5-auto-rollback': 5_000,  // p95 2.1s
  pitfall: 20_000,            // p95 10.3s（P4 扫描）
  queue: 5_000,               // p95 2.6s
  reconcile: 10_000,          // p95 3.7s（日对账）
  relay: 8_000,               // p95 3.7s
  restart: 180_000,           // 真重启含等待（实测 max 132s）—— 长是语义，不是故障
  tidy: 60_000,               // p95 17.5s
  token: 60_000,              // p95 13.3s（n=1，首跑口径）
  'upgrade-patrol': 30_000,   // p95 1.1s，但可能真跑预检（留余量）
  upstream: 30_000,           // p95 7.6s
  watch: 90_000,              // p95 28.0s（5min 档重活）
  watchfs: 60_000,            // p95 33.4s
});

/** 超预算告警冷却（同一 job 冷却期内只写一条 —— 没有它，"只记录"会退化成刷屏）。 */
export const BUDGET_ALERT_COOLDOWN_MS = 30 * 60_000;

/** 顶层 `state.metrics.budgetOver` 环形台账上限（最近 N 条，防状态文件无界增长）。 */
export const BUDGET_OVER_KEEP = 5;

/** EWMA 平滑系数（观测摘要用；越小越迟钝）。 */
export const EWMA_ALPHA = 0.3;

/**
 * 指标名是否合规：`dsh.butler.*` 三段式 **或** `gen_ai.*` 三段式。
 * （两域都要求严格三段式 ⇒ 放宽的只是"域名"，不是"形状"；不合规照样进不了状态文件。）
 */
export function isValidMetricName(name) {
  return typeof name === 'string' && (METRIC_NAME_RE.test(name) || GENAI_METRIC_NAME_RE.test(name));
}

/** token 侧名字是否合规（单独暴露，便于断言/报告分别统计两域）。 */
export function isValidGenAiMetricName(name) {
  return typeof name === 'string' && GENAI_METRIC_NAME_RE.test(name);
}

/** 命名表全部名字（单测/报告用；**只含 `dsh.butler.*` 域**，token 域走 allGenAiMetricNames）。 */
export function allMetricNames() {
  return Object.values(NAMED_METRICS).map((m) => m.name);
}

/** token 侧全部名字（`gen_ai.*` 域）。 */
export function allGenAiMetricNames() {
  return Object.values(GENAI_METRICS).map((m) => m.name);
}

/**
 * 档位判定（纯函数）：日历型（`at`）或间隔 ≥30 分钟 → 重量；其余 → 轻量。
 * 口径依据 = v2 §3.7.5 的「轻量 <2s / 重量 <10s（30 min 一次）」（30 分钟那一档就是重量档）。
 */
export function budgetClassForJob(job) {
  if (!job) return 'light';
  if (job.at) return 'heavy';
  const iv = Number(job.intervalMs);
  if (Number.isFinite(iv) && iv >= 30 * 60_000) return 'heavy';
  return 'light';
}

/**
 * 该 job 的名义预算。
 * @param {{id?:string, at?:string, intervalMs?:number, budgetMs?:number}} job
 * @returns {{budgetMs:number, class:'light'|'heavy', source:'override'|'job-field'|'class-default'}}
 */
export function budgetForJob(job) {
  const cls = budgetClassForJob(job);
  const id = job?.id;
  // ① job 自己声明（注册表里直接写 budgetMs 的 job 优先 —— 显式语义压过标定值）
  const own = Number(job?.budgetMs);
  if (Number.isFinite(own) && own > 0) return { budgetMs: own, class: cls, source: 'job-field' };
  // ② 实测标定覆盖值
  const ov = Number(JOB_BUDGET_OVERRIDES[id]);
  if (Number.isFinite(ov) && ov > 0) return { budgetMs: ov, class: cls, source: 'override' };
  // ③ 档位缺省（= 方案原文口径；未观测过的 job 走这条，首跑实测后回填）
  return { budgetMs: BUDGET_DEFAULTS[cls], class: cls, source: 'class-default' };
}

/**
 * 预算判定（纯函数）：`durationMs > budgetMs` 才算超界（**等于不算** —— 恰好卡在预算上是合规）。
 * @returns {{budgetMs:number, class:string, source:string, exceeded:boolean, ratio:number|null}}
 */
export function judgeBudget(job, durationMs) {
  const b = budgetForJob(job);
  // ⚠️ 判"有没有真耗时"必须先看**原始值**：`Number(null)` 是 0、`Number('')` 也是 0
  //    ⇒ 直接拿 Number() 判会把手滑传进来的 null 当成"耗时 0ms"（假合规，掩盖上游 bug）。
  const raw = durationMs;
  const d = Number(raw);
  const ok = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(d) && d >= 0;
  return {
    ...b,
    exceeded: ok ? d > b.budgetMs : false,
    ratio: ok && b.budgetMs > 0 ? Number((d / b.budgetMs).toFixed(3)) : null,
  };
}

/** 指数滑动平均（prev 缺失/非数 → 直接用 next 起头）。 */
export function ewma(prev, next, alpha = EWMA_ALPHA) {
  const n = Number(next);
  if (!Number.isFinite(n)) return Number.isFinite(Number(prev)) ? Number(prev) : null;
  const p = Number(prev);
  if (!Number.isFinite(p)) return n;
  return Number((p * (1 - alpha) + n * alpha).toFixed(1));
}

/**
 * 耗时摘要（**滑动窗口的紧凑形态**：EWMA + max + count，不存明细环 —— 状态文件增长受 §3.7.5 预算约束）。
 * @param {object|null} prev 上一轮 `jobs.<id>.durationSummary`
 * @param {number} durationMs
 * @param {string} at ISO 时刻
 */
export function durationSummary(prev, durationMs, at) {
  const d = Number(durationMs);
  const p = prev && typeof prev === 'object' ? prev : {};
  return {
    last: Number.isFinite(d) ? d : null,
    ewma: ewma(p.ewma, d),
    max: Number.isFinite(Number(p.max)) ? Math.max(Number(p.max), Number.isFinite(d) ? d : 0) : (Number.isFinite(d) ? d : null),
    count: (Number(p.count) || 0) + 1,
    at: at ?? null,
  };
}

/**
 * 预算累计记账（**只读观察，不改行为**）。
 * @param {object|null} prevBudget 上一轮 `jobs.<id>.budget`
 * @param {object} verdict `judgeBudget()` 的结果
 * @param {string} at ISO 时刻
 * @param {number} durationMs 本次实测耗时（越界时留档，人回看时不必翻日志）
 */
export function budgetLedger(prevBudget, verdict, at, durationMs) {
  const p = prevBudget && typeof prevBudget === 'object' ? prevBudget : {};
  const exceededNow = verdict?.exceeded === true;
  return {
    ms: verdict?.budgetMs ?? null,
    class: verdict?.class ?? null,
    source: verdict?.source ?? null,
    exceeded: exceededNow,
    ratio: verdict?.ratio ?? null,
    exceededCount: (Number(p.exceededCount) || 0) + (exceededNow ? 1 : 0),
    lastExceededAt: exceededNow ? (at ?? null) : (p.lastExceededAt ?? null),
    lastAlertAt: p.lastAlertAt ?? null,
    lastDurationMs: exceededNow ? (Number.isFinite(Number(durationMs)) ? Number(durationMs) : (p.lastDurationMs ?? null)) : (p.lastDurationMs ?? null),
  };
}

/** 冷却判定：该不该为这次越界写告警（同 job 冷却期内不重复写）。 */
export function shouldAlertBudget(prevBudget, now = Date.now(), cooldownMs = BUDGET_ALERT_COOLDOWN_MS) {
  const last = Date.parse(prevBudget?.lastAlertAt ?? '');
  if (!Number.isFinite(last)) return true;
  return now - last >= cooldownMs;
}

/**
 * 预算越界告警文案 —— 按 v2 §3.7.6「告警可执行性模板」四段式：
 *   现象 / 影响 / 建议动作 / 依据（缺任一段视为不合格告警）。
 */
export function budgetAlertText(job, { durationMs, budgetMs, class: cls, ratio, source }) {
  const sec = (ms) => `${(Number(ms) / 1000).toFixed(1)}s`;
  return `现象：tick job \`${job?.id ?? '?'}\` 单次耗时 ${sec(durationMs)} 超预算 ${sec(budgetMs)}（${ratio ?? '?'}×）`
    + ` ｜ 影响：管家采集偏慢（不影响 DSH 主程序；仅当日志增长/机器变忙时可能叠加）`
    + ` ｜ 建议动作：看 \`%TEMP%\\dsh-butler-tickd\\state.json\` 的 \`jobs.${job?.id ?? '?'}.durationSummary\` 与 \`budget\`，`
    + `必要时人工调 \`JOB_BUDGET_OVERRIDES.${job?.id ?? '?'}\` 或查该 job 脚本 ｜ `
    + `依据：v2 方案 §3.7.5 单次 tick 耗时预算（档位 ${cls} / 来源 ${source}）· 指标 ${NAMED_METRICS.jobDurationMs.name}`;
}

/**
 * 生成该 job 的**命名指标样本**（供落 `state.metrics.jobs.<id>`）。
 * 只产出有真值的指标（runs/failures 恒有；benign_exits 只在该 job 声明过让路码时产出）。
 *
 * @param {{job:object, durationMs:number, status:string, at:string, runs:number, failures:number,
 *          benignExits?:number|null, verdict:object}} o
 * @returns {Record<string, {unit:string, value?:number, last?:number, ewma?:number, max?:number, count?:number, at?:string, labels:object}>}
 */
export function buildJobMetricSamples({ job, durationMs, status, at, runs, failures, benignExits = null, verdict, via = null }) {
  const out = {};
  const put = (key, sample) => { out[NAMED_METRICS[key].name] = { ...sample, unit: NAMED_METRICS[key].unit }; };
  put('jobDurationMs', { last: Number(durationMs), at, labels: { job: job?.id ?? null, status: status ?? null, via } });
  put('jobBudgetMs', { value: verdict?.budgetMs ?? null, labels: { job: job?.id ?? null, class: verdict?.class ?? null } });
  put('jobBudgetExceededCount', { value: Number(verdict?.exceededCount ?? 0), labels: { job: job?.id ?? null } });
  put('jobRunsCount', { value: Number(runs) || 0, labels: { job: job?.id ?? null } });
  put('jobFailuresCount', { value: Number(failures) || 0, labels: { job: job?.id ?? null } });
  if (benignExits !== null) put('jobBenignExitsCount', { value: Number(benignExits) || 0, labels: { job: job?.id ?? null } });
  return out;
}

/**
 * 把本轮 job 的指标样本并进顶层 `state.metrics`（**紧凑、有界**）：
 *   · 每个 job 只留**最新值**（duration 带 last/ewma/max/count —— 不存明细环，防状态文件无界增长）；
 *   · `budgetOver` 是最近 `BUDGET_OVER_KEEP` 条越界台账（给人看的"什么时候、超了多少"）。
 * @returns {object} 新的 metrics 对象（不可变风格：不改入参）
 */
export function mergeMetrics(stateMetrics, jobId, samples, { now = Date.now(), overEntry = null, alertSent = false } = {}) {
  const prev = stateMetrics && typeof stateMetrics === 'object' ? stateMetrics : {};
  const jobs = { ...(prev.jobs ?? {}) };
  const prevJob = jobs[jobId] && typeof jobs[jobId] === 'object' ? jobs[jobId] : {};
  const nextJob = { ...prevJob };
  for (const [name, s] of Object.entries(samples ?? {})) {
    if (!isValidMetricName(name)) continue;            // 不合规的名字一律不落盘（防口径漂移）
    const before = nextJob[name] ?? {};
    nextJob[name] = {
      unit: s.unit,
      labels: s.labels ?? before.labels ?? null,
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.last !== undefined ? { last: s.last, ewma: ewma(before.ewma, s.last), max: Math.max(Number(before.max) || 0, Number(s.last) || 0), count: (Number(before.count) || 0) + 1, at: s.at ?? null } : {}),
    };
  }
  jobs[jobId] = nextJob;

  const prevOver = Array.isArray(prev.budgetOver) ? prev.budgetOver : [];
  const budgetOver = overEntry ? [...prevOver, overEntry].slice(-BUDGET_OVER_KEEP) : prevOver;
  // 告警计数（`dsh.butler.alert.count`）落**顶层**（不是 job 级）—— 它统计的是"预算越界告警通道"本身
  const prevAlerts = prev.alerts && typeof prev.alerts === 'object' ? prev.alerts : {};
  const alerts = alertSent
    ? { metric: NAMED_METRICS.alertCount.name, unit: '1', count: (Number(prevAlerts.count) || 0) + 1, lastAt: new Date(now).toISOString(), lastJob: jobId }
    : { ...prevAlerts, metric: prevAlerts.metric ?? NAMED_METRICS.alertCount.name, unit: '1', count: Number(prevAlerts.count) || 0 };
  return {
    schemaVersion: 1,
    source: 'butler-tickd',
    naming: `${METRIC_PREFIX}<domain>.<metric>`,
    namingSource: NAMING_SOURCE,
    version: TICKD_METRICS_VERSION,
    updatedAt: new Date(now).toISOString(),
    budget: { defaults: BUDGET_DEFAULTS, overrides: Object.keys(JOB_BUDGET_OVERRIDES).length, cooldownMs: BUDGET_ALERT_COOLDOWN_MS },
    budgetOverCount: (Number(prev.budgetOverCount) || 0) + (overEntry ? 1 : 0),
    budgetOver,
    alerts,
    jobs,
  };
}

/**
 * 【B3 · gap-1-09】自动动作成功率 SLI（**只读纯函数**：不改动作、不写状态）。
 *
 * 数据源 = `~\.dsh\butler-auto-actions.json#lastResults`（环形缓冲，最近 50 条）。
 * 口径（写死在这里，别处不许各算一份）：
 *   分子 = `status === 'executed'`；分母 = executed + `status === 'failed'`；
 *   `dryRun === true` 的行**不进分母**（dry-run 不是"执行失败"，把它算进去会把成功率算假）；
 *   没有 status 的行同样不进分母（宁可窗口小，也不造假值 —— 分母为 0 时 ratio 返回 `null`，
 *   调用方必须显式判 null，**不许把 null 当 0**）。
 *
 * @param {object|null} ledger butler-auto-actions.json 的对象
 * @param {{window?:number}} [opts] window = 只看最近 N 条（默认全部 lastResults）
 */
export function autoActionSuccessSli(ledger, opts = {}) {
  const rows = Array.isArray(ledger?.lastResults) ? ledger.lastResults : [];
  const win = Number(opts.window);
  const slice = Number.isFinite(win) && win > 0 ? rows.slice(-win) : rows;
  const real = slice.filter((r) => r && typeof r === 'object' && r.dryRun !== true);
  const executed = real.filter((r) => r.status === 'executed').length;
  const failed = real.filter((r) => r.status === 'failed').length;
  const denom = executed + failed;
  const byKind = {};
  for (const r of real) {
    const k = String(r.kind ?? 'unknown');
    const e2 = byKind[k] ?? { executed: 0, failed: 0 };
    if (r.status === 'executed') e2.executed += 1;
    else if (r.status === 'failed') e2.failed += 1;
    byKind[k] = e2;
  }
  return {
    metric: NAMED_METRICS.autoActionSuccessRatio.name,
    unit: '1',
    window: slice.length,
    dryRunExcluded: slice.length - real.length,
    excludedNoStatus: real.length - denom,
    executed,
    failed,
    successRatio: denom > 0 ? Number((executed / denom).toFixed(4)) : null,
    byKind,
    source: '~/.dsh/butler-auto-actions.json#lastResults',
    note: 'dry-run 不进分母；分母为 0 ⇒ successRatio=null（不许当 0 读）',
  };
}

/**
 * 【B3 · gap-1-10】token 侧命名指标样本（`gen_ai.*`）。
 *
 * 只产**有真值**的样本：`inputTokens` / `outputTokens` 都没有 ⇒ 返回 `{}`（调用方据此"没数据不落盘"），
 * 绝不落 0 假装采到了。`operationDurationMs` 同理（本机当前无耗时采集 ⇒ 通常不产）。
 *
 * @param {{inputTokens?:number|null, outputTokens?:number|null, model?:string|null,
 *          operationName?:string|null, operationDurationMs?:number|null,
 *          at?:string|null, source?:string|null}} o
 */
export function buildTokenMetricSamples(o = {}) {
  const out = [];
  const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const labels = { 'gen_ai.request.model': o.model ?? null };
  const inp = num(o.inputTokens);
  const outp = num(o.outputTokens);
  if (inp !== null) {
    out.push({ name: GENAI_METRICS.tokenUsage.name, unit: GENAI_METRICS.tokenUsage.unit, value: inp, at: o.at ?? null, source: o.source ?? null, labels: { ...labels, 'gen_ai.token.type': 'input' } });
  }
  if (outp !== null) {
    out.push({ name: GENAI_METRICS.tokenUsage.name, unit: GENAI_METRICS.tokenUsage.unit, value: outp, at: o.at ?? null, source: o.source ?? null, labels: { ...labels, 'gen_ai.token.type': 'output' } });
  }
  const dur = num(o.operationDurationMs);
  if (dur !== null) {
    out.push({ name: GENAI_METRICS.operationDuration.name, unit: GENAI_METRICS.operationDuration.unit, value: dur, at: o.at ?? null, source: o.source ?? null, labels: { ...labels, 'gen_ai.operation.name': o.operationName ?? null } });
  }
  return out;
}

/** 只读自检（供 --status / 报告用）：命名表合规性 + 覆盖了几个 job。 */
export function metricsSelfCheck() {
  const names = allMetricNames();
  const genai = allGenAiMetricNames();
  const bad = names.filter((n) => !isValidMetricName(n));
  const badGenai = genai.filter((n) => !isValidGenAiMetricName(n));
  return {
    version: TICKD_METRICS_VERSION,
    namingSource: NAMING_SOURCE,
    metrics: names.length,
    invalid: bad,
    genai: { metrics: genai.length, names: genai, invalid: badGenai, source: GENAI_METRICS_SOURCE },
    overrides: Object.keys(JOB_BUDGET_OVERRIDES).length,
    defaults: BUDGET_DEFAULTS,
    cooldownMs: BUDGET_ALERT_COOLDOWN_MS,
    sourceFile: fileURLToPath(import.meta.url),
    ok: bad.length === 0 && badGenai.length === 0,
  };
}

// 供 CLI/报告直接打印命名表（`node lib\tickd-metrics.mjs`）
function isMainEntry() {
  try {
    const a = path.resolve(fileURLToPath(import.meta.url));
    const b = path.resolve(process.argv[1] ?? '');
    return a === b;
  } catch { return false; }
}
if (isMainEntry()) {
  console.log(JSON.stringify({ selfCheck: metricsSelfCheck(), named: NAMED_METRICS }, null, 1));
}
