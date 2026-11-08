// dsh-butler / lib/single-writer.mjs —— 停机窗口「单写者」护栏（P9 §17.1 T2 · H2 接线卡）
//
// ── 为什么需要 ───────────────────────────────────────────────────────────────
// 跨机语义合并器会**覆盖写**本机库文件（`~/.dsh/butler-pitfalls.json` / `memory.db`）。
// 而写者不止一个：
//   · 坑库：P4 的 `pitfall` tick（`pitfall-tick.mjs`）由 **tickd 常驻进程**每 30 分钟驱动 ——
//     tickd 是**独立进程，DSH 停了它不停**，所以「DSH 停止」并不等于「坑库无写者」；
//   · 记忆库：DSH 进程本身（agent 的 memory 工具）+ 手动 memory-db-tools。
// 若合并与 tick 并发，两者都是「读-改-写」→ 后写者覆盖先写者，观测**静默丢失**（正是 H2 要修的病灶）。
//
// ── 口径（本模块只做判据，不做决策）────────────────────────────────────────────
//   ① 主判据 = **tick 单例锁**：`pitfall-tick.mjs` 每轮开头 `acquireTickLock('p4-pitfall')`，
//      抢不到就跳过整轮（`skipped: 'locked'`）。所以**合并侧先抢同一把锁**即可保证：
//        抢到 → 临界区内不可能有第二个写者（tick 会被自己的锁挡在门外，不排队、不并发）；
//        抢不到 → 说明 tick 正在跑 → **拒合并**（宁可拒，不可赌）。
//      旧锁由 store 的 stale 判定处理（pid 死 / TTL 过期），不需要本模块重复实现。
//   ② 辅助判据（只读，用于报告与排障）：tickd 进程存活 + 心跳、`jobs.pitfall.running`、
//      job 开关、库原子写临时文件（`.butler-pitfalls.json.<pid>.<rnd>.tmp`）。
//      这些**不承担判定职责**，只解释「为什么抢不到」。
//   ③ 记忆库另有窗口判据：合并只在 **DSH 未运行**（3080 无监听）且 `memory.db-wal` 为空时执行。
//
// ── 为什么不用「停 job 开关」或「全局静默窗」────────────────────────────────
//   · `butler-autonomy-cli job off pitfall` 停的是**配置**：改它要写生产配置文件 + 落审计，
//     每次 Arrive 都做一次「改配置→恢复」既重又留噪音；且恢复失败会把 job 永久关掉（风险大于收益）。
//   · `dsh-upgrade-silence.mjs --disable` 是**整体静默**（P0 重启闸门 / 队列叫醒 / P2 盯人全停），
//     对「跑 5 秒的合并」代价过大。
//   · 而 tick 锁是 tick 自己的**原生互斥语义**：零配置写入、零副作用、失败自动 TTL 兜底。
//     本模块因此选 (b) 文件级互斥锁（tick 侧写入被拒=跳过本轮），并以 (c)「抢不到即拒合并」兜底。
//
// ── 铁律：**禁止静默并发写** ─────────────────────────────────────────────────
//   任何一步拿不到锁 / 探测不确定 → 返回 ok:false 让调用方**跳过合并并告警**，绝不"差不多就写"。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireTickLock } from './store.mjs';
import { butlerPaths, dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';

export const SINGLE_WRITER_LIB_VERSION = '0.1.0';

/** 坑库写者（P4 tick）的锁名 —— 必须与 `pitfall-tick.mjs` 的 `TICK_NAME` 逐字一致。 */
export const PITFALL_TICK_NAME = 'p4-pitfall';

/** 【2c-B2】坑库 / 候选池路径访问器（消费方 = 定时 tick）。 */
export function pitfallsFilePath(home = dshHome()) { return resolveStatePath(PITFALLS_BASENAME, { home }).path; }
export function candidatesFilePath(home = dshHome()) { return resolveStatePath(CANDIDATES_BASENAME, { home }).path; }
/** 坑库数据文件（合并的目标）。 */
export const PITFALLS_BASENAME = 'butler-pitfalls.json';
/** 候选池（同一次 tick 一并重写，故同一把锁即覆盖）。 */
export const CANDIDATES_BASENAME = 'butler-p4-candidates.json';

/** 合并侧持锁 TTL：远大于一次合并（实测 <10s），又短于 tick 周期（30min）。 */
export const PITFALL_GUARD_TTL_MS = 300_000;
/** 抢锁等待上限（默认 0：不排队，直接拒 —— 排队会把 Arrive 挂住）。 */
export const PITFALL_GUARD_WAIT_MS = 0;
/** tickd 心跳新鲜阈值（与 butler-tickd 的 isRunning 默认一致）。 */
export const TICKD_STALE_MS = 180_000;
/** 记忆库 WAL 允许的残留上限（>0 即说明有未落盘事务 → 疑似 DSH 在写）。 */
export const MEMORY_WAL_TOLERANCE_BYTES = 0;

// ---------------------------------------------------------------- 只读探测

/** pid 是否存活（不依赖杀进程：kill(pid,0) 语义；EPERM 视为存活）。 */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** tickd 状态目录（可用 DSH_TICKD_DIR 覆盖，测试隔离用）。 */
export function tickdDir(env = process.env) {
  return env.DSH_TICKD_DIR || path.join(env.TEMP || os.tmpdir(), 'dsh-butler-tickd');
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 库文件是否有「原子写进行中」的临时文件（`.butler-pitfalls.json.<pid>.<rnd>.tmp`）。 */
export function pendingAtomicWrite(home, basename = PITFALLS_BASENAME) {
  try {
    const dir = home;
    const names = fs.readdirSync(dir).filter((n) => n.startsWith(`.${basename}.`) && n.endsWith('.tmp'));
    return names.map((n) => path.join(dir, n));
  } catch { return []; }
}

/**
 * 坑库写者探测（**只读**，零副作用）。
 * @param {{home?:string, env?:NodeJS.ProcessEnv, now?:number, staleMs?:number}} [opts]
 * @returns {{active:boolean, reasons:string[], details:object}}
 *   `active=true` 只表示「有写者活动的证据」；最终判定以 `acquirePitfallGuard()` 抢锁结果为准。
 */
export function probePitfallWriter(opts = {}) {
  const home = opts.home ?? dshHome();
  const env = opts.env ?? process.env;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : TICKD_STALE_MS;
  const reasons = [];
  const details = {};

  // ① tick 锁（最权威：tick 每轮抢的就是它）
  const lockPath = path.join(butlerPaths(home).locks, `tick-${PITFALL_TICK_NAME}.lock`);
  const lock = readJsonSafe(lockPath);
  details.lockPath = lockPath;
  details.lockExists = fs.existsSync(lockPath);
  details.lockPid = lock?.pid ?? null;
  details.lockPidAlive = lock ? isPidAlive(lock.pid) : false;
  const lockAgeMs = lock?.startedAt ? now - Number(lock.startedAt) : null;
  details.lockAgeMs = lockAgeMs;
  details.lockTtlMs = lock?.ttl ?? null;
  const lockFresh = lockAgeMs !== null && Number.isFinite(Number(lock.ttl)) ? lockAgeMs < Number(lock.ttl) : false;
  if (details.lockExists && details.lockPidAlive && lockFresh) {
    reasons.push(`tick 锁被持有且新鲜（pid ${lock.pid}，age ${Math.round((lockAgeMs ?? 0) / 1000)}s）`);
  }

  // ② tickd 常驻进程（写者的宿主）
  const tdir = tickdDir(env);
  const tlock = readJsonSafe(path.join(tdir, 'lock'));
  details.tickdDir = tdir;
  details.tickdLockPid = tlock?.pid ?? null;
  details.tickdPidAlive = tlock ? isPidAlive(tlock.pid) : false;
  const beat = Number(tlock?.heartbeatAt ?? tlock?.startedAt ?? 0);
  details.tickdHeartbeatAgeMs = beat ? now - beat : null;
  const tickdAlive = details.tickdPidAlive && (beat === 0 || now - beat <= staleMs);
  details.tickdRunning = tickdAlive;

  // ③ tickd 记录的 pitfall job 运行态（内存语义，只作旁证）
  const state = readJsonSafe(path.join(tdir, 'state.json'));
  const jobState = state?.jobs?.['pitfall'] ?? null;
  details.jobRunning = jobState?.running === true;
  details.jobLastRunAt = jobState?.lastRunAt ?? null;
  details.jobLastStatus = jobState?.lastStatus ?? null;
  if (details.jobRunning) reasons.push('tickd state.json 记 pitfall job running=true');

  // ④ 原子写临时文件（正在写库的直接证据）
  const pend = pendingAtomicWrite(home, PITFALLS_BASENAME);
  details.pendingTempFiles = pend.map((p) => path.basename(p));
  if (pend.length) reasons.push(`存在原子写临时文件 ${pend.map((p) => path.basename(p)).join(', ')}`);

  return { active: reasons.length > 0, reasons, details };
}

// ---------------------------------------------------------------- 抢锁（唯一判定）

/**
 * 尝试取得坑库单写者护栏（= 抢 tick 自己那把 `tick-p4-pitfall.lock`）。
 *
 * ⚠️ **显式传 `env:{}`**：`acquireTickLock` 在 `DSH_BUTLER_TICK_LOCK_HELD` / `DSH_HANDOFF_LOCK_HELD`
 *    环境变量下会返回**虚拟锁**（不真正创建锁文件、不互斥）—— 那是给"父调度器已持锁的子进程"用的。
 *    护栏绝不能吃这个继承语义（否则护栏形同虚设），所以这里强制走真实锁。
 *
 * @param {{home?:string, ttlMs?:number, waitMs?:number, now?:number, probe?:object}} [opts]
 * @returns {{ok:boolean, mode:'held'|'busy', reason:string, lockPath:string, waitedMs:number,
 *            probe:object, release:Function}}
 */
export function acquirePitfallGuard(opts = {}) {
  const home = opts.home ?? dshHome();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : PITFALL_GUARD_TTL_MS;
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : PITFALL_GUARD_WAIT_MS;
  const probe = opts.probe ?? probePitfallWriter({ home, now: opts.now });
  const t0 = Date.now();
  const lock = acquireTickLock(PITFALL_TICK_NAME, { ttlMs, waitMs, home, env: {}, autoReleaseOnExit: true });
  const waitedMs = Date.now() - t0;
  if (!lock?.ok) {
    return {
      ok: false, mode: 'busy', waitedMs,
      reason: `抢不到坑库 tick 锁（${lock?.reason ?? 'unknown'}）${probe.reasons.length ? ' · ' + probe.reasons.join('；') : ''}`,
      lockPath: lock?.lockPath ?? path.join(butlerPaths(home).locks, `tick-${PITFALL_TICK_NAME}.lock`),
      holder: lock?.holder ?? null,
      probe,
      release: () => false,
    };
  }
  return {
    ok: true, mode: 'held', waitedMs,
    reason: `已持有坑库 tick 锁（tick 本轮将被拒=跳过，不并发写）${probe.active ? ' · 探测到旁证：' + probe.reasons.join('；') : ''}`,
    lockPath: lock.lockPath,
    inherit: lock.inherit === true,
    probe,
    release: () => { try { return lock.release() === true; } catch { return false; } },
  };
}

// ---------------------------------------------------------------- 记忆库窗口判据

/**
 * 记忆库合并窗口判据（方案 §4.3：**只在 DSH 停止时执行**）。
 * 双判据：① 3080 无监听（DSH 未运行）；② `memory.db-wal` 无残留（无未落盘事务）。
 * @param {{dshRunning?:boolean|null, walBytes?:number|null, tolerance?:number}} [opts]
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function judgeMemoryWindow(opts = {}) {
  const reasons = [];
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : MEMORY_WAL_TOLERANCE_BYTES;
  if (opts.dshRunning === true) reasons.push('DSH 正在运行（3080 监听中）→ 方案 §4.3 要求记忆库合并只在停机窗口做');
  if (Number.isFinite(opts.walBytes) && opts.walBytes > tolerance) {
    reasons.push(`memory.db-wal 非空（${opts.walBytes} 字节）→ 疑似有未落盘事务（DSH 或工具在写）`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** 读 `memory.db-wal` 大小（不存在 → 0；读不到 → null）。 */
export function memoryWalBytes(dbPath) {
  try { return fs.statSync(`${dbPath}-wal`).size; } catch (e) { return e?.code === 'ENOENT' ? 0 : null; }
}

export default {
  SINGLE_WRITER_LIB_VERSION,
  PITFALL_TICK_NAME,
  probePitfallWriter,
  acquirePitfallGuard,
  judgeMemoryWindow,
  memoryWalBytes,
  pendingAtomicWrite,
  isPidAlive,
  tickdDir,
};
