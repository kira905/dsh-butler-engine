#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dsh-butler / mem-push-leaf.mjs —— HOST_A → HOST_C「单向叶子推具」：只投本机快照，不拉、不合、不碰向量
//   （卡：人格统一·A13 · 2026-10-26 · 方案真源 `docs\交付报告-多机同步前置B诊断-20261026.md` §5-3 S1）
//
// ── 语义（一件事）──────────────────────────────────────────────────────────
//   把 HOST_A 的 `VACUUM INTO` 只读快照（+ 成对撤回台账 `-retractions.jsonl`）scp 到对端 `inbox`，
//   投递成功后按 `--keep` 清对端 inbox（保留最近 N 份）。
//   所有投递细节**复用** `mem-sync-tick.mjs` 的导出（`resolvePaths` / `deliverSelfSnapshot` / `pruneInbox`），
//   本脚本**不重写任何一段投递逻辑**；**不 import `runOnce`** —— 因为 driver 的 `runOnce` 第①步就是 pull。
//
// ── 为什么只推不拉（三条，A12 §5-1 的一句话版）────────────────────────────────
//   ① **拉 = 反向**：driver 分支自带"探对端 → 产对端快照 → scp 回本机 → 合并本机"；在 HOST_A 上拿 HOST_C 当
//      对端跑 driver，就会把 HOST_C 快照合回主库 ⇒ 双向，且会把 HOST_C 独有的 155 条老记忆灌进 HOST_A/HOST_B。
//   ② **HOST_C 当 driver 更糟**：它拉 HOST_A 快照、再往 HOST_A 投，而 HOST_A 同时也在往它投 ⇒ 两台互投同源快照，
//      inbox 里"最后到的那份"说了算（谁也没法解释某一拍的中间态是哪来的）。
//   ③ **HOST_B 一掺进来必然成环**：一旦 HOST_B↔HOST_C 有任何一条边，三台就是 A→B→C→A；而合并计划是
//      "以两台当时的行集"算的，环上任何一拍的中间态都会被下一拍当成事实。
//   ⇒ 铁律：**HOST_C 只收**。本脚本没有任何"从对端读 / 合并 / 建向量"的代码路径（不回 scp、不调 merge-memory）。
//
// ── 用法 ───────────────────────────────────────────────────────────────────
//   node mem-push-leaf.mjs [--peer-lan host-c-lan] [--peer-tunnel host-c] [--keep 24] [--apply] [--json] [--home <沙箱>]
//                           [--tmp-dir <路径>]
//
//   · 缺省 **dry-run**（零写入）：不产快照、不 scp、不建目录、不动任何 state / alert 文件。
//     打印五样 = ①路径 ②本机库 size/mtime/行数（`readOnly` 打开，不复制库）③目标 inbox
//     ④选路结果 + 探活读数 ⑤`--keep` + 对端 inbox 现有快照数。
//   · `--apply` 才真做：`deliverSelfSnapshot` → 成功后 `pruneInbox(paths.inbox, keep)`；失败**不 prune**。
//   · 选路：先试 `--peer-lan`，失败回落 `--peer-tunnel`；探活只跑 `ssh <别名> hostname`（只读）。
//   · 两个 `--peer-*` **都没给** ⇒ 用法错 exit 2（本脚本**不编默认别名**：`mem-sync-tick` 的缺省别名是
//     HOST_B 的 `host-b-lan`/`host-b`，拿它当缺省就会把叶子快照投到 HOST_B 去）。
//
// ── 临时目录（为什么叶子要单独一份 · 卡 A14 加）────────────────────────────────
//   快照落点 = `path.join(paths.tmpDir, 'self-memory.db')`（`deliverSelfSnapshot` L541，而且**先 `unlinkSync` 再写**），
//   而 `paths.tmpDir` 的**缺省**（`resolvePaths` L140）= `<tmp>\dsh-mem-sync` —— 与小时级 driver 每轮那份快照
//   **同一个文件**。⇒ 本脚本**不继承**那个缺省：不给 `--tmp-dir` 时自己缺省成 `<tmp>\dsh-mem-sync-leaf`。
//   为什么必须分开：本器具被 tickd 挂成 **15 分钟一轮**（S3）之后，与 **60 分钟一轮**的 driver 必然重叠；
//   两进程抢同一个 `self-memory.db` ⇒ 一个刚 unlink、另一个正在读，轻则本轮 `snapshot-failed`，
//   重则把对面那份快照写坏/清掉（`unlink` + 重写不是原子操作）。
//   ⚠️ 只改**本脚本**的缺省：`mem-sync-tick.mjs#resolvePaths` 的缺省一个字没动（driver 行为零变化）。
//   回滚（一行）：把下面 `LEAF_TMP_DIRNAME` 改回 `'dsh-mem-sync'`（= 回到与 driver 共用），或直接删本脚本（见上"回滚"）。
//
// ── 退出码 ─────────────────────────────────────────────────────────────────
//   0 成功 / 3 **对端不可达**（探活全失败；benign —— tickd job 的 `benignExitCodes` 就用它）
//   1 其它失败（快照失败 / scp 失败 / 读库失败）/ 2 用法错
//   失败（仅 `--apply` 模式）同时在 `<home>\butler-alert.log` 追**一行**（`source=mem-push-leaf ...`）。
//   dry-run 一律零写入 ⇒ 不写 alert（真实告警走 tickd 那条 `--apply` 的路，dry-run 不承担告警职责）。
//
// ── 回滚（一行）────────────────────────────────────────────────────────────
//   cmd /c del "<pkg>\jobs\mem-push-leaf.mjs"
//
// ── 隔离注入（只给夹具，生产两个 env 都不设）──────────────────────────────────
//   `DSH_MEM_SYNC_SSH_EXE=node` + `DSH_MEM_SYNC_SSH_PREFIX=<假 ssh 脚本>` —— 与 `mem-sync-tick.mjs` 同一套口径；
//   `deliverSelfSnapshot` 内部的 mkdir / scp 也走同一套（`DSH_MEM_SYNC_SCP_EXE` / `SCP_PREFIX`），
//   所以夹具能在 **CLI 层**把"连网"整个换掉，而不必改生产代码。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MEM_SYNC_TICK_VERSION,
  resolvePaths,
  deliverSelfSnapshot,
  pruneInbox,
} from './mem-sync-tick.mjs';

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, UNREACHABLE: 3 };
const SRC = 'mem-push-leaf';

/**
 * 叶子专用快照目录名（`<tmp>\<这个>`）。**故意**与 `mem-sync-tick.mjs` 的 `dsh-mem-sync` 分开 ——
 * 理由见头注释「临时目录」段：共同一份 `self-memory.db` + `unlink` 重写 ⇒ 15 分钟一轮的叶子会跟
 * 小时级 driver 对撞。改这里 = 改叶子的缺省落点（`--tmp-dir` 仍可覆盖）。
 */
const LEAF_TMP_DIRNAME = 'dsh-mem-sync-leaf';

// 与 `mem-sync-tick.mjs` 的 `SSH_COMMON` 一字不差（同一个信任/超时口径；别在这里单独调）。
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

function tail(s, n = 300) { return String(s ?? '').replace(/\s+$/, '').slice(-n); }

/**
 * ssh 启动器 —— 与 `mem-sync-tick.mjs#sshLauncher` 同款（那边没 export，这里 6 行照抄：
 * 卡面红线是"不要重写**投递逻辑**"，传输启动器属 CLI 小工具；两边口径必须一致，改一处要改两处）。
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
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null };
}

/** 失败告警：**一行**，追进 `<home>\butler-alert.log`（格式照 `mem-sync-tick.mjs#appendAlert`）。 */
function appendAlert(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    return true;
  } catch { return false; }
}

/** 本机库读数：size/mtime 走 statSync，行数走 `readOnly` 连接（**不复制库、不写库**）。 */
async function readLocalDbInfo(dbPath) {
  const info = { db: dbPath, exists: false, bytes: null, mtimeMs: null, rows: null, maxId: null, readOnly: true, error: null };
  try {
    const st = fs.statSync(dbPath);
    info.exists = true; info.bytes = st.size; info.mtimeMs = st.mtimeMs;
  } catch { return info; }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const r = db.prepare('SELECT COUNT(*) AS c, MAX(id) AS mx FROM memories').get();
      info.rows = Number(r.c);
      info.maxId = Number(r.mx ?? 0);
    } finally { db.close(); }
  } catch (e) { info.error = String(e?.message ?? e); }
  return info;
}

/** 对端 inbox 现有快照数（**只读**：`ssh <别名> "dir <inbox>"`）。目录不存在时 dir 回 rc 1 ⇒ count 0。 */
function countInbox(alias, inbox) {
  const r = ssh(alias, ['cmd', '/c', 'dir', `"${inbox}"`]);
  const text = `${r.stdout}\n${r.stderr}`;
  const dbCount = (text.match(/[^\s\\/:*?"<>|]+\.db\b/gi) || []).length;
  // 真实命名 = `mem-snapshot-<日期8位>-<UTC时间6位>-<sha8>.db`（`deliverSelfSnapshot` 的 stamp 是 `YYYYMMDD-HHMMSS`）。
  // ⚠️ 别照抄 `listInboxSnapshots` 里那个 `\d{4}` 的旧正则：那里靠 `endsWith('.db')` 兜底才没出事，这里没有兜底。
  const leafCount = (text.match(/mem-snapshot-\d{8}-\d{6}-[0-9a-f]{8}\.db/gi) || []).length;
  return { dirOk: r.ok, dbCount, leafCount, err: r.ok ? null : tail(text, 160) };
}

// ─────────────────────────────── 主流程 ───────────────────────────────

async function main() {
  const flags = parseArgs();
  const json = flags.json === true;
  const apply = flags.apply === true;
  /** `--json` 时**所有提示走 stderr**，stdout 只留最后那段 JSON（这条踩过坑）。 */
  const emit = (s) => (json ? process.stderr : process.stdout).write(`${s}\n`);

  if (flags.help) {
    process.stdout.write('用法：node mem-push-leaf.mjs --peer-lan <别名> [--peer-tunnel <别名>] [--keep 24]\n'
      + '  [--apply] [--json] [--home <沙箱>] [--tmp-dir <路径>] [--help]\n'
      + '  语义：把本机 `VACUUM INTO` 快照（+ 成对撤回台账）单向投到对端 inbox，再按 --keep 清对端 inbox。\n'
      + '  **只推不拉**：不 scp 回来、不 merge、不碰向量（叶子端点只收）。\n'
      + '  `--tmp-dir` 缺省 = `<tmp>\\dsh-mem-sync-leaf`（**叶子专用**：不与 driver 的 `<tmp>\\dsh-mem-sync` 共用快照文件）。\n'
      + '  缺省 dry-run（零写入）；选路 lan → tunnel，都探不通 exit 3（benign）。\n'
      + '  退出码：0 成功 / 3 对端不可达 / 1 其它失败 / 2 用法错\n');
    return EXIT.OK;
  }

  // ── 用法校验：两个 --peer-* 都没给 ⇒ 2（不编默认别名，见头部注释）──
  const lanRaw = flags['peer-lan'];
  const tunRaw = flags['peer-tunnel'];
  const lan = (typeof lanRaw === 'string' && lanRaw.trim()) ? lanRaw.trim() : null;
  const tun = (typeof tunRaw === 'string' && tunRaw.trim()) ? tunRaw.trim() : null;
  if (!lan && !tun) {
    process.stderr.write('[mem-push-leaf] ✗ 用法错：至少要给一个 --peer-lan <ssh别名> 或 --peer-tunnel <ssh别名>\n'
      + '（本脚本不编默认别名 —— mem-sync-tick 的缺省别名是 HOST_B，拿它当缺省会把叶子快照投到别的机器）\n');
    return EXIT.USAGE;
  }
  const keep = Number(flags.keep ?? 24);
  if (!Number.isFinite(keep) || keep < 1) {
    process.stderr.write(`[mem-push-leaf] ✗ 用法错：--keep 必须是 ≥1 的数字（收到 ${JSON.stringify(flags.keep)}）\n`);
    return EXIT.USAGE;
  }

  // ── `--tmp-dir` 缺省 = **叶子专用独立子目录**（不继承 `mem-sync-tick` 的 `<tmp>\dsh-mem-sync`，理由见头注释）──
  //   `resolvePaths` 的 `flags['tmp-dir']` 键本来就支持（L140）；这里只负责"**不给**时填什么"，不改它的解析。
  if (flags['tmp-dir'] === undefined) {
    flags['tmp-dir'] = path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), LEAF_TMP_DIRNAME);
  } else if (flags['tmp-dir'] === true || !String(flags['tmp-dir']).trim()) {
    // `--tmp-dir` 后面没跟值 ⇒ parseArgs 记成 `true`，放任它下去会被 `path.resolve('true')` 解成 `<cwd>\true`（静默跑偏）
    process.stderr.write('[mem-push-leaf] ✗ 用法错：--tmp-dir 需要一个路径值（收到无值）\n');
    return EXIT.USAGE;
  }

  const paths = resolvePaths(flags);
  // `resolvePaths` 的缺省别名是 HOST_B；本脚本自己算候选，把这两个字段覆盖成**显式给的**（避免被误读）。
  paths.peerLan = lan ?? '';
  paths.peerTunnel = tun ?? '';

  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const device = os.hostname();
  const warnings = [];

  // ── ① 本机库读数（readOnly）──
  const local = await readLocalDbInfo(paths.localDb);

  // ── ② 选路（探活只跑 `ssh <别名> hostname`）──
  const candidates = [
    ...(lan ? [{ channel: 'lan', alias: lan }] : []),
    ...(tun ? [{ channel: 'tunnel', alias: tun }] : []),
  ];
  const probes = [];
  let chosen = null;
  for (const c of candidates) {
    const t0 = Date.now();
    const r = ssh(c.alias, ['hostname']);
    const rec = {
      channel: c.channel, alias: c.alias, ok: r.ok, ms: Date.now() - t0,
      hostname: r.ok ? r.stdout.trim() : null, err: r.ok ? null : tail(r.stderr || r.error, 160),
    };
    probes.push(rec);
    if (r.ok) { chosen = rec; break; }
  }

  const report = {
    ok: false, exitCode: null, at, device, mode: apply ? 'apply' : 'dry-run',
    tool: { name: 'mem-push-leaf.mjs', memSyncTickVersion: MEM_SYNC_TICK_VERSION },
    peer: {
      alias: chosen?.alias ?? null, via: chosen?.channel ?? null,
      hostname: chosen?.hostname ?? null, probes,
    },
    paths: {
      home: paths.home, localDb: paths.localDb, retractionsFile: paths.retractionsFile,
      stateFile: paths.stateFile, alertLog: paths.alertLog, tmpDir: paths.tmpDir,
      inbox: paths.inbox, keep, minAgeMs: paths.minAgeMs,
    },
    local,
    inbox: { path: paths.inbox, remote: null },
    delivery: null, pruned: null, warnings,
  };

  // ── 对端不可达 ⇒ 3（benign）· 不产快照、不 scp ──
  if (!chosen) {
    const line = `source=${SRC} exit=${EXIT.UNREACHABLE} reason=peer-unreachable`
      + ` candidates=${candidates.map((c) => `${c.channel}:${c.alias}`).join(',')}`
      + ` err=${tail(probes.map((p) => p.err).filter(Boolean).join(' | '), 200)}`;
    const alert = apply
      ? { file: paths.alertLog, written: appendAlert(paths.alertLog, line), line }
      : { file: paths.alertLog, written: false, line, skipped: 'dry-run 零写入' };
    report.exitCode = EXIT.UNREACHABLE;
    report.alert = alert;
    emit(`[mem-push-leaf] ✗ 对端不可达（探活 ${probes.length} 条候选全失败）⇒ exit 3（benign，不产快照）`);
    for (const p of probes) emit(`  · ${p.channel} ${p.alias} → ${p.ok ? 'ok' : 'fail'}（${p.ms} ms）${p.err ? ` ${p.err}` : ''}`);
    return finish(report, json);
  }

  emit(`[mem-push-leaf] 选路：${chosen.channel} → ${chosen.alias}（hostname=${chosen.hostname} · ${chosen.ms} ms）`);

  // ── ③ 对端 inbox 现有快照数（只读 dir）──
  report.inbox.remote = countInbox(chosen.alias, paths.inbox);
  emit(`[mem-push-leaf] 对端 inbox：${paths.inbox} → dir ${report.inbox.remote.dirOk ? 'ok' : 'fail'}`
    + ` · .db ${report.inbox.remote.dbCount} 个（host-a-memory 形态 ${report.inbox.remote.leafCount} 个）`
    + (report.inbox.remote.dirOk ? '' : ` · ${report.inbox.remote.err}`));

  // ── ④ dry-run：只打印计划，一个字节都不写 ──
  if (!apply) {
    emit(`[mem-push-leaf] 本机库：${local.db} · ${local.exists ? `${local.bytes} B · ${local.rows} 行 · maxId=${local.maxId}` : '不存在（--apply 会失败）'}`);
    emit(`[mem-push-leaf] 快照落点（--apply 才会建）：${path.join(paths.tmpDir, 'self-memory.db')}`);
    emit(`[mem-push-leaf] 台账：${paths.retractionsFile} · ${fs.existsSync(paths.retractionsFile) ? '存在（会成对跟上）' : '不存在（跳过，正常）'}`);
    emit(`[mem-push-leaf] 计划：--apply 时 → 产快照 → scp ${chosen.alias}:${String(paths.inbox).replace(/\\/g, '/')}/mem-snapshot-<stamp>-<sha8>.db`
      + ` → 台账成对 → pruneInbox(keep=${keep})`);
    emit(`[mem-push-leaf] dry-run 完成：零写入（未产快照 / 未 scp / 未建目录 / 未动 state 与 alert）`);
    report.ok = true;
    report.exitCode = EXIT.OK;
    report.plan = {
      dryRun: true, wouldDeliver: true, keep,
      snapshotPath: path.join(paths.tmpDir, 'self-memory.db'),
      remoteInbox: String(paths.inbox).replace(/\\/g, '/'),
      retractionsExists: fs.existsSync(paths.retractionsFile),
      localDbUsable: local.exists === true,
    };
    return finish(report, json);
  }

  // ── ⑤ --apply：投递（失败不 prune）──
  emit(`[mem-push-leaf] 本机库：${local.db} · ${local.exists ? `${local.bytes} B · ${local.rows} 行 · maxId=${local.maxId}` : '不存在'}`);
  const out = await deliverSelfSnapshot({
    paths, alias: chosen.alias, nowMs, log: (m) => emit(m), warnings,
  });
  report.delivery = out;

  if (!out.ok) {
    const reason = out.skipped || 'unknown';
    const line = `source=${SRC} exit=${EXIT.FAIL} reason=${reason} peer=${chosen.alias}`
      + ` detail=${tail(out.error, 200)}`;
    report.alert = { file: paths.alertLog, written: appendAlert(paths.alertLog, line), line };
    report.exitCode = EXIT.FAIL;
    emit(`[mem-push-leaf] ✗ 投递失败（skipped=${reason}）⇒ exit 1 · **不 prune** · 告警一行已写 ${paths.alertLog}`);
    return finish(report, json);
  }

  // ── ⑥ 投递成功 → pruneInbox（只在成功后）──
  report.pruned = pruneInbox(paths.inbox, keep, { nowMs: Date.now() });
  emit(`[mem-push-leaf] ✓ 已投递 ${out.delivered}；inbox 保留 ${keep} → 删 ${report.pruned.removed} 份快照`
    + `${report.pruned.removedLedgers ? `（含 ${report.pruned.removedLedgers} 份成对台账）` : ''}`);

  if (warnings.length) for (const w of warnings) emit(`[mem-push-leaf] ⚠️ ${w}`);
  report.ok = true;
  report.exitCode = EXIT.OK;
  return finish(report, json);
}

/** 收尾：JSON 模式只把结构化结果打到 stdout（提示已在 stderr），返回退出码。 */
function finish(report, json) {
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (!report.ok) process.stdout.write(`[mem-push-leaf] 结果：ok=false exit=${report.exitCode}\n`);
  return report.exitCode;
}

if (process.argv[1]) {
  let isMain = false;
  try { isMain = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { isMain = false; }
  if (isMain) main().then((c) => { process.exitCode = c; }).catch((e) => {
    process.stderr.write(`[mem-push-leaf] ✗ ${e?.stack ?? e}\n`);
    process.exitCode = EXIT.FAIL;
  });
}

export { EXIT, parseArgs, readLocalDbInfo };
