#!/usr/bin/env node
// dsh-butler / butler-tidy-tick.mjs —— P8 会收纳：收纳审计采集器（卡 [10]，**纯只读**）
//
// 方案：docs\管家v2.5-P8会收纳设计-20260909.md
//   §7.1 组件（butler-tidy-tick：计划任务短命脚本，每 6h）
//   §7.2 状态文件（butler-tidy-state.json：持久 / 每路径 1 条 + 180 天 / **不随仓1同步**）
//   §13 复用件（butler-scheduler 注册采集器 + butler-store 原子写与 tick 锁 + 既有审计器）
//   §15.2 P-1（降档态读 butler-autonomy.json 的 phase）/ P-2（白名单读取顺序 + 遍历器 junction 二分）
//
// 本卡只读边界（§11 [10]）：
//   ✅ 跑既有 butler-audit-archive.mjs 的 auditArchive()（**不重写检查逻辑**）
//   ✅ 统计 _tmp / _archive 现状（走 lib/tidy-walk.mjs，内容 reparse point 不穿透）
//   ✅ 解析降档态与 L2 闸门（**只解析，不执行任何 L2 动作**）
//   ❌ 不搬移、不删除、不改名、不写任何被审计对象（只写自己的状态文件与审计流水）
//
// ── 订正注（2026-10-14 · V2.9 封口清单 J L478 · 卡「施工·封口①J域README生成侧」）────────────
//   ⚠️ 上一行「不写任何被审计对象」**多了一个受控例外**（只标注，不改上文原文）：
//     `_archive/README.md`（**生成物**）在 CLI 入口（= tickd job `tidy` 的自动入口）**缺省自动生成** ——
//     审计检测到它缺失/过期即重写，幂等（新鲜时不碰盘）；`--no-readme-gen` 关回、`--dry-run` 只算不落盘。
//     · 边界不变的部分：**搬移/删除/改名/其它实体一律不碰**；README 是索引生成物，重写不改任何归档实体。
//     · 库调用（`createTidyScheduler()` / `runTidyAudit()` 直调）**缺省不生成** ⇒ 单测/验收脚本零写盘。
//     真源 = `docs\交付报告-封口①-J域README生成侧-20261014.md`。
//
// 跨线让路（③-2 · 方案 docs\跨线契约包-方案-20260917.md §3.3 C-3 · 家规 R8）：
//   本采集器**只读**，所以它**不抢** `handoff` 锁（抢了会与 30 分钟热采正面互斥 ⇒ 审计长期断档）；
//   改为「**判窗口 + 整轮跳过**」：进采集器第一件事 = `judgeLane({self:'tidy'})`，判定非 clear ⇒
//     · **不跑审计、不写审计行、不产报告**（半截 `_archive`/_tmp 统计会产出**假告警** ⇒ 宁缺不脏）；
//     · 只在 `butler-tidy-state.json` 的 `lane` 段记 `{skipped, at, streak, evidence}`（让路必须可见）；
//     · 6h 后下一轮照跑（判据不可用同样让路 + 告警，绝不"判不了就当没事跑"）。
//   ⚠️ 让路**不写审计行**是刻意的（判据唯一源 lib/cross-lane.mjs 自己也不写）——可见性靠状态文件 +
//      日报「🔗 跨线契约」段（读同一份 judgeLane 结果）。
//
// 一次 tick 的流程：
//   0. **跨线让路闸**（③-2）：judgeLane({self:'tidy'}) → 非 clear 即整轮跳过（见上）
//   1. 组件版本闸门（gateComponent）→ 不匹配则跳过本组件 + 独立告警通道
//   2. 注册采集器 → butler-scheduler 抢 tick 锁（抢不到 = 静默跳过，exit 0），
//      **单个采集器抛错被隔离**成一条 record，不影响其他采集器
//   3. 读降档态（P-1）：butler-autonomy.json 的 phase → L2 闸门两行（phaseAllowsL2 / switchAllowsL2）
//   4. 跑归档审计（P-2：白名单读取顺序 = 策略文件 → wrapup 内联）
//   5. 写状态文件（butler-store updateJson 原子写，schemaVersion 1；`lane` 为后加的可空字段）
//   6. P2 取舍：**结论仍不调 ctx.alert**；事件注册 = **2026-10-09 起 3 类（执行/失败/跳过）已注册**，
//      但落地形态是"报告段"（watch tick 的 🧹 收纳段），**不进 EVENT_SPECS 主表** ⇒ 不抬告警分母。
//      （订正注：原文为"不注册 P2 事件 / 裸跑期样本池保护"，见下方 P2_EVENTS_POLICY 的沿革段。
//        **唯一例外**一直有效 = 让路的"判据不可用"档必报警。）
//
// 用法：
//   node butler-tidy-tick.mjs             # 跑一轮（正常入口，供计划任务调用）
//   node butler-tidy-tick.mjs --dry-run   # 只跑不写状态文件
//   node butler-tidy-tick.mjs --json      # 结构化输出
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome, statePath, newRunId } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { updateJson } from '../src/dsh-butler/lib/store.mjs';
import { updateStateJson } from '../src/dsh-butler/lib/dual-write-store.mjs';
import { createScheduler } from './lib/scheduler.mjs';
import { readAutonomy } from '../src/dsh-butler/lib/autonomy.mjs';
import { readAutonomyState } from '../src/dsh-butler/lib/autonomy-state.mjs';
import { readModules } from '../src/dsh-butler/lib/autonomy-modules.mjs';
import { gateComponent } from '../src/dsh-butler/lib/version.mjs';
import { countTree } from './lib/tidy-walk.mjs';
import { planTidyMove, describePlan, bucketName } from './lib/tidy-move.mjs';
// 【2026-10-09 · 卡「冲刺600·补C2C3」】P2 事件注册由 `false` 改 `true`（**只注册执行/失败/跳过三类**，
//   候选提示类明确不注册）—— 权威清单与判据层都在 `lib/tidy-events.mjs`（单一真相，本文件不复制字面量）。
import { TIDY_P2_EVENT_KINDS, TIDY_NOT_REGISTERED } from './lib/tidy-events.mjs';
import {
  auditArchive, sampleArchiveNaming, AUDIT_CHECKPOINT_IDS, AUDIT_SAMPLE, DEFAULT_DSH_ROOT,
} from './butler-audit-archive.mjs';

export const VERSION = '0.1.0';
/** 调度器名（tick 锁名 = `${TICK_NAME}-${采集器 id}`）。 */
export const TICK_NAME = 'tidy';
export const COLLECTOR_ID = 'audit';
/** 计划任务名（供部署脚本/文档引用；本卡不注册计划任务，注册属 [12]）。 */
export const TASK_NAME = 'DSH-Butler-TidyTick';
export const COMPONENT = 'butler-tidy';
/** 采集间隔（方案 §4.1 A2 原文 1 次/6h；**2026-09-29 主人令改 12h** —— 必须与 tickd JOBS 的 tidy 行同值，见 butler-tickd.mjs 该行注）。 */
export const INTERVAL_MS = 12 * 3600_000;
/** 【2c-B3】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, home) {
  return resolveStatePath(name, { home }).path;
}
export const STATE_NAME = 'butler-tidy-state.json';
export const STATE_SCHEMA = 1;
export const HISTORY_CAP = 30;

/**
 * 【2026-10-10 · B4 卡（冲刺600·补收纳）】`lastRun` 里一并落盘的**另外四个挂载点目录**（A1「扫六目录计数与占用」）。
 *
 * 六个目录 = `_tmp` / `_archive`（本采集器原有）+ `generated` / `logs` / `backups` / `snapshots`（本卡补）。
 * 六个都是 **<workspace> 根的挂载点 junction** → 指向 `<offsync>\…`（生产数据正式所在，跟随后才统计得到；
 * 见 `lib/tidy-walk.mjs` 的挂载点/内容 reparse point 二分）。
 *
 * 为什么值得落盘：B4 前 `lastRun` 只有 `tmp` / `archive` 两处读数 ⇒ 面板/报告说不出另外四个目录
 * 有多大、有多少文件；而 A3 的 KPI ⑤（三件套）与 C1（空间治理候选清单）都要靠这些读数。
 * 代价实测（2026-10-10 · host-a · _tmp 5801 文件）：四目录合计 **~0.9s**（generated 212ms /
 * logs 571ms / snapshots 104ms / backups 16ms），tick 预算 60000ms（heavy）⇒ 远在预算内。
 */
export const STORAGE_DIRS = Object.freeze(['generated', 'logs', 'backups', 'snapshots']);

/**
 * P2 事件取舍 —— 【2026-10-09 · 卡「冲刺600·补C2C3」**已注册**（原文保留在下方"沿革"里）】。
 *
 * 沿革：卡 [10]（2026-09-10）原决定 = **收纳事件只进报告，不进告警计数**（裸跑期样本池保护）。
 * 本次订正：裸跑期收口后按 **K5b 口径**（`docs\交付报告-看板瘦身K5b登记-20260928.md` §2②：
 *   "只注册执行类事件，候选提示类不注册 ⇒ 不抬高只读提示的告警分母"）注册 **3 类**：
 *   `tidy-move-applied`（执行）/ `tidy-move-failed`（失败）/ `tidy-audit-skipped`（跳过）。
 *
 * ⚠️ 落地形态与"注册"二字的含义（别误读）：
 *   · 判定层 = `lib/tidy-events.mjs`（自带注册表，机器可核）；
 *   · **不进 `watch-events.mjs#EVENT_SPECS` 主表** ⇒ 不占裸跑期 KPI 分母/分子（与 P9 交接同款，
 *     走 `writeReport({ extra })` 的 🧹 收纳段）；
 *   · `kinds` = 已注册清单；`notRegistered` = 明确不注册的候选提示类 + 理由（可核"为什么没有它"）。
 */
export const P2_EVENTS_POLICY = Object.freeze({
  registered: true,
  reason: 'bare-run-sample-pool-closed',
  deferTo: null,
  kinds: Object.freeze([...TIDY_P2_EVENT_KINDS]),
  notRegistered: TIDY_NOT_REGISTERED,
  channel: 'report-section',
  detail: '报告段落地（`writeReport({extra})` 的 🧹 收纳段）；不进 EVENT_SPECS 主表 ⇒ 零 KPI 污染。'
    + '判定/去重/显式出口全在 lib\\tidy-events.mjs。2026-10-09 卡「冲刺600·补C2C3」。',
});

export const USAGE = [
  'butler-tidy-tick —— P8 会收纳：只读审计采集器（卡 [10]）',
  '  node butler-tidy-tick.mjs [--dry-run] [--json] [--no-readme-gen] [--readme-min-age-days N]',
  '',
  'README 生成侧（2026-10-14 · 封口① J L478）：CLI 入口**缺省开** —— 审计检测到 `_archive/README.md`',
  '  缺失/过期即生成（幂等）；`--no-readme-gen` 关回、`--dry-run` 只算不落盘。库调用缺省关（测试不写盘）。',
  '',
  '跨线让路（③-2 · 方案 §3.3 C-3）：进采集器先 judgeLane({self:\'tidy\'})；判定非 clear 即整轮跳过',
  '  （不跑审计 / 不写审计行 / 不产报告），只在收纳状态文件的 lane 段记 skipped + evidence。',
  '  跳过原因码：handoff-window（交接窗口）/ upgrade-active（升级锁三态）/ judge-unavailable（判据不可用，另报警）。',
].join('\n');

/** 让路原因码（对外唯一字符串口径：写进状态文件 lane.skipped、日志与测试断言都用它）。 */
export const LANE_SKIP = Object.freeze({
  HANDOFF_WINDOW: 'handoff-window',
  UPGRADE_ACTIVE: 'upgrade-active',
  JUDGE_UNAVAILABLE: 'judge-unavailable',
});

/** 采集器默认让路判定线名（judgeLane 的 self；画像 = 'skip'，见 lib/cross-lane.mjs 的 LANE_SELF_PROFILES）。 */
export const LANE_SELF = 'tidy';

/** 状态文件 lane 段 schema（后加的可空字段；schemaVersion 仍为 1 —— 纯新增键，读侧容忍缺失）。 */
export const LANE_FIELD_NOTE = 'lane = 最近一次的跨线判定（skipped 非空 = 该轮整轮让路，无审计产物）';

export function tidyStatePath(home = dshHome()) {
  return stateFileOf(STATE_NAME, home);
}

/** 设备短码（P8 §2.7 发现 3：归档状态是单机事实，报告必须标设备）。 */
export function deviceName() {
  try { return os.hostname() || 'unknown-host'; } catch { return 'unknown-host'; }
}

/**
 * L2 闸门（**2026-09-28 P8 [12] 重写**）。
 *
 * ── 改前（2026-09-10 ~ 09-28）──────────────────────────────────────────────
 *   判据 = `butler-autonomy.json#phase === 'normal'` × `p8AutoEnabled === true`（P-1 的第一版实现）。
 * ── 为什么必须改写（真源：设计档 §11 订正注 · 主人 2026-09-21 对 D-d 拍板「③」）────
 *   主人拍定 **`phase` 只作历史标记，放行一律看报告与判据** ⇒ 拿 `phase` 当闸门 = 拿历史标记当判据。
 *   新判据 = 与搬移动作的**独立自治闸**同源（`lib/tidy-move.mjs` 的 `resolveMoveGate`）：
 *     **L0 降档**（`butler-autonomy-state.json#level === 'normal'`）
 *   × **L1 `p8AutoEnabled`**（`butler-autonomy.json`，主人 09-10 16:36 拍板「p8-auto 独立自主」）
 *   × **L2 `modules['p8-tidy'].enabled`**（模块级熔断，默认关）
 *   三缺一即停；读不到一律按**停**（fail-safe）。
 *   ⚠️ **本函数保持"纯"**（不碰磁盘）：L0 与 L2 的值由调用方读出后经 `ctx` 传入 ——
 *      就地读会把它变成一次性 I/O 副作用，单测没法构造两态（test-tidy 段④ 正是这么验的）。
 *
 * @param {object|null} raw `butler-autonomy.json` 原始内容（只读其中 `p8AutoEnabled` 与 `phase`）
 * @param {{l0Level?:string, moduleEnabled?:boolean}} [ctx] L0 降档态与 L2 模块门（**缺省 = 停**）
 */
export function resolveL2Gate(raw, ctx = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const phase = typeof src.phase === 'string' && src.phase ? src.phase : 'bare-run';
  const hasSwitch = Object.prototype.hasOwnProperty.call(src, 'p8AutoEnabled');
  const l0Level = typeof ctx.l0Level === 'string' ? ctx.l0Level : null;
  const l0AllowsL2 = l0Level === 'normal';
  const switchAllowsL2 = src.p8AutoEnabled === true;
  const moduleAllowsL2 = ctx.moduleEnabled === true;
  const l2Allowed = l0AllowsL2 && switchAllowsL2 && moduleAllowsL2;
  const missing = [];
  if (!l0AllowsL2) missing.push(`L0 降档（level=${l0Level ?? '读不到'}）`);
  if (!switchAllowsL2) missing.push(hasSwitch ? 'L1 p8AutoEnabled=false' : 'L1 p8AutoEnabled 未注册（键缺失 ⇒ fail-safe 关）');
  if (!moduleAllowsL2) missing.push('L2 modules[p8-tidy] 关（默认关）');
  return {
    phase,
    /** 历史标记（**不参与判定** —— D-d ③ 拍板）。留在这里只是让面板/报告还能显示出它。 */
    phaseIsHistorical: true,
    l0Level,
    l0AllowsL2,
    switchRegistered: hasSwitch,
    switchAllowsL2,
    moduleAllowsL2,
    l2Allowed,
    reason: l2Allowed ? 'ok（L0 normal × L1 p8AutoEnabled × L2 modules[p8-tidy]）' : missing.join(' + '),
  };
}

export function emptyTidyState() {
  return {
    schemaVersion: STATE_SCHEMA,
    product: 'dsh-butler',
    component: COMPONENT,
    version: VERSION,
    updatedAt: null,
    device: null,
    counters: { runs: 0, fails: 0, skips: 0 },
    lane: null,
    lastRun: null,
    history: [],
  };
}

/** 纯函数：把一轮结果并入状态（便于单测，不碰磁盘）。 */
export function applyRun(cur, run) {
  const base = cur && typeof cur === 'object' ? cur : emptyTidyState();
  const row = {
    at: run.at,
    runId: run.runId,
    durationMs: run.durationMs,
    produced: run.audit.produced,
    summary: run.audit.summary,
    tmpFiles: run.tmp.fileCount,
    tmpBytes: run.tmp.bytes,
    // A1（B4）：另外四目录 + _archive 之外的合计（趋势对比用；历史行缺该字段 = 老口径，读侧容忍缺失）
    storageBytes: run.storageTotals?.bytes ?? null,
    storageFiles: run.storageTotals?.fileCount ?? null,
    degraded: run.gate.l2Allowed !== true,
  };
  // 真跑必定在 judgeLane 的 clear 分支里（③-2）⇒ 顺手把让路连击清零（"现在不在让路"要能被读出来）
  // ⚠️ `run.lane` 由采集器（生产唯一入口）传入；测试/验收脚本直接调 `runTidyAudit()` 时无 lane 入参
  //    ⇒ 记 null（"本轮没做跨线判定"如实表达），**不留上一次的 skipped 残影**。
  const laneRec = run.lane && typeof run.lane === 'object'
    ? {
      at: run.lane.at ?? new Date(run.at).toISOString(),
      verdict: run.lane.verdict ?? 'clear',
      owner: run.lane.owner ?? null,
      judgeUnavailable: run.lane.judgeUnavailable === true,
      skipped: null,
      streak: 0,
      since: null,
      summary: run.lane.summary ?? null,
      evidence: null,
    }
    : null;
  return {
    ...base,
    schemaVersion: STATE_SCHEMA,
    product: 'dsh-butler',
    component: COMPONENT,
    version: VERSION,
    updatedAt: new Date(run.at).toISOString(),
    device: run.device,
    counters: { runs: (base.counters?.runs ?? 0) + 1, fails: base.counters?.fails ?? 0, skips: base.counters?.skips ?? 0 },
    lane: laneRec,
    lastRun: run,
    history: [...(base.history ?? []), row].slice(-HISTORY_CAP),
  };
}

// ------------------------------------------------------- 跨线让路（③-2 · 方案 §3.3 C-3）

/** 纯函数：judgeLane() 结果 → 让路原因码（未知 owner 一律按"判据不可用"记账，**不静默**）。 */
export function laneSkipKind(lane) {
  if (!lane || typeof lane !== 'object') return LANE_SKIP.JUDGE_UNAVAILABLE;
  if (lane.judgeUnavailable === true) return LANE_SKIP.JUDGE_UNAVAILABLE;
  if (lane.owner === 'handoff') return LANE_SKIP.HANDOFF_WINDOW;
  if (lane.owner === 'upgrade') return LANE_SKIP.UPGRADE_ACTIVE;
  return LANE_SKIP.JUDGE_UNAVAILABLE;
}

/** 纯函数：跨线证据压缩（状态文件要能自证"凭什么跳过"，但别把整份锁对象塞进去）。 */
export function compactLaneEvidence(lane) {
  const ev = lane?.evidence ?? {};
  const up = ev.upgrade ?? null;
  const hf = ev.handoff ?? null;
  const si = ev.silence ?? null;
  const num = (x) => (Number.isFinite(x) ? Number(x) : null);
  return {
    verdict: lane?.verdict ?? null,
    owner: lane?.owner ?? null,
    profile: lane?.profile ?? null,
    judgeUnavailable: lane?.judgeUnavailable === true,
    summary: lane?.summary ?? null,
    reasons: Array.isArray(lane?.reasons) ? lane.reasons.slice(0, 6) : [],
    upgrade: up ? {
      state: up.state ?? null, holding: up.holding === true, summary: up.summary ?? null,
      ageMs: num(up.ageMs), pidAlive: up.pidAlive ?? null, file: up.file ?? null,
      judgeUnavailable: up.judgeUnavailable === true, unavailableWhy: up.unavailableWhy ?? null,
    } : null,
    handoff: hf ? {
      active: hf.active === true, reason: hf.reason ?? null, lockPath: hf.lockPath ?? null,
      ageMs: num(hf.ageMs), ttlMs: num(hf.ttlMs), stale: hf.stale === true,
      judgeUnavailable: hf.judgeUnavailable === true, unavailableWhy: hf.unavailableWhy ?? null,
    } : null,
    silence: si ? {
      open: si.open === true,
      holders: (Array.isArray(si.holders) ? si.holders : []).map((x) => ({ id: x?.id ?? null, at: x?.at ?? null, reason: x?.reason ?? null })),
    } : null,
  };
}

/**
 * 纯函数：把"本轮跨线判定"并进状态（**跳过轮与真跑轮都记** —— 让路必须可见，且能数出连续轮数）。
 * 跳过轮：counters.skips+1、lane.streak+1、history 追加一条 `{skipped}` 行（不覆盖 lastRun）。
 * 真跑轮：lane.streak 归零（由 applyRun 落），本函数只处理跳过轮 / 也需要独立落 lane 的场景。
 */
export function applyLane(cur, rec) {
  const base = cur && typeof cur === 'object' ? cur : emptyTidyState();
  const skipped = rec?.skipped ?? null;
  const prevStreak = Number.isFinite(base.lane?.streak) ? Number(base.lane.streak) : 0;
  const streak = skipped ? prevStreak + 1 : 0;
  const since = skipped ? (prevStreak > 0 ? (base.lane?.since ?? rec.at) : rec.at) : null;
  const next = {
    ...base,
    schemaVersion: STATE_SCHEMA,
    product: 'dsh-butler',
    component: COMPONENT,
    version: VERSION,
    updatedAt: new Date(rec.atMs ?? Date.now()).toISOString(),
    device: rec.device ?? base.device ?? null,
    lane: {
      at: rec.at,
      verdict: rec.verdict ?? null,
      owner: rec.owner ?? null,
      judgeUnavailable: rec.judgeUnavailable === true,
      skipped,
      streak,
      since,
      summary: rec.summary ?? null,
      evidence: rec.evidence ?? null,
    },
    counters: {
      runs: base.counters?.runs ?? 0,
      fails: base.counters?.fails ?? 0,
      skips: (base.counters?.skips ?? 0) + (skipped ? 1 : 0),
    },
  };
  if (!skipped) return next;
  const row = {
    at: rec.atMs ?? null,
    runId: rec.runId ?? null,
    skipped,
    owner: rec.owner ?? null,
    durationMs: rec.durationMs ?? 0,
  };
  return { ...next, history: [...(base.history ?? []), row].slice(-HISTORY_CAP) };
}

/** 纯函数：跳过轮记录（供采集器与单测共用；不碰磁盘）。 */
export function buildSkipRecord(lane, opts = {}) {
  const now = opts.now ?? Date.now();
  return {
    at: lane?.at ?? new Date(now).toISOString(),
    atMs: now,
    runId: opts.runId ?? null,
    device: opts.device ?? deviceName(),
    verdict: lane?.verdict ?? null,
    owner: lane?.owner ?? null,
    judgeUnavailable: lane?.judgeUnavailable === true,
    skipped: laneSkipKind(lane),
    summary: lane?.summary ?? null,
    evidence: compactLaneEvidence(lane),
    durationMs: opts.durationMs ?? 0,
  };
}

/**
 * 跨线让路判定（③-2）。**动态 import + 兜底**：
 *   `cross-lane.mjs` import 失败 / `judgeLane()` 抛错 ⇒ 合成一条 `judgeUnavailable` 的 yield 判定
 *   （保守让路），**绝不"判不了就当没事跑"**（方案 §3.2 硬口径③ / §7.1 ③）。
 * 为什么动态 import：静态 import 一旦失败会让整个脚本**加载即崩**，那就不是"不跑本轮"而是"炸了"。
 * @param {{home?:string, now?:number}} [opts]
 * @returns {Promise<{lane:object, moduleLoaded:boolean, error:string|null}>}
 */
export async function judgeTidyLane(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  try {
    const mod = await import('./lib/cross-lane.mjs');
    return { lane: mod.judgeLane({ home, self: LANE_SELF, now }), moduleLoaded: true, error: null };
  } catch (e) {
    const msg = e?.message ?? String(e);
    return {
      moduleLoaded: false,
      error: msg,
      lane: {
        at: new Date(now).toISOString(),
        self: LANE_SELF,
        profile: 'skip',
        verdict: 'yield',
        owner: null,
        reasons: [`⚠️ 判据不可用（lib/cross-lane.mjs 不可用）：${msg}`],
        judgeUnavailable: true,
        evidence: { home, upgrade: null, handoff: null, silence: null },
        summary: `yield（self=${LANE_SELF}，判据不可用）`,
      },
    };
  }
}

/** 把跳过轮写进状态文件（butler-store 原子写）。`dryRun` 由调用方把关。 */
export function recordLane(home, rec) {
  return updateStateJson(STATE_NAME, tidyStatePath(home), (cur) => applyLane(cur, rec), {
    schemaVersion: STATE_SCHEMA,
    defaultValue: emptyTidyState(),
    home,
  });
}

/**
 * 跑一轮收纳审计（只读）。**不搬移、不删除、不告警**。
 * ⚠️ 跨线让路闸（③-2）**不在这里**，而在采集器 `run()` 里（`createTidyScheduler`）—— 理由：
 *   本函数也被测试与 `_test/verify-p8-acceptance.mjs` **直接调用**，若把闸放这里，验收脚本撞上
 *   交接窗口就会拿到 `ok:false` 而崩（`r.run.audit` 读 undefined）。「tick 让路」是采集器的语义。
 * @param {{home?:string, dshRoot?:string, now?:number, runId?:string, dryRun?:boolean, docsSample?:number, lane?:object|null}} [opts]
 */
export async function runTidyAudit(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const runId = opts.runId ?? newRunId('p8');
  const t0 = Date.now();

  const gate = gateComponent(COMPONENT, VERSION, { home });
  if (!gate.run) return { ok: false, skipped: 'version-gate', gate, runId };

  const autonomy = readAutonomy({ home });
  // 【2026-09-28】L2 闸门三源：L0（降档态，独立文件）× L1（p8AutoEnabled）× L2（modules['p8-tidy']）
  const l0State = readAutonomyState({ home });
  const p8Module = readModules({ home })?.modules?.['p8-tidy'] ?? null;
  const l2 = resolveL2Gate(autonomy.raw, { l0Level: l0State.level, moduleEnabled: p8Module?.enabled === true });

  const audit = await auditArchive({
    dshRoot,
    home,
    now,
    docsSample: opts.docsSample ?? AUDIT_SAMPLE.docs ?? 10,
    recentLimit: AUDIT_SAMPLE.backup,
    archiveLimit: AUDIT_SAMPLE.naming,
    // 【2026-10-14 · V2.9 封口清单 J L478 · 卡「施工·封口①J域README生成侧」】
    //   `_archive/README.md` 的**生成侧**接进本审计流程：检测到缺失/过期即生成（幂等）。
    //   ⚠️ 缺省 **false** —— 本函数对测试/验收脚本直调时**绝不写盘**（否则 `_test` 会污染生产 `_archive`）；
    //      自动入口由采集器显式开（见 `createTidyScheduler` 的 `readmeGen`，缺省关；CLI 入口缺省开）。
    //   `readmeDryRun` 跟随本函数的 `dryRun`（--dry-run 轮绝不落盘）。
    ensureReadme: opts.ensureReadme === true,
    readmeDryRun: opts.dryRun === true,
    readmeMinAgeDays: opts.readmeMinAgeDays,
    // 夹具/验收隔离：孤儿检测扫的桌面随调用方透传（缺省仍为真实桌面）
    desktop: opts.desktop,
  });
  // 统一遍历器（P-2）：_tmp 是根级挂载点，跟随后统计；其内部的内容 reparse point 不穿透
  const tmp = countTree(path.join(dshRoot, '_tmp'));
  const naming = sampleArchiveNaming(dshRoot, AUDIT_SAMPLE.naming);
  // A1（B4 卡）：另外四个挂载点目录 —— 与 tmp 同款字段结构，逐目录一条
  const storage = {};
  for (const name of STORAGE_DIRS) {
    const t = countTree(path.join(dshRoot, name));
    storage[name] = {
      exists: t.exists,
      fileCount: t.fileCount,
      bytes: t.bytes,
      dirCount: t.dirCount,
      skippedLinks: t.skipped.length,
      mountPoints: t.mounts.map((m) => m.path),
    };
  }
  const storageTotals = Object.values(storage).reduce(
    (a, s) => ({ fileCount: a.fileCount + (s.fileCount ?? 0), bytes: a.bytes + (s.bytes ?? 0), dirCount: a.dirCount + (s.dirCount ?? 0) }),
    { fileCount: 0, bytes: 0, dirCount: 0 },
  );

  const run = {
    runId,
    at: now,
    durationMs: Date.now() - t0,
    device: deviceName(),
    dshRoot,
    readOnly: true,
    audit: {
      version: audit.version,
      checkpoints: audit.checkpoints.total,
      produced: audit.checkpoints.produced,
      missingCheckpoints: audit.checkpoints.missing,
      summary: audit.summary,
      samples: audit.samples,
      // 明细进报告/面板（P2 取舍：不进告警计数，见 P2_EVENTS_POLICY）
      findings: audit.checks.map((c) => ({ id: c.id, level: c.level, message: c.message })),
      whitelist: audit.rootWhitelist,
      policy: audit.policy,
      rootJunctions: audit.rootJunctions,
    },
    tmp: {
      exists: tmp.exists,
      fileCount: tmp.fileCount,
      bytes: tmp.bytes,
      dirCount: tmp.dirCount,
      skippedLinks: tmp.skipped.length,
      warnFiles: 200,
      warnBytes: 200 * 1024 * 1024,
      overThreshold: tmp.fileCount > 200 || tmp.bytes > 200 * 1024 * 1024,
      mountPoints: tmp.mounts.map((m) => m.path),
    },
    // A1（B4）：另外四个挂载点目录独立成键（同款结构）+ 一份合计（趋势用）
    ...storage,
    storageTotals,
    archive: {
      dirs: naming.dirs,
      looseFiles: naming.looseFiles,
      sampled: naming.sampled.length,
      noncompliant: naming.bad,
      compliant: naming.sampled.length - naming.bad,
      legacyNoncompliant: naming.legacyBad,
      policy: naming.policyInfo ?? null,
      note: '[11a] 起按策略文件判定（10 种形态 + 结构性例外 + 常驻资产白名单）；legacyNoncompliant = 旧正则（规范原文）同口径误报数',
    },
    gate: {
      ...l2,
      autonomySource: autonomy.source,
      autonomyReason: autonomy.reason,
      autonomyFile: autonomy.file,
      p2Events: P2_EVENTS_POLICY,
    },
    /** 【2026-10-14 · 封口① J L478】README 自动生成结果（`ensureReadme` 未开时为 null）。
     *  `action` ∈ created/refreshed/would-create/would-refresh/skipped/failed；`reason` = 触发判据。 */
    readmeGen: audit.readmeEnsure ?? null,
    // 跨线判定（③-2）：由采集器的让路闸传入（clear 才可能走到这里）；直接调用者为 null
    lane: opts.lane && typeof opts.lane === 'object' ? opts.lane : null,
  };

  if (opts.dryRun !== true) {
    updateStateJson(STATE_NAME, tidyStatePath(home), (cur) => applyRun(cur, run), {
      schemaVersion: STATE_SCHEMA,
      defaultValue: emptyTidyState(),
      home,
    });
  }
  return { ok: true, run, stateFile: tidyStatePath(home), dryRun: opts.dryRun === true };
}

// ─────────────────────────────────────────────────────── P8 [12] · L2「observe 档」采集器

/** observe 档采集器 id（锁名 = `tidy-observe`，与审计采集器各自独立失败）。 */
export const OBSERVE_COLLECTOR_ID = 'observe';
export const OBSERVE_SCHEMA = 1;
/** observe 历史保留条数（状态文件别无限长）。 */
export const OBSERVE_HISTORY_CAP = 30;

/**
 * 纯函数：把一轮 observe 结果并进状态（不碰磁盘）。
 * **只写"若开启会搬什么"** —— observe 档的硬边界：不建桶、不写 manifest、不动文件。
 */
export function applyObserve(cur, rec) {
  const base = cur && typeof cur === 'object' ? cur : emptyTidyState();
  const row = {
    at: rec.at,
    device: rec.device,
    candidates: rec.counters?.candidates ?? 0,
    passedActive: rec.counters?.passedActive ?? 0,
    planned: rec.counters?.planned ?? 0,
    batched: rec.counters?.batched ?? 0,
    skipped: rec.counters?.skipped ?? 0,
    bytes: rec.counters?.bytes ?? 0,
    gateAllowed: rec.gate?.allowed === true,
    elapsedMs: rec.elapsedMs ?? 0,
  };
  return {
    ...base,
    schemaVersion: STATE_SCHEMA,
    product: 'dsh-butler',
    component: COMPONENT,
    version: VERSION,
    updatedAt: new Date(rec.atMs ?? Date.now()).toISOString(),
    device: rec.device ?? base.device ?? null,
    observe: {
      schemaVersion: OBSERVE_SCHEMA,
      at: rec.at,
      mode: 'observe',
      device: rec.device,
      dshRoot: rec.dshRoot,
      limit: rec.limit,
      gate: rec.gate,
      counters: rec.counters,
      buckets: rec.buckets,                       // 桶名（**只是名字**：observe 不建桶）
      wouldMove: rec.wouldMove,                   // 本批"若开启会搬"的清单
      deferredCount: rec.deferredCount,
      skippedByStage: rec.skippedByStage,
      refcheck: rec.refcheck,
      board: rec.board,
      runtime: rec.runtime ?? null,
      describe: rec.describe,
      elapsedMs: rec.elapsedMs,
      sideEffects: 'none',
    },
    observeHistory: [...(base.observeHistory ?? []), row].slice(-OBSERVE_HISTORY_CAP),
  };
}

/**
 * 跑一轮 **observe 档**（零副作用）。
 *
 * 硬边界（本卡 P1 期生产只跑这一档）：
 *   ✅ 读候选 / 跑两道闸 / 出"若开启会搬什么"清单 / 写**自己的状态文件**
 *   ❌ 不建桶、不写 manifest、不改名/搬移/删除任何文件、不动任何开关
 * ⚠️ 与审计采集器一样，**跨线让路闸在采集器的 run() 里**（本函数可被测试/CLI 直接调）。
 * @param {{home?:string, dshRoot?:string, now?:number, runId?:string, dryRun?:boolean, limit?:number,
 *          runtimeScan?:boolean, boardUrl?:string, fetchImpl?:Function, corpus?:object}} [opts]
 */
export async function runTidyObserve(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const t0 = Date.now();
  const gate = gateComponent(COMPONENT, VERSION, { home });
  if (!gate.run) return { ok: false, skipped: 'version-gate', gate };

  const plan = await planTidyMove({
    home, dshRoot, now, mode: 'observe', limit: opts.limit,
    runtimeScan: opts.runtimeScan === true, boardUrl: opts.boardUrl, fetchImpl: opts.fetchImpl,
    corpus: opts.corpus,
  });

  const skippedByStage = {};
  for (const s of plan.skipped) skippedByStage[s.stage] = (skippedByStage[s.stage] ?? 0) + 1;

  const rec = {
    at: new Date(now).toISOString(),
    atMs: now,
    device: plan.device,
    dshRoot,
    limit: plan.limit,
    gate: plan.gate,
    counters: plan.counters,
    buckets: [bucketName(now, plan.deviceCode)],
    wouldMove: plan.batch.map((b) => ({
      relName: b.relName, isDir: b.isDir, sizeBytes: b.sizeBytes, fileCount: b.fileCount,
      mtime: new Date(b.mtimeMs).toISOString(),
    })),
    deferredCount: plan.deferred.length,
    skippedByStage,
    refcheck: { summary: plan.refcheck.summary, corpus: plan.refcheck.corpus, elapsedMs: plan.refcheck.elapsedMs },
    board: plan.board,
    runtime: plan.runtime
      ? { sessions: plan.runtime.sessions.hitNames, sessionsQualified: plan.runtime.sessions.qualifiedNames, board: plan.runtime.board.hitNames, boardError: plan.runtime.board.error }
      : null,
    describe: describePlan(plan),
    elapsedMs: Date.now() - t0,
    /** observe 档的硬边界声明（**零副作用**）：调用方/面板/单测据此判别"这只是观察，不是动作"。 */
    sideEffects: 'none',
  };

  if (opts.dryRun !== true) {
    updateStateJson(STATE_NAME, tidyStatePath(home), (cur) => applyObserve(cur, rec), {
      schemaVersion: STATE_SCHEMA,
      defaultValue: emptyTidyState(),
      home,
    });
  }
  return { ok: true, observe: rec, plan, stateFile: tidyStatePath(home), dryRun: opts.dryRun === true };
}

/**
 * 建调度器并注册采集器（独立失败隔离靠 butler-scheduler，别在采集器里自己 catch）。
 *
 * 注册两个采集器（**各自抢各自的 tick 锁，独立失败隔离**）：
 *   · `audit`   = P8-A 只读审计（卡 [10] 交付，12h —— 2026-09-29 主人令由 6h 改）
 *   · `observe` = P8 [12] L2 **观察档**（本卡 P1 期交付，12h —— 同批改）—— 只报"若开启会搬什么"，零副作用
 *
 * ③-2 让路闸（方案 §3.3 C-3）挂在两个采集器 `run()` 的**最前面**：
 *   判定非 clear ⇒ **整轮跳过**（不跑审计 / 不写审计行 / 不产报告），只在状态文件记 `lane` 段。
 *   让路的"判据不可用"档**必须报警**（方案 §7.1 ③：既不能让审计跑一半，也不能静默断档）。
 *   ⚠️ 状态码语义：让路 = **deliberate skip**（`ok:true` + detail.skipped），**不是 error** ——
 *     否则每次交接窗口都会把 tick 记为失败（`failed>0` + exit 1），把"让路"变成"故障"。
 */
export function createTidyScheduler(opts = {}) {
  const home = opts.home ?? dshHome();
  // 【2026-10-14 · 封口① J L478】README 自动生成开关（**缺省关** —— 库调用方【测试/验收】一律不写盘）。
  //   生产自动入口 = `butler-tidy-tick.mjs` 的 **CLI 分支**（tickd job `tidy` 就是 spawn 这个 CLI，无参数）
  //   ⇒ CLI 缺省**开**、`--no-readme-gen` 关回。这样"默认自动"与"测试不污染生产 `_archive`"两不误。
  const readmeGen = opts.readmeGen === true;
  const sch = createScheduler({ name: TICK_NAME, home, logger: opts.logger });
  sch.register({
    id: COLLECTOR_ID,
    label: 'P8 收纳审计（只读）',
    intervalMs: INTERVAL_MS,
    ttlMs: 10 * 60_000,
    run: async (ctx) => {
      // ── 跨线让路闸（③-2）：进采集器第一件事，判窗口而不是抢锁（只读采集不抢 handoff 锁）
      const t0Lane = Date.now();
      const judged = await judgeTidyLane({ home: ctx.home, now: ctx.now });
      const lane = judged.lane;
      if (!lane || lane.verdict !== 'clear') {
        const skipRec = buildSkipRecord(lane, {
          now: ctx.now, runId: ctx.runId, durationMs: Date.now() - t0Lane,
        });
        let persisted = null;
        if (opts.dryRun !== true) {
          try { persisted = recordLane(ctx.home, skipRec); }
          catch (e) {
            ctx.alert({ level: 'warn', message: `让路记录写不进状态文件（${e?.message ?? e}）→ 本轮仍跳过（宁缺不脏）`, detail: { skipped: skipRec.skipped } });
          }
        }
        if (skipRec.skipped === LANE_SKIP.JUDGE_UNAVAILABLE) {
          ctx.alert({
            level: 'warn',
            message: `跨线判据不可用 → 本轮整轮让路（不跑审计）：${lane.summary ?? '?'}`,
            detail: { error: judged.error ?? null, reasons: lane.reasons ?? [], home: ctx.home },
          });
        }
        const detailSkip = persisted?.lane
          ? { ...skipRec, streak: persisted.lane.streak, since: persisted.lane.since }
          : skipRec;
        ctx.log(`跨线让路：skipped=${skipRec.skipped} owner=${skipRec.owner ?? '-'} · ${lane.summary ?? ''}`);
        // ⚠️ 这里**不调 ctx.audit**（方案 §3.3：让路不写审计行 —— 可见性靠状态文件 + 日报跨线段）
        return { ok: true, detail: { skipped: detailSkip, lane, run: null } };
      }

      const r = await runTidyAudit({
        home: ctx.home, now: ctx.now, runId: ctx.runId, dryRun: opts.dryRun === true,
        dshRoot: opts.dshRoot, docsSample: opts.docsSample, lane,
        // 【2026-10-14 · 封口① J L478】README 生成侧开关（缺省关；CLI 入口缺省开，见本文件 CLI 段）
        ensureReadme: readmeGen, readmeMinAgeDays: opts.readmeMinAgeDays,
      });
      if (r.ok === false) return { ok: false, error: r.skipped ?? 'tidy-audit-skipped' };
      // 审计流水（§6 护栏：每动作一行）——不是 P2 事件，不进告警计数
      ctx.audit({
        type: 'tidy-audit',
        device: r.run.device,
        checkpoints: r.run.audit.checkpoints,
        produced: r.run.audit.produced,
        summary: r.run.audit.summary,
        tmpFiles: r.run.tmp.fileCount,
        tmpBytes: r.run.tmp.bytes,
        l2Allowed: r.run.gate.l2Allowed,
        phase: r.run.gate.phase,
        dryRun: r.dryRun === true,
        lane: 'clear',
        // 【2026-10-14】README 生成结果（只在开启开关时非 null；流水里可查"这轮到底生成了没、为什么"）
        readmeGen: r.run.readmeGen ? { action: r.run.readmeGen.action, reason: r.run.readmeGen.reason, bytes: r.run.readmeGen.bytes } : null,
      });
      if (r.run.readmeGen) ctx.log(`README 自动生成：${r.run.readmeGen.describe ?? r.run.readmeGen.action}`);
      return { ok: true, detail: { run: r.run } };
    },
  });

  // ── 采集器 2：P8 [12] L2 **观察档**（零副作用；本卡 P1 期生产只跑这一档）──────────
  // 为什么单独一个采集器而不是塞进 `audit`：
  //   · 观测对象不同（审计 = `_archive` 命名/散落文件；observe = `_tmp` 搬移候选）；
  //   · 失败隔离（observe 慢/挂不会拖累审计采集器）；
  //   · 关掉一个不影响另一个（调度器逐采集器独立拉锁）。
  if (opts.observe === false) return sch;
  sch.register({
    id: OBSERVE_COLLECTOR_ID,
    label: 'P8 L2 观察档（只报"若开启会搬什么"，零副作用）',
    intervalMs: INTERVAL_MS,
    ttlMs: 10 * 60_000,
    run: async (ctx) => {
      // 与审计采集器同一道跨线让路闸（写动作必须抢 handoff 锁；只读观察档仍按窗口让路，
      //   理由同审计：半截 `_tmp` 统计会产出**假清单**）
      const t0Lane = Date.now();
      const judged = await judgeTidyLane({ home: ctx.home, now: ctx.now });
      const lane = judged.lane;
      if (!lane || lane.verdict !== 'clear') {
        const skipRec = buildSkipRecord(lane, { now: ctx.now, runId: ctx.runId, durationMs: Date.now() - t0Lane });
        if (opts.dryRun !== true) {
          try { recordLane(ctx.home, skipRec); }
          catch (e) { ctx.alert({ level: 'warn', message: `observe 让路记录写不进状态文件（${e?.message ?? e}）→ 本轮仍跳过`, detail: { skipped: skipRec.skipped } }); }
        }
        if (skipRec.skipped === LANE_SKIP.JUDGE_UNAVAILABLE) {
          ctx.alert({ level: 'warn', message: `跨线判据不可用 → observe 档本轮让路：${lane.summary ?? '?'}`, detail: { error: judged.error ?? null } });
        }
        ctx.log(`observe 跨线让路：skipped=${skipRec.skipped} owner=${skipRec.owner ?? '-'}`);
        return { ok: true, detail: { skipped: skipRec, lane, observe: null } };
      }

      const r = await runTidyObserve({
        home: ctx.home, now: ctx.now, runId: ctx.runId, dryRun: opts.dryRun === true,
        dshRoot: opts.dshRoot, limit: opts.limit, corpus: opts.corpus,
      });
      if (r.ok === false) return { ok: false, error: r.skipped ?? 'tidy-observe-skipped' };
      const o = r.observe;
      // 审计流水：observe **不是动作**（零副作用），所以只记一行"观察结论"，不写 tidy-move-apply
      ctx.audit({
        type: 'tidy-observe',
        device: o.device,
        candidates: o.counters.candidates,
        batched: o.counters.batched,
        planned: o.counters.planned,
        gateAllowed: o.gate.allowed === true,
        dryRun: r.dryRun === true,
        sideEffects: 'none',
        lane: 'clear',
      });
      ctx.log(`${o.describe} · 闸门=${o.gate.allowed ? '放行' : '停'}（零副作用）`);
      return { ok: true, detail: { observe: o, plan: r.plan } };
    },
  });
  return sch;
}

// ------------------------------------------------------------------ CLI
const isMainEntry = (() => {
  const a = process.argv[1];
  if (!a) return false;
  try { return fs.realpathSync(a) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMainEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
  const dryRun = argv.includes('--dry-run');
  const asJson = argv.includes('--json');
  // 【2026-10-14 · 封口① J L478】CLI 入口 = 生产自动入口（tickd job `tidy` 无参数 spawn 本脚本）
  //   ⇒ **缺省开** README 自动生成；`--no-readme-gen` 关回。库调用（createTidyScheduler 直调）缺省关。
  const readmeGen = !argv.includes('--no-readme-gen');
  const minAgeArg = argv.indexOf('--readme-min-age-days');
  const readmeMinAgeDays = minAgeArg >= 0 ? Number(argv[minAgeArg + 1]) : undefined;
  const home = dshHome();
  const sch = createTidyScheduler({
    home, dryRun, readmeGen,
    readmeMinAgeDays: Number.isFinite(readmeMinAgeDays) ? readmeMinAgeDays : undefined,
    logger: asJson ? () => {} : (m) => console.log(`[tidy] ${m}`),
  });
  const out = await sch.tickOnce({ force: true });
  const rec = out.results.find((r) => r.id === COLLECTOR_ID) ?? null;
  const run = rec?.detail?.run ?? null;
  const skip = rec?.detail?.skipped ?? null;
  const orec = out.results.find((r) => r.id === OBSERVE_COLLECTOR_ID) ?? null;
  const obs = orec?.detail?.observe ?? null;
  if (asJson) {
    console.log(JSON.stringify({ tick: out, record: rec, run, skipped: skip, observeRecord: orec, observe: obs }, null, 2));
  } else if (skip) {
    console.log(`[tidy] 跨线让路（方案 §3.3 C-3）：skipped=${skip.skipped} · owner=${skip.owner ?? '-'}`
      + `${skip.judgeUnavailable ? ' · **判据不可用**（已报警）' : ''}`);
    console.log(`[tidy] 本轮整轮跳过：不跑审计、不写审计行、不产报告（半截统计会产假告警 ⇒ 宁缺不脏）`);
    console.log(`[tidy] 连续让路 ${skip.streak ?? 1} 轮${skip.since ? `（自 ${skip.since}）` : ''} · 6h 后下一轮照跑`
      + `${skip.evidence?.handoff?.reason ? ` · 交接窗口：${skip.evidence.handoff.reason}` : ''}`
      + `${skip.evidence?.upgrade?.summary ? ` · 升级锁：${skip.evidence.upgrade.summary}` : ''}`);
    console.log(`[tidy] 状态文件 → ${tidyStatePath(home)}${dryRun ? '（dry-run 未写）' : ''}`);
  } else if (!run) {
    console.log(`[tidy] 未产出结果：status=${rec?.status ?? '?'}${rec?.reason ? ` (${rec.reason})` : ''}${rec?.error ? ` error=${rec.error}` : ''}`);
  } else {
    const s = run.audit.summary;
    console.log(`[tidy] runId=${run.runId} device=${run.device} ${dryRun ? '(dry-run) ' : ''}${run.durationMs}ms`);
    console.log(`[tidy] 检查点 ${run.audit.checkpoints}/${AUDIT_CHECKPOINT_IDS.length} · 产出 ${run.audit.produced} 行（⛔${s.block} 🟡${s.warn} ✅${s.ok}）`
      + (run.audit.missingCheckpoints.length ? ` · 未产出行：${run.audit.missingCheckpoints.join(',')}` : ''));
    console.log(`[tidy] _tmp ${run.tmp.fileCount} 文件 / ${(run.tmp.bytes / 1048576).toFixed(1)}MB（阈值 ${run.tmp.warnFiles}/${run.tmp.warnBytes / 1048576}MB，超限=${run.tmp.overThreshold ? '是' : '否'}）`
      + (run.tmp.skippedLinks ? ` · 跳过内容 reparse point ${run.tmp.skippedLinks} 个` : ''));
    console.log(`[tidy] _archive 顶层 ${run.archive.dirs} 目录 + ${run.archive.looseFiles} 散落文件 · 命名采样不合规 ${run.archive.noncompliant}/${run.archive.sampled}`);
    // A1（B4）：另外四个挂载点目录（generated/logs/backups/snapshots）
    if (run.storageTotals) {
      const parts = STORAGE_DIRS.map((d) => `${d} ${run[d]?.fileCount ?? '?'}文件/${((run[d]?.bytes ?? 0) / 1048576).toFixed(1)}MB`);
      console.log(`[tidy] 另四目录（A1）：${parts.join(' · ')}`
        + ` ⇒ 合计 ${run.storageTotals.fileCount} 文件 / ${(run.storageTotals.bytes / 1048576).toFixed(1)}MB`);
    }
    console.log(`[tidy] 降档态 phase=${run.gate.phase}（**历史标记，不参与判定**）· L2 闸门 = ${run.gate.l2Allowed ? '放行' : '停'}（${run.gate.reason}）· 白名单来源 ${run.audit.whitelist.source}`);
    if (run.readmeGen) console.log(`[tidy] 📄 ${run.readmeGen.describe ?? `README 自动生成：${run.readmeGen.action}`}`);
    console.log(`[tidy] 状态文件 → ${tidyStatePath(home)}${dryRun ? '（dry-run 未写）' : ''}`);
  }
  // ── P8 [12] observe 档（零副作用）结果
  if (!asJson) {
    if (obs) {
      console.log(`[tidy] L2 观察档（零副作用）：${obs.describe}`);
      console.log(`[tidy]   自治闸 = ${obs.gate.allowed ? '🟢 放行' : `🔴 停（${obs.gate.reason}）`}`);
      console.log(`[tidy]   桶名（**只是名字，本轮不建**）：_archive\\${obs.buckets?.[0] ?? '?'}`);
      console.log(`[tidy]   跳过按阶段：${JSON.stringify(obs.skippedByStage)}`);
      for (const w of (obs.wouldMove ?? []).slice(0, 8)) console.log(`[tidy]     · ${w.relName}${w.isDir ? ` [目录 ${w.fileCount} 文件]` : ''}`);
      if ((obs.wouldMove?.length ?? 0) > 8) console.log(`[tidy]     …（另 ${obs.wouldMove.length - 8} 条）`);
    } else if (orec?.detail?.skipped) {
      console.log(`[tidy] L2 观察档让路：skipped=${orec.detail.skipped.skipped}`);
    } else if (orec) {
      console.log(`[tidy] L2 观察档未产出结果：status=${orec.status}${orec.error ? ` error=${orec.error}` : ''}`);
    }
  }
  process.exitCode = out.failed > 0 ? 1 : 0;
}
