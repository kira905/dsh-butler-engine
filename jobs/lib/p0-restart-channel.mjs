// dsh-butler / lib/p0-restart-channel.mjs —— 自动来源重启请求的**唯一**子进程调用点
//
// 为什么单独一个文件（2026-09-13 批次 4，卡验收 4 明确要求）：
//   验收 4 =「全文搜 `lib\p0-auto-restart.mjs` 无直接的重启脚本调用 / 子进程调用」。
//   把唯一的子进程调用隔离到本文件，主动作文件 `lib/p0-auto-restart.mjs` 里**没有一行**子进程相关引用，
//   判据一眼可查。本文件本身也只是**调用既有通道**，绝不新增第二条重启路径。
//
// 【本文件只做一件事】调既有 CLI：`node request-restart.mjs --as-auto --actor <组件名> --reason <事由>`
//   —— 该 CLI 与面板按钮 / 会话内 `request-restart.mjs` 写的是**同一份请求文件**
//      （`<tmp>\dsh-guard\restart-request.json`），走**同一个** restart-coordinator 闸门。
//
// 【红线（违反即打回）】
//   ❌ 不调任何重启脚本、不杀任何进程、不拉守护鱼、不写维护窗口、不写请求文件
//      （重启脚本与进程编排是桌面急救通道与协调器的职责；本动作只发一条请求）
//   ❌ 参数集**不含强制模式**（自动来源永不跳过低水位等待、永不打断在跑会话）
//   ❌ 参数集**不含发起者会话**（自动来源没有发起者 → 协调器的低水位排除集合不含任何人）
//   ✅ 只用 request-restart.mjs 的**默认参数集**（含它自带的 `--as-auto` 既有关闭闸门；也不传 `--no-tick`，
//      让它在 HOST_C 等仍用计划任务的机器上立即触发协调器，在 HOST_A 上触发失败也只打印一行警告、≤1 分钟由 tickd 处理）
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 既有通道脚本（唯一被允许调用的重启入口）。 */
export const REQUEST_RESTART_CLI = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'request-restart.mjs',
);

/** 自动来源的默认发起组件名（写进请求的 `requester.actor`，审计与通知里可见）。 */
export const DEFAULT_ACTOR = 'p0-auto-restart';

/** 单次调用超时（防止 CLI 卡住把动作挂死；超时由 runAction 的 executeTimeoutMs 兜第二层）。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 调既有自动来源通道发一条重启请求。
 * **本函数不判断闸门** —— 闸门有两道：① 调用前的 `autoAllowed('p0-auto-restart')` 预检（在主动作里）
 * ② request-restart.mjs 内部的 `--as-auto` 关闭闸门（裸跑期默认拒绝 → exit 2）。
 *
 * @param {{reason:string, actor?:string, cliPath?:string, timeoutMs?:number}} spec
 * @returns {Promise<{ok:boolean, exitCode:number|null, rejected:boolean, cli:string, argv:Array<string>,
 *                    stdout:string, stderr:string, error:string|null, durationMs:number}>}
 *   exitCode 2 = 被通道闸门拒绝（`--as-auto` 在裸跑期默认拒绝，属预期）；0 = 请求已落盘。
 */
export function requestRestartViaCli(spec = {}) {
  const cli = spec.cliPath ?? REQUEST_RESTART_CLI;
  const actor = String(spec.actor ?? DEFAULT_ACTOR);
  const reason = String(spec.reason ?? 'P0 低水位自动重启');
  // 参数集刻意最小化：只有 --as-auto / --actor / --reason（不加强制模式、不加发起者会话、不加面板身份）
  const argv = [cli, '--as-auto', '--actor', actor, '--reason', reason];
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, argv, {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(cli),
      });
    } catch (e) {
      resolve({ ok: false, exitCode: null, rejected: false, cli, argv: argv.slice(1), stdout: '', stderr: '', error: e?.message ?? String(e), durationMs: Date.now() - t0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; resolve({ cli, argv: argv.slice(1), durationMs: Date.now() - t0, ...r }); };
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => done({ ok: false, exitCode: null, rejected: false, stdout: stdout.trim(), stderr: stderr.trim(), error: e?.message ?? String(e) }));
    child.on('close', (code) => done({
      ok: code === 0, exitCode: code ?? null, rejected: code === 2,
      stdout: stdout.trim(), stderr: stderr.trim(), error: code === 0 ? null : `exit ${code}`,
    }));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已被回收 */ }
      done({ ok: false, exitCode: null, rejected: false, stdout: stdout.trim(), stderr: stderr.trim(), error: `超时（${spec.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）` });
    }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
