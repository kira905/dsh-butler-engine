// dsh-butler / lib/memory-snapshot.mjs —— 记忆库「每日 1 次热采 + 内容未变不推」
//
// 为什么存在（主人 2026-09-17 拍板 · 依据 docs\P9第四轮15条-消化核对-20260917.md §四 ②）：
//   记忆库 memory.db 是 **A 类不可重建资产**，但它的 RPO 一直是最差的那一档 ——
//   只在 Depart（收工冷采）时进仓1，最坏要丢一整天的记忆（§5.7 登记口径）。
//   R4 收口卡已实测 `VACUUM INTO` 成本（21ms / 1.43MB），本模块把它做成**每日一次**的热采：
//     · 只读打开生产库 + `VACUUM INTO` 快照（**绝不写 memory.db 本体**）
//     · 与仓1 现副本逐字节比对（sha256）——**内容没变就零写入、零提交、不增仓体积**
//     · 有变化才更新仓1 采集副本 + 走**既有**采集/推送链路（`dsh-backup-sync.ps1 -Push`，
//       含超集挡推门 + git-crypt 加密），绝不另造一套 push
//     · 失败/让路一律可见（状态文件 + `butler-alert.log` + tickd 日报「tick 调度健康」段）
//
// 为什么不是 30 分钟档（主人已否决）：
//   仓1 实测已 240MB > §5.4 的 200MB 阈值，而 memory.db 是二进制快照、git **无法做内容增量**
//   ⇒ 高频只会把仓撑爆。「每日 1 次 + 内容未变不推」把最坏缺口从「一天」压到「一天且必然落仓」，
//   且写入量由真实变化决定（实测日新增 1~80 条，未变的日子零提交）。
//
// 为什么与 hot / 交接器**共用 `handoff` 锁**：
//   本 job 会写仓1 工作副本（`dsh/memory/memory.db`）+ commit + push，而 hot（30 分钟热采）与
//   handoff（Depart/Arrive）动的是**同一个工作副本**。三者并发 = index.lock 打架 / 工作副本中间态
//   （§5.3 第 6 条 R12「四类触发源共用单例锁」）。登记见 lib/butler-locks.mjs。
//
// 幂等与「补推」语义：
//   内容未变 → 不写、不提交；但若 git 里还有**本机未推送的提交**（上轮 push 被挡/失败留下的），
//   仍走一次既有 push 链路把它推出去 —— 否则那批提交会永久积压在本机（hot-collect 同款教训，
//   见 lib/hot-collect.mjs 的 ahead>0 注释）。这一步不产生任何新体积。
import fs from 'node:fs';
import { workspaceRoot } from './ws-root.mjs';
import { gitBackupRoot } from './ws-root.mjs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { acquireTickLock } from '../../src/dsh-butler/lib/store.mjs';
import { updateStateJson } from '../../src/dsh-butler/lib/dual-write-store.mjs';
import { git } from './hot-collect.mjs';
import { alert } from '../../src/dsh-butler/lib/alert.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../src/lib/production-guard.mjs';

/** 唯一删口（R-065）：dry-run 是本函数**第一条**可执行语句；被拒 ⇒ 返回 false（调用方按「没删」处理）。 */
function removeGuarded(target, { whitelist, reason = null, dryRun = false, allowReparse = false, op = '删文件' } = {}) {
  if (dryRun === true) return false;
  const g = gateDestructive({
    targets: [{ path: target, label: reason }], whitelist, op, scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return false;
  try { fs.rmSync(target, { force: true }); return true; } catch { return false; }
}

/** 唯一搬移口（R-065）：同卷 rename 的**原子替换**语义。dry-run 同样是第一条可执行语句。 */
function renameGuarded(from, to, { whitelist, reason = null, dryRun = false, allowReparse = false } = {}) {
  if (dryRun === true) return { ok: true, dryRun: true, code: 'dry-run', reason: 'dry-run（零动作）' };
  const g = gateDestructive({
    targets: [{ path: from, label: 'src' }, { path: to, label: 'dst' }], whitelist, op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return { ok: false, code: g.code, reason: g.reason };
  try { fs.renameSync(from, to); return { ok: true, code: null, reason: g.reason }; }
  catch (e) { return { ok: false, code: 'fs-error', reason: String(e?.message ?? e) }; }
}


export const MEMORY_SNAPSHOT_VERSION = '0.1.0';

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-memory-snapshot.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

/** 本机状态文件（~/.dsh 下相对名；登记在 lib/state-files.mjs，sync:false）。 */
export const STATE_NAME = 'butler-memory-snapshot.json';
/** 与 hot / handoff 共用同一把锁（见文件头）。 */
export const LOCK_NAME = 'handoff';
export const LOCK_TTL_MS = 45 * 60 * 1000;
/** 仓1 工作副本内的记忆库副本相对路径（采集白名单 `memory` 目录 + `.gitattributes` 加密段）。 */
export const REPO_COPY_REL = path.posix.join('dsh', 'memory', 'memory.db');
export const DEFAULT_REPO_DIR = path.join(gitBackupRoot(), 'dsh-core');
export const DEFAULT_DSH_ROOT = workspaceRoot();
/** VACUUM INTO 的重试（与 DSH 自身的写事务错开，避免 SQLITE_BUSY）。 */
export const VACUUM_RETRIES = 3;
export const VACUUM_BACKOFF_MS = [300, 900, 2700];
export const BUSY_TIMEOUT_MS = 5000;
/** 临时快照目录（可注入/可被环境变量改道；默认在系统临时目录，绝不落生产路径）。 */
export function defaultTmpDir() {
  return process.env.DSH_MEMORY_SNAPSHOT_TMP || path.join(os.tmpdir(), 'dsh-memory-snapshot');
}
export function defaultRepoDir() {
  return process.env.DSH_MEMORY_SNAPSHOT_REPO || DEFAULT_REPO_DIR;
}
export function localMemoryDbPath(home = dshHome()) {
  return path.join(home, 'memory', 'memory.db');
}
export function repoCopyPathOf(repoDir) {
  return path.join(repoDir, ...REPO_COPY_REL.split('/'));
}
export function statePathOf(home = dshHome()) {
  return stateFileOf(STATE_NAME, { home });
}

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } };

// ---------------------------------------------------------------- 基础工具（纯函数 / 只读）

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** git-crypt 密文特征（`\0GITCRYPT\0` 头）：仓未 unlock 时工作副本里就是它。 */
export function looksGitCrypt(file) {
  try {
    const buf = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, 16, 0); } finally { fs.closeSync(fd); }
    return buf.includes(Buffer.from('GITCRYPT'));
  } catch { return false; }
}

/** 打开一个库做只读体检：integrity_check + 逐表条数（源库/快照共用同一口径）。 */
export function inspectDb(file, { sqlite = (f, o) => new DatabaseSync(f, o), busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  const db = sqlite(file, { readOnly: true });
  try {
    try { db.exec(`PRAGMA busy_timeout=${Number(busyTimeoutMs) || 0}`); } catch { /* 只读连接上设置失败不致命 */ }
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check ?? Object.values(r)[0]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const counts = {};
    for (const t of tables) {
      try { counts[t] = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c); } catch { counts[t] = null; }
    }
    return { integrity, integrityOk: integrity.length === 1 && String(integrity[0]).toLowerCase() === 'ok', tables, counts };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 内容指纹：逐表「表名 + 条数 + 全表行内容（键排序后 JSON）」哈希。
 * 用途：当仓1 副本与快照**字节不同**时回答"是不是只是形态不同（库本体 vs 真空快照）、内容其实一样"，
 * 只作诊断字段，不参与"要不要落仓"的判定（判定看字节 sha，见 decideSnapshotAction）。
 */
export function contentFingerprint(file, { sqlite = (f, o) => new DatabaseSync(f, o) } = {}) {
  const db = sqlite(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const h = crypto.createHash('sha256');
    for (const t of tables) {
      let rows;
      try { rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all(); }
      catch { rows = db.prepare(`SELECT * FROM "${t}"`).all(); }
      h.update(`${t}:${rows.length}\n`);
      for (const r of rows) h.update(JSON.stringify(r, Object.keys(r).sort()) + '\n');
    }
    return h.digest('hex');
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * `VACUUM INTO` 在线快照（**只读源库**，绝不写 memory.db 本体）。
 * 退避重试：DSH 侧恰好在写记忆时会短暂持有写锁 → 3 次退避（0.3/0.9/2.7s），仍失败则如实上报。
 * @returns {{ok:boolean, ms:number, attempts:number, out?:string, error?:string}}
 */
export function vacuumInto(src, out, {
  sqlite = (f, o) => new DatabaseSync(f, o),
  busyTimeoutMs = BUSY_TIMEOUT_MS,
  retries = VACUUM_RETRIES,
  backoffMs = VACUUM_BACKOFF_MS,
  sleep = sleepSync,
} = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let lastError = null;
  const attempts = Math.max(1, Number(retries) || 1);
  for (let i = 0; i < attempts; i++) {
    const t0 = Date.now();
    let db = null;
    try {
      db = sqlite(src, { readOnly: true });
      try { db.exec(`PRAGMA busy_timeout=${Number(busyTimeoutMs) || 0}`); } catch { /* ignore */ }
      try { removeGuarded(out, { whitelist: [path.dirname(out)], reason: 'VACUUM 目标预清理' }); } catch { /* ignore */ }
      db.exec(`VACUUM INTO '${String(out).replace(/'/g, "''")}'`);
      return { ok: true, ms: Date.now() - t0, attempts: i + 1, out };
    } catch (e) {
      lastError = String(e?.message ?? e);
      if (i < attempts - 1) sleep(backoffMs[Math.min(i, backoffMs.length - 1)] ?? 1000);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  return { ok: false, ms: 0, attempts, error: lastError, out };
}

/**
 * **要不要落仓**的判定（纯函数，单测锚点）。
 * 顺序即优先级：密文仓 fail-closed > 副本缺失 > 显式 --force > 内容变化 > 未变但有未推提交（补推）> 未变。
 * @returns {{action:'write'|'resume-push'|'unchanged'|'blocked', reason:string}}
 */
export function decideSnapshotAction({
  snapshotSha, repoCopySha = null, repoCopyExists = true, ahead = 0,
  force = false, gitCryptLocked = false,
} = {}) {
  if (gitCryptLocked) return { action: 'blocked', reason: 'repo-copy-is-git-crypt-cipher（仓1 工作副本未 unlock）' };
  if (!repoCopyExists) return { action: 'write', reason: 'repo-copy-missing（仓里还没有记忆库副本）' };
  if (force === true) return { action: 'write', reason: 'force' };
  if (!snapshotSha || snapshotSha !== repoCopySha) return { action: 'write', reason: 'content-changed' };
  if (Number(ahead) > 0) return { action: 'resume-push', reason: `unchanged-but-${Number(ahead)}-commits-ahead（内容未变，仅补推积压提交）` };
  return { action: 'unchanged', reason: 'content-identical（零写入 / 零提交）' };
}

// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】统一 PowerShell 真源（pwsh 7 优先）
import { powerShellCandidates } from './powershell-exe.mjs';

/** 解析 pwsh（PS7 优先，回落 powershell.exe）。候选来自统一工具（tools/lib/powershell-exe.mjs）。 */
export function resolvePwsh() {
  // 【2026-10-09 · 卡「360弹窗治本-pwsh7」】候选换成统一真源：原先只认 PATH 的 'pwsh' 名，
  //   本机 pwsh 是 WindowsApps 别名（existsSync=false 但可跑）—— 用工具的候选表能覆盖到全路径形态。
  const cands = [...new Set([process.env.DSH_PWSH, ...powerShellCandidates().map((c) => c.exe)].filter(Boolean))];
  for (const c of cands) {
    const r = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 20_000 });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

/**
 * 默认推送实现 = **既有链路**：`tools\dsh-backup-sync.ps1 -Push`
 * （含超集挡推门 Assert-PushSafe + git-crypt，绝不在此另写一套 git push）。
 * @returns {{ok:boolean, blocked:boolean, code:string|null, output:string}}
 */
export function defaultPush({ repoDir = defaultRepoDir(), dshRoot = DEFAULT_DSH_ROOT, timeoutMs = 300_000 } = {}) {
  const ps1 = path.join(dshRoot, 'tools', 'dsh-backup-sync.ps1');
  if (!fs.existsSync(ps1)) return { ok: false, blocked: false, code: 'ps1-missing', output: `缺少既有推送链路：${ps1}` };
  const exe = resolvePwsh();
  if (!exe) return { ok: false, blocked: false, code: 'pwsh-missing', output: '找不到 pwsh/powershell，无法调用既有推送链路' };
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ps1, '-Push', '-Repo', repoDir], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  if (r.error) return { ok: false, blocked: false, code: `spawn-${r.error.code ?? 'error'}`, output: `${r.error.message}\n${output}` };
  const blocked = /PUSH BLOCKED/.test(output);
  const ok = r.status === 0 && !blocked;
  return {
    ok, blocked, code: ok ? null : (blocked ? 'push-blocked' : `exit-${r.status}`), output,
  };
}

// ---------------------------------------------------------------- 主流程

function defaultDeps() {
  return {
    sqlite: (f, o) => new DatabaseSync(f, o),
    git,
    push: defaultPush,
    alert,
    acquireLock: (name, opts) => acquireTickLock(name, opts),
    // 写层按「目录 + 文件名」两段表达：name = stateFile 的 basename（canonical 时正好就是 STATE_NAME），
    // home 由 updateStateJson 取 dirname(file)。**传死 STATE_NAME 会把自定义 basename 静默丢弃**
    // （file 只被当目录来源）⇒ `runMemorySnapshot({ stateFile: <自定义路径> })` 不落盘，
    // 只有测试/自定义调用方会撞到（生产 CLI 传的就是 canonical 名）。2026-10-22 修。
    writeState: (file, fn, opts) => updateStateJson(path.basename(file), file, fn, opts),
    now: () => Date.now(),
    sleep: sleepSync,
  };
}

function fmtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function stampCompact(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 跑一轮记忆库热采（**绝不写生产 memory.db**）。
 *
 * @param {{
 *   home?:string, srcDb?:string, repoDir?:string, repoCopyPath?:string, tmpDir?:string, stateFile?:string,
 *   dshRoot?:string, dryRun?:boolean, force?:boolean, noPush?:boolean, keepSnapshot?:boolean,
 *   lock?:boolean, host?:string, deps?:object
 * }} [opts]
 * @returns {Promise<object>} 结构化结果（result / exitCode / stages / 各阶段明细）
 */
export async function runMemorySnapshot(opts = {}) {
  const deps = { ...defaultDeps(), ...(opts.deps ?? {}) };
  const t0 = deps.now();
  const home = opts.home ?? dshHome();
  const host = String(opts.host ?? process.env.COMPUTERNAME ?? os.hostname() ?? 'unknown').toLowerCase();
  const src = opts.srcDb ?? localMemoryDbPath(home);
  const repoDir = opts.repoDir ?? defaultRepoDir();
  const repoCopy = opts.repoCopyPath ?? repoCopyPathOf(repoDir);
  const tmpDir = opts.tmpDir ?? defaultTmpDir();
  const stateFile = opts.stateFile ?? statePathOf(home);
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const noPush = opts.noPush === true;
  const useLock = opts.lock !== false;

  const out = {
    ok: false, result: 'failed', exitCode: 1, host, at: fmtLocal(t0), startedAt: new Date(t0).toISOString(),
    version: MEMORY_SNAPSHOT_VERSION, dryRun, force, noPush,
    paths: { src, repoDir, repoCopy, tmpDir, stateFile },
    stages: [], alerts: [], deferred: [],
    snapshot: null, repo: { beforeSha: null, afterSha: null, existed: false, gitCryptLocked: false },
    commit: null, push: null, integrity: null, counts: null,
    durationMs: 0, finishedAt: null,
  };
  const stage = (name, detail = {}) => { out.stages.push({ name, at: fmtLocal(deps.now()), ...detail }); };
  const fail = (stageName, message, { exitCode = 1, result = 'failed' } = {}) => {
    out.result = result; out.exitCode = exitCode; out.ok = result === 'ok' || result === 'unchanged';
    out.error = message; out.lastStage = stageName;
    stage(stageName, { ok: false, message });
    out.alerts.push({ level: exitCode === 3 ? 'warn' : 'error', code: stageName, message });
    return finish();
  };

  let lock = null;
  let snapshotFile = null;
  const finish = () => {
    out.durationMs = deps.now() - t0;
    out.finishedAt = new Date().toISOString();
    // 临时快照清理：失败时**保留**（供排障，状态文件记路径），下次跑清 stale；非失败一律删。
    if (snapshotFile) {
      const keep = out.result === 'failed' && opts.keepSnapshot !== false;
      if (!keep) { try { removeGuarded(snapshotFile, { whitelist: [path.dirname(snapshotFile)], reason: '临时快照清理', dryRun }); } catch { /* ignore */ } }
      else out.snapshot.keptAt = snapshotFile;
    }
    sweepStaleSnapshots(tmpDir, deps);
    // 状态文件：**每轮都写**（含失败），失败可见的第一现场
    if (!dryRun) {
      try {
        deps.writeState(stateFile, (cur) => stampState(cur, { out, host }), { schemaVersion: 1, defaultValue: {} });
      } catch (e) { out.alerts.push({ level: 'warn', code: 'state-write-failed', message: `状态文件写入失败：${String(e?.message ?? e)}` }); }
      const bad = out.alerts.filter((a) => a.level === 'error' || a.level === 'warn');
      for (const a of bad) {
        try { deps.alert({ level: a.level === 'warn' ? 'warn' : 'error', source: 'butler-memory-snapshot', message: `[${out.result}] ${a.message}`, detail: { stage: out.lastStage ?? null, result: out.result, counts: out.counts ?? null } }, { home, silent: true }); } catch { /* 告警通道故障不影响结论 */ }
      }
    }
    return out;
  };

  // 0) 单例锁（与 hot / handoff 共用 `tick-handoff.lock`；tickd 侧持锁时走继承虚拟锁）
  if (useLock) {
    lock = deps.acquireLock(LOCK_NAME, { ttlMs: LOCK_TTL_MS, home });
    if (!lock?.ok) {
      out.deferred.push(`交接锁被占用（${lock?.reason ?? 'held'}）→ 本轮记忆库热采跳过（不并发，§5.3 R12）`);
      return fail('lock-held', `交接锁被占用（${lock?.reason ?? 'held'}）：本轮跳过（下轮照跑，不丢内容 —— 键是"内容未变不推"而非"必须每轮推"）`, { exitCode: 3, result: 'blocked' });
    }
  }

  try {
    // 1) 前置体检：源库在不在
    if (!fs.existsSync(src)) {
      return fail('precheck', `生产记忆库不存在：${src}`);
    }
    const srcBytes = fs.statSync(src).size;
    const srcShaBefore = sha256File(src);
    stage('precheck', { ok: true, srcBytes, srcShaBefore });

    // 2) VACUUM INTO（只读源库 → 临时快照）
    snapshotFile = path.join(tmpDir, `memory-${stampCompact(t0)}.db`);
    const vac = vacuumInto(src, snapshotFile, { sqlite: deps.sqlite, sleep: deps.sleep });
    if (!vac.ok) {
      out.snapshot = { file: snapshotFile, vacuumMs: vac.ms, vacuumAttempts: vac.attempts };
      return fail('vacuum', `VACUUM INTO 失败（${vac.attempts} 次尝试）：${vac.error}`);
    }
    const snapBytes = fs.statSync(snapshotFile).size;
    const snapSha = sha256File(snapshotFile);
    out.snapshot = { file: snapshotFile, vacuumMs: vac.ms, vacuumAttempts: vac.attempts, bytes: snapBytes, sha256: snapSha };
    stage('vacuum', { ok: true, ms: vac.ms, attempts: vac.attempts, bytes: snapBytes, sha256: snapSha });

    // 3) 产物校验：能打开 + integrity_check=ok + 逐表条数与源库一致（不一致**绝不落仓**）
    const snapInfo = inspectDb(snapshotFile, { sqlite: deps.sqlite });
    const srcInfo = inspectDb(src, { sqlite: deps.sqlite });
    out.integrity = { snapshot: snapInfo.integrity, source: srcInfo.integrity, ok: snapInfo.integrityOk };
    out.counts = { snapshot: snapInfo.counts, source: srcInfo.counts, equal: JSON.stringify(snapInfo.counts) === JSON.stringify(srcInfo.counts) };
    if (!snapInfo.integrityOk) {
      return fail('verify', `快照 integrity_check 未通过（${JSON.stringify(snapInfo.integrity).slice(0, 200)}）→ 不落仓`);
    }
    if (!out.counts.equal) {
      return fail('verify', '快照逐表条数与源库不一致 → 不落仓（快照不可信）');
    }
    stage('verify', { ok: true, tables: snapInfo.tables.length, memories: snapInfo.counts.memories ?? null });

    // 3.5) 源库零写入自证（只读断言：跑前后 sha 必须一致）
    const srcShaAfter = sha256File(src);
    out.sourceUnchanged = srcShaBefore === srcShaAfter;
    if (!out.sourceUnchanged) out.deferred.push('生产记忆库在采集期间发生了写入（快照仍是一致态；源库 sha 变化是 DSH 自己的写，不是本 job）');
    out.source = { bytes: srcBytes, shaBefore: srcShaBefore, shaAfter: srcShaAfter };
    stage('source-readonly-check', { ok: out.sourceUnchanged, sha: srcShaAfter });

    // 4) 与仓1 现副本比对
    out.repo.existed = fs.existsSync(repoCopy);
    out.repo.gitCryptLocked = out.repo.existed ? looksGitCrypt(repoCopy) : false;
    out.repo.beforeSha = out.repo.existed ? sha256File(repoCopy) : null;
    out.repo.beforeBytes = out.repo.existed ? fs.statSync(repoCopy).size : null;
    // 密文仓 fail-closed 判定**先于** ahead 查询：仓未 unlock 时连只读 git 都不必碰
    const ahead = (!out.repo.gitCryptLocked && repoDirExists(repoDir)) ? commitsAhead(repoDir, deps) : 0;
    out.repo.ahead = ahead;
    const decision = decideSnapshotAction({
      snapshotSha: snapSha, repoCopySha: out.repo.beforeSha, repoCopyExists: out.repo.existed,
      ahead, force, gitCryptLocked: out.repo.gitCryptLocked,
    });
    out.decision = decision;
    stage('compare', { ok: true, action: decision.action, reason: decision.reason, repoCopySha: out.repo.beforeSha, ahead });

    if (decision.action === 'blocked') {
      return fail('git-crypt-locked', `仓1 工作副本未 unlock（${repoCopy} 是 git-crypt 密文）→ 拒绝写入（fail-closed，避免明文入库）`, { exitCode: 3, result: 'blocked' });
    }

    if (decision.action === 'unchanged') {
      out.ok = true; out.result = 'unchanged'; out.exitCode = 0;
      out.deferred.push('内容与仓1 副本逐字节一致 → 零写入 / 零提交 / 未推送（§四 ② 的口径）');
      out.repo.afterSha = out.repo.beforeSha;
      return finish();
    }

    if (dryRun) {
      out.ok = true; out.result = 'dry-run'; out.exitCode = 0;
      out.deferred.push(`dry-run：将执行 ${decision.action}（${decision.reason}），未写任何文件`);
      return finish();
    }

    if (!fs.existsSync(repoDir)) {
      return fail('repo-missing', `仓1 工作副本不存在：${repoDir}（先跑 dsh-backup-sync.ps1 -Init / -Pull）`);
    }
    // 子目录不存在 = 首次把记忆库放进这个工作副本 → 允许建（仓根在就够了）
    fs.mkdirSync(path.dirname(repoCopy), { recursive: true });

    // 5) 更新仓1 采集副本（只在有变化时；写后校验 sha）
    if (decision.action === 'write') {
      const tmpDst = `${repoCopy}.tmp-${process.pid}`;
      fs.copyFileSync(snapshotFile, tmpDst);
      if (sha256File(tmpDst) !== snapSha) {
        try { removeGuarded(tmpDst, { whitelist: [path.dirname(tmpDst)], reason: '复制校验失败回收 tmp' }); } catch { /* ignore */ }
        return fail('copy', '复制到仓1 采集副本后 sha 不符（写入不完整）→ 已回退，未落仓');
      }
      const gr = renameGuarded(tmpDst, repoCopy, { whitelist: [path.dirname(repoCopy)], reason: '更新仓1 采集副本（原子替换）' });
      if (!gr.ok) return fail('copy', `落仓被三件套拒绝（${gr.code}）：${gr.reason}`);
      out.repo.afterSha = sha256File(repoCopy);
      out.repo.afterBytes = fs.statSync(repoCopy).size;
      if (out.repo.afterSha !== snapSha) return fail('copy', '落仓后 sha 校验不符（目标被并发改写？）');
      stage('copy', { ok: true, bytes: out.repo.afterBytes, sha256: out.repo.afterSha });

      // 6) 提交（复用既有 git 封装；只 add 这一个文件，不捎带工作树其它改动）
      const c = commitRepoCopy(repoDir, repoCopy, { host, now: t0, deps });
      out.commit = c;
      if (!c.ok) return fail('commit', `git 提交失败：${c.error ?? '未知'}`);
      stage('commit', { ok: true, committed: c.committed, message: c.message });
    } else {
      stage('copy', { ok: true, skipped: 'resume-push（内容未变，不重写副本）' });
      out.commit = { ok: true, committed: false, reason: 'unchanged' };
    }

    // 7) 推送（既有链路 dsh-backup-sync.ps1 -Push；含超集挡推门）
    if (noPush) {
      out.ok = true; out.result = 'ok'; out.exitCode = 0;
      out.deferred.push('--no-push：已提交但未推送（演练/沙箱用）');
      return finish();
    }
    const p = deps.push({ repoDir, dshRoot: opts.dshRoot ?? DEFAULT_DSH_ROOT });
    out.push = { ok: !!p.ok, blocked: !!p.blocked, code: p.code ?? null, outputTail: String(p.output ?? '').slice(-4000) };
    stage('push', { ok: !!p.ok, blocked: !!p.blocked, code: p.code ?? null });
    if (p.blocked) {
      return fail('push-blocked',
        `既有推送链路拦下本次推送（超集挡推门）：${(p.output ?? '').split('\n').filter((l) => l.trim()).slice(-3).join(' / ').slice(0, 300)}`,
        { exitCode: 3, result: 'blocked' });
    }
    if (!p.ok) {
      return fail('push-failed', `推送失败（${p.code ?? '未知'}）：${(p.output ?? '').slice(-300)}`);
    }
    out.ok = true; out.result = 'ok'; out.exitCode = 0;
    return finish();
  } catch (e) {
    return fail('exception', `未预期异常：${String(e?.stack ?? e).slice(0, 600)}`);
  } finally {
    try { if (lock && typeof lock.release === 'function') lock.release(); } catch { /* ignore */ }
  }
}

function repoDirExists(repoDir) {
  try { return fs.existsSync(path.join(repoDir, '.git')); } catch { return false; }
}

/** 本机未推送提交数（ahead>0 ⇒ 内容未变也要补推，否则那批提交永久积压）。 */
export function commitsAhead(repoDir, deps) {
  const g = deps.git ?? git;
  const br = g(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (br.ok && br.out) ? br.out : 'master';
  const ab = g(repoDir, ['rev-list', '--count', `origin/${branch}..HEAD`]);
  return ab.ok ? (Number(ab.out) || 0) : 0;
}

/** 提交仓1 采集副本（只 add 目标文件；复用既有 git 封装，不另造 push）。 */
export function commitRepoCopy(repoDir, repoCopyRelOrAbs, { host = 'host', now = Date.now(), deps } = {}) {
  const g = deps?.git ?? git;
  const rel = path.isAbsolute(repoCopyRelOrAbs)
    ? path.relative(repoDir, repoCopyRelOrAbs).split(path.sep).join('/')
    : String(repoCopyRelOrAbs);
  const add = g(repoDir, ['add', '--', rel]);
  if (!add.ok) return { ok: false, error: `git add 失败：${add.err || add.out}` };
  const st = g(repoDir, ['status', '--porcelain', '--', rel]);
  if (!st.ok) return { ok: false, error: `git status 失败：${st.err || st.out}` };
  if (!st.out) return { ok: true, committed: false, reason: 'no-changes' };
  const message = `${stampCompact(now).replace('-', ' ')} ${String(host).toUpperCase()} memory-snapshot (auto)`;
  const c = g(repoDir, ['commit', '-m', message, '--', rel]);
  if (!c.ok) return { ok: false, committed: false, error: (c.err || c.out).slice(0, 300), message };
  return { ok: true, committed: true, message, porcelain: st.out };
}

/** 清理陈旧临时快照（>24h，只删本模块命名规则的文件）。 */
export function sweepStaleSnapshots(tmpDir, { now = () => Date.now() } = {}) {
  try {
    if (!fs.existsSync(tmpDir)) return 0;
    const cutoff = now() - 24 * 3600 * 1000;
    let n = 0;
    for (const f of fs.readdirSync(tmpDir)) {
      if (!/^memory-\d{8}-\d{6}\.db$/.test(f)) continue;
      const full = path.join(tmpDir, f);
      try { if (fs.statSync(full).mtimeMs < cutoff && removeGuarded(full, { whitelist: [tmpDir], reason: '陈旧临时快照清理' })) n++; } catch { /* ignore */ }
    }
    return n;
  } catch { return 0; }
}

/** 状态文件写入（每轮必写；失败/让路可见的第一现场）。 */
export function stampState(cur, { out, host }) {
  const prev = cur ?? {};
  const entry = {
    at: out.finishedAt ?? new Date().toISOString(),
    result: out.result,
    reason: out.decision?.reason ?? out.error ?? null,
    stage: out.lastStage ?? null,
    durationMs: out.durationMs,
    snapshotBytes: out.snapshot?.bytes ?? null,
    snapshotSha: out.snapshot?.sha256 ?? null,
    repoCopySha: out.repo?.afterSha ?? out.repo?.beforeSha ?? null,
    ahead: out.repo?.ahead ?? 0,
    pushed: out.push?.ok === true,
  };
  const history = [...(Array.isArray(prev.history) ? prev.history : []), entry].slice(-30);
  const counter = { ok: 'pushedCount', unchanged: 'unchangedCount', blocked: 'blockedCount', failed: 'failedCount', 'dry-run': 'dryRunCount' }[out.result];
  return {
    ...prev,
    schemaVersion: 1,
    host,
    updatedAt: entry.at,
    version: MEMORY_SNAPSHOT_VERSION,
    lastResult: out.result,
    lastStage: out.lastStage ?? null,
    lastError: out.error ?? null,
    lastReason: out.decision?.reason ?? null,
    lastRunAt: out.startedAt,
    lastFinishedAt: entry.at,
    lastDurationMs: out.durationMs,
    runs: (Number(prev.runs) || 0) + 1,
    ...(counter ? { [counter]: (Number(prev[counter]) || 0) + 1 } : {}),
    vacuumMs: out.snapshot?.vacuumMs ?? prev.vacuumMs ?? null,
    vacuumAttempts: out.snapshot?.vacuumAttempts ?? null,
    snapshotBytes: out.snapshot?.bytes ?? null,
    snapshotSha: out.snapshot?.sha256 ?? null,
    repoCopyBytes: out.repo?.afterBytes ?? out.repo?.beforeBytes ?? null,
    repoCopySha: out.repo?.afterSha ?? out.repo?.beforeSha ?? null,
    contentChanged: out.decision?.action === 'write' ? true : (out.decision ? false : null),
    counts: out.counts?.snapshot ?? null,
    integrityOk: out.integrity?.ok ?? null,
    source: out.source ?? null,
    sourceUnchanged: out.sourceUnchanged ?? null,
    commit: out.commit ?? null,
    push: out.push ?? null,
    deferred: out.deferred.slice(-10),
    alerts: out.alerts.slice(-10),
    lastSnapshotKept: out.snapshot?.keptAt ?? null,
    history,
  };
}
