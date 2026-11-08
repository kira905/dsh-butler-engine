#!/usr/bin/env node
// dsh-butler / butler-audit-archive.mjs —— P5 归档审计 + P8 收纳审计（只读）
//
// 检查项（9 个检查点固定清单）：
//   根目录白名单 / 白名单漂移 / _tmp 积压 / 备份三件套（+孤儿恢复脚本）/ 桌面入口 /
//   _archive 命名与 README / 变更流水是否记 / 文档头部元信息。
//
// 【[11a] 2026-09-10 改造：规范单一数据源】
//   白名单 / 命名规范 / 三件套判据 / 阈值 全部改读 `butler-tidy-policy.json`，不再各自内联副本。
//   读取顺序（P8 §15.2 P-2 契约）：
//     ① <pkg>/src/dsh-butler/butler-tidy-policy.json（主位置，随仓3 同步）
//     ② ~/.dsh/butler-tidy-policy.json（兼容位，随仓1 同步）
//     ③ 内置默认（策略文件缺失/损坏时的回落；命名与阈值有内置副本，root 白名单回落 wrapup 内联解析）
//   ①②同时存在且内容不一致 → 产出「规范漂移」行（不静默取其一）。
//
// 【命名规范修订（P8 §2.4）】旧正则 `^[\w.\u4e00-\u9fa5]+-\d{8}(?:T\d{6})?$` 的 `\w` 不含 `-`
//   → 多连字符前缀（但ler-panel-deploy-… 等）**100% 误报**（124/124）。修订方式 = 修正则（前缀类含 `-`）
//   + 显式承认既有 10 种日期/时间形态 + 2 类结构性例外 + 3 项常驻资产白名单；
//   **不改任何目录名**（改名会断 14 个「自动选最新备份」前缀 + 12 个桌面硬依赖）。
//
// 用法：
//   node butler-audit-archive.mjs [--json] [--dsh-root <dir>] [--docs-sample N] [--orphans] [--policy] [--fix-readme]
// 退出码：0 无 block / 1 有 block / 2 用法错误
//
// ── 订正注（2026-10-14 · V2.9 封口清单 J L478 · 卡「施工·封口①J域README生成侧」）────────────
//   ⚠️ 上面「（只读）」**在缺省调用下依然成立**，但多了一个**可选**写动作（只标注，不改上文原文）：
//     `auditArchive({ensureReadme:true})` / CLI `--fix-readme` 会在检测到 `_archive/README.md`
//     缺失/过期时生成它（唯一实现 `lib/archive-readme.mjs#ensureArchiveReadme`，幂等）。
//     缺省 = **不写盘**（面板 / 日报 / 单测的调用面零变化）；自动入口 = tickd job `tidy`（每 12h）。
//     真源 = `docs\交付报告-封口①-J域README生成侧-20261014.md`。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadRules } from './lib/audit-cli.mjs';
import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { dirsIncludingSubdir } from '../src/dsh-butler/lib/desktop-entry.mjs';
import { countTree, walkTree } from './lib/tidy-walk.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';

export const ARCHIVE_AUDIT_VERSION = '0.3.0';
export const DEFAULT_DSH_ROOT = process.env.DSH_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME || '.', 'dsh-workspace');
const WRAPUP = path.join('tools', 'dsh-wrapup.ps1');
const SELFCHECK = path.join('tools', 'dsh-selfcheck.ps1');
const CHANGELOG_STALE_DAYS = 3;
/**
 * 审计器检查点固定清单（9 个）——§14.9 复核表的「9 条 finding」口径就是这张表。
 * 【2026-10-10 · B4】起 **9 个检查点每轮各至少产一行**（合规 = ok 行）⇒ `produced` 恒为 9、
 *   `missing` 恒为空。改前口径是「`root-whitelist` / `root-whitelist-drift` 仅异常才产行」，
 *   那让 `missing` 被读成「两检查点没做」（gap-1-39 的误读来源）—— 详见 `checkRootWhitelist()` 的订正注。
 * [11a] 起 **不新增检查点**：孤儿恢复脚本检测并入既有 `backup-trio`（否则面板/文档/复核表三处口径连锁漂移）。
 */
export const AUDIT_CHECKPOINT_IDS = [
  'root-whitelist', 'root-whitelist-drift', 'tmp-backlog', 'backup-trio', 'desktop-entry',
  'archive-naming', 'archive-readme', 'changelog', 'docs-meta',
];
/** 采样窗口（§14.9 复核口径：备份目录采样 10 个 / 命名采样 30 个）。 */
export const AUDIT_SAMPLE = Object.freeze({ backup: 10, naming: 30 });

// ─────────────────────────────────────────────────────────── 策略文件（单一数据源）
/** 【2c-B3】兼容位（~/.dsh）策略文件路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function policyFileOf(name, home) {
  return resolveStatePath(name, { home }).path;
}
/** 策略文件名（主位置 tools/dsh-butler/ 与兼容位 ~/.dsh/ 同名）。 */
export const POLICY_FILE_NAME = 'butler-tidy-policy.json';
/** 策略文件主位置（相对 dshRoot）。 */
export const POLICY_TOOLS_DIR = ['tools', 'dsh-butler'];

/** 两个候选位置。 */
export function policyPaths(dshRoot, home = dshHome()) {
  return {
    tools: path.join(dshRoot, ...POLICY_TOOLS_DIR, POLICY_FILE_NAME),
    home: policyFileOf(POLICY_FILE_NAME, home),
  };
}

/**
 * 旧命名正则（**保留导出用于复现「规范原文 100% 误报」**，P8 §2.4）。
 * 缺陷：`\w` 不含连字符，前缀字符类里也没补 `-` → 多连字符前缀一律判违规。
 */
export const LEGACY_NAMING_RE = /^[\w.\u4e00-\u9fa5]+-\d{8}(?:T\d{6})?$/;
/** 旧的结构性例外正则（对照用）。 */
export const LEGACY_NAMING_EXEMPT_RE = /^_tmp-archive-/;

/**
 * 内置默认命名规范 —— 仅在策略文件缺失/损坏时使用（与 butler-tidy-policy.json 的 archiveNaming 同源）。
 * 存在的意义 = fail-safe：规范文件读不到时审计器仍按**修订后**口径工作，而不是退回 100% 误报的旧正则。
 */
export const BUILTIN_NAMING = Object.freeze({
  prefixClass: '[A-Za-z0-9_.\\u4e00-\\u9fa5-]+',
  forms: [
    { id: 'd8', pattern: '-\\d{8}$', label: '<任务>-YYYYMMDD' },
    { id: 'd8-t6', pattern: '-\\d{8}T\\d{6}$', label: '<任务>-YYYYMMDDTHHMMSS' },
    { id: 'd8-h6', pattern: '-\\d{8}-\\d{6}$', label: '<任务>-YYYYMMDD-HHMMSS' },
    { id: 'd8-h4', pattern: '-\\d{8}-\\d{4}$', label: '<任务>-YYYYMMDD-HHMM' },
    { id: 'd14', pattern: '-\\d{14}$', label: '<任务>-YYYYMMDDHHMMSS' },
    { id: 'iso-date', pattern: '-\\d{4}-\\d{2}-\\d{2}$', label: '<任务>-YYYY-MM-DD' },
    { id: 'iso-t', pattern: '-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}$', label: '<任务>-YYYY-MM-DDTHH-MM-SS' },
    { id: 'iso-dash', pattern: '-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}$', label: '<任务>-YYYY-MM-DD-HH-MM-SS' },
    { id: 'iso-ms-z', pattern: '-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$', label: '<任务>-ISO-msZ' },
    { id: 'epoch-ms', pattern: '-\\d{13}$', label: '<任务>-<epoch 毫秒>' },
  ],
  exempt: [
    { pattern: '^_tmp-archive-', label: '结构性例外：临时区归档桶' },
    { pattern: '^_ref-', label: '结构性例外：参考资料区' },
  ],
  assets: ['persona-backups', 'memory-db-tools', 'balance-capsule'],
});
/** 内置默认三件套判据。 */
export const BUILTIN_TRIO = Object.freeze({
  restoreKeywords: ['restore', 'rollback', '恢复'],
  restoreExts: ['.mjs', '.js', '.cjs', '.cmd', '.bat', '.ps1', '.sh'],
  manifestPattern: '^(manifest|MANIFEST).*\\.(json|md|txt)$|^README.*\\.md$|^恢复说明.*\\.md$',
  manifestMaxDepth: 1,
  restoreMaxDepth: 2,
  desktopEntryPattern: 'restore|rollback|恢复',
  sampleRecent: 10,
});
/** 内置默认阈值。 */
export const BUILTIN_TMP = Object.freeze({ warnFiles: 200, warnBytes: 200 * 1024 * 1024 });

/** 旧根文件匹配回落值（wrapup 未内联 `$item.Name -notmatch` 时）。 */
export const DEFAULT_ROOT_FILE_PATTERN = '^(dsh-.*\\.(cmd|ps1|mjs|js)|.*\\.(ico|png|svg))$';
/** 白名单里登记但允许缺失的项（策略文件未声明 optionalMissing 时的回落）。 */
export const DEFAULT_OPTIONAL_MISSING = Object.freeze(['node_modules']);

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 读一个策略文件候选位置。不抛错：坏文件只记原因。 */
export function readPolicyFile(file) {
  try {
    if (!fs.existsSync(file)) return { ok: false, file, reason: 'missing' };
    const text = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || !json.schemaVersion) return { ok: false, file, reason: 'bad-schema' };
    return { ok: true, file, json, hash: sha256(text) };
  } catch (e) {
    return { ok: false, file, reason: `read-error:${e?.message ?? e}` };
  }
}

/** 编译命名规范（策略里的字符串形态 → 正则对象）。编译失败回落到内置形态。 */
export function compileNaming(naming) {
  const prefixClass = naming?.prefixClass || BUILTIN_NAMING.prefixClass;
  const src = Array.isArray(naming?.forms) && naming.forms.length ? naming.forms : BUILTIN_NAMING.forms;
  const forms = [];
  for (const f of src) {
    const pattern = typeof f === 'string' ? f : f?.pattern;
    if (!pattern) continue;
    try { forms.push({ id: f?.id ?? pattern, label: f?.label ?? pattern, pattern, re: new RegExp('^' + prefixClass + pattern) }); } catch { /* 跳过坏形态 */ }
  }
  if (!forms.length) for (const f of BUILTIN_NAMING.forms) forms.push({ ...f, re: new RegExp('^' + prefixClass + f.pattern) });
  const exemptSrc = Array.isArray(naming?.exempt) ? naming.exempt : BUILTIN_NAMING.exempt;
  const exempt = [];
  for (const e of exemptSrc) {
    const pattern = typeof e === 'string' ? e : e?.pattern;
    if (!pattern) continue;
    try { exempt.push({ label: e?.label ?? pattern, pattern, re: new RegExp(pattern) }); } catch { /* 跳过 */ }
  }
  const assets = new Set((Array.isArray(naming?.assets) ? naming.assets : BUILTIN_NAMING.assets)
    .map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean));
  return { prefixClass, forms, exempt, assets, legacy: naming?.legacy ?? null };
}

/** 内置默认命名（已编译）。 */
export const BUILTIN_COMPILED_NAMING = compileNaming(BUILTIN_NAMING);

/**
 * 加载策略（**唯一入口**：白名单 / 命名 / 三件套 / 阈值 都从这里取）。
 * @param {string} dshRoot
 * @param {{home?:string}} [opts]
 * @returns {{ok:boolean, where:'tools'|'home'|'builtin', file:string|null, errors:string[], drift:string[], naming:object, namingSource:'policy'|'builtin', trio:object, tmp:object, rootWhitelist:object|null, rootSource:{where:string,file:string}|null, raw:object|null}}
 */
export function loadTidyPolicy(dshRoot, opts = {}) {
  const home = opts.home ?? dshHome();
  const p = policyPaths(dshRoot, home);
  const tools = readPolicyFile(p.tools);
  const homeHit = readPolicyFile(p.home);
  const errors = [];
  if (!tools.ok && tools.reason !== 'missing') errors.push(`tools:${tools.reason}`);
  if (!homeHit.ok && homeHit.reason !== 'missing') errors.push(`home:${homeHit.reason}`);
  const drift = [];
  if (tools.ok && homeHit.ok && tools.hash !== homeHit.hash) {
    drift.push(`策略文件双副本内容不一致：主位置 ${tools.file}（${tools.hash.slice(0, 12)}）≠ 兼容位 ${homeHit.file}（${homeHit.hash.slice(0, 12)}）→ 以主位置为准，请手工同步或删除多余副本`);
  }
  // 两处都存在且 hash 相同 → 不是漂移（副本一致无害，只是冗余；收敛由人做）
  const hit = tools.ok ? tools : (homeHit.ok ? homeHit : null);
  const where = tools.ok ? 'tools' : (homeHit.ok ? 'home' : 'builtin');
  const raw = hit?.json ?? null;
  const naming = compileNaming(raw?.archiveNaming);
  const trio = { ...BUILTIN_TRIO, ...(raw?.backupTrio ?? {}) };
  const tmp = { ...BUILTIN_TMP, ...(raw?.tmp ?? {}) };
  const rw = raw?.rootWhitelist;
  const rootWhitelist = rw && Array.isArray(rw.dirs) && Array.isArray(rw.files)
    ? {
      dirs: rw.dirs,
      files: rw.files,
      filePattern: rw.filePattern ?? DEFAULT_ROOT_FILE_PATTERN,
      optionalMissing: Array.isArray(rw.optionalMissing) ? rw.optionalMissing : [...DEFAULT_OPTIONAL_MISSING],
    }
    : null;
  return {
    ok: Boolean(hit),
    where,
    file: hit?.file ?? null,
    errors,
    drift: drift.filter(Boolean),
    naming,
    namingSource: raw?.archiveNaming ? 'policy' : 'builtin',
    trio,
    tmp,
    rootWhitelist,
    rootSource: rootWhitelist ? { where, file: hit.file } : null,
    raw,
  };
}

/** 取策略对象（**防御 `??` 陷阱**：opts.policy 可能是 CLI 的布尔标志 false，必须类型判定后再回落）。 */
function policyOf(dshRoot, opts = {}) {
  return (opts.policy && typeof opts.policy === 'object') ? opts.policy : loadTidyPolicy(dshRoot, opts);
}

/**
 * 判定单个 _archive 顶层名是否符合命名规范（[11a] 新口径）。
 * 判定顺序：常驻资产白名单 → 结构性例外 → 10 种日期/时间形态。
 * @returns {{ok:boolean, kind:'asset'|'exempt'|'form'|'violation', id?:string, label:string}}
 */
export function matchArchiveName(name, naming = BUILTIN_COMPILED_NAMING) {
  if (naming.assets.has(name)) return { ok: true, kind: 'asset', label: `常驻资产白名单：${name}` };
  for (const e of naming.exempt) if (e.re.test(name)) return { ok: true, kind: 'exempt', id: e.pattern, label: e.label };
  for (const f of naming.forms) if (f.re.test(name)) return { ok: true, kind: 'form', id: f.id, label: f.label };
  return { ok: false, kind: 'violation', label: `不符合任何允许形态（${naming.forms.length} 种日期/时间形态 / ${naming.exempt.length} 类结构性例外 / ${naming.assets.size} 项常驻资产）` };
}

/** 旧正则口径复算（用于「规范原文误报率」对照：不打补丁的旧正则会报多少）。 */
export function legacyNamingViolates(name) {
  return !LEGACY_NAMING_RE.test(name) && !LEGACY_NAMING_EXEMPT_RE.test(name);
}

/** 校验某字符串是否一个合法的归档目录名（正例/反例自检用，纯函数）。 */
export function isCompliantArchiveName(name, policy = null) {
  const naming = policy?.naming ?? BUILTIN_COMPILED_NAMING;
  return matchArchiveName(name, naming);
}

/**
 * 【2026-10-10 · B4 卡（冲刺600·补收纳）】解析**任意 .ps1 里的内联根白名单**。
 *
 * 为什么要通用解析器：根白名单有**三处副本** —— 权威源 `butler-tidy-policy.json` +
 * `tools\dsh-wrapup.ps1` 内联 + `tools\dsh-selfcheck.ps1` 内联（[11b] 之后两个 .ps1 都
 * 「策略读得到就用策略、读不到回落到自己的内联副本」）。B4 之前审计器**只取一处**（策略优先），
 * 副本之间分叉时**静默** —— 那两个 PS 侧自检（wrapup/selfcheck 各有一段 `$wlDiff` 双向比对）
 * 只在**手动跑那两个脚本**时才报，采集器侧看不见。本函数 + `compareWhitelistCopies()` 就是把
 * 这条「双向比对」搬进审计器（每轮 tick 都跑）。
 *
 * @returns {{file:string, dirs:string[], files:string[], filePattern:string}|null} 文件读不到 **或** 没有内联副本 ⇒ null
 */
export function parseInlineWhitelist(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const dirs = text.match(/\$allowedDirs\s*=\s*@\(([^)]*)\)/s);
  const files = text.match(/\$allowedFiles\s*=\s*@\(([^)]*)\)/s);
  if (!dirs && !files) return null;   // 该文件没有内联副本（只有读策略那一段）⇒ 不是「副本缺失」，是形态不同
  const parse = (m) => (m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []);
  const filePattern = text.match(/\$item\.Name\s+-notmatch\s+'([^']+)'/);
  return { file, dirs: parse(dirs), files: parse(files), filePattern: filePattern ? filePattern[1] : DEFAULT_ROOT_FILE_PATTERN };
}

/** 解析 dsh-wrapup.ps1 的根目录白名单（策略文件缺失时的中间态回落）。 */
export function parseWrapupWhitelist(dshRoot) {
  const file = path.join(dshRoot, WRAPUP);
  const inline = parseInlineWhitelist(file);
  if (!inline) return null;
  return { file, dirs: inline.dirs, files: inline.files, filePattern: inline.filePattern };
}

/**
 * 根白名单的**两处内联副本**（权威源 = `butler-tidy-policy.json`）。
 * [11b] 起两个 .ps1 都是「策略读得到就用策略、读不到回落自己的内联副本」⇒ 内联是**回落态**，
 * 三处必须逐条一致（先例：CW-2 11→12 · 补C4 12→13=guard-http.mjs）。
 * @type {ReadonlyArray<{name:string, rel:string}>}
 */
export const WHITELIST_INLINE_COPIES = Object.freeze([
  { name: 'dsh-wrapup.ps1', rel: WRAPUP },
  { name: 'dsh-selfcheck.ps1', rel: SELFCHECK },
]);

/**
 * **跨副本双向比对**（B4 新增）：权威源 × 两份内联副本，四个方向逐条列差集。
 *   双向 = 「权威有·副本缺」（`-项`）+ 「副本有·权威无」（`+项`），目录与文件各算 —— 与
 *   `dsh-wrapup.ps1` / `dsh-selfcheck.ps1` 里那段 `$wlDiff` 的写法同口径（那两段只在**手动跑脚本**时可见，
 *   本函数把它搬进采集器 ⇒ 每轮 tick 都有读数）。
 *   ⚠️ 只读：不读生产 `~/.dsh`（home 经参数），不写任何文件。
 * @param {string} dshRoot
 * @param {{wl?:object}} [opts] `wl` = `resolveRootWhitelist()` 的结果（权威面）
 * @returns {{auth:{source:string,dirs:string[],files:string[]}, rows:object[], divergent:object[]}}
 */
export function compareWhitelistCopies(dshRoot, opts = {}) {
  const auth = {
    source: opts.wl?.source ?? 'none',
    dirs: opts.wl?.dirs ?? [],
    files: opts.wl?.files ?? [],
  };
  const rows = [];
  for (const c of WHITELIST_INLINE_COPIES) {
    const file = path.join(dshRoot, c.rel);
    const inline = parseInlineWhitelist(file);
    if (!inline) { rows.push({ name: c.name, file, present: false, onlyAuth: [], onlyInline: [] }); continue; }
    const onlyAuth = [
      ...auth.dirs.filter((d) => !inline.dirs.includes(d)).map((n) => ({ name: n, kind: 'dir' })),
      ...auth.files.filter((f) => !inline.files.includes(f)).map((n) => ({ name: n, kind: 'file' })),
    ];
    const onlyInline = [
      ...inline.dirs.filter((d) => !auth.dirs.includes(d)).map((n) => ({ name: n, kind: 'dir' })),
      ...inline.files.filter((f) => !auth.files.includes(f)).map((n) => ({ name: n, kind: 'file' })),
    ];
    rows.push({
      name: c.name, file, present: true,
      counts: { dirs: inline.dirs.length, files: inline.files.length },
      onlyAuth, onlyInline,
    });
  }
  return { auth, rows, divergent: rows.filter((r) => r.present && (r.onlyAuth.length || r.onlyInline.length)) };
}

/**
 * 读兼容位（~/.dsh）策略文件的 rootWhitelist（[10] 时期的老入口，保留向后兼容）。
 * @returns {{ok:boolean, file:string, reason:string, dirs?:string[], files?:string[], filePattern?:string}}
 */
export function readPolicyWhitelist(home) {
  const file = policyFileOf(POLICY_FILE_NAME, home);
  const hit = readPolicyFile(file);
  if (!hit.ok) return { ok: false, file, reason: hit.reason };
  const rw = hit.json?.rootWhitelist;
  if (!rw || !Array.isArray(rw.dirs) || !Array.isArray(rw.files)) return { ok: false, file, reason: 'no-rootWhitelist' };
  return { ok: true, file, dirs: rw.dirs, files: rw.files, filePattern: rw.filePattern ?? DEFAULT_ROOT_FILE_PATTERN };
}

/**
 * **白名单读取顺序契约（P8 §15.2 P-2）**：策略文件（tools → home）→ wrapup 内联解析。
 * 为什么是"顺序"而不是"二选一"：`[11b]` 会把 `dsh-wrapup.ps1` 改成读策略文件，
 * 届时 wrapup 里可能不再内联 `$allowedDirs/$allowedFiles` —— 若审计器只会解析 wrapup 源码，
 * 就会把整个根目录报成混入（P8 §14.2 阻断级预言 L2）。所以策略文件永远第一顺位。
 * @param {string} dshRoot
 * @param {{home?:string, policy?:object}} [opts]
 * @returns {{source:'policy'|'wrapup'|'none', file:string, dirs:string[], files:string[], filePattern:string, optionalMissing:string[], note:string}}
 */
export function resolveRootWhitelist(dshRoot, opts = {}) {
  const policy = policyOf(dshRoot, opts);
  if (policy.rootWhitelist) {
    return {
      source: 'policy',
      file: policy.rootSource.file,
      dirs: policy.rootWhitelist.dirs,
      files: policy.rootWhitelist.files,
      filePattern: policy.rootWhitelist.filePattern,
      optionalMissing: policy.rootWhitelist.optionalMissing,
      note: `policy:${policy.rootSource.where}`,
    };
  }
  const wl = parseWrapupWhitelist(dshRoot);
  // note 保留具体原因（坏文件 → read-error:…），便于排障与单测断言
  const reason = policy.ok
    ? 'policy:no-rootWhitelist'
    : (policy.errors.length ? `policy:${policy.errors.join(' | ')}` : 'policy:missing');
  if (!wl) {
    return { source: 'none', file: '', dirs: [], files: [], filePattern: DEFAULT_ROOT_FILE_PATTERN, optionalMissing: [...DEFAULT_OPTIONAL_MISSING], note: `${reason} + wrapup:missing` };
  }
  return {
    source: 'wrapup',
    file: wl.file,
    dirs: wl.dirs,
    files: wl.files,
    filePattern: wl.filePattern,
    optionalMissing: [...DEFAULT_OPTIONAL_MISSING],
    note: reason,
  };
}

/**
 * ① 根目录白名单（含「规范过时」识别、「策略文件双副本分叉」识别、**跨副本双向比对**）。
 *
 * 【2026-10-10 · B4 卡（冲刺600·补收纳）· 口径变更（订正注）】
 *   改前：本函数**只在异常时**才产出行 ⇒ 合规时 `root-whitelist` / `root-whitelist-drift`
 *         两个 id 一行都不产，而 `auditArchive()` 用 `AUDIT_CHECKPOINT_IDS.filter(未产出行)`
 *         算 `checkpoints.missing` ⇒ 状态文件里被读成「两检查点仍缺」
 *         （补弹药计划 `gap-1-39` 的证据就是这么读出来的）。**事实是两条一直有实现**，
 *         只是"合规即无声"，字段名 `missing` 与"没做"撞了语义。
 *   改后：**9 个检查点每轮各至少产一行**（合规 = ok 行），`missing` 从此是真空集：
 *         · `root-whitelist`       —— 合规时产 ok 行（带白名单来源与条数读数）
 *         · `root-whitelist-drift` —— 合规时产 ok 行（带**三处副本逐条差集 0** 的读数）
 *   ⚠️ 这是**设计变更**，不是"把红改绿"：反例断言（混入 → block 行、登记项消失 → drift warn 行）
 *      一条没动；`_test/test-tidy.mjs` §③ 与 `_test/test-audit.mjs` ⑫ 同步**加强**了断言。
 */
export function checkRootWhitelist(dshRoot, opts = {}) {
  const policy = policyOf(dshRoot, opts);
  const wl = opts.whitelist ?? resolveRootWhitelist(dshRoot, { ...opts, policy });
  const findings = [];
  // 跨副本双向比对（B4 新增）—— 权威源 × wrapup 内联 × selfcheck 内联
  const copies = compareWhitelistCopies(dshRoot, { wl });

  if (wl.source === 'none') {
    findings.push({ id: 'root-whitelist', level: 'warn', message: `找不到 ${WRAPUP} 且无 ${POLICY_FILE_NAME}（无法校验根目录白名单）` });
  }
  let entries = [];
  let rootError = null;
  if (wl.source !== 'none') {
    try { entries = fs.readdirSync(dshRoot, { withFileTypes: true }); } catch (e) { rootError = e; }
  }
  if (rootError) {
    findings.push({ id: 'root-whitelist', level: 'block', message: `读不到根目录：${rootError?.message ?? rootError}` });
  }
  const re = new RegExp(wl.filePattern ?? DEFAULT_ROOT_FILE_PATTERN);
  const stray = [];
  const present = new Set();
  for (const e of entries) {
    present.add(e.name);
    // junction / 符号链接目录（_archive/generated 等已外移 <offsync>）→ 必须跟随链接判定：
    // 挂载点 junction 是生产数据正式所在，跟随后才统计得到（见 lib/tidy-walk.mjs 的挂载点/内容二分）
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(dshRoot, e.name)).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) {
      if (!wl.dirs.includes(e.name)) stray.push({ name: e.name, kind: 'dir' });
    } else if (!wl.files.includes(e.name) && !re.test(e.name)) {
      stray.push({ name: e.name, kind: 'file' });
    }
  }
  if (stray.length) {
    const names = stray.map((s) => s.name);
    findings.push({
      id: 'root-whitelist', level: 'block',
      message: `根目录混入白名单外项 ${stray.length} 个：${names.slice(0, 8).join(', ')}${names.length > 8 ? ' …' : ''}`,
      detail: `若其中确有合法文件（如 guard2 系列 / tools / assets），说明 **规范过时** → 更新 ${POLICY_FILE_NAME} 的 rootWhitelist；否则按【DSH 目录结构铁律】归档。`,
      stray,
    });
  } else if (wl.source !== 'none' && !rootError) {
    // B4：合规也产行 —— 让「检查点做过且干净」这件事本身可读（旧版此处无行 ⇒ missing 误读）
    findings.push({
      id: 'root-whitelist', level: 'ok',
      message: `根目录无白名单外项（白名单来源 ${wl.source}：${wl.dirs.length} 目录 / ${wl.files.length} 文件 / 1 形态正则）`,
      detail: wl.source === 'policy'
        ? `权威源：${wl.file}（${wl.note}）`
        : `权威源：wrapup 内联（${wl.note}）—— 策略文件无 rootWhitelist 或读不到`,
    });
  }
  // 反向：白名单条目已不存在 → 规范过时
  const optional = new Set(wl.optionalMissing ?? DEFAULT_OPTIONAL_MISSING);
  if (!rootError && wl.source !== 'none') {
    const missing = [
      ...wl.dirs.filter((d) => !present.has(d) && !optional.has(d)).map((n) => ({ name: n, kind: 'dir' })),
      ...wl.files.filter((f) => !present.has(f) && !optional.has(f)).map((n) => ({ name: n, kind: 'file' })),
    ];
    if (missing.length) {
      findings.push({
        id: 'root-whitelist-drift', level: 'warn',
        message: `白名单过时：${missing.length} 个登记项已不在根目录（${missing.slice(0, 6).map((m) => m.name).join(', ')}）`,
        detail: `规范与现状不符 → 更新 ${POLICY_FILE_NAME}（审计器不自动改规范，只提示）。`,
        missing,
      });
    }
  }
  // 策略文件双副本分叉（[11a] 新增；同一检查点，不新增检查点 id）
  if (policy.drift.length) {
    findings.push({
      id: 'root-whitelist-drift', level: 'warn',
      message: `规范漂移：策略文件有两份副本且内容不一致（主位置 ${policy.rootSource?.file ?? policy.file}）`,
      detail: policy.drift.join(' | ') + '（白名单/命名/阈值以主位置为准，本行提示手工收敛）。',
    });
  }
  for (const err of policy.errors ?? []) {
    findings.push({
      id: 'root-whitelist-drift', level: 'warn',
      message: `策略文件解析异常：${err}`,
      detail: `读取顺序：${policyPaths(dshRoot, opts.home ?? dshHome()).tools} → ~/.dsh/${POLICY_FILE_NAME} → wrapup 内联。异常时按下一顺位回落（fail-safe）。`,
    });
  }
  // ── B4 新增：跨副本双向比对结论（合规也产行）
  if (copies.divergent.length) {
    const parts = copies.divergent.map((r) => `${r.name}: 差集 ${r.onlyAuth.length} 项（权威有·副本缺）+ ${r.onlyInline.length} 项（副本有·权威无）`);
    findings.push({
      id: 'root-whitelist-drift', level: 'warn',
      message: `白名单副本分叉：${copies.divergent.length}/${copies.rows.length} 份内联副本与权威源逐条不一致（${parts.join('；')}）`,
      detail: '权威源 = ' + (wl.file || '(none)') + '；处置 = 同步两个 .ps1 的内联 $allowedDirs/$allowedFiles 后重跑'
        + '（先例：CW-2 11→12 · 补C4 12→13=guard-http.mjs）。审计器只报不改。',
      divergent: copies.divergent.map((r) => ({
        name: r.name, onlyAuth: r.onlyAuth, onlyInline: r.onlyInline,
      })),
    });
  } else {
    const presentCopies = copies.rows.filter((r) => r.present);
    findings.push({
      id: 'root-whitelist-drift', level: 'ok',
      message: presentCopies.length
        ? `白名单三处一致：权威源 × ${presentCopies.map((r) => r.name).join(' × ')}逐条差集 0`
          + `（${presentCopies.map((r) => `${r.name} ${r.counts.dirs} 目录/${r.counts.files} 文件`).join('；')}）`
        : `无可比对的内联副本（${copies.rows.length} 份 .ps1 均无 $allowedDirs/$allowedFiles 内联段）`,
      detail: '双向比对口径 = 目录与文件各算「权威有·副本缺 / 副本有·权威无」四个方向（B4 · 2026-10-10）。',
    });
  }
  return findings;
}

/** ② _tmp 积压（阈值取自策略文件；遍历统一走 lib/tidy-walk.mjs）。 */
export function checkTmpBacklog(dshRoot, opts = {}) {
  const policy = policyOf(dshRoot, opts);
  const maxFiles = policy.tmp.warnFiles ?? BUILTIN_TMP.warnFiles;
  const maxBytes = policy.tmp.warnBytes ?? BUILTIN_TMP.warnBytes;
  const dir = path.join(dshRoot, '_tmp');
  if (!fs.existsSync(dir)) return [{ id: 'tmp-backlog', level: 'warn', message: '_tmp 目录不存在（公约要求存在）' }];
  const tree = countTree(dir);
  const files = tree.fileCount;
  const bytes = tree.bytes;
  if (files > maxFiles || bytes > maxBytes) {
    return [{
      id: 'tmp-backlog', level: 'warn',
      message: `_tmp 积压 ${files} 文件 / ${(bytes / 1048576).toFixed(1)}MB（阈值 ${maxFiles} 文件 / ${maxBytes / 1048576}MB）`,
      detail: '一次性诊断产物 → 归档到 _archive\\_tmp-archive-<日期>\\；进行中/仍被引用的保留。',
    }];
  }
  return [{ id: 'tmp-backlog', level: 'ok', message: `_tmp ${files} 文件 / ${(bytes / 1048576).toFixed(1)}MB（正常，阈值 ${maxFiles} 文件 / ${maxBytes / 1048576}MB）` }];
}

// ─────────────────────────────────────────────────── 备份三件套 / 孤儿恢复脚本检测
/** 在目录内浅层查找恢复脚本（深度 ≤ restoreMaxDepth）。 */
function findRestoreScripts(dir, trio) {
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;              // 内容 reparse point 不穿透（P8 §5.4）
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth + 1 <= trio.restoreMaxDepth) walk(full, depth + 1); continue; }
      const lower = e.name.toLowerCase();
      const ext = path.extname(lower);
      if (trio.restoreExts.includes(ext) && trio.restoreKeywords.some((k) => lower.includes(k))) out.push(path.relative(dir, full));
    }
  };
  walk(dir, 0);
  return out;
}

/** 在目录内查找 manifest / README 索引（深度 ≤ manifestMaxDepth）。 */
function findManifest(dir, trio) {
  const re = new RegExp(trio.manifestPattern, 'i');
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth + 1 <= trio.manifestMaxDepth) walk(full, depth + 1); continue; }
      if (re.test(e.name)) out.push(path.relative(dir, full));
    }
  };
  walk(dir, 0);
  return out;
}

/** 桌面恢复脚本的文本池（用于判定"该备份目录有没有桌面入口"）。 */
function desktopEntryIndex(desktop, trio) {
  const entryRe = new RegExp(trio.desktopEntryPattern, 'i');
  const dirRe = /[\\/]_archive[\\/]([A-Za-z0-9_.\u4e00-\u9fa5-]+)/g;
  const declared = new Set();
  const blob = [];
  const entries = [];
  // 2026-09-11 起入口统一收进桌面的 DSH鲸落地 子文件夹，但桌面根的旧入口同样算数 → 两处都扫
  for (const dir of dirsIncludingSubdir(desktop)) {
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of files) {
      if (!e.isFile() || !entryRe.test(e.name)) continue;
      entries.push(e.name);
      // 只有脚本类才读文本（其余按文件名计入入口数，不改 [10] 的既有计数口径）
      if (!/\.(cmd|bat|ps1|mjs|js|cjs)$/i.test(e.name)) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(dirRe)) declared.add(m[1].replace(/[\\/]+$/, ''));
      blob.push(text);
    }
  }
  return { entries, declared, blob: blob.join('\n') };
}

/**
 * 孤儿恢复脚本检测（[11a] 交付）：对 `_archive` 顶层逐目录判三项 ——
 *   ① 有无一键恢复脚本（restore/rollback/恢复 + 脚本扩展名）
 *   ② 有无 manifest / README 索引
 *   ③ 有无桌面入口（桌面 restore-*.cmd 里声明了该目录；§2.8 口径的"孤儿备份"）
 * 常驻资产（persona-backups 等）与结构性例外（_tmp-archive-*）单列，不计入"孤儿"。
 * @param {string} dshRoot
 * @param {{home?:string, desktop?:string, policy?:object}} [opts]
 */
export function detectOrphanBackups(dshRoot, opts = {}) {
  const policy = policyOf(dshRoot, opts);
  const trio = policy.trio;
  const desktop = opts.desktop ?? path.join(os.homedir(), 'Desktop');
  const dir = path.join(dshRoot, '_archive');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { ok: false, dir, desktop, scanned: 0, items: [], withoutRestore: [], withoutManifest: [], noDesktopEntry: [] }; }
  const desk = desktopEntryIndex(desktop, trio);
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    const judge = matchArchiveName(e.name, policy.naming);
    const restore = findRestoreScripts(full, trio);
    const manifest = findManifest(full, trio);
    const onDesktop = desk.declared.has(e.name) || (desk.blob ? desk.blob.includes(e.name) : false);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
    items.push({
      name: e.name,
      mtimeMs,
      isAsset: judge.kind === 'asset',
      isExempt: judge.kind === 'exempt',
      restoreScripts: restore,
      hasRestore: restore.length > 0,
      manifests: manifest,
      hasManifest: manifest.length > 0,
      desktopEntry: onDesktop,
    });
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scoped = items.filter((i) => !i.isAsset);          // 常驻资产不参与三件套判定
  return {
    ok: true,
    dir,
    desktop,
    scanned: scoped.length,
    desktopEntries: desk.entries,
    assets: items.filter((i) => i.isAsset).map((i) => i.name),
    exempt: items.filter((i) => i.isExempt).map((i) => i.name),
    items,
    withoutRestore: scoped.filter((i) => !i.hasRestore).map((i) => i.name),
    withoutManifest: scoped.filter((i) => !i.hasManifest).map((i) => i.name),
    noDesktopEntry: scoped.filter((i) => i.hasRestore && !i.desktopEntry).map((i) => i.name),
  };
}

/** ③ 备份 + 恢复脚本 + manifest 三件套（最近任务目录）+ ④ 桌面入口。 */
export function checkBackupTrio(dshRoot, desktop = path.join(os.homedir(), 'Desktop'), limit = 10, opts = {}) {
  const policy = policyOf(dshRoot, opts);
  const dir = path.join(dshRoot, '_archive');
  // 采样窗口：最近 N 个目录（阈值取自策略文件 backupTrio.sampleRecent）
  const sampleN = limit ?? policy.trio.sampleRecent ?? AUDIT_SAMPLE.backup;
  const det = detectOrphanBackups(dshRoot, { ...opts, policy, desktop });
  if (!det.ok) return [{ id: 'backup-trio', level: 'warn', message: '读不到 _archive 目录' }];
  const subs = det.items.slice(0, sampleN);
  const missingRestore = subs.filter((i) => !i.isAsset && !i.hasRestore).map((i) => i.name);
  const missingManifest = subs.filter((i) => !i.isAsset && !i.hasManifest).map((i) => i.name);
  const findings = [];
  if (missingRestore.length || missingManifest.length) {
    findings.push({
      id: 'backup-trio', level: 'warn',
      message: `最近 ${subs.length} 个备份目录：缺一键恢复脚本 ${missingRestore.length} 个、缺 manifest ${missingManifest.length} 个`
        + (missingRestore.length ? `（缺恢复脚本：${missingRestore.slice(0, 4).join(', ')}${missingRestore.length > 4 ? ' …' : ''}）` : ''),
      detail: `铁律·备份+恢复脚本：改动前留备份 + 同时写一键恢复脚本（放桌面 + 归档 _archive）。全库口径：${det.scanned} 个目录中 ${det.withoutRestore.length} 个缺恢复脚本、${det.withoutManifest.length} 个缺 manifest、${det.noDesktopEntry.length} 个有脚本但桌面无入口（孤儿）→ 完整清单：node butler-audit-archive.mjs --orphans`,
      orphans: { missingRestore, missingManifest, sample: subs.map((s) => s.name) },
    });
  }
  const desktopRestore = det.desktopEntries ?? [];
  const entries = desktopRestore;
  findings.push({
    id: 'desktop-entry', level: 'ok',
    message: entries.length
      ? `桌面恢复入口 ${entries.length} 个（${entries.slice(0, 5).join(', ')}）：孤儿备份 ${det.noDesktopEntry.length} 个（有恢复脚本、桌面无入口，符合"稳定后归档"约定）`
      : `桌面恢复入口：${det.noDesktopEntry.length} 个孤儿备份（有脚本、桌面无入口）`,
  });
  return findings;
}

// ─────────────────────────────────────────────────── _archive 命名 / README
/**
 * `_archive` 顶层采样（命名审计与面板合规率共用同一口径，杜绝两套正则漂移）。
 * 口径说明（§14.9 复核基线）：命名采样只针对**目录**（不含顶层 12 个散落文件），采样窗口 = 最近 30 个目录。
 * [11a] 起：判定用**策略文件的命名规范**（10 形态 + 结构性例外 + 常驻资产白名单），
 *          并同时给出**旧正则口径**（legacyBad）用于复现「规范原文 100% 误报」。
 * @param {string} dshRoot
 * @param {number} [limit]
 * @param {{policy?:object, home?:string}} [opts]
 */
export function sampleArchiveNaming(dshRoot, limit = AUDIT_SAMPLE.naming, opts = {}) {
  const policy = policyOf(dshRoot, opts);
  const dir = path.join(dshRoot, '_archive');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
    return { ok: false, dir, dirs: 0, looseFiles: 0, sampled: [], sampledBad: [], bad: 0, legacyBad: 0, forms: {}, naming: policy.naming };
  }
  const dirs = entries.filter((e) => e.isDirectory());
  const loose = entries.filter((e) => !e.isDirectory());
  const all = dirs.map((e) => ({ name: e.name, mtimeMs: (() => { try { return fs.statSync(path.join(dir, e.name)).mtimeMs; } catch { return 0; } })() }));
  const sampled = all.slice().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  const judged = sampled.map((s) => ({ ...s, judge: matchArchiveName(s.name, policy.naming) }));
  const sampledBad = judged.filter((j) => !j.judge.ok).map((j) => j.name);
  const forms = {};
  for (const j of judged) {
    const key = j.judge.ok ? (j.judge.kind === 'asset' ? '常驻资产白名单' : j.judge.kind === 'exempt' ? '结构性例外' : j.judge.id) : '违规';
    forms[key] = (forms[key] ?? 0) + 1;
  }
  return {
    ok: true,
    dir,
    dirs: dirs.length,
    looseFiles: loose.length,
    sampled,
    judged,
    sampledBad,
    bad: sampledBad.length,
    legacyBad: sampled.filter((s) => legacyNamingViolates(s.name)).length,
    forms,
    naming: policy.naming,
    policyInfo: { where: policy.where, file: policy.file, namingSource: policy.namingSource, forms: policy.naming.forms.length, exempt: policy.naming.exempt.length, assets: policy.naming.assets.size },
  };
}

/** ④ _archive 命名规范 + README（命名口径见 sampleArchiveNaming）。 */
export function checkArchiveNaming(dshRoot, limit = AUDIT_SAMPLE.naming, opts = {}) {
  const s = sampleArchiveNaming(dshRoot, limit, opts);
  if (!s.ok) return [{ id: 'archive-naming', level: 'warn', message: '读不到 _archive 目录' }];
  const findings = [];
  const cl = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadTidyPolicy(dshRoot, opts);
  const formList = cl.naming.forms.map((f) => f.id).join('/');
  const legacyNote = `旧正则（\\w 不含 - 的规范原文）同日会误报 ${s.legacyBad}/${s.sampled.length}`;
  if (s.bad) {
    findings.push({
      id: 'archive-naming', level: 'warn',
      message: `_archive 命名不规范 ${s.bad}/${s.sampled.length}：${s.sampledBad.slice(0, 6).join(', ')}`,
      detail: `规范（${POLICY_FILE_NAME} · archiveNaming）：形态 ${formList} + 结构性例外 + 常驻资产白名单。${legacyNote}。**改名一律 L3（只出建议）**——14 个前缀被生产脚本用于选最新备份、12 个目录被桌面脚本硬依赖。`,
      noncompliant: s.sampledBad,
    });
  } else {
    findings.push({
      id: 'archive-naming', level: 'ok',
      message: `_archive 命名 ${s.sampled.length}/${s.sampled.length} 合规（形态 ${formList}）· ${legacyNote}`,
      detail: `口径来源：${cl.where === 'builtin' ? '内置默认（策略文件缺失）' : cl.file}`,
    });
  }
  const readme = path.join(s.dir, 'README.md');
  const readmeExists = fs.existsSync(readme);
  let readmeAge = '';
  if (readmeExists) {
    try {
      const days = (Date.now() - fs.statSync(readme).mtimeMs) / 86400000;
      readmeAge = `最近生成 ${days.toFixed(1)} 天前（重跑：node tools\\dsh-butler\\gen-archive-readme.mjs）`;
    } catch { /* ignore */ }
  }
  findings.push(readmeExists
    ? { id: 'archive-readme', level: 'ok', message: `_archive/README.md 存在（${readmeAge}）` }
    : { id: 'archive-readme', level: 'warn', message: '_archive 缺 README.md（归档约定与目录索引）', detail: '生成：node tools\\dsh-butler\\gen-archive-readme.mjs' });
  return findings;
}

/** ⑤ 变更流水是否记（最近 N 天）。 */
export function checkChangelog(dshRoot, now = Date.now()) {
  const dir = path.join(dshRoot, 'docs', '变更流水');
  const d = new Date(now);
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.md`;
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    return [{ id: 'changelog', level: 'warn', message: `本月变更流水不存在：docs\\变更流水\\${name}`, detail: '凡改过生产文件 → 记一行（docs\\变更流水\\YYYY-MM.md，最新在最上）。' }];
  }
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
  const ageDays = (now - mtimeMs) / 86400000;
  if (ageDays > CHANGELOG_STALE_DAYS) {
    return [{ id: 'changelog', level: 'warn', message: `变更流水 ${name} 已 ${ageDays.toFixed(1)} 天未更新`, detail: '若最近改过生产文件 → 补记一行；确实没改动可忽略。' }];
  }
  return [{ id: 'changelog', level: 'ok', message: `变更流水 ${name} 最近更新 ${ageDays.toFixed(1)} 天前` }];
}

/** ⑥ 文档头部元信息（抽样跑 docs-audit 规则）。 */
export async function checkDocsMeta(dshRoot, sample = 10) {
  const dir = path.join(dshRoot, 'docs');
  // 统一遍历器（P-2）：内容 reparse point 不穿透（docs 不在根级挂载点白名单里 → 其下 junction 一律跳过）
  const tree = walkTree(dir, { maxDepth: 3 });
  const files = tree.files.filter((f) => /\.md$/i.test(f.path)).map((f) => ({ full: f.path, mtimeMs: f.mtimeMs }));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = files.slice(0, sample);
  const rules = loadRules();
  const docRule = [];
  for (const r of rules) {
    const mod = await r.loader().catch(() => null);
    const def = mod?.default ?? mod?.rule ?? null;
    if (def?.id === 'docs-audit') docRule.push(def);
  }
  if (!docRule.length) return [{ id: 'docs-meta', level: 'ok', message: 'docs-audit 规则未加载（跳过）' }];
  const bad = [];
  for (const f of picked) {
    let text = '';
    try { text = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    const raw = await docRule[0].check({ mode: 'archive-audit', file: f.full, target: f.full, text });
    const list = Array.isArray(raw) ? raw : (raw && raw.ok === false ? [raw] : []);
    const blocks = list.filter((x) => (x.level ?? 'warn') === 'block');
    if (blocks.length) bad.push({ file: path.relative(dshRoot, f.full), message: blocks[0].message });
  }
  if (bad.length) {
    return [{
      id: 'docs-meta', level: 'warn',
      message: `最近 ${picked.length} 篇文档中 ${bad.length} 篇结构不合规`,
      detail: bad.slice(0, 5).map((b) => `${b.file}: ${b.message}`).join(' | '),
    }];
  }
  return [{ id: 'docs-meta', level: 'ok', message: `最近 ${picked.length} 篇文档结构合规` }];
}

/** 根目录一级的 reparse point（挂载点）名单——用于报告"统计口径是否覆盖了外移目录"。 */
export function rootJunctions(dshRoot) {
  try {
    return fs.readdirSync(dshRoot, { withFileTypes: true }).filter((e) => e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** 全量归档审计。 */
export async function auditArchive(opts = {}) {
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const home = opts.home ?? dshHome();
  // [11a] 规范单一数据源：白名单 / 命名 / 三件套 / 阈值 全从这里取
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadTidyPolicy(dshRoot, home);
  const whitelist = resolveRootWhitelist(dshRoot, { home, policy });
  const checks = [];
  checks.push(...checkRootWhitelist(dshRoot, { whitelist, policy }));
  checks.push(...checkTmpBacklog(dshRoot, { policy }));
  checks.push(...checkBackupTrio(dshRoot, opts.desktop, opts.recentLimit ?? AUDIT_SAMPLE.backup, { policy, home }));
  checks.push(...checkArchiveNaming(dshRoot, opts.archiveLimit ?? AUDIT_SAMPLE.naming, { policy, home }));
  checks.push(...checkChangelog(dshRoot, opts.now ?? Date.now()));
  checks.push(...await checkDocsMeta(dshRoot, opts.docsSample ?? 10));
  // 【2026-10-14 · V2.9 封口清单 J L478 · 卡「施工·封口①J域README生成侧」】
  // 可选步：`_archive/README.md` **缺失/过期即生成**（缺省关 ⇒ 本函数对所有人保持只读语义）。
  //   · 谁开它：① 唯一自动入口 = tickd job `tidy`（每 12h）→ `butler-tidy-tick.mjs` 的 audit 采集器；
  //             ② 人工 = 本 CLI `--fix-readme`；缺省（面板/日报/5 个单测直调）**一律不写盘**。
  //   · 为什么不做进 `checkArchiveNaming()`：那是**共享只读检查点**（面板 / 日报 / 单测都调它），
  //     在里面写盘会让"审计"变成有副作用的动词 —— 每次调用都重写 README（正文含生成时间 ⇒ 每次都不同）。
  //   · 为什么动态 import：`lib/archive-readme.mjs` 单向依赖本模块 ⇒ 静态 import 成环；
  //     动态失败可降级成"生成不可用"结果，不炸整轮审计。
  //   · 结果**刻意不进 `checks`**（只作返回体的独立字段）：9 个检查点的 `produced` 口径一字不动，
  //     面板/复核表零连锁漂移；呈现责任交给调用方（tidy-tick 落 state + 审计流水一行）。
  let readmeEnsure = null;
  if (opts.ensureReadme === true) {
    try {
      const arm = await import('./lib/archive-readme.mjs');
      readmeEnsure = arm.ensureArchiveReadme(dshRoot, {
        out: opts.readmeOut,
        minAgeDays: opts.readmeMinAgeDays,
        dryRun: opts.readmeDryRun === true,
        // 夹具/验收隔离用：home（策略回落位置）与 desktop（孤儿检测扫的桌面）随调用方透传
        home: opts.home,
        desktop: opts.desktop,
      });
      readmeEnsure = { ...readmeEnsure, describe: arm.describeReadmeEnsure(readmeEnsure) };
    } catch (e) {
      const msg = String(e?.message ?? e);
      readmeEnsure = {
        action: 'failed', reason: 'module-unavailable', error: msg, out: null, bytes: 0,
        dryRun: opts.readmeDryRun === true, state: null, version: null,
        describe: `_archive/README.md 自动生成不可用：${msg}`,
      };
    }
  }
  const summary = { block: 0, warn: 0, ok: 0 };
  for (const c of checks) summary[c.level] = (summary[c.level] ?? 0) + 1;
  const missing = AUDIT_CHECKPOINT_IDS.filter((id) => !checks.some((c) => c.id === id));
  // B4（2026-10-10）起 missing 应为空（每检查点必产行）；保留字段做**回归哨兵** —— 若哪天又变非空，
  // 说明有人把"仅异常产行"写回来了（旧口径的坑），面板/日报会立刻看见。
  const silent = [...missing];
  return {
    ok: summary.block === 0,
    at: new Date().toISOString(),
    dshRoot,
    version: ARCHIVE_AUDIT_VERSION,
    summary,
    /** 检查点口径（§14.9 的「9 条 finding」= 本清单的 9 个检查点；produced 为本轮实际产出行数） */
    checkpoints: { ids: [...AUDIT_CHECKPOINT_IDS], total: AUDIT_CHECKPOINT_IDS.length, produced: checks.length, missing, silent },
    samples: { backup: opts.recentLimit ?? AUDIT_SAMPLE.backup, naming: opts.archiveLimit ?? AUDIT_SAMPLE.naming, docs: opts.docsSample ?? 10 },
    rootWhitelist: { source: whitelist.source, file: whitelist.file, note: whitelist.note, dirs: whitelist.dirs.length, files: whitelist.files.length },
    /** [11a] 规范来源（面板 / 报告可见）：策略文件在哪、命名规范来自策略还是内置 */
    policy: {
      where: policy.where,
      file: policy.file,
      namingSource: policy.namingSource,
      forms: policy.naming.forms.length,
      exempt: policy.naming.exempt.length,
      assets: policy.naming.assets.size,
      drift: policy.drift,
      errors: policy.errors,
    },
    rootJunctions: rootJunctions(dshRoot),
    /** 见上方可选步注释：`ensureReadme` 未开时为 null（缺省态的返回体与接线前**逐字节等价**）。 */
    readmeEnsure,
    checks,
  };
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

const USAGE = [
  'butler-audit-archive —— P5 归档审计 + P8 收纳审计（根目录 / _tmp / 备份三件套 / _archive / 变更流水 / 文档元信息）',
  '  node butler-audit-archive.mjs [--json] [--dsh-root <dir>] [--docs-sample N]',
  '  node butler-audit-archive.mjs --orphans   # 列出全部「缺恢复脚本 / 缺 manifest / 桌面无入口」的备份目录',
  '  node butler-audit-archive.mjs --policy    # 打印策略文件解析结果（来源 / 形态数 / 漂移）',
  '  node butler-audit-archive.mjs --fix-readme # 顺带把缺失/过期的 _archive/README.md 生成一次（缺省只审计、不写盘）',
].join('\n');

if (isMainEntry()) {
  const argv = process.argv.slice(2);
  const opt = { json: false, dshRoot: null, docsSample: 10, showOrphans: false, showPolicy: false, ensureReadme: false };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') opt.json = true;
      else if (a === '--orphans') opt.showOrphans = true;
      else if (a === '--policy') opt.showPolicy = true;
      else if (a === '--fix-readme') opt.ensureReadme = true;
      else if (a === '--dsh-root') opt.dshRoot = argv[++i];
      else if (a === '--docs-sample') opt.docsSample = Number(argv[++i]);
      else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
      else throw new Error(`未知参数：${a}`);
    }
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  const dshRoot = opt.dshRoot ?? DEFAULT_DSH_ROOT;
  if (opt.showOrphans) {
    const det = detectOrphanBackups(dshRoot, {});
    console.log(`孤儿恢复脚本检测（${det.dir}）：扫描 ${det.scanned} 个目录（常驻资产 ${det.assets.length} 个单列不计）`);
    const line = (label, arr) => {
      console.log(`\n== ${label}（${arr.length}）==`);
      for (const n of arr) console.log(`  - ${n}`);
    };
    line('缺一键恢复脚本', det.withoutRestore);
    line('缺 manifest / README 索引', det.withoutManifest);
    line('有恢复脚本但桌面无入口（§2.8 口径的孤儿备份）', det.noDesktopEntry);
    console.log(`\n常驻资产（不参与三件套判定）：${det.assets.join(', ') || '无'}`);
    process.exit(0);
  }
  if (opt.showPolicy) {
    const policy = loadTidyPolicy(dshRoot, {});
    console.log(`策略文件：where=${policy.where} file=${policy.file ?? '(无 → 内置默认)'}`);
    console.log(`  命名规范来源=${policy.namingSource} 形态=${policy.naming.forms.length} 例外=${policy.naming.exempt.length} 常驻资产=${policy.naming.assets.size}`);
    console.log(`  形态：${policy.naming.forms.map((f) => `${f.id}(${f.label})`).join(' / ')}`);
    console.log(`  例外：${policy.naming.exempt.map((e) => e.label).join(' / ')}`);
    console.log(`  常驻资产：${[...policy.naming.assets].join(', ')}`);
    console.log(`  三件套判据：restore=${policy.trio.restoreKeywords.join('|')} ext=${policy.trio.restoreExts.join(',')} manifest=${policy.trio.manifestPattern}`);
    console.log(`  _tmp 阈值：${policy.tmp.warnFiles} 文件 / ${policy.tmp.warnBytes} 字节`);
    console.log(`  白名单来源：${policy.rootWhitelist ? '策略文件' : '策略无 rootWhitelist → 回落 wrapup 内联'}`);
    if (policy.drift.length) console.log(`  ⚠️ 漂移：${policy.drift.join(' | ')}`);
    if (policy.errors.length) console.log(`  ⚠️ 解析异常：${policy.errors.join(' | ')}`);
    process.exit(0);
  }
  const result = await auditArchive(opt);
  if (opt.json) process.stdout.write(JSON.stringify(result) + '\n');
  else {
    const mark = { block: '⛔', warn: '🟡', ok: '✅' };
    console.log(`归档审计（${result.dshRoot}）：block=${result.summary.block} warn=${result.summary.warn} ok=${result.summary.ok}`);
    for (const c of result.checks) console.log(`  ${mark[c.level] ?? '·'} [${c.id}] ${c.message}`);
    console.log(`  规范来源：策略文件 ${result.policy.file ?? '(缺失→内置默认)'}（${result.policy.where}）· 命名规范 ${result.policy.namingSource} · 形态 ${result.policy.forms} 种 · 白名单来源 ${result.rootWhitelist.source}${result.policy.drift.length ? ' · ⚠️ 双副本漂移' : ''}`);
    if (result.readmeEnsure) console.log(`  📄 README 自动生成：${result.readmeEnsure.describe ?? result.readmeEnsure.action}`);
  }
  process.exit(result.ok ? 0 : 1);
}
