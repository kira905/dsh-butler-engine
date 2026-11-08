// dsh-butler / lib/archive-readme.mjs —— `_archive/README.md`：采集 + 渲染 + **「缺失/过期即生成」**
//
// 沿革（2026-10-14 · V2.9 封口清单 J L478 · 卡「施工·封口①J域README生成侧」）：
//   原 `gen-archive-readme.mjs` 头部写「生成物，**不是自动改写** —— 不挂 tick、不进计划任务，只在人跑它时…」；
//   检测侧（审计发现缺失/过旧）早已自动在跑（tickd job `tidy` 每 12h → `butler-audit-archive.mjs` 的
//   `archive-readme` 检查点），**生成侧此前只能人工**。本卡把生成侧接进同一流程：
//     `auditArchive({ensureReadme:true})` → `ensureArchiveReadme()`（本模块）
//   接线范围只有一处自动入口 = `butler-tidy-tick.mjs` 的 audit 采集器（tickd job `tidy` 每轮 spawn）；
//   共享只读检查点 `checkArchiveNaming()` **不写盘**（面板/日报/单测都调它，写盘会变"重复写 README"）。
//
// 依赖方向（单向，**避免循环 import**）：
//   本模块 → `../butler-audit-archive.mjs`（借 loadTidyPolicy / detectOrphanBackups / matchArchiveName …）
//   `../butler-audit-archive.mjs` → 本模块**只动态 import**（在可选步里；失败降级成一行 finding，不炸审计）
//   `gen-archive-readme.mjs` → 本模块（原语搬来此处后 **re-export**，既有 import 面零变化）
//
// 全程**只读归档区实体**：只 readdir / stat / 读文件；唯一写入 = `_archive/README.md`（生成物本身）。
// 归档区的改名/搬移/删除一律 L3（人工拍板），本模块不碰。
import fs from 'node:fs';
import path from 'node:path';
import {
  loadTidyPolicy, detectOrphanBackups, matchArchiveName, legacyNamingViolates, DEFAULT_DSH_ROOT,
} from '../butler-audit-archive.mjs';

/** 生成物文件名（`_archive` 顶层；也是「归档索引」约定的固定名）。 */
export const README_FILE_NAME = 'README.md';
/** 生成器/判定口径版本（写进结果与 finding，便于面板/报告判"判定有没有换过口径"）。 */
export const ARCHIVE_README_VERSION = '1.0.0';
/**
 * 索引「最长静默期」（天）：归档区长期没变化时，也至少以此频率刷新一次
 * （正文口径演进 / 生成器版本变化能被带出来）。缺省 30 天。
 */
export const README_STALE_DAYS_DEFAULT = 30;

export const README_ACTION_LABEL = Object.freeze({
  created: '已生成',
  refreshed: '已刷新（索引过期）',
  'would-create': '（dry-run）将生成',
  'would-refresh': '（dry-run）将刷新',
  skipped: '无需生成（索引新鲜）',
  failed: '生成失败',
});

/** 生成物路径（唯一口径；夹具/验收可经 opts.out 覆盖成隔离路径）。 */
export function archiveReadmePath(dshRoot = DEFAULT_DSH_ROOT) {
  return path.join(dshRoot, '_archive', README_FILE_NAME);
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const mib = (b) => (b / 1048576).toFixed(1) + ' MB';

/**
 * 采集归档区实况（只读）。**原语**：2026-10-14 自 `gen-archive-readme.mjs` 原样迁入（行为逐字未改，
 * 只多接了两个可选入参 `opts.home` / `opts.desktop` 供夹具隔离）。
 * @param {string} dshRoot
 * @param {{home?:string, desktop?:string, policy?:object}} [opts]
 */
export function collectArchive(dshRoot = DEFAULT_DSH_ROOT, opts = {}) {
  const policy = loadTidyPolicy(dshRoot, opts);
  const det = detectOrphanBackups(dshRoot, { ...opts, policy });
  const loose = [];
  try {
    for (const e of fs.readdirSync(det.dir, { withFileTypes: true })) {
      if (e.isDirectory()) continue;
      let size = 0, mtimeMs = 0;
      try { const st = fs.statSync(path.join(det.dir, e.name)); size = st.size; mtimeMs = st.mtimeMs; } catch { /* ignore */ }
      loose.push({ name: e.name, size, mtimeMs });
    }
  } catch { /* ignore */ }
  const judged = det.items.map((i) => ({ ...i, judge: matchArchiveName(i.name, policy.naming), legacyViolates: legacyNamingViolates(i.name) }));
  return { policy, det, loose, judged, dshRoot };
}

/** 渲染 README 正文。**原语**：自 `gen-archive-readme.mjs` 原样迁入（逐字未改）。 */
export function renderReadme(collected, now = Date.now()) {
  const { policy, det, loose, judged } = collected;
  const naming = policy.naming;
  const dirs = judged.length;
  const bad = judged.filter((j) => !j.judge.ok).map((j) => j.name);
  const legacyBad = judged.filter((j) => j.legacyViolates).length;
  const assets = judged.filter((j) => j.judge.kind === 'asset').map((j) => j.name);
  const exempt = judged.filter((j) => j.judge.kind === 'exempt');
  const forms = {};
  for (const j of judged) {
    const key = j.judge.ok ? (j.judge.kind === 'asset' ? '常驻资产白名单' : j.judge.kind === 'exempt' ? '结构性例外' : j.judge.label) : '违规';
    forms[key] = (forms[key] ?? 0) + 1;
  }
  const legacy = naming.legacy?.measured ?? {};
  const L = [];
  L.push('# _archive 归档索引与约定');
  L.push('');
  L.push('> **本文件是生成物**：`node tools/dsh-butler/gen-archive-readme.mjs`（人跑强制重写）；');
  L.push('> 也可由审计流程自动补齐 —— tickd job `tidy`（每 12h）检测到**缺失/过期**时自动生成（2026-10-14 起 · 封口① J L478）。');
  L.push(`> 生成时间：${fmtTime(now)} ｜ 生成器版本：P8 [11a]（2026-09-10）｜ 设备：本机`);
  L.push('> 约定正文的**权威源** = `tools/dsh-butler/butler-tidy-policy.json`（审计器 `butler-audit-archive.mjs` 与本文件同源读它，杜绝两套口径）。');
  L.push('> **本文件只是索引与说明**：归档区的改名/搬移/删除一律 L3（人工拍板），审计器与生成器全程只读。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 一、归档约定（规范）');
  L.push('');
  L.push('### 1.1 命名（`_archive` 顶层目录）');
  L.push('');
  L.push(`判定顺序：**常驻资产白名单 → 结构性例外 → 允许形态**。形态表（前缀类 \`${naming.prefixClass}\`）：`);
  L.push('');
  L.push('| 形态 id | 模式（尾部） | 说明 | 当前数量 |');
  L.push('|---|---|---|---|');
  for (const f of naming.forms) {
    L.push(`| \`${f.id}\` | \`${f.pattern}\` | ${f.label} | ${forms[f.label] ?? 0} |`);
  }
  L.push('');
  L.push('结构性例外（不计违规）：');
  L.push('');
  for (const e of naming.exempt) L.push(`- \`${e.pattern}\` —— ${e.label}（当前 ${judged.filter((j) => e.re.test(j.name)).length} 个目录命中）`);
  L.push('');
  L.push(`常驻资产白名单（无日期、长期驻留，不参与命名判定）：${assets.map((a) => `\`${a}\``).join('、') || '（无）'}`);
  L.push('');
  L.push('### 1.2 规范修订说明（旧规范是坏的）');
  L.push('');
  L.push('旧正则 `^[\\w.\\u4e00-\\u9fa5]+-\\d{8}(?:T\\d{6})?$` 的前缀字符类用了 `\\w`，**`\\w` 不含连字符 `-`**，');
  L.push('而归档区几乎所有目录都是多连字符名（`butler-panel-deploy-…`、`_tmp-archive-…`）→ 该规范**对全库 100% 误报**。');
  L.push('');
  L.push('| 口径 | 违规数 | 说明 |');
  L.push('|---|---|---|');
  L.push(`| ① 规范原文（旧正则） | ${legacy.byLegacy ?? '124 / 124（100%）'} | 0 个目录能通过它自己的规范；连告警文案里的示例 \`butler-core-20260909T164108\` 也通不过 |`);
  L.push(`| ② 仅修正正则（前缀类补 \`-\`） | ${legacy.byPrefixFixedOnly ?? '目录 84 / 112；含散落文件 96 / 124'} | 只补连字符 → 仍把「没有日期」的常驻资产、多种既有时间形态判违规 |`);
  L.push(`| ③ 新规范（形态 + 例外 + 常驻白名单） | **${bad.length} / ${dirs}** | 本机 ${fmtTime(now)} 实测：承认既有形态，**一个目录名都没改** |`);
  L.push('');
  L.push('修订原则：**改规范，不改目录名**——14 个前缀被生产脚本用于「自动选最新备份」、12 个目录被桌面 `restore-*.cmd` 硬依赖，改名即断链。');
  L.push('');
  L.push('### 1.3 备份三件套（persona 铁律）');
  L.push('');
  L.push('改动生产文件前必须：**① 备份到 `_archive/<任务>-<时间戳>/` ② 同时写一键恢复脚本（放桌面）③ 留 manifest/README 索引**。');
  L.push(`判据（取自策略文件）：恢复脚本 = 文件名含 ${policy.trio.restoreKeywords.map((k) => `\`${k}\``).join('/')} 且扩展名 ∈ ${policy.trio.restoreExts.join(' ')}（深度 ≤ ${policy.trio.restoreMaxDepth}）；`);
  L.push(`manifest = \`${policy.trio.manifestPattern}\`（深度 ≤ ${policy.trio.manifestMaxDepth}）；桌面入口 = 桌面脚本内声明了 \`_archive\\<目录名>\`。`);
  L.push('');
  L.push('### 1.4 junction 与边界');
  L.push('');
  L.push('- 根级 6 个挂载点 junction（`_archive`/`_tmp`/`generated`/`logs`/`snapshots`/`backups`）→ 指向 `<offsync>\\…`，**跟随统计、不删不搬**。');
  L.push('- 归档区**内部**的 reparse point（历史对端迁移沙箱）→ 任何递归遍历**不穿透**（`lstatSync().isSymbolicLink()` 为真即跳过）。');
  L.push('- 所有「路径相等」判断必须先 `fs.realpathSync` 归一（junction 字符串比较会静默失效）。');
  L.push('- 桌面是主人私有区：只读扫 `restore-*`，其余一概不碰。');
  L.push('');
  L.push('### 1.5 归档桶命名（跨机对账）');
  L.push('');
  L.push('临时区归档桶建议 `_tmp-archive-<YYYYMMDD>-<host-a|host-c>`——归档状态是**单机事实**，桶名带设备短码才能对账（2026-09-09 跨机同名桶内容不同踩过）。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 二、当前规模（生成时快照）');
  L.push('');
  L.push(`- 顶层 **${dirs + loose.length}** 项 = 目录 ${dirs} + 散落文件 ${loose.length}`);
  L.push(`- 命名合规 **${dirs - bad.length}/${dirs}**（同口径下旧正则会误报 ${legacyBad}/${dirs}）`);
  L.push(`- 缺一键恢复脚本 **${det.withoutRestore.length}/${det.scanned}** ｜ 缺 manifest **${det.withoutManifest.length}/${det.scanned}** ｜ 有脚本但桌面无入口（孤儿）**${det.noDesktopEntry.length}**`);
  L.push(`- 常驻资产 ${assets.length} 个（不参与三件套判定）：${assets.map((a) => `\`${a}\``).join('、') || '（无）'}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 三、孤儿恢复脚本检测');
  L.push('');
  L.push('完整清单随时可重算：`node tools/dsh-butler/butler-audit-archive.mjs --orphans`。');
  L.push('');
  L.push(`### 3.1 缺一键恢复脚本（${det.withoutRestore.length}）`);
  L.push('');
  for (const n of det.withoutRestore.slice(0, 60)) L.push(`- ${n}`);
  if (det.withoutRestore.length > 60) L.push(`- …（其余 ${det.withoutRestore.length - 60} 个见 \`--orphans\`）`);
  L.push('');
  L.push(`### 3.2 缺 manifest / README 索引（${det.withoutManifest.length}）`);
  L.push('');
  for (const n of det.withoutManifest.slice(0, 60)) L.push(`- ${n}`);
  if (det.withoutManifest.length > 60) L.push(`- …（其余 ${det.withoutManifest.length - 60} 个见 \`--orphans\`）`);
  L.push('');
  L.push(`### 3.3 有恢复脚本但桌面无入口（${det.noDesktopEntry.length}）`);
  L.push('');
  L.push('> §2.8 口径的「孤儿备份」：**不是故障**——persona 约定"改动确认稳定后，恢复脚本与备份一起归档"，桌面入口被有意撤下。');
  L.push('');
  for (const n of det.noDesktopEntry.slice(0, 60)) L.push(`- ${n}`);
  if (det.noDesktopEntry.length > 60) L.push(`- …（其余 ${det.noDesktopEntry.length - 60} 个见 \`--orphans\`）`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 四、目录索引（全量，按最近修改倒序）');
  L.push('');
  L.push('| 目录 | 最近修改 | 命名形态 | 一键恢复脚本 | manifest | 桌面入口 |');
  L.push('|---|---|---|---|---|---|');
  for (const j of judged) {
    const form = j.judge.ok ? (j.judge.kind === 'form' ? `\`${j.judge.id}\`` : j.judge.kind === 'asset' ? '常驻资产' : '结构性例外') : '**违规**';
    L.push(`| ${j.name} | ${fmtTime(j.mtimeMs)} | ${form} | ${j.restoreScripts.length ? `✅ ${j.restoreScripts[0]}${j.restoreScripts.length > 1 ? ` +${j.restoreScripts.length - 1}` : ''}` : '—'} | ${j.hasManifest ? '✅' : '—'} | ${j.desktopEntry ? '✅' : '—'} |`);
  }
  L.push('');
  L.push(`## 五、顶层散落文件（${loose.length}）`);
  L.push('');
  L.push('> 归档区根目录下的裸文件（历史 `.bak`）。命名规范只管目录，本类不计违规；归属由主人决定（不自动搬移）。');
  L.push('');
  L.push('| 文件 | 大小 | 最近修改 |');
  L.push('|---|---|---|');
  for (const f of loose.sort((a, b) => b.mtimeMs - a.mtimeMs)) L.push(`| ${f.name} | ${mib(f.size)} | ${fmtTime(f.mtimeMs)} |`);
  L.push('');
  return L.join('\n');
}

/**
 * 「索引新鲜度」判定（只读，纯计算）。
 *
 * 判据（任一成立 ⇒ stale）：
 *   ① `missing`        —— 生成物不存在；
 *   ② `index-behind`   —— 存在，但 `_archive` 顶层有**晚于它**的条目（索引漏了东西）；
 *   ③ `aged`           —— 存在，但已超过 `minAgeDays`（缺省 30 天）没刷新（口径演进兜底）。
 * ⚠️ 比较时**排除生成物自身**（它就是被判定对象；它在 §五 表格里会列出自己，属既有正文口径）。
 * @param {string} dshRoot
 * @param {{out?:string, minAgeDays?:number, now?:number}} [opts]
 */
export function readmeState(dshRoot = DEFAULT_DSH_ROOT, opts = {}) {
  const out = opts.out ?? archiveReadmePath(dshRoot);
  const dir = path.join(dshRoot, '_archive');
  const minAgeDays = Number.isFinite(opts.minAgeDays) ? Number(opts.minAgeDays) : README_STALE_DAYS_DEFAULT;
  const now = opts.now ?? Date.now();
  let exists = false, mtimeMs = 0;
  try { const st = fs.statSync(out); exists = st.isFile(); mtimeMs = st.mtimeMs; } catch { exists = false; }
  const outKey = path.resolve(out).replace(/\//g, '\\').toLowerCase();
  let newestEntryMs = 0, newestEntry = null, entries = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (path.resolve(full).replace(/\//g, '\\').toLowerCase() === outKey) continue;
      let m = 0;
      try { m = fs.statSync(full).mtimeMs; } catch { continue; }
      entries++;
      if (m > newestEntryMs) { newestEntryMs = m; newestEntry = e.name; }
    }
  } catch { /* 目录读不到 → 保持 0（缺目录时 exists 必为 false ⇒ 仍判 missing） */ }
  const reasons = [];
  if (!exists) reasons.push('missing');
  else {
    if (newestEntryMs > mtimeMs) reasons.push('index-behind');
    if ((now - mtimeMs) / 86400000 > minAgeDays) reasons.push('aged');
  }
  return {
    out, dir, exists, mtimeMs,
    ageDays: exists ? (now - mtimeMs) / 86400000 : null,
    entries, newestEntry, newestEntryMs, minAgeDays, now,
    stale: reasons.length > 0,
    reasons,
    reason: reasons[0] ?? 'fresh',
  };
}

/**
 * 「检测到缺失/过期即生成」的唯一实现（**幂等**）。
 *
 * 幂等保证（两跑一致、第二次不重写 —— 夹具 `drill/idempotency` 实测）：
 *   写盘前先 `readmeState()` 判定；新鲜（`stale === false` 且未 `force`）⇒ **直接返回 skipped、不碰磁盘**
 *   ⇒ 第二次调用的 `bytes` = 0、目标文件 `mtime`/`sha256` **一字不变**。
 *   写盘后 `mtime = now > 归档区顶层最新条目 mtime`（且 `ageDays ≈ 0 < minAgeDays`）⇒ 下一轮判定自然为新鲜。
 *   ⚠️ 正文含「生成时间」行 ⇒ **不能靠"内容比对"判幂等**（每次生成都不同）——幂等门只有新鲜度判定这一道。
 *
 * 失败绝不抛：渲染/写盘异常 ⇒ `action:'failed'`（调用方记一行 finding，审计结论不受影响）。
 * @param {string} dshRoot
 * @param {{out?:string, dryRun?:boolean, minAgeDays?:number, force?:boolean, now?:number, home?:string, desktop?:string}} [opts]
 * @returns {{action:'created'|'refreshed'|'would-create'|'would-refresh'|'skipped'|'failed', reason:string,
 *            out:string, bytes:number, state:object, dryRun:boolean, at:string, elapsedMs:number,
 *            error?:string, version:string}}
 */
export function ensureArchiveReadme(dshRoot = DEFAULT_DSH_ROOT, opts = {}) {
  const t0 = Date.now();
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  const out = opts.out ?? archiveReadmePath(dshRoot);
  const dryRun = opts.dryRun === true;
  const base = { out, dryRun, at, version: ARCHIVE_README_VERSION };
  const state = readmeState(dshRoot, { out, minAgeDays: opts.minAgeDays, now });
  const fail = (reason, error) => ({ ...base, action: 'failed', reason, error, bytes: 0, state, elapsedMs: Date.now() - t0 });

  if (!state.stale && opts.force !== true) {
    return { ...base, action: 'skipped', reason: state.reason, bytes: 0, state, elapsedMs: Date.now() - t0 };
  }

  let text;
  try {
    text = renderReadme(collectArchive(dshRoot, opts), now);
  } catch (e) {
    return fail('render-error', String(e?.message ?? e));
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (dryRun) {
    return {
      ...base, action: state.exists ? 'would-refresh' : 'would-create',
      reason: state.reason, bytes, state, elapsedMs: Date.now() - t0,
    };
  }
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
  } catch (e) {
    return fail('write-error', String(e?.message ?? e));
  }
  return {
    ...base, action: state.exists ? 'refreshed' : 'created',
    reason: state.reason, bytes, state, elapsedMs: Date.now() - t0,
  };
}

/** 一行人话描述（审计 finding / 日志 / 报告共用同一句，避免三处口径漂移）。 */
export function describeReadmeEnsure(r) {
  if (!r) return 'README 自动生成：未执行';
  const label = README_ACTION_LABEL[r.action] ?? r.action;
  const head = `_archive/README.md ${label}`;
  if (r.action === 'failed') return `${head}（${r.reason}${r.error ? `：${r.error}` : ''}）`;
  if (r.action === 'skipped') {
    const age = Number.isFinite(r.state?.ageDays) ? `，最近生成 ${r.state.ageDays.toFixed(1)} 天前` : '';
    return `${head}（判据：${r.reason}${age}）`;
  }
  const reasonText = { missing: '缺失', 'index-behind': '索引落后于归档区最新条目', aged: `超过 ${r.state?.minAgeDays} 天未刷新` }[r.reason] ?? r.reason;
  return `${head}（触发：${reasonText}；${(r.bytes / 1024).toFixed(1)} KB${r.dryRun ? '；dry-run 未落盘' : ''}）`;
}
