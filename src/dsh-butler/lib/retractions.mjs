// dsh-butler / lib/retractions.mjs —— 撤回台账（tombstone）唯一读写口径
//
// 出处（口径真源，改这里必须同步改方案档）：
//   · docs/服务面隐私包-方案-20260917.md §3.5a（载体 / schema / 隐私最小化 / 判据 hash+owner）
//   · docs/服务面隐私包-方案-20260917.md §3.5c（合并器侧：读对端台账、按 hash+owner 去重并回）
//   · docs/六包施工方案-20260917.md §1.1 ⑤-4 行（本卡的载体）
//   · 施工卡：【施工·⑤-4】⑤-4 撤回链
//
// 契约（**顺序铁律**，调用方必守）：
//   ① 撤回一个条目的正确顺序 = **先写台账行（append + fsync）→ 再 DELETE FROM memories**。
//      反过来的半完成态 =「已删但没 tombstone」⇒ 下次接机还魂且事后无人知道 ⇒ 由 memory-retract.mjs
//      的代码级顺序 + 崩溃注入单测（_test/test-memory-retract.mjs）机械保证。
//   ② 台账 append-only：只追加、绝不改写已写行（幂等靠 `hash+owner` 去重键判定，不是靠改文件）。
//
// schema（§3.5a 逐字）：
//   { at, by, hash, owner, reasonCode, note?, host }
//     · at         ISO 8601 字符串（写入时刻）
//     · by         发起人 owner_user（外部 IM userid）
//     · hash       内容哈希 `sha256:<16 hex>`（与 lib/merge-memory.mjs 的 contentHashOf 同源）
//     · owner      被撤回条目的 owner_user（撤回判据的第二个条件，防"同文本误删"）
//     · reasonCode self-request | owner-action | mistake | other
//     · note?      可选，≤80 字
//     · host       写入机器名（COMPUTERNAME / hostname）
//   ⚠️ **隐私最小化**（§3.5a 设计决定）：**只存内容哈希 + 发起人标识，绝不存正文片段**。
//   ⚠️ **不含**「是否已在对端应用」标记（§16-B2 阻断级意见：修法 (a) 追加 kind:'applied' 行 / (b) 检查项
//      降级为"本机侧可判定"）。本卡未替该决策拍板 ⇒ schema 保持 §3.5a 现状，B2 仍为待决项。
//
// 本模块**纯逻辑 + 单文件 IO**：不开数据库连接、不碰 memories 表、不做网络/时间以外的副作用。
// 默认台账路径 = `<home>/.dsh/memory/retractions.jsonl`（`home` 默认 `%USERPROFILE%`）。
// 所有写函数都接受显式路径 ⇒ 单测/沙箱可完全隔离，绝不隐式写生产。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// layout 变更史：0.1.0 = §3.5a 四值（self-request/owner-action/mistake/other）
//               0.2.0 = +移走类（merged-into:<id> / duplicate / stale，见 MOVE_REASON_CODES）
export const RETRACTIONS_LIB_VERSION = '0.2.0';

/** 台账 schema 版本（写进每行，便于将来迁移；§3.5a 未规定该字段 ⇒ 本卡不写进行内，仅作模块常量）。 */
export const RETRACTIONS_SCHEMA = 1;

/** reasonCode 取值域（§3.5a）。**老数组语义不动**（"人主动撤回"四值）。 */
export const REASON_CODES = Object.freeze(['self-request', 'owner-action', 'mistake', 'other']);

/**
 * **移走类** reasonCode（方案 `docs/方案-记忆架构整体与增量-20261022.md` §4 I2 · 2026-10-22 卡「dream 器具」新增）。
 *
 * 与上面 `REASON_CODES` 的区别（刻意**不就地扩老数组**）：
 *   · `REASON_CODES` = 「谁让它走的」= 人主动撤回（隐私请求 / 操作者动作 / 误记 / 其他）
 *   · `MOVE_REASON_CODES` = 「为什么该走」= **合并 / 去重 / 过期** ⇒ 属「移走」语义：
 *     条目被物理搬到备份区（`_archive\memory-removed\<stamp>\rows.jsonl`），不是"人想撤"。
 *
 * 取值形态（`merged-into:<id>` 是**带参形态**，`<id>` 处为数字 display id）：
 *   · `merged-into:<id>`  该条内容已被并入 `#<id>` ⇒ 此条为残余副本
 *   · `duplicate`         与另一条重复（不指向具体目标）
 *   · `stale`             过期/被新结论覆盖
 *
 * ⚠️ `merged-into:<id>` 里的 id **必须当下库里存在**（写入前由调用方核，防"指向空气"）；
 *    且 id 会漂（`merge-memory.mjs#allocDisplayId` = 当前未占用最小号 ⇒ 删行即改占用集）⇒
 *    台账行仍以 `hash + owner` 为判据，id 只作人读提示。
 */
export const MOVE_REASON_CODES = Object.freeze(['merged-into:<id>', 'duplicate', 'stale']);

/** 移走类的无参形态（`merged-into:<id>` 的 `<id>` 被替换后就是这几个）。 */
export const MOVE_REASON_KINDS = Object.freeze(['merged-into', 'duplicate', 'stale']);

/** `merged-into:<id>` 的正则（id 为十进制数字，允许前导 0 之外的自然写法）。 */
export const MERGED_INTO_RE = /^merged-into:(\d+)$/;

/** note 长度上限（§3.5a：≤80 字）。 */
export const NOTE_MAX = 80;

/** 台账相对 home 的路径（§3.5a：`~/.dsh/memory/retractions.jsonl`）。 */
export const RETRACTIONS_REL = Object.freeze(['.dsh', 'memory', 'retractions.jsonl']);

/** 内容哈希前缀（与 lib/merge-memory.mjs 的 HASH_PREFIX 同源，故意各写一份避免循环依赖）。 */
export const HASH_PREFIX = 'sha256:';

/**
 * 台账文件绝对路径。
 * @param {string} [home] 默认 `%USERPROFILE%`（再退 `HOME`）
 */
export function retractionsPath(home = process.env.USERPROFILE ?? process.env.HOME ?? '') {
  return path.join(home, ...RETRACTIONS_REL);
}

/** 本机名（写 host 字段）。 */
export function hostName() {
  return process.env.COMPUTERNAME ?? os.hostname();
}

/**
 * 归一内容哈希：接受 `sha256:abcdef...`（任意长度）或裸 hex → 一律 `sha256:` + 前 16 位小写 hex。
 * 非法（非 hex / 太短 / 非字符串）→ null。
 */
export function normalizeHash(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (s.startsWith(HASH_PREFIX)) s = s.slice(HASH_PREFIX.length);
  if (!/^[0-9a-f]{16,}$/.test(s)) return null;
  return HASH_PREFIX + s.slice(0, 16);
}

/**
 * 解析「移走类」reasonCode。
 * @returns {{ok:boolean, kind:string|null, intoId:number|null, errors:string[]}}
 *   合法：`duplicate` / `stale` → kind=本身、intoId=null
 *        `merged-into:<id>`    → kind='merged-into'、intoId=Number(id)
 */
export function parseMoveReason(code) {
  const s = typeof code === 'string' ? code.trim() : '';
  if (!s) return { ok: false, kind: null, intoId: null, errors: ['空 reasonCode'] };
  const m = s.match(MERGED_INTO_RE);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, kind: null, intoId: null, errors: [`merged-into 的 id 非法：${m[1]}`] };
    return { ok: true, kind: 'merged-into', intoId: n, errors: [] };
  }
  if (s === 'duplicate' || s === 'stale') return { ok: true, kind: s, intoId: null, errors: [] };
  return { ok: false, kind: null, intoId: null, errors: [`不是移走类 reasonCode：${s}`] };
}

/** 是否属「移走类」（`merged-into:<id>` / `duplicate` / `stale`）。 */
export function isMoveReasonCode(code) {
  return parseMoveReason(code).ok;
}

/**
 * reasonCode 总判据 = **老四值 ∪ 移走类**。台账 schema 校验一律走这里
 * （`validateRetraction` 用它，避免"新值进得了 CLI、进不了台账"）。
 */
export function isValidReasonCode(code) {
  const s = typeof code === 'string' ? code.trim() : '';
  if (!s) return false;
  return REASON_CODES.includes(s) || parseMoveReason(s).ok;
}

/** 全部合法取值（诊断/报错文案用；`merged-into:<id>` 按模板形式给）。 */
export const ALL_REASON_CODES = Object.freeze([...REASON_CODES, ...MOVE_REASON_CODES]);

/**
 * 单行校验（**不改写输入**）。
 * @returns {{ok:boolean, errors:string[], row:object|null}} row = 归一后的行（仅 ok 时有值）
 */
export function validateRetraction(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['不是对象'], row: null };
  }
  const at = typeof raw.at === 'string' ? raw.at.trim() : '';
  if (!at) errors.push('缺 at');
  else if (Number.isNaN(Date.parse(at))) errors.push(`at 不是可解析的时间：${at}`);
  const by = typeof raw.by === 'string' ? raw.by.trim() : '';
  if (!by) errors.push('缺 by（发起人 owner_user）');
  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
  if (!owner) errors.push('缺 owner（被撤回条的 owner_user）');
  const hash = normalizeHash(raw.hash);
  if (!hash) errors.push(`hash 非法（要 sha256:<16 hex>）：${String(raw.hash)}`);
  const reasonCode = typeof raw.reasonCode === 'string' ? raw.reasonCode.trim() : '';
  if (!reasonCode) errors.push('缺 reasonCode');
  else if (!isValidReasonCode(reasonCode)) errors.push(`reasonCode 非法（∈ ${ALL_REASON_CODES.join('|')} 或 merged-into:<id>）：${reasonCode}`);
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  if (!host) errors.push('缺 host');
  let note = null;
  if (raw.note !== undefined && raw.note !== null && raw.note !== '') {
    if (typeof raw.note !== 'string') errors.push('note 不是字符串');
    else if ([...raw.note].length > NOTE_MAX) errors.push(`note 超长（${[...raw.note].length} > ${NOTE_MAX}）`);
    else note = raw.note;
  }
  if (errors.length) return { ok: false, errors, row: null };
  const row = { at, by, hash, owner, reasonCode };
  if (note !== null) row.note = note;
  row.host = host;
  return { ok: true, errors: [], row };
}

/**
 * 构造一行（校验通过才返回 ok:true）。`at` 默认写现在（可注入 nowMs 便于单测）。
 * @returns {{ok:boolean, errors:string[], row:object|null}}
 */
export function makeRetraction(fields = {}, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  return validateRetraction({
    at: fields.at ?? new Date(nowMs).toISOString(),
    by: fields.by,
    hash: fields.hash,
    owner: fields.owner,
    reasonCode: fields.reasonCode ?? 'self-request',
    note: fields.note,
    host: fields.host ?? hostName(),
  });
}

/** 去重键 = `hash|owner`（§3.5a：撤回判据 = 内容哈希 + owner 双条件）。 */
export function retractionKey(row) {
  const hash = normalizeHash(row?.hash);
  const owner = typeof row?.owner === 'string' ? row.owner.trim() : '';
  if (!hash || !owner) return null;
  return `${hash}|${owner}`;
}

/** rows → Map(key → row)（同 key 多行时保留 at 最早者，并列取先出现者）。 */
export function indexRetractions(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = retractionKey(row);
    if (!key) continue;
    const cur = map.get(key);
    if (!cur) { map.set(key, row); continue; }
    if (String(row.at) < String(cur.at)) map.set(key, row);
  }
  return map;
}

/** 单条判据：`(hash, owner)` 是否落在台账里（rows 数组或 indexRetractions 的 Map 都行）。 */
export function isRetracted(rowsOrIndex, hash, owner) {
  const key = retractionKey({ hash, owner });
  if (!key) return false;
  if (rowsOrIndex instanceof Map) return rowsOrIndex.has(key);
  return indexRetractions(rowsOrIndex).has(key);
}

/** 某 owner 名下的全部撤回行（诊断/报告用）。 */
export function retractionsForOwner(rows, owner) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.owner === owner);
}

/**
 * 解析台账文本（JSONL）。**坏行只报不抛**：返回 invalid 清单（行号 + 原因）。
 * @returns {{rows:object[], invalid:{line:number,error:string,raw:string}[], dupKeys:string[]}}
 */
export function parseRetractions(text) {
  const rows = [];
  const invalid = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let doc;
    try {
      doc = JSON.parse(line);
    } catch (e) {
      invalid.push({ line: i + 1, error: `JSON 解析失败：${e.message}`, raw: line.slice(0, 120) });
      continue;
    }
    const v = validateRetraction(doc);
    if (!v.ok) { invalid.push({ line: i + 1, error: v.errors.join('；'), raw: line.slice(0, 120) }); continue; }
    rows.push(v.row);
  }
  const seen = new Set();
  const dupKeys = [];
  for (const r of rows) {
    const k = retractionKey(r);
    if (seen.has(k)) dupKeys.push(k);
    else seen.add(k);
  }
  return { rows, invalid, dupKeys };
}

/**
 * 只读台账文件。
 * @returns {{exists:boolean,path:string,bytes:number|null,sha256:string|null,rows:object[],
 *            invalid:object[],dupKeys:string[],keys:string[]}}
 */
export function readRetractions(file) {
  const p = path.resolve(String(file));
  if (!fs.existsSync(p)) {
    return { exists: false, path: p, bytes: null, sha256: null, rows: [], invalid: [], dupKeys: [], keys: [] };
  }
  const buf = fs.readFileSync(p);
  const parsed = parseRetractions(buf.toString('utf8'));
  return {
    exists: true,
    path: p,
    bytes: buf.length,
    sha256: HASH_PREFIX + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    rows: parsed.rows,
    invalid: parsed.invalid,
    dupKeys: parsed.dupKeys,
    keys: [...new Set(parsed.rows.map(retractionKey).filter(Boolean))].sort(),
  };
}

/**
 * 台账并集（**幂等口径**）：按 `hash|owner` 去重；同 key 保留 `at` 最早的一行（并列取先出现者）。
 * 用于「把对端台账并入本机」（§3.5c 第 1 条）与跨机夹具。
 * @returns {{rows:object[], added:string[], dupKeys:string[]}} rows 按 at 升序
 */
export function unionRetractions(...lists) {
  const merged = new Map();
  const dupKeys = [];
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      const key = retractionKey(row);
      if (!key) continue;
      const cur = merged.get(key);
      if (!cur) { merged.set(key, row); continue; }
      dupKeys.push(key);
      if (String(row.at) < String(cur.at)) merged.set(key, row);
    }
  }
  const rows = [...merged.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { rows, added: [...merged.keys()], dupKeys };
}

/** 台账差的 key：在 b 里、不在 a 里（跨机口径：`a` 本机 / `b` 对端 ⇒ 返回本机尚未知晓的撤回行）。 */
export function retractionsDiffKeys(a, b) {
  const A = new Set((Array.isArray(a) ? a : []).map(retractionKey).filter(Boolean));
  const out = [];
  for (const row of Array.isArray(b) ? b : []) {
    const key = retractionKey(row);
    if (key && !A.has(key)) out.push(key);
  }
  return [...new Set(out)].sort();
}

/**
 * **追加一行台账（append-only + fsync）** —— 顺序铁律的"先写台账"这一步就是它。
 * 幂等由调用方按 key 判定（本函数不做去重，只保证写入与落盘）。
 * @returns {{ok:boolean, file:string, appended:boolean, bytes:number|null, line:string, error?:string}}
 */
export function appendRetraction(file, row) {
  const v = validateRetraction(row);
  if (!v.ok) {
    return { ok: false, file: path.resolve(String(file)), appended: false, bytes: null, line: '', error: `台账行非法：${v.errors.join('；')}` };
  }
  const p = path.resolve(String(file));
  const line = JSON.stringify(v.row);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // O_APPEND + 单行写入 + fsync：写完就落盘，崩溃也不丢（这是"先写台账"的意义所在）
    const fd = fs.openSync(p, 'a');
    try {
      fs.writeSync(fd, line + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, file: p, appended: true, bytes: fs.statSync(p).size, line };
  } catch (e) {
    return { ok: false, file: p, appended: false, bytes: null, line, error: e?.message ?? String(e) };
  }
}

/**
 * 逐条追加（同一 fsync 语义）。**任一条失败立即停止**并如实返回已写条数 ——
 * 调用方（memory-retract.mjs）据此**拒绝继续删除**（台账写不进 ⇒ 绝对不许删，§7.2③）。
 * @returns {{ok:boolean, appended:number, failed:object|null, results:object[]}}
 */
export function appendRetractions(file, rows) {
  const results = [];
  let appended = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = appendRetraction(file, row);
    results.push(r);
    if (!r.ok) return { ok: false, appended, failed: r, results };
    appended += 1;
  }
  return { ok: true, appended, failed: null, results };
}

export default {
  RETRACTIONS_LIB_VERSION,
  RETRACTIONS_SCHEMA,
  REASON_CODES,
  MOVE_REASON_CODES,
  MOVE_REASON_KINDS,
  ALL_REASON_CODES,
  MERGED_INTO_RE,
  parseMoveReason,
  isMoveReasonCode,
  isValidReasonCode,
  NOTE_MAX,
  RETRACTIONS_REL,
  retractionsPath,
  hostName,
  normalizeHash,
  validateRetraction,
  makeRetraction,
  retractionKey,
  indexRetractions,
  isRetracted,
  retractionsForOwner,
  parseRetractions,
  readRetractions,
  unionRetractions,
  retractionsDiffKeys,
  appendRetraction,
  appendRetractions,
};
