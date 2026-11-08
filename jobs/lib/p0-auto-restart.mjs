// dsh-butler / lib/p0-auto-restart.mjs —— P0 低水位自动重启（L2 模块 `p0-auto-restart` 的执行体）
//
// 由来：`docs\管家-开关矩阵与放行判据-20260913.md` §3.1 待实现动作清单（卡：V3 全量开发 批次 4）。
//   规则 R2「锁后交付」：代码进生产 + 开关默认关 + 单测/夹具 + dry-run 可跑 + 生产零动作强断言 + 回滚点 + 演练 + 登记 + 流水。
//
// 【动作语义（照矩阵 §3 表，不自创）】
//   矩阵 §3 表该行：`p0-auto-restart` = 「P0 低水位自动重启（无主人请求时）」，护栏 = 「闸门排队 + 不打断在跑卡」。
//   落地成一句话：**当"存在待重启事由"且"此刻是低水位（活跃集合为空）"时，自动发一条重启请求进既有 P0 闸门。**
//     · 判定口径**全部复用** `lib/restart.mjs` + `restart-coordinator.mjs` 的既有函数（见下方"边界①"），不另写第二套
//     · 活跃集合非空 → `defer`（**绝不发起**）："闸门排队不打断"由既有请求方承担，自动来源不在有人跑时添乱
//     · 既有请求已 pending/executing、或维护窗口活跃 → `skip`（不重复发起，避免幽灵重启）
//     · 无事由 → `idle`（**低水位本身不是重启理由**；没有事由时空跑 = 幽灵重启）
//     · 24h 去重（按事由签名）+ 单日上限 + token 预算门（后两条由 runAction 既有护栏承担）
//
// 【边界（改本文件前必读）】
//   ① 判定口径一律复用既有函数，**不复制**：
//        - `restart-coordinator.collectSessions()` → 内部用 `lib/restart.mjs` 的 `classifyTail` / `isSessionActive`（文件判据）
//        - `restart-coordinator.readBoardCardSessions()` → 内部用 `extractRunningCardSessions`（看板 running 卡判据）
//        - `lib/restart.mjs` 的 `mergeActiveSources()`（三源并集：文件 ∪ 主包 running ∪ 看板 running 卡）
//        - `lib/restart.mjs` 的 `planRestart()`（内部再调 `mergeBatch`）与 `buildInterruptionList()`（会打断谁）
//   ② 本文件只做"低水位判定 + 发起一条自动重启请求"：**不重启任何进程、不杀任何进程、不调任何重启脚本、**
//      **不拉守护鱼、不写维护窗口、不结算请求** —— 那些是 restart-coordinator（既有 P0 闸门）的职责。
//      本文件**不含任何子进程调用或子进程模块引用**；唯一的子进程调用在 `lib/p0-restart-channel.mjs`（见该文件头注释）。
//   ③ 所有执行走 `lib/autonomy-actions.mjs` 的 `runAction()` **唯一闸门**：dry-run 永远可跑（只算不动）；
//      `dryRun:false` 时四门任一关 → `blocked` 且零副作用（不写记账、不占额度、不发请求）。
//
// 【闸门（三道串联，fail-safe 方向更严）】
//   · 模块级：`checkModuleAllowed('p0-auto-restart')` = L0 降档 × L1 owner × L2 `modules['p0-auto-restart']`
//   · 动作级：`runAction({kind:'p0-auto-restart'})` 内置 p3-auto 总闸 + 24h 去重 + 单日上限 + token 预算门
//   · 通道级：调用前 `autoAllowed('p0-auto-restart')` 预检 + `request-restart.mjs --as-auto` 内部闸门（exit 2）
//
// ⚠️ 【L1 归属的已知不一致 —— 本卡**只报告不修改**（改开关归属属放行面，须主人拍板）】
//     矩阵 §3 表该行「归属 L1 总开关」列写 `p0AutoRestartEnabled`；`lib/autonomy-modules.mjs:59` 的 `owner` 写 `p3AutoEnabled`；
//     而 `lib/autonomy.mjs:27/65` 的真实口径是**两把键与**（`p3AutoEnabled && p0AutoRestartEnabled`）。
//     ⇒ `checkModuleAllowed()` 只读 `owner` 一把键 ⇒ 漏了 raw 键（2026-09-13 实测：拒动原因串里只有 `p3AutoEnabled=false`）。
//     本文件**按现状调用**（不复刻第二套、不擅自改归属）；实测结论与建议见本卡交付报告「验收 6」。
//
// 【本卡红线（2026-09-13 批次 4）】**不接线到 tick**：`butler-tickd.mjs` 一行不动、
//   `restart-coordinator.mjs` / `request-restart.mjs` / `lib/restart.mjs` 一行不动；
//   本文件只交付"实现 + dry-run 路径 + 单测"，四门全关时不得发生任何真实动作（单测夹具强断言）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { checkModuleAllowed } from '../../src/dsh-butler/lib/autonomy-modules.mjs';
import { autoAllowed } from '../../src/dsh-butler/lib/autonomy.mjs';
import {
  runAction, checkDailyLimit, checkSignature, readActionsState, readLimits, localDay, sigKeyOf,
} from '../../src/dsh-butler/lib/autonomy-actions.mjs';
import {
  DEFAULT_POLICY, mergeActiveSources, planRestart, buildInterruptionList, maintenancePhase, readMaintenanceWindow,
} from '../../src/dsh-butler/lib/restart.mjs';
import { collectSessions, readBoardCardSessions, readRequests } from '../restart-coordinator.mjs';
import { readSessions } from '../../src/dsh-butler/lib/queue-watch.mjs';
import { requestRestartViaCli, DEFAULT_ACTOR, DEFAULT_TIMEOUT_MS } from './p0-restart-channel.mjs';
// P9 H4（2026-09-28）：交接窗口判据与协调器同源（交接锁 + TTL + 持有者活性）
import { restartGuard } from '../../src/dsh-butler/lib/handoff-version-gate.mjs';

// ⚠️ 版本号与底座自检的关系：`verify.mjs` 要求"登记表里所有组件版本 == 产品版本"，
//    故本模块**不单独 bump**（同 lib/restart.mjs 的口径）；本卡交付靠注释 + 变更流水 + 交付报告追溯。

/** 动作 kind（与 `AUTO_ACTION_KINDS` 的键同名；L2 模块 id 亦同名 —— 矩阵 §3 列口径要求"同名才能对齐开关"）。 */
export const RESTART_KIND = 'p0-auto-restart';
/** 风险级（矩阵 §3 表：L2 = 有损可回滚；重启会打断在跑会话，但可一键恢复/重启后会话可续）。 */
export const RESTART_LEVEL = 'L2';
/** 目标档（矩阵 §3 表）——只作展示与放行判据的记录，不参与运行时判定。 */
export const RESTART_TARGET_STAGE = 'S3';
/** 自动来源的默认发起组件名。 */
export const AUTO_ACTOR = DEFAULT_ACTOR;
/** 计划条目判定值（预览里可见）。 */
export const DECISIONS = ['idle', 'defer', 'ready', 'skip'];

/** 仅在调用方未传 limits 时用的兜底值（与 lib/autonomy-actions.mjs 的 defaultLimits() 同口径）。 */
export const FALLBACK_MAX_PER_DAY = 5;
/** 预览里最多列几个"会被打断的会话"。 */
export const PREVIEW_MAX_ACTIVE = 8;
/** 预览里最多列几条事由。 */
export const PREVIEW_MAX_INTENTS = 8;

export const DEFAULT_BASE_URL = 'http://localhost:3080';

/** 判定 reason → 人话（预览里可见；**只做翻译，不改判定**）。 */
export const NOTE_BY_REASON = {
  'no-intent': '本轮没有待重启事由（低水位本身不是重启理由）→ 不发起',
  'not-low-watermark': '非低水位（有会话在跑）→ 不打断，等下轮',
  'request-pending': '既有重启请求待处理（闸门已在管）→ 不重复发起',
  'restart-in-flight': '维护窗口活跃（重启进行中）→ 不动',
  'daily-limit': '单日上限已用尽 → 不发起',
  dedup: '24h 内已因同一事由发起过 → 去重跳过',
  'low-watermark-zero': '低水位达成 + 有事由 → 可发起重启请求',
  'collect-failed': '采集失败 → 本轮不规划（fail-closed）',
  // P9 H4（2026-09-28）：交接窗口内一律回 busy（§17.1 T2「RestartTick 在交接窗口内必须回 busy」）
  'handoff-window': '交接进行中（交接器持有 tick-handoff.lock）→ 不发起重启请求，回 busy',
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 事由归一化（纯）：`{id?, reason, actor?, at?}` → 稳定结构；id 缺失时用 reason 当兜底标识（去重签名要稳定）。 */
export function normIntents(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const raw of list) {
    if (raw === null || raw === undefined) continue;
    const it = typeof raw === 'string' ? { reason: raw } : (typeof raw === 'object' ? raw : null);
    if (!it) continue;
    const reason = String(it.reason ?? it.text ?? '').trim();
    if (!reason) continue;
    const id = String(it.id ?? it.key ?? reason).trim().slice(0, 120);
    out.push({
      id,
      reason: reason.slice(0, 200),
      actor: it.actor ? String(it.actor).slice(0, 80) : null,
      at: Number(it.at ?? 0) || null,
    });
  }
  return out;
}

/** 事由集合 → 去重签名（同一批事由 = 同一签名；换了一批 = 归零重算）。 */
export function intentSigKey(intents) {
  const ids = normIntents(intents).map((i) => i.id).sort();
  return sigKeyOf(RESTART_KIND, 'intent', ids.join(',') || 'none');
}

// ---------------------------------------------------------------- 只读采集（复用既有判据）

/** 主包会话视图取数（标题 + running 权威标志）——**只取数，判据不在这里**。 */
async function readSessionViews(opts = {}) {
  if (opts.views) return opts.views;
  const r = await readSessions({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  if (!r.ok) return { ok: false, error: r.error, titles: new Map(), runningIds: new Set(), listedIds: new Set(), items: [] };
  const titles = new Map();
  const runningIds = new Set();
  const listedIds = new Set();
  for (const it of r.items) {
    if (it.sessionId) listedIds.add(it.sessionId);
    if (it.title) titles.set(it.sessionId, it.title);
    if (it.running === true) runningIds.add(it.sessionId);
  }
  return { ok: true, error: null, titles, runningIds, listedIds, items: r.items };
}

/**
 * 只读采集低水位现场（**零副作用**：只读文件 + 只发只读请求，不写任何状态）。
 *
 * fail-closed 取舍：主包会话视图不可用（DSH 没跑 / RPC 失败）→ `ok:false`，本轮不规划任何重启。
 *   理由：`running` 是**权威**活跃标志，缺了它就可能把"正在跑"误判成低水位 → 误发起重启。
 *   （dsh 真挂掉的场景由守护鱼/开机链路负责，不是本动作的职责。）
 * @returns {Promise<{ok:boolean, error:string|null, home:string, now:number, policy:object,
 *                    views:object|null, rows:Array, scanned:number, active:Array, merged:object|null,
 *                    cardSessions:object|null, requests:Array, liveRequests:Array,
 *                    window:object|null, phase:object|null, intents:Array}>}
 */
export async function scanLowWater(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const base = {
    ok: false, error: null, home, now, policy,
    views: null, rows: [], scanned: 0, active: [], merged: null, cardSessions: null,
    requests: [], liveRequests: [], window: null, phase: null, intents: normIntents(opts.intents),
  };

  // ① 主包会话视图（HTTP 取数）
  const views = opts.views ?? await readSessionViews(opts);
  if (!views.ok) {
    return { ...base, views, error: `会话视图不可用（${views.error ?? 'unknown'}）→ 本轮不规划（漏判活跃会误判低水位）` };
  }

  // ② 会话文件判据（复用 coordinator.collectSessions → classifyTail/isSessionActive）
  const rows = Array.isArray(opts.sessionRows)
    ? opts.sessionRows
    : collectSessions({ home, now, policy, titles: views.titles });

  // ③ 看板 running 卡判据（复用 coordinator.readBoardCardSessions → extractRunningCardSessions）
  const board = opts.cardSessionIds instanceof Map
    ? { ok: true, map: opts.cardSessionIds }
    : readBoardCardSessions({ home });

  // ④ 三源并集（复用 lib/restart.mjs 判据；**不另写第二套**）
  const merged = mergeActiveSources(rows, {
    runningIds: views.runningIds, listedSessionIds: views.listedIds, sessionListKnown: views.ok === true,
    cardSessionIds: board.map ?? new Map(), now, policy,
  });

  // ⑤ 请求队列 + 维护窗口（只读）
  const requests = Array.isArray(opts.requests) ? opts.requests : (readRequests(undefined, { home })?.requests ?? []);
  const window = opts.window !== undefined ? opts.window : readMaintenanceWindow({ home });
  const phase = maintenancePhase(window, { now });

  return {
    ...base,
    ok: true, error: null,
    views, rows, scanned: rows.length, active: merged.active, merged,
    cardSessions: { ok: board.ok === true, count: board.map?.size ?? 0, error: board.error ?? null },
    requests,
    liveRequests: requests.filter((r) => r && (r.state === 'pending' || r.state === 'executing')),
    window, phase,
  };
}

// ---------------------------------------------------------------- 规划（纯函数）

/**
 * 规划一轮（**纯函数，零副作用**）：给定现场 → 决策。
 *
 * 决策树（顺序即优先级，全部只看传入数据）：
 *   1. 维护窗口活跃（pending/overdue）      → `skip` / `restart-in-flight`
 *   2. 已有 pending/executing 请求           → `skip` / `request-pending`
 *   3. 无事由                                → `idle` / `no-intent`
 *   4. 活跃集合非空                          → `defer` / `not-low-watermark`（**绝不打断**）
 *   5. 单日额度用尽（既有护栏同源判定）      → `skip` / `daily-limit`
 *   6. 24h 去重命中（同事由签名）            → `skip` / `dedup`
 *   7. 其余                                  → `ready` / `low-watermark-zero`（`wouldRequest=true`）
 *
 * 其间还复用 `planRestart()`（内部含 `mergeBatch`）产出「闸门视角」：既有请求会被判成
 * `none / queue / restart(低水位)`，用于预览里如实展示"协调器此刻会怎么做"。
 *
 * @returns {{kind:string, now:number, day:string, decision:string, reason:string, note:string,
 *            lowWatermark:boolean, wouldRequest:boolean,
 *            active:Array, activeCount:number, interruptions:Array, scanned:number,
 *            requests:object, gate:object, window:object, intents:Array,
 *            quota:object, limits:object, sigKey:string, request:object|null}}
 */
export function planAutoRestart(input = {}) {
  const now = num(input.now, Date.now());
  const policy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
  const limits = input.limits ?? {};
  const state = input.state ?? {};
  const rows = Array.isArray(input.sessions) ? input.sessions : [];
  const active = Array.isArray(input.active) ? input.active : rows.filter((s) => s?.active === true);
  const requests = Array.isArray(input.requests) ? input.requests : [];
  const win = input.window ?? null;
  // P9 H4：交接窗口事实（判据由调用方注入；未注入 = null = 不判，与改动前逐字节一致）
  const hw = input.handoffWindow ?? null;
  const intents = normIntents(input.intents);
  const maxPerDay = num(limits.maxAutoActionsPerDay, FALLBACK_MAX_PER_DAY);
  // 【施工卡 ⑥-3】分池：判自己的 kind 池 + 生态总闸（`pools` 未配置 ⇒ 与改动前逐字节一致）
  const daily = checkDailyLimit(state, localDay(now), maxPerDay, { kind: RESTART_KIND, pools: limits.pools });

  // ⚠️ 口径必须与 restart-coordinator.tick 一致：**只有 pending 才算"待执行"**
  //   （coordinator: `const live = all.filter((r) => r.state === 'pending')` → `planRestart({requests: live})`）。
  //   实测 2026-09-13（生产 restart-request.json）：该文件是**历史累积**文件（保留最近 50 条，实测 34 条全是 done，
  //   其中 3 条 force）——把整份历史一起喂给 planRestart，会把早已结束的 force 请求当成待执行，
  //   闸门视角被误判成 `restart(force-request)`（假"有人在等重启"信号）。故此处**先按 pending 过滤**。
  const pendingRequests = requests.filter((r) => r && r.state === 'pending');
  const liveRequests = requests.filter((r) => r && (r.state === 'pending' || r.state === 'executing'));
  const gate = planRestart({ requests: pendingRequests, sessions: rows, now, policy });
  const phase = maintenancePhase(win, { now });
  const sigKey = intentSigKey(intents);
  const dedup = intents.length
    ? checkSignature(state, sigKey, now, num(limits.dedupWindowMs, 24 * 3600 * 1000))
    : { dup: false, lastAt: null, ageMs: null, reason: 'no-intents' };

  const out = {
    kind: RESTART_KIND,
    now,
    day: localDay(now),
    decision: 'idle',
    reason: 'no-intent',
    note: '',
    lowWatermark: active.length === 0,
    wouldRequest: false,
    active: active.slice(0, PREVIEW_MAX_ACTIVE).map(slimSession),
    activeCount: active.length,
    interruptions: active.length ? buildInterruptionList(active, { now }).slice(0, PREVIEW_MAX_ACTIVE) : [],
    scanned: rows.length,
    requests: {
      total: requests.length,
      live: liveRequests.length,
      pending: pendingRequests.length,
      executing: requests.filter((r) => r?.state === 'executing').length,
      historical: requests.length - liveRequests.length,
      liveIds: liveRequests.map((r) => r.id ?? null),
    },
    gate: {
      action: gate.action, reason: gate.reason,
      batchId: gate.batch?.batchId ?? null, batchRequests: gate.batch?.requestIds?.length ?? 0,
      activeCount: gate.active?.length ?? 0, waitingMs: gate.waitingMs ?? 0,
      inFallbackWindow: gate.inFallbackWindow === true,
    },
    window: win ? { active: phase.phase !== 'none', phase: phase.phase, correlationId: win.correlationId ?? null, until: win.until ?? null, remainingMs: phase.remainingMs } : null,
    intents,
    quota: daily,
    limits: { maxAutoActionsPerDay: maxPerDay, dedupWindowMs: num(limits.dedupWindowMs, 24 * 3600 * 1000) },
    sigKey,
    request: null,
    // P9 H4：交接窗口事实（注入时可见；未注入 = null，行为与改动前一致）
    handoffWindow: hw ? { active: hw.active === true, reason: hw.reason ?? null, expiresInMs: hw.expiresInMs ?? null, source: hw.source ?? 'lock' } : null,
  };

  const decide = (decision, reason) => {
    out.decision = decision;
    out.reason = reason;
    out.note = NOTE_BY_REASON[reason] ?? reason;
    return out;
  };

  // P9 H4 · P0 闸门互斥（§17.1 T2）：**交接窗口内一律回 busy** —— 放在决策树第一条，
  //   与 restart-coordinator.tick 的 1.5 步（restartGuard）同源同判据（交接锁 + TTL）。
  //   为什么这条要在 auto 侧也判：否则"自动重启"通道会在窗口内记一笔"已发起"，而请求最终被
  //   协调器 busy 挡下 ⇒ 记账与事实不符（影子视图也会显示成"若此刻发起会…"）。
  //   输入由调用方注入（`handoffWindow`）；未注入 = 不判（与改动前逐字节一致，零行为变更）。
  if (hw && hw.active === true) return decide('skip', 'handoff-window');
  if (phase.phase === 'pending' || phase.phase === 'overdue') return decide('skip', 'restart-in-flight');
  if (liveRequests.length) return decide('skip', 'request-pending');
  if (!intents.length) return decide('idle', 'no-intent');
  // 活跃集合与"会被打断谁"**无论什么决策都填**（影子视图的价值就在这里：即便本轮不发，
  // 也要看得见"若此刻发起会打断谁"）—— 决策只决定 wouldRequest。
  if (active.length) return decide('defer', 'not-low-watermark');
  if (daily.reached) return decide('skip', 'daily-limit');
  if (dedup.dup) return decide('skip', 'dedup');

  out.wouldRequest = true;
  out.request = {
    actor: AUTO_ACTOR,
    reason: intents.map((i) => i.reason).join('；').slice(0, 200),
    mode: 'queue',
    requester: { kind: 'auto', actor: AUTO_ACTOR },
    intentIds: intents.map((i) => i.id),
    sigKey,
  };
  return decide('ready', 'low-watermark-zero');
}

/** 会话行瘦身（预览/记账用；必须可 JSON 化）。 */
function slimSession(s) {
  return {
    sessionId: s?.sessionId ?? null,
    title: s?.title ?? '',
    mark: s?.mark ?? null,
    activeSource: s?.activeSource ?? null,
    state: s?.state ?? null,
    ageMs: Number.isFinite(s?.ageMs) ? s.ageMs : null,
    tail: s?.tail ?? null,
  };
}

/** 精简直方记账体（**必须可 JSON 化**，不带 rows/views 等大对象）。 */
function slimPlan(plan) {
  return {
    decision: plan.decision, reason: plan.reason, lowWatermark: plan.lowWatermark,
    wouldRequest: plan.wouldRequest, activeCount: plan.activeCount, scanned: plan.scanned,
    requests: plan.requests, gate: plan.gate, window: plan.window,
    intents: plan.intents.slice(0, PREVIEW_MAX_INTENTS).map((i) => ({ id: i.id, reason: i.reason, actor: i.actor })),
    quota: plan.quota, sigKey: plan.sigKey, request: plan.request,
  };
}

/**
 * 预览形状（dry-run 的"将要做什么"）。
 * @returns {{action:string, at:number, day:string, decision:string, reason:string, note:string,
 *            lowWatermark:boolean, wouldRequest:boolean, activeCount:number, scanned:number,
 *            active:Array, interruptions:Array, truncated:number, requests:object, gate:object,
 *            window:object, intents:Array, quota:object, limits:object, request:object|null, note2:string}}
 */
export function restartPreview(plan, opts = {}) {
  const maxItems = opts.maxItems ?? PREVIEW_MAX_ACTIVE;
  const all = Array.isArray(plan?.interruptions) ? plan.interruptions : [];
  return {
    action: RESTART_KIND,
    at: opts.now ?? plan?.now ?? Date.now(),
    day: plan?.day ?? null,
    decision: plan?.decision ?? null,
    reason: plan?.reason ?? null,
    note: plan?.note ?? null,
    lowWatermark: plan?.lowWatermark === true,
    wouldRequest: plan?.wouldRequest === true,
    activeCount: plan?.activeCount ?? 0,
    scanned: plan?.scanned ?? 0,
    active: Array.isArray(plan?.active) ? plan.active.slice(0, maxItems) : [],
    interruptions: all.slice(0, maxItems),
    truncated: Math.max(0, all.length - maxItems),
    requests: plan?.requests ?? null,
    gate: plan?.gate ?? null,
    window: plan?.window ?? null,
    intents: Array.isArray(plan?.intents) ? plan.intents.slice(0, PREVIEW_MAX_INTENTS) : [],
    quota: plan?.quota ? { used: plan.quota.used, max: plan.quota.max, reached: plan.quota.reached } : null,
    limits: plan?.limits ?? null,
    request: plan?.request ?? null,
    note2: 'dry-run：只算不动 —— 以上为"若此刻放行会怎么做"；未产生任何真实重启请求、未改动任何开关',
  };
}

// ---------------------------------------------------------------- 动作入口（唯一闸门）

/**
 * 跑一轮「P0 低水位自动重启」动作。
 *
 * 三条路径（语义与 runAction 一致）：
 *   dryRun:true        → 永远可跑：只算不动，写一条 dry-run 影子记账（供影子视图/日报），**零请求**
 *   四门任一关          → status='blocked'，**零副作用**（不写记账、不占额度、不发请求）
 *   四门全开 + wouldRequest → 走 runAction（24h 去重 + 每日额度 + 预算门）→ execute 里调既有 --as-auto 通道
 *
 * @param {{
 *   home?:string, now?:number, dryRun?:boolean, baseUrl?:string, policy?:object, limits?:object,
 *   state?:object, scan?:object, plan?:object, autonomy?:object, intents?:Array,
 *   requests?:Array, window?:object|null, views?:object, sessionRows?:Array, cardSessionIds?:Map,
 *   fetchImpl?:Function, deps?:{requestRestart?:Function}, executeTimeoutMs?:number
 * }} spec
 */
export async function runAutoRestart(spec = {}, opts = {}) {
  const now = num(opts.now ?? spec.now, Date.now());
  const home = opts.home ?? spec.home ?? dshHome();
  const dryRun = spec.dryRun === true || opts.dryRun === true;
  const limits = spec.limits ?? readLimits({ home });
  const state = spec.state ?? readActionsState({ home });

  const out = {
    kind: RESTART_KIND, ok: true, dryRun, status: null, reason: null,
    home, now, day: localDay(now), moduleGate: null, channelGate: null, plan: null, action: null,
    requested: 0, failed: 0, blocked: 0, noop: 0, skipped: null, preview: null,
  };

  // 1) 只读采集（失败 → 本轮不规划，不写任何东西）
  const scan = spec.scan ?? await scanLowWater({
    home, now, policy: spec.policy, baseUrl: spec.baseUrl, fetchImpl: spec.fetchImpl,
    intents: spec.intents, requests: spec.requests, window: spec.window,
    views: spec.views, sessionRows: spec.sessionRows, cardSessionIds: spec.cardSessionIds,
  });
  if (!scan.ok) return { ...out, ok: false, status: 'collect-failed', reason: scan.error };

  // 2) 规划（纯函数，零副作用）
  // P9 H4（2026-09-28）：交接窗口事实 —— **判据与 restart-coordinator.tick 的 1.5 步同源**
  //   （都走 `lib/handoff-version-gate.mjs` 的 `restartGuard`：交接锁 + 锁 TTL + 持有者活性），
  //   避免"auto 说不在窗口、协调器说在窗口"的双口径。取不到 → null（不判，行为与改动前一致）。
  let handoffWindow = spec.handoffWindow ?? null;
  if (handoffWindow === null) {
    try {
      const hg = restartGuard({ home, now });
      handoffWindow = hg?.action === 'busy'
        ? { active: true, reason: hg.reason, expiresInMs: hg.window?.expiresInMs ?? null, source: 'lock' }
        : { active: false, reason: hg?.reason ?? null, expiresInMs: null, source: 'lock' };
    } catch { handoffWindow = null; }
  }
  const plan = spec.plan ?? planAutoRestart({
    sessions: scan.rows, active: scan.active, requests: scan.requests, window: scan.window,
    intents: scan.intents, now, policy: scan.policy ?? spec.policy, limits, state,
    handoffWindow,
  });
  out.plan = plan;

  // 3) 模块级闸门（L0 × L1 × L2）；dry-run **不受闸门限制**（只算不动 —— 与 runAction 同一语义）
  const moduleGate = checkModuleAllowed(RESTART_KIND, { home, autonomy: spec.autonomy });
  out.moduleGate = moduleGate;

  if (!dryRun && !moduleGate.allowed) {
    return {
      ...out, ok: true, status: 'blocked',
      reason: `L2 模块闸门关闭：${moduleGate.reason}`,
      blocked: 1,
      skipped: { decision: plan.decision, reason: plan.reason },
    };
  }

  // 4a) dry-run：一条轮级影子记账（明细在 detail 里），零请求
  if (dryRun) {
    const preview = restartPreview(plan, { now });
    out.preview = preview;
    const r = await runAction({
      kind: RESTART_KIND, level: RESTART_LEVEL, dryRun: true, home, now,
      detail: preview, preview: () => preview,
    }, { home, now });
    out.action = r;
    out.status = r.status;
    out.reason = r.reason;
    return out;
  }

  // 4b) 决策不是 ready → noop（不写签名、不占额度、零副作用）
  if (!plan.wouldRequest) {
    return {
      ...out, status: 'noop',
      reason: `本轮不发起（decision=${plan.decision}：${plan.note || plan.reason}）`,
      noop: 1,
      skipped: { decision: plan.decision, reason: plan.reason },
    };
  }

  // 4c) 通道级预检（与 request-restart.mjs 的闸门同源：autoAllowed('p0-auto-restart')）
  //     通道会拒绝时**不启动子进程**（省一次调用、不留审计噪音）—— fail-closed 方向
  const channelGate = autoAllowed(RESTART_KIND, { home });
  out.channelGate = channelGate;
  const requestRestart = spec.deps?.requestRestart ?? requestRestartViaCli;

  const r = await runAction({
    kind: RESTART_KIND, level: RESTART_LEVEL, dryRun: false, home, now,
    consumesQuota: true,
    sigKey: plan.sigKey,
    detail: slimPlan(plan),
    revertHint: '只发一条重启请求进既有 P0 闸门（不直接重启）：撤销 = 把 <tmp>\\dsh-guard\\restart-request.json 里该请求标 done/cancelled，闸门即不再执行；本动作不删卡、不改数据',
    execute: async () => {
      if (!channelGate.allowed) {
        return {
          // kind:'noop' 是 runAction 的既有语义标记（changed===0 && kind==='noop' → status='noop'）：
          // "被闸门拒绝"属**预期结果**而非失败（记 failed 会触发告警噪音、污染日报）
          kind: 'noop', ok: true, changed: 0, rejected: true, action: RESTART_KIND,
          where: 'channel-precheck', reason: channelGate.reason,
          note: '通道级预检未通过 → 未调用 request-restart.mjs',
        };
      }
      const res = await requestRestart({
        actor: plan.request?.actor ?? AUTO_ACTOR,
        reason: plan.request?.reason ?? 'P0 低水位自动重启',
        timeoutMs: spec.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (res?.rejected === true) {
        // exit 2 = 被 request-restart.mjs 内部闸门拒绝（裸跑期预期）→ 记为 noop 而非 failed
        return {
          kind: 'noop', ok: true, changed: 0, rejected: true, action: RESTART_KIND,
          where: 'request-restart-cli', exitCode: res.exitCode ?? null,
          stderr: res.stderr ?? '', argv: res.argv ?? null,
          note: '通道闸门拒绝（--as-auto 裸跑期关闭）→ 请求未落盘',
        };
      }
      return {
        kind: RESTART_KIND, ok: res?.ok === true, changed: res?.ok === true ? 1 : 0,
        rejected: false, exitCode: res?.exitCode ?? null,
        stdout: res?.stdout ?? '', stderr: res?.stderr ?? '',
        argv: res?.argv ?? null, error: res?.error ?? null,
      };
    },
  }, { home, now, executeTimeoutMs: spec.executeTimeoutMs });

  out.action = r;
  out.status = r.status;
  out.reason = r.reason;
  if (r.status === 'executed') out.requested = 1;
  else if (r.status === 'failed') { out.failed = 1; out.ok = false; }
  else if (r.status === 'noop') out.noop = 1;
  else out.blocked = 1;
  return out;
}

/** 一轮摘要（CLI / 报表用；纯只读）。 */
export function summarizeAutoRestart(result) {
  const p = result?.plan ?? null;
  return {
    kind: RESTART_KIND, dryRun: result?.dryRun === true, status: result?.status ?? null, reason: result?.reason ?? null,
    decision: p?.decision ?? null, decisionReason: p?.reason ?? null,
    lowWatermark: p?.lowWatermark === true, wouldRequest: p?.wouldRequest === true,
    activeCount: p?.activeCount ?? 0, scanned: p?.scanned ?? 0,
    interruptions: (p?.interruptions ?? []).length,
    requestsLive: p?.requests?.live ?? 0, gateAction: p?.gate?.action ?? null,
    quota: p?.quota ?? null,
    requested: result?.requested ?? 0, failed: result?.failed ?? 0, blocked: result?.blocked ?? 0, noop: result?.noop ?? 0,
    moduleGate: result?.moduleGate?.reason ?? null,
    channelGate: result?.channelGate?.reason ?? null,
  };
}

// ---------------------------------------------------------------- CLI（恒 dry-run）

/**
 * CLI 参数解析（**纯函数，单测入口**）。
 * 2026-09-13 实测踩坑：早先按 `indexOf` 反查"上一个是不是 flag"的写法，会把 `--reason` 这个 flag 名**自己**
 * 判成未知参数（exit 2）—— 现在改成顺序扫描：flag 与它的取值成对消费，剩下的才算未知。
 * @returns {{help:boolean, json:boolean, unknown:Array<string>, reasons:Array<string>, intentIds:Array<string>, actor:string|null}}
 */
export function parseCliArgs(argv = []) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const boolFlags = new Set(['--dry-run', '--json', '--help', '-h']);
  const valueFlags = new Set(['--reason', '--actor', '--intent-id']);
  const out = {
    help: list.includes('-h') || list.includes('--help'),
    json: list.includes('--json'),
    unknown: [], reasons: [], intentIds: [], actor: null,
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (boolFlags.has(a)) continue;
    if (valueFlags.has(a)) {
      const v = list[i + 1];
      const hasValue = v !== undefined && !boolFlags.has(v) && !valueFlags.has(v);
      i += 1;
      if (!hasValue) { out.unknown.push(a); continue; }
      if (a === '--reason') out.reasons.push(v);
      else if (a === '--actor') out.actor = v;
      else out.intentIds.push(v);
      continue;
    }
    out.unknown.push(a);
  }
  return out;
}

function printUsage() {
  process.stdout.write([
    '用法: node <dsh-butler>/lib/p0-auto-restart.mjs [--dry-run] [--json] [--reason <事由>]... [--actor <组件名>]',
    '',
    '  --dry-run  默认行为（只算不动，写一条 dry-run 影子记账；不产生任何真实重启请求）',
    '  --json     以 JSON 输出完整计划（略去会话明细大对象）',
    '  --reason   追加一条"待重启事由"（可重复；事由 id 默认取事由文本）',
    '  --actor    自动来源的组件名（默认 p0-auto-restart）',
    '',
    '⚠️ 本 CLI **只提供 dry-run**：真实发起只能由动作调用方（将来的 tick 接线 / 组件自修复）走 runAutoRestart()。',
    '   四门全关时任何真实执行路径一律 blocked 且零副作用（红线）。',
    '',
  ].join('\n'));
}

async function cliMain(argv) {
  const args = parseCliArgs(argv);
  if (args.help) { printUsage(); return 0; }
  if (args.unknown.length) {
    process.stderr.write(`未知参数：${args.unknown.join(' ')}\n`);
    printUsage();
    return 2;
  }
  const intents = args.reasons.map((reason, i) => ({ id: args.intentIds[i] ?? reason, reason, actor: args.actor }));

  const now = Date.now();
  const home = dshHome();
  const result = await runAutoRestart({ home, now, dryRun: true, intents });
  const sum = summarizeAutoRestart(result);
  const p = result.plan ?? null;

  if (args.json) {
    process.stdout.write(JSON.stringify({
      home, device: process.env.COMPUTERNAME ?? null, result: { ...result, plan: p ? slimPlan(p) : null, scan: undefined },
      summary: sum,
    }, null, 2) + '\n');
    return result.ok ? 0 : 1;
  }

  const yn = (b) => (b === true ? '是' : '否');
  const L = [
    `[p0-auto-restart] dry-run（只算不动；未产生任何真实重启请求）`,
    `  home      : ${home}`,
    `  决策      : ${p?.decision ?? '?'}`,
    `  理由      : ${p?.reason ?? '?'}（${p?.note ?? ''}）`,
    `  会发起请求: ${yn(p?.wouldRequest)}`,
    `  低水位    : ${yn(p?.lowWatermark)}（活跃 ${p?.activeCount ?? 0} / 扫描 ${p?.scanned ?? 0} 个会话）`,
    `  会被打断  : ${(p?.interruptions ?? []).length ? (p.interruptions ?? []).map((x) => `${x.sessionId}(${x.title || '无标题'})`).join('、') : '无'}`,
    `  既有请求  : ${p?.requests?.live ?? 0} 待处理（pending ${p?.requests?.pending ?? 0} / executing ${p?.requests?.executing ?? 0}）｜闸门判定 ${p?.gate?.action ?? '?'}（${p?.gate?.reason ?? '?'}）`,
    `  维护窗口  : ${p?.window ? `${p.window.phase}（${p.window.correlationId ?? '-'}）` : '无'}`,
    `  事由      : ${(p?.intents ?? []).length ? p.intents.map((i) => `${i.id}`).join('、') : '无（低水位本身不是重启理由）'}`,
    `  配额      : 今日 ${p?.quota?.used ?? 0}/${p?.quota?.max ?? 0}${p?.quota?.reached ? '（已用尽）' : ''}`,
    `  L2 模块门 : allowed=${result.moduleGate?.allowed ?? '?'}（${result.moduleGate?.reason ?? '?'}）`,
    `  通道级闸门: autoAllowed('p0-auto-restart') allowed=${result.channelGate?.allowed ?? '未判定（dry-run 不判）'}`,
    `  dry-run 记账：${result.status === 'dry-run' ? '已写 1 条（dryRun=true，不占额度、不写签名）' : `未写（status=${result.status}）`}`,
  ];
  process.stdout.write(L.join('\n') + '\n');
  return result.ok ? 0 : 1;
}

// 入口守卫：junction/实体化场景下 import.meta.url 会解析为物理路径，而 argv[1] 是逻辑路径
// ⇒ 必须双方 realpath 后再比（persona 铁律：字符串直比会静默退出 0）
const isMainEntry = (() => {
  try {
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return Boolean(argv1) && argv1 === self;
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  cliMain(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      process.stderr.write(`[p0-auto-restart] 失败：${e?.stack ?? e}\n`);
      process.exitCode = 1;
    });
}
