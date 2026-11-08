// dsh-butler / lib/stuck-recovery.mjs —— 卡死会话自愈链（提醒×2 → 自动重启请求 → 补注入 → 升级报警）
//
// 方案真源：`docs\方案-卡死会话自愈链-20261010.md`（主人口令 2026-10-10 08:4x：
//   「2 次提醒如果都无效，那你再注入也不会有效果，不如直接重启再补注入了」）。
//
// 【治什么（两条实证，都不是推测）】
//   ① 现场 A（2026-10-10 整夜断链 6.8h）：第10棒会话的 turn 在 01:23 那次
//      P0 重启时被判 `interrupted`，此后 **410 分钟零事件**；08:13:45 主人在 GUI 发了一条「。。。」
//      才把它唤醒（turn/start turn:10）⇒ **重启不叫醒会话，一条消息才叫醒它**。
//   ② 现场 B（主人经验）：工具调用卡死时「插不进会话、急停也停不下来」⇒ tool call 挂在 I/O 上时
//      该 step 永不结束，`queue` 等不到回合结束、`steer` 也等不到 step 边界 ⇒ **两种投递都读不到**，
//      只有进程级打断（P0 重启）能清掉悬挂的 tool call。
//   ⇒ 链条形状 = 温和提醒 2 次（给还能读到的会话）→ 无效直接走自动重启（清僵尸态）→ 重启后补注入
//     （重启只清状态、不叫醒；唤醒必须靠注入）→ 仍不动则升级报警（重投由既有 relay 机制承担）。
//   ③ 现场 C（2026-10-12/13 · 「等主人回答提问」被误判成卡死 · 本文件 2026-10-13 备料改动的原因）：
//      卡执行会话（某张卡）在 **00:32:48.876** 发出 `ask_user_question`
//      （`tool/call` seq 553 / callId `call_00_HEPNtt0l36xB9H1Gh0L91068`），主人的回答在
//      **01:00:19.217** 才作为 `tool/result`（seq 556）回来 ⇒ 中间 **27 分 30 秒**零事件。
//      这段时间里尾巴「回合未闭合 + idle ≥ 10 分钟」⇒ 本链把它当**卡死**：发了 2 次提醒（第 2 次文案
//      还写着「约 N 分钟后若仍无响应，将自动走 P0 重启」），t0+20 分钟会把一条自动重启事由塞进 P0 闸门。
//      **而重启根本解决不了「没人回答」**：它只清僵尸状态，还会打断当时所有其他会话。
//      ⇒ 本次改动 = 链条先识别「尾部有 tool/call 无 tool/result 的提问」这一状态（下称 **ask-wait**），
//        该状态下 **不产生 restart、不重复 nudge，只留痕**（告警一行 + 链条 history + 状态文件字段）；
//        状态消失（主人答了 / 工具返回 / 回合收尾）⇒ 清标记 + 链条时钟复位回 t0，**回到原有行为**，
//        绝不永久豁免。
//
// 【边界（改本文件前必读）】
//   ① 判定口径**复用** `lib/watch-collect.mjs#collectSessionsLight` 的 `stuck`（回合未闭合 + idle≥阈值），
//      不另造第二套；本文件不重算回合边界。
//   ①b ask-wait 判定**只读会话日志尾部**（`readSessionTail` + `discoverSessionFiles`，均复用既有只读件），
//      不新造采集器、不写会话、不改主包；读不到尾部 ⇒ **不改原行为**（照旧判卡死）+ 留 hint（见 §1.7）。
//   ② 重启**不自己发起**：一律调 `lib/p0-auto-restart.mjs#runAutoRestart({ intents })` —— 复用它的
//      低水位判定（活跃集合为空才发起，不打断在跑卡）、24h 去重、单日上限、通道闸 `autoAllowed('p0-auto-restart')`
//      与真实通道（`request-restart.mjs --as-auto`）。本文件**不含任何子进程调用**。
//   ③ 注入走 `notifySession`（queue/steer），并且**只在 runAction 闸门放行后**执行。
//   ④ 所有执行走 `runAction()` 唯一闸门：dry-run 永远可跑（只算不动）；四门任一关 → blocked 零副作用。
//   ⑤ 本功能**不扩权**：不改权限、不动凭据、不出机器；一键关回 = `stuck-recovery-cli.mjs off --apply`。
//   ⑥ **ask-wait 不是"新动作"**：它不进 `AUTO_ACTION_KINDS`、不走 `runAction`（与 `escalate` 同款
//      —— 只观察 + 留痕，不投递、不写记账、不占额度）。一旦将来它要"真的做点什么"，按矩阵 §3.1 的
//      固定落地顺序（实现 → 登记 kind → 补 §3 表 → 补影子视图映射 → 流水）另开卡办。
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { readJson } from '../../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../../src/dsh-butler/lib/dual-write.mjs';
import { alert } from '../../src/dsh-butler/lib/alert.mjs';
import { checkModuleAllowed } from '../../src/dsh-butler/lib/autonomy-modules.mjs';
import { runAction, readLimits, sigKeyOf, localDay } from '../../src/dsh-butler/lib/autonomy-actions.mjs';
import { notifySession } from '../../src/dsh-butler/lib/watch-notify.mjs';
import { collectSessionsLight, readSessionTail } from '../../src/dsh-butler/lib/watch-collect.mjs';
import { discoverSessionFiles } from '../../src/dsh-butler/lib/pitfall-scan.mjs';
import { readSessions } from '../../src/dsh-butler/lib/queue-watch.mjs';
import { runAutoRestart } from './p0-auto-restart.mjs';

export const STUCK_RECOVERY_VERSION = '0.1.0';
export const STUCK_RECOVERY_SCHEMA = 1;
// ⚠️ 状态文件名**必须**与配置文件（`butler-stuck-recovery.json`）不同名 —— 同名时一轮真执行会把
//    状态结构写进配置文件、覆盖掉 `enabled` 键（2026-10-10 09:11 生产实测踩到：开闸后下一轮 job 跑完，
//    配置文件变成状态体、总闸读数回落 false）。此处改名后已由单测钉死（E7）。
/** 【2c-B2】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, opts = {}) {
  return resolveStatePath(name, { home: opts.home ?? dshHome() }).path;
}
export const STUCK_STATE_FILE = 'butler-stuck-recovery-state.json';
export const STUCK_CONFIG_FILE = 'butler-stuck-recovery.json';
// 【命名口径】动作 kind 与模块 id **同名**（`own` 类要求同名 —— 准入校验 A3；先例 = queue-wake）。
//   语义分工：模块 = 整条自愈链的开关；动作 = 链里的"注入提醒"这一跳（重启那跳走 p0-auto-restart）。
export const NUDGE_KIND = 'stuck-recovery';
export const NUDGE_LEVEL = 'L1';
export const MODULE_ID = 'stuck-recovery';
// ⛔ 顺序有讲究：`ASK_WAIT_ACTION` 必须在 `STUCK_KINDS` **之前**声明（module 级 const 的 TDZ —— 反过来写
//    会在模块加载时直接 ReferenceError，本备料的夹具 F0 就是钉这条）。
/** 计划项 action 名（**不**是 runAction kind；见下方 ask-wait 段落）。 */
export const ASK_WAIT_ACTION = 'ask-wait';
/** 认作"提问等待"的工具名（可经 opts.toolNames 覆盖；将来若有别的交互式提问工具，加这里）。 */
export const ASK_TOOL_NAMES = Object.freeze(['ask_user_question']);
/** ask-wait 留痕频率：每会话每天最多 1 条（不静默，也不刷屏）。 */
export const ASK_WAIT_ALERTS_PER_DAY = 1;
export const STUCK_KINDS = Object.freeze(['nudge1', 'nudge2', 'restart', 'reinject', 'escalate', ASK_WAIT_ACTION]);

// ══════════════════════════════════════════════════════════════════════════════
// ask-wait（尾部有提问未应答）—— 纯判定 + 只读探测
//   ⚠️ 与 `escalate` 同款：**只是一个"计划项"，不是 runAction 动作**（不进 AUTO_ACTION_KINDS）。
//   为什么要单独一档：自愈链原来「只会看 idle 时长」，分不清"真卡死"与"在等主人回答"。
//   2026-10-12/13 实测（卡 `4a967552` 的执行会话）等了 27 分 30 秒 ⇒ 会被判卡死并塞 P0 重启事由。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 从一条 `tool/result` 事件里取出它回答掉的 callId（两处都取，兼容不同世代写法）。
 *   · `data.message.source.callId`（实测 2026-10-12 seq 556 有此字段）
 *   · `data.message.content[].toolCallId`（实测同上，`{type:'tool-result', toolCallId}`
 * @returns {string[]}
 */
export function resultCallIds(ev) {
  const out = [];
  const src = ev?.data?.message?.source?.callId;
  if (typeof src === 'string' && src) out.push(src);
  const content = ev?.data?.message?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const id = c?.toolCallId;
      if (typeof id === 'string' && id) out.push(id);
    }
  }
  return out;
}

/**
 * 纯函数：尾部事件里**最后一条**提问类 `tool/call` 有没有对应的 `tool/result`。
 *
 * 判据（只用两件事，不猜、不超时）：
 *   ① 把全部 `tool/result` 回答掉的 callId 收成集合；
 *   ② 从尾部往前找**最后一条** `tool/call` 且 `data.name ∈ toolNames`：
 *      · 它的 callId **不在**集合里 ⇒ `pending:true`（在等回答，**这就是 ask-wait**）
 *      · 在集合里           ⇒ `pending:false`（已答，链条回原行为）
 *      · 尾部没有提问类 call ⇒ `pending:false`（真卡死走原链）
 *
 * 「只认最后一条」的理由：一次问答闭环之后又出现新的提问 ⇒ 后一条才是当前状态；
 *   中间历史问答（answered）不会把新提问误判成"已答"。
 * ⚠️ **绝不按超时猜**：没有"等了 N 分钟就当你没在等"这种口径 —— 等多久都还是 ask-wait，
 *    直到 tool/result（或回合收尾）出现。这正是本缺陷的根因（旧口径只看 idle 时长）。
 *
 * @param {Array<{type:string,data?:any}>} events 尾部事件（seq 升序）
 * @param {{toolNames?:string[]}} [opts]
 * @returns {{pending:boolean, reason:string, callId:string|null, tool:string|null}}
 */
export function detectAskWait(events, opts = {}) {
  const names = new Set((opts.toolNames ?? ASK_TOOL_NAMES).map((x) => String(x)));
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e.type === 'string') : [];
  if (!list.length) return { pending: false, reason: 'no-events', callId: null, tool: null };
  const answered = new Set();
  for (const e of list) {
    if (e.type !== 'tool/result') continue;
    for (const id of resultCallIds(e)) answered.add(id);
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e.type !== 'tool/call') continue;
    const name = String(e?.data?.name ?? '');
    if (!names.has(name)) continue;
    const callId = String(e?.data?.callId ?? '') || null;
    if (callId && answered.has(callId)) return { pending: false, reason: 'answered', callId, tool: name };
    return { pending: true, reason: callId ? 'unanswered-ask' : 'unanswered-ask(no-callId)', callId, tool: name };
  }
  return { pending: false, reason: 'no-ask-call', callId: null, tool: null };
}

/**
 * 只读探测：某个会话的尾部是否处于 ask-wait（**唯一 IO 点**）。
 *
 * 用既有的两个只读件拼：`discoverSessionFiles(home)` 找文件（只取活跃树，归档会话不是"活跃会话"）、
 * `readSessionTail(file)` 读尾部并逐帧解 zstd。**不写任何东西**。
 * 取多份候选时：mtime 最新优先 → 平局取代际大者（与 `session-file-name.mjs` 的候选链同口径）。
 *
 * ⚠️ 失败语义（**不改原行为**）：读不到 / 没这个会话 / 解析空 ⇒ 返回 `{pending:false, error}`，
 *    调用方照旧按"卡死"处理（宁可漏判 ask-wait，也不让"尾部读不动"变成永久豁免重启的挡箭牌）。
 *
 * @returns {{pending:boolean, reason:string, callId:string|null, tool:string|null, file?:string, events?:number, error?:string}}
 */
export function readAskStateForSession(home = dshHome(), sessionId, opts = {}) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) return { pending: false, reason: 'no-session-id', callId: null, tool: null, error: 'no-session-id' };
  let files;
  try { files = discoverSessionFiles(home); } catch (e) {
    return { pending: false, reason: 'session-scan-failed', callId: null, tool: null, error: e?.message ?? String(e) };
  }
  const mine = files.filter((f) => f.sessionId === sid && f.root !== 'archived');
  if (!mine.length) return { pending: false, reason: 'session-file-not-found', callId: null, tool: null };
  mine.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.generation - a.generation));
  const f = mine[0];
  let tail;
  try { tail = readSessionTail(f.file, { tailBytes: opts.tailBytes ?? 256 * 1024 }); } catch (e) {
    return { pending: false, reason: 'tail-read-failed', callId: null, tool: null, file: f.file, error: e?.message ?? String(e) };
  }
  const r = detectAskWait(tail.events, opts);
  return { ...r, file: f.file, events: tail.events.length };
}

/** ask-wait 留痕文案（唯一构造点；CLI / 告警 / 日报共用，别各处手打）。 */
export function formatAskWaitText(item = {}) {
  const min = Math.round((Number(item.idleMs ?? item.ageMs ?? 0)) / MIN);
  const tool = String(item?.chain?.askWaitTool ?? 'ask_user_question');
  return `会话在等回答提问（${tool} 已发出、还没返回）：已静止约 ${min} 分钟。`
    + '这不是卡死 —— 自愈链暂停（不提醒、不重启），等主人回答或工具返回后自动回到原链。';
}

const MIN = 60_000;

/**
 * 【2026-10-30 新增 · 首投宽限】
 * 会话**刚进**卡死名单时不再立刻投第 1 次提醒 —— 长思考 / 长工具调用（生图、下载、跨机 ssh、
 * 大文件写入前）期间会话不写盘，10 分钟无写入就会被判「回合未闭合且卡死」；
 * 一进名单就投提醒正是「误投放变多」的直接原因（`a64aae60` 10:23 被提醒、10:54 还在干活）。
 * 放行条件（**或**关系）：年龄 ≥ min(NUDGE1_GRACE_MS, stuckMs/2) **或** 已在名单里待满 NUDGE1_MIN_TICKS 个 tick。
 * ⚠️ 只管第 1 次提醒；nudge2 / restart / escalate 的时序一字不动。
 */
export const NUDGE1_GRACE_MS = 5 * MIN;
export const NUDGE1_MIN_TICKS = 2;

/** 缺省参数（**全写在这里**；闸文件只覆盖合法键）。 */
export const DEFAULT_CFG = Object.freeze({
  enabled: false,                 // 总开关：缺省关（交付/放行分离）—— 放行 = stuck-recovery-cli.mjs on --apply
  stuckMs: 10 * MIN,              // 判死阈值：回合未闭合且 idle ≥ 该值（与 watch 的 session-spin 同源）
  nudgeSteerMs: 10 * MIN,         // t0 + 该值 → 第 2 次提醒（steer）
  restartMs: 20 * MIN,            // t0 + 该值 → 登记自动重启事由（交给 p0-auto-restart）
  reinjectMs: 2 * MIN,            // 重启批次完成 + 该值 → 补注入
  escalateMs: 15 * MIN,           // 补注入后 + 该值仍卡死 → 升级报警
  maxNudgesPerSessionPerDay: 2,   // 主人口令：每会话每天 2 次提醒
  maxRestartIntentsPerDay: 2,     // 自动重启事由每天上限（真正的闸门在 p0-auto-restart）
  onlyWhenOvernight: true,        // 自动重启只在整夜模式保护中发起（白天主人在场，人工更快）
  sessionMaxFiles: 40,
});

export function cfgPath(home = dshHome()) { return stateFileOf(STUCK_CONFIG_FILE, { home }); }
export function statePath(home = dshHome()) { return stateFileOf(STUCK_STATE_FILE, { home }); }

/** 读闸（缺省即关；文件损坏 ⇒ 回缺省 = 关，fail-closed）。 */
export function loadCfg(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.file ?? cfgPath(home);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CFG, file, exists: false };
  const out = { ...DEFAULT_CFG };
  for (const k of Object.keys(DEFAULT_CFG)) if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  out.enabled = raw.enabled === true;
  return { ...out, file, exists: true };
}

/** 读状态（链表 + 重启事由计数）。 */
export function loadState(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.file ?? statePath(home);
  const j = readJson(file, { defaultValue: null });
  if (!j || typeof j !== 'object') return { schemaVersion: STUCK_RECOVERY_SCHEMA, updatedAt: 0, chains: {}, restartLog: {}, file };
  return {
    schemaVersion: j.schemaVersion ?? STUCK_RECOVERY_SCHEMA,
    updatedAt: j.updatedAt ?? 0,
    chains: j.chains && typeof j.chains === 'object' ? j.chains : {},
    restartLog: j.restartLog && typeof j.restartLog === 'object' ? j.restartLog : {},
    file,
  };
}

/**
 * 纯函数：算本轮该对哪些卡死会话做什么（**零 IO、零副作用**，单测入口）。
 *
 * @param {{now:number, stuck:Array, chains:object, cfg:object, dayKey:string,
 *          overnightProtected:boolean, lastRestartFinishedAt:number|null,
 *          restartIntentsToday:number}} input
 * @returns {{items:Array, chains:object, summary:object}}
 */
export function planStuckRecovery(input = {}) {
  const now = Number(input.now) || Date.now();
  const cfg = { ...DEFAULT_CFG, ...(input.cfg ?? {}) };
  const dayKey = String(input.dayKey ?? localDay(now));
  const overnight = input.overnightProtected === true;
  const lastRestartAt = Number(input.lastRestartFinishedAt ?? 0) || 0;
  const stuck = Array.isArray(input.stuck) ? input.stuck : [];
  const chains = { ...(input.chains ?? {}) };
  const items = [];
  const live = new Set();
  let restartIntentsToday = Number(input.restartIntentsToday ?? 0) || 0;

  for (const s of stuck) {
    const sid = String(s?.sessionId ?? '').trim();
    if (!sid) continue;
    live.add(sid);
    const idleMs = Number(s.idleMs ?? 0) || 0;
    const prev = chains[sid] && typeof chains[sid] === 'object' ? chains[sid] : null;
    // 跨天重置：nudge 计数按天（重启事由计数在全局）
    // t0 = **首次判出卡死的时刻**（不是反推"空闲起点"）—— 链条时序以判出时刻为基准（判死阈值本身就是 stuckMs）。
    const c = prev && prev.dayKey === dayKey
      ? { ...prev }
      : { sessionId: sid, firstSeenAt: now, firstIdleMs: idleMs, dayKey, nudges: 0, history: [], seenTicks: 0 };
    if (!Number.isFinite(Number(c.firstSeenAt))) c.firstSeenAt = now;
    c.sessionId = sid;
    c.lastSeenAt = now;
    c.idleMs = idleMs;
    c.reason = String(s.reason ?? '').slice(0, 160);
    c.nudges = Number(c.nudges ?? 0) || 0;

    if (c.recoveredAt) {
      // 已恢复过的链若再次卡死 ⇒ 重新开链（不清历史）。⚠️ 必须在 age 计算**之前**重置 firstSeenAt，
      //   否则本轮会拿旧 firstSeenAt 算出超长 age 而直接跳进 restart 阶段（2026-10-10 单测抓到）。
      delete c.recoveredAt;
      c.firstSeenAt = now; c.firstIdleMs = idleMs;
      c.nudges = 0;
      c.seenTicks = 0;   // 重新开链 ⇒ 首投宽限重走一遍（不拿旧 tick 数硬闯）
      c.nudge1At = null; c.nudge2At = null; c.restartIntentAt = null; c.reinjectAt = null; c.escalateAt = null;
    }

    // 【2026-10-30 新增】进名单 tick 计数（首投宽限的第二个条件用；一轮 = 一个 tick）。
    //   放在 recovered / ask-wait 清理**之后**：新建链与重开链都从 0 起数，本轮统一算第 1 个 tick。
    c.seenTicks = Number(c.seenTicks ?? 0) + 1;

    // ⭐【2026-10-13 新增】ask-wait 冻结：该会话尾部有"发出但没返回"的提问 ⇒ 它在**等主人回答**，
    //    不是卡死。此时**既不提醒、也不重启、也不升级**，只在每天第一次留痕一条（不静默）。
    //    ⚠️ 这一段**只在 `askPending === true` 时进入** ⇒ 真卡死会话的链对象与本改动前**逐字节一致**
    //       （夹具 R2 就是这个断言）。恢复路径见紧随其后的 `askWaitAt` 清理段。
    if (s?.askPending === true) {
      const firstDetect = !c.askWaitAt;
      if (firstDetect) {
        c.askWaitAt = now;                                        // 首次识别时刻（取证用）
        c.askWaitCallId = String(s?.askWait?.callId ?? '') || null;
        c.askWaitTool = String(s?.askWait?.tool ?? '') || null;
        c.askWaitSeenCount = Number(c.askWaitSeenCount ?? 0) + 1;
        c.history = [...(c.history ?? []), { at: now, kind: 'ask-wait', callId: c.askWaitCallId }].slice(-20);
      }
      c.askWaitLastSeenAt = now;
      c.askWaitIdleMs = idleMs;
      let askAction = null;
      // 留痕频率：每会话每天 ≤1 条（`askWaitAlertedDay` **不在**恢复段里清 ⇒ 同一天反复开合也不刷屏）
      if (String(c.askWaitAlertedDay ?? '') !== dayKey) {
        c.askWaitAlertedDay = dayKey;
        askAction = ASK_WAIT_ACTION;
      }
      if (askAction) items.push({ sessionId: sid, action: askAction, reason: c.reason, idleMs, ageMs: now - Number(c.firstSeenAt), chain: { ...c } });
      chains[sid] = c;
      continue;                                                   // ⛔ 跳过原链：**绝不**产生 restart/nudge/escalate
    }
    // ask-wait 状态消失（主人答了 / 工具返回 / 回合收尾）⇒ 清标记 + **链条时钟复位回 t0**，
    //   回到原有 nudge1 → nudge2 → restart 行为（**不永久豁免**）。复位理由：刚答完的会话很可能
    //   马上继续干活；若立刻按旧 firstSeenAt 判 age≥restartMs，会把"刚被叫醒的会话"直接送进重启。
    if (c.askWaitAt) {
      c.history = [...(c.history ?? []), { at: now, kind: 'ask-wait-cleared' }].slice(-20);
      delete c.askWaitAt; delete c.askWaitCallId; delete c.askWaitTool;
      delete c.askWaitLastSeenAt; delete c.askWaitIdleMs;
      c.firstSeenAt = now; c.firstIdleMs = idleMs;
      c.nudges = 0;
      c.seenTicks = 1;   // 时钟已复位回 t0 ⇒ 本轮就是新链的第 1 个 tick（计数行已在本段之前执行过）
      c.nudge1At = null; c.nudge2At = null; c.restartIntentAt = null; c.reinjectAt = null; c.escalateAt = null;
    }

    const age = now - Number(c.firstSeenAt);
    let action = null;

    if (c.escalateAt) {
      action = null;                                      // 已升级报警：不再重复动作（等人工/重投）
    } else if (c.reinjectAt) {
      if (now - Number(c.reinjectAt) >= cfg.escalateMs) action = 'escalate';
    } else if (c.restartIntentAt) {
      const done = lastRestartAt > Number(c.restartIntentAt);
      if (done && now - Number(c.restartIntentAt) >= cfg.reinjectMs) action = 'reinject';
      else if (!done && now - Number(c.restartIntentAt) >= cfg.restartMs * 3) action = 'escalate'; // 长时间等不到低水位 ⇒ 报警
    } else if (age >= Number(cfg.restartMs)) {
      if (cfg.onlyWhenOvernight && !overnight) action = 'escalate';         // 窗口外不自动重启 ⇒ 升级报警
      else if (restartIntentsToday >= Number(cfg.maxRestartIntentsPerDay)) action = 'escalate';
      else action = 'restart';
    } else if (age >= Number(cfg.nudgeSteerMs)) {
      if (!c.nudge2At && c.nudges < Number(cfg.maxNudgesPerSessionPerDay)) action = 'nudge2';
    } else if (!c.nudge1At && c.nudges < Number(cfg.maxNudgesPerSessionPerDay)) {
      // 【2026-10-30 修 · 首投宽限】见 NUDGE1_GRACE_MS 注释：进名单当轮不投。
      const graceMs = Math.min(NUDGE1_GRACE_MS, Number(cfg.stuckMs ?? DEFAULT_CFG.stuckMs) / 2);
      const byAge = age >= graceMs;
      const byTicks = Number(c.seenTicks ?? 0) >= NUDGE1_MIN_TICKS;
      if (byAge || byTicks) action = 'nudge1';
    }

    if (action) items.push({ sessionId: sid, action, reason: c.reason, idleMs, ageMs: age, chain: { ...c } });
    if (action === 'restart') restartIntentsToday += 1;
    chains[sid] = c;
  }

  // 已不在卡死名单里的链 ⇒ 标 recovered（保留 24h 供取证，之后由 prune 清）
  for (const [sid, c] of Object.entries(chains)) {
    if (live.has(sid)) continue;
    if (!c.recoveredAt) { c.recoveredAt = now; c.history = [...(c.history ?? []), { at: now, kind: 'recovered' }].slice(-20); }
  }

  return {
    items,
    chains,
    summary: {
      stuck: stuck.length, planned: items.length,
      byAction: items.reduce((m, i) => (m[i.action] = (m[i.action] ?? 0) + 1, m), {}),
      restartIntentsToday,
      // ★ 新增（additive）：本轮"在等主人回答提问"的会话数 —— 让读数里看得见这条链被暂停过。
      askWait: stuck.filter((s) => s?.askPending === true).length,
    },
  };
}

/**
 * 注入文案（唯一构造点）。
 *
 * 【2026-10-30 修 · 文案口径】(真源 `docs\交付报告-卡死自愈误投放三修-20261030.md`)
 *   旧写法 `const min = Math.round((Number(item.ageMs ?? item.idleMs ?? 0)) / MIN)` 取反了优先级：
 *   `ageMs = now - firstSeenAt`，**首次判出那一刻恒为 0** ⇒ 每条第 1 次提醒都写成
 *   「本会话已约 0 分钟没有新事件」（主人 2026-10-30 10:52 的截图就是这样，自己露了馅）。
 *   真实静默 = `idleMs`（= now − 会话文件 mtime），也是采集侧 `reason` 里那个数。
 *   ⇒ 正文改用 `idleMs`（缺了才回落 `ageMs`），并把「真实静默 / 本链跟踪」两个数**分开写清楚**，
 *     谁也不冒充谁：前者是客观静默时长，后者是链条从首次判出起跑了多久（决定何时重启）。
 */
export function formatNudgeText(item, opts = {}) {
  const idleMin = Math.max(0, Math.round((Number(item.idleMs ?? item.ageMs ?? 0)) / MIN));
  const ageMin = Math.max(0, Math.round((Number(item.ageMs ?? 0)) / MIN));
  const head = `🐳 管家·卡死自愈（第 ${item.action === 'nudge2' ? 2 : 1} 次提醒）`;
  if (item.action === 'reinject') {
    return [
      '🐳 管家·卡死自愈（重启后补注入）',
      '',
      '你刚才被一次 P0 重启打断（回合被强制结束）。请**接着把当前这件事做完**；若已无法继续，就收尾并写交接档交棒（命令：session-relay.mjs --check / --handoff）。',
      '',
      '（本提醒只注入文本：不改会话数据、不改看板、不改配置。）',
    ].join('\n');
  }
  return [
    head,
    '',
    `本会话已约 ${idleMin} 分钟没有新事件、且尾部回合未闭合（可能是工具调用卡住或回合被打断）。`,
    `（口径：真实静默 ${idleMin} 分钟 = 会话日志最后写入距今；本链从首次判出起跟踪 ${ageMin} 分钟。）`,
    '',
    '请二选一：',
    '1. **继续干**：接着把手上这件事做完；',
    '2. **收尾交棒**：写第 N 棒交接档 → `node <workspace>\\tools\\session-relay.mjs --check "<档>"` → `--handoff "<档>"`。',
    '',
    `⚠️ 若你其实是在等长任务（下载/长命令），忽略本条即可 —— 但请回一句话说明在等什么，以免被判定为卡死。`,
    `⚠️ 约 ${Math.max(1, Math.round((Number(opts.restartMs ?? DEFAULT_CFG.restartMs) - Number(item.ageMs ?? 0)) / MIN))} 分钟后若仍无响应，将自动走 P0 重启。`,
  ].join('\n');
}

/**
 * 执行一轮自愈（只读采集 → 纯函数计划 → 逐项过 runAction 闸门执行）。
 *
 * @param {{home?:string, now?:number, dryRun?:boolean, baseUrl?:string, cfg?:object, state?:object,
 *          stuck?:Array, overnightProtected?:boolean, lastRestartFinishedAt?:number,
 *          skipListFilter?:boolean, skipAskProbe?:boolean, tailBytes?:number,
 *          deps?:{inject?:Function, autoRestart?:Function, askProbe?:Function, alert?:Function}}} spec
 */
export async function runStuckRecovery(spec = {}, opts = {}) {
  const home = opts.home ?? spec.home ?? dshHome();
  const now = Number(opts.now ?? spec.now) || Date.now();
  const dryRun = spec.dryRun === true || opts.dryRun === true;
  const cfg = { ...(spec.cfg ?? loadCfg({ home })) };
  const state = spec.state ?? loadState({ home });
  const dayKey = localDay(now);

  const out = {
    kind: MODULE_ID, version: STUCK_RECOVERY_VERSION, ok: true, dryRun, enabled: cfg.enabled === true,
    status: null, reason: null, home, now, day: dayKey,
    stuck: 0, planned: 0, executed: 0, failed: 0, blocked: 0, noop: 0,
    // ★ 新增（additive）：`held` = 因 ask-wait 被"冻结"的计划项数；`askWait` = 命中 ask-wait 的会话 id
    held: 0, askWait: [],
    items: [], plan: null, action: null, hints: [],
  };

  // 0) 总开关（缺省关 ⇒ 零动作、零 IO 副作用）；dry-run 不受开关限制（只算不动）
  if (!dryRun && cfg.enabled !== true) {
    return { ...out, status: 'disabled', reason: `总开关关闭（${cfg.file ?? cfgPath(home)} ⇒ enabled!==true）` };
  }

  // 0.5) 模块级闸门（L0 降档 × L1 owner × L2 `modules['stuck-recovery']`）—— 与 queue-wake 同款三段串联；
  //      dry-run 不受闸门限制（只算不动）。fail-safe 方向：读不到/未放行 ⇒ blocked 零动作。
  const moduleGate = checkModuleAllowed(MODULE_ID, { home, autonomy: spec.autonomy });
  out.moduleGate = { allowed: moduleGate.allowed, reason: moduleGate.reason };
  if (!dryRun && !moduleGate.allowed) {
    return { ...out, status: 'blocked', reason: `L2 模块闸门关闭：${moduleGate.reason}` };
  }

  // 1) 只读采集卡死会话（缺省复用一个采集器，不重算回合边界）
  let stuck = Array.isArray(spec.stuck) ? spec.stuck : null;
  if (!stuck) {
    let r;
    try {
      r = collectSessionsLight({ home, now, stuckMs: cfg.stuckMs, sessionMaxFiles: cfg.sessionMaxFiles });
    } catch (e) {
      return { ...out, ok: false, status: 'collect-failed', reason: `会话采集异常：${e?.message ?? String(e)}` };
    }
    if (!r?.ok) return { ...out, ok: false, status: 'collect-failed', reason: r?.error ?? 'collect-not-ok' };
    stuck = r.stuck ?? [];
    // 【2026-10-30 新增 · 可观测】「在等工具」的会话已被采集侧分流、**不进** stuck（见
    //   `watch-collect.mjs#detectWaitingTool`）。这里把它们带进读数，让 dry-run / CLI 看得见
    //   “为什么这轮没判它卡死” —— 只读提示，不产生任何动作。
    if (Array.isArray(r?.waitingTool) && r.waitingTool.length) {
      out.waitingTool = r.waitingTool.map((x) => `${x.sessionId}:${x.tool ?? 'tool'}`);
      out.hints.push(`waiting-tool：${r.waitingTool.length} 个会话在等工具返回（未判卡死）`);
    }
  }
  out.stuck = stuck.length;

  // 1.5) 安全过滤（防误伤）—— 只对"主包会话表里存在 **且** 标题不是【待续】/【完成】/【已交接】"的会话动作。
  //   现场教训（2026-10-10 09:12 dry-run）：`--D-DSH-card-sessions--` 下的**空壳卡会话**
  //   （不在会话表窗口、无任何活跃工作）同样命中 stuck 判定 ⇒ 若不过滤，会白提醒它、
  //   并在 20 分钟后把一条重启事由塞进 P0 闸门（昨天第10棒那种"真卡死"才是目标）。
  //   表读不到 ⇒ **fail-closed**（本轮零动作），绝不"猜着发"。
  //   ⚠️ 调用方**自己注入** `spec.stuck`（外部算好）时跳过本过滤 —— 注入方负责其口径（单测夹具即走这条路）。
  if (spec.skipListFilter !== true && !Array.isArray(spec.stuck)) {
    let r = null;
    try {
      r = spec.views ?? await readSessions({ baseUrl: spec.baseUrl, timeoutMs: spec.viewsTimeoutMs ?? 8000 });
    } catch (e) {
      return { ...out, ok: false, status: 'views-failed', reason: `会话表读取异常 ⇒ fail-closed：${e?.message ?? String(e)}` };
    }
    if (!r?.ok) return { ...out, ok: false, status: 'views-failed', reason: `会话表读不到 ⇒ fail-closed（${r?.error ?? 'unknown'}）` };
    const listed = new Set(r.items.filter((i) => i.sessionId).map((i) => i.sessionId));
    const titles = new Map(r.items.filter((i) => i.sessionId).map((i) => [i.sessionId, String(i.title ?? '')]));
    const before = stuck.length;
    stuck = stuck.filter((s) => {
      if (!listed.has(s.sessionId)) return false;                       // 老会话 / 空壳卡会话
      if (/【待续】|【完成】|【已交接】/.test(titles.get(s.sessionId) ?? '')) return false; // 有意停手 / 已闭环
      return true;
    });
    out.listFilter = { before, after: stuck.length, dropped: before - stuck.length };
    out.stuck = stuck.length;
  }

  // 1.7)【2026-10-13 新增】ask-wait 富化（只读）—— 给每个卡死候选打一个"它是不是在等主人回答提问"的标。
  //   为什么放在这（过滤之后）：只对**真要动作的**那几个会话读尾部，成本与卡死数同阶（不是全量 40 个会话）。
  //   判定 = 尾部最后一条提问类 `tool/call` 有没有配对的 `tool/result`（纯函数 `detectAskWait`）。
  //   ⚠️ **失败语义 = 不改原行为**：读不到尾部 / 找不到会话文件 ⇒ 不标 askPending（照旧判卡死）+ 留 hint。
  //      取舍理由：本改动只为"消掉误判"，不该把"读不动"变成**永久豁免重启**的挡箭牌（那会反过来
  //      把真卡死的会话永久挂着）。宁可漏判。夹具 F3 钉这条。
  //   ⚠️ `spec.skipAskProbe === true` 或调用方注入 `spec.stuck` 且已自带 `askPending` ⇒ 跳过探测（单测/夹具走这条）。
  if (Array.isArray(stuck) && stuck.length && spec.skipAskProbe !== true) {
    const probe = spec.deps?.askProbe ?? ((o) => readAskStateForSession(o.home, o.sessionId, { tailBytes: spec.tailBytes }));
    const enriched = [];
    for (const s of stuck) {
      if (s?.askPending !== undefined) { enriched.push(s); continue; }   // 调用方已算好 ⇒ 尊重它
      let info = null;
      try { info = await probe({ home, sessionId: s.sessionId, now, cfg }); }
      catch (e) { info = { pending: false, error: e?.message ?? String(e) }; }
      if (info?.pending === true) {
        enriched.push({ ...s, askPending: true, askWait: { callId: info.callId ?? null, tool: info.tool ?? null } });
      } else {
        enriched.push(s);
        if (info?.error) out.hints.push(`ask-probe-failed:${s.sessionId}:${String(info.error).slice(0, 80)}`);
      }
    }
    stuck = enriched;
    out.askWait = enriched.filter((s) => s.askPending === true).map((s) => s.sessionId);
  }

  // 2) 整夜模式保护态（只读；读不到 ⇒ 视为未保护 = 不自动重启，fail-closed）
  let overnightProtected = spec.overnightProtected;
  if (overnightProtected === undefined) {
    try {
      const f = path.join(home, `overnight-mode-${String(process.env.COMPUTERNAME ?? '').toLowerCase()}.json`);
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      overnightProtected = j?.enabled === true || j?.protected === true || j?.active === true;
    } catch { overnightProtected = false; }
  }
  out.overnightProtected = overnightProtected === true;

  // 3) 最近一次重启批次完成时刻（判定"重启已完成"）
  let lastRestartFinishedAt = spec.lastRestartFinishedAt;
  if (lastRestartFinishedAt === undefined) {
    try {
      const j = JSON.parse(fs.readFileSync(resolveStatePath('butler-restart-state.json', { home }).path, 'utf8'));
      lastRestartFinishedAt = Number(j?.lastBatch?.finishedAt ?? 0) || 0;
    } catch { lastRestartFinishedAt = 0; }
  }

  // 4) 纯函数计划（零副作用）
  const restartIntentsToday = Number(state.restartLog?.[dayKey] ?? 0) || 0;
  const plan = planStuckRecovery({
    now, stuck, chains: state.chains, cfg, dayKey,
    overnightProtected, lastRestartFinishedAt, restartIntentsToday,
  });
  out.plan = { summary: plan.summary };

  if (!plan.items.length) {
    out.status = 'noop';
    out.reason = `本轮无待处理卡死会话（扫到卡死 ${stuck.length} 个）`;
    return out;
  }
  out.planned = plan.items.length;

  // 5) 逐项执行（每项独立 runAction：独立签名 + 独立额度）
  const inject = spec.deps?.inject ?? ((sid, text, o) => notifySession(sid, text, { baseUrl: spec.baseUrl, ...o }));
  const autoRestart = spec.deps?.autoRestart ?? runAutoRestart;
  // 告警出口可注入（默认仍是既有 `alert`）—— 只为让夹具能断言"留痕真的发生了"（不是静默）；
  //   行为零变化：不注入时逐字调同一个 `alert`。
  const alertFn = spec.deps?.alert ?? alert;

  for (const item of plan.items) {
    // ⭐【2026-10-13 新增】ask-wait ⇒ **冻结**：不重启（不碰 P0 闸门）、不注入提醒、不升级，
    //    只留痕一条（告警 + items + 链条 history/字段 + 状态文件）。这是本改动的语义核心。
    if (item.action === ASK_WAIT_ACTION) {
      out.held += 1;
      const text = formatAskWaitText(item);
      out.items.push({
        sessionId: item.sessionId, action: ASK_WAIT_ACTION,
        status: dryRun ? 'dry-run' : 'held',
        reason: text,
        detail: { tool: item?.chain?.askWaitTool ?? null, callId: item?.chain?.askWaitCallId ?? null, idleMs: item.idleMs, ageMs: item.ageMs },
      });
      if (!dryRun) {
        try {
          alertFn({
            level: 'info', source: MODULE_ID,
            message: `会话在等主人回答提问 ⇒ 卡死自愈链已暂停（不提醒、不重启）：${item.sessionId.slice(0, 20)}…`,
            detail: { sessionId: item.sessionId, tool: item?.chain?.askWaitTool ?? null, callId: item?.chain?.askWaitCallId ?? null, idleMs: item.idleMs, ageMs: item.ageMs, held: true },
          }, { home });
        } catch { /* 报警失败不阻断 */ }
      }
      continue;
    }

    if (item.action === 'restart') {
      // 重启事由交给既有 p0-auto-restart（低水位判定 + 24h 去重 + 日上限 + 通道闸全在它那）
      let r;
      try {
        r = await autoRestart({
          home, now, dryRun,
          intents: [{
            id: `stuck:${item.sessionId}`,
            reason: `会话 ${item.sessionId.slice(0, 20)}… 卡死 ${Math.round(item.ageMs / MIN)} 分钟（回合未闭合无新事件）`,
            actor: MODULE_ID, at: now,
          }],
        }, { home, now });
      } catch (e) {
        r = { ok: false, status: 'failed', reason: e?.message ?? String(e), skipped: null };
      }
      const wrote = r?.status === 'executed' || (r?.requested ?? 0) > 0;
      out.items.push({ sessionId: item.sessionId, action: 'restart', status: r?.status ?? 'failed', reason: r?.reason ?? null, detail: r?.skipped ?? null });
      if (wrote && !dryRun) {
        plan.chains[item.sessionId] = { ...plan.chains[item.sessionId], restartIntentAt: now, restartBatchId: r?.plan?.batchId ?? null };
        state.restartLog[dayKey] = restartIntentsToday + 1;
        out.hints.push('restart-intent-written');
      } else if (r?.status === 'blocked' || r?.status === 'noop') {
        out.hints.push(`restart-${r.status}:${r?.reason ?? ''}`);
      } else if (!dryRun) {
        out.hints.push(`restart-not-fired:${r?.skipped?.reason ?? r?.reason ?? 'unknown'}`);
      }
      continue;
    }

    if (item.action === 'escalate') {
      out.items.push({ sessionId: item.sessionId, action: 'escalate', status: dryRun ? 'dry-run' : 'executed', reason: item.reason });
      if (!dryRun) {
        plan.chains[item.sessionId] = { ...plan.chains[item.sessionId], escalateAt: now };
        try {
          alertFn({
            level: 'warn', source: MODULE_ID,
            message: `卡死会话需要人工接手：${item.sessionId.slice(0, 20)}…（空闲 ${Math.round(item.idleMs / MIN)} 分钟）`,
            detail: { sessionId: item.sessionId, reason: item.reason, idleMs: item.idleMs },
          }, { home });
        } catch { /* 报警失败不阻断 */ }
      }
      out.executed += 1;
      continue;
    }

    // nudge1 / nudge2 / reinject ⇒ 注入（走 runAction 闸门）
    const text = formatNudgeText(item, { restartMs: cfg.restartMs });
    const mode = item.action === 'nudge2' ? 'steer' : 'queue';
    const r = await runAction({
      kind: NUDGE_KIND, level: NUDGE_LEVEL, dryRun, home, now,
      consumesQuota: true,
      sigKey: sigKeyOf(NUDGE_KIND, item.sessionId, item.action),
      detail: { sessionId: item.sessionId, action: item.action, idleMs: item.idleMs, mode },
      revertHint: '本动作只注入提醒文本：不改会话数据、不改看板、不改配置 → 误提醒忽略即可，无数据变更',
      preview: () => ({ sessionId: item.sessionId, action: item.action, mode, text }),
      execute: async () => {
        const rr = await inject(item.sessionId, text, { mode, timeoutMs: spec.injectTimeoutMs ?? 10_000 });
        return { ok: rr?.ok === true, error: rr?.error ?? null, mode, delivery: rr };
      },
    }, { home, now, executeTimeoutMs: spec.executeTimeoutMs });

    out.items.push({ sessionId: item.sessionId, action: item.action, status: r.status, reason: r.reason ?? null });
    if (r.status === 'dry-run') out.dryRunItems = (out.dryRunItems ?? 0) + 1;
    else if (r.status === 'executed') {
      out.executed += 1;
      if (!dryRun) {
        const c = plan.chains[item.sessionId] ?? { sessionId: item.sessionId };
        const patch = item.action === 'nudge1' ? { nudge1At: now } : item.action === 'nudge2' ? { nudge2At: now } : { reinjectAt: now };
        plan.chains[item.sessionId] = { ...c, ...patch, nudges: Number(c.nudges ?? 0) + (item.action === 'reinject' ? 0 : 1) };
      }
    } else if (r.status === 'failed') out.failed += 1;
    else if (r.status === 'noop') out.noop += 1;
    else out.blocked += 1;
  }

  const st = dryRun
    ? (out.failed ? 'failed' : 'dry-run')
    : (out.failed ? 'failed' : (out.executed ? 'executed' : (out.held ? 'held' : (out.noop ? 'noop' : 'blocked'))));
  out.action = { kind: MODULE_ID, status: st };
  out.status = st;
  out.reason = out.failed
    ? `有 ${out.failed} 项失败（下轮重试）`
    : (dryRun
      ? `dry-run：计划 ${out.planned} 项（${Object.entries(out.plan.summary.byAction).map(([k, v]) => `${k}×${v}`).join(' / ')}）`
      : (out.executed
        ? `已处理 ${out.executed} 项（${Object.entries(out.plan.summary.byAction).map(([k, v]) => `${k}×${v}`).join(' / ')}）`
        : (out.held
          ? `已冻结 ${out.held} 项（等主人回答提问，不提醒/不重启；${Object.entries(out.plan.summary.byAction).map(([k, v]) => `${k}×${v}`).join(' / ')}）`
          : `全部未执行（noop ${out.noop} / blocked ${out.blocked}）`)));

  // 6) 落状态（dry-run 不写）
  if (!dryRun) {
    try {
      const next = { schemaVersion: STUCK_RECOVERY_SCHEMA, updatedAt: now, chains: plan.chains, restartLog: state.restartLog };
      fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
      const dw = writeStateText(STUCK_STATE_FILE, JSON.stringify(next, null, 2) + '\n', {
        home, write: (p, t) => fs.writeFileSync(p, t, 'utf8'),
      });
      if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
      out.state = { saved: true, chains: Object.keys(plan.chains).length };
    } catch (e) {
      out.state = { saved: false, error: e?.message ?? String(e) };
    }
  } else {
    out.state = { saved: false, reason: 'dry-run' };
  }
  return out;
}

/** 一句话摘要（CLI / 日报用）。 */
export function summarizeStuckRecovery(r) {
  if (!r) return '（无结果）';
  const s = r.plan?.summary ?? {};
  return `卡死自愈 ${r.status ?? '-'} · 卡死 ${r.stuck ?? 0} · 计划 ${r.planned ?? 0} · 执行 ${r.executed ?? 0}`
    + `（${Object.entries(s.byAction ?? {}).map(([k, v]) => `${k}×${v}`).join(' / ') || '无动作'}）`
    + (r.failed ? ` · 失败 ${r.failed}` : '') + (r.blocked ? ` · 被拦 ${r.blocked}` : '')
    + (r.held ? ` · 冻结 ${r.held}（等主人回答提问，未提醒/未重启）` : '');
}
