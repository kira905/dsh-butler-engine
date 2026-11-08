#!/usr/bin/env node
/**
 * dsh-butler / text-sync-direct.mjs —— 跨机「文本文件」**不经仓**的直连同步（v1 · 只增不删）
 *
 * ── 为什么有它（人话）────────────────────────────────────────────────────────
 * 现在 `docs/` 与 `agent-presets/` 在两台机之间**只能靠 Gitee 三仓过一道**：
 *   · `text-sync.mjs` 走 git（仓3 采 docs、仓1 采 presets），对端要靠 `handoff --arrive` 才落地；
 *   · 拆仓钩子（方案 §4）时必然有一段**没有通道**的窗口 —— 得有第二条腿，而且这条腿**不经过仓**。
 * 本脚本就是那条腿：走**隧道/局域网 SSH + scp**，把文本文件在两机之间双向搬，
 * 规则与 `text-sync.mjs` **同一份口径**（`TEXT_EXTS` / `SKIP_DIRS` / docs 的双向排除子目录都是 import 来的，
 * 不是抄来的），但**全程不碰 git、不碰仓**。
 *
 * ── 三段式（为什么得分三段）──────────────────────────────────────────────────
 *   阶段 A **本机出清单**：按口径遍历本机、产出 `[{relPath,size,mtimeMs}]`（**先不算 sha**）。
 *   阶段 B **对端比对**（`_direct/select.mjs`，只读）：对端拿这份清单跟自己 stat 比，
 *         把"对端缺 / 同名但不像同一份 / 对端多出来的"分好组；**sha 只对"已经不像同一份"的算**。
 *   阶段 C **分批传**：只把"真要传"的打成批次包（`_direct/packfile.mjs` 自定义容器，≤ `--max-batch-bytes`），
 *         本机落盘 → `scp` → 对端 `_direct/place.mjs` 按覆盖规则落位。
 * 为什么要三段：一次性把 3,500 份 / 108 MB 全推过去，等于**用本机覆盖对端**（对端自己也在产文档）；
 * 只有"先比对、只传差量"才能做到「只增不删 + 不覆盖较新」。
 *
 * ── 覆盖规则（本卡最要紧的设计）─────────────────────────────────────────────
 *   对端没有                       ⇒ **新增**（传）
 *   同名、本机 mtime 更新且内容不同  ⇒ **更新**（传；覆盖前把旧件存 `<原名>.bak-<stamp>`，**只留最近 1 份**）
 *   同名、对端更新且内容不同         ⇒ **跳过**（记一笔"对端较新"，绝不反向覆盖）
 *   同名、内容不同但 mtime 判不了谁新 ⇒ **冲突**：原件不动，本机版本落 `<原名>.conflict-<发起方host>-<stamp>` 副本
 *   双写黑名单（默认 `docs/变更流水/` 全下 + `docs/` 里形如 `20xx-….md` 的）⇒ **永不覆盖**，只落冲突副本
 *   内容相同（sha 相等，或 size+mtime 快路径判定）⇒ **跳过**
 * 🔴 **绝不删除任何文件**；也不提供 `--delete` / `--purge`。唯一会删目标文件的是回滚器
 *    （`rollback-direct-sync.mjs`，且只删本次新建的、sha 对得上的）。
 *
 * ── 通道（不自己写探测）─────────────────────────────────────────────────────
 * 复用共用件 `tools\lib\peer-channel.mjs`：`lan（<peer>-lan）→ tunnel（<peer>）→ 按需短租`，
 * 收尾 `releasePeerChannel()` **只关本次自己开的**（net-arbiter 保活开的隧道不会被它关掉）。
 *
 * ── 可观测性（2026-10-28 · 卡「同步可观测性」B1/B2/B3 · **不改同步语义**）────────────
 *   本脚本原来"跑完不留账"：除了 tickd 的 `ok / failures / consecutiveBenign` 三个字段，没人能回答
 *   「上次什么时候同步过、推了几份、冲突副本在哪、这个月是不是一直空转」。现在补三件：
 *   · **B1 自有状态文件** `~\.dsh\butler-text-sync-direct.json`（dual 期**两个名字**：
 *        primary `ops-text-sync-direct.json` + mirror `butler-text-sync-direct.json`）：
 *        `last`（最近一轮完整结果）+ `rounds[]`（最近 48 轮摘要）+ `idle{}`（三态计数）。
 *        **只在 `--apply` 写**；**让路轮（rc=3）与失败轮（rc=1）也落一条** —— 否则 `--status`
 *        会把整段断网期"跳过"（这正是 I-3 要解决的核心场景）。
 *        🔴 **权威源裁定**：一轮同步的原始件是 `_archive\text-sync-direct\<runId>\manifest.json`
 *        （不可重算 + 回滚器唯一输入）；状态文件是**派生视图**（可丢、可删）⇒
 *        `--status` 在状态文件缺失时**回退扫最近一份 manifest**。
 *   · **B2 留档 retention**：`--prune-archive`（**默认 dry-run**）把 `<runId>` 形态目录裁到
 *        「最近 `--keep`（默认 30）份 **且** 总量 ≤ `--max-mb`（默认 200 MB）」，两条件取严。
 *        ⚠️ 生效后更老的轮次**不可回滚**（`rollback-direct-sync.mjs` 的输入只剩最近 N 份）。
 *   · **B3 空转 SLI**：`idle{}` 三态（idle / active / unknown）+ `--status` 只读查询；
 *        连续 **24 轮**「跑成了但没东西搬」⇒ 摘要行点名。**不接告警**（告警面归 `f5440482` 管 liveness，
 *        本件管 idleness，两边**不共享计数器**）。
 *   记账点 = `finalizeRun()` —— **每一条 return 路径都过它**（锁让路 / 通道让路 / `--only` 未匹配 / 正常收尾）。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 *   0 = 完成（含"无变化"）｜3 = **让路**（通道不通 / 对端不可达 / 锁被占 —— 物理常态，不是失败）｜1 = 真失败
 *   **2 = 拒绝执行**：参数越界（如 `--prune-archive --keep 0`）或**生产路径护栏**命中
 *   （`--transport local` 的 home / archiveRoot 落在生产 `~/.dsh` / `<数据区>/_archive`，且没带
 *   `--allow-production-fixture`）—— 防"哪天有人手工跑夹具又写生产"。
 *   （tickd 侧登记 `benignExitCodes:[3]`，所以 3 与 1 必须分开 —— 这条本卡就守住了。）
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node text-sync-direct.mjs [--apply] [--dir to-peer|from-peer|both] [--only docs,presets]
 *        [--peer <别名>] [--max-batch-bytes 8388608] [--staging <本地暂存根>]
 *        [--dual-write "<re>,<re>"] [--keep-staging] [--json] [--help]
 *   node text-sync-direct.mjs --status [--json]　　　　　← 只读：最近一轮 / rounds 尾部 / idle 三态
 *   node text-sync-direct.mjs --prune-archive [--apply] [--keep 30] [--max-mb 200]
 *   （夹具专用，生产别用：`--transport local --dsh-root … --home … --peer-dsh-root … --peer-home …`）
 *
 * ⚠️ **默认 dry-run**（生态规矩）：dry-run 会把三段式的 A/B 都真跑一遍（只读），C 只出计划、零传输零写入。
 *    ⇒ dry-run **不写状态文件**（口径 5「只在 `--apply` 写」；判据 2 就靠这条）。
 * ⚠️ **不挂 job、不拆 job、不改 butler-autonomy.json** —— 那是批 2 的事（见交付报告「待拍板」段）。
 * 🔴 不碰对端 `docs\管家报告` 与 `docs\坑库`（口径 import 自 `text-sync.mjs` 的 `SPECS`）。
 * 🔴 不碰 `.credentials*` / `keys` / `*.key` / `memory.db` / `task-board` / `sessions`（遍历阶段就排除）。
 *
 * 真源：`docs\交付报告-V3功能面-批1补双向直连-20261028.md`（同步本体）
 *       `docs\方案-文档直连同步可观测性-20261028.md`（可观测性 · v2 · §3 设计 / §5 判据）
 *       交付：`docs\交付报告-V3功能面-同步可观测性-20261028.md`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { TEXT_EXTS, SKIP_DIRS, SPECS } from './text-sync.mjs';
import { dshHome } from './lib/paths.mjs';
import {
  dshRoot, peerAlias, peerHome as peerHomeCfg, peerDshRoot as peerDshRootCfg,
} from '../lib/host-config.mjs';
import { acquireTickLock, writeTextAtomic } from './lib/store.mjs';
import { writeTargets } from './lib/state-paths.mjs';
import { writeStateText } from './lib/dual-write.mjs';
import { appendAudit } from './lib/audit.mjs';
import { ensurePeerChannel, releasePeerChannel } from '../lib/peer-channel.mjs';
import { walkFiles, isBlockedRel, inScopeExt } from './_direct/common.mjs';
import { writePack, loadPack, entryBuffer, sha256Buf, sha256FileAbs } from './_direct/packfile.mjs';

export const VERSION = 'text-sync-direct/0.1.0';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_YIELD = 3;

const SCRIPT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '_direct');
const SCRIPT_FILES = ['common.mjs', 'packfile.mjs', 'select.mjs', 'pack.mjs', 'place.mjs', 'unplace.mjs'];

/** 默认对端 ssh 别名。**未配置即空** —— 要求显式 `--peer`，不替用户猜一台机器。 */
const DEFAULT_PEER = peerAlias() || '';
const DEFAULT_PEER_HOME = peerHomeCfg() || '';
const DEFAULT_PEER_DSH_ROOT = peerDshRootCfg() || '';
const DEFAULT_STAGE_ROOT = path.join(dshRoot(), '_tmp', 'text-sync-direct');
const DEFAULT_ARCHIVE_ROOT = path.join(dshRoot(), '_archive', 'text-sync-direct');
const DEFAULT_MAX_BATCH = 8 * 1024 * 1024; // 2026-10-28 D7：32 MB 走隧道实测 `scp: Broken pipe`（rc=255），8 MB + 退避重试才稳
const LOCK_TTL_MS = 45 * 60 * 1000;

// ---- 可观测性常量（B1/B2/B3）---------------------------------------------------
const STATE_NAME = 'butler-text-sync-direct.json';   // dual 期真名由 writeTargets 算出（ops- / butler-）
const ROUNDS_KEEP = 48;              // rounds[] 上限（≈2 天，对齐 text-sync.mjs 先例）
const IDLE_THRESHOLD = 24;           // 连续 24 轮「跑成了但没东西搬」⇒ 摘要点名（**不接告警**）
const CONFLICT_LIST_MAX = 200;       // last.conflicts[] 上限
const CORRUPT_KEEP = 3;              // `.corrupt-*` 只留最近 3 份
const PRUNE_KEEP_DEFAULT = 30;
const PRUNE_MAX_MB_DEFAULT = 200;
/** runId 目录名。⚠️ `newRunId()` 的 PID 段**不 padStart**（原样 `${process.pid}`）⇒ 实测出现过 **4 位**
 *  PID（生产 `20261028-131535-2096-7fc6`）⇒ 正则必须从 2 位认起，否则那一轮目录**永久逃逸** retention
 *  （既不裁也不被任何规则清理）。2026-10-28 主会话验收时按生产实况把 `\d{5,7}` 放成 `\d{2,7}`。 */
const RUNID_DIR_RE = /^\d{8}-\d{6}-\d{2,7}-[0-9a-f]{4}$/;
/** 数据区 `_archive` 根（护栏对照物；该目录可能是 junction ⇒ 比较时两侧都取 realpath 形态）。 */
const PROD_ARCHIVE_ROOT = path.join(dshRoot(), '_archive');

/** 双写黑名单（**默认值**：两边都在改、谁覆盖谁都是丢数据）。键 = spec key，值是相对该根的路径正则。 */
const DEFAULT_DUAL_WRITE = {
  docs: [/^变更流水\//, /^(?:.*\/)?20\d{2}-\d.*\.md$/],
  presets: [],
};

const USAGE = [
  'dsh-butler / text-sync-direct —— 跨机文本直连同步（docs / presets；不经仓；默认 dry-run）',
  '',
  '  node text-sync-direct.mjs [--apply] [--dir to-peer|from-peer|both] [--only docs,presets]',
  '       [--peer <别名>] [--max-batch-bytes 8388608] [--staging <目录>]',
  '       [--dual-write "<re>,<re>"] [--keep-staging] [--json] [--help]',
  '',
  '  --apply                  真传/真落位（缺省 = dry-run：只读比一遍 + 出计划）',
  '  --dir <d>                方向：to-peer（本机→对端，默认 both 的第一半）/ from-peer / both（默认）',
  '  --only <k,k>             只处理 docs / presets',
  '  --peer <别名>            ssh 别名（默认取 $BUTLER_PEER；未配置则必须显式传）；通道链 = <别名>-lan → <别名> → 按需短租',
  '  --max-batch-bytes <N>    单批次上限（默认 8 MB —— 32 MB 走隧道实测会 `scp: Broken pipe`）',
  '  --staging <目录>         本机暂存根（默认 <数据区>/_tmp/text-sync-direct）',
  '  --dual-write <re,re>     覆盖双写黑名单（相对 spec 根的正则，逗号分隔）',
  '  --keep-staging           收尾不删本次暂存目录（排障用）',
  '',
  '  只读查询 / 留档清理（不传就不同步）：',
  '  --status                 打印最近一轮 / rounds 尾部 5 条 / idle 三态（不写文件、不抢锁、不探通道）',
  '  --prune-archive          裁 `_archive\\text-sync-direct` 下的 <runId> 目录（**默认 dry-run**）',
  '  --keep <N>               retention 保留份数（默认 30；< 1 ⇒ rc=2 拒跑 —— 不许算出"删光"）',
  '  --max-mb <M>             retention 总量上限 MB（默认 200；与份数取严）',
  '  --allow-production-fixture  --transport local 打到生产路径时**显式**放行（默认 rc=2 拒跑）',
  '',
  '  覆盖规则：对端没有=新增；本机更新=更新（旧件 .bak-只留1份）；对端更新=跳过；',
  '           判不了谁新=落 .conflict-<host>-<stamp> 副本；内容相同=跳过。🔴 永不删除任何文件。',
  '  退出码：0 完成 / 3 让路（通道不通·对端不可达·锁被占）/ 1 失败 / 2 拒绝执行（参数越界·生产路径护栏）',
].join('\n');

// ---------------------------------------------------------------- 参数
function parseArgs(argv) {
  const o = {
    apply: false, dir: 'both', only: null, json: false, peer: DEFAULT_PEER,
    maxBatchBytes: DEFAULT_MAX_BATCH, staging: DEFAULT_STAGE_ROOT, help: false,
    dualWrite: null, keepStaging: false,
    transport: 'ssh', dshRoot: dshRoot(), home: null,
    peerDshRoot: DEFAULT_PEER_DSH_ROOT, peerHome: DEFAULT_PEER_HOME,
    archiveRoot: DEFAULT_ARCHIVE_ROOT, lockName: 'text-sync-direct', forceLock: false,
    status: false, pruneArchive: false, keep: null, maxMb: null, allowProductionFixture: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--keep-staging') o.keepStaging = true;
    else if (a === '--force-lock') o.forceLock = true;
    else if (a === '--status') o.status = true;
    else if (a === '--prune-archive') o.pruneArchive = true;
    else if (a === '--allow-production-fixture') o.allowProductionFixture = true;
    else if (a === '--keep') o.keep = Number(argv[++i]);
    else if (a === '--max-mb') o.maxMb = Number(argv[++i]);
    else if (a === '--dir') o.dir = String(argv[++i] ?? '');
    else if (a === '--only') o.only = String(argv[++i] ?? '');
    else if (a === '--peer') o.peer = String(argv[++i] ?? '');
    else if (a === '--max-batch-bytes') o.maxBatchBytes = Number(argv[++i] ?? DEFAULT_MAX_BATCH);
    else if (a === '--staging') o.staging = String(argv[++i] ?? DEFAULT_STAGE_ROOT);
    else if (a === '--dual-write') o.dualWrite = String(argv[++i] ?? '');
    else if (a === '--transport') o.transport = String(argv[++i] ?? 'ssh');
    else if (a === '--dsh-root') o.dshRoot = String(argv[++i] ?? dshRoot());
    else if (a === '--home') o.home = String(argv[++i] ?? '');
    else if (a === '--peer-dsh-root') o.peerDshRoot = String(argv[++i] ?? DEFAULT_PEER_DSH_ROOT);
    else if (a === '--peer-home') o.peerHome = String(argv[++i] ?? DEFAULT_PEER_HOME);
    else if (a === '--archive-root') o.archiveRoot = String(argv[++i] ?? DEFAULT_ARCHIVE_ROOT);
    else if (a === '--lock-name') o.lockName = String(argv[++i] ?? 'text-sync-direct');
    else return { ...o, unknown: a };
  }
  return o;
}

// ---------------------------------------------------------------- 日志
const OUT = { lines: [], json: null };
let LOG_TO_STDERR = false;
function log(msg = '') {
  OUT.lines.push(msg);
  if (LOG_TO_STDERR) process.stderr.write(`${msg}\n`);
  else process.stdout.write(`${msg}\n`);
}

// ---------------------------------------------------------------- 口径（全部 import 自 text-sync.mjs）
function docsSkipDirs() {
  const s = SPECS.find((x) => x.key === 'docs');
  const set = new Set([...(s?.collectSkipDirs ?? []), ...(s?.backfillSkipDirs ?? [])]);
  return [...set];
}

function specDefs(o) {
  const commonSkip = [...SKIP_DIRS];
  return [
    {
      key: 'docs',
      localRoot: path.join(o.dshRoot, 'docs'),
      peerRoot: path.join(o.peerDshRoot, 'docs'),
      skipDirs: [...commonSkip, ...docsSkipDirs()],
      exts: [...TEXT_EXTS], allowNoExt: false,
    },
    {
      key: 'presets',
      localRoot: path.join(o.home, '.agent-presets'),
      peerRoot: path.join(o.peerHome, '.dsh', '.agent-presets'),
      skipDirs: [...commonSkip],
      exts: [...TEXT_EXTS], allowNoExt: true,
    },
  ];
}

function dualWriteRes(o) {
  if (o.dualWrite) {
    const list = String(o.dualWrite).split(',').map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s));
    return { '*': list };
  }
  return DEFAULT_DUAL_WRITE;
}

function isDualWrite(specKey, relPath, rules) {
  const rel = String(relPath).replace(/\\/g, '/');
  const rs = [...(rules[specKey] ?? []), ...(rules['*'] ?? [])];
  return rs.some((re) => re.test(rel));
}

/** 本机按口径出清单（**不算 sha**：阶段 A 只靠 size+mtime 快路径）。 */
function scanLocal(spec) {
  const map = walkFiles(spec.localRoot, { skipDirs: spec.skipDirs });
  const entries = [];
  let bytes = 0;
  for (const [rel, st] of map) {
    if (!inScopeExt(rel, spec.exts.map((e) => e.toLowerCase()), spec.allowNoExt)) continue;
    entries.push({ relPath: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs), abs: path.join(spec.localRoot, rel) });
    bytes += st.size;
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return { entries, bytes, files: entries.length, rawFiles: map.size };
}

// ---------------------------------------------------------------- 传输层（ssh / 夹具 local）
function sshArgs(target, extra = []) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', ...extra, target];
}

function probeSsh(target) {
  const r = spawnSync('ssh', sshArgs(target, ['-o', 'ConnectTimeout=6']).concat(['hostname']), {
    encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 1 << 20,
  });
  const out = String(r.stdout ?? '').trim();
  const ok = r.status === 0 && !!out;
  return { ok, hostname: ok ? out.split(/\r?\n/).pop() : null, err: ok ? null : String(r.stderr ?? r.error?.message ?? '').trim().slice(-200) };
}

/** 同步 sleep（原子等待，不引入 async）。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms | 0)); }
  catch { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
}

/**
 * 传输重试：跨机通道（VPS 中继隧道）**实测会中途掐断** —— 2026-10-28 首次真跑，
 * 32 MB 批次 scp 报 `scp: Couldn't send packet: Broken pipe`（rc=255），整轮白跑。
 * scp 覆盖写是幂等的 ⇒ 这里对 put/get 一律退避重试（默认 3 次 / 2s、5s）。
 * 只重试**传输**，不重试对端脚本执行（那些写目标目录，重试语义得由 place 的第三态管）。
 */
function withRetry(fn, { tries = 3, onRetry = null, label = '' } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    last = fn();
    if (last?.ok) return { ...last, attempts: i };
    if (i < tries) {
      if (onRetry) onRetry({ label, attempt: i, code: last?.code ?? null, err: String(last?.stderr || last?.error || '').slice(-160) });
      sleepSync(2000 * i);
    }
  }
  return { ...last, attempts: tries };
}

function makeTransport(o, channel) {
  const isLocal = o.transport === 'local';
  const target = channel?.target ?? o.peer;
  const logRetry = ({ label, attempt, code, err }) => log(`  ⚠️ 传输重试（${label} 第 ${attempt} 次失败 rc=${code}）：${err}`);
  const t = {
    kind: isLocal ? 'local' : 'ssh',
    target,
    exec(cmd) {
      if (isLocal) return norm(spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 10 * 60_000 }));
      return norm(spawnSync('ssh', sshArgs(target).concat([cmd.map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(' ')]), {
        encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 10 * 60_000,
      }));
    },
    mkdirp(dir) {
      if (isLocal) { fs.mkdirSync(dir, { recursive: true }); return { code: 0, ok: true, stdout: '', stderr: '', error: null }; }
      return t.exec(['cmd', '/c', `mkdir ${dir} 2>nul & exit 0`]);
    },
    put(files, remoteDir) {
      if (isLocal) {
        fs.mkdirSync(remoteDir, { recursive: true });
        for (const f of files) fs.copyFileSync(f, path.join(remoteDir, path.basename(f)));
        return { code: 0, ok: true, stdout: '', stderr: '', error: null };
      }
      return withRetry(() => norm(spawnSync('scp', ['-o', 'BatchMode=yes', '-q', ...files, `${target}:${slashed(remoteDir)}`], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 15 * 60_000,
      })), { onRetry: logRetry, label: `put ${files.length} 个文件` });
    },
    get(remoteFile, localFile) {
      if (isLocal) { fs.copyFileSync(remoteFile, localFile); return { code: 0, ok: true, stdout: '', stderr: '', error: null }; }
      return withRetry(() => norm(spawnSync('scp', ['-o', 'BatchMode=yes', '-q', `${target}:${slashed(remoteFile)}`, localFile], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 15 * 60_000,
      })), { onRetry: logRetry, label: `get ${path.basename(remoteFile)}` });
    },
    rmtree(dir) {
      if (isLocal) { fs.rmSync(dir, { recursive: true, force: true }); return { code: 0, ok: true, stdout: '', stderr: '', error: null }; }
      return t.exec(['cmd', '/c', `rmdir /s /q ${dir} 2>nul & exit 0`]);
    },
  };
  return t;
}

function slashed(p) { return String(p).replace(/\\/g, '/'); }

/** 统一成 `{ code, ok, stdout, stderr, error }`：spawnSync 的退出码在 `.status`，
 *  而夹具的本地实现给的是 `.code` —— 两种混读会**静默判失败**（本卡真踩过，见交付报告）。 */
function norm(r) {
  const code = typeof r?.status === 'number' ? r.status : (typeof r?.code === 'number' ? r.code : null);
  return { code, ok: code === 0, stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? ''), error: r?.error ? String(r.error.message ?? r.error) : null };
}

/** 在对端/本机跑一个 `_direct/*.mjs`：**job 用文件传参**（躲开 cmd 引号与中文路径）。 */
function runPeerScript(t, side, script, jobObj, ctx) {
  const stage = side === 'peer' ? ctx.peerStage : ctx.localStage;
  fs.mkdirSync(stage, { recursive: true });
  const jobFile = path.join(stage, `job-${script.replace(/\.mjs$/, '')}-${ctx.tag}.json`);
  const resultPath = jobFile.replace(/\.json$/, '-result.json');
  const job = { ...jobObj, runId: ctx.runId, resultPath };
  fs.writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`, 'utf8');

  let remoteJobFile = jobFile;
  if (side === 'peer' && t.kind === 'ssh') {
    const put = t.put([jobFile], stage);
    if (!put.ok) return { ok: false, stage: 'put-job', code: put.code, err: String(put.stderr || put.error || '').slice(-400) };
    remoteJobFile = path.join(stage, path.basename(jobFile));
  }

  // 对端只在 ssh 模式下才跑「暂存目录里的副本」；夹具模式两边共用同一份源码
  const scriptPath = (side === 'peer' && t.kind === 'ssh')
    ? path.join(ctx.peerStage, 'scripts', script)
    : path.join(SCRIPT_DIR, script);
  // ⚠️ side==='local' 必须**在本机跑**（走 ssh 会拿本机路径去对端找 place.mjs ⇒ MODULE_NOT_FOUND）
  const r = side === 'local'
    ? norm(spawnSync(process.execPath, [scriptPath, remoteJobFile], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 10 * 60_000 }))
    : t.exec(['node', scriptPath, remoteJobFile]);
  let result = null;
  try {
    if (side === 'peer' && t.kind === 'ssh') {
      const localResult = path.join(ctx.localStage, `result-${script.replace(/\.mjs$/, '')}-${ctx.tag}.json`);
      const g = t.get(resultPath, localResult);
      if (g.ok) result = JSON.parse(fs.readFileSync(localResult, 'utf8'));
    } else {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    }
  } catch (e) {
    return { ok: false, stage: 'read-result', code: r.code, err: `读不到结果 JSON：${e?.message ?? e}｜stdout=${String(r.stdout ?? '').slice(-200)}｜stderr=${String(r.stderr ?? '').slice(-300)}` };
  }
  return {
    ok: result?.ok === true && r.ok === true,
    code: r.code, stdout: String(r.stdout ?? '').trim().slice(-400), stderr: String(r.stderr ?? '').trim().slice(-400),
    result,
  };
}

// ---------------------------------------------------------------- 阶段 A/B：清单 + 比对
function buildSelectJob(specs, localListings) {
  return {
    mode: 'select',
    apply: false,
    sameMtimeToleranceMs: 2000,
    maxSha: 8000,
    specs: specs.map((s) => ({
      key: s.key, root: s.peerRoot,
      skipDirs: s.skipDirs, exts: s.exts, allowNoExt: s.allowNoExt,
      local: {
        files: localListings.get(s.key).files,
        bytes: localListings.get(s.key).bytes,
        entries: localListings.get(s.key).entries.map((e) => ({ relPath: e.relPath, size: e.size, mtimeMs: e.mtimeMs })),
      },
    })),
  };
}

/** 冲突副本名（**内容定了名字就定了**）：`<原名>.conflict-<发起方host>-<stamp>-<内容sha前8>`。
 *  为什么带 sha 前 8 位：这样"这轮还要不要再造一份"能**只靠名字**判断（对端不必算 sha），
 *  幂等就能做到「冲突了也不重复传」——否则每轮都会多一份副本。 */
function conflictNameOf(relPath, host, stamp, sha) {
  return `${relPath}.conflict-${host}-${stamp}-${String(sha ?? '').slice(0, 8)}`;
}

/** 「这份内容的冲突副本已经在了」——按 `<前缀>.conflict-…-<sha8>` 认，不看时间戳（每轮都变）。
 *  ⚠️ 两边给的名字空间不同：对端 artifacts 是 **relPath**、本机读目录拿到的是 **basename** ⇒ 前缀由调用方给。 */
function conflictAlready(names, prefix, sha) {
  const suffix = `-${String(sha ?? '').slice(0, 8)}`;
  for (const n of names ?? []) { if (String(n).startsWith(prefix) && String(n).endsWith(suffix)) return true; }
  return false;
}

// ---------------------------------------------------------------- 判定（四分类）
function decideToPeer(spec, sel, rules, ctx) {
  const out = { new: [], update: [], conflict: [], skip: [] };
  const byRel = new Map(spec.localEntries.map((e) => [e.relPath, e]));
  const peerArtifacts = new Set(sel.groups.artifacts ?? []);
  for (const rel of sel.groups.new ?? []) {
    const le = byRel.get(rel);
    if (!le) continue;
    out.new.push({ relPath: rel, size: le.size, bytes: le.size, action: 'create' });
  }
  for (const d of sel.groups.differ ?? []) {
    const le = byRel.get(d.relPath);
    if (!le) continue;
    const localSha = safeSha(le.abs);
    if (d.peerSha && localSha && localSha === d.peerSha) { out.skip.push({ relPath: d.relPath, size: le.size, bytes: le.size, reason: 'same-content' }); continue; }
    if (isDualWrite(spec.key, d.relPath, rules)) { pushConflict(out, d.relPath, le, localSha, ctx, peerArtifacts, 'dual-write'); continue; }
    const dt = Number(le.mtimeMs) - Number(d.peerMtimeMs);
    if (Math.abs(dt) < 2000) { pushConflict(out, d.relPath, le, localSha, ctx, peerArtifacts, 'mtime-tie'); continue; }
    if (dt < 0) { out.skip.push({ relPath: d.relPath, size: le.size, bytes: le.size, reason: 'peer-newer' }); continue; }
    if (!d.peerSha) { out.skip.push({ relPath: d.relPath, size: le.size, bytes: le.size, reason: 'no-old-sha(拒覆盖)' }); continue; }
    out.update.push({ relPath: d.relPath, size: le.size, bytes: le.size, action: 'update', expectOldSha: d.peerSha, localSha });
  }
  return out;
}

function pushConflict(out, relPath, le, localSha, ctx, peerArtifacts, reason) {
  if (conflictAlready([...peerArtifacts], `${relPath}.conflict-${ctx.host}-`, localSha)) {
    out.skip.push({ relPath, size: le.size, bytes: le.size, reason: `${reason}(冲突副本已在)` });
    return;
  }
  out.conflict.push({ relPath, size: le.size, bytes: le.size, reason, localSha });
}

function decideFromPeer(spec, sel, rules, ctx) {
  const out = { pull: [], conflict: [], skip: [] };
  const byRel = new Map(spec.localEntries.map((e) => [e.relPath, e]));
  const pushLocalConflict = (relPath, size, localSha, peerSha, reason) => {
    // 本机已有"这份对端内容"的冲突副本 ⇒ 不再拉第二份（副本名带内容 sha 前 8 位，认得出）
    const dir = path.join(spec.localRoot, path.dirname(relPath));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    if (conflictAlready(names, `${path.basename(relPath)}.conflict-`, peerSha)) {
      out.skip.push({ relPath, size, bytes: size, reason: `${reason}(冲突副本已在)` });
      return;
    }
    out.conflict.push({ relPath, size, bytes: size, reason, expectOldSha: localSha });
  };
  for (const p of sel.groups.peerOnly ?? []) {
    out.pull.push({ relPath: p.relPath, size: p.size, bytes: p.size, action: 'create', peerSha: p.sha256 });
  }
  for (const d of sel.groups.differ ?? []) {
    const le = byRel.get(d.relPath);
    if (!le) continue;
    const localSha = safeSha(le.abs);
    if (d.peerSha && localSha && localSha === d.peerSha) { out.skip.push({ relPath: d.relPath, size: le.size, bytes: le.size, reason: 'same-content' }); continue; }
    if (isDualWrite(spec.key, d.relPath, rules)) { pushLocalConflict(d.relPath, d.peerSize, localSha, d.peerSha, 'dual-write'); continue; }
    const dt = Number(le.mtimeMs) - Number(d.peerMtimeMs);   // >0 ⇒ 本机较新
    if (Math.abs(dt) < 2000) { pushLocalConflict(d.relPath, d.peerSize, localSha, d.peerSha, 'mtime-tie'); continue; }
    if (dt > 0) { out.skip.push({ relPath: d.relPath, size: le.size, bytes: le.size, reason: 'local-newer(不覆盖)' }); continue; }
    if (!localSha) { out.skip.push({ relPath: d.relPath, size: le.size, bytes: le.size, reason: 'no-local-sha(拒覆盖)' }); continue; }
    out.pull.push({ relPath: d.relPath, size: d.peerSize, bytes: d.peerSize, action: 'update', peerSha: d.peerSha, expectOldSha: localSha });
  }
  return out;
}

function safeSha(abs) {
  try { return sha256FileAbs(abs); } catch { return null; }
}

// ---------------------------------------------------------------- 打包（本机 → 对端）
function packLocally(o, spec, items, stamp, packsDir) {
  const packs = [];
  const byRel = new Map(spec.localEntries.map((e) => [e.relPath, e]));
  let batch = [];
  let batchBytes = 0;
  const flush = () => {
    if (!batch.length) return;
    const file = path.join(packsDir, `${stamp}-${spec.key}-${String(packs.length + 1).padStart(4, '0')}.pk`);
    const w = writePack(file, { specKey: spec.key, stamp, files: batch.map((b) => ({ relPath: b.relPath, absPath: b.abs, mtimeMs: b.mtimeMs })) });
    packs.push({ file, localFile: file, bytes: w.bytes, entries: w.header.entries });
    batch = []; batchBytes = 0;
  };
  for (const it of items) {
    const le = byRel.get(it.relPath);
    if (!le) continue;
    if (batch.length && batchBytes + le.size > o.maxBatchBytes) flush();
    batch.push({ relPath: it.relPath, abs: le.abs, mtimeMs: le.mtimeMs });
    batchBytes += le.size;
  }
  flush();
  return packs;
}

// ================================================================ B1/B2/B3：状态账本 / retention / 查询
// 设计真源 = `docs\方案-文档直连同步可观测性-20261028.md` §3（v2）+ 追审 round=2 的 E-1/E-2/E-3 修法。
// 【记账口径 8 条（写死，防两套算法）】
//   ① 每 spec 带 `dir`（`--dir both` 会出两条同 key 的 spec）
//   ② totals 五计数按方向相加：pushed=Σnew / updated=Σupdate / skipped=Σskip / conflicts=Σconflict / pulled=Σpull
//      · `conflicts` **按方向计数**：同一份冲突文件可能两方向各判一次（各落一个副本）⇒ both 时可以是 2
//      · `skip` **不含"快路径判同"**（阶段 B 的 size+mtime 快路径记在 select.counts.same，不进 decision.skip）
//   ③ 两个字节字段分开（**E-1**）：`decisionBytes = Σ(newBytes+updateBytes+conflictBytes)` = "判定口径"；
//      `transferBytes = Σ specs[].transfer.bytes` = 真实搬运量。
//      ⚠️ **回程轮通常 0（回程结构上不产 new/update），但回程产生冲突副本时非 0** —— 生产
//      `_archive\text-sync-direct\20261028-131417-39988-2b09` 与 `…131535-2096-7fc6` 两轮实测
//      `from-peer` + `conflictBytes=1505`。**别把这条写成"纯回程恒 0"**。
//   ④ `rounds[]` 只存计数与结果（不存冲突清单），`.slice(-48)`；另带 `idleRole`（full / partial）
//   ⑤ **只在 `--apply` 写**；让路轮（exit 3）与失败轮（exit 1）**也写一条**（否则 `--status` 会跳过整段断网期）
//   ⑥ dual 双名：读 primary 优先 + mirror 兜底（两份都读得出时按 `updatedAt` 新者 —— partial 写失败窗口）；
//      写 `writeStateText`（序列化一次、两个原子写）；**两份都坏**才各自 rename `.corrupt-*`，
//      只坏一份 ⇒ 用好的那份重建坏的（**不许只 rename 不重建**）；`.corrupt-*` 只留最近 3 份
//   ⑦ 写失败两个层级：状态写失败 ⇒ `appendAudit(state-write-failed)` + stderr，**不改 exit、不写 last.errors**；
//      manifest 写失败 ⇒ `res.warnings` + `appendAudit(manifest-write-failed)`，**不改 exit**
//   ⑧ 坏 JSON / 字段类型不对 ⇒ 不崩，按"首次运行"重建

const EXIT_REFUSE = 2;

function stderrLine(msg) { process.stderr.write(`${msg}\n`); }
const n0 = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** 一个路径的多种形态（resolve / realpath；小写 + 去尾分隔符）—— 生产护栏比对用（junction 坑）。 */
function pathVariants(p) {
  const out = new Set();
  const push = (x) => { try { out.add(String(x).toLowerCase().replace(/[\\/]+$/, '')); } catch { /* ignore */ } };
  let abs;
  try { abs = path.resolve(String(p)); } catch { return out; }
  push(abs);
  try { push(fs.realpathSync.native(abs)); } catch { /* 不存在 */ }
  try { push(fs.realpathSync(abs)); } catch { /* 不存在 */ }
  return out;
}
function intersects(a, b) { for (const x of pathVariants(a)) if (pathVariants(b).has(x)) return true; return false; }
function underOrEqual(a, b) {
  const vb = pathVariants(b);
  for (const x of pathVariants(a)) for (const y of vb) if (x === y || x.startsWith(`${y}\\`) || x.startsWith(`${y}/`)) return true;
  return false;
}

/**
 * §10 P5 护栏：`--transport local`（夹具模式）一旦打到**生产 home / 生产 _archive** ⇒ rc=2 拒跑。
 * 理由：代码默认值全指生产（`o.home = dshHome()` / `archiveRoot = <数据区>/_archive/text-sync-direct`），
 * 而 manifest 写入判据不看 transport ⇒ 漏参数的夹具会往生产 `_archive` 写真清单、按 `--keep` 还能删真清单。
 * 逃生：显式 `--allow-production-fixture`（打印警告后放行）。
 * @returns {string[]|null} 命中的参数列表（null = 放行）
 */
function guardProductionFixture(o) {
  if (o.transport !== 'local' || o.allowProductionFixture) return null;
  const hits = [];
  const prodHome = path.join(os.homedir(), '.dsh');
  const home = o.home ?? dshHome();
  if (intersects(home, prodHome) || intersects(home, path.resolve(prodHome))) hits.push(`--home ${home}（= 生产 ~\\.dsh）`);
  if (underOrEqual(o.archiveRoot, PROD_ARCHIVE_ROOT)) hits.push(`--archive-root ${o.archiveRoot}（在数据区 _archive 之下）`);
  return hits.length ? hits : null;
}

// ---------------------------------------------------------------- 状态文件读写（双名 / 自愈）
function statePathsOf(home) {
  const { mode, primary, mirrors } = writeTargets(STATE_NAME, { home });
  return { mode, primary, mirrors: mirrors ?? [] };
}

function emptyState() {
  return {
    schemaVersion: 1, host: os.hostname(), createdAt: new Date().toISOString(), updatedAt: null,
    last: null, rounds: [], idle: { state: 'unknown', streak: 0, since: null, lastPushAt: null, lastExit: null },
  };
}

/** 结构判据（口径 8：字段类型不对 ⇒ 当坏文件处理，按首次运行重建）。 */
function validState(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (d.last != null && (typeof d.last !== 'object' || Array.isArray(d.last))) return false;
  if (d.rounds != null && !Array.isArray(d.rounds)) return false;
  if (d.idle != null && (typeof d.idle !== 'object' || Array.isArray(d.idle))) return false;
  return true;
}

function readTextMaybe(p) {
  try { return { exists: true, text: fs.readFileSync(p, 'utf8') }; }
  catch (e) {
    const missing = e?.code === 'ENOENT';
    return { exists: !missing, missing, text: null, err: String(e?.message ?? e) };
  }
}

function parseStateText(text) {
  if (typeof text !== 'string') return null;
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  return validState(d) ? d : null;
}

function corruptStamp() {
  const d = new Date();
  const p = (x, w = 2) => String(x).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    + `-${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
}

/** `.corrupt-*` 只留最近 3 份（按 mtime 倒序；它不在 `_archive` 树里，也不匹配 runId 正则 ⇒ 不会被 prune 误删）。 */
function pruneCorrupt(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-')); } catch { return []; }
  const items = names.map((n) => {
    const p = path.join(dir, n);
    let m = 0;
    try { m = fs.statSync(p).mtimeMs; } catch { /* ignore */ }
    return { p, m };
  }).sort((a, b) => b.m - a.m);
  const drop = items.slice(CORRUPT_KEEP).map((x) => x.p);
  for (const p of drop) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  return drop;
}

/**
 * 读状态（双名）。口径 6：
 *   · 只有一份读得出 ⇒ 用它，并把坏的那份**重建**（不许只 rename 不重建）
 *   · 两份都读得出 ⇒ **updatedAt 新者为准**（tie ⇒ primary）—— 覆盖"partial 写失败只剩旧一轮"的窗口
 *   · 两份都坏 ⇒ 各自 rename `.corrupt-<stamp>`，`.corrupt-*` 留 3 份，然后按首次运行重建
 *   · 都不存在 ⇒ 空态（`--status` 再回退扫最近一份 manifest）
 * `--status` 走 `readOnly:true`（方案 §3.4「**不写任何文件**」）：坏文件既不 rename 也不重建，只按"读不出"处理。
 * @param {{readOnly?:boolean}} [opts]
 * @returns {{data:object|null, source:'primary'|'mirror'|'none', paths:object, healed:string[], corrupt:string[], bad:string[]}}
 */
function loadStateDual(home, opts = {}) {
  const readOnly = opts.readOnly === true;
  const paths = statePathsOf(home);
  const targets = [paths.primary, ...paths.mirrors];
  const rows = targets.map((p) => ({ p, r: readTextMaybe(p) }));
  const good = [];
  const bad = [];
  const healed = [];
  const corrupt = [];
  for (const x of rows) {
    if (x.r.missing) continue;
    const d = parseStateText(x.r.text);
    if (d) good.push({ ...x, d }); else bad.push(x);
  }
  let chosen = null;
  if (good.length) {
    chosen = good.find((g) => g.p === paths.primary) ?? good[0];
    for (const g of good) {
      if (g === chosen) continue;
      const cur = Date.parse(chosen.d?.updatedAt ?? '') || 0;
      const cand = Date.parse(g.d?.updatedAt ?? '') || 0;
      if (cand > cur) chosen = g;
    }
    if (!readOnly) {
      for (const b of bad) {
        try {
          writeTextAtomic(b.p, chosen.r.text ?? `${JSON.stringify(chosen.d, null, 2)}\n`);
          healed.push(b.p);
        } catch (e) { stderrLine(`⚠️ 状态文件自愈失败（${b.p}）：${e?.message ?? e}`); }
      }
    }
  } else if (bad.length && !readOnly) {
    for (const b of bad) {
      const dst = `${b.p}.corrupt-${corruptStamp()}`;
      try { fs.renameSync(b.p, dst); corrupt.push(dst); }
      catch (e) { stderrLine(`⚠️ 坏状态文件留档失败（${b.p}）：${e?.message ?? e}`); }
    }
    pruneCorrupt(path.dirname(paths.primary));
  }
  const source = chosen ? (chosen.p === paths.primary ? 'primary' : 'mirror') : 'none';
  return { data: chosen?.d ?? null, source, paths, healed, corrupt, bad: bad.map((b) => b.p) };
}

/** 写状态（序列化一次 + 双写原子）；失败不抛（由调用方记审计 + stderr）。 */
function saveStateTo(home, st) {
  const text = `${JSON.stringify(st, null, 2)}\n`;
  const paths = statePathsOf(home);
  try {
    return writeStateText(STATE_NAME, text, { home, write: (p, t) => writeTextAtomic(p, t) });
  } catch (e) {
    return { ok: false, kind: 'threw', failures: [{ role: 'both', error: String(e?.message ?? e) }], primary: paths.primary, mirrors: paths.mirrors, mode: paths.mode };
  }
}

/** 口径 7 第一层：状态写失败 ⇒ 审计一行 + stderr 一行；**不改 exit、不写 last.errors**（那是自指死路）。 */
function reportStateWriteFailure(o, r) {
  const failures = (r?.failures ?? []).map((f) => ({ role: f.role, path: f.path, error: f.error }));
  stderrLine(`⚠️ 状态文件写失败（${r?.kind ?? 'unknown'}）：${failures.map((f) => `${f.role}:${f.error}`).join(' | ') || '未知错误'}`);
  try { appendAudit({ type: 'text-sync-direct', action: 'state-write-failed', kind: r?.kind ?? 'unknown', failures }, { home: o.home }); }
  catch { /* 审计写失败自己会告警，这里不再抛 */ }
}

// ---------------------------------------------------------------- 账目（totals / last / rounds / idle）
function collectTotals(res) {
  const t = { pushed: 0, updated: 0, skipped: 0, conflicts: 0, pulled: 0, decisionBytes: 0, transferBytes: 0 };
  for (const p of res?.phases ?? []) {
    for (const s of p.specs ?? []) {
      const d = s.decision;
      if (!d) continue;
      t.pushed += n0(d.new); t.updated += n0(d.update); t.skipped += n0(d.skip);
      t.conflicts += n0(d.conflict); t.pulled += n0(d.pull);
      t.decisionBytes += n0(d.newBytes) + n0(d.updateBytes) + n0(d.conflictBytes);
      t.transferBytes += n0(s.transfer?.bytes);
    }
  }
  return t;
}

function buildLast(res, totals) {
  const specs = [];
  const conflicts = [];
  for (const p of res?.phases ?? []) {
    for (const s of p.specs ?? []) {
      const d = s.decision ?? null;
      specs.push({
        dir: p.dir, key: s.key,
        new: n0(d?.new), update: n0(d?.update), conflict: n0(d?.conflict), skip: n0(d?.skip),
        newBytes: n0(d?.newBytes), updateBytes: n0(d?.updateBytes),
        conflictBytes: n0(d?.conflictBytes), skipBytes: n0(d?.skipBytes),
        pull: n0(d?.pull), pullBytes: n0(d?.pullBytes),
        transfer: { files: n0(s.transfer?.files), bytes: n0(s.transfer?.bytes), packs: n0(s.transfer?.packs) },
      });
      for (const c of s.conflictCopies ?? []) {
        if (conflicts.length >= CONFLICT_LIST_MAX) break;
        conflicts.push({ dir: p.dir, specKey: s.key, relPath: c.relPath, sha256: c.sha256 ?? null, bytes: n0(c.bytes) });
      }
    }
  }
  const ch = res?.channel;
  return {
    at: res?.at ?? new Date().toISOString(), mode: res?.mode ?? null, dir: res?.dir ?? null, peer: res?.peer ?? null,
    channel: ch ? { kind: ch.kind ?? null, target: ch.target ?? null, rented: ch.rented === true } : null,
    exit: n0(res?.exit), reason: res?.reason ?? null, durationMs: n0(res?.durationMs),
    specs, totals, conflicts,
    manifests: res?.manifests ?? [],
    errors: res?.errors ?? [],
  };
}

function buildRound(res, totals) {
  return {
    at: res?.at ?? new Date().toISOString(), mode: res?.mode ?? null, dir: res?.dir ?? null,
    exit: n0(res?.exit), reason: res?.reason ?? null,
    channel: res?.channel?.kind ?? null,     // **只存字符串**（lan / tunnel / local / null）—— 让路轮的 res.channel 是对象
    pushed: totals.pushed, updated: totals.updated, skipped: totals.skipped,
    conflicts: totals.conflicts, pulled: totals.pulled,
    decisionBytes: totals.decisionBytes, transferBytes: totals.transferBytes,
    idleRole: res?.dir === 'both' ? 'full' : 'partial',
  };
}

/**
 * 空转三态（§3.2）：
 *   idle    = exit 0 且 pushed+updated===0 且 pulled===0 ⇒ streak+1、since 记首轮
 *   active  = exit 0 且 pushed+updated+pulled > 0 ⇒ streak=0、since=null、lastPushAt=本轮
 *   unknown = exit !== 0（让路 3 / 失败 1）⇒ **streak 不动**，只记 lastExit
 * 追加口径（追审 E-8）：单方向轮（`--dir to-peer|from-peer`）的"零推送/零拉取"是**结构性**的
 *   ⇒ 不改 streak、不改 state（rounds 里标 `idleRole:'partial'`）—— 否则手工单方向轮会虚增 streak。
 */
function nextIdle(prev, res, totals) {
  const p = (prev && typeof prev === 'object' && !Array.isArray(prev)) ? prev : {};
  const idle = {
    state: ['idle', 'active', 'unknown'].includes(p.state) ? p.state : 'unknown',
    streak: n0(p.streak), since: p.since ?? null, lastPushAt: p.lastPushAt ?? null, lastExit: p.lastExit ?? null,
  };
  if (n0(res?.exit) !== EXIT_OK) { idle.state = 'unknown'; idle.lastExit = n0(res?.exit); return idle; }
  idle.lastExit = 0;
  if (res?.dir !== 'both') return idle;
  const moved = totals.pushed + totals.updated + totals.pulled;
  if (moved > 0) {
    idle.state = 'active'; idle.streak = 0; idle.since = null; idle.lastPushAt = res?.at ?? new Date().toISOString();
    return idle;
  }
  idle.state = 'idle';
  idle.streak = n0(p.streak) + 1;
  idle.since = p.since || res?.at || new Date().toISOString();
  idle.lastPushAt = p.lastPushAt ?? null;
  return idle;
}

/**
 * 把一轮结果记进状态文件（读 → 合并 → 写）。**唯一记账入口**（由 `finalizeRun` 调）。
 * ⚠️ 已知边界：状态文件本身**不加锁**（它只是派生视图，且 tickd 单写者占着 tick 锁）；
 *    人工轮与 tickd 轮极端并发时可能丢一条 round —— 代价可接受（manifest 才是权威源）。
 */
function recordRound(res, o) {
  const loaded = loadStateDual(o.home);
  const st = loaded.data ?? emptyState();
  const totals = collectTotals(res);
  st.schemaVersion = 1;
  st.host = st.host || os.hostname();
  // 首轮 createdAt 取**本轮 at**（不是写入时刻）：否则"文件创建时间"会晚于"最近一轮时间"，看着像时钟回拨
  st.createdAt = st.createdAt || (res?.at ?? new Date().toISOString());
  st.updatedAt = res?.at ?? new Date().toISOString();
  st.last = buildLast(res, totals);
  const rounds = Array.isArray(st.rounds) ? st.rounds : [];
  st.rounds = [...rounds, buildRound(res, totals)].slice(-ROUNDS_KEEP);
  st.idle = nextIdle(st.idle, res, totals);
  const w = saveStateTo(o.home, st);
  if (!w.ok) reportStateWriteFailure(o, w);
  // 空转摘要要的"其中 M 轮让路"= 自 `idle.since` 起、rounds 里 exit≠0 的条数
  const sinceMs = Date.parse(st.idle?.since ?? '') || 0;
  const yieldSince = st.rounds.filter((r) => n0(r.exit) !== 0 && (Date.parse(r.at ?? '') || 0) >= sinceMs).length;
  return {
    ok: w.ok === true, kind: w.kind ?? null,
    primary: w.primary ?? loaded.paths.primary, mirrors: w.mirrors ?? loaded.paths.mirrors, mode: w.mode ?? loaded.paths.mode,
    source: loaded.source, healed: loaded.healed, corrupt: loaded.corrupt,
    idle: st.idle, rounds: st.rounds.length, totals, yieldSince,
  };
}

/**
 * **唯一收尾**（E-2 修法）：构造 `res` 之后的每一条 return 路径都走它 ——
 * ① 补 durationMs ② 写状态（仅 `--apply`）③ 打印摘要（含 idle 三态与空转告警行）④ 打 JSON ⑤ 返回 exit code。
 * ⚠️ in-try 早退（通道让路 / 推脚本失败 / `--only` 未匹配）时，`finally` 的放锁/关租发生在它**之后**
 *    ⇒ 摘要里少一行「短租收尾」，但账本字段（channel / exit / reason）已定，不受影响。
 * @param {{t0?:number, record?:boolean}} [opts] record:false ⇒ 不写状态（`--help` / 参数错等非同步路径）
 */
function finalizeRun(res, o, opts = {}) {
  const t0 = Number(opts.t0 ?? NaN);
  if (res.durationMs == null) res.durationMs = Number.isFinite(t0) ? Math.max(0, Date.now() - t0) : 0;
  let stateInfo = null;
  if (o.apply && opts.record !== false) {
    try { stateInfo = recordRound(res, o); }
    catch (e) { stderrLine(`⚠️ 状态记账异常（不影响本轮同步）：${e?.message ?? e}`); }
  }
  log('');
  log(summary(res, o, stateInfo));
  OUT.json = res;
  if (o.json) log(`---JSON---\n${JSON.stringify(res, null, 2)}`);
  return res.exit;
}

// ---------------------------------------------------------------- B2：留档 retention
/** 列 `_archive` 根下的 `<runId>` 目录（新 → 旧，按目录名 = runId 时间序；不匹配的一律不碰）。 */
function listRunDirs(root) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const dirs = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (!RUNID_DIR_RE.test(e.name)) continue;
    const abs = path.join(root, e.name);
    let bytes = 0;
    let files = 0;
    try {
      for (const f of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        try { bytes += fs.statSync(path.join(abs, f.name)).size; files++; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    dirs.push({ name: e.name, abs, bytes, files });
  }
  dirs.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return dirs;
}

/**
 * `--prune-archive`：把 `<runId>` 形态目录裁到「最近 `--keep` 份 且总量 ≤ `--max-mb`」，两条件**取严**。
 * 🔴 默认 dry-run；`--keep < 1` ⇒ rc=2（不许算出"删光"）；`_archive` 不存在 / 0 个 runId 目录 ⇒ rc=0。
 * 🔴 生效后更老的轮次**不可回滚**（`rollback-direct-sync.mjs` 的输入只剩最近 N 份）。
 */
function cmdPruneArchive(o) {
  const keep = o.keep == null ? PRUNE_KEEP_DEFAULT : Number(o.keep);
  const maxMb = o.maxMb == null ? PRUNE_MAX_MB_DEFAULT : Number(o.maxMb);
  if (!Number.isFinite(keep) || keep < 1) {
    stderrLine(`❌ --keep 必须 ≥ 1（收到 ${o.keep == null ? '(缺省)' : o.keep}）—— 拒跑，避免一次算出"删光"（rc=2）`);
    return EXIT_REFUSE;
  }
  if (!Number.isFinite(maxMb) || maxMb <= 0) {
    stderrLine(`❌ --max-mb 必须是正数（收到 ${o.maxMb == null ? '(缺省)' : o.maxMb}）—— rc=2`);
    return EXIT_REFUSE;
  }
  const root = o.archiveRoot;
  const dirs = listRunDirs(root);
  log('════ 留档 retention（_archive\\text-sync-direct）════');
  if (dirs === null) { log(`   ${root} 不存在 ⇒ 无需清理（rc=0）`); return EXIT_OK; }
  const ignored = (() => {
    try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !RUNID_DIR_RE.test(e.name)).length; }
    catch { return 0; }
  })();
  if (!dirs.length) { log(`   ${root} 里 0 个 <runId> 目录（非 runId 目录 ${ignored} 个，不碰）⇒ 无需清理（rc=0）`); return EXIT_OK; }
  const keepList = dirs.slice(0, keep);
  const removeList = dirs.slice(keep);
  let keptBytes = keepList.reduce((a, d) => a + d.bytes, 0);
  const limit = maxMb * 1048576;
  while (keptBytes > limit && keepList.length > 1) {          // 体积从最老继续裁（永远留最新一份）
    const oldest = keepList.pop();
    removeList.push(oldest);
    keptBytes -= oldest.bytes;
  }
  removeList.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));   // 删的时候从最老开始
  const freeBytes = removeList.reduce((a, d) => a + d.bytes, 0);
  const totalBytes = dirs.reduce((a, d) => a + d.bytes, 0);
  log(`   根 ${root}`);
  log(`   现状 ${dirs.length} 份 <runId> / ${mb(totalBytes)}（非 runId 目录 ${ignored} 个，**不碰**）`);
  log(`   口径 留最近 ${keep} 份 且 ≤ ${maxMb} MB（两条件取严）`);
  log(`   保留 ${keepList.length} 份 / ${mb(keptBytes)}：新 ${keepList[0]?.name ?? '-'} … 老 ${keepList[keepList.length - 1]?.name ?? '-'}`);
  if (!removeList.length) { log('   ⇒ 无需清理（rc=0）'); return EXIT_OK; }
  log(`   ${o.apply ? '删除' : '将删'} ${removeList.length} 份 / 释放 ${mb(freeBytes)}（从最老开始）：`);
  for (const d of removeList) log(`     - ${d.name}（${d.files} 文件 / ${mb(d.bytes)}）`);
  if (!o.apply) { log('   ⓘ dry-run（默认）：一个字节没删；加 --apply 才真删。'); return EXIT_OK; }
  let removed = 0;
  let freed = 0;
  const failed = [];
  for (const d of removeList) {
    try { fs.rmSync(d.abs, { recursive: true, force: true }); removed++; freed += d.bytes; }
    catch (e) { failed.push({ name: d.name, err: String(e?.message ?? e) }); }
  }
  log(`   ⇒ 已删 ${removed} 份 / 释放 ${mb(freed)}${failed.length ? `　⚠️ 失败 ${failed.length} 份` : ''}`);
  for (const f of failed) log(`     ✗ ${f.name}：${f.err}`);
  try { appendAudit({ type: 'text-sync-direct', action: 'prune-archive', root, removed, kept: keepList.length, bytes: freed, keep, maxMb }, { home: o.home }); }
  catch { /* 审计失败不拖垮清理 */ }
  return failed.length ? EXIT_FAIL : EXIT_OK;
}

// ---------------------------------------------------------------- B3：--status（只读）
function cmdStatus(o) {
  // 方案 §3.4：**不写任何文件、不抢锁、不探通道** ⇒ 只读模式（坏文件既不 rename 也不重建）
  const loaded = loadStateDual(o.home, { readOnly: true });
  const paths = loaded.paths;
  const out = {
    status: null, statePath: paths.primary, stateMirror: paths.mirrors, source: 'none',
    rounds: [], idle: null, manifest: null,
  };
  log('════ 直连同步状态（--status · 只读）════');
  if (loaded.bad.length) log(`   ⚠️ 坏状态文件（--status **只读**：既不 rename 也不重建 —— 自愈留给下一轮 --apply）：${loaded.bad.join(' , ')}`);
  if (!loaded.data?.last) {
    log('   （尚无记录）');
    log(`   候选路径：${[paths.primary, ...paths.mirrors].join(' ｜ ')}`);
    // 回退源（I-7）：状态文件缺失但 `_archive` 有 manifest ⇒ 扫**最近一份**只读回显（不重建状态文件）
    const dirs = listRunDirs(o.archiveRoot);
    if (dirs && dirs.length) {
      const latest = dirs[0];
      const mf = path.join(latest.abs, 'manifest.json');
      try {
        const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
        let conf = 0;
        let created = 0;
        for (const p of man.phases ?? []) for (const s of p.specs ?? []) { conf += (s.conflictCopies ?? []).length; created += (s.created ?? []).length; }
        out.source = 'manifest';
        out.manifest = { path: mf, runId: latest.name, at: man.at ?? null, dir: man.dir ?? null, peer: man.peer ?? null, conflicts: conf, created };
        log(`   ⓘ 回退源（manifest · 只读，不重建状态文件）：${mf}`);
        log(`     轮次 ${latest.name}　at ${man.at ?? '?'}　dir ${man.dir ?? '?'}　对端 ${man.peer ?? '?'}　冲突副本 ${conf} 份　新建 ${created} 份`);
      } catch (e) {
        log(`   ⚠️ 最近 manifest 读不出（${mf}）：${e?.message ?? e}`);
      }
    }
    log(`   状态文件：${paths.primary}${paths.mirrors.length ? `（mirror ${paths.mirrors.join(' , ')}）` : ''}`);
    OUT.json = out;
    if (o.json) log(`---JSON---\n${JSON.stringify(out, null, 2)}`);
    return EXIT_OK;
  }

  const st = loaded.data;
  const L = st.last;
  const t = L.totals ?? collectTotals({ phases: [] });
  out.status = L;
  out.source = loaded.source;
  out.rounds = Array.isArray(st.rounds) ? st.rounds : [];
  out.idle = st.idle ?? null;

  log(`   设备 ${st.host ?? '?'}　上次 ${L.at ?? '?'}　模式 ${L.mode ?? '?'}　方向 ${L.dir ?? '?'}　对端 ${L.peer ?? '?'}`);
  log(`   通道 ${L.channel?.kind ?? '?'}（${L.channel?.target ?? ''}${L.channel?.rented ? ' · 本轮短租' : ''}）　`
    + `退出码 ${L.exit}${L.reason ? `（${L.reason}）` : ''}　耗时 ${((L.durationMs ?? 0) / 1000).toFixed(1)}s`);
  for (const s of L.specs ?? []) {
    // ① spec 级**没有** decisionBytes / transferBytes 字段 ⇒ 这里**现算**（E-7 ①）
    const dec = n0(s.newBytes) + n0(s.updateBytes) + n0(s.conflictBytes);
    log(`   ${String(s.dir ?? '-').padEnd(9)} ${String(s.key ?? '-').padEnd(8)}`
      + ` 新增 ${n0(s.new)} / 更新 ${n0(s.update)} / 冲突 ${n0(s.conflict)} / 跳过 ${n0(s.skip)} / 拉取 ${n0(s.pull)}`
      + `　decisionBytes ${fmtBytes(dec)} · transferBytes ${fmtBytes(s.transfer?.bytes ?? 0)}`);
  }
  log(`   合计 推送 ${t.pushed ?? 0} / 更新 ${t.updated ?? 0} / 跳过 ${t.skipped ?? 0} / 冲突 ${t.conflicts ?? 0} / 拉取 ${t.pulled ?? 0}`
    + `　decisionBytes ${fmtBytes(t.decisionBytes ?? 0)} · transferBytes ${fmtBytes(t.transferBytes ?? 0)}`);
  if ((L.conflicts ?? []).length) {
    log(`   冲突副本 ${L.conflicts.length} 份（最多显示 5）：`);
    for (const c of L.conflicts.slice(0, 5)) log(`     ${c.dir} ${c.specKey} ${c.relPath}（${c.bytes} B）`);
  }
  if ((L.manifests ?? []).length) log(`   清单：${L.manifests.join(' , ')}`);
  const rounds = out.rounds;
  log(`   rounds ${rounds.length} 条（尾部 5 条 · 新→旧）：`);
  for (const r of rounds.slice(-5).reverse()) {
    log(`     ${r.at ?? '?'} ${String(r.mode ?? '?').padEnd(7)} ${String(r.dir ?? '?').padEnd(9)} exit=${r.exit}`
      + `${r.reason ? `(${r.reason})` : ''}　推 ${r.pushed ?? 0} / 更 ${r.updated ?? 0} / 拉 ${r.pulled ?? 0} / 冲 ${r.conflicts ?? 0}`
      + `　dec ${fmtBytes(r.decisionBytes ?? 0)} · xfer ${fmtBytes(r.transferBytes ?? 0)}${r.idleRole === 'partial' ? '　[单方向·不计 streak]' : ''}`);
  }
  if (!rounds.length) log('     （无）');
  const idle = out.idle ?? { state: 'unknown', streak: 0 };
  log(`   idle：${idle.state}　streak ${idle.streak ?? 0}　since ${idle.since ?? '-'}　lastPushAt ${idle.lastPushAt ?? '-'}　lastExit ${idle.lastExit ?? '-'}`
    + `${idle.state === 'idle' && n0(idle.streak) >= IDLE_THRESHOLD ? `　⚠️ 超阈值（≥ ${IDLE_THRESHOLD} 轮）` : ''}`);
  log(`   状态文件：${paths.primary}（source=${loaded.source}${paths.mirrors.length ? ` · mirror ${paths.mirrors.join(' , ')}` : ''}）`);
  OUT.json = out;
  if (o.json) log(`---JSON---\n${JSON.stringify(out, null, 2)}`);
  return EXIT_OK;
}

// ---------------------------------------------------------------- 主流程
function newRunId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
}
function stamp12(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
function mb(n) { return `${(Number(n) / 1048576).toFixed(2)} MB`; }
/** 人读字节（`--status` 用）：小于 1 KB / 1 MB 时别一律打成 "0.00 MB"。 */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  return mb(v);
}
function sumBytes(list) { return list.reduce((a, x) => a + (Number(x.bytes ?? x.size) || 0), 0); }

async function main() {
  const t0 = Date.now();
  const o = parseArgs(process.argv.slice(2));
  LOG_TO_STDERR = o.json;
  // ⚠️ 参数级错误 / --help **不记状态账**（下面 `finalizeRun` 一处都不经过它们）——
  //    理由：它们不是"一轮同步"（没抢锁、没探通道、没判任何文件），记进 rounds 会把
  //    "有人手滑敲错参数"污染成"空转/让路"证据。判据 5③ 要的是**真让路轮**，不是敲错参数。
  if (o.unknown) { log(`❌ 未知参数：${o.unknown}`); log(''); log(USAGE); return EXIT_FAIL; }
  if (o.help) { log(USAGE); return EXIT_OK; }
  o.home = o.home || dshHome();

  // 只读查询 / 留档清理：不抢锁、不写状态、不探通道（可安全在生产上跑）
  if (o.status) return cmdStatus(o);
  if (o.pruneArchive) return cmdPruneArchive(o);

  if (!['to-peer', 'from-peer', 'both'].includes(o.dir)) { log(`❌ --dir 只能是 to-peer / from-peer / both（收到 ${o.dir}）`); return EXIT_FAIL; }

  // §10 P5 护栏：夹具模式打到生产 home / 生产 _archive ⇒ rc=2（参数级拒跑，不记账）
  const prodHits = guardProductionFixture(o);
  if (prodHits) {
    log('❌ 拒绝执行：`--transport local`（夹具模式）打到了生产路径（rc=2）—— 会写生产 home / 写或删生产清单');
    for (const h of prodHits) log(`   · ${h}`);
    log('   ⇒ 夹具必须把 6 个路径全指 `<数据区>/_tmp/<runTag>/` 下的临时目录；确要如此才加 --allow-production-fixture');
    return EXIT_REFUSE;
  }
  if (o.transport === 'local' && o.allowProductionFixture) log('⚠️ 已带 --allow-production-fixture：夹具模式打到生产路径，后果自负');

  const res = {
    schemaVersion: 1, version: VERSION, at: new Date().toISOString(), host: os.hostname(),
    mode: o.apply ? 'apply' : 'dry-run', dir: o.dir, peer: o.peer, transport: o.transport,
    exit: EXIT_OK, phases: [], manifests: [], warnings: [],
  };

  // 锁：**夹具模式也抢**（E-3）—— `home: o.home` 让锁目录跟着 `--home` 走（临时 home），
  // 否则 `acquireTickLock` 缺省用 dshHome() = 生产 `~\.dsh`，夹具会把锁落进生产、还能挡住 tickd 真轮。
  let lock = null;
  lock = acquireTickLock(o.lockName, { ttlMs: LOCK_TTL_MS, home: o.home });
  if (!lock?.ok) {
    const lockDir = lock?.lockPath ? path.dirname(lock.lockPath) : o.home;
    log(`⏸ 让路：锁「${o.lockName}」被占（holder pid=${lock?.holder?.pid ?? '?'}；锁目录 ${lockDir}）—— 物理常态，不是失败（退出码 3）`);
    res.exit = EXIT_YIELD; res.reason = 'lock-busy';
    return finalizeRun(res, o, { t0 });
  }

  let lease = null;
  try {
    const specs = specDefs(o).filter((s) => !o.only || String(o.only).split(',').map((x) => x.trim()).includes(s.key));
    if (!specs.length) {
      log(`❌ --only 没匹配到任何 spec（可用：docs, presets）`);
      res.exit = EXIT_FAIL; res.reason = 'only-unmatched';
      return finalizeRun(res, o, { t0 });
    }
    const rules = dualWriteRes(o);

    // ── 择路（共用件；lan → tunnel → 按需短租）
    const candidates = [
      { channel: 'lan', target: `${o.peer}-lan` },
      { channel: 'tunnel', target: o.peer },
    ];
    let channel = null;
    if (o.transport === 'local') {
      channel = { ok: true, channel: 'local', target: 'local（夹具模式）', hostname: os.hostname(), tried: [], rented: false, lease: null };
      log('ⓘ 夹具模式（--transport local）：不走 ssh，两边都是本机目录');
    } else {
      log(`◾ 择路：${candidates.map((c) => c.target).join(' → ')}（全不通再按需短租）`);
      channel = ensurePeerChannel({
        candidates, probe: (c) => probeSsh(c.target), owner: 'text-sync-direct',
        log: (m) => log(m),
      });
      lease = channel?.lease ?? null;
      if (!channel?.ok) {
        log(`⏸ 让路：通道全不通（${(channel?.tried ?? []).map((x) => `${x.channel}:${String(x.err ?? '').slice(0, 60)}`).join(' | ') || '未试'}）—— 物理常态，不是失败（退出码 3）`);
        res.exit = EXIT_YIELD; res.reason = 'channel-unreachable'; res.channel = { tried: channel?.tried ?? [], rent: channel?.rent ?? null };
        return finalizeRun(res, o, { t0 });
      }
      log(`  ✔ 通道 = ${channel.channel}（${channel.target} · ${channel.hostname ?? '?'}${channel.rented ? ' · 本轮按需短租' : ''}）`);
    }
    res.channel = { kind: channel.channel, target: channel.target, hostname: channel.hostname ?? null, rented: channel.rented === true, tried: channel.tried ?? [] };
    const t = makeTransport(o, channel);

    // ── 暂存目录（带 runId：并发跑不互删）
    const runId = newRunId();
    const stamp = stamp12();
    const ctx = {
      runId, stamp,
      localStage: path.join(o.staging, runId),
      peerStage: path.join(o.staging, runId),
      tag: 'main',
    };
    fs.mkdirSync(path.join(ctx.localStage, 'packs'), { recursive: true });
    if (t.kind === 'ssh') {
      t.mkdirp(path.join(ctx.peerStage, 'scripts'));
      t.mkdirp(path.join(ctx.peerStage, 'packs'));
      const putScripts = t.put(SCRIPT_FILES.map((f) => path.join(SCRIPT_DIR, f)), path.join(ctx.peerStage, 'scripts'));
      if (putScripts.code !== 0) {
        log(`❌ 失败：脚本推不到对端（scp rc=${putScripts.code}）：${String(putScripts.stderr || putScripts.error || '').slice(-300)}`);
        res.exit = EXIT_FAIL; res.reason = 'put-scripts-failed';
        res.errors = [{ stage: 'put-scripts', rc: putScripts.code }];
        return finalizeRun(res, o, { t0 });
      }
      log(`◾ 暂存：本机 ${ctx.localStage} ｜ 对端 ${ctx.peerStage}`);
    } else {
      ctx.peerStage = ctx.localStage;
      fs.mkdirSync(path.join(ctx.peerStage, 'scripts'), { recursive: true });
    }

    const directions = o.dir === 'both' ? ['to-peer', 'from-peer'] : [o.dir];
    for (const dir of directions) {
      const phase = await runPhase({ o, t, ctx, specs, rules, dir, stamp });
      res.phases.push(phase);
      if (phase.exit !== EXIT_OK) { res.exit = phase.exit; break; }
    }

    // ── 清单落盘（口径 7 第二层：写失败只记 warning + 审计，**不改 exit**）
    //    明写这个选择：清单缺失只意味着"这一轮不能回滚"，不是同步失败；`--status` 的 manifests:[] 会显示空。
    if (o.apply && res.phases.length) {
      try {
        const dirM = path.join(o.archiveRoot, runId);
        fs.mkdirSync(dirM, { recursive: true });
        const manifestPath = path.join(dirM, 'manifest.json');
        const manifest = {
          schemaVersion: 1, runId, at: res.at, host: res.host, peer: o.peer, peerHost: res.channel?.hostname ?? null,
          dir: o.dir, dryRun: false, phases: res.phases,
          note: 'created[] 里是本次新建的文件（回滚器只删它们）；conflictCopies[] 需 --include-conflicts 才回滚',
        };
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        res.manifests.push(manifestPath);
        log(`◾ 清单：${manifestPath}`);
      } catch (e) {
        const err = String(e?.message ?? e);
        res.warnings.push(`manifest-write-failed: ${err}`);
        stderrLine(`⚠️ 清单写失败（这一轮不能回滚，但同步本身没失败）：${err}`);
        try { appendAudit({ type: 'text-sync-direct', action: 'manifest-write-failed', err }, { home: o.home }); } catch { /* ignore */ }
      }
    }

    // ── 收尾：只删自己这次那份
    if (!o.keepStaging) {
      try { fs.rmSync(ctx.localStage, { recursive: true, force: true }); } catch { /* ignore */ }
      if (t.kind === 'ssh') { try { t.rmtree(ctx.peerStage); } catch { /* ignore */ } }
      log('◾ 暂存已清（只删本次 runId 那份）');
    } else {
      log(`◾ 暂存保留（--keep-staging）：${ctx.localStage}`);
    }
  } catch (e) {
    res.exit = EXIT_FAIL;
    res.reason = res.reason ?? 'fatal';
    res.errors = [...(res.errors ?? []), { stage: 'fatal', err: String(e?.stack ?? e).slice(0, 1200) }];
    log(`❌ 失败：${String(e?.message ?? e)}`);
  } finally {
    if (lease) {
      const rel = releasePeerChannel(lease, { log: (m) => log(m) });
      res.leaseRelease = { released: rel.released, skipped: rel.skipped ?? null, detail: rel.detail };
    }
    try { lock?.release?.(); } catch { /* ignore */ }
  }

  // 唯一收尾（E-2）：durationMs + 状态记账 + 摘要 + --json + exit code 全在这一处
  return finalizeRun(res, o, { t0 });
}

async function runPhase({ o, t, ctx, specs, rules, dir, stamp }) {
  const fromPeer = dir === 'from-peer';
  const phase = {
    dir, exit: EXIT_OK, at: new Date().toISOString(),
    specs: [], channel: t.kind, apply: o.apply,
  };
  log('');
  log(`── ${fromPeer ? '回程' : '去程'}（${fromPeer ? '对端 → 本机' : '本机 → 对端'}）${o.apply ? '' : ' · dry-run'} ─────`);

  // 阶段 A：本机清单
  const listings = new Map();
  for (const s of specs) {
    const l = scanLocal(s);
    s.localEntries = l.entries;
    listings.set(s.key, l);
    phase.specs.push({ key: s.key, localRoot: s.localRoot, peerRoot: s.peerRoot, local: { files: l.files, bytes: l.bytes, rawFiles: l.rawFiles } });
  }

  // 阶段 B：对端比对
  const selRun = runPeerScript(t, 'peer', 'select.mjs', buildSelectJob(specs, listings), { ...ctx, tag: `select-${dir}` });
  if (!selRun.ok) {
    log(`❌ 失败：对端挑选器没跑通（rc=${selRun.code ?? '?'}）：${selRun.err ?? selRun.stderr ?? ''}`);
    phase.exit = EXIT_FAIL; phase.error = { stage: 'select', err: selRun.err ?? selRun.stderr ?? null };
    return phase;
  }
  const sel = selRun.result;
  log(`   阶段 B：对端 ${sel.counts?.peerFiles ?? '?'} 份 / 本机 ${o.only ? [...listings.keys()].join('+') : 'docs+presets'} 清单 ${specs.reduce((a, s) => a + listings.get(s.key).files, 0)} 份`
    + `（对端缺 ${sel.counts?.new ?? 0} / 不像同一份 ${sel.counts?.differ ?? 0} / 对端多 ${sel.counts?.peerOnly ?? 0} / 快路径判同 ${sel.counts?.same ?? 0}）`);

  // 阶段 C：判定 + 打包 + 落位
  for (const s of specs) {
    const selSpec = (sel.specs ?? []).find((x) => x.key === s.key);
    const rec = phase.specs.find((x) => x.key === s.key);
    rec.peer = selSpec?.peer ?? null;
    if (!selSpec) { rec.error = '对端没返回这个 spec'; continue; }

    const decCtx = { host: os.hostname(), peerHost: sel.host ?? null, stamp };
    const dec = fromPeer ? decideFromPeer(s, selSpec, rules, decCtx) : decideToPeer(s, selSpec, rules, decCtx);

    rec.decision = {
      new: dec.new?.length ?? 0,
      newBytes: sumBytes(dec.new ?? []),
      update: dec.update?.length ?? 0,
      updateBytes: sumBytes(dec.update ?? []),
      conflict: dec.conflict?.length ?? 0,
      conflictBytes: sumBytes(dec.conflict ?? []),
      skip: dec.skip?.length ?? 0,
      skipBytes: sumBytes(dec.skip ?? []),
      skipReasons: countBy(dec.skip ?? [], 'reason'),
      pull: dec.pull?.length ?? 0,
      pullBytes: sumBytes(dec.pull ?? []),
    };
    log(`   ${s.key}：新增 ${rec.decision.new} 份 / ${mb(rec.decision.newBytes)}　更新 ${rec.decision.update} 份 / ${mb(rec.decision.updateBytes)}`
      + `　冲突 ${rec.decision.conflict} 份 / ${mb(rec.decision.conflictBytes)}　跳过 ${rec.decision.skip} 份${fromPeer ? `　拉取 ${rec.decision.pull} 份 / ${mb(rec.decision.pullBytes)}` : ''}`);
    if (rec.decision.skip) log(`      ⓘ 跳过原因：${Object.entries(rec.decision.skipReasons).map(([k, v]) => `${k}=${v}`).join(' / ')}`);
    rec.conflicts = (dec.conflict ?? []).map((c) => ({ relPath: c.relPath, reason: c.reason, bytes: c.bytes }));
    rec.skipDetail = (dec.skip ?? []).map((c) => ({ relPath: c.relPath, reason: c.reason })).slice(0, 200);

    // 无要传的 ⇒ 这一格收工（幂等时就是这条路径：零传输零写入）
    const work = fromPeer ? dec.pull : [...dec.new, ...dec.update];
    const conflictWork = dec.conflict;
    if (!work.length && !conflictWork.length) { rec.transfer = { packs: 0, files: 0, bytes: 0, note: '无变化' }; continue; }

    // dry-run：**到这里就停**（不打包、不 scp、不落位）——只把"将写清单"交出去
    if (!o.apply) {
      rec.transfer = { packs: 0, files: 0, bytes: 0, note: 'dry-run：零传输（未打包 / 未 scp / 未落位）' };
      const sample = (arr, n = 50) => (arr ?? []).slice(0, n).map((x) => x.relPath);
      rec.plan = {
        newSample: sample(dec.new), updateSample: sample(dec.update),
        pullSample: sample(dec.pull), conflictSample: sample(conflictWork),
        skipSample: sample(dec.skip, 20),
        willTransfer: work.length, willTransferBytes: sumBytes(work),
        willConflict: conflictWork.length, willConflictBytes: sumBytes(conflictWork),
      };
      log(`      ⓘ dry-run：将传 ${work.length} 份 / ${mb(sumBytes(work))}；冲突副本 ${conflictWork.length} 份` +
        '（零传输、零写入 —— dry-run 在打包之前就停）');
      if (rec.plan.newSample?.length) log(`      将新增样例：${rec.plan.newSample.slice(0, 5).join(' ｜ ')}`);
      if (rec.plan.updateSample?.length) log(`      将更新样例：${rec.plan.updateSample.slice(0, 5).join(' ｜ ')}`);
      if (rec.plan.conflictSample?.length) log(`      将落冲突副本：${rec.plan.conflictSample.slice(0, 5).join(' ｜ ')}`);
      continue;
    }

    let packs = [];
    if (fromPeer) {
      // 对端打包 → 拉回本机
      const want = [...work, ...conflictWork].map((w) => ({ specKey: s.key, root: s.peerRoot, relPath: w.relPath }));
      const packRun = runPeerScript(t, 'peer', 'pack.mjs', {
        mode: 'pack', apply: true, stamp, packsDir: path.join(ctx.peerStage, 'packs'),
        stagingRoot: ctx.peerStage, maxBatchBytes: o.maxBatchBytes, wanted: want,
      }, { ...ctx, tag: `pack-${s.key}` });
      if (!packRun.ok) {
        log(`❌ 失败：对端打包没成（rc=${packRun.code ?? '?'}）：${packRun.err ?? packRun.stderr ?? ''}`);
        rec.error = 'peer-pack'; phase.exit = EXIT_FAIL; continue;
      }
      const localPacksDir = path.join(ctx.localStage, 'packs');
      for (const p of packRun.result.packs ?? []) {
        const localFile = path.join(localPacksDir, path.basename(p.file));
        const g = t.get(p.file, localFile);
        if (g.code !== 0) { log(`❌ 失败：拉包 ${path.basename(p.file)} rc=${g.code}`); rec.error = 'get-pack'; phase.exit = EXIT_FAIL; continue; }
        packs.push({ ...p, localFile });
      }
    } else {
      const built = packLocally(o, s, [...work, ...conflictWork], stamp, path.join(ctx.localStage, 'packs'));
      const put = t.put(built.map((b) => b.file), path.join(ctx.peerStage, 'packs'));
      if (put.code !== 0) {
        log(`❌ 失败：批次包推不到对端（scp rc=${put.code}）：${String(put.stderr || put.error || '').slice(-300)}`);
        rec.error = 'put-packs'; phase.exit = EXIT_FAIL; continue;
      }
      packs = built.map((b) => ({ ...b, remoteFile: path.join(ctx.peerStage, 'packs', path.basename(b.file)) }));
    }

    rec.transfer = {
      packs: packs.length, files: packs.reduce((a, p) => a + (p.entries?.length ?? 0), 0),
      bytes: packs.reduce((a, p) => a + Number(p.bytes ?? 0), 0),
      packNames: packs.map((p) => path.basename(p.file)),
    };

    // 组织落位条目（**loadPack 用本机那份**；给落位器的 packPath 用目标侧那份）
    const targetSide = fromPeer ? 'local' : 'peer';
    const packPathFor = (p) => (targetSide === 'peer' ? (p.remoteFile ?? p.file) : (p.localFile ?? p.file));
    const items = packs.map((p) => ({
      specKey: s.key,
      root: fromPeer ? s.localRoot : s.peerRoot,
      packPath: packPathFor(p),
      entries: [],
    }));
    const entryMap = new Map();
    for (let i = 0; i < packs.length; i++) {
      for (const e of loadPack(packs[i].localFile ?? packs[i].file).header.entries) entryMap.set(e.relPath, items[i]);
    }
    const pushEntry = (relPath, entry) => {
      const it = entryMap.get(relPath);
      if (!it) return false;
      it.entries.push(entry);
      return true;
    };
    let lost = 0;
    for (const w of work) {
      if (!pushEntry(w.relPath, { relPath: w.relPath, action: w.action, expectOldSha: w.expectOldSha ?? null })) lost++;
    }
    for (const c of conflictWork) {
      if (!pushEntry(c.relPath, { relPath: c.relPath, action: 'conflictCopy' })) lost++;
    }
    if (lost) log(`   ⚠️ ${lost} 条没有对应的批次条目（包内缺失，已跳过）`);

    const allowRoots = fromPeer ? [s.localRoot] : [s.peerRoot];
    const placeJob = {
      mode: 'place', apply: o.apply, stamp, originHost: fromPeer ? (sel.host ?? o.peer) : os.hostname(),
      allowRoots, items: items.filter((i) => i.entries.length),
    };
    const placeRun = runPeerScript(t, targetSide, 'place.mjs', placeJob, { ...ctx, tag: `place-${s.key}` });
    if (!placeRun.ok) {
      log(`❌ 失败：落位器没跑通（rc=${placeRun.code ?? '?'}）：${placeRun.err ?? placeRun.stderr ?? ''}`);
      rec.error = 'place'; phase.exit = EXIT_FAIL; continue;
    }
    const pr = placeRun.result;
    rec.placed = pr.counts ?? null;
    rec.placedDetail = (pr.placed ?? []).filter((p) => !p.dryRun);
    rec.created = (pr.created ?? []).map((p) => ({ specKey: s.key, root: fromPeer ? s.localRoot : s.peerRoot, relPath: p.relPath, action: 'create', sha256: p.sha256, bytes: p.bytes }));
    rec.conflictCopies = (pr.conflicts ?? []).map((p) => ({ specKey: s.key, root: fromPeer ? s.localRoot : s.peerRoot, relPath: p.relPath, sha256: p.sha256, bytes: p.bytes }));
    rec.backups = pr.backups ?? [];
    rec.refused = (pr.refused ?? []).slice(0, 200);
    log(`   落位：新建 ${pr.counts?.created ?? 0}　更新 ${pr.counts?.updated ?? 0}　冲突副本 ${pr.counts?.conflictCopies ?? 0}`
      + `　备份 ${pr.counts?.backups ?? 0}　已同 ${pr.counts?.skipped ?? 0}　拒动 ${pr.counts?.refused ?? 0}`
      + `${o.apply ? '' : '（dry-run：只出计划）'}`);
    if (pr.counts?.refused) log(`      ⚠️ 拒动样例：${(pr.refused ?? []).slice(0, 3).map((r) => `${r.relPath}: ${String(r.reason).slice(0, 60)}`).join(' ｜ ')}`);
  }
  return phase;
}

function countBy(list, key) {
  const out = {};
  for (const x of list) out[x[key] ?? '-'] = (out[x[key] ?? '-'] ?? 0) + 1;
  return out;
}

function summary(res, o, stateInfo) {
  const lines = [];
  lines.push('════ 直连同步摘要 ════');
  lines.push(`  模式 ${res.mode}　方向 ${res.dir}　对端 ${res.peer}（${res.channel?.hostname ?? '?'}）　通道 ${res.channel?.kind ?? '?'}${res.channel?.rented ? '（本轮短租）' : ''}`);
  for (const p of res.phases ?? []) {
    lines.push(`  ── ${p.dir} ──`);
    for (const s of p.specs ?? []) {
      const d = s.decision;
      if (!d) { lines.push(`    ${s.key}: ${s.error ?? '未判定'}`); continue; }
      lines.push(`    ${s.key}：新增 ${d.new} / 更新 ${d.update} / 冲突 ${d.conflict} / 跳过 ${d.skip}`
        + `${p.dir === 'from-peer' ? ` / 拉取 ${d.pull}` : ''}　`
        + `字节 新 ${mb(d.newBytes)} · 更 ${mb(d.updateBytes)} · 冲 ${mb(d.conflictBytes)} · 跳 ${mb(d.skipBytes)}`
        + `${s.transfer ? `　传输 ${s.transfer.files} 份 / ${mb(s.transfer.bytes)}（${s.transfer.packs} 批）` : ''}`);
    }
  }
  lines.push(`  退出码 ${res.exit}（0 完成 / 3 让路 / 1 失败 / 2 拒绝执行）　耗时 ${((res.durationMs ?? 0) / 1000).toFixed(1)}s`);
  if (res.reason) lines.push(`  让路/失败原因：${res.reason}`);
  if (res.leaseRelease) lines.push(`  短租收尾：${res.leaseRelease.detail}`);
  if (res.manifests?.length) lines.push(`  清单：${res.manifests.join(' , ')}`);
  // ── 状态账本（B1/B3）：只在 --apply 有；dry-run 一个字节都不写
  if (stateInfo) {
    lines.push(`  状态：rounds ${stateInfo.rounds} 条　idle=${stateInfo.idle?.state ?? '?'} streak=${stateInfo.idle?.streak ?? 0}`
      + `${stateInfo.ok ? '' : '　⚠️ 状态写失败（已记审计，不影响本轮同步）'}`);
    if (stateInfo.healed?.length) lines.push(`  ⓘ 状态文件自愈（用好的那份重建）：${stateInfo.healed.join(' , ')}`);
    if (stateInfo.corrupt?.length) lines.push(`  ⚠️ 坏状态文件已留档：${stateInfo.corrupt.join(' , ')}`);
    // 空转 SLI（**不接告警**：只在本行点名）
    if (stateInfo.idle?.state === 'idle' && n0(stateInfo.idle.streak) >= IDLE_THRESHOLD) {
      const sinceMs = Date.parse(stateInfo.idle.since ?? '') || 0;
      const hours = sinceMs ? `（墙钟 ≈${((Date.now() - sinceMs) / 3_600_000).toFixed(1)}h）` : '';
      lines.push(`  ⚠️ 疑似空转：已连续 ${stateInfo.idle.streak} 轮${hours}零推送；`
        + `其中 ${stateInfo.yieldSince ?? 0} 轮让路、最近一次真推送 ${stateInfo.idle.lastPushAt ?? '（最近 48 轮内没有）'}`);
    }
  } else if (o.apply === false) {
    lines.push('  状态：dry-run 不记状态账（口径 5「只在 --apply 写」）');
  }
  lines.push('  🔴 本轮没有删除任何文件（本脚本不具备删目标文件的能力）');
  return lines.join('\n');
}

// ---- 入口守卫（junction/realpath 坑：argv[1] 是逻辑路径、import.meta.url 是物理路径）
const isMain = (() => {
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1] ?? ''));
    const b = fs.realpathSync(path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    return a === b;
  } catch { return false; }
})();

if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`❌ ${e?.stack ?? e}\n`);
    process.exitCode = EXIT_FAIL;
  });
}
