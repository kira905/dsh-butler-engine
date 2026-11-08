#!/usr/bin/env node
// dsh-butler / cold-handoff.mjs —— 「冷接机」编排器（P9 §5.1 / §17.1 T2 · 2026-09-16）
//
// ── 这是什么 ──────────────────────────────────────────────────────────────────
// 「冷接机」= **DSH 已停 + 写者已被冻结** 的窗口里，做跨机**语义合并**（坑库 / 记忆库 /
//   看板快照）并留下可核对证据的那一套动作。它**不是**第二套接头器 —— 接机的拉取 / 会话落地 /
//   分发仍然全部归 `handoff.mjs`（本工具不重复实现，`--with-arrive` 只是原样把它叫起来）。
//
// ── 为什么需要它（现场事实，别凭记忆）─────────────────────────────────────────
//   ① 记忆库合并窗口（§4.3）= 「DSH 未运行 + `memory.db-wal` 为空」。开机钩子的 Arrive 跑在
//      `guard-ctl start` 之前，窗口天然满足；但**手工接机**（人先开机进了 GUI 再跑 Arrive）
//      一定不满足 → 记忆库合并每轮静默跳过（H2 文档 §11 待观察第 2 条）。
//   ② 坑库的写者是 **tickd 常驻进程**驱动的 `pitfall` job，**DSH 停了它不停**（§17.1 T2）。
//      所以「DSH 停止」≠「无写者」。H2 已有护栏（抢 `tick-p4-pitfall.lock`）挡并发，
//      但那是"抢不到就跳过"的**兜底拒合并**，不是"保证能合"。
//   ③ 热采 `hot` job 每 30 分钟会**写仓1 工作副本**（`hot-collect.mjs`），与合并的
//      "对端来源"是同一份数据 → 需要同一个互斥语义把它挡在窗外（它抢的是 `tick-handoff.lock`）。
//
// ── 冻结 = drain（杜绝新动作），不是 kill ─────────────────────────────────────
//   冻结手段 = **抢写者自己那把锁**（不是杀进程、不是改 job 开关配置）：
//     · `tick-p4-pitfall.lock`（TTL 10min 的 tick 锁）→ `pitfall-tick.mjs` 本轮
//        `acquireTickLock(TICK_NAME)` 失败 → `{ok:false, skipped:'locked'}` **静默跳过整轮**，
//        **不排队、不并发**（这就是 drain：它那一轮的动作根本没开始）。
//     · `tick-handoff.lock`（TTL 45min）→ `hot-collect.mjs` 启动即抢同一把锁、抢不到就
//       打印「交接窗口被占用 → 本轮热采跳过」并退出。
//   两把锁都**不写生产配置**（`butler-autonomy.json` 一个字节都不动），进程异常退出由 TTL 兜底。
//
// ── 本卡硬约束（原样遵守）────────────────────────────────────────────────────
//   · ❌ 不新增/修改任何 `dsh-shutdown` 关机链 —— 本工具是**独立 CLI**，谁都不 hook。
//   · ❌ 不使用镜像语义（`/MIR` / `--delete` / `rsync --delete`）。
//   · ❌ 不做两台对等写同一批单文件；不把 DSH 改成监听 `0.0.0.0`。
//   · ✅ 合并器**只加不减**；任一环节失败一律 **fail-open**（记账 + 继续，绝不阻塞接机）。
//   · ✅ 任何写操作前留备份/快照；危险步骤全部可 `--dry-run` 预览；**默认就是 dry-run**。
//
// ── 用法 ─────────────────────────────────────────────────────────────────────
//   node tools/dsh-butler/cold-handoff.mjs --status            # 只读：窗口体检
//   node tools/dsh-butler/cold-handoff.mjs --dry-run           # 默认：冻结→合并→验证 全流程演练（零写入）
//   node tools/dsh-butler/cold-handoff.mjs --apply             # 真做（抢锁 + 合并坑库/记忆库 + 账本快照导出）
//   node tools/dsh-butler/cold-handoff.mjs --apply --only pitfall
//   node tools/dsh-butler/cold-handoff.mjs --hold              # 只冻住写者并**原地续租**（Ctrl-C 解冻）
//   node tools/dsh-butler/cold-handoff.mjs --thaw              # 解除冻结（释放本工具持有的锁）
//   node tools/dsh-butler/cold-handoff.mjs --apply --with-arrive   # 合并后再跑一次完整 Arrive
//   node tools/dsh-butler/cold-handoff.mjs --status --json
//
// 退出码：0 成功（含"跳过但无风险"）· 2 用法错 · 3 前置门未过（窗口不可用）· 4 有步骤失败（fail-open 已记账）
//
// ── 与既有件的关系（不造第二份真相）──────────────────────────────────────────
//   · 单写者判据：`lib/single-writer.mjs`（`probePitfallWriter` / `acquirePitfallGuard` /
//     `judgeMemoryWindow` / `memoryWalBytes`） —— **本工具不自己写一套探测**。
//   · 锁：`lib/store.mjs#acquireTickLock`（真实锁；**显式 env:{}**，绝不吃继承虚拟锁）。
//   · 合并：`merge-pitfalls.mjs` / `merge-memory.mjs`（生产 CLI，不复制逻辑）。
//   · 接机本体：`handoff.mjs`（`--with-arrive` 原样调用）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { acquireTickLock, readJson, writeJsonAtomic, writeTextAtomic } from './lib/store.mjs';
import { writeStateText } from './lib/dual-write.mjs';
import { dshHome, butlerPaths } from './lib/paths.mjs';
import { dshRoot, repoRoot, selfBase } from '../lib/host-config.mjs';
import { resolveStatePath } from './lib/state-paths.mjs';
import {
  PITFALL_TICK_NAME,
  PITFALLS_BASENAME,
  CANDIDATES_BASENAME,
  probePitfallWriter,
  judgeMemoryWindow,
  memoryWalBytes,
  pendingAtomicWrite,
  isPidAlive,
  TICKD_STALE_MS,
} from './lib/single-writer.mjs';

export const COLD_HANDOFF_VERSION = '1.0.0';

const DSH_ROOT = process.env.DSH_ROOT || dshRoot();
const BUTLER_DIR = path.join(DSH_ROOT, 'tools', 'dsh-butler');
const ARCHIVE_ROOT = process.env.BUTLER_HANDOFF_ARCHIVE || path.join(DSH_ROOT, '_archive');
const GIT_BACKUP = process.env.DSH_GIT_BACKUP || repoRoot();

/** 默认对端来源 = 仓1 工作副本（Depart 冷采写进去、pull 后在本机就位）。 */
const DEFAULT_FROM = path.join(GIT_BACKUP, 'dsh-core');

/** 【2c-B3】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, home) {
  return resolveStatePath(name, { home: home ?? dshHome() }).path;
}
/** 本工具的运行键（`sync:false` 本机视角；登记见 lib/state-files.mjs 同名条目）。 */
const RUNKEY_NAME = 'butler-cold-handoff.json';

/** 两把写者锁 —— 抢到即冻结，TTL 兜底（进程被 /F 强杀也不会永久冻住）。 */
const LOCKS = [
  { name: PITFALL_TICK_NAME, ttlMs: 600_000, role: '坑库写者（pitfall tick）', why: 'pitfall-tick.mjs 每轮开头抢它；抢不到即 skipped:locked（不排队、不并发）' },
  { name: 'handoff', ttlMs: 45 * 60 * 1000, role: '热采（hot job）', why: 'hot-collect.mjs 抢同一把锁；抢不到即「本轮热采跳过」' },
];

/** 记忆库 WAL 容忍值（与 single-writer 同口径：>0 即疑似有未落盘事务）。 */
const MEMORY_WAL_TOLERANCE_BYTES = 0;

/** 官方出网权威时刻（与 handoff 的时钟门同款口径，用于负向偏差告警）。 */
const SELF_BASE = selfBase();

// ---------------------------------------------------------------- 小工具

const colored = process.stdout.isTTY;
const paint = (s, c) => (colored ? `\u001b[${c}m${s}\u001b[0m` : s);
const green = (s) => paint(s, '32');
const yellow = (s) => paint(s, '33');
const red = (s) => paint(s, '31');
const dim = (s) => paint(s, '2');

const OUT = { lines: [], json: null };
function log(msg = '') { OUT.lines.push(msg); }
function section(title) { log(''); log(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`); }
function info(msg) { log(`  ·  ${msg}`); }
function ok(msg) { log(`  ${green('OK')} ${msg}`); }
function warn(msg) { log(`  ${yellow('!!')} ${msg}`); }
function bad(msg) { log(`  ${red('XX')} ${msg}`); }
function skip(msg) { log(`  ${dim('--')} ${msg}`); }

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}
function statSafe(file) {
  try { const s = fs.statSync(file); return { bytes: s.size, mtimeMs: s.mtimeMs }; } catch { return null; }
}
function mb(n) { return Number.isFinite(n) ? `${(n / 1048576).toFixed(2)}MB` : 'n/a'; }
function tsStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function iso(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
function ageText(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

/** DSH 是否在跑（3080 是否有 LISTENING；`handoff.mjs#dshRunning` 同款判据）。
 *
 *  ⚠️ 只给**沙箱/隔离测试**用的旁路开关（生产一律不设）：
 *    `DSH_COLD_ASSUME_DSH_STOPPED=1` 把判据钉成"已停"。
 *    没有它，隔离测试**在本机 DSH 正在跑的时候永远走不到合并分支**（窗口门会如实拦住），
 *    于是合并路径根本没被测到。**危险**：真用它等于对"DSH 还在跑"的记忆库做合并 ——
 *    只在沙箱 home（`--home`/`BUTLER_DSH_HOME` 指向隔离目录）时才允许开启。
 */
export function dshRunning(env = process.env) {
  if (String(env.DSH_COLD_ASSUME_DSH_STOPPED ?? '') === '1') return false;
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).some((l) => /:3080\s/.test(l) && /LISTENING/i.test(l));
}

/** 读 tickd 状态（`butler-tickd.mjs --status`；取不到 → null，绝不编）。 */
export function tickdStatus(env = process.env) {
  const script = path.join(BUTLER_DIR, 'butler-tickd.mjs');
  if (!fs.existsSync(script)) return { ok: false, reason: `tickd 脚本不存在（${script}）` };
  const r = spawnSync(process.execPath, [script, '--status'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...env, DSH_TICKD_DIR: env.DSH_TICKD_DIR || path.join(env.TEMP || os.tmpdir(), 'dsh-butler-tickd') },
  });
  if (r.status !== 0) return { ok: false, reason: `tickd --status 退出码 ${r.status}` };
  try {
    const i = String(r.stdout).indexOf('{');
    const j = JSON.parse(String(r.stdout).slice(i));
    const jobs = {};
    for (const job of j.jobs ?? []) jobs[job.id] = job;
    return { ok: true, running: j.running === true, pid: j.pid ?? null, loopCount: j.loopCount ?? null, blocked: j.switches?.blocked ?? [], jobs };
  } catch (e) { return { ok: false, reason: `tickd --status 解析失败：${e?.message ?? e}` }; }
}

/** 库文件快照（sha256 + 字节 + mtime + 条目数 + Σcount）。 */
function pitfallsSnapshot(home) {
  const file = path.join(home, PITFALLS_BASENAME);
  const cand = path.join(home, CANDIDATES_BASENAME);
  const out = { file, exists: fs.existsSync(file), sha256: sha256File(file), ...(statSafe(file) ?? {}) };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j.entries) ? j.entries : (Array.isArray(j.pitfalls) ? j.pitfalls : []));
    out.entries = list.length;
    out.sumCount = list.reduce((a, e) => a + (Number(e?.count) || 0), 0);
  } catch { out.entries = null; out.sumCount = null; }
  out.candidates = { file: cand, exists: fs.existsSync(cand), sha256: sha256File(cand), ...(statSafe(cand) ?? {}) };
  try {
    const j = JSON.parse(fs.readFileSync(cand, 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j.entries) ? j.entries : []);
    out.candidates.entries = list.length;
    out.candidates.sumCount = list.reduce((a, e) => a + (Number(e?.count) || 0), 0);
  } catch { out.candidates.entries = null; out.candidates.sumCount = null; }
  return out;
}

/** 记忆库文件快照（只做字节级取证 —— **不用 sqlite 打开生产库**，避免留下 -shm/-wal）。 */
function memorySnapshot(home) {
  const file = path.join(home, 'memory', 'memory.db');
  const s = statSafe(file);
  return {
    file, exists: fs.existsSync(file), sha256: sha256File(file), ...(s ?? {}),
    walBytes: memoryWalBytes(file),
    // 条目数只在合并报告里取（合并器会开库，那里才是权威）；这里只给文件级证据。
    rows: null,
  };
}

/** 坑库/热采运行键（写者活动的旁证）。 */
function hotState(home) {
  const file = resolveStatePath('butler-handoff-hot.json', { home }).path;
  const j = readJsonSafe(file);
  return { file, exists: fs.existsSync(file), data: j, mtimeMs: statSafe(file)?.mtimeMs ?? null };
}

function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** 本工具的运行键。 */
export function runKeyPath(home = dshHome()) { return stateFileOf(RUNKEY_NAME, home); }
function readRunKey(home) { return readJsonSafe(runKeyPath(home)) ?? { schemaVersion: 1, device: os.hostname(), windows: [] }; }
function writeRunKey(home, data, { dryRun }) {
  if (dryRun) return false;
  const dw = writeStateText(RUNKEY_NAME, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return true;
}

// ---------------------------------------------------------------- 窗口体检（只读）

/**
 * 只读体检：给出「窗口是否可用」的逐条判据 + 证据。
 * **不写任何文件、不抢任何锁**（`--status` 与 `--dry-run` 共用它）。
 * @returns {{ok:boolean, blockers:string[], warnings:string[], details:object}}
 */
export function inspectWindow(opts = {}) {
  const home = opts.home ?? dshHome();
  const env = opts.env ?? process.env;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const blockers = [];
  const warnings = [];

  // ① DSH 进程（记忆库窗口的第一判据）
  const running = opts.dshRunning !== undefined ? opts.dshRunning : dshRunning(env);
  const walBytes = memoryWalBytes(path.join(home, 'memory', 'memory.db'));

  // ② 坑库写者探测（只读；live-single-writer 的辅助判据原样复用）
  const probe = probePitfallWriter({ home, env, now });

  // ③ tickd（写者的宿主）与两个相关 job 的开关/运行态
  const tickd = opts.tickdStatus !== undefined ? opts.tickdStatus : tickdStatus(env);
  const jobPitfall = tickd.ok ? tickd.jobs?.pitfall ?? null : null;
  const jobHot = tickd.ok ? tickd.jobs?.hot ?? null : null;

  // ④ 热采锁（tick-handoff.lock）+ 运行键时间（写者旁证）
  const handoffLockPath = path.join(butlerPaths(home).locks, 'tick-handoff.lock');
  const handoffLock = readJsonSafe(handoffLockPath);
  const hot = hotState(home);

  // ⑤ 原子写临时文件（正在写库的直接证据）
  const pending = pendingAtomicWrite(home, PITFALLS_BASENAME);

  // ⑥ 记忆库窗口判据（复用 single-writer 的口径，不自己发明）
  const memWindow = judgeMemoryWindow({ dshRunning: running === true, walBytes });

  // ── 阻塞项（窗口不可用）────────────────────────────────────────────────────
  if (running === true) {
    blockers.push('DSH 正在运行（3080 有 LISTENING）→ 记忆库合并的窗口不成立（§4.3：只在 DSH 停止时执行）');
  }
  if (pending.length) {
    blockers.push(`存在坑库原子写临时文件（${pending.map((p) => path.basename(p)).join(', ')}）→ 有写者正在写库，等一下再跑`);
  }
  if (handoffLock && isPidAlive(handoffLock.pid) && now - Number(handoffLock.startedAt ?? 0) < Number(handoffLock.ttl ?? 0)) {
    blockers.push(`tick-handoff.lock 被持有且新鲜（pid ${handoffLock.pid}）→ 有交接/热采正在跑（很可能就是你自己，或另一次接机）`);
  }

  // ── 告警项（能跑但要知道）──────────────────────────────────────────────────
  if (probe.details.lockExists && probe.details.lockPidAlive && probe.details.lockFresh) {
    warnings.push(`坑库 tick 锁当前被持有（pid ${probe.details.lockPid}，age ${ageText(probe.details.lockAgeMs)}）→ 抢锁会失败（等这一轮跑完再试）`);
  }
  if (jobPitfall && jobPitfall.running === true) warnings.push('tickd 记 pitfall job running=true → 这一轮正在跑');
  if (jobHot && jobHot.running === true) warnings.push('tickd 记 hot job running=true → 热采正在跑');
  if (tickd.ok && tickd.running === false) warnings.push('tickd 常驻进程未运行（--status 报 not running）→ 本轮无 tickd 写者，但 kill 过 tickd 的情况要留意');
  if (!tickd.ok) warnings.push(`tickd 状态取不到（${tickd.reason}）→ 只能靠锁与临时文件判写者`);
  if (jobPitfall && jobPitfall.enabled === false) warnings.push('pitfall job 开关已关（job off）→ 不用冻结也不会写；本工具仍会抢锁做互斥证明');
  if (jobHot && jobHot.enabled === false) warnings.push('hot job 开关已关（job off）');
  if (walBytes === null) warnings.push('memory.db-wal 读不到（ENOENT 之外的错误）→ 窗口判据降级为"只看 DSH 是否在跑"');
  else if (walBytes > MEMORY_WAL_TOLERANCE_BYTES) warnings.push(`memory.db-wal 非空（${walBytes} 字节）→ 疑似有未落盘事务`);
  if (hot.mtimeMs) {
    const age = now - hot.mtimeMs;
    if (age < 10 * 60 * 1000) warnings.push(`热采运行键刚被写过（${ageText(age)} 前）→ 热采可能刚落过，留意工作副本新鲜度`);
  }

  return {
    ok: blockers.length === 0,
    blockers, warnings,
    details: {
      home, dshRunning: running, walBytes, memWindow,
      lock: { path: probe.details.lockPath, exists: probe.details.lockExists, pid: probe.details.lockPid, alive: probe.details.lockPidAlive, ageMs: probe.details.lockAgeMs, ttlMs: probe.details.lockTtlMs, fresh: probe.details.lockFresh ?? false },
      probe,
      tickd: { ok: tickd.ok, running: tickd.ok ? tickd.running : null, pid: tickd.ok ? tickd.pid : null, blocked: tickd.ok ? tickd.blocked : [], jobPitfall: jobPitfall ? { enabled: jobPitfall.enabled, running: jobPitfall.running, lastEndAt: jobPitfall.lastEndAt, failures: jobPitfall.failures } : null, jobHot: jobHot ? { enabled: jobHot.enabled, running: jobHot.running, lastEndAt: jobHot.lastEndAt, failures: jobHot.failures } : null },
      handoffLock: { path: handoffLockPath, exists: !!handoffLock, pid: handoffLock?.pid ?? null, ageMs: handoffLock?.startedAt ? now - Number(handoffLock.startedAt) : null },
      hotState: { file: hot.file, exists: hot.exists, mtimeMs: hot.mtimeMs, lastResult: hot.data?.lastResult ?? null, updatedAt: hot.data?.updatedAt ?? null },
      pendingTempFiles: pending.map((p) => path.basename(p)),
      pitfalls: pitfallsSnapshot(home),
      memory: memorySnapshot(home),
    },
  };
}

// ---------------------------------------------------------------- 冻结 / 解冻

/**
 * 抢两把写者锁 = 冻结。
 * ⚠️ **显式传 `env: {}`**：`acquireTickLock` 在 `DSH_BUTLER_TICK_LOCK_HELD` / `DSH_HANDOFF_LOCK_HELD`
 *    存在时会返回**内存虚拟锁**（零 I/O、不互斥）。冻结必须拿**真实锁**，否则整个流程形同虚设
 *    —— 与 `lib/single-writer.mjs#acquirePitfallGuard` 同一条纪律。
 * @returns {{ok:boolean, held:string[], failed:object[], release:Function, details:object}}
 */
export function freezeWriters(opts = {}) {
  const home = opts.home ?? dshHome();
  const held = [];
  const failed = [];
  const details = {};
  for (const spec of LOCKS) {
    const t0 = Date.now();
    const lock = acquireTickLock(spec.name, { ttlMs: spec.ttlMs, home, env: {}, autoReleaseOnExit: true });
    const waitedMs = Date.now() - t0;
    details[spec.name] = { ok: lock.ok === true, reason: lock.reason ?? null, holder: lock.holder ?? null, lockPath: lock.lockPath, inherit: lock.inherit === true, waitedMs, role: spec.role, ttlMs: spec.ttlMs };
    if (lock.ok) held.push(spec.name);
    else failed.push({ name: spec.name, role: spec.role, reason: lock.reason ?? 'unknown', holder: lock.holder ?? null });
  }
  const releases = [];
  // 抢到几把就返回几把（释放用）；**未抢到的锁不假装持有**。
  const release = () => {
    let n = 0;
    for (const r of releases) { try { if (r() === true) n++; } catch { /* TTL 兜底 */ } }
    return n;
  };
  for (const spec of LOCKS) {
    if (!held.includes(spec.name)) continue;
    // release() 必须"真释放"：重新读锁文件确认自己还是持有者，再删（store 的 release 已幂等）。
    releases.push(makeReleaser(home, spec.name));
  }
  return { ok: failed.length === 0, held, failed, release, details };
}

/** 构造一个真释放函数（读锁文件核对 pid → 删锁；pid 不是自己就不动）。 */
function makeReleaser(home, lockName) {
  const lockPath = path.join(butlerPaths(home).locks, `tick-${lockName}.lock`);
  return () => {
    try {
      const cur = readJsonSafe(lockPath);
      if (!cur || Number(cur.pid) !== process.pid) return null;   // 不是自己的锁 → 不删
      fs.unlinkSync(lockPath);
      return true;
    } catch { return null; }
  };
}

/** 续租（长窗口时维持锁的活性）。 */
function renew(home, lockName) {
  const lockPath = path.join(butlerPaths(home).locks, `tick-${lockName}.lock`);
  try {
    const cur = readJsonSafe(lockPath);
    if (!cur || Number(cur.pid) !== process.pid) return false;
    const next = { ...cur, startedAt: Date.now(), renewedAt: Date.now() };
    fs.writeFileSync(lockPath, JSON.stringify(next), { encoding: 'utf8', flag: 'w' });
    return true;
  } catch { return false; }
}

/** 解除冻结：删掉**本工具创建**的锁（pid 核对；别人的锁绝不碰）。 */
export function thawWriters(opts = {}) {
  const home = opts.home ?? dshHome();
  const out = { released: [], skipped: [] };
  for (const spec of LOCKS) {
    const lockPath = path.join(butlerPaths(home).locks, `tick-${spec.name}.lock`);
    const cur = readJsonSafe(lockPath);
    if (!cur) { out.skipped.push({ name: spec.name, reason: 'no-lock-file' }); continue; }
    if (Number(cur.pid) !== process.pid) { out.skipped.push({ name: spec.name, reason: `held-by-other-pid:${cur.pid}` }); continue; }
    try { fs.unlinkSync(lockPath); out.released.push(spec.name); } catch (e) { out.skipped.push({ name: spec.name, reason: String(e?.code ?? e?.message ?? 'unlink-failed') }); }
  }
  return out;
}

// ---------------------------------------------------------------- 写者冻结的**实证**

/**
 * 写者被冻结的实证（单写者保证的核心证据）。
 *
 * 三层证据，缺一不可：
 *   ① **锁自持**：两把锁文件存在且 pid == 本进程（说明写者抢不到）。
 *   ② **试跑被拒**（**主动实证**，不是"没看到它跑"）：以真实锁环境跑一次
 *      `pitfall-tick.mjs --dry-run --no-render --json` —— 它若拿到锁就会去扫会话（有 I/O 开销），
 *      这里期望它返回 `{ok:false, skipped:'locked'}`。**拿到锁 = 冻结失败**（会立刻解冻并报错）。
 *   ③ **零写入窗口**：冻结前 vs 验证时的库文件 sha256 完全不等于窗口内有任何写入
 *      （合并动作**除外** —— 合并后比对的是"合并后基线"，见 §验证）。
 */
export function proveFrozen(opts = {}) {
  const home = opts.home ?? dshHome();
  const env = opts.env ?? process.env;
  const t0 = Number.isFinite(opts.t0) ? opts.t0 : Date.now();
  const out = { ok: true, checks: [], reasons: [] };

  // ① 锁自持
  for (const spec of LOCKS) {
    const lockPath = path.join(butlerPaths(home).locks, `tick-${spec.name}.lock`);
    const cur = readJsonSafe(lockPath);
    const mine = cur && Number(cur.pid) === process.pid;
    const fresh = mine && (Date.now() - Number(cur.startedAt ?? 0)) < Number(cur.ttl ?? 0);
    out.checks.push({ id: `lock:${spec.name}`, ok: mine === true && fresh, detail: mine ? `锁由本进程持有（pid ${cur.pid}，age ${ageText(Date.now() - Number(cur.startedAt))}，TTL ${ageText(Number(cur.ttl))}）` : (cur ? `锁被 pid ${cur.pid} 持有（不是本进程！）` : '锁文件不存在（未冻结）') });
    if (!(mine && fresh)) { out.ok = false; out.reasons.push(`锁 ${spec.name} 未被本进程持有`); }
  }

  // ② 试跑被拒
  const tick = path.join(BUTLER_DIR, 'pitfall-tick.mjs');
  if (fs.existsSync(tick)) {
    const r = spawnSync(process.execPath, [tick, '--dry-run', '--no-render', '--json'], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
      // 刻意**清掉继承标记**（本进程是持有者，但子进程要走真实抢锁路径才算实证）
      env: { ...env, DSH_BUTLER_TICK_LOCK_HELD: '', DSH_HANDOFF_LOCK_HELD: '' },
    });
    let payload = null;
    try { payload = JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf('{'))); } catch { payload = null; }
    const locked = payload?.skipped === 'locked' || /skipped:\s*locked/.test(`${r.stdout}${r.stderr}`);
    out.checks.push({
      id: 'pitfall-tick-rejected',
      ok: locked === true,
      detail: locked
        ? `pitfall-tick 试跑被自己的锁拒（skipped=locked）→ **写者本轮确实进不来**（dry-run，零写入）`
        : `pitfall-tick 试跑**没有被拒**（exit ${r.status}，skipped=${payload?.skipped ?? 'n/a'}）→ 冻结未生效！`,
    });
    if (!locked) { out.ok = false; out.reasons.push('试跑未被锁拒 → 冻结未生效'); }
  } else {
    out.checks.push({ id: 'pitfall-tick-rejected', ok: false, detail: `pitfall-tick.mjs 不存在（${tick}）→ 无法做"试跑被拒"实证` });
    out.ok = false;
    out.reasons.push('pitfall-tick.mjs 缺失，无法实证');
  }

  // ③ 写入活动旁证（只读探测）
  const probe = probePitfallWriter({ home, env: Object.assign({}, env, { DSH_BUTLER_TICK_LOCK_HELD: '' }), now: Date.now() });
  out.checks.push({
    id: 'probe',
    ok: true,
    detail: `只读探测：tick 锁存在=${probe.details.lockExists} · tickdRunning=${probe.details.tickdRunning} · jobRunning=${probe.details.jobRunning} · 原子写临时文件=${probe.details.pendingTempFiles.length}${probe.reasons.length ? ' ｜ ' + probe.reasons.join('；') : ''}`,
  });
  out.probe = probe;
  out.windowMs = Date.now() - t0;
  return out;
}

// ---------------------------------------------------------------- 合并步骤

/**
 * 合并器 CLI 的**本机目标路径**必须显式下传（2026-09-16 事故修复）。
 *
 * 根因（实测，血泪）：`merge-pitfalls.mjs` / `merge-memory.mjs` 解析"本机目录"用的是
 *   `process.env.USERPROFILE ?? process.env.HOME` + `.dsh`，**不是** `dshHome()` 的
 *   `BUTLER_DSH_HOME > DSH_HOME > homedir` 口径。所以只把 `BUTLER_DSH_HOME` 指向沙箱时，
 *   合并器仍然会把 `<用户目录>\.dsh` 当成本机库 —— 隔离演练会**直接打到生产**。
 * 修法：本工具在 `--apply` 时**显式**下传 `--local` / `--state`（记忆库再加 `--local` 的 db 路径），
 *   让目标路径只由本工具的 `--home` 决定，不再依赖子进程的环境变量口径。
 */
function localArgs(home) {
  const pitfallState = resolveStatePath('butler-pitfalls-merge-state.json', { home }).path;
  return {
    pitfalls: { local: home, state: pitfallState },
    memory: { local: path.join(home, 'memory', 'memory.db'), state: resolveStatePath('butler-memory-merge-state.json', { home }).path },
  };
}

function mergeCli(name) { return path.join(BUTLER_DIR, name); }

/**
 * 调合并器 CLI（`--json` 输出）。失败**绝不抛**（fail-open）。
 * @returns {{ok:boolean, code:number|null, payload:object|null, reason:string|null, durationMs:number, stdoutTail:string}}
 */
function runMergeCli(name, args, { timeoutMs }) {
  const cli = mergeCli(name);
  const t0 = Date.now();
  if (!fs.existsSync(cli)) return { ok: false, code: null, payload: null, reason: `merge-cli-missing:${name}`, durationMs: 0, stdoutTail: '' };
  let r;
  try {
    r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    return { ok: false, code: null, payload: null, reason: `merge-spawn-error:${String(e?.message ?? e).slice(0, 120)}`, durationMs: Date.now() - t0, stdoutTail: '' };
  }
  const durationMs = Date.now() - t0;
  const out = String(r.stdout ?? '');
  const errOut = String(r.stderr ?? '');
  const i = out.indexOf('{');
  let payload = null;
  if (i >= 0) { try { payload = JSON.parse(out.slice(i)); } catch { payload = null; } }
  const tail = `${out}\n${errOut}`.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);
  if (!payload) {
    // 诊断留存（实测教训：`merge-json-unparsed` 只带两行时根本无法归因 —— 子进程是真崩了
    // （libuv 断言 / 未捕获异常）还是输出格式变了，全靠这两份原文分辨）。
    let dumpDir = null;
    try {
      dumpDir = path.join(ARCHIVE_ROOT, 'cold-handoff-subproc-dump');
      fs.mkdirSync(dumpDir, { recursive: true });
      const base = path.join(dumpDir, `${name.replace(/\.mjs$/, '')}-${tsStamp()}-${process.pid}`);
      fs.writeFileSync(`${base}.stdout.txt`, out, 'utf8');
      fs.writeFileSync(`${base}.stderr.txt`, errOut, 'utf8');
      fs.writeFileSync(`${base}.meta.json`, JSON.stringify({ cli: name, args, exitCode: r.status ?? null, signal: r.signal ?? null, errorCode: r.error?.code ?? null, durationMs }, null, 2), 'utf8');
    } catch { /* 留存失败不影响结论 */ }
    return {
      ok: false, code: r.status ?? null, payload: null,
      reason: `merge-json-unparsed:${tail}`,
      durationMs, stdoutTail: tail, timedOut: r.error?.code === 'ETIMEDOUT',
      raw: { stdout: out.slice(-4000), stderr: errOut.slice(-4000) },
      dumpDir,
    };
  }
  return { ok: r.status === 0 && payload.ok !== false, code: r.status ?? 0, payload, reason: null, durationMs, stdoutTail: tail, timedOut: r.error?.code === 'ETIMEDOUT' };
}

/** 从合并器报告里抽"条目数 / Σcount / 插入了多少"。 */
function summarizeMerge(payload) {
  const st = payload?.stats ?? {};
  return {
    localRows: st.localN ?? payload?.local?.rows ?? null,
    remoteRows: st.remoteN ?? null,
    union: st.union ?? null,
    sumLocal: st.sumLocal ?? null,
    sumRemote: st.sumRemote ?? null,
    sumMerged: st.sumMerged ?? null,
    onlyLocal: st.onlyLocal ?? null,
    onlyRemote: st.onlyRemote ?? null,
    both: st.both ?? null,
    conflicts: st.conflicts ?? null,
    inserted: payload?.inserted ?? null,
    autoRenamed: st.autoRenamed ?? null,
    written: payload?.written === true,
    skipped: payload?.idempotency?.skipped === true || payload?.objects?.pitfalls?.skipped === true,
    skipReason: payload?.idempotency?.reason ?? payload?.objects?.pitfalls?.reason ?? null,
    fields: {
      baselineSource: st.baselineSource ?? null,
      remoteCommit: payload?.remoteCommit ?? null,
      remoteCarriesLocal: st.remoteCarriesLocal ?? null,
    },
    warnings: payload?.warnings ?? [],
  };
}

/**
 * 解析 `--from`：可以是仓1 工作副本目录（含 `dsh/`）、也可以是直指 `dsh` 子目录。
 * 返回 `{ok, cliArg, pitfalls, memoryDb, reason}` —— cliArg 是传给合并器 `--from` 的值。
 */
export function resolveFrom(fromPath) {
  const p = path.resolve(fromPath);
  if (!fs.existsSync(p)) return { ok: false, reason: `对端来源不存在：${p}` };
  const candidates = [p, path.join(p, 'dsh')];
  for (const base of candidates) {
    const pf = path.join(base, 'butler-pitfalls.json');
    const mm = path.join(base, 'memory', 'memory.db');
    if (fs.existsSync(pf) || fs.existsSync(mm)) {
      return { ok: true, cliArg: base, pitfalls: pf, memoryDb: mm, reason: null };
    }
  }
  return { ok: false, reason: `${p} 下找不到 butler-pitfalls.json / memory/memory.db（git-crypt 未解锁或还没 Depart 过？）` };
}

/** 解密自检门（§4.3 ③）：坑库须明文 JSON、记忆库须 SQLite 魔数。 */
const SQLITE_MAGIC = 'SQLite format 3\0';
export function checkDecryptGate(peer) {
  const out = { ok: true, reasons: [], pitfalls: 'missing', memory: 'missing' };
  if (peer.pitfalls && fs.existsSync(peer.pitfalls)) {
    let plain = false;
    try { JSON.parse(fs.readFileSync(peer.pitfalls, 'utf8')); plain = true; } catch { plain = false; }
    out.pitfalls = plain ? 'ok' : 'encrypted';
    if (!plain) { out.ok = false; out.reasons.push('坑库副本不是明文 JSON（git-crypt 未解锁？）'); }
  }
  if (peer.memoryDb && fs.existsSync(peer.memoryDb)) {
    let sqlite = false;
    try {
      const fd = fs.openSync(peer.memoryDb, 'r');
      const buf = Buffer.alloc(SQLITE_MAGIC.length);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      sqlite = read === buf.length && buf.toString('latin1') === SQLITE_MAGIC;
    } catch { sqlite = false; }
    out.memory = sqlite ? 'ok' : 'encrypted';
    if (!sqlite) { out.ok = false; out.reasons.push('记忆库副本不是 SQLite（git-crypt 未解锁？）'); }
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

const STEPS = ['freeze', 'pitfall', 'memory', 'board', 'verify'];

function parseArgs(argv) {
  const o = {
    mode: 'run', dryRun: true, json: false, only: null, from: DEFAULT_FROM, home: null,
    withArrive: false, holdMs: 0, reportDir: null, unknown: null, help: false, selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') o.mode = 'status';
    else if (a === '--hold') o.mode = 'hold';
    else if (a === '--thaw') o.mode = 'thaw';
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--apply') o.dryRun = false;
    else if (a === '--json') o.json = true;
    else if (a === '--only') o.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--from') o.from = argv[++i] ?? o.from;
    else if (a === '--home') o.home = argv[++i] ?? null;
    else if (a === '--with-arrive') o.withArrive = true;
    else if (a === '--hold-ms') o.holdMs = Number(argv[++i] ?? 0);
    else if (a === '--report-dir') o.reportDir = argv[++i] ?? null;
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o.unknown = a;
  }
  if (o.only) {
    for (const s of o.only) if (!STEPS.includes(s) && s !== 'all') o.unknown = `--only 未知步骤：${s}（可选：${STEPS.join('/')}）`;
  }
  return o;
}

const USAGE = [
  '冷接机（P9 §5.1 / §17.1 T2）—— DSH 已停 + 写者已冻结的窗口里做跨机语义合并',
  '',
  '用法（**默认 dry-run**，什么都不写）：',
  '  node tools/dsh-butler/cold-handoff.mjs --status           # 只读窗口体检（不抢锁、不写文件）',
  '  node tools/dsh-butler/cold-handoff.mjs --dry-run          # 冻结→合并→验证 全流程演练（零写入）',
  '  node tools/dsh-butler/cold-handoff.mjs --apply            # 真做（抢锁 + 合并坑库/记忆库 + 账本快照导出）',
  '  node tools/dsh-butler/cold-handoff.mjs --apply --only pitfall,memory',
  '  node tools/dsh-butler/cold-handoff.mjs --hold [--hold-ms N] # 只冻住写者并原地续租（Ctrl-C 解冻）',
  '  node tools/dsh-butler/cold-handoff.mjs --thaw             # 解除冻结（只删本进程建的锁）',
  '  node tools/dsh-butler/cold-handoff.mjs --apply --with-arrive  # 合并后再跑一次完整 Arrive（handoff.mjs）',
  '',
  '参数：--from <仓1工作副本>（默认 $BUTLER_REPO_ROOT/dsh-core）· --home <DSH home>（隔离测试用）',
  '      --only all|freeze,pitfall,memory,board,verify · --json · --report-dir <目录> · --self-test',
  '',
  '退出码：0 成功 · 2 用法错 · 3 前置门未过（窗口不可用）· 4 有步骤失败（fail-open 已记账）',
  '',
  '⚠️ 本工具**不 hook 任何关机/启动链**；冻结 = 抢写者自己那把锁（drain），不是 kill、不是改配置。',
].join('\n');

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
  // ⚠️ stderr 一律 ASCII 前缀：Windows 上 pwsh 按系统代码页（GBK）解码 node 的 UTF-8 stderr，
  //    非 ASCII 前缀（❌ 之类）会把流解坏 → 调用方**读到被截断的输出**（实测：调试时整段 stdout 消失）。
  if (o.unknown) { process.stderr.write(`[ERR] ${o.unknown}\n\n${USAGE}\n`); return 2; }
  const home = o.home ? path.resolve(o.home) : dshHome();
  const runKey = readRunKey(home);

  if (o.mode === 'status') return cmdStatus(o, home, runKey);
  if (o.mode === 'thaw') return cmdThaw(o, home, runKey);

  // hold / run / dry-run 共用：体检 → 冻结 → 合并 → 验证 → 解冻
  return cmdRun(o, home, runKey);
}

function header(o, home) {
  // 三种模式的标题要分清：status/hold 不是 dry-run（历史坑：--status 打的是"DRY-RUN（零写入）"，
  //   让人以为跑了合并流程）。
  const title = o.mode === 'status' ? '只读体检（不抢锁、不写文件）'
    : (o.mode === 'hold' ? '冻结守护（写者锁保持持有）'
      : (o.mode === 'thaw' ? '解冻（释放本工具持有的写者锁）' : (o.dryRun ? 'DRY-RUN（零写入）' : 'APPLY（真做）')));
  section(`冷接机 · ${title}`);
  info(`主机 ${os.hostname()} · DSH home ${home}`);
  if (o.mode !== 'thaw') info(`对端来源 --from ${path.resolve(o.from)}`);
  if (o.only) info(`步骤限定 --only ${o.only.join(',')}`);
}

// ---------------------------------------------------------------- --status

function cmdStatus(o, home, runKey) {
  header(o, home);
  section('① 窗口体检（只读：不抢锁、不写文件）');
  const w = inspectWindow({ home });
  const d = w.details;
  info(`DSH 3080 LISTENING：${d.dshRunning === true ? red('是（DSH 在跑）') : (d.dshRunning === false ? green('否（DSH 已停）') : yellow('探测不到'))}`);
  info(`记忆库 WAL：${d.walBytes === null ? yellow('读不到') : `${d.walBytes} 字节`} · 窗口判据 ${d.memWindow.ok ? green('成立') : red('不成立：' + d.memWindow.reasons.join('；'))}`);
  info(`坑库 tick 锁：${d.lock.exists ? `存在（pid ${d.lock.pid}，age ${ageText(d.lock.ageMs)}，${d.lock.fresh ? '新鲜' : '陈旧'}）` : '不存在'} · 原子写临时文件 ${d.pendingTempFiles.length} 个`);
  info(`handoff 锁：${d.handoffLock.exists ? `存在（pid ${d.handoffLock.pid}，age ${ageText(d.handoffLock.ageMs)}）` : '不存在'}`);
  info(`tickd：${d.tickd.ok ? `running=${d.tickd.running} pid=${d.tickd.pid} · pitfall job enabled=${d.tickd.jobPitfall?.enabled} running=${d.tickd.jobPitfall?.running}（last ${d.tickd.jobPitfall?.lastEndAt}）· hot job enabled=${d.tickd.jobHot?.enabled} running=${d.tickd.jobHot?.running}（last ${d.tickd.jobHot?.lastEndAt}）` : yellow(`取不到（${d.tickd.reason ?? 'n/a'}）`)}`);
  info(`热采运行键：${d.hotState.exists ? `${d.hotState.lastResult} @ ${d.hotState.updatedAt}（${ageText(Date.now() - Number(d.hotState.mtimeMs))} 前写的）` : '不存在'}`);

  section('② 库文件现状（只读取证）');
  const p = d.pitfalls;
  info(`坑库 ${path.basename(p.file)}：${p.exists ? `${p.entries} 条 / Σ${p.sumCount} · ${mb(p.bytes)} · sha ${String(p.sha256).slice(0, 16)}` : red('不存在')}`);
  info(`候选池：${p.candidates.exists ? `${p.candidates.entries} 条 / Σ${p.candidates.sumCount} · ${mb(p.candidates.bytes)}` : '不存在'}`);
  info(`记忆库 memory.db：${d.memory.exists ? `${mb(d.memory.bytes)} · sha ${String(d.memory.sha256).slice(0, 16)}（条目数以合并报告为准）` : red('不存在')}`);

  section('③ 对端来源');
  const from = resolveFrom(o.from);
  if (!from.ok) bad(from.reason);
  else {
    info(`解析为 ${from.cliArg}`);
    info(`坑库副本：${fs.existsSync(from.pitfalls) ? '有' : '无'} · 记忆库副本：${fs.existsSync(from.memoryDb) ? '有' : '无'}`);
    const gate = checkDecryptGate(from);
    info(`解密自检门：坑库=${gate.pitfalls} 记忆库=${gate.memory} → ${gate.ok ? green('过') : red('不过：' + gate.reasons.join('；'))}`);
  }

  section('④ 结论');
  if (w.ok) ok('窗口可用：可以跑 `--apply`（DSH 已停、无并发写者迹象、对端来源可解）');
  else for (const b of w.blockers) bad(b);
  for (const x of w.warnings) warn(x);
  const last = (runKey.windows ?? []).slice(-1)[0];
  if (last) info(`上一次冷接机：${last.startedAt} · 模式=${last.mode} · 结果=${last.result} · 产物目录=${last.archiveDir ?? 'n/a'}`);

  if (o.json) OUT.json = { mode: 'status', ok: w.ok, blockers: w.blockers, warnings: w.warnings, details: d, from: { ok: from.ok, reason: from.reason, cliArg: from.cliArg ?? null } };
  return w.ok ? 0 : 3;
}

// ---------------------------------------------------------------- --thaw

function cmdThaw(o, home, runKey) {
  header(o, home);
  const t = thawWriters({ home });
  if (t.released.length) ok(`已解除冻结（删掉本进程创建的锁）：${t.released.join(', ')}`);
  if (t.skipped.length) for (const s of t.skipped) info(`未动 ${s.name}：${s.reason}`);
  if (!t.released.length && !t.skipped.some((s) => s.reason !== 'no-lock-file')) skip('没有本进程持有的写者锁（可能已自然释放/TTL 过期）');
  const applied = (runKey.windows ?? []).slice(-1)[0];
  if (applied) {
    writeRunKey(home, { ...runKey, windows: [...(runKey.windows ?? []).slice(0, -1), { ...applied, thawedAt: new Date().toISOString() }] }, { dryRun: o.dryRun });
    info('运行键已更新 thawedAt（解冻留痕）');
  }
  if (o.json) OUT.json = { mode: 'thaw', ...t };
  return 0;
}

// ---------------------------------------------------------------- --hold / 全流程

function cmdRun(o, home, runKey) {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const archiveDir = o.reportDir ? path.resolve(o.reportDir) : path.join(ARCHIVE_ROOT, `cold-handoff-${tsStamp()}`);
  const result = {
    mode: o.mode === 'hold' ? 'hold' : (o.dryRun ? 'dry-run' : 'apply'),
    startedAt, host: os.hostname(), home, dryRun: o.dryRun, from: null,
    steps: {}, blockers: [], warnings: [], alerts: [], frozen: null, windowMs: null,
    before: null, after: null, reports: {}, archiveDir: null, result: 'ok',
  };
  header(o, home);

  // ── 步骤 0：**隔离自检**（2026-09-16 事故后的硬护栏）────────────────────────
  //   事故：隔离演练只把 BUTLER_DSH_HOME/DSH_HOME 指向沙箱，但合并器内部按 USERPROFILE
  //   解析本机目录 → `--local` 落到生产 `~/.dsh`，156 条坑库被重写成 Σ1410（本机独立观测），
  //   `counters.crossHostMergeNote` 被盖上"跨机合并"字样。虽已从仓1 工作副本恢复（sha 对拍一致），
  //   但这说明"沙箱"必须是**显式声明**的，不能靠调用者自觉。
  //   判据：凡启用"假设 DSH 已停"的测试旁路（`DSH_COLD_ASSUME_DSH_STOPPED=1`），
  //         home 必须**不等于**真实生产 home（`USERPROFILE\.dsh`），否则直接拒跑。
  const assumeStopped = String(process.env.DSH_COLD_ASSUME_DSH_STOPPED ?? '') === '1';
  const realProdHome = path.join(process.env.USERPROFILE || os.homedir(), '.dsh');
  const sameHome = path.resolve(home).toLowerCase() === path.resolve(realProdHome).toLowerCase();
  if (assumeStopped && sameHome) {
    bad('隔离自检失败：DSH_COLD_ASSUME_DSH_STOPPED=1 只能配合**沙箱 home** 使用（当前 home == 生产 home）');
    bad('该旁路会让"DSH 在跑"被当成"已停"，对生产记忆库做合并 —— 拒绝执行（fail-closed，零写入）');
    result.result = 'isolation-refused';
    result.alerts.push({ level: 'alert', code: 'cold-isolation-refused', message: 'DSH_COLD_ASSUME_DSH_STOPPED 与生产 home 同时出现，已拒绝执行' });
    result.windowMs = Date.now() - t0;
    if (o.json) OUT.json = result;
    return 3;
  }
  if (assumeStopped) warn(`测试旁路已启用：DSH_COLD_ASSUME_DSH_STOPPED=1（home=${home} 已确认非生产）`);

  // ── 步骤 0b：体检 ───────────────────────────────────────────────────────────
  section('① 前置体检（只读）');
  const w = inspectWindow({ home });
  result.windowBefore = { ok: w.ok, blockers: w.blockers, warnings: w.warnings };
  result.blockers = w.blockers;
  result.warnings = w.warnings;
  info(`DSH：${w.details.dshRunning === true ? red('在跑（记忆库合并窗口不成立）') : (w.details.dshRunning === false ? green('已停') : yellow('探测不到'))}`);
  info(`坑库：${w.details.pitfalls.entries} 条 / Σ${w.details.pitfalls.sumCount} · ${mb(w.details.pitfalls.bytes)}`);
  info(`记忆库：${mb(w.details.memory.bytes)} · WAL ${w.details.walBytes} 字节`);
  for (const x of w.warnings) warn(x);
  if (!w.ok) {
    for (const b of w.blockers) bad(b);
    bad('前置门未过 → 不进入合并（**不做任何写**）。DSH 在跑时请先停机；写者活跃时等这一轮跑完再试。');
    result.result = 'gate-failed';
    result.windowMs = Date.now() - t0;
    writeRunKeyFor(result, home, runKey, o);
    if (o.json) OUT.json = result;
    return 3;
  }
  const from = resolveFrom(o.from);
  result.from = { arg: path.resolve(o.from), cliArg: from.cliArg ?? null, ok: from.ok, reason: from.reason ?? null };
  if (!from.ok) { bad(from.reason); bad('对端来源不可用 → 不合并（fail-open，不做任何写）'); result.result = 'gate-failed'; writeRunKeyFor(result, home, runKey, o); if (o.json) OUT.json = result; return 3; }
  info(`对端来源：${from.cliArg}`);
  const gate = checkDecryptGate(from);
  if (!gate.ok) { bad(`解密自检门未过：${gate.reasons.join('；')}`); result.result = 'gate-failed'; writeRunKeyFor(result, home, runKey, o); if (o.json) OUT.json = result; return 3; }
  ok(`解密自检门：坑库=${gate.pitfalls} · 记忆库=${gate.memory}`);

  // 采集"冻结前"基线（写者窗口的对照证据）
  const snapBefore = { pitfalls: pitfallsSnapshot(home), memory: memorySnapshot(home), t: Date.now() };
  result.before = snapBefore;

  // ── 步骤 1：冻结写者 ────────────────────────────────────────────────────────
  section('② 冻结写者（抢写者自己的锁 = drain；不 kill、不改配置）');
  const wantFreeze = (o.only ? o.only.includes('freeze') : true);
  let freeze = null;
  if (!wantFreeze) skip('--only 未包含 freeze → 跳过冻结（合并步骤将失去互斥保证，仅排障用）');
  else if (o.dryRun) {
    for (const spec of LOCKS) info(`将抢锁 tick-${spec.name}.lock（TTL ${ageText(spec.ttlMs)}）→ ${spec.role}`);
    info('dry-run：不真的抢锁（--apply 才抢）');
  } else {
    freeze = freezeWriters({ home });
    for (const spec of LOCKS) {
      const d = freeze.details[spec.name];
      if (d.ok) ok(`已持有 tick-${spec.name}.lock（pid ${process.pid}，TTL ${ageText(spec.ttlMs)}）→ ${spec.role} 本轮进不来`);
      else bad(`抢不到 tick-${spec.name}.lock（${d.reason}）→ ${spec.role} 可能正在跑${d.holder ? `（持有者 pid ${d.holder.pid}）` : ''}`);
    }
    result.frozen = { held: freeze.held, failed: freeze.failed, details: freeze.details };
    if (!freeze.ok) {
      // fail-open：把抢到的锁放掉（不假装冻结），有失败就拒合并（铁律：宁可拒，不可赌）
      const rel = freeze.release();
      bad(`冻结不完整（${freeze.failed.map((f) => f.name).join(',')} 抢不到）→ **拒绝合并**并释放已抢到的锁（${rel} 把）；宁可这一轮不合并，也不赌并发。`);
      result.result = 'freeze-failed';
      result.windowMs = Date.now() - t0;
      writeRunKeyFor(result, home, runKey, o);
      if (o.json) OUT.json = result;
      return 4;
    }
    // 冻结实证
    const proof = proveFrozen({ home, t0 });
    result.steps.freezeProof = proof;
    section('②b 冻结实证（单写者保证）');
    for (const c of proof.checks) (c.ok ? ok : bad)(`[${c.id}] ${c.detail}`);
    if (!proof.ok) {
      const rel = freeze.release();
      bad(`冻结实证未过（${proof.reasons.join('；')}）→ 释放锁并放弃本次合并（fail-open，不阻塞接机）`);
      result.result = 'freeze-unproven';
      result.windowMs = Date.now() - t0;
      writeRunKeyFor(result, home, runKey, o);
      if (o.json) OUT.json = result;
      return 4;
    }
  }

  // ── 步骤 2/3/4：合并 ────────────────────────────────────────────────────────
  const steps = {};
  const wantStep = (id) => !o.only || o.only.includes('all') || o.only.includes(id);
  try {
    if (wantStep('pitfall')) steps.pitfall = stepMergePitfall(o, home, from, archiveDir, result);
    else { skip('跳过步骤 pitfall（--only 未包含）'); steps.pitfall = { skipped: true, reason: 'not-selected' }; }

    if (wantStep('memory')) steps.memory = stepMergeMemory(o, home, from, archiveDir, result);
    else { skip('跳过步骤 memory（--only 未包含）'); steps.memory = { skipped: true, reason: 'not-selected' }; }

    if (wantStep('board')) steps.board = stepBoardSnapshot(o, home, archiveDir, result);
    else { skip('跳过步骤 board（--only 未包含）'); steps.board = { skipped: true, reason: 'not-selected' }; }
  } catch (e) {
    bad(`合并步骤异常（已吞，fail-open）：${String(e?.stack ?? e).slice(0, 400)}`);
    result.alerts.push({ level: 'warn', code: 'cold-merge-exception', message: String(e?.message ?? e).slice(0, 200) });
  }
  result.steps = { ...result.steps, ...steps };

  // ── 步骤 5：验证 ────────────────────────────────────────────────────────────
  section('③ 事后核对（合并前 vs 合并后 + 窗口安全）');
  const snapAfter = { pitfalls: pitfallsSnapshot(home), memory: memorySnapshot(home), t: Date.now() };
  result.after = snapAfter;
  const verify = buildVerify({ snapBefore, snapAfter, steps, result });
  result.verify = verify;
  printVerify(verify);
  if (verify.holdForever) {
    warn('--hold 模式：写者锁**保持持有**（本进程会一直续租到 Ctrl-C / --hold-ms 到期）—— 期间别关这个窗口');
  }

  // ── 步骤 6：解冻 ────────────────────────────────────────────────────────────
  const holdForever = o.mode === 'hold';
  if (freeze && !holdForever) {
    section('④ 解冻');
    const rel = freeze.release();
    ok(`已释放 ${rel} 把写者锁 → pitfall tick / hot 热采恢复正常节奏（下一轮照跑）`);
    const t2 = thawWriters({ home });
    if (t2.released.length) info(`兜底清理残留锁：${t2.released.join(', ')}`);
  }

  // ── 可选：完整 Arrive ───────────────────────────────────────────────────────
  if (o.withArrive) {
    section('⑤ 完整 Arrive（handoff.mjs，原样调用；不重复实现）');
    if (o.dryRun) skip('dry-run：跳过 --with-arrive（要真跑请加 --apply）');
    else {
      const cli = path.join(BUTLER_DIR, 'handoff.mjs');
      const r = spawnSync(process.execPath, [cli, '--arrive', '--lock-wait-ms', String(o.lockWaitMs ?? 120000)], { encoding: 'utf8', timeout: 360_000, maxBuffer: 256 * 1024 * 1024 });
      const tail = String(r.stdout ?? '').split('\n').filter(Boolean).slice(-6).join('\n');
      log(tail);
      result.steps.arrive = { exitCode: r.status ?? null, timedOut: r.error?.code === 'ETIMEDOUT' };
      if (r.status === 0) ok('Arrive 完成（细节见交接单（状态目录下））');
      else warn(`Arrive 退出码 ${r.status}（fail-open：接机失败不阻塞本机使用，见交接单 alerts/deferred）`);
    }
  }

  // ── 报告落盘 ────────────────────────────────────────────────────────────────
  result.windowMs = Date.now() - t0;
  result.result = result.result === 'ok' && Object.values(result.steps).some((s) => s && s.ok === false) ? 'partial' : result.result;
  section('⑥ 报告');
  const reportPath = writeReport({ o, home, archiveDir, result, verify });
  result.archiveDir = reportPath.dir;
  result.reports = { markdown: reportPath.markdown, json: reportPath.json };
  writeRunKeyFor(result, home, runKey, o);
  if (reportPath.markdown) ok(`报告：${reportPath.markdown}`);
  if (reportPath.json) ok(`结构化：${reportPath.json}`);
  info(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 结论 ${result.result}`);
  if (result.result === 'partial') {
    warn('有步骤失败（fail-open：**不影响接机**，按上面报告的"回滚通道"处置）');
  }

  if (o.json) OUT.json = result;
  return result.result === 'partial' ? 4 : 0;
}

// ---------------------------------------------------------------- 各合并步骤

function stepMergePitfall(o, home, from, archiveDir, result) {
  section('② -1 坑库合并（merge-pitfalls.mjs）');
  const step = { name: 'pitfall', ok: true, skipped: false, written: false, dryRun: o.dryRun, before: null, after: null, summary: null, reason: null, durationMs: 0 };
  step.before = pitfallsSnapshot(home);
  if (!fs.existsSync(from.pitfalls)) {
    step.skipped = true; step.reason = '对端无坑库副本'; skip(step.reason);
    // 幂等门/超集门会跳过 —— 用 CLI 报告如实呈现，但这一层是"文件都没有"，不必调 CLI。
    return step;
  }
  const la = localArgs(home);
  const args = ['--from', from.cliArg, '--local', la.pitfalls.local, '--state', la.pitfalls.state,
    '--json', '--top', '5', '--archive-dir', path.join(archiveDir, 'pitfalls')];
  if (!o.dryRun) args.push('--apply', '--allow-production');
  else args.push('--dry-run');
  info(`命令：node merge-pitfalls.mjs ${args.filter((a) => a !== '--json').join(' ')}`);
  info(`本机目标：--local ${la.pitfalls.local}（显式下传，避免合并器按 USERPROFILE 打到生产）`);
  const t0 = Date.now();
  const r = runMergeCli('merge-pitfalls.mjs', args, { timeoutMs: 120_000 });
  step.durationMs = Date.now() - t0;
  step.ok = r.ok === true;
  step.reason = r.reason;
  if (r.payload) {
    step.summary = summarizeMerge(r.payload);
    step.written = r.payload.written === true;
    const s = step.summary;
    info(`本机 ${s.localRows} 条 / Σ${s.sumLocal} ⊕ 对端 ${s.remoteRows} 条 / Σ${s.sumRemote} → 并集 ${s.union} 条 / **Σmerged ${s.sumMerged}**`);
    info(`四类计数：both ${s.both} / onlyLocal ${s.onlyLocal} / onlyRemote ${s.onlyRemote}（可补入 ${s.inserted}）· 写库=${step.written}${step.summary.skipped ? ` · 幂等跳过（${step.summary.skipReason}）` : ''}`);
    if (s.fields.remoteCarriesLocal !== null && s.fields.remoteCarriesLocal !== undefined) info(`同源旁证：对端 ${s.fields.remoteCarriesLocal} 条标了本机设备（逐设备 max 口径 ⇒ 不双计）`);
    for (const x of s.warnings ?? []) warn(String(x).slice(0, 200));
  } else {
    bad(`坑库合并失败：${r.reason}${r.stdoutTail ? ` ｜ ${r.stdoutTail}` : ''}`);
    if (r.raw) {
      step.raw = r.raw;
      step.dumpDir = r.dumpDir ?? null;
      for (const [k, v] of Object.entries(r.raw)) if (v) for (const ln of String(v).split('\n').filter(Boolean).slice(-4)) log(`      [${k}] ${ln.slice(0, 220)}`);
      if (r.dumpDir) info(`子进程原文已留存：${r.dumpDir}.*`);
    }
  }
  step.after = pitfallsSnapshot(home);
  if (!o.dryRun && step.after.sha256 !== step.before.sha256) ok(`库文件已更新（sha ${String(step.before.sha256).slice(0, 12)} → ${String(step.after.sha256).slice(0, 12)}）`);
  else if (!o.dryRun) info('库文件字节未变（无新增内容 / 幂等跳过，属正常）');
  else info('dry-run：未写盘（库文件应保持零改动）');
  return step;
}

function stepMergeMemory(o, home, from, archiveDir, result) {
  section('② -2 记忆库合并（merge-memory.mjs）');
  const step = { name: 'memory', ok: true, skipped: false, written: false, dryRun: o.dryRun, before: null, after: null, summary: null, reason: null, durationMs: 0 };
  step.before = memorySnapshot(home);
  if (!fs.existsSync(from.memoryDb)) { step.skipped = true; step.reason = '对端无记忆库副本'; skip(step.reason); return step; }
  // 窗口判据（复现 A5b 的口径：DSH 未运行 + WAL 空）
  const running = dshRunning();
  const win = judgeMemoryWindow({ dshRunning: running === true, walBytes: memoryWalBytes(step.before.file) });
  if (!win.ok) {
    step.ok = false; step.skipped = true; step.reason = win.reasons.join('；');
    bad(`记忆库窗口不成立 → 跳过：${step.reason}`);
    result.alerts.push({ level: 'warn', code: 'cold-memory-window', message: `记忆库合并跳过：${step.reason}`.slice(0, 300) });
    return step;
  }
  ok('记忆库窗口成立（DSH 未运行 + WAL 空）');
  const la = localArgs(home);
  const args = ['--from', from.cliArg, '--local', la.memory.local, '--state', la.memory.state,
    '--json', '--top', '5', '--archive-dir', path.join(archiveDir, 'memory')];
  if (!o.dryRun) args.push('--apply', '--allow-production');
  else args.push('--dry-run');
  info(`命令：node merge-memory.mjs ${args.filter((a) => a !== '--json').join(' ')}`);
  info(`本机目标：--local ${la.memory.local}（显式下传，避免合并器按 USERPROFILE 打到生产）`);
  const t0 = Date.now();
  const r = runMergeCli('merge-memory.mjs', args, { timeoutMs: 180_000 });
  step.durationMs = Date.now() - t0;
  step.ok = r.ok === true;
  step.reason = r.reason;
  if (r.payload) {
    step.summary = summarizeMerge(r.payload);
    const s = step.summary;
    info(`本机 ${s.localRows} 条 ⊕ 对端 ${s.remoteRows} 条 → 并集 ${s.union} 条 · 待插入 ${s.inserted} · 自动并存 ${s.autoRenamed ?? 0} · 写库=${step.written}`);
    if (step.summary.skipped) info(`幂等跳过：${step.summary.skipReason}`);
    info(`快照：合并器已 VACUUM INTO 到 ${path.join(archiveDir, 'memory', 'before', 'memory.db')}`);
  } else {
    bad(`记忆库合并失败：${r.reason}${r.stdoutTail ? ` ｜ ${r.stdoutTail}` : ''}`);
    // ⚠️ 严重度说明：合并器是"先写库、后校验"——校验阶段抛异常时**库已被合并**，
    //    只是报告没落盘（实测：夹具缺 memories_fts 表 → `no such table` 崩在 verifyMemoryDb）。
    //    所以这一档必须给出"库可能已变 + 快照在哪"，而不是含糊的"失败"。
    step.severity = 'merge-ran-then-verify-crashed';
    warn('注意：合并器的写库发生在校验之前 —— 这个失败**可能意味着库已经被合并**，只是校验没跑完。');
    info(`合并前快照（可整库回滚）：${path.join(archiveDir, 'memory', 'before', 'memory.db')}`);
    info(`人工复核：node tools/dsh-butler/merge-memory.mjs --from "${from.cliArg}" --local "${path.join(home, 'memory', 'memory.db')}" --dry-run（再跑一次应报 superset/幂等，即库已是最新）`);
    if (r.raw) {
      step.raw = r.raw;
      step.dumpDir = r.dumpDir ?? null;
      for (const [k, v] of Object.entries(r.raw)) if (v) for (const ln of String(v).split('\n').filter(Boolean).slice(-4)) log(`      [${k}] ${ln.slice(0, 220)}`);
      if (r.dumpDir) info(`子进程原文已留存：${r.dumpDir}.*`);
    }
  }
  step.after = memorySnapshot(home);
  if (!o.dryRun && step.after.sha256 !== step.before.sha256) ok(`库文件已更新（sha ${String(step.before.sha256).slice(0, 12)} → ${String(step.after.sha256).slice(0, 12)}）`);
  else if (!o.dryRun) info('库文件字节未变（超集/幂等跳过，属正常）');
  else info('dry-run：未写盘（库文件应保持零改动）');
  return step;
}

/** 看板账本：冷窗口只做**快照导出**（Host API 并回必须 DSH 在跑 → 归热阶段）。 */
function stepBoardSnapshot(o, home, archiveDir, result) {
  section('② -3 看板账本（冷阶段：只导出快照；并回走 Host API 属热阶段）');
  const step = { name: 'board', ok: true, skipped: false, mode: 'snapshot-export', written: false, dryRun: o.dryRun, summary: null, reason: null, durationMs: 0 };
  const ledger = path.join(home, 'task-board', 'ledger-v2.json');
  if (!fs.existsSync(ledger)) { step.skipped = true; step.reason = '账本不存在（未装看板插件？）'; skip(step.reason); return step; }
  const cli = path.join(DSH_ROOT, 'tools', 'board-snapshot-export.mjs');
  if (!fs.existsSync(cli)) { step.ok = false; step.skipped = true; step.reason = `导出器不存在：${cli}`; warn(step.reason); return step; }
  const outDir = path.join(archiveDir, 'board');
  if (o.dryRun) {
    info(`将执行：node board-snapshot-export.mjs --label cold-handoff --out ${outDir}（只读账本、只出快照 JSON）`);
    info('热阶段（DSH 起来之后）：node board-merge.mjs --snapshot <对端快照.json> --dry-run → --apply');
    step.skipped = true; step.reason = 'dry-run（未导出）';
    return step;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cli, '--label', 'cold-handoff', '--out', outDir, '--json'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  step.durationMs = Date.now() - t0;
  // 退出码契约（导出器 §注释）：0 干净出包 / 3 体检命中但已出包（调用方记 deferred） / 1 真失败
  step.exitCode = r.status ?? null;
  if (r.status === 0 || r.status === 3) {
    step.written = true;
    if (r.status === 3) {
      step.ok = true;
      step.reason = '体检命中敏感串但已出包 → 需人工核验';
      warn('快照已生成，但敏感串体检命中（rc=3）→ 交接单纪律要求记 deferred（待人工核验），**不可当失败、也不可静默放行**');
    } else ok('账本快照已导出');
    try {
      const i = String(r.stdout).indexOf('{');
      const j = JSON.parse(String(r.stdout).slice(i));
      step.summary = { file: j.file ?? j.out ?? null, cards: j.cards ?? j.count ?? null, label: j.label ?? null };
      if (step.summary.file) info(`快照：${step.summary.file}${step.summary.cards !== null ? `（${step.summary.cards} 张卡）` : ''}`);
    } catch { /* 报告解析失败不影响结论 */ }
  } else {
    step.ok = false;
    step.reason = `导出器退出码 ${r.status}`;
    bad(`账本快照导出失败（rc=${r.status}）：${String(r.stderr ?? '').slice(0, 200)}`);
  }
  info('热阶段（DSH 启动后）再跑：node board-merge.mjs --snapshot <对端快照> --dry-run → --apply（Host API，绝不手改 ledger）');
  return step;
}

// ---------------------------------------------------------------- 验证

function buildVerify({ snapBefore, snapAfter, steps, result }) {
  const rows = [];
  const b = snapBefore.pitfalls, a = snapAfter.pitfalls;
  rows.push({
    item: '坑库条目数', before: b.entries, after: a.entries,
    delta: (a.entries !== null && b.entries !== null) ? a.entries - b.entries : null,
    verdict: (a.entries !== null && b.entries !== null && a.entries >= b.entries) ? 'only-add（不减）' : (b.entries === null || a.entries === null ? 'n/a' : '⚠ 减少？见下'),
  });
  rows.push({
    item: '坑库 Σcount', before: b.sumCount, after: a.sumCount,
    delta: (a.sumCount !== null && b.sumCount !== null) ? a.sumCount - b.sumCount : null,
    verdict: (a.sumCount !== null && b.sumCount !== null && a.sumCount >= b.sumCount) ? 'only-add（不减）' : 'n/a',
  });
  rows.push({
    item: '坑库 sha256', before: String(b.sha256 ?? '').slice(0, 12), after: String(a.sha256 ?? '').slice(0, 12),
    delta: b.sha256 === a.sha256 ? '未变' : '变化',
    verdict: b.sha256 === a.sha256 ? (result.dryRun ? 'dry-run 期望（零写入）' : '无新增/幂等跳过') : '已写入',
  });
  rows.push({
    item: '候选池 sha256', before: String(b.candidates?.sha256 ?? '').slice(0, 12), after: String(a.candidates?.sha256 ?? '').slice(0, 12),
    delta: b.candidates?.sha256 === a.candidates?.sha256 ? '未变' : '变化',
    verdict: b.candidates?.sha256 === a.candidates?.sha256 ? '未变' : '已写入',
  });
  const mb2 = snapBefore.memory, ma = snapAfter.memory;
  rows.push({
    item: '记忆库 sha256', before: String(mb2.sha256 ?? '').slice(0, 12), after: String(ma.sha256 ?? '').slice(0, 12),
    delta: mb2.sha256 === ma.sha256 ? '未变' : '变化',
    verdict: mb2.sha256 === ma.sha256 ? (result.dryRun ? 'dry-run 期望（零写入）' : (steps.memory?.skipped ? '跳过（窗口/幂等）' : '无缺口')) : '已写入',
  });
  rows.push({
    item: '记忆库条目数', before: steps.memory?.summary?.localRows ?? null, after: steps.memory?.summary?.union ?? null,
    delta: (steps.memory?.summary?.union != null && steps.memory?.summary?.localRows != null) ? steps.memory.summary.union - steps.memory.summary.localRows : null,
    verdict: steps.memory?.skipped ? '未做合并' : '见合并报告（union / inserted）',
  });

  // 窗口安全：dry-run 时"库文件零改动"本身就是"没有第二个写者"的最强证据
  const zeroWrite = (!result.dryRun) || (b.sha256 === a.sha256 && mb2.sha256 === ma.sha256);
  const holdForever = result.mode === 'hold';
  const checks = [
    { id: 'window-gate', ok: result.blockers.length === 0, detail: result.blockers.length ? result.blockers.join('；') : '前置门全过（DSH 状态 / 无并发写者 / 对端可解）' },
    { id: 'freeze-proof', ok: result.dryRun || !result.steps.freezeProof ? true : result.steps.freezeProof.ok === true, detail: result.dryRun ? 'dry-run 未冻结（--apply 才做实证）' : (result.steps.freezeProof ? `${result.steps.freezeProof.checks.length} 项实证` : '未做实证') },
    { id: 'only-add', ok: (b.entries === null || a.entries === null || a.entries >= b.entries) && (b.sumCount === null || a.sumCount === null || a.sumCount >= b.sumCount), detail: '坑库/记忆库合并语义 = 只加不减（本机内容永不删）' },
    { id: 'zero-write-dryrun', ok: zeroWrite, detail: result.dryRun ? 'dry-run 全程零写入（库 sha256 未变 ⇒ 无第二个写者也未误写）' : 'apply 模式（写入由合并器自带备份 + VACUUM 快照兜底）' },
  ];
  return { rows, checks, holdForever, ok: checks.every((c) => c.ok) };
}

function printVerify(v) {
  const w = [12, 16, 16, 10, 26];
  const padEnd = (s, n) => { const t = String(s ?? '-'); return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length); };
  log(`  ${padEnd('项', w[0])}${padEnd('合并前', w[1])}${padEnd('合并后', w[2])}${padEnd('Δ', w[3])}结论`);
  log(`  ${'-'.repeat(w.reduce((a, x) => a + x, 0))}`);
  for (const r of v.rows) log(`  ${padEnd(r.item, w[0])}${padEnd(r.before, w[1])}${padEnd(r.after, w[2])}${padEnd(r.delta, w[3])}${r.verdict}`);
  log('');
  for (const c of v.checks) (c.ok ? ok : bad)(`[${c.id}] ${c.detail}`);
}

// ---------------------------------------------------------------- 报告 / 运行键

function writeReport({ o, home, archiveDir, result, verify }) {
  const out = { dir: null, markdown: null, json: null };
  if (o.dryRun) return out;   // dry-run 不落盘（"零写入"要名副其实）
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    out.dir = archiveDir;
    const lines = [];
    lines.push(`# 冷接机报告（${result.mode}）`);
    lines.push('');
    lines.push(`> 生成：${new Date().toISOString()} · 主机 ${result.host} · DSH home \`${home}\``);
    lines.push(`> 结论：**${result.result}** · 耗时 ${(result.windowMs / 1000).toFixed(1)}s · 对端来源 \`${result.from?.cliArg ?? '-'}\``);
    lines.push('');
    lines.push('## 1. 前置门');
    lines.push('');
    for (const x of result.warnings ?? []) lines.push(`- ⚠ ${x}`);
    lines.push(result.blockers?.length ? result.blockers.map((x) => `- ❌ ${x}`).join('\n') : '- ✅ 无阻塞项（DSH 已停 / 无并发写者 / 对端可解）');
    lines.push('');
    lines.push('## 2. 冻结（drain 语义）');
    lines.push('');
    if (result.frozen) {
      lines.push(`- 已持有：${result.frozen.held.map((h) => `\`tick-${h}.lock\``).join('、')}`);
      for (const [name, d] of Object.entries(result.frozen.details)) lines.push(`  - \`${name}\`：${d.ok ? 'OK' : 'FAIL'} ttl=${d.ttlMs}ms reason=${d.reason ?? '-'}`);
    } else if (!o.dryRun && result.steps?.freezeProof) {
      lines.push(`- 实证：${result.steps.freezeProof.checks.length} 项`);
    } else lines.push('- dry-run：未冻结');
    for (const c of result.steps?.freezeProof?.checks ?? []) lines.push(`  - [${c.ok ? 'OK' : 'XX'}] ${c.id}：${c.detail}`);
    lines.push('');
    lines.push('## 3. 合并步骤');
    lines.push('');
    for (const key of ['pitfall', 'memory', 'board', 'arrive']) {
      const s = result.steps?.[key];
      if (!s) continue;
      lines.push(`### ${key}`);
      lines.push('');
      lines.push(`- ok=${s.ok} skipped=${s.skipped ?? false} written=${s.written ?? false} reason=${s.reason ?? '-'} durationMs=${s.durationMs ?? '-'}`);
      if (s.summary) lines.push(`- 统计：\`${JSON.stringify(s.summary)}\``);
      lines.push('');
    }
    lines.push('## 4. 合并前后对照');
    lines.push('');
    lines.push('| 项 | 合并前 | 合并后 | Δ | 结论 |');
    lines.push('|---|---|---|---|---|');
    for (const r of verify.rows) lines.push(`| ${r.item} | ${r.before ?? '-'} | ${r.after ?? '-'} | ${r.delta ?? '-'} | ${r.verdict} |`);
    lines.push('');
    lines.push('## 5. 验证断言');
    lines.push('');
    for (const c of verify.checks) lines.push(`- ${c.ok ? '✅' : '❌'} \`${c.id}\`：${c.detail}`);
    lines.push('');
    lines.push('## 6. 回滚通道');
    lines.push('');
    lines.push('- 坑库：合并器在 `--archive-dir` 下自留 `before/` 副本 → 直接拷回 `~/.dsh/butler-pitfalls.json`（**先核 sha256**）');
    lines.push('- 记忆库：合并器 `VACUUM INTO` 快照 → `' + path.join(archiveDir, 'memory', 'before', 'memory.db') + '`（DSH 停止时拷回）');
    lines.push('- 运行键：`' + runKeyPath(home) + '`（本工具自己那个）删掉即回到"没跑过冷接机"');
    lines.push('- 未提交任何关机/启动链改动 → 回滚无需重启 DSH');
    lines.push('');
    fs.writeFileSync(path.join(archiveDir, 'report.md'), lines.join('\n'), 'utf8');
    out.markdown = path.join(archiveDir, 'report.md');
    const j = { ...result, verify };
    fs.writeFileSync(path.join(archiveDir, 'report.json'), JSON.stringify(j, null, 2), 'utf8');
    out.json = path.join(archiveDir, 'report.json');
  } catch (e) {
    bad(`报告落盘失败（不影响合并结果）：${String(e?.message ?? e).slice(0, 200)}`);
  }
  return out;
}

function writeRunKeyFor(result, home, runKey, o) {
  if (o.dryRun) return false;
  try {
    const entry = {
      id: randomUUID().slice(0, 8),
      startedAt: result.startedAt, finishedAt: new Date().toISOString(),
      mode: result.mode, result: result.result, host: result.host,
      from: result.from?.cliArg ?? null, archiveDir: result.archiveDir ?? null,
      frozen: result.frozen?.held ?? [], windowMs: result.windowMs,
      steps: Object.fromEntries(Object.entries(result.steps ?? {}).map(([k, v]) => [k, v && typeof v === 'object' ? { ok: v.ok, skipped: v.skipped ?? false, written: v.written ?? false, reason: v.reason ?? null } : v])),
      before: result.before ? { pitfalls: { entries: result.before.pitfalls.entries, sumCount: result.before.pitfalls.sumCount, sha256: result.before.pitfalls.sha256 }, memory: { sha256: result.before.memory.sha256, bytes: result.before.memory.bytes } } : null,
      after: result.after ? { pitfalls: { entries: result.after.pitfalls.entries, sumCount: result.after.pitfalls.sumCount, sha256: result.after.pitfalls.sha256 }, memory: { sha256: result.after.memory.sha256, bytes: result.after.memory.bytes } } : null,
    };
    const windows = [...(runKey.windows ?? []), entry].slice(-20);
    const dw = writeStateText(RUNKEY_NAME, JSON.stringify({ schemaVersion: 1, device: os.hostname(), updatedAt: new Date().toISOString(), windows }, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
    return true;
  } catch (e) {
    warn(`运行键写入失败（不影响结论）：${String(e?.message ?? e).slice(0, 160)}`);
    return false;
  }
}

// ---------------------------------------------------------------- 入口守卫

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    // 【2026-09-16 修】此处曾是 `await import('./_test/test-cold-handoff.mjs')` + `await runSelfTest(...)`：
    //   实测（DSH 在跑 / 沙箱 / 直接 CLI 三种环境一致）该 await **永不 settle** → node 报
    //   `Warning: Detected unsettled top-level await at cold-handoff.mjs:1211` → 进程以 exit 13 退出，
    //   却只打印到「── 1. 沙箱与导入」为止（自检 55 项一项都没跑）。
    //   对照实验证明自检本体是好的：① `node _test/test-cold-handoff.mjs` 直接跑 = 55/55 全绿
    //   ② 外部进程 `await import(CLI)` 再 `await import(test)` 再 `runSelfTest()` = 55/55 全绿（9s）。
    //   ⇒ 只有"CLI 进程内动态导入测试模块"这一跳会死锁（疑 ESM loader + TLA 自引用）。
    //   修法：改成 **spawn 子进程** 跑同一个自检模块（仍只写 %TEMP% 沙箱、不碰生产），
    //   既绕开 loader 死锁，也让自检输出的退出码成为唯一真相。
    const selfScript = fileURLToPath(new URL('./_test/test-cold-handoff.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [selfScript], {
      stdio: 'inherit', timeout: 30 * 60 * 1000, env: process.env,
    });
    if (r?.error) {
      process.stderr.write(`\n[FATAL] 自检子进程启动失败：${r.error.message}\n`);
      process.exitCode = 13;
    } else if (r?.signal) {
      process.stderr.write(`\n[FATAL] 自检子进程被信号终止：${r.signal}${r.timeout ? '（超时）' : ''}\n`);
      process.exitCode = 13;
    } else {
      process.exitCode = typeof r?.status === 'number' ? r.status : 13;
    }
  } else {
    try {
      const code = await main(argv);
      process.exitCode = code;
    } catch (e) {
      process.stderr.write(`\n[FATAL] 冷接机异常：${e?.stack ?? e}\n`);
      process.exitCode = 1;
    } finally {
      // 输出统一在**最后**落 stdout（含 --json 的 `---JSON---` 段）：
      //   main 内部只把行攒进 OUT.lines，避免"日志在管道里还没刷出来、JSON 已经打完了"
      //   这种顺序错乱（实测：CLI 端先读到 JSON，--dry-run 关键行反而缺失）。
      if (OUT.lines.length) process.stdout.write(OUT.lines.join('\n') + '\n');
      if (argv.includes('--json') && OUT.json) process.stdout.write('\n---JSON---\n' + JSON.stringify(OUT.json) + '\n');
    }
  }
}

export { main, STEPS, LOCKS, USAGE };
