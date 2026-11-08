#!/usr/bin/env node
/**
 * dsh-butler / text-sync.mjs —— 跨机「文本文件」同步（docs / persona / 变更流水）
 *
 * 〔订正注 · 2026-10-28〕**本件只作历史读**：2026-10-28 拆仓库钩子后，tickd 的 `hot` / `text-sync` /
 *   `memory-snapshot` / `arrive-b` 四个 job **已全关**（`enabled:false`，why=拆仓库钩子 20261028），
 *   六个私有 Gitee 仓同日**全部删除**（本地工作副本降为**只读历史存档**，
 *   remote 已改名 `retired-20261028`）。**现行跨机文本通道 = `tools\dsh-butler\text-sync-direct.mjs`**
 *   （隧道 scp、不经仓、tickd 每小时一轮）。⇒ 本件描述的 git 采/回灌/推流程**不再有自动触发方**，
 *   下文照旧保留（当时判据链），但别按它去排障现网同步。
 *   真源：`docs\方案-拆仓库钩子-20261028.md`、`docs\交付报告-拆仓库钩子方案过审-20261028.md` §6.1 #9。
 *
 * ── 为什么有它（人话）────────────────────────────────────────────────────────
 * 两台机之间要交换的文本文件分两半：
 *   ① **推出去**（本机 → Gitee 仓 → 对端）：`hot`（30 分钟档）只采 **`HOT_SPECS` 清单里的东西**
 *      —— 仓1 的 `.agent-presets`/`skills`/坑库/审计、仓3 的 `docs\坑库` + `docs\管家报告`⑧。
 *      **数据区 `docs/` 的其余全部（交付报告 / 方案 / 交接档 / 变更流水 / 文档总索引…）根本不在清单里**
 *      ⇒ 自 2026-09-21 之后就没进过仓（实测：仓3 `docs` 目录 mtime 停在 09-21、`docs\变更流水\2026-10.md` 不在仓里）。
 *   ② **收回来**（仓 → 本机生产）：`hot` **只读搬运、绝不向生产分发**（那是 Arrive 的事，要人工 `handoff --arrive`）。
 *      ⇒ 对端采进仓的文本，**永远不会自动落回本机的 `docs/` / `agent-presets/`**。
 *
 * 本脚本把这两半补上，范围**只有文本文件**（`docs` + `.agent-presets`），不碰会话仓（仓2 只推不拉）、
 * 不碰 memory.db / 看板账本 / 凭据。
 *
 * ── 顺序（**顺序本身就是安全设计**，别改）────────────────────────────────────
 *   1. `fetch` → 若落后且工作树干净 ⇒ `merge --ff-only`（拿对端提交，记录本轮被对端改动的路径）
 *   2. **回灌**：只把「本轮 pull 带进来的路径」里、且和白名单匹配的文件，**仓 → 生产** 写回去
 *      （先回灌再采集，是 `dsh-backup-sync.ps1 -Sync` 的 pull-first 同款理由：采集是覆盖式，
 *        先采再拉会把对端刚进来的内容用本机旧内容顶掉，再推出去就是**吃掉对端改动**）
 *   3. **采集**：生产 → 工作副本（只增不删 /E 语义，**永不 purge**）
 *   4. **提交 + 推**：先过「推前安全门」（`lib/push-guard.mjs`，与 hot 同一份判据）与
 *      「超集体检」（`tools/lib/repo-superset.mjs`，与 `check-repo-superset.mjs` 同源），过了才 `git push`
 *
 * ── 幂等 ───────────────────────────────────────────────────────────────────
 *   无变化 ⇒ 不写生产、不提交、不推送、不产生空提交；文件复制按 `size+mtime` 快路径 + 内容兜底，
 *   且复制后回写源 mtime（保住 git 的 stat cache ⇒ 每轮秒级）。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 *   node text-sync.mjs [--apply] [--json] [--status]
 *        [--only docs,presets] [--channel auto|direct|proxy|off]
 *        [--skip-push] [--skip-backfill] [--no-peer-probe]
 *        [--repo-root <工作副本根>] [--home <生产 home>] [--dsh-root <数据区根>] [--archive-root <回滚点根>]
 *        [--rollback <回灌回滚目录>] [--rollback-apply]
 *        [--help]
 *
 *   ⚠️ **默认 dry-run**（生态规矩：动生产的脚本默认 dry-run，必须显式 `--apply`）。
 *   ⚠️ 所有"写哪里"都做成可注入参数（`--repo-root` / `--home` / `--dsh-root` / `--archive-root`），
 *      单测/演练一律用夹具根，**绝不写生产输出位置**（persona 铁律）。
 *
 * 退出码：0 = 完成（含"无变化"）｜3 = 让路/跳过（锁被占 / 工作树脏 / 分叉 / 通道不通 / 被挡推）｜1 = 失败
 *   （3 = 让路是物理常态，tickd 侧登记 benignExitCodes:[3]，与 hot / session-mirror 同口径）
 *
 * 锁：与 `hot` / `handoff` / `memory-snapshot` **共用 `handoff`**
 *   （同一个仓3/仓1 工作副本 ⇒ 不能两个进程同时动 git index）。tickd 侧 lockName 也登记 `handoff`。
 *   〔订正注 · 2026-10-28〕锁名 `handoff` 的**登记仍成立**（`lib\butler-locks.mjs` 的登记不变量不变，
 *   别去摘），但「共用」的**现役方已变**：`hot` / `memory-snapshot` / `arrive-b` 与**本件自己的 job**
 *   同日全关 ⇒ 现在只剩人工调用与 `handoff` 相关手工流程在用这个名字，不再有常驻 job 抢它。
 *
 * 🔴 红线（本脚本自己守的）：
 *   · 仓2（sessions）**只推不拉**：本脚本**根本不碰**仓2 ✅
 *   · **禁 `--prune`** / 禁 `/MIR`：采集只增不删 ✅
 *   · **禁 `--force-collect`**：不提供该逃生舱；挡推即停 ✅
 *   · 不改对端任何东西：本脚本**只与 Gitee 远端说话**，不 ssh 写对端（对端探测只读）✅
 *   · 不碰 `docs\管家报告` / `docs\坑库`：前者机器自产、后者走语义合并，**都不做文件级回灌** ✅
 *
 * 方案/口径真源：`docs\多机线-方案与进度统筹-20261010.md`、技能 `dsh-sync`、
 *             `docs\交付报告-多端线-文本同步自动化-20261011.md`
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { dshHome } from './lib/paths.mjs';
import { dshRoot, repoRoot } from '../lib/host-config.mjs';
import { resolveStatePath } from './lib/state-paths.mjs';
import { readJson, writeJsonAtomic, writeTextAtomic, acquireTickLock } from './lib/store.mjs';
import { writeStateText } from './lib/dual-write.mjs';
import { appendAudit } from './lib/audit.mjs';
import { alert } from './lib/alert.mjs';
import { judgeSyncSafety } from './lib/push-guard.mjs';
import { checkRepo, conclusion } from '../lib/repo-superset.mjs';
import { gateDestructive, renderDestructive, DESTRUCTIVE_EXIT } from '../lib/production-guard.mjs';
// ── R-065 三件套（删除/搬移闸）：dry-run 第一道门（函数内）+ 白名单 + reparse 拒删 + 作用域点明 ──
function gateOrRefuse(targets, whitelist, { op = '删', reason = '', allowProduction = false } = {}) {
  const g = gateDestructive({ targets, whitelist, op, scope: ['file'], requires: ['file'], dryRun: false, allowProduction, reason });
  if (!g.ok) { process.stderr.write(renderDestructive(g) + '\n'); process.exitCode = DESTRUCTIVE_EXIT.REFUSE; return false; }
  return true;
}
function rmGuarded(target, whitelist, reason, dryRun = false) {
  if (dryRun) return true;                                  // ← 第一道门：dry-run 零动作
  if (!gateOrRefuse([target], whitelist, { op: '删', reason })) return false;
  fs.rmSync(target, { force: true });
  return true;
}
function mvGuarded(from, to, whitelist, reason, dryRun = false) {
  if (dryRun) return true;                                  // ← 第一道门：dry-run 零动作
  if (!gateOrRefuse([from, to], whitelist, { op: '搬移', reason })) return false;
  fs.renameSync(from, to);
  return true;
}


export const TEXT_SYNC_VERSION = '0.1.0';

/** 状态名 → 统一状态入口（覆盖窗口要它贴在上面；函数提升供 statePath() 用）。 */
function stateFileOf(name, home) { return resolveStatePath(name, { home }).path; }

const STATE_NAME = 'butler-text-sync.json';
const BRANCH = 'master';
const DEFAULT_REPO_ROOT = process.env.BUTLER_REPO_ROOT || repoRoot();
const DEFAULT_DSH_ROOT = process.env.BUTLER_DSH_ROOT || dshRoot();
/** 对端可达性探测器（可选件；缺省 = 探测不可用，只影响报告里的那行提示）。 */
const PEER_PROBE = process.env.BUTLER_PEER_PROBE || path.join(DEFAULT_DSH_ROOT, 'tools', 'multi-host-status.mjs');
/** 对端清单（`BUTLER_PEERS`，逗号分隔；未配置 ⇒ 空表 = 不探测）。 */
const PEER_LIST = String(process.env.BUTLER_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const LOCK_TTL_MS = 20 * 60 * 1000;

/** 文本扩展名白名单（**只要文本**；二进制/图片/压缩包一律不采不回灌）。 */
export const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yml', '.yaml',
  '.mjs', '.cjs', '.js', '.ps1', '.cmd', '.bat', '.ini', '.toml',
]);

/** 一律跳过的目录名（与 hot / 既有采集同口径）。 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '_archive', '_tmp', 'generated', 'logs', 'snapshots', 'backups', 'chrome-profile', 'card-sessions',
]);

/**
 * 同步对象清单（**本清单 = 口径的单一数据源**）。
 *   `collect` = 生产 → 工作副本（可跳过某些子目录）
 *   `backfill` = 工作副本 → 生产（同样可跳过；**只会写"本轮 pull 带进来的路径"**）
 */
export const SPECS = [
  {
    key: 'docs',
    label: '数据区 docs 文本（交付报告/方案/交接档/变更流水/文档总索引…）',
    repo: 'dsh-workspace',
    repoDir: 'docs',
    prodDir: (o) => path.join(o.dshRoot, 'docs'),
    exts: TEXT_EXTS,
    // 管家报告：机器自产、每轮重生成、无 host 后缀者两机同名会互相顶 ⇒ 不采不回灌（hot 已按近 7 天采它）
    // 坑库：**走 sigKey 语义合并**（P9 §4.3），文件级回灌会把对端数据覆盖回去 ⇒ 不采不回灌（hot 已采）
    collectSkipDirs: new Set(['管家报告', '坑库']),
    backfillSkipDirs: new Set(['管家报告', '坑库']),
  },
  {
    key: 'presets',
    label: '~/.dsh/.agent-presets（persona 与预设）',
    repo: 'dsh-core',
    repoDir: path.join('dsh', '.agent-presets'),
    prodDir: (o) => path.join(o.home, '.agent-presets'),
    exts: new Set([...TEXT_EXTS, '']),   // NOTICE 之类无扩展名小文件
    collectSkipDirs: new Set(),
    backfillSkipDirs: new Set(),
    persona: true,
  },
];

const OUT = { lines: [], json: null };
function log(msg = '') { OUT.lines.push(msg); process.stdout.write(msg + '\n'); }
function section(t) { log(''); log(`── ${t} ─────────────────────────────────`); }

const USAGE = [
  'dsh-butler / text-sync —— 跨机文本同步（docs / persona / 变更流水；默认 dry-run）',
  '',
  '  node text-sync.mjs [--apply] [--json] [--status]',
  '       [--only docs,presets] [--channel auto|direct|proxy|off]',
  '       [--skip-push] [--skip-backfill] [--no-peer-probe] [--allow-divergence]',
  '       [--repo-root <路径>] [--home <路径>] [--dsh-root <路径>] [--archive-root <路径>]',
  '       [--rollback <回灌回滚目录>] [--rollback-apply] [--lock-name <名>]',
  '',
  '  --apply            真执行（采集/提交/推送/回灌）。缺省 = dry-run，零写入。',
  '  --only <k,k>       只处理指定 key（docs / presets）。',
  '  --channel <c>      auto（默认｜直连→代理→跳过）/ direct / proxy / off（不联网，只本地采集+回灌判定）。',
  '  --skip-push        采集+提交但不 push（演练用）。',
  '  --skip-backfill    只做"推出去"那一半。',
  '  --no-peer-probe    跳过对端可达探测（省 10~30s）。',
  '  --allow-divergence 推前安全门显式放行（危险，写审计；**没有 --force-collect 那种逃生舱**）。',
  '  --superset-force   强制本轮跑完整超集体检（缺省按节流：本轮有 pull 或距上次 ≥ --superset-interval-min 才跑）。',
  '  --superset-interval-min <n>  超集体检节流阈值（默认 360 分钟；设 0 = 每轮都检，慢）。',
  '  --rollback <dir>   从某个 text-sync-backfill-* 备份目录回滚（默认 dry-run，加 --rollback-apply 才写）。',
  '  --lock-name <n>    抢哪把 tick 锁（默认 handoff，与 hot 共用）。',
  '',
  '  顺序：fetch/pull → 回灌（仓→生产）→ 采集（生产→仓）→ 提交 → 过门 → push。',
  '  无变化 ⇒ 零写入零提交零推送。仓2（sessions）本脚本根本不碰。',
  '  ⏱ 超集体检（`repo-superset`）是逐文件起 git 子进程的实现：仓3 采完 docs 后实测 **176.6s/轮**',
  '     ⇒ 默认节流为"本轮有 pull 或距上次 ≥6h 才跑完整检"，其余轮次靠**每轮都跑**的推前安全门兜底。',
].join('\n');

// ---------------------------------------------------------------- 小工具

function parseArgs(argv) {
  const o = {
    apply: false, json: false, status: false, only: null, channel: 'auto',
    skipPush: false, skipBackfill: false, peerProbe: true, allowDivergence: false,
    repoRoot: null, home: null, dshRoot: null, archiveRoot: null,
    rollback: null, rollbackApply: false, lockName: 'handoff', help: false, unknown: null,
    supersetIntervalMin: 360, supersetForce: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a === '--status') o.status = true;
    else if (a === '--skip-push') o.skipPush = true;
    else if (a === '--skip-backfill') o.skipBackfill = true;
    else if (a === '--no-peer-probe') o.peerProbe = false;
    else if (a === '--allow-divergence') o.allowDivergence = true;
    else if (a === '--rollback-apply') o.rollbackApply = true;
    else if (a === '--only') o.only = String(argv[++i] ?? '');
    else if (a === '--channel') o.channel = String(argv[++i] ?? '');
    else if (a === '--repo-root') o.repoRoot = argv[++i];
    else if (a === '--home') o.home = argv[++i];
    else if (a === '--dsh-root') o.dshRoot = argv[++i];
    else if (a === '--archive-root') o.archiveRoot = argv[++i];
    else if (a === '--rollback') o.rollback = argv[++i];
    else if (a === '--lock-name') o.lockName = String(argv[++i] ?? 'handoff');
    else if (a === '--superset-interval-min') o.supersetIntervalMin = Number(argv[++i]);
    else if (a === '--superset-force') o.supersetForce = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o.unknown = a;
  }
  return o;
}

function resolveRoots(o) {
  return {
    repoRoot: o.repoRoot ?? process.env.TEXT_SYNC_REPO_ROOT ?? DEFAULT_REPO_ROOT,
    home: o.home ?? process.env.TEXT_SYNC_HOME ?? dshHome(),
    dshRoot: o.dshRoot ?? process.env.TEXT_SYNC_DSH_ROOT ?? DEFAULT_DSH_ROOT,
    archiveRoot: o.archiveRoot ?? process.env.TEXT_SYNC_ARCHIVE_ROOT ?? path.join(o.dshRoot ?? process.env.TEXT_SYNC_DSH_ROOT ?? DEFAULT_DSH_ROOT, '_archive'),
  };
}

function hostTag() {
  return String(process.env.COMPUTERNAME ?? os.hostname() ?? 'unknown').toUpperCase();
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function git(dir, args, { timeout = 120_000, env = null } = {}) {
  // ⚠️ `-c core.quotepath=false` 必须带：git 默认会把非 ASCII 路径输出成 `"docs/\344\272\244..."`
  //    （八进制转义 + 引号）⇒ `--name-only` 的结果无法与库内相对路径直接比对
  //    （2026-10-11 夹具演练实测：回灌因此跳过全部中文名文档，只回灌了 ASCII 名的）
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '-C', dir, ...args], {
    encoding: 'utf8', timeout, windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  return { ok: r.status === 0, code: r.status, out, err, text: (out || err) };
}

function isGitRepo(dir) { try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; } }

function safeRel(rel) {
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]+/);
  return !parts.some((p) => p === '..' || p === '');
}

function relNormalize(rel) { return rel.split(/[\\/]+/).join(path.sep); }

/** 目录树遍历（返回相对路径数组；跳过 SKIP_DIRS 与额外跳过目录名）。 */
function walk(root, { skipDirNames = new Set(), extraSkip = new Set() } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (e.isSymbolicLink()) continue;
        if (SKIP_DIRS.has(e.name) || skipDirNames.has(e.name) || extraSkip.has(e.name)) continue;
        stack.push(r);
      } else if (e.isFile()) {
        if (e.isSymbolicLink()) continue;
        out.push(r);
      }
    }
  }
  return out;
}

function extOf(rel) { return path.extname(rel).toLowerCase(); }

/** 快路径（size+mtime）→ 内容兜底。返回 {same:boolean, mode:'fast'|'content'}。 */
function filesSame(a, b) {
  let sa, sb;
  try { sa = fs.statSync(a); sb = fs.statSync(b); } catch { return { same: false, mode: 'content' }; }
  if (sa.size !== sb.size) return { same: false, mode: 'fast' };
  if (Math.abs(sa.mtimeMs - sb.mtimeMs) < 1) return { same: true, mode: 'fast' };
  try {
    return { same: fs.readFileSync(a).equals(fs.readFileSync(b)), mode: 'content' };
  } catch { return { same: false, mode: 'content' }; }
}

function copyPreserve(srcFile, dstFile) {
  fs.mkdirSync(path.dirname(dstFile), { recursive: true });
  fs.copyFileSync(srcFile, dstFile);
  try { const st = fs.statSync(srcFile); fs.utimesSync(dstFile, st.atime, st.mtime); } catch { /* 非致命 */ }
}

// ---------------------------------------------------------------- 通道择路

/**
 * 通道择路（**只作用于"能不能够到 Gitee 远端仓"**）。
 *   数据面是 Gitee 三仓（git 行级合并），所以"家网 / 公司网 / 仓信箱"在这里的落地形态 =
 *   「直连能不能通 / 要不要走本机代理」；对端机器可达性另由 `probePeers()` 只读探测、只做报告。
 *   auto：direct → proxy → off(跳过本轮)
 */
function resolveChannel(o, probeDir) {
  const want = String(o.channel || 'auto').toLowerCase();
  const tryDirect = () => {
    if (!probeDir || !isGitRepo(probeDir)) return { ok: false, why: '无本地仓可探' };
    const r = git(probeDir, ['ls-remote', '--exit-code', 'origin', 'HEAD'], {
      timeout: 25_000, env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
    });
    return r.ok ? { ok: true, why: `${(r.out || '').slice(0, 12)}…` } : { ok: false, why: (r.err || r.out || `rc=${r.code}`).slice(0, 160) };
  };
  const tryProxy = () => {
    if (!probeDir || !isGitRepo(probeDir)) return { ok: false, why: '无本地仓可探' };
    const r = git(probeDir, ['-c', 'http.proxy=http://127.0.0.1:7897', 'ls-remote', '--exit-code', 'origin', 'HEAD'], {
      timeout: 30_000, env: { GIT_TERMINAL_PROMPT: '0' },
    });
    return r.ok ? { ok: true, why: 'via 127.0.0.1:7897' } : { ok: false, why: (r.err || r.out || `rc=${r.code}`).slice(0, 160) };
  };

  if (want === 'off') return { kind: 'off', detail: '显式 off（只本地采集/回灌判定，不联网）', attempts: [] };
  if (want === 'direct') {
    const d = tryDirect();
    return { kind: d.ok ? 'direct' : 'none', detail: d.ok ? '显式 direct 直连成功' : `显式 direct 失败：${d.why}`, attempts: [{ ch: 'direct', ok: d.ok }] };
  }
  if (want === 'proxy') {
    const p = tryProxy();
    return { kind: p.ok ? 'proxy' : 'none', detail: p.ok ? '显式 proxy 成功' : `显式 proxy 失败：${p.why}`, attempts: [{ ch: 'proxy', ok: p.ok }] };
  }
  // auto
  const attempts = [];
  const d = tryDirect(); attempts.push({ ch: 'direct', ok: d.ok });
  if (d.ok) return { kind: 'direct', detail: '直连成功（家网/公网直连）', attempts };
  const p = tryProxy(); attempts.push({ ch: 'proxy', ok: p.ok });
  if (p.ok) return { kind: 'proxy', detail: `直连失败(${d.why}) → 代理成功`, attempts };
  return { kind: 'none', detail: `直连与代理都不通：direct=${d.why} / proxy=${p.why}`, attempts };
}

/** 对端可达性（只读；复用 multi-host-status，lan / 隧道两级别）——只做报告，不做数据传输。 */
function probePeers() {
  if (!PEER_LIST.length) return { ok: false, reason: 'no-peer-configured', peers: {} };
  if (!fs.existsSync(PEER_PROBE)) return { ok: false, reason: 'probe-missing', peers: {} };
  const r = spawnSync(process.execPath, [PEER_PROBE, '--json'], { encoding: 'utf8', timeout: 150_000, windowsHide: true });
  if (r.status !== 0 && !r.stdout) return { ok: false, reason: `rc=${r.status}`, peers: {} };
  let j = null;
  try { j = JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf('{'))); } catch { return { ok: false, reason: 'bad-json', peers: {} }; }
  const peers = {};
  for (const h of PEER_LIST) {
    const x = j?.[h];
    peers[h] = x ? { reachable: !!x.reachable, channel: x.channel ?? null, alias: x.alias ?? null } : { reachable: false, channel: null, alias: null };
  }
  return { ok: true, peers };
}

function peerLine(probe) {
  if (!probe?.ok) return `对端探测不可用（${probe?.reason ?? '—'}）`;
  const f = (h) => {
    const p = probe.peers?.[h];
    if (!p) return `${h}=?`;
    if (!p.reachable) return `${h}=✗`;
    return `${h}=✅${p.channel === 'lan' ? '局域网直连' : '隧道'}`;
  };
  return `对端 ${PEER_LIST.map(f).join(' / ')}`;
}

// ---------------------------------------------------------------- 回灌（仓 → 生产）

function makeRestoreScript(dir) {
  const tpl = `#!/usr/bin/env node
// 自动生成：把 text-sync 回灌写进生产的文件回滚回去。默认 dry-run，--apply 才写。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes('--apply');
const man = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
let restored = 0, deleted = 0, skip = 0, missing = 0;
for (const e of man.entries) {
  try {
    if (e.targetExistsBefore === false) {
      // 回灌时是**新建**的文件 ⇒ 回滚 = 删掉它
      if (!fs.existsSync(e.target)) { skip++; continue; }
      if (apply) fs.rmSync(e.target, { force: true });
      deleted++;
    } else {
      const bak = path.join(HERE, 'before', e.key, e.rel);
      if (!fs.existsSync(bak)) { missing++; continue; }
      if (apply) { fs.mkdirSync(path.dirname(e.target), { recursive: true }); fs.copyFileSync(bak, e.target); }
      restored++;
    }
  } catch (err) { console.error('回滚失败 ' + e.rel + '：' + err.message); process.exitCode = 1; }
}
console.log((apply ? '[apply] ' : '[dry-run] ') + restored + ' 个还原 / ' + deleted + ' 个删除 / ' + skip + ' 个跳过 / ' + missing + ' 个缺备份');
if (!apply) console.log('加 --apply 才真写。');
`;
  fs.writeFileSync(path.join(dir, 'restore.mjs'), tpl, 'utf8');
}

/**
 * 回灌：仓 → 生产。**只处理 `pulledPaths` 里的路径**（= 本轮 pull 从远端带进来的），
 * 这样不会把"本机删了但仓里还在"的文件复活。
 */
function backfill(o, ctx, root, spec, pulledPaths, res, R) {
  const repoDir = path.join(root, spec.repoDir);
  const prodDir = spec.prodDir(o);
  const prefix = spec.repoDir.split(/[\\/]+/).join('/') + '/';
  // ⚠️ 目录名必须**带 key**：一轮里两个 spec 都会回灌，同用一个 `<stamp>` 目录会让后写的
  //    manifest.json / restore.mjs 覆盖前一个（2026-10-11 夹具演练实测踩到 ⇒ 回滚会丢条目）
  const archive = path.join(ctx.archiveRoot, `text-sync-backfill-${ctx.stamp}-${spec.key}`);
  const entries = [];

  for (const p of pulledPaths) {
    const pp = p.split(/[\\/]+/).join('/');
    if (!pp.startsWith(prefix)) continue;
    const rel = pp.slice(prefix.length);
    if (!rel) continue;
    if (!safeRel(rel)) { res.backfillSkipped.push({ rel, reason: 'unsafe-path' }); continue; }
    const parts = rel.split('/');
    if (parts.some((d) => spec.backfillSkipDirs.has(d))) { res.backfillSkipped.push({ rel, reason: 'skip-dir' }); continue; }
    const ext = extOf(rel);
    if (!spec.exts.has(ext)) { res.backfillSkipped.push({ rel, reason: `non-text:${ext || '(no-ext)'}` }); continue; }
    const srcFile = path.join(repoDir, relNormalize(rel));
    const dstFile = path.join(prodDir, relNormalize(rel));
    if (!fs.existsSync(srcFile)) { res.backfillSkipped.push({ rel, reason: 'peer-deleted→跳过（不自动删生产）' }); continue; }
    // 路径越界保护
    if (!path.resolve(dstFile).startsWith(path.resolve(prodDir) + path.sep)) { res.backfillSkipped.push({ rel, reason: 'escape' }); continue; }

    if (fs.existsSync(dstFile) && filesSame(srcFile, dstFile).same) { res.backfillSkipped.push({ rel, reason: 'already-identical' }); continue; }

    if (!o.apply) { res.backfilled.push(rel); R.backfilled.push(rel); res.backfillPlan.push({ rel, target: dstFile }); continue; }

    let targetExistsBefore = false;
    try { targetExistsBefore = fs.existsSync(dstFile); } catch { /* ignore */ }
    if (targetExistsBefore) {
      const bak = path.join(archive, 'before', spec.key, relNormalize(rel));
      copyPreserve(dstFile, bak);
    }
    copyPreserve(srcFile, dstFile);
    entries.push({ key: spec.key, rel: relNormalize(rel), target: dstFile, targetExistsBefore });
    res.backfilled.push(rel);
    R.backfilled.push(rel);
  }

  if (o.apply && entries.length) {
    fs.mkdirSync(archive, { recursive: true });
    const man = {
      schemaVersion: 1, tool: 'text-sync.mjs', version: TEXT_SYNC_VERSION, key: spec.key,
      at: new Date().toISOString(), host: hostTag(), apply: true,
      entries,
      note: '回滚 = node restore.mjs --apply（在同目录）；回滚顺序无关（逐文件独立）。',
    };
    writeJsonAtomic(path.join(archive, 'manifest.json'), man);
    makeRestoreScript(archive);
    res.backfillArchive.push(archive);
    R.backfillArchive.push(archive);
  }
  return res;
}

// ---------------------------------------------------------------- 单仓一轮

function processRepo(o, ctx, spec, res) {
  const dir = path.join(ctx.repoRoot, spec.repo);
  const R = {
    repo: spec.repo, key: spec.key, dir,
    headBefore: null, headAfterPull: null, headAfterCommit: null,
    pulled: 0, pulledPaths: [], pulledClean: null,
    collected: 0, collectUnchanged: 0, skippedExt: 0, skippedDir: 0,
    backfilled: [], backfillPlan: [], backfillArchive: [],
    committed: false, commitSha: null, pushed: false, gate: null, notes: [],
  };
  if (!isGitRepo(dir)) { R.notes.push('工作副本不存在或不是 git 仓'); res.repos.push(R); return R; }
  const T = R.timings = { fetchMs: 0, pullMs: 0, backfillMs: 0, collectMs: 0, commitMs: 0, supersetMs: 0, gateMs: 0, pushMs: 0 };
  const tic = (k, fn) => { const s = Date.now(); const v = fn(); T[k] += Date.now() - s; return v; };
  tic('fetchMs', () => { git(dir, ['fetch', '--quiet', 'origin'], { timeout: 120_000 }); });
  R.headBefore = git(dir, ['rev-parse', 'HEAD']).out || null;
  // 本机"已确认消费的远端同步点" = fetch 后的 origin/master。
  // 为什么是它：下一步会 ff-only 拉平 + **回灌**（把对端内容落进生产）⇒ 远端内容确实已被本机消化；
  // 而"没拉平"（工作树脏 / 分叉）的情形由门的第一条判据（HEAD..origin > 0）先拦，不会走到这里 ⇒ 不撒谎。
  R.originSha = git(dir, ['rev-parse', `origin/${BRANCH}`]).out || null;

  // ---- 1) pull-first（ff-only）----
  const behind = Number(git(dir, ['rev-list', '--count', `HEAD..origin/${BRANCH}`]).out || '0');
  const dirty = (git(dir, ['status', '--porcelain', '--untracked-files=no']).out || '').length > 0;
  if (behind > 0) {
    if (dirty) {
      R.pulledClean = false; R.notes.push(`落后 ${behind} 个提交但工作树脏 ⇒ 本轮不 pull（fail-closed，不动 git index）`);
    } else if (o.apply) {
      const m = tic('pullMs', () => git(dir, ['merge', '--ff-only', `origin/${BRANCH}`], { timeout: 120_000 }));
      R.pulledClean = m.ok;
      if (!m.ok) R.notes.push(`merge --ff-only 失败（分叉？）：${(m.err || m.out).slice(0, 160)}`);
      else {
        R.headAfterPull = git(dir, ['rev-parse', 'HEAD']).out || null;
        const d = git(dir, ['diff', '--name-only', `${R.headBefore}`, `${R.headAfterPull}`]).out || '';
        R.pulledPaths = d.split('\n').map((s) => s.trim()).filter(Boolean);
        R.pulled = R.pulledPaths.length;
      }
    } else {
      const d = git(dir, ['diff', '--name-only', `HEAD..origin/${BRANCH}`]).out || '';
      R.pulledPaths = d.split('\n').map((s) => s.trim()).filter(Boolean);
      R.pulled = R.pulledPaths.length;
      R.pulledClean = null;
      R.notes.push(`dry-run：远端领先 ${behind} 个提交、涉及 ${R.pulled} 个文件（真跑会先 ff-only 拉平）`);
    }
  } else {
    R.pulledClean = true;
  }

  // 分叉（本地有未推提交 + 远端也领先）⇒ 本轮不做回灌（避免用分叉态覆盖生产）
  const aheadNow = Number(git(dir, ['rev-list', '--count', `origin/${BRANCH}..HEAD`]).out || '0');
  const diverged = behind > 0 && aheadNow > 0 && R.pulledClean !== true;
  if (diverged) R.notes.push(`⚠️ 分叉态（本地领先 ${aheadNow} / 远端领先 ${behind}）⇒ 本轮不做回灌、不推，等人工裁决`);

  // ---- 2) 回灌（仓 → 生产）----
  if (!o.skipBackfill && !diverged && R.pulledPaths.length) {
    tic('backfillMs', () => backfill(o, ctx, dir, spec, R.pulledPaths, res, R));
  }

  // ---- 3) 采集（生产 → 仓）----
  const repoDir = path.join(dir, spec.repoDir);
  const prodDir = spec.prodDir(o);
  if (fs.existsSync(prodDir)) {
    tic('collectMs', () => {
      const rels = walk(prodDir, { skipDirNames: spec.collectSkipDirs });
      for (const rel of rels) {
        const parts = rel.split(path.sep);
        if (parts.some((d) => spec.collectSkipDirs.has(d))) { R.skippedDir++; continue; }
        const ext = extOf(rel);
        if (!spec.exts.has(ext)) { R.skippedExt++; continue; }
        const src = path.join(prodDir, rel);
        const dst = path.join(repoDir, rel);
        const cmp = fs.existsSync(dst) ? filesSame(src, dst) : { same: false, mode: 'fast' };
        if (cmp.same) { R.collectUnchanged++; continue; }
        R.collected++;
        if (o.apply) copyPreserve(src, dst);
      }
    });
  } else {
    R.notes.push(`生产目录不存在：${prodDir}`);
  }

  // ---- 4) 提交 + 推 ----
  if (o.apply) {
    const st = git(dir, ['status', '--porcelain', '--', spec.repoDir]).out || '';
    if (st.length > 0) {
      tic('commitMs', () => {
        git(dir, ['add', '--', spec.repoDir]);
        const msg = `${stamp()} ${hostTag()} text-sync (auto)`;
        const c = git(dir, ['commit', '-m', msg, '--', spec.repoDir], { timeout: 120_000 });
        if (!c.ok) R.notes.push(`commit 失败：${(c.err || c.out).slice(0, 200)}`);
        else { R.committed = true; R.commitSha = git(dir, ['rev-parse', '--short', 'HEAD']).out || null; }
      });
    }
    R.headAfterCommit = git(dir, ['rev-parse', 'HEAD']).out || null;

    const toPush = Number(git(dir, ['rev-list', '--count', `origin/${BRANCH}..HEAD`]).out || '0');
    if (o.skipPush) {
      R.notes.push(`--skip-push：本地领先 ${toPush}，未推`);
    } else if (toPush > 0) {
      const prodRoot = spec.repo === 'dsh-workspace' ? o.dshRoot : o.home;

      // 4a-0) **超集体检**（🔴 红线：`-Push` 前必比对超集）—— 判据真源 = `tools/lib/repo-superset.mjs`
      //   的 `conclusion(..., {gate:'blocking'})`，与 `check-repo-superset.mjs --blocking-only`
      //   和 `dsh-backup-*.ps1 -Push` **同一套**（不另造）。挡 = 工作副本里存在"生产没有、且 git 也找不回"
      //   的真内容独有行 ⇒ 采集是覆盖式，推上去会**永久丢内容**。
      let supersetOk = true;
      // **超集体检节流**（2026-10-11 实测加装）：`checkRepo` 是**逐文件起 git 子进程**的实现，
      //   仓3 采完 docs 后 3788 个 tracked 文件 ⇒ **单轮 176.6s**（占整轮 203s 的 87%）。而本 job
      //   每轮的采集方向都是「生产 → 仓」（不会自造"仓里有、生产没有"的内容），真正的新风险面
      //   只有一个：**对端推了新东西**（那才会出现仓侧独有）⇒ 判据 = 「本轮有 pull ⇒ 必检」+
      //   「距上次完整检 ≥ intervalMs ⇒ 必检」；其余轮次只走**每轮都跑的**推前安全门（push-guard，
      //   秒级，含 remote-ahead / foreign-commits 两判据）。逃生舱 = `--superset-force` / interval 设 0。
      const lastSuper = ctx.state?.lastSupersetAt ? Date.parse(ctx.state.lastSupersetAt) : 0;
      const superAgeMin = lastSuper ? (Date.now() - lastSuper) / 60000 : Infinity;
      const supersetDue = o.supersetForce || R.pulled > 0 || !(superAgeMin < o.supersetIntervalMin);
      if (!supersetDue) {
        // ⚠️ 节流是**正常态**，不许写进 `notes`（notes 非空 ⇒ result=partial ⇒ 每轮弹一条告警）——
        //   2026-10-11 实测踩到：接上节流后第一轮就回了 partial + butler-alert 一条 warn。
        R.superset = {
          skipped: true,
          reason: `节流：距上次完整超集体检 ${Number.isFinite(superAgeMin) ? superAgeMin.toFixed(0) + ' 分钟' : '（无记录）'} < 阈值 ${o.supersetIntervalMin} 分钟，且本轮无 pull ⇒ 本轮只跑推前安全门`,
          lastAt: ctx.state?.lastSupersetAt ?? null,
        };
      }
      try {
        if (supersetDue) {
          const t0s = Date.now();
          const rep = checkRepo(spec.repo, { root: dir, prod: prodRoot });
          const verdict = conclusion([rep], { gate: 'blocking' });
          R.timings.supersetMs += Date.now() - t0s;
          ctx.supersetRanAt = new Date().toISOString();
          R.superset = {
            exitCode: verdict.exitCode, blocking: verdict.blockingTotal, risky: verdict.risky,
            recoverable: verdict.recoverableTotal, forked: verdict.forkedTotal, rewrite: verdict.rewriteTotal,
            files: (rep.uniqueLines ?? []).slice(0, 20).map((u) => u.rel),
            blockingFiles: (rep.blockingLines ?? []).slice(0, 20).map((u) => u.rel),
            text: verdict.text, durationMs: Date.now() - t0s,
          };
          if (verdict.exitCode !== 0) {
            supersetOk = false;
            R.notes.push(`🚧 超集挡推门：${verdict.text.slice(0, 220)}`);
            res.blocked = true;
            try { alert({ level: 'warn', source: 'text-sync', message: `超集挡推：${spec.repo} 有 ${verdict.blockingTotal} 个文件存在不可回退的仓侧独有行（${(rep.blockingLines ?? []).slice(0, 3).map((u) => u.rel).join(', ')}）` }, { home: o.home }); } catch { /* ignore */ }
          }
        }
      } catch (e) {
        supersetOk = false; res.blocked = true;
        R.notes.push(`🚧 超集体检不可用（fail-closed，不推）：${String(e?.message ?? e).slice(0, 160)}`);
      }

      // 4a) 推前安全门（判据真源 = lib/push-guard.mjs，与 hot 同一份）
      const gate = supersetOk ? tic('gateMs', () => judgeSyncSafety({
        dir, repo: spec.repo, host: hostTag(), branch: BRANCH,
        // ⚠️ 刻意**不**用 hot 的基准（hot 会自己维护）；用"fetch 后刚确认的 origin/master"——
        //   语义 = 「本机已消费到哪个远端点」。前提 = 本函数前面已 ff-only 拉平 + 回灌；
        //   没拉平的情形由门第①条（HEAD..origin > 0）先拦，走不到这里。
        lastSyncedSha: R.originSha,
        fetch: true, timeoutMs: 120_000,
        contentProbe: () => {
          const rep = checkRepo(spec.repo, { root: dir, prod: prodRoot });
          if (rep?.error) return { risky: true, reason: `内容体检不可用（${rep.error}）` };
          const files = (rep.uniqueLines ?? []).map((u) => u.rel);
          return {
            risky: files.length > 0, files,
            reason: `工作副本独有行 ${files.length} 个文件 / 疑似改写 ${rep.rewriteLines?.length ?? 0} 个`,
          };
        },
      })) : null;
      R.gate = gate ? { safe: gate.safe, code: gate.code, status: gate.status, reason: gate.reason, basis: gate.basis } : null;
      if (supersetOk && gate && (!gate.safe && !o.allowDivergence)) {
        R.notes.push(`🚧 推前安全门挡住（${gate.code}）：${gate.reason}`);
        res.blocked = true;
      } else if (supersetOk) {
        if (gate && !gate.safe && o.allowDivergence) {
          R.notes.push(`⚠️ 门被 --allow-divergence 显式放行（${gate.code}）`);
          appendAudit({ type: 'text-sync', action: 'push-guard-bypassed', repo: spec.repo, code: gate.code, reason: gate.reason }, { home: o.home });
        }
        // 4b) push
        const p = tic('pushMs', () => git(dir, ['push', 'origin', BRANCH], { timeout: 240_000 }));
        R.pushed = p.ok;
        if (!p.ok) {
          R.notes.push(`push 失败：${(p.err || p.out).slice(0, 200)}`);
        }
      } else {
        R.notes.push('⏸ 超集体检未过 ⇒ 本轮不推（fail-closed）');
      }
    }
  }

  res.repos.push(R);
  return R;
}

// ---------------------------------------------------------------- 状态 / 报告

function statePath(home) { return stateFileOf(STATE_NAME, home); }

function loadState(home) {
  return readJson(statePath(home), { defaultValue: null }) ?? {
    schemaVersion: 1, host: hostTag(), createdAt: new Date().toISOString(), rounds: [], last: null,
  };
}

function saveState(home, st) {
  try { const dw = writeStateText(STATE_NAME, JSON.stringify(st, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) }); if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown')); } catch { /* 状态写失败不致命 */ }
}

function cmdStatus(home) {
  const st = loadState(home);
  section('文本同步状态');
  if (!st.last) { log('    （尚无记录）'); OUT.json = { status: null, statePath: statePath(home) }; return 0; }
  const L = st.last;
  log(`    设备 ${st.host ?? '?'}　上次 ${L.at ?? '?'}　结果 ${L.result ?? '?'}　耗时 ${L.durationMs ?? '?'}ms`);
  log(`    通道 ${L.channel?.kind ?? '?'}（${L.channel?.detail ?? ''}）　${L.peerLine ?? ''}`);
  for (const r of L.repos ?? []) {
    log(`    ${r.key.padEnd(8)} 采集 ${r.collected} / 未变 ${r.collectUnchanged} / 回灌 ${r.backfilled?.length ?? 0} / 提交 ${r.committed ? r.commitSha : '无'} / 推 ${r.pushed ? '✓' : '—'}`);
  }
  log(`    状态文件 ${statePath(home)}`);
  OUT.json = { status: L, statePath: statePath(home) };
  return 0;
}

function summarize(res, o, ctx, t0) {
  const parts = [];
  parts.push(`[text-sync] ${ctx.stamp.slice(9, 13)}:${ctx.stamp.slice(13, 15)} ${res.result} · ${o.apply ? 'APPLY' : 'DRY-RUN'} · 通道=${res.channel.kind}`);
  for (const r of res.repos) {
    parts.push(`${r.key}: 采${r.collected}/未变${r.collectUnchanged}/回灌${r.backfilled.length}/提交${r.committed ? r.commitSha : '无'}/推${r.pushed ? '✓' : '—'}`);
  }
  parts.push(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- 回滚

function cmdRollback(o) {
  const dir = path.resolve(o.rollback);
  const manFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manFile)) { process.stderr.write(`❌ 找不到 manifest：${manFile}\n`); return 2; }
  const man = readJson(manFile, { defaultValue: null });
  if (!man?.entries) { process.stderr.write('❌ manifest 无 entries\n'); return 2; }
  section(`回灌回滚（${o.rollbackApply ? 'APPLY' : 'dry-run'}）`);
  let n = 0, del = 0, miss = 0;
  for (const e of man.entries) {
    if (e.targetExistsBefore === false) {
      log(`    DEL   ${e.rel}`);
      if (o.rollbackApply && fs.existsSync(e.target)) {
        if (!rmGuarded(e.target, [o.dshRoot, o.home], 'text-sync 回灌回滚：删除回灌新建的文件', false)) return DESTRUCTIVE_EXIT.REFUSE;
      }
      del++;
      continue;
    }
    const bak = path.join(dir, 'before', e.key, e.rel);
    if (!fs.existsSync(bak)) { log(`    MISS  ${e.rel}（缺备份 ${bak}）`); miss++; continue; }
    log(`    REST  ${e.rel} → ${e.target}`);
    if (o.rollbackApply) { fs.mkdirSync(path.dirname(e.target), { recursive: true }); copyPreserve(bak, e.target); }
    n++;
  }
  log(`    ${o.rollbackApply ? '[apply] ' : '[dry-run] '}还原 ${n} / 删除 ${del} / 缺备份 ${miss}`);
  if (!o.rollbackApply) log('    加 --rollback-apply 才真写。');
  OUT.json = { ok: true, restored: n, deleted: del, missing: miss, applied: o.rollbackApply };
  if (o.rollbackApply) appendAudit({ type: 'text-sync', action: 'rollback', dir, restored: n, deleted: del, missing: miss }, { home: resolveRoots(o).home });
  return 0;
}

// ---------------------------------------------------------------- 主流程

export async function run(argv = process.argv.slice(2)) {
  const t0 = Date.now();
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (o.unknown) { process.stderr.write(`❌ 未知参数：${o.unknown}\n\n${USAGE}\n`); return 2; }

  const roots = resolveRoots(o);
  // ⚠️ 必须把解析后的根合回 `o`：`spec.prodDir(o)` 读的是 `o.dshRoot` / `o.home` / `o.archiveRoot`，
  //    而它们只有在这里才被解析出默认值（2026-10-11 生产 dry-run 实测：不合并 ⇒ path.join(null) 崩）
  Object.assign(o, roots);
  if (o.rollback) return cmdRollback(o);
  if (o.status) return cmdStatus(roots.home);

  const only = o.only ? new Set(String(o.only).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const specs = SPECS.filter((s) => !only || only.has(s.key));
  if (!specs.length) { process.stderr.write(`❌ --only 没匹配到任何 key（可用：${SPECS.map((s) => s.key).join(', ')}\n`); return 2; }
  if (!fs.existsSync(roots.repoRoot)) { process.stderr.write(`❌ 工作副本根不存在：${roots.repoRoot}\n`); return 1; }

  const ctx = { ...roots, stamp: stamp(), host: hostTag() };
  ctx.state = o.apply ? loadState(roots.home) : null;
  const res = {
    schemaVersion: 1, tool: 'text-sync.mjs', version: TEXT_SYNC_VERSION, host: ctx.host,
    at: new Date().toISOString(), apply: o.apply, mode: o.apply ? 'apply' : 'dry-run',
    channel: null, peers: null, repos: [], backfilled: [], backfillPlan: [], backfillSkipped: [],
    backfillArchive: [], blocked: false, result: 'ok', reason: null, durationMs: 0,
  };

  // ---- 锁（只有真写才抢；与 hot/handoff 共用 handoff）----
  // ⚠️ 抢锁移到**通道择路之后**：择路只用 `git ls-remote`（只读、不碰本地 git index），
  //    通道不通就没必要占着 handoff 锁把 hot 挡在门外（2026-10-11 改）。
  let lock = null;

  try {
    section(`跨机文本同步（${o.apply ? 'APPLY' : 'DRY-RUN'}）`);
    log(`    工作副本根 ${roots.repoRoot}`);
    log(`    生产 home  ${roots.home}`);
    log(`    生产 DSH   ${roots.dshRoot}`);
    log(`    范围       ${specs.map((s) => s.key).join(', ')}（**文本 only**）`);

    // ---- 通道择路 ----
    const probeDir = path.join(roots.repoRoot, 'dsh-workspace');
    res.channel = resolveChannel(o, probeDir);
    log(`    通道       ${res.channel.kind} —— ${res.channel.detail}`);
    if (o.peerProbe) {
      res.peers = probePeers();
      res.peerLine = peerLine(res.peers);
      log(`    ${res.peerLine}`);
    } else {
      log('    对端探测   已跳过（--no-peer-probe）');
    }

    // ---- 让路判定（两条：通道不通 / 抢不到锁）——**都走同一条收尾**（状态文件与流水照写，可查）----
    if (res.channel.kind === 'none') {
      res.result = 'deferred'; res.reason = '通道不通（直连与代理都失败）⇒ 跳过本轮';
      log(`⏸ ${res.reason}`);
      if (o.apply) appendAudit({ type: 'text-sync', action: 'channel-none', detail: res.channel.detail }, { home: roots.home });
    } else if (o.apply) {
      lock = acquireTickLock(o.lockName, { ttlMs: LOCK_TTL_MS, home: roots.home });
      if (!lock.ok) {
        res.result = 'deferred'; res.reason = `抢不到 ${o.lockName} 锁（${lock.reason ?? ''}）`;
        log(`⏸ ${res.reason} ⇒ 本轮让路`);
      }
    }

    if (res.result !== 'deferred') {
      // ---- 逐 spec ----
      for (const spec of specs) processRepo(o, ctx, spec, res);

      // ---- 结论 ----
      section('结论');
      for (const r of res.repos) {
        log(`    ${r.key.padEnd(8)} head ${String(r.headAfterCommit ?? r.headAfterPull ?? r.headBefore ?? '-').slice(0, 8)}　` +
          `采集 ${r.collected}（未变 ${r.collectUnchanged} / 非文本跳过 ${r.skippedExt}）　回灌 ${r.backfilled.length}　` +
          `提交 ${r.committed ? r.commitSha : '—'}　推送 ${r.pushed ? '✓' : '—'}　拉取 ${r.pulled}`);
        for (const n of r.notes) log(`             ⚠️ ${n}`);
        if (r.superset?.skipped) log(`             ℹ️ ${r.superset.reason}`);
      }
      if (res.backfillSkipped.length) {
        const byReason = {};
        for (const s of res.backfillSkipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
        log(`    回灌跳过 ${res.backfillSkipped.length}：` + Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(' / '));
      }
      if (res.backfillArchive.length) log(`    回灌回滚点 ${res.backfillArchive.join(' , ')}（回滚：node restore.mjs --apply）`);

      const anyNote = res.repos.some((r) => r.notes.length);
      res.result = res.blocked ? 'blocked' : (anyNote ? 'partial' : 'ok');
      if (res.blocked) { res.reason = '推前安全门拦截（见各仓 notes）'; }
      if (res.result !== 'ok') {
        try { alert({ level: 'warn', source: 'text-sync', message: `text-sync ${res.result}：${res.reason ?? (res.repos.flatMap((r) => r.notes).join(' | ').slice(0, 180))}` }, { home: roots.home }); } catch { /* 告警失败不致命 */ }
      }
    }
  } catch (e) {
    res.result = 'failed'; res.reason = String(e?.message ?? e).slice(0, 300);
    log(`❌ 失败：${res.reason}`);
    try { alert({ level: 'error', source: 'text-sync', message: `text-sync failed：${res.reason}` }, { home: roots.home }); } catch { /* ignore */ }
  } finally {
    try { lock?.release?.(); } catch { /* ignore */ }
  }

  res.durationMs = Date.now() - t0;
  // 状态落盘（只挡 apply；dry-run 只打印不写）
  if (o.apply) {
    const st = loadState(roots.home);
    st.host = ctx.host; st.updatedAt = res.at; st.last = res;
    if (ctx.supersetRanAt) st.lastSupersetAt = ctx.supersetRanAt;
    st.rounds = [...(st.rounds ?? []), {
      at: res.at, result: res.result, mode: res.mode, channel: res.channel?.kind,
      collected: res.repos.reduce((a, r) => a + r.collected, 0),
      backfilled: res.backfilled.length,
      commits: res.repos.filter((r) => r.committed).map((r) => r.commitSha),
      pushed: res.repos.filter((r) => r.pushed).length,
      reason: res.reason ?? null,
    }].slice(-48);
    saveState(roots.home, st);
    appendAudit({
      type: 'text-sync', action: 'round', result: res.result, mode: res.mode,
      channel: res.channel?.kind, collected: res.repos.reduce((a, r) => a + r.collected, 0),
      backfilled: res.backfilled.length,
      commits: res.repos.filter((r) => r.committed).map((r) => r.commitSha),
      pushed: res.repos.filter((r) => r.pushed).length,
      reason: res.reason ?? null,
    }, { home: roots.home });
  }

  log('');
  log(summarize(res, o, ctx, t0));
  OUT.json = res;
  if (o.json) log('---JSON---\n' + JSON.stringify(res, null, 2));
  if (res.result === 'failed') return 1;
  if (res.result === 'deferred') return 3;
  return 0;
}

// ---- 入口守卫（junction/realpath 坑：argv[1] 是逻辑路径、import.meta.url 是物理路径）----
const isMain = (() => {
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1] ?? ''));
    const b = fs.realpathSync(path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    return a === b;
  } catch { return false; }
})();

if (isMain) {
  run().then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`❌ ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
