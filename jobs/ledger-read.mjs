#!/usr/bin/env node
// ============================================================================
// dsh-butler / ledger-read.mjs —— 主线流水小本本的**完整读端**（V9 §5.4 + §5.5 · 12 态）
//
// 出处：docs\方案-三层角色工作方式与主线流水-V9.md
//   §5.0 不变量 1（L165）「**读端零写盘**」—— 本文件不 append、不建目录、不写 suppressed、
//        不做隔离搬迁、**连 writer 模块都不 import**（机械可验：`ledger-writer-audit.mjs`
//        把它列进 `readers`；⚠️ 一旦这里出现写调用或 import writer 的写函数 ⇒ 直接判红）
//   §5.4（L385-418）读入口 / `--json` schema / `--raw --row N` / rate 三条判空规矩 / 跨年退位
//   §5.5（L419-480）12 态 + **判定优先级**（依次判、命中即停）+ 读策略 1/2/4/5 + 降级链
//   §14.3 R-11（L1152）`--now <ISO>` 注入时钟（**禁改系统月份**）
//   §14.3 R-13（L1154）`cardsState` 取不到时不静默（不许当 0 / 当 ok）
//
// 判定优先级（§5.5 读策略 0，**次序即语义**，单点定义在 lib\ledger-phases.mjs#LEDGER_STATES）：
//   lines-map-missing → absent → rotated-new → empty → orphan-file → ledger-broken →
//   ok-gapped → tail-broken → scan-stale → missing-round → logs-archived → ok
//   · `orphan-file` 排在 `ledger-broken` 前：它判的是"这份 .jsonl 根本不属于这条线"，
//     比"这份账坏了几行"更前置 —— 先报"你读错文件了"，人才不会去修一份本来不该读的账（§5.5 L451）。
//   · `scan-stale` 排在 `missing-round` 前：这条线的扫描根本没跑时，"账本没推进"只是它的后果；
//     先报"扫描已停"才让人知道后面那些数都不可信（§5.5 L452）。
//
// 本卡（P1-c）**不做**：`--stale`（P2）· `ledger-scan` / `writeCursor` / `writeRate` /
//   `appendSuppressed` / `quarantineRows` / `ledger-repair`（P2 与后续卡）· 任何写动作。
//
// 三个 home 概念（`--home` 是**唯一**旋钮，缺省 `~/.dsh`）：
//   `<home>\mainline-ledger\`        账本本体（只读）
//   `<home>\sessions\`              本线 sid 的"日志还在不在"（只 readdir 一层组，不解压）
//   `<home>\_archived-sessions\.auto-archive.json` · `<home>\storages\workspace.json`
//                                   归档标记（判 `logs-archived` 的**唯一**依据，§5.1 L211）
//   ⇒ 夹具把这几样一起放进同一个临时 home，就不会碰到真账本（判据：真 home 零改动）。
//
// 用法：
//   node ledger-read.mjs [--line <lineId|线名>] [--last N] [--json] [--raw --row N]
//                        [--home <dir>] [--now <ISO>] [--missing-round-min N] [--scan-stale-min N]
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { hostTag } from '../src/dsh-butler/lib/host-tag.mjs';
import {
  PHASES,
  LEDGER_STATES,
  LEDGER_STATE_KEYS,
  isLedgerState,
  worstState,
} from './lib/ledger-phases.mjs';
import {
  monthOf,
  monthWindow,
  toCompact,
  parseLedgerFileName,
  ledgerFileName,
} from './lib/ledger-month.mjs';
import { readEvents } from './lib/session-events.mjs';

const TOOL = 'ledger-read';
const LEDGER_DIR = 'mainline-ledger';
const LINES_FILE = '_lines.json';
const META_FILE = '_meta.json';
const CURSOR_FILE = '_cursor.json';
const RATES_DIR = '_rates';
const SIDS_DIR = '_sids';
const ARCHIVE_DIR = '_archived-sessions';
const ARCHIVE_MARKER = '.auto-archive.json';
const WORKSPACE_STORAGE = path.join('storages', 'workspace.json');

/** 末行"正在被写"的静默窗（§5.5 读策略 2）：mtime 稳定 ≥5 s 才敢报 `tail-broken` */
const TAIL_STABLE_MS = 5000;
/** `scan-stale` 超龄阈值（§5.4 ①：3 个 2 分钟周期） */
const SCAN_STALE_MIN_DEFAULT = 6;
/** `missing-round` 窗口（§5.5：默认 30 分钟，可配） */
const MISSING_ROUND_MIN_DEFAULT = 30;
/** `missing-round` 最多解压几份日志（成本上界；§5.5 读策略 4：单份 74 ms 平均 / 401 ms 封顶） */
const MISSING_ROUND_MAX_PROBE = 3;
/** lineId 形状（读端自带一份字面判据，**故意不 import writer**） */
const LINE_ID_RE = /^l-[a-z0-9-]+-\d{3,}$/;
/** 裸 uuid（同上） */
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isLineId = (s) => typeof s === 'string' && LINE_ID_RE.test(s);
const isBareUuid = (s) => typeof s === 'string' && BARE_UUID_RE.test(s);
const normSid = (s) => {
  const t = String(s ?? '').trim();
  return t ? t.replace(/^session-/, '').toLowerCase() : null;
};
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// 只读小工具（**一个写 API 都不许出现**）
// ---------------------------------------------------------------------------
function statSafe(p) {
  try { return { ok: true, st: fs.statSync(p) }; } catch (e) { return { ok: false, error: e?.code ?? 'ERR' }; }
}

function isDir(p) {
  const r = statSafe(p);
  return r.ok && r.st.isDirectory();
}

/** 读文本；失败回 `{ok:false, error:<code>}`（**不抛** —— 一条读不了不许炸整次读） */
function readTextSafe(p) {
  try { return { ok: true, text: fs.readFileSync(p, 'utf8') }; } catch (e) { return { ok: false, error: e?.code ?? 'ERR' }; }
}

/**
 * 读一个 JSON 文件。三态要分清（R-13 的根）：
 *   `{ok:true, val}` / `{ok:false, error:'ENOENT'}`（不存在）/ `{ok:false, error:'EPERM'|'EACCES'|…}`
 *   / `{ok:false, error:'JSON'}`（文件在但解不出）⇒ 调用方**不许**把后两者当"空/0"。
 */
function readJsonSafe(p) {
  const t = readTextSafe(p);
  if (!t.ok) return { ok: false, error: t.error };
  try {
    const val = JSON.parse(t.text);
    return { ok: true, val };
  } catch {
    return { ok: false, error: 'JSON' };
  }
}

function isoOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `ts` 字面量 ⇒ 毫秒（带显式偏移按字面算；不带偏移落本机时区） */
function msOfTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const s = String(ts ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    const [y, mo, d, hh, mm, ss] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
    let ms = Date.UTC(y, mo - 1, d, hh, mm, ss, Number(`0.${m[7] ?? 0}`) * 1000);
    if (m[8] && m[8] !== 'Z') {
      const off = m[8].replace(':', '');
      const sign = off[0] === '-' ? -1 : 1;
      const oh = Number(off.slice(1, 3));
      const om = Number(off.slice(3, 5));
      ms -= sign * (oh * 60 + om) * 60 * 1000;
    }
    return Number.isFinite(ms) ? ms : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------
// `_lines.json`（只读自己解析，不借 writer）
// ---------------------------------------------------------------------------
function readLinesMap(dir) {
  const r = readJsonSafe(path.join(dir, LINES_FILE));
  if (!r.ok) return { ok: false, error: r.error, lines: [] };
  const j = r.val;
  if (!j || typeof j !== 'object' || !Array.isArray(j.lines)) return { ok: false, error: 'SHAPE', lines: [] };
  return { ok: true, lines: j.lines.filter((l) => l && isLineId(String(l.lineId))) };
}

function resolveLineIdFromMap(lines, literal) {
  const raw = String(literal ?? '').trim();
  if (!raw) return null;
  if (isLineId(raw)) return raw;
  const k = norm(raw);
  const hit = lines.find((l) => norm(l.line) === k)
    ?? lines.find((l) => (l.alias ?? l.aliases ?? []).some((x) => norm(x) === k));
  return hit?.lineId ?? null;
}

// ---------------------------------------------------------------------------
// 单个主账文件：**逐行隔离解析**（§5.5 读策略 1）
//   · 整文件读 → 按 `\n` 切 → 丢弃最后一个空串 → 逐行 JSON.parse
//   · 解不出 ⇒ 记 badLines、**跳过继续读**（不许整份 parse，不许坏一行就停）
//   · 末行特例（读策略 2）：末行不完整 **且** 文件不以 `\n` 结尾 ⇒ 不算坏行，
//     只看 mtime：未稳定 ⇒ 静默；稳定 ≥5 s ⇒ tail-broken + 余字节数
// ---------------------------------------------------------------------------
function parseLedgerFile(info, baseLineNo) {
  const t = readTextSafe(info.file);
  const st = statSafe(info.file);
  const mtimeMs = st.ok ? Math.round(st.st.mtimeMs) : null;
  const out = { ...info, mtimeMs, rows: [], bad: [], tail: null, lineCount: 0, unreadable: null };
  if (!t.ok) {
    out.unreadable = t.error;
    out.bad.push({ rowNo: baseLineNo + 1, lineNo: 1, reason: `unreadable:${t.error}`, sample: null });
    return out;
  }
  const hasTrailingNewline = t.text.endsWith('\n');
  const parts = t.text.split('\n');
  if (hasTrailingNewline && parts.length && parts[parts.length - 1] === '') parts.pop();
  out.lineCount = parts.length;
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    const rawLine = parts[i].endsWith('\r') ? parts[i].slice(0, -1) : parts[i];
    const rowNo = baseLineNo + i + 1;
    const s = rawLine.trim();
    if (!s) continue; // 空行：既不算行、也不算坏行（但行号照数）
    let obj = null;
    let why = null;
    try {
      obj = JSON.parse(s);
    } catch {
      why = 'json-parse';
    }
    if (why === null && (!obj || typeof obj !== 'object' || Array.isArray(obj))) {
      obj = null;
      why = 'not-object';
    }
    if (why === null) { out.rows.push({ ...obj, __rowNo: rowNo, __file: info.name }); continue; }
    // 末行特例：只有"最后一行且文件没以 \n 结尾"才算"写到一半"
    if (isLast && !hasTrailingNewline) {
      out.tail = { rowNo, lineNo: i + 1, bytes: Buffer.byteLength(rawLine, 'utf8'), reason: why };
      continue;
    }
    out.bad.push({ rowNo, lineNo: i + 1, reason: why, sample: s.slice(0, 120) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// `_cursor.json`（**P2 才有人写**）—— 不存在 ⇒ 不判 `scan-stale`、lastScanAt/scanBudget 全 null
//   形态：`{v:1,cursor,sids:{...},lines:{<lineId>:{lastScanAt,consecutiveMissed,dirtyUnread}}}`
//   另按月分片 `_cursor-<YYYYMM>.json`（§5.0 第 9 行）⇒ 两个都读，晚读的覆盖先读的。
// ---------------------------------------------------------------------------
function readCursor(dir, months) {
  const files = [
    ...months.slice().reverse().map((m) => path.join(dir, `_cursor-${toCompact(m)}.json`)),
    path.join(dir, CURSOR_FILE),
  ];
  const merged = { present: false, lines: {}, sids: {}, job: {}, bad: [] };
  for (const f of files) {
    const r = readJsonSafe(f);
    if (!r.ok) {
      if (r.error !== 'ENOENT') merged.bad.push({ file: path.basename(f), error: r.error });
      continue;
    }
    const j = r.val;
    if (!j || typeof j !== 'object') { merged.bad.push({ file: path.basename(f), error: 'SHAPE' }); continue; }
    merged.present = true;
    Object.assign(merged.lines, j.lines && typeof j.lines === 'object' ? j.lines : {});
    Object.assign(merged.sids, j.sids && typeof j.sids === 'object' ? j.sids : {});
    Object.assign(merged.job, j);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// `_rates\<lineId>.json`（§5.4 L413 三条判空规矩 · 读端**只读不现算不写盘**）
// ---------------------------------------------------------------------------
function readRate(dir, lineId, todayStr) {
  const file = path.join(dir, RATES_DIR, `${lineId}.json`);
  const r = readJsonSafe(file);
  if (!r.ok) {
    return {
      value: null,
      reason: r.error === 'ENOENT'
        // ⚠️ 2026-11-04 订正（统筹线 P2 · B 路已上线）：原文写"P2 未上线"，现在这句会误导
        //    —— 文件不存在 = **B 路还没为这条线算过**（该线没有 sid 集 / 还没轮到他），
        //    不是"扫描器还没上线"。read端仍然只读、不现算（不变量 1）。
        ? 'rate 未算（`_rates\\<lineId>.json` 不存在：B 路还没为这条线算过）'
        : `rate 读不到（${path.basename(file)}:${r.error}）`,
      file,
    };
  }
  const o = r.val && typeof r.val === 'object' ? r.val : {};
  if (o.windowClosed === false) return { value: null, reason: '当日窗口进行中（windowClosed:false）', file };
  const day = String(o.day ?? '');
  if (!day) return { value: null, reason: 'rate 缺 day（读数不可信）', file };
  if (day !== todayStr) return { value: null, reason: `rate 上次算于 ${day}`, file };
  const v = Number(o.value);
  if (!Number.isFinite(v)) return { value: null, reason: `rate 值非法（${String(o.value)}）`, file };
  return { value: v, reason: null, file, day, windowClosed: o.windowClosed === true };
}

// ---------------------------------------------------------------------------
// 归档标记（§5.1 L211 / §5.5 `logs-archived`）
//   **只许读标记** —— 本机 `moveFiles:false` ⇒ 归档只打标不搬文件 ⇒
//   按"日志文件搬到哪去了"判会让这个态**永不触发**。
// ---------------------------------------------------------------------------
function readArchiveMarkers(home) {
  const set = new Set();
  const notes = [];
  const pushAll = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) {
      const b = normSid(x);
      if (b && isBareUuid(b)) set.add(b);
    }
  };
  const aa = readJsonSafe(path.join(home, ARCHIVE_DIR, ARCHIVE_MARKER));
  if (aa.ok) {
    pushAll(aa.val?.state?.lastResult?.archived);
  } else if (aa.error !== 'ENOENT') {
    notes.push(`归档标记读不到（${ARCHIVE_MARKER}:${aa.error}）`);
  }
  const wp = readJsonSafe(path.join(home, WORKSPACE_STORAGE));
  if (wp.ok) {
    const j = wp.val ?? {};
    pushAll(j?.global?.archivedSessionIds);
    pushAll(j?.archivedSessionIds);
    const wss = j?.tables?.workspaces;
    if (Array.isArray(wss)) for (const w of wss) pushAll(w?.archivedSessionIds);
  } else if (wp.error !== 'ENOENT') {
    notes.push(`workspace 归档标记读不到（${wp.error}）`);
  }
  return { set, notes };
}

/** 本机 `sessions\` 树里的会话目录 ⇒ Map<裸sid, 目录>（只 readdir 两层，不解压、不 stat） */
function readSessionIndex(home) {
  const idx = new Map();
  const root = path.join(home, 'sessions');
  let wsEntries = [];
  try { wsEntries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { ok: false, idx }; }
  for (const w of wsEntries) {
    if (!w.isDirectory()) continue;
    const wsDir = path.join(root, w.name);
    let sids = [];
    try { sids = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const e of sids) {
      if (!e.isDirectory()) continue;
      const b = normSid(e.name);
      if (b && isBareUuid(b) && !idx.has(b)) idx.set(b, path.join(wsDir, e.name));
    }
  }
  return { ok: true, idx };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/**
 * 读一次账本（**零写盘**）。`--line` 给了 ⇒ 单线结果；没给 ⇒ 全线下线后的汇总。
 *
 * @param {{home?:string, line?:string|null, last?:number, now?:Date|string,
 *          missingRoundMin?:number, scanStaleMin?:number, probeTurnEnd?:boolean}} [opts]
 * @returns {object} `--json` 的整份 payload（顶层字段见 §5.4 L409）
 */
export function readLedger(opts = {}) {
  const home = path.resolve(opts.home ?? dshHome());
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error(`--now 认不出：${String(opts.now)}`);
  const nowMs = now.getTime();
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const scanStaleMin = Number.isFinite(Number(opts.scanStaleMin)) ? Number(opts.scanStaleMin) : SCAN_STALE_MIN_DEFAULT;
  const missingRoundMin = Number.isFinite(Number(opts.missingRoundMin)) ? Number(opts.missingRoundMin) : MISSING_ROUND_MIN_DEFAULT;
  const probeTurnEnd = opts.probeTurnEnd !== false;

  const dir = path.join(home, LEDGER_DIR);
  const months = monthWindow(now);
  const base = {
    tool: TOOL,
    ts: isoOf(Date.now()),
    now: isoOf(nowMs),
    home,
    dir,
    months,
    lineRequested: opts.line == null || opts.line === '' ? null : String(opts.line),
    lineId: null,
    line: null,
    state: 'ok',
    stateSince: null,
    rows: 0,
    badLines: [],
    tailBytes: 0,
    cardsState: null,
    ledgerSince: null,
    knownSids: 0,
    activeSids: 0,
    archivedSids: 0,
    note: null,
    rate: null,
    lastScanAt: null,
    scanBudget: null,
    lines: [],
    orphans: [],
    files: [],
    badLineDetails: [],
    phases: Object.keys(PHASES).length,
    states: Object.keys(LEDGER_STATES).length,
  };

  // ── ① absent：连目录都不存在（§5.5 表第一行：静默 / 首跑）
  //     ⚠️ 这条必须排在 `lines-map-missing` **之前**：目录都没了 `_lines.json` 当然也没有，
  //        反之会让 `absent` 永远不可达、且全员首跑变 25 条红（那是 absent 这一行要治的病）。
  //        已记进交付报告「待拍板」（V9 §5.5 优先级 0 与表里 absent 判据的字面冲突）。
  if (!isDir(dir)) {
    return finish(base, { state: 'absent', note: '目录不存在（首跑 / 换机），静默' });
  }

  // ── ② lines-map-missing：映射表没了 / `_meta.json` 版本不认 ⇒ 红 + 全线下线
  const map = readLinesMap(dir);
  const meta = readJsonSafe(path.join(dir, META_FILE));
  let schemaNewer = null;
  if (meta.ok && meta.val && typeof meta.val === 'object') {
    const sv = Number(meta.val.schemaVersion ?? 1);
    if (Number.isFinite(sv) && sv > 1) schemaNewer = sv;
  }
  const mapBroken = !map.ok;
  const redMap = schemaNewer !== null || mapBroken;

  // ── ③ 目录顶层清点（只有文件；junction/符号链接不算文件）
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const topFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  const topFileSet = new Set(topFiles);
  const selfUnmapped = `${hostTag()}-unmapped.jsonl`;

  // 孤儿账：**只扫顶层、非递归、跳过 `_` 开头**（`_ops\` / `_quarantine\` 一并排除，
  //   `_ops\_unknown-<YYYYMM>.jsonl` 永远不属于任何 lineId，递归扫就会天天黄）
  const orphans = [];
  if (map.ok) {
    const known = new Set(map.lines.map((l) => String(l.lineId)));
    for (const name of topFiles) {
      if (name.startsWith('_')) continue;
      if (name === selfUnmapped) continue;
      if (!name.toLowerCase().endsWith('.jsonl')) continue;
      const parsed = parseLedgerFileName(name);
      if (!parsed) { orphans.push({ name, lineId: null, why: '不像账本文件名' }); continue; }
      if (!known.has(parsed.lineId)) orphans.push({ name, lineId: parsed.lineId, why: '_lines.json 里没有这个 lineId' });
    }
  }
  base.orphans = orphans;

  // ── ④ 选线：`--line` 给了就只读那条；没给就全线下线
  let targets = [];
  if (base.lineRequested) {
    const wanted = resolveLineIdFromMap(map.lines, base.lineRequested);
    if (!wanted) {
      // 未归线：`_lines.json` 里没有这条线 ⇒ 人传错了（业务上"未归线"是写端的事，读端直接说）
      // ⚠️ 但降级链要求"仍给出最后一次已知状态"：若字面值本身就是合法 lineId，照读它的文件
      const fallback = isLineId(base.lineRequested) ? base.lineRequested : null;
      if (!fallback) {
        return finish(base, {
          state: 'empty',
          rcOverride: 2,
          note: `_lines.json 里没有这条线（${base.lineRequested}）⇒ 读端不猜（写端会把它送进未归线队列）`,
        });
      }
      targets = [{ lineId: fallback, line: null, ledgerSince: null, unknownInMap: true }];
    } else {
      const e = map.lines.find((l) => l.lineId === wanted) ?? { lineId: wanted };
      targets = [{ lineId: wanted, line: e.line ?? null, ledgerSince: e.ledgerSince ?? null }];
    }
  } else if (map.ok) {
    targets = map.lines.map((l) => ({ lineId: String(l.lineId), line: l.line ?? null, ledgerSince: l.ledgerSince ?? null }));
  }

  const cursor = readCursor(dir, months);
  const archive = readArchiveMarkers(home);
  const sessionIndex = readSessionIndex(home);
  const ctx = {
    home, dir, nowMs, todayStr, months, cursor, archive, sessionIndex, scanStaleMin, missingRoundMin, probeTurnEnd,
  };

  // ── ⑤ 逐线判
  const perLine = [];
  for (const t of targets) perLine.push(evalLine(t, ctx, topFileSet));

  // ── ⑥ 汇总
  if (redMap) {
    // 映射表坏了：**全线下线**，但仍给"最后一次已知状态 + 它有多旧"（§5.5 降级链）
    const agg = aggregate(perLine);
    return finish(base, {
      ...agg,
      __perLine: perLine,
      state: 'lines-map-missing',
      note: [
        schemaNewer !== null ? `本器具不认 schemaVersion=${schemaNewer}` : null,
        mapBroken ? `_lines.json ${map.error === 'ENOENT' ? '不存在' : `读不了/形状不对（${map.error}）`}` : null,
        agg.note,
      ].filter(Boolean).join('；'),
    });
  }

  if (orphans.length) {
    // 孤儿账是**目录级**的：按 §5.5 优先级它排在 `ledger-broken` 之前、`empty`/`rotated-new` 之后
    // ⇒ 只顶掉"本来该报 ok / logs-archived"的那条线，不覆盖更靠前的态（也不覆盖更靠后的两态：
    //   scan-stale / missing-round 是"数不可信"的更强信号，保留原判）
    for (const p of perLine) {
      if (p.state === 'ok' || p.state === 'logs-archived') {
        p.state = 'orphan-file';
        p.note = [p.note, `发现 ${orphans.length} 份孤儿账（不属于任何线）`].filter(Boolean).join('；');
        p.rate = null;
      }
    }
  }

  const agg = aggregate(perLine);
  const noteBits = [agg.note];
  if (orphans.length) {
    noteBits.push(`发现 ${orphans.length} 份孤儿账 ${orphans.slice(0, 5).map((o) => o.name).join('、')}`
      + `${orphans.length > 5 ? ` 等 ${orphans.length} 份` : ''}（读端不读它、不删它、不搬它）`);
  }
  if (!cursor.present) noteBits.push('扫描器未上线（P2）：`_cursor.json` 不存在 ⇒ 不判 scan-stale、lastScanAt/scanBudget 为 null');
  if (archive.notes.length) noteBits.push(...archive.notes);

  // `--last N`：只用于"给人看最后 N 条"（`rows` 仍是计数，§5.4 schema）；按 ts 升序取尾
  const lastN = Number(opts.last ?? 0);
  let lastRows = null;
  if (Number.isInteger(lastN) && lastN > 0) {
    const all = perLine.flatMap((p) => p._rows ?? []);
    all.sort((x, y) => (msOfTs(x?.ts) ?? 0) - (msOfTs(y?.ts) ?? 0));
    lastRows = all.slice(-lastN).map((r) => ({
      ts: r?.ts ?? null,
      sid: r?.sid ?? null,
      turn: r?.turn ?? null,
      lineId: r?.lineId ?? null,
      phase: r?.phase ?? null,
      by: r?.by ?? null,
      did: r?.did ?? null,
      next: r?.next ?? null,
      file: r?.__file ?? null,
      rowNo: r?.__rowNo ?? null,
    }));
  }
  return finish(base, { ...agg, __perLine: perLine, lastRows, note: noteBits.filter(Boolean).join('；') });
}

// ---------------------------------------------------------------------------
// 单线判定
// ---------------------------------------------------------------------------
function evalLine(t, ctx, topFileSet) {
  const lineId = t.lineId;
  const notes = [];
  const [curM, prevM] = ctx.months;

  // 读文件（**按月亮序**：上月在前 ⇒ 行号/行序 = 时间序）
  const fileInfos = [];
  let cum = 0;
  for (const m of [prevM, curM]) {
    const name = ledgerFileName(lineId, m);
    if (!topFileSet.has(name)) continue;
    const info = { name, month: m, file: path.join(ctx.dir, name) };
    const parsed = parseLedgerFile(info, cum);
    cum += parsed.lineCount || 0;
    fileInfos.push(parsed);
  }

  const hasCur = fileInfos.some((f) => f.month === curM);
  const hasPrev = fileInfos.some((f) => f.month === prevM);
  const rows = [];
  const bad = [];
  let tail = null;
  let tailFileMtime = null;
  for (const f of fileInfos) {
    rows.push(...f.rows);
    bad.push(...f.bad);
    if (f.tail) { tail = { ...f.tail, file: f.name }; tailFileMtime = f.mtimeMs; }
  }
  const tailAgeMs = tail && Number.isFinite(tailFileMtime) ? ctx.nowMs - tailFileMtime : null;

  // `cardsState`：逐行取该行字段的最后一次值；没有行 ⇒ null（§5.4 L411）
  const cards = cardsStateOf(rows);

  // sid 集合（本线）：①行里的 sid ②`_sids\<lineId>.jsonl`
  const sids = collectSids(t.lineId, rows, ctx);
  let activeSids = 0;
  let archivedSids = 0;
  if (sids.size) {
    for (const sid of sids) {
      if (ctx.sessionIndex.idx.has(sid)) activeSids += 1;
      if (ctx.archive.set.has(sid)) archivedSids += 1;
    }
  }

  // rate（只读 `_rates\<lineId>.json`；**只有 state==='ok' 才允许给数**）
  const rate = readRate(ctx.dir, t.lineId, ctx.todayStr);

  // lastScanAt / scanBudget（`_cursor.json` 不存在 ⇒ 全 null、**不判 scan-stale**）
  const lineCursor = ctx.cursor.lines[lineId] && typeof ctx.cursor.lines[lineId] === 'object'
    ? ctx.cursor.lines[lineId] : null;
  const lastScanAt = lineCursor?.lastScanAt ? String(lineCursor.lastScanAt) : null;
  const lastScanMs = lastScanAt ? msOfTs(lastScanAt) : null;
  let scanBudget = null;
  if (ctx.cursor.present) {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    scanBudget = {
      windowMin: ctx.scanStaleMin,
      scannedSids: num(lineCursor?.scannedSids ?? ctx.cursor.job?.lastScannedSids),
      batchLimit: num(ctx.cursor.job?.batchLimit ?? 120),
      budgetMs: num(ctx.cursor.job?.budgetMs ?? 110000),
      dirtyUnread: num(lineCursor?.dirtyUnread ?? 0),
      skippedUnchanged: num(lineCursor?.skippedUnchanged ?? 0),
    };
  }

  const lastRowMs = lastRowMsOf(rows, fileInfos);
  const total = rows.length + bad.length;

  // ── 判定（§5.5 优先级，命中即停）
  let state = null;
  let stateSince = null;

  if (hasPrev && !hasCur) {
    state = 'rotated-new'; // 每月 1 号常见：上月有、当月还没第一笔
    const pf = fileInfos.find((f) => f.month === prevM);
    stateSince = isoOf(pf?.mtimeMs ?? null);
  } else if (!hasCur && !hasPrev) {
    state = 'empty'; // 这条线还没开始记账
  } else if (hasCur && rows.length === 0 && bad.length === 0 && !tail) {
    state = 'empty'; // 当月文件在、但 0 行
  } else if (bad.length > 0 && (firstIsBad(bad) || bad.length / Math.max(total, 1) >= 0.5)) {
    state = 'ledger-broken'; // 整份不可用：第 1 行就坏，或坏行 ≥50%
    stateSince = isoOf(lastRowMs);
  } else if (bad.length > 0) {
    state = 'ok-gapped'; // 跳过坏行照读（坏行 <50% 且第 1 行可解析）
    stateSince = isoOf(lastRowMs);
  } else if (tail && tailAgeMs !== null && tailAgeMs >= TAIL_STABLE_MS) {
    state = 'tail-broken'; // 末行不完整 + mtime 稳定 ≥5 s
    stateSince = isoOf(tailFileMtime);
  } else if (isScanStale(lineCursor, lastScanMs, ctx)) {
    // `scan-stale` 排在 missing-round 前：扫描没跑时"账本没推进"只是后果
    state = 'scan-stale';
    stateSince = lastScanAt;
  } else if (isMissingRound(rows, lastRowMs, sids, ctx, notes)) {
    state = 'missing-round';
    stateSince = isoOf(lastRowMs);
  } else if (archivedSids > 0) {
    state = 'logs-archived'; // 灰：只单列，**不动分母**
    stateSince = isoOf(lastRowMs);
  } else {
    state = 'ok';
    stateSince = isoOf(lastRowMs);
  }

  // 末行"正在被写"的静默（§5.5 读策略 2）：不报、不记 —— 但要让人知道"看到半行没管它"
  if (tail && state === 'ok') notes.push(`末行还在写（mtime ${Math.max(0, Math.round((tailAgeMs ?? 0) / 1000))}s < 5s）⇒ 静默，未计入 badLines`);

  // rate 收口：**只有 ok 才给数**（§5.4 L415）
  let rateValue = null;
  if (state !== 'ok') {
    notes.push(`rate 不回数：state=${state}（${rate.reason ?? '只有 state==="ok" 才允许给数'}）`);
  } else if (rate.reason) {
    notes.push(rate.reason);
  } else {
    rateValue = rate.value;
  }
  if (cards.note) notes.push(cards.note);

  return {
    lineId: t.lineId,
    line: t.line ?? null,
    state,
    stateSince,
    rows: rows.length,
    badLines: bad.map((b) => b.rowNo),
    tailBytes: tail ? tail.bytes : 0,
    cardsState: cards.value,
    ledgerSince: t.ledgerSince ?? null,
    knownSids: sids.size,
    activeSids,
    archivedSids,
    note: notes.filter(Boolean).join('；') || null,
    rate: rateValue,
    lastScanAt,
    scanBudget,
    // 附加（不进 §5.4 那 15 个键，但排查要用）
    monthsPresent: fileInfos.map((f) => f.month),
    files: fileInfos.map((f) => f.name),
    badLineDetails: bad,
    tailDetail: tail ? { ...tail, ageMs: tailAgeMs } : null,
    _rows: rows,
    _bad: bad,
  };
}

function firstIsBad(bad) {
  return bad.length > 0 && bad[0].rowNo === 1;
}

function cardsStateOf(rows) {
  if (!rows.length) return { value: null, note: null };
  let last;
  for (const r of rows) {
    const v = r?.cardsState;
    if (typeof v === 'string' && v) last = v;
  }
  if (last === undefined) return { value: 'unavailable', note: '行里没有 cardsState 字段（R-13：不许当 0 / 当 ok）' };
  if (last !== 'ok' && last !== 'unavailable') {
    return { value: 'unavailable', note: `cardsState 取值不认识（${last}）⇒ 按 unavailable` };
  }
  if (last === 'unavailable') return { value: 'unavailable', note: '本行 cards{} 不可信（写端算不出看板六计数）' };
  return { value: 'ok', note: null };
}

function collectSids(lineId, rows, ctx) {
  const set = new Set();
  for (const r of rows) {
    const b = normSid(r?.sid);
    if (b && isBareUuid(b)) set.add(b);
  }
  const f = path.join(ctx.dir, SIDS_DIR, `${lineId}.jsonl`);
  const t = readTextSafe(f);
  if (t.ok) {
    for (const line of t.text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        const b = normSid(o?.sid);
        if (b && isBareUuid(b)) set.add(b);
      } catch { /* `_sids` 的坏行不参与判定（它没有自己的 ok-gapped 态） */ }
    }
  }
  return set;
}

function lastRowMsOf(rows, fileInfos) {
  let ms = null;
  for (const r of rows) {
    const t = msOfTs(r?.ts);
    if (t !== null && (ms === null || t > ms)) ms = t;
  }
  if (ms === null) {
    const mts = fileInfos.map((f) => f.mtimeMs).filter(Number.isFinite);
    if (mts.length) ms = Math.max(...mts);
  }
  return ms;
}

/**
 * `scan-stale`（**逐线判**，不许取全树 `max(lastScanAt)`）。
 * §5.4 ①：该线 `lastScanAt` 超龄 > 6 分钟；②：`dirtyUnread > 0` 且 `consecutiveMissed >= 3`。
 * ⚠️ 两条都要求 `dirtyUnread > 0` —— 这是 §5.4「**不误报前提**：一条线整月没动
 *    （`dirtyUnread == 0`）⇒ 不判 `scan-stale`（它不是没扫，是没事可扫）」的直接落地。
 *    （方案 ① 那一句没带这个前提，字面上与"不误报前提"冲突 ⇒ 已记进交付报告「待拍板」。）
 * ⚠️ `_cursor.json` 不存在 ⇒ 不判（P2 才写它；判了 = 全线必然橙 = 噪声）。
 */
function isScanStale(lineCursor, lastScanMs, ctx) {
  if (!ctx.cursor.present) return false;
  if (!lineCursor) return false;
  const dirty = Number(lineCursor.dirtyUnread ?? 0);
  if (!(dirty > 0)) return false;
  const missed = Number(lineCursor.consecutiveMissed ?? 0);
  const stale = lastScanMs !== null && (ctx.nowMs - lastScanMs) > ctx.scanStaleMin * 60_000;
  return stale || missed >= 3;
}

/**
 * `missing-round`：文件有历史行，但距最后一条**成功解析**的行已 > N 分钟，
 * **且**该窗口内本线有新 `turn/end`（§5.5）。
 * 成本上界：只探"日志 mtime 落在窗口后的 sid"，最多 `MISSING_ROUND_MAX_PROBE` 份。
 */
function isMissingRound(rows, lastRowMs, sids, ctx, notes) {
  if (!rows.length || lastRowMs === null || lastRowMs === undefined) return false;
  if (!ctx.probeTurnEnd) return false;
  if ((ctx.nowMs - lastRowMs) <= ctx.missingRoundMin * 60_000) return false;
  if (!ctx.sessionIndex.ok || !sids.size) return false;

  const cands = [];
  for (const sid of sids) {
    const d = ctx.sessionIndex.idx.get(sid);
    if (!d) continue;
    let newest = null;
    try {
      const files = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile());
      for (const f of files) {
        const st = statSafe(path.join(d, f.name));
        if (st.ok && (newest === null || st.st.mtimeMs > newest)) newest = st.st.mtimeMs;
      }
    } catch { continue; }
    if (newest !== null && newest > lastRowMs) cands.push({ sid, newest });
  }
  if (!cands.length) return false;
  cands.sort((a, b) => b.newest - a.newest);
  const picked = cands.slice(0, MISSING_ROUND_MAX_PROBE);
  if (cands.length > picked.length) {
    notes.push(`missing-round 只探了最近 ${picked.length} 份日志（候选 ${cands.length} 份，成本上界）`);
  }
  for (const c of picked) {
    try {
      const r = readEvents(c.sid, { types: ['turn/end'], lastN: 0, home: ctx.home });
      const hit = (r?.events ?? []).some((e) => {
        const t = Number(e?.time);
        return Number.isFinite(t) && t > lastRowMs && t <= ctx.nowMs;
      });
      if (hit) return true;
    } catch { /* 单份日志读不了不算"有新轮"（读端不因为一条日志坏了就炸） */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 汇总（没给 `--line` 时）
// ---------------------------------------------------------------------------
function aggregate(perLine) {
  const sum = (k) => perLine.reduce((s, p) => s + Number(p[k] ?? 0), 0);
  const rowsTotal = sum('rows');
  const badLines = perLine.flatMap((p) => p.badLines ?? []).sort((a, b) => a - b);
  const tailBytes = perLine.reduce((m, p) => Math.max(m, p.tailBytes ?? 0), 0);
  const state = perLine.length ? worstState(perLine.map((p) => p.state)) : 'empty';
  const worst = perLine.find((p) => p.state === state) ?? null;
  const ledgerSince = perLine.map((p) => p.ledgerSince).filter(Boolean).sort()[0] ?? null;
  return {
    lineId: perLine.length === 1 ? perLine[0].lineId : null,
    line: perLine.length === 1 ? perLine[0].line : null,
    state,
    stateSince: worst?.stateSince ?? null,
    rows: rowsTotal,
    badLines,
    tailBytes,
    cardsState: lastCardsState(perLine),
    ledgerSince,
    // ⚠️ 汇总模式的 sid 计数 = **逐线相加**（同一 sid 正常只属一条线；若人手工把同一 sid
    //    认领进两条线，这里会重复计数 —— 单线模式（`--line`）永远是准的）
    knownSids: sum('knownSids'),
    activeSids: sum('activeSids'),
    archivedSids: sum('archivedSids'),
    note: perLine.map((p) => p.note).filter(Boolean).join('；') || null,
    rate: perLine.length === 1 ? perLine[0].rate : null,
    lastScanAt: worst?.lastScanAt ?? null,
    scanBudget: perLine.length === 1 ? perLine[0].scanBudget : null,
  };
}

/** 汇总时的 cardsState：逐线看最后一条（都是 null ⇒ null；有 unavailable ⇒ unavailable） */
function lastCardsState(perLine) {
  const vals = perLine.map((p) => p.cardsState);
  if (vals.every((v) => v === null)) return null;
  if (vals.some((v) => v === 'unavailable')) return 'unavailable';
  return 'ok';
}

/** 收尾：补 rc / 公开字段（去掉 `_rows` 等内部件） */
function finish(base, patch) {
  const merged = { ...base, ...patch };
  const perLine = patch.__perLine ?? [];
  const rc = Number.isFinite(patch.rcOverride)
    ? patch.rcOverride
    : (isLedgerState(merged.state) ? LEDGER_STATES[merged.state].rc : 0);
  const out = {
    lineId: merged.lineId,
    line: merged.line,
    state: merged.state,
    stateSince: merged.stateSince,
    rows: merged.rows,
    badLines: merged.badLines,
    tailBytes: merged.tailBytes,
    cardsState: merged.cardsState,
    ledgerSince: merged.ledgerSince,
    knownSids: merged.knownSids,
    activeSids: merged.activeSids,
    archivedSids: merged.archivedSids,
    note: merged.note,
    rate: merged.rate,
    lastScanAt: merged.lastScanAt,
    scanBudget: merged.scanBudget,
    // —— 附加（不进 §5.4 的 15 键）——
    rc,
    tool: TOOL,
    ts: merged.ts,
    now: merged.now,
    home: merged.home,
    dir: merged.dir,
    months: merged.months,
    lineRequested: merged.lineRequested,
    lines: perLine.map(publicLine),
    orphans: merged.orphans ?? [],
    badLineDetails: merged.badLineDetails ?? perLine.flatMap((p) => p.badLineDetails ?? []),
    phases: merged.phases,
    states: merged.states,
  };
  if (merged.lastRows) out.lastRows = merged.lastRows;
  return { payload: out, perLine };
}

function publicLine(p) {
  if (!p) return p;
  const { _rows, _bad, ...rest } = p;
  return rest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const VALUE_FLAGS = new Set(['line', 'last', 'home', 'now', 'row', 'missing-round-min', 'scan-stale-min']);
const BOOL_FLAGS = new Set(['json', 'raw', 'stale', 'help']);

function parseArgs(argv) {
  const a = { _: [], unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith('--')) { a._.push(tok); continue; }
    const name = tok.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { a[name] = ''; continue; }
      a[name] = v;
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(name)) { a[name] = true; continue; }
    a.unknown.push(name);
  }
  return a;
}

const HELP = [
  'ledger-read —— 主线流水小本本的完整读端（V9 §5.4 + §5.5 · 12 态）',
  '',
  '  node ledger-read.mjs [--line <lineId|线名>] [--last N] [--json] [--raw --row N]',
  '                       [--home <dir>] [--now <ISO>] [--missing-round-min N] [--scan-stale-min N]',
  '',
  '  --line               线名 / 别名 / lineId；不给 = 全线下线后汇总',
  '  --last N             只要最后 N 行（跨月自动接上月文件尾部）',
  '  --json               stdout 一行 JSON（schema 见 V9 §5.4）',
  '  --raw --row N        把第 N 行**原样**打出来（坏行只能靠它排查）',
  '                       ⚠️ 行号 = 全局行号：按月升序（上月在前）、文件内从 1 数、跨文件连续',
  '  --now <ISO>          注入"现在"（R-11：造跨年/跨月夹具，**禁改系统月份**）',
  '  --home <dir>         dsh home 根（缺省 ~/.dsh）；夹具把 mainline-ledger\\ /',
  '                       sessions\\ / _archived-sessions\\ / storages\\ 一起放进同一个临时目录',
  '',
  '12 态（判定优先级即下面顺序）：',
  `  ${LEDGER_STATE_KEYS.join(' → ')}`,
  '',
  '⚠️ 读端**零写盘**：不 append、不建目录、不搬坏行、不写 suppressed。`--stale` 归 P2。',
].join('\n');

function printHuman(payload) {
  const lines = [];
  const lv = isLedgerState(payload.state) ? LEDGER_STATES[payload.state].level : '?';
  lines.push(`state=${payload.state}（${lv}）· 行数 ${payload.rows} · 坏行 ${payload.badLines.length} · 月窗 ${payload.months.join('+')}`);
  if (payload.lineId) lines.push(`线 ${payload.lineId}${payload.line ? `（${payload.line}）` : ''}`);
  if (payload.stateSince) lines.push(`stateSince ${payload.stateSince}`);
  lines.push(`cardsState=${payload.cardsState ?? 'null'} · rate=${payload.rate ?? 'null'} · `
    + `sid ${payload.knownSids}(活 ${payload.activeSids} / 归档 ${payload.archivedSids})`);
  lines.push(`ledgerSince ${payload.ledgerSince ?? '—'} · lastScanAt ${payload.lastScanAt ?? 'null'}`);
  if (payload.note) lines.push(`note：${payload.note}`);
  if (payload.badLines.length) lines.push(`坏行号：${payload.badLines.join(', ')}（用 --raw --row N 看原文）`);
  if (payload.tailBytes) lines.push(`末行余 ${payload.tailBytes} B（写到一半，下次 append 自动闭合）`);
  for (const o of payload.orphans.slice(0, 5)) lines.push(`孤儿账 ${o.name} —— ${o.why}`);
  for (const l of payload.lines) {
    if (payload.lines.length === 1 && payload.lineRequested) break;
    lines.push(`  · ${l.lineId} ${l.line ?? ''} ⇒ ${l.state}（行 ${l.rows}${l.badLines.length ? ` / 坏 ${l.badLines.length}` : ''}）`);
  }
  return lines;
}

/** `--raw --row N`：定位文件 + 物理行号，**原样**打出来（读端不修、不搬、不改写） */
function rawRow(home, now, lineLiteral, rowNo) {
  const dir = path.join(home, LEDGER_DIR);
  const months = monthWindow(now);
  const map = readLinesMap(dir);
  // 用与 readLedger 完全同一套"月升序"口径重算各文件行数
  let targets = [];
  if (lineLiteral) {
    const id = resolveLineIdFromMap(map.lines, lineLiteral) ?? (isLineId(lineLiteral) ? lineLiteral : null);
    if (!id) return { ok: false, why: `_lines.json 里没有这条线（${lineLiteral}）` };
    targets = [id];
  } else if (map.ok) {
    targets = map.lines.map((l) => String(l.lineId)).sort();
  } else {
    return { ok: false, why: `_lines.json 读不了（${map.error}）` };
  }
  const files = [];
  for (const id of targets) {
    for (const m of months.slice().reverse()) {
      const name = ledgerFileName(id, m);
      const f = path.join(dir, name);
      const st = statSafe(f);
      if (!st.ok) continue;
      const t = readTextSafe(f);
      if (!t.ok) continue;
      const parts = t.text.split('\n');
      if (parts.length && parts[parts.length - 1] === '') parts.pop();
      files.push({ name, parts });
    }
  }
  let cum = 0;
  for (const f of files) {
    if (rowNo > cum && rowNo <= cum + f.parts.length) {
      const raw = f.parts[rowNo - cum - 1];
      return { ok: true, file: f.name, lineNo: rowNo - cum, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw };
    }
    cum += f.parts.length;
  }
  return { ok: false, why: `行号 ${rowNo} 超界（共 ${cum} 行）`, total: cum };
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.help) {
    process.stdout.write(HELP + '\n');
    process.exitCode = 0;
    return;
  }
  if (a.unknown?.length) {
    process.stderr.write(`❌ 不认识的参数：--${a.unknown.join(' --')}\n`);
    process.exitCode = 2;
    return;
  }
  if (a.stale) {
    // §5.4 L389 有 `--stale`，但本卡明确划给 P2（P2 行原话「读端接进 --stale」）
    process.stderr.write('❌ `--stale` 本卡未实现（P1-c 只做 §5.4/§5.5 的读;`--stale` 归 P2 那张卡）\n');
    process.exitCode = 2;
    return;
  }
  const home = a.home ? path.resolve(String(a.home)) : dshHome();
  let now;
  if (a.now !== undefined) {
    now = new Date(String(a.now));
    if (Number.isNaN(now.getTime())) {
      process.stderr.write(`❌ --now 认不出：${a.now}\n`);
      process.exitCode = 2;
      return;
    }
  } else {
    now = new Date();
  }

  if (a.raw) {
    const rowNo = Number(a.row);
    if (!Number.isInteger(rowNo) || rowNo < 1) {
      process.stderr.write('❌ --raw 需要 --row N（N ≥ 1）\n');
      process.exitCode = 2;
      return;
    }
    const r = rawRow(home, now, a.line ? String(a.line) : null, rowNo);
    if (!r.ok) {
      process.stderr.write(`❌ ${r.why}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`# ${r.file}#${r.lineNo}（原样，读端不修不搬）\n`);
    process.stdout.write(r.text + '\n');
    process.exitCode = 0;
    return;
  }

  const res = readLedger({
    home,
    line: a.line ? String(a.line) : null,
    last: a.last ? Number(a.last) : 0,
    now,
    missingRoundMin: a['missing-round-min'] !== undefined ? Number(a['missing-round-min']) : undefined,
    scanStaleMin: a['scan-stale-min'] !== undefined ? Number(a['scan-stale-min']) : undefined,
  });
  const payload = res.payload;
  // `rows` 是**计数**（§5.4 schema）；`--last N` 给的是"最后 N 条摘要"，走 `lastRows`
  payload.count = payload.rows;

  if (a.json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stdout.write(printHuman(payload).join('\n') + '\n');
  }
  process.exitCode = Number.isFinite(payload.rc) ? payload.rc : 0;
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));

export { main, parseArgs, rawRow };
