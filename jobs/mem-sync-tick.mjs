#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dsh-butler / mem-sync-tick.mjs —— 跨机记忆库**每小时自动同步**（双向收敛）
//   （卡：跨机记忆库每小时自动同步 · 2026-10-11 主人令）
//
// 需求原文（主人 2026-10-11 01:11）：
//   「占用资源这么少的话，每小时同步一次咋样？HOST_A 在公司网的话可以开临时通道或者仓信箱同步」
//   「重建向量如果是各机自己重建，就让 HOST_A 也跟 HOST_B 一样每小时跑一次」
//
// ── 形态（为什么这样分角色）────────────────────────────────────────────────
//   两台机各自跑**本脚本**，角色由主机名决定：
//     · driver（HOST_A，`host-a`）：
//         ① 取对端（HOST_B）**只读快照**（VACUUM INTO，在对端产出）→ scp 回本机
//         ② 合并进**本机**库（merge-memory --apply --allow-production）
//         ③ 产本机合并后快照 → 投递到对端 `inbox`（供 follower 下一轮取用）
//         ④ 重建本机向量（butler-memory-vectors-tick）
//     · follower（HOST_B，`host-b`）：
//         ① 读**本地** inbox 里 driver 投递来的最新快照（**不需要网络回连 HOST_A**）
//         ② 合并进本机库 → ③ 重建本机向量
//   ⇒ 传输只走 **HOST_A → HOST_B** 单向（lan / 隧道 / 按需短租），HOST_B 侧自持、不依赖 HOST_A 在线。
//
// ── 红线（照抄，别越）─────────────────────────────────────────────────────
//   * **禁整库同步/覆盖**：跨机搬的永远是 `VACUUM INTO` 只读快照，绝不是热库文件。
//   * `--apply` 打生产库必须显式 `--allow-production`（本脚本代传；merge-memory 自带该安全门）。
//   * 默认 **dry-run**（生态规矩：动生产须显式 `--apply`）；tickd job 用 `--apply` 放行。
//   * 失败**绝不静默**：非零退出（进 tickd 日报）+ state + `butler-alert.log` 一行。
//   * **公司有线网禁常驻通道**：按需短租（enable+up），跑完 **finally 归还**（`--no-tunnel-rent` 可关）；家里 wifi 等非公司有线网可长期开隧道（2026-10-11 主人令）。
//     ⚠️ **归还语义 = 只关"本次由我开的"**（2026-10-14 R12 切共用件 `tools\lib\peer-channel.mjs`，与 `session-mirror` 统一）：
//        进短租前隧道已 `enabled=true`（`relay-ondemand` 判决器 / 主人手动开的）⇒ 我只把它 `up` 起来用，
//        跑完**不 down**、只销自己的租约 —— 绝不把别人开的隧道一起关掉。
//   * 幂等：merge-memory 的运行键 `{object, remoteCommit, mergedAt}`（remoteCommit = 快照 sha256）。
//
// ── 撤回台账随快照投递（方案 §4 I2-④ / §9.1 **B1** · 2026-10-22 卡「V3 功能面 · 撤回链接线」）──────
//   问题：合并器 `merge-memory.mjs` 早就支持 `--retractions` / `--retractions-from` / `--apply-retractions`，
//         但本脚本调它时一个台账参数都没传 ⇒ 对端台账永不读、`adoptedRetractions` 生产恒空
//         ⇒ **A 机删掉的记忆，B 机合并后原样复活**（「dream 真移走」的唯一前置）。
//   本卡接的四件事：
//     ① **投递侧（driver）**：本机台账 `<home>/memory/retractions.jsonl` **随快照成对投递**到对端 inbox，
//        文件名 = 快照名去掉 `.db` 再加 `-retractions.jsonl`（如 `host-a-memory-<stamp>-<sha8>-retractions.jsonl`）。
//        为什么是"成对命名"而不是固定 `dsh/memory/retractions.jsonl`：inbox 里同时躺着十几个快照，
//        固定名会让"这一轮的库"配到"上一轮的台账"（配对不可核）；成对名能被机械推出、且 prune 能跟着快照一起清。
//        台账不存在 ⇒ 正常继续（不是错误）；投递失败 ⇒ 只进 warnings，**绝不挡快照投递**（快照优先级更高）。
//     ② **调用侧（两侧同一路）**：合并的 dry-run 与 `--apply` 都显式传 `--retractions <本机台账>`
//        与 `--retractions-from <对端台账>`（**不许靠默认路径**：`--home <沙箱>` 时默认路径仍指生产库台账）；
//        **只有 `--apply` 那一路**才加 `--apply-retractions`（dry-run 只出计划、不执行删除）。
//     ③ **顺序纪律：先合再撤回** —— 撤回由合并器在"插入/更新都落库之后"执行（合并器内部还是"先写台账再删"）。
//        本脚本不提供"先删再合"的入口、自己也不删任何条目；理由 = 合并计划是**以两台库当时的行集**算出来的，
//        先删会把"本机唯一副本"提前抹掉，一旦后段失败连快照外的对照都没了。
//     ④ **接收侧（follower）**：按上面的成对命名从 `--from` 快照旁推台账路径；推不出来 ⇒ 只合并不撤回（记一行）。
//   ⚠️ 残余面（如实登记，不假装治好了）：**反向没有通道** —— follower 不联网回连 driver，driver 也**不拉对端台账**
//      ⇒ 「HOST_B 侧删了 → HOST_A 不复活」这条**本卡没覆盖**（见交付报告「残余面 / 待拍板」）。
//
// ── 拓扑守卫 + 转发通道（V3 功能面 · 2026-10-22 · 评审发现 B / 方案 §9.1 B6）──────────────
//   ① **拓扑守卫**（`checkTopologyGuard`，lib 纯函数）：edge 模式的 driver **只许**投给中心机
//      （`partition.hubHost`）。判据 = `enabled ∧ mode==='edge' ∧ role==='driver' ∧ 对端认得出 ∧ 对端≠hub`
//      ⇒ 本轮 `deferred='topology-guard'`、`exit 3`、`butler-alert.log` 一行、`report.topologyGuard` 留证。
//      **不拦但告警**两态：hubHost 没配 / 对端 hostname 认不出（今天生产没配 ⇒ fail-open，见报告「待拍板」）。
//   ② **转发通道**：edge 模式下本机库**故意**不含 foreign 行 ⇒ 直接投「本机库快照」会让中心永久少事实（B6）。
//      本脚本把合并器的**未过滤**合并结果（`--forward-out` 文件，**只落文件不进报告**）填进**投递副本**，
//      再投出去 —— 本机库一个字节都不写（`applyForwardRowsToDb` 按内容哈希幂等）。
//      填充失败 ⇒ **整轮不投**（`deferred='forward-fill-failed'` + exit 3 + 告警行）：宁可不投，也不让中心悄悄少事实。
//      T1 幂等门/超集门"整段跳过"的轮次 ⇒ 用一次**只读**的 `--force` dry-run 补算计划（不写库）。
//
// 用法：
//   node mem-sync-tick.mjs [--role auto|driver|follower] [--apply] [--dry-run] [--json]
//        [--peer-lan <ssh别名>] [--peer-tunnel <ssh别名>] [--inbox <远端目录>]
//        [--keep N] [--no-vectors] [--no-tunnel-rent] [--state-file P] [--relay-cli P]
//        [--merge-config P] [--forward-file P] [--home P] [--help]
//
// 退出码：0 正常（含"合并无变化"/"幂等跳过"）/ 3 安全跳过（对端不可达 / 角色未知 / 无 inbox 快照 /
//         拓扑守卫拦下 / 转发填充失败）/ 1 真失败 / 2 用法错
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import { snapshotPrefix } from './lib/ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { writeStateText } from '../src/dsh-butler/lib/dual-write.mjs';
// 【0.2.0】撤回台账的**唯一读写口径**（只读它：rows/sha/是否存在；本脚本从不 append 台账 —— 写台账只发生在
//   合并器（并入对端行）与 memory-retract（撤一条）里，本脚本只负责"搬"）。
import * as R from '../src/dsh-butler/lib/retractions.mjs';
// ── 通道与「按需短租」用**共用件**（R9 · 2026-10-14 抽出；`session-mirror` 同一份判据）──────────
//   语义 = 先试候选（lan → tunnel）；都不通且开关允许 ⇒ `relay-cli enable`+`up` 后重试候选；
//   收尾 `releasePeerChannel(lease)` **只关"本次由我开的"** —— 进短租前已 enabled 的一律不碰。
//   一键关回：`--no-tunnel-rent` ／ env `DSH_PEER_SHORT_RENT=off` ／ 开关文件 `~\.dsh\relay\short-rent.json`。
import { ensurePeerChannel, releasePeerChannel } from '../src/lib/peer-channel.mjs';
// ── 归属过滤 / 拓扑守卫 / 转发副本填充（V3 功能面 · 只读配置 + 纯判据 + 副本写口）──────────
//   本脚本**从不创建** `butler-merge-config.json`（今天生产不存在，本卡保持它不存在）；
//   `readPartitionConfig` 在文件缺失时只回 `enabled:false` ⇒ 守卫不适用、转发不启用 = 与接线前逐字同行为。
import * as MM from '../src/dsh-butler/lib/merge-memory.mjs';

export const MEM_SYNC_TICK_VERSION = '0.3.0';

// ── 【A28 · 2026-10-26】连续 deferred 告警（审核档 §1-2「判据缺实现」的落地）──────────────────
//   病根：`finishState()` 的 `history` **只在 `status !== 'deferred'` 时追加** ⇒ 连续 10 小时 deferred 时
//   历史看着像"没异常"（2026-10-26 08:09 那轮就是）。「谁落后了没人知道」正是本线要消灭的那一条。
//   现在：连续 ≥ `DEFERRED_ALERT_STREAK`（3 轮 ≈ 3 小时）deferred ⇒ 往**既有**告警出口
//   `<home>/butler-alert.log` 追**一行**（含 `source=mem-sync`），读数同时进 `report`（tickd 日报 / 面板读它，
//   **不新造第二套通道**）。
//   去重：同一段连续**只报一次**（`state.deferredAlerted`），出现任一非 deferred 轮即复位 ⇒ 不刷屏。
//   计数落 `butler-mem-sync-state.json` 的**新键**：`deferredStreak` / `deferredStreakSince` / `deferredAlerted`
//   （`history` / `lastStatus` / `lastDeferred` 等既有键语义一字不动 ⇒ 老读者不破）。
//   **默认关**（卡面 A5 与审核档 §1-2 同口径：默认关、可一键关回）：
//     开 = env `DSH_MEM_SYNC_DEFERRED_ALERT=on`（`1`/`true`/`yes` 同义）
//       或 开关文件 `<home>/butler-mem-sync-alert.json` 的 `{"enabled": true}`（env 优先）
//     关 = env 置 `off`（或删该 env）= 回到默认；或把开关文件 `enabled` 改 false
//   ⚠️ 与 `peer-channel` 的 fail-open **故意相反**：这条通道是"往人和日报喊"，宁可缺也不能吵 ⇒ 读不到就当关。
export const DEFERRED_ALERT_STREAK = 3;
export const DEFERRED_ALERT_ENV = 'DSH_MEM_SYNC_DEFERRED_ALERT';
export const DEFERRED_ALERT_SWITCH = 'butler-mem-sync-alert.json';
const DEFERRED_ALERT_ON = new Set(['on', '1', 'true', 'yes', 'enable', 'enabled']);

/** 读「连续 deferred 告警」开关（env 优先 → 开关文件 → 默认关）。纯读，不写盘。 */
export function readDeferredAlertSwitch({ home, env = process.env } = {}) {
  const file = path.join(home ?? dshHome(), DEFERRED_ALERT_SWITCH);
  const envRaw = String(env?.[DEFERRED_ALERT_ENV] ?? '').trim().toLowerCase();
  if (envRaw) {
    return { enabled: DEFERRED_ALERT_ON.has(envRaw), source: 'env', reason: `env ${DEFERRED_ALERT_ENV}=${envRaw}`, file };
  }
  const raw = readJsonFile(file);
  if (raw && raw.enabled === true) return { enabled: true, source: 'file', reason: `开关文件 ${file} 的 enabled=true`, file };
  return {
    enabled: false, source: raw ? 'file' : 'default',
    reason: raw ? `开关文件 ${file} 的 enabled≠true` : `无 env 且开关文件不存在（${file}）⇒ 默认关`, file,
  };
}

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, DEFER: 3 };
const HERE = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try { return fs.realpathSync(here); } catch { return path.resolve(here); }
})();

const MERGE_SCRIPT = path.join(HERE, 'merge-memory.mjs');
const SNAP_SCRIPT = path.join(HERE, 'mem-snapshot-remote.mjs');
const VECTORS_SCRIPT = path.join(HERE, 'butler-memory-vectors-tick.mjs');
const TICK_RUNNER = path.join(HERE, 'lib', 'tick-job-runner.mjs');
const REMOTE_DH = process.env.DSH_REMOTE_BUTLER_DIR || '/srv/dsh/tools/dsh-butler';

/** 已知角色表（主机名小写 → 角色）。未知主机 ⇒ 让路（宁可不动，不瞎跑）。 */
export const ROLE_BY_HOST = {};

const SSH_COMMON = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'StrictHostKeyChecking=accept-new'];

// ─────────────────────────────── 参数 ───────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[body] = next; i += 1; continue; }
    flags[body] = true;
  }
  return flags;
}

export function resolveRole(hostname, roleFlag) {
  const h = String(hostname || '').trim().toLowerCase();
  if (roleFlag && roleFlag !== 'auto' && roleFlag !== true) return { role: String(roleFlag), reason: 'explicit' };
  const envRole = String(process.env.DSH_MEM_ROLE || '').trim().toLowerCase();
  if (envRole && envRole !== 'auto') return { role: envRole, reason: 'env:DSH_MEM_ROLE' };
  const r = ROLE_BY_HOST[h] ?? null;
  return { role: r, reason: r ? `host:${h}` : `unknown-host:${h}` };
}

/**
 * 【B案 · A29 · 2026-10-26】**默认对端按本机角色推导**（不再全局写死 host-b）。
 *
 * 为什么必须改：tickd 注册表给这个 job 的 args 是 `['--role','auto','--apply']`
 *   （**不带 peer 参数**，而 `butler-autonomy.json#jobs[id].args` 根本不被 tickd 读），
 *   而 `peerLan/peerTunnel` 原来的缺省恒为 `host-b-lan` / `host-b`
 *   ⇒ HOST_B 自己变中心之后，它会拿"指向自己的别名"当对端，**自己跟自己同步**。
 *
 * 口径（主人 2026-10-26 08:4x「中心机是HOST_B，保持不变，改代码和实现方式」）：
 *   · 中心在 HOST_B ⇒ 它的对端是 **HOST_C**（家里同网段直连，别名 `host-c-lan`，实测 `ssh … hostname` = `host-c`）；
 *   · HOST_A 仍是"叶子送中心" ⇒ 对端仍是 **HOST_B**（缺省值与接线前**逐字相同 ⇒ 行为一字不变**）。
 * ⚠️ 显式传 `--peer-lan/--peer-tunnel` 的一律优先 —— `memory-sync-leaf` job 就是显式传 `host-c-lan`/`host-c`，
 *    不受本表影响；夹具同理（它显式传假别名，保证不会真连网）。
 * ⚠️ 表里没有的机器 ⇒ 回落到老缺省（`host-b-lan`/`host-b`）= 与接线前一致。
 */
const PEER_BY_HOST = {};

export function resolvePaths(flags = {}, env = process.env) {
  const home = flags.home ? path.resolve(String(flags.home)) : dshHome();
  const hostKey = String(env.COMPUTERNAME || os.hostname() || '').toLowerCase();
  const peerDefault = PEER_BY_HOST[hostKey] ?? { lan: env.DSH_PEER_LAN ?? null, tunnel: env.DSH_PEER_TUNNEL ?? null };
  const tmp = env.TEMP || env.TMP || os.tmpdir();
  const tmpDir = flags['tmp-dir'] ? path.resolve(String(flags['tmp-dir'])) : path.join(tmp, 'dsh-mem-sync');
  return {
    home,
    localDb: path.join(home, 'memory', 'memory.db'),
    // 【0.2.0】本机撤回台账（`lib/retractions.mjs#retractionsPath` 同一落点：`<home>/memory/retractions.jsonl`）。
    //   显式算出来是为了：① 合并时**必须显式传**（默认路径按 USERPROFILE 算，`--home <沙箱>` 时会指错）；
    //   ② 投递/接收两侧都从这里取同一个真源，不在别处再拼一次字符串。
    retractionsFile: path.join(home, 'memory', 'retractions.jsonl'),
    stateFile: flags['state-file'] ? path.resolve(String(flags['state-file'])) : resolveStatePath('butler-mem-sync-state.json', { home }).path,
    alertLog: resolveStatePath('butler-alert.log', { home }).path,
    // 【0.3.0 · 拓扑守卫 / 转发通道】归属过滤配置载体（**只读**；文件不存在 = off）。
    //   与其余状态文件同一套口径（`paths.home` = `~/.dsh`），所以 `--home <沙箱>` 时读的是沙箱配置，
    //   **绝不会在夹具里读到生产配置**（同 `--local` 那条坑）。
    mergeConfig: flags['merge-config']
      ? path.resolve(String(flags['merge-config']))
      : resolveStatePath(MM.PARTITION_CONFIG_BASENAME, { home }).path,
    // 【0.3.0】转发计划文件（合并器 `--forward-out` 的落点；只落文件不进报告，体量大）。
    forwardFile: flags['forward-file']
      ? path.resolve(String(flags['forward-file']))
      : path.join(tmpDir, 'forward-rows.json'),
    tmpDir,
    // 【0.3.0】合并器的**运行键**（与 tick 自己的 stateFile 不是一个文件）。
    //   显式传的理由与 `--local` / `--retractions` 同源：不传则合并器按 USERPROFILE 解析，
    //   `--home <沙箱>` 的演练会把"假 remoteCommit"写进**生产**运行键。生产路径下两者逐字相同 ⇒ 行为零变化。
    mergeStateFile: resolveStatePath(MM.MERGE_MEMORY_STATE_BASENAME, { home }).path,
    // 合并归档根（tick 自己 prune 的就是这里）。`--archive-root` 只为隔离演练：不传 = 生产 `<workspace>\_archive`。
    archiveRoot: flags['archive-root'] ? path.resolve(String(flags['archive-root'])) : path.join(workspaceRoot(), '_archive'),
    relayCli: flags['relay-cli'] ? path.resolve(String(flags['relay-cli'])) : path.join(workspaceRoot(), 'tools', 'relay', 'relay-cli.mjs'),
    inbox: String(flags.inbox || path.join(os.homedir(), 'dsh-memory-sync', 'inbox')),
    peerLan: String(flags['peer-lan'] || peerDefault.lan),
    peerTunnel: String(flags['peer-tunnel'] || peerDefault.tunnel),
    keep: Number(flags.keep ?? 24) || 24,
    /** inbox 快照的"最小年龄"（毫秒）：比这更新的文件当作**可能还在传输中**，本轮不碰。默认 60s。 */
    minAgeMs: Number.isFinite(Number(flags['min-age-ms'])) ? Number(flags['min-age-ms']) : 60_000,
  };
}

// ─────────────────────────────── 小工具 ───────────────────────────────

function tail(s, n = 400) { return String(s ?? '').replace(/\s+$/, '').slice(-n); }

function runNode(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: opts.timeout ?? 20 * 60 * 1000, windowsHide: true,
    maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null };
}

/**
 * ssh 启动器 —— **只供隔离演练注入**（照 `dsh-session-mirror.mjs` 的 R9 同款口径）：
 *   `DSH_MEM_SYNC_SSH_EXE=node` + `DSH_MEM_SYNC_SSH_PREFIX=<假 ssh 脚本>` ⇒ 所有**会连网**的 ssh 都被换掉；
 *   **两个 env 都不设 ⇒ 逐字用系统 `ssh`**（生产行为一个字节都不变）。
 */
function sshLauncher() {
  const prefix = process.env.DSH_MEM_SYNC_SSH_PREFIX ? [String(process.env.DSH_MEM_SYNC_SSH_PREFIX)] : [];
  if (prefix.length) return { cmd: process.execPath, args: prefix };
  return { cmd: String(process.env.DSH_MEM_SYNC_SSH_EXE || 'ssh'), args: [] };
}

function ssh(alias, remoteArgs, opts = {}) {
  const l = sshLauncher();
  const r = spawnSync(l.cmd, [...l.args, ...SSH_COMMON, alias, ...remoteArgs], {
    encoding: 'utf8', timeout: opts.timeout ?? 90_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    // ⚠️【B案 · A29 · 2026-10-26】**stdin 必须显式 `ignore`**。默认 `pipe` 会给 ssh 一个
    //   "空但不保证 EOF"的 stdin；在部分宿主上 ssh 会**一直等 stdin**直到撞满 90 秒 timeout
    //   （症状 = `spawnSync ssh ETIMEDOUT`，而同一台机上**手敲一模一样的参数是秒回** —— 极易误判成
    //   "对端不可达 / 网不通"，实测 HOST_B 作为中心第一次跑起来就栽在这里，一次探测白等 90 秒 ×2 个候选）。
    //   HOST_A 当 driver 时没暴露（它对端走的是另一条路径），所以这条一直潜伏到今天换中心才现形。
    //   对 HOST_A 侧行为无影响：ssh 从来不需要我们喂 stdin（BatchMode=yes 下更不需要）。
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null };
}

/**
 * scp 启动器 —— 与 `sshLauncher()` 同款口径（**只供隔离演练注入**）：
 *   `DSH_MEM_SYNC_SCP_EXE=node` + `DSH_MEM_SYNC_SCP_PREFIX=<假 scp 脚本>` ⇒ 投递动作被换成假 transport；
 *   **两个 env 都不设 ⇒ 逐字用系统 `scp`**（生产行为一个字节都不变）。
 *   为什么需要它（新）：转发通道的验收判据是「中心**收到的**快照里 foreign 条都在」⇒ 必须能截获投递动作，
 *   而不是只测"填充函数返回 ok"。
 */
function scpLauncher() {
  const prefix = process.env.DSH_MEM_SYNC_SCP_PREFIX ? [String(process.env.DSH_MEM_SYNC_SCP_PREFIX)] : [];
  if (prefix.length) return { cmd: process.execPath, args: prefix };
  return { cmd: String(process.env.DSH_MEM_SYNC_SCP_EXE || 'scp'), args: [] };
}

function scp(from, to, opts = {}) {
  const l = scpLauncher();
  const r = spawnSync(l.cmd, [...l.args, ...SSH_COMMON, from, to], {
    encoding: 'utf8', timeout: opts.timeout ?? 5 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    // 同 `ssh()`：stdin 显式 `ignore`（scp 不需要我们从管道喂东西；留着 pipe 会让 scp 侧的 ssh 等 stdin）
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null };
}

/**
 * 【0.2.0 · I2-④】**把本机撤回台账随快照投递到对端 inbox**（成对命名）。
 *
 * 契约（卡面点名，缺一不算）：
 *   · 台账不存在 ⇒ **不是错误**：`skipped:'no-local-ledger'`，正常继续（不写 warning，避免每天刷警）；
 *   · 投递失败 ⇒ **只记 warnings**、返回 `ok:false`，**绝不抛、绝不挡快照投递**（快照优先级更高）；
 *   · 只读：本脚本从不写台账（`R.readRetractions` 纯读）。
 *
 * @param {{alias:string, inbox:string, localLedger:string, dbName:string,
 *          transport?:{scp:Function}, log?:Function, warnings?:string[]}} opts
 *   `transport` 只给夹具注入（生产不传 ⇒ 真 scp）。
 * @returns {{ok:boolean, name:string|null, skipped:string|null, bytes:number|null, rows:number|null,
 *            sha256:string|null, error:string|null, remoteTarget:string|null}}
 */
export function deliverRetractions(opts = {}) {
  const {
    alias, inbox, localLedger, dbName, log = () => {}, warnings = [], transport = null,
  } = opts;
  const name = retractionsSiblingName(dbName);
  const info = {
    ok: false, name, skipped: null, bytes: null, rows: null, sha256: null, error: null, remoteTarget: null,
  };
  if (!name) { info.skipped = 'no-db-name'; return info; }
  const led = R.readRetractions(localLedger);
  if (!led.exists) {
    info.skipped = 'no-local-ledger';
    log('[mem-sync] 撤回台账：本机还没有台账（`~/.dsh/memory/retractions.jsonl` 不存在）⇒ 本轮只投快照，正常');
    return info;
  }
  const remoteTarget = `${String(inbox).replace(/\\/g, '/')}/${name}`;
  info.remoteTarget = remoteTarget;
  info.bytes = led.bytes;
  info.rows = led.rows.length;
  info.sha256 = led.sha256;
  const up = (transport?.scp ?? scp)(localLedger, `${alias}:${remoteTarget}`);
  if (!up?.ok) {
    info.error = tail(up?.stderr || up?.error, 200);
    // 只记 warning：投递台账失败不该让"快照已送达"这件事变成失败（下一轮还会再投一次）
    warnings.push(`撤回台账投递失败（快照已送达，不影响合并；下一轮重试）：${info.error}`);
    log(`[mem-sync] ⚠️ 撤回台账投递失败（${name}）：${info.error}`);
    return info;
  }
  info.ok = true;
  log(`[mem-sync] ✓ 撤回台账已随快照投递：${name}（${led.rows.length} 行 · ${led.bytes} 字节 · ${String(led.sha256).slice(0, 14)}）`);
  return info;
}

function appendAlert(file, line) {
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8'); } catch { /* 忽略 */ }
}

function readJsonFile(file) {
  try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/** 解析 merge-memory `--json` 的 stdout（它只在最后打一段 JSON；log() 在 JSON 模式下静默）。 */
export function parseMergeJson(stdout) {
  const s = String(stdout ?? '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 落下面兜底 */ }
  const i = s.lastIndexOf('\n{');
  if (i >= 0) { try { return JSON.parse(s.slice(i + 1)); } catch { /* 忽略 */ } }
  return null;
}

// ─────────────────────────────── 择路（driver 用） ───────────────────────────────

/**
 * 单个候选的探活（命令固定 `hostname` —— 与 2026-10-11 起的既有判据一字不差）。
 * 【R12】抽成函数是为了把它**注入**共用件 `ensurePeerChannel`（判据仍在本脚本，模块只负责"开的动作"）。
 */
function probeCandidate(c) {
  const r = ssh(c.target, ['hostname']);
  return { ok: r.ok, hostname: r.stdout.trim(), err: tail(r.stderr || r.error, 160) };
}

/**
 * 探测对端通道。顺序 = lan（快、不依赖隧道）→ 隧道（若已在跑）→ **按需短租**隧道（默认开、可关）。
 *
 * 【R12 · 2026-10-14】短租段**切到共用件** `tools\lib\peer-channel.mjs`（与 `session-mirror` 同一份判据）：
 *   · 进短租前 `enabled=false`、由我 `enable`+`up` 起来的 ⇒ `downOnRelease=true` ⇒ 收尾 `down`（照旧）；
 *   · 进短租前**已经** `enabled=true`（`relay-ondemand` 判决器 / 主人手动开的）⇒ `downOnRelease=false`
 *     ⇒ 收尾**只销自己的租约、绝不动隧道**（改前这里收尾是无条件 `down` ⇒ 会把别人的隧道一起关掉）。
 *   · 租了仍不通 ⇒ 共用件**自己回滚 `down`**（不留 `enabled=true` 这种常驻意图在生产）。
 * @returns {{via:string|null, alias:string|null, rented:boolean, lease:object|null, rent:object|null, trace:object[]}}
 */
export function probePeer(paths, flags, { dryRun = false, log = () => {} } = {}) {
  const trace = [];
  const candidates = [
    { channel: 'lan', target: paths.peerLan },
    { channel: 'tunnel', target: paths.peerTunnel },
  ];
  const probe = (c) => {
    const t = Date.now();
    const r = probeCandidate(c);
    trace.push({ step: c.channel, alias: c.target, ok: r.ok, ms: Date.now() - t, err: r.ok ? null : r.err });
    return r;
  };
  // ⚠️ **只在显式关回时才传 `allowRent`**：缺省留给共用件读**总开关**（env `DSH_PEER_SHORT_RENT` →
  //    开关文件 `~\.dsh\relay\short-rent.json` → 缺省开）。传 `allowRent:true` 会把总开关整个绕过
  //    （R9 夹具 B5 实测踩到过这条 ⇒ 一键关回失效）。
  const noRent = flags['no-tunnel-rent'] === true;
  const res = ensurePeerChannel({
    candidates, probe, owner: 'memory-sync', relayCli: paths.relayCli,
    ...(noRent ? { allowRent: false } : {}),
    dryRun, log: (m) => log(`[mem-sync]${m}`),
  });
  const rented = res.rented === true && res.lease != null;
  trace.push({
    step: 'rent', alias: paths.peerTunnel, ok: res.ok === true, rented,
    enabledBefore: res.rent?.enabledBefore ?? null, downOnRelease: res.rent?.downOnRelease ?? null,
    skipped: res.rent?.skipped ?? null, rolledBack: res.rent?.rolledBack === true,
    err: res.ok ? null : tail(res.tried?.[res.tried.length - 1]?.err, 160),
  });
  return {
    via: res.ok ? (res.rented === true ? 'rent' : (res.channel ?? null)) : null,
    alias: res.ok ? res.target : null,
    rented, lease: res.lease ?? null, rent: res.rent ?? null,
    wouldRent: res.rent?.skipped === 'dry-run' ? true : undefined,
    trace, hostname: res.hostname ?? null,
  };
}

// ─────────────────────────────── 合并 ───────────────────────────────

/**
 * 组出调 `merge-memory` 的实参数（**单点**：正式合并与"补算转发计划"的只读重算共用同一套 ⇒ 不会漂）。
 *
 * 三条**必须显式传**的路径（都是同一个坑：合并器默认按 USERPROFILE 解析，`--home <沙箱>` 会指到生产）：
 *   · `--local <paths.localDb>`：本机库；
 *   · `--retractions <paths.retractionsFile>`：本机台账；
 *   · `--merge-config <paths.mergeConfig>`：归属过滤配置（生产路径下与合并器默认值逐字相同 ⇒ 行为零变化）。
 * 另：`--retractions-from`（给了就传，文件不存在也传）、`--forward-out`（转发计划，只落文件不进报告）。
 */
export function buildMergeArgs(paths, snapFile, { remoteRetractions = null, forwardOut = null, archiveDir = null } = {}) {
  const base = ['--from', snapFile, '--local', paths.localDb, '--retractions', paths.retractionsFile, '--json'];
  if (paths.mergeConfig) base.push('--merge-config', paths.mergeConfig);
  if (paths.mergeStateFile) base.push('--state', paths.mergeStateFile);
  if (archiveDir) base.push('--archive-dir', archiveDir);
  const remoteArg = remoteRetractions ? path.resolve(String(remoteRetractions)) : null;
  if (remoteArg) base.push('--retractions-from', remoteArg);
  if (forwardOut) base.push('--forward-out', path.resolve(String(forwardOut)));
  return { base, remoteArg };
}

/** 合并归档目录（每**次调用**唯一；`--home <沙箱>` 的演练不许往生产 `_archive` 堆快照）。 */
let mergeArchiveSeq = 0;
function nextMergeArchiveDir(paths) {
  mergeArchiveSeq += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(paths.archiveRoot ?? path.join(workspaceRoot(), '_archive'), `memory-merge-${stamp}-${process.pid}-${mergeArchiveSeq}`);
}

/**
 * 跑一轮 merge-memory（对端快照路径来自 snapFile）。返回 {dry, applied, skipped, error}。
 *
 * 【0.2.0 · I2-④ / B1】**台账真喂进去了**（改前这里只传 `--from/--local/--json`）：
 *   · 本机台账 `--retractions <paths.retractionsFile>`：**必须显式传**（合并器默认按 USERPROFILE 解析，
 *     `--home <沙箱>` 时默认路径会指到生产台账 —— 与 `--local` 那条坑同源）；
 *   · 对端台账 `--retractions-from <remoteRetractions>`：给了就传（文件不存在也传 —— 报告里能看到
 *     `retractions.remote.path` + `exists:false`，比"悄悄不传"好排障）；
 *   · `--apply-retractions` **只加在 `--apply` 那一路**：dry-run 只出「撤回计划 N 条」，绝不执行删除。
 */
export function mergeFromSnapshot(paths, snapFile, { apply, json, remoteRetractions = null, forwardOut = null } = {}) {
  // ⚠️ **必须显式传 `--local`**：不给的话 `merge-memory` 用它自己的 `localDbPath(HOME)` 解析默认生产库，
  //   于是 `--home <沙箱>` 只影响本脚本自己的路径解析、**合并却打在生产库上**
  //   （2026-10-11 本卡夹具演练实测踩到：演练条真的进了生产记忆库）。
  //   生产路径下两者逐字相同（`<home>/.dsh/memory/memory.db`）⇒ 行为不变，安全门也不变。
  const { base, remoteArg } = buildMergeArgs(paths, snapFile, { remoteRetractions, forwardOut, archiveDir: nextMergeArchiveDir(paths) });
  const dryRun = runNode(MERGE_SCRIPT, base);
  const dry = parseMergeJson(dryRun.stdout);
  if (!dry || dry.ok !== true) {
    return { ok: false, error: `dry-run 失败（exit ${dryRun.status}）：${dry?.error ?? tail(dryRun.stderr || dryRun.stdout)}`, dry: null };
  }
  const out = {
    ok: true, dry, applied: null, skippedApply: false,
    // 可核痕迹：本轮喂给合并器的台账实参（报告/日报直接引用，不用猜）
    retractionsArgs: {
      local: paths.retractionsFile,
      localExists: fs.existsSync(paths.retractionsFile),
      remote: remoteArg,
      remoteExists: remoteArg ? fs.existsSync(remoteArg) : false,
      applyRetractions: false,
      note: 'dry-run 只出撤回计划；--apply-retractions 只在 apply 那一路加',
    },
  };
  const changed = dry?.result?.changed === true && dry?.idempotency?.skipped !== true;
  out.changed = changed;
  if (!apply || !changed) { out.skippedApply = true; out.skipReason = apply ? 'no-change' : 'dry-run'; return out; }

  // 顺序纪律（写进代码而不是只写注释）：merge-memory 自己在 apply 段先并 inserts/updates、**再**执行撤回删除，
  //   且撤回删除前先把对端台账 append+fsync 进本机台账。本脚本只加开关，不自己删任何行 ⇒ "先合再撤回"由合并器保证。
  const ap = runNode(MERGE_SCRIPT, [...base, '--apply', '--allow-production', '--apply-retractions']);
  const body = parseMergeJson(ap.stdout);
  out.retractionsArgs.applyRetractions = true;
  if (!body || body.ok !== true) {
    return { ok: false, error: `apply 失败（exit ${ap.status}）：${body?.error ?? tail(ap.stderr || ap.stdout)}`, dry, applied: null };
  }
  return { ok: true, dry, applied: body, changed, skippedApply: false, retractionsArgs: out.retractionsArgs };
}

/** SQLite 写锁争用（**生产库 journal_mode=delete 时读者也会被阻塞**，实测 2026-10-11）。 */
const BUSY_RE = /database is locked|SQLITE_BUSY|ERR_SQLITE_ERROR/i;
/**
 * 【B案 · A29】**并发插入撞 id** 也算"可重试的争用"，但它与 `BUSY_RE` 性质不同：
 *   `merge-memory` 分配新 id 是「先读 `MAX(id)`、再插」两步 ⇒ 两个写者同时进来时，
 *   后者会撞 `UNIQUE constraint failed: memories.id`（**不是** database is locked）。
 *   合并器撞上会**报错退出、库不回退**（A45 起删了整库还原），但那一轮就白跑了 —— 退避重试第二次
 *   会读到已被对方推进的 `MAX(id)`（或发现内容哈希已存在⇒跳过）⇒ 正常收敛。
 *   ⚠️ 只给**新增的 inbox 前置步**开这层重试（`retryOnUnique`）；主合并路径语义一字不动
 *      （那是既有行为，改它属另一件事，登记在报告「待拍板 / 技术债」）。
 *   【2026-10-26 · 卡 A34】上面那两行是 **A29 当时的选择**（保留原文不改），今天按 A29 报告 §待拍板 A29-3 改了：
 *     **主合并也开**。理由 —— 主合并才是并发面最宽的那条：HOST_A 与 HOST_B 两台都是 driver（A29 设计），
 *     叠加 DSH 主进程自己写记忆 ⇒ 撞 id 的窗口真实存在；而撞上就整轮白跑（合并器**不再**从快照还原；快照只供人工恢复）。
 *     夹具在 `_archive\a29-fixtures-20261026\fixtures-a34.mjs`（G1 真并发撞 id / G2 非 UNIQUE 不吞 /
 *     G3 重试上限 / G4 等价），改前改后各跑一遍留读数。⚠️ 只开开关：**重试次数与退避算法一字未动**。
 */
const UNIQUE_RE = /UNIQUE constraint failed|SQLITE_CONSTRAINT/i;

/**
 * 带**退避重试**的合并（并发安全的关键一环）。
 *
 * 为什么必须重试：`merge-memory` 内部打开库时**没有设 busy timeout** ⇒ 撞上写者的锁立即抛
 * `database is locked`（2026-10-11 夹具实测：写者 15ms/条 时 351ms 的合并必然撞）。
 *   DSH 自己写记忆也是短事务，锁只在事务窗口内持有 ⇒ **退避重试**就能等到窗口。
 * 退避共 5 次（1+2+3+5+8 = 19 秒）；仍撞 ⇒ 交给调用方**让路**（exit 3，下一轮自然再来），
 *   **绝不**静默、也绝不把"库正忙"记成失败。
 *
 * @param {boolean} [opts.retryOnUnique=false] 连 `UNIQUE constraint failed: memories.id` 也退避重试
 *   （**默认值仍是 false，函数层面语义不变**：【B案 · A29】当初只给 inbox 前置步用）
 *   【A34 · 2026-10-26】两个**调用点**现在都显式传 `true`：inbox 前置步 + 主合并。
 */
async function mergeWithRetry(paths, snapFile, { apply, log, remoteRetractions = null, forwardOut = null, retryOnUnique = false }) {
  const delays = [1000, 2000, 3000, 5000, 8000];
  let last = null;
  for (let i = 0; i <= delays.length; i += 1) {
    const r = mergeFromSnapshot(paths, snapFile, { apply, remoteRetractions, forwardOut });
    if (r.ok) {
      if (i > 0) log(`[mem-sync] 合并：第 ${i + 1} 次尝试成功（前 ${i} 次撞写锁${retryOnUnique ? ' / 撞 id' : ''}）`);
      return r;
    }
    last = r;
    const busy = BUSY_RE.test(r.error ?? '');
    const collided = retryOnUnique && UNIQUE_RE.test(r.error ?? '');
    if (!busy && !collided) return r;
    if (i === delays.length) break;
    log(busy
      ? `[mem-sync] ⏳ memory.db 正被写（database is locked）⇒ ${delays[i]}ms 后重试（第 ${i + 2} 次）`
      : `[mem-sync] ⏳ 并发写者抢先占了 id（UNIQUE constraint failed: memories.id）⇒ ${delays[i]}ms 后重试（第 ${i + 2} 次）`);
    await new Promise((res) => setTimeout(res, delays[i]));
  }
  return { ...last, busyExhausted: true };
}

// ─────────────────── 转发通道（B6）：计划文件 → 只填投递副本 ───────────────────

/**
 * 读转发计划文件（合并器 `--forward-out` 的产物，形状 = `plan.partition.forward.rows` JSON 数组）。纯读、不抛。
 * @returns {{ok:boolean, file:string|null, exists:boolean, rows:object[], count:number, error:string|null}}
 */
export function readForwardPlan(file) {
  const out = { ok: false, file: file ?? null, exists: false, rows: [], count: 0, error: null };
  if (!file) { out.error = '未给转发计划文件路径'; return out; }
  if (!fs.existsSync(file)) { out.error = `转发计划文件不存在：${file}`; return out; }
  out.exists = true;
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { out.error = `转发计划读不出：${e?.message ?? e}`; return out; }
  let j;
  try { j = JSON.parse(txt); } catch (e) { out.error = `转发计划不是合法 JSON：${e?.message ?? e}`; return out; }
  if (!Array.isArray(j)) { out.error = '转发计划不是 JSON 数组（期望 plan.partition.forward.rows）'; return out; }
  out.ok = true; out.rows = j; out.count = j.length;
  return out;
}

/**
 * 把转发面填进**投递副本**（`<tmp>/self-memory.db`）—— 本脚本唯一会"写"的投递侧动作，且**只写副本**。
 *
 * 三条口径（卡面要求）：
 *   · 复用 lib 写库口径 `applyForwardRowsToDb`（内容哈希幂等 + `MAX(id)+1`），**不手写 SQL**；
 *   · 本机库一个字节都不写（`copyFile`/`VACUUM INTO` 出来的副本才是写入对象）；
 *   · 任何一步不成立（计划文件缺 / 坏 / 写库抛）⇒ `ok:false` + `stage`，**上层据此整轮不投**。
 *
 * @param {string} copyFile 投递副本路径
 * @param {{file?:string, rows?:object[]}} forward `rows` 给了就直接用（避免二次读盘），否则从 `file` 读
 * @returns {Promise<{ok:boolean, file:string|null, rows:number|null, inserted:number, skippedExisting:number,
 *            afterRows:number|null, stage:'plan'|'fill'|null, error:string|null}>}
 */
export async function fillForwardIntoCopy(copyFile, forward = {}, { log = () => {}, nowMs = Date.now() } = {}) {
  const info = {
    ok: false, file: forward.file ?? null, rows: null, inserted: 0, skippedExisting: 0, afterRows: null, stage: null, error: null,
  };
  let rows = Array.isArray(forward.rows) ? forward.rows : null;
  if (!rows) {
    const plan = readForwardPlan(forward.file);
    if (!plan.ok) { info.stage = 'plan'; info.error = plan.error; return info; }
    rows = plan.rows;
  }
  info.rows = rows.length;
  try {
    const r = await MM.applyForwardRowsToDb(copyFile, rows, { nowMs });
    info.inserted = r.inserted;
    info.skippedExisting = r.skippedExisting;
    info.afterRows = r.afterRows;
    info.ok = true;
    log(`[mem-sync] ✓ 转发面填进**投递副本**（本机库零写入）：新增 ${r.inserted} / 已存在跳过 ${r.skippedExisting}`
      + `（副本 ${r.beforeRows} → ${r.afterRows} 行）`);
    return info;
  } catch (e) {
    info.stage = 'fill';
    info.error = String(e?.message ?? e);
    return info;
  }
}

/**
 * driver 投递「本机快照」给 follower —— 从 `runOnce` 里抽出来，是为了能被夹具用**假 transport** 实测
 * 「中心**收到的**那份快照里 foreign 条都在」这条判据（只测函数返回值不够硬）。
 *
 * 顺序（改顺序 = 改安全语义）：
 *   ① `--db <paths.localDb>` 产本机快照副本（显式传库路径：`--home <沙箱>` 时不许去产生产库快照）
 *   ② **转发面先填副本**（`forward.required` 才做）⇒ 失败**立即返回、绝不 scp**
 *   ③ mkdir inbox + scp 快照
 *   ④ 撤回台账成对跟上（失败只进 warnings，不回滚快照投递）
 *
 * @param {{paths:object, alias:string, nowMs?:number, forward?:{required:boolean, file?:string, rows?:object[]},
 *          transport?:{scp:Function}, log?:Function, warnings?:string[]}} opts
 * @returns {Promise<{ok:boolean, delivered:string|null, remoteTarget:string|null, skipped:string|null, error:string|null,
 *            forward:object|null, retractionsDelivery:object|null, snapshot:object}>}
 */
export async function deliverSelfSnapshot(opts = {}) {
  const { paths, alias, nowMs = Date.now(), forward = null, transport = null, log = () => {}, warnings = [] } = opts;
  const out = {
    ok: false, delivered: null, remoteTarget: null, skipped: null, error: null,
    forward: null, retractionsDelivery: null, snapshot: { ok: false, path: null, bytes: null, sha256: null, rows: null },
  };
  const outLocal = path.join(paths.tmpDir, 'self-memory.db');
  if (fs.existsSync(outLocal)) fs.unlinkSync(outLocal);
  const snap = runNode(SNAP_SCRIPT, ['--out', outLocal, '--db', paths.localDb, '--json']);
  const meta = parseMergeJson(snap.stdout);
  if (snap.status !== 0 || !meta?.sha256) {
    out.skipped = 'snapshot-failed';
    out.error = tail(snap.stderr || snap.stdout);
    warnings.push(`本机快照失败：${out.error}`);
    log(`[mem-sync] ⚠️ 投递跳过：本机快照失败 ${tail(snap.stderr || snap.stdout, 200)}`);
    return out;
  }
  out.snapshot = { ok: true, path: outLocal, bytes: meta.bytes ?? null, sha256: meta.sha256, rows: meta.rows ?? null };

  // ── ② 转发面填副本（**只在这份副本上**）──
  if (forward?.required) {
    const filled = await fillForwardIntoCopy(outLocal, forward, { log, nowMs });
    out.forward = filled;
    if (!filled.ok) {
      out.skipped = 'forward-fill-failed';
      out.error = `转发面填充失败（stage=${filled.stage ?? '?'}）：${filled.error}`;
      return out;                       // ← 绝不 scp：不拿"不完整副本"冒充完整
    }
  }

  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const remoteName = `${snapshotPrefix()}-${stamp}-${meta.sha256.slice(0, 8)}.db`;
  const remoteTarget = `${paths.inbox.replace(/\\/g, '/')}/${remoteName}`;
  out.remoteTarget = remoteTarget;
  ssh(alias, ['cmd', '/c', 'if', 'not', 'exist', `"${paths.inbox}"`, 'mkdir', `"${paths.inbox}"`]);
  const up = (transport?.scp ?? scp)(outLocal, `${alias}:${remoteTarget}`);
  if (!up?.ok) {
    out.skipped = 'upload-failed';
    out.error = tail(up?.stderr || up?.error, 200);
    warnings.push(`投递失败：${out.error}`);
    log(`[mem-sync] ⚠️ 投递失败（follower 下轮仍用旧快照）：${out.error}`);
    return out;
  }
  out.ok = true;
  out.delivered = remoteName;
  log(`[mem-sync] ✓ 已投递本机快照 → 对端 inbox：${remoteName}`
    + (out.forward ? `（含转发面新增 ${out.forward.inserted} 条 / 已存在跳过 ${out.forward.skippedExisting}）` : ''));
  // 台账**成对**跟上（只在快照真送达后才投 —— 快照没到，孤零零的台账没人会配对读）
  out.retractionsDelivery = deliverRetractions({
    alias, inbox: paths.inbox, localLedger: paths.retractionsFile, dbName: remoteName, log, warnings, transport,
  });
  return out;
}

// ─────────────────────────────── 清理 ───────────────────────────────

/** 清理本机 `_archive/memory-merge-*`，保留最近 keep 个（**只碰这个命名模式**，不跟链接）。 */
export function pruneMergeArchives(archiveRoot, keep) {
  if (!keep || keep <= 0) return { removed: 0, kept: 0 };
  let names = [];
  try { names = fs.readdirSync(archiveRoot); } catch { return { removed: 0, kept: 0 }; }
  const cands = names
    .filter((n) => /^memory-merge-\d{4}-\d{2}-\d{2}T/.test(n))
    .map((n) => {
      const p = path.join(archiveRoot, n);
      try {
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink() || !st.isDirectory()) return null;   // 链接/非目录一律不碰
        return { p, mtimeMs: st.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  for (const c of cands.slice(keep)) {
    try { fs.rmSync(c.p, { recursive: true, force: true }); removed += 1; } catch { /* 忽略 */ }
  }
  return { removed, kept: Math.min(keep, cands.length) };
}

/**
 * **向量水位回退**（合并插入的行「向量扫不到」的根治）。
 *
 * 为什么需要：向量增量同步的判据是 `memories.updated_at > 水位`（`memory-engine/lib/sync.mjs`
 *   主路径）。而合并**插入**的行 `updated_at` 用的是**对端原值**（可能远早于本机水位 —— 实测
 *   2026-10-11 本机水位 `17:56`，插入行最早 `2026-08-27`）⇒ 这些行**天然扫不到**，向量库长出缺口
 *   （实测 HOST_A 记忆 1264 / 向量 1233，缺 31 条）。
 * 修法：把水位**回退**到这批新 id 的最小 `updated_at - 1`，让下一轮增量重扫那一段。
 *   代价极小且**幂等**：重扫时 hash 未变的行会 `skippedSameHash` 直接跳过，只有真正缺的才编码。
 * 边界：只写**派生库** `vectors.db` 的 `meta`（可重建），绝不碰记忆库；失败只 warning 不阻断。
 *
 * @returns {Promise<{rewound:boolean, from?:number, to?:number, ids?:number, reason?:string}|null>}
 */
export async function rewindVectorWatermark(paths, ids, log = () => {}) {
  const list = (ids ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (!list.length) return { rewound: false, reason: 'no-inserted-ids' };
  const vectorsDb = path.join(paths.home, 'memory-vectors', 'vectors.db');
  if (!fs.existsSync(vectorsDb)) return { rewound: false, reason: 'no-vectors-db' };
  const { DatabaseSync } = await import('node:sqlite');
  const mem = new DatabaseSync(paths.localDb, { readOnly: true });
  let minU = null;
  try {
    const ph = list.map(() => '?').join(',');
    const r = mem.prepare(`SELECT MIN(updated_at) AS m FROM memories WHERE id IN (${ph})`).get(...list);
    minU = Number(r?.m ?? NaN);
  } finally { mem.close(); }
  if (!Number.isFinite(minU)) return { rewound: false, reason: 'min-updated-at-not-found' };

  const target = Math.max(0, minU - 1);
  let v = null;
  try {
    v = new DatabaseSync(vectorsDb, { timeout: 20_000 });
    // ⚠️ 水位键是**按来源命名空间**的（`memory-engine/lib/vectors-store.mjs` 的 SOURCE_SCOPED_META_KEYS）：
    //   现行键 = `lastIncrementalSyncAt:memory`，而**无后缀**的同名键是「老库尚未迁移」时的兼容读。
    //   只写无后缀键 = **完全无效**（读取优先拿 `:memory`）—— 2026-10-11 本卡实测踩过。
    //   ⇒ 两条都认：写的时候**存在的行全更新**，一条都不存在则补插命名空间键。
    const rows = v.prepare("SELECT k, v FROM meta WHERE k IN ('lastIncrementalSyncAt:memory','lastIncrementalSyncAt')").all();
    if (!rows.length) {
      v.exec('BEGIN IMMEDIATE');
      v.prepare("INSERT INTO meta (k, v) VALUES ('lastIncrementalSyncAt:memory', ?)").run(String(target));
      v.exec('COMMIT');
      log(`[mem-sync] 向量水位：新建命名空间键 lastIncrementalSyncAt:memory = ${new Date(target).toISOString()}（新增 ${list.length} 条里最早的 updated_at 之前）`);
      return { rewound: true, from: null, to: target, ids: list.length, keys: ['lastIncrementalSyncAt:memory'] };
    }
    const nsRow = rows.find((r) => r.k === 'lastIncrementalSyncAt:memory');
    const effRow = nsRow ?? rows.find((r) => r.k === 'lastIncrementalSyncAt');
    const cur = Number(effRow?.v ?? 0);
    if (!(target < cur)) return { rewound: false, reason: 'watermark-already-low-enough', from: cur, to: target };
    v.exec('BEGIN IMMEDIATE');
    const upd = v.prepare('UPDATE meta SET v = ? WHERE k = ?');
    for (const r of rows) upd.run(String(target), r.k);
    v.exec('COMMIT');
    log(`[mem-sync] 向量水位回退：${new Date(cur).toISOString()} → ${new Date(target).toISOString()}`
      + `（键 ${rows.map((r) => r.k).join(' + ')}；新增 ${list.length} 条里最早的 updated_at 之前 ⇒ 下一轮增量能扫到它们；hash 未变的行会自动跳过）`);
    return { rewound: true, from: cur, to: target, ids: list.length, keys: rows.map((r) => r.k) };
  } catch (e) {
    try { v?.exec('ROLLBACK'); } catch { /* 忽略 */ }
    return { rewound: false, reason: `error:${e?.message ?? e}` };
  } finally { try { v?.close(); } catch { /* 忽略 */ } }
}

/**
 * 只读比对：向量库里 `source='memory'` 的 ref_id 是否覆盖了记忆库全部 id（找缺口）。
 * 用途 = `--heal-vectors` 补齐模式 / 验收判据「向量一致性」的读数。
 */
export async function findVectorGaps(paths) {
  const vectorsDb = path.join(paths.home, 'memory-vectors', 'vectors.db');
  const out = { memRows: null, vecRows: null, missing: [], extra: 0, vectorsDb };
  if (!fs.existsSync(vectorsDb)) { out.error = 'no-vectors-db'; return out; }
  const { DatabaseSync } = await import('node:sqlite');
  const mem = new DatabaseSync(paths.localDb, { readOnly: true });
  let memRows = [];
  try { memRows = mem.prepare('SELECT id FROM memories').all(); } finally { mem.close(); }
  const v = new DatabaseSync(vectorsDb, { readOnly: true });
  let vecRows = [];
  try { vecRows = v.prepare("SELECT ref_id FROM vectors WHERE source='memory'").all(); } finally { v.close(); }
  const vecIds = new Set(vecRows.map((r) => String(r.ref_id)));
  const memIds = new Set(memRows.map((r) => String(r.id)));
  out.memRows = memIds.size;
  out.vecRows = vecIds.size;
  out.missing = [...memIds].filter((i) => !vecIds.has(i)).map((s) => Number(s)).filter(Number.isFinite);
  out.extra = [...vecIds].filter((i) => !memIds.has(i)).length;
  return out;
}

/**
 * 【0.2.0】快照 ↔ 撤回台账的**成对命名**口径：`x.db` → `x-retractions.jsonl`。
 * 投递侧与接收侧都用它 ⇒ 命名规则只有一份，改这里就两边一起改。
 */
export function retractionsSiblingName(dbFileName) {
  const s = String(dbFileName ?? '');
  if (!s) return null;
  if (s.toLowerCase().endsWith('-retractions.jsonl')) return s;
  return `${s.replace(/\.db$/i, '')}-retractions.jsonl`;
}

/**
 * 【0.2.0】从"对端快照文件"推出"对端台账文件"的绝对路径（不判存在）。
 * 只在 `--from` 是**文件**（driver 拉回的快照 / follower 的 inbox 快照）时有意义。
 * @returns {string|null} 推不出（无文件名）⇒ null
 */
export function inferRemoteRetractionsPath(snapFile) {
  const s = String(snapFile ?? '');
  if (!s) return null;
  const name = retractionsSiblingName(path.basename(s));
  return name ? path.join(path.dirname(path.resolve(s)), name) : null;
}

/** 列出 inbox 里可直接用的快照（过滤：命名匹配 + 是文件 + 非链接 + mtime 早于 minAgeMs）。 */
export function listInboxSnapshots(inbox, { minAgeMs = 60_000, nowMs = Date.now() } = {}) {
  let names = [];
  try { names = fs.readdirSync(inbox); } catch { return []; }
  return names
    .filter((n) => /-memory-\d{8}-\d{6}-[0-9a-f]{8}\.db$/.test(n) || /^peer-memory.*\.db$/.test(n) || n.endsWith('.db'))
    .map((n) => {
      const p = path.join(inbox, n);
      try {
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink() || !st.isFile()) return null;
        if (nowMs - st.mtimeMs < minAgeMs) return null;             // 可能还在传输中 ⇒ 本轮不碰
        return { p, name: n, mtimeMs: st.mtimeMs, bytes: st.size };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** inbox 只留最近 keep 个（driver 投递的 `*-memory-*.db`）；【0.2.0】连成对台账一起清（否则 jsonl 只增不减）。 */
export function pruneInbox(inbox, keep, { nowMs = Date.now() } = {}) {
  if (!keep || keep <= 0) return { removed: 0 };
  const all = listInboxSnapshots(inbox, { minAgeMs: 0, nowMs });
  let removed = 0;
  let removedLedgers = 0;
  for (const c of all.slice(keep)) {
    try { fs.unlinkSync(c.p); removed += 1; } catch { /* 忽略 */ }
    // 【0.2.0】成对清：删快照时把它配对的 `-retractions.jsonl` 一起删，**只删严格同名推出来的那一个**
    const sib = path.join(path.dirname(c.p), retractionsSiblingName(path.basename(c.p)));
    try { if (fs.existsSync(sib)) { fs.unlinkSync(sib); removedLedgers += 1; } } catch { /* 忽略 */ }
  }
  return { removed, kept: Math.min(keep, all.length), removedLedgers };
}

/**
 * 【B案 · A29 · 2026-10-26】driver **先吃掉本机 inbox**里最新那份快照。
 *
 * 为什么必须有这一步（方案 §1-8 的病根）：
 *   原 driver 分支只有「探对端 → 拉对端快照 → 合并本机 → 投本机快照给对端 inbox」，
 *   **从不读自己的 inbox**。B 案把中心换成 HOST_B（driver）后，HOST_A 仍以 driver 身份
 *   把「本机合并后全量」投进 HOST_B 的 inbox ⇒ 没人吃就烂在那儿，
 *   **中心反而成了三台里最不全的那台**。这一步就是补上那个"吃"的动作。
 *
 * 语义与安全性（四条，改动前先读）：
 *   · **只吃最新一份**：inbox 里每份都是"对端本机全量快照"（不是增量）⇒ 最新即最全，
 *     追旧账无收益；`pruneInbox` 保留 `--keep` 份，所以吃到的那份不会立刻消失。
 *   · **合并器按内容哈希幂等**（`merge-memory` 的运行键 + `applyForwardRowsToDb`）⇒
 *     同一份快照重复吃不重复插入（follower 分支早就在用同一套）。
 *   · **与主合并共用同一把库写锁** ⇒ 撞锁走 `mergeWithRetry` 的退避（1+2+3+5+8 = 19 秒）；
 *     退避用尽只记 `db-busy`、**不丢条**（下一轮再来，快照还在）。
 *   · **失败不阻断主流程**：调用方 try/catch 包住 —— 宁可这轮没吃 inbox，
 *     也不能因为 inbox 里躺着一份坏文件就让"拉对端 / 投对端"整轮停摆。
 *
 * @returns {Promise<{ok:boolean, inbox:string, scanned:number, picked:string|null, bytes:number|null,
 *   mtime:string|null, changed:boolean|null, skipped:string|null, applied:object|null,
 *   pruned:object|null, retractions:object|null, busy:boolean, error:string|null}>}
 */
export async function intakeLocalInbox(paths, { apply = false, log = () => {}, nowMs = Date.now() } = {}) {
  const out = {
    ok: false, inbox: paths.inbox, scanned: 0, picked: null, bytes: null, mtime: null,
    changed: null, skipped: null, applied: null, pruned: null, retractions: null, busy: false, error: null,
  };
  const cands = listInboxSnapshots(paths.inbox, { minAgeMs: paths.minAgeMs, nowMs });
  out.scanned = cands.length;
  if (!cands.length) {
    out.skipped = 'no-inbox-snapshot';
    log(`[mem-sync] 本机 inbox：无可用快照（${out.inbox}）⇒ 本步零动作（本机不是任何叶子的投递目标时就是这样）`);
    return out;
  }
  const pick = cands[0];
  out.picked = pick.name; out.bytes = pick.bytes; out.mtime = new Date(pick.mtimeMs).toISOString();
  log(`[mem-sync] 本机 inbox：可用 ${cands.length} 份 ⇒ **吃最新 1 份** ${pick.name}`
    + `（${pick.bytes} 字节 · ${out.mtime}）`
    + (cands.length > 1 ? ` · 其余 ${cands.length - 1} 份是更早的全量快照（最新即最全，不追）` : ''));
  // 对端撤回台账成对到达则一起喂（口径同 follower 分支：推不出就只合并不撤回，宁可少撤不乱删）
  const inferred = inferRemoteRetractionsPath(pick.p);
  const remoteRetractions = (inferred && fs.existsSync(inferred)) ? inferred : null;
  out.retractions = { path: inferred, found: remoteRetractions != null };

  const m = await mergeWithRetry(paths, pick.p, { apply, log, remoteRetractions, forwardOut: null, retryOnUnique: true });
  out.changed = m.changed === true;
  out.busy = m.busyExhausted === true;
  if (!m.ok) {
    out.skipped = m.busyExhausted ? 'db-busy' : 'merge-failed';
    out.error = m.error ?? 'merge failed';
    log(`[mem-sync] ⚠️ 本机 inbox 合并未完成（${out.skipped}）：${out.error}`
      + ` ⇒ 快照留在 inbox，下一轮再来`);
    return out;
  }
  out.ok = true;
  out.applied = m.applied ? {
    inserted: m.applied.applied?.inserted ?? 0,
    updated: m.applied.applied?.updated ?? 0,
    deleted: m.applied.applied?.deleted ?? 0,
    rows: m.applied.result?.rows ?? null,
    archive: m.applied.archiveDir ?? null,
  } : null;
  if (m.skippedApply) {
    out.skipped = m.skipReason ?? 'no-change';
    log(`[mem-sync] 本机 inbox：无需写入（${out.skipped}）`
      + ` · 本机 ${m.dry?.local?.rows ?? '?'} 条 / 快照 ${m.dry?.from?.rows ?? '?'} 条`);
  } else {
    log(`[mem-sync] ✓ 本机 inbox 已吃下（${pick.name}）：插入 ${out.applied.inserted} / 更新 ${out.applied.updated}`
      + ` / 删除 ${out.applied.deleted} ⇒ 本机 ${out.applied.rows} 条`);
  }
  // 吃过之后才修剪（失败不修剪 —— 保住"还没吃成功"的那份证据）
  out.pruned = pruneInbox(paths.inbox, paths.keep, { nowMs });
  return out;
}

// ─────────────────────────────── 主流程 ───────────────────────────────

function localDbInfo(dbPath) {
  try {
    const st = fs.statSync(dbPath);
    return { exists: true, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch { return { exists: false }; }
}

async function readLocalRows(dbPath) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const r = db.prepare('SELECT COUNT(*) AS c, MAX(id) AS mx FROM memories').get();
      return { rows: Number(r.c), maxId: Number(r.mx ?? 0) };
    } finally { db.close(); }
  } catch { return null; }
}

export async function runOnce({ flags = {}, hostname = os.hostname(), nowMs = Date.now() } = {}) {
  const paths = resolvePaths(flags);
  const apply = flags.apply === true && flags['dry-run'] !== true;
  const json = flags.json === true;
  const lines = [];
  const log = (s) => lines.push(s);
  const { role, reason } = resolveRole(hostname, flags.role);

  const state = readJsonFile(paths.stateFile) ?? {};
  const result = {
    at: new Date(nowMs).toISOString(), device: hostname, role, roleReason: reason,
    apply, via: null, peer: null, peerCommit: null,
    localBefore: null, localAfter: null, changed: null, applied: null,
    vectors: null, pruned: null, deferred: null, error: null, warnings: [],
    // 【R12】通道短租的可核痕迹（**纯增量字段**，既有字段语义一字未动）：
    //   channelRent = 共用件给出的"本轮租没租 / 进短租前隧道是什么状态"；channelRelease = 收尾归还结果。
    channelRent: null, channelRelease: null,
    // 【0.2.0 · I2-④】撤回台账面的三个可核字段（纯增量）：
    //   retractions = 本轮喂给合并器的台账实参 + 撤回计划/执行读数；retractionsRemote = 对端台账来自哪；
    //   retractionsDelivery = driver 侧"台账有没有跟上快照"（ok / skipped / error）。
    retractions: null, retractionsRemote: null, retractionsDelivery: null,
    // 【0.3.0 · 拓扑守卫 / 转发通道】三个纯增量字段：
    //   partition = 本轮读到的归属过滤配置（文件不存在 ⇒ enabled:false）；topologyGuard = 守卫判定 + 拦没拦；
    //   forward = 转发面（计划行数 / 填了几条 / 失败在哪一段）；delivery = 投递结果（含跳过原因）。
    partition: null, topologyGuard: null, forward: null, delivery: null,
    // 【B案 · A29】driver 先吃本机 inbox 的两个纯增量字段（follower 恒为 null）：
    //   inboxIntake = 吃的结果（扫到几份 / 吃哪份 / 插入几条 / 修掉几份 / 跳过原因）；
    //   localAfterIntake = 吃之后的**本机行数**（判据 5「lastLocalRows 上涨」靠它定位是"吃来的"还是"拉来的"）。
    inboxIntake: null, localAfterIntake: null,
  };

  const finishState = (status, exitCode, extra = {}) => {
    // 【A28】连续 deferred 计数（**只加字段**；既有键语义一字不动）
    const prevDeferred = Number.isFinite(Number(state.deferredStreak)) && Number(state.deferredStreak) > 0
      ? Math.trunc(Number(state.deferredStreak)) : 0;
    const deferredStreak = status === 'deferred' ? prevDeferred + 1 : 0;
    const deferredStreakSince = status === 'deferred'
      ? (typeof state.deferredStreakSince === 'string' && state.deferredStreakSince ? state.deferredStreakSince : result.at)
      : null;
    const next = {
      schema: 1, ...state,
      device: hostname, role,
      lastRunAt: result.at, lastStatus: status, lastExitCode: exitCode,
      lastVia: result.via, lastPeer: result.peer, lastPeerCommit: result.peerCommit,
      lastLocalRows: result.localAfter ?? result.localBefore,
      lastApplied: result.applied ? { inserted: result.applied.inserted, updated: result.applied.updated, deleted: result.applied.deleted } : null,
      lastVectors: result.vectors, lastError: result.error, lastDeferred: result.deferred,
      // 【B案 · A29】driver 前置步的**跨机可核读数**（纯增量键；follower 恒为 null）
      //   记它是因为「中心到底吃没吃叶子投来的快照」只能从 state 一眼看出，否则得去翻 tickd 日志。
      lastInboxIntake: result.inboxIntake ?? null,
      lastLocalAfterIntake: result.localAfterIntake ?? null,
      failures: (state.failures ?? 0) + (exitCode === EXIT.FAIL ? 1 : 0),
      // 【A28】连续 deferred 的三个新键 + 「本段已报过」标记（非 deferred 轮一律复位）
      deferredStreak, deferredStreakSince,
      deferredAlerted: status === 'deferred' ? state.deferredAlerted === true : false,
      ...extra,
    };
    if (status !== 'deferred') {
      next.history = [{ at: result.at, status, via: result.via, changed: result.changed,
        inserted: result.applied?.inserted ?? 0, rows: result.localAfter ?? result.localBefore ?? null },
      ...(Array.isArray(state.history) ? state.history : [])].slice(0, 48);
    }
    // 【A28】连续 deferred ≥3 轮 ⇒ 写一行告警（默认关；同一段只报一次）—— 必须在落盘**之前**，
    //   否则 `deferredAlerted` 的这次置位写不进 state，下一轮又会重报（重复吵）。
    if (status === 'deferred') {
      result.deferredStreak = deferredStreak;
      if (deferredStreak >= DEFERRED_ALERT_STREAK) {
        const sw = readDeferredAlertSwitch({ home: paths.home });
        result.deferredAlertSwitch = sw;
        if (!sw.enabled) {
          result.deferredAlert = { fired: false, why: 'switch-off', reason: sw.reason, streak: deferredStreak, file: paths.alertLog };
          log(`[mem-sync] 连续 ${deferredStreak} 轮 deferred（告警开关=关：${sw.reason}）`);
        } else if (next.deferredAlerted === true) {
          result.deferredAlert = { fired: false, why: 'already-alerted-this-streak', streak: deferredStreak, file: paths.alertLog };
          log(`[mem-sync] 连续 ${deferredStreak} 轮 deferred（本段已报过，不重复吵）`);
        } else {
          const line = `mem-sync 连续 ${deferredStreak} 轮 deferred（≈${deferredStreak} 小时 · 自 ${deferredStreakSince} 起`
            + ` · 末轮原因 ${result.deferred ?? 'unknown'} · 对端 ${result.peer ?? '-'} · via ${result.via ?? '-'}）`
            + ' ⇒ **跨机同步已停下等人**，别只看 history 以为没事'
            + ` · source=mem-sync · 关回：env ${DEFERRED_ALERT_ENV}=off，或把 ${sw.file} 的 enabled 改 false`;
          appendAlert(paths.alertLog, line);
          next.deferredAlerted = true;
          result.deferredAlert = { fired: true, streak: deferredStreak, line, file: paths.alertLog };
          log(`[mem-sync] ⚠️ 连续 ${deferredStreak} 轮 deferred ⇒ 已写告警：${paths.alertLog}`);
        }
      }
    }
    try { fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true }); const dw = writeStateText(path.basename(paths.stateFile), JSON.stringify(next, null, 2), { home: path.dirname(paths.stateFile), write: (p, t) => fs.writeFileSync(p, t, 'utf8') }); if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown')); } catch { /* 忽略 */ }
    return next;
  };

  if (!role) {
    result.deferred = 'unknown-host';
    log(`[mem-sync] 让路：本机 ${hostname} 未被声明为同步角色（声明方式 --role driver|follower，或加入 ROLE_BY_HOST）⇒ 安全跳过`);
    finishState('deferred', EXIT.DEFER);
    return { ok: true, exitCode: EXIT.DEFER, lines, report: result };
  }

  // ── 归属过滤配置（**只读**；文件不存在 ⇒ enabled:false ⇒ 守卫不适用、转发不启用 = 与接线前逐字同行为）──
  //    ⚠️ 本脚本**从不创建** `butler-merge-config.json`（今天生产不存在，本卡保持它不存在）。
  const partitionCfg = MM.readPartitionConfig(paths.mergeConfig, { host: hostname });
  result.partition = {
    path: partitionCfg.path, exists: partitionCfg.exists,
    enabled: partitionCfg.enabled, mode: partitionCfg.mode,
    host: partitionCfg.hostCanonical ?? null,
    hubHost: partitionCfg.hubHostCanonical ?? null, hubHostReason: partitionCfg.hubHostReason,
    reason: partitionCfg.reason,
  };
  if (partitionCfg.warnings?.length) result.warnings.push(...partitionCfg.warnings);
  // 转发面只在「edge + driver」下需要（hub 全收 ⇒ 本机库已含全部事实；follower 不投递）
  const forwardRequired = partitionCfg.enabled === true && partitionCfg.mode === 'edge' && role === 'driver';

  const dbInfo = localDbInfo(paths.localDb);
  if (!dbInfo.exists) {
    result.deferred = 'no-local-db';
    log(`[mem-sync] 让路：本机记忆库不存在 ${paths.localDb}（安全跳过，不建库）`);
    finishState('deferred', EXIT.DEFER);
    return { ok: true, exitCode: EXIT.DEFER, lines, report: result };
  }
  result.localBefore = (await readLocalRows(paths.localDb))?.rows ?? null;

  // ── `--heal-vectors`：只读比对向量缺口 → 回退水位 → 重跑增量（不合并、不开通道）──
  //    用途：合并插入的行若因 updated_at 陈旧被增量漏掉，本模式把它们补齐（也可挂低频兜底 job）。
  if (flags['heal-vectors']) {
    const gaps = await findVectorGaps(paths);
    result.vectorGaps = { ...gaps, missing: gaps.missing.length, missingSample: gaps.missing.slice(0, 8) };
    if (gaps.error) {
      result.error = `向量库不可用：${gaps.error}`;
      log(`[mem-sync] ✗ ${result.error}`);
      finishState('failed', EXIT.FAIL);
      return { ok: false, exitCode: EXIT.FAIL, lines, report: result };
    }
    if (!gaps.missing.length) {
      log(`[mem-sync] 向量一致性：**无缺口**（记忆 ${gaps.memRows} / 向量 ${gaps.vecRows}）`);
      finishState('ok', EXIT.OK);
      return { ok: true, exitCode: EXIT.OK, lines, report: result };
    }
    log(`[mem-sync] 向量缺口 ${gaps.missing.length} 条（记忆 ${gaps.memRows} / 向量 ${gaps.vecRows}，示例 ${gaps.missing.slice(0, 5).join(',')}）`);
    if (!apply) {
      log('[mem-sync] dry-run：**不回退水位、不跑向量**（加 --apply 才补）');
      finishState('ok', EXIT.OK);
      return { ok: true, exitCode: EXIT.OK, lines, report: result };
    }
    result.vectorsWatermark = await rewindVectorWatermark(paths, gaps.missing, log);
    const v = runNode(TICK_RUNNER, ['--job', 'memory-vectors', '--script', VECTORS_SCRIPT,
      '--allow-host', String(hostname).toLowerCase(), '--json'], { timeout: 30 * 60 * 1000 });
    const vb = parseMergeJson(v.stdout);
    result.vectors = { exitCode: v.status, ok: v.status === 0 || v.status === EXIT.DEFER || v.status === 7, state: vb?.state?.lastSync ?? null };
    const after = await findVectorGaps(paths);
    result.vectorGapsAfter = { memRows: after.memRows, vecRows: after.vecRows, missing: after.missing.length, extra: after.extra };
    log(`[mem-sync] ✓ 补齐后：记忆 ${after.memRows} / 向量 ${after.vecRows} · 仍缺 ${after.missing.length} 条`
      + `（向量 exit ${v.status}${v.status === 7 ? ' = 锁被占，下轮再来' : ''}）`);
    finishState(after.missing.length === 0 ? 'ok' : 'partial', EXIT.OK);
    return { ok: true, exitCode: EXIT.OK, lines, report: result };
  }

  // 清理本机合并快照目录（每轮一次，两侧都做）
  result.pruned = { archives: pruneMergeArchives(paths.archiveRoot, paths.keep) };

  // ── 【B案 · A29】driver **先吃掉本机 inbox**（中心 HOST_B 也要收叶子投来的快照）──────────
  //   位置为什么在「探对端」**之前**（别挪到 driver 分支里头）：对端（HOST_C）不可达时 driver 会
  //     提前 `deferred` 返回 —— 若把收 inbox 写在后面，中心会在"连不上叶子"的每一轮里都
  //     **不吃叶子已经送到的数据**，那正是本方案最怕的静默。
  //   对 HOST_A（它也是 driver）**行为等价**：它的 inbox 本来就不存在/为空 ⇒ 扫到 0 份 ⇒
  //     只多一行日志 + 一个 report 字段，零写入、零网络动作。
  //   开关：`--no-inbox-intake`（单次关回；刻意不做持久开关 —— 关掉它中心就不全）。
  if (role === 'driver' && flags['no-inbox-intake'] !== true) {
    try {
      result.inboxIntake = await intakeLocalInbox(paths, { apply, log, nowMs });
      if (result.inboxIntake.changed === true) {
        result.localAfterIntake = (await readLocalRows(paths.localDb))?.rows ?? null;
      }
    } catch (e) {
      result.inboxIntake = { ok: false, error: String(e?.message ?? e), stage: 'intake' };
      result.warnings.push(`本机 inbox 合并失败（不阻断主流程）：${result.inboxIntake.error}`);
      log(`[mem-sync] ⚠️ 本机 inbox 合并失败（**不阻断**后面的拉/合/投）：${result.inboxIntake.error}`);
    }
  }

  // ── 取对端快照 ──
  let snapFile = null;
  /** 【0.2.0】**对端**撤回台账路径（`--retractions-from` 的实参）。推不出来 ⇒ null（只合并不撤回）。 */
  let remoteRetractions = null;
  let lease = null;                 // 【R12】本轮**由本 job 开起来**的隧道租约（共用件）；没租 = null
  try {
    if (role === 'driver') {
      const probe = probePeer(paths, flags, { dryRun: !apply, log });
      result.via = probe.via;
      result.channelTrace = probe.trace;
      result.channelRent = probe.rent ?? null;
      lease = probe.lease ?? null;
      const rented = lease != null;
      if (!probe.via) {
        result.deferred = probe.wouldRent ? 'peer-unreachable-would-rent' : 'peer-unreachable';
        // 纯增量：对端没连上 ⇒ 本轮**没做**拓扑判定（如实写，不假装拦过/放行过）
        result.topologyGuard = {
          blocked: false, reason: MM.TOPOLOGY_GUARD_REASONS.PEER_UNREACHABLE,
          detail: '对端不可达 ⇒ 本轮未做拓扑判定（先让路，下轮再看）',
          peerHostname: null, peerCanonical: null, hubHost: partitionCfg.hubHostCanonical ?? null,
        };
        log(`[mem-sync] 让路：对端不可达（lan/tunnel/${flags['no-tunnel-rent'] ? '' : 'rent '}均不通）`
          + `，本轮跳过并记日报（家网/隧道恢复后自动收敛）`);
        finishState('deferred', EXIT.DEFER);
        return { ok: true, exitCode: EXIT.DEFER, lines, report: result };
      }
      result.peer = `${probe.alias}(${probe.via}${probe.hostname ? `/${probe.hostname}` : ''})`;

      // ── 拓扑守卫（**拉对端快照之前**判；拦下 ⇒ 本轮不拉/不合/不投，exit 3 与「对端不可达」同类）──
      //    判据全在 lib 纯函数里（`checkTopologyGuard`）；本处只做"接线 + 留证 + 告警 + 让路"。
      const guard = MM.checkTopologyGuard({ hostname, role, partition: partitionCfg, peerHostname: probe.hostname });
      result.topologyGuard = {
        blocked: guard.blocked, reason: guard.reason, detail: guard.detail,
        peerHostname: guard.peerHostname, peerCanonical: guard.peerCanonical,
        hostCanonical: guard.hostCanonical, hubHost: guard.hubHostCanonical ?? null, hubHostRaw: guard.hubHost,
        hubHostReason: partitionCfg.hubHostReason,
      };
      if (guard.warnings?.length) {
        for (const w of guard.warnings) result.warnings.push(`拓扑守卫：${w}`);
        log(`[mem-sync] ⚠️ 拓扑守卫：${guard.warnings.join('；')}`);
      }
      if (guard.blocked) {
        result.deferred = 'topology-guard';
        log(`[mem-sync] ⛔ 拓扑守卫拦下（${guard.reason}）：${guard.detail}`);
        appendAlert(paths.alertLog, `mem-sync 拓扑守卫拦下（${guard.reason}）：${guard.detail}`);
        finishState('deferred', EXIT.DEFER);
        return { ok: true, exitCode: EXIT.DEFER, lines, report: result };
      }
      if (guard.reason !== MM.TOPOLOGY_GUARD_REASONS.PARTITION_OFF) {
        log(`[mem-sync] 拓扑守卫：放行（${guard.reason}）—— ${guard.detail}`);
      }
      const rentNote = rented
        ? (probe.rent?.downOnRelease === false
          ? ' · **借道**（进短租前隧道已 enabled —— 只销自己的租约、**不关别人的隧道**）'
          : ' · **按需短租**（本轮由我开起，收尾立刻 down）')
        : '';
      log(`[mem-sync] 对端通道：${probe.via} → ${probe.alias}${probe.hostname ? ` · hostname=${probe.hostname}` : ''}${rentNote}`);

      fs.mkdirSync(paths.tmpDir, { recursive: true });
      const remoteOut = path.join(process.env.TEMP || os.tmpdir(), 'dsh-mem-sync', 'peer-memory.db').replace(/\\/g, '/');
      const remote = ssh(probe.alias, ['node', `${REMOTE_DH}\\mem-snapshot-remote.mjs`, '--json', '--out', remoteOut], { timeout: 5 * 60 * 1000 });
      if (!remote.ok) {
        result.error = `对端产快照失败（exit ${remote.status}）：${tail(remote.stderr || remote.stdout)}`;
        log(`[mem-sync] ✗ ${result.error}`);
        finishState('failed', EXIT.FAIL);
        return { ok: false, exitCode: EXIT.FAIL, lines, report: result };
      }
      const rmeta = parseMergeJson(remote.stdout);
      const local = path.join(paths.tmpDir, `peer-memory.db`);
      if (fs.existsSync(local)) fs.unlinkSync(local);
      const dl = scp(`${probe.alias}:${rmeta?.out ?? remoteOut}`, local);
      if (!dl.ok) {
        result.error = `拉取对端快照失败（exit ${dl.status}）：${tail(dl.stderr)}`;
        log(`[mem-sync] ✗ ${result.error}`);
        finishState('failed', EXIT.FAIL);
        return { ok: false, exitCode: EXIT.FAIL, lines, report: result };
      }
      snapFile = local;
      result.peerCommit = rmeta?.sha256 ?? null;
      result.peerRows = rmeta?.rows ?? null;
      log(`[mem-sync] 对端快照：${rmeta?.rows ?? '?'} 条 · ${rmeta?.bytes ?? '?'} 字节 · sha ${String(rmeta?.sha256 ?? '').slice(0, 12)}`);
      // 【0.2.0】driver 侧**不拉**对端台账（本卡没加这个网络动作，见文件头"残余面"）⇒ remoteRetractions 保持 null。
      //   对"本机删了不许被对端带回来"这件事，**本机台账自己就够了**（合并器把 local 台账也算进撤回判据集）；
      //   需要"对端删了本机也删"的那一半，走下面 follower 分支（driver 投递 → follower 读）。
      result.retractionsRemote = { path: null, reason: 'driver-no-pull' };
    } else {
      // follower：读本地 inbox（不联网）
      const cands = listInboxSnapshots(paths.inbox, { minAgeMs: paths.minAgeMs });
      if (!cands.length) {
        result.deferred = 'no-inbox-snapshot';
        log(`[mem-sync] 让路：inbox 没有可用快照 ${paths.inbox}（driver 未投递 / 投递中）⇒ 本轮跳过`);
        finishState('deferred', EXIT.DEFER);
        return { ok: true, exitCode: EXIT.DEFER, lines, report: result };
      }
      snapFile = cands[0].p;
      result.peer = `inbox:${cands[0].name}`;
      result.via = 'inbox';
      log(`[mem-sync] inbox 快照：${cands[0].name}（${cands[0].bytes} 字节 · ${new Date(cands[0].mtimeMs).toISOString()}）`);
      // 【0.2.0 · I2-④】**成对命名推台账**：`<inbox>/<快照名去掉 .db>-retractions.jsonl`
      //   推得到 ⇒ 显式喂 `--retractions-from`；推不到 ⇒ 只合并不撤回（**不猜别的文件名**，宁可少撤不乱删）
      const inferred = inferRemoteRetractionsPath(snapFile);
      if (inferred && fs.existsSync(inferred)) {
        remoteRetractions = inferred;
        result.retractionsRemote = { path: inferred, found: true };
        log(`[mem-sync] 对端撤回台账：${path.basename(inferred)}（随快照成对到达）⇒ 本轮撤回计划会生效`);
      } else {
        result.retractionsRemote = { path: inferred, found: false };
        log(`[mem-sync] 对端撤回台账：**未随快照到达**（期望 ${inferred ? path.basename(inferred) : '?'}）⇒ 本轮只合并不撤回`
          + '（driver 端台账为空 / 投递失败时会这样，下一轮自然再来）');
      }
      result.pruned.inbox = pruneInbox(paths.inbox, paths.keep, { nowMs });
    }

    // ── 合并（撞写锁则退避重试；持续撞 ⇒ 让路 exit 3，记日报不记失败）──
    //    【0.2.0 · I2-④】台账两路都喂：本机台账由 mergeFromSnapshot 内部显式传 `--retractions`；
    //    对端台账走这里（apply 时它还会被 append 进本机台账 —— 由合并器做，顺序"先合再撤回"）。
    // ── 转发计划文件：**每轮先清掉旧的**（绝不拿上一轮的行当本轮的行）──
    if (forwardRequired) {
      try { fs.rmSync(paths.forwardFile, { force: true }); } catch { /* 忽略 */ }
    }
    //    【A34 · 2026-10-26】主合并也开"撞 id 退避重试"：两个写者（另一台机器 / DSH 主进程）抢先占了
    //    我们要插的 id 时，`merge-memory` 会报 `UNIQUE constraint failed: memories.id` 并 bail（事务已 ROLLBACK），**库不回退**
    //    ⇒ 那一轮白跑（快照还在、下轮会再来）。开这层重试 ⇒ 第二次读到的 id 已被推进，撞车条按
    //    「D2=② 自动并存（显示 id 取高位段）」落位，不再白跑（夹具 G1 实测：并集落地、dup=0）。
    const m = await mergeWithRetry(paths, snapFile, {
      apply, log, remoteRetractions, forwardOut: forwardRequired ? paths.forwardFile : null,
      retryOnUnique: true,   // ←【A34】主合并：撞 UNIQUE 也退避重试（与 inbox 前置步同一套次数/退避）
    });
    if (!m.ok) {
      if (m.busyExhausted) {
        result.deferred = 'db-busy';
        result.error = m.error;
        // 【A34】退避用尽的两种原因都要点名：撞写锁（database is locked）/ 撞 id（UNIQUE constraint failed）
        log(`[mem-sync] 让路：memory.db 持续争用（退避重试 5 次仍失败：${m.error ?? '原因未知'}）⇒ 本轮跳过，下一轮自然再来`);
        finishState('deferred', EXIT.DEFER);
        return { ok: true, exitCode: EXIT.DEFER, lines, report: result };
      }
      result.error = m.error;
      log(`[mem-sync] ✗ ${m.error}`);
      finishState('failed', EXIT.FAIL);
      return { ok: false, exitCode: EXIT.FAIL, lines, report: result };
    }
    const d = m.dry;
    result.changed = m.changed === true;

    // ── 转发面计划（B6 正解的另一半）：拿不到"未过滤的合并结果"就**不许投** ──
    //   主合并会把它落到 `--forward-out` 文件（只落文件、不进 report.json）。
    //   但 T1 幂等门 / 超集门"整段跳过"的轮次不会算计划（连数据都不读）⇒ 那是**常态**（对端没变的那些小时），
    //   不能就此不投（会把"本机新写的记忆"也一起拖住）⇒ 补跑一次**只读** `--force` dry-run 只算计划：
    //   `--force` 绕过两道跳过门；**没有 `--apply` ⇒ 不写库**（只写计划文件与它的 report）。
    if (forwardRequired) {
      let fp = readForwardPlan(paths.forwardFile);
      let rematerialized = false;
      if (!fp.ok) {
        log('[mem-sync] 转发面：主合并未产出计划（T1 幂等门 / 超集门整段跳过）⇒ 补跑一次**只读** dry-run 重算');
        const { base } = buildMergeArgs(paths, snapFile, { remoteRetractions, forwardOut: paths.forwardFile, archiveDir: nextMergeArchiveDir(paths) });
        const re = runNode(MERGE_SCRIPT, [...base, '--force']);
        const rj = parseMergeJson(re.stdout);
        fp = readForwardPlan(paths.forwardFile);
        rematerialized = fp.ok;
        if (!fp.ok) {
          fp.error = `补算失败（exit ${re.status}）：${rj?.error ?? fp.error ?? tail(re.stderr || re.stdout, 200)}`;
        }
      }
      result.forward = {
        required: true, file: paths.forwardFile, ok: fp.ok, rows: fp.ok ? fp.count : null,
        rematerialized, inserted: 0, skippedExisting: 0, stage: fp.ok ? null : 'plan', error: fp.ok ? null : fp.error,
      };
      if (!fp.ok) {
        result.deferred = 'forward-fill-failed';
        log(`[mem-sync] 让路：转发计划不可得 ⇒ **本轮不投递**（不拿不完整副本冒充完整）：${fp.error}`);
        appendAlert(paths.alertLog, `mem-sync 转发计划不可得 ⇒ 本轮不投递：${fp.error}`);
        finishState('deferred', EXIT.DEFER);
        return { ok: true, exitCode: EXIT.DEFER, lines, report: result };
      }
      log(`[mem-sync] 转发面计划：${fp.count} 行（未过滤的合并结果${rematerialized ? ' · 由只读重算得到' : ''}）→ ${paths.forwardFile}`);
    }

    result.dryStats = {
      localRows: d?.local?.rows ?? null, remoteRows: d?.from?.rows ?? null,
      onlyRemote: d?.stats?.onlyRemote ?? null, inserted: d?.stats?.inserted ?? null,
      idempotentSkip: d?.idempotency?.skipped === true, superset: d?.superset?.superset === true,
      reason: d?.idempotency?.reason ?? null,
    };
    // 【0.2.0 · I2-④】撤回面的可核读数（dry-run 也出 —— "生产 dry-run 必须能打印撤回计划 N 条"靠它）
    const planN = Array.isArray(d?.retractPlan) ? d.retractPlan.length : null;
    result.retractions = {
      ...(m.retractionsArgs ?? {}),
      remoteFrom: remoteRetractions,
      plan: planN,
      adopted: Array.isArray(d?.adoptedRetractions) ? d.adoptedRetractions.length : null,
      suppressed: Array.isArray(d?.suppressed) ? d.suppressed.length : null,
      ledger: d?.retractions ?? null,
      executed: m.applied
        ? { deleted: m.applied.applied?.deleted ?? 0, ledgerAppended: m.applied.retractLedgerWrite?.appended ?? null }
        : null,
    };
    if (planN) {
      log(`[mem-sync] 撤回计划：**${planN} 条** 本机命中撤回判据（hash+owner）`
        + ` · 对端台账 ${remoteRetractions ? path.basename(remoteRetractions) : '未提供'}`
        + ` · 本机台账 ${m.retractionsArgs?.localExists ? '在位' : '不存在'}`
        + (apply ? ' ⇒ 本轮执行（先合再撤回）' : ' ⇒ **dry-run 只出计划、未执行**'));
    }
    if (m.skippedApply) {
      log(`[mem-sync] 合并：无需写入（${m.skipReason === 'dry-run' ? 'dry-run 模式（未给 --apply）' : (d?.idempotency?.skipped ? 'T1 幂等门：同一 remoteCommit 已应用' : '无变化')}）`
        + ` · 本机 ${d?.local?.rows ?? '?'} 条 / 对端 ${d?.from?.rows ?? '?'} 条`);
    } else {
      result.applied = { inserted: m.applied.applied?.inserted ?? 0, updated: m.applied.applied?.updated ?? 0, deleted: m.applied.applied?.deleted ?? 0, archive: m.applied.archiveDir ?? null };
      log(`[mem-sync] ✓ 合并写入：插入 ${result.applied.inserted} / 更新 ${result.applied.updated} / 删除 ${result.applied.deleted}`
        + `（本机 ${d?.local?.rows} → ${m.applied.result?.rows} 条）· 快照 ${result.applied.archive}`);
      // 合并**插入**的行 updated_at 是对端原值（可能早于向量水位）⇒ 增量扫不到 ⇒ 先回退水位（见函数注释）
      if (result.applied.inserted > 0) {
        const ids = (m.applied.inserts ?? []).map((i) => i.id);
        result.vectorsWatermark = await rewindVectorWatermark(paths, ids, log);
        if (result.vectorsWatermark && result.vectorsWatermark.rewound === false && result.vectorsWatermark.reason?.startsWith('error:')) {
          result.warnings.push(`向量水位回退失败：${result.vectorsWatermark.reason}`);
        }
      }
    }

    // ── driver：投递本机合并后快照给 follower（+ 转发面填副本）──
    if (role === 'driver' && apply) {
      const dlv = await deliverSelfSnapshot({
        paths,
        alias: result.peer.split('(')[0],
        nowMs,
        forward: forwardRequired ? { required: true, file: paths.forwardFile } : null,
        log,
        warnings: result.warnings,
      });
      result.delivery = {
        ok: dlv.ok, delivered: dlv.delivered, remoteTarget: dlv.remoteTarget,
        skipped: dlv.skipped, error: dlv.error, snapshot: dlv.snapshot,
      };
      if (dlv.forward) result.forward = { ...(result.forward ?? { required: forwardRequired }), ...dlv.forward };
      result.retractionsDelivery = dlv.retractionsDelivery;
      if (dlv.ok) result.delivered = dlv.delivered;
      if (!dlv.ok && dlv.skipped === 'forward-fill-failed') {
        // 失败语义（本卡拍定）：**整轮 deferred**，不投半份 —— 代价 = 中心晚一轮，收益 = 它永远不会静默少事实
        result.deferred = 'forward-fill-failed';
        log(`[mem-sync] 让路：${dlv.error} ⇒ **本轮不投递**（宁可中心晚一轮，也不让它悄悄少事实）`);
        appendAlert(paths.alertLog, `mem-sync 转发填充失败 ⇒ 本轮不投递：${dlv.error}`);
        finishState('deferred', EXIT.DEFER);
        return { ok: true, exitCode: EXIT.DEFER, lines, report: result };
      }
    }

    result.localAfter = (await readLocalRows(paths.localDb))?.rows ?? null;

    // ── 重建本机向量（同步后各机自己重建）──
    if (flags['no-vectors']) {
      log('[mem-sync] 向量：--no-vectors ⇒ 跳过');
    } else {
      // 本轮是 dry-run ⇒ 向量也只探（`--dry-run` 不自建库、不写向量库/state），守住"dry-run 不动生产"
      const vArgs = ['--allow-host', String(hostname).toLowerCase(), '--json'];
      if (!apply) vArgs.push('--dry-run');
      // 经**包装层**调起：抢的是 `tick-memory-vectors.lock`（与既有 `memory-vectors` job **同一把**）
      //   ⇒ 那个 job 正在跑时本轮自动跳过（exit 7），**绝不会两个进程同时写 vectors.db**。
      const v = runNode(TICK_RUNNER, ['--job', 'memory-vectors', '--script', VECTORS_SCRIPT, ...vArgs], { timeout: 30 * 60 * 1000 });
      const vb = parseMergeJson(v.stdout);
      result.vectors = { exitCode: v.status, ok: v.status === 0 || v.status === EXIT.DEFER || v.status === 7, state: vb?.state?.lastSync ?? null };
      if (v.status === EXIT.DEFER) log('[mem-sync] 向量：让路（宿主未声明 ⇒ 与接线前行为一致）');
      else if (v.status === 7) log('[mem-sync] 向量：跳过（`memory-vectors` 锁被占 —— 那个 job 正在跑，下一轮自然收敛）');
      else if (v.status === 0) log(`[mem-sync] ✓ 向量：ok（sync ${JSON.stringify(vb?.state?.lastSync ?? {})}）`);
      else {
        result.warnings.push(`向量失败（exit ${v.status}）：${tail(v.stderr || v.stdout)}`);
        log(`[mem-sync] ⚠️ 向量失败（exit ${v.status}）**不阻断合并**：${tail(v.stderr || v.stdout, 200)}`);
      }
    }

    const ok = true;
    // 【B案 · A29】"吃下本机 inbox"同样是**本机真的变了** ⇒ 不能因为「主合并没变化」就把整轮报成
    //   `no-change`（否则 HOST_B 明明吃下了 HOST_A 投来的快照，state 里却写 no-change，验收方会误判成"中心没在收"）。
    const intakeChanged = result.inboxIntake?.changed === true;
    const status = (result.changed || intakeChanged) ? 'ok' : 'no-change';
    log(`[mem-sync] 完成：本机 ${result.localBefore} → ${result.localAfter} 条 · 状态 ${status}`);
    finishState(status, EXIT.OK);
    return { ok, exitCode: EXIT.OK, lines, report: result };
  } finally {
    // 【R12】收尾归还 = 共用件 `releasePeerChannel` —— **只关"本次由我开的"**：
    //   `downOnRelease===true`（进短租前 enabled=false、由我 enable+up 起来）⇒ `down` + 销租约；
    //   `downOnRelease===false`（进短租前别人已 enabled：relay-ondemand / 主人手动）⇒ 只销自己的租约、**不 down**。
    //   ⚠️ 失败也走这里（所有出口都会归还）；归还失败**不吞** —— 打一行带 reclaim 兜底命令的告警。
    if (lease) {
      try {
        const rel = releasePeerChannel(lease, { log: (m) => log(`[mem-sync]${m}`) });
        result.channelRelease = { released: rel.released === true, skipped: rel.skipped ?? null, detail: rel.detail, down: rel.down ?? null };
        if (!rel.released) log(`[mem-sync] 短租归还：${rel.detail}`);
      } catch (e) {
        result.channelRelease = { released: false, error: String(e?.message ?? e) };
        log(`[mem-sync] ⚠️ 短租归还失败（隧道可能还挂着 ⇒ 可跑 node <workspace>\\tools\\peer-channel-cli.mjs reclaim --apply）：${e?.message ?? e}`);
      }
    }
  }
}

async function main() {
  const flags = parseArgs();
  if (flags.help) {
    process.stdout.write('用法：node mem-sync-tick.mjs [--role auto|driver|follower] [--apply] [--dry-run] [--json]\n'
      + '  [--peer-lan host-b-lan] [--peer-tunnel host-b] [--inbox <drive>\\dsh-memory-sync\\inbox]\n'
      + '  [--keep 24] [--no-vectors] [--no-tunnel-rent] [--state-file P] [--relay-cli P] [--no-inbox-intake]\n'
      + '  [--merge-config P] [--forward-file P] [--home P] [--tmp-dir P] [--help]\n'
      + '  退出码：0 ok（含无变化/幂等跳过）/ 3 安全跳过（含拓扑守卫拦下 / 转发填充失败）/ 1 失败 / 2 用法\n'
      + '  通道短租（共用件 tools/lib/peer-channel.mjs）：lan → tunnel → 都不通则 enable+up；\n'
      + '    收尾**只关"本次由我开的"**（进短租前隧道已 enabled 的一律不碰）。\n'
      + '    一键关回：--no-tunnel-rent（单次）／ env DSH_PEER_SHORT_RENT=off ／ 开关文件\n'
      + '    ~/.dsh/relay/short-rent.json（写入口 node tools/peer-channel-cli.mjs off --apply）。\n'
      + '  撤回台账（0.2.0）：本机 `<home>/memory/retractions.jsonl` 随快照**成对投递**到对端 inbox\n'
      + '    （`<快照名去 .db>-retractions.jsonl`）；合并时两侧台账都显式喂给 merge-memory，\n'
      + '    `--apply-retractions` **只在 --apply 那一路加** ⇒ dry-run 只打印「撤回计划 N 条」。\n'
      + '  拓扑守卫 / 转发通道（0.3.0）：`partition.mode==edge` 的 driver 只许投给 `partition.hubHost`；\n'
      + '    投递副本会先填进「未过滤的合并结果」（`--forward-out` 计划文件）再投，失败 ⇒ 整轮 deferred。\n'
      + '  driver 先吃本机 inbox（B案 · A29，2026-10-26）：driver 每轮**先把**叶子投进本机 inbox 的最新快照\n'
      + '    合并掉，**再**探对端/拉/投。顺序不许颠倒 —— 对端不可达的那几轮，中心也必须先吃叶子已送到的数据。\n'
      + '    `--no-inbox-intake` 单次关回（无持久开关：关掉它中心就不全）。对 inbox 本来就空的机器行为等价。\n'
      + '  连续 deferred 告警（A28 · **默认关**）：连续 ≥3 轮（≈3 小时）deferred ⇒ `<home>/butler-alert.log` 一行\n'
      + '    （含 `source=mem-sync`）+ report 字段（tickd 日报读它）；同一段连续只报一次。\n'
      + '    开 = env DSH_MEM_SYNC_DEFERRED_ALERT=on ／ 开关文件 `<home>/butler-mem-sync-alert.json` 的 enabled:true\n'
      + '    关回 = env 置 off 或删该 env ／ 把开关文件 enabled 改 false（env 优先）。\n');
    return EXIT.OK;
  }
  const r = await runOnce({ flags });
  // `--json`：structured 结果走 **stdout**、人读日志走 **stderr**（既有生态口径：stdout 是数据通道；
  //   也保证排障时"撞锁退避重试"这类关键行不会因为开了 --json 就消失）。
  if (flags.json) {
    for (const l of r.lines) process.stderr.write(l + '\n');
    process.stdout.write(JSON.stringify({ ok: r.ok, exitCode: r.exitCode, report: r.report }, null, 2) + '\n');
  } else for (const l of r.lines) process.stdout.write(l + '\n');
  return r.exitCode;
}

if (process.argv[1]) {
  let isMain = false;
  try { isMain = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { isMain = false; }
  if (isMain) main().then((c) => { process.exitCode = c; }).catch((e) => {
    process.stderr.write(`[mem-sync] ✗ ${e?.stack ?? e}\n`);
    process.exitCode = EXIT.FAIL;
  });
}
