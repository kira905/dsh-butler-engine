// dsh-butler / lib/audit-lock.mjs —— 审计追加的跨进程写锁（P-1 治本 · 2026-09-23）
//
// ── 为什么需要（真源 docs/ §4.2）──────────
//   `lib/audit.mjs` 的 `appendAudit()` 是「读文件尾拿 prev → appendFileSync」两步，两步之间**没有互斥**。
//   dsh 进程与 tickd（**独立常驻进程**）同时写时各自读到同一个尾部 hash ⇒ 哈希链分叉：
//     · 2026-09-20T12:49:36.101Z  pid 49056 与 56132 同 4ms 各写一条（两条 prev 同指 4df7f031）
//     · 2026-09-22T04:38:44.817Z  pid 30204 与 53316 同毫秒各写一条（两条 prev 同指 00bca93e）
//   本模块把「读尾 + 追加」围进一把**跨进程互斥**的临界区，让第二个写者等第一名写完再取锚点。
//
// ── 铁律（本模块存在的全部前提）────────────────────────────────────────────────
//   ① **fail-open**：锁拿不到 / 锁损坏 / 等待超时 ⇒ 让调用方**照样追加**，只返回 `ok:false` 由调用方写告警。
//      审计契约是「写失败绝不抛、绝不因为辅助设施故障而丢审计」—— 锁是辅助设施，不能反过来变成审计写失败的原因。
//   ② **绝不抛异常**：任何路径都 catch，最坏返回 `{ok:false, mode:'error'}`。
//   ③ **不用 existsSync + 写**（TOCTOU）：`openSync(lock, 'wx')` 原子创建（与 `store.acquireTickLock` 同口径）。
//   ④ **新鲜锁一律不抢**：刚创建、内容可能还没落盘的锁文件，读方看到空/半截不能判"坏锁"去抢
//      （2026-09-09 十进程压力测试的既有结论：这条踩过，后果是两进程同时持锁 + 丢更新）。
//   ⑤ **坏锁只在够老（> staleMs）时才敢抢**，避免把"正在创建"当成"僵尸"。
//
// ── 为什么刻意不复用 lib/store.mjs 的 acquireTickLock ─────────────────────────
//   `store.mjs` 顶部 `import { appendAudit } from './audit.mjs'`（状态文件原子写要落审计行）⇒
//   audit 反向 import store 会形成**循环依赖**；而且审计是底座，必须能在 store 不可用时独立工作。
//   故本模块**不 import 本目录其它 lib**（除下方 R-065 的 tools\lib 本地共享件外，只 node:fs / node:path），也不 import paths.mjs（路径由调用方给出）。
import fs from 'node:fs';
import path from 'node:path';
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


/** 等锁上限（毫秒）。审计写入本身 <1ms，2s 已远超正常争抢；超时即 fail-open。 */
export const APPEND_LOCK_WAIT_MS = 2000;
/** 锁新鲜度上限：超过它 + 持有者已死（或内容不可解析）才判僵尸并抢占。 */
export const APPEND_LOCK_STALE_MS = 5000;
/** 重试步长（毫秒）。 */
export const APPEND_LOCK_RETRY_MS = 15;
/** 「新鲜窗口」：锁文件比这更年轻就绝不判坏锁（见铁律④）。 */
export const APPEND_LOCK_FRESH_MS = 250;
/** 单次调用最多抢占僵尸锁几次（防 rm 失败导致的死循环）。 */
export const APPEND_LOCK_MAX_TAKEOVERS = 5;

/** 锁文件路径：与审计流水同目录的隐藏文件（`.<月>.jsonl.append.lock`）。 */
export function appendLockPath(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.append.lock`);
}

/** pid 是否存活（kill(pid,0) 语义；EPERM 视为存活）。不依赖 store/single-writer（避免依赖链）。 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** 同步睡眠（不 spin CPU）：Atomics.wait 不可用时退化为忙等兜底。 */
export function sleepSync(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  } catch {
    const end = Date.now() + n;
    while (Date.now() < end) { /* 极端兜底 */ }
  }
}

function readLock(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

/**
 * 抢「审计追加锁」。
 *
 * @param {string} file 审计流水文件绝对路径（锁文件放同目录）
 * @param {{waitMs?:number, staleMs?:number, now?:()=>number}} [opts]
 * @returns {{ok:boolean, mode:'held'|'reentrant'|'timeout'|'error', lockPath:string, waitedMs:number,
 *            error?:string, holder?:object|null, takeovers?:number, release:()=>boolean}}
 *   `ok:true`  = 已持锁（mode=held 或同进程重入 reentrant）；调用方**必须** release()
 *   `ok:false` = **未持锁，但调用方仍应继续追加**（fail-open；mode=timeout/error 供告警归因）
 */
export function acquireAppendLock(file, opts = {}) {
  const lockPath = appendLockPath(file);
  const waitMs = Number.isFinite(Number(opts.waitMs)) ? Number(opts.waitMs) : APPEND_LOCK_WAIT_MS;
  const staleMs = Number.isFinite(Number(opts.staleMs)) ? Number(opts.staleMs) : APPEND_LOCK_STALE_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const t0 = now();
  let takeovers = 0;
  let lastError = null;

  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* 交给 openSync 报错 → fail-open */ }

  // 同进程重入：JS 同步代码不可能真并发，但嵌套调用（如 appendAudit 内部再触发一次）不该被自己的锁
  // 挡住白等 2 秒 —— 直接视为已持锁（不创建第二把锁、release 为 noop）。
  const holder0 = readLock(lockPath);
  if (holder0 && Number(holder0.pid) === process.pid) {
    return { ok: true, mode: 'reentrant', lockPath, waitedMs: 0, release: () => false };
  }

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString(), tool: 'audit-append' }));
      } catch { /* 内容写失败不影响互斥语义（open 已原子占位） */ }
      try { fs.closeSync(fd); } catch { /* 句柄异常不影响锁语义 */ }
      let released = false;
      return {
        ok: true,
        mode: 'held',
        lockPath,
        waitedMs: now() - t0,
        release() {
          if (released) return false;
          released = true;
          try { return removeGuarded(lockPath, { whitelist: [path.dirname(lockPath)], reason: '审计追加锁释放' }); } catch { return false; }
        },
      };
    } catch (e) {
      const code = e?.code;
      // EEXIST = 别人持有；EPERM/EACCES = Windows 上刚被抢占删除的 delete-pending 态（不是"没权限"）
      // ⇒ 两者同等对待，走竞争等待。其余错误码（ENOSPC/EROFS/ENOTDIR…）= 锁设施不可用 → 立刻 fail-open。
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
        return { ok: false, mode: 'error', lockPath, waitedMs: now() - t0, error: e?.message ?? String(e), release: () => false };
      }
      lastError = e?.message ?? String(e);
    }

    const st = statSafe(lockPath);
    if (st) {
      const age = now() - Number(st.mtimeMs ?? 0);
      const holder = readLock(lockPath);
      const dead = Boolean(holder) && Number.isFinite(Number(holder.pid)) && !isPidAlive(Number(holder.pid));
      const badAndOld = !holder && age > APPEND_LOCK_FRESH_MS && age > staleMs;  // 坏锁：够老才敢抢
      const oldAndAlive = Boolean(holder) && age > staleMs;                       // 超期锁：TTL 兜底
      if ((dead || badAndOld || oldAndAlive) && takeovers < APPEND_LOCK_MAX_TAKEOVERS) {
        takeovers += 1;
        try { removeGuarded(lockPath, { whitelist: [path.dirname(lockPath)], reason: '抢占僵尸审计锁' }); } catch { /* 抢不掉就继续等 → 最终 fail-open */ }
        continue;   // 抢完立刻重试
      }
    }
    // 锁文件不存在（持有者刚释放）→ 直接回到循环顶部重试。

    if (now() - t0 >= waitMs) {
      return {
        ok: false, mode: 'timeout', lockPath, waitedMs: now() - t0,
        error: lastError, holder: readLock(lockPath), takeovers, release: () => false,
      };
    }
    sleepSync(Math.max(1, Math.min(APPEND_LOCK_RETRY_MS, waitMs - (now() - t0))));
  }
}

/**
 * 在锁内跑一段同步逻辑（fail-open 安全版：拿不到锁**照样执行 fn**）。
 *
 * 为什么不是「拿不到锁就跳过」：审计是 append-only 的唯一写入口，跳过 = 丢审计行 —— 比断链更糟。
 * @returns {{ok:boolean, lock:object, value:any}}
 */
export function withAppendLock(file, fn, opts = {}) {
  const lock = acquireAppendLock(file, opts);
  try {
    const value = typeof fn === 'function' ? fn(lock) : undefined;
    return { ok: lock.ok, lock, value };
  } finally {
    try { lock.release(); } catch { /* 释放失败由 stale/TTL 兜底 */ }
  }
}

export default {
  APPEND_LOCK_WAIT_MS,
  APPEND_LOCK_STALE_MS,
  APPEND_LOCK_RETRY_MS,
  APPEND_LOCK_FRESH_MS,
  APPEND_LOCK_MAX_TAKEOVERS,
  appendLockPath,
  acquireAppendLock,
  withAppendLock,
  isPidAlive,
  sleepSync,
};
