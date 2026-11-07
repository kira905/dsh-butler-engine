// dsh-butler / lib/progress-extract.mjs —— 开发进度指示器（A 计划）· **只读**事实抽取器
//
// 它是什么：把"两端权威"的**既有事实**抽成结构化数据，供渲染器（卡 2 的 progress-status.mjs）用：
//   ① **看板**：`GET /api/task-board/state` → 卡的状态（唯一权威 = 看板实况，本模块**只读、绝不写账本**）
//   ② **总纲**：`docs/` §5.1（G 表）/ §6.1（工作域表）→ 条目键 + 原文文字
//      （唯一权威 = 总纲；抽取失败就判"不可用"，**不回落手写副本** —— 避免造第二处真相）
//   怎么跑：被 progress-status.mjs import；本模块无 CLI、无副作用（除了把探到的 mtime 如实回报）。
//   怎么回滚：删文件即回滚（渲染器是纯派生视图，本模块是它的取数层）。
//
// 三条设计铁律（逐条有判据）：
//   ① **只读**：只发 `GET /api/task-board/state`（复用 lib\ledger-api.mjs 的 `readState()`：
//      同源头头 / 8s 超时 / 错误分档；该模块注释原文"绝不写账本"）。**永不** POST/PUT/DELETE（J7）。
//   ② **降级不抛错、也不造假**（J5-卡口径 / J10 / J14）：看板不可达 → `available:false`
//      + 分档文案（offline/retryable → "未取到"+exit 4；permanent（403 origin 头不对 / bad-port）
//      → 文案另写"取数被拒（配置问题…）"+exit 2，J13），**tasks 一律给空数组且标 `tasksTrustworthy:false`**
//      —— 调用方必须先判 `available` 再用 `tasks`，禁把空数组当真相当"0 卡/全绿"。
//   ③ **按表头列名取列，不按列序号、也不写死行号**（行号会漂：方案记 §5.1 表头 @:522，本卡 2026-09-17
//      实测已漂到 524；② 包 A-5 还会给 G 表加两列）。列名匹配做归一（去空格）+ 前缀兜底，
//      **列名兜底是已知维护点**（方案 §9 R2）：若列名被改名（如"解除条件"→"销案条件"），
//      本文件顶部的 *_COL 常量要同步改。
//
// ⚠️ 实测坑（2026-09-17 本卡亲跑，写入代码注释防复踩）：
//   - 总纲里**有 4 处表头带 `#` 列**（§2.0 取证表、§R6 判据表、§5.1 G 表、§6.1）：**两个目标表的首列
//     都叫 `#`** ⇒ **不能靠"首列是 #"认表**，必须靠**第二列列名**区分（G 表 = `缺口`，§6.1 = `项`）。
//   - §6.1 首列是**纯数字** `1…20`，登记侧键写作 `R<n>` ⇒ 归一化在 progress-registry.normalizeKey 里做（J1）。
import fs from 'node:fs';
import path from 'node:path';
import { createLedgerApi, DEFAULT_BASE_URL, STATE_PATH } from './ledger-api.mjs';
import { normalizeKey, compareKeys } from './progress-registry.mjs';
import { dshHome } from './paths.mjs';
// 归档批次卡面（K4 物理归档后的唯一读法）：路径与批次索引口径复用既有模块，**不自造第二处真源**
import { readArchivedCardsSync } from '../../lib/board-archive-view.mjs';

/** 总纲默认路径（权威源；只读）。 */
export const DEFAULT_DOC_PATH = '<butler-root>\\docs/';

/** 表头识别：靠**第二列列名**认表（两表首列同名 `#`，见头注实测坑）。 */
export const G_TABLE_SECOND_COL = '缺口';
export const R_TABLE_SECOND_COL = '项';

/** 各表列名（按名取列；改名即需同步改这里 —— 方案 §9 R2 已知维护点）。 */
export const G_COLS = Object.freeze({ key: '#', gap: '缺口', owner: '归属', type: '类型', status: '状态', release: '解除条件 / 触发点' });
export const R_COLS = Object.freeze({ key: '#', item: '项', owner: '归属', done: '做完的', closed: '关着的', todo: '没做的', gist: '最要紧的一句' });

// ---------------------------------------------------------------- 文本/表格解析

/** 归一化行尾（照方案 §3.5.2：`\r\n` → `\n`；实测总纲为纯 LF，但统一归一以抗将来）。 */
export function normalizeNewlines(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** 拆一行 markdown 表格（去掉首尾空单元格）。 */
function splitRow(line) {
  return String(line).split('|').slice(1, -1).map((s) => s.trim());
}

/** 是不是分隔行（`|---|---|`）。 */
function isSeparatorRow(line) {
  return /^\|[\s:|-]+\|?\s*$/.test(String(line).trim());
}

/** 本表行的起判：以 `|` 开头（**blockquote 内的 `> |` 不算本表行** —— 订正注里常内嵌子表）。 */
function looksLikeTableRow(line) { return /^\s*\|/.test(String(line)); }

/** 引用块行（订正注 / 读法注：`> …`）。 */
function looksLikeQuote(line) { return /^\s*>/.test(String(line)); }

/**
 * 表块结束标志：标题 / 代码围栏 / 水平线（文档结构里表总被它们终结）。
 *
 * ⚠️ **实测坑（2026-09-28 · 卡【进度表失真修复】）**：旧实现在**第一个非表格行**就 `break`，
 *    而总纲 §5.1 按「只加订正注、不改原文」体例在**表体中间**插了大量 `> ⚠️ 订正注…` 行
 *    ⇒ 表在 **G13 行后即被截断**，只抽到 13/34 行，其余 21 行被渲染成「总纲对应行取不到」
 *    （表自报「§5.1 · 13 条 → 登记 34 条」）。修法 = 遇非表格行**不 break、记为表内注块继续扫**。
 */
function endsTableBlock(line) {
  const t = String(line);
  return /^\s*#{1,6}\s/.test(t) || /^\s*```/.test(t) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(t);
}

/** 列名匹配：精确 → 去空格 → 前缀兜底（返回列下标，找不到 -1）。 */
export function colIndex(cells, wanted) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, '');
  const w = norm(wanted);
  let i = (cells ?? []).findIndex((c) => String(c).trim() === String(wanted).trim());
  if (i >= 0) return i;
  i = (cells ?? []).findIndex((c) => norm(c) === w);
  if (i >= 0) return i;
  return (cells ?? []).findIndex((c) => norm(c).startsWith(w));
}

/**
 * 按第二列列名定位一张表（返回表头行下标；找不到 -1）。
 * @param {string[]} lines
 * @param {string} secondColName
 */
export function findTableHeader(lines, secondColName) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('|')) continue;
    const cells = splitRow(l);
    if (cells.length < 2) continue;
    if (cells[0] === '#' && cells[1].trim() === secondColName) return i;
  }
  return -1;
}

/**
 * 解析一张"首列是 #"的表。
 *
 * **表体扫描规则（2026-09-28 修 · 抽取面失效）**：不再"遇非表格行即停"，而是
 *   · **空行 / 引用块行 / 其它非表格行** → 记为**表内注块（订正注）**，继续扫；
 *   · **标题 / 代码围栏 / 水平线** → 表结束；
 *   · `|` 开头且首列符合键形态 → 数据行（`> |` 开头的订正注内嵌子表行**不会被误收**）。
 *
 * **注块归属（`attributedBy`）**：
 *   · `mentioned` —— 注块里点到了本表的键（`G33` / 「第 23 项」）⇒ 归**那些键**（一条注可归多条）；
 *   · `following-row` —— 没点名 ⇒ 归**紧邻其上的那一个数据行**（并如实标注是这个口径，不冒充点名）；
 *   · `unattached` —— 表头后、首个数据行之前的注 ⇒ 不归属。
 *
 * @param {string[]} lines
 * @param {number} headerIdx
 * @param {{secondCol:string, keyPattern:RegExp, canonize:(raw:string)=>({ok:boolean,canon?:string,error?:string}), mentionRes?:RegExp[]}} spec
 */
function parseTableAt(lines, headerIdx, spec) {
  const headerLine = headerIdx + 1;
  const columns = splitRow(lines[headerIdx]);
  const keyIdx = colIndex(columns, '#');
  const rows = [];
  const notes = [];
  const byCanon = new Map();
  /** 表体内识别到的订正注块（渲染层据此做「原文 + 订正注 + 卡实况」合读）。 */
  const noteBlocks = [];
  let pending = [];
  let lastRow = null;

  /** 剔除**范围表述**（`G1–G32` / `第 17–20 项`）：范围左端 ≠ "点名该行"，留着会造成假归属（实测：G1 被挂 3 条与它无关的注）。 */
  const stripRanges = (text) => String(text)
    .replace(/G\d{1,3}\s*[–—~至-]\s*G?\d{1,3}/g, (m) => ' '.repeat(m.length))
    .replace(/第\s*\d{1,3}\s*[–—~至-]\s*\d{1,3}\s*项/g, (m) => ' '.repeat(m.length));

  /**
   * 从一段文字里捞出本表的键引用（`G33` / 「第 23 项」…）——**取捕获组**，纯数字键交给 canonize 判段。
   * `strong` = 被反引号 / 加粗 / 【】「」 包住，或后随「行 / 格 / 项 / 条」⇒ 视为**真点名**；
   * 裸键（`G9 / G16` 这类并列清单）只算**弱提及**，归属时让位于 strong（精度优先，避免把"清单"当"点名"）。
   */
  const mentionKeysOf = (text) => {
    const t = stripRanges(text);
    const out = [];
    for (const re of spec.mentionRes ?? []) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t)) !== null) {
        const raw = String(m[1] ?? m[0]);
        const nk = spec.canonize(raw);
        if (!nk.ok || out.some((x) => x.key === nk.canon)) continue;
        const end = m.index + m[0].length;
        const before = t.slice(Math.max(0, m.index - 3), m.index);
        const after = t.slice(end, end + 4);
        const strong = /[`*【\[「]\s*$/.test(before) || /^\s*(行|格|项|条)/.test(after) || /^\s*[`*】\]」]/.test(after);
        out.push({ key: nk.canon, strong });
      }
    }
    return out;
  };

  const flushNotes = () => {
    if (!pending.length) return;
    const all = new Map();   // key → 是否强点名（同一块里出现强形态即升格）
    for (const p of pending) for (const { key, strong } of mentionKeysOf(p.text)) all.set(key, (all.get(key) ?? false) || strong);
    const existing = [...all.keys()].filter((k) => byCanon.has(k));
    const strongKeys = existing.filter((k) => all.get(k) === true);
    const weakKeys = existing.filter((k) => all.get(k) !== true);
    const targets = strongKeys.length ? strongKeys : weakKeys;
    const block = {
      fromLine: pending[0].line,
      toLine: pending[pending.length - 1].line,
      lines: pending.map((x) => x.text),
      mentionKeys: existing,
      strongKeys,
      attributedBy: strongKeys.length ? 'mentioned-strong'
        : (weakKeys.length ? 'mentioned-weak' : (lastRow ? 'following-row' : 'unattached')),
      attributedTo: targets.length ? targets : (lastRow ? [lastRow.canonKey] : []),
    };
    noteBlocks.push(block);
    for (const k of block.attributedTo) byCanon.get(k)?.docNotes.push(block);
    pending = [];
  };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (endsTableBlock(l)) { flushNotes(); break; }
    if (!String(l).trim()) { flushNotes(); continue; }
    if (looksLikeQuote(l) || !looksLikeTableRow(l)) { pending.push({ line: i + 1, text: l }); continue; }
    if (isSeparatorRow(l)) continue;
    const cells = splitRow(l);
    const rawKey = String(cells[keyIdx >= 0 ? keyIdx : 0] ?? '').trim();
    if (!spec.keyPattern.test(rawKey)) {
      notes.push({ code: 'ROW_KEY_SKIPPED', message: `第 ${i + 1} 行首列「${rawKey}」不符合 ${spec.keyPattern} → 跳过该行（不改判、不猜）`, line: i + 1 });
      continue;
    }
    const nk = spec.canonize(rawKey);
    if (!nk.ok) { notes.push({ code: 'ROW_KEY_INVALID', message: `第 ${i + 1} 行键非法：${nk.error}`, line: i + 1 }); continue; }
    if (cells.length !== columns.length) {
      notes.push({ code: 'ROW_CELL_COUNT', message: `第 ${i + 1} 行有 ${cells.length} 格、表头 ${columns.length} 列 → 按列名取格可能错位（如实标注，不猜）`, line: i + 1 });
    }
    flushNotes();   // 收行前先把挂着的注块落定（归上一行 / 点名键）
    const named = {};
    columns.forEach((c, ci) => { named[String(c).trim()] = String(cells[ci] ?? '').trim(); });
    const row = { key: rawKey, canonKey: nk.canon, line: i + 1, cells: named, raw: cells, docNotes: [] };
    rows.push(row);
    if (!byCanon.has(nk.canon)) byCanon.set(nk.canon, row);
    lastRow = row;
  }
  flushNotes();   // 表尾挂着的注（最后一行之后 / 表末）

  return {
    available: true,
    headerLine,
    columns,
    keyColumnIndex: keyIdx,
    rows,
    keys: rows.map((r) => r.canonKey),
    notes,
    noteBlocks,
  };
}

/**
 * 只读解析总纲 §5.1 / §6.1。
 * @param {{docPath?:string}} [opts]
 * @returns {{available:boolean, path:string, bytes:number, mtime:string|null, error:string|null,
 *            g:object, r:object, errors:Array}}
 */
export function extractDocTables(opts = {}) {
  const docPath = opts.docPath ?? DEFAULT_DOC_PATH;
  const empty = (error) => ({
    available: false, path: docPath, bytes: 0, mtime: null, error,
    g: { available: false, error, headerLine: null, columns: [], rows: [], keys: [], notes: [] },
    r: { available: false, error, headerLine: null, columns: [], rows: [], keys: [], notes: [] },
    errors: [{ code: 'DOC_UNAVAILABLE', message: error }],
  });

  let text;
  try {
    text = fs.readFileSync(docPath, 'utf8');
  } catch (e) {
    return empty(`总纲读不到（${docPath}）：${e?.code ?? ''} ${e?.message ?? e} → §5.1/§6.1 判"不可用"（不回落手写副本）`);
  }
  let mtime = null;
  try { mtime = new Date(fs.statSync(docPath).mtimeMs).toISOString(); } catch { /* 只读，stat 失败不影响 */ }

  const lines = normalizeNewlines(text).split('\n');
  const gIdx = findTableHeader(lines, G_TABLE_SECOND_COL);
  const rIdx = findTableHeader(lines, R_TABLE_SECOND_COL);
  const errors = [];
  const blankTable = (error) => ({ available: false, error, headerLine: null, columns: [], rows: [], keys: [], notes: [] });
  let g = blankTable(null);
  let r = blankTable(null);

  if (gIdx < 0) {
    g.error = `总纲 §5.1 G 表未定位到（找不到第二列为「${G_TABLE_SECOND_COL}」的表头）→ 判"不可用"`;
    errors.push({ code: 'G_TABLE_NOT_FOUND', message: g.error });
  } else {
    g = { ...parseTableAt(lines, gIdx, {
      secondCol: G_TABLE_SECOND_COL,
      keyPattern: /^G\d{1,3}$/i,
      canonize: (raw) => { const nk = normalizeKey(raw); return nk.ok && nk.seg === 'G' ? nk : { ok: false, error: `G 段键应以 G 开头：${raw}` }; },
      // 订正注点名的键形态：`G33`（**捕获组给 canonize 的是完整键**，不能给纯数字 —— 那会被判成 R 段）
      mentionRes: [/(G\d{1,3})/gi],
    }), error: null };
  }
  if (rIdx < 0) {
    r.error = `总纲 §6.1 未定位到（找不到第二列为「${R_TABLE_SECOND_COL}」的表头）→ 判"不可用"`;
    errors.push({ code: 'R_TABLE_NOT_FOUND', message: r.error });
  } else {
    r = { ...parseTableAt(lines, rIdx, {
      secondCol: R_TABLE_SECOND_COL,
      keyPattern: /^(R)?\d{1,3}$/i,
      // §6.1 首列是纯数字 → 归一键 R<n>（J1 归一化前置；纯数字与 R<n> 两种写法都收）
      canonize: (raw) => { const nk = normalizeKey(raw); return nk.ok ? nk : { ok: false, error: `§6.1 键应为数字或 R<n>：${raw}` }; },
      // §6.1 的订正注惯用「第 23 项」写法（而非 `R23`）⇒ 两种都认
      mentionRes: [/第\s*(\d{1,3})\s*项/g, /(R\d{1,3})/gi],
    }), error: null };
  }

  return {
    available: g.available || r.available,
    path: docPath,
    bytes: Buffer.byteLength(text, 'utf8'),
    mtime,
    error: errors.length ? errors.map((e) => e.message).join('；') : null,
    g, r, errors,
  };
}

/** 按列名取某条目的原文（抽取失败/键不存在 → null，调用方据此显示"解析失败"，不回落副本）。 */
export function cellOf(table, canonKey, colName) {
  if (!table?.available) return null;
  const nk = normalizeKey(canonKey);
  const key = nk.ok ? nk.canon : String(canonKey);
  const row = (table.rows ?? []).find((x) => x.canonKey === key);
  if (!row) return null;
  const idx = colIndex(table.columns, colName);
  if (idx < 0) return null;
  return row.raw[idx] ?? null;
}

// ---------------------------------------------------------------- 归档面（K4 物理归档后的兜底读法）

/**
 * 归档批次里的卡面（**只读、永不抛**）—— 给"主账本 `/state` 里已经找不到"的卡做兜底判档。
 *
 * 为什么需要（卡【进度表失真修复】②）：K4（2026-09-27）把 486 张卡**物理搬进**
 *   `task-board\archive\<batchId>\cards.json`（主账本 7.68 MB → 2.39 MB）。**当前 `/state`
 *   仍全量返回归档卡**（带 `archivedAt` + 原 status），所以**归档案位语义的修法不依赖本函数**；
 *   本函数只覆盖"连 state 都不返回该卡"的降级场景，让表能**如实写出判据来源** =
 *   「卡面 status（state 实况）」还是「归档批次里的归档前最后状态」。
 *
 * 口径：归档路径与批次索引一律走 `tools\lib\board-archive-view.mjs`（既有唯一源），**不自造第二处**。
 * @param {{home?:string, cache?:boolean, readCards?:Function}} [opts]
 * @returns {{ok:boolean, source:string, reason:string, home:string, byId:Map<string,object>,
 *            count:number, batches:number, errors:string[]}}
 */
export function readArchivedCardsSafe(opts = {}) {
  const home = opts.home ?? dshHome();
  try {
    const view = typeof opts.readCards === 'function'
      ? opts.readCards(home)
      : readArchivedCardsSync(home, opts.cache === false ? { cache: false } : {});
    return {
      ok: Boolean(view?.ok),
      source: String(view?.source ?? 'none'),
      reason: String(view?.reason ?? ''),
      home,
      byId: view?.byId instanceof Map ? view.byId : new Map(),
      count: Number(view?.count ?? 0),
      batches: Array.isArray(view?.batches) ? view.batches.length : 0,
      errors: Array.isArray(view?.errors) ? view.errors : [],
    };
  } catch (e) {
    return {
      ok: false, source: 'error', reason: `归档面读失败：${e?.message ?? e}`,
      home, byId: new Map(), count: 0, batches: 0, errors: [String(e?.message ?? e)],
    };
  }
}

// ---------------------------------------------------------------- 看板（只读降级不抛错）

/** 错误分档 → 人话 + 退出码提示（J13：permanent 与 offline 的文案**必须不同**）。 */
export function boardFailureText(kind, code, error) {
  if (kind === 'permanent') {
    return {
      message: '取数被拒（配置问题：本机铁律用 localhost，别用 127.0.0.1 / 别漏 origin 头）',
      detail: `${code}${error ? ' · ' + error : ''}`,
      exitCode: 2,
    };
  }
  return {
    message: '未取到（看板不可达；卡状态列不得当 0 卡或全绿）',
    detail: `${code}${error ? ' · ' + error : ''}`,
    exitCode: 4,
  };
}

/**
 * 只读抽取看板卡状态（**降级不抛错**）。
 * @param {{baseUrl?:string, fetchImpl?:Function, timeoutMs?:number, api?:object}} [opts]
 * @returns {{
 *   available:boolean, tasksTrustworthy:boolean, kind:string, code:string, error:string|null,
 *   reasonText:string|null, exitCodeHint:number, baseUrl:string, revision:number|null,
 *   durationMs:number, asOf:string, tasks:object[], taskIds:string[], archivedIds:Set<string>,
 *   titleById:Map<string,string>, counts:{total:number,live:number,archived:number,byStatus:object}
 * }}
 */
export function extractBoard(opts = {}) {
  const baseUrl = String(opts.baseUrl ?? DEFAULT_BASE_URL);
  const api = opts.api ?? createLedgerApi({ baseUrl, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });

  const fail = (kind, code, error, durationMs, revision = null) => {
    const txt = boardFailureText(kind, code, error);
    return {
      available: false, tasksTrustworthy: false, kind, code, error: error ?? null,
      reasonText: txt.message, detail: txt.detail, exitCodeHint: txt.exitCode,
      baseUrl, url: `${baseUrl}${STATE_PATH}`, revision, durationMs, asOf: new Date().toISOString(),
      tasks: [], taskIds: [], archivedIds: new Set(), titleById: new Map(),
      counts: { total: 0, live: 0, archived: 0, byStatus: {} },
    };
  };

  let st;
  try {
    // Promise.resolve：允许注入同步 stub（单测）而不必包 Promise
    st = Promise.resolve(api.readState());
  } catch (e) {
    // 防御：readState 自身理论上不抛（源码里 catch 了），但"降级不抛错"是判据 ⇒ 这里兜一层
    return fail('offline', 'read-state-threw', `readState 抛出异常：${e?.message ?? e}`, 0);
  }
  return st.then((r) => {
    if (!r?.ok) return fail(r?.kind ?? 'offline', r?.code ?? 'unknown', r?.error ?? null, Number(r?.durationMs ?? 0), r?.revision ?? null);
    const tasks = Array.isArray(r.tasks) ? r.tasks : [];
    const taskIds = []; const archivedIds = new Set(); const titleById = new Map(); const byStatus = {};
    let live = 0;
    for (const t of tasks) {
      const id = String(t?.id ?? '');
      if (!id) continue;
      taskIds.push(id);
      if (typeof t?.title === 'string') titleById.set(id, t.title);
      // ⚠️ 归档判据用**真值判定**（在板卡没有 `archivedAt` 这个键，不是 null —— 方案 E2/O2-1：
      //    写 `'archivedAt' in t` 会把全部在板卡判成"已归档"，表会全空）
      if (t?.archivedAt) archivedIds.add(id); else live += 1;
      const s = String(t?.status ?? '(空)');
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    return {
      available: true, tasksTrustworthy: true, kind: 'ok', code: 'ok', error: null,
      reasonText: null, detail: null, exitCodeHint: 0,
      baseUrl, url: r.url ?? `${baseUrl}${STATE_PATH}`, revision: Number(r.revision ?? 0),
      durationMs: Number(r.durationMs ?? 0), asOf: new Date().toISOString(),
      tasks, taskIds, archivedIds, titleById,
      counts: { total: tasks.length, live, archived: archivedIds.size, byStatus },
    };
  }).catch((e) => fail('offline', 'read-state-threw', `readState 抛出异常：${e?.message ?? e}`, 0));
}

// ---------------------------------------------------------------- 统一入口

/**
 * 两端事实一次抽（看板 + 总纲）。**无论哪端失败都不抛错**（J5-卡口径）。
 * @param {{baseUrl?:string, fetchImpl?:Function, timeoutMs?:number, docPath?:string, now?:number}} [opts]
 */
export async function extractAll(opts = {}) {
  const board = await extractBoard(opts);
  const doc = extractDocTables(opts);
  const gKeys = doc.g.available ? [...doc.g.keys].sort(compareKeys) : [];
  const rKeys = doc.r.available ? [...doc.r.keys].sort(compareKeys) : [];
  return {
    asOf: new Date(opts.now ?? Date.now()).toISOString(),
    board,
    doc,
    availableKeys: {
      g: new Set(gKeys),
      r: new Set(rKeys),
      gList: gKeys,
      rList: rKeys,
    },
    /** 供渲染器/校验器直接喂给 crossCheckRegistry（`--only` 之外一律全量）。 */
    crossCheckContext: {
      availableKeys: { g: gKeys, r: rKeys },
      taskIds: board.available ? board.taskIds : null,
      archivedIds: board.available ? board.archivedIds : null,
      titleById: board.available ? board.titleById : null,
    },
    degraded: !board.available || !(doc.g.available && doc.r.available),
  };
}

export default extractAll;
