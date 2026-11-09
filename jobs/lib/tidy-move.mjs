// dsh-butler / lib/tidy-move.mjs —— P8 会收纳：**L2 搬移引擎**（B1 `tidy-move-tmp`）
//
// 方案：docs\管家v2.5-P8会收纳设计-20260909.md
//   §4.2 B1（动作本体 + 回滚 + 上限）· §5.1 引用检查 · §5.2 活跃保护 · §5.4 junction 防护
//   §6 护栏（干跑默认 / 爆炸半径 ≤50 / 强制备份 fail-close / 回滚验证 / 降档联动 / 审计留痕）
//   §11 [12] 卡 · §15.1 D2（p8-auto 独立开关）· §15.2 P-4 / P-6 / P-7
//
// ── 三条不可动摇的口径 ─────────────────────────────────────────────────────
//   ① **永不删**：本模块只有 `renameSync`（同卷搬移），**没有任何 unlink/rm/rmdir 调用**。
//      删除是 L3 人工批（§4.3 C1），本层一行都不碰。
//   ② **闸门顺序写死（P-7 拍板）**：第一道 = **活跃保护**（§5.2 五条：运行态硬清单 / 24h mtime /
//      占用重试 / 锁文件 / 进行中卡），第二道 = **引用检查**（§5.1 八条）。顺序不可颠倒：
//      活跃保护是"事实判断"，引用检查是"静态文本判断"。
//
//      ⚠️ 2026-10-16 增补 **第 0 层**：`TMP_MOVE_EXCLUDE`（主人未决名单）跑在活跃保护**之前**。
//      理由：它是**策略级判定**（主人的明确决定），必须压过运行态/启发式判据 —— 后者（尤其
//      `running-card` 那条"卡面文本近似判据"）会随卡面措辞时有时无，**不能拿它当保护**（本卡起因）。
//      命中 ⇒ `skipped[stage='exclude']`；`--no-exclude` / `opts.noExclude` 可临时绕过（不是死锁）。
//   ③ **manifest-first（fail-close）**：搬之前先把 MANIFEST.json 落盘（含 sha256）；写不出来 ⇒
//      **一个文件都不搬**。搬完再跑一次 `verifyManifest()`；校验失败 ⇒ 自动搬回 + 报错。
//   ④ **同桶同日多批 = 追加 entries**（2026-10-13 修，`交接-愿景实体核查-20261013.md` §6b-5）：
//      `writeManifest()` 永远走 `mergeBucketManifest()`（按 `to` 去重合并；`at` 保最早，`batches` 累积），
//      桶内 restore 脚本用**合并后**清单渲染 ⇒ 认识桶里**全部**条目；桶内清单解析失败 ⇒ fail-close 停手
//      （绝不整文件覆盖丢回滚凭据）。配套 `verifyManifest(bucket, { rels })`：合并桶只校验**本批**。
//   ⑤ **规划期先探「树内 reparse」（2026-10-21 加）**：候选**目录**在进批**之前**按 R-065 判据
//      （`scanReparsePoints`，判据本体复用共享件、不另造）扫一遍树内 junction / 符号链接 ——
//      命中 / 扫不完 ⇒ `skipped[stage='reparse-tree']`，**永不进批**。
//      为什么：此前只有 `moveWithRetry()` 的 R-065 闸在**搬到一半**才拒 ⇒ manifest 里留一条 `moved:false`
//      的注定失败项，每批重来一次（实测 `_tmp\p8-13`）。成本实测：45 棵树 / 14,923 条目 ≈ 0.5s。
//      配套：`verifyManifest()` **跳过 `moved === false`（拒搬）条目**、单列 `refused` 计数 —— 拒搬
//      从来没搬走，用「桶内有 + 原位无 + sha 对」判它**必然假红**（会把人练成"红也不看"）。
//
// ── 用户可见的三个档 ───────────────────────────────────────────────────────
//   `observe`  只报"若开启会搬什么"，**零副作用**（不建桶、不写 manifest、不动文件）——本卡（P1 期）生产只跑这一档；
//   `dry-run`  与 observe 同为零副作用，差别只在输出细节（含逐条跳过原因）；
//   `apply`    **真搬**。必须先过自治闸（L0 正常 × `p8AutoEnabled` × `modules['p8-tidy']`）
//              + 抢到 `handoff` 锁 + manifest 写出成功 + 单批 ≤50。
//
// ── 与 P3 四键的关系（主人 2026-09-10 16:36 拍板）────────────────────────────
//   `p8-auto` **独立自主**，不并 `runAction` 四键：搬移风险面（只搬不删、可一键回滚）与 P3「派活」
//   不同量级 ⇒ 单独一把钥匙。所以本模块**不** import `runAction()`，闸门 = 自己的 `resolveMoveGate()`。
import fs from 'node:fs';
import { workspaceRoot } from './ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { acquireTickLock, readJson, writeJsonAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { appendAudit } from '../../src/dsh-butler/lib/audit.mjs';
import { readAutonomyState, LEVEL_NORMAL } from '../../src/dsh-butler/lib/autonomy-state.mjs';
import { autoAllowed } from '../../src/dsh-butler/lib/autonomy.mjs';
import { checkModuleAllowed } from '../../src/dsh-butler/lib/autonomy-modules.mjs';
import { checkReferences, describeRefCheck, scanRuntimeRefs, REFCHECK_VERSION } from './tidy-refcheck.mjs';
import { desktopEntryDir } from '../../src/dsh-butler/lib/desktop-entry.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive, scanReparsePoints } from '../../src/lib/production-guard.mjs';

/** 唯一删口（R-065）：dry-run 是本函数**第一条**可执行语句；被拒 ⇒ 返回 false（调用方按「没删」处理）。 */
function removeGuarded(target, { whitelist, reason = null, dryRun = false, allowReparse = false, op = '删文件' } = {}) {
  if (dryRun === true) return false;
  const g = gateDestructive({
    targets: [{ path: target, label: reason }], whitelist, op, scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return false;
  try { fs.rmSync(target, { force: true }); return true; } catch { return false; }
}

/** 唯一搬移口（R-065）：同卷 rename 的**原子替换**语义。dry-run 同样是第一条可执行语句。 */
function renameGuarded(from, to, { whitelist, reason = null, dryRun = false, allowReparse = false } = {}) {
  if (dryRun === true) return { ok: true, dryRun: true, code: 'dry-run', reason: 'dry-run（零动作）' };
  const g = gateDestructive({
    targets: [{ path: from, label: 'src' }, { path: to, label: 'dst' }], whitelist, op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return { ok: false, code: g.code, reason: g.reason };
  try { fs.renameSync(from, to); return { ok: true, code: null, reason: g.reason }; }
  catch (e) { return { ok: false, code: 'fs-error', reason: String(e?.message ?? e) }; }
}


export const TIDY_MOVE_VERSION = '0.1.0';
/** 爆炸半径（§6）：L2 单批 ≤50 个顶层项，超限转 L3。 */
export const MOVE_LIMIT = 50;
/** 活跃保护：mtime 新于此时长的项一律跳过（§5.2 第一行）。 */
export const ACTIVE_MIN_AGE_MS = 24 * 3600_000;
/** 默认白名单（§15.1 放行策略①：先只开 `_tmp` 一个）。 */
export const DEFAULT_WHITELIST = Object.freeze([{ dir: '_tmp', label: '临时区（本卡唯一白名单项）' }]);

/** 名单来源（写进每条拦截理由 ⇒ 人能从一条 skipped 反查到"这道闸是谁、按哪份档定的"）。 */
export const TMP_MOVE_EXCLUDE_SOURCE = 'tools\\dsh-butler\\lib\\tidy-move.mjs 的 TMP_MOVE_EXCLUDE 常量';
/** 名单依据档（名单里每条都引它）。 */
export const TMP_MOVE_EXCLUDE_BASIS = 'docs\\交付报告-生态维护与V3需求-第6棒接手-20261016.md §2/§5-A1';

/**
 * 「主人未决名单」= `_tmp` 搬移的**显式排除位**（2026-10-16 加 · 卡「生态·HOST_C窗口B」）。
 *
 * 用途：某项"还在用 / 还用不用主人还没定"时给它一个**正式保护位** —— 不再靠"排队顺序"或
 *   "恰好有在途卡面提到它"这种时有时无的运气（`running-card` 是近似判据，卡面一改就失效）。
 *   命中 ⇒ 进 `skipped[stage='exclude']`，**永不进候选批**（连 refcheck 都不跑）。
 *
 * 依据（为什么是这三个）：见 `TMP_MOVE_EXCLUDE_BASIS` —— 那三个目录"还用不用"是**主人的判断**，
 *   尚未定；主人 2026-10-16 15:24 拍板「其他按建议落」= 先上闸，**搬/删另议**。
 *
 * 🔴 本名单**只影响 `_tmp` 搬移的候选筛选**：备份 / 幂等 / 单批上限(≤50) / LIFO 回滚 等既有语义一行不动。
 * 🔴 **怎么加下一条（唯一权威源 = 本常量，无同步副本）**：
 *      ① 往下面数组追加 `{ name, since, why }`（`name` = `_tmp` **顶层名**，大小写与磁盘逐字一致）；
 *      ② 复核：`node <pkg>\jobs\butler-tidy-move.mjs --dry-run --json`
 *         ⇒ 该条应出现在 `plan.skipped` 且 `stage='exclude'`、`plan.counters.excluded` +1；
 *      ③ 主人拍板"可以搬了"⇒ 从数组**删掉**那一条（撤保护走一次显式改动，是刻意的）。
 *      临时/一次性用：`--no-exclude`（整体绕过）或 `--exclude a,b`（临时追加，见下）。
 */
export const TMP_MOVE_EXCLUDE = Object.freeze([
  { name: 'supplier-samples', since: '2026-10-16', why: '外部甲方「供应商入驻审核」业务的真实样本目录（甲方名称不在开源面复述）—— 是否继续用未决' },
  { name: 'supplier-audit-ledger', since: '2026-10-16', why: '同上业务的审核台账产物 —— 是否继续用未决' },
  { name: 'see-video', since: '2026-10-16', why: '「看视频」技能的工作目录（yt-dlp 取片 / 抽帧产物）—— 是否继续用未决' },
  // 2026-10-22 增补（家庭保姆线 · ②-C 方案 §4 N6）：refcheck 的 docs/tools/skills 三条已全部放宽为
  //   blocking:false（2026-10-13 / 2026-10-15 主人拍板）⇒「被文档反复提及」不再能拦住它 ⇒ 必须走本名单。
  { name: 'external-inbound', since: '2026-10-22', why: '家庭保姆微信入站活数据（queue\\ 待处理条目 · done.jsonl 墓碑 · media\\ 留存条目 · media-index.jsonl · session.json）—— 被搬走 = 静默丢队列（真源 docs\\方案-保姆微信②C媒体入库-20261022.md §4 N6）' },
]);

/**
 * 主人未决名单 → `Map<name, {why, since, source}>`。
 * @param {Array<string|{name:string, why?:string, since?:string}>} [extra] **追加**项（临时/测试用，不改常量）
 */
export function moveExcludeMap(extra = []) {
  const m = new Map();
  for (const r of [...TMP_MOVE_EXCLUDE, ...(Array.isArray(extra) ? extra : [])]) {
    const name = String(typeof r === 'string' ? r : (r?.name ?? '')).trim();
    if (!name) continue;
    const o = typeof r === 'string' ? {} : r;
    m.set(name, { why: String(o.why ?? '主人未决（暂不搬）'), since: o.since ?? null, source: TMP_MOVE_EXCLUDE_SOURCE });
  }
  return m;
}
/** 归档桶前缀（策略文件 archiveNaming.exempt 已登记 `^_tmp-archive-`，命名合规）。 */
export const BUCKET_PREFIX = '_tmp-archive-';
export const MANIFEST_NAME = 'MANIFEST.json';
/** 本模块**唯一**允许的动作集（无 delete ⇒ 见文件头口径①）。 */
export const MOVE_MODES = Object.freeze(['observe', 'dry-run', 'apply']);
/** 设备短码（§2.7 发现 3：归档桶名带设备短码）。 */
export const DEVICE_CODES = Object.freeze({});

export function deviceName() {
  try { return process.env.COMPUTERNAME || os.hostname() || 'unknown'; } catch { return 'unknown'; }
}

/** 主机名 → 设备短码（未登记的机器回落主机名小写—— 不猜，宁可桶名难看也别撞车）。 */
export function deviceCode(host = deviceName()) {
  const h = String(host).toUpperCase();
  return DEVICE_CODES[h] ?? String(host).toLowerCase();
}

export function dayStamp(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function bucketName(now = Date.now(), code = deviceCode()) {
  return `${BUCKET_PREFIX}${dayStamp(now)}-${code}`;
}

export function bucketPath(dshRoot, now = Date.now(), code = deviceCode()) {
  return path.join(dshRoot, '_archive', bucketName(now, code));
}

/** 文件 sha256（搬移前算、回滚前核；读不出来返回 null —— 不阻断计划，但会在 verify 里报）。 */
export function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

// ─────────────────────────────────────── 第 1.5 道闸：树内 reparse 探测（2026-10-21 加）

/**
 * 规划期「树内 reparse」拒搬的 `skipped.stage` 值。
 * ⚠️ 与既有的 `reparse-point` 区分：那个是 `_tmp` **顶层**就是一个链接（`listTmpTop` 直接拎出来），
 *    这个是**目录里面**藏着 junction / 符号链接（只有递归走才看得见）。
 */
export const REPARSE_TREE_STAGE = 'reparse-tree';

/**
 * 探一棵候选目录树里的 reparse point。**判据本体 = R-065 的 `scanReparsePoints()`**（共享件，
 *   `tools\lib\production-guard.mjs`）—— 本函数只做**摘要 + 定档**，绝不另造一套判据（两套判据
 *   迟早分叉：规划期放行、执行期拒搬，就是本卡要修的病）。
 * 与 R-065 的 `onScanError:'refuse'` 同口径：**没扫完 = 不能断言「树里没有 junction」** ⇒ `unsafe`。
 * @param {string} abs 候选目录的绝对路径
 * @param {{maxEntries?:number, maxDepth?:number}} [opts]
 * @returns {{abs:string, scanned:number, dirs:number, elapsedMs:number, hit:boolean, hitCount:number,
 *            hits:Array<{rel:string, kind:string|null, pointsTo:string|null}>, truncated:boolean,
 *            errors:Array<{path:string, error:string}>, unsafe:boolean}}
 */
export function probeReparseTree(abs, opts = {}) {
  const r = scanReparsePoints(abs, { maxEntries: opts.maxEntries, maxDepth: opts.maxDepth });
  return {
    abs,
    scanned: r.scanned, dirs: r.dirs, elapsedMs: r.elapsedMs,
    hit: r.hits.length > 0, hitCount: r.hits.length,
    hits: r.hits.slice(0, 8).map((h) => ({ rel: h.rel, kind: h.kind ?? null, pointsTo: h.pointsTo ?? null })),
    truncated: r.truncated === true,
    errors: r.errors.slice(0, 5).map((e) => ({ path: e.path, error: String(e.error) })),
    unsafe: r.hits.length > 0 || r.truncated === true || r.errors.length > 0,
  };
}

/** 把 `probeReparseTree()` 的结果写成一句人话（进 `skipped.reason`）。 */
export function describeReparseSkip(p) {
  const parts = [];
  if (p.hit) {
    parts.push(`树内含 reparse point（junction/符号链接）⇒ **R-065 拒搬**（规划期即排除，不进批次）`
      + ` · 命中 ${p.hitCount} 处：`
      + p.hits.map((h) => `${h.rel}${h.pointsTo ? ` → ${h.pointsTo}` : ''}`).join('；')
      + (p.hitCount > p.hits.length ? `；……另有 ${p.hitCount - p.hits.length} 处` : '')
      + ' · 处置：用 `cmd /c rd "<链接路径>"` 单独摘链接（不递归），或确认可留则维持不搬');
  }
  if (p.truncated) parts.push('树内 reparse 扫描被条目/深度上限截断 ⇒ 不能断言"树里没有 junction"（R-065 fail-closed）');
  if (p.errors.length) parts.push('树内有目录读不动 ⇒ 同上（R-065 fail-closed）：'
    + p.errors.map((e) => `${e.path}: ${e.error}`).join('；'));
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────── 第一道闸：活跃保护（§5.2 五条）

/**
 * 运行态硬清单（§5.2 最后一行）——**无条件跳过，优先级最高**。
 * 本模块的射程只有 `_tmp` ⇒ 只登记**可能落在 `_tmp` 里**的两类：
 *   · 当天 `migrate-backup-*`（启动期自动生成的会话迁移备份，随时在写）
 *   · `.lock` / `.tmp` 结尾（别人正持有的锁 / 半成品）
 * 其余（`guard-session.id` / guard flag / `guard.log` / `dsh-web-*.log` / `dl-queue\queue.json`）
 * 实测**全部在 `<tmp>\dsh-guard` 或 `<workspace>\logs`**，不在本模块射程内 —— 但为可核对起见仍登记成
 * "射程外"条目（`inRange:false`），面板/报告要能看见"它被想到了，只是不在这条线上"。
 * @param {{home?:string, dshRoot?:string, now?:number}} [opts]
 */
export function runtimeHardList(opts = {}) {
  const dshRoot = opts.dshRoot ?? workspaceRoot();
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const stamp = dayStamp(now);
  return {
    /** 射程内（`_tmp` 顶层）—— 命中即无条件跳过。 */
    inRange: [
      { match: 'prefix', value: `migrate-backup-${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`, why: '当天 migrate-backup-*（启动期自动写）' },
      { match: 'prefix', value: 'migrate-backup-', why: 'migrate-backup-*（D2 源头产物，清理须先核会话副本 ⇒ 本层不碰）' },
      { match: 'suffix', value: '.lock', why: '锁文件（有人正持有）' },
      { match: 'suffix', value: '.tmp', why: '半成品临时文件（读写进行中）' },
      { match: 'suffix', value: '.err', why: '最近一轮命令的 stderr 落盘（诊断现场，24h 内仍需人看）' },
      { match: 'suffix', value: '.out', why: '最近一轮命令的 stdout 落盘（诊断现场）' },
    ],
    /** 射程外（如实登记，便于核对"硬清单想全了没有"）。 */
    outOfRange: [
      { value: path.join(os.tmpdir(), 'dsh-guard', 'guard-session.id'), why: 'guard 会话 id' },
      { value: path.join(os.tmpdir(), 'dsh-guard', 'guard-flag'), why: 'guard flag' },
      { value: path.join(os.tmpdir(), 'dsh-guard', 'guard2.log'), why: '守护鱼现行日志' },
      { value: path.join(dshRoot, 'logs', 'guard.log'), why: 'guard1 旧日志' },
      { value: '<最新 ≥5 个 dsh-web-*.log>', why: 'DSH web 日志' },
      { value: '<dl-queue/queue.json>', why: '下载队列（本机实测不存在此路径）' },
      { value: path.join(home, 'butler-locks', 'tick-handoff.lock'), why: '交接锁（走抢锁闸，不走硬清单）' },
    ],
    watchRoot: path.join(dshRoot, '_tmp'),
  };
}

/** 命中运行态硬清单？返回 why 或 null。 */
export function hardListHit(relName, list) {
  for (const e of list?.inRange ?? []) {
    if (e.match === 'prefix' && relName.startsWith(e.value)) return e.why;
    if (e.match === 'suffix' && relName.endsWith(e.value)) return e.why;
    if (e.match === 'exact' && relName === e.value) return e.why;
  }
  return null;
}

/**
 * 活跃保护（第一道闸）。返回 `{blocked, reason, stage}`。
 * 覆盖 §5.2 的五条：硬清单 / 24h mtime / 占用 / 锁文件 / 进行中卡（卡面文本近似）。
 * @param {{abs:string, relName:string, stat:fs.Stats}} entry
 * @param {{hardList:object, now:number, minAgeMs?:number, busyNames?:Set<string>, runningCardText?:string|null}} ctx
 */
export function activeProtection(entry, ctx) {
  const minAgeMs = ctx.minAgeMs ?? ACTIVE_MIN_AGE_MS;
  const hard = hardListHit(entry.relName, ctx.hardList);
  if (hard) return { blocked: true, stage: 'hard-list', reason: `运行态硬清单：${hard}` };
  const age = ctx.now - (entry.stat?.mtimeMs ?? 0);
  if (age < minAgeMs) {
    return {
      blocked: true, stage: 'fresh-mtime',
      reason: `24h 活跃保护：mtime 距今 ${(age / 3600_000).toFixed(1)}h < 24h（可能正在用）`,
    };
  }
  if (ctx.busyNames?.has(entry.relName)) return { blocked: true, stage: 'busy', reason: '被进程占用（EBUSY/EPERM 重试 3 次仍失败）' };
  if (ctx.lockGroupNames?.has(entry.relName)) return { blocked: true, stage: 'lock-group', reason: '同组存在 .lock / 同名 .tmp' };
  if (ctx.runningCardText && ctx.runningCardText.includes(entry.relName)) {
    return {
      blocked: true, stage: 'running-card',
      reason: '进行中/待验收卡的卡面提到该名（⚠️ 近似判据：0.1.5 的卡对象无 workspace 字段，'
        + '原设计「workspace 指向的目录」改用卡面文本，更保守）',
    };
  }
  return { blocked: false, reason: null, stage: null };
}

// ─────────────────────────────────────────────────────────── 自治闸（独立于 P3 四键）

/**
 * 搬移闸门（**独立闸**，§15.1 D2 拍板；不并 `runAction` 四键）。
 *   闸门 = L0 降档（`butler-autonomy-state.json#level === 'normal'`）
 *        × L1 `autoAllowed('p8-auto')`（读 `butler-autonomy.json#p8AutoEnabled`）
 *        × L2 `checkModuleAllowed('p8-tidy')`（读 `modules['p8-tidy'].enabled`）
 * 三缺一即拒 —— 且**读不到一律按关**（fail-safe）。
 * @param {{home?:string}} [opts]
 */
export function resolveMoveGate(opts = {}) {
  const home = opts.home ?? dshHome();
  const l0 = readAutonomyState({ home });
  const l1 = autoAllowed('p8-auto', { home });
  const l2 = checkModuleAllowed('p8-tidy', { home });
  const reasons = [];
  if (l0.level !== LEVEL_NORMAL) reasons.push(`L0 降档（level=${l0.level}，reason=${l0.reason}）`);
  if (l1.allowed !== true) reasons.push(`L1 p8AutoEnabled 未放行（${l1.reason}）`);
  if (l2.allowed !== true) reasons.push(`L2 模块门 p8-tidy 未放行（${l2.reason}）`);
  return {
    allowed: reasons.length === 0,
    reason: reasons.length ? reasons.join(' + ') : 'ok（L0 normal × L1 p8AutoEnabled × L2 modules[p8-tidy]）',
    l0: { level: l0.level, source: l0.source, reason: l0.reason },
    l1: { allowed: l1.allowed === true, owner: l1.owner, reason: l1.reason },
    l2: { allowed: l2.allowed === true, owner: l2.owner, reason: l2.reason, moduleEnabled: l2.moduleEnabled },
  };
}

// ─────────────────────────────────────────────────────────── 计划（observe / dry-run / apply 共用）

/** 列 `_tmp` 顶层项（**不穿透 reparse point**，§5.4）。 */
export function listTmpTop(dshRoot) {
  const dir = path.join(dshRoot, '_tmp');
  const out = { dir, exists: false, entries: [], links: [], errors: [] };
  if (!fs.existsSync(dir)) return out;
  out.exists = true;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { out.errors.push(String(e?.message ?? e)); return out; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(abs); } catch (err) { out.errors.push(`${e.name}: ${err?.message ?? err}`); continue; }
    if (st.isSymbolicLink()) { out.links.push({ abs, relName: e.name, isDir: false }); continue; }
    out.entries.push({ abs, relName: e.name, isDir: st.isDirectory(), size: st.isDirectory() ? null : st.size, stat: st });
  }
  return out;
}

/** 目录体积（走 tidy-walk 口径：不穿透内容 reparse point）。 */
function dirStats(abs) {
  let files = 0, bytes = 0, links = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) { links++; continue; }
      if (e.isDirectory()) { walk(full); continue; }
      files++;
      try { bytes += fs.statSync(full).size; } catch { /* 竞态 */ }
    }
  };
  walk(abs);
  return { files, bytes, links };
}

/**
 * 读"进行中/待验收"卡的卡面文本（活跃保护用）。不可达 ⇒ 返回 `{ok:false}`（**不抛、不拦**，
 * 由调用方在报告里如实标注 —— 判据不可用不该变成"静默放行"，也不该变成"全拦"）。
 */
export async function readRunningCardText(opts = {}) {
  const boardUrl = opts.boardUrl ?? 'http://localhost:3080';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  try {
    const r = await fetchImpl(`${boardUrl}/api/task-board/state`, {
      headers: { origin: boardUrl, 'sec-fetch-site': 'same-origin', 'x-dsh-board-scope': 'live' },
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, text: null, cards: 0 };
    const j = await r.json();
    const rows = (j.tasks ?? []).filter((t) => ['running', 'review', 'todo'].includes(t.status));
    const text = rows.map((t) => [t.title, t.description, t.prompt].filter(Boolean).join('\n')).join('\n');
    return { ok: true, error: null, text, cards: rows.length };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), text: null, cards: 0 };
  }
}

/**
 * 出计划（**纯只读**：observe / dry-run / apply 三种模式共用同一份计划逻辑）。
 * @param {{home?:string, dshRoot?:string, now?:number, limit?:number, action?:'move',
 *          runtimeScan?:boolean, boardUrl?:string, fetchImpl?:Function, minAgeMs?:number,
 *          corpus?:object, noExclude?:boolean, excludeNames?:Array}} [opts]
 *   `noExclude: true` ⇒ **临时绕过**主人未决名单（`TMP_MOVE_EXCLUDE`）；`excludeNames` ⇒ 往名单里
 *   **临时追加**（两者都只影响本轮计划，不改常量、不写任何状态文件）。
 */
export async function planTidyMove(opts = {}) {
  const t0 = Date.now();
  const home = opts.home ?? dshHome();
  const dshRoot = opts.dshRoot ?? workspaceRoot();
  const now = opts.now ?? Date.now();
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(MOVE_LIMIT, Number(opts.limit))) : MOVE_LIMIT;
  const gate = resolveMoveGate({ home });
  const hardList = runtimeHardList({ home, dshRoot, now });
  /** 第 0 层闸（策略级）：主人未决名单。`--no-exclude` ⇒ 空表（临时放行，不改常量）。 */
  const excludeMap = opts.noExclude === true ? new Map() : moveExcludeMap(opts.excludeNames);

  const tmp = listTmpTop(dshRoot);
  const runningCards = opts.skipBoard === true
    ? { ok: false, error: 'skipped', text: null, cards: 0 }
    : await readRunningCardText({ boardUrl: opts.boardUrl, fetchImpl: opts.fetchImpl });

  const skipped = [];
  const stage1 = [];   // 过了第一道闸（活跃保护）
  const lockGroups = new Set();
  for (const e of tmp.entries) {
    if (e.relName.endsWith('.lock')) lockGroups.add(e.relName.replace(/\.lock$/, ''));
    if (e.relName.endsWith('.tmp')) lockGroups.add(e.relName.replace(/\.tmp$/, ''));
  }
  const busyNames = new Set(opts.busyNames ?? []);

  for (const e of tmp.entries) {
    // ── 第 0 层闸（策略级 · 2026-10-16）：主人未决名单 —— 优先于运行态/启发式判据
    const ex = excludeMap.get(e.relName);
    if (ex) {
      skipped.push({
        relName: e.relName, stage: 'exclude',
        reason: `来自主人未决名单（暂不搬）：${ex.why}${ex.since ? `（列入 ${ex.since}）` : ''}`
          + ` · 名单来源 = ${ex.source} · 依据 = ${TMP_MOVE_EXCLUDE_BASIS}`
          + ' · 主人拍板"可以搬了"⇒ 从该常量删掉这条即可（或本次加 --no-exclude 临时绕过）',
      });
      continue;
    }
    const ap = activeProtection(e, {
      hardList, now, minAgeMs: opts.minAgeMs,
      busyNames, lockGroupNames: lockGroups, runningCardText: runningCards.ok ? runningCards.text : null,
    });
    if (ap.blocked) { skipped.push({ relName: e.relName, stage: ap.stage, reason: ap.reason }); continue; }
    stage1.push(e);
  }
  for (const l of tmp.links) {
    skipped.push({ relName: l.relName, stage: 'reparse-point', reason: '内容 reparse point（junction/symlink）⇒ 不穿透、不搬（§5.4）' });
  }

  // ── 第 1.5 道闸（结构级 · 2026-10-21）：**树内** reparse 探测。
  //   为什么在引用检查之前：它是"事实判断"（跟 24h mtime 同类），不是"静态文本判断"；
  //   且命中的树本来就不该进批 ⇒ 也就不必为它跑引用检查（省一遍语料扫描）。
  //   判据本体 = R-065 的 `scanReparsePoints()`（共享件）⇒ 规划期与执行期**同一个判据**，
  //   不会再出现"规划期放行、搬到一半被 moveWithRetry 拒"的分叉。
  const reparse = {
    probed: 0, refused: 0, scanned: 0, elapsedMs: 0,
    maxEntries: opts.reparseMaxEntries ?? null, maxDepth: opts.reparseMaxDepth ?? null,
    hits: [],
  };
  const stage15 = [];
  for (const e of stage1) {
    if (e.isDir !== true) { stage15.push(e); continue; }   // 单文件没有"树内"，顶层链接已在上面的 loop 里处理
    const p = probeReparseTree(e.abs, { maxEntries: opts.reparseMaxEntries, maxDepth: opts.reparseMaxDepth });
    reparse.probed++;
    reparse.scanned += p.scanned;
    reparse.elapsedMs += p.elapsedMs;
    if (p.unsafe) {
      reparse.refused++;
      reparse.hits.push({ relName: e.relName, hitCount: p.hitCount, hits: p.hits, truncated: p.truncated, errorCount: p.errors.length });
      skipped.push({ relName: e.relName, stage: REPARSE_TREE_STAGE, reason: describeReparseSkip(p), hits: p.hits });
      continue;
    }
    stage15.push(e);
  }

  // ── 第二道闸：引用检查（只对过了第一道 + 1.5 道的跑 —— P-7 顺序的直接后果）
  const refcheck = stage15.length
    ? checkReferences(stage15.map((e) => ({ path: e.abs, relName: e.relName })), { home, dshRoot, action: 'move', corpus: opts.corpus })
    : { ok: true, results: [], summary: { allow: 0, block: 0, byRule: {} }, corpus: { files: 0, byRule: {}, roots: {} }, scanned: { files: 0, bytes: 0 }, elapsedMs: 0, action: 'move', at: new Date(now).toISOString() };

  const planned = [];
  const byRel = new Map(stage15.map((e) => [e.relName, e]));
  for (const r of refcheck.results) {
    const e = byRel.get(r.relName);
    if (r.verdict !== 'allow') {
      skipped.push({
        relName: r.relName, stage: 'refcheck', reason: `引用检查拦下（${r.blockedBy.join('+')}）`,
        detail: r.hits.slice(0, 3),
      });
      continue;
    }
    const ds = e.isDir ? dirStats(e.abs) : { files: 1, bytes: e.size ?? 0, links: 0 };
    planned.push({
      relName: e.relName, abs: e.abs, isDir: e.isDir,
      sizeBytes: ds.bytes, fileCount: ds.files, innerLinks: ds.links,
      mtimeMs: e.stat.mtimeMs, sha256: e.isDir ? null : sha256File(e.abs),
    });
  }
  planned.sort((a, b) => (a.mtimeMs - b.mtimeMs));   // 最旧的先搬（mtime 升序 = 越早的越该走）
  // 【2026-10-16 修正 · 生态A系列卡8】原为 (b.mtimeMs - a.mtimeMs) = **最新先搬**，与本行注释相反（卡3 §3.3 F2）。
  //   后果：单批 50 条被顶成 766.9 MiB（含 4 个 120MB+ 夹具副本），而"最旧先搬"口径下首批仅 ≤193 MiB（196.9 MiB 实测）。
  //   对齐对象：lib\tidy-desktop.mjs:243 桌面归档那条线本就是 mtime 升序（最旧先走）⇒ 本次是把 _tmp 侧对齐既有设计意图。
  //   回滚：备份 _archive\tidy-sort-fix-20261016\tidy-move.mjs.bak（sha256 D0D53BFA…C688）写回即可。

  const overLimit = planned.length > limit;
  const batch = planned.slice(0, limit);
  const deferred = planned.slice(limit);

  // ── 运行态引用（**advisory**，P-7 盲窗证据；默认不开，observe 报告里按需开）
  let runtime = null;
  if (opts.runtimeScan === true) {
    runtime = await scanRuntimeRefs({
      names: batch.map((b) => b.relName), home, boardUrl: opts.boardUrl,
      withinMs: opts.runtimeWithinMs, maxBytes: opts.runtimeMaxBytes,
      fetchImpl: opts.fetchImpl,
    });
  }

  return {
    ok: true,
    at: new Date(now).toISOString(),
    device: deviceName(),
    deviceCode: deviceCode(),
    dshRoot,
    mode: opts.mode ?? 'observe',
    action: 'move',
    limit,
    gate,
    hardList: { inRange: hardList.inRange.map((x) => x.why), outOfRange: hardList.outOfRange.length },
    exclude: {
      bypassed: opts.noExclude === true,
      source: TMP_MOVE_EXCLUDE_SOURCE,
      basis: TMP_MOVE_EXCLUDE_BASIS,
      /** 本轮生效的名单（**常量 + `opts.excludeNames` 临时追加**；绕过时为空表）。 */
      names: [...excludeMap.keys()].sort(),
      /** 名单里登记了几条（= names.length，单列出来便于对账）。 */
      listed: TMP_MOVE_EXCLUDE.length,
      /** 本机 `_tmp` 里真命中的条数。 */
      hit: skipped.filter((s) => s.stage === 'exclude').length,
    },
    board: { ok: runningCards.ok, error: runningCards.error, cards: runningCards.cards },
    tmp: { dir: tmp.dir, exists: tmp.exists, topEntries: tmp.entries.length, links: tmp.links.length, errors: tmp.errors },
    refcheck: { version: REFCHECK_VERSION, summary: refcheck.summary, corpus: refcheck.corpus, scanned: refcheck.scanned, elapsedMs: refcheck.elapsedMs },
    /** 第 1.5 道闸：树内 reparse 探测的读账（`probed` = 探了几棵候选树 · `refused` = 命中几棵）。 */
    reparse,
    batch,
    deferred,
    overLimit,
    skipped,
    runtime,
    counters: {
      candidates: tmp.entries.length,
      passedActive: stage1.length,
      /** 第 1.5 道闸（树内 reparse）拒搬的条数 —— `skipped` 的子集，单列便于对账。 */
      reparseRefused: reparse.refused,
      planned: planned.length,
      batched: batch.length,
      skipped: skipped.length,
      deferred: deferred.length,
      /** 第 0 层闸（主人未决名单）拦下的条数 —— `skipped` 的子集，单列便于对账。 */
      excluded: skipped.filter((s) => s.stage === 'exclude').length,
      bytes: batch.reduce((a, b) => a + (b.sizeBytes ?? 0), 0),
    },
    elapsedMs: Date.now() - t0,
  };
}

// ─────────────────────────────────────────────────────────── manifest + 回滚脚本

export function manifestPath(bucket) { return path.join(bucket, MANIFEST_NAME); }

/** 回滚脚本文件名（也是桌面入口引用的名字）。 */
export function restoreScriptName(bucket) { return `restore-${path.basename(bucket)}.mjs`; }

/**
 * 生成**自足**的一键搬回脚本源码（只依赖 node 内置模块；不 import dsh-butler 任何东西
 * —— 否则工具树一变，回滚脚本就跟着失效，那是最不能失效的东西）。
 */
export function renderRestoreScript(manifest) {
  // ⚠️ 生成器**不写巨型模板字面量**：把被生成的源码逐行放进数组再 join。
  //   理由：被生成的脚本里本来就有反引号与 `${}`（它自己的 console.log），一旦放进外层模板字面量，
  //   两个转义面就会互相咬（2026-09-28 实测踩过一次，语法直接崩）⇒ 数组 join 是唯一不会咬的写法。
  const scriptName = restoreScriptName(manifest.bucket);
  const L = [
    '#!/usr/bin/env node',
    '// 一键搬回：' + manifest.bucket,
    '//',
    '// 本脚本由 dsh-butler / lib/tidy-move.mjs 自动生成（component=' + manifest.component + ' v' + manifest.version + '）。',
    '// 它只做一件事：**按 MANIFEST.json 原路把文件搬回** <workspace>/_tmp。',
    '//   - 默认 dry-run，加 --apply 才真搬；',
    '//   - 同卷 renameSync；跨卷 copy+校验+删源（跨卷是兜底，本机 _tmp/_archive 同卷）；',
    '//   - 搬回前核 sha（搬移不改内容 => sha 必须一致；不一致 = 桶里被改过 => 默认拒绝，加 --force 才动）；',
    '//   - 目标已存在 => 默认拒绝（不覆盖活文件），加 --force 才动。',
    '// 用法：node ' + scriptName + ' [--apply] [--force] [--json]',
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import crypto from 'node:crypto';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));',
    "const MANIFEST = path.join(HERE, '" + MANIFEST_NAME + "');",
    'const argv = process.argv.slice(2);',
    "const apply = argv.includes('--apply');",
    "const force = argv.includes('--force');",
    "const asJson = argv.includes('--json');",
    "const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };",
    '',
    "const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));",
    "// 拒搬条目（moved === false 且带 error）：桶里从来没有它 ⇒ 不算「该搬回但搬不回」，单列出来（2026-10-21）",
    'const allRows = Array.isArray(m.entries) ? m.entries : [];',
    'const rows = allRows.filter((e) => !(e.moved === false && e.error));',
    'const refusedRows = allRows.filter((e) => e.moved === false && e.error);',
    'const done = [], failed = [], skippedRows = [];',
    '',
    '// ── R-065 三件套（自足版：生成脚本不得依赖工具树）──',
    '//   语义对齐 tools/lib/production-guard.mjs 的 gateDestructive：reparse 拒搬 + 白名单拒跑；',
    '//   dry-run 由 moveBack() 的第一条语句保证。',
    'const ROOTS = [HERE].concat([...new Set((m.entries || []).map((e) => path.dirname(e.from)))]);',
    'const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };',
    'const under = (p, r) => path.resolve(p).toLowerCase().startsWith(path.resolve(r).toLowerCase());',
    'function gateDestructive(from, to) {',
    "  if (isLink(from) || isLink(to)) return { ok: false, why: '源/目标自身是 reparse point（junction/symlink）⇒ 拒绝搬回（R-065①）' };",
    "  if (!ROOTS.some((r) => under(from, r)) || !ROOTS.some((r) => under(to, r))) return { ok: false, why: '搬回目标不在白名单根内（R-065②）' };",
    '  return { ok: true };',
    '}',
    'function moveBack(e) {',
    '  if (!apply) return { ok: true, dryRun: true };',
    '  const g = gateDestructive(e.to, e.from);',
    '  if (!g.ok) return g;',
    '  try {',
    '    fs.mkdirSync(path.dirname(e.from), { recursive: true });',
    '    try {',
    '      fs.renameSync(e.to, e.from);            // 同卷',
    '    } catch (err) {',
    "      if (err && (err.code === 'EXDEV')) {    // 跨卷：copy + 校验 + 删源",
    '        fs.copyFileSync(e.to, e.from);',
    '        const a = sha(e.to), b = sha(e.from);',
    "        if (a && b && a !== b) { try { fs.rmSync(e.from, { force: true }); } catch {} return { ok: false, why: '跨卷复制校验失败，已回收目标' }; }",
    '        fs.rmSync(e.to, { force: true });',
    '      } else throw err;',
    '    }',
    '    return { ok: true };',
    "  } catch (err) { return { ok: false, why: String((err && err.message) || err) }; }",
    '}',
    'for (const e of rows) {',
    "  if (!fs.existsSync(e.to)) { skippedRows.push({ rel: e.rel, why: '桶内源不存在（可能已被手工搬回）' }); continue; }",
    "  if (fs.existsSync(e.from) && !force) { failed.push({ rel: e.rel, why: '目标已存在（不覆盖活文件；--force 可强搬）' }); continue; }",
    '  if (e.sha256) {',
    '    const cur = sha(e.to);',
    "    if (cur && cur !== e.sha256 && !force) { failed.push({ rel: e.rel, why: 'sha 与 manifest 不符（桶里被改过；--force 可强搬）' }); continue; }",
    '  }',
    '  const r = moveBack(e);',
    '  if (r.dryRun) done.push({ rel: e.rel, dryRun: true });',
    "  else if (!r.ok) failed.push({ rel: e.rel, why: r.why });",
    '  else done.push({ rel: e.rel, back: e.from });',
    '}',
    'if (asJson) console.log(JSON.stringify({ manifest: MANIFEST, apply, moved: done.length, failed, skipped: skippedRows, refused: refusedRows.map((e) => ({ rel: e.rel, why: e.error || null })) }, null, 2));',
    'else {',
    "  console.log((apply ? '搬回' : 'DRY-RUN') + '：' + m.bucket + '（' + rows.length + ' 条，创建于 ' + m.at + '）'"
      + " + (refusedRows.length ? ' · 另有拒搬 ' + refusedRows.length + ' 条（当年没搬走，原位保留）' : ''));",
    "  for (const d of done) console.log((apply ? '  OK  ' : '  .   ') + d.rel);",
    "  for (const s of skippedRows) console.log('  SKIP ' + s.rel + ' — ' + s.why);",
    "  for (const r of refusedRows) console.log('  REFUSED ' + r.rel + ' — 拒搬（从未进桶）：' + String(r.error || '').split('\\n')[0]);",
    "  for (const f of failed) console.log('  FAIL ' + f.rel + ' — ' + f.why);",
    "  if (!apply) console.log('\\n（dry-run：没有动任何文件；加 --apply 才真搬回）');",
    '}',
    'process.exitCode = failed.length ? 1 : 0;',
    '',
  ];
  return L.join('\n');
}

/** 桌面一键入口（**.cmd 必须纯 ASCII** —— 中文在 GBK 解析下会拆坏命令）。 */
export function renderDesktopCmd(manifest) {
  const script = path.join(manifest.bucket, restoreScriptName(manifest.bucket));
  return [
    '@echo off',
    'REM ============================================================',
    `REM  P8 tidy archive restore - bucket ${path.basename(manifest.bucket)}`,
    `REM  Created ${manifest.at} by dsh-butler ${manifest.component} v${manifest.version}`,
    `REM  Moves ${manifest.entries.length} item(s) back to ${manifest.dshRoot}\\_tmp`,
    'REM  Default = dry run. Pass "apply" to really move back.',
    'REM ============================================================',
    'setlocal',
    `set "S=${script}"`,
    'if not exist "%S%" (',
    '  echo [ERROR] restore script not found: %S%',
    '  pause',
    '  exit /b 2',
    ')',
    'if /i "%~1"=="apply" (',
    '  node "%S%" --apply',
    ') else (',
    '  echo === DRY RUN: nothing will be moved. Run with "apply" to move back. ===',
    '  node "%S%"',
    ')',
    'echo.',
    'pause',
    '',
  ].join('\r\n');
}

/**
 * 读桶内既有清单（合并用）。桶内没有 ⇒ `{ exists: false }`。
 * 读得到但**解析失败 / kind 不符 / bucket 不符 / 缺 entries** ⇒ **抛错**（拒绝整文件覆盖：
 * 宁可本轮停手，也不丢回滚凭据）。
 */
export function readBucketManifest(bucket) {
  const file = manifestPath(bucket);
  if (!fs.existsSync(file)) return { exists: false, manifest: null, file };
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`桶内已有 MANIFEST.json 但解析失败（拒绝整文件覆盖，避免丢回滚凭据）：${file} —— ${e?.message ?? e}`); }
  if (!m || m.kind !== 'tmp-archive-manifest') throw new Error(`桶内 MANIFEST.json 的 kind 不是 tmp-archive-manifest（拒绝混写）：${file}`);
  if (m.bucket && path.resolve(String(m.bucket)) !== path.resolve(bucket)) throw new Error(`桶内 MANIFEST.json 的 bucket 与本桶不一致（拒绝混写）：${m.bucket} ≠ ${bucket}`);
  if (!Array.isArray(m.entries)) throw new Error(`桶内 MANIFEST.json 缺 entries 数组（拒绝整文件覆盖）：${file}`);
  return { exists: true, manifest: m, file };
}

/**
 * 合并本批清单与桶内既有清单（**同日多批 = 追加 entries**，不是覆盖）。
 *   去重键 = 条目落地路径 `to`；**本批覆盖同键历史条目**（最新一次搬移是权威）。
 *   顶层元数据取本批的，但 `at` 保留**最早**（= 桶创建时间），并累积 `batches` 摘要（每批一行，便于对账）。
 * 2026-10-13 修（`docs\交接-愿景实体核查-20261013.md` §6b 第 5 条）：旧实现整文件覆盖 ⇒ 同日第二批把第一批
 *   entries 冲掉，桶内 restore 脚本随之只认识最后一批（实测 `_archive\_tmp-archive-20261013-host-a` 桶内
 *   16 条 vs 清单 10 条）。
 */
export function mergeBucketManifest(bucket, manifest) {
  const prev = readBucketManifest(bucket);
  const oldEntries = prev.exists ? prev.manifest.entries : [];
  const key = (e) => String(e?.to ?? e?.rel ?? '');
  const incoming = new Set((manifest.entries ?? []).map(key));
  const kept = oldEntries.filter((e) => !incoming.has(key(e)));
  const oldBatches = prev.exists && Array.isArray(prev.manifest.batches) ? prev.manifest.batches : [];
  const entries = manifest.entries ?? [];
  const merged = {
    ...manifest,
    at: prev.exists ? (prev.manifest.at ?? manifest.at) : manifest.at,
    entries: [...kept, ...entries],
    batches: [...oldBatches, {
      at: manifest.at,
      planned: entries.length,
      moved: entries.filter((e) => e.moved === true).length,
      failed: entries.filter((e) => e.moved === false && e.error).length,
      /** 拒搬条数（2026-10-21 加）：`moved === false` 且**有 error** = 被闸门拒 / 搬失败；
       *  与 `failed` 同源，但单列出来便于对账（verify 侧按 `moved === false` 跳过，不看 `error`）。 */
      refused: entries.filter((e) => e.moved === false && e.error).length,
      bytes: manifest.counters?.bytes ?? 0,
    }],
  };
  return { merged, prevExists: prev.exists, prevEntries: oldEntries.length, kept: kept.length, added: entries.length, file: prev.file };
}

/**
 * 写 manifest（**manifest-first**：写不出来 ⇒ 调用方必须放弃搬移）。
 * 走 `mergeBucketManifest()`：同桶同日多批 = **追加**（见上）。
 * @returns {string} manifest 文件路径（保持旧签名）
 */
export function writeManifest(bucket, manifest) {
  fs.mkdirSync(bucket, { recursive: true });
  const { merged } = mergeBucketManifest(bucket, manifest);
  writeJsonAtomic(manifestPath(bucket), merged, {});
  return manifestPath(bucket);
}

/**
 * 校验 manifest（搬完立刻跑一次；失败 ⇒ 调用方自动搬回）。
 * @param {string} bucket
 * @param {{rels?:string[]|null}} [opts] `rels` = 只校验这批 rel（**合并桶必须限本批**）：历史条目对应的
 *   `_tmp` 位置后来又出现同名新文件是常态，那不该把**本批**判红并触发误回滚。缺省 = 全量
 *   （CLI `--verify-manifest` 语义不变：桶内清单每一条现在能否原路搬回）。
 *
 * 🔴 2026-10-21 修：**`moved === false`（拒搬）条目一律跳过**，单列到 `refused`。
 *   理由：拒搬项**从来没搬走**（R-065 在 `moveWithRetry` 里就拒了：源还在原位、桶里从来没有它），
 *   用「桶内有 + 原位无 + sha 对」判它 = **必然假红** ⇒ `tidy-move-verify-failed` 审计行 +
 *   `verified:false`，看着像搬坏了。判据只对**真搬过**的条目成立（口径：不因"没搬"报"搬坏了"）。
 *   真损坏（桶里文件 sha 变了 / 桶内缺 / 原位又长出同名文件）**照旧报红**，`bad` 语义不变。
 *   ⚠️ 只把**带理由**的（`moved === false && error`）当拒搬。`moved === false` **且无 error**
 *      = 清单写了但没走到搬（进程崩在"写 manifest 之后、搬之前"—— 方案 §8 那条崩溃面）⇒
 *      **照旧判红**（行上标 `incomplete: true`），否则"什么都没搬"会被伪装成"全部一致"。
 */
export function verifyManifest(bucket, opts = {}) {
  const file = manifestPath(bucket);
  const m = readJson(file);
  if (!m) return { ok: false, error: `读不到 manifest：${file}`, rows: [], bad: 0, refused: [], refusedCount: 0, scope: 'all' };
  const only = Array.isArray(opts.rels) ? new Set(opts.rels) : null;
  const rows = [];
  const refused = [];
  let bad = 0;
  for (const e of m.entries ?? []) {
    if (only && !only.has(e.rel)) continue;
    if (e.moved === false) {
      if (e.error) {
        refused.push({ rel: e.rel, from: e.from ?? null, to: e.to ?? null, reason: e.error });
        continue;
      }
      // 清单里写了、没搬、也没记理由 ⇒ 当作"没搬完"报红（不伪装成 refused —— 那会盖掉真问题）
      bad++;
      rows.push({ rel: e.rel, toExists: fs.existsSync(e.to), fromExists: fs.existsSync(e.from), shaOk: null, ok: false, incomplete: true });
      continue;
    }
    const toExists = fs.existsSync(e.to);
    const fromExists = fs.existsSync(e.from);
    const curSha = toExists && e.sha256 ? sha256File(e.to) : null;
    const shaOk = e.sha256 ? curSha === e.sha256 : true;
    const ok = toExists && !fromExists && shaOk;
    if (!ok) bad++;
    rows.push({ rel: e.rel, toExists, fromExists, shaOk, ok });
  }
  return {
    ok: bad === 0, rows, bad,
    /** 拒搬条目（`moved === false`）：**不参与一致性判定**，只如实登记「这条本来就没搬」。 */
    refused, refusedCount: refused.length,
    manifest: m, file, scope: only ? 'batch' : 'all',
  };
}

// ─────────────────────────────────────────────────────────── 执行（apply）

/**
 * 真搬（**只在 `apply` 模式下被调用**）。
 * 顺序（任一步失败 ⇒ 停手 + 已搬的自动搬回）：
 *   ① 自治闸（L0 × L1 × L2）② 抢 `handoff` 锁（waitMs 0）③ 建桶
 *   ④ **写 manifest（fail-close）** ⑤ 逐条 `renameSync`（EBUSY/EPERM 重试 3 次）
 *   ⑥ 写回滚脚本 + 桌面入口 ⑦ `verifyManifest()` ⑧ 审计留痕
 * @param {object} plan planTidyMove() 的结果
 * @param {{home?:string, now?:number, dryRun?:boolean, skipLock?:boolean, desktopDir?:string|null}} [opts]
 */
export function applyTidyMove(plan, opts = {}) {
  const t0 = Date.now();
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const result = {
    ok: false, at: new Date(now).toISOString(), bucket: null, moved: [], skipped: [], failed: [],
    rolledBack: [], manifest: null, manifestEntries: null, manifestMerge: null, restoreScript: null, desktopCmd: null,
    gate: plan?.gate ?? null, verified: null, lock: null, elapsedMs: 0,
  };
  if (!plan) { result.failed.push({ why: 'no plan' }); result.elapsedMs = Date.now() - t0; return result; }
  if (opts.dryRun === true || plan.mode !== 'apply') {
    result.failed.push({ why: `applyTidyMove 只接受 mode='apply' 的计划（实得 mode=${plan.mode}）——observe/dry-run 零副作用` });
    result.elapsedMs = Date.now() - t0; return result;
  }
  const gate = resolveMoveGate({ home });
  result.gate = gate;
  if (!gate.allowed) { result.failed.push({ why: `自治闸未放行：${gate.reason}` }); result.elapsedMs = Date.now() - t0; return result; }

  // ② 抢 handoff 锁（§5.2 订正：写入侧必须抢；抢不到 ⇒ 跳过整轮，不静默）
  let lock = { ok: true, inherited: true, release: () => false };
  if (opts.skipLock !== true) {
    lock = acquireTickLock('handoff', { ttlMs: 10 * 60_000, waitMs: 0, home });
    result.lock = { ok: lock.ok === true, reason: lock.reason ?? null, lockPath: lock.lockPath ?? null, inherit: lock.inherit === true, holder: lock.holder ?? null };
    if (lock.ok !== true) {
      result.failed.push({ why: `抢 handoff 锁失败（${lock.reason}）⇒ 本轮整轮跳过（交接复制进行中，搬走源 = 静默漏采）` });
      result.elapsedMs = Date.now() - t0; return result;
    }
  } else {
    result.lock = { ok: true, reason: 'skipLock（测试用）', inherited: true };
  }

  try {
    const batch = plan.batch ?? [];
    if (!batch.length) { result.ok = true; result.failed.push({ why: '无候选（batch 为空）' }); return finish(); }
    if (batch.length > MOVE_LIMIT) { result.failed.push({ why: `单批 ${batch.length} > 上限 ${MOVE_LIMIT}（爆炸半径护栏）` }); return finish(); }

    const bucket = bucketPath(plan.dshRoot ?? workspaceRoot(), now, plan.deviceCode ?? deviceCode());
    result.bucket = bucket;
    fs.mkdirSync(bucket, { recursive: true });

    // ④ manifest-first（fail-close）
    const manifest = {
      schemaVersion: 1,
      kind: 'tmp-archive-manifest',
      product: 'dsh-butler',
      component: 'butler-tidy-move',
      version: TIDY_MOVE_VERSION,
      at: new Date(now).toISOString(),
      device: plan.device ?? deviceName(),
      deviceCode: plan.deviceCode ?? deviceCode(),
      dshRoot: plan.dshRoot ?? workspaceRoot(),
      bucket,
      action: 'move',
      limit: plan.limit ?? MOVE_LIMIT,
      gate,
      refcheck: plan.refcheck ?? null,
      entries: batch.map((b) => ({
        rel: b.relName,
        from: b.abs,
        to: path.join(bucket, b.relName),
        isDir: b.isDir === true,
        sizeBytes: b.sizeBytes ?? null,
        fileCount: b.fileCount ?? null,
        mtimeMs: b.mtimeMs ?? null,
        sha256: b.sha256 ?? null,
        moved: false,
      })),
      counters: { planned: batch.length, bytes: plan.counters?.bytes ?? 0 },
      warning: '本文件是**搬移**（非删除）的回滚凭据：回滚 = 按 from/to 反向搬回。'
        + '搬移不改内容 ⇒ 回滚前核 sha；sha 不符（桶里被改过）默认拒绝，须 --force。'
        + '⚠️ 不要用「整文件覆盖」的方式回滚 —— 本桶只增不减。',
    };
    let mergedInfo;
    try { mergedInfo = mergeBucketManifest(bucket, manifest); }
    catch (e) { result.failed.push({ why: `manifest 合并失败（fail-close，一个文件都不搬）：${e?.message ?? e}` }); return finish(); }
    try { writeJsonAtomic(manifestPath(bucket), mergedInfo.merged, {}); }
    catch (e) { result.failed.push({ why: `manifest 写失败（fail-close，一个文件都不搬）：${e?.message ?? e}` }); return finish(); }
    result.manifest = manifestPath(bucket);
    result.manifestEntries = mergedInfo.merged.entries.length;
    result.manifestMerge = { prevExists: mergedInfo.prevExists, prevEntries: mergedInfo.prevEntries, kept: mergedInfo.kept, added: mergedInfo.added, at: mergedInfo.merged.at };

    // ⑤ 逐条搬（本批 entries 与 merged.entries 是**同一批对象** ⇒ 下面的 moved 状态已反映到合并清单里）
    for (const e of manifest.entries) {
      const moved = moveWithRetry(e.from, e.to);
      if (moved.ok) { e.moved = true; result.moved.push({ rel: e.rel, from: e.from, to: e.to }); }
      else { result.skipped.push({ rel: e.rel, why: moved.reason }); e.moved = false; e.error = moved.reason; }
    }
    // 二次落盘：写回**合并后**的清单（历史条目 + 本批 moved 状态）。
    // ⚠️ 这里绝不能写 `{ ...manifest }` —— 那会把刚合并进来的历史条目整片冲掉（2026-10-13 修的就是这一处）。
    const merged = mergedInfo.merged;
    merged.batches = merged.batches.map((b, i) => (i === merged.batches.length - 1
      ? { ...b, moved: result.moved.length, failed: result.skipped.length, refused: manifest.entries.filter((e) => e.moved === false).length }
      : b));
    merged.completedAt = new Date().toISOString();
    writeJsonAtomic(manifestPath(bucket), merged, {});

    // ⑥ 回滚脚本 + 桌面入口（用**合并后**清单 ⇒ 桶内 restore 脚本认识桶里**全部**条目，不只最后一批）
    const rs = path.join(bucket, restoreScriptName(bucket));
    fs.writeFileSync(rs, renderRestoreScript({ ...merged, bucket }), 'utf8');
    result.restoreScript = rs;
    const dd = opts.desktopDir === null ? null : (opts.desktopDir ?? desktopEntryDir({ mkdir: true }));
    if (dd) {
      const cmd = path.join(dd, `restore-p8-${bucketName(now, manifest.deviceCode)}.cmd`);
      fs.writeFileSync(cmd, renderDesktopCmd({ ...merged, bucket }), 'ascii');
      result.desktopCmd = cmd;
    }

    // ⑦ 搬完校验；失败 ⇒ 自动搬回（§6 护栏「回滚验证」）
    //    合并桶**只校验本批 rel**（历史条目在 _tmp 又出现同名新文件属常态，不该把本批判红误回滚）
    const v = verifyManifest(bucket, { rels: manifest.entries.map((e) => e.rel) });
    // 拒搬条目（moved === false）不参与判红（2026-10-21）⇒ 本批 `verified.ok` 只反映**真搬过**的条目
    result.verified = { ok: v.ok, bad: v.bad, rows: v.rows, refused: v.refused, refusedCount: v.refusedCount };
    if (!v.ok) {
      for (const r of v.rows.filter((x) => !x.ok)) {
        const e = manifest.entries.find((x) => x.rel === r.rel);
        if (e && fs.existsSync(e.to) && !fs.existsSync(e.from)) {
          const back = moveWithRetry(e.to, e.from);
          result.rolledBack.push({ rel: r.rel, ok: back.ok, why: back.reason ?? null });
        }
      }
      result.failed.push({ why: `搬移后 manifest 校验失败（bad=${v.bad}）⇒ 已自动搬回 ${result.rolledBack.length} 条` });
      appendAudit({ type: 'tidy-move-verify-failed', bucket, bad: v.bad, rolledBack: result.rolledBack, device: manifest.device }, { home });
      return finish();
    }
    result.ok = true;
  } catch (e) {
    result.failed.push({ why: `执行异常：${e?.message ?? e}` });
  } finally {
    try { lock.release?.(); } catch { /* ignore */ }
  }
  return finish();

  function finish() {
    result.elapsedMs = Date.now() - t0;
    return result;
  }
}

/** 搬一个（同卷 rename；EBUSY/EPERM 重试 3 次，50/150/400ms —— §5.2 第二行）。 */
export function moveWithRetry(from, to, opts = {}) {
  const waits = opts.waits ?? [50, 150, 400];
  // R-065 三件套（锁6 · 批 E2）：搬移语义先在函数内过闸（dry-run 由调用方在外层挡；本函数是执行器）
  const guard = gateDestructive({
    targets: [{ path: from, label: 'src' }, { path: to, label: 'dst' }],
    whitelist: opts.whitelist ?? [path.dirname(from), path.dirname(to)],
    op: '搬移', scope: ['file'], requires: ['file'], dryRun: false,
    allowProduction: true, allowReparse: false, ledgerBypass: false, reason: opts.reason ?? 'tidy-move 搬移',
  });
  if (!guard.ok) return { ok: false, refused: true, reason: `R-065 三件套拒绝（${guard.code}）：${String(guard.reason).split('\n')[0]}` };
  let last = null;
  for (let i = 0; i <= waits.length; i++) {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return { ok: true };
    } catch (e) {
      last = e;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e?.code)) break;
      if (i < waits.length) { const until = Date.now() + waits[i]; while (Date.now() < until) { /* 忙等：本函数是同步 API */ } }
    }
  }
  return { ok: false, reason: `${last?.code ?? ''} ${last?.message ?? last}`.trim() };
}

/** 一行摘要（CLI / 面板 / 日报用）。 */
export function describePlan(plan) {
  if (!plan) return '（无计划）';
  const g = plan.gate?.allowed ? '放行' : `停（${plan.gate?.reason}）`;
  return `P8 L2 搬移计划[${plan.mode}] ${plan.device}/${plan.deviceCode} · 闸门=${g}`
    + ` · 候选 ${plan.counters.candidates} → 过活跃保护 ${plan.counters.passedActive}`
    + ` → 树内 reparse 拒搬 ${plan.counters.reparseRefused ?? 0} → 计划 ${plan.counters.planned}`
    + ` → 本批 ${plan.counters.batched}（上限 ${plan.limit}，超限 ${plan.counters.deferred}）`
    + ` · ${(plan.counters.bytes / 1024).toFixed(1)}KB · ${plan.elapsedMs}ms`;
}
