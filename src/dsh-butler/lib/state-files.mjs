// dsh-butler / lib/state-files.mjs —— 大管家状态文件登记表（方案 §6.5 的代码化）
//
// 单一数据源：schemaVersion / 持久性 / retention / 丢失后果 / 能否随仓1同步。
//   - butler-store 用它拿 schemaVersion 做迁移校验
//   - sync-ignore.mjs 用它生成 / 校验 dsh-core 工作副本 .gitignore 的排除段
//   - 后续卡（P0/P2/P5）新增状态文件必须在此登记，否则 sync-ignore --check 会报"未登记"
//
// 同步判据（方案 §6.5）：
//   内容带「设备短码 / 按会话 / 按设备」维度 → 可同步（跨机共享语义）
//   内容带「时间窗口 / 冷却 / 去重 / 锁」   → 禁止同步（双机共享会互相压制告警与自动动作）

import { toNewName } from './state-paths.mjs';

/** 仓1（dsh-core）工作副本中 .dsh 的挂载前缀。 */
export const REPO1_DSH_PREFIX = 'dsh/';

/**
 * @typedef {Object} StateFileSpec
 * @property {string}  name       ~/.dsh 下相对路径（目录以 / 结尾）
 * @property {number|null} schemaVersion  期望 schemaVersion；null = 不适用（目录/豁免）
 * @property {'persistent'|'volatile'|'exempt'} persistence
 * @property {string}  retention
 * @property {boolean} sync       能否随仓1同步
 * @property {string}  syncWhy    判据理由（写进 .gitignore 注释便于复核）
 * @property {string}  loss       丢失后果
 * @property {boolean} [onDemand]  **按需生成**（稳态下不存在属正常）—— 该位是 registry-audit
 *   **S5「登记有必须落盘」**的豁免位：S5 对 `onDemand !== true` 的**非目录项**断言磁盘存在；
 *   标 true 者**必须**同时写 `onDemandWhy`（否则 S5 记一条 problem —— 禁无理由豁免）
 * @property {string} [onDemandWhy] 为什么"不常驻"（判据可审计；一句话讲清真源/闸门/触发条件）
 * @property {string[]} [gitignoreNote]  .gitignore 段里插在该条目**之前**的注释行（纯 ASCII）
 */

/**
 * barewatch 两个原文件在 .gitignore 段的说明行。
 * ⚠️ 必须与 dsh-backup-sync.ps1 的 $ignore here-string **逐字一致**，否则 sync-ignore.mjs --check 报不一致。
 */
export const BAREWATCH_GITIGNORE_NOTE = [
  '# barewatch original filenames: single-machine alert stream (never synced as-is);',
  '# cross-machine copies live in dsh/butler-barewatch/<host>-{ledger.jsonl,state.json}',
  '# (host-prefixed collect, see Copy-BarewatchFiles; viewer: dsh-butler/barewatch-cross.mjs)',
];

/** @type {StateFileSpec[]} */
export const STATE_FILES = [
  {
    name: 'butler-monitor-registry.json', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（CI 不删，标 retired）', sync: false,
    // 【2026-09-17 拷问 2.6 收尾裁决】本文件**本版不落盘**（实测：本机 .dsh 无此文件、仓1 工作副本亦无；
    //   生态面板 client.js 亦写明「`butler-monitor-registry.json` 不存在，故不做依赖图」）。
    //   旧登记 sync:true 但冷采（dsh-backup-sync.ps1 $DshFiles）与热采（HOT_SPECS）两条路径都没有它
    //   ⇒ 长期以 knownGaps 形态报"登记说同步、实际没采"（采集四轴对账第 1 条）。
    //   判据不是"该不该同步"，而是"根本没有可同步的实体文件"：保留登记仅作历史对照
    //   （_test\verify-gitignore.mjs 拿它当"可同步项"对照样本，删条目会让该夹具失去对照组）。
    //   entities.mjs:431-433 读它作六路源之一 —— 读不到即跳过，无副作用。
    // ── 🔄 订正注（2026-10-10 · 卡「冲刺600·A域宪章层三件」）：**"本版不落盘"已不成立** ──────────
    //   该实体**已真落盘**：`~/.dsh/butler-monitor-registry.json`（7,262 B · 2026-10-10 22:03:09 ·
    //   `schemaVersion:1` + 7 条 CI），生成器/校验器 = `lib/monitor-registry.mjs` +
    //   CLI `butler-monitor-registry.mjs`（缺省 dry-run；`--apply` 落盘；`--check` 双向对账）。
    //   真跑读数：`--check` = 候选 7 / 注册 7 / 幽灵 0 / 漏网 0 / 结构自检 ✅（rc=0）。
    //   `sync` **仍维持 false**（= 不进仓1）：本文件的**跨机语义**（方案 §6.5 表列为"可同步"，
    //   但落地要连带改采集白名单 `dsh-backup-sync.ps1#$DshFiles` 与仓1 `.gitignore` 段）
    //   ⇒ 属**行为变更**、记「待主人拍板」，本卡不自行扩同步面。旧注释与 syncWhy 保留作历史对照。
    syncWhy: '本版**已落盘**（2026-10-10）但暂不随仓1同步（维护本 7 条 CI 的跨机语义要连带改采集白名单 = 行为变更，待主人拍板）；'
      + '登记保留作历史对照，entities 现能真读到该源',
    loss: '重新自动发现（S 档 / 期望值需主人重设）',
  },
  {
    name: 'butler-autonomy-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（保留最近 100 条迁移）', sync: false, syncWhy: '降档态属单机时间窗口状态，双机共享会互相压制',
    loss: 'fail-safe：默认 degraded（原 %TEMP% 方案重启/清理后静默放行自动动作）',
  },
  {
    name: 'butler-maintenance.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '维护窗口档（retention 明写「窗口结束即清」）⇒ 无维护窗口时本就不该存在，窗口期由写口按需生成',
    retention: '窗口结束即清', sync: false, syncWhy: '维护窗口=时间窗口，跨机同步会掩盖本机真实告警',
    loss: '读不到 = 无维护窗口（可能误报一条重启期告警）',
  },
  {
    name: 'butler-restart-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '心跳 1 条 + 最近 1 个批次 + 提醒去重 50 条', sync: false, syncWhy: '心跳 / 排队窗口 / 通知去重都是时间窗口状态，跨机共享会互相压制',
    loss: '心跳丢失 → 健康监控报「协调器可能被停/被拦」；排队明细丢失 → 下次 tick 重建',
  },
  {
    name: 'butler-watch-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每事件保留最近 1 条 + 90 天', sync: false, syncWhy: '冷却 / ack 状态，双机共享会互相压制告警',
    loss: '冷却 / ack 重置 → 可能重复推一次',
  },
  {
    name: 'butler-pitfalls.json', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（沉底不删）+ 单文件 <10 MB', sync: true, syncWhy: '跨机共享语义（坑库）',
    loss: '重新积累（历史 seed 可重跑）',
    // ── 【2026-11-05 · A 案 Q3「坑库写侧合一」】本文件**降为纯缓存/派生**，真源搬到 md ──
    // 背景：同一类事实以前在两处**各写各的**（本文件 = P4 自动聚类态 0.61 MB；坑库 md 树 = 18 件 0.9 MB，
    //   其中还有**人写的手工条目区**本文件里根本没有）⇒ 违反 R1「每类事实只有一个真源」。
    // 主人 2026-11-05 10:31「按建议落」拍板：**合读到坑库 md（人读的真源）**，本文件降为缓存并登记。
    // 口径实现 = `lib\pitfall-source.mjs`（读侧统一口）；写者**不变**（pitfall-tick / pitfall-cluster-tick 照旧写本文件，
    //   只是它不再是权威 —— 删本文件不丢「坑」，只丢聚类态）。
    authority: 'cache',
    canonical: '坑库 md（人读/人写的真源；机器只读，绝不自动改写；路径随宿主工作区而定）',
    derivedFrom: '本机 / 对端会话扫描（P4 tick 聚类）+ 坑库 md 的手工条目区',
    rebuildCmd: 'node <workspace>\\tools\\dsh-butler\\pitfall-tick.mjs --force',
    rebuildNote: '重建会**丢**：① count / firstSeen / lastSeen 的精确值（要从会话重扫才回来，重扫只覆盖还留在 sessions\\ 与 '
      + '_archived-sessions\\ 里的会话）② tools 计数 ③ sessions 列表 ④ stage / likelyFixed 判定位 ⑤ 跨机合并进度（devices 并集）'
      + ' ⇒ **已知代价**：聚类态归零、坑库主榜重排；**不丢** md 里人写的条目（那是真源，机器不写它）。',
  },
  {
    // 【2026-09-20 · 施工卡 ②-3 · D2：同一文件的两条重复登记**已合并为这一条**】
    //   原状：本文件里 `butler-auto-actions.json` 登记了两次（本行 = 数组第 7 条 / 原第 27 条），
    //   且 **retention / syncWhy / loss 三个字段全是两套说法**（审核实证见 ② 包 §15-R6）。
    //   合并口径（② 包 §16-3 采纳意见）：`retention` 取**并集**（两条语义都保留）、
    //   `syncWhy` 取**更具体**那条并把另一条原话并拢、`loss` 取**更严**那条。
    //   ⚠️ 位置刻意保留在**首条**：`specOf()` 与消费方（如 `_test\test-auto.mjs` 的 `find()`）
    //      一律 `.find` 取首条 ⇒ 保留首条 = 消费语义零变化（② 包 §12.4-1 已查明消费方）。
    //   ⚠️ 本改动有**跨仓派生链**：`gitignoreBlock()` 逐条输出 ⇒ 少一条登记就少一行 ⇒
    //      仓1 工作副本 `.gitignore`（`node sync-ignore.mjs` 重生成）与 `dsh-backup-sync.ps1` 的
    //      `$ignore` 段（`node patch-backup-ignore.mjs`，`-Init` 生成器）都必须同步，
    //      否则下次 `-Init` 把旧段写回、`sync-ignore --check` 转 ❌（② 包 §9 风险首行 四步闭环）。
    name: 'butler-auto-actions.json', schemaVersion: 1, persistence: 'persistent',
    retention: '签名 500 条 / 30 天 + 每日计数 30 天 + 最近 50 条结果（并集口径：原第二条登记写「最近 30 天」，'
      + '与本条的 30 天窗口同义，按并集一并保留）',
    sync: false,
    syncWhy: '自动动作的「签名去重 24h 窗口 + 每日次数上限」是单机时间窗口口径，跨机共享会互相压制自动动作'
      + '（并集口径：原第二条登记写「24h 去重表，双机共享会让另一台漏执行自动动作」）',
    loss: '去重与计数重置：可能重复处理一次同一动作（有上限兜底）；每日上限需重新累计',
  },
  {
    name: 'butler-autonomy-limits.json', schemaVersion: 1, persistence: 'persistent',
    retention: '1 份（主人设定）', sync: false,
    syncWhy: '各机自算 / 各自设定（2026-09-16 主人裁决）：限额是**本机**自主动作的运行边界，跨机共享等于让另一台的设定静默覆盖本机；原写 sync:true 但冷采/热采两条路径都没有它 ⇒ 从未进仓（"登记说同步、实际没采"的假象）',
    loss: '回落代码默认（更严：5 次/日），不放开任何权限',
  },
  {
    name: 'butler-precheck.json', schemaVersion: 1, persistence: 'persistent',
    retention: '最近 200 张卡 + 累计计数', sync: false,
    syncWhy: '按本机看板卡内容指纹记账（同卡内容变才重检），跨机共享会让另一台误判「已检过」而漏检',
    loss: '重建（下次 tick 重新预检，纯只读成本低）',
  },
  {
    name: 'butler-token-usage.json', schemaVersion: 1, persistence: 'persistent',
    retention: '按会话累计（不删）+ 扫描记账 + 最近 50 条错误', sync: false,
    syncWhy: '各机自算（2026-09-16 主人裁决）：口径是「本机扫本机会话得出的用量」，跨机共享会让两台互相覆盖、算出来的数不是任何一台的真实值；要跨机对照走日报/看板，不走文件同步',
    loss: '重扫（增量记账重置 → 首扫需再解一遍会话日志，分钟级）',
  },
  {
    // 补登（2026-10-29 · N3 卡执行会话 · registry-audit S4 报「磁盘有必须登记」）：
    //   生产者 = `tools\life-shared-push.mjs`（卡【小汐新家·记忆v2-2】人生库只读副本投给 对端机 上的小汐，
    //   计划任务驱动）。原样挂在 `~/.dsh/` 根下、名字带 `butler-` 前缀，但一直没登记 ⇒
    //   所有跑 `butler-registry-audit.mjs` 的卡都吃这一条红（与本卡的提醒链改动无关，纯登记缺口）。
    //   内容 = `{schemaVersion, runs, consecutiveDeferred, lastRunAt, lastResult, peer, files}`；
    //   `files[<YYYY-MM>.md].settledSha` 是「上次投成功后对端实测 sha」的记账（drift 判据主链）。
    //   2026-10-30（r36C · lifePUSH 告警收敛）新增两字段（**既有字段一个没动**）：
    //     · `blockedActive` = 当前是否有未清的四类硬闸拒投（true 时 48h 新鲜度告警不再单独喊）；
    //     · `blocked` = `{fingerprint(命中集合指纹), files[{name,header[],entries[{title,keys[]}]}],
    //       staleAt, detectedAt, firstDetectedAt, lastAlertAt, lastAlertFingerprint,
    //       lastAlertReason, clearedAt}` —— 告警去重与 `--blocked` 的唯一数据源。
    name: 'butler-life-shared-push.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（`runs` 计数 + 每份月度文件各自的 `settledSha/settledAt/bytes/mtimeUtc` + 拒投面的 `blockedActive/blocked`）', sync: false,
    syncWhy: '投递记账是**本机→对端**的单向事实（`settledSha` = 对端实测 sha）；跨机共享会让另一台把"别人推的"当成"自己推的"，drift（副本被改）判定随即失效',
    loss: '重建（下一轮 `--apply` 重算本地 sha 并重投；缺 `settledSha` 只多投一次，投递本身幂等、内容相同也照写）',
  },
  {
    // 补登（2026-10-30 · r36C 卡执行会话 · `butler-registry-audit.mjs` S4 报「磁盘有必须登记」）：
    //   生产者 / 读者 = `tools\life-shared-push.mjs`（`loadFilterConfig()`）与 `tools\life-append.mjs`。
    //   内容 = `{enabled, words[], minHits}`：人生库投递前的**条目分拣开关 + 工作向词表**（a 案）。
    //   ⚠️ 缺文件 = 开关关闭 + 内置默认词表 ⇒ 文件本身可选；但磁盘上已有这份（`enabled:false`），
    //      不登记会让「登记 ↔ 磁盘」不闭合，故补登。
    name: 'life-filter.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（开关 + 词表 + 阈值；人工维护，不追加）', sync: false,
    syncWhy: '分拣只在**投递侧（本机）**生效，对端不读它；跨机共享会让另一台用自己的词表判"该投什么"，与 `settledSha` 记账的口径打架',
    loss: '重建 = 下一轮按「未配置」处理（开关回落关闭 + 内置 14 词）⇒ 投递回到"整份全投"，不丢数据、只是分拣失效',
  },
  {
    // 声明式登记（§6.5 单一数据源）：自动动作的**前置备份**归宿。
    // 生产路径的账本备份落 <workspace>\_archive\p3-auto-backup-<日期>\（盘外、不进仓）；
    // 本项留给回滚 CLI 的默认备份目录（~/.dsh/butler-backups/）——单机时间点数据，禁同步。
    name: 'butler-backups/', schemaVersion: null, persistence: 'persistent',
    retention: '备份文件按日累计；>30 天可人工清理', sync: false,
    syncWhy: '本机账本 / 文件的时间点备份（L1/L2 动作前置备份与回滚用），跨机无意义且体积大',
    loss: '回滚能力下降（L1 合并本身也可从审计行还原；删备注即可）',
  },
  {
    name: 'butler-pitfall-scan.json', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（按 sessionId，会话文件消失也保留）', sync: false,
    syncWhy: '按本机会话 id 记账（含路径/mtime），跨机共享会让另一台误判「已扫过」而漏扫',
    loss: '重扫（首扫秒级～十秒级，此后增量）',
  },
  {
    name: 'butler-sessions-health.json', schemaVersion: 1, persistence: 'persistent',
    retention: '最近 90 天', sync: false, syncWhy: '按本机会话 / 时间窗口采样，跨机混合会算错健康度',
    loss: '重扫',
  },
  {
    name: 'butler-entities.json', schemaVersion: 1, persistence: 'persistent',
    retention: '全量重建（六路源：CI 名 / 方案 P 标题 / 看板卡 / docs 文件名 / _archive 顶层目录 / 记忆标题）',
    sync: true, syncWhy: '按设备维度索引（跨机可各自重建），跨机共享语义（对账参照系）',
    loss: '重建（秒级；语料不变时靠 corpusHash 复用）',
  },
  {
    name: 'butler-reconcile-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '去噪 seen 最近 500 条 + 忽略规则最近 200 条', sync: false,
    syncWhy: '「同实体同类型 24h 只提示一次」的冷却表 + 本机忽略规则，都是单机时间窗口/去重状态 —— '
      + '跨机共享会让另一台被对方的提示压制（P2 冷却判据同款）',
    loss: '重建（代价：已提示过的条目可能再提示一次；忽略规则需重新登记）',
  },
  {
    // 登记名 = **实际落盘名**（host 分文件，2026-09-11 起）。
    // 2026-09-15 修正（AT4 卡 · 三项未接线状态文件）：此前登记的是逻辑名/旧单文件名
    //   `external-sources.json`，而该文件在本版代码里**已不存在**（external-sources.mjs:202-203
    //   writeRegistry() 永远写 host 文件；legacySourcesPath() 只读不写，本机 侧 127ec76 已删净）。
    //   ⇒ 旧的登记名与"采集白名单显式列 external-sources-<host>.json"对不上，
    //     正是 docs-pending-cards #22 读出的"登记说同步、实际没采"假象的来源（登记名 → 落盘名脱钩）。
    //   注意：name 用 <host> 占位，因为本表是跨机共享代码而非运行态快照。
    name: 'external-sources-<host>.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每源最近 30 份快照 / 单机注册表 1 份', sync: true,
    syncWhy: '外部源定义跨机共享；**实际落盘名带主机短码**（external-sources-<host>.json）——'
      + '两台机各存一份、互不覆盖（此前同名互覆 → 每次 depart 被推前超集门挡）',
    loss: '首轮只报"有变化"',
  },
  {
    name: 'butler-external-snapshots/', schemaVersion: null, persistence: 'persistent',
    retention: '每源最近 30 份', sync: true, syncWhy: '外部源快照，跨机共享语义',
    loss: '首轮只报"有变化"',
  },
  {
    name: 'butler-external-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每源运行态 1 条 + 当日 digest + 冷却/门控记录', sync: false,
    syncWhy: '冷却 / 24h 提示门 / 连续失败计数都是单机时间窗口状态，跨机共享会互相压制提示',
    loss: '重建（首轮重新建基线；失败计数与 24h 门重置 → 可能重复提示一次）',
  },
  {
    name: 'butler-audit/', schemaVersion: null, persistence: 'persistent',
    retention: '永久；>30 天留摘要行（append-only）', sync: true, syncWhy: '不可重建，必须随仓1备份',
    loss: '不可重建',
  },
  {
    name: 'butler-audit-off.json', schemaVersion: 1, persistence: 'persistent',
    retention: '开关关闭即写 off:false（保留原因）', sync: false, syncWhy: '逃生舱开关=单机时间窗口状态，跨机共享会互相压制审计',
    loss: '读不到 = 不暂停（fail-safe：审计照常，宁可多拦不可漏拦）',
  },
  {
    name: 'butler-watch-fs-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每受管文件保留 1 条 hash + 快照索引', sync: false, syncWhy: '本机快照索引（%TEMP% 路径），跨机同步无意义',
    loss: '重建（下次扫描重新建立快照）',
  },
  {
    // 2026-09-15 接线（AT4 卡 · 三项未接线状态文件）：此前 sync:true 却不在采集白名单
    //   （dsh-backup-sync.ps1 的 Copy-BarewatchFiles 名单里没有它）→ 从未进仓。
    //   落盘点 = 仓1 `dsh/butler-barewatch/<host>-butler-falsepositives.jsonl`
    //   （按主机名前缀；采集实现见 dsh-backup-sync.ps1 同名函数的显式映射表）。
    name: 'butler-falsepositives.jsonl', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（append-only：一条 = 一次 --false-positive 标记）', sync: true,
    syncWhy: '误报校准数据跨机共享；落盘侧同名（~/.dsh/butler-falsepositives.jsonl，无 host 后缀），'
      + '采集侧按主机名前缀落仓（dsh/butler-barewatch/<host>-butler-falsepositives.jsonl）'
      + '——跨机读取侧 barewatch-cross.mjs:244 已按 host 前缀期待该文件',
    loss: '校准数据缺失（对端误报明细不可见 → barewatch-pool 判"明细不完整"）',
  },
  {
    // 2026-10-16 接线（R-067 门误报治理 · 卡「V3·机器锁7」）：本卡新增的**绕过留痕台账**。
    //   落点 = `~/.dsh/butler-bypass-ledger.jsonl`；写入方 = `tools\lib\bypass-ledger.mjs`（append-only · fail-open），
    //   消费方 = 日报「🚧 门绕过台账」段（`tools\dsh-butler-panel\report.mjs`）。
    //   为什么必须登记：磁盘有而表里没有 ⇒ 「登记 ↔ 磁盘」不闭合（判据 S4），日报「🧾 登记一致性」当场报红
    //   —— 本卡首次跑日报即实测到该红项（3 项差异之一），故补登（**引入即登记**，别把欠账留给下一张卡）。
    name: 'butler-bypass-ledger.jsonl', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（append-only：一条 = 一次「门被判拦 + 显式放行开关真被用上」）', sync: false,
    syncWhy: '单机观测数据：每条自带 host/pid 可分辨来源，但**采集侧没有它的映射**——'
      + '若标 sync:true 而 dsh-backup-sync.ps1 的 Copy-BarewatchFiles 名单里没有它，就会变成'
      + '「声称同步、实际从未进仓」（正是 2026-09-15 AT4 卡修的那类缺陷，见上面 butler-falsepositives 条）'
      + '⇒ 先如实标 false；要跨机汇总须先加采集映射再改本行',
    loss: '重新积累（观测期从头计时）—— 该台账是**观察面**，丢它不阻断任何流程（fail-open）',
  },
  {
    name: 'butler-autonomy.json', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（每次改动落审计）', sync: false,
    syncWhy: '裸跑期计时 / 放行态属单机时间窗口状态，跨机共享会让另一台被另一台的放行决定带跑',
    loss: 'fail-safe：读不到 = 四项「自动执行」全关（宁可少做，不可未放行就自动执行）',
  },
  {
    name: 'butler-barewatch-ledger.jsonl', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（append-only 逐条告警台账）', sync: false,
    gitignoreNote: BAREWATCH_GITIGNORE_NOTE,
    syncWhy: '本机告警流 + 设备维度（事件判定依赖本机会话/磁盘/同步状态），跨机混合会算错误报率；'
      + '仓内以 dsh/butler-barewatch/<host>-ledger.jsonl 主机名前缀归档（Copy-BarewatchFiles），原文件不直接同步',
    loss: '重新积累（观测期从头计时）',
  },
  {
    name: 'butler-barewatch-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（元数据 + gap 记录最近 50 条）', sync: false,
    syncWhy: '采集时间窗口 + 本机观测期起点，跨机共享会互相覆盖；'
      + '仓内以 dsh/butler-barewatch/<host>-state.json 主机名前缀归档（Copy-BarewatchFiles）',
    loss: '重建（从台账重算，仅丢 gap 记录）',
  },
  {
    name: 'butler-barewatch/', schemaVersion: null, persistence: 'persistent',
    retention: '永久；每机每 tick 覆盖自身那一份（<host>-ledger.jsonl / <host>-state.json）', sync: true,
    syncWhy: '按主机名前缀采集的跨机副本（双机各存一份、互不覆盖）；只读对照用，不参与本机门槛判定',
    loss: '跨机对照数据缺失（本机台账不受影响，下次采集重建）',
  },
  // 【2026-09-20 · 施工卡 ②-3 · D2 收口】这里原有一条 `butler-auto-actions.json` 的**重复登记**
  //   （数组第 27 条，retention 写「最近 30 天」）—— 已合并进本数组第 7 条那一条（保留并集：
  //   retention / syncWhy / loss 三个字段都并入，无信息丢失）。
  //   ⚠️ 删掉它**会改变 `gitignoreBlock()` 的行数**（原两行 → 一行）⇒ 仓1 `.gitignore` 与
  //      `dsh-backup-sync.ps1` 的 `$ignore` 段必须同批重生成（② 包 §9 风险首行「四步闭环」）。
  {
    name: 'butler-p4-candidates.json', schemaVersion: 1, persistence: 'persistent',
    retention: '待确认候选，确认后清', sync: true, syncWhy: 'P4 候选跨机共享语义',
    loss: '重扫',
  },
  {
    name: 'butler-locks/', schemaVersion: null, persistence: 'volatile',
    retention: '进程重建 / 过期抢占', sync: false, syncWhy: '锁=单机互斥，跨机同步会造成假锁',
    loss: '锁丢失 → 最多重复执行一次（butler-auto-actions 去重兜底）',
  },
  {
    name: 'butler-alert.log', schemaVersion: null, persistence: 'volatile',
    retention: '最近 30 天', sync: false, syncWhy: '本机告警日志（时间窗口），跨机同步无意义且会串味',
    loss: '告警历史丢失（不影响功能）',
  },
  {
    name: 'butler-version.json', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（部署即写）', sync: true, syncWhy: '产品版本声明，跨机应一致（各机部署同版本）',
    loss: '组件启动自检无法确认版本 → 按契约跳过 + 告警',
  },
  {
    // 2026-10-10 卡「冲刺600·补核心库」（gap-1-49）：P8 收纳**规范文件**此前未登记
    //   （`state-files.mjs` 里 `butler-tidy-policy` 零命中）⇒ 属「磁盘/规范有 · 登记无」。
    //   本条目登记的是 **`~/.dsh` 兼容位**；**主位置**在 `tools\dsh-butler\butler-tidy-policy.json`
    //   （随仓3 同步）—— 本表 `name` 语义 = `~/.dsh` 下相对路径（见 lib/registry-audit.mjs S4 注释），
    //   故主位置不在本表口径内，只在下面的 syncWhy / loss 里写明三处读取顺序。
    //   ⚠️ 反面代价记一笔：本条目登记时兼容位磁盘上**尚不存在**（`Test-Path ~/.dsh/butler-tidy-policy.json`
    //      = False，2026-10-10 实测）—— 登记 = 声明"该位是受管状态文件"（读方按 readOrder 回落主位置即可）。
    name: 'butler-tidy-policy.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: 'P8 收纳规范的 **~/.dsh 兼容位**（真源 = tools\\dsh-butler\\butler-tidy-policy.json，随仓3）——读方按 readOrder 回落主位置，兼容位未落地不影响任何判据（见本条目上方 2026-10-10 注）',
    retention: '随规范修订覆盖（无历史；主位置用 `updatedAt` 记版本日期）', sync: false,
    syncWhy: '**本表 sync 的语义 = 「是否被仓1（dsh-core）采集链覆盖」**（不是「跨机是否该一致」）：'
      + '本文件的**规范主位置**在 `tools\\dsh-butler\\butler-tidy-policy.json`，随**仓3（dsh-workspace）**同步 ——'
      + '跨机一致性由仓3 那条链负责。本兼容位（`~/.dsh`）当前**没有采集条目**（`collect-manifest` 未列它），'
      + '如实记 `sync:false`（首版曾记 true，被 registry-audit **S2「sync:true 必须被采集」当场拦下** ——'
      + '这正是该断言的用途：不许"登记说同步、实际没采"）。'
      + '⚠️ 若将来要让兼容位也随仓1 同步 ⇒ **补 `collect-manifest` 条目**后再把这里改回 true（触发式，别只改一处）',
    loss: '按 readOrder 回落：主位置 `tools\\dsh-butler\\butler-tidy-policy.json` → 再回落 '
      + '`tools\\dsh-wrapup.ps1` 的内联白名单副本；三级都读不到才用审计器内置默认 —— '
      + '此时**根目录越界与命名漂移会误报**（正是 [11b]/2026-09-22 两次补登记的成因）',
  },
  {
    name: 'butler-tidy-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每路径 1 条 + 最近 30 轮摘要 + 180 天', sync: false,
    syncWhy: 'P8 收纳审计的**本机文件系统事实 + 时间窗口**（每 6h 一轮的审计时点、_tmp/_archive 计数），'
      + '跨机共享会让另一台读到对方的目录规模与审计时刻',
    loss: '重扫（下次 tick 重建；无可重建以外的数据损失）',
  },
  {
    name: 'butler-handoff.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每机 1 条（每次完整 Depart/Arrive 覆盖）', sync: false,
    syncWhy: '本机交接单（心跳 / T3 对偶门基线 applied[] / 主机名 / 卷体积）—— 跨机同名互覆；'
      + '仓内以 dsh/butler-handoff/<host>.json 主机名前缀归档（handoff.mjs 自行落盘提交），原文件不直接同步',
    loss: 'T3 对偶门失去基线 → 下次 Arrive 全部走 skipped(unrecorded)（保守拒绝覆盖，不会静默覆盖本机改动）',
  },
  {
    name: 'butler-handoff/', schemaVersion: null, persistence: 'persistent',
    retention: '每机每份覆盖（<host>.json；只增不删）', sync: true,
    syncWhy: '按主机名前缀的跨机交接单副本（双机各存一份、互不覆盖）；Arrive 靠它做心跳双字段与对端交接状态判读',
    loss: '跨机心跳 / 对端交接状态不可见（本机交接单不受影响，下次 Depart 重建）',
  },
  {
    // H1b · 2026-09-14：热采（30 分钟档）的搬运快照（会话 id → bytes/mtimeMs/state）。
    name: 'butler-handoff-hot.json', schemaVersion: 1, persistence: 'persistent',
    retention: '会话 id 级快照（只增不删；随会话归档自然失效）', sync: false,
    syncWhy: '「每个闭合周期搬一次」的记账是**单机判断**（本机文件何时变）——跨机共享会让另一台'
      + '误判"已搬过"而漏搬自己的增量，属单机时间窗口状态；且体积随会话数线性增长（上百 KB），'
      + '进仓纯属负担（会话本体走仓2）',
    loss: '快照丢失 → 下一轮把全部已闭合会话重搬一遍（幂等，只多一次 I/O 与提交，不丢数据）',
  },
  // ── 2026-10-11（卡「文件同步」）：跨机文本同步状态 ─────────────────────────────
  {
    name: 'butler-text-sync.json', schemaVersion: 1, persistence: 'persistent',
    retention: 'last（最近一轮完整结果）+ rounds（最近 48 轮摘要：时间/结果/通道/条数/提交/推送）',
    sync: false,
    syncWhy: '记的是**本机**跨机文本同步的进度与结果（channel / lastSupersetAt / 每仓采集·回灌·提交·推送）'
      + '—— 两台机各跑各的、各自记账，跨机共享会让另一台按对端的进度判自己（同 butler-mem-sync-state.json 款）；'
      + '且它是"本机立场"的状态，按骨架 v2 §5.3 一律不进任何仓/同步链',
    loss: '丢失 = 下轮当首次运行：只影响两件事 —— ① 状态可读性 ② 超集体检节流基准（lastSupersetAt）失效'
      + ' ⇒ 下轮会多跑一次完整超集体检（实测约 3.6 分钟）；同步本身的正确性不受影响（每轮都重新算差异）',
  },
  {
    // 【2026-10-28 · 卡「V3功能面 · 同步可观测性」（B1）】文本**直连**同步（不经仓）的自有账本。
    //   写方 = `tools\dsh-butler\text-sync-direct.mjs` 的 `finalizeRun()` → `recordRound()`（唯一记账入口）。
    //   口径 = 8 条写死 + 本段登记（出处不在本包内）。
    //   ⚠️ dual 期**两个名字**：primary `ops-text-sync-direct.json` + mirror `butler-text-sync-direct.json`
    //      （`writeTargets()` 算出，本表登记旧名 = 逻辑名，`registry-audit` 的别名归并认得出两个拼写）。
    //   ⚠️ 权威源不是本文件：一轮同步的原始件是 `_archive\text-sync-direct\<runId>\manifest.json`
    //      （不可重算 + 回滚器唯一输入）；本文件是**派生视图**，可丢可删，`--status` 缺失时回退扫最近一份 manifest。
    name: 'butler-text-sync-direct.json', schemaVersion: 1, persistence: 'persistent',
    // ✅ 已摘 onDemand（2026-10-28 21:4x · 主会话验收时现跑核实）：tickd job `text-sync-direct` 于
    //   2026-10-28T13:41:52Z（本地 21:41:52 = 20:41 那轮 +60 min 的节拍）**真跑落地** ——
    //   生产 home 里 primary `ops-text-sync-direct.json` 与 mirror `butler-text-sync-direct.json` **都在**
    //   （各 2,366 B / `createdAt 2026-10-28T13:42:11Z`），`_archive\text-sync-direct\20261028-214152-8948-9b4f\manifest.json`
    //   同步产出（peerHost `对端机` · 推 13 份 / 2.67 MB）⇒ 原摘除条件满足。
    //   （当时标 onDemand 的理由 = 首次 --apply 前不存在；**不许**拿夹具 home 跑巡检来判断，`registry-audit`
    //    的夹具门在显式注入 home 时默认关 S5 ⇒ 那样看是假绿。）
    retention: 'last（最近一轮完整结果；conflicts[] ≤200 条）+ rounds（最近 48 轮摘要：时间/模式/方向/退出码/'
      + 'reason/通道/推·更·跳·冲·拉五计数/两字节）+ idle（三态 state / streak / since / lastPushAt / lastExit）',
    sync: false,
    syncWhy: '记的是**本机**直连同步的进度与结果（本机 ↔ 对端的轮次账 + 空转计数）—— 两台机各跑各的、各自记账；'
      + '跨机共享会让另一台按对端的进度判自己（同 butler-text-sync.json 款）；且它是"本机立场"的状态，'
      + '按骨架 v2 §5.3 不进任何仓/同步链',
    loss: '丢失 = 下轮当首次运行（按方案 §3.1 口径 6 回退 primary/mirror，或 `--status` 从最近 manifest 只读回显）：'
      + '只影响状态可读性（48 轮历史与 idle 计数归零），**同步正确性不受影响**（每轮都重新算差异）；'
      + '`idle.streak` 归零会让空转提示晚一天出现（阈值 24 轮）',
  },
  {
    // 记忆库每日热采（2026-09-17 · 卡「记忆库每日 1 次热采 + 内容未变不推」）：
    //   记本轮快照 sha256 / 仓1 副本 sha256 / 条数 / 推送结果 + 最近 30 轮历史。
    name: 'butler-memory-snapshot.json', schemaVersion: 1, persistence: 'persistent',
    retention: '最近 30 轮历史 + 累计计数', sync: false,
    syncWhy: '记的是**本机** `memory.db` 与仓1 副本的字节指纹（sha256）+ 本机推送结果 ——'
      + '跨机共享会让另一台误判"已推过"而漏推自己那份变化（两机记忆库内容本就不同，'
      + '合并走 merge-memory 的停机窗口，不走文件同步）',
    loss: '下一轮重新判定（内容未变则重算一次 sha；最大代价 = 多一次 VACUUM 与一次空提交检查）',
  },
  {
    name: 'upgrade-lock', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '升级锁文件：正常收尾即 clear 删除 ⇒ 无锁 = 常态，只在持锁窗口内存在',
    retention: '单路径 1 条（一次升级一条，正常收尾即 clear 删除）', sync: false,
    syncWhy: '升级锁=单机互斥 + 进程/心跳时间窗口状态（pid / 心跳 / 静默窗期间的时间轴）——'
      + '跨机同步会造成"假锁"（另一台的锁把本机升级挡住），且会把本机的中断现场与对方现场混成一条',
    loss: '无法判断升级是否中断（半升级态只剩"起不来"的表象，判不出卡在哪一步、该回滚什么）',
  },
  // 卡 [Q1] 队列推进巡检（B 主干）：档位配置 + 通知台账 + 事件信箱（[Q2] 协议 v1 的消费端）
  {
    name: 'butler-queue.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（档位变更覆盖；每次变更落审计）', sync: false,
    syncWhy: '三档放权（observe/report/notify）是「主人对本机的放权」，属单机档位状态 —— '
      + '与 butler-autonomy.json 同款判据：跨机共享会让另一台被本机的放行决定带跑（会自动注入会话）',
    loss: 'fail-safe：读不到/坏文件 = 回落默认 observe（最保守，零对外副作用），只会少叫醒不会多叫醒',
  },
  {
    name: 'butler-queue-notify.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每条待验收卡 1 条（离开 review 即清）+ 当日事件 50 条 + 已消费偏移', sync: false,
    syncWhy: '通知去重（已提醒过谁）+ 滞留升级计时 + 事件信箱偏移都是单机时间窗口状态，'
      + '跨机共享会让另一台漏叫醒或重复升级',
    loss: '重建（代价：已提醒过的卡可能重复注入一次；升级计时重新起算）',
  },
  // ── R-062「失败必须有一次送达」（2026-10-16 · 卡「V3机器锁3 · R062 失败送达」）────────────
  //   写方 = `tools\dsh-butler\job-failure-delivery-tick.mjs`（tickd job `failure-delivery` / 人工直跑）。
  //   判据唯一源 = `lib\job-failure-delivery.mjs`；日报「🚨 关键 job 失败送达」段**只读**它。
  {
    name: 'butler-failure-delivery.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每 job 1 条冷却位（alerts：最近一次送达的 eventKey + 时刻）+ 每 job 1 条快照位（snapshots）',
    sync: false,
    syncWhy: '冷却位是**单机时间窗口状态**（"本机这一条失败已经喊过人了"）—— 与 butler-watch-state.json 同款判据：'
      + '跨机共享会让另一台按**对端**的告警历史压制本机真告警（"对端刚喊过"不等于"本机看过了"）。'
      + '⚠️ 与 jobs 开关（butler-autonomy.json）同款：tickd 的 job 状态本就是每机各一份',
    loss: 'fail-safe：读不到 / 坏文件 = 回落空态（冷却位清空）⇒ 最坏只**重复送达一次**；**绝不会因此漏报**'
      + '（判据源是 tickd state.json，与本文件无关）',
    // ⚠️ **按需生成**（registry-audit S5「登记有必须落盘」的豁免位，判据同 `butler-upgrade-lock` 先例）：
    //   本文件只在**真送达**（`--emit` 且当时确有关键 job 失败）时才被创建
    //   ⇒ 「文件不存在」= **从未送达过** = 正常态（不是"登记成空头支票"）。
    //   反向锚：一旦送达过一次，它就会常驻（每 job 一条冷却位），此后 S5 靠"磁盘有"自然通过。
    onDemand: true,
    onDemandWhy: '冷却位只在**真送达**时按需创建（`--emit` 且有关键 job 失败）；'
      + '文件不存在 = 本机从未送达过 = 正常稳态（判据源 tickd state.json 与本文件无关，缺它绝不影响判定）',
  },
  {
    name: 'queue-events.jsonl', schemaVersion: 1, persistence: 'volatile',
    retention: 'append-only；消费端按 1000 行裁剪（只在全部已消费时）', sync: false,
    syncWhy: '看板结算事件流（含本机 sessionId / 结算时刻）= 单机时间窗口事实；'
      + '跨机同步会让另一台按对方机器的结算事件触发本机的叫醒判定',
    loss: '重建（代价：滞留计时改用「首次见到」而非结算时刻）',
  },
  // 卡 Q5（P3 叫醒目标绑定 · A 段，2026-09-14）：卡 ↔ 发起会话的绑定表
  {
    name: 'queue-bindings.json', schemaVersion: 1, persistence: 'persistent',
    retention: '卡级上限 500 条（超出按 boundAt 淘汰最旧）+ 主线 200 条 + 变更审计 50 条',
    sync: false,
    syncWhy: '绑定的是**本机会话 id**（只在本机有意义）+ 本机 run 事实 —— 跨机共享会让另一台拿着对端失效的 '
      + 'sessionId 去叫醒；C 段后账本 `requestedBy` 带着对端 sessionId 跨机过来时，本机必然查不到该会话，'
      + '判定侧只做降级、绝不按对端 id 投递（方案 §4：跨机永远走降级链，是设计而非缺陷）',
    loss: 'fail-safe：读不到/坏文件 = 无绑定 → 判定降级到「标题【运行】唯一」，再不行 escalate（宁可不发，绝不误发）',
  },
  // 看板主线清账判定（P0 · 卡 E1，2026-09-14）：判定台账 + 首跑基线 + 线级冷却 + 第三态
  {
    name: 'butler-board-cleanup.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每线 1 条（冷却 / 关闭 / 第三态 + 最近 3 代事件键）+ 事件 1000 条上限 '
      + '（先清超期 closed，再按 lastSeenAt 升序，stale 永不淘汰）+ 本轮计数',
    sync: false,
    syncWhy: '判定台账 = 「首跑基线 + 7 天线级冷却 + 已提示过谁」三件**单机时间窗口状态** —— '
      + '跨机共享会让另一台按对方的提示记录压制自己的提示（同 butler-queue-notify.json 款判据）；'
      + '且两台机各自判定各自提示是设计（方案 §3.5 跨机：单机判定 + 单机通知）',
    loss: '重建（代价：首跑基线重来一次 = 当前"在板全完成"的线会被静默登记一批；'
      + '已提示记录的冷却窗口重新起算 → 可能重复提示一次）',
  },
  // H2 接线（卡 P9·H2，2026-09-15）：跨机语义合并器的两个**运行键**（T1 幂等基线）。
  //   它们是「本机视角」状态：内容 = 本机独立观测基线 + 上次合并输出指纹 + 已应用的对端 commit。
  //   跨机覆盖会毁基线（另一台会把对方的观测当自己的），故 sync:false —— 且**不进仓1 采集白名单**。
  {
    name: 'butler-pitfalls-merge-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '最近 50 条 applied + 当前基线（每次 apply 覆盖写）', sync: false,
    syncWhy: '运行键 = **本机视角**：baseline 是"本机不含任何远端贡献的观测"，lastOutputFingerprint 是'
      + '"本机文件是否仍是上次合并输出"的判据 —— 跨机同步会让另一台拿对方的基线去重算，'
      + '立刻把 count 双计（正是 H2·B 修掉的病灶）。要冷备就按主机名前缀另存（照 butler-audit/ 先例）',
    loss: '基线丢失 → 下次合并退回"以当前文件为基线"；结果仍幂等（逐设备 max），'
      + '但若对端快照本身含本机贡献，护栏会告警提示人工确认（不会静默算错）',
  },
  {
    name: 'butler-memory-merge-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '最近 50 条 applied + 本机内容哈希集合基线（每次 apply 覆盖写）', sync: false,
    syncWhy: '同上：本机视角（内容哈希集合基线 + 上次输出指纹 + 已应用的对端 commit）。'
      + '记忆库**本体**随仓1 加密同步是设计，但运行键不随仓 —— 跨机覆盖会让另一台'
      + '误判"这份对端快照已合并过"而漏补自己的缺口（静默丢数据）',
    loss: '基线丢失 → 下次合并重算（集合插入语义天然幂等，代价只是多一次 I/O 与一次快照）',
  },
  // 卡「[盯卡巡检] 假结算 / 假 running 常驻巡检 + 主动通知」（2026-09-16）：巡检台账。
  //   tickd job `card-watchdog`（默认关）；**只巡检 + 通知，绝不自动改卡状态**。
  {
    name: 'butler-card-watchdog.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每张异常卡 1 条（异常消失即 cleanup）+ 当日事件 50 条 + 条目上限 500',
    sync: false,
    syncWhy: '台账 = 「首见时刻 + 已通知过谁 + 与 queue 去重标记」三件**单机时间窗口状态** —— '
      + '跨机共享会让另一台按对方的通知记录压制自己的提醒（同 butler-queue-notify.json 判据）；'
      + '而且卡状态与执行会话存活都是**本机事实**，两台机各自巡检、各自提醒是设计',
    loss: '重建（代价：在册异常重新计首见时刻；已提醒过的卡可能重复提醒一次）',
  },
  // 卡「[盯卡巡检]」配套：档位覆盖文件（不写时**跟随** butler-queue.json 的 mode）。
  {
    name: 'butler-card-watchdog-config.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '盯卡档位**覆盖**文件（不写 = 跟随 butler-queue.json 的档位；syncWhy 明写「独立于 queue 时才存在」）',
    retention: '单份（档位变更覆盖）', sync: false,
    syncWhy: '档位 = 「主人对本机的放权等级」（独立于 queue 时才存在）—— 与 butler-queue.json 同款判据：'
      + '跨机共享会让另一台被本机的放行决定带跑',
    loss: 'fail-safe：读不到 = 回落「跟随 queue 档位」（最保守路径），只会少叫醒不会多叫醒',
  },
  // ── 整夜兜底 → G1G2-C（2026-09-25 放行批 2b · 三项登记：C 新状态文件 + 两项既有欠账）──
  {
    name: 'butler-relay-handoff-warn.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '人工维护的豁免名单 + 告警配额（未配过即不存在；loss 记「重建」）',
    retention: '长期（人工维护，无自动过期）—— exempt 豁免名单 + 告警配额', sync: false,
    syncWhy: '豁免名单 + 告警配额 = 单机时间窗口 / 去重语义，跨机共享会让另一台按对方的豁免名单'
      + '压制自己的告警（同 butler-queue-notify.json 判据）',
    loss: '重建（代价：豁免名单失效 ⇒ 退化为「每轮重报」，可能误报）',
  },
  {
    name: 'butler-relay.json', schemaVersion: 1, persistence: 'persistent',
    retention: 'chains 段 .slice(-100) 自滚；pendingHandoff 30min TTL', sync: false,
    syncWhy: '接力台账（inFlight / pendingHandoff / dailyStarted / chains / scan）带「时间窗口 + 去重 / 锁」语义 ——'
      + '跨机共享会让另一台拿着对端的 in-flight 记录压制自己的接力锁与告警',
    loss: '重建（代价：新机首跑 chains 为空；C 判「无法判定」= 静默、零配额消费）',
  },
  {
    name: 'butler-relay.handed/', schemaVersion: null, persistence: 'persistent',
    retention: '每标记一文件；唯一删除者 = session-relay.mjs --selfcheck 的 consumeHandedMarks()（一跑全清）', sync: false,
    syncWhy: '交接标记 = 本机交接事实（sourceSessionId / markedAt / 标题），带时间窗口语义 ——'
      + '跨机同步会让另一台按对方的标记判定本机断链；C 的主判据依赖本机实况',
    loss: '重建（代价：C 的候选面归零 ⇒ 主判据失据）',
  },
  // 卡「Arrive-B 接线」（2026-09-17 · P9 H4）：接机后看板账本并回台账（tickd job `arrive-b`，默认关）。
  //   幂等签名 = 「本机已处理过哪份对端快照（快照名#账本 revision）」，是**单机视角**的运行键。
  {
    name: 'butler-arrive-b.json', schemaVersion: 1, persistence: 'persistent',
    retention: '最近 50 条幂等签名 + 最近 20 条告警 + 累计计数（每次运行覆盖写）',
    sync: false,
    syncWhy: '签名跨机共享会让另一台误判「这份对端快照已并回过」而漏并自己的缺口'
      + '（与 butler-memory-merge-state.json 同款判据）；且快照文件本身随仓3 走，两台机各读各的对端快照是设计',
    loss: '重建（代价：同一份对端快照可能再并一次；board-merge 自身保守幂等——只新增、状态只前进，无害）',
  },
  // ── 2026-09-17 施工卡 ②-1（② 准入表地基包）· 跨包登记增量（C-2：state-files.mjs 写权归 ②-1 独占）────
  //   本批 4 条登记的来源与归属：
  //     ① `upgrade-silence-state.json` —— **③ 跨线契约包**「① 包请求、② 包抓」的收信项（③ §2.4d/§13.2-1 +
  //        施工方案 §8.1-X1）：它此前**根本没进本表**（grep `silence` 零命中）。字段口径取 ③ §3.5(c) 的五项。
  //     ② `upgrade-automation.json`   —— **④ 升级链入家规包** §4.4-X4 交出由 ② 包裁定的项：**裁定 = 登记**
  //        （理由见该条 syncWhy/loss：它虽属"闸文件/配置"，但本表在册先例已有四例同类 ——
  //         `butler-autonomy.json`(:187) / `butler-autonomy-limits.json`(:84) / `butler-queue.json`(:286) /
  //         `butler-card-watchdog-config.json`(:361) 全是配置闸文件；"不登记"会让"哪些单机放权文件在册"缺一角）。
  //     ③④ `butler-shadow-baseline.json` / `butler-quota-ledger.jsonl` —— **⑥ 观测与额度包** §4.3/§8 的 2 条增量
  //        （⑥ §4.3 明写"新增 2 条登记"，由本卡一批落）。
  //   ⚠️ 四条一律 `sync: false` ⇒ `gitignoreBlock()` 会多 4 行 ⇒ 仓1 工作副本 `.gitignore` 必须重生成
  //      （`node sync-ignore.mjs`，见施工方案 §9 风险首行的跨仓派生链；推送由主人窗口执行）。
  {
    // ⚠️ schemaVersion 按 ③ 包 §3.5(c) 登记为 **2**（holders v2，兼容读 v1）——**实体当前仍是 v1**
    //   （现场 `phase:'enabled'` 的 09-11 记录）；升 v2 的实现在 ③-4 卡，登记先按目标口径落（登记 = 声明期望）。
    name: 'upgrade-silence-state.json', schemaVersion: 2, persistence: 'persistent',
    retention: '不清理（保留最近一次开窗/关窗的完整记录，供中断现场判读）',
    sync: false,
    syncWhy: '静默窗 = 停本机 tickd 的**单机互斥 + 进程/心跳时间窗口**状态（holders / tickdPid / actions 时间轴）——'
      + '跨机同步会造成"假静默"（另一台的窗口把本机 tickd 挡住），与 `upgrade-lock` 同款判据',
    loss: 'holders 丢失 ⇒ 静默窗"看起来关着" ⇒ 没人去恢复 tickd（③ 包 §3.5(c) 原话）：丢失后必须 `--ensure` 兜底',
  },
  {
    name: 'upgrade-automation.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（总闸 `enabled` + 巡检档位；每次改动覆盖）',
    sync: false,
    syncWhy: '它是「主人对**本机**升级链的放权决定」+ 含本机巡检档位（patrol.days）—— 与 `butler-autonomy.json` / '
      + '`butler-queue.json` 同款判据：跨机共享会让另一台被本机的放行决定带跑（本机未放行 = 关，不许被对端打开）',
    loss: 'fail-closed：读不到 = 总闸关（升级链不自动跑，④ 包 §2.3 口径）；只会更保守，不放开任何权限',
  },
  {
    name: 'butler-shadow-baseline.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每 kind 1 条最新预测集（按 kind 覆盖写；只读采集器每次重采）',
    sync: false,
    syncWhy: '预测基线 = **本机视角**（预测集来自本机会话/账本观测 + 本机 sha 指纹）—— 跨机共享会让另一台'
      + '拿对方的预测集做"实际 ⊂ 预测"对照判定（⑥ 包表 1：基线档是唯一权威源，必须本机）',
    loss: '重建（下一轮只读采集器重采）；代价 = 该 kind 的对照判定暂时记「未观测」（不判绿）',
  },
  {
    name: 'butler-quota-ledger.jsonl', schemaVersion: 1, persistence: 'persistent',
    retention: 'append-only；先按同族口径 90 天（⑥ 包 §11-D3 的沉底不删 / 90 天两案未拍，默认取 90 天）',
    sync: false,
    syncWhy: '降级台账记的是**本机**额度池的当日占用与降级时刻（单机时间窗口事实）—— 跨机共享会让'
      + '另一台按对端的降级/占用记录判自己的额度（同 `queue-events.jsonl` 款判据）',
    loss: '不可重建（历史降级事件丢失）⇒ 答不出"额度降级发生过几次"（这正是 ⑥ 包 I13 的一半）',
  },
  // ── 2026-09-18 施工卡 ⑤-6（⑤ 服务面隐私包 §3.9 承载表 + §3.8 第 5 条登记义务）──────────────
  //   本批 3 条 = ⑤ 包 §3.9 表的三条台账；**sync 标志逐条取自该表「跨机」列**（不是本卡自定）：
  //     · `secretary-push.jsonl`         §3.9「跨机 ❌（单机事实）」
  //     · `secretary-usage-<host>.jsonl` §3.9「跨机 ❌（host 分文件，照 external-sources-<host> 先例）」
  //     · `memory/retractions.jsonl`     §3.9「跨机 ✅ 随仓1（P1）」
  //   ⚠️ 两条 `sync:false` ⇒ `gitignoreBlock()` 多 2 行 ⇒ 仓1 工作副本 `.gitignore` 须重生成
  //      （`node sync-ignore.mjs`；**推送由主人窗口执行**——与 ②-1 那批同一处置）。
  //   ⚠️ `memory/retractions.jsonl` 由 `dsh-core:memory`（Copy-Tree 整目录）采集 + `dsh/memory/**`
  //      加密规则覆盖 ⇒ 采集清单侧补一条文件级映射声明（本卡已落，见 collect-manifest.json entries）。
  //   ⚠️ 三条台账的**实体均尚未落盘**（撤回链 S-5 / 台账件 S-9 在 ⑤ 包其它卡）⇒ 本批 = 前置登记
  //      （与 `butler-monitor-registry.json` / `butler-quota-ledger.jsonl` 同款先例：登记 = 声明期望）。
  {
    name: 'butler-service.json', schemaVersion: 1, persistence: 'persistent',
    retention: '覆盖式（服务面自有闸：总闸/单通道/预算/静默时段/对账历史；对账结论只留最近 14 天）',
    sync: false,
    syncWhy: '单机开关 + 单机对账历史（总纲 §4「服务面自有闸」D5：独立闸 · 吃 L0 · **不落生态四键**）——'
      + '跨机共享会让对端开关状态与本机台账对不上（"闸说开、台账零行"= 判据自相矛盾，同 §3.9「单机事实」款）',
    loss: '推送总闸回缺省（**缺省 = 默认关**，方案 §1.7 第 4 项）⇒ 服务面推送停摆（重开推送总闸可重建）；'
      + '对账历史丢失 ⇒ 连续不齐天数从 0 重新累计（判定不丢，只是回数断档）',
  },
  {
    name: 'secretary-push.jsonl', schemaVersion: 1, persistence: 'persistent',
    retention: 'append-only（每次推送一行，不自动清理）',
    sync: false,
    syncWhy: '单机投递事实（⑤ 包 §3.9「跨机 ❌」）：含 touser / errcode / msgid 与「连续失败计数」判据 —— '
      + '跨机共享会让两台互相压制推送告警（同 `queue-events.jsonl` 款判据）',
    loss: 'R6.1b「真送达」判据失去唯一载体（stdout 不算证据）⇒ 答不出"推了但主人没收到"；下次推送起重新积累',
  },
  {
    name: 'secretary-usage-<host>.jsonl', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: 'append-only 用量台账：**有真推送才有行** ⇒ 零推送不落文件（本机 2026-10-10 实测缺位）',
    retention: 'append-only（按人累计，不自动清理）',
    sync: false,
    syncWhy: '文件名带主机短码（⑤ 包 §3.9「跨机 ❌（host 分文件，照 external-sources-<host> 先例）」）：'
      + '记的是本机家人用量，跨机共享会让额度数不是任何一台的真实值',
    loss: '家人用量 / 被拒统计需重新积累；日报「家人用量」段归零（⑥ 包额度池分摊的口径输入缺失）',
  },
  {
    name: 'memory/retractions.jsonl', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '撤回台账 append-only：**发生过撤回**才有行 ⇒ 无撤回不落文件（⑤包 §3.9：跨机 ✅ 随仓1）；'
      + '【2026-11-05 · 卡「记忆引擎4期B+」】第 4 期起**插件 `memory_forget` 也写这一份**'
      + '（真写手 = `dsh-memory/lib/forget-ledger.mjs`，raw 单行 append，不复用 `appendRetraction`）——'
      + '与 CLI 同一个文件、同一份 `hash|owner` 去重键；**正文不进台账**（隐私最小化），'
      + '正文落在 `_archive\\memory-removed\\plugin\\`（见本表 EXTERNAL_STATE 的目录级条目）',
    retention: '永久（append-only，一行一条）；丢了 = 撤回失效 + 记忆还魂',
    sync: true,
    syncWhy: '撤回必须跨机传播（⑤ 包 §3.9「跨机 ✅ 随仓1」）：对端接机时由既有 A5b 合并窗口应用 —— '
      + '只留本机等于对端永不生效（对第三方的隐私承诺物理落空）',
    loss: '撤回链断裂：已删的家人投喂会在对端还魂，且主人看不见（⑤ 包 §3.7 的 retractions 检查项无输入）',
  },
  // ── 2026-09-20 施工卡 G23-2（PM3 · L-1 落库侧）新增三条 ────────────────────────
  //   判据源：⑤ 包 §3.2-2 / §3.9 第 5 条「新台账必须登记 `state-files.mjs`」。
  //   三条**均为单机事实**（投喂随宿主：落在当前跑 DSH 的那台机上，跨机共享会让"谁的投喂"失去唯一性）
  //   ⇒ `sync: false`（照 §3.9 表「跨机 ❌（单机事实）」款）⇒ `gitignoreBlock()` 多 3 行，
  //   仓1 工作副本 `.gitignore` 须重生成（`node sync-ignore.mjs`；**推送由主人窗口执行**）。
  //   ⚠️ 实体尚未落到 本机 生产（闸 `switches.feed` 默认关）⇒ 本批 = **前置登记**（登记 = 声明期望）。
  {
    name: 'memory/feed.db', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '投喂库：闸 `switches.feed` **默认关** ⇒ 本机实体未落；该条目上方注释明写本批 = **前置登记**（登记 = 声明期望）',
    retention: '长期（投喂条 append-only 语义；**不自动清理**，保留期规则见 §11.3-S2 待拍项）',
    sync: false,
    syncWhy: '投喂库含**投喂正文 + `owner_user` + `visibility`**，且「投喂随宿主」（方案 §4-PM3.1 2026-09-20 订正）'
      + '—— 落库机就是唯一权威；跨机共享会让"这条是谁的"在两端对不上（隐私包 §3.3 的过滤与撤回同时失效，判据 4）',
    loss: '投喂内容与归属丢失（**不可重建**：源文件与外部通道消息都已过期）；对账失去条面 ⇒ 只能靠实体面报孤儿',
  },
  {
    name: 'secretary-feed-audit.jsonl', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '投喂落库审计（同 feed 闸默认关 ⇒ 无落库则无留痕；与 memory/feed.db 同批前置登记）',
    retention: 'append-only（每次落库/批准/退回一行，不自动清理）；带自制哈希链（prev/hash）',
    sync: false,
    syncWhy: '单机落库留痕（含 owner_user / sha256 / 设备名）；**宿主无大管家链时的降级落点** —— '
      + '有链的机器进 `butler-audit`（append-only 哈希链，跨机不合并，照 `Copy-AuditDir` 先例），'
      + '故本台账一律单机，跨机合并会断链',
    loss: '答不出"谁在什么时候落了什么"（落库条的审计腿断裂）；已落投喂条本身不受影响',
  },
  {
    name: 'secretary-feed-reconcile.json', schemaVersion: 1, persistence: 'persistent',
    retention: '覆盖式（只留最近一次对账快照：verdict + counts + issues ≤50 条 + notes）',
    sync: false,
    syncWhy: '单机对账结论（本机条/实体/记忆条三面引用完整性）—— 跨机共享会让另一台按对端的问题清单判自己（同 `queue-events.jsonl` 款）',
    loss: '最近一次对账快照丢失（判定可随时重跑重算，只是回看断档）；**不静默**：重跑 `reconcile` 即重建',
  },
  // ── 2026-09-21 施工卡 G24 / 记忆引擎 v2 · S2c（运行化基础件）新增两条 ─────────────
  //   判据源：方案 §4「登记义务」（**每一个**新建 state 文件都要登记，否则 `sync-ignore.mjs --check` 会红）
  //   + §3.1「该目录不纳入任何同步 / 采集」（向量库是**可重建派生物**，不进仓1 是机制收益）。
  //   ⚠️ 两条 `sync: false` ⇒ `gitignoreBlock()` 多两行 ⇒ 仓1 工作副本 `.gitignore` 必须重生成
  //      （`node sync-ignore.mjs`；推送由主人窗口执行）。
  {
    name: 'butler-memory-vectors-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每轮覆盖写）+ 最近 20 轮 history 摘要',
    sync: false,
    syncWhy: '记的是**本机**向量同步进度与桥台账（`memoryDb`/`vectorsDb` 绝对路径 + 桥端口/pid + `lastSweep` 周号）'
      + '—— 一期宿主 = 对端机 单机自持，跨机共享会让另一台按对端的进度判自己（同 `butler-memory-snapshot.json` 款）',
    loss: '丢失 = 下轮当首次运行：向量库仍在（`text_hash` 幂等）⇒ 最多一次水位重扫 + 重复一次当周兜底轮转',
  },
  // ── 2026-10-11（卡「跨机记忆库每小时自动同步」）新增一条 ─────────────────────────────
  //   判据源：本节开头「**每一个**新建 state 文件都要登记，否则 `sync-ignore.mjs --check` 会红」。
  //   ⚠️ `sync: false`：记的是**本机那一半**的同步进度（角色/lastVia/lastPeer/lastPeerCommit/近 48 轮历史），
  //      跨机共享会让另一台拿对端进度判自己（同 `butler-memory-vectors-state.json` 款）。
  {
    name: 'butler-mem-sync-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每轮覆盖写）+ 最近 48 轮 history 摘要（只记条数/id，**不记正文**）',
    sync: false,
    syncWhy: '记的是**本机**跨机记忆同步的进度与结果（role / lastVia / lastPeer / lastPeerCommit / lastApplied / lastVectors）'
      + '—— 两台机各自跑一半、各自记账，跨机共享会让另一台按对端的进度判自己（同 `butler-memory-vectors-state.json` 款）',
    loss: '丢失 = 下轮当首次运行：合并本身幂等（`merge-memory` 的运行键在 `butler-memory-merge-state.json` 里，不在本文件）'
      + '⇒ 最多丢一段历史摘要，不影响正确性',
  },
  // ── 2026-10-30（卡「记忆两岸互通 S2」）：运行键补登记 ─────────────────────────────────
  //   来由（现跑读数）：`butler-registry-audit.mjs --no-ledger` 在本卡改完 JOBS 后报
  //     `S4 磁盘有必须登记：~/.dsh/butler-memory-life-import.json` —— 该文件是 S1 导入器写的，
  //     当时**漏登记**；本卡把 `memory-sync-life` 接进 tickd 后它就是**每轮必写**的运行键
  //     ⇒ 不登记 = 跨机判定/schemaVersion 迁移/丢失后果全无依据。
  //   ⚠️ `sync: false`：记的是**本机**导入进度（`lastLifeMaxId` + `rounds` 20 轮），
  //      跨机共享会让另一台按对端进度判自己（同 `butler-mem-sync-state.json` 款）。
  {
    name: 'butler-memory-life-import.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每轮覆盖写）+ `rounds` 尾部 20 轮摘要（只记条数/rc，**不记正文**）',
    sync: false,
    syncWhy: '记的是**本机**从「岸」增量导入的进度（`lastLifeMaxId` / `inserted` / `rounds`）'
      + '—— 每台机各自的岸侧水位不同，跨机共享会让另一台按对端水位判自己（同 `butler-mem-sync-state.json` 款）',
    loss: '丢失 = 下轮当首次运行：去重键是**内容 sha256 + `srcid:`**（都在目标库行标签里，不在本文件）'
      + '⇒ 最多重算一遍 skipped 计数，不会重复导入、不会删任何行',
  },
  // ── 2026-10-26 · 卡「人格统一 A32 · 状态文件补登记」新增两条 ─────────────────────────
  //   来源：A29 报告 §未查证 2/3 + §待拍板 A29-1 —— 两个**非 `ops-` 前缀**的状态文件一直没人管
  //   （`sync-ignore --check` 的「新名覆盖自检」只扫 `NEW_PREFIX`=`ops-`，它们天生逃过自检 ⇒
  //   **登记表才是唯一真源**，别指望自检兜底）。
  //   判据源 = 本节开头「**每一个**新建 state 文件都要登记」+ `sync-ignore.mjs` 文件头 L1-7
  //   「带时间窗口 / 冷却 / 去重 / 锁 → 禁止同步；带设备短码 / 按会话 / 按设备 → 可同步」。
  //   ⚠️ 第一条 `sync: false` ⇒ `gitignoreBlock()` 多 1 行 ⇒ 仓1 工作副本 `.gitignore`
  //      （`node sync-ignore.mjs`）与 `.ps1` 的 `$ignore` 段（`patch-backup-ignore.mjs`）
  //      **两处都必须重生成** —— 只改一处 = 排除只生效一半。
  //   ⚠️ 第二条 `sync: true` ⇒ 不进排除段（`gitignoreNames()` 对它出 0 条），但登记表与采集清单之间
  //      会多一处「登记说同步、实际没采」⇒ 已同步记进 `collect-manifest.json#knownGaps`
  //      （本卡禁改 `dsh-backup-sync.ps1#$DshFiles`；真要开采集 = 一行加白名单 + 一条 entries）。
  {
    name: 'net-arbiter-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（net-arbiter 每轮覆盖写；`tunnelWantStreak` / `tunnelIdleStreak` 是跨轮迟滞计数器）',
    sync: false,
    syncWhy: '记的是**本机网络判决**（class / desired / observed / tunnelWantStreak 迟滞计数 / tunnelDecide）'
      + '—— `observed.lan.*` 是本机视角的探测结果、`observed.queue.lastCommitAt` 是时间窗口 ⇒ '
      + '跨机共享会让另一台按 本机 的网络状态判自己（同 `butler-mem-sync-state.json` 款）',
    loss: '丢失 = 下轮当首次判（`tunnelWantStreak` / `tunnelIdleStreak` 归零 ⇒ 迟滞重新累计 2 轮 ≈ 30 分钟）'
      + '⇒ 期间不误开也不误关，只是收缩/开启的判决慢半拍',
  },
  {
    name: 'butler-mem-sync-alert.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（开关翻转时覆盖写：`{enabled, reason, by, at}`，不留历史）',
    sync: true,
    syncWhy: '纯开关（`enabled` + 说明字段 reason/by/at），**无冷却 / 时间窗口 / 去重 / 锁** ⇒ '
      + '按判据允许同步；三台开关一致反而是好事（不必各配一份），且它只解释「要不要往告警日志追一行」',
    loss: '丢失 = 回到默认关（`readDeferredAlertSwitch()` 读不到文件即 `enabled:false`）'
      + '⇒ 只是少了「连续 deferred」的告警行，不影响同步本身',
  },
  // ── 2026-10-27 · 卡「V3功能面·registry续登」新增七条（N0-b 之后的真缺口）──────────────
  //   来源：`butler-registry-audit.mjs --json --no-ledger` 现跑 = `state-file 127 条 / failed 7`（rc=1），
  //     七个文件全部是 S4「磁盘有必须登记」命中；写者与形状逐条现跑核过（01:1x 主会话 + 本卡复核）。
  //   判据源 = 本节开头「**每一个**新建 state 文件都要登记」+ S4 自己的处置文案（默认补登、不塞 allowlist）。
  //   字段口径：jsonl 流式件**无 `schemaVersion` 字段** ⇒ 按 `butler-bind-reconcile.log` /
  //     `butler-registry-audit-runs.jsonl` 先例登记 `null`（不虚报不存在的字段）。
  //   ⚠️ 七条全 `sync: false` ⇒ `gitignoreBlock()` 新增 8 行（`butler-drain-freeze.json` 走 2c 双名 = 旧名 + `ops-` 名）
  //      ⇒ 仓1 工作副本 `.gitignore`（`node sync-ignore.mjs`）与 `dsh-backup-sync.ps1` 的 `$ignore` 段
  //      （`node patch-backup-ignore.mjs`）**本轮按卡面红线未动**（只许改本文件）⇒ 属"派生链待重生成"，
  //      已记进交付报告「待拍板 / 后续一件」；在那之前 `sync-ignore.mjs --check` 会报排除段不一致（预期，不是回归）。
  {
    // ① 排水冻结记账
    name: 'butler-drain-freeze.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（每轮冻结覆盖写：{batchId, sent:{sid→iso}, updatedAt}）',
    sync: false,
    syncWhy: '记的是**本机**这一轮排水冻结「已经通知过谁」—— 会话 id 与时间戳都是本机视角；'
      + '跨机共享会让另一台按 本机 的批次判自己（同 net-arbiter-state.json 款）',
    loss: 'fail-soft：丢失 ⇒ 下一轮当「谁都没通知过」，会重复发一遍冻结通知（幂等文案，无害）；'
      + '不丢冻结状态本身（状态在会话侧）',
  },
  {
    // ② 记忆分类跑批清单
    name: 'memory-classify-runs.jsonl', schemaVersion: null, persistence: 'append',
    retention: 'append-only（每跑一轮一行：runAt/tool/card/rows/dbCount/byRule…）',
    sync: false,
    syncWhy: '**本机跑批的台账**（哪轮跑了多少行）；跨机同步会把对端跑批混进本机账。'
      + '⚠️ 记忆面（记忆库/分类/检索词）的**跨机同步口径归「人格统一线」**，本行只按大管家线登记本机',
    loss: '丢历史跑清单 ⇒ 无法追溯某轮跑过多少、before/after 对不上；重跑可重建，不影响分类产物本身',
  },
  {
    // ③ 记忆分类标签（旁挂全集）
    name: 'memory-classify.jsonl', schemaVersion: null, persistence: 'persistent',
    retention: '单份（全量旁挂：一行一记忆 {id,cls,conf,reason,by,at,srcHash}；重跑整份覆盖）',
    sync: false,
    syncWhy: '本机 `memory.db` 的旁挂产物（`srcHash` 绑定本机记忆内容）；跨机同步会与对端库的 id/srcHash 错配。'
      + '记忆面跨机口径归人格统一线，本行只登记本机',
    loss: '丢标签 ⇒ 需重跑 `classify-memories.mjs`（规则/LLM 成本 + 时间）；记忆本体不受影响（旁挂、不写库）',
  },
  {
    // ④ 检索词（旁挂 · 当前零消费者）
    name: 'memory-recall-terms.jsonl', schemaVersion: null, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '**旁挂件、生产链零消费者**（器具仍在 `_tmp\\recall-terms-l1-20261026\\` 未转正；'
      + '卡「召回-检索词1」的产物）⇒ 接线后才变常驻产物；照 `butler-maintenance.json` 同款登记为按需',
    retention: '单份（一行一记忆 {id,terms[]}；重新生成整份覆盖）',
    sync: false,
    syncWhy: '同上：绑定本机记忆 id 的旁挂产物，跨机同步会 id/内容错配',
    loss: '丢检索词 ⇒ 要重新生成（花 LLM 调用；实测 308 行 / 128,510 B 量级）；当前无消费者 ⇒ 眼下零影响',
  },
  {
    // ⑤ 双写失败审计
    name: 'ops-state-write-audit.jsonl', schemaVersion: null, persistence: 'append',
    retention: 'append-only（**只在双写失败时**追加一行，正常写不落 —— 防流水爆炸）',
    sync: false,
    syncWhy: '本机写入面的失败审计（`dualWritePartial` 等）；跨机共享会把对端写失败混进本机账',
    loss: '丢失败审计 ⇒ 无法追溯哪次双写没成功（**不影响主数据**，主写另有兜底与回滚）',
    // ⚠️ 注意：同一文件也被 lib\state-exceptions.mjs#INFRA_NAMES 收录（用途 = inferMode 排除迁移基础设施）
    //    ⇒ 两处口径各写明用途，**别当成重复登记**、别删任何一处。
  },
  {
    // ⑥ preset 推送状态
    name: 'preset-push-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（按 peer 记最近一次推送：stamp/at/alias/peerHome + files[].personas[] 的 before/after sha）',
    sync: false,
    syncWhy: '**强烈不该同步** —— 它记的是「本机 → 各 peer」的推送戳与 sha；'
      + '同步会让两台互相覆盖「对端视角」的记录（同 butler-restart-state.json 的时间窗口款）',
    loss: '丢推送状态 ⇒ 下次 `gen-presets --push` 重推（幂等、无害），只是判不出「上次推到哪个 sha」',
  },
  {
    // ⑦ 外部通道告警本地队列
    name: 'channel-alert-queue.jsonl', schemaVersion: null, persistence: 'append',
    retention: 'append-only（hub 不可达 / 渠道失败时把告警落本地队列，**绝不静默吞**；人工确认后才清）',
    sync: false,
    syncWhy: '告警是**本机发出**的动作（hub-unreachable / 渠道失败）；跨机同步会让两台互发同一批告警，重复打扰主人',
    loss: '⚠️ **真损失**：丢掉 = 那条告警永远没人知道（设计意图就是「发不出去也要留痕」）'
      + '⇒ 全 7 项里丢失后果最重的一条',
  },
  {
    name: 'memory-vectors/', schemaVersion: null, persistence: 'persistent',
    retention: '向量库可随时删库重建；`bridge-port.json` 每次探活覆盖；`bridge.log` 上限 2 MB 自截断',
    sync: false,
    syncWhy: '方案 §3.1 明写「该目录不纳入任何同步 / 采集」：`vectors.db` 与 `doc-index.db` 都是**可重建派生'
      + '物**，`bridge-port.json` / `bridge.log` 带**本机 pid 与端口** ⇒ 跨机同步既无意义又会串味',
    loss: '向量库丢失 = 重编码（`cli/sync.mjs --full`）；端口台账丢失 = 下一轮 `serve-start` 重新探活重建',
  },
  // ── 2026-10-26 · 卡「家庭保姆 · 记忆隔离 F7」新增两条（B 案 DB-per-tenant · 落点路 A）────────
  //   拍定真源：主人 2026-10-26 01:33 —— 家人库生产根只落 对端机 = `<home>\family-memory\`（路 A）；
  //     方案 §3c-2 第 1 条（一律不进镜像 / 备份仓）+ 第 5 条（I-7 登记进本表；顺序 = 先登记后重生成）。
  //   ⚠️ 两条 `sync: false` ⇒ `gitignoreBlock()` 多 4 行（每条经 `gitignoreNames()` 出一条：本名不含 butler- 前缀 ⇒ 原样）
  //      ⇒ 仓1 工作副本 `.gitignore`（`node sync-ignore.mjs`）与 `.ps1` 的 `$ignore` 段（`patch-backup-ignore.mjs`）
  //      **两处都必须重生成** —— 只改一处 = 排除只生效一半。
  //   ⚠️ 目录型（name 以 `/` 结尾）与通配型（含 `*`）**都不在 S5「登记有必须落盘」断言内**
  //      （registry-audit 0.3.4 口径：S5 只断言无通配的**文件项**）⇒ 生产根只在 对端机 时本机零实体 = 设计态，无需 onDemand。
  {
    name: 'family-memory/', schemaVersion: null, persistence: 'persistent',
    retention: '长期（家人库 append-only 语义，不自动清理）；每日 `VACUUM INTO` 到 `<workspace>\\_archive\\family-memory-backups\\<YYYYMMDD>\\`，留最近 30 份（拍定第 7 条；不推跨机仓、不落 `.dsh` 内）',
    sync: false,
    syncWhy: '🔴 家人库一律不进主人的镜像 / 备份仓（方案 §3c-2 第 1 条）：里面是**别人的**记忆 —— '
      + '跨机同步既破隐私口径，也会让"这条是谁的"在两端对不上；**排除 ≠ 不备份**（独立备份见 retention 那条链）',
    loss: '家人记忆**不可重建**（源是家人与主人的对话 / 投喂，无第二份）⇒ 只能靠它自己的每日备份恢复',
  },
  {
    name: 'family-memory/memory-family-*.db*', schemaVersion: 1, persistence: 'persistent',
    retention: '每日 `VACUUM INTO` 留 30 份；删某人 = **删库**（先 VACUUM INTO 留 7 天），删完该人残留必须 0 个文件（拍定第 10 条）',
    sync: false,
    syncWhy: '目录级条目的**精确点名**：`memory-family-<sha16>.db` + 伴生 `-journal`（本插件 `PRAGMA journal_mode = DELETE`，'
      + '**不是** `-wal` / `-shm`）—— 通配 `*.db*` 连将来若有人改回 WAL 的 `-wal` / `-shm` 一并覆盖；永不进仓1 / 永不进 `merge-memory`（不变量 B）',
    loss: '家人记忆**不可重建**（同目录级条目）；`-journal` 丢失 = 未提交事务回滚（库停在上一检查点）',
  },
  // ── 2026-10-10 · 冲刺600 补坑库联动A（A 点：坑库第二向量来源）新增一条 ────────────────
  //   判据源：坑库联动方案的 §A.4（出处不在本包内）「新增登记：若引入标记文件
  //   `butler-pitfall-vector-dirty.json`，必须登记进 `lib\state-files.mjs`（否则 `sync-ignore --check` 会红）」
  //   + 同节 C5：该文件是全方案**唯一"有意双写者"**（置标记 = pitfall job；清标记 = 消费方）
  //     ⇒ 语义 = 时间窗口/一次性信号（跨机共享会让另一台按对端的待办判自己）⇒ `sync: false`。
  {
    name: 'butler-pitfall-vector-dirty.json', schemaVersion: 1, persistence: 'persistent',
    // 【2026-10-14 · 卡「收尾·V2 状态登记闭合」】补 `onDemand` 位（**原位漏标修正**，不是新登记）——
    //   本条目 retention 自陈「正常态 = 文件不存在（标记被消费后摘除）」= 瞬态的教科书定义，
    //   但当时没标 `onDemand` ⇒ 标记一被消费，S5「登记有必须落盘」就报一条红：
    //     实测 = 2026-10-13 / 10-14 两份日报出现过、而 **2026-10-14T01:12Z 那份日报里没有它**
    //     （那时刻标记恰在盘上）⇒ **时有时无**，正是"瞬态件漏标 onDemand"的指纹。
    //   处置依据 = ① S5 自己的报错文案第 ① 支（「确属按需 ⇒ 该条目补 onDemand: true + onDemandWhy」）
    //     ② 主档 §1 A 域该行原话「与『随用随删、漏标 onDemand』一致（未修，属生产改动）」——本卡就是来干这把生产改动的。
    //   ⚠️ 只加豁免位，**不动 `sync`** ⇒ `gitignoreBlock()` 一行都不变（无派生链影响，不需重跑生成器）。
    onDemand: true,
    onDemandWhy: '**一次性信号**：`pitfall job` 置标记 → 消费方清标记（见本条目 retention 原文「正常态 = 文件不存在」）'
      + '⇒ 无待办可跑时本就不该存在，属"按需生成、稳态不存在是正常"的典型',
    retention: '单份（覆盖写）；正常态 = 文件不存在（标记被消费后摘除）或 `updatedAt` 早于上次消费起点',
    sync: false,
    syncWhy: '一次性信号（"坑库变了、待向量同步"）带 `updatedAt` 与设备名 —— 跨机共享会让另一台按对端的待办'
      + '跑一次与自己无关的坑源编码（同 `butler-memory-vectors-state.json` 款）；且它由**两台机各自的 pitfall job** 生成',
    loss: '丢失 = 本机坑源增量同步少跑一轮（**不静默**：`cli/sync.mjs --source pitfall` 可手动补，'
      + '`sweep --source pitfall` 兜底也会按 `text_hash` 补齐）⇒ 无数据损失',
  },
  // ── 2026-09-21 施工卡 G24 / 记忆引擎 v2 · S3a（文档索引独立库）新增一条 ─────────────
  //   判据源：方案 §4「登记义务」（**每一个**新建 state 文件都要登记，否则 `sync-ignore.mjs --check` 会红）
  //   + §3.2「索引条描述**本机** docs 的 mtime，两机 mtime 不同 ⇒ 跨机双写会互相覆盖」。
  {
    name: 'butler-doc-index-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每轮覆盖写）+ 最近 20 轮 history 摘要 + per-path 台账（mtime/size/lastResult/failCount）',
    sync: false,
    syncWhy: '记的是**本机** docs 的 mtime/size 与索引进度（含 `docsRoot` / `dbPath` 绝对路径）—— 索引条描述本机文档的 mtime，'
      + '一期宿主 = 对端机 单机自持，跨机共享会让另一台按对端的进度判自己（同 `butler-memory-vectors-state.json` 款）',
    loss: '丢失 = 下轮当首次运行：库仍在、且按 `path` 主键幂等覆盖（每篇最多重算一次摘要），无数据损失',
  },
  // ── 2026-09-21 施工卡 G24 / 记忆引擎 v2 · S3c（夜间提炼）新增一条 ────────────────
  //   判据源：方案 §4 载体清单（`~/.dsh/butler-distill-state.json`，跨机列 = ❌ 各机独立）
  //   + §4「登记义务」（**每一个**新建 state 文件都要登记，否则 `sync-ignore.mjs --check` 会红，见 I6）
  //   + §3.5 状态与锁（Z15：原子写 + schemaVersion；登记进 `lib/butler-locks.mjs` 含 skipPolicy）。
  {
    name: 'butler-distill-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每轮覆盖写）+ 最近 20 轮 history 摘要 + `processed` 台账（上限 2000 条，超出按时间淘汰）',
    sync: false,
    syncWhy: '记的是**本机**提炼进度与**当日成本记账**（调用次数 / token / 结果 + `memoryDb` 绝对路径）——'
      + '成本闸是"每日"口径，跨机共享会让另一台拿对端的当日用量判自己（同 `butler-memory-vectors-state.json` 款）；'
      + '且去重的**权威源是库里的 `src=` 标签**（本 state 只是快查缓存）⇒ 不需要也不应该跨机',
    loss: '丢失 = 下轮当首次运行：① 去重仍由库里的 `src=` 标签兜住（**不会重复提炼、不会重复计费**）'
      + '② 当日成本计数归零（最坏 = 当天可能多花一次额度上限内的调用）⇒ 代价可接受，故 `persistent` 而非 `permanent`',
  },
  // ── 2026-10-10 · 冲刺600 补坑库联动BCD（B 点：落地判据向量化）新增一条 ──────────────────
  //   判据源：坑库联动方案的 §B.2 第 5 行（出处不在本包内） + §B.4「新状态文件
  //   `butler-p4-triage.json`（须登记 `state-files.mjs`）」+ §B.6 风险表（"判定文件被当权威" ⇒ 文件内写死 advisoryOnly）
  //   ⚠️ 与 D 点**同文件**（§D.1 落点：分 `advisory` / `llm` 两段）⇒ 只登记一次。
  {
    name: 'butler-p4-triage.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: 'P4 分诊产物：由 `pitfall-triage-tick.mjs` **按 tick 生成**（未跑则该文件不存在；loss 记「重算」）',
    retention: '单份（覆盖写，原子写）；`advisory[]` = 候选池逐条判定，`llm[]` = D 点的建议段（默认关时不写）',
    sync: false,
    syncWhy: '内容 = 候选在当前**本机 policy 库**（persona/技能段向量）上的相似度分数与 top-1 出处 —— 方案 §B.2-5 明写'
      + '「含本机 policy 库的相似度分数，跨机无意义」；且 policy 库本身不同步（D5 已拍 = 不跨机传 persona/技能文本）'
      + '⇒ 跨机合并会出现"同一候选在两台机上判定不同"的自相矛盾',
    loss: '丢失 = 重算（`node tools\\dsh-butler\\pitfall-triage-tick.mjs`）；候选池**未被本文件写入**（只读）'
      + '⇒ 无数据损失，故 `persistent` 而非 `permanent`',
  },
  // ── 2026-10-10 · 冲刺600 补坑库联动BCD（C 点：坑聚类升级）新增一条 ─────────────────────
  //   判据源：方案 §C.2 第 5 行 + §C.4「新增状态文件的登记义务同上」+ §C.6（跨机各建各的 ⇒ 判据不一致）
  {
    name: 'butler-p4-clusters.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（覆盖写，原子写）；`clusters[]` = 族（memberIds/representativeId/theme/size/totalCount）',
    sync: false,
    syncWhy: '方案 §C.2-5 明写 syncWhy「聚类结果依赖**本机**向量库（向量库不同步），跨机合并会自相矛盾」；'
      + '且聚类只做**收敛展示**（不改任何坑的 count/excluded/候选 status）⇒ 各机自用即可',
    loss: '丢失 = 重算（`node tools\\dsh-butler\\pitfall-cluster-tick.mjs`）；无向量库时脚本优雅降级为恒等聚类'
      + '⇒ 无数据损失，故 `persistent` 而非 `permanent`',
  },
  // ── 2026-10-10 · 冲刺600 补坑库联动BCD（D 点：提炼 job 消化 P4 新增坑）新增一条 ────────────
  //   判据源：方案 §D.2-5「登记 `butler-distill-state.json` + `butler-p4-triage.json`」+ §D.4 成本闸（≤20 次/日、≤150K token/日）
  //   ⚠️ 本文件 = **D 点的一键关回开关 + 当日成本账**（两层里"默认关"的唯一权威层是它）
  {
    name: 'butler-p4-digest.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: 'D 点提炼的**开关 + 当日成本账 + 日报落点**：`enabled` **默认关** ⇒ 关着不写（loss 记「判关并重启当日成本计数」）；`digest` 段 = D-7 的「job 写 state ⇒ 日报渲染一行」落点（2026-10-19 V3 地基 P4 收口）',
    retention: '单份（覆盖写，原子写）；字段 = `enabled`（默认关）+ `why` + `cost{day,calls,tokens}`（当日口径）+ `digest{schemaVersion,asOf,count,added,source,status}`（最近一轮消化；日报只读此段）',
    sync: false,
    syncWhy: '① `enabled` 是**本机自治动作开关**（跨机共享会让另一台被对端放行）；'
      + '② `cost` 是"每日"口径的调用/token 记账 —— 跨机共享会让另一台拿对端的当日用量判自己'
      + '（同 `butler-distill-state.json` 款判据）',
    loss: '丢失 = 判关并重启当日成本计数（fail-safe 方向：**宁可不动**）⇒ 不会误花钱；'
      + '重新放行 = 重写 `enabled:true` 一行 ⇒ 代价可接受，故 `persistent` 而非 `permanent`',
  },
  // ── 2026-09-24 · 文档纪律落地②（卡「判据载体接线」· 家规第 10 条）新增一条 ────────────────
  //   判据源：家规《审核与回修文档纪律》第 10 条（紧急豁免通道 → 台账 `~/.dsh/butler-doc-discipline.json`）
  //   + 真源方案 §4 第 ④ 步（台账 `sync:true` **四步链路** = 本表登记 → collect-manifest.json 加条目
  //     → dsh-backup-sync.ps1 的 `$DshFiles` 加文件 → collect-check.mjs 对账 0 差异）；
  //     四步**缺一** = 换机后不可见（登记说同步、实际没采的假象，轴① 会报 state-sync-true-not-collected）。
  //   ⚠️ 台账为**明文**（不含任何凭据）：记录 = 主人明令的「at / by / reason / affectedDocs[] /
  //     recallCardId / recallDueBy / roundNo」七字段；本卡只建骨架 `{"schemaVersion":1,"records":[]}`，
  //     **未登记任何记录**（家规第 10 条：判定人 = 主人，登记须主人明令 ⇒ 空态照报警、不静默、不自填）。
  {
    name: 'butler-doc-discipline.json', schemaVersion: 1, persistence: 'persistent',
    retention: '永久（append-only：一条 = 一次主人明令的紧急豁免登记）',
    sync: true,
    syncWhy: '豁免台账是**跨机共享语义**：家规第 10 条要求换机后「哪一轮豁免过、7 天内要补审」的账仍然可见；'
      + '双机各自独立记会让对端的豁免记录与本机凭据凭空消失（同 butler-pitfalls.json 款判据：跨机共享语义）',
    loss: '丢失 = 已登记的豁免与「7 天内补审」到期账消失（**不可重建**：主人当时的口头明令没有第二处载体）'
      + '⇒ 到期告警无处可算、补审可能被静默漏掉',
  },
  // ── 2026-10-10 · 卡「冲刺600·补台账」（J 域 A-2「运行台账」）新增一条 ──────────────
  //   判据源：缺口台账 §2 第 31 行 + §7 第 ② 条（出处不在本包内）
  //   （缺口 = 文件不存在 / 无写入实现 / 未登记 state-files）。写口 = `lib/registry-audit-runs.mjs`
  //   （**单点**，判定源 `lib/registry-audit.mjs` 仍纯只读），调用点 = CLI 每次真跑（`--no-ledger` 可跳过）。
  //   ⚠️ `sync: false` ⇒ `gitignoreBlock()` 多一行 ⇒ 仓1 工作副本 `.gitignore` 与
  //      `dsh-backup-sync.ps1` 的 `$ignore` 段须同批重生成（`node sync-ignore.mjs` /
  //      `node patch-backup-ignore.mjs`）；**推送由主人窗口执行**。
  {
    name: 'butler-registry-audit-runs.jsonl', schemaVersion: 1, persistence: 'persistent',
    retention: 'append-only（每次真跑一行；单行 < 64 KB，超限截断 problems 保计数）；不自动清理',
    sync: false,
    syncWhy: '记的是**本机**运行事实与时间线（哪台机、哪个 source 在何时跑了跨表校验、结论如何）——'
      + '跨机共享会让另一台把对端的运行记录当成自己的（同 `queue-events.jsonl` / `secretary-push.jsonl` 款判据：'
      + '单机时间窗口事实）；且两台机各自留痕、各自判定是设计',
    loss: '不可重建（历史运行记录丢失）⇒ **答不出「最近一次全绿是哪天」**（这正是该台账存在的唯一目的）；'
      + '校验器本体与判定能力不受影响（只丢留痕）',
  },

  // ══════════════════════════════════════════════════════════════════════════════════
  // ── 2026-10-10 · 卡「冲刺600·补登记」（状态文件登记收口 · 21 条） ──────────────────────
  //   出处 = 缺口台账（§2 第 11 行 / §1 A 域；名字与路径不在本包内）。
  //        「登记 ↔ 磁盘双向闭合」判 🟡：磁盘有·登记无 22。
  //   本批口径（可复现）：磁盘侧 = `~/.dsh` **根层** `*.json` / `*.jsonl`（非递归，与第7棒转绿B /
  //        缺口台账1 同口径）；登记侧 = 本表 `name` 经 `expandHostPlaceholder(name, <host短码>)` 展开。
  //   逐条定性（读/写点 + mtime）与不登白名单理由：明细不在本包内。
  //   ⚠️ `sync:false` 的每一条都会让 `gitignoreBlock()` 多一行 ⇒ 仓1 工作副本 `.gitignore` 与
  //      `dsh-backup-sync.ps1` 的 `$ignore` 段须**同批重生成**（`node sync-ignore.mjs` /
  //      `node patch-backup-ignore.mjs`）；三处逐字一致由 `sync-ignore --check` 验。
  //   ⚠️ 三条 `sync:true`（api-balance-stats / butler-ignored / handoff-version）**已是仓1 采集项**
  //      （见 `dsh-backup-sync.ps1` 的 `$DshFiles` / `collect-manifest.json`）——若错标 false，
  //      `gitignoreBlock()` 会给它们加排除行 ⇒ `git add` 跳过 ⇒ **采集静默失效**。故标 true，
  //      并同批给 `collect-manifest.json` 补 `stateFile` 映射（S2 反向对账才闭合）。
  {
    name: 'api-balance-stats.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（每次刷新覆盖；只留 today / month 两个窗口）', sync: true,
    syncWhy: '跨机共享：两机各有一份 API 余额统计，随仓1 采集留档（重灌策略 report-only「双向分叉（各机统计）」，'
      + '即**采而不自动覆盖**——避免一台把另一台的统计抹掉）',
    loss: '余额曲线断档（当前值下次刷新即重建，**历史窗口不可回补**）',
  },
  {
    name: 'butler-ignored.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（主人 / 面板维护；sessions + tasks 两个忽略清单）', sync: true,
    syncWhy: '主人在面板上标记的「忽略项」是**跨机共享语义**（换机后同一批忽略仍成立）；'
      + '随仓1 采集（回灌 report-only，防旧仓版覆盖本机新忽略）',
    loss: '忽略项丢失 ⇒ 面板把主人已忽略的条目重新当"待处理"（噪音回归，需重新忽略）',
  },
  {
    name: 'handoff-version.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（交接器自举写 / 发布方写；含 self 版本 + minSupported + collectors/artifacts 指纹）', sync: true,
    syncWhy: '交接**版本门**的数据源：本机 `self` 版本要与仓内副本（`dsh/handoff-version.json`）与对端对照，'
      + 'fail-closed 判「版本不匹配禁止交接」⇒ 语义上必须跨机共享（随仓1 采集）',
    loss: '版本门降级（读不到即按 self 重建）；重建前**换机会误判版本不匹配而拒交接**',
  },
  {
    name: 'butler-relay-watchdog.json', schemaVersion: 1, persistence: 'persistent',
    retention: '每链最近 1 条（次数 + 时刻；`chains` 键控）', sync: false,
    syncWhy: '接力链**断链计数与时刻**＝单机时间窗口状态（冷却/去重同款判据）——双机共享会让另一台'
      + '把对端的断链次数当成自己的，误判「链已断」或「已恢复」',
    loss: '断链计数重置 ⇒ 需重新累计到阈值才告警（**一次漏报窗口**）；下一轮 tick 重建',
  },
  {
    name: 'butler-handoff-obs.json', schemaVersion: 1, persistence: 'persistent',
    retention: '按 runKey 去重（保留最近状态 + `staleLevel` / `staleDay`）', sync: false,
    syncWhy: 'P2 盯人侧的事件去重键 + `staleLevel`（「坏到什么程度才报」的档位）＝单机冷却口径；'
      + '双机共享会互相压制告警（同 butler-watch-state.json 款）',
    loss: '「不再更坏就永久静默」的判据丢失 ⇒ 同一交接告警可能重复推送（有冷却兜底，不会刷屏）',
  },
  {
    name: 'overnight-mode-<host>.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每次 `on` 覆盖；`off` / 恢复后保留 `restoredAt` 与原值快照）', sync: false,
    syncWhy: '整夜模式的电源/休眠/屏保/WU 加固**是本机设置快照**（按主机分文件）——跨机共享会把对端的'
      + '电源状态当成「本机原值被改回」的判据，导致误报或误恢复',
    loss: '备用原值基线丢失 ⇒ `overnight-mode off` 无法精确还原（退化为按默认计划恢复，需人工核对电源设置）',
  },
  {
    name: 'overnight-mode-auto-<host>.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（只在「宽限起算 / 宽限清空 / 真核到点」时覆盖写；一致时**零写盘**）', sync: false,
    syncWhy: '它记的是**本机**电源事件（拔电时刻）与真核时刻（按主机分文件）——跨机共享会把对端的拔电时间'
      + '当成自己的宽限起算点，导致本机该退保护时被对端的计时压住（或反之提前退）',
    loss: '宽限计时与真核时刻丢失 ⇒ 拔电后重新起算一次宽限期（晚 ≤10 分钟退保护）、真核提前触发一次'
      + '（多花一次 ~15 s 的只读核对）——**不影响保护本身**（保护态真源仍是 overnight-mode-<host>.json）',
  },
  {
    name: 'butler-tidy-obs.json', schemaVersion: 1, persistence: 'persistent',
    retention: '按 runKey 去重（保留最近状态）', sync: false,
    syncWhy: 'P2 收纳侧事件去重键＝单机冷却口径（与 butler-handoff-obs.json 同款），双机共享会互相压制告警',
    loss: '去重键重置 ⇒ 同一收纳事件可能重复推送一次',
  },
  {
    name: 'rollback-offsite-<host>.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每次跑覆盖；含 lastRunAt / consecutiveFailures / escalated）', sync: false,
    syncWhy: '冷盘可达性与连续失败计数**是本机事实**（按主机分文件：冷盘只挂在某一台）——跨机共享会把'
      + '对端的冷盘状态当成自己的（假绿/假红都会出）',
    loss: '连续失败计数与升级告警去重丢失 ⇒ 下次失败从 1 重新累计（**可能漏一次升级告警**）',
  },
  {
    name: 'upstream-watch-<host>.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每次 watch 覆盖基线：headSha / lastTag / baselineSource）', sync: false,
    syncWhy: '上游基线**按主机分文件**：两机各自观察到的上游 HEAD 推进独立记账（共享会让一台的推进'
      + '被另一台的基线吞掉 ⇒ 天天"无新提交"）',
    loss: '基线丢失 ⇒ 下次报告退化为全量（仍可重建，无数据损失）',
  },
  {
    // 2026-10-30 · 宿主侧 tickd job（外部通道官方 SDK 版本盯梢）的唯一写者（本包不附该脚本）。
    // 判据 = 宿主工具目录里的 `watch-official-sdk.mjs`（只写这一个文件 + 版本变化时一行告警）。
    name: 'channel-sdk-watch-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每次检查覆盖：lastCheckedAt / lastSeenVersion / lastAlertedVersion / baseline）', sync: false,
    syncWhy: '已告警版本是**本机去重键**：跨机共享会让对端先把某版本喊过 ⇒ 本机再发新版时被静默压掉；'
      + '且基线常量写在脚本里（随代码走），状态只补"喊没喊过"',
    loss: '「这个版本喊过没有」的记忆丢失 ⇒ 最坏是同一个新版多喊一次（无动作、无数据损失），下次检查即重建',
  },
  {
    name: 'butler-l3-reminder.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（插件开关，**热读**：改完不用重启）；含 maxPerSession / cooldownMs', sync: false,
    syncWhy: 'L3 提醒插件的**开关 + 每会话上限 + 冷却**（时间窗口口径）——双机共享会让另一台的开关/'
      + '冷却静默覆盖本机（且该插件默认关，跨机同步会把"本机故意关"改成"对端开着"）',
    loss: '回落代码默认（**默认关**）⇒ 零动作，不放开任何权限',
  },
  {
    name: 'ecosystem-panel-upgrade-cache.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（面板/采集刷新时覆盖：`at` / `latest` / `highest`）', sync: false,
    syncWhy: '版本体检结果是**按本机 node_modules 实测**得出的（含本机装了什么版本）——跨机共享会把'
      + '对端的版本当成本机（面板的"该升级"判断会指错包）',
    loss: '面板「升级体检」段退化（缓存缺失/结构不可解析 ⇒ 计 0 项、标 ok:false）；重跑体检即重建',
  },
  {
    name: 'butler-attach-scan.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份缓存（键 = 相对路径 + size + mtimeMs；`version` 字段内含 schema 号，无 `schemaVersion`）', sync: false,
    syncWhy: '附件实体存在性是**按本机磁盘 + 本机 home 路径**记账的——跨机共享会让另一台误判"实体在"'
      + '而**漏报缺失**（该扫描的全部意义就是发现缺失）',
    loss: '退化为全量重扫（只有耗时，无数据损失）',
  },
  {
    name: 'butler-restart-policy.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（主人设定：当前只有 `urgentEscalateMs`）', sync: false,
    syncWhy: '重启加急档阈值**是本机设定**（各机自算 / 各自设定口径）——跨机共享等于让另一台的设定'
      + '静默覆盖本机（同 butler-autonomy-limits.json 款判据）',
    loss: '回落代码默认策略（缺失/坏/非法键 ⇒ 用默认），**不放开任何权限**',
  },
  {
    name: 'phone-tunnel-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每次开/关手机通道覆盖：url / alive / pid / note）', sync: false,
    syncWhy: '隧道 URL / 存活 / pid 是**本机会话事实**（含本机进程与临时域名）——跨机共享会把对端的'
      + '隧道当成自己的（面板显示"已开"而本机其实没开）',
    loss: '面板/日报显示「未开启」（下次开启重建，无数据损失）',
  },
  {
    name: 'butler-handoff-imported.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每次导入覆盖）+ 抑制窗口（`suppressUntil`）', sync: false,
    syncWhy: '导入**抑制窗口**＝单机时间窗口（防"刚导入完又提醒"）——双机共享会压制对端本应报的'
      + '交接告警（对端的导入与本机的导入是两件事）',
    loss: '抑制窗口丢失 ⇒ 可能重复提醒一次交接导入（无实质损失）',
  },
  {
    name: 'butler-session-mirror.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每轮同步覆盖：`files` 增量 + `lastResult` + `consecutiveUnreachable`）', sync: false,
    syncWhy: '会话异地镜像的**可达性 + 增量状态**是本机到对端的链路事实（含 target 主机）——跨机共享'
      + '会把对端链路状态当本机；且该文件是 tickd 对该 job 的**健康判据真源**（见 lib/tickd-health.mjs）',
    loss: '镜像健康判据失效（tickd-health 退化为「不可探测」）；下一轮同步重建',
  },
  // 【卡「多端线·跨机骨架 S1」· 2026-10-11】新增 —— **统一开关文件本体**（方案 v2 §5.1 键形状 / §5.3 不跨机）。
  //   判据源：§5.3「**不进任何仓、不进任何同步链**」（**指开关文件本身**；核对产物随仓3 走是另一回事）——
  //   ① 它是**本机立场**（"我这台推不推"），另一台 拿到 本机 的值会当自己的口径；
  //   ② 先例 `butler-session-mirror.json`（E-7 明写"不跨机"）。
  //   ⚠️ 与"fail-open"不矛盾：文件丢了各入口按现值执行**但必须打印**（§5.2）⇒ 同步它零收益、只有串味风险。
  //   读取方 = `lib/sync-topology.mjs`（**唯一读取器**，2026-10-11 同卡新增；四入口接线属卡 S1b，S1 不接线）。
  //   ⚠️ `sync:false` ⇒ `gitignoreBlock()` 多 1 行 ⇒ 仓1 工作副本 `.gitignore` 与
  //     `dsh-backup-sync.ps1#$ignore` 两处载体需同步（跑 `sync-ignore.mjs` / `patch-backup-ignore.mjs`）。
  {
    name: 'butler-sync-topology.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（**人工/主人维护**；首期无任何自动写入方 —— 改它即改所有入口行为）', sync: false,
    syncWhy: '**本机立场**（"我这台推不推仓2 / 远端盘阈值多少"）：跨机共享会让对端把本机口径当自己的'
      + '（方案 §5.3 ①；先例 butler-session-mirror.json 的 E-7 同款：不跨机）。'
      + '⚠️ 缺文件时一律 fail-open 按各脚本现值 + 打印（§5.2）—— 正是"丢了也不改行为"这条设计，'
      + '使"同步它"零收益、只有串味风险',
    loss: '丢失 ⇒ 各入口 **fail-open 按现值执行 + 打印**（行为可预测、可诊断）；`remoteSpace` 段丢失 ⇒ '
      + 'fail-closed 到内置默认阈值 20/10 GiB（§5.2）—— 不丢能力，只丢"本机自定义口径"',
  },
  // 【卡「多端线·骨架第三柱」S4 · 2026-10-11】补登 —— 来源 = 第三轮复审 **D-3** 的建议
  //   （"方案未登记的新状态文件（S2 已建/将建）⇒ 建议补登记该文件"）。触发时点：S4 真跑
  //   `--audit-remote` 首次让它落盘 ⇒ `butler-registry-audit` 的 S4 判据「磁盘有必须登记」当场红。
  //   写入方 = `dsh-session-mirror.mjs` 的 `AUDIT_STATE`（默认 `~/.dsh/butler-session-mirror-audit.json`，
  //   env `DSH_SESSION_MIRROR_AUDIT_STATE` 可注入）；**它与主状态文件刻意分离**（§2.6：核对不写主状态文件）。
  {
    name: 'butler-session-mirror-audit.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每次核对覆盖：`lastAuditAt` + `orphans[]` + `orphanNew[]` + 计数）', sync: false,
    syncWhy: 'orphan「新增 / 存量」**基线**是本机对远端镜像的事实快照（含 `host` / `by`，2026-10-11 实测 133 KB）'
      + '——跨机共享会把对端基线当本机基线 ⇒ 「新增」计数错乱（假新增 / 假存量）',
    loss: 'orphan 基线丢失 ⇒ 该维度退化为 `null`（脚本如实写「无法分新增」，**不假绿**）；下一轮核对重建',
  },
  {
    name: 'board-j1b-samples.jsonl', schemaVersion: null, persistence: 'persistent',
    retention: 'append-only 采样台账（同 revision + 6h 内不重复；无 `schemaVersion`，首行自带 `at`/`host`）', sync: false,
    syncWhy: '看板体积/卡数采样是**本机账本的事实**（每行带 host）——跨机合并会让趋势曲线混入对端口径'
      + '（K5 趋势判据只认本机）',
    loss: '趋势曲线断档（重建需重新积累采样）',
  },
  {
    name: 'butler-sessions-land.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每次落地覆盖：repoHead / localCount / mergedCount）', sync: false,
    syncWhy: '会话落地的**跳过键**（本机 repoHead + 计数）＝单机幂等判据——跨机共享会让另一台误判'
      + '「这批会话已落地过」而静默跳过',
    loss: '退化为全量落地（幂等重跑，无数据损失；下次跑重建）',
  },
  {
    name: 'wake-smart.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（主人设定：目标 session + cards + note）', sync: false,
    syncWhy: '整夜「智能闹钟」的目标是**本机特定会话**（session id / 卡号）——跨机同步会让对端去唤醒'
      + '一个本机不存在的会话（静默失效）',
    loss: '回落 env（`WAKE_SESSION`）/ 命令行参数；配置丢失 = 闹钟不响（**不误发**）',
  },
  {
    name: 'butler-cold-handoff.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份运行键（`device` 维度：windows 窗口 + updatedAt）', sync: false,
    syncWhy: '冷交接的**运行键按设备记账**（窗口 / 去重）＝单机时间窗口口径，跨机共享会互相压制',
    loss: '退化为无运行键（下次执行重建；不误发）',
  },
  {
    name: 'channel-bot-state.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（本人 chatid / chattype / userid + **最近一条消息原文** + updatedAt）', sync: false,
    syncWhy: '**含家人消息明文**（隐私敏感，出机登记已单列 `tools\\lib\\egress-registry.mjs`）；且 chatid 是'
      + '本机观察到的单聊目标 —— 跨机共享等于把对端家人的消息搬到本机（服务面隐私包 §B2 判据）',
    loss: '退化为 **fail-closed 拒发**（找不到本人 chatid ⇒ 服务面推送不发，绝不误发给他人）',
  },
  // ── 【2026-10-10 · 卡「冲刺600·A域宪章层三件」】四件 10-10 新上物补登记 ────────────────
  //   来由：`butler-registry-audit` 的 **S4「磁盘有必须登记」**当场报 4 条红（复现值只读，出处不在本包内）
  //   ——这些文件都是 10-10 当天新上的
  //   （分身僵留收官 / 卡死会话自愈链），上卡时漏了这一步。
  //   字段口径：配置型文件**没有** `schemaVersion` 字段（只有开关键）⇒ 按先例登记 `null`（"不适用"）；
  //   账本型用 `version`（不是 `schemaVersion`）同此处置 —— 不虚报一个文件里不存在的字段。
  //   ⚠️ 四条一律 `sync:false`（单机行为口径 / 单机时间窗口），落进 .gitignore 排除段 ⇒ 三处载体
  //   （本表 / 仓1 工作副本 `.gitignore` / `dsh-backup-sync.ps1` 的 `$ignore`）同批重生成，
  //   由 `sync-ignore.mjs --check` 与 `patch-backup-ignore.mjs` 保证逐字一致。
  {
    name: 'butler-repair.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（开关键：`resumeInject` / `lingerAutoFinish`）', sync: false,
    syncWhy: '自治**开关**（本机是否自动续干 / 自动收官分身）= 单机行为口径 —— 跨机共享等于让对端'
      + '按本机的开关去动对端的分身',
    loss: '回落缺省（两键缺省均 false）⇒ fail-safe：宁可不自动动，不误动',
  },
  {
    name: 'butler-repair-linger.json', schemaVersion: null, persistence: 'persistent',
    retention: '环形账本（`history[]` 保留最近 N 条判定；含 `lastRunAt` / `lastVerdict`）', sync: false,
    syncWhy: '分身僵留账本 = **本机分身进程的历史**（含 PID / 报告龄）—— 跨机合并会把对端的 PID '
      + '当成本机分身（判据全错）；且它是 tickd 对该 job 的健康读数',
    loss: '只丢判定历史（下一轮按实况重算，无功能损失）',
  },
  {
    name: 'butler-stuck-recovery.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（开关键：`enabled` + `stuckMs` / `maxNudges` 阈值）', sync: false,
    syncWhy: '卡死会话自愈的**开关 + 阈值** = 单机行为口径（跨机共享会让对端按本机阈值去注入提醒）',
    loss: '回落缺省 `enabled:false` ⇒ 自愈停用（fail-safe：宁可不注入，不误扰会话）',
  },
  {
    name: 'butler-stuck-recovery-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: '按 session 记账（当日 `dayKey` 重置；`nudges` 计数 + `history[]`）', sync: false,
    syncWhy: '**按会话 + 按当日**的 nudge 计数与升级去重 = 单机时间窗口状态 —— 双机共享会互相'
      + '压制注入额度（同一会话当日将被少提醒）',
    loss: '当日计数与去重重置 ⇒ 可能同日重复提醒一次（无数据损失）',
  },
  // 【主线停滞提醒 v1 · 2026-10-23】stall-nudge 的三道闸状态（lastPushDate + 每 key 24h 冷却 / snooze）。
  //   判据同本表口径：内容 = **时间窗口 + 去重**（同一天推过没有 / 这个 key 24h 内提醒过没有），
  //   双机共享会互相压制提醒 ⇒ sync:false。丢失只影响"当天可能重复推一次"，无数据损失。
  {
    name: 'butler-stall-nudge.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（`lastPushDate` + `items[<key>].lastNotifiedAt/snoozedUntil/title`；无历史数组）', sync: false,
    syncWhy: '同日去重 + 24h 冷却 + 主人「先放着」搁置位 = **单机时间窗口状态** —— 双机共享会让对端'
      + '以为"今天已经推过 / 这条刚提醒过"而不喊人（告警被静默）',
    loss: '当天可能重复提醒一次；搁置位丢失 ⇒ 被搁置条目重新出现（无数据损失）',
  },
  // ── 2026-10-10 施工卡「翻译官·批1·hub 骨架」新增（channel-hub · 3 条）─────────────────────────
  //   判据源：台账 / 本地出口 / 闸三件（出处不在本包内）
  //   + ⑤包 §3.9 第 5 条登记义务；**卡验收判据 5 明写"新台账必须登记 state-files.mjs"**。
  //   三条一律 `sync:false`，判据 = 本表口径（**时间窗口 / 去重 / 锁 / 单机事实**一律禁同步）：
  //     入站消息流 + msgid 去重窗口 + 单实例锁 + 出口令牌 **全是"本机这一份长连接"的产物**，
  //     跨机共享会让两台都以为自己持着唯一长连接 —— 而方案 H1 明确同一机器人**只允许 1 条连接**。
  //   ⚠️ 三条 `sync:false` ⇒ `gitignoreBlock()` 多 3 行 ⇒ 仓1 工作副本 `.gitignore` 与
  //      `dsh-backup-sync.ps1#$ignore` 必须重生成（`node sync-ignore.mjs` + `node patch-backup-ignore.mjs`；
  //      **推送由主人窗口执行**）。
  //   ⚠️ 实体**只落在 对端机**（批1 按互踢纪律不挂常驻自启；本机 侧只有代码副本、不跑）。
  {
    name: 'channel-hub/inbound.jsonl', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '外部通道 hub 状态**只落在跑 hub 的那台机**（该段上方注释：实体只落 对端机，本机 侧只有代码副本、不跑）⇒ 本机不该有',
    retention: 'append-only（每条入站一行，不自动清理）；🔴 **只摘要+长度，禁落消息正文**（X6 口径）',
    sync: false,
    syncWhy: '单机入站事实（含 msgid / from.userid / chattype / 路由与耗时）—— 入站流属"本机这一份长连接"：'
      + '跨机共享会让对端读到"不是自己收的"消息，并污染 msgid 去重窗口（同 §3.9「单机事实」款）',
    loss: '答不出"这条消息到底收没收到"（批1 唯一的收货凭据）；去重窗口可从本台账重建、**本台账不可重建**',
  },
  {
    name: 'channel-hub/hub-state.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '外部通道 hub 连接态 / 去重窗口：同上（hub 只跑 对端机）⇒ 本机不该有',
    retention: '单份覆盖写（msgid 去重窗口 LRU 2000 + 连接态 + 收/去重计数）',
    sync: false,
    syncWhy: '**去重窗口 + 连接态** = 本表判据明列的禁同步项（去重 / 时间窗口）：双机共享会让两台互相压制'
      + '对方的 msgid 去重，并把对端的 `connected` 误读成本机连接态',
    loss: '重投保护窗口丢失 ⇒ 重启后若服务端重投旧消息会重复入库一行（可从台账看出，可容忍）；连接态是派生物',
  },
  // ── 2026-10-10 施工卡「翻译官·批2·能回话」新增（channel-hub · 2 条）─────────────────────────
  //   判据源：方案 §D4（会话映射 `~/.dsh/channel-hub/sessions.json`，**不进任何仓**）
  //   + §12.5-I10（"登记随批做，不要拖到 K5"）+ ⑤包 §3.9 第 5 条；两条同样 `sync:false`，
  //   理由与批1 三条同款：都是**本机这一份长连接**的产物（映射表指向的 DSH 会话就在本机）。
  {
    name: 'channel-hub/sessions.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '外部通道 hub 会话映射：同上（映射指向**本机** DSH 会话，只有跑 hub 的那台机才有）',
    retention: '单份覆盖写（原子写）：default 会话 + 每个 chat 的绑定 + pending（二次确认，批3 用）'
      + ' + pendingAsk（**agent 提问「待回答」标记**，卡【翻译官·交互】2026-10-11；🔴 **只落定位信息** {sessionId,host,callId,qCount,msgid,at}，**零正文**）'
      + '（R-015 2026-10-22 追加：pendingAsk 可选带 `labels` = **选项标签文案**〔仅「单问题 + 有选项」时落〕，'
      + '供跨机回答时把 `2` 译成「第 2 项」；**仍不含问句正文**，旧结构无该字段）',
    sync: false,
    syncWhy: '会话映射 = **本机 hub 与它本机 DSH 会话之间的对应关系**（含 chatid / userid / DSH sessionId）：'
      + '跨机共享会让对端指向"别的机器上的会话"（方案 §D4 明写落 对端机）；且含家人侧 chatid ⇒ 单机独占',
    loss: '丢失 ⇒ 手机每句话变"新建会话"（上下文全丢、token 暴涨）：可重建，但**旧会话上下文不可追**；'
      + 'pending 丢失 ⇒ 未消费的二次确认作废（安全方向，fail-safe）',
  },
  {
    name: 'channel-hub/hub-config.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '外部通道 hub 主人白名单 / 派发参数：同上（身份表 = 跑 hub 那台机的单机权限事实）',
    retention: '单份覆盖写：**主人白名单**（ownerUserIds）+ 家人身份表（批4）+ 派发参数（cwd / 超时 / 选段）'
      + ' + 批1b 起 `holdConnectionHosts`（**持长连接白名单**，全局单连接者语义）',
    sync: false,
    syncWhy: '**身份表就是单机权限事实**（谁能下危险动作）：跨机共享等于把一台机的授权搬到另一台，属越权风险；'
      + '且缺省空 = 谁都不是主人（fail-closed）—— 两份分叉会让人分不清"哪份才算"',
    loss: '丢失 ⇒ 回到"无主人"安全默认（危险动作全拒，**绝不降级执行**）+ 持连接白名单变空（= 不限制）；派发参数回缺省值（cwd=DSH 默认 / 超时 110s）',
  },
  // ── 2026-10-10 施工卡「翻译官·批1b·hub 常驻化」新增（channel-hub · 1 条）─────────────────
  //   判据源：方案 §12.5-I5（跨机件搬运单 · 凭证**只写路径不写值**）+ 卡任务 6「出机面/台账登记随本卡就地做」。
  {
    name: 'channel-hub/bot.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '外部通道 hub 明文凭据：同上（且属凭据类 —— 只落跑 hub 的那台机）',
    retention: '单份覆盖写：`{botId, secret}`（**明文密钥**）。批1b 起 hub 只读这里，**不再回落** `~/.dsh/channel-bot.json`',
    sync: false,
    syncWhy: '**明文凭据**（与 `channel-bot.json` / `channel-notify-token.json` 同款口径：凭证与凭证派生物一律单机、'
      + '不进任何仓、不打印值）；且它正是"哪台机能建长连接"的开关 —— 跨机共享 = 两台都能建连 ⇒ **互踢 + 消息静默丢失**',
    loss: '丢失 = hub 起不来（`exit 2` 凭证缺失，fail-closed 不静默降级）；恢复 = 从共享位置重新复制一份（同机同用户）',
  },
  {
    name: 'channel-hub/autostart-task.xml', schemaVersion: null, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '外部通道 hub 开机自启任务定义（绑**那台机**的计划任务/账号/路径）：同上',
    retention: '单份覆盖写：开机自启任务定义（UTF-16LE+BOM），每次 `hub-ctl autostart install --apply` 重写',
    sync: false,
    syncWhy: '它绑的是**这台机**的计划任务/账号/路径（`S4U` + 本机用户 + 本机 `--home`）—— 跨机共享无意义且会误装任务的形态',
    loss: '丢失 = 无碍（下次 install 重新生成；任务本体已注册在系统里，不依赖这份留档）',
  },
  {
    name: 'channel-hub/confirm.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '外部通道 hub 二次确认链的**运行态**（失败计数 / 静默窗口）：只有真发生过确认尝试才会建这份文件 ⇒ 稳态下不存在属正常',
    retention: '单份覆盖写：`fails`（每个 chatid:userid 的错误确认计数，满 3 清零）+ `silence`（静默窗口 until/reason）',
    sync: false,
    syncWhy: '**时间窗口 + 防暴力猜的计数**（跨机共享会互相压制：一台机的"错 3 次"不该把另一台也静默）；'
      + '且键域 = 本机 hub 收到的 `chatid:userid` ⇒ 单机独占',
    loss: '丢失 ⇒ 静默窗口与失败计数归零（fail-safe 方向：更宽松，但**不会**因此放行任何危险动作；'
      + '危险动作还要过 pending + 内存原文绑定 + actionHash 复核）',
  },
  // ── 2026-10-11 卡【翻译官·批4·家人档地基】新增（channel-hub · 1 条）──────────────────────
  //   判据源：方案 §12.5-I6（`enter_chat` **未查证** ⇒ 落探针实测）+ ⑤ 包 §3.9 第 5 条「新台账必须登记」。
  {
    name: 'channel-hub/enter-chat-probe.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '`event.enter_chat` 实测探针：**只有那个事件真的来过**才建这份文件（没有 ⇒ 不落盘，'
      + '这本身就是"未触发过"的证据）',
    retention: '单份覆盖写：`count`（来过几次）+ `lastAt`（最近一次）+ `lastFromShape`（from 的**形态串**：'
      + '`short:N` 明文 / `long:N` 疑似密文，**零 userid、零正文**）',
    sync: false,
    syncWhy: '**本机 hub 的运行时事实**（哪台机的长连接收到过该事件）—— 跨机共享会让对端把本机的探针读数当自己的',
    loss: '丢失 = 只剩"是否触发过"这一个问题的取证断档（功能不受影响）；重跑即从 0 重新累计',
  },
  // ── 2026-10-11 卡【翻译官·批5-3·图片】新增（channel-hub · 1 条）──────────────────────────
  //   判据源：本卡 prompt 任务④「素材目录纳入清理口径（写进文档）」+ ⑤ 包 §3.9 第 5 条。
  //   📌 **订正注（2026-11-04 · 卡「通道非文字-1」R-013 · 只加注不改下文原句）**：下面说"**唯一**会把用户
  //      内容**实体**落盘的地方"仍然成立（媒体素材 = 入站用户内容）；但 channel-hub 里**落盘的内容实体**自此有
  //      **第二处** = `channel-hub/media/<日期>/outbox/`（长文转 .md）——它存的是**出站**正文（本鱼回给主人的话），
  //      **不是用户内容**，所以不推翻"唯一"这个判定，只在此标明两处落盘实体各自的分类。条目见本段末尾。
  //   📌 **订正注（2026-11-04 · 卡「通道非文字-3」R-008 · 文件入站 · 只加注不改下文原句）**：本条目
  //      （`channel-hub/media/`）**自 2026-11-04 起管两类入站实体**，不只图片：
  //        ① 图片 `media/<日期>/<msgid>.<ext>`（png/jpg/gif/webp —— 10-11 起）；
  //        ② **文件** `media/<日期>/<msgid>-<净化名>.<ext>`（pdf/docx/xlsx/zip/csv/md/txt —— 本卡起）。
  //      ⇒ 下方 retention 里「扩展名白名单 = png/jpg/gif/webp」与「唯一到图片字节」两句**已被这条扩写**；
  //        文件支的落盘扩展名**只到 `{csv, md, txt}`**（纯文本一律收，但绝不让 `.ps1/.bat/.js` 带可执行扩展名落地，
  //        真源 = `<宿主工具目录>\inbound-common.mjs#sniffDocType`）。
  //        其余口径（按日期分目录 · keepDays 单一真源 `imageInbound.keepDays` · `image-ctl.mjs clean` 是唯一删除口 ·
  //        sync:false · 可丢类）**全部不变** —— 文件素材与图片**同一个根**，所以不新增条目（审核 I12 允许的形态）。
  //   📌 **订正注（2026-11-04 · 卡「通道非文字-4」R-009 · 视频入站 · 只加注不改下文原句）**：本条目**再扩一类**：
  //        ③ **视频** `media/<日期>/<msgid>-video.mp4`（或 `.webm`）+ 它的**帧子目录**
  //           `media/<日期>/<msgid>/frames/frame-<N>.jpg`（抽 6 帧，每张 ≥1 KB）—— 本卡起。
  //      ⇒ "唯一到图片字节"这句**进一步被扩写**：实体现在有三类（图片 / 文件 / 视频与帧），但**同一个根**
  //        （`channel-hub/media/`）⇒ 仍**不新增条目**；8 字段口径逐条对齐如下（审核 I12 要求"写满 8 字段"）：
  //          · schemaVersion = null（目录型，无版本键）；persistence = volatile（同一行已给）；
  //          · onDemand = true（只在真收到视频时才建）；onDemandWhy 同上条（没收到 ⇒ 不存在）；
  //          · retention = 跟 `imageInbound.keepDays`（**现 30 天**；2026-11-04 收尾卡由 14 改）+ `image-ctl.mjs clean` 唯一删除口
  //            （帧目录在**日期目录之内** ⇒ 结构上被同一个守门管到，方案 §3.5 第 6 条）；
  //          · sync = false（同条）；loss = **可重抽**：视频字节还在 ⇒ 删了帧能再抽一次；视频也被清理 ⇒ 帧不可恢复
  //            （但源在外部通道侧，主人重发即可）⇒ 与图片同属**可丢**类，**不影响台账与判定**。
  //      🔴 ffmpeg **不写任何东西到本目录之外**（帧目录 `frames.tmp-*` 的临时件同父目录、抽完即改名或删除）；
  //         `extractFrames` 删旧目录前有**守门**（只删 `mediaRoot` 之下的路径，别的一律拒动）。
  //   🔴 **口径例外（经主人 2026-10-11 授权）**：这是 channel-hub 里**唯一**会把用户内容**实体**落盘的地方
  //      （其余台账 / 审计一律"只记摘要 + 长度 + 判定"）；例外范围**只到图片字节**——
  //      下载链接、aeskey、正文文本**一律不落盘、不进任何仓、不外发**。
  //   📌 **订正注（2026-11-04 · 卡「通道非文字-5」收尾 · 只加注不改上文原句 · 审核 I12 要求）**：上三行里
  //      「例外范围**只到图片字节**」**已过期** —— 自 2026-11-04 四件非文字上线起，同一个 `channel-hub/media/` 根下
  //      **共有四类实体**，都属这一条例外的授权范围（口径不变的那半句 = 链接 / aeskey / 正文文本仍一律不落盘）：
  //        ① **图片** `media/<日期>/<msgid>.<ext>`（png/jpg/gif/webp）—— 10-11 起；
  //        ② **文件** `media/<日期>/<msgid>-<净化名>.<ext>`（pdf/docx/xlsx/zip/csv/md/txt）—— 卡 3 起；
  //        ③ **视频** `media/<日期>/<msgid>-video.{mp4,webm}` + 帧 `media/<日期>/<msgid>/frames/frame-<N>.jpg` —— 卡 4 起；
  //        ④ **出站附件** `media/<日期>/outbox/reply-<YYYYMMDD-HHmmss>-<sha8>.md` —— 卡 1 起（**出站正文、不是用户内容**，
  //           挂同一根只为共用清理守门；条目见本段末尾 `channel-hub/media/<日期>/outbox/`）。
  //      ⇒ **四类各自的 loss 分开判**（别拿一句话概括四类）：
  //        · ①②③（用户内容实体）丢 = 会话里那条路径失效（`read_document` / `read_image` 打不开），
  //          台账与判定**不受影响**，让主人/家人**重发**即可 ⇒ **可丢**；
  //        · ③ 的**帧**另有增量口径：视频字节还在 ⇒ 删了帧**能重抽**；视频也被清理 ⇒ 帧不可恢复（源在外部通道侧，重发即可）；
  //        · ④（出站附件）丢 = 本地副本没了，**外部通道里那条消息与附件照旧**（`media_id` 3 天有效，过期也不影响已发消息）⇒ **可丢**。
  //      清理口径：全部由 `imageInbound.keepDays`（**30 天**，2026-11-04 统一）驱动，删除口仍是 `image-ctl.mjs clean`
  //      （唯一，`…/channel-hub/media` 守门）+ 出站专用的 `outbound-ctl.mjs clean`（同 30 天，守门白名单 `{media, outbox}`）。
  {
    name: 'channel-hub/media/', schemaVersion: null, persistence: 'volatile',
    onDemand: true,
    onDemandWhy: '外部通道图片素材目录：**只有真收到过图片**才建（没收到 ⇒ 不存在，这本身就是"没收到过图"的证据）',
    retention: '按本地日期分目录 `media/<YYYY-MM-DD>/<msgid>.<ext>`（扩展名白名单 = png/jpg/gif/webp，'
      + '**魔数嗅探**判定、不看扩展名；单张上限缺省 10 MB）。清理口径 = `hub-config.json#imageInbound.keepDays`'
      + '（现 **30 天**；2026-11-04 收尾卡由 14 改 —— 与 `media-clean.cmd --days 30` 两处同改，审核 I4）'
      + '；一键清理 `node <宿主工具目录>\\image-ctl.mjs clean [--days N] --apply`'
      + '（**缺省 dry-run**，只有 --apply 才真删）。',
    sync: false,
    syncWhy: '① 里面是**用户发来的原始内容实体**（图片字节）—— 跨机共享 = 把主人/家人的私人图片复制到另一台机，'
      + '与"零正文 / 最小出机面"口径直接冲突；② 它是**单机事实**（只有持长连接那台机收得到图）'
      + '⇒ 与本表内 `channel-hub/*` 各条同款判定（单机独占，理由见该段段首注）。',
    loss: '丢失 = 那几张图在会话里"路径失效"（DSH 侧 read_image 打不开）；**不影响任何台账与判定**，'
      + '让对端重发即可 ⇒ 属**可丢**类（时间窗口素材，非凭据、非台账、非配置）。',
  },
  // ── 2026-11-04 卡「通道非文字-1」（R-013 · 长文当文件发）新增（channel-hub · 1 条）────────────
  //   判据源：§3.1 + §3.5 第 6 条 + 审核 I6 / I12（出处不在本包内）。
  //   🔴 与上一条 `channel-hub/media/` 的关系：**同根不同类** —— media/<日期>/ 存**入站**素材（用户发来的图），
  //      outbox/ 存**出站**附件（我们把长文转成的 .md，内容是本鱼回给主人的话）⇒ 不属"用户内容实体"。
  //   ⚠️ 为什么嵌在 media 日期目录下（而不是独立 `channel-hub/outbox/`）：`image-ctl.mjs:117` 的守门硬编码
  //      「`…/channel-hub/media`」，独立成兄弟目录就**结构上**落在守门之外（方案 §3.5 第 6 条）。
  {
    name: 'channel-hub/media/<日期>/outbox/', schemaVersion: null, persistence: 'volatile',
    onDemand: true,
    onDemandWhy: '长文转文件（R-013）**只在真发过超阈值长文**时才建（>100 行 或 >4000 字）；没发过 ⇒ 不存在',
    retention: '按本地日期分目录 `media/<YYYY-MM-DD>/outbox/reply-<YYYYMMDD-HHmmss>-<sha8>.md`（文件名**纯 ASCII**）；'
      + '清理口径 = `hub-config.json#outboundFile.keepDays`（缺省 **30 天**）；'
      + '一键清理 `node <宿主工具目录>\\outbound-ctl.mjs clean [--days N] --apply`'
      + '（**缺省 dry-run**，只有 --apply 才真删）。'
      + '⚠️ `image-ctl.mjs clean`（30 天）**不会**连带删它：超期日期目录若含未到期附件 ⇒ 只清该目录的其余内容。',
    sync: false,
    syncWhy: '① 里面是**出站正文的实体**（本鱼回给主人的长答原文）—— 跨机共享 = 把一段对话内容复制到另一台机，'
      + '与"零正文 / 最小出机面"口径直接冲突；② 它是**单机事实**（谁发谁落，另一台没有这段上下文）'
      + '⇒ 与本表内 `channel-hub/*` 各条同款判定（单机独占，理由见该段段首注）。',
    loss: '丢失 = 手机上那个 `.md` 附件对应的**本地副本**没了（附件本身已躺在主人外部通道里，消息不丢）；'
      + '此后新长文照常生成新附件 ⇒ 属**可丢**类（时间窗口产物，非凭据、非台账、非配置）。',
  },
  {
    name: 'channel-hub/', schemaVersion: null, persistence: 'persistent',
    // 【2026-11-04 · 卡「通道非文字-5」收尾】补齐 8 字段：本条原来只有 7 项（缺 onDemand / onDemandWhy）
    //   ⇒ 语义按现场实测填：目录**跑过一次 hub 才会有**（本机 这份是测试残留：hub-ctl.log / hub-token /
    //   inbound.jsonl / sessions.json 四件），生产实体只在 对端机 ⇒ 与段首「实体只落 对端机」同款，判 onDemand。
    onDemand: true,
    onDemandWhy: '目录由 hub 运行产生（锁 / 令牌 / 日志 / 控制留痕）：**没跑过 hub 就没有** —— '
      + '本机（本机）现有内容是测试残留，生产实体只在 对端机（与段首「实体只落 对端机，本机 侧只有代码副本」同口径）',
    retention: '令牌永久（本机凭据；重建 = 重新生成）· 锁随进程（退出即删）· `hub.log` 5MB 轮转 · '
      + '`drill-*.json` 演练留档不自动清理 · `hub-ctl.log` 操作留痕 append-only',
    sync: false,
    syncWhy: '目录内是本机**凭据与进程态**（`hub-token` 出口令牌 / `hub.lock` 单实例锁 / `hub.log` / '
      + '演练报告 / 控制留痕）：令牌跨机会让对端能调本机出口；锁跨机会让对端误判"已有实例"而拒启'
      + '（同 `channel-notify-token.json` 款：凭证派生物一律单机）',
    loss: '令牌丢失 = 重新生成（调用方需重读）；锁丢失 = 无害（启动时重建）；日志与留档丢失 = 排障与演练取证断档',
  },
  // ── 【2026-10-14 · 卡「大管家 V2.9.X 收口尾段 · 控制室红项」】补登：`ws-rehome-once.json` ──────────
  //   来由：该文件自 2026-10-12 由一次性归位工具 `tools\ws-rehome-once.mjs` 首次落盘后，
  //     `butler-registry-audit` 的 **S4「磁盘有必须登记」**每轮都报一条红（2026-10-12 / 10-13 / 10-14
  //     日报「🔴 控制室红项」段同一件）⇒ 「登记 ↔ 磁盘」不闭合。
  //   处置判据（S4 纪律：**有生产读写点的一律补登**，不许塞 `DISK_ONLY_ALLOWLIST`）：
  //     · **不是凭据类**：内容只有 task / status / doneAt / 计数（零 secret、零 token）；
  //     · **不是死文件**：写点 = `tools\ws-rehome-once.mjs` L274 / L374（`fs.writeFileSync(MARKER, …)`），
  //       读点 = 同文件入口 + `dsh-start.ps1` 第 1.9 步（L519-547，marker 驱动：只有 `status=pending` 才跑）。
  //   ⚠️ 字段口径：文件里是 `version: 1`（**不是** `schemaVersion`）⇒ 按 `butler-attach-scan.json` 先例登记 `null`，
  //      不虚报一个文件里不存在的字段。
  {
    name: 'ws-rehome-once.json', schemaVersion: null, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '**一次性迁移的完成标记**：只有**跑过**那次「工作区归位」的机器才落它（本机 2026-10-12 已跑完 ⇒ 常驻 `status:done`）；'
      + '对端（另一台）没跑过、也就没有这个文件 —— 标 `onDemand` 才不至于把 S4 的红项从本机搬到对端的 S5（正向断言）上',
    retention: '单份（每次运行覆盖写；跑完自标 `status:done` 后不再变）',
    sync: false,
    syncWhy: '记的是**本机**一次性迁移的完成事实（`task` / `status` / `doneAt` + 迁移与收养的会话数 + 被删工作区 id）——'
      + '两台机的工作区表与会话目录各自独立，跨机共享会让另一台误判「本机已归位过」；'
      + '且它的唯一消费方就是本机启动链（`dsh-start.ps1` 第 1.9 步）',
    loss: '丢失 = 下次冷启动当作「未归位」⇒ **重跑一次**归位（工具幂等：会话 / 工作区已就位时只写 `status:"done"` + '
      + "`note:'无需处理（幂等）'`）⇒ **不丢数据、不误迁**，代价 = 一次只读扫描 + 一个备份目录",
  },
  // ── 【2026-10-14 · 卡「封口①-A域」】补登：`butler-rule-drift-exempt.json` ──────────────
  //   来由：本卡开工**现跑** `node tools\dsh-butler\butler-registry-audit.mjs --json --no-ledger`
  //     ⇒ `state-file 196/1`，**唯一 problem 就是本件「S4 磁盘有必须登记」**（上一件 `ws-rehome-once.json`
  //     已由 2026-10-14 卡「大管家 V2.9.X 收口尾段 · 控制室红项」补登 ⇒ S4 侧缺口**换件**、不变量仍未闭合）。
  //   处置判据（S4 纪律：**有生产读写点的一律补登**，不许塞 `DISK_ONLY_ALLOWLIST` 糊过去）：
  //     · **读点**：`tools\rule-drift-check.mjs`（「老话巡检」唯一读方）+ `lib\butler-locks.mjs:474`
  //       锁注册表登记「读 ~/.dsh/butler-rule-drift-exempt.json（只读：豁免清单）」；
  //     · **写点**：豁免项由人 / 卡显式追加（文件内 `_updatedAt` 随写刷新）；
  //     · **不是凭据类**：内容是「哪一行老话被判定为『就该这么写』」+ 理由，零 secret。
  {
    name: 'butler-rule-drift-exempt.json', schemaVersion: null, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '**人工维护的豁免清单**：`exempt` 从未加过的机器本就不该有该文件（与 '
      + '`butler-relay-handoff-warn.json` 同款判据：「未配过即不存在」）⇒ 标 `onDemand` 才不会把本机的'
      + '红项搬到对端的**正向断言**（S5 登记有必须落盘）上去',
    retention: '长期（人工维护，无自动过期）—— 豁免项只增不减，每条自带 `at`（哪天判定的）',
    sync: false,
    syncWhy: '豁免绑的是**本机 skill 文件的某一行原文**（`file` 含 `<home>` 占位 + `line` 行号）—— '
      + '两台机的 skill 版本与行号各自独立，跨机共享会让另一台按对方的行号压制自己该报的漂移'
      + '（同 `butler-relay-handoff-warn.json` 判据）',
    loss: '重建（代价 = 已确认豁免的那几行重新报一次漂移 ⇒ 退化为「每轮重报」；不丢数据、不误判）',
  },
  // ── 【2026-10-19 · 控制室红项清零】补登：`dsh-expression.json` / `upgrade-progress.json` ─────────────
  //   来由：`butler-registry-audit` 的 S4「磁盘有必须登记」在 2026-10-19 日报仍报 2 条红
  //     （`~/.dsh/dsh-expression.json` / `~/.dsh/upgrade-progress.json` 在磁盘上但 STATE_FILES 没有）。
  //   处置判据（S4 纪律：**有生产读写点的一律补登**，不许塞 DISK_ONLY_ALLOWLIST）：两个都有真实读写点。
  //     · `dsh-expression.json` —— 写/读点 = DSH「表情/梗图」设置面（生态面板 / 表情插件）：
  //       内容是梗图根目录 + 启用的包清单 + 远端订阅；不是凭据（零 token / 零正文）。
  //     · `upgrade-progress.json` —— 写点 = `tools\snapshot-upgrade-pre.mjs` L629；
  //       读点 = `tools\restore-upgrade-pre.mjs` L237 + `tools\dsh-butler\lib\upgrade-lock.mjs`（注释口径：锁即进度）。
  //   ⚠️ 两文件均**无 schemaVersion 字段** ⇒ 按 `butler-attach-scan.json` 先例登记 null，不虚报不存在的字段。
  {
    name: 'dsh-expression.json', schemaVersion: null, persistence: 'persistent',
    retention: '长期（人工在设置面改，无自动过期）',
    sync: false,
    syncWhy: '内容是本机梗图根目录（绝对路径）+ 启用的梗图包 + 远端订阅清单 —— 两台机的梗图目录与包版本各自独立，'
      + '跨机共享会让对端按不存在的路径读图（且会把个人订阅选择带过去）',
    loss: '丢失 = 表情/梗图配置回落默认（梗图根目录与启用包需在设置面重选；不影响会话与告警）',
  },
  {
    name: 'upgrade-progress.json', schemaVersion: null, persistence: 'volatile',
    retention: '最近一次升级的步骤进度（每步一条；升级完成后保留作取证，人工清理）',
    sync: false,
    syncWhy: '记录的是**本机**某次升级已完成的步骤（插件名 + 版本迁移）—— 跨机共享会让对端误判「这一步我做过」'
      + '（同 butler-autonomy-state.json 款：单机时间窗口状态）',
    loss: '丢失 = 升级中断时无法从进度判断走到哪一步（重跑预检 snapshot-upgrade-pre.mjs 即可重建，不误回滚）',
  },
  // ── 【2026-10-21 · 卡「V3 功能面 N0-b · registry 真缺口补登记」】补登 3 件 ────────────────────
  //   来由：`butler-registry-audit` 的 **S4「磁盘有必须登记」**现跑（2026-10-21 13:42）报 42 条 state-file 差异，
  //     其中 40 条是 `ops-*` 一族（2c 状态名迁移的双写镜像 —— 由 registry-audit 0.3.5 的**别名归并**处置，
  //     **不重复登记**：`ops-X` 与 `butler-X` 是同一个逻辑文件，登记两次会把 sync/schemaVersion/丢失后果各写两遍），
  //     真·未登记 = 下面 3 件。处置判据（S4 纪律：**有生产读写点的一律补登**，不许塞 `DISK_ONLY_ALLOWLIST`）。
  {
    // R-071② 定时快照 + 异地镜像的账本（tickd job `snapshot`，30 min，`--once --apply`）。
    //   写/读点唯一 = `tools\dsh-butler\dsh-snapshot-tick.mjs`（经 `resolveStatePath()` 取名 ⇒ 2c 迁移后
    //   **新建**的文件只落新名 `ops-snapshot-tick.json`：`dual` 期「文件不存在 ⇒ 给新名」）。
    //   ⚠️ 登记名按**逻辑名**（`butler-` 前缀）写 —— S5 改名时只改 `name` 字段（2cA §145 口径）；
    //      盘上只有新名这一形态由 registry-audit 0.3.5 的别名归并认（S4 磁盘→登记 / S5 登记→磁盘 双向）。
    //   字段口径：文件里确为 `schemaVersion: 1`（2026-10-21 现读）。
    name: 'butler-snapshot-tick.json', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '**job 可关**（一键关回 = `butler-autonomy-cli.mjs job off snapshot`，缺键/关着即不该有该账本）：'
      + '关着该 job 的机器本就不生成它 ⇒ 标 onDemand 才不至于把本机的红项搬到对端的 S5（登记有必须落盘）上',
    retention: '单份（每次运行覆盖）：lastRun / lastSnapshot（name·files·bytes·copied·linked·elapsedMs）/ '
      + 'lastMirror + lastMirroredDay + history（逐轮条目）+ usedNames + totals（runs/failures/mirrorRuns/mirrorFailures）',
    sync: false,
    syncWhy: '记的是**本机** `~/.dsh` 的快照份名与「今天镜像过没有」（`lastMirroredDay`）—— '
      + '跨机共享会让另一台误判「今天已镜像过」而漏推自己那份（同 butler-memory-snapshot.json 款判据）；'
      + '两机 home 内容本就不同，快照份也不该互相覆盖',
    loss: '丢失 = ① 判不出今天是否已镜像 ⇒ 多推一次（幂等，代价一次打包+scp）② `usedNames` 丢了可能重名覆盖同名份 '
      + '⇒ 下一轮快照按 `--once` 重建账本；快照实体与远端镜像不受影响（只丢"记账"）',
  },
  {
    // R-071④ 进程审计日志（Security 4688）增量转存的**游标 + 去重键**。
    //   写/读点唯一 = `tools\dsh-butler\audit-export-4688.mjs`（缺省 `DEFAULT_STATE`，`--state` 可覆盖；
    //   跑在 Windows 计划任务里 = SYSTEM + 最高权限，读 Security 日志需要「管理审核和安全日志」特权）。
    //   字段口径：文件里是 `version: 1`（**不是** `schemaVersion`）⇒ 按 `ws-rehome-once.json` 先例登记 `null`。
    name: 'butler-audit-export.json', schemaVersion: null, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '**只有装了转存计划任务的机器才有它**（安装器 = 桌面 `DSH鲸落地\\audit-export-install.cmd`，'
      + '2026-10-21 本机已装、`totalEvents 87,712`）；没装该任务的机器本就没有这个游标文件 ⇒ 不该被 S5 判红',
    retention: '单份（每次运行覆盖）：lastExportedAt / lastExportFile / lastEventCount / lastRunRc / '
      + 'totalEvents / totalFiles / recentKeys（去重键，保留 20 条）/ updatedAt',
    sync: false,
    syncWhy: '记的是**本机** Security 日志的导出游标与去重键（键里含本机事件原文：进程路径 + 父进程 PID）—— '
      + '跨机同步会让对端按本机的游标去导/跳过自己的事件（同 butler-pitfall-scan.json 款判据）；且事件键属本机现场，不该跨机漂流',
    loss: '丢失 = 下次按 `--since`（缺省 24 小时前）重导 ⇒ 已导过的事件**重复写一遍**（去重键没了）、'
      + '或游标丢失后只补最近 24h（更早窗口靠 CSV 本体，不靠本文件）；CSV 实体在 `<workspace>\\_archive\\audit-4688\\` 不受影响',
  },
  {
    // 家人身份表（唯一的"谁能用小秘书 + 能用哪些能力位"真源）。
    //   读/写实现唯一 = `<宿主工具目录>\identity.mjs`（CLI 壳 = `tools\dsh-butler\secretary-user.mjs`，
    //   缺省 dry-run、`--apply` 才写、写前自动备份到 `<home>\_archive\secretary-users\<ts>\`）。
    //   字段口径：文件里是 `version: 1` ⇒ 按 `ws-rehome-once.json` 先例登记 `null`。
    name: 'secretary-users.json', schemaVersion: null, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '**未登记过任何家人的机器本就没有它**（语义 = `default: deny` 的空表：没有文件也照样"一律拒"）；'
      + '只有跑过 `secretary-user.mjs add … --apply` 的机器才落盘 ⇒ 标 onDemand 才不会把本机红项搬去对端的 S5',
    retention: '单份（人工维护，无自动过期）：users{userid → name/role/caps/limits/llm/notified/addedAt/addedBy}',
    sync: false,
    syncWhy: '身份表绑的是**本机那条外部通道长连接**（userid 只在这台机收得到消息）；跨机同步会把对端的 userid 带过来 ⇒ '
      + '本机按一条不存在的连接授权（假放行）；且 userid 属个人信息，不该作为状态文件跨机漂流'
      + '（真源口径 = `<宿主工具目录>\\identity.mjs` 头注「唯一权威源」+ 服务面隐私包 §3.3）',
    loss: '丢失 = 按 `default: deny` **所有人一律拒**（含主人本人）⇒ 家人档整条不可用；'
      + '重建 = 按外部通道导出的 userid 跑 `node tools\\dsh-butler\\secretary-user.mjs add <userid> … --apply` 逐条重录'
      + '（`_archive\\secretary-users\\<ts>\\` 有写前备份可回滚）',
  },
  {
    // R-071③ 大量消失告警的账本（tickd job `vanish-watch`，5 min，`--once --apply`，首版 observe 档）。
    //   写/读点唯一 = `tools\dsh-butler\dsh-vanish-watch.mjs`（`STATE_NAME = 'butler-vanish-watch.json'`，
    //   经 `resolveStatePath()` 取名 ⇒ 2c 迁移后**新建**的文件只落新名 `ops-vanish-watch.json`）。
    //   ⚠️ 它进本表的直接原因：别名归并（`ops-X` ↔ `butler-X`）能认"两边都在盘"的 39 件，但**认不出
    //      "天生只有新名"**的文件（盘上 `ops-vanish-watch.json`、本表查无此项）⇒ 这一件必须真登记。
    //      登记名 = **逻辑名**（`butler-` 前缀），盘上只有新名由 0.3.5 的别名归并认（S4/S5 双向）。
    //   字段口径：文件里确为 `schemaVersion: 1`（2026-10-21 现读）。
    name: 'butler-vanish-watch.json', schemaVersion: 1, persistence: 'persistent',
    retention: '单份（每轮覆盖）：mode（observe/notify）+ faces{各面 count/at} + shadow + events（最近 20 条）+ '
      + 'cooldowns（按面冷却）+ lastRunAt',
    sync: false,
    syncWhy: '内容全是**本机**各面的条目数（sessions / skills / docs / tools / _archive 顶层）—— 两机条目数天然不同，'
      + '跨机共享会让对端拿本机读数当基线，一合并就判「大量消失」；cooldowns 也是单机告警冷却'
      + '（同 butler-watch-state.json 款判据）',
    loss: '丢失 = 下一轮重建基线（**首轮无对照 ⇒ 那一轮不告警**，静默一轮）；不丢数据、不误判'
      + '（对照缺失时脚本按"只记基线"处理）',
  },
  // ── 【2026-10-22 · 卡「V3 功能面·两小件 R-044」】补登：`butler-bind-reconcile.log` ─────────────
  //   来由（不是"顺手补"）：R-044 新加的那条**新名覆盖自检**（`sync-ignore.mjs --check`）现跑点出来
  //     —— `~\.dsh\ops-bind-reconcile.log` 在盘上，而**登记表与排除段两头都没有它**
  //     （正是 `交付报告-V3功能面-待核7条定性-20261022.md` §3⑤ 说的「两张表都不管」地带）。
  //   读写点：
  //     · **写点** = `tools\dsh-butler\butler-bind-card.mjs`（`RECONCILE_LOG_NAME`；经 `resolveStatePath()`
  //       取名 ⇒ 2c 迁移后落新名 `ops-bind-reconcile.log`；只在绑卡的输出异常时追加一行）；
  //     · **读点** = 无 —— 纯人工排查时看的日志（与 `butler-alert.log` 同款）。
  //   ⇒ 登记为 `sync:false`（本机日志，跨机同步只会串味）。`schemaVersion` 不适用（文本日志）⇒ null。
  {
    name: 'butler-bind-reconcile.log', schemaVersion: null, persistence: 'volatile',
    onDemand: true,
    onDemandWhy: '**只有绑过卡的机器才有它**（每行 = 一次 `butler-bind-card` 输出异常的留痕；没绑过卡的机器'
      + '本就没有该文件）⇒ 标 `onDemand` 才不会把本机日志搬到对端的 S5（登记有必须落盘）上判红',
    retention: '无限追加（只记绑卡输出异常；人工清理）',
    sync: false,
    syncWhy: '内容是**本机**卡 id / 会话 id / 超时与耗时（如 `card=… timeoutMs=8000 status=ok ms=7977`）——'
      + '跨机同步既不解决任何问题，又把别机的绑卡现场串进来（同 butler-alert.log 款判据）',
    loss: '丢失 = 历史上「哪次绑卡输出异常」的线索消失（不影响任何功能判定；下一行继续写）',
  },
  // ── 【2026-10-28 · 卡「V3 功能面 · 文档同步告警」】新件两条：`notify-docsync.json` + `notify-docsync-state.json` ──
  //   真源 = 内部文档同步告警方案（不在本包内）；脚本 `tools\dsh-butler\notify-docsync-watch.mjs`
  //   （tickd job `notify-docsync`，30 分钟，`--apply`）。
  //   为什么必须登记：registry-audit 的 **S4「磁盘有必须登记」** 现跑就点了名 —— 不登记则
  //   schemaVersion 迁移校验、跨机同步判定、丢失后果三项**全无依据**。
  //   两条**都** `sync: false`（判据同 butler-watch-state.json 款，但理由各有各的）：
  //     · 配置里含主人的**外部通道 userId / 机器人账号**（单机登录身份）⇒ 跨机同步 = 把别人的收件人串过去；
  //     · 状态里全是**时间窗口 / 每日计数 / 去重**（`day` / `dayCount` / `lastNotifiedAt`）⇒
  //       两机共享会互相压制告警（判据原文：「时间窗口 → 禁止同步」）。
  {
    name: 'notify-docsync.json', schemaVersion: null, persistence: 'persistent',
    retention: '单份（人工维护；`enabled:false` = 一条即停，不必删文件）',
    sync: false,
    syncWhy: '含**主人自己的外部通道收件人 userId + 机器人账号 id**（单机登录身份）—— 跨机同步等于把本机的收件人'
      + '带到对端，对端若没登同一个账号就会「发不出去还静默」；且 `enabled` 是**本机**的开关意图',
    loss: '丢失后脚本回落内置缺省（`enabled:true` 但 `account` / `to` 为空）⇒ **发送闸会拦下并记 `send-failed`**，'
      + '即「装了但发不出去」，**不会误发**；重建 = 按报告 §关回 那份 JSON 手抄一遍',
  },
  {
    name: 'notify-docsync-state.json', schemaVersion: 1, persistence: 'volatile',
    retention: '单份（每轮覆盖）：schemaVersion + lastNotified / lastNotifiedAt / day / dayCount + lastText / lastServerId',
    sync: false,
    syncWhy: '**纯时间窗口 + 每日计数 + 去重**（`lastNotified` 挡同一状态重发、`day`/`dayCount` 挡每日超发）'
      + '—— 两机共享会让对端拿本机的「今天已发 2 条」当自己的额度，A 机报过 down 之后 B 机就再也不吭声',
    loss: '丢失 = 下一轮重建空态（`lastNotified:null` / `dayCount:0`）⇒ **最坏多发一条**（重复一条「断了」），'
      + '不丢数据、不误判通道状态（判定真源是 tickd `state.json`，不是本文件）',
  },
  // ── 【2026-10-30 · 家庭保姆 46-B「outbox 超时告警」】新登：`butler-outbox-stale.json` ─────────────
  //   来由（registry-audit S4 现跑点出来的，不是"顺手补"）：tickd job `outbox-stale` 的去重状态文件
  //   一落到 `~/.dsh`，审计就报「磁盘有必须登记」⇒ 补登，判据照 `notify-docsync-state.json` 同款。
  {
    name: 'butler-outbox-stale.json', schemaVersion: 1, persistence: 'volatile',
    retention: '单份（每轮覆盖）：v + updatedAt + entries{<结果文件名>: firstSeenAt/lastNotifiedAt/notified}'
      + ' + lastRc / lastDelivery / day / dayCount / lastText',
    sync: false,
    syncWhy: '**纯时间窗口 + 每日计数 + 去重**（`entries` 挡"同一批结果 TTL 内重复喊"，`day`/`dayCount` 挡每日超发）'
      + '—— 两机共享会让对端拿本机的「今天已喊 6 条」当自己的额度（同 notify-docsync-state 款判据）',
    loss: '丢失 = 下一轮重建空态（entries 全空、dayCount 归零）⇒ **最坏对同一批结果多喊一次**，'
      + '不丢数据、不改判定（判定真源 = 只读检查器现跑 `git log` / mtime，与本文件无关）',
  },
  // ── 【2026-10-30 · 家庭保姆线「白名单写入口加固」B 项】新登：`family-allowlist-journal.jsonl` ────────
  //   来由（卡 81551bdf 验收时主会话指出，**不是** registry-audit 点出来的 —— S4 只在文件已落盘时才会喊，
  //   本文件当时还没生成过）：家人白名单的**变更台账**是"谁在什么时候改过白名单"的**唯一证据**，
  //   不登记 ⇒ 重建机器 / 换盘时这份账会悄悄丢（且丢的是不可重建的那一类）。
  //   写者 = 唯一写入口 `<宿主工具目录>\set-family-allowlist.mjs`
  //     （每写一次一行：add / remove / set / rollback / noop；含 beforeSha→afterSha、peer、drill、
  //       `allowEmpty`(闸 ⓪ 逃生口)、`unregistered`）。
  //   ⚠️ **按需生成**（不标 onDemand 就会当场吃 S5「登记有必须落盘」红）：2026-10-30 登记时实测
  //     `~\.dsh\family-allowlist-journal.jsonl` **盘上还没有**（= 还没真改过白名单）⇒ 判据同
  //     `butler-failure-delivery.json` 款：「不存在 = 从未写过 = 正常稳态」，首次真写即常驻。
  //   ⚠️ 跨仓派生链（本卡只登记、**不代打**）：`sync:false` ⇒ `gitignoreBlock()` 多一行
  //     `dsh/family-allowlist-journal.jsonl` ⇒ 仓1 工作副本 `.gitignore` 与 `dsh-backup-sync.ps1` 的
  //     `$ignore` 段要重生成（`node sync-ignore.mjs` / `node patch-backup-ignore.mjs`）。
  //     该派生链**改前就已是 ❌**（2026-10-30 21:50 实测：期望 214 行 / 实际 212 行 = 另有 2 行属于别的卡
  //     的欠账），故不在本卡里顺手重生成（会把别人那 2 行一起带进仓1）—— 已记进交付报告与债的现状行。
  {
    name: 'family-allowlist-journal.jsonl', schemaVersion: 1, persistence: 'persistent',
    onDemand: true,
    onDemandWhy: '白名单变更台账：**只在真写白名单时**创建（首条写入前不存在 = 还没改过名单 = 正常稳态）；'
      + '`--list` / dry-run / 闸拒动都不落盘（写者 = <宿主工具目录>\\set-family-allowlist.mjs）',
    retention: '永久（append-only：一条 = 一次 add/remove/set/rollback/noop），随写入线性增长、单文件目前 KB 级',
    sync: false,
    syncWhy: '台账记的是**本机写入口这一侧**的动作（localPath / peerPath / peer host / drill 标记 + 两机 sha 变化）'
      + '—— 两台机各写各的账；跨机同步会把"对端改的"混进"本机改的"，而它是「谁在什么时候改过白名单」'
      + '的唯一证据链，混了就答不出问题（同 butler-bypass-ledger.jsonl 款判据）',
    loss: '**不可重建**（"谁在什么时候改过白名单"这件事实只在这里）：丢它**不影响**白名单本身、不影响任何判定'
      + '（fail-open），但事后回溯/追责无据 ⇒ 换机重建时应连同 `_archive\\family-allowlist\\` 备份批次一起保',
  },
  // ── 【2026-11-02 · 卡 6f121702「统筹线·脑子」steward.mjs 甲层】新登：`steward-state.json` ──────────
  //   来由：统筹线的「脑子」（tickd job `steward`，每天 08:20 只读产物→排序→写账，零模型调用）的
  //   唯一持久状态。口径 = §2.3（内容已到 v0.5；出处不在本包内）。
  //   内容 = 六必填 + heartbeat / lastReport / decisions[] / instructions[] / raiseCounts[] / reports[]
  //          + 【2026-11-02 · 卡 C10】attentions[]（「等人工决定」的唯一来源，`{cardId, question, options[],
  //            askedAt, answeredAt}`；写入口 `steward.mjs --attention-add/--attention-answer`；
  //            `standup.mjs` 只认 answeredAt 为空的条目，卡面文本不再参与统计）。
  //   ⚠️ 三条判据要点（都是方案 §2.3 写死的）：
  //     ① **禁止跨机同步** —— 本文件带「同 id 二次 no-op 去重 + 上桌次数 + 心跳」时间窗口语义，
  //        双机共享会互相压制上桌计数；第一版单机 本机（方案 §1.4），三台各出一份晨报是预期行为。
  //     ② **写者只有一个** —— tickd job `steward`（人手工排障可直跑，靠锁 `steward` 互斥，登记在
  //        `lib\butler-locks.mjs` 的 LOCK_REGISTRY）；「嘴」会话**只读不写**。
  //     ③ retention 分两段 —— `decisions[]` **永久**（要能回答"当时为什么这么拍"）；
  //        `instructions[]` / `raiseCounts[]` / `reports[]` / 心跳**只留 30 天**（脚本自己按日裁剪）。
  {
    name: 'steward-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: 'decisions[] 永久（拍板理由可考）· attentions[] 永久（2026-11-02 C10 起：等人工决定的唯一来源，已答也留）'
      + '· instructions[] / raiseCounts[] / reports[] / heartbeat 只留 30 天（脚本按日裁剪）',
    sync: false,
    syncWhy: '带「同 id 二次 no-op 去重 + 上桌次数 + 心跳」三种时间窗口语义 ⇒ 双机共享会让对端拿本机的'
      + '「这条已上桌 2 次」当自己的计数，互相压制（本文件头部判据：带去重/冷却/时间窗口 ⇒ 禁同步）；'
      + '第一版单机 本机（方案 §1.4）',
    loss: '上桌计数与心跳归零 ⇒ 待拍板项「上桌过几次」回到 0、需重新累计（方案 §4.2 的黄标会晚 3 轮）；'
      + 'decisions[] 丢失 = 拍板理由不可考，只能从档/会话里翻回去',
  },
  // ── 【2026-11-02 · 卡 C12-A「Thread 与订阅数据面」】新登：`steward-threads.json` ──────────────
  //   来由：统筹线 C12 拆三段（A 地基 / B 扇出 / C 唤醒）的 **A 段产物** = "Thread 与 trigger_thread
  //   关系表"（架构精读 §A-5 把「Thread 对象」列为最贵那一步；出处不在本包内）。
  //   写者只有一个：`tools\dsh-butler\steward-threads.mjs`（new/bind/unbind 三个写动作，
  //   读侧 list/show 只读，对看板**只有一条 GET**）。
  //   形状：`{version:1, threads:[{id:'th-<8hex>', title, line, createdAt, cards:[], messages:[]}]}`；
  //   `messages[]` 在 B 卡落地前**恒为空数组**（本件只建不写）。
  //   🔧 **2026-11-02 · 卡 C12-B 订正**（只标注、不改上文）：`messages[]` 自 `--thread-post --apply` 起
  //      **会被追加投递记录**（形状 `{threadId, cardId, sessionId, title, at, ok, via, error?, text}`）；
  //      **干跑仍零写入**、其余五个动作仍不碰它（改动出处不在本包内）。
  //   ⚠️ 三条判据要点：
  //     ① **禁止跨机同步** —— 与 `steward-state.json` 同款：统筹线状态是**单机事实**（方案 §1.4 第一版
  //        单机 本机）；且「两机的 thread 撞了怎么合并」B/C 段才有扇出/写回口径，现在定不了
  //        ⇒ 先不同步，等 B 段给出跨机语义再改这一位（改这一位 = 走本表 + sync-ignore 重生成）。
  //     ② **按需生成** —— 首次 `--thread-new` 才建文件；稳态下没有这本文件属正常（故 onDemand）。
  //     ③ retention：`threads[]` 永久（一条线索的一生），**没有任何裁剪**（本件不删条目；
  //        thread 的生老病死留到 B 卡定，见交付报告「待定项」）。
  {
    name: 'steward-threads.json', schemaVersion: 1, persistence: 'persistent', onDemand: true,
    onDemandWhy: '首次 `--thread-new` 才落盘；没有线索时文件不存在是正常稳态（list/show 只读，不建文件）',
    retention: 'threads[] 永久（每本 = 一条线索的一生：标题 / 主线 / 卡绑定关系）；messages[] 本件恒空，B 卡写入后另定窗口',  // 🔧 2026-11-02 C12-B 订正：messages[] 现由 --thread-post --apply 追加（投递记录），仍**无裁剪**——窗口待定，见 C12-B 报告「待定项」
    sync: false,
    syncWhy: '与 steward-state.json 同款判据：统筹线状态是**单机事实**（方案 §1.4 第一版单机 本机）；'
      + '且「两机的 thread 撞了怎么合并」属 B/C 段（扇出/写回）才有的口径 ⇒ 现在同步 = 把未定义语义写进仓',
    loss: 'thread 与卡的绑定关系全丢（`--thread-show` 反查不到任何线索）⇒ 数据面可从看板卡面 + 交接档重建，'
      + '但"哪几张卡本来是一件事"要人工再判；本件无自动备份（B 卡起再说）',
  },
  // ── 【2026-11-02 · 卡 C12-D「Disposition 行流 + 两值副作用」】新登：`steward-disposition.jsonl` ──────
  //   来由：架构精读 §A-3/§A-4（出处不在本包内）—— 原型把「这条事件到哪了」记成
  //   **一张表、每 trigger 一行**（同时回答"为什么没处理 / 到了哪些卡 / 一生"）；我们的 `instructions[]`
  //   只回答"投给谁、accepted"，答不出"这条为什么没处理"。本文件就是那张表的**行流**。
  //   形状：每行一个 JSON 对象 `{at, kind, cardId?, reason, detail?, runId}`；
  //   `kind` ∈ `evaluated / filtered / ignored / fanned-out / blocked / failed`（六值封闭词表，
  //   其中 `fanned-out` 只留词表位置，甲层不产生）；`reason` 是机器读的原因码（表在
  //   `lib\disposition.mjs#REASON_CODES`，`detail` 才是给人看的那半）。
  //   写者只有一个：`tools\dsh-butler\steward.mjs` 甲层收尾（`runDisposition()`）；
  //   另有 `--disposition-add` 一个**人工 / 执行会话**补记入口、`--disposition-list` 只读入口。
  //   ⚠️ 三条判据要点：
  //     ① **只增不改** —— 写口只有单次 `fs.appendFileSync`；lib 里**没有** unlink / writeFileSync /
  //        truncate / `--clear`（夹具41 按源码验一条），改代码才可能破坏它。
  //     ② **禁止跨机同步** —— 与 `steward-state.json` 同款：统筹线状态是**单机事实**（方案 §1.4
  //        第一版单机 本机）；且「两机对同一张卡各记一行怎么合并」没有口径 ⇒ 现在同步 = 把未定义语义写进仓。
  //     ③ **按需生成** —— 首次甲层收尾（或 `--disposition-add`）才落盘；`--json` / `--no-write` /
  //        `--selftest` 一路零写入（`dispositionGate()` 是判据本体）⇒ "今天还没跑过"时不存在属正常。
  {
    name: 'steward-disposition.jsonl', schemaVersion: null, persistence: 'persistent', onDemand: true,
    onDemandWhy: '首次甲层收尾（或 `--disposition-add`）才落盘；`--json` / `--no-write` / `--selftest` / `--broadcast` '
      + '一路零写入，所以"今天还没跑过"时文件不存在属正常（行流是流水，不是常驻配置）',
    retention: '**只增不改、本版无自动裁剪**（append-only —— 卡 C12-D 明写"不许提供清空默认行为"）。'
      + '一天 ≈ 一行 / 待拍板卡（现约 470 张看板 ⇒ 实测几十行/天），按 ~200 B/行估每年 < 10 MB；'
      + '需要归档时人工 `Move-Item` 到 `_archive\\`（不是代码动作）',
    sync: false,
    syncWhy: '与 steward-state.json 同款判据：统筹线状态是**单机事实**（方案 §1.4 第一版单机 本机）；'
      + '且「两机对同一张卡各记一行怎么合并」没有口径 ⇒ 现在同步 = 把未定义语义写进仓',
    loss: '「这条为什么没处理 / 上了哪张桌 / 什么时候失败的」失去机器可读历史（只剩当天的 state.lastReport 快照 '
      + '+ 看板现状）⇒ **不影响任何判定**（行流只记录、不驱动动作），但事后回溯要人工翻会话与交付报告',
  },
  // ── 【2026-11-02 · 卡「统筹线 R1-6 · Router 守护与巡检」】新登：`router-guard-state.json` ──────
  //   来由：巡检器具 `tools\dsh-butler\router-guard.mjs`（tickd job `router-guard`，每 30 分钟）的
  //   自家状态件。口径 = §3 R1-6 行（出处不在本包内）。
  //   形状：`{version:1, updatedAt, lastRun:{at,apply,tally,workspaceId,currentSession}, alertMarks:{<sig>:<epochMs>}}`。
  //   用途只有一个：**报警去重**（同一条「站着的报警」6 小时内只落一行 `butler-alert.log`）；
  //   `lastRun` 是给人看「上一轮什么时候跑的、五项各是什么」的快照。
  //   ⚠️ 三条判据要点：
  //     ① **禁止跨机同步** —— 记的是**本机**的 Router 会话 uuid / 工作区 id / 报警去重时钟，
  //        对端读过去只会把本机的"这条刚报过"当成自己的 ⇒ 与本表 `steward-state.json` 同款判据（单机事实）。
  //     ② **本件不驱动任何判定** —— 丢它 = 去重窗口归零（下一轮把站着的报警再落一遍）+ 少一份快照；
  //        **不影响**任何复位动作（五项判据全现读，从不读本文件）。
  //     ③ 无 schemaVersion 迁移负担（本件只写 `version:1`，读侧缺字段一律走默认值）；`alertMarks` 自动裁剪 7 天。
  {
    name: 'router-guard-state.json', schemaVersion: 1, persistence: 'persistent',
    retention: 'alertMarks 只留 7 天（脚本按 now-7d 裁剪）· lastRun 只留最后一次（整份覆盖写）· 无历史堆积',
    sync: false,
    syncWhy: '记的是**本机** Router 工作区 id 与会话 uuid + 报警去重时钟（带去重时间窗口语义）⇒ '
      + '双机共享会让对端把本机"这条刚报过"当自己的、把对端的 Router 会话 uuid 当本机的（本文件头部判据：'
      + '带去重/冷却/时间窗口 ⇒ 禁同步）；且三台各有一间 Router ⇒ 各报各的（方案 §1.4 第一版单机）',
    loss: '报警去重窗口归零（下一轮会把"站着的报警"再落一遍，属噪音不属误判）+ 少一份上一轮快照；'
      + '**不影响任何复位动作**（五项判据全现读，从不读本文件）⇒ 可随手删掉重建',
  },
  // ── 【2026-11-02 · 卡「统筹线 R1-6」顺手订正】补登：`router-ops.jsonl` ────────────────────────
  //   🔴 为什么这行是"补登"而不是"新登"：该文件由 **R1-5**（`router-act.mjs` 的动作流水）落盘，
  //      当时漏了本表 ⇒ `butler-registry-audit` 的 **S4「磁盘有必须登记」当场报红**
  //      （2026-11-02 21:20 本卡跑审计时实测：`❌ [state-file] router-ops.jsonl`）。
  //      本卡只补登记位、**不动 R1-5 的任何代码与行为**。
  //   形状：每行一个 JSON 对象（`router-act.mjs#appendOps` 写；动词 `say` / `wake` / `card-show` 各记一条）。
  //   ⚠️ 三条判据要点：
  //     ① **只增不改** —— 写口只有 `fs.appendFileSync` 一行（`router-act.mjs#appendOps`）；
  //        没有清空/重写入口（要归档就人工 `Move-Item` 到 `_archive\`）。
  //     ② **禁止跨机同步** —— 记的是"本机 Router 会话里发生过什么动作"，是单机事实；
  //        两机对同一张卡各记一行怎么合并没有口径 ⇒ 与本表 `steward-state.json` 同款判据。
  //     ③ **按需生成** —— 只有第一次真动作（`--apply` 的 say/wake）才建文件；只读动词零写入 ⇒
  //        "从没动过手"时文件不存在属正常（故 onDemand）。
  {
    name: 'router-ops.jsonl', schemaVersion: null, persistence: 'persistent', onDemand: true,
    onDemandWhy: '只有第一次真动作（`router-act.mjs` 的 say / wake 带 `--apply`）才落盘；`status` / `brief` / '
      + '`card-show` 三个只读动词一路零写入 ⇒ "从没动过手"时文件不存在属正常（动作流水，不是常驻配置）',
    retention: '**只增不改、无自动裁剪**（append-only；按动作计一行，一天顶多几条到几十条，~300 B/行）；'
      + '需要归档时人工 `Move-Item` 到 `_archive\\`（不是代码动作）',
    sync: false,
    syncWhy: '与 `steward-state.json` 同款判据：记的是"本机 Router 会话里发生过什么动作"（单机事实）；'
      + '两机对同一张卡各记一行怎么合并没有口径 ⇒ 现在同步 = 把未定义语义写进仓',
    loss: '「Router 什么时候、替谁、说过什么 / 叫醒过谁」失去机器可读历史 ⇒ **不影响任何判定**'
      + '（流水只记录、不驱动动作），但事后回溯要人工翻会话与交付报告',
  },
  // ── 【2026-11-09 · 卡「N1 催办判据」】两档：`router-status-snapshot.json` + `router-nudge-state.json` ──
  //    口径 = §N1（L283-297）+ 对应交付报告（出处不在本包内）。
  //    🔴 为什么要这两档：N1 把「催」从"回合里想起来"改成机械判据 —— 判据要读**车况快照**（不每轮现算
  //      `router-act status`，2.3~3.1 s/次），催过没催过要**落盘**（内存里的限流重启就忘）。
  //    写口各一个：快照只由 `router-status-snapshot.mjs`（tickd job `router-status-snapshot`，默认关）写；
  //      限流账只由 `router-nudge.mjs --apply` 写（干跑零写入）。
  {
    name: 'router-status-snapshot.json', schemaVersion: 1, persistence: 'volatile', onDemand: true,
    onDemandWhy: '只有刷新器真跑过一次（`router-status-snapshot.mjs --apply`，或该 tickd job 已放行）才存在；'
      + 'job 默认关 ⇒ 没放行时不存在属正常（读侧会显示「❓未知」而不是拿旧数据当现状）',
    retention: '单文件覆盖（`writeJsonAtomic`），每 10 分钟一份、不堆积；`judgedAt` 就是"这份判断是几点做的"',
    sync: false,
    syncWhy: '快照搬的是**本机**看板 lines[] 与**本机**卡面白名单；两台机的看板/主线各是各的 ⇒ '
      + '同步过去等于把对端的车况当本机现状（正是 N1 要消灭的"拿旧/别人的数据当现在"）',
    loss: '丢掉 ⇒ 读侧显示「❓未知（快照读不到）」，下一轮刷新自愈；**不丢任何历史**（产物计数随时可重算）',
  },
  {
    name: 'router-nudge-state.json', schemaVersion: 1, persistence: 'persistent', onDemand: true,
    onDemandWhy: '只有 `router-nudge.mjs --apply` 真投过话/写过 digest 才建文件；干跑与"没候选"都零写入',
    retention: '单文件覆盖（`writeJsonAtomic`）；`history` 只留最近 50 条；`day` 按**北京日期**切日'
      + '（🔴 不用 UTC —— 历史踩过「按 UTC 切日造出假矛盾」）',
    sync: false,
    syncWhy: '限流额度是**这台机 Router 的投话额度**（同线 12h 冷却 + 每天 ≤5 条）：两台机共享一份账会'
      + '互相吃掉对方额度、且对端根本没有这条线的会话可投 ⇒ 口径必错',
    loss: '丢掉 ⇒ 冷却与当日计数归零（最坏后果 = 多催一条，可容忍；**不会漏催、不下发任何消息**）',
  },
  // ── 【2026-11-03 · S6 期 1c · 卡 59ba654f】router 派生**单文件 fail 状态**（方案 §3.8 ① 的规定形状）
  //    判据出处：「新增状态文件必须在此登记，否则 sync-ignore --check 报未登记」（本文件头注释）。
  //    落点 `~/.dsh/router-derive-fail.json`；读/写/删都在 `tools/gen-presets.mjs`
  //    （`recordRouterFail()` / `readRouterFail()` / `clearRouterFail()`），**不落 `<workspace>/logs`**（junction 跟删风险）。
  {
    name: 'router-derive-fail.json', schemaVersion: 1, persistence: 'volatile',
    retention: '单文件覆盖（成功一次即删）；不轮转、不按时间戳堆积',
    sync: false, syncWhy: '派生成败属单机时间窗口状态（firstFailedAt 计时），双机共享会互相压制/提前触发升级',
    loss: '丢失 ⇒ 24h 升级计时归零（下次失败重新起算）；派生出件本身不受影响',
    onDemand: true,
    onDemandWhy: '只在「派生被拒」时存在；成功即删 ⇒ 稳态下不存在属正常（不是漏写）',
  },
  // ── 【2026-11-06 · 卡「Router 静默收信」】四条：`router-inbox` 系列的档 ─────────────────────
  //    口径 = §4.2（四档 + 两缓存；出处不在本包内）。
  //    🔴 为什么必须登记：这四个档由本卡新建，`butler-registry-audit` 的 S4「磁盘有必须登记」当场报红
  //       （2026-11-06 施工时实测：`❌ router-inbox.jsonl` / `❌ router-inbox-target.json` 两条）。
  //       写法与 `router-ops.jsonl` 同款：**只登记位、不改任何写入行为**。
  //    ⚠️ 四条一律 `sync: false`：主档记的是"本机各线往本机 Router 汇报了什么"，认领游标与限流计数
  //       都是**单机时间窗口**（双机共享会让对端把本机的"刚投过"当成自己的 ⇒ 互相压制告警）。
  {
    name: 'router-inbox.jsonl', schemaVersion: null, persistence: 'persistent', onDemand: true,
    onDemandWhy: '只有第一条静默来信落盘才建文件；通道关着、或从没线用过 `--silent` 时不存在属正常',
    retention: '**只追加**；唯一切档时整份重写一次（`rotate` 只搬「已认领」的行到 `router-inbox-<YYYYMM>-<NN>.jsonl`）；'
      + '归档档**只读、永不删**（Non-goal）',
    sync: false,
    syncWhy: '记的是"这台机的各线往这台机 Router 汇报了什么"——单机事实；两台机各有一间 Router（不同会话、'
      + '各自的认领游标），双机共享会把对端的信算成本机未认领 ⇒ 主档与游标必须同机',
    loss: '未认领的机械汇报丢失 ⇒ 只影响下一批「静默批」摘要（各线原始结论/回执仍在它们自己的会话与报告里；'
      + '且 push 失败会 rc 1/7 退回实时投递，不静默吞）',
  },
  {
    name: 'router-inbox-state.json', schemaVersion: 1, persistence: 'persistent', onDemand: true,
    onDemandWhy: '只被 `claim` / `unclaim` 写；从没认领过时不存在属正常（渲染侧把"没有游标"当"全部未认领"）',
    retention: '单文件覆盖（`writeJsonAtomic`）；不堆积',
    sync: false,
    syncWhy: '认领游标绑定**本机**主档的行序（主档不同步）⇒ 游标单独同步毫无意义且会让对端跳过自己的未读',
    loss: '游标归零 ⇒ 全部历史重新算未认领（槽位会出现一大批、下一批静默批会重投一次摘要）—— **不丢信**，只重看',
  },
  {
    name: 'router-inbox-flush.json', schemaVersion: 1, persistence: 'volatile', onDemand: true,
    onDemandWhy: '只有真投过一批静默批才建文件；从没投过时不存在属正常',
    retention: '单文件覆盖；`day` / `hour` 是本地时间窗口键（跨零点/跨小时自动重置计数）',
    sync: false,
    syncWhy: '日/时批次计数与「同一批 30 分钟内不重投」都是**时间窗口 + 冷却**语义（本文件头部判据第 2 条）⇒ 禁同步',
    loss: '额度计数归零 ⇒ 当天可能多投几批；`lastFlush` 丢失会让同一批再提醒一次（也是"宁可重看"）—— 不影响信本身',
  },
  {
    name: 'router-inbox-target.json', schemaVersion: null, persistence: 'volatile',
    retention: '单文件覆盖；超 7 天自动作废（届时现查 `session.list` 重判并重写）',
    sync: false,
    syncWhy: '缓存的是**本机** Router 会话的 sid 与标题（会话 uuid 天然按机不同）⇒ 同步只会把对端的会话 id 写进本机',
    loss: '丢失 ⇒ 下一次 push 现查 `session.list` 重新判 Router（判不出就 rc 6 退回实时投递）—— 不影响信',
  },
  // ⚠️ 方案 §3.8 ② 的**边界**（如实写清，不是遗漏）：`base.md` / `drop.md`
  //    （`<workspace>/tools/presets-src/router/`）**填不进这张表** —— 本表 `name` 是**相对 `~/.dsh`** 的路径
  //    （见上面 `@property {string} name` 注释），而这两个件在 `<workspace>/tools` 下 ⇒ **不在管辖域**。
  //    🔴 不许为了让「看起来齐」造一行假登记：登记表 name 语义一变，sync-ignore 生成的 .gitignore 就会排错东西。
  //    替代处置（方案 §3.8 ③ 的托管方案，已实现）：每次派生在
  //    `_archive/router-derive-snapshots/<ts>/manifest.json` 里留 `src.base` / `src.drop` 的 sha256 + 字节数 + 字数
  //    ⇒ 「出事能回看改过什么」，同时也是 `--check-stale` 的「上一版」。
  //    （`tools/` 无版本控制的长期收口 = 技术债台账 TD-42，仍需主人拍一个私有仓位置。）
  // ── 【2026-11-04 · 卡「统筹线 P1-b 写者与建线」】`mainline-ledger/`（主线流水小本本）───────────
  //    判据出处 = 方案 V9 §5.1 末行「状态文件登记」：**必须**加进本表（E15），否则
  //      `sync-ignore --check` 报"未登记"。**只登一条目录项、不逐文件** —— 主账文件名是
  //      `<lineId>-<YYYYMM>.jsonl`（动态名：lineId 按 host 前缀递增、月份按月滚动），
  //      逐文件登记必然漏（§5.1 写死的那句"不逐文件登记"）。
  //    目录内形状：`_meta.json`（schemaVersion:1）· `<lineId>-<YYYYMM>.jsonl`（append-only 主账）·
  //      `_lines.json`（建线/别名/ledgerSince，整文件写）· `_ops\<lineId>-<YYYYMM>.jsonl`（运维行）·
  //      `_sids\<lineId>.jsonl`（会话认领表）· `<host>-unmapped.jsonl`（未归线队列）。
  //    ⚠️ 唯一写口 = `tools\dsh-butler\lib\mainline-ledger-writer.mjs`（不变量 2）；读端零写盘。
  //    ⚠️ 目录型条目（name 以 `/` 结尾）不在 registry-audit 的 S5「登记有必须落盘」断言内
  //      ⇒ 本卡**不建真账本**（接线后才首跑 `ensureHome`）不会在本机报"登记有但磁盘没有"。
  {
    name: 'mainline-ledger/', schemaVersion: null, persistence: 'persistent',
    retention: '**只增不删**（按月分文件、无轮转动作）；人可手动归档老月份，器具不自动删',
    sync: false,
    syncWhy: '每个 jsonl 都带本机会话 sid，跨机同步会把三台互相认成自己的账',
    loss: '判活/漂移/催办全部退化成"只看卡状态"（可接受降级，不崩）；读端一律 fail-closed 报「流水缺」，'
      + '绝不报"很勤快"',
  },
];

/**
 * 不随仓1 同步、且不适用 schemaVersion 豁免的既有外部文件（仅登记，不生成 .gitignore）。
 *
 * ── 【2026-09-21 · 小护士 P2-A · G12 登记】为什么护士面登记在**这里**而不是 `STATE_FILES` ──
 *   `STATE_FILES` 的 `name` 语义是「**`~/.dsh` 下**相对路径」，`gitignoreBlock()` 会逐条输出
 *   `dsh/<name>` 并驱动「仓1 工作副本 `.gitignore` + `dsh-backup-sync.ps1` 的 `$ignore` 段」三处逐字一致
 *   （`sync-ignore --check` / `verify-gitignore` 会验）。而护士的实体**根本不在 `~/.dsh` 下**：
 *     · `%USERPROFILE%\.dsh-safe\**` 与 `~/.dsh` **平级**（方案 §4.1 的隔离设计）；
 *     · 写前备份落 `<workspace>\_archive\nurse-case-*`（`_archive` 三仓都不收，方案 §12.1 / E8）。
 *   ⇒ 若登记进 `STATE_FILES`，`gitignoreBlock()` 会吐出 `dsh/.dsh-safe/` 这种**仓1 里不存在的路径**
 *     （语义错误且白占排除行），还会把"排除段条数 = syncExcluded 条数"这类既有不变量拖着一起改。
 *   本表定义正是「不随仓1 同步的既有外部文件（仅登记，不生成 .gitignore）」⇒ 落点即此。
 *   字段口径（逐文件填齐，G12 要求的五项）：persistence / retention / schemaVersion / loss / **sync=false**。
 *
 *   `kind` 与 `note` 是本次为护士面新增的**可选**字段（既有两条不填也照跑）：
 *   `kind:'nurse'` 供单测与面板按面过滤。
 */
export const EXTERNAL_STATE = [
  { name: '%TEMP%/dsh-guard/restart-request.json', persistence: 'volatile', schemaVersion: 1, note: '易失（可重建），24h 过期' },
  { name: '%TEMP%/dsh-guard/guard-state.json', persistence: 'exempt', schemaVersion: 'exempt', note: '守护鱼自己写，不适用"无版本即拒启"，大管家只读不写' },
  // ── 小护士（安全模式修复层）状态面 · 8 条 · G12 ────────────────────────────────────────────
  {
    kind: 'nurse', name: '%USERPROFILE%/.dsh-safe/', persistence: 'persistent', schemaVersion: null, sync: false,
    retention: 'case-* 目录 **7 天**（`tools\\dsh-nurse\\retention.mjs`，tickd job `nurse-retention`，**默认 dry-run**）；'
      + '`nurse-profile.json` / `profiles/nurse/` 永久（重建 = 跑 make-nurse-profile.mjs，勿删）',
    loss: '整个安全模式层不可用：**出事时小护士起不来**（bootstrap 拒启）⇒ 复建 = `make-nurse-profile.mjs`（P1 已预建，别等出事那天）',
    syncWhy: '隔离 home 单机事实（DSH_HOME 指向它、含实例 pid 与故障现场）—— 跨机同步会把"对端的现场/实例记录"当成自己的（同 butler-autonomy-state 款判据）',
  },
  {
    kind: 'nurse', name: '%USERPROFILE%/.dsh-safe/case-<ts>/state.json', persistence: 'persistent', schemaVersion: 1, sync: false,
    retention: '随 case 目录 7 天（同上）；**写盘前脱敏**（绝对用户路径 → `<home>`，2026-09-21 P2-A 起）',
    loss: '该 case 的半完成态兜底（T7/G9）失去依据 ⇒ 编排器认不出"上次没干完"，可能在同一现场上叠新动作（**必须靠 status 人工核**）',
    syncWhy: 'case 是**本机单机事实**（崩溃现场 + 处置进度 + 预算/时间轴），跨机共享会让对端把本机 case 当成自己的半完成态而拒启',
  },
  {
    kind: 'nurse', name: '%USERPROFILE%/.dsh-safe/case-<ts>/takeover.json', persistence: 'volatile', schemaVersion: 1, sync: false,
    retention: '**TTL 30 分钟**（判据真源 `lib\\lane-gate.mjs` 的 `TAKEOVER_TTL_MS`；**2026-09-21 P2-B 已由 2h 收紧** = 2×预算）；⑤.5 收尾时删除；超期残留由 `lib\\residue-reaper.mjs` 三层挂点真释放',
    loss: '丢失 = 修复窗口内 guard **不再被拦**（可拉起生产）⇒ 与修复动作并发（T2 竞态回归）；被强杀时同样残留（靠 TTL 自愈 + `residue-reaper` 分钟级收敛）',
    syncWhy: '接管声明是**单机互斥**凭据（本机的 guard 读本机的窗口），跨机同步 = 对端按本机的修复窗口停手（假接管）',
  },
  {
    kind: 'nurse', name: '%USERPROFILE%/.dsh-safe/case-<ts>/manifest.json', persistence: 'persistent', schemaVersion: 1, sync: false,
    retention: '随 case 目录 7 天',
    loss: '现场包"采了什么/缺了什么"台账丢失（V8 报告字段与 V3 演练的判据源）⇒ 诊断只能靠残存分节',
    syncWhy: '现场包含本机日志/进程/端口/会话指针（单机现场），跨机同步无意义且泄露面变大',
  },
  {
    kind: 'nurse', name: '%USERPROFILE%/.dsh-safe/case-<ts>/before|after|evidence/', persistence: 'persistent', schemaVersion: null, sync: false,
    retention: '随 case 目录 7 天（**删了不可逆**，故 retention job 默认 dry-run）',
    loss: '该 case 的**回滚能力丢失**（写前副本没了两处都拿不回来）⇒ 只能靠 `<workspace>\\_archive\\nurse-case-*` 的同类副本',
    syncWhy: '回滚副本是单机时间点数据（体积大、含生产文件内容），三仓不收（同 `_archive` 款判据）',
  },
  {
    kind: 'nurse', name: '%USERPROFILE%/.dsh-safe/nurse-instance.json', persistence: 'volatile', schemaVersion: 1, sync: false,
    retention: '单份（每次 start 覆盖；stop 后清理）',
    loss: 'stop 的**pid 凭据**缺失 ⇒ 退化为命令行形态判定（`--profile nurse --port 3091`）；判不出则**拒停**（fail-closed，绝不误杀生产）',
    syncWhy: '实例 pid / 端口是本机进程事实，跨机同步会把对端 pid 当本机进程（同 `%TEMP%/dsh-guard/*` 款）',
  },
  {
    kind: 'nurse', name: '%USERPROFILE%/.dsh-safe/nurse-profile.json', persistence: 'persistent', schemaVersion: null, sync: false,
    retention: '永久（重建 = make-nurse-profile.mjs 幂等构建）',
    loss: '安全 profile 的"由谁派生成、摘掉了哪些自研插件"取证丢失（**不阻断**：profile 实体在 `profiles/nurse/`）',
    syncWhy: 'profile 声明描述的是**本机生产 profile 的快照**（派生来源 + 摘除清单），跨机读会拿到对端的派生关系',
  },
  {
    kind: 'nurse', name: '%USERPROFILE%/.dsh-safe/logs/dsh-nurse-<ts>.log', persistence: 'volatile', schemaVersion: null, sync: false,
    retention: '不自动清理（随 check 人工清；体积小）',
    loss: '安全实例的启动/崩溃日志丢失（排障降级：只能看 case 现场包里的进程/端口快照）',
    syncWhy: '本机实例日志（含本机路径/进程事实），跨机无意义',
  },
  {
    kind: 'nurse', name: 'REPAIR_FAILED 标记（**无独立文件**）', persistence: 'exempt', schemaVersion: 'exempt', sync: false,
    retention: '随 `case-<ts>/state.json`（`phase:"failed"` 即冻结现场；G6 禁循环重试）',
    loss: '不适用（无实体）：判据读 `state.json#phase`；该文件丢失的后果见上面 state.json 那条',
    syncWhy: '与 state.json 同款（单机现场）',
  },
  // ─────────────────────────────────────────────────────────────────────────────
  // 【明确**不登记**的项 · 判定 + 理由（2026-10-10 卡「冲刺600·补核心库」gap-1-56）】
  //   `butler-sync-state.json`（P9 v2.5 方案里的「活跃机 / 心跳，云中继用」）
  //   判定 = **暂不登记（未落地的设计件）**，三条实测依据：
  //     ① 磁盘上不存在：`Test-Path ~/.dsh/butler-sync-state.json` = **False**（2026-10-10 实测）；
  //     ② **全库代码零引用**：`grep -r butler-sync-state tools/` 零命中 —— 唯一出现处是设计文档
  //        内部 v2.5 方案 §6.5 表格与缺口台账（出处不在本包内），
  //        **没有任何 .mjs 读或写它**；
  //     ③ 它的唯一消费场景 = **云中继 H5**，而 H5 **未开工**
  //        （四组汇总的必拍清单：「H5（云中继）…没开工」；出处不在本包内）。
  //   为什么不"先登记声明期望"：本表的 `persistence / sync / loss` 三列必须对得上**真实读写点**；
  //     登记一个零读写点的文件会把「登记 ↔ 磁盘 ↔ 代码」三角关系做成假的（S4 反向断言也照不出它）。
  //   重启条件（触发式）：**H5 开工并真落盘后**，在**同一张卡**里补进 `STATE_FILES`
  //     （形态照 v2.5 方案 §6.5 表格：schemaVersion=1 / persistence=volatile / sync=false / 「时间窗口」）。
  //   —— 另一条不登记项（`butler-tidy-ledger.jsonl`）已在缺口台账标注「等 L2 真跑后再登」，同此处置。
  // ── 2026-11-05 · 卡「记忆引擎第 4 期 · 路 B+」新增一条（**目录级**）────────────────────
  //   判据源：方案 §3.3 / §7.1 R5（正文落点**故意**在 home 外）+ §12.5 新增状态文件清单——
  //     那张表已把归档的「跨机」写成 **否**；本条目 = 那条的目录级实名登记（面板/报告按面过滤用）。
  //   为什么登记在 EXTERNAL_STATE 而不在 STATE_FILES：STATE_FILES 的口径是 `<home>` 内的状态文件，
  //     而本目录**必须在 home 外**（在 home 内 = 每 30 分钟进快照、每天 scp 出机）。
  {
    kind: 'memory',
    name: '<workspace>/_archive/memory-removed/plugin/<stamp>/<memId>-<hash12>.json',
    persistence: 'persistent',
    schemaVersion: 1,
    sync: false,
    retention: '永久（**不自动删** —— 人的记忆不该过期；保留期见方案 §9 D-7「超 N 年人工归档到冷盘」，未定）',
    loss: '🔴 **真损失**：该条记忆的正文永久消失（删了就这一份、无第二份；库里只剩一个 id 空洞）',
    syncWhy: '**故意**不放 `<home>/memory/removed/`：那目录在 `dsh-snapshot-tick.mjs` 的 INCLUDE_DIRS 里'
      + '（30 分钟一采、每天 scp 到 对端机、远端留 7 天）⇒ 台账不出机、正文反而每天出机 = 红线。'
      + '`_archive` 不在快照白名单、不在任何跨机采集面（`collect-manifest.json` 的 excluded 有声明）'
      + '⇒ 跨机只传台账（hash + 指针）',
  },
];

/** 禁止随仓1同步的项（方案 §6.5 判据：时间窗口 / 冷却 / 去重 / 锁）。 */
export function syncExcluded() {
  return STATE_FILES.filter((f) => f.sync === false);
}/**
 * 【G12 · 2026-09-21 P2-A】护士面（小护士安全模式层）登记条目 —— 逐文件 persisted / retention /
 *   schemaVersion / 丢失后果 / 跨机同步=否。供单测、面板、报告按面过滤（`kind:'nurse'`）。
 */
export function nurseStateSpecs() {
  return EXTERNAL_STATE.filter((f) => f.kind === 'nurse');
}

/** 外部状态文件规格（`EXTERNAL_STATE`；未登记返回 undefined —— 调用方必须显式处理，不猜）。 */
export function externalSpecOf(name) {
  const norm = String(name ?? '').replace(/\\/g, '/');
  return EXTERNAL_STATE.find((f) => String(f.name).replace(/\\/g, '/') === norm);
}

/** 允许随仓1同步的项（供备份脚本白名单参考）。 */
export function syncAllowed() {
  return STATE_FILES.filter((f) => f.sync === true);
}

/**
 * 【⑤-6 · 占位展开】把登记名里的 `<host>` 占位换成调用方要的形态。
 * 为什么需要它：本表是**跨机共享代码**，名字里带本机短码的文件一律写 `<host>` 占位
 *   （照 `external-sources-<host>.json` / `secretary-usage-<host>.jsonl` 先例）；但下游两处要的是**可用的路径**：
 *   · `.gitignore` 段 —— 字面 `<host>` 既不是真实文件名、也不是通配 ⇒ **那行等于没写**（静默失效）；
 *   · 造真实文件复核（`_test\verify-gitignore.mjs`）—— Windows 文件名不许含 `<>`（会 ENOENT）。
 * ⇒ 唯一展开点在本函数，消费方一律经它取名（别再各自 replace）。
 * @param {string} name 登记名（可能含 `<host>` 占位）
 * @param {string} host 替换值：默认 `'*'`（.gitignore 通配）；造真实文件时传具体主机短码
 * @returns {string}
 */
export function expandHostPlaceholder(name, host = '*') {
  return String(name).split('<host>').join(host);
}

/**
 * 【2026-10-22 · 卡「V3 功能面·两小件 R-044」】一个登记名在 `.gitignore` 段里要写出的**全部行名**。
 *
 * 为什么必须两行：2c 状态名迁移（真源 `lib\state-paths.mjs` 的 `NEW_PREFIX='ops-'` / `toNewName()`）
 *   把 `butler-X` → `ops-X`；读侧 `resolveStatePath()` 在 `new` / `dual` 期**落新名**，
 *   `legacy` 期仍落旧名 ⇒ 只写旧名 = 新件裸奔，只写新名 = 老件裸奔。
 *   2026-10-22 现跑实测：`~\.dsh` 顶层 45 个 `ops-*`，而排除段一条 `ops-` 都没有
 *   （旧 `--check` 是「同一张登记表对同一张表」⇒ 结构上永远绿，发现不了）。
 *
 * 映射不写死前缀：一律走 `state-paths.mjs#toNewName()`（改名逻辑再变，这里自动跟随）。
 * 非 `butler-` 名（`upgrade-lock` / `secretary-push.jsonl` / `channel-hub/` 等）原样返回一条。
 * @param {string} name 登记名（可含 `<host>` 占位；调用方自行决定展开时点）
 * @returns {string[]} `[旧名, 新名]` 或 `[原样名]`
 */
export function gitignoreNames(name) {
  const legacy = String(name).replace(/\\/g, '/');
  const fresh = toNewName(legacy);
  return fresh === legacy ? [legacy] : [legacy, fresh];
}

/** 生成 .gitignore 排除段（纯 ASCII 注释：dsh-backup-sync.ps1 用 ascii 编码重写，中文会变 ?）。 */
export function gitignoreBlock() {
  const lines = [
    '# ---- dsh-butler single-machine runtime state: NEVER sync via repo1 (dsh-core) ----',
    '# criterion (butler v2 plan 6.5): time-window / cooldown / dedupe / lock -> not syncable;',
    '# syncing them makes two machines suppress each other alerts and auto-actions.',
    '# generator: <workspace>\\tools\\dsh-butler\\sync-ignore.mjs (--check to verify, no writes)',
    '# 2c rename: every butler-X is emitted TWICE (butler-X + ops-X) -- read side',
    '#   (lib/state-paths.mjs) writes the new name during new/dual, the old name during legacy;',
    '#   covering only one spelling leaves the other exposed. mapping = state-paths.mjs#toNewName.',
  ];
  for (const f of syncExcluded()) {
    if (f.gitignoreNote) lines.push(...f.gitignoreNote);
    // ⚠️ `<host>` 占位必须展开为 `*`（否则该行字面无效 = 静默失效）；判据与理由见 expandHostPlaceholder()
    // ⚠️ 旧名 + 新名两行都写（R-044）：判据见 gitignoreNames()
    for (const n of gitignoreNames(expandHostPlaceholder(f.name))) lines.push(`${REPO1_DSH_PREFIX}${n}`);
  }
  lines.push('# ---- end dsh-butler ignore block ----');
  return lines;
}

/** 单个状态的规格（未登记返回 undefined —— 调用方必须显式处理，不猜）。 */
export function specOf(name) {
  const norm = String(name).replace(/\\/g, '/').replace(/^dsh\//, '');
  return STATE_FILES.find((f) => f.name === norm);
}
