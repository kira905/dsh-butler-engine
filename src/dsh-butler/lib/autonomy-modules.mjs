// dsh-butler / lib/autonomy-modules.mjs —— **模块级熔断开关（kill switch L2）**
//
// 由来：the operator 2026-09-13 定「开关要活的——哪个模块坏了，直接关掉再去修」。
//   · L0 全局降档  = butler-autonomy-state.json 的 level（lib/autonomy-state.mjs）
//   · L1 总开关    = butler-autonomy.json 四键（lib/autonomy.mjs）
//   · L2 **模块级** = 本文件（butler-autonomy.json 的 `modules` 段）
//   · L3 动作级    = lib/autonomy-actions.mjs + butler-autonomy-limits.json
//
// **有效值 = 降档 normal（L0） && 归属总开关开（L1，若有） && 模块 enabled（L2）**。
//
// fail-safe 铁律：文件缺失 / 读失败 / 损坏 → **一律按「关」处理**（宁可少做一次自动动作）。
//   · 文件里**没有**该模块的键 → 取该模块登记表里的 `baseline`（已上线模块 = true，未上线的 = false），
//     这样"首次建立 baseline"不会误关已经跑着的模块；
//   · 文件**读不到/损坏** → 全部 false（保守）。
//   · 未登记的模块 id → 一律 false（未登记 = 不可用，防"手打 id 打开任意东西"）。
//
// 【2026-09-13 卡：4 处无运行时开关收口】两处语义扩展：
//   ① `scope: 'infra'`（基础设施类：守护鱼 / tickd 调度 / P5 保护区清单 / 标题插件）
//      —— 它们是「保命 + 观测」件，不是"自主动作"：**只受 L2 显式开关约束，不受 L0 降档 / L1 四键牵连**。
//      理由：降档本身可能由配置损坏触发（fail-safe=degraded），若把守护鱼/调度器一并停掉，
//      一次损坏就会让生态失去自愈与观测能力（fail-safe 反向踩雷）。
//   ② `failSafe: 'baseline'`（同上 4 件）—— 文件**读不到/损坏**时**保持现状（baseline）**，不判"关"。
//      理由：kill switch 的语义是"the operator显式拨的闸"；读不到配置 = 没人在拨闸 ≠ the operator要求关闭。
//      对这类件，"保守"= 维持现状（否则会静默停摆 / 悄悄放松保护），而不是"少做动作"。
//      ⚠️ 显式写进文件的 `enabled:false` 一律照办（那才是有 since/by/why 的熔断动作）。
//
// 写入走 writeJsonAtomic（原子写）+ 落审计（appendAudit），并维护 `moduleHistory`（最近 100 条）。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './paths.mjs';
import { writeJsonAtomic, readJson, updateJson } from './store.mjs';
import { appendAudit } from './audit.mjs';
import { autonomyPath, AUTONOMY_SCHEMA, defaultAutonomy, readAutonomy } from './autonomy.mjs';
import { readAutonomyState, LEVEL_NORMAL } from './autonomy-state.mjs';

export const MODULES_VERSION = '0.1.0';
export const MODULE_HISTORY_KEEP = 100;

/** L1 总开关键 → lib/autonomy.mjs 的 effective kind 键
 *  【P8 [12] · 2026-09-28】加 `p8AutoEnabled: 'p8-auto'` —— **不加则 P8 模块门永久拒动**
 *  （`owner` 查 `effective[kind]` 时拿不到 kind ⇒ ownerOn 恒 false）。
 *  依据：设计档 §「口径已拍板」第 4 条明文「`lib\autonomy-modules.mjs:40` 的 `OWNER_TO_KIND`
 *  要加 `p8AutoEnabled:'p8-auto'`（不加则永久拒动）」。 */
const OWNER_TO_KIND = { p3AutoEnabled: 'p3-auto', autoHealEnabled: 'auto-heal', p8AutoEnabled: 'p8-auto' };

/**
 * 模块登记表（**唯一真相源**：未登记 id 一律不可用）。
 *   owner   : 归属的 L1 总开关键（null = 不受四键约束，如"已上线的只读/既有自治成员"）
 *   rawOwner: **通道级**再读的第二把 raw 键（仅当它 ≠ owner 时登记；见下「L1 归属口径」）
 *   baseline: 文件里没有该键时的取值（= 现状基线；已上线的 true，未上线的 false）
 *   scope   : 'action'（默认，自主动作）| 'infra'（基础设施，不受 L0/L1 牵连）
 *   failSafe: 'off'（默认：读不到 → 判关）| 'baseline'（读不到 → 保持现状）
 *   pseudo  : **伪模块行**（不是独立模块，不得当独立开关判定）—— ① 包冻结项② 的机器可读落地；
 *             为 true 时必须同时写 `pseudoWhy`（为什么它不是独立模块）
 *   noOwnerWhy: **所有 `owner:null` 成员（含 `scope:'infra'`）的必填理由**（② 准入表地基包 A-8）——
 *             写明"不受四键约束"的原因，不许留空（空 = 失败无人负责、也不在可观测面内）。
 *             ⚠️ 2026-09-17 施工卡 ②-6 起**收口为 8/8 全填写**（infra 4 条也补齐）：`registry-audit` 的 M5
 *             断言**不再豁免 infra** —— 那 4 条 infra 成员同样是"四键关不掉、坏了没人负责"，
 *             A-8 的可见化口径必须覆盖全部 8 条（出口 = 日报段「不受四键约束的自治成员」）。
 *   ⚠️ 以上三个标注字段（pseudo / pseudoWhy / noOwnerWhy）**只作声明与呈现**，
 *      **一字不改判定**：`checkModuleAllowed()` 读的仍是 `owner` + `scope` + `failSafe`（见下）。
 *      跨表校验器 = `lib/registry-audit.mjs`（施工卡 ②-1）。
 *
 * 【L1 归属口径（2026-09-13 卡 ac3f9038 拍板① 统一）】放行一个动作实际要过几道闸：
 *   ① 本文件的**模块门** `checkModuleAllowed()` → 读 `owner`；
 *   ② 通道级的 `autoAllowed(kind)`（lib/autonomy.mjs 的 AUTO_KINDS）→ 读 `owner && raw`；
 *   ③ `lib/autonomy-actions.mjs` 的 `runAction()` **恒查** `p3-auto`（位置：dry-run 通道之后）。
 *   所以真实口径：
 *     · p0-auto-restart : p3AutoEnabled && p0AutoRestartEnabled            —— 两把键
 *     · p5-auto-rollback: p3AutoEnabled && autoHealEnabled && p5AutoRollbackEnabled —— 三把键
 *   （p0 的 p3 与 runAction 恒查的 p3 是同一把；p5 的 p3 来自 runAction，另两把来自通道级。）
 *   `rawOwner` 只用于**回报与呈现**（readModules / describeModules / checkModuleAllowed 的 rawOwnerOn），
 *   **绝不参与 allowed 判定** —— 加它一行都不会改变既有闸门行为。
 */
export const MODULE_IDS = {
  'p2-watch': {
    label: 'P2 会盯人（事件判定 + 推送/报告）', owner: null, baseline: true, note: '已上线；裸跑期观测中',
    noOwnerWhy: '已上线自治成员：P2 是观测/推送线，与四键的「自主动作」语义不同族 ⇒ 不吃四键；'
      + '仍吃 L0 降档（checkModuleAllowed 对非 infra 恒判 degraded）+ 本模块 L2 开关',
  },
  'p4-pitfall-write': {
    label: 'P4 会学习（坑库渲染 + 候选池写入）', owner: null, baseline: true, note: '已上线',
    noOwnerWhy: '已上线自治成员：P4 随 tickd job 渲染坑库/写候选池，不是四键所管的"有闸自主动作" ⇒ 不吃四键；'
      + '仍吃 L0 降档 + 本模块 L2 开关',
  },
  'p6-discovery': {
    label: 'P6 自动探源（候选落盘/建议，不自动启用）', owner: null, baseline: true, note: '已上线',
    noOwnerWhy: '已上线自治成员：P6 只落候选与建议、不执行动作 ⇒ 与四键（自动执行闸）不同族，不吃四键；'
      + '仍吃 L0 降档 + 本模块 L2 开关',
  },
  'archive-sessions': {
    label: '会话自动归档（dsh-archive-sessions）', owner: null, baseline: true, note: '已上线：>48h 无未闭合 turn 物理移出',
    noOwnerWhy: '已上线自治成员：归档按「>48h 无未闭合 turn」这条客观判据自动跑，不是四键所管的动作族 ⇒ 不吃四键；'
      + '仍吃 L0 降档 + 本模块 L2 开关',
  },
  'queue-wake': { label: '队列推进自动叫醒（待验收卡叫醒空闲会话）', owner: 'p3AutoEnabled', baseline: false, note: '现只到 report 档' },
  // 【卡死会话自愈链 · 2026-10-10】实现 = `lib/stuck-recovery.mjs`（方案 `docs/`）。
  //   治：整夜链路里"会话卡死/回合被打断"后**无人叫醒**（2026-10-10 凌晨静默 6.8h 实证）。
  //   · owner = `p3AutoEnabled`（本模块是生态自治动作族成员，与 queue-wake 同族判据）
  //   · `baseline:false` = **默认关**（配置文件无该键 ⇒ 判关；放行 = `stuck-recovery-cli.mjs on --apply`）
  //   · ⚠️ 本模块**只注入提醒文本**；自动重启**不自建通道** —— 复用既有 `p0-auto-restart`（低水位 + 通道闸）
  'stuck-recovery': {
    label: '卡死会话自愈链（提醒×2 → 自动重启请求 → 重启后补注入 → 升级报警）', owner: 'p3AutoEnabled', baseline: false,
    note: '2026-10-10 落地：判定复用 watch-collect 的 stuck；重启走 p0-auto-restart；每会话每天 2 次提醒',
  },
  // 【P8 [12] · 2026-09-28】本地块**已落地**（原 note = 「待开发」）：
  //   · **owner 由 `p3AutoEnabled` 改为 `p8AutoEnabled`** —— the operator 2026-09-10 16:36 拍板
  //     「p8-auto 独立自主（不挂在 p3-auto 之下）」+ 设计档 §「口径已拍板」第 4 条。
  //     ⇒ P8 搬移的放行 = L0 正常 × `p8AutoEnabled`（本行 owner）× `modules['p8-tidy']`（本行 L2），
  //       **不并** `runAction` 的四键那道恒查（P8 动作体自己过闸，见 lib/tidy-move.mjs 的 resolveMoveGate）。
  //   · `baseline:false` = **默认关**（配置文件里没有该键 ⇒ 判关；放行 = `module on p8-tidy`）。
  //   · 实现体 = `lib/tidy-move.mjs`（observe / dry-run / apply 三档）+ `butler-tidy-move.mjs`（CLI）。
  //   · ⚠️ 本卡（P1 期）**只跑 observe 档**，开关保持关；真搬（P3 期）须 observe 两周零误报 + the operator明说。
  'p8-tidy': {
    label: 'P8 临时区自动收纳（L2 搬移 · 只搬不删 · 可一键回滚）', owner: 'p8AutoEnabled', baseline: false,
    note: 'P1 期已实现（2026-09-28）：observe/dry-run 零副作用可跑，apply 须过独立闸（L0 × p8AutoEnabled × modules[p8-tidy]）+ 抢 handoff 锁；'
      + '真搬默认关（P3 期须 observe 两周零误报 + the operator明说）；实现体 = lib\\tidy-move.mjs',
  },
  'p9-handoff': { label: 'P9 交接自动钩子（开机/收工自动交接）', owner: 'p3AutoEnabled', baseline: false, note: '待开发' },
  // 【伪模块行（① 包冻结项②）】p3-auto **不是独立模块**：它是 P3 整族的总闸行 ——
  //   呈现/判定层不得把它当"可单独关的模块"（关它 = 关整族）。
  'p3-auto': {
    label: 'P3 全部 L1/L2 自动动作（整族）', owner: 'p3AutoEnabled', baseline: false, note: 'L3 动作级在其之下',
    pseudo: true,
    pseudoWhy: '整族总闸行，不是独立模块：它没有自己的执行体，只表达「P3 全族」这把 L1 键（① 包冻结项②：伪模块行不参与独立判定 ⇒ 呈现层必须标"总闸、非独立模块"）',
  },
  'p5-auto-rollback': {
    label: 'P5 B 层自动回滚', owner: 'autoHealEnabled', rawOwner: 'p5AutoRollbackEnabled', baseline: false,
    note: '待开发；放行 = p3AutoEnabled + autoHealEnabled + p5AutoRollbackEnabled 三把键（前两把模块门/通道级，第三把通道级 raw；p3 另由 runAction 恒查）',
  },
  'p0-auto-restart': {
    label: 'P0 低水位自动重启（无the operator显式请求）', owner: 'p3AutoEnabled', rawOwner: 'p0AutoRestartEnabled', baseline: false,
    note: '待开发；放行 = p3AutoEnabled + p0AutoRestartEnabled 两把键（p3 既是模块门 owner 亦由 runAction 恒查，p0raw 走通道级）',
  },
  'auto-heal': { label: '组件自修复的自动修复分支', owner: 'autoHealEnabled', baseline: false, note: '待开发' },
  // 2026-09-16（卡：P3 自主动作 ctx-guard · 上下文看门）：
  //   语义 = 会话上下文用量超软限/硬限时，向**正在跑**的会话投递「移交」提醒。
  //   ⚠️ **2026-09-24（卡「夜批03 · 投递分级实现」）**：投递分两档 —— 软限 = `queue`（不打断，旧行为）；
  //     硬限 = **可 `steer`**（step 边界插话、不 abort 工具），但**默认关**（开关 = `butler-autonomy-limits.json`
  //     的 `ctxGuard.steer.enabled`，未配置即关）+ 危险动作豁免名单（判据唯一源 `lib/steer-gate.mjs`，
  //     卡执行会话一律不进名单）。动作风险级同步 **L1 → L2**（如实升档）。
  //   baseline=false：**默认关**（本卡只交付"能跑但默认关"；放行 = 改开关，不是改代码）。
  //   放行口径 = p3AutoEnabled（模块门 owner）+ modules['ctx-guard']（本表）+ runAction 恒查的 p3-auto 总闸。
  //   ⚠️ 注意区分两层"默认关"：**模块门开关**（本表，生产已放行 = true）≠ **硬限 steer 开关**
  //     （`ctxGuard.steer.enabled`，**未配置 = 关**；两者互不影响，本卡未改前者）。
  'ctx-guard': { label: '上下文看门（超阈值提醒在跑会话移交工作）', owner: 'p3AutoEnabled', baseline: false, note: '待放行：默认关；dry-run/观察档可跑' },
  // 【K5b · 2026-09-28】看板周期归档（P2 自动动作 `board-line-archive` 的同名 L2 模块位，`moduleKind:'own'`）。
  //   为什么必须登记：`AUTO_ACTION_KINDS` 该行声明 `moduleKind:'own'` ⇒ `registry-audit` 的 A3 要求
  //   **同名模块行存在**（否则报红）；且 `lib\shadow-view.mjs` 的 `ACTION_MODULES` 是派生视图
  //   （值取自动作表 `moduleId`）⇒ 本行落定后影子视图自动含该 kind（**不手改 shadow-view**）。
  //   `owner: 'p3AutoEnabled'`（与 `ctx-guard` 同族口径：既作模块门 owner，亦由 `runAction()` 恒查）。
  //   `baseline: false` = **默认关**（配置文件里没有 `modules['board-line-archive']` 键 ⇒ 判关；放行 = `module on board-line-archive`）。
  //   ✅ **2026-09-28 K5d：模块门已接线 + 已放行**（原"如实登记：本模块门当前未接线"一句就此失效）——
  //     动作体 `lib\board-line-archive.mjs` 已调 `checkModuleAllowed()`（dry-run 不受限；有候选且门关 ⇒ blocked），
  //     tickd 调用点已接（job `board-line-archive`，每 30 分钟），开关已 `module on board-line-archive`。
  //     关回 = `butler-autonomy-cli.mjs module off board-line-archive`（一键 ⇒ 真执行 blocked）。
  'board-line-archive': {
    label: '看板周期归档（整线"在板全完成"→ 逐线调既有归档命令；单轮上限 + 默认 dry-run）',
    owner: 'p3AutoEnabled', baseline: false,
    note: '已放行（2026-09-28 K5d · the operator当日 10:19「K5 接闸门，然后放行」）：模块门已接线进动作体 + tickd 调用点每 30 分钟；'
      + '关回 = module off board-line-archive（真执行立即 blocked）。实现体 = lib\\board-line-archive.mjs',
  },
  // 【施工卡 ④-3 · ④ 包 U-1「登记」】插件自动升级链（🟢/🟡 档）。
  //   `owner: null` = **不吃生态四键**：本链的总闸是**独立闸文件** `~/.dsh/upgrade-automation.json` 的 `enabled`
  //     （fail-closed：文件缺失 / 不可解析 ⇒ 关），不并入四键 —— 叠第二把总闸会出现"两把总闸谁说话"的歧义
  //     （④ 包方案 §11 **D-2** 建议值 (b)；⚠️ 该条**待the operator拍板**，本登记按建议值落并如实标注）。
  //   `baseline: false` = **默认关**（配置文件里没有该键 ⇒ 判关；已上线件才写 true）。
  //   家规接入点 = L0 降档闸 + 升级锁（二者由 orchestrator 在 `--run` 路径上恒查，不靠本行判定）。
  //   ⚠️ 本行**不改变任何既有判定**：`checkModuleAllowed()` 读的仍是 `owner` + `scope` + `failSafe`，
  //      新增的只有"可关性 + 可见性"（本行 = 一个可单独关的 L2 模块开关位）。
  'auto-upgrade': {
    label: '插件自动升级链（🟢/🟡 档）', owner: null, baseline: false,
    note: '未放行：总闸 = ~/.dsh/upgrade-automation.json（现况**缺失 = 关**）；已实现（dry-run 可跑），实现体 = tools\\dsh-upgrade-orchestrator.mjs',
    noOwnerWhy: '本链总闸 = ~/.dsh/upgrade-automation.json 的 enabled（独立闸文件、fail-closed）——不并入四键，'
      + '避免"两把总闸谁说话"；家规接入点 = L0 降档闸 + 升级锁 + 登记可查性（④ 包 §3.1 的 noOwnerWhy 原文口径）。'
      + '【A-8 可见化】正因没有 L1 键，四键全关也关不掉它、放行也管不到它 ⇒ 列入日报「不受四键约束的自治成员」段。',
  },
  // ── 【2026-11-02 · 卡 6f121702「协调线·脑子」】`steward`：协调线脑子（甲层批处理）的 L2 开关位 ──────
  //   语义 = tickd job `steward` 每天 08:20 只读产物（看板 / 晨报 / 年轮 json）→ 排序 → 算收敛线 →
  //     写自己的流水账（`~/.dsh/steward-state.json`）。**零模型调用、零 token**（方案 §1.1 甲层）。
  //   `owner: null` = **不吃四键**：它是只读/观测线（同 `p2-watch` / `p4-pitfall-write` 同族口径），
  //     不是"有闸自主动作" ⇒ 与四键（自动执行闸）不同族；仍吃 L0 降档 + 本行 L2 开关。
  //   `baseline: true` = 已上线（本卡交付即上线；关它的唯一正规入口 = `module off steward`）。
  //   ⚠️ 本行**不改变任何既有判定**：`checkModuleAllowed()` 读的仍是 owner + scope + failSafe。
  //   ⚠️ 与 job 开关的关系：`job off steward` 停调度、`module off steward` 停模块位 —— 两者都开才能跑，
  //     但本件**不自查模块门**（只读件不该因为一个开关位而静默不跑），模块位管的是"呈现 + 可关性"。
  'steward': {
    label: '协调线·脑子（读产物→排序→算收敛线→写流水账 · 零 token · 不叫停不建卡）', owner: null, baseline: true,
    note: '2026-11-02 上线：tickd job `steward` 每天 08:20；写者唯一 = 该 job（锁 `steward` 登记在 lib\\butler-locks.mjs）；'
      + '「嘴」会话只读不写；实现体 = tools\\dsh-butler\\steward.mjs',
    noOwnerWhy: '已上线自治成员：协调线脑子只读现成产物（standup / 看板 / 年轮 json）并只写自己那份流水账，'
      + '**不做任何自动动作**（方案 §3.1 写死：不叫停、不砍线、不重派、不建卡、不验收、不发喊话）'
      + '⇒ 与四键（"自动执行闸"）不同族，不吃四键；仍吃 L0 降档 + 本行 L2 开关。',
  },
  // ── 【2026-11-04 · 协调线 P3「防偷偷缩目标」】`mainline-anchor`：锚检测的 L2 开关位 ──────────
  //   语义 = tickd job `mainline-anchor` 每 2 分钟读「年轮锚 + 上一份快照」，判「锚被动过 / 没推进 /
  //     两机各一份」三档，落 `_archive\anchor-snapshots\` 与 `docs/`。
  //   `owner: null` = **不吃四键**：它是纯观察线（同 `p2-watch` / `p4-pitfall-write` / `steward` 同族），
  //     不是"有闸自主动作" ⇒ 与四键（自动执行闸）不同族；仍吃 L0 降档 + 本行 L2 开关。
  //   `baseline: true` = 已上线（本卡交付即上线）；关它的正规入口 = `job off mainline-anchor`
  //     （调度）+ `module off mainline-anchor`（模块位）。两者都开才跑；本件**不自查模块门**
  //     （只读件不该因为一个开关位静默不跑，同 steward 口径），模块位管的是"呈现 + 可关性"。
  //   ⚠️ 本行**不改变任何既有判定**：`checkModuleAllowed()` 读的仍是 owner + scope + failSafe。
  'mainline-anchor': {
    label: '锚检测（防缩目标：三档判定 + 快照基线 · 只读判定 / 只写自己那份快照 · 零投递）',
    owner: null, baseline: true,
    note: '2026-11-04 上线：tickd job `mainline-anchor` 每 2 分钟；写者唯一 = 该 job'
      + '（锁 `mainline-anchor` + 按线动态锁 `mainline-anchor:<lineId>`，登记在 lib\\butler-locks.mjs）；'
      + '实现体 = tools\\dsh-butler\\anchor-watch.mjs（建锚 = anchor-init.mjs）',
    noOwnerWhy: '已上线自治成员：锚检测是**纯观察**（只读年轮锚/看板/线表，只写自己那份快照与日报），'
      + '不投递、不占 msg 日配额、不写 lastNotifiedAt（三红线①）⇒ 与四键（"自动执行闸"）不同族，不吃四键；'
      + '仍吃 L0 降档 + 本行 L2 开关。',
  },
  // ---- 基础设施类（2026-09-13 卡：给 4 处无运行时开关的组件装活开关）----
  'session-title-live': {
    label: '会话标题插件（回合打标【运行】/【完成】+ 全量重生成标题）', owner: null, baseline: true,
    scope: 'infra', failSafe: 'baseline',
    note: '关 = 停回合打标 + 停标题生成（generate 直接拒绝，不调 LLM 不烧 token）；插件本身仍在加载',
    noOwnerWhy: '基础设施类（scope:infra）：标题插件在 DSH 进程内按回合边界打标、按需重生成标题，'
      + '不是四键所管的「有闸自主动作」⇒ 不吃四键；它的"关" = L2 模块开关（modules.session-title-live.enabled=false）'
      + '且走 failSafe=baseline（配置读不到时**保持现状**，不判关）。'
      + '【A-8 可见化】正因没有 L1 键，四键全关也关不掉它、放行也管不到它 ⇒ 列入日报「不受四键约束的自治成员」段。',
  },
  'tickd-jobs': {
    label: '常驻 tickd 调度（全部 job 的总闸）', owner: null, baseline: true,
    scope: 'infra', failSafe: 'baseline',
    note: '关 = 所有 job 停跑（进程仍在、心跳照写）；单 job 另有 jobs.<id> 开关',
    noOwnerWhy: '基础设施类（scope:infra）：它是全部 tickd job 的调度总闸，自身有 L2 开关、单 job 另有 jobs.<id> 开关，'
      + '不属四键（生态自主动作闸）的判定对象 ⇒ 不吃四键；failSafe=baseline（配置读不到时保持现状）。'
      + '【A-8 可见化】没有 L1 键 ⇒ 四键关不掉它、放行也管不到它 ⇒ 列入日报「不受四键约束的自治成员」段。',
  },
  guard: {
    label: '守护鱼自动动作（拉起 / 强杀 / 唤醒分身）', owner: null, baseline: true,
    scope: 'infra', failSafe: 'baseline',
    note: '关 = 只观测（探活+日志照旧，不 kill/不 relaunch/不唤醒分身）；⚠️ 不是"停掉守护鱼进程"',
    noOwnerWhy: '基础设施类（scope:infra）：守护鱼的自动动作（拉起 / 强杀 / 唤醒分身）是**保命件**，'
      + '走 L2 模块开关 + failSafe=baseline（读不到配置时保持现状），不在四键判定范围内 ⇒ 不吃四键；'
      + '关它 = 只观测（探活与日志照旧，不 kill/不 relaunch/不唤醒分身），**不是**停掉守护鱼进程。'
      + '【A-8 可见化】没有 L1 键 ⇒ 四键关不掉它 ⇒ 列入日报「不受四键约束的自治成员」段。',
  },
  'p5-protected-paths': {
    label: 'P5 保护区清单（A 层写前拦截 + B 层写后审计的判定源）', owner: null, baseline: true,
    scope: 'infra', failSafe: 'baseline',
    note: '关 = 清单清空（不拦不审）；⚠️ 读不到配置时**保持保护**（保护类组件的保守方向）',
    noOwnerWhy: '基础设施类（scope:infra）：保护区清单是 A 层写前拦截 / B 层写后审计的**判定源**，属保护类组件'
      + '（读不到配置时**保持保护**），不是四键所管的动作族 ⇒ 不吃四键；关它 = 清单清空（不拦不审），走 L2 模块开关 + failSafe=baseline。'
      + '【A-8 可见化】没有 L1 键 ⇒ 四键关不掉它 ⇒ 列入日报「不受四键约束的自治成员」段。',
  },
  // 【卡 G24-S2a · 记忆引擎 v2（小会计线）登记】两条模块位 ——
  //   方案 §3.5「L2 模块登记」/ §4 登记义务：`MODULE_IDS` 增 `memory-distill` 与 `memory-recall`，
  //   各写明 owner 与 fail-safe 方向（读不到配置时判关），均 `baseline:false`（默认关，家规 R3 锁后交付）。
  //   归属线 = 小会计线（不是生态四键的动作族）：放行权在**各自的开关载体**上
  //   （distill → `butler-autonomy.json` 的 `jobs` 段；recall → 插件每轮读本段并自我 drain），
  //   再叠四键会出现"两把总闸谁说话"的歧义（理由同 `auto-upgrade` 行的独立闸口径）。
  //   本行只加"可关性 + 可见性"，不改变任何既有判定：`checkModuleAllowed()` 读的仍是 owner + scope + failSafe。
  'memory-distill': {
    label: '记忆提炼 job（小会计 · 记忆引擎 v2 · 向量聚类 → LLM 提炼）', owner: null, baseline: false,
    note: '未放行：默认关（键缺失 ⇒ 判关）；开关载体 = autonomy 配置的 jobs.memory-distill；'
      + '两层默认关的另一半 = 源码不写死 enabled:false（方案 D4 订正）；执行体在 S2c 落',
    noOwnerWhy: '归属小会计线（记忆引擎 v2），不属生态四键所管的「有闸自主动作」：放行由 jobs 段单键决定，'
      + '再叠四键会出现"两把总闸谁说话"；fail-safe = 读不到配置即判关'
      + '（readModules 缺键回落 baseline=false ⇒「关」）。【A-8 可见化】没有 L1 键 ⇒ 四键关不掉它也放行不了它。',
  },
  'memory-recall': {
    label: '记忆召回注入（小会计 · 记忆引擎 v2 · 每轮指针注入 agent/pre-step）', owner: null, baseline: false,
    note: '未放行：默认关（键缺失 ⇒ 判关）；**由插件自己每轮读本段并自我 drain**'
      + '（butler 无法热关 DSH 进程内的插件）；执行体在 S2b 落',
    noOwnerWhy: '归属小会计线（记忆引擎 v2）：注入发生在 DSH 进程内的 agent/pre-step 钩子里，butler 关不掉插件本身，'
      + '故「关」的落地形态 = 插件每轮读本段 + 自我 drain（读到关 ⇒ 本轮不注入）；'
      + 'fail-safe = 读不到配置即判关（不注入，宁可少注入也不越权注入）。'
      + '【A-8 可见化】没有 L1 键 ⇒ 四键关不掉它也放行不了它。',
  },
  // 【施工卡 S0 · 自动交接与会话接力（第 0 步前置）】登记 `relay` 模块位 ——
  //   方案 `docs/` §4.4 闸门 11 / §5.1 / §12 第 0 步 3（K-4 阻断级前置）。
  //   为什么必须登记：未登记时 `setModuleEnabled`（:302）硬拒写入、`isModuleEnabled`（:241）恒判
  //     `enabled:false` ⇒ 阶段 1 主路径**永不执行且无声**（CLI 直接报错，绕过 CLI 手改 JSON 也恒判关）。
  //   `owner`: 方案**未写死** ⇒ 本卡自决 = `p3AutoEnabled`（与 `ctx-guard` 同族：都是"自动对会话做动作"的
  //     P3 动作族，受四键 + L0 降档 + 本模块 L2 开关约束）；改它 = 改这一行（可改点）。
  //   `baseline:false` = 默认关（配置文件里没有该键 ⇒ 判关；已上线件才写 true）。
  //   ⚠️ **默认关是设计内状态、不是故障**（方案 §4.1「总开关初值与首次放行」· D-1 已拍）：阶段 1 一旦
  //     真生效会**自动开新会话（花钱）· 自动改另一个会话的标题 · 自动改绑看板卡** ⇒ 属乙档"必须先问the operator"；
  //     **首次放行属乙档**（须带 `--reason` + 留痕），**关回 = 甲档**，再放行仍按乙档（单向规则）。
  //   ⚠️ 总闸分两处：阶段 1（agent 侧）= `modules.relay.enabled`（本行）；阶段 2（tickd）= `jobs.relay.enabled`。
  //      **人工通道**（`--handoff --no-create --actor manual`）**不受总开关约束**（它是兜底手段）。
  //   ⚠️ 本行不改变任何既有判定：`checkModuleAllowed()` 读的仍是 `owner` + `scope` + `failSafe`。
  relay: {
    label: '自动交接与会话接力（写交接档 → 开接手会话 → 补标【已交接】）', owner: 'p3AutoEnabled', baseline: false,
    note: '未放行：默认关（键缺失 ⇒ 判关）；阶段 1 总闸 = modules.relay.enabled、阶段 2 = jobs.relay.enabled；'
      + '首次放行属乙档（自动开会话＝花钱 + 改他人会话标题 + 改绑看板卡）⇒ 须带 --reason + 留痕，关回 = 甲档；'
      + '人工通道（--handoff --no-create --actor manual）不受总开关约束',
  },
  // 【卡「冲刺600·M域记忆两项」· 2026-10-10】登记 `pitfall-vector-hook` 模块位 ——
  //   方案 `docs/` §A.2 **第 10 行**（tick-hook 消费方；原文备注
  //   「**也可由 `memory-vectors` job 定时扫**」）。落点 = `butler-memory-vectors-tick.mjs` 的 **④b 步**（默认关）。
  //   为什么必须登记：未登记时 `setModuleEnabled` **硬拒写入** ⇒ 没有"一键放行 / 一键关回"的载体。
  //   `owner: null` + `baseline: false`（照同族 `memory-recall` / `memory-distill` 口径）：归属记忆引擎线、
  //     不并入生态四键（避免"两把总闸谁说话"）；**默认关**（键缺失 ⇒ 判关 ⇒ 与接线前行为逐字等价）。
  //   关的落地形态 = 每轮 tick 现读本键（读到关 ⇒ 不消费，标记留着下轮再说）。
  'pitfall-vector-hook': {
    label: '坑源脏标记消费（小会计 · 记忆引擎 v2 · memory-vectors job 的第 ④b 步）', owner: null, baseline: false,
    note: '未放行：默认关（键缺失 ⇒ 判关）；放行 = `module on pitfall-vector-hook`，关回 = `module off`（一键）；'
      + '实现体 = tools\\dsh-butler\\butler-memory-vectors-tick.mjs（消费 tools\\memory-engine\\lib\\tick-hook.mjs）',
    noOwnerWhy: '归属小会计线（记忆引擎 v2 · 坑库联动 A 点第 10 步）：消费时机由 tickd job memory-vectors 决定，'
      + '放行由本模块位单键决定，再叠四键会出现"两把总闸谁说话"；fail-safe = 读不到配置即判关'
      + '（宁可让标记多留一轮，也不越权往向量库写）。【A-8 可见化】没有 L1 键 ⇒ 四键关不掉它也放行不了它。',
  },
  // 【V3 地基 · 规则升档「只进日报」（2026-10-19 卡 · the operator 12:08 拍板）】登记 `rulecheck-daily` 模块位 ——
  //   作用域 = **仅日报段渲染**（`tools\dsh-butler-panel\lib\rulecheck-daily.mjs` 读本键）：
  //     开 ⇒ 日报出现「🧭 规矩体检」段；关 ⇒ **整段不渲染**（不是空行）。
  //   为什么必须登记：未登记时 `setModuleEnabled` 硬拒写入 ⇒ 没有"一键开/关"的载体（照同族口径）。
  //   `owner:null` + `scope:'infra'` + `failSafe:'baseline'`：它是**观测件**（只读跑 rulecheck 后渲染计数），
  //     不执行任何动作、不碰卡状态、不发通知 ⇒ 不属生态四键动作族；配置读不到时保持 baseline（= 开，观测不消失）。
  //   `baseline:true` = **默认开**（the operator 2026-10-19 12:08 拍板：四条规矩升档 = 只进日报；观察 ≥2 周再谈"拦"）。
  //   ⚠️ 本模块的语义红线：只报事实、不拦卡、不推送手机、不改四件判据（observe 档）。
  'rulecheck-daily': {
    label: '日报「规矩体检」段（DoR / DoD / 缺陷分级 / 复盘+惯例 · 只读渲染）',
    owner: null, baseline: true, scope: 'infra', failSafe: 'baseline',
    note: '默认开（the operator 2026-10-19 拍板"只进日报"）：日报整段渲染；关 ⇒ 整段不出现（`module off rulecheck-daily`）；'
      + '只读 + observe 档，不拦卡 / 不推送 / 不改判据；实现体 = tools\\dsh-butler-panel\\lib\\rulecheck-daily.mjs',
    noOwnerWhy: '观测件（scope:infra）：只读跑 `rulecheck` 并把红黄计数渲染进日报，不执行任何动作、不碰卡状态、不发通知'
      + '⇒ 不属生态四键所管的「有闸自主动作」；关它 = 停日报段（走 L2 模块开关 modules.rulecheck-daily），'
      + 'failSafe=baseline（配置读不到时保持开启，观测面不静默消失）。【A-8 可见化】没有 L1 键 ⇒ 四键关不掉它也放行不了它。',
  },
  // 【R-071① 误删三道防线 · 进程审计自检（2026-10-20 卡）】登记 `audit-state` 模块位 ——
  //   作用域 = **日报「🛠 开工预检」段多一行**「审计：ok / off / unknown（原因）」
  //   （`tools\dsh-butler-panel\lib\audit-state-daily.mjs` 读本键）：开 ⇒ 出这一行；关 ⇒ 该行不出现（不是空行）。
  //   为什么必须登记：未登记时 `setModuleEnabled` 硬拒写入 ⇒ 没有"一键开/关"的载体（照同族口径）。
  //   `owner:null` + `scope:'infra'` + `failSafe:'baseline'`：它是**观测件**（只读跑 reg/auditpol/wevtutil，
  //     然后渲染一行），不执行任何动作、不改审计策略、不碰卡状态、不发通知 ⇒ 不属生态四键动作族；
  //     配置读不到时保持 baseline（= 开，安全观测面不静默消失）。
  //   `baseline:true` = **默认开**（R-071 是 2026-10-19 误删事故的防线①，"默认看得见"才算防线）。
  //   ⚠️ 语义红线：非管理员档一律 unknown（needs-admin），**绝不误报 off**（假警报比没警报更坏）。
  'audit-state': {
    label: '日报「审计状态」一行（4688 命令行 · 只读自检）',
    owner: null, baseline: true, scope: 'infra', failSafe: 'baseline',
    note: '默认开：日报「🛠 开工预检」段多一行「审计：ok / off / unknown（原因）」；关 ⇒ 该行不出现（`module off audit-state`）；'
      + '只读（不写状态 / 不改审计策略 / 不重启），非管理员档一律 unknown（needs-admin）；'
      + '实现体 = tools\\dsh-butler\\audit-state-check.mjs（判定）+ tools\\dsh-butler-panel\\lib\\audit-state-daily.mjs（渲染）',
    noOwnerWhy: '观测件（scope:infra）：只读探测「进程审计还在不在记命令行」并渲染一行，不执行任何动作、不碰卡状态、不发通知，'
      + '也不改审计策略 ⇒ 不属生态四键所管的「有闸自主动作」；关它 = 停日报那一行（走 L2 模块开关 modules.audit-state）；'
      + 'failSafe=baseline（配置读不到时保持开启，安全观测面不静默消失）。【A-8 可见化】没有 L1 键 ⇒ 四键关不掉它也放行不了它。',
  },
};

export function isKnownModule(id) {
  return Object.prototype.hasOwnProperty.call(MODULE_IDS, id);
}

/** 读整个 modules 段（fail-safe：读不到 → 全部按 false，不回落到 baseline）。 */
export function readModules(opts = {}) {
  const file = autonomyPath(opts);
  let raw = null;
  let reason = 'ok';
  try {
    if (!fs.existsSync(file)) reason = 'file-missing';
    else {
      const txt = fs.readFileSync(file, 'utf8');
      if (!txt.trim()) reason = 'file-empty';
      else {
        const j = JSON.parse(txt);
        if (!j || typeof j !== 'object') reason = 'file-not-object';
        else if (Number(j.schemaVersion ?? AUTONOMY_SCHEMA) !== AUTONOMY_SCHEMA) reason = `schema-mismatch:${j.schemaVersion}`;
        else { raw = j; reason = 'ok'; }
      }
    }
  } catch (e) {
    reason = `read-error:${e?.message ?? e}`;
  }
  const fileOk = raw !== null;
  const stored = (fileOk && raw.modules && typeof raw.modules === 'object') ? raw.modules : null;
  const modules = {};
  for (const [id, meta] of Object.entries(MODULE_IDS)) {
    const cell = stored?.[id];
    let enabled;
    let source;
    if (!fileOk) {
      // failSafe='baseline'（基础设施类）→ 读不到配置时**保持现状**（不判关）；
      // 其余模块照旧 fail-safe 判关（宁可少做一次自动动作）。
      const keepBaseline = meta.failSafe === 'baseline';
      enabled = keepBaseline ? meta.baseline === true : false;
      source = keepBaseline ? 'fail-safe-baseline' : 'fail-safe';
    } else if (cell && typeof cell === 'object' && typeof cell.enabled === 'boolean') { enabled = cell.enabled; source = 'file'; }
    else { enabled = meta.baseline === true; source = 'baseline'; }
    modules[id] = { id, label: meta.label, owner: meta.owner ?? null, rawOwner: meta.rawOwner ?? null, scope: meta.scope ?? 'action', enabled, source, since: cell?.since ?? null, by: cell?.by ?? null, why: cell?.why ?? null };
  }
  return { ok: fileOk, file, reason, modules, raw };
}

/**
 * 单模块是否允许执行（只判本模块开关，不含 L0/L1）。
 * @returns {{enabled:boolean, known:boolean, source:string, reason:string, label:string|null}}
 */
export function isModuleEnabled(id, opts = {}) {
  if (!isKnownModule(id)) return { enabled: false, known: false, source: 'unregistered', reason: `模块 ${id} 未登记（未登记一律不可用）`, label: null };
  const r = readModules(opts);
  const m = r.modules[id];
  return { enabled: m.enabled === true, known: true, source: m.source, reason: m.enabled ? 'enabled' : `disabled(${m.source})`, label: m.label };
}

/**
 * 组合判定：L0 降档 × L1 归属总开关 × L2 模块开关。
 *
 * ⚠️ `scope:'infra'`（守护鱼 / tickd 调度 / P5 保护区清单 / 标题插件）**只判 L2**：
 *    它们是"保命 + 观测"基础设施，不是自主动作 —— L0 降档（可能由配置损坏 fail-safe 触发）
 *    和 L1 四键（裸跑期默认全关）都不该把生态的自愈/观测能力一起带走。
 * @returns {{allowed:boolean, reason:string, module:string, label:string|null, moduleEnabled:boolean,
 *            owner:string|null, ownerOn:boolean|null, rawOwner:string|null, rawOwnerOn:boolean|null,
 *            level:string, degraded:boolean, source:string, scope:string}}
 */
export function checkModuleAllowed(id, opts = {}) {
  const mod = isModuleEnabled(id, opts);
  const meta = MODULE_IDS[id] ?? null;
  const scope = meta?.scope ?? 'action';
  const owner = meta?.owner ?? null;
  const rawOwner = meta?.rawOwner ?? null;
  // infra：只判 L2，读 L0/L1 只为回报（不参与 allow 判定）
  const st = scope === 'infra' ? { degraded: false, level: readAutonomyState(opts).level } : readAutonomyState(opts);
  const auto = opts.autonomy ?? readAutonomy(opts); // 调用方可传入已读的 autonomy（省一次读盘）
  let ownerOn = null;
  if (owner && scope !== 'infra') {
    const eff = auto?.effective ?? null;
    ownerOn = (eff && typeof eff === 'object') ? eff[OWNER_TO_KIND[owner] ?? owner] === true : false; // 读不到总开关 = 关（fail-safe）
  }
  // rawOwner：**只回报**，从 opts.autonomy.raw 读原始键值（读不到 = null）。
  //   ⚠️ 绝不参与 allowed 判定 —— 通道级 autoAllowed() 才是 raw 键的判定方；
  //   这里给出它只为让"放行实际要哪几把键"在模块门输出里可见（2026-09-13 卡 ac3f9038 拍板①）。
  let rawOwnerOn = null;
  if (rawOwner) {
    const raw = auto?.raw ?? null;
    rawOwnerOn = (raw && typeof raw === 'object' && typeof raw[rawOwner] === 'boolean') ? raw[rawOwner] : null;
  }
  const degraded = st.degraded === true;
  const reasons = [];
  if (scope !== 'infra') {
    if (degraded) reasons.push(`L0 降档中（level=${st.level}）`);
    if (owner && ownerOn === false) reasons.push(`L1 ${owner}=false`);
    if (owner && ownerOn === null) reasons.push(`L1 ${owner} 未提供（调用方须显式传入 autonomy）`);
  }
  if (!mod.enabled) reasons.push(`L2 模块关（${mod.source}）`);
  return {
    allowed: reasons.length === 0,
    reason: reasons.length ? reasons.join(' + ') : (scope === 'infra' ? 'ok（infra：只受 L2 约束）' : 'ok'),
    module: id, label: mod.label, moduleEnabled: mod.enabled, owner, ownerOn, rawOwner, rawOwnerOn,
    level: st.level ?? 'unknown', degraded, source: mod.source, scope,
  };
}

/**
 * 写模块开关（原子写 + 审计 + moduleHistory）。
 * @param {string} id
 * @param {boolean} enabled
 * @param {{by?:string, why?:string, home?:string, now?:number}} [opts]
 */
export function setModuleEnabled(id, enabled, opts = {}) {
  if (!isKnownModule(id)) return { ok: false, error: `模块 ${id} 未登记（MODULE_IDS）：拒绝写入`, file: autonomyPath(opts) };
  if (typeof enabled !== 'boolean') return { ok: false, error: `enabled 必须是 boolean（实得 ${JSON.stringify(enabled)}）`, file: autonomyPath(opts) };
  const by = opts.by ?? 'unknown';
  const why = opts.why ?? '';
  if (!why) return { ok: false, error: '必须提供 why（开关变更必须可溯源）', file: autonomyPath(opts) };
  const file = autonomyPath(opts);
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  // 【施工卡 ①-3 · ①-7】读-改-写改走 `store.updateJson`（**持 RMW 锁 + 原子写**）。
  //   改前：`readJson` → `writeJsonAtomic`，**不持锁** ⇒ 面板 / CLI / tickd 并发写同一文件时
  //   "后写覆盖先写"，**丢闸门开关值**（①包 §2.5 实测；①包 §5 判据 8 的并发用例）。
  //   `before` 值也在**锁内**读（并发下 from/to 审计才准）。
  let prevEnabled = null;
  const applyModuleCell = (cur) => {
    const base = (cur && typeof cur === 'object') ? cur : defaultAutonomy(now);
    // before 值 = **生效值**，口径必须与 `readModules` 一致（文件里没有该键的模块取登记表 `baseline`）。
    //   ⚠️ 不可直接读 `base.modules[id].enabled`：那会把"baseline=true 但文件里无键"（如 p2-watch）
    //   误报成 false —— 2026-09-18 本卡实测踩过（test-modules-route / test-modules-http-index 立刻红）。
    prevEnabled = (readModules(opts)?.modules?.[id]?.enabled) === true;
    return {
      ...base,
      schemaVersion: AUTONOMY_SCHEMA,
      modules: { ...(base.modules ?? {}), [id]: { enabled, since: at, by, why } },
      moduleHistory: [
        ...(Array.isArray(base.moduleHistory) ? base.moduleHistory : []),
        { at, module: id, from: prevEnabled, to: enabled, by, why, device: process.env.COMPUTERNAME ?? null },
      ].slice(-MODULE_HISTORY_KEEP),
      updatedAt: at,
      updatedBy: by,
    };
  };
  try {
    updateJson(file, applyModuleCell, { home: opts.home, defaultValue: defaultAutonomy(now) });
  } catch (e) {
    // 文件损坏 / schema 不符 ⇒ `updateJson` 在**读阶段**就 fail-closed 抛错（CORRUPT_STATE）。
    //   **沿既有语义就地重建**（不往损坏文件上写；重建后四键回 fail-safe=false）——
    //   这是"改走带锁入口"最容易顺手改掉的旧行为（实测：test-autonomy-modules 第⑦段会红）。
    //   重建失败仍照旧抛出（与改前 writeJsonAtomic 直写一致，调用方按 500 处理）。
    writeJsonAtomic(file, applyModuleCell(null));
  }
  try {
    appendAudit({ type: 'autonomy-module', module: id, from: prevEnabled === true, to: enabled, by, why, file }, { home: opts.home });
  } catch { /* 审计失败不阻断开关本身（与 autonomy.mjs 同口径） */ }
  return { ok: true, file, module: id, before: prevEnabled === true, after: enabled, at };
}

// ---------------------------------------------------------------- job 级开关（tickd）
// 【2026-09-13 卡②】常驻 tickd 的 JOBS 注册表原先只认源码常量 `j.enabled`，想临时停单个
// job（如冷备盘不在线时的 imagegen）只能改源码 + --stop/--ensure。这里把单 job 开关
// 落到**同一个配置文件**的 `jobs` 段（不新增第二套存储）：
//   { "jobs": { "imagegen": { "enabled": false, "since": "...", "by": "...", "why": "..." } } }
// fail-safe 口径同基础设施类：**读不到配置 = 保持现状**（关闸必须是显式动作，有 since/by/why 可查）。
export const JOB_HISTORY_KEEP = 100;

/**
 * 读 jobs 段（不做默认值填充，只回文件里显式写了什么）。
 * @returns {{ok:boolean, file:string, reason:string, jobs:Record<string,{id:string,enabled:boolean,source:string,since:string|null,by:string|null,why:string|null}>}}
 */
export function readJobSwitches(opts = {}) {
  const file = autonomyPath(opts);
  let raw = null;
  let reason = 'ok';
  try {
    if (!fs.existsSync(file)) reason = 'file-missing';
    else {
      const txt = fs.readFileSync(file, 'utf8');
      if (!txt.trim()) reason = 'file-empty';
      else {
        const j = JSON.parse(txt);
        if (!j || typeof j !== 'object') reason = 'file-not-object';
        else if (Number(j.schemaVersion ?? AUTONOMY_SCHEMA) !== AUTONOMY_SCHEMA) reason = `schema-mismatch:${j.schemaVersion}`;
        else { raw = j; reason = 'ok'; }
      }
    }
  } catch (e) { reason = `read-error:${e?.message ?? e}`; }
  const stored = (raw && raw.jobs && typeof raw.jobs === 'object' && !Array.isArray(raw.jobs)) ? raw.jobs : {};
  const jobs = {};
  for (const [id, cell] of Object.entries(stored)) {
    if (!cell || typeof cell !== 'object') continue;
    jobs[id] = {
      id, enabled: cell.enabled !== false, source: 'file',
      since: cell.since ?? null, by: cell.by ?? null, why: cell.why ?? null,
    };
  }
  return { ok: raw !== null, file, reason, jobs };
}

/**
 * 【H4b · 2026-09-21】JOBS 条目 → 「**缺覆盖项时**的默认开关值」（声明式）。
 *
 * 治什么：`isTickJobEnabled` 在「配置读不到 / 该 job 无 `jobs.<id>` 覆盖项」时用
 *   `opts.defaultEnabled`（历史口径 = `!hardDisabled` = **默认开**）。于是**新增 job** 在任何
 *   缺该键的机器（典型 = 对端：`butler-autonomy.json` 不跨机同步）上会**自动开跑**，
 *   交付纪律「默认关、先观测」在对端形同虚设（2026-09-17 arrive-b 实测）。
 *   作者想在代码里声明「缺键即关」时，此前只有 `enabled:false` 一条路 —— 那是**硬禁用**
 *   （`job on` 也打不开），会破坏「放行 = 改开关不是改代码」的序列。
 *
 * 口径（**三条，缺一不可**）：
 *   ① 未声明 `defaultWhenUnset` → **返回 true = 逐字节保持既有全局默认语义**（红线：不许改全局默认）；
 *   ② `defaultWhenUnset:'off'` → 缺键即关（**但 `job on <id>` 照常能打开**：一旦有覆盖项就归 file 分支）；
 *   ③ `enabled:false`（源码硬禁用）优先，仍是「开关打不开」的既有语义。
 *   ⚠️ 只认 `'off'` 这一个字面量：其它值（含 'on'）一律按「未声明」处理 —— 显式声明面越窄越不容易写错，
 *      且 `'on'` 与「不写」在本语义下等价，没有存在必要。
 *
 * @param {{enabled?:boolean, defaultWhenUnset?:string}} job JOBS 条目
 * @returns {boolean} 传给 `isTickJobEnabled(id, { defaultEnabled })` 的值
 */
export function declaredJobDefault(job) {
  if (!job || typeof job !== 'object') return true;
  if (job.enabled === false) return false;              // ③ 源码硬禁用（既有语义，最高优先）
  if (job.enabled === true) return true;                // ④ 源码显式开 = 作者已表态，尊重之
  if (job.defaultWhenUnset === 'off') return false;     // ② 声明式：缺覆盖项即关
  // ⑤【本包默认】「缺键即开」对**本仓自己的部署**成立（生产 home 里每台机都有 `jobs` 覆盖项），
  //    但对**第一次装本包的人**是灾难：调度表里多数 job 的脚本不随本包发布 ⇒ 一开跑就是一堆
  //    `MODULE_NOT_FOUND`，几分钟内就能刷满告警。所以本包默认**缺键即关**，
  //    要恢复"缺键即开"的历史语义，显式设环境变量 `BUTLER_JOBS_DEFAULT=on`。
  //    单个 job 放行仍走配置（`jobs.<id>.enabled = true` + why），与源码硬禁用互不覆盖。
  if (process.env.BUTLER_JOBS_DEFAULT !== 'on') return false;
  return true;                                          // ① 未声明 → 现状
}

/**
 * 单 job 是否允许跑（只判 job 开关；模块级总闸由调用方叠加 `tickd-jobs`）。
 * fail-safe：配置读不到 / 无该 job 的覆盖项 → `opts.defaultEnabled ?? true`（= 现状）。
 * @returns {{id:string, enabled:boolean, source:'file'|'default'|'fail-safe-baseline', reason:string, by?:string|null, why?:string|null, since?:string|null}}
 */
export function isTickJobEnabled(id, opts = {}) {
  const def = opts.defaultEnabled !== false;
  const src = opts.jobSwitches ?? readJobSwitches(opts);
  if (!src.ok) return { id, enabled: def, source: 'fail-safe-baseline', reason: `开关配置不可用（${src.reason}）→ 保持现状` };
  const cell = src.jobs[id];
  if (!cell) return { id, enabled: def, source: 'default', reason: '无覆盖项 → 现状' };
  return {
    id, enabled: cell.enabled === true, source: 'file',
    reason: cell.enabled ? 'enabled(file)' : 'disabled(file)',
    by: cell.by ?? null, why: cell.why ?? null, since: cell.since ?? null,
  };
}

/**
 * 写单 job 开关（原子写 + 审计 + jobHistory）。
 * @param {string} id job id（tickd JOBS 的 id）
 * @param {boolean} enabled
 * @param {{by?:string, why?:string, home?:string, now?:number, knownJobIds?:string[]}} [opts]
 */
export function setJobEnabled(id, enabled, opts = {}) {
  const file = autonomyPath(opts);
  if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'job id 不能为空', file };
  if (Array.isArray(opts.knownJobIds) && opts.knownJobIds.length > 0 && !opts.knownJobIds.includes(id)) {
    return { ok: false, error: `job ${id} 不在调度表（JOBS）里：拒绝写入（防手打 id 打开任意东西）`, file };
  }
  if (typeof enabled !== 'boolean') return { ok: false, error: `enabled 必须是 boolean（实得 ${JSON.stringify(enabled)}）`, file };
  const by = opts.by ?? 'unknown';
  const why = opts.why ?? '';
  if (!why) return { ok: false, error: '必须提供 why（开关变更必须可溯源）', file };
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  // 【施工卡 ①-3 · ①-7】同 `setModuleEnabled`：读-改-写走 store.updateJson（持 RMW 锁 + 原子写），
  //   `from` 值在锁内读（并发下审计才准）。改前不持锁 ⇒ 与面板/tickd 并发写会丢开关值。
  let prevEnabled = null;
  const applyJobCell = (cur) => {
    const base = (cur && typeof cur === 'object') ? cur : defaultAutonomy(now);
    // before 值走 `readJobSwitches`（与 job 侧既有口径单一来源：只认文件里显式写的覆盖项）
    prevEnabled = (readJobSwitches(opts)?.jobs?.[id]?.enabled) === true;
    return {
      ...base,
      schemaVersion: AUTONOMY_SCHEMA,
      jobs: { ...(base.jobs ?? {}), [id]: { enabled, since: at, by, why } },
      jobHistory: [
        ...(Array.isArray(base.jobHistory) ? base.jobHistory : []),
        { at, job: id, from: prevEnabled === true, to: enabled, by, why, device: process.env.COMPUTERNAME ?? null },
      ].slice(-JOB_HISTORY_KEEP),
      updatedAt: at,
      updatedBy: by,
    };
  };
  try {
    updateJson(file, applyJobCell, { home: opts.home, defaultValue: defaultAutonomy(now) });
  } catch (e) {
    // 同 setModuleEnabled：损坏 / schema 不符 ⇒ 就地重建（沿用既有语义）
    writeJsonAtomic(file, applyJobCell(null));
  }
  try {
    appendAudit({ type: 'autonomy-job', job: id, from: prevEnabled === true, to: enabled, by, why, file }, { home: opts.home });
  } catch { /* 审计失败不阻断开关本身 */ }
  return { ok: true, file, job: id, before: prevEnabled === true, after: enabled, at };
}

/** job 开关总览（CLI / tickd --status 用）。knownJobIds 给了就把"没覆盖项的"也列出来。
 *  【2026-10-23 · stall-nudge】主线停滞提醒（工作日 08:30 · 外部通道真发）的**开关表唯一源 =**
 *  `butler-tickd.mjs#JOBS`（本文件不维护第二份 job 清单；knownJobIds 由调用方从 JOBS 传入）。
 *  该 job 未声明 `defaultWhenUnset` ⇒ 缺覆盖项 = 开（the operator已拍「真发」）。
 *  【H4b】第三参 `declaredDefaults` = `{ <jobId>: boolean }`，每 job 的「缺覆盖项时默认值」
 *  由调用方按 JOBS 声明给出（`declaredJobDefault(j)`）。不传 → 逐字节保持既有口径
 *  （`opts.defaultEnabled !== false`）。**必须传**才能让 `job list` 与 tickd 判定显示一致，
 *  否则会出现「tickd 因声明而不跑、CLI 却显示🟢」的误导。 */
export function describeJobs(opts = {}, knownJobIds = null, declaredDefaults = null) {
  const r = readJobSwitches(opts);
  const ids = new Set([...Object.keys(r.jobs), ...(Array.isArray(knownJobIds) ? knownJobIds : [])]);
  const globalDefault = opts.defaultEnabled !== false;
  const rows = [...ids].map((id) => {
    const cell = r.jobs[id] ?? null;
    const declared = (declaredDefaults && typeof declaredDefaults === 'object' && Object.prototype.hasOwnProperty.call(declaredDefaults, id))
      ? declaredDefaults[id] === true
      : null;
    const def = declared !== null ? declared : globalDefault;
    return {
      id,
      enabled: r.ok ? (cell ? cell.enabled === true : def) : def,
      source: r.ok ? (cell ? 'file' : (declared === false && globalDefault ? 'declared-off' : 'default')) : 'fail-safe-baseline',
      declaredDefault: declared,
      since: cell?.since ?? null, by: cell?.by ?? null, why: cell?.why ?? null,
    };
  });
  return { ok: r.ok, file: r.file, reason: r.reason, count: rows.length, disabled: rows.filter((x) => !x.enabled).map((x) => x.id), jobs: rows };
}

/** 把当前 modules 段渲染成 CLI 用的行（只读）。
 *  rawOwner：通道级第二把 raw 键（只呈现，不判定）；配合 `autoAllowed(meta.raw)` 才是完整放行口径。 */
export function describeModules(opts = {}) {
  const r = readModules(opts);
  const rows = Object.values(r.modules).map((m) => ({
    id: m.id, label: m.label, owner: m.owner, rawOwner: m.rawOwner, enabled: m.enabled, source: m.source, since: m.since, by: m.by, why: m.why,
  }));
  return { ok: r.ok, file: r.file, reason: r.reason, level: readAutonomyState(opts).level, count: rows.length, enabledCount: rows.filter((x) => x.enabled).length, modules: rows };
}
