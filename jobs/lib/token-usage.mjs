// dsh-butler / lib/token-usage.mjs —— P3 token 用量监测（纯脚本 0 token）
//
// 方案 §4 P3「token 用量监测」（主人 2026-09-09 拍板新增）：
//   数据源已实测：会话日志 `assistant/chunk` 事件带 `chunk.type="usage"` +
//   `usage.{inputTokens,outputTokens,cacheReadTokens,reasoningTokens}`。
//   口径：按天汇总（input+output+reasoning）→ 阈值告警 → 超限自动停（= 不再启动新自动动作）
//   归因升级：①按会话 / 按卡归因 ②cacheReadTokens 占比单列 ③reasoningTokens 占比单列 ④周环比进周报
//
// ★ 2026-10-16（A 组卡 · 修 P-4）：**文件级世代判别** —— 0.2.x 现行日志的 usage 落在
//   `assistant/message`，此前 `eventUsage()` 只认 chunk/attempt ⇒ 按天数据自 2026-09-22 静默冻结。
//   补 message 取数 + `scanLegacyUsage()` 防「0.1.1 同笔 usage 双报」双计（详见该函数注释）。
//
// A5 spike 复验（2026-09-11，本机 HOST-B 实测）
//   `data.chunk = {type:'usage', usage:{inputTokens,outputTokens,cacheReadTokens,reasoningTokens}}`
//   （另有 data.turn / data.step 可供步级对账）。字段名与方案一致，无需兼容层。
//
// 复用 P4 的会话扫描设施（lib/pitfall-scan.mjs 的 discoverSessionFiles / decodeZstdFrames），
// 增量记账同样**按 sessionId 不按路径**（归档移动不改键）。
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { readJson } from '../../src/dsh-butler/lib/store.mjs';
import { updateStateJson } from '../../src/dsh-butler/lib/dual-write-store.mjs';
import { alert } from '../../src/dsh-butler/lib/alert.mjs';
// ★ P0 宿主适配层（2026-09-14）：`assistant/chunk` 取值 + usage 形态判别走适配层（R4）。
import { eventUsage, EV } from '../../src/dsh-butler/lib/host-adapter.mjs';
import { discoverSessionFiles, decodeZstdFrames, deviceName } from '../../src/dsh-butler/lib/pitfall-scan.mjs';

export const TOKEN_USAGE_VERSION = '0.1.0';
export const TOKEN_USAGE_SCHEMA = 1;
/** 【2c-B2】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, opts = {}) {
  return resolveStatePath(name, { home: opts.home ?? dshHome() }).path;
}
export const TOKEN_USAGE_FILE = 'butler-token-usage.json';

/** 默认阈值（可被 ~/.dsh/butler-autonomy-limits.json 的 tokenBudgetPerDay 覆盖）。 */
export const DEFAULT_DAILY_TOKEN_WARN = 3_000_000;
export const DEFAULT_DAILY_TOKEN_BUDGET = 5_000_000;

export function tokenUsagePath(opts = {}) { return stateFileOf(TOKEN_USAGE_FILE, { home: opts.home }); }

export function emptyTokenState() {
  return {
    schemaVersion: TOKEN_USAGE_SCHEMA,
    device: null,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, events: 0, sessions: 0 },
    sessions: {},
    sessionToCard: {},
    cards: {},
    lastScanAt: null,
    lastScan: null,
    scanErrors: [],
  };
}

/** 状态文件实际路径（opts.file 优先：dry-run 时把产物写到临时目录，不碰生产 home）。 */
export function tokenStateFile(opts = {}) { return opts.file ?? tokenUsagePath(opts); }

export function readTokenState(opts = {}) {
  const file = tokenStateFile(opts);
  try {
    const j = readJson(file, { schemaVersion: TOKEN_USAGE_SCHEMA, defaultValue: emptyTokenState(), audit: false });
    if (!j || typeof j !== 'object') return { ...emptyTokenState(), _file: file };
    const state = { ...emptyTokenState(), ...j, sessions: { ...(j.sessions ?? {}) }, sessionToCard: { ...(j.sessionToCard ?? {}) }, cards: { ...(j.cards ?? {}) }, _file: file };
    // 累计摘要可能缺失（老文件 / 手工写入）→ 从会话明细重算，保证展示口径一致
    if (!state.totalsSummary) state.totalsSummary = summarizeUsage(state.totals ?? {});
    return state;
  } catch (e) {
    alert({ level: 'warn', source: 'butler-token', message: `用量状态读取失败（按空处理，下次全量重扫）：${e?.message ?? e}`, detail: { file } }, { home: opts.home });
    return { ...emptyTokenState(), _file: file, _readError: e?.message ?? String(e) };
  }
}

/** 本地日期键（与每日上限同一口径：本地时区自然日）。 */
export function localDay(ts = Date.now()) {
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO 周键（YYYY-Www，周一为一周开始）—— 周环比用。 */
export function isoWeekKey(ts = Date.now()) {
  const d = new Date(Number(ts));
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // 该周周四
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 86400000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function bumpDay(target, day, u) {
  const cur = target[day] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, events: 0 };
  target[day] = {
    inputTokens: cur.inputTokens + (u.inputTokens || 0),
    outputTokens: cur.outputTokens + (u.outputTokens || 0),
    cacheReadTokens: cur.cacheReadTokens + (u.cacheReadTokens || 0),
    reasoningTokens: cur.reasoningTokens + (u.reasoningTokens || 0),
    events: cur.events + 1,
  };
  return target;
}

/** 从 usage 对象做一次累加（纯函数，供增量与单测共用）。 */
export function accumulate(target, day, usage) {
  return bumpDay(target, day, usage);
}

/**
 * 扫整段文本，统计 **legacy 两线**（0.1.1 `assistant/chunk` / 0.1.5 `assistant/attempt`）usage 命中数
 * 与最大 seq，以及 message usage 命中数（后两者供 `extractUsage` 做世代判别与混合登记）。
 *
 * 🔴 为什么是「**文件级**二选一」而不是「只取 seq > legacyMaxSeq 的 message」这条更细的规则：
 *   2026-10-16 隔离实测 —— 细规则在真实 legacy 文件（dac25465）上仍**多算 1 笔**（该笔双报的 message
 *   排在最后一个 chunk-usage 之后）⇒ 只要整段里有 legacy 命中，message 一律不计。
 *   口径 = **宁可少算、不可双计**（双计会让 token 预算门误判超限、虚告警）。
 *
 * 成本：行级预筛（只 parse 含 `assistant/` 的行）⇒ 远低于全量重解析；零副作用（纯函数）。
 * @returns {{count:number, maxSeq:number, messageCount:number}}
 */
export function scanLegacyUsage(text) {
  const s = String(text ?? '');
  // 廉价短路（性能）：整段连 legacy 两线的**事件名**都不含 ⇒ 不可能有 legacy 命中（现代日志走这条，
  //   零额外解析成本）；注：短路时 messageCount 记 0 —— mixed 判据要 count>0，故语义等价。
  if (!s.includes(EV.LEGACY_ASSISTANT_CHUNK) && !s.includes(EV.ASSISTANT_ATTEMPT)) return { count: 0, maxSeq: -1, messageCount: 0 };
  let count = 0; let maxSeq = -1; let messageCount = 0;
  for (const line of s.split('\n')) {
    if (!line.includes('assistant/')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const legacy = eventUsage(ev, { message: false });
    if (legacy) {
      count++;
      const seq = Number(ev?.seq ?? NaN);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
      continue;
    }
    const msg = eventUsage(ev);
    if (msg && msg.source === 'message') messageCount++;
  }
  return { count, maxSeq, messageCount };
}

/**
 * 从已解码文本提取 usage 事件（增量：只处理 seq > sinceSeq）。
 * @param {{text:string, sinceSeq?:number, maxSeq?:number, byDay?:object}} opts
 */
export function extractUsage(opts) {
  const sinceSeq = Number(opts.sinceSeq ?? -1);
  const byDay = opts.byDay ?? {};
  let maxSeq = Number(opts.maxSeq ?? sinceSeq);
  let events = 0;
  let lines = 0;
  let badLines = 0;
  let minTime = null;
  let maxTime = null;
  const byTurnStep = new Map();

  // ★ 2026-10-16（A 组卡 · 修 P-4）：**文件级世代判别** —— 整段有 legacy 命中就只认 legacy（防 0.1.1 双计）
  const text = String(opts.text ?? '');
  const legacySpan = scanLegacyUsage(text);
  const useMessage = legacySpan.count === 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let ev;
    try { ev = JSON.parse(line); } catch { badLines++; continue; }
    const seq = Number(ev?.seq ?? NaN);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    // ★ P0 宿主适配层（2026-09-14）：原写死 `ev.type !== 'assistant/chunk'` + `chunk.type === 'usage'`。
    //   改走适配层 `eventUsage` —— 它按**事件形态**（不靠版本号）给三线各一套取数：
    //     0.1.1：`assistant/chunk` + `data.chunk.type === 'usage'` → `data.chunk.usage`（旧行为逐字节不变）
    //     0.1.5：`assistant/attempt` + `data.usage`（结算式整段流；`assistant/chunk` 已删除）
    //     0.2.x：`assistant/message` + `data.usage`（★ 2026-10-16 补；受世代判别约束防双计）
    //   顺序等价性：旧代码对"非 usage 的 chunk"也会先走 seq 判断再 continue（无副作用），
    //   新代码提前 return null，输出完全一致（回归差异 0 条）。
    const usageRec = eventUsage(ev, { message: useMessage });
    if (!usageRec) continue;
    if (Number.isFinite(seq) && seq <= sinceSeq) continue;
    const u = usageRec.usage;
    const time = usageRec.time;
    const day = localDay(time || Date.now());
    accumulate(byDay, day, {
      inputTokens: Number(u.inputTokens ?? 0),
      outputTokens: Number(u.outputTokens ?? 0),
      cacheReadTokens: Number(u.cacheReadTokens ?? 0),
      reasoningTokens: Number(u.reasoningTokens ?? 0),
    });
    const key = `${usageRec.turn}/${usageRec.step}`;
    byTurnStep.set(key, (byTurnStep.get(key) ?? 0) + 1);
    if (time) { if (minTime === null || time < minTime) minTime = time; if (maxTime === null || time > maxTime) maxTime = time; }
    events++;
  }
  // 🔎 **混合登记（不静默）**：整段既有 legacy 命中、又有「多于 legacy 命中数」的 message usage
  //   ⇒ 存在 "legacy 段 + 现行世代新段" 同文件（只在跨世代升级且未换文件时出现）。本实现按 legacy-only
  //   处理、新段被跳过（保守防双计）。2026-10-16 全库实测 0 例；一旦出现 ⇒ `scanTokenUsage` 记进 lastScan。
  const mixed = (legacySpan.count > 0 && legacySpan.messageCount > legacySpan.count)
    ? { legacyCount: legacySpan.count, messageCount: legacySpan.messageCount, policy: 'legacy-only' }
    : null;
  return { events, maxSeq, lines, badLines, minTime, maxTime, steps: byTurnStep.size, byDay, ...(mixed ? { mixed } : {}) };
}

/**
 * 从看板账本建立 sessionId → cardId 归因表（只读）。
 * @param {object} ledger
 */
export function buildAttribution(ledger) {
  const sessionToCard = {};
  const cards = {};
  for (const t of Array.isArray(ledger?.tasks) ? ledger.tasks : []) {
    const ex = Array.isArray(t?.executions) ? t.executions : [];
    if (!ex.length) continue;
    const id = String(t.id ?? '');
    cards[id] = { id, title: String(t.title ?? ''), status: t.status ?? null, kind: t.kind ?? null, executions: ex.length };
    for (const e of ex) {
      const sid = String(e?.sessionId ?? '');
      if (!sid) continue;
      const prev = sessionToCard[sid];
      const startedAt = Number(e?.startedAt ?? 0);
      if (!prev || startedAt > Number(prev.startedAt ?? 0)) sessionToCard[sid] = { cardId: id, startedAt };
    }
  }
  return { sessionToCard, cards };
}

/** 单会话用量汇总（含 cache / reasoning 占比）。 */
export function summarizeUsage(byDay) {
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, events: 0 };
  for (const v of Object.values(byDay ?? {})) {
    for (const k of Object.keys(sum)) sum[k] += Number(v?.[k] ?? 0);
  }
  const totalTokens = sum.inputTokens + sum.outputTokens + sum.reasoningTokens;
  // 注意：cache 占比的分母 = inputTokens + cacheReadTokens
  // 实测（2026-09-11，302 个会话）：cacheReadTokens 常是 inputTokens 的数十倍（命中缓存的输入不计入 inputTokens）
  // → 拿 inputTokens 当分母会算出 9517% 这种荒谬值。
  const inputTotal = sum.inputTokens + sum.cacheReadTokens;
  return {
    ...sum,
    totalTokens,
    inputTotal,
    cacheReadRatio: inputTotal > 0 ? sum.cacheReadTokens / inputTotal : 0,
    reasoningRatio: totalTokens > 0 ? sum.reasoningTokens / totalTokens : 0,
  };
}

/**
 * 扫一遍本机会话日志（增量；纯只读 + 0 token）。
 * @param {{
 *   home?:string, now?:number, state?:object, full?:boolean, maxFiles?:number,
 *   ledger?:object|null, persist?:boolean, onProgress?:Function, sinceDays?:number|null
 * }} [opts]
 */
export function scanTokenUsage(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const state = opts.state ?? readTokenState({ home });
  const files = discoverSessionFiles(home);
  const sessions = { ...(state.sessions ?? {}) };
  const mixedFiles = []; // 🔎 世代混合文件登记（2026-10-16 A 组卡）
  let scanned = 0; let skipped = 0; let bytes = 0; const errors = [];
  const cutoff = opts.sinceDays ? now - opts.sinceDays * 86400000 : null;

  let budget = Number.isFinite(opts.maxFiles) ? opts.maxFiles : files.length;
  for (const f of files) {
    if (budget <= 0) break;
    const prev = sessions[f.sessionId];
    if (!opts.full && prev && Number(prev.bytes) === f.bytes) { skipped++; continue; }
    if (cutoff && f.mtimeMs < cutoff && !prev) { skipped++; continue; }
    budget--;
    let buf;
    try { buf = fs.readFileSync(f.file); } catch (e) { errors.push({ sessionId: f.sessionId, error: e?.message ?? String(e) }); continue; }
    bytes += buf.length;
    let decoded;
    try { decoded = decodeZstdFrames(buf); } catch (e) { errors.push({ sessionId: f.sessionId, error: `decode:${e?.message ?? e}` }); continue; }
    const sinceSeq = opts.full ? -1 : Number(prev?.lastSeq ?? -1);
    // 文件变小 = 被重写/重建（不是追加）→ 必须重算该会话，否则同一批 usage 会被重复累加
    const rewritten = !!prev && f.bytes < Number(prev.bytes ?? 0);
    const byDay = (opts.full || rewritten) ? {} : { ...(prev?.byDay ?? {}) };
    const r = extractUsage({ text: decoded.text, sinceSeq: rewritten ? -1 : sinceSeq, maxSeq: sinceSeq, byDay });
    if (r.mixed) mixedFiles.push({ sessionId: f.sessionId, ...r.mixed });
    sessions[f.sessionId] = {
      lastSeq: r.maxSeq,
      bytes: f.bytes,
      root: f.root,
      mtimeMs: f.mtimeMs,
      byDay,
      usage: summarizeUsage(byDay),
      lastEventAt: r.maxTime ?? prev?.lastEventAt ?? null,
      firstEventAt: r.minTime ?? prev?.firstEventAt ?? null,
      scannedAt: now,
      frameErrors: decoded.frameErrors?.length ?? 0,
      rewritten: rewritten || undefined,
    };
    scanned++;
    if (typeof opts.onProgress === 'function' && scanned % 25 === 0) {
      try { opts.onProgress({ scanned, skipped, sessionId: f.sessionId }); } catch { /* 忽略 */ }
    }
  }

  // 归因表（账本 → sessionId/card）
  let attribution = { sessionToCard: state.sessionToCard ?? {}, cards: state.cards ?? {} };
  if (opts.ledger) attribution = buildAttribution(opts.ledger);

  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, events: 0 };
  for (const s of Object.values(sessions)) {
    const u = s.usage ?? summarizeUsage(s.byDay);
    for (const k of Object.keys(totals)) totals[k] += Number(u?.[k] ?? 0);
  }
  const summary = summarizeUsage(totals);

  const next = {
    ...state,
    schemaVersion: TOKEN_USAGE_SCHEMA,
    device: deviceName(),
    totals: { ...totals, sessions: Object.keys(sessions).length },
    totalsSummary: summary,
    sessions,
    sessionToCard: attribution.sessionToCard,
    cards: attribution.cards,
    lastScanAt: now,
    lastScan: { scanned, skipped, files: files.length, bytes, errors: errors.length, full: opts.full === true, durationMs: 0, mixedFiles: mixedFiles.length, mixedDetail: mixedFiles.slice(0, 5) },
    scanErrors: errors.slice(-50),
  };

  return { state: next, scanned, skipped, files: files.length, bytes, errors, summary };
}

/** 落盘（走 butler-store 原子写；opts.file 可重定向到隔离目录）。 */
export function persistTokenState(state, opts = {}) {
  const file = tokenStateFile(opts);
  const out = updateStateJson(TOKEN_USAGE_FILE, file, () => ({ ...state, schemaVersion: TOKEN_USAGE_SCHEMA }), {
    schemaVersion: TOKEN_USAGE_SCHEMA, defaultValue: emptyTokenState(), home: opts.home ?? dshHome(), audit: false,
  });
  return { ok: true, file, lastScanAt: out?.lastScanAt ?? null, sessions: Object.keys(out?.sessions ?? {}).length };
}

/** 按天汇总（最近 N 天，倒序）。 */
export function aggregateByDay(state, opts = {}) {
  const days = Number(opts.days ?? 14);
  const acc = {};
  for (const s of Object.values(state?.sessions ?? {})) {
    for (const [day, v] of Object.entries(s?.byDay ?? {})) {
      if (!acc[day]) acc[day] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, events: 0, sessions: new Set() };
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens', 'events']) acc[day][k] += Number(v?.[k] ?? 0);
      acc[day].sessions.add(s.sessionId ?? '');
    }
  }
  const out = Object.entries(acc)
    .map(([day, v]) => {
      const totalTokens = v.inputTokens + v.outputTokens + v.reasoningTokens;
      const inputTotal = v.inputTokens + v.cacheReadTokens;
      return {
        day, ...v, sessions: v.sessions.size, totalTokens, inputTotal,
        cacheReadRatio: inputTotal ? v.cacheReadTokens / inputTotal : 0,
        reasoningRatio: totalTokens ? v.reasoningTokens / totalTokens : 0,
      };
    })
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  return out.slice(0, days);
}

/** 今日用量（token 预算门用）。 */
export function usageForDay(state, day = localDay()) {
  let inputTokens = 0; let outputTokens = 0; let reasoningTokens = 0; let cacheReadTokens = 0; let events = 0;
  for (const s of Object.values(state?.sessions ?? {})) {
    const v = s?.byDay?.[day];
    if (!v) continue;
    inputTokens += Number(v.inputTokens ?? 0);
    outputTokens += Number(v.outputTokens ?? 0);
    reasoningTokens += Number(v.reasoningTokens ?? 0);
    cacheReadTokens += Number(v.cacheReadTokens ?? 0);
    events += Number(v.events ?? 0);
  }
  return { day, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, events, totalTokens: inputTokens + outputTokens + reasoningTokens };
}

/** 按会话排序（Top N）。 */
export function topSessions(state, opts = {}) {
  const limit = Number(opts.limit ?? 10);
  const rows = Object.entries(state?.sessions ?? {}).map(([sessionId, s]) => {
    const u = s?.usage ?? summarizeUsage(s?.byDay);
    const card = state?.sessionToCard?.[sessionId] ?? null;
    const cardMeta = card ? state?.cards?.[card.cardId] ?? null : null;
    return {
      sessionId,
      root: s?.root ?? null,
      totalTokens: u.totalTokens, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens, reasoningTokens: u.reasoningTokens,
      cacheReadRatio: u.cacheReadRatio, reasoningRatio: u.reasoningRatio,
      cardId: card?.cardId ?? null, cardTitle: cardMeta?.title ?? null,
      lastEventAt: s?.lastEventAt ?? null,
    };
  }).filter((r) => r.totalTokens > 0);
  rows.sort((a, b) => b.totalTokens - a.totalTokens);
  return rows.slice(0, limit);
}

/** 按卡归因。 */
export function aggregateByCard(state, opts = {}) {
  const rows = new Map();
  for (const [sessionId, s] of Object.entries(state?.sessions ?? {})) {
    const u = s?.usage ?? summarizeUsage(s?.byDay);
    if (!u.totalTokens) continue;
    const link = state?.sessionToCard?.[sessionId];
    const cardId = link?.cardId ?? '(未归因)';
    const meta = state?.cards?.[cardId] ?? null;
    const cur = rows.get(cardId) ?? {
      cardId, title: meta?.title ?? '(未归因会话)', status: meta?.status ?? null,
      totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, sessions: [],
    };
    cur.totalTokens += u.totalTokens; cur.inputTokens += u.inputTokens; cur.outputTokens += u.outputTokens;
    cur.reasoningTokens += u.reasoningTokens; cur.cacheReadTokens += u.cacheReadTokens;
    cur.sessions.push({ sessionId, totalTokens: u.totalTokens });
    rows.set(cardId, cur);
  }
  const out = [...rows.values()].map((r) => ({
    ...r,
    sessionCount: r.sessions.length,
    cacheReadRatio: (r.inputTokens + r.cacheReadTokens) ? r.cacheReadTokens / (r.inputTokens + r.cacheReadTokens) : 0,
    reasoningRatio: r.totalTokens ? r.reasoningTokens / r.totalTokens : 0,
    topSessions: r.sessions.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 3).map((s) => s.sessionId),
  }));
  out.sort((a, b) => b.totalTokens - a.totalTokens);
  return Number.isFinite(opts.limit) ? out.slice(0, opts.limit) : out;
}

/** 周环比（本周 vs 上周；进周报段）。 */
export function weekOverWeek(state, now = Date.now()) {
  const curWeek = isoWeekKey(now);
  const prevWeek = isoWeekKey(now - 7 * 86400000);
  const bucket = (weekKey) => {
    const sum = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, events: 0 };
    for (const s of Object.values(state?.sessions ?? {})) {
      for (const [day, v] of Object.entries(s?.byDay ?? {})) {
        if (isoWeekKey(Date.parse(`${day}T12:00:00`)) !== weekKey) continue;
        for (const k of Object.keys(sum)) sum[k] += Number(v?.[k] ?? 0);
      }
    }
    return { week: weekKey, ...sum, totalTokens: sum.inputTokens + sum.outputTokens + sum.reasoningTokens };
  };
  const cur = bucket(curWeek);
  const prev = bucket(prevWeek);
  const delta = cur.totalTokens - prev.totalTokens;
  return {
    current: cur, previous: prev, delta,
    deltaRatio: prev.totalTokens > 0 ? delta / prev.totalTokens : null,
    direction: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat'),
  };
}

/**
 * 阈值判定 + 告警（方案：超限 → 自动停 = 不再启动新自动动作）。
 * @param {object} state
 * @param {{now?:number, warn?:number, budget?:number, home?:string, silent?:boolean}} [opts]
 */
export function checkThresholds(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const day = localDay(now);
  const usage = usageForDay(state, day);
  const warn = Number(opts.warn ?? DEFAULT_DAILY_TOKEN_WARN);
  const budget = Number(opts.budget ?? DEFAULT_DAILY_TOKEN_BUDGET);
  const level = usage.totalTokens >= budget ? 'budget' : (usage.totalTokens >= warn ? 'warn' : 'ok');
  const out = {
    day, usage, warn, budget, level,
    exceeded: level === 'budget',
    message: level === 'budget'
      ? `今日 token ${usage.totalTokens} 已超预算 ${budget} → 停止启动新自动动作（不强杀在跑的会话）`
      : (level === 'warn' ? `今日 token ${usage.totalTokens} 已过警戒线 ${warn}` : `今日 token ${usage.totalTokens}（预算 ${budget}）`),
  };
  if (level !== 'ok' && !opts.silent) {
    alert({ level: level === 'budget' ? 'error' : 'warn', source: 'butler-token', message: out.message, detail: { day, usage } }, { home: opts.home });
  }
  return out;
}

/** 一行摘要（日报 / CLI）。累计值**从会话明细现算**（不信任状态里的摘要字段，避免口径漂移）。 */
export function describeTokenUsage(state, opts = {}) {
  const days = aggregateByDay(state, { days: opts.days ?? 7 });
  const totals = summarizeUsage(Object.fromEntries(Object.entries(state?.sessions ?? {}).map(([sid, s]) => [sid, s?.usage ?? summarizeUsage(s?.byDay)])));
  return {
    file: tokenUsagePath(opts),
    device: state?.device ?? null,
    sessions: Object.keys(state?.sessions ?? {}).length,
    totals,
    lastScanAt: state?.lastScanAt ?? null,
    lastScan: state?.lastScan ?? null,
    days,
    threshold: checkThresholds(state, { now: opts.now, silent: true, warn: opts.warn, budget: opts.budget }),
    topSessions: topSessions(state, { limit: opts.top ?? 5 }),
    topCards: aggregateByCard(state, { limit: opts.topCards ?? 5 }),
    weekOverWeek: weekOverWeek(state, opts.now),
  };
}

export { discoverSessionFiles, decodeZstdFrames, deviceName };
