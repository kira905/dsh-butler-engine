# 变更记录

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
  - **不带任何具体通道**（企业微信 / 微信 / 语音都不在包里），开关默认关；同日同键只发一次。
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
