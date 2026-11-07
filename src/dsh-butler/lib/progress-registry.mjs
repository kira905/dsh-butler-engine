// dsh-butler / lib/progress-registry.mjs —— 开发进度登记表（A 计划）· schema + 读写 + 结构校验
//
// 它是什么：一份**人写一次**的映射登记表 ——「愿景条目（G<n> / R<n>）↔ 方案档 ↔ 看板卡 uuid」。
//   权威在哪：**本表只权威"映射关系"**。缺口/工作域的文字权威 = 总纲 §5.1 / §6.1（只读抽取，不复制）；
//   卡的状态权威 = 看板实况（每次现拉，绝不进本表）。见 方案 §3.1 三层结构 / §6 表 1 载体归属。
//   怎么跑：被 progress-status.mjs（卡 2 渲染器）import；本模块（纯逻辑 + 文件 IO）也可被校验脚本直接调。
//   落点：`tools\dsh-butler\progress-registry-<host>.json`（按主机分文件，照 plugin-digests-<host>.json 先例；
//         口径来源 lib\host-tag.mjs —— 本机自己生成却要跨机进仓的文件，同名必然互覆）。
//   怎么回滚：删掉登记表文件即回到"无归属信息"态（卡状态仍可由看板重建）—— 本表是人工资产，渲染物是派生视图。
//
// 生命周期五要素（照 lib\state-files.mjs 的登记纪律；本表住在 <butler-root> 下故不在该文件里，
//   在 方案 §8 载体清单第 1/12 行登记 —— 方案原文：对**渲染**非致命、对**数据资产**致命）：
//   schemaVersion = 1 · 持久性 = 持久 · retention = 长期保留（人工资产，不设自动清理）
//   · 丢失后果 = 退化为"无归属信息"（44 条人工映射 + review/blocked 的人写判断一起蒸发，恢复 ≈3h）
//   · 跨机同步 = 走仓3 **分机文件**、不跨机合并（卡 id 不是跨机共享事实，见 repo-superset FORKED）
//   · 写入契约 = 人写（the operator/主人）+ 改前备份；渲染器只读（J7/J8）；写出唯一入口 = writeRegistry（原子写）
//
// 铁律四条（机器可校验，不是口号）：
//   ① **卡状态永不进本表**：白名单（REGISTRY_TOP_KEYS / ENTRY_KEYS / PLAN_KEYS / CARD_KEYS …）
//      之外的键一律判错 —— 防"顺手加个 status 字段"把本表退化成第二本手写进度表（J5 / 反例 R-3）；
//   ② `plans[].path` 与 `evidence.path` **一律相对 `<butler-root>` 根**（不是相对 cwd —— 卡执行会话的工作区
//      不是 <butler-root>，`path.resolve` 会解析成错路径、J3 全表假红）；
//   ③ 读入**容 BOM**（PS5.1 `Set-Content -Encoding UTF8` 必写 BOM，实测 `JSON.parse('\uFEFF{…}')`
//      直接 SyntaxError），写出**无 BOM + LF**（走 store.mjs 的 writeTextAtomic，utf8 写字符串不加 BOM）；
//   ④ 本模块的校验函数**不抛错**：返回 `{ok, fatal[], errors[], warnings[]}`，让调用方按 方案 §3.6
//      的退出码分档（fatal → exit 2；errors → exit 3；warnings → 只提示）。只有 writeRegistry 的
//      磁盘失败会以 `{ok:false, written:false, fatal:[…]}` 形式回报（同样不抛）。
//
// 判据映射（方案 §5）：J1 键唯一且与总纲主键同源 → normalizeKey + checkCoverage；
//   J2 外键严 → crossCheckRegistry；J15 重复键 → validateRegistry；J5 禁二次维护 → 白名单；
//   J3/J4 文档在 / 卡在 → crossCheckRegistry（渲染器接 CLI，卡 2）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeTextAtomic } from './store.mjs';

/** 登记表 schema 版本（改动必须是"加字段可选"或带迁移，见头注生命周期）。 */
export const REGISTRY_SCHEMA_VERSION = 1;

/** `plans[].path` / `evidence.path` 的基准根（方案 §3.3 字段纪律：相对 <butler-root> 根）。 */
export const DSH_ROOT_DEFAULT = process.env.BUTLER_ROOT || path.join(os.homedir(), 'dsh');

/** 登记表目录（`tools\dsh-butler`，P5 写后审计自指豁免清单内）。 */
export const REGISTRY_DIR_DEFAULT = process.env.BUTLER_REGISTRY_DIR || path.join(DSH_ROOT_DEFAULT, 'tools', 'dsh-butler');

/** 顶层白名单（多一键即判错 —— 防"顺手加个 status"）。 */
export const REGISTRY_TOP_KEYS = Object.freeze(['schemaVersion', 'host', 'asOf', 'note', 'entries']);
/** 条目白名单。 */
export const ENTRY_KEYS = Object.freeze(['key', 'plans', 'cards', 'blocked', 'note']);
/** `plans[]` 元素白名单。 */
export const PLAN_KEYS = Object.freeze(['path', 'kind', 'review', 'evidence', 'asOf']);
/** `evidence` 白名单。 */
export const EVIDENCE_KEYS = Object.freeze(['kind', 'path', 'asOf']);
/** `cards[]` 元素白名单（**只存 uuid**，方案 E3/O2-2：`seq` 有重复组，绝不能当键）。 */
export const CARD_KEYS = Object.freeze(['id', 'titleSnapshot', 'role']);
/** `blocked` 白名单。 */
export const BLOCKED_KEYS = Object.freeze(['kind', 'who', 'why']);

/** `plans[].kind` 三值（`plan` 才参与"已过审"判定；设计/交付档不参与）。 */
export const PLAN_KINDS = Object.freeze(['plan', 'design', 'delivery']);
/** `plans[].review` 五值（权威 = 人工登记 + 弱核对，理由见 方案 §2.4）。 */
export const REVIEW_VALUES = Object.freeze(['approved', 'pending', 'failed', 'none', 'n/a']);
/** `blocked.kind` 四值。 */
export const BLOCKED_KINDS = Object.freeze(['decision', 'window', 'external', 'upstream']);
/** `evidence.kind` 两值。 */
export const EVIDENCE_KINDS = Object.freeze(['section', 'doc']);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 登记表默认文件名（host 后缀来自 hostTag()，见 lib\host-tag.mjs）。 */
export function registryFileName(host) {
  return `progress-registry-${String(host ?? 'unknown')}.json`;
}

/**
 * 登记表默认绝对路径。
 * @param {{host?:string, dir?:string}} [opts]
 */
export function progressRegistryPath(opts = {}) {
  const dir = opts.dir ?? REGISTRY_DIR_DEFAULT;
  return path.join(dir, registryFileName(opts.host));
}

/** 本地日期 `YYYY-MM-DD`（asOf 用；可注入 now 供测试固定）。 */
export function localDate(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 空登记表（首次登记前的形态；`entries: []` → 渲染出来全 🧠 需求档，看得见，不假过）。 */
export function emptyRegistry(host, opts = {}) {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    host: String(host ?? 'unknown'),
    asOf: opts.asOf ?? localDate(opts.now),
    note: '人写一次（the operator/主人）· 卡状态不得写进本文件 · 渲染器只读',
    entries: [],
  };
}

/** 相对 `root` 解析登记表里的仓库相对路径（正反斜杠皆可）。 */
export function resolveRepoPath(root, relPath) {
  const rel = String(relPath ?? '').trim().replace(/\\/g, '/');
  if (!rel) return '';
  return path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(root ?? DSH_ROOT_DEFAULT, rel);
}

// ---------------------------------------------------------------- 键（J1 归一化前置）

/**
 * 归一化条目键。
 * ⚠️ 归一化规则（须打印进 `--verify`，方案 T1）：**§6.1 首列是纯数字 `1…20`，登记侧写作 `R<n>`**
 *   ⇒ 比集合前先归一（`R<n>` ↔ `n`），否则 `{R1..R20} ⊇ {1..20}` 恒 false、第一次 `--verify` 就假红。
 * @param {string} key
 * @returns {{ok:true, canon:string, seg:'G'|'R', num:number} | {ok:false, error:string}}
 */
export function normalizeKey(key) {
  const raw = String(key ?? '').trim();
  if (!raw) return { ok: false, error: '键为空' };
  const m = /^([GRgr])?\s*0*(\d{1,3})$/.exec(raw);
  if (!m) return { ok: false, error: `键形态非法「${raw}」（只允许 G<n> / R<n> / 纯数字（纯数字视为 R 段））` };
  const seg = String(m[1] ?? '').toUpperCase() === 'G' ? 'G' : 'R';
  const num = Number(m[2]);
  if (!Number.isFinite(num) || num < 1) return { ok: false, error: `键序号非法「${raw}」` };
  return { ok: true, canon: `${seg}${num}`, seg, num };
}

/** 键自然序比较（G2 排在 G10 前）。 */
export function compareKeys(a, b) {
  const na = normalizeKey(a); const nb = normalizeKey(b);
  if (!na.ok || !nb.ok) return String(a).localeCompare(String(b));
  if (na.seg !== nb.seg) return na.seg === 'G' ? -1 : 1;
  return na.num - nb.num;
}

function canonSet(keys) {
  const out = new Set();
  for (const k of keys ?? []) { const nk = normalizeKey(k); if (nk.ok) out.add(nk.canon); }
  return out;
}

/**
 * J1 覆盖齐：G 段键集合 ⊇ G 表全部 G 号；**且若登记表 R 段非空**则 R 段键集合 ⊇ §6.1 的 1–20。
 * @param {object[]} entries
 * @param {{gKeys?:Iterable<string>, rKeys?:Iterable<string>}} docKeys
 */
export function checkCoverage(entries, docKeys = {}) {
  const gReg = new Set(); const rReg = new Set();
  for (const e of entries ?? []) {
    const nk = normalizeKey(e?.key);
    if (!nk.ok) continue;
    (nk.seg === 'G' ? gReg : rReg).add(nk.canon);
  }
  const gDoc = canonSet(docKeys.gKeys);
  const rDoc = canonSet(docKeys.rKeys);
  const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort(compareKeys);
  const missingG = diff(gDoc, gReg);
  const extraG = diff(gReg, gDoc);
  const missingRAll = diff(rDoc, rReg);
  const extraR = diff(rReg, rDoc);
  // ⚠️ R 段为空 = 尚未做 R 段登记（首次登记前）⇒ 按方案 J1 原文**不据此报差集**。
  //    这里 `missingR` 也必须跟着清空（不只是 `ok` 放行）：否则渲染器会照着 missingR 打印
  //    "缺 R1..R20" 却 exit 0，判据与差异列表自相矛盾。全量差值留在 `missingRWhenRegistered`（诊断用）。
  const rRegisteredEmpty = rReg.size === 0;
  const missingR = rRegisteredEmpty ? [] : missingRAll;
  const rCovered = rRegisteredEmpty || missingRAll.length === 0;
  return {
    ok: missingG.length === 0 && rCovered,
    rule: '归一化规则：§6.1 首列纯数字 n ↔ 登记侧键 R<n>（先归一再比集合）',
    registeredG: [...gReg].sort(compareKeys),
    registeredR: [...rReg].sort(compareKeys),
    docGCount: gDoc.size,
    docRCount: rDoc.size,
    rRegisteredEmpty,
    missingG, extraG, missingR, extraR,
    /** 诊断：若不看"R 段是否已登记"这条豁免，R 段还差哪些（首次登记时用来估工作量）。 */
    missingRWhenRegistered: missingRAll,
  };
}

// ---------------------------------------------------------------- 读

/**
 * 解析登记表文本（剥离 BOM；**不抛错**）。
 * @param {string} text
 */
export function parseRegistryText(text) {
  let raw = String(text ?? '');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // PS5.1 Set-Content -Encoding UTF8 的 BOM
  if (!raw.trim()) return { ok: false, error: '内容为空（0 字节或全空白）' };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${e?.message ?? e}` };
  }
}

/** 序列化登记表（**无 BOM**，LF 行尾，末尾换行）。 */
export function serializeRegistry(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * 读登记表（**唯一读入口**；不抛错）。
 * - 文件不存在 → `{ok:false, exists:false, data: 空表, fatal:[…]}`（按方案 T18：按空表继续，表头显式标"登记表缺失"）
 * - 语法错 / schema 不符 / host 不符 → `fatal` 非空
 * @param {string} file
 * @param {{host?:string, expectedHost?:string|null, strictHost?:boolean, now?:number}} [opts]
 * @returns {{ok:boolean, exists:boolean, file:string, data:object|null, bytes:number, mtime:string|null, fatal:Array, errors:Array, warnings:Array}}
 */
export function readRegistry(file, opts = {}) {
  const fatal = []; const errors = []; const warnings = [];
  const host = String(opts.host ?? 'unknown');
  const base = { ok: false, exists: false, file, data: null, bytes: 0, mtime: null, fatal, errors, warnings };

  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') {
      fatal.push({ code: 'REGISTRY_MISSING', message: `登记表不存在（${file}）→ 按空表继续；首次登记前这是预期态` });
      return { ...base, data: emptyRegistry(host, opts) };
    }
    fatal.push({ code: 'REGISTRY_UNREADABLE', message: `登记表读不到（${file}）：${e?.code ?? ''} ${e?.message ?? e}` });
    return { ...base, data: emptyRegistry(host, opts) };
  }

  let mtime = null; let bytes = 0;
  try { const st = fs.statSync(file); mtime = new Date(st.mtimeMs).toISOString(); bytes = Buffer.byteLength(text, 'utf8'); } catch { /* stat 失败不影响解析 */ }

  const parsed = parseRegistryText(text);
  if (!parsed.ok) {
    fatal.push({ code: 'REGISTRY_PARSE_ERROR', message: `登记表解析失败（${file}）：${parsed.error}` });
    return { ...base, exists: true, bytes, mtime, data: null };
  }

  const schema = validateRegistry(parsed.data, { expectedHost: opts.expectedHost ?? null, strictHost: opts.strictHost !== false });
  fatal.push(...schema.fatal);
  errors.push(...schema.errors);
  warnings.push(...schema.warnings);
  return { ok: fatal.length === 0, exists: true, file, data: parsed.data, bytes, mtime, fatal, errors, warnings };
}

// ---------------------------------------------------------------- schema 校验（J5 / J15）

function foreign(obj, allowed) {
  return Object.keys(obj ?? {}).filter((k) => !allowed.includes(k));
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 结构校验（纯函数，不碰文件系统）。
 * @param {any} data
 * @param {{expectedHost?:string|null, strictHost?:boolean}} [opts]
 * @returns {{ok:boolean, fatal:Array, errors:Array, warnings:Array}}
 */
export function validateRegistry(data, opts = {}) {
  const fatal = []; const errors = []; const warnings = [];
  const err = (code, message, extra) => errors.push({ code, message, ...extra });
  const war = (code, message, extra) => warnings.push({ code, message, ...extra });

  if (!isPlainObject(data)) {
    fatal.push({ code: 'REGISTRY_NOT_OBJECT', message: '登记表顶层必须是 JSON 对象' });
    return { ok: false, fatal, errors, warnings };
  }

  const extraTop = foreign(data, REGISTRY_TOP_KEYS);
  if (extraTop.length) {
    err('REGISTRY_FOREIGN_KEY', `顶层出现白名单之外的键：${extraTop.join(', ')}（卡状态/档位不得进登记表 —— J5 / 反例 R-3）`);
  }

  const sv = Number(data.schemaVersion);
  if (!Number.isFinite(sv)) fatal.push({ code: 'REGISTRY_NO_SCHEMA_VERSION', message: '缺 schemaVersion' });
  else if (sv !== REGISTRY_SCHEMA_VERSION) {
    fatal.push({ code: 'REGISTRY_SCHEMA_MISMATCH', message: `schemaVersion=${sv} 与期望 ${REGISTRY_SCHEMA_VERSION} 不符（无迁移脚本 → 不猜、不静默降级）` });
  }

  if (data.host !== undefined && typeof data.host !== 'string') err('REGISTRY_HOST_TYPE', 'host 必须是字符串');
  if (opts.expectedHost && String(data.host ?? '') !== String(opts.expectedHost)) {
    fatal.push({ code: 'REGISTRY_HOST_MISMATCH', message: `登记表 host=${String(data.host ?? '(缺)')} 与本文档 hostTag=${opts.expectedHost} 不符（禁止把对端登记表当自己的读）` });
  }
  if (data.asOf === undefined) war('REGISTRY_NO_AS_OF', '缺 asOf（登记日期，人自报；滞后即标 ⚠️）');
  else if (!DATE_RE.test(String(data.asOf))) err('REGISTRY_AS_OF_FORMAT', `asOf「${data.asOf}」不是 YYYY-MM-DD`);

  if (!Array.isArray(data.entries)) {
    fatal.push({ code: 'REGISTRY_ENTRIES_TYPE', message: 'entries 必须是数组（空表 = []）' });
    return { ok: false, fatal, errors, warnings };
  }

  const seen = new Map();
  data.entries.forEach((entry, i) => {
    const at = `entries[${i}]`;
    if (!isPlainObject(entry)) { err('ENTRY_NOT_OBJECT', `${at} 必须是对象`); return; }
    const extra = foreign(entry, ENTRY_KEYS);
    if (extra.length) err('ENTRY_FOREIGN_KEY', `${at} 出现白名单之外的键：${extra.join(', ')}（J5）`, { at });

    const nk = normalizeKey(entry.key);
    if (!nk.ok) err('ENTRY_KEY_INVALID', `${at} 键非法：${nk.error}`, { at, key: entry.key });
    else {
      if (seen.has(nk.canon)) err('ENTRY_KEY_DUPLICATE', `${at} 键重复：${nk.canon}（已在 entries[${seen.get(nk.canon)}] 出现 —— J15）`, { at, key: nk.canon });
      else seen.set(nk.canon, i);
    }

    if (entry.note !== undefined && typeof entry.note !== 'string') err('ENTRY_NOTE_TYPE', `${at}.note 必须是字符串`, { at });

    // blocked：null / 缺省 = 未卡住；对象则白名单 + kind 四值
    if (entry.blocked !== undefined && entry.blocked !== null) {
      if (!isPlainObject(entry.blocked)) err('ENTRY_BLOCKED_TYPE', `${at}.blocked 必须是对象或 null`, { at });
      else {
        const bx = foreign(entry.blocked, BLOCKED_KEYS);
        if (bx.length) err('ENTRY_BLOCKED_FOREIGN_KEY', `${at}.blocked 白名单之外的键：${bx.join(', ')}`, { at });
        if (!BLOCKED_KINDS.includes(String(entry.blocked.kind ?? ''))) {
          err('ENTRY_BLOCKED_KIND', `${at}.blocked.kind「${entry.blocked.kind}」不在 ${BLOCKED_KINDS.join('/')} 内`, { at });
        }
        if (entry.blocked.who !== undefined && typeof entry.blocked.who !== 'string') err('ENTRY_BLOCKED_WHO', `${at}.blocked.who 必须是字符串`, { at });
        if (entry.blocked.why !== undefined && typeof entry.blocked.why !== 'string') err('ENTRY_BLOCKED_WHY', `${at}.blocked.why 必须是字符串`, { at });
      }
    }

    // plans
    if (entry.plans === undefined) err('ENTRY_PLANS_MISSING', `${at} 缺 plans（可为空数组，但字段必须在 —— 方案 §0#3）`, { at });
    else if (!Array.isArray(entry.plans)) err('ENTRY_PLANS_TYPE', `${at}.plans 必须是数组`, { at });
    else entry.plans.forEach((p, j) => {
      const pat = `${at}.plans[${j}]`;
      if (!isPlainObject(p)) { err('PLAN_NOT_OBJECT', `${pat} 必须是对象`, { at }); return; }
      const px = foreign(p, PLAN_KEYS);
      if (px.length) err('PLAN_FOREIGN_KEY', `${pat} 白名单之外的键：${px.join(', ')}`, { at });
      if (typeof p.path !== 'string' || !p.path.trim()) err('PLAN_PATH_MISSING', `${pat}.path 必填且非空（相对 <butler-root> 根）`, { at });
      else if (path.isAbsolute(String(p.path))) err('PLAN_PATH_ABSOLUTE', `${pat}.path 必须是相对 <butler-root> 根的相对路径，收到绝对路径「${p.path}」`, { at });
      if (!PLAN_KINDS.includes(String(p.kind ?? ''))) err('PLAN_KIND_INVALID', `${pat}.kind「${p.kind}」不在 ${PLAN_KINDS.join('/')} 内（缺它就没法区分方案档与设计档 —— 方案 §7.1 失败点③）`, { at });
      if (!REVIEW_VALUES.includes(String(p.review ?? ''))) err('PLAN_REVIEW_INVALID', `${pat}.review「${p.review}」不在 ${REVIEW_VALUES.join('/')} 内`, { at });
      if (p.asOf !== undefined && !DATE_RE.test(String(p.asOf))) err('PLAN_AS_OF_FORMAT', `${pat}.asOf「${p.asOf}」不是 YYYY-MM-DD`, { at });
      if (p.evidence !== undefined && p.evidence !== null) {
        if (!isPlainObject(p.evidence)) err('PLAN_EVIDENCE_TYPE', `${pat}.evidence 必须是对象或 null`, { at });
        else {
          const ex = foreign(p.evidence, EVIDENCE_KEYS);
          if (ex.length) err('PLAN_EVIDENCE_FOREIGN_KEY', `${pat}.evidence 白名单之外的键：${ex.join(', ')}`, { at });
          if (p.evidence.path !== undefined && (typeof p.evidence.path !== 'string' || path.isAbsolute(String(p.evidence.path)))) {
            err('PLAN_EVIDENCE_PATH', `${pat}.evidence.path 必须是相对 <butler-root> 根的相对路径字符串`, { at });
          }
          if (p.evidence.kind !== undefined && !EVIDENCE_KINDS.includes(String(p.evidence.kind))) {
            err('PLAN_EVIDENCE_KIND', `${pat}.evidence.kind「${p.evidence.kind}」不在 ${EVIDENCE_KINDS.join('/')} 内`, { at });
          }
        }
      }
    });

    // cards
    if (entry.cards === undefined) err('ENTRY_CARDS_MISSING', `${at} 缺 cards（可为空数组，但字段必须在 —— 方案 §0#3）`, { at });
    else if (!Array.isArray(entry.cards)) err('ENTRY_CARDS_TYPE', `${at}.cards 必须是数组`, { at });
    else entry.cards.forEach((c, j) => {
      const cat = `${at}.cards[${j}]`;
      if (!isPlainObject(c)) { err('CARD_NOT_OBJECT', `${cat} 必须是对象`, { at }); return; }
      const cx = foreign(c, CARD_KEYS);
      if (cx.length) err('CARD_FOREIGN_KEY', `${cat} 白名单之外的键：${cx.join(', ')}（⚠️ 卡状态不得进登记表，哪怕只是"顺手记一下"）`, { at });
      const id = String(c.id ?? '');
      if (!UUID_RE.test(id)) {
        err('CARD_ID_INVALID', `${cat}.id「${id || '(缺)'}」必须是**完整 uuid**（seq 有重复组不能当键 —— 方案 E3/O2-2）`, { at });
      }
      if (c.titleSnapshot !== undefined && typeof c.titleSnapshot !== 'string') err('CARD_TITLE_TYPE', `${cat}.titleSnapshot 必须是字符串（只作展示 + 漂移告警，不作判定）`, { at });
      if (c.role !== undefined && typeof c.role !== 'string') err('CARD_ROLE_TYPE', `${cat}.role 必须是字符串`, { at });
    });
  });

  return { ok: fatal.length === 0, fatal, errors, warnings };
}

// ---------------------------------------------------------------- 外键 / 引用（J2 / J3 / J4）

function defaultProbePath(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { exists: false, bytes: 0, error: 'not-a-file' };
    return { exists: true, bytes: st.size, error: null };
  } catch (e) {
    return { exists: false, bytes: 0, error: e?.code ?? String(e?.message ?? e) };
  }
}

/**
 * 引用可解析性校验（纯函数 + 可注入探测，供单测隔离生产路径）。
 * - 键 ∈ 权威表键集（J2 外键严）
 * - `plans[].path` / `evidence.path` 存在且非空（J3）
 * - `cards[].id` 在 `tasks[]` 里存在（J4；归档卡照实标 `archived`，找不到即红 —— **不静默跳过**）
 * @param {object} data 登记表
 * @param {{
 *   availableKeys?:{g?:Iterable<string>, r?:Iterable<string>}|null,
 *   taskIds?:Iterable<string>|null,
 *   archivedIds?:Iterable<string>|null,
 *   titleById?:Map<string,string>|null,
 *   root?:string, probePath?:(abs:string)=>{exists:boolean,bytes:number,error:string|null}
 * }} [opts]
 */
export function crossCheckRegistry(data, opts = {}) {
  const errors = []; const warnings = [];
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const root = opts.root ?? DSH_ROOT_DEFAULT;
  const probePath = typeof opts.probePath === 'function' ? opts.probePath : defaultProbePath;
  const taskIds = opts.taskIds ? new Set([...opts.taskIds].map(String)) : null;
  const archivedIds = opts.archivedIds ? new Set([...opts.archivedIds].map(String)) : new Set();
  const titleById = opts.titleById instanceof Map ? opts.titleById : null;
  const keys = opts.availableKeys ?? null;
  const gSet = keys?.g ? canonSet(keys.g) : null;
  const rSet = keys?.r ? canonSet(keys.r) : null;

  const checkPath = (rel, label, at) => {
    const abs = resolveRepoPath(root, rel);
    if (!abs) { errors.push({ code: 'PATH_EMPTY', message: `${label} 路径为空（${at}）`, at }); return; }
    const probe = probePath(abs);
    if (!probe.exists) errors.push({ code: 'PATH_NOT_FOUND', message: `${label} 不存在：${rel} → ${abs}（${probe.error ?? 'ENOENT'}）`, at, path: rel, abs });
    else if (!probe.bytes) errors.push({ code: 'PATH_EMPTY_FILE', message: `${label} 存在但为空文件：${rel}`, at, path: rel, abs });
  };

  entries.forEach((entry, i) => {
    const at = `entries[${i}]`;
    const nk = normalizeKey(entry?.key);
    const label = nk.ok ? nk.canon : String(entry?.key ?? '(缺键)');
    if (nk.ok && keys) {
      const set = nk.seg === 'G' ? gSet : rSet;
      if (set && !set.has(nk.canon)) {
        errors.push({ code: 'KEY_NOT_IN_DOC', message: `${label} 不在总纲 ${nk.seg === 'G' ? '§5.1' : '§6.1'} 权威表里（登记表有、权威源没有 —— J2）`, at, key: label });
      }
    }
    for (const [j, p] of (Array.isArray(entry?.plans) ? entry.plans : []).entries()) {
      if (typeof p?.path === 'string' && p.path.trim()) checkPath(p.path, `${at}.plans[${j}].path`, at);
      const ev = p?.evidence;
      if (isPlainObject(ev) && typeof ev.path === 'string' && ev.path.trim()) checkPath(ev.path, `${at}.plans[${j}].evidence.path`, at);
      const abs = isPlainObject(ev) && typeof ev.path === 'string' ? resolveRepoPath(root, ev.path) : '';
      if (abs && probePath(abs).exists && ev.kind === 'section') {
        warnings.push({ code: 'EVIDENCE_WEAK_CHECK', message: `${at}.plans[${j}] 的过审证据是 section 类 → 渲染器只做弱核对（标题行 + 台账交叉），不构成合格证`, at });
      }
    }
    for (const [j, c] of (Array.isArray(entry?.cards) ? entry.cards : []).entries()) {
      const id = String(c?.id ?? '');
      if (!taskIds) continue;
      if (!taskIds.has(id)) {
        errors.push({ code: 'CARD_NOT_FOUND', message: `${at}.cards[${j}] 卡 ${id} 在账本里找不到（J4，不静默跳过）`, at, cardId: id });
        continue;
      }
      if (archivedIds.has(id)) warnings.push({ code: 'CARD_ARCHIVED', message: `${at}.cards[${j}] 卡 ${id} 已归档（终态；档位不得因此判 ✅ 落地）`, at, cardId: id });
      if (titleById && typeof c?.titleSnapshot === 'string') {
        const live = titleById.get(id);
        if (live !== undefined && live !== c.titleSnapshot) {
          warnings.push({ code: 'CARD_TITLE_DRIFT', message: `${at}.cards[${j}] 卡标题快照与实况不符（登记：${c.titleSnapshot} ／ 实况：${live}）→ 建议更新登记表`, at, cardId: id });
        }
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------- 写（唯一入口，原子写）

/**
 * 写登记表（**唯一写入口**）。写出前先 schema 校验：不合格**拒绝写**（不许把坏数据落盘）。
 * 原子写用 store.mjs 的 writeTextAtomic（tmp + fsync + rename，Windows 占用重试 3 次，绝不退化直写）。
 * @param {string} file
 * @param {object} data
 * @param {{expectedHost?:string|null, retryDelaysMs?:number[]}} [opts]
 * @returns {{ok:boolean, written:boolean, file:string, bytes?:number, attempts?:number, fatal:Array, errors:Array, warnings:Array}}
 */
export function writeRegistry(file, data, opts = {}) {
  const v = validateRegistry(data, { expectedHost: opts.expectedHost ?? null });
  if (v.fatal.length || v.errors.length) {
    return { ok: false, written: false, file, fatal: v.fatal, errors: v.errors, warnings: v.warnings };
  }
  try {
    const r = writeTextAtomic(file, serializeRegistry(data), opts.retryDelaysMs ? { retryDelaysMs: opts.retryDelaysMs } : {});
    return { ok: true, written: true, file, bytes: r.bytes, attempts: r.attempts, fatal: [], errors: [], warnings: v.warnings };
  } catch (e) {
    return { ok: false, written: false, file, fatal: [{ code: 'REGISTRY_WRITE_FAILED', message: `原子写失败：${e?.message ?? e}` }], errors: [], warnings: v.warnings };
  }
}

/** 登记表文件状态（不存在也如实回报，不抛错）。 */
export function registryStat(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs, file };
  } catch (e) {
    return { exists: false, bytes: 0, mtime: null, mtimeMs: null, file, error: e?.code ?? String(e?.message ?? e) };
  }
}
