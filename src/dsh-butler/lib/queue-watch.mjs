// dsh-butler / lib/queue-watch.mjs —— [Q1] 队列推进巡检 + 自动叫醒（B 主干）的判定与通知引擎
//
// 问题：看板 runner 把卡结算成「待验收(review)」后**不叫醒任何人**，下一张 once 卡也不会自己起
//       → 串行队列靠「主会话记得回来看」（实测 L1 卡 11:36 完成、11:45 才被推进）。
// 定位（2026-09-11 讨论定稿 · B 做主干）：tickd 每 1 分钟巡检看板，把「review 滞留」叫醒给
//       标题标【运行】的那个会话；**只提醒，不自动验收、不自动起卡**（自动接力属 P3，等放行）。
//
// 六条设计默认值（[Q1] 卡）：
//   ① tick 1 分钟（tickd job）② 目标会话**空闲才注入**（running=true 记 pending 下轮重试）
//   ③ 目标 = 标题**以**「【运行】」开头，**恰好 1 个才发**，0 个/多个 → 不发（退回落报告 + 桌宠）
//   ④ 通知后 30 分钟仍 review → 升级提醒一次（桌宠 + 日报段 + alert），**不重复注入**
//   ⑤ 队列关系不结构化（只判 review 滞留；文案里的「其后」只是同线待办的展示性提示）
//   ⑥ 裸跑期硬约束：不注册 P2 事件、不自动 run/confirm/reject、autonomy 四门保持 false
//
// 【2026-09-14 · 叫醒目标绑定 A 段：③ 从主判据降为**降级判据**】
//   背景：③ 实测两个失效模式 —— 档位躺平无人发现；目标不唯一就宁可不发（2026-09-14 15:37 实测 5 个【运行】
//   → ambiguous-target，一次都没发）。根因是"通知目标 ≠ 语义归属"：run 卡时没人记录谁发起的。
//   现在改走**降级链**（`pickTarget`，每一级都标注来源 `source`）：
//     ① 卡级绑定（`~/.dsh/queue-bindings.json` 的 cards[cardId]）且该会话**在本机存在** → 投给它
//     ② 同主线 owner（lines[card.line]）且会话存在                            → 投给它
//     ③ 回落标题判据（`pickNotifier`，恰好 1 个【运行】才发）                  → 投给它
//     ④ 都不行 → escalate（桌宠 + 日报段 + alert）
//   绑定会话在跑 → 与既有 `target-busy` 同款：**只排队，绝不打断**。坏绑定文件 = 无绑定（fail-safe，绝不误发）。
//   B 段（runner 写事件信箱带 initiator）/ C 段（run 带 requester）见 docs/。
//
// 三档（`butler-queue.json` 的 mode，**默认 observe**）：observe（零对外副作用，只写台账+日志）
//   → report（落日报段 + 桌宠）→ notify（注入会话）。放权路径不许跳档（CLI 需 --allow-skip-stage）。
//
// 复用底座（禁止另起一套）：lib/store.mjs（原子写 / RMW / tick 锁）、lib/alert.mjs（独立告警通道）、
//   lib/watch-notify.mjs（sayWhale / notifySession 通道）、lib/state-files.mjs（状态登记）、
//   lib/version.mjs（组件闸门）、lib/paths.mjs（home / 路径）。
// 事件信箱消费端（A 卡协议 v1）：`~/.dsh/queue-events.jsonl`（append-only，一行一条）。
//   本模块**只读消费** + 极端情况按 maxLines 裁剪；生产端在 `[Q2]` 卡（看板侧，暂未实现）——协议即接口，零代码耦合。
//
// 【V3功能面 · 失败卡通知档 · 2026-10-22】failed 卡也叫醒一次（同一条通道）
//   事故：2026-10-22 22:56 起卡 H-14 跑挂 —— 执行会话 `turn/end kind=error`（`EBUSY … session.v4.jsonl.zstd`）
//   ⇒ 卡落 `failed`、产物只做一半（缺交付报告）；**52 分钟无人知晓**（主人随口问才暴露）。
//   现查两套巡检都不管它：`lib/card-watchdog.mjs` 头注释写明「done / failed / todo / backlog 一律不算异常」；
//   `stuck-recovery` 管的是「会话挂着不结束 / 分身跑完不收尾」，不是已结算失败。
//   ⇒ 缺口 = **已经死透的卡没有任何出口**：review 会推、卡死会自愈，`failed` 只能靠人翻。
//   本档（纯增量，review 那条语义一字不动）：
//     · 候选 `pickFailedCards`：`status==='failed'` ∧ 未归档 ∧ 末条 execution `result==='failed'`；
//     · 三条「别吵」：宽限 3 分钟（`FAILED_GRACE_MS`）· 已有更新 execution（rerun）= 已接手 ⇒ 不推 ·
//       同一 execution 只推一次（`lastNotifiedExecutionId` 去重形态，状态落 `stats.failedNotify[cardId]`）；
//     · 通道与 review 同一套（卡级绑定 → 主线 owner → 标题唯一；无目标 ⇒ 落日报/桌宠/告警，绝不静默）；
//     · 来源标签 = `failed`（`stats.bySource.failed` + `day.events[].source`）；
//     · 开关 `cfg.failedNotify`（缺省**开**；`false` / `{enabled:false}` 一键关回 = 逐字旧行为）。
//   边界：状态**独立命名空间**（绝不写 `ledger.entries`，那是 review 的）；只在 notify 档真投；
//     超 `FAILED_TTL_MS`（6h）只落日报不注入；observe / report / dry-run 只算不投（不消费去重配额）。

import fs from 'node:fs';
import { hostRpc, hostRpcJson } from '../../lib/dsh-host-rpc.mjs';
import os from 'node:os';
import path from 'node:path';

import { dshHome, ensureDir, monthKey } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { readJson, writeTextAtomic, sleepSync } from './store.mjs';
import { writeStateText } from './dual-write.mjs';
import { updateStateJson } from './dual-write-store.mjs';
import { alert as sendAlert } from './alert.mjs';
import { sayWhale, notifySession } from './watch-notify.mjs';
import { BINDINGS_NAME, bindingsPath, loadBindings, bindCard as bindCardEntry, resolveCardBinding, resolveLineOwner } from './queue-bindings.mjs';
// 【卡 S2】通知改投的审计留痕（§8 四/五类事件）—— **走既有 appendAudit**（哈希链 prev/hash，不许裸写一行 JSON）
import { appendAudit } from './audit.mjs';
// 看板主线清账判定（P0 · 只读）：同 tick 复用本模块已采集的 tasks（零额外 IO）
import { boardCleanupTick } from './board-cleanup.mjs';
// 【2026-09-17 · Q6 采集抖动收口】会话采集失败 → 有限重试（唯一实现，与 ctx-guard 共用一份）
import { collectWithRetry, DEFAULT_RETRIES as DEFAULT_COLLECT_RETRIES, DEFAULT_RETRY_DELAY_MS as DEFAULT_COLLECT_RETRY_DELAY_MS } from './collect-retry.mjs';
// 【N12 · 2026-10-10】叫醒存亡确认（重启后补投兜底）—— 需要"目标会话尾部回合状态"这一个客观量。
//   · `classifyTail`           回合边界分类的**唯一实现**（lib/restart.mjs；P0/看板/collectSessionsLight 同一份口径）
//   · `discoverSessionFiles`   会话文件定位（lib/pitfall-scan.mjs；内部用 tools/lib/session-file-name.mjs 判文件名）
//   · `readSessionTail`        会话尾部解码（lib/watch-collect.mjs）
//   反向依赖已核：三者都不 import 本模块 ⇒ 不构成 ESM 循环。
import { classifyTail } from './restart.mjs';
import { discoverSessionFiles } from './pitfall-scan.mjs';
import { readSessionTail } from './watch-collect.mjs';
// 【G1G2 候选 C · 2026-09-25】「标了没交棒」巡检（判据 + 计划 + 只读观察档）
//   口径真源：`docs/` §5.1/§5.2；过审见 `方案复审…-v3轻量复审-20260925.md` §0
//   · 新库**零本地依赖**（HTTP/文件 IO 全部由本模块注入）⇒ 可离线单测；反向依赖为零 ⇒ 不构成 ESM 循环。
import {
  judgeDanglingHandoffs, planRelayHandoffWatch, renderObserveDoc, writeObserveDoc, observeDocPath,
  loadRelayHandoffWarnState, WARN_STATS_KEY,
  // 【改动 1 · 断链看门狗 · 2026-09-29】同库新增导出（**纯新增**，上面几个函数的语义一行未改）
  judgeChainSilence, planChainWatchdog, applyWatchdogOutcome, pruneWatchdogState,
  loadWatchdogState, saveWatchdogState, watchdogStatePath, listHandoffDocs, pickHandoffDocPath,
  renderWatchdogText, renderWatchdogDoc, watchdogDocPath, CHAIN_ACTION,
} from './relay-handoff-watch.mjs';
// 【改动 1】看门狗开关载体 = `butler-autonomy-limits.json#relayWatchdog`（缺省即关 ⇒ 零 IO/零动作）。
//   `readLimits` 与本次新逻辑同属 butler 线内部件，且 `autonomy-actions.mjs` **不反向 import 本模块**
//   ⇒ 不构成 ESM 循环（已核）。
import { readLimits } from './autonomy-actions.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../lib/production-guard.mjs';

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


export const QUEUE_VERSION = '0.1.0';
export const QUEUE_SCHEMA = 1;          // 台账 schemaVersion
export const QUEUE_CONFIG_SCHEMA = 1;   // 配置 schemaVersion
/** 【2c-B2】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, opts = {}) {
  return resolveStatePath(name, { home: opts.home ?? dshHome() }).path;
}
export const LEDGER_NAME = 'butler-queue-notify.json';
export const CONFIG_NAME = 'butler-queue.json';
export const INBOX_NAME = 'queue-events.jsonl';
export const DEFAULT_BASE_URL = 'http://localhost:3080';
export const RUN_MARK = '【运行】';
export const MODES = ['observe', 'report', 'notify'];

// 【G3 · 卡被打断 ⇒ 叫醒 owner（候选 B）】打断通道常量（唯一权威源；CLI / 单测 / 日报渲染都读这里）
//   · DAY_LIMIT  单日上限（按**风暴汇总后**的注入条数计；被挡的仍进日报，不丢信息）
//   · TTL_MS     新鲜度窗口：超 12h 的旧打断**不注入、落 report**（防重启后一次性补发历史）
//   · MIN_AGE_MS 下限 1 个 tick：结算瞬时/时钟抖动期间不判（下一轮再判，不丢）
//   · STORM_MIN  同轮 ≥3 张 ⇒ 汇总一条（逐卡明细进日报）
export const INTERRUPT_DAY_LIMIT = 6;
export const INTERRUPT_TTL_MS = 12 * 3600_000;
export const INTERRUPT_MIN_AGE_MS = 60_000;
export const INTERRUPT_STORM_MIN = 3;
export const INTERRUPT_KEEP_MAX = 200;
// 【候选补丁 · 2026-10-13 · 未落生产】超期打断（interrupt-expired）重报节流窗口：
//   原实现该分支无去重（且排在去重闸之前）⇒ 只要卡仍停在 todo/backlog 且末条 execution 是 interrupted，
//   每轮 tick（60s）都会产一条 interrupt-report + 落日报段 + 写台账（实测 2026-10-13 当日 events 26 条里 21 条 = 同一条重复）。
//   本闸：同一 executionId 在窗口内只报一次（跨窗口仍再报 ⇒ 不违反 G3「绝不静默」）。
export const INTERRUPT_REPORT_REPEAT_MS = 24 * 3600_000;

// 【卡 S2 · 阶段 1 改投】方案 §6.1「改投实现口径」常量（同一事实只许一处权威源）
//   · HANDOFF_MARK        §6.1 三步走 条件①：目标标题**以**此开头 ⇒ 判已交棒（前缀匹配，不用"包含"）
//   · RELAY_LEDGER_NAME   会话接力台账（阶段 1 主卡 session-relay.mjs 写，**本模块只读**、缺失即"无数据"）
//   · REROUTE_GRACE_MS    K-27 时序竞态宽限：快照未命中但 handoffAt 在 10 分钟内 ⇒ 保守不判"找不到"
//   · SKIP_REASON_*       K-12② 显式 skip reason（**不进 report / escalate**）；来源档见 SOURCE_HANDOFF_REROUTE
export const HANDOFF_MARK = '【已交接】';
/**
 * 【2026-09-22 · 接力轴可见性修复（主人拍板）】判「标题是否带接力轴【已交接】」——**兼容两形态**：
 *   · `【已交接】X`         —— session-mark 刚标好（把状态轴替换掉）时的形态；
 *   · `【完成】【已交接】X` —— 跑过回合边界后 title-live 的 turn-mark 叠上状态轴后的形态
 *     （插件修复前这一层会被写成 `【完成】X`、接力轴直接丢失 ⇒ §6.1 条件① 静默失效）。
 * ⚠️ 仍只认**前缀段**（绝不用"包含"）：形如 `【完成】会话标题自动打标（插件钩子：【已交接】…）`
 *    不许被误判；词表外的 `【…】`（如 `【跨机同步】`）一律不当状态轴。
 */
const HANDOFF_STATE_AXES = ['【运行】', '【完成】', '【待续】', '【待命】', '【已中断】', '【续】'];
export function hasHandoffMark(title) {
  if (typeof title !== 'string') return false;
  let rest = title.trimStart();
  for (let depth = 0; depth < 4; depth++) {
    if (rest.startsWith(HANDOFF_MARK)) return true;
    const hit = HANDOFF_STATE_AXES.find((p) => rest.startsWith(p));
    if (hit === undefined) return false;
    rest = rest.slice(hit.length).trimStart();
  }
  return false;
}
/** 【2c-B2】接力台账路径（唯一读点走这里；legacy 期 = 旧名）。 */
function relayLedgerFileOf(home = dshHome()) {
  return resolveStatePath(RELAY_LEDGER_NAME, { home }).path;
}
export const RELAY_LEDGER_NAME = 'butler-relay.json';
export const REROUTE_GRACE_MS = 600_000;
export const SKIP_REASON_HANDOFF_MISSING = 'handoff-window-missing';
export const SKIP_REASON_HANDOFF_GRACE = 'handoff-reroute-pending';
export const SOURCE_HANDOFF_REROUTE = 'handoff-reroute';
// 【V3功能面 · 失败卡通知档】通道来源标签：`failed` = 本次投递由「failed 卡叫醒」档发起（与 review 的 notify 区分）。
//   ⚠️ 它只在 `stats.bySource` / `day.events[].source` / 状态条目 `source` 里用；**目标来源**（binding / line-owner /
//   fallback / handoff-reroute）仍单独记在 `targetSource`，两者不混。
export const SOURCE_FAILED = 'failed';
/** 目标来源四档 + 改投档 + 失败卡通知档（K-12①：白名单与日报渲染**同一份**，避免"新档被静默归 none"）。 */
export const SOURCE_KEYS = ['binding', 'line-owner', 'fallback', SOURCE_HANDOFF_REROUTE, SOURCE_FAILED, 'none'];

// 【V3功能面 · 失败卡通知档】三条「别吵」常量（**独立定义**：刻意不复用 COLLECT_ALERT_COOLDOWN_MS = 30min，
//   那个是"采集失败告警限流"，与本档语义无关；也不要拿 escalateAfterMs 当宽限——那是 review 滞留升级线）。
//   · FAILED_GRACE_MS  宽限：末条执行结束到 now < 3 分钟 ⇒ 不推（留给人肉立刻重跑的余地，避免和手动重跑撞车）
//   · FAILED_TTL_MS    新鲜度上界：超 6 小时的失败只落日报/桌宠/告警，**不注入**（免得叫醒一条三天前的旧账）
//   · FAILED_KEEP_MAX  状态条目上限（按 lastSeenAt 淘汰最旧；防止台账无限膨胀）
export const FAILED_GRACE_MS = 3 * 60_000;
export const FAILED_TTL_MS = 6 * 3600_000;
export const FAILED_KEEP_MAX = 200;

/** 配置默认值（`butler-queue.json`；缺失/损坏 → 用这份，fail-safe 取最保守的 observe）。 */
export const DEFAULT_CONFIG = {
  schemaVersion: QUEUE_CONFIG_SCHEMA,
  mode: 'observe',
  escalateAfterMs: 30 * 60_000,
  targetPrefix: RUN_MARK,
  inbox: { enabled: true, maxLines: 1000, pruneAfterDays: 7 },
  dailyReport: true,
  // 双判据第二半（[Q1] 卡 12:0x 设计补充）：卡的执行会话仍在 running → 疑似假结算，绝不叫醒。
  // 关掉它等于退回"只看看板 status"，只在排障时临时关。
  checkExecutionAlive: true,
  // 【V3功能面 · 失败卡通知档】缺省**开**（未写此键 = 开）。一键关回：`failedNotify:false`（或 `{enabled:false}`）
  //   ⇒ 整段不跑、result 无 failedNotify 字段、台账无新增键（逐字旧行为）。对象形态可覆盖阈值：
  //   `{ enabled:true, graceMs, ttlMs }`（单位毫秒；非法值回落常量）。
  failedNotify: true,
  // 【N12 · 2026-10-10 · 重启后「叫醒验收方」兜底】**叫醒存亡确认**（候选态，默认关）。
  //   治的病（2026-10-10 凌晨实证 6.5h 静默）：卡进 review → 队列叫醒注入成功 → **4 秒后 P0 重启**
  //   把该会话刚起的回合打断（`turn/end reason=interrupted`）⇒ 叫醒被吞；台账已记 `notifiedAt`
  //   ⇒ 去重签名把它当"已通知"，此后**再无任何机制重投**（详见交付报告 §2 根因链）。
  //   判据（只用客观量，全部可复算）：目标会话尾部回合 = `interrupted` **且** 已静默 ≥ minIdleMs
  //   **且** 目标 running=false **且** 该卡 `notifiedAt` 已过 minAgeMs ⇒ 补投一次（≤maxRetries 次）。
  //   边界：`open`（回合未闭合）**不归本机制管** —— 那是 `stuck-recovery` 卡死会话自愈链的职责，
  //     两条链刻意不重叠，避免同一会话收到两条同源提醒。
  wakeReceipt: { enabled: false, minAgeMs: 120_000, maxAgeMs: 6 * 3600_000, minIdleMs: 120_000, maxRetries: 1 },
  updatedAt: null,
  updatedBy: null,
};

export const LEDGER_DEFAULT = {
  schemaVersion: QUEUE_SCHEMA,
  entries: {},
  inbox: { offset: 0, size: 0, consumedKeys: [], lastReadAt: null, eventsSeen: 0, resets: 0 },
  day: { day: null, events: [] },
  stats: {
    ticks: 0, notified: 0, reported: 0, escalated: 0, cleaned: 0, lastTickAt: null, lastMode: null,
    // A 段（叫醒目标绑定）：目标来源累计 + 上次投递结果（日报段与 --status 用它治"隐形失效"）
    bySource: { binding: 0, 'line-owner': 0, fallback: 0, [SOURCE_HANDOFF_REROUTE]: 0, none: 0 },
    lastNotify: null,
    // 【2026-09-17 · Q6】采集健康（治"整轮跳过静默"）：失败不再只是 %TEMP% 日志里的一行。
    //   collectFailures   = 累计失败轮数（不因恢复清零）
    //   collectFailStreak = **当前连败轮数**（采集成功一轮即归零）
    //   collectAlertAt    = 上次失败**告警**时刻（限流用；见 COLLECT_ALERT_COOLDOWN_MS）
    //   collectAlertCount = 累计发出的失败告警条数（用来核对"限流真的生效了"）
    collectFailures: 0,
    collectFailStreak: 0,
    collectFailFirstAt: null,
    collectFailLastAt: null,
    collectFailLastReason: null,
    collectAlertAt: null,
    collectAlertCount: 0,
    collectRecoveredAt: null,
    // 【K-14】接力台账 TTL 巡检的本地状态（幂等键等）—— 放 `stats` 里才会被 saveLedger 落盘
    //   （`warnedKey` = `${sourceSessionId}|${handoffAt}`：同一交接条目的超时告警**只喊一次**）
    relayTtl: null,
  },
};

const MAX_DAY_EVENTS = 50;
const MAX_CONSUMED_KEYS = 500;
const LOG_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------- 小工具

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function hhmm(now = Date.now()) {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function deviceName() {
  try { return os.hostname(); } catch { return process.env.COMPUTERNAME ?? 'unknown'; }
}

/** 日志文件（%TEMP%，不占 .dsh 状态、不进备份；DSH_QUEUE_LOG 可覆盖）。 */
export function logFile() {
  return process.env.DSH_QUEUE_LOG || path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-queue.log');
}

/** 写一行日志（1MB 轮转）+ 同步 stderr/标准输出（人工跑时可见）。 */
export function logLine(msg, opts = {}) {
  const line = `[${new Date(opts.now ?? Date.now()).toISOString()}] ${msg}`;
  try {
    const file = opts.file ?? logFile();
    ensureDir(path.dirname(file));
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > LOG_MAX_BYTES) fs.writeFileSync(file, '', 'utf8');
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch { /* 日志失败绝不影响主流程 */ }
  if (opts.quiet !== true) {
    try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
  }
}

function firstNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ---------------------------------------------------------------- 配置

export function configPath(home = dshHome()) {
  return stateFileOf(CONFIG_NAME, { home });
}
export function ledgerPath(home = dshHome()) {
  return stateFileOf(LEDGER_NAME, { home });
}
export function inboxPath(home = dshHome()) {
  return path.join(home, INBOX_NAME);
}

/** 读配置（缺失/损坏/版本不符 → 默认 observe，绝不因配置问题放大权限）。 */
export function loadConfig(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = configPath(home);
  try {
    const raw = readJson(file, { schemaVersion: QUEUE_CONFIG_SCHEMA, home, defaultValue: null });
    if (!raw) return { ...DEFAULT_CONFIG, file, exists: false };
    return {
      ...DEFAULT_CONFIG, ...raw,
      inbox: { ...DEFAULT_CONFIG.inbox, ...(raw.inbox ?? {}) },
      // 【N12】嵌套对象必须逐字段合并：浅合并会让"只写了一个键的局部配置"把其余默认值抹成 undefined
      wakeReceipt: { ...DEFAULT_CONFIG.wakeReceipt, ...(raw.wakeReceipt ?? {}) },
      file, exists: true,
    };
  } catch (e) {
    logLine(`⚠️ 读配置失败，回落默认 observe：${e?.message ?? e}`, { quiet: opts.quiet });
    return { ...DEFAULT_CONFIG, file, exists: false, error: e?.message ?? String(e) };
  }
}

/** 写配置（原子写；CLI `--mode` 用）。 */
export function saveConfig(patch, opts = {}) {
  const home = opts.home ?? dshHome();
  const file = configPath(home);
  const cur = loadConfig({ home, quiet: true });
  const next = {
    ...cur,
    ...patch,
    schemaVersion: QUEUE_CONFIG_SCHEMA,
    inbox: { ...cur.inbox, ...(patch.inbox ?? {}) },
    // 【N12】同 loadConfig：嵌套对象逐字段合并（`--receipt on` 只动 enabled，其余阈值保持）
    wakeReceipt: { ...(cur.wakeReceipt ?? DEFAULT_CONFIG.wakeReceipt), ...(patch.wakeReceipt ?? {}) },
    updatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    updatedBy: opts.actor ?? process.env.DSH_SESSION_ID ?? 'cli',
  };
  delete next.file; delete next.exists; delete next.error;
  const dw = writeStateText(CONFIG_NAME, JSON.stringify(next, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return { ok: true, file, config: next };
}

/** 设置档位；跳档（observe→notify）必须显式 allowSkip。 */
export function setMode(mode, opts = {}) {
  if (!MODES.includes(mode)) return { ok: false, error: `mode 必须是 ${MODES.join('|')}` };
  const cur = loadConfig({ home: opts.home, quiet: true });
  if (mode === 'notify' && cur.mode === 'observe' && opts.allowSkipStage !== true) {
    return {
      ok: false,
      error: '分档放权路径不许跳档（observe → report → notify）：确认无误后加 --allow-skip-stage',
      current: cur.mode,
    };
  }
  const r = saveConfig({ mode }, opts);
  return { ok: true, mode, previous: cur.mode, file: r.file };
}

// ---------------------------------------------------------------- 台账

/** 读台账（走 store 唯一入口；缺失 → 默认结构）。 */
export function loadLedger(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = ledgerPath(home);
  const data = readJson(file, { schemaVersion: QUEUE_SCHEMA, home, defaultValue: null });
  if (!data) return { ...structuredClone(LEDGER_DEFAULT), file, exists: false };
  return {
    ...structuredClone(LEDGER_DEFAULT),
    ...data,
    entries: { ...(data.entries ?? {}) },
    inbox: { ...LEDGER_DEFAULT.inbox, ...(data.inbox ?? {}) },
    day: { ...LEDGER_DEFAULT.day, ...(data.day ?? {}) },
    stats: { ...LEDGER_DEFAULT.stats, ...(data.stats ?? {}) },
    file,
    exists: true,
  };
}

/** 写台账（RMW 原子写）。 */
export function saveLedger(ledger, opts = {}) {
  const home = opts.home ?? dshHome();
  const file = ledgerPath(home);
  const next = {
    schemaVersion: QUEUE_SCHEMA,
    device: deviceName(),
    updatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    entries: ledger.entries ?? {},
    inbox: ledger.inbox ?? LEDGER_DEFAULT.inbox,
    day: ledger.day ?? LEDGER_DEFAULT.day,
    stats: ledger.stats ?? LEDGER_DEFAULT.stats,
  };
  if (opts.dryRun) return { ok: true, file, dryRun: true };
  updateStateJson(LEDGER_NAME, file, () => next, { schemaVersion: QUEUE_SCHEMA, home, defaultValue: next });
  return { ok: true, file };
}

// ---------------------------------------------------------------- 只读采集

/** 看板 state（只读；本机一律 localhost）。 */
export async function readBoard(opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const r = await fetchImpl(`${baseUrl}/api/task-board/state`, {
      headers: {
        origin: baseUrl,
        'sec-fetch-site': 'same-origin',
        // 【看板瘦身 · 2026-09-24】只取未归档卡。
        // 为什么：生产账本 609 张卡 / 6 MB，其中归档 + 早已做完的卡占 96%，
        // 而本模块的全部消费方（queue 叫醒 / card-watchdog 盯卡 / 主线清账 /
        // 绑卡 CLI）看的都是**在途卡**。每分钟把整本 6 MB 序列化+传输到本地，
        // 正是把 dsh 主线程压住几十秒、被守护鱼判成"卡死"强杀的负载来源。
        // 副作用（已知、可接受）：board-cleanup 的提示文案里「另有归档 N 张」
        // 会算成 0 —— 它的判定口径是"在板卡是否全 done"，与归档数无关。
        // 需要全量历史的读者（查重 / 快照导出 / 归档页）保持不带头 = 全量。
        'x-dsh-board-scope': 'live',
        // 【卡 面板③·取数 · S1】可选条件请求：调用方给出上次看板 revision 时带 If-None-Match，
        //   看板命中即回 304（`host-routes.ts#matchesRevision`：短路在快照构建之前 ⇒ 省掉 3.1 MB 序列化）。
        //   **只有显式 opt-in 的调用方**会拿到 304；其余调用方行为逐字节不变。
        ...(typeof opts.ifNoneMatch === 'string' && opts.ifNoneMatch ? { 'if-none-match': opts.ifNoneMatch } : {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    // 【卡 面板③·取数 · S1】304 = 看板没变：显式回 notModified（不解析 3.1 MB，也不返回 tasks/review）。
    if (r.status === 304) {
      const raw = String(r.headers?.get?.('etag') ?? '').replace(/^W\//, '').replace(/"/g, '');
      const rev = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
      return { ok: true, notModified: true, revision: rev, tasks: [], review: [] };
    }
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, tasks: [], review: [] };
    const j = await r.json();
    const tasks = Array.isArray(j?.tasks) ? j.tasks : [];
    return { ok: true, revision: j?.revision ?? null, tasks, review: pickReviewCards(tasks) };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), tasks: [], review: [] };
  }
}

/** 取「待验收」卡（纯函数；归档卡不算）。executions 原样带上——双判据要用（字段名是 executions 不是 runs）。 */
export function pickReviewCards(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.status === 'review' && !t.archivedAt)
    .map((t) => ({
      id: String(t.id),
      title: String(t.title ?? ''),
      seq: t.seq ?? null,
      line: t.line ?? null,
      kind: t.kind ?? 'once',
      status: 'review',
      createdAt: Number(t.createdAt ?? 0) || null,
      updatedAt: Number(t.updatedAt ?? 0) || null,
      executions: Array.isArray(t.executions) ? t.executions : [],
      settledAt: null,
    }));
}

/**
 * 【G3 · 候选 B 第 1 行】打断事实（纯函数）：从看板卡末条 execution 取"这一次打断"的可展示事实。
 * ⚠️ 事实字段（endedAt / error）**只在本轮内存里传递**（注入文案 + 日报），**绝不落 queue 台账**
 *   —— 台账真源仍是看板 `executions[]`（方案 §3.9 载体归属）。
 */
export function interruptFact(card, ex) {
  const list = Array.isArray(card?.executions) ? card.executions : [];
  const raw = list.filter((e) => e && typeof e === 'object').slice(-1)[0] ?? {};
  return {
    executionId: ex?.id ? String(ex.id) : null,
    sessionId: ex?.sessionId ?? null,
    startedAt: ex?.startedAt ?? null,
    endedAt: ex?.endedAt ?? null,
    error: raw.error ? String(raw.error) : null,
  };
}

/**
 * 【G3 · 候选 B 第 1 行】取「被打断回待办」的卡（**纯函数**，形状与 `pickReviewCards` 同族）。
 * 判据（八闸 ①②）= 卡 `status ∈ {todo, backlog}`（结算语义：interrupted ⇒ 回 todo）+ **末条** execution `result === 'interrupted'`。
 * 与 review 卡的区别：**保留 `status` 原值**（decide 的打断分支据此与 review 守卫区分），另带 `interrupted: true` 标记。
 */
export function pickInterruptedCards(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && !t.archivedAt && (t.status === 'todo' || t.status === 'backlog'))
    .map((t) => ({ t, ex: lastExecution(t) }))
    .filter(({ ex }) => Boolean(ex) && ex.result === 'interrupted')
    .map(({ t, ex }) => ({
      id: String(t.id),
      title: String(t.title ?? ''),
      seq: t.seq ?? null,
      line: t.line ?? null,
      kind: t.kind ?? 'once',
      status: t.status,
      createdAt: Number(t.createdAt ?? 0) || null,
      updatedAt: Number(t.updatedAt ?? 0) || null,
      executions: Array.isArray(t.executions) ? t.executions : [],
      settledAt: null,
      interrupted: true,
      interruptedFact: interruptFact(t, ex),
    }));
}

/**
 * 【G3】打断分支的状态载体（**独立命名空间**：tick 只把它挑字段写进 `stats.interrupted[cardId]`，**绝不写 `entries`**）。
 * 只放去重/状态键，**不复制判据事实**（§3.9：result/endedAt/error 的真源是看板 executions[]）。
 */
function interruptPatch(card, fact, st, now) {
  return {
    taskId: card.id,
    title: card.title,
    seq: card.seq ?? null,
    line: card.line ?? null,
    executionId: fact?.executionId ?? null,   // ← buildItems 的 eventKeyRaw 取这里（R7）
    firstSeenAt: Number(st?.firstSeenAt ?? 0) || now,
    lastSeenAt: now,
  };
}

/**
 * 【G3 · 候选 B 第 4 行】打断通道判定（**纯函数**）。返回 `null` = 本分支不适用（走既有 review 路径，逐字不变）。
 *
 * ⚠️ 三条施工硬约束（复审 §7 + 方案 §3 候选 B 第 4 行）：
 *   ① **mode 首判**：本分支插在 `:1069` review 守卫**之前** ⇒ 也早于 `:1095 if (mode === 'observe')` 早退 ⇒
 *      非 notify 档（observe / report / `--dry-run` / `--status`）**只登记不动作**（不产 `interrupt-notify`、不写 stats）。
 *   ② **目标回传**：本分支在 `:1087 const n = pickTarget(...)` **之前**执行 ⇒ 既有 `n` 尚在 TDZ（引用即 ReferenceError）⇒
 *      必须**自行** `pickTarget(...)` 并回传 `detail: { notifier: n }`（**不得**只放进 `patch`）。
 *   ③ **自带完整过滤**：`card &&` + `status ∈ {todo,backlog}` + 末条 `interrupted`（`card === null` 的清理项仍走老路径）。
 *
 * 八闸顺序（方案总则 (vi)）：①事实 → ②状态 → ③新鲜度 → ④去重 → ⑥目标 →（⑦风暴 + ⑤额度在 `planTick` 后处理）→ 动作。
 */
export function decideInterrupted(ctx) {
  const { card, exec = null, interruptedDay = null, interruptedEntry = null, now, mode = 'observe', binding = null, lineOwner = null, notifier = null } = ctx ?? {};
  if (!card) return null;
  if (card.status !== 'todo' && card.status !== 'backlog') return null;
  const ex = lastExecution(card);
  if (!ex || ex.result !== 'interrupted') return null;                       // ① 事实闸
  const fact = card.interruptedFact ?? interruptFact(card, ex);
  if (mode !== 'notify') {                                                    // R11：只登记不动作
    return { action: 'skip', reason: 'interrupt-observe-mode', detail: { interrupted: fact } };
  }
  if (exec && exec.alive === true) {                                           // 还在跑 ⇒ 下轮再看（保守）
    return { action: 'skip', reason: 'interrupt-execution-alive', detail: { interrupted: fact, exec } };
  }
  const st = interruptedEntry ?? {};
  const dayCount = String(interruptedDay?.day ?? '') === dayKey(now) ? (Number(interruptedDay?.count ?? 0) || 0) : 0;
  const patch = interruptPatch(card, fact, st, now);
  // ③ 新鲜度闸：≥1 tick 且 ≤12h；超期**不注入、落 report**（不静默丢弃）
  const endedAt = Number(fact.endedAt ?? 0) || 0;
  const ageMs = endedAt ? Math.max(0, now - endedAt) : Number.POSITIVE_INFINITY;
  if (ageMs < INTERRUPT_MIN_AGE_MS) {
    return { action: 'skip', reason: 'interrupt-too-fresh', patch, detail: { interrupted: fact } };
  }
  if (!(ageMs <= INTERRUPT_TTL_MS)) {
    // 【候选补丁 · 2026-10-13 · 未落生产】③b 超期重报节流闸（③ 新鲜度闸的 expired 支路专用）
    //   原实现：本分支直接 return（**在 ④ 去重闸之前**，且不落任何去重键）⇒ 同一条历史打断每轮 tick 重报一次。
    //   现值：同一 executionId 在 INTERRUPT_REPORT_REPEAT_MS（默认 24h）内只报一次；跨窗口仍再报（不静默）。
    const lastRepExec = String(st.lastReportedExecutionId ?? '') || null;
    const lastRepAt = Number(st.lastReportedAt ?? 0) || 0;
    if (lastRepExec && lastRepExec === String(fact.executionId ?? '') && (now - lastRepAt) < INTERRUPT_REPORT_REPEAT_MS) {
      return { action: 'skip', reason: 'interrupt-report-throttled', patch, detail: { interrupted: fact, ageMs, lastReportedAt: lastRepAt } };
    }
    return {
      action: 'interrupt-report',
      reason: 'interrupt-expired',
      patch: { ...patch, lastReportedExecutionId: fact.executionId ?? null, lastReportedAt: now },
      detail: { interrupted: fact, ageMs },
    };
  }
  // ④ 去重闸：**同一次打断**（同一 executionId）只注入一次；同卡新 executionId 可再通知
  if (st.lastNotifiedExecutionId && String(st.lastNotifiedExecutionId) === String(fact.executionId)) {
    return { action: 'skip', reason: 'interrupt-already-notified', patch, detail: { interrupted: fact } };
  }
  // ⑤ 单日额度（已注入计数；精确的"按汇总后条数计"由 planTick 的 applyInterruptGates 补）
  if (dayCount >= INTERRUPT_DAY_LIMIT) {
    return { action: 'interrupt-report', reason: 'interrupt-day-limit', patch, detail: { interrupted: fact, dayCount } };
  }
  // ⑥ 目标闸：降级链（卡级绑定 → 主线 owner → 标题唯一）；**自行 pickTarget**（不能用 :1087 的 n —— TDZ）
  const n = pickTarget({ binding, lineOwner, notifier: notifier ?? { kind: 'none', count: 0 } });
  const detail = { notifier: n, interrupted: fact };
  if (n.kind === 'none' || n.kind === 'ambiguous') {
    return {
      action: 'interrupt-report',
      reason: n.kind === 'none' ? 'interrupt-no-target' : 'interrupt-ambiguous-target',
      patch, detail,
    };
  }
  if (n.running === true) {                                                    // 目标在跑 ⇒ 只排队，绝不打断
    return { action: 'skip', reason: 'interrupt-target-busy', patch: { ...patch, pendingSince: Number(st.pendingSince ?? 0) || now, pendingReason: 'target-busy' }, detail };
  }
  return {
    action: 'interrupt-notify',
    reason: 'interrupt-target-idle',
    patch: { ...patch, targetSource: n.source ?? null, targetSessionId: n.sessionId ?? null },
    detail,
  };
}

// ---------------------------------------------------------------- 失败卡通知档（[V3功能面] · 2026-10-22）
//
// 判据/状态/文案三件都在这里（纯函数；IO 全由 runTick 编排）：
//   · pickFailedCards   候选：status=failed ∧ 未归档 ∧ 末条 execution result=failed
//   · decideFailed      八闸：事实 → 执行存活 → 宽限 → 去重 → TTL → 档位 → 目标 → 动作
//   · failedFact        本次失败的事实（endedAt / error 首行 / 产物线索）——**只在本轮内存里传递**，
//                       绝不把 error/产物复制进台账（真源仍是看板 `executions[]` 与卡 description/prompt）
//   · formatFailedText  注入/日报文案（一句话说清：哪张卡 · 什么时候挂的 · 错误首行 · 产物缺口 · 你可以 rerun）

/** 开关解析（缺省开；`false` / `{enabled:false}` = 关；对象形态可覆盖 graceMs / ttlMs）。 */
export function failedNotifySettings(cfg = DEFAULT_CONFIG) {
  const raw = cfg?.failedNotify;
  if (raw === false || (raw && typeof raw === 'object' && raw.enabled === false)) {
    return { enabled: false, graceMs: FAILED_GRACE_MS, ttlMs: FAILED_TTL_MS };
  }
  const pick = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    enabled: true,
    graceMs: pick(raw?.graceMs, FAILED_GRACE_MS),
    ttlMs: pick(raw?.ttlMs, FAILED_TTL_MS),
  };
}

/**
 * 产物缺口线索（纯函数，**只读卡文本**）：从 `description` / `prompt` 里抽 1~2 个产物路径。
 * 为什么从文本抽：看板卡没有结构化的「必交产物」字段，而卡描述/提示词里通常写着
 * `docs/` 这类路径 —— 失败时它是"哪些产物可能没写入"的最直接线索（H-14 事故就是缺交付报告）。
 * 抽不到就如实回空数组（文案写「卡里没写产物路径」），**绝不编**。
 */
export function failedDeliverableHint(card) {
  const text = `${card?.description ?? ''}\n${card?.prompt ?? ''}`;
  const out = [];
  const re = /(?:[A-Za-z]:[\\/]|docs[\\/])[^\s，。；;、）)】\]"'<>|]+\.(?:md|docx|xlsx|pptx|json|txt)/g;
  for (const m of text.matchAll(re)) {
    const p = String(m[0]).replace(/[，。、；;：:）)】\]"'`]+$/g, '');
    if (!p || out.includes(p)) continue;
    out.push(p);
    if (out.length >= 2) break;
  }
  return out;
}

/** 本次失败的事实（`executions[]` 末条；endedAt / error 首行 / 产物线索）。 */
export function failedFact(card) {
  const ex = lastExecution(card);
  if (!ex) return null;
  const raw = (Array.isArray(card?.executions) ? card.executions : []).filter((e) => e && typeof e === 'object').slice(-1)[0] ?? {};
  const error = raw.error ? String(raw.error) : null;
  const firstLine = error ? (error.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '') : null;
  return {
    executionId: ex.id ? String(ex.id) : null,
    sessionId: ex.sessionId ?? null,
    startedAt: Number(ex.startedAt ?? 0) || null,
    endedAt: Number(ex.endedAt ?? 0) || null,
    result: ex.result ?? null,
    error,
    errorFirstLine: firstLine ? firstLine.slice(0, 200) : null,
    deliverables: failedDeliverableHint(card),
  };
}

/**
 * 取「执行失败」的卡（**纯函数**，形状与 `pickReviewCards` / `pickInterruptedCards` 同族；归档卡不算）。
 * 「已被接手」的判据落在候选层：候选要求**末条** execution `result==='failed'`；一旦 rerun，
 * 新 execution 成为末条（result 为空 / running / succeeded）⇒ 自然不候选 ⇒ 不推。
 */
export function pickFailedCards(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.status === 'failed' && !t.archivedAt)
    .map((t) => ({ t, fact: failedFact(t) }))
    .filter(({ fact }) => Boolean(fact) && fact.result === 'failed')
    .map(({ t, fact }) => ({
      id: String(t.id),
      title: String(t.title ?? ''),
      seq: t.seq ?? null,
      line: t.line ?? null,
      kind: t.kind ?? 'once',
      status: 'failed',
      createdAt: Number(t.createdAt ?? 0) || null,
      updatedAt: Number(t.updatedAt ?? 0) || null,
      executions: Array.isArray(t.executions) ? t.executions : [],
      settledAt: null,
      failed: true,
      failedFact: fact,
    }));
}

/**
 * 【失败卡通知档】判定（**纯函数**）。返回 `null` = 本档不适用（开关关 / 非候选卡）。
 *
 * 闸门顺序：① 开关 → ② 事实（必须有 executionId，否则无法去重 ⇒ 宁可不推）→ ③ 执行会话存活（不打断）
 *   → ④ 去重（同一 execution 只推一次；已推超 escalateAfterMs 仍未处理 ⇒ 升级一次）
 *   → ⑤ 宽限（3 分钟）→ ⑥ 档位（非 notify 只算不投）→ ⑦ TTL（>6h 只落日报）→ ⑧ 目标（降级链 + 空闲）
 *
 * 状态载体 = `ledger.stats.failedNotify[cardId]`（**独立命名空间**；绝不写 `entries`）。
 * @returns {{action:string, reason:string, source?:string, patch?:object, detail?:object}|null}
 *   action ∈ failed-notify | failed-report | failed-escalate | failed-skip
 */
export function decideFailed(input = {}) {
  const {
    card, state = null, now, mode = 'observe', cfg = DEFAULT_CONFIG,
    binding = null, lineOwner = null, notifier = null, handoff = null,
  } = input ?? {};
  const sw = failedNotifySettings(cfg);
  if (!sw.enabled) return null;                                  // ① 开关（关 = 逐字旧行为）
  if (!card || card.failed !== true) return null;                // ② 非候选
  const fact = card.failedFact ?? failedFact(card);
  // 没有 executionId ⇒ 无法去重 ⇒ 不推（不猜）；末条不是 failed（rerun 已接手）⇒ 不推
  if (!fact || !fact.executionId || fact.result !== 'failed') return null;
  const st = (state && typeof state === 'object') ? state : {};
  const endedAt = Number(fact.endedAt ?? 0) || 0;
  const ageMs = endedAt ? Math.max(0, now - endedAt) : Number.POSITIVE_INFINITY;
  // 状态条目**只放去重/状态键**（§3.9 载体归属：error 首行 / 产物线索的真源是看板 executions[] 与卡文本，
  //   **不复制进台账**；本轮的文案直接用内存里的 fact）。
  const patchBase = {
    taskId: card.id,
    title: card.title,
    seq: card.seq ?? null,
    line: card.line ?? null,
    source: SOURCE_FAILED,
    executionId: fact.executionId,
    firstSeenAt: Number(st.firstSeenAt ?? 0) || now,
    lastSeenAt: now,
    lastNotifiedExecutionId: st.lastNotifiedExecutionId ?? null,
    notifiedAt: Number(st.notifiedAt ?? 0) || null,
    notifiedTo: st.notifiedTo ?? null,
    escalatedAt: Number(st.escalatedAt ?? 0) || null,
    lastReportedExecutionId: st.lastReportedExecutionId ?? null,
    lastReportedAt: Number(st.lastReportedAt ?? 0) || null,
  };
  // ③ 执行会话还在跑（与 review 的「假结算」同口径：绝不向在跑的会话发提醒/绝不打断）
  if (card.exec?.alive === true) {
    return { action: 'failed-skip', reason: 'failed-execution-alive', patch: patchBase, detail: { failed: fact, exec: card.exec } };
  }
  // ④ 去重：同一 execution 只推一次；已推且超升级线仍未处理 ⇒ 升级一次（不重复注入）
  if (st.lastNotifiedExecutionId && String(st.lastNotifiedExecutionId) === String(fact.executionId)) {
    const after = Math.max(60_000, Number(cfg?.escalateAfterMs ?? DEFAULT_CONFIG.escalateAfterMs) || 0);
    if (!st.escalatedAt && patchBase.notifiedAt && now - patchBase.notifiedAt >= after) {
      const n = pickTarget({ binding, lineOwner, notifier: notifier ?? { kind: 'none', count: 0 }, handoff });
      return {
        action: 'failed-escalate', reason: 'failed-notified+stale', source: SOURCE_FAILED,
        patch: { ...patchBase, escalatedAt: now }, detail: { notifier: n, failed: fact, ageMs },
      };
    }
    return { action: 'failed-skip', reason: 'failed-already-notified', patch: patchBase, detail: { failed: fact, ageMs } };
  }
  // ⑤ 宽限：留给人肉立刻重跑（3 分钟）
  if (ageMs < sw.graceMs) {
    return { action: 'failed-skip', reason: 'failed-too-fresh', detail: { failed: fact, ageMs, graceMs: sw.graceMs } };
  }
  // ⑥ 档位：observe / report / dry-run **只算不投**（观察档不消费去重/冷却配额 —— persona 三红线 ①）
  if (mode !== 'notify') {
    const n = pickTarget({ binding, lineOwner, notifier: notifier ?? { kind: 'none', count: 0 }, handoff });
    return { action: 'failed-skip', reason: 'failed-non-notify-mode', detail: { notifier: n, failed: fact, ageMs, mode } };
  }
  const n = pickTarget({ binding, lineOwner, notifier: notifier ?? { kind: 'none', count: 0 }, handoff });
  // ⑦ TTL（6h）：超期不注入，只落日报/桌宠/告警；同一 execution 只报一次
  if (!(ageMs <= sw.ttlMs)) {
    if (st.lastReportedExecutionId && String(st.lastReportedExecutionId) === String(fact.executionId)) {
      return { action: 'failed-skip', reason: 'failed-expired-reported', patch: patchBase, detail: { failed: fact, ageMs } };
    }
    return {
      action: 'failed-report', reason: 'failed-expired', source: SOURCE_FAILED,
      patch: { ...patchBase, lastReportedExecutionId: fact.executionId, lastReportedAt: now, targetSource: n.source ?? 'none' },
      detail: { notifier: n, failed: fact, ageMs, ttlMs: sw.ttlMs },
    };
  }
  // ⑧ 目标闸（与 review 同一套降级链）：无目标 / 多目标 ⇒ 落日报一次（绝不静默）
  if (n.kind !== 'unique' || !n.sessionId) {
    const reason = n.kind === 'ambiguous' ? 'failed-ambiguous-target' : 'failed-no-target';
    if (st.lastReportedExecutionId && String(st.lastReportedExecutionId) === String(fact.executionId)) {
      return { action: 'failed-skip', reason: `${reason}-reported`, patch: patchBase, detail: { notifier: n, failed: fact } };
    }
    return {
      action: 'failed-report', reason, source: SOURCE_FAILED,
      patch: { ...patchBase, lastReportedExecutionId: fact.executionId, lastReportedAt: now, targetSource: n.source ?? 'none' },
      detail: { notifier: n, failed: fact },
    };
  }
  if (n.running === true) {
    return {
      action: 'failed-skip', reason: 'failed-target-busy',
      patch: { ...patchBase, pendingSince: Number(st.pendingSince ?? 0) || now, pendingReason: 'target-busy' },
      detail: { notifier: n, failed: fact },
    };
  }
  return {
    action: 'failed-notify', reason: 'failed-target-idle', source: SOURCE_FAILED,
    patch: {
      ...patchBase,
      lastNotifiedExecutionId: fact.executionId,
      notifiedAt: now,
      notifiedTo: n.sessionId,
      targetSource: n.source ?? null,
      targetSessionId: n.sessionId,
      pendingSince: null,
      pendingReason: null,
    },
    detail: { notifier: n, failed: fact },
  };
}

/**
 * 失败卡文案（纯函数；唯一调用点 = `queue-wake.injectOne`（注入）与 runTick 的 failed-report/escalate）。
 * 五个必说清：**哪张卡** · **什么时候挂的** · **错误首行** · **产物缺口线索** · **你可以 rerun**。
 * 绝不只发一个裸 id（H-14 事故里主人最想知道的就是"挂了什么、挂在哪、还能不能重跑"）。
 */
export function formatFailedText(ctx = {}) {
  const { card, failed = null, now, notifier = null, expired = false, escalated = false } = ctx;
  const endedAt = Number(failed?.endedAt ?? 0) || 0;
  const mins = endedAt ? Math.max(0, Math.round((now - endedAt) / 60_000)) : null;
  const seq = card?.seq ? `${card.seq}` : (card?.line || '未归线');
  const head = escalated
    ? '🐳⏫ 管家自动提醒（卡跑挂 · 仍未处理）'
    : (expired ? '🐳 管家自动提醒（卡跑挂 · 已超 6 小时 · 只落日报）' : '🐳 管家自动提醒（卡跑挂了 · 可重跑）');
  const lines = [
    head,
    '',
    `卡「${card?.title ?? '?'}」（${seq}）的执行**失败**${endedAt ? `：${hhmm(endedAt)}（${mins} 分钟前）` : '（账本未记录结束时刻）'}。`,
  ];
  lines.push(`- 卡 id：\`${card?.id ?? '?'}\``);
  lines.push(failed?.errorFirstLine ? `- 错误首行：${String(failed.errorFirstLine).slice(0, 200)}` : '- 错误首行：（账本未记录 error —— 去执行会话尾部看失败原因）');
  const dl = Array.isArray(failed?.deliverables) ? failed.deliverables : [];
  lines.push(dl.length
    ? `- 产物缺口线索：${dl.join(' / ')}（执行已失败 ⇒ 这些产物可能没写入，验收前先核实）`
    : '- 产物缺口线索：（卡里没写产物路径 —— 去执行会话 / 看板描述里核做到哪一步）');
  if (notifier && notifier.kind !== 'unique') {
    lines.push(`- 没找到可叫醒的会话（${notifier.kind === 'ambiguous' ? `标题【运行】的会话有 ${notifier.count ?? '?'} 个` : '标题【运行】的会话 = 0'}）⇒ 本条只落日报/桌宠；请手动接手`);
  }
  lines.push('- 你可以重跑：看板卡上的「重试」（card-retry），或另开会话补做。管家**只提醒**，不自动重跑。');
  lines.push('');
  lines.push('> 这是管家自动提醒，非主人发言；忽略本条即可。');
  return lines.join('\n');
}
/** 取最后一条执行记录（`{id, sessionId, startedAt, endedAt, result}`）。 */
export function lastExecution(card) {
  const list = Array.isArray(card?.executions) ? card.executions : [];
  const ex = list.filter((e) => e && typeof e === 'object').slice(-1)[0];
  if (!ex) return null;
  return {
    id: ex.id ?? null,
    sessionId: ex.sessionId ?? null,
    startedAt: Number(ex.startedAt ?? 0) || null,
    endedAt: Number(ex.endedAt ?? 0) || null,
    result: ex.result ?? null,
  };
}

/**
 * 双判据的第二半（**纯函数**）：该卡的执行会话**是否还活着**。
 *
 * 为什么必须有它（[Q1] 卡 12:0x 设计补充 + [Q3] 卡）：
 *   「卡 status === review」**不等于**「卡执行真的结束了」。2026-09-11 11:52 一次 P0 闸门重启
 *   打断了三张正在跑的卡，新实例恢复时 runner 把它们批量结算成 `succeeded → review`，
 *   而执行会话此后仍在继续跑 —— 典型**假结算**。只看看板 status 就通知/叫醒，等于对假货叫醒，
 *   越推越乱（实测：S3·L2 卡 `result=succeeded` 但执行会话至今 running=true）。
 *
 * 判据（保守：拿不准就不叫醒）：
 *   - **列表不可信**（`opts.listTrusted === false`：采集异常 / 空列表 / 索引未就绪）→ `known:false`
 *     ⇒ 调用方整轮跳过，**绝不用"查不到"推断"会话不存在"**（见下条 ⚠️ 与 2026-09-16 拷问 1.8）
 *   - 会话在 session.list 里且 `running === true` → **alive**（不叫醒）
 *   - 会话 `running === false` → 真结束（可叫醒）
 *   - 会话在 session.list 里**找不到**（被归档/清理/换机）→ 视为已结束（可叫醒）
 *   - 卡没有 executions / 没有 sessionId → `known:false`，**不阻断**（不因缺数据永久卡住队列）
 *   - session.list 采集失败 → 调用方（runTick）整轮跳过，不会走到这里
 *
 * ⚠️【2026-09-16 拷问 1.8】`session-missing → alive:false` 这条**只在列表可信时才成立**：
 *   冷启动 / 索引未就绪 / 采集半途返回空数组时，"列表里没有它"≠"它不在了"，而下游
 *   `card-watchdog` 的 `running` 卡判据会据此把**每一张卡**判成僵尸 → notify 档下"一批一批误注入"。
 *   看板侧同名问题有 `determined:false` 保护，这里等价物 = `listTrusted:false → known:false`。
 *
 * ⚠️ [Q3] 卡要求「与看板侧结算判据抽成公共函数避免分叉」；本函数是 dsh-butler 侧实现，
 *    看板侧（`dsh-task-board-local` 的 runner）修复时须与本口径**逐条对齐**（语义见上）。
 *
 * @param {{listTrusted?:boolean, enabled?:boolean}} [opts] listTrusted=false ⇒ 列表不可信（整轮跳过语义）
 * @returns {{known:boolean, alive:boolean, reason:string, sessionId:string|null, title?:string|null}}
 */
export function isExecutionAlive(card, sessions, opts = {}) {
  if (opts.enabled === false) return { known: false, alive: false, reason: 'disabled', sessionId: null };
  const ex = lastExecution(card);
  if (!ex || !ex.sessionId) return { known: false, alive: false, reason: 'no-execution', sessionId: ex?.sessionId ?? null };
  // ★ 列表不可信 → 拿不准（known:false），绝不降级成 session-missing
  if (opts.listTrusted === false) {
    return { known: false, alive: false, reason: 'list-untrusted', sessionId: ex.sessionId };
  }
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) {
    // 空数组**同样不可信**（真·零会话在本机不存在）——沿用同一保守口径，别把空名单当"人都不在了"
    return { known: false, alive: false, reason: 'list-untrusted', sessionId: ex.sessionId };
  }
  const s = list.find((x) => x && x.sessionId === ex.sessionId);
  if (!s) return { known: true, alive: false, reason: 'session-missing', sessionId: ex.sessionId };
  if (s.running === true) {
    return { known: true, alive: true, reason: 'session-running', sessionId: ex.sessionId, title: s.title ?? null, result: ex.result ?? null, endedAt: ex.endedAt ?? null };
  }
  return { known: true, alive: false, reason: 'session-idle', sessionId: ex.sessionId };
}

/** 同线「其后」待办（展示性提示；**不参与任何判定**）。 */
export function nextInQueue(board, card) {
  if (!card?.line) return null;
  const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
  const cand = tasks
    .filter((t) => t && t.id !== card.id && !t.archivedAt && (t.line ?? null) === card.line
      && (t.status === 'todo' || t.status === 'backlog'))
    .sort((a, b) => (Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)));
  const nx = cand[0];
  return nx ? { id: nx.id, title: nx.title, seq: nx.seq ?? null, status: nx.status } : null;
}

/**
 * 上下文用量投影（**纯函数**；2026-09-16 · ctx-guard 卡补的映射）。
 *
 * 来源 = `/api/session.list` → `items[].projections.values.contextPressure`，与 GUI 输入框旁的
 * 上下文圆环**同源**（主包 `dsh-token-meter` 的投影）：
 *   · `pressureTokens`  = 上一次请求实测的提示词规模（provider 值锚定）
 *   · `projectedTokens` = **下一个请求的预计用量**（判定用这个）
 *   · `contextWindow`   = 该路由容量（本机 deepseek = 1,000,000）
 * 缺投影 / 数值不可解析 → `null`（**调用方据此跳过，绝不猜**）。
 * ⚠️ 本函数只做映射，**不做任何阈值判定**（判定在 lib/ctx-guard.mjs 的 planCtxGuard）。
 */
export function mapContextPressure(session) {
  const cp = session?.projections?.values?.contextPressure;
  if (!cp || typeof cp !== 'object') return null;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const out = {
    pressureTokens: n(cp.pressureTokens),
    projectedTokens: n(cp.projectedTokens),
    contextWindow: n(cp.contextWindow),
  };
  if (out.pressureTokens === null && out.projectedTokens === null && out.contextWindow === null) return null;
  return out;
}

/** 会话列表（client-request RPC 信封；实测扁平 body 会被拒）。 */
export async function readSessions(opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // 0.1.5 换线（2026-09-22）：旧 POST /api/session.list 已失效 → 共享适配层（新端点 + cookie，
  // 旧主包自动回落）。fetchImpl 透传以保留测试注入能力。
  try {
    const { status, body: j } = await hostRpc(baseUrl, 'session.list', {}, {
      timeoutMs: opts.timeoutMs ?? 10_000,
      ...(typeof fetchImpl === 'function' ? { fetchImpl } : {}),
    });
    if (j?.result === undefined) return { ok: false, error: `HTTP ${status}`, items: [] };
    const items = j?.result?.value?.items;
    if (!Array.isArray(items)) return { ok: false, error: 'no-items', items: [], trusted: false };
    // 【2026-09-16 拷问 1.8】空列表 = **不可信**（本机 DSH 至少总有一个会话；空多半是索引未就绪 /
    //   采集半途）。旧口径返回 `ok:true + []`，下游 `isExecutionAlive` 会把**每一张卡**的执行会话
    //   判成 `session-missing` ⇒ notify 档下冷启动/索引未就绪时"一批一批误注入"。
    //   这里直接判失败，调用方（queue-tick / card-watchdog）按既有 collect-failed 分支**整轮跳过**：
    //   fail-closed —— 宁可不叫醒一轮，也不误报/误注入。
    if (!items.length) return { ok: false, error: 'empty-list（会话列表为空 = 不可信）', items: [], trusted: false };
    return {
      ok: true,
      trusted: true,
      items: items.map((s) => ({
        sessionId: s?.sessionId ?? s?.id ?? null,
        running: s?.running === true,
        title: String(s?.projections?.values?.title ?? s?.title ?? ''),
        updatedAt: Number(s?.updatedAt ?? 0) || null,
        // 2026-09-16 · ctx-guard 卡：会话列表同时带回上下文用量投影（GUI 圆环同源）。
        // 只是想多带一个字段，**既有调用方（queue-wake / isExecutionAlive / sessionIndex）语义不变**。
        contextPressure: mapContextPressure(s),
      })).filter((s) => s.sessionId),
    };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), items: [] };
  }
}

/**
 * 目标判定（纯函数）：标题**以**【运行】开头的会话，恰好 1 个才算目标。
 * ⚠️ 必须前缀匹配：60 字节裁剪后的标题形如 `【运行】[Q1] 队列推进巡检…`；
 *    用「包含」会把 `【完成】会话标题自动打标（插件钩子：【运行】/【完成】…）` 误判成目标。
 * @returns {{kind:'none'|'unique'|'ambiguous', count:number, sessionId?:string, running?:boolean, title?:string, candidates:Array}}
 */
export function pickNotifier(sessions, opts = {}) {
  const prefix = opts.targetPrefix ?? RUN_MARK;
  const list = (Array.isArray(sessions) ? sessions : []).filter(
    (s) => s && typeof s.title === 'string' && s.title.trimStart().startsWith(prefix),
  );
  const slim = (s) => ({ sessionId: s.sessionId, running: s.running === true, title: s.title });
  if (!list.length) return { kind: 'none', count: 0, candidates: [] };
  if (list.length > 1) return { kind: 'ambiguous', count: list.length, candidates: list.map(slim) };
  const s = list[0];
  return { kind: 'unique', count: 1, sessionId: s.sessionId, running: s.running === true, title: s.title, candidates: [slim(s)] };
}

// ---------------------------------------------------------------- 叫醒目标降级链（A 段 · 2026-09-14）
//
// 顺序铁律：**卡级绑定 → 主线 owner → 标题唯一 → none（escalate）**。
// 每一级都标注 `source`（binding / line-owner / fallback / none），写进台账与日报 —— 这是治「隐形失效」的关键
// （2026-09-14 事故的教训不是"算错了"，而是"没人知道它一次都没发"）。

/** 会话索引（sid → 会话记录；`readSessions().items` 或 mock 数组都能用）。 */
export function sessionIndex(sessions) {
  const m = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s && s.sessionId) m.set(String(s.sessionId), s);
  }
  return m;
}

/**
 * 解析一条绑定在本机是否可用（**纯函数**；不存在/无主都如实回报，绝不猜）。
 * @param {object|null} binding 绑定原始条目（cards[x] 或 lines[x]）
 * @param {Array|Map} sessionsOrIndex
 * @param {{source?:'binding'|'line-owner'}} [opts]
 * @returns {null|{source:string, sessionId:string|null, exists:boolean, running:boolean, title:string|null,
 *                 boundAt:number|null, reason:string, detail:object}}
 */
export function resolveBinding(binding, sessionsOrIndex, opts = {}) {
  if (!binding || typeof binding !== 'object') return null;
  const sidRaw = binding.initiatorSessionId ?? binding.ownerSessionId ?? null;
  const source = opts.source ?? 'binding';
  const boundAt = Number(binding.boundAt ?? 0) || null;
  if (!sidRaw) return { source, sessionId: null, exists: false, running: false, title: null, boundAt, reason: 'no-initiator', detail: binding };
  const idx = sessionsOrIndex instanceof Map ? sessionsOrIndex : sessionIndex(sessionsOrIndex);
  const s = idx.get(String(sidRaw)) ?? null;
  if (!s) return { source, sessionId: String(sidRaw), exists: false, running: false, title: null, boundAt, reason: 'session-missing', detail: binding };
  return { source, sessionId: String(sidRaw), exists: true, running: s.running === true, title: s.title ?? null, boundAt, reason: 'ok', detail: binding };
}

/** 会话快照里按 sid 取一条（Map / 数组都吃；缺快照 → null）。 */
function handoffSessionOf(handoff, sid) {
  const list = handoff?.sessions ?? null;
  if (!list || !sid) return null;
  if (list instanceof Map) return list.get(String(sid)) ?? null;
  if (Array.isArray(list)) return list.find((s) => s && String(s.sessionId) === String(sid)) ?? null;
  return null;
}

/**
 * 【卡 S2 · 阶段 1 改投】§6.1 三步走（**纯函数**：只吃调用方注入的快照，绝不碰文件系统 / 绝不读台账）。
 *
 *   ① 目标标题**以** HANDOFF_MARK 开头                         ⇒ 判已交棒
 *   ② 或台账 pendingHandoff.sourceSessionId 指向目标会话        ⇒ 判已交棒
 *   ③ 命中 ①② ⇒ **改投 pendingHandoff.newSessionId**（接手会话在快照里时），
 *      返回 source='handoff-reroute' + handoff.state='rerouted'；接手会话**找不到**时：
 *        · handoffAt 在宽限窗内（≤ REROUTE_GRACE_MS）⇒ state='pending-grace'（**不投递也不告警**，下轮再看）
 *        · 超宽限                                     ⇒ state='missing'（decide 走显式 skip + 审计）
 *
 * ⚠️ 未命中 ⇒ **原样返回**（§6.1「宽限窗内通知的期望行为」：权限回读窗口内既没有【已交接】标题、
 *    也没有 pendingHandoff ⇒ 到期通知**照旧投源会话**，绝不许实现成"跳过投递"）。
 * ⚠️ 改投后 running **跟着新会话走**（§6.1：running=true 仍走 target-busy 只排队、绝不注入）。
 * ⚠️ 未果时 kind 仍为 'unique' 且 sessionId=null ——「找不到」**只许**由 decide 的显式 skip 分支收口，
 *    不得改判成 kind:'none'（那会落进 report/escalate 噪音分支，即回归项 K-12 的反例形态）。
 *
 * @param {object} base pickTarget 降级链算出的目标
 * @param {{pending?:object|null, sessions?:Array|Map|null, now?:number, graceMs?:number}|null} handoff
 * @returns {object} 目标（形状与 pickNotifier() 兼容）；改投/未果时额外带 handoff 元信息
 */
export function applyHandoffReroute(base, handoff) {
  if (!base || typeof base !== 'object') return base;
  const sid = base.sessionId ? String(base.sessionId) : null;
  if (!sid) return base;                                  // 没有目标 ⇒ 改投无从谈起（走既有无目标分支）
  const pending = handoff?.pending ?? null;
  const now = Number(handoff?.now ?? Date.now());
  const graceMs = Number(handoff?.graceMs ?? REROUTE_GRACE_MS);
  const title = typeof base.title === 'string' ? base.title.trimStart() : '';
  const byMark = hasHandoffMark(title);
  const byPending = Boolean(pending && pending.sourceSessionId && String(pending.sourceSessionId) === sid);
  if (!byMark && !byPending) return base;                 // 条件①②都不成立 ⇒ 不判已交棒（照旧投源会话）

  const to = pending?.newSessionId ? String(pending.newSessionId) : null;
  const meta = {
    matched: byMark && byPending ? 'mark+pending' : (byMark ? 'mark' : 'pending'),   // 命中依据（可核查）
    chainId: pending?.chainId ?? null,
    fromSessionId: sid,
    toSessionId: to,
    handoffAt: Number(pending?.handoffAt ?? 0) || null,
  };
  if (to && to === sid) return base;                      // 已指向接手会话本身 ⇒ 不改投（防自我改投）

  if (to) {
    const s = handoffSessionOf(handoff, to);
    if (s) {
      // ③ 改投：source / sessionId / running / title **同源同改**（台账与 detail.notifier 是同一份）
      return {
        ...base,
        source: SOURCE_HANDOFF_REROUTE,
        kind: 'unique',
        count: 1,
        sessionId: to,
        running: s.running === true,
        title: s.title ?? null,
        boundAt: null,
        candidates: [{ sessionId: to, running: s.running === true, title: s.title ?? null }],
        handoff: { ...meta, state: 'rerouted', reason: 'new-session-found' },
      };
    }
  }
  // 接手会话找不到（K-27 时序竞态）：宽限内保守不判"找不到"；超宽限才落 skipped-handoff-window
  const age = meta.handoffAt ? now - meta.handoffAt : null;
  const inGrace = age !== null && age >= 0 && age <= graceMs;
  return {
    ...base,
    source: SOURCE_HANDOFF_REROUTE,        // 账实一致：意图档位仍标 handoff-reroute（但本轮**未投递**）
    kind: 'unique',
    count: 1,
    sessionId: null,
    running: null,
    title: base.title ?? null,
    candidates: [],
    handoff: { ...meta, state: inGrace ? 'pending-grace' : 'missing', reason: inGrace ? 'new-session-not-in-snapshot' : 'new-session-unresolved' },
  };
}

/**
 * 读接力台账的 pendingHandoff（**唯一读点**；只读、容错、缺文件 = 无数据）。
 * fail-safe 方向写死：读不到 ⇒ null ⇒ 改投判据整体不成立 ⇒ **照旧投源会话**（绝不"跳过投递"）。
 * @returns {null|{sourceSessionId:string, newSessionId:string, handoffAt:number|null, expireAt:number|null, chainId:string|null}}
 */
export function loadPendingHandoff(opts = {}) {
  const home = opts.home ?? dshHome();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(relayLedgerFileOf(home), 'utf8'));
  } catch {
    return null;                                          // 不存在 / 坏 JSON ⇒ 无数据（不抛、不刷告警噪音）
  }
  const sv = Number(raw?.schemaVersion ?? 1) || 1;
  if (sv > 1) return null;                                // 未知 schema（>1）⇒ 保守按"无数据"处理
  const p = raw?.pendingHandoff ?? null;
  if (!p || typeof p !== 'object' || !p.sourceSessionId || !p.newSessionId) return null;
  return {
    sourceSessionId: String(p.sourceSessionId),
    newSessionId: String(p.newSessionId),
    handoffAt: Number(p.handoffAt ?? 0) || null,
    expireAt: Number(p.expireAt ?? 0) || null,
    chainId: p.chainId ?? null,
  };
}

/** 组装改投快照（I/O 只发生在这里；纯函数 applyHandoffReroute 只吃结果）。 */
export function readHandoffSnapshot(opts = {}) {
  const pending = opts.pending !== undefined ? (opts.pending ?? null) : loadPendingHandoff({ home: opts.home });
  return {
    pending,
    sessions: opts.sessions ?? null,
    now: Number(opts.now ?? Date.now()),
    graceMs: Number(opts.graceMs ?? REROUTE_GRACE_MS),
    source: pending ? 'relay-ledger' : 'none',
  };
}

// ---------------------------------------------------------------- 台账 TTL 巡检（K-14 · 独立驱动者 = 本 job）
//
// 口径真源：`docs/` §5 三载体表「pendingHandoff」行（K-14）· §6.2 · §12 ⑥ v11 追加项 ②
//   · 病根：`pendingHandoff` 的两个清除者（① `session-mark --handed` 联动 ② `session-relay` 进入自检回查）
//     原先都挂在「下一次接力 / 下一次自检」上 ⇒ **没有下一次就永远不进自检**（超期条目可能数天不清）。
//   · 方案写死的**独立驱动者 = 既有 `queue` job（本 job，每 1 分钟）**：每轮读 `butler-relay.json`，
//     判 `pendingHandoff.expireAt` 是否超期 / owner 是否已换 ⇒ 超期清 + 审计 `stale-pending-handoff`；
//     **超 10 分钟未改绑 ⇒ 日报段 + 桌宠** —— 这一项是「阶段 2 未放行时改绑超时告警仍然存在」的唯一保证。
//   · **清理口径不许另造第二套**：判定与清理的真源 = `tools/session-relay.mjs#sweepLedgerTtl()`
//     （`--selfcheck` 用的就是它）⇒ 本模块**只做编排**：ownerLookup 注入 + 抢锁失败留痕 + 超时告警。
//     用**动态 import**（懒加载 + 失败降级）：本 job 是生产关键叫醒链，接力件加载失败**绝不许**拖垮整轮 tick。
//   · 锁语义（§5 / K-32）：抢锁失败 ⇒ 审计 `skipped-rmw-contention` + **保留 `pendingHandoff`** + 下轮重试（绝不静默丢）。
//   · 门禁（与既有纪律逐字一致）：`--dry-run` ⇒ 只判不清（零写盘零审计）；`observe` 档 ⇒ 同样只判不清
//     （「零对外副作用」：清理 = 跨组件写 + 写审计）。10 分钟线**只告警**、30 分钟线（`expireAt`）才清理。

/** 改绑超时告警线（§6.2）。**兜底值** —— 真源 = `session-relay.mjs#REBIND_WARN_MS`，两者相等由新单测守（防漂移）。 */
export const DEFAULT_REBIND_WARN_MS = 600_000;
/** 实例重启后的静默窗（§6.2 ② + S5 / R5：「超时判据按**实例在线时长**计，跨停机不累计」）。真源 = `session-relay.mjs#RELAY_BOOT_GRACE_MS`。 */
export const DEFAULT_BOOT_GRACE_MS = 20 * 60 * 1000;
/** 连续 tick 链的断链阈值（R5「跨停机不累计」的第二道闸）：上一轮 tick 距今超过它 ⇒ 本轮超时告警静默。 */
export const DEFAULT_CHAIN_GAP_MS = 5 * 60 * 1000;

/** tickd 心跳状态文件（**实例在线时长的基准载体** —— 方案 §6.2 ② 的落地口径 = `butler-tickd` 心跳文件 + `startedAt`）。 */
export function tickdStateFile(opts = {}) {
  const dir = opts.tickdDir ?? process.env.DSH_TICKD_DIR ?? path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-tickd');
  return path.join(dir, 'state.json');
}

/**
 * 读「本实例在线时长」基准（tickd 心跳 `startedAt`）。
 * 取不到（文件缺失 / 坏 JSON / 字段缺失）⇒ `uptimeMs: null` ⇒ 调用方**按保守方向不报**
 * （方案 §5.1 登记口径：**基准丢失 = 计时基准归零 ⇒ 实例重启后前 20 分钟不触发（偏保守，不出危险动作）**）。
 */
export function readInstanceUptime(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  try {
    const file = opts.tickdStateFile ?? tickdStateFile(opts);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = Date.parse(String(j?.startedAt ?? ''));
    if (!Number.isFinite(t)) return { ok: false, file, uptimeMs: null, startedAt: null, reason: 'no-startedAt' };
    return { ok: true, file, uptimeMs: now - t, startedAt: t, reason: null };
  } catch (e) {
    return { ok: false, file: opts.tickdStateFile ?? tickdStateFile(opts), uptimeMs: null, startedAt: null, reason: e?.code === 'ENOENT' ? 'no-tickd-state' : 'unreadable' };
  }
}

/** 懒加载接力件（只 import 一次；失败**不缓存失败态**，下轮可重试）。 */
let _relayModPromise = null;
function loadRelayModule() {
  if (!_relayModPromise) {
    _relayModPromise = import('../../session-relay.mjs').catch((e) => { _relayModPromise = null; throw e; });
  }
  return _relayModPromise;
}

/**
 * 改绑超时告警计划（**纯函数**：只吃入参，不读文件、不发通知、不读时钟）。
 *
 * 口径（§6.2 写死）：读点 = **`pendingHandoff.handoffAt`**（**不是** `inFlight.startedAt` —— 后者整链结束即删、
 * 窗口期根本读不到）；「超 10 分钟未改绑」= `now - handoffAt >= REBIND_WARN_MS`。
 * 幂等键 = `${sourceSessionId}|${handoffAt}` ⇒ **同一交接条目只喊一次**（本 job 每 1 分钟一轮，
 * 不幂等就是每 60 秒一条桌宠）。
 */
export function planRebindWarn(input = {}) {
  const p = input.pending ?? null;
  const now = Number(input.now ?? Date.now());
  const warnMs = Number(input.warnMs ?? DEFAULT_REBIND_WARN_MS);
  const out = { due: false, fire: false, key: null, ageMs: null, alreadyWarned: false, warnMs, bootGraceMs: Number(input.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS), uptimeMs: null, chainGapMs: null, chainGapMaxMs: Number(input.chainGapMaxMs ?? DEFAULT_CHAIN_GAP_MS), suppressed: null };
  const h = Number(p?.handoffAt ?? 0);
  if (!p || !Number.isFinite(h) || h <= 0) return out;
  out.key = `${p.sourceSessionId ?? '?'}|${h}`;
  out.ageMs = now - h;
  out.due = out.ageMs >= warnMs;
  out.alreadyWarned = String(input.warnedKey ?? '') === out.key;
  // 【§6.2 ② + S5 / R5】**超时判据按实例在线时长计**：跨停机不累计、**实例重启后前 20 分钟不报**；
  //   基准（tickd 心跳 `startedAt`）取不到 ⇒ 同样不报（保守方向 —— 绝不"基准一丢就放箭"）。
  const up = input.uptimeMs;
  out.uptimeMs = up === null || up === undefined || !Number.isFinite(Number(up)) ? null : Number(up);
  // 【R5「跨停机不累计」的第二道闸】本 job 的**连续 tick 链**：上一轮 tick 距今超过阈值（或压根没有上一轮）
  //   ⇒ 这段时间里没人看着台账（tickd 重启 / 停机 / 长连败）⇒ 等待时长里的这一段**不计入** ⇒ 本轮静默。
  const gapMs = Number(input.chainGapMaxMs ?? DEFAULT_CHAIN_GAP_MS);
  const gap = input.chainGapMs;
  out.chainGapMs = gap === null || gap === undefined || !Number.isFinite(Number(gap)) ? null : Number(gap);
  out.chainGapMaxMs = gapMs;
  if (out.due) {
    if (out.uptimeMs === null) out.suppressed = 'no-instance-baseline';
    else if (out.uptimeMs < out.bootGraceMs) out.suppressed = 'boot-grace';
    else if (out.chainGapMs === null || out.chainGapMs > gapMs) out.suppressed = 'gapped-chain';
  }
  out.fire = out.due && !out.suppressed && !out.alreadyWarned;
  return out;
}

/**
 * 「owner 是否已换到接手会话」判据（§5 三载体表 (b)：**读绑定表**）——
 * 判据写死：绑定表任意条目（卡级 `initiatorSessionId` / 主线级 `ownerSessionId`）已指向
 * `pendingHandoff.newSessionId` ⇒ 接手会话已改绑 ⇒ 命中（`sweepLedgerTtl` 据此清条目）。
 * 坏表 / 缺表 / 取不到 ⇒ `false`（**fail-safe：宁可留着也不误清**）。
 */
export function ownerChangedInBindings(pending, bindings) {
  const target = String(pending?.newSessionId ?? '');
  if (!target) return false;
  const pairs = [[bindings?.cards, 'initiatorSessionId'], [bindings?.lines, 'ownerSessionId']];
  for (const [bucket, field] of pairs) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const k of Object.keys(bucket)) {
      const v = bucket[k];
      if (!v || typeof v !== 'object') continue;
      if (String(v[field] ?? '') === target) return true;
    }
  }
  return false;
}

/**
 * 台账 TTL 巡检（**编排层**；判定与清理同源复用 `session-relay#sweepLedgerTtl`）。
 *
 * @param {{home?:string, now?:number, pending?:object|null, bindings?:object, dryRun?:boolean, readOnly?:boolean,
 *          warnedKey?:string|null, emit?:boolean, warnMs?:number, ownerLookup?:Function, sweep?:Function}} opts
 *   · `pending` = 本轮**已读**的 `pendingHandoff`（runTick 传快照，避免二次读盘）；缺省自己读。
 *   · `sweep` = 单测用的注入桩（缺省 = 真件 `session-relay#sweepLedgerTtl`）。
 * @returns {{ok:boolean, readOnly:boolean, pending:object|null, sweepRan:boolean, skipped:string|null, error:string|null,
 *            cleared:number, expired:number, ownerChanged:number, rmwContention:boolean, rebindWarn:object}}
 */
export async function sweepRelayLedgerTtl(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const home = opts.home ?? dshHome();
  const dryRun = opts.dryRun === true;
  const readOnly = dryRun || opts.readOnly === true;     // dry-run 与 observe 档都落"只判不清"
  const emit = opts.emit !== false;
  const pending = opts.pending !== undefined ? (opts.pending ?? null) : loadPendingHandoff({ home });
  const out = {
    ok: true, rule: 'session-relay#sweepLedgerTtl', dryRun, readOnly, pending: pending ?? null,
    sweepRan: false, skipped: null, error: null,
    cleared: 0, expired: 0, ownerChanged: 0, rmwContention: false,
    uptimeMs: null, uptimeSource: null,
    rebindWarn: planRebindWarn({ pending: null }),
  };
  if (!pending) return out;
  // 实例在线时长（§6.2 ② / S5：**按实例计、跨停机不累计**；基准 = tickd 心跳 startedAt）。
  // ⚠️ 取不到 ⇒ `uptimeMs: null` ⇒ 偏保守不报（绝不"基准一丢就放箭"）。
  const up = opts.uptimeMs !== undefined ? { uptimeMs: opts.uptimeMs } : readInstanceUptime({ now, tickdDir: opts.tickdDir, tickdStateFile: opts.tickdStateFile });
  out.uptimeMs = Number.isFinite(Number(up?.uptimeMs)) ? Number(up.uptimeMs) : null;
  out.uptimeSource = up?.ok ? 'tickd-heartbeat' : (up?.reason ?? 'unknown');
  let mod = null;
  if (typeof opts.sweep === 'function') mod = { sweepLedgerTtl: opts.sweep };
  else {
    try { mod = await loadRelayModule(); } catch (e) {
      out.ok = false;
      out.skipped = 'relay-module-unavailable';
      out.error = e?.message ?? String(e);
      out.rebindWarn = planRebindWarn({ pending, now, warnMs: opts.warnMs ?? DEFAULT_REBIND_WARN_MS, bootGraceMs: opts.bootGraceMs, uptimeMs: out.uptimeMs, chainGapMs: opts.chainGapMs, chainGapMaxMs: opts.chainGapMaxMs, warnedKey: opts.warnedKey });
      return out;
    }
  }
  const warnMs = Number(opts.warnMs ?? mod.REBIND_WARN_MS ?? DEFAULT_REBIND_WARN_MS);
  const bootGraceMs = Number(opts.bootGraceMs ?? mod.RELAY_BOOT_GRACE_MS ?? DEFAULT_BOOT_GRACE_MS);
  out.rebindWarn = planRebindWarn({ pending, now, warnMs, bootGraceMs, uptimeMs: out.uptimeMs, chainGapMs: opts.chainGapMs, chainGapMaxMs: opts.chainGapMaxMs, warnedKey: opts.warnedKey });
  const ownerLookup = typeof opts.ownerLookup === 'function' ? opts.ownerLookup : ((ph) => ownerChangedInBindings(ph, opts.bindings));
  let r = null;
  try {
    r = mod.sweepLedgerTtl({ home, now, ownerLookup, emit: emit && !readOnly, dryRun: readOnly }) ?? {};
  } catch (e) {
    out.ok = false; out.skipped = 'sweep-threw'; out.error = e?.message ?? String(e);
    return out;
  }
  out.sweepRan = true;
  out.cleared = Array.isArray(r.cleared) ? r.cleared.length : 0;
  out.expired = Array.isArray(r.expired) ? r.expired.length : 0;
  out.ownerChanged = Array.isArray(r.ownerChanged) ? r.ownerChanged.length : 0;
  out.rmwContention = r.rmwContention === true;
  if (out.rmwContention && emit && !readOnly) {
    // K-32 写死：抢锁失败**不是"什么都不做"** —— 留一条审计（否则生产上只会看到"条目一直在、没人知道为什么）。
    appendAudit({
      type: 'skipped-rmw-contention', by: 'butler-queue', phase: 'ledger-ttl-sweep',
      sourceSessionId: pending.sourceSessionId ?? null, newSessionId: pending.newSessionId ?? null,
      chainId: pending.chainId ?? null, handoffAt: pending.handoffAt ?? null, expireAt: pending.expireAt ?? null,
      note: '台账 RMW 抢锁失败 ⇒ 保留 pendingHandoff，下轮重试',
    }, { home, silent: true });
  }
  return out;
}

/**
 * 目标判定（**纯函数**，降级链）：返回带 `source` 的目标 —— 形状与 `pickNotifier()` 兼容
 * （`kind` / `count` / `sessionId` / `running` / `candidates`），`decide()` 因此一行不改地复用既有分支。
 *
 * @param {{binding?:object|null, lineOwner?:object|null, notifier?:object}} input
 *   binding / lineOwner 均为 `resolveBinding()` 的结果（null = 该级没有绑定）
 * @returns {{source:'binding'|'line-owner'|'fallback'|'none', kind:'unique'|'none'|'ambiguous',
 *            count:number, sessionId:string|null, running:boolean|null, title?:string|null,
 *            boundAt?:number|null, candidates:Array, degraded:string[]}}
 */
export function pickTarget(input = {}) {
  // 【卡 S2】改投落在**输入层**：快照由调用方注入（runTick / test），本函数与 pickTargetBase 都是纯函数。
  return applyHandoffReroute(pickTargetBase(input), input.handoff ?? null);
}

/** 降级链本体（**原实现逐字不动**；改投在 pickTarget 出口统一后处理 ⇒ 四个 return 路径同源同改）。 */
function pickTargetBase(input = {}) {
  const notifier = input.notifier ?? { kind: 'none', count: 0, candidates: [] };
  const degraded = [];
  const asTarget = (b, source) => ({
    source,
    kind: 'unique',
    count: 1,
    sessionId: b.sessionId,
    running: b.running === true,
    title: b.title ?? null,
    boundAt: b.boundAt ?? null,
    candidates: [{ sessionId: b.sessionId, running: b.running === true, title: b.title ?? null }],
    degraded: [...degraded],
  });

  const card = input.binding ?? null;
  if (card) {
    if (card.exists && card.sessionId) return asTarget(card, card.source ?? 'binding');
    degraded.push(`binding:${card.reason ?? 'unusable'}`);      // 有绑定但不可用 → 明确记降级原因
  }
  const line = input.lineOwner ?? null;
  if (line) {
    if (line.exists && line.sessionId) return asTarget(line, line.source ?? 'line-owner');
    degraded.push(`line-owner:${line.reason ?? 'unusable'}`);
  }
  if (notifier.kind === 'unique' && notifier.sessionId) {
    return {
      source: 'fallback', kind: 'unique', count: 1, sessionId: notifier.sessionId,
      running: notifier.running === true, title: notifier.title ?? null, boundAt: null,
      candidates: notifier.candidates ?? [], degraded,
    };
  }
  return {
    source: 'none', kind: notifier.kind ?? 'none', count: notifier.count ?? 0,
    sessionId: null, running: null, candidates: notifier.candidates ?? [], degraded,
  };
}

/** 看板上「进行中」的卡（cron 自动登记的输入；归档卡不算）。 */
export function pickRunningCards(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.status === 'running' && !t.archivedAt)
    .map((t) => ({ id: String(t.id), title: String(t.title ?? ''), seq: t.seq ?? null, line: t.line ?? null }));
}

/**
 * 【A 段 · 发起方自动登记】给「进行中但绑定表里没有记录」的卡显式记一笔 `source:'cron'`。
 *
 * 为什么是 cron：tick 由常驻调度器（butler-tickd）起，**没有会话身份** —— 它无从知道这张卡是
 * 本机会话 run 的、面板 run 的、还是 cron 自己起的。方案 §5 风险 3 的纪律是「**不猜**」：
 * 无会话身份就显式声明无主（`initiatorSessionId:null` + `source:'cron'`），判定侧照常走降级链。
 * 主会话 run 卡时用 `--session auto`（= `DSH_SESSION_ID`）登记 → 覆盖本条（审计留 `previousInitiator`）。
 *
 * 幂等：已有条目（任何来源）一律跳过，绝不覆盖人的登记。
 * @returns {{scanned:number, missing:number, bound:number, skipped:number, corrupt:boolean, items:Array}}
 */
export function autobindCronCards(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const cards = Array.isArray(opts.cards) ? opts.cards : [];
  const out = { scanned: cards.length, missing: 0, bound: 0, skipped: 0, corrupt: false, items: [] };
  if (!cards.length) return out;
  let bindings = opts.bindings ?? loadBindings({ home });
  if (bindings.corrupt) { out.corrupt = true; return out; }
  for (const card of cards) {
    if (resolveCardBinding(bindings, card.id)) { out.skipped++; continue; }
    out.missing++;
    out.items.push({ cardId: card.id, seq: card.seq ?? null, title: card.title ?? null, action: dryRun ? 'would-bind-cron' : 'bind-cron' });
    if (dryRun) continue;
    const r = bindCardEntry(card.id, null, {
      home, now, source: 'cron', title: card.title, seq: card.seq, line: card.line,
      actor: opts.actor ?? 'butler-queue-tick',
      note: 'cron 自动登记（无会话身份 → 显式无主；主会话 run 卡可用 --session auto 覆盖）',
    });
    if (r.ok) {
      out.bound++;
      bindings = { ...bindings, cards: { ...bindings.cards, [card.id]: r.entry } };   // 内存跟进，避免重复 IO
    } else {
      out.error = r.error ?? 'bind-failed';
    }
  }
  return out;
}

// ---------------------------------------------------------------- 事件信箱（[Q2] 协议 v1）

/**
 * 消费事件信箱（append-only；只读 + 按偏移去重）。
 * @returns {{events:Array, newEvents:number, offset:number, size:number, reset:boolean, lines:number, error?:string}}
 */
export function consumeInbox(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.inboxFile ?? inboxPath(home);
  const cfg = opts.config ?? DEFAULT_CONFIG;
  const ledger = opts.ledger ?? LEDGER_DEFAULT;
  const out = { events: [], newEvents: 0, offset: ledger.inbox?.offset ?? 0, size: 0, reset: false, lines: 0, file };
  if (cfg.inbox?.enabled === false) { out.skipped = 'disabled'; return out; }
  let buf;
  try {
    if (!fs.existsSync(file)) { out.skipped = 'missing'; return out; }
    buf = fs.readFileSync(file);
  } catch (e) {
    out.error = e?.message ?? String(e);
    return out;
  }
  out.size = buf.length;
  let offset = out.offset;
  // 文件被截断/重建（size < offset）→ 从头重读，并记一次 reset（不静默）
  if (offset > buf.length) { out.reset = true; offset = 0; }
  // ⚠️ 偏移是**字节**偏移：只在 buffer 上找最后一个 0x0A（不按字符串长度推算，避免 UTF-8/CRLF 错位）
  const tail = buf.subarray(offset);
  const lastNl = tail.lastIndexOf(0x0A);
  const consumedBytes = lastNl < 0 ? 0 : lastNl + 1;   // 最后一行可能正在 append（半截）→ 只消费到最后一个换行
  const text = tail.subarray(0, consumedBytes).toString('utf8');
  const complete = text.length ? text.split(/\r?\n/).slice(0, -1) : [];  // 末尾必定是空串（以 \n 结尾）
  out.lines = complete.filter((l) => l.trim()).length;

  const seen = new Set((ledger.inbox?.consumedKeys ?? []).map(String));
  for (const line of complete) {
    const t = line.trim();
    if (!t) continue;
    let evt;
    try { evt = JSON.parse(t); } catch { continue; }
    if (!evt || typeof evt !== 'object') continue;
    const at = Number(evt.at ?? 0);
    const taskId = evt.taskId ? String(evt.taskId) : null;
    if (!taskId || !Number.isFinite(at) || at <= 0) continue;
    const key = `${taskId}|${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.events.push({ ...evt, at, taskId, key });
    out.newEvents++;
  }
  out.offset = offset + consumedBytes;
  out.consumedKeys = [...seen].slice(-MAX_CONSUMED_KEYS);
  return out;
}

/**
 * 裁剪信箱（只在「全部已消费」时执行；原子重写剩余行）。
 * 生产端（[Q2]）未实现前信箱通常不存在，此处为纯保险。
 */
export function pruneInbox(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.inboxFile ?? inboxPath(home);
  const maxLines = opts.maxLines ?? 1000;
  try {
    if (!fs.existsSync(file)) return { ok: true, action: 'missing' };
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length <= maxLines) return { ok: true, action: 'under-limit', lines: lines.length };
    const keep = lines.slice(-maxLines);
    const next = keep.join('\n') + '\n';
    if (opts.writeText) opts.writeText(next);
    else {
      const r = writeStateText(INBOX_NAME, next, { home, write: (p, t) => writeJsonAtomicRaw(p, t) });
      if (!r.ok) throw new Error(`双写失败（${r.kind ?? 'unknown'}）：${(r.failures?.[0] ?? {}).error ?? 'unknown'}`);
    }
    return { ok: true, action: 'pruned', from: lines.length, to: keep.length };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// pruneInbox 内部用：原子写文本（保持 store 契约，不直写目标）
function writeJsonAtomicRaw(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const pre = gateDestructive({
    targets: [{ path: tmp, label: 'src' }, { path: file, label: 'dst' }], whitelist: [path.dirname(file)], op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse: false, ledgerBypass: false, reason: '裁剪信箱原子重写',
  });
  if (!pre.ok) throw new Error(`pruneInbox 被三件套拒绝（${pre.code}）：${pre.reason}`);
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let i = 0; i <= 3; i++) {
    try { fs.renameSync(tmp, file); return; } catch { sleepSync([50, 150, 400][i] ?? 0); }
  }
  throw new Error(`pruneInbox 原子写失败，临时文件保留：${tmp}`);
}

// ---------------------------------------------------------------- 判定（纯函数，单测主战场）

/** 新条目。 */
export function newEntry(card, now) {
  return {
    taskId: card.id,
    title: card.title,
    seq: card.seq ?? null,
    line: card.line ?? null,
    firstSeenAt: now,
    settledAt: card.settledAt ?? null,
    notifiedAt: null,
    notifiedTo: null,
    notifyMode: null,
    reportedAt: null,
    noTargetAt: null,
    noTargetReason: null,
    pendingSince: null,
    pendingReason: null,
    escalatedAt: null,
    injectedCount: 0,
    lastInjectError: null,
    // 双判据（假结算）：执行会话是否仍活着 + 首次发现时刻
    execAlive: false,
    execSessionId: null,
    execAliveReason: null,
    execAliveSince: null,
    // 叫醒目标降级链（A 段）：本次评估的目标来源（binding / line-owner / fallback / none）+ 目标会话 + 降级原因
    targetSource: null,
    targetSessionId: null,
    targetDegraded: null,
  };
}

/**
 * 判定（**纯函数**）：给定 台账条目 + 看板卡 + 目标判定 + 当前时刻 + 档位 → 一个动作。
 *
 * action ∈ cleanup | observe | report | notify | escalate | skip
 *   cleanup  卡离开 review → 删台账条目（不留残渣）
 *   observe  observe 档首次见到（只记台账 + 日志，零对外副作用）
 *   report   report 档 / notify 档但无唯一目标 → 落日报段 + 桌宠（不注入）
 *   notify   唯一目标 + 空闲 → 注入会话
 *   escalate 通知（或首次见到）后超阈值仍滞留 → 升级提醒一次（桌宠 + 日报段 + alert）
 *   skip     无事可做（含 target-busy 排队）
 *
 * @returns {{action:string, reason:string, remove?:boolean, patch?:object, detail?:object}}
 */
/**
 * 【N12 · 2026-10-10】**叫醒存亡确认**（纯函数；唯一读取点 = `decide()` 的 ③ 分支）。
 *
 * 治什么（2026-10-10 凌晨实证，`docs/` §4.1）：
 *   卡进 review ⇒ 队列把叫醒**注入成功**（台账 `notifiedAt` 落盘）⇒ 4 秒后 P0 重启把目标会话
 *   刚起的回合打断（尾部 `turn/end reason={kind:'interrupted'}`）⇒ 那条提醒**实际没被消费**。
 *   此后：去重签名认为"本轮事件已通知过该目标"（`queue-wake` 的 sigKey）、③ 分支认为"已通知"
 *   ⇒ **没有任何机制重投**，卡在「待验收」空等 6.5 小时直到主人自己发现。
 *
 * 判据（**全部是客观量、可复算**；任一不满足即不动作 = 宁可少叫醒也不误伤）：
 *   ① 开关：`cfg.wakeReceipt.enabled === true`（**默认 false ⇒ 本函数恒返回 null = 零行为变更**）
 *   ② 档位：`mode === 'notify'`（补投与既有注入同档；observe/report 档不注入会话）
 *   ③ 证据：`receipt.enabled === true` 且 `receipt.bySession[目标]` 存在（采不到 = 不动作，fail-safe）
 *   ④ 尾部回合 **`state === 'interrupted'`**（= 被打断后静止。`open` 刻意归 stuck-recovery 管，不重叠）
 *   ⑤ 静默 `idleMs ≥ minIdleMs`（默认 2 分钟：刚被打断时可能正在自己恢复，别抢跑）
 *   ⑥ 目标 `running !== true`（**绝不打断正在跑的会话** —— 与既有 target-busy 同款红线）
 *   ⑦ 时效：`minAgeMs ≤ now - notifiedAt ≤ maxAgeMs`（太新=可能还在恢复；太老=人工早该看到）
 *   ⑧ 次数：`receiptRetries < maxRetries`（默认 1 ⇒ 同一卡同一叫醒最多补投一次，绝不轰炸）
 *
 * 幂等：补投走既有动作层 `runAction`（L0/模块门/单日上限/24h 签名），且本函数在 patch 里换
 *   **新去重令牌** `receiptToken`（`buildItems` 把它灌进 sigKey 的 `eventKeyRaw`）⇒ 既不被旧签名
 *   挡死（治根因），也不会在同一轮重复注入（护栏不弱化）。
 * 失败可见：补投被挡/失败 ⇒ 走既有 `wakeBlocked*` 标记 + `deps.alert` + `%TEMP%` 日志；
 *   补投次数用尽后仍判出"被吞" ⇒ 返回一次 `escalate`（`receipt-lost`，桌宠 + 日报 + alert），
 *   **绝不静默收场**。
 *
 * @returns {{action:'notify'|'escalate', reason:string, patch:object, detail:object}|null}
 */
export function decideReceipt(input = {}) {
  const { entry, notifier = null, now, cfg = DEFAULT_CONFIG, mode = 'observe', receipt = null } = input;
  const rc = { ...DEFAULT_CONFIG.wakeReceipt, ...(cfg?.wakeReceipt ?? {}) };
  if (rc.enabled !== true) return null;                       // ① 开关（默认关）
  if (mode !== 'notify') return null;                         // ② 档位
  if (!receipt || receipt.enabled !== true) return null;      // ③ 证据就绪
  const target = entry?.notifiedTo ?? notifier?.sessionId ?? null;
  if (!target) return null;
  const ev = receipt.bySession?.[String(target)] ?? null;
  if (!ev) return null;
  if (ev.state !== 'interrupted') return null;                // ④ 被打断后静止（open 不归本机制）
  if (!(Number(ev.idleMs) >= Number(rc.minIdleMs))) return null;   // ⑤ 静默够久
  if (notifier?.running === true) return null;                // ⑥ 绝不打断正在跑的会话
  const age = Number(now) - Number(entry.notifiedAt ?? 0);
  if (!(age >= Number(rc.minAgeMs) && age <= Number(rc.maxAgeMs))) return null;  // ⑦ 时效
  const retries = Number(entry.receiptRetries ?? 0) || 0;
  const maxRetries = Number(rc.maxRetries ?? 1) || 1;
  const evidence = {
    targetState: ev.state, targetIdleMs: Math.round(Number(ev.idleMs) || 0),
    batchId: receipt.batchId ?? null, ageMs: Math.round(age), retries,
  };
  if (retries >= maxRetries) {
    // ⑧ 补投次数用尽仍判出"被吞" ⇒ 升级一次（可见，不静默）；`receiptAlertedAt` 保证只喊一次
    if (entry.receiptAlertedAt) return null;
    return {
      action: 'escalate',
      reason: 'receipt-lost',
      patch: { ...entry, receiptAlertedAt: now, escalatedAt: entry.escalatedAt ?? now },
      detail: { notifier, receipt: evidence, escalatedBy: 'wake-receipt' },
    };
  }
  return {
    action: 'notify',
    reason: 'receipt-retry',
    patch: {
      ...entry,
      notifiedAt: now,                                  // 与既有约定一致：notifiedAt = 最近一次投递时刻
      notifiedTo: target,
      notifyMode: mode,
      injectedCount: (Number(entry.injectedCount ?? 0) || 0) + 1,
      receiptRetries: retries + 1,
      receiptRetryAt: now,
      receiptReason: `target-${ev.state}`,
      receiptBatchId: receipt.batchId ?? null,
      // 去重令牌：同一卡同一批次的**第 N 次补投**是独立键（否则被 24h 签名静默挡下 = 白补）
      receiptToken: `receipt:${retries + 1}:${receipt.batchId ?? 'na'}`,
      pendingSince: null, pendingReason: null,
    },
    detail: { notifier, receipt: evidence },
  };
}

/**
 * 重启后「叫醒存亡确认」的证据采集（**唯一 IO 点**；只读，零写盘）。
 *
 * 成本控制：**只在开关打开且存在候选卡时才读盘** —— 候选 = 在册 review 卡里
 *   「已注入过（notifiedAt）+ 未用尽补投次数 + 过了 minAgeMs」的那些；再对**去重后的目标会话**
 *   （通常 0~3 个）读一次尾部。开关关着时**一次 IO 都不做**（逐字旧路径）。
 *
 * fail-safe：会话文件找不到 / 尾部解不开 / 事件为空 ⇒ 该目标**不进证据表** ⇒ 判定层不动作
 *   （宁可不补投，也不误投）。
 *
 * @returns {{enabled:boolean, bySession:object, candidates:number, targets:number, reason:string|null, readAt:number}}
 */
export function collectWakeReceipt(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = Number(opts.now ?? Date.now());
  const cfg = { ...DEFAULT_CONFIG, ...(opts.cfg ?? {}) };
  const rc = { ...DEFAULT_CONFIG.wakeReceipt, ...(cfg.wakeReceipt ?? {}) };
  const out = { enabled: false, bySession: {}, candidates: 0, targets: 0, reason: null, readAt: now };
  if (rc.enabled !== true) { out.reason = 'switch-off'; return out; }
  if (opts.mode !== undefined && opts.mode !== 'notify') { out.reason = 'mode-not-notify'; return out; }

  // 候选（纯内存；台账条目形态 = 既有 `ledger.entries[taskId]`）
  const entries = Object.values(opts.ledger?.entries ?? {});
  const wanted = new Set();
  for (const e of entries) {
    if (!e?.notifiedAt) continue;
    const retries = Number(e.receiptRetries ?? 0) || 0;
    if (retries >= (Number(rc.maxRetries ?? 1) || 1) && e.receiptAlertedAt) continue;   // 已升级过 ⇒ 不再采
    const age = now - Number(e.notifiedAt);
    if (!(age >= Number(rc.minAgeMs) && age <= Number(rc.maxAgeMs))) continue;
    const target = e.notifiedTo ?? e.targetSessionId ?? null;
    if (!target) continue;
    // 目标会话必须在场且**不在跑**（running 判据来自 session.list，是"绝不打断"的唯一依据）
    const s = (opts.sessions ?? []).find((x) => String(x?.sessionId) === String(target));
    if (!s) continue;
    if (s.running === true) continue;
    wanted.add(String(target));
  }
  out.candidates = wanted.size;
  if (!wanted.size) { out.reason = 'no-candidate'; return out; }
  out.enabled = true;

  let files = [];
  try { files = discoverSessionFiles(home); } catch (e) { out.reason = `discover-failed:${e?.message ?? e}`; return out; }
  const byId = new Map();
  for (const f of files) if (!byId.has(f.sessionId)) byId.set(f.sessionId, f);
  for (const sid of wanted) {
    const f = byId.get(sid);
    if (!f) continue;
    try {
      const tail = readSessionTail(f.file, {});
      if (!tail?.events?.length) continue;
      const cls = classifyTail(tail.events);
      out.bySession[sid] = { state: cls?.state ?? null, idleMs: Math.max(0, now - Number(f.mtimeMs ?? 0)), mtimeMs: Number(f.mtimeMs ?? 0) };
    } catch { /* fail-safe：读不到就不进证据表 */ }
  }
  out.targets = Object.keys(out.bySession).length;
  if (!out.targets) { out.reason = 'no-evidence'; return out; }
  // 相关重启批次（**只读一个 JSON**，仅供文案与复盘；采不到不影响判定）
  //   真源 = `~/.dsh/butler-restart-state.json#lastBatch`（restart-coordinator 在每次批次收尾时写）
  try {
    const rst = readJson(resolveStatePath('butler-restart-state.json', { home }).path, { schemaVersion: 1, home, defaultValue: null });
    const lb = rst?.lastBatch ?? null;
    if (lb?.batchId) {
      out.batch = { batchId: lb.batchId, createdAt: lb.createdAt ?? null, finishedAt: lb.finishedAt ?? null, interrupted: (lb.interrupted ?? []).length };
      out.batchId = lb.batchId;
    }
  } catch { /* 采不到就算了（fail-safe：不影响补投判定） */ }
  out.reason = null;
  return out;
}

export function decide(input) {
  const { entry, card, notifier, binding = null, lineOwner = null, now, mode = 'observe', cfg = DEFAULT_CONFIG, exec = null,
    // 【G3 · v3·R6 / v4·R12】新增两个**可选**入参（既有调用点不传 ⇒ 既有输入域逐字不变）：
    //   · interruptedDay   —— 打断通道单日上限载体 `stats.interruptedDay = {day,count}`
    //   · interruptedEntry —— 该卡的打断状态 `stats.interrupted[cardId]`（去重键真身；decide 需读它才能判 ④ 去重闸）
    interruptedDay = null, interruptedEntry = null,
    // 【N12 · 2026-10-10】叫醒存亡确认证据（**可选**入参；既有调用点不传 ⇒ 逐字旧行为）。
    //   形态 = `{ enabled, bySession: { <sessionId>: { state, idleMs } }, batchId, collectedAt }`
    //   由 `collectWakeReceipt()` 在 tick 里采（唯一 IO 点）；本函数只读它，仍是纯函数。
    receipt = null } = input;
  // 【G3 · 候选 B 第 4 行】打断分支：插在 review 守卫**之前**（对所有非 review 卡先过一遍；不适用则返回 null 落回老路径）
  const interruptDecision = decideInterrupted({
    card, exec, interruptedDay, interruptedEntry, now, mode, cfg, binding, lineOwner, notifier,
  });
  if (interruptDecision) return interruptDecision;

  const inReview = Boolean(card) && card.status === 'review';
  if (!inReview) {
    return entry
      ? { action: 'cleanup', remove: true, reason: 'left-review' }
      : { action: 'skip', reason: 'not-in-review' };
  }

  const st = entry ? { ...entry } : newEntry(card, now);
  st.taskId = card.id;
  st.title = card.title;
  st.seq = card.seq ?? st.seq ?? null;
  st.line = card.line ?? st.line ?? null;
  if (!entry) st.firstSeenAt = now;
  if (card.settledAt) st.settledAt = card.settledAt;
  const baseline = firstNum(st.settledAt, st.firstSeenAt, now);

  // ⓪ 叫醒目标（降级链：卡级绑定 → 主线 owner → 标题唯一 → none）——**纯函数**，任何档位都先算出来，
  //    这样 observe 档也能在台账 / `--status` 里看清「若叫醒会投给谁、来源是哪一级」（治隐形失效）。
  const n = pickTarget({ binding, lineOwner, notifier: notifier ?? { kind: 'none', count: 0 }, handoff: input.handoff ?? null });
  st.targetSource = n.source;
  st.targetSessionId = n.sessionId ?? null;
  st.targetDegraded = (n.degraded ?? []).length ? n.degraded.join(',') : null;

  // ① observe 档（含从 notify 降档回来）：零对外副作用
  //    但假结算标记要写进台账 —— observe 档的意义就是"让人看清判定准不准"，标记下来才看得见；
  //    标记**解除**也要落盘（实测坑：只改内存不返回 patch → `--status` 一直误报已结束的卡）。
  if (mode === 'observe') {
    if (exec && exec.alive === true) {
      const marked = { ...st, execAlive: true, execSessionId: exec.sessionId ?? null, execAliveReason: exec.reason ?? null, execAliveSince: st.execAliveSince ?? now };
      return entry
        ? { action: 'skip', reason: 'execution-alive', patch: marked, detail: { exec, fake: true } }
        : { action: 'observe', reason: 'first-seen', patch: marked, detail: { exec, fake: true } };
    }
    if (st.execAlive === true) {
      return { action: 'skip', reason: 'execution-resolved', patch: { ...st, execAlive: false, execAliveReason: 'resolved', execAliveSince: null } };
    }
    return entry
      ? { action: 'skip', reason: 'observed', patch: st }      // 带 patch：让 targetSource（若叫醒会投给谁）随时可见
      : { action: 'observe', reason: 'first-seen', patch: st };
  }

  const idleUnique = mode === 'notify' && n.kind === 'unique' && n.running === false;
  const stale = !st.escalatedAt && now - baseline >= Number(cfg?.escalateAfterMs ?? DEFAULT_CONFIG.escalateAfterMs);

  // ② 双判据（硬优先）：卡在看板是「待验收」，但**执行会话仍在运行** → 疑似重启导致的**假结算**
  //    绝不叫醒验收（也绝不落"请去验收"的报告），只记 pending；滞留超阈值给一次升级提醒，
  //    文案里明确「疑似假结算，请先核实执行会话是否真结束、交付是否完整」。
  if (exec && exec.alive === true) {
    const base = { ...st, execAlive: true, execSessionId: exec.sessionId ?? null, execAliveReason: exec.reason ?? null, execAliveSince: st.execAliveSince ?? now };
    if (!base.escalatedAt && stale) {
      return { action: 'escalate', reason: 'execution-alive+stale', patch: { ...base, escalatedAt: now }, detail: { exec, fake: true } };
    }
    return { action: 'skip', reason: 'execution-alive', patch: base, detail: { exec, fake: true } };
  }
  // 执行会话已真结束（或数据不足以致无法判定）→ 清掉旧的假结算标记，继续正常判定
  if (st.execAlive) { st.execAlive = false; st.execAliveReason = 'resolved'; st.execAliveSince = null; }

  // ②-2) 【卡 S2 · §6.1 改投】「已交棒但改投未果」⇒ **显式 skip**（K-12② 收口）
  //    两种形态都是"**既不投源也不投新**"，且**绝不进 report / escalate**（否则桌宠 + 日报 + 告警每张卡刷噪音）：
  //      · state='missing'       接手会话超宽限仍找不到 ⇒ reason='handoff-window-missing'（审计 skipped-handoff-window）
  //      · state='pending-grace' K-27 宽限内（handoffAt ≤10 分钟）⇒ reason='handoff-reroute-pending'（审计 reroute-pending-grace）
  //    ⚠️ 位置铁律：必须在 ③/④/⑤ 之前 —— 否则 ④「首见即滞留」会先 escalate 出去。
  //    ⚠️ 不得改判成 kind:'none'（那会落进 ⑥ 的 report/escalate 噪音分支）—— 回归项 K-12 的反例即针对此形态。
  const hstate = n.handoff?.state ?? null;
  if (hstate === 'missing' || hstate === 'pending-grace') {
    const reason = hstate === 'missing' ? SKIP_REASON_HANDOFF_MISSING : SKIP_REASON_HANDOFF_GRACE;
    const patch = {
      ...st,
      handoffFromSessionId: n.handoff?.fromSessionId ?? null,
      handoffToSessionId: n.handoff?.toSessionId ?? null,
      handoffChainId: n.handoff?.chainId ?? null,
      handoffAt: n.handoff?.handoffAt ?? null,
      handoffSkipReason: reason,
      handoffSkipAt: st.handoffSkipAt ?? now,        // 首次时刻（审计只写一次，1 分钟一轮不刷审计）
    };
    return { action: 'skip', reason, patch, detail: { notifier: n, handoff: n.handoff } };
  }

  // ③ 已注入过 → 【N12】先过"叫醒存亡确认"（重启把叫醒吞了 ⇒ 补投一次），否则只管「超阈值升级一次」
  if (st.notifiedAt) {
    const receiptDecision = decideReceipt({ entry: st, notifier: n, now, cfg, mode, receipt });
    if (receiptDecision) return receiptDecision;
    return escalateOrSkip(st, now, cfg, baseline, 'notified', n);
  }

  // ③-2) 【2026-09-21 · 治静默】想叫醒却被动作层挡下（`wakeBlockedStatus === 'noop'`：24h 签名去重 / 单日上限）
  //   且挡下已超升级阈值 → **升级一次**（桌宠 + 日报段 + alert）。
  //   由来：去重签名 24h 内一直有效且**没有重试窗口**，卡会一路"判定 notify → 被 noop 挡 → 不写 notifiedAt"
  //   无限循环 ⇒ 最长 24 小时完全无声无息（2026-09-21 实测：卡 01:47 补件再进待验收，到 08:16 才靠别的
  //   路径升档，主人干等 6.5 小时）。本分支只覆盖"被挡超阈值"这一种情况：正常注入路径不经过它。
  //   `blocked`（四门关：L0 降档 / 总闸 / 模块关闭）**刻意不在此列** —— 那是主人主动关的，且 `alertsOf`
  //   已有告警通道；对本分支认 `noop`，因为它是"看着像在工作、实际一条都没发出去"的隐蔽形态。
  if (st.wakeBlockedAt && st.wakeBlockedStatus === 'noop' && !st.escalatedAt
    && now - Number(st.wakeBlockedAt) >= Number(cfg?.escalateAfterMs ?? DEFAULT_CONFIG.escalateAfterMs)) {
    return {
      action: 'escalate', reason: 'wake-blocked+stale',
      patch: { ...st, escalatedAt: now },
      detail: { notifier: n, blocked: { at: st.wakeBlockedAt, status: st.wakeBlockedStatus, reason: st.wakeBlockedReason ?? null } },
    };
  }

  // ④ 首见即已滞留、又没法叫醒（无目标 / 多目标 / report 档）→ 直接升级，不必先走一次 report
  //    （事件信箱上线后常见：本 tick 才首见，但卡早已结算 → settledAt 就是基线）
  if (stale && !idleUnique) {
    const patch = { ...st, escalatedAt: now };
    if (mode === 'notify' && n.kind !== 'unique' && !st.noTargetAt) {
      patch.noTargetAt = now;
      patch.noTargetReason = n.kind === 'none' ? 'no-target' : 'ambiguous-target';
      patch.noTargetCount = n.count ?? 0;
    }
    return { action: 'escalate', reason: 'stale-before-notify', patch, detail: { notifier: n, stale: true } };
  }

  // ⑤ report 档 → 日报 + 桌宠（每卡一次）
  if (mode === 'report') {
    if (!st.reportedAt) return { action: 'report', reason: 'report-mode', patch: { ...st, reportedAt: now } };
    return escalateOrSkip(st, now, cfg, baseline, 'report-mode', n);
  }

  // ⑥ notify 档
  if (n.kind === 'none' || n.kind === 'ambiguous') {
    const reason = n.kind === 'none' ? 'no-target' : 'ambiguous-target';
    if (!st.noTargetAt) {
      return { action: 'report', reason, patch: { ...st, noTargetAt: now, noTargetReason: reason, noTargetCount: n.count ?? 0 }, detail: { notifier: n } };
    }
    return escalateOrSkip(st, now, cfg, baseline, reason, n);
  }
  if (n.running === true) {
    // 目标在跑 → 绝不注入（发消息 = 打断当前回合）；记 pending 下轮重试
    // （总是回 patch：也要把「假结算已解除」等 st 上的变更落盘，别只改内存）
    const patch = { ...st, pendingSince: st.pendingSince ?? now, pendingReason: 'target-busy' };
    return { action: 'skip', reason: 'target-busy', patch, detail: { notifier: n } };
  }
  return {
    action: 'notify',
    reason: 'target-idle',
    patch: { ...st, notifiedAt: now, notifiedTo: n.sessionId, notifyMode: mode, injectedCount: (st.injectedCount ?? 0) + 1, pendingSince: null, pendingReason: null, execAlive: false },
    detail: { notifier: n },
  };
}

/** 目标来源计数（A 段）：认 `SOURCE_KEYS` 全部档位（A 段四档 + 卡 S2 新增 `handoff-reroute`），其余归 none。 */
function bumpSource(bySource, source) {
  const key = SOURCE_KEYS.includes(source) ? source : 'none';
  const cur = bySource && typeof bySource === 'object' ? bySource : {};
  return { ...cur, [key]: Number(cur[key] ?? 0) + 1 };
}

/** 已通知/已报告后：要么等，要么升级一次（**带 detail.notifier**：`skip` 不写台账，但目标来源仍要可见）。 */
function escalateOrSkip(st, now, cfg, baseline, reason, notifier = null) {
  const detail = notifier ? { notifier } : undefined;
  if (st.escalatedAt) return { action: 'skip', reason: 'escalated', detail };
  const after = Number(cfg?.escalateAfterMs ?? DEFAULT_CONFIG.escalateAfterMs);
  if (now - baseline < after) return { action: 'skip', reason: 'waiting', detail };
  return { action: 'escalate', reason: `${reason}+stale`, patch: { ...st, escalatedAt: now }, detail };
}

/**
 * 【G3 · 八闸 ⑦ 风暴闸 + ⑤ 额度闸】**轮级**判据（纯函数；必须在逐卡 `decide` 之后）。
 *   · ⑦ 同轮 ≥3 张打断 ⇒ 只留**首卡**一条汇总条（其余降级 `interrupt-report`；逐卡明细进 `detail.interruptedStorm` 与日报）
 *   · ⑤ 额度按**汇总后**的条数计（方案总则 (vi)：先汇总、后计额度 —— 这是计数语义要求）
 * 汇总条**仍带首卡**（`card` 非空）⇒ `queue-wake` 两处 `it.card &&` 过滤点一行都不用改（复审 R9-① 推荐做法）。
 */
export function applyInterruptGates(plan, opts = {}) {
  const { interruptedDay = null, now = Date.now(), limit = INTERRUPT_DAY_LIMIT, stormMin = INTERRUPT_STORM_MIN } = opts;
  const idx = [];
  (Array.isArray(plan) ? plan : []).forEach((it, i) => {
    if (it?.card && it.decision?.action === 'interrupt-notify') idx.push(i);
  });
  if (!idx.length) return plan;

  let keep = idx;
  if (idx.length >= stormMin) {
    const first = idx[0];
    const bucket = idx.map((i) => {
      const f = plan[i].decision?.detail?.interrupted ?? null;
      return { taskId: plan[i].card.id, title: plan[i].card.title, seq: plan[i].card.seq ?? null, endedAt: f?.endedAt ?? null, error: f?.error ?? null };
    });
    plan[first].decision = { ...plan[first].decision, detail: { ...(plan[first].decision.detail ?? {}), interruptedStorm: { count: idx.length, cards: bucket } } };
    for (const i of idx.slice(1)) {
      plan[i].decision = {
        ...plan[i].decision,
        action: 'interrupt-report',
        reason: 'interrupt-storm-summarized',
        detail: { ...(plan[i].decision.detail ?? {}), interruptedStorm: { count: idx.length, cards: bucket, summarizedInto: plan[first].card.id } },
      };
    }
    keep = [first];
  }

  const day = dayKey(now);
  const baseCount = String(interruptedDay?.day ?? '') === day ? (Number(interruptedDay?.count ?? 0) || 0) : 0;
  let budget = Math.max(0, Number(limit) - baseCount);
  for (const i of keep) {
    if (budget > 0) { budget -= 1; continue; }
    plan[i].decision = {
      ...plan[i].decision,
      action: 'interrupt-report',
      reason: 'interrupt-day-limit',
      detail: { ...(plan[i].decision.detail ?? {}), interruptDayLimit: baseCount },
    };
  }
  return plan;
}

/**
 * 判定整轮（纯函数）：给定 review 卡列表 + 台账 + 目标判定 + 时刻 → 动作计划。
 *
 * 【A 段】`bindings` / `sessions` 可选：给了就逐卡走**降级链**（卡级绑定 → 主线 owner → 标题唯一），
 *   不给则等价于"无绑定"（与旧行为逐字相同 —— 既有单测语义不破）。
 */
export function planTick(input) {
  const { cards = [], entries = {}, notifier, bindings = null, sessions = null, now, mode, cfg, handoff = null,
    // 【G3 · v3·R6】打断通道的两个**可选**载体（既有调用点不传 ⇒ 逐字旧行为）
    interruptedDay = null, interrupted = null,
    // 【N12 · 2026-10-10】叫醒存亡确认证据（可选；见 collectWakeReceipt / decideReceipt）
    receipt = null } = input;
  const sidx = sessionIndex(sessions);
  const plan = [];
  const seen = new Set();
  const interruptBase = (interruptedDay && typeof interruptedDay === 'object') ? interruptedDay : null;
  const interruptMap = (interrupted && typeof interrupted === 'object') ? interrupted : {};
  let interruptPlanned = 0;
  for (const card of cards) {
    // ⚠️【G3】只有 review 卡进 `seen`：打断卡（todo/backlog）若残留 review 台账条目，仍要被下面的清理循环清掉
    //   （否则残留条目会污染 alertsOf 红标 —— 这正是方案 §3.9 阻断 1 的三号后果）
    if (card.status === 'review') seen.add(card.id);
    const entry = entries[card.id] ?? null;
    // 降级链前两级（第三级 = notifier 标题判据，第四级 = escalate，都在 decide 内）
    const binding = bindings ? resolveBinding(resolveCardBinding(bindings, card.id), sidx, { source: 'binding' }) : null;
    const lineOwner = bindings ? resolveBinding(resolveLineOwner(bindings, card.line), sidx, { source: 'line-owner' }) : null;
    const decision = decide({
      entry, card, notifier, binding, lineOwner, now, mode, cfg, exec: card.exec ?? null, handoff,
      // 额度判定按「当日已注入 + 本轮已规划打断条数」（与 buildItems 的 planned 同款语义）
      interruptedDay: interruptBase ? { day: interruptBase.day ?? null, count: (Number(interruptBase.count) || 0) + interruptPlanned } : null,
      interruptedEntry: interruptMap[card.id] ?? null,
      // 【N12】叫醒存亡确认证据（开关关着时 = {enabled:false} ⇒ decide 的 ③ 分支逐字走老路）
      receipt,
    });
    if (decision.action === 'interrupt-notify') interruptPlanned += 1;
    plan.push({ card, entry, binding, lineOwner, decision });
  }
  // 【G3 · 八闸 ⑦⑤】风暴汇总 + 单日额度（轮级判据，必须在逐卡判定之后；纯函数，只改 decision）
  applyInterruptGates(plan, { interruptedDay: interruptBase, now });
  // 台账里有、看板上已不在 review → 清理（含卡被删除/归档）
  for (const [taskId, entry] of Object.entries(entries)) {
    if (seen.has(taskId)) continue;
    plan.push({ card: null, entry, decision: decide({ entry, card: null, notifier, now, mode, cfg, handoff }) });
  }
  return plan;
}

// ---------------------------------------------------------------- 通知文案

export function formatInjectText(ctx) {
  const { card, next, entry, now, cfg } = ctx;
  const seen = entry?.settledAt ?? entry?.firstSeenAt ?? now;
  const mins = Math.max(0, Math.round((now - seen) / 60_000));
  const seq = card.seq ? `${card.seq}` : (card.line || '未归线');
  const lines = [
    '🐳 管家自动提醒（队列推进）',
    '',
    `卡「${card.title}」（${seq}）已进「**待验收**」（review）。`,
  ];
  if (card.settledAt) lines.push(`- 结算时刻：${hhmm(card.settledAt)}（至今 ${Math.max(0, Math.round((now - card.settledAt) / 60_000))} 分钟）`);
  else lines.push(`- 首次见到：${hhmm(seen)}（至今 ${mins} 分钟）`);
  lines.push(`- 队列其后：${next ? `卡「${next.title}」${next.seq ? `（${next.seq}）` : ''}·${next.status === 'backlog' ? '待规划' : '待办'}` : '（同线无待办卡）'}`);
  lines.push('- 处理方式：验收后由你触发下一张（confirm → 下一张 run）。管家**只提醒**，不自动验收、不自动起卡。');
  lines.push('');
  lines.push('> 这是管家自动提醒，非主人发言；忽略本条即可。');
  return lines.join('\n');
}

/**
 * 【G3 · 候选 B 第 5 行】打断通知文案（纯函数；**唯一调用点** = `queue-wake.injectOne`）。
 * 内容按方案 §1 目标 2：卡名 + 卡 id + 打断时刻 + 打断原因 + 建议动作（重跑 / 复核 / 放弃）。
 */
export function formatInterruptedText(ctx) {
  const { card, interrupted, now } = ctx;
  const endedAt = Number(interrupted?.endedAt ?? 0) || null;
  const mins = endedAt ? Math.max(0, Math.round((now - endedAt) / 60_000)) : null;
  const seq = card.seq ? `${card.seq}` : (card.line || '未归线');
  const lines = [
    '🐳 管家自动提醒（卡被打断 · 待重跑）',
    '',
    `卡「${card.title}」（${seq}）的执行**被打断**（DSH 重启/进程中断），已回落到「待办」。`,
  ];
  lines.push(`- 卡 id：\`${card.id}\``);
  lines.push(endedAt ? `- 打断时刻：${hhmm(endedAt)}（${mins} 分钟前）` : '- 打断时刻：（账本未记录 endedAt）');
  lines.push(interrupted?.error ? `- 打断原因：${interrupted.error}` : '- 打断原因：（账本未记录 error）');
  lines.push('- 建议动作：复核交付是否完整 → 重跑该卡；或确认可放弃。管家**只提醒**，不自动重跑。');
  lines.push('');
  lines.push('> 这是管家自动提醒，非主人发言；忽略本条即可。');
  return lines.join('\n');
}

/**
 * 【N12 · 2026-10-10】叫醒存亡确认的补投文案（纯函数；唯一调用点 = `queue-wake.injectOne`）。
 *
 * 与 `formatInjectText` 的区别只在**第一句为什么会再收到一次**：上一次叫醒被"打断"吞掉了
 * （尾部回合 `interrupted` 且此后一直静默）⇒ 主动说清"你已经收到过一次、这次是补发"，避免
 * 目标会话误以为是重复噪声而忽略。
 */
export function formatReceiptText(ctx) {
  const { card, next, entry, now, receipt = null } = ctx;
  const seen = entry?.settledAt ?? entry?.firstSeenAt ?? now;
  const mins = Math.max(0, Math.round((now - seen) / 60_000));
  const seq = card.seq ? `${card.seq}` : (card.line || '未归线');
  const idleMin = Math.round(Number(receipt?.targetIdleMs ?? 0) / 60_000);
  const lines = [
    '🐳 管家自动提醒（补发 · 上一次叫醒可能被打断吞掉）',
    '',
    `卡「${card.title}」（${seq}）已进「**待验收**」（review），上一次提醒发出后你的回合被打断`,
    `（尾部回合 = interrupted，已静默 ${idleMin} 分钟）⇒ 本条是**补发**，不是新事件。`,
  ];
  if (card.settledAt) lines.push(`- 结算时刻：${hhmm(card.settledAt)}（至今 ${Math.max(0, Math.round((now - card.settledAt) / 60_000))} 分钟）`);
  else lines.push(`- 首次见到：${hhmm(seen)}（至今 ${mins} 分钟）`);
  lines.push(`- 队列其后：${next ? `卡「${next.title}」${next.seq ? `（${next.seq}）` : ''}·${next.status === 'backlog' ? '待规划' : '待办'}` : '（同线无待办卡）'}`);
  if (receipt?.batchId) lines.push(`- 相关重启批次：\`${receipt.batchId}\``);
  lines.push('- 处理方式：验收后由你触发下一张（confirm → 下一张 run）。管家**只提醒**，不自动验收、不自动起卡。');
  lines.push('');
  lines.push('> 这是管家自动提醒，非主人发言；忽略本条即可。');
  return lines.join('\n');
}

export function formatReportText(ctx) {
  const { card, reason, next, notifier } = ctx;
  const why = {
    'no-target': '没有可叫醒的目标会话（标题标【运行】的会话 = 0）',
    'ambiguous-target': `目标会话不唯一（标题标【运行】的会话 = ${notifier?.count ?? '?'}）→ 宁可不发`,
    'report-mode': '当前档位 = report（只落日报 + 桌宠，不注入会话）',
  }[reason] ?? reason;
  return [
    `🐳 队列推进：卡「${card.title}」已进待验收`,
    why,
    next ? `其后：${next.title}` : '',
  ].filter(Boolean).join(' · ');
}

export function formatEscalateText(ctx) {
  const { card, entry, now, cfg } = ctx;
  const base = firstNum(entry?.notifiedAt, entry?.reportedAt, entry?.settledAt, entry?.firstSeenAt, now);
  const mins = Math.max(0, Math.round((now - base) / 60_000));
  const limit = Math.round(Number(cfg?.escalateAfterMs ?? DEFAULT_CONFIG.escalateAfterMs) / 60_000);
  // 假结算（执行会话仍在跑）→ 文案必须是「先核实」，而不是「请去验收」
  if (entry?.execAlive === true) {
    return `🐳⏫ 队列滞留·**疑似假结算**：卡「${card.title}」在看板是「待验收」已 ${mins} 分钟（阈值 ${limit}），`
      + `但其执行会话 \`${entry.execSessionId ?? '?'}\` **仍在运行** —— 很可能是重启把正在跑的卡结算成了 succeeded（[Q3] 同源问题）。`
      + `请先核实该执行会话是否真结束、交付是否完整，再决定验收；**不要直接 confirm**。`;
  }
  // 【N12 · 2026-10-10】补投次数用尽仍判出"叫醒被吞" ⇒ 文案必须点明「补投也没唤醒」，
  //   而不是与老路径一样说「已于 X 注入提醒」（那会让人以为"通知到位了、只是人没看到"）。
  if (entry?.receiptAlertedAt) {
    return `🐳⏫ 队列滞留·**叫醒补投未生效**：卡「${card.title}」进待验收已 ${mins} 分钟（阈值 ${limit} 分钟），`
      + `叫醒后目标会话（${entry.notifiedTo ?? '?'}）回合被打断并一直静默 —— 已补投 ${entry.receiptRetries ?? 0} 次`
      + `${entry.receiptRetryAt ? `（末次 ${hhmm(entry.receiptRetryAt)}）` : ''}仍未唤醒 ⇒ 请手动验收或重开会话接手。`;
  }
  // 被动作层挡下过（noop：24h 去重 / 单日上限）→ 文案必须点明"不是没卡，是通知没投出去"
  // （2026-09-21：主人曾因此以为"整夜在跑"，实际卡在待验收空等 6.5 小时 —— 见 decide 的 ③-2 分支）
  const how = entry?.notifiedAt
    ? `已于 ${hhmm(entry.notifiedAt)} 注入提醒给 ${entry.notifiedTo}`
    : (entry?.wakeBlockedStatus === 'noop'
      ? `**通知被挡下**（${entry.wakeBlockedReason ?? '去重窗口 / 额度'}）—— 会话**没有被叫醒过**，请手动验收`
      : (entry?.noTargetAt ? `未能注入（${entry.noTargetReason}）` : '未注入会话'));
  return `🐳⏫ 队列滞留升级：卡「${card.title}」进待验收已 ${mins} 分钟（阈值 ${limit} 分钟），${how} → 请主人/推进者处理`;
}

// ---------------------------------------------------------------- 日报段（docs/）

export function dailyReportPath(now = Date.now(), opts = {}) {
  const docsRoot = opts.docsRoot ?? path.join('<butler-root>', 'docs', 'reports');
  return path.join(docsRoot, `${dayKey(now)}-${opts.device ?? deviceName()}.md`);
}

/**
 * 刷新「## 🐳 队列推进提醒」段（幂等：整段替换；**绝不碰** P2 的「📊 误报率」段）。
 * 段落在文件末尾；锚点之间的内容才被替换，插入位置固定在最后一个 `## ` 段之后。
 */
export function refreshQueueSection(file, payload, opts = {}) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const mode = payload?.mode ?? 'observe';
  const now = opts.now ?? Date.now();
  const eolProbe = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = eolProbe.includes('\r\n') ? '\r\n' : '\n';
  const block = [];
  block.push('## 🐳 队列推进提醒（管家 · 自动）');
  block.push('');
  block.push(`- 档位：**${mode}** · 最近刷新 ${hhmm(now)} · 设备 ${opts.device ?? deviceName()}`);
  // 【Q6】采集失败/健康行：整轮跳过**必须可见** —— 此前失败只在 %TEMP% 日志与 alert.log 里，
  //   日报读者（主人）完全看不见"队列这几轮根本没推进"。
  const cf = payload?.collectFailure ?? null;
  if (cf) {
    block.push(
      `- ⚠️ **采集失败**：连续 **${cf.streak}** 轮（自 ${hhmm(Number(cf.firstAt) || now)}，累计 ${cf.count} 次）· ${cf.detail ?? ''}`
      + ` → **本轮跳过、未写判定台账**（队列本轮不推进）${cf.suppressed ? ' · 告警已限流' : ''}`,
    );
  } else {
    const ch = payload?.collectHealth ?? null;
    if (ch && Number(ch.failures ?? 0) > 0) {
      block.push(
        `- 采集健康：累计失败 **${ch.failures}** 轮 · 上次失败 ${ch.lastFailAt ? hhmm(Number(ch.lastFailAt)) : '-'}`
        + `${ch.lastReason ? `（${ch.lastReason}）` : ''}${ch.recoveredAt ? ` · 最近恢复 ${hhmm(Number(ch.recoveredAt))}` : ''}`,
      );
    }
  }
  // A 段（治「隐形失效」）：段头固定带「上次投递结果 + 目标来源」——档位躺平 / 一直没投出去，一眼可见。
  const last = payload?.last ?? null;
  if (last) {
    const licon = { notify: '🔔', report: '📣', escalate: '⏫' }[last.kind] ?? '·';
    block.push(
      `- 上次投递：${hhmm(Number(last.at) || now)} ${licon} ${last.kind}${last.ok === false ? '（**失败**）' : ''}`
      + `${last.title ? `：**${last.title}**${last.seq ? `（${last.seq}）` : ''}` : ''}`
      + `${last.sessionId ? ` → \`${String(last.sessionId).slice(0, 28)}…\`` : ''}`
      + ` · 目标来源 **${last.source ?? 'none'}**`,
    );
  } else {
    block.push('- 上次投递：（**暂无记录** —— 本机还没投递过；长期如此请查档位与目标判定）');
  }
  const bySource = payload?.bySource ?? null;
  if (bySource) {
    // 【失败卡通知档】`failed` 只在真出现过时才进图例（开关关 / 从没触发 ⇒ 段文字与改前一致）
    const keys = SOURCE_KEYS.filter((k) => k !== SOURCE_FAILED || Object.prototype.hasOwnProperty.call(bySource, SOURCE_FAILED));
    const parts = keys
      .map((k) => `${k} ${Number(bySource[k] ?? 0)}`)
      .join(' / ');
    const legend = '（binding=卡级绑定 · line-owner=主线 owner · fallback=标题判据 · handoff-reroute=已交棒改投接手会话 · none=无目标'
      + `${keys.includes(SOURCE_FAILED) ? ' · failed=失败卡通知档' : ''}）`;
    block.push(`- 目标来源累计：${parts}${legend}`);
  }
  // 【G3 · 候选 B 第 6 行 + 候选 D】打断通道行（**渲染层，只读**；真源 = 台账 stats.interrupted / stats.interruptedDay，
  //   事实字段（时刻/原因）现读看板 executions[]，**不复制进台账** —— §3.9 载体归属）。
  const ic = payload?.interrupted ?? null;
  if (ic && (ic.active || 0) > 0) {
    const day = ic.dayCount ? `${ic.dayCount.day} 已注入 ${ic.dayCount.count} 条` : '今日 0 条';
    block.push(`- 🔁 打断通道（卡被打断 ⇒ 回了「待办」）：在册 **${ic.active}** 张 · ${day}（上限 ${ic.dayLimit}）· 本轮 注入 ${ic.injected ?? 0} / 落日报 ${ic.reported ?? 0} / 排队 ${ic.queued ?? 0}`);
    for (const it of (ic.items ?? []).slice(0, 10)) {
      block.push(`  - 「${it.title}」${it.seq ? `（${it.seq}）` : ''}｜打断于 ${it.endedAt ? hhmm(Number(it.endedAt)) : '?'}${it.error ? `｜原因 ${String(it.error).slice(0, 60)}` : ''}｜${it.note ?? it.action ?? ''}`);
    }
  }
  // 【V3功能面 · 失败卡通知档 · 2026-10-22】失败卡通道行（渲染层只读；真源 = 台账 stats.failedNotify / stats.failed*）
  //   无候选时不渲染 ⇒ 日报段与改前逐字一致（开关关时整键不存在）。
  const fn = payload?.failedNotify ?? null;
  if (fn && Number(fn.candidates ?? 0) > 0) {
    const tagOf = (a) => ({ 'failed-notify': '已叫醒', 'failed-report': '落日报', 'failed-escalate': '升级', 'failed-skip': '跳过' }[a] ?? (a ?? '?'));
    block.push(`- 🗂 失败卡通道（卡跑挂 ⇒ 叫醒一次）：候选 **${fn.candidates}** 张 · 本轮 注入 ${fn.injected ?? 0} / 落日报 ${fn.reported ?? 0} / 升级 ${fn.escalated ?? 0} / 排队 ${fn.deferred ?? 0} / 跳过 ${fn.skipped ?? 0}（累计注入 ${Number(payload?.failedTotal ?? 0) || 0} 次）`);
    for (const it of (fn.items ?? []).slice(0, 10)) {
      block.push(`  - 「${it.title}」${it.seq ? `（${it.seq}）` : ''}｜挂于 ${it.endedAt ? hhmm(Number(it.endedAt)) : '?'}${it.ageMin !== null && it.ageMin !== undefined ? `（${it.ageMin} 分钟前）` : ''}${it.errorFirstLine ? `｜错误 ${String(it.errorFirstLine).slice(0, 70)}` : ''}｜${tagOf(it.action)}（${it.reason ?? ''}）`);
    }
  }
  // 【K-14 · §6.2】接力台账 TTL 巡检行：**超 10 分钟未改绑**必须在本段可见（方案写死的两个出口之一）。
  const rt = payload?.relayTtl ?? null;
  if (rt && rt.pending) {
    const p = rt.pending;
    const bits = [
      `待改绑 **1** 条（源 \`${String(p.sourceSessionId ?? '?').slice(0, 28)}…\` → 接手 \`${String(p.newSessionId ?? '?').slice(0, 28)}…\` · 交接 ${hhmm(Number(p.handoffAt) || now)}${p.expireAt ? ` · 超期清理线 ${hhmm(Number(p.expireAt))}` : ''}）`,
      `本轮清理 ${rt.cleared ?? 0}（超期 ${rt.expired ?? 0} / owner 已换 ${rt.ownerChanged ?? 0}）`,
    ];
    if (rt.rmwContention) bits.push('⚠️ **台账抢锁失败 ⇒ 条目保留、下轮重试**（审计 `skipped-rmw-contention`）');
    const rw = rt.rebindWarn ?? null;
    if (rw?.due) bits.push(`⚠️ **超 ${Math.round(Number(rw.warnMs ?? 600_000) / 60_000)} 分钟未改绑**${rw.suppressed ? `（本轮静默：${rw.suppressed === 'boot-grace' ? '实例刚起，20 分钟内不报' : '实例时长基准不可得'}）` : rw.fire ? '（已发桌宠）' : '（已告警过，不重复喊）'}`);
    block.push(`- 接力台账 TTL：${bits.join(' · ')}`);
  } else if (rt && ((rt.cleared ?? 0) > 0 || rt.rmwContention)) {
    block.push(`- 接力台账 TTL：本轮清理 ${rt.cleared ?? 0}（超期 ${rt.expired ?? 0} / owner 已换 ${rt.ownerChanged ?? 0}）${rt.rmwContention ? ' · ⚠️ **抢锁失败 ⇒ 条目保留、下轮重试**' : ''}`);
  }
  // 【G1G2 候选 C · 2026-09-25】「标了没交棒」巡检行（四计数；只读档的同批可见性）
  //   口径：方案 §5.1「机制自身健康观测」——**候选数 = 无法判定数** 即「本轮整体静默」（判据输入缺失）。
  const rhw = payload?.relayHandoffWatch ?? null;
  if (rhw && rhw.counts) {
    const c = rhw.counts;
    block.push(
      `- 交接巡检：候选 ${c.candidates ?? 0} · 断链 **${c.dangling ?? 0}** · 无法判定 ${c.undecidable ?? 0} · 已交棒 ${c.handed ?? 0}`
      + `${(c.candidates ?? 0) > 0 && c.candidates === c.undecidable ? ' · 🟡 **本轮整体静默**（chains 空 / 台账缺失 / 标记 sid 不在会话面）' : ''}`
      + `${rhw.fire ? ' · ⏫ **已告警**' : (c.dangling > 0 ? `（未投递：${rhw.suppressed ?? '-'}）` : '')}`,
    );
  }
  // 【改动 1 · 2026-09-29】断链看门狗行（总开关状态 + 三判据计数 + 本轮动作）
  //   口径：方案 §1「三条判据同时成立才动手」—— 开关关时也留一行，让「机制存在但关着」可见。
  const wd = payload?.relayWatchdog ?? null;
  if (wd) {
    if (wd.counts) {
      const w = wd.counts;
      block.push(
        `- 断链看门狗：主线 ${w.chains ?? 0} · 候选 ${w.candidates ?? 0} · 断链 **${w.silent ?? 0}** · 未到 30min ${w.withinGap ?? 0}`
        + ` · 已在跑 ${w.otherRunning ?? 0} · 已续棒 ${w.handed ?? 0} · 已收工 ${w.settled ?? 0} · 有意停【待续】 ${w.paused ?? 0} · 判不出 ${w.undecidable ?? 0}`
        + `${(wd.actions ?? []).length ? ` ⇒ 本轮动作：${wd.actions.map((a) => `「${a.chainKey}」${a.kind}${a.result ? `/${a.result}` : ''}`).join(' / ')}` : ''}`
        + `${wd.state?.saved === false ? `（状态未写：${wd.state.reason}）` : ''}`,
      );
    } else if (wd.enabled !== true) {
      block.push(`- 断链看门狗：**关**（${wd.skipped ?? '未开启'}）`);
    }
  }
  // 【C 口径 · 2026-09-17 叫醒通道合并】可见性补丁（V3 批次3 §4 第 5 条）：
  //   notify 档下真注入**只**由动作层执行 —— 必须把"四门开没开、动作层本轮干了什么"写在段头，
  //   否则会出现"档位已是 notify 但四门关 → 静默无动作"的黑箱（看起来在跑，其实一次都没发）。
  if (mode === 'notify') {
    const wl = payload?.wakeLayer ?? null;
    const gate = wl?.moduleGate ?? null;
    block.push(
      `- 叫醒执行者：**动作层 queue-wake**（C 口径 · 单一注入者）· 本轮 ${wl ? wl.status : '未跑（本轮无 notify 项或无候选）'}`
      + `${gate ? ` · 模块门：${gate.allowed ? '🟢 通过' : `🔴 关（${gate.reason ?? '未知'}）`}` : ''}`
      + `${wl?.injected ? ` · 注入 ${wl.injected}` : ''}${wl?.blocked ? ` · 被门挡下 ${wl.blocked}` : ''}${wl?.noop ? ` · 跳过 ${wl.noop}` : ''}`,
    );
  }
  if (!events.length) {
    block.push('- 本轮无事件（无滞留待验收卡，或尚未观察到）。');
  } else {
    for (const e of [...events].reverse().slice(0, 40)) {
      const icon = { notify: '🔔', report: '📣', escalate: '⏫', cleanup: '🧹', observe: '👀', skip: '·', 'relay-ttl': '🔁', 'relay-handoff-warn': '⏫', interrupt: '🔁', 'interrupt-report': '🔁' }[e.kind] ?? '·';
      const who = e.sessionId ? ` → \`${String(e.sessionId).slice(0, 28)}…\`` : '';
      const src = e.source ? `（${e.source}）` : '';
      block.push(`- ${hhmm(e.at)} ${icon} ${e.kind}${src}：**${e.title}**${e.seq ? `（${e.seq}）` : ''}${who} — ${e.detail ?? ''}`);
    }
  }
  block.push('');
  block.push('> 由 `<butler-root>\\tools\\dsh-butler\\butler-queue-tick.mjs` 每 1 分钟巡检（**只提醒，不自动验收/不自动起卡**）。');
  block.push('> 三档：observe（只记台账）→ report（日报 + 桌宠）→ notify（注入会话）。');

  if (opts.dryRun) return { ok: true, action: 'dry-run', file };

  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) {
      const header = [
        `# 管家日报 · ${dayKey(now)}`,
        '',
        `> 由 \`butler-queue-tick.mjs\` 于 ${hhmm(now)} 创建（原日报未生成时的兜底，面板 09:00 会重建）。`,
        '',
      ].join(eol);
      fs.writeFileSync(file, header, 'utf8');
    }
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = lines.findIndex((l) => /^##\s*🐳\s*队列推进提醒/.test(l));
    let next;
    if (start < 0) {
      const base = raw.endsWith('\n') || raw.endsWith('\r\n') ? raw : raw + eol;
      next = base + eol + block.join(eol) + eol;
    } else {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
      }
      next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join(eol);
      if (!next.endsWith(eol)) next += eol;
    }
    if (next === raw) return { ok: true, action: 'unchanged', file };
    fs.writeFileSync(file, next, 'utf8');
    return { ok: true, action: start < 0 ? 'appended' : 'updated', file };
  } catch (e) {
    return { ok: false, action: 'error', file, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------- 动作层桥（C 口径 · 2026-09-17 叫醒通道合并）

/**
 * 懒加载动作层（`lib/queue-wake.mjs`）。
 *
 * ⚠️ 必须**动态** import：`queue-wake.mjs` 顶部静态 import 本模块（判定函数是唯一源），
 *   反向静态 import 会构成 ESM 循环依赖（求值顺序脆弱）。动态 import 发生在两边求值完成之后，零风险。
 * @returns {Promise<object>}
 */
let _wakeModPromise = null;
function loadWakeModule() {
  if (!_wakeModPromise) _wakeModPromise = import('./queue-wake.mjs');
  return _wakeModPromise;
}

/**
 * 【C 口径 · 叫醒通道合并】把本轮的 notify 计划交给动作层执行（**唯一注入执行体**）。
 *
 * · **判定不重算**：`rows` = 本 tick 的 `planTick()` 结果 → 动作层只做"翻译 + 限额判定"（planWakeFromTick）；
 * · 注入走 `runAction()` 唯一闸门（L0 降档 / `p3AutoEnabled` / `modules['queue-wake']` / 单日上限 / 24h 去重）；
 * · **本函数不写 queue 台账** —— 台账回写由 runTick 按返回的 `results[]` 做（写者仍是本 tick，见动作层边界②）。
 */
async function runWakeLayer(args) {
  const mod = await loadWakeModule();
  return mod.runQueueWake({
    home: args.home, now: args.now, dryRun: false, cfg: args.cfg, baseUrl: args.baseUrl,
    ledger: args.ledger, rows: args.rows,
    // scan 只为满足动作层的"采集成功"前置（本轮 tick 已采集完，绝不重复 HTTP）
    scan: { ok: true, cfg: args.cfg, board: args.board, sessions: null, cards: args.cards ?? [], notifier: args.notifier, fakeSettled: 0 },
    deps: { inject: args.deps?.inject },
    injectTimeoutMs: args.injectTimeoutMs,
  });
}

// ---------------------------------------------------------------- 采集失败留痕与限流（Q6 · 2026-09-17）

// 病象（实测）：`session.list` 间歇超时 → `runTick` 整轮跳过 → 卡「④-4」二次进「待验收」
//   （22:54:48）后再没有投递通知 ⇒ **串行队列停摆**。当时唯一痕迹 = %TEMP% 日志一行 +
//   `butler-alert.log`（且**每轮一条、无冷却**）；台账里什么都看不到。
// 本段只治「留痕 + 噪音」，**不治判定**：双判据（isExecutionAlive）、四门、投递降级链一律原样。
//
// 口径（保守）：
//   · 失败统计**总是**累加（含 observe 档）—— 这是自身健康状况，不是对外副作用；
//   · 失败**告警/日报行/事件**共用同一个开关：连败段内**首轮必发**，其后 **≥ 冷却窗口才再发一条**
//     ⇒ 持续故障每小时最多 2 条，绝不每轮刷屏；
//   · 采集成功一轮 → `planCollectRecovery()` 把 streak 归零并复位告警冷却（下一段失败又是"首轮必发"）。
export const COLLECT_ALERT_COOLDOWN_MS = 30 * 60_000;

/**
 * 采集失败留痕计划（**纯函数**：只读台账 + 入参，不写文件、不发通知、不读时钟）。
 *
 * @param {{ledger?:object, now?:number, board?:object, sessions?:object, attempts?:number, cooldownMs?:number}} input
 * @returns {{streak:number, count:number, firstAt:number, alert:boolean, detail:string, attempts:number,
 *            suppressed:boolean, suppressReason:string|null, nextAlertEligibleAt:number|null, patch:object}}
 *   `alert` = **允许发这一轮的失败告警/日报行/事件**；`patch` = 要并进 `ledger.stats` 的字段。
 */
export function planCollectFailure(input = {}) {
  const {
    ledger = null, now = Date.now(), board = null, sessions = null, attempts = 1,
    cooldownMs = COLLECT_ALERT_COOLDOWN_MS,
  } = input;
  const stats = ledger?.stats ?? {};
  const prevStreak = Math.max(0, Number(stats.collectFailStreak ?? 0) || 0);
  const streak = prevStreak + 1;
  const firstAt = Number(stats.collectFailFirstAt ?? 0) || now;
  const lastAlertAt = Number(stats.collectAlertAt ?? 0) || null;
  const cd = Math.max(0, Number(cooldownMs) || 0);
  const firstInStreak = prevStreak === 0;                 // 连败段第一次：必发
  const cooled = lastAlertAt !== null && cd > 0 && now - lastAlertAt < cd;
  const alert = firstInStreak || !cooled;
  const nextAt = lastAlertAt !== null && cd > 0 ? lastAlertAt + cd : null;
  const detail = `board=${board ? (board.ok ? 'ok' : `✘${board.error ?? '?'}`) : '?'} / sessions=${sessions ? (sessions.ok ? 'ok' : `✘${sessions.error ?? '?'}`) : '?'}（尝试 ${attempts} 次）`;
  const patch = {
    collectFailures: (Number(stats.collectFailures ?? 0) || 0) + 1,
    collectFailStreak: streak,
    collectFailFirstAt: firstAt,
    collectFailLastAt: now,
    collectFailLastReason: detail,
    collectAlertAt: alert ? now : lastAlertAt,
    collectAlertCount: (Number(stats.collectAlertCount ?? 0) || 0) + (alert ? 1 : 0),
  };
  return {
    streak, count: patch.collectFailures, firstAt, alert, detail, attempts,
    suppressed: !alert,
    suppressReason: alert ? null : `告警限流中（同因冷却 ${Math.round(cd / 60_000)} 分钟，${Math.max(0, Math.round(((nextAt ?? now) - now) / 60_000))} 分钟后可再发）`,
    nextAlertEligibleAt: nextAt,
    patch,
  };
}

/**
 * 采集恢复正常（**纯函数**）：把连败段清零。`null` = 无连败段（常态，零副作用）。
 * @returns {null|{streak:number, firstAt:number|null, at:number, patch:object}}
 */
export function planCollectRecovery(input = {}) {
  const { ledger = null, now = Date.now() } = input;
  const stats = ledger?.stats ?? {};
  const streak = Math.max(0, Number(stats.collectFailStreak ?? 0) || 0);
  if (streak <= 0) return null;
  return {
    streak,
    firstAt: Number(stats.collectFailFirstAt ?? 0) || null,
    at: now,
    patch: { collectFailStreak: 0, collectFailFirstAt: null, collectAlertAt: null, collectRecoveredAt: now },
  };
}

// ---------------------------------------------------------------- tick 主流程

/**
 * 跑一轮（依赖可注入，便于单测断言「零注入」）。
 * @param {object} opts {home, now, config, mode, dryRun, baseUrl, deps:{readBoard, readSessions, inject, say, alert, writeDaily}, cfgOverride, json}
 */
export async function runTick(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? dshHome();
  const cfg = { ...(opts.config ?? loadConfig({ home, quiet: true })), ...(opts.cfgOverride ?? {}) };
  const mode = MODES.includes(opts.mode) ? opts.mode : cfg.mode;
  const dryRun = opts.dryRun === true;
  const deps = {
    readBoard: opts.deps?.readBoard ?? readBoard,
    readSessions: opts.deps?.readSessions ?? readSessions,
    inject: opts.deps?.inject ?? ((sid, text, o) => notifySession(sid, text, { baseUrl: opts.baseUrl, ...o })),
    say: opts.deps?.say ?? ((text, o) => sayWhale(text, { baseUrl: opts.baseUrl, ...o })),
    alert: opts.deps?.alert ?? ((entry, o) => sendAlert(entry, { home, ...o })),
    writeDaily: opts.deps?.writeDaily ?? refreshQueueSection,
  };
  const calls = { inject: 0, say: 0, alert: 0, daily: 0, notifyTargets: [] };

  const result = {
    ok: true, mode, dryRun, now, home,
    board: null, notifier: null, actions: [], entries: 0, calls, ledgerFile: ledgerPath(home), configFile: configPath(home), error: null,
    // A 段（叫醒目标绑定）：绑定表位置 / 表状态 / 逐卡目标来源统计 / cron 自动登记结果
    bindingsFile: bindingsPath(home), bindings: null, targets: null, autobind: null,
  };

  try {
    const ledger = opts.ledger ?? loadLedger({ home });
    const configHostile = cfg.mode !== mode ? { ...cfg, mode } : cfg;

    // 0) 当日事件流水（【Q6】定义上移到采集之前：采集失败分支也要能留痕 / 刷日报段）
    const day = dayKey(now);
    if (ledger.day?.day !== day) ledger.day = { day, events: [] };
    const pushEvent = (evt) => {
      // observe 档 = 零对外副作用：连"当日事件流水"都不落（日报段由它驱动），只留自身台账 + 日志。
      if (mode === 'observe') return;
      ledger.day.events = [...(ledger.day.events ?? []), evt].slice(-MAX_DAY_EVENTS);
    };

    // 1) 事件信箱（先消费，拿到 settle 时刻）
    const inbox = consumeInbox({ home, ledger, config: configHostile, inboxFile: opts.inboxFile });
    result.inbox = { newEvents: inbox.newEvents, offset: inbox.offset, size: inbox.size, reset: inbox.reset, skipped: inbox.skipped ?? null, error: inbox.error ?? null };
    if (inbox.reset) logLine(`⚠️ 事件信箱被截断/重建（size ${inbox.size} < offset ${ledger.inbox?.offset}）→ 从头重读`, { now });
    if (!dryRun && (inbox.newEvents || inbox.reset)) {
      ledger.inbox = { ...ledger.inbox, offset: inbox.offset, size: inbox.size, lastReadAt: new Date(now).toISOString(), consumedKeys: inbox.consumedKeys ?? ledger.inbox.consumedKeys, eventsSeen: (ledger.inbox?.eventsSeen ?? 0) + inbox.newEvents, resets: (ledger.inbox?.resets ?? 0) + (inbox.reset ? 1 : 0) };
    }
    const settledAt = {};
    for (const e of inbox.events) settledAt[e.taskId] = e.at;

    // 2) 只读采集
    //    【Q6 · 2026-09-17 采集抖动收口】sessions 一路加**有限重试**（共享实现 `lib/collect-retry.mjs`，
    //      口径与批次17 ctx-guard 同值：`retries=1` / 退避 1500ms，均可参数化）。
    //      实测病象：`session.list` 间歇超时（21:21 / 22:04 / 22:24 / …，同一时刻 board 是 ok）→ 整轮跳过
    //      → 卡再进「待验收」后没人叫醒 ⇒ **串行队列停摆**。重试**只治抖动**，失败语义一字不改。
    //    · board 一路**不加重试**：实测零失败（12 次采样 p50 102ms / max 124ms），无证据不动它。
    const [board, sxc] = await Promise.all([
      deps.readBoard({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl }),
      collectWithRetry(
        () => deps.readSessions({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl }),
        {
          retries: opts.collectRetries ?? cfg.collectRetries ?? DEFAULT_COLLECT_RETRIES,
          retryDelayMs: opts.collectRetryDelayMs ?? cfg.collectRetryDelayMs ?? DEFAULT_COLLECT_RETRY_DELAY_MS,
          onRetry: (info) => logLine(`🔁 会话采集失败（第 ${info.attempt}/${info.maxAttempts} 次：${info.error}）→ ${info.delayMs}ms 后重试`, { now }),
        },
      ),
    ]);
    const sessions = sxc.result ?? { ok: false, error: 'no-result', items: [] };
    result.board = { ok: board.ok, error: board.error ?? null, tasks: board.tasks?.length ?? 0, review: board.review?.length ?? 0, revision: board.revision ?? null };
    result.sessions = { ok: sessions.ok, error: sessions.error ?? null, total: sessions.items?.length ?? 0, attempts: sxc.attempts, retries: sxc.retries };
    if (!board.ok || !sessions.ok) {
      // 文案与旧口径**逐字一致**（失败不会被重试掩掉；attempts/retries 只作旁证，不进文案）
      const msg = `采集失败（board=${board.ok ? 'ok' : board.error} / sessions=${sessions.ok ? 'ok' : sessions.error}）→ 本轮跳过，不写台账`;
      logLine(`⚠️ ${msg}`, { now });
      result.error = msg;
      result.action = 'collect-failed';
      // 【Q6】留痕（治"整轮跳过静默"）：统计 + **限流**告警 + 日报行 —— 判定与投递链一行不动
      const plan = planCollectFailure({
        ledger, now, board, sessions, attempts: sxc.attempts,
        cooldownMs: opts.collectAlertCooldownMs ?? cfg.collectAlertCooldownMs ?? COLLECT_ALERT_COOLDOWN_MS,
      });
      result.collectFailure = {
        streak: plan.streak, count: plan.count, firstAt: plan.firstAt, alert: plan.alert,
        suppressed: plan.suppressed, reason: plan.suppressReason, detail: plan.detail,
        attempts: plan.attempts, nextAlertEligibleAt: plan.nextAlertEligibleAt,
      };
      if (plan.suppressed) logLine(`🔇 失败告警已限流：${plan.suppressReason}（连续失败 ${plan.streak} 轮）`, { now });
      if (!dryRun) {
        // 只在**既有**台账上累加：异常路径不新建状态文件（保持既有契约"采集失败不写台账"；
        // 生产环境台账必然已存在 ⇒ 统计照落；首次失败由 alert.log + %TEMP% 日志留痕。）
        if (fs.existsSync(ledgerPath(home))) {
          Object.assign(ledger.stats, plan.patch);
          if (plan.alert) {
            pushEvent({
              at: now, kind: 'collect-failed', title: '（队列巡检采集失败）',
              detail: `连续 ${plan.streak} 轮 · ${plan.detail} —— 本轮跳过，队列本轮不推进`,
            });
          }
          saveLedger(ledger, { home, now });
        } else {
          logLine('ℹ️ 台账尚未创建 → 本轮失败只落日志/告警，不新建状态文件', { now });
        }
      }
      // 日报段：**限流的只是告警与事件流水**；段里的失败行如实反映当前状态（整段替换，幂等）
      if (!dryRun && mode !== 'observe' && cfg.dailyReport !== false) {
        calls.daily++;
        const dre = await safeCall(async () => deps.writeDaily(dailyReportPath(now, { docsRoot: opts.docsRoot }), {
          events: ledger.day?.events ?? [], mode, device: deviceName(),
          last: ledger.stats?.lastNotify ?? null,
          bySource: ledger.stats?.bySource ?? null,
          collectFailure: { streak: plan.streak, count: plan.count, firstAt: plan.firstAt, at: now, detail: plan.detail, suppressed: plan.suppressed },
          stats: { ticks: ledger.stats?.ticks ?? 0, notified: ledger.stats?.notified ?? 0, escalated: ledger.stats?.escalated ?? 0, reported: ledger.stats?.reported ?? 0 },
        }, { now, device: deviceName() }));
        result.daily = dre ?? null;
      }
      return result;
    }
    // 【Q6】采集恢复正常 → 连败段清零（零副作用：没有连败段就什么都不做）
    const collectRec = planCollectRecovery({ ledger, now });
    if (collectRec) {
      Object.assign(ledger.stats, collectRec.patch);
      pushEvent({ at: now, kind: 'collect-recovered', title: '（队列巡检采集恢复）', detail: `连续失败 ${collectRec.streak} 轮后恢复（自 ${hhmm(collectRec.firstAt ?? now)}）` });
      logLine(`✅ 会话采集恢复（此前连败 ${collectRec.streak} 轮）`, { now });
      result.collectRecovery = { streak: collectRec.streak, firstAt: collectRec.firstAt, at: now };
    }

    // 双判据第二半：逐卡判「执行会话是否还活着」（假结算 → 绝不叫醒）
    const cards = (board.review ?? []).map((c) => {
      const withSettle = settledAt[c.id] ? { ...c, settledAt: settledAt[c.id] } : c;
      const exec = isExecutionAlive(withSettle, sessions.items, { enabled: cfg.checkExecutionAlive !== false });
      return { ...withSettle, exec };
    });
    // 【G3 · 候选 B 第 2 行】收集面追加一路「被打断卡」（todo/backlog 且末条 execution = interrupted）。
    //   ⚠️ 判定走 decide 的打断分支（独立命名空间，**不写 entries**）；review 优先排序见 planTick 收集顺序 + queue-wake 的 sortInterruptLast。
    const interruptCards = pickInterruptedCards(board.tasks).map((c) => ({
      ...c,
      exec: isExecutionAlive(c, sessions.items, { enabled: cfg.checkExecutionAlive !== false }),
    }));
    const tickCards = [...cards, ...interruptCards];
    result.interrupt = { candidates: interruptCards.length, ids: interruptCards.slice(0, 20).map((c) => c.id) };
    const fakeSettled = cards.filter((c) => c.exec?.alive === true);
    result.execCheck = {
      enabled: cfg.checkExecutionAlive !== false,
      alive: fakeSettled.length,
      items: fakeSettled.map((c) => ({ taskId: c.id, seq: c.seq, sessionId: c.exec.sessionId, reason: c.exec.reason })),
    };
    if (fakeSettled.length) {
      logLine(`⏳ 疑似假结算 ${fakeSettled.length} 张（执行会话仍在跑，本轮不对其叫醒）：${fakeSettled.map((c) => c.seq ?? c.id).join(' / ')}`, { now });
    }
    const notifier = pickNotifier(sessions.items, { targetPrefix: cfg.targetPrefix });
    result.notifier = { kind: notifier.kind, count: notifier.count, sessionId: notifier.sessionId ?? null, running: notifier.running ?? null, source: 'fallback' };

    // 2b) 叫醒目标绑定表（A 段）：读表 → cron 自动登记（无会话身份 → 显式 source:'cron'，**不猜**）
    //     ⚠️ fail-safe：坏表 = 无绑定（降级到标题判据），绝不会因为一个坏文件就发错人。
    let bindings = opts.bindings ?? loadBindings({ home });
    if (bindings.corrupt) {
      logLine(`⚠️ 绑定表损坏（${bindings.error}）→ 本轮按「无绑定」走降级链（绝不因此误发）`, { now });
    }
    const auto = autobindCronCards({ cards: pickRunningCards(board.tasks), bindings, home, now, dryRun, actor: opts.actor ?? 'butler-queue-tick' });
    if (!dryRun && auto.bound) bindings = loadBindings({ home });
    result.autobind = auto;
    if (auto.missing) {
      logLine(`🔗 绑定自动登记：${auto.missing} 张进行中卡无绑定 → 显式记 source=cron${dryRun ? '（dry-run 未写）' : `（已写 ${auto.bound}）`}`, { now });
    }
    result.bindings = {
      file: bindings.file, exists: bindings.exists === true, corrupt: bindings.corrupt === true,
      cards: Object.keys(bindings.cards ?? {}).length, lines: Object.keys(bindings.lines ?? {}).length,
      error: bindings.error ?? null,
    };

    // 2c) 【卡 S2 · §6.1 改投】接力台账快照（**唯一读点**：这里读文件，纯函数只吃结果）
    //     缺台账 / 坏 JSON / schema > 1 ⇒ pending=null ⇒ 改投判据整体不成立 ⇒ 照旧投源会话（fail-safe）。
    const handoff = readHandoffSnapshot({ home, now, sessions: sessions.items, pending: opts.pendingHandoff, graceMs: opts.rerouteGraceMs });
    result.handoff = {
      source: handoff.source, pending: handoff.pending
        ? { sourceSessionId: handoff.pending.sourceSessionId, newSessionId: handoff.pending.newSessionId, handoffAt: handoff.pending.handoffAt, expireAt: handoff.pending.expireAt, chainId: handoff.pending.chainId }
        : null,
    };

    // 2e) 【G1G2 候选 C · 2026-09-25】「标了没交棒」巡检（**只读 + 可选告警**）
    //     口径：`docs/` §5.1（判据）/ §5.2（落点）；库 = `./relay-handoff-watch.mjs`
    //     · **主判据 = 标记文件存在**（`mtime` **数字毫秒**；⛔ 禁 `markedAt`）；空态四例一律「无法判定 ⇒ 静默」；
    //     · `chains` **不在** `readHandoffSnapshot()` 的返回值里 ⇒ 由注入依赖调 relay 的 `readLedger()`
    //       （`session-relay.mjs:458` 已导出，**纯读**，本卡**不新增 relay 台账写者**），且与 `handoff.pending`
    //       **同一轮、同一时刻**取（就在上面一行，防两份状态来自不同瞬间）；
    //     · 投递门禁：`dryRun` / `mode==='observe'` ⇒ 只算不投 + 幂等键不落（照 `:1735` / `:1771` 先例）；
    //     · 只读观察档**不消费去重/冷却配额**（persona 三红线 ①）；
    //     · 失败隔离：与 `:1788` 的 TTL 段同款 —— 巡检异常绝不许拖垮整轮 tick（关键路径是叫醒）。
    try {
      const relayMod = await loadRelayModule();
      const marks = typeof relayMod.listHandedMarks === 'function' ? relayMod.listHandedMarks({ home }) : [];
      const ledgerRead = typeof relayMod.readLedger === 'function' ? relayMod.readLedger({ home }) : null;
      const exemptState = loadRelayHandoffWarnState({ home });
      const judged = judgeDanglingHandoffs({
        marks, ledgerRead, sessions: sessions.items, pending: handoff.pending ?? null,
        exempt: exemptState.exempt, now,
      });
      const planned = planRelayHandoffWatch({
        judged, now, mode, dryRun, emit: true,
        warnState: ledger.stats?.[WARN_STATS_KEY] ?? null, dateKey: day,
        dailyMax: opts.relayHandoffDailyMax,
      });
      result.relayHandoffWatch = {
        counts: judged.counts, due: planned.due, fire: planned.fire,
        suppressed: planned.suppressed, freshKeys: planned.freshKeys.length, keys: planned.allKeys.slice(0, 20),
        emit: planned.emit, gateOpen: planned.gateOpen,
        exemptFile: exemptState.file, exemptExists: exemptState.exists === true, exemptWarning: exemptState.warning ?? null,
      };
      // 只读观察档（每轮刷新、整段替换；`--dry-run` 零写盘 ⇒ action='dry-run'）
      const docPath = opts.relayHandoffDocPath ?? observeDocPath(now, { docsRoot: opts.docsRoot, dateKey: day });
      result.relayHandoffWatch.doc = writeObserveDoc(
        docPath,
        renderObserveDoc({ judged, planned, mode, dryRun, now }, { dateKey: day }),
        { dryRun, write: opts.relayHandoffDoc !== false },
      );
      if (planned.fire && planned.patch) {
        // 🔴 幂等键**必须落在 `stats` 里**（`saveLedger()` 只落 entries/inbox/day/stats 四个字段，
        //    顶层自定义字段会被丢弃 —— 首版实测踩过：键没落盘 ⇒ 下一轮又喊一次）。
        ledger.stats[WARN_STATS_KEY] = { ...(ledger.stats[WARN_STATS_KEY] ?? {}), ...planned.patch };
        calls.say++;
        await safeCall(() => deps.say(planned.text, { state: 'idle' }));
        calls.alert++;
        await safeCall(() => deps.alert({
          level: 'warn', source: 'butler-queue', message: planned.text,
          detail: { keys: planned.keys, candidates: judged.counts.candidates, undecidable: judged.counts.undecidable },
        }, { silent: true }));
        pushEvent({ at: now, kind: 'relay-handoff-warn', title: '（标了没交棒）', detail: planned.text.slice(0, 160) });
        logLine(`⏫ ${planned.text}`, { now });
      } else if (judged.counts.dangling > 0 || (judged.counts.candidates > 0 && judged.counts.candidates === judged.counts.undecidable)) {
        // 静默必须可见：断链被判静默（门禁/已喊过）或判据输入缺失（候选数 = 无法判定数）时留一行
        logLine(`👀 交接巡检（静默）：候选 ${judged.counts.candidates} · 断链 ${judged.counts.dangling} · 无法判定 ${judged.counts.undecidable} · 已交棒 ${judged.counts.handed} · ${planned.suppressed ?? '-'}`, { now });
      }
    } catch (e) {
      result.relayHandoffWatch = { ok: false, error: e?.message ?? String(e) };
      logLine(`⚠️ 交接巡检异常（已隔离）：${e?.message ?? e}`, { now });
    }

    // 2f) 【改动 1 · 断链看门狗 · 2026-09-29】链静止判定 + 自动重投 / 报警
    //     口径真源：`docs/` §0/§1；
    //     实测依据：`docs/` §0/§4.3（缺口 G8 —— 历史 33 个
    //       「停 ≥25 分钟」窗口内零闸门记录 = 该干活的那一棒没干活、且没有任何机制知道）。
    //     · **总开关 = `butler-autonomy-limits.json#relayWatchdog.enabled`**，**缺省即关** ⇒
    //       本段连判定都不跑（零 IO / 零写盘 / 零通知）⇒ 生产行为与改动前逐字相同；
    //       放行 = 加键（乙档，等主人拍板）—— **不是**改代码、不是 deploy。
    //     · 【N18 · 2026-10-10】可选 `relayWatchdog.activeWindowMs` ⇒ 透传给 `judgeChainSilence`，
    //       控制「链尾仍活跃」的窗口（缺省 30 分钟；链尾在跑 turn 或最近还有活动 ⇒ 不判断链）。
    //     · 子开关 `relayWatchdog.rehandoff`（默认 false）⇒ 关时「只报警、不重投」（甲档形态）。
    //     · 闸门链（三段，缺一即不动）：`relayWatchdog.enabled` × 档位门禁（`--dry-run` / `mode==='observe'`）
    //       × **relay 自身总闸**（重投走 `actor:'agent'` ⇒ `modules.relay.enabled` + relay 的 7 道闸）。
    //       ⚠️ **不并 runAction 四键**（理由见交付报告：本动作是接力链的恢复动作，不是 P3 队列叫醒；
    //          且它已经被 relay 自己的总闸管住，多一层只会让"一键停"落到两处）。
    //     · 三红线 ①：`mode==='observe'` / `--dry-run` ⇒ 判完即止，**不写状态文件**（不消费节流配额）。
    //     · 三红线 ③：本段日志只走 `logLine`（落文件），**不改 stdout 契约**。
    //     · 失败隔离：与 2e / 2d 同款 —— 看门狗异常绝不拖垮整轮 tick（关键路径永远是叫醒）。
    try {
      const wdCfg = opts.relayWatchdog ?? (() => {
        try { return readLimits({ home })?.relayWatchdog ?? null; } catch { return null; }
      })();
      const wdEnabled = wdCfg?.enabled === true;
      result.relayWatchdog = {
        enabled: wdEnabled,
        source: opts.relayWatchdog ? 'injected' : 'limits-file',
        skipped: wdEnabled ? null : 'disabled（`relayWatchdog.enabled !== true` ⇒ 缺省即关，本段零动作）',
        stateFile: watchdogStatePath({ home }),
        counts: null, actions: [], outcomes: [], state: null,
      };
      if (wdEnabled) {
        const relayMod2 = await loadRelayModule();
        const marks2 = typeof relayMod2.listHandedMarks === 'function' ? relayMod2.listHandedMarks({ home }) : [];
        const ledgerRead2 = typeof relayMod2.readLedger === 'function' ? relayMod2.readLedger({ home }) : null;
        const wdLoaded = loadWatchdogState({ home });
        const wdJudged = judgeChainSilence({
          ledgerRead: ledgerRead2, sessions: sessions.items, marks: marks2,
          pending: handoff.pending ?? null, now, silentGapMs: wdCfg?.silentGapMs,
          // 【N18 · 2026-10-10】链尾「仍活跃」窗口（缺省 30 分钟）——链尾在跑/最近还有活动 ⇒ 静默。
          activeWindowMs: wdCfg?.activeWindowMs,
        });
        const wdPlan = planChainWatchdog({
          judged: wdJudged, state: wdLoaded.state, now, mode, dryRun, enabled: true,
          rehandoffEnabled: wdCfg?.rehandoff === true || wdCfg?.rehandoff?.enabled === true,
          throttleMs: wdCfg?.throttleMs, maxAttempts: wdCfg?.maxAttempts, failStreakMax: wdCfg?.failStreakMax,
        });
        result.relayWatchdog.counts = wdJudged.counts;
        result.relayWatchdog.suppressed = wdPlan.suppressed;
        result.relayWatchdog.stateWarning = wdLoaded.warning ?? null;
        result.relayWatchdog.actions = wdPlan.actions.map((a) => ({
          chainKey: a.chainKey, sid: a.sid, form: a.form, kind: a.kind, alert: a.alert,
          reason: a.reason, silentMin: a.silentMin, attempts: a.attempts,
        }));
        // 只读观察档（整段替换；`--dry-run` 零写盘）—— 只在开关开着时写，缺省关 ⇒ 生产零新增文件
        if (wdCfg?.doc !== false) {
          const wdDoc = opts.relayWatchdogDocPath ?? watchdogDocPath(now, { docsRoot: opts.docsRoot, dateKey: day });
          result.relayWatchdog.doc = writeObserveDoc(
            wdDoc,
            renderWatchdogDoc({ judged: wdJudged, planned: wdPlan, mode, dryRun, now }, { dateKey: day }),
            { dryRun, write: true },
          );
        }
        const outcomes = [];
        for (const act of wdPlan.actions) {
          if (act.kind === CHAIN_ACTION.THROTTLED) {
            logLine(`⏳ 断链看门狗：主线「${act.mainline}」${act.reason}`, { now });
            continue;
          }
          if (act.kind === CHAIN_ACTION.REHANDOFF) {
            const files = listHandoffDocs({ docsDir: opts.handoffDocsDir }).files;
            const doc = pickHandoffDocPath(files, { mainline: act.mainline, at: act.wakeAt });
            if (!doc) {
              // 找不到档 ⇒ **绝不瞎猜一份档去建会话** ⇒ 记为一次失败的重投（会走「连续失败 2 次停招」）
              act.result = 'failed'; act.reason = 'no-handoff-doc'; act.alert = true;
              outcomes.push({ ...act, kind: CHAIN_ACTION.REHANDOFF, result: 'failed', reason: 'no-handoff-doc' });
              logLine(`⚠️ 断链看门狗：主线「${act.mainline}」找不到可重跑的交接档 ⇒ 本次重投记为失败（不瞎猜档）`, { now });
            } else {
              const injected = typeof deps.rehandoff === 'function' ? deps.rehandoff : null;
              const rr = await safeCall(async () => {
                if (injected) return injected({ chainKey: act.chainKey, mainline: act.mainline, sessionId: act.sid, docPath: doc.path, home, baseUrl: opts.baseUrl, now });
                const mod = await loadRelayModule();
                const r = await mod.runRelay({ handoff: doc.path, session: act.sid, actor: 'agent', home, baseUrl: opts.baseUrl, quiet: true });
                return { ok: r?.ok === true && r?.exitCode === 0, exitCode: r?.exitCode ?? null, reason: r?.reason ?? null, newSessionId: r?.newSessionId ?? null };
              });
              const ok = rr?.ok === true;
              act.docPath = doc.path; act.result = ok ? 'ok' : 'failed';
              if (!ok) act.reason = `rehandoff-failed: ${rr?.reason ?? rr?.error ?? 'unknown'}`;
              outcomes.push({ ...act, kind: CHAIN_ACTION.REHANDOFF, result: act.result });
              logLine(`${ok ? '🔁' : '⚠️'} 断链看门狗：主线「${act.mainline}」重投第 ${act.attempts + 1}/${act.maxAttempts} 次`
                + `${ok ? `成功（档 ${doc.name} · 新会话 ${String(rr?.newSessionId ?? '').slice(0, 20)}…）` : `失败（档 ${doc.name} · ${act.reason}）`}`, { now });
            }
          } else {
            outcomes.push({ ...act });
          }
          // 报警（重投同时必须报警）：日报段 + `butler-alert.log`（`deps.alert`）+ 桌宠；
          //   notify 档再**投一次给同刻在跑的【运行】会话**（= 「能接手的新会话」这一条通道）。
          if (act.alert === true) {
            const text = renderWatchdogText([act], { now });
            calls.say++;
            await safeCall(() => deps.say(text, { state: 'idle' }));
            calls.alert++;
            await safeCall(() => deps.alert({
              level: act.kind === CHAIN_ACTION.ESCALATE || act.kind === CHAIN_ACTION.HALTED ? 'error' : 'warn',
              source: 'butler-queue',
              message: text,
              detail: { chainKey: act.chainKey, sid: act.sid, form: act.form, kind: act.kind, attempts: act.attempts, silentMin: act.silentMin, docPath: act.docPath ?? null },
            }, { silent: true }));
            pushEvent({ at: now, kind: 'relay-watchdog', title: `（断链看门狗·${act.kind}）`, detail: text.slice(0, 160) });
            logLine(`⏫ ${text}`, { now });
            if (!dryRun && mode === 'notify') {
              const wdTgt = pickNotifier(sessions.items, { targetPrefix: cfg.targetPrefix });
              if (wdTgt.kind === 'unique' && wdTgt.sessionId) {
                calls.inject++;
                const wdInj = await safeCall(() => deps.inject(wdTgt.sessionId, text, {}));
                if (wdInj?.ok !== true) logLine(`⚠️ 断链看门狗：投递到活跃会话失败（${wdInj?.error ?? wdInj?.reason ?? 'unknown'}）`, { now });
              }
            }
          }
        }
        result.relayWatchdog.outcomes = outcomes.map((o) => ({ chainKey: o.chainKey, kind: o.kind, result: o.result ?? null, reason: o.reason ?? null }));
        // 状态落盘：**门禁关 / dry-run ⇒ 不写**（只读观测不消费节流配额，persona 三红线 ①）
        if (wdPlan.gateOpen && !dryRun) {
          const merged = applyWatchdogOutcome(wdLoaded.state, outcomes, { now });
          const pruned = pruneWatchdogState(merged, { now });
          const saved = saveWatchdogState(pruned.state, { home });
          result.relayWatchdog.state = { saved: saved.ok === true, action: saved.action, chains: Object.keys(pruned.state.chains).length, pruned: pruned.dropped.length };
        } else {
          result.relayWatchdog.state = { saved: false, reason: dryRun ? 'dry-run' : 'gate-closed' };
        }
      }
    } catch (e) {
      result.relayWatchdog = { ok: false, error: e?.message ?? String(e) };
      logLine(`⚠️ 断链看门狗异常（已隔离）：${e?.message ?? e}`, { now });
    }

    // 2d) 【K-14 · 台账 TTL 巡检】本 job = 方案写死的**独立驱动者**（每 1 分钟一轮，不依赖"下一次接力"）。
    //     · 判定与清理**同源**复用 `session-relay#sweepLedgerTtl`（与 `--selfcheck` 同一函数），本处只编排；
    //     · 门禁：`--dry-run`（零写盘）与 `observe` 档（跨组件写 + 写审计 = 对外副作用）⇒ 只判不清；
    //     · 抢锁失败 ⇒ 保留条目 + 审计 `skipped-rmw-contention` + 下轮重试（K-32，绝不静默丢）；
    //     · 超 10 分钟未改绑 ⇒ 幂等键落 queue 台账 → 日报段 + 桌宠（同一交接条目只喊一次）。
    //     ⚠️ 采集失败的那一轮会在这里之前早退（动作链整体跳过）—— 该轮不做 TTL 巡检（如实声明，见交付报告「未验面」）。
    try {
      // 连续 tick 链（R5「跨停机不累计」第二道闸）：上一轮 tick 距今 —— 缺上一轮（null）⇒ 本轮静默（保守）
      const prevTickAt = Date.parse(String(ledger.stats?.lastTickAt ?? ''));
      const chainGapMs = Number.isFinite(prevTickAt) ? now - prevTickAt : null;
      const ttl = await sweepRelayLedgerTtl({
        home, now, pending: handoff.pending ?? null, bindings,
        dryRun, readOnly: dryRun || mode === 'observe',
        warnedKey: ledger.stats?.relayTtl?.warnedKey ?? null, chainGapMs,
        sweep: opts.deps?.sweepLedgerTtl, warnMs: opts.rebindWarnMs, ownerLookup: opts.ownerLookup,
        // 单测可注入：实例在线时长 / 静默窗 / tickd 心跳落点（缺省 = 读真实 tickd 心跳）
        uptimeMs: opts.uptimeMs, bootGraceMs: opts.bootGraceMs, tickdDir: opts.tickdDir, tickdStateFile: opts.tickdStateFile,
      });
      result.relayTtl = {
        rule: ttl.rule, ok: ttl.ok, sweepRan: ttl.sweepRan, readOnly: ttl.readOnly === true || dryRun,
        skipped: ttl.skipped ?? null, error: ttl.error ?? null,
        pending: ttl.cleared > 0 ? null : (ttl.pending ? { ...ttl.pending } : null),
        cleared: ttl.cleared, expired: ttl.expired, ownerChanged: ttl.ownerChanged,
        rmwContention: ttl.rmwContention, rebindWarn: ttl.rebindWarn, warned: false,
        uptimeMs: ttl.uptimeMs ?? null, uptimeSource: ttl.uptimeSource ?? null, chainGapMs,
      };
      if (ttl.skipped) logLine(`⚠️ 接力台账 TTL 巡检跳过（${ttl.skipped}）：${ttl.error ?? ''} —— 本轮**不清任何条目**，下轮重试`, { now });
      if (ttl.cleared > 0) {
        logLine(`🧹 接力台账 TTL：清掉 ${ttl.cleared} 条 pendingHandoff（超期 ${ttl.expired} / owner 已换 ${ttl.ownerChanged}）· 审计 stale-pending-handoff`, { now });
        pushEvent({ at: now, kind: 'relay-ttl', title: '（接力台账 TTL 巡检）', detail: `清掉 ${ttl.cleared} 条 pendingHandoff（超期 ${ttl.expired} / owner 已换 ${ttl.ownerChanged}）→ 审计 stale-pending-handoff` });
      }
      if (ttl.rmwContention) {
        logLine('⚠️ 接力台账 RMW 抢锁失败 ⇒ **保留 pendingHandoff**、下轮重试（已审计 skipped-rmw-contention）', { now });
      }
      const rw = ttl.rebindWarn ?? null;
      if (rw?.due) {
        const ageMin = Math.round((rw.ageMs ?? 0) / 60_000);
        const warnMin = Math.round((rw.warnMs ?? DEFAULT_REBIND_WARN_MS) / 60_000);
        if (rw.suppressed) {
          // §6.2 ② + S5/R5：超时判据按**实例在线时长**计 —— 静默必须**可见**（否则看起来像"机制不存在"）
          logLine(`⏳ 接力改绑超时（${ageMin} 分钟 > ${warnMin} 分钟线）但本轮**静默**：`
            + (rw.suppressed === 'boot-grace'
              ? `本实例在线仅 ${Math.round((rw.uptimeMs ?? 0) / 60_000)} 分钟（实例重启后前 ${Math.round((rw.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS) / 60_000)} 分钟不报 · §6.2 ② / S5）`
              : '实例在线时长基准不可得（tickd 心跳缺失）⇒ 偏保守不报'), { now });
        } else {
          logLine(`⏳ 接力改绑超时：源 ${ttl.pending?.sourceSessionId ?? '?'} → 接手 ${ttl.pending?.newSessionId ?? '?'} 已 ${ageMin} 分钟未改绑（§6.2 线 ${warnMin} 分钟）${rw.alreadyWarned ? '（本条目已告警过，不重复喊）' : ''}`, { now });
        }
      }
      if (rw?.fire && mode !== 'observe' && !dryRun) {
        const text = `接力改绑超时（${Math.round((rw.ageMs ?? 0) / 60_000)} 分钟）：源 ${ttl.pending?.sourceSessionId ?? '?'} → 接手 ${ttl.pending?.newSessionId ?? '?'} 尚未改绑`
          + ' —— 接手会话请先 `node <butler-root>\\tools\\session-mark.mjs --handed --base "<主线>"`，再逐卡改绑';
        // ⚠️ 幂等键必须落在 `stats` 里：`saveLedger()` 只落 entries/inbox/day/stats 四个字段
        //   （顶层自定义字段会被丢弃 —— 首版实测踩过：键没落盘 ⇒ 下一轮又喊一次）。
        ledger.stats.relayTtl = { ...(ledger.stats.relayTtl ?? {}), warnedKey: rw.key, warnedAt: now };
        result.relayTtl.warned = true;
        pushEvent({ at: now, kind: 'relay-ttl', title: '（接力改绑超时）', detail: text });
        calls.say++;
        await safeCall(() => deps.say(text, { state: 'idle' }));
        calls.alert++;
        await safeCall(() => deps.alert({
          level: 'warn', source: 'butler-queue', message: text,
          detail: { sourceSessionId: ttl.pending?.sourceSessionId ?? null, newSessionId: ttl.pending?.newSessionId ?? null, chainId: ttl.pending?.chainId ?? null, ageMs: rw.ageMs, warnMs: rw.warnMs, key: rw.key },
        }, { silent: true }));
        logLine(`⏫ ${text}`, { now });
      }
    } catch (e) {
      // 失败隔离：巡检异常绝不外抛（本 job 的关键路径是叫醒，不是这一项）
      result.relayTtl = { ok: false, error: e?.message ?? String(e) };
      logLine(`⚠️ 接力台账 TTL 巡检异常（已隔离）：${e?.message ?? e}`, { now });
    }

    // 2.6) 【N12 · 2026-10-10】叫醒存亡确认（**只读**证据采集；开关关着时一次 IO 都不做）
    //   治：卡进 review → 叫醒注入成功 → 紧接着 P0 重启把目标会话刚起的回合打断 ⇒ 台账已记
    //       `notifiedAt`、去重签名也认为"通知过" ⇒ 此后无人重投（2026-10-10 凌晨静默 6.5h 实证）。
    //   本步只采集"目标会话尾部回合状态"这一个客观量；判定在 `decideReceipt`（纯函数），
    //   补投走**同一套** notify 通道（动作层 runAction：四门 + 单日上限 + 去重签名 + 台账回写）。
    //   失败隔离：采集异常绝不外抛（本 job 关键路径是叫醒，不是这一项）。
    let receiptEvidence = { enabled: false, bySession: {}, candidates: 0, targets: 0, reason: 'not-collected' };
    if (!dryRun) {
      try {
        receiptEvidence = collectWakeReceipt({ home, now, ledger, sessions: sessions.items, cfg: configHostile, mode });
      } catch (e) {
        receiptEvidence = { enabled: false, bySession: {}, candidates: 0, targets: 0, reason: `collect-error:${e?.message ?? e}` };
        logLine(`⚠️ 叫醒存亡确认证据采集异常（已隔离）：${e?.message ?? e}`, { now });
      }
      result.wakeReceipt = {
        enabled: configHostile.wakeReceipt?.enabled === true,
        candidates: receiptEvidence.candidates, targets: receiptEvidence.targets,
        states: Object.fromEntries(Object.entries(receiptEvidence.bySession).map(([k, v]) => [k, v.state])),
        reason: receiptEvidence.reason,
      };
    }

    // 2.9) 【V3功能面 · 失败卡通知档 · 2026-10-22】failed 卡也叫醒一次（与 review 同一条通道）
    //   动机见文件头；缺口 = 「已经死透的卡没有任何出口」。本段**纯增量**：
    //     · 开关关（`failedNotify:false`）⇒ 整段不跑、result 无新字段、台账无新键（逐字旧行为）；
    //     · 判定 = `decideFailed`（纯函数）；状态 = `stats.failedNotify[cardId]`（**独立命名空间**，不碰 entries）；
    //     · 真注入与 review 同一条执行体（动作层 queue-wake，四门 + 单日上限 + 24h 签名），
    //       签名令牌 = executionId（`eventKeyRaw`）⇒ 同一 execution 不会被投第二次。
    const failedSw = failedNotifySettings(configHostile);
    let failedRows = [];
    if (failedSw.enabled) {
      const sidxFailed = sessionIndex(sessions.items);
      const failedCards = pickFailedCards(board.tasks).map((c) => ({
        ...c,
        exec: isExecutionAlive(c, sessions.items, { enabled: cfg.checkExecutionAlive !== false }),
      }));
      failedRows = failedCards.map((c) => {
        const binding = bindings ? resolveBinding(resolveCardBinding(bindings, c.id), sidxFailed, { source: 'binding' }) : null;
        const lineOwner = bindings ? resolveBinding(resolveLineOwner(bindings, c.line), sidxFailed, { source: 'line-owner' }) : null;
        const decision = decideFailed({
          card: c, state: (ledger.stats.failedNotify ?? {})[c.id] ?? null, now, mode, cfg: configHostile,
          binding, lineOwner, notifier, handoff,
        });
        return { card: c, entry: null, decision, binding, lineOwner };
      });
      result.failedNotify = {
        enabled: true,
        switch: { graceMs: failedSw.graceMs, ttlMs: failedSw.ttlMs },
        candidates: failedCards.length,
        injected: 0, reported: 0, escalated: 0, deferred: 0, skipped: 0,
        items: failedRows.map(({ card, decision }) => {
          const fact = card.failedFact ?? null;
          const tg = decision?.detail?.notifier ?? notifier;
          const endedAt = Number(fact?.endedAt ?? 0) || 0;
          return {
            taskId: card.id, title: card.title, seq: card.seq ?? null,
            executionId: fact?.executionId ?? null, endedAt: endedAt || null,
            ageMin: endedAt ? Math.max(0, Math.round((now - endedAt) / 60_000)) : null,
            errorFirstLine: fact?.errorFirstLine ?? null, deliverables: fact?.deliverables ?? [],
            action: decision?.action ?? null, reason: decision?.reason ?? null,
            source: decision?.source ?? null,
            targetSource: decision?.patch?.targetSource ?? tg?.source ?? null,
            targetSessionId: decision?.patch?.targetSessionId ?? tg?.sessionId ?? null,
          };
        }),
      };
      if (failedCards.length) {
        logLine(`🗂 失败卡通知档：候选 ${failedCards.length} 张（${failedCards.map((c) => c.seq ?? c.id).join(' / ')}）· 档位 ${mode}${dryRun ? ' · dry-run（只算不投）' : ''}`, { now });
      }
    }

    // 3) 纯函数判定（逐卡走降级链：卡级绑定 → 主线 owner → 标题唯一 → escalate）
    const plan = planTick({
      cards: tickCards, entries: ledger.entries, notifier, bindings, sessions: sessions.items, now, mode, cfg: configHostile, handoff,
      // 【G3 · v3·R6】打断通道载体（tick 是台账唯一写者；decide 只读）
      interruptedDay: ledger.stats.interruptedDay ?? null,
      interrupted: ledger.stats.interrupted ?? null,
      // 【N12】叫醒存亡确认证据（开关关着 ⇒ enabled:false ⇒ decide ③ 逐字走老路）
      receipt: receiptEvidence,
    });

    // 逐卡目标来源统计（`--status` / `--dry-run` / 日报都用它，治「档位躺平没人知道」）
    const targets = { binding: 0, 'line-owner': 0, fallback: 0, [SOURCE_HANDOFF_REROUTE]: 0, none: 0, degraded: [] };
    for (const it of plan) {
      if (!it.card) continue;
      const src = it.decision?.patch?.targetSource ?? it.decision?.detail?.notifier?.source ?? null;
      if (!src) continue;
      targets[src] = (targets[src] ?? 0) + 1;
      const deg = it.decision?.patch?.targetDegraded ?? null;
      if (deg && targets.degraded.length < 20) {
        targets.degraded.push({ taskId: it.card.id, seq: it.card.seq ?? null, reasons: String(deg).split(',') });
      }
    }
    result.targets = targets;

    // 4) 执行动作（observe / dry-run 下不产生任何对外副作用）
    //    （当日事件流水的初始化在步骤 0 —— Q6 上移，采集失败分支也要能留痕）

    // 4a) 【C 口径 · 2026-09-17 叫醒通道合并】notify 档的**真注入**统一交给动作层（唯一注入执行体）：
    //     · 判定一行不动：rows = 本 tick 的 planTick 结果（含叫醒目标降级链 + 事件信箱的 settledAt）；
    //     · 执行走 runAction 四门（L0 降档 / p3AutoEnabled / modules['queue-wake'] / 档位 notify）
    //       + 24h 签名去重 + 单日上限；
    //     · 四门任一关 → 本段只产出 blocked，**不注入、不写 notifiedAt**（下轮继续尝试）；
    //     · tick 自己**不再调 deps.inject** ⇒ 不存在"A/B 各自投递"。
    const wakeResults = new Map();
    if (!dryRun && mode === 'notify') {
      // 【G3 · 候选 B 第 12 行 + v4·R10 同源】送行 filter 必须与 `queue-wake.mjs` 的注入判定**同源、同批改**：
      //   不扩 ⇒ 本轮"只有打断卡、零 review 卡"时判空 ⇒ 走 no-candidate ⇒ 动作层根本不调用 ⇒ 静默不发。
      // 【V3功能面 · 失败卡通知档】第三档 `failed-notify` 一并送行（开关关时 failedNotifyRows = [] ⇒ 逐字旧行为）。
      const failedNotifyRows = failedSw.enabled ? failedRows.filter((r) => r.decision?.action === 'failed-notify') : [];
      const wakeRows = [...plan, ...failedNotifyRows];
      const notifyRows = wakeRows.filter((it) => it.card && (it.decision.action === 'notify' || it.decision.action === 'interrupt-notify' || it.decision.action === 'failed-notify'));
      if (!notifyRows.length) {
        result.wakeLayer = { ok: true, status: 'no-candidate', reason: '本轮无 notify 项', injected: 0, failed: 0, blocked: 0, noop: 0, moduleGate: null };
      } else {
        const w = await safeCall(() => runWakeLayer({
          home, now, cfg: configHostile, board, notifier, cards: tickCards, rows: wakeRows, ledger,
          deps, baseUrl: opts.baseUrl, injectTimeoutMs: opts.injectTimeoutMs,
        }));
        result.wakeLayer = {
          ok: w?.ok !== false,
          status: w?.status ?? 'error',
          reason: w?.reason ?? (w?.error ? String(w.error) : null),
          injected: w?.injected ?? 0, failed: w?.failed ?? 0, blocked: w?.blocked ?? 0, noop: w?.noop ?? 0,
          planned: w?.plan?.summary ?? null,
          moduleGate: w?.moduleGate ? { allowed: w.moduleGate.allowed === true, reason: w.moduleGate.reason ?? null } : null,
        };
        for (const x of (w?.results ?? [])) wakeResults.set(String(x.taskId), x);
        if (w?.ok === false || (w && w.status !== 'noop' && w.status !== 'executed' && !wakeResults.size)) {
          logLine(`⏸ 动作层未注入（${result.wakeLayer.status}）：${result.wakeLayer.reason ?? ''}`, { now });
        }
      }
    }

    for (const item of plan) {
      const { card, entry, decision } = item;
      const rec = {
        action: decision.action, reason: decision.reason,
        taskId: card?.id ?? entry?.taskId ?? null, title: card?.title ?? entry?.title ?? null, seq: card?.seq ?? entry?.seq ?? null,
        // 目标来源（binding / line-owner / fallback / none）—— 每条动作都标；skip 不写台账时从 detail 取
        targetSource: decision.patch?.targetSource ?? decision.detail?.notifier?.source ?? entry?.targetSource ?? null,
        targetSessionId: decision.patch?.targetSessionId ?? decision.detail?.notifier?.sessionId ?? entry?.targetSessionId ?? null,
        detail: null, ok: true,
      };
      const next = card ? nextInQueue(board, card) : null;

      if (decision.action === 'cleanup') {
        if (!dryRun) delete ledger.entries[rec.taskId];
        ledger.stats.cleaned = (ledger.stats.cleaned ?? 0) + 1;
        rec.detail = '卡已离开待验收 → 台账条目清理';
        logLine(`🧹 清理 ${rec.seq ?? ''}「${rec.title}」`, { now });
        pushEvent({ at: now, kind: 'cleanup', taskId: rec.taskId, title: rec.title, seq: rec.seq, detail: rec.detail });
      } else if (decision.action === 'observe') {
        if (!dryRun) ledger.entries[card.id] = decision.patch;
        rec.detail = 'observe 档：只记台账 + 日志（零对外副作用）';
        logLine(`👀 [observe] 首次见到待验收卡 ${rec.seq ?? ''}「${rec.title}」`, { now });
      } else if (decision.action === 'report') {
        const tg = decision.detail?.notifier ?? notifier;        // per-card 目标（降级链结果，绑定优先）
        const text = formatReportText({ card, reason: decision.reason, next, notifier: tg });
        rec.detail = text;
        rec.targetSource = tg.source ?? rec.targetSource;
        rec.targetSessionId = tg.sessionId ?? rec.targetSessionId;
        if (!dryRun) {
          calls.say++;
          await safeCall(() => deps.say(text, { state: 'idle' }));
          pushEvent({ at: now, kind: 'report', taskId: rec.taskId, title: rec.title, seq: rec.seq, source: tg.source ?? null, detail: `${decision.reason}（目标来源 ${tg.source ?? 'none'}）：${text.slice(0, 120)}` });
          ledger.entries[card.id] = decision.patch;
          ledger.stats.reported = (ledger.stats.reported ?? 0) + 1;
          ledger.stats.bySource = bumpSource(ledger.stats.bySource, tg.source);
          ledger.stats.lastNotify = { at: now, kind: 'report', taskId: rec.taskId, title: rec.title, seq: rec.seq, sessionId: tg.sessionId ?? null, source: tg.source ?? null, reason: decision.reason };
          calls.alert++;
          await safeCall(() => deps.alert({ level: 'info', source: 'butler-queue', message: `队列提醒未注入（${decision.reason}，目标来源 ${tg.source ?? 'none'}）：${card.title}`, detail: { taskId: card.id, reason: decision.reason, notifier: tg } }, { silent: true }));
        }
        logLine(`📣 [${decision.reason}]（来源 ${tg.source ?? 'none'}）${text}`, { now });
      } else if (decision.action === 'notify') {
        const tg = decision.detail?.notifier ?? notifier;        // per-card 目标（降级链结果，绑定优先）
        // 【N12】补投与首次叫醒在日志/JSON 里必须一眼可分（否则复盘时看不出"这条是补发的"）
        const isReceiptRetry = decision.reason === 'receipt-retry';
        rec.detail = isReceiptRetry
          ? `**补投**（叫醒存亡确认 · 目标被打断后静止${decision.detail?.receipt?.batchId ? ` · 重启批次 ${decision.detail.receipt.batchId}` : ''}）→ ${tg.sessionId}（目标来源 ${tg.source ?? 'fallback'}）`
          : `注入 → ${tg.sessionId}（目标来源 ${tg.source ?? 'fallback'}）`;
        rec.targetSource = tg.source ?? rec.targetSource;
        rec.targetSessionId = tg.sessionId ?? rec.targetSessionId;
        if (!dryRun) {
          // 【C 口径 · 2026-09-17】真注入已由动作层（runWakeLayer → runQueueWake → runAction）完成，
          //   本处**只读结果 + 落台账**：tick 是 ledger 唯一写者，动作层不写台账（其边界②）。
          //   注入文案由动作层用同一个 formatInjectText 生成（口径不变）。
          const w = wakeResults.get(String(card.id)) ?? null;
          const st = w?.status ?? 'not-run';
          if (st === 'executed') {
            calls.inject++;
            calls.notifyTargets.push(tg.sessionId);
            // 清理"曾因四门关被挡"的观察标记（成功注入后它没有意义了）
            const patch = { ...decision.patch };
            delete patch.wakeBlockedAt; delete patch.wakeBlockedStatus; delete patch.wakeBlockedReason;
            ledger.entries[card.id] = patch;
            ledger.stats.notified = (ledger.stats.notified ?? 0) + 1;
            ledger.stats.bySource = bumpSource(ledger.stats.bySource, tg.source);
            ledger.stats.lastNotify = { at: now, kind: 'notify', ok: true, taskId: rec.taskId, title: rec.title, seq: rec.seq, sessionId: tg.sessionId, source: tg.source ?? null, reason: decision.reason };
            pushEvent({ at: now, kind: 'notify', taskId: rec.taskId, title: rec.title, seq: rec.seq, sessionId: tg.sessionId, source: tg.source ?? null, detail: `已注入提醒（目标来源 ${tg.source ?? 'fallback'}；经动作层 queue-wake）` });
            logLine(`🔔 已叫醒 ${tg.sessionId}（${tg.source ?? 'fallback'}）→ 「${rec.title}」`, { now });
            // 【卡 S2 · §8 事件④】改投**真投递成功**才记审计 `rerouted`（卡 id + 原目标 + 新目标 + chainId + targetSource）
            //   —— 只判"想改投"就记审计会虚报（被四门挡下 / 24h 去重时其实一条都没投出去）。
            if (tg.handoff?.state === 'rerouted') {
              appendAudit({
                type: 'rerouted', by: 'butler-queue', taskId: card.id, title: rec.title, seq: rec.seq,
                fromSessionId: tg.handoff.fromSessionId ?? null,
                toSessionId: tg.handoff.toSessionId ?? null,
                chainId: tg.handoff.chainId ?? null,
                targetSource: tg.source ?? SOURCE_HANDOFF_REROUTE,
                matched: tg.handoff.matched ?? null, mode,
              }, { home, silent: true });
              logLine(`↪️ 通知改投：${rec.seq ?? ''}「${rec.title}」已交棒 ${tg.handoff.fromSessionId ?? '?'} → 接手 ${tg.handoff.toSessionId ?? '?'}（审计 rerouted）`, { now });
            }
          } else if (st === 'failed') {
            rec.ok = false;
            rec.detail = `注入失败（动作层 failed）：${w?.error ?? w?.reason ?? 'unknown'}`;
            ledger.entries[card.id] = {
              ...(entry ?? newEntry(card, now)),
              targetSource: decision.patch?.targetSource ?? entry?.targetSource ?? null,
              targetSessionId: decision.patch?.targetSessionId ?? entry?.targetSessionId ?? null,
              lastInjectError: String(w?.error ?? w?.reason ?? 'unknown'),
              pendingSince: entry?.pendingSince ?? now,
              pendingReason: 'inject-failed',
            };
            ledger.stats.lastNotify = { at: now, kind: 'notify', ok: false, taskId: rec.taskId, title: rec.title, seq: rec.seq, sessionId: tg.sessionId, source: tg.source ?? null, reason: 'inject-failed', error: String(w?.error ?? w?.reason ?? 'unknown') };
            logLine(`⚠️ 注入失败（下轮重试）：${rec.detail}`, { now });
            calls.alert++;
            await safeCall(() => deps.alert({ level: 'warn', source: 'butler-queue', message: `注入提醒失败：${rec.detail}`, detail: { taskId: card.id, sessionId: tg.sessionId, source: tg.source ?? null } }, { silent: true }));
          } else {
            // blocked（四门任一关）/ noop（24h 签名去重、单日上限）/ no-candidate / error
            // → 零注入、零副作用；**绝不写 notifiedAt**（下轮继续尝试 ⇒ 门一开就能投出去）
            const gateReason = String(w?.reason ?? result.wakeLayer?.reason ?? '').slice(0, 200);
            rec.detail = `未注入（动作层 ${st}：${gateReason}）→ 目标 ${tg.sessionId}（目标来源 ${tg.source ?? 'fallback'}）`;
            const firstAt = entry?.wakeBlockedAt ?? now;
            ledger.entries[card.id] = {
              ...(entry ?? newEntry(card, now)),
              targetSource: decision.patch?.targetSource ?? entry?.targetSource ?? null,
              targetSessionId: decision.patch?.targetSessionId ?? entry?.targetSessionId ?? null,
              wakeBlockedAt: firstAt,
              wakeBlockedStatus: st,
              wakeBlockedReason: gateReason,
            };
            // 首见才刷日志（否则四门关着时每 60s 一条，属噪音）
            if (!entry?.wakeBlockedAt) logLine(`⏸ 未注入（动作层 ${st}）：${rec.seq ?? ''}「${rec.title}」← ${gateReason}`, { now });
          }
        }
      } else if (decision.action === 'interrupt-notify' || decision.action === 'interrupt-report' || String(decision.reason ?? '').startsWith('interrupt-')) {
        // 【G3 · 复审 §7 硬约束 ①·②】**打断项专属分支**（不写 `ledger.entries`；状态只落 `stats.interrupted` / `stats.interruptedDay`）。
        //   落 else 的后果（硬约束 ①）：无日志无统计 + `decision.patch` 会被 `ledger.entries[card.id] =` 写进 review 命名空间
        //   ⇒ 污染 review 的 `notifiedAt` 短路 / 被 planTick 清理循环删 / alertsOf 假红标。
        const isInject = decision.action === 'interrupt-notify';
        const isReport = decision.action === 'interrupt-report';
        // 带 patch 的 skip 型打断项（target-busy / too-fresh / …）也走本分支 —— 否则落 else 会把打断 patch 写进 entries（复审 §7 硬约束 ①）
        const fact = decision.detail?.interrupted ?? null;
        const tg = decision.detail?.notifier ?? notifier;
        const w = isInject ? (wakeResults.get(String(card.id)) ?? null) : null;
        const st = isInject ? (w?.status ?? 'not-run') : (isReport ? 'report' : 'skip');
        const okInject = isInject && st === 'executed';
        rec.targetSource = tg?.source ?? rec.targetSource;
        rec.targetSessionId = tg?.sessionId ?? rec.targetSessionId;
        rec.detail = isInject
          ? `${okInject ? '注入' : '未注入（动作层 ' + st + '）'} → ${tg?.sessionId ?? '?'}（目标来源 ${tg?.source ?? 'none'}）· 打断于 ${fact?.endedAt ? hhmm(Number(fact.endedAt)) : '?'}`
          : (isReport
            ? `落日报段（${decision.reason}）· 目标来源 ${tg?.source ?? 'none'}`
            : `本轮不动作（${decision.reason}）· 只登记 stats.interrupted`);
        if (!dryRun && mode === 'notify') {   // R11：非 notify 档（observe/report）只登记不动作 —— stats 也不写
          const day = dayKey(now);
          const prev = (ledger.stats.interrupted ?? {})[card.id] ?? {};
          const prevDay = ledger.stats.interruptedDay && ledger.stats.interruptedDay.day === day
            ? ledger.stats.interruptedDay
            : { day, count: 0 };
          // 状态载体：**只挑去重/状态键**（事实字段的真源仍是看板 executions[]，§3.9）
          ledger.stats.interrupted = {
            ...(ledger.stats.interrupted ?? {}),
            [card.id]: {
              lastExecutionId: fact?.executionId ?? null,
              firstSeenAt: Number(prev.firstSeenAt ?? 0) || now,
              lastNotifiedExecutionId: okInject ? (fact?.executionId ?? null) : (prev.lastNotifiedExecutionId ?? null),
              notifiedAt: okInject ? now : (prev.notifiedAt ?? null),
              notifiedTo: okInject ? (tg?.sessionId ?? null) : (prev.notifiedTo ?? null),
              escalatedAt: prev.escalatedAt ?? null,
              wakeBlockedStatus: isInject ? (okInject ? null : (st === 'noop' ? 'noop' : (st === 'blocked' ? 'blocked' : st))) : (isReport ? 'report' : decision.reason),
              // 【§3.6 target-busy】只排队时的排队起点（人可见载体之一；注入成功后清空）
              pendingSince: okInject ? null : (Number(decision.patch?.pendingSince ?? 0) || Number(prev.pendingSince ?? 0) || null),
              pendingReason: okInject ? null : (decision.patch?.pendingReason ?? prev.pendingReason ?? null),
              // 【候选补丁 · 2026-10-13】超期重报节流的去重键（判定层 patch 带值，但本处是**白名单式重建** ⇒ 不显式列出就会被丢掉）
              lastReportedExecutionId: decision.patch?.lastReportedExecutionId ?? prev.lastReportedExecutionId ?? null,
              lastReportedAt: Number(decision.patch?.lastReportedAt ?? 0) || (Number(prev.lastReportedAt ?? 0) || null),
              lastSeenAt: now,
              title: card.title,
              seq: card.seq ?? null,
            },
          };
          if (okInject) {
            calls.inject++;
            calls.notifyTargets.push(tg?.sessionId ?? null);
            ledger.stats.notified = (ledger.stats.notified ?? 0) + 1;
            ledger.stats.bySource = bumpSource(ledger.stats.bySource, tg?.source);
            ledger.stats.lastNotify = { at: now, kind: 'interrupt-notify', ok: true, taskId: rec.taskId, title: rec.title, seq: rec.seq, sessionId: tg?.sessionId ?? null, source: tg?.source ?? null, reason: decision.reason, executionId: fact?.executionId ?? null };
            ledger.stats.interruptedDay = { day, count: (Number(prevDay.count ?? 0) || 0) + 1 };
            const storm = decision.detail?.interruptedStorm ?? null;
            pushEvent({ at: now, kind: 'interrupt', taskId: rec.taskId, title: rec.title, seq: rec.seq, sessionId: tg?.sessionId ?? null, source: tg?.source ?? null,
              detail: `${storm ? `本轮 ${storm.count} 张打断汇总 1 条 · ` : ''}已注入提醒（打断于 ${fact?.endedAt ? hhmm(Number(fact.endedAt)) : '?'}${fact?.error ? `：${String(fact.error).slice(0, 80)}` : ''}；经动作层 queue-wake）` });
            logLine(`🔁 已叫醒 ${tg?.sessionId ?? '?'}（${tg?.source ?? 'none'}）→ 卡被打断：${rec.seq ?? ''}「${rec.title}」`, { now });
          } else if (isInject) {
            // 未注入（动作层 noop/blocked/failed/not-run）→ 可见性：日报 + 首次日志（+ 失败告警）
            ledger.stats.interruptedReported = (ledger.stats.interruptedReported ?? 0) + 1;
            pushEvent({ at: now, kind: 'interrupt-report', taskId: rec.taskId, title: rec.title, seq: rec.seq, source: tg?.source ?? null,
              detail: `未注入（动作层 ${st}：${String(w?.reason ?? result.wakeLayer?.reason ?? '').slice(0, 120)}）→ 打断于 ${fact?.endedAt ? hhmm(Number(fact.endedAt)) : '?'}` });
            if (!entry?.wakeBlockedAt && !prev.lastSeenAt) logLine(`⏸ 打断通知未注入（动作层 ${st}）：${rec.seq ?? ''}「${rec.title}」`, { now });
            if (st === 'failed') {
              calls.alert++;
              await safeCall(() => deps.alert({ level: 'warn', source: 'butler-queue', message: `打断通知注入失败：${card.title}`, detail: { taskId: card.id, sessionId: tg?.sessionId ?? null, source: tg?.source ?? null, error: w?.error ?? w?.reason ?? null } }, { silent: true }));
            }
          } else if (isReport) {
            // interrupt-report：不注入，但**绝不静默**（日报段 + 桌宠 + 事件流水）
            const text = formatInterruptedText({ card, interrupted: fact, now, cfg: configHostile });
            rec.detail = `${text.split('\n')[2] ?? text.slice(0, 80)}（${decision.reason}）`;
            ledger.stats.interruptedReported = (ledger.stats.interruptedReported ?? 0) + 1;
            ledger.stats.reported = (ledger.stats.reported ?? 0) + 1;
            calls.say++;
            await safeCall(() => deps.say(`🐳🔁 卡被打断待重跑：「${card.title}」（${decision.reason}）`, { state: 'idle' }));
            calls.alert++;
            await safeCall(() => deps.alert({ level: 'info', source: 'butler-queue', message: `卡被打断待重跑：${card.title}（未注入：${decision.reason}）`, detail: { taskId: card.id, reason: decision.reason, notifier: tg, executionId: fact?.executionId ?? null } }, { silent: true }));
            pushEvent({ at: now, kind: 'interrupt-report', taskId: rec.taskId, title: rec.title, seq: rec.seq, source: tg?.source ?? null, detail: `未注入（${decision.reason}）→ 打断于 ${fact?.endedAt ? hhmm(Number(fact.endedAt)) : '?'}${fact?.error ? `：${String(fact.error).slice(0, 80)}` : ''}` });
          } else {
            // skip 型（target-busy / too-fresh / execution-alive / already-notified / observe-mode）：
            //   **不注入、不刷日报段**（每轮刷 = 噪音），只落 stats.interrupted（可见性）+ **首次**一行日志。
            ledger.stats.interruptedSkipped = (ledger.stats.interruptedSkipped ?? 0) + 1;
            if (!Number(prev.lastSeenAt ?? 0)) logLine(`⏸ 打断项本轮不动作（${decision.reason}）：${rec.seq ?? ''}「${rec.title}」`, { now });
          }
        }
        if (isInject || isReport) {   // skip 型不刷顶层日志（每 60s 一条 = 噪音）
          logLine(isInject
            ? `🔁 [打断]（来源 ${tg?.source ?? 'none'}）${rec.seq ?? ''}「${rec.title}」← ${rec.detail}`
            : `📣 [打断·${decision.reason}]（来源 ${tg?.source ?? 'none'}）${rec.seq ?? ''}「${rec.title}」`, { now });
        }
      } else if (decision.action === 'escalate') {
        const text = formatEscalateText({ card, entry: { ...(entry ?? {}), ...(decision.patch ?? {}) }, now, cfg: configHostile });
        rec.detail = text;
        rec.targetSource = decision.patch?.targetSource ?? rec.targetSource;
        rec.targetSessionId = decision.patch?.targetSessionId ?? rec.targetSessionId;
        if (!dryRun) {
          calls.say++;
          await safeCall(() => deps.say(text, { state: 'error-spiral' }));
          calls.alert++;
          await safeCall(() => deps.alert({ level: 'warn', source: 'butler-queue', message: text, detail: { taskId: card.id, notifiedAt: entry?.notifiedAt ?? null, notifiedTo: entry?.notifiedTo ?? null, source: decision.patch?.targetSource ?? null } }, { silent: true }));
          ledger.entries[card.id] = decision.patch;
          ledger.stats.escalated = (ledger.stats.escalated ?? 0) + 1;
          ledger.stats.bySource = bumpSource(ledger.stats.bySource, decision.patch?.targetSource);
          ledger.stats.lastNotify = { at: now, kind: 'escalate', ok: true, taskId: rec.taskId, title: rec.title, seq: rec.seq, sessionId: decision.patch?.targetSessionId ?? null, source: decision.patch?.targetSource ?? null, reason: decision.reason };
          pushEvent({ at: now, kind: 'escalate', taskId: rec.taskId, title: rec.title, seq: rec.seq, source: decision.patch?.targetSource ?? null, detail: text.slice(0, 160) });
        }
        logLine(`⏫ 升级提醒：${text}`, { now });
      } else {
        // skip：仅在有状态更新（如 pendingSince 首次落账）时写台账
        if (decision.patch && !dryRun) ledger.entries[card.id] = decision.patch;
        // 【卡 S2 · §8 事件⑤ + K-27】改投未果两形态的审计 —— **首次才写**（skip 每 tick 都命中，否则 1 分钟一条刷爆流水）。
        //   missing        ⇒ `skipped-handoff-window`（超宽限仍找不到接手会话；由接手方 `--list` 兜底核对）
        //   pending-grace  ⇒ `reroute-pending-grace`（宽限内不投递也不告警，下轮再看）
        const hs = decision.detail?.handoff ?? null;
        if (hs && (hs.state === 'missing' || hs.state === 'pending-grace') && !entry?.handoffSkipAt) {
          appendAudit({
            type: hs.state === 'missing' ? 'skipped-handoff-window' : 'reroute-pending-grace',
            by: 'butler-queue', taskId: card.id, title: rec.title, seq: rec.seq,
            sourceSessionId: hs.fromSessionId ?? null, newSessionId: hs.toSessionId ?? null,
            chainId: hs.chainId ?? null, handoffAt: hs.handoffAt ?? null, matched: hs.matched ?? null,
            reason: hs.reason ?? null, mode,
          }, { home, silent: true });
          rec.detail = hs.state === 'missing'
            ? `已交棒但改投无门（超宽限 ${Math.round(REROUTE_GRACE_MS / 60_000)} 分钟）：接手会话 ${hs.toSessionId ?? '?'} 不在会话快照 → 跳过投递（审计 skipped-handoff-window；由接手方 --list 兜底核对）`
            : `已交棒 · 改投宽限内（handoffAt ${hs.handoffAt ?? '?'}）：接手会话尚未进会话快照 → 本轮不投递也不告警（审计 reroute-pending-grace）`;
          logLine(`⏸ ${rec.detail}：${rec.seq ?? ''}「${rec.title}」`, { now });
        }
        // 假结算：首次见到记一行日志（之后每 tick 不再刷日志，避免 1 分钟一条噪音）
        if (decision.reason === 'execution-alive') {
          rec.detail = `疑似假结算：执行会话 ${decision.detail?.exec?.sessionId ?? '?'} 仍在运行（running=true）→ 本轮不叫醒`;
          if (!entry?.execAlive) {
            logLine(`⏳ 疑似假结算（跳过叫醒）：${rec.seq ?? ''}「${rec.title}」← 执行会话 ${decision.detail?.exec?.sessionId ?? '?'} 仍在跑`, { now });
          }
        }
      }
      result.actions.push(rec);
    }

    // 4b) 【V3功能面 · 失败卡通知档】执行结果回写（**独立命名空间** `stats.failedNotify`；不写 entries）
    //   · dry-run / 非 notify 档：只算不投（不消费去重配额）—— 结果已经在 `result.failedNotify.items` 里；
    //   · notify 档：真注入走动作层（与 review 同一执行体），成功才写 `notifiedAt` / `lastNotifiedExecutionId`；
    //     被挡（blocked/noop/failed）⇒ 不写通知位（下轮再试），只留 `wakeBlocked*` 观察标记（可见、可排障）。
    if (failedSw.enabled && failedRows.length) {
      const fnStat = result.failedNotify;
      const fnState = (!dryRun && ledger.stats.failedNotify && typeof ledger.stats.failedNotify === 'object')
        ? ledger.stats.failedNotify
        : {};
      if (!dryRun) ledger.stats.failedNotify = fnState;
      for (const row of failedRows) {
        const { card, decision } = row;
        if (!decision) continue;
        const fact = card.failedFact ?? null;
        const tg = decision.detail?.notifier ?? notifier;
        const endedAt = Number(fact?.endedAt ?? 0) || 0;
        const rec = {
          action: decision.action, reason: decision.reason,
          taskId: card.id, title: card.title, seq: card.seq ?? null,
          targetSource: decision.patch?.targetSource ?? tg?.source ?? null,
          targetSessionId: decision.patch?.targetSessionId ?? tg?.sessionId ?? null,
          source: SOURCE_FAILED, detail: null, ok: true,
        };
        if (decision.action === 'failed-notify') {
          if (dryRun) {
            fnStat.deferred += 1;
            rec.detail = `dry-run：只算不投（若放行会注入 → ${tg?.sessionId ?? '?'}，目标来源 ${tg?.source ?? 'none'}）`;
          } else {
            const w = wakeResults.get(String(card.id)) ?? null;
            const st = w?.status ?? 'not-run';
            if (st === 'executed') {
              calls.inject++;
              calls.notifyTargets.push(tg?.sessionId ?? null);
              fnState[card.id] = { ...decision.patch, lastSeenAt: now };
              ledger.stats.failed = (ledger.stats.failed ?? 0) + 1;
              ledger.stats.bySource = bumpSource(ledger.stats.bySource, SOURCE_FAILED);
              ledger.stats.lastNotify = {
                at: now, kind: 'failed-notify', ok: true, taskId: card.id, title: card.title, seq: card.seq ?? null,
                sessionId: tg?.sessionId ?? null, source: SOURCE_FAILED, targetSource: tg?.source ?? null,
                reason: decision.reason, executionId: fact?.executionId ?? null,
              };
              rec.detail = `已叫醒 ${tg?.sessionId ?? '?'}（目标来源 ${tg?.source ?? 'none'}）· 卡挂于 ${endedAt ? hhmm(endedAt) : '?'}${fact?.errorFirstLine ? `：${String(fact.errorFirstLine).slice(0, 80)}` : ''}`;
              pushEvent({
                at: now, kind: 'failed', taskId: card.id, title: card.title, seq: card.seq ?? null,
                sessionId: tg?.sessionId ?? null, source: SOURCE_FAILED, targetSource: tg?.source ?? null,
                detail: `卡挂于 ${endedAt ? hhmm(endedAt) : '?'}${fact?.errorFirstLine ? `：${String(fact.errorFirstLine).slice(0, 80)}` : ''} → 已注入可重跑提醒`,
              });
              logLine(`⚠️🔔 失败卡已叫醒 ${tg?.sessionId ?? '?'}（${tg?.source ?? 'none'}）→ ${card.seq ?? ''}「${card.title}」`, { now });
              fnStat.injected += 1;
            } else {
              const prev = fnState[card.id] ?? {};
              fnState[card.id] = {
                ...decision.patch,
                // 通知位**不前进**（下轮继续尝试；只有真投出去才算通知过）
                lastNotifiedExecutionId: prev.lastNotifiedExecutionId ?? null,
                notifiedAt: prev.notifiedAt ?? null,
                notifiedTo: prev.notifiedTo ?? null,
                lastSeenAt: now,
                wakeBlockedAt: Number(prev.wakeBlockedAt ?? 0) || now,
                wakeBlockedStatus: st,
                wakeBlockedReason: String(w?.reason ?? result.wakeLayer?.reason ?? '').slice(0, 200),
              };
              rec.detail = `未注入（动作层 ${st}：${String(w?.reason ?? result.wakeLayer?.reason ?? '').slice(0, 120)}）→ 目标 ${tg?.sessionId ?? '?'}（目标来源 ${tg?.source ?? 'none'}）`;
              if (!Number(prev.wakeBlockedAt ?? 0)) {
                logLine(`⏸ 失败卡提醒未注入（动作层 ${st}）：${card.seq ?? ''}「${card.title}」← ${String(w?.reason ?? '').slice(0, 120)}`, { now });
              }
              fnStat.deferred += 1;
              if (st === 'failed') {
                rec.ok = false;
                calls.alert++;
                await safeCall(() => deps.alert({
                  level: 'warn', source: 'butler-queue', message: `失败卡提醒注入失败：${card.title}`,
                  detail: { taskId: card.id, sessionId: tg?.sessionId ?? null, error: w?.error ?? null },
                }, { silent: true }));
              }
            }
          }
        } else if (decision.action === 'failed-report') {
          const text = formatFailedText({
            card, failed: fact, now, notifier: tg,
            expired: decision.reason === 'failed-expired',
          });
          rec.detail = `${text.split('\n')[2] ?? text.slice(0, 100)}（${decision.reason}）`;
          if (!dryRun) {
            fnState[card.id] = { ...decision.patch, lastSeenAt: now };
            calls.say++;
            await safeCall(() => deps.say(text, { state: 'idle' }));
            calls.alert++;
            await safeCall(() => deps.alert({
              level: 'warn', source: 'butler-queue', message: text,
              detail: { taskId: card.id, executionId: fact?.executionId ?? null, reason: decision.reason, notifier: tg },
            }, { silent: true }));
            pushEvent({
              at: now, kind: 'failed-report', taskId: card.id, title: card.title, seq: card.seq ?? null,
              source: SOURCE_FAILED, targetSource: tg?.source ?? null,
              detail: `未注入（${decision.reason}）→ 卡挂于 ${endedAt ? hhmm(endedAt) : '?'}${fact?.errorFirstLine ? `：${String(fact.errorFirstLine).slice(0, 80)}` : ''}`,
            });
            ledger.stats.failedReported = (ledger.stats.failedReported ?? 0) + 1;
            ledger.stats.reported = (ledger.stats.reported ?? 0) + 1;
            ledger.stats.bySource = bumpSource(ledger.stats.bySource, SOURCE_FAILED);
            logLine(`📣 [失败卡·${decision.reason}] ${card.seq ?? ''}「${card.title}」`, { now });
          }
          fnStat.reported += 1;
        } else if (decision.action === 'failed-escalate') {
          const text = formatFailedText({ card, failed: fact, now, notifier: tg, escalated: true });
          rec.detail = text;
          if (!dryRun) {
            fnState[card.id] = { ...decision.patch, lastSeenAt: now };
            calls.say++;
            await safeCall(() => deps.say(text, { state: 'error-spiral' }));
            calls.alert++;
            await safeCall(() => deps.alert({
              level: 'warn', source: 'butler-queue', message: text,
              detail: { taskId: card.id, executionId: fact?.executionId ?? null, reason: decision.reason },
            }, { silent: true }));
            pushEvent({
              at: now, kind: 'failed-escalate', taskId: card.id, title: card.title, seq: card.seq ?? null,
              source: SOURCE_FAILED, targetSource: tg?.source ?? null,
              detail: `已叫醒过但 ${Math.round((now - Number(decision.patch?.notifiedAt ?? now)) / 60_000)} 分钟仍未处理 → 升级提醒一次`,
            });
            ledger.stats.failedEscalated = (ledger.stats.failedEscalated ?? 0) + 1;
            ledger.stats.bySource = bumpSource(ledger.stats.bySource, SOURCE_FAILED);
            logLine(`⏫ [失败卡] 已叫醒仍未处理 → ${card.seq ?? ''}「${card.title}」`, { now });
          }
          fnStat.escalated += 1;
        } else {
          // skip：带 patch 的（已通知 / 已报过 / 目标在跑排队 / 执行会话仍活）才落状态；
          //   too-fresh / 非 notify 档 这类不落盘（观察档零副作用、也不消费去重配额）
          if (!dryRun && decision.patch) fnState[card.id] = { ...decision.patch, lastSeenAt: now };
          rec.detail = `本轮不动作（${decision.reason}）`;
          fnStat.skipped += 1;
        }
        result.actions.push(rec);
      }
      // 清理：只保留仍是候选的卡（卡离开 failed / 归档 ⇒ 状态随之清掉；容量上限按 lastSeenAt 淘汰最旧）
      if (!dryRun) {
        const live = new Set(failedRows.map((r) => String(r.card.id)));
        const kept = {};
        for (const [k, v] of Object.entries(fnState)) if (live.has(k)) kept[k] = v;
        const keys = Object.keys(kept);
        if (keys.length > FAILED_KEEP_MAX) {
          keys.sort((a, b) => Number(kept[a]?.lastSeenAt ?? 0) - Number(kept[b]?.lastSeenAt ?? 0));
          for (const k of keys.slice(0, keys.length - FAILED_KEEP_MAX)) delete kept[k];
        }
        ledger.stats.failedNotify = kept;
      }
    }

    ledger.stats.ticks = (ledger.stats.ticks ?? 0) + 1;
    ledger.stats.lastTickAt = new Date(now).toISOString();
    ledger.stats.lastMode = mode;
    result.entries = Object.keys(ledger.entries).length;

    // 4c-2) 【G3 · §3.9 清理时机】卡离开 `todo/backlog`（被重跑/归档/删除）⇒ 顺手删它的打断状态
    //   （独立小清理，**不动** entries 清理循环；容量 ≤200 兜底，按 lastSeenAt 淘汰最旧）
    if (!dryRun) {
      const live = new Set(interruptCards.map((c) => String(c.id)));
      const kept = {};
      for (const [k, v] of Object.entries(ledger.stats.interrupted ?? {})) {
        if (live.has(k)) kept[k] = v;
      }
      const keys = Object.keys(kept);
      if (keys.length > INTERRUPT_KEEP_MAX) {
        keys.sort((a, b) => Number(kept[a]?.lastSeenAt ?? 0) - Number(kept[b]?.lastSeenAt ?? 0));
        for (const k of keys.slice(0, keys.length - INTERRUPT_KEEP_MAX)) delete kept[k];
      }
      ledger.stats.interrupted = kept;
    }

    // 4d) 【G3】打断通道本轮摘要（供日报段渲染：渲染层只读，不参与判定）
    result.interruptSummary = (() => {
      const interruptActions = result.actions.filter((a) => a.action === 'interrupt-notify' || a.action === 'interrupt-report');
      const stats = ledger.stats.interrupted ?? {};
      const items = interruptActions.map((a) => {
        const d = plan.find((p) => p.card && String(p.card.id) === String(a.taskId));
        const f = d?.decision?.detail?.interrupted ?? null;
        return {
          taskId: a.taskId, title: a.title, seq: a.seq, action: a.action,
          endedAt: f?.endedAt ?? null, error: f?.error ?? null,
          note: a.action === 'interrupt-notify'
            ? '注入/待注入': '落日报（不注入）',
        };
      });
      return {
        candidates: result.interrupt?.candidates ?? 0,
        active: Object.keys(stats).length,
        injected: interruptActions.filter((a) => a.action === 'interrupt-notify').length,
        reported: interruptActions.filter((a) => a.action === 'interrupt-report').length,
        queued: result.actions.filter((a) => a.action === 'skip' && String(a.reason ?? '').startsWith('interrupt-')).length,
        dayLimit: INTERRUPT_DAY_LIMIT,
        dayCount: ledger.stats.interruptedDay ?? null,
        items,
      };
    })();

    // 5) 日报段刷新（observe 档零对外写入 → 不碰日报；有事件 **或** 有上次投递结果就刷新段头行）
    const dayEvents = ledger.day.events ?? [];
    // 【K-14】TTL 巡检命中（清条目 / 改绑超时 / 抢锁失败）也要刷段 —— 否则"告警只在日志里、日报看不见"
    const ttlHit = result.relayTtl
      ? ((result.relayTtl.cleared ?? 0) > 0 || result.relayTtl.rebindWarn?.due === true || result.relayTtl.rmwContention === true)
      : false;
    if (mode !== 'observe' && cfg.dailyReport !== false && !dryRun && (dayEvents.length || ledger.stats.lastNotify || ttlHit)) {
      calls.daily++;
      const payload = {
        events: dayEvents, mode, device: deviceName(),
        last: ledger.stats.lastNotify ?? null,          // A 段：段头「上次投递结果 + 目标来源」
        bySource: ledger.stats.bySource ?? null,
        relayTtl: result.relayTtl ?? null,              // 【K-14】接力台账 TTL 巡检行（待改绑 / 清理 / 超时）
        targets: result.targets ?? null,
        bindings: result.bindings ?? null,
        wakeLayer: result.wakeLayer ?? null,            // C 口径：动作层本轮状态 + 模块门（可见性）
        relayHandoffWatch: result.relayHandoffWatch ?? null, // 【G1G2 候选 C】交接巡检四计数（日报段可见性）
        relayWatchdog: result.relayWatchdog ?? null,         // 【改动 1 · 2026-09-29】断链看门狗（开关状态 + 判定计数 + 本轮动作/结果）
        // 【G3 · 候选 B 第 6 行 / 候选 D】打断通道行（渲染层只读；真源 = 台账 stats.interrupted*）
        interrupted: result.interruptSummary ?? null,
        // 【V3功能面 · 失败卡通知档】失败卡通道行（**只在开关开着时出现** ⇒ 开关关 = 日报段与改前逐字一致）
        ...(result.failedNotify ? { failedNotify: result.failedNotify, failedTotal: ledger.stats.failed ?? 0 } : {}),
        // 【Q6】采集健康（本轮采集成功 → collectFailure 为 null；失败轮走上面的早退分支自刷）
        collectFailure: null,
        collectHealth: {
          failures: Number(ledger.stats.collectFailures ?? 0) || 0,
          streak: Number(ledger.stats.collectFailStreak ?? 0) || 0,
          lastReason: ledger.stats.collectFailLastReason ?? null,
          lastFailAt: ledger.stats.collectFailLastAt ?? null,
          recoveredAt: ledger.stats.collectRecoveredAt ?? null,
          alerts: Number(ledger.stats.collectAlertCount ?? 0) || 0,
        },
        stats: { ticks: ledger.stats.ticks ?? 0, notified: ledger.stats.notified ?? 0, escalated: ledger.stats.escalated ?? 0, reported: ledger.stats.reported ?? 0 },
      };
      const r = await safeCall(async () => deps.writeDaily(dailyReportPath(now, { docsRoot: opts.docsRoot }), payload, { now, device: deviceName() }));
      result.daily = r ?? null;
    }

    // 6) 台账落盘（dryRun 不写）
    if (!dryRun) saveLedger(ledger, { home, now });
    result.ledger = ledger;

    // 7) 看板主线清账判定（P0 · 只读；方案 docs/）
    //    ⚠️ 位置铁律（§3.2 / 审查人 A-B2 阻断项）：**必须在第 ⑥ 步 saveLedger() 之后**。
    //      runTick 是「单个 try/catch 包全 tick」——插在落盘之前一旦抛错 → 本轮 queue 台账不写 +
    //      result.ok=false → tickd 记 failure + 告警，把生产在跑的叫醒链拉红（现状 runs=1544 fail=0）。
    //      故：插在 `result.ledger = ledger` 之后 + 用既有 safeCall() 包裹 + 返回值写进 result.boardCleanup。
    //    反向隔离（§3.2）：readBoard 失败时本函数已早退（action='collect-failed'），本判定**根本不会被调用**
    //      → --status 靠「lastCheckAt 停摆 + 依赖 job/queue 台账状态」归因（A8b）。
    //    零额外 IO：复用同一份 board.tasks；模块内自带 30 分钟节流 + revision 短路。
    result.boardCleanup = await safeCall(() => boardCleanupTick({
      tasks: board.tasks,
      revision: board.revision,
      now,
      home,
      dryRun,
      reportPath: dailyReportPath(now, { docsRoot: opts.docsRoot }),
      deps: { log: (msg) => logLine(msg, { now }) },
    }));
    // 只在本判定自己出错时补一行日志（节流跳过/无候选 = 常态，不刷日志；命中项由模块内部记账）
    // `logged !== true` = 模块内的 catch 没跑到（safeCall 兜到的意外抛错）→ 这里补记，绝不静默
    if (result.boardCleanup && result.boardCleanup.ok === false && result.boardCleanup.logged !== true) {
      logLine(`⚠️ 看板清账判定失败（已隔离，不影响 queue 台账与叫醒）：${result.boardCleanup.error}`, { now });
    }
    return result;
  } catch (e) {
    // 失败隔离：本 job 自己的异常绝不外抛给 tickd 的其它任务
    const msg = e?.message ?? String(e);
    result.ok = false;
    result.error = msg;
    logLine(`✘ tick 失败（已隔离）：${msg}`, { now });
    try { sendAlert({ level: 'error', source: 'butler-queue', message: `队列巡检 tick 失败：${msg}`, detail: { stack: String(e?.stack ?? '').slice(0, 800) } }, { home, silent: true }); } catch { /* ignore */ }
    return result;
  }
}

async function safeCall(fn) {
  try { return await fn(); } catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
}

// ---------------------------------------------------------------- 告警视图（面板红标 · 遗留① 2026-09-17）
//
// 动机：队列的**失败态**过去只有散落通道 —— 桌宠 say / 日报段 / `%TEMP%` 日志 —— 面板「② 待处理」
//   一条都看不到（遗留①）。主人不开日报就完全看不见"提醒发不出去"。
// 定位（不另造第二套）：**判据在此处定，面板只展示**。面板 core 片拿到的是本函数的输出，
//   与 CLI `--status` 共用同一份口径 ⇒ 不会出现"面板说没事、CLI 说没人收得到"的分叉。
// 边界：**纯函数只读**，不写台账、不发通知、不消费任何去重/冷却配额（观察档语义不变）。
//
// 等级口径（**三条都已在 decide/runTick 里各自成立**，这里只做归集）：
//   🔴 red  = 需要人到场才能恢复：
//       · inject-failed        —— 注入了但失败（entry.lastInjectError 有值）
//       · 四门挡下（wakeBlockedStatus 非 noop）—— 如模块门关 → 长期"静默无动作"
//       · 疑似假结算（execAlive）—— 卡已进待验收但执行会话仍在跑，**别直接 confirm**
//       · 超时仍未投出（noTargetAt / pendingSince 起算 ≥ escalateAfterMs）
//   🟡 yellow = 提醒已投出但卡仍滞留自升级阈值（escalatedAt）—— 人不来，队列就卡着
//
// ⚠️ **升级标记保留语义**（读代码实测，非推断）：`runTick` 的 notify 成功分支只清 `wakeBlocked*`，
//   **不清 `escalatedAt`** ⇒ 若把 `escalatedAt` 无条件当红标，卡升级后偶尔投成功一次就会永久挂红标。
//   ⇒ 只把 `escalatedAt` 且**本轮仍未投出**（`notifiedAt` 空）计为 🔴；已投出则降为 🟡。
//   （本函数**不修改**队列侧行为，只如实反映；如需"升级后回头清标记"属另一个改动。）
export const QUEUE_ALERTS_VERSION = '0.1.0';

/** 事件类噪音：这些不是失败态，不该出现在红标里。 */
const WAKE_BENIGN_STATUS = new Set(['noop']);

/**
 * 队列告警视图（纯函数 · 面板红标通道）。
 * @param {object} ledger  `butler-queue-notify.json` 内容
 * @param {{now?:number, cfg?:object, cap?:number}} [opts]  `cap` 只截**返回**条数（统计仍按全量）
 * @returns {{version:string, ok:boolean, asOf:number|null, cap:number, stats:object, items:Array}}
 */
export function alertsOf(ledger, opts = {}) {
  const now = Number(opts.now ?? Date.now()) || Date.now();
  const cfg = opts.cfg ?? DEFAULT_CONFIG;
  const cap = Math.max(1, Number(opts.cap ?? 12) || 12);
  const limit = Math.max(60_000, Number(cfg?.escalateAfterMs ?? DEFAULT_CONFIG.escalateAfterMs) || 0);
  const entries = ledger?.entries && typeof ledger.entries === 'object' ? Object.values(ledger.entries) : [];
  const items = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    // 基线：卡进 review 的时刻（与 summarize 同源口径）
    const baseline = firstNum(e.settledAt, e.firstSeenAt, now);
    const ageMs = Math.max(0, now - baseline);
    const notified = Number(e.notifiedAt ?? 0) > 0;
    let level = null;
    let label = null;
    let detail = null;

    if (String(e.lastInjectError ?? '')) {
      level = 'red'; label = '注入失败';
      detail = `注入了但失败（${String(e.lastInjectError).slice(0, 160)}）→ 下轮自动重试；持续失败说明目标会话或动作层有问题`;
    } else if (e.wakeBlockedAt && !WAKE_BENIGN_STATUS.has(String(e.wakeBlockedStatus ?? ''))) {
      level = 'red'; label = '注入被挡（四门）';
      detail = `未注入（${String(e.wakeBlockedStatus ?? 'blocked')}${e.wakeBlockedReason ? `：${String(e.wakeBlockedReason).slice(0, 120)}` : ''}）→ 四门开着才会真投出去`;
    } else if (e.execAlive === true) {
      level = 'red'; label = '疑似假结算';
      detail = `执行会话 ${String(e.execSessionId ?? '?').slice(0, 24)} 仍在运行（${e.execAliveReason ?? 'session-running'}）→ **别直接 confirm**，等执行真结束`;
    }

    // 超时未投出：入场条件 = **卡在 review 已滞留 ≥ 阈值**（与既有升级口径同源；
    //   刚进 review 的头 30 分钟内 whatever 都不算失败，避免告警风暴）。
    //   各支的"卡了多久"分别取更贴切的时刻（不是一律用 settledAt）：目标被判无要到失败的时刻、
    //   排队超时要到开始排队的时刻、升级后仍没投出去到升级的时刻。
    if (!level && ageMs >= limit && !notified) {
      if (String(e.noTargetAt ?? '')) {
        level = 'red'; label = `无目标（${e.noTargetReason ?? 'no-target'}）`;
        detail = `自 ${hhmm(firstNum(e.noTargetAt, baseline))} 起无人可投（${e.noTargetReason ?? 'no-target'}）→ 登记绑定或让一个会话标【运行】`;
      } else if (String(e.pendingSince ?? '')) {
        level = 'red'; label = '目标忙碌排队超时';
        detail = `自 ${hhmm(Number(e.pendingSince))} 起目标在跑（${e.pendingReason ?? 'target-busy'}）→ 已超 ${Math.round(limit / 60_000)} 分钟仍未投出`;
      } else if (e.escalatedAt) {
        level = 'red'; label = '升级后仍未投出';
        detail = `已升级提醒（${hhmm(Number(e.escalatedAt))}）但至今没投进任何会话`;
      }
    }
    // 升级但仍滞留：提醒投出去了，人也知道了，卡就是不动 → 🟡（不占用"人来才能恢复"的红位）
    if (!level && e.escalatedAt) {
      level = 'yellow'; label = '已升级仍滞留';
      detail = `提醒已投出（${e.notifiedTo ? String(e.notifiedTo).slice(0, 24) : '目标未知'}），${hhmm(Number(e.escalatedAt))} 升级过，至今仍待验收（滞留 ${Math.round(ageMs / 60_000)} 分钟）`;
    }
    if (!level) continue;

    items.push({
      taskId: String(e.taskId ?? ''),
      seq: e.seq ?? null,
      line: e.line ?? null,
      title: String(e.title ?? ''),
      level,
      label,
      detail,
      ageMin: Math.round(ageMs / 60_000),
      source: e.targetSource ?? null,
      notifiedAt: e.notifiedAt ?? null,
      escalatedAt: e.escalatedAt ?? null,
      execAlive: e.execAlive === true,
    });
  }
  // 排序：🔴 优先，同级按滞留时长降序（最久的先看）；同长按 taskId 定序（保证输出稳定可比对）
  const rank = (x) => (x.level === 'red' ? 0 : 1);
  items.sort((a, b) => (rank(a) - rank(b)) || (b.ageMin - a.ageMin) || String(a.taskId).localeCompare(String(b.taskId)));
  const byLevel = { red: 0, yellow: 0 };
  for (const it of items) byLevel[it.level] = (byLevel[it.level] ?? 0) + 1;
  return {
    version: QUEUE_ALERTS_VERSION,
    ok: true,
    asOf: Number(ledger?.updatedAt ? Date.parse(ledger.updatedAt) : 0) || null,
    cap,
    stats: {
      entries: entries.length, count: items.length, total: items.length, shown: Math.min(items.length, cap),
      byLevel, escalated: Number(ledger?.stats?.escalated ?? 0) || 0, ticks: Number(ledger?.stats?.ticks ?? 0) || 0,
    },
    items: items.slice(0, cap),
  };
}

/** 台账总览（CLI --status / 面板用）。 */
export function summarize(ledger, opts = {}) {
  const now = opts.now ?? Date.now();
  const entries = Object.values(ledger?.entries ?? {});
  const rows = entries.map((e) => ({
    taskId: e.taskId,
    title: e.title,
    seq: e.seq,
    notifiedAt: e.notifiedAt ?? null,
    notifiedTo: e.notifiedTo ?? null,
    pendingSince: e.pendingSince ?? null,
    escalatedAt: e.escalatedAt ?? null,
    execAlive: e.execAlive === true,
    execSessionId: e.execSessionId ?? null,
    execAliveReason: e.execAliveReason ?? null,
    // A 段：本次评估的叫醒目标来源（binding / line-owner / fallback / none）
    targetSource: e.targetSource ?? null,
    targetSessionId: e.targetSessionId ?? null,
    targetDegraded: e.targetDegraded ?? null,
    ageMin: Math.round((now - firstNum(e.settledAt, e.firstSeenAt, now)) / 60_000),
  })).sort((a, b) => b.ageMin - a.ageMin);
  return {
    entries: entries.length,
    rows,
    stats: ledger?.stats ?? {},
    lastNotify: ledger?.stats?.lastNotify ?? null,
    bySource: ledger?.stats?.bySource ?? null,
    inbox: ledger?.inbox ?? {},
    day: { day: ledger?.day?.day ?? null, events: (ledger?.day?.events ?? []).length },
    auditMonth: monthKey(now),
  };
}
