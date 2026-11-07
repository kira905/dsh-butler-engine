// dsh-butler / lib/collect-retry.mjs —— 「采集抖动收口」的**唯一实现**（有限重试 + 短退避）
//
// 由来（单一实现纪律）：
//   · 2026-09-17 【V3·批次17】：ctx-guard 先遇到 `session.list` 间歇超时（fetch failed /
//     aborted due to timeout），在 `lib/ctx-guard.mjs` 的 `scanContext()` 里**私有**实现了
//     「retries=1 + 退避 1500ms」。
//   · 同日【Q6】：同一病症打到队列通知链（`butler-queue-tick.mjs` 的 queue job）——任一路采集
//     失败即整轮跳过 ⇒ 卡进「待验收」后再没人叫醒主会话 ⇒ **串行队列停摆**。
//   ⇒ 按「不许两处各写一份」的纪律，把批次17 的循环抽到本模块；ctx-guard 与 queue tick 共用它。
//     数值口径与批次17 **逐字一致**（retries=1 / 1500ms），不另立一套。
//
// 语义红线（四条，全卡通用）：
//   ① **失败语义不回退**：重试后仍失败 → 把最后一次的失败结果原样交给调用方，调用方照旧判
//      `collect-failed` / `ok:false` + 原样文案 → exit 1 → 报警。**绝不**改成成功、绝不静默降级。
//   ② **超时值不动**：本模块不碰超时；每次尝试沿用调用方给 `readSessions`/`readBoard` 的既有超时。
//   ③ **成功即返回**，不额外延迟；只在**失败之后**才等待退避。
//   ④ **本模块自己不写任何文件、不打日志**（零副作用）——留痕由调用方决定；`onRetry` 是纯观察钩子，
//      钩子自身抛错一律吞掉，绝不影响主流程。
//
// 参数：`{retries, retryDelayMs, isOk, onRetry}`；`retries:0` = 完全关掉重试（测试用关闭路径）。
export const COLLECT_RETRY_VERSION = '0.1.0';

/**
 * 默认值（**与批次17 的 `DEFAULT_SCAN_RETRIES` / `DEFAULT_SCAN_RETRY_DELAY_MS` 同值同义**）。
 *   · `retries = 1` ⇒ 最多 **2 次尝试**；最坏耗时 = 2× 调用方超时 + 1× 退避
 *     （queue tick 的 sessions 超时 10s ⇒ 最坏 21.5s ≪ tick 周期 60s、≪ tick 锁 TTL 120s）；
 *   · 实测抖动窗口（批次17 记录：正常 0.5~2.2s）远小于一次退避 + 一次重试 ⇒ 一次重试足够覆盖。
 */
export const DEFAULT_RETRIES = 1;
export const DEFAULT_RETRY_DELAY_MS = 1500;

/** 退避（可被 `retryDelayMs:0` 关掉）。 */
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 解析参数（非法值 → 用默认；负数/小数一律规整）。 */
export function resolveRetryOpts(opts = {}) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  const retries = Math.max(0, Math.trunc(n(opts.retries, DEFAULT_RETRIES)));
  const retryDelayMs = Math.max(0, n(opts.retryDelayMs, DEFAULT_RETRY_DELAY_MS));
  return { retries, retryDelayMs, maxAttempts: retries + 1 };
}

/**
 * 有限重试执行器。
 *
 * @param {(attempt:number)=>Promise<any>} fn 采集动作（每次尝试都被调用一次；**不做任何包装/改写**）
 * @param {{retries?:number, retryDelayMs?:number, isOk?:(r:any)=>boolean, onRetry?:(info:object)=>void}} [opts]
 * @returns {Promise<{result:any, attempts:number, retries:number, maxAttempts:number, ok:boolean}>}
 *   `attempts` = 实际尝试次数；`retries` = 允许的重试次数（口径旁证，进 `--json`/单测，不进失败文案）。
 */
export async function collectWithRetry(fn, opts = {}) {
  const { retries, retryDelayMs, maxAttempts } = resolveRetryOpts(opts);
  const isOk = typeof opts.isOk === 'function' ? opts.isOk : (r) => r?.ok === true;
  let result = null;
  let attempts = 0;
  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    result = await fn(attempts);                 // ① 红线②：超时由调用方给，本模块不介入；异常照旧外抛（不吞）
    if (isOk(result)) break;                     // ③ 成功即返回，不额外延迟
    if (attempts >= maxAttempts) break;          // 用尽 → 交给调用方的失败分支（红线①）
    try {
      opts.onRetry?.({ attempt: attempts, maxAttempts, error: result?.error ?? 'unknown', delayMs: retryDelayMs });
    } catch { /* 观察钩子失败绝不影响主流程 */ }
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }
  return { result, attempts, retries, maxAttempts, ok: isOk(result) };
}
