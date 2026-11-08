# 变更记录

## 0.4.0 · 2026-11-09

**作业脚本进来了**（`jobs/`，可选附带品）。调度内核、锁、审计、自主矩阵的行为不变。

- **新增 `jobs/` 目录**：30 个作业脚本，覆盖 `JOBS` 表里 **41 条作业**。0.3.x 的缺口是
  「作业表 77 条、包里只有 3 个脚本」⇒ 装完看到满屏作业、一条也跑不起来。
  逐条清单、每件吃什么环境变量、以及**哪两个脚本刻意没带**见 `jobs/README.md`。
- **三级解析**（新增 `resolveJobEntry`，`butler-tickd.mjs` 里是单一判定点）：
  ① `<包根>/jobs/` ② 环境变量 `BUTLER_JOBS_DIR` ③ `job.dir`（内核自带）；
  都没有 ⇒ 记 `skipped-missing-src` —— **不发红**：不涨 `failures`、不进 `last-error`、不抢锁、不 spawn。
  `--list` 每行标了入口来源（`[jobs]` / `[host-dir]` / `[pkg-dir]` / `[缺脚本]`），
  `--status` 的 job 记录里多了 `lastEntrySource`。
- **判据一处放宽（有据）**：`lib/tickd-health.mjs#BENIGN_STATUSES` 与
  `lib/board-cleanup.mjs` 的"失败状态"白名单都加上了 `skipped-missing-src` ——
  "没装这件东西"和"这件东西坏了"必须分开，否则默认不附带脚本会变成一片红。
- **`queue-wake.mjs` 挪进内核位置**（`lib/queue-wake.mjs`）：`queue-watch` 一直在懒加载
  `./queue-wake.mjs`，而 0.3.x 的包里没有这个文件 ⇒ 那一段静默降级。属修既有缺口。
- **新增口径件 `jobs/lib/ws-root.mjs`**：工作区根 / 盘外副本根 / 快照文件名前缀 / 设备名标签正则的
  单点定义（`DSH_WORKSPACE` / `DSH_GITBACKUP_ROOT` / `DSH_SNAPSHOT_PREFIX` / `DSH_HOST_TOKENS`），
  换机器不必改源码。
- **`dsh-butler-watch` 的第四路通道抽成中性注入点**：原来的字段名叫某个具体通道，
  现在统一成 `external`（`deliver.external` / `channel.external.enabled`）。
  本包不提供实现 ⇒ 状态恒为「外部通道未注入（默认关）」，要接就把这两段补进你自己的 `watch-notify`。
- **脱敏**：作业脚本按「非通道 / 非家人 / 非生活侧」口径筛过；盘符、机名、真名、主线名一律
  参数化或占位化，宽词表（纯子串）**0 命中**。
- **判据**：仓内 `npm test` 全过；全 `jobs/` `node --check` 0 失败；脱敏扫描 `review=0`。

## 0.3.1 · 2026-11-08

**只动文案与注释，行为一字不变**（补 0.3.0 的脱敏收尾）。

- 三份文档里"我们不附带哪些通道"的口径段改中性说法（不再点具体产品名），**声明照样在、边界更清楚**：
  `README.md` · `CHANGELOG.md` · `docs/架构一页.md`。
- 两处源码注释不再写内部通道脚本的文件名/路径，改成"宿主侧的通道脚本（不进本包）"：
  `butler-tickd.mjs` · `lib/butler-locks.mjs`。
- 自测夹具里的绝对路径样本改成运行时拼接构造（字符串一模一样，`review=0`），
  避免 `package.json` 的 `files` 把字面量盘符路径打进公开包。
- 判据：仓内 `npm test` 全过；脱敏扫描 `review=0`；宽词表（纯子串）品牌名/机名/真名 **0 命中**。

## 0.3.0 · 2026-11-08

**交接 / 跨机同步这一面进来了**（四个 CLI + 一套宿主环境口径）。调度内核与日报巡检的行为不变。

- **新增四个命令**（都默认 dry-run，先看计划再 `--apply`）：
  - `butler-handoff`：手动交接器 —— `--status` 体检 / `--depart` 交出本机状态 / `--arrive` 接收对端状态
    （Arrive 分发前过对偶门：目标文件当前 hash ≠ 上次基线就跳过 + 告警）。
  - `butler-cold-handoff`：冷接机 —— DSH 已停 + 写者已冻结的窗口里做跨机语义合并（坑库 / 记忆库）。
  - `butler-text-sync`：跨机文本同步（文档 / 预设；经三仓工作副本，带推前超集体检）。
  - `butler-text-sync-direct`：不经仓的直连文本同步（ssh 传包；默认 dry-run、永不删除任何文件）。
- **新增 `lib/host-config.mjs`：把「本机在哪台机器上」从代码里挪出来**。
  数据区根 / 工作副本根 / 对端别名 / 对端用户目录 / 对端数据区根 / 本机服务基址 / 机器别名表
  全部走环境变量 + 中性兜底（见 README 的环境变量表）。**这一版没有任何真实机名或盘符当默认值。**
- **机器别名表默认只有本机一台**：`merge-memory` 的归属分类（own / pointer / foreign / unlabeled）
  仍按 `$BUTLER_MACHINE_ALIASES` 声明的拓扑判定；不声明 ⇒ 跨机判定说不出对端是谁（`foreign` 收不到），
  这是有意的 —— 别把某个人的机器名当成协议。
- **对端未配置时明确报「未配置」而不是猜一台**：`text-sync-direct` 的 `--peer` 默认取 `$BUTLER_PEER`，
  两者都没有 ⇒ 提示要求显式传；`text-sync` 的对端探测在 `$BUTLER_PEERS` 为空时直接报「未配置」。
- `text-sync-direct` 的四个远程脚本（`_direct/select|pack|place|unplace.mjs`）与
  `handoff-record.schema.json` / `handoff-manifest.json` 一并进包 —— 它们是按路径引用的资源，
  只按 import 闭包打包会缺件（冒烟测试已补上「每个 .mjs 能 import / `_direct` 语法可解析」两条）。
- 冒烟测试口径修正：`_direct/` 是随主件 scp 到对端执行的独立 CLI（运行时入口是顶层语句），
  不再当作"可 import 的模块"来测，改为 `node --check` 语法保证。

## 0.2.2 · 2026-11-07

发布前独立复核抓出的**脱敏残留**收尾（**没有行为变更**）：

- **作业表 / 锁表里去掉一条不属于本包的 job**：`<外部通道 job>`（脚本在宿主私有的通道树里，本包从不附带）。
  留着它只会让人照着去一个不存在的路径找脚本 —— 现在两处都换成一句「本包不含此 job，宿主自行登记」的说明。
- **注释里的具体通道名换成中性表述**：真发送末端统一写成「由宿主自行注入的外部通道（本包不提供具体实现）」，
  不再点名任何通道组件（`scan-oss-sanitize` 的 P0 词表命中 7 → 0）。
- **盘符路径与用户目录字面换成占位**：注释与自测夹具里的 `<盘>:\workspace\…`、`<用户目录>\.dsh`、`<path>` 一类
  写法统一占位化；两处会话 id 夹具拆成互不相同的中立 id。⇒ `scan-oss-sanitize` 待复核 23 → 0。
- 仓库 `.gitignore` 补 `*.tgz`（打包残留不再可能被误提交）。

## 0.2.1 · 2026-11-07

0.2.0 发布后当场自测发现的三个收尾问题，同批修掉（**没有行为变更**）：

- **`steward --selftest` 有一条夹具红**：三个自测夹具的会话 id 在去私有化时被压成了同一个占位值，导致 `--only` 收窄判据失真（production 侧 52/52，开源侧 51/52）。已拆回三个不同的中立 id ⇒ **52/52 全过**。
- **两处默认路径被去私有化规则吃坏**：`steward-advice` 的判据表相对路径与两件"年轮档"默认名变成了 `docs/`（不可用）。已改成 `docs/rules/advice-rules.md` 与 `docs/reports/{capability,coordination}.json`，其 21 条夹具同步改并全过。
- **注释里的占位词在中文语境读不通**（`the assistant新家` 之类）⇒ 换成中文中性词（示例主线 / 助手 / 操作者 / 本机）。

## 0.2.0 · 2026-11-07

**日报与巡检工具集**进来了（六个工具）+ **一个通知注入点**。调度内核本身行为不变。

- **新增工具**（都能单独当命令跑，默认 dry-run、只读先看）：
  - `butler-steward`：把「今天该看什么」拼成一份报告（看板 / 进度 / 产物 / 待办），`--json` 给机器读。
  - `butler-steward-threads`：Thread（话题串）数据面 —— 建串 / 挂卡 / 订阅 / 扇出，纯数据、不调模型。
  - `butler-steward-advice`：按「现象 → 判断 → 建议动作 → 依据」四段出建议（判据表可换）。
  - `butler-failure-classify`：把一批失败会话/卡分成五类（真失败 / 被驳回 / 被打断 / 环境 / 未判），只给草稿不动账本。
  - `butler-progress-status`：读进度登记表，产「已落地 / 证据在哪 / 还差什么」的一页表。
  - `butler-stall-nudge`：主线停滞提醒 —— 判四类停滞、出报告、按需推送 Top N（推送走注入点）。
- **通知注入点** `src/dsh-butler/lib/notify.mjs`（`@kira905/dsh-butler-engine/notify`）：
  - 接口 `notify({ level, title, body, dedupeKey, channel })`；宿主用 `setNotifier(fn)` 接自己的通道。
  - **默认实现 = console + no-op**：往 stderr 打一行、返回 `{ ok:false, error:'no-channel' }` —— 看得见，但不假装发出去了。
  - **不带任何具体通道**（企业级 IM / 个人 IM / 语音都不在包里），开关默认关；同日同键只发一次。
- **自检**：新增 `test/notify-seam.mjs` 19 条（默认 no-op / 注入后真发 / 去重 / 开关 / 六个入口能跑）；`smoke.mjs` 18 条不变。

### 已知限制（0.2.0 追加）

- 六个工具的输出目录、主线名、文档目录都是**可配的**：`BUTLER_DOCS_DIR` / `BUTLER_REPORT_DIR` / `BUTLER_ROOT`，没配就按 `<home>/dsh/docs` 这类默认值走 —— 先跑 `--help` 看一眼再接线。
- `butler-steward-threads` 没有 `--help` 分支（无参数或未知参数 ⇒ 直接打用法 + 退出码 2），这是它本来的 CLI 形态。

## 0.1.0 · 2026-11-07

首个公开版本：把长期自动运维的那套**调度与放行内核**单独拿出来。

- **调度**：常驻循环，四种作业形态（固定间隔 / 每天某点 / 每周某天 / 只在时段窗内），错峰首次延迟，作业级耗时预算与良性退出码。
- **单实例**：按作业名登记的锁注册表（TTL 由间隔推导，可显式覆盖），同一作业多触发源共享一把锁，撞上本轮让路；交接窗口内自动让路。
- **放行**：模块级 + 作业级开关矩阵，每次改动都带 `by` / `why` / `since`，并落一行审计；`declaredJobDefault()` 把「配置里没写时该开还是关」变成源码里可审的一行。
- **默认关**：本包不附带作业脚本 ⇒ 缺键即关（`BUTLER_JOBS_DEFAULT=on` 可恢复"缺键即开"的老语义）。
- **账本**：哈希链审计（跨进程写锁 + 尾部断链巡检）、失败原因留痕、心跳与逐作业最近结果。
- **自检**：`test/smoke.mjs` 18 条，全部落在临时目录，不碰真实状态。

### 已知限制

- 状态默认在 `%TEMP%\dsh-butler-tickd`；同机多实例必须各给 `DSH_TICKD_DIR`。
- 作业表是源码常量，没有热加载。
- Windows 优先（路径归一 / junction / `%TEMP%` 口径）。
