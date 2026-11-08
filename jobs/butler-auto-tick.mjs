// dsh-butler / butler-auto-tick.mjs —— P3 会派活：自动动作 tick 入口（L1/L2 + token 监测）
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §4 P3 + §5 裸跑期
//
// **本入口是 P3 的「唯一执行点」**：所有自动动作都经 lib/autonomy-actions.runAction 的统一闸门，
//   闸门 = ①分级表（L3 永不自动）②四把开关之一 p3AutoEnabled（裸跑期默认 false）
//         ③签名去重 24h ④每日次数上限 ⑤token 预算门
//
// ❗ 2026-09-13（卡 S5·[6a-实施]）：**账本写路径 = Host API 调用序列**（`lib\ledger-api.mjs`）——
//   `dup-cards-merge` 不再直写 `ledger-v2.json`（Host 内存 document 整份 commit 会静默覆盖直写内容）。
//   账本读取也改为 `GET /api/task-board/state`（权威态）；`--ledger <file>` 只用于**离线/隔离只读检测**，
//   且此时必须显式 `--base-url` 指向测试/mock Host 才允许真跑（否则拒绝，防误写生产看板）。
//   备份机制：不再是"拷账本文件"，而是**动作前 `GET /state` 快照**（落 state-<revision>-<ts>.json）。
//
// 用法：
//   node butler-auto-tick.mjs                      # 常规 tick（闸门关 → 全部 blocked，零副作用）
//   node butler-auto-tick.mjs --dry-run            # 只算不动：输出"将要做什么" + 落 --out 证据文件
//   node butler-auto-tick.mjs --job dup            # 只跑一个 job（dup|precheck|archive|token|wake|restart|rollback|heal|ctx-guard）
//   node butler-auto-tick.mjs --home <dir>         # 隔离 home（测试用；等价 BUTLER_DSH_HOME）
//
// ❗ 2026-09-15（卡：四动作接线 · B1）：新增 4 个 job（wake / restart / rollback / heal）—— 把四个
//   **已实现但未接线**的自动动作（`queue-wake` / `p0-auto-restart` / `p5-auto-rollback` / `auto-heal`）
//   接进 tick 链：`butler-tickd.mjs` 的 JOBS 新增 4 条 job，各自带 `--job <id>` spawn 本脚本。
//   · 语义 = **真执行路径**（dryRun:false）：一律经动作体自身的模块门 + `runAction()` 统一闸门；
//   · 四门（`p3AutoEnabled` / `p0AutoRestartEnabled` / `p5AutoRollbackEnabled` / `autoHealEnabled`）
//     全关时 → `status='blocked'` 且**零副作用**（不写记账 / 不占额度 / 不写审计 / 不 spawn）；
//   · 影子预测（dry-run 记账）**不由 tickd 驱动**：需要时手动 `--job <id> --dry-run`（只算不动）；
//     放行前的预测基线 + 放行后 48h 对照方案见
//     `docs\管家-四动作接线与48h影子对照-20260915.md`。
//   ⚠️ 本次接线**不放行任何开关**（四门键值一字未动）→ tickd 每轮跑到的都是 blocked。
//   node butler-auto-tick.mjs --ledger <file>      # 离线只读检测（写需配 --base-url，见上）
//   node butler-auto-tick.mjs --base-url <url>     # Host 地址（默认 http://localhost:3080）
//   node butler-auto-tick.mjs --json               # 机器可读输出
//
// **dry-run 语义（交付验收要求）**：
//   - 绝不写账本、绝不发 action、绝不写生产状态文件（状态写入重定向到 --out 目录）
//   - 只读产物仍会落盘（--out 默认 <workspace>\_tmp\butler-auto-dryrun\<时间戳>\），便于贴证据
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import path from 'node:path';

import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { createScheduler } from './lib/scheduler.mjs';
import { appendAudit } from '../src/dsh-butler/lib/audit.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { AUTO_KINDS, describeAutonomy } from '../src/dsh-butler/lib/autonomy.mjs';
import { AUTO_ACTION_KINDS, describeActions, readLimits, runAction, sigKeyOf, localDay } from '../src/dsh-butler/lib/autonomy-actions.mjs';
import { planDuplicateMerge, applyDuplicateMerge } from '../src/dsh-butler/lib/dup-cards.mjs';
import { readLedger, defaultLedgerPath } from './lib/ledger-write.mjs';
import { createLedgerApi, DEFAULT_BASE_URL } from '../src/dsh-butler/lib/ledger-api.mjs';
import { precheckReviewCards, recordPrecheck, readPrecheckState, summarizePrecheck } from './lib/evidence-precheck.mjs';
import { scanTokenUsage, persistTokenState, readTokenState, describeTokenUsage, checkThresholds, usageForDay, tokenStateFile } from './lib/token-usage.mjs';
import { gatherArchiveAutoStatus, attemptArchiveRetry, attemptMetaBackfill } from './lib/archive-watch.mjs';
import { gateComponent } from '../src/dsh-butler/lib/version.mjs';
// 【2026-09-15 接线】四个已实现动作的执行体（各自内部 = 只读采集 → 模块门 → runAction 统一闸门）
import { runQueueWake } from '../src/dsh-butler/lib/queue-wake.mjs';
import { runAutoRestart } from './lib/p0-auto-restart.mjs';
import { runAutoRollback } from './lib/p5-auto-rollback.mjs';
import { runAutoHeal } from './lib/auto-heal.mjs';
// 【2026-09-16 接线】上下文看门（`ctx-guard`）：超阈值时向**在跑**会话 queue 模式投递「移交」提醒
import { runCtxGuard } from './lib/ctx-guard.mjs';
// 【2026-09-28 接线 · 卡 K5d】看板周期归档（`board-line-archive`）：整线"在板全完成"⇒ 逐线调既有
//   `tools\board-archive-line.mjs --line … --apply --emit-restore`。闸门 = 动作体模块门 + runAction 统一闸门。
import { runBoardLineArchive } from './lib/board-line-archive.mjs';
// 【2026-09-21 接线 · 卡 S3c】记忆提炼（`memory-distill`）：夜间把窗口内新增/变更的记忆聚类提炼成长期结论。
//   形态 = `butler-auto-tick.mjs --job distill`（方案 §3.5 第 3 条 P1 拍板）⇒ 才有**真正的 job 级模块门**
//   + 复用本调度的锁/失败隔离/日报。**成本闸自带**（引擎侧：≤20 次/日 · ≤150K token/日 · 超限即停不重试）。
import { runDistillJob } from './lib/distill-job.mjs';

// 版本号与 lib/version.mjs 的 COMPONENT_VERSIONS['butler-auto']、cli 的 VERSION、product.mjs 的
//   PRODUCT_VERSION 必须一致（否则组件自检 version-mismatch → 整个 tick 跳过）。
export const AUTO_TICK_VERSION = '0.1.0';
const COMPONENT = 'butler-auto';

const MIN = 60_000;

/** job 定义（间隔与 tickd 的 JOBS 对齐；独立注册 + 独立失败隔离由 scheduler 保证）。 */
export const AUTO_JOBS = {
  dup: { id: 'dup', label: 'P3-L1 重复卡检测+合并', intervalMs: 6 * 3600_000 },
  precheck: { id: 'precheck', label: 'P3-L1 待验收证据预检', intervalMs: 10 * MIN },
  archive: { id: 'archive', label: 'P3-L2 归档出错自动重试', intervalMs: 30 * MIN },
  // 【冲刺600 · 2026-10-09 卡「token 用量监测接调度」】intervalMs 6h → 60min，**三处同值**
  //   （本行 / `butler-tickd.mjs` 的 JOBS `token` 行 / `lib\butler-locks.mjs` 的 token 条目）。
  //   为什么 1h：token 监测是「按天滚动 + 超预算拦后续自动动作」的判据源 —— 一天一次太迟
  //   （预算门要当天就看得见）。`AUTO_JOBS` 的 intervalMs 只用于 TTL 派生与人工复核，
  //   实际触发节拍由 tickd 的 JOBS 决定；本 job 此前**没有任何调度点**（tickd JOBS 从无 token 行），
  //   故改这个常量零行为风险（本次才首次接线）。
  token: { id: 'token', label: 'P3 token 用量监测', intervalMs: 60 * MIN },
  // ── 2026-09-15 接线（卡 B1）：四个已实现动作的 tick 执行点 ──────────────────
  //   job id 与动作 kind 一一对应（tickd job id 亦同名，便于双向追溯）：
  //     wake → queue-wake · restart → p0-auto-restart · rollback → p5-auto-rollback · heal → auto-heal
  //   intervalMs 必须与 `butler-tickd.mjs` 的同名 job 一致（tickd 用 --job 单跑，interval 由 tickd 决定；
  //   这里保留同值用于 TTL 派生与人工复核）。四门全关时每轮只产出 blocked（零副作用）。
  wake: { id: 'wake', label: 'P3-L1 queue-wake（队列推进自动叫醒）', intervalMs: 5 * MIN },
  restart: { id: 'restart', label: 'P3-L2 p0-auto-restart（P0 低水位自动重启）', intervalMs: 5 * MIN },
  rollback: { id: 'rollback', label: 'P3-L2 p5-auto-rollback（写后违规自动回滚）', intervalMs: 10 * MIN },
  heal: { id: 'heal', label: 'P3-L2 auto-heal（组件自修复）', intervalMs: 60 * MIN },
  // ── 2026-09-16（卡：P3 自主动作 ctx-guard · 上下文看门）────────────────────
  //   job id 与动作 kind / L2 模块 id **同名**（tickd job id 亦同名，便于双向追溯）。
  //   语义 = 真执行路径（dryRun:false、emit:true）：一律经动作体自身的模块门 + runAction 统一闸门；
  //   `modules['ctx-guard']`（baseline=false）+ 四键（p3AutoEnabled=false）⇒ 每轮只产出 blocked、零副作用。
  //   ⚠️ 【顺手修复 2026-09-24 · 卡「夜批03」】intervalMs 原写 5*MIN —— 与 `butler-tickd.mjs` 的同名 job
  //     （2026-09-22 收紧为 **2*MIN**）**不一致**（本表注释第 82-83 行明确要求两处一致）⇒ 本卡一并对齐。
  //     标签里的 "P3-L1" 同步改名（风险级已升 L2：硬限可 steer 插话，见 `lib/autonomy-actions.mjs`）。
  'ctx-guard': { id: 'ctx-guard', label: 'P3-L2 ctx-guard（上下文看门）', intervalMs: 2 * MIN },
  // ── 2026-09-28（卡 K5d：看板周期归档接线 + 放行）────────────────────────────────
  //   job id 与动作 kind / L2 模块 id / tickd job id **四处同名**（照 ctx-guard 先例，无历史短名包袱）。
  //   语义 = 真执行路径（dryRun:false）：先过动作体自身的模块门 `checkModuleAllowed('board-line-archive')`，
  //     再过 `runAction()` 统一闸门（L0 降档 / p3-auto 总闸 / 24h 去重 / 单日上限 / token 预算）。
  //   三案硬要求由动作体内建：**默认 dry-run** · **无候选 ⇒ noop（不调 runAction、不占额度）** · **留痕可见**。
  //   intervalMs 30 分钟：账本级低频动作（候选本身还受"单卡 24h 成熟期 + 线级 7 天冷却"约束），
  //     与 `butler-tickd.mjs` 同名 job 一致（TTL 派生口径）。
  'board-line-archive': { id: 'board-line-archive', label: 'P3-L2 board-line-archive（看板周期归档）', intervalMs: 30 * MIN },
  // ── 2026-09-21（卡 S3c：记忆引擎 v2 · 夜间提炼）──────────────────────────────
  //   语义 = 真执行路径（dryRun:false、真写库）：窗口（默认 24h）内新增/变更的记忆 → 向量聚类 → LLM 提炼
  //     → 新增 `distilled` 条（可批量回滚）。
  //   · job id 用 **短名 `distill`**（本文件的内部 id），tickd 侧 job id = `memory-distill`（对外名），
  //     两者关系见 `lib/butler-locks.mjs` 的登记注释与 `butler-tickd.mjs` 的 JOBS 行。
  //   · intervalMs 取 24h：本 job 由 tickd 按日历（04:10）触发，这里只供"人工 `--job distill` 的 TTL 派生"。
  //   · **默认关的唯一权威层** = `~/.dsh/butler-autonomy.json` 的 `jobs['memory-distill'].enabled=false`
  //     （本文件**刻意不写** `enabled:false` —— 写死即硬禁用，`job on` 也打不开，与 D4 互斥）。
  distill: { id: 'distill', label: '记忆提炼（夜间 · 默认关）', intervalMs: 24 * 3600_000 },
};

/** 接线动作 job id → 动作 kind（唯一映射；单测断言逐一对应）。 */
export const WIRE_JOB_KINDS = Object.freeze({
  wake: 'queue-wake',
  restart: 'p0-auto-restart',
  rollback: 'p5-auto-rollback',
  heal: 'auto-heal',
  // 2026-09-16：job id 与 kind **同名**（不同于上面四个的短名）——ctx-guard 是本批次新动作，
  //   没有历史短名包袱，直接同名可少一层映射心智负担（tickd job id / 模块 id / kind 三处同名）。
  'ctx-guard': 'ctx-guard',
  // 2026-09-28（卡 K5d）：同 ctx-guard —— job id / kind / 模块 id / tickd job id 四处同名。
  'board-line-archive': 'board-line-archive',
});

// ---------------------------------------------------------------- CLI

export function parseArgs(argv = process.argv.slice(2)) {
  const has = (f) => argv.includes(f);
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    dryRun: has('--dry-run'),
    json: has('--json'),
    quiet: has('--quiet'),
    full: has('--full'),
    force: has('--force'),
    job: get('--job') ?? null,
    home: get('--home') ?? null,
    ledger: get('--ledger') ?? null,
    out: get('--out') ?? null,
    baseUrl: get('--base-url') ?? null,
    sinceDays: get('--since-days') ? Number(get('--since-days')) : null,
    // ── 卡 S3c（记忆提炼 job）：只服务 `--job distill`；不传就走引擎默认（<home> 下的生产路径）
    memoryDb: get('--memory-db') ?? null,
    vectorsDb: get('--vectors-db') ?? null,
    distillState: get('--distill-state') ?? null,
    windowHours: get('--window-hours') ? Number(get('--window-hours')) : null,
    limit: get('--limit') ? Number(get('--limit')) : null,
    maxCalls: get('--max-calls') ? Number(get('--max-calls')) : null,
    maxTokens: get('--max-tokens') ? Number(get('--max-tokens')) : null,
    engineDir: get('--engine-dir') ?? null,
  };
}

// 入口守卫：junction 下 import.meta.url 会解析为物理路径，必须 realpath 双方再比
function isMainEntry() {
  try {
    const a = fs.realpathSync(process.argv[1] ?? '');
    const b = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return a.toLowerCase() === b.toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 各 job 实现

/**
 * 共用上下文：组装 home / 账本来源 / Host 地址 / dry-run 重定向目录。
 * 账本来源（`ledgerSource`）：
 *   - `api`（默认，生产）：`GET /api/task-board/state` —— Host 权威态；
 *   - `file`（`--ledger <file>` 显式给出）：**离线/隔离只读检测**；真跑时必须显式 `--base-url`（见 jobDup 安全门）。
 */
export function makeContext(args = {}) {
  const home = args.home ?? process.env.BUTLER_DSH_HOME ?? dshHome();
  const isolatedHome = Boolean(args.home ?? process.env.BUTLER_DSH_HOME);
  const ledgerFile = args.ledger ?? defaultLedgerPath({ home });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.dryRun
    ? path.resolve(args.out ?? path.join(workspaceRoot(), '_tmp', 'butler-auto-dryrun', stamp))
    : (args.out ? path.resolve(args.out) : null);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  return {
    home, ledgerFile, outDir,
    /** `file` = 显式 --ledger（隔离只读检测）；`api` = 走 Host state */
    ledgerSource: args.ledger ? 'file' : 'api',
    baseUrl: String(args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    baseUrlExplicit: Boolean(args.baseUrl),
    /** 隔离 home（测试/演练）→ 备份落自家 home，**绝不写生产 _archive** */
    isolatedHome,
    dryRun: args.dryRun === true,
    /** ★ 2026-10-16（A 组卡「拍板落地」）：`--full` / `--since-days` 此前**解析了却没接进 ctx**
     *  ⇒ `ctx.full` 恒 `undefined` ⇒ token job 的"全量重扫"永远无效（实测恒走增量：`--full` 只扫 89 会话）。
     *  本处补接线；真源 = `docs\交付报告-harness成本与路由-拍板落地A组-读数修复与轻建议-20261016.md` §5.4。 */
    full: args.full === true,
    sinceDays: args.sinceDays ?? null,
    /** 卡 S3c：记忆提炼 job 的路径/参数（CLI 覆盖；缺省 = 引擎按 <home> 解析生产路径） */
    distill: {
      memoryDb: args.memoryDb ?? null,
      vectorsDb: args.vectorsDb ?? null,
      stateFile: args.distillState ?? null,
      windowHours: args.windowHours ?? null,
      limit: args.limit ?? null,
      maxCalls: args.maxCalls ?? null,
      maxTokens: args.maxTokens ?? null,
      engineDir: args.engineDir ?? null,
    },
    // dry-run 时把状态写入重定向到 outDir（绝不碰生产状态文件）
    stateFiles: outDir ? {
      dupState: resolveStatePath('butler-auto-actions.json', { home: outDir }).path,
      precheckState: resolveStatePath('butler-precheck.json', { home: outDir }).path,
      tokenState: resolveStatePath('butler-token-usage.json', { home: outDir }).path,
    } : {},
    now: Date.now(),
  };
}

/** 备份（动作前 `GET /state` 快照）的落盘目录。隔离 home → 自家 home 下，绝不污染生产 `_archive`。 */
export function backupDirOf(ctx, now = Date.now()) {
  if (ctx.outDir) return path.join(ctx.outDir, 'state-snapshots');
  if (ctx.isolatedHome) return path.join(ctx.home, 'butler-backups', `p3-auto-backup-${localDay(now)}`);
  return path.join(ctx.archiveDir ?? path.join(workspaceRoot(), '_archive'), `p3-auto-backup-${localDay(now)}`);
}

/**
 * 读看板账本（**权威态**）：默认走 Host API；给了 `--ledger` 则读该文件（只用于离线/隔离检测）。
 * @returns {{ok:boolean, source:'api'|'file', file:string, revision:number|null, tasks:object[], ledger:object|null, error?:string}}
 */
export async function readBoard(ctx) {
  if (ctx.ledgerSource === 'file') {
    const rd = readLedger(ctx.ledgerFile);
    if (!rd.ok) return { ok: false, source: 'file', file: ctx.ledgerFile, revision: null, tasks: [], ledger: null, error: `账本不可读：${rd.error}` };
    return { ok: true, source: 'file', file: ctx.ledgerFile, revision: rd.revision, tasks: rd.ledger?.tasks ?? [], ledger: rd.ledger };
  }
  const api = createLedgerApi({ baseUrl: ctx.baseUrl });
  const st = await api.readState();
  const file = `${ctx.baseUrl}/api/task-board/state`;
  if (!st.ok) return { ok: false, source: 'api', file, revision: null, tasks: [], ledger: null, error: `看板 state 不可读（${st.kind}/${st.code}）：${st.error} —— 看板 Host 未在线？` };
  return { ok: true, source: 'api', file, revision: st.revision, tasks: st.tasks, ledger: { revision: st.revision, tasks: st.tasks } };
}

/**
 * L1①：重复卡检测 + 合并（可逆，不删卡）。
 * 写路径 = **Host API 动作序列**（update 挂备注 → set-schedule 禁用），失败态安全（备注已挂、cron 未禁）。
 */
export async function jobDup(ctx, opts = {}) {
  const board = await readBoard(ctx);
  if (!board.ok) {
    return {
      ok: false,
      error: board.error,
      detail: { ledger: board.file, source: board.source, baseUrl: ctx.baseUrl, hint: '看板 Host 必须在线（P3 的写一律经 Host API）' },
    };
  }
  const plan = planDuplicateMerge({ revision: board.revision, tasks: board.tasks }, { now: ctx.now });
  const suspected = plan.suspected ?? [];
  // ★K3（2026-09-24 · 看板瘦身/归档物理化 §8 #11）：归档卡不能当"不存在" ——
  //   `plan.archivedTwins` = 「在板卡与**已归档**卡同题」的对照（**只提示、零动作**，
  //   归档卡只读且不可复活）。没有它，这类在板新卡会被判成"唯一卡"，把重复开工盖住。
  const archivedTwins = plan.archivedTwins ?? [];
  const twinBrief = (t) => `${String(t.boardId).slice(0, 8)}「${String(t.boardTitle).slice(0, 32)}」≈ 归档 ${t.archivedIds.map((x) => String(x).slice(0, 8)).join(',')}`;
  const actionWire = (a) => a.patches.map((p) => ({
    id: p.id,
    actions: p.actions.map((x) => ({ kind: x.kind, patch: x.patch })),
    scheduleFrom: p.from.schedule ?? null,
    scheduleTo: p.to.schedule ?? null,
    warnings: p.warnings ?? [],
    descriptionHead: String(p.to.description ?? '').split('\n')[0],
  }));

  if (ctx.dryRun) {
    const preview = {
      ledger: board.file,
      source: board.source,
      baseUrl: ctx.baseUrl,
      revisionBefore: board.revision,
      stats: plan.stats,
      // ★ I14 maxAffected（2026-09-19）：dry-run 也要看得见"本批上限 / 被截断了多少"
      limits: { maxAffected: plan.stats.maxAffected, note: '单批影响上限（被改动卡数）；取值见 lib/dup-cards.mjs 的 DUP_MAX_AFFECTED_DEFAULT' },
      willDo: plan.actions.map((a) => ({
        kind: a.kind, keeperId: a.keeperId, titleNorm: a.titleNorm,
        patches: actionWire(a),
      })),
      deferred: (plan.deferred ?? []).map((d) => ({ keeperId: d.keeperId, titleNorm: d.titleNorm, ids: d.ids, partial: d.partial === true, reason: d.reason })),
      notAuto: suspected.map((s) => ({ titleNorm: s.titleNorm, ids: s.ids, reason: s.reason })),
      // K3：与归档卡同题的在板卡（只提示；不产 action）
      archivedTwins: archivedTwins.map((t) => ({ boardId: t.boardId, titleNorm: t.titleNorm, archivedIds: t.archivedIds, boardStatus: t.boardStatus, note: t.note })),
      reason: plan.reason,
      note: 'dry-run：零 action、零账本写入（读也只读）',
    };
    if (ctx.outDir) fs.writeFileSync(path.join(ctx.outDir, 'dup-plan.json'), JSON.stringify(preview, null, 2) + '\n', 'utf8');
    return {
      ok: true,
      detail: preview,
      summary: `dry-run：检出确定重复 ${plan.actions.length} 组 / 待合并卡 ${plan.stats.plannedPatches} 张 · 🟡 疑似 ${suspected.length} 组`
        + (plan.stats.deferredCards ? ` · 超单批上限 ${plan.stats.maxAffected} 已 deferred ${plan.stats.deferredCards} 张` : '')
        + (archivedTwins.length ? ` · ⚠ 与归档卡同题 ${archivedTwins.length} 张（不自动合并）：${archivedTwins.map(twinBrief).join('；')}` : ''),
    };
  }

  // ⛔ 安全门：隔离夹具账本（--ledger）+ 未显式指定 Host → 拒绝真跑。
  //    夹具与 Host 权威态是两份不同的账本，此时"读夹具、写生产"必然错位（且是主人级动作）。
  if (board.source === 'file' && !ctx.baseUrlExplicit) {
    return {
      ok: false,
      error: '安全门拒绝：--ledger 指向隔离夹具时必须同时用 --base-url 指定测试/mock Host（防真动作打到生产看板）',
      detail: { ledger: board.file, source: board.source, baseUrl: ctx.baseUrl, baseUrlExplicit: false },
    };
  }

  const api = createLedgerApi({ baseUrl: ctx.baseUrl });
  const results = [];
  let idx = 0;
  for (const action of plan.actions) {
    idx++;
    if (idx > readLimits({ home: ctx.home }).maxActionsPerTick) {
      results.push({ keeperId: action.keeperId, status: 'deferred', reason: '超出单 tick 动作数上限（下一 tick 继续）' });
      continue;
    }
    const single = { ...plan, actions: [action] };
    const r = await runAction({
      kind: 'dup-cards-merge',
      sigKey: action.sigKey,
      home: ctx.home,
      now: ctx.now,
      detail: { keeperId: action.keeperId, ids: action.patches.map((p) => p.id), titleNorm: action.titleNorm },
      revertHint: '删掉后建卡 description 首行备注 + 按审计行的 patches[].rollback（或 rollback-dup --from-audit）还原 schedule 即可',
      execute: async ({ now }) => {
        // 备份 = 动作前 GET /state 快照（不再拷账本文件；回滚走 API，不依赖本地文件）
        const snapDir = backupDirOf(ctx, now);
        const snap = await api.snapshot({ dir: snapDir, now });
        if (!snap.ok) throw new Error(`动作前快照失败，拒绝写入：${snap.error}`);

        const applied = await applyDuplicateMerge(single, {
          apply: (seq) => api.applySequence(seq, { label: 'dup-merge' }),
          readState: async () => {
            const st = await api.readState();
            return st.ok ? { tasks: st.tasks } : null;
          },
        });
        if (!applied.ok) {
          // 失败也要留痕：审计记"动作序列 + 每步 HTTP 结果"，便于人工接手与回滚
          appendAudit({
            type: 'dup-merge-failed',
            kind: 'dup-cards-merge',
            level: 'L1',
            keeperId: action.keeperId,
            titleNorm: action.titleNorm,
            detail: {
              sigKey: action.sigKey, baseUrl: ctx.baseUrl, snapshot: snap.file,
              failedStep: applied.failedStep, error: applied.error,
              steps: stepSummary(applied.steps),
              patches: action.patches.map((p) => ({ id: p.id, actions: p.actions, rollback: p.rollback })),
            },
          }, { home: ctx.home, silent: true });
          return {
            ok: false, error: applied.error,
            applied: applied.applied, backup: snap.file, revision: applied.revision,
            steps: stepSummary(applied.steps), failedStep: applied.failedStep,
          };
        }

        // 合并动作的审计（含回滚数据）—— L1 也要留痕
        appendAudit({
          type: 'dup-merge',
          kind: 'dup-cards-merge',
          level: 'L1',
          keeperId: action.keeperId,
          titleNorm: action.titleNorm,
          detail: {
            sigKey: action.sigKey, baseUrl: ctx.baseUrl, snapshot: snap.file,
            revision: applied.revision, revisionBefore: snap.revision,
            steps: stepSummary(applied.steps),
            patches: action.patches.map((p) => ({ id: p.id, to: p.to, actions: p.actions, rollback: p.rollback })),
            // I14：兜底截断只可能在"调用方绕过 planDuplicateMerge"时非空（生产路径恒空）
            ...((applied.deferred ?? []).length ? { limitDeferred: applied.deferred } : {}),
          },
        }, { home: ctx.home, silent: true });
        return {
          ok: applied.ok, changed: applied.changed, applied: applied.applied,
          backup: snap.file, revision: applied.revision, steps: stepSummary(applied.steps),
        };
      },
    });
    results.push({ keeperId: action.keeperId, status: r.status, reason: r.reason, result: r.result ?? null });
  }

  // ★ I14 maxAffected（2026-09-19 卡）：计划阶段已按「被改动卡数」截断 —— 超限的组/卡在这里登记为
  //   `deferred`（**零写入**：description / schedule 原样，下一 tick 重新检出后继续）。
  //   措辞与 tick 层截断（`超出单 tick 动作数上限`）刻意区分，便于复盘分别数数。
  for (const d of plan.deferred ?? []) {
    results.push({ keeperId: d.keeperId, status: 'deferred', reason: d.reason, ids: d.ids, result: null });
  }

  // ★ I14 可观测性（2026-09-19）：每轮 dup 计划落一条审计行 —— **只增加记录，不改任何行为语义**。
  //   依据：2026-09-24 观察期复盘要按「检出确定重复组数 / 计划影响卡数 / 因超上限被截断的组数」的实测
  //   数据决定 maxAffected 放大还是收紧；没有这条，25 轮零检出在审计里只剩 1 条 dup-merge 行 = 凭猜。
  //   ⚠️ 只落在**真跑**分支（dry-run 恒零副作用，不写审计）。
  appendAudit({
    type: 'dup-plan',
    kind: 'dup-cards-merge',
    level: 'L1',
    detail: {
      baseUrl: ctx.baseUrl, source: board.source, revisionBefore: board.revision,
      maxAffected: plan.stats.maxAffected,
      detectedCertainGroups: plan.stats.certainGroups,
      actionableGroups: plan.stats.actionableGroups,
      plannedGroups: plan.actions.length,
      plannedAffectedCards: plan.stats.plannedPatches,
      deferredGroups: plan.stats.deferredGroups,
      deferredCards: plan.stats.deferredCards,
      truncated: plan.stats.truncated === true,
      suspectedGroups: suspected.length,
      // K3：与归档卡同题的在板卡数（可观测性；不产 action、不进审计判定）
      archivedTwins: archivedTwins.length,
      archivedScanned: plan.stats.archivedScanned ?? 0,
      results: results.map((r) => ({ keeperId: r.keeperId, status: r.status })),
    },
  }, { home: ctx.home, silent: true });

  const deferredCards = plan.stats.deferredCards ?? 0;
  return {
    ok: true,
    detail: {
      ledger: board.file, source: board.source, baseUrl: ctx.baseUrl, revisionBefore: board.revision,
      stats: plan.stats, results, suspected: suspected.length,
      // K3：与归档卡同题的在板卡（只提示、零动作）
      archivedTwins: archivedTwins.map((t) => ({ boardId: t.boardId, titleNorm: t.titleNorm, archivedIds: t.archivedIds, note: t.note })),
      maxAffected: plan.stats.maxAffected, deferredGroups: plan.stats.deferredGroups, deferredCards,
    },
    summary: ((plan.actions.length || deferredCards)
      ? `重复卡合并：${results.map((r) => `${r.keeperId.slice(0, 8)}=${r.status}`).join(' · ')}`
        + (deferredCards ? `（其中 ${deferredCards} 张超单批上限 ${plan.stats.maxAffected} 已 deferred）` : '')
      : `重复卡检测：无待处理（${plan.reason}）`)
      + (archivedTwins.length ? ` · ⚠ 与归档卡同题 ${archivedTwins.length} 张（不自动合并）：${archivedTwins.map(twinBrief).join('；')}` : ''),
  };
}

/** 每步 HTTP 结果摘要（审计/输出用；不外泄整份响应）。 */
function stepSummary(steps) {
  return (steps ?? []).map((s) => ({
    index: s.index, kind: s.action?.kind, taskId: s.action?.taskId,
    ok: s.ok, status: s.status ?? null, code: s.code ?? null,
    attempts: s.attempts ?? null, requestId: s.requestId ?? null,
    settledByReadback: s.settledByReadback === true, error: s.error ?? null,
  }));
}

/**
 * 只读账本（fail-soft）：优先 Host API（权威态），Host 不在线时回退读账本文件。
 * **只用于只读 job（precheck / token 归因）**——写路径**绝不**回退（见 jobDup 的安全门）。
 */
export async function readBoardSoft(ctx) {
  const board = await readBoard(ctx);
  if (board.ok || ctx.ledgerSource === 'file') return board;
  const rd = readLedger(ctx.ledgerFile);
  if (!rd.ok) return board;
  return { ok: true, source: 'file-fallback', file: ctx.ledgerFile, revision: rd.revision, tasks: rd.ledger?.tasks ?? [], ledger: rd.ledger, degraded: board.error };
}

/** L1③：待验收证据预检（只读，只标注不阻断）。 */
export async function jobPrecheck(ctx, opts = {}) {
  const board = await readBoardSoft(ctx);
  if (!board.ok) return { ok: false, error: board.error };
  const stateOpts = ctx.stateFiles.precheckState ? { home: ctx.home, file: ctx.stateFiles.precheckState } : { home: ctx.home };
  // dry-run 时**只读**生产状态（去重口径一致），但绝不写
  const state = readPrecheckState(stateOpts);
  const r = await precheckReviewCards(board.ledger, { ...stateOpts, state, now: ctx.now, force: ctx.force === true });
  const warned = r.results.filter((x) => x.verdict === 'evidence-missing');

  const detail = {
    reviewCards: r.reviewCards, checked: r.checked, warned: warned.length,
    results: r.results.map((x) => ({
      cardId: x.cardId, title: x.title, verdict: x.verdict, declaredPaths: x.declaredPaths,
      failed: x.failed, auditFindings: (x.audit?.findings ?? []).filter((f) => f.level === 'block'),
      durationMs: x.durationMs,
    })),
    // 🟡 只通知不自动（方案：验不过 → 卡标 🟡「证据缺失」；改卡本身是 L3，故只落状态文件 + 通知）
    notify: warned.map((x) => ({ cardId: x.cardId, title: x.title, failed: x.failed.map((f) => `${f.path}: ${f.message}`) })),
  };

  if (ctx.dryRun) {
    if (ctx.outDir) fs.writeFileSync(path.join(ctx.outDir, 'precheck.json'), JSON.stringify(detail, null, 2) + '\n', 'utf8');
    return { ok: true, detail, summary: `dry-run：待验收卡 ${r.reviewCards} 张 / 本次预检 ${r.checked} 张 / 🟡 证据缺失 ${warned.length} 张` };
  }

  const rec = recordPrecheck(r.results, stateOpts);
  // 预检是只读动作：不计入每日自动动作额度（consumesQuota:false），但仍留审计与状态
  const gate = await runAction({
    kind: 'evidence-precheck',
    home: ctx.home, now: ctx.now, dryRun: false,
    consumesQuota: false,
    sigKey: null, // 预检自带指纹去重（cardFingerprint），不再叠加 24h 签名窗口
    detail: { checked: r.checked, warned: warned.length },
    execute: () => ({ ok: true, changed: r.checked, file: rec.file }),
  });
  return {
    ok: true,
    detail: { ...detail, gate: gate.status, gateReason: gate.reason, stateFile: rec.file },
    summary: `证据预检：待验收 ${r.reviewCards} 张 / 检查 ${r.checked} 张 / 🟡 证据缺失 ${warned.length} 张（闸门 ${gate.status}）`,
  };
}

/** L2：归档出错自动重试（一次，不无限重试）＋【M2 遗留②】写库失败 → 只补写。 */
export async function jobArchive(ctx, opts = {}) {
  const st = gatherArchiveAutoStatus({ home: ctx.home });
  const retryable = st.errors > 0;
  // 【2026-09-28 · M2 遗留②】判据分流：**写库失败**（`state.metaStore.writeFailedStreak>0`，归档动作本身
  //   已成功）⇒ 只走补写（读侧惰性补写），**绝不重跑 `/auto/run`**（会话已搬走，重跑＝空转再报错）。
  //   ⚠️ 门槛刻意写成 `!retryable && …`：① errors>0 时一律走既有重试路径（两类失败同时出现 ⇒ 归档优先）；
  //   ② 状态文件**无 metaStore 段**时 `retryMode` 恒 `'none'` ⇒ 本分支不进 ⇒ 行为与扩展前逐字一致。
  const metaBackfill = !retryable && st.retryMode === 'meta-backfill';

  if (ctx.dryRun) {
    const preview = {
      stateFile: st.file, fileExists: st.fileExists, enabled: st.enabled, dryRunConfigured: st.dryRun,
      batch: st.batch, errors: st.errors, errorSamples: st.errorSamples,
      retryMode: st.retryMode, metaStore: st.metaStore,
      decision: retryable ? '将要重试：POST /api/dsh-archive-sessions/auto/run（一次）'
        : (metaBackfill ? '将要补写：GET /api/dsh-archive-sessions/list（读侧惰性补写，不重跑归档）'
          : '无需重试（errors=0 或状态文件缺失）'),
      wouldRetry: retryable || metaBackfill,
      note: 'dry-run 绝不发真实 HTTP 请求，也不改 .auto-archive.json',
    };
    if (ctx.outDir) fs.writeFileSync(path.join(ctx.outDir, 'archive-retry.json'), JSON.stringify(preview, null, 2) + '\n', 'utf8');
    return {
      ok: true, detail: preview,
      summary: `dry-run：归档 ${st.batch ?? '(无批次)'} errors=${st.errors} → ${retryable ? '将重试一次'
        : (metaBackfill ? `将补写一次（writeFailedStreak=${st.metaStore?.writeFailedStreak ?? 0}）` : '无需重试')}`,
    };
  }

  if (!retryable && !metaBackfill) {
    return { ok: true, detail: { ...st, retryable: false }, summary: `归档重试：无需重试（errors=${st.errors}）` };
  }

  // ② 只补写（归档动作已成功）——与下面 ① 互斥；kind 复用既有 `archive-retry`（不新增动作矩阵条目）
  if (metaBackfill) {
    const streak = st.metaStore?.writeFailedStreak ?? 0;
    const sigKey = sigKeyOf('archive-meta-backfill', st.batch ?? String(st.lastRunAt ?? ''), String(streak));
    const r = await runAction({
      kind: 'archive-retry',
      sigKey,
      home: ctx.home, now: ctx.now,
      detail: { mode: 'meta-backfill', batch: st.batch, writeFailedStreak: streak, writeFailedTotal: st.metaStore?.writeFailedTotal ?? 0 },
      revertHint: '补写只写元数据库（加速缓存）；权威源 = append-only 会话日志，写失败不破坏归档区（且不重跑归档）',
      execute: async () => attemptMetaBackfill({ baseUrl: ctx.baseUrl, home: ctx.home, streakBefore: streak }),
    });
    return {
      ok: true,
      detail: { ...st, retryable: true, mode: 'meta-backfill', gate: r.status, reason: r.reason, result: r.result ?? null },
      summary: `归档元数据库补写：${r.status}（${r.reason}）`,
    };
  }

  const sigKey = sigKeyOf('archive-retry', st.batch ?? String(st.lastRunAt ?? ''), String(st.errors));
  const r = await runAction({
    kind: 'archive-retry',
    sigKey,
    home: ctx.home, now: ctx.now,
    detail: { batch: st.batch, errors: st.errors },
    revertHint: '归档本身有恢复脚本（桌面 restore-*），重试失败不会破坏已归档数据（只追加）',
    execute: async () => attemptArchiveRetry({ baseUrl: ctx.baseUrl, home: ctx.home, now: ctx.now }),
  });

  return {
    ok: true,
    detail: { ...st, retryable: true, gate: r.status, reason: r.reason, result: r.result ?? null },
    summary: `归档重试：${r.status}（${r.reason}）`,
  };
}

/** token 用量监测（只读扫日志；超限 → 预算门拦后续自动动作）。 */
export async function jobToken(ctx, opts = {}) {
  const stateOpts = ctx.stateFiles.tokenState ? { home: ctx.home, file: ctx.stateFiles.tokenState } : { home: ctx.home };
  const prev = readTokenState(stateOpts);
  const board = await readBoardSoft(ctx);
  const rd = { ok: board.ok, ledger: board.ledger };
  const t0 = Date.now();
  const r = scanTokenUsage({ ...stateOpts, now: ctx.now, state: prev, full: ctx.full, ledger: rd.ok ? rd.ledger : null, sinceDays: ctx.sinceDays });
  const next = { ...r.state, lastScan: { ...r.state.lastScan, durationMs: Date.now() - t0 } };
  const limits = readLimits({ home: ctx.home });
  const threshold = checkThresholds(next, {
    now: ctx.now, silent: ctx.dryRun,
    warn: limits.tokenWarnPerDay ?? undefined,
    budget: limits.tokenBudgetPerDay > 0 ? limits.tokenBudgetPerDay : undefined,
    home: ctx.home,
  });
  const summaryRow = describeTokenUsage(next, { now: ctx.now, home: ctx.home });
  const detail = {
    scanned: r.scanned, skipped: r.skipped, files: r.files, bytes: r.bytes, errors: r.errors.slice(0, 10),
    durationMs: next.lastScan.durationMs,
    today: usageForDay(next, localDay(ctx.now)),
    threshold: { ...threshold, usage: undefined },
    cacheReadRatio: summaryRow.totals?.cacheReadRatio ?? 0,
    reasoningRatio: summaryRow.totals?.reasoningRatio ?? 0,
    weekOverWeek: summaryRow.weekOverWeek,
    topSessions: summaryRow.topSessions,
    topCards: summaryRow.topCards,
    stateFile: tokenStateFile(stateOpts),
  };
  if (ctx.outDir) fs.writeFileSync(path.join(ctx.outDir, 'token-usage.json'), JSON.stringify(detail, null, 2) + '\n', 'utf8');
  if (!ctx.dryRun) persistTokenState(next, stateOpts);
  return {
    ok: true, detail,
    summary: `token：扫 ${r.scanned} 会话（跳过 ${r.skipped}）/ 今日 ${detail.today.totalTokens}（${threshold.level}）/ cache ${(detail.cacheReadRatio * 100).toFixed(1)}% / reasoning ${(detail.reasoningRatio * 100).toFixed(1)}%`,
  };
}

// ---------------------------------------------------------------- 接线：四个已实现动作（2026-09-15 卡 B1）

/**
 * 「若开启会做什么」的**只读**摘要（零副作用；从动作体已算完的 plan 里提炼）。
 * 为什么可以拿 plan：四个动作体的顺序都是「只读采集 → 规划（纯函数）→ 模块门 → 分派」，
 *   blocked 分支发生在规划**之后**，故 plan 本身不含任何写入/子进程（纯函数产物）。
 */
function wirePlanBrief(r) {
  const p = r?.plan;
  if (!p || typeof p !== 'object') return null;
  const o = {};
  if (p.decision != null) o.decision = p.decision;
  if (p.summary && typeof p.summary === 'object') {
    for (const k of ['cards', 'wake', 'queue', 'escalate', 'skip', 'execAlive']) {
      if (p.summary[k] != null) o[k] = p.summary[k];
    }
    // 2026-09-16 · ctx-guard：它的 summary 是"会话维度"的（sessions/running/overSoft/soft/hard/deliver/observe）
    for (const k of ['sessions', 'running', 'overSoft', 'soft', 'hard', 'deliver', 'observe']) {
      if (p.summary[k] != null) o[k] = p.summary[k];
    }
    if (p.summary.deliver != null) o.wouldDeliver = p.summary.deliver;
  }
  if (Array.isArray(p.items)) o.items = p.items.length;
  if (Array.isArray(p.candidates)) o.candidates = p.candidates.length;
  if (p.wouldRequest != null) o.wouldRequest = p.wouldRequest === true;
  if (p.wouldRollback != null) o.wouldRollback = p.wouldRollback === true;
  if (p.wouldHeal != null) o.wouldHeal = p.wouldHeal === true;
  if (p.reason) o.planReason = String(p.reason).slice(0, 160);
  return Object.keys(o).length ? o : null;
}

/**
 * 接线统一收口：把动作体结果归一成 scheduler 契约 `{ok, detail, summary}`。
 *
 * ❗ **本函数不做任何闸门判定** —— 判定全部在动作体内部：`checkModuleAllowed(kind)`
 *   （L0 降档 × L1 owner × L2 模块）+ `runAction()`（L0 降档闸 / p3-auto 总闸 / 24h 去重 /
 *   单日上限 / token 预算门）。这里只透传 dryRun 并归一结果，绝不自建第二套判据。
 *
 * 状态语义：
 *   blocked / noop / executed / dry-run → job 成功（`ok:true`；"被闸门挡住" ≠ job 故障）
 *   collect-failed                      → **采集失败 = job 失败**（`ok:false` + 报警）。
 *     【2026-09-16 拷问 1.7】旧口径把 collect-failed 记成 `ok:true`（照 butler-queue-tick 的旧惯例），
 *     后果：dsh/看板没在线、这一轮啥也没干成，tickd 里却是 `status=ok / failures=0` —— 系统性失效
 *     永远看不见（ctx-guard 放行后尤其致命：采集挂了 = 看门静默瞎掉，日报还全绿）。
 *     现在：① job 记失败（CLI exit 1 → tickd failures++ → 日报「⏱ tick 调度健康」段看得见）
 *           ② 同时显式报警（alert 通道，含 kind 与原因），双保险。
 *     ⚠️ 这是**环境态失败**（dsh 未起 / 看板离线），不是代码 bug —— 但"环境态"不等于"不用叫"。
 */
function wireOutcome(kind, r, opts = {}) {
  const status = r?.status ?? null;
  const reason = r?.reason ?? null;
  const wouldDo = wirePlanBrief(r);
  const detail = {
    kind, status, reason, wouldDo,
    dryRun: r?.dryRun === true,
    moduleGate: r?.moduleGate?.reason ?? null,
    blocked: r?.blocked ?? null,
    summary: `${kind}：${status ?? 'unknown'}（${reason ?? '-'}）${wouldDo ? ' · 若开启：' + JSON.stringify(wouldDo) : ''}`,
  };
  if (status === 'collect-failed') {
    const msg = `${kind} 采集失败：${reason ?? 'collect-failed'}`;
    try {
      alert({ level: 'warn', source: 'butler-auto-tick', message: `自动动作采集失败 —— ${msg}`, detail: { kind, status, reason, wouldDo } }, { home: opts.home });
    } catch { /* 告警通道失败不改变结论：job 仍然是失败的 */ }
    return { ok: false, error: msg, detail: { ...detail, collectFailed: true, error: reason }, summary: detail.summary };
  }
  return { ok: true, detail, summary: detail.summary };
}

/** 接线 job ①：`queue-wake`（队列推进自动叫醒）。 */
export async function jobWake(ctx, opts = {}) {
  const r = await runQueueWake({
    home: ctx.home, now: ctx.now, dryRun: ctx.dryRun === true, baseUrl: ctx.baseUrl,
    cfg: opts.cfg, scan: opts.scan, plan: opts.plan, deps: opts.deps, autonomy: opts.autonomy,
    limits: opts.limits, state: opts.state, ledger: opts.ledger,
  });
  return wireOutcome('queue-wake', r, { home: ctx.home });
}

/** 接线 job ②：`p0-auto-restart`（P0 低水位自动重启；真实通道 = 既有 request-restart.mjs --as-auto）。 */
export async function jobRestart(ctx, opts = {}) {
  const r = await runAutoRestart({
    home: ctx.home, now: ctx.now, dryRun: ctx.dryRun === true, baseUrl: ctx.baseUrl,
    policy: opts.policy, limits: opts.limits, state: opts.state, scan: opts.scan, plan: opts.plan,
    autonomy: opts.autonomy, intents: opts.intents, requests: opts.requests, window: opts.window,
    views: opts.views, sessionRows: opts.sessionRows, cardSessionIds: opts.cardSessionIds,
    deps: opts.deps,
  });
  return wireOutcome('p0-auto-restart', r, { home: ctx.home });
}

/** 接线 job ③：`p5-auto-rollback`（P5 B 层写后审计违规自动回滚；复用 watcher 既有快照）。 */
export async function jobRollback(ctx, opts = {}) {
  const r = await runAutoRollback({
    home: ctx.home, now: ctx.now, dryRun: ctx.dryRun === true,
    limits: opts.limits, state: opts.state, scan: opts.scan, plan: opts.plan,
    autonomy: opts.autonomy, deps: opts.deps,
  });
  return wireOutcome('p5-auto-rollback', r, { home: ctx.home });
}

/** 接线 job ④：`auto-heal`（组件自修复；幂等补丁重打 + 声明式指向重建）。 */
export async function jobHeal(ctx, opts = {}) {
  const r = await runAutoHeal({
    home: ctx.home, now: ctx.now, dryRun: ctx.dryRun === true,
    limits: opts.limits, state: opts.state, scan: opts.scan, plan: opts.plan,
    autonomy: opts.autonomy, deps: opts.deps, toolsRoot: opts.toolsRoot,
    linkRoot: opts.linkRoot, sourceRoot: opts.sourceRoot, profileDir: opts.profileDir,
    panelUrl: opts.panelUrl, baseUrl: ctx.baseUrl, env: opts.env,
  });
  return wireOutcome('auto-heal', r, { home: ctx.home });
}

/** 接线 job ⑤：`ctx-guard`（上下文看门；真执行路径 = `emit:true`，仍要过模块门 + runAction 四门）。 */
export async function jobCtxGuard(ctx, opts = {}) {
  const r = await runCtxGuard({
    home: ctx.home, now: ctx.now, dryRun: ctx.dryRun === true, emit: true, baseUrl: ctx.baseUrl,
    cfg: opts.cfg, limits: opts.limits, state: opts.state, scan: opts.scan, plan: opts.plan,
    deps: opts.deps, autonomy: opts.autonomy,
  });
  return wireOutcome('ctx-guard', r, { home: ctx.home });
}

/** 接线 job ⑦：`board-line-archive`（看板周期归档；真执行路径 = 模块门 + `runAction()` 双闸，2026-09-28 K5d）。 */
export async function jobBoardLineArchive(ctx, opts = {}) {
  const r = await runBoardLineArchive({
    home: ctx.home, now: ctx.now, dryRun: ctx.dryRun === true, baseUrl: ctx.baseUrl,
    maxLines: opts.maxLines, tasks: opts.tasks, revision: opts.revision,
    autonomy: opts.autonomy, deps: opts.deps, timeoutMs: opts.timeoutMs,
  });
  return wireOutcome('board-line-archive', r, { home: ctx.home });
}

/** 接线 job ⑥：`distill`（记忆提炼；tickd job id = `memory-distill`，日历型 04:10）。
 *
 * 【2026-10-10 · 补坑库联动BCD】改用 `runDistillJob`（**两段编排**）：`phase = 'distill' | 'p4-digest' | 'all'`。
 *   · `runMemoryDistill` 本体**一字未改**（仍是"只看 distill 段"的同步实现）⇒ 既有单测不受影响；
 *   · `phase` 缺省 `'all'`；但 **P4 段默认关**（闸文件 `~/.dsh/butler-p4-digest.json` 缺省不存在 ⇒ 判关）
 *     ⇒ 关着时本 job 的 `summary`/`ok`/`status` 与旧行为**逐字一致**（只多一个 `detail.p4Digest` 字段）；
 *   · P4 段抛错**不影响** job 成败（§D.5 断言：P4 失败时 job 状态仍写 ok/dry-run，日报只多一行）。 */
export async function jobDistill(ctx, opts = {}) {
  const r = await runDistillJob({
    home: ctx.home, now: ctx.now, dryRun: ctx.dryRun === true,
    phase: opts.phase ?? ctx.distill?.phase ?? 'all',
    engineDir: opts.engineDir ?? ctx.distill?.engineDir ?? null,
    memoryDb: opts.memoryDb ?? ctx.distill?.memoryDb ?? null,
    vectorsDb: opts.vectorsDb ?? ctx.distill?.vectorsDb ?? null,
    stateFile: opts.stateFile ?? ctx.distill?.stateFile ?? null,
    windowHours: opts.windowHours ?? ctx.distill?.windowHours ?? null,
    limit: opts.limit ?? ctx.distill?.limit ?? null,
    maxCalls: opts.maxCalls ?? ctx.distill?.maxCalls ?? null,
    maxTokens: opts.maxTokens ?? ctx.distill?.maxTokens ?? null,
    timeoutMs: opts.timeoutMs,
    // D 点（p4-digest）的可注入项
    p4MinCount: opts.p4MinCount ?? ctx.distill?.p4MinCount ?? null,
    triageFile: opts.triageFile ?? ctx.distill?.triageFile ?? null,
    pitfallsFile: opts.pitfallsFile ?? ctx.distill?.pitfallsFile ?? null,
    clustersFile: opts.clustersFile ?? ctx.distill?.clustersFile ?? null,
    p4LlmCall: opts.p4LlmCall ?? null,
    // 单测可注入 runner：不 spawn 子进程也能跑完整映射逻辑
    run: opts.run,
  });
  // scheduler 契约：ok:false ⇒ 记失败；否则收 detail（"被闸门挡住"/"让路"都算 ok）
  return {
    ok: r.ok,
    error: r.ok ? null : r.reason,
    detail: { ...r.detail, innerStatus: r.status, reason: r.reason, summary: r.summary },
    summary: r.summary,
  };
}

/** 接线 job 表（id → 实现）；tickd 的 5 条 job 带 `--job <id>` 单跑其中一个。
 *
 * ⚠️ **只放"已登记动作族"的接线 job**（`queue-wake`/`p0-auto-restart`/`p5-auto-rollback`/`auto-heal`/`ctx-guard`）
 *   —— 它们各自对应 `AUTO_ACTION_KINDS` 里的一个 kind，`registry-audit` 的 **J6 断言
 *   `WIRE_JOBS 键集 == WIRE_JOB_KINDS 键集`**。
 *   `distill`（卡 S3c）**刻意不入本表**：它不是 `runAction()` 族的"有闸自主动作"
 *   （`memory-distill` 模块行 noOwnerWhy 已写明"放行由 jobs 段单键决定"），
 *   与 `dup`/`precheck`/`token` 同款 —— **自有 job 实现，直接注册进调度器**（见 `createAutoScheduler`）。
 *   放进来会让 J6 变红（实测踩过：`_test/test-tickd.mjs` ⑨ 段）。 */
export const WIRE_JOBS = Object.freeze({
  wake: jobWake,
  restart: jobRestart,
  rollback: jobRollback,
  heal: jobHeal,
  'ctx-guard': jobCtxGuard,
  // 2026-09-28（卡 K5d）：看板周期归档接线（tickd job 同名 → `--job board-line-archive`）。
  'board-line-archive': jobBoardLineArchive,
});

// ---------------------------------------------------------------- 调度

/** 建调度器（独立注册 + 失败隔离；dry-run 时也走同一套，只是 execute 换 dry 分支）。 */
export function createAutoScheduler(ctx, opts = {}) {
  // 日志一律走 stderr：stdout 必须保持"纯 JSON / 纯报告"，否则 --json 会被日志行污染
  const sch = createScheduler({
    name: 'p3-auto', home: ctx.home,
    logger: opts.logger ?? ((m) => process.stderr.write(`[butler-auto] ${m}\n`)),
  });
  sch.register({ ...AUTO_JOBS.dup, run: async () => jobDup(ctx) });
  sch.register({ ...AUTO_JOBS.precheck, run: async () => jobPrecheck(ctx) });
  sch.register({ ...AUTO_JOBS.archive, run: async () => jobArchive(ctx) });
  sch.register({ ...AUTO_JOBS.token, run: async () => jobToken(ctx) });
  // 接线（2026-09-15 卡 B1）：四个已实现动作。`opts.wire.<jobId>` 仅供单测注入夹具
  //   （scan / plan / deps）；生产路径不传 = 各动作体走真实只读采集。
  const wire = opts.wire ?? {};
  sch.register({ ...AUTO_JOBS.wake, run: async () => jobWake(ctx, wire.wake ?? {}) });
  sch.register({ ...AUTO_JOBS.restart, run: async () => jobRestart(ctx, wire.restart ?? {}) });
  sch.register({ ...AUTO_JOBS.rollback, run: async () => jobRollback(ctx, wire.rollback ?? {}) });
  sch.register({ ...AUTO_JOBS.heal, run: async () => jobHeal(ctx, wire.heal ?? {}) });
  // 2026-09-16：上下文看门（job id 与动作 kind 同名，故用 `wire['ctx-guard']` 注入夹具）
  sch.register({ ...AUTO_JOBS['ctx-guard'], run: async () => jobCtxGuard(ctx, wire['ctx-guard'] ?? {}) });
  // 2026-09-28（卡 K5d）：看板周期归档（`wire['board-line-archive']` 供单测注入 scan/deps 夹具）
  sch.register({ ...AUTO_JOBS['board-line-archive'], run: async () => jobBoardLineArchive(ctx, wire['board-line-archive'] ?? {}) });
  // 2026-09-21（卡 S3c）：记忆提炼（`wire.distill` 供单测注入 runner / 隔离库路径）
  sch.register({ ...AUTO_JOBS.distill, run: async () => jobDistill(ctx, wire.distill ?? {}) });
  return sch;
}

/** 跑一轮（force 时全部 job 都跑；only 指定单个）。 */
export async function runOnce(args = {}) {
  const ctx = makeContext(args);
  // 防呆（2026-09-15 接线）：--job 打错名字会静默"零 job 执行"（tickd 里看起来正常、实际没接上），
  //   故显式拒绝未知 job id —— 配置错误必须可见（tickd 记 1 次 failure）。
  if (args.job && !Object.prototype.hasOwnProperty.call(AUTO_JOBS, args.job)) {
    return {
      ok: false, disabled: false,
      reason: `未知 job id：${args.job}（可选 ${Object.keys(AUTO_JOBS).join('|')}）`,
      results: [], summaries: [],
    };
  }
  const gate = gateComponent(COMPONENT, AUTO_TICK_VERSION, { home: ctx.home });
  if (!gate.run) {
    return { ok: false, disabled: true, reason: `组件版本自检未通过：${gate.reason}`, results: [] };
  }
  const sch = createAutoScheduler(ctx, {});
  const only = args.job ? [args.job] : null;
  const tick = await sch.tickOnce({ force: true, only });

  const results = [];
  for (const rec of tick.results) {
    const row = tick.results.find((x) => x.id === rec.id);
    if (!row) continue;
    results.push({ job: rec.id, status: rec.status, error: rec.error ?? null, detail: rec.detail ?? null });
  }
  // 逐 job 摘要（从 detail 重组，供人读）
  const summaries = [];
  for (const r of results) {
    const s = summarizeJobResult(r);
    if (s) summaries.push(`[${r.job}] ${s}`);
  }
  const out = {
    ok: results.every((r) => r.status === 'ok' || r.status === 'locked'),
    dryRun: ctx.dryRun,
    home: ctx.home,
    ledger: ctx.ledgerFile,
    outDir: ctx.outDir,
    autonomy: describeAutonomy({ home: ctx.home }),
    limits: readLimits({ home: ctx.home }),
    results,
    summaries,
    at: new Date(ctx.now).toISOString(),
  };
  return out;
}

function summarizeJobResult(r) {
  const d = r.detail;
  if (!d) return r.error ?? null;
  if (r.job === 'dup') {
    if (r.detail.willDo) {
      return `dry-run 检出确定重复 ${d.willDo.length} 组 / 待合并 ${d.willDo.reduce((n, a) => n + a.patches.length, 0)} 张`
        + `（上限 ${d.stats?.maxAffected ?? '?'}） / 🟡 疑似 ${d.notAuto?.length ?? 0} 组`
        + (d.deferred?.length ? ` / 超上限 deferred ${d.deferred.reduce((n, x) => n + (x.ids?.length ?? 0), 0)} 张` : '');
    }
    return `检出 ${d.stats?.certainGroups ?? 0} 组 / 影响 ${d.stats?.plannedPatches ?? 0} 张（上限 ${d.stats?.maxAffected ?? '?'}）`
      + ` / deferred ${d.deferredCards ?? 0} 张 / 合并结果 ${(d.results ?? []).map((x) => x.status).join(',') || '无'}`;
  }
  if (r.job === 'precheck') return `待验收 ${d.reviewCards} 张 / 检查 ${d.checked} 张 / 🟡 ${d.warned} 张`;
  if (r.job === 'archive') return d.decision ? `${d.decision}` : `errors=${d.errors} gate=${d.gate}`;
  if (r.job === 'token') return `扫 ${d.scanned} 会话 / 今日 ${d.today?.totalTokens} / ${d.threshold?.level}`;
  // 接线四动作（2026-09-15 卡 B1）：detail.summary 由 wireOutcome() 统一生成
  if (WIRE_JOB_KINDS[r.job]) return d.summary ?? `${WIRE_JOB_KINDS[r.job]}：${d.status ?? '?'}`;
  // 卡 S3c：记忆提炼（detail 由 jobDistill + 引擎 CLI 的 --json 结果组成）
  if (r.job === 'distill') return d.summary ?? `memory-distill：${d.innerStatus ?? '?'}（${d.reason ?? '-'}）`;
  return null;
}

/** 人读报告。
 *
 * 【2026-10-11 · 卡 auto-tick-report-failsafe】本函数必须 **fail-safe**：
 *   `runOnce()` 有两处**优雅早退**（① 版本门 skip ② 未知 job id），它们返回的对象
 *   **没有 `autonomy` / `summaries` / `at` 字段**（其余字段 = `{ok:false, disabled, reason, results}`）。
 *   旧代码直读 `out.autonomy.offCount` ⇒ TypeError ⇒ 把"一次正常跳过"变成了 exit-1 崩溃，
 *   而且**真因（reason）被吞掉**（HOST_B 现场：`memory-distill.log` 里
 *   `[butler-auto-tick] 崩溃：Cannot read properties of undefined (reading 'offCount')`）。
 *   ⇒ 这里对每个字段一律「有就读、缺就降级打印」，**永不抛**；同时把 `reason` 打出来（排障不必翻代码）。
 *   ⚠️ 正常路径（有 autonomy）的输出**逐字节不变**：新增行只在缺字段 / 有 reason 时出现。
 */
export function formatReport(out) {
  const lines = [];
  const o = out && typeof out === 'object' ? out : {};
  const dm = o.dryRun ? 'DRY-RUN（只算不动）' : 'REAL';
  lines.push(`🐳 P3 会派活 tick · ${dm} · ${o.at ?? '(未记录时间)'}`);
  lines.push(`  home=${o.home ?? '(未指定)'}`);
  lines.push(`  ledger=${o.ledger ?? '(未指定)'}`);
  if (o.outDir) lines.push(`  证据目录=${o.outDir}`);
  const a = o.autonomy && typeof o.autonomy === 'object' ? o.autonomy : null;
  if (a && Array.isArray(a.rows)) {
    lines.push(`  自治开关：${a.offCount}/${a.total} 关闭${a.allOff ? '（裸跑期合规 ✅）' : ' ⚠️ 有开关已放行'}`);
    for (const r of a.rows) lines.push(`    ${r.allowed ? '🟢 放行' : '🔴 关闭'} ${r.label}`);
  } else if (a) {
    // 形状可疑（是对象但 rows 不是数组）：尽力打印，绝不抛
    lines.push(`  自治开关：数据不完整（offCount=${a.offCount ?? '?'} / total=${a.total ?? '?'} / rows 缺失）`);
  } else {
    lines.push(o.disabled
      ? '  自治开关：版本门跳过：无 autonomy 数据（本次未读开关）'
      : '  自治开关：无 autonomy 数据（本次未读开关）');
  }
  if (o.reason) lines.push(`  原因=${o.reason}`);
  lines.push('  ── jobs ──');
  if (Array.isArray(o.summaries)) {
    for (const s of o.summaries) lines.push(`  ${s}`);
  } else {
    lines.push('  （本次未执行任何 job —— 提前返回，无 job 结果）');
  }
  const results = Array.isArray(o.results) ? o.results : [];
  const failed = results.filter((r) => r.status && !['ok', 'locked'].includes(r.status));
  if (failed.length) { lines.push('  ── 失败/异常 ──'); for (const f of failed) lines.push(`  ❌ ${f.job}: ${f.error ?? f.status}`); }
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs();
  const out = await runOnce(args);
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else if (!args.quiet) console.log(formatReport(out));
  if (!out.ok) process.exitCode = out.disabled ? 2 : 1;
}

if (isMainEntry()) {
  main().catch((e) => {
    try { alert({ level: 'error', source: 'butler-auto-tick', message: `tick 崩溃：${e?.message ?? e}`, detail: { stack: String(e?.stack ?? '').slice(0, 500) } }, {}); } catch { /* 告警通道也失败 */ }
    console.error(`[butler-auto-tick] 崩溃：${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
