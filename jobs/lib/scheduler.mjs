// dsh-butler / lib/scheduler.mjs —— butler-scheduler：轻量调度器（v2.4 补登记）
//
// 来源：方案 §5 砍单线（审核 §四-17）——P2 tick 被 P3/P4/P7/扩面共同挂载，先落一层轻量调度器
//      再挂功能，否则 P2 自身故障会连带拖垮一半能力。§5.1 组件清单 v2.4 补登记。
//
// 设计原则（轻量，无常驻进程）：
//   - 每个采集器独立注册（register）：一个失败不拖垮其他（单 tick 抛错被隔离）
//   - 统一 tick 契约：run(ctx) 可返回 {ok,detail} / undefined，可抛错；调度器永不 reject
//   - 每个任务执行前抢 tick 锁（butler-store.acquireTickLock）：抢不到 = 静默跳过（exitCode 0 语义）
//   - 记录每次 tick 的耗时 / 状态（内存 ring buffer；需要落盘时传 stateFile，走 butler-store 原子写）
//   - 本模块是被短命 tick 脚本调用的库，**不自己起定时器、不常驻**
//
// 统一 tick 契约：
//   run(ctx) -> void | { ok?:boolean, detail?:any, error?:string } | false
//     ctx = { id, runId, now, log(msg), home, store:{readJson,updateJson,writeJsonAtomic}, audit(entry), alert(entry) }
//     抛错 / 返回 false / 返回 {ok:false} → 记为失败，隔离，不影响其他任务
import { dshHome, newRunId } from '../../src/dsh-butler/lib/paths.mjs';
import { acquireTickLock, readJson, updateJson, writeJsonAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { appendAudit } from '../../src/dsh-butler/lib/audit.mjs';
import { alert } from '../../src/dsh-butler/lib/alert.mjs';

export const VERSION = '0.1.0';

const DEFAULT_MAX_RECORDS = 500;

/**
 * @param {{
 *   name?:string, home?:string, logger?:(line:string)=>void,
 *   onRecord?:(rec:object)=>void, clock?:()=>number, maxRecords?:number,
 *   stateFile?:string|null, stateSchemaVersion?:number, audit?:boolean
 * }} [opts]
 */
export function createScheduler(opts = {}) {
  const name = opts.name ?? 'butler';
  const home = opts.home ?? dshHome();
  const clock = opts.clock ?? Date.now;
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
  const stateFile = opts.stateFile ?? null;
  const stateSchemaVersion = opts.stateSchemaVersion ?? 1;
  const doAudit = opts.audit !== false;

  /** @type {Map<string, any>} */
  const tasks = new Map();
  /** @type {object[]} */
  const records = [];

  function log(msg) {
    try {
      if (typeof opts.logger === 'function') opts.logger(msg);
      else process.stdout.write(`[butler-scheduler:${name}] ${msg}\n`);
    } catch { /* 日志失败不影响调度 */ }
  }

  /** 注册一个采集器。返回注销函数。 */
  function register(spec) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) throw new Error('scheduler.register: 需要字符串 id');
    if (tasks.has(spec.id)) throw new Error(`scheduler.register: id 重复 ${spec.id}`);
    if (typeof spec.run !== 'function') throw new Error(`scheduler.register: ${spec.id} 缺少 run(ctx)`);
    const intervalMs = Number(spec.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error(`scheduler.register: ${spec.id} intervalMs 必须为正数`);
    const task = {
      id: spec.id,
      label: spec.label ?? spec.id,
      intervalMs,
      ttlMs: Number.isFinite(spec.ttlMs) ? spec.ttlMs : Math.max(intervalMs * 2, 60_000),
      timeoutMs: Number.isFinite(spec.timeoutMs) ? spec.timeoutMs : 0,
      initialDelayMs: Number.isFinite(spec.initialDelayMs) ? spec.initialDelayMs : 0,
      run: spec.run,
      enabled: spec.enabled !== false,
      registeredAt: clock(),
      runs: 0,
      failures: 0,
      lastRunAt: 0,
      lastStatus: 'pending',
      lastDurationMs: null,
      lastError: null,
    };
    tasks.set(task.id, task);
    return () => tasks.delete(task.id);
  }

  function list() {
    return [...tasks.values()].map((t) => ({
      id: t.id, label: t.label, intervalMs: t.intervalMs, enabled: t.enabled,
      runs: t.runs, failures: t.failures, lastRunAt: t.lastRunAt, lastStatus: t.lastStatus,
      lastDurationMs: t.lastDurationMs, lastError: t.lastError,
    }));
  }

  function getRecords(limit = records.length) {
    return records.slice(-limit);
  }

  function pushRecord(rec) {
    records.push(rec);
    if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
    try { if (typeof opts.onRecord === 'function') opts.onRecord(rec); } catch { /* 观察者故障不影响 */ }
    return rec;
  }

  /** 落盘调度记录（可选；走 butler-store 原子写，schemaVersion 1）。 */
  function persist() {
    if (!stateFile) return null;
    try {
      return updateJson(stateFile, (cur) => ({
        schemaVersion: stateSchemaVersion,
        scheduler: name,
        updatedAt: new Date(clock()).toISOString(),
        tasks: list(),
        records: [...(cur?.records ?? []), ...records].slice(-200),
      }), { schemaVersion: stateSchemaVersion, home, defaultValue: { schemaVersion: stateSchemaVersion, scheduler: name, records: [] } });
    } catch (e) {
      alert({ level: 'warn', source: 'butler-scheduler', message: `调度记录落盘失败：${e?.message ?? e}`, detail: { stateFile } }, { home });
      return null;
    }
  }

  function withTimeout(promise, timeoutMs, id) {
    if (!timeoutMs) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`tick ${id} 超时（${timeoutMs}ms）`)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** 执行单个任务（失败隔离：任何异常都转成 record，不外抛）。 */
  async function runOne(task, runId, at) {
    const lock = acquireTickLock(`${name}-${task.id}`, { ttlMs: task.ttlMs, home, audit: doAudit });
    if (!lock.ok) {
      return pushRecord({ id: task.id, label: task.label, at: new Date(at).toISOString(), runId, status: 'locked', durationMs: 0, error: null, reason: lock.reason });
    }
    const t0 = clock();
    const ctx = {
      id: task.id,
      runId,
      now: t0,
      home,
      log: (m) => log(`${task.id}: ${m}`),
      store: { readJson, updateJson, writeJsonAtomic },
      audit: (entry) => appendAudit({ runId, tick: task.id, ...entry }, { home, silent: true }),
      alert: (entry) => alert({ source: `butler-tick:${task.id}`, ...entry }, { home }),
    };
    let status = 'ok';
    let error = null;
    let detail = null;
    try {
      const r = await withTimeout(Promise.resolve().then(() => task.run(ctx)), task.timeoutMs, task.id);
      if (r === false) { status = 'error'; error = 'run returned false'; }
      else if (r && typeof r === 'object' && r.ok === false) { status = 'error'; error = r.error ?? r.reason ?? 'run returned ok:false'; }
      else if (r && typeof r === 'object') detail = r.detail ?? null;
    } catch (e) {
      status = /超时/.test(e?.message ?? '') ? 'timeout' : 'error';
      error = (e?.message ?? String(e)).split('\n')[0].slice(0, 400);
    } finally {
      lock.release();
    }
    const durationMs = clock() - t0;
    task.runs += 1;
    if (status !== 'ok') task.failures += 1;
    task.lastRunAt = at;
    task.lastStatus = status;
    task.lastDurationMs = durationMs;
    task.lastError = error;
    return pushRecord({ id: task.id, label: task.label, at: new Date(at).toISOString(), runId, status, durationMs, error, detail, staleLock: lock.stale === true });
  }

  /**
   * 跑一轮：只执行到期的任务（force=true 则全部执行）。
   * 永不 reject —— 单个任务抛错被隔离，其余照跑。
   * @param {{force?:boolean, only?:string[]|null, now?:number}} [opts]
   */
  async function tickOnce(opts2 = {}) {
    const at = opts2.now ?? clock();
    const runId = newRunId(`tick-${name}`);
    const only = opts2.only ?? null;
    const results = [];
    for (const task of tasks.values()) {
      if (only && !only.includes(task.id)) continue;
      if (!task.enabled) { results.push({ id: task.id, status: 'disabled' }); continue; }
      const due = task.lastRunAt === 0
        ? at - task.registeredAt >= task.initialDelayMs
        : at - task.lastRunAt >= task.intervalMs;
      if (!opts2.force && !due) { results.push({ id: task.id, status: 'not-due' }); continue; }
      // 顺序执行：状态文件写冲突交给 butler-store 的锁；并发采集器需自行在 run 内处理
      results.push(await runOne(task, runId, at));
    }
    persist();
    const executed = results.filter((r) => r.status && !['not-due', 'disabled'].includes(r.status)).length;
    const failed = results.filter((r) => r.status === 'error' || r.status === 'timeout').length;
    const out = { runId, at: new Date(at).toISOString(), name, executed, failed, results };
    log(`tick ${runId}: executed=${executed} failed=${failed}`);
    return out;
  }

  return { name, register, list, tickOnce, getRecords, persist, tasks };
}
