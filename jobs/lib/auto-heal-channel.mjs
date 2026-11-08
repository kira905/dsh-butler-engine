// dsh-butler / lib/auto-heal-channel.mjs —— auto-heal 的**唯一子进程调用点**（薄壳，仿 lib/p0-restart-channel.mjs）
//
// 为什么要单独一个文件：主动作文件 `lib/auto-heal.mjs` 必须**零子进程引用**
//   （单测有静态断言；与批次 4 的 p0-auto-restart 同一纪律）——真实通道（spawn）只住在这里，
//   这样"动作判定"与"进程外动作"在静态上就是分开的两层，审查时一眼可见。
//
// 【只跑"已声明"的入口】本文件**不决定跑什么**：入口由 `lib/auto-heal.mjs` 的
//   `plan.items[].entry` 给定，来源只有两处（都写在代码里的声明式清单）：
//     · patch 类  → `tools\<PATCH_MANIFEST.script>`（生态面板 PATCH_MANIFEST 声明的幂等补丁脚本）
//     · pointer 类 → `lib/closure-links.mjs` 的 `repairCommands()` 探测到的既有修复脚本
//   本文件只做**二次校验**（形状 / 后缀 / 存在性 / 参数白名单）后 spawn，**不接受任意路径**。
//
// ⚠️ 纪律：`windowsHide: true`（persona 铁律：子进程不弹终端窗）+ 超时（不得把 tick 挂死）+
//   输出截尾（审计里不留大块日志）+ 同步执行（修完立刻自检，不做并发"连环修"）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CHANNEL_VERSION = '1.0.0';

/** 输出保留长度（审计里只留尾部，防一条日志几 MB）。 */
export const TAIL_CHARS = 2000;
/** 允许的脚本后缀（只允许 node 脚本；杜绝 .cmd/.ps1/.bat 被"顺手"接进来）。 */
export const ALLOWED_SUFFIX = ['.mjs', '.js'];
/** 允许传给入口的参数（白名单：修法所需的"确认执行"开关，别的一律拒）。 */
export const ALLOWED_ARGS = new Set(['--apply', '--yes', '--quiet']);

/** 尾部截断（保留最后 n 个字符，前面加省略标记）。 */
export function tailText(s, n = TAIL_CHARS) {
  const t = String(s ?? '');
  return t.length > n ? `…（前 ${t.length - n} 字符省略）…` + t.slice(-n) : t;
}

/**
 * 入口形状校验（纯函数，单测入口）。
 * @param {{type?:string, path?:string, args?:Array<string>, cwd?:string}|null} entry
 * @returns {{ok:boolean, reason:string, script?:string, args?:Array<string>, cwd?:string}}
 */
export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: '入口为空' };
  if (entry.type !== 'node-script') return { ok: false, reason: `入口类型不支持：${String(entry.type)}` };
  const script = String(entry.path ?? '');
  if (!script) return { ok: false, reason: '入口缺少 path' };
  if (!path.isAbsolute(script)) return { ok: false, reason: `入口必须是绝对路径：${script}` };
  if (script.includes('..')) return { ok: false, reason: `入口路径不得含 ..：${script}` };
  const ext = path.extname(script).toLowerCase();
  if (!ALLOWED_SUFFIX.includes(ext)) return { ok: false, reason: `入口后缀不在白名单（${ALLOWED_SUFFIX.join('/')}）：${script}` };
  if (!fs.existsSync(script)) return { ok: false, reason: `入口脚本不存在：${script}` };
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const bad = args.filter((a) => !ALLOWED_ARGS.has(a));
  if (bad.length) return { ok: false, reason: `入口参数不在白名单：${bad.join(' ')}` };
  const cwd = entry.cwd ? String(entry.cwd) : path.dirname(script);
  if (!fs.existsSync(cwd)) return { ok: false, reason: `入口 cwd 不存在：${cwd}` };
  return { ok: true, reason: 'ok', script, args, cwd };
}

/**
 * 跑一个已声明的修法入口（同步，超时兜底）。
 * @param {object} entry {type:'node-script', path, args?, cwd?}
 * @param {{timeoutMs?:number, env?:object, now?:number}} [opts]
 * @returns {{ok:boolean, exitCode:number|null, signal:string|null, error:string|null,
 *            script:string|null, args:Array<string>, ms:number, stdout:string, stderr:string, rejected?:boolean, reason?:string}}
 */
export function runEntry(entry, opts = {}) {
  const t0 = opts.now ?? Date.now();
  const v = validateEntry(entry);
  if (!v.ok) {
    return { ok: false, exitCode: null, signal: null, error: `入口被拒：${v.reason}`, rejected: true, reason: v.reason, script: entry?.path ?? null, args: [], ms: 0, stdout: '', stderr: '' };
  }
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120_000;
  let r;
  try {
    r = spawnSync(process.execPath, [v.script, ...v.args], {
      cwd: v.cwd,
      timeout: timeoutMs,
      windowsHide: true,          // 不弹终端窗（persona 铁律）
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
  } catch (e) {
    return { ok: false, exitCode: null, signal: null, error: String(e?.message ?? e), script: v.script, args: v.args, ms: Date.now() - t0, stdout: '', stderr: '' };
  }
  const timedOut = r.error && /ETIMEDOUT|timed? ?out/i.test(String(r.error.message ?? ''));
  return {
    ok: r.status === 0 && !r.error,
    exitCode: typeof r.status === 'number' ? r.status : null,
    signal: r.signal ?? null,
    error: r.error ? String(r.error.message ?? r.error) : (timedOut ? `执行超时（${timeoutMs}ms）` : null),
    script: v.script,
    args: v.args,
    ms: Date.now() - t0,
    stdout: tailText(r.stdout),
    stderr: tailText(r.stderr),
  };
}
