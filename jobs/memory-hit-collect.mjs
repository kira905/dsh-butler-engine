#!/usr/bin/env node
// dsh-butler / memory-hit-collect.mjs —— 记忆衰减 P1·A0 旁路采集（只读日志 → JSONL 事件流水）
//
// 真源（唯一口径）：`docs\方案-记忆衰减二期-半衰期与召回留痕-20261023.md` §5.1.1（实现契约十条）
//   ① 状态文件 state.json（先 .tmp 再 renameSync 原子覆盖）  ② 启动流程顺序写死
//   ③ 幂等键 sha1(原始行字节去行尾换行)                     ④ 写序：追加行 → 更新 offset
//   ⑤ 字段名是 `event`（不是 `kind`）                       ⑥ 夹具三条
//   ⑦ 不采曝光                                              ⑧ 保留 90 天 + 同 job 清理
//   ⑨ 时间基准 = 行内 `t`（禁文件 mtime）                    ⑩ 已知边界
//
// 红线（本文件必须始终满足）：
//   · **只读** `~/.dsh/logs/memory-recall*.log`：绝不修改 / 截断 / 重命名 / 删除日志
//   · **不碰插件**：`dsh-memory` 一个字节不改、不写 `memory.db`、不动 pinned
//   · **fail-open**：任何异常都不抛，返回可读 error（rc 见 EXIT，benign 类不打失败计数）
//   · 同一份日志跑 100 遍，JSONL 行数不变（幂等）
//
// EXIT（与 JOBS 的 benignExitCodes 对齐）：
//   0 = 正常（含"本批 0 新事件"）  ·  3 = benign（环境类 fail-open：日志缺失/目录不可写/上轮未释放）
//   1 = 用法错误或未预期异常（计入失败）
//
// 用法：
//   node memory-hit-collect.mjs --once            # dry-run：只打印"将读哪段 / 将写几行"，一个字节不写
//   node memory-hit-collect.mjs --once --apply    # 真采一次 + 落 state + 顺手清理过期分片
//   node memory-hit-collect.mjs --stats [--json]  # 只读统计（行数/坏行/停跑分钟 + SLO 口径）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── 常量（口径全在这，别散落）────────────────────────────────────────────────
export const SCHEMA_VERSION = 1;
export const MAIN_LOG = 'memory-recall.log';
/** 轮转名 = `memory-recall.<YYYYMMDD-HHmmss>.log`（`recall-log.mjs:42`）。**禁止**硬编码 `.1` 单代。 */
export const GEN_RE = /^memory-recall\.(\d{8}-\d{6})\.log$/;
export const SHARD_RE = /^(\d{4})-(\d{2})\.jsonl$/;
/** 保留 90 天 ⇒ 文件名月份 < 当前月 − 3 才算过期（§5.1.1 ⑧） */
export const KEEP_MONTHS = 3;
/** 删前要求 mtime 距今 > 10 分钟（无正在写迹象） */
export const PURGE_MIN_AGE_MS = 10 * 60 * 1000;
/** 锁陈旧判据：一轮实测毫秒级，5 分钟不释放视为陈旧（崩死残留） */
export const LOCK_STALE_MS = 5 * 60 * 1000;
export const STATE_FILE = 'state.json';
export const BADLINES_FILE = 'badlines.log';
export const PURGE_LOG_FILE = 'purge.log';
export const LOCK_FILE = '.collect.lock';

/** 事件映射（§5.1.1 ⑤）：**字段名写死 `event`** —— 写成 `row.kind` 恒 undefined ⇒ 静默采 0 行 */
export const EVENT_KEEP = new Set(['inject', 'expand', 'search']);
export const EVENT_DROP_KNOWN = new Set(['skip', 'warmup']);

/** SLO 口径（§7.3） */
export const SLO_STOP_MINUTES = 8 * 24 * 60;          // 8 天 = 1 个轮转周期
export const SLO_ACCEPT_LOST_MINUTES = 24 * 24 * 60;  // 24 天 ⇒ 接受丢数
export const SLO_BAD_RATE = 0.01;                     // 坏行率 > 1%
export const SLO_BAD_ABS = 10;                        // 或绝对值 > 10

export const EXIT = { OK: 0, USAGE: 1, BENIGN: 3 };

// ── 路径 ─────────────────────────────────────────────────────────────────────
export function defaultDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return path.join(os.homedir(), '.dsh');
}
export function defaultLogDir(home = defaultDshHome()) { return path.join(home, 'logs'); }
export function defaultHitsDir(home = defaultDshHome()) { return path.join(home, 'memory-hits'); }

// ── fileId / state ──────────────────────────────────────────────────────────
/**
 * `fileId` = `dev:ino` 字符串（bigint 直接 JSON.stringify 会抛 TypeError ⇒ 必须转字符串）。
 * 取不到（非 NTFS / 异常 / ino=0）⇒ 回退 `birthtimeMs:size`，并记 `fileIdSource`。
 */
export function fileIdOf(p) {
  try {
    const st = fs.statSync(p, { bigint: true });
    if (st.ino !== 0n) return { fileId: `${st.dev}:${st.ino}`, source: 'ino' };
  } catch { /* 落到回退 */ }
  try {
    const s = fs.statSync(p);
    return { fileId: `${Math.round(s.birthtimeMs)}:${s.size}`, source: 'birthtime-size' };
  } catch {
    return { fileId: null, source: null };
  }
}

export function statePathOf(hitsDir) { return path.join(hitsDir, STATE_FILE); }

/** 读状态；坏/缺 ⇒ null（不抛）。 */
export function readState(hitsDir) {
  try {
    const j = JSON.parse(fs.readFileSync(statePathOf(hitsDir), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const off = Number(j.offset);
    return {
      schemaVersion: Number(j.schemaVersion) || 0,
      fileId: typeof j.fileId === 'string' ? j.fileId : null,
      offset: Number.isFinite(off) ? Math.max(0, Math.trunc(off)) : 0,
      lastT: typeof j.lastT === 'string' ? j.lastT : null,
      fileIdSource: typeof j.fileIdSource === 'string' ? j.fileIdSource : null,
    };
  } catch {
    return null;
  }
}

/** 写状态：先 `.tmp` 再 `renameSync` 原子覆盖（同盘 ⇒ 原子；tickd 单写者）。 */
export function writeStateAtomic(hitsDir, state) {
  const p = statePathOf(hitsDir);
  const tmp = `${p}.tmp`;
  const body = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    fileId: state.fileId,
    offset: Math.trunc(state.offset),
    lastT: state.lastT ?? null,
    fileIdSource: state.fileIdSource ?? null,
  }, null, 2) + '\n';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, p);
}

// ── 读日志（多代 + 半行）────────────────────────────────────────────────────
/** 目录里所有轮转代（按时间戳名倒序 = 最新在前）。读不到 ⇒ []。 */
export function listGenerations(logDir) {
  let names = [];
  try { names = fs.readdirSync(logDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = GEN_RE.exec(n);
    if (m) out.push({ name: n, full: path.join(logDir, n), stamp: m[1] });
  }
  out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  return out;
}

/**
 * 从 `offset` 读到 EOF，只消费**最后一个换行之前的完整行**；末行半行不消费。
 * 返回行内容 Buffer（已去掉行尾 \n / \r\n —— 幂等键对 CRLF 不敏感，LF 文件逐字节等价）。
 */
export function readChunk(p, offset = 0) {
  const st = fs.statSync(p);
  const size = st.size;
  const start = Math.max(0, Math.trunc(offset));
  if (size <= start) return { lines: [], newOffset: size, partialBytes: 0, size, offsetClamp: start !== Math.trunc(offset) };
  const len = size - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(p, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { lines: [], newOffset: start, partialBytes: len, size, offsetClamp: false };
  const complete = buf.subarray(0, lastNl + 1);
  const lines = [];
  let s = 0;
  for (let i = 0; i < complete.length; i += 1) {
    if (complete[i] !== 0x0a) continue;
    let e = i;
    if (e > s && complete[e - 1] === 0x0d) e -= 1;
    lines.push(complete.subarray(s, e));
    s = i + 1;
  }
  return { lines, newOffset: start + lastNl + 1, partialBytes: len - (lastNl + 1), size, offsetClamp: false };
}

export function sha1Of(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** 行内 `t` → 月份分片名 `YYYY-MM`（**UTC**，与日志写侧 ISO 一致）；不可解析 ⇒ null。 */
export function monthOfT(t) {
  if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(t)) return null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthIndexOf(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''));
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

export function monthOfNow(now) {
  const d = new Date(now.getTime());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 当前月 + 上月（§5.1.1 ③ 写死的去重读取范围） */
export function dedupeMonths(now) {
  const cur = monthOfNow(now);
  const idx = monthIndexOf(cur);
  const prev = `${Math.floor((idx - 1) / 12)}-${String(((idx - 1) % 12) + 1).padStart(2, '0')}`;
  return [cur, prev];
}

/** 读已落盘分片的 sha1 集合（只读；坏行跳过不阻断）。 */
export function loadShardKeys(hitsDir, months) {
  const keys = new Set();
  for (const m of months) {
    let txt;
    try { txt = fs.readFileSync(path.join(hitsDir, `${m}.jsonl`), 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.sha1 === 'string') keys.add(o.sha1);
      } catch { /* 已落盘行坏了不该阻断采集 */ }
    }
  }
  return keys;
}

// ── 采集主体 ────────────────────────────────────────────────────────────────
/**
 * 采一次。
 * @param {{apply?:boolean, logDir?:string, hitsDir?:string, home?:string, now?:Date|string}} opts
 * @returns 结果对象（永不抛）：{ ok, apply, readLines, written, duplicates, badLines, warnings, ... }
 */
export function collect(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  const apply = opts.apply === true;
  const home = opts.home ?? defaultDshHome();
  const logDir = opts.logDir ?? defaultLogDir(home);
  const hitsDir = opts.hitsDir ?? defaultHitsDir(home);
  const main = path.join(logDir, MAIN_LOG);

  const res = {
    ok: true, apply, logDir, hitsDir, now: now.toISOString(),
    mainFileId: null, fileIdSource: null,
    rotated: false, prevFound: null, segments: [],
    readLines: 0, written: 0, duplicates: 0, badLines: 0,
    keptByEvent: { inject: 0, expand: 0, search: 0 },
    dropped: { skip: 0, warmup: 0 }, unknownEvents: 0,
    months: [], newOffset: null, lastT: null, partialBytes: 0,
    warnings: [], purge: null, error: null, benign: false,
  };

  const fail = (msg, benign = true) => {
    res.ok = false; res.error = msg; res.benign = benign;
    return res;
  };

  // ① 取当前 main 的 fileId
  const cur = fileIdOf(main);
  if (!cur.fileId) return fail(`读不到日志文件：${main}`);
  res.mainFileId = cur.fileId; res.fileIdSource = cur.source;

  const state = readState(hitsDir);

  // ② 启动流程（顺序写死）：同代 ⇒ 从 offset；异代 ⇒ 旧代读到 EOF + 新 main 从 0
  const segs = [];
  if (state && state.fileId && state.fileId === cur.fileId) {
    let off = state.offset;
    try {
      const size = fs.statSync(main).size;
      if (off > size) { res.warnings.push(`offset ${off} > size ${size}（文件被替换？）⇒ 从 0 读`); off = 0; }
    } catch { /* stat 失败留给 readChunk 报 */ }
    segs.push({ p: main, offset: off, tag: 'main', gen: null });
  } else if (state && state.fileId) {
    // ③ 不同 ⇒ 判轮转：先补旧代（按 fileId 找，**不按 `.1` 猜**）
    res.rotated = true;
    let prev = null;
    for (const g of listGenerations(logDir)) {
      const id = fileIdOf(g.full).fileId;
      if (id && id === state.fileId) { prev = g; break; }
    }
    if (prev) {
      res.prevFound = prev.name;
      segs.push({ p: prev.full, offset: state.offset, tag: 'prev', gen: prev.name });
    } else {
      // ④ 旧代找不到 ⇒ 记 warn，从新文件头读，**不重头刷全库**
      res.warnings.push('previous generation missing');
    }
    segs.push({ p: main, offset: 0, tag: 'main', gen: null });
  } else {
    // 首次运行：无状态 ⇒ main 从头读
    segs.push({ p: main, offset: 0, tag: 'main', gen: null });
  }

  // 读三段（每段独立 try/catch：一段坏了不拖整批）
  const raw = [];   // { buf, sha1, row, month, t, tms, seq }
  let seq = 0;
  for (const s of segs) {
    let chunk;
    try {
      chunk = readChunk(s.p, s.offset);
    } catch (e) {
      res.warnings.push(`读 ${path.basename(s.p)}@${s.offset} 失败：${e?.message ?? e}`);
      res.segments.push({ tag: s.tag, file: path.basename(s.p), offset: s.offset, lines: 0, error: String(e?.message ?? e) });
      continue;
    }
    res.segments.push({ tag: s.tag, file: path.basename(s.p), offset: s.offset, lines: chunk.lines.length, newOffset: chunk.newOffset, partialBytes: chunk.partialBytes });
    res.readLines += chunk.lines.length;
    if (s.tag === 'main') { res.newOffset = chunk.newOffset; res.partialBytes = chunk.partialBytes; }
    for (const buf of chunk.lines) {
      const sha1 = sha1Of(buf);
      let row;
      try {
        row = JSON.parse(buf.toString('utf8'));
      } catch {
        res.badLines += 1;
        pushBadLine(hitsDir, { sha1, bytes: buf.length });
        continue;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        res.badLines += 1;
        pushBadLine(hitsDir, { sha1, bytes: buf.length });
        continue;
      }
      // ⑤ 事件过滤：字段名 `event`
      const ev = row.event;
      if (EVENT_KEEP.has(ev)) {
        const month = monthOfT(row.t);
        if (!month) {           // 时间基准不可解析 ⇒ 认坏行（不能落错分片）
          res.badLines += 1;
          pushBadLine(hitsDir, { sha1, bytes: buf.length });
          continue;
        }
        res.keptByEvent[ev] += 1;
        raw.push({ buf, sha1, row, month, t: row.t, tms: Date.parse(row.t), seq: seq++ });
      } else if (EVENT_DROP_KNOWN.has(ev)) {
        res.dropped[ev] += 1;
      } else {
        res.unknownEvents += 1;   // 未知值：丢弃 + 计数（防 `kind` 回潮的告警面）
      }
    }
  }

  // ③ 幂等键去重：本批 Set + 已落盘（当前月 + 上月 + 本批实际要写的月 —— 后者是超集，
  //    为的是"迟到的旧月份事件"重跑也不会重复；见报告 §A0 口径注）
  const monthsToScan = new Set([...dedupeMonths(now), ...raw.map((r) => r.month)]);
  const onDisk = loadShardKeys(hitsDir, [...monthsToScan]);
  const seen = new Set();
  const picked = [];
  for (const r of raw) {
    if (onDisk.has(r.sha1) || seen.has(r.sha1)) { res.duplicates += 1; continue; }
    seen.add(r.sha1);
    picked.push(r);
  }

  // 两批合并后按行内 `t` 稳定排序
  picked.sort((a, b) => (a.tms - b.tms) || (a.seq - b.seq));

  // ⑥ 断言：写入 > 0 或 读取 = 0；其余计 warn（`kind` 静默失败点回潮的报警器）
  //   ⚠️ 订正（2026-10-23 主线验收 · 卡 9c2b86cd）：本批「只有 skip/warmup（设计内丢弃）」
  //      或「只有坏行（坏行率自有 SLO 管）」是**正常批次**，原先落进 else ⇒ 天天误报
  //      （实测：真机第二跑读了 1 行 skip 就告警）。⇒ 先判良性，剩下才是真异常。
  const legitDropped = (res.dropped.skip ?? 0) + (res.dropped.warmup ?? 0) + (res.badLines ?? 0);
  if (res.readLines > 0 && picked.length === 0) {
    if (res.duplicates > 0) {
      res.warnings.push(`本批 ${res.readLines} 行全部已在盘上（幂等重放）`);
    } else if (res.unknownEvents > 0 && Object.values(res.keptByEvent).every((n) => n === 0)) {
      res.warnings.push(`本批 ${res.readLines} 行全部落进"未知事件"（检查字段名是否仍是 event）`);
    } else if (legitDropped >= res.readLines) {
      res.skippedBatch = true; // 良性批次：全是设计内丢弃 / 坏行 ⇒ 不告警
    } else {
      res.warnings.push(`本批读取 ${res.readLines} 行但写入 0 行（除幂等/未知/设计内丢弃外不应出现）`);
    }
  }

  const byMonth = new Map();
  for (const r of picked) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, []);
    byMonth.get(r.month).push(r);
  }
  res.months = [...byMonth.keys()].sort();
  res.pendingRows = picked.length;

  if (!apply) {
    // dry-run：一个字节不写（连 state 都不碰）
    res.lastT = picked.length ? picked[picked.length - 1].t : (state?.lastT ?? null);
    res.stateAfter = { fileId: cur.fileId, offset: res.newOffset, lastT: res.lastT, fileIdSource: cur.source };
    return res;
  }

  // ⑦ 真写：单写入者互斥 → 追加行 → 更新 offset（顺序不可反）→ 清理过期分片
  let lock = null;
  try {
    lock = acquireLock(hitsDir, now);
    if (!lock.ok) return fail(lock.error, true);

    let written = 0;
    let lastT = state?.lastT ?? null;
    for (const month of res.months) {
      const rows = byMonth.get(month);
      const body = rows.map((r) => JSON.stringify({ sha1: r.sha1, ...r.row })).join('\n') + '\n';
      try {
        fs.appendFileSync(path.join(hitsDir, `${month}.jsonl`), body, 'utf8');
      } catch (e) {
        // 半途写失败：**不更新 state**（下轮重读该段；已落盘部分由幂等键挡重复）
        return fail(`追加 ${month}.jsonl 失败：${e?.message ?? e}`);
      }
      written += rows.length;
      lastT = rows[rows.length - 1].t;
    }
    res.written = written;
    res.lastT = lastT;

    // ⑤ 整批写完才更新 state
    try {
      writeStateAtomic(hitsDir, { fileId: cur.fileId, offset: res.newOffset ?? 0, lastT, fileIdSource: cur.source });
    } catch (e) {
      return fail(`写 state 失败：${e?.message ?? e}`);
    }

    // ⑧ 保留 90 天（同一 job 内；失败只 warn 不重试）
    try {
      res.purge = purgeExpired({ hitsDir, now, apply: true });
      for (const w of res.purge.warnings) res.warnings.push(`purge: ${w}`);
    } catch (e) {
      res.warnings.push(`purge 异常（下周期再试，不重试）：${e?.message ?? e}`);
    }
  } catch (e) {
    return fail(`采集异常：${e?.message ?? e}`);
  } finally {
    if (lock && lock.ok) { try { lock.release(); } catch { /* ignore */ } }
  }
  return res;
}

/** 坏行只记 sha1 + 字节数，**绝不落原文**（§5.1.1 ④）。失败静默（不能因日志而中断整批）。 */
function pushBadLine(hitsDir, { sha1, bytes }) {
  try {
    fs.mkdirSync(hitsDir, { recursive: true });
    fs.appendFileSync(path.join(hitsDir, BADLINES_FILE), JSON.stringify({ t: new Date().toISOString(), sha1, bytes }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 独占锁（tickd 与手工直跑可能撞；陈旧 5 分钟自动接管）。 */
export function acquireLock(hitsDir, now = new Date()) {
  try { fs.mkdirSync(hitsDir, { recursive: true }); } catch (e) { return { ok: false, error: `hits 目录不可用：${e?.message ?? e}` }; }
  const p = path.join(hitsDir, LOCK_FILE);
  const body = JSON.stringify({ pid: process.pid, t: now.toISOString() });
  const make = () => {
    fs.writeFileSync(p, body, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, release() { try { fs.unlinkSync(p); } catch { /* ignore */ } } };
  };
  try {
    return make();
  } catch (e) {
    if (e?.code !== 'EEXIST') return { ok: false, error: `锁文件不可写：${e?.message ?? e}` };
  }
  try {
    const st = fs.statSync(p);
    if (now.getTime() - st.mtimeMs > LOCK_STALE_MS) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
      return make();
    }
  } catch { /* 锁文件刚被释放 ⇒ 视为可抢 */ try { return make(); } catch { /* fallthrough */ } }
  return { ok: false, error: '上一轮仍在跑（锁未释放）' };
}

/**
 * ⑧ 保留 90 天：删前三条同时满足（①存在可读 ②非当前月分片 ③mtime > 10 分钟），删前写 purge.log。
 * 失败只记 warn（禁循环重试）。
 */
export function purgeExpired({ hitsDir, now = new Date(), apply = false } = {}) {
  const out = { checked: 0, purged: [], skipped: [], warnings: [] };
  let names;
  try { names = fs.readdirSync(hitsDir); } catch (e) { out.warnings.push(`读目录失败：${e?.message ?? e}`); return out; }
  const curIdx = monthIndexOf(monthOfNow(now));
  for (const n of names) {
    const m = SHARD_RE.exec(n);
    if (!m) continue;
    out.checked += 1;
    const idx = monthIndexOf(`${m[1]}-${m[2]}`);
    if (idx === null) { out.skipped.push({ file: n, reason: 'month-unparsable' }); continue; }
    if (!(idx < curIdx - KEEP_MONTHS)) continue; // 未过期（≥ 当前月 − 3）
    const full = path.join(hitsDir, n);
    let st;
    try { st = fs.statSync(full); } catch { out.skipped.push({ file: n, reason: 'unreadable' }); continue; }
    if (!st.isFile()) { out.skipped.push({ file: n, reason: 'not-file' }); continue; }
    let txt;
    try { txt = fs.readFileSync(full, 'utf8'); } catch { out.skipped.push({ file: n, reason: 'unreadable' }); continue; }
    if (now.getTime() - st.mtimeMs <= PURGE_MIN_AGE_MS) { out.skipped.push({ file: n, reason: 'recent-write' }); continue; }
    const rows = txt.split('\n').filter((x) => x.length > 0).length;
    if (!apply) { out.purged.push({ file: n, bytes: st.size, rows, dryRun: true }); continue; }
    try {
      fs.appendFileSync(path.join(hitsDir, PURGE_LOG_FILE),
        JSON.stringify({ t: now.toISOString(), file: n, bytes: st.size, rows }) + '\n', 'utf8');
      fs.unlinkSync(full);
      out.purged.push({ file: n, bytes: st.size, rows });
    } catch (e) {
      out.warnings.push(`删 ${n} 失败（下周期再试）：${e?.message ?? e}`);
    }
  }
  return out;
}

// ── 统计（--stats / 日报一行）───────────────────────────────────────────────
/** 只读统计：行数 / 坏行 / 停跑分钟 + 三条 SLO 口径（告警接线不属本件）。 */
export function statsReport({ hitsDir = defaultHitsDir(), logDir = defaultLogDir(), now = new Date(), days = 7 } = {}) {
  const out = {
    ok: true, hitsDir, logDir, now: new Date(now).toISOString(),
    shards: [], totalRows: 0, rowsByMonth: {}, rowsPerDay: 0, rowsToday: 0,
    badLines: 0, consumed: 0, badRate: 0,
    lastT: null, stopMinutes: null,
    state: null, warnings: [],
    slo: { stop: null, badRate: null },
  };
  try {
    const state = readState(hitsDir);
    out.state = state;
    let names = [];
    try { names = fs.readdirSync(hitsDir); } catch { names = []; }
    const t0 = new Date(now).getTime();
    const windowStart = t0 - days * 86400000;
    const todayKey = new Date(t0).toISOString().slice(0, 10);
    let inWindow = 0;
    let latest = null;
    const daySet = new Set();   // 窗口内**真有事件**的日期（分母口径，见下）
    for (const n of names) {
      if (!SHARD_RE.test(n)) continue;
      const p = path.join(hitsDir, n);
      let txt; let st;
      try { txt = fs.readFileSync(p, 'utf8'); st = fs.statSync(p); } catch { continue; }
      const lines = txt.split('\n').filter((x) => x.length > 0);
      let rows = 0;
      for (const line of lines) {
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        rows += 1;
        const ms = Date.parse(o?.t ?? '');
        if (Number.isFinite(ms)) {
          if (ms >= windowStart && ms <= t0) { inWindow += 1; daySet.add(o.t.slice(0, 10)); }
          if (!latest || ms > latest) latest = ms;
          if (o.t.slice(0, 10) === todayKey) out.rowsToday += 1;
        }
      }
      out.shards.push({ file: n, bytes: st.size, rows, mtime: new Date(st.mtimeMs).toISOString() });
      out.rowsByMonth[n.replace('.jsonl', '')] = rows;
      out.totalRows += rows;
    }
    out.shards.sort((a, b) => (a.file < b.file ? -1 : 1));
    // 「N 行/天」的分母 = **窗口内真有事件的天数**（`min(days, 观测天数)`），不是硬写 days：
    //   留痕刚起步时只有 4 天数据，拿 7 除会把真实速率压成 57%（实测 445 行/5 天 = 89 行/天 vs 除以 7 = 64）。
    const distinctDays = daySet.size;
    const divisor = Math.max(1, Math.min(days, distinctDays || 1));
    out.distinctDays = distinctDays;
    out.windowDays = divisor;
    out.rowsPerDay = Math.round((inWindow / divisor) * 10) / 10;
    try {
      const bad = fs.readFileSync(path.join(hitsDir, BADLINES_FILE), 'utf8').split('\n').filter((x) => x.length > 0);
      out.badLines = bad.length;
    } catch { out.badLines = 0; }
    out.consumed = out.totalRows + out.badLines;
    out.badRate = out.consumed > 0 ? out.badLines / out.consumed : 0;
    const lastT = (state && state.lastT) || (latest ? new Date(latest).toISOString() : null);
    out.lastT = lastT;
    if (lastT) {
      const ms = Date.parse(lastT);
      if (Number.isFinite(ms)) out.stopMinutes = Math.max(0, Math.round((t0 - ms) / 60000));
    }
    out.slo = {
      stop: {
        minutes: out.stopMinutes,
        limitMinutes: SLO_STOP_MINUTES,
        breach: out.stopMinutes !== null && out.stopMinutes > SLO_STOP_MINUTES,
        acceptLost: out.stopMinutes !== null && out.stopMinutes > SLO_ACCEPT_LOST_MINUTES,
        note: `> ${SLO_STOP_MINUTES} 分钟（8 天 = 1 个轮转周期）告警；> ${SLO_ACCEPT_LOST_MINUTES} 分钟（24 天）接受丢数`,
      },
      badRate: {
        rate: out.badRate, badLines: out.badLines, consumed: out.consumed,
        threshold: SLO_BAD_RATE, absoluteThreshold: SLO_BAD_ABS,
        breach: out.badRate > SLO_BAD_RATE || out.badLines > SLO_BAD_ABS,
        note: 'badLines /（已落盘行 + 坏行）> 1% 或 badLines > 10 ⇒ 告警（口径 = 累计，非单批）',
      },
    };
  } catch (e) {
    out.ok = false; out.error = String(e?.message ?? e);
  }
  return out;
}

/** 日报一行（§7.3「可见读数」）。只读 + fail-open：watch 永不被它拖挂。 */
export function hitStatsLine(opts = {}) {
  try {
    const r = statsReport(opts);
    if (!r.ok) return `- 🧠 记忆 hit 采集：❔ 读不到（${r.error}）`;
    const n = Math.round(r.rowsPerDay);
    const k = r.stopMinutes === null ? '?' : r.stopMinutes;
    const flag = [];
    if (r.slo?.stop?.breach) flag.push('停跑超期');
    if (r.slo?.badRate?.breach) flag.push('坏行偏高');
    return `- 🧠 记忆 hit 采集：${n} 行/天 · 坏行 ${r.badLines} · 停跑 ${k} 分钟${flag.length ? ` · ⚠️ ${flag.join('、')}` : ''}`;
  } catch (e) {
    return `- 🧠 记忆 hit 采集：❔ 判定异常（${e?.message ?? e}）`;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = `memory-hit-collect.mjs —— 记忆衰减 P1·A0 旁路采集（只读日志 → JSONL）

  --once               采一次（**默认 dry-run**：只打印将读哪段/将写几行，一个字节不写）
  --once --apply       真采一次：追加 JSONL → 更新 state.json → 顺手清理过期分片
  --stats [--json]     只读统计（行数 / 坏行 / 停跑分钟 + SLO 口径）
  --log-dir <dir>      日志目录（缺省 $DSH_HOME/logs 或 ~/.dsh/logs）
  --hits-dir <dir>     输出目录（缺省 $DSH_HOME/memory-hits 或 ~/.dsh/memory-hits）
  --now <iso>          时间基准覆盖（夹具用）

退出码：0 正常 · 3 benign（日志缺失/目录不可写/上轮未释放）· 1 用法或未预期异常
`;

export function parseArgs(argv) {
  const o = { mode: 'collect', apply: false, json: false, logDir: null, hitsDir: null, now: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') o.mode = 'collect';
    else if (a === '--apply') o.apply = true;
    else if (a === '--stats') o.mode = 'stats';
    else if (a === '--json') o.json = true;
    else if (a === '--log-dir') o.logDir = argv[++i] ?? null;
    else if (a === '--hits-dir') o.hitsDir = argv[++i] ?? null;
    else if (a === '--now') o.now = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') o.mode = 'help';
    else return { error: `未知参数：${a}` };
  }
  return o;
}

function fmtCollect(r) {
  const L = [];
  L.push(`[hit-collect] ${r.apply ? 'APPLY' : 'DRY-RUN'} log=${r.logDir} hits=${r.hitsDir}`);
  L.push(`  main fileId=${r.mainFileId}（${r.fileIdSource}）· state=${r.rotated ? '轮转（读旧代 + 新 main）' : '同代增量'}`);
  for (const s of r.segments) {
    L.push(`  段 ${s.tag}：${s.file}@${s.offset}${s.error ? ` ✗ ${s.error}` : ` → ${s.lines} 行，至 ${s.newOffset}${s.partialBytes ? `（半行 ${s.partialBytes} B 不消费）` : ''}`}`);
  }
  L.push(`  读 ${r.readLines} 行 · 保留 ${r.keptByEvent.inject} inject / ${r.keptByEvent.expand} expand / ${r.keptByEvent.search} search`
    + ` · 丢 skip ${r.dropped.skip} / warmup ${r.dropped.warmup} · 未知事件 ${r.unknownEvents} · 坏行 ${r.badLines}`);
  if (!r.ok) {
    L.push(`  ✗ ${r.error}${r.benign ? '（benign）' : ''}`);
  } else if (r.apply) {
    L.push(`  ✅ 写入 ${r.written} 行 → ${r.months.length ? r.months.map((m) => `${m}.jsonl`).join(' / ') : '（无）'} · 重复跳过 ${r.duplicates} · lastT ${r.lastT ?? '-'}`);
    if (r.purge) L.push(`  清理：检查 ${r.purge.checked} 片 · 删 ${r.purge.purged.length} · 跳过 ${r.purge.skipped.length}`);
  } else {
    L.push(`  将写 ${r.pendingRows} 行 → ${r.months.length ? r.months.map((m) => `${m}.jsonl`).join(' / ') : '（无）'} · 重复跳过 ${r.duplicates}（dry-run：一个字节未写）`);
  }
  for (const w of r.warnings) L.push(`  ⚠️ ${w}`);
  return L.join('\n');
}

function fmtStats(r) {
  const L = [];
  L.push(`[hit-collect --stats] ${r.ok ? '' : `✗ ${r.error}`}`.trim());
  L.push(`  分片：${r.shards.length ? r.shards.map((s) => `${s.file} ${s.rows} 行 / ${s.bytes} B`).join('；') : '（无）'}`);
  L.push(`  合计 ${r.totalRows} 行 · 近 ${r.windowDays ?? 7} 天（观测 ${r.distinctDays ?? '?'} 天）${r.rowsPerDay} 行/天 · 今日 ${r.rowsToday} 行 · 坏行 ${r.badLines}（率 ${(r.badRate * 100).toFixed(2)}%）`);
  L.push(`  停跑：${r.stopMinutes === null ? '?' : r.stopMinutes} 分钟（末事件 ${r.lastT ?? '-'}）`);
  L.push(`  SLO 停跑：>${r.slo.stop.limitMinutes} 分钟告警 ⇒ ${r.slo.stop.breach ? '⚠️ 超期' : '正常'}${r.slo.stop.acceptLost ? '（已超 24 天，接受丢数）' : ''}`);
  L.push(`  SLO 坏行：率 ${(r.slo.badRate.rate * 100).toFixed(2)}% / 阈 ${(r.slo.badRate.threshold * 100).toFixed(0)}% 或 >${r.slo.badRate.absoluteThreshold} ⇒ ${r.slo.badRate.breach ? '⚠️ 偏高' : '正常'}`);
  L.push(`  日报一行：${hitStatsLine({ hitsDir: r.hitsDir, logDir: r.logDir, now: r.now })}`);
  return L.join('\n');
}

function isMainEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const opts = parseArgs(process.argv.slice(2));
  let rc = EXIT.OK;
  if (opts.error) {
    process.stdout.write(`${opts.error}\n${USAGE}\n`);
    rc = EXIT.USAGE;
  } else if (opts.mode === 'help') {
    process.stdout.write(USAGE);
  } else if (opts.mode === 'stats') {
    const r = statsReport({ hitsDir: opts.hitsDir ?? defaultHitsDir(), logDir: opts.logDir ?? defaultLogDir(), now: opts.now ?? Date.now() });
    process.stdout.write((opts.json ? JSON.stringify(r) : fmtStats(r)) + '\n');
  } else {
    const r = collect({ apply: opts.apply, logDir: opts.logDir ?? undefined, hitsDir: opts.hitsDir ?? undefined, now: opts.now ?? undefined });
    process.stdout.write((opts.json ? JSON.stringify(r) : fmtCollect(r)) + '\n');
    if (!r.ok) rc = r.benign ? EXIT.BENIGN : EXIT.USAGE;
  }
  process.exitCode = rc;
}
