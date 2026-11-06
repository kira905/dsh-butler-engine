// dsh-butler / lib/store.mjs —— butler-store：butler状态文件读写唯一入口
//
// 契约来源：docs/
//   §3.6.6 并发与原子写契约（三条强制）
//   §5.1   版本策略（schemaVersion 与产品版本解耦；改 schema 必须有 migrate-*.mjs）
//
// 三条强制契约（所有状态文件无例外）：
//   1. 原子写：写同目录临时文件 → fsync → renameSync 覆盖。禁止直接 writeFileSync(目标)。
//      Windows 上目标被占用会 EPERM/EBUSY → 重试 3 次（50/150/400ms）；仍失败 → 保留 .tmp
//      待下次覆盖 + 抛 AtomicWriteError，绝不退化为直接写目标。
//   2. 单例 tick 互斥：acquireTickLock() 用 fs.writeFileSync(lock, data, {flag:'wx'}) 原子创建
//      （禁止 existsSync + 写 的 TOCTOU）；抢不到且未过期 → {ok:false, exitCode:0} 由调用方静默退出；
//      过期 → 抢占 + 记一行审计。
//   3. 读-改-写唯一入口：readJson / updateJson；任何脚本不得自己 JSON.parse(readFileSync(...)) 后写回。
//
// schemaVersion 迁移契约：
//   readJson(file, { schemaVersion }) 发现版本不符 → 在 migrations/ 找
//   migrate-<state名>-v<from>-to-v<to>.cjs（CommonJS，可同步 require）链式迁移；
//   找不到 → 抛 SchemaMismatchError（调用方跳过该模块 + 告警，**不猜不静默降级**）；
//   找到 → 迁移后原子写回 + 审计一行 schema-migrate。
//   迁移脚本导出：module.exports = { from, to, migrate(data) { return newData } }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { MIGRATIONS_DIR, butlerPaths, dshHome, ensureDir } from './paths.mjs';
import { appendAudit } from './audit.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../lib/production-guard.mjs';

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


const require_ = createRequire(import.meta.url);

// ---------------------------------------------------------------- 错误类型

export class StoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** schemaVersion 不匹配且无迁移脚本 → 调用方必须"跳过该模块 + 告警"。 */
export class SchemaMismatchError extends StoreError {
  constructor(file, found, expected, detail) {
    super('SCHEMA_MISMATCH', `状态文件 ${path.basename(file)} schemaVersion=${found} 与期望 ${expected} 不符，且无可用迁移脚本（${detail}）`, { file, found, expected, detail });
    this.name = 'SchemaMismatchError';
  }
}

/** 原子写失败（重试耗尽）——临时文件保留，等待下次覆盖，目标文件保持旧内容完整。 */
export class AtomicWriteError extends StoreError {
  constructor(file, tmp, attempts, cause) {
    super('ATOMIC_WRITE_FAILED', `原子写失败（重试 ${attempts} 次）：${file}（${cause}）；临时文件已保留：${tmp}`, { file, tmp, attempts, cause });
    this.name = 'AtomicWriteError';
  }
}

/** RMW 锁等待超时。 */
export class LockTimeoutError extends StoreError {
  constructor(lockPath, waitMs) {
    super('LOCK_TIMEOUT', `等待状态文件锁超时（${waitMs}ms）：${lockPath}`, { lockPath, waitMs });
    this.name = 'LockTimeoutError';
  }
}

// ---------------------------------------------------------------- 基础工具

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
/** 同步 sleep（短命 tick 脚本里比异步更简单可靠，无 event loop 竞争）。 */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function tmpPathFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const rnd = crypto.randomBytes(4).toString('hex');
  return path.join(dir, `.${base}.${process.pid}.${rnd}.tmp`);
}

function sanitizeLockName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_');
}

function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    if (!raw.trim()) return null;
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 原子写

/**
 * 原子写文本：临时文件 → fsync → renameSync（Windows 占用重试 3 次）。
 * 所有落盘（JSON / JSONL 元数据 / .gitignore 段 / 版本文件）都必须走这里，禁止直写目标。
 * @param {string} file
 * @param {string} text
 * @param {{retryDelaysMs?:number[], hooks?:{beforeRename?:Function}}} [opts]
 * @returns {{ok:true, file:string, bytes:number, attempts:number, tmp:string}}
 */
export function writeTextAtomic(file, text, opts = {}) {
  const retryDelaysMs = opts.retryDelaysMs ?? [50, 150, 400];
  ensureDir(path.dirname(file));
  const tmp = tmpPathFor(file);

  // 1) 写临时文件 + fsync（断电/崩溃也不会留半截目标文件）
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // 测试钩子：在 rename 之前挂起，用于验证"写入中途 kill → 目标仍是旧完整内容"
  if (opts.hooks && typeof opts.hooks.beforeRename === 'function') opts.hooks.beforeRename(tmp, file);

  // 2) rename 覆盖（Windows 目标被占用 → EPERM/EBUSY，重试）
  //   R-065 三件套：原子替换 = 搬移语义，先过闸再进重试环；被拒 ⇒ 抛错（绝不退化为直写目标）
  const pre = gateDestructive({
    targets: [{ path: tmp, label: 'src' }, { path: file, label: 'dst' }], whitelist: [path.dirname(file)], op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse: false, ledgerBypass: false, reason: 'store 原子写替换',
  });
  if (!pre.ok) throw new AtomicWriteError(file, tmp, 0, `R-065 三件套拒绝（${pre.code}）：${String(pre.reason).split('\n')[0]}`);
  let lastErr;
  for (let attempt = 1; attempt <= retryDelaysMs.length + 1; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return { ok: true, file, bytes: Buffer.byteLength(text, 'utf8'), attempts: attempt, tmp };
    } catch (e) {
      lastErr = e;
      if (attempt <= retryDelaysMs.length) sleepSync(retryDelaysMs[attempt - 1]);
    }
  }
  // 3) 绝不退化为直写目标：保留 tmp 抛错（下次写入会覆盖它）
  throw new AtomicWriteError(file, tmp, retryDelaysMs.length + 1, `${lastErr?.code ?? ''} ${lastErr?.message ?? lastErr}`);
}

/**
 * 原子写 JSON（= writeTextAtomic 的 JSON 包装）。
 * @param {string} file
 * @param {any} data
 * @param {{retryDelaysMs?:number[], hooks?:{beforeRename?:Function}}} [opts]
 */
export function writeJsonAtomic(file, data, opts = {}) {
  return writeTextAtomic(file, JSON.stringify(data, null, 2) + '\n', opts);
}

/** 追加一行 JSONL（append-only；单行 <4KB 时 O_APPEND 原子）。 */
export function appendJsonl(file, record) {
  ensureDir(path.dirname(file));
  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line, 'utf8') > 4096) {
    throw new StoreError('LINE_TOO_LONG', `appendJsonl 单行超过 4096 字节（${file}），请拆分记录`);
  }
  fs.appendFileSync(file, line, 'utf8');
  return { ok: true, file, bytes: Buffer.byteLength(line, 'utf8') };
}

// ---------------------------------------------------------------- 读 + schema 迁移

/** 迁移脚本候选（migrate-<stem>-v<from>-to-v<to>.cjs）。 */
function migrationCandidates(file, from, dir) {
  const stem = path.basename(file).replace(/\.(json|jsonl)$/i, '');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.startsWith(`migrate-${stem}-v${from}-to-v`) && n.endsWith('.cjs'))
    .sort();
}

/** 链式解析 from → to 的迁移（支持多级：v1→v2→v3）。 */
function resolveMigrationChain(file, from, to, dir) {
  const chain = [];
  let cur = from;
  for (let guard = 0; cur !== to && guard < 32; guard++) {
    const candidates = migrationCandidates(file, cur, dir);
    if (!candidates.length) break;
    const full = path.join(dir, candidates[0]);
    let mod;
    try {
      mod = require_(full);
    } catch (e) {
      throw new StoreError('MIGRATION_LOAD_FAILED', `迁移脚本加载失败：${full}（${e?.message ?? e}）`, { file: full });
    }
    if (!mod || typeof mod.migrate !== 'function') {
      throw new StoreError('MIGRATION_INVALID', `迁移脚本必须导出 { from, to, migrate(data) }：${full}`, { file: full });
    }
    const next = Number(mod.to ?? NaN);
    if (!Number.isFinite(next) || next <= cur) {
      throw new StoreError('MIGRATION_INVALID', `迁移脚本 to=${mod.to} 必须大于 from（不支持降级，当前 v${cur}）：${full}`, { file: full });
    }
    chain.push({ name: path.basename(full), from: Number(mod.from ?? cur), to: next, migrate: mod.migrate, file: full });
    cur = next;
  }
  return chain;
}

/**
 * 读状态文件（唯一入口）。
 * @param {string} file
 * @param {{
 *   schemaVersion?:number, defaultValue?:any, migrationsDir?:string, home?:string,
 *   audit?:boolean, migrateWrite?:boolean
 * }} [opts]
 * @returns {any} 解析后的数据（文件不存在/空文件 → defaultValue）
 * @throws {SchemaMismatchError} 版本不符且无迁移脚本（调用方跳过该模块 + 告警）
 * @throws {StoreError} JSON 损坏 / 迁移脚本非法
 */
export function readJson(file, opts = {}) {
  const {
    schemaVersion = null,
    defaultValue = null,
    migrationsDir = MIGRATIONS_DIR,
    home = dshHome(),
    audit = true,
    migrateWrite = true,
  } = opts;

  if (!fs.existsSync(file)) return defaultValue;
  const raw = fs.readFileSync(file, 'utf8');
  // 0 字节 / 全空白：视为"尚无状态"，不用损坏路径（DSH 生态踩过空状态文件坑）
  if (!raw.trim()) return defaultValue;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new StoreError('CORRUPT_STATE', `状态文件不是合法 JSON：${file}（${e?.message ?? e}）`, { file });
  }

  if (schemaVersion === null || schemaVersion === undefined) return data;

  const found = Number(data?.schemaVersion ?? 0);
  if (found === schemaVersion) return data;

  const chain = resolveMigrationChain(file, found, schemaVersion, migrationsDir);
  if (!chain.length) {
    throw new SchemaMismatchError(file, found, schemaVersion, `migrationsDir=${migrationsDir}`);
  }
  let out = data;
  for (const step of chain) out = step.migrate(out);
  out = (out && typeof out === 'object') ? { ...out, schemaVersion } : out;
  if (migrateWrite) writeJsonAtomic(file, out, {});
  if (audit) {
    appendAudit({
      type: 'schema-migrate',
      file: path.basename(file),
      from: found,
      to: schemaVersion,
      chain: chain.map((c) => c.name),
    }, { home, silent: true });
  }
  return out;
}

// ---------------------------------------------------------------- 锁
//
// Windows 实测坑（2026-09-09 压力测试 10 进程 × 10 次自增复现，丢更新 1/100）：
//   ① 锁文件刚被创建、内容还没落盘时，读方看到空/半截文件 → 原实现判"坏锁"→ 抢占删除
//      → 两个进程同时持锁 → 读-改-写丢更新。修复：坏锁/空锁只在"文件够老"（> FRESH_LOCK_MS）
//      时才敢抢占；新鲜窗口内一律视为"可能正在创建"。
//   ② 抢占 rmSync 后目标进入 delete-pending 状态，另一进程 open('wx') 会拿到 EPERM（不是 EEXIST）
//      → EPERM/EACCES 必须与 EEXIST 同等对待，走竞争等待路径，绝不外抛。
const CONTENDED_CODES = new Set(['EEXIST', 'EPERM', 'EACCES']);
const FRESH_LOCK_MS = 1500;

function makeRelease(lockPath, data) {
  let released = false;
  return {
    lockPath,
    release() {
      if (released) return false;
      released = true;
      const cur = readLock(lockPath);
      // 只释放自己的锁（防删掉抢占者的锁）。
      // ⚠️ 只比 pid，**不比 startedAt**（2026-09-11 实测修复）：renewTickLock 续租会刷新 startedAt，
      //    原实现拿建锁时的 startedAt 去比 → 续租过的锁永远 release 不掉（长任务必踩）。
      //    防误删仍成立：同一 pid 内同名锁只可能有一个持有者；换 pid 的抢占者不会被删到。
      //    pid 复用（进程退出后 pid 被新进程拿到）风险：即使撞上，也只是删掉一把"恰好同名同 pid"的锁，
      //    而那种情况必然意味着原持有者已退出 → 锁本就该释放。
      if (cur && Number(cur.pid) === Number(data.pid)) {
        try { return removeGuarded(lockPath, { whitelist: [path.dirname(lockPath)], reason: '释放 RMW/tick 锁' }); } catch { return false; }
      }
      return false;
    },
  };
}

/**
 * 通用锁创建（RMW 与 tick 共用一套竞争/抢占语义）。
 * @param {{ttlMs:number, waitMs:number, kind:string, name?:string, target?:string, home:string, audit?:boolean}} opts
 * waitMs <= 0 → 抢不到立即返回（tick 语义：静默退出，不排队不重试）
 */
function createLock(lockPath, data, opts) {
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  let takeovers = 0;
  let lastCode = null;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(data), { flag: 'wx' });
      return { ok: true, stale: takeovers > 0, holder: null, ...makeRelease(lockPath, data) };
    } catch (e) {
      if (!CONTENDED_CODES.has(e?.code)) throw e;
      lastCode = e.code;
    }
    let st = null;
    try { st = fs.statSync(lockPath); } catch { st = null; }
    if (!st) {
      // 锁文件已消失（持有者刚释放）→ 直接重试创建。
      // ⚠️ 这里绝不能做删除动作：删了就会误删"别人刚创建的新锁"，导致双持锁丢更新
      // （2026-09-09 压力测试实测：正是这条路径造成 100 次自增少 1~3）。
      if (++takeovers > 200) return { ok: false, reason: 'thrash', holder: null, stale: false };
      continue;
    }
    const cur = readLock(lockPath);
    const holderAge = cur ? Date.now() - Number(cur.startedAt ?? 0) : null;
    const ttl = Number(cur?.ttl ?? opts.ttlMs);
    const fileAge = Date.now() - st.mtimeMs;
    // 有过期时间戳的锁按 ttl 判；坏锁/空锁按文件新鲜度判（新鲜 = 可能正在写入，只等不抢）
    const stale = cur
      ? (holderAge === null || !Number.isFinite(holderAge) || holderAge > ttl)
      : fileAge > FRESH_LOCK_MS;
    if (stale) {
      if (++takeovers > 50) return { ok: false, reason: 'takeover-thrash', holder: cur, stale: true };
      try { removeGuarded(lockPath, { whitelist: [path.dirname(lockPath)], reason: '抢占过期锁' }); } catch { /* 竞争失败，下一轮再试 */ }
      if (opts.audit !== false) {
        appendAudit({ type: 'lock-takeover', kind: opts.kind, name: opts.name ?? null, target: opts.target ?? null, holder: cur, ageMs: holderAge, fileAgeMs: Math.round(fileAge), errCode: lastCode }, { home: opts.home, silent: true });
      }
      continue; // 立即重试抢锁（不 sleep）
    }
    // 持有者活着
    if (opts.waitMs <= 0) return { ok: false, reason: 'held', holder: cur, stale: false };
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout', holder: cur, stale: false };
    sleepSync(10 + Math.floor(Math.random() * 20));
  }
}

/**
 * RMW 锁（updateJson 内部用）：等待式，临界区短。
 * 过期（age > ttl）→ 抢占 + 审计一行；等待超时 → 抛 LockTimeoutError。
 */
export function acquireRmwLock(file, opts = {}) {
  const home = opts.home ?? dshHome();
  const ttlMs = opts.ttlMs ?? 10_000;
  const waitMs = opts.waitMs ?? 5_000;
  const locksDir = butlerPaths(home).locks;
  ensureDir(locksDir);
  const lockPath = path.join(locksDir, `rmw-${sanitizeLockName(path.basename(file))}.lock`);
  const data = { pid: process.pid, startedAt: Date.now(), ttl: ttlMs, kind: 'rmw', target: path.basename(file) };
  const r = createLock(lockPath, data, { ttlMs, waitMs, kind: 'rmw', target: path.basename(file), home, audit: opts.audit });
  if (!r.ok) {
    if (r.reason === 'timeout') throw new LockTimeoutError(lockPath, waitMs);
    throw new StoreError('LOCK_CONTENTION', `RMW 锁竞争失败（${r.reason}）：${lockPath}`, { lockPath, holder: r.holder });
  }
  return { lockPath, release: r.release, stale: r.stale, holder: r.holder };
}

/**
 * tick 单例互斥锁（方案 §3.6.6 契约 2）。
 *
 * 【T2 锁继承（2026-09-11，§17.1 T2）】常驻调度器 butler-tickd.mjs 以**同一锁名**持真实锁、
 * 再把 tick 脚本 spawn 成子进程。父进程已持锁时，子进程若再抢同一把锁必然失败 →
 * 每个 tick 都会被误判为 locked、永远不执行。为此 tickd 注入环境变量
 * `DSH_BUTLER_TICK_LOCK_HELD=<锁名,...>`，本函数见到自己的锁名在列表里即返回**内存虚拟锁**
 * （零 I/O、不创建锁文件、不写审计）——单机内同一 tick 仍然只有一个实例，且不会双层互斥打架。
 * 手动直跑脚本（无该环境变量）走原路径，行为一字不变。
 * @param {string} name tick 名（如 'p2-watch'）
 * @param {{ttlMs?:number, home?:string, audit?:boolean, env?:Record<string,string|undefined>, waitMs?:number, lockWaitMs?:number}} [opts] ttl 默认 2× 周期，由调用方传
 *   **waitMs / lockWaitMs**（2026-09-14 · H1b drain 语义）：默认 0 = 抢不到立即返回（原 tick 语义，一字不改）。
 *   >0 时阻塞式重试直到拿到锁或超时 —— 只给「关机钩 Depart 撞上热采」这类**必须等它结束、不许并发**的
 *   场景用（§5.3 第 6 条 R12）。⚠️ 别给常态 tick 传它：那会让每个 job 排队等待、拖垮 tick 节奏。
 *   （`lockWaitMs` 是同义别名：`createLock` 的 opts 字段就叫 lockWaitMs，两个名字都收，避免调用方记错。）
 * @returns {{ok:boolean, reason?:string, exitCode?:number, stale?:boolean, holder?:object, lockPath?:string, inherit?:boolean, release:Function}}
 */
export function acquireTickLock(name, opts = {}) {
  const home = opts.home ?? dshHome();
  const ttlMs = opts.ttlMs ?? 120_000;
  const locksDir = butlerPaths(home).locks;
  const lockPath = path.join(locksDir, `tick-${sanitizeLockName(name)}.lock`);

  // ---- T2 锁继承：父调度器（butler-tickd）已持锁 → 虚拟锁，零副作用
  const env = opts.env ?? process.env;
  const held = String(env?.DSH_BUTLER_TICK_LOCK_HELD ?? '');
  const heldDirect = String(env?.DSH_HANDOFF_LOCK_HELD ?? '');
  if (held.split(',').map((s) => s.trim()).filter(Boolean).includes(String(name)) || heldDirect === '1') {
    return {
      ok: true, stale: false, holder: null, lockPath, inherit: true,
      reason: 'inherited-from-parent',
      release: () => false,
    };
  }

  ensureDir(locksDir);
  const data = { pid: process.pid, startedAt: Date.now(), ttl: ttlMs, kind: 'tick', name };
  // waitMs 默认 0（原语义）；>0 用于 drain（等正在跑的热采结束，上限由调用方按剩余预算给）
  const waitMsRaw = Number.isFinite(opts.waitMs) && opts.waitMs > 0 ? opts.waitMs
    : (Number.isFinite(opts.lockWaitMs) && opts.lockWaitMs > 0 ? opts.lockWaitMs : 0);
  const waitMs = waitMsRaw;
  const t0 = Date.now();
  const r = createLock(lockPath, data, { ttlMs, waitMs, kind: 'tick', name, home, audit: opts.audit });
  // drain 自证：等了多久才拿到锁（>100ms 才算"真的等过"，避免把正常路径抖成 waited=true）
  const waitedMs = Date.now() - t0;
  const waited = r.ok && waitedMs > 100 && waitMs > 0;
  if (r.ok) {
    // 【T2 锁泄漏修复（2026-09-11 实测）】短命 tick 脚本普遍是 `acquireTickLock(...) → … → process.exit(0)`
    //   （barewatch-tick.mjs 就是），**从不显式 release**。锁文件于是留到 TTL 过期，下轮只能靠"抢占"拿锁——
    //   实测审计流水每 5 分钟一条 `lock-takeover`（barewatch），且 TTL 窗口内与"锁没放"无法区分。
    //   这里挂一个幂等的进程退出钩子：正常退出（含 process.exit）自动删锁，异常/被 /F 强杀仍由 TTL 兜底。
    if (opts.autoReleaseOnExit !== false) {
      // 让 release 自身幂等：显式 release() 与退出钩子共用一个开关，谁先谁生效、绝不重复删
      const safeRelease = registerExitRelease(lockPath, data, r.release);
      return { ok: true, stale: r.stale, holder: r.holder, lockPath, release: safeRelease, autoRelease: true, waited, waitedMs };
    }
    return { ok: true, stale: r.stale, holder: r.holder, lockPath, release: r.release, waited, waitedMs };
  }
  return { ok: false, reason: r.reason, exitCode: 0, holder: r.holder ?? null, stale: r.stale === true, lockPath, release: () => false, waited: false, waitedMs };
}

/**
 * 进程退出时自动释放 tick 锁（幂等；只删自己创建的那把）。
 * 注意：`process.kill(pid,'SIGKILL')` / taskkill /F 不触发 exit 钩子 → 那种情况由 TTL 与
 * sweepStaleTickLocks 兜底，不在这里处理。
 * @param {string} lockPath
 * @param {{pid:number, startedAt:number}} data
 * @param {Function} release 原 release
 */
function registerExitRelease(lockPath, data, release) {
  let done = false;
  const safeRelease = () => {
    if (done) return false;
    done = true;
    try { return release(); } catch { return false; }
  };
  try {
    process.once('exit', () => { safeRelease(); });
  } catch { /* 注册失败不影响主流程（TTL 兜底） */ }
  return safeRelease;
}

/**
 * 续租 tick 锁（长任务兜底；只续自己的锁，别人抢走了就不动）。
 * @param {string} lockPath
 * @param {{ttlMs:number, holder?:{pid:number, startedAt:number}}} opts holder 缺省 = 本进程
 * @returns {{ok:boolean, reason?:string}}
 */
export function renewTickLock(lockPath, opts = {}) {
  try {
    const cur = readLock(lockPath);
    if (!cur) return { ok: false, reason: 'lock-gone' };
    const me = opts.holder ?? { pid: process.pid };
    if (Number(cur.pid) !== Number(me.pid)) return { ok: false, reason: 'not-holder' };
    const ttl = Number(opts.ttlMs ?? cur.ttl ?? 120_000);
    const next = { ...cur, startedAt: Date.now(), ttl, renewedAt: Date.now() };
    fs.writeFileSync(lockPath, JSON.stringify(next), { encoding: 'utf8', flag: 'w' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.code ?? e?.message ?? 'renew-failed' };
  }
}

/**
 * 清理"已确认死亡"的 tick 锁（调度器冷启动用；staleMs 内不动 —— 防误抢刚建的锁）。
 * @param {{home?:string, staleMs?:number, isAlive?:(pid:number)=>boolean, now?:number}} [opts]
 * @returns {{removed:string[], kept:string[]}}
 */
export function sweepStaleTickLocks(opts = {}) {
  const home = opts.home ?? dshHome();
  const dir = butlerPaths(home).locks;
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? 0; // 0 = 只按"pid 存活 + ttl"判，不看新鲜度
  const isAlive = opts.isAlive ?? defaultPidAlive;
  const removed = [];
  const kept = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { removed, kept }; }
  for (const n of names) {
    if (!/^tick-.*\.lock$/.test(n)) continue;
    const full = path.join(dir, n);
    const cur = readLock(full);
    if (!cur) { kept.push(n); continue; }
    const holderAlive = isAlive(Number(cur.pid));
    const age = now - Number(cur.startedAt ?? 0);
    const expired = !Number.isFinite(age) || age > Number(cur.ttl ?? 120_000);
    const fresh = age < staleMs;
    if (!holderAlive && expired && !fresh) {
      try { if (removeGuarded(full, { whitelist: [dir], reason: '收敛过期 tick 锁' })) { removed.push(n); continue; } } catch { /* 竞争失败留下轮 */ }
    }
    kept.push(n);
  }
  return { removed, kept };
}

function defaultPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

// ---------------------------------------------------------------- 读-改-写

/**
 * 读-改-写唯一入口：加锁 → 读 → 变换 → 原子写 → 解锁。
 * @param {string} file
 * @param {(cur:any)=>(any|undefined)} fn 返回 undefined = 只读事务（不写盘）
 * @param {{schemaVersion?:number, defaultValue?:any, migrationsDir?:string, home?:string,
 *          lockTtlMs?:number, lockWaitMs?:number, audit?:boolean}} [opts]
 * @returns {any} 变换后的值
 */
export function updateJson(file, fn, opts = {}) {
  const lock = acquireRmwLock(file, {
    home: opts.home,
    ttlMs: opts.lockTtlMs ?? 10_000,
    waitMs: opts.lockWaitMs ?? 5_000,
    audit: opts.audit,
  });
  try {
    const cur = readJson(file, opts);
    const next = fn(cur);
    if (next === undefined) return cur;
    writeJsonAtomic(file, next, opts);
    return next;
  } finally {
    lock.release();
  }
}

/** 清理残留的临时文件（人工/收尾用；正常路径下 tmp 会被 rename 或下次覆盖）。 */
export function sweepTempFiles(dir, olderThanMs = 24 * 3600 * 1000) {
  const removed = [];
  if (!fs.existsSync(dir)) return removed;
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    if (!/^\..+\.\d+\.[0-9a-f]{8}\.tmp$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > olderThanMs && removeGuarded(full, { whitelist: [dir], reason: '清理陈旧 tmp' })) removed.push(full);
    } catch { /* 跳过 */ }
  }
  return removed;
}
