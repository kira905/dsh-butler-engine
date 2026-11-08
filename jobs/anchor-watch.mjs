#!/usr/bin/env node
// ============================================================================
// dsh-butler / anchor-watch.mjs —— 防「偷偷缩目标」· 锚检测器（三档 + 快照基线）
//
// 真源：docs\方案-三层角色工作方式与主线流水-V9.md
//   §8.1（为什么必须有）· §8.2（载体与门槛，**D-1 已由主人 2026-11-04 01:47 拍「②+③ 组合」**）
//   §8.3（锚长什么样 / 快照基线 / 保留 30 份）· §8.4（三档检测 + 投递与判定分开写死）
//   §8.5（谁看得见）· §14.2 P3 行（判据 ①~③）
//
// 本件干什么（**只读判定 + 只写自己那份快照/日报**）：
//   ① 档 A 名单 = 「在途卡（todo+running+review+failed）≥1 且近 7 天有流水」的线（现算，不写死）
//   ② 按线读 docs\年轮\<lineId>-anchor.json，跟上一次快照比 ⇒ 判「锚被动过」（anchor-shrunk 等）
//   ③ 把 docs\年轮\l-*-anchor.json 全读出来，按 `{line} ∪ aliases` 规范化集合分组 ⇒ 判 anchor-forked
//   ④ 每轮成功读锚后落 _archive\anchor-snapshots\<lineId>-<YYYYMMDD>.json；每线留最近 30 份
//   ⑤ 失败出口（fail-closed）：读不到 ⇒ anchor-missing（黄）；坏 JSON ⇒ anchor-broken（黄）；
//      快照/日报写不下去 ⇒ rc=3 + 日报一行（**绝不当"没漂移"**）
//
// 🔴 三条不许破的边界：
//   1. **不写年轮 json**（D-1 选②：锚另存成新事实；年轮现有格式一字不动）；
//   2. **不碰小本本（账本目录）**：本件对它是**纯读**（只 `_lines.json` + `readLedger` 的只读视图），
//      连 writer 模块都不 import —— `ledger-writer-audit.mjs` 必须仍判「碰账本的写者只有那一个」；
//   3. **不投递**：观察项不占 msg 日配额、不写 `lastNotifiedAt`、不动 `butler-queue-notify.json`
//      （三红线①）。"判定 ≤ 2 分钟可以承诺；投递受通道配额" —— 换通道 = T-2 待拍板，本件不代拍。
//
// 用法：
//   node <pkg>/src/dsh-butler/anchor-watch.mjs [--apply] [--json <文件>] [--quiet]
//        [--home <目录>] [--nianlun <目录>] [--snapshots <目录>] [--board <夹具json>]
//        [--now <ISO>] [--stall-rounds 6] [--flow-days 7] [--min-inflight 1] [--keep 30]
//   node <pkg>/src/dsh-butler/anchor-watch.mjs --selftest
//
// 缺省 = **dry-run**（零写入：不快照、不写日报、不删超龄）；`--apply` 才落盘。
// 退出码：0 正常 / 2 用法错 / 3 快照或日报写不下去（rc=3 + 日报一行）/ 4 判定不可用（看板与账本都读不到）/ 5 自检失败
// ⚠️ 判定类三红线③：`--json` 只落文件，**不上 stdout**。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { acquireTickLock, writeJsonAtomic, writeTextAtomic } from '../src/dsh-butler/lib/store.mjs';
import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { readLedger } from './ledger-read.mjs';

export const TOOL = 'anchor-watch';
export const VERSION = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `<workspace>`（本件在 `tools\dsh-butler\` 下两跳）。⚠️ 只用于**逻辑路径**：`_archive` 是 junction，写它就写到目标盘。 */
export const DSH_ROOT = path.resolve(HERE, '..', '..');

export const DEFAULT_NIANLUN = path.join(DSH_ROOT, 'docs', '年轮');
export const DEFAULT_SNAPSHOTS = path.join(DSH_ROOT, '_archive', 'anchor-snapshots');
export const DEFAULT_REPORT_DIR = path.join(DSH_ROOT, 'docs', '管家报告');

export const SNAP_KEEP_DEFAULT = 30;
export const STALL_ROUNDS_DEFAULT = 6;
export const FLOW_DAYS_DEFAULT = 7;
export const MIN_INFLIGHT_DEFAULT = 1;
export const LOCK_TTL_MS = 30_000;
export const LOCK_PREFIX = 'mainline-anchor:';
export const SHRINK_TEXT_RATIO = 0.3; // 措辞长度缩 > 30% ⇒ 命中
export const ANCHOR_SUFFIX = '-anchor.json';
export const LINE_ID_RE = /^l-[a-z0-9-]+-\d{3,}$/;
export const ANCHOR_FILE_RE = /^(l-[a-z0-9-]+-\d{3,})-anchor\.json$/;
export const INFLIGHT_STATUSES = ['todo', 'running', 'review', 'failed'];
export const ANCHOR_REQUIRED = ['v', 'lineId', 'line', 'aliases', 'updatedAt', 'criteria', 'quotes'];

const MAX_LIST = 40;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }

/** 本机时区的 ISO（带 +08:00 这类偏移；不要 `toISOString()` 的 Z）。 */
export function isoWithOffset(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T`
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

export function dayKeyDash(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 线名规范化（分组键用）：全角空格/半角空格一律去掉、大小写折叠、首尾去空。 */
export function normLine(s) {
  return String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
}

function preview(s, n = 48) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t;
}

function codePointLen(s) { return [...String(s ?? '')].length; }

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

function readJsonSafe(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
    return { ok: false, kind: e && e.code === 'ENOENT' ? 'missing' : 'unreadable', error: `${e && e.code ? e.code : ''} ${e && e.message ? e.message : e}`.trim(), val: null, mtimeMs: null };
  }
  const st = statSafe(p);
  if (!raw.trim()) return { ok: false, kind: 'empty', error: '文件是空的', val: null, mtimeMs: st?.mtimeMs ?? null };
  try {
    return { ok: true, kind: 'ok', error: null, val: JSON.parse(raw), mtimeMs: st?.mtimeMs ?? null };
  } catch (e) {
    return { ok: false, kind: 'broken', error: `坏 JSON：${e.message}`, val: null, mtimeMs: st?.mtimeMs ?? null };
  }
}

// ---------------------------------------------------------------------------
// 锚文件
// ---------------------------------------------------------------------------
export function anchorPath(nianlunDir, lineId) { return path.join(nianlunDir, `${lineId}${ANCHOR_SUFFIX}`); }

/** 列出年轮目录里所有锚文件（按文件名排序，不跟子目录）。 */
export function listAnchorFiles(nianlunDir) {
  let entries = [];
  try { entries = fs.readdirSync(nianlunDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = ANCHOR_FILE_RE.exec(e.name);
    if (!m) continue;
    out.push({ file: path.join(nianlunDir, e.name), name: e.name, lineId: m[1] });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * 结构校验（§8.3 逐字格式）。**缺字段本身就是一条告警**（§8.3 末条）⇒ 判 broken。
 * 只在字段缺失/类型不对时判 broken；`changedAt:""` 是初版锚的**合法**值（不算 broken）。
 */
export function validateAnchor(a) {
  const missing = [];
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, missing: ['(root)'], error: '锚不是一个对象' };
  for (const k of ANCHOR_REQUIRED) if (!(k in a)) missing.push(k);
  if (!Array.isArray(a.criteria) && !missing.includes('criteria')) missing.push('criteria[]');
  if (!Array.isArray(a.quotes) && !missing.includes('quotes')) missing.push('quotes[]');
  if (!Array.isArray(a.aliases) && !missing.includes('aliases')) missing.push('aliases[]');
  if (missing.length) return { ok: false, missing, error: `缺必填字段：${missing.join('、')}` };
  for (const [i, c] of a.criteria.entries()) {
    if (!c || typeof c !== 'object') return { ok: false, missing: [`criteria[${i}]`], error: `criteria[${i}] 不是对象` };
    if (typeof c.id !== 'string' || !c.id.trim()) return { ok: false, missing: [`criteria[${i}].id`], error: `criteria[${i}] 缺 id` };
    if (typeof c.text !== 'string') return { ok: false, missing: [`criteria[${i}].text`], error: `criteria[${i}] 的 text 不是字符串` };
  }
  const seen = new Set();
  for (const c of a.criteria) {
    if (seen.has(c.id)) return { ok: false, missing: [`criteria.id 重复:${c.id}`], error: `criteria id 重复：${c.id}（同一条判据两条行 ⇒ before/after 无法对位）` };
    seen.add(c.id);
  }
  for (const [i, q] of a.quotes.entries()) {
    if (!q || typeof q !== 'object') return { ok: false, missing: [`quotes[${i}]`], error: `quotes[${i}] 不是对象` };
    if (typeof q.text !== 'string') return { ok: false, missing: [`quotes[${i}].text`], error: `quotes[${i}].text 不是字符串` };
  }
  if (!LINE_ID_RE.test(String(a.lineId))) return { ok: false, missing: ['lineId(格式)'], error: `lineId 不像线号：${a.lineId}` };
  return { ok: true, missing: [], error: null };
}

/** 读一份锚：missing / unreadable / broken / ok —— **每种都不是"没漂移"**。 */
export function readAnchor(file) {
  const r = readJsonSafe(file);
  if (!r.ok) {
    const state = r.kind === 'missing' ? 'anchor-missing' : r.kind === 'unreadable' ? 'anchor-missing' : 'anchor-broken';
    return { state, anchor: null, error: r.error, mtimeMs: r.mtimeMs };
  }
  const v = validateAnchor(r.val);
  if (!v.ok) return { state: 'anchor-broken', anchor: null, error: v.error, missing: v.missing, mtimeMs: r.mtimeMs };
  return { state: 'ok', anchor: r.val, error: null, mtimeMs: r.mtimeMs };
}

/** 内容签名：**只算判据正文 + 出处**（不含 changedAt/before/after/why/by/updatedAt 这类留痕字段）。 */
export function contentSig(a) {
  return sha1(JSON.stringify({
    criteria: (a.criteria ?? []).map((c) => [String(c.id), String(c.text), String(c.status ?? '')]),
    quotes: (a.quotes ?? []).map((q) => [String(q.at ?? ''), String(q.by ?? ''), String(q.text ?? '')]),
  }));
}

/** `{line} ∪ aliases` 的规范化集合 —— **anchor-forked 的分组键（线号不参与）**。 */
export function forkKey(anchor) {
  const set = new Set();
  const add = (s) => { const k = normLine(s); if (k) set.add(k); };
  add(anchor?.line);
  for (const x of Array.isArray(anchor?.aliases) ? anchor.aliases : []) add(x);
  return [...set].sort().join('|');
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------
export function snapshotFile(snapshotsDir, lineId, d = new Date()) {
  return path.join(snapshotsDir, `${lineId}-${dayKey(d)}.json`);
}

/** 同线全部快照（按**文件名日期**排序，新的在前）。 */
export function listSnapshots(snapshotsDir, lineId) {
  let entries = [];
  try { entries = fs.readdirSync(snapshotsDir, { withFileTypes: true }); } catch { return []; }
  const re = new RegExp(`^${lineId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{8})\\.json$`);
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = re.exec(e.name);
    if (!m) continue;
    out.push({ file: path.join(snapshotsDir, e.name), name: e.name, day: m[1] });
  }
  out.sort((a, b) => (a.day === b.day ? a.name.localeCompare(b.name) : (a.day < b.day ? 1 : -1)));
  return out;
}

/** 最近一份快照（若今天那份就是"上一次"）。返回 {snapshot, file, day} 或 null。 */
export function readLatestSnapshot(snapshotsDir, lineId) {
  const all = listSnapshots(snapshotsDir, lineId);
  for (const s of all) {
    const r = readJsonSafe(s.file);
    if (!r.ok) return { snapshot: null, file: s.file, day: s.day, error: r.error, broken: true };
    const val = r.val;
    if (!val || typeof val !== 'object') return { snapshot: null, file: s.file, day: s.day, error: '快照不是对象', broken: true };
    if (!val.anchor || typeof val.anchor !== 'object') return { snapshot: null, file: s.file, day: s.day, error: '快照里没有 anchor', broken: true };
    const v = validateAnchor(val.anchor);
    if (!v.ok) return { snapshot: null, file: s.file, day: s.day, error: `快照里的锚不合法：${v.error}`, broken: true };
    return { snapshot: val, file: s.file, day: s.day, error: null, broken: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 看板 / 线表
// ---------------------------------------------------------------------------
/**
 * 看板卡面：`GET /api/task-board/state` → 失败回落账本文件并**报黄**（fail-open，不静默当空）。
 * `--board <file>` = 夹具注入（不碰 HTTP，不碰生产账本）。
 */
export async function loadBoard({ home = dshHome(), boardFile = null, timeoutMs = 8000 } = {}) {
  const absorb = (arr) => arr.filter((t) => t && t.id);
  if (boardFile) {
    const r = readJsonSafe(boardFile);
    if (!r.ok) return { state: 'unavailable', source: 'fixture', cards: [], revision: null, error: `夹具读不到：${r.error}` };
    const st = r.val?.state ?? r.val;
    const tasks = Array.isArray(st?.tasks) ? st.tasks : null;
    if (!tasks) return { state: 'unavailable', source: 'fixture', cards: [], revision: null, error: '夹具里没有 tasks[]' };
    return { state: 'ok', source: 'fixture', cards: absorb(tasks), revision: Number.isFinite(st?.revision) ? st.revision : null, error: null };
  }
  const base = (process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  let apiErr = null;
  try {
    const res = await fetch(`${base}/api/task-board/state`, {
      headers: { origin: base, 'sec-fetch-site': 'same-origin', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const st = j?.state ?? j;
    if (!st || !Array.isArray(st.tasks)) throw new Error('返回体里没有 tasks[]');
    return { state: 'ok', source: 'api', cards: absorb(st.tasks), revision: Number.isFinite(st.revision) ? st.revision : null, error: null };
  } catch (e) {
    apiErr = e?.message ?? String(e);
  }
  const ledgerPath = path.join(home, 'task-board', 'ledger-v2.json');
  const r = readJsonSafe(ledgerPath);
  if (r.ok && Array.isArray(r.val?.tasks)) {
    return { state: 'ok', source: 'file', cards: absorb(r.val.tasks), revision: Number.isFinite(r.val.revision) ? r.val.revision : null,
      error: `API 读不到（${apiErr}）⇒ 已回落账本 ${ledgerPath}` };
  }
  return { state: 'unavailable', source: 'none', cards: [], revision: null,
    error: `API 读不到（${apiErr}）且账本也读不到（${r.error}）` };
}

/**
 * 账本目录（**由读端给出**，本件不自己拼路径）。
 * 🔴 为什么绕这一道：写者不变量（R-14）按**文件**判 —— 同一份源码里既出现写盘 API、又出现账本目录名，
 *    就会被 `ledger-writer-audit.mjs` 判成"第二个写者"。本件对账本是**纯读**，所以路径只从
 *    `ledger-read.mjs`（已登记 read端）解析结果里取，绝不自己拼。
 */
export function ledgerDirOf(home = dshHome()) {
  try {
    const r = readLedger({ home });
    const payload = r?.payload ?? r;
    return payload?.dir ?? null;
  } catch {
    return null;
  }
}

/** 线表（`_lines.json`）：只读自己解析，**不 import 写者模块**（写者不变量 R-14）。 */
export function loadLines({ home = dshHome() } = {}) {
  const dir = ledgerDirOf(home);
  if (!dir) return { state: 'unavailable', lines: [], dir: null, error: '读端没给出账本目录' };
  const file = path.join(dir, '_lines.json');
  const r = readJsonSafe(file);
  if (!r.ok) return { state: 'unavailable', lines: [], dir, file, error: `${file}：${r.error}` };
  const raw = Array.isArray(r.val?.lines) ? r.val.lines : null;
  if (!raw) return { state: 'unavailable', lines: [], dir, file, error: '_lines.json 里没有 lines[]' };
  const lines = raw
    .filter((l) => l && LINE_ID_RE.test(String(l.lineId)))
    .map((l) => ({ lineId: String(l.lineId), line: String(l.line ?? ''), aliases: Array.isArray(l.aliases) ? l.aliases.map(String) : [] }));
  return { state: lines.length ? 'ok' : 'empty', lines, dir, file, error: null };
}

/** 卡片自由字符串线名 → lineId（按 `line` 与 `aliases` 规范化比对；认不出 = null，**不猜**）。 */
export function resolveLineId(lines, literal) {
  const raw = String(literal ?? '').trim();
  if (!raw) return null;
  if (LINE_ID_RE.test(raw)) return raw;
  const k = normLine(raw);
  const hit = lines.find((l) => normLine(l.line) === k) ?? lines.find((l) => l.aliases.some((a) => normLine(a) === k));
  return hit?.lineId ?? null;
}

/**
 * 档 A 名单（§8.2，主人 2026-11-04 拍定口径）：
 *   在途卡（todo+running+review+failed）≥1 **且** 近 N 天有流水。
 *
 * ⚠️ **"流水"的取数口径**（V9 没写死，本件按最保守可复现的一条落地，已进报告「待拍板」）：
 *   该线卡片 `updatedAt` 的最大值（看板真源；658 张卡 0 张缺该字段）。
 *   不用小本本行数当分子：账本 2026-11-04 01:50 才建，拿它算会让档 A 从 11 条掉到 2 条，
 *   而 §8.2 的 10 条正是按看板口径点出来的。账本行数只作旁证列在 JSON 里（`ledgerRows`）。
 */
export function computeTierA({ lines, cards, nowMs, flowDays = FLOW_DAYS_DEFAULT, minInflight = MIN_INFLIGHT_DEFAULT }) {
  const live = cards.filter((t) => !t.archivedAt);
  const byLine = new Map();
  let unmappedTotal = 0;
  const unmappedMap = new Map();
  for (const t of live) {
    const lit = String(t.line ?? '').trim();
    const lineId = resolveLineId(lines, lit);
    if (!lineId) {
      unmappedTotal += 1;
      const k = lit || '(未归线)';
      unmappedMap.set(k, (unmappedMap.get(k) ?? 0) + 1);
      continue;
    }
    if (!byLine.has(lineId)) byLine.set(lineId, { counts: {}, lastFlowMs: null, cards: 0 });
    const bucket = byLine.get(lineId);
    const st = String(t.status ?? '');
    bucket.counts[st] = (bucket.counts[st] ?? 0) + 1;
    bucket.cards += 1;
    const ms = Number(t.updatedAt ?? t.createdAt ?? NaN);
    if (Number.isFinite(ms) && (bucket.lastFlowMs == null || ms > bucket.lastFlowMs)) bucket.lastFlowMs = ms;
  }
  const flowMs = flowDays * 24 * 3600 * 1000;
  const inWindow = [];
  const excluded = [];
  for (const [lineId, b] of byLine) {
    const meta = lines.find((l) => l.lineId === lineId);
    const inflight = INFLIGHT_STATUSES.reduce((n, s) => n + (b.counts[s] ?? 0), 0);
    const row = {
      lineId,
      line: meta?.line ?? null,
      aliases: meta?.aliases ?? [],
      inflight,
      counts: { todo: b.counts.todo ?? 0, running: b.counts.running ?? 0, review: b.counts.review ?? 0, failed: b.counts.failed ?? 0, backlog: b.counts.backlog ?? 0, done: b.counts.done ?? 0 },
      boardCards: b.cards,
      lastFlowAt: b.lastFlowMs != null ? isoWithOffset(new Date(b.lastFlowMs)) : null,
      lastFlowMs: b.lastFlowMs,
    };
    if (inflight < minInflight) { row.reason = `在途 ${inflight} < ${minInflight}`; excluded.push(row); continue; }
    if (b.lastFlowMs == null || nowMs - b.lastFlowMs > flowMs) {
      row.reason = `近 ${flowDays} 天无流水（lastFlowAt=${row.lastFlowAt ?? 'null'}）`;
      excluded.push(row);
      continue;
    }
    row.reason = null;
    inWindow.push(row);
  }
  inWindow.sort((a, b) => (b.inflight - a.inflight) || String(a.line).localeCompare(String(b.line)));
  excluded.sort((a, b) => (b.inflight - a.inflight) || String(a.line).localeCompare(String(b.line)));
  return {
    minInflight,
    flowDays,
    count: inWindow.length,
    lines: inWindow,
    excluded: excluded.slice(0, MAX_LIST),
    excludedCount: excluded.length,
    unmapped: [...unmappedMap.entries()].map(([line, n]) => ({ line, cards: n })).sort((a, b) => b.cards - a.cards).slice(0, MAX_LIST),
    unmappedTotal,
    liveCards: live.length,
    linesWithoutCards: lines.filter((l) => !byLine.has(l.lineId)).length,
  };
}

// ---------------------------------------------------------------------------
// 漂移判定（before = 上一份快照里的锚；after = 当前锚）
// ---------------------------------------------------------------------------
export function summarizeAnchor(a) {
  return {
    criteriaCount: (a?.criteria ?? []).length,
    quotesCount: (a?.quotes ?? []).length,
    updatedAt: a?.updatedAt ?? null,
    changedAt: a?.changedAt ?? '',
    why: a?.why ?? '',
    by: a?.by ?? '',
    sig: a ? contentSig(a) : null,
    criteria: (a?.criteria ?? []).map((c) => ({ id: String(c.id), status: String(c.status ?? ''), len: codePointLen(c.text) })),
    quotes: (a?.quotes ?? []).map((q) => ({ at: String(q.at ?? ''), by: String(q.by ?? ''), len: codePointLen(q.text) })),
  };
}

/** 逐条比 before/after ⇒ 返回 { diffs, progress, contentChanged }。 */
export function diffAnchors(before, after) {
  const diffs = [];
  const bc = before?.criteria ?? [];
  const ac = after?.criteria ?? [];
  // ① 条数减少
  if (ac.length < bc.length) {
    const aIds = new Set(ac.map((c) => String(c.id)));
    const gone = bc.filter((c) => !aIds.has(String(c.id))).map((c) => String(c.id));
    diffs.push({ rule: 'criteria-count', before: bc.length, after: ac.length, removed: gone.slice(0, MAX_LIST) });
  }
  // ② 同 id 措辞缩短 > 30%
  const bMap = new Map(bc.map((c) => [String(c.id), String(c.text)]));
  for (const c of ac) {
    const id = String(c.id);
    if (!bMap.has(id)) continue;
    const bText = bMap.get(id);
    const bLen = codePointLen(bText);
    const aLen = codePointLen(c.text);
    if (bLen <= 0) continue;
    if (aLen < bLen * (1 - SHRINK_TEXT_RATIO)) {
      diffs.push({
        rule: 'criteria-text', id,
        beforeLen: bLen, afterLen: aLen, ratio: Number((aLen / bLen).toFixed(3)),
        beforePreview: preview(bText), afterPreview: preview(c.text),
      });
    }
  }
  // ③ quotes[] 只增不改（删 = 改；同 `at` 换正文 = 改）
  const bq = before?.quotes ?? [];
  const aq = after?.quotes ?? [];
  const aKeys = new Set(aq.map((q) => `${q.at ?? ''}\u0000${String(q.text ?? '')}`));
  const aByAt = new Map(aq.map((q) => [String(q.at ?? ''), String(q.text ?? '')]));
  for (const q of bq) {
    const key = `${q.at ?? ''}\u0000${String(q.text ?? '')}`;
    if (aKeys.has(key)) continue;
    const sameAt = aByAt.get(String(q.at ?? ''));
    if (sameAt != null) {
      diffs.push({ rule: 'quotes-modified', at: String(q.at ?? ''), beforePreview: preview(q.text), afterPreview: preview(sameAt) });
    } else {
      diffs.push({ rule: 'quotes-removed', at: String(q.at ?? ''), beforePreview: preview(q.text) });
    }
  }
  // ④ 改了内容却没留痕（changedAt 缺失）
  const contentChanged = contentSig(before) !== contentSig(after);
  if (contentChanged && !String(after?.changedAt ?? '').trim()) {
    diffs.push({ rule: 'changedAt-missing', hint: '内容变了但 changedAt 是空的 ⇒ 改锚没留痕（§8.3）' });
  }
  // ② 锚没推进（② 档）：todo → done
  const bStatus = new Map(bc.map((c) => [String(c.id), String(c.status ?? '')]));
  const progress = [];
  for (const c of ac) {
    const id = String(c.id);
    const was = bStatus.get(id);
    const nowS = String(c.status ?? '');
    if (was === 'todo' && nowS === 'done') progress.push(id);
  }
  return { diffs, progress, contentChanged };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function summarizeFindingForLog(f) {
  if (f.kind === 'anchor-forked') return `${f.kind} · ${f.line}（${f.sides.length} 份）`;
  return `${f.kind} · ${f.line}（${f.lineId}）`;
}

export async function run(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error(`--now 认不出：${String(opts.now)}`);
  const nowMs = now.getTime();
  const apply = opts.apply === true;
  const home = path.resolve(opts.home ?? dshHome());
  const nianlunDir = path.resolve(opts.nianlunDir ?? DEFAULT_NIANLUN);
  const snapshotsDir = path.resolve(opts.snapshotsDir ?? DEFAULT_SNAPSHOTS);
  const reportDir = path.resolve(opts.reportDir ?? DEFAULT_REPORT_DIR);
  const stallRounds = Number.isFinite(Number(opts.stallRounds)) ? Number(opts.stallRounds) : STALL_ROUNDS_DEFAULT;
  const flowDays = Number.isFinite(Number(opts.flowDays)) ? Number(opts.flowDays) : FLOW_DAYS_DEFAULT;
  const minInflight = Number.isFinite(Number(opts.minInflight)) ? Number(opts.minInflight) : MIN_INFLIGHT_DEFAULT;
  const keep = Number.isFinite(Number(opts.keep)) ? Number(opts.keep) : SNAP_KEEP_DEFAULT;

  const out = {
    tool: TOOL,
    version: VERSION,
    ts: isoWithOffset(new Date()),
    now: isoWithOffset(now),
    mode: apply ? 'apply' : 'dry-run',
    home,
    nianlunDir,
    snapshotsDir,
    reportDir,
    board: null,
    lines: null,
    tierA: null,
    anchors: [],
    findings: [],
    snapshots: { written: 0, failed: 0, locked: 0, pruned: 0, kept: 0, errors: [], skipped: [] },
    report: { path: null, written: false, error: null },
    notifications: { msgSent: 0, dedupConsumed: 0, lastNotifiedAtWritten: false, reason: 'observe 档：纯观察项不占 msg 日配额、不写 lastNotifiedAt（三红线①）' },
    judge: {
      latencyPromise: '判定 ≤ 2 分钟（tickd job mainline-anchor intervalMs = 2 * MIN）',
      delivery: '受通道配额（现网最坏 = 下一个工作日 08:30）；本件**不投递** —— 换通道 = T-2 待拍板（§8.4）',
    },
    state: 'ok',
    rc: 0,
    warn: [],
  };

  // ① 线表 + 看板
  const linesInfo = loadLines({ home });
  out.lines = { state: linesInfo.state, count: linesInfo.lines.length, file: linesInfo.file ?? null, error: linesInfo.error };
  const board = await loadBoard({ home, boardFile: opts.boardFile ?? null, timeoutMs: opts.timeoutMs });
  out.board = {
    state: board.state, source: board.source, revision: board.revision,
    cards: board.cards.filter((t) => !t.archivedAt).length,
    archived: board.cards.filter((t) => !!t.archivedAt).length,
    error: board.error,
  };
  if (board.error) out.warn.push(board.error);
  if (!Array.isArray(linesInfo.lines) || linesInfo.lines.length === 0) {
    out.warn.push(`线表读不到（${linesInfo.error}）⇒ 档 A 名单不可算；锚侧检测照跑`);
  }

  // ② 档 A
  let tierA = null;
  if (board.state === 'ok' && linesInfo.lines.length) {
    tierA = computeTierA({ lines: linesInfo.lines, cards: board.cards, nowMs, flowDays, minInflight });
    out.tierA = tierA;
  } else {
    out.tierA = { count: null, minInflight, flowDays, lines: [], excluded: [], unmapped: [], unmappedTotal: null, unavailable: true,
      error: board.state !== 'ok' ? `看板不可用：${board.error}` : `线表不可用：${linesInfo.error}` };
  }

  // ③ 读全部锚（forked 用）
  const files = listAnchorFiles(nianlunDir);
  const anchorByLineId = new Map();
  const fileByLineId = new Map();
  for (const f of files) {
    const r = readAnchor(f.file);
    const rel = path.relative(DSH_ROOT, f.file);
    const rec = {
      lineId: r.anchor?.lineId ?? f.lineId,
      line: r.anchor?.line ?? null,
      file: f.file,
      path: rel,
      state: r.state,
      error: r.error ?? null,
      missing: r.missing ?? null,
      criteria: r.anchor ? r.anchor.criteria.length : null,
      quotes: r.anchor ? r.anchor.quotes.length : null,
      updatedAt: r.anchor?.updatedAt ?? null,
      changedAt: r.anchor?.changedAt ?? '',
      aliases: r.anchor?.aliases ?? [],
      mtimeMs: r.mtimeMs,
      anchor: r.anchor,
    };
    out.anchors.push(rec);
    if (!fileByLineId.has(f.lineId)) fileByLineId.set(f.lineId, rec);
    if (rec.state === 'ok') {
      // 同一 lineId 两份锚（文件名撞）⇒ 记一条，别静默丢一份
      if (anchorByLineId.has(rec.lineId)) out.warn.push(`同一 lineId 出现两份锚：${rec.lineId}（${anchorByLineId.get(rec.lineId).path} / ${rec.path}）`);
      else anchorByLineId.set(rec.lineId, rec);
    }
    if (rec.state === 'anchor-broken') {
      out.findings.push({
        kind: 'anchor-broken', level: 'yellow', lineId: f.lineId, line: rec.line ?? f.lineId,
        path: rec.path, error: rec.error, missing: rec.missing,
        note: '坏 JSON / 缺字段 —— **绝不当"没漂移"**（§8.4 失败出口）',
      });
    }
  }

  // ②' 档 A 的「没挂锚」与「读不到」
  const tierALineIds = new Set((tierA?.lines ?? []).map((l) => l.lineId));
  for (const l of tierA?.lines ?? []) {
    const rec = fileByLineId.get(l.lineId) ?? null;
    const hasFile = !!rec;
    const snaps = listSnapshots(snapshotsDir, l.lineId);
    if (!hasFile) {
      const everHad = snaps.length > 0;
      out.findings.push({
        kind: everHad ? 'anchor-missing' : 'no-anchor',
        level: 'info',
        lineId: l.lineId, line: l.line,
        path: anchorPath(nianlunDir, l.lineId),
        snapshots: snaps.length,
        note: everHad
          ? '该线**有快照历史**但锚文件现在没了 ⇒ 判异常（不是"没挂锚"）'
          : '档 A 线还没建锚 ⇒ 按 §8.4① 进月度盘点，**不进日报红**',
      });
      continue;
    }
    if (rec.state === 'anchor-missing') {
      out.findings.push({ kind: 'anchor-missing', level: 'yellow', lineId: l.lineId, line: l.line, path: rec.path, error: rec.error,
        note: '锚文件读不到 —— 绝不当"没漂移"' });
    }
  }
  for (const [lineId, rec] of fileByLineId) {
    if (rec.state !== 'anchor-missing') continue;
    if (tierALineIds.has(lineId)) continue; // 档 A 已在上面的循环里记过
    out.findings.push({ kind: 'anchor-missing', level: 'yellow', lineId, line: rec.line ?? lineId, path: rec.path, error: rec.error,
      note: '锚文件读不到（非档 A 线）—— 绝不当"没漂移"' });
  }

  // ④ 逐线比快照 ⇒ shrink / unmarked-change / stalled
  const snapshotsByLine = new Map();
  for (const rec of out.anchors) {
    if (rec.state !== 'ok') continue;
    const prev = readLatestSnapshot(snapshotsDir, rec.lineId);
    const diff = prev?.snapshot ? diffAnchors(prev.snapshot.anchor, rec.anchor) : { diffs: [], progress: [], contentChanged: false };
    const beforeSum = prev?.snapshot ? summarizeAnchor(prev.snapshot.anchor) : null;
    const afterSum = summarizeAnchor(rec.anchor);

    // 第二次对照：锚**自报**的 before/after（有人手改时留下的痕迹；只作旁证，不替代快照）
    const selfBefore = rec.anchor?.before && typeof rec.anchor.before === 'object' ? rec.anchor.before : null;

    const shrinkDiffs = diff.diffs.filter((d) => d.rule !== 'changedAt-missing');
    if (prev?.broken) {
      out.warn.push(`上一份快照坏了（${rec.lineId}）：${prev.error} ⇒ 本轮没有基线，before/after 不作数`);
    }
    if (shrinkDiffs.length) {
      out.findings.push({
        kind: 'anchor-shrunk', level: 'yellow', lineId: rec.lineId, line: rec.line, path: rec.path,
        baseline: prev?.file ? path.relative(DSH_ROOT, prev.file) : null,
        diffs: shrinkDiffs,
        before: beforeSum, after: afterSum,
        selfReported: selfBefore ? { before: summarizeAnchor(selfBefore), after: rec.anchor?.after ? summarizeAnchor(rec.anchor.after) : null, why: rec.anchor?.why ?? '', by: rec.anchor?.by ?? '', changedAt: rec.anchor?.changedAt ?? '' } : null,
        note: '拿**上一份快照**当基线（§8.3）：before/after 只跟它比',
      });
    } else if (diff.contentChanged && !String(rec.anchor?.changedAt ?? '').trim()) {
      out.findings.push({
        kind: 'anchor-unmarked-change', level: 'yellow', lineId: rec.lineId, line: rec.line, path: rec.path,
        baseline: prev?.file ? path.relative(DSH_ROOT, prev.file) : null,
        diffs: diff.diffs,
        before: beforeSum, after: afterSum,
        note: '内容变了、但没命中"缩"的三条，**且 changedAt 是空的** —— 改了却没说为什么（留了痕的改动不报这条）',
      });
    }

    // ② 锚没推进（按日轮计：快照一天一份，2 分钟档只刷新当日那份）
    const prevMeta = prev?.snapshot?.meta ?? {};
    const prevDay = prevMeta.lastProgressDay ?? null;
    const todayKey = dayKey(new Date(nowMs));
    let stall = Number.isFinite(Number(prevMeta.stallRounds)) ? Number(prevMeta.stallRounds) : 0;
    let lastProgressDay = prevDay;
    let lastProgressAt = prevMeta.lastProgressAt ?? null;
    if (diff.progress.length) {
      stall = 0;
      lastProgressDay = todayKey;
      lastProgressAt = out.now;
    } else if (prev?.snapshot && prevDay && prevDay !== todayKey) {
      stall += 1;
    } else if (prev?.snapshot && !prevDay) {
      stall = 0;
    }
    const criteriaCount = rec.anchor.criteria.length;
    if (stall >= stallRounds && criteriaCount > 0) {
      out.findings.push({
        kind: 'anchor-stalled', level: 'yellow', lineId: rec.lineId, line: rec.line, path: rec.path,
        stallRounds: stall, threshold: stallRounds,
        lastProgressAt, criteriaCount,
        note: `连续 ${stall} 日轮没有任何 criteria[].status 从 todo→done ⇒ 这条线在忙，但离靶没近`,
      });
    }
    if (criteriaCount === 0) {
      out.warn.push(`${rec.lineId} 的锚 criteria[] 是空的 ⇒ 「锚没推进」「缩条数」两条判据对它**无意义**（先补判据）`);
    }
    snapshotsByLine.set(rec.lineId, { meta: { stallRounds: stall, lastProgressDay, lastProgressAt, sig: afterSum.sig },
      anchor: rec.anchor, line: rec.line });
  }

  // ⑤ anchor-forked（同一逻辑线在两台机上各有一份；**线号不参与**）
  const groups = new Map();
  for (const rec of out.anchors) {
    if (rec.state !== 'ok') continue;
    const key = forkKey(rec.anchor);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  for (const [key, recs] of groups) {
    if (recs.length < 2) continue;
    const lineIds = new Set(recs.map((r) => r.lineId));
    out.findings.push({
      kind: 'anchor-forked', level: 'yellow',
      line: recs[0].line, lineId: recs.map((r) => r.lineId).join('+'),
      key, sides: recs.map((r) => ({
        lineId: r.lineId, line: r.line, path: r.path,
        criteria: r.criteria, quotes: r.quotes, updatedAt: r.updatedAt,
        updatedAtMtime: r.mtimeMs ? isoWithOffset(new Date(r.mtimeMs)) : null,
        changedAt: r.changedAt,
      })),
      lineIdCount: lineIds.size,
      note: '同一条逻辑线在两台机各有一份锚（文件名带 lineId ⇒ 同步器不当同一份文件）—— 附两侧各自条数与 updatedAt',
    });
  }

  // ⑥ 快照落盘（--apply 才写）+ 保留策略
  if (apply) {
    for (const rec of out.anchors) {
      if (rec.state !== 'ok') continue;
      if (!LINE_ID_RE.test(rec.lineId) || !/^[a-z0-9-]+$/.test(rec.lineId)) {
        out.snapshots.skipped.push({ lineId: rec.lineId, why: 'lineId 含非法字符 ⇒ 不许拼进锁名' });
        continue;
      }
      const lockName = `${LOCK_PREFIX}${rec.lineId}`;
      // ⚠️ env:{} **不可省**：交接窗口里若继承父锁，这把线锁就是假的（§5.0 第 11 行）
      // ⚠️ autoReleaseOnExit:false + finally 里显式 release —— 一次运行要给**每一条线**各抢一把锁，
      //    每把锁再挂一个 exit 钩子，锚一多就会撞 EventEmitter 的 10 个监听上限（实测 11 个就告警）。
      //    TTL 30 s 兜住"进程被强杀"这种兜不住的情况。
      const lock = acquireTickLock(lockName, { ttlMs: LOCK_TTL_MS, home, env: {}, autoReleaseOnExit: false });
      if (!lock.ok) {
        out.snapshots.locked += 1;
        out.snapshots.skipped.push({ lineId: rec.lineId, why: `锁没抢到：${lock.reason ?? 'held'}` });
        continue;
      }
      try {
        const file = snapshotFile(snapshotsDir, rec.lineId, now);
        const s = snapshotsByLine.get(rec.lineId);
        const body = {
          v: 1,
          lineId: rec.lineId,
          line: rec.line,
          takenAt: out.now,
          baselineIs: '上一份快照（本文件写盘前的同名/上一日那份）',
          anchor: rec.anchor,
          meta: s?.meta ?? { stallRounds: 0, lastProgressDay: null, lastProgressAt: null, sig: contentSig(rec.anchor) },
        };
        writeJsonAtomic(file, body);
        out.snapshots.written += 1;
        // 保留策略：每线最近 N 份（按文件名日期排序、不看内容；删第 N+1 份起）
        const all = listSnapshots(snapshotsDir, rec.lineId);
        if (all.length > keep) {
          for (const victim of all.slice(keep)) {
            try { fs.unlinkSync(victim.file); out.snapshots.pruned += 1; }
            catch (e) { out.warn.push(`超龄快照删不掉：${victim.name}（${e?.code ?? e?.message ?? e}）`); }
          }
        }
        out.snapshots.kept += Math.min(all.length, keep);
      } catch (e) {
        out.snapshots.failed += 1;
        out.snapshots.errors.push({ lineId: rec.lineId, error: String(e?.message ?? e) });
      } finally {
        try { lock.release(); } catch { /* 退出钩子兜底 */ }
      }
    }
  }

  // ⑦ 日报（每轮覆盖写，不 append ⇒ 2 分钟档不会刷屏）
  out.findings.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.line).localeCompare(String(b.line)));
  out.counts = countByKind(out.findings);
  const reportPath = path.join(reportDir, `anchor-${dayKeyDash(new Date(nowMs))}.md`);
  const md = renderDailyReport(out);
  if (apply) {
    try {
      writeTextAtomic(reportPath, md);
      out.report.path = path.relative(DSH_ROOT, reportPath);
      out.report.written = true;
    } catch (e) {
      out.report.error = String(e?.message ?? e);
      out.report.path = path.relative(DSH_ROOT, reportPath);
    }
  } else {
    out.report.path = path.relative(DSH_ROOT, reportPath);
    out.report.written = false;
    out.report.preview = md;
  }

  // ⑧ 判定 + 出口
  const boardUnavailable = board.state !== 'ok';
  if (out.snapshots.failed > 0 || out.report.error) {
    out.state = 'snapshot-write-failed';
    out.rc = 3;
    const why = out.snapshots.failed > 0
      ? `快照写不下去：${out.snapshots.errors.map((e) => `${e.lineId}:${e.error}`).join('；')}`
      : `日报写不下去：${out.report.error}`;
    // 「日报一行」：写进今天那份日报（若日报本身写不下去，退到告警日志，绝不静默）
    out.warn.push(`rc=3 · ${why}（跳过 = 基线断，before/after 失效）`);
    if (apply) {
      try {
        writeTextAtomic(reportPath, renderDailyReport(out));
        out.report.written = true;
      } catch (e2) {
        try {
          fs.appendFileSync(path.join(home, 'butler-alert.log'),
            `[${out.ts}] ${TOOL}: rc=3 · ${why}（日报也写不下去：${e2?.message ?? e2}）\n`, 'utf8');
        } catch { /* 最后一道也写不下去 —— stderr 兜底 */ }
        process.stderr.write(`${TOOL}: rc=3 · ${why} · 日报写不下去：${e2?.message ?? e2}\n`);
      }
    }
  } else if (boardUnavailable && out.anchors.length === 0) {
    out.state = 'unavailable';
    out.rc = 4;
    out.warn.push(`判定不可用：看板/账本都读不到（${board.error}）且年轮目录没有锚 ⇒ 什么都不许结论`);
  } else {
    out.state = 'ok';
    out.rc = 0;
  }
  return out;
}

export function countByKind(findings) {
  const c = {};
  for (const f of findings) c[f.kind] = (c[f.kind] ?? 0) + 1;
  return c;
}

// ---------------------------------------------------------------------------
// 日报渲染（人读；每轮覆盖）
// ---------------------------------------------------------------------------
export function renderDailyReport(out) {
  const L = [];
  const tierA = out.tierA ?? {};
  const counts = out.counts ?? countByKind(out.findings ?? []);
  const red = out.findings.filter((f) => f.level === 'yellow');
  L.push(`# 锚检测日报 · ${dayKeyDash(new Date(Date.parse(out.now)))}（每轮覆盖写，最新一轮为准）`);
  L.push('');
  L.push('> **判定 ≤ 2 分钟可以承诺**（tickd `mainline-anchor` 2 分钟档）；**投递受通道配额**（现网最坏 = 下一个工作日 08:30）。'
    + '本件**不投递**（换通道 = T-2 待拍板，§8.4）。');
  L.push('> 观察项**不占 msg 日配额、不写 `lastNotifiedAt`**（判定类三红线①）。');
  L.push(`> 数据源：\`docs\\年轮\\*-anchor.json\` · \`_archive\\anchor-snapshots\\\` · 看板 state（source=${out.board?.source ?? '?'} · revision=${out.board?.revision ?? '?'}）。`);
  L.push('');
  L.push('## 摘要');
  L.push('');
  L.push(`- 模式：${out.mode} · ${out.state} · rc=${out.rc} · ${out.now}`);
  L.push(`- 档 A（在途 ≥${tierA.minInflight ?? '?'} 且近 ${tierA.flowDays ?? '?'} 天有流水）：**${tierA.count ?? '不可用'} 条**`
    + `（看板在板 ${out.board?.cards ?? '?'} 卡 / 线表 ${out.lines?.count ?? '?'} 条）`);
  if (tierA.unavailable) L.push(`  - ⚠️ 档 A 不可算：${tierA.error}`);
  const noAnchor = (out.findings ?? []).filter((f) => f.kind === 'no-anchor');
  L.push(`- 已挂锚 ${out.anchors.filter((a) => a.state === 'ok').length} 份 · 未建锚 ${noAnchor.length} 条（按 §8.4① 进月度盘点，**不进日报红**）`);
  L.push(`- 漂移告警（黄）：**${red.length}** 条 —— ` + (red.length
    ? Object.entries(counts).filter(([k]) => k !== 'no-anchor').map(([k, v]) => `${k} ${v}`).join(' / ')
    : '无'));
  L.push(`- 快照：写 ${out.snapshots.written} · 失败 ${out.snapshots.failed} · 锁让路 ${out.snapshots.locked} · 裁掉超龄 ${out.snapshots.pruned}（保留 ${out.snapshots.kept}）`);
  if (out.warn.length) {
    L.push('');
    L.push('## ⚠️ 读不动 / 边界');
    L.push('');
    for (const w of out.warn.slice(0, 20)) L.push(`- ${w}`);
  }
  L.push('');
  L.push('## 逐条');
  L.push('');
  const order = ['anchor-shrunk', 'anchor-changed', 'anchor-unmarked-change', 'anchor-forked', 'anchor-stalled', 'anchor-broken', 'anchor-missing', 'no-anchor'];
  const pick = (k) => (out.findings ?? []).filter((f) => f.kind === k);
  for (const kind of order) {
    const rows = pick(kind);
    if (!rows.length) continue;
    L.push(`### ${kind}（${rows.length}）`);
    L.push('');
    for (const f of rows.slice(0, 10)) {
      L.push(`- **${f.line ?? '?'}**（\`${f.lineId}\`）${f.path ? ` · \`${f.path}\`` : ''}`);
      if (f.kind === 'anchor-forked') {
        for (const s of f.sides) L.push(`  - \`${s.lineId}\`：${s.criteria} 条判据 / ${s.quotes} 条引语 · updatedAt=${s.updatedAt ?? 'null'} · 文件 mtime=${s.updatedAtMtime ?? '?'}`);
      }
      for (const d of f.diffs ?? []) {
        if (d.rule === 'criteria-count') L.push(`  - 判据条数 ${d.before} → ${d.after}${d.removed?.length ? `（少了：${d.removed.join('、')}）` : ''}`);
        else if (d.rule === 'criteria-text') L.push(`  - 措辞缩短 ${d.id}：${d.beforeLen} → ${d.afterLen} 字（${Math.round((1 - d.ratio) * 100)}%）：「${d.beforePreview}」→「${d.afterPreview}」`);
        else if (d.rule === 'quotes-removed') L.push(`  - 引语被删（at=${d.at || '?'}）：「${d.beforePreview}」`);
        else if (d.rule === 'quotes-modified') L.push(`  - 引语被改（at=${d.at || '?'}）：「${d.beforePreview}」→「${d.afterPreview}」`);
        else if (d.rule === 'changedAt-missing') L.push(`  - ${d.hint}`);
      }
      if (f.kind === 'anchor-stalled') L.push(`  - 连续 ${f.stallRounds}/${f.threshold} 日轮无 todo→done（判据 ${f.criteriaCount} 条；上次推进 ${f.lastProgressAt ?? '从未'}）`);
      if (f.kind === 'anchor-broken') L.push(`  - ${f.error}${f.missing?.length ? `（缺：${f.missing.join('、')}）` : ''}`);
      if (f.baseline) L.push(`  - 基线：\`${f.baseline}\``);
      if (f.kind === 'no-anchor') L.push(`  - ${f.note}`);
      if (f.kind === 'anchor-missing') L.push(`  - ${f.note ?? ''}${f.error ? `（${f.error}）` : ''}`);
    }
    if (rows.length > 10) L.push(`- ……另有 ${rows.length - 10} 条（见 \`--json\` 落盘）`);
    L.push('');
  }
  if (!(out.findings ?? []).length) L.push('（本轮无发现）');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 自检（12 条夹具；全部在临时目录里，零生产写入）
// ---------------------------------------------------------------------------
async function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-watch-st-'));
  const results = [];
  const t = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e?.message ?? String(e) }); }
  };
  const tAsync = async (name, fn) => {
    try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e?.message ?? String(e) }); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const mk = (p) => { fs.mkdirSync(p, { recursive: true }); };
  const anchorOf = (lineId, line, criteria, quotes = []) => ({
    v: 1, lineId, line, aliases: [], updatedAt: '2026-11-04T01:00:00+08:00',
    criteria, quotes, changedAt: '', before: null, after: null, why: '', by: '',
  });
  const crit = (n) => Array.from({ length: n }, (_, i) => ({ id: `A-${i + 1}`, text: `判据正文第 ${i + 1} 条，要有一定长度才能比出缩短`, status: 'todo' }));

  // ── 1 缩条数 ⇒ anchor-shrunk（正例）
  await tAsync('1 shrink: 少一条判据 ⇒ anchor-shrunk + before/after', async () => {
    const home = path.join(root, 'f1', 'home'); mk(home);
    writeLines(home, [{ lineId: 'l-host-901', line: '夹具线甲', aliases: [] }]);
    const nl = path.join(root, 'f1', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f1', 'snap'); mk(sp);
    fs.writeFileSync(path.join(nl, 'l-host-901-anchor.json'), JSON.stringify(anchorOf('l-host-901', '夹具线甲', crit(4))), 'utf8');
    await run({ ...baseOpts(home, nl, sp), apply: true, now: '2026-11-04T10:00:00+08:00', boardFile: boardFixture(root, 'f1', [card('夹具线甲', 'todo')]) });
    const after = anchorOf('l-host-901', '夹具线甲', crit(3));
    fs.writeFileSync(path.join(nl, 'l-host-901-anchor.json'), JSON.stringify(after), 'utf8');
    const r = await run({ ...baseOpts(home, nl, sp), apply: false, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f1', [card('夹具线甲', 'todo')]) });
    const hit = r.findings.find((f) => f.kind === 'anchor-shrunk');
    assert(hit, `没报 anchor-shrunk（findings=${r.findings.map((f) => f.kind).join(',')}）`);
    assert(hit.before?.criteriaCount === 4 && hit.after?.criteriaCount === 3, 'before/after 条数不对');
    assert(hit.diffs.some((d) => d.rule === 'criteria-count'), '缺 criteria-count 差异项');
  });

  // ── 2 措辞砍一半 ⇒ anchor-shrunk（正例）
  await tAsync('2 shrink: 措辞缩 >30% ⇒ criteria-text', async () => {
    const home = path.join(root, 'f2', 'home'); mk(home);
    writeLines(home, [{ lineId: 'l-host-902', line: '夹具线乙', aliases: [] }]);
    const nl = path.join(root, 'f2', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f2', 'snap'); mk(sp);
    fs.writeFileSync(path.join(nl, 'l-host-902-anchor.json'), JSON.stringify(anchorOf('l-host-902', '夹具线乙', crit(2))), 'utf8');
    await run({ ...baseOpts(home, nl, sp), apply: true, now: '2026-11-04T10:00:00+08:00', boardFile: boardFixture(root, 'f2', [card('夹具线乙', 'todo')]) });
    const shrunk = crit(2); shrunk[0].text = '判据一';
    fs.writeFileSync(path.join(nl, 'l-host-902-anchor.json'), JSON.stringify(anchorOf('l-host-902', '夹具线乙', shrunk)), 'utf8');
    const r = await run({ ...baseOpts(home, nl, sp), apply: false, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f2', [card('夹具线乙', 'todo')]) });
    const hit = r.findings.find((f) => f.kind === 'anchor-shrunk');
    assert(hit && hit.diffs.some((d) => d.rule === 'criteria-text'), '没报措辞缩短');
  });

  // ── 3 反例：原样不动再跑 ⇒ 必须不报（证明不是恒真）
  await tAsync('3 阴性：锚原样不动 ⇒ 不报 anchor-shrunk', async () => {
    const home = path.join(root, 'f3', 'home'); mk(home);
    writeLines(home, [{ lineId: 'l-host-903', line: '夹具线丙', aliases: [] }]);
    const nl = path.join(root, 'f3', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f3', 'snap'); mk(sp);
    fs.writeFileSync(path.join(nl, 'l-host-903-anchor.json'), JSON.stringify(anchorOf('l-host-903', '夹具线丙', crit(3))), 'utf8');
    await run({ ...baseOpts(home, nl, sp), apply: true, now: '2026-11-04T10:00:00+08:00', boardFile: boardFixture(root, 'f3', [card('夹具线丙', 'todo')]) });
    const r = await run({ ...baseOpts(home, nl, sp), apply: false, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f3', [card('夹具线丙', 'todo')]) });
    assert(!r.findings.some((f) => f.kind === 'anchor-shrunk' || f.kind === 'anchor-unmarked-change'),
      `原样不动却报了：${r.findings.map((f) => f.kind).join(',')}`);
  });

  // ── 4 引语被改 ⇒ 报（quotes 只增不改）
  await tAsync('4 shrink: 引语被改 ⇒ quotes-modified', async () => {
    const home = path.join(root, 'f4', 'home'); mk(home);
    writeLines(home, [{ lineId: 'l-host-904', line: '夹具线丁', aliases: [] }]);
    const nl = path.join(root, 'f4', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f4', 'snap'); mk(sp);
    const q = [{ at: '2026-11-01T23:05:20+08:00', by: '主人', text: '……我能做的就是多那么几个入口……' }];
    fs.writeFileSync(path.join(nl, 'l-host-904-anchor.json'), JSON.stringify(anchorOf('l-host-904', '夹具线丁', crit(2), q)), 'utf8');
    await run({ ...baseOpts(home, nl, sp), apply: true, now: '2026-11-04T10:00:00+08:00', boardFile: boardFixture(root, 'f4', [card('夹具线丁', 'todo')]) });
    const q2 = [{ at: '2026-11-01T23:05:20+08:00', by: '主人', text: '……几个入口……' }];
    fs.writeFileSync(path.join(nl, 'l-host-904-anchor.json'), JSON.stringify(anchorOf('l-host-904', '夹具线丁', crit(2), q2)), 'utf8');
    const r = await run({ ...baseOpts(home, nl, sp), apply: false, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f4', [card('夹具线丁', 'todo')]) });
    const hit = r.findings.find((f) => f.kind === 'anchor-shrunk');
    assert(hit && hit.diffs.some((d) => d.rule === 'quotes-modified'), '没报引语被改');
  });

  // ── 5 forked 正例：同 line、不同 lineId（不同 host 段）
  await tAsync('5 forked 正例：同 line 不同 lineId ⇒ anchor-forked', async () => {
    const home = path.join(root, 'f5', 'home'); mk(home);
    writeLines(home, [{ lineId: 'l-host-905', line: '夹具线戊', aliases: ['戊线别名'] }]);
    const nl = path.join(root, 'f5', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f5', 'snap'); mk(sp);
    fs.writeFileSync(path.join(nl, 'l-host-905-anchor.json'), JSON.stringify(anchorOf('l-host-905', '夹具线戊', crit(3))), 'utf8');
    const other = anchorOf('l-other-012', '夹具线戊', crit(2));
    other.aliases = [];
    other.updatedAt = '2026-11-03T09:00:00+08:00';
    fs.writeFileSync(path.join(nl, 'l-other-012-anchor.json'), JSON.stringify(other), 'utf8');
    const r = await run({ ...baseOpts(home, nl, sp), apply: false, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f5', [card('夹具线戊', 'todo')]) });
    const hit = r.findings.find((f) => f.kind === 'anchor-forked');
    assert(hit, '没报 anchor-forked');
    assert(hit.sides.length === 2, `两侧应有 2 份，实为 ${hit.sides.length}`);
    assert(hit.sides.every((s) => s.criteria != null && s.updatedAt != null), '两侧条数/updatedAt 没列全');
  });

  // ── 6 forked 反例：不同 line、同线号 ⇒ 必须不报（假阳性判据）
  await tAsync('6 forked 反例：不同 line 同线号 ⇒ 不报', async () => {
    const home = path.join(root, 'f6', 'home'); mk(home);
    writeLines(home, [{ lineId: 'l-host-906', line: '夹具线己', aliases: [] }]);
    const nl = path.join(root, 'f6', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f6', 'snap'); mk(sp);
    fs.writeFileSync(path.join(nl, 'l-host-906-anchor.json'), JSON.stringify(anchorOf('l-host-906', '夹具线己', crit(2))), 'utf8');
    fs.writeFileSync(path.join(nl, 'l-other-906-anchor.json'), JSON.stringify(anchorOf('l-other-906', '完全不同的另一条线', crit(2))), 'utf8');
    const r = await run({ ...baseOpts(home, nl, sp), apply: false, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f6', [card('夹具线己', 'todo')]) });
    assert(!r.findings.some((f) => f.kind === 'anchor-forked'), `假阳性：不该报 forked（${r.findings.map((f) => f.kind).join(',')}）`);
  });

  // ── 7 档 A 线没挂锚 ⇒ no-anchor（info，不进日报红）
  await tAsync('7 no-anchor：档 A 线没锚 ⇒ info', async () => {
    const home = path.join(root, 'f7', 'home'); mk(home);
    writeLines(home, [{ lineId: 'l-host-907', line: '夹具线庚', aliases: [] }]);
    const nl = path.join(root, 'f7', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f7', 'snap'); mk(sp);
    const r = await run({ ...baseOpts(home, nl, sp), apply: false, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f7', [card('夹具线庚', 'running')]) });
    const hit = r.findings.find((f) => f.kind === 'no-anchor');
    assert(hit && hit.level === 'info', 'no-anchor 没报或不是 info');
  });

  // ── 8 坏 JSON ⇒ anchor-broken（黄），不是"没漂移"
  await tAsync('8 坏 JSON ⇒ anchor-broken', async () => {
    const home = path.join(root, 'f8', 'home'); mk(home);
    writeLines(home, [{ lineId: 'l-host-908', line: '夹具线辛', aliases: [] }]);
    const nl = path.join(root, 'f8', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f8', 'snap'); mk(sp);
    fs.writeFileSync(path.join(nl, 'l-host-908-anchor.json'), '{oops', 'utf8');
    const r = await run({ ...baseOpts(home, nl, sp), apply: false, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f8', [card('夹具线辛', 'todo')]) });
    assert(r.findings.some((f) => f.kind === 'anchor-broken' && f.level === 'yellow'), '坏 JSON 没报 anchor-broken');
  });

  // ── 9 保留策略 30 份（31 ⇒ 裁 1，按文件名日期）
  await tAsync('9 快照保留 30 份（第 31 份被裁）', async () => {
    const home = path.join(root, 'f9', 'home'); mk(home);
    writeLines(home, []);
    const nl = path.join(root, 'f9', 'nianlun'); mk(nl);
    const sp = path.join(root, 'f9', 'snap'); mk(sp);
    fs.writeFileSync(path.join(nl, 'l-host-909-anchor.json'), JSON.stringify(anchorOf('l-host-909', '夹具线壬', crit(2))), 'utf8');
    for (let d = 1; d <= 31; d += 1) {
      const day = `202610${String(d).padStart(2, '0')}`;
      fs.writeFileSync(path.join(sp, `l-host-909-${day}.json`), JSON.stringify({ v: 1, lineId: 'l-host-909', line: '夹具线壬', takenAt: 'x', anchor: anchorOf('l-host-909', '夹具线壬', crit(2)), meta: { stallRounds: 0 } }), 'utf8');
    }
    const r = await run({ ...baseOpts(home, nl, sp), apply: true, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f9', []) });
    const left = listSnapshots(sp, 'l-host-909');
    assert(left.length === 30, `应留 30 份，实为 ${left.length}`);
    assert(!left.some((s) => s.name.endsWith('20261001.json')), '最老那份没被裁');
    assert(r.snapshots.pruned >= 1, 'pruned 计数没涨');
  });

  // ── 10 快照写不下去 ⇒ rc=3 + 日报有行
  await tAsync('10 快照写不下去 ⇒ rc=3 + 日报一行', async () => {
    const home = path.join(root, 'f10', 'home'); mk(home);
    writeLines(home, []);
    const nl = path.join(root, 'f10', 'nianlun'); mk(nl);
    const blocker = path.join(root, 'f10', 'blocker'); fs.writeFileSync(blocker, 'x', 'utf8'); // 文件冒充目录
    fs.writeFileSync(path.join(nl, 'l-host-910-anchor.json'), JSON.stringify(anchorOf('l-host-910', '夹具线癸', crit(2))), 'utf8');
    const r = await run({ ...baseOpts(home, nl, blocker), apply: true, now: '2026-11-04T10:02:00+08:00', boardFile: boardFixture(root, 'f10', []) });
    assert(r.rc === 3, `rc 应为 3，实为 ${r.rc}`);
    assert(r.snapshots.failed >= 1, '失败计数没涨');
    assert((r.warn ?? []).some((w) => w.includes('rc=3')), '没有 rc=3 的说明行');
  });

  // ── 11 敏感串软校验：阴性（§8.3 例句 0 误报）+ 阳性
  await tAsync('11 敏感串：例句 0 误报 / sk- 必命中', async () => {
    const samples = [
      '……我能做的就是多那么几个入口……',
      '让主人只需要做一个决定：看图和听声音。',
      '不交接，只滚动清理上下文，自动记忆',
      '2026-11-01 23:05:20 主人原话：整夜推进',
    ];
    for (const s of samples) assert(!secretHits(s).length, `误报：${s} ⇒ ${secretHits(s).join(',')}`);
    assert(secretHits('token = ' + ['s', 'k', '-'].join('') + 'x'.repeat(40)).includes('sk-'), 'sk- 没命中');
    assert(secretHits('Authorization: Bearer abc').includes('Bearer '), 'Bearer 没命中');
    assert(secretHits('password=hunter2').includes('password='), 'password= 没命中');
    assert(secretHits('连 ' + ['192', '168', '1', '20'].join('.') + ':3080').includes('内网IP'), '内网 IP 没命中');
  });

  // ── 12 锁名安全 / 默认路径不许出现 offsync
  t('12 路径与锁名：默认快照路径不含 offsync / 非法 lineId 拒拼锁名', () => {
    assert(path.isAbsolute(DEFAULT_SNAPSHOTS), `默认快照路径不是绝对路径：${DEFAULT_SNAPSHOTS}`);
    assert(!DEFAULT_SNAPSHOTS.toLowerCase().includes('offsync'), '默认快照路径落到物理盘了（少一个 n 会造鬼根）');
    assert(!LINE_ID_RE.test('l-host-90'), '两位线号不该过');
    assert(LINE_ID_RE.test('l-host-a-022'), '正常线号没过');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) process.stdout.write(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : ` —— ${r.error}`}\n`);
  process.stdout.write(`\n自检：${results.length - failed.length}/${results.length} 绿\n`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响判定 */ }
  return failed.length ? 5 : 0;
}

function baseOpts(home, nl, sp) {
  return { home, nianlunDir: nl, snapshotsDir: sp, reportDir: path.join(path.dirname(home), 'report') };
}

/**
 * 夹具：把线表塞进**读端给出的**目录（`ledgerDirOf`）。
 * 🔴 不自己拼账本目录名 —— 一旦本文件里出现"写盘 API + 账本目录名"，写者不变量就会把本件判成第二个写者。
 */
function writeLines(home, lines) {
  const dir = ledgerDirOf(home);
  if (!dir) throw new Error('夹具：读端没给出账本目录');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_lines.json'), JSON.stringify({ v: 1, host: 'host', next: 99, lines }, null, 2), 'utf8');
}

let _fixtureBoardSeq = 0;
function card(line, status) {
  return { id: `c-${(_fixtureBoardSeq += 1)}`, line, status, updatedAt: Date.parse('2026-11-04T09:55:00+08:00'), createdAt: Date.parse('2026-11-01T00:00:00+08:00') };
}

function boardFixture(root, tag, tasks) {
  const dir = path.join(root, tag);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify({ revision: 1, tasks }, null, 2), 'utf8');
  return file;
}

/** 敏感串软校验（§5.3 `did/next` 同款口径）：命中即拒写，提示改写。 */
export function secretHits(text) {
  const s = String(text ?? '');
  const hits = [];
  if (/sk-[A-Za-z0-9]{6,}/.test(s)) hits.push('sk-');
  if (/Bearer\s+\S+/i.test(s)) hits.push('Bearer ');
  if (/password\s*=/i.test(s)) hits.push('password=');
  if (/\b(?:10|127|169\.254)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(s)
    || /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/.test(s)
    || /\b192\.168\.\d{1,3}\.\d{1,3}\b/.test(s)) hits.push('内网IP');
  if (/\b(?:token|api[_-]?key|secret)\s*[:=]\s*[A-Za-z0-9_\-]{12,}/i.test(s)) hits.push('令牌赋值');
  return hits;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const a = { _: [], unknown: [] };
  const need = (i, flag) => {
    const v = argv[i + 1];
    if (v == null || String(v).startsWith('--')) return { err: `${flag} 需要值` };
    return { val: v };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') a.apply = true;
    else if (t === '--quiet') a.quiet = true;
    else if (t === '--selftest') a.selftest = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--json') { const r = need(i, t); if (r.err) return { err: r.err }; a.json = r.val; i += 1; }
    else if (t === '--home') { const r = need(i, t); if (r.err) return { err: r.err }; a.home = r.val; i += 1; }
    else if (t === '--nianlun') { const r = need(i, t); if (r.err) return { err: r.err }; a.nianlunDir = r.val; i += 1; }
    else if (t === '--snapshots') { const r = need(i, t); if (r.err) return { err: r.err }; a.snapshotsDir = r.val; i += 1; }
    else if (t === '--report-dir') { const r = need(i, t); if (r.err) return { err: r.err }; a.reportDir = r.val; i += 1; }
    else if (t === '--board') { const r = need(i, t); if (r.err) return { err: r.err }; a.boardFile = r.val; i += 1; }
    else if (t === '--now') { const r = need(i, t); if (r.err) return { err: r.err }; a.now = r.val; i += 1; }
    else if (t === '--stall-rounds') { const r = need(i, t); if (r.err) return { err: r.err }; a.stallRounds = r.val; i += 1; }
    else if (t === '--flow-days') { const r = need(i, t); if (r.err) return { err: r.err }; a.flowDays = r.val; i += 1; }
    else if (t === '--min-inflight') { const r = need(i, t); if (r.err) return { err: r.err }; a.minInflight = r.val; i += 1; }
    else if (t === '--keep') { const r = need(i, t); if (r.err) return { err: r.err }; a.keep = r.val; i += 1; }
    else if (t.startsWith('-')) a.unknown.push(t);
    else a._.push(t);
  }
  return a;
}

const USAGE = `anchor-watch —— 防「偷偷缩目标」的锚检测器（observe 档 · 缺省 dry-run · 零投递）

  node <pkg>/src/dsh-butler/anchor-watch.mjs [选项]

  --apply             真写（快照 + 日报 + 裁超龄）；不给 = dry-run 零写入
  --json <文件>       机读全量落盘（**不上 stdout**；三红线③）
  --quiet             只打一行摘要
  --home <目录>       账本 home（读「_lines.json」；缺省 ~\\.dsh）
  --nianlun <目录>    锚文件目录（缺省 <workspace>\\docs\\年轮）
  --snapshots <目录>  快照目录（缺省 <workspace>\\_archive\\anchor-snapshots）
  --report-dir <目录> 日报目录（缺省 <workspace>\\docs\\管家报告）
  --board <文件>      看板夹具 JSON（跳过 HTTP）
  --now <ISO>         注入时钟（夹具用）
  --stall-rounds N    「锚没推进」阈值（缺省 6 日轮）
  --flow-days N       档 A 的"近 N 天有流水"（缺省 7）
  --min-inflight N    档 A 的"在途卡 ≥N"（缺省 1）
  --keep N            每线保留快照份数（缺省 30）
  --selftest          12 条夹具自检（临时目录，零生产写入）
  --help

退出码：0 正常 / 2 用法错 / 3 快照或日报写不下去 / 4 判定不可用 / 5 自检失败`;

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.err) { process.stderr.write(`${a.err}\n\n${USAGE}\n`); return 2; }
  if (a.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  if (a.unknown.length) { process.stderr.write(`未知参数：${a.unknown.join('、')}\n\n${USAGE}\n`); return 2; }
  if (a.selftest) return selftest();

  const out = await run({
    apply: a.apply === true,
    now: a.now,
    home: a.home,
    nianlunDir: a.nianlunDir,
    snapshotsDir: a.snapshotsDir,
    reportDir: a.reportDir,
    boardFile: a.boardFile,
    stallRounds: a.stallRounds,
    flowDays: a.flowDays,
    minInflight: a.minInflight,
    keep: a.keep,
  });

  if (a.json) {
    try {
      writeJsonAtomic(path.resolve(a.json), out);
    } catch (e) {
      process.stderr.write(`--json 落盘失败：${e?.message ?? e}\n`);
    }
  }

  if (a.quiet) {
    const c = out.counts ?? {};
    process.stdout.write(`${out.tool} ${out.state} rc=${out.rc} · 模式 ${out.mode} · 档A ${out.tierA?.count ?? '?'} · `
      + `锚 ${out.anchors.filter((x) => x.state === 'ok').length} · 告警 ${out.findings.filter((f) => f.level === 'yellow').length}`
      + `（${Object.entries(c).filter(([k]) => k !== 'no-anchor').map(([k, v]) => `${k}:${v}`).join(',') || '无'}）`
      + ` · 快照 写${out.snapshots.written}/失败${out.snapshots.failed}\n`);
  } else {
    const c = out.counts ?? {};
    process.stdout.write(`=== ${out.tool} v${out.version} · ${out.state} · rc=${out.rc} · ${out.mode} ===\n`);
    process.stdout.write(`now=${out.now} · home=${out.home}\n`);
    process.stdout.write(`年轮：${out.nianlunDir}\n快照：${out.snapshotsDir}（每线留 ${SNAP_KEEP_DEFAULT} 份）\n`);
    process.stdout.write(`看板：${out.board.state}（${out.board.source} · revision=${out.board.revision ?? '?'} · ${out.board.cards} 卡）\n`);
    process.stdout.write(`线表：${out.lines.state}（${out.lines.count} 条）\n`);
    process.stdout.write(`档 A：${out.tierA?.count ?? '不可用'} 条（在途 ≥${out.tierA?.minInflight ?? '?'} ∧ 近 ${out.tierA?.flowDays ?? '?'} 天有流水）\n`);
    for (const l of (out.tierA?.lines ?? []).slice(0, 20)) {
      process.stdout.write(`  · ${String(l.inflight).padStart(2)} 在途 | ${l.line}（${l.lineId}）lastFlow=${l.lastFlowAt ?? 'null'}\n`);
    }
    process.stdout.write(`锚：${out.anchors.filter((x) => x.state === 'ok').length} 份可读 / ${out.anchors.length} 个文件\n`);
    process.stdout.write(`发现：${out.findings.length} 条（${Object.entries(c).map(([k, v]) => `${k}:${v}`).join('、') || '无'}）\n`);
    for (const f of out.findings.filter((x) => x.level === 'yellow').slice(0, 20)) {
      process.stdout.write(`  🟡 ${summarizeFindingForLog(f)}${f.diffs?.length ? ` · ${f.diffs.map((d) => d.rule).join('+')}` : ''}\n`);
    }
    process.stdout.write(`快照：写 ${out.snapshots.written} · 失败 ${out.snapshots.failed} · 锁让路 ${out.snapshots.locked} · 裁 ${out.snapshots.pruned}\n`);
    process.stdout.write(`日报：${out.report.written ? '已写 ' : '未写（dry-run）'}${out.report.path}\n`);
    if (out.warn.length) {
      process.stdout.write('提示：\n');
      for (const w of out.warn.slice(0, 10)) process.stdout.write(`  - ${w}\n`);
    }
    process.stdout.write('投递：本件不投递（observe 档 / 三红线①）· 判定 ≤2 分钟可承诺，投递受通道配额（T-2 待拍板）\n');
  }
  return out.rc;
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (invokedDirectly) {
  main().then((rc) => { process.exitCode = rc; }).catch((e) => {
    process.stderr.write(`${TOOL} 崩了：${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
