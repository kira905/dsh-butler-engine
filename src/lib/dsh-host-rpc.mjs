/**
 * DSH Host HTTP RPC 适配层 —— **宿主适配壳（不发布）** · 卡 S9（2026-10-16）拆分后
 *
 * 【本文件现在是什么】拆分（方案 §3 步 2 三处刀口 ④）后只剩两层，**本文件是它们的宿主侧组合入口**：
 *   ① `./dsh-rpc-client.mjs` —— **RPC 客户端件（可发布）**：端点表 + 双栈回落 + 请求发送；
 *      cookie 由**显式参数 / env / 可选本机凭据件**三路注入，自身零 fs、零凭据路径。
 *   ② `./dsh-host-credential.mjs` —— **本机凭据解析件（不发布）**：读本机 `.credentials.yaml`。
 *      客户端件用 `createRequire` + try/catch **运行时可选探测**它（宿主上有就用，公开环境没有 = 无凭据）。
 *   ③ 本文件另承载 `withDshHome()`（临时改道 `BUTLER_DSH_HOME` 的宿主专有工具）与**原样的导出面**。
 *
 * 【为什么这么拆】刀口②/④ 要求公开件内零 `os.homedir()`/零凭据耦合（准入四条③），
 *   而宿主行为必须**逐字不变** ⇒ 「实现搬走 + 壳保持导出面」是唯一同时满足两条的姿势。
 *   **导出面与拆分前逐字一致**（`hostRpc` / `hostRpcJson` / `hostRpcValue` / `hostCookie` /
 *   `detectStack` / `clearCookieCache` / `ENDPOINT_TABLE` / `REMOVED_ENDPOINTS` / `withDshHome` / default）
 *   ⇒ **81 处既有消费方零改动**。
 *
 * 🔴 本文件**不随任何公开批发布**（逐件处置表：凭据通道 Y；方案 §5「绝不开放」）。
 *
 * 拆分未改动的行为口径（原文保留于此、由客户端件逐字实现）：0.1.4 旧点号 `POST /api/<ns>.<method>`
 * 无鉴权；0.1.5-rc.2 端点路径段化 + `method` 与端点串逐字相同 + `payload.args.<wire>` + `/api` cookie
 * 鉴权门（`dsh-auth-<sha256(authority)>`，HMAC-SHA256）。红线：**不硬编码 token、不关鉴权门**。
 */

export * from './dsh-rpc-client.mjs';

import {
  hostRpc, hostRpcJson, hostRpcValue, hostCookie,
  detectStack, clearCookieCache, ENDPOINT_TABLE, REMOVED_ENDPOINTS,
} from './dsh-rpc-client.mjs';

/**
 * 在指定 home 口径下跑一段（同步或异步）逻辑：临时把 `BUTLER_DSH_HOME` 指向 `home`，**用完必定还原**。
 *
 * 为什么需要它：cookie 自签密钥取「home 口径」（`BUTLER_DSH_HOME > DSH_HOME > ~/.dsh`）
 * —— 即 **cookie 绑定的是「home 口径」**。而「对**隔离实例**（`<safeRoot>` 起的 3091）取页面 / 发 RPC」
 * 的目标 home 不是生产 home ⇒ 必须调用期间改道，否则一律 **401**（活着的实例被看成死的）。
 *
 * 为什么抽成**唯一一份**：这段改道逻辑原先是 `nurse-orchestrate.mjs#injectViaAgent` 的内联 `withHome()`
 * 私有实现，`nurse-verify.mjs` 没有它 ⇒ 它的 `[V1-a]/[V1-b]/[V1-d]` 对 3091 **恒 401**
 * （2026-10-13 卡「愿景核查」V2 实测，两处共用同一份口径才不会再次分叉）。
 *
 * ⚠️ 改的是**进程级 env** ⇒ 只在单点调用期间改道、`finally` 还原（不并发调用、不跨请求残留）。
 * ⚠️ 传 `null`/`undefined` 视为「不改道、直接跑」—— 便于调用方按条件复用同一段代码。
 *
 * @template T
 * @param {string|null|undefined} home 目标 home（如 `<safeRoot>`）
 * @param {() => T|Promise<T>} fn 要执行的逻辑
 * @returns {Promise<T>}
 */
export async function withDshHome(home, fn) {
  if (home === null || home === undefined || home === '') return await fn();
  const prev = process.env.BUTLER_DSH_HOME;
  process.env.BUTLER_DSH_HOME = String(home);
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.BUTLER_DSH_HOME;
    else process.env.BUTLER_DSH_HOME = prev;
  }
}

export default { hostRpc, hostRpcJson, hostRpcValue, hostCookie, withDshHome, detectStack, clearCookieCache, ENDPOINT_TABLE, REMOVED_ENDPOINTS };
