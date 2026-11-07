// 2c-B8-1 接线薄封装：把 store 的「读-改-写」语义**原样保留**，只把写目标交给 dual-write。
//
// 为什么需要这一件：`store.updateJson(file, fn, opts)` 内部把 `writeJsonAtomic(file, next, opts)` 写死，
//   调用点没有注入写目标的入口。若在每个调用点展开「锁 + 读 + 变换 + 写」，等于把锁参数复制 N 份
//   （默认值一改就漂移）。本件只做这一层转发，**不新增任何策略**：
//     · 锁  = acquireRmwLock（与 store.updateJson 同一把锁、同一组默认参数）
//     · 读  = readJson（原样透传 opts）
//     · 写  = writeStateText（序列化在调用点只发生一次；原子写实现仍由调用方/store 提供）
//     · 失败 = 与原 updateJson 一致**抛错**（writeStateText 本身不抛，这里把 failures 转成异常）
//
// 口径（读者别猜）：
//   · `name` 必须是**相对名**（如 `butler-queue.json`）—— 写目标由 dual-write 按 mode 计算；
//   · `file` 仍传「读/锁用的绝对路径」（= 调用点原来 resolveStatePath 的结果），读语义零变化；
//   · `home` 缺省取 `path.dirname(file)`（跟随调用点的重定向/夹具 home），不吞成 dshHome()。
import path from 'node:path';
import { acquireRmwLock, readJson, writeTextAtomic } from './store.mjs';
import { writeStateText } from './dual-write.mjs';

/**
 * 与 store.updateJson 等价，只把落盘改走 dual-write。
 * @param {string} name 状态相对名（交给 dual-write；拒绝绝对路径）
 * @param {string} file 读/锁用的绝对路径（调用点原值）
 * @param {(cur:any)=>(any|undefined)} fn 返回 undefined = 只读事务（不写盘）
 * @param {{schemaVersion?:number, defaultValue?:any, migrationsDir?:string, home?:string,
 *          lockTtlMs?:number, lockWaitMs?:number, audit?:boolean}} [opts]
 */
export function updateStateJson(name, file, fn, opts = {}) {
  const home = opts.home ?? path.dirname(file);
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
    const r = writeStateText(name, JSON.stringify(next, null, 2) + '\n', {
      home,
      write: (p, t) => writeTextAtomic(p, t),
    });
    if (!r.ok) {
      const first = r.failures?.[0] ?? {};
      const e = new Error(`双写失败（${r.kind ?? 'unknown'}）：${first.error ?? 'unknown'}`);
      e.code = r.kind ?? 'dual-write-failed';
      e.failures = r.failures ?? [];
      throw e;
    }
    return next;
  } finally {
    lock.release();
  }
}

export default { updateStateJson };
