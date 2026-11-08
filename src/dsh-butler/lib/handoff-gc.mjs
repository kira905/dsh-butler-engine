// dsh-butler / lib/handoff-gc.mjs —— `_archive\handoff-*` 桶 GC 的**唯一实现**（③ 包 C-4 收口）
//
// 方案依据：docs\跨线契约包-方案-20260917.md §3.4（C-4 · I4 处方）+ §5 判据 4/5 + §6 表 2/表 4 + §7.2
//   落地卡：③-3「handoff 桶 GC 收口」（2026-09-20 12:15 窗口授权：沙箱真删 + 生产 dry-run）
//
// ── 这个模块治什么（I4）────────────────────────────────────────────────────────
//   改前：`handoff.mjs` 的 `gcArchives()` 直接 `fs.rmSync(d.full, {recursive:true, force:true})` ——
//   ① 删之前不摘凭据（桶里的 `restore*.cmd` / `restore.mjs` / `backup-manifest.json` / `files/`
//      随桶一起消失，实测 3 个射程内桶含凭据）；② 不留任何痕（只有一行 stdout，日报/审计都没有）；
//   ③ 射程靠正则隐式约束、非标准桶"永远没人管"也无人可见。
//
// ── GC 的三条新约束（本模块逐条实现，判据 4/5 机械校验）──────────────────────
//   ① **先摘凭据 → 校验字节 → 再删桶**（顺序写死，半完成态由下一轮 GC 自然收敛）：
//      凭据子集 = 顶层 `restore*.(cmd|mjs|ps1)` · `(backup-)manifest.json`（含 MANIFEST.json 大小写）·
//      `butler-handoff.prev.json` · `files/` 目录（递归）。复制到 `_archive\handoff-keep\<桶名>\`，
//      逐文件**字节数 + sha256** 比对通过才允许删桶主体；任一环节失败 ⇒ **该桶不删** + alert。
//      `handoff-keep` 根不可写 ⇒ **整轮不删**（fail-close，方案 §7.2③）。
//   ② **射程写死**：只覆盖标准命名 `^handoff-\d{8}-\d{6}$`；非标准 `handoff-*` 桶**永不由 GC 删**
//      （实测 11 个非标准桶里含 `restore-*` / `drill-record` —— 那是别的线自己的回滚点），
//      改为在上一轮 GC 汇总审计里**如实列名**，日报段照铺 ⇒ "没人管"变成"有人看见"。
//   ③ **删桶必留痕 + 可见**（2026-09-17 22:20 拍板 = ③ 包必拍 #4 = b，推翻 P9 §5.7 原口径
//      「超期静默清理（属备份，不告警）」）：每轮 GC 写一条 `type:'handoff-gc', scope:'summary'` 审计；
//      每删一个桶写一条 `scope:'bucket'` 明细；keep 自身清理写 `scope:'keep'`。**dry-run 一律不写审计**
//      （零副作用；dry-run 的可读性由 stdout 承担）。
//
// ── 边界（红线圈）──────────────────────────────────────────────────────────────
//   · **唯一删除权**：真删入口只有 `handoff.mjs` 的 `gcArchives()` → `runGc({dryRun:false})`；
//     配套 CLI `handoff-gc.mjs` **只读**（永远 dry-run，不提供真删开关）——防止长出第二条删除入口。
//   · **零主包依赖**：只 import node 内置（本库要能在 DSH 崩掉的场景里被 CLI 单独调用）。
//   · **纯函数可注入**：`now` / `audit` / `alert` / 两个根路径全部可传参 ⇒ 单测与沙箱钻取零生产副作用。
//   · **含链接的桶不删**（保守）：桶内若存在 junction/symlink（`lstat().isSymbolicLink()`）⇒ 跳过该桶
//     + alert。**实测口径（2026-09-20 本机 Node 24 探针 `probe-junction.mjs`）**：① Node 的 `lstat` 认
//     junction（`isSymbolicLink() === true`）② `fs.rmSync(recursive)` 删含 junction 的目录**不会跟删**
//     目标（只摘链接）。⇒ 本防护**不是**为绕开某个已知跟删 bug，而是按 persona 铁律「含 junction 的树
//     绝不递归删」取的保守姿态：行为跨 Node 版本/跨平台不稳，宁可留着让人看，不可赌。
//   · `handoff-keep` **不是异地备份**（方案 §3.4 注 T6）：它与被删桶同盘同树，只是"本机唯一凭据手"；
//     数据主体（桶内非凭据内容）**不可回滚** —— 这句话必须原样出现在日报段文案里。
//
// ── 保留策略（两套，各自单一真源）───────────────────────────────────────────
//   · 桶：最近 `GC_KEEP_MAX = 20` 份 或 `GC_KEEP_DAYS = 30` 天（先到者）—— 原样沿用 P9 §5.7 R12。
//   · 保留区：最近 `KEEP_KEEP_MAX = 20` 份凭据 或 `KEEP_KEEP_DAYS = 90` 天（比桶宽，因为它是回滚最后一手）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
// 只 import 本目录 lib（与 cross-lane.mjs 同款边界：**零主包依赖**，DSH 崩掉也能单独跑 CLI）。
//   用途：把"最近一轮 GC 审计"定位到审计流水文件（`~/.dsh/butler-audit/<YYYY-MM>.jsonl`）——
//   日报段与审计同源（方案 §6 表 3），**不新建状态文件**。
import { butlerPaths, monthKey } from './paths.mjs';
// 【R-065 三件套 · 锁 batchD2（2026-10-19）】唯一删除口的外部判据（共享件）。
//   ⚠️ 与上方「零主包依赖」不冲突：这是**本仓库 tools\lib 下的本地件**，不是 `@deepseek-ai/*` 主包依赖，
//      DSH 崩掉时照样能随本模块一起被 CLI 单独调用。
import { gateDestructive } from '../../lib/production-guard.mjs';

export const HANDOFF_GC_VERSION = '0.1.0';

/** 标准桶（P9 交接器自己造、**唯一**被 GC 覆盖的形态）。 */
export const STANDARD_BUCKET_RE = /^handoff-\d{8}-\d{6}$/;
/** 桶名前缀（非标准桶 = 前缀命中但标准正则不命中）。 */
export const BUCKET_PREFIX = 'handoff-';
/** 凭据保留区目录名（`_archive\handoff-keep`，P8 命名豁免同批登记）。 */
export const KEEP_DIR_NAME = 'handoff-keep';

export const GC_KEEP_MAX = 20;
export const GC_KEEP_DAYS = 30;
export const KEEP_KEEP_MAX = 20;
export const KEEP_KEEP_DAYS = 90;

/** 审计行 scope（日报按 summary 定位"最近一轮"，按 bucket/keep 铺明细）。 */
export const GC_AUDIT_TYPE = 'handoff-gc';
export const GC_SCOPE_SUMMARY = 'summary';
export const GC_SCOPE_BUCKET = 'bucket';
export const GC_SCOPE_KEEP = 'keep';

/** 凭据子集判定（顶层项；目录只认 `files`）。 */
export const CREDENTIAL_FILE_RE = /^restore.*\.(cmd|mjs|ps1)$/i;
export const CREDENTIAL_MANIFEST_RE = /^(backup-)?manifest\.json$/i;
export const CREDENTIAL_PREV_RE = /^butler-handoff\.prev\.json$/i;
export const CREDENTIAL_DIR_RE = /^files$/i;
/** 审计行里列非标准桶名单的上限（单行 <4KB 契约，超出的只计数不列名）。 */
export const NONSTANDARD_LIST_MAX = 40;

// ── 枚举预算（方案 §6 表 2「GC 枚举开销」行 · 落地卡 ③-3.2）────────────────────
//   为什么有这个度量：GC 在**交接器持 `handoff` 锁期间**跑（Depart/Arrive 收尾）。单桶摘凭据是 ms 级，
//   但**归档根自身的目录枚举开销随 `_archive` 顶层目录数线性增长**（实测 783 目录、整轮 tidy 9.1s 量级）。
//   一旦 `_archive` 无限膨胀，GC 会把持锁时长拖长 → 交接窗口被拉长。所以：
//   **决定参数 = 顶层目录数；超界告警 = 枚举 > 5s ⇒ 日报一行**（廉价、可见、不抢注意力）。
/** 归档根顶层枚举的时间预算（毫秒；`enumMs > ENUM_BUDGET_MS` ⇒ 超界）。 */
export const ENUM_BUDGET_MS = 5000;
/** 超界标记（审计 summary 行 `warn` 字段的唯一取值；同时是日报句的判据）。 */
export const ENUM_WARN = 'enum-over-budget';

const msgOf = (e) => String(e?.message ?? e ?? '未知错误');

// ---------------------------------------------------------------- 小工具（只读）

/** 文件 sha256（读不到 → null，调用方按"校验不可用"处理）。 */
export function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return null; }
}

/** 递归统计一棵树（返回 {files, bytes, links}；links>0 = 含 junction/symlink）。 */
export function walkStat(root) {
  const out = { files: 0, bytes: 0, links: 0 };
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      let st = null;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) { out.links++; continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) { out.files++; out.bytes += st.size; }
    }
  };
  walk(root);
  return out;
}

/** 单调毫秒时钟（默认实现；`enumClock` 可注入 ⇒ 单测零等待）。 */
function defaultClock() {
  try { return Number(process.hrtime.bigint()) / 1e6; } catch { return Date.now(); }
}
/** 把时钟差值归一成"取整毫秒、非负"（时钟坏掉/注入错误 → 0，绝不产生 NaN 进审计）。 */
const normMs = (x) => (Number.isFinite(x) && x > 0 ? Math.round(x) : 0);

/**
 * `_archive` 顶层目录名（读不到 → []）。
 * ⚠️ 2026-09-20（卡 ③-3.2）：实现由「readdir 只认 Dirent 类型」升级为「**readdir + 逐项 lstat**」——
 *   这就是要被计时的那个开销本身（表 2 的"目录枚举开销"），语义与旧实现等价：
 *   真目录收下；仅在 `lstat` 说是链接时才 `stat` 跟随判一次"是否指向目录"（旧实现同款只对链接 stat）。
 */
export function listTopLevelDirs(root) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    const full = path.join(root, e.name);
    let st = null;
    try { st = fs.lstatSync(full); } catch { continue; }   // 逐项 stat（= 被计时的开销）
    if (st.isDirectory()) { out.push(e.name); continue; }
    if (!st.isSymbolicLink()) continue;
    try { if (fs.statSync(full).isDirectory()) out.push(e.name); } catch { /* 断链/无权限 → 不当目录 */ }
  }
  return out;
}

/**
 * 归档根**顶层目录枚举 + 耗时**（方案 §6 表 2「GC 枚举开销」唯一的度量点）。
 * 计时口径 = §6 表 2 原文「目录枚举开销」：`readdir` + **逐项 stat** 全套跑完的墙钟毫秒（取整）。
 * @param {string} archiveRoot
 * @param {{enumClock?:Function}} [opts] `enumClock` = 返回单调毫秒的零参函数（注入 ⇒ 单测确定性、零等待）
 * @returns {{names:string[], ms:number, entries:number}}
 */
export function measureTopLevelEnum(archiveRoot, opts = {}) {
  const clock = typeof opts.enumClock === 'function' ? opts.enumClock : defaultClock;
  const t0 = clock();
  const names = listTopLevelDirs(archiveRoot);
  const ms = normMs(clock() - t0);
  return { names, ms, entries: names.length };
}

// ---------------------------------------------------------------- 计划（纯函数 + 一次 readdir/stat）

/**
 * 算出本轮 GC 会动哪些桶（**不写任何东西**；含"归档根顶层枚举"的耗时度量）。
 * @param {{archiveRoot:string, now?:number, keepMax?:number, keepDays?:number, keepRoot?:string,
 *          enumClock?:Function, enumBudgetMs?:number}} opts
 * @returns {{archiveRoot:string, keepRoot:string, scannedTopLevel:number, enumMs:number,
 *            enumBudgetMs:number, enumOverBudget:boolean, standard:object[],
 *            nonStandard:string[], nonStandardNames:string[], nonStandardTruncated:boolean,
 *            toDelete:object[], toKeep:string[], reason:string}}
 */
export function planGc(opts = {}) {
  const archiveRoot = String(opts.archiveRoot ?? '');
  const keepRoot = String(opts.keepRoot ?? path.join(archiveRoot, KEEP_DIR_NAME));
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const keepMax = Number.isFinite(opts.keepMax) ? opts.keepMax : GC_KEEP_MAX;
  const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : GC_KEEP_DAYS;
  const enumBudgetMs = Number.isFinite(opts.enumBudgetMs) ? opts.enumBudgetMs : ENUM_BUDGET_MS;

  // 顶层枚举**只做一次**，顺手把它的耗时量出来（表 2 判据：超预算 ⇒ warn + 日报一行）。
  const scan = measureTopLevelEnum(archiveRoot, { enumClock: opts.enumClock });
  const names = scan.names;
  const scannedTopLevel = names.length;
  const enumMs = scan.ms;
  const enumOverBudget = enumMs > enumBudgetMs;
  const buckets = [];
  const nonStandard = [];
  for (const n of names) {
    if (!n.startsWith(BUCKET_PREFIX)) continue;
    const full = path.join(archiveRoot, n);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch { mtimeMs = 0; }
    if (STANDARD_BUCKET_RE.test(n)) buckets.push({ name: n, full, mtimeMs });
    else nonStandard.push(n);
  }
  buckets.sort((a, b) => b.mtimeMs - a.mtimeMs);
  nonStandard.sort();

  const cutoff = now - keepDays * 24 * 3600 * 1000;
  const toDelete = [];
  const toKeep = [];
  buckets.forEach((b, i) => {
    const overMax = i >= keepMax;
    const expired = b.mtimeMs > 0 && b.mtimeMs < cutoff;
    if (overMax || expired) {
      toDelete.push({ ...b, reason: overMax ? 'over-max' : 'expired' });
    } else {
      toKeep.push(b.name);
    }
  });

  return {
    archiveRoot, keepRoot, scannedTopLevel, enumMs, enumBudgetMs, enumOverBudget, standard: buckets,
    nonStandard: nonStandard.length,
    nonStandardNames: nonStandard.slice(0, NONSTANDARD_LIST_MAX),
    nonStandardTruncated: nonStandard.length > NONSTANDARD_LIST_MAX,
    toDelete, toKeep,
    reason: `标准命名 ${STANDARD_BUCKET_RE.source} · 保留最近 ${keepMax} 份或 ${keepDays} 天（先到者）`,
  };
}

// ---------------------------------------------------------------- 凭据（收集 / 复制 / 校验）

/** 桶内顶层凭据项（不递归判定，`files/` 作为一项整目录）。 */
export function collectCredentials(bucketDir) {
  let ents = [];
  try { ents = fs.readdirSync(bucketDir, { withFileTypes: true }); } catch { return []; }
  const items = [];
  for (const e of ents) {
    const full = path.join(bucketDir, e.name);
    const isDir = e.isDirectory();
    const isFile = e.isFile();
    if (isDir && CREDENTIAL_DIR_RE.test(e.name)) { items.push({ rel: e.name, abs: full, kind: 'dir' }); continue; }
    if (isFile && (CREDENTIAL_FILE_RE.test(e.name) || CREDENTIAL_MANIFEST_RE.test(e.name) || CREDENTIAL_PREV_RE.test(e.name))) {
      items.push({ rel: e.name, abs: full, kind: 'file' });
    }
  }
  items.sort((a, b) => a.rel.localeCompare(b.rel));
  return items;
}

/** 逐文件清单（用于复制与校验；目录展开为相对路径）。 */
function listCredentialFiles(items) {
  const out = [];
  for (const it of items) {
    if (it.kind === 'file') { out.push({ rel: it.rel, abs: it.abs }); continue; }
    const walk = (dir, relBase) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        const rel = `${relBase}/${e.name}`;
        let st = null;
        try { st = fs.lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;                       // 链接不进保留区（也不被跟随）
        if (st.isDirectory()) walk(full, rel);
        else if (st.isFile()) out.push({ rel, abs: full });
      }
    };
    walk(it.abs, it.rel);
  }
  return out;
}

/**
 * 复制凭据子集到保留区（`keepRoot/<bucket>/…`，幂等：目标已存在且 sha 相同则跳过）。
 * @returns {{ok:boolean, dir:string, files:number, bytes:number, copied:number, reused:number, error:string|null}}
 */
export function copyCredentials(bucketDir, keepDir, items) {
  const files = listCredentialFiles(items);
  let bytes = 0, copied = 0, reused = 0;
  try {
    fs.mkdirSync(keepDir, { recursive: true });
    for (const f of files) {
      const dst = path.join(keepDir, ...f.rel.split('/'));
      let st = null;
      try { st = fs.statSync(f.abs); } catch { continue; }
      bytes += st.size;
      let same = false;
      try {
        const d = fs.statSync(dst);
        same = d.size === st.size && sha256File(dst) === sha256File(f.abs);
      } catch { same = false; }
      if (same) { reused++; continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(f.abs, dst);
      copied++;
    }
  } catch (e) {
    return { ok: false, dir: keepDir, files: files.length, bytes, copied, reused, error: msgOf(e) };
  }
  return { ok: true, dir: keepDir, files: files.length, bytes, copied, reused, error: null };
}

/**
 * 校验保留区与源桶**逐文件字节一致**（字节数 + sha256）。任何不一致 ⇒ 调用方不许删桶。
 * @returns {{ok:boolean, checked:number, mismatches:object[]}}
 */
export function verifyCredentials(bucketDir, keepDir, items) {
  const files = listCredentialFiles(items);
  const mismatches = [];
  for (const f of files) {
    const dst = path.join(keepDir, ...f.rel.split('/'));
    let sHash = null, dHash = null, sSize = -1, dSize = -1;
    try { const s = fs.statSync(f.abs); sSize = s.size; } catch { sSize = -1; }
    try { const d = fs.statSync(dst); dSize = d.size; } catch { dSize = -1; }
    sHash = sha256File(f.abs);
    dHash = sha256File(dst);
    if (sSize !== dSize || sHash === null || dHash === null || sHash !== dHash) {
      mismatches.push({ rel: f.rel, srcBytes: sSize, dstBytes: dSize, srcSha: sHash, dstSha: dHash });
    }
  }
  return { ok: mismatches.length === 0, checked: files.length, mismatches };
}

/**
 * 【R-065 三件套 · 锁 batchD2】本模块的**唯一删除口**。
 *  ① dry-run 是本函数**第一条**语句（R-065③；只在调用方判挡不住「传 dryRun 也真删」）；
 *  ② 过 `gateDestructive`：作用域 file（点明只碰文件面）/ 白名单（本次允许动的根）/ reparse 拒删 / 生产判定；
 *  ③ 被拒 ⇒ **抛错**（调用方 catch 后记 `skipped` + alert，绝不"警告后继续删"）。
 *  ④ `allowProduction: true` 的依据：本模块删的就是 `_archive` 下的桶（生产树），这是它唯一用途；
 *     `ledgerBypass: false` 的依据：GC 是**常驻周期性**放行（每轮都跑），逐条写绕过台账会把真绕过数淹掉
 *     （与共享件「dry-run 不记」同一精神）；留痕改由本模块自己的 summary/bucket/keep 三条审计承担。
 */
function removeGuarded(target, { kind, dryRun, whitelist, reason }) {
  if (dryRun === true) return false;
  const g = gateDestructive({
    targets: [{ path: target, label: reason }],
    whitelist, op: kind === 'dir' ? '删' : '删文件', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse: false, ledgerBypass: false,
    reason,
  });
  if (!g.ok) throw new Error(`R-065 拒删（${g.code ?? 'blocked'}）：${String(g.reason).split('\n')[0]}`);
  if (kind === 'dir') fs.rmSync(target, { recursive: true, force: true });
  else fs.rmSync(target, { force: true });
  return true;
}

/** keepRoot 可写探针（写一个空文件再删；失败 = 整轮不删）。 */
export function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.gc-write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    removeGuarded(probe, { kind: 'file', dryRun: false, whitelist: [dir], reason: '可写探针文件清理' });
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: msgOf(e) };
  }
}

// ---------------------------------------------------------------- 执行（唯一真删入口）

/**
 * 跑一轮 GC。
 * @param {{archiveRoot:string, keepRoot?:string, now?:number, dryRun?:boolean,
 *          keepMax?:number, keepDays?:number, keepCredMax?:number, keepCredDays?:number,
 *          audit?:Function|null, alert?:Function|null, label?:string,
 *          enumClock?:Function, enumBudgetMs?:number}} opts
 *   `enumClock` / `enumBudgetMs` = 枚举计时与预算的注入点（默认真时钟 + `ENUM_BUDGET_MS`）；
 *   **dry-run 与真跑共用同一路计时**（计时零副作用，不受运行档影响）。
 * @returns {object} 报告（结构见 §5 判据 4/5；`summary` 可直接进审计/日报）
 */
export function runGc(opts = {}) {
  const dryRun = opts.dryRun === true;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const keepCredMax = Number.isFinite(opts.keepCredMax) ? opts.keepCredMax : KEEP_KEEP_MAX;
  const keepCredDays = Number.isFinite(opts.keepCredDays) ? opts.keepCredDays : KEEP_KEEP_DAYS;
  const audit = typeof opts.audit === 'function' ? opts.audit : null;
  const alertFn = typeof opts.alert === 'function' ? opts.alert : null;
  const doAlert = (message, detail) => { try { alertFn?.({ level: 'warn', source: 'handoff-gc', message, detail }); } catch { /* 告警不许拖垮 GC */ } };

  const plan = planGc(opts);
  const keepRoot = plan.keepRoot;
  const report = {
    version: HANDOFF_GC_VERSION,
    at: new Date(now).toISOString(),
    dryRun,
    archiveRoot: plan.archiveRoot,
    keepRoot,
    scannedTopLevel: plan.scannedTopLevel,
    enumMs: plan.enumMs,
    enumBudgetMs: plan.enumBudgetMs,
    enumOverBudget: plan.enumOverBudget,
    standard: plan.standard.length,
    nonStandard: plan.nonStandard,
    nonStandardNames: plan.nonStandardNames,
    nonStandardTruncated: plan.nonStandardTruncated,
    planned: plan.toDelete.map((d) => ({ bucket: d.name, mtimeMs: d.mtimeMs, reason: d.reason })),
    plannedBytes: 0,
    plannedCredBytes: 0,
    deleted: [],
    skipped: [],
    keptCredentials: [],
    keptBytes: 0,
    keepCleaned: [],
    aborted: null,
    plan,
  };

  // 计划里先把"将会摘的凭据"列出来（dry-run 的可读性靠它；判据要求 dry-run 打印"摘了哪些字节"）
  for (const p of report.planned) {
    const bucketDir = path.join(plan.archiveRoot, p.bucket);
    const st = walkStat(bucketDir);
    p.files = st.files; p.bytes = st.bytes; p.links = st.links;
    const items = collectCredentials(bucketDir);
    p.credentials = items.map((x) => (x.kind === 'dir' ? `${x.rel}/` : x.rel));
    const credFiles = listCredentialFiles(items);
    let cb = 0;
    for (const f of credFiles) { try { cb += fs.statSync(f.abs).size; } catch { /* 读不到按 0 计 */ } }
    p.credFiles = credFiles.length;
    p.credBytes = cb;
    report.plannedBytes += st.bytes;
    report.plannedCredBytes += cb;
  }

  if (plan.toDelete.length === 0) {
    // 保留区自身的保留策略与"本轮有没有桶要删"**无关**（独立职责：keep 会随每轮摘取而增长）——
    //   所以这里也照跑一遍（dry-run 只算不删），否则"桶一直没超期"就等于 keep 永不清理。
    report.keepCleaned = cleanKeep(keepRoot, { now, max: keepCredMax, days: keepCredDays, dryRun, audit, doAlert });
    report.summary = summarize(report);
    if (!dryRun) writeAudit(report, audit);
    return report;
  }

  // fail-close：保留区根不可写 ⇒ 整轮不删（方案 §7.2③）
  //   ⚠️ **dry-run 绝不 probe**：探针会 `mkdir` 出保留区目录 —— 那就不再是"零副作用"了
  //   （2026-09-20 单测 D1/D2 抓到的真问题：dry-run 跑完凭空多出 `handoff-keep`）。
  //   dry-run 的"保留区有没有 / 可不可写"由 CLI 用 existsSync 如实呈现，不去创建它。
  if (!dryRun) {
    const probe = probeWritable(keepRoot);
    if (!probe.ok) {
      report.aborted = { reason: 'keep-unwritable', detail: probe.error };
      report.skipped = plan.toDelete.map((d) => ({ bucket: d.name, reason: 'keep-unwritable' }));
      doAlert(`handoff GC 中止：凭据保留区不可写（${probe.error}）→ 本轮不删任何桶`, { keepRoot });
      report.summary = summarize(report);
      writeAudit(report, audit);
      return report;
    }
  }

  for (const d of plan.toDelete) {
    const bucketDir = path.join(plan.archiveRoot, d.name);
    const keepDir = path.join(keepRoot, d.name);
    const items = collectCredentials(bucketDir);

    // 含链接的桶不删（persona 铁律：含 junction 的树绝不递归删）
    const st = walkStat(bucketDir);
    if (st.links > 0) {
      report.skipped.push({ bucket: d.name, reason: 'contains-links', links: st.links });
      doAlert(`handoff GC 跳过 \`${d.name}\`：桶内含 ${st.links} 个 junction/符号链接 → 不递归删（保守）`, { bucket: d.name });
      continue;
    }

    if (dryRun) {
      if (items.length) report.keptCredentials.push({ bucket: d.name, dir: keepDir, files: st.files, bytes: st.bytes, items: items.map((x) => x.rel), planned: true });
      report.deleted.push({ bucket: d.name, bytes: st.bytes, files: st.files, credentialsKept: items.length, keptDir: items.length ? keepDir : null, planned: true, reason: d.reason });
      continue;
    }

    // ① 先摘凭据（无凭据的桶 = 无需摘，直接进第 ③ 步）
    if (items.length) {
      const cp = copyCredentials(bucketDir, keepDir, items);
      if (!cp.ok) {
        report.skipped.push({ bucket: d.name, reason: 'copy-failed', detail: cp.error });
        doAlert(`handoff GC 跳过 \`${d.name}\`：凭据复制失败（${cp.error}）→ 该桶不删`, { bucket: d.name, keepDir });
        continue;
      }
      // ② 校验字节（不一致 ⇒ 不删桶）
      const vf = verifyCredentials(bucketDir, keepDir, items);
      if (!vf.ok) {
        report.skipped.push({ bucket: d.name, reason: 'verify-mismatch', mismatches: vf.mismatches.slice(0, 5) });
        doAlert(`handoff GC 跳过 \`${d.name}\`：凭据校验不一致（${vf.mismatches.length} 项）→ 该桶不删`, { bucket: d.name, keepDir });
        continue;
      }
      report.keptCredentials.push({ bucket: d.name, dir: keepDir, files: cp.files, bytes: cp.bytes, items: items.map((x) => x.rel), copied: cp.copied, reused: cp.reused });
      report.keptBytes += cp.bytes;
    }

    // ③ 再删桶主体
    try {
      removeGuarded(bucketDir, { kind: 'dir', dryRun, whitelist: [plan.archiveRoot], reason: `handoff GC 删桶：${d.name}` });
    } catch (e) {
      report.skipped.push({ bucket: d.name, reason: 'rm-failed', detail: msgOf(e) });
      doAlert(`handoff GC 删桶失败 \`${d.name}\`：${msgOf(e)}`, { bucket: d.name });
      continue;
    }
    report.deleted.push({
      bucket: d.name, bytes: st.bytes, files: st.files,
      credentialsKept: items.length, keptDir: items.length ? keepDir : null,
      reason: d.reason, mtimeMs: d.mtimeMs,
    });
    writeAuditBucket(report.deleted[report.deleted.length - 1], audit);
  }

  // 保留区自身保留策略（最近 20 份凭据 / 90 天）——**同样删必留痕**
  report.keepCleaned = cleanKeep(keepRoot, { now, max: keepCredMax, days: keepCredDays, dryRun, audit, doAlert });

  report.summary = summarize(report);
  if (!dryRun) writeAudit(report, audit);
  return report;
}

/** 保留区清理（先写审计行，审计写失败 ⇒ 不删）。 */
function cleanKeep(keepRoot, { now, max, days, dryRun, audit, doAlert }) {
  const cleaned = [];
  let names = [];
  try {
    names = fs.readdirSync(keepRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return cleaned; }
  const rows = names.map((n) => {
    const full = path.join(keepRoot, n);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch { mtimeMs = 0; }
    return { n, full, mtimeMs };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = now - days * 24 * 3600 * 1000;
  rows.forEach((r, i) => {
    const overMax = i >= max;
    const expired = r.mtimeMs > 0 && r.mtimeMs < cutoff;
    if (!overMax && !expired) return;
    const reason = overMax ? 'over-max' : 'expired';
    if (dryRun) { cleaned.push({ bucket: r.n, reason, planned: true }); return; }
    const line = { type: GC_AUDIT_TYPE, scope: GC_SCOPE_KEEP, bucket: r.n, reason, keptDir: path.join(keepRoot, r.n) };
    const res = audit ? audit(line) : { ok: true };
    if (res && res.ok === false) {
      doAlert(`handoff-keep 清理跳过 \`${r.n}\`：留痕审计写入失败（删之前先留痕，写不进就不删）`, { bucket: r.n });
      return;
    }
    try { removeGuarded(r.full, { kind: 'dir', dryRun, whitelist: [keepRoot], reason: `handoff-keep 保留区清理：${r.n}` }); cleaned.push({ bucket: r.n, reason }); }
    catch (e) { doAlert(`handoff-keep 清理失败 \`${r.n}\`：${msgOf(e)}`, { bucket: r.n }); }
  });
  return cleaned;
}

/** 汇总（审计 summary 行 + 日报段的唯一数据源）。 */
function summarize(report) {
  return {
    at: report.at,
    dryRun: report.dryRun,
    archiveRoot: report.archiveRoot,
    keepRoot: report.keepRoot,
    scannedTopLevel: report.scannedTopLevel,
    // 表 2「GC 枚举开销」：耗时与是否超预算进 summary（审计/日报同源）；**只在超界时带 `warn` 键**
    //（正常路径不带该键 ⇒ 下游判"有没有告警"只看键在不在，不必解析值）。
    enumMs: report.enumMs,
    enumBudgetMs: report.enumBudgetMs,
    enumOverBudget: report.enumOverBudget === true,
    ...(report.enumOverBudget === true ? { warn: ENUM_WARN } : {}),
    standard: report.standard,
    nonStandard: report.nonStandard,
    nonStandardNames: report.nonStandardNames,
    nonStandardTruncated: report.nonStandardTruncated,
    plannedDelete: report.planned.length,
    plannedBuckets: report.planned.map((p) => p.bucket),
    plannedBytes: report.plannedBytes,
    standardKept: report.plan.toKeep,
    deleted: report.deleted.filter((d) => !d.planned).length,
    plannedDeleted: report.deleted.filter((d) => d.planned).length,
    deletedBuckets: report.deleted.map((d) => d.bucket),
    plannedCredentials: report.planned.reduce((a, p) => a + (p.credentials?.length ?? 0), 0),
    plannedCredBytes: report.plannedCredBytes,
    credentialsKept: report.keptCredentials.filter((k) => !k.planned).length,
    keptBytes: report.keptBytes,
    keptDirs: report.keptCredentials.filter((k) => !k.planned).map((k) => k.dir),
    skipped: report.skipped,
    keepCleaned: report.keepCleaned.map((c) => c.bucket),
    aborted: report.aborted,
    reason: report.plan.reason,
  };
}

function writeAudit(report, audit) {
  if (!audit) return;
  const s = report.summary;
  try {
    audit({
      type: GC_AUDIT_TYPE, scope: GC_SCOPE_SUMMARY,
      // ⚠️ `at` 必须写：日报行的「（最近一轮 <时间>）」与 readLastGcRun 的「已超 7 天」判定都靠它；
      //   缺了它 → 日报渲染成"最近一轮 （空）"、ageMs=NaN ⇒ staleness 永不触发
      //   （2026-09-20 卡 ③-3.2 取证时发现的 **③-3 既有缺陷**，属纯增量字段，不改成形已落地的其余字段）。
      at: s.at,
      standard: s.standard, nonStandard: s.nonStandard, nonStandardNames: s.nonStandardNames,
      // 枚举耗时随 summary 行进审计（**不新建状态文件**：日报句与审计同源，方案 §6 表 3）。
      // ⚠️ `scannedTopLevel` 必须一起写：日报告警句要「（顶层 N 目录）」，缺了它那句话只能写 0 目录
      //（2026-09-20 本卡单测 D6/D9 首跑抓到的真缺陷 —— 数据不落审计 = 日报渲染不出）。
      scannedTopLevel: s.scannedTopLevel,
      enumMs: s.enumMs, enumBudgetMs: s.enumBudgetMs, enumOverBudget: s.enumOverBudget,
      ...(s.enumOverBudget === true ? { warn: ENUM_WARN } : {}),
      plannedDelete: s.plannedDelete, deleted: s.deleted,
      credentialsKept: s.credentialsKept, keptBytes: s.keptBytes,
      plannedCredentials: s.plannedCredentials, plannedCredBytes: s.plannedCredBytes,
      skipped: s.skipped.map((x) => ({ bucket: x.bucket, reason: x.reason })),
      keepCleaned: s.keepCleaned, aborted: s.aborted,
      archiveRoot: s.archiveRoot, keepRoot: s.keepRoot,
    });
  } catch { /* 审计写失败已在 appendAudit 内走 alert；不拖垮 GC */ }
}

function writeAuditBucket(rec, audit) {
  if (!audit) return;
  try {
    audit({
      type: GC_AUDIT_TYPE, scope: GC_SCOPE_BUCKET,
      bucket: rec.bucket, bytes: rec.bytes, files: rec.files,
      credentialsKept: rec.credentialsKept, keptDir: rec.keptDir, reason: rec.reason,
    });
  } catch { /* 同上 */ }
}

// ---------------------------------------------------------------- 呈现（日报段 · 最近一轮）

/**
 * 读**最近一轮** GC 的审计（summary + 其后的 bucket/keep 明细）。
 * 数据源 = 审计流水（与表 3「日报段与审计流水同源」一致，**不新建状态文件**）。
 * @param {{home?:string, auditFile?:string, now?:number, staleMs?:number}} [opts]
 * @returns {{ok:boolean, run:object|null, stale:boolean, ageMs:number|null, file:string|null, reason:string}}
 */
export function readLastGcRun(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const files = [];
  if (opts.auditFile) files.push(String(opts.auditFile));
  else {
    const dir = butlerPaths(opts.home).auditDir;
    files.push(path.join(dir, `${monthKeyAt(now)}.jsonl`));
    files.push(path.join(dir, `${monthKeyAt(shiftMonth(now, -1))}.jsonl`));
  }
  // 找"最近一轮"：优先返回**当月**能读出 summary 的那个文件；
  //   若当月能读但没有 GC 记录（= GC 从未跑过，最常见），**返回它**而不是继续翻上月、
  //   更不能把"上月文件不存在"当成结论（2026-09-20 实测踩到：会误报成"审计流水读不到"）。
  let fallback = null;
  for (const f of files) {
    const r = readGcFromAuditFile(f, { now, staleMs: opts.staleMs });
    if (r.ok && r.run) return r;
    if (r.ok && !fallback) fallback = r;
    if (!r.ok) fallback = fallback ?? r;
  }
  return fallback ?? { ok: false, run: null, stale: false, ageMs: null, file: files[0] ?? null, reason: '未找到审计流水文件' };
}

/** 本地时区的 `YYYY-MM`（与 lib/paths.mjs 的 monthKey() 同口径，便于跨月回退找上一轮）。 */
function monthKeyAt(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(ms, delta) {
  const d = new Date(ms);
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  return d.getTime();
}

/** 从一个审计流水文件里取"最后一个 summary + 其后的明细"。 */
function readGcFromAuditFile(file, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let lines = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    lines = text.split('\n');
    if (lines.length > 4000) lines = lines.slice(-4000);
  } catch (e) {
    return { ok: false, run: null, stale: false, ageMs: null, file, reason: `审计流水读不到（${msgOf(e)}）` };
  }
  let idx = -1;
  const recs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let r = null;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r?.type !== GC_AUDIT_TYPE) continue;
    recs.push({ i, r });
  }
  for (let k = recs.length - 1; k >= 0; k--) {
    if (recs[k].r.scope === GC_SCOPE_SUMMARY) { idx = k; break; }
  }
  if (idx < 0) return { ok: true, run: null, stale: false, ageMs: null, file, reason: '尚无 handoff-gc 审计（GC 从未跑过）' };
  const head = recs[idx].r;
  const tail = recs.slice(idx + 1).map((x) => x.r);
  const run = {
    ...head,
    buckets: tail.filter((r) => r.scope === GC_SCOPE_BUCKET),
    keepRows: tail.filter((r) => r.scope === GC_SCOPE_KEEP),
  };
  const t = Date.parse(head.at ?? '');
  const ageMs = Number.isFinite(t) ? Math.max(0, now - t) : null;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 7 * 24 * 3600 * 1000;
  return { ok: true, run, stale: ageMs !== null && ageMs > staleMs, ageMs, file, reason: 'ok' };
}

/** 日报行（供 dsh-butler-panel/report.mjs push 进「🔗 跨线契约」段；不含尾部空行）。 */
export function gcSectionLines(loaded, opts = {}) {
  const L = [];
  if (!loaded || loaded.ok !== true) {
    L.push(`- ❔ handoff 桶 GC：不可探测（${loaded?.reason ?? '未知'}）`);
    return L;
  }
  if (!loaded.run) {
    L.push(`- ⚪ handoff 桶 GC：${loaded.reason ?? '尚无记录'}（射程 \`${STANDARD_BUCKET_RE.source}\` · 保留最近 ${GC_KEEP_MAX} 份或 ${GC_KEEP_DAYS} 天）`);
    return L;
  }
  const r = loaded.run;
  const when = String(r.at ?? '').replace('T', ' ').slice(0, 16);
  const deleted = Number(r.deleted) || 0;
  const cred = Number(r.credentialsKept) || 0;
  const kept = Array.isArray(r.standardKept)
    ? r.standardKept.length
    : Math.max(0, (Number(r.standard) || 0) - (Number(r.plannedDelete) || 0));
  L.push(`- ${deleted > 0 ? '📦' : '✅'} handoff 桶 GC（最近一轮 ${when}${loaded.stale ? ' · ⚠️ 已超 7 天' : ''}）：`
    + `**删除 ${deleted} 个** · 摘凭据 ${cred} 份（${fmtBytes(Number(r.keptBytes) || 0)}）· 保留 ${kept} 个`
    + `（标准桶 ${Number(r.standard) || 0} · 射程 \`${STANDARD_BUCKET_RE.source}\` · 保留最近 ${GC_KEEP_MAX} 份或 ${GC_KEEP_DAYS} 天）`);
  // ⚠️ 表 2「GC 枚举开销」：**超界才在同一行追加一句**（在预算内不报数——日报要的是异常可见，不是每轮刷数字）。
  //    同段不新开段 / 不新建状态文件：数据来自审计 summary 行（③-3 的段序纪律）。
  {
    const note = enumBudgetNote(r);
    if (note) L[L.length - 1] += ` ${note.text}`;
  }
  const names = Array.isArray(r.nonStandardNames) ? r.nonStandardNames : [];
  if (Number(r.nonStandard) > 0) {
    L.push(`  - 非标准 handoff 桶 **${r.nonStandard} 个（不在 GC 射程，需人工清理）**：${names.map((n) => `\`${n}\``).join('、')}${r.nonStandardTruncated ? ' …' : ''}`);
  }
  for (const b of (r.buckets ?? []).slice(0, 10)) {
    L.push(`  - 已删 \`${b.bucket}\`（${fmtBytes(Number(b.bytes) || 0)} · ${b.files ?? '?'} 文件 · 凭据 ${b.credentialsKept ?? 0} 项 → \`${b.keptDir ?? '（无凭据）'}\`）`);
  }
  if (Number(r.keepCleaned?.length) > 0) L.push(`  - 保留区自身清理：${r.keepCleaned.map((n) => `\`${n}\``).join('、')}（保留最近 ${KEEP_KEEP_MAX} 份凭据 / ${KEEP_KEEP_DAYS} 天）`);
  if (Array.isArray(r.skipped) && r.skipped.length) {
    L.push(`  - ⚠️ 跳过 ${r.skipped.length} 个桶：${r.skipped.slice(0, 5).map((s) => `\`${s.bucket}\`（${s.reason}）`).join('、')}`);
  }
  if (r.aborted) L.push(`  - 🔴 本轮中止（**未删任何桶**）：${r.aborted.reason}${r.aborted.detail ? ` — ${r.aborted.detail}` : ''}`);
  L.push(`  - 口径（2026-09-17 拍板 · ③ 包 C-4）：**删桶必留痕**（审计 \`${GC_AUDIT_TYPE}\` + 本段可见）· 删前先摘凭据到 \`_archive/${KEEP_DIR_NAME}/<桶>/\` 并逐文件校验字节；`
    + `**可回滚的只有"怎么恢复"的凭据**（本机唯一凭据手 · 同盘同树非异地备份），**桶内数据主体不可回滚**`);
  return L;
}

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
};

/**
 * 「枚举耗时超界」那句话的**唯一真源**（方案 §6 表 2「GC 枚举开销」⇒ 日报一行；CLI 复用同一句）。
 * 口径：超界 = 审计 summary 标了 `enumOverBudget` **或** 实例算 `enumMs > enumBudgetMs`（兼容旧记录）；
 * 没超界 / 记录里根本没有枚举字段（③-3 之前写的旧 summary 行）⇒ 返回 `null`（**不虚构、不刷屏**）。
 * @param {object|null} run 最近一轮 GC 的审计 summary 行
 * @returns {{ms:number, budgetMs:number, topLevel:number, text:string}|null}
 */
export function enumBudgetNote(run) {
  if (!run || typeof run !== 'object') return null;
  const rawMs = Number(run.enumMs);
  const ms = Number.isFinite(rawMs) ? rawMs : null;
  const rawBudget = Number(run.enumBudgetMs);
  const budgetMs = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : ENUM_BUDGET_MS;
  const over = run.enumOverBudget === true || (ms !== null && ms > budgetMs);
  if (!over) return null;
  const topLevel = Number(run.scannedTopLevel) || 0;
  return {
    ms: ms ?? 0, budgetMs, topLevel,
    text: `⚠️ 枚举耗时 ${((ms ?? 0) / 1000).toFixed(1)}s 超 ${budgetMs / 1000}s 预算（顶层 ${topLevel} 目录）`,
  };
}

export default {
  HANDOFF_GC_VERSION,
  STANDARD_BUCKET_RE, BUCKET_PREFIX, KEEP_DIR_NAME,
  GC_KEEP_MAX, GC_KEEP_DAYS, KEEP_KEEP_MAX, KEEP_KEEP_DAYS,
  ENUM_BUDGET_MS, ENUM_WARN,
  GC_AUDIT_TYPE, GC_SCOPE_SUMMARY, GC_SCOPE_BUCKET, GC_SCOPE_KEEP,
  sha256File, walkStat, listTopLevelDirs, measureTopLevelEnum,
  planGc, collectCredentials, copyCredentials, verifyCredentials, probeWritable,
  runGc, readLastGcRun, gcSectionLines, enumBudgetNote,
};
