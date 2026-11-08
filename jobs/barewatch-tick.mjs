#!/usr/bin/env node
// dsh-butler / barewatch-tick.mjs —— 裸跑期观测采集器（看板卡 [4]）
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §5「裸跑期」（行 943-959）
//   逐日记录：总告警数 / 标记误报数 / 疑似误报数（未标且 >4h 未 ack）/ 误报率 / 累计告警数
//   放行门槛（三条同时满足才可放行 [6] P3）：
//     ① 误报率 < 5%（10% 警戒线，>10% 必须回头调规则）
//     ② 累计告警 ≥ 50 条（样本不足必须延长裸跑，不许靠样本少达标）
//     ③ 疑似误报占比 ≤ 10%（防「不标就是 0%」的自欺）
//
// **只读观测，不改 P2 判定规则**（方案 §5 并行提示：改判定规则会污染观测）。
//
// ── 自治降档读侧对齐（2026-09-12 卡「降档开关接进 barewatch 读数路径」）────────────
//   旧读法：本文件自己 readJson 后判 `d.degraded === true`，而开关文件真实字段是 `level`（normal|degraded）
//           → **降档读不到**（不误报，但护栏无效）。
//   现读法：一律走 `lib/autonomy-state.mjs` 的 `readAutonomyState()` / `checkAutonomyAllowed()`
//           ——**禁止任何调用方自己 if 字段**；fail-safe：缺文件 / 损坏 / 读失败一律判降档。
//   语义（降档 ≠ 停机）：降档期间本采集器**照常观测与报告**（observationAllowed 恒 true），
//           只在日报 / 告警里显式标注「自治降档中 · 自主动作已暂停」，并把自主动作闸门
//           （autonomousAllowed）透出给需要动手的路径走 `checkAutonomyAllowed()` 拒动判定。
//   ⛔ 动作侧（repair L2 / 小护士 G7）不在本文件接线范围——本卡只做读侧。
//   数据源（全部只读）：
//     · ~/.dsh/butler-watch-state.json  daily.items（P2 每 tick 落一条告警流）+ events[].ackedAt
//     · ~/.dsh/butler-falsepositives.jsonl（主人 `--false-positive` 标记）
//   产出：
//     · ~/.dsh/butler-barewatch-ledger.jsonl  逐条告警台账（append-only，去重键防重复采集）
//     · ~/.dsh/butler-barewatch-state.json    采集元数据 + gap 记录 + 降档快照
//     · 当日日报「📊 误报率」段刷新（docs\管家报告\<YYYY-MM-DD>-<host>.md）
//
// 用法：
//   node barewatch-tick.mjs [--json] [--dry-run] [--no-daily] [--status] [--home <dir>]
// 退出码：0 正常 / 1 失败 / 2 用法错误
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { readJson, updateJson, acquireTickLock, StoreError } from '../src/dsh-butler/lib/store.mjs';
import { appendStateText } from '../src/dsh-butler/lib/dual-write.mjs';
import { updateStateJson } from '../src/dsh-butler/lib/dual-write-store.mjs';
import { readAutonomy } from '../src/dsh-butler/lib/autonomy.mjs';
import { readAutonomyState, checkAutonomyAllowed } from '../src/dsh-butler/lib/autonomy-state.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { gateComponent } from '../src/dsh-butler/lib/version.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';

export const BAREWATCH_VERSION = '0.1.0';
export const BAREWATCH_SCHEMA = 1;
/** 【2c-B3】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, home) {
  return resolveStatePath(name, { home: home ?? dshHome() }).path;
}
export const LEDGER_NAME = 'butler-barewatch-ledger.jsonl';
export const STATE_NAME = 'butler-barewatch-state.json';
const WATCH_STATE_NAME = 'butler-watch-state.json';
const FP_NAME = 'butler-falsepositives.jsonl';

/** 降档标注文案（日报 / 告警 / CLI 统一措辞，禁止各处自己拼）。 */
export const DEGRADE_BANNER = '自治降档中 · 自主动作已暂停';

// 与 dsh-butler-panel/lib/checks.mjs 保持同一口径（改动必须两边同步）
export const FP_GATE_RATE = 0.05;
export const FP_WARN_RATE = 0.10;
export const FP_MIN_SAMPLES = 50;
export const UNACK_SUSPECT_HOURS = 4;

const SUSPECT_MS = UNACK_SUSPECT_HOURS * 3_600_000;

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function deviceName() {
  try { return os.hostname(); } catch { return process.env.COMPUTERNAME ?? 'unknown'; }
}

// ── 自治降档（统一读法）─────────────────────────────────────────────────

/**
 * 降档快照。**唯一读法**：一律走 `lib/autonomy-state.mjs`，禁止调用方自己 if 字段。
 * fail-safe：缺文件 / 损坏 / 读失败 → degraded（`failSafe:true`）。
 * @param {{home?:string, kind?:string}} [opts]
 * @returns {{level:string, degraded:boolean, observationAllowed:boolean, autonomousAllowed:boolean,
 *            failSafe:boolean, source:string, reason:string, updatedAt:string|null, updatedBy:string|null,
 *            file:string, note:string|null}}
 */
export function readDegradeSnapshot(opts = {}) {
  const s = readAutonomyState(opts);
  const gate = checkAutonomyAllowed({ ...opts, kind: opts.kind ?? 'barewatch-collect' });
  return {
    level: s.level,
    degraded: s.degraded === true,
    // 降档 ≠ 停机：观测 / 采集 / 报告永不被降档阻塞
    observationAllowed: true,
    // 自主动作闸门（本卡只透出判定；真要动手的路径必须自己问 checkAutonomyAllowed）
    autonomousAllowed: gate.allowed === true,
    failSafe: s.ok !== true,
    source: s.source,
    reason: s.reason,
    updatedAt: s.updatedAt ?? null,
    updatedBy: s.updatedBy ?? null,
    file: s.file,
    note: s.degraded === true ? DEGRADE_BANNER : null,
  };
}

/** 归一：接受降档快照对象 或 旧布尔（兼容既有调用点）→ 是否降档。 */
export function degradeFlag(v) {
  if (v && typeof v === 'object') return v.degraded === true;
  return v === true;
}

/** 归一：降档标注文本（非降档 → null）；日报 / 告警 / CLI 共用同一措辞。 */
export function degradeText(v) {
  if (!degradeFlag(v)) return null;
  const d = v && typeof v === 'object' ? v : null;
  const from = d ? (d.failSafe ? `fail-safe:${d.reason}` : String(d.source ?? 'file')) : 'unknown';
  const at = d?.updatedAt ? ` · 更新 ${d.updatedAt}` : '';
  return `${DEGRADE_BANNER}（level=degraded · 来源 ${from}${at}）`;
}

/** 降档状态变化的告警计划（幂等：同一态同一天只写一条；dry-run 不写亦不推进记录）。 */
export function planDegradeAlert(degrade, prev, opts = {}) {
  const prevAlert = prev?.degradeAlert ?? null;
  const day = dayKey(opts.now ?? Date.now());
  const key = `${degrade?.level ?? 'unknown'}|${degrade?.source ?? '?'}|${degrade?.reason ?? '?'}`;
  if (opts.dryRun) return prevAlert;
  if (degrade?.degraded === true) {
    if (prevAlert?.kind === 'degraded' && prevAlert.key === key && prevAlert.day === day) return prevAlert;
    alert({
      level: 'warn',
      source: 'butler-barewatch',
      message: `${DEGRADE_BANNER}（观测照常，仅自主动作暂停）`,
      detail: { level: degrade.level, source: degrade.source, reason: degrade.reason, failSafe: degrade.failSafe, updatedAt: degrade.updatedAt, updatedBy: degrade.updatedBy },
    }, { home: opts.home });
    return { kind: 'degraded', key, day, at: new Date(opts.now ?? Date.now()).toISOString() };
  }
  if (prevAlert?.kind === 'degraded') {
    alert({
      level: 'info',
      source: 'butler-barewatch',
      message: '自治降档已解除 · 自主动作恢复按各自开关与护栏判定',
      detail: { level: degrade?.level ?? 'normal', source: degrade?.source ?? null, updatedAt: degrade?.updatedAt ?? null, updatedBy: degrade?.updatedBy ?? null },
    }, { home: opts.home });
    return { kind: 'normal', key, day, at: new Date(opts.now ?? Date.now()).toISOString() };
  }
  return prevAlert;
}

function readJsonl(file) {
  const out = [];
  try {
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* 坏行跳过（append-only 台账可能被截断写入） */ }
    }
  } catch { /* 读失败 = 空 */ }
  return out;
}

/**
 * 从事件的当前值里提取「对象标识」（subject）—— 独立状况去重键的第四段。
 *
 * 【2026-09-15 · 独立状况去重精度】去重本意是防「同一对象反复刷屏」，
 *   但旧口径只按 eventId ⇒ 同一天两个**不同对象**真出状况会被并成 1 个
 *   （实测：`session-b783` 与 `session-0d9d` 各自真卡住，却只算 1 个状况）。
 *   取冒号前片段（不含「分钟数」等易变尾巴，避免同对象被误判成多个状况）；
 *   无 event 记录 / 空值 → null（退化为旧口径，存量计数不变）。
 * @param {{value?:string,lastValue?:string}|null|undefined} ev watch-state 的 events[eventId]
 */
export function subjectOf(ev) {
  const v = ev?.value ?? ev?.lastValue ?? null;
  if (typeof v !== 'string') return null;
  const head = v.split(/[:：]/)[0].trim();
  if (!head) return null;
  return head.slice(0, 64);
}

/** 从 watch-state 的 daily.items 提取本轮可见的告警条目。 */
export function extractDailyItems(watchState) {
  const day = watchState?.daily?.day ?? null;
  const items = Array.isArray(watchState?.daily?.items) ? watchState.daily.items : [];
  const events = watchState?.events ?? {};
  return items
    .filter((it) => it && typeof it === 'object' && it.id)
    .map((it) => ({
      key: `${day}|${it.id}|${Number(it.at ?? 0)}|${it.kind ?? '?'}|${it.ackToken ?? ''}`,
      day,
      eventId: it.id,
      at: Number(it.at ?? 0),
      level: it.level ?? null,
      kind: it.kind ?? null,
      ackToken: it.ackToken ?? null,
      // 对象标识（2026-09-15）：采集当刻从 events[eventId] 的当前值取；取不到 → null
      subject: subjectOf(events?.[it.id]),
    }))
    .filter((r) => r.at > 0);
}

/** 把误报标记 + ack 状态回填到台账行（纯函数，便于单测）。 */
export function applyMarks(rows, fpRecords, events = {}) {
  const out = rows.map((r) => ({ ...r }));
  const byToken = new Map();
  const byEvent = new Map();
  for (const fp of Array.isArray(fpRecords) ? fpRecords : []) {
    if (!fp || typeof fp !== 'object') continue;
    const t = Date.parse(fp.at ?? '') || 0;
    if (fp.ackToken) byToken.set(String(fp.ackToken).toLowerCase(), { t, fp });
    if (fp.eventId) {
      const cur = byEvent.get(fp.eventId);
      if (!cur || t > cur.t) byEvent.set(fp.eventId, { t, fp });
    }
  }
  // ① ackToken 精确命中（推送条目每次一个新令牌 → 最精确）
  for (const r of out) {
    const tok = r.ackToken ? String(r.ackToken).toLowerCase() : null;
    const hit = tok ? byToken.get(tok) : null;
    if (hit) { r.falsePositiveAt = hit.t || null; r.fpNote = hit.fp.note ?? null; r.fpMatch = 'ackToken'; }
  }
  // ② eventId 命中 → 该事件在标记时刻之前最近的一条（🟡 条目无 token，只能事件级）
  for (const [eventId, { t, fp }] of byEvent) {
    let best = null;
    for (const r of out) {
      if (r.eventId !== eventId || r.falsePositiveAt) continue;
      if (r.at > t) continue;
      if (!best || r.at > best.at) best = r;
    }
    if (best) { best.falsePositiveAt = t || null; best.fpNote = fp.note ?? null; best.fpMatch = 'eventId'; }
  }
  // ③ ack 回填（事件级 ackedAt >= 该条时刻 → 视为已确认）
  for (const r of out) {
    const ackedAt = Number(events?.[r.eventId]?.ackedAt ?? 0) || 0;
    if (ackedAt >= r.at) r.ackedAt = ackedAt;
  }
  return out;
}

/** 统计（纯函数）。 */
export function summarize(rows, opts = {}) {
  const now = opts.now ?? Date.now();
  const today = dayKey(now);
  const dayRows = rows.filter((r) => r.day === today);
  const count = (list, pred) => list.filter(pred).length;
  const isMarked = (r) => Boolean(r.falsePositiveAt);
  // 【口径修正 · 2026-09-15 主人拍板「甲」· 不重置计时】
  //   P2 权威口径（lib/watch-policy.mjs：「只有真正推送过的记录（lastNotifyAt > 0）才需要 ack；
  //   🟡 只进日报、无 lastNotifyAt → 不在此列」）—— 即 report 类条目**本就不需要 ack**。
  //   旧实现逐条判「未 ack 即疑似」，把 report 类（本机 44 条里 33 条）永久算作疑似
  //   ⇒ 疑似占比结构性 ≈80% ⇒ 门槛③结构性不可达（与判定准不准无关）。
  //   现口径：疑似只计**曾推送过**的条目（kind === 'push' 或带 ackToken）；分母仍为总告警数
  //   （方案 §3.7.1「疑似误报数 / 总告警数」原文不变）。
  //   为何不重置：改的是**统计归类**（回归既有权威定义），非判定规则；台账一字未动，
  //   历史样本按修正后口径**全量重算**（非新旧混算）⇒ 段 2 计时继续有效。
  const isPushRow = (r) => r.kind === 'push' || Boolean(r.ackToken);
  const isSuspect = (r) => isPushRow(r) && !isMarked(r) && !r.ackedAt && now - r.at > SUSPECT_MS;
  const day = { total: dayRows.length, marked: count(dayRows, isMarked), suspect: count(dayRows, isSuspect) };
  const all = { total: rows.length, marked: count(rows, isMarked), suspect: count(rows, isSuspect) };
  day.rate = day.total ? day.marked / day.total : null;
  day.suspectRate = day.total ? day.suspect / day.total : null;
  all.rate = all.total ? all.marked / all.total : null;
  all.suspectRate = all.total ? all.suspect / all.total : null;
  const gate = {
    rateOk: all.rate !== null && all.rate < FP_GATE_RATE,
    sampleOk: all.total >= FP_MIN_SAMPLES,
    suspectOk: (all.suspectRate ?? 1) <= FP_WARN_RATE,
    minSamples: FP_MIN_SAMPLES,
    gateRate: FP_GATE_RATE,
    warnRate: FP_WARN_RATE,
  };
  gate.pass = gate.rateOk && gate.sampleOk && gate.suspectOk;
  gate.warn = all.rate !== null && all.rate > FP_WARN_RATE;
  return { asOf: new Date(now).toISOString(), day: today, dayStats: day, cumulative: all, gate };
}

/** 判定结论（人话）。 */
export function verdictOf(summary, opts = {}) {
  const g = summary.gate;
  const t = summary.cumulative.total;
  const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
  const bits = [];
  if (t === 0) bits.push('尚无告警样本（观测期刚起步，或 P2 无状态变化）');
  else {
    if (g.warn) bits.push(`误报率 ${pct(summary.cumulative.rate)} > 警戒线 10% → 必须回头调判定规则`);
    else if (!g.rateOk) bits.push(`误报率 ${pct(summary.cumulative.rate)} ≥ 5%`);
    if (!g.suspectOk) bits.push(`疑似误报占比 ${pct(summary.cumulative.suspectRate)} > 10% → 不放行`);
  }
  if (!g.sampleOk) bits.push(`累计告警 ${t} < ${g.minSamples} → 样本不足，延长裸跑`);
  const degraded = degradeFlag(opts.degrade);
  if (degraded) bits.push(`⚠️ ${degradeText(opts.degrade) ?? DEGRADE_BANNER} → 裸跑计时重置（异常期误报率不可作放行依据）`);
  if (g.pass && !degraded) return `达标 → 可提请主人拍板放行 [6] P3（${bits.length ? bits.join('；') : '三门槛全过'}）`;
  return `不放行 → ${bits.join('；') || '未达门槛'}`;
}

/** 刷新日报「📊 误报率」段（幂等；找不到日报/锚点则跳过）。 */
export function refreshDailySection(file, summary, opts = {}) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'daily-missing', file };
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*📊\s*误报率/.test(l));
  if (start < 0) return { ok: false, reason: 'anchor-missing', file };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
  }
  const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
  const g = summary.gate;
  const mark = (ok) => (ok ? '✓' : '✗');
  // 降档标注：normal 时**不出现此行**（降档解除后自然复原，段内容逐字回到正常版）
  const degradeLine = degradeText(opts.degrade);
  const block = [
    '## 📊 误报率（裸跑期 KPI）',
    '',
    ...(degradeLine ? [`- ⚠️ **${degradeLine}**（观测照常，仅自主动作暂停）`, ''] : []),
    `- 当日（${summary.day}）：总告警 **${summary.dayStats.total}** · 标记误报 **${summary.dayStats.marked}** · 疑似误报 **${summary.dayStats.suspect}**（**推送类**未标且 >${UNACK_SUSPECT_HOURS}h 未 ack）`,
    `- 观测期累计（自段起点）：总告警 **${summary.cumulative.total}** · 标记误报 **${summary.cumulative.marked}** · 疑似误报 **${summary.cumulative.suspect}**`,
    `- 误报率（累计）：**${pct(summary.cumulative.rate)}** · 疑似误报占比：**${pct(summary.cumulative.suspectRate)}** · 累计告警数：**${summary.cumulative.total}** / 门槛 ${g.minSamples}`,
    `- 门槛：①误报率 <5% ${mark(g.rateOk)} ②累计 ≥${g.minSamples} ${mark(g.sampleOk)} ③疑似占比 ≤10% ${mark(g.suspectOk)}`,
    `- 口径（2026-09-15 修正 · 主人拍板「甲」）：疑似只计**推送过**的条目（\`kind=push\` 或带 ackToken）——依据 P2 \`lib/watch-policy.mjs\`「只进日报、无 lastNotifyAt 的记录不需要 ack」；分母仍为总告警数；**计数自本段起点起**（段前条目留档不计数）。本次为**统计归类修正**（非判定规则变更），段 2 计时不重置。`,
    `- 结论：**${verdictOf(summary, opts)}**`,
    '',
    `> 数据源：状态目录下的走查台账（逐条台账，每 5 分钟采集；只读观测，不改 P2 判定规则）。`,
    `> 观测期：起 ${opts.startedAt ?? '?'} · 第 ${opts.dayIndex ?? '?'} 天 · 设备 ${opts.device ?? deviceName()} · 报告 \`docs\\管家报告\\裸跑期观测-${opts.startedAt ?? 'x'}.md\``,
  ];
  const next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join(eol);
  if (next === raw) return { ok: true, action: 'unchanged', file };
  if (opts.dryRun) return { ok: true, action: 'would-update', file };
  fs.writeFileSync(file, next, 'utf8');
  return { ok: true, action: 'updated', file };
}

// ------------------------------------------------------------------ 主流程

export function runTick(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? dshHome();
  const device = opts.device ?? deviceName();
  const ledgerFile = stateFileOf(LEDGER_NAME, home);
  const stateFile = stateFileOf(STATE_NAME, home);
  const watchFile = stateFileOf(WATCH_STATE_NAME, home);
  const fpFile = stateFileOf(FP_NAME, home);

  const watchState = (() => { try { return readJson(watchFile, { schemaVersion: 1, home, defaultValue: null }); } catch { return null; } })();
  const prev = (() => { try { return readJson(stateFile, { schemaVersion: BAREWATCH_SCHEMA, home, defaultValue: null }); } catch { return null; } })();
  const autonomy = readAutonomy({ home });
  // v0.1.0（2026-09-14 修，**跨机共性缺陷**）：state 文件由本 tick 每 5 分钟整体重建后覆盖写，
  //   旧实现在此处丢失「非本 tick 产出」的字段 —— 实测抹掉了段起点重置写进去的
  //   previousSegments / segmentRule（两机都中招：HOST_C 本机 + HOST_A 仓1 快照均无这两字段）。
  //   ⇒ 重建 state 时保留前一版中未由本 tick 管理的字段（段历史属长期元数据）。
  //   注意：下方 state 字面量里的显式赋值仍会覆盖同名键（startedAt 等仍以本 tick 计算值为准）。
  const prevMeta = (() => {
    const out = { ...(prev ?? {}) };
    for (const k of ['schemaVersion', 'device', 'startedAt', 'minDays', 'lastCollectedAt', 'lastCollectedDay',
      'ledgerRows', 'addedThisTick', 'gaps', 'degrade', 'degradeAlert', 'autonomyEffective', 'summary']) delete out[k];
    return out;
  })();
  const startedAt = opts.startedAt ?? prev?.startedAt ?? autonomy.bareRun?.startedAt ?? null;
  const startedAtMs = startedAt ? Date.parse(startedAt) : 0;
  // 观测期起点之前的条目只留档、不计数（起点取自然日 00:00，避免半截天污染误报率）
  const fresh = extractDailyItems(watchState).filter((r) => !startedAtMs || r.at >= startedAtMs);
  const ledger = readJsonl(ledgerFile);
  const seen = new Set(ledger.map((r) => r.key));
  const added = [];
  for (const r of fresh) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    added.push(r);
  }
  if (!opts.dryRun && added.length) {
    for (const r of added) {
      const line = JSON.stringify({ ...r, device, recordedAt: new Date(now).toISOString(), schemaVersion: BAREWATCH_SCHEMA }) + '\n';
      if (Buffer.byteLength(line, 'utf8') > 4096) throw new StoreError('LINE_TOO_LONG', 'appendJsonl 单行超过 4096 字节（' + ledgerFile + '），请拆分记录');
      appendStateText(LEDGER_NAME, line, { home, write: (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, t, 'utf8'); } });
    }
  }
  //   ⚠️ 段过滤（2026-09-15 修）：startedAt 过去只过滤「新增采集」（fresh），统计却用全量台账
  //      ⇒ 09-13 的计时重置（段 2 起点 2026-09-13T09:25）**没作用到计数**，本机指标混算段 1
  //      （与 docs\裸跑期段2-规则v2与计时重置-20260913.md §3 登记的池级同源缺陷一致）。
  //      现口径：参与统计的行必须 ≥ 本段起点；段前条目**留档不计数**（台账文件一字不删）。
  const allRows = [...ledger, ...added];
  const rows = startedAtMs ? allRows.filter((r) => r.at >= startedAtMs) : allRows;
  const marked = applyMarks(rows, readJsonl(fpFile), watchState?.events ?? {});
  const summary = summarize(marked, { now });

  const gaps = [...(prev?.gaps ?? [])];
  if (prev?.lastCollectedDay && prev.lastCollectedDay !== summary.day) {
    const gapDays = Math.round((Date.parse(`${summary.day}T00:00:00`) - Date.parse(`${prev.lastCollectedDay}T00:00:00`)) / 86_400_000);
    if (gapDays > 1) {
      gaps.push({ at: new Date(now).toISOString(), from: prev.lastCollectedDay, to: summary.day, days: gapDays, note: '跨天未采集（关机/任务未跑）—— 期间 P2 daily 已重置，条目可能丢失' });
    }
  }
  // 自治降档：**统一读法**（lib/autonomy-state.mjs；旧读法判 `degraded === true` 已废）
  const degrade = readDegradeSnapshot({ home });
  const degradeAlert = planDegradeAlert(degrade, prev, { home, now, dryRun: opts.dryRun });
  const state = {
    // 保留上一版中原有的、非本 tick 管理的字段（见上方 prevMeta 注释：段历史 previousSegments / segmentRule）
    ...prevMeta,
    schemaVersion: BAREWATCH_SCHEMA,
    device,
    startedAt,
    minDays: autonomy.bareRun?.minDays ?? 3,
    lastCollectedAt: new Date(now).toISOString(),
    lastCollectedDay: summary.day,
    ledgerRows: allRows.length,
    segmentRows: rows.length,
    addedThisTick: added.length,
    gaps: gaps.slice(-50),
    degrade,
    degradeAlert,
    autonomyEffective: autonomy.effective,
    summary,
  };
  if (!opts.dryRun) {
    updateStateJson(STATE_NAME, stateFile, () => state, { schemaVersion: BAREWATCH_SCHEMA, home, defaultValue: state });
  }
  const dayIndex = state.startedAt ? Math.floor((now - Date.parse(state.startedAt)) / 86_400_000) + 1 : null;
  let daily = { ok: false, reason: 'skipped' };
  if (!opts.noDaily && (!startedAtMs || now >= startedAtMs)) {
    const dailyFile = opts.dailyFile ?? path.join('<workspace>', 'docs', '管家报告', `${summary.day}-${device}.md`);
    daily = refreshDailySection(dailyFile, summary, {
      dryRun: opts.dryRun, device, startedAt: state.startedAt, dayIndex,
      degrade,
    });
  }
  return {
    ok: true, ledgerFile, stateFile, added: added.length,
    ledgerRows: allRows.length, // 台账文件行数（全量，含段前留档）
    segmentRows: rows.length,   // 本段参与统计的行数
    summary, state, daily, verdict: verdictOf(summary, { degrade }),
  };
}

function printStatus(r) {
  const s = r.summary;
  const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
  console.log('裸跑期观测（只盯人 · 只审计 · 只统筹）');
  console.log(`  台账：${r.ledgerFile}（${r.ledgerRows} 行 · 本段 ${r.segmentRows ?? r.ledgerRows} 条 · 本轮新增 ${r.added}）`);
  console.log(`  当日 ${s.day}：总告警 ${s.dayStats.total} · 标记误报 ${s.dayStats.marked} · 疑似误报 ${s.dayStats.suspect}`);
  console.log(`  观测期累计：总告警 ${s.cumulative.total} · 标记误报 ${s.cumulative.marked} · 疑似误报 ${s.cumulative.suspect}`);
  console.log(`  误报率 ${pct(s.cumulative.rate)} · 疑似占比 ${pct(s.cumulative.suspectRate)} · 门槛：<5% ${s.gate.rateOk ? '✓' : '✗'} · ≥${s.gate.minSamples} ${s.gate.sampleOk ? '✓' : '✗'} · 疑似≤10% ${s.gate.suspectOk ? '✓' : '✗'}`);
  const dt = degradeText(r.state?.degrade);
  if (dt) console.log(`  ⚠️ ${dt}（观测照常；自主动作闸门 autonomousAllowed=${r.state?.degrade?.autonomousAllowed === true}）`);
  else console.log('  自治降档：normal（自主动作按各自开关与护栏判定）');
  console.log(`  结论：${r.verdict}`);
  if (r.daily?.action) console.log(`  日报段：${r.daily.action} → ${r.daily.file}`);
}

function isMainEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainEntry()) {
  const argv = process.argv.slice(2);
  const opt = { json: false, dryRun: false, noDaily: false, status: false, home: null, dailyFile: null };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') opt.json = true;
      else if (a === '--dry-run') opt.dryRun = true;
      else if (a === '--no-daily') opt.noDaily = true;
      else if (a === '--status') opt.status = true;
      else if (a === '--home') opt.home = argv[++i];
      else if (a === '--daily') opt.dailyFile = argv[++i];
      else if (a === '-h' || a === '--help') { console.log('usage: node barewatch-tick.mjs [--json] [--dry-run] [--no-daily] [--status] [--home <dir>] [--daily <file>]'); process.exit(0); }
      else throw new Error(`未知参数：${a}`);
    }
  } catch (e) { console.error(e.message); process.exit(2); }

  const lock = (opt.dryRun || opt.status) ? { ok: true } : acquireTickLock('barewatch', { ttlMs: 120_000, home: opt.home ?? dshHome() });
  if (!lock.ok) { if (opt.json) process.stdout.write(JSON.stringify({ ok: true, skipped: 'lock' }) + '\n'); process.exit(0); }
  // 版本自检（方案 §5.1）：不匹配 → 跳过本组件 + 告警（其余组件照常）
  const gate = gateComponent('butler-barewatch', BAREWATCH_VERSION, { home: opt.home ?? dshHome() });
  if (!gate.run) { console.error(`[barewatch] 跳过：${gate.message}`); process.exit(0); }
  try {
    const r = runTick(opt);
    if (opt.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else printStatus(r);
    process.exit(0);
  } catch (e) {
    console.error(`barewatch-tick 失败：${e?.stack ?? e}`);
    process.exit(1);
  }
}
