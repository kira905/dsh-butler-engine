// dsh-butler / lib/restart.mjs —— P0 重启统筹核心（卡 [1]）
//
// 方案：docs/ §4 P0（行 380-433）
// 本模块只做**判定**与**维护窗口读写**，不做进程编排（编排在 restart-coordinator.mjs），
// 以便三条核心函数（活跃判定 / 低水位 / 合并批次）能被单测直接覆盖（方案 §4 R·回归）。
//
// 三条硬约束（方案代码实证，不得违反）：
//   1. 重启 = 硬杀（taskkill /F），无优雅退出。
//   2. 「通知活跃会话快收尾」这条路禁止——发消息会让会话重新变活跃（产生新回合），
//      协调器永远等不到空闲。实现者不得因 queue 不打断就恢复这条路。
//   3. 发起重启的会话自身必然在跑 → 活跃判定必须排除发起者。
//
// 事件模型来源（spike A15，2026-09-09 实证）：
//   - 会话目录名 = sessionId（76/76 精确匹配），首帧 header 内 id 一致 → 映射稳定。
//   - 尾部事件判定：只读文件末尾若干帧即可拿到 tail（76 会话 84ms）。
//   - 权威事件词表：主包 @deepseek-ai/dsh-session/lib/types/known-event-types.js（47 类）。
//   - 回合开闭以 turn/start ↔ turn/end 配对折叠为准（主包 dsh-plan-mode / dsh-llm-retry 同款逻辑），
//     比"尾部事件属于中间白名单"更稳：session/title 等会话级事件夹在中间也不会误判。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { statePath, dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
// 会话日志**文件名判据的生态单一真源**（2026-09-24「三机同步步A」卡建立；其文件头「已知同类读取侧判据」
// 清单里点名的 `tools\dsh-butler\restart-coordinator.mjs（另一卡在管）`就是本卡）——别在本地另写正则。
// 同目录先例：lib/pitfall-scan.mjs 已走同一 import 路径。
import { pickSessionFileInDir } from '../../lib/session-file-name.mjs';
import { readJson, writeTextAtomic } from './store.mjs';
import { writeStateText } from './dual-write.mjs';
// 宿主适配层副本（唯一源 tools\lib\host-adapter.mjs；由 tools\sync-host-adapter.mjs 生成 + R5 校验）
import * as host from './host-adapter.mjs';
// 【本卡 · 通知面·卡会话豁免 / 2026-09-23】卡执行会话判定**唯一源**（fail-open：读不到账本 ⇒ 不排除任何人）
import { asCardSessionIndex, extractCardSessions, isSettledCardSession, makeCardSessionIndex, normCardSessionDirection } from './card-session.mjs';
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


// ⚠️ 版本号**故意保持 0.1.0**：底座自检 verify.mjs 的硬规范是「登记表所有组件版本 == 产品版本」，
//    单独 bump 本组件会让 `verify.mjs` 永久 FAIL（60/1）。要 bump 必须整套产品一起升
//    （PRODUCT_VERSION + 全部组件 + 每台机重写 butler-version.json），那是独立的一件事、不在本卡范围内。
//    本次 [Q4] 修复（2026-09-11：活跃判定多源并集 + 修 mtime-in-future 漏判）靠注释/变更流水/文档追溯。
export const RESTART_VERSION = '0.1.0';

/** 状态文件 schema 版本（改结构必须配 migrations/migrate-*.cjs）。 */
export const RESTART_STATE_SCHEMA = 1;
export const RESTART_REQUEST_SCHEMA = 1;
export const MAINTENANCE_SCHEMA = 1;

// ────────────────────────────────────────────────────────────────────────
// ★ P0 宿主适配层（2026-09-14）：以下词表与族判定**统一由唯一源提供**
//
//   唯一源 = `tools\lib\host-adapter.mjs`；本包消费的是同步器生成的副本
//   `lib\host-adapter.mjs`（`tools\sync-host-adapter.mjs` 幂等生成，R5 校验副本 sha == 唯一源）。
//
//   为什么搬走：主包升级会**改名/删除事件**（0.1.5 已删 `assistant/chunk`、
//   `tool/code-dispatch*` 改名 `tool/ptc-dispatch*`）—— 字面量散落在功能代码里，
//   升级改点就会随功能增长而增长；适配层是**全生态唯一允许出现主包事件名**的地方。
//   判定口径（档 A 等价替换）与迁移前逐字一致，见 `_archive\adapter-p0-20260914-1536\regression\`。
//
//   ⚠️ 下面这几个常量是**适配层同一实例的再导出**（保持既有公共 API 与 .has() 消费方式不变），
//      只读、不得在别处改内容。
// ────────────────────────────────────────────────────────────────────────

/** 回合边界事件（主包 SessionEventMap）。 */
export const TURN_BOUNDARY_TYPES = host.TURN_BOUNDARY_TYPES;
/** 种子/会话终结标记（主包 dsh-session：seed 会话末尾追加）。 */
export const SESSION_END_TYPES = host.SESSION_END_TYPES;
/**
 * `turn/end` 的「正常收尾」reason.kind（2026-09-11 补，主人点破"被打断检测失效"）。
 * 实测主包在回合被打断/异常时写的是 `turn/end{reason:{kind:'interrupted'|'aborted'|'error'}}`，
 * 旧实现把 turn/end 一律当"回合已闭合"→ 被硬杀打断的会话全被漏报。
 * 只有下列 kind（或没有 kind 的老日志）才算真收尾；其余一律视为 interrupted。
 */
export const NORMAL_TURN_END_KINDS = host.NORMAL_TURN_END_KINDS;
/**
 * 回合中间事件（**已从"枚举白名单"改为"族判定"**，判定走 `host.isTurnInterior`）。
 * 本常量保留为：①兼容导出 ②单测里的"金标准"对照（断言 族 ⊇ 本表，防族前缀写漏）。
 */
export const MID_TURN_TYPES = host.MID_TURN_TYPES;
/** 会话级 / 回合外事件（出现在 turn/end 之后属正常，不表示回合进行中）。 */
export const OUT_OF_TURN_TYPES = host.OUT_OF_TURN_TYPES;

/** 默认策略（方案 §4 策略表；可被 butler-restart-policy.json 覆盖）。 */
export const DEFAULT_POLICY = {
  /** 活跃判定 mtime 窗口：尾部事件超过该时长未更新 → 视为不活跃（防僵尸卡住排队）。 */
  activeMtimeMs: 5 * 60_000,
  /**
   * [Q4] 看板 running 卡强制活跃的「静默上限」（默认 30 分钟）。
   * 卡会话按 running 卡状态强制计入活跃，但如果它的会话文件已 30 分钟没动，
   * 说明卡状态可能是陈旧的（runner 挂了 / 卡被假结算）→ 停止强制，避免闸门被僵尸卡永久挡住。
   * 主包 running 标志（agent-running）**不设**此上限：那是主包内存态，可信度更高。
   */
  cardForceActiveMaxIdleMs: 30 * 60_000,
  /**
   * [D17 / 2026-09-23 主人点名 A 方案] **旁路通知窗口**：重启前 N 毫秒内有过活动的会话，
   * 重启完成后补发一条「你在等的东西可能已失效」提醒（**0 = 关闭这一路通知**）。
   *
   * 治什么：回合间隙里等通知 / 等卡完成的会话在重启瞬间三源（回合未闭合 / 主包 running /
   * 看板 running 卡）全不命中 ⇒ 既不在打断名单、也不是发起者 ⇒ 一条通知都收不到、静默停摆
   * （2026-09-22 01:31:56 批次实测：主会话在等 L-2 验收通知，被打断后静默 6.5 小时无人知）。
   *
   * ⚠️ 只影响**通知**，不参与活跃判定 / 低水位 / force 语义（判据真源见 selectStaleWaitSessions）。
   */
  staleWaitNoticeMs: 10 * 60_000,
  /** 排队超过该时长 → 提醒主人拍板（只提醒一次）。 */
  queueTimeoutMs: 30 * 60_000,
  /** 请求 24h 未执行自动作废（避免幽灵重启）。 */
  requestTtlMs: 24 * 3600_000,
  /** 维护窗口默认时长（P2 静默 + 就绪探测的兜底上限）。 */
  maintenanceWindowMs: 10 * 60_000,
  /** 兜底窗口（凌晨，预期空闲期；不强制打断，仅标记 + 记录）。 */
  fallbackWindow: { startHour: 3, endHour: 6 },
  /** 单次批次最多合并请求数（防失控）。 */
  maxRequests: 50,
  /** 尾部读取窗口（字节）；不足时由调用方扩大。 */
  tailBytes: 256 * 1024,
  // ────────────────────────────────────────────────────────────────────────
  // 【加急档（分层低水位）· 卡【加急档·A1】判据层 / 2026-09-24】
  //   方案 `docs/` §3.3 策略键；数值口径 = §11.1（主人 2026-09-24 拍板 ④）
  //   ⚠️ **交付 ≠ 放行**：`urgentEscalateMs` **默认关**（`null`）。放行 = 主人点头后改成 20 分钟
  //      （只改口径不改代码）—— 那是 A4（乙档），本卡不开任何开关。
  // ────────────────────────────────────────────────────────────────────────
  /**
   * 排队超时**自动升档**到加急档的阈值（毫秒）。
   * `null` / `NaN` / `0` / 负数 / 键缺失 **一律视为"升档关"**（默认）。
   * ⚠️ 判空口径**写死**（方案 §3.2 · M-1）：`const v = Number(...); Number.isFinite(v) && v > 0 && waitingMs >= v`；
   *    **禁止**直接写 `waitingMs >= policy.urgentEscalateMs` —— JS 里 `waitingMs >= null` ≡ `>= 0` **恒真**，
   *    会把"默认关"静默变成"默认开"，让这条"无人下令也打断人"的路径失控。
   * 放行值（主人拍板）= **20 分钟**（`20 * 60_000`）。
   */
  urgentEscalateMs: null,
  /**
   * 软保护窗口（毫秒）：普通活跃会话最近这么久内出现过 `user/message` ⇒ 本轮不打断（退回 queue）。
   * 主人 2026-09-24 拍板 ②=b / ④ = **120 秒**。
   * ⚠️ 本键**同时**是软保护的显式开关（方案 §3.2 订正注 · 复审 N-6 三态）：非有限正数
   *    （`null`/`0`/负数/缺键）⇒ `softProtect.mode='off'`（显式关闭 ⇒ 允许执行 + 审计 `softProtectDisabled`）。
   */
  urgentProtectUserInputMs: 120_000,
  /**
   * **自动升档**每天最多执行几次（主人拍板 ④ = **5 次/天**）。
   *
   * 【A4 前置已落地 · 2026-09-28】消费方 = `resolveUrgentDailyQuota()` / `gateUrgentEscalation()`
   *   （判据层闸门）＋ `restart-coordinator.mjs` 的计数器（`readUrgentDaily` / `bumpUrgentDaily`）。
   *   复审 R-4 要求的「计数器 + 闸门 + 可见性」三件自此齐备。
   * ⚠️ **交付 ≠ 放行**：`urgentEscalateMs` 仍为 `null`（升档默认关）⇒ 闸门当下**无从拦截**
   *   （没有升档动作可拦）；放行 = A4（乙档 · 等主人拍板），本键与闸门都不改变"默认关"这一事实。
   * ⚠️ 口径边界（本卡自决、已登记）：闸门只拦**自动升档**（`tierEscalated` 且把档位真抬到 urgent）；
   *   人显式下的 `--priority urgent` 请求**不被拦**（那是人在当场拍板），但同样计数并可见。
   */
  urgentMaxPerDay: 5,
  /**
   * 加急档**自动喊话**开关（2026-10-26 主人令）。
   * 语义：排队等久了自动升到 urgent 档、但仍停在 `queue`（卡在跑 / 等用户输入）⇒ 协调器自动跑一次
   *   `drain-freeze.mjs --send`，把「卡跑完只等验收、不推新卡、去闸门领通知、重启后继续」的口径
   *   喊给活跃主线会话，**断掉「卡跑完 → 接下一张」这条死锁链**。
   * ⚠️ **默认开**（主人令）；关回 = 策略文件 `"autoDrainFreeze": false`，或 env
   *   `DSH_RESTART_AUTO_DRAIN_FREEZE=0|off`（env 优先）。
   * ⚠️ 本键**只被 `restart-coordinator.mjs` 的 6.35 段读取**，不参与档位 / 低水位 / 卡分流任何判定。
   */
  autoDrainFreeze: true,
};

/**
 * 维护窗口期「预期事件静默白名单」——P2 watch 读 butler-maintenance.json 后按此静默。
 * 维护窗口**不是全局静音开关**：白名单外的事件照常判定与推送（方案 §4 v2.2 修正）。
 */
export const MAINTENANCE_SILENCE_WHITELIST = [
  { id: 'guard-alive', match: 'guard', description: '守护鱼存活异常（重启期 guard 可能瞬时不可见）' },
  { id: 'port-3080', match: 'port', description: '3080 未监听（重启期必然发生）' },
  { id: 'task-result', match: 'scheduled-task', description: '计划任务结果码非 0（重启期 tick 可能被抢占）' },
  { id: 'dsh-event', match: 'dsh', description: 'dsh 相关事件（重启期必然发生）' },
];

// ══════════════════════════════════════════════════════════════════════════
// ★ 策略文件读取入口（`~/.dsh/butler-restart-policy.json`）
//   卡【G33·重启闸门加急档】**A4 放行** / 2026-09-28
//   真源：`docs/` §3.3（策略键）+ §10 A4 行 + §11.1 拍板值
//
//   为什么要有这一层：`DEFAULT_POLICY` 的注释从 A1 起就承诺「可被 butler-restart-policy.json 覆盖」，
//   但**一直没有读取方**（A4 前置卡实测：`urgentEscalateMs` 只能靠改代码生效；2026-09-25 第 12 棒会话
//   把这个缺口登记为「A4 不能独立先行」的理由之一）—— 本层把那个承诺兑现。
//
//   口径（每条都取 fail-safe 一侧，条条有单测）：
//     · 文件**缺失** = 正常态（**不是**错误）⇒ 回落 `DEFAULT_POLICY`（其 `urgentEscalateMs: null` = 升档默认关）；
//     · 文件读不出 / JSON 坏了 / 顶层不是对象 ⇒ 回落默认 + 告警（**绝不**因此"默认开"）；
//     · 白名单内的键**值非法**（类型/范围不符）⇒ **丢弃该键**、回落默认值 + 告警（不猜、不钳制）；
//     · 白名单**外**的键 ⇒ 忽略 + 告警（不静默用未知键改行为）；
//     · 优先级：**调用方显式传入的 policy > 策略文件 > `DEFAULT_POLICY`**
//       （显式最优先 ⇒ 单测/预演可注入，且不会被生产文件"串味"；都没有时 == 老行为逐字不变）。
//   ⚠️ 本层**只读不写**：放行 / 关回都由人改这个文件（放行 = 写入值；关回 = 删文件 **或** 把键设回 `null`）。
//   ⚠️ 为什么不用 `lib/store.mjs#readJson`：那是**状态文件**读写器（带 schemaVersion 迁移语义、
//      版本不符即抛 SchemaMismatchError、写侧走原子写）。本文件是**人工编辑的策略契约文件**：
//      缺失是正常态、没有 schemaVersion 语义、也从不由此处写入 ⇒ 自读自解析，语义更清楚。
// ══════════════════════════════════════════════════════════════════════════

/** 【2c-B2】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, opts = {}) {
  return resolveStatePath(name, { home: opts.home ?? dshHome() }).path;
}
/** 策略文件名（放行开关的载体）。 */
export const RESTART_POLICY_FILE_NAME = 'butler-restart-policy.json';

/** 策略文件绝对路径（唯一口径；禁各脚本自己拼 `~/.dsh/...`）。 */
export function restartPolicyFilePath(home = dshHome()) {
  return stateFileOf(RESTART_POLICY_FILE_NAME, { home });
}

/**
 * 策略文件**可覆盖键白名单**（v1 = 加急档三键 · 方案 §3.3 同族）。
 *
 * 【为什么白名单这么窄】其余策略键（`activeMtimeMs` / `queueTimeoutMs` / `requestTtlMs` /
 *   `tailBytes` / `fallbackWindow` …）属于"低水位判定 / 排队提醒 / 维护窗口"族，放行它们会把本次
 *   改动的**影响面**从加急档扩大到整个重启闸门 ⇒ 本卡（A4）不放。要放行某个新键：在此表**显式登记
 *   校验函数**，并同步补单测（表里没有 = 忽略 + 告警，永不静默生效）。
 *
 * 【为什么非法值要"丢弃"而不是"钳制到最近合法值"】文件是人工契约：写错了必须**看得见**（告警），
 *   并且结果落在安全一侧（回落默认 = 升档关）。静默钳制会把"我明明写了"和"实际生效值"拉开距离。
 */
const POLICY_KEY_SPECS = Object.freeze({
  /**
   * 排队超时**自动升档**阈值（毫秒）。**A4 放行的就是这个键**：`1200000` = 20 分钟。
   * 合法 = `null`（显式关） 或 正有限数；其余（0 / 负数 / NaN / 字符串 / 对象 / 布尔）⇒ 丢弃回落 `null`。
   * ⚠️ 消费侧判空口径写死在 `resolveTier()`（M-1：禁裸写 `waitingMs >= 该键`，否则 `>= null` 恒真）。
   */
  urgentEscalateMs: Object.freeze({
    check: (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0),
    expect: 'null（= 升档关）或正有限数（毫秒）；放行值 = 1200000（20 分钟）',
  }),
  /** 自动升档每天上限（拍板 5 次/天）。合法 = **非负**有限数（`0` = 显式全禁，合法）；其余 ⇒ 丢弃回落 5。 */
  urgentMaxPerDay: Object.freeze({
    check: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    expect: '非负有限数（0 = 显式全禁）；拍板值 = 5',
  }),
  /**
   * 软保护窗口（毫秒）。合法 = `null`（显式关软保护） 或 有限数（含 0 / 负数 —— 按 `DEFAULT_POLICY`
   * 注释的既有三态口径，它们等价于"关"，语义确定，故判合法）；其余 ⇒ 丢弃回落 120000。
   */
  urgentProtectUserInputMs: Object.freeze({
    check: (v) => v === null || (typeof v === 'number' && Number.isFinite(v)),
    expect: 'null（= 显式关软保护）或有限数（毫秒）；拍板值 = 120000',
  }),
  /**
   * 加急档自动喊话开关（2026-10-26 主人令 · **默认开**）。
   * 合法 = 布尔；其余（字符串 / 数字 / null）⇒ 丢弃并回落默认 `true`（仍是开，fail-open 一侧）。
   * ⚠️ 只影响 `restart-coordinator.mjs` 的 6.35 副作用段，不改任何判定语义。
   */
  autoDrainFreeze: Object.freeze({
    check: (v) => typeof v === 'boolean',
    expect: 'true / false（缺键 = 开；关回 = false）',
  }),
});

/**
 * 读取并校验策略文件（**纯 IO + 校验，只读不写**；单测入口）。
 *
 * @param {{home?:string, file?:string}} [opts] `home` 决定默认落点；`file` 显式指定（测试/预演用）
 * @returns {{policy:object, source:'absent'|'file'|'unreadable'|'invalid-json'|'not-object',
 *            file:string, applied:object, ignored:Array<object>, rejected:Array<object>, warnings:string[]}}
 *   · `policy` **永远**是完整可用的对象（`DEFAULT_POLICY` 打底 + 合法键覆盖）——调用方不必再判空；
 *   · `source` = 取数来源（`absent` = 没有文件，正常态）；`applied` = 真正覆盖上的键；
 *   · `ignored` / `rejected` / `warnings` = 给审计与 tick 日志的"为什么没按你写的值生效"。
 */
export function loadRestartPolicy({ home = dshHome(), file = null } = {}) {
  const target = file ? path.resolve(file) : restartPolicyFilePath(home);
  const result = {
    policy: { ...DEFAULT_POLICY }, source: 'absent', file: target,
    applied: {}, ignored: [], rejected: [], warnings: [],
  };
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return result; // 正常态：没有策略文件 ⇒ 全默认（升档关）
    result.source = 'unreadable';
    result.warnings.push(`策略文件读不出来（${e?.code ?? e?.message ?? e}）⇒ 回落默认策略：${target}`);
    return result;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    result.source = 'invalid-json';
    result.warnings.push(`策略文件不是合法 JSON（${e?.message ?? e}）⇒ 回落默认策略：${target}`);
    return result;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.source = 'not-object';
    result.warnings.push(`策略文件顶层必须是对象（实得 ${Array.isArray(parsed) ? 'array' : typeof parsed}）⇒ 回落默认策略：${target}`);
    return result;
  }
  result.source = 'file';
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // ① 白名单内的键：逐个校验（**遍历白名单**而不是遍历文件，防 `__proto__` 之类原型链取值）
  for (const key of Object.keys(POLICY_KEY_SPECS)) {
    if (!has(parsed, key)) continue;
    const value = parsed[key];
    const spec = POLICY_KEY_SPECS[key];
    if (!spec.check(value)) {
      result.rejected.push({ key, value, reason: `值非法（期望 ${spec.expect}）⇒ 丢弃、回落默认值 ${JSON.stringify(DEFAULT_POLICY[key])}` });
      continue;
    }
    result.policy[key] = value;
    result.applied[key] = value;
  }
  // ② 白名单外的键：忽略 + 告警（改行为的键必须显式登记 + 有校验才生效）
  for (const key of Object.keys(parsed)) {
    if (has(POLICY_KEY_SPECS, key)) continue;
    result.ignored.push({ key, value: parsed[key], reason: '不在可覆盖白名单（改行为的键必须显式登记 + 带校验才能生效）' });
  }
  for (const it of result.ignored) result.warnings.push(`策略文件忽略键 ${it.key}=${JSON.stringify(it.value)}：${it.reason}`);
  for (const it of result.rejected) result.warnings.push(`策略文件拒绝键 ${it.key}=${JSON.stringify(it.value)}：${it.reason}`);
  return result;
}

/**
 * 策略求值的**唯一入口**（策略文件 ⊕ 调用方显式 policy ⊕ `DEFAULT_POLICY`）。
 *
 * 优先级（高 → 低）：`policy`（调用方显式传入，内部代码/单测/预演用的注入面）
 *   → 策略文件里的合法键 → `DEFAULT_POLICY`。
 *
 * 【为什么显式最优先】① 单测/只读预演要能注入"假设放行 20 分钟"而**不被生产策略文件串味**；
 *   ② "调用方明确要求"比"配置文件"更接近意图。③ 三者都没有时 == `DEFAULT_POLICY`，老行为逐字不变。
 *
 * @param {{home?:string, policy?:object|null, file?:string}} [opts]
 * @returns {{policy:object, source:string, file:string, applied:object, ignored:Array, rejected:Array,
 *            warnings:string[], overriddenByCaller:string[]}}
 */
export function resolveRestartPolicy({ home = dshHome(), policy = null, file = null } = {}) {
  const loaded = loadRestartPolicy({ home, file });
  const override = {};
  if (policy && typeof policy === 'object' && !Array.isArray(policy)) {
    for (const [k, v] of Object.entries(policy)) if (v !== undefined) override[k] = v;
  }
  return { ...loaded, policy: { ...loaded.policy, ...override }, overriddenByCaller: Object.keys(override) };
}

/** 是否落在兜底窗口内（仅标记用途，不改变低水位判定）。 */
export function inFallbackWindow(now, policy = DEFAULT_POLICY) {
  const { startHour, endHour } = policy.fallbackWindow ?? DEFAULT_POLICY.fallbackWindow;
  const h = new Date(now).getHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour; // 跨午夜
}

// ------------------------------------------------------------------ ① 活跃判定

/**
 * 折叠尾部事件的回合开闭状态（纯函数，单测入口）。
 *
 * ★ P0 宿主适配层（2026-09-14）：**实现已收敛到 `host.classifyTail`**，本函数是转发壳。
 *   保留它是因为它是既有公共 API（单测 / watch-collect / 面板链路直接调）；
 *   行为与迁移前**逐字一致**（`_archive\adapter-p0-20260914-1536\regression\` 回归差异 0 条）。
 *   判定口径的文字说明保留在下面（迁移前的历史，配合适配层内的实现阅读）。
 *
 * v0.1.1（2026-09-11 修「被打断检测失效」，主人点破）：
 *   ① `turn/end` 不再一律算"已收尾"——读 `data.reason.kind`，非 NORMAL_TURN_END_KINDS
 *      （interrupted / aborted / error / …）→ state='interrupted'（回合结束了，但是被打断的）。
 *   ② `session/end-seed` 透明化——它是**重启/停机时主包给当时活跃会话补写的收尾标记**，
 *      实测常常落在被打断会话的最后一条，把真正的尾巴（turn/end interrupted）挡住。
 *      改为继续往前找回合边界（实测本机 38/38 个 end-seed 会话，其前一条回合事件都是 turn/end）；
 *      若窗口内根本没有回合边界 → 仍是 closed（种子会话已终结，保持旧语义）。
 *   `interrupted` 对「活跃判定」等价于 closed（回合确实结束了，不该阻塞重启排队），
 *   对「被打断清单 / P2 会盯人」则是一条真信号（见 watch-collect.mjs）。
 * @param {Array<{type:string,seq?:number,time?:number,data?:any}>} events 尾部事件（seq 升序）
 * @returns {{state:'empty'|'closed'|'open'|'interrupted'|'unknown', boundary:object|null, last:object|null, reason:string}}
 */
export function classifyTail(events) {
  return host.classifyTail(events);
}

/**
 * 单会话是否"活跃"（纯函数，单测入口）。
 * 口径：回合未闭合（open）或读不到边界（unknown）**且** 文件在 activeMtimeMs 内更新过。
 *
 * v0.1.2（2026-09-11 卡 [Q4]「低水位误判打断在跑的卡」）两处修正：
 *   ① **`ageMs < 0` 不是 stale，而是最新鲜**：旧判据写的是 `ageMs >= 0 && ageMs < 窗口`，
 *      把"文件 mtime 晚于传入的 now"当成过期 → 直接判不活跃。而调用方传的 now 是
 *      **tick 启动时刻**，到真正读盘之间夹着 fetchTitles 的 HTTP 往返（DSH 忙时实测 0.8–11.6 秒），
 *      期间高频写日志的会话 mtime 必然越过 now → 越活跃越被判 stale（反选择）。
 *      实测复现：同一时刻 running 会话 5 个，用旧 now 判 active=1，用判定前即时时钟判 active=5；
 *      HTTP 耗时 11.6s 那轮 4 个会话被判 `stale(age=-Ns)`。这正是 11:52:44 / 14:58:28
 *      两次 `reason=low-watermark-zero` 重启的真实原因。
 *   ② `newestFrameBad`（尾部最新帧解压失败，通常是被读取时正在写入的半截帧）→ 不采信更早的
 *      回合边界，保守按"回合进行中"处理（仅在文件新鲜时生效，避免僵尸会话永久阻塞）。
 *
 * @param {Array} events 尾部事件
 * @param {{now:number, mtimeMs:number, policy?:object, newestFrameBad?:boolean}} opts
 *        ⚠️ now 必须是**判定时刻的即时时钟**（Date.now()），不是 tick 启动时刻；
 *           显式注入 now 只用于单测/回放（此时把 now 当权威时钟）。
 * @returns {{active:boolean, state:string, reason:string, ageMs:number|null, tail:object|null, lastType:string|null}}
 */
export function isSessionActive(events, opts = {}) {
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const now = opts.now ?? Date.now();
  const mtimeMs = Number(opts.mtimeMs ?? 0);
  const c = classifyTail(events);
  const ageMs = mtimeMs ? now - mtimeMs : null;
  // v0.1.2：负值 = 文件在 now 之后被写过 = 刚写完，**最活跃**（不是过期）。
  const fresh = ageMs !== null && ageMs < policy.activeMtimeMs;
  const clockNote = ageMs !== null && ageMs < 0 ? `判定时钟早于写入 ${Math.round(-ageMs / 1000)}s（视为新鲜）` : null;
  const tailDesc = c.last ? describeTail(c.last) : null;
  if (c.state === 'empty') return { active: false, state: 'empty', reason: 'no-events', ageMs, tail: null, lastType: null };
  // v0.1.1：interrupted（被打断的 turn/end）对活跃判定等价于 closed —— 回合确实已结束，不该阻塞重启排队
  if (c.state === 'closed' || c.state === 'interrupted') {
    if (opts.newestFrameBad === true && fresh) {
      return { active: true, state: 'unknown', reason: `${c.reason} but newest-frame-unreadable（半截帧，保守视为回合进行中）`, ageMs, tail: tailDesc, lastType: c.last?.type ?? null, newestFrameBad: true };
    }
    return { active: false, state: c.state, reason: c.reason, ageMs, tail: tailDesc, lastType: c.last?.type ?? null };
  }
  if (!fresh) return { active: false, state: c.state, reason: `${c.reason} but stale(${ageMs === null ? 'no-mtime' : Math.round(ageMs / 1000) + 's'})`, ageMs, tail: tailDesc, lastType: c.last?.type ?? null };
  return { active: true, state: c.state, reason: clockNote ? `${c.reason}（${clockNote}）` : c.reason, ageMs, tail: tailDesc, lastType: c.last?.type ?? null, ...(opts.newestFrameBad ? { newestFrameBad: true } : {}) };
}

/** 人类可读的"尾巴停在 X"（打断清单 / 通知用）。
 *  ★ P0（2026-09-14）：文案映射已收敛到 `host.describeTail`（适配层 `legacyName` 同族职责：
 *     人类可读映射是本层职责，各包自带映射表视作 R4 违规）。转发壳保持既有行为逐字不变。 */
export function describeTail(event) {
  return host.describeTail(event);
}

// ---------------------------------------------------- ①b 活跃集合多源并集（[Q4]，v0.1.2）

/** sessionId 归一化（目录名 / session.list / ledger 三处写法统一成字符串）。 */
export function normSessionId(id) {
  const s = String(id ?? '').trim();
  return s || null;
}

function toIdSet(ids) {
  const out = new Set();
  const list = ids instanceof Set || Array.isArray(ids) ? [...ids] : (ids ? [...ids] : []);
  for (const raw of list) {
    const id = normSessionId(raw);
    if (id) out.add(id);
  }
  return out;
}

/**
 * 从看板 ledger 提取「正在执行的卡」的执行会话（纯函数，单测入口）。
 * 只认 `status === 'running'` 的卡 —— 它们的执行会话此刻按定义必须在跑。
 * ⚠️ 故意**不认** review（待验收）卡：那类卡的会话通常已结束，计入会让闸门长期排队。
 * @param {object|Array} ledger ledger-v2.json 内容（{tasks:[...]} 或裸数组）
 * @returns {Map<string, {cardId:string, title:string, startedAt:number}>}
 */
export function extractRunningCardSessions(ledger) {
  const tasks = Array.isArray(ledger) ? ledger : (ledger?.tasks ?? []);
  const out = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.status !== 'running') continue;
    for (const e of Array.isArray(t.executions) ? t.executions : []) {
      const id = normSessionId(e?.sessionId);
      if (!id) continue;
      const startedAt = Number(e?.startedAt) || 0;
      const prev = out.get(id);
      if (!prev || startedAt >= prev.startedAt) out.set(id, { cardId: t.id, title: String(t.title ?? ''), startedAt });
    }
  }
  return out;
}

/**
 * 活跃集合多源取并集（纯函数，单测入口；[Q4] 修复核心）。
 *
 * 【判据参与模型】——一句话：文件判据 + 主包 running + 看板 running 卡，**并集**，任一说活跃就活跃。
 *
 * 参与判定（任一命中 → active=true）：
 *   ① `file`          —— 文件判据（isSessionActive）：尾部回合未闭合/读不到边界，且在活跃时间窗内；
 *   ② `agent-running` —— 主包权威标志（session.list[].running === true）：主包内存态，说在跑就是在跑；
 *   ③ `board-card`    —— 看板 running 卡的执行会话（extractRunningCardSessions）。
 *
 * **不参与**判定（别再加回来）：
 *   - 会话标题状态标记（【运行】/【完成】）：agent 自己打的标，忘了改回来会让闸门永久排队；
 *   - 看板 review/待验收/已完成卡：会话通常已结束；
 *   - P2 会盯人的"疑似被打断"清单：那是**事后投影**（5 分钟~3 天窗口），不是"此刻是否在跑"。
 *
 * 安全阀（防"永不重启"）：
 *   - ③ **先过主包存活二次校验**（2026-09-14 假 running 收口）：调用方给出**可读且非空**的
 *     会话列表（`sessionListKnown` + `listedSessionIds`）时，卡会话只要**不在** `runningIds`
 *     里，就是主包明确说"它没在跑" → 不再按卡状态强制活跃。治的正是"会话早已结束、卡还是
 *     running"的假 running 卡把闸门永久堵死（现场：2026-09-14 03:14–03:17 `73c29748[board-card]stale`
 *     连续 4 轮把排队重启挡在门外，最后只能强制重启）。
 *     **反过来不成立**：真在跑的卡会话必然出现在 `runningIds` 里 → 仍照旧计入活跃
 *     （[Q4] 的初衷：只信文件判据会漏判在跑的卡，这条不能被修丢）。
 *     列表不可读 / 列表为空 → **关掉校验**、退回旧行为（宁可排队等，不可漏判在跑的会话）。
 *   - ③ 仍受 `cardForceActiveMaxIdleMs`（默认 30 分钟）兜底 —— 主包列表不可用时的第二道阀，
 *     避免 runner 挂掉留下的僵尸 running 卡把闸门永久挡住；会话文件不存在（无 mtime）时同样不强制。
 *   - ② 不设上限（主包内存态可信，重启即清）。
 *
 * @param {Array} sessions collectSessions() 的原始行
 * @param {{runningIds?:Array|Set, listedSessionIds?:Array|Set, sessionListKnown?:boolean,
 *          cardSessionIds?:Map|Array, now?:number, policy?:object}} opts
 *        `sessionListKnown` = 主包会话列表本轮**读到了**（RPC ok）；只有它为 true 且
 *        `listedSessionIds` 非空时，存活二次校验才生效（缺省 = 旧行为）。
 * @returns {{sessions:Array, active:Array, stats:object}}
 */
export function mergeActiveSources(sessions, opts = {}) {
  const now = opts.now ?? Date.now();
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const rows = Array.isArray(sessions) ? sessions : [];
  const runningIds = toIdSet(opts.runningIds ?? []);
  const listedIds = toIdSet(opts.listedSessionIds ?? []);
  // 存活二次校验的启用前提：主包列表可读且非空。缺任何一条都退回旧行为（fail-safe 站在"挡住重启"一侧）。
  const hostLivenessKnown = opts.sessionListKnown === true && listedIds.size > 0;
  const cardMap = opts.cardSessionIds instanceof Map
    ? opts.cardSessionIds
    : new Map([...toIdSet(opts.cardSessionIds ?? [])].map((id) => [id, { cardId: null, title: '', startedAt: 0 }]));
  const maxIdle = Number(policy.cardForceActiveMaxIdleMs ?? DEFAULT_POLICY.cardForceActiveMaxIdleMs);
  const seen = new Set();
  const stats = { file: 0, agentRunning: 0, boardCard: 0, synthesized: 0, droppedByHostLiveCheck: 0, droppedStaleCards: [], total: 0, now, hostLivenessKnown };
  const out = [];

  const apply = (row) => {
    const id = normSessionId(row.sessionId);
    if (id) seen.add(id);
    const sources = [];
    if (row.active === true) sources.push(row.activeSource ?? 'file');
    if (id && runningIds.has(id)) sources.push('agent-running');
    if (id && cardMap.has(id)) {
      const info = cardMap.get(id);
      const age = Number.isFinite(row.ageMs) ? row.ageMs : null;
      // ① 主包存活二次校验（2026-09-14 假 running 收口）：列表可读且该会话**不在** running 集合
      //    ⇒ 主包明确说它没在跑 ⇒ 卡状态不再强制活跃（假 running 卡不再堵门）。
      //    真在跑的卡会话在 running 集合里 → 走到 ③ 照旧计入活跃（[Q4] 初衷不丢）。
      if (hostLivenessKnown && !runningIds.has(id)) {
        stats.droppedStaleCards.push({ sessionId: id, cardId: info.cardId ?? null, ageMs: age, why: 'host-not-running' });
        stats.droppedByHostLiveCheck++;
      } else if (age === null) {
        stats.droppedStaleCards.push({ sessionId: id, cardId: info.cardId ?? null, ageMs: null, why: 'no-mtime' });
      } else if (age > maxIdle) {
        stats.droppedStaleCards.push({ sessionId: id, cardId: info.cardId ?? null, ageMs: age, why: 'idle-over-max' });
      } else {
        sources.push('board-card');
      }
    }
    const uniq = [...new Set(sources)];
    if (uniq.includes('board-card')) stats.boardCard++;
    if (uniq.includes('agent-running')) stats.agentRunning++;
    if (uniq.length === 1 && uniq[0] === 'file') stats.file++;
    const active = uniq.length > 0;
    return {
      ...row,
      active,
      activeSource: uniq.join('+') || null,
      reason: active ? `active-by=[${uniq.join('+')}]｜${row.reason ?? ''}` : row.reason,
    };
  };

  for (const row of rows) out.push(apply(row));

  // 主包说 running 但文件没扫到（扫描范围/文件缺失）→ 合成一行，别让它凭空消失（主包是权威）
  for (const id of runningIds) {
    if (seen.has(id)) continue;
    out.push({
      sessionId: id, active: true, activeSource: 'agent-running', state: 'agent-running',
      reason: 'active-by=[agent-running]｜session.list running=true（无会话文件，主包权威）',
      mtimeMs: 0, ageMs: null, tail: null, lastType: null, title: '', synthesized: true,
    });
    stats.synthesized++;
    stats.agentRunning++;
  }
  // 卡会话若没有会话文件 → 不强制（无法验证新鲜度），只登记，避免僵尸卡堵死闸门
  for (const [id, info] of cardMap) {
    if (seen.has(id)) continue;
    stats.droppedStaleCards.push({ sessionId: id, cardId: info.cardId ?? null, ageMs: null, why: 'no-session-file' });
  }

  const active = out.filter((r) => r.active);
  stats.total = active.length;
  return { sessions: out, active, stats };
}

// ------------------------------------------------------------------ ② 合并批次

/** 批次 id = correlationId（贯穿请求 → 重启 → 通知 → 打断清单 → 审计）。 */
export function makeBatchId(now = Date.now(), seed = Math.random) {
  const t = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `rst-${t}-${Math.floor(seed() * 1e6).toString(36)}`;
}

/**
 * 合并待执行请求为一个批次（方案：多请求合并成一个批次，不逐个重启）。
 * @param {Array<object>} requests 有效 pending 请求
 * @param {{now?:number, batchId?:string, policy?:object}} [opts]
 */
export function mergeBatch(requests, opts = {}) {
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const now = opts.now ?? Date.now();
  const list = (Array.isArray(requests) ? requests : []).slice(0, policy.maxRequests);
  if (!list.length) return null;
  const requesterIds = [...new Set(list.map((r) => r?.requester?.sessionId).filter(Boolean))];
  // 低水位「排除集合」≠ 通知目标集合（2026-09-11 卡 [S*·重启通知] 拆分）：
  //   会话内发起（kind=session/cli/未标）→ 排除发起者自己（旧语义：发起者必然在跑）。
  //   面板发起（kind=panel）带上的会话只是**通知目标**（主人在那个界面点的按钮），
  //   它若正在跑回合仍应阻止重启 → 保持"不打断真活跃会话"的低水位语义不变。
  const excludeIds = [...new Set(
    list
      .filter((r) => (r?.requester?.kind ?? 'session') !== 'panel')
      .map((r) => r?.requester?.sessionId)
      .filter(Boolean),
  )];
  const createdAt = Math.min(...list.map((r) => Number(r?.createdAt) || now));
  return {
    batchId: opts.batchId ?? makeBatchId(now),
    requestIds: list.map((r) => r.id),
    correlationId: opts.batchId ?? null, // 由调用方补（batchId 即 correlationId）
    requesterIds,
    excludeIds,
    force: list.some((r) => r?.mode === 'force'),
    reasons: [...new Set(list.map((r) => r?.reason).filter(Boolean))],
    createdAt,
    waitingSince: createdAt,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// ★ 加急档（分层低水位）**判据层** —— 卡【加急档·A1】/ 2026-09-24
//   方案：docs/（§3.1 档位 / §3.2 判据 / §3.3 策略键 / §3.4 红线）
//   过审面：定点复审 ✅ 范围性合格证（只覆盖 B-1/B-2/M-1/M-2/M-3）；
//   拍板面：§11.1（2026-09-24 主人：①=c ②=b ③=a ⑤=a · 数值 = 20 分钟 / 120 秒 / 5 次/天）
//   本层只做**纯判据**（不写状态、不发通知、不动进程）；执行/审计/提醒 = A2，入口 = A3，放行 = A4（乙档）。
// ══════════════════════════════════════════════════════════════════════════

/** 档位（rank 越大越激进）：`normal` 默认 / `urgent` 本方案新增的中间档 / `force` 语义不变。 */
export const RESTART_TIERS = Object.freeze(['normal', 'urgent', 'force']);
export const TIER_RANK = Object.freeze({ normal: 0, urgent: 1, force: 2 });

/** 档位归一化（不认识的输入一律 `normal` ⇒ 零行为变更）。 */
export function normalizeTier(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return RESTART_TIERS.includes(s) ? s : 'normal';
}

/**
 * 有效档位 = `max(显式档, 超时升档)`（纯函数，单测入口；方案 §3.2/§3.3）。
 *
 * 【M-1 判空口径 —— 必须逐字照抄，别"优化"】升档键的判定**必须**写成
 *   `const v = Number(policy.urgentEscalateMs); Number.isFinite(v) && v > 0 && waitingMs >= v`。
 *   **禁止**直接写 `waitingMs >= policy.urgentEscalateMs`：JS 里 `waitingMs >= null` ≡ `>= 0` **恒真**，
 *   会把"默认关"静默变成"默认开"（这条是本方案唯一的"无人下令也会打断人"路径）。
 *
 * @param {{requests?:Array, batch?:object, force?:boolean, waitingMs?:number, policy?:object}} input
 * @returns {{tierRequested:'normal'|'urgent'|'force', tierEscalated:boolean,
 *            tierEffective:'normal'|'urgent'|'force', escalateEnabled:boolean,
 *            escalateMs:number|null, waitingMs:number}}
 */
export function resolveTier(input = {}) {
  const policy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
  const requests = Array.isArray(input.requests) ? input.requests : [];
  const waitingMs = Number.isFinite(Number(input.waitingMs)) ? Number(input.waitingMs) : 0;
  let tierRequested = 'normal';
  for (const r of requests) {
    const t = normalizeTier(r?.priority);
    if (TIER_RANK[t] > TIER_RANK[tierRequested]) tierRequested = t;
  }
  // `batch.force`（= 批次里任一请求 `mode:'force'`）仍旧表达强制档；请求里的 `priority:'force'` 同样认。
  if (input.batch?.force === true || input.force === true) tierRequested = 'force';
  const v = Number(policy.urgentEscalateMs);
  const escalateEnabled = Number.isFinite(v) && v > 0;
  const tierEscalated = escalateEnabled && waitingMs >= v;
  const tierEffective = tierEscalated && TIER_RANK.urgent > TIER_RANK[tierRequested] ? 'urgent' : tierRequested;
  return { tierRequested, tierEscalated, tierEffective, escalateEnabled, escalateMs: escalateEnabled ? v : null, waitingMs };
}

// ── 每日升档上限（复审 R-4 的「计数器 + 闸门 + 可见性」三件 · 判据侧）────────────────
//   方案 §3.3 策略键 = `urgentMaxPerDay`（拍板值 5 次/天）；R-4 原文：
//     「A4 放行后升档无每日上限 ⇒ R-2/R-3 风险的护栏缺失 ⇒ 放行前必须有计数器 + 闸门 + 可见性」。
//   本层只做**纯判据**（读入计数、算出闸门结论），**不写任何状态**；计数器的落盘 = 执行层
//   `restart-coordinator.mjs`（`readUrgentDaily` / `bumpUrgentDaily`，同源状态文件
//   `~/.dsh/butler-restart-state.json`，不另起新根）。

/**
 * 本地时区日期键 `YYYY-MM-DD`（加急档每日计数器的日切口径）。
 *
 * 【为什么单列一个函数】计数必须**按本地日切**（主人在本地作息，UTC 会在晚上 8 点翻页）。
 *   口径与 `lib\autonomy-actions.mjs#localDay` **完全一致**（本地时区 + 补零）；本线（重启统筹）
 *   以本函数为唯一源，别再另写一份 `toISOString().slice(0,10)`（那是 UTC，会错 8 小时）。
 */
export function localDayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 闸门拒绝/降级的 reason 常量（**写死**：审计与面板按字面消费，禁止就地另造字符串）。 */
export const URGENT_DAILY_REASONS = Object.freeze({
  /** 当日升档次数已达上限 ⇒ 拒绝升档、退回 queue 档（方案 §3.3 / 复审 R-4 要求的那条）。 */
  LIMIT: 'urgent-daily-limit',
  /** 计数器读不出来 ⇒ **fail-safe 拒绝升档**（不许"读不到就放行"，那等于上限形同虚设）。 */
  UNAVAILABLE: 'urgent-daily-unavailable',
  /** 执行前记账写盘失败 ⇒ 放弃本次升档执行（不静默，见执行层审计 `restart-urgent-counter-failed`）。 */
  COUNTER_FAILED: 'urgent-counter-failed',
});

/**
 * 当日升档额度求值（**纯函数**，单测入口；复审 R-4）。
 *
 * @param {{policy?:object, urgentDaily?:{ok?:boolean, day?:string|null, used?:number,
 *          escalated?:number, explicit?:number, denied?:number}|null}} input
 * @returns {{ok:boolean, day:string|null, used:number, limit:number, reached:boolean,
 *            reason:string|null, escalated:number, explicit:number, denied:number}}
 *
 * 【判空口径（与 `urgentEscalateMs` 的 M-1 同精神，必须照抄）】
 *   · `limit` 取 `policy.urgentMaxPerDay`：**非有限数或负数 ⇒ 回落 `DEFAULT_POLICY.urgentMaxPerDay`**；
 *     `0` 是合法值 ⇒ **显式全禁**（比"误判成无限"安全得多，方向 pick fail-safe 一侧）。
 *   · `used` 非有限/负数 ⇒ 0。
 *   · `urgentDaily` **整块缺省**（调用方还没接计数器）⇒ `ok:true, used:0, reached:false`
 *     ⇒ **零行为变更**（A1/A2 既有路径不受影响）；只有显式 `ok:false` 才判"计数器不可用"。
 */
export function resolveUrgentDailyQuota(input = {}) {
  const policy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
  const raw = input.urgentDaily ?? null;
  const defaultMax = Number(DEFAULT_POLICY.urgentMaxPerDay);
  const n = Number(policy.urgentMaxPerDay);
  const limit = (Number.isFinite(n) && n >= 0) ? n : defaultMax;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const used = num(raw?.used);
  const available = raw == null ? true : raw.ok !== false;
  const day = (typeof raw?.day === 'string' && raw.day) ? raw.day : null;
  const reached = !available || used >= limit;
  const reason = !available
    ? URGENT_DAILY_REASONS.UNAVAILABLE
    : (used >= limit ? URGENT_DAILY_REASONS.LIMIT : null);
  return {
    ok: available, day, used, limit, reached, reason,
    escalated: num(raw?.escalated), explicit: num(raw?.explicit), denied: num(raw?.denied),
  };
}

/**
 * 把每日上限闸门套在 `resolveTier()` 的结果上（**纯函数**）。
 *
 * 【只拦"自动升档"】`tierEscalationApplied` = 排队超时**真把档位抬上去**了
 *   （`tierEscalated === true` 且请求档位低于 urgent）。人显式 `--priority urgent` 时
 *   `tierEscalationApplied === false` ⇒ **闸门不拦**（人当场拍板的事，不该被自动护栏挡住），
 *   但该次执行仍会被执行层计数（`explicit`）以便可见与复盘。
 * 【拒绝形态】达上限/计数器不可用 ⇒ `tierEffective` **退回 `tierRequested`**（= 退回 queue 档，
 *   走老判据），并置 `tierEscalationDenied` + `urgentDeniedReason`；**不改 `action`/`reason` 文案**
 *   （退回后由老分支自然给出 `active=N` 之类的排队原因，老断言逐字不变）。
 *
 * @param {object} tier `resolveTier()` 的返回值
 * @param {{policy?:object, urgentDaily?:object|null}} [input]
 */
export function gateUrgentEscalation(tier, input = {}) {
  const quota = resolveUrgentDailyQuota({ policy: input.policy, urgentDaily: input.urgentDaily });
  const requested = normalizeTier(tier?.tierRequested);
  const escalationApplied = tier?.tierEscalated === true && TIER_RANK[requested] < TIER_RANK.urgent;
  const denied = escalationApplied && quota.reached === true;
  return {
    ...tier,
    tierEffective: denied ? requested : tier?.tierEffective,
    tierEscalationApplied: escalationApplied,
    tierEscalationDenied: denied,
    urgentDeniedReason: denied ? quota.reason : null,
    urgentDailyQuota: quota,
  };
}

/**
 * 「卡执行会话」判据 —— **账本全量、不筛卡状态**（方案 §3.4 红线 2；单测入口）。
 *
 * 【为什么另立】既有 `restart.mjs#extractRunningCardSessions()` 只认 `status==='running'` 卡（服务**活跃判定**）；
 *   卡被**假结算**成 `review` 时其执行会话可能仍在跑 ⇒ 只看 running 会把它误判成"非卡会话"而打断 ⇒ 制造新的假结算。
 *
 * 【解析口径复用唯一源】解析（账本字段名 / sessionId 归一化 / 同 id 取最新执行）**一行都不重写** ——
 *   直接复用 `lib\card-session.mjs#extractCardSessions`（D-1 = b「一处判据 + 方向参数」的落地）。
 *   **但取向不同、不可照用**：通知面那份索引默认 **fail-open**（账本读不到 ⇒ 不排除任何人），
 *   本档要求 **fail-safe**（读不到 ⇒ **判为卡会话、不打断**）⇒ 方向由**消费侧**显式给
 *   （见 {@link classifyActiveByCard}：`asCardSessionIndex(..., { direction: 'fail-safe' })`）。
 *
 * @param {object|Array} ledger ledger-v2.json 内容（`{tasks:[...]}` 或裸数组）
 * @returns {Map<string, object>} sessionId → 卡执行会话条目（含 `status` / `settled` / `cardId`）
 */
export function extractAllCardSessions(ledger) {
  return extractCardSessions(ledger);
}

/**
 * 建**fail-safe**方向的卡会话索引（内部 helper）：``裸账本对象``（`{tasks:[...]}`）走全量解析，
 * 其余宽容输入（索引 / Map / Set / 数组 / `{home|ledger|ledgerPath}`）交给 `asCardSessionIndex`。
 * ⚠️ `asCardSessionIndex` **不认裸账本**（会落到 `unrecognized-index` ⇒ 被当成"不可用"）——本 helper 补这一口。
 */
function failSafeCardIndex(input, direction = 'fail-safe') {
  const dir = normCardSessionDirection(direction);
  if (input && typeof input === 'object' && !(input instanceof Map) && !Array.isArray(input) && Array.isArray(input.tasks)) {
    return makeCardSessionIndex(extractAllCardSessions(input), { source: 'ledger-object', direction: dir });
  }
  return asCardSessionIndex(input, { direction: dir });
}

/**
 * 把活跃集合按「卡执行会话 / 普通会话」分流（纯函数，单测入口；J1 / J4 的判据）。
 *
 * 【取向 = fail-safe（与通知面相反，故意的）】账本读不到 / 没给索引（`ok:false`）⇒ **全部活跃会话判为卡会话**
 *   ⇒ 加急档判据 `cardActive=0` 恒不成立 ⇒ **退回 queue**（宁可多等一分钟，也不打断真在跑的卡）。
 *   ⚠️ 与 `lib\card-session.mjs` 的默认 fail-open **方向相反** ⇒ 这里**必须**显式传 `direction: 'fail-safe'`。
 *
 * @param {Array} active `plan.active`（**已排除发起者**的活跃集合）
 * @param {{cardSessions?:object|Map|Array|Set, cardIndex?:object}} opts
 *        `cardSessions` = 账本 / 卡执行会话索引 / Map / Set（宽容输入，走 `asCardSessionIndex`）
 * @returns {{cardActive:Array, softActive:Array, count:number, cardIndexOk:boolean,
 *            degraded:boolean, direction:string, unknownAsCard:number}}
 */
export function classifyActiveByCard(active, opts = {}) {
  const rows = Array.isArray(active) ? active : [];
  const idx = failSafeCardIndex(opts.cardSessions ?? opts.cardIndex ?? null);
  const degraded = idx.ok !== true; // 账本不可读 ⇒ 方向生效（全判卡会话）
  const isCard = (id) => (degraded ? true : idx.isCardSession(id) === true);
  const cardActive = [];
  const softActive = [];
  for (const row of rows) {
    const id = normSessionId(row?.sessionId);
    if (id && isCard(id)) cardActive.push(row);
    else softActive.push(row);
  }
  return {
    cardActive,
    softActive,
    count: cardActive.length,
    cardIndexOk: idx.ok === true,
    degraded,
    direction: normCardSessionDirection(idx.direction),
    unknownAsCard: degraded ? rows.length : 0,
  };
}

/** 软保护三态（方案 §3.2 订正注 · 复审 N-6）。 */
export const SOFT_PROTECT_MODES = Object.freeze(['off', 'on', 'unavailable']);

/**
 * 软保护求值结果归一化（纯函数，单测入口）—— **三态契约**（复审 N-6 收口）。
 *
 * | mode | 何时是这一态 | 加急档行为 |
 * |---|---|---|
 * | `on` | 输入面可用（v3 尾部事件读到） | `holdSessionIds` 非空 ⇒ queue（`urgent-hold-user-input=K`） |
 * | `off` | **显式关闭**（策略键 `urgentProtectUserInputMs` 非有限正数） | **允许执行** + 审计 `softProtectDisabled` |
 * | `unavailable` | 输入面不可用（文件缺失 / 多帧解失败 / **判据未接**的过渡窗口） | **一律 queue**（`soft-protect-unavailable`） |
 *
 * **缺省口径（本卡定 · 待主人核）**：调用方**未注入**（`input` 为空）⇒ 按 `unavailable` 处理
 *   （fail-safe 站在"不打断"一侧）；`off` **只能由显式配置产生**，不许由"没接上"隐式产生。
 * 兼容旧形态 `{available: boolean}`（`true` → `on`、`false` → `unavailable`）。
 *
 * @param {{mode?:string, available?:boolean, holdSessionIds?:Array|Set, holdIds?:Array|Set}} input
 * @param {object} [policy]
 * @returns {{mode:'off'|'on'|'unavailable', holdSessionIds:Set, holdCount:number, holdIds:Array,
 *            disabled:boolean, unavailable:boolean, windowMs:number|null, source:string}}
 */
export function normalizeSoftProtect(input, policy = DEFAULT_POLICY) {
  const p = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  const hold = toIdSet(input?.holdSessionIds ?? input?.holdIds ?? []);
  const rawMode = String(input?.mode ?? '').trim().toLowerCase();
  let mode = SOFT_PROTECT_MODES.includes(rawMode) ? rawMode : null;
  let source = mode ? 'explicit-mode' : 'default';
  if (!mode && input && typeof input.available === 'boolean') {
    mode = input.available ? 'on' : 'unavailable';
    source = 'legacy-available';
  }
  const v = Number(p.urgentProtectUserInputMs);
  const enabledByPolicy = Number.isFinite(v) && v > 0;
  if (!mode) mode = enabledByPolicy ? 'unavailable' : 'off';
  if (mode === 'off') source = 'policy-off';
  const holdSessionIds = mode === 'on' ? hold : new Set();
  return {
    mode,
    holdSessionIds,
    holdCount: holdSessionIds.size,
    holdIds: [...holdSessionIds],
    disabled: mode === 'off',
    unavailable: mode === 'unavailable',
    windowMs: enabledByPolicy ? v : null,
    source,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 【加急档（分层低水位）· 卡【加急档·A2】执行层 / 2026-09-28】
//   软保护输入面（拍板 D-3 = a「加法另建 v3 尾部事件读取」· D-4 = a「写成可被治本路线复用的形态」）
//   方案落点：§3.4 红线 4 / §3.5 / §5 J5；复审落点：R-1（degraded 必须可见）+ P-2（缺省 = `unavailable`，
//   **A2 必须把求值接上** —— 不接 = 加急档永不执行且不可见）。
//   ⚠️ **不并入活跃判据**（三源并集 / 五道安全阀一字不动）：这是**独立的第二条读取**，只服务加急档。
//   ⚠️ 输入面口径（复审 B-1 阻断项已闭合的口径，别改回去）：**不得**依赖 `session.jsonl.zstd`
//      那份旧面（主包 0.1.5 起生产恒不命中）—— 一律走 `scanSessionLogFiles()`（族名唯一源）挑"当前那份"。
// ══════════════════════════════════════════════════════════════════════════

/** zstd 帧 magic（多帧 append-only 会话日志的帧边界判据）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 解出来的 jsonl 文本 → 事件对象数组（半截行 / 坏行跳过，不让它污染判定）。 */
function parseTailJsonLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j.type === 'string') out.push(j);
    } catch { /* 半截行：跳过 */ }
  }
  return out;
}

/** 读文件尾部字节（越界自动裁剪）。 */
function readTailBuffer(file, maxBytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - Math.min(maxBytes, st.size));
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    return { buf: read === buf.length ? buf : buf.subarray(0, read), truncated: start > 0, size: st.size };
  } finally { fs.closeSync(fd); }
}

/**
 * **软保护输入面**：读某个会话的尾部事件，取最近一条 `user/message` 的年龄（毫秒）。
 *
 * 【为什么另立一个函数】方案 §3.5 原写"从 `collectSessions()` 取最近 `user/message`",
 *   而该数据源（旧名 `session.jsonl.zstd`）在 0.1.5 生产**恒不命中** ⇒ 保护会**静默空转**
 *   （"主人正在打字的会话被硬杀"且无人知）。复审 B-1 判为阻断项，处置 = 本函数走
 *   **同族最新日志**（`scanSessionLogFiles()` 的 `pickSessionFileInDir`：认全世代 + 确定性挑当前那份）
 *   + **多帧 zstd 逐帧解**（会话日志是 append-only 多帧，只解最后一帧会漏掉更早的 `user/message`）。
 *
 * 【可用性显式化（fail-safe）】`ok:false` = **输入面不可用**（文件缺失 / stat 失败 / 无帧 / 最新帧解失败），
 *   消费侧（{@link evaluateSoftProtect}）必须把它翻成 `mode='unavailable'` ⇒ 加急档**一律退回 queue**，
 *   并在审计与面板明示"当前无输入保护"。**禁止静默按"无保护会话"放行。**
 *   `ok:true` + `ageMs:null` = 输入面**可用**、只是（窗口内）没有 `user/message` 事件 ⇒ 不构成 hold。
 *
 * @param {string} sessionId 会话 id（目录名）
 * @param {{home?:string, now?:number, filePath?:string, maxBytes?:number}} opts
 *        `filePath` 可显式指定（单测 / 调用方已扫过）；缺省按 `<home>/sessions/<workspace>/<sid>` 定位。
 * @returns {{ok:boolean, sessionId:string|null, file:string|null, ageMs:number|null, lastAt:number|null,
 *            frames:number, truncated:boolean, error:string|null}}
 */
export function readLastUserMessageAge(sessionId, opts = {}) {
  const sid = normSessionId(sessionId);
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) ? Number(opts.maxBytes) : DEFAULT_POLICY.tailBytes;
  const fail = (error, file = null) => ({ ok: false, sessionId: sid, file, ageMs: null, lastAt: null, frames: 0, truncated: false, error });
  let file = opts.filePath ?? null;
  if (!file) {
    if (!sid) return fail('no-session-id');
    let rec = null;
    try { rec = scanSessionLogFiles(opts.home ?? dshHome()).get(sid) ?? null; } catch (e) { return fail(`scan:${e?.message ?? e}`); }
    file = rec?.filePath ?? null;
    if (!file) return fail('no-session-file');
  }
  let buf; let truncated = false;
  try { const r = readTailBuffer(file, maxBytes); buf = r.buf; truncated = r.truncated; }
  catch (e) { return fail(e?.code ?? `read:${e?.message ?? e}`, file); }
  const offsets = [];
  for (let i = buf.indexOf(ZSTD_MAGIC, 0); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 1)) offsets.push(i);
  if (!offsets.length) return fail('no-frame', file);
  let lastAt = null;
  let frames = 0;
  let newestFrameBad = false;
  // 从**最新帧往回**解：先解出来的 `user/message` 就是最近一条（帧内按行顺序，取最大值兜底）。
  for (let k = offsets.length - 1; k >= 0; k--) {
    const s = offsets[k];
    const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); }
    catch { if (k === offsets.length - 1) newestFrameBad = true; continue; }
    frames++;
    const recs = parseTailJsonLines(text);
    if (!recs.length) { if (k === offsets.length - 1) newestFrameBad = true; continue; }
    for (const r of recs) {
      if (r.type !== host.EV.USER_MESSAGE) continue;
      const t = Number(r.time);
      if (Number.isFinite(t) && (lastAt === null || t > lastAt)) lastAt = t;
    }
    if (lastAt !== null) break;
  }
  // 最新帧读不出来（正在写的半截帧 / 错位）且没拿到任何 user/message ⇒ 输入面**不可用**（不许当成"无输入"）
  if (newestFrameBad && lastAt === null) return { ...fail('newest-frame-bad', file), frames, truncated };
  if (lastAt === null) return { ok: true, sessionId: sid, file, ageMs: null, lastAt: null, frames, truncated, error: null };
  return { ok: true, sessionId: sid, file, ageMs: now - lastAt, lastAt, frames, truncated, error: null };
}

/**
 * **软保护求值**（纯 IO、纯判据；单测入口 J5）—— 把"非卡活跃会话"里最近 `urgentProtectUserInputMs`
 * 内出现过 `user/message` 的挑出来，交给 {@link normalizeSoftProtect} 归一化成三态。
 *
 * 【输入】`sessions` = **`plan.active − cardActive`**（即 `plan.softActive`；见 §3.2 订正注 N-1 的命名统一）。
 * 【三态出口】① 策略键非有限正数 ⇒ `off`（显式关闭，允许执行 + 审计 `softProtectDisabled`）；
 *   ② 全部被检查会话都读得到 ⇒ `on`（`holdSessionIds` 非空 ⇒ 退回 queue）；③ **任一**会话读不到
 *   （文件缺失 / 解帧失败 / 归档走了）⇒ `unavailable` ⇒ 一律退回 queue（fail-safe，见方案 §3.4 红线 4）。
 *   ⚠️ 第 ③ 条**故意偏严**：宁可因一个坏文件多等一个 tick（reason 可见），也不拿"读不到"冒充"没在输入"。
 *
 * @param {Array<{sessionId?:string, file?:string, filePath?:string}>} sessions
 * @param {{home?:string, now?:number, policy?:object, maxBytes?:number}} opts
 * @returns {{mode:'off'|'on'|'unavailable', holdSessionIds:Set<string>, holdCount:number, holdIds:Array<string>,
 *            disabled:boolean, unavailable:boolean, windowMs:number|null, source:string,
 *            checked:number, unavailableIds:Array<string>, unavailableList:Array<object>}}
 */
export function evaluateSoftProtect(sessions, opts = {}) {
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const rows = Array.isArray(sessions) ? sessions : [];
  const v = Number(policy.urgentProtectUserInputMs);
  if (!(Number.isFinite(v) && v > 0)) {
    return { ...normalizeSoftProtect({ mode: 'off' }, policy), checked: 0, unavailableIds: [], unavailableList: [] };
  }
  const hold = new Set();
  const unavailableList = [];
  let checked = 0;
  for (const row of rows) {
    const id = normSessionId(row?.sessionId);
    if (!id) continue;
    checked++;
    const r = readLastUserMessageAge(id, { home: opts.home, now, filePath: row.file ?? row.filePath, maxBytes: opts.maxBytes });
    if (!r.ok) { unavailableList.push({ sessionId: id, error: r.error ?? 'unavailable' }); continue; }
    // 负 ageMs（文件比判定时钟还新 = 刚写完）同样算"刚有输入"：越活跃越不能漏（与 isSessionActive 同口径）。
    if (r.ageMs !== null && r.ageMs < v) hold.add(id);
  }
  if (unavailableList.length) {
    return {
      ...normalizeSoftProtect({ mode: 'unavailable' }, policy),
      checked, unavailableIds: unavailableList.map((x) => x.sessionId), unavailableList,
    };
  }
  return { ...normalizeSoftProtect({ mode: 'on', holdSessionIds: hold }, policy), checked, unavailableIds: [], unavailableList: [] };
}

/**
 * **排队提醒指纹**（方案 §3.8 附修；J7 的幂等键）—— 稳定的**请求集合**指纹。
 *
 * 现状缺陷（§1.3 实测）：`restart-coordinator.mjs` 的 `reminded` 用 `batch.batchId` 作去重键，
 *   而 `mergeBatch()` **每次调用都 `makeBatchId()` 生成新 id** ⇒ 每 tick 都是"新批次" ⇒ 去重永不命中
 *   （2026-09-22 实测 15:14–15:42 **连刷 23 条**「⏳ 排队超 30 分钟」+ 桌宠反复被戳）。
 *
 * 口径：`requestIds` **排序后拼接**。请求集合不变 ⇒ 指纹不变（同一批人只提醒一次，**有意设计**，
 *   信息不丢：面板排队明细实时显示"在等谁/等了多久"）；新请求并入批次 ⇒ 指纹变 ⇒ 视为新一次提醒。
 * ⚠️ 这是**运行键/提醒键**，与去重键 `batchId` **不复用同一字段**（规程 §3.4）。
 *
 * @param {object} input `plan` 或 `batch`（两者都认）
 * @returns {string} 指纹（无 requestIds 时退化为 batchId，绝不返回空串 —— 空串会让去重键互相碰撞）
 */
export function remindFingerprint(input) {
  const batch = input?.batch ?? input ?? {};
  const ids = (Array.isArray(batch.requestIds) ? batch.requestIds : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (ids.length) return [...new Set(ids)].sort().join('+');
  return String(batch.batchId ?? '').trim() || 'unknown-batch';
}

/**
 * 红线断言（J3 口径，供单测强断言与审计扫描共用）：
 *   **任何非 force 批次的打断清单里，不得出现"非发起者"的卡执行会话** ——
 *   集合式写法：`interrupted ∩ 卡执行会话（账本全量） ⊆ {发起者}`（**不是空集**：发起者例外是现状语义，
 *   方案 §3.4 红线 1 / 拍板 ⑤=a；只有主人拍"连发起者也保护"才升级为空集）。
 *
 * 方向默认 **fail-safe**（账本读不到 ⇒ 全判卡会话 ⇒ 更容易报违规）：红线断言宁严勿松 ——
 *   `degraded=true` 时消费方应把它读成"索引不可用导致的报警"，别当成"代码引入的回归"。
 *
 * @param {{interruptions?:Array, cardSessions?:object|Map|Array|Set, cardIndex?:object,
 *          requesterIds?:Array|Set, direction?:'fail-open'|'fail-safe'}} input
 * @returns {{ok:boolean, violations:Array<string>, interrupted:Array<string>, cardSessionIds:Array<string>,
 *            requesterIds:Array<string>, cardIndexOk:boolean, degraded:boolean, checked:number, assert:string}}
 */
export function findInterruptedCardViolations(input = {}) {
  const idx = failSafeCardIndex(input.cardSessions ?? input.cardIndex ?? null, input.direction ?? 'fail-safe');
  const requesterIds = toIdSet(input.requesterIds ?? []);
  const list = Array.isArray(input.interruptions) ? input.interruptions : [];
  const violations = [];
  const interrupted = [];
  const cardSessionIds = [];
  for (const it of list) {
    const id = normSessionId(typeof it === 'string' ? it : it?.sessionId);
    if (!id) continue;
    interrupted.push(id);
    if (idx.isCardSession(id) !== true) continue; // 非卡会话 ⇒ 不涉红线
    cardSessionIds.push(id);
    if (requesterIds.has(id)) continue; // 发起者例外（现状语义）
    violations.push(id);
  }
  return {
    ok: violations.length === 0,
    violations,
    interrupted,
    cardSessionIds,
    requesterIds: [...requesterIds],
    cardIndexOk: idx.ok === true,
    degraded: idx.ok !== true,
    checked: list.length,
    assert: 'interrupted ∩ 卡执行会话（账本全量） ⊆ {发起者}',
  };
}

/**
 * 低水位决策（纯函数，单测入口）。
 * 口径（方案 §4 策略表 + v2.2 修正）：
 *   排除发起者后活跃 = 0 → 立即重启；活跃 ≥ 1 → 排队（不打断任何真活跃会话）。
 *   force 请求 → 跳过等待直接重启（面板「立即强制重启」/ 会话内 --force）。
 * @param {{
 *   requests:Array<object>, sessions:Array<{sessionId:string,active:boolean,tail?:string,mtimeMs?:number,title?:string}>,
 *   now?:number, policy?:object
 * }} input
 */
export function planRestart(input = {}) {
  const policy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
  const now = input.now ?? Date.now();
  const requests = (Array.isArray(input.requests) ? input.requests : []).filter((r) => r && r.state !== 'expired');
  const expired = (Array.isArray(input.requests) ? input.requests : []).filter((r) => r && r.state === 'expired');
  if (!requests.length) {
    return { action: 'none', reason: expired.length ? 'all-expired' : 'no-request', batch: null, active: [], excluded: [], waitingMs: 0, needRemind: false, inFallbackWindow: inFallbackWindow(now, policy), expired };
  }
  const batch = mergeBatch(requests, { now, policy });
  batch.correlationId = batch.batchId;
  const excluded = new Set(batch.excludeIds ?? batch.requesterIds);
  const active = (Array.isArray(input.sessions) ? input.sessions : [])
    .filter((s) => s && s.active === true && !excluded.has(s.sessionId));
  const waitingMs = Math.max(0, now - batch.waitingSince);
  const needRemind = waitingMs >= policy.queueTimeoutMs;
  // ---- 加急档（A1）：有效档位 + 卡/非卡分流 + 软保护三态（纯投影；`normal` 路径逐字不变）----
  //   【A4 前置 · 复审 R-4】档位再经**每日升档上限闸门**（`gateUrgentEscalation`）：达上限/计数器
  //   不可用 ⇒ 升档被拒、`tierEffective` 退回 `tierRequested`（= 退回 queue 档，见 lib 说明）。
  //   `urgentDaily` 缺省 ⇒ 闸门不拦（`reached:false`）⇒ 未接计数器的调用方零行为变更。
  const tier = gateUrgentEscalation(resolveTier({ requests, batch, waitingMs, policy }), {
    policy, urgentDaily: input.urgentDaily ?? null,
  });
  const split = classifyActiveByCard(active, { cardSessions: input.cardSessions ?? input.cardIndex ?? null });
  const softProtect = normalizeSoftProtect(input.softProtect, policy);
  const base = {
    batch, excluded: [...excluded], notifyTargets: batch.requesterIds, active, waitingMs, needRemind,
    inFallbackWindow: inFallbackWindow(now, policy), expired,
    // 加急档投影（A1）：`tierEffective === 'normal'` + 无 urgent 请求时，老路径的 action/reason 逐字不变
    tierRequested: tier.tierRequested, tierEscalated: tier.tierEscalated, tierEffective: tier.tierEffective,
    urgentEscalateMs: tier.escalateMs,
    cardActive: split.cardActive, softActive: split.softActive,
    cardSessionIndexOk: split.cardIndexOk, cardSessionDegraded: split.degraded,
    softProtect,
    // 【A4 前置 · 复审 R-4】每日升档额度（闸门结论 + 当日用量）—— 审计 / 面板 / queueNotice 都读它
    tierEscalationApplied: tier.tierEscalationApplied === true,
    tierEscalationDenied: tier.tierEscalationDenied === true,
    urgentDeniedReason: tier.urgentDeniedReason ?? null,
    urgentDaily: tier.urgentDailyQuota ?? null,
  };
  if (batch.force || tier.tierEffective === 'force') return { ...base, action: 'restart', reason: 'force-request' };
  if (tier.tierEffective === 'urgent') {
    // 加急档：只等**卡执行会话**（红线 1：非发起者的卡会话不打断）；普通会话可打断。
    //   软保护三态：`unavailable` ⇒ 一律 queue（fail-safe）；`off` ⇒ 允许执行；`on` ⇒ 有 hold 就 queue。
    const pre = tier.tierEscalated ? 'escalated-' : 'urgent-';
    if (softProtect.mode === 'unavailable') return { ...base, action: 'queue', reason: 'soft-protect-unavailable' };
    if (split.cardActive.length > 0) return { ...base, action: 'queue', reason: `${pre}waiting-cards=${split.cardActive.length}` };
    if (softProtect.holdCount > 0) return { ...base, action: 'queue', reason: `${pre}hold-user-input=${softProtect.holdCount}` };
    return { ...base, action: 'restart', reason: 'urgent-low-watermark-cards-zero' };
  }
  if (active.length === 0) return { ...base, action: 'restart', reason: 'low-watermark-zero' };
  return { ...base, action: 'queue', reason: `active=${active.length}` };
}

/** 请求是否已过期（24h 未执行自动作废）。 */
export function isRequestExpired(request, now = Date.now(), policy = DEFAULT_POLICY) {
  const exp = Number(request?.expiresAt);
  if (Number.isFinite(exp)) return exp <= now;
  const created = Number(request?.createdAt);
  if (!Number.isFinite(created)) return false;
  return created + (policy.requestTtlMs ?? DEFAULT_POLICY.requestTtlMs) <= now;
}

/** 构造一条重启请求（面板 / 会话内 CLI 共用）。 */
export function makeRequest(input = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const id = input.id ?? makeBatchId(now);
  return {
    id,
    correlationId: id,
    mode: input.mode === 'force' ? 'force' : 'queue',
    // 【加急档 · A1】请求档位（`normal` | `urgent` | `force`）；缺省 `normal` = 零行为变更。
    //   ⚠️ 这里只登记字段；判定在 `planRestart()`（`tierRequested` = 批次内最高档；`batch.force` 仍优先）。
    priority: normalizeTier(input.priority),
    requester: {
      kind: input.requester?.kind ?? 'cli',
      sessionId: input.requester?.sessionId ?? null,
      // 自动来源的发起组件名（裸跑期拒绝 kind:'auto'，见 request-restart.mjs 闸门）
      ...(input.requester?.actor ? { actor: String(input.requester.actor).slice(0, 80) } : {}),
    },
    reason: String(input.reason ?? '').slice(0, 200),
    createdAt: now,
    expiresAt: now + policy.requestTtlMs,
    state: 'pending',
    batchId: null,
  };
}

// ------------------------------------------------------------------ ③ 维护窗口

/** 构造维护窗口记录（写 ~/.dsh/butler-maintenance.json）。 */
export function makeMaintenanceWindow(input = {}) {
  const now = input.now ?? Date.now();
  const policy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
  const windowMs = Number(input.windowMs) || policy.maintenanceWindowMs;
  return {
    schemaVersion: MAINTENANCE_SCHEMA,
    mode: 'restart',
    correlationId: input.correlationId ?? null,
    startedAt: now,
    until: now + windowMs,
    reason: String(input.reason ?? 'dsh restart (butler coordinator)').slice(0, 200),
  };
}

/** 写维护窗口（原子写；home 可注入便于单测）。 */
export function writeMaintenanceWindow(win, opts = {}) {
  const file = resolveStatePath('butler-maintenance.json', { home: opts.home }).path;
  const dw = writeStateText('butler-maintenance.json', JSON.stringify(win, null, 2) + '\n', {
    home: opts.home, write: (p, t) => writeTextAtomic(p, t),
  });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return { ok: true, file };
}

/** 读维护窗口（无窗口 → null）。 */
export function readMaintenanceWindow(opts = {}) {
  const file = resolveStatePath('butler-maintenance.json', { home: opts.home }).path;
  try {
    return readJson(file, { schemaVersion: MAINTENANCE_SCHEMA, home: opts.home, defaultValue: null });
  } catch {
    return null; // 版本不符/损坏 → 视为无窗口（fail-open 只影响静默，不影响重启）
  }
}

/** 清维护窗口（幂等）。 */
export function clearMaintenanceWindow(opts = {}) {
  const file = resolveStatePath('butler-maintenance.json', { home: opts.home }).path;
  try {
    if (!removeGuarded(file, { whitelist: [path.dirname(file)], reason: '清维护窗口' })) {
      return { ok: false, file, error: '被 R-065 三件套拒绝（未删除）' };
    }
    return { ok: true, file, removed: true };
  } catch (e) {
    return { ok: false, file, error: e?.message ?? String(e) };
  }
}

/**
 * 维护窗口阶段判定（纯函数，单测入口）。
 * @param {object|null} win
 * @param {{now?:number, ready?:boolean}} [opts] ready = 「3080 可连 + 一次成功 RPC」探测结果
 * @returns {{phase:'none'|'pending'|'overdue'|'cleared', expired:boolean, remainingMs:number|null, win:object|null}}
 */
export function maintenancePhase(win, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!win || win.mode !== 'restart') return { phase: 'none', expired: false, remainingMs: null, win: null };
  const until = Number(win.until) || 0;
  const expired = until > 0 && now >= until;
  if (opts.ready === true) return { phase: 'cleared', expired, remainingMs: Math.max(0, until - now), win };
  if (expired) return { phase: 'overdue', expired: true, remainingMs: 0, win };
  return { phase: 'pending', expired: false, remainingMs: Math.max(0, until - now), win };
}

/** 就绪判据：3080 可连 + 一次成功 RPC（方案 §4 v2.2 补）。 */
export function isReady(probe = {}) {
  return probe.portReachable === true && probe.rpcOk === true;
}

// ------------------------------------------------- ④b 旁路通知名单（D17 / 2026-09-23）

/**
 * 会话活动时间补充源（**D17 旁路通知专用；不参与活跃判定**）。
 *
 * 背景（2026-09-23 真机取证，dry-run 首跑就暴露）：主包 0.1.5 起会话日志文件名换代为
 * `session.v3.jsonl.zstd`，而 `collectSessions` / `isSessionActive` 只认旧的 `session.jsonl.zstd`。
 * 生产实测：54 个会话目录 → **28 个含旧文件（mtime 全部停在约 9 小时前的批量写入）**、
 * **53 个含 `session.v3.jsonl.zstd`（正在写，本会话 0.03 分钟前）**。⇒ 只听旧文件取"近窗活动"
 * 恒为空（真机 dry-run：`scanned=28 inWindow=0`），旁路通知等于没做。
 *
 * 本函数按会话目录取**同族日志文件的最新 mtime**（`session.jsonl.zstd` 与 `session.v3.jsonl.zstd`
 * 都看，取 max）——同一事件源、同一 `ageMs = now - mtimeMs` 语义，不新增任何"活跃/不活跃"判据。
 *
 * ⚠️ 输出**只喂给旁路名单**（`selectStaleWaitSessions`）：`isSessionActive` / `mergeActiveSources` /
 * 低水位 / `force` 语义一概不动。
 *
 * 【口子已做 · 2026-09-24 「修·V3判据①」】本节原先收尾一句「把活跃判据本身切到 v3 是另一件事
 * （跨判据改动，需独立审核）」——**那件事已做**：`restart-coordinator.mjs#scanSessionDirs`
 * （活跃判定文件源）改走下面的 `scanSessionLogFiles` 同一实现。本函数语义未变，仍是旁路通知源。
 *
 * @param {string} home DSH home
 * @returns {Map<string, {mtimeMs:number, file:string}>} sessionId → 最新日志文件的 mtime 与文件名
 */

/**
 * 扫描 `<home>/sessions/<workspace>/<sessionId>/`，**每个会话目录取"当前那一份"会话日志**
 * （`pickSessionFileInDir`：认全世代 —— 旧名 `session.jsonl.zstd` / 当前名 `session.v3.jsonl.zstd` / 未来 vN；
 *   mtime 最新 → 平局取代际大者 → 再平局字典序小者）；一个族名都不存在才跳过该目录。
 * 返回带全路径与 size，供两个投影各取所需。
 *
 * 【为什么必须取"族内最新"】生产实测（2026-09-23/24）：会话目录里**只有** `session.v3.jsonl.zstd`
 * 在写，旧名文件的 mtime 停在换代前的批量写入时刻 ⇒ 只听旧名 = 把此刻正在跑的会话看成 9 小时前。
 *
 * ⚠️ 族名判据与"挑哪一份"的**实现全部在生态单一真源** `tools/lib/session-file-name.mjs`
 *    （`tools\dsh-butler\lib\pitfall-scan.mjs` 同款 import）；本文件不另写正则、不复制平局规则。
 *
 * @param {string} home DSH home
 * @returns {Map<string, {sessionId:string, workspace:string, dir:string, fileName:string, filePath:string, mtimeMs:number, size:number}>}
 */
export function scanSessionLogFiles(home) {
  const out = new Map();
  let workspaces = [];
  try { workspaces = fs.readdirSync(path.join(home, 'sessions'), { withFileTypes: true }); } catch { return out; }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(home, 'sessions', ws.name), { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(home, 'sessions', ws.name, d.name);
      const filePath = pickSessionFileInDir(dir); // 唯一源：认全世代 + 只认文件 + 确定性挑"当前那份"
      if (!filePath) continue;
      let st;
      try { st = fs.statSync(filePath); } catch { continue; /* 竞态：刚被删/改名 → 跳过该目录（不抛） */ }
      out.set(d.name, {
        sessionId: d.name, workspace: ws.name, dir,
        fileName: path.basename(filePath), filePath, mtimeMs: st.mtimeMs, size: st.size,
      });
    }
  }
  return out;
}

/** 会话活动时间源（旁路通知用）= `scanSessionLogFiles` 的**投影**（只保留 mtime 与文件名）。 */
export function scanSessionActivityTimes(home) {
  const out = new Map();
  for (const rec of scanSessionLogFiles(home).values()) out.set(rec.sessionId, { mtimeMs: rec.mtimeMs, file: rec.fileName });
  return out;
}

/**
 * 旁路通知名单（纯函数，单测入口）。
 *
 * 【为什么需要它】闸门的通知目标原本 = **被打断会话** ∪ **请求发起者**，而「被打断」判据 =
 * **重启瞬间的活跃集合**（回合未闭合 `file` / 主包 `agent-running` / 看板 `board-card` 三源并集）。
 * **回合间隙里等通知、等卡完成的会话三源全不命中**（没有回合在跑 ⇒ 不算活跃）⇒ 既不在打断名单、
 * 也不像发起者那样收完成回执 ⇒ **一条通知都收不到**，被打断后静默停摆。
 * 实测（2026-09-22 01:31:56 批次 `rst-20260922173156-1vsl`）：审计 `interrupted:[]`、
 * 通知目标只有两个发起者，而主会话当时正等 L-2 验收通知，**静默 6.5 小时无人知**。
 *
 * 【本函数只做加法】从**同一批**会话扫描结果里挑出「重启前 N 毫秒内有过活动」的会话，
 * 交给重启后的补发通知多播一条提醒。**不改活跃判据、不改低水位、不改 force 语义、
 * 不改 `buildInterruptionList` 的 interrupted 口径**（本卡是纯加法）。
 *
 * 【判据：与 `isSessionActive` 同源，只放宽时间窗】——不另造第二套会话状态判定。
 * 数据源 = 同一次 `collectSessions()` 的同一批行（同一个 `now`、同一个 mtime）：
 *   - `ageMs < policy.staleWaitNoticeMs` 才进名单；**负值（文件比判定时钟还新 = 刚写完）同样计入**
 *     （与 `isSessionActive` 的"越活跃越不能漏"同口径）；
 *   - 会话必须存在（有 sessionId）且能验证新鲜度（拿不到 mtime 的行不进：无法验证 = 可能已死）；
 *   - **排除已另有通知的会话**（`excludeIds` = 打断名单 ∪ 批次发起者）——防同一会话收两条；
 *   - 同一会话只出现一次（按归一化 id 去重）。
 *
 * 【宁多勿漏】判据边界上倾向多通知一条（多一条提醒无害；漏一条 = 会话静默停摆）。
 * 【fail-open】调用方必须把它包在 try/catch 里：算失败只**少发**通知（审计一条 `staleWaitError`），
 * 绝不允许影响重启主流程。
 *
 * 【卡执行会话豁免（2026-09-23 · 主人拍板）】**已结算的卡执行会话不进旁路名单**：
 *   判据取自唯一源 `card-session.mjs`（账本 `tasks[].executions[].sessionId` + 卡 `status ∈ {done, review, failed}`）。
 *   为什么：那份活已经闭环（卡进 done/review/failed），再发一条「你在等的东西可能失效了」是纯噪声。
 *   ⚠️ **fail-open**：`opts.cardSessions` 没给 / 索引 `ok:false`（账本读不到）⇒ **一个都不排除**
 *      （保持改动前语义：宁可多通知，不可静默少通知）。
 *   ⚠️ 本函数仍然只是"多挑一路通知目标"：活跃判据 / 低水位 / force 语义 / interrupted 口径一字不动。
 *
 * @param {Array<{sessionId:string,title?:string,mark?:string,state?:string,ageMs?:number,mtimeMs?:number}>} sessions
 *        与活跃判定**同一批**扫描结果（`collectSessions()` / `mergeActiveSources().sessions`）
 * @param {{now?:number, policy?:object, excludeIds?:Array|Set, cardSessions?:object}} opts
 *        `cardSessions` = 卡执行会话索引（`loadCardSessionIndex()` 的产物；缺省 ⇒ 不排除任何人）
 * @returns {{enabled:boolean, windowMs:number, list:Array<object>, stats:object}}
 */
export function selectStaleWaitSessions(sessions, opts = {}) {
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const rawWindow = Number(policy.staleWaitNoticeMs ?? DEFAULT_POLICY.staleWaitNoticeMs);
  const windowMs = Number.isFinite(rawWindow) ? rawWindow : DEFAULT_POLICY.staleWaitNoticeMs;
  const enabled = windowMs > 0;
  const exclude = toIdSet(opts.excludeIds ?? []);
  // 【本卡】卡执行会话索引（唯一源 card-session.mjs）；拿不到 ⇒ ok:false ⇒ 不排除任何人（fail-open）
  const cardIdx = asCardSessionIndex(opts.cardSessions);
  const base = {
    windowMs, enabled, scanned: 0, inWindow: 0, notified: 0,
    excludedNotified: 0, outsideWindow: 0, noMtime: 0, noSession: 0, duplicate: 0,
    excludedIds: [],
    // 【本卡 · 通知面卡会话豁免】单独计数，便于前后对照与复盘（不改既有键的语义）
    settledCardSessions: 0, settledCardIds: [], cardSessionsInList: 0,
    cardSessionIndex: {
      ok: cardIdx.ok, count: cardIdx.count, settledCount: cardIdx.settledCount,
      source: cardIdx.source, error: cardIdx.error ?? null,
    },
  };
  if (!enabled) {
    return { enabled: false, windowMs, list: [], stats: { ...base, reason: 'staleWaitNoticeMs=0 → 本路通知关闭' } };
  }
  const seen = new Set();
  const list = [];
  const stats = { ...base };
  // 内部防护上限（不是策略键）：窗口内会话异常多时防通知风暴；50 ≈ 既有 maxRequests 量级，正常够用
  const MAX_LIST = 50;
  for (const row of Array.isArray(sessions) ? sessions : []) {
    stats.scanned++;
    const id = normSessionId(row?.sessionId);
    if (!id) { stats.noSession++; continue; }          // 会话不存在 → 排除
    if (seen.has(id)) { stats.duplicate++; continue; } // 同一会话只发一条
    seen.add(id);
    if (exclude.has(id)) { stats.excludedNotified++; stats.excludedIds.push(id); continue; } // 已另有通知 → 去重
    const ageMs = row?.ageMs;
    if (!Number.isFinite(ageMs)) { stats.noMtime++; continue; } // 无 mtime（无会话文件 / 可能已死）→ 不进
    if (!(ageMs < windowMs)) { stats.outsideWindow++; continue; } // 窗口外（老会话）→ 不进
    // 【本卡 · 通知面卡会话豁免】已结算的卡执行会话 → 不进旁路名单（活已闭环，再提醒是纯噪声）
    //   ⚠️ fail-open：`cardIdx.ok === false`（没给索引 / 账本读不到）时 isSettledCardSession 恒 false ⇒ 不排除
    if (isSettledCardSession(id, cardIdx)) {
      stats.settledCardSessions++;
      stats.settledCardIds.push(id);
      continue;
    }
    if (cardIdx.ok && cardIdx.isCardSession(id)) stats.cardSessionsInList++; // 未结算的卡会话照旧进（不误伤）
    if (list.length >= MAX_LIST) { stats.truncated = (stats.truncated ?? 0) + 1; continue; }
    stats.inWindow++;
    list.push({
      sessionId: id,
      // 【本卡】名单内条目是否卡执行会话（未结算的卡会话会进来，标记出来便于复盘；索引不可用 → null）
      cardSession: cardIdx.ok ? cardIdx.isCardSession(id) : null,
      title: row?.title ?? '',
      mark: row?.mark ?? null,
      state: row?.state ?? null,
      ageMs,
      idleMs: Math.max(0, Number(ageMs) || 0),
      // 快照证据：为什么它进名单（复盘用，不是文案必需字段）
      why: `ageMs=${Math.round(Number(ageMs) / 1000)}s < 窗口 ${Math.round(windowMs / 1000)}s`,
    });
  }
  stats.notified = list.length;
  return { enabled: true, windowMs, list, stats };
}

/**
 * 旁路通知文案（重启前 N 分钟内有活动、但重启瞬间没在跑的会话）。
 * ⚠️ 必须与 `interruptionNotice` **措辞区分**：后者是「你被打断了（尾巴停在 X）」，
 * 本条是「你没有被打断，但你在等的东西可能已经失效」——混用会误导主人/会话去"续做被中断的活"。
 */
export function staleWaitNotice(batch, entry, opts = {}) {
  const who = entry?.title ? `「${entry.title}」` : (entry?.sessionId ? String(entry.sessionId).slice(0, 16) : '本会话');
  const raw = Number(opts.windowMs ?? batch?.staleWaitWindowMs ?? DEFAULT_POLICY.staleWaitNoticeMs);
  const mins = Math.max(1, Math.round((Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLICY.staleWaitNoticeMs) / 60_000));
  return [
    `ℹ️ DSH 刚完成一次闸门重启（批次 ${batch?.batchId ?? '?'}）。`,
    '',
    `你在重启前 ${mins} 分钟内有活动（${who}），但重启那一刻**没有回合在跑** —— 所以这条**不是**「你被硬杀了」，而是一次自查提醒：`,
    '- 如果你正在等某个通知 / 某张看板卡完成 / 某个外部回执：**那次等待可能已经失效**（等待的另一端也可能被这次重启打断了）；',
    '- 请自查一次再继续：需要就自己重新发起等待，或直接接着干。',
    '',
    '重启原因：' + ((batch?.reasons ?? []).join('；') || '主人请求'),
    '本条为自动通知，无需回复。',
  ].join('\n');
}

// ------------------------------------------------------------------ ④ 打断清单

/**
 * 重启前快照：谁被打断、尾巴停在哪（重启后多播通知用）。
 * @param {Array<{sessionId:string,title?:string,tail?:string,lastType?:string,ageMs?:number,turn?:number,step?:number}>} sessions
 */
export function buildInterruptionList(sessions, opts = {}) {
  const now = opts.now ?? Date.now();
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.sessionId)
    .map((s) => ({
      sessionId: s.sessionId,
      title: s.title ?? '',
      // 标题状态标记（【运行】/【完成】）——展示与审计用，不参与低水位判定
      mark: s.mark ?? null,
      tailLabel: s.tail ?? '尾巴停在未知事件',
      lastType: s.lastType ?? null,
      activeForMs: Number.isFinite(s.ageMs) ? s.ageMs : null,
      snapshotAt: now,
    }));
}

/** 通知文案（重启完成 → 被打断会话）。 */
export function interruptionNotice(batch, entry) {
  const who = entry?.title ? `「${entry.title}」` : entry?.sessionId?.slice(0, 16) ?? '本会话';
  // 【加急档 · A2】档位可见（方案 §3.6）：`normal` / `force` 档输出**逐字不变**（零回归）。
  const tier = normalizeTier(batch?.tier);
  const lines = [
    `🔄 DSH 已按管家重启统筹完成重启（批次 ${batch?.batchId ?? '?'}）。`,
    '',
    `会话 ${who} 在重启时正在执行回合，已被硬杀打断：`,
    `- ${entry?.tailLabel ?? '尾巴停在未知事件'}`,
    ...(tier === 'urgent'
      ? ['', `本次为**加急**档（只等卡执行会话${batch?.escalated === true ? '，且由排队超时**自动升档**' : ''}）—— 卡执行会话一律不打断，被打断的都是普通会话。`]
      : []),
    '',
    '重启原因：' + ((batch?.reasons ?? []).join('；') || '主人请求'),
    '如需继续，直接发一句话即可接着干；本条为自动通知，无需回复。',
  ];
  return lines.join('\n');
}

/** 重启完成通知（无被打断会话时发给发起者——让"请求方"确知重启已执行）。 */
export function completionNotice(batch, opts = {}) {
  const n = Number(opts.interruptedCount ?? 0);
  const parts = ['管家统筹', `批次 ${batch?.batchId ?? '?'}`];
  if (opts.requesterLabel) parts.push(`发起者：${opts.requesterLabel}`);
  // 【加急档 · A2】档位可见（方案 §3.6）：`normal` / `force` 档输出**逐字不变**（零回归）。
  const tier = normalizeTier(opts.tier ?? batch?.tier);
  const escalated = opts.escalated === true || batch?.escalated === true;
  if (tier === 'urgent') parts.push(`加急档${escalated ? '（排队超时自动升档）' : ''}`);
  const lines = [
    `✅ DSH 已按请求重启完成（${parts.join(' · ')}）。`,
    n > 0 ? `本次打断 ${n} 个正在跑的会话，它们各自收到了「尾巴停在 X」通知。` : '本次重启没有打断任何正在跑的回合（发起时排除请求方后活跃会话为 0）。',
  ];
  if (tier === 'urgent') {
    const mins = Math.round(Number(opts.waitingMs ?? batch?.waitingMs ?? 0) / 60000);
    const held = Number(opts.heldForUserInput ?? batch?.heldForUserInput ?? 0);
    lines.push(`加急档说明：只等卡执行会话（不打断别人在跑的卡）；本次打断 ${n} 个非卡会话，自请求起等待约 ${mins} 分钟${held > 0 ? `；另有 ${held} 个会话因"最近有用户输入"被豁免过（软保护）` : ''}。`);
  }
  lines.push('原因：' + ((batch?.reasons ?? []).join('；') || '主人请求'), '本条为自动通知，无需回复。');
  return lines.join('\n');
}

/** 排队状态文案（面板 / 提醒用）。 */
export function queueNotice(plan) {
  const active = plan?.active ?? [];
  const mins = Math.round((plan?.waitingMs ?? 0) / 60000);
  // 【加急档 · A1】档位可见（"为什么还在等"一眼看清）：**normal 档输出逐字不变**
  const tier = plan?.tierEffective ?? 'normal';
  const cardIds = tier === 'urgent'
    ? new Set((plan?.cardActive ?? []).map((s) => s?.sessionId).filter(Boolean))
    : new Set();
  const srcLabel = (s) => {
    const src = String(s?.activeSource ?? '');
    if (src.includes('board-card')) return '看板卡执行中';
    if (src.includes('agent-running')) return '主包 running';
    return s?.tail ?? '执行中';
  };
  const head = tier === 'urgent'
    ? (plan?.tierEscalated
      ? `⏳ 重启请求已排队 ${mins} 分钟（⚡ 已自动升档到加急档：只等 ${plan?.cardActive?.length ?? 0} 个卡执行会话；${plan?.softActive?.length ?? 0} 个普通会话可打断）：`
      : `⚡ 加急档排队中 ${mins} 分钟（只等 ${plan?.cardActive?.length ?? 0} 个卡执行会话；${plan?.softActive?.length ?? 0} 个普通会话可打断）：`)
    : `⏳ 重启请求已排队 ${mins} 分钟（等 ${active.length} 个活跃会话收尾）：`;
  // 【加急档 · A2】**降级可见**（复审 R-1② + 方案 §3.4 红线 4「禁止静默」）：
  //   "加急档为什么不动"必须一眼可见 —— 软保护输入面不可用 / 卡会话索引退化，两条都要显式说。
  //   ⚠️ 只在**加急档**下追加：`normal` 档输出继续**逐字不变**（零回归，见 test-urgent-tier §9 用例）。
  const notes = [];
  if (tier === 'urgent') {
    const sp = plan?.softProtect;
    if (sp?.mode === 'unavailable') notes.push(`⚠️ 当前**无输入保护**（输入面不可用：${sp?.source ?? 'unknown'}）⇒ 本轮不执行加急、一律退回排队（审计 \`softProtectUnavailable=true\`）—— 宁可多等，也不打断主人正在打字的会话。`);
    else if (sp?.mode === 'off') notes.push('⚠️ 软保护已**显式关闭**（`urgentProtectUserInputMs` 非有限正数）⇒ 不检查"主人是否正在输入"（审计 `softProtectDisabled=true`）。');
    if (plan?.cardSessionDegraded === true) notes.push('⚠️ 卡执行会话索引**不可用**（账本读不到）⇒ 按 fail-safe **一律判为卡执行会话**：宁多等一分钟，也不打断真在跑的卡（审计 `cardSessionDegraded=true`）。');
  }
  return [
    head,
    ...active.slice(0, 8).map((s) => `- ${s.title ? `「${s.title}」` : String(s.sessionId).slice(0, 16)}：${srcLabel(s)}${cardIds.has(s.sessionId) ? '（卡执行会话 · 不可打断）' : ''}`),
    ...(notes.length ? ['', ...notes] : []),
    '',
    '选项：① 继续等（活跃会话结束后自动重启）② 面板点「立即强制重启」③ 忽略',
  ].join('\n');
}
