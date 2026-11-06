// dsh-butler / lib/butler-locks.mjs —— T2 单例锁注册表（单一数据源）
//
// 来源：docs/ §17.1 T2
//   「把 butler-scheduler 单例锁扩到**全部 butler tick**（含既有 8 个计划任务）……
//     RestartTick 在交接窗口内必须回 `busy`、不得拉起 DSH」
//   口径拍板：2026-09-10 16:36 the operator采纳 T2（看板卡 S5·H1b + S5·H1b-prep）。
//
// 为什么需要"注册表"这一层：
//   调度入口有**两套**（本机 <host>/<host> 已切常驻 butler-tickd.mjs；对端/<host> 仍可能用 Windows
//   计划任务启同名短命脚本）。两套入口都会 spawn 同一个 tick 脚本，因此：
//     ① 锁名必须**逐 job 唯一**且与脚本内部自报的锁名一致，否则同一 tick 两把锁 = 白锁；
//     ② 谁持锁、谁跳过必须可由**单测断言**（不能靠读源码猜）；
//     ③ H1b 要把 Arrive/Depart 也接进同一套互斥（§5.3 第 6 条「触发源互斥 + drain 语义」），
//        需要一张"哪些临界区、各自多少 TTL"的表，而不是散在 11 个脚本里的魔法数字。
//
// 本模块**只定义数据与纯函数**（无副作用、不 import store）：
//   - jobsForLock() / lockNameFor() / ownerOf() / describeLockTable()：供 tickd 与单测使用；
//   - heldLockNames(env)：供 store.acquireTickLock 判断"本进程已在父调度器持锁保护下"。
//
// ⚠️ 与 store.mjs 的接口约定（勿改口径）：
//   tickd 抢到锁后 spawn 子脚本时注入环境变量 `DSH_BUTLER_TICK_LOCK_HELD=<锁名,...>`；
//   store.acquireTickLock 见到自己的锁名已在该列表里 → 返回**内存虚拟锁**（不做任何 I/O）。
//   目的：既保证"单机内同一 job 只有一个实例"，又避免 tickd 与短命脚本**双层加锁互相打架**
//   （父进程持锁 → 子进程再抢同一把锁必然失败 → 每个 job 都会被误判为 locked 而永远不执行）。
export const BUTLER_LOCKS_VERSION = '0.1.0';

/**
 * 锁注册表 —— 覆盖 Butler 全部 job（含 tickd 调度表 11 项 + 计划任务时代遗留的 tidy）。
 *
 * 字段：
 *   job           : 调度器里的 job id（butler-tickd.mjs 的 JOBS[].id 可不同，见 jobAliases）
 *   lockName      : 规范锁名 = store 里 `tick-<lockName>.lock`；**必须与脚本内自报锁名一致**
 *   script        : 相对 COMPONENT_ROOT 的入口（人工复核用，不参与判定）
 *   ttlMs         : 锁 TTL —— 必须 > 该 job 最长正常执行时间（tickd 侧还有续期兜底）
 *   intervalMs    : 期望周期（0 = 日历型 / 手工，不参与 TTL 推导）
 *   critical      : 该 job 会写哪些共享状态（人工复核 + H1b drain 语义的判据基础）
 *   skipPolicy    : 抢不到锁时的语义（'skip' = 静默跳过并记 locked，绝不排队）
 *   source        : 'tickd' = 常驻调度器；'schtasks' = 旧计划任务；'both'
 *   lockRunner    : true = 该 job **必须**由 tickd 经 `lib/tick-job-runner.mjs` 包装层 spawn
 *                   （包装层语义：抢锁 → 动态 import 目标脚本 → 释放）
 *   lockRunnerReason : 为什么必须走包装层（**lockRunner=true 时必填**，auditRegistry 校验）
 */
export const LOCK_REGISTRY = [
  { job: 'restart', lockName: 'restart-coordinator', script: 'restart-coordinator.mjs', ttlMs: 180_000, intervalMs: 60_000,
    critical: ['butler-restart-state.json', 'butler-restart-requests.json', '重启窗口/VBS 触发'], skipPolicy: 'skip', source: 'tickd' },
  { job: 'queue', lockName: 'queue', script: 'butler-queue-tick.mjs', ttlMs: 120_000, intervalMs: 60_000,
    critical: ['butler-queue-state.json', '看板只读 + 叫醒会话'], skipPolicy: 'skip', source: 'tickd' },
  // 【卡死会话自愈链 · 2026-10-10】方案真源 = `docs/`。
  //   治：会话卡死/回合被重启打断后无人叫醒（2026-10-10 凌晨静默 6.8h 实证）。
  //   与 queue 同节奏（1 分钟）；重启本身不自建通道（走 p0-auto-restart）。
  { job: 'stuck-recovery', lockName: 'stuck-recovery', script: 'butler-stuck-recovery.mjs', ttlMs: 120_000, intervalMs: 60_000,
    critical: ['butler-stuck-recovery.json', '会话注入（提醒 / 重启后补注入）', 'p0-auto-restart 重启事由登记'], skipPolicy: 'skip', source: 'tickd' },
  // 分身僵留自动收官（2026-10-10 · 卡「冲刺600·补守护鱼」F-B2 → tickd job `repair-linger`）。
  //   【本行来由 · 2026-10-10 卡「冲刺600·A域宪章层三件」】`butler-registry-audit` 的
  //   **J3「锁登记完整」**当场报红：调度表 44 个 job 里**只有它**没登记锁 ⇒ 本卡补登。
  //   ⚠️ 判据 = 脚本自身**有没有** `acquireTickLock`（不是"是不是新 job"）：
  //   `butler-repair-linger-tick.mjs` **没有** ⇒ 按 watchfs / daily / weekly / imagegen* 同款先例
  //   填 `lockRunner: true`（tickd 经 `lib/tick-job-runner.mjs` 包装层抢锁 → 动态 import → 释放）。
  //   为什么必须加锁：该 job 会写**唯一账本** `butler-repair-linger.json` 并 spawn `repair-ctl.mjs finish`
  //   （真动作）；而它同时有**手工入口**（`--go` 绕过配置单次真跑）⇒ 手工与 tickd 并发会双写账本、
  //   同时收官同一分身。job 本身默认关（`butler-repair.json#lingerAutoFinish` 缺省 false）
  //   ⇒ 本次登记**不改变默认行为**（加的是并发保护，不是新动作）。
  //   TTL 5 分钟：一轮 = 读 watch 状态 + 判定 + 可能的 `repair-ctl finish`（秒级~分钟级），给足余量。
  { job: 'repair-linger', lockName: 'repair-linger', script: 'butler-repair-linger-tick.mjs', ttlMs: 300_000, intervalMs: 30 * 60 * 1000,
    critical: ['butler-repair-linger.json（账本，本 job 唯一写者）', 'butler-repair.json（只读开关）',
      '**真动作**：调 `repair-ctl.mjs finish` 收官分身'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无 acquireTickLock：手工 `--go` 直跑与 tickd 并发会同时写账本并同时调 repair-ctl finish' },

  // 心情播报定时（2026-11-02 · 跨线派活：the operator<mainline>线 → butler线 · 判据 14-c 保新鲜 · 技术债 TD-35）
  //   脚本 `broadcast.mjs` **自身没有** acquireTickLock（独立小件，不 import butler 任何东西）
  //   ⇒ 按 repair-linger / watchfs 同款填 `lockRunner: true`（tickd 经 lib\tick-job-runner.mjs 包装层抢锁）。
  //   为什么必须加锁：它写唯一产物 `~/.dsh/feiyu-mood-broadcast/<机器名>.json`，且**有手工入口**
  //   （人会直接 `node broadcast.mjs` 补一次）⇒ 手工与 tickd 并发会同时写同一份播报件。
  //   TTL 60s：一轮 = 读 state（几十 KB）+ 算 sha + 写几百字节，秒级完成，给足余量。
  { job: 'mood-broadcast', lockName: 'mood-broadcast', script: 'broadcast.mjs', ttlMs: 60_000, intervalMs: 15 * 60 * 1000,
    critical: ['feiyu-mood-broadcast/<机器名>.json（本机唯一产物 · 对端只读拉取）', '只读 feiyu-mood/state.json（禁写，写完自证 sha）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无 acquireTickLock：手工直跑与 tickd 并发会同时写同一份播报件' },
  // 统筹线 R1-6 · Router 守护与巡检（2026-11-02 · 卡「统筹线 R1-6」· tickd job `router-guard`）
  //   脚本**自身有** `acquireTickLock('router-guard')` ⇒ 按 queue / stuck-recovery 同款**不加 `lockRunner`**
  //   （包装层再抢同一把锁会让子进程永远判 locked，steward 同款先例）。
  //   为什么必须加锁：它写三处共享件 —— `workspace.json`（经 RPC 置顶 / 解归档）、
  //   `~/.dsh-qqbot/model-prefs.json`（钉子改写）、`~/.dsh/butler-alert.log`（报警一行）；
  //   且有**手工入口**（人会直接 `node router-guard.mjs --apply` 补一次）⇒ 手工与 tickd 并发会同时改 prefs。
  //   TTL 2 分钟：一轮 = 读三份文件 + 最多 2 次写 RPC（实测 300~500ms，最慢也秒级），给足余量。
  { job: 'router-guard', lockName: 'router-guard', script: 'router-guard.mjs', ttlMs: 120_000, intervalMs: 30 * 60 * 1000,
    critical: ['workspace.json（经 RPC insertBefore / unarchiveSession，只动 Router 那一组 / 那一个会话）',
      '~/.dsh-qqbot/model-prefs.json（钉子改写 · 只动 sessionIds，不碰 presets）',
      '~/.dsh/butler-alert.log（报警一行）', '~/.dsh/router-guard-state.json（只写自家状态件）'],
    skipPolicy: 'skip', source: 'tickd' },
  // 统筹线 · 年轮判据 A-3（2026-11-05 · 卡「Router 年轮 A1A3」· tickd job `router-digest`）
  //   脚本 `router-act.mjs digest --auto` **自身有** `acquireTickLock('router-digest')`（只在 --auto 分支抢）
  //   ⇒ 按 queue / router-guard 同款**不加 `lockRunner`**：router-act 的 main() 是异步的，包装层
  //      import 一返回就放锁 + 读 `process.exitCode` ⇒ 真失败会被吞（router-guard 同款先例）。
  //   为什么必须加锁：它写唯一共享件 `docs/`（结论档 —— Router 每轮读它拼槽位），
  //   且有**手工入口**（Router 会直接 `node router-act.mjs digest --auto --apply` 补一次）⇒
  //   手工与 tickd 并发会双写同一份档（同线同日两行，readSlots 只认先出现者）。
  //   TTL 2 分钟：一轮 = 一次看板 GET + 最多 16 次追加（实测秒级），给足余量。
  { job: 'router-digest', lockName: 'router-digest', script: 'router-act.mjs', ttlMs: 120_000, intervalMs: 0,
    critical: ['docs/（结论档：每条有活主线一行 · 幂等键 线名+日期 · ≤16 行 × 每行 ≤120）',
      '~/.dsh/router-ops.jsonl（动作流水，一轮一行）'],
    skipPolicy: 'skip', source: 'tickd' },
  // 统筹线 · Router 静默收信（2026-11-06 · 卡「Router 静默收信」· tickd job `router-inbox-flush` · 方案 §4.7-2）
  //   脚本 `router-inbox-flush.mjs` **自身有** `acquireTickLock('router-inbox-flush')`（job 锁）
  //   ⇒ 按 router-guard / router-digest 同款**不加 `lockRunner`**。
  //   🔴 **两把锁是两个名字，别混**：本行登记的是 job 自己的 `router-inbox-flush`；
  //     数据写口用 `router-inbox`（push / claim / rotate 三条互斥）—— 那条**不登记**
  //      （它不是调度 job，auditRegistry 只要求"调度表里的 job 有登记"）。
  //      混成一把的后果：一次 5 分钟的空转 job 会把各线的 push 全堵住。
  //   TTL 60s：一轮 = 读三份小档 + 一次 session.list + 一次 spawn session-say；判档与记账都是毫秒级。
  { job: 'router-inbox-flush', lockName: 'router-inbox-flush', script: 'router-inbox-flush.mjs',
    ttlMs: 60_000, intervalMs: 5 * 60 * 1000,
    critical: ['router-inbox.jsonl（只读；写由 router-inbox push 走它自己的 tick 锁）',
      'router-inbox-flush.json（日/时批次计数）', 'router-inbox-target.json（Router 归属缓存）',
      'router-ops.jsonl（投递流水，一轮一行）'],
    skipPolicy: 'skip', source: 'tickd' },
  { job: 'watch', lockName: 'p2-watch', script: 'dsh-butler-watch.mjs', ttlMs: 600_000, intervalMs: 300_000,
    critical: ['butler-watch-state.json', 'docs/', '桌宠 /whale/say'], skipPolicy: 'skip', source: 'tickd' },
  { job: 'barewatch', lockName: 'barewatch', script: 'barewatch-tick.mjs', ttlMs: 120_000, intervalMs: 300_000,
    critical: ['butler-barewatch-state.json'], skipPolicy: 'skip', source: 'tickd' },
  { job: 'watchfs', lockName: 'watchfs', script: 'butler-watch-fs.mjs', ttlMs: 600_000, intervalMs: 600_000,
    critical: ['butler-watch-fs-state.json', '%TEMP%/butler-watch-snap', '：违规可回滚生产文件'], skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无 acquireTickLock：计划任务/手动直跑可绕过 tickd 并发踩状态文件与快照' },
  //   ⚠️ 该 job 声明 `benignExitCodes:[5]`（**V31-039 · 2026-11-04**）：5 = 「坑库真源不可用 ⇒ 拒渲染」，
  //     与网络/锁类让路（那种是 3）刻意分开 —— 退出码本身当判据用，手跑 `--once pitfall` 直接看 rc。
  //     拒渲染 = 一个文件都不写 + 🔴 告警（文案带真源绝对路径），故它**不动**任何一个 `critical` 路径。
  { job: 'pitfall', lockName: 'p4-pitfall', script: 'pitfall-tick.mjs', ttlMs: 600_000, intervalMs: 1_800_000,
    critical: ['butler-pitfalls.json', 'docs/', 'butler-p4-candidates.json'], skipPolicy: 'skip', source: 'tickd' },
  { job: 'external', lockName: 'butler-external', script: 'butler-external.mjs', ttlMs: 1_200_000, intervalMs: 3_600_000,
    critical: ['butler-external-state.json', 'external-sources.json'], skipPolicy: 'skip', source: 'tickd' },
  // P7 会照应（看板卡 [8]，2026-09-12 交付）：每日 09:10 对账 —— **新增 job 必须同步登记**，
  //   否则 H1b-prep 建立的「tickd 全部 job 都有锁登记」不变量单测会红（2026-09-12 验收时实测抓到）。
  { job: 'reconcile', lockName: 'p7-reconcile', script: 'butler-reconcile.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['butler-reconcile-state.json', 'butler-entities.json', 'docs/report-dir 的「💡 统筹提示」段（经 report.mjs）'], skipPolicy: 'skip', source: 'tickd' },
  // 官方上游动态（2026-09-15 新增，the operator拍板「每天盯一次」）：每日 09:20 抓 deepseek-ai/deepseek-harness
  //   的内容级增量（compare API 提交明细 / 热点 / 断裂面符号告警）。
  //   TTL 15 分钟：正常秒级，但慢网下 compare API 单次超时上限就有 25s，给足余量。
  //   脚本自带幂等（基线推进）+ 只读，抢不到锁静默跳过即可 —— 第二天照跑，不丢内容。
  { job: 'upstream', lockName: 'upstream', script: 'dsh-upstream-watch.mjs', ttlMs: 900_000, intervalMs: 0,
    critical: ['~/.dsh/upstream-watch-<host>.json（基线，按主机分文件）', 'docs/'],
    skipPolicy: 'skip', source: 'tickd' },
  // 微信官方 SDK 版本盯梢（2026-10-30 · the operator 17:20 拍板）：每天 10:10 只读查 npm `latest`，
  //   与基线 2.4.10 不同 ⇒ 写一条 info 告警（同一版本只喊一次）。脚本**不装包、不升级**。
  //   TTL 15 分钟：正常秒级；`--deep`（默认不启用）内含 npm pack，给足余量。
  //   脚本自带幂等（lastAlertedVersion）+ 只读，抢不到锁静默跳过即可 —— 第二天照跑，不丢结论。
  { job: 'wechat-sdk-watch', lockName: 'wechat-sdk-watch', script: 'wechat-bridge/watch-official-sdk.mjs', ttlMs: 900_000, intervalMs: 0,
    critical: ['~/.dsh/wechat-sdk-watch-state.json（基线 + 已告警版本）', '~/.dsh/butler-alert.log（版本变化时一行）'],
    skipPolicy: 'skip', source: 'tickd' },
  // 升级巡检（2026-09-15 · 卡 S8「升级分级授权·A3」②「巡检载体重建」）：
  //   载体 = tickd job（**0 token**，不建卡、不唤起 LLM 会话）；每日 09:30 触发、脚本内月频闸
  //   （默认 1/15，配置 ~/.dsh/upgrade-automation.json 的 patrol.days）决定是否真出报告。
  //   只读：读决策表 + 三件只读工具 → 定档 → 落一份只读报告；**不承接任何升级动作**（口径 §6 D3）。
  //   抢不到锁静默跳过即可（第二天的巡检照跑，不丢结论）。
  { job: 'upgrade-patrol', lockName: 'upgrade-patrol', script: 'dsh-upgrade-orchestrator.mjs', ttlMs: 900_000, intervalMs: 0,
    critical: ['docs/（只读报告）',
      '~/.dsh/upgrade-automation.json（只读：总闸默认 false）'],
    skipPolicy: 'skip', source: 'tickd' },
  { job: 'daily', lockName: 'daily', script: 'dsh-butler-panel/report.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['docs/'], skipPolicy: 'skip', source: 'both',
    lockRunner: true, lockRunnerReason: '脚本自身无锁：日报有多个生成入口（开机钩子/手工/tickd）会整份重写' },
  { job: 'weekly', lockName: 'weekly', script: 'dsh-butler-panel/report-weekly.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['docs/'], skipPolicy: 'skip', source: 'both',
    lockRunner: true, lockRunnerReason: '脚本自身无锁：周报可被手工/tickd 双入口重写' },
  // 冷备作业（**三 job 归并** · the operator 2026-10-13 16:12 拍板 #12/#13）：
  //   一个 job 按序跑两件（回滚点打包 + 生图索引/镜像），两件**各自**解析冷备根、都不写死盘符 ——
  //   回滚点根见 tools/lib/rollback-points-root.mjs，生图根见 tools/lib/imagegen-backup-root.mjs。
  //   ⚠️ 归并前这里登记的是三条（imagegen / imagegen-full / rollback-offsite）—— 已随归并移除；
  //     它们对应的 job 表位在 butler-tickd.mjs 的 JOBS 里也一并删除（锁表 ↔ 调度表的关系由
  //     butler-registry-audit.mjs 的 J3 单向保证：**调度表里每个 job 都要有锁登记**）。
  //   TTL 给 1h：最重的两件是图片增量镜像与首次全量打包（实测 20s 量级），慢盘/量增长也要够用。
  { job: 'coldbackup', lockName: 'coldbackup', script: 'coldbackup.mjs', ttlMs: 3_600_000, intervalMs: 0,
    critical: ['冷盘 <本机默认盘>/dsh-rollback-points（points/* 快照 + 保留策略清理，只读源 _archive）',
      '冷盘 <本机默认盘>/dsh-imagegen-backup（索引快照 + 图片镜像，只读源 ~/.dsh/dsh-imagegen）',
      '~/.dsh/rollback-offsite-<host>.json（状态）', 'logs/rollback-offsite-alert.log（升级告警流水）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无锁：coldbackup.mjs 与它调的两个备份脚本都可被手工直跑（冷备作业单/排障）与 tick 并发' },
  // 【主线停滞提醒 v1 · 2026-10-23】tickd job `stall-nudge`（工作日 08:30 · 微信真发）。
  //   为什么要锁：脚本会写 `~/.dsh/butler-stall-nudge.json`（lastPushDate + 每 key 冷却）并**真发微信**；
  //   手工直跑（排障 / 补推）与 tickd 并发会双写状态、可能同一批推两次 ⇒ 走包装层单实例。
  //   TTL 10 分钟：一轮 = 读看板 + stat/读 stale 交接档 + 一次微信发送（秒级~分钟级），给足余量。
  { job: 'stall-nudge', lockName: 'stall-nudge', script: 'stall-nudge.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['~/.dsh/butler-stall-nudge.json（同日去重 + 24h 冷却）',
      'docs/（完整候选清单）', '**真动作**：微信 iLink 发送 Top N（serverId 为成功判据）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无 acquireTickLock：手工直跑与 tickd 并发会双写状态并可能重复发微信' },
  // ⚠️ **锁名订正（2026-09-17 · ③-2 跨线契约包 C-3）**：原写 `'tidy'`，与脚本**实际抢的锁**不一致 ——
  //   脚本走 `lib/scheduler.mjs:130` 的 `acquireTickLock(`${name}-${task.id}`)`，而
  //   `butler-tidy-tick.mjs` 的 `TICK_NAME='tidy'` + `COLLECTOR_ID='audit'` ⇒ 真锁名是 **`tidy-audit`**
  //   （→ `tick-tidy-audit.lock`；该脚本被 `createScheduler({name:TICK_NAME})` 注册，采集器 id=COLLECTOR_ID）。
  //   改前是「登记失真」：将来 tidy 接进 tickd 时，tickd 抢 `tick-tidy.lock`、脚本再抢 `tick-tidy-audit.lock`
  //   ⇒ 双层锁 + 交接侧推不出 tidy 的真实锁。**本行必须恒等于 `${TICK_NAME}-${COLLECTOR_ID}`**
  //   （机械校验 = `_test/test-tidy.mjs` ⑦ 段的「锁名零差集」断言；方案 §5 判据 2）。
  // ── 2026-09-29（卡「P8 tidy 接调度」）：tidy 正式接进 tickd 的 JOBS ─────────────────────────
  //   本行的三处**如实更新**（锁名/脚本/形态一个字没动，只改登记口径）：
  //   ① `source: 'schtasks'` → `'tickd'`：旧口径来自 P8 方案 §7.1 的原始形态（计划任务短命脚本），
  //      而本机 360 企业 EDR 已把整套计划任务清废（`DSH-Butler-*` 查无此任务、也无注册脚本），
  //      2026-09-29 起由常驻 `butler-tickd.mjs` 唯一驱动 ⇒ 驱动入口类型 = 'tickd'。
  //   ② `intervalMs: 0` → `12 * 60 * 60 * 1000`：与 JOBS 的 `intervalMs: 12 * 60 * MIN` 和脚本自报的
  //      `INTERVAL_MS` 三者同值（0 = 日历/手工 的旧登记已失真，会误导 TTL 推导读者）。
  //      **2026-09-29 the operator令「tidy 改 12 或者 24 小时放行」⇒ 6h → 12h**，四处同批改（本行 / JOBS /
  //      脚本常量 `INTERVAL_MS` / 单测断言）；机械守门 = `_test/test-tidy.mjs` ⑦ 段。
  //   ③ **刻意不填 `lockRunner`**（与 `memory-distill` / 四动作同款处置）：脚本自身就是
  //      `createScheduler({name:'tidy'})` 的执行体、自带 `acquireTickLock('tidy-audit')`
  //      ⇒ tickd 抢同名的 `tick-tidy-audit.lock` 并注入 `DSH_BUTLER_TICK_LOCK_HELD` 后，
  //      子脚本走 store 的「锁继承 → 内存虚拟锁」（零 I/O）。填 `lockRunner:true` 会变成
  //      包装层与脚本各抢一次 = **双层锁**，job 每轮都会被误判 locked 而永不执行（B1 四动作栽过）。
  //      ⚠️ 反例对照：`watchfs`/`daily`/`weekly`/`imagegen*`/`secretary-morning`/`memory-vectors`
  //      那 6 类**脚本自身无锁**才必须走包装层 —— 判据 = 脚本有没有 acquireTickLock，不是"是不是新 job"。
  //   TTL 600_000（10 分钟）沿用原值：一轮 = 全树 `_tmp`/`_archive` 遍历（junction 不穿透）+ 9 检查点
  //     审计 + 原子写状态文件，实测秒级~十秒级；tickd 侧另有续期兜底（`renewTickLock`）。
  { job: 'tidy', lockName: 'tidy-audit', script: 'butler-tidy-tick.mjs', ttlMs: 600_000, intervalMs: 12 * 60 * 60 * 1000,
    critical: ['butler-tidy-state.json（只写：状态 + lane 让路段）', '收纳审计报告 / 自己的审计流水（butler-audit）',
      '**只读**被审计对象：_tmp / _archive 不搬移、不删除、不改名'],
    skipPolicy: 'skip', source: 'tickd' },
  // 交接器本身（H1a 已持锁）——T2 只登记，**不接管**：H1b 才接 drain 语义。
  { job: 'handoff', lockName: 'handoff', script: 'handoff.mjs', ttlMs: 3_600_000, intervalMs: 0,
    critical: ['三仓工作副本', '生产路径分发', '交接单'], skipPolicy: 'busy', source: 'manual' },
  // 热采（H1b · §8 30 分钟档）——**与交接器共用同一把锁 `tick-handoff.lock`**（§5.3 第 6 条 R12：
  //   四类触发源共用 butler-scheduler 单例）。所以它**不是**新锁，而是同一把锁的第二个入口：
  //     · tickd 跑 hot job → 抢到 tick-handoff.lock，注入 DSH_BUTLER_TICK_LOCK_HELD=handoff
  //       → hot-collect.mjs 里的 acquireTickLock('handoff') 走继承虚拟锁，不会双层互斥打架；
  //     · 手工跑 handoff.mjs --depart → 同一把锁抢不到 → 走 drain 等待（waitMs=120s），等热采结束。
  //   TTL 45 分钟：热采正常秒级~分钟级；给足余量覆盖大会话首次全量搬运。
  { job: 'hot', lockName: 'handoff', script: 'hot-collect.mjs', ttlMs: 45 * 60 * 1000, intervalMs: 30 * 60 * 1000,
    critical: ['三仓工作副本（只读生产侧）', '看板账本走 Host API 导出', '会话<sync-repo>（只搬已闭合）'],
    skipPolicy: 'skip', source: 'tickd' },
  // 跨机文本同步（2026-10-11 · 卡「文件同步」· the operator 01:11 令）——
  //   **第四个共用 `handoff` 锁的入口**（前三个：hot-collect、memory-snapshot、handoff 本身）：
  //   本 job 写**<sync-repo> 与<sync-repo> 的同一个工作副本**（`.agent-presets` / `docs`）+ commit + push，
  //   并**回灌**生产（`~/.dsh/.agent-presets` / `<butler-root>\docs`）⇒ 与 hot 动的是同一批 git 对象，
  //   并发会撞 index.lock / 采到中间态。共用锁 = 天然互斥（`skipPolicy:'skip'` ⇒ 撞上就本轮让路）。
  //   TTL 20 分钟：一轮 = fetch/ff-pull（秒级~分钟级）+ 回灌（几十文件）+ 采集（首次 1286 个文本文件
  //     实测 ~13s）+ 超集体检（**实测 23.7s**）+ commit + push（首次 ~46MB）。
  //   intervalMs=60 分钟与 JOBS 表同值（派生 TTL = max(2×interval, 5min) 会算出 2h ⇒ 显式给 ttlMs）。
  { job: 'text-sync', lockName: 'handoff', script: 'text-sync.mjs', ttlMs: 20 * 60 * 1000, intervalMs: 60 * 60 * 1000,
    critical: ['<sync-repo> `dsh/.agent-presets` + <sync-repo> `docs`（**写**：采集 + commit + push）',
      '生产 `~/.dsh/.agent-presets`（**写**：只在"本轮 pull 带进来"的文件上回灌；逐文件备份 + 一键回滚）',
      '生产 `<butler-root>\\docs`（**写**：同上；report-dir / 坑库**排除**）',
      '~/.dsh/butler-text-sync.json（状态 + 近 48 轮）+ butler-audit / butler-alert（**只追加**）'],
    skipPolicy: 'skip', source: 'tickd' },
  // 记忆库每日热采（2026-09-17 · 卡「记忆库每日 1 次热采 + 内容未变不推」）——
  //   **第三个共用 `handoff` 锁的入口**（前两个：hot-collect、handoff 本身）：
  //   本 job 会写<sync-repo> 工作副本（`dsh/memory/memory.db`）+ commit + 走既有推送链路
  //   （`dsh-backup-sync.ps1 -Push`），与 hot / Depart / Arrive 动的是**同一个工作副本**
  //   ⇒ 并发会把工作副本搅成中间态 / index.lock 打架（§5.3 第 6 条 R12）。共用锁 = 天然互斥。
  //   TTL 45 分钟与 hot 同值：一轮 = VACUUM INTO（~30ms）+ sha 比对 + 可能的 copy/commit +
  //     push 前的超集体检（node 子进程，秒级~分钟级）；给足余量。
  //   intervalMs=0：日历型（每日 04:20），TTL 由 ttlMs 显式给出。
  { job: 'memory-snapshot', lockName: 'handoff', script: 'memory-snapshot.mjs', ttlMs: 45 * 60 * 1000, intervalMs: 0,
    critical: ['<sync-repo> 工作副本 `dsh/memory/memory.db`（**只在内容变化时**写 + 提交 + 推）',
      '生产 memory.db（**只读**：VACUUM INTO 到临时目录，本体绝不改）',
      '~/.dsh/butler-memory-snapshot.json（状态）+ butler-alert.log（失败/让路告警）'],
    skipPolicy: 'skip', source: 'tickd' },
  // 会话异地镜像（2026-09-20 · the operator拍板「主推 <host>，<sync-repo> 瘦身」）——
  //   把会话（活跃+归档）+ 附件实体增量镜像到 **<host> 本地盘**，与三仓工作副本**零交集**
  //   （它只读生产 `~/.dsh`、只写对端 `<butler-root>-session-mirror`）⇒ **独占新锁** `session-mirror`，
  //   刻意**不**与 `handoff` 共用：共用会让"每小时一次"的镜像被热采/交接长时间挡住。
  //   TTL 30 分钟：首轮全量 1.34GB 实测 112s，日常增量 4~6s；给慢网与对端老机器留足余量。
  //   `lockRunner: true`：脚本自身无 acquireTickLock（可被手工直跑）⇒ 由 tickd 包装层抢锁，
  //   避免手工直跑与 tick 并发重复传输、争状态文件。
  { job: 'session-mirror', lockName: 'session-mirror', script: 'dsh-session-mirror.mjs', ttlMs: 30 * 60 * 1000, intervalMs: 60 * 60 * 1000,
    critical: ['<host> `<butler-root>-session-mirror\\rog\\.dsh`（镜像目标，**只增不删**：远端永不 purge）',
      '生产 `~/.dsh/{sessions,_archived-sessions,attachments}`（**只读**）',
      '~/.dsh/butler-session-mirror.json（增量状态）',
      // 【R9 · 2026-10-14】按需短租：通道（lan/隧道）都不通时经 `relay-cli` 短租 —— **会写**下面这些
      //   （与 relay-ondemand job 的写对象重叠；窗口 = 本轮传输期间、收尾立刻 `down`，按公司有线网短租纪律）。
      //   登记而不加锁：两边的锁名本就不同（session-mirror / relay-ondemand-job），加锁会互相挡住常活。
      '~/.dsh/relay/{relay-config.json,tunnel.pid.json,short-lease.json}（**仅按需短租时**经 relay-cli 写；用完即 down）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无 acquireTickLock：可被手工直跑（--full/--limit），与 tick 并发会重复传输并竞争状态文件' },
  // ── 跨机骨架 · 第三柱（2026-10-11 · 卡【多端线·骨架第三柱】S4）─────────────────────
  //   方案真源 = `docs/` §4.2。
  //   ⚠️ **本行与 JOBS 表的 mirror-audit 行必须同批落地**（只加一边 ⇒ `auditRegistry` 的
  //      J3「调度表 job 未登记锁：mirror-audit」当场 ❌）。
  //   为什么**独立锁**、不与推送 job `session-mirror` 共用：① 共用 ⇒ 核对撞上推送会被
  //      `skipPolicy:'skip'` 静默跳过，而**周频 job 一跳就等一周**；② 核对走 `--audit-remote`
  //      全程**只读**状态文件（方案 §2.6）⇒ 与推送**没有共享写对象** ⇒ 独立锁无丢更新风险。
  //   `ttlMs` 600 s：> 实测单次 6.1 s，< 推送锁的 30 min（只保"不会永久占锁"）。
  //   `intervalMs: 0`：**日历型**（`at:'SUN 10:30'`）—— 注册表契约明写「0 = 日历型/手工，不参与
  //      TTL 推导」；同类日历型 job（imagegen-full / rollback-offsite / daily / weekly）全为 0。
  //      ⚠️ 写"一周的毫秒数"会被锁表渲染成 `10080m` ⇒ 读数失真（不影响运行），故写 0。
  //   `critical` 一律标 **（只读）**：本 job 不写这些载体（避免被读成"会写状态文件"）
  //      —— 它自己写的只有 `docs\report-dir\mirror-audit-*`（本机新件、不与推送族共享）。
  { job: 'mirror-audit', lockName: 'mirror-audit', script: 'dsh-session-mirror.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['~/.dsh/butler-session-mirror.json（**只读**：核对全程不写状态文件，方案 §2.6）',
      '远端镜像根（**只读**列目录）+ 远端盘读数（`fsutil`，只读）',
      'docs/report-dir/mirror-audit-*.{json,md}（本 job 自己写；与推送族零交集）',
      // 【R9 · 2026-10-14】同推送轮：通道全不通时**按需短租**（周频核对"一跳等一周"，让路代价更高）
      '~/.dsh/relay/{relay-config.json,tunnel.pid.json,short-lease.json}（**仅按需短租时**经 relay-cli 写；用完即 down）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 四动作接线（2026-09-15 卡 B1）：lockName 刻意 == 子脚本内调度器的锁名 `p3-auto-<jobId>` ──
  //   原因：tickd 抢到锁后 spawn 子脚本时注入 `DSH_BUTLER_TICK_LOCK_HELD=<lockName>`，
  //   `store.acquireTickLock` 见自己的锁名已在列表里 → 返回**内存虚拟锁**（零 I/O）。
  //   锁名一致才不会出现"父子双层加锁互相打架"（那会让每个 job 都被误判 locked 而永不执行）。
  //   TTL：动作体每次含只读采集（看板 HTTP / 会话列表 / 生态面板 state）→ 给足 15 分钟；
  //   auto-heal 放行后可能 spawn 修复脚本（幂等补丁重打），TTL 30 分钟。
  { job: 'queue-wake', lockName: 'p3-auto-wake', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 300_000,
    critical: ['~/.dsh/butler-auto-actions.json（仅放行后写：签名/额度）', '~/.dsh/butler-queue.json（只读台账）',
      '本动作只注入会话提醒：不改看板 / 不验收 / 不起卡'],
    skipPolicy: 'skip', source: 'tickd' },
  { job: 'p0-auto-restart', lockName: 'p3-auto-restart', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 300_000,
    critical: ['~/.dsh/butler-auto-actions.json（仅放行后写）',
      '%TEMP%/dsh-guard/restart-request.json（仅放行后写：经既有 P0 闸门）', '只发请求、不直接重启'],
    skipPolicy: 'skip', source: 'tickd' },
  { job: 'p5-auto-rollback', lockName: 'p3-auto-rollback', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 600_000,
    critical: ['~/.dsh/butler-watch-fs-state.json（只读）', 'B 层快照回写生产文件（仅放行后）',
      '%USERPROFILE%/.dsh/butler-audit/*.jsonl（留痕）'],
    skipPolicy: 'skip', source: 'tickd' },
  { job: 'auto-heal', lockName: 'p3-auto-heal', script: 'butler-auto-tick.mjs', ttlMs: 1_800_000, intervalMs: 3_600_000,
    critical: ['幂等补丁重打（仅放行后；各 patch 脚本自带备份）',
      '闭包 junction / package-map 指向重建（仅放行后）', '%USERPROFILE%/.dsh/butler-audit/*.jsonl（留痕）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-09-16（卡：P3 自主动作 ctx-guard · 上下文看门）────────────────────
  //   lockName 刻意 == 子脚本内调度器的锁名 `p3-auto-<jobId>`（`lib/scheduler.mjs` 的 `${name}-${id}`，
  //   name='p3-auto'）—— 否则父子双层加锁互相打架，job 会被误判 locked 而永不执行（既有口径）。
  //   TTL 15 分钟：动作体每轮含一次只读 session.list 采集（HTTP，秒级）；给足余量。
  { job: 'ctx-guard', lockName: 'p3-auto-ctx-guard', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 300_000,
    critical: ['~/.dsh/butler-auto-actions.json（仅放行后写：签名/额度）',
      '本动作只往在跑会话投递提醒文本（queue 模式、不打断）：不改会话数据 / 不改看板 / 不改配置'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-09-16（卡：[盯卡巡检] 假结算 / 假 running 常驻巡检 + 主动通知）──────────
  //   判据/通知全部复用现成件（queue-watch 的 isExecutionAlive + queue 通道）；
  //   本 tick 只写自己的台账（butler-card-watchdog.json）+ 日报段 + 桌宠/会话提醒。
  //   TTL 2 分钟：一轮 = 两次只读 HTTP（看板 state ~1.4MB + session.list）+ 判定，秒级；
  //   锁名 == 脚本内 acquireTickLock('card-watchdog')（父子双层加锁会互相打架，见上文口径）。
  { job: 'card-watchdog', lockName: 'card-watchdog', script: 'butler-card-watchdog-tick.mjs', ttlMs: 120_000, intervalMs: 300_000,
    critical: ['~/.dsh/butler-card-watchdog.json（巡检台账）',
      '看板 state + session.list（**只读**）；本动作只提醒 —— 不改卡状态 / 不写看板账本 / 不重启'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-09-17（卡：裸跑 L1 放行收尾 · 待办 B）：`evidence-precheck` 接 tickd ──────────
  //   lockName 刻意 == 子脚本内调度器的锁名 `p3-auto-<jobId>`（`lib/scheduler.mjs:130` 的 `${name}-${id}`，
  //   name='p3-auto'、子脚本内 job id='precheck'）—— 父子锁名不一致会让 job 被误判 locked 而永不执行。
  //   TTL 15 分钟：一轮 = 看板 state 只读（HTTP，~1.4MB）+ 逐卡证据路径 fs 核验（秒级）；给足余量。
  { job: 'evidence-precheck', lockName: 'p3-auto-precheck', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 600_000,
    critical: ['~/.dsh/butler-precheck.json（预检台账）', '看板 state（**只读**）',
      '本动作只核验证据（不改卡 / 不写看板账本 / 不验收 —— 改卡属 L3）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-09-17（卡：P9「H4 butler接入」子项 · Arrive-B）────────────────────
  //   接机后看板账本并回（tickd job `arrive-b`，默认关）。**与 `hot` / `handoff` 共用 `handoff` 锁**：
  //   三者都读写同一批仓工作副本（<sync-repo> 对端交接单 / <sync-repo> 对端看板快照），并发跑会把工作副本搅成中间态
  //   （§5.3 R12「四类触发源共用单例锁」；共用已登记在 ALLOWED_SHARED_LOCKS.handoff）。
  //   TTL 30 分钟：一轮 = 读 2.4MB 级快照 + 1~2 次 board-merge（含 Host HTTP 往返与账本读）+ 复核
  //   dry-run，秒级~分钟级；给足余量（与脚本内 LOCK_TTL_MS 同值）。
  //   ⚠️ 账本**只经 Host API 写入**（board-merge.mjs），本 job 绝不直接碰 ledger-v2.json。
  { job: 'arrive-b', lockName: 'handoff', script: 'handoff-arrive-b.mjs', ttlMs: 30 * 60 * 1000, intervalMs: 15 * 60 * 1000,
    critical: ['三仓工作副本（**只读**：<sync-repo> `dsh/butler-handoff/*.json` 对端心跳 + <sync-repo> `tools/board-snapshots/` 对端快照）',
      '本机看板账本（**经 Host HTTP API** 由 board-merge.mjs 写入；apply 前自动备份 + 生成 restore.mjs，绝不手改 ledger）',
      '~/.dsh/butler-arrive-b.json（状态）+ logs/handoff/arrive-b-*.log + docs/'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-09-17（卡：P3 重复卡合并受控验收）：`dup-cards-merge` 接 tickd ──────────────
  //   锁名 = `p3-auto-dup`：**必须**等于子脚本内调度器的锁名 `${name}-${task.id}`
  //   （`lib/scheduler.mjs:130`，name='p3-auto'、子脚本内 job id='dup'）—— 父子锁名不一致会让
  //   job 被误判 locked 而永不执行（既有口径，见上方四动作接线注释）。
  //   ⚠️ 注意 job id ≠ 子脚本 job id：tickd 侧是 `dup-cards-merge`（与动作 kind 同名），
  //   spawn 的参数是 `--job dup`（AUTO_JOBS 短名）⇒ 锁名按**子脚本**那个 id 取。
  //   TTL 15 分钟：一轮 = 看板 state 只读（HTTP ~1.4MB）+ 逐卡 update/set-schedule 动作序列
  //   （每卡 2 次 HTTP）+ 动作前 state 快照（~2.8MB 落盘）；给足余量。
  { job: 'dup-cards-merge', lockName: 'p3-auto-dup', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 1_800_000,
    critical: ['本机看板账本（**经 Host HTTP API**：`update` 挂备注 + `set-schedule{enabled:false}` 清定时；**不删卡**）',
      '~/.dsh/butler-auto-actions.json（放行后写：24h 签名 / 每日额度）',
      '~/.dsh/butler-backups/p3-auto-backup-<日期>/state-<revision>-*.json（动作前快照）',
      '%USERPROFILE%/.dsh/butler-audit/*.jsonl（`dup-merge` 行，含 patches[].rollback 回滚数据）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-09-28（卡 K5d：看板周期归档接线 + 放行）：`board-line-archive` 接 tickd ─────────
  //   锁名刻意 == 子脚本内调度器的锁名 `p3-auto-<jobId>`（`lib/scheduler.mjs` 的 `${name}-${id}`，
  //   name='p3-auto'、子脚本内 job id='board-line-archive'）—— 父子锁名不一致会让 job
  //   被误判 locked 而永不执行（既有口径，见上方四动作接线注释）。
  //   TTL 15 分钟：一轮 = 看板 state 只读（HTTP live 视图）+ 逐线 CLI（单条超时 120 s，归档为秒级）；
  //   给足余量。
  { job: 'board-line-archive', lockName: 'p3-auto-board-line-archive', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 1_800_000,
    critical: ['本机看板账本（**经 Host HTTP API**：`board-archive-line.mjs --line … --apply --emit-restore`；**绝不手改 ledger-v2.json**）',
      '~/.dsh/butler-auto-actions.json（24h 签名 / 每日额度）',
      '归档批次目录 ~/.dsh/task-board/archive/<batchId>/（cards.json + manifest.json + archive-index.json）',
      '逐卡 restore 脚本（`--emit-restore` 产物）',
      '%USERPROFILE%/.dsh/butler-audit/*.jsonl（留痕）'],
    skipPolicy: 'skip', source: 'tickd' },

  // ── 2026-09-20（卡 G23-1：服务面主动推送 PM1 落地）：`secretary-morning` 接 tickd ────────────
  //   每日 **09:05** 早报取数（接在 `daily` 09:00 之后、静默期之外）；**默认关**（交付≠放行；
  //   放行 = `butler-autonomy-cli.mjs job on secretary-morning` **且** 闸文件 `switches.push=true`）。
  //   ⚠️ **新增 job 必须同步登记**（不变量 = "tickd 全部 job 都有锁登记"，由 registry-audit 的 J3
  //      断言 + `_test/test-auto-actions-wire.mjs` / `test-ctx-guard.mjs` / `test-handoff-gate.mjs`
  //      的「auditRegistry({jobs: JOBS}) 零问题」把守）—— 2026-09-12 `reconcile` 与 2026-09-20 本行
  //      是同一口径；**G23-1 交付时正是漏了这一行**，registry-audit 报 ❌（job 已注册、锁未登记）。
  //   本脚本**自身无 acquireTickLock**（职责仅两件：读日报抽白名单计数 → 交唯一出口
  //      `tools\secretary-notify.mjs`；它不发消息、不写台账、不判闸）⇒ 标 `lockRunner: true`
  //      走包装层（抢锁 → 动态 import → 释放），防"手动直跑 / 计划任务"绕过 tickd 与调度并发
  //      （同 `watchfs` / `daily` / `weekly` / `imagegen*` 先例）。
  //   TTL 10 分钟：一轮 = 读日报（~65 KB）+ 出口连企微长连接（连→认证→发→断，实测 <1 s）+ 写台账，
  //      秒级；给足余量。
  { job: 'secretary-morning', lockName: 'secretary-morning', script: 'secretary-morning.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['~/.dsh/secretary-push.jsonl（推送台账 · **追加写**）',
      '~/.dsh/butler-secretary.json（读总闸 `switches.push` + 写对账历史 `reconcile`）',
      'docs/（**只读**：早报取数源）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无锁：取数层可被手工直跑（node secretary-morning.mjs）与 tick 调度并发，共用同一份台账与闸文件' },

  // ── 2026-11-05（卡「记忆引擎第 4 期 · 路 B+」）：`memory-change-audit` 接 tickd ────────────────
  //   每天一次只读体检（假撤回 / 孤儿归档 / 关系脏边 / 老账基线漂移）。
  //   TTL 10 分钟：一轮 = 读 26 行台账 + 一次全库 `SELECT id, tags FROM memories`（3.6k 行）
  //     + 归档目录遍历；实测秒级，给足余量。`lockRunner:true` ⇒ 本 job 的脚本**自身无锁**，
  //     必须走包装层（判据 = 脚本有没有 acquireTickLock，不是"是不是新 job"）。
  { job: 'memory-change-audit', lockName: 'memory-change-audit', script: 'memory-change-audit-tick.mjs',
    ttlMs: 10 * 60 * 1000, intervalMs: 24 * 60 * 60 * 1000,
    critical: ['~/.dsh/memory/retractions.jsonl（**只读**：C1/C2/C3 三条判据的输入）',
      '~/.dsh/memory/memory.db（**只读** `readOnly` 打开：假撤回判据 + 关系 tag 形态）',
      '<butler-root>/_archive/memory-removed/plugin/（**只读**：孤儿归档 + 归档 ↔ 台账对账）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无锁：体检器具可被人工直跑（node memory-change-audit.mjs --all）与 tick 调度并发，共用同一份台账/归档目录' },
  // ── 2026-09-21（卡 S2c：记忆引擎 v2 运行化基础件）：`memory-vectors` 接 tickd ────────────────
  //   每小时：① **幂等启动编码桥**（`cli/serve-start.mjs`，已跑则跳过）
  //          ② **增量同步**（`cli/sync.mjs`：只读 `memory.db` → 写独立向量库）
  //          ③ **每周（ISO 周）1 段兜底 hash 轮转**（`cli/sweep.mjs`）。
  //   ⚠️ **新增 job 必须同步登记锁**（不变量 = 「tickd 全部 job 都有锁登记」，由 `auditRegistry({jobs:JOBS})`
  //      的「调度表 job 未登记锁」断言 + `_test/test-handoff-gate.mjs` / `test-ctx-guard.mjs` 把守）——
  //      2026-09-12 `reconcile`、2026-09-20 `secretary-morning` 两处都栽在这一行，别第三次。
  //   本脚本**自身无 acquireTickLock**（它只是编排层：探库 → 子进程调 serve-start / sync / sweep）
  //   ⇒ `lockRunner: true` 走包装层（抢锁 → 动态 import → 释放），防「手动直跑 / 计划任务」
  //      绕过 tickd 与调度并发踩同一份 state 与向量库（同 `watchfs` / `daily` / `weekly` /
  //      `imagegen*` / `secretary-morning` 先例）。
  //   TTL 30 分钟：一轮 = 桥探活（秒级，未跑则 1~3s 拉起）+ 增量同步（增量 0 条 ~1s；首次全量
  //      570 条实测 42s）+ 每周那一段 sweep（~2s）；中枢是 CPU 推理（<host>）⇒ 给足余量。
  { job: 'memory-vectors', lockName: 'memory-vectors', script: 'butler-memory-vectors-tick.mjs',
    ttlMs: 30 * 60 * 1000, intervalMs: 60 * 60 * 1000,
    critical: ['~/.dsh/butler-memory-vectors-state.json（同步进度 + 桥台账）',
      '~/.dsh/memory-vectors/（独立向量库 vectors.db · **可重建** · + bridge-port.json / bridge.log）',
      '~/.dsh/memory/memory.db（**只读**：`openMemorySource` 一律 readOnly ⇒ 本 job 绝不写生产记忆库）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无锁：可被手工直跑（node butler-memory-vectors-tick.mjs）与 tick 调度并发，共用同一份 state 与向量库' },

  // ── 2026-10-11（卡「跨机记忆库每小时自动同步」· the operator 01:11 令）：`memory-sync` 接 tickd ────────
  //   每小时一次跨机记忆库双向收敛（driver=<host> 取对端快照+合并+投递；follower=<host> 读 inbox+合并），
  //   合并完**紧接着**重建本机向量。
  //   ⚠️ **新增 job 必须同步登记锁**（不变量 = 「tickd 全部 job 都有锁登记」，由 `auditRegistry({jobs:JOBS})`
  //      的「调度表 job 未登记锁」断言把守）—— `reconcile`(09-12) / `secretary-morning`(09-20) /
  //      `memory-vectors`(09-21) 三处都栽在这一行，别第四次。
  //   本脚本**自身无 acquireTickLock**（它只编排：取快照 → 调 merge-memory CLI → 经包装层调向量）
  //   ⇒ `lockRunner: true` 走包装层，防「手动直跑 / 计划任务」绕过 tickd 与调度并发踩同一份 state / inbox。
  //   TTL 30 分钟：一轮 = 取对端快照（lan 秒级 / 隧道秒级 / 短租 ~5s）+ 合并（1200 余条读 + 短事务写，
  //      秒级）+ 投递 scp（约 4 MB，秒级）+ 向量（增量秒级；**首次全量实测 626 条 / 102s**）⇒ 余量充足。
  //   ⚠️ **与 `memory-vectors` 的关系**：`memory-vectors` 每小时、`memory-sync` **自 A53 起 15 分钟**
  //      （2026-10-26 the operator破例授权改一行；`intervalMs` 见 L374）；`initialMs` 仍刻意错开 180s（510s vs 690s）；
  //      本 job 调向量时经包装层抢 `tick-memory-vectors.lock`（**同一把**）⇒ 那个 job 在跑就本轮跳过。
  { job: 'memory-sync', lockName: 'memory-sync', script: 'mem-sync-tick.mjs',
    ttlMs: 30 * 60 * 1000, intervalMs: 15 * 60 * 1000,
    critical: ['~/.dsh/memory/memory.db（**写**：把对端快照合并进本机 —— `BEGIN IMMEDIATE` 短事务；'
      + '合并前自动 `VACUUM INTO` 快照到 `<butler-root>\\_archive\\memory-merge-*`，失败**不再**自动还原〔A45 起；快照只作人工恢复源〕）',
      '~/.dsh/butler-mem-sync-state.json（同步状态 + 近 48 轮历史；**只记条数/id，不记正文**）',
      '~/.dsh/memory-vectors/vectors.db（**写**：经包装层调 `memory-vectors`，与那个 job 抢同一把锁）',
      '<butler-root>-memory-sync\\inbox（driver 投递 / follower 取用；只留最近 `--keep` 个快照 —— A57 起 <host> 走 `--keep 96`，默认仍 24）',
      '<butler-root>\\_archive\\memory-merge-*（合并前快照目录；只留最近 `--keep` 个 —— 同上，<host> 现 96）',
      '对端（<host>）`<butler-root>\\tools\\dsh-butler\\mem-snapshot-remote.mjs`（**只读**调起：在数据所在机产 VACUUM INTO 快照）',
      // 【R12 · 2026-10-14 · 卡「memory-sync 短租语义切共用件」】按需短租期间会经 relay-cli 写
      //   `~/.dsh/relay/{short-lease.json,relay-config.json}` —— 与 `relay-ondemand` job 的写对象**重叠**
      //   （窗口 = 本轮开隧道那几十秒），照 R9 §3.5 同款「**登记而不加锁**」。改前也在写 relay-config
      //   （enable/up/down），R12 新增的只有**租约文件**；收尾只关"本次由我开的"。
      '~/.dsh/relay/{short-lease.json,relay-config.json}（**写**：按需短租 enable/up/down + 租约；与 relay-ondemand 写对象重叠）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true, lockRunnerReason: '脚本自身无锁：可被手工直跑（node mem-sync-tick.mjs）与 tick 调度并发，共用同一份 state / inbox / 归档目录' },

  // ── 2026-09-21（卡 S3c：记忆引擎 v2 · 夜间提炼）`memory-distill` 接 tickd ──────────────────
  //   语义 = 每天 04:10 跑一轮提炼（窗口内新增/变更记忆 → 向量聚类 → LLM 提炼 → 新增 distilled 条）。
  //   ⚠️ **锁名刻意 == 子脚本内调度器的锁名 `p3-auto-distill`**（`butler-auto-tick.mjs` 用
  //      `createScheduler({name:'p3-auto'})` + `AUTO_JOBS.distill` ⇒ 抢 `p3-auto-distill`）：
  //      tickd 抢到 `tick-memory-distill.lock` 后 spawn 子脚本时注入 `DSH_BUTLER_TICK_LOCK_HELD`，
  //      子脚本 `acquireTickLock` 见自己的锁名已在列表里 ⇒ 返回内存虚拟锁（零 I/O）。
  //      锁名不一致 ⇒ 父子双层加锁互相打架，job 每轮都被误判 locked 永不执行（B1 四动作栽过）。
  //   刻意**不填** `lockRunner`：本 job 的执行体就是 `butler-auto-tick.mjs`，它的调度器**自带**
  //      `acquireTickLock` ⇒ 再套一层包装层 = 双层锁（与 queue-wake 等四动作同款处置）。
  //   TTL 60 分钟：一轮 = 只读采集（记忆库 600 余条 + 向量库）+ **最多 20 次 LLM 调用**
  //      （单次实测冷启动 ~20s、超时上限 120s）⇒ 给足余量；tickd 侧另有续期兜底。
  //   intervalMs=0：日历型（每日 04:10），TTL 由 ttlMs 显式给出。
  { job: 'memory-distill', lockName: 'p3-auto-distill', script: 'butler-auto-tick.mjs', ttlMs: 60 * 60 * 1000, intervalMs: 0,
    critical: ['~/.dsh/memory/memory.db（**写**：新增 distilled 条；失败可 distill-rollback.mjs 整批回滚）',
      '~/.dsh/butler-distill-state.json（提炼进度 + 成本记账：调用次数 / token / 结果）',
      '~/.dsh/memory-vectors/vectors.db（**写**：只写 memories_dirty 台账的 consumed 标记）'],
    skipPolicy: 'skip', source: 'tickd' },
  // 小护士 case 保留期清理（2026-09-21 · 小护士 P2-A · G12/retention 行）——
  //   每日 04:40 扫 `~/.dsh-safe/case-*`，删超过保留期（默认 7 天）的现场包目录。
  //   ⚠️ **本 job 会真删目录（不可逆）** ⇒ 三重闸：① 脚本默认 dry-run（配置 `apply:true` 才真删）
  //      ② `case-*` 路径硬闸 + **不跟链接**（junction 递归删会跟删目标内容 —— persona 铁律）
  //      ③ 全程审计 + 报告留痕。
  //   TTL 10 分钟：扫描 + 目录体积统计（14 层）在 case 多/大时也要够；实际秒级。
  //   intervalMs=0：日历型（每日 04:40），TTL 由 ttlMs 显式给出。
  { job: 'nurse-retention', lockName: 'nurse-retention', script: 'dsh-nurse/retention.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['~/.dsh-safe/case-*（**删目录，不可逆**；默认 dry-run 零删除）',
      '~/.dsh/butler-nurse-retention.json（只读：真删放行开关，缺省 false）',
      '~/.dsh/butler-audit（审计留痕）+ <butler-root>\\logs\\nurse-retention-<日期>.md'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-10（卡「冲刺600·补坑库联动BCD」· C 点：坑聚类升级 · 方案 §5 / §C.2-4）─────────────
  //   每日 04:50 读坑库 + `source='pitfall'` 向量库 → 向量二级聚类 → 写 `~/.dsh/butler-p4-clusters.json`。
  //   ⚠️ **lockName 必须与脚本内 `acquireTickLock` 的名字逐字相同**（脚本用 `tick-pitfall-cluster`）：
  //      tickd 以该名持真锁并注入 `DSH_BUTLER_TICK_LOCK_HELD`；子进程用同名 ⇒ 走"锁继承"虚拟锁，
  //      不会出现"父持锁 + 子再抢 ⇒ 永远 locked"（本生态踩过该坑，见 store.mjs T2 注释）。
  //   ⚠️ 产出**只是"收敛展示"建议**（`advisoryOnly:true`）；**不改**任何坑的 count/excluded/候选 status。
  //   TTL 10 分钟：O(n²) 点积在百级条目下毫秒级，余量充足。
  //   intervalMs=0：日历型（每日 04:50），TTL 由 ttlMs 显式给出。
  { job: 'pitfall-cluster', lockName: 'tick-pitfall-cluster', script: 'pitfall-cluster-tick.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['~/.dsh/butler-p4-clusters.json（**写**：唯一写者；原子写；删文件即回滚）',
      '~/.dsh/butler-pitfalls.json（只读）· ~/.dsh/memory-vectors/vectors.db（只读 `source=pitfall`）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-09-22（卡 S0 · 自动交接与会话接力 · §12 第 0 步 3 · P-2 / K-23）`relay` 接 tickd ──────────
  //   为什么必须登记（**不变量 = "tickd 全部 job 都有锁登记"**）：漏登记时 `auditRegistry({jobs:JOBS})`
  //     会报「调度表 job 未登记锁」→ registry-audit 的 J3 断言 + 三个单测（test-handoff-gate /
  //     test-ctx-guard / test-auto-actions-wire）齐红。**先例**：2026-09-12 `reconcile`、2026-09-20
  //     `secretary-morning` 两次栽在这一行 —— 这是第三次机会，别再漏。
  //   形态依据 = 方案 §12 第 0 步 3 逐字给定的行：`{job:'relay', lockName:'relay', script:<阶段 2 执行体
  //     入口>, ttlMs:600000, intervalMs:300000, skipPolicy:'skip', source:'tickd', critical:[…]}`。
  //   ⚠️ **`script` 字段（如实登记）**：方案 §5.1 只登记了 `tools/session-relay.mjs`（CLI），而 §12
  //     阶段 2 ① 的"事实采集器"**未写死独立文件名** ⇒ 本行按 CLI 同址填 `session-relay.mjs`
  //     （相对 COMPONENT_ROOT = `<butler-root>\tools`）。**阶段 2 落地时若另立执行体，必须同步改本行与
  //     `butler-tickd.mjs` 的 JOBS 条目**（两处一致）；"必须与脚本自报锁名一致"这条留给阶段 2 卡验。
  //   TTL 10 分钟（= 600_000，方案给值）：一轮 = 解帧会话尾（≤2 MB / ≤3 s）+ LLM（≤60 s +
  //     既有超时 60 s）+ 三步 HTTP（≤45 s）≈ 最坏 ≤109 s；给足余量（tickd 侧另有续期兜底）。
  //   intervalMs 5 分钟（300_000，与 `ctx-guard` 同节拍；方案 D9）；与 JOBS 表 initialMs 540 s 错峰配套。
  //   ⚠️ **与方案闸门 5 的"源会话锁"是两把不同的锁，各管一段、不许合并**：
  //     · 本行 = **job 级锁** `tick-relay.lock`（一份 tick 同时只跑一个实例）；
  //     · 闸门 5 = **单条接力链锁** `~/.dsh/butler-relay.<源会话id>.inflight`（互斥键 = 源会话；
  //       不同源会话可并行 ⇒ 那把锁天然是"多把并存"的，**无法**用 job 锁替代）。
  { job: 'relay', lockName: 'relay', script: 'session-relay.mjs', ttlMs: 600_000, intervalMs: 300_000,
    critical: ['~/.dsh/butler-relay.json（台账：inFlight{sourceSessionId,step,chainId,startedAt} / pendingHandoff / dailyStarted）',
      '~/.dsh/butler-relay.<源会话id>.inflight（**按源会话分的 single-flight 锁** —— ⚠️ 与本 job 的 tick-relay.lock **是两把不同的锁**，各管一段、不许合并）',
      '会话面（session.create / session.rename / session.prompt —— 开新会话 + 打【续】标题；**改绑看板卡由接手会话做**）',
      '%USERPROFILE%/.dsh/butler-audit/*.jsonl（审计：session-relay / session-relay-denied / relay-halted / skipped-* 等，**必须走既有 append 哈希链**）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-09-27（卡「整夜班底丙1丙2」）：丙-1 整夜保护自检 / 丙-2 停手审计 ──────────────
  //   两条都是**只读**巡检：overnight-guard 一个字节都不写（结论走 stdout，日报段由 report.mjs 现场跑）；
  //   night-stop-audit 只落一份 `docs/` 只读档。
  //   `lockRunner` **不加**：脚本自身不抢锁、也不与手工直跑争互斥资源（纯读；同日两次跑最多覆盖同一份
  //     只读档，内容相近、无害）。tickd 侧的 job 级锁仍按本表生效（防同 job 双实例）。
  //   TTL：overnight-guard 5 分钟（一轮 = 1 次 CIM 读值 + 几条 reg query，实测 ~1 s）；
  //     night-stop-audit 10 分钟（一轮 = 遍历会话树 + 窗口内会话解帧 + 1 次 session.list，1458 目录实测 ~4 s）。
  //   ⚠️ 两条在 `butler-tickd.mjs` 的 JOBS 里都声明了 `defaultWhenUnset:'off'` ⇒ 交付即默认关（放行走开关）。
  { job: 'overnight-guard', lockName: 'overnight-guard', script: 'overnight-guard-check.mjs', ttlMs: 300_000, intervalMs: 0,
    critical: ['**只读**：不写任何文件（电源 7 项 × 方案 × AC/DC + 屏保 3 项 + 更新时段窗，全部 reg query / CIM 读取）',
      '读 ~/.dsh/overnight-mode-<host>.json（只读：备份原值，用作「被改回」判据）'],
    skipPolicy: 'skip', source: 'tickd' },
  { job: 'night-stop-audit', lockName: 'night-stop-audit', script: 'night-stop-audit.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['**只读会话**：不写会话 / 不改标题 / 不跑接力 / 不开会话 / 不发消息（只列清单）',
      '读 ~/.dsh/sessions 与 ~/.dsh/_archived-sessions（只读）',
      '读 ~/.dsh/butler-relay.handed 与 ~/.dsh/butler-relay.json（只读：交接证据）',
      '写：docs/（**唯一的写**，只读档）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-14（the operator令「都做吧」· 防复发三件套 ②）：`rule-drift` 老话巡检 ───────────────────
  //   纯只读：扫 `~/.dsh/.agent-presets/<preset>/agent.cordis.yml` 的 persona 正文 + `~/.dsh/skills/<名字>/SKILL.md`，
  //   命中"教会话先问the operator"的保守句式族就报（结论走 stdout / 日报段；`--json` 时日志落 %TEMP%）。
  //   `lockRunner` **不加**：脚本自身不抢锁、不与手工直跑争互斥资源（纯读；同日两次跑最多重复报同一批命中）。
  //   TTL 5 分钟（一轮 = 读 3 份 persona + 25 份技能，实测 < 1 s）。
  //   ⚠️ 与 `butler-tickd.mjs` 的 JOBS 行同源（`at:'15:30'` · `defaultWhenUnset:'off'`）⇒ 改一处必须同批改另一处。
  { job: 'rule-drift', lockName: 'rule-drift', script: 'rule-drift-check.mjs', ttlMs: 300_000, intervalMs: 0,
    critical: ['**只读**：不写任何文件（只读 persona / 技能文本）',
      '读 ~/.dsh/.agent-presets/*/agent.cordis.yml（只读：真源 + 副本 preset 的 persona 正文）',
      '读 ~/.dsh/skills/*/SKILL.md（只读）',
      '读 ~/.dsh/butler-rule-drift-exempt.json（只读：豁免清单）'],
    skipPolicy: 'skip', source: 'tickd' },

  // ── 2026-10-22（卡「V3 功能面 · 记忆架构四件」H-5）：`memory-dream` 后台记忆整理 ──────────────
  //   纯只读：`dream-tick.mjs` 以 `DatabaseSync({readOnly:true})` 打开 `~/.dsh/memory/memory.db`，
  //   出「合并建议 / 陈旧标记建议 / 三层分布」；**唯一写入** = `docs/`。
  //   ⚠️ **写回需人审**：本 job 不提供真写口（合并、打 `superseded-by:` 都要人看报告后另开卡）。
  //   `lockRunner` 不加：脚本自身不抢锁（纯读；同日重复跑最多覆盖同一份报告）。
  //   TTL 10 分钟（全库扫描 + 倒排两两比，1,800 条实测 < 1 s，余量 ~600×）。
  //   ⚠️ 与 `butler-tickd.mjs` 的 JOBS 行同源（`at:'04:35'` · `defaultWhenUnset:'off'`）⇒ 改一处必须同批改另一处。
  { job: 'memory-dream', lockName: 'memory-dream', script: 'dream-tick.mjs', ttlMs: 600_000, intervalMs: 0,
    critical: ['**只读库**：`~/.dsh/memory/memory.db` 以 readOnly 打开，只发 SELECT',
      '写：docs/（**唯一的写**；`--dry-run` 时连这份也不写）',
      '不碰 persona / 技能 / 任何配置'],
    skipPolicy: 'skip', source: 'tickd' },

  // ── 2026-10-09（冲刺600 · 卡「归档出错自动重试接调度」）：`archive` 接 tickd ──────────────────
  //   锁名刻意 == 子脚本内调度器的锁名 `p3-auto-<jobId>`（`lib/scheduler.mjs` 的 `${name}-${id}`，
  //   name='p3-auto'、子脚本内 job id='archive'，见 `butler-auto-tick.mjs` 的 `createScheduler({name:'p3-auto'})`
  //   + `sch.register({...AUTO_JOBS.archive})`）—— 父子锁名不一致会让 job 被误判 locked 而永不执行
  //   （既有口径，见上方四动作接线注释：B1 四动作栽过）。
  //   TTL 15 分钟：一轮 = 读 `.auto-archive.json` 状态（本地 fs，秒级）+ 命中时一次
  //   `POST /api/dsh-archive-sessions/auto/run`（Host HTTP，真重跑一轮归档）或读侧惰性补写
  //   （`GET …/list`）；给足余量。
  //   intervalMs 30 分钟与 JOBS 表 `archive` 行同值（0 = 日历/手工 的登记会失真，见 tidy 先例）。
  { job: 'archive', lockName: 'p3-auto-archive', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 1_800_000,
    critical: ['~/.dsh/_archived-sessions/.auto-archive.json（**命中时写**：重跑一轮归档 / 补写元信息）',
      '~/.dsh/butler-auto-actions.json（**仅放行后**写：24h 签名 / 每日额度）',
      '%USERPROFILE%/.dsh/butler-audit/*.jsonl（`archive-retry` 行，含回滚数据）'],
    skipPolicy: 'skip', source: 'tickd' },

  // ── 2026-10-09（冲刺600 · 卡「token 用量监测接调度」）：`token` 接 tickd ──────────────────────
  //   锁名刻意 == 子脚本内调度器的锁名 `p3-auto-<jobId>`（`lib/scheduler.mjs` 的 `${name}-${id}`，
  //   name='p3-auto'、子脚本内 job id='token'，见 `butler-auto-tick.mjs` 的 `createScheduler({name:'p3-auto'})`
  //   + `sch.register({ ...AUTO_JOBS.token })`）—— 父子锁名不一致会让 job 被误判 locked 而永不执行
  //   （既有口径，见上方四动作接线注释：B1 四动作栽过）。
  //   ⚠️ **刻意不填 `lockRunner`**：本 job 的执行体就是 `butler-auto-tick.mjs`，它的调度器**自带**
  //      `acquireTickLock` ⇒ 再套一层包装层 = 双层锁、每轮都被误判 locked（同 queue-wake /
  //      memory-distill / archive 的处置；判据 = 脚本有没有 acquireTickLock，不是"是不是新 job"）。
  //   TTL 15 分钟：一轮 = 只读扫会话日志（**首轮全量**实测分钟级；此后只解字节数变化的文件）
  //      + 一次看板 state 只读（Host HTTP，仅用于按卡归因）+ 原子写台账；给足余量（tickd 侧另有续期兜底）。
  //   intervalMs 60 分钟：与 JOBS 行 / `AUTO_JOBS.token.intervalMs` **三处同值**
  //      （0 = 日历/手工 的旧登记会失真会误导 TTL 推导，见 tidy 先例）。
  //   ⚠️ 本 job **不写生产配置 / 不改卡 / 不发外部消息 / 不调 LLM**（0 token）—— 唯一写入 = 自家台账文件。
  { job: 'token', lockName: 'p3-auto-token', script: 'butler-auto-tick.mjs', ttlMs: 900_000, intervalMs: 3_600_000,
    critical: ['~/.dsh/butler-token-usage.json（**写**：按会话/按天用量台账 + 归因表；纯本机自算、可重建）',
      '生产 ~/.dsh/sessions + ~/.dsh/_archived-sessions（**只读**：增量解帧取 usage 事件）',
      '本机看板账本（**只读**：经 Host HTTP `/api/task-board/state`，仅用于按卡归因）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-10（卡「冲刺600·补记忆服务面」）两条新调度 job 的锁登记 ─────────────────────
  //   不变量：`auditRegistry({jobs: JOBS})` 必须零问题（每个调度 job 都要有锁登记）——
  //   漏登记会被单测 `test-auto-actions-wire.mjs` / `test-board-line-archive.mjs` 抓红。
  //   `doc-index`：重建器（memory-engine/cli/doc-index-rebuild.mjs）自带 `VACUUM INTO` 快照，
  //     但**自身无锁**（可从 CLI 手工直跑）⇒ 并发一次会两写同一库，故 TTL 给 15 分钟覆盖全量重扫。
  //   `upgrade-watch`：B 线体检纯只读（不改任何文件、零 token），TTL 15 分钟（远端 fetch 超时上限累计）；
  //     抢不到锁静默跳过即可 —— 第二天照跑，不丢结论。
  { job: 'doc-index', lockName: 'doc-index', script: 'memory-engine/cli/doc-index-rebuild.mjs', ttlMs: 900_000, intervalMs: 0,
    critical: ['~/.dsh/memory-vectors/doc-index.db（**写**：文档索引库；重建前自动落 VACUUM INTO 快照）',
      '~/.dsh/memory-vectors/doc-index-snapshots/（**写**：每次重建前的快照，`--restore` 可回退）',
      '~/.dsh/butler-doc-index-state.json（**写**：增量差分状态）',
      '<butler-root>/docs + <butler-root>/tools（**只读**：扫描面）'],
    skipPolicy: 'skip', source: 'tickd' },
  { job: 'upgrade-watch', lockName: 'upgrade-watch', script: 'dsh-upgrade-watch.mjs', ttlMs: 900_000, intervalMs: 0,
    critical: ['（**只读**：默认不写任何文件）本机 web profile 的 package.json / node_modules 实体 + npm registry + 4 个社区规范仓',
      '（**只读**：仅在显式 `--json <path>` 时写）版本体检 JSON'],
    skipPolicy: 'skip', source: 'tickd' },
  //   `secretary-feed`：只跑 `reconcile`（三面引用对账），**不写投喂面**；脚本自身无锁
  //     （可从 CLI 手工直跑 list/show/search/reconcile）⇒ 与 tick 并发会两写同一状态文件，故登记。
  { job: 'secretary-feed', lockName: 'secretary-feed', script: 'secretary-feed.mjs', ttlMs: 900_000, intervalMs: 0,
    critical: ['~/.dsh/secretary-feed-reconcile.json（**写**：每日对账结论 + 问题清单）',
      '~/.dsh/secretary-feed-audit.jsonl（**写**：投喂审计；本 job 不产生条目）',
      '~/.dsh/secretary-feed/（**只读**：投喂条与实体文件）'],
    skipPolicy: 'skip', source: 'tickd' },
  //   `relay-ondemand`（2026-10-12 · 卡 caa96f3f）：**按需自动开隧道**的判决 job。
  //     脚本自身**没有** `acquireTickLock`（`tools\relay\relay-ondemand.mjs` 是独立工具，
  //     设计上要能被人手工直跑：`status` / `run --apply`）⇒ 按 `repair-linger` / `watchfs` /
  //     `daily` / `imagegen*` 同款先例走 **`lockRunner: true`**（tickd 经 `lib/tick-job-runner.mjs`
  //     包装层抢锁 → 动态 import → 释放），这样**手工直跑与 tick 会抢同一把锁**。
  //     为什么必须互斥：它会 `enable` / `up` / `down` 隧道 —— 两个实例并发判定会
  //     「一个刚开、另一个立刻按旧读数关掉」，把通道打得忽上忽下。
  //     TTL 5 分钟：一轮 = git fetch + git log + 一次 relay-cli（实测秒级），给足余量。
  //     intervalMs 与本 job 的 `initialMs` 必须与 `butler-tickd.mjs` 的 JOBS 行一致（同值纪律）。
  { job: 'relay-ondemand', lockName: 'relay-ondemand', script: 'relay/relay-ondemand.mjs',
    ttlMs: 300_000, intervalMs: 2 * 60 * 1000,
    critical: ['~/.dsh/relay/relay-config.json（**写**：enabled 开关 —— 经 relay-cli enable/up/down）',
      '~/.dsh/relay/tunnel.pid.json（**写**：隧道进程记录 —— 经 relay-cli）',
      '~/.dsh/relay/ondemand.json（**写**：本 job 自己的开关）',
      '~/.dsh/relay/ondemand-state.json（**写**：隧道的归属与最近活动时间）',
      '<butler-root>/logs/relay-ondemand-<日期>.jsonl（**写**：每次判决留痕）',
      '<butler-root>-mailbox（**只读**：git fetch / log / ls-tree —— 跨机消息的观测面）'],
    skipPolicy: 'skip', source: 'tickd', lockRunner: true,
    lockRunnerReason: '脚本无 acquireTickLock 且允许手工直跑（status/run）⇒ 必须由包装层抢锁，'
      + '否则手工与 tick 并发会「一个刚开隧道、另一个按旧读数立刻关掉」' },
  //   `relay-keepalive`（2026-10-27 · 批 2 · 2-1 · 真源 `docs/` §3 批 2）：
  //     19080 中继隧道的**独立保活件**（脚本 `tools\relay\relay-keepalive.mjs`；JOBS 行见 `butler-tickd.mjs` 表尾）。
  //     为什么有它：隧道改成常驻之后，保活要从 `net-arbiter` **下沉成独立件**（方案 §7）——
  //     `net-arbiter` 另有六件职责未全部移交，它的计划任务**不许拆**，所以两条链必须能各自独立开关。
  //     脚本自身**没有** `acquireTickLock`（是独立工具，允许手工直跑：`--status` / 缺省 dry-run / `--apply`）
  //     ⇒ 按 `relay-ondemand` / `repair-linger` / `watchfs` 同款先例走 **`lockRunner: true`**
  //     （tickd 经 `lib/tick-job-runner.mjs` 包装层抢锁 → 动态 import → 释放）⇒ 手工直跑与 tick 抢同一把锁。
  //     为什么必须互斥：它会 `taskkill` 半死的 ssh 再 `relay-cli enable/up` —— 两个实例并发会
  //     「一个刚把隧道起好、另一个把新进程当半死再杀掉」，隧道永远起不稳。
  //     ⚠️ 与 `relay-ondemand` / `lease-reclaim` 的写对象重叠（`relay-config.json` / `tunnel.pid.json`）
  //     —— 按 R9 已立的先例「**登记而不加锁**」处理：锁名各自独立（`relay-keepalive` / `relay-ondemand` /
  //     `lease-reclaim`），**刻意不共用**（共用 = 5 分钟一轮的保活会被 2 分钟一轮的判决用
  //     `skipPolicy:'skip'` 静默跳过 ⇒ 保活链断，而保活断了才最要命）。
  //     语义分工（方案 §6 红线「别造第二个隧道写者」）：on-demand / lease 管"该不该开着"，
  //     本 job 只管"缺了补上"—— 它**从不调 `relay-cli down`**（那会把 enabled 置 false），
  //     所以不会与关断/续约那条链互相拉扯。
  //     TTL 5 分钟：一轮 = 四元组读数 + 一次端到端探针（≤3 s）+ 至多 kill/up（实测秒级~20 s），给足余量。
  //     `intervalMs` 与 JOBS 行的 `intervalMs` 同值纪律（5 分钟）。
  { job: 'relay-keepalive', lockName: 'relay-keepalive', script: 'relay/relay-keepalive.mjs',
    ttlMs: 300_000, intervalMs: 5 * 60 * 1000,
    critical: ['~/.dsh/relay/relay-config.json（**写**：仅当 enabled=false 时经 relay-cli enable；**从不 down**）',
      '~/.dsh/relay/tunnel.pid.json（**写**：经 relay-cli up 重写隧道进程记录）',
      '~/.dsh/relay/keepalive-state.json（**写**：心跳 / lastRc / lastError / blockedStreak）',
      '<butler-root>/logs/relay-keepalive-<日期>.jsonl（**写**：每轮四元组 + 动作留痕）',
      '<butler-root>/logs/relay-keepalive-alert.log（**写**：仅 rc=1 真失败时一行，供日报/告警取）',
      '**真动作**：`taskkill /F` 半死的 ssh 进程（只杀 name=ssh.exe 的，绝不误杀 dsh/node/外来进程）'],
    skipPolicy: 'skip', source: 'tickd', lockRunner: true,
    lockRunnerReason: '脚本无 acquireTickLock 且允许手工直跑（--status / --apply）⇒ 必须由包装层抢锁，'
      + '否则手工与 tick 并发会「一个刚把隧道起好、另一个把新进程当半死再杀掉」' },
  //   `text-sync-direct`（2026-10-28 · V3 功能面 · 批 2「拆仓库钩子」· **真源 = 本卡 / 方案 §4 批 2**）：
  //     不经仓的**文档直连同步**（脚本 `tools\dsh-butler\text-sync-direct.mjs`；JOBS 行见 `butler-tickd.mjs` 表尾）。
  //     为什么有它：本卡拆掉 `hot` / `text-sync` / `memory-snapshot` / `arrive-b` 这四个「读写 Gitee 三仓」的 job
  //     之后，`docs` 面不能断供 —— 本 job 走 ssh 直连对端（不经 git、不碰仓信箱、不写仓），
  //     把 `docs` 增量搬到 <host>（批 1 卡 `793ac386` 已交付并真跑通）。
  //     🔴 **脚本自己抢锁** ⇒ 本登记**刻意不加 `lockRunner: true`**：
  //     `text-sync-direct.mjs` L498 自己 `acquireTickLock('text-sync-direct', { ttlMs: 45min })`。
  //     若再挂包装层 = 同一进程内自己跟自己互斥 ⇒ 永远判 locked、job 永远让路
  //     （生态踩过该坑，见 `butler-tickd.mjs` 包装层那段注释与 `plug-guard` 同款说明）。
  //     `lockName` 与脚本自报名**逐字相等** = `text-sync-direct`（脚本 `--lock-name` 缺省值同值）。
  //     为什么必须互斥：本 job 会往**对端 `<butler-root>\docs`** 真写（新增件 + 覆盖件留 `.bak`）——
  //     两个实例并发传同一批 = 同秒两次落位、`.bak` 互相覆盖、与 `.conflict-*` 判据打架。
  //     ⚠️ 与 `text-sync`（共用 `handoff` 锁）**刻意不共用**：两者写的是同一批文件，但 `text-sync` 是
  //     "经仓 + 回灌生产"、本 job 是"直连对端"；共用会让 60 分钟一轮的直连被热采/交接长时间挡住
  //     （R9 立的先例：低频兜底不许挡常活）。本卡关掉 `text-sync` 后两者不会并存，
  //     即便如此也**不并锁** —— 将来若回滚旧 job，两把锁各自独立更安全。
  //     TTL 45 分钟 = **脚本自己的值**（`LOCK_TTL_MS`，照抄不另设）：首轮 87 MB 约 30 分钟，
  //     稳态增量秒级；45 分钟覆盖首轮 + 慢盘/重试，又不至于长到挡住下一轮（60 分钟周期）。
  //     `intervalMs` 与 JOBS 行**同值纪律**（60 分钟）。
  { job: 'text-sync-direct', lockName: 'text-sync-direct', script: 'dsh-butler/text-sync-direct.mjs',
    ttlMs: 45 * 60 * 1000, intervalMs: 60 * 60 * 1000,
    critical: ['本机 `<butler-root>\\docs`（**只读**：只出清单与 sha）',
      '对端 <host> `<butler-root>\\docs`（**写**：新增件 + 覆盖件；旧件留 `.bak-<stamp>` 只留 1 份）',
      '对端 <host> `<butler-root>\\docs` 的**冲突副本** `*.conflict-<host>-<stamp>-<sha8>`（**写**：双写黑名单件）',
      '本机 `<butler-root>\\_tmp\\text-sync-direct`（**写**：分批容器暂存，收尾删本次）',
      '本机 `<butler-root>\\_archive\\text-sync-direct`（**写**：覆盖前留档）',
      '~/.dsh/relay/short-lease.json（**写**：通道不通时经 `peer-channel` 短租，收尾只销自己的租约）',
      '🔴 **永不删除任何文件**（唯一删口 = `rollback-direct-sync.mjs`，且只删本次新建、sha 对得上）'],
    skipPolicy: 'skip', source: 'tickd' },
  //   `notify-docsync`（2026-10-28 · V3 功能面 · **真源 = 本卡 / 报告
  //     `docs/`**）：
  //     「文档跨机同步真的断了才发一条微信」的窄口子告警件
  //     （脚本 `tools\dsh-butler\notify-docsync-watch.mjs`；JOBS 行见 `butler-tickd.mjs` 表尾）。
  //     为什么有它：the operator**不看企微告警**（原话「现在企微那边的告警我都不咋看了」），而
  //     `~\.dsh\butler-alert.log` 已积 **9,328 条 / 5.7 MB**、多数是「job 耗时超预算」这类 info
  //     ⇒ **告警量本身就是它失效的原因**。本件只盯 `text-sync-direct` 一件事：
  //     连续 ≥6 轮让路 **且** tickd 自己还活着 ⇒ 推一条；通了再推一条「已恢复」。
  //     🔴 **刻意不注册 `lib\alert.mjs` 的 `addChannel()`**（那等于给全部告警加微信通道 = 洪水回来了），
  //     也**不改** `alert.mjs` 的既有行为与既有通道（只在发送失败时借它写一行）。
  //     🔴 **脚本自己不抢锁**（无 `acquireTickLock`；允许手工直跑：`--status` / 缺省 dry-run /
  //     `--apply`）⇒ 按 `relay-keepalive` / `lease-reclaim` / `watchfs` 同款先例走
  //     **`lockRunner: true`**（tickd 经 `lib\tick-job-runner.mjs` 包装层抢锁 → 动态 import → 释放）。
  //     为什么必须互斥：它**会真发一条微信**给the operator。两个实例并发、又恰好在同一状态首次判定
  //     ⇒ 双双读到 `lastNotified=null` ⇒ the operator收到两条一模一样的「断了」。
  //     幂等闸（状态文件 `lastNotified`）能挡"同一状态重发"，但挡不住"同一瞬间的双发"。
  //     ⚠️ 与 `text-sync-direct` 是**只读关系**（只读 tickd `state.json` 的 `jobs['text-sync-direct']`；
  //     不读它的锁、不碰它搬的文件）⇒ 两把锁**刻意不共用**：共用会让 60 分钟一轮的文档同步
  //     被本件的发送（spawn `cli.mjs`，实测秒级，超时上限 60 s）用 `skipPolicy:'skip'` 静默跳过。
  //     TTL 5 分钟：一轮 = 读两个 JSON + 至多一次微信发送，给足余量。
  //     `intervalMs` 30 分钟（与 JOBS 行同值纪律）—— 比源 job 的 60 分钟更密，因为「恢复」
  //     要尽快报出来；判「断」靠源 job 自己的 `consecutiveBenign` 计数，不靠本件的采样密度。
  { job: 'notify-docsync', lockName: 'notify-docsync', script: 'dsh-butler/notify-docsync-watch.mjs',
    ttlMs: 300_000, intervalMs: 30 * 60 * 1000,
    critical: ['~/.dsh/notify-docsync-state.json（**写**：lastNotified / lastNotifiedAt / day / dayCount = 幂等与频率闸）',
      '~/.dsh/notify-docsync.json（**只读**：enabled / account / to / jobId / 阈值 / 周期 / 每日上限）',
      '%TEMP%/dsh-butler-tickd/state.json（**只读**：`jobs[<jobId>]` 的三条判据 + runs）',
      '<butler-root>/logs/notify-docsync-<日期>.jsonl（**写**：每轮判定留痕，含 throttled / noop）',
      '~/.dsh/butler-alert.log（**仅发送失败时**写一行，走既有 `lib/alert.mjs`，不改其行为）',
      '🔴 **真动作**：`tools\\wechat-bridge\\cli.mjs send --go` 真发一条微信 —— **只发给the operator自己**'
        + '（配置文件里的 `to`），不发群、不加人、不广播'],
    skipPolicy: 'skip', source: 'tickd', lockRunner: true,
    lockRunnerReason: '脚本无 acquireTickLock 且允许手工直跑（--status / --apply）⇒ 必须由包装层抢锁，'
      + '否则手工与 tick 并发会在同一瞬间双双读到 lastNotified=null ⇒ the operator收到两条一样的「断了」' },
  //   `lease-reclaim`（2026-10-14 · 卡「愿景实体核查 R11」）：短租租约**过期回收** job
  //     （真源 R9 报告 §3.4 / §8-R2 / §9-P1；调度行见 `butler-tickd.mjs` 的 JOBS 表尾）。
  //     脚本 `tools\peer-channel-reclaim-tick.mjs` 自身**没有** `acquireTickLock`（是独立工具，
  //     允许手工直跑：缺省 dry-run / `--apply` / `--json`）⇒ 按 `relay-ondemand` / `repair-linger` /
  //     `watchfs` / `daily` / `imagegen*` 同款先例走 **`lockRunner: true`**（tickd 经
  //     `lib\tick-job-runner.mjs` 包装层抢锁 → 动态 import → 释放）⇒ 手工直跑与 tick **抢同一把锁**。
  //     为什么必须互斥：它会计数并按过期条件**删除** `short-lease.json`、并在"由短租开的"时
  //     调 `relay-cli down` —— 两个实例并发会重复 down、或把"另一个刚写的租约"当过期销掉。
  //     ⚠️ **与 `relay-ondemand` 的写对象重叠**（都经 relay-cli 写 `relay-config.json` /
  //     `tunnel.pid.json`，都读 `short-lease.json`）—— 按 R9 已立的先例「**登记而不加锁**」处理：
  //     两边锁名本就不同（`lease-reclaim` / `relay-ondemand`），**刻意不共用**：一旦共用，
  //     每 2 分钟跑一次的**判决 job**（常活）会被 5 分钟一次的**低频兜底**用
  //     `skipPolicy:'skip'` 静默跳过 —— 让路的代价不对等（判决链断了 = 该开的隧道没人开）。
  //     重叠窗口 = "同一秒各写一次原子 JSON"，最坏一方意图被覆盖；缓解与残余风险见 R9 §8-R4。
  //     TTL 5 分钟：一轮 = 读一次租约 + 至多一次 relay-cli（实测秒级），给足余量。
  //     `intervalMs` 与 JOBS 行的 `intervalMs` 同值纪律（5 分钟）。
  { job: 'lease-reclaim', lockName: 'lease-reclaim', script: 'peer-channel-reclaim-tick.mjs',
    ttlMs: 300_000, intervalMs: 5 * 60 * 1000,
    critical: ['~/.dsh/relay/short-lease.json（**写**：过期即销租约；⚠️ `down` 失败时**保留**待下轮重试）',
      '~/.dsh/relay/relay-config.json（**仅当租约是"由短租开的"时**经 relay-cli down 写：enabled→false）',
      '~/.dsh/relay/tunnel.pid.json（同上：经 relay-cli down 删隧道进程记录）',
      '⚠️ 与 `relay-ondemand` job 的写对象重叠（见上注）—— **登记而不加锁**'],
    skipPolicy: 'skip', source: 'tickd', lockRunner: true,
    lockRunnerReason: '脚本无 acquireTickLock 且允许手工直跑（--apply / --json / 缺省 dry-run）⇒ '
      + '必须由包装层抢锁，否则手工与 tick 并发会重复 down 隧道、或误销别人刚写的租约' },
  //   `stale-lease-reap`（2026-10-16 · 卡「R-061 余项 · 过期占位收敛」）：把"持有者早没了"的占位
  //     （升级锁 `~/.dsh/upgrade-lock` / 挂起锁 `%TEMP%\dsh-guard\repair-hold.json`）自动收敛掉
  //     —— 事故真源 `docs/`；调度行见 `butler-tickd.mjs` 的 JOBS 表尾。
  //     脚本 `tools\dsh-butler\stale-lease-reaper-tick.mjs` 自身**没有** `acquireTickLock`（是独立入口，
  //     允许手工直跑：缺省只报告 / `--apply --allow-production` / `--json`）⇒ 按 `lease-reclaim` /
  //     `relay-ondemand` / `repair-linger` 同款先例走 **`lockRunner: true`**（tickd 经
  //     `lib\tick-job-runner.mjs` 包装层抢锁 → 动态 import → 释放）⇒ 手工直跑与 tick **抢同一把锁**。
  //     为什么必须互斥：它会计数并按过期条件**删除**升级锁与挂起锁、并写审计/告警 ——
  //     两个实例并发会重复释放、把审计写成双份、"谁清的"说不清。
  //     ⚠️ 只有**判据成立**才动手：升级锁 `state==='interrupted'`（判据源 `upgrade-lock.mjs#status()`）/
  //     挂起锁 `expiresAt` 已过；**心跳新鲜的锁一字不碰**（连审计都不写）。
  //     ⚠️ 与 guard 侧 `residue-reaper` 的写对象**不重叠**（那边管 takeover.json 与静默窗 holders，
  //     本 job 管锁与挂起锁）—— 故各自独立成锁，**刻意不共用**。
  //     TTL 2 分钟：一轮 = 读 2~3 个小文件 + 至多两次删 + 两条审计（实测秒级），给足余量。
  //     `intervalMs` 与 JOBS 行的 `intervalMs` 同值纪律（5 分钟）。
  { job: 'stale-lease-reap', lockName: 'stale-lease-reap', script: 'stale-lease-reaper-tick.mjs',
    ttlMs: 120_000, intervalMs: 5 * 60 * 1000,
    critical: ['~/.dsh/upgrade-lock（**删**：仅当判 interrupted〔心跳超 TTL 且持锁进程已退出〕）',
      '%TEMP%/dsh-guard/repair-hold.json（**删**：仅当 expiresAt 已过；缺 expiresAt 一律按未过期不删）',
      '~/.dsh/butler-audit/<月>.jsonl（**写**：每条释放一行审计 `stale-lease-reap`）',
      '~/.dsh/butler-alert.log（**写**：一条汇总告警，level=warn/error）',
      '%TEMP%/dsh-guard/butler-stale-lease-reap.json（**写**：收敛记录/证据）',
      '⚠️ 与 guard 侧 `residue-reaper` 的写对象不重叠（那边管 takeover.json 与静默窗 holders）'],
    skipPolicy: 'skip', source: 'tickd', lockRunner: true,
    lockRunnerReason: '脚本无 acquireTickLock 且允许手工直跑（--apply --allow-production / --json / 缺省只报告）⇒ '
      + '必须由包装层抢锁，否则手工与 tick 并发会重复释放同一把锁、写双份审计' },
  //   `failure-delivery`（2026-10-16 · 卡「V3机器锁3 · R062 失败送达」）：关键 job 的**最近一次真失败**
  //     **首败即报** —— 写既有告警出口 `~/.dsh/butler-alert.log` + 对"首败"采最小资源快照。
  //     事故真源 `docs/` §4 R-062（近两月 ≥6 起"失败静默"取证）；
  //     调度行见 `butler-tickd.mjs` 的 JOBS 表尾（`failure-delivery`）。
  //     脚本 `tools\dsh-butler\job-failure-delivery-tick.mjs` 自身**没有** `acquireTickLock`（是独立入口，
  //     允许手工直跑：缺省只报告 / `--emit --allow-production` / `--json`）⇒ 按 `lease-reclaim` /
  //     `stale-lease-reap` 同款先例走 **`lockRunner: true`**（tickd 经 `lib\tick-job-runner.mjs` 包装层
  //     抢锁 → 动态 import → 释放）⇒ 手工直跑与 tick **抢同一把锁**。
  //     为什么必须互斥：它会**读改冷却状态**（`~/.dsh/butler-failure-delivery.json` 的
  //     `alerts[jobId].eventKey`）并与告警写盘配对 —— 两个实例并发会各自判定"未送达"⇒ 重复写告警、
  //     冷却位互相覆盖（"这条到底送过没"说不清）。
  //     TTL 2 分钟：一轮 = 读 1 个 state.json + 至多 16 条判定 +（红项时）写 1~N 行告警 + 至多 1 份快照
  //     （快照含一次 pwsh 探针，实测秒级），给足余量。
  //     `intervalMs` 与 JOBS 行的 `intervalMs` 同值纪律（5 分钟）。
  { job: 'failure-delivery', lockName: 'failure-delivery', script: 'job-failure-delivery-tick.mjs',
    ttlMs: 120_000, intervalMs: 5 * 60 * 1000,
    critical: ['~/.dsh/butler-alert.log（**写**：关键 job 首败即报，level=error · source=tickd · 同 job 30 分钟冷却）',
      '~/.dsh/butler-failure-delivery.json（**读改**：冷却位 `alerts[jobId]` + 首败快照位 `snapshots[jobId]`）',
      '%TEMP%/dsh-butler-failsnap/（**写**：首败最小资源快照，最多保留 50 份）',
      '%TEMP%/dsh-butler-tickd/state.json（**只读**：判据源；本脚本从不写它）',
      '⚠️ 与 `watch`(P2) 的写对象**不重叠**：P2 事件族走 `~/.dsh/butler-watch-state.json`（另一套预算）'],
    skipPolicy: 'skip', source: 'tickd', lockRunner: true,
    lockRunnerReason: '脚本无 acquireTickLock 且允许手工直跑（--emit --allow-production / --json / 缺省只报告）⇒ '
      + '必须由包装层抢锁，否则手工与 tick 并发会重复写告警、冷却位互相覆盖' },
  // ── 2026-10-16（卡「整夜模式 -> 插电保护（常驻化四件套）」③ 周期自愈）：`plug-guard` ─────────────
  //   每 10 分钟跑 `overnight-mode.mjs auto`：插电 ⇒ 对齐到保护态；电池 ⇒ 宽限（默认 10 分钟）后回日常态。
  //   ⚠️ **会写**（与上面的 overnight-guard 那条**只读**承诺形成对照；两条是两个 job，别混）：
  //     ① 电源方案 7 项 × N 方案 × AC/DC（`powercfg /set*valueindex`，**非管理员即可写**）
  //     ② 屏保 3 项（HKCU\Control Panel\Desktop）
  //     ③ `~/.dsh/overnight-mode-<host>.json`（保护备份）+ `~/.dsh/overnight-mode-auto-<host>.json`（宽限/真核计时）
  //     ④ **仅当原值为「关」时**才放行 `jobs.relay`（走 butler `setJobEnabled`：RMW 锁 + 原子写 + 审计）
  //     ⑤ WU 层：L1 活动时间（普通权限可写）+ L2 策略（**非管理员一律不碰**，只记 need-admin）
  //   ⚠️ **刻意不加 lockRunner**（同 overnight-guard / night-stop-audit 先例）：脚本自身没有 acquireTickLock，
  //     而 auto 是**幂等**的（状态一致 = 零动作零写盘）⇒ 与手工直跑并发最坏是两边各写一次同样的值，
  //     不会损坏状态。真要严格互斥得让脚本自己抢锁（改动面更大）—— 本卡不做，登记为已知边界。
  //   TTL 600_000（10 分钟）：一轮 = 1 次电源判定（实测 ~1.5 s）+ 到点时 1 次真核（同 status 判据面，
  //     实测 15 s 量级）+ 该切时的 on/off（on 实测 30 s 量级）；给足余量。intervalMs 与 JOBS 行同值。
  { job: 'plug-guard', lockName: 'plug-guard', script: 'overnight-mode.mjs',
    ttlMs: 600_000, intervalMs: 10 * 60 * 1000,
    critical: ['电源方案 7 项 × N 方案 × AC/DC（powercfg /setacvalueindex · /setdcvalueindex，非管理员可写）',
      '屏保 3 项 HKCU\\Control Panel\\Desktop（ScreenSaveActive / ScreenSaveTimeOut / ScreenSaverIsSecure）',
      '~/.dsh/overnight-mode-<host>.json（保护备份）+ ~/.dsh/overnight-mode-auto-<host>.json（宽限 / 真核计时）',
      '**仅当备份原值为关时**放行 jobs.relay（经 butler setJobEnabled）',
      'WU 层：L1 活动时间（普通权限）+ L2 策略（**非管理员不碰**）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-20（R-071 误删三道防线 ③「大量消失告警」）：`vanish-watch` ─────────────
  //   每 5 分钟按 8 个面数条目（**只 readdir，不读内容、不 hash**），与状态里上一读数比：
  //   跌幅 > 阈值（默认 10%）⇒ 缺口告警。首版 **observe 档**（只记事件、不调 alert），
  //   放行 = 把状态文件 `mode` 改成 `notify`（`--set-mode notify --apply`），不改代码。
  //   ⚠️ **刻意不加 lockRunner**（同 plug-guard / overnight-guard 先例）：脚本自身没有 acquireTickLock；
  //     一轮只读若干 readdir + 一次原子写自己的状态文件，与手工直跑并发最坏是两边各写一次同样的读数，
  //     不会损坏状态。真要严格互斥得让脚本自己抢锁（改动面更大）—— 本卡不做，登记为已知边界。
  //   TTL 600_000（10 分钟 = 2× 周期）：一轮实测 ≈ 1.1 s（`docs` 2,540 + `tools` 2,068 + 会话 5,866 条目；
  //     最大一面为会话）。给足余量，又不至于把真卡死吞掉。intervalMs 与 JOBS 行同值。
  { job: 'vanish-watch', lockName: 'vanish-watch', script: 'dsh-vanish-watch.mjs',
    ttlMs: 600_000, intervalMs: 5 * 60 * 1000,
    critical: ['`~/.dsh`（**只读**：sessions / _archived-sessions / skills / .agent-presets / dsh-imagegen / attachments / task-board）',
      '`<butler-root>\\docs` 与 `<butler-root>\\tools`（**只读**；tools 跳过 node_modules/.git）',
      '`<butler-root>\\_archive`（**只读**：仅数顶层条目，作「迁移 vs 消失」判定信号）',
      '`~/.dsh/ops-vanish-watch.json`（状态：各面读数 + 最近 20 条事件 + 冷却表）',
      '`~/.dsh/butler-alert.log`（**只追加**：仅 notify 档且过冷却时才写）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-21（V3 功能面 N0-b · registry 补登记）：`snapshot`（R-071② 定时快照 + 异地镜像）──
  //   来由：`butler-registry-audit` 的 **J3「锁登记完整」**当场报红 ——「调度表 job 未登记锁：snapshot」。
  //   **是否真在跑（现查，不是推测）**：tickd `JOBS` 有该表位（30 min / `initialMs 745_000` /
  //     `--once --apply`，2026-10-19 接入）；`butler-tickd.mjs --status` 实测 **runs=22 / failures=1 /
  //     lastStatus=ok**（lastStartAt 2026-10-21T05:35:32Z → lastEndAt 05:36:10Z，duration 37,497 ms）
  //     ⇒ **是真在跑的 job**，不是"登记了没跑"。
  //   ⚠️ 判据 = 脚本自身**有没有** `acquireTickLock`：`dsh-snapshot-tick.mjs` **没有**（全文 0 命中，
  //     也不 import `butler-locks`）⇒ 锁由 tickd 侧 `acquireJobLock` 兜底 —— 未登记时
  //     `lockNameFor()` 原样返回 job id（所以实际锁名一直是 `snapshot`）、`deriveTtlMs()` 兜底 300_000。
  //   ⚠️ **刻意不加 `lockRunner`**（同 plug-guard / vanish-watch 先例）：加包装层会改变 spawn 形态，
  //     而它的并发面本来就被 tickd 侧那把锁兜住。
  //   ⚠️ TTL 取 **300_000（5 分钟）= 登记前 `deriveTtlMs()` 对"无条目 job"的兜底值** ⇒
  //     `lockNameFor` / `deriveTtlMs` / `usesLockRunner` 三个运行时出口与本行加入前**逐值相同**
  //     （即：**加这一行对运行时零行为变化**，只是把"本来就生效的锁"写进真相表）。
  //   ⚠️ **已知边界 → 已处置（2026-10-21 14:2x · 功能面接手第 1 棒 · the operator授「其他你自己拍板」）**：
  //     实测最长一轮 **358,385 ms ≈ 6 分钟**（2026-10-21 00:28 撞 budget 240 s 的那轮：打包 + scp + 远端验包）
  //     > 原 300_000 ⇒ 那一轮里锁会过期。风险窗口 = 「手工 `--once` 与慢轮 tick 并发」。
  //     ⇒ **TTL 抬到 600_000（10 分钟）**，覆盖最长轮 + 余量；属行为变更（锁定释放变慢），
  //     **生效需 tickd 重启**（`--ensure` 对活进程是 no-op）⇒ 下次 tickd 重启自然生效，本处不动进程。
  //   `intervalMs` 与 JOBS 行同值（30 min）；`critical` 三处写面见下。
  { job: 'snapshot', lockName: 'snapshot', script: 'dsh-snapshot-tick.mjs',
    ttlMs: 600_000, intervalMs: 30 * 60 * 1000,
    critical: ['`~/.dsh/butler-snapshot-tick.json`（**读改**：lastRunAt / 份清单 / lastMirroredDay；'
      + '实盘落 `ops-snapshot-tick.json` —— 2c 状态名迁移的新名前缀，见 `lib\\state-paths.mjs`）',
      '`<butler-root>\\snapshots\\` 下的快照份（**写 + 按保留策略只删自己生成的份**：`manifest.generator === dsh-snapshot-tick`；凭据类已排除）',
      '对端 <host> `<butler-root>-home-backup\\`（scp 上传 + 远端 `tar -tzf` 验包）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-21 15:4x（卡「V3 功能面 N0-b」**收尾补登** · 卡外新缺口）：`secretary-drift` ──────────
  //   来由：15:34 小秘书服务管道线把 `{ id: 'secretary-drift', at: '09:40', script:
  //     tools\secretary-drift-check.mjs }` 接进 tickd JOBS，**没同步登记锁** ⇒ `butler-registry-audit` 的
  //     **J3** 立刻报红（`调度表 job 未登记锁：secretary-drift`，job 域 74 次断言里失败 1）。
  //   为什么由本卡补：本卡就是「registry 真缺口补登记」，而这条红会让**共用闸门与生态面板 registry chip
  //     一起变红**（面板依据 = 同一个判定源）。补的是登记元数据，不动调度、不动脚本。
  //   ⚠️ 判据 = 脚本自身**有没有** `acquireTickLock`：`tools\secretary-drift-check.mjs` 全文
  //     **0 命中**（也不 import `butler-locks`）⇒ 锁由 tickd 侧 `acquireJobLock` 兜底 —— 未登记时
  //     `lockNameFor()` 原样返回 job id（实际锁名一直是 `secretary-drift`）、`deriveTtlMs()` 对无条目 job
  //     兜底 300_000。⇒ 本行取 **`lockName: 'secretary-drift'` + `ttlMs: 300_000` + `intervalMs: 0`
  //     （日历档 `at:'09:40'`）**，三个运行时出口与登记前**逐值相同 = 对运行时**零行为变化**。
  //   ⚠️ **刻意不加 `lockRunner`**（同 plug-guard / vanish-watch / snapshot 先例）。
  //   ⚠️ 该 job 声明 `benignExitCodes:[3]`（对端不可达 = 正常让路，不记 failures）。
  { job: 'secretary-drift', lockName: 'secretary-drift', script: 'secretary-drift-check.mjs',
    ttlMs: 300_000, intervalMs: 0,
    critical: ['对端（<host>）`tools\\` 下测试件 / lib 的 **sha + 大小（只读对照）**（经 `--peer m6800`，通道由脚本自己择路）',
      '`docs/`（**写**：差异清单 + 分级；一份/天，覆盖写）',
      '**不自动改任何一侧**（下发与否由人拍）⇒ 无写远端面'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-23（主线「the operator<mainline>」卡①）：`preset-drift` ────────────────────────
  //   每天 08:50 只读比一遍「本机 + 对端」每份 preset 的**目录版 ↔ patch 内联**（0.2.0 只认内联，
  //   改了目录忘重内联 = 白改且没人发现），报告落 `docs/`。
  //   ⚠️ 判据 = 脚本自身**没有** `acquireTickLock`（`tools\dsh-butler\preset-drift-tick.mjs` 包装层只 spawn
  //     检查器 `tools\preset-drift-all.mjs`，两者都不抢锁）⇒ 锁由 tickd 侧 `acquireJobLock` 兜底；按 `lockName: <job id>`
  //     + `ttlMs 300_000`（实测一轮 ≈3~20 s：跨机两次 ssh + 两次 scp，给足余量）
  //     + `intervalMs: 0`（日历档 `at:'08:50'`）登记 ⇒ 三个运行时出口与登记前**逐值相同**。
  //   ⚠️ 刻意不加 `lockRunner`（同 secretary-drift / plug-guard / snapshot 先例）。
  //   ⚠️ 该 job 声明 `benignExitCodes:[3]`（**只**对端不可达 = 让路；真漂移 exit 1 照红 —— 2026-11-04 卡 V31-031）。
  { job: 'preset-drift', lockName: 'preset-drift', script: 'preset-drift-tick.mjs',
    ttlMs: 300_000, intervalMs: 0,
    critical: ['本机 `~/.dsh/.agent-presets/**/agent.cordis.yml` + `~/.dsh/profiles/web/cordis.patch.yml`（**只读**：绝不写）',
      '对端（<host>）同名两件（**只读**：只 ssh `echo %USERPROFILE%` + scp 拉副本到 `<butler-root>\\_tmp\\preset-drift-<日期>\\peer\\`，对端零写入）',
      '`docs/`（**写**：一份/天，覆盖写）',
      '**不改任何 preset / patch**（漂移只报不改；修法归主线「the operator<mainline>」另开卡）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-22（卡「素材库中心化」· 方案 §3.5）：`secretary-sync` ────────────────────────────
  //   每小时一轮 + tickd/开机后补一轮，把素材两件套（`feed.db` 索引 + `<butler-root>\secretary` 文件）
  //   在本机与中心 <host> 之间做**双向增量**（只增不删、内容 sha 去重、目标已存在绝不覆盖）。
  //   ⚠️ 判据 = 脚本自身**不用** `acquireTickLock`（`tools\secretary-sync.mjs` 自管一把
  //     `~\.dsh\secretary-sync.lock`，pid + 20 分钟陈旧判据）⇒ tickd 侧锁由 `acquireJobLock` 兜底，
  //     这里按 `lockName: <job id>` + 与 `intervalMs` 同档 `ttlMs` 登记，**运行时逐值不变**。
  //   ⚠️ 刻意不加 `lockRunner`（同 secretary-drift / plug-guard / snapshot 先例）。
  //   ⚠️ 该 job 声明 `benignExitCodes:[3,6]`（对端不可达 / 上一轮仍在跑 = 正常让路，不记 failures）。
  { job: 'secretary-sync', lockName: 'secretary-sync', script: 'secretary-sync.mjs',
    ttlMs: 20 * 60 * 1000, intervalMs: 60 * 60 * 1000,
    critical: ['本机 `~/.dsh/memory/feed.db`（**写**：行级并集插入，`BEGIN IMMEDIATE` 短事务；既有行只在 status 冲突时改 status）',
      '本机 `<butler-root>\\secretary\\<域>\\<期>\\*`（**写**：只新建缺失文件，`COPYFILE_EXCL` 硬禁覆盖）',
      '本机 `~/.dsh/secretary-sync.lock`（**写**：单轮互斥）',
      '本机 `<butler-root>\\docs/`（**写**：回滚清单，追加式）',
      '对端（<host>）`~/.dsh/memory/feed.db` + `<butler-root>\\secretary\\` 的**新增**行/文件（the operator 2026-10-22 已批：只增不删、可回滚）',
      '隧道开关 `~/.dsh/relay/relay-config.json` + 短租租约 `~/.dsh/relay/short-lease.json`（按需短租时；与 relay-ondemand 同款「登记而不加锁」）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-23（家庭保姆 ⑤ · 日程提醒）：`family-remind` ─────────────────────
  //   每 1 分钟扫 family-calendar 的 events，找到点提醒、落状态行（幂等键 = `remindKey`）。
  //   ⚠️ 判据 = 脚本自身**没有** `acquireTickLock`（`family-remind-tick.mjs` 不自建锁、可被手工直跑
  //     `--once --apply`）⇒ 按 watchfs / daily / imagegen* 同款先例走 **`lockRunner: true`**
  //     （tickd 经 lib/tick-job-runner.mjs 包装层抢锁 → import → 释放）⇒ 手工直跑与 tick 抢同一把锁。
  //     为什么必须互斥：它写 `reminded.jsonl`（**原子 upsert**，见方案 §0c #17）与 `attempts.json`，
  //     两个实例并发会读到同一批「未发」、对同一 `remindKey` 重复计一次尝试/重复发送。
  //   TTL 2 分钟：一轮 = 读 events/relations + 读 reminded/attempts/digest + 判定 + 原子写（秒级），给足余量。
  //   intervalMs 与 JOBS 行的 `intervalMs` 同值（60 秒）；JOBS 那行在
  //   `tools\dsh-butler\butler-tickd.mjs:213`（`args` 与 `benignExitCodes:[3]` 同一行 —— 加行会让
  //   `failure-classify.mjs` 的 ENV_EXIT_TABLE 行号全漂，改前先看那边）。
  //
  //   🔴 订正注（2026-10-29 · N3 卡「家人日程提醒一期」第 55 棒 · 只标注不改原文语义）：
  //     上面的「零依赖、不发消息」与下面的「append / 不发真消息」**都是 2026-10-23 的旧状态，已过期**：
  //     ① N2（`lib\remind.mjs` + `family-remind-tick.mjs` 落地）之后：`reminded.jsonl` 改为
  //        **按 `remindKey` 原子 upsert**（tmp + rename，方案 §0c #17），**不再是 append**；
  //        另新增 `attempts.json`（有界重试 3 轮 ⇒ gave-up）与 `digest.json`（静音窗汇总桶）；
  //        `activation.json` 由 `--activate` 写、job 内**只读**（缺 ⇒ fail-closed `rc=4`）。
  //     ② N2 起 `selectChannel` 缺省按 `'wechat'`（不再是 `() => null`）；**真发与否只由 `opts.send` 决定**，
  //        缺省 ⇒ `undeliverable/no-transport`。真发送末端 = `tools\wechat-bridge\lib\messaging\direct-transport.mjs`，
  //        接线属 **N3**（要the operator在场 + 开闸窗口）。
  //     ③ 锁纪律的现行口径 = 方案 §0c **#18**（提醒链自身不持锁 / 由 `lockRunner` 单实例串行）
  //        ＋ **#21**（`DSH_BUTLER_TICK_LOCK_HELD` 含 `family-remind` ⇒ job 环境**可归档**；否则手工禁归档；
  //        两者冲突时 **env 优先**）⇒ 下面 `critical` 已按此改写。
  //     真源 = `docs/` §0c #17/#18/#21 · §2 C3/C4 · N2/N3 交付报告。
  { job: 'family-remind', lockName: 'family-remind', script: 'family-calendar/family-remind-tick.mjs',
    ttlMs: 120_000, intervalMs: 60_000,
    critical: ['~/.dsh/family-calendar/reminded.jsonl（**写**：按 `remindKey` 原子 upsert，tmp+rename；幂等键取代旧 `eventId+remindAt`）',
      '~/.dsh/family-calendar/reminded-archive-YYYYMM.jsonl（**写**：append 归档；**仅 job 环境**，手工 `--force` 禁归档 ⇒ 方案 §0c #21）',
      '~/.dsh/family-calendar/attempts.json（**写**：有界重试计数 / nextAt 退避，tmp+rename）',
      '~/.dsh/family-calendar/digest.json（**写**：静音窗 22:30–07:00 汇总桶，tmp+rename）',
      '~/.dsh/family-calendar/activation.json（**只读**：开闸下界，缺 ⇒ fail-closed `rc=4`；只由 `--activate --at <ISO>` 写）',
      '~/.dsh/family-calendar/events.json + relations.json（**只读**：到点判定与收件人）',
      '**真发送（N3 接线后）**：经 `tools\\wechat-bridge\\lib\\messaging\\direct-transport.mjs` 直发（不传 contextToken、不走 channels.mjs）；`opts.send` 缺省 ⇒ `undeliverable/no-transport`，一条不发'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true,
    lockRunnerReason: '脚本自身无 acquireTickLock 且可被手工直跑（--once --apply）⇒ 必须由包装层抢锁，'
      + '否则手工与 tick 并发会读到同一批「未发」、对同一 remindKey 重复 upsert 状态行 / 重复计一次发送尝试' },
  // ── 2026-10-23（记忆衰减 P1·A0）：`memory-hit-collect` ─────────────────────────────
  //   每 10 分钟**只读** `~/.dsh/logs/memory-recall*.log`，把新增的 inject/expand/search 抄成
  //   `~/.dsh/memory-hits/YYYY-MM.jsonl`（按行内 t 归月、幂等键 = sha1(原始行)），顺手清 90 天前的分片。
  //   ⚠️ 判据 = 脚本自身**有**自己的互斥（`~/.dsh/memory-hits/.collect.lock`：wx 独占 + 5 分钟陈旧接管），
  //      **不用** butler 的 acquireTickLock ⇒ tickd 侧锁由 `acquireJobLock` 兜底；
  //      这里按 `lockName: <job id>` + 与 JOBS 行同档登记，**运行时逐值不变**（同 secretary-drift 先例）。
  //   ⚠️ 刻意不加 `lockRunner`（同 secretary-drift / plug-guard / snapshot 先例）。
  //   TTL 120_000：一轮 = 读增量 + 追加 + 原子写 state + 扫分片（实测毫秒级），给足余量。
  //   ⚠️ 本 job **只读日志、只写旁挂**：不碰 `memory.db`、不改 `dsh-memory` 插件、不动 pinned。
  { job: 'memory-hit-collect', lockName: 'memory-hit-collect', script: 'memory-hit-collect.mjs',
    ttlMs: 120_000, intervalMs: 10 * 60 * 1000,
    critical: ['`~/.dsh/logs/memory-recall*.log`（**只读**：绝不修改 / 截断 / 重命名 / 删除）',
      '`~/.dsh/memory-hits/YYYY-MM.jsonl`（**写**：仅追加；跨月分片按行内 t 归月）',
      '`~/.dsh/memory-hits/state.json`（**写**：先 .tmp 再 renameSync 原子覆盖）',
      '`~/.dsh/memory-hits/{badlines,purge}.log`（**写**：append；坏行只记 sha1，不落原文）',
      '`~/.dsh/memory-hits/.collect.lock`（**写**：单轮互斥）',
      '**不碰** `memory.db` / `dsh-memory` 插件目录 / pinned（纯旁路采集）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-26（卡「V3功能面·号段哨兵挂job」）：`band-sentinel` ─────────────────────────────
  //   每天 08:50 只读跑一遍「记忆号段复发哨兵」。⚠️ **实体在 `tools\memory-engine\`、不在本组件目录**：
  //   那个脚本是<mainline>线 A43b 交付的器具（判据口径已定稿：主判据只认 `sqlite_sequence.seq`、
  //   段计数只披露不判红），本卡**一个字都没改它**，只代挂 tickd job + 补这一行锁登记。
  //   ⚠️ 判据 = 脚本自身**没有** `acquireTickLock`（`band-sentinel.mjs` 全文零命中、也不 import
  //     `butler-locks`）⇒ 锁由 tickd 侧 `acquireJobLock` 兜底；**登记前** `lockNameFor()` 原样返回
  //     job id（实际锁名一直是 `band-sentinel`）、`deriveTtlMs()` 对无条目 job 兜底 300_000
  //     ⇒ 本行取 `ttlMs: 300_000` + `intervalMs: 0`（日历档 `at:'08:50'`）⇒ 三个运行时出口
  //     （`lockNameFor` / `deriveTtlMs` / `usesLockRunner`）与登记前**逐值相同 = 零行为变化**。
  //   ⚠️ 刻意不加 `lockRunner`（同 secretary-drift / preset-drift / plug-guard / snapshot 先例）：
  //     它**一轮纯读**（三台一律 `DatabaseSync({readOnly:true})`，对端只经 ssh 喂脚本、对端零写入）
  //     ⇒ 并发最坏是两边各读一遍库，没有可损坏的写面。
  //   ⚠️ 该 job 声明 `benignExitCodes:[3,4]`（号段异常 / 取数失败 fail-closed = 有结论地跑完，不记 failures）。
  { job: 'band-sentinel', lockName: 'band-sentinel', script: 'memory-engine/band-sentinel.mjs',
    ttlMs: 300_000, intervalMs: 0,
    critical: ['三台记忆库的 `sqlite_sequence.seq`（**只读**：本机 `~/.dsh/memory/memory.db` 直读；'
      + '<host> / <host> 经 ssh 把脚本喂给对端 node（`node -`），对端**只开只读连接、不落任何文件**）',
      '**零写入**：不写 `memory.db`、不动 pinned、不写状态文件、不落报告、不重启任何进程',
      '一轮输出只在 stdout（`--line` 一行；`--json` 给机器读）；出口 = tickd 调度日志 + （待接线）日报行'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-26（卡「V3功能面·号段哨兵挂job」**顺带补登** · 既有 J3 红）：`memory-sync-leaf` ───────
  //   来由（现跑读数，不是推测）：<mainline>线卡 A14 把 `{ id:'memory-sync-leaf', intervalMs: 15min }`
  //     接进 tickd JOBS 时**没同步登记锁** ⇒ `butler-registry-audit` 的 **J3「锁登记完整」**当场报红
  //     （「调度表 job 未登记锁：memory-sync-leaf」）。本卡改完自己的表位后重跑审计，这条红仍在
  //     ⇒ 同一条不变量、同一个文件，顺带补登：**只补元数据，不动调度、不动脚本、不改任何开关**。
  //   ⚠️ 判据 = 脚本自身**没有** `acquireTickLock`（`mem-push-leaf.mjs` 全文零命中、也不 import
  //     `butler-locks`）⇒ 锁由 tickd 侧 `acquireJobLock` 兜底；**登记前** `lockNameFor()` 原样返回
  //     job id（实际锁名一直是 `memory-sync-leaf`）、`deriveTtlMs()` 兜底 300_000
  //     ⇒ 本行取 `ttlMs: 300_000` + `intervalMs: 15 * 60 * 1000`（与 JOBS 行同值）⇒ 三个运行时出口
  //     **逐值相同 = 对运行时零行为变化**（与 snapshot / secretary-drift / preset-drift 同款处置）。
  //   ⚠️ 刻意不加 `lockRunner`（同 band-sentinel / secretary-sync / preset-drift 先例）。
  //   ⚠️ 该 job 声明 `benignExitCodes:[3]`（对端不可达 = 本轮让路，不记 failures）。
  { job: 'memory-sync-leaf', lockName: 'memory-sync-leaf', script: 'mem-push-leaf.mjs',
    ttlMs: 300_000, intervalMs: 15 * 60 * 1000,
    critical: ['本机 `~/.dsh/memory/memory.db`（**只读**：只走 `VACUUM INTO` 只读快照，禁整库复制/覆盖）',
      '本机临时快照 `<tmpDir>\\self-memory.db`（**写**：`deliverSelfSnapshot` 先 `unlinkSync` 再写；'
      + 'job args 显式给 `%TEMP%\\dsh-mem-sync-leaf`，与小时级 driver 的 `dsh-mem-sync` 刻意分开）',
      '对端 <host> inbox（**写**：scp 投递本机快照 + 成对撤回台账；投递成功后才 `pruneInbox(paths.inbox, keep)` '
      + '按保留策略删旧份；失败**不 prune**）—— <host> **只收不回流**，本脚本无任何"从对端读/合并/建向量"路径',
      '**不 import `runOnce`**：不做 pull、不合并、不碰向量库'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-30（卡「记忆两岸互通 S2」）：`memory-sync-life` ─────────────────────────────
  //   语义 = 每 30 分钟把「岸」（<host> 生活实例 · 独立 `DSH_HOME=<life-home>\.dsh`）新增的记忆
  //     增量导入本机库（`memory-import-life.mjs`，幂等：内容 sha256 + `srcid:` 双键）。
  //   ⚠️ 判据 = 脚本自身**没有** `acquireTickLock`（`memory-import-life.mjs` 全文零命中、也不 import
  //     本模块）⇒ 锁由 tickd 侧 `acquireJobLock` 兜底；登记只为防「手工直跑 + tickd 到点」
  //     并发踩同一份运行键（`butler-memory-life-import.json` 的 `rounds` 会被两边同时读改写）。
  //   ⚠️ **与 `memory-sync` / `memory-vectors` 不共用锁，也刻意不共用**：三者都碰
  //     `~/.dsh/memory/memory.db`，但本仓既有口径是「锁各管各的 job，同库靠 SQLite 自己串行」
  //     —— 本脚本 `pragma busy_timeout=20000` + 25 条一批 `BEGIN IMMEDIATE`，`memory-sync` 同款短事务；
  //     真撞上只是短暂等锁。且 `memory-vectors` 对记忆库只读、`memory-sync` 的跨机对象是工作线那台
  //     （**不含** `<life-home>` 这个独立 home）⇒ 语义上也不冲突。
  //   ⚠️ **零删除**：本脚本没有一行 DELETE / UPDATE（删行属乙档）；对端只走 `VACUUM INTO` 只读快照。
  //   ⚠️ `benignExitCodes:[3]`：对端不可达（<host> 关机 / 不在网 / ssh 别名不通）= 本轮让路，不记 failures；
  //     rc 4/5/6（取数读不动 / 回读不符 / 写不进去）是**真失败**，别塞进 benign。
  //   ⚠️ 刻意**不加** `lockRunner`（同 memory-sync-leaf / secretary-sync / tickd-inspect-15m 先例）。
  { job: 'memory-sync-life', lockName: 'memory-sync-life', script: 'memory-import-life.mjs',
    ttlMs: 60 * 60 * 1000, intervalMs: 30 * 60 * 1000,
    critical: ['本机 `~/.dsh/memory/memory.db`（**写**：新 id 落 [1_500_000, 2_000_000) 专用段、'
      + '一律重编号；25 条一批 `BEGIN IMMEDIATE` + `busy_timeout=20000`；**无 DELETE/UPDATE**，删行属乙档）',
      '本机 `~/.dsh/butler-memory-life-import.json`（**写**：运行键；`rounds` 尾部 20 轮 = 唯一台账）',
      '对端 <host> `<life-home>\\.dsh\\memory\\memory.db`（**只读**：唯一姿势 = 对端 node 跑 `VACUUM INTO` '
      + '到对端 `%TEMP%\\dsn-life-snap-*`，成功/失败都在 finally 删；绝不裸 copy 热库）',
      '本机 `%TEMP%\\dsn-import-*` / `dsn-target-*`（**写**：拉回的快照与前后回读快照；除 `--keep-snapshot` 外用完即删）',
      '**不碰**：人格真源 / 生活实例启动链 / 家庭保姆线 / 隧道链（`DSH-NetArbiter`、relay）/ `dsh-memory` 插件代码'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-11-06（卡「家庭保姆 · family 向量同步 job」· 方案 §4.2）：`family-vectors` ────────────────
  //   语义 = 每 60 分钟按家人库台账逐库**串行**补向量（`family-vectors-tick.mjs` 薄包装 → 现成执行体）。
  //   ⚠️ 判据 = 脚本**自己**会 `acquireTickLock('family-vectors', {ttlMs:50min, home:dshHome()})`
  //     （方案 §3.5：无条件调一次，继承判定在 acquireTickLock 第一道）⇒ 锁名必须与脚本内自报**逐字一致**。
  //   ⚠️ `lockRunner: true`：tickd 经 `lib/tick-job-runner.mjs` 抢锁后注入 `DSH_BUTLER_TICK_LOCK_HELD=family-vectors`
  //     （tickd L2404 现核）⇒ 脚本内那次 acquireTickLock 走虚拟锁、父子不双层加锁；**手工直跑**（无该 env）
  //     时脚本自己抢 `tick-family-vectors.lock` ⇒ 与到点那轮互斥。
  //   ⚠️ **不共用the operator的锁**：job id 自带锁名 ⇒ 无需进 `ALLOWED_SHARED_LOCKS`（那只管"多 job 共用一个 lockName"）。
  //   ⚠️ `ttlMs: 50 min` 必须 > 整轮真实上界（总预算 40 min + 收尾 < 1 min）：tickd 侧每 ttlMs/3 续租
  //     （`butler-tickd.mjs` L2396-2398），**只有手工直跑**才暴露"锁先到期 = 双写"。
  //   ⚠️ `benignExitCodes:[3]` 在 JOBS 侧声明（3 = 锁被占 / 对端不可达 ⇒ 让路）；1 是真失败。
  { job: 'family-vectors', lockName: 'family-vectors', script: 'family-vectors-tick.mjs',
    ttlMs: 50 * 60 * 1000, intervalMs: 60 * 60 * 1000,
    critical: ['~/.dsh/family-memory/memory-vectors-<key>/tick-state.json（每库各自的同步进度 + 桥台账）',
      '~/.dsh/family-memory/memory-vectors-<key>/vectors.db（**可重建**：删目录回到 datastore-unavailable，与现状等价）',
      '~/.dsh/family-memory/memory-family-<key>.db（**只读**：执行体一律 readOnly，本 job 零 DELETE/UPDATE）',
      '**不碰**：`butler-memory-vectors-state.json`（the operator memory-vectors job 的 state，每库显式 --state-file 隔离）'
      + ' · 生产 8201 桥（子进程一律 --no-bridge） · dsh-memory 插件代码'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: true,
    lockRunnerReason: '脚本会被手工直跑（node family-vectors-tick.mjs）与 tick 调度并发；锁继承靠 acquireTickLock 内置的 '
      + 'DSH_BUTLER_TICK_LOCK_HELD 判定（tickd L2404 注入），手工直跑时自己抢 tick-family-vectors.lock' },
  //   `tickd-inspect-15m`（2026-10-29 · V3 功能面 · B2 + D-b1 · **真源 = `docs/`**）：
  //     15 分钟档的**只读巡检** job，执行体 = 本卡新增的包装器 `tools\dsh-butler\tickd-inspect-15m.mjs`
  //     （串行跑两件：① `sync-ignore.mjs --check` 只读校验 → ② `text-sync-direct.mjs --prune-archive --apply`）。
  //     为什么要它：R-044 **两次复发**（2026-10-22 / 2026-10-28）长得一模一样 —— 判据在、没人跑
  //     ⇒ 把判据挂进 tickd，红了自动进日报「tick 调度健康」段（补登理由见 `butler-tickd.mjs` 的 JOBS 注释）。
  //     ⚠️ 判据 = 被 spawn 的两件**都不抢锁**（`sync-ignore.mjs` 纯校验；`text-sync-direct.mjs --prune-archive`
  //     在 `acquireTickLock` 之前就 return）⇒ 锁由 tickd 侧 `acquireJobLock` 兜底。
  //     ⚠️ **刻意不加 `lockRunner`**（同 `text-sync-direct` / `plug-guard` / `vanish-watch` / `snapshot` 先例）：
  //     包装层再抢一次对这两个子件毫无互斥价值，反而会给将来"脚本自己抢锁"的变体埋雷（永远判 locked）。
  //     ⚠️ `benignExitCodes` 刻意**不声明**：`--check` 的 rc=1（不一致）/ rc=2（仓库缺失）**都是真异常**，
  //     让路会把这条巡检变成"永远绿" —— 那正是 R-044 复发的病根。
  { job: 'tickd-inspect-15m', lockName: 'tickd-inspect-15m', script: 'dsh-butler/tickd-inspect-15m.mjs',
    ttlMs: 300_000, intervalMs: 15 * 60 * 1000,
    critical: ['`<offsync-root>\\git-backup\\dsh-core\\.gitignore`（**只读**：`--check` 只比对，绝不写）',
      '`~/.dsh` 顶层 `ops-*`（**只读**：新名覆盖自检逐条 `git check-ignore --no-index`）',
      '采集白名单 `collect-manifest.json`（**只读**：对账，不写）',
      '`<butler-root>\\_archive\\text-sync-direct\\<runId>\\`（**真删**：只裁最老的、只认 runId 形态目录；'
      + '非 runId 目录绝不碰；`--keep < 1` / 参数越界由脚本自己 rc=2 拒跑）',
      '审计行 `~/.dsh/…`（**写**：由 `text-sync-direct` 自己的 `appendAudit` 落，本包装器不写任何状态）'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-10-30（家庭保姆 · 46-B「outbox 超时告警」）：`outbox-stale` ─────────────
  //   判据 = 脚本自身**没有** `acquireTickLock`（`tools\mailbox\outbox-stale-tick.mjs` 全文零命中、
  //     也不 import 本模块）⇒ 锁由 tickd 侧 `acquireJobLock` 兜底。
  //     ⚠️ **刻意不加 `lockRunner`**（同 tickd-inspect-15m / vanish-watch / plug-guard 先例）：包装层再抢一次
  //     对"只读判定 + 原子写自己状态文件"毫无互斥价值，反而会给将来"脚本自己抢锁"的变体埋雷（永远判 locked）。
  //   ⚠️ ttlMs 取 300_000（`deriveTtlMs()` 的兜底值）+ intervalMs 与 JOBS 行同值 ⇒ 三个运行时出口逐值相同
  //     = 对运行时零行为变化（与 snapshot / secretary-drift / tickd-inspect-15m 同款处置）。
  { job: 'outbox-stale', lockName: 'outbox-stale', script: 'mailbox/outbox-stale-tick.mjs',
    ttlMs: 300_000, intervalMs: 15 * 60 * 1000,
    critical: ['`<butler-root>-mailbox\\qrog\\outbox\\*.json`（**只读**：只 `stat` + `git log -1 --format=%ct`；'
      + '绝不删 / 搬 / commit / push，绝不写 `mailbox` 分支）',
      '`~/.dsh/butler-outbox-stale.json`（**写**：去重位 `entries` / `day` / `dayCount` / `lastText` —— 原子写 tmp+rename）',
      '`~/.dsh/butler-alert.log`（**写**：只在 hub 与微信**都**发不出去时落一行兜底告警）',
      '`<butler-root>\\docs/`（**写**：同上兜底时的当日段一行，人可读）',
      '**零删除 / 零 git 写**：本件不 commit、不 push、不动任何仓内文件'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-11-02（卡 6f121702「统筹线·脑子」steward.mjs 甲层）：`steward` ────────────────────
  //   判据 = 脚本**自己** `acquireTickLock('steward')`（`tools\dsh-butler\steward.mjs` 主流程第 ① 步）
  //     ⇒ **刻意不加 `lockRunner`**（同 text-sync-direct / plug-guard 先例）：包装层再抢一次同一把锁，
  //     子进程会永远判 locked ⇒ 每个 job 都被误判为跳过。
  //   为什么这把锁必须有（方案 §2.3）：本 job 是 `~/.dsh/steward-state.json` 的**唯一写者**，
  //     而人工排障/验收随时会直跑 `node steward.mjs` ⇒ 无锁就会双写同一份 JSON（后写覆盖前写，
  //     幂等键只能防重复行，防不住整体覆盖）。抢不到锁的语义 = `skip`（静默跳过、不排队），
  //     第二天照跑，不丢结论。
  //   ⚠️ ttlMs 取 600_000：单轮 = 1 次 spawn standup（实测 ~1.3 s）+ 1 次看板 GET（7.8 MB 本地环回）
  //     + 原子写；给足余量兜住"本机负载高时 GET 慢"。
  //   ⚠️ **零真动作**：只读看板/年轮 + 只写自己那份 state；不叫停、不建卡、不验收、不发喊话（方案 §3.1/§5）。
  { job: 'steward', lockName: 'steward', script: 'dsh-butler/steward.mjs',
    ttlMs: 600_000, intervalMs: 0,
    critical: ['`~/.dsh/steward-state.json`（**写**：本 job 唯一写者；走 `store.writeTextAtomic` 原子写）',
      '看板 `GET /api/task-board/state` + 账本 `ledger-v2.json`（**只读**）',
      '`docs/` / `docs/`（**只读**：人写档，读时带 mtime）',
      '`tools\\dsh-butler\\standup.mjs`（**只读**：spawn 拿 `--json`，ageDays 的唯一权威源）',
      '**零删除 / 零改卡 / 零喊话**：不碰看板写口、不发 session-say'],
    skipPolicy: 'skip', source: 'tickd' },
  // ── 2026-11-04（统筹线 P2「B 路扫描」）：`mainline-scan` = `ledger-scan.mjs` ───────────────
  //   真源 = `docs/` §6.2 ② + §5.6。
  //
  //   ⚠️ **只登一个代表项**（= B 路 job 自己那把静态锁 `mainline-scan`）：
  //     `LOCK_REGISTRY` 是 **job → 锁名** 的静态表，装不下 `mainline-ledger:<lineId>` 这种按线
  //     展开的动态名 ⇒ 线锁（+ `_lines` 锁 + 第四把 `_cursor` 锁）当**数据级锁**，由
  //     `lib\mainline-ledger-writer.mjs` 在模块内自行管理，**不进这张表**。
  //     🔴 照字面把 `mainline-ledger:_lines` 登记成这个 job 的锁，会让 B 路**整轮持死 `_lines`**，
  //        把 `--register-line` / `--alias` / 未归线队列全堵在 30 s ttl 上（§5.6 那条）。
  //
  //   ⚠️ 判据 = 脚本**自己**在入口 `acquireTickLock('mainline-scan', …)`（手跑与 tickd 共用同一份
  //     代码、同一把真锁）⇒ **刻意不加 `lockRunner`**（同 text-sync-direct / plug-guard / steward 先例）：
  //     包装层再抢一次同一把锁，子进程会永远判 locked ⇒ 每轮 9 ms 让路、一行也写不出。
  //     （`auditRegistry` 只在 `lockRunner===true` 时校验 `lockRunnerReason`，但"为什么是 false"
  //      这件事更需要被人读到 —— 下一个重构的人一定会想加上它。）
  {
    job: 'mainline-scan', lockName: 'mainline-scan', script: 'ledger-scan.mjs',
    ttlMs: 120_000, intervalMs: 2 * 60 * 1000,
    critical: ['`~/.dsh/mainline-ledger/**`（**写**：全部经 `lib\\mainline-ledger-writer.mjs` 落地 '
      + '—— 主账 / `_sids` / `_ops` / `_cursor` / `_rates` / `_suppressed`；本脚本零写盘 API）',
      '会话日志 `~/.dsh/sessions/**`（**只读**：`readEvents` 分帧解，不改不搬不归档）',
      '看板账本 `task-board/ledger-v2.json` + 归档视图（**只读**：算 `cards` 六计数）',
      '**不许绕开 writer 直接 append**：`_cursor` / `_rates` / `_suppressed` 三笔都进同一个写者模块'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: false,
    lockRunnerReason: '包装层不再抢同一把锁：真锁由 ledger-scan 入口自己拿，tickd 侧与手跑走同一份代码才不会互相顶死',
  },
  // ── 2026-11-04（统筹线 P3「防偷偷缩目标」）：`mainline-anchor` = `anchor-watch.mjs` ────────────
  //   真源 = `docs/` §8.4 / §8.3（D-1 由the operator 2026-11-04 01:47 拍「②+③」）。
  //
  //   ⚠️ **只登一个代表项**（= 本条 `mainline-anchor`）：写锚/写快照真正用的是**按线展开的动态锁**
  //     `mainline-anchor:<lineId>`（ttl 30 s、`env:{}` ⇒ 交接窗口里不继承父锁），由
  //     `anchor-watch.mjs` 在模块内自行 `acquireTickLock(…)`。
  //     🔴 把 `mainline-anchor:<lineId>` 这种动态名塞进本静态表（§5.6 同款规矩）会让 auditRegistry
  //        把"每个 lineId"当一条 job 登记，且穷举不完 —— 线锁按数据级锁处置，**不进这张表**。
  //
  //   ⚠️ 判据 = 脚本**自己**在 `--apply` 路径上按线抢真锁（手跑与 tickd 共用同一份代码）⇒
  //     **刻意不加 `lockRunner`**（同 text-sync-direct / plug-guard / steward / mainline-scan 先例）：
  //     包装层再抢一次同一把锁，子进程会永远判 locked。
  //   ⚠️ `benignExitCodes` 刻意不声明：`rc=3`（快照/日报写不下去）**是真失败**（基线断 ⇒ before/after 失效），
  //     塞进 benign 就等于"跳过 = 没事"，正是 §8.4 明令禁止的那件事。
  {
    job: 'mainline-anchor', lockName: 'mainline-anchor', script: 'anchor-watch.mjs',
    ttlMs: 60_000, intervalMs: 2 * 60 * 1000,
    critical: ['`<butler-root>\\docs/`（**只读**：锚是人写的载体，本件只读不写；'
      + '写锚走 `anchor-init.mjs`，改锚必须带 changedAt/before/after/why/by）',
      '`<butler-root>\\docs/`（**写**：本件是唯一写者；'
      + '每线保留最近 30 份，超龄按文件名日期确定性删除；⚠️ 路径一律写 `<butler-root>\\_archive\\…` 走 junction）',
      '`<butler-root>\\docs/`（**写**：每轮覆盖，不 append；"日报一行"的载体）',
      '看板 `GET /api/task-board/state` + 账本 `ledger-v2.json`（**只读**：算档 A 名单）',
      '账本目录（**只读**：只 `_lines.json` 与读端视图；本件零写盘 API 落在账本里）'],
    skipPolicy: 'skip', source: 'tickd',
    lockRunner: false,
    lockRunnerReason: '包装层不抢锁：真锁是按线的 `mainline-anchor:<lineId>`，由 anchor-watch 自己在 --apply 路径上拿',
  },
];

/** job id 别名（历史/入口差异 → 规范 job id）。 */
export const JOB_ALIASES = {
  // tickd 的 job id 与注册表 job id 目前一一对应；保留别名表以便将来改名不改锁名。
};

/**
 * **允许共用同一把锁**的 lockName 白名单（§5.3 第 6 条 R12 的实现方式）。
 *
 * 背景：T2 的原始不变量是"锁名逐 job 唯一"，为的是同一 tick 不被两把锁白锁。
 * 但 H1b 的**触发源互斥**要求相反的另一件事：多类触发必须**共用同一把锁**才能互斥
 * ——`handoff`（手动/关机钩 Depart、开机钩 Arrive）与 `hot`（30 分钟热采 tick）抢的
 * 必须是同一把 `tick-handoff.lock`，否则两者会并发跑、把工作副本搅成中间态。
 *
 * 所以不变量改写成："锁名要么唯一，要么**显式登记在这张表里**"——既保留防呆
 * （漏登记/写错锁名会被 auditRegistry 与单测抓出来），又允许有意的共用。
 */
export const ALLOWED_SHARED_LOCKS = {
  handoff: 'H1b 触发源互斥：交接器（手动 / 关机钩 / 开机钩）与热采 tick 必须抢同一把锁（§5.3 R12）',
};

const BY_JOB = new Map();
const BY_LOCK = new Map();
for (const e of LOCK_REGISTRY) {
  if (BY_JOB.has(e.job)) throw new Error(`LOCK_REGISTRY: job 重复 ${e.job}`);
  // ⚠️ lockName **允许重复**（H1b 起：`handoff` 与 `hot` 共用 `tick-handoff.lock`——这是
  //     §5.3 第 6 条"四类触发源共用单例锁"的**实现方式**，不是配置错误）。
  //    这里保留"首见条目"作 lockEntryByName 的回答，多入口查询一律走 jobsForLock()。
  if (!BY_LOCK.has(e.lockName)) BY_LOCK.set(e.lockName, e);
  BY_JOB.set(e.job, e);
}

/** 规范 job id（吃别名）。 */
export function canonicalJobId(jobId) {
  const id = String(jobId ?? '').trim();
  return JOB_ALIASES[id] ?? id;
}

/** 注册表条目（未知 job → null）。 */
export function lockEntryFor(jobId) {
  return BY_JOB.get(canonicalJobId(jobId)) ?? null;
}

/** job id → 规范锁名；未知 job **按 id 原样**返回（向后兼容：不因漏登记而炸）。 */
export function lockNameFor(jobId) {
  return lockEntryFor(jobId)?.lockName ?? canonicalJobId(jobId);
}

/** 锁名 → 注册表条目（未知 → null）。 */
export function lockEntryByName(lockName) {
  return BY_LOCK.get(String(lockName ?? '').trim()) ?? null;
}

/** 同一把锁下有几个入口（>1 = 复核重点：谁持锁、谁跳过）。 */
export function jobsForLock(lockName) {
  const name = String(lockName ?? '').trim();
  return LOCK_REGISTRY.filter((e) => e.lockName === name);
}

/** 锁的the operator类型（'tickd' / 'schtasks' / 'both' / 'manual' / 'unknown'）。 */
export function ownerOf(jobId) {
  return lockEntryFor(jobId)?.source ?? 'unknown';
}

/**
 * 该 job 是否**必须经锁包装层**（`lib/tick-job-runner.mjs`）spawn —— 卡 S5·T2b。
 *
 * 为什么由注册表回答、而不是在 tickd 里再写一份 job id 清单：与 lockName / ttlMs 同源，
 * 避免"两处清单漂移"（新增或改名 job 时只改一处；auditRegistry 还会校验 reason 非空）。
 */
export function usesLockRunner(jobId) {
  return lockEntryFor(jobId)?.lockRunner === true;
}

/** 走包装层的全部 job id（tickd 自检 / 单测 / 报告用）。 */
export function lockRunnerJobIds() {
  return LOCK_REGISTRY.filter((e) => e.lockRunner === true).map((e) => e.job);
}

/**
 * 该 job 在交接窗口内是否**必须**让路（不得发起重启 / 不得抢交接锁）。
 * 依据 §17.1 T2：「RestartTick 在交接窗口内必须回 busy、不得拉起 DSH」。
 * H1b 追加 `hot`：热采与交接器**共用同一把锁**，本可由锁自然互斥，但先判窗口再跳过的收益是
 *   ——不产生 lock-takeover 审计噪音、也不让 tickd 白等；语义上等价，行为更干净。
 */
export function mustYieldInHandoff(jobId) {
  const id = canonicalJobId(jobId);
  return id === 'restart' || id === 'hot';
}

/** 锁现状表（人类可读 / Markdown，双机同构，便于写进卡与文档）。 */
export function describeLockTable() {
  return LOCK_REGISTRY.map((e) => ({
    job: e.job,
    lockName: e.lockName,
    lockFile: `tick-${e.lockName}.lock`,
    script: e.script,
    ttlMs: e.ttlMs,
    interval: e.intervalMs ? `${Math.round(e.intervalMs / 60_000)}m` : '日历/手工',
    source: e.source,
    critical: e.critical,
  }));
}

/**
 * 从环境变量解析"本进程已被父调度器持有的锁名集合"。
 * 继承标记由 butler-tickd.mjs 注入（tickd 持真实锁，子脚本据此跳过重复加锁）。
 * @param {Record<string,string|undefined>} [env]
 * @returns {Set<string>}
 */
export function heldLockNames(env = process.env) {
  const raw = env?.DSH_BUTLER_TICK_LOCK_HELD;
  if (!raw || typeof raw !== 'string') return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** 本进程当前是否持有某把锁（用于 store 的继承判定）。 */
export function isLockHeldByParent(lockName, env = process.env) {
  return heldLockNames(env).has(String(lockName ?? '').trim());
}

/**
 * 派生兜底 TTL：注册表缺项时用 max(2×interval, 5min)；无 interval → 5min。
 * 保证"锁比最长正常执行时间长"，且不会被短周期任务误抢。
 */
export function deriveTtlMs(jobId) {
  const e = lockEntryFor(jobId);
  if (e?.ttlMs) return e.ttlMs;
  const iv = Number(e?.intervalMs ?? 0);
  return Math.max(2 * (Number.isFinite(iv) ? iv : 0), 300_000);
}

/** 注册表完整性自检（供单测 / 部署后自检）：返回问题清单（空 = 通过）。 */
export function auditRegistry({ jobs = null } = {}) {
  const problems = [];
  for (const e of LOCK_REGISTRY) {
    if (!e.job || !e.lockName) problems.push(`条目缺 job/lockName：${JSON.stringify(e.job)}`);
    if (!Number.isFinite(e.ttlMs) || e.ttlMs <= 0) problems.push(`${e.job}: ttlMs 必须为正数`);
    if (e.skipPolicy !== 'skip' && e.skipPolicy !== 'busy') problems.push(`${e.job}: skipPolicy 非法（${e.skipPolicy}）`);
    if (!Array.isArray(e.critical) || !e.critical.length) problems.push(`${e.job}: critical 缺失`);
    // 【卡 S5·T2b】走锁包装层的 job 必须写明"为什么"—— 否则下一个人看不懂这层壳是干什么的、
    //   容易在重构时把它当冗余删掉（删了 = 跨入口互斥又没了）。
    if (e.lockRunner === true && !(typeof e.lockRunnerReason === 'string' && e.lockRunnerReason.trim().length >= 8)) {
      problems.push(`${e.job}: lockRunner=true 但缺 lockRunnerReason（为什么必须走包装层要能被人读到）`);
    }
  }
  // 锁名不变量：**要么唯一，要么显式登记为可共用**（见 ALLOWED_SHARED_LOCKS）
  const byLock = new Map();
  for (const e of LOCK_REGISTRY) {
    if (!byLock.has(e.lockName)) byLock.set(e.lockName, []);
    byLock.get(e.lockName).push(e.job);
  }
  for (const [lockName, jobIds] of byLock) {
    if (jobIds.length > 1 && !ALLOWED_SHARED_LOCKS[lockName]) {
      problems.push(`锁名 ${lockName} 被多个 job 共用但未登记白名单：${jobIds.join(',')}（共用必须显式登记，防写错锁名造成白锁）`);
    }
  }
  // 每个"日常调度 job"都必须有锁登记（漏登记 = T2 未覆盖）
  if (Array.isArray(jobs)) {
    for (const j of jobs) {
      const id = canonicalJobId(j?.id ?? j);
      if (!lockEntryFor(id)) problems.push(`调度表 job 未登记锁：${id}`);
    }
  }
  return problems;
}
