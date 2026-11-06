// dsh-butler / lib/audit.mjs —— 审计流水唯一写入口（append-only + 哈希链）
//
// 方案 §6.5：审计流水 ~/.dsh/butler-audit/YYYY-MM.jsonl，持久 + append-only，不可重建 → 必须随<sync-repo>备份。
// 契约：
//   - 单行 JSON（<4KB），fs.appendFileSync 追加（O_APPEND 单行写入原子，不做读改写）
//   - 写失败绝不抛：审计不能反过来拖垮主流程；失败时走 alert 通道并返回 {ok:false}
//   - 不 import butler其他组件（只依赖 paths/alert + 两个零依赖的兄弟模块），避免循环依赖
// P5 增补（哈希链，方案 §4 P5 R·回归）：
//   每条记录带 prev（上一条 hash）+ hash（本条内容 hash，不含 hash 字段）→ butler-audit-verify.mjs 可验完整性。
//   旧记录无这两个字段 → verify 报「链起点」而不报错（向后兼容）。
// P-1 治本（2026-09-23，真源 docs/ §4）：
//   原实现「读尾拿 prev → appendFileSync」两步之间**无互斥** ⇒ dsh 与 tickd 并发写会各自读到同一个
//   尾部 hash，链分叉（09-20 / 09-22 各一次，pid 不同、毫秒同刻）。现在把两步围进**跨进程写锁**
//   （lib/audit-lock.mjs）：锁**拿不到也照样追加**（fail-open，只告警）—— 审计绝不能因为辅助设施
//   故障而丢失；写完再对**文件尾窗口**巡检一次，发现新断点告警一次（lib/audit-chain-watch.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { butlerPaths, ensureDir, monthKey } from './paths.mjs';
import { alert } from './alert.mjs';
import { acquireAppendLock } from './audit-lock.mjs';
import { inspectAuditChain, alertAppendLockFailOpen } from './audit-chain-watch.mjs';

/** 计算一条记录的内容 hash（排除 hash 字段本身）。 */
export function recordHash(rec) {
  const { hash, ...rest } = rec ?? {};
  return createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
}

/** 读文件末尾最后一条记录的 hash（哈希链锚点；读失败返回 null）。 */
function lastHash(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const st = fs.fstatSync(fd);
      const size = Math.min(st.size, 16 * 1024);
      if (size <= 0) return null;
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (!last) return null;
      const rec = JSON.parse(last);
      return typeof rec?.hash === 'string' ? rec.hash : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 追加一行审计。
 * @param {object} entry 审计内容（自动补 at / pid / prev / hash）
 * @param {{home?:string, silent?:boolean, lockWaitMs?:number, lockStaleMs?:number, chainAlert?:boolean}} [opts]
 *   `lockWaitMs` / `lockStaleMs` 供单测压缩等待；`chainAlert:false` 关闭尾部巡检（只用于测试）
 * @returns {{ok:boolean, file:string, hash?:string, error?:string,
 *            lock?:{ok:boolean, mode:string, waitedMs:number},
 *            chain?:{breaks:number, fresh:number, alerted:boolean}}}
 */
export function appendAudit(entry, opts = {}) {
  const p = butlerPaths(opts.home);
  // 时间可注入（2026-10-21 · 主线「V3.0.0 功能面」G 段 R-047）：缺省 = 真实时间（行为零变化）；
  //   传 `opts.now`（毫秒）⇒ 月份文件与 `at` 都按该时刻算 ⇒ 单测能用假时钟精确断言。
  //   不注入时写读口径完全不变（读侧 `auditMonths(now)` 也是同一套月份算法）。
  const nowMs = Number(opts.now ?? NaN);
  const tsMs = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const file = path.join(p.auditDir, `${monthKey(tsMs)}.jsonl`);
  const rec = { at: new Date(tsMs).toISOString(), pid: process.pid, ...entry };
  try {
    ensureDir(p.auditDir);
    // ── RMW 临界区：读尾拿 prev → 追加，两步必须互斥（见文件头 P-1 说明）──────────
    // 锁失败**不阻断**写入：拿不到锁/锁损坏/超时 ⇒ fail-open 照样追加（further below 只告警）。
    const lock = acquireAppendLock(file, { waitMs: opts.lockWaitMs, staleMs: opts.lockStaleMs });
    try {
      rec.prev = lastHash(file);
      rec.hash = recordHash(rec);
      fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    } finally {
      try { lock.release(); } catch { /* 释放失败由 stale/TTL 兜底，不影响写入结果 */ }
    }
    if (!lock.ok) {
      // fail-open 分支：追加已完成（上面的 appendFileSync 没抛），这里只负责"让人知道锁出过问题"。
      alertAppendLockFailOpen(file, lock, { home: opts.home, silent: opts.silent, emit: opts.chainAlert !== false });
    }
    // 链尾巡检（写后立刻做）：新断链 → 告警一次。无断链时零额外 I/O；异常全部吞掉（绝不影响返回值）。
    const chain = inspectAuditChain(file, { home: opts.home, silent: opts.silent, emit: opts.chainAlert !== false });
    return {
      ok: true,
      file,
      hash: rec.hash,
      lock: { ok: lock.ok, mode: lock.mode, waitedMs: lock.waitedMs },
      chain: { breaks: chain?.breaks?.length ?? 0, fresh: chain?.fresh?.length ?? 0, alerted: chain?.alerted === true },
    };
  } catch (e) {
    const error = e?.message ?? String(e);
    alert({ level: 'warn', source: 'butler-audit', message: `审计写入失败: ${error}`, detail: { file } }, { home: opts.home, silent: opts.silent });
    return { ok: false, file, error };
  }
}

/** 读审计尾部（verify / 排障用）。 */
export function tailAudit(limit = 20, opts = {}) {
  const p = butlerPaths(opts.home);
  const file = path.join(p.auditDir, `${monthKey()}.jsonl`);
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}
