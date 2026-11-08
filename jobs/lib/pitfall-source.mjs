// dsh-butler / lib/pitfall-source.mjs —— 坑库「读侧统一口」（A 案 Q3 写侧合一 · 2026-11-05）
//
// 【口径（主人 2026-11-05 10:31「按建议落」，方案 docs\总纲-记忆载体权威表-20261105.md §6 Q3）】
//   权威（真源）  = `docs\坑库\*.md`          —— 人读/人写；机器只读，**绝不自动改写**
//   缓存（派生）  = `~\.dsh\butler-pitfalls.json` —— P4 自动聚类态；pitfall-tick / pitfall-cluster-tick 照旧写它，
//                   但它**不再是权威**（写者不变、只降级读口径）
//
// 三条读侧规则：
//   1. **默认以 md 为准**；json 只用于「聚类态 / 次数 / lastSeen / tools / sessions」这类 md 里没有或不够细的字段
//   2. **缓存坏 / 缺 / 过期 ⇒ fail-open 回落 md**（不许因为缓存坏了就不报坑，也不许崩）；
//      md 自己坏 / 缺 / 过期（生成时间比 json 落后 > STALE_MS）⇒ 反向 fail-open 回落缓存
//   3. **冲突以 md 为准**，冲突条数如实报出（`conflicts.total`，可观测）
//
// 为什么不新增第二套口径：`tools\memory-db-tools\memory-ask.mjs` 的规矩层（L444-478）
//   早已写「butler-pitfalls.json 缓存 … （md 为准）」⇒ 本模块把那句话落成实现，**照它的口径统一**。
//
// 纯读：本模块**零写入**（不 mkdir、不 touch、不写盘）。
import fs from 'node:fs';
import path from 'node:path';

import { COMPONENT_ROOT, dshHome } from '../../src/dsh-butler/lib/paths.mjs';

export const PITFALL_SOURCE_VERSION = '1.0.0';

/** md 生成时间比 json 落后多久算「过期」（过期 ⇒ fail-open 回落缓存，避免 tick 停了还拿旧 md 当真）。 */
export const MD_STALE_MS = 2 * 60 * 60 * 1000;

/** 默认坑库 doc 目录（`<DSH>\docs\坑库`）。 */
export function defaultDocsDir() {
  return path.resolve(COMPONENT_ROOT, '..', '..', 'docs', '坑库');
}

/** 默认缓存路径（`<home>\.dsh\butler-pitfalls.json`）。 */
export function defaultPitfallsFile(home = dshHome()) {
  return path.join(home, 'butler-pitfalls.json');
}

// ───────────────────────── 摘要/key 口径（必须与渲染器逐字对齐） ─────────────────────────

/**
 * 现象摘要 —— **与 `lib\pitfall-render.mjs#pitfallRow` 完全同一算法**：
 *   `(normText).replace(/\|/g,'\\|').replace(/\n/g,' ').slice(0,70)` 然后塞进表格单元格。
 * 这里返回「已转义」形态（与 md 单元格原文一致），比较前用 `unescapeCell` 还原。
 */
export function digestCell(normText) {
  return String(normText ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 70);
}

/** 表格单元格 → 原文字符串：去反引号、把 `\|` 还原成 `|`。 */
export function unescapeCell(cell) {
  return String(cell ?? '').replace(/`/g, '').replace(/\\\|/g, '|').trim();
}

/**
 * 条目 key（md ↔ json 对齐用）= `签名#摘要`。
 * 两侧走同一函数 ⇒ 同一渲染器产出的 md 行与 json 条目必然同 key。
 * 摘要取 digestCell 的前 60 字符（尾部截断边界差异不参与比较）。
 */
export function pitfallKey(sig, normTextOrCell) {
  const s = unescapeCell(sig);
  const d = unescapeCell(normTextOrCell).slice(0, 60);
  return `${s}#${d}`;
}

/** `Error|NO_CODE` → `{ name:'Error', code:'NO_CODE' }`（`FsError|FS_NOT_OBSERVED` 同理） */
export function splitSig(sig) {
  const s = unescapeCell(sig);
  const i = s.indexOf('|');
  if (i < 0) return { name: s, code: '' };
  return { name: s.slice(0, i), code: s.slice(i + 1) };
}

// ───────────────────────── md 解析 ─────────────────────────

const AUTO_BEGIN = '<!-- butler-auto:begin -->';
const AUTO_END = '<!-- butler-auto:end -->';

/** 本地日期 `YYYY-MM-DD` → 当天 00:00 的 epoch ms（解析不了返回 null）。 */
export function dayToMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/** epoch ms → 本地日期 `YYYY-MM-DD`（与 fmtDay 同口径）。 */
export function msToDay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 任意时间表示 → epoch ms。支持 number（ms）、ISO 字符串、`YYYY-MM-DD HH:MM`。
 * ⚠️ 缓存 json 的 `updatedAt` 历史上有两种写法（epoch ms / ISO 字符串）⇒ 两种都得认，
 * 否则「md 是否过期」的判据会静默失效（假绿）。
 */
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 0 ? n : null; }
  const t = Date.parse(s.includes('T') || /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/** 状态列 → 机器态（`renderPitfallRow` 的 st 列的逆）。未知返回 null。 */
export function statusFromCell(cell) {
  const s = String(cell ?? '');
  if (/历史种子/.test(s)) return 'seed';
  if (/疑似已修复/.test(s)) return 'likelyFixed';
  if (/候选/.test(s)) return 'candidate';
  if (/上浮/.test(s)) return 'surfaced';
  if (/记录/.test(s)) return 'recorded';
  return null;
}

/** json 条目 → 机器态（与渲染器的 st 列判定同序）。 */
export function statusFromJson(p) {
  if (!p) return null;
  if (p.source === 'seed') return 'seed';
  if (p.likelyFixed) return 'likelyFixed';
  if (p.stage === 'candidate') return 'candidate';
  if (p.stage === 'surfaced') return 'surfaced';
  return 'recorded';
}

/** 表格行 → 单元格数组（按**未转义的 `|`** 切，与 pitfall-trace 同口径）。 */
function splitRow(line) {
  return line.split(/(?<!\\)\|/).map((s) => s.trim());
}

/**
 * 解析 `docs\坑库\*.md`：
 *   · 自动块（`<!-- butler-auto:begin -->` … `end`）里的表格行 → 会话聚类坑（机器条目）
 *   · 自动块**之外**的 `### C1. 标题 ｜ 日期` → 手写条目（人写的真源，json 里没有）
 * @param {{docsDir?:string}} [opts]
 */
export function parsePitfallMd({ docsDir = defaultDocsDir() } = {}) {
  const out = {
    ok: false, dir: docsDir, files: [], filesExcluded: [], entries: [], auto: [], manual: [],
    generatedAt: null, error: null,
  };
  let all;
  try {
    all = fs.readdirSync(docsDir);
  } catch (e) {
    out.error = `坑库目录不可读：${e.message}`;
    return out;
  }
  // 与 memory-ask 同口径：排除 *.bak*（坑库有 .bak 副本，不排会同一坑报两遍）
  const files = all.filter((f) => f.toLowerCase().endsWith('.md') && !/\.bak/i.test(f)).sort();
  out.files = files;
  out.filesExcluded = all.filter((f) => /\.bak/i.test(f)).sort();

  for (const f of files) {
    const full = path.join(docsDir, f);
    let txt;
    try {
      txt = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      continue;
    }
    const lines = txt.split(/\r?\n/);

    // 自动块边界：渲染器用 indexOf 取**第一个** begin / 其后的 end ⇒ 这里同口径
    const bi = txt.indexOf(AUTO_BEGIN);
    const ei = bi < 0 ? -1 : txt.indexOf(AUTO_END, bi + AUTO_BEGIN.length);
    const autoFromLine = bi < 0 ? -1 : txt.slice(0, bi).split(/\r?\n/).length - 1; // 0-based 行号
    const autoToLine = ei < 0 ? -1 : txt.slice(0, ei).split(/\r?\n/).length - 1;

    // ① 生成时间（自动块头部 `> 主机：… ｜ 生成时间：YYYY-MM-DD HH:MM ｜ …`）
    if (autoFromLine >= 0) {
      for (let i = autoFromLine; i < Math.min(lines.length, autoFromLine + 6); i += 1) {
        const m = /生成时间：(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(lines[i] ?? '');
        if (m) {
          const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
          if (Number.isFinite(t) && (!out.generatedAt || t > out.generatedAt)) out.generatedAt = t;
          break;
        }
      }
    }

    // ② 自动块内表格行
    if (autoFromLine >= 0 && autoToLine > autoFromLine) {
      for (let i = autoFromLine; i <= autoToLine && i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        // 主榜编号 = `1`..`n`；历史种子小节编号 = `S1`..`Sm`（两者都要）
        if (!/^\|\s*[A-Za-z]*\d+\s*\|/.test(line)) continue;
        const c = splitRow(line);
        // ⚠️ 渲染器的 `code()` 不转义竖线 ⇒ 签名列 `name|code` 会把这行切成 **11 段**：
        //   ['', '#', '`name', 'code`', '`现象摘要`', '次数', '会话', 'score', '末次', '状态', '']
        //   （摘要列里的 `|` 是转义过的 `\|`，splitRow 不会切它）
        let sigRaw;
        let rest;
        if (c.length >= 11) {
          sigRaw = `${c[2]}|${c[3]}`;
          rest = c.slice(4);
        } else if (c.length >= 9) {
          sigRaw = c[2];          // 兜底：签名里没有竖线（理论上不出现）
          rest = c.slice(3);
        } else continue;
        const sig = unescapeCell(sigRaw);
        const digest = unescapeCell(rest[0]);
        if (!sig) continue;
        const count = Number(rest[1]);
        const sessionCount = Number(rest[2]);
        const score = Number(rest[3]);
        const lastSeenDay = unescapeCell(rest[4]);
        const status = statusFromCell(rest[5]) ?? 'recorded';
        out.auto.push({
          key: pitfallKey(sig, digest),
          sig, digest,
          count: Number.isFinite(count) ? count : null,
          sessionCount: Number.isFinite(sessionCount) ? sessionCount : null,
          score: Number.isFinite(score) ? score : null,
          lastSeenDay,
          status,
          sourceFile: f, sourceLine: i + 1, origin: 'md-auto',
        });
      }
    }

    // ③ 自动块之外的 `### C1. 标题 ｜ 日期` = 手写条目
    for (let i = 0; i < lines.length; i += 1) {
      if (autoFromLine >= 0 && i >= autoFromLine && (autoToLine < 0 || i <= autoToLine)) continue;
      const line = lines[i] ?? '';
      const m = /^###\s+([A-Za-z]*\d+)\.\s+(.+?)\s*｜/.exec(line);
      if (!m) continue;
      const no = m[1];
      const title = m[2].trim();
      const dayM = /｜\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
      // 错误签名：标题之后到下一个 ### 之间找 `- **错误签名（检索用）**：` 的反引号内容
      let sig = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
        if (/^###\s/.test(lines[j] ?? '')) break;
        const sm = /错误签名[^：]*：(.+)$/.exec(lines[j] ?? '');
        if (sm) { sig = (sm[1].match(/`([^`]+)`/) ?? [])[1] ?? sm[1].trim(); break; }
      }
      out.manual.push({
        key: `manual#${no}#${title.slice(0, 60)}`,
        sig: sig || title,
        digest: title,
        count: null,           // 手写条目没有次数语义（不编数字）
        sessionCount: null,
        score: null,
        lastSeenDay: dayM ? dayM[1] : '—',
        status: 'manual',
        no, title,
        sourceFile: f, sourceLine: i + 1, origin: 'md-manual',
      });
    }
  }

  out.entries = out.auto.concat(out.manual);
  out.ok = out.entries.length > 0 || files.length > 0;
  if (!out.ok && !out.error) out.error = '坑库里没有可解析条目（md 空？）';
  return out;
}

// ───────────────────────── 缓存（json）读取 ─────────────────────────

/**
 * 读缓存 json。**任何异常都不抛**：坏 JSON / 空文件 / 无权限 ⇒ `ok:false` + `reason`。
 * @param {{pitfallsFile?:string}} [opts]
 */
export function readPitfallCache({ pitfallsFile = defaultPitfallsFile() } = {}) {
  const out = { path: pitfallsFile, exists: false, ok: false, reason: null, bytes: 0, mtime: null, updatedAt: null, updatedAtRaw: null, entries: [], error: null };
  let st;
  try {
    st = fs.statSync(pitfallsFile);
  } catch {
    out.reason = '缓存不存在';
    return out;
  }
  out.exists = true;
  out.bytes = st.size;
  out.mtime = st.mtimeMs;
  let raw;
  try {
    raw = fs.readFileSync(pitfallsFile, 'utf8');
  } catch (e) {
    out.reason = `缓存读不出来：${e.message}`;
    return out;
  }
  if (!raw.trim()) {
    out.reason = '缓存是空文件';
    return out;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    out.reason = `缓存不是合法 JSON：${e.message}`;
    return out;
  }
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.pitfalls) ? doc.pitfalls : null;
  if (!list) {
    out.reason = '缓存结构不对（既不是数组也没有 pitfalls[]）';
    return out;
  }
  out.updatedAt = toMs(doc?.updatedAt) ?? toMs(doc?.generatedAt) ?? null;
  out.updatedAtRaw = doc?.updatedAt ?? doc?.generatedAt ?? null;
  out.entries = list.filter((x) => x && typeof x === 'object');
  out.ok = true;
  return out;
}

// ───────────────────────── 合一视图 ─────────────────────────

/**
 * 坑库读侧统一视图（md 为准 + json 补字段 + 冲突计数 + 双向 fail-open）。
 *
 * @param {{docsDir?:string, pitfallsFile?:string, home?:string, now?:number, includeJsonOnly?:boolean}} [opts]
 * @returns {{
 *   source:'md'|'md+json'|'json'|'none', entries:object[], conflicts:object, cache:object, md:object,
 *   notes:string[], failOpen:boolean, generatedAt:number|null, stale:boolean
 * }}
 *   `entries` 每条 = 合并后的坑对象（json 同形 + `_md` 溯源字段）：
 *     `count / lastSeen / status` **以 md 为准**；`id / category / tools / sessions / normText / source` 由缓存补。
 */
export function loadPitfallView({
  docsDir = defaultDocsDir(),
  pitfallsFile = defaultPitfallsFile(),
  now = Date.now(),
  includeJsonOnly = false,
} = {}) {
  const md = parsePitfallMd({ docsDir });
  const cache = readPitfallCache({ pitfallsFile });
  const notes = [];

  const mdGen = md.generatedAt;
  const cacheAt = cache.updatedAt || cache.mtime || null;
  const stale = Boolean(md.ok && mdGen && cacheAt && mdGen < cacheAt - MD_STALE_MS);

  // ── 决策：谁是这次读数的主源 ──
  let source;
  if (md.ok && md.entries.length && stale && cache.ok) {
    source = 'json';
    notes.push(`md 过期（生成时间 ${new Date(mdGen).toISOString().slice(0, 16).replace('T', ' ')} 比缓存落后 > ${MD_STALE_MS / 60000} 分钟）⇒ fail-open 回落缓存`);
  } else if (md.ok && md.entries.length) {
    source = cache.ok ? 'md+json' : 'md';
    if (!cache.ok) notes.push(`缓存不可用（${cache.reason}）⇒ fail-open 回落 md（条目仍照报）`);
  } else if (cache.ok) {
    source = 'json';
    notes.push(`md 不可用（${md.error ?? '无可解析条目'}）⇒ 回落缓存`);
  } else {
    source = 'none';
    notes.push(`md 与缓存都不可用（md：${md.error ?? '空'}；缓存：${cache.reason ?? '未知'}）`);
  }

  // 缓存侧按 key 分组：渲染器把摘要截到 70 字 ⇒ **不同坑可能撞同一个 key**
  // （例：`Error: grep search failed (exit 2): rg: <PATH>: IO error for operation` 的几种尾部全被截掉）。
  // 故匹配时在候选组内**按次数就近一对一消费**，避免 A 坑配到 B 坑的次数。
  const byKeyMulti = new Map();
  if (cache.ok) {
    for (const p of cache.entries) {
      const k = pitfallKey(`${p.name}|${p.code}`, p.normText);
      if (!byKeyMulti.has(k)) byKeyMulti.set(k, []);
      byKeyMulti.get(k).push(p);
    }
  }
  const consumed = new Set();   // 已被 md 条目消费掉的缓存条目（对象引用）
  const takeCache = (e) => {
    const arr = byKeyMulti.get(e.key);
    if (!arr || !arr.length) return null;
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < arr.length; i += 1) {
      const d = e.count == null ? 0 : Math.abs((Number(arr[i].count) || 0) - e.count);
      if (d < best) { best = d; idx = i; }
    }
    const [p] = arr.splice(idx, 1);
    consumed.add(p);
    return p;
  };

  // ── ① md 内部去重 ──
  // 同一个坑会同时出现在**本机**与**对端**的 host 文件里（两机各渲一份；对端那份可能停在几天前）。
  // 口径：同 key 取「次数最大 / 末次最新」那条（并集口径，不丢信息），文件列表全留（可溯源）；重复条数如实报。
  const mdMap = new Map();
  let mdDuplicates = 0;
  for (const e of md.entries) {
    const cur = mdMap.get(e.key);
    if (!cur) { mdMap.set(e.key, { ...e, sourceFiles: [e.sourceFile], sourceLines: [e.sourceLine] }); continue; }
    mdDuplicates += 1;
    cur.sourceFiles.push(e.sourceFile);
    cur.sourceLines.push(e.sourceLine);
    const a = Number(e.count ?? -1);
    const b = Number(cur.count ?? -1);
    const ta = dayToMs(e.lastSeenDay) ?? 0;
    const tb = dayToMs(cur.lastSeenDay) ?? 0;
    if (a > b || (a === b && ta > tb)) {
      Object.assign(cur, {
        count: e.count, sessionCount: e.sessionCount, score: e.score,
        lastSeenDay: e.lastSeenDay, status: e.status, sourceFile: e.sourceFile, sourceLine: e.sourceLine,
      });
    }
  }
  const mdUnique = [...mdMap.values()];

  // ── ② 「滞后」 vs 「真冲突」 ──
  // md 是每 30 分钟一次的渲染快照 ⇒ mdGen < cacheAt 时，两次 tick 之间的正常增量会被判成"差异"。
  // 那不是冲突，是滞后（skew）：照报、但**不算冲突**。只有「md 已经是最新渲染（mdGen >= cacheAt）却仍对不上」
  // 才是真冲突（人工改了 md / 缓存丢过条目 / 合并过）。
  const lagged = Boolean(mdGen && cacheAt && mdGen < cacheAt);
  const bucket = lagged ? 'skew' : 'conflict';
  const mk = () => ({ total: 0, countMismatch: [], lastSeenMismatch: [], statusMismatch: [], mdOnly: [], jsonOnly: [] });
  const conflicts = { conflict: mk(), skew: mk(), manualOnly: [], mdDuplicates, total: 0, lagged, byKey: {} };

  const entries = [];

  const jsonToEntry = (p, extra = {}) => {
    const sessionCount = Number(p?.sessionCount ?? (Array.isArray(p?.sessions) ? p.sessions.length : 0)) || 0;
    return {
      ...p,
      id: p?.id != null ? String(p.id) : null,
      sessionCount,
      count: Number(p?.count) || 0,
      _md: { origin: 'json', sourceFile: null, sourceLine: null, sourceFiles: [], ...extra },
    };
  };

  const mdEntryToObject = (e, j) => {
    const { name, code: codeName } = splitSig(e.sig);
    const mdMs = e.lastSeenDay && e.lastSeenDay !== '—' ? dayToMs(e.lastSeenDay) : null;
    // 次数 / 末次 / 状态：**md 为准**。json 只在「同日」时补精确时刻（不算差异）。
    let lastSeen = mdMs;
    let lastSeenSource = mdMs ? 'md-day' : null;
    if (j && mdMs) {
      const jDay = msToDay(j.lastSeen);
      if (jDay === e.lastSeenDay) {
        lastSeen = Number(j.lastSeen) || mdMs;
        lastSeenSource = 'md-day+cache-ms';
      }
    }
    const base = j ? jsonToEntry(j) : {
      id: null, sessionCount: e.sessionCount ?? 0, sessions: [],
      category: '其他', source: e.origin === 'md-manual' ? 'manual' : 'scan',
    };
    const status = e.status;
    const stage = status === 'candidate' ? 'candidate' : status === 'surfaced' ? 'surfaced' : 'recorded';
    return {
      ...base,
      name: base.name ?? name,
      code: base.code ?? codeName,
      normText: base.normText ?? (e.origin === 'md-manual' ? e.title : e.digest),
      sigKey: base.sigKey ?? e.sig,
      category: base.category ?? '其他',
      count: e.count ?? base.count ?? 0,
      sessionCount: e.sessionCount ?? base.sessionCount ?? 0,
      lastSeen: lastSeen ?? base.lastSeen ?? null,
      likelyFixed: status === 'likelyFixed' ? true : status === 'seed' ? base.likelyFixed === true : false,
      stage,
      _md: {
        origin: e.origin,
        sourceFile: e.sourceFile,
        sourceLine: e.sourceLine,
        sourceFiles: e.sourceFiles ?? [e.sourceFile],
        lastSeenDay: e.lastSeenDay,
        statusCell: status,
        lastSeenSource,
        mdCount: e.count,
        cacheCount: j ? Number(j.count) : null,
        key: e.key,
      },
    };
  };

  if (source === 'md' || source === 'md+json') {
    for (const e of mdUnique) {
      const j = takeCache(e);
      entries.push(mdEntryToObject(e, j));
      if (e.origin === 'md-manual') {
        // 手写条目（人写的真源）：缓存**本来就不该有**它 ⇒ 不是冲突，单列
        conflicts.manualOnly.push({ key: e.key, sig: e.sig, file: e.sourceFile, line: e.sourceLine, title: e.title });
        continue;
      }
      if (j) {
        const slot = (lagged ? conflicts.skew : conflicts.conflict);
        if (e.count != null && Number(j.count) !== e.count) {
          slot.countMismatch.push({ key: e.key, sig: e.sig, md: e.count, cache: Number(j.count), file: e.sourceFile, line: e.sourceLine });
        }
        const jDay = msToDay(j.lastSeen);
        if (e.lastSeenDay && e.lastSeenDay !== '—' && jDay !== '—' && jDay !== e.lastSeenDay) {
          slot.lastSeenMismatch.push({ key: e.key, sig: e.sig, md: e.lastSeenDay, cache: jDay, file: e.sourceFile, line: e.sourceLine });
        }
        const js = statusFromJson(j);
        if (js && js !== e.status) {
          slot.statusMismatch.push({ key: e.key, sig: e.sig, md: e.status, cache: js, file: e.sourceFile, line: e.sourceLine });
        }
      } else if (cache.ok) {
        // md 自动条目、缓存里没有（且缓存是好的）⇒ 缓存丢过条 / 合并过 / 或只是还没渲染到
        (lagged ? conflicts.skew : conflicts.conflict).mdOnly.push({ key: e.key, sig: e.sig, origin: e.origin, file: e.sourceFile, line: e.sourceLine });
      }
    }
    if (cache.ok) {
      for (const p of cache.entries) {
        const k = pitfallKey(`${p.name}|${p.code}`, p.normText);
        if (consumed.has(p)) continue;
        (lagged ? conflicts.skew : conflicts.conflict).jsonOnly.push({
          key: k, sig: `${p.name}|${p.code}`, id: p.id != null ? String(p.id) : null,
          count: Number(p.count) || 0, lastSeen: Number(p.lastSeen) || null,
        });
        if (includeJsonOnly) entries.push(jsonToEntry(p, { origin: 'json-pending' }));
      }
    }
  } else if (source === 'json') {
    for (const p of cache.entries) entries.push(jsonToEntry(p, { origin: 'cache-fallback' }));
  }

  for (const b of [conflicts.conflict, conflicts.skew]) {
    b.total = b.countMismatch.length + b.lastSeenMismatch.length + b.statusMismatch.length + b.mdOnly.length + b.jsonOnly.length;
  }
  const cB = conflicts.conflict;
  conflicts.byKey = {
    countMismatch: cB.countMismatch.length, lastSeenMismatch: cB.lastSeenMismatch.length,
    statusMismatch: cB.statusMismatch.length, mdOnly: cB.mdOnly.length, jsonOnly: cB.jsonOnly.length,
  };
  conflicts.total = cB.total;   // 「冲突」这个词只算**真冲突**（滞后单列在 skew 里）

  if (conflicts.total) {
    notes.push(`md 与缓存**真冲突** ${conflicts.total} 处（次数 ${conflicts.byKey.countMismatch} / 末次 ${conflicts.byKey.lastSeenMismatch} / 状态 ${conflicts.byKey.statusMismatch} / 仅 md ${conflicts.byKey.mdOnly} / 仅缓存 ${conflicts.byKey.jsonOnly}）⇒ **一律以 md 为准**`);
  }
  if (conflicts.skew.total) {
    notes.push(`另有 ${conflicts.skew.total} 处**滞后**（md 是 ${mdGen ? new Date(mdGen).toLocaleString('sv-SE').slice(0, 16) : '?'} 的渲染快照，比缓存旧 ${cacheAt && mdGen ? Math.round((cacheAt - mdGen) / 60000) : '?'} 分钟）⇒ 仍按 md 的数值报，差异可解释、不计冲突`);
  }
  if (conflicts.manualOnly.length) {
    notes.push(`手写条目 ${conflicts.manualOnly.length} 条（人写在 md 里、缓存本来就不该有 ⇒ 不算冲突，但**读侧必须报出来**，这正是 md 为真的地方）`);
  }
  if (mdDuplicates) {
    notes.push(`同一坑在多份 host 文件里重复出现 ${mdDuplicates} 次（本机 + 对端各渲一份）⇒ 按「次数最大/末次最新」去重，文件全留可溯源`);
  }

  return {
    version: PITFALL_SOURCE_VERSION,
    source,
    entries,
    conflicts,
    cache: {
      path: cache.path, exists: cache.exists, ok: cache.ok, reason: cache.reason,
      bytes: cache.bytes, mtime: cache.mtime, updatedAt: cache.updatedAt, updatedAtRaw: cache.updatedAtRaw,
      count: cache.entries.length,
    },
    md: {
      dir: md.dir, ok: md.ok, files: md.files, filesExcluded: md.filesExcluded,
      auto: md.auto.length, manual: md.manual.length, unique: mdUnique.length,
      generatedAt: md.generatedAt, error: md.error,
    },
    notes,
    failOpen: source === 'md' || source === 'json',
    stale,
    generatedAt: mdGen,
    now,
  };
}

/** 一行摘要（给 CLI 打日志 / 报告用）。 */
export function describePitfallView(v) {
  if (!v) return '坑库视图：无';
  const c = v.conflicts.byKey;
  return `坑库视图 源=${v.source} · 条目 ${v.entries.length}（md 去重后 ${v.md.unique}｜自动 ${v.md.auto}/手写 ${v.md.manual}）`
    + ` · 缓存 ${v.cache.ok ? `ok ${v.cache.count} 条` : `不可用(${v.cache.reason})`}`
    + ` · 真冲突 ${v.conflicts.total}（次数${c.countMismatch}/末次${c.lastSeenMismatch}/状态${c.statusMismatch}/仅md${c.mdOnly}/仅缓存${c.jsonOnly}）`
    + ` · 滞后 ${v.conflicts.skew.total} · 手写 ${v.conflicts.manualOnly.length}`;
}
