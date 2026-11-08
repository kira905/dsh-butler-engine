// dsh-butler / lib/board-line-archive.mjs —— P2 自主动作 `board-line-archive`（周期归档）
//
// ✅ **本文件当前状态 = 已登记 · 已接线 · 已放行**（2026-09-28 K5d；主人当日 10:19 原话「K5 接闸门，然后放行」）：
//      · **登记**（K5b · 2026-09-28 09:51）：`AUTO_ACTION_KINDS` 该 kind + `MODULE_IDS` 同名模块行；
//      · **接线**（K5d）：① 动作体自身加**模块门** `checkModuleAllowed(KIND)` —— 与 `lib\queue-wake.mjs`
//        / `lib\auto-heal.mjs` **同构**（dry-run 不受闸门限制；真执行且门关 ⇒ `blocked` 零动作）；
//        ② tickd 调用点 `board-line-archive`（每 30 分钟 → `butler-auto-tick.mjs --job board-line-archive`）；
//      · **放行**（K5d）：`butler-autonomy-cli.mjs module on board-line-archive` ⇒ 矩阵 §3 该行状态 = ✅ 已放行。
//    ⇒ 自此「已放行 / 未放行」**差异可证**：一把 `module off board-line-archive` 关回 ⇒ 真执行路径立刻
//      `blocked`（接线前无此可证差异 —— 唯一的屏障只是"零调用点"，见 K5b 报告 §3）。
//    完整放行链（已完成）：① 登记 kind → ② 影子观测（`docs\管家-board-line-archive放行观测-20260928.md`）
//      → ③ 接线（模块门 + 调用点）→ ④ R3 改表放行。
//
// 【口径铁律·不自造第二套】本模块**不实现任何判定**，一律复用既有链条（方案 §8 #21）：
//   · 判定引擎 = `lib/board-cleanup.mjs` 的 `boardCleanupTick()`（在板卡全部 done 才算候选；
//     单卡线 24h 成熟期 · 线级 7 天冷却 · 首跑基线永久静默 · 出新卡不召回旧卡）
//   · 执行命令 = `tools\board-archive-line.mjs`（`--line "<主线名>" --apply --emit-restore`；
//     默认 dry-run；**只允许精确 `--line`/`--ids`，不提供 `--all`**）
//   · 唯一闸门 = `lib/autonomy-actions.mjs` 的 `runAction()`（去重 24h / 每日上限 / token 预算 / L0 降档）
//   ⇒ 本模块只做三件事：**取候选（只读）→ 排序截断（纯函数）→ 逐线调既有 CLI**。
//
// 三案共同硬要求（方案 §10 K5 行）：**默认 dry-run + 有候选才 apply + 执行留痕可见**。
//   · 默认 dry-run：`runBoardLineArchive()` 的 `dryRun` 缺省 = true（dry-run 通道不消费配额、零副作用）
//   · 有候选才 apply：无候选直接返回 `{ok:true, kind:'noop', changed:0}`，**不调 runAction**（不占额度）
//   · 留痕可见：走 `runAction()` ⇒ `~/.dsh/butler-auto-actions.json`（lastResults + daily）+ 审计；
//     逐线 CLI 的 stdout/stderr 摘要回灌进返回值。
//
// 零依赖（node 内置）；纯函数与 IO 分离，便于单测注入。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { readJson, updateJson } from '../../src/dsh-butler/lib/store.mjs';
import { boardCleanupTick, ARCHIVE_TOOL } from '../../src/dsh-butler/lib/board-cleanup.mjs';
// 【K5d · 2026-09-28 接线】模块门：与 `lib\queue-wake.mjs`（L466）/ `lib\auto-heal.mjs`（L701）**同构**调用。
import { checkModuleAllowed } from '../../src/dsh-butler/lib/autonomy-modules.mjs';
// 【G11③ · 2026-09-28】日额度（单日按线上限）：**复用**动作状态文件的读写与日切，不自造第二套 ——
//   `actionsStatePath`/`ACTIONS_SCHEMA`/`emptyActionsState` = 状态载体真源；`localDay` = 日切唯一源
//   （与 `checkDailyLimit` 同一函数）；`readLimits` = 护栏限额唯一源（本卡新增键 `lineArchiveMaxPerDay`）。
import {
  runAction as defaultRunAction,
  actionsStatePath, ACTIONS_SCHEMA, emptyActionsState, localDay, readLimits,
} from '../../src/dsh-butler/lib/autonomy-actions.mjs';
import { appendAudit } from '../../src/dsh-butler/lib/audit.mjs';

export const BOARD_LINE_ARCHIVE_VERSION = '0.1.0';
export const KIND = 'board-line-archive';
/** 单轮最多归档几条线（保守起步；放行后由主人按观测调，见 §11 P-8 可改点）。 */
export const MAX_LINES_PER_ROUND = 2;

// ---------------------------------------------------------------- 【G11③ · 2026-09-28】单日按线上限（B 案）
// 判据真源 = 卡 G11③「整线归档单日 ≤2 条线/天」；上游口径（卡面第 4 条硬要求 + 站1第12棒 §7 B 案）：
//   `docs\管家全家桶-愿景总纲.md` §5.1 P2 行解锁条件 ③「**单日上限（≤2 条线/天）**+ 冷却 7 天」
//   + `docs\交付报告-管家站1第12棒-20260928.md` §7（"单轮 2"≠"单日 2"，B 案 = 在动作体增按线计数的日上限）。
// **四条设计口径（为什么这样计数）**：
//   ① **计数单位 = 线**，不是动作次数：本动作**每条线调一次 `runAction()`** ⇒ 若复用 `runAction` 的
//      `daily.byKind` 会把 dry-run / 失败 / 被去重跳过的条目一起算成"线"（语义错位）；而
//      `maxAutoActionsPerDay` 是**跨 kind 全局**上限（卡面明写"不要复用它当判据"）⇒ 自建**按线**计数。
//   ② **载体不另起新根**：落在既有动作状态文件 `butler-auto-actions.json`（`ACTIONS_FILE`）的**顶层新段**
//      `lineArchiveDaily: { day, count, lastAt }` —— 与 `signatures` / `daily` 同族、走同一次原子读改写
//      （`store.mjs#updateJson`）。不新建 state 文件、不新增开关键、既有段语义一个字不改。
//   ③ **日切 = `autonomy-actions.mjs#localDay()`**（本地时区 YYYY-MM-DD）。选它的理由：本闸门与
//      `runAction()` 的每日上限**同源同日**，两者必须在跨天边界同时翻页；另写一份
//      `toISOString().slice(0,10)`（UTC）会错 8 小时（`lib\restart.mjs:650` 已有同款铁律）。
//      **读时归零、写时开新一天，无清零任务**（与 G33 加急档计数器同体例）。
//   ④ **向后兼容**：状态里没有该段 ⇒ `count = 0` ⇒ 行为与现状一致（第一轮不误拦）；读失败（损坏 /
//      schema 不符）也回归 0 = **fail-open**。理由：这是**节流**闸门不是**安全**闸门 —— "读不到就多跑
//      一次"优于"读不到就永久停摆"，安全面由模块门 + `runAction()` 四道闸兜着（对比模块门是 fail-close）。
/** 单日最多归档几条线（**默认 2**，与单轮同值；可被 `butler-autonomy-limits.json#lineArchiveMaxPerDay` 覆盖，0 = 显式全禁）。 */
export const MAX_LINES_PER_DAY = 2;
/** 计数段键名（`butler-auto-actions.json` 顶层）。 */
export const DAY_STATE_KEY = 'lineArchiveDaily';
/** 覆盖键名（`butler-autonomy-limits.json`；缺省/非法 ⇒ 回落 `MAX_LINES_PER_DAY`）。 */
export const DAY_LIMIT_KEY = 'lineArchiveMaxPerDay';
/** 单条线 CLI 超时（归档是秒级动作；给足余量但不许挂死）。 */
export const EXEC_TIMEOUT_MS = 120_000;
/** CLI 路径取自 `board-cleanup.mjs` 的 `ARCHIVE_TOOL`（唯一真源，不复制字面量）。 */
export const ARCHIVE_CLI = String(ARCHIVE_TOOL).replace(/^node\s+/i, '');
/** 看板 state 端点（live 视图足够：候选判定只看在板卡）。 */
export const DEFAULT_BASE_URL = 'http://localhost:3080';

/**
 * 取候选线（**只读**；判定 100% 复用引擎，本函数不算任何口径）。
 * live 视图（`x-dsh-board-scope: live`）比全量小一个数量级，且候选语义只依赖在板卡。
 */
export async function scanCandidates(opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const tasks = Array.isArray(opts.tasks) ? opts.tasks : null;
  let list = tasks;
  let revision = opts.revision ?? null;
  if (!list) {
    const res = await fetch(`${baseUrl}/api/task-board/state`, {
      headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin', 'x-dsh-board-scope': 'live' },
    });
    if (!res.ok) throw new Error(`读 /state 失败：HTTP ${res.status}`);
    const j = await res.json();
    list = Array.isArray(j.tasks) ? j.tasks : [];
    revision = j.revision ?? null;
  }
  const tick = await boardCleanupTick({
    home: opts.home ?? dshHome(),
    now: opts.now ?? Date.now(),
    tasks: list,
    revision,
    dryRun: true,                    // 只算不动：不写台账、不写日报段、不发桌宠
    force: true,                     // 绕过 30 分钟节流与 revision 短路（本动作自带 24h 去重）
    docsRoot: opts.docsRoot,
    readArchivedLineCounts: opts.readArchivedLineCounts,
  });
  return {
    ok: tick.ok !== false,
    revision,
    items: Array.isArray(tick.items) ? tick.items : [],
    counts: tick.counts ?? null,
    inBoard: tick.inBoard ?? null,
    resultText: tick.resultText ?? null,
    error: tick.error ?? null,
  };
}

// ---------------------------------------------------------------- 【G11③】日额度：解析 / 判据 / 读写

/** 解析单日按线上限：显式注入 > `limits` 注入 > `butler-autonomy-limits.json` 的 `lineArchiveMaxPerDay` > 默认 2。 */
export function resolveDayLimit(opts = {}) {
  const explicit = Number(opts.maxLinesPerDay ?? (opts.limits ? opts.limits[DAY_LIMIT_KEY] : undefined));
  if (Number.isFinite(explicit)) return Math.max(0, Math.floor(explicit));       // 0 = 显式全禁（与 G33 加急档同口径）
  let fromFile = NaN;
  try { fromFile = Number(readLimits({ home: opts.home })?.[DAY_LIMIT_KEY]); } catch { fromFile = NaN; }
  if (Number.isFinite(fromFile)) return Math.max(0, Math.floor(fromFile));
  return MAX_LINES_PER_DAY;
}

/** 读「当天已归档的线数」（**纯函数**，零 IO）。缺失段 / 跨日 ⇒ 归零（源标注在 `source`，供读数取证）。 */
export function dayStateOf(state, now = Date.now()) {
  const day = localDay(now);
  const seg = state?.[DAY_STATE_KEY];
  if (!seg || typeof seg !== 'object') return { day, count: 0, lastAt: null, source: 'absent' };
  if (String(seg.day ?? '') !== day) return { day, count: 0, lastAt: null, source: 'rolled' };
  const n = Number(seg.count);
  return {
    day,
    count: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    lastAt: Number(seg.lastAt ?? 0) || null,
    source: 'same-day',
  };
}

/** 日额度判据（**纯函数**）：`reached` ⇒ 今日不再归档新线；`remaining` = 本轮真执行可用的条数。 */
export function checkDayLimit(dayState, max) {
  const used = Math.max(0, Math.floor(Number(dayState?.count ?? 0)) || 0);
  const cap = Math.max(0, Math.floor(Number(max)) || 0);
  const reached = used >= cap;
  return {
    day: dayState?.day ?? null, used, max: cap, reached, remaining: Math.max(0, cap - used),
    source: dayState?.source ?? 'unknown',
    reason: reached
      ? `单日按线上限已达 ${used}/${cap}（本地日 ${dayState?.day}；跨日自动归零）`
      : `今日已归档 ${used}/${cap} 条线`,
  };
}

/** 读当日计数（**只读**，零写入）。读不到 / 损坏 ⇒ 0（fail-open，见文件头口径 ④）。 */
export function readDayUsed(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  try {
    const j = readJson(actionsStatePath({ home }), {
      schemaVersion: ACTIONS_SCHEMA, defaultValue: emptyActionsState(), home, audit: false,
    });
    return dayStateOf(j, now);
  } catch (e) {
    return { ...dayStateOf(null, now), source: 'read-error', error: String(e?.message ?? e) };
  }
}

/** 当日计数 +1（**原子读改写**，复用 `updateJson` 的同一把 RMW 锁）。**dry-run / 失败 / 被拦一律不调用**。 */
export function bumpDayUsed(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const by = Number.isFinite(Number(opts.by)) ? Math.max(0, Math.floor(Number(opts.by))) : 1;
  const file = actionsStatePath({ home });
  try {
    let next = null;
    updateJson(file, (cur) => {
      const seg = dayStateOf(cur, now);
      next = { day: seg.day, count: seg.count + by, lastAt: now };
      return { ...(cur ?? emptyActionsState()), [DAY_STATE_KEY]: next, schemaVersion: ACTIONS_SCHEMA };
    }, { schemaVersion: ACTIONS_SCHEMA, defaultValue: emptyActionsState(), home, audit: false });
    return { ok: true, ...next, file };
  } catch (e) {
    return { ok: false, count: null, error: String(e?.message ?? e), file };
  }
}

/**
 * 候选 → 逐线任务（**纯函数**，零 IO）。
 * 排序：`sortAt` 升序（最早动静优先）→ 线名；截断：单轮上限。
 * 双保险：`isBaseline` 的条目一律剔除（引擎已压制基线，此处再挡一层，防上游改动漏出）。
 */
export function planArchive(items, opts = {}) {
  const max = Number.isFinite(opts.maxLines) ? opts.maxLines : MAX_LINES_PER_ROUND;
  return (Array.isArray(items) ? items : [])
    .filter((x) => x && x.line && Number(x.live) > 0 && x.isBaseline !== true)
    .map((x) => ({
      line: String(x.line),
      rawLine: x.rawLine ?? String(x.line),
      live: Number(x.live),
      eventKey: x.eventKey ?? null,
      lastActivity: x.lastActivity ?? null,
      sortAt: x.sortAt ?? x.lastActivity ?? 0,
    }))
    .sort((a, b) => (a.sortAt - b.sortAt) || a.line.localeCompare(b.line))
    .slice(0, Math.max(0, max));
}

/** 逐线执行既有 CLI（`--apply --emit-restore`；dryRun 时**绝不**带 `--apply`）。 */
export function execArchiveLine(task, opts = {}) {
  const line = task.rawLine ?? task.line;
  const args = [ARCHIVE_CLI, '--line', line];
  if (opts.dryRun !== true) args.push('--apply', '--emit-restore');
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? EXEC_TIMEOUT_MS,
    windowsHide: true,
    cwd: opts.cwd,
  });
  const exitCode = r.status === null ? -1 : r.status;
  // 退出码语义（board-archive-line.mjs 文件头）：0 成功 / 4 有卡被跳过 / 5 命中 0 张 / 1 失败 / 2 用法 / 3 环境
  const ok = exitCode === 0 || exitCode === 4 || exitCode === 5;
  return {
    ok, line, exitCode,
    stdout: String(r.stdout ?? '').trim().slice(-2000),
    stderr: String(r.stderr ?? '').trim().slice(-2000),
    error: r.error ? String(r.error.message ?? r.error) : null,
  };
}

/**
 * 周期归档的动作体（**唯一入口**）。
 * 编排：scan（只读）→ **模块门 `checkModuleAllowed`** → **日额度（G11③，只读）** → plan（纯函数）
 *       → 逐线 `runAction()`（去重/上限/预算/降档全在这里）→ 成功一条线就 +1 日计数。
 *
 * @param {{home?:string, now?:number, dryRun?:boolean, maxLines?:number, maxLinesPerDay?:number,
 *          limits?:object, baseUrl?:string, tasks?:Array, revision?:number|string|null, autonomy?:object,
 *          deps?:{runAction?:Function, scan?:Function, exec?:Function}}} [opts]
 * @returns {Promise<{ok:boolean, kind:'noop'|'blocked'|'executed'|'partial'|'failed',
 *                    status:'dry-run'|'noop'|'blocked'|'executed'|'partial'|'failed', changed:number,
 *                    scanned:object, moduleGate?:object, dayQuota?:object, tasks:Array, outcomes:Array, reason?:string}>}
 */
export async function runBoardLineArchive(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun !== false;          // 默认 dry-run（硬要求）
  const runAction = opts.deps?.runAction ?? defaultRunAction;
  const scan = opts.deps?.scan ?? scanCandidates;
  const exec = opts.deps?.exec ?? execArchiveLine;

  const scanned = await scan({ home, now, tasks: opts.tasks, revision: opts.revision, baseUrl: opts.baseUrl });
  const planned = planArchive(scanned.items, { maxLines: opts.maxLines });   // 单轮口径（**G11③ 一字未改**）
  const base = { scanned, tasks: [], outcomes: [] };

  // 【K5d · 2026-09-28 接线】模块级闸门（L0 降档 × L1 owner `p3AutoEnabled` × L2 `modules['board-line-archive']`）。
  //   语义与 `queue-wake` / `auto-heal` 完全一致：**dry-run 不受闸门限制**（只算不动 ⇒ 影子视图照旧可见）。
  const moduleGate = checkModuleAllowed(KIND, { home, autonomy: opts.autonomy });
  base.moduleGate = moduleGate;

  // 【G11③ · 2026-09-28】单日按线上限（**只读读数**；dry-run 既不消费也不受限 ⇒ 影子视图口径不变）。
  const dayQuota = checkDayLimit(readDayUsed({ home, now }), resolveDayLimit({ home, limits: opts.limits, maxLinesPerDay: opts.maxLinesPerDay }));
  base.dayQuota = dayQuota;

  if (!planned.length) {
    return { ...base, ok: true, kind: 'noop', status: 'noop', changed: 0, reason: '无候选（在板全完成的线 0 条：可能仍在成熟期/冷却期/基线静默中）' };
  }

  // 门关 ⇒ blocked（零动作）。**判定顺序说明**：noop 先于 blocked —— "无候选"是没事可做，
  //   报 blocked 会误导成"被门挡住"；而"**有候选却门关**"才是闸门差异本身，也就是本卡接线的可证点。
  if (!dryRun && !moduleGate.allowed) {
    return { ...base, ok: true, kind: 'blocked', status: 'blocked', changed: 0, reason: `L2 模块闸门关闭：${moduleGate.reason}` };
  }

  // 【G11③】日额度熔断：**有候选才判**（无候选已在上面 noop 掉），且同样排在模块门之后 ——
  //   门关时报"门"、不报"额度"，否则会读成"额度放开就能动"。零动作 + 零看板写入 + 审计留痕（真执行路径才写）。
  if (!dryRun && dayQuota.reached) {
    // ⚠️ 字段**逐个显式**写，不用 `...dayQuota` —— 它自带 `reason` 字段，展开在后面会把
    //    `gateEvent` 这类标识键挤掉/覆盖（首版就踩了：spread 覆盖导致审计里查不到 `day-line-limit`，
    //    被单测 T9 ② 抓出，2026-09-28 实测）。
    appendAudit({
      type: 'auto-action-skip', kind: KIND, gateEvent: 'day-line-limit',
      day: dayQuota.day, used: dayQuota.used, max: dayQuota.max, reached: dayQuota.reached,
      reason: `单日按线上限：${dayQuota.reason}`,
    }, { home, silent: true });
    return { ...base, ok: true, kind: 'blocked', status: 'blocked', changed: 0, reason: `单日按线上限熔断：${dayQuota.reason}` };
  }

  // 真执行的计划 = 单轮上限 ∩ 当日剩余额度；dry-run 不截断（影子视图仍按单轮口径预演）。
  const tasks = dryRun ? planned : planned.slice(0, dayQuota.remaining);
  base.tasks = tasks;

  let dayUsed = dayQuota.used;
  for (const t of tasks) {
    const res = await runAction({
      kind: KIND, now, home, dryRun,
      // 去重键 = 线 + 该线当前事件键（引擎给的，非自造）：同线同状态 24h 内不重复动手
      sigKey: t.eventKey ? `${KIND}|${t.line}|${t.eventKey}` : `${KIND}|${t.line}`,
      preview: () => ({ line: t.line, live: t.live, command: `node ${ARCHIVE_CLI} --line "${t.rawLine ?? t.line}" --apply --emit-restore` }),
      execute: async () => exec(t, { home, dryRun: false, timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS }),
    });
    const outcome = {
      line: t.line, status: res.status, reason: res.reason ?? null,
      exitCode: res.result?.exitCode ?? null, ok: res.result?.ok ?? null,
      stdout: res.result?.stdout ?? null, stderr: res.result?.stderr ?? null,
    };
    // 【G11③】**成功归档一条线 ⇒ 当日计数 +1**。三条不计：dry-run（零副作用）/ 失败（没办成事，同
    //   `runAction` 的"失败不占额度"口径）/ blocked·noop（压根没动手）。计数写失败**不回滚已归档事实**，
    //   只在逐线结果里如实标注 `dayCountError`（绝不假装记上了）。
    if (!dryRun && outcome.status === 'executed' && outcome.ok !== false) {
      const bumped = bumpDayUsed({ home, now });
      if (bumped.ok) { dayUsed = bumped.count; outcome.dayCount = bumped.count; }
      else outcome.dayCountError = bumped.error;
    }
    base.outcomes.push(outcome);
  }

  const executed = base.outcomes.filter((o) => o.status === 'executed' && o.ok !== false).length;
  const failed = base.outcomes.filter((o) => o.status === 'failed' || o.ok === false).length;
  const wouldRun = base.outcomes.filter((o) => o.status === 'dry-run').length;
  const changed = dryRun ? 0 : executed;         // dry-run 永远 changed=0（零写入）
  const kind = failed > 0 ? (executed > 0 ? 'partial' : 'failed') : 'executed';
  return {
    ...base,
    ok: failed === 0,
    kind,
    // 【K5d 接线补齐】`status` = 接线层（`butler-auto-tick.mjs#wireOutcome`）读取的**状态字段名**
    //   —— 四个先例动作体（queue-wake / auto-heal / …）都带 `status`，本模块 K5b 实现只给了 `kind`
    //   ⇒ 接线后 tickd 记账会显示 `unknown`（2026-09-28 K5d 实测：`[board-line-archive] … unknown`）。
    //   故**纯新增**该字段（`kind` 语义一字不改，向后兼容）：dry-run 时报 `dry-run`（同先例语义）。
    status: dryRun ? 'dry-run' : kind,
    changed,
    reason: dryRun
      ? `dry-run：${wouldRun}/${tasks.length} 条线将被归档（未执行；今日已归档 ${dayQuota.used}/${dayQuota.max} 条线）`
      : `已执行 ${executed}/${tasks.length} 条线${failed ? `，失败 ${failed} 条` : ''}（今日按线计数 ${dayUsed}/${dayQuota.max}）`,
  };
}

export default runBoardLineArchive;

// ---------------------------------------------------------------- CLI（便于实测与人工预演）
// 用法：node lib\board-line-archive.mjs [--apply] [--json] [--max-lines N] [--max-lines-per-day N]
//   缺省 = dry-run（只列候选与将执行的命令）；`--apply` 才真跑（仍受 runAction 闸门 + 日额度约束）。

async function main(argv) {
  const json = argv.includes('--json');
  const apply = argv.includes('--apply');
  const mi = argv.indexOf('--max-lines');
  const maxLines = mi >= 0 ? Number(argv[mi + 1]) : undefined;
  const di = argv.indexOf('--max-lines-per-day');
  const maxLinesPerDay = di >= 0 ? Number(argv[di + 1]) : undefined;
  const out = await runBoardLineArchive({ dryRun: !apply, maxLines, maxLinesPerDay });
  if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    process.stdout.write(`# board-line-archive（${apply ? 'apply' : 'dry-run'}）\n`);
    if (out.dayQuota) {
      process.stdout.write(`- 日额度：今日已归档 ${out.dayQuota.used}/${out.dayQuota.max} 条线`
        + `（${out.dayQuota.reached ? '已达上限' : `剩余 ${out.dayQuota.remaining}`}）· 本地日 ${out.dayQuota.day} · 读数源 ${out.dayQuota.source}\n`);
    }
    process.stdout.write(`- 候选线 ${out.tasks.length} 条（本轮上限内）：${out.tasks.map((t) => `${t.line}(${t.live})`).join(' / ') || '(无)'}\n`);
    process.stdout.write(`- 结果：${out.kind} · ${out.reason ?? ''}\n`);
    for (const o of out.outcomes) process.stdout.write(`  - ${o.line} → ${o.status}${o.exitCode === null ? '' : ` (exit ${o.exitCode})`}${o.reason ? ` ${o.reason}` : ''}\n`);
    if (out.scanned?.inBoard) {
      const ib = out.scanned.inBoard;
      process.stdout.write(`- 在板 ${ib.cards} 张 · 主账本 ${ib.ledgerBytes} B · J1 相对项 ${ib.relOk ? '✅' : '❌'} / 绝对项 ${ib.absOk ? '✅' : '❌'}\n`);
    }
  }
  if (out.kind === 'failed') process.exitCode = 1;
}

const isMain = (() => {
  try {
    const a = path.resolve(process.argv[1] ?? '');
    const b = path.resolve(fileURLToPath(import.meta.url));
    return a.toLowerCase() === b.toLowerCase();
  } catch { return false; }
})();
if (isMain) await main(process.argv.slice(2));
