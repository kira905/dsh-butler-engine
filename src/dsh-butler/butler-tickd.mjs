#!/usr/bin/env node
// ---------------------------------------------------------------------------
// butler-tickd.mjs —— butler常驻 tick 调度守护（2026-09-11）
//
// 为什么存在：
//   2026-09-10 18:01 公司 360 企业 EDR 把 7 个 tick 启动器（VBS/CMD）判定为
//   「建议禁止开机自动运行的程序」并隔离，连带清掉 8 个 Windows 计划任务 →
//   P2/P4/P5/P6/裸跑观测/重启闸门全部静默停摆（数据断点 17:57~18:01）。
//   计划任务形态（wscript 启 VBS + 高频触发）在受管终端上不可靠，改为：
//   **一个 node.exe 常驻进程**（与守护鱼 guard.mjs 同形态）按原间隔 spawn
//   那些短命 tick 脚本。node 直启不属于"开机自动运行的可疑程序"特征，
//   且信任区是公司 IT 下发的、终端只读 —— 我们只能改自己的形态。
//
// 与旧计划任务的关系：
//   - 间隔/入口逐条对齐（见 JOBS），tick 脚本本身一句没改（各自带 tick 锁、
//     日志、退出码语义）；
//   - 计划任务的注册脚本保留（<host> 侧无 360，仍用计划任务；本机若将来拿到
//     白名单也可随时回到计划任务 —— 两套入口互不冲突，靠各自的锁防重）。
//
// 用法：
//   node butler-tickd.mjs                  # 前台常驻（调试/被 --ensure 以 detached 启动）
//   node butler-tickd.mjs --ensure         # 幂等启动：活着就退，否则 detached 起一个
//   node butler-tickd.mjs --stop           # 停止（杀 pid + 清理锁）
//   node butler-tickd.mjs --status         # 状态（JSON，含每个 job 的最近结果）
//   node butler-tickd.mjs --list           # 调度表
//   node butler-tickd.mjs --once [jobId]   # 跑一轮到期任务（或指定）后退出 —— 单测/手动用
//   node butler-tickd.mjs --loop-ms <ms>   # 覆盖主循环节拍（测试用，默认 15000）
//
// 落点：
//   %TEMP%\dsh-butler-tickd\state.json   状态与心跳（不跨机同步）
//   %TEMP%\dsh-butler-tickd\lock         单例锁（含 pid/startedAt）
//   %TEMP%\dsh-butler-tickd.log          调度日志（追加，>1MB 轮转）
//
// 冷启动时由 dsh-start.ps1 调 `--ensure` 拉起（照抄守护鱼的入口形态）；
// 停机由 dsh-shutdown.ps1 的「清其余 DSH node」自然带走（命令行含 <butler-root>），
// 故 tickd 不做关机钩子 —— 下次 --ensure 靠活跃探测 + 陈旧锁清理重建。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// T2（§17.1）：单例锁扩到全部 job —— 锁名注册表（单一数据源）+ 交接窗口判定（纯逻辑）
import { acquireTickLock, renewTickLock, sweepStaleTickLocks } from './lib/store.mjs';
import { lockNameFor, deriveTtlMs, mustYieldInHandoff, auditRegistry, usesLockRunner } from './lib/butler-locks.mjs';
import { detectHandoffWindow } from './lib/handoff-version-gate.mjs';
import { dshHome } from './lib/paths.mjs';
// 【卡 4a12fc8c · 修法 3】残留清理要写一条告警（只写 ~/.dsh/butler-alert.log + stderr，不阻断调度）
import { alert } from './lib/alert.mjs';
// 【卡 tickd 实例唯一性 · 2026-10-22】启动期守卫的留痕出口 = 审计流水（~/.dsh/butler-audit/YYYY-MM.jsonl）。
//   复用**唯一写入口** lib/audit.mjs（append-only + 哈希链；写失败只告警，绝不拖垮启动）。
import { appendAudit } from './lib/audit.mjs';
// 【2026-09-13 卡②：job 级活开关（kill switch L2）】真相源 = ~/.dsh/butler-autonomy.json
//   · modules['tickd-jobs'] = 全部 job 的总闸（关 = 一律不跑，进程仍在、心跳照写）
//   · jobs.<id>.enabled     = 单 job 开关（关 = 只跳这一个）
//   两者都**每 tick 现读**（读盘无缓存 → 改文件 ≤1 个 loop 生效，不必 --stop/--ensure）。
import { isModuleEnabled, readJobSwitches, isTickJobEnabled, describeJobs, declaredJobDefault } from './lib/autonomy-modules.mjs';
// 【冲刺600 · 批4-3 可观测性收口（2026-10-09）】tick 观测口径**单一真源**（命名表 / 耗时预算 / 指标样本）。
//   为什么走 lib 而不是在本文件里写死：口径必须能被面板、日报、单测、未来后端**同一份**引用，
//   散在调度器里就必然长出第二套（v2 方案 §3.7.2「不自造」）。本文件只负责"什么时候算、写到哪"。
import {
  buildJobMetricSamples, budgetLedger, budgetAlertText, durationSummary,
  judgeBudget, mergeMetrics, shouldAlertBudget, metricsSelfCheck, NAMED_METRICS,
} from './lib/tickd-metrics.mjs';
// 【卡 冲刺600·tickd失败留痕（2026-10-10）】子进程**非 0 退出**时把它的输出尾部落盘 ——
//   补上「失败原因不留痕」这条结构性缺口（背景：docs/
//   §2.2 / §5 结论二：「stdio:'ignore' ⇒ 子进程报什么错一个字都不留」）。
//   ⚠️ 本模块**只做留痕**：lastStatus / lastExitCode / failures / benign 的**判定语义一字不改**。
//   反向锚：`_test/test-tickd-fail-trace.mjs`（含"改了 pipe 但不并发读取 ⇒ 子进程卡死"的实测对照）。
import {
  TailBuffer, attachTail, shouldTraceExit, traceDirFor,
  writeExitTrace, traceSummaryLine, resolveTraceConfig,
} from './lib/tickd-fail-trace.mjs';
// 【V2.9 封口①·A 域 · 2026-10-14 · 卡「封口①-A域」】三项封口项在 tickd 侧的挂点（全部只读/台账，零新 job、零开关）：
//   · `authorizeSelfCheck`  → A L154「授权合成 min(对象S档, actor矩阵, 动作L级)」补上第一元后的**真跑读数**
//      （判据源 = `lib/authorize-compose.mjs`；本文件只负责"什么时候跑、写到哪"）；
//   · `memorySample` / `judgeMemoryBudget` → A L162「采集开销预算」的**内存**侧 —— 该模块此前是
//      **候选态·零接线**（`lib/slo-tail.mjs` 头注自陈），本卡把它接进生产；⚠️ 采样**必须在本进程内**
//      （Node 跨不了进程读 RSS），另该文件头注已同步订正；
//   · `runVersionDisposition` → A L167「不匹配处置 4 步」里步骤 3/4 的**自动触发点**
//      （只**自动产出请求 + 落审计台账 + 告警**，真执行仍归人/卡 —— 重部署含重启、降档改自治行为）。
import { authorizeSelfCheck } from './lib/authorize-compose.mjs';
import { memorySample, judgeMemoryBudget } from './lib/slo-tail.mjs';
import { runVersionDisposition } from './lib/version-disposition.mjs';

export const TICKD_VERSION = '1.0.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 工具树根（默认 <home>/dsh；可用 BUTLER_ROOT 覆盖）。开源包里不随包提供大多数 job 脚本。
const DSH = process.env.BUTLER_ROOT || path.join(os.homedir(), 'dsh');
const PANEL = path.join(DSH, 'tools', 'dsh-butler-panel');
const NODE_EXE = process.execPath;
/**
 * 【卡 S5·T2b（2026-09-17）】tick **锁包装层**入口。
 *
 * 缺口（H1b-prep §七 遗留项 3）：`watchfs` / `daily` / `weekly` / `imagegen*` 的脚本本体
 *   **没有 acquireTickLock** —— T2 的锁只加在调度器这层，于是「计划任务 / 手动直跑」这类
 *   绕过 tickd 的入口可以并发踩同一批状态文件。
 * 补法（不改那 4 个脚本）：脚本自身无锁的 job 改为 spawn `lib/tick-job-runner.mjs`，
 *   由包装层**抢锁 → 动态 import 目标脚本 → 释放**；谁走包装层由锁注册表的 `lockRunner`
 *   字段回答（单一数据源，不在本文件里再写一份 job id 清单）。
 */
const TICK_JOB_RUNNER = path.join(HERE, 'lib', 'tick-job-runner.mjs');
const TEMP = process.env.TEMP || os.tmpdir();
// DSH_TICKD_DIR 可覆盖落点 —— 单测用临时目录，绝不碰生产状态。
const STATE_DIR = process.env.DSH_TICKD_DIR || path.join(TEMP, 'dsh-butler-tickd');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = path.join(STATE_DIR, 'lock');
const LOG_FILE = process.env.DSH_TICKD_LOG || path.join(STATE_DIR, '..', 'dsh-butler-tickd.log');
const LOG_MAX_BYTES = 1024 * 1024;
// 【卡 冲刺600·tickd失败留痕】失败留痕目录与上限（env 可覆盖；缺省即生产口径）。
//   落点挂在**同一个** STATE_DIR 下（`%TEMP%\dsh-butler-tickd\last-error\`）—— 与 state.json
//   同源同生命周期，不新建第二套状态根；DSH_TICKD_DIR 一改（单测）留痕目录也跟着隔离。
const TRACE_DIR = traceDirFor(STATE_DIR);
const TRACE_CFG = resolveTraceConfig();

const MIN = 60_000;

/**
 * 【卡 4a12fc8c】stale running 兜底：`jobs.<id>.running` 是**内存语义**的防重入标记，
 * 只在本进程收到子进程 exit 时清零 —— tickd 被杀 / exit 事件丢失（实测两种形态都出现过）
 * 都会让它永久残留，pickDue 于是永远跳过该 job，且 failures 不增、lastStatus 仍是 ok
 * （静默停摆，日报/tickd 健康段都看不出）。
 * 阈值口径 = max(注册表 ttlMs, 2×intervalMs, 15min)：够长（不误伤真在跑的慢 job），
 * 够短（残留最多耽误一刻钟就被复位）。真在跑的 job 另有**内存判据**豁免（见 activeChildren）。
 */
export const STALE_RUNNING_MIN_MS = 15 * MIN;

/**
 * 本进程 spawn 出来、尚未收尾的子进程（jobId → child）。
 * 为什么必须有：时间判据可能误伤「确实在跑但很慢」的 job，而这张表是**权威事实**——
 * 只要 child 还在（本进程就没收到 exit），无论多久都不许判残留。
 * tickd 冷启动后此表为空且旧 child 已随旧进程消亡 ⇒ 冷启动判定天然正确。
 */
const activeChildren = new Map();

/** 【卡②】上一次 loop 里被开关拦下的 job 集合（只用于"变化才记日志"）。 */
let lastBlockedKey = null;

function trackChild(jobId, child) { activeChildren.set(jobId, child); }
function untrackChild(jobId, child) {
  if (activeChildren.get(jobId) === child) activeChildren.delete(jobId);
}
/** 本进程是否真的在跑该 job（单测可注入，生产用 activeChildren）。 */
export function hasLiveChild(jobId) { return activeChildren.has(jobId); }

/**
 * 调度表 —— 逐条对齐 2026-09-11 之前 Windows 计划任务里的 8 个任务。
 *   intervalMs : 运行间隔（daily/weekly 用 at 字段）
 *   initialMs  : 启动后首次延迟（barewatch 原与 watch 错开 2 分钟）
 *   at         : 'HH:MM' 每日；'MON HH:MM' 每周
 *   days       : 【新 · 2026-09-20】星期集合，如 ['MON','TUE','WED','THU','FRI']（仅日历型 + at 为 'HH:MM' 时有效）
 *   window     : 【新 · 2026-09-20】时段窗 { from:'HH:MM', to:'HH:MM' }，仅间隔型（intervalMs）有效
 * 入口一律 node 直跑脚本（等价于旧 VBS 里 sh.Run node "…"）。
 *
 * ──【2026-09-20 · 施工卡「冷盘窗」】调度语义三种形态（**只此三种，别再造第二套写法**）
 *   ① 日频           `at:'08:45'`                        —— 每天该点必跑一次（今日已跑 → lastDay 挡住）
 *   ② 周频           `at:'FRI 09:40'`                    —— 每周该天该点跑一次（本周已跑 → lastWeek 挡住）
 *   ③ 多星期（新）   `at:'08:45' + days:['MON',…,'FRI']` —— 只在 day 集合命中的那些天跑；
 *        判定与 ① 同源（**按 lastDay 而不是 lastWeek 去重**）—— 否则"本周一跑过"会把周二~周五全挡住。
 *   ⚠️ **非命中日直接 return false，且不写 lastDay**（runJob 的 exit 分支只在 `at` 无空格时写 lastDay，
 *      但前提是**这一轮真的跑了**）。写进去会把下一个命中日误判成"已跑过"而漏跑（周一漏跑）。
 *   ⚠️ 区间型窗口（窗户开启）**只在窗口内才判定**到期；窗口外连"到期"都不算，
 *      因此**不会推进 lastRunAt** —— 窗口一开就按正常间隔补跑一次，之后回到正常节奏
 *      （不会因整夜窗口外而攒出一串"欠跑"，也不会让窗口打开时白等一整个 interval）。
 * 形态取舍（施工卡要求"选中一个形态并写进注释"，**别两套并存**）：
 *   · 星期集合用**并列字段 `days`**，不用 `at:'MON-FRI 08:45'` 区间串 —— 理由：
 *     `at` 的既有两种形态是"时刻"与"星期+时刻"，再塞进范围语法会让 parseHhMm / 周频判定 /
 *     `at.includes(' ')` 这三处既有分支各自长出特例；`days` 缺省 = 全部命中 ⇒ **未声明新字段的 job
 *     逐字节保持原行为**（兼容性是本卡硬要求）。
 *   · 时段窗用**并列字段 `window:{from,to}`**，不用 `hours:[8,18]` —— 理由同上（与 `days` 同族写法、
 *     不需要"小时数组 + 分钟在哪"的第二套解析）。
 */
export const JOBS = [
  { id: 'restart',   label: 'P0 重启统筹闸门', intervalMs: 1 * MIN,  initialMs: 5_000,
    script: 'restart-coordinator.mjs', args: [], dir: HERE },
  // 卡 [Q1] B 主干：看板卡进「待验收」后叫醒推进者（三档 observe/report/notify，默认 observe）
  //   —— 1 分钟节奏对齐 restart 闸门；只提醒，不自动验收/不自动起卡。
  { id: 'queue',     label: '队列推进巡检（叫醒）', intervalMs: 1 * MIN, initialMs: 20_000,
    script: 'butler-queue-tick.mjs', args: [], dir: HERE },
  // 【卡死会话自愈链 · 2026-10-10】方案真源 = `docs/`。
  //   治：会话卡死/回合被重启打断后**无人叫醒**（2026-10-10 凌晨静默 6.8h 实证）。
  //   链 = 提醒×2（每会话每天）→ 登记自动重启事由（复用 p0-auto-restart 低水位通道）→ 重启后补注入 → 升级报警。
  //   ⚠️ 本 job **不自建重启通道**：重启一律经既有 `p0-auto-restart`（低水位 + 24h 去重 + 通道闸）。
  //   ⚠️ 默认关的**唯一权威层** = 生产 `butler-autonomy.json` 的 `jobs['stuck-recovery'].enabled=false`
  //      （源码不写 `enabled:false` —— 写死 = 硬禁用，`job on` 也打不开）；
  //      另有一道闸 = `~/.dsh/butler-stuck-recovery.json#enabled`（缺省 false ⇒ 脚本自己零动作）。
  //   ⚠️ 与 queue 同节奏（1 分钟）但**独立 job**：好单独关、好观测；`--apply` 由本行给（脚本默认 dry-run）。
  { id: 'stuck-recovery', label: '卡死会话自愈链（提醒 / 重启事由 / 补注入）', intervalMs: 1 * MIN, initialMs: 45_000,
    script: 'butler-stuck-recovery.mjs', args: ['--apply'], dir: HERE },
  // ── <mainline> ⑤ · 日程提醒 job（2026-10-23 · 卡「日程 + 提醒」）────────────────────
  //   语义 = 每 1 分钟扫 `~/.dsh/family-calendar/events.json`，找「未发且 remindAt <= now」的到点提醒，
  //     逐条落状态行到 `reminded.jsonl`（幂等键 = eventId + remindAt；方案 §5.6）。
  //   ⚠️ **本卡不发真消息**：脚本 `family-remind-tick.mjs` 的 selectChannel 缺省 = () => null ⇒
  //     到点一律记 `undeliverable/no-transport`；真通道（外部通道/外部通道）属 ⑨ 卡，要the operator在场再接。
  //   🔴 订正注（2026-10-29 · N2 卡 · 只标注不改原文）：上面这条**已过期**。一期提醒链（N2）落地后：
  //     ① `selectChannel` 缺省按 `'wechat'`，不再是 `() => null`；
  //     ② **真发与否只由 `opts.send` 决定**：`opts.send` 缺省 ⇒ `undeliverable/no-transport`，CLI 只在
  //        `--fake-transport`（夹具专用）时注入假实现 ⇒ **本 job 行的 args 里永远不带 `--fake-transport`**；
  //     ③ 真发送末端 = `tools\wechat-bridge\lib\messaging\direct-transport.mjs`，接线属 **N3**（要the operator在场）；
  //     ④ 语义扩到：静音窗 22:30–07:00 进次日 07:00–08:00 汇总、`activation.json` 开闸下界（缺 ⇒ `rc=4`）、
  //        `attempts.json` 有界重试（3 轮 ⇒ `gave-up`）。
  //     真源 = `docs/` §2 C3/C4 · §3.5；N2 交付报告同批。
  //   ⚠️ **默认关（交付纪律）**：声明 `defaultWhenUnset:'off'` ⇒ 任何机器（含对端：butler-autonomy.json
  //     不跨机同步）缺 `jobs['family-remind']` 覆盖项时一律不跑；放行 = `butler-autonomy-cli.mjs job on
  //     family-remind --reason "…"`（只改开关不改代码）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是启动期常量）：`--stop` + `--ensure`。
  //   ⚠️ 锁登记必须同步加在 `lib\butler-locks.mjs`（否则 J3「调度表 job 未登记锁」红）。
  //   ⚠️ 数据根 = `~/.dsh/family-calendar`（env FAMILY_CALENDAR_HOME 可覆盖）；脚本默认 dry-run，`--apply` 才写。
  //   initialMs 70_000：与三个 1 分钟 job（restart 5s / queue 20s / stuck-recovery 45s）错峰。
  { id: 'family-remind', label: '家庭日程提醒（每 1 分钟 · 默认关 · 不发真消息）', intervalMs: 1 * MIN, initialMs: 70_000,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'family-calendar', 'family-remind-tick.mjs'),
    args: ['--once', '--apply', '--account', process.env.FAMILY_BOT_ACCOUNT ?? '<bot-account>'], dir: path.join(DSH, 'tools', 'family-calendar'), benignExitCodes: [3], benignExitLabel: '未初始化（events/relations 缺失 / 数据目录不可写）⇒ 本轮让路（开闸未就绪 4 不在此列）' },
  // ── 记忆衰减 P1·A0 · 召回命中留痕旁路采集（2026-10-23 · 卡「记忆衰减 P1·A0」）───────────
  //   语义 = 每 10 分钟把 `~/.dsh/logs/memory-recall.log` 的**新增** `inject`/`expand`/`search`
  //     事件抄进 `~/.dsh/memory-hits/YYYY-MM.jsonl`（按行内 `t` 归月，一行一事件；幂等键 = sha1(原始行)）。
  //   为什么要它：方案 §6 P1 留痕期的**唯一入口** —— 现成日志里有 inject（带 ids）与 expand（带 id），
  //     但每代 ~8 天就被轮转覆盖 ⇒ 不抄一份，"最近用过没有"永远没有数据（F2 恒 0）。
  //   真源 = `docs/` §5.1.1（实现契约十条）· §6 · §7.3。
  //   ⚠️ **只读日志 + 写旁挂**：`dsh-memory` 插件一个字节不改、不写 `memory.db`、不动 pinned
  //      ⇒ 注入链零影响（读数一字不变，见交付报告关回演练）。
  //   ⚠️ **默认关（交付纪律：新自治动作默认关）**：声明 `defaultWhenUnset:'off'` ⇒ 任何机器
  //      （含对端：`butler-autonomy.json` 不跨机同步）缺 `jobs['memory-hit-collect']` 覆盖项时一律不跑；
  //      放行 = `node tools\dsh-butler\butler-autonomy-cli.mjs job on memory-hit-collect --reason "…"`
  //      （只改开关不改代码）；关回 = 同款 `job off` + 挪走 `~/.dsh/memory-hits/` = 彻底回到今天。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是启动期常量）：`--stop` 然后 `--ensure`。
  //      这不碰 dsh 进程、**不是** dsh 重启 ⇒ 不走 P0 闸门。
  //   ⚠️ 锁登记必须同步加在 `lib\butler-locks.mjs`（否则 registry-audit 的 J3「调度表 job 未登记锁」红）；
  //      脚本自身另有一把 `~/.dsh/memory-hits/.collect.lock`（wx 独占 + 5 分钟陈旧接管）防手工直跑并发。
  //   ⚠️ **10 分钟节奏**（采集不是实时需求；日志 maxBytes=1MB ⇒ 约 8 天才轮转一代）。
  //   initialMs 200_000：与既有 job（5s/10s/20s/30s/45s/60s/70s/90s/100s/130s/210s…）错峰。
  //   ⚠️ `benignExitCodes:[3]`：日志缺失 / hits 目录不可写 / 上轮未释放 = 环境语义（脚本 fail-open 返回 3），
  //      本轮让路、不涨 failures；真异常才 rc=1 计失败（§7.3「连续 3 次 rc≠0 ⇒ 告警」）。
  //   ⚠️ 脚本默认 **dry-run**（`--once` 不带 `--apply` 一个字节不写）⇒ 本行显式给 `--apply`。
  { id: 'memory-hit-collect', label: '记忆召回命中留痕采集（每 10 分钟 · 默认关 · 只读日志）',
    intervalMs: 10 * MIN, initialMs: 200_000,
    defaultWhenUnset: 'off',
    script: 'memory-hit-collect.mjs', args: ['--once', '--apply'], dir: HERE,
    benignExitCodes: [3], benignExitLabel: '日志缺失 / hits 目录不可写 / 上轮未释放 ⇒ 本轮让路' },
  // ── 心情播报定时（2026-11-02 · 跨线派活：the operator<mainline>线 → butler线 · the operator 13:3x 拍板「A+B 一起」）──
  //   语义 = 每 15 分钟跑 `tools\mood-broadcast\broadcast.mjs`，把本机 state 读成一枚小快照写到
  //     `~/.dsh/feiyu-mood-broadcast/<机器名>.json`（本机 = <host-a>.json），供对端只读拉取。
  //   治什么：判据 14-c「两边互相听得见」要求播报件保持新鲜；方案档 L87 早就写了「每 N 分钟播一次」，
  //     但**从未实现** ⇒ 播报件只在人工跑时更新，30 分钟后就判红。技术债 = `docs\技术债台账-the operator<mainline>.md` TD-35。
  //     时效判据 = 播报落后 state ≤ 30 分钟（= 2× 周期），判据器默认 maxStaleMin=30 正好，不改器具阈值。
  //   🔴 三条不许（10-31 the operator 00:37 口径，踩了就做成「谁是真身」的选举）：
  //     ① 不碰 push-to-peer / mood-sync 的 --peer-apply 与任何「推 state 到对端」的路径；
  //     ② 脚本只写**自己那一份**播报件，绝不写对端任何文件、绝不写 state（写完自证 sha 一字未变，污染 exit 9）；
  //     ③ 本行不传任何额外参数（缺省行为即口径；`--with-reason` 会多播 lastReason，未获授权不加）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是启动期常量）：`--stop` + `--ensure`；这不碰 dsh，不是 dsh 重启。
  //   ⚠️ 锁登记必须同步加在 `lib\butler-locks.mjs`（否则 registry-audit 的 J3「调度表 job 未登记锁」红）；
  //      脚本自身**没有** acquireTickLock ⇒ 走 `lockRunner: true` 包装层抢锁。
  //   ⚠️ 默认关（新自治动作交付纪律）：放行 = `butler-autonomy-cli.mjs job on mood-broadcast --reason "…"`。
  //   ⚠️ `benignExitCodes:[3]`：state 读不到/读不懂（心情插件未初始化）属环境语义 ⇒ 本轮让路、不涨 failures；
  //      **exit 9（播报污染了 state）不在此列**，会照常计失败并进 last-error。
  //   initialMs 180_000：与既有 job（…130s / 200s / 210s / 240s …）错峰。
  { id: 'mood-broadcast', label: '心情播报（每 15 分钟 · 只写本机那份 · 默认关）',
    intervalMs: 15 * MIN, initialMs: 180_000,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'mood-broadcast', 'broadcast.mjs'), args: [],
    dir: path.join(DSH, 'tools', 'mood-broadcast'),
    benignExitCodes: [3], benignExitLabel: 'state 读不到/读不懂（心情插件未初始化）⇒ 本轮让路；exit 9 污染 state 不在此列' },
  // ── 协调线 R1-6 · Router 守护与巡检（2026-11-02 · 卡「协调线 R1-6」）────────────────────
  //   语义 = 每 30 分钟把 Router 那套「不该坏的东西」现读一遍：能自己拨回来就拨回来（记一行），
  //     拨不回来就报警一行。五项 = 置顶复位 / 归档保护 / 会话身份漂移 / Bot ready / cwd 还在
  //     （真源 `docs\方案-Router Session-20261102.md` §3 R1-6 行 · §4 R1/R2 · §6 R10）。
  //   治什么：① 24h 归档会把 Router 会话搬走（§4 R1）② QQ 掉线没人看见（§4 R2）
  //     ③ 换过会话之后 prefs 钉子变成死值（§6 R10：the operator的 QQ 消息进旧会话、GUI 里新会话一片空白）。
  //   ⚠️ 复位面只有两件 RPC（`workspace.insertBefore` / `workspace.unarchiveSession`）+ 一次 prefs 改写；
  //     **绝不自己重启 dsh**（重启是 P0 闸门的事）· **不自动建目录**（免得将错就错）·
  //     **不碰 QQ 插件 dist / groupMode / c2cAllow**（那三样归 R1-3 的卡）。
  //   ⚠️ 默认**开**：本卡判据要求「重启后从 `--status` 看见 runs 涨、lastStatus=ok」⇒
  //     不能写 `defaultWhenUnset:'off'`。关回 = `butler-autonomy-cli.mjs job off router-guard --reason "…"`。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是启动期常量）：`--stop` + `--ensure`；
  //     这不碰 dsh 进程、**不是** dsh 重启 ⇒ 不走 P0 闸门（但本卡另有一趟 P0 重启是为了让 dsh 侧无变化可验）。
  //   ⚠️ 锁登记必须同步加在 `lib\butler-locks.mjs`（否则 registry-audit 的 J3「调度表 job 未登记锁」红）；
  //      脚本自身有 `acquireTickLock('router-guard')` ⇒ **不加 `lockRunner`**（包装层再抢同一把锁会让子进程
  //      永远判 locked，steward 同款先例）。
  //   ⚠️ `benignExitCodes:[3]`：workspace.json 与 prefs **两处都读不到** = 环境未就绪 ⇒ 本轮让路、不涨 failures；
  //      「有报警」**不是**脚本失败（rc 0）——报警自己落 `~/.dsh/butler-alert.log`（同一条出口，按 sig 6h 去重）。
  //   ⚠️ 30 分钟节奏：判据的时间尺度是分钟级；太密会与其它高频 job 抢锁（本卡待拍板项，按建议值落地）。
  //   ⚠️ `budgetMs` 30s：一轮 = 读三份文件 + 最多 2 次写 RPC（实测 300~500ms），给足余量。
  //   initialMs 150_000：与既有 job（…90s / 100s / 130s / 180s / 200s / 210s …）错峰。
  { id: 'router-guard', label: 'Router 守护巡检（每 30 分钟 · 置顶/归档/钉子/Bot/cwd）',
    intervalMs: 30 * MIN, initialMs: 150_000,
    script: 'router-guard.mjs', args: ['--once', '--apply'], dir: HERE, budgetMs: 30_000,
    benignExitCodes: [3], benignExitLabel: 'workspace.json 与 prefs 两处都读不到（环境未就绪）⇒ 本轮让路' },
  // ── 协调线 · 年轮判据 A-3（2026-11-05 · 卡「Router 年轮 A1A3」）· Router 结论槽位每日机械收口 ──
  //   判据原文（`docs/` A-3 · 逐字）：「每条在跑的主线**都有一行结论**在槽位里（不是只记 4 条）」
  //   语义 = 每天 22:10 把**每条「有活的主线」**各写一行结论进 `docs/`：
  //     取该线最近一张 **done 卡**的标题（≤120 显示宽）+ 卡 id 作 ref；没有 done 卡的线退化成
  //     「状态词：最近一张卡」（同样机械，不编）。口径与 `brief` 车况同一套（aggregate + activeCount>0）。
  //   🔴 **零模型调用**：无 LLM、无外部网络请求（只有一次既有的本机看板 GET）；写盘走 `router-act.mjs digest`
  //     那一条既有路径（幂等键 = 线名 + 日期；槽位 ≤16 行 × 每行 ≤120 显示宽；超了明写哪几条没写 + 谁被滚出窗）。
  //   ⚠️ 默认**开**（缺键 = 开）；关回 = `butler-autonomy-cli.mjs job off router-digest --reason "…"`。
  //   ⚠️ 锁 = 脚本自身 `acquireTickLock('router-digest')`（登记在 `lib\butler-locks.mjs`），**刻意不加 lockRunner**
  //      （router-act 的 main() 是异步的，包装层 import 一返回就放锁/读退出码 ⇒ 会漏掉真失败，router-guard 同款先例）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是启动期常量）：`--stop` + `--ensure`；这不碰 dsh，不是 dsh 重启。
  //   budgetMs 120s：一轮 = 一次看板 GET + 最多 16 次追加（实测秒级）。
  { id: 'router-digest', label: 'Router 结论槽位每日收口（零模型 · 每线一行）', at: '22:10', initialMs: 0,
    script: 'router-act.mjs', args: ['digest', '--auto', '--apply'], dir: HERE, budgetMs: 120_000 },
  // ── 协调线 · Router「静默收信」的唤醒端（2026-11-06 · 卡「Router 静默收信」· 方案 §4.7-1）──
  //   语义 = 每 5 分钟判一次"有没有没认领的静默来信"，有就投**一条**唤醒（正文「静默批 · 未认领 N 条」）；
  //     没信 ⇒ 零动作、零成本；六条闸全在脚本里（`.off` / 无未认领 / 额度 / Router 在跑 / 归档换棒 / 其余投）。
  //   ⚠️ 默认**开**（缺键 = 开）；关回 = `butler-autonomy-cli.mjs job off router-inbox-flush --reason "…"`。
  //   ⚠️ 锁 = 脚本自身抢**两把**：job 锁（`router-inbox-flush`，由 LOCK_REGISTRY 那条给）+
  //     数据锁（`router-inbox`，只在"读档 / 记账"两个短临界区里抢，**投递期间不持锁**）。
  //     所以**不加 `lockRunner`**（包装层再抢同一把会让子进程永远判 locked；router-guard / router-digest 同款先例）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是启动期常量）：`--stop` + `--ensure`；这不碰 dsh，不是 dsh 重启。
  //   budgetMs 120s：一轮 = 一次 session.list + 一次 spawn session-say（后者自身 90s 超时）。
  //   initialMs 240_000：与既有 job（…90s / 100s / 130s / 150s / 180s / 200s / 210s …）错峰。
  { id: 'router-inbox-flush', label: 'Router 静默批唤醒（每 5 分钟 · 无来信不投）',
    intervalMs: 5 * MIN, initialMs: 240_000,
    script: 'router-inbox-flush.mjs', args: [], dir: HERE, budgetMs: 120_000 },
  { id: 'watch',     label: 'P2 会盯人',       intervalMs: 5 * MIN,  initialMs: 10_000,
    script: 'dsh-butler-watch.mjs', args: [], dir: HERE },
  // 【F-B2 · 2026-10-10 · 卡 01c658b1「补守护鱼」】分身「僵留」自动收官（tickd job）。
  //   为什么：分身修完是"挂起等验收"（linger 不自杀），没人执行 finish 就**永远留着** —— 生产实录
  //   2026-10-10 14:33 那份 tick 报「修复分身 1 个（PID 6888）跑完未收尾：本轮报告已落盘 819 分钟」。
  //   方案原口径是"先观测 7 天"，观察期已过（约 18 天）仍未闭环 ⇒ 本 job 补上"跑完就该收"这一环。
  //   ⚠️ 属**新增自治动作** ⇒ 默认**关**。唯一权威层 = `~/.dsh/butler-repair.json#lingerAutoFinish`
  //      （缺省 false ⇒ 脚本自己零动作、只打印一行判定，rc 0）；源码**不写** `enabled:false`
  //      （写死 = 硬禁用，`job on` 也打不开，与 stuck-recovery 同口径）。
  //      放行 = `node tools\dsh-butler\butler-repair-linger-tick.mjs --on`（只改开关不改代码）；
  //      关回 = 同款命令 `--off`；随时可看 `--status`。
  //   ⚠️ 动作**走既有 CLI** `node <butler-root>\repair-ctl.mjs finish`（不自写标记、不杀进程 —— 收官语义
  //      由分身自己处理）；判据保守：有分身 ∧ 报告已落盘 > 15 min ∧ 无生效挂起锁 ∧ 无 finish 标记，
  //      任一项读不到 ⇒ 不动（fail-closed）。真跑过的证据 + 台账见卡报告 §3-F-B2。
  //   ⚠️ 30 分钟节奏：判据的时间尺度是分钟级，且每次要起一次 CIM 查询（实测 1.6~1.9 s）⇒ 不必更密。
  { id: 'repair-linger', label: '分身僵留自动收官（默认关）', intervalMs: 30 * MIN, initialMs: 100_000,
    script: 'butler-repair-linger-tick.mjs', args: ['--tick'], dir: HERE },
  { id: 'barewatch', label: '裸跑期观测采集',   intervalMs: 5 * MIN,  initialMs: 130_000,
    script: 'barewatch-tick.mjs', args: [], dir: HERE },
  { id: 'watchfs',   label: 'P5 磁盘层审计',   intervalMs: 10 * MIN, initialMs: 30_000,
    script: 'butler-watch-fs.mjs', args: ['--once'], dir: HERE },
  { id: 'pitfall',   label: 'P4 会学习（坑库）', intervalMs: 30 * MIN, initialMs: 60_000,
    script: 'pitfall-tick.mjs', args: [], dir: HERE, benignExitCodes: [5], benignExitLabel: '坑库真源缺失/读不出/0 条目 ⇒ 拒渲染（不写空壳、已告警）' },
  { id: 'external',  label: 'P6 会望风',       intervalMs: 60 * MIN, initialMs: 90_000,
    script: 'butler-external.mjs', args: [], dir: HERE },
  { id: 'daily',     label: '日报兜底',         at: '09:00', initialMs: 0,
    script: path.join(PANEL, 'report.mjs'), args: [], dir: PANEL },
  // 【G23-1 · 服务面主动推送 PM1】每日早报（09:05）：
  //   口径真源 = `docs/` §1.1/§1.2/§3.4-D2 —— 常驻形态 = **tickd job**
  //     （2026-09-18 the operator照准选项 c：不新建常驻进程、不新建插件、不新建 Windows 计划任务；
  //      推送时「连→认证→发→断」，空闲不占连接 ⇒ 不与将来任何常驻长连接互踢）。
  //   ⚠️ 为什么 09:05：`daily`(09:00) 才落日报，早报要等它；且 09:05 距前一天 09:05 ≈24h05m
  //      ⇒ 方案 §2 已标为「窗口踩线」风险点，兜底 = 早报末行「回「1」可续期」提示。
  //   ⚠️ **默认关**（交付/放行分离，R3 锁后交付）：本行只落*表位*，不自动开跑。
  //      放行 = `node tools\dsh-butler\butler-autonomy-cli.mjs job on secretary-morning --reason "..."`（**只改开关不改代码**）；
  //      开跑前还须确认闸文件 `~/.dsh/butler-secretary.json#switches.push` 为 true（出口每次先读它）。
  //   ⚠️ 出口唯一：本 job 只调 `secretary-morning.mjs`（取数），真正发送/闸门/预算/台账全在 `tools\secretary-notify.mjs`。
  { id: 'secretary-morning', label: '服务面早报（外部通道推送 · 默认关）', at: '09:05', initialMs: 0,
    script: 'secretary-morning.mjs', args: [], dir: HERE },
  // ── 2026-11-02（卡 6f121702「协调线·脑子」steward.mjs 甲层）：`steward` ──────────────────────
  //   语义 = 协调线的「**脑子**」甲层：读现成产物（看板 / `standup.mjs` 晨报 / 两份年轮 json）→
  //     按方案 §4.1 四条排序（failed 优先 → ageDays 倒序 → 可恢复性 → id 字典序）→
  //     出「**上桌** ≤3 件 + **收敛线** 总数」→ 写 `~/.dsh/steward-state.json`（幂等键 `sha16(卡id|动作|日期)`）。
  //   **零模型调用、零 token**（方案 §1.1 甲层）；乙层"把候选写成背景/选项/建议/代价"是另一张卡，
  //     本 job **不接任何模型调用**。
  //   🔴 不叫停 / 不砍线 / 不重派 / 不建卡 / 不验收卡 / 不动看板（只读 GET）/ 不发任何喊话（方案 §3.1 / §5）。
  //   为什么挂 tickd job 而不是 recurring 卡（方案 §7.1 已定）：recurring 卡每触发一次 = 开一个真实会话
  //     = 烧 token 且带上下文，而脑子是**批处理**、不该有会话。
  //   ⚠️ 08:20 刻意排在 `stall-nudge`(08:30) / `preset-drift`(08:50) / `daily`(09:00) 之前：
  //     它产出的是"今天先看什么"的排序，要早于日报与停滞提醒，免得同一屏三个声音抢注意力。
  //   ⚠️ 锁 = 脚本自己 `acquireTickLock('steward')`（登记在 `lib\butler-locks.mjs`，**刻意不加 lockRunner**：
  //     包装层再抢同一把锁会让子进程永远判 locked）。
  //   ⚠️ 退出码：0 = 正常（含"锁被占 ⇒ 本轮跳过"）；3 = 硬输入读不到（账本 / 晨报）⇒ 照旧记 failures 让人看见。
  //   ⚠️ 跨机：代码同步到对端后那边也会各跑一份（state 不跨机，方案 §1.4 第一版单机）⇒ **同步前**先在对端
  //     `butler-autonomy-cli.mjs job off steward --reason "对端不跑"`（同 stall-nudge / preset-drift 先例）。
  { id: 'steward', label: '协调线脑子（只读产物→写账 · 零 token）', at: '08:20', initialMs: 0,
    script: 'steward.mjs', args: [], dir: HERE, budgetMs: 180_000 },
  // 【主线停滞提醒 v1 · 2026-10-23 · 卡「butler·主动推进」】工作日 08:30 真发外部通道。
  //   为什么：现有 job 都在管**卡**（queue / card-watchdog / 失败通知），没有一个在看
  //   「**主线**是不是停摆了」—— 交接档写完也没人读它的 §5「下一步」。
  //   the operator 2026-10-23 11:05 原话：「很多主线做着做着我就忘了推进了，其实这些事才是应该你主动来找我的。」
  //   形态 = `at:'08:30' + days:[MON..FRI]`（多星期形态，按 lastDay 去重；周末不跑）。
  //   参数 = `--apply --push`：写 `docs/`（**全部候选**）+ Top 3 真发外部通道。
  //   三道闸（同日一次 / Top N / 同 key 24h）全在 `stall-nudge.mjs` 内；job 本身不重试。
  //   ⚠️ 跨机：代码同步到 <host> 后，两侧 08:30 会各推一次（state 不跨机）⇒ **同步前**先在对端
  //      `butler-autonomy-cli.mjs job off stall-nudge --reason "对端不推"`（本机保持开）。
  { id: 'stall-nudge', label: '主线停滞提醒（工作日 08:30 · 外部通道）', at: '08:30', initialMs: 0,
    days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    script: 'stall-nudge.mjs', args: ['--apply', '--push'], dir: HERE, budgetMs: 120_000 },
  // 卡 [8] P7 会照应：跨载体对账（耦合 / 落地缺口 / 脱管任务）。
  //   为什么单独一个 job：日报段（09:00 的 daily job）只在"当日首次开 DSH 或 09:00 兜底"时生成，
  //   若当天日报已生成在前、后又在盘中建了卡，就没人再跑对账；这里每天补一次（幂等 + 24h 去噪）。
  //   纯文本匹配 0 token；本脚本自带 tick 锁与 schema 守卫，失败只落 tickd 状态、不影响其他 job。
  { id: 'reconcile', label: 'P7 会照应（跨载体对账）', at: '09:10', initialMs: 0,
    script: 'butler-reconcile.mjs', args: ['--check'], dir: HERE },
  // 官方上游动态（2026-09-15 the operator拍板「每天盯一次」）：
  //   A 线（dsh-upgrade-watch）只报 release tag / 最近提交的**时间戳**，看不出「官方干了啥」；
  //   本 job 出**内容级**增量：compare API 的自基线提交明细（默认滤 merge）+ 目录热点 +
  //   断裂面符号分级告警（只认生产代码命中）+ 版本线（主包 / 桌面版 @deepseek-ai/dsh-desktop）。
  //   基线 ~\.dsh\upstream-watch-<host>.json（按主机分文件）；报告落 docs/。
  //   09:20 接在 daily(09:00) / reconcile(09:10) 之后，串成早晨巡检；每次约 5-6 次 GitHub API 调用
  //   （未认证配额 60 次/小时，一天一次远低于限流）。只读 + 零 token，失败只落 tickd 状态。
  { id: 'upstream', label: '官方上游动态', at: '09:20', initialMs: 0,
    script: path.join(DSH, 'tools', 'dsh-upstream-watch.mjs'),
    args: ['--report-dir', path.join(DSH, 'docs', 'report-dir')], dir: path.join(DSH, 'tools') },
  // 外部通道官方 SDK 版本盯梢（2026-10-30 · the operator 17:20 拍板「发图暂缓，盯着 SDK 更新」）：
  //   为什么：外部通道腿（iLink）下行 CDN 要第二个参数 `encrypted_param`，而官方 SDK 2.4.10 仍是单参数
  //   （服务端先改、SDK 没跟）⇒ 「发二维码图片」暂缓。官方哪天发新版 ⇒ 脚本写一条 info 告警喊人回来看。
  //   纯只读 + 零 token + 零依赖；状态 `~/.dsh/wechat-sdk-watch-state.json`，同一版本只喊一次（幂等）。
  //   **绝不自动升级**（脚本只"看"，不装包）；网络失败打印一句 + exit 0（不刷告警）。
  //   10:10 落在早晨巡检链（09:00→09:40）之后、与其余表位不撞车。
  //   真源 docs/ / docs/
  { id: 'wechat-sdk-watch', label: '外部通道官方SDK版本盯梢', at: '10:10', initialMs: 0,
    script: path.join(DSH, 'tools', 'wechat-bridge', 'watch-official-sdk.mjs'),
    args: [], dir: path.join(DSH, 'tools', 'wechat-bridge') },
  // 升级巡检（2026-09-15 · 卡 S8「升级分级授权·A3」②：重建「DSH 版本体检」/「Adapter 生态跟踪」的载体）
  //   为什么是 tickd job 而不是看板 recurring 卡（**重建选型的论证**）：
  //     ① 口径 §5 / §6 D2 已拍板「执行主体 = 计划任务脚本链，0 token，不建卡、不唤起 LLM 会话」；
  //     ② recurring 卡每触发一次 = 开一个真实 DSH 会话（烧 token），且卡依赖 DSH 正开着
  //        （关机即静默跳过 —— 升级方案 §9.4 环 C 点名的缺陷），还有"跑完自动 done 而 cron 仍开"的历史坑；
  //     ③ 体检本身是**确定性只读操作**（读决策表 + 三件只读工具 + 落一份报告），不需要 LLM。
  //   频率：tickd 调度器只支持 'HH:MM' / 'MON HH:MM'（无月频形态），故**每天 09:30 触发**，
  //     由脚本内的月频闸（默认 1/15）决定是否真跑 —— 非目标日直接 exit 0（成本≈启动一次 node）。
  //     频率可配置：~/.dsh/upgrade-automation.json 的 patrol.days（口径 D4 待the operator拍板是否保留月频）。
  //   09:30 接在 daily(09:00) / reconcile(09:10) / upstream(09:20) 之后，串成早晨巡检链。
  { id: 'upgrade-patrol', label: '升级巡检（只读报告）', at: '09:30', initialMs: 0,
    script: path.join(DSH, 'tools', 'dsh-upgrade-orchestrator.mjs'),
    // `--no-fail-on-red`：**发现 🔴 是巡检的正常结论，不是 job 失败** —— 不加它会让 tickd 把
    //   "今天有 5 个插件判 🔴"记成 failures，进而在日报「tick 调度健康」段天天告警（告警疲劳）。
    args: ['--patrol', '--no-fail-on-red'], dir: path.join(DSH, 'tools') },
  // 小秘书跨机体检（2026-10-21 · 交接档 `docs/` §5-3 可自拍项①）：
  //   为什么：2026-10-21 白天实测踩到 —— <host> 上跑着**旧版** `_test\test-secretary-*.mjs`，
  //   旧夹具把 10 条假语料写进了生产素材根。根因 = 两侧测试件版本不同步且没人天天比。
  //   本 job 每天只读比一遍两侧 sha/大小，差异落 `docs/`，**不自动改任何一侧**
  //   （下发与否由人拍）。零 token、只读；判据与分级见 `tools\secretary-drift-check.mjs` 头部。
  //   09:40 接在 daily(09:00)/reconcile(09:10)/upstream(09:20)/upgrade-patrol(09:30) 之后，串成早晨巡检链。
  //   ⚠️ `benignExitCodes:[3]`：对端不可达（公司网隧道关 / 对端离线 / 别名不通）是本剧本的正常让路，
  //   不记 failures（同 coldbackup / hot 的理由：外部阻塞不该刷红）。
  //   通道择路由脚本自己做（先 `--peer` 给的别名，不通再试 `<别名>-lan`）。
  { id: 'secretary-drift', label: '小秘书跨机体检（只读 · 每天 09:40）', at: '09:40', initialMs: 0,
    script: path.join(DSH, 'tools', 'secretary-drift-check.mjs'),
    args: ['--peer', '<peer>', '--report-dir', path.join(DSH, 'docs', 'report-dir')],
    dir: path.join(DSH, 'tools'),
    benignExitCodes: [3], benignExitLabel: '对端不可达（隧道关 / 对端离线）⇒ 本轮让路' },
  // preset 漂移巡检（主线「the operator<mainline>」卡① · 2026-10-23）：
  //   为什么有它（主线验收判据第 8 条）：「任何人改完人格忘了重内联 ⇒ **当天就被发现**，不靠人想起来」。
  //   0.2.0 只认 `cordis.patch.yml` 的**内联**，目录版是手改的真源 ⇒ 两份漂移 = 改了不生效、且没人知道
  //   （<host> 的 whale-girl 29,380 / 27,070 自 2026-10-21 起就是这个状态，直到 10-23 手工比对才发现）。
  //   本 job 每天只读比一遍「本机 + 对端（缺省 <peer>）」每份 preset 的目录 ↔ 内联 + 关键标记命中数，
  //   报告落 `docs/`；日报「摘要」段渲染其中一行（lib\preset-drift-line.mjs）。
  //   ⚠️ **时段 08:50 是刻意的：必须早于 daily(09:00)** —— 日报要读**当天**那份报告；排在 09:00 之后就只能报到隔夜的。
  //   ⚠️ `benignExitCodes:[3]`（2026-11-04 卡 V31-031 · 两态拆分）：**只把「对端不可达」当让路** —— 对端没开机 /
  //     隧道没起是常态；真漂移由包装层给 **exit 1**（记失败、进告警）。旧口径 `[4]` 把真漂移一起吞了 = 假绿。
  //   ⚠️ 通道择路由脚本自己做（先 `--peer` 给的别名，不通再试 `<别名>-lan`）；对端**零写入**（只 ssh echo + scp 拉副本）。
  //   ⚠️ 跨机：代码同步到 <host> / <host> 后，那边也会各跑一次 ⇒ **同步前**先在对端
  //      `butler-autonomy-cli.mjs job off preset-drift --reason "对端不跑"`（同 stall-nudge 先例；本机保持开）。
  //   ⚠️ `budgetMs: 120_000`：**首轮实测 19,367 ms**（08:47:41 那一轮），缺省预算 10 s ⇒ 被记成
  //      「⏱ 超 1.937×」并写了一条耗时告警（30 分钟冷却）。耗时构成 = 1 次 `ssh echo %USERPROFILE%`
  //      + 2 次 `scp -r`（隧道下各 ~5 s，含 <host> 的 `.agent-presets` 整棵 + 202 KB 的 patch）≈ 3 次网络往返。
  //      抬到 2 分钟（同 stall-nudge 档）：真卡死（对端 SSH 半通）仍会被 budget 兜住。
  { id: 'preset-drift', label: 'preset 漂移巡检（只读 · 每天 08:50）', at: '08:50', initialMs: 0,
    script: path.join(DSH, 'tools', 'dsh-butler', 'preset-drift-tick.mjs'),
    args: ['--peer', '<peer>', '--report-dir', path.join(DSH, 'docs', 'report-dir')],
    dir: path.join(DSH, 'tools'), budgetMs: 120_000,
    benignExitCodes: [3], benignExitLabel: '对端不可达（隧道关 / 对端离线）⇒ 本轮让路；真漂移 exit 1 照红' },
  // ── 2026-10-26（卡「V3功能面·号段哨兵挂job」）：`band-sentinel` ─────────────────────────────
  //   语义 = 每天 08:50 跑一次「记忆号段复发哨兵」（`tools\memory-engine\band-sentinel.mjs --line`）：
  //     三台各读 `sqlite_sequence.seq`，看「**下一条新记忆 id**」是否落在本机独占段
  //     （<host> 2e6 / <host> 3e6 / <host> 4e6）。主判据**只认 seq**，六个段的计数只披露、不判红。
  //   为什么要有它（2026-10-26 真事故）：<host> 写了一条 `#3000000` → 合并搬进 <host> →
  //     **<host> 的 `sqlite_sequence` 被顶到 3,000,000** → 之后 <host> 每条新记忆都落进 <host> 的段，
  //     **靠the operator肉眼发现才止血**。A37 已治本（搬入一律落 1e6 段），但**没有哨兵就没人知道有没有再漏**。
  //   为什么挂在本线（不是做器具的<mainline>线 A43b）：那张卡的红线是「不改 `butler-tickd.mjs`、
  //     不挂任何 tickd job」，且 job 注册表是**单点共享文件**（两线同改必撞车）⇒ 代挂归本卡。
  //   ⚠️ **纯只读 / 零 token**：三台一律 `DatabaseSync({ readOnly: true })`；对端经 ssh 喂脚本
  //     （`node -`）、**对端不落任何文件**；不写 `memory.db`、不动 pinned、不重启任何东西。
  //   ⚠️ **rc 语义（必须按 benign 记账，否则每天一个假失败）**：
  //      · `0` = 三台全绿（不写日报正文）
  //      · **`3` = 号段异常**（要进日报 + 点名哪台哪条）
  //      · **`4` = 取数失败 fail-closed**（连不上对端 / 读不到库 —— **连不上 ≠ 正常**，也要进日报）
  //      · `2` = 用法错
  //     ⇒ 3 与 4 进 `benignExitCodes`：它们是「**有结论地跑完**」，不是 job 失败
  //     （同 `preset-drift` 的 3 / `secretary-drift` 的 3 / `coldbackup` 的 3 先例；真故障仍是 1/2 照红）。
  //     ⚠️ 代价如实登记：rc=3/4 都记 benign ⇒ tickd 的 `failures` 不涨、日报「⏱ tick 调度健康」段
  //        **不会自己变红** —— 号段异常的可见面 = 本 job 的 stdout 点名 + （待做）日报行接线。
  //   ⚠️ **时点 08:50 与 `preset-drift` 同点**（那条也 08:50，理由同样「必须早于 daily 09:00」）：
  //     两条都只读 + 跨机，tickd 逐 job 串行 spawn，实测一轮 ~4.5 s ⇒ 不冲突、也无共享写对象；
  //     整体避开 daily(09:00) / reconcile(09:10) / upstream(09:20) / upgrade-patrol(09:30)。
  //   ⚠️ **必须 `--stop` + `--ensure` 才生效**（JOBS 是模块级 const；`--status` 只是新进程读当前代码）。
  //     生效判据 = `%TEMP%\dsh-butler-tickd.log` 里出现 `loop: 启动 band-sentinel`。
  //   ⚠️ 锁登记已同步加在 `lib\butler-locks.mjs`（`band-sentinel`，**刻意不加 lockRunner**：
  //     脚本自身无 `acquireTickLock`、一轮纯读 ⇒ 并发最坏是两边各读一遍库，无写面可损坏）。
  //   ⚠️ `budgetMs: 30_000`：首跑实测 **4,532 ms**（本机直读 + 2 次 ssh）；缺省档位预算 2,000 ms
  //     （`light`/`class-default`）⇒ 不抬会判「超 2×」并每 30 分钟写一条告警污染 butler-alert。
  //   ⚠️ 一键关回 = `node tools\dsh-butler\butler-autonomy-cli.mjs job off band-sentinel --reason "…"`。
  //   口径真源：`docs/` §8 **V31-016**（需求登记）+ 本卡交付报告。
  //   ⚠️【2026-10-27 · 卡「V3功能面·哨兵默认关」】**本 job 只该在 <host> 上跑** ⇒ 声明 `defaultWhenUnset:'off'`
  //      （the operator 2026-10-27 01:0x 拍板 C 方案 = 治本，不是"对端先埋 job off"）：
  //      ① 器具要 `<host-a>`/`<peer>`/`<peer>` 三个 ssh 别名，三台里只有 <host> 齐；<host> 的 `~/.ssh/config` 只有
  //         `gitee.com`、<host> 只有 `<host-a>`/`<peer-lan>` ⇒ 那两台跑起来**必然 rc=4**（有结论地失败，但纯属无意义开销）。
  //      ② `butler-tickd.mjs` 是**双机同一份代码**（随仓同步）⇒ 对端同步到本版后**必须显式授权**才会跑；
  //         缺键即关 = fail-safe，因此**不必也不能**去对端预埋 `job off`（对端零写入）。
  //      ③ <host> 自己**已显式 `job on`**（`butler-autonomy.json#jobs['band-sentinel']`，
  //         `enabled:true` · by `cli:<user>` · 2026-10-27T01:07:32Z）—— 缺键即关，所以 <host> 靠这条显式记录活着；
  //         **误删该键 = <host> 哨兵自己也停**（已端到端反证过，见交付报告 §5-b）。
  //      跨机查证真源 = `docs/` §10。
  { id: 'band-sentinel', label: '记忆号段复发哨兵（三台 · 只读 · 零 token）', at: '08:50', initialMs: 0,
    script: path.join(DSH, 'tools', 'memory-engine', 'band-sentinel.mjs'),
    args: ['--line'], dir: path.join(DSH, 'tools', 'memory-engine'),
    budgetMs: 30_000,
    benignExitCodes: [3, 4], benignExitLabel: '号段异常(3) / 取数失败 fail-closed(4) ⇒ 有结论地跑完，不记失败',
    defaultWhenUnset: 'off' },
  // ── 冷备作业（**三 job 归并** · the operator 2026-10-13 16:12 拍板 #12/#13）────────────────────────
  //   归并前 = 三个独立 job：`imagegen`（每小时索引快照 · 时段窗 08:30–18:00）/
  //     `imagegen-full`（每周五 09:40 图片镜像）/ `rollback-offsite`（工作日 08:45 回滚点打包）。
  //     三套频率、三个开关，冷盘不可达时各自刷红（2026-09-29 08:2x the operator令其全部关回、改手动冷备）。
  //   归并后 = **一个作业按序跑两件**（入口 `tools/dsh-butler/coldbackup.mjs`）：
  //     ① `rollback-points-offsite.mjs --backup --prune`（回滚点打包 + 保留策略清理）
  //     ② `imagegen-backup.mjs --snapshot --with-images`（索引快照 + 图片增量镜像）
  //   调度 = **每周一 + 周五 13:00**（the operator口径 16:12：「每周一和周五各 1 次冷备，时间中午 13 点」）：
  //     `at:'13:00' + days:['MON','FRI']` = 多星期形态（按 lastDay 去重；非命中日不判定、不写 lastDay）。
  //   ⚠️ `benignExitCodes:[3]`（**the operator 16:12 #13 明确同意**）：两件脚本的"冷盘不可达"都返回 3，
  //     作业聚合成 3 ⇒ tickd 记 `deferred`、**不涨 failures**（「周一周五非工作日（冷盘不可达）就跳过」）。
  //     反向锚：真失败（exit 1）仍照常涨 failures 并报红（见 `_test/test-tickd-benign-exit.mjs`）。
  //   ⚠️ 冷盘根**故意不在 job 里传**（沿 2026-09-11 口径：tickd 是双机同一份代码，写路径 = 单机绝对路径病根）
  //     —— 两件各由脚本内的唯一口径解析（`--target` > 环境变量 > 主机名默认），见
  //     `tools/lib/rollback-points-root.mjs` 与 `tools/lib/imagegen-backup-root.mjs`。
  //   ⚠️ **默认关**（`defaultWhenUnset:'off'` = 交付 ≠ 放行）：放行 = `butler-autonomy-cli.mjs job on coldbackup`；
  //     一键关回 = `butler-autonomy-cli.mjs job off coldbackup`。归并前那三条 `enabled:false` 键
  //     （imagegen / imagegen-full / rollback-offsite）**保留在 butler-autonomy.json 里作历史留痕**，
  //     对本次无影响（JOBS 里已无这三个 id）。
  //   ⚠️ 沿革与原始口径：`docs/` §6b #12/#13（the operator原话逐条照录）。
  { id: 'coldbackup', label: '冷备作业（回滚点 + 生图 · MON/FRI 13:00）', at: '13:00', initialMs: 0,
    days: ['MON', 'FRI'],
    script: 'coldbackup.mjs', args: [], dir: HERE,
    benignExitCodes: [3], benignExitLabel: '冷盘（H:）不可达 ⇒ 本轮让路',
    defaultWhenUnset: 'off' },
  { id: 'weekly',    label: '周报',             at: 'MON 09:05', initialMs: 0,
    script: path.join(PANEL, 'report-weekly.mjs'), args: [], dir: PANEL },
  // 热采（H1b · 方案 §8「使用中（热）：每 30 分钟」）——只搬小文件 + **已闭合会话**，
  //   账本走 Host API 只读导出，memory.db 一律跳过；与交接器共用 tick-handoff.lock（见 butler-locks 的 hot 条目）。
  //   与 pitfall（30 分钟）错峰 210s，避开同一时刻双 I/O 高峰。
  //   ⚠️【卡 AT19（2026-09-16）】`benignExitCodes: [3]` —— 热采脚本的「让路 / 未完成」退出码，
  //      **不计入 failures**（记账见下面 runJob 的 `isBenignExit` 分支）：
  //        · hot-collect.mjs 头部退出码表 = 0 完成 / **3 让路或未完成** / 1 真失败
  //          （3 的三条来源：L120-125 抢不到交接锁、L140-149 双开嫌疑 fail-closed、L239 push-guard 挡推 ⇒ result=blocked|deferred）
  //        · 现场实测（2026-09-16）：日报「⏱ tick 调度健康」段常驻 🔴「hot 累计失败」，
  //          而审计流水 73 条 handoff-hot 里 result = ok 42 / blocked 30 / deferred 1，
  //          tickd 日志同期 hot 只有 exit-3（31 次）与 locked 跳过（224 次）——**零真失败**。
  //          即这 31 次"失败"全是"远端有本机不了解的提交 → 推前安全门拦住整仓推送"这类**外部阻塞**，
  //          与热采本身是否采集成功无关 ⇒ 记 failures 属误报（假红），会淹没真问题。
  //        · 只对**显式声明**的 job 生效：未声明的 job 收到任何非 0 码照旧计失败
  //          （反向锚 `_test/test-tickd-benign-exit.mjs`：未声明的 exit 3 仍报红、声明了但 exit 1 也仍报红）。
  //   ⚠️【2026-09-23 the operator拍板 · <sync-repo> 停热采】`args` 挂 `--skip-sessions`：热采不再采<sync-repo>
  //      （不写 `gitBackup\dsh-sessions`）⇒ <sync-repo> 工作副本无变化 ⇒ 不 commit、`ahead=0` ⇒ 不 push。
  //      改前实测：<sync-repo> `ahead=0` + 工作区干净 ⇒ 挂参数**不会**产生一次积压推送（不会再把配额顶高）。
  //      <sync-repo> 的体积检查段仍在跑 ⇒ 配额告警（当前 101.9% 🔴）继续可见，不是"看不见了"。
  //      恢复 = 把 args 改回 `[]`。真源：`docs/`。
  { id: 'hot',       label: 'P9 热采（30 分钟档）', intervalMs: 30 * MIN, initialMs: 210_000,
    script: 'hot-collect.mjs', args: ['--skip-sessions'], dir: HERE,
    benignExitCodes: [3], benignExitLabel: '交接锁被占 / 双开嫌疑 / 推前安全门拦截' },
  // ── 2026-10-11（卡「文件同步」· the operator 01:11 令）：`text-sync` 接 tickd ─────────────────
  //   为什么有它（**hot 的两个盲区**，实测口径见 tools\dsh-butler\text-sync.mjs 文件头）：
  //     ① `hot` 只采 `HOT_SPECS` 清单里的东西 —— <sync-repo> 只有 `docs\坑库` + `docs\report-dir`,
  //        `<butler-root>\docs` 其余全部（交付报告 / 方案 / 交接档 / 变更流水 / 文档总索引…）
  //        **自 2026-09-21 起就没进过仓**；
  //     ② `hot` **只读搬运、绝不向生产分发** ⇒ 对端采进仓的文本永远不自动落回本机生产位置。
  //   本 job 补这两半，面**只有文本**（`docs` + `.agent-presets`），与 hot **互补不重叠**
  //     （report-dir / 坑库刻意排除：前者机器自产会互顶，后者走 sigKey 语义合并）。
  //   为什么每小时：文本是小文件、增量通常 0~几十个；与 `memory-sync`（690s）错开用 `initialMs 780s`，
  //     并晚于 `memory-vectors`（510s）/ `tidy`（600s）/ `archive`（630s）/ `token`（660s）。
  //   锁：与 hot / handoff / memory-snapshot **共用 `handoff`**（同一个<sync-repo>+<sync-repo> 工作副本 + git index）。
  //   `benignExitCodes: [3]`：让路码 = 抢不到锁 / 工作树脏 / 远端分叉 / **通道不通（家网/代理都不通）**
  //     / 被超集挡推门拦 —— 属物理常态（对端关机、外出断网），不计 failures、不刷日报红。
  //   `defaultWhenUnset: 'off'`：**缺键即关**（fail-safe）—— 放行靠 `butler-autonomy.json#jobs['text-sync']`，
  //     这样对端机器（没有该键）不会自己动起来。
  { id: 'text-sync', label: '跨机文本同步（docs / persona / 流水 · 每小时 · 默认关）',
    intervalMs: 60 * MIN, initialMs: 780_000,
    script: 'text-sync.mjs', args: ['--apply'], dir: HERE,
    defaultWhenUnset: 'off',
    benignExitCodes: [3], benignExitLabel: '锁被占 / 工作树脏 / 远端分叉 / 通道不通 / 超集挡推' },
  // ── 2026-09-17（卡：记忆库每日 1 次热采 + 内容未变不推）────────────────────────
  //   语义：把 A 类不可重建资产 `memory.db` 的 RPO 从「Depart 冷采（最坏丢一天）」压到
  //   「每日 1 次且内容变化必然落仓」——`VACUUM INTO` 只读快照（实测 16~32ms / 1.70MB）→
  //   与<sync-repo> 现副本**逐字节比对** → 一致就**零写入 / 零提交 / 不增仓体积**；有变化才更新
  //   采集副本 + 走**既有**推送链路（`dsh-backup-sync.ps1 -Push`，含超集挡推门，不另造 push）。
  //   为什么 04:20：避开 hot（30 分钟档，整点/半点后 210s）、queue（1 分钟）、pitfall（30 分钟）
  //   与 rollback-offsite（03:30）/ daily（09:00）。
  //   为什么**不是** 30 分钟档（the operator 2026-09-17 已否决）：<sync-repo> 实测 240MB > §5.4 的 200MB 阈值，
  //   而 memory.db 是二进制快照、git 无法内容增量 ⇒ 高频只增肥不增价值。
  //   `benignExitCodes: [3]`：脚本的让路码（交接锁被占 / <sync-repo> 未 unlock / 推前安全门拦截）语义同 hot
  //   （卡 AT19 口径，真失败仍走 exit 1，照旧计 failures 并在日报报红）。
  //   锁：与 hot / handoff **共用 `handoff`**（同一<sync-repo> 工作副本，见 lib/butler-locks.mjs）。
  { id: 'memory-snapshot', label: '记忆库每日热采（未变不推）', at: '04:20', initialMs: 0,
    script: 'memory-snapshot.mjs', args: [], dir: HERE,
    benignExitCodes: [3], benignExitLabel: '交接锁被占 / <sync-repo> 未 unlock / 推前安全门拦截' },
  // ── 会话异地镜像（2026-09-20 · the operator拍板「主推 <host>，<sync-repo> 瘦身」）──────────────────
  //   为什么要它：Gitee <sync-repo>（免费私有仓 1GB 配额）装不下会话全量 —— 实测日增 ~150MB、
  //   2.7 天触线（09-16 已因超配额被拒推一次）。本 job 把 **会话（活跃+归档）+ 附件实体**
  //   增量镜像到 <host> 本地盘（7×24 常驻宿主，D 盘空闲 237GB），无任何配额约束；
  //   <sync-repo> 从此只承担「近 3 天 + 关键小件」的轻量异地轨。
  //   产物：tools/dsh-session-mirror.mjs（零依赖 tar+scp+ssh；**只增不删**：远端永不 purge）
  //   实测（2026-09-20 首传）：1664 文件 / 1342MB / 112s；增量 5~6 文件 / 4~6s。
  //   initialMs 480s：与 hot（210s，30 分钟档）错峰，避开同一时刻两个网络/IO 高峰。
  //   `benignExitCodes: [3]`：脚本的让路码 = **对端（<host>）不可达**（the operator外出/对端重启属常态）
  //     ⇒ 不计 failures、不刷日报红（口径同 hot，见上面 AT19 注释）。
  //   `lockRunner: true`：脚本自身无 acquireTickLock（可被手工直跑）⇒ 由 tickd 包装层抢锁，
  //     避免手工直跑与 tick 并发重复传输、争状态文件。
  //   【R9 · 2026-10-14 · 卡「传输类 job 通道自查 + 按需短租」】**通道不通时脚本自己把隧道开起来**：
  //     lan → tunnel 两条候选都探不通 ⇒ `relay-cli enable`+`up`（公司有线网短租纪律）⇒ 跑完
  //     `finally` 立刻 `down`，**只关"本次由我开的"**（进短租前已 `enabled=true` 的一律不关）。
  //     判据实现 = 共用件 `tools\lib\peer-channel.mjs`（同一份也被 `mirror-audit` / `--fetch` 用；
  //     `memory-sync` 自 2026-10-14（卡 R12）起**已合并到同一份共用件**：`mem-sync-tick.mjs` 的短租段调
  //     `ensurePeerChannel`、收尾调 `releasePeerChannel` ⇒ 同样是"只关本次由我开的"（真源 = R12 报告 §2/§3）。
  //     一键关回 = 脚本 `--no-tunnel-rent` ／ env `DSH_PEER_SHORT_RENT=off` ／ `peer-channel-cli.mjs off --apply`。
  //     ⚠️ 本 job 的**表位/参数一字未改**（只改脚本内容 ⇒ 改完无需重启 tickd）。
  //   ⚠️【M4 · 2026-09-27 · §5.5 [N5]】**本 job 在 state.json 里的健康语义已知失真 ⇒ 禁止再作健康判据**：
  //     `lockRunner: true` 的包装层（`lib\tick-job-runner.mjs`）**恒返 OK**（L212 起 `exitCode = RUNNER_EXIT.OK`、
  //     L218 `await import()` 不抛即恒 OK、L267 `process.exitCode = await main()` 把子脚本自设的
  //     `process.exitCode = 3` **覆盖掉**）⇒ 上面声明的 `benignExitCodes: [3]` 在这条路径上**拿不到**：
  //     `state.jobs['session-mirror'].lastStatus` 恒 ok、`benignExits` 恒 null、`consecutiveBenign` **恒 0**
  //     （2026-09-23 实测 runs=59 / consecutiveBenign=0，而脚本自己的 `lastResult=unreachable` —— 镜像停摆看不见）。
  //     ⇒ **健康判据真源 = 脚本自写的 `~\.dsh\butler-session-mirror.json`**（`lastResult` +
  //       `consecutiveUnreachable`；读取方 = `lib\tickd-health.mjs` 的 `judgeMirrorJob()`，阈值 N=3）。
  //     `benignExitCodes` 声明**保留**（tickd 记账形态照旧 / 其它读取方仍可用），但**不得**作健康判据。
  { id: 'session-mirror', label: '会话异地镜像（<host> → <host>）', intervalMs: 60 * MIN, initialMs: 480_000,
    script: path.join(DSH, 'tools', 'dsh-session-mirror.mjs'), args: [], dir: path.join(DSH, 'tools'),
    benignExitCodes: [3], benignExitLabel: '对端（<host>）不可达 → 本轮让路' },
  // ── 跨机骨架 · 第三柱（2026-10-11 · 卡【多端线·骨架第三柱】S4）────────────────────
  //   方案真源 = `docs/` §4.1 / §4.4 / §4.5。
  //   为什么要它：镜像**只增不删**（远端永不 purge）⇒「远端到底收到没有 / 本机登记有没有成僵尸」
  //     此前只能靠人手工跑 `--audit-remote`；本 job 把它接成**周频**核对，并把 JSON + 人读 md
  //     双落到 `docs\report-dir\`（与既有 `upstream-*.md` / `watch-*.md` 同目录习惯）。
  //   `--audit-remote` 全程**只读**（不写 `butler-session-mirror.json`）⇒ 与推送 job 没有共享写对象；
  //     锁仍**独立登记**（见 lib/butler-locks.mjs 的 mirror-audit 行 —— 漏登记 = J3 当场 ❌）。
  //   `benignExitCodes: [3]`：脚本让路码 = **对端（<host>）不可达**（the operator外出 / 对端关机属常态），
  //     口径同 hot / session-mirror。⚠️ **代价如实登记**（方案 §4.3 · R3-4）：连续 rc=3 ⇒ failures 恒 0
  //     ⇒ 日报「tick 调度健康」一声不响（补偿落点经复审判为"落点缺失"，已升级为方案 §6.5-D8 待拍，
  //     首期按默认 ③ = 零改动如实接受；⇒ 一级可见面是**周报 md**，不是日报）。
  //   `at: 'SUN 10:30'`：周日白天（the operator在家窗口概率高）、避开 imagegen-full(FRI) / weekly(MON) / 早间链；
  //     pickDue 语义实测 —— **命中日过了点仍会在本日后续 tick 补跑**（lastWeek 只在真跑完时写）。
  //   `budgetMs` 只是耗时预算（JOBS 无 kill 超时）；实测单次 1.7–6.1 s ⇒ 300 s 富余 ~50×。
  //   不配 `lockRunner`：本 job 走 `--audit-remote` 路径自身不抢锁（只 `--fetch` 路径持锁）⇒
  //     由 tickd 侧 `acquireJobLock` 兜底（手工直跑与 tick 的并发实测见 S4 交付报告判据⑥）。
  { id: 'mirror-audit', label: '会话镜像每周核对（周报）', at: 'SUN 10:30', initialMs: 0,
    script: path.join(DSH, 'tools', 'dsh-session-mirror.mjs'),
    args: ['--audit-remote', '--json',
      '--out', path.join(DSH, 'docs', 'report-dir'),
      '--report-md', path.join(DSH, 'docs', 'report-dir')],
    dir: path.join(DSH, 'tools'), budgetMs: 300_000,
    benignExitCodes: [3], benignExitLabel: '对端（<host>）不可达 → 本轮让路' },
  // ── 四个已实现动作接线（2026-09-15 卡 B1）─────────────────────────────────────
  //   四个动作（`queue-wake` / `p0-auto-restart` / `p5-auto-rollback` / `auto-heal`）此前**只有 CLI 与
  //   dry-run 通道、没有任何 tick 调用点**（矩阵 §3 表「当前状态」列的"动作未接线"）。
  //   这 4 条 job 把**执行路径**接进 tick 链：每轮 spawn `butler-auto-tick.mjs --job <id>`
  //   → 动作体内部的模块门（`checkModuleAllowed`）+ `runAction()` 统一闸门（L0 降档 / p3-auto 总闸 /
  //   24h 去重 / 单日上限 / token 预算）。
  //   ⚠️ 四门（`p3AutoEnabled` / `p0AutoRestartEnabled` / `p5AutoRollbackEnabled` / `autoHealEnabled`）
  //      **当前全关** → 每轮只产出 blocked，且零副作用（不写记账 / 不占额度 / 不写审计 / 不 spawn）。
  //      这正是接线目的：放行当天不是"第一次真跑"，而是"已空转千百轮"。
  //   job id 与动作 kind / L2 模块 id 同名（双向可追溯）；锁名 `p3-auto-<id>` 与
  //   `butler-auto-tick.mjs` 内调度器的锁名一致（见 lib/butler-locks.mjs 的登记注释）。
  //   initialMs 与既有 job 错峰（restart 5s / queue 20s / watch 10s / barewatch 130s）。
  { id: 'queue-wake',       label: 'P3 队列推进自动叫醒（默认关）', intervalMs: 5 * MIN,  initialMs: 240_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'wake'], dir: HERE },
  { id: 'p0-auto-restart',  label: 'P3 低水位自动重启（默认关）',   intervalMs: 5 * MIN,  initialMs: 270_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'restart'], dir: HERE },
  { id: 'p5-auto-rollback', label: 'P3 写后违规自动回滚（默认关）', intervalMs: 10 * MIN, initialMs: 300_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'rollback'], dir: HERE },
  { id: 'auto-heal',        label: 'P3 组件自修复（默认关）',       intervalMs: 60 * MIN, initialMs: 330_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'heal'], dir: HERE },
  // ── 2026-09-16（卡：P3 自主动作 ctx-guard · 上下文看门）──────────────────────
  //   语义：每 **2 分钟**（2026-09-22 the operator拍板由 5 分钟收紧）扫全部会话，对 `running === true` 且**投影用量**超软限（默认 300K）/ 硬限（450K）的
  //   会话投递一条「该移交了」的提醒。
  //   ⚠️ **投递通道 2026-09-24 起分两档**（卡「夜批03 · 投递分级实现」，the operator D27=(b′)）：
  //     · 软限 = `queue`（排队等当前回合结束，**不打断**，与交付前一致）；
  //     · 硬限 = **可 `steer`**（`session.prompt { mode:'steer' }`：当前 step 跑完时插话，**不 abort 工具**），
  //       但**默认关**（开关 = `butler-autonomy-limits.json` 的 `ctxGuard.steer.enabled`，未配置即关）
  //       + 危险动作豁免名单（判据唯一源 `lib/steer-gate.mjs`；卡执行会话一律不进名单）。
  //       动作风险级同步 **L1 → L2**（如实升档，见 `lib/autonomy-actions.mjs` 的登记注释）。
  //   job 自身（调度层）一行未动：本卡未改 job 周期/开关，**tickd 无需重启**。
  //   与 queue-wake 刻意相反：那个只叫空闲会话且要求目标唯一，这个瞄准在跑会话逐个各自投递。
  //   job id 与动作 kind / L2 模块 id **同名**（不同于上面四条短名 job，无历史包袱）。
  //   ⚠️ **默认关**（本卡交付纪律）：① `modules['ctx-guard'].baseline=false`（L2 模块默认关）
  //      ② 四键 `p3AutoEnabled=false`（L1 总闸关）⇒ 即使 job 跑起来，每轮也只产出 blocked、零副作用；
  //      ③ 生产 `butler-autonomy.json` 的 `jobs['ctx-guard'].enabled=false` —— 调度层也显式关着，
  //         放行时一把 `butler-autonomy-cli.mjs job on ctx-guard --why "..."`（**不改代码**）。
  //   initialMs 与既有接线 job 错峰（queue-wake 240s / restart 270s / rollback 300s / heal 330s）。
  //   ⚠️ 2026-09-22（the operator拍板）：intervalMs **5 → 2 分钟** —— 生产实测「越线 → 投递」原最坏要等一轮
  //      5 分钟（13:02:17 那次是当轮发出）；收紧后最坏等待降到 2 分钟。`initialMs` 360s 保持不变
  //      （仍与既有 job 错峰），**阈值（300K / 450K）不动**。
  { id: 'ctx-guard', label: 'P3 上下文看门（默认关）', intervalMs: 2 * MIN, initialMs: 360_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'ctx-guard'], dir: HERE },
  // ── 2026-09-16（卡：[盯卡巡检] 假结算 / 假 running 常驻巡检 + 主动通知）──────────
  //   语义：全量扫看板卡的两种「状态撒谎」——① **假结算**：卡在 review 但执行会话仍在跑；
  //   ② **假 running（僵尸卡）**：卡在 running 但执行会话已死，且**无法自愈**（rerun 报
  //   `task is already running or missing`、move 被拒）—— 这一类此前**没有任何巡检覆盖**，
  //   只能靠人肉盯（2026-09-16 实证：盯卡把验收会话拴住、单轮 toolMs 704s、上下文暴涨）。
  //   **只巡检 + 通知，绝不自动改卡状态**（不 confirm / 不 move / 不 rerun / 不碰账本）；
  //   判据复用 `lib/queue-watch.mjs` 的 `isExecutionAlive`（与 queue tick **同源**，不复制逻辑）；
  //   通知复用 queue 通道（目标降级链 + 桌宠 /whale/say + 会话 queue 模式注入 + alert），
  //   档位默认**跟随** `~/.dsh/butler-queue.json` 的 mode（也可用 `--mode` 独立设定）。
  //   ⚠️ **默认关**（本卡交付纪律）：生产 `butler-autonomy.json` 的 `jobs['card-watchdog'].enabled=false`
  //      —— 调度层显式关着；放行时一把 `butler-autonomy-cli.mjs job on card-watchdog --reason "..."`（**不改代码**）。
  //   initialMs 与既有接线 job 错峰（queue-wake 240s / restart 270s / rollback 300s / heal 330s / ctx-guard 360s）。
  { id: 'card-watchdog', label: '盯卡巡检（假结算 / 假 running · 默认关）', intervalMs: 5 * MIN, initialMs: 390_000,
    script: 'butler-card-watchdog-tick.mjs', args: [], dir: HERE },
  // ── 2026-09-17（卡：裸跑 L1 放行收尾 · 待办 B）──────────────────────────────
  //   `evidence-precheck`（待验收卡证据预检）：核验卡声明的交付证据路径是否真存在 + 审计规则，
  //   落 `~/.dsh/butler-precheck.json`（面板/the operator可查）并给出「🟡 证据缺失」通知清单。
  //   为什么现在才接：动作已在 L1 放行名单（总闸 `p3AutoEnabled` 已开、四键全关的旧账已翻篇），
  //   但本 JOBS 表**没有调用点** ⇒ 它永远不会自动跑（矩阵 §3 该行"已登记·已实现；未接线"）。
  //   闸门：`runAction({kind:'evidence-precheck', consumesQuota:false})` —— **只读动作不占每日额度**，
  //   但照旧受 L0 降档闸 + p3-auto 总闸约束；闸门关时只产出 blocked、零副作用（不写卡/不写账本）。
  //   入口沿用 `butler-auto-tick.mjs --job precheck`（与 AUTO_JOBS.precheck 同一实现，间隔同 10 分钟）。
  //   initialMs 与既有接线 job 错峰（queue-wake 240s / restart 270s / rollback 300s / heal 330s /
  //   ctx-guard 360s / card-watchdog 390s）。
  { id: 'evidence-precheck', label: 'P3 待验收证据预检（只读）', intervalMs: 10 * MIN, initialMs: 420_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'precheck'], dir: HERE },
  // ── 2026-09-17（卡：P9「H4 butler接入」子项 · Arrive-B）─────────────────────────
  //   语义：接机后把「对端看板快照 → 本机账本」并回自动化（P9 方案 §5.1 预留位，此前一直没实现）。
  //   为什么必须**在线**做：账本走 Host HTTP API（`board-merge.mjs`），而 Arrive-A 的插入点在
  //   `guard-ctl start` 之前（DSH 未起）⇒ 只能由 tickd（DSH 起来之后）驱动。
  //   门序（见 `lib/arrive-b.mjs#decide`）：Host 在线 → 无双开嫌疑 → 有对端快照 → 幂等键未处理过
  //   → 干跑干净则 apply / 有保守冲突只报告 / 真失败告警。任何一门不过都**不写生产账本**。
  //   ⚠️ **默认关**（本卡交付纪律，照 ctx-guard / card-watchdog 先例）：生产 `butler-autonomy.json`
  //      的 `jobs['arrive-b'].enabled=false` —— 调度层显式关着；放行一把
  //      `butler-autonomy-cli.mjs job on arrive-b --why "..."`（**不改代码**）。
  //      建议两档放行：先只报告（人工看几天报告）→ 再开自动 apply（方案 §3.6）。
  //   `benignExitCodes: [3]` —— 让路码（Host 不在 / 双开嫌疑 / 无对端快照 / 交接锁被占）属传输与
  //      环境类语义，**不计 failures**（卡 AT19 口径；真失败仍走 1）。
  //   ⚠️【H4b · 2026-09-21】**`defaultWhenUnset:'off'`（本卡新增的声明式缺键默认）**：
  //      本 JOBS 表随**<sync-repo>**（`ws:tools/dsh-butler` 分发清单）过河到对端，而 `butler-autonomy.json`
  //      **不跨机同步** ⇒ 对端没有 `jobs['arrive-b']` 覆盖项 ⇒ 旧口径下 `defaultEnabled=true`
  //      = **对端自动开跑、且旧版是"无冲突直接 apply"**（2026-09-17 H4a 验收时实测的跨机缺口）。
  //      声明 `defaultWhenUnset:'off'` 后：缺键即关（**只对本 job 生效**；其余 job 一个字没改，
  //      全局默认语义零改动 —— 见 `lib\autonomy-modules.mjs#declaredJobDefault`）；
  //      对端要跑仍是 `job on arrive-b`（有覆盖项就走 file 分支，声明不锁死开关）。
  //   intervalMs 15 分钟与 hot（30 分钟）错峰兜底；initialMs 450_000 接在既有错峰之后
  //      （… / ctx-guard 360s / card-watchdog 390s / evidence-precheck 420s）。
  { id: 'arrive-b', label: 'P9 接机看板并回（默认关）', intervalMs: 15 * MIN, initialMs: 450_000,
    script: 'handoff-arrive-b.mjs', args: [], dir: HERE,
    defaultWhenUnset: 'off',
    benignExitCodes: [3], benignExitLabel: 'Host 未就绪 / 双开嫌疑 / 无对端快照 / 交接锁被占' },
  // ── 2026-09-17（卡：P3 重复卡合并受控验收 · 接线 + 造样本 + 跑一次 + 回滚 + 定口径）──────
  //   `dup-cards-merge`（P3 L1 头部动作：重复卡合并 = 挂备注 + 清 schedule，**不删卡**）此前
  //   **有实现、无调度点**（只存在于 `butler-auto-tick.mjs` 的 AUTO_JOBS.dup，需人工 `--job dup`）——
  //   原为**the operator拍板保留手动**（见 docs/ L21/L88）；
  //   2026-09-17 the operator改拍板成「造受控样本 + 接一次 + 跑通验收」，本 job 据此新增。
  //   入口沿用 `butler-auto-tick.mjs --job dup`（与 AUTO_JOBS.dup 同一实现）。
  //   闸门：`runAction({kind:'dup-cards-merge'})` —— 过 L0 降档闸 + `p3AutoEnabled` 总闸 +
  //   24h 签名去重 + 单日上限（默认 200，见 butler-autonomy-limits.json）+ token 预算门；
  //   任一不过 → blocked/noop 且**零副作用**（不写账本 / 不占额度）。
  //   ⚠️ **默认关**（本卡交付纪律，照 ctx-guard / card-watchdog / arrive-b 先例）：生产
  //      `butler-autonomy.json` 的 `jobs['dup-cards-merge'].enabled=false` —— 调度层显式关着；
  //      放行一把 `butler-autonomy-cli.mjs job on dup-cards-merge --why "..."`（**不改代码**）。
  //   intervalMs 30 分钟：账本级低频动作，且 24h 去重窗口本就让它一天最多处理同一对卡一次。
  //   initialMs 480_000 接在既有错峰之后（… ctx-guard 360s / card-watchdog 390s /
  //      evidence-precheck 420s / arrive-b 450s）。
  //   ⚠️ 与动作 kind 同名（`dup-cards-merge`），锁名 = `p3-auto-dup`（子脚本内 job id 仍是短名 `dup`）。
  { id: 'dup-cards-merge', label: 'P3 重复卡合并（默认关）', intervalMs: 30 * MIN, initialMs: 480_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'dup'], dir: HERE },
  // ── 2026-09-21（卡 S2c：记忆引擎 v2 运行化基础件 · 「能跑一次」→「能长期跑」）──────────────
  //   语义 = 方案 §3.1 落地三件（顺序即语义，全在 `butler-memory-vectors-tick.mjs` 里）：
  //     ① **编码桥幂等启动**：`cli/serve-start.mjs` 先 `GET /health` 探活，**在跑就跳过**；
  //        不在跑才 detached 拉起 `serve.mjs`（只绑 127.0.0.1；端口 8201 被占 +1 顺延，
  //        真实端口按子进程 pid 定位后落 `bridge-port.json` ⇒ 顺延后调用方仍查得到）。
  //     ② **每小时增量同步**：`cli/sync.mjs`（只读 `memory.db` → 写独立向量库
  //        `~/.dsh/memory-vectors/vectors.db`；批 50、失败保留进度可续跑）。
  //     ③ **每周 1 段兜底 hash 轮转**：`cli/sweep.mjs`（ISO 周判据；治方案 §3.1 的 A7
  //        「改 text 不动 updated_at」盲区，20 段一轮完整覆盖）。
  //   ⚠️ **默认关**（本卡交付纪律，照 ctx-guard / card-watchdog / arrive-b / secretary-morning 先例）：
  //      源码**不写** `enabled:false`（写死 = `hardDisabled`，`job on` 也打不开 —— 方案 §3.5 第 1 条）；
  //      默认关的唯一权威层 = 生产 `butler-autonomy.json` 的 `jobs['memory-vectors'].enabled=false`；
  //      放行 = `butler-autonomy-cli.mjs job on memory-vectors --reason "..."`（**只改开关不改代码**）。
  //   ⚠️ **库路径一律参数化、禁写死本机路径**（方案 §4 宿主迁移契约）：脚本默认走 memory-engine 的
  //      `resolveConfig`（`--memory-db/--vectors-db/--model-dir` 或 `MEMORY_ENGINE_*` / `DSH_HOME` 环境变量）。
  //   ⚠️ **宿主闸（fail-closed，2026-09-21 补件加）**：本机主机名不在**显式声明的宿主**里 ⇒ 让路 exit 3，
  //      **什么都不做**（不启动桥 / 不建向量库 / 不建任何目录，只在自己 state 里记一行）。
  //      —— 原先只按「记忆库存不存在」判宿主，而 <host> 也有生产 memory.db ⇒ 在 <host> 放行会真跑一轮全量
  //         （验收实测 626 条 / 102s）并在 <host> 建向量库；故加本闸（单测 `_test/test-memory-vectors-tick.mjs`）。
  //      **放行口径（一期）**：只允许 <host> ⇒ 给 args 加 `'--allow-host', '<<host> 的主机名>'`
  //         （或环境变量 `MEMORY_ENGINE_VECTORS_HOST`）；**不写宿主 = 谁都不放行**。
  //      ⚠️ 主机名口径 = `os.hostname()`（大小写不敏感）；<host> 的准确值须在放行前由对端 `hostname` 核实。
  //      ── 【订正注 2026-10-10 · 卡「冲刺600·补向量同步」】上面「一期只允许 <host>」的**放行口径已按本机改写** ──
  //         事实依据：tickd 只在 <host> 常驻，<host> 侧**没有 tickd**（S2c 卡遗留的待拍板项，至今未解决）⇒
  //         照"只允许 <host>"写，这个 job 就是 **100% 让路**（本卡实测 runs=45 / skips=43 / allowedHosts=[]）。
  //         本卡按缺口台账 `docs/` §6 建议 2 改为**本机放行**：
  //         `args: ['--allow-host', '<host-a>']`（下方 job 行）。依据 = 本机实测 `os.hostname()` = `<host-a>`
  //         （比较时大小写不敏感）；且生产向量库 `~\.dsh\memory-vectors\vectors.db` 的 `meta.hostId` 本来就 = `<host-a>`。
  //         **关回 = 把 args 改回 `[]`**（一字之差，与 `hot --skip-sessions` 先例同款；改完须 `--stop` + `--ensure`）。
  //   `benignExitCodes: [3]` —— 让路码（**宿主未声明 / 记忆库不存在 / 引擎入口缺失**）属环境语义，
  //      **不计 failures**（卡 AT19 口径；真失败仍走 1）。
  //   intervalMs 60 分钟（方案 §3.1「每小时」）；initialMs 510_000 接在既有错峰之后
  //      （… evidence-precheck 420s / arrive-b 450s / dup-cards-merge 480s）。
  // ── 2026-11-05（卡「记忆引擎第 4 期 · 路 B+」）：删留痕体检 ─────────────────────────
  //   语义 = 每天一次跑 `memory-db-tools\memory-change-audit.mjs --all`（**只读**：不开写事务、不改台账/库/归档）。
  //   为什么要它（方案 §12.5 / §13.2⑤）：假撤回（台账说删了、条目还在）**没有定时器** ——
  //     不挂 job 就只剩"人想起来跑"，而"体检没跑"正是这条链唯一会静默失效的态。
  //   红项口径：`--all` 的 rc=3 = 有红项（假撤回 / 关系脏边 / 老账基线漂移），**故意不设 benignExitCodes**
  //     ⇒ 红项算 failure，要能在日报的 job 段看见（这正是挂 job 的目的，别把它降格成让路）。
  //   ⚠️ **默认关（交付纪律：新自治动作默认关）**：`defaultWhenUnset:'off'` ⇒ 对端机器缺覆盖项时不跑；
  //     放行 = `butler-autonomy-cli.mjs job on memory-change-audit --reason "…"`。
  //   ⚠️ 必须重启 tickd 常驻进程才生效（JOBS 是启动期常量）：`--stop` + `--ensure`（不碰 dsh，不走 P0）。
  //   ⚠️ 锁已同批登记在 `lib\butler-locks.mjs`（否则 registry-audit 的 J3 红）。
  { id: 'memory-change-audit', label: '记忆留痕体检（只读 · 每天一次 · 默认关）',
    intervalMs: 24 * 60 * MIN, initialMs: 4_320_000,
    defaultWhenUnset: 'off',
    script: 'memory-change-audit-tick.mjs', args: [], dir: HERE },
  { id: 'memory-vectors', label: '记忆向量同步（编码桥 + 增量同步 · 默认关）', intervalMs: 60 * MIN, initialMs: 510_000,
    script: 'butler-memory-vectors-tick.mjs', args: ['--allow-host', '<host-a>,<host-b>'], dir: HERE,
    benignExitCodes: [3], benignExitLabel: '宿主未声明 / 记忆库不存在 / 引擎入口缺失 ⇒ 安全跳过（不建库、不报红）' },
  // ── 2026-10-11（卡「跨机记忆库每小时自动同步」· the operator 01:11 令）───────────────────────────
  //   语义 = 每小时一次跨机记忆库**双向收敛**（各机各跑一半，形态见 `mem-sync-tick.mjs` 头注释）：
  //     · driver（<host> `<host-a>`）：取对端**只读快照**（对端跑 VACUUM INTO）→ 合并进本机库
  //         → 产本机合并后快照**投递到对端 inbox** → 重建本机向量。
  //     · follower（<host> `<host-b>`）：读**本地** inbox 里 driver 投递的快照 → 合并进本机
  //         → 重建本机向量（**不需要网络回连 <host>**，所以 <host> 关机/外出也照跑）。
  //   ⚠️ 角色由主机名自动判定（`args` 恒 `--role auto`）⇒ **两台机可共用同一份代码**；
  //      未知主机名 ⇒ 让路 exit 3（宁可不动，不瞎跑）。
  //   ⚠️ **顺序铁律**：先合并记忆库、再重建向量（本 job 内部串行；向量经**包装层**调起，
  //      抢的是 `tick-memory-vectors.lock` —— 与既有 `memory-vectors` job 同一把 ⇒
  //      那个 job 正在跑时本轮自动跳过，**绝不两个进程同时写 vectors.db**）。
  //   ⚠️ **默认关**（照 ctx-guard / memory-vectors / relay 先例）：源码**不写** `enabled:false`
  //      （写死 = hardDisabled，`job on` 也打不开）；默认关的唯一权威层 = `butler-autonomy.json`
  //      的 `jobs['memory-sync'].enabled`；放行 = `butler-autonomy-cli.mjs job on memory-sync --why "…"`。
  //   ⚠️ **红线**：跨机搬的永远是 `VACUUM INTO` 只读快照（**禁整库同步/覆盖** —— 热库带 WAL，
  //      复制会损坏或丢写）；`--apply` 打生产库必须显式 `--allow-production`（脚本代传，
  //      `merge-memory.mjs` 自带该安全门）；合并是 `BEGIN IMMEDIATE` 短事务 + 自带 T1 运行键幂等。
  //   ⚠️ **通道**：家网 ⇒ `*-lan` 直连优先；隧道已在跑 ⇒ 直接用；都不通 ⇒ **按需短租**
  //      （`relay-cli enable`+`up`，finally 立刻 `down`；**公司有线网**禁常驻 · 家里 wifi 等其余网络可长期开）；仍不通 ⇒ 让路 exit 3
  //      （家网恢复后自动收敛；失败一律进日报，绝不静默）。
  //   `benignExitCodes: [3]` —— 让路码（对端不可达 / 角色未声明 / inbox 无快照）属环境语义，不计 failures。
  //   intervalMs 60 分钟（the operator原话「每小时同步一次」）；initialMs 690_000 接在 interval 序列末位
  //      （… tidy 600s / archive 630s / token 660s），且**刻意晚于 `memory-vectors` 的 510s**
  //      （两者都每小时 ⇒ 每轮错开 180s；若将来改时刻，保持这个 ≥120s 的间距）。
  //   【A57 · 2026-10-27 订正注】上面两处「60 分钟 / 每小时」已过时（原句保留备查）：**A53 起 `intervalMs` = 15 分钟**
  //      （`15 * MIN`；压档理由 = 跨机收敛更快，判据 12 由the operator 2026-10-26 22:21 拍板「两个都试」）。
  //      错峰关系不变：`initialMs` 仍 690s，比 `memory-vectors` 的 510s 晚 180s（≥120s 的间距照旧成立）。
  //   【A57】`args` 追加 `--keep 96`：`mem-sync-tick.mjs` 的 `keep` 按**份数**保留，压档后
  //      `24 × 15min = 6h` 会把灾后恢复窗口缩 4 倍 ⇒ `96 × 15min = 24h` 保住原有窗口。
  //      代价：对端 inbox 常驻 ≈ 737 MB（压档前 ≈184 MB）、传输 ≈ 737 MB/日（<host> 的 D: 现可用约 192 GB）。
  { id: 'memory-sync', label: '跨机记忆同步（双向收敛 · 每 15 分钟 · 默认关）', intervalMs: 15 * MIN, initialMs: 690_000,
    script: 'mem-sync-tick.mjs', args: ['--role', 'auto', '--apply', '--keep', '96'], dir: HERE,
    benignExitCodes: [3], benignExitLabel: '对端不可达 / 角色未声明 / inbox 无快照 ⇒ 安全跳过（家网恢复自动收敛）' },
  // ── 2026-10-30（卡「记忆两岸互通 S2」· 方案 `docs/` §9）──────────
  //   语义 = 每 30 分钟把**岸**（<host> 上的生活实例，独立 `DSH_HOME=<life-home>\.dsh`）**新增**的记忆
  //     增量导入本机（this host）记忆库。S1 已完成一次性全量导入（154 条 → id `1500000..1500153` · 标签成对
  //     `src:life,srcid:<源id>` · 判据器 `memory-bridge-probe.mjs` rc=0）；本 job 是它的**续章** ——
  //     她那边的日常写入不会自己长腿跑进来，必须有这一轮轮询。
  //   ⚠️ **只读对端、只写本机**（脚本硬约束，一条不许放宽）：对端唯一读取姿势 = 在对端 node 上跑
  //     `VACUUM INTO` 到对端 `%TEMP%` 下一次一性目录 → scp 回本机 → **finally 删对端临时目录**；
  //     绝不裸 copy 热库（她随时在写）。本脚本没有一行 DELETE，删行属乙档（本卡不做）。
  //   ⚠️ **幂等两把键**：去重 = 内容 sha256（只对成对标签的导入行比对）+ `srcid:<源id>` 兜底；
  //     运行键 = `~\.dsh\butler-memory-life-import.json`（`rounds` 尾部 20 轮）。
  //   ⚠️ **台账落点 = 运行键，不写第二份**（方案 §5.2-7「固定、不无限堆积」）：job **刻意不带**
  //     `--ledger-dir` —— S1 那份 `docs/` 是一次性证据，
  //     再往里写就变成会无限长的第二个状态源。
  //   ⚠️ **退出码语义（三种，别混）**：`0` 正常（有导入 / 无需导入都算）· `3` 对端不可达/无通道
  //     ⇒ **benign**（<host> 自己那条 `memory-sync` 现就是 `deferred / rc 3`）· `4/5/6` 真失败
  //     （取数读不动 / 回读不符 / 写不进去）⇒ 记 failed。所以 `benignExitCodes` **只声明 3**。
  //   ⚠️ **一行可观测**：`node <butler-root>\tools\memory-import-life.mjs --status` —— 读 tickd state 的
  //     `lastStatus` + 运行键最近一轮 `inserted/skipped/rc` + 库里 `src:life` 行数，**零写入零新文件**。
  //   ⚠️ **与 `memory-sync` / `memory-vectors` 的锁关系 = 不共用锁，也不需要**：三者写的是同一份
  //     `~\.dsh\memory\memory.db`，但既有口径从来不是"锁层面互斥"，而是 SQLite 自己串行
  //     （本脚本 `pragma busy_timeout=20000` + 25 条一批 `BEGIN IMMEDIATE`；`memory-sync` 同款短事务）
  //     ⇒ 真撞上只是短暂等锁，不会写坏。而且 `memory-vectors` 对记忆库**只读**、`memory-sync` 的
  //     跨机收敛对象是工作线那台（不含 `<life-home>` 这个独立 home）⇒ 语义上也不冲突。
  //     登记自己那把锁（`memory-sync-life`）只为防"手工直跑 + tickd 到点"并发踩同一份运行键。
  //   ⚠️ **默认关（不写死）**：源码**不写** `enabled:false`（写死 = hardDisabled，`job on` 都打不开）；
  //     声明 `defaultWhenUnset:'off'` ⇒ 任何机器缺覆盖项时一律按关（对端 `butler-autonomy.json`
  //     不跨机同步，这一条保证她那边不会自己跑）。放行 = `butler-autonomy-cli.mjs job on
  //     memory-sync-life --reason "…"`（只改开关不改代码）。
  //   ⚠️ **initialMs = 1_180_000（1_180 s）—— 卡面写的 1_080_000 实算不合法，已按本仓错峰硬约束改值**：
  //     判据 = `(init_new − init_other) mod gcd(P_new, P_other) ≠ 0`（静态算全表 44 条周期型 job，
  //     器具 `<butler-root>\docs/`）。实算：`1_080_000` 与 **`ctx-guard`
  //     （P=120s, init=360s）同余** ⇒ 每 2 小时撞一秒；且与既有末位 `notify-docsync`(1_050_000) 只差
  //     **30 s**（< 40 s 间距纪律）。`1_180_000` 实算 **零同余**、与同周期(30 min)最近者
  //     `notify-docsync` 距 130 s（> 120 s 纪律）、与末位差 130 s（≥ 40 s）。
  //   ⚠️ **必须先 `--stop` + 等守护鱼 `--ensure` 才生效**（JOBS 是模块级 const；`--status`/`--list`
  //     只是新进程读当前代码）。回滚 = `docs/ [--apply]`。
  { id: 'memory-sync-life', label: '岸记忆增量导入（<host> 生活实例 · 每 30 分钟 · 默认关）',
    intervalMs: 30 * MIN, initialMs: 1_180_000,
    script: path.join(DSH, 'tools', 'memory-import-life.mjs'),
    args: ['--apply', '--json'],
    dir: path.join(DSH, 'tools'), budgetMs: 180_000,
    defaultWhenUnset: 'off',
    benignExitCodes: [3], benignExitLabel: '对端（<host> 生活实例）不可达/无通道 ⇒ 本轮让路（她那边开机/进网后自动收敛）' },

  // ── 2026-11-06（卡「<mainline> · family 向量同步 job」· 方案 `docs/`）──
  //   家人库（`~\.dsh\family-memory\memory-family-<key>.db`）的**向量增量补齐**：读台账 → 逐库串行调现成执行体
  //   （`family-vectors-tick.mjs` 是薄包装，零改既有执行体 / 零改 dsh-memory 插件 / 零碰the operator库）。
  //   ⚠️ **默认关（不写死）**：`defaultWhenUnset:'off'` —— 源码**绝不写** `enabled:false`（写死 = hardDisabled，
  //      连 `job on` 都打不开）。放行 = `butler-autonomy-cli.mjs job on family-vectors --reason "…"`。
  //   ⚠️ **args 两行，拍完留一行**（卡面 §1.5-17 S5：别让待拍板项与落地清单打架）：
  //      路线 (乙)（推荐）· <host> tickd + ssh 代跑对端**现成 0.1.1** ⇒ 对端一个文件都不改；路线 (甲) 留注释。
  //   ⚠️ **错峰 initialMs = 1_310_000**（方案 §4.1 实算）：最近邻 `memory-sync-life` @1_180_000 距 **130 s**
  //      （> 120 s 纪律）；同周期 60 min 的最近者 `text-sync-direct` @1_000_000 距 **310 s**；与全表间隔型
  //      job **无同余冲突**（`(1_310_000 − init_o) mod gcd(3_600_000, P_o) ≠ 0` 全成立）。
  //   ⚠️ **`benignExitCodes:[3]`**：3 = 让路（锁被占 / 对端两个别名都不通）；**1 = 真失败**（有 failed / 台账坏 /
  //      preflight 不符），别往 benign 里塞 —— 那正是这个 job 唯一要治的病（rc 0 出口让"向量永远不补"静默）。
  //   ⚠️ **必须重启 tickd 才生效**（JOBS 是模块级常量）；`--list` 里有它 **≠** 已经在跑。
  //   回滚：删本条 + 重启 tickd（`docs/` 默认 dry-run、sha 不符拒动）。
  { id: 'family-vectors', label: '家人记忆向量同步（逐库增量 · 默认关）',
    intervalMs: 60 * MIN, initialMs: 1_310_000,
    script: 'family-vectors-tick.mjs', dir: HERE,
    // —— 路线 (乙)（已落 · 在用）：<host> tickd + ssh 代跑对端现成 0.1.1（对端零改动）
    args: ['--apply', '--exec', 'ssh', '--remote', '<peer-lan>', '--remote-fallback', '<peer>',
      '--allow-host', '<host-b>'],
    // —— 路线 (甲)（备选 · 落地时另抄一份调度项到对端 tickd）：
    // args: ['--apply', '--exec', 'local', '--allow-host', '<host-b>'],
    budgetMs: 2_700_000, defaultWhenUnset: 'off',
    benignExitCodes: [3], benignExitLabel: '锁被占 / 对端不可达 ⇒ 本轮让路（不计失败）' },

  // ── 2026-10-26（卡「<mainline> · A14」· 方案 `docs/` §5-3 S3）──
  //   <host> → <host> **单向叶子推送**（<host> 只收：不回流、不三角收敛、<host> 不掺进来）—— 每 15 分钟把本机快照投到 <host> inbox。
  //   脚本 = `mem-push-leaf.mjs`（卡 A13 新增）：只 import `resolvePaths`/`deliverSelfSnapshot`/`pruneInbox`，
  //   **不 import `runOnce`** —— driver 的 runOnce 第①步就是 pull，用它就不再是单向。
  //   ⚠️ **默认关（缺键即关 · fail-safe）**：`defaultWhenUnset: 'off'` ⇒ 任何机器（含对端：`butler-autonomy.json`
  //      不跨机同步）缺 `jobs['memory-sync-leaf']` 覆盖项时一律按**关**处理。源码**绝不写** `enabled: false`
  //      （写死 = `hardDisabled`，连 `job on` 都打不开）。放行 = `butler-autonomy-cli.mjs job on memory-sync-leaf --why "…"`
  //      —— **A14 卡一次都没跑**，放行动作留给 S4。
  //   ⚠️ **`--tmp-dir` 必须带**：叶子 `--apply` 写的是 `<tmpDir>\self-memory.db` 且**先 `unlinkSync` 再写**；
  //      不吃 `--tmp-dir` 就落回 `%TEMP%\dsh-mem-sync`（与小时级 driver **同一个文件**）⇒ 15 分钟一轮必然与
  //      60 分钟一轮对撞（一个刚 unlink、另一个正在读）。叶子自己也已把缺省改成 `dsh-mem-sync-leaf`（A14 ②），
  //      这里**再显式带一次** = 双保险（job args 自解释，不依赖缺省不被改动）。
  //      值**不写死绝对路径**（三台用户名/TEMP 各异）：按本机 `TEMP` 现算成 `path.join(TEMP, 'dsh-mem-sync-leaf')`
  //      —— `TEMP` 常量在 L103 已定义（`process.env.TEMP || os.tmpdir()`），与 `resolvePaths` 用的同一口径。
  //   ⚠️ `benignExitCodes: [3]`：对端不可达（<host> 未进网 / tickd 未起 / 别名不通）= 环境语义、本轮让路、不记失败
  //      （<host> 进网后自动收敛）。脚本另有 exit 1（快照/scp 失败）/ 2（用法错）—— 那两个要算红，别往 benign 里塞。
  //   ⚠️ **必须重启 tickd 才生效**（JOBS 是模块级常量；`--status`/`--list` 是新进程读当前代码）。
  //      A14 卡**刻意不重启**：本条只"上表"，真正生效窗口留给 S4 —— 看到 `--status` 里有它**不等于**它已经在跑。
  //   回滚（一行）：删掉本条 + 重启 tickd（`--stop` 后由守护鱼 30s 内 `--ensure`，或显式 `--ensure`）。
  { id: 'memory-sync-leaf', label: '<host>→<host> 叶子推送（单向 · 15 分钟 · 默认关）', intervalMs: 15 * MIN, initialMs: 900_000,
    script: 'mem-push-leaf.mjs',
    args: ['--peer-lan', '<peer-lan>', '--peer-tunnel', '<peer>', '--apply', '--tmp-dir', path.join(TEMP, 'dsh-mem-sync-leaf')],
    dir: HERE, defaultWhenUnset: 'off',
    benignExitCodes: [3], benignExitLabel: '对端不可达 ⇒ 安全跳过（<host> 进网后自动收敛）' },
  // ── 2026-10-22（卡「素材库中心化」· 方案 §3.5「每小时一轮 + 开机后一轮」）────────────────
  //   素材**两件套**（`~\.dsh\memory\feed.db` 索引 + `<butler-root>\secretary` 文件）双向增量同步：
  //   <host> = 中心持全量、<host>/<host> = 边缘（只增不删 · 按内容 sha 去重 · 目标已存在**绝不覆盖**）。
  //   ① 频率 = **每小时一轮**（`intervalMs: 60min`）+ `initialMs` 小值 ⇒ tickd/开机起来后**先补一轮**
  //      （即方案里的「开机后一轮」；tickd 由 `DSH-Autostart` 在开机拉起 ⇒ 开机即触发）。
  //   ② 通道由脚本自己择路（`<peer>-lan` → `<peer>` 隧道 → 都不通则**按需短租**、用完归还；
  //      公司有线网下 net-arbiter 每 15 分钟会停隧道 ⇒ 每轮按需重开，见 tools\lib\peer-channel.mjs）。
  //      【A28 订正 · 2026-10-26 · 只加不改上文】上面「net-arbiter 每 15 分钟会停隧道 ⇒ 每轮按需重开」
  //      **已作废**：net-arbiter 改「判到就保持」（公司有线/家里 ⇒ 目标 up，只有 other 档连续 2 轮才收缩）
  //      ⇒ 隧道由它保活，本 job 的短租通常变**借道**（`enabledBefore=true` ⇒ `downOnRelease=false`
  //      ⇒ 只销租约、不 down）。真源 `docs/` §3-1 A2。
  //   ③ 对端不可达 ⇒ **rc 3 让路**、上一轮还在跑（锁占）⇒ rc 6，两者都记 benign（不涨 failures）。
  //   ④ 真源 `docs/`；回滚点 `_archive\secretary-sync-20261022\`
  //      （`manifest.json` 记本次新增的每个文件/每行 id，`rollback.mjs` 默认 dry-run、只删登记项）。
  //   ⑤ 一键关回 = `node <butler-root>\tools\dsh-butler\butler-autonomy-cli.mjs job off secretary-sync --reason "…"`。
  { id: 'secretary-sync', label: '素材库中心化同步（每小时 + 开机一轮）', intervalMs: 60 * MIN, initialMs: 120_000,
    script: path.join(DSH, 'tools', 'secretary-sync.mjs'),
    args: ['--peer', '<peer>', '--apply', '--json'],
    dir: path.join(DSH, 'tools'),
    // ⚠️ `budgetMs: 120_000`（2026-10-22 首跑实测后补，照 plug-guard / snapshot 先例）：默认预算是 10_000ms
    //   （`heavy/class-default`），而一轮要么在**按需短租**上（enable+up+复探 ≈ 6–20 s）、要么在**首次补齐**上
    //   （实测 89 s / 6.2 MB 双向），10 s 会被判 `超 1.076×` 并**每 30 分钟写一条告警**污染 butler-alert。
    //   `budgetMs` 只是耗时预算（无 kill 超时）；无差异的常轮约 10–25 s。
    budgetMs: 120_000,
    benignExitCodes: [3, 6], benignExitLabel: '对端不可达 / 上一轮仍在跑 ⇒ 本轮让路' },
  // ── 2026-09-21（卡 S3c：记忆引擎 v2 · S3c 夜间提炼）────────────────────────────
  //   语义 = 每天 04:10 把窗口（默认 24h）内新增/变更的记忆按**语义向量**聚成组，交给便宜档模型
  //     （`deepseek-flash` · the operator链，2026-09-21 the operator拍板）提炼成**长期结论**，写成带 `distilled` 标记的新记忆（可批量回滚）。
  //   形态 = `butler-auto-tick.mjs --job distill`（方案 §3.5 第 3 条 · P1 已拍）：
  //     · 只有这个形态才存在**真正的 job 级模块门**（tickd 的模块门只认 `tickd-jobs` 一个 id）
  //     · 复用既有 tick 调度的锁 / 失败隔离 / 日报三条通道；子脚本内的调度器锁名 = `p3-auto-distill`
  //       （tickd 抢 `tick-memory-distill.lock` 后注入 `DSH_BUTLER_TICK_LOCK_HELD`，父子不双层加锁）
  //   ⚠️ **成本闸自带**（本生态第一个"无人值守调 LLM 的 tickd job"）：模型 `deepseek-flash`（the operator链，
  //      2026-09-21 the operator拍板；不许改回第三方）· 调用 ≤20 次/日 · token ≤150K/日 · **超限即停 + 日报一行** · **不重试**；
  //      记账落 `~/.dsh/butler-distill-state.json`。既有 `tokenBudgetPerDay` 门只挂 `runAction()` 路径，
  //      直接 spawn 脚本的 job 天然绕开 ⇒ 必须自带（方案 §3.5 成本闸小节）。
  //   ⚠️ **两层默认关可核对**（D4 订正写法，与本文件其它 job 同款）：
  //      ① 源码**不写** `enabled:false`（写死＝硬禁用，`job on` 也打不开，与"先手动跑 2 周"互斥）；
  //      ② 默认关的**唯一权威层** = `butler-autonomy.json` 的 `jobs['memory-distill'].enabled=false`。
  //      放行 = `node tools\dsh-butler\butler-autonomy-cli.mjs job on memory-distill --why "..."`（不改代码）。
  //   ⚠️ **时点 04:10**：03:30 原被 `rollback-offsite` 占用（该 job 2026-09-20 已挪到工作日 08:45）；
  //      04:20 是 `memory-snapshot`（VACUUM INTO + <sync-repo> 推送）⇒ 两者相邻，实测本 job 一轮含 LLM 等待
  //      可能数分钟；若将来互相拖慢，按方案 N7 提前到 03:50（改本行一个字符串即可）。
  //   initialMs 0 + `at` 日历型：由 tickd 按"当天 04:10 已过则补跑"的既有日历判据驱动。
  { id: 'memory-distill', label: '记忆提炼（夜间 · 默认关）', at: '04:10', initialMs: 0,
    script: 'butler-auto-tick.mjs', args: ['--job', 'distill'], dir: HERE },
  // ── 2026-10-10（卡「冲刺600·补坑库联动BCD」· C 点：坑聚类升级 · 方案 §5）─────────────────────
  //   语义 = 把「按 sigKey 精确匹配 ⇒ 同源坑在候选池里分裂」升级为**向量二级聚类**（贪心聚合，
  //     cos ≥ eps），产出 `~/.dsh/butler-p4-clusters.json`，供候选列表**折叠展示 / 建议批量处理**。
  //   ⚠️ **只收敛展示**：聚类结果**不得**改任何坑的 count/excluded/候选 status（方案 §C.6 第一行）。
  //   ⚠️ **默认关**（本卡交付纪律，照 memory-vectors / nurse-retention / relay 先例）：
  //      源码**不写** `enabled:false`（写死 = hardDisabled，`job on` 也打不开）；
  //      默认关的唯一权威层 = `butler-autonomy.json` 的 `jobs['pitfall-cluster'].enabled=false`。
  //      放行 = `node tools\dsh-butler\butler-autonomy-cli.mjs job on pitfall-cluster --why "..."`（不改代码）。
  //   ⚠️ **前置依赖**：`source='pitfall'` 的向量库（A 点 + `memory-vectors` job 建库）；
  //      无库 ⇒ 脚本**优雅降级**为恒等聚类（= 现状）+ 日志一行，**不报错**（方案 §C.6 第二行）。
  //   ⚠️ **互斥**：脚本内 `acquireTickLock('tick-pitfall-cluster')` —— **与 registry lockName 同名**
  //      （否则 tickd 持锁 + 子进程再抢 ⇒ 永远判定 locked；本生态踩过该坑）。
  //   ⚠️ **时点 04:50**：接在 memory-distill(04:10) / memory-snapshot(04:20) / nurse-retention(04:40) 之后，
  //      避开早间巡检链（09:00+）；TTL 10 分钟（O(n²) 点积毫秒级，余量充足）。
  { id: 'pitfall-cluster', label: 'P4 坑聚类（向量二级聚类 · 默认关）', at: '04:50', initialMs: 0,
    script: 'pitfall-cluster-tick.mjs', args: ['--eps', '0.8'], dir: HERE,
    // 【订正 · 2026-10-10 · 卡「N16 放 C 点」】两处**一行**订正（真源 = docs/）：
    //   ① `args` 补 `--eps 0.8`：本卡标定结论 `eps* = 0.80`（0.85 ⇒ 30 条 todo 收敛 14 族 ❌ 判据 1；
    //      0.80 ⇒ 12 族 ✅），而脚本内默认 `eps = 0.85` ⇒ **不传参就等于按未标定的那一档跑**。
    //      CLI / 库的默认值**一个字没动**（只钉死本 job 的调度参数）。
    //   ② 加 `defaultWhenUnset: 'off'`：本行上面的注释（与交付报告 §1、主档 `gap-2-28`）都写
    //      「配置缺 `jobs['pitfall-cluster']` ⇒ 默认关（fail-safe）」，但**当初漏了这条声明** ⇒
    //      按 H4b 语义「未声明 ⇒ 走全局默认（**开**）」。实测 2026-10-10 10:4x（放行前）：
    //      `job list` = `🟢 开 来源=default` —— 配置里确无该键 ⇒ **声明后「缺键即关」才真成立**；
    //      放行/关回仍是 `job on|off pitfall-cluster`（有覆盖项就走 file 分支，声明不锁死开关）。
    defaultWhenUnset: 'off' },
  // 小护士 case 保留期清理（方案 §5.1 retention 行 · the operator 2026-09-21 D3 拍板「**retention 挂 tickd**」）：
  //   ⚠️ **为什么挂 tickd 没有自举问题**（B4 修订块的设计依据）：静默窗 `--disable` 停的是
  //      `TICK_TASKS` + **tickd 进程本身**，而"修复窗口内本就不该清 case、平时 tickd 在跑"
  //      ⇒ 与「残留收敛」那一半（②守护鱼 / ③开机链）不同，retention 不会撞上"挂了个不跑的 job"。
  //   ⚠️ **删文件不可逆** ⇒ 脚本（`tools\dsh-nurse\retention.mjs`）定死三条：
  //      ① **默认 dry-run**（只报告不删）；② 真删 = 配置放行 `~/.dsh/butler-nurse-retention.json` 的
  //      `apply:true`（**改开关不改代码**；CLI `--apply` 打默认安全根还要 `--allow-production`，fail-closed）；
  //      ③ 留痕 = `butler-audit` 一条 + `logs\nurse-retention-<日期>.md` 一节。
  //   ⚠️ **失败容忍**（`lib\tickd-health.mjs`：failures≥2 且 lastStatus!=ok ⇒ 🟡/🔴）⇒ 脚本内单条失败/无过期项
  //      一律 exit 0，只有"安全根不可读"才 exit 3。
  //   ⚠️ **两点必须落进实现**（B4 原话）：dry-run + 留痕 + 审计；job 幂等。已落（见该脚本头注释）。
  //   ⚠️ **默认关的权威层**（与本文件其它 job 同款）：源码**不写** `enabled:false`；
  //      默认关 = `butler-autonomy.json` 的 `jobs['nurse-retention'].enabled=false`；
  //      放行 = `node tools\dsh-butler\butler-autonomy-cli.mjs job on nurse-retention --why "..."`（不改代码）。
  //   ⚠️ **时点 04:40**：04:10 memory-distill / 04:20 memory-snapshot 之后，错开半小时，避开早间巡检链。
  { id: 'nurse-retention', label: '小护士 case 保留期清理（默认 dry-run · 默认关）', at: '04:40', initialMs: 0,
    script: path.join(DSH, 'tools', 'dsh-nurse', 'retention.mjs'), args: [], dir: path.join(DSH, 'tools', 'dsh-nurse') },
  // ── 2026-09-22（卡 S0 · 自动交接与会话接力 · 方案 §12 第 0 步 3 + 阶段 2 ③ · D9）─────────────
  //   语义 = **无人值守时替卡执行会话接力**（阶段 2）：采集事实 → 交 LLM 产七段草稿 → 走**主路径同一条**
  //     接力链（同闸门、同锁、同审计）。与阶段 1 的唯一区别 = "谁来写档"。
  //   ⚠️ **job id 全篇唯一 = `relay`**（K-15 收口）：方案正文 §12 ③ 曾写成 `session-relay`，而闸门 11 /
  //      §9 / §5.1 写 `relay` —— 同一个 job 两种 id 会让"一键停"落到不存在的 id（回滚手段失效）。
  //      ⇒ 全篇统一 `relay`；验收判据 = `job off relay` 后 `--status` 里该 job 显示关闭。
  //   ⚠️ **默认关**（本卡交付纪律，照 ctx-guard / card-watchdog / arrive-b / secretary-morning /
  //      memory-vectors 先例）：源码**不写** `enabled:false`（写死 = `hardDisabled`，`job on` 也打不开）；
  //      默认关的唯一权威层 = 生产 `butler-autonomy.json` 的 `jobs['relay'].enabled=false`；
  //      放行 = `butler-autonomy-cli.mjs job on relay --reason "..."`（**只改开关不改代码**）。
  //      **首次放行属乙档**（方案 §4.1 · D-1 已拍）：阶段 2 会真开新会话（花钱）+ 调 deepseek ⇒ 必须先问the operator。
  //   ⚠️ **入口待阶段 2 落地时核对**（如实登记）：方案 §5.1 只登记了 `tools/session-relay.mjs`（CLI），
  //      §12 阶段 2 ① 的"事实采集器"**未写死独立文件名** ⇒ 本行先按 CLI 同址登记；阶段 2 卡若另立执行体，
  //      **必须同步改本行 + `lib\butler-locks.mjs` 的 LOCK_REGISTRY 的 `script` 字段**（两处一致）。
  //   ⚠️ initialMs 540_000 与既有接线 job 错峰（审6 P-1 更正）：原写 420 s 是"错峰序列下一位"，但
  //      **420 s 已被 `evidence-precheck` 占用**（它 10 min 一跑，与 relay 的 5 min 每 10 分钟同拍，
  //      恰好抵消 initialMs 存在的唯一目的）⇒ 新依据 = 当前序列**末位** `memory-vectors` 510 s ⇒ relay 取 540 s
  //      （序列：360 ctx-guard / 390 card-watchdog / 420 evidence-precheck / 450 arrive-b / 480 dup-cards-merge
  //      / 480 session-mirror / 510 memory-vectors ⇒ 540）。**维护口径**：今后新接 tick job 必须重排
  //      initialMs 并回读本表全表（不许按某份"段"判某槽位空着）＋按本表既有纪律在此处登记。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（只重启 dsh 无效）；生效判据见方案 §9 R1（`--status` 出现 relay + 首触验证）。
  //   ⚠️ **该 job 锁（`tick-relay.lock`）与方案闸门 5 的"源会话锁"（`~/.dsh/butler-relay.<sid>.inflight`）
  //      是两把不同的锁**：各管一段（job 级互斥 / 单条接力链互斥），**不许合并**。
  { id: 'relay', label: '会话接力（无人值守自动交接 · 默认关）', intervalMs: 5 * MIN, initialMs: 540_000,
    script: path.join(DSH, 'tools', 'session-relay.mjs'), args: [], dir: path.join(DSH, 'tools') },
  // ── 2026-09-28（卡 K5d：看板周期归档接线 + 放行）──────────────────────────────────
  //   语义：把"已实现 · 已登记 · 未接线"的 P2 自动动作 `board-line-archive` 接进 tick 链 ——
  //     每轮 spawn `butler-auto-tick.mjs --job board-line-archive` → 动作体模块门
  //     （`checkModuleAllowed('board-line-archive')`）+ `runAction()` 统一闸门
  //     （L0 降档 / p3-auto 总闸 / 24h 去重 / 单日上限 / token 预算）。
  //   ⚠️ 接线目的同四动作先例（见本文件 L305-316 的注释）：放行当天不是"第一次真跑"，
  //      而是"已空转多轮" —— 每轮无候选即 noop，有候选才走 runAction。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是代码常量；`--status` 是新进程读当前代码，
  //      不代表运行中实例已加载）。**只重启 tickd，不重启 dsh**。
  //   ⚠️ 默认关的权威层 = 生产 `butler-autonomy.json` 的 `jobs['board-line-archive'].enabled`
  //      （源码不写 `enabled:false` —— 写死 = 硬禁用，`job on` 也打不开）；模块层 = L2 模块门
  //      `modules['board-line-archive']`（**2026-09-28 K5d 已放行**：`module on board-line-archive`）。
  //   intervalMs 30 分钟（账本级低频动作；与 `AUTO_JOBS['board-line-archive'].intervalMs` 同值）。
  //   initialMs 570_000 接在既有错峰序列末位之后（… evidence-precheck 420 / arrive-b 450 /
  //      dup-cards-merge 480 / memory-vectors 510 / relay 540 ⇒ 570）。
  //   锁名 = `p3-auto-board-line-archive`（登记在 `lib\butler-locks.mjs`，与子脚本内调度器锁名一致）。
  { id: 'board-line-archive', label: 'P3 看板周期归档（默认关）', intervalMs: 30 * MIN, initialMs: 570_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'board-line-archive'], dir: HERE },
  // ── 整夜班底 丙-1 / 丙-2（2026-09-27 · 卡「整夜班底丙1丙2」；来源 `docs/` §丙组）
  //   丙-1「整夜保护每日自检」：**只读**比对「加固目标（7 项电源全 0 + 屏保 0/0/0 + 更新时段窗 21→15）」
  //     vs 实测，并把「被改回原值」与「被改成别值」分开报。出处 = 2026-09-25 实测掉过一次保护
  //     （加固值被人改回），当晚无人知晓 —— 保护掉了机器可能整夜睡死，属致命面。
  //   丙-2「停手审计」：每天扫整夜窗口内「干两下就停、且没交棒」的会话，**只出清单、不改任何东西**
  //     （不补跑 / 不开会话 / 不发通知；判据与降噪门见脚本头注释）。
  //   ⚠️ **默认关（交付≠放行）**：两条都声明 `defaultWhenUnset:'off'` ⇒ **任何**机器（含对端，`butler-autonomy.json`
  //     不跨机同步）缺覆盖项时一律不跑；放行 = `node tools\dsh-butler\butler-autonomy-cli.mjs job on overnight-guard
  //     --reason "…"`（**只改开关不改代码**）；关回 = `job off <id>`。理由：新增自动调度面按纪律先交付、后放行。
  //   ⚠️ **时点 15:10 / 15:20**：整夜加固窗 = 21:00 → 15:00（overnight-mode 的 WU 活动时间窗）⇒ 窗口一关就核查
  //     「这一夜保护在不在」「这一夜有没有人干两下就停」；与早间巡检链（09:00~09:40）完全错开。
  //   ⚠️ **只读承诺**：overnight-guard 不写任何文件（结论走 stdout / 日报段）；
  //     night-stop-audit 只落一份 `docs/` 只读档（`--write`）。
  //   ⚠️ **退出码**：两条都**不**因"发现变化 / 列到清单"而非 0（那是巡检的正常结论，非 0 会被 tickd 记 failures
  //     并让日报 tick 段天天刷红 —— 同 `upgrade-patrol --no-fail-on-red` 的理由）；只有「读不到 ⇒ 判定不可用」
  //     才 exit 3（真异常，该红）。
  //   ⚠️ 两条都是**日历型**（`at`），不占 `initialMs` 槽位（那个序列只对间隔型 job 有意义；见上面 relay 行的纪律）。
  //   ⚠️ 锁登记必须同步加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（否则「tickd 全部 job 都有锁登记」不变量单测会红）。
  { id: 'overnight-guard', label: '插电保护每日自检（只读 · 默认关）', at: '15:10', initialMs: 0,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'overnight-guard-check.mjs'), args: [], dir: path.join(DSH, 'tools') },
  { id: 'night-stop-audit', label: '停手审计（只读清单 · 默认关）', at: '15:20', initialMs: 0,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'night-stop-audit.mjs'), args: ['--write'], dir: path.join(DSH, 'tools') },
  // ── 2026-10-14（the operator令「都做吧」· 防复发三件套 ②）：`rule-drift` 老话巡检接 tickd ─────────────
  //   治什么病：the operator老把the operator的新口径"抄一张便利贴贴到冰箱上"（在 persona 里存副本），抄久了冰箱上那张是
  //     三个月前的、抽屉里的（驾照细则 §11）早改了 ⇒ 新会话照冰箱干、显得死板（不敢建卡、动不动等the operator点头）；
  //     而"冰箱"没人查，只有the operator撞见了喊一嗓子 —— **the operator被当成了检查员**。
  //   本 job = 每天自动对一次表：扫**所有 preset 的 persona 正文 + 全部技能**，命中"教会话先问the operator"的
  //     保守句式族就报（判据 / 黑名单 / 豁免见 `tools\rule-drift-check.mjs` 头注释）。
  //   首跑实测价值（2026-10-14）：当场抓出 `card-no-ask` 副本落后真源 6 处口径未同步 —— 靠人记 = 必漏。
  //   ⚠️ **默认关（交付纪律，同 overnight-guard / night-stop-audit / tidy 先例）**：`defaultWhenUnset:'off'`；
  //     放行/关回 = `node tools\dsh-butler\butler-autonomy-cli.mjs job on|off rule-drift --reason "…"`（只改开关不改代码）。
  //   ⚠️ **只读**：不写任何文件（`--json` 时日志落 %TEMP%，正常模式只走 stdout）；退出码**不**因"有命中"而非 0
  //     （那是巡检的正常结论；同 overnight-guard 的原因 = 非 0 会被记 failures 并让日报 tick 段天天刷红）。
  //   ⚠️ 日历型（`at`），不占 initialMs 槽位；锁登记必须同步加在 `lib\butler-locks.mjs`（否则不变量单测红）；
  //     改本行后**只重启 tickd**（`butler-tickd.mjs --ensure`），不重启 dsh。
  { id: 'rule-drift', label: '老话巡检（只读 · 默认关）', at: '15:30', initialMs: 0,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'rule-drift-check.mjs'), args: [], dir: path.join(DSH, 'tools') },
  // ── 2026-10-22（卡「V3 功能面 · 记忆架构四件」H-5）：后台 **dream 整理** 接 tickd ─────────────
  //   语义（R-072 记忆六条标配之「后台整理 distill + dream phase」）：空闲时**回头翻全库**，
  //     出三样建议 —— ① 重复/同题**合并建议**（倒排 + 6-gram Jaccard，与离线器具同口径）
  //     ② **陈旧标记建议**（过期关键词组 / 超龄未动 / 被点名订正）③ **三层分布**（core/recall/archival）。
  //   ⚠️ **只读 + 写回需人审**（本卡红线）：`dream-tick.mjs` 只用 `DatabaseSync({readOnly:true})`，
  //     唯一写入 = `docs/`；**合并/标陈旧一条都不自动落地**。
  //     〔订正注 2026-10-22 · 卡「V3 功能面 · dream 判据修正」〕上面这句已不全：现另写一处灰区清单
  //     `docs/`（只 head 截 200 字、`--no-gray` 可关），供后续 LLM 判卡消费；
  //     库仍是 readOnly、写库恒 0。真源 = `docs/`。
  //   ⚠️ **默认关**（交付纪律，同 rule-drift / overnight-guard / memory-distill 先例）：源码**不写** `enabled:false`；
  //     默认关的唯一权威层 = `butler-autonomy.json` 的 `jobs['memory-dream'].enabled`；
  //     放行 = `node tools\dsh-butler\butler-autonomy-cli.mjs job on memory-dream --reason "…"`（只改开关不改代码）。
  //   ⚠️ **时点 04:35**：接在 memory-distill(04:10) / memory-snapshot(04:20) 之后、nurse-retention(04:40) 之前，
  //     与 pitfall-cluster(04:50) 错开 15 分钟 —— dream 要全库扫（1,800 条量级实测 <1 s，余量充足）。
  //   ⚠️ **失败不刷红**：只有"库打不开"才 rc=3；单条记忆异常一律跳过并计数。
  //   ⚠️ 日历型（`at`），不占 initialMs 槽位；锁登记已同步加在 `lib\butler-locks.mjs`（`tick-memory-dream`）；
  //     改本行后**必须 `--stop` + `--ensure` 重启 tickd**（JOBS 是启动期常量），不重启 dsh。
  { id: 'memory-dream', label: '记忆 dream 整理（只读 · 写回需人审 · 默认关）', at: '04:35', initialMs: 0,
    defaultWhenUnset: 'off',
    script: 'dream-tick.mjs', args: [], dir: HERE },
  // ── 2026-09-29（卡「P8 tidy 接调度」）：P8 只读审计采集器 `tidy` 接进 tickd 调度表 ────────────
  //   为什么接：`butler-tidy-tick.mjs`（卡 [10] 交付 · P8 方案 §7.1 要求「计划任务短命脚本，每 6h」）
  //     **有实现、无调度点** —— 本机 360 企业 EDR 已把整套计划任务清废（`DSH-Butler-*` 全无），
  //     而本 JOBS 表里从无 tidy 行 ⇒ 采集器**永远不会自动跑**（交接档 §6 记的 N6 缺口）。
  //     本行只补「接线」；**放行是另一件事**（`job on tidy`，首次放行属乙档）。
  //   ⚠️ **默认关（交付纪律，同 overnight-guard / night-stop-audit 先例）**：声明
  //     `defaultWhenUnset:'off'` ⇒ **任何**机器（含对端：`butler-autonomy.json` 不跨机同步）
  //     缺 `jobs['tidy']` 覆盖项时一律不跑；生产机另有显式 `jobs['tidy'].enabled=false` 兜底
  //     （2026-09-29 同批 CLI 写入）。放行/关回 = `butler-autonomy-cli.mjs job on|off tidy --reason "…"`
  //     （**只改开关不改代码**）；关回属甲档、首次放行属乙档。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是代码常量；`--status`/`--list` 是新进程读当前代码，
  //     不代表运行中实例已加载）。**只重启 tickd，不重启 dsh**。
  //   intervalMs 12 小时（= 脚本自报的 `INTERVAL_MS = 12 * 3600_000`；采集是遍历级低频活，
  //     间隔改了要先核对脚本内常量）。**2026-09-29 the operator令：6h → 12h**（原文「tidy 改 12 或者 24 小时
  //     放行」，the operator取 12h 档；P8 方案 §4.1 A2 / §7.1 原文仍是「每 6h」⇒ 方案未回写，此处为现值真源）。
  //   initialMs 600_000 接在既有错峰序列**末位之后**（序列：5 restart / 10 watch / 20 queue /
  //     30 watchfs / 60 pitfall / 90 external / 130 barewatch / 150 imagegen / 210 hot / 240 queue-wake /
  //     270 p0-auto-restart / 300 p5-auto-rollback / 330 auto-heal / 360 ctx-guard / 390 card-watchdog /
  //     420 evidence-precheck / 450 arrive-b / 480 dup-cards-merge / 480 session-mirror / 510 memory-vectors /
  //     540 relay / 570 board-line-archive ⇒ **600**）。**维护口径**：今后新接间隔型 job 必须重排
  //     initialMs 并回读全表（不许只看某一段）＋按本表纪律在此处登记。
  //   ⚠️ **刻意不填 `lockRunner`**：脚本自身带 `createScheduler({name:'tidy'})` +
  //     `acquireTickLock('tidy-audit')`（= `${TICK_NAME}-${COLLECTOR_ID}`）⇒ tickd 侧抢
  //     `tick-tidy-audit.lock` 后注入 `DSH_BUTLER_TICK_LOCK_HELD=tidy-audit`，子脚本走**内存虚拟锁**
  //     （跨入口互斥仍成立：计划任务/手动直跑抢真锁）。再套包装层 = 双层锁互相打架
  //     （同 `memory-distill` / 四动作先例）。锁登记必须与脚本自报锁名恒等 —— 见 `lib\butler-locks.mjs`。
  //   ⚠️ **纯只读**：只写 `butler-tidy-state.json` + 自己的审计流水；不搬移/不删除/不改名；
  //     跨线让路走「判窗口 + 整轮跳过」（**刻意不抢 handoff 锁**，见脚本头 §16-23）。
  { id: 'tidy', label: 'P8 收纳审计采集（只读 · 默认关）', intervalMs: 12 * 60 * MIN, initialMs: 600_000,
    defaultWhenUnset: 'off',
    script: 'butler-tidy-tick.mjs', args: [], dir: HERE },
  // ── 2026-10-09（冲刺600 · 卡「归档出错自动重试接调度」）：P3-L2 `archive` job 接进 tickd 调度表 ───
  //   为什么接：动作体**早已实现并注册进子脚本调度器**（`butler-auto-tick.mjs` 的 `AUTO_JOBS.archive`
  //     + `jobArchive()` / `lib\archive-watch.mjs`，`sch.register({...AUTO_JOBS.archive})` 在位），
  //     但本 JOBS 表**从无 archive 行** ⇒ 生产从来没调度过它（旁证：`butler-auto-actions.json` 的
  //     daily 17 天 0 条 `archive-retry`；`.auto-archive.json#state.lastResult.errors` 为空）。
  //     本行只补「接线」；**放行是另一件事**（首次放行属乙档，等the operator拍板）。
  //   入口沿用 `butler-auto-tick.mjs --job archive`（与 AUTO_JOBS.archive 同一实现；子脚本内
  //     调度器锁名 = `p3-auto-archive`）。
  //   闸门：`runAction({kind:'archive-retry'})` —— 过 L0 降档闸 + `p3AutoEnabled` 总闸 +
  //     24h 签名去重 + 单日上限（`butler-autonomy-limits.json`）+ token 预算门；
  //     任一不过 → blocked/noop 且**零副作用**（不写记账 / 不占额度 / 不写审计 / 不 spawn）。
  //   ⚠️ **默认关（交付纪律，同 overnight-guard / night-stop-audit / tidy 先例）**：声明
  //     `defaultWhenUnset:'off'` ⇒ **任何**机器（含对端：`butler-autonomy.json` 不跨机同步）
  //     缺 `jobs['archive']` 覆盖项时一律不跑；生产机另有显式 `jobs['archive'].enabled=false` 兜底
  //     （2026-10-09 同批 CLI 写入）。
  //     放行/关回 = `butler-autonomy-cli.mjs job on|off archive --reason "…"`（**只改开关不改代码**）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是代码常量；`--status`/`--list` 是新进程读当前代码，
  //     不代表运行中实例已加载）。**只重启 tickd，不重启 dsh**。
  //   intervalMs 30 分钟（= `AUTO_JOBS.archive.intervalMs` 同值；归档重试是低频账本级动作）。
  //   initialMs 630_000 接在既有错峰序列**末位之后**（序列：5 restart / 10 watch / 20 queue /
  //     30 watchfs / 60 pitfall / 90 external / 130 barewatch / 150 imagegen / 210 hot / 240 queue-wake /
  //     270 p0-auto-restart / 300 p5-auto-rollback / 330 auto-heal / 360 ctx-guard / 390 card-watchdog /
  //     420 evidence-precheck / 450 arrive-b / 480 dup-cards-merge / 480 session-mirror / 510 memory-vectors /
  //     540 relay / 570 board-line-archive / 600 tidy ⇒ **630**）。**维护口径**：今后新接间隔型 job
  //     必须重排 initialMs 并回读全表（不许只看某一段）＋按本表纪律在此处登记。
  //   ⚠️ 锁登记必须同步加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`p3-auto-archive`，否则
  //     「tickd 全部 job 都有锁登记」不变量单测会红 —— reconcile / secretary-morning /
  //     memory-vectors / relay / tidy 五次先例）。
  { id: 'archive', label: 'P3-L2 归档出错自动重试（默认关）', intervalMs: 30 * MIN, initialMs: 630_000,
    defaultWhenUnset: 'off',
    script: 'butler-auto-tick.mjs', args: ['--job', 'archive'], dir: HERE },
  // ── 2026-10-09（冲刺600 · 卡「token 用量监测接调度」）：P3 `token` job 接进 tickd 调度表 ─────────
  //   为什么接：`lib\token-usage.mjs`（scanTokenUsage / checkThresholds / 按会话·按卡归因）与
  //     `butler-auto-tick.mjs` 的 `AUTO_JOBS.token` / `jobToken()` **早已实现并注册进子脚本调度器**
  //     （`sch.register({ ...AUTO_JOBS.token, … })` 在位），但本 JOBS 表**从无 token 行** ⇒ 生产从来没
  //     调度过它（旁证：全盘递归找不到 `~/.dsh/butler-token-usage.json`，从未落盘）；
  //     `butler-autonomy-limits.json#tokenBudgetPerDay=0` ⇒ 预算门没数据可用，等于未启用。
  //     本行只补「接线」——**放行是另一件事**，见下面两条默认层口径。
  //   入口沿用 `butler-auto-tick.mjs --job token`（与 AUTO_JOBS.token 同一实现；子脚本内调度器
  //     锁名 = `p3-auto-token`，见 `lib\butler-locks.mjs` 登记）。
  //   ⚠️ **它不是 `runAction()` 族的自主动作**：`jobToken()` 是**只读扫会话日志 + 写自己的台账**
  //     （0 token、无外部出口、不调 LLM、不改卡/不改配置/不重启），故**不挂 p3-auto 总闸**、也不占
  //     每日额度 —— 与 `precheck`（只读预检）同类。它是**预算门的数据提供者**：不跑 = 预算门没数据。
  //   ⚠️ **缺键默认层的语义（如实写明，本次一个开关都没改）**：源码**不写** `enabled:false`，也
  //     **不声明** `defaultWhenUnset:'off'` ⇒ 缺 `jobs['token']` 覆盖项时按**全局既有默认（开）**
  //     处理，与 watch / pitfall / hot 等常态 job 同款；生产 `butler-autonomy.json` 本次**一字未动**。
  //     关回（属甲档、随时可做、下一轮 loop 即生效）=
  //     `node tools\dsh-butler\butler-autonomy-cli.mjs job off token --reason "…"`。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是代码常量；`--status`/`--list` 是新进程读当前代码，
  //     不代表运行中实例已加载）。**只重启 tickd，不重启 dsh**。
  //   intervalMs 60 分钟：token 监测是「按天滚动 + 超预算拦后续自动动作」的判据源 —— 一天一次太迟
  //     （预算门要当天就看得见），1 小时与同类轻量只读 job（imagegen / external / session-mirror）同档；
  //     **三处同值** = 本行 / `AUTO_JOBS.token.intervalMs` / `lib\butler-locks.mjs` 的 `intervalMs`。
  //   ⚠️ **首次全扫是重活**：本机无历史台账 ⇒ 第一轮要解全部会话日志（实测分钟级），此后每轮只解
  //     字节数变化的文件（增量）。故 initialMs 660_000 接在错峰序列末位之后（序列：5 restart /
  //     10 watch / 20 queue / 30 watchfs / 60 pitfall / 90 external / 130 barewatch / 150 imagegen /
  //     210 hot / 240 queue-wake / 270 p0-auto-restart / 300 p5-auto-rollback / 330 auto-heal /
  //     360 ctx-guard / 390 card-watchdog / 420 evidence-precheck / 450 arrive-b / 480 dup-cards-merge /
  //     480 session-mirror / 510 memory-vectors / 540 relay / 570 board-line-archive / 600 tidy /
  //     630 archive ⇒ **660**）。**维护口径**：今后新接间隔型 job 必须重排 initialMs 并回读全表
  //     （不许只看某一段）＋按本表纪律在此处登记。
  //   ⚠️ 锁登记必须同步加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`p3-auto-token`，否则
  //     「tickd 全部 job 都有锁登记」不变量单测会红 —— reconcile / secretary-morning /
  //     memory-vectors / relay / tidy / archive 六次先例）。
  { id: 'token', label: 'P3 token 用量监测（只读扫会话日志）', intervalMs: 60 * MIN, initialMs: 660_000,
    script: 'butler-auto-tick.mjs', args: ['--job', 'token'], dir: HERE },
  // ── 2026-10-10（卡「冲刺600·补记忆服务面」· gap-2-23：S3a 文档索引库**无调度**）────────────
  //   现状（本卡只读取证）：`~/.dsh/memory-vectors/doc-index.db` 与 `butler-doc-index-state.json`
  //     双双停在 2026-09-21 08:44:10（18 天未更新）；tickd JOBS 表里**没有任何 doc-index 行**
  //     ⇒ 索引**有产物、无调度点**（建库器只在手工跑时动过）。
  //   本行 = 给 `tools\memory-engine\cli\doc-index-rebuild.mjs` 挂一个**低频**（周一 04:30）调度点。
  //   ⚠️ **为什么是周频、为什么 04:30**：① 文档索引是离线层，日频收益低、全量重扫有 I/O 成本；
  //     ② 04:10 memory-distill / 04:20 memory-snapshot / 04:40 nurse-retention 已占住夜间窗口，
  //        04:30 正好插在中间，彼此不抢 I/O。
  //   ⚠️ **重建器自带回滚**：每次真跑前 `VACUUM INTO`
  //     `~/.dsh/memory-vectors/doc-index-snapshots/doc-index-<ts>.db`（`--restore <快照>` 可一键回退）。
  //   ⚠️ **关回（甲档·下一轮 loop 即生效）**：
  //     `node tools\dsh-butler\butler-autonomy-cli.mjs job off doc-index --reason "…"`
  //     （或直接删本行 + 重启 tickd；**只重启 tickd，不重启 dsh**）。
  { id: 'doc-index', label: '文档索引重建（记忆引擎离线层 · 周频）', at: 'MON 04:30', initialMs: 0,
    script: path.join(DSH, 'tools', 'memory-engine', 'cli', 'doc-index-rebuild.mjs'), args: [],
    dir: path.join(DSH, 'tools', 'memory-engine') },
  // ── 2026-10-10（卡「冲刺600·补记忆服务面」· gap-3-78：G16 B 线版本体检**无自动调度**）──────
  //   现状（本卡只读取证）：tickd state 的 jobs 段只有 `upgrade-patrol`，**没有 upgrade-watch**；
  //     `dsh-upgrade-watch.mjs`（B 线：本地插件 × 主包版本体检）此前只存在于手工调用。
  //   本行 = 把它挂进早晨巡检链。**只读 + 零 token**（脚本头部：默认不写任何文件；
  //     未传 `--json <path>` 时零写入），**不承接任何升级动作**（升级永远the operator批准后在主会话执行）。
  //   ⚠️ **为什么 09:35**：接在 daily(09:00) / secretary-morning(09:05) / reconcile(09:10) /
  //     upstream(09:20) / upgrade-patrol(09:30) 之后 —— 与既有 `upstream`（A 线·内容面）
  //     同链、紧邻，两线结论并列可比；错峰避开同一分钟。
  //   ⚠️ **exit 3 是环境语义**（本地基线缺失），不是失败 ⇒ 登记为 benign。
  //   ⚠️ **关回（甲档）**：`node tools\dsh-butler\butler-autonomy-cli.mjs job off upgrade-watch --reason "…"`。
  { id: 'upgrade-watch', label: 'B 线版本体检（只读）', at: '09:35', initialMs: 0,
    script: path.join(DSH, 'tools', 'dsh-upgrade-watch.mjs'), args: ['--quiet'],
    dir: path.join(DSH, 'tools'), benignExitCodes: [3],
    benignExitLabel: '本地基线缺失（未跑过采集/无 packages 基线）⇒ 安全跳过（不计 failures）' },
  // ── 2026-10-10（卡「冲刺600·补记忆服务面」· gap-2-33：采集面「件在、闸关、无调度点」）──────
  //   现状（本卡只读取证）：`tools\secretary-feed.mjs` 在位（39 KB）· `switches.feed=false` ·
  //     `~/.dsh/memory/feed.db` 不存在 · tickd 与 AUTO_JOBS **无 feed 行** ⇒ 三个缺里两个是"没有调度点"。
  //   本行补的就是**调度点**：每日 20:30 跑 `reconcile` —— 方案 §11.3-S2 原文要求
  //     「文件与记忆条数量/大小**每日对一次**；不齐 ⇒ 落日报，**绝不静默**」。
  //   ⚠️ **它不是投喂写入**：`reconcile` 只做三面引用对账（条 ↔ 实体 ↔ 记忆条），
  //     唯一写入 = 自家状态文件 `~/.dsh/secretary-feed-reconcile.json`；
  //     **投喂写面（落盘 + 记忆条）仍由 `switches.feed` 关着**（新写入面默认关，且当前
  //     宿主根本没有投喂入口 —— 外部通道长连接 / 浏览器上传属 L-2 / L-4，未落地）。
  //   ⚠️ **退出码 3 = 对账发现半完成态**（不是环境语义）⇒ **不当 benign**：它就是要红出来让人看见。
  //   ⚠️ **关回（甲档·下一轮 loop 即生效）**：
  //     `node tools\dsh-butler\butler-autonomy-cli.mjs job off secretary-feed --reason "…"`。
  //   🔢 **订正注（2026-10-10 22:2x · 卡「冲刺600·第23棒补件」执行会话）**：上一段「现状（本卡只读取证）」
  //     里的 **`switches.feed=false` 已过时** —— 该闸已依the operator 2026-10-10 21:53 令放行，现值 **`true`**
  //     （`readFeedGate()` 实读 `feedEnabled:true/reason:"ok"`）；`feed.db` 仍不存在、宿主仍无投喂入口
  //     ⇒ **本 job 的行为一个字节没变**（它跑 `reconcile`，只读对账、**不读该闸**）。真源 =
  //     `docs/`。**关回 = 该键改回 false**（一键）。
  { id: 'secretary-feed', label: '服务面投喂对账（只读 · 不写投喂面）', at: '20:30', initialMs: 0,
    script: path.join(DSH, 'tools', 'secretary-feed.mjs'), args: ['reconcile'],
    dir: path.join(DSH, 'tools') },
  // ── 2026-10-12（卡 caa96f3f · 多端线）：「**按需自动开隧道**」接调度 ─────────────────────────
  //   the operator 2026-10-12 11:32 令原文：「<host> 按需开隧道这事，如果我只是**偶尔问一句**，是不是没必要
  //     开隧道，如果是**连续会话**再开吧」。
  //   语义 = 每 2 分钟判一次「本机最近有没有**连续/密集**的跨机消息」⇒ 有就 `relay-cli enable + up`，
  //     静默 M 分钟（默认 15）就 `down`；**绝不允许无脑常开**。
  //   判决体 = `tools\relay\relay-ondemand.mjs`（自有开关 `~/.dsh/relay/ondemand.json`，关了它
  //     本 job 就是 no-op ⇒ 回到「纯手动开隧道」）。判据 / 默认值 / 信号来源全部写在那个文件头。
  //   ⚠️ **两层开关都可一键关回**：① `relay-ondemand.mjs disable`（本文件配置）
  //     ② `butler-autonomy-cli.mjs job off relay-ondemand --reason "…"`（调度层）。
  //   🔴 **只关自己开的**：隧道若是**别人手动开的**（`ondemand-state.json` 无归属），本 job **不动它**
  //     —— 免得把the operator正在用的通道掐了（配置 `manageExternal`，缺省 false）。
  //   🔴 **公司有线网短租**：判据 = 物理网卡 `MediaType=802.3 && Up`（脚本内探测、缓存 10 分钟、
  //     走 **pwsh 7**，禁裸 powershell 5.1）；探测不到按公司网**从严**。硬上限 `hardCapMin=30` 分钟
  //     ⇒ 到点无条件 `down`。**不碰** `DSH-Relay-<host>` 自启任务、**不碰** <host> 侧。
  //   ⚠️ **默认关（交付纪律，同 overnight-guard / archive / pitfall-cluster 先例）**：声明
  //     `defaultWhenUnset:'off'` ⇒ **任何**机器（含对端：`butler-autonomy.json` 不跨机同步）缺
  //     `jobs['relay-ondemand']` 覆盖项时一律不跑 ⇒ **对端（<host> / <host>）天然不会去开 <host> 的隧道**。
  //     本机放行 = `butler-autonomy-cli.mjs job on relay-ondemand --reason "…"`（**只改开关不改代码**）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是代码常量；`--status` 是新进程读当前代码，
  //     不代表运行中实例已加载）。**只重启 tickd，不重启 dsh**。
  //   intervalMs 2 分钟（卡口径「每 1–2 分钟判一次」）：跨机会话是**分钟级**的活动，
  //     判太稀（5 分钟）跟不上"连续会话"的节奏，判太密（1 分钟）白跑 git fetch。
  //   initialMs 750_000 —— **必须解释**：既有错峰序列末位是 `memory-sync` 690_000，但它之后的
  //     720_000 **不能用**：本 job 周期 120 s 与 `ctx-guard`（2 * MIN / initialMs 360_000）**同网格**
  //     （360 mod 120 = 720 mod 120 = 0）⇒ 取 720 会与 ctx-guard **每轮都撞**。750 mod 120 = 30
  //     ⇒ 稳定错开 ctx-guard（720 / 840 / …）**30 秒**，且晚于 690。
  //     **维护口径**：今后新接**周期型** job 选 initialMs 时，除了"接末位"，还要核对
  //     `initialMs mod 本 job 周期` 是否与**同周期**既有 job 同余（同余 = 永远撞）。
  //   ⚠️ 锁登记**已同步**加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`relay-ondemand`，
  //     `lockRunner: true`）—— 否则「tickd 全部 job 都有锁登记」不变量会红
  //     （reconcile / secretary-morning / memory-vectors / relay / tidy / archive / token 七次先例）。
  { id: 'relay-ondemand', label: '按需自动开隧道（连续跨机才开 · 默认关）', intervalMs: 2 * MIN, initialMs: 750_000,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'relay', 'relay-ondemand.mjs'), args: ['run', '--apply'],
    dir: path.join(DSH, 'tools', 'relay') },
  // ── 2026-10-14（卡「愿景实体核查 R11」· 真源 R9 报告 §3.4 / §8-R2 / §9-P1）────────────────
  //   短租租约**过期回收**：R9 给传输类 job 加了「按需短租隧道」，收尾 `try/finally` 归还；
  //   **但进程被硬杀 / 断电 / 收尾没跑到** ⇒ 租约留在 `~/.dsh/relay/short-lease.json`、隧道可能
  //   **挂过夜**（违公司有线网短租纪律）。本 job = 那个兜底的**自动入口**（此前只有人工 CLI）。
  //   动作体 = `tools\peer-channel-reclaim-tick.mjs`（**薄壳**：调共用件 `lib\peer-channel.mjs`
  //   的 `reclaimStaleLease({apply:true})`，不重造判据）；**只对"由短租开的"动手**，
  //   对"别人已 enabled"的只销租约、绝不动隧道。
  //   ⚠️ **默认关（交付纪律，同 relay-ondemand / tidy / archive 先例）**：声明
  //     `defaultWhenUnset:'off'` ⇒ **任何**机器（含对端：`butler-autonomy.json` 不跨机同步）缺
  //     `jobs['lease-reclaim']` 覆盖项时一律不跑（免得对端去关 <host> 的隧道）。
  //     放行 = `butler-autonomy-cli.mjs job on lease-reclaim --reason "…"`（**只改开关不改代码**）；
  //     关回 = `job off lease-reclaim`（另两道：本脚本缺省 dry-run · `module off tickd-jobs` 整表停）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是代码常量；`--list`/`--status` 是新进程读当前代码，
  //     不代表运行中实例已加载）。**只重启 tickd，不重启 dsh**。
  //   intervalMs 5 分钟：租约默认 20 分钟过期（`peer-channel.mjs#DEFAULT_LEASE_MS`）⇒ 最坏 25 分钟
  //     收回，贴"别挂过夜"这条纪律，又不白跑（一轮只有一次文件读 + 至多一次 relay-cli）。
  //   initialMs 790_000 —— **必须解释**（错峰硬约束：`initialMs mod gcd(P_new,P_other) == 差值 mod gcd`
  //     ⇒ 同余 = 两 job **永远同一刻**触发）。本 job 周期 300_000 ⇒ 对既有 46 条实算：
  //     790_000 mod 300_000 = **190_000**（未被占用的余数，占位集合 {0,5k,10k,20k,30k,45k,60k,90k,
  //     100k,120k,130k,150k,180k,210k,240k,270k}）；mod 120_000 = 70_000（≠ ctx-guard 0 · relay-ondemand
  //     30_000）；mod 60_000 = 10_000（≠ restart 5_000 · queue 20_000 · stuck-recovery 45_000）。
  //     **零撞车**（可复跑：`docs/`）；且 790_000 紧随错峰
  //     序列末位 `relay-ondemand` 750_000 之后（780_000 会撞 text-sync / session-mirror /
  //     dup-cards-merge，故取 790_000）。**维护口径**：今后新接周期型 job 照此算式核 `mod gcd`。
  //   ⚠️ 锁登记**已同步**加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`lease-reclaim`，
  //     `lockRunner: true`）—— 否则「tickd 全部 job 都有锁登记」不变量会红（八次先例）。
  { id: 'lease-reclaim', label: '短租租约过期回收（兜隧道挂过夜 · 默认关）', intervalMs: 5 * MIN, initialMs: 790_000,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'peer-channel-reclaim-tick.mjs'), args: ['--apply'],
    dir: path.join(DSH, 'tools') },
  // ── 2026-10-16（卡「R-061 余项 · 过期占位收敛」· 真源 `docs/` §4 R-061）────
  //   「没人管的占位」过期收敛：升级锁（判 `interrupted`）+ 挂起锁 `repair-hold.json`（已过期）。
  //   事故背景 = `docs/`（跑升级的那一端断网消失 ⇒ 锁留在原地、48 分钟无人放行）。
  //   动作体 = `stale-lease-reaper-tick.mjs`（**薄壳**：调共用件 `lib\stale-lease-reaper.mjs`，不重造判据）。
  //   ⚠️ **默认关（交付纪律，同 relay-ondemand / lease-reclaim / tidy / archive 先例）**：
  //     声明 `defaultWhenUnset:'off'` ⇒ 任何机器（含对端：`butler-autonomy.json` 不跨机同步）缺
  //     `jobs` 覆盖项时一律不跑。放行 = `butler-autonomy-cli.mjs job on stale-lease-reap --reason "…"`；
  //     关回 = `job off stale-lease-reap`（另两道：脚本缺省只报告 · `module off tickd-jobs` 整表停）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是代码常量；`--list`/`--status` 是新进程读当前代码）。
  //   ⚠️ **挂点自举说明（为什么挂 tickd 不是死结）**：静默窗 `--disable` 会停 tickd ⇒ 若"锁 + 静默窗同时残留"，
  //     本 job 与 tickd 一起停着。但**静默窗残留已由 guard 侧 `lib\residue-reaper.mjs` 收敛**（守护鱼不在
  //     静默窗停的名单里）⇒ 链式自愈 = 静默窗先清 ⇒ tickd 恢复 ⇒ 本 job 再清锁。
  //   intervalMs 5 分钟：一轮只读 2~3 个小文件（秒级），不白跑。
  //   initialMs 820_000 —— 错峰硬约束（`initialMs mod gcd(P_new, P_other)` 不得与既有 job 同余）；
  //     本 job 周期与 lease-reclaim 同为 300_000 ⇒ 取 mod 300_000 = 220_000（lease-reclaim 占 190_000）。
  //     可复跑校验（逐 job 实算 gcd）：`node tools\dsh-butler\_test\test-stale-lease-reaper.mjs`（F 组 F11）。
  //   ⚠️ 锁登记已同步加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`stale-lease-reap`，`lockRunner: true`）。
  { id: 'stale-lease-reap', label: '过期占位收敛（升级锁/挂起锁 · 默认关）', intervalMs: 5 * MIN, initialMs: 820_000,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'dsh-butler', 'stale-lease-reaper-tick.mjs'),
    args: ['--apply', '--allow-production'],
    dir: path.join(DSH, 'tools', 'dsh-butler') },
  // ── R-062「失败必须有一次送达」（2026-10-16 · 卡「V3机器锁3 · R062 失败送达」）─────────────
  //   语义：**关键 job**（判据 = 会改生产 / 会推仓 / 会动数据 / 是看护类；清单**唯一源** =
  //     `lib\job-failure-delivery.mjs#CRITICAL_JOBS`）的**最近一次真失败**（`lastStatus` ∈ exit-N / error / spawn-error）
  //     ⇒ **首败即报**（不设"连续 N 次"静默期 —— 那正是事故形态：一整晚没人知道）：
  //       ① 写**既有**告警出口 `~/.dsh/butler-alert.log`（`lib\alert.mjs`，level=error · source=tickd ·
  //          同 job 30 分钟冷却；**observe 档不消费冷却配额**）；
  //       ② 对"首败"采一份**最小资源快照**（`lib\failure-snapshot.mjs` → `%TEMP%\dsh-butler-failsnap\`；
  //          采集清单照 `docs/` §3）；
  //       ③ 日报「🚨 关键 job 失败送达」段（`dsh-butler-panel\report.mjs`）渲染**同一份判据**（日报侧只读）。
  //   ⚠️ **不并入 P2 事件族**：P2 的 4h 冷却 / 日上限 10 是**另一套预算**（判据源也不同 —— P2 读会话/看板快照，
  //      本 job 读 tickd state）⇒ 刻意不互相复制、也不共用配额（否则一次 job 抖动会挤掉真告警的额度）。
  //   ⚠️ **不刷屏**（红线③）：非关键 job 的失败**不报红**（日报里只出一行汇总）；日报每天最多逐条列 8 条。
  //   ⚠️ **默认开**（有意不声明 `defaultWhenUnset`）：本条属"送达/可观测"方向（只写自身告警日志 + `%TEMP%` 快照，
  //      **不改生产数据、不删东西、不花钱**），且the operator 2026-10-16 明确要求「失败必须有一次送达」；
  //      一键关回 = `butler-autonomy-cli.mjs job off failure-delivery`（另有 `module off tickd-jobs` 整表停）。
  //   intervalMs 5 分钟：一轮只读 1 个 state.json（秒级）；`--emit` 时多写 ≤N 行告警 +（首败时）1 份快照。
  //   initialMs 850_000 —— 错峰硬约束（`initialMs mod gcd(P_new, P_other)` 不得与既有 job 同余）：
  //     本 job 周期与 lease-reclaim / stale-lease-reap 同为 300_000 ⇒ 取 mod 300_000 = 250_000
  //     （lease-reclaim 190_000 / stale-lease-reap 220_000 / watch 10_000）。
  //   ⚠️ 锁登记已同步加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`failure-delivery`，`lockRunner: true`）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是模块级常量；`--status` 只是新进程读当前代码）——
  //      本卡**不重启**（红线②）⇒ 生效前使用人工直跑：`node tools\dsh-butler\job-failure-delivery-tick.mjs`
  //      （**缺省只报告**，零写入；真送达加 `--emit --allow-production`）。
  { id: 'failure-delivery', label: '关键 job 失败送达（首败即报 · 告警 + 首败快照）', intervalMs: 5 * MIN, initialMs: 850_000,
    script: path.join(DSH, 'tools', 'dsh-butler', 'job-failure-delivery-tick.mjs'),
    args: ['--emit', '--allow-production'],
    dir: path.join(DSH, 'tools', 'dsh-butler') },
  // ── 2026-10-16（the operator令「四件套都做，改叫插电保护，根据电源情况自己判断」· 卡「整夜模式 -> 插电保护（常驻化四件套）」③）
  //   语义：**周期自愈** —— 每 10 分钟按电源状态把保护态对齐一次：
  //     插电 ⇒ 保护态（不睡眠 / 不关屏 / 合盖不睡 / 防更新重启 / 放行会话接力）；电池 ⇒ 宽限 10 分钟后回日常态。
  //   幂等：状态一致时 `overnight-mode.mjs auto` **零动作、零写盘**（2026-10-16 真机实测：第 2 轮 3.0 s，
  //     主状态文件与 auto 计时文件的 sha + mtime 都不变）。
  //   ⚠️ **默认关（交付纪律）**：`defaultWhenUnset: 'off'` ⇒ 任何机器（含对端：`butler-autonomy.json` 不跨机同步）
  //     缺覆盖项时一律不跑；放行 = `butler-autonomy-cli.mjs job on plug-guard --reason "…"`（**只改开关不改代码**）。
  //   ⚠️ 与 DSH 生态开机链 `dsh-start.ps1` 的 3f 段同源（一个管"开机对齐"、一个管"运行期自愈"）；
  //     真源口径 = `tools\overnight-mode.mjs` 头部「插电自动对齐」段。
  //   ⚠️ **不计 benign 退出码**：auto 对齐成功返 0；on/off 真失败返 1 —— 那正是「保护掉了没人补」，
  //     该红就该红（会被 `failure-delivery` 首败即报，见上面那条）。
  //   ⚠️ 每轮以 `--json` 跑：人类可读日志落 `%TEMP%\dsh-overnight-mode.log`，stdout 只留 JSON ⇒ tickd 留痕干净。
  //   intervalMs 10 分钟：与 auto 的**拔电宽限期（默认 10 分钟）同拍** ⇒ 拔电后最多多等一轮。
  //   initialMs 880_000 —— 错峰硬约束（`initialMs mod gcd(P_new, P_other)` 不得与既有 job 同余）：
  //     本 job 周期 600_000 与 watchfs / p5-auto-rollback / evidence-precheck 同周期 ⇒ 取 mod 600_000 = 280_000
  //     （watchfs 30_000 / p5-auto-rollback 300_000 / evidence-precheck 420_000，均不同余；
  //      与 1 / 2 / 5 / 15 / 30 / 60 分钟各档（gcd 60_000~600_000）逐档复核亦不同余）。
  //   ⚠️ 锁登记已同步加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`plug-guard`，**刻意不加 lockRunner**：
  //     与 overnight-guard 同款 —— 脚本自身不抢锁，由 tickd 抢 `tick-plug-guard.lock` 并注入持锁标记）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是模块级常量；`--status` 只是新进程读当前代码）。
  //   ⚠️ 首次放行属甲档（只切本机电源设置、不花钱、不推远端、不碰对端）—— the operator 2026-10-16 已拍板做实。
  //   ⚠️ **`budgetMs: 90_000`（2026-10-16 首跑实测后补）**：首跑 `ok (2761ms)` 但默认预算只有
  //     2000ms（`class-default`）⇒ 报 `超 1.381×` 并**每 30 分钟写一条告警**（污染 butler-alert）。
  //     本 job 的耗时结构：平时（未到真核点）≈ 3.0 s（node 启动 + 一次 pwsh 读 ACLineStatus）；
  //     真核轮 ≈ 15 s（同 status 判据面）；该切时的 on/off 最坏几十秒（56 条 powercfg + WU + 状态文件）。
  //     ⇒ 取 90 s：覆盖最坏情况、又不至于把真卡死也吞掉。
  { id: 'plug-guard', label: '插电保护自动对齐（按电源切保护/日常 · 默认关）', intervalMs: 10 * MIN, initialMs: 880_000,
    defaultWhenUnset: 'off',
    script: path.join(DSH, 'tools', 'overnight-mode.mjs'), args: ['auto', '--json'], dir: path.join(DSH, 'tools'),
    budgetMs: 90_000 },
  // ── 2026-10-20（R-071 误删三道防线 ③ · 卡「R-071 第③件」）────────────────────────────
  //   为什么要有这条：2026-10-19 23:48:51 起 `~\.dsh` 与 `<butler-root>` 被删掉 4,000+ 件，**全程零告警**；
  //     删除持续 5 分多钟（23:48:51~23:54:12）—— 5 分钟一轮的"件数断崖"足以在窗口内喊停。
  //   与既有 `watchfs` 的分工（**不要合并**）：watchfs 比**内容 hash**判"A 层文件被改动"，
  //     清单是"现在枚举出来的" ⇒ **被删的文件根本不在清单里，消失对它是静默的**；本 job 数是"件数"。
  //   面的口径（**本卡 §2 的结论**）：`sessions + _archived-sessions` **合成一个面** —— 归档会从一面搬到另一面，
  //     分开数必然天天误报"会话大量消失"（开工实测：sessions 159 / 归档 5,705）。
  //   ⚠️ **首版 observe**（状态文件 `mode: 'observe'`）：只记事件、**不调 alert**；
  //     放行 = `node tools\dsh-butler\dsh-vanish-watch.mjs --set-mode notify --apply`（改开关不改代码）；
  //     关回 = `butler-autonomy-cli.mjs job off vanish-watch`（调度层停）或 `--set-mode observe`（恢复只记）。
  //   intervalMs 5 分钟：一轮实测 ≈ 1.1 s（8 面 readdir 合计 1.3 万条目的量级）；
  //     ⚠️ 卡面要求"5 分钟跌幅 >10%"，周期与阈值是两个独立旋钮（阈值默认 10%，`--threshold` 可调）。
  //   initialMs 640_000 —— 错峰硬约束（`initialMs mod gcd(P_new, P_other)` 不得与既有 job 同余）：
  //     本 job 周期 300_000 与 1/2/5/10/15/30/60 分钟各档同节拍 ⇒ 取 mod 60_000 = 40_000（无人占用）、
  //     mod 300_000 = 40_000（watch 10_000 / barewatch 130_000 / queue-wake 240_000 / p0-auto-restart 270_000 /
  //     lease-reclaim 190_000 / stale-lease-reap 220_000 / failure-delivery 250_000 / card-watchdog 390_000 均不同余）。
  //   ⚠️ 锁登记已同步加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`vanish-watch`，**刻意不加 lockRunner**：
  //     脚本自身不抢锁，与 plug-guard 同款 —— 一轮只读 + 原子写自己的状态文件，并发最坏各写一次同样的读数）。
  //   ⚠️ **必须 `--stop` + `--ensure` 才生效**（JOBS 是模块级 const）；`--status` 只是新进程读当前代码。
  //   ⚠️ **`budgetMs: 30_000`**（交付实测后补，照 plug-guard 先例）：默认预算是 2000ms（`class-default`），
  //     而本轮实测 **1.1~1.8 s**（会话面 5,866 条目 + `docs` 2,541 + `tools` 2,069 + `_archive` 顶层 2,358 次 stat）
  //     ⇒ 贴着 2000ms 线跑，机器一忙就会「超时 ⇒ 每 30 分钟一条告警」，把真告警额度挤掉。
  //     取 30 s：覆盖最坏情况（冷缓存/杀软扫描），又不至于把真卡死吞掉。
  { id: 'vanish-watch', label: 'R-071 大量消失告警（observe）', intervalMs: 5 * MIN, initialMs: 640_000,
    script: 'dsh-vanish-watch.mjs', args: ['--once', '--apply'], dir: HERE, budgetMs: 30_000 },
  // ── 2026-10-20（R-071 误删三道防线 ② · 卡「R-071 第②件」）────────────────────────────
  //   为什么要有这条：事故里**没有任何自动快照**，救命靠 <host> 会话镜像 + 卷影 ⇒ 第②道防线 =
  //     每 30 分钟一份**增量**快照（写进 `<butler-root>\_archive\snapshots\dshhome-<ts>\`）+ 每日一次异地镜像。
  //   脚本 `dsh-snapshot-tick.mjs`（**缺省 dry-run**，这里显式 `--apply`）：
  //     · 增量 = 未变且"可硬链"的文件 `fs.linkSync` 到上一份；`.jsonl/.zstd/.log/.db` 等**追加型永不硬链**
  //       （硬链共享 inode，源文件原地 append 会把**旧快照**一起改掉）⇒ 那些每轮复制。
  //     · 🔴 凭据遍历即排除（`.credentials*` / `*credentials*` / `keys\` / `*.key` / `*.pem|pfx|p12`）：
  //       快照写完自查一遍、异地包打包后本地 + 远端各查一遍；命中 ⇒ 删包/删快照 + rc≠0（fail-closed）。
  //     · 🔴 junction 一律 lstat 判定、不跟随；清理走 `tools\safe-rm-tree.mjs`，**只删自己生成的份**
  //       （manifest.generator === 'dsh-snapshot-tick'）—— 手工件 `dshhome-20261020-0147` 永不被碰。
  //     · 保留 6 份（`--keep`）/ 72 小时（`--hours`）；首跑实测 2,005 件 / ≈156 MB，稳态 6 份 ≈ 0.9 GB。
  //     · 异地镜像每日一次（判据 `state.lastMirroredDay` ≠ 今天，或 `--push-now`）：打包 → 自查 →
  //       `lib\peer-channel.mjs` 择路（lan → 隧道 → 按需短租）→ scp 到 `<host>:<butler-root>-home-backup\` → 远端验包。
  //   错峰：周期 30 min 与既有各档共节拍 ⇒ 取 `initialMs: 745_000`（`docs/` 实测 34 个 job 全不同余）。
  //   budgetMs 240 s：打包 + scp + 远端 tar -tzf 的预算（单轮快照实测 < 2 s，镜像日才用得上）。
  //   ⚠️ 必须 `--stop` + `--ensure` 才生效（JOBS 是模块级 const）；关回 = `butler-autonomy-cli.mjs job off snapshot`。
  { id: 'snapshot', label: 'R-071 定时快照 + 异地镜像（30 分钟 · 排除凭据）', intervalMs: 30 * MIN, initialMs: 745_000,
    script: 'dsh-snapshot-tick.mjs', args: ['--once', '--apply'], dir: HERE, budgetMs: 240_000 },
  // ── 2026-10-27（批 2 · 2-1 · 真源 `docs/` §3 批 2 的 2-1 格）──────
  //   为什么要它：隧道**常驻**之后必须有**独立保活**，不能继续挂在 `net-arbiter` 上
  //     （方案 §7：保活下沉到 `relay-keepalive`；net-arbiter 还有六件职责没全部移交 ⇒ 它的计划任务**不许拆**）。
  //   脚本 `tools\relay\relay-keepalive.mjs`（**缺省 dry-run**，这里显式 `--apply`）：
  //     · 四元组判定 = `enabled` + `process` + `port19080` + **端到端探针**（`ssh <peer> hostname`，≤3 s）
  //       —— 只看端口不够（实测踩过「process=1 而端口空」和「端口在听但隧道半死」两种病态）；
  //     · 已在听且探针通 ⇒ **零动作**（幂等，绝不重复建连）；只缺端口 / 只缺探针 ⇒ 按半死**真重建**；
  //     · `enabled=false` ⇒ **先 `relay-cli enable` 再 `up`**（`up` 要求 enabled=true，单条拉不起来）。
  //   ⚠️ `benignExitCodes:[3]`：脚本让路码 = **端到端探针外部阻塞**（<host> 关机 / the operator不在家网 / VPS 转发断）
  //     ⇒ 本轮让路、不涨 failures。此时隧道本机侧是好的（端口在听、进程在），反复重建没有意义，
  //     脚本自己会把 `blockedStreak` 记账，只重建**第一次**，之后只让路。
  //   ⚠️ **默认开**（fail-safe：隧道没人保活比多跑一次更糟）—— 刻意不写 `defaultWhenUnset`，
  //     缺 `jobs['relay-keepalive']` 覆盖项时按全局默认（开）跑。一键关回 = `butler-autonomy-cli.mjs job off relay-keepalive`。
  //   🔴 与 `relay-ondemand` 的分工（方案 §6 红线「别造第二个隧道写者」）：on-demand 管**按流量开/关**、
  //     生产上必须保持 `enabled=false`；本 job 只做「缺了才补」—— 从不调 `relay-cli down`、不读网络分档。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是模块级 const）：`--stop` + `--ensure`。**只重启 tickd，不重启 dsh**。
  //   intervalMs 5 分钟（方案原文）：拉起判据就是「杀进程后 5 分钟内复听」，周期 = 那个上限。
  //   initialMs 950_000 —— **必须解释**（错峰硬约束：`(init_new - init_other) % gcd(P_new,P_other) ≠ 0`）：
  //     实算（`docs/` 跑既有 39 个周期型 job 全表）：950_000 **零撞车**；
  //     5 分钟余数 = 50 s，距最近同周期锚（watch 10 s / barewatch 130 s）≥40 s；
  //     同时接在既有 interval 序列末位（memory-sync-leaf 900_000）之后。
  //   budgetMs 90 s：最坏一轮 = kill + enable + up（内部 waitListening 8 s）+ 复检探针 ≤3 s ⇒ 实测秒级~20 s，
  //     90 s 覆盖慢盘/杀软扫描，又不至于把真卡死吞掉。
  { id: 'relay-keepalive', label: '19080 中继保活（四元组 + 端到端探针 · 5 分钟）', intervalMs: 5 * MIN, initialMs: 950_000,
    script: path.join(DSH, 'tools', 'relay', 'relay-keepalive.mjs'), args: ['--apply'],
    dir: path.join(DSH, 'tools', 'relay'), budgetMs: 90_000,
    benignExitCodes: [3], benignExitLabel: '端到端探针外部阻塞（<host> 关机 / 不在家网 / VPS 转发断）⇒ 本轮让路' },
  // ── 2026-10-28（V3 功能面 · 批 2「拆仓库钩子」· **真源 = 本卡 / 方案 §4 批 2**）────────────────────
  //   为什么要有这条：本卡把**四个读写 Gitee 三仓的 job**（`hot` / `text-sync` / `memory-snapshot` / `arrive-b`）
  //     全关掉。仓不再是同步通道 ⇒ `docs` 面必须换一条腿，否则文档就此断供。
  //   脚本 `tools\dsh-butler\text-sync-direct.mjs`（**缺省 dry-run**，这里显式 `--apply`；批 1 卡 `793ac386` 交付）：
  //     · 三段式：本机清单 → 对端**只读**挑选 → 分批容器 scp + 对端落位；**只增不删**、不覆盖较新件、
  //       双写件只落 `.conflict-<host>-<stamp>-<sha8>` 副本、覆盖前留 `.bak-<stamp>`（只留 1 份）。
  //     · 稳态走 size+mtime 快路径，只对"已经不像同一份"的算 sha ⇒ 增量轮通常秒级。
  //   🔴 args 三条都**必须**带：
  //     · `--apply` —— 脚本缺省 dry-run，不带就等于白跑一轮（还记 ok，最坑）。
  //     · `--only docs,presets` —— 【2026-10-29 订正 · D5】**原文是 `--only docs` / 不碰 presets**
  //       （历史理由照录：presets 归<mainline>线，对端那份 whale-girl 预设正在 FLIP2-C 重启窗口里改，
  //       本 job 去写会和那边撞车；docs 才是"拆仓之后没人搬"的那一块）。**该窗口已于 2026-10-28 结束**，
  //       the operator 2026-10-29 已拍 D5（清单 `docs/`）⇒ args 改为 `docs,presets`
  //       （预设是口径文件，不同步的话换机会丢）。
  //       开前用 `--only presets` 干跑量过（2026-10-29 15:35，rc=0、零写入）：本机 6 份 / 对端 <host> 17 份；
  //       去程（→对端）新增 1 份（`card-no-ask/preset.yml`）· 跳过 4（peer-newer 2 / same-content 2）·
  //       **更新 0 · 冲突 0**；回程（对端→本机）拉取 11 份 / 0.16 MB · 跳过 2（same-content）·
  //       **更新 0 · 冲突 0** ⇒ 只增不覆盖。
  //       🔴 跨线注意：对端 `.agent-presets` 归**<mainline>线 / <mainline>线**。若将来摘要里出现
  //         `presets：更新 N 份`（= 真覆盖了对端）⇒ 先 `butler-autonomy-cli.mjs job off text-sync-direct`
  //         停手，找the operator判是否上双写保护（`--dual-write`）—— **别自己拍**。
  //     · `--max-batch-bytes 8388608` —— 批 1 实测：单批按默认 32 MB 走隧道会 `scp: Broken pipe`（rc=255），
  //       8 MB + 内部 3 次退避重试才稳。
  //   ⚠️ `benignExitCodes:[3]`：脚本让路码 = 通道不通 / 对端不可达 / 锁被占（批 1 契约明确写了 3=让路）
  //     ⇒ 本轮让路、不涨 failures。公司网上对端不可达属物理常态，不该记成失败。
  //   ⚠️ **默认开**（fail-safe：拆了旧 job 之后没人搬文档比多跑一轮更糟）—— 刻意不写 `defaultWhenUnset`。
  //     一键关回 = `butler-autonomy-cli.mjs job off text-sync-direct`。
  //   🔴 **锁登记已同步**加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`text-sync-direct`，**刻意不加
  //     `lockRunner`** —— 脚本自己 `acquireTickLock`，包装层再抢一次 = 永远判 locked）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是模块级 const）：`--stop` + `--ensure`。**只重启 tickd，不重启 dsh**。
  //   intervalMs 60 分钟（方案 §4 批 2）：拆掉 `text-sync`（60 分钟）之后原样接上同一节奏。
  //   initialMs 1_000_000 —— **必须解释**（错峰硬约束：`(init_new − init_other) % gcd(P_new, P_other) ≠ 0`）：
  //     实算（`<butler-root>\docs/`，静态解析本表 → 现表 63 job / 40 个周期型：
  //       1,000,000 **零撞车**；与**同周期（60 min）**最近者间隔 **220 s**（> 既有 120 s 间距纪律）；
  //       接**末位**：现序列末位 = `relay-keepalive` 950_000 ⇒ 差 **50 s** ≥ 40 s（照那条定下的间距）。
  //     ⚠️ 刻意**不用**卡里提示的"从 950_000 附近找起"的原值：950_000 与 `relay-keepalive`
  //       （间隔 5 min ⇒ gcd 300_000）**同余（差 0）⇒ 永远撞车**，脚本已实测点名。将来新接周期型 job
  //       仍须按此式重算全表。
  //   budgetMs 1_200_000（20 分钟）：批 1 首轮 87 MB 约 30 分钟**是首轮**（之后增量秒级）；
  //     20 分钟覆盖慢盘 / 3 次退避重试 / 一次短租 up，又不至于把真卡死吞掉。
  //     （首轮若超预算只影响那一轮记超时，不影响后续增量轮。）
  { id: 'text-sync-direct', label: '文档直连同步（不经仓 · 60 分钟）',
    intervalMs: 60 * MIN, initialMs: 1_000_000,
    script: path.join(DSH, 'tools', 'dsh-butler', 'text-sync-direct.mjs'),
    args: ['--apply', '--only', 'docs,presets', '--max-batch-bytes', '8388608'],
    dir: path.join(DSH, 'tools', 'dsh-butler'), budgetMs: 1_200_000,
    benignExitCodes: [3], benignExitLabel: '通道不通 / 对端不可达 / 锁被占 ⇒ 本轮让路（物理常态）' },
  // ── 2026-10-29（V3 功能面 · **真源 = `docs/` B2 + D-b1** · the operator「其他按建议落」）──
  //   为什么要有它（B2）：R-044 **两次复发**（2026-10-22 / 2026-10-28）长的是同一个样子 ——
  //     `sync-ignore.mjs --check` 这条判据早就有，可它只等人手工跑；没人跑 ⇒ 排除清单悄悄漂移，
  //     直到下一次出事才被发现。治复发的办法不是再写一份判据，而是**让 tickd 定期跑它**：
  //     红了就变成日报「⏱ tick 调度健康（tickd）」段的一行（走既有链路：rc≠0 ⇒ failures++ ⇒ judgeJob）。
  //   第二件活（D-b1）：`_archive\text-sync-direct\` 每轮同步 +1 个 `<runId>` 目录、没人裁就一直涨
  //     ⇒ 同一个 job 里顺带跑 `--prune-archive --apply`（按脚本既定 retention：留最近 30 份 **且**
  //     ≤ 200 MB，两条件取严；**不新增任何参数**）。它自带生产路径护栏、只认 `<runId>` 形态目录、
  //     `--keep < 1` 直接 rc=2 挡"删光"。
  //   脚本 `tools\dsh-butler\tickd-inspect-15m.mjs`（本卡新增的**包装器**：一件 job 串行跑两件活）：
  //     · ① `sync-ignore.mjs --check`（**只读**）→ ② `text-sync-direct.mjs --prune-archive --apply`；
  //     · 退出码聚合：任一件非 0 ⇒ 本 job 非 0（取**第一个**非 0 件的码）⇒ tickd 记 `exit-N`、
  //       failures++ ⇒ 日报段看得见；两件都 0 ⇒ 0；
  //     · 输出刻意短（每件一行摘要，红了才打关键行 ≤10 行）—— tickd 只留尾部 64 KB。
  //   🔴 **rc=1 / rc=2 一律当让路（不许进 `benignExitCodes`）**：`--check` 的语义是
  //     `0=一致 / 1=不一致 / 2=仓库缺失`，后两个**都是真异常**（排除段漂了 / 仓没了）。
  //     一旦写成让路码，这条巡检立刻变"永远绿"——那正是 R-044 复发的病。⇒ 本 job **刻意不声明
  //     `benignExitCodes`**。⚠️ 现状（2026-10-29 15:44 实测）就有一处真红：`--check` rc=1
  //     （`.gitignore` 排除段期望 210 行 / 实际 208 行）⇒ 本 job 上线第一轮就该红，这是**对的**，
  //     还债不归本卡（本卡只负责"有人定期跑"）。
  //   ⚠️ 锁：**刻意不加 `lockRunner`**（同 `text-sync-direct` / `plug-guard` 先例），三条理由：
  //     ① 被 spawn 的两件**都不抢锁**（`sync-ignore.mjs` 是纯校验；`text-sync-direct.mjs --prune-archive`
  //        在 `acquireTickLock` **之前**就 return —— 见其 `main()` 里 `if (o.pruneArchive) return cmdPruneArchive(o)`）
  //        ⇒ 包装层再抢一次纯属多余，还会与"脚本自己抢锁"那类 job 互相判 locked；
  //     ② tickd 侧 `acquireJobLock` 照旧为本 job 抢 `tick-tickd-inspect-15m.lock` ⇒ **同 job 不并发**；
  //     ③ 与 60 分钟那轮 `text-sync-direct --apply` **不会互相判 locked**：prune 真删走
  //        `fs.rmSync(force:true)`（最坏重复删同一批 = 幂等无害），且它只裁**最老**的，
  //        正在写的那一轮目录是最新的一份 ⇒ 永远落在 keepList 里。
  //     锁登记已同步加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`tickd-inspect-15m`）。
  //   ⚠️ **默认开**（fail-safe：这条巡检本身就是"没人跑"的病根解药，关着等于没装）—— 刻意不写
  //     `defaultWhenUnset`。一键关回 = `butler-autonomy-cli.mjs job off tickd-inspect-15m`。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是模块级 const）：`--stop` + 等守护鱼 `--ensure`。
  //     **只重启 tickd，不重启 dsh**。
  //   intervalMs 15 分钟：巡检的诉求是"漂了当天就能发现"，而两件活都是秒级；15 分钟是既有
  //     「≥15 分钟档」里最保守的一档 —— 再密对收益为零，只会多刷状态文件。
  //   initialMs 110_000 —— **必须解释**（错峰硬约束：`(init_new − init_other) % gcd(P_new, P_other) ≠ 0`）：
  //     实算（`<butler-root>\docs/`，静态解析本表 → 改表前 65 job / 43 个周期型，
  //     已排除自身）：110_000 **零撞车**（对 43 条逐个复核，同余冲突 **0**）；
  //     与**同周期（15 min）**最近者 `arrive-b`（450_000）间隔 **340 s**（≥ 既有 40 s 间距纪律）；
  //     表尾 `notify-docsync` 是 1_050_000（> 一个周期）⇒ 本档只能在 `[40 s, 900 s)` 里取，
  //     110_000 是该区间内第一个零撞车候选（候选清单见交付报告）。
  //   budgetMs 300_000（5 分钟）：两件实测（2026-10-29 15:47 本机）= `sync-ignore --check` **14.5 s**
  //     （50 件 `git check-ignore` 逐条 spawn，是它的大头）+ `prune --apply` **0.4 s**（29 份 / 2 MB）
  //     ⇒ 整轮 16.0 s。300 s 覆盖慢盘 / 杀软扫描，又刻意**不给**得比
  //     60 分钟 job 的 1_200_000 更大（它不是重活）。
  { id: 'tickd-inspect-15m', label: '只读巡检：排除清单校验 + 留档裁剪（15 分钟）',
    intervalMs: 15 * MIN, initialMs: 110_000,
    script: path.join(DSH, 'tools', 'dsh-butler', 'tickd-inspect-15m.mjs'),
    dir: path.join(DSH, 'tools', 'dsh-butler'), budgetMs: 300_000 },
  // ── 2026-10-28（V3 功能面 · **真源 = 本卡 / 报告 `docs/`**）──
  //   为什么要有它：the operator**不看外部通道告警**（原话「现在外部通道那边的告警我都不咋看了」），而
  //     `~\.dsh\butler-alert.log` 已积 **9,328 条 / 5.7 MB**、多数是「job 耗时超预算」这类 info
  //     ⇒ **告警量本身就是它失效的原因**。于是只开一条**窄口子**：
  //     **文档直连同步真的断了才发一条外部通道**，通了再发一条「已恢复」。
  //   脚本 `tools\dsh-butler\notify-docsync-watch.mjs`（**缺省 dry-run**，这里显式 `--apply`）：
  //     · 判「断」= **三条同时满足**：源 job `lastStatus==='deferred'` ·
  //       `consecutiveBenign >= 6`（6 轮 × 60 分钟 ≈ 6 小时）· `lastStartAt` 距今 **< 2 个周期**（120 分钟）。
  //       第三条是**防误报的关键**：机器睡眠 / tickd 自己停摆时 `lastStartAt` 会停在几小时甚至几天前，
  //       而 `lastStatus` 仍留 `deferred`、`consecutiveBenign` 仍留 6 以上 —— 若不加这条，
  //       「关电脑一天回来」就会收到「通道断了」，那是冤枉对端。
  //     · `runs===0` 或 `jobs[jobId]` 不存在 ⇒ 一律**不判、不发**（刚装 / 刚重启 tickd，别一惊一乍）。
  //     · 幂等与频率：状态文件 `~\.dsh\notify-docsync-state.json` 记 lastNotified / day / dayCount，
  //       **同一个状态不重发**；每天最多 2 条（1 条 down + 1 条 up）。
  //   🔴 **刻意不注册 `lib\alert.mjs` 的 `addChannel()`**、不改 `alert.mjs` 的既有行为与既有通道 ——
  //     那等于给全部告警加外部通道通道，洪水立刻回来。本 job 是**唯一的窄出口**。
  //   🔴 配置 `~\.dsh\notify-docsync.json` 里 `enabled:false` **一条即停**（脚本每个入口先读它）。
  //   ⚠️ `benignExitCodes:[3]`：脚本让路码 = **tickd state 读不到或坏** ⇒ 本轮不判定、不涨 failures
  //     （那属于 tickd/机器层的问题，既有告警与守护鱼会管，不归本件）。
  //   ⚠️ **默认开**（fail-safe：这条口子本身就是「告警不该失效」的兜底，关着等于没装）——
  //     刻意不写 `defaultWhenUnset`。关回两条：`butler-autonomy-cli.mjs job off notify-docsync`（彻底）
  //     / 配置 `enabled:false`（立刻生效、不必重启）。
  //   🔴 **锁登记已同步**加在 `lib\butler-locks.mjs` 的 LOCK_REGISTRY（`notify-docsync`，**加了
  //     `lockRunner: true`** —— 脚本自己**不**抢锁，由包装层抢；它会真发外部通道，
  //     两个实例并发 = 同一天同一状态双发）。
  //   ⚠️ **必须重启 tickd 常驻进程才生效**（JOBS 是模块级 const）：`--stop` + `--ensure`。**只重启 tickd，不重启 dsh**。
  //   intervalMs 30 分钟 —— 比源 job（`text-sync-direct` 60 分钟）更密：「恢复」要尽快报出来；
  //     判「断」靠源 job 自己的 `consecutiveBenign` 计数，**不靠本 job 的采样密度**。
  //   initialMs 1_050_000 —— **必须解释**（错峰硬约束：`(init_new − init_other) mod gcd(P_new, P_other) ≠ 0`）：
  //     实算（`<butler-root>\docs/`，静态解析本表 → 现表 64 job / 42 个周期型）：
  //       1_050_000 **零撞车**（对 42 条逐个复核，同余冲突 **0**）；
  //       与**同周期（30 min）**最近者（`snapshot` 745_000）间隔 **305 s**（> 120 s 间距纪律）；
  //       接**末位**：现序列末位 = `text-sync-direct` 1_000_000 ⇒ 差 **50 s** ≥ 40 s（照 relay-keepalive 定下的间距）。
  //   budgetMs 60_000：一轮 = 读两个 JSON（tickd state ≈130 KB）+ 至多一次外部通道发送
  //     （`cli.mjs send` 内部超时 15 s、本件 spawnSync 上限 60 s）⇒ 常态化 < 1 s；
  //     60 s 覆盖慢网/慢盘，又不至于把真卡死吞掉。
  { id: 'notify-docsync', label: '文档同步断链告警（窄口子 · 30 分钟）',
    intervalMs: 30 * MIN, initialMs: 1_050_000,
    script: path.join(DSH, 'tools', 'dsh-butler', 'notify-docsync-watch.mjs'),
    args: ['--apply'],
    dir: path.join(DSH, 'tools', 'dsh-butler'), budgetMs: 60_000,
    benignExitCodes: [3], benignExitLabel: 'tickd state 读不到或坏 ⇒ 本轮不判定（让路）' },
  // ── 2026-10-30（<mainline> · 46-B「outbox 超时告警」· 真源 = `docs/`）
  //   为什么要有它：2026-10-28 清掉 12 个「算完从没人取走」的孤儿结果（10-12 ~ 10-27 陆续攒的）
  //     —— 它们就躺在 `<butler-root>-mailbox\qrog\outbox` 里，此前**没有任何人 / 任何 job 会发现**。
  //     the operator当场同意加常检：outbox 压着超 15 分钟的结果，就得有人知道。
  //   两件套（分工不混）：
  //     · `tools\mailbox\outbox-stale-check.mjs` = **纯只读判定**（rc 0 正常 / 3 超时 / 2 用法 / 4 读不到仓；
  //       一个字节都不写，绝不删/搬/commit/push）
  //     · 本 job 跑的是 `tools\mailbox\outbox-stale-tick.mjs` = **策略层**（去重 + 送达）
  //   送达链（args 显式 `--apply` 才真发）：① `hub-ctl push`（外部通道长连接 · 只发the operator单聊）
  //     → ② the operator本人外部通道直发（与 `notify-docsync` 同一个口子、同一个人）→ ③ 会话通知 + 当日段文件
  //     （`butler-alert.log` 一行 + 桌宠 `/whale/say` + `docs/`）。
  //   ⚠️ **只发the operator本人**；🔴 绝不发家人（不读写家人库、不走家人通道）。
  //   ⚠️ 去重：同一文件名 TTL（默认 6 小时）内只喊一次，每天最多 6 条
  //     —— 不让「15 分钟一跑」变成 96 遍刷屏。
  //   ⚠️ **默认开**（fail-safe：这条口子就是"结果没人取"的唯一常检，关着等于没装）；
  //     一键关回 = `node <butler-root>\tools\dsh-butler\butler-autonomy-cli.mjs job off outbox-stale`。
  //   ⚠️ 退出码恒 0（判定与送达都在脚本内收口）：**不让 job 失败去二次告警**，
  //     否则同一件事会和 `failure-delivery` 撞车双喊。真异常 ⇒ 状态文件 `lastRc` + alert 一行。
  //   intervalMs 15 分钟 = 与阈值同拍（阈值 15 分钟 ⇒ 最多晚一轮发现）。
  //   initialMs 55_000 —— 错峰硬约束（`(init_new − init_other) mod gcd(P_new, P_other) ≠ 0`）：
  //     静态算既有 42 个周期型 job（`docs/`）⇒ 55_000 **零同余**；
  //     同周期最近邻居 = `tickd-inspect-15m` 110_000，间隔 55 s（> 40 s 间距纪律）。
  //   budgetMs 90_000：一轮 = 每文件一次 `git log`（实测单次 ≈ 30 ms）+ 至多一次送达
  //     （hub push / 外部通道 send 各自 spawnSync 上限 60 s）⇒ 常态 < 3 s。
  //   ⚠️ 必须 `--stop` + `--ensure` 才生效（JOBS 是模块级 const）；**只重启 tickd，不重启 dsh**。
  { id: 'outbox-stale', label: '仓信箱 outbox 超时告警（只读判定 + 只喊the operator · 15 分钟）',
    intervalMs: 15 * MIN, initialMs: 55_000,
    script: path.join(DSH, 'tools', 'mailbox', 'outbox-stale-tick.mjs'),
    args: ['--apply'],
    dir: path.join(DSH, 'tools', 'mailbox'), budgetMs: 90_000 },
  // ── 2026-11-04（协调线 P2「B 路扫描」）：`mainline-scan` ────────────────────────────────
  //   真源 = `docs/` §6.2「新 job 怎么登记」①。
  //   干什么：每 2 分钟扫一遍「本线 sid 集」里的会话日志，把**漏记的轮次**补成 `phase:"scan-fill"`
  //     的一行（`by:"scan"`、行内 `turn := forTurn`、`atTurn` = 该轮 `turn/end.time`），
  //     并落三个新载体：`_cursor-<YYYYMM>.json`（sid 级水位）/ `_rates\<lineId>.json`（漏记率）/
  //     `_suppressed\<lineId>-<YYYYMM>.jsonl`（被抑制的告警计数）。
  //   🔴 `defaultWhenUnset:'off'`（**缺这一格 ⇒ `declaredJobDefault()` 返回 true ⇒ 一进 JOBS 就
  //     自动开跑**，见 `lib\autonomy-modules.mjs` L543-548）。⇒ 新 job 默认关，开 = `job on`；
  //     对端机器不会自动开（`butler-autonomy.json` 不同步）⇒ 每台机各自 `job on` 一次。
  //   ⚠️ **绝对不碰 `WIRE_JOBS`**：那是 `butler-auto-tick.mjs` 的"自主动作"接线表，
  //     J4/J6 断言它的键集与 `WIRE_JOB_KINDS` 一致、源码注释自写"塞进来会红"——而且它本来
  //     就不是自主动作（是记账基础设施）。
  //   ⚠️ 锁：**只登一个代表项**（`lib\butler-locks.mjs` 里 `job:'mainline-scan'`），
  //     `lockRunner: false`（脚本自己在入口抢真锁；见那边的 long comment）。**没有 lockRunner** ⇒
  //     tickd 直接 spawn 脚本，不给包装层。
  //   initialMs 90_000 —— §6.2「CPU 与并发」要求错峰到 90 s（避开 restart/queue/stuck-recovery
  //     这些 `1*MIN` 档）；budgetMs 110_000 = §6.2 的单轮软预算（**tickd 不会来杀它**，
  //     是脚本自己计时、到点停止领新 sid 并记 `scan-budget-exceeded`）。
  //   ⚠️ **必须 `args: ['--apply']`**：`ledger-scan.mjs` 与本线其它器具同款，**默认 dry-run**，
  //     `--apply` 才真写（主账 / `_cursor` / `_rates` / `_suppressed` / `_ops` 心跳全靠它）。
  //     V9 §6.2 的样例把 args 写成 `[]` —— **照抄那一行 = job 每轮只算不写**，而且日志里
  //     "job mainline-scan: ok (810ms)" 看起来完全正常（2026-11-04 01:52 实测踩到：第一轮
  //     零落盘、零心跳）。判据 = `_cursor-<YYYYMM>.json` 出现 + `_ops\_unknown-*.jsonl` 有 `scan-tick`。
  //   ⚠️ 必须 `--stop` + `--ensure` 才生效（JOBS 是模块级 const）；**只重启 tickd，不重启 dsh**。
  { id: 'mainline-scan', label: 'B 路主线流水扫描（补记 scan-fill · 默认关）',
    intervalMs: 2 * MIN, initialMs: 90_000,
    script: 'ledger-scan.mjs', args: ['--apply'], dir: HERE, budgetMs: 110_000,
    defaultWhenUnset: 'off' },
  // ── 2026-11-04（协调线 P3「防偷偷缩目标」）：`mainline-anchor` ─────────────────────────────
  //   真源 = `docs/` §8.3 / §8.4 ③（D-1 由the operator 2026-11-04 01:47 拍「②+③」）。
  //   干什么：每 2 分钟跑一遍 `anchor-watch.mjs` —— ① 现算档 A 名单（在途 ≥1 ∧ 近 7 天有流水）
  //     ② 逐线读 `docs/` 与**上一份快照**比，判「锚被动过」（anchor-shrunk）
  //     ③ 全量锚按 `{line} ∪ aliases` 分组判 anchor-forked ④ 落 `_archive\anchor-snapshots\`（每线留 30 份）
  //     ⑤ 覆盖写 `docs/`（"日报一行"的载体；2 分钟档不会刷屏，因为它是覆盖不是 append）。
  //   ⚠️ 为什么不设 `defaultWhenUnset:'off'`：本件是**纯观察**（只写自己那份快照 + 日报），
  //     与 `mainline-scan`（写主账）不同族 —— 它不上线就没有基线，"锚被动过"永远判不出来
  //     （§8.4 的时效承诺 = 一个 tick 周期）。关它的正规入口 = `job off mainline-anchor`（面板同款）。
  //   ⚠️ 锁：**只登一个代表项**（`lib\butler-locks.mjs` 里 `job:'mainline-anchor'`）；按线的
  //     `mainline-anchor:<lineId>` 是**数据级动态锁**，由脚本自己 `acquireTickLock(…, {env:{}})` 拿，
  //     不进 LOCK_REGISTRY 静态表（同上一条 `mainline-ledger:<lineId>` 的处置，§5.6 同款）。
  //   ⚠️ **绝不进 `WIRE_JOBS`**（`butler-auto-tick.mjs` 的自主动作接线表；J4/J6 会当场判红）。
  //   ⚠️ 必须 `--stop` + `--ensure` 才生效（JOBS 是模块级 const）；**只重启 tickd，不重启 dsh**。
  //   initialMs 150_000 —— 错峰避让 restart/queue/stuck-recovery（1 分钟档）与 mainline-scan（90 s）。
  //   budgetMs 60_000：单轮 = 1 次看板 GET（本地环回 7.8 MB）+ readLedger（实测 ~180 ms）+ 逐线快照写。
  { id: 'mainline-anchor', label: '锚检测（防缩目标 · 三档 + 快照基线 · 只读判定/只写自己快照）',
    intervalMs: 2 * MIN, initialMs: 150_000,
    script: 'anchor-watch.mjs', args: ['--apply'], dir: HERE, budgetMs: 60_000 },
];

// ---------------------------------------------------------------- 工具

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch { /* 已存在 */ } }

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    ensureDir(path.dirname(LOG_FILE));
    const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (st && st.size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, '', 'utf8');
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch { /* 日志失败不影响调度 */ }
  if (process.stdout.isTTY) process.stdout.write(line);
}

function readState() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
  // 【2026-09-14 修复】恢复时清掉"从未真正跑过却带着 lastRunAt"的残留：
  //   busy / locked 分支会写 lastRunAt 当"上次检查时刻"，重启后 lastRunAt 被从磁盘恢复 →
  //   新 job 的首跑被推迟一整个周期（实测 hot 因此白等 30 分钟，看起来像没接线）。
  //   判据 = runs 缺失或为 0（语义：真正执行过才有 runs 计数）。
  //   只在**内存态**清理，不写盘（下次 stampJob 自然覆盖成真实值）。
  try {
    if (st && st.jobs && typeof st.jobs === 'object') {
      for (const [id, j] of Object.entries(st.jobs)) {
        const runs = Number(j?.runs);
        if (j && j.lastRunAt && !(Number.isFinite(runs) && runs > 0)) {
          // 只清 lastRunAt（供 isIntervalDue 用）；lastStatus/lastError 留着，人还能看到"上次被跳过"的原因
          st.jobs[id] = { ...j, lastRunAt: null };
        }
      }
    }
  } catch { /* 清理失败不影响主流程 */ }
  return st;
}

function writeState(patch) {
  ensureDir(STATE_DIR);
  const cur = readState() ?? {};
  const next = { ...cur, ...patch };
  try {
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* 状态写失败不致命 */ }
  return next;
}

/** pid 是否存活（不依赖外部命令：kill(pid,0) 在 Windows 上 node 亦可用）。 */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * 【卡 tickd 止血三件 · 2026-10-30】pid → 进程启动时间（Unix ms）。取不到返回 null。
 *
 * 为什么需要它：判断「锁里那个 pid 是不是**锁主本人**」只靠 `kill(pid,0)` 不够 —— Windows 会复用 pid，
 *   撞上一个不相干的新进程时「pid 存活」并不代表锁主还活着。唯一稳的判据是**进程启动时间**与锁里
 *   `startedAt` 是否吻合（容差 `PID_START_TOLERANCE_MS`）。
 *
 * 取不到（pwsh 不在 / 进程已退 / 超时）⇒ 返回 **null**，调用方必须按「不确定」处理、**不许**据此判死
 *   —— fail-open：宁可留一个活锁，也不许再把活进程判成死的（那正是本卡要根治的病）。
 *
 * 性能：只在「pid 活着但心跳过期」这条罕见分支上被调用；同一 pid 的结果在进程内缓存。
 */
export const PID_START_TOLERANCE_MS = 120_000;

const _procStartCache = new Map();

export function pidStartedAtMs(pid, { cache = true } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (cache && _procStartCache.has(n)) return _procStartCache.get(n);
  let ms = null;
  // 只查**这一个** pid（不用整表 Get-CimInstance：一次枚举几百个进程更慢，也更容易被安全软件拦）。
  // ⚠️ `Get-Process).StartTime` 是 `[System.DateTime]`（本地时区）—— 直接 `[DateTimeOffset](...)` 强转在
  //   本机实测报 `MethodNotFound: ToUnixTimeMilliseconds`（2026-10-30 夹具抓到）；必须 `[DateTimeOffset]::new(...)`。
  const cmd = `[DateTimeOffset]::new((Get-Process -Id ${Math.trunc(n)} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    try {
      const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
      const out = String(r?.stdout ?? '').trim();
      if (/^\d{12,}$/.test(out)) { const v = Number(out); if (Number.isFinite(v) && v > 0) { ms = v; break; } }
    } catch { /* 换下一个解释器；都不行 ⇒ null（fail-open） */ }
  }
  if (cache) _procStartCache.set(n, ms);
  return ms;
}

/**
 * 【卡 tickd 实例唯一性 · 2026-10-22】并发实例判定（纯读，零副作用；供 serve() 启动期守卫用）。
 *
 * 判据刻意保守、**不放宽**：lock 文件里记着 pid + 该 pid **存活** + pid ≠ 自己 ⇒ 判重复。
 *   · pid 已死 / 无 lock / 解析失败 / pid 非法 ⇒ 一律 `duplicate:false`，**交回既有接管行为**
 *     （`acquireLock()` 的陈旧锁清理）。若改成"lock 里有 pid 就一律退出"，崩溃后的 tickd
 *     会永远起不来 —— 这是本判据的红线。
 *   · 只看**存活**、不看心跳新鲜度：心跳过期但 pid 还活着的僵死实例同样会挡住新实例（有意）——
 *     僵死实例仍是实例。
 *   · 【2026-10-30 止血三件 ②】⚠️ 原文「guard 的 `--ensure` 是另一入口（会先删锁再 spawn），
 *     不受本守卫影响」**已作废**：`ensure()` 现在删锁前先调本守卫核锁主（活锁拒删）。
 *   · 【2026-10-30 止血三件 ②'】新增 **pid 撞号** 判据：pid 活着但进程启动时间与锁 `startedAt`
 *     相差 >`PID_START_TOLERANCE_MS` ⇒ 那不是锁主（锁属于另一个已死进程）⇒ 放行，否则锁永远删不掉。
 *     拿不到启动时间 ⇒ 保守判「是锁主」（与旧行为一致）。
 *   · 逃生口：`DSH_TICKD_ALLOW_DUPLICATE=1`（人工排障 / 演练）。
 *
 * @param {{lockFile?:string, selfPid?:number, isAlive?:(pid:number)=>boolean, allow?:boolean}} [opts]
 * @returns {{duplicate:boolean, reason:string, lockPid?:number}}
 */
export function detectDuplicateInstance(opts = {}) {
  const lockFile = opts.lockFile ?? LOCK_FILE;
  const selfPid = Number(opts.selfPid ?? process.pid);
  const isAlive = opts.isAlive ?? isPidAlive;
  const allow = opts.allow ?? process.env.DSH_TICKD_ALLOW_DUPLICATE === '1';
  const startedAtOf = opts.startedAtOf ?? pidStartedAtMs;
  if (allow) return { duplicate: false, reason: 'allow-duplicate' };
  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return { duplicate: false, reason: 'no-lock' }; }
  const lockPid = Number(lock?.pid);
  if (!Number.isFinite(lockPid) || lockPid <= 0) return { duplicate: false, reason: 'bad-lock' };
  if (lockPid === selfPid) return { duplicate: false, reason: 'self-pid', lockPid };
  let alive = false;
  try { alive = isAlive(lockPid) === true; } catch { alive = false; }
  if (!alive) return { duplicate: false, reason: 'dead-pid', lockPid };
  // 【卡 tickd 止血三件 · 2026-10-30 ②'】pid 撞号：pid 活着但启动时间与锁 startedAt 差 >120s
  //   ⇒ 这个 pid 现在是**另一个进程**在用，锁主早死了 ⇒ 不能当"活的锁主"挡人（否则锁永远删不掉、
  //   tickd 再也起不来 = 反向红线）。拿不到启动时间 ⇒ 不放行（保守判 duplicate，与旧行为一致）。
  const lockAt = Date.parse(String(lock?.startedAt ?? ''));
  if (Number.isFinite(lockAt)) {
    let procStart = null;
    try { procStart = startedAtOf(lockPid); } catch { procStart = null; }
    if (Number.isFinite(procStart) && Math.abs(procStart - lockAt) > PID_START_TOLERANCE_MS) {
      return { duplicate: false, reason: 'pid-reused', lockPid, lockStartedAt: lockAt, procStartedAt: procStart };
    }
  }
  return { duplicate: true, reason: 'alive-other', lockPid };
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}

/** 读任意路径的 JSON（夹具注入用；读不到/坏 JSON ⇒ null）。 */
function readJsonAt(file) {
  if (!file || file === LOCK_FILE) return readLock();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 活跃判定：锁文件里那个 pid **是不是锁主本人、还活着**。
 *
 * 【卡 tickd 止血三件 · 2026-10-30】★ 铁律：**心跳过期不得单独判死**（本函数原来的病根）
 *
 *   事故（第三次复发 10-22 / 10-26 / 10-30，真源 `docs/` §4.1）：
 *   老实现先确认「锁里的 pid 明确活着」，紧接着又用「心跳 >180s」把它推翻 ⇒ **活进程被判成死进程**
 *   ⇒ 调用方（`ensure()` / `acquireLock()`）据此删掉活锁 ⇒ 后来的启动者看到 `no-lock` ⇒ 双实例。
 *   两条**正常**路径都会踩：
 *     · 场景 A：新实例从 `acquireLock()` 到第一次写心跳之间有一段窗口（生产实测 ≥5 s），
 *       窗口内 `state.lastLoopAt` 还是**上一个已死进程**的值；
 *     · 场景 B：系统睡眠 163 分钟后唤醒，心跳天然冻结（2026-10-29 那次就是这么复发的）。
 *
 *   现在：pid 活着时，只有「进程启动时间与锁 `startedAt` 对不上 >`PID_START_TOLERANCE_MS`」
 *   （= pid 撞号，锁其实属于另一个已死进程）才算死；心跳只作为**证据**放进返回值（`heartbeat`），
 *   不再单独定生死。取不到启动时间 ⇒ 按活着处理（fail-open）。
 *
 * @param {{now?:number, staleMs?:number, lockFile?:string, stateFile?:string,
 *          isAlive?:(pid:number)=>boolean, startedAtOf?:(pid:number)=>number|null}} [opts]
 * @returns {{running:boolean, reason:string, lock:object|null, beat?:number,
 *          heartbeat?:'fresh'|'stale'|'unknown', lockStartedAt?:number, procStartedAt?:number}}
 */
export function isRunning({ now = Date.now(), staleMs = 180_000, lockFile, stateFile, isAlive, startedAtOf } = {}) {
  const lf = lockFile ?? LOCK_FILE;
  const sf = stateFile ?? STATE_FILE;
  const alive = isAlive ?? isPidAlive;
  const startOf = startedAtOf ?? pidStartedAtMs;
  const lock = readJsonAt(lf);
  if (!lock) return { running: false, reason: 'no-lock', lock: null };
  if (alive(lock.pid) !== true) return { running: false, reason: 'stale-pid', lock };
  const st = (sf === STATE_FILE) ? readState() : readJsonAt(sf);
  const beat = st?.lastLoopAt ? Date.parse(st.lastLoopAt) : Date.parse(lock.startedAt ?? '');
  const heartbeat = !Number.isFinite(beat) ? 'unknown' : (now - beat > staleMs ? 'stale' : 'fresh');
  // 唯一允许判死的 pid 分支：pid 撞号（锁是 old 时间写的，但那个 pid 现在是另一个新进程在用）
  const lockAt = Date.parse(String(lock.startedAt ?? ''));
  let procStart = null;
  if (Number.isFinite(lockAt)) {
    try { procStart = startOf(lock.pid); } catch { procStart = null; }
  }
  if (Number.isFinite(lockAt) && Number.isFinite(procStart)
      && Math.abs(procStart - lockAt) > PID_START_TOLERANCE_MS) {
    return { running: false, reason: 'pid-reused', lock, beat, heartbeat, lockStartedAt: lockAt, procStartedAt: procStart };
  }
  return { running: true, reason: 'alive', lock, beat, heartbeat,
    ...(Number.isFinite(lockAt) ? { lockStartedAt: lockAt } : {}),
    ...(Number.isFinite(procStart) ? { procStartedAt: procStart } : {}) };
}

/**
 * 抢锁（`flag:'wx'` 原子创建）。
 *
 * 【卡 tickd 止血三件 · 2026-10-30 ③】陈旧判定**只认两种**：pid 已死、或 pid 撞号（启动时间对不上）。
 *   「心跳过期」**不再**是删锁理由 —— 老实现在这里靠 `isRunning()` 的 stale-heartbeat 分支，
 *   于是活锁被当成陈旧锁删掉（`ensure()` 里那句无条件 unlink 是同一条事故链的另一环）。判据本体在 `isRunning()`，本函数照抄结论。
 *
 * @param {{lockFile?:string, stateFile?:string, selfPid?:number,
 *          isAlive?:(pid:number)=>boolean, startedAtOf?:(pid:number)=>number|null}} [opts]
 * @returns {{ok:boolean, reason?:string}}
 */
export function acquireLock(opts = {}) {
  const lockFile = opts.lockFile ?? LOCK_FILE;
  const stateFile = opts.stateFile ?? STATE_FILE;
  const selfPid = Number(opts.selfPid ?? process.pid);
  ensureDir(path.dirname(lockFile));
  if (fs.existsSync(lockFile)) {
    const r = isRunning({ lockFile, stateFile, isAlive: opts.isAlive, startedAtOf: opts.startedAtOf });
    if (r.running) return { ok: false, reason: `already running (PID ${r.lock.pid})` };
    // ← 走到这里只剩「pid 死」/「pid 撞号」两种，删旧锁是安全的
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: selfPid, startedAt: new Date().toISOString(), version: TICKD_VERSION }, null, 1), { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `lock busy: ${e?.code ?? e?.message}` };
  }
}

function releaseLock() {
  try {
    const l = readLock();
    if (l && l.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* ignore */ }
}

/**
 * 【T2】冷启动清扫：上一轮 tickd 被 taskkill /F 带走时，正在跑的 job 锁会残留
 * （心跳新鲜 + pid 已死 → 新实例会误判"还活着"而跳过最长一个 TTL）。
 * 这里按 **pid 已死 + TTL 过期 + 建立 ≥120s** 三条件清理，宁可多等一轮也不误抢新锁。
 */
function sweepDeadLocks(staleMs = 120_000) {
  try {
    const r = sweepStaleTickLocks({ home: dshHome(), staleMs, isAlive: isPidAlive });
    if (r.removed.length) log(`T2 冷启动清扫：清理陈旧 tick 锁 ${r.removed.join(', ')}`);
    return r;
  } catch (e) {
    log(`T2 冷启动清扫失败（不致命）：${e?.message ?? e}`);
    return { removed: [], kept: [] };
  }
}

// ---------------------------------------------------------------- 纯调度逻辑（可单测）

/** 'HH:MM' → {h, m}；非法返回 null。 */
export function parseHhMm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

/** 本地日的 'YYYY-MM-DD' 与 'YYYY-Www' 与周几（1=周一）。 */
export function localDayInfo(now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  // ISO 周号
  const t = new Date(Date.UTC(y, d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fdayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdayNum + 3);
  const week = 1 + Math.round((t - firstThursday) / (7 * 86400_000));
  return { day: `${y}-${mm}-${dd}`, week: `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, dow, hhmm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, h: d.getHours(), mi: d.getMinutes() };
}

/** 星期令牌（1=周一 → 'MON'）。'MON'..'SUN' 与 localDayInfo().dow 一一对应。 */
export const DOW_TOKENS = Object.freeze(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);

/** dow(1=周一) → 'MON'。越界返回 null（不外抛，纯判定不炸调度）。 */
export function dowToken(dow) {
  const n = Number(dow);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? DOW_TOKENS[n - 1] : null;
}

/**
 * 【卡「冷盘窗」2026-09-20】时段窗判定（纯函数，**只读**，不进任何状态）。
 *
 * 语义：`window:{from:'HH:MM', to:'HH:MM'}` —— 当前**本地时刻**落在 [from, to]（闭区间）内才算"在窗内"。
 *   比较走 `localDayInfo().hhmm` 的 'HH:MM' 字面量（两位补零 ⇒ 字典序 == 时间序），
 *   与既有 `parseHhMm` 的判定口径同源，不引 UTC、不用 Date 比较。
 *   半截坏值（缺 from/to、解析不出）→ **判"在窗内"**（fail-open）：
 *   宁可让 job 照旧跑（坏配置表现为"窗口没生效"，人能看见 job 在跑），
 *   也不要因为一个错字把 job 永久静默关死（后者没有任何可见出口）。
 * @param {{window?:{from?:string,to?:string}}} job
 * @param {{hhmm:string}} info localDayInfo() 结果
 */
export function isWithinWindow(job, info) {
  const w = job?.window;
  if (!w || typeof w !== 'object') return true;
  const from = parseHhMm(w.from);
  const to = parseHhMm(w.to);
  if (!from || !to) return true; // fail-open（见上）
  const hhmm = String(info?.hhmm ?? '');
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return true;
  return hhmm >= String(w.from).trim() && hhmm <= String(w.to).trim();
}

/**
 * 取 job 声明的星期集合（`days` 字段）→ Set<'MON'..'SUN'>；未声明 / 非法 → null。
 *
 * 【卡「冷盘窗」2026-09-20】`days` 只在**日历型 + at 为 'HH:MM'** 时有意义（周频自带星期，见 isCalendarDue）。
 *   `days:[]`（空数组）是**非法声明** ⇒ 返回 null（按"未声明"处理），否则会得到一个"永不命中"的
 *   静默死 job —— 那属于写错了该当场看见，而不是表现成"这 job 从此不跑"。
 */
export function parseDays(job) {
  const d = job?.days;
  if (!Array.isArray(d) || d.length === 0) return null;
  const out = new Set();
  for (const t of d) {
    const s = String(t ?? '').trim().toUpperCase();
    if (!DOW_TOKENS.includes(s)) return null;
    out.add(s);
  }
  return out;
}

/**
 * 日历型任务是否到期（daily / weekly / 多星期窗）。
 *
 * 【卡「冷盘窗」2026-09-20】新增两条判定，**未声明新字段的 job 逐字节保持原行为**：
 *   ① `days`（多星期窗）：命中集合外的日子 → 直接 false，且**不写 lastDay**
 *      （runJob 只在真正跑完后写 lastDay；这里 return false ⇒ 本 tick 不产生任何状态写入）。
 *      ⚠️ 多星期 job 必须按 **lastDay** 去重，不能按 lastWeek —— 否则周一跑过会把周二~周五全挡掉。
 *      ⚠️ 与周频的优先级：`days` 命中时**覆盖** at 里的星期令牌（`days` 是更显式的声明）；
 *      at 里的令牌仍作为"该 job 是周频"的载体（决定 lastWeek 还是 lastDay 去重）。
 *   ② `window`（时段窗）：窗外的每一 tick 都**不算到期** ⇒ 不跑、不推进 lastRunAt，
 *      窗口一开就按正常间隔补跑（口径见文件头 JOBS 注释）。
 *
 * @param {{at?:string, days?:string[], window?:object}} job
 * @param {object} jobState 该 job 的运行状态（lastDay / lastWeek）
 * @param {number} now
 */
export function isCalendarDue(job, jobState, now) {
  if (!job.at) return false;
  const parts = String(job.at).trim().split(/\s+/);
  const wantDow = parts.length > 1 ? parts[0].toUpperCase() : null; // 'MON'
  const hm = parseHhMm(parts.length > 1 ? parts[1] : parts[0]);
  if (!hm) return false;
  const info = localDayInfo(now);
  if (!isWithinWindow(job, info)) return false;
  const daysSet = wantDow ? null : parseDays(job);
  if (wantDow || daysSet) {
    // 命中集合：days 显式声明优先；否则 = at 里的单个令牌；都没有 = 每日（走下面的日频分支）
    const hitToday = daysSet ? daysSet.has(dowToken(info.dow)) : (wantDow === dowToken(info.dow));
    if (!hitToday) return false;                       // 非命中日：不跑、不写 lastDay
    if (wantDow && jobState?.lastWeek === info.week) return false;
    if (!wantDow && jobState?.lastDay === info.day) return false;
    return info.h > hm.h || (info.h === hm.h && info.mi >= hm.m);
  }
  if (jobState?.lastDay === info.day) return false;
  return info.h > hm.h || (info.h === hm.h && info.mi >= hm.m);
}

/**
 * 【2026-09-16 拷问 1.5】日历型 job 的「该跑没跑」判定（纯函数）。
 *
 * 为什么需要（现场实证）：`rollback-offsite`（每日 03:30）在 <host> 侧 `lastDay=2026-09-14`、
 *   **两天没跑**，而 `lastStatus` 仍是 `ok`、`failures=0` ⇒ 健康判据只看 `failures`，
 *   于是**所有 cron 型 job 在停机窗口 / 停摆期都会永久静默变绿**（日报照写「✅ 最近一次打包成功」）。
 *
 * 判据（保守：只认"该跑的时刻确实已经过去"，绝不提前报）：
 *   · 日频 `at:'HH:MM'`：应跑日 = 今天（本地时间已过 HH:MM）否则昨天；`lastDay` 早于应跑日 → 落后 N 天。
 *   · 多星期（【新 · 卡「冷盘窗」2026-09-20】`at:'HH:MM' + days:[…]`）：从今天开始**往前找最近一个命中日**
 *     （今天命中但未到 HH:MM 时，算到昨天为止）；`lastDay` 早于该日 → 落后。
 *     ⚠️ **非命中日（如周末）默认就不报落后** —— 否则日报会在每个周末固定报红一次
 *     （"该跑没跑"是给"本该跑的日期"用的判据，不是"每天必须有一次"）。
 *     ⚠️ 回看上限 14 天（防坏配置造成死循环；超过上限按"无应跑日"从宽不报）。
 *   · 周频 `at:'MON HH:MM'`：用 `lastEndAt` 的时间差判（`lastWeek` 只有周号，回推要另写一套 ISO 周算法，
 *     不划算——周频 job 只有 weekly / imagegen-full 两个）。
 *   · 缺 `lastDay`（旧 state 从未写过该字段）：用 `lastEndAt` 兜底（超 26h 视为落后一天）。
 *   · 从未跑过（无 `lastEndAt` 也无 `lastDay`）→ **不判**（"未运行过"另有一条判据，别重复报）。
 *   · 被开关关掉的 job 由**调用方**据 `state.blockedJobs` 排除（故意不跑 ≠ 该跑没跑）。
 * @returns {{kind:'daily'|'weekly', lagDays:number, dueDay:string|null, lastDay:string|null, sinceLastMs:number|null, reason:string}|null}
 */
export function calendarLag(job, jobState, now = Date.now()) {
  if (!job?.at) return null;
  const parts = String(job.at).trim().split(/\s+/);
  const weekly = parts.length > 1;
  const hm = parseHhMm(weekly ? parts[1] : parts[0]);
  if (!hm) return null;
  const s = jobState ?? null;
  const DAY = 86400_000;
  const lastEndMs = Date.parse(String(s?.lastEndAt ?? ''));

  if (weekly) {
    if (!Number.isFinite(lastEndMs)) return null;
    const overdueMs = now - lastEndMs - 7 * DAY;
    if (overdueMs <= 0) return null;
    return {
      kind: 'weekly', lagDays: Math.floor(overdueMs / DAY) + 1, dueDay: null, lastDay: s?.lastWeek ?? null,
      sinceLastMs: now - lastEndMs,
      reason: `周频 job 距上次成功结束已 ${Math.floor((now - lastEndMs) / DAY)} 天（超过 7 天周期）`,
    };
  }

  const info = localDayInfo(now);
  // 【卡「冷盘窗」2026-09-20】应跑日 = "从今天往回找最近一个**该跑且已到点**的日期"。
  //   多星期 job：今天命中但还没到 HH:MM → 从昨天起往回找（周一 09:00 时，上周五跑过 ⇒ 应跑日还是上周五 ⇒ 不落后）；
  //              今天不命中（周末）→ 从昨天起往回找（周六 10:00 ⇒ 应跑日 = 周五 ⇒ 周五跑过则不落后，**周末不报红**）。
  //   日频 job（无 days）：退化为"今天到点则今天，否则昨天"——与改动前逐字节一致。
  const daysSet = parseDays(job);
  const dueToday = info.h > hm.h || (info.h === hm.h && info.mi >= hm.m);
  let dueDay = info.day;
  let hops = 0;
  while (hops < 14) {
    // 往回 hops 天的 dow 纯算术推导（不构造 Date ⇒ 不依赖任何解析口径，也不受本地时区影响）
    const dowBack = ((info.dow - 1 - hops) % 7 + 7) % 7 + 1;
    const hit = daysSet ? daysSet.has(dowToken(dowBack)) : true;
    if (hit && (hops > 0 || dueToday)) break;
    dueDay = shiftDayKey(dueDay, -1);
    hops += 1;
  }
  if (hops >= 14) dueDay = null;   // 配置异常（如 days 里全是非法令牌被过滤）→ 从宽不报，绝不误报红
  const lastDay = s?.lastDay ?? null;
  if (!lastDay) {
    if (!Number.isFinite(lastEndMs)) return null;
    const overdueMs = now - lastEndMs - 26 * 3600_000;
    if (overdueMs <= 0) return null;
    return {
      kind: 'daily', lagDays: Math.floor(overdueMs / DAY) + 1, dueDay, lastDay: null,
      sinceLastMs: now - lastEndMs,
      reason: `状态里没有 lastDay；上次结束于 ${Math.round((now - lastEndMs) / 3600_000)} 小时前（应跑日 ${dueDay}）`,
    };
  }
  if (!dueDay) return null;
  const lagDays = dayKeyDiff(dueDay, lastDay);
  if (!(lagDays > 0)) return null;
  return {
    kind: 'daily', lagDays, dueDay, lastDay,
    sinceLastMs: Number.isFinite(lastEndMs) ? now - lastEndMs : null,
    reason: `应跑日 ${dueDay} 未跑（lastDay=${lastDay}，落后 ${lagDays} 天）`,
  };
}

/** 日期键平移（'YYYY-MM-DD' 按天加减；只做日期算术，走 UTC 以免夏令时/时区抖动）。 */
export function shiftDayKey(day, deltaDays) {
  const [y, m, d] = String(day).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86400_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** 两个日期键相差的天数（a - b）。 */
export function dayKeyDiff(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 86400_000);
}

/** 间隔型任务是否到期。 */
export function isIntervalDue(job, jobState, now, startedAt) {
  // 【卡「冷盘窗」2026-09-20】时段窗：窗外**不算到期** ⇒ 不跑、**不推进 lastRunAt**
  //   （lastRunAt 只在 runJob 收尾时写）。窗口一开，`now - last >= intervalMs` 立刻成立 ⇒ 补跑一次。
  if (!isWithinWindow(job, localDayInfo(now))) return false;
  const last = jobState?.lastRunAt ? Date.parse(jobState.lastRunAt) : 0;
  // 「从未真正跑过」的判据是 **runs**，不是 lastRunAt（2026-09-14 实测的调度漏洞）：
  //   busy / locked / 开关拦下 这些"检查过但没执行"的分支也会写 lastRunAt，
  //   于是 job 一旦被跳过就凭空消耗掉一个周期。对**新加进来的 job** 尤其致命——
  //   实测：hot 在 21:29 被 busy 跳过 → 重启 tickd 后 lastRunAt=21:29 被从 state.json 恢复 →
  //   首跑被推到 21:59（白等一个 30 分钟周期），看起来像"热采没接线"。
  //   口径：runs 缺失或为 0 ⇒ 还没真正跑过 ⇒ 走首次分支（initialMs）。
  const runs = Number(jobState?.runs);
  if (!last || !(Number.isFinite(runs) && runs > 0)) return now - startedAt >= (job.initialMs ?? 0);
  return now - last >= job.intervalMs;
}

/**
 * 残留 running 的判定阈值（纯函数）：max(注册表 ttlMs, 2×intervalMs, 15min)。
 * 与卡 4a12fc8c「建议修法 1」逐字一致；未知 job 走 deriveTtlMs 的兜底。
 */
export function staleRunningThresholdMs(job) {
  let ttl = STALE_RUNNING_MIN_MS;
  try { ttl = Number(deriveTtlMs(job?.id)) || STALE_RUNNING_MIN_MS; } catch { /* 未知 job：用下限 */ }
  const iv = Number(job?.intervalMs ?? 0);
  return Math.max(Number.isFinite(ttl) ? ttl : 0, 2 * (Number.isFinite(iv) ? iv : 0), STALE_RUNNING_MIN_MS);
}

/**
 * 是否为「残留的 running 标记」（纯函数）。
 *
 * 判据优先级（顺序即优先级）：
 *   ① 本进程有活 child → **绝不是残留**（唯一权威反例口径，卡要求"真在跑不许被误清"）；
 *   ② state.pid ≠ 当前 tickd pid → 上一进程实例留下的标记（其 child 已随旧进程消亡）
 *      → 立即判残留、不必等阈值：这正是「冷启动清扫」（修法 2）要的语义；
 *   ③ 否则按时间：lastStartAt（缺失退 lastRunAt）距 now 超阈值 → 残留；
 *      两者都不可解析（脏写/残缺）→ **不判**（与"真在跑"同侧保守，宁可多等一轮）。
 */
export function isStaleRunning(job, jobState, now, { localRunning = false, tickdPid = null, statePid = null } = {}) {
  if (jobState?.running !== true) return false;
  if (localRunning) return false;
  if (Number.isFinite(tickdPid) && Number.isFinite(statePid) && tickdPid !== statePid) return true;
  const since = Date.parse(String(jobState.lastStartAt ?? jobState.lastRunAt ?? ''));
  if (!Number.isFinite(since)) return false;
  return now - since > staleRunningThresholdMs(job);
}

/**
 * 【卡「冷盘窗」2026-09-20】调度表 → 人读摘要（`--status` / `--list` / 日报 tickd 健康段共用）。
 * 为什么要抽出来：加了 `days` / `window` 之后，只打 `at` 或只打 `60m` 会把"什么时候真会跑"藏掉
 *   —— 尤其"60m + 窗 08:30-18:00"这种形态，只看到 `60m` 的人会以为它整夜都在跑。
 * 形态（**只此一处实现**，消费方别再自己拼字符串）：
 *   · 日频          '09:00'
 *   · 周频          'MON 09:05'
 *   · 多星期窗      '08:45 · 工作日(MON,TUE,WED,THU,FRI)'
 *   · 间隔          '60m' / '60m · 窗 08:30-18:00'
 *   · 纯天数（无 at，理论上不该出现）'每天/… · 窗 …'
 */
export function describeSchedule(job) {
  let base = job?.at ? String(job.at) : `${Math.round(Number(job?.intervalMs ?? 0) / 60000)}m`;
  const ds = parseDays(job);
  if (ds) {
    const wd = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
    const isWeekday = ds.size === 5 && wd.every((t) => ds.has(t));
    base += ` · ${isWeekday ? '工作日' : '每周'}(${[...ds].join(',')})`;
  }
  const w = job?.window;
  if (w && typeof w === 'object' && parseHhMm(w.from) && parseHhMm(w.to)) base += ` · 窗 ${w.from}-${w.to}`;
  return base;
}

/** 挑出本轮要跑的 job（纯函数，供单测）。
 *  @param {{localRunning?:Set<string>|null, gateOf?:(id:string)=>{enabled:boolean}}} [opts]
 *    gateOf：job 级开关判定（2026-09-13 卡②）。**不传 = 现状**（只看 `j.enabled !== false`）。 */
export function pickDue(jobs, states, now, startedAt, { localRunning = null, gateOf = null } = {}) {
  const out = [];
  for (const j of jobs) {
    const s = states?.[j.id];
    if (j.enabled === false) continue;
    // 活开关：模块级总闸 ∪ 单 job 开关（每轮现读，见 resolveJobGates）
    if (gateOf && gateOf(j.id)?.enabled !== true) continue;
    // 上一轮还没跑完 → 跳过，不叠；但**残留**标记视为"没在跑"照常入队（修法 1，pid 分支在 sweep 里）
    if (s?.running && !isStaleRunning(j, s, now, { localRunning: localRunning?.has?.(j.id) === true })) continue;
    if (j.at) { if (isCalendarDue(j, s, now)) out.push(j); }
    else if (isIntervalDue(j, s, now, startedAt)) out.push(j);
  }
  return out;
}

/**
 * 【2026-09-13 卡②】解析本轮每个 job 的开关（模块级总闸 × 单 job 开关）。
 * 口径：
 *   · 源码 `j.enabled === false` = 硬禁用（开发期用，现状保留），开关**打不开**它（只能关更多）；
 *   · `modules['tickd-jobs'].enabled === false` → 全部 job 停（进程仍在跑 loop、心跳照写 = drain 语义）；
 *   · `jobs.<id>.enabled === false` → 只停这一个；
 *   · 配置读不到 → **保持现状**（基础设施类 fail-safe，见 lib/autonomy-modules.mjs 头部）。
 * @param {Array} jobs
 * @param {{home?:string}} [opts]
 */
export function resolveJobGates(jobs = JOBS, opts = {}) {
  const mod = isModuleEnabled('tickd-jobs', opts);
  const jobSwitches = readJobSwitches(opts);
  const gates = {};
  for (const j of jobs) {
    const hardDisabled = j.enabled === false;
    // 【H4b · 2026-09-21】「缺覆盖项时的默认值」改由 JOBS 条目**声明**（declaredJobDefault）：
    //   · 未声明 defaultWhenUnset → 返回 true（`!hardDisabled` 的既有语义，逐字节不变）；
    //   · 声明 defaultWhenUnset:'off' → 缺键即关（**只对本 job 生效**，全局默认语义零改动），
    //     但仍可被 `job on <id>` 打开（有覆盖项就走 file 分支）。
    //   为什么不直接写 defaultEnabled:false：那等于把所有 job（imagegen / rollback-offsite /
    //   card-watchdog …）一起改成缺键默认关 —— 越权改全局语义（本卡红线）。
    const defaultEnabled = declaredJobDefault(j);
    const one = isTickJobEnabled(j.id, { ...opts, jobSwitches, defaultEnabled });
    const moduleOn = mod.enabled === true;
    const enabled = moduleOn && one.enabled === true && !hardDisabled;
    const reasons = [];
    if (hardDisabled) reasons.push('源码 j.enabled=false');
    if (!moduleOn) reasons.push(`L2 模块关 tickd-jobs（${mod.source}）`);
    if (!one.enabled) reasons.push(`job 开关关（${one.source}${one.why ? `: ${one.why}` : ''}）`);
    gates[j.id] = {
      id: j.id, enabled, moduleEnabled: moduleOn, moduleSource: mod.source,
      jobEnabled: one.enabled, jobSource: one.source, defaultWhenUnset: j.defaultWhenUnset ?? null,
      by: one.by ?? null, why: one.why ?? null, since: one.since ?? null,
      reason: reasons.join(' + ') || 'ok',
    };
  }
  return { ok: mod.known === true, module: mod, jobSwitchesOk: jobSwitches.ok, jobSwitchesReason: jobSwitches.reason, gates };
}

// ---------------------------------------------------------------- 执行

function stampJob(state, jobId, patch) {
  const jobs = { ...(state.jobs ?? {}) };
  jobs[jobId] = { ...(jobs[jobId] ?? {}), ...patch };
  return writeState({ jobs });
}

/**
 * 【T2（§17.1）】调度器侧持真实 tick 锁 → 同一 job 只有一个实例，且**跨入口**生效
 * （另一套入口 = 旧 Windows 计划任务启同名短命脚本；两套入口靠同一把 `tick-<锁名>.lock` 互斥）。
 * 抢不到 = 别的入口/别的实例在跑 → 本轮跳过，记 lastStatus='locked'，不排队不叠加。
 * @param {object} job
 * @returns {{ok:boolean, lock?:object, reason?:string}}
 */
function acquireJobLock(job) {
  const lockName = lockNameFor(job.id);
  const ttlMs = deriveTtlMs(job.id);
  const home = jobHome(job);
  try {
    const lock = acquireTickLock(lockName, { ttlMs, home });
    if (!lock.ok) return { ok: false, reason: lock.reason ?? 'held' };
    return { ok: true, lock, lockName, ttlMs };
  } catch (e) {
    return { ok: false, reason: `lock-error:${e?.code ?? e?.message ?? 'unknown'}` };
  }
}

/** 子进程要用的 home（panel 系列脚本按 USERPROFILE 解析，统一走 dshHome 不影响它们）。 */
function jobHome(job) {
  try { return dshHome(); } catch { return undefined; }
}

/**
 * 【卡 AT19】该退出码是否属于 job **显式声明**的"让路 / 未完成"语义（见 JOBS.hot.benignExitCodes）。
 *
 * 语义分层（**不是"永远绿"**）：只有注册表里写了 `benignExitCodes` 的 job、且退出的正是表里那些码，
 * 才按"让路/未完成"处理（lastStatus='deferred'、failures 不涨）；其余任何非 0 码——包括
 * **同一个 job 的其他退出码**（如 hot 的 exit 1 = 采集真失败）与 spawn 异常——照旧计 failures
 * 并在日报「⏱ tick 调度健康」报红。反向锚见 `_test/test-tickd-benign-exit.mjs`。
 *
 * @param {{benignExitCodes?:number[]}} job
 * @param {number} code 子进程退出码
 * @returns {boolean}
 */
export function isBenignExit(job, code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return false;
  const codes = Array.isArray(job?.benignExitCodes) ? job.benignExitCodes : [];
  return codes.some((c) => Number(c) === n);
}

/** 让路退出码的 lastError 文案（把"为什么不算失败"写进状态文件，排障时不必翻代码）。 */
export function benignExitError(job, code) {
  return `exit code ${code}（让路/未完成：${job?.benignExitLabel ?? '非故障'}，不计失败）`;
}

function runJob(job, now) {
  const t0 = now;
  let state = readState() ?? {};

  // ---- T2 ①：调度器抢真实锁（跨入口单例；抢不到跳过）
  const got = acquireJobLock(job);
  if (!got.ok) {
    stampJob(state, job.id, { running: false, lastStatus: 'locked', lastError: `lock held by another entry (${got.reason})`, lastLockName: lockNameFor(job.id) });
    log(`job ${job.id}: 跳过 —— 锁被占用（${got.reason}）`);
    return null;
  }

  // ---- T2 ②：交接窗口内 restart 必须回 busy、不得拉起 DSH（§17.1 T2）
  //   ⚠️ **只对 restart 做这层判定**（2026-09-14 实测死锁）：hot job 与交接器**共用** tick-handoff.lock，
  //      tickd 自己抢到它之后，detectHandoffWindow 会把**本进程刚写的锁**读成"交接进行中"
  //      → 每轮 hot 都 busy 退出、热采永远不跑（实测日志：`pid=21412 剩余 2700s`，21412 就是 tickd 自己）。
  //      对 hot 而言这层判定**本来就是冗余**：真·交接（手工/钩子跑 handoff.mjs）持有同一把锁时，
  //      tickd 的 acquireJobLock 已经抢不到锁并在上面提前 return 了，根本走不到这里。
  //      故 hot 的"让路"由**锁本身**保证，restart（另一把锁）才需要显式窗口判定。
  let handoff = null;
  if (mustYieldInHandoff(job.id) && job.id !== 'hot') {
    handoff = detectHandoffWindow({ home: jobHome(job) });
    if (handoff.active) {
      const reason = `handoff-window:${handoff.reason}`;
      got.lock.release();
      stampJob(readState() ?? {}, job.id, {
        running: false, lastStatus: 'busy', lastError: reason, lastHandoffWindow: handoff,
        lastRunAt: new Date().toISOString(),
      });
      log(`job ${job.id}: busy —— ${reason}（交接窗口内让路：不发起重启 / 不抢交接锁）`);
      return null;
    }
  }

  // 【卡 S5·T2b】脚本自身无锁的 job 经**包装层** spawn（由注册表 lockRunner 字段决定）。
  //   与 tickd 抢的是**同一把** tick 锁：tickd 已持锁并注入 DSH_BUTLER_TICK_LOCK_HELD ⇒ 包装层
  //   走 store 的 T2「锁继承 → 内存虚拟锁」（零 I/O、不双层互斥打架，既有口径）；
  //   而**独立入口**（计划任务 / 手动直跑包装层）没有继承标记 → 抢真锁 ⇒ 跨入口互斥才真正成立。
  //   ⚠️ 包装层要**绝对路径**：它靠摆 process.argv[1] 让目标脚本的 isMainEntry 守卫命中，
  //      相对路径会按包装层自己的 cwd 解析（未必等于 job.dir）—— 这里按本文件同款口径先解析。
  const viaRunner = usesLockRunner(job.id);
  const scriptAbs = viaRunner ? path.resolve(job.dir ?? HERE, job.script) : job.script;
  const spawnArgv = viaRunner
    ? [TICK_JOB_RUNNER, '--job', job.id, '--script', scriptAbs, ...(job.args ?? [])]
    : [job.script, ...(job.args ?? [])];
  // lastVia：state.json 里能直接看出这个 job 本轮走的是哪条入口（验收 / 排障用）
  stampJob(state, job.id, { running: true, lastStartAt: new Date(now).toISOString(), lastLockName: got.lockName, ttlMs: got.ttlMs,
    lastVia: viaRunner ? 'tick-job-runner' : 'direct' });
  let child;
  // 【卡 冲刺600·tickd失败留痕】输出尾部捕获器（stdout/stderr 各一个）：内存上限恒定
  //   （默认每流 64 KB，只保留尾部），不落盘、不做 I/O —— 见 lib\tickd-fail-trace.mjs 头注释。
  const capOut = new TailBuffer(TRACE_CFG.captureBytes);
  const capErr = new TailBuffer(TRACE_CFG.captureBytes);
  try {
    child = spawn(NODE_EXE, spawnArgv, {
      cwd: job.dir ?? HERE, windowsHide: true,
      // 【卡 冲刺600·tickd失败留痕】stdio 由 `'ignore'` 改 `'pipe'` —— 非 0 退出时要能留痕。
      //   ⚠️ 改 pipe 的**充分必要条件 = 立刻并发读取**（见下面两行 attachTail）：不读 ⇒ 管道缓冲
      //     写满 ⇒ 子进程阻塞在 write 上永不退出 ⇒ `exit` 回调不触发 ⇒ job 永远 running=true、
      //     锁不释放 ⇒ **静默停摆**（比丢日志严重得多）。实测对照（本卡证据）：
      //     `_test/test-tickd-fail-trace.mjs` ⑥ 段 —— 同一个往两流各写 4 MB 的脚本，
      //     不挂读取 ⇒ 3s 后仍未退出；挂读取 ⇒ 正常 exit 1 且尾部完整。
      stdio: ['ignore', 'pipe', 'pipe'], detached: false,
      // T2 ③：把"父调度器已持锁"透给子脚本 → store.acquireTickLock 返回虚拟锁，
      //        绝不出现"父持锁 + 子抢同一把锁失败"的双层互斥打架。
      env: { ...process.env, DSH_BUTLER_TICK_LOCK_HELD: got.lockName, DSH_BUTLER_TICKD_PID: String(process.pid) },
    });
    // ⚠️ 必须与 spawn 在**同一个 tick 内同步**挂上（事件驱动、不 await、不阻塞）—— 这就是"并发读取"。
    //   attachTail 内部吞掉流错误：留痕链路的任何异常都不许把常驻 tickd 带崩。
    attachTail(child.stdout, capOut);
    attachTail(child.stderr, capErr);
  } catch (e) {
    log(`job ${job.id}: spawn 失败 ${e?.message ?? e}`);
    try { got.lock.release(); } catch { /* ignore */ }
    stampJob(readState() ?? {}, job.id, { running: false, lastStatus: 'spawn-error', lastError: String(e?.message ?? e).slice(0, 300), lastEndAt: new Date().toISOString() });
    return null;
  }

  // 【卡 4a12fc8c】登记"本进程真在跑这个 job"——stale 判定的权威反例依据（见 activeChildren）
  trackChild(job.id, child);

  // T2 ④：长任务续租，避免"仍在跑但 TTL 到期 → 被下一个实例抢走"（只在退出时停）
  const renewMs = Math.max(30_000, Math.floor(got.ttlMs / 3));
  const renewTimer = setInterval(() => {
    try { renewTickLock(got.lock.lockPath, { ttlMs: got.ttlMs }); } catch { /* 续租失败不致命 */ }
  }, renewMs);
  if (typeof renewTimer.unref === 'function') renewTimer.unref();

  const finish = () => {
    clearInterval(renewTimer);
    untrackChild(job.id, child);          // 收尾即"本进程不再跑它"（error/exit 两条路都经过这里）
    try { got.lock.release(); } catch { /* ignore */ }
  };

  child.on('error', (e) => {
    log(`job ${job.id}: 子进程错误 ${e?.message ?? e}`);
    finish();
    const endAt = new Date().toISOString();
    const cur = readState() ?? {};
    stampJob(cur, job.id, { running: false, lastRunAt: endAt, lastEndAt: endAt, lastStatus: 'error', lastError: String(e?.message ?? e).slice(0, 300), failures: (cur.jobs?.[job.id]?.failures ?? 0) + 1 });
  });
  child.on('exit', (code) => {
    finish();
    const endAt = new Date().toISOString();
    // 【冲刺600 · 批4-3 可观测性收口】耗时只测一次：既有 `lastDurationMs` 与新增的观测摘要/预算判定
    //   **同一口径**（= 调度器拍板时刻 → 子进程 exit 时刻，含锁/交接窗口判定与 spawn 开销）。
    const durationMs = Date.now() - t0;
    const cur = readState() ?? {};
    const prev = cur.jobs?.[job.id] ?? {};
    const info = localDayInfo(Date.now());
    // 【卡 AT19】让路退出码（`benignExitCodes`，当前仅 hot 声明）：记 'deferred'、**不涨 failures**，
    //   并记连续次数（tickd-health 连续 ≥N 次时给 🟡 —— 让路不是故障，但"一直没完成"要看得见）。
    const benign = isBenignExit(job, code);
    const patch = {
      running: false,
      lastEndAt: endAt,
      // ⚠️ lastRunAt 是 isIntervalDue 的判据，必须写 —— 漏写会让 last=0 永远走"首次分支"，
      //    变成每轮都触发（2026-09-11 实测：restart 5 分钟跑了 19 次）。
      lastRunAt: endAt,
      lastStatus: code === 0 ? 'ok' : (benign ? 'deferred' : `exit-${code}`),
      lastExitCode: code,
      lastDurationMs: durationMs,
      // 【批4-3】耗时摘要（last/ewma/max/count）——落**既有** state.json 的 `jobs.<id>` 段，
      //   不新建第二套状态文件（口径：观测数据跟 job 状态同源同生命周期）。
      durationSummary: durationSummary(prev.durationSummary, durationMs, endAt),
      runs: (prev.runs ?? 0) + 1,
      failures: (prev.failures ?? 0) + (code === 0 || benign ? 0 : 1),
      lastError: code === 0 ? null : (benign ? benignExitError(job, code) : `exit code ${code}`),
    };
    // ── 【卡 冲刺600·tickd失败留痕】非 0 退出 ⇒ 子进程输出尾部落盘（**纯增量，判定语义不变**）──
    //   ① 上面 patch 的 lastStatus / lastExitCode / failures / lastError 全部**原样不动**；
    //   ② 只有非 0 才写文件（0 退出不写 —— 反向锚：`_test/test-tickd-fail-trace.mjs` ② 段）；
    //   ③ benign（让路）同样留痕：让路也是非 0 退出，它的输出同样可能带诊断信息；文案仍走 benignExitError；
    //   ④ 写盘/轮转的任何异常都在 lib 内被吞成 `ok:false`，**绝不影响结算**（留痕是诊断附属品）；
    //   ⑤ lastError 只在真失败时追加**第二行**摘要（首行 `exit code N` 保持不变 ⇒ 既有消费面
    //      「取 lastError 首行」的地方，如 tickd-health / 日报段，行为一字不变）。
    const trace = shouldTraceExit(code)
      ? writeExitTrace({
        jobId: job.id, label: job.label ?? null, code, status: patch.lastStatus, benign,
        durationMs, via: viaRunner ? 'tick-job-runner' : 'direct', pid: child.pid ?? null,
        startedAt: new Date(t0).toISOString(), at: endAt,
        stdoutTail: capOut, stderrTail: capErr, dir: TRACE_DIR,
        tailBytes: TRACE_CFG.tailBytes, maxFiles: TRACE_CFG.maxFiles,
      })
      : null;
    const traceLine = traceSummaryLine(trace);
    // ⚠️ 只对**真失败**追加 lastError 第二行：benign 的 lastError 文案（benignExitError，含"不计失败"）
    //   是既有消费面（单测 test-tickd-benign-exit.mjs 断言 /不计失败/），一字不动。
    if (traceLine && !benign) patch.lastError = `${patch.lastError}\n${traceLine}`;
    if (benign) {
      patch.benignExits = (prev.benignExits ?? 0) + 1;
      patch.consecutiveBenign = (prev.consecutiveBenign ?? 0) + 1;
      patch.lastBenignAt = endAt;
    } else {
      // 真失败或 ok：连续让路链断开（health 的"连续让路"提示据此归零）
      patch.consecutiveBenign = 0;
    }
    if (job.at) {
      if (String(job.at).includes(' ')) patch.lastWeek = info.week;
      else patch.lastDay = info.day;
    }

    // ── 【冲刺600 · 批4-3】观测层：耗时预算判定 + 越界记录（**只加观测，不改业务行为**）──────
    //   ★ 行为红线（本卡唯一允许的写入面 = 状态/日志/告警）：
    //     本段绝不碰 `job.intervalMs` / 开关 / job 参数 / 调度顺序 —— **没有**"超预算就降频/降档/
    //     跳 job"这类分支。越界只做三件"看得见"的事：① 落 state（`budget` + `durationSummary`）
    //     ② tickd 日志一行 ③ `~/.dsh/butler-alert.log`（info 级 + 30 分钟冷却，防"只记录"退化成刷屏）。
    //     反向锚：`_test/test-tickd-metrics.mjs` 断言超预算前后 intervalMs / 开关文件 / job 注册表零变化。
    const verdict = judgeBudget(job, durationMs);
    const ledger = budgetLedger(prev.budget, verdict, endAt, durationMs);
    const alertNow = verdict.exceeded && shouldAlertBudget(prev.budget, Date.now());
    if (alertNow) ledger.lastAlertAt = endAt;         // 冷却计时只在**真写了告警**时推进
    patch.budget = ledger;
    const after = stampJob(cur, job.id, patch);       // 返回写盘后的完整 state（下面直接用，不重复读盘）
    const overEntry = verdict.exceeded
      ? { job: job.id, at: endAt, durationMs, budgetMs: verdict.budgetMs, class: verdict.class, ratio: verdict.ratio, alert: alertNow }
      : null;
    // 日志首段**保持既有格式**（`job <id>: <status> (<ms>ms)`）—— 外部统计/排障工具按它 grep，
    //   观测信息只往后追加，不许改写前缀（口径：加观测不破坏既有消费面）。
    const budgetNote = `· 预算 ${verdict.budgetMs}ms（${verdict.class}/${verdict.source}）`
      + `${verdict.exceeded ? ` · ⏱ 超 ${verdict.ratio}× ⇒ 只记录不降档${alertNow ? '｜已写告警（30 分钟冷却）' : '｜告警冷却中'}` : ''}`
      + `｜${NAMED_METRICS.jobDurationMs.name}`;
    log(`job ${job.id}: ${patch.lastStatus} (${durationMs}ms) ${budgetNote}`
      + (benign ? ` · exit ${code} 让路/未完成，不计失败（${job.benignExitLabel ?? '非故障'}）` : '')
      // 【卡 冲刺600·tickd失败留痕】失败时多一句"去哪看"——排障时不必翻 state.json
      + (trace?.ok ? ` · 输出尾部 → ${trace.path}` : (shouldTraceExit(code) ? ' · 输出尾部留痕失败（不影响结算）' : '')));
    if (verdict.exceeded && alertNow) {
      try {
        alert({
          level: 'info', source: 'tickd',
          message: budgetAlertText(job, { ...verdict, durationMs }),
          detail: { jobId: job.id, durationMs, ...verdict, metric: NAMED_METRICS.jobDurationMs.name },
        }, { home: jobHome() });
      } catch { /* 告警失败不影响调度 */ }
    }
    // 顶层命名指标（`dsh.butler.<domain>.<metric>`，v2 §3.7.2 口径）——面板/日报/未来后端的**同一份**出口。
    //   key 用命名表里的名字（不合规一律不落盘），job 维度走 labels。
    const hasBenignCodes = Array.isArray(job.benignExitCodes) && job.benignExitCodes.length > 0;
    const metrics = mergeMetrics(after.metrics, job.id, buildJobMetricSamples({
      job, durationMs, status: patch.lastStatus, at: endAt, via: prev.lastVia ?? null,
      runs: patch.runs, failures: patch.failures,
      benignExits: hasBenignCodes ? (benign ? patch.benignExits : (prev.benignExits ?? 0)) : null,
      verdict: { ...verdict, exceededCount: ledger.exceededCount },
    }), { now: Date.now(), overEntry, alertSent: alertNow });
    writeState({ metrics });
  });
  // 不 await：并发跑由调度器侧的 tick 锁（本函数）+ 子脚本自身的逻辑兜底；这里只记"正在跑"防叠加
  return child;
}

/**
 * 【卡 4a12fc8c · 修法 1+2+3】清理 state.json 里的**残留 `running:true`** 标记。
 *
 * 与 sweepDeadLocks() 是两件事：那个清 `butler-locks\tick-*.lock` 文件锁，这个清调度器
 * 内存语义的防重入标记 —— 原先只清了前者，所以 tickd/机器被带走一次（或子进程 exit
 * 事件丢失一次）就让某个 job 静默停摆（实测 barewatch 15h+、restart 2h+，failures 仍为 0）。
 *
 * 调用点：① 每轮 tickOnce 开头（幂等：清理后 running=false，同一条不会再命中）
 *        ② serve() 冷启动（必须在写自己的 pid 之前 —— pid 分支据此立即判残留）。
 * 副作用仅三处：状态补 `running:false` + `staleRunningReset*` 字段、日志一行、alert 一条。
 * @param {{jobs?:Array, state?:object, now?:number, only?:string|null, why?:string}} [opts]
 * @returns {{reset:Array<{id:string,since:string|null,ageMs:number|null,thresholdMs:number,cause:string}>, state:object}}
 */
export function sweepStaleRunning({ jobs = JOBS, state = null, now = Date.now(), only = null, why = 'tick' } = {}) {
  const cur = state ?? readState() ?? {};
  const states = cur.jobs ?? {};
  const reset = [];
  let next = cur;
  for (const j of jobs) {
    if (only && j.id !== only) continue;
    const s = states[j.id];
    if (s?.running !== true) continue;
    const statePid = Number(cur.pid);
    if (!isStaleRunning(j, s, now, {
      localRunning: activeChildren.has(j.id),      // ① 本进程真在跑 → 绝不误清
      tickdPid: process.pid, statePid,             // ② pid 不同 → 上一实例的残留，立即清
    })) continue;

    const since = s.lastStartAt ?? s.lastRunAt ?? null;
    const sinceMs = Date.parse(String(since ?? ''));
    const thresholdMs = staleRunningThresholdMs(j);
    const ageMs = Number.isFinite(sinceMs) ? now - sinceMs : null;
    const cause = Number.isFinite(statePid) && statePid !== process.pid ? 'prev-process' : 'over-threshold';
    next = stampJob(next, j.id, {
      running: false,
      staleRunningResetAt: new Date(now).toISOString(),
      staleRunningResetNote: `残留 running=true 自动复位（${why}/${cause}；lastStartAt=${since ?? '—'}；阈值=${thresholdMs}ms）`,
      staleRunningResets: Number(s.staleRunningResets ?? 0) + 1,
      staleRunningLastSince: since,
      staleRunningLastThresholdMs: thresholdMs,
    });
    reset.push({ id: j.id, since, ageMs, thresholdMs, cause });
    log(`stale-running-reset: job ${j.id} 残留标记已复位 → 本轮重新入队（${cause}${ageMs === null ? '' : `，已挂 ${Math.round(ageMs / 1000)}s`}）`);
    try {
      alert({
        level: 'warn', source: 'tickd',
        message: `job ${j.id} 残留 running=true 被自动复位（${cause}）→ 已重新入队`,
        detail: { jobId: j.id, why, cause, statePid: Number.isFinite(statePid) ? statePid : null, tickdPid: process.pid, lastStartAt: since, ageMs, thresholdMs },
      }, { home: jobHome() });
    } catch { /* 告警失败不影响调度 */ }
  }
  return { reset, state: next };
}

/** 「上一进程停摆窗口」结算阈值：停摆 ≥ 该值才记台账（loop 15s，正常重启的 gap 通常 < 1 分钟）。 */
export const STALL_MIN_GAP_MS = 10 * 60_000;
/** 停摆窗口台账保留条数（`state.stallWindows` 环形，最近 N 条）。 */
export const STALL_WINDOWS_KEEP = 20;

/**
 * 【2026-09-16 拷问 1.5】tickd 启动时结算「上一进程停摆窗口」→ 写台账 + 报警。
 *
 * 为什么：tickd 被杀 / 机器关机 / 长时间停摆时，**没有任何地方记录"这段空档里哪些 job 该跑没跑"**
 *   —— 状态文件只有"上一进程最后一次心跳"，停摆结束、下次启动，这段事实就永久消失了
 *   （现场：rollback-offsite 两天没跑，日报全绿，见 `calendarLag` 头注释）。
 *   本函数在 **serve() 冷启动**（写自己 pid 之前）把空档落成一条台账：
 *     `state.stallWindows[] = { from, to, gapMs, prevPid, missedCount, missed[] }`（保留最近 20 条）
 *   + 若窗口内确有"该跑没跑"的日历 job → `alert(warn)`（进日报告警段）。
 *
 * 口径：① 只认日历型 job（interval 型"没跑"由看门狗/健康段自己体现，不在这里猜）；
 *      ② 被开关关掉的 job（`state.blockedJobs`）**不算**该跑没跑；③ 从没跑过的 job 不判。
 * 只读入参 + 一次 `writeState({stallWindows})`，不改 job 状态、不触发 job。
 */
export function settleStallWindow({ jobs = JOBS, state = null, now = Date.now(), minGapMs = STALL_MIN_GAP_MS } = {}) {
  const cur = state ?? readState() ?? {};
  const prevBeat = cur.lastLoopAt ?? cur.stoppedAt ?? null;
  const beatMs = Date.parse(String(prevBeat ?? ''));
  if (!Number.isFinite(beatMs)) return { ok: false, reason: 'no-previous-heartbeat', gapMs: null, window: null, missed: [] };
  const gapMs = now - beatMs;
  if (gapMs < minGapMs) return { ok: true, reason: 'gap-below-threshold', gapMs, window: null, missed: [] };

  const blocked = Array.isArray(cur.blockedJobs) ? cur.blockedJobs : [];
  const missed = [];
  for (const j of jobs) {
    if (j.enabled === false) continue;
    if (blocked.includes(j.id)) continue;
    const lag = calendarLag(j, cur.jobs?.[j.id], now);
    if (lag) missed.push({ id: j.id, lagDays: lag.lagDays, reason: lag.reason });
  }

  const window = {
    from: prevBeat, to: new Date(now).toISOString(), gapMs,
    prevPid: Number.isFinite(Number(cur.pid)) ? Number(cur.pid) : null,
    missedCount: missed.length, missed: missed.slice(0, 10),
  };
  const windows = [...(Array.isArray(cur.stallWindows) ? cur.stallWindows : []), window].slice(-STALL_WINDOWS_KEEP);
  writeState({ stallWindows: windows });

  const mins = Math.round(gapMs / 60_000);
  log(`停摆结算：上一进程心跳 ${prevBeat} → 本次启动，空档 ${mins} 分钟；窗口内"该跑没跑" ${missed.length} 个`
    + `${missed.length ? `（${missed.map((m) => `${m.id} 落后${m.lagDays}天`).join('、')}）` : ''}`);
  if (missed.length) {
    try {
      alert({
        level: 'warn', source: 'tickd',
        message: `tickd 停摆 ${mins} 分钟，窗口内有 ${missed.length} 个日历 job 未跑：${missed.map((m) => m.id).join('、')}`,
        detail: window,
      }, { home: jobHome() });
    } catch { /* 告警失败不影响调度 */ }
  }
  return { ok: true, reason: 'settled', gapMs, window, missed, wroteState: true };
}

/**
 * 跑一轮：到期就 spawn。返回本轮启动的 job id 列表。
 * 【2026-09-13 卡②】开关门在**这里每轮现读**（模块级 + job 级），因此
 *   改 `butler-autonomy.json` ≤1 个 loop（默认 15s）生效 —— 不必 --stop/--ensure。
 *   `ignoreGates`（= `--once <job> --force`）仅供排障强制跑单个 job 用。
 */
export async function tickOnce({ jobs = JOBS, now = Date.now(), startedAt = now, only = null, force = false, ignoreGates = false, home = undefined } = {}) {
  const state = readState() ?? {};
  // 【修法 1+2】先清残留标记（幂等）再排队：否则被残留的 job 会被 pickDue 永久跳过
  const swept = sweepStaleRunning({ jobs, state, now, only });
  const states = swept.state?.jobs ?? state.jobs ?? {};
  const gates = resolveJobGates(jobs, home ? { home } : {});
  const gateOf = (id) => gates.gates[id] ?? { id, enabled: true, reason: 'unknown-job' };
  let list;
  if (only) list = jobs.filter((j) => j.id === only && (ignoreGates || gateOf(j.id).enabled === true));
  else if (force) list = jobs.filter((j) => ignoreGates || gateOf(j.id).enabled === true);
  else list = pickDue(jobs, states, now, startedAt, { localRunning: activeChildren, gateOf });
  const blocked = jobs.filter((j) => gateOf(j.id).enabled !== true).map((j) => j.id);
  const started = [];
  for (const j of list) {
    runJob(j, now);
    started.push(j.id);
  }
  // 【卡②】被开关拦下的 job 落进 state：任何查看路径（--status / 日报 tickd 健康段 / 排障）
  //   都看得见"谁被关了、因为什么"（"关闭必须可观测"四条的落点）。
  writeState({
    blockedJobs: blocked,
    blockedJobsDetail: Object.fromEntries(Object.entries(gates.gates).filter(([, v]) => v.enabled !== true).map(([k, v]) => [k, v.reason])),
    blockedJobsAt: new Date(now).toISOString(),
  });
  return {
    started, reset: swept.reset.map((r) => r.id), blocked, gates: gates.gates,
    moduleEnabled: gates.module?.enabled === true, at: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------- 常驻循环

/**
 * 【T2 · 施工卡 ②-2 · 挂点①】登记自检 = 锁注册表完整性 + **跨表准入校验器**（唯一判定源
 * `lib/registry-audit.mjs`）。返回可写入 `state.registryAudit` 的三态结论文档。
 *
 * **为什么必须抽成函数 + 消灭空 catch**（② 包 §3.2 挂点① / 轮三 R2 / 轮四 6）：
 *   改前是 `try { auditRegistry(...) } catch { /* 自检失败不阻断 *／ }` —— 校验器一抛错，
 *   **日志里什么都没有、state 里也没有字段** ⇒ "零问题"与"从未跑"外观完全相同（单点即静默）。
 *   现在三态都可分辨：① 日志（成功/差异/不可用都留行）② `state.registryAudit = {at, ok, failed, …}`
 *   ③ 日报段读该字段（字段缺失 ⇒ 显式写「自检未执行」）。
 *
 * **纪律**：纯只读、**不阻断**（绝不让调度器因登记问题起不来）；校验器加载走**动态 import**
 *   （加载失败也只降级成 `error` 字段 + 日志，不抛出去）；`auditFn` 可注入**仅供单测**做"校验器自己炸"夹具。
 *
 * @param {object} [opts]
 * @param {Array} [opts.jobs]      调度表（默认 `JOBS`）
 * @param {string} [opts.home]     `~/.dsh`（默认由 lib 侧解析）
 * @param {string} [opts.root]     DSH 根（默认由 lib 侧解析；夹具显式注入）
 * @param {number} [opts.now]      计算时刻（默认 `Date.now()`）
 * @param {number} [opts.startedAt] 本进程启动时刻（判定源新鲜度用；缺省 = `now`）
 * @param {Function} [opts.auditFn] 校验器注入（**仅单测**）
 * @returns {Promise<{at:string, ok:boolean, failed:number|null, checks:number|null, problems:string[],
 *                    unavailable:string[], lockProblems:string[], asOf:string|null, sourceLib:string|null,
 *                    sourceLibMtime:string|null, pendingRestart:boolean|null, error:string|null}>}
 */
export async function runRegistrySelfCheck(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const jobs = opts.jobs ?? JOBS;
  const at = new Date(now).toISOString();
  const out = {
    at, ok: false, failed: null, checks: null,
    problems: [], unavailable: [], lockProblems: [],
    asOf: null, sourceLib: null, sourceLibMtime: null, pendingRestart: null,
    error: null,
  };

  // ① 锁注册表完整性（原 T2 判据，保留 —— "漏登记 = 该 job 没锁"）
  try {
    out.lockProblems = auditRegistry({ jobs }) ?? [];
  } catch (e) {
    out.error = `锁注册表自检抛错：${String(e?.message ?? e)}`;
    log(`T2 锁注册表自检不可用：${out.error}`);
  }
  if (out.lockProblems.length) log(`T2 锁注册表问题：${out.lockProblems.join(' | ')}`);

  // ② 跨表准入校验器（四域零差集；失败可见、绝不阻断调度）
  try {
    let auditRegistries = typeof opts.auditFn === 'function' ? opts.auditFn : null;
    if (!auditRegistries) {
      const mod = await import(pathToFileURL(path.join(HERE, 'lib', 'registry-audit.mjs')).href);
      if (typeof mod.auditRegistries !== 'function') throw new Error('registry-audit 未导出 auditRegistries');
      auditRegistries = mod.auditRegistries;
    }
    const r = await auditRegistries({
      jobs, now, startedAt: Number(opts.startedAt ?? now),
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.root ? { root: opts.root } : {}),
    });
    out.asOf = typeof r?.asOf === 'string' && r.asOf ? r.asOf : null;
    out.sourceLib = r?.source?.lib ?? null;
    out.sourceLibMtime = r?.source?.libMtime ?? null;
    out.pendingRestart = typeof r?.source?.pendingRestart === 'boolean' ? r.source.pendingRestart : null;
    out.checks = Object.values(r?.byDomain ?? {}).reduce((s, v) => s + Number(v?.checks ?? 0), 0);
    out.problems = (r?.problems ?? []).map((p) => `[${p.domain}] ${p.id} · ${p.check}：${p.detail}`);
    out.unavailable = (r?.unavailable ?? []).map((u) => `[${u.domain}] ${u.check}：${u.detail}`);
    out.failed = out.problems.length;
    out.ok = r?.ok === true;
    // 成功也留一行日志 —— "零问题"必须与"从未跑"可区分（这是本挂点的核心判据）
    log(`T2 登记自检：${out.ok ? '✅ 零差集' : `❌ 差异 ${out.failed} 项`}`
      + `（四域断言 ${out.checks} 次${out.unavailable.length ? ` · 不可用 ${out.unavailable.length} 项` : ''}`
      + ` · asOf=${out.asOf ?? '?'}）${out.pendingRestart ? ' ｜⚠️ 待重启生效（源码比进程新）' : ''}`);
    if (out.failed) {
      log(`T2 登记自检问题：${out.problems.slice(0, 5).join(' | ')}${out.failed > 5 ? ` …另 ${out.failed - 5} 项（全量：node tools\\dsh-butler\\butler-registry-audit.mjs）` : ''}`);
    }
    if (out.unavailable.length) {
      log(`T2 登记自检不可用 ${out.unavailable.length} 项（**不许判绿**）：${out.unavailable.slice(0, 3).join(' | ')}`);
    }
  } catch (e) {
    // ⚠️ 这里**不再是空 catch**：校验器自己炸 ⇒ error 字段 + 日志 + ok:false / failed:null（三态可分辨）
    out.error = `${out.error ? `${out.error}；` : ''}跨表校验器不可用：${String(e?.message ?? e)}`;
    out.ok = false;
    out.failed = null;
    log(`T2 登记自检不可用（不阻断调度）：${String(e?.message ?? e)}`);
  }
  return out;
}

/**
 * 【V2.9 封口①·A 域 · 2026-10-14 · 卡「封口①-A域」】tickd 侧三项观测/自检的**逻辑本体**。
 *
 * 为什么抽出来：`serve()` 的常驻循环**不能拿来隔离实测** —— 它一旦起来就会按期启动真实 job
 *   （restart-coordinator 等生产脚本）⇒ "测观测"会变成"动生产"。本函数是**纯逻辑 + 全注入**：
 *   单测直接调它就能验「首扫只写一次 / 内存取值 / 自检字段 / 失败转 error 字段」，
 *   而 `serve()` 只剩「什么时候调、写到哪」。
 *
 * @param {{now?:number, startedAt?:number, coldBootAt?:number, coldBootMs?:number, loops?:number,
 *          coldStartWritten?:boolean, selfCheck?:boolean, apply?:boolean,
 *          memoryFn?:Function, budgetFn?:Function, authorizeFn?:Function, dispositionFn?:Function,
 *          authorizeOpts?:object, dispositionOpts?:object}} [opts]
 * @returns {{memory:object, coldStart?:object, authorizeAudit?:object, versionDisposition?:object}}
 */
export function buildTickObservability(opts = {}) {
  const nowMs = Number(opts.now ?? Date.now());
  const startedAt = Number(opts.startedAt ?? nowMs);
  const coldBootAt = Number(opts.coldBootAt ?? startedAt);
  const apply = opts.apply !== false;
  const out = {};

  // ① A L162 · 内存 —— ⚠️ 采样对象 = **调用者进程**（Node 跨不了进程读 RSS）⇒ 只在此处（tickd 内）调才有意义
  const memFn = typeof opts.memoryFn === 'function' ? opts.memoryFn : memorySample;
  const budFn = typeof opts.budgetFn === 'function' ? opts.budgetFn : judgeMemoryBudget;
  const mem = memFn(null, nowMs) ?? {};
  const bud = budFn(mem.rssBytes) ?? {};
  out.memory = {
    at: new Date(nowMs).toISOString(), subject: mem.subject ?? 'caller-process', pid: process.pid,
    rssBytes: mem.rssBytes ?? null, heapUsedBytes: mem.heapUsedBytes ?? null, heapTotalBytes: mem.heapTotalBytes ?? null,
    // 【R-031 · 2026-10-19】补 external/arrayBuffers：RSS 与 heap 之间的差额主要来自这里 + V8 代码页，
    //   不记下来就没法区分「堆在涨」与「高水位没还」。
    externalBytes: mem.externalBytes ?? null, arrayBuffersBytes: mem.arrayBuffersBytes ?? null,
    budgetBytes: bud.budget ?? null, budgetOk: bud.ok === true, ratio: bud.ratio ?? null,
    // 地板 + 增量（判据与读数同源；旧消费面只读 budgetOk/ratio 也不受影响）
    floorBytes: bud.floorBytes ?? null, deltaBudgetBytes: bud.deltaBudgetBytes ?? null,
    overFloorBytes: bud.overFloorBytes ?? null, deltaRatio: bud.deltaRatio ?? null,
    basis: 'lib/slo-tail.mjs#memorySample（**tickd 进程内**）+ judgeMemoryBudget（预算 = 平台地板 58 MB + tickd 增量 24 MB ＝ 82 MB · 方案 §3.7.5 口径校准 2026-10-19 R-031）',
  };

  // ② A L162 · 首扫（**只写一次**：进程启动 → 首轮 tick 全量采集完成；此前全库无载体）
  if (opts.coldStartWritten !== true) {
    out.coldStart = {
      at: new Date(nowMs).toISOString(), startedAt: new Date(startedAt).toISOString(),
      coldBootMs: Number(opts.coldBootMs ?? (coldBootAt - startedAt)),
      firstScanMs: nowMs - coldBootAt, totalMs: nowMs - startedAt,
      jobs: JOBS.length, loops: Number(opts.loops ?? 1),
      basis: '首扫 = 进程启动 → **首轮 tick 全量采集完成**的耗时（拆「冷启动自检」+「首轮采集」两段）',
    };
  }

  // ③ A L154 授权合成自检 / A L167 不匹配处置自检（节流由调用方给 `selfCheck`）
  if (opts.selfCheck !== false) {
    const authFn = typeof opts.authorizeFn === 'function' ? opts.authorizeFn : authorizeSelfCheck;
    const dispFn = typeof opts.dispositionFn === 'function' ? opts.dispositionFn : runVersionDisposition;
    try {
      out.authorizeAudit = authFn({ now: nowMs, ...(opts.authorizeOpts ?? {}) });
    } catch (e) {
      // 「零问题」与「从未跑」必须可分辨 ⇒ 自己炸也要落 error 字段（不抛、不阻断调度）
      out.authorizeAudit = { at: new Date(nowMs).toISOString(), ok: false, error: String(e?.message ?? e) };
    }
    try {
      // ⚠️ `apply:true` = 真落审计台账；**正常态（无版本不匹配）零写入**（处置器早返回）
      out.versionDisposition = dispFn({ apply, now: nowMs, ...(opts.dispositionOpts ?? {}) });
    } catch (e) {
      out.versionDisposition = { at: new Date(nowMs).toISOString(), acted: false, error: String(e?.message ?? e) };
    }
  }
  return out;
}

// ---------------------------------------------------------------- 启动补桥
// 【V3 功能面 · 起服召回空窗（2026-10-22）】起服时立刻把记忆编码桥拉起（幂等），不等 job 的到期点。
// 缺口（实测）：桥由本表 job `memory-vectors` 幂等启动，而该 job 的**首次到期判定**看的是磁盘上的
//   `lastRunAt + intervalMs`（`initialMs` 只在 runs=0 时生效，见 isIntervalDue）⇒ 起服后最坏要等满
//   一个周期（60 min）才补起桥。2026-10-21 23:47 起服 → 23:53 桥仍无监听，召回全程 bridge-unavailable；
//   手动跑一次 `cli/serve-start.mjs` 立刻就好。
// 口径（四条，缺一不可）：
//   · **只保桥**：spawn `butler-memory-vectors-tick.mjs --bridge-only --json` —— 只起桥，不跑增量同步 /
//     兜底轮转 / 坑源钩子，**不写该 job 的 tick 状态**（runs / lastRunAt 不动 ⇒ 每小时节奏与历史不受影响）。
//   · **幂等**：`serve-start.mjs` 自带 `GET /health` 探活，桥在跑就跳过（重复调用零副作用）。
//   · **尊重开关**：`memory-vectors` 在 `butler-autonomy.json` 里关着 ⇒ 不补桥（与 `job off` 语义一致）。
//   · **best-effort**：非阻塞 spawn + 尾部捕获（不读管道会卡死子进程，见 runJob 同款注释）；
//     失败只记一行日志 + 一行 state，**绝不阻断调度**。
const STARTUP_BRIDGE_JOB = 'memory-vectors';
const STARTUP_BRIDGE_EXTRA_ARGS = ['--bridge-only', '--json'];

function ensureMemoryBridgeOnStart() {
  if (String(process.env.DSH_TICKD_STARTUP_BRIDGE ?? '1') === '0') {
    log('启动补桥：DSH_TICKD_STARTUP_BRIDGE=0 ⇒ 跳过（演练/单测用）');
    return;
  }
  const job = JOBS.find((j) => j.id === STARTUP_BRIDGE_JOB);
  if (!job?.script) { log(`启动补桥：job ${STARTUP_BRIDGE_JOB} 未注册 ⇒ 跳过`); return; }
  const gate = resolveJobGates(JOBS).gates?.[job.id];
  if (gate?.enabled !== true) {
    log(`启动补桥：${job.id} 开关=关（${gate?.reason ?? 'unknown'}）⇒ 不补桥（与 job off 语义一致）`);
    writeState({ startupBridge: { at: new Date().toISOString(), skipped: 'job-disabled', reason: gate?.reason ?? null } });
    return;
  }
  const at = new Date().toISOString();
  const t0 = Date.now();
  const script = path.resolve(job.dir ?? HERE, job.script);
  const capOut = new TailBuffer(TRACE_CFG.captureBytes);
  const capErr = new TailBuffer(TRACE_CFG.captureBytes);
  let child;
  try {
    child = spawn(NODE_EXE, [script, ...(job.args ?? []), ...STARTUP_BRIDGE_EXTRA_ARGS], {
      cwd: job.dir ?? HERE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    });
    // ⚠️ 与 spawn 同一个 tick 内同步挂读取（理由同 runJob：pipe 不并发读 ⇒ 子进程写满缓冲即卡死）
    attachTail(child.stdout, capOut);
    attachTail(child.stderr, capErr);
  } catch (e) {
    log(`启动补桥：spawn 失败 ${e?.message ?? e}（不阻断调度）`);
    writeState({ startupBridge: { at, ok: false, error: `spawn: ${String(e?.message ?? e).slice(0, 200)}` } });
    return;
  }
  let settled = false;
  const settle = (code, err) => {
    if (settled) return;
    settled = true;
    const elapsedMs = Date.now() - t0;
    let body = null;
    try { body = JSON.parse(String(capOut.text() ?? '').trim()); } catch { /* 非 JSON：按退出码判 */ }
    const bridge = body?.bridge ?? null;
    const ok = body?.ok === true && bridge?.ok !== false;
    const detail = {
      at, elapsedMs, ok, exitCode: code ?? null, status: body?.status ?? null,
      started: bridge?.started ?? null, port: bridge?.port ?? null, pid: bridge?.pid ?? null,
      error: ok ? null : (bridge?.error ?? (err ? String(err).slice(0, 200) : `exit ${code}`)),
      stderr: ok ? null : (capErr.text() || '').slice(-300) || null,
    };
    log(`启动补桥：${ok
      ? `桥就绪 port=${detail.port ?? '?'} ${detail.started ? '（本次拉起）' : '（已在跑，跳过）'}`
      : `未就绪（${detail.error ?? 'unknown'}）`} · ${elapsedMs}ms（只保桥，不跑同步）`);
    writeState({ startupBridge: detail });
  };
  child.on('error', (e) => settle(null, e?.message ?? e));
  child.on('close', (code) => settle(code, null));
}

async function serve(loopMs) {
  // ── 【卡 tickd 实例唯一性 · 2026-10-22】启动期守卫（**进入主循环之前**）────────────
  //   为什么：2026-10-21 C 段施工 `--stop` 之后现场同时有「持锁现役 18716」+「孤儿 8532（2026-10-20 起、
  //   跑的是旧代码）」——「改了代码就生效」在双实例下不成立。真源
  //   `docs/` §7-2。
  //   ★ 顺序红线：必须在 acquireLock() **之前** —— acquireLock 会先把「心跳过期」的锁当陈旧删掉再接管，
  //     那一步正好会把「另一个真活着的实例」顺手清掉（= 本次事故的机制面）。
  //   ★ 命中 ⇒ 审计一行 tickd-duplicate + **良性退出 rc 0**（不是故障，是"已有实例在跑"）。
  //   ★ 收尾只用 `process.exitCode`（本卡不新增 process.exit：强退会截断同步写盘的尾巴）。
  const dup = detectDuplicateInstance();
  if (dup.duplicate) {
    appendAudit({ type: 'tickd-duplicate', myPid: process.pid, lockPid: dup.lockPid, at: new Date().toISOString() });
    log(`启动期守卫：已有实例在跑（lock PID ${dup.lockPid}）⇒ 本进程不启动（审计 tickd-duplicate）`);
    process.exitCode = 0;
    return;
  }
  const lock = acquireLock();
  if (!lock.ok) { log(`serve: 退出 —— ${lock.reason}`); return 1; }
  const startedAt = Date.now();
  // 【卡 tickd 止血三件 · 2026-10-30 ④】锁到手**立刻**写一次自己的心跳。
  //   为什么（事故链条的第一环，真源报告 §4.1 场景 A）：从「拿到锁」到「首轮 loop 写心跳」之间，
  //   还要跑 registry 自检 / 冷启动清扫 / 停摆结算（生产实测 ≥5 s）。这段窗口里
  //   `state.lastLoopAt` 还是**上一个已死进程**的值 ⇒ 任何人问 isRunning() 都读到旧心跳
  //   （守护鱼 TICKD-WATCH 每 30 s 探一次；19:34 就是这么判 down 然后 ensure 删锁的）。
  //   现在把窗口压到 0：锁一拿到、心跳先落盘。
  //   ⚠️ 停摆结算要的是「上一进程的 lastLoopAt」，所以先快照旧 state 传给它（见下面的 settleStallWindow），
  //      否则停摆台账会永远记成 0 分钟。
  const prevStateSnapshot = readState();
  writeState({ lastLoopAt: new Date().toISOString() });
  // 【T2 · 挂点①（施工卡 ②-2）】注册表完整性 + 跨表准入自检（漏登记 / 缺锁 / 重名 / 缺字段）
  //   → **只记日志 + 写 state.registryAudit，不阻断**（调度器不得因登记问题起不来）。
  //   ⚠️ 改前那个 `catch { /* 自检失败不阻断 */ }` 是**空的** ⇒ 校验器抛错时单点即静默；现已三处留痕。
  const registryAudit = await runRegistrySelfCheck({ startedAt });
  writeState({ registryAudit });

  sweepDeadLocks();
  // 【修法 2】冷启动清扫**必须在 writeState(pid=自己) 之前**：此刻 state.pid 还是上一实例的 pid，
  //   isStaleRunning 的 pid 分支据此立即判定"这些 running 标记属于已消亡的进程"（其 child 全随它死了），
  //   不必苦等 15 分钟阈值 —— 这是"被杀一次就停摆到天亮"的直接解药。
  try {
    const cold = sweepStaleRunning({ jobs: JOBS, now: Date.now(), why: 'cold-start' });
    if (cold.reset.length) log(`冷启动清扫：复位 ${cold.reset.length} 个残留 running 标记（${cold.reset.map((r) => `${r.id}/${r.cause}`).join(', ')}）`);
  } catch (e) { log(`冷启动 stale 清扫失败（不致命）：${e?.message ?? e}`); }
  // 【2026-09-16 拷问 1.5】停摆窗口结算：上一进程最后一次心跳 → 本次启动之间的空档写台账
  //   （在 writeState(pid=自己) **之前**，此刻 state.lastLoopAt 还属于上一进程）。
  try {
    // ⚠️ 必须传上面那份**写心跳之前**的快照（止血三件 ④ 的配套）：settleStallWindow 要的是
    //   「上一进程的 lastLoopAt ↔ 本次启动」的空档，读盘上最新的 state 会读到刚写的心跳 ⇒ 空档恒为 0。
    const stall = settleStallWindow({ jobs: JOBS, now: Date.now(), state: prevStateSnapshot });
    if (stall.window) log(`停摆窗口已记台账：${Math.round(stall.gapMs / 60_000)} 分钟（窗口内该跑没跑 ${stall.missed.length} 个）`);
  } catch (e) { log(`停摆结算失败（不致命）：${e?.message ?? e}`); }
  writeState({
    schemaVersion: 1, version: TICKD_VERSION, pid: process.pid,
    startedAt: new Date(startedAt).toISOString(), loopMs, jobs: (readState()?.jobs) ?? {},
  });
  log(`tickd 启动 pid=${process.pid} loop=${loopMs}ms jobs=${JOBS.length}`);
  // 【V3 功能面 · 起服召回空窗（2026-10-22）】启动补桥（幂等/非阻塞/尊重 job 开关）
  try { ensureMemoryBridgeOnStart(); } catch (e) { log(`启动补桥异常（已隔离，不影响调度）：${e?.message ?? e}`); }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('tickd 收到停止信号，退出');
    writeState({ lastLoopAt: new Date().toISOString(), stoppedAt: new Date().toISOString() });
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', (e) => log(`未捕获异常（已隔离，进程继续）：${e?.stack ?? e}`));
  process.on('unhandledRejection', (e) => log(`未处理的 Promise 拒绝（已隔离）：${e?.message ?? e}`));

  // 【V2.9 封口①·A 域 · 2026-10-14 · 卡「封口①-A域」】三个**只读自检**的挂点（全在 tickd 进程内，
  //   不进场 dsh 进程；不新增 job、不动任何开关、失败只落 state/日志 —— **绝不阻断 job 调度**）。
  //   逻辑本体抽在导出的 `buildTickObservability()` 里 ⇒ 可**隔离单测**（不必真起常驻调度器去跑 job）。
  const coldBootAt = Date.now();
  const coldBootMs = coldBootAt - startedAt;
  const SELF_CHECK_EVERY_MS = 15 * 60_000;
  let loops = 0;
  let coldStartWritten = false;
  let lastSelfCheckAt = 0;

  const loop = async () => {
    if (stopping) return;
    try {
      const r = await tickOnce({ startedAt });
      loops += 1;
      const nowMs = Date.now();
      const patch = {
        lastLoopAt: new Date().toISOString(), lastStarted: r.started, blockedJobs: r.blocked,
        loopCount: (readState()?.loopCount ?? 0) + 1,
      };
      // 内存每轮采样（A L162）；首扫只写一次；A L154/A L167 自检节流（首次立即跑，便于接线后一眼看到读数）
      const due = lastSelfCheckAt === 0 || nowMs - lastSelfCheckAt >= SELF_CHECK_EVERY_MS;
      if (due) lastSelfCheckAt = nowMs;
      const obs = buildTickObservability({
        now: nowMs, startedAt, coldBootAt, coldBootMs, loops, coldStartWritten, selfCheck: due,
      });
      Object.assign(patch, obs);
      if (obs.coldStart) {
        coldStartWritten = true;
        log(`首扫完成：${obs.coldStart.totalMs}ms（冷启动自检 ${obs.coldStart.coldBootMs}ms + 首轮采集 ${obs.coldStart.firstScanMs}ms · jobs=${obs.coldStart.jobs}）`);
      }
      if (obs.authorizeAudit && obs.authorizeAudit.ok !== true) log(`授权合成自检：不可用（${obs.authorizeAudit.error ?? (obs.authorizeAudit.problems ?? []).join(' | ')}）—— 不阻断调度`);
      if (obs.versionDisposition && obs.versionDisposition.error) log(`版本不匹配处置自检不可用（不阻断调度）：${obs.versionDisposition.error}`);
      writeState(patch);
      if (r.started.length) log(`loop: 启动 ${r.started.join(', ')}`);
      // 【卡②】开关状态变化才记一行（防刷屏）：关了谁必须看得见（"关闭必须可观测"）
      const key = r.blocked.join(',');
      if (key !== lastBlockedKey) {
        lastBlockedKey = key;
        if (r.blocked.length) {
          const detail = r.blocked.map((id) => `${id}（${r.gates?.[id]?.reason ?? '?'}）`).join(', ');
          log(`门：被开关拦下的 job = ${detail}${r.moduleEnabled === false ? '｜模块 tickd-jobs 总闸=关' : ''}`);
        } else log('门：无 job 被开关拦下（全部照常）');
      }
    } catch (e) {
      log(`loop 异常（已隔离）：${e?.message ?? e}`);
      writeState({ lastLoopAt: new Date().toISOString(), lastError: String(e?.message ?? e).slice(0, 300) });
    }
  };
  await loop();
  setInterval(loop, loopMs);
  return new Promise(() => { /* 常驻 */ });
}

// ---------------------------------------------------------------- CLI

function statusOut() {
  const lock = readLock();
  const state = readState();
  const r = isRunning();
  const gates = resolveJobGates(JOBS);
  return {
    ok: true, running: r.running, reason: r.reason, pid: lock?.pid ?? null,
    version: TICKD_VERSION, startedAt: state?.startedAt ?? null, lastLoopAt: state?.lastLoopAt ?? null,
    loopCount: state?.loopCount ?? 0,
    // 【卡②】活开关现状（kill switch L2）：总闸 + 每个 job 的判定与来源
    switches: {
      module: 'tickd-jobs', moduleEnabled: gates.module?.enabled === true, moduleSource: gates.module?.source ?? null,
      file: gates.module?.file ?? null, jobSwitchesOk: gates.jobSwitchesOk, jobSwitchesReason: gates.jobSwitchesReason,
      blocked: JOBS.filter((j) => gates.gates[j.id]?.enabled !== true).map((j) => j.id),
    },
    jobs: JOBS.map((j) => ({
      id: j.id, label: j.label,
      every: describeSchedule(j),
      lastStatus: state?.jobs?.[j.id]?.lastStatus ?? null,
      lastEndAt: state?.jobs?.[j.id]?.lastEndAt ?? null,
      runs: state?.jobs?.[j.id]?.runs ?? 0,
      failures: state?.jobs?.[j.id]?.failures ?? 0,
      // 【卡 4a12fc8c】残留可见性：running + 复位次数/时间（--status 是排障第一入口，必须看得见）
      running: state?.jobs?.[j.id]?.running === true,
      staleRunningResets: state?.jobs?.[j.id]?.staleRunningResets ?? 0,
      staleRunningResetAt: state?.jobs?.[j.id]?.staleRunningResetAt ?? null,
      // 【卡②】开关（enabled=false 的 job 即使到期也不会被启动）
      enabled: gates.gates[j.id]?.enabled === true,
      switchSource: `${gates.gates[j.id]?.moduleSource ?? '?'}/${gates.gates[j.id]?.jobSource ?? '?'}`,
      switchReason: gates.gates[j.id]?.reason ?? null,
      // 【冲刺600 · 批4-3】观测读数：`--status` 是排障第一入口 —— 耗时/预算/越界必须一眼可见
      lastDurationMs: state?.jobs?.[j.id]?.lastDurationMs ?? null,
      durationSummary: state?.jobs?.[j.id]?.durationSummary ?? null,
      budget: state?.jobs?.[j.id]?.budget ?? null,
    })),
    staleRunning: { localRunning: [...activeChildren.keys()] },
    // 【冲刺600 · 批4-3】观测口径读数：命名表自检（合规数 / 标定覆盖）+ 最新指标快照指针
    metrics: {
      selfCheck: metricsSelfCheck(),
      updatedAt: state?.metrics?.updatedAt ?? null,
      jobsWithMetrics: Object.keys(state?.metrics?.jobs ?? {}).length,
      budgetOverCount: state?.metrics?.budgetOverCount ?? 0,
      budgetOver: state?.metrics?.budgetOver ?? [],
      alerts: state?.metrics?.alerts ?? null,
    },
  };
}

/**
 * 幂等启动（守护鱼 TICKD-WATCH / DSH 启动链 / 人手动都走这里）。
 *
 * 【卡 tickd 止血三件 · 2026-10-30 ②】★ 删锁前必须先核锁主。
 *
 *   老实现是「`isRunning()` 说没跑 ⇒ **无条件** `unlinkSync(LOCK_FILE)` ⇒ spawn」——
 *   于是只要判活判错一次（老 `isRunning()` 就是错的），**活锁当场被删**，接着起来的第二个
 *   实例看到 `no-lock` 一路放行（19:34 双实例事故就是这么发生的）。
 *   现在两道闸：① `isRunning()` 口径已修（心跳不单独判死）；② 即使它说没跑，还要再过一遍
 *   `detectDuplicateInstance()`（纯 pid 判据）—— 它说"锁主活着"，就**拒删、直接返回 already running**。
 *
 * @param {{lockFile?:string, stateFile?:string, isAlive?:(pid:number)=>boolean,
 *          startedAtOf?:(pid:number)=>number|null, spawn?:Function,
 *          unlinkSync?:(p:string)=>void, say?:(s:string)=>void}} [opts]
 *   opts 全部为夹具注入点（默认走真实 fs / spawn，生产行为零变化）。
 */
export function ensure(opts = {}) {
  const lockFile = opts.lockFile ?? LOCK_FILE;
  const stateFile = opts.stateFile ?? STATE_FILE;
  const isAlive = opts.isAlive ?? isPidAlive;
  const startedAtOf = opts.startedAtOf ?? pidStartedAtMs;
  const spawnFn = opts.spawn ?? spawn;
  const unlinkFn = opts.unlinkSync ?? ((p) => fs.unlinkSync(p));
  const say = opts.say ?? ((s) => console.log(s));
  const r = isRunning({ lockFile, stateFile, isAlive, startedAtOf });
  if (r.running) { say(`tickd already running (PID ${r.lock.pid})`); return 0; }
  const dup = detectDuplicateInstance({
    lockFile, selfPid: process.pid, isAlive, startedAtOf,
    allow: opts.allow ?? (process.env.DSH_TICKD_ALLOW_DUPLICATE === '1'),
  });
  if (dup.duplicate) {
    say(`tickd already running (PID ${dup.lockPid}) —— 锁主存活，拒删锁、不起新实例（守卫 ${dup.reason}）`);
    return 0;
  }
  ensureDir(path.dirname(lockFile));
  if (fs.existsSync(lockFile)) { try { unlinkFn(lockFile); } catch { /* ignore */ } }
  const child = spawnFn(NODE_EXE, [fileURLToPath(import.meta.url)], {
    detached: true, windowsHide: true, stdio: 'ignore',
    cwd: HERE, env: { ...process.env },
  });
  if (typeof child?.unref === 'function') child.unref();
  say(`tickd started (PID ${child?.pid}); 日志 ${LOG_FILE}`);
  return 0;
}

function stop() {
  const lock = readLock();
  if (!lock) { console.log('tickd 未运行（无锁文件）'); return 0; }
  if (!isPidAlive(lock.pid)) {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    console.log(`tickd 未运行（陈旧锁 PID ${lock.pid} 已清理）`);
    return 0;
  }
  const r = spawnSync('taskkill.exe', ['/PID', String(lock.pid), '/F'], { windowsHide: true, encoding: 'utf8' });
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  console.log(`tickd 已停止 (PID ${lock.pid})${r?.status === 0 ? '' : ' (taskkill 返回非 0)'}`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  // 【2026-10-23 · stall-nudge 卡】补 `--help`：此前没实现，`--help` 会落到常驻入口
  //   （被实例唯一性守卫良性退出，但看不到任何用法）—— 只读帮助 = 排障第一入口。
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('butler-tickd.mjs —— butler常驻 tick 调度（node.exe 单进程）');
    console.log('');
    console.log('用法：');
    console.log('  node butler-tickd.mjs                  # 前台常驻（调试 / 由 --ensure detached 拉起）');
    console.log('  node butler-tickd.mjs --ensure         # 幂等启动：活着就退，否则 detached 起一个');
    console.log('  node butler-tickd.mjs --stop           # 停止（杀 pid + 清理锁）');
    console.log('  node butler-tickd.mjs --status         # 状态 JSON（含每个 job 的最近结果 / 开关 / 预算）');
    console.log('  node butler-tickd.mjs --list           # 调度表（含开关与入口）');
    console.log('  node butler-tickd.mjs --once [jobId]   # 跑一轮到期任务（或指定）后退出；--force 忽略开关');
    console.log('  node butler-tickd.mjs --loop-ms <ms>   # 覆盖主循环节拍（测试用，默认 15000）');
    console.log('');
    console.log('调度表（JOBS）：');
    for (const j of JOBS) console.log(`  ${j.id.padEnd(16)} ${describeSchedule(j).padEnd(30)} ${j.label}  →  ${j.script}`);
    return 0;
  }
  if (argv.includes('--list')) {
    const gates = resolveJobGates(JOBS);
    for (const j of JOBS) {
      const g = gates.gates[j.id];
      console.log(`${j.id.padEnd(14)} ${describeSchedule(j).padEnd(10)} ${(g?.enabled ? '🟢' : '🔴')} ${j.label}  →  ${j.script}`);
    }
    if (gates.module?.enabled !== true) console.log(`⚠️ 模块 tickd-jobs 总闸=关（${gates.module?.source}）→ 全部 job 停跑`);
    return 0;
  }
  if (argv.includes('--status')) { console.log(JSON.stringify(statusOut(), null, 1)); return 0; }
  if (argv.includes('--ensure')) return ensure();
  if (argv.includes('--stop')) return stop();
  if (argv.includes('--once')) {
    const i = argv.indexOf('--once');
    const only = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
    const ignoreGates = argv.includes('--force');
    if (!acquireLock().ok) { console.error('已有实例在跑，--once 退出'); return 1; }
    try {
      sweepDeadLocks();
      const r = await tickOnce({ only, force: !!only, ignoreGates });
      console.log(`--once 启动: ${r.started.join(', ') || '(无到期任务)'}`);
      if (r.blocked.length && !ignoreGates) console.log(`--once 被开关拦下: ${r.blocked.join(', ')}（原因看 --status；强制跑单个：--once <job> --force）`);
      // 等子进程结束（最多 120s），让单测能看到结果
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const st = readState() ?? {};
        const anyRunning = Object.values(st.jobs ?? {}).some((j) => j.running);
        if (!anyRunning) break;
        await new Promise((r2) => setTimeout(r2, 500));
      }
    } finally { releaseLock(); }
    return 0;
  }
  const li = argv.indexOf('--loop-ms');
  const loopMs = li >= 0 ? Math.max(500, Number(argv[li + 1]) || 15_000) : 15_000;
  return serve(loopMs);
}

/** 供 bin 包装层调用（`node bin/butler-tickd.mjs`）：返回进程退出码。 */
export { main as runMain };

// 入口守卫：junction 下 import.meta.url（物理）与 argv[1]（逻辑）必须 realpath 后比较
function isMainEntry() {
  try {
    const a = fs.realpathSync(fileURLToPath(import.meta.url));
    const b = fs.realpathSync(path.resolve(process.argv[1] ?? ''));
    return a === b;
  } catch { return false; }
}

if (isMainEntry()) {
  main().then((code) => { if (typeof code === 'number' && code !== 0) process.exit(code); else process.exit(0); })
    .catch((e) => { console.error(`tickd 失败：${e?.stack ?? e}`); process.exit(1); });
}
