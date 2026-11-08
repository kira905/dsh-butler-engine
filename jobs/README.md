# `jobs/` —— 随包附带的作业脚本（可选附带品）

`butler-tickd` 的调度表（`src/dsh-butler/butler-tickd.mjs` 的 `JOBS`）里有 **77 条作业**，
但内核自己只带 3 个脚本（`steward.mjs` / `stall-nudge.mjs` / `text-sync.mjs`）。
本目录补上其中 **31 个作业脚本**，覆盖 **41 条作业**。

**作业是可选附带品，与内核分层**：整个 `jobs/` 目录可以直接删掉，删了只会让那 41 条作业
变成「找不到脚本」，不会影响调度器、锁、审计、自主矩阵这些内核件。

---

## 1. 脚本从哪来（三级解析）

`butler-tickd` 每次派活前先解析入口，**前命中即用**：

| 级 | 来源 | 说明 |
|---|---|---|
| ① | `<包根>/jobs/` | 就是本目录 |
| ② | 环境变量 `BUTLER_JOBS_DIR` | 指向你自己的脚本目录（绝对路径）。⚠️ 同名时 **① 先命中**（包内那份胜出）—— 想用自己那份，就换个文件名，或在 `JOBS` 里把 `script` 写成绝对路径 |
| ③ | `job.dir`（内核位置） | 内核自带的 3 个脚本走这条 |
| ④ | 都没有 | 记 `skipped-missing-src` —— **不发红**：不涨 `failures`、不抢锁、不 spawn |

`JOBS` 里写成绝对路径的那些作业（如 `report.mjs`、`session-relay.mjs`）按绝对路径用，
和上面三级无关 —— 那是"宿主自建的树"，本来就不该由本包提供。

**怎么看自己这台是什么状况**：

```bash
npx butler-tickd --list      # 每条后面标 [jobs] / [host-dir] / [pkg-dir] / [缺脚本]
npx butler-tickd --status    # JSON：每个 job 的最近结果（含 lastEntrySource）
```

`--list` 的 stdout 严格一行一条（有单测按行数对 `JOBS` 条数）；「缺脚本」的汇总行走 stderr。

## 1.5 第一次装完先开哪几条（照这份抄）

装完是**全关**的（见下一节），所以"装好了"和"它在干活"之间差一步：开开关。
刚上手别一次全开 —— 先用一组**只读、可逆、不碰外部数据**的作业确认调度链真的通了。

机器可读的模板在 **`examples/first-run.json`**（4 条作业 + 开关文件的确切形状 + 三步验收命令）。
它为什么长这样：给 agent 抄的 —— 设置不对时，agent 照这份文件就能把开关改对。

**文件放哪**：`~/.dsh/butler-autonomy.json`（Windows = `%USERPROFILE%\.dsh\butler-autonomy.json`）。
不存在就新建；已存在就**往 `jobs` 里加键**，别整份覆盖（别人的开关与理由也在里面）。

```json
{
  "schemaVersion": 1,
  "jobs": {
    "card-watchdog": { "enabled": true, "by": "you", "since": "2026-01-01T00:00:00.000Z", "why": "first run" },
    "barewatch":     { "enabled": true, "by": "you", "since": "2026-01-01T00:00:00.000Z", "why": "first run" }
  }
}
```

`enabled` 是唯一判定字段（`false` 才是关）；`by` / `since` / `why` 是留痕，方便日后自己回看是谁为什么开的。
改完**必须重启常驻进程**（`JOBS` 是启动期常量）：`butler-tickd --stop` 然后 `butler-tickd --ensure`。

**怎么开、怎么看它真的跑了**（三步，逐条对得上才算通）：

| 步 | 命令 | 看什么 |
|---|---|---|
| ① 开关认到了吗 | `butler-tickd --list` | 那几行开头由 🔴 变 🟢 |
| ② 真跑一轮 | `butler-tickd --once card-watchdog` | 出现 `--once 启动: card-watchdog`（而不是「被开关拦下」） |
| ③ 到底成没成 | `butler-tickd --status` | 该 id 的 `lastStatus: "ok"`、`runs` 涨了、`lastEndAt` 是刚才、`failures` 不涨 |

同一组里为什么是这 4 条、哪几条这次没放进来的原因，都写在 `examples/first-run.json` 的
`jobs[].why` 与 `knownGaps` 里（包括 `tidy` 被版本门拦、`watchfs` 经 tickd 报 exit-1 这两条）。


## 2. 默认仍然全关（这一条没变）

装完**一条作业都不会自己跑**。脚本在位只是"能跑"，跑不跑由开关决定：

```bash
npx butler-autonomy-cli job list          # 看全部开关
npx butler-autonomy-cli job on  pitfall --reason "想在本地跑坑库学习"
npx butler-autonomy-cli job off pitfall --reason "先关掉"
```

- 总闸 = `modules['tickd-jobs']`（关 = 一律不跑，进程还在、心跳照写）。
- 单开关 = `jobs.<id>.enabled`；有些作业在源码里声明了 `defaultWhenUnset: 'off'`（**缺省关**，
  与全局缺省无关），这类要显式 `job on` 才会跑。
- **改完必须重启 tickd 常驻进程**才生效（`JOBS` 是启动期常量）：`--stop` 然后 `--ensure`。

## 3. 这 31 个脚本各自覆盖哪些作业

| 脚本 | 覆盖的作业 id | 干什么 |
|---|---|---|
| `restart-coordinator.mjs` | `restart` | P0 重启统筹闸门：低水位 + 24h 去重 + 通道闸 |
| `butler-queue-tick.mjs` | `queue` | 卡进「待验收」后叫醒推进者（三档 observe/report/notify） |
| `butler-stuck-recovery.mjs` | `stuck-recovery` | 卡死会话自愈链（提醒 → 登记重启事由 → 补注入） |
| `butler-auto-tick.mjs` | `queue-wake` `p0-auto-restart` `p5-auto-rollback` `auto-heal` `ctx-guard` `evidence-precheck` `dup-cards-merge` `memory-distill` `board-line-archive` `archive` `token` | 自治动作的**接线层**：一个脚本挂 11 条作业，各自带模块门 |
| `butler-card-watchdog-tick.mjs` | `card-watchdog` | 盯卡巡检：假结算 / 假 running（只报不改卡） |
| `butler-repair-linger-tick.mjs` | `repair-linger` | 分身僵留自动收官 |
| `barewatch-tick.mjs` | `barewatch` | 裸跑期观测采集 |
| `butler-watch-fs.mjs` | `watchfs` | 磁盘层审计（P5） |
| `pitfall-tick.mjs` | `pitfall` | 坑库学习（渲染色 / 写流水） |
| `pitfall-cluster-tick.mjs` | `pitfall-cluster` | 坑库向量二级聚类 |
| `butler-tidy-tick.mjs` | `tidy` | 收纳审计采集（只读 · 默认关） |
| `butler-external.mjs` | `external` | 外部信号采集 + 报告（P6） |
| `butler-reconcile.mjs` | `reconcile` | 跨载体对账（P7） |
| `coldbackup.mjs` | `coldbackup` | 冷备（回滚点 + 生图） |
| `hot-collect.mjs` | `hot` | 热采（看板 / 会话 / 流水 → 台账） |
| `memory-snapshot.mjs` | `memory-snapshot` | 记忆库每日热采（未变不推） |
| `memory-hit-collect.mjs` | `memory-hit-collect` | 记忆召回命中留痕采集（只读日志） |
| `memory-change-audit-tick.mjs` | `memory-change-audit` | 记忆留痕体检（只读） |
| `butler-memory-vectors-tick.mjs` | `memory-vectors` | 记忆向量同步（编码桥 + 增量） |
| `dream-tick.mjs` | `memory-dream` | 记忆 dream 整理（只读，写回需人审） |
| `mem-sync-tick.mjs` | `memory-sync` | 跨机记忆同步（双向收敛） |
| `mem-push-leaf.mjs` | `memory-sync-leaf` | 记忆快照**单向**叶子推送 |
| `handoff-arrive-b.mjs` | `arrive-b` | 接机：看板并回 + 安全搬件 |
| `anchor-watch.mjs` | `mainline-anchor` | 锚检测（防缩目标 · 只读判定） |
| `ledger-scan.mjs` | `mainline-scan` | 主线流水扫描（补记 scan-fill） |
| `router-guard.mjs` | `router-guard` | Router 守护巡检（置顶 / 归档 / 钉子 / cwd） |
| `router-act.mjs` | `router-digest` | Router 结论槽位每日收口（零模型） |
| `router-inbox-flush.mjs` | `router-inbox-flush` | Router 静默批唤醒（无来信不投） |
| `dsh-butler-watch.mjs` | `watch` | P2 盯人：把待处理推到会话 / 报告 |
| `dsh-vanish-watch.mjs` | `vanish-watch` | 大量消失告警（observe 档） |
| `dsh-snapshot-tick.mjs` | `snapshot` | 定时快照 + 异地镜像（排除凭据） |

除了这 31 个作业入口，`jobs/` 顶层还躺着 7 个**辅助 CLI**（被入口当依赖拖进来的，`JOBS` 表里没有它们）：
`butler-audit-archive.mjs` · `butler-audit-verify.mjs` · `ledger-line.mjs` · `ledger-read.mjs` ·
`router-inbox.mjs` · `session-say.mjs` · `yearring-index.mjs`。

辅助件都在 `jobs/lib/`（`lib/ws-root.mjs` 是口径单点：工作区根 / 盘外副本根 / 快照前缀）；
`jobs/memory-layers/` 与 `jobs/ext/` 是少数几件跨域依赖。**它们不是入口**，不要单独挂作业。

## 4. 没带的两个脚本（以及为什么）

| 脚本 | 挡在哪 |
|---|---|
| `secretary-morning.mjs` | 早报要**取数 + 走外部推送通道**（"服务面早报"整条链），通道实现在本包里刻意不给 ⇒ 带走也没法用，还得带一整串通道代码 |
| `family-vectors-tick.mjs` | 家人记忆向量同步：动的是**家庭成员的私有数据**，不属于"通用调度器"的交付面 |

除这两个之外，`JOBS` 里还有 **33 条作业**找不到脚本 —— 它们属于「宿主自建 / 上游观测 /
通道 / 生活侧」三类（如 `report.mjs`、`session-relay.mjs`、`dsh-session-mirror.mjs`、
`dsh-upstream-watch.mjs`、`memory-import-life.mjs`、`mood-broadcast/broadcast.mjs` …）。
这些是**你的树里的东西**，本包不替你猜路径：要么把 `script` 改成绝对路径，要么把脚本放进
`BUTLER_JOBS_DIR` 指向的目录。

## 5. 环境变量

### 5.1 通用（本目录新增，见 `lib/ws-root.mjs`）

| 变量 | 含义 | 缺省 |
|---|---|---|
| `BUTLER_JOBS_DIR` | 作业脚本目录（第 ② 级解析） | 未设 = 没有这一级 |
| `DSH_WORKSPACE` | 工作区根（含 `docs/` `tools/` `_archive/`） | `~/DSH` |
| `DSH_GITBACKUP_ROOT` | 盘外副本 / 冷备根 | `~/dsh-git-backup` |
| `DSH_SNAPSHOT_PREFIX` | 记忆快照文件名前缀 | `mem-snapshot` |
| `DSH_HOST_TOKENS` | 「设备名」标签正则（主题聚类时剔除） | `^$`（不剔任何） |

### 5.2 各脚本自己的开关（只列常用的；每个脚本 `--help` 里还有）

| 变量 | 用在 | 含义 |
|---|---|---|
| `BUTLER_DSH_HOME` / `DSH_HOME` | 全族 | DSH home（缺省 `~/.dsh`）；测试/金丝雀指到隔离目录 |
| `BUTLER_ROOT` | tickd 与多件 | 数据区根（缺省 `~/dsh`） |
| `DSH_WEB_URL` | `anchor-watch` `router-*` `session-say` `auto-heal` | 本机 DSH 服务基址（缺省 `http://127.0.0.1:3080`） |
| `DSH_SESSION_ID` | `butler-card-watchdog-tick` `butler-queue-tick` `ledger-line` `session-say` | 当前会话 id（tickd 会透传） |
| `DSH_TICKD_DIR` | `butler-card-watchdog-tick` `butler-queue-tick` | tickd 状态目录（夹具隔离用） |
| `DSH_MEM_ROLE` | `mem-sync-tick` | 本机角色 `driver` / `follower`（**缺省没有角色 ⇒ 让路**） |
| `DSH_PEER_LAN` / `DSH_PEER_TUNNEL` | `mem-sync-tick` | 缺省对端 ssh 别名（不给就得 `--peer-lan` / `--peer-tunnel`） |
| `DSH_MEM_SYNC_SSH_EXE` / `_SSH_PREFIX` / `_SCP_EXE` / `_SCP_PREFIX` | `mem-sync-tick` `mem-push-leaf` | 换 ssh/scp 实现（Windows 自带 OpenSSH 时不需要设） |
| `DSH_REMOTE_BUTLER_DIR` | `mem-sync-tick` | 对端作业目录（缺省 `/srv/dsh/tools/dsh-butler`） |
| `ARRIVE_B_*` | `handoff-arrive-b` | 接机各落点与模式（`ARRIVE_B_REPORT_ONLY=1` 只报告不搬件） |
| `DSH_REMOTE_BACKUP_DIR` | `dsh-snapshot-tick` | 异地镜像落点 |
| `DSH_MEMORY_SNAPSHOT_REPO` / `_TMP` | `memory-snapshot` | 快照仓 / 临时目录 |
| `DSH_PWSH` | `memory-snapshot` | pwsh 可执行文件（缺省 `pwsh`，回落 `powershell`） |
| `DSH_MEMORY_SNAPSHOT_*`、`DSH_HOT_*` | 见各脚本 `--help` | 节流 / 导出间隔等 |

### 5.3 只读 / dry-run 口径（重要）

这些脚本**默认不动生产**，靠显式参数放行：

- `butler-external` `hot-collect` `pitfall-tick` `butler-tidy-tick` `dream-tick` 等采集类：缺省只生成报告，
  写盘要 `--apply`。
- `tickd` 的作业表里已经按各自口径写好参数（例如 `hot` 带 `--apply`、`pitfall` 不带）。
  自己手动跑时**先看 `--help`**。
- `dsh-butler-watch` 的「外部通道」是**注入点**：本包不提供任何具体通道实现，
  `deliverPush()` 返回里没有 `external` 这一段 ⇒ 状态恒为「未注入（默认关）」。
  你要接自己的通道，就在 `watch-notify` 的返回里补一段
  `external: { ok, reason, stage, error }` 与 `channel.external.enabled`。

## 6. 许可

与主包一致：**AGPL-3.0-only + 商业授权**（见包根 `LICENSE` 与 `README.md` 的「License」段）。
