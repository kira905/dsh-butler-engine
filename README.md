# dsh-butler-engine · 常驻调度内核

> ### 这是什么
> **一套"让机器按表自己上班"的内核**：常驻调度（每隔几分钟 / 每天几点 / 每周哪天 / 只在某个时段跑）+ 单实例锁（同一个作业同一时刻只跑一份）+ 自主开关矩阵（谁能自己动手，每次改动都带「谁改的、为什么」）+ 哈希链审计（事后能追）。
>
> 它原本是一个长期自动运维的管家里被天天跑着的那部分，现在把**调度与放行这一层**单独拿出来开源。
>
> ### 它解决什么
> 让程序自己跑，真正的麻烦不是"跑得慢"，是**没人知道它此刻在干什么、为什么干、出事谁放行的**。
> 这里有三个明确的设计取舍：
> 1. **作业表写在源码里**（`src/dsh-butler/butler-tickd.mjs` 的 `JOBS`）——「谁能自己上班」这件事应当被 diff 审一遍，而不是悄悄写进某个配置文件。
> 2. **默认全关**：新装的机器上，一条作业都不会自己跑。要跑哪条，就在配置里显式放行并写明理由。
> 3. **锁按作业名登记**：同一类作业在多处触发（常驻调度 / 手动 / 计划任务）时共享同一把锁，撞上就本轮让路，不会两份同时改同一个状态。
>
> ### 一条命令跑起来
> ```powershell
> npm i -g @kira905/dsh-butler-engine
> butler-tickd --list      # 只读：看作业表有哪几条、开没开、入口是哪个脚本
> butler-tickd --status    # 只读：心跳 / 每个作业最近一次结果 / 被哪些开关拦着
> butler-tickd             # 前台常驻（Ctrl+C 停）；--ensure 可拉起后台常驻
> ```
>
> > ⚠️ **装完它不会自己动**。原因见下一节，这是有意的。

> ### 它不附带什么（先看清楚，省得装完失望）
>
> 1. **大多数作业脚本**。调度表里登记了 78 条作业（备份、巡检、归档、日报、扩缩容…），绝大部分脚本是另一套东西，**不随这个包发布**。所以本包默认把**全部作业关掉**——否则一启动就是几十个"找不到脚本"的失败，几分钟刷满告警。
> 2. **面板 / 网页界面**。这里只有调度、放行、以及命令行工具，不画面板。
> 3. **任何具体通知通道**。企业级 IM、个人 IM、语音播报这类**不随开源发布**（绑定账号、设备与私人日程，整块脱敏不了）。取而代之是一个**注入点**（见下节）——你要发到哪，自己接一行代码。
>
> 所以你装到的是一台**调度器 + 闸门 + 账本 + 一组命令行工具**，不是一个会自己上班的管家。要它干活，得接自己的作业脚本与通道——下面就是怎么接。

## 0.2.0 新增：日报与巡检（六个工具）

这六个都能单独当命令跑，**默认只读 / dry-run**，看清楚再 `--apply`。

| 命令 | 一句话 | 典型用法 |
|---|---|---|
| `butler-steward` | 把"今天该看什么"拼成一份报告（看板 / 进度 / 产物 / 待办） | `butler-steward --json` |
| `butler-steward-threads` | 话题串数据面：建串 / 挂卡 / 订阅 / 扇出（纯数据，不调模型） | `butler-steward-threads --thread-new --title "第一本"` |
| `butler-steward-advice` | 按「现象 → 判断 → 建议动作 → 依据」四段出建议 | `butler-steward-advice --card <卡id>` |
| `butler-failure-classify` | 把失败分成五类，产草稿（不动账本） | `butler-failure-classify --days 30 --json` |
| `butler-progress-status` | 读进度登记表，产「已落地 / 证据 / 还差什么」一页表 | `butler-progress-status --md` |
| `butler-stall-nudge` | 主线停滞提醒：判四类停滞、出报告、按需推送 Top N | `butler-stall-nudge --days 3 --json` |

### 通知注入点（"出事喊到人"那一块，交给你）

包里**没有**任何通道实现，只有一个函数面：

```js
import { notify, setNotifier } from '@kira905/dsh-butler-engine/notify';

// ① 接你自己的通道（邮件、IM、Webhook、桌面通知都行）
setNotifier(async ({ level, title, body, dedupeKey }) => {
  await myChannel.send({ level, title, body });
  return { ok: true, msgid: 'whatever' };   // ok:true = 真发出去了；false ⇒ 调用方会当失败、可重试
});

// ② 业务侧只管"发什么"
await notify({ level: 'warn', title: '卡跑挂了', body: '…', dedupeKey: 'card-123' });
```

不注入时：往 stderr 打一行 `[butler:notify] …`，返回值 `{ ok:false, error:'no-channel' }`——
**看得见，但不假装发出去了**。开关默认关（`<数据根>/butler-alert.json` 里 `channels.alert`），
同一 `dedupeKey` 同一本地日只真发一次。

## 怎么接自己的作业（三步）

```powershell
# ① 作业脚本放哪都行，调度表里写绝对路径；同目录的写文件名即可
# ② 在 JOBS 表里加一行（源码，一路只会有一处）：
#    { id: 'my-job', label: '我的作业', intervalMs: 10 * 60_000,
#      script: 'my-job.mjs', args: ['--once'], dir: HERE }
# ③ 放行这一条（写配置，不写代码）：编辑 <数据根>/butler-autonomy.json，加一段
#    "jobs": { "my-job": { "enabled": true, "by": "me", "why": "第一次接线" } }
#    这个文件不存在就新建，最小内容：{"schemaVersion": 1, "jobs": { … }}
# ④ 看一眼它被认到了没
butler-tickd --list      # 该行前面应当变成 🟢
```

写配置也可以用库里现成的门子（会同时落一行审计，带 by/why）：

```js
import { setJobEnabled } from '@kira905/dsh-butler-engine';
setJobEnabled('my-job', true, { by: 'me', why: '第一次接线' });
```

> ⚠️ 库调用注意：`isTickJobEnabled(id)` **单独调用不知道"源码里声明了默认关"**，
> 必须把 `defaultEnabled: declaredJobDefault(job)` 一起传进去（本包自己的常驻进程就是这么调的）。
> 忘了传 = 按"缺键即开"处理，会出现"明明该关却开"的错觉。

## 装完自检（三条只读，不启服务）

```powershell
# ① 命令在不在
butler-tickd --help

# ② 作业表读得出来吗（应当看到 78 行，每行带 🔴/🟢）
butler-tickd --list

# ③ 心跳与开关现状（JSON；全新机器上 running=false、blocked 全覆盖）
butler-tickd --status
```

## 0.3.0 新增：交接 / 跨机同步（四个工具）

同一个内核算出来的另一面：**机器之间怎么交接**。四个入口都默认 dry-run，先把计划打出来看清楚再 `--apply`。

| 命令 | 一句话 | 典型用法 |
|---|---|---|
| `butler-handoff` | 手动交接器：`--status` 体检 / `--depart` 交出本机状态 / `--arrive` 接对端状态 | `butler-handoff --status` · `butler-handoff --depart --dry-run` |
| `butler-cold-handoff` | 冷接机：DSH 已停 + 写者已冻结的窗口里做跨机语义合并（坑库 / 记忆库） | `butler-cold-handoff --status` · `--dry-run` · `--apply` |
| `butler-text-sync` | 跨机文本同步（文档 / 预设；经工作副本，带推前超集体检） | `butler-text-sync --status` · `--apply` |
| `butler-text-sync-direct` | 不经仓的直连同步（ssh 传包；永不删除任何文件） | `butler-text-sync-direct --status` · `--status -json` |

三条与"跨机"有关的硬规矩，写死在里面：

1. **Arrive 分发前过对偶门**：目标文件当前 hash ≠ 上一次交接基线 ⇒ 跳过 + 告警，不静默覆盖。
2. **永不删除对端文件**：文本同步只有"新增 / 更新 / 落冲突副本"三种结果，没有 purge、没有镜像。
3. **交接单不写绝对路径**：记录里只有主机名 / 仓内相对路径 / key / 哈希 / 条数，写盘前硬校验。

### 环境变量（跨机这一面认这些）

| 变量 | 含义 | 不设时的兜底 |
|---|---|---|
| `BUTLER_DSH_ROOT` | 本机数据区根（含 `docs/` `tools/` `_archive/`） | `$DSH_WORKSPACE` 或 `~/DSH` |
| `BUTLER_REPO_ROOT` | 三仓工作副本根（盘外目录） | `~/dsh-repos` |
| `BUTLER_PEER` | 默认对端 ssh 别名 | **空** —— 用 `--peer` 显式传 |
| `BUTLER_PEER_HOME` | 对端用户目录根 | 空 |
| `BUTLER_PEER_DSH_ROOT` | 对端数据区根 | 空 |
| `BUTLER_PEERS` | 对端清单（逗号分隔，`text-sync` 的探测用） | 空 = 不探测 |
| `BUTLER_MACHINE_ALIASES` | 机器别名表（JSON：`{ "规范名": ["别名…"] }`） | **只有本机一台** |
| `BUTLER_SELF_BASE` | 本机服务基址 | `http://127.0.0.1:3080` |
| `BUTLER_DESKTOP_SUBDIR` | 桌面恢复入口子目录名 | `DSH-restore` |

> ⚠️ 这些兜底值只是"能跑起来"，不代表推荐布局。**换机器请显式设变量**。

## 状态与配置放在哪

| 东西 | 默认位置 | 覆盖方式 |
|---|---|---|
| 心跳 / 单实例锁 / 调度日志 | `%TEMP%\dsh-butler-tickd\`（`state.json` / `lock` / `dsh-butler-tickd.log`） | 环境变量 `DSH_TICKD_DIR` |
| 配置与审计（放行开关、审计流水、告警日志） | `~/.dsh`（Windows：`%USERPROFILE%\.dsh`） | 环境变量 `BUTLER_DSH_HOME` 或 `DSH_HOME` |
| 作业脚本树根（作业表里 `path.join(DSH, …)` 那部分） | `~/dsh`（Windows 上落在用户目录下的 `dsh` 子目录） | 环境变量 `BUTLER_ROOT` |

## 已知限制（第一版就说清楚）

1. **状态默认落在 `%TEMP%`**——同一台机器上跑两个实例会共用同一份状态与同一把锁（表现是"第二个实例静默不干活"）。要多实例，请各给一个 `DSH_TICKD_DIR`。
2. **作业表是常量**：改作业表 = 改源码 + 重启常驻进程（`--stop` 然后 `--ensure`）。没有热加载。
3. **Windows 优先**：路径归一、junction 判定、`%TEMP%` 口径都按 Windows 写的；Linux/macOS 能跑但不是主要目标。
4. **默认关是"缺键即关"**：显式放行才能跑；要恢复"缺键即开"的老语义（不推荐），设 `BUTLER_JOBS_DEFAULT=on`。
5. **审计是本地文件**（按月 jsonl + 哈希链），没有中心化服务，也没有远端上报。
6. **六个工具不知道你的目录长什么样**：文档目录 / 报告目录 / 工具树根分别认 `BUTLER_DOCS_DIR` / `BUTLER_REPORT_DIR` / `BUTLER_ROOT`，没配就按 `<home>/dsh/docs` 这类默认值走。主线名、判据表这类"你的家规"也不在包里 —— 先 `--help` 看一眼，再接线。
7. **`butler-steward-threads` 没有 `--help`**（无参数或未知参数 ⇒ 直接打用法 + 退出码 2），这是它原本的 CLI 形态，不是坏掉。

## 目录结构

```
src/dsh-butler/         调度内核 + 日报/巡检工具 + 交接/跨机工具（butler-tickd.mjs 是调度入口，
                        handoff / cold-handoff / text-sync / text-sync-direct 是跨机入口）
src/dsh-butler/lib/     同层模块：锁、审计、开关、状态读写、交接核心与合并…… 以及 lib/notify.mjs（通知注入点）
src/dsh-butler/_direct/ 直连同步的远程脚本（select / pack / place / unplace，随主件 scp 到对端执行）
src/lib/                与上层工具共用的几件：生产树守卫、DSH home/工作区解析、宿主环境口径（host-config）、
                        三仓超集体检（repo-superset）、对端通道（peer-channel）
bin/butler-tickd.mjs    npm bin 包装层
docs/架构一页.md         各模块职责一页看完
test/smoke.mjs          内核自检：19 条（全用临时目录，不碰真实状态）
test/notify-seam.mjs    通知注入点自检：19 条（默认 no-op / 注入 / 去重 / 开关 / 六个入口）
```

## 许可

AGPL-3.0-only。详见 [LICENSE](./LICENSE)。
