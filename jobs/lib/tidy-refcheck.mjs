// dsh-butler / lib/tidy-refcheck.mjs —— P8 会收纳：**引用检查**（搬移/删除的判定闸）
//
// 方案：docs\管家v2.5-P8会收纳设计-20260909.md
//   §5.1 引用检查（8 条检查位置）· §15.2 P-7（闸门顺序翻转：**24h 活跃保护为第一道、引用检查降为第二道**）
//
// 一句话：**搬任何 _tmp 项之前，先问"还有谁在指这个名字"** —— 命中就报告（不静默）；**是否因此拦下，看规则表的 `blocking` 旗子**。
//
// ── 拦截面现状（2026-10-15 主人拍板「**_tmp 放宽**」）────────────────────────────
//   拦（blocking:true）= ① persona · ⑤ startup · ⑥ desktop · ⑧ secrets
//   另报·不拦（blocking:false）= ② skills · ③ tools · ④ docs · ⑦ prefix（改名专用）
//   放宽理由：**"某处文本提到过这个名字" ≠ "运行时还在按这个名字取文件"** —— 历史技能/脚本/文档里
//     写过的 `_tmp` 路径多为当时的取证记录/一次性读，搬走不产生新故障；命中仍逐条进报告
//     （`results[].advisoryHits` + `summary.advisoryByRule`），人要复核随时能看见。
//   ⚠️ **与引用判据无关的三道保护一字未动**：运行态硬清单（`migrate-backup-*` / `.lock` / `.tmp` / `.err` / `.out`
//     —— `lib/tidy-move.mjs#runtimeHardList`）· 24h 活跃保护（`fresh-mtime`）· 桌面与启动链仍拦。
//
// ── 闸门顺序（P-7 拍板后的现行口径）─────────────────────────────────────────────
//   第一道 = 24h 活跃保护（lib/tidy-move.mjs 的 `activeProtection()`，mtime 太新 ⇒ 直接出局）
//   第二道 = **本模块**（引用检查）—— 只对"已经过第一道"的候选跑，省一半 I/O。
//   ⚠️ 顺序不可颠倒：活跃保护是"事实判断"（文件正在被用），引用检查是"静态文本判断"（可能漏）。
//
// ── 已知盲窗（设计 §15.2 P-7 明文，**不构成本模块的判据**）──────────────────────
//   本模块只看**文本引用**。以下三类**不在**判据内，属已知盲窗：
//     · **会话日志**（`~/.dsh/sessions/**/session.v3.jsonl.zstd`）—— 历史对话里提到过某个 `_tmp` 路径；
//     · **看板卡**（`/api/task-board/state` 的 description / prompt）—— 卡面写着的 `_tmp` 路径；
//     · **非文本引用**（图片/二进制里嵌的路径、运行期内存里的路径）。
//   这三类由 `scanRuntimeRefs()` **只读采集**（advisory，不拦），用于：
//     ① 开工前的「漏报 spike」（量化盲窗有多大）；
//     ② observe 档报告里如实标注"本候选在会话/看板里出现过"。
//   ⇒ 所以本模块的正确期望不是"零漏报"，而是"文本面零漏报 + 盲窗大小有数字"。
//
// ── 性能口径 ───────────────────────────────────────────────────────────────
//   一次扫描 = **单遍**读语料（本机 docs+tools ≈ 2654 文件 / 74MB），对每个语料文件读一次内容、
//   对全部候选名做 `String.includes`。实测 HOST_A 全库 ≈ 2~4s，足够 6h 一轮的采集器用。
//   不建持久索引（索引会过期 → 引用检查一旦过期就是**漏报**，比慢更坏）。
import fs from 'node:fs';
import { workspaceRoot } from './ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { desktopEntryDirs } from '../../src/dsh-butler/lib/desktop-entry.mjs';

// 【版本】0.2.0 → **0.2.2**（2026-10-15 一次性补登两轮判据变更）：
//   0.2.1 = ④ docs 放宽为「另报·不拦」（2026-10-13 主人拍板；当时未升版，遗留成待拍板项）；
//   0.2.2 = ② skills / ③ tools / ① persona 三面并入同一口径（2026-10-15 主人拍板「_tmp 放宽」）。
//   为什么必须升：判据变了而版本不动 ⇒ 以后拿两份 `--dry-run --json` 报告对比时，只能靠 sha/mtime 认版本。
export const REFCHECK_VERSION = '0.2.2';
export const DEFAULT_DSH_ROOT_RC = workspaceRoot();

/** 语料文件上限（防御"某天 docs 里进了个大二进制"把一轮扫描拖爆）。 */
export const CORPUS_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** 文本判定：前 8KB 出现 NUL ⇒ 当二进制跳过。 */
const BINARY_PROBE_BYTES = 8192;
/** 候选名最短长度（太短的名字 = 到处都命中，纯噪声；不足此长度按 `too-short` 跳过 = 保守不搬）。 */
export const MIN_NAME_LEN = 4;
/** 单个候选最多展开多少个"内层名字"（目录候选 = 目录名 + 内层文件名/目录名）。 */
export const MAX_NAMES_PER_CANDIDATE = 2000;

/**
 * §5.1 的 8 条检查位置（**判据本体**，改这里 = 改判据）。
 *   appliesTo : 该规则约束哪些动作（move = 搬移 / delete = 删除 / rename = 改名）
 *   blocking  : 命中是否拦（true = 拦；false = **另报·不拦**）。现行不拦 = ② skills · ③ tools · ④ docs · ⑦ prefix
 *               （④ docs = 2026-10-13 主人拍板；②③① = 2026-10-15 主人拍板「_tmp 放宽」并入同一口径
 *                · 见 REFCHECK_RULES 各行 why 与本文件头「拦截面现状」）
 *   why       : 命中含义（写进报告，便于人复核）
 */
export const REFCHECK_RULES = Object.freeze([
  { id: 'persona', order: 1, appliesTo: ['move', 'delete'], blocking: false, why: 'persona 文本引用 → 另报·不拦（2026-10-15 主人拍板「_tmp 放宽」· 与 ④ docs 同口径；命中仍进 advisoryByRule 报告）' },
  { id: 'skills', order: 2, appliesTo: ['move', 'delete'], blocking: false, why: '技能文档引用 → 另报·不拦（2026-10-15 主人拍板「_tmp 放宽」· 与 ④ docs 同口径；命中仍进 advisoryByRule 报告）' },
  { id: 'tools', order: 3, appliesTo: ['move', 'delete'], blocking: false, why: '脚本文本引用 → 另报·不拦（2026-10-15 主人拍板「_tmp 放宽」· 与 ④ docs 同口径；命中仍进 advisoryByRule 报告，硬编码依赖由人复核）' },
  { id: 'docs', order: 4, appliesTo: ['move', 'delete'], blocking: false, why: '文档引用 → 只报告不拦（2026-10-13 主人拍板：历史文档里写过的 _tmp 路径指空无害 · 运行时没有任何程序读文档取路径；命中仍进 advisoryByRule 报告）' },
  { id: 'startup', order: 5, appliesTo: ['move', 'delete'], blocking: true, why: '启动期依赖 → 最高危' },
  { id: 'desktop', order: 6, appliesTo: ['move', 'delete'], blocking: true, why: '桌面恢复脚本硬依赖该备份目录' },
  { id: 'prefix', order: 7, appliesTo: ['rename'], blocking: false, why: '被生产脚本用「前缀选取」写法取用 → **改名**即静默失效（搬移不受影响）' },
  { id: 'secrets', order: 8, appliesTo: ['move', 'delete'], blocking: true, why: '凭证/密钥类 → 永不搬移、不得进同步仓' },
]);

/** ⑦ 前缀选取写法的识别（改名专属）：`_archive\<前缀>*` / glob 取最新。 */
export const PREFIX_SELECT_PATTERNS = Object.freeze([
  /_archive[\\/][^\s'"`)]*\*/,
  /Get-ChildItem[^\n]*_archive[^\n]*\*/,
  /readdirSync\([^)]*_archive[^)]*\)/,
]);

/** ⑧ 凭证/密钥类文件名判据（**任何动作都不得搬/删**，与引用无关）。 */
export const SECRET_NAME_PATTERN = /^(\.credentials.*|.*\.(key|pem|pfx|p12|keystore|jks)|id_rsa.*|id_ed25519.*|.*\.credentials\.yaml)$/i;

/**
 * 【2026-10-10 · B4 卡（冲刺600·补收纳）】§5.1 的 8 类位置 = 6 类**内容语料** + 2 类**登记语料**。
 *
 * 为什么要有这张表：B4 前的实测读数是
 *   `corpus.byRule = {persona, skills, tools, docs, startup, desktop}`（6 类）
 *   —— ⑦`prefix` 以 `put('prefix', [])` 空登记（不进 byRule）、⑧`secrets` 根本没有语料类
 *   ⇒ 状态文件里「8 类位置」读出来只有 6 类，看不出后两类**到底有没有被纳入检查**。
 *
 * 那两类为何**不读内容**（noScan）：
 *   · `prefix`：判据来自 tools 脚本内容（`matchPrefixSelect()` 按行找 `_archive\<前缀>*`），
 *     语料就是 ③ tools ——**再登记一份是为了让"该类存在"可读**，不是再扫一遍。
 *   · `secrets`：凭证/密钥文件**内容一律不进语料**（读了会把密钥值/邻行写进 excerpt，
 *     而状态文件随仓1 同步 = 凭据外泄面）⇒ 只登记**文件名清单**，判定仍走名字（`SECRET_NAME_PATTERN`）。
 */
export const CORPUS_NO_SCAN_RULES = Object.freeze(['prefix', 'secrets']);
/** §5.1 的 8 类位置 id（**代码与文档共用的唯一清单**；单测据此断言"铺满"）。 */
export const CORPUS_RULE_IDS = Object.freeze([...REFCHECK_RULES.map((r) => r.id)]);

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.yml', '.yaml', '.mjs', '.js', '.cjs', '.ts',
  '.ps1', '.psm1', '.cmd', '.bat', '.sh', '.py', '.toml', '.ini', '.cfg', '.log', '.csv',
]);

// ─────────────────────────────────────────────────────────── 语料收集

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 递归列文件（不穿透 reparse point —— 与 lib/tidy-walk.mjs 同一条铁律）。 */
function listFiles(root, { exts = null, maxFiles = 20000, filter = null } = {}) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;                       // junction / symlink：不进（§5.4）
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      if (exts && !exts.has(path.extname(e.name).toLowerCase())) continue;
      if (filter && !filter(full, e.name)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * 收集一次扫描要读的**语料文件清单**（去重后按规则归属；同一文件可属多条规则）。
 * @param {{dshRoot?:string, home?:string, desktopDirs?:string[]}} [opts]
 * @returns {{files:string[], byRule:Record<string,string[]>, noScan:string[], roots:Record<string,string[]>, errors:string[]}}
 */
export function collectCorpus(opts = {}) {
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT_RC;
  const home = opts.home ?? dshHome();
  const desktopDirs = opts.desktopDirs ?? desktopEntryDirs();
  const byRule = {};
  const roots = { dshRoot, home, desktopDirs };
  const errors = [];

  const put = (rule, files) => { if (files.length) byRule[rule] = files; };
  const safe = (fn) => { try { return fn(); } catch (e) { errors.push(String(e?.message ?? e)); return []; } };

  // ① persona：`.agent-presets\<preset>\agent.cordis.yml`（**注意是两级**：preset 目录 + yml）
  put('persona', safe(() => listFiles(path.join(home, '.agent-presets'), { exts: new Set(['.yml', '.yaml']) })));
  // ② 技能：SKILL.md + 技能自带脚本/配置
  put('skills', safe(() => listFiles(path.join(home, 'skills'), { exts: TEXT_EXTS })));
  // ③ 工具脚本
  put('tools', safe(() => listFiles(path.join(dshRoot, 'tools'), { exts: TEXT_EXTS })));
  // ④ 文档
  put('docs', safe(() => listFiles(path.join(dshRoot, 'docs'), { exts: new Set(['.md', '.markdown']) })));
  // ⑤ 启动链：DSH 根**直属**文件（dsh-* / guard* / repair* 等）+ 根 .md
  put('startup', safe(() => fs.readdirSync(dshRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && TEXT_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dshRoot, e.name))));
  // ⑥ 桌面恢复入口（只按文件名模式匹配 `^restore-|^rollback-` —— §5.5 铁律：其余不读不统计）
  put('desktop', safe(() => {
    const out = [];
    for (const d of desktopDirs) {
      for (const f of listFiles(d, { filter: (_full, name) => /^(restore-|rollback-)/i.test(name), maxFiles: 200 })) out.push(f);
    }
    return out;
  }));
  // ⑦ 前缀选取：判据来自 ③ 的脚本内容（此处只登记"哪些文件参与"，命中判定在 scanNames 里按行做）
  //   【2026-10-10 B4】由 `put('prefix', [])`（空登记 = 不进 byRule）改为**显式登记 tools 语料**：
  //   8 类位置必须每类都有独立读数，否则状态文件里读不出"这类到底纳没纳进来"。
  //   ⚠️ 同一批文件对象复用（不是复制列表），且按 CORPUS_NO_SCAN_RULES 排除内容扫描 —— 不重复扫盘。
  put('prefix', [...(byRule.tools ?? [])]);
  // ⑧ 凭证类：**只登记文件名**（`~/.dsh` 顶层 + tools 树；上限 200），内容一律不读（见 CORPUS_NO_SCAN_RULES 注释）。
  put('secrets', safe(() => {
    const out = [];
    try {
      for (const e of fs.readdirSync(home, { withFileTypes: true })) {
        if (e.isFile() && SECRET_NAME_PATTERN.test(e.name)) out.push(path.join(home, e.name));
      }
    } catch { /* home 读不到：不是致命（下面 tools 仍扫） */ }
    out.push(...listFiles(path.join(dshRoot, 'tools'), {
      filter: (_f, n) => SECRET_NAME_PATTERN.test(n), maxFiles: 200,
    }));
    return [...new Set(out)];
  }));

  // 内容扫描语料 = 全部 byRule **去掉 noScan 类**（prefix/secrets 只登记不读）。
  const noScan = new Set(CORPUS_NO_SCAN_RULES);
  const all = new Set();
  for (const [rule, list] of Object.entries(byRule)) {
    if (noScan.has(rule)) continue;
    for (const f of list) all.add(f);
  }
  return { files: [...all], byRule, noScan: [...CORPUS_NO_SCAN_RULES], roots, errors };
}

// ─────────────────────────────────────────────────────────── 名字展开

/**
 * 把一个 `_tmp` 顶层候选展开成"要在语料里找的名字集合"。
 *   文件 → [文件名]；目录 → [目录名] + 内层（最多 MAX_NAMES_PER_CANDIDATE 个）文件名/目录名。
 * 为什么目录要展开内层：搬走一个目录 = 内层全部文件一起搬 ⇒ 任何一个内层名被引用都会指空。
 * @param {string} absPath 候选的绝对路径
 * @param {{max?:number}} [opts]
 */
export function expandNames(absPath, opts = {}) {
  const max = opts.max ?? MAX_NAMES_PER_CANDIDATE;
  const names = new Set();
  let truncated = false;
  const base = path.basename(absPath);
  const st = (() => { try { return fs.lstatSync(absPath); } catch { return null; } })();
  if (!st) return { names: [base], truncated: false, kind: 'missing' };
  if (st.isSymbolicLink()) return { names: [base], truncated: false, kind: 'link' };
  names.add(base);
  if (!st.isDirectory()) return { names: [...names], truncated: false, kind: 'file' };

  const walk = (dir, depth) => {
    if (depth > 4 || names.size >= max) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (names.size >= max) { truncated = true; return; }
      names.add(e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(absPath, 1);
  return { names: [...names], truncated, kind: 'dir' };
}

// ─────────────────────────────────────────────────────────── 单遍扫描

function lineOf(text, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * 行号索引（**一次 O(n) 建表 + 二分查**）。
 * 为什么不能逐次 `lineOf(text, idx)`：那个是 O(idx)，而运行态扫描里每个大文本可能有几千次命中
 * ⇒ 实测把 59MB 的扫描拖成 140s（2026-09-28 spike 现场）。建一次表后单次查询是 O(log n)。
 */
export function buildLineIndex(text) {
  const pos = [];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) pos.push(i);
  return pos;
}

/** 用 buildLineIndex() 的产物查行号（1-based）。 */
export function lineAtIndex(pos, idx) {
  let lo = 0, hi = pos.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pos[mid] < idx) lo = mid + 1; else hi = mid; }
  return lo + 1;
}

/**
 * 单遍扫描：读每个语料文件一次，对全部候选名做匹配。
 *
 * ⚠️ **实现口径（2026-09-28 spike 现场修正）**：**不能用「逐个名字 `text.indexOf(name)`」** ——
 * 那是 O(名字数 × 文本长度)。本机实测：255 个候选展开成上千个名字 × 5178 个语料文件 ≈ 60~100s，
 * 一轮观察档慢到不可用。改为**一条 alternation 正则扫一遍**（每个文件只扫 1 次，命中集合完全等价，
 * 名字里的正则元字符先转义）。行号用 `buildLineIndex()` 一次建表 + 二分，**不**逐次 O(idx) 数换行。
 * @param {{names:string[], corpus:{files:string[], byRule:Record<string,string[]>}}} input
 * @param {{perNameHitCap?:number, maxFileBytes?:number}} [opts]
 * @returns {{hits:Record<string,Array<{rule:string,file:string,line:number,excerpt:string}>>,
 *            scanned:{files:number, bytes:number, skippedBinary:number, skippedBig:number, readErrors:number}, elapsedMs:number}}
 */
export function scanNames(input, opts = {}) {
  const t0 = Date.now();
  const perNameCap = opts.perNameHitCap ?? 6;
  const maxBytes = opts.maxFileBytes ?? CORPUS_MAX_FILE_BYTES;
  const names = (input.names ?? []).filter((n) => typeof n === 'string' && n.length >= MIN_NAME_LEN);
  const hits = {};
  for (const n of names) hits[n] = [];
  const ruleOf = new Map();   // file → Set(rule)
  for (const [rule, files] of Object.entries(input.corpus?.byRule ?? {})) {
    for (const f of files) {
      if (!ruleOf.has(f)) ruleOf.set(f, new Set());
      ruleOf.get(f).add(rule);
    }
  }
  const scanned = { files: 0, bytes: 0, skippedBinary: 0, skippedBig: 0, readErrors: 0 };
  const pending = new Set(names);
  if (!names.length) return { hits, scanned, elapsedMs: Date.now() - t0 };
  const namesRe = buildNamesRe(names);
  const CAP_PER_FILE = 50000;

  for (const file of input.corpus?.files ?? []) {
    if (pending.size === 0) break;
    let st;
    try { st = fs.statSync(file); } catch { scanned.readErrors++; continue; }
    if (st.size > maxBytes) { scanned.skippedBig++; continue; }
    let buf;
    try { buf = fs.readFileSync(file); } catch { scanned.readErrors++; continue; }
    if (isProbablyBinary(buf)) { scanned.skippedBinary++; continue; }
    const text = buf.toString('utf8');
    scanned.files++;
    scanned.bytes += buf.length;
    const rules = [...(ruleOf.get(file) ?? ['corpus'])];
    namesRe.lastIndex = 0;
    let m, n = 0;
    let nlIdx = null;
    while ((m = namesRe.exec(text)) !== null) {
      const name = m[0];
      const bucket = hits[name];
      if (bucket && bucket.length < perNameCap) {
        if (nlIdx === null) nlIdx = buildLineIndex(text);
        const from = Math.max(0, m.index - 40);
        bucket.push({
          rule: rules[0], rules,
          file,
          line: lineAtIndex(nlIdx, m.index),
          excerpt: text.slice(from, m.index + name.length + 40).replace(/\s+/g, ' ').trim(),
        });
        if (bucket.length >= perNameCap) pending.delete(name);
      }
      if (++n >= CAP_PER_FILE) break;
      if (m.index === namesRe.lastIndex) namesRe.lastIndex++;
    }
  }
  return { hits, scanned, elapsedMs: Date.now() - t0 };
}

/** 名字集合 → 一条 alternation 正则（长名字优先，先转义元字符）。 */
export function buildNamesRe(names) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp([...names].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g');
}

// ─────────────────────────────────────────────────────────── 判定

/**
 * ⑦ 前缀选取（改名专属）：候选名是否被某个脚本当"前缀"用来 glob。
 * 判据 = 在 tools 语料里出现 `_archive\<名字>*` 或 `_archive` + 名字 + 通配 的同名共现。
 */
export function matchPrefixSelect(name, toolsFiles, opts = {}) {
  const out = [];
  for (const f of toolsFiles) {
    let text;
    try {
      const st = fs.statSync(f);
      if (st.size > (opts.maxFileBytes ?? CORPUS_MAX_FILE_BYTES)) continue;
      text = fs.readFileSync(f, 'utf8');
    } catch { continue; }
    if (!text.includes(name)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.includes(name)) continue;
      if (!/_archive|Get-ChildItem|readdirSync|glob/i.test(l)) continue;
      if (PREFIX_SELECT_PATTERNS.some((re) => re.test(l)) && /\*|glob|sort|Latest/i.test(l)) {
        out.push({ rule: 'prefix', file: f, line: i + 1, excerpt: l.trim().slice(0, 200) });
      }
    }
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * 引用检查主入口（**纯判据，不碰磁盘以外的任何东西**）。
 * @param {Array<{path:string, relName?:string, sizeBytes?:number}>} candidates
 * @param {{dshRoot?:string, home?:string, action?:'move'|'delete'|'rename', corpus?:object,
 *          perNameHitCap?:number, desktopDirs?:string[]}} [opts]
 * @returns {{ok:boolean, action:string, at:string, corpus:{files:number, byRule:Record<string,number>, roots:object},
 *            scanned:object, elapsedMs:number,
 *            results:Array<{path:string, relName:string, kind:string, names:number, truncated:boolean,
 *                           verdict:'allow'|'block', blockedBy:string[], hits:Array, advisoryHits:Array, prefixHits:Array,
 *                           notes:string[]}>,
 *            summary:{allow:number, block:number, byRule:Record<string,number>, advisoryByRule:Record<string,number>}}}
 */
export function checkReferences(candidates, opts = {}) {
  const t0 = Date.now();
  const action = opts.action ?? 'move';
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT_RC;
  const home = opts.home ?? dshHome();
  const corpus = opts.corpus ?? collectCorpus({ dshRoot, home, desktopDirs: opts.desktopDirs });

  // 展开全部候选的名字（去重后统一扫一遍，避免重复 I/O）
  const perCand = [];
  const allNames = new Set();
  for (const c of candidates ?? []) {
    const abs = path.isAbsolute(c.path) ? c.path : path.join(dshRoot, '_tmp', c.path);
    const rel = c.relName ?? path.basename(abs);
    const ex = expandNames(abs);
    perCand.push({ abs, rel, ...ex, src: c });
    for (const n of ex.names) if (n.length >= MIN_NAME_LEN) allNames.add(n);
  }

  const scan = allNames.size
    ? scanNames({ names: [...allNames], corpus }, { perNameHitCap: opts.perNameHitCap })
    : { hits: {}, scanned: { files: 0, bytes: 0, skippedBinary: 0, skippedBig: 0, readErrors: 0 }, elapsedMs: 0 };

  const results = [];
  const byRule = {};
  const advisoryByRule = {};   // 【2026-10-13 起】blocking:false 规则的命中计数（**只报告，不进 verdict**；现 = skills/tools/docs/prefix）
  let allow = 0, block = 0;
  const toolsFiles = corpus.byRule?.tools ?? [];

  for (const c of perCand) {
    const notes = [];
    const blockedBy = new Set();
    const hitRows = [];
    const advisoryRows = [];   // 【2026-10-13 起】不拦但仍报告的命中（现 = ② skills / ③ tools / ④ docs）
    for (const n of c.names) {
      const rows = scan.hits[n] ?? [];
      for (const h of rows) {
        for (const r of (h.rules ?? [h.rule])) {
          const rule = REFCHECK_RULES.find((x) => x.id === r);
          if (!rule || !rule.appliesTo.includes(action)) continue;
          if (!rule.blocking) {
            // ⚠️ 2026-10-13 修（卡「愿景核查-V1-P8-refcheck-docs」）：`blocking:false` 的既定语义是
            //   「**只报告**不拦」（见本文件规则表头注 + ⑦ prefix 的既有做法），但这条支路原先直接
            //   `continue` 丢命中 ⇒ 非拦规则的命中**既不拦也不报**，与自己的口径矛盾（④ docs 改 false 后，
            //   报告里就再也看不见「哪份文档提过这个名字」；2026-10-15 ② skills / ③ tools / ① persona 并入同一
            //   口径 ⇒ 同样走这条桶）。现改为落 advisory 桶：只计进
            //   `results[].advisoryHits` / `summary.advisoryByRule`，**不参与 verdict**（blockedBy 一行不加）。
            advisoryByRule[r] = (advisoryByRule[r] ?? 0) + 1;
            advisoryRows.push({ name: n, rule: r, file: h.file, line: h.line, excerpt: h.excerpt });
            continue;
          }
          blockedBy.add(r);
          byRule[r] = (byRule[r] ?? 0) + 1;
          hitRows.push({ name: n, rule: r, file: h.file, line: h.line, excerpt: h.excerpt });
        }
      }
    }
    // ⑦ 前缀选取（只在 rename 动作里参与判定；move 时仅作提示）
    let prefixHits = [];
    if (action === 'rename') {
      prefixHits = matchPrefixSelect(c.rel, toolsFiles);
      if (prefixHits.length) { blockedBy.add('prefix'); byRule.prefix = (byRule.prefix ?? 0) + 1; }
    } else if (c.src?.withPrefixHint) {
      prefixHits = matchPrefixSelect(c.rel, toolsFiles);
    }
    // ⑧ 凭证类：名字本身即判据（与引用无关）
    if (SECRET_NAME_PATTERN.test(c.rel)) {
      blockedBy.add('secrets');
      byRule.secrets = (byRule.secrets ?? 0) + 1;
      notes.push('文件名命中凭证/密钥模式 ⇒ 任何动作都不得自动执行');
    }
    if (c.names.length <= 1 && !c.names[0].includes('.') && c.kind !== 'dir') notes.push('可疑候选：既非目录也无扩展名');
    if (c.truncated) notes.push(`内层名字超过 ${MAX_NAMES_PER_CANDIDATE} 个 ⇒ 只检查了前若干（保守起见按已检查结果判定）`);

    const verdict = blockedBy.size ? 'block' : 'allow';
    if (verdict === 'allow') allow++; else block++;
    results.push({
      path: c.abs, relName: c.rel, kind: c.kind,
      names: c.names.length, truncated: c.truncated,
      verdict, blockedBy: [...blockedBy], hits: hitRows.slice(0, 12), advisoryHits: advisoryRows.slice(0, 12), prefixHits,
      notes,
    });
  }

  return {
    ok: true,
    action,
    at: new Date().toISOString(),
    corpus: { files: corpus.files.length, byRule: Object.fromEntries(Object.entries(corpus.byRule).map(([k, v]) => [k, v.length])), noScan: corpus.noScan ?? [...CORPUS_NO_SCAN_RULES], roots: corpus.roots, errors: corpus.errors },
    scanned: scan.scanned,
    elapsedMs: Date.now() - t0,
    results,
    summary: { allow, block, byRule, advisoryByRule },
  };
}

/** 一行摘要（面板 / 日报 / CLI 用）。 */
export function describeRefCheck(rep) {
  const ruleText = Object.entries(rep.summary.byRule).map(([k, v]) => `${k}=${v}`).join(' ');
  const advText = Object.entries(rep.summary.advisoryByRule ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  return `引用检查（${rep.action}）：放行 ${rep.summary.allow} / 拦截 ${rep.summary.block}`
    + `${ruleText ? `（拦因：${ruleText}）` : ''}`
    + `${advText ? `（另报·不拦：${advText}）` : ''}`
    + ` · 语料 ${rep.corpus.files} 文件 · ${rep.elapsedMs}ms`;
}

// ─────────────────────────────────────────────────────────── 运行态引用（**盲窗采集，advisory**）

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 多帧 zstd 拼接解码（会话文件是 append-only 的多帧；只解第一帧会漏掉后面全部内容）。 */
export function decodeZstdFrames(buf) {
  const starts = [];
  let i = 0;
  while (i >= 0 && i < buf.length) {
    const j = buf.indexOf(ZSTD_MAGIC, i);
    if (j < 0) break;
    starts.push(j);
    i = j + 4;
  }
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try { parts.push(zlib.zstdDecompressSync(seg)); } catch { /* 截断帧：跳过 */ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: starts.length, framesOk: parts.length };
}

/** 会话日志候选（近 N 天修改过的，避免全库解码）。 */
export function listSessionFiles(opts = {}) {
  const home = opts.home ?? dshHome();
  const withinMs = opts.withinMs ?? 14 * 24 * 3600_000;
  const maxFiles = opts.maxFiles ?? 200;
  const now = opts.now ?? Date.now();
  const roots = [path.join(home, 'sessions')];
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.length >= maxFiles) return;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.jsonl.zstd')) continue;
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (now - st.mtimeMs > withinMs) continue;
        out.push({ file: full, mtimeMs: st.mtimeMs, bytes: st.size });
      }
    };
    walk(root);
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 一次命中是不是「**路径式引用**」（= 前面紧跟 `_tmp\\` / `_tmp/` / `.../_tmp` 的路径写法）。
 *
 * 为什么必须分这一刀（2026-09-28 spike 实测教训）：
 *   会话日志里出现某个 `_tmp` 文件名的**绝大来源是"有人列过目录"**（`ls _tmp` 的输出被存进会话），
 *   那种命中**不代表这个文件还在被用** —— 只要任何一个会话 `ls` 过 `_tmp`，全部名字都会"命中"。
 *   实测：本机 68 个会话里有 1 个列过目录 ⇒ 120 个候选中 100% 命中，盲窗数字变成纯噪声。
 *   ⇒ 口径修正：`bare`（裸出现）只作**弱信号**（报告里给数字、给证据），`qualified`（路径式）才算**强信号**。
 *   两者都仍是 advisory（不拦），因为设计档 §15.2 P-7 已把运行态整体列为**已知盲窗**。
 */
export function classifyRuntimeHit(text, idx, name) {
  const before = text.slice(Math.max(0, idx - 24), idx);
  return /_tmp[\\/][^\\/]*$|_tmp$/.test(before) ? 'qualified' : 'bare';
}

/**
 * 运行态引用采集（**只读、advisory、不参与拦**）—— P-7 的"漏报 spike"与 observe 报告的盲窗证据。
 *   来源 A：会话日志（近 `withinMs`，多帧解码，按 `maxBytes` 总量封顶）
 *   来源 B：看板卡 description / prompt（走 localhost Host API；不可达 ⇒ 记 unavailable，不抛）
 *
 * 命中分强弱：`qualified`（路径式 `_tmp\<名字>`）/ `bare`（只是出现过，多半来自"有人列过目录"）。
 * 报告里两个数都要给 —— 只有 `qualified` 能支撑"这个文件还在被用"的结论。
 * @param {{names:string[], home?:string, boardUrl?:string, withinMs?:number, maxBytes?:number, now?:number, fetchImpl?:Function}} opts
 */
export async function scanRuntimeRefs(opts = {}) {
  const names = (opts.names ?? []).filter((n) => typeof n === 'string' && n.length >= MIN_NAME_LEN);
  const found = {};   // name → [{source, ref, line?}]
  const out = { names: names.length, sessions: { scanned: 0, bytes: 0, frames: 0, hitNames: 0, hitNameSet: new Set(), qualifiedNames: 0, errors: [] }, board: { ok: false, cards: 0, hitNames: 0, hitNameSet: new Set(), qualifiedNames: 0, error: null }, found, elapsedMs: 0 };
  const t0 = Date.now();
  if (!names.length) { out.elapsedMs = Date.now() - t0; return out; }
  const pending = new Set(names);
  const qualified = new Set();
  const record = (name, source, ref, line, strength) => {
    if (strength === 'qualified') qualified.add(name);
    const rows = (found[name] ??= []);
    if (rows.length >= 5) return;                    // 单名最多留 5 条证据
    rows.push({ source, ref, line, strength });
  };

  // ── 来源 A：会话日志
  //  ⚠️ **性能口径（2026-09-28 spike 实测）**：逐个名字 `text.includes(name)` 是 O(名字数 × 文本长度)
  //  —— 120 名 × 68 会话 × ~10MB 文本 = 81GB 扫描量，实测 135s。改为**一条 alternation 正则扫一遍**
  //  ⇒ 每个文本只扫 1 次（同样的命中集合，快约 100×）。名字里的正则元字符必须转义。
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namesRe = new RegExp([...names].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g');
  const PER_FILE_MATCH_CAP = 20000;
  const maxBytes = opts.maxBytes ?? 120 * 1024 * 1024;
  for (const s of listSessionFiles({ home: opts.home, withinMs: opts.withinMs, now: opts.now })) {
    if (out.sessions.bytes > maxBytes) { out.sessions.errors.push(`字节上限 ${maxBytes} 到达，提前停止`); break; }
    let buf;
    try { buf = fs.readFileSync(s.file); } catch (e) { out.sessions.errors.push(`${path.basename(path.dirname(s.file))}: ${e?.message ?? e}`); continue; }
    out.sessions.scanned++;
    out.sessions.bytes += buf.length;
    let text;
    if (path.basename(s.file).endsWith('.zstd')) {
      const d = decodeZstdFrames(buf);
      text = d.text; out.sessions.frames += d.frames;
    } else text = buf.toString('utf8');
    if (!text) continue;
    const sid = path.basename(path.dirname(s.file));
    namesRe.lastIndex = 0;
    let m, n = 0;
    const hitHere = new Set();
    let nlIdx = null;                              // 行号索引：**第一次真要记证据时**才建（多数文件零命中）
    while ((m = namesRe.exec(text)) !== null) {
      const name = m[0];
      hitHere.add(name);
      const rows = found[name];
      if (rows === undefined || rows.length < 5) {
        if (nlIdx === null) nlIdx = buildLineIndex(text);
        record(name, 'session', sid, lineAtIndex(nlIdx, m.index), classifyRuntimeHit(text, m.index, name));
      }
      if (++n >= PER_FILE_MATCH_CAP) break;
      if (m.index === namesRe.lastIndex) namesRe.lastIndex++;   // 零长匹配防御
    }
    for (const h of hitHere) out.sessions.hitNameSet.add(h);
    out.sessions.hitNames = out.sessions.hitNameSet.size;
  }
  delete out.sessions.hitNameSet;

  // ── 来源 B：看板卡（Host API；本地一律 localhost:3080）
  const boardUrl = opts.boardUrl ?? 'http://localhost:3080';
  try {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const r = await fetchImpl(`${boardUrl}/api/task-board/state`, { headers: { origin: boardUrl, 'sec-fetch-site': 'same-origin', 'x-dsh-board-scope': 'live' } });
    if (!r.ok) { out.board.error = `HTTP ${r.status}`; }
    else {
      const j = await r.json();
      const tasks = j.tasks ?? [];
      out.board.cards = tasks.length;
      out.board.ok = true;
      for (const t of tasks) {
        const blob = [t.id, t.title, t.description, t.prompt, t.line, t.seq].filter(Boolean).join('\n');
        namesRe.lastIndex = 0;
        let m;
        const hitHere = new Set();
        while ((m = namesRe.exec(blob)) !== null) {
          hitHere.add(m[0]);
          record(m[0], 'board', `${String(t.id).slice(0, 8)} ${String(t.title ?? '').slice(0, 40)}`, null, classifyRuntimeHit(blob, m.index, m[0]));
          if (m.index === namesRe.lastIndex) namesRe.lastIndex++;
        }
        for (const h of hitHere) out.board.hitNameSet.add(h);
      }
      out.board.hitNames = out.board.hitNameSet.size;
      delete out.board.hitNameSet;
      out.board.qualifiedNames = [...qualified].filter((n) => (found[n] ?? []).some((x) => x.source === 'board' && x.strength === 'qualified')).length;
    }
  } catch (e) { out.board.error = e?.message ?? String(e); }

  out.sessions.qualifiedNames = [...qualified].filter((n) => (found[n] ?? []).some((x) => x.source === 'session' && x.strength === 'qualified')).length;
  out.qualifiedNames = [...qualified];
  out.elapsedMs = Date.now() - t0;
  return out;
}
