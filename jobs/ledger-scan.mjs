#!/usr/bin/env node
// ============================================================================
// dsh-butler / ledger-scan.mjs —— B 路扫描器（tickd job `mainline-scan` 的执行体）
//
// 出处：docs\方案-三层角色工作方式与主线流水-V9.md
//   §6.2（L513-624）B 路 = tickd 扫描（候选集 / 归线三路 / 四条判据 / 补记形态 / 分子分母 / 预算）
//   §5.2 末条（L314-317）**两段式**：扫描段不持锁、落地段逐笔抢线锁
//   §5.0 表的第 3（补记行）/ 4（ops）/ 9（cursor）/ 10（suppressed）/ 12（rate）行
//   §5.3（L342）`by:scan` 时行内 `turn := forTurn`（**不许绕开 writer 直接 append**）
//   §5.6（L482-499）四把锁互不嵌套；`_cursor` 是第四把
//   §14.2 P2（L1131）判据 ①~⑧
//
// 🔴 本文件**一个写盘 API 都不许有**（`appendFileSync` / `writeFileSync` / `mkdirSync` /
//   `renameSync` … 全部禁）：所有落盘一律调 `lib\mainline-ledger-writer.mjs`。
//   机械判据：`node <pkg>\jobs\ledger-writer-audit.mjs --root <workspace>\tools\dsh-butler --json`
//   ⇒ 碰 `mainline-ledger\` 的直接写者**只允许** `lib\mainline-ledger-writer.mjs` 一个；
//     本文件应落在 `indirect`（import writer 并调它的写函数）。
//
// 两段式（本卡的形态铁律，别合成一段）：
//   ① 扫描段（**不持任何线锁**）：`listActiveSessions` 思路的目录枚举 + `readEvents`
//      ⇒ 得出「哪些 (sid,turn) 缺账」的**清单**；
//   ② 落地段（逐笔）：对清单每笔**单独**抢线锁 → 写一行 → 释放。
//   ⇒ 单次持锁 = 写一行（毫秒级），`ttlMs:30_000` 绰绰有余；**不许持锁遍历 120 次读**
//     （401 ms × 120 ≈ 48 s > ttl 30 s ⇒ 被抢 ⇒ 双写者）。
//
// 三个 home 别混：
//   --home <dir>    **账本**家目录（缺省 `~/.dsh`；夹具一律传临时目录）
//   会话日志/看板账本恒读**真实** dsh home（夹具不放会话，也不放看板）
//
// 用法：
//   node ledger-scan.mjs [--home <dir>] [--now <ISO>] [--apply] [--dry-run] [--json]
//        [--limit <n>] [--budget-ms <n>] [--lines <lineId,…>] [--no-cards]
//        [--no-skip-unchanged]
//   rc：0 正常（含"没有东西要补"）· 2 参数错 · 3 环境错 · 4 job 锁被占（让路）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

import { dshHome, realOrResolve } from '../src/dsh-butler/lib/paths.mjs';
import { acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { readEvents } from './lib/session-events.mjs';
import { pickSessionFileInDir } from '../src/lib/session-file-name.mjs';
import { monthWindow, toCompact } from './lib/ledger-month.mjs';
import { probeActor, computeCards } from './ledger-line.mjs';
import {
  appendRow,
  appendOps,
  appendSuppressed,
  writeCursor,
  writeRate,
  readCursorState,
  readLinesMap,
  ensureHome,
  isoWithOffset,
  normalizeSid,
  isLineId,
  isBareUuid,
  ledgerDir,
  RATES_DIR,
} from './lib/mainline-ledger-writer.mjs';

const TOOL = 'ledger-scan';
/** job 静态锁（= `lib\butler-locks.mjs` 里登的那一把；**不是**线锁、**不是** `_lines` 锁） */
const JOB_LOCK_NAME = 'mainline-scan';
const JOB_LOCK_TTL_MS = 120_000;
/** 单轮预算（§6.2 工程约束：≤120 sid 次 / 软预算 110 s） */
const BATCH_LIMIT_SIDS = 120;
const BUDGET_MS = 110_000;
/** `scan-stale` 判据（§5.4 ①：> 6 分钟 = 3 个 2 分钟周期） */
const SCAN_STALE_MS = 6 * 60 * 1000;
/** `consecutiveMissed>=3` ⇒ 该线 `scan-stale`、`rate` 回 null（§5.4 ②） */
const MISS_STALE_ROUNDS = 3;
/** 时钟偏差宽容窗（§6.2 判据 1：`turn/end.time >= ledgerSince - 60s`，方向是"宁可少补"） */
const LEDGER_SINCE_TOL_MS = 60_000;
/** 水位淘汰：连续 N 轮不在候选集里 ⇒ 摘掉（否则 `sids{}` 无限长） */
const EVICT_MISS_ROUNDS = 3;
/** 单 sid 连续 `frameFail` 上限（超了就放弃重试，避免永久 pending） */
const FRAME_FAIL_GIVE_UP = 3;
const SIDS_DIR = '_sids';

const BOOL_FLAGS = new Set(['apply', 'dry-run', 'json', 'help', 'no-cards', 'no-skip-unchanged']);
const VALUE_FLAGS = new Set(['home', 'now', 'limit', 'budget-ms', 'lines']);

// ---------------------------------------------------------------------------
// 参数 / 输出
// ---------------------------------------------------------------------------
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

const OUT = { json: false };

function emit(result, humanLines) {
  if (OUT.json) process.stdout.write(JSON.stringify(result) + '\n');
  else for (const l of humanLines) process.stdout.write(l + '\n');
  process.exitCode = result.rc;
  return result;
}

const pad = (n) => String(n).padStart(2, '0');
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.length > n ? s.slice(0, n) : s;
};

/** 本机时钟的自然日（`Asia/Shanghai`；`_rates` / `_cursor` 都是本机文件，§6.2） */
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 某自然日 00:00:00 的毫秒（本机时区） */
function dayStartMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) throw new Error(`dayStartMs: 非法自然日 = ${String(day)}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}

function readJsonIfAny(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonlRows(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { rows: [], bad: 0 }; }
  const rows = [];
  let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') rows.push(o); else bad += 1;
    } catch { bad += 1; }
  }
  return { rows, bad };
}

function msOfTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const s = String(ts ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const [y, mo, d, hh, mm, ss] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  let ms = Date.UTC(y, mo - 1, d, hh, mm, ss, Number(`0.${m[7] ?? 0}`) * 1000);
  if (m[8] && m[8] !== 'Z') {
    const off = m[8].replace(':', '');
    const sign = off[0] === '-' ? -1 : 1;
    ms -= sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5))) * 60_000;
  }
  return ms;
}

/**
 * 本线主账「键当前有没有效」（§5.3 行序语义：void 只作废它**之前**的行；后写者胜）。
 * ⚠️ 别把"键出现过"当成"键还有效" —— 被冲销的键必须视为不存在（否则 B 路补不回）。
 */
function keyStates(rows, lineId) {
  const map = new Map();
  for (const o of rows) {
    if (!o || o.lineId !== lineId) continue;
    if (String(o.phase ?? '') === 'void' && o.voids) {
      const cur = map.get(String(o.voids));
      if (cur) cur.voided = true;
      continue;
    }
    map.set(`${o.sid}#${o.turn}`, { voided: false, by: String(o.by ?? ''), row: o });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 会话目录索引（**只 readdir 两层 + 只给候选 sid 找日志**，不整树解压）
//   §6.2「'在跑会话'从哪取」：扫 `~\.dsh\sessions\<ws>\` 下的会话目录 + 日志 mtime，
//   不走 `session.list` RPC（实测它会污染内存 registry）。
//   ⚠️ 成本纪律：**先枚举目录（不解压、不 stat 全树），再只对候选 sid 找日志**。
// ---------------------------------------------------------------------------
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionDirs(sessionHome) {
  const map = new Map(); // 裸 sid -> 目录（两形态都收，先到先得）
  const root = path.join(sessionHome, 'sessions');
  let wss = [];
  try { wss = fs.readdirSync(root, { withFileTypes: true }); } catch { return { map, activeCount: 0 }; }
  let activeCount = 0;
  for (const ws of wss) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let ents = [];
    try { ents = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const bare = String(e.name).replace(/^session-/, '');
      if (!BARE_UUID_RE.test(bare)) continue;
      activeCount += 1;
      if (!map.has(bare)) map.set(bare, path.join(wsDir, e.name));
    }
  }
  return { map, activeCount };
}

/** sid 的会话日志 {file, mtimeMs, size}（找不到 ⇒ null） */
function logOf(sid, dirMap) {
  const dir = dirMap.get(sid);
  if (!dir) return null;
  const file = pickSessionFileInDir(dir);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    return { file, mtimeMs: Math.round(st.mtimeMs), size: st.size, dir };
  } catch {
    return null;
  }
}

/** 归档标记（**只读标记**；§5.5 `logs-archived` —— 本机 `moveFiles:false` ⇒ 按"搬到哪"判恒不触发） */
function archivedSidSet(sessionHome) {
  const set = new Set();
  const pushAll = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) {
      const b = normalizeSid(x);
      if (b && isBareUuid(b)) set.add(b);
    }
  };
  const aa = readJsonIfAny(path.join(sessionHome, '_archived-sessions', '.auto-archive.json'));
  pushAll(aa?.state?.lastResult?.archived);
  const wp = readJsonIfAny(path.join(sessionHome, 'storages', 'workspace.json'));
  pushAll(wp?.global?.archivedSessionIds);
  pushAll(wp?.archivedSessionIds);
  const wss = wp?.tables?.workspaces;
  if (Array.isArray(wss)) for (const w of wss) pushAll(w?.archivedSessionIds);
  return set;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/**
 * 跑一轮扫描。
 * @param {{home?:string, now?:Date|string, apply?:boolean, limit?:number, budgetMs?:number,
 *          lines?:string[]|null, cards?:boolean, skipUnchanged?:boolean}} [opts]
 */
export function scan(opts = {}) {
  const t0 = Date.now();
  const home = path.resolve(opts.home ?? dshHome());
  const sessionHome = dshHome();
  const fixture = realOrResolve(home) !== realOrResolve(sessionHome);
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error(`--now 认不出：${String(opts.now)}`);
  const nowMs = now.getTime();
  const nowIso = isoWithOffset(now);
  const today = dayOf(nowMs);
  const apply = opts.apply === true;
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
    ? Math.floor(Number(opts.limit)) : BATCH_LIMIT_SIDS;
  const budgetMs = Number.isFinite(Number(opts.budgetMs)) && Number(opts.budgetMs) > 0
    ? Number(opts.budgetMs) : BUDGET_MS;
  const readCards = opts.cards !== false;
  const skipUnchanged = opts.skipUnchanged !== false;
  const onlyLines = Array.isArray(opts.lines) && opts.lines.length ? new Set(opts.lines) : null;

  const notes = [];
  const out = {
    rc: 0, tool: TOOL, action: 'scan', home, sessionHome, fixture,
    now: nowIso, today, apply, dryRun: !apply,
    linesTotal: 0, linesCovered: 0,
    sids: { candidates: 0, scanned: 0, dirty: 0, unreadDirty: 0, skippedUnchanged: 0,
      readErrors: 0, unreadable: 0, archived: 0, activeSessionsInWindow: 0, already: 0 },
    budget: { batchLimit: limit, budgetMs, sidReads: 0, elapsedMs: 0, exceeded: false, exceededBy: null },
    missing: [], wrote: { attempted: 0, appended: 0, dupSkip: 0, lockMissed: 0, failed: 0 },
    lineMismatch: [], rates: [], suppressed: { appended: 0, dupSkip: 0 },
    cursor: { written: false, evicted: 0, sidsLost: 0 },
    ops: { heartbeat: false, budgetExceeded: false },
    notes,
  };

  // ── ① job 静态锁（**手跑与 tickd 共用同一份代码、同一把真锁**，§6.2 ②）
  //   ⚠️ env 只透传 `DSH_BUTLER_TICK_LOCK_HELD`（tickd 的锁继承），**丢掉 `DSH_HANDOFF_LOCK_HELD`**：
  //      后者会让锁变成零 I/O 虚拟锁（交接窗口里两个写者同时写）。见交付报告「设计裁定」。
  const lockEnv = { DSH_BUTLER_TICK_LOCK_HELD: process.env.DSH_BUTLER_TICK_LOCK_HELD };
  const jobLock = acquireTickLock(JOB_LOCK_NAME, { ttlMs: JOB_LOCK_TTL_MS, home, env: lockEnv });
  out.jobLock = { ok: jobLock.ok, inherit: jobLock.inherit === true, reason: jobLock.reason ?? null };
  if (!jobLock.ok) {
    const ops = appendOps(home, null, { ts: nowIso, phase: 'lock-missed', reason: `job-lock:${jobLock.reason ?? 'held'}` });
    out.rc = 4;
    out.action = 'job-lock-missed';
    out.opsFile = ops.file ?? null;
    notes.push('job 锁被占 ⇒ 本轮让路（rc=4），.ops 记了 lock-missed');
    return finish(out, nowMs);
  }

  try {
    return runLocked();
  } finally {
    try { jobLock.release(); } catch { /* TTL 兜底 */ }
  }

  function runLocked() {
    // ⚠️ dry-run **一个字节都不写**：`ensureHome`（建目录 + `_meta.json`）只在 `--apply` 时跑。
    //    （本卡实测踩到：原先无条件 ensureHome ⇒ 只读跑一次也会在生产 home 建出目录。）
    if (apply) {
      const home0 = ensureHome(home);
      if (home0.rc !== 0) {
        out.rc = 3; out.action = home0.action;
        notes.push(`账本目录不可用：${home0.action}`);
        return finish(out, nowMs);
      }
    }

    const map = readLinesMap(home);
    const allLines = Array.isArray(map?.lines) ? map.lines.filter((l) => isLineId(String(l.lineId))) : [];
    const lines = onlyLines ? allLines.filter((l) => onlyLines.has(l.lineId)) : allLines;
    out.linesTotal = lines.length;
    if (!allLines.length) {
      out.action = 'no-lines';
      notes.push('`_lines.json` 里一条线都没有（先跑 `ledger-line --register-line`）⇒ 本轮无可扫');
      return finish(out, nowMs);
    }

    // ── ② 主账行（当月 + 上月，**读端口径**：上月在前 ⇒ 行序 = 时间序）
    const months = monthWindow(now).map((m) => toCompact(m));
    const rowsByLine = new Map();
    for (const l of lines) {
      const rows = [];
      for (const m of months.slice().reverse()) {
        const f = path.join(ledgerDir(home), `${l.lineId}-${m}.jsonl`);
        const r = readJsonlRows(f);
        for (const o of r.rows) rows.push(o);
      }
      rowsByLine.set(l.lineId, rows);
    }

    // ── ③ 归线：`sidOwner(sid)`（§6.2「换线不双计」）
    //   ① `_sids\*` 里该 sid **最新一条**（按 ts）②否则该 sid 在**全部线文件里最后一条行**
    //   ③都没有 ⇒ unmapped
    const ownerFromSids = new Map(); // sid -> {lineId, ts, ms}
    const ownerFromRows = new Map();
    const lineSids = new Map();      // lineId -> Set<sid>
    for (const l of lines) {
      const set = new Set();
      for (const r of rowsByLine.get(l.lineId) ?? []) {
        const b = normalizeSid(r?.sid);
        if (!b || !isBareUuid(b)) continue;
        set.add(b);
        const ms = msOfTs(r?.ts) ?? 0;
        const cur = ownerFromRows.get(b);
        if (!cur || ms > cur.ms) ownerFromRows.set(b, { lineId: l.lineId, ts: r?.ts ?? null, ms });
      }
      const sidFile = path.join(ledgerDir(home), SIDS_DIR, `${l.lineId}.jsonl`);
      for (const r of readJsonlRows(sidFile).rows) {
        const b = normalizeSid(r?.sid);
        if (!b || !isBareUuid(b)) continue;
        set.add(b);
        const ms = msOfTs(r?.ts) ?? 0;
        const cur = ownerFromSids.get(b);
        if (!cur || ms > cur.ms) ownerFromSids.set(b, { lineId: l.lineId, ts: r?.ts ?? null, ms, how: r?.how ?? null });
      }
      lineSids.set(l.lineId, set);
    }
    const sidOwner = (sid) => ownerFromSids.get(sid) ?? ownerFromRows.get(sid) ?? null;

    // ── ④ 候选集 = 本线 sid 集（`sidOwner` 去重后仍属本线）
    const dirs = sessionDirs(sessionHome);
    const archiveSet = archivedSidSet(sessionHome);
    out.sids.activeSessionsInWindow = dirs.activeCount;

    const candidates = [];
    for (const l of lines) {
      for (const sid of lineSids.get(l.lineId) ?? []) {
        const own = sidOwner(sid);
        if (!own || own.lineId !== l.lineId) continue; // 换线不双计：只算最新归属那条线
        candidates.push({ sid, lineId: l.lineId, ledgerSince: l.ledgerSince ?? null, line: l.line ?? null });
      }
    }
    out.sids.candidates = candidates.length;

    // ── ⑤ 作用域过滤（§6.2 判据 4：子代理 / 卡会话跳过）
    for (const c of candidates) {
      const actor = probeActor(c.sid, sessionHome);
      c.scope = actor.known ? 'ok' : 'unknown';
      c.outOfScope = Boolean(actor.known && (actor.isSubagent || actor.isCardSession));
      if (c.outOfScope) c.why = actor.isSubagent ? 'subagent' : 'card-session';
    }
    const scoped = candidates.filter((c) => {
      if (!c.outOfScope) return true;
      notes.push(`跳过 ${c.sid.slice(0, 8)}（${c.why}）`);
      return false;
    });

    // ── ⑥ 水位（只读）+ 轮转顺序
    const cursorRead = readCursorState(home, now);
    const cursorState = cursorRead.state;
    const prevSids = cursorState.sids ?? {};
    const rotateTo = typeof cursorState.cursor === 'string' ? cursorState.cursor : null;
    if (rotateTo) {
      const idx = scoped.findIndex((c) => c.sid === rotateTo);
      if (idx > 0) scoped.push(...scoped.splice(0, idx));
    }

    // ── ⑦ 扫描段（**不持任何线锁**）
    const perLine = new Map();
    for (const l of lines) {
      perLine.set(l.lineId, {
        lineId: l.lineId, touched: false, scanned: 0, dirty: 0, unreadDirty: 0, skippedUnchanged: 0,
        readErrors: 0, unreadable: 0, archived: 0, missing: 0, wrote: 0,
      });
    }
    const endTimesBySid = new Map(); // sid -> number[]（供 rate 复用，免得二次读）
    let sidReads = 0;
    let exceeded = false;
    const dirtyList = [];

    for (const c of scoped) {
      if (exceeded) { if (c.dirtyFlag) dirtyList.push(c); continue; } // 记录未扫的脏
      const pl = perLine.get(c.lineId);
      pl.touched = true;   // "这条线本轮被过了一遍"（读过 / 未变跳过 / 日志不可读都算）
      const log = logOf(c.sid, dirs.map);
      c.archived = archiveSet.has(c.sid);
      if (!log) {
        // 日志搬走了 / 目录没了 ⇒ 不可读（`logs-archived` 的物理成因）；**不动水位、不判漏记**
        pl.unreadable += 1;
        out.sids.unreadable += 1;
        if (c.archived) { pl.archived += 1; out.sids.archived += 1; }
        c.unreadable = true;
        continue;
      }
      const prev = prevSids[c.sid] ?? null;
      const dirty = !prev || prev.pending === true
        || Number(prev.lastMtimeMs) !== log.mtimeMs || Number(prev.lastSize) !== log.size;
      if (dirty) { pl.dirty += 1; out.sids.dirty += 1; c.dirtyFlag = true; }
      if (!dirty && skipUnchanged) {
        pl.skippedUnchanged += 1;
        out.sids.skippedUnchanged += 1;
        c.skipped = true;
        if (Number.isInteger(Number(prev?.lastTurn))) c.turn = Number(prev.lastTurn);
        if (Number(prev?.atTurnMs) === 0) c.atTurnMs = null;
        continue;
      }
      // 预算：到点就**停止领新 sid**，剩余留在清单里（§6.2 ③ 正确形态 = 脚本自己计时）
      if (sidReads >= limit) { exceeded = true; c.pendingDirty = true; pl.unreadDirty += 1; out.sids.unreadDirty += 1; continue; }
      if (Date.now() - t0 > budgetMs) {
        out.budget.exceededBy = 'budgetMs';
        exceeded = true; c.pendingDirty = true; pl.unreadDirty += 1; out.sids.unreadDirty += 1; continue;
      }
      const ev = readEvents(log.file, { types: ['turn/start', 'turn/end'], lastN: 0, home: sessionHome });
      sidReads += 1;
      c.read = true;
      c.mtimeMs = log.mtimeMs;
      c.size = log.size;
      if (ev.stats?.frameFail > 0) {
        // P0' 口径：`frameFail>0` ⇒ **不报"没有事件"**，跳过该 sid
        pl.readErrors += 1;
        out.sids.readErrors += 1;
        const fails = Number(prev?.frameFail ?? 0) + 1;
        c.frameFail = fails;
        c.skipRead = true;
        notes.push(`frameFail=${ev.stats.frameFail}（${c.sid.slice(0, 8)}）⇒ 本轮跳过，不进分子分母`);
        if (fails < FRAME_FAIL_GIVE_UP) c.pending = true;
        continue;
      }
      pl.scanned += 1;
      out.sids.scanned += 1;

      const starts = ev.events.filter((e) => e.type === 'turn/start');
      const ends = ev.events.filter((e) => e.type === 'turn/end');
      const lastStart = starts.length ? starts[starts.length - 1] : null;
      const turn = Number(lastStart?.data?.turn);
      c.turn = Number.isInteger(turn) && turn > 0 ? turn : null;
      const endMsList = [];
      const endByTurn = new Map();
      for (const e of ends) {
        const t = Number(e?.data?.turn);
        const ms = Number(e?.time);
        if (!Number.isFinite(ms)) continue;
        if (Number.isInteger(t)) endByTurn.set(t, ms);
        endMsList.push(ms);
      }
      endTimesBySid.set(c.sid, endMsList);
      c.hasEvents = true;
      if (c.turn == null) continue;                                  // 还没开始过一轮
      const atMs = endByTurn.get(c.turn);
      if (!Number.isFinite(atMs)) { c.openTurn = true; continue; }    // 轮未闭合 ⇒ 不计分母、不判漏记
      c.atTurnMs = atMs;
      const sinceMs = c.ledgerSince ? msOfTs(c.ledgerSince) : null;
      if (sinceMs !== null && atMs < sinceMs - LEDGER_SINCE_TOL_MS) { c.beforeSince = true; continue; }

      // 存在性（要不要补）：**任何 by 的行都算"这一轮已经有账"**；被 void 的键按不存在处理
      const ks = keyStates(rowsByLine.get(c.lineId) ?? [], c.lineId);
      const hit = ks.get(`${c.sid}#${c.turn}`);
      if (hit && hit.voided !== true) { c.already = hit.by; out.sids.already += 1; continue; }
      // 跨线：同一 (sid,turn) 在**别的线**名下 ⇒ 报 line-mismatch、**不补**（§6.2 判据 2）
      let otherLine = null;
      for (const l of lines) {
        if (l.lineId === c.lineId) continue;
        const o = keyStates(rowsByLine.get(l.lineId) ?? [], l.lineId).get(`${c.sid}#${c.turn}`);
        if (o && o.voided !== true) { otherLine = l.lineId; break; }
      }
      if (otherLine) {
        c.mismatch = otherLine;
        out.lineMismatch.push({ sid: c.sid, lineId: c.lineId, otherLineId: otherLine, turn: c.turn });
        continue;
      }
      c.missing = true;
      pl.missing += 1;
      out.missing.push({
        sid: c.sid, lineId: c.lineId, turn: c.turn,
        atTurn: isoWithOffset(new Date(atMs)), atTurnMs: atMs,
      });
    }
    out.budget.sidReads = sidReads;
    out.budget.exceeded = exceeded;
    if (exceeded && !out.budget.exceededBy) out.budget.exceededBy = 'batchLimit';

    // ── ⑧ 落地段（逐笔：抢线锁 → 写一行 → 释放）
    if (apply) {
      const cardsCache = new Map();
      for (const m of out.missing) {
        out.wrote.attempted += 1;
        const line = lines.find((l) => l.lineId === m.lineId) ?? null;
        const aliases = [line?.line, ...(line?.aliases ?? [])].filter(Boolean);
        let cards = { cards: {}, state: 'unavailable' };
        if (readCards) {
          const ck = m.lineId;
          if (!cardsCache.has(ck)) cardsCache.set(ck, computeCards(sessionHome, aliases));
          cards = cardsCache.get(ck);
        } else {
          cards = { cards: {}, state: 'unavailable' };
        }
        const row = {
          v: 1,
          ts: nowIso,
          sid: m.sid,
          turn: m.turn,
          lineId: m.lineId,
          phase: 'scan-fill',
          src: 'scan',
          did: '',
          next: '',
          anchor: '',
          ref: '',
          cards: cards.cards ?? {},
          cardsState: cards.state ?? 'unavailable',
          by: 'scan',
          forTurn: m.turn,
          atTurn: m.atTurn,
          atTurnMs: m.atTurnMs,
          scope: 'ok',
          opId: `${m.sid.slice(0, 8)}-${m.turn}-${nowMs}`,
        };
        const res = appendRow(home, m.lineId, row);
        const pl = perLine.get(m.lineId);
        if (res.rc === 0 && res.action === 'appended') {
          out.wrote.appended += 1;
          if (pl) pl.wrote += 1;
          m.result = 'appended';
        } else if (res.rc === 0 && res.action === 'dup-skip') {
          out.wrote.dupSkip += 1;
          m.result = 'dup-skip';
        } else if (res.rc === 4) {
          out.wrote.lockMissed += 1;
          m.result = 'lock-missed';
          const c = scoped.find((x) => x.sid === m.sid);
          if (c) c.pending = true;   // 落地失败 ⇒ 下一轮即使 mtime 未变也要重试
        } else {
          out.wrote.failed += 1;
          m.result = `${res.action}:${res.rc}`;
          const c = scoped.find((x) => x.sid === m.sid);
          if (c) c.pending = true;
        }
        // cards 拿不到 ⇒ 记一笔 suppressed（幂等键 <sid>#<turn>，R-13 口径）
        if ((cards.state ?? 'ok') !== 'ok') {
          const sp = appendSuppressed(home, m.lineId, {
            ts: nowIso, day: today, phase: 'scan-fill', n: 1, reason: 'cardsUnavailable',
            key: `${m.sid}#${m.turn}`,
          });
          if (sp.action === 'suppressed-appended') out.suppressed.appended += 1;
          else if (sp.action === 'suppressed-dup-skip') out.suppressed.dupSkip += 1;
        }
      }
    } else {
      for (const m of out.missing) m.result = 'dry-run';
    }

    // ── ⑨ 漏记率（每线每天一次；**当天窗口未关闭 ⇒ value:null**，§5.0 第 12 行）
    if (apply) {
      // 🔴 先把"本 run 刚写进去的行"读回来再算 rate：`rowsByLine` 是**写之前**的快照，
      //   拿它算分子会漏掉刚补的 scan-fill 行 ⇒ 漏记率被低估 ⇒ **"补完自证清白"**（V9 明令不许）。
      //   重读一次也顺带吃进并发写者（人工 C 路）刚落的行。文件很小，代价可忽略。
      const wroteLines = new Set(out.missing.filter((m) => m.result === 'appended').map((m) => m.lineId));
      for (const lineId of wroteLines) {
        const rows = [];
        for (const m of months.slice().reverse()) {
          const f = path.join(ledgerDir(home), `${lineId}-${m}.jsonl`);
          for (const o of readJsonlRows(f).rows) rows.push(o);
        }
        rowsByLine.set(lineId, rows);
      }
      for (const l of lines) {
        const sidsOfLine = (lineSids.get(l.lineId) ?? new Set());
        if (!sidsOfLine.size) continue;
        const pl = perLine.get(l.lineId);
        const rateNow = computeRate({
          lineId: l.lineId, ledgerSince: l.ledgerSince ?? null, rows: rowsByLine.get(l.lineId) ?? [],
          sids: sidsOfLine, archivedSet: archiveSet, dirs, endTimesBySid,
          sessionHome, today, nowMs, pl, budgetLeft: () => (Date.now() - t0) < budgetMs,
        });
        const file = path.join(ledgerDir(home), RATES_DIR, `${l.lineId}.json`);
        const stored = readJsonIfAny(file);
        const storedDay = typeof stored?.day === 'string' ? stored.day : null;
        let targetDay = null;
        let windowClosed = false;
        if (storedDay === today) {
          out.rates.push({ lineId: l.lineId, action: 'skip-today', day: storedDay });
          continue;
        }
        if (storedDay && stored.windowClosed !== true) {
          // 关窗者 = 次日首轮：**先把昨天那一份算成 closed 落盘**（本 run 只做这一笔转换写，
          //  见交付报告「设计裁定」：一次 run 只写一个状态，②' 与 ②'' 才可能同时绿）
          targetDay = storedDay;
          windowClosed = true;
        } else {
          targetDay = today;
          windowClosed = false;
        }
        const r = rateNow(targetDay, windowClosed);
        if (!r) {
          out.rates.push({ lineId: l.lineId, action: 'skipped-budget', day: targetDay });
          notes.push(`${l.lineId}：rate 未写（本轮预算已用完，不写不完整的读数）`);
          continue;
        }
        const w = writeRate(home, l.lineId, r);
        out.rates.push({
          lineId: l.lineId, action: w.action, day: r.day, windowClosed: r.windowClosed,
          value: r.value, numerator: r.numerator, denominator: r.denominator, reason: r.reason ?? null,
        });
      }
    }

    // ── ⑩ 水位（**整份重写**，持第四把锁 `mainline-ledger:_cursor`）
    if (apply) {
      const nextCursor = scoped.length ? scoped[0].sid : null;
      const w = writeCursor(home, (cur) => {
        const sids = {};
        const candSet = new Set(scoped.map((c) => c.sid));
        const bySid = new Map(scoped.map((c) => [c.sid, c]));
        // ① 本轮候选：更新水位（没读的也留一条，lastMtimeMs/lastSize 沿用旧值）
        for (const c of scoped) {
          const prev = (cur.sids ?? {})[c.sid] ?? {};
          const entry = {
            lineId: c.lineId,
            lastScanAt: c.read ? nowIso : (prev.lastScanAt ?? null),
            lastMtimeMs: c.mtimeMs ?? prev.lastMtimeMs ?? null,
            lastSize: c.size ?? prev.lastSize ?? null,
            missStreak: 0,
          };
          if (Number.isInteger(c.turn)) entry.lastTurn = c.turn;
          else if (Number.isInteger(prev.lastTurn)) entry.lastTurn = prev.lastTurn;
          if (c.pending) entry.pending = true;
          if (c.frameFail) entry.frameFail = c.frameFail;
          sids[c.sid] = entry;
        }
        // ② 淘汰离场 sid（连续 N 轮不在活跃集里 ⇒ 摘掉；**首次消失记一行 `sids-lost`**）
        let evicted = 0;
        let lost = 0;
        for (const [sid, prev] of Object.entries(cur.sids ?? {})) {
          if (candSet.has(sid) || !prev || typeof prev !== 'object') continue;
          const streak = Number(prev.missStreak ?? 0) + 1;
          if (!prev.lostNoted) {
            const r = appendOps(home, null, {
              ts: nowIso, sid, turn: 0, phase: 'sids-lost', reason: 'vanished-from-candidates',
            });
            if (r.rc === 0) lost += 1;
          }
          if (streak >= EVICT_MISS_ROUNDS) { evicted += 1; continue; }
          sids[sid] = { ...prev, missStreak: streak, lostNoted: true };
        }
        // ③ 每条线一行（**必须包含 `_lines.json` 里每一条线**，否则上月分片的旧
        //    `lastScanAt` 会把"这个月没动过"的线读成永久 scan-stale）
        const linesOut = {};
        for (const l of allLines) {
          const prevLine = (cur.lines ?? {})[l.lineId] ?? {};
          const pl = perLine.get(l.lineId) ?? null;
          const covered = Boolean(pl && pl.touched);
          const dirtyUnread = pl ? pl.unreadDirty : 0;
          const prevMissed = Number(prevLine.consecutiveMissed ?? 0);
          const debtRounds = dirtyUnread > 0 ? prevMissed + 1 : 0;
          linesOut[l.lineId] = {
            lastScanAt: covered ? nowIso : (prevLine.lastScanAt ?? null),
            consecutiveMissed: debtRounds,
            debtRounds,
            dirtyUnread,
            skippedUnchanged: pl ? pl.skippedUnchanged : 0,
            scannedSids: pl ? pl.scanned : 0,
            unreadable: pl ? pl.unreadable : 0,
          };
        }
        return {
          cursor: nextCursor,
          sids,
          lines: linesOut,
          lastScanAt: nowIso,
          lastScannedSids: sidReads,
          batchLimit: limit,
          budgetMs,
          dirty: out.sids.dirty,
          unreadDirty: out.sids.unreadDirty,
          skippedUnchanged: out.sids.skippedUnchanged,
          candidates: out.sids.candidates,
          linesTotal: allLines.length,
          linesCovered: coveredCount(perLine, lines),
        };
      }, { ts: nowIso });
      if (w.rc === 0) {
        out.cursor.written = w.action === 'cursor-written';
        out.cursor.files = w.files ?? [];
      } else {
        notes.push(`cursor 写不下去（${w.action} / rc=${w.rc}）—— 下一轮最多多扫一遍，可重建`);
      }
    }

    // ── ⑪ 读数收口
    for (const l of lines) {
      const pl = perLine.get(l.lineId);
      if (pl && pl.touched) out.linesCovered += 1;
    }
    out.budget.elapsedMs = Date.now() - t0;
    // 心跳（§6.2「自举可见」：读端用最后一条心跳判活，而不是 `_cursor.json` 的存在与否）
    if (apply) {
      const hb = appendOps(home, null, {
        ts: nowIso, turn: 0, phase: 'scan-tick',
        reason: `lines=${out.linesCovered}/${out.linesTotal} sids=${out.sids.scanned}/${out.sids.candidates}`
          + ` dirty=${out.sids.dirty} unreadDirty=${out.sids.unreadDirty}`
          + ` skippedUnchanged=${out.sids.skippedUnchanged} appended=${out.wrote.appended}`
          + ` dup=${out.wrote.dupSkip} mismatch=${out.lineMismatch.length}`,
      });
      out.ops.heartbeat = hb.rc === 0;
      if (exceeded) {
        const be = appendOps(home, null, {
          ts: nowIso, turn: 0, phase: 'scan-budget-exceeded',
          reason: `limit=${limit} sidReads=${sidReads} exceededBy=${out.budget.exceededBy}`
            + ` unreadDirty=${out.sids.unreadDirty}（不假装全量）`,
        });
        out.ops.budgetExceeded = be.rc === 0;
      }
      // 覆盖不足 / 归线异常也留痕（失败可见：不许静默跳过）
      if (out.sids.unreadable > 0) {
        appendOps(home, null, {
          ts: nowIso, turn: 0, phase: 'logs-archived',
          reason: `${out.sids.unreadable} 个 sid 的日志读不到（含归档 ${out.sids.archived}）⇒ 不进分母`,
        });
      }
    }
    out.action = out.missing.length ? (apply ? 'scan-filled' : 'scan-plan') : 'scan-clean';
    return finish(out, nowMs);
  }

  /** 收口：补几条给人看的结论句 */
  function finish(o, _nowMs) {
    o.budget.sidReads = o.budget.sidReads ?? o.sids.scanned;
    o.budget.elapsedMs = o.budget.elapsedMs || (Date.now() - t0);
    return o;
  }
}

function coveredCount(perLine, lines) {
  let n = 0;
  for (const l of lines) {
    const pl = perLine.get(l.lineId);
    if (pl && pl.touched) n += 1;
  }
  return n;
}

/**
 * 漏记率算法（分子分母口径 = §6.2「漏记率的分子分母」那一段，**全档只许那一句**）。
 * @returns {(day:string, windowClosed:boolean) => object|null} 返回 null = 本轮预算不够、不写
 */
function computeRate(ctx) {
  return (day, windowClosed) => {
    const start = dayStartMs(day);
    const end = start + 24 * 3600 * 1000;
    const sinceMs = ctx.ledgerSince ? msOfTs(ctx.ledgerSince) : null;
    let denominator = 0;
    let archived = 0;
    let known = 0;
    let active = 0;
    let unread = 0;
    for (const sid of ctx.sids) {
      known += 1;
      if (ctx.archivedSet.has(sid)) archived += 1;
      const log = logOf(sid, ctx.dirs.map);
      if (!log) { unread += 1; continue; }
      active += 1;
      let times = ctx.endTimesBySid.get(sid);
      if (!times) {
        if (!ctx.budgetLeft()) return null;             // 预算不够 ⇒ 不写不完整的读数
        const ev = readEvents(log.file, { types: ['turn/end'], lastN: 0, home: ctx.sessionHome });
        if (ev.stats?.frameFail > 0) { unread += 1; continue; }
        times = ev.events.map((e) => Number(e?.time)).filter(Number.isFinite);
        ctx.endTimesBySid.set(sid, times);
      }
      for (const t of times) {
        if (t < start || t >= end) continue;
        if (sinceMs !== null && t < sinceMs - LEDGER_SINCE_TOL_MS) continue;
        denominator += 1;
      }
    }

    // 分子：`by:"scan"` 的 scan-fill 行（按 atTurn 归窗口）；同键已有真话行（含 mergedFrom）
    //   的不计入分子，改计 recoveredByTruth（否则"先补后覆盖"那一轮分子照记一笔，rate 虚高）
    const truthKeys = new Set();
    for (const r of ctx.rows) {
      if (!r) continue;
      if (r.by === 'self' || r.by === 'hook') truthKeys.add(`${r.sid}#${r.turn}`);
    }
    let numerator = 0;
    let recoveredByTruth = 0;
    let atTurnMissing = 0;
    for (const r of ctx.rows) {
      if (!r || String(r.phase ?? '') !== 'scan-fill') continue;
      if (String(r.by ?? '') !== 'scan') continue;
      let ms = Number(r.atTurnMs);
      if (!Number.isFinite(ms)) {
        atTurnMissing += 1;
        ms = msOfTs(r.ts);
      }
      if (ms === null || ms < start || ms >= end) continue;
      if (sinceMs !== null && ms < sinceMs - LEDGER_SINCE_TOL_MS) continue;
      if (truthKeys.has(`${r.sid}#${r.turn}`)) { recoveredByTruth += 1; continue; }
      numerator += 1;
    }

    // `scan-stale` 逐线判（§5.4 ①②③）：**该线本轮有没有被过一遍 / 有没有脏活没扫**
    //   ⚠️ 不能拿 `pl.scanned>0` 当"覆盖"：稳态下全部 sid 未变跳过（scanned=0）是**健康**，
    //      不是 stale —— 那样会把每一天的第一笔 rate 都判成 stale（本卡实测踩到）。
    const stale = !(ctx.pl && ctx.pl.touched) || (ctx.pl ? ctx.pl.unreadDirty > 0 : true);
    // 🔴 §5.0 第 12 行：**当日窗口未关闭 ⇒ `value:null` + `windowClosed:false`**
    //    （只有"关窗者"那一笔 = 次日首轮补算昨天，才有数）
    const value = (denominator > 0 && !stale && windowClosed) ? numerator / denominator : null;
    let note = '';
    if (stale) note = 'scan-stale：这条线本轮没被扫到 / 有脏 sid 未扫（rate 回 null，不报 0%）';
    else if (denominator === 0) note = '分母为 0（本线在这个窗口里没有可读的 turn/end）⇒ n/a';
    else if (!windowClosed) note = '当日窗口进行中（windowClosed:false）';
    return {
      day, windowClosed, numerator, denominator,
      value, note,
      atTurnMissing, archivedSids: archived, knownSids: known, activeSids: active,
      scanStale: stale, unmeasurable: denominator === 0,
      computedAt: isoWithOffset(),
      recoveredByTruth, unreadableSids: unread,
    };
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function usage() {
  return [
    'ledger-scan —— B 路扫描器（tickd job mainline-scan 的执行体，V9 §6.2）',
    '',
    '用法：ledger-scan [--home <dir>] [--now <ISO>] [--apply] [--json]',
    '                  [--limit <n>] [--budget-ms <n>] [--lines <lineId,…>] [--no-cards]',
    '                  [--no-skip-unchanged]',
    '',
    '默认 **dry-run**（只出清单、不写）；--apply 才写（主账 / _cursor / _rates / _suppressed / _ops）。',
    '--now <ISO>  注入"现在"（R-11：窗口 / 日期判定全走它，禁改系统时间）',
    '--home <dir> 账本家目录（夹具隔离的命门；缺省 ~/.dsh）',
  ].join('\n');
}

function humanLines(o) {
  const L = [];
  const tag = o.dryRun ? '🔎 dry-run（未写）' : '✅ apply';
  L.push(`${tag}：候选 ${o.sids.candidates} 个 sid / ${o.linesTotal} 条线；`
    + `读 ${o.sids.scanned} 个（dirty ${o.sids.dirty} · 未变跳过 ${o.sids.skippedUnchanged}`
    + ` · 预算外 ${o.sids.unreadDirty}）`);
  if (o.linesCovered !== undefined) L.push(`   本轮覆盖 ${o.linesCovered}/${o.linesTotal} 条线`);
  if (o.missing.length) {
    L.push(`   缺账 ${o.missing.length} 笔：`);
    for (const m of o.missing.slice(0, 20)) {
      L.push(`     · ${m.sid.slice(0, 8)} turn=${m.turn} @ ${m.atTurn} → ${m.lineId}`
        + `${m.result ? ` [${m.result}]` : ''}`);
    }
    if (o.missing.length > 20) L.push(`     … 还有 ${o.missing.length - 20} 笔`);
  } else {
    L.push('   没有要补的轮次');
  }
  if (o.lineMismatch.length) L.push(`   ⚠️ line-mismatch ${o.lineMismatch.length} 笔（该轮记在别的线下 ⇒ 不补）`);
  if (o.wrote.attempted) L.push(`   写：appended=${o.wrote.appended} dup-skip=${o.wrote.dupSkip}`
    + ` lock-missed=${o.wrote.lockMissed} failed=${o.wrote.failed}`);
  if (o.rates.length) {
    for (const r of o.rates) {
      L.push(`   rate ${r.lineId}：${r.action} day=${r.day} closed=${r.windowClosed}`
        + ` value=${r.value === null ? 'null' : r.value} (${r.numerator}/${r.denominator})`);
    }
  }
  if (o.cursor.written) L.push(`   _cursor 已写（evicted=${o.cursor.evicted} sids-lost=${o.cursor.sidsLost}）`);
  if (o.budget.exceeded) L.push(`   ⚠️ 超预算（${o.budget.exceededBy}）⇒ 剩余留清单，不假装全量`);
  L.push(`   耗时 ${o.budget.elapsedMs} ms · sidReads=${o.budget.sidReads}`);
  for (const n of o.notes.slice(0, 10)) L.push(`   · ${n}`);
  return L;
}

function main(argv) {
  const a = parseArgs(argv);
  OUT.json = a.json === true;
  if (a.help) {
    process.stdout.write(usage() + '\n');
    process.exitCode = 0;
    return;
  }
  if (a.unknown?.length) {
    emit({ rc: 2, tool: TOOL, action: 'bad-args', reason: `不认识的参数：--${a.unknown.join(' --')}` },
      [`❌ 参数错（rc=2）：不认识的参数 --${a.unknown.join(' --')}`]);
    return;
  }
  const apply = a.apply === true && a['dry-run'] !== true;
  let now = null;
  if (a.now) {
    now = new Date(a.now);
    if (Number.isNaN(now.getTime())) {
      emit({ rc: 2, tool: TOOL, action: 'bad-args', reason: `--now 认不出：${a.now}` }, [`❌ --now 认不出：${a.now}`]);
      return;
    }
  }
  let res;
  try {
    res = scan({
      home: a.home ? path.resolve(a.home) : dshHome(),
      now: now ?? new Date(),
      apply,
      limit: a.limit,
      budgetMs: a['budget-ms'],
      lines: a.lines ? String(a.lines).split(/[,，]/).map((s) => s.trim()).filter(Boolean) : null,
      cards: a['no-cards'] !== true,
      skipUnchanged: a['no-skip-unchanged'] !== true,
    });
  } catch (e) {
    emit({ rc: 3, tool: TOOL, action: 'exception', error: String(e?.message ?? e) },
      [`❌ 环境错（rc=3）：${e?.message ?? e}`]);
    return;
  }
  emit(res, humanLines(res));
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

export { main, computeRate, dayOf, dayStartMs };
