// dsh-butler / lib/slo-tail.mjs —— v2 方案 §3.7「可观测性 SLO」**尾部 SLI** 的只读采集器（候选态）
//
// 【缺口原文】（主档 `docs/` §1 **A 域** `可观测性 SLO` 🟡 = 4/8；
//   2026-10-11 冲刺600 第 32 棒「开发批十二」现场复算）：
//     §3.7.1 八项 SLI 里，真正有采集器的只有
//       ④ 管家数据新鲜度(asOf) · ⑤⑥ 误报率 · ⑦ 自动动作成功率（`lib\tickd-metrics.mjs#autoActionSuccessSli`）；
//     **① 守护鱼可用率 / ② dsh 服务可用率 / ③ 会话成功率 / ⑧ 回滚成功率 一项采集器都没有**。
//     §3.7.5「管家常驻内存 <50MB（测量方式 = 进程采样）」同样零采样（`memoryUsage|rss|heapUsed` 在
//     `butler-tickd.mjs` 全库 0 命中）。
//
// 【本模块定位 = **候选态**】**零接线**：不改 `butler-tickd.mjs`、不改 `lib\tickd-metrics.mjs`、不改任何既有文件；
//   本文件只被 `_test\test-slo-tail.mjs` 与只读 CLI `butler-slo-tail.mjs` 调用
//   ⇒ **本夜不生效**（生产 tick/闸门/日报行为一字不变，接线留给后续生产卡）。
//   📌 **订正注（2026-10-14 · 卡「封口①-A域」执行会话 · 只加注、不改上文一字）**：
//      **§5 `memorySample()` / `judgeMemoryBudget()` 已接线生产** —— 消费点 = `butler-tickd.mjs#buildTickObservability()`
//      （`serve()` 主循环**每轮**调用；⚠️ 采样对象 = 调用者进程，**必须**在 tickd 进程内调，理由见 §5 头注本身），
//      落 `%TEMP%\dsh-butler-tickd\state.json#memory`（含 rss/heap + 预算判定 `budgetOk`/`ratio`）。
//      ⇒ 上文「零接线 / 本夜不生效」**对"内存采样"这一项已过期**；**其余尾部 SLI（①②③⑧）仍零接线**，
//      「候选态」定位对其余部分继续成立。判据 = `state.json#memory` 的现跑读数（见
//      `docs/` §A3）。接线动因 = 主档 A 域 `采集开销预算` 行缺口之一
//      「内存有代码未接线」。
//
// 【三条纪律】
//   ① **只读**：除 `writeSampleLedger()`（显式调用才写、生产路径当前无人调用）外全部函数无副作用。
//   ② **算不出就 null + reason，绝不造假值**（沿用既有「不显假值」口径：分母为 0 / 无源 ⇒ 返回 null 而不是 1.0）。
//   ③ **口径写进返回值 `basis`**：凡与方案 §3.7.1 原文口径不一致的（如"会话文件健康率"），
//      必须 `conformsToPlan:false` + 说明，防下游当成方案口径用。
//
// 出处：2026-10-11 · 冲刺600 · 卡「开发批十二」A 域 17 项非✅ · 缺口 = ①②③⑧ + §3.7.5 内存采样。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, butlerPaths, monthKey } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { appendStateText } from './dual-write.mjs';

export const SLO_TAIL_VERSION = '0.1.0';
export const SLO_TAIL_SCHEMA = 1;

/**
 * §3.7.5 预算：管家常驻内存。
 *
 * 【R-031 口径校准 · 2026-10-19】原口径 = 绝对 RSS < 50 MB（单阈值）。
 *   现跑实测（<host> · node v24.19.0）：**裸 node 空进程 RSS 即 56.5~57.3 MiB**
 *   （`node -p process.memoryUsage().rss` × 3 = 59,219,968 / 59,195,392 / 59,252,736 B；带 probe 的进程 60,059,648 B）
 *   ⇒ 60.4 MiB 的 tickd 里**大头是平台地板**，那条 50 MB 阈值对任何 tickd 都不可满足、且永远 🔴 = 没有信号。
 *   复跑封口：`node <butler-root>\tools\dsh-butler\mem-floor-probe.mjs`（只读，打 N 个裸 node 的 RSS 中位数）。
 *   现口径 = **平台地板（可现跑复现）+ 进程增量预算**：
 *     budgetOk ⇔ rss ≤ 地板 + 增量预算（**等于不算超**，语义与旧口径一致）
 *   现跑对照（2026-10-19 10:50 重启后 30s×12 轮）：tickd rss **70.3~75.1 MiB**（稳态 ~72~73）
 *      首轮冷启动峰值 **78.7 MiB**（registry 自检 554 项 + 首轮全量采集把 heapTotal 顶到 32 MiB，
 *      3 分钟内 V8 memory reducer 收回 14.9 MiB，RSS 同步回落到 73.7；**RSS 对 heapTotal 有 demand-page 依赖，非线性**）
 *      ⇒ 增量预算取 **24 MiB**（上限 82 MiB = 78.7 峰值 + ~3.3 MiB 抖动余量；
 *        RSS 单点抖动 ±3 MiB 来自 GC / 工作集修剪，**判泄漏看 deltaRatio 趋势，不看单点**）。
 *      budgetOk=true；**真泄漏仍会被抓**（增量越界即 🔴 / deltaRatio>1）。
 *   地板可用 env `DSH_TICKD_MEM_FLOOR_BYTES` 覆盖：换机 / 换 node 大版本后按探针重测再改。
 *   归因证据（300 轮 churn retained Δ0.00 MiB、无无限增长数组）见
 *   `docs/`。
 */
export const MEMORY_FLOOR_BYTES = (() => {
  const v = Number(process.env.DSH_TICKD_MEM_FLOOR_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 58 * 1024 * 1024;
})();
/** 进程增量预算：地板之上允许的常驻增量（模块图 + tickd 状态 + V8 堆高水位 + 冷启动峰值余量）。 */
export const MEMORY_DELTA_BUDGET_BYTES = 24 * 1024 * 1024;
/** 总预算 = 地板 + 增量（保留旧名，既有消费面 `MEMORY_BUDGET_BYTES` 语义不变）。 */
export const MEMORY_BUDGET_BYTES = MEMORY_FLOOR_BYTES + MEMORY_DELTA_BUDGET_BYTES;

/** 守护鱼探测周期（`guard2.log` 启动行自陈 `check 2000ms`）—— 仅用于说明采样密度，不参与判定。 */
export const DEFAULT_PROBE_INTERVAL_MS = 2000;

/** 【2c-B2】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, opts = {}) {
  return resolveStatePath(name, { home: opts.home ?? dshHome() }).path;
}
/** 采集台账（**append-only JSONL**；本模块默认不写，只有显式 `writeSampleLedger()` 才落盘）。 */
export const SLI_SAMPLE_FILE = 'butler-sli-samples.jsonl';

/** 审计流水目录里的月份文件键（默认最近 2 个月）。 */
export function defaultMonthKeys(now = Date.now()) {
  return [monthKey(now), monthKey(now - 31 * 86_400_000)];
}

// ───────────────────────── §1 日志解析（守护鱼 guard2.log · 纯函数）─────────────────────────

/** 行首本地时间戳 `[YYYY-MM-DD HH:MM:SS]` → epoch ms（**本地时区**，guard 日志写的就是本地时间）。 */
const LOG_TS_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/;
export function parseLogTime(line) {
  const m = LOG_TS_RE.exec(String(line ?? ''));
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 事件分类表（顺序敏感：先窄后宽）。 */
export const GUARD_EVENT_KINDS = Object.freeze([
  { kind: 'probe-fail', re: /STUCK\?.*HTTP probe failed/i },
  { kind: 'probe-ok', re: /OK: HTTP probe healthy again/i },
  { kind: 'tickd-down', re: /TICKD-WATCH: down/i },
  { kind: 'tickd-alive', re: /TICKD-WATCH: alive/i },
  { kind: 'guard-start', re: /DSH Guard 2\.0 started/i },
  { kind: 'guard-exit', re: /GUARD EXIT|guard-exit|EXIT: guard/i },
  { kind: 'kill', re: /force-kill|killing dsh|killing dsi/i },
]);

/**
 * 解析守护鱼日志 → 事件序列（只读纯函数）。
 * @returns {{events:Array<{at:number,kind:string,line:number}>, counts:object, first:number|null, last:number|null, lines:number}}
 */
export function parseGuardLog(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const events = [];
  const counts = {};
  let firstLine = null;
  let lastLine = null;
  lines.forEach((l, i) => {
    const at = parseLogTime(l);
    if (at === null) return;
    if (firstLine === null) firstLine = at;
    lastLine = at;
    for (const e of GUARD_EVENT_KINDS) {
      if (e.re.test(l)) {
        events.push({ at, kind: e.kind, line: i + 1 });
        counts[e.kind] = (counts[e.kind] ?? 0) + 1;
        break;
      }
    }
  });
  events.sort((a, b) => a.at - b.at);
  return { events, counts, first: firstLine, last: lastLine, lines: lines.length };
}

// ───────────────────────── §2 可用率（纯函数 · ① ②）─────────────────────────

function overlapMs(aFrom, aTo, bFrom, bTo) {
  const lo = Math.max(aFrom, bFrom);
  const hi = Math.min(aTo, bTo);
  return hi > lo ? hi - lo : 0;
}

/**
 * 可用率 = `1 − 异常分钟 ÷ 总分钟`（方案 §3.7.1 ① ② 定义，**排除维护窗口**）。
 *
 * 输入 = 事件序列（`parseGuardLog().events` 或调用方自造的采样序列），
 * `downKinds` 进入异常态、`upKinds` 退出异常态；窗口结束时仍处于异常态 ⇒ 计到窗口末。
 *
 * ⚠️ **诚实边界**：这是**按日志事件重建的估计值**，不是秒级真值 ——
 *   守护鱼只在**状态变化**时写日志（探测周期 2s），故异常区间 = 「首次失败 → 恢复通知」，
 *   期间真实恢复时刻可能早于恢复通知。返回值 `basis` 里写明这一点。
 *
 * @returns {{value:number|null, windowMs:number, downMs:number, downs:Array, basis:string, reason?:string, samples:number}}
 */
export function computeAvailability(events, opts = {}) {
  const downKinds = opts.downKinds ?? ['probe-fail'];
  const upKinds = opts.upKinds ?? ['probe-ok'];
  const all = (events ?? []).filter((e) => e && Number.isFinite(e.at));
  const evs = all
    .filter((e) => downKinds.includes(e.kind) || upKinds.includes(e.kind))
    .slice()
    .sort((a, b) => a.at - b.at);

  const basisBase = `口径 = 1 − 异常分钟 ÷ 总分钟（v2 方案 §3.7.1，排除维护窗口）· 异常区间 = [${downKinds.join('|')}] → [${upKinds.join('|')}] · 源 = 守护鱼日志事件重建（状态变化才写日志，非秒级真值）`;
  // 窗口：优先显式 from/to；否则退回事件首末（`*FromLog` 会传日志首末**行**时间，比事件跨度更贴近真实观测期）
  const evFirst = evs.length ? evs[0].at : (all.length ? Math.min(...all.map((e) => e.at)) : null);
  const evLast = evs.length ? evs[evs.length - 1].at : (all.length ? Math.max(...all.map((e) => e.at)) : null);
  const from = Number.isFinite(opts.from) ? opts.from : evFirst;
  const to = Number.isFinite(opts.to) ? opts.to : evLast;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) {
    return { value: null, windowMs: 0, downMs: 0, downs: [], basis: basisBase, reason: evs.length ? 'empty-window' : 'no-events-no-window', samples: 0 };
  }
  const windowMs = to - from;
  if (!evs.length) {
    // 窗口有效 + 零异常事件 ⇒ **可用率 1.0**（不是 null：零异常就是零异常）；`reason` 让下游能看出"零事件"这件事
    return { value: 1, windowMs, downMs: 0, downs: [], basis: basisBase, reason: 'no-down-events', samples: 0 };
  }

  const downs = [];
  let open = null;
  for (const e of evs) {
    if (downKinds.includes(e.kind) && open === null) open = e.at;
    else if (upKinds.includes(e.kind) && open !== null) { downs.push({ from: open, to: e.at, ms: e.at - open, closed: true }); open = null; }
  }
  if (open !== null) downs.push({ from: open, to, ms: Math.max(0, to - open), closed: false });

  const maint = (opts.maintenanceWindows ?? []).filter((w) => w && Number.isFinite(w.from) && Number.isFinite(w.to));
  let downMs = 0;
  for (const d of downs) {
    let ms = overlapMs(d.from, d.to, from, to);
    for (const w of maint) ms -= overlapMs(Math.max(d.from, from), Math.min(d.to, to), w.from, w.to);
    downMs += Math.max(0, ms);
  }
  const openDowns = downs.filter((d) => !d.closed);
  const value = Math.max(0, Math.min(1, 1 - downMs / windowMs));
  return {
    value: Number(value.toFixed(6)),
    windowMs,
    downMs,
    downs: downs.map((d) => ({ ...d, inWindowMs: overlapMs(d.from, d.to, from, to) })),
    openDown: openDowns.length > 0,
    openDownMs: openDowns.reduce((s, d) => s + Math.max(0, overlapMs(d.from, d.to, from, to)), 0),
    basis: basisBase + ` · 维护窗口 ${maint.length} 个（已扣除）`
      + (openDowns.length ? ` · ⚠️ 含 ${openDowns.length} 段**未闭合**异常区间（按窗口末截断 ⇒ 可能**低估**不可用时长；要准必须把窗口末设为「现在」）` : ''),
    samples: evs.length,
  };
}

/** ② dsh 服务可用率（方案 §3.7.1：3080 可连比例）—— 由守护鱼 HTTP 探测事件重建。 */
export function dshAvailabilityFromLog(text, opts = {}) {
  const parsed = opts.parsed ?? parseGuardLog(text);
  const win = { from: opts.from ?? parsed.first, to: opts.to ?? parsed.last };
  return { ...computeAvailability(parsed.events, { ...opts, ...win, downKinds: ['probe-fail'], upKinds: ['probe-ok'] }), source: 'guard2.log#HTTP probe' };
}

/**
 * ① 守护鱼可用率（方案 §3.7.1）—— 由「守护鱼进程退出 → 重新拉起」事件重建。
 * ⚠️ 守护鱼日志不以停机为目的写事件 ⇒ 若全窗口内没有 `kill|guard-exit` 事件，
 *    本函数**不返回 1.0**（那会把"没记录"说成"没停机"），而是 `reason:'insufficient-events'`。
 */
export function guardAvailabilityFromLog(text, opts = {}) {
  const parsed = opts.parsed ?? parseGuardLog(text);
  const downHits = parsed.events.filter((e) => e.kind === 'kill' || e.kind === 'guard-exit').length;
  const upHits = parsed.events.filter((e) => e.kind === 'guard-start').length;
  const win = { from: opts.from ?? parsed.first, to: opts.to ?? parsed.last };
  const r = computeAvailability(parsed.events, { ...opts, ...win, downKinds: ['kill', 'guard-exit'], upKinds: ['guard-start'] });
  if (downHits === 0 && upHits <= 1) {
    return {
      ...r,
      value: null,
      reason: 'insufficient-events',
      source: 'guard2.log#guard lifecycle',
      basis: `${r.basis} · ⚠️ 本窗口内 kill/guard-exit ${downHits} 条、guard-start ${upHits} 条 ⇒ 无法区分「守护鱼从未停」与「停了但没写日志」`,
    };
  }
  return { ...r, source: 'guard2.log#guard lifecycle' };
}

// ───────────────────────── §3 会话成功率（③ · 只做纯函数 + 保守装配）─────────────────────────

/**
 * ③ 会话成功率（方案 §3.7.1：正常收尾会话 ÷ 总会话 ≥95%/周）。
 * 输入 = 每会话的收尾结论记录 `{sessionId, outcome:'ok'|'error'|'interrupted'|'aborted', at}`。
 * 无记录 ⇒ `value:null`（**不返回 1.0**）。
 */
export function sessionSuccessSli(records) {
  const rs = (records ?? []).filter((r) => r && typeof r.outcome === 'string');
  const basis = '口径 = 正常收尾会话 ÷ 总会话 ≥95%/周（v2 方案 §3.7.1 第 3 项）；data 源 = 每会话收尾结论（turn/end 结果）';
  if (!rs.length) return { value: null, ok: 0, total: 0, reason: 'no-records', basis, conformsToPlan: true };
  const ok = rs.filter((r) => r.outcome === 'ok').length;
  return { value: Number((ok / rs.length).toFixed(6)), ok, total: rs.length, basis, conformsToPlan: true };
}

/**
 * ③ 的**保守装配**：从 `~/.dsh/butler-sessions-health.json` 的 `files[].status` 算「会话**文件**健康率」。
 * ⚠️ 这**不是**方案口径的会话成功率 ⇒ 显式 `conformsToPlan:false` + `planValue:null`（需要读会话日志 turn/end，
 *    本模块不做，留给后续卡），避免下游把两者混用。
 */
export function sessionOutcomesFromHealth(health) {
  const files = health && typeof health === 'object' ? (health.files ?? {}) : {};
  const recs = Object.values(files).filter((f) => f && typeof f.status === 'string');
  const basis = '口径 = 会话**文件**健康率（`butler-sessions-health.json#files[].status === "ok"` 占比）· **≠** v2 方案 §3.7.1「正常收尾会话 ÷ 总会话」';
  if (!recs.length) return { value: null, ok: 0, total: 0, reason: 'no-records', basis, conformsToPlan: false, planValue: null, planReason: 'needs-session-turn-end' };
  const ok = recs.filter((r) => r.status === 'ok').length;
  return {
    value: Number((ok / recs.length).toFixed(6)),
    ok,
    total: recs.length,
    basis,
    conformsToPlan: false,
    planValue: null,
    planReason: 'needs-session-turn-end（读会话日志 turn/end，本模块不装配）',
  };
}

// ───────────────────────── §4 回滚成功率（⑧ · 只读审计 + 纯函数）─────────────────────────

/**
 * ⑧ 回滚成功率（方案 §3.7.1：成功回滚 ÷ 需回滚，SLO 100%）。
 * 被显式拒绝（`rejected:true`）的动作不进分母（它没执行 ⇒ 无"回滚结果"可言）。
 */
export function rollbackSuccessSli(records) {
  const rs = (records ?? []).filter((r) => r && typeof r.ok === 'boolean' && r.rejected !== true);
  const basis = '口径 = 成功回滚 ÷ 需回滚，SLO 100%（v2 方案 §3.7.1 第 8 项）；被拒动作（rejected:true）不进分母';
  if (!rs.length) return { value: null, ok: 0, total: 0, reason: 'no-records', basis };
  const ok = rs.filter((r) => r.ok).length;
  return { value: Number((ok / rs.length).toFixed(6)), ok, total: rs.length, basis };
}

/**
 * 只读：从审计流水 `~/.dsh/butler-audit/<YYYY-MM>.jsonl` 取回滚类记录。
 * 命中判据（**只认回滚语义**，不把自愈/重试混进来）：`type === 'p5-auto-rollback'`
 * 或 `type === 'auto-heal' && /rollback/i.test(item|entry)`。
 * 生产当前该动作默认关 ⇒ 大概率返回 0 条（`rollbackSuccessSli` 会如实给 null）。
 */
export function collectRollbackRecords(opts = {}) {
  const home = opts.home ?? dshHome();
  const months = opts.monthKeys ?? defaultMonthKeys(opts.now ?? Date.now());
  const dir = butlerPaths(home).auditDir;
  const records = [];
  const scanned = [];
  for (const mk of months) {
    const f = path.join(dir, `${mk}.jsonl`);
    let text = null;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    scanned.push({ file: f, bytes: Buffer.byteLength(text) });
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let j = null;
      try { j = JSON.parse(line); } catch { continue; }
      if (!j || typeof j !== 'object') continue;
      const isRollback = j.type === 'p5-auto-rollback'
        || (j.type === 'auto-heal' && /rollback/i.test(`${j.item ?? ''} ${j.entry ?? ''}`));
      if (!isRollback) continue;
      records.push({ at: j.at ?? null, type: j.type, item: j.item ?? null, ok: j.ok === true, rejected: j.rejected === true });
    }
  }
  return { records, scannedFiles: scanned.length, scanned };
}

// ───────────────────────── §5 内存采样（§3.7.5）─────────────────────────

/**
 * 进程采样（方案 §3.7.5「测量方式 = 进程采样」）。
 * ⚠️ 观测对象 = **调用者进程**（Node 无法跨进程读 RSS）⇒ 接线后必须**在 tickd 进程内**调用；
 *    从 CLI 调用得到的是 CLI 自己的读数（`subject:'caller-process'` 已标明）。
 */
export function memorySample(usage = null, now = Date.now()) {
  const u = usage ?? process.memoryUsage();
  return {
    at: now,
    subject: 'caller-process',
    rssBytes: u.rss ?? null,
    heapUsedBytes: u.heapUsed ?? null,
    heapTotalBytes: u.heapTotal ?? null,
    externalBytes: u.external ?? null,
    arrayBuffersBytes: u.arrayBuffers ?? null,
  };
}

/**
 * 预算判定（纯函数）：`rss > 总预算` 才算超（**等于不算**，与 tickd-metrics 的预算口径一致）。
 * 总预算 = 平台地板 + 进程增量（见上方 MEMORY_FLOOR_BYTES 头注）；同时给出「地板之上增量」读数，
 * 让真泄漏（增量单调上涨）在**永远不超总预算**的情况下也能被看见（`deltaRatio`）。
 */
export function judgeMemoryBudget(bytes, budget = MEMORY_BUDGET_BYTES) {
  const b = Number(bytes);
  const fin = Number.isFinite(b);
  const ok = fin && b <= budget;
  return {
    ok,
    bytes: fin ? b : null,
    budget,
    ratio: fin && budget > 0 ? Number((b / budget).toFixed(3)) : null,
    floorBytes: MEMORY_FLOOR_BYTES,
    deltaBudgetBytes: MEMORY_DELTA_BUDGET_BYTES,
    overFloorBytes: fin ? b - MEMORY_FLOOR_BYTES : null,
    deltaRatio: fin && MEMORY_DELTA_BUDGET_BYTES > 0
      ? Number(((b - MEMORY_FLOOR_BYTES) / MEMORY_DELTA_BUDGET_BYTES).toFixed(3))
      : null,
    basis: `预算 = 平台地板 ${(MEMORY_FLOOR_BYTES / 1048576).toFixed(0)} MB（裸 node 实测 · 复跑 tools/dsh-butler/mem-floor-probe.mjs）+ tickd 增量 ${(MEMORY_DELTA_BUDGET_BYTES / 1048576).toFixed(0)} MB ＝ ${(budget / 1048576).toFixed(0)} MB（v2 方案 §3.7.5 口径校准 · 2026-10-19 R-031）；指标名 dsh.butler.process.memory_bytes`,
  };
}

// ───────────────────────── §6 采集台账（默认不写 · 候选态）─────────────────────────

export function sliSamplePath(opts = {}) {
  return opts.file ?? stateFileOf(SLI_SAMPLE_FILE, { home: opts.home });
}

/** 只读读台账（容错：坏行跳过，不抛）。 */
export function readSampleLedger(opts = {}) {
  let text = null;
  try { text = fs.readFileSync(sliSamplePath(opts), 'utf8'); } catch { return { samples: [], badLines: 0, file: sliSamplePath(opts) }; }
  const samples = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { samples.push(JSON.parse(line)); } catch { badLines++; }
  }
  return { samples, badLines, file: sliSamplePath(opts) };
}

/**
 * 采一行可用性样本（**写**动作 · 幂等：同一 `atMs` 已存在则跳过）。
 * ⚠️ 生产路径当前**无人调用** ⇒ 本函数的存在不代表台账已启用（接线见后续生产卡）。
 */
export function writeSampleLedger(sample, opts = {}) {
  if (opts.apply !== true) return { written: false, reason: 'dry-run（缺省零写入；需要 { apply: true }）', file: sliSamplePath(opts) };
  const file = sliSamplePath(opts);
  const cur = readSampleLedger({ ...opts, file });
  const atMs = Number(sample?.atMs ?? sample?.at ?? Date.now());
  if (cur.samples.some((s) => Number(s?.atMs ?? s?.at) === atMs)) return { written: false, reason: 'duplicate-atMs', file };
  const row = { atMs, guardUp: sample?.guardUp === true, dshUp: sample?.dshUp === true, source: sample?.source ?? 'unknown' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  appendStateText(SLI_SAMPLE_FILE, JSON.stringify(row) + '\n', {
    home: opts.home, write: (p, t) => fs.appendFileSync(p, t, 'utf8'),
  });
  return { written: true, row, file };
}

/** 采样间隔中位数（台账口径：最后一个样本代表它到"下一个采样点"为止的时段）。 */
export function sampleCadence(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return DEFAULT_PROBE_INTERVAL_MS;
  const gaps = rows.slice(1).map((r, i) => r.at - rows[i].at).filter((g) => g > 0).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : DEFAULT_PROBE_INTERVAL_MS;
}

/** 由台账采样算可用率（采样口径：每行 = 一个时刻的 up/down 二元状态）。 */
export function availabilityFromSamples(samples, opts = {}) {
  const rows = (samples ?? []).filter((s) => s && Number.isFinite(Number(s.atMs ?? s.at)))
    .map((s) => ({ at: Number(s.atMs ?? s.at), guardUp: s.guardUp === true, dshUp: s.dshUp === true }))
    .sort((a, b) => a.at - b.at);
  // 窗口末缺省 = 最后样本 + 采样间隔（否则"末段还在 down"会被截成 0ms ⇒ 低估不可用）
  const win = {
    from: opts.from,
    to: opts.to ?? (rows.length ? rows[rows.length - 1].at + sampleCadence(rows) : undefined),
  };
  const pick = (key) => computeAvailability(
    rows.map((r) => ({ at: r.at, kind: r[key] ? 'up' : 'down' })),
    { ...opts, ...win, downKinds: ['down'], upKinds: ['up'] },
  );
  return { guard: pick('guardUp'), dsh: pick('dshUp'), samples: rows.length, cadenceMs: sampleCadence(rows) };
}

// ───────────────────────── §7 汇总（只读）─────────────────────────

/** 默认守护鱼日志路径（`%TEMP%\dsh-guard\guard2.log`；可覆盖）。 */
export function defaultGuardLogPath() {
  const tmp = process.env.TEMP || process.env.TMP || '';
  return path.join(tmp, 'dsh-guard', 'guard2.log');
}

/**
 * 汇总尾部 SLI 读数（**只读**：读日志 + 读审计 + 读 sessions-health，不写任何东西）。
 * 返回结构供日报/面板消费（本模块不渲染文本、不推送）。
 */
export function sliTailReport(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const out = { at: new Date(now).toISOString(), version: SLO_TAIL_VERSION, home, items: {} };

  // ① ② 守护鱼 / dsh 可用率（同一份日志，两种口径）
  const logPath = opts.guardLog ?? defaultGuardLogPath();
  let logText = null;
  try { logText = fs.readFileSync(logPath, 'utf8'); } catch { logText = null; }
  if (logText === null) {
    out.items.dshAvailability = { value: null, reason: 'log-missing', file: logPath };
    out.items.guardAvailability = { value: null, reason: 'log-missing', file: logPath };
  } else {
    const parsed = parseGuardLog(logText);
    const win = { from: opts.from, to: opts.to };
    out.items.dshAvailability = { ...dshAvailabilityFromLog(logText, { parsed, ...win }), file: logPath };
    out.items.guardAvailability = { ...guardAvailabilityFromLog(logText, { parsed, ...win }), file: logPath };
    out.log = { lines: parsed.lines, events: parsed.events.length, counts: parsed.counts, first: parsed.first, last: parsed.last };
  }

  // ③ 会话成功率
  const healthFile = resolveStatePath('butler-sessions-health.json', { home }).path;
  let health = null;
  try { health = JSON.parse(fs.readFileSync(healthFile, 'utf8')); } catch { health = null; }
  out.items.sessionSuccess = health
    ? { ...sessionOutcomesFromHealth(health), file: healthFile }
    : { value: null, reason: 'health-missing', file: healthFile, conformsToPlan: false };

  // ⑧ 回滚成功率
  const rr = collectRollbackRecords({ home, now, monthKeys: opts.monthKeys });
  out.items.rollbackSuccess = { ...rollbackSuccessSli(rr.records), scannedFiles: rr.scannedFiles, source: 'butler-audit/*.jsonl' };

  // §3.7.5 内存（subject 显式标明 = 调用者进程）
  const mem = memorySample(opts.usage ?? null, now);
  out.items.memory = { ...mem, verdict: judgeMemoryBudget(mem.rssBytes) };

  // 覆盖率（对齐主档「4/8」口径的复算：④⑤⑥⑦ 由既有模块覆盖，本模块补 ①②③⑧）
  out.coverage = {
    total: 8,
    coveredElsewhere: ['freshness-asOf', 'falsePositiveRate', 'falsePositiveRate-guard', 'actionSuccessRatio'],
    coveredByThisModule: ['guardAvailability', 'dshAvailability', 'sessionSuccess', 'rollbackSuccess'],
    extra: ['memory-rss'],
    note: '本模块只补尾部 4 项 + 内存采样；④⑤⑥⑦ 分别见 lib/control-room-verdict.mjs / barewatch-tick.mjs / lib/tickd-metrics.mjs',
  };
  return out;
}

// ───────────────────────── §8 接线出口（面板片 + 日报段 · 2026-10-14 V2.9封口②·W2 备料新增）─────────────────────────
// 【为什么加这一段】A 域 L149/L160（可观测性 SLO / SLI-SLO 清单 8 项）的尾巴 = ①②③⑧ 四项采集器
//   **零接线**（采集实现早在 §1~§7，却没有任何生产/面板/日报消费口）⇒ 本段提供两个**唯一消费出口**：
//     · `sliTailLite()`      → 面板片（瘦载荷，禁全量；见下）
//     · `sliSectionLines()`  → 日报段（文案同源，消费方只 push）
//   口径纪律不变：判定与文案**只在本模块**，消费方（面板片 / 日报）**只渲染、不自算**。

/**
 * 面板片用的**瘦载荷**（只带结论值，不带 `downs` 逐段区间明细）。
 * 为什么另出一个函数：`sliTailReport()` 实测全量 ≈ 27.7 KB（`downs` 区间数组占大头），而面板片有硬字节预算
 * （对照：metrics 片硬 ≤ 2048 B）⇒ 直接塞全量 = 首屏载荷灾难。
 * 只读；不可探测一律 `reason`，**绝不造假值**（沿用本模块三条纪律）。
 *
 * ⚠️ **内存项的口径红线（2026-10-14 W2 备料实测）**：`sliTailReport()` 里的 `memory` 来自
 *   `memorySample()`，它取的是「**调用者进程**」的 RSS ⇒ 在**面板进程（dsh）**里调用 = 报的是
 *   **dsh 的 RSS（实测 159 MB / ratio 3.03）**，与 §3.7.5「管家（tickd）常驻内存 <50 MB」
 *   **根本不是一回事** ⇒ 直接接出去会点亮一个**假 🔴**。
 *   本出口因此**不自行采样**：内存读数只由调用方**显式传入**（面板片传 null = 如实「不可探测」；
 *   日报传 `tickdMemorySample()` 的 tickd 进程真值）。**宁可不显示，也不显示错的。**
 */
export function sliTailLite(opts = {}) {
  const rep = sliTailReport(opts);
  const brief = (x) => ({
    value: x?.value ?? null,
    ok: x?.ok ?? null,
    total: x?.total ?? null,
    reason: x?.reason ?? null,
    source: x?.source ?? null,
    conformsToPlan: x?.conformsToPlan ?? null,
  });
  const ms = opts.memorySample ?? null;
  return {
    ok: true,
    at: rep.at,
    version: rep.version,
    items: {
      guardAvailability: brief(rep.items.guardAvailability),
      dshAvailability: brief(rep.items.dshAvailability),
      sessionSuccess: brief(rep.items.sessionSuccess),
      rollbackSuccess: brief(rep.items.rollbackSuccess),
    },
    memory: (ms && Number.isFinite(ms.rssBytes))
      ? {
        rssBytes: ms.rssBytes,
        heapUsedBytes: ms.heapUsedBytes ?? null,
        at: ms.at ?? null,
        subject: ms.subject ?? null,
        pid: ms.pid ?? null,
        ok: ms.ok ?? ms.budgetOk ?? null,
        ratio: ms.ratio ?? null,
        budgetBytes: ms.budgetBytes ?? null,
        floorBytes: ms.floorBytes ?? null,
        overFloorBytes: ms.overFloorBytes ?? null,
        deltaRatio: ms.deltaRatio ?? null,
        source: ms.source ?? null,
      }
      : null,
    coverage: {
      total: rep.coverage?.total ?? null,
      covered: (rep.coverage?.coveredByThisModule?.length ?? 0) + (rep.coverage?.coveredElsewhere?.length ?? 0),
      byThisModule: rep.coverage?.coveredByThisModule ?? [],
    },
  };
}

/**
 * tickd 进程的内存采样**真值**（唯一权威源 = tickd 自己每轮写下的 `state.json#memory`）。
 * 为什么必须有这个函数：§3.7.5 的判定对象是「**管家进程**（tickd）常驻内存」，
 *   而 `memorySample()` 只能采「调用者进程」⇒ 从面板/日报侧直接调它必然采错对象（见 `sliTailLite` 头注）。
 * 读不到 ⇒ 显式「不可探测 + 原因」，**不回落成调用者进程读数**（宁可空着）。
 */
export function tickdMemorySample(opts = {}) {
  const tmp = process.env.TEMP || process.env.TMP || '';
  const file = opts.file ?? path.join(tmp, 'dsh-butler-tickd', 'state.json');
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: 'tickd 状态文件不可读（不可探测）', file }; }
  const m = j && typeof j === 'object' ? j.memory : null;
  if (!m || !Number.isFinite(m.rssBytes)) return { ok: false, reason: 'tickd 状态文件无 memory 段（不可探测）', file };
  return {
    rssBytes: m.rssBytes,
    heapUsedBytes: m.heapUsedBytes ?? null,
    at: m.at ?? null,
    subject: 'tickd-process',
    pid: m.pid ?? null,
    ok: m.budgetOk ?? null,
    ratio: m.ratio ?? null,
    budgetBytes: m.budgetBytes ?? null,
    floorBytes: m.floorBytes ?? null,
    overFloorBytes: m.overFloorBytes ?? null,
    deltaRatio: m.deltaRatio ?? null,
    source: path.basename(file),
    file,
  };
}

/**
 * 日报段行渲染（**口径/文案同源在本模块**——消费方只 push 这些行，不复制任何统计）。
 * @param {object} lite `sliTailLite()` 的返回值
 * @returns {string[]} markdown 行（**不含**段标题；标题由调用方给）
 */
export function sliSectionLines(lite) {
  const pct = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(2) + '%');
  const it = lite?.items ?? {};
  const g = it.guardAvailability ?? {};
  const d = it.dshAvailability ?? {};
  const s = it.sessionSuccess ?? {};
  const r = it.rollbackSuccess ?? {};
  const lines = [];
  lines.push(`- ① 守护鱼可用率：**${pct(g.value)}**${g.reason ? `（${g.reason}）` : ''} · ② dsh 服务可用率：**${pct(d.value)}**${d.reason ? `（${d.reason}）` : ''}`);
  lines.push(`- ③ 会话成功率：**${pct(s.value)}**（${s.ok ?? '—'}/${s.total ?? '—'}）${s.conformsToPlan === false ? ' ⚠️ 当前是**非方案口径**（会话**文件**健康率），方案口径需读会话 turn/end' : ''} · ⑧ 回滚成功率：**${pct(r.value)}**（${r.ok ?? '—'}/${r.total ?? '—'}）${r.reason ? `（${r.reason}）` : ''}`);
  const m = lite?.memory;
  if (m && Number.isFinite(m.rssBytes)) {
    // 【R-031 · 2026-10-19】预算不再写死 50 MB：总预算 = 平台地板 + 增量（读调用方传进来的真值，
    //   旧 state.json 无该字段时回落到常量；**文案数字必须与判定同源**，不许再出现「判据是 76、文案写 50」）。
    const budMB = Number.isFinite(m.budgetBytes) ? (m.budgetBytes / 1048576).toFixed(0) : (MEMORY_BUDGET_BYTES / 1048576).toFixed(0);
    const floorMB = Number.isFinite(m.floorBytes) ? (m.floorBytes / 1048576).toFixed(0) : (MEMORY_FLOOR_BYTES / 1048576).toFixed(0);
    const deltaMB = Number.isFinite(m.deltaBudgetBytes) ? (m.deltaBudgetBytes / 1048576).toFixed(0) : (MEMORY_DELTA_BUDGET_BYTES / 1048576).toFixed(0);
    const over = Number.isFinite(m.overFloorBytes) ? ` · 地板之上 ${(m.overFloorBytes / 1048576).toFixed(2)} MB（增量预算 ${deltaMB} MB）` : '';
    lines.push(`- §3.7.5 管家常驻内存：**${(m.rssBytes / 1048576).toFixed(1)} MB** / 预算 ${budMB} MB（平台地板 ${floorMB} MB + 增量 ${deltaMB} MB）⇒ ${m.ok ? '达标 ✓' : '超预算 🔴'}${over}（采样对象 = ${m.subject ?? '未知'}${Number.isFinite(m.pid) ? ` pid ${m.pid}` : ''} · 源 = ${m.source ?? '?'}）`);
  } else {
    lines.push('- §3.7.5 管家常驻内存：_（不可探测）_ —— 采样对象必须是 **tickd 进程**；面板/日报侧不自行采样（会把「调用者进程 RSS」错当成「管家常驻」，实测差 2.2×）');
  }
  if (lite?.coverage) lines.push(`- 覆盖率：**${lite.coverage.covered ?? '—'}/${lite.coverage.total ?? '—'}**（本模块补 ${(lite.coverage.byThisModule ?? []).join(' / ')}）；④⑤⑥⑦ 见既有模块`);
  if (lite?.ok !== true) lines.push(`- ⚠️ 采集不可用：${lite?.reason ?? '未知原因'}`);
  return lines;
}

/** 自检（纯函数可跑；不写盘）。 */
export function sliTailSelfCheck() {
  const problems = [];
  const events = [
    { at: 1000, kind: 'probe-fail' },
    { at: 2000, kind: 'probe-ok' },
    { at: 3000, kind: 'other' },
  ];
  const a = computeAvailability(events, { from: 1000, to: 5000 });
  if (a.value !== 0.75) problems.push(`computeAvailability 期望 0.75 实得 ${a.value}`);
  const b = computeAvailability([]);
  if (b.value !== null) problems.push('空事件集且无窗口必须返回 null');
  const b2 = computeAvailability([], { from: 0, to: 1000 });
  if (b2.value !== 1) problems.push('窗口有效 + 零异常事件应返回 1.0（不是 null）');
  const c = rollbackSuccessSli([]);
  if (c.value !== null) problems.push('空回滚记录必须返回 null');
  const d = judgeMemoryBudget(MEMORY_BUDGET_BYTES);
  if (d.ok !== true) problems.push('恰好等于预算应判 ok（等于不算超）');
  const e = judgeMemoryBudget(MEMORY_BUDGET_BYTES + 1);
  if (e.ok !== false) problems.push('超预算 1 字节应判 not ok');
  const f = sessionOutcomesFromHealth({ files: {} });
  if (f.value !== null || f.conformsToPlan !== false) problems.push('空 sessions-health 必须 null + conformsToPlan:false');
  return { ok: problems.length === 0, problems, version: SLO_TAIL_VERSION, schema: SLO_TAIL_SCHEMA };
}
