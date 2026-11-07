// dsh-butler / lib/autonomy-actions.mjs —— P3 自动动作统一闸门 + 护栏（分级 / 去重 / 上限 / 预算）
//
// 方案：docs/ §4 P3
//   「自动执行护栏（L1/L2 也必须遵守）」：
//     ① 裸跑期门槛：P3 自动化开关默认关闭（统一由 lib/autonomy.mjs 的 p3AutoEnabled 控制）
//     ② 自动动作去重（同签名 24h 内只处理一次）
//     ③ 每日次数上限（maxAutoActionsPerDay: 5，达上限停并记日志）
//     ④ token 预算上限（超限 → 不再启动新自动动作；**不强杀已在跑的会话**）
//     ⑤ 只对分级表内 L1/L2 自动执行，L3 一律通知 / 预览确认
//
// **本模块是「自动动作」的唯一闸门**：任何 auto kind 的写操作必须经过 runAction()。
// 裸跑期（四把开关全关）语义：dryRun=false 的调用一律被 blocked，且**不留任何副作用**
//   （不写去重记录、不占每日额度 —— 「被闸门挡住」不是一次自动动作）。
// dryRun=true 永远可用：只算不动，输出"将要做什么"，供裸跑观测与交付验收取证。
//
// ❗ 2026-09-13（G7 · V3 批次 6）：新增**第 0 道闸 = L0 降档**（唯一真相源 lib/autonomy-state.mjs）——
//   `level=degraded`（含缺文件/损坏 fail-safe）→ 一律 blocked 且**零副作用**；
//   位置固定在 dry-run 通道**之后**（观测不受降档影响）、去重/上限/预算记账**之前**
//   （被降档挡住 ≠ 一次自动动作：不写签名、不占每日额度）。
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { readJson } from './store.mjs';
import { updateStateJson } from './dual-write-store.mjs';
import { appendStateText } from './dual-write.mjs';
import { appendAudit } from './audit.mjs';
import { alert } from './alert.mjs';
import { autoAllowed, describeAutonomy } from './autonomy.mjs';
import { checkAutonomyAllowed } from './autonomy-state.mjs';
import { checkComponent } from './version.mjs';
import { sha256 } from './dup-cards.mjs';

// 版本随组件 `butler-auto` 走：**改这里必须同步 lib/version.mjs 的 COMPONENT_VERSIONS['butler-auto']
//   与 butler-auto-tick.mjs 的 AUTO_TICK_VERSION / butler-auto-cli.mjs 的 VERSION**，否则
//   checkComponent 会把整条组件判为 version-mismatch → runAction 全部 skip（2026-09-13 实测踩到）。
//   且三者必须都等于 product.mjs 的 PRODUCT_VERSION（`verify.mjs` 的不变量：组件版本 == 产品版本）。
export const AUTONOMY_ACTIONS_VERSION = '0.1.0';
export const ACTIONS_SCHEMA = 1;

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-*.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

export const ACTIONS_FILE = 'butler-auto-actions.json';
export const LIMITS_FILE = 'butler-autonomy-limits.json';
// ⑥-1 · ⑥ 包 §3.4-P1 / §8 额度降级台账（append-only JSONL 单行/次；登记见 lib/state-files.mjs ②-1：schemaVersion 1 · persistent · append-only · sync:false）。
export const QUOTA_LEDGER_FILE = 'butler-quota-ledger.jsonl';
export const QUOTA_LEDGER_SCHEMA = 1;
// 【施工卡 ⑥-3 · ⑥ 包 §3.4-P2「分池 + 保底」】额度降级 gate 值域（台账 `gate` 字段）：
//   `quota-day` 生态池/全局日额度 · `quota-kind` kind 池上限 · `quota-reserve` 保底预留挡住 ·
//   `quota-pool` 服务面独立池 · `quota-tick` 单轮并发上限（**由 planner 打，不由本模块派生**）。
export const QUOTA_GATES = Object.freeze(['quota-day', 'quota-tick', 'quota-kind', 'quota-pool', 'quota-reserve']);

/** 组件名（版本自检用；登记在 lib/version.mjs 的 COMPONENT_VERSIONS）。 */
export const COMPONENT = 'butler-auto';

/**
 * 后果严重度分级表（主人 2026-09-09 拍板：分界是"后果严重度"，不是"机械/成本"）。
 * 判定口诀：会丢东西的、要主人拿主意的 → 留给人；不丢东西的 → 管家自己干。
 */
export const LEVELS = {
  L1: { id: 'L1', auto: true, reversible: true, label: '🟢 无害可逆', rule: '做错也毫发无损，随时还原 → 全自动 + 审计留痕' },
  L2: { id: 'L2', auto: true, reversible: true, label: '🟡 有损可回滚', rule: '动数据但有一键恢复兜底 → 自动执行 + 强制留备份' },
  L3: { id: 'L3', auto: false, reversible: false, label: '🔴 可能丢 / 难撤销', rule: '删了就没 / 影响主人决策 → 只通知 / 预览确认，绝不自动' },
};

/**
 * 动作注册表（kind → 分级 + 说明）。
 * **必须与 lib/autonomy.mjs 的 AUTO_KINDS('p3-auto') 对齐**：本表里 auto:true 的动作，
 * 执行前一律经 autoAllowed('p3-auto') 总闸。
 *
 * 【2026-09-17 施工卡 ②-1（② 准入表地基包 A-1）】本表是 **action 域的权威载体**，每行新增三个
 *   准入域字段（`moduleId` / `moduleKind` / `domain`，family 行另有 `familyWhy`，none 行另有 `moduleWhy`）：
 *   · `moduleKind: 'own'`    = 有**同名** L2 模块行（该模块可单独关；`moduleId === kind`）
 *   · `moduleKind: 'family'` = **无**同名 L2 模块行，随某族总闸（矩阵 §3 该行「干系 L2 模块」列已如此声明）
 *   · `moduleKind: 'none'`   = L3 永不自动执行 ⇒ 无模块归属（`moduleId` 显式 null + `moduleWhy` 写理由）
 *   · `domain`               = `'ecosystem'`（生态自治）/ `'service'`（服务面：`offSwitch`/`auditStream`/`quota` 三字段）
 *   ⚠️ **声明 ≠ 判定**：真实放行读的是模块行的 `owner`（L1 键）+ `runAction()` 恒查的 `p3-auto` 总闸
 *      （见 lib/autonomy-modules.mjs 的「L1 归属口径」）。本三字段只作**声明与跨表校验**，一行都不改闸门行为。
 *   ⚠️ 判据唯一源 = `lib/registry-audit.mjs`（只读校验器，零差集为通过）；本表**增加字段但不增加登记点**。
 */
// ============================================================ 【施工卡 ②-6 · ② 包 A-7「maxAffected 登记」】
// 每行新增 `guard` 声明字段（v2 方案 §3.6.5「爆炸半径与回滚验证」的注册表形态）：
//   · `maxAffected` : number = 单次执行允许多少个对象（超限必须拒绝并提示分批）；**null = 非批量动作（不适用）**
//   · `allowBatch`  : 主人强制批量（`forced`）通路是否已实现 —— **当前一律 false = 尚无通路**
//   · `guardWhy`    : 取值依据（**仅 `maxAffected` 非 null 的行必填**）
// ⚠️ **本次只登记、不实现校验**（② 包 §3.7 + §13 Non-goal；主人 2026-09-17 B12 口径）：
//   `runAction()` 里**没有** `affectedCount ≤ maxAffected` 断言、**没有** `allowBatch` 放开路径 ——
//   **登记 ≠ 有护栏**。放行前置判据 = 批量类动作**进放行流程前**必须先实现
//   「`affectedCount ≤ maxAffected` 校验 + `allowBatch` 通路 + 超限拒绝单测」
//   （v2 方案 §3.6.5 + 矩阵 §3 这两行的「护栏 / 放行判据」列已同步写明）。
//   【订正注 · 2026-10-11 · 卡「冲刺600·开发批八」· 本注不改上面五行的历史事实，只标现值】
//     ↑ 上面五行的**前四条已过期**：卡「冲刺600·补核心库」gap-1-08（2026-10-10）已真实现
//     `runAction()` 的爆炸半径护栏 —— 闸门 **6.5 执行前预判**（取值口 `maxAffectedOf(kind)`，不再采信调用方自报；
//     超限 ⇒ `blocked` + 零副作用 + 审计 `auto-action-radius{result:'blocked'}`）+
//     闸门 **6.6 执行后复核**（动作体自报 `affectedCount` 越界 ⇒ `failed` + 审计 `result:'exceeded'`）。
//     仍然成立的只有 `allowBatch` 那一半：**全表一律 `false`，放开路径仍未做**。
//     单测已同步翻转：`_test\test-registry-audit.mjs`「runAction **有** affectedCount 护栏（gap-1-08 落地…）」。
//     ⇒ **勿再据上面五行判「自动动作执行层无护栏」**（域档 I#10 的旧判定即由此产生）。
// 判据唯一源 = `lib/registry-audit.mjs` 的 **A8**（声明齐备 + 取值域 + 批量类必须填数）。
export const AUTO_ACTION_KINDS = {
  'dup-cards-merge': {
    level: 'L1', label: '重复卡合并（挂备注 + 清 schedule，不删卡）', reversible: true,
    moduleId: 'p3-auto', moduleKind: 'family',
    familyWhy: '看板线 P3 老范式四件之一：无同名 L2 模块行，随 p3-auto 整族总闸（矩阵 §3 该行「干系 L2 模块」列已如此声明）',
    domain: 'ecosystem',
    guard: { maxAffected: 4, allowBatch: false, guardWhy: '看板重复卡合并：单轮最多处理 4 张 —— 与运行时单批上限 `lib/dup-cards.mjs#DUP_MAX_AFFECTED_DEFAULT`（=4）对齐（2026-09-27 主人拍板第 6 条①；依据 = 观察期复盘零撞限 ⇒ 4 够用，不放宽到 10）。原声明 10（v2 方案 §3.6.5「合并卡 ≤10」）是设计上限，实现取更保守值；两侧由校验器 A9 机械比对（防再漂）' },
  },
  'evidence-precheck': {
    level: 'L1', label: '待验收证据预检（只读，标 🟡 证据缺失）', reversible: true,
    moduleId: 'p3-auto', moduleKind: 'family',
    familyWhy: 'P3 老范式四件之一（AUTO_JOBS 短名 precheck）：无同名 L2 模块行，随 p3-auto 整族总闸',
    domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  'archive-retry': {
    level: 'L2', label: '归档出错自动重试（一次，不无限重试）', reversible: true,
    moduleId: 'p3-auto', moduleKind: 'family',
    familyWhy: 'P3 老范式四件之一（AUTO_JOBS 短名 archive）：无同名 L2 模块行，随 p3-auto 整族总闸',
    domain: 'ecosystem',
    guard: { maxAffected: 50, allowBatch: false, guardWhy: '归档出错重试：单轮最多 50 张（v2 方案 §3.6.5「归档 ≤50」）' },
  },
  // 2026-09-13 批次 2（矩阵 §3.1 待实现清单第 1 项）：实现 = lib/queue-wake.mjs；
  //   干系 L2 模块 = 同名 `queue-wake`（modules['queue-wake']，baseline=false 默认关）；
  //   **未放行**：dry-run 通道可跑（影子视图可见），四门全关时任何执行一律 blocked。
  'queue-wake': {
    level: 'L1', label: '队列推进自动叫醒（待验收卡叫醒空闲会话；只叫 idle、running 只排队、滞留 30min 升级一次）', reversible: true,
    moduleId: 'queue-wake', moduleKind: 'own', domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  // 2026-10-10（卡「卡死会话自愈链」）：实现 = lib/stuck-recovery.mjs；
  //   干系 L2 模块 = 同名 `stuck-recovery`（modules['stuck-recovery']，baseline=false 默认关）。
  //   动作语义 = **只注入提醒文本**（queue 第 1 次 / steer 第 2 次 / 重启后补注入）——
  //   不改会话数据、不改看板、不改配置 ⇒ 误提醒忽略即可，无数据变更（故 L1 = 无害可逆）。
  //   ⚠️ 本 kind **不含重启**：重启不自建通道，走既有 `p0-auto-restart`（低水位判定 + 24h 去重 + 通道闸全在它那）。
  'stuck-recovery': {
    level: 'L1', label: '卡死会话自愈链·注入跳（回合未闭合 + 长时间无新事件 ⇒ 给该会话本身投提醒文本；每会话每天 2 次）', reversible: true,
    moduleId: 'stuck-recovery', moduleKind: 'own', domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  // 2026-09-13 批次 4（矩阵 §3.1 待实现清单第 4 项）：实现 = lib/p0-auto-restart.mjs（真实通道 = 既有
  //   `request-restart.mjs --as-auto --actor p0-auto-restart`，不新建第二条重启路径）；
  //   干系 L2 模块 = 同名 `p0-auto-restart`（modules['p0-auto-restart']，baseline=false 默认关）；目标档 S3；
  //   **未放行**：dry-run 通道可跑（影子视图可见），四门全关时任何执行一律 blocked 且零副作用。
  //   ⚠️ L1 归属已知不一致（owner=p3AutoEnabled vs 矩阵声明 p0AutoRestartEnabled，真实口径=两把键与）——
  //      2026-09-13 卡 ac3f9038 拍板① 已统一口径：模块登记表补 `rawOwner: 'p0AutoRestartEnabled'`，**只作回报与呈现**
  //      （checkModuleAllowed 的 allowed 判定一字未改；raw 键的判定方仍是通道级 `autoAllowed('p0-auto-restart')`）。
  'p0-auto-restart': {
    level: 'L2', label: 'P0 低水位自动重启（待重启事由 + 低水位达成时自动发一条重启请求进既有 P0 闸门；不打断在跑卡）', reversible: true,
    moduleId: 'p0-auto-restart', moduleKind: 'own', domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  // 2026-09-13 批次 5（矩阵 §3.1 待实现清单第 3 项）：实现 = lib/p5-auto-rollback.mjs（执行体**复用既有回滚能力** ——
  //   B 层快照由 butler-watch-fs.mjs 的 ensureSnap() 建立，本动作只把 state.files[file].snap 拷回原位，**不重写第二套回滚算法**，
  //   也不把动作接线进 tick / 不改 watcher 一行）；干系 L2 模块 = 同名 `p5-auto-rollback`（modules['p5-auto-rollback']，baseline=false 默认关）；
  //   数据级闸门 = 审计链校验（butler-audit-verify.mjs 的 verifyChain()，链断/篡改 → 拒绝自动回滚）；目标档 S3；
  //   **未放行**：dry-run 通道可跑（影子视图可见），四门全关时任何执行一律 blocked 且零副作用。
  //   ⚠️ L1 归属已知不一致（模块门 owner=autoHealEnabled vs 矩阵声明 p5AutoRollbackEnabled，真实口径=两把键与；
  //      且 runAction 第三道闸恒查 p3-auto）——2026-09-13 卡 ac3f9038 拍板① 已统一口径：模块登记表补
  //      `rawOwner: 'p5AutoRollbackEnabled'`，**只作回报与呈现**（allowed 判定一字未改；raw 键判定方仍是通道级 autoAllowed）。
  'p5-auto-rollback': {
    level: 'L2', label: 'P5 B 层写后审计违规自动回滚（用既有快照把已判违规的文件还原成最近合法内容；审计链校验通过才动手）', reversible: true,
    moduleId: 'p5-auto-rollback', moduleKind: 'own', domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  // 2026-09-14 批次 8（矩阵 §3.1 待实现清单第 4 项）：实现 = lib/auto-heal.mjs（+ lib/auto-heal-channel.mjs 薄调用点）；
  //   干系 L2 模块 = 同名 `auto-heal`（modules['auto-heal']，baseline=false 默认关）；目标档 S3。
  //   语义（照 2026-09-13 主人批准的边界，不扩大）：① 幂等补丁重打（只重打"被证明特征丢失"的声明式补丁）
  //   ② 声明式指向重建（闭包 junction / package-map；只跑已声明的既有修复入口）③ 修完同源自检 + **失败即停** + 单轮上限 + 全部落审计；
  //   ❌ 不改 persona/技能/文档内容、不改配置值、不升降版本、不删任何东西。
  //   L1 归属：模块 owner = `autoHealEnabled`，通道 raw 亦 `autoHealEnabled`（**同名，无批次 4/5 那种归属不一致**）
  //   ⇒ 真实放行 = `p3AutoEnabled`（runAction 第三道闸恒查）+ `autoHealEnabled`（模块门/通道级同一把）+ `modules['auto-heal']`。
  //   **未放行**：dry-run 通道可跑（影子视图可见），四门全关时任何执行一律 blocked 且零副作用。
  'auto-heal': {
    level: 'L2', label: '组件自修复自动分支（幂等补丁重打 + 声明式指向重建；修完同源自检、失败即停、单轮上限、全部落审计）', reversible: true,
    moduleId: 'auto-heal', moduleKind: 'own', domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  // 2026-09-16（卡：P3 自主动作 ctx-guard · 上下文看门）：实现 = lib/ctx-guard.mjs；
  //   干系 L2 模块 = 同名 `ctx-guard`（modules['ctx-guard']，baseline=false 默认关）；
  //   语义：tick **每 2 分钟**（`butler-tickd.mjs` 的 `{ id:'ctx-guard', intervalMs: 2*MIN }`；2026-09-22 由
  //   5 分钟收紧）扫会话 → 对 `running === true` 且投影用量超软限/硬限的会话投递「该移交了」的提醒。
  //   ⚠️ **2026-09-24 重登记（卡「夜批03 · 投递分级实现」· 主人 D27 = (b′) 拍板）**：
  //     · 投递分两档：软限 = `queue`（排队等当前回合结束、**不打断**，与旧行为一致）；
  //       **硬限 = 可 `steer`**（`session.prompt {mode:'steer'}`：**当前 step 跑完时插话**，
  //       **不 abort 进行中的工具**），但**默认关**（开关 = `butler-autonomy-limits.json` 的
  //       `ctxGuard.steer.enabled`，未配置即关）+ **危险动作豁免名单**（判据唯一源 = `lib/steer-gate.mjs`；
  //       **卡执行会话一律不进硬限插话名单**，复用 `lib/card-session.mjs`）。
  //     · **风险级 L1 → L2（"风险级必须如实升档"）**：L1 的旧定义「只注入提醒文本、不改数据、
  //       **不打断回合**」自 steer 落地起不再成立（它会改变在跑会话的节奏）；但它**不 abort 工具**、
  //       不改任何数据、关掉开关即复原旧行为 ⇒ 落 L2（有损可回滚），不是 L3（L3 = 永不自动执行）。
  //     · ⚠️ 本行 `level` 与 `lib/ctx-guard.mjs` 的 `CTX_LEVEL` **必须一致**（`checkSpecLevel` 判据口径；
  //       一致性由 `_test\test-ctx-guard.mjs` 与 `_test\test-4-3-upgrade-registration.mjs` 钉死）。
  //   与 `queue-wake` 刻意相反：那个只叫**空闲**会话且要求"目标唯一"，这个瞄准**在跑**会话逐个各自投递。
  //   去重/限额/闸门一律复用 runAction（不另造口径）；**未放行**：dry-run 通道可跑，四门全关时任何执行一律 blocked。
  'ctx-guard': {
    level: 'L2', label: '上下文看门（软限 queue 投递移交提醒；硬限可 steer 在 step 边界插话——默认关 + 卡执行会话不进名单，不 abort 工具）', reversible: true,
    moduleId: 'ctx-guard', moduleKind: 'own', domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  // 2026-09-28（K5b · 主人拍板 P-8=③）：实现 = lib/board-line-archive.mjs（+ _test\test-board-line-archive.mjs）；
  //   干系 L2 模块 = **同名** `board-line-archive`（modules['board-line-archive']，baseline=false ⇒ 默认关）；
  //   口径 = 复用既有链条（判定 board-cleanup.mjs / 执行 tools\board-archive-line.mjs / 闸门 runAction）；
  //   目标档 S3；**登记 ≠ 放行**：登记后 dry-run 可跑（影子可见），真执行仍被
  //   L0 降档 + 总闸 p3-auto + 去重/上限/预算四类护栏拦。
  //   ⚠️ **2026-09-28 K5b 实测订正（与上一句并列，不算推翻）**：本机当前 `p3AutoEnabled=true`（生态总闸
  //     常态开）⇒ "登记后仍被四道闸拦"**不成立于 P3 那一门**；而**模块门未接线**（动作体
  //     `runBoardLineArchive()` 只调 `runAction()`，不调 `checkModuleAllowed`）⇒ `modules['board-line-archive']`
  //     目前**不参与判定**。故"未放行"的**实际屏障 = 零调用点**（无 tick / 无回调；机械断言钉在
  //     `_test\test-board-line-archive.mjs` 的 T6）+ CLI 默认 dry-run。**放行前必须先接线模块门**，
  //     否则"改表放行"与"登记"之间没有可证的闸门差异（读数见 `docs/` §3）。
  //   ✅ **2026-09-28 K5d 接线并放行（正好接手 K5b 的"放行前必须先接线模块门"）**：动作体已补
  //     `checkModuleAllowed('board-line-archive')`（dry-run 不受闸门限制；**有候选且门关 ⇒ blocked 零动作**），
  //     且 tickd 已有调用点 `board-line-archive`（每 30 分钟 → `butler-auto-tick.mjs --job board-line-archive`）；
  //     并已 `butler-autonomy-cli.mjs module on board-line-archive`（L2 模块门 🟢，L1 总闸 `p3AutoEnabled` 本就为开）
  //     ⇒ "登记 / 放行"自此**有可证差异**：`module off board-line-archive` 一把关回 ⇒ 真执行立刻 blocked
  //     （双向断言钉在 `_test\test-board-line-archive.mjs` 的 T5）。
  'board-line-archive': {
    level: 'L2', label: '看板周期归档（整线"在板全完成"→ 逐线调既有归档命令；单轮上限 + 默认 dry-run）', reversible: true,
    moduleId: 'board-line-archive', moduleKind: 'own', domain: 'ecosystem',
    guard: { maxAffected: 8, allowBatch: false, guardWhy: '整线归档：**单轮**最多 2 条线（MAX_LINES_PER_ROUND）+ **单日**最多 2 条线（MAX_LINES_PER_DAY，G11③ · 2026-09-28 落地；可在 butler-autonomy-limits.json 用 lineArchiveMaxPerDay 覆盖，0 = 全禁），按实测在线卡均值 ≈7.4 张/线 ⇒ 影响面上界 ≈15 张，取整记 8+（放行后按观测调，见 §11 P-8 可改点）' },
  },
  // L3 登记（**永不自动**，登记在这里是为了让分级映射成为单一数据源，供通知/预览路径共用）
  //   ②-1 域模型：L3 行用 `moduleKind:'none'` 显式声明"无模块归属"（`moduleId` = null + `moduleWhy` 写理由），
  //   与矩阵 §3 该行「干系 L2 模块 = —（L3 无自动通道）」口径一致；**不允许** auto 行拿 `none` 逃避登记。
  'delete-card': {
    level: 'L3', label: '删卡', reversible: false,
    moduleId: null, moduleKind: 'none',
    moduleWhy: 'L3 永不自动执行 ⇒ 无 L2 模块可关（也无可放行）；登记只为分级映射单源与通知路径共用',
    domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  'edit-card': {
    level: 'L3', label: '改卡（标题 / prompt / 类型）', reversible: false,
    moduleId: null, moduleKind: 'none',
    moduleWhy: 'L3 永不自动执行 ⇒ 无 L2 模块可关；登记只为分级映射单源',
    domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  'nudge-reschedule': {
    level: 'L3', label: '催办改期（涉意图）', reversible: false,
    moduleId: null, moduleKind: 'none',
    moduleWhy: 'L3 永不自动执行 ⇒ 无 L2 模块可关；登记只为分级映射单源',
    domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  // 【施工卡 ④-3 · ④ 升级链入家规包 U-1「登记」】🟢/🟡 档插件自动升级链。
  //   实现体 = `tools\dsh-upgrade-orchestrator.mjs`（v1.1.0；④-1 卡已落三道闸：总闸 → L0 降档 → 升级锁 + 审计留痕）。
  //   **与 `escalate-red` 的分工**（矩阵 §3 两行「备注」列已同步写明）：
  //     · 🟢 / 🟡 档 → **本行**（L2，真执行体 = orchestrator；前提：三道闸全开 + 主人批准）
  //     · 🔴（主包 / 决策表禁升区 / 断裂面命中 / 词表 `GONE`）→ `escalate-red`（L3，**只通知、永不自动**）
  //   ⚠️ **登记 ≠ 放行**（家规 R3 原话"已登记可未放行，三者可以不同步"）：本行落地后状态 =
  //      「**已登记 · 已实现（dry-run 可跑）· 未放行**（闸文件 `~/.dsh/upgrade-automation.json` 缺失 = 关）」。
  //   ⚠️ **不新增任何调用点**（本卡 Non-goal）：源码里**没有** `runAction({ kind: 'auto-upgrade' })` ——
  //      机械断言（静态扫描零命中）钉在 `_test\test-4-3-upgrade-registration.mjs`。
  //   `guard`: 升级链单次只升**一个包**（`commands.upgrade` 逐包调），不属批量类
  //      （`registry-audit` 的 BATCH_GUARD_REQUIRED 清单只含 dup-cards-merge / archive-retry）⇒ 声明 `maxAffected: null`。
  //      ⚠️ 与其余行同款：**登记 ≠ 有护栏**（运行时 `affectedCount ≤ maxAffected` 校验尚未实现，② 包 Non-goal）。
  //         【订正注 · 2026-10-11 · 卡「冲刺600·开发批八」】上面括注那半**已过期**：gap-1-08（2026-10-10）
  //         已实现 `runAction()` 闸门 6.5/6.6 的 `affectedCount` 护栏（见本文件头部同名订正注）；
  //         仍旧成立的只有 `allowBatch` 全表 `false`（放开路径未做）。
  'auto-upgrade': {
    level: 'L2', label: '🟢/🟡 档插件自动升级（快照 → 升级 →（🟡）补丁重打 → 自检 → 失败回滚；主包与 🔴 档不走此路）', reversible: true,
    moduleId: 'auto-upgrade', moduleKind: 'own', domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  'escalate-red': {
    level: 'L3', label: '🔴 级升级（主包 / 禁升区）', reversible: false,
    moduleId: null, moduleKind: 'none',
    moduleWhy: 'L3 永不自动（矩阵 §3 该行「干系 L2 模块 = —（L3 无自动通道）」）；无执行体',
    domain: 'ecosystem',
    guard: { maxAffected: null, allowBatch: false },
  },
  // ============================================================ 【施工卡 ⑤-6 · ⑤ 包 §3.6 S-6】
  // 服务面动作 4 行（domain:'service'）；⚠️ 形态 = **字面量**（不是 serviceActionRow()）：
  //   工厂依赖的 isNonEmptyStr 定义在本表之后 ⇒ 表内调用会 TDZ 崩（⑤-6 探针实测：
  //   "Cannot access 'isNonEmptyStr' before initialization"）⇒ 一致性由 A7 断言兜底。
  'secretary-push': {
    level: 'L1', label: '服务面主动推送（早报 / 完成通知 / 异常告警）', reversible: true,
    moduleId: 'p2-watch', moduleKind: 'family',
    familyWhy: '服务面自有闸（服务面配置，不吃生态四键）⇒ 挂 owner:null 的模块（② 包 §7.4 判定①"或"分支）',
    domain: 'service',
    offSwitch: 'butler-secretary.json#switches.push',
    auditStream: 'butler-audit(type=secretary-push-*)',
    quota: 'service-pool',
    guard: { maxAffected: null, allowBatch: false },
  },
  'feed-ingest': {
    level: 'L1', label: '家人/主人投喂落库（写 memory.db + owner_user 归属）', reversible: true,
    moduleId: 'p2-watch', moduleKind: 'family',
    familyWhy: '同上：落库不烧 token、无外部出口，但属服务面写者 ⇒ 挂 owner=null 模块',
    domain: 'service',
    offSwitch: 'butler-secretary.json#switches.feed',
    auditStream: 'butler-audit(type=secretary-feed-*)',
    quota: 'none',
    guard: { maxAffected: null, allowBatch: false },
  },
  'family-answer': {
    level: 'L1', label: '家人问答（操作者这条链；按人记账）', reversible: true,
    moduleId: 'p2-watch', moduleKind: 'family',
    familyWhy: '同上：额度走 service-pool（⑥ 包池子分摊）⇒ 挂 owner=null 模块',
    domain: 'service',
    offSwitch: 'butler-secretary.json#switches.familyChat',
    auditStream: 'butler-audit(type=secretary-answer-*)',
    quota: 'service-pool',
    guard: { maxAffected: null, allowBatch: false },
  },
  'secretary-tunnel': {
    level: 'L3', label: 'H5 临时入口开关（手工开关，非自动动作）', reversible: false,
    moduleId: null, moduleKind: 'none',
    moduleWhy: '手工开关 ⇒ 永不自动执行（L3），无 L2 模块可关；登记只为分级映射单源与通知路径共用',
    domain: 'service',
    offSwitch: 'butler-secretary.json#switches.tunnel',
    auditStream: 'butler-audit(type=secretary-tunnel-*)',
    quota: 'none',
    guard: { maxAffected: null, allowBatch: false },
  },
  // ============================================================ 【⑤-6 服务面 4 行 —— 以上】
};

// ============================================================ 【施工卡 ②-4 · ② 包 A-4「服务面动作表位」】
// 服务面动作（外部通道推送 / 家人问答 / 投喂落库…）**并进本表**，不新建第二张表（② 包 §11.1 Q2 = ②）：
//   · `domain: 'service'` = 服务面子域（区别于 `'ecosystem'` 生态自治）；
//   · 三字段 **齐备或整体判红**（半填 = 红；判定执行在 lib/registry-audit.mjs 的 A7）：
//       `offSwitch`   关断键 —— **服务面自有键**，**不得落在生态五键**（`ECOSYSTEM_L1_KEYS`）
//       `auditStream` 审计流标识（写清落哪条流水 / type 前缀）
//       `quota`       额度归属 ∈ `SERVICE_QUOTA_POOLS` —— **不许留空**（I13「额度池无分摊」的病根）
//   · 隔离口径：**吃 L0、不吃生态四键**（② 包 §3.4 隔离断言 + ⑤ 包 §4.4-X2 收信）；
//     `moduleId` 指向的模块行 `owner` **不得**是四键，**或**挂 `owner:null` 的模块（如 `p2-watch`）
//     + `offSwitch` 为服务面自有键（② 包 §7.4 判定①的"或"分支）。
//   · **本节只建表位 / 不含服务面实现**：⑤ 包落地服务面动作时**只填行**（用 `serviceActionRow()` 构造），
//     不搬迁 `alert-*` / `secretary-*` 代码（那是 ⑤ 包的活）。
//   · ⚠️ **判据唯一源仍是 `lib/registry-audit.mjs` 的 A7**；本节常量与工厂只做"写入侧声明 + 防呆"，
//     两处一旦漂移，由 A7 的「表位常量同源」断言当场报红（机械兜住，不靠自觉）。
export const SERVICE_DOMAIN = 'service';

/** 服务面三字段（`domain:'service'` 时**齐备或整体判红**，不许半填）。 */
export const SERVICE_ACTION_FIELDS = Object.freeze(['offSwitch', 'auditStream', 'quota']);

/** `quota` 取值域：`eco-pool` 生态额度池 / `service-pool` 服务面自有池 / `none` 不烧额度。 */
export const SERVICE_QUOTA_POOLS = Object.freeze(['eco-pool', 'service-pool', 'none']);

/** 生态 L1 键（**五键**）——服务面动作**不得**被它们判定（② 包 §3.4 隔离断言的键集唯一来源）。
 *  【P8 [12] · 2026-09-28】四键 → **五键**：登记 `p8AutoEnabled`（主人 2026-09-10 16:36 拍板
 *  「p8-auto 独立自主」+ 设计档 §15.1 D2 + §11 订正注③ 明文要求「`ECOSYSTEM_L1_KEYS` 四键→五键」）。
 *  ⚠️ 语义不变：仍是「**L1 自治总开关键**」这一集合，只是多了一把独立的 P8 钥匙；
 *     服务面 `offSwitch` 命中其中任何一把都判红（`offSwitchHitsEcosystemKeys`）。
 *     常量名保留 `FOUR_L1_KEYS` 别名的历史出处见 lib/registry-audit.mjs（别名指向本常量，不改名）。 */
export const ECOSYSTEM_L1_KEYS = Object.freeze(['p3AutoEnabled', 'p0AutoRestartEnabled', 'p5AutoRollbackEnabled', 'autoHealEnabled', 'p8AutoEnabled']);

/** 关断键是否命中生态四键：命中 ⇒ 返回那个键名，否则 null。
 *  ⚠️ 形态多样（`switches.push` / `butler-secretary.json#switches.push`）⇒ 按**非字母数字下划线分隔取段**比对，
 *  不靠整串相等（整串相等会漏掉带前缀 / 带路径的写法 ⇒ 隔离判据形同虚设）。 */
export function offSwitchHitsEcosystemKeys(offSwitch) {
  if (typeof offSwitch !== 'string') return null;
  const segs = offSwitch.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  return segs.find((s) => ECOSYSTEM_L1_KEYS.includes(s)) ?? null;
}

const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 【②-4 表位接口】构造一条 `domain:'service'` 动作行 —— **⑤-6 填行的唯一入口**。
 * 入参非法一律 **throw**（fail loud）：半填行 / 关断键落在生态四键上的行**不许悄悄进表**
 * （② 包 §17-b：「三字段齐备或整体判红」，写入侧先炸一道，校验器 A7 再判一道）。
 * ⚠️ 本函数只保证"结构齐备 + 明显违规在写入侧就炸"；**准入判定的唯一权威仍是 registry-audit 的 A7**
 *   （`_test\test-2-4-service-slot.mjs` 有"工厂产出必然过 A7 / 工厂拒收的反例 A7 也判红"的不漂移断言）。
 * @param {{kind:string, level:'L1'|'L2'|'L3', label:string, reversible:boolean,
 *          offSwitch:string, auditStream:string, quota:'eco-pool'|'service-pool'|'none',
 *          moduleId?:string|null, moduleKind?:'own'|'family'|'none',
 *          familyWhy?:string, moduleWhy?:string,
 *          guard?:{maxAffected:number|null, allowBatch:boolean, guardWhy?:string}}} input
 * @returns {object} 可直接展开进 `AUTO_ACTION_KINDS` 的行对象
 */
export function serviceActionRow(input = {}) {
  const { kind, level, label, reversible, offSwitch, auditStream, quota } = input;
  const moduleId = input.moduleId ?? null;
  const moduleKind = input.moduleKind ?? (moduleId === null ? 'none' : 'family');
  const auto = LEVELS[level]?.auto === true;
  const bad = [];
  if (!isNonEmptyStr(kind)) bad.push('kind 必填且非空');
  if (!LEVELS[level]) bad.push(`level 必填且 ∈ ${Object.keys(LEVELS).join('|')}`);
  if (!isNonEmptyStr(label)) bad.push('label 必填且非空');
  if (typeof reversible !== 'boolean') bad.push('reversible 必填且为布尔');
  for (const f of SERVICE_ACTION_FIELDS) {
    if (!isNonEmptyStr(input[f])) bad.push(`${f} 必填（三字段齐备或整体判红：半填 = 红）`);
  }
  if (isNonEmptyStr(quota) && !SERVICE_QUOTA_POOLS.includes(quota)) {
    bad.push(`quota=${JSON.stringify(quota)} 不在 ${SERVICE_QUOTA_POOLS.join('|')}`);
  }
  const hit = offSwitchHitsEcosystemKeys(offSwitch);
  if (hit) bad.push(`offSwitch 命中生态四键 ${hit} ⇒ 服务面动作会被生态熔断连带关掉（只许服务面自有键）`);
  if (!['own', 'family', 'none'].includes(moduleKind)) bad.push(`moduleKind=${JSON.stringify(moduleKind)} 不在 own|family|none`);
  if (moduleKind === 'none' && moduleId !== null) bad.push('moduleKind=none 必须 moduleId=null');
  if (moduleKind !== 'none' && !isNonEmptyStr(moduleId)) bad.push('moduleKind≠none 时必须给 moduleId（服务面行挂模块行或 owner:null 的模块）');
  if (moduleKind === 'own' && moduleId !== kind) bad.push("moduleKind='own' 时 moduleId 必须与 kind 同名（own 的定义 = 有同名模块行）");
  if (moduleKind === 'family' && !isNonEmptyStr(input.familyWhy)) bad.push('moduleKind=family 必须写 familyWhy（"动作 ID ≠ 模块 id"要写明）');
  if (moduleKind === 'none') {
    if (!isNonEmptyStr(input.moduleWhy)) bad.push('moduleKind=none 必须写 moduleWhy');
    if (auto) {
      bad.push('moduleKind=none 仅 L3 可用（A2/A5 断言当场判红）⇒ 自动档服务面行须挂模块行；'
        + '若要"moduleId:null + 服务面自有闸"形态，属 ②-4 交付报告的「待拍板项」，先别填');
    }
  }
  // 【施工卡 ②-6 · A-7】服务面行**同样必须**带 `guard` 声明（不把"漏声明"埋给 ⑤-6：
  //   否则 registry-audit 的 A8 会在 ⑤-6 填行当天报红，而那是本卡埋的雷）。默认 = 非批量。
  const g = input.guard ?? { maxAffected: null, allowBatch: false };
  if (!g || typeof g !== 'object'
    || !(g.maxAffected === null || (Number.isInteger(g.maxAffected) && g.maxAffected > 0))
    || typeof g.allowBatch !== 'boolean'
    || (g.maxAffected !== null && !isNonEmptyStr(g.guardWhy))) {
    bad.push('guard 非法：须 { maxAffected: 正整数|null, allowBatch: boolean, guardWhy: string（maxAffected 非 null 时必填）}');
  }
  if (bad.length) throw new Error(`serviceActionRow(${JSON.stringify(kind ?? null)}): ${bad.join('；')}`);
  const row = { level, label, reversible, moduleId, moduleKind };
  if (moduleKind === 'family') row.familyWhy = input.familyWhy;
  if (moduleKind === 'none') row.moduleWhy = input.moduleWhy;
  row.domain = SERVICE_DOMAIN;
  row.offSwitch = offSwitch;
  row.auditStream = auditStream;
  row.quota = quota;
  row.guard = g;
  return row;
}

/** 分级查询（未知 kind → 按最严处理：L3，绝不自动）。 */
export function levelOf(kind) {
  const row = AUTO_ACTION_KINDS[kind];
  if (!row) return { id: 'L3', auto: false, label: '未登记', rule: '未登记的动作一律按 L3（只通知）处理', unknown: true };
  return { ...LEVELS[row.level], kind, label: row.label, reversible: row.reversible };
}

/** 该 kind 是否允许自动执行（分级表判据）。 */
export function isAutoLevel(kind) {
  const lv = levelOf(kind);
  return lv.auto === true && lv.unknown !== true;
}

/**
 * 动作的**爆炸半径上限**（v2 方案 §3.6.5）= `AUTO_ACTION_KINDS[kind].guard.maxAffected`。
 *   - `null` = 该动作不适用批量语义（非批量动作）；
 *   - 未登记 kind → `null`（不在此拦：未登记由 `levelOf` 判 L3 + 闸门 1 兜住）。
 *
 * 2026-10-10 卡「冲刺600·补核心库」（gap-1-08）：此前**登记面 ≠ 执行面** —— 表里写了 `maxAffected`，
 * 但 `runAction()` 里零校验（"声明 ≠ 有护栏"）。本函数是**唯一取值口**，`runAction` 的闸门 6.5/6.6
 * 经它拿上限 ⇒ 登记表的改动会自动成为运行时判据（不再需要两处维护）。
 */
export function maxAffectedOf(kind) {
  const row = AUTO_ACTION_KINDS[kind];
  const m = row?.guard?.maxAffected;
  return Number.isInteger(m) && m > 0 ? m : null;
}

/** 默认护栏限额（写入 butler-autonomy-limits.json，可被主人调）。 */
export function defaultLimits() {
  return {
    schemaVersion: 1,
    maxAutoActionsPerDay: 5,
    dedupWindowMs: 24 * 3600 * 1000,
    tokenBudgetPerDay: 0,          // 0 = 不启用 token 预算门
    maxActionsPerTick: 2,
    keepSignatures: 500,
    signatureRetentionMs: 30 * 24 * 3600 * 1000,
  };
}

export function limitsPath(opts = {}) { return stateFileOf(LIMITS_FILE, opts); }
export function actionsStatePath(opts = {}) { return stateFileOf(ACTIONS_FILE, opts); }

/** 读护栏限额（缺失/损坏 → 默认值，fail-safe 用默认（更严）而非放宽）。 */
export function readLimits(opts = {}) {
  const file = limitsPath(opts);
  try {
    if (!fs.existsSync(file)) return { ...defaultLimits(), _file: file, _source: 'default' };
    const j = readJson(file, { audit: false });
    return { ...defaultLimits(), ...(j && typeof j === 'object' ? j : {}), _file: file, _source: 'file' };
  } catch (e) {
    alert({ level: 'warn', source: 'butler-auto', message: `护栏限额读取失败，回落默认：${e?.message ?? e}`, detail: { file } }, { home: opts.home });
    return { ...defaultLimits(), _file: file, _source: 'fallback' };
  }
}

/** 本机日期（本地时区 YYYY-MM-DD；每日上限按自然日）。 */
export function localDay(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysBetween(dayA, dayB) {
  const t = (s) => Date.parse(`${s}T00:00:00`);
  const a = t(dayA); const b = t(dayB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

/** 空状态（schemaVersion 1）。 */
export function emptyActionsState() {
  return { schemaVersion: ACTIONS_SCHEMA, signatures: {}, daily: {}, lastRunAt: null, lastResults: [] };
}

export function readActionsState(opts = {}) {
  const file = actionsStatePath(opts);
  try {
    const j = readJson(file, { schemaVersion: ACTIONS_SCHEMA, defaultValue: emptyActionsState(), audit: false });
    if (!j || typeof j !== 'object') return { ...emptyActionsState(), _file: file };
    return { ...emptyActionsState(), ...j, signatures: { ...(j.signatures ?? {}) }, daily: { ...(j.daily ?? {}) }, _file: file };
  } catch (e) {
    // schemaVersion 不符 / 损坏 → 不猜，返回空（去重记录丢失只会多跑一次，不会误放行）
    alert({ level: 'warn', source: 'butler-auto', message: `自动动作状态读取失败（按空处理）：${e?.message ?? e}`, detail: { file } }, { home: opts.home });
    return { ...emptyActionsState(), _file: file, _readError: e?.message ?? String(e) };
  }
}

/**
 * 签名去重判据（纯函数，供单测）。
 * @param {object} state 当前状态
 * @param {string} sigKey
 * @param {number} now
 * @param {number} windowMs
 * @returns {{dup:boolean, lastAt:number|null, ageMs:number|null, reason:string}}
 */
export function checkSignature(state, sigKey, now = Date.now(), windowMs = 24 * 3600 * 1000) {
  const rec = state?.signatures?.[sigKey];
  if (!rec) return { dup: false, lastAt: null, ageMs: null, reason: 'first-seen' };
  const lastAt = Number(rec.lastAt ?? 0) || null;
  if (!lastAt) return { dup: false, lastAt: null, ageMs: null, reason: 'no-timestamp' };
  const ageMs = now - lastAt;
  if (ageMs < windowMs) return { dup: true, lastAt, ageMs, reason: `24h 内已处理（${Math.round(ageMs / 60000)} 分钟前）` };
  return { dup: false, lastAt, ageMs, reason: 'window-expired' };
}

// ============================================================ 【施工卡 ⑥-3 · ⑥ 包 §3.4-P2「分池 + 保底」】
// 设计真源 = `docs/` §3.4-P2（配置形态 / 判定顺序 / 保底语义 / service 独立池）
//   + `docs/` §4-B5（主人 2026-09-17 22:20 拍板 = **b**：可见化 + 分池）。
// 三条不可动的边界（本卡逐条守，出处见括号）：
//   ① **默认不启用**：`pools` 缺失/非法 ⇒ 走原路径，`checkDailyLimit` 的返回**逐字节不变**
//      （方案 §9 风险 1 的缓解原文：「分池逻辑**默认不启用**（`pools` 不存在 ⇒ 走原路径）」）。
//   ② **旧字段语义一个字不改**：`maxAutoActionsPerDay` 仍是**全局总闸**（与 `pools.eco.maxPerDay` 取 min）；
//      `daily[day].count` / `byKind` 只读、写法与含义不动（方案 §3.4-P2 配置注释 + §9 风险 2）。
//   ③ **判定只此一处**：分池判定全部在本函数内派生；planner/面板/日报只消费结果，**不自建第二套额度判定**
//      （方案 §2.3 复用表：`checkDailyLimit` = 额度判定唯一函数）。
// 形态说明（⑥ 包 §16 A13 / §3 批注⑥ 已改正）：`reserveMin` 的形态**不是** ③ 包 §3.5(c) 的「持有者计数」
//   （那是外部显式登记 + 释放的引用计数），而是**配置里的预留额度**（无持有者、无释放语义），
//   与既有护栏字段 `maxAutoActionsPerDay` / `maxActionsPerTick` **同族**。

/** 池名：`eco` 生态池（生态自治动作）/ `service` 服务面独立池。 */
export const POOL_ECO = 'eco';
export const POOL_SERVICE = 'service';

const numOr = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * 归一化 `pools` 配置（**纯函数**）。任何非法/缺失一律 ⇒ `{ enabled:false }`：
 *   判定函数必须 fail-safe —— 配置写坏只会回落「现状单池」，**绝不把动作全拦死**。
 * @param {object} raw `butler-autonomy-limits.json` 的 `pools` 字段
 * @returns {{enabled:boolean, eco?:object, service?:object}}
 */
export function normalizeQuotaPools(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { enabled: false };
  const ecoRaw = (raw.eco && typeof raw.eco === 'object' && !Array.isArray(raw.eco)) ? raw.eco : null;
  const svcRaw = (raw.service && typeof raw.service === 'object' && !Array.isArray(raw.service)) ? raw.service : null;
  if (!ecoRaw && !svcRaw) return { enabled: false };
  const kindsOf = (o) => {
    const out = {};
    const src = (o?.kinds && typeof o.kinds === 'object' && !Array.isArray(o.kinds)) ? o.kinds : {};
    for (const [k, v] of Object.entries(src)) {
      // ⚠️ 非对象值 ⇒ 丢弃（防呆）；**对象值即使为空也保留** —— 空格子 = 只声明「归哪个池」，
      //   不设 kind 级上限（`pools.service.kinds['secretary-push'] = {}` 是合法且必要的写法：
      //   service 池归属靠名单，上限由 `pools.service.maxPerDay` 统一给）。
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const cell = {};
      const mx = Number(v.maxPerDay);
      if (Number.isFinite(mx) && mx >= 0) cell.maxPerDay = mx;
      const rs = Number(v.reserveMin);
      if (Number.isFinite(rs) && rs >= 0) cell.reserveMin = rs;
      out[String(k)] = cell;
    }
    return out;
  };
  const capOf = (o) => { const n = Number(o?.maxPerDay); return (Number.isFinite(n) && n >= 0) ? n : null; };
  return {
    enabled: true,
    eco: { maxPerDay: capOf(ecoRaw), kinds: kindsOf(ecoRaw) },
    service: { maxPerDay: capOf(svcRaw), kinds: kindsOf(svcRaw) },
  };
}

/**
 * 某 kind 属哪个池（**纯函数**，判定与回报同源）。
 * 判据顺序：`pools.service.kinds` 显式名单 → 动作表 `domain:'service'` 且 `quota:'service-pool'` → 默认 eco。
 *   后者让 ⑤ 包填表行（`serviceActionRow()`）**自动落服务面池**，不必再抄一遍名字到 `pools`（⑥ 包 §4.2 同源要求）。
 * @param {string} kind
 * @param {object} pools 归一化结果或原始 `pools`
 */
export function quotaPoolOf(kind, pools) {
  const k = String(kind ?? '');
  const p = (pools && pools.enabled !== undefined) ? pools : normalizeQuotaPools(pools);
  if (!k || !p?.enabled) return POOL_ECO;
  if (p.service.kinds[k]) return POOL_SERVICE;
  const row = AUTO_ACTION_KINDS[k] ?? null;
  if (row && row.domain === SERVICE_DOMAIN && row.quota === 'service-pool') return POOL_SERVICE;
  return POOL_ECO;
}

/**
 * 每日上限判据（**纯函数**；额度判定唯一函数 —— 8 处调用点全部走它）。
 *
 * 旧签名 `checkDailyLimit(state, day, max)` **保持可用且行为不变**；分池走第 4 个参数：
 * `checkDailyLimit(state, day, max, { kind, pools })`。
 *
 * 判定顺序（⑥ 包 §3.4-P2 原文）：**① kind 池上限（若声明）→ ② 生态总闸 → ③ service 池上限**；
 *   · 生态动作（默认）：`cap = min(maxAutoActionsPerDay, pools.eco.maxPerDay) − 保底缺口`；
 *   · 服务面动作（`quotaPoolOf === 'service'`）：**走自己的池** `pools.service.maxPerDay`（独立，不吃生态总闸）；
 *   · 保底 `reserveMin: N`（配置在生态池的某个 kind 上）= **给该通道预留 N 个/日**：
 *     其它 kind 的可用量扣掉「该通道尚未用掉的预留额」（缺口 = `max(0, N − 已用)`），
 *     该通道自己不受此约束 ⇒ 别人再挤也动不了它的 N 个（对症 09-17 08:18「卡完成通知被挤掉」）。
 *
 * @param {object} state `butler-auto-actions.json` 内容
 * @param {string} day 本地自然日
 * @param {number} max 全局总闸 `maxAutoActionsPerDay`
 * @param {{kind?:string, pools?:object}} [opts] 分池参数（缺省 = 旧行为）
 * @returns {{day:string, used:number, max:number, reached:boolean, reason:string, pool?:string,
 *            kind?:string|null, gate?:string|null, quota?:object, reserves?:Array}}
 */
export function checkDailyLimit(state, day = localDay(), max = 5, opts = {}) {
  const used = Number(state?.daily?.[day]?.count ?? 0);
  const reachedGlobal = used >= max;
  const pools = normalizeQuotaPools(opts?.pools);
  const kind = (typeof opts?.kind === 'string' && opts.kind) ? opts.kind : null;

  // ── 旧路径：`pools` 未配置 ⇒ **逐字节保持原行为**（⑥ 包 §9 风险 1 的缓解措施）────────
  if (!pools.enabled) {
    return { day, used, max, reached: reachedGlobal, reason: reachedGlobal ? `今日已达上限 ${used}/${max}` : `今日 ${used}/${max}` };
  }

  // ── 分池路径 ─────────────────────────────────────────────────────────────────────
  const qbk = state?.daily?.[day]?.quotaByKind ?? {};
  const pool = quotaPoolOf(kind, pools);
  const kindCell = kind ? (pool === POOL_SERVICE ? pools.service.kinds[kind] : pools.eco.kinds[kind]) : null;

  // 池用量：按分账 `quotaByKind` 归类求和；分账缺口（⑥-1 之前的老条目无此字段）用"全局减另一池"保守兜底。
  let ecoSum = 0; let serviceUsed = 0;
  for (const [k, v] of Object.entries(qbk)) {
    if (quotaPoolOf(k, pools) === POOL_SERVICE) serviceUsed += numOr(v);
    else ecoSum += numOr(v);
  }
  const ecoUsed = Math.max(ecoSum, used - serviceUsed);
  const kindUsed = kind ? numOr(qbk[kind]) : 0;

  // 保底预留：只对**生态池**里声明了 `reserveMin` 的**其它** kind 计算（服务面池独立，不参与生态保底）。
  const reserves = [];
  let reservedGap = 0;
  if (pool === POOL_ECO) {
    for (const [r, cell] of Object.entries(pools.eco.kinds)) {
      const rs = numOr(cell.reserveMin);
      if (!(rs > 0) || r === kind) continue;
      const usedR = numOr(qbk[r]);
      const gap = Math.max(0, rs - usedR);
      reservedGap += gap;
      reserves.push({ kind: r, reserveMin: rs, used: usedR, gap });
    }
  }

  // 上限：生态池 = min(全局总闸, pools.eco.maxPerDay) − 保底缺口；服务面池 = 自己的上限（独立）。
  const ecoCap = (pools.eco.maxPerDay === null) ? max : Math.min(pools.eco.maxPerDay, max);
  const serviceCap = (pools.service.maxPerDay === null) ? max : pools.service.maxPerDay;
  const cap = pool === POOL_SERVICE ? serviceCap : Math.max(0, ecoCap - reservedGap);
  const poolUsed = pool === POOL_SERVICE ? serviceUsed : ecoUsed;

  // ① kind 池上限 → ② 生态总闸（含保底）／服务面池上限
  let reached = false; let gate = null; let reason = '';
  if (kindCell?.maxPerDay !== undefined && kindUsed >= kindCell.maxPerDay) {
    reached = true; gate = 'quota-kind';
    reason = `\`${kind}\` 已达 kind 池上限 ${kindUsed}/${kindCell.maxPerDay}（全局 ${used}/${max}）`;
  } else if (poolUsed >= cap) {
    reached = true;
    if (pool === POOL_SERVICE) {
      gate = 'quota-pool';
      reason = `服务面池已达上限 ${poolUsed}/${cap}（独立池，全局 ${used}/${max}）`;
    } else if (reservedGap > 0) {
      gate = 'quota-reserve';
      reason = `生态池已达可用上限 ${poolUsed}/${cap}（其中 ${reservedGap} 个为保底预留，全局 ${used}/${max}）`;
    } else {
      gate = 'quota-day';
      reason = `今日生态池已达上限 ${poolUsed}/${cap}（全局 ${used}/${max}）`;
    }
  } else {
    reason = pool === POOL_SERVICE
      ? `服务面池 ${poolUsed}/${cap}（独立池，全局 ${used}/${max}）`
      : `生态池 ${poolUsed}/${cap}（全局 ${used}/${max}${reservedGap > 0 ? `，已扣保底预留 ${reservedGap}` : ''}）`;
  }

  return {
    day, used, max, reached, reason,
    pool, kind, gate,
    quota: {
      pool, kind,
      kindUsed, kindMax: (kindCell?.maxPerDay ?? null),
      poolUsed, poolMax: cap,
      ecoUsed, serviceUsed, ecoMaxPerDay: pools.eco.maxPerDay, serviceMaxPerDay: pools.service.maxPerDay,
      reservedGap, effectiveEcoMax: ecoCap - reservedGap,
    },
    reserves,
  };
}

/** 惰性过期清理（去重记录与每日计数）。 */
export function pruneActionsState(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const limits = opts.limits ?? defaultLimits();
  const sigs = { ...(state?.signatures ?? {}) };
  let removed = 0;
  for (const [k, v] of Object.entries(sigs)) {
    const age = now - Number(v?.lastAt ?? 0);
    if (age > limits.signatureRetentionMs) { delete sigs[k]; removed++; }
  }
  let entries = Object.entries(sigs).sort((a, b) => Number(b[1]?.lastAt ?? 0) - Number(a[1]?.lastAt ?? 0));
  if (entries.length > limits.keepSignatures) {
    for (const [k] of entries.slice(limits.keepSignatures)) { delete sigs[k]; removed++; }
    entries = entries.slice(0, limits.keepSignatures);
  }
  const today = localDay(now);
  const daily = {};
  for (const [d, v] of Object.entries(state?.daily ?? {})) {
    if (daysBetween(d, today) <= 30) daily[d] = v;
  }
  return { state: { ...state, signatures: sigs, daily }, removed };
}

/**
 * token 预算门（可插拔：由 lib/token-usage.mjs 提供今日用量）。
 * 超限 → 返回 {exceeded:true}：**"停" = 不再启动新自动动作**（方案 v2.4 精确措辞）。
 */
export function checkTokenBudget(opts = {}) {
  const limits = opts.limits ?? readLimits(opts);
  const budget = Number(limits.tokenBudgetPerDay ?? 0);
  if (!(budget > 0)) return { enabled: false, exceeded: false, budget, used: null, reason: 'token 预算门未启用' };
  let used = null;
  try {
    if (typeof opts.usageProvider === 'function') used = Number(opts.usageProvider() ?? 0);
  } catch { used = null; }
  if (used === null || !Number.isFinite(used)) return { enabled: true, exceeded: true, budget, used: null, reason: '用量不可得 → fail-safe 停止新自动动作' };
  return { enabled: true, exceeded: used >= budget, budget, used, reason: used >= budget ? `今日 ${used}/${budget} 已超预算` : `今日 ${used}/${budget}` };
}

/** 记录一次自动动作（写状态 + 审计；只在**真的执行**或 dry-run 预览时调用）。 */
export function recordAction(entry, opts = {}) {
  const now = opts.now ?? Date.now();
  const limits = opts.limits ?? readLimits(opts);
  const file = actionsStatePath(opts);
  const day = localDay(now);
  const out = updateStateJson(ACTIONS_FILE, file, (cur) => {
    const base = { ...emptyActionsState(), ...(cur ?? {}) };
    const sigs = { ...(base.signatures ?? {}) };
    if (entry.sigKey) {
      const prev = sigs[entry.sigKey] ?? {};
      sigs[entry.sigKey] = { lastAt: now, count: Number(prev.count ?? 0) + 1, kind: entry.kind, level: entry.level, detail: entry.detail ?? null };
    }    const daily = { ...(base.daily ?? {}) };
    const prevDay = daily[day] ?? { count: 0, byKind: {}, noQuotaCount: 0 };
    const noQuota = entry.consumesQuota === false;
    const isDryRun = entry.dryRun === true;
    // 【施工卡 ⑥-1 · ⑥ 包 §3.4-P1「分账」】`quotaByKind` = **只累加真占配额的条目**
    //   （`consumesQuota !== false` 且 `dryRun !== true`）。语义 = "谁吃了额度"，供面板/日报/分摊报表用。
    //   ⚠️ 老字段 `byKind` 语义**一个字不改**（全量混合：含不占配额与 dry-run）——它被
    //      `shadow-view.mjs` 的窗口注记与 `metrics.mjs` 的 `byKindSum` 消费，改语义 = 连带漂移（⑥ §3.4-P1 原话）。
    //   ⚠️ 未占配额的 kind **不进 `quotaByKind`**（不创建 0 键）：保持"分账里出现的 kind = 真吃过额度"可判。
    const quotaCounted = !noQuota && !isDryRun;
    const quotaByKind = { ...(prevDay.quotaByKind ?? {}) };
    if (quotaCounted) quotaByKind[entry.kind] = Number(quotaByKind[entry.kind] ?? 0) + 1;
    daily[day] = {
      count: Number(prevDay.count ?? 0) + (noQuota ? 0 : 1),
      noQuotaCount: Number(prevDay.noQuotaCount ?? 0) + (noQuota ? 1 : 0),
      byKind: { ...(prevDay.byKind ?? {}), [entry.kind]: Number((prevDay.byKind ?? {})[entry.kind] ?? 0) + 1 },
      quotaByKind,
      lastAt: now,
    };
    const lastResults = [...(base.lastResults ?? []), {
      at: now, kind: entry.kind, level: entry.level, sigKey: entry.sigKey ?? null,
      dryRun: entry.dryRun === true, status: entry.status ?? 'executed',
      consumesQuota: !noQuota, detail: entry.detail ?? null,
    }].slice(-50);
    const pruned = pruneActionsState({ ...base, signatures: sigs, daily }, { now, limits });
    return { ...pruned.state, lastRunAt: now, lastResults, schemaVersion: ACTIONS_SCHEMA };
  }, { schemaVersion: ACTIONS_SCHEMA, defaultValue: emptyActionsState(), home: opts.home ?? dshHome(), audit: false });

  const auditRow = {
    type: 'auto-action',
    kind: entry.kind,
    level: entry.level,
    status: entry.status ?? 'executed',
    dryRun: entry.dryRun === true,
    sigKey: entry.sigKey ?? null,
    day,
    detail: entry.detail ?? null,
  };
  appendAudit(auditRow, { home: opts.home, silent: true });
  return { ok: true, file, day, count: Number(out?.daily?.[day]?.count ?? 0), auditRow };
}

/**
 * **P3 自动动作唯一入口**（异步：动作体内可能有 HTTP 调用，如归档重试）。
 * @param {{
 *   kind:string, sigKey?:string, level?:string, dryRun?:boolean, consumesQuota?:boolean,
 *   limits?:object, home?:string, now?:number, usageProvider?:()=>number,
 *   detail?:any, preview?:()=>any, execute:(ctx:object)=>any, revertHint?:string
 * }} spec
 * @returns {Promise<{
 *   kind:string, level:string, status:'blocked'|'dry-run'|'executed'|'failed'|'noop'|'disabled',
 *   reason:string, gate:object, dedup:object|null, limit:object|null, budget:object|null, degrade:object|null,
 *   result?:any, audit?:object|null
 * }>}
 */
export async function runAction(spec, opts = {}) {
  const now = opts.now ?? spec.now ?? Date.now();
  const home = opts.home ?? spec.home;
  const kind = String(spec.kind ?? '');
  const level = spec.level ?? levelOf(kind);
  const levelId = typeof level === 'string' ? level : level.id;
  const dryRun = spec.dryRun === true || opts.dryRun === true;
  const base = { kind, level: levelId, gate: null, dedup: null, limit: null, budget: null };

  // 0) 组件版本自检（**只在产品版本文件存在时拦截**：文件缺失 = 产品未部署版本登记，
  //    此时"跳过"会让隔离 home / 测试环境整体停摆，而版本自检不是放行判据——
  //    真正的放行判据永远是第 3 步的总闸；故缺失时告警 + 继续）
  const gate = checkComponent(COMPONENT, AUTONOMY_ACTIONS_VERSION, { home });
  if (gate.action === 'skip') {
    alert({ level: 'warn', source: 'butler-auto', message: `组件版本自检未通过：${gate.reason}`, detail: gate }, { home });
    return { ...base, status: 'disabled', reason: `组件版本自检未通过：${gate.reason}`, gate, result: null };
  }

  // 1) 分级表（L3 / 未登记 → 永不自动，连 dry-run 的执行也不给）
  const lv = levelOf(kind);
  if (!lv.auto || lv.unknown) {
    return { ...base, status: 'blocked', level: lv.id, reason: `${lv.label}：分级表禁止自动执行（${lv.rule}）`, gate, result: null };
  }

  // 2) dry-run 通道：只算不动，永不被闸门拦（裸跑观测/交付取证靠它）
  if (dryRun) {
    let preview = null;
    try { preview = typeof spec.preview === 'function' ? spec.preview() : (spec.detail ?? null); } catch (e) { preview = { error: e?.message ?? String(e) }; }
    // ⚠️ dry-run **不写签名表**：否则"只看不动"的一次预览会占掉 24h 去重窗口，
    //    让随后真正该执行的那次被判重复而跳过（2026-09-11 实测踩到）
    const rec = recordAction({
      kind, level: levelId, sigKey: null, dryRun: true, status: 'dry-run', consumesQuota: false, detail: preview,
    }, { home, now });
    return { ...base, status: 'dry-run', reason: 'dry-run 通道：只算不动', gate, dedup: null, limit: null, budget: null, result: preview, audit: rec.auditRow };
  }

  // 2.5) L0 降档闸（G7 · 2026-09-13 批次 6）：degraded / 读不到 → **一律 blocked 且零副作用**。
  //    口径只读复用 lib/autonomy-state.mjs（唯一真相源，禁另写第二套）。
  //    位置刻意放在 dry-run 通道**之后**（dry-run 只算不动，影子视图/观测不受降档影响）、
  //    去重/上限/预算记账**之前**（被降档挡住 ≠ 一次自动动作：不写签名、不占额度、不写审计）。
  const degrade = checkAutonomyAllowed({ home, kind });
  if (!degrade.allowed) {
    return { ...base, status: 'blocked', reason: `L0 降档中（level=${degrade.level}）：${degrade.hint}`, degrade, gate, result: null };
  }

  // 3) 总闸（四把开关之一：p3-auto）
  const allow = autoAllowed('p3-auto', { home });
  if (!allow.allowed) {
    return { ...base, status: 'blocked', reason: `总闸关闭：${allow.reason}`, gate, result: null };
  }

  // 4) 去重窗口（24h）
  //    护栏限额来源优先级：调用方显式注入（spec.limits / opts.limits）→ 状态文件 → 代码默认
  const limits = spec.limits ?? opts.limits ?? readLimits({ home });
  const state = readActionsState({ home });
  if (spec.sigKey) {
    const dup = checkSignature(state, spec.sigKey, now, limits.dedupWindowMs);
    if (dup.dup) {
      appendAudit({ type: 'auto-action-skip', kind, level: levelId, reason: 'duplicate-signature', sigKey: spec.sigKey, lastAt: dup.lastAt }, { home, silent: true });
      return { ...base, status: 'noop', reason: `去重窗口内跳过：${dup.reason}`, dedup: dup, gate, result: null };
    }
  }

  // 5) 每日次数上限（**只读动作**如证据预检可不占额度 —— consumesQuota:false）
  const consumesQuota = spec.consumesQuota !== false;
  let limit = null;
  if (consumesQuota) {
    // 【施工卡 ⑥-3】分池：把本动作的 `kind` 与 `pools` 交给唯一判定函数（`pools` 未配置时零行为变化）
    limit = checkDailyLimit(state, localDay(now), limits.maxAutoActionsPerDay, { kind, pools: limits.pools });
    if (limit.reached) {
      alert({ level: 'warn', source: 'butler-auto', message: `自动动作达每日上限（${limit.used}/${limit.max}），停止新动作`, detail: { kind, day: limit.day } }, { home });
      appendAudit({ type: 'auto-action-limit', kind, level: levelId, ...limit }, { home, silent: true });
      return { ...base, status: 'blocked', reason: `每日上限熔断：${limit.reason}`, limit, gate, result: null };
    }
  }

  // 6) token 预算门（超限 = 不再启动新自动动作；不强杀已在跑的会话）
  const budget = checkTokenBudget({ home, limits, usageProvider: spec.usageProvider ?? opts.usageProvider });
  if (budget.exceeded) {
    alert({ level: 'warn', source: 'butler-auto', message: `token 预算门拦截：${budget.reason}`, detail: { kind } }, { home });
    appendAudit({ type: 'auto-action-budget', kind, level: levelId, ...budget }, { home, silent: true });
    return { ...base, status: 'blocked', reason: `token 预算门：${budget.reason}`, budget, gate, result: null };
  }

  // 6.5) 爆炸半径·执行前预判（§3.6.5 · 2026-10-10 卡「冲刺600·补核心库」gap-1-08）
  //      上限**从动作登记表取**（maxAffectedOf(kind)），不采信调用方自报 —— 防"自己给自己放宽"。
  //      调用方**可选**给 `spec.affectedCount`（数字或函数）做执行前预判；超限 ⇒ **blocked，零副作用**。
  //      ⚠️ 既有动作体都不传该字段 ⇒ 对现网行为零变化（只对将来提供预判的新动作生效）；
  //         执行后复核（6.6）兜住"预判不可知、真跑完才发现越界"的情形。
  const maxAffected = maxAffectedOf(kind);
  let plannedAffected = null;
  if (maxAffected !== null && spec.affectedCount !== undefined) {
    try {
      plannedAffected = typeof spec.affectedCount === 'function' ? spec.affectedCount() : spec.affectedCount;
    } catch (e) {
      plannedAffected = null;
      alert({ level: 'warn', source: 'butler-auto', message: `爆炸半径预判失败（${kind}）：${e?.message ?? e}`, detail: { kind } }, { home });
    }
    if (Number.isFinite(plannedAffected) && plannedAffected > maxAffected) {
      alert({
        level: 'warn', source: 'butler-auto',
        message: `爆炸半径超限，已拒绝执行：${kind} 本次 ${plannedAffected} > 上限 ${maxAffected}`,
        detail: { kind, plannedAffected, maxAffected },
      }, { home });
      appendAudit({ type: 'auto-action-radius', kind, level: levelId, result: 'blocked', affectedCount: plannedAffected, maxAffected }, { home, silent: true });
      return {
        ...base, status: 'blocked',
        reason: `爆炸半径超限（${plannedAffected} > ${maxAffected}）：请分批执行`,
        gate, limit, budget, result: null,
      };
    }
  }

  // 7) 执行（支持异步动作体：归档重试要走 HTTP）
  let result = null;
  let status = 'executed';
  try {
    result = typeof spec.execute === 'function'
      ? await withTimeout(Promise.resolve().then(() => spec.execute({ kind, level: levelId, now, home, limits })), opts.executeTimeoutMs ?? 180_000, `${kind} 执行`)
      : null;
    // 【2026-09-16 拷问 1.7】`ok:false` 也是失败，**必须报警**：旧口径只在抛异常分支 alert，
    //   "动作体正常返回但明确报告没办成"（inject 失败、HTTP 4xx…）一路静默到记账里，没人知道。
    if (result && result.ok === false) {
      status = 'failed';
      alert({
        level: 'error', source: 'butler-auto',
        message: `自动动作执行失败：${kind} —— ${result.error ?? result.reason ?? 'execute 返回 ok:false'}`,
        detail: { kind, result },
      }, { home });
    }
    if (result && result.changed === 0 && result.kind === 'noop') status = 'noop';
  } catch (e) {
    status = /超时/.test(e?.message ?? '') ? 'failed' : 'failed';
    result = { ok: false, error: e?.message ?? String(e) };
    alert({ level: 'error', source: 'butler-auto', message: `自动动作执行失败：${kind} —— ${e?.message ?? e}`, detail: { kind } }, { home });
  }

  // 6.6) 爆炸半径·执行后复核（gap-1-08）：预判不可知、真跑完动作体自报 `affectedCount` 超限 ⇒
  //      判 **failed**（= 真越界，必须走"失败"路径：不写签名、不占额度、🔴 可见 + 审计 + 报警）。
  const actualAffected = result && typeof result.affectedCount === 'number' ? result.affectedCount : null;
  if (maxAffected !== null && actualAffected !== null && actualAffected > maxAffected) {
    status = 'failed';
    result = { ...result, ok: false, error: `爆炸半径越界：本次 ${actualAffected} > 上限 ${maxAffected}（动作体自报）` };
    alert({
      level: 'error', source: 'butler-auto',
      message: `爆炸半径越界（已执行）：${kind} ${actualAffected} > ${maxAffected}`,
      detail: { kind, actualAffected, maxAffected },
    }, { home });
    appendAudit({ type: 'auto-action-radius', kind, level: levelId, result: 'exceeded', affectedCount: actualAffected, maxAffected }, { home, silent: true });
  }

  // 【2026-09-16 拷问 1.7】失败 = **没办成事**，不许自我封口（旧行为：失败也写 24h 签名 + 记每日额度）：
  //   · 不写 24h 签名 —— 写了就等于"失败也吃掉去重窗口"，下轮真该重试时反而被自己挡住；
  //     旧文案 `lib/ctx-guard.mjs` 还写「下轮重试」，与实现对不上（同一处自相矛盾，已一并改掉）。
  //   · 不占每日额度 —— 额度语义是"真的动过手"的配额，失败重试不该被它限流（5 次失败 = 一天额度烧光）。
  //   · 仍然**落审计 + 记账 + 报警**（失败必须可见，绝不静默）。
  //   dry-run 通道不受影响（一直就是 sigKey:null / consumesQuota:false）。
  const failed = status === 'failed';
  const rec = recordAction({
    kind, level: levelId,
    sigKey: failed ? null : spec.sigKey,
    dryRun: false,
    status,
    consumesQuota: failed ? false : consumesQuota,
    detail: { result, preview: spec.detail ?? null, revertHint: spec.revertHint ?? null },
  }, { home, now, limits });

  return {
    ...base, status, failed,
    sigKey: failed ? null : (spec.sigKey ?? null),
    sigKeySkipped: failed && Boolean(spec.sigKey),
    quotaConsumed: !failed && consumesQuota,
    reason: status === 'executed'
      ? '已执行'
      : (failed ? `执行失败（未写签名 / 未占额度，下轮可再试）：${result?.error ?? result?.reason ?? status}` : `执行结果：${status}`),
    gate, limit, budget, result, audit: rec.auditRow,
  };
}

/** 状态摘要（CLI / 面板 / 日报用）。 */
export function describeActions(opts = {}) {
  const limits = readLimits(opts);
  const state = readActionsState(opts);
  const day = localDay(opts.now ?? Date.now());
  // 【施工卡 ⑥-3】不传 `kind` = **生态池视角**（CLI/摘要用）；`pools` 未配置时输出与原样一致
  const daily = checkDailyLimit(state, day, limits.maxAutoActionsPerDay, { pools: limits.pools });
  const a = describeAutonomy(opts);
  return {
    file: actionsStatePath(opts),
    limitsFile: limitsPath(opts),
    limits: { maxAutoActionsPerDay: limits.maxAutoActionsPerDay, dedupWindowMs: limits.dedupWindowMs, tokenBudgetPerDay: limits.tokenBudgetPerDay, maxActionsPerTick: limits.maxActionsPerTick },
    daily,
    signatures: Object.keys(state.signatures ?? {}).length,
    lastRunAt: state.lastRunAt ?? null,
    lastResults: (state.lastResults ?? []).slice(-10),
    phases: a,
    levels: LEVELS,
    kinds: AUTO_ACTION_KINDS,
  };
}

/** 签名工具（供各动作构造稳定 sigKey）。 */
export function sigKeyOf(...parts) {
  return parts.filter((p) => p !== undefined && p !== null && String(p).length).map((p) => String(p)).join('|');
}

/** 超时包装（自动动作不得把 tick 挂死；归档重试这类 HTTP 动作尤其需要）。 */
export function withTimeout(promise, timeoutMs, label) {
  if (!(timeoutMs > 0)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ============================================================ 额度降级台账（⑥ 观测与额度包 · P1 · 施工卡 ⑥-1）
//
// 治什么（⑥ 包 §2.2d/(e)/(f)/§1-2）：额度降级**发生在 planner 里、零留痕** —— 台账 / alert / job detail
//   三处都没有（`auto-action-limit` 审计行实测 0 条）⇒ 09-17 08:18 那次「卡完成通知被凌晨的 queue-wake
//   + ctx-guard 挤掉」要靠主人 8 小时后偶然发现（人可见延迟 = ∞）。本段把"降级发生过"落成可查的行。
//
// 写点在哪（⑥ 包 §7.1③ · 审核批注 A7）：**共用执行函数内**（`runQueueWake` / `runCtxGuard`），
//   不挂任何单入口 —— queue-wake 有两条 plan 入口（planWakeFromTick/planWake）而 runQueueWake 唯一；
//   ctx-guard 的 runCtxGuard 有两个调用方（tickd job + CLI）⇒ 挂"某个入口"必漏。
//
// 本期**不覆盖**（如实声明 + 理由）：`butler-auto-tick.mjs` dup-merge 的 `deferred`（⑥ 包 Q6-③ 的第三处降级
//   落点）—— 它在 auto-tick 的合并循环里，既不属本卡点名的两个共用执行函数，纳入还需改调度循环（跨卡范围）。
//
// 口径（⑥ 包 §6 表 4 · 审核批注 A3 已改正的那行）：**append-only + 非幂等**（每轮每 gate 一行）；
//   写侧按**四元组 `at+kind+day+gate`** 去重；写者 ≥2 个独立进程（tickd spawn 的 job 子进程 + CLI/主会话），
//   锁注册表无 quota 类锁 ⇒ **不加文件锁**（依据 = 单行 <300B、单次 append 写原子）；
//   写失败**不阻断降级**（降级照旧发生）但**必须 `alert(warn)`** —— 绝不"写不进台账就悄悄降级"。

/** 台账路径（home 可注入 ⇒ 单测/沙箱零污染生产）。 */
export function quotaLedgerPath(opts = {}) { return stateFileOf(QUOTA_LEDGER_FILE, opts); }

/** 单行长度上限（写侧"无锁"的依据；超限只告警、不丢弃）。 */
export const QUOTA_LEDGER_MAX_LINE = 300;

/**
 * 从一轮计划里抽出「额度降级」条目并按 gate 聚合（**纯函数**：零 IO、零副作用、可单测）。
 *
 * 认 planner 显式打的 `quotaGate` 字段（`quota-day` / `quota-tick`）—— **不靠 note 文案匹配**：
 * 文案会随措辞漂移，字段才是契约（⑥ 包 §3.4-P1：判定仍在 planner，本轮只加"判定之后多一步写台账"）。
 *
 * @param {{kind?:string, day?:string, now?:number, quota?:object, items?:Array}} plan
 * @param {{kind?:string, day?:string, now?:number}} [opts]
 * @returns {Array<{at:number, kind:string, gate:string, used:number, max:number,
 *                  blockedCount:number, day:string, actionId:string|null}>}
 */
export function extractQuotaDegrades(plan, opts = {}) {
  const now = Number(opts.now ?? plan?.now ?? Date.now());
  const kind = String(opts.kind ?? plan?.kind ?? '');
  const day = String(opts.day ?? plan?.day ?? localDay(now));
  const q = plan?.quota ?? {};
  const used = Number(q.used ?? 0);
  const max = Number(q.max ?? 0);
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const byGate = new Map();
  for (const it of items) {
    // 【施工卡 ⑥-3】gate 值域扩到 `QUOTA_GATES`（新增 `quota-kind` / `quota-pool` / `quota-reserve`）；
    //   `quota-day` / `quota-tick` 两个老值的行为与判定一字未改。
    const g = it?.quotaGate ?? it?.reason ?? null;
    const gate = (typeof g === 'string' && QUOTA_GATES.includes(g)) ? g : null;
    if (!gate) continue;
    if (it?.verdict !== 'queue') continue;          // 只认"被额度拦下"的条目；其它 verdict 不是额度降级
    const cell = byGate.get(gate) ?? { gate, blockedCount: 0, actionId: null };
    cell.blockedCount += 1;
    const id = it?.sessionId ?? it?.taskId ?? null;
    if (cell.actionId === null && id) cell.actionId = String(id);
    byGate.set(gate, cell);
  }
  return [...byGate.values()]
    .sort((a, b) => String(a.gate).localeCompare(String(b.gate)))
    .map((c) => ({ at: now, kind, gate: c.gate, used, max, blockedCount: c.blockedCount, day, actionId: c.actionId }));
}

/** 读台账尾部已有行的去重键 `at|kind|day|gate`（只读尾 8KB，不读整文件；读不到 = 空集，退化为本轮内去重）。 */
function readLedgerTailKeys(file, maxBytes = 8192) {
  const keys = new Set();
  try {
    if (!fs.existsSync(file)) return keys;
    const size = fs.statSync(file).size;
    if (!(size > 0)) return keys;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    let text = buf.toString('utf8');
    if (start > 0) {
      // 从尾部切进来的**半行**丢掉（否则首行 JSON 必坏、静默漏去重）
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t);
        if (j?.at && j?.kind && j?.day && j?.gate) keys.add(`${j.at}|${j.kind}|${j.day}|${j.gate}`);
      } catch { /* 坏行/半行忽略：去重降级，不影响追加 */ }
    }
  } catch { /* 读不到 = 当作"无历史"：最坏结果是多写一行，绝不因此不写 */ }
  return keys;
}

/**
 * 追加本轮额度降级记录（**失败不阻断**：只 `alert(warn)`，降级本身照旧发生）。
 * @param {object} plan planner 产物（含 `quota` / `items` / `kind` / `day`）
 * @param {{home?:string, now?:number, kind?:string, day?:string}} [opts]
 * @returns {{ok:boolean, file:string, written:number, skipped:number, rows:Array, error:string|null}}
 */
export function appendQuotaDegrades(plan, opts = {}) {
  const rows = extractQuotaDegrades(plan, opts);
  const file = quotaLedgerPath(opts);
  const out = { ok: true, file, written: 0, skipped: 0, rows, error: null };
  if (!rows.length) return out;
  try {
    const seen = readLedgerTailKeys(file);
    const lines = [];
    for (const r of rows) {
      const key = `${r.at}|${r.kind}|${r.day}|${r.gate}`;
      if (seen.has(key)) { out.skipped += 1; continue; }
      seen.add(key);
      const line = JSON.stringify({ ...r, schemaVersion: QUOTA_LEDGER_SCHEMA });
      if (Buffer.byteLength(line, 'utf8') > QUOTA_LEDGER_MAX_LINE) {
        // 超长只告警、不丢弃：行变长会削弱"单次写原子"的无锁依据，如实提示（不静默截断）
        alert({ level: 'warn', source: 'butler-auto', message: `额度台账单行超长（${Buffer.byteLength(line, 'utf8')}B > ${QUOTA_LEDGER_MAX_LINE}B），无锁依据受影响`, detail: { file, line } }, { home: opts.home });
      }
      lines.push(line);
    }
    if (lines.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const r = appendStateText(QUOTA_LEDGER_FILE, lines.join('\n') + '\n', {
        home: opts.home, write: (p, t) => fs.appendFileSync(p, t, 'utf8'),
      });
      if (!r.ok) throw new Error(`双写失败（${r.kind ?? 'unknown'}）：${(r.failures?.[0] ?? {}).error ?? 'unknown'}`);
      out.written = lines.length;
    }
  } catch (e) {
    out.ok = false;
    out.error = e?.message ?? String(e);
    alert({ level: 'warn', source: 'butler-auto', message: `额度降级台账写入失败（降级本身不受影响）：${out.error}`, detail: { file, rows } }, { home: opts.home });
  }
  return out;
}

/**
 * 读台账汇总（日报「🎫 额度与降级」段 / 面板 `quotaGate` 的数据源；只读、不写）。
 *
 * 语义分界（⑥ 包 §6 表 3 审核批注 A17）：
 *   · 文件不存在  ⇒ `available:true` + 全 0 —— **不是"不可用"**（从未降级 = 正常绿）；
 *   · 读失败 / 存在但一行都解析不出 ⇒ `available:false` —— 调用方必须**显式报"未观测"**，**不许判 0**。
 * @param {{home?:string, now?:number, day?:string, onlyToday?:boolean}} [opts]
 */
export function readQuotaLedger(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const day = String(opts.day ?? localDay(now));
  const filterDay = opts.onlyToday === false ? null : day;
  const out = {
    ok: true, available: true, file: quotaLedgerPath(opts), day, filterDay, exists: false,
    lines: 0, badLines: 0, degradedBatches: 0, blockedCount: 0,
    byKind: {}, byGate: {}, firstAt: null, lastAt: null, last: null, error: null,
  };
  try {
    if (!fs.existsSync(out.file)) return out;
    out.exists = true;
    const txt = fs.readFileSync(out.file, 'utf8');
    let parsed = 0;
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      out.lines += 1;
      let j = null;
      try { j = JSON.parse(t); } catch { j = null; }
      if (!j || typeof j !== 'object') { out.badLines += 1; continue; }
      parsed += 1;
      const at = Number(j.at ?? 0) || null;
      if (at) {
        if (!out.firstAt || at < out.firstAt) out.firstAt = at;
        if (!out.lastAt || at >= out.lastAt) { out.lastAt = at; }
      }
      if (filterDay && String(j.day ?? '') !== filterDay) continue;
      const kind = String(j.kind ?? 'unknown');
      const gate = String(j.gate ?? 'unknown');
      const blocked = Number(j.blockedCount ?? 1);
      out.degradedBatches += 1;
      out.blockedCount += Number.isFinite(blocked) ? blocked : 1;
      out.byKind[kind] = Number(out.byKind[kind] ?? 0) + 1;
      out.byGate[gate] = Number(out.byGate[gate] ?? 0) + 1;
      out.last = { at, kind, gate, used: Number(j.used ?? 0), max: Number(j.max ?? 0), blockedCount: Number.isFinite(blocked) ? blocked : 1, actionId: j.actionId ?? null };
    }
    if (out.lines > 0 && parsed === 0) {
      out.available = false;
      out.ok = false;
      out.error = `台账 ${out.lines} 行全部无法解析（判"不可用"，不判 0）`;
    }
  } catch (e) {
    out.ok = false;
    out.available = false;
    out.error = e?.message ?? String(e);
  }
  return out;
}

/** 本地短时间（MM-DD HH:mm），段文案用。 */
function shortTime(ts) {
  const n = Number(ts ?? 0);
  if (!(n > 0)) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 日报段「🎫 额度与降级」的行（**渲染在库、可注入依赖** ⇒ 段渲染失败可被演练夹具触发，判据 12）。
 *
 * 三节：① 今日额度 + `quotaByKind` 分账（判定唯一源 = `checkDailyLimit`）② 降级台账 ③ 未验证动作（影子对账）。
 * 纪律（①包 P-5 第 3 条）：**判定不可用必须显式成段** —— ①节失败 ⇒ 整段显式"降级"（不静默留空）；
 *   ②节台账不可用 ⇒ 显式"未观测、不判 0"；③节判定不可用 ⇒ 显式"未观测、不判无"。
 * @param {{home?:string, now?:number, day?:string, shadow?:object, deps?:object}} [opts]
 * @returns {string[]}
 */
export function quotaSectionLines(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = Number(opts.now ?? Date.now());
  const day = String(opts.day ?? localDay(now));
  const shadow = opts.shadow ?? null;
  const deps = { readLimits, readActionsState, checkDailyLimit, readQuotaLedger, ...(opts.deps ?? {}) };
  const head = ['## 🎫 额度与降级', ''];
  const lines = [];

  // ① 今日额度 + 分账（判定与渲染同节：这里失败 = 段渲染失败 ⇒ 显式降级整段）
  try {
    const limits = deps.readLimits({ home });
    const state = deps.readActionsState({ home });
    const daily = deps.checkDailyLimit(state, day, limits.maxAutoActionsPerDay);
    const quotaByKind = state?.daily?.[day]?.quotaByKind ?? {};
    lines.push(`- 今日额度（${day}）：**${daily.used}/${daily.max}**${daily.reached
      ? ' ⚠️ **已达上限** ⇒ 其后的自动动作按额度降级为「只排队，不注入」'
      : ''}（护栏文件：\`${limits._file ?? '?'}\`，来源 ${limits._source ?? '?'}）`);
    const qk = Object.entries(quotaByKind).sort((a, b) => Number(b[1]) - Number(a[1]));
    lines.push(qk.length
      ? `- 分账 \`quotaByKind\`（**只计真占配额**的条目：\`consumesQuota!==false\` 且非 dry-run）：${qk.map(([k, v]) => `\`${k}\` ×${v}`).join('、')}`
      : '- 分账 `quotaByKind`：今日尚无占配额的自动动作（空）。');
    lines.push('  - 口径注：老字段 `byKind` 是**全量混合**（含不占配额与 dry-run），不能当"谁吃了额度"用 —— 分摊看本行。');
  } catch (e) {
    return [...head, `_（额度与降级段降级：${String(e?.message ?? e)}）_`];
  }

  // ② 降级台账（读侧；不可用 ⇒ 显式"未观测"，不判 0）
  try {
    const ledger = deps.readQuotaLedger({ home, day });
    if (!ledger.available) {
      lines.push(`- 🔴 额度降级台账**不可用**（\`${ledger.file}\`：${ledger.error}）⇒ 本次**未观测**，**不判 0**`);
    } else if (ledger.degradedBatches > 0) {
      const kinds = Object.entries(ledger.byKind).map(([k, v]) => `\`${k}\` ×${v}`).join('、');
      const gates = Object.entries(ledger.byGate).map(([g, v]) => `${g} ×${v}`).join('、');
      lines.push(`- ⚠️ **今日降级：${ledger.degradedBatches} 次**（被拦 ${ledger.blockedCount} 条）｜按动作：${kinds}｜按闸：${gates}`
        + `｜最近一次 ${shortTime(ledger.last?.at)} \`${ledger.last?.kind}\` ${ledger.last?.gate}（${ledger.last?.used}/${ledger.last?.max}）`);
      lines.push('  - 说明：降级 = 「本可执行、因额度只排队」；台账见额度台账（状态目录下，append-only）。');
    } else {
      lines.push(`- 今日降级：**0 次**（台账${ledger.exists ? `已有 ${ledger.lines} 行历史` : '尚未建立 = 从未发生降级'}）`);
    }
  } catch (e) {
    lines.push(`- 🔴 额度降级台账读取**异常**（${String(e?.message ?? e)}）⇒ 本次**未观测**，**不判 0**`);
  }

  // ③ 未验证动作（已放行 × 无预测；判定在 lib/shadow-view.mjs，这里只渲染）
  try {
    const unobs = shadow?.unobserved ?? [];
    if (unobs.length) {
      lines.push(`- ⚠️ **未验证动作**（已放行但窗口内 0 条预测 = 未观测，**不得据此判"一致"**）：${unobs.map((r) => `\`${r.kind}\``).join('、')}`);
    } else if (shadow?.releaseUnavailable) {
      lines.push('- ⚠️ **未验证动作**：放行判定**不可用**（模块快照读取失败）⇒ 本次未观测，**不判"无"**');
    } else if (shadow === null || shadow === undefined) {
      lines.push('- ⚠️ **未验证动作**：影子视图**未就绪**（采集失败）⇒ 本次未观测，**不判"无"**');
    } else {
      lines.push('- 未验证动作：无（已放行的动作在窗口内均有预测）。');
    }
  } catch (e) {
    lines.push(`- ⚠️ **未验证动作**：判定**不可用**（${String(e?.message ?? e)}）⇒ 本次未观测，**不判"无"**`);
  }

  return [...head, ...lines];
}

export { sha256 };
