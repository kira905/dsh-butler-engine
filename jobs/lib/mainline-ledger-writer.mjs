// ============================================================================
// dsh-butler / lib/mainline-ledger-writer.mjs —— 主线流水小本本的**唯一写口**
//
// 出处：docs\方案-三层角色工作方式与主线流水-V9.md
//   §5.0（L166-197）不变量 2「一个载体只有一个 writer 模块」+ 写者×载体×锁×rc 表
//   §5.1（L199-265）载体形状 / 文件名 / `_lines.json` 容器 / `_sids` 判重窗口
//   §5.2（L266-318）append-only + 同键跳重 + 单写者锁 + 按 row.ts 分月路由 + 写序六步
//   §5.3（L319-384）唯一写入口 + rc 表
//
// 🔴 命名警告：本文件与 `lib\ledger-write.mjs` **只差几个字符、毫无关系** —— 后者写的是
//   **看板账本**（`defaultLedgerPath` / `readLedger` / `writeLedger` / `makeLedgerWriter`）。
//   `import` 抄错不报错、只会写错账本（方案 §5.0 L167 已写死这条警告）。
//
// 三条不变量（本模块是第 2 条的实现件）：
//   1. 读端零写盘 —— `ledger-read.mjs` 不 import 本模块、不调任何写函数
//   2. 一个载体只有一个 writer 模块 —— `~\.dsh\mainline-ledger\` 下的每一次落盘都在本文件
//      （机械判据：`node <pkg>\jobs\ledger-writer-audit.mjs --root <workspace>\tools\dsh-butler`）
//   3. 锁只在"写那一笔"时持 —— 遍历 / 扫描 / 读全部不持锁
//
// 本卡（P1-b）实现 §5.0 表的第 1/2/4/5/6/7/8 行；**不实现**第 9（writeCursor）/ 10
//   （appendSuppressed）/ 12（writeRate）行与 `_quarantine\`（quarantineRows）—— 它们是
//   P1b/P2 的活，留空位（导出名已在 §5.0 表里，别在这里半实现）。
//
// 锁序（§5.1 L209 写死）：**线锁在前、`_lines` 锁在后，两段永不同时持有**。
//   本文件里没有任何一条路径同时握两把锁 ⇒ 构不成环、不需要跨锁事务。
//   ⚠️ 由此推出两条实现纪律：
//     · `appendOps` **不单独加锁**（调用时必然已持线锁；唯一无锁路径 = 抢锁失败后写
//       `lock-missed`，单次 append ≤4 KiB 不交错 —— 方案 §5.2 L309 明写允许）
//     · `ensureHome` **不抢 `_lines` 锁**，用 `O_EXCL`（`wx`）原子创建 `_meta.json`
//       —— 并发首跑不会互相覆盖，比"先抢锁再建"更严，且避免与 `writeLinesMap`
//       （它已持 `_lines` 锁）嵌套死锁。⚠️ 与方案 §5.0 第 8 行"持 `_lines` 锁"的
//       差异已记进交付报告 §4。
//
// 只写盘、不判断业务（phase 白名单的**取号**在 `lib\ledger-phases.mjs`，
//   actor 判定在 `lib\session-header.mjs`，本文件只做"行守卫 + 落盘 + 跳重"）。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { acquireTickLock } from '../../src/dsh-butler/lib/store.mjs';
import { hostTag } from '../../src/dsh-butler/lib/host-tag.mjs';
import { PHASES, isPhase } from './ledger-phases.mjs';

// ---------------------------------------------------------------------------
// 常量（口径全部来自方案，改这里前先改方案）
// ---------------------------------------------------------------------------
export const LEDGER_DIR_NAME = 'mainline-ledger';
export const SCHEMA_VERSION = 1;
export const ROW_VERSION = 1;
/** 线锁 ttl（§5.0 表第 1 行：`ttlMs:30_000`） */
export const LINE_LOCK_TTL_MS = 30_000;
/** `_lines.json` / 未归线队列的锁名（§5.1 L209） */
export const LINES_LOCK_NAME = 'mainline-ledger:_lines';
/** 线锁名前缀（完整名 = 前缀 + lineId） */
export const LINE_LOCK_PREFIX = 'mainline-ledger:';
/** §5.2 ②' 幂等键覆盖窗口：从文件末尾向前读满 2 MiB */
export const KEY_SCAN_BYTES = 2 * 1024 * 1024;
/** §5.1 `_sids` 判重窗口：一律取尾 1 MiB */
export const SID_DEDUP_BYTES = 1024 * 1024;
/** §5.1 `_sids` 预警阈值：> 800 KiB ⇒ 写一行 `.ops` `sids-file-large` */
export const SID_WARN_BYTES = 800 * 1024;
/** `.ops` 单行上限（≤4 KiB 不交错，这是唯一被允许的无锁写） */
export const OPS_LINE_MAX = 4096;
/** lineId 形状：`l-<hostTag()>-<NNN>`（§5.1 L208；host 段只许 [a-z0-9-]） */
export const LINE_ID_RE = /^l-[a-z0-9-]+-\d{3,}$/;
/** 裸 uuid（落盘规范形，§5.1 L217） */
export const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 三种 by（`src` 不在这里判，写端只管 by） */
export const BY_VALUES = ['self', 'hook', 'scan'];
/**
 * `_sids` 行的 `how` 白名单（§5.0 第 5 行）。
 *   · `claim` = 人工 `ledger-line --claim`
 *   · `guess` = 自动猜配（保留旧值，未启用）
 *   · `relay` = **2026-11-04 新增**：`session-relay.mjs` 接力成功后自动补认领（交接换了新 sid，账本必须跟上）
 * 白名单外的一律回落 `claim`（**旧行为逐字不变**：改动前就是"非 guess 全写 claim"）。
 */
export const SID_HOW_VALUES = ['claim', 'guess', 'relay'];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 北京时间带偏移的 ISO（§5.1 字段表 `ts`：**写入时刻**，不是"被记那一轮"的时刻）。 */
export function isoWithOffset(d = new Date()) {
  const off = -d.getTimezoneOffset(); // 分钟，东八区 = 480
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 月份键 `YYYYMM`（按 `row.ts` 的**本地**月份路由；§5.1 文件名行）。 */
export function monthOf(ts) {
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/.test(ts)) {
    return ts.slice(0, 4) + ts.slice(5, 7); // 带偏移的字面量按字面月份（我们只写北京时间）
  }
  const d = ts instanceof Date ? ts : new Date(ts ?? Date.now());
  if (Number.isNaN(d.getTime())) throw new Error(`monthOf: 非法 ts = ${String(ts)}`);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}`;
}

/** 账本目录（`<home>\mainline-ledger`）。 */
export function ledgerDir(home) {
  return path.join(home, LEDGER_DIR_NAME);
}

/** 主账文件：`<lineId>-<YYYYMM>.jsonl`（当月也带月后缀，§5.1 L204）。 */
export function ledgerFile(home, lineId, ts) {
  return path.join(ledgerDir(home), `${lineId}-${monthOf(ts)}.jsonl`);
}

export function isLineId(s) {
  return typeof s === 'string' && LINE_ID_RE.test(s);
}

export function isBareUuid(s) {
  return typeof s === 'string' && BARE_UUID_RE.test(s);
}

/** `sid` 规范形：去 `session-` 前缀（§5.1 L217，落盘一律裸 uuid）。 */
export function normalizeSid(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return s.replace(/^session-/, '');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 读文件尾部 ≤maxBytes 的文本（0 字节缺失 ⇒ 空串，不抛）。 */
function tailText(file, maxBytes) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { text: '', size: 0, truncated: false };
  }
  const size = st.size;
  if (size <= 0) return { text: '', size: 0, truncated: false };
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', size, truncated: false };
  }
  return { text: buf.toString('utf8'), size, truncated: start > 0 };
}

/**
 * 逐行解析 jsonl 尾部（坏行**计数并跳过**，不整份放弃 —— §5.2 L312 口径）。
 * @returns {{rows:object[], bad:number, size:number, truncated:boolean}}
 */
function parseJsonlTail(file, maxBytes) {
  const { text, size, truncated } = tailText(file, maxBytes);
  if (!text) return { rows: [], bad: 0, size, truncated };
  let lines = text.split(/\r?\n/);
  // 回退读时刻的**第一段必然是半行**（从中间切进来）⇒ 丢掉它，不算坏行
  if (truncated) lines = lines.slice(1);
  const rows = [];
  let bad = 0;
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') rows.push(o);
      else bad += 1;
    } catch {
      bad += 1; // 半行 / 坏行：`badLines`，只影响这一行（§5.2 L305）
    }
  }
  return { rows, bad, size, truncated };
}

/** 追加一行并 fsync；**末行没闭合先补一个 `\n`**（§5.2 L302-305，绝不"修好"那半行）。 */
function appendJsonLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(obj) + '\n';
  let needNewline = false;
  try {
    const st = fs.statSync(file);
    if (st.size > 0) {
      const fd0 = fs.openSync(file, 'r');
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd0, b, 0, 1, st.size - 1);
        needNewline = b[0] !== 0x0a;
      } finally {
        fs.closeSync(fd0);
      }
    }
  } catch { /* 文件不存在 ⇒ 无需闭合 */ }
  const fd = fs.openSync(file, 'a');
  try {
    if (needNewline) fs.writeSync(fd, '\n');
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { needNewline, bytes: Buffer.byteLength(line, 'utf8') };
}

/** 整文件写：tmp + fsync + rename（**只给低频整文件**：`_lines.json` / `_meta.json`，§5.2 L273）。 */
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(data, null, 2) + '\n';
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return body.length;
}

const clip = (v, n) => {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.length > n ? s.slice(0, n) : s;
};

// ---------------------------------------------------------------------------
// ① ensureHome —— §5.0 第 8 行（首跑建目录 + `_meta.json{schemaVersion:1}`）
// ---------------------------------------------------------------------------
/**
 * 建 `~\.dsh\mainline-ledger\` + `_meta.json`（幂等）。
 * ⚠️ 不抢 `_lines` 锁：用 `O_EXCL` 原子创建（见文件头两条实现纪律）。
 * @returns {{rc:number, action:string, dir:string, metaFile:string, schemaVersion:number|null, created:boolean}}
 */
export function ensureHome(home) {
  const dir = ledgerDir(home);
  const metaFile = path.join(dir, '_meta.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { rc: 3, action: 'mkdir-failed', dir, metaFile, schemaVersion: null, created: false, error: e?.code ?? String(e) };
  }
  const existing = readJsonFile(metaFile);
  if (existing && typeof existing === 'object') {
    const sv = Number(existing.schemaVersion ?? 1);
    if (Number.isFinite(sv) && sv > SCHEMA_VERSION) {
      // §5.1 L212：读到 schemaVersion > 1 ⇒ 不猜、不降级解析
      return { rc: 3, action: 'schema-newer', dir, metaFile, schemaVersion: sv, created: false };
    }
    return { rc: 0, action: 'home-exists', dir, metaFile, schemaVersion: Number.isFinite(sv) ? sv : 1, created: false };
  }
  try {
    const fd = fs.openSync(metaFile, 'wx'); // 原子创建：并发首跑不会互相覆盖
    try {
      fs.writeSync(fd, JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e?.code !== 'EEXIST') {
      return { rc: 3, action: 'meta-write-failed', dir, metaFile, schemaVersion: null, created: false, error: e?.code ?? String(e) };
    }
  }
  return { rc: 0, action: 'home-created', dir, metaFile, schemaVersion: SCHEMA_VERSION, created: true };
}

// ---------------------------------------------------------------------------
// 行守卫（§5.3 写者守卫；rc=2 一律"我传错了"）
// ---------------------------------------------------------------------------
/**
 * 行守卫：返回 null = 可写；返回 `{rc:2,...}` = 拒写。
 * 三条来源：phase 白名单（ledger-phases.mjs）/ by 白名单 / requires 必带字段。
 */
export function guardRow(row) {
  const phase = String(row?.phase ?? '');
  if (phase === 'recovered') {
    // §5.3 L337：recovered 不在 PHASES 里，只有 ledger-repair 的收据行才写它
    return { rc: 2, action: 'bad-args', reason: 'phase-recovered-not-in-PHASES' };
  }
  if (!isPhase(phase)) {
    return { rc: 2, action: 'bad-args', reason: 'phase-not-in-PHASES', known: Object.keys(PHASES) };
  }
  const def = PHASES[phase];
  const by = String(row?.by ?? 'self');
  if (!BY_VALUES.includes(by)) return { rc: 2, action: 'bad-args', reason: 'by-not-allowed', allowed: BY_VALUES };
  if (Array.isArray(def.byWhitelist) && !def.byWhitelist.includes(by)) {
    return { rc: 2, action: 'bad-args', reason: 'phase-by-guard', phase, by, byWhitelist: def.byWhitelist };
  }
  if (row?.forTurn != null && by !== 'scan') {
    // §5.3 L341：--for-turn 只许 --by scan 传
    return { rc: 2, action: 'bad-args', reason: 'for-turn-only-for-scan', by };
  }
  for (const req of def.requires ?? []) {
    if (row?.[req] == null || String(row[req]).trim() === '') {
      return { rc: 2, action: 'bad-args', reason: `missing-${req}`, phase };
    }
  }
  if (!isLineId(String(row?.lineId ?? ''))) {
    return { rc: 2, action: 'bad-args', reason: 'bad-lineId', lineId: row?.lineId ?? null };
  }
  if (!isBareUuid(String(row?.sid ?? ''))) {
    return { rc: 2, action: 'bad-args', reason: 'bad-sid', sid: row?.sid ?? null };
  }
  const turn = Number(row?.turn);
  if (!Number.isInteger(turn) || turn < 1) {
    return { rc: 2, action: 'bad-args', reason: 'bad-turn', turn: row?.turn ?? null };
  }
  if (phase === 'void') {
    // 冲销键严格 `<裸uuid>#<turn>`
    const v = String(row.voids ?? '').trim();
    const m = /^([0-9a-fA-F-]{36})#(\d+)$/.exec(v);
    if (!m || !BARE_UUID_RE.test(m[1])) {
      return { rc: 2, action: 'bad-args', reason: 'bad-voids-shape', voids: clip(v, 80) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ② appendRow —— §5.0 第 1/2/3 行（写序六步照 §5.2 L280-296）
// ---------------------------------------------------------------------------
/**
 * 主账 append（同键跳重；`void` 豁免；真话覆盖 scan 补记行）。
 * @returns {{rc:number, action:string, file?:string, turn?:number, by?:string}}
 *   action ∈ appended / dup-skip / void-recorded / merged-scan / lock-missed /
 *            bad-args / meta-failed / schema-newer / ops-write-failed
 */
export function appendRow(home, lineId, row) {
  if (!isLineId(String(lineId ?? ''))) return { rc: 2, action: 'bad-args', reason: 'bad-lineId' };
  const r = { ...(row ?? {}), lineId };
  const guard = guardRow(r);
  if (guard) return guard;

  const ts = r.ts || isoWithOffset();
  const out = { ...r, ts };
  if (out.by === 'scan' && out.forTurn != null) {
    // §5.3 L342：by:scan 时行内 turn := forTurn
    out.turn = Number(out.forTurn);
  }

  const home0 = ensureHome(home);
  if (home0.rc !== 0) return { rc: 3, action: home0.action === 'schema-newer' ? 'schema-newer' : 'meta-failed', reason: home0.action };

  // ① 抢线锁（**先抢锁再读**，§5.2 L300）
  const lock = acquireTickLock(LINE_LOCK_PREFIX + lineId, { ttlMs: LINE_LOCK_TTL_MS, env: {}, home });
  if (!lock.ok) {
    // 抢不到 ⇒ 不写、记一行 lock-missed 到 `.ops.jsonl`，不阻塞会话（rc=4）
    const ops = appendOps(home, lineId, {
      ts: out.ts, sid: out.sid, turn: out.turn, phase: 'lock-missed',
      reason: 'line-lock-held', opId: out.opId ?? null,
    });
    if (ops.rc !== 0) return { rc: 3, action: 'ops-write-failed', reason: 'lock-missed-ops-failed', opsFile: ops.file };
    return { rc: 4, action: 'lock-missed', opsFile: ops.file };
  }

  try {
    const file = ledgerFile(home, lineId, out.ts);
    // ② 读该月文件尾部，按 §5.3 L349 的**行序语义**重建"每个键当前有没有效"：
    //    · 遇 `phase:"void"` ⇒ 把 `voids` 指到的那个键标作废（**void 行不登记自己的键**，方案原文如此；
    //      这也正是"void 豁免跳重"的另一半：重复冲销允许）
    //    · 遇普通行 ⇒ `state[key] = {voided:false}`（覆盖即复活）
    //    ⚠️ 别把"键存在过"当成"键还有效" —— 被 void 掉的键**必须视为不存在**，否则
    //      ①B 路补不回被冲销的那一轮 ②"取消 void = 再写一行正常流水"这条路直接死掉（后写者胜失效）。
    const tail = parseJsonlTail(file, KEY_SCAN_BYTES);
    const keyState = new Map(); // `<sid>#<turn>` -> {voided:boolean, by:string}
    for (const o of tail.rows) {
      if (!o || o.lineId !== lineId) continue;
      if (String(o.phase ?? '') === 'void' && o.voids) {
        const cur = keyState.get(String(o.voids));
        if (cur) cur.voided = true;
        continue;
      }
      keyState.set(`${o.sid}#${o.turn}`, { voided: false, by: String(o.by ?? '') });
    }
    const key = `${out.sid}#${out.turn}`;
    const prev = keyState.get(key) ?? null;
    const prevActive = prev !== null && prev.voided !== true;

    const isVoid = out.phase === 'void';
    const isTruth = out.by === 'self' || out.by === 'hook';
    if (prevActive && !isVoid && !(isTruth && prev.by === 'scan')) {
      // ③ 已存在且无例外 ⇒ 回「跳重」并释放锁退出（不写）
      return { rc: 0, action: 'dup-skip', file, turn: out.turn, by: prev.by };
    }
    if (prevActive && isTruth && prev.by === 'scan') {
      // ③-b 真话覆盖补记：**照写一行新的同键真话行**，旧 scan 行原样留着
      out.mergedFrom = 'scan';
    }
    const revived = Boolean(prev && prev.voided === true);
    // ④ append + fsync　　⑤ 释放锁（finally）
    const w = appendJsonLine(file, out);
    return {
      rc: 0,
      action: isVoid ? 'void-recorded' : (out.mergedFrom ? 'merged-scan' : 'appended'),
      file, turn: out.turn, by: out.by, revived, patchedNewline: w.needNewline, bytes: w.bytes,
    };
  } finally {
    try { lock.release(); } catch { /* 锁 TTL 兜底 */ }
  }
}

// ---------------------------------------------------------------------------
// ④ appendOps —— §5.0 第 4 行（`.ops\<lineId>-<YYYYMM>.jsonl`；不给 lineId ⇒ `_unknown`）
// ---------------------------------------------------------------------------
/**
 * 运维行（`lock-missed` / `no-sid` / `bad-args` / `out-of-scope` / `scan-budget-exceeded` /
 * `sids-lost` / `sids-file-large` …）。**不单独加锁**（§5.2 L309）。
 * @returns {{rc:number, action:string, file:string}}
 */
export function appendOps(home, lineId, op) {
  const dir = path.join(ledgerDir(home), '_ops');
  const id = isLineId(String(lineId ?? '')) ? lineId : '_unknown';
  const o = op ?? {};
  const ts = o.ts || isoWithOffset();
  const file = path.join(dir, `${id}-${monthOf(ts)}.jsonl`);
  const row = {
    v: ROW_VERSION,
    ts,
    sid: isBareUuid(String(o.sid ?? '')) ? o.sid : null,
    turn: Number.isInteger(Number(o.turn)) ? Number(o.turn) : 0,
    phase: clip(o.phase ?? 'ops', 40),
    reason: clip(o.reason ?? '', 400),
    lineId: id === '_unknown' ? null : id,
    opId: o.opId == null ? null : clip(o.opId, 80),
  };
  // 单行 ≤4 KiB（唯一被允许的无锁写；超了截 reason 而不是写半行）
  let line = JSON.stringify(row);
  if (Buffer.byteLength(line, 'utf8') > OPS_LINE_MAX) {
    row.reason = clip(row.reason, 120);
    line = JSON.stringify(row);
  }
  try {
    appendJsonLine(file, row);
  } catch (e) {
    return { rc: 3, action: 'ops-write-failed', file, error: e?.code ?? String(e) };
  }
  return { rc: 0, action: 'ops-appended', file };
}

// ---------------------------------------------------------------------------
// ⑤ appendSid —— §5.0 第 5 行（`_sids\<lineId>.jsonl`，同 sid 跳重，判重取尾 1 MiB）
// ---------------------------------------------------------------------------
/**
 * 登记一个会话到某条线（`how` ∈ `SID_HOW_VALUES` = `claim` | `guess` | `relay`）。
 * 线锁**在本函数内部抢**（自包含：调用方不必先持锁，也不许再持 —— 避免双层互斥）。
 * @returns {{rc:number, action:string, file?:string, bytes?:number}}
 *   action ∈ sid-appended / sid-dup-skip / bad-args / lock-missed / ops-write-failed
 */
export function appendSid(home, lineId, sid, how = 'claim') {
  if (!isLineId(String(lineId ?? ''))) return { rc: 2, action: 'bad-args', reason: 'bad-lineId' };
  const bare = normalizeSid(sid);
  if (!isBareUuid(String(bare ?? ''))) return { rc: 2, action: 'bad-args', reason: 'bad-sid', sid: sid ?? null };
  const home0 = ensureHome(home);
  if (home0.rc !== 0) return { rc: 3, action: home0.action === 'schema-newer' ? 'schema-newer' : 'meta-failed' };

  const lock = acquireTickLock(LINE_LOCK_PREFIX + lineId, { ttlMs: LINE_LOCK_TTL_MS, env: {}, home });
  if (!lock.ok) {
    const ops = appendOps(home, lineId, { sid: bare, turn: 0, phase: 'lock-missed', reason: 'sid-lock-held' });
    if (ops.rc !== 0) return { rc: 3, action: 'ops-write-failed', opsFile: ops.file };
    return { rc: 4, action: 'lock-missed', opsFile: ops.file };
  }
  try {
    const file = path.join(ledgerDir(home), '_sids', `${lineId}.jsonl`);
    const tail = parseJsonlTail(file, SID_DEDUP_BYTES);
    const dup = tail.rows.some((o) => o && String(o.sid) === bare);
    if (dup) return { rc: 0, action: 'sid-dup-skip', file };
    appendJsonLine(file, { v: ROW_VERSION, ts: isoWithOffset(), sid: bare, how: SID_HOW_VALUES.includes(how) ? how : 'claim' });
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { /* 刚写完读不到就跳过预警 */ }
    if (bytes > SID_WARN_BYTES) {
      // §5.1 L206 ①：> 800 KiB ⇒ `.ops` 一行 `sids-file-large`（提前 200 KiB 预警，不参与判重）
      appendOps(home, lineId, { phase: 'sids-file-large', reason: `${bytes}B>${SID_WARN_BYTES}B`, sid: null, turn: 0 });
    }
    return { rc: 0, action: 'sid-appended', file, bytes };
  } finally {
    try { lock.release(); } catch { /* TTL 兜底 */ }
  }
}

// ---------------------------------------------------------------------------
// ⑥ appendUnmapped —— §5.0 第 6 行（`<host>-unmapped.jsonl`，追加事件流）
// ---------------------------------------------------------------------------
/**
 * 未归线队列：`{id,ts,literal,sid,turn}` 与认领事件 `{id,claimed:true,claimedAs,claimedAt}`。
 * 持 `_lines` 锁（**不与线锁同时持**）。
 * @returns {{rc:number, action:string, file?:string, id?:string}}
 */
export function appendUnmapped(home, event) {
  const e = event ?? {};
  const home0 = ensureHome(home);
  if (home0.rc !== 0) return { rc: 3, action: home0.action === 'schema-newer' ? 'schema-newer' : 'meta-failed' };
  const id = clip(e.id ?? '', 80);
  if (!id) return { rc: 2, action: 'bad-args', reason: 'missing-id' };
  const file = path.join(ledgerDir(home), `${hostTag()}-unmapped.jsonl`);

  const lock = acquireTickLock(LINES_LOCK_NAME, { ttlMs: LINE_LOCK_TTL_MS, env: {}, home });
  if (!lock.ok) return { rc: 3, action: 'lines-lock-missed', file };
  try {
    let row;
    if (e.claimed === true) {
      row = { id, claimed: true, claimedAs: clip(e.claimedAs ?? '', 60), claimedAt: e.claimedAt || isoWithOffset() };
    } else {
      const bare = normalizeSid(e.sid);
      row = {
        id,
        ts: e.ts || isoWithOffset(),
        literal: clip(e.literal ?? '', 200),
        sid: isBareUuid(String(bare ?? '')) ? bare : null,
        turn: Number.isInteger(Number(e.turn)) ? Number(e.turn) : 0,
      };
    }
    appendJsonLine(file, row);
    return { rc: 0, action: e.claimed === true ? 'unmapped-claimed' : 'unmapped-appended', file, id };
  } catch (err) {
    return { rc: 3, action: 'unmapped-write-failed', file, error: err?.code ?? String(err) };
  } finally {
    try { lock.release(); } catch { /* TTL 兜底 */ }
  }
}

// ---------------------------------------------------------------------------
// ⑦ writeLinesMap —— §5.0 第 7 行（`_lines.json` 整文件写：tmp + fsync + rename）
// ---------------------------------------------------------------------------
export const LINES_FILE_NAME = '_lines.json';

function emptyLinesMap() {
  return { v: ROW_VERSION, host: hostTag(), next: 1, lines: [] };
}

/** 规范化容器形状（`lines[]` 按 `lineId` 升序；`next` 不许回退 —— §5.1 L205）。 */
export function normalizeLinesMap(map) {
  const src = map && typeof map === 'object' ? map : emptyLinesMap();
  const lines = Array.isArray(src.lines) ? src.lines.filter((x) => x && isLineId(String(x.lineId))) : [];
  lines.sort((a, b) => String(a.lineId).localeCompare(String(b.lineId)));
  const maxSeq = lines.reduce((m, x) => Math.max(m, Number(String(x.lineId).split('-').pop()) || 0), 0);
  const next = Math.max(Number.isFinite(Number(src.next)) ? Number(src.next) : 1, maxSeq + 1);
  return {
    v: ROW_VERSION,
    host: typeof src.host === 'string' && src.host ? src.host : hostTag(),
    next,
    lines: lines.map((x) => ({
      lineId: x.lineId,
      line: String(x.line ?? ''),
      aliases: Array.isArray(x.aliases) ? [...new Set(x.aliases.map((a) => String(a ?? '').trim()).filter(Boolean))] : [],
      createdAt: x.createdAt ?? isoWithOffset(),
      ledgerSince: x.ledgerSince ?? x.createdAt ?? isoWithOffset(),
    })),
    updatedAt: isoWithOffset(),
  };
}

/** 只读取当前 `_lines.json`（缺失/坏 ⇒ null；**读端专用**，不写盘）。 */
export function readLinesMap(home) {
  const j = readJsonFile(path.join(ledgerDir(home), LINES_FILE_NAME));
  return j && typeof j === 'object' ? j : null;
}

/**
 * 整文件写 `_lines.json`（持 `_lines` 锁；**读-改-写全在锁内**）。
 * @param {string} home
 * @param {object|((cur:object)=>(object|{skip:true}))} mapOrFn
 *        给函数时：在锁内用当前 `_lines.json` 调它，返回新容器（或 `{skip:true,reason}` 放弃写）
 * @returns {{rc:number, action:string, file?:string, map?:object}}
 */
export function writeLinesMap(home, mapOrFn) {
  const home0 = ensureHome(home);
  if (home0.rc !== 0) return { rc: 3, action: home0.action === 'schema-newer' ? 'schema-newer' : 'meta-failed' };

  const lock = acquireTickLock(LINES_LOCK_NAME, { ttlMs: LINE_LOCK_TTL_MS, env: {}, home });
  if (!lock.ok) return { rc: 3, action: 'lines-lock-missed' };
  try {
    const file = path.join(ledgerDir(home), LINES_FILE_NAME);
    const cur = normalizeLinesMap(readLinesMap(home) ?? emptyLinesMap());
    const nextRaw = typeof mapOrFn === 'function' ? mapOrFn(cur) : mapOrFn;
    if (nextRaw && nextRaw.skip === true) {
      return { rc: 0, action: 'lines-unchanged', file, map: cur, reason: nextRaw.reason ?? null };
    }
    const out = normalizeLinesMap(nextRaw);
    writeJsonAtomic(file, out);
    return { rc: 0, action: 'lines-written', file, map: out };
  } catch (e) {
    return { rc: 3, action: 'lines-write-failed', error: e?.code ?? String(e) };
  } finally {
    try { lock.release(); } catch { /* TTL 兜底 */ }
  }
}

// ---------------------------------------------------------------------------
// ⑧ writeCursor —— §5.0 第 9 行（B 路 sid 级水位）
//   `mainline-ledger\_cursor-<YYYYMM>.json`（月分片）+ `_cursor.json`（当月完整镜像）
//
// 为什么两份都要写（不是重复）：
//   · §5.0 第 9 行容量规矩要求**月分片**（否则 30 天后 ≈0.95 MB 每 2 分钟整份重写）；
//   · §6.2 ③ 的验收读的是 `_cursor.json` 出现 `lines{}`，读端 `ledger-read#readCursor`
//     也是"先读各月分片、再读 `_cursor.json` 后者覆盖前者"；
//   · ⇒ 分片装"那个月的水位"，`_cursor.json` 装**当月完整镜像**。镜像必须是完整的一份
//     （包含 `_lines.json` 里的**每一条线**），否则上月分片里那些"这个月没动过"的线会被
//     残留的旧 `lastScanAt` 读成永久 `scan-stale`。
//
// 锁 = 第四把锁 `mainline-ledger:_cursor`（`ttlMs:30_000` · `env:{}`）：
//   与线锁 / `_lines` 锁 / `mainline-scan` job 锁**都不同名、互不嵌套**（§5.6 末条）。
//   ⚠️ 必须 `env:{}`：交接窗口里 `DSH_HANDOFF_LOCK_HELD=1` 会把任何名字变成零 I/O 虚拟锁，
//     那正好是"两次整写、后写覆盖先写、部分 sid 的 lastScanAt 回退"（§5.0 第 9 行）。
// ---------------------------------------------------------------------------
export const CURSOR_LOCK_NAME = 'mainline-ledger:_cursor';
export const CURSOR_FILE_NAME = '_cursor.json';

/** 月份分片文件名：`_cursor-<YYYYMM>.json`（**紧凑形态**，读端 `toCompact` 就认这个）。 */
export function cursorShardFileName(ts) {
  return `_cursor-${monthOf(ts)}.json`;
}

/** 空水位（不是"没有水位"：`{}` 与 `null` 在读端语义上不同，这里只产生结构化空值）。 */
export function emptyCursorState() {
  return { v: ROW_VERSION, cursor: null, sids: {}, lines: {}, job: {} };
}

/** 规范化水位形状（`sids{}` / `lines{}` 必须是对象；顶层 `v` 归一）。 */
export function normalizeCursorState(src) {
  const s = src && typeof src === 'object' ? src : {};
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  return {
    ...s,
    v: ROW_VERSION,
    cursor: typeof s.cursor === 'string' ? s.cursor : null,
    sids: obj(s.sids),
    lines: obj(s.lines),
    job: obj(s.job),
  };
}

/**
 * 只读：读当月分片 + `_cursor.json` 镜像并合并（镜像后读 ⇒ 前者被覆盖）。
 * **读端专用**（`ledger-read.mjs` 自带一份等价实现 —— 那里是"读端零写盘"的硬要求，
 * 它连 writer 都不 import）。
 * @returns {{state:object, files:string[], present:boolean}}
 */
export function readCursorState(home, ts) {
  const dir = ledgerDir(home);
  const files = [
    path.join(dir, cursorShardFileName(ts)),
    path.join(dir, CURSOR_FILE_NAME),
  ];
  const out = emptyCursorState();
  const seen = [];
  let present = false;
  for (const f of files) {
    const j = readJsonFile(f);
    if (!j || typeof j !== 'object') continue;
    present = true;
    seen.push(f);
    const n = normalizeCursorState(j);
    Object.assign(out.sids, n.sids);
    Object.assign(out.lines, n.lines);
    Object.assign(out.job, n.job);
    for (const k of Object.keys(n)) {
      if (k === 'sids' || k === 'lines' || k === 'job') continue;
      out[k] = n[k];
    }
  }
  return { state: out, files: seen, present };
}

/**
 * 整份重写水位（**持 `_cursor` 锁**；读-改-写全在锁内）。
 * @param {string} home
 * @param {object|((cur:object)=>(object|{skip:true}))} stateOrFn
 *        给函数时：在锁内用当前合并后的水位调它，返回新水位（或 `{skip:true, reason}` 放弃写）
 * @param {{ts?:string}} [opts]  `ts` = 写入时刻（`--now` 注入；决定分片月份）
 * @returns {{rc:number, action:string, files?:string[], state?:object}}
 *   action ∈ cursor-written / cursor-unchanged / bad-args / cursor-lock-missed / cursor-write-failed
 */
export function writeCursor(home, stateOrFn, opts = {}) {
  const ts = opts.ts || isoWithOffset();
  const home0 = ensureHome(home);
  if (home0.rc !== 0) return { rc: 3, action: home0.action === 'schema-newer' ? 'schema-newer' : 'meta-failed' };

  const lock = acquireTickLock(CURSOR_LOCK_NAME, { ttlMs: LINE_LOCK_TTL_MS, env: {}, home });
  if (!lock.ok) return { rc: 4, action: 'cursor-lock-missed' };
  try {
    const cur = readCursorState(home, ts).state;
    const nextRaw = typeof stateOrFn === 'function' ? stateOrFn(cur) : stateOrFn;
    if (nextRaw && nextRaw.skip === true) {
      return { rc: 0, action: 'cursor-unchanged', reason: nextRaw.reason ?? null, state: cur };
    }
    const out = normalizeCursorState({ ...cur, ...(nextRaw ?? {}) });
    out.updatedAt = ts;
    const files = [
      path.join(ledgerDir(home), cursorShardFileName(ts)),
      path.join(ledgerDir(home), CURSOR_FILE_NAME),
    ];
    for (const f of files) writeJsonAtomic(f, out);
    return { rc: 0, action: 'cursor-written', files, state: out };
  } catch (e) {
    return { rc: 3, action: 'cursor-write-failed', error: e?.code ?? String(e) };
  } finally {
    try { lock.release(); } catch { /* TTL 兜底 */ }
  }
}

// ---------------------------------------------------------------------------
// ⑨ writeRate —— §5.0 第 12 行（漏记率 `_rates\<lineId>.json`，每线每份、天级覆盖写）
//
// 三条判空规矩（§5.4 L413）落在**写端**：`value:null` 必须由一个字段说清原因 ⇒
//   本函数拒绝"`value:null` 且 `note` 为空"的载荷（rc=2），并把 `windowClosed` /
//   `unmeasurable` / `scanStale` 三个原因位规范化。**绝不许把"还没算"写成 0**。
// ---------------------------------------------------------------------------
export const RATES_DIR = '_rates';
export const RATE_BASES = ['readable-logs-only'];

/** `_rates\<lineId>.json` 路径 */
export function rateFile(home, lineId) {
  return path.join(ledgerDir(home), RATES_DIR, `${lineId}.json`);
}

/**
 * 写一条线的漏记率（**整份覆盖**，持线锁）。
 * @param {string} home
 * @param {string} lineId
 * @param {{day:string, numerator:number, denominator:number, value:number|null,
 *          windowClosed:boolean, computedAt?:string, atTurnMissing?:number, basis?:string,
 *          archivedSids?:number, knownSids?:number, activeSids?:number, note?:string,
 *          scanStale?:boolean, unmeasurable?:boolean}} payload
 * @returns {{rc:number, action:string, file?:string}}
 *   action ∈ rate-written / bad-args / lock-missed / rate-write-failed
 */
export function writeRate(home, lineId, payload) {
  if (!isLineId(String(lineId ?? ''))) return { rc: 2, action: 'bad-args', reason: 'bad-lineId' };
  const p = payload ?? {};
  const day = String(p.day ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { rc: 2, action: 'bad-args', reason: 'bad-day', day: p.day ?? null };
  if (typeof p.windowClosed !== 'boolean') return { rc: 2, action: 'bad-args', reason: 'bad-windowClosed' };
  const den = Number(p.denominator);
  const num = Number(p.numerator);
  if (!Number.isInteger(den) || den < 0) return { rc: 2, action: 'bad-args', reason: 'bad-denominator' };
  if (!Number.isInteger(num) || num < 0) return { rc: 2, action: 'bad-args', reason: 'bad-numerator' };
  if (num > den) return { rc: 2, action: 'bad-args', reason: 'numerator-gt-denominator', num, den };

  let value = p.value;
  let note = typeof p.note === 'string' ? p.note : '';
  if (value === undefined) value = den > 0 && p.windowClosed ? num / den : null;
  if (value === null) {
    // 🔴 判空规矩：null 必须由 note（或三个原因位之一）说清原因
    const hasReason = Boolean(note.trim())
      || p.unmeasurable === true || p.scanStale === true || p.windowClosed === false;
    if (!hasReason) return { rc: 2, action: 'bad-args', reason: 'value-null-without-reason' };
    if (!note.trim()) {
      note = p.scanStale ? 'scan-stale：这条线的扫描已停（rate 回 null，不报 0%）'
        : (p.unmeasurable ? '分母为 0（本线在这个窗口里没有可读的 turn/end）⇒ n/a'
          : '当日窗口进行中（windowClosed:false）');
    }
  } else if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
    return { rc: 2, action: 'bad-args', reason: 'bad-value' };
  }

  const body = {
    v: ROW_VERSION,
    lineId,
    day,
    numerator: num,
    denominator: den,
    rate: value === null ? null : Number(value),
    value: value === null ? null : Number(value),
    windowClosed: p.windowClosed,
    computedAt: p.computedAt || isoWithOffset(),
    atTurnMissing: Number.isInteger(Number(p.atTurnMissing)) ? Number(p.atTurnMissing) : 0,
    basis: RATE_BASES.includes(String(p.basis)) ? String(p.basis) : RATE_BASES[0],
    archivedSids: Number.isInteger(Number(p.archivedSids)) ? Number(p.archivedSids) : 0,
    knownSids: Number.isInteger(Number(p.knownSids)) ? Number(p.knownSids) : 0,
    activeSids: Number.isInteger(Number(p.activeSids)) ? Number(p.activeSids) : 0,
    note,
  };
  if (p.scanStale === true) body.scanStale = true;
  if (p.unmeasurable === true) body.unmeasurable = true;

  const home0 = ensureHome(home);
  if (home0.rc !== 0) return { rc: 3, action: home0.action === 'schema-newer' ? 'schema-newer' : 'meta-failed' };
  const lock = acquireTickLock(LINE_LOCK_PREFIX + lineId, { ttlMs: LINE_LOCK_TTL_MS, env: {}, home });
  if (!lock.ok) {
    const ops = appendOps(home, lineId, { phase: 'lock-missed', reason: 'rate-lock-held', sid: null, turn: 0 });
    if (ops.rc !== 0) return { rc: 3, action: 'ops-write-failed', reason: 'lock-missed-ops-failed' };
    return { rc: 4, action: 'lock-missed', opsFile: ops.file };
  }
  try {
    const file = rateFile(home, lineId);
    writeJsonAtomic(file, body);
    return { rc: 0, action: 'rate-written', file };
  } catch (e) {
    return { rc: 3, action: 'rate-write-failed', error: e?.code ?? String(e) };
  } finally {
    try { lock.release(); } catch { /* TTL 兜底 */ }
  }
}

// ---------------------------------------------------------------------------
// ⑩ appendSuppressed —— §5.0 第 10 行（"本该报、被抑制了几条"）
//   `mainline-ledger\_suppressed\<lineId>-<YYYYMM>.jsonl`（append-only）
//   幂等键 `key = <sid>#<turn>`（B 路侧 `<scanRunId>`）⇒ 写前读**尾 64 KiB** 判同 key，
//   同 key 只累加一次（同一夹具跑两遍 `n` 不变 —— §14.3 R-13）。
// ⚠️ 为它单开白名单文件 = 把"一个载体一个 writer"拆开（R-14① 明令禁止）⇒ 落在这里。
// ---------------------------------------------------------------------------
export const SUPPRESSED_DIR = '_suppressed';
export const SUPPRESSED_DEDUP_BYTES = 64 * 1024;
/** `reason` 白名单（§5.0 第 10 行）*/
export const SUPPRESS_REASONS = ['cardsUnavailable', 'quota', 'dedupWindow'];

/** `_suppressed\<lineId>-<YYYYMM>.jsonl` 路径 */
export function suppressedFile(home, lineId, ts) {
  return path.join(ledgerDir(home), SUPPRESSED_DIR, `${lineId}-${monthOf(ts)}.jsonl`);
}

/**
 * 记一笔"被抑制的告警"（幂等键 `<sid>#<turn>`；同 key 只累加一次）。
 * @returns {{rc:number, action:string, n?:number, file?:string}}
 *   action ∈ suppressed-appended / suppressed-dup-skip / bad-args / lock-missed
 */
export function appendSuppressed(home, lineId, entry) {
  if (!isLineId(String(lineId ?? ''))) return { rc: 2, action: 'bad-args', reason: 'bad-lineId' };
  const e = entry ?? {};
  const key = String(e.key ?? '').trim();
  if (!key) return { rc: 2, action: 'bad-args', reason: 'missing-key' };
  const reason = String(e.reason ?? '').trim();
  if (!SUPPRESS_REASONS.includes(reason)) {
    return { rc: 2, action: 'bad-args', reason: 'bad-reason', allowed: SUPPRESS_REASONS };
  }
  const ts = e.ts || isoWithOffset();
  const n = Number.isInteger(Number(e.n)) && Number(e.n) > 0 ? Number(e.n) : 1;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(e.day ?? '')) ? String(e.day) : ts.slice(0, 10);
  const phase = clip(e.phase ?? 'scan-fill', 40);

  const home0 = ensureHome(home);
  if (home0.rc !== 0) return { rc: 3, action: home0.action === 'schema-newer' ? 'schema-newer' : 'meta-failed' };
  const lock = acquireTickLock(LINE_LOCK_PREFIX + lineId, { ttlMs: LINE_LOCK_TTL_MS, env: {}, home });
  if (!lock.ok) return { rc: 4, action: 'lock-missed' };
  try {
    const file = suppressedFile(home, lineId, ts);
    const tail = parseJsonlTail(file, SUPPRESSED_DEDUP_BYTES);
    const prev = tail.rows.find((o) => o && String(o.key) === key) ?? null;
    if (prev) {
      return { rc: 0, action: 'suppressed-dup-skip', n: Number(prev.n ?? 1), file };
    }
    appendJsonLine(file, { v: ROW_VERSION, ts, day, lineId, phase, n, reason, key });
    return { rc: 0, action: 'suppressed-appended', n, file };
  } catch (err) {
    return { rc: 3, action: 'suppressed-write-failed', error: err?.code ?? String(err) };
  } finally {
    try { lock.release(); } catch { /* TTL 兜底 */ }
  }
}

// ---------------------------------------------------------------------------
// 只读辅助（给 CLI 用；不写盘）
// ---------------------------------------------------------------------------
/** 主账某月文件是否已存在（只读）。 */
export function mainLedgerFileExists(home, lineId, ts) {
  try {
    return fs.statSync(ledgerFile(home, lineId, ts)).isFile();
  } catch {
    return false;
  }
}

/** 读 `<host>-unmapped.jsonl` 的每个 id 的最后一条事件（只读；§5.1 L207）。 */
export function readUnmappedLatest(home) {
  const file = path.join(ledgerDir(home), `${hostTag()}-unmapped.jsonl`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, events: new Map(), bad: 0, count: 0 };
  }
  const events = new Map();
  let bad = 0;
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      bad += 1;
      continue;
    }
    if (!o || typeof o.id !== 'string') continue;
    count += 1;
    events.set(o.id, o); // 行序取最后一条
  }
  return { file, events, bad, count };
}

export default {
  ensureHome,
  appendRow,
  appendOps,
  appendSid,
  appendUnmapped,
  writeLinesMap,
  writeCursor,
  writeRate,
  appendSuppressed,
};
