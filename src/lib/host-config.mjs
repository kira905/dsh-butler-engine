// ============================================================
//  host-config.mjs —— 宿主环境口径（单点定义）
//  ------------------------------------------------------------
//  为什么要有这一层：
//    交接 / 跨机 / 文本同步这一族工具，天然要写「本机数据区在哪」「对端是哪台」
//    「工作副本放哪」。这些**每台机器都不一样**，不能写死在代码里 —— 写死一次，
//    换个人用就得改源码。
//
//  全部口径走环境变量（未设置时有中性兜底），优先级统一：
//    显式参数 / 命令行开关  >  环境变量  >  兜底
//
//  | 变量 | 含义 | 兜底 |
//  |---|---|---|
//  | `BUTLER_DSH_ROOT`        | 本机数据区根（含 docs/ tools/ _archive/） | `$DSH_WORKSPACE` 或 `~/DSH` |
//  | `BUTLER_REPO_ROOT`       | 三仓工作副本根（盘外，不进同步目录） | `~/dsh-repos` |
//  | `BUTLER_PEER`            | 默认对端 ssh 别名 | 空（未配置 ⇒ 需要显式传 `--peer`） |
//  | `BUTLER_PEER_HOME`       | 对端用户目录根 | 空 |
//  | `BUTLER_PEER_DSH_ROOT`   | 对端数据区根 | 空 |
//  | `BUTLER_SELF_BASE`       | 本机服务基址 | `http://127.0.0.1:3080` |
//  | `BUTLER_MACHINE_ALIASES` | 机器别名表（JSON，见 machineAliases） | 只有本机一台 |
//
//  ⚠️ 兜底值只是「能跑起来」的默认，不代表推荐布局；换机器请显式设变量。
// ============================================================
import os from 'node:os';
import path from 'node:path';
import { resolveDshWorkspace } from './dsh-home.mjs';

/** 任意环境变量的非空取值（空串 / 纯空白视为未设置）。 */
export const envStr = (name, env = process.env) => {
  const v = env?.[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** 本机数据区根（放 docs/、tools/、_archive/ 的那棵树）。 */
export function dshRoot(env = process.env) {
  const explicit = envStr('BUTLER_DSH_ROOT', env);
  if (explicit) return path.resolve(explicit);
  return path.resolve(resolveDshWorkspace());
}

/** 三仓工作副本根（GitHub/Gitee 克隆下来的工作副本，天然在数据区之外）。 */
export function repoRoot(env = process.env) {
  const explicit = envStr('BUTLER_REPO_ROOT', env);
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), 'dsh-repos');
}

/** 默认对端 ssh 别名。未配置 → `null`（调用方应要求显式 `--peer`，别猜）。 */
export const peerAlias = (env = process.env) => envStr('BUTLER_PEER', env);
/** 对端用户目录根。未配置 → `null`。 */
export const peerHome = (env = process.env) => envStr('BUTLER_PEER_HOME', env);
/** 对端数据区根。未配置 → `null`。 */
export const peerDshRoot = (env = process.env) => envStr('BUTLER_PEER_DSH_ROOT', env);

/** 本机服务基址（时钟门 / 状态接口用）。 */
export const selfBase = (env = process.env) => envStr('BUTLER_SELF_BASE', env) || 'http://127.0.0.1:3080';

/** 本机主机名（小写短名）。 */
export function selfHost() {
  return String(os.hostname() || 'localhost').toLowerCase();
}

/**
 * 机器别名表：`{ 规范名: [别名…] }`（别名一律小写比）。
 *
 * 来源优先级：
 *   1. `BUTLER_MACHINE_ALIASES` 环境变量（JSON 字符串）；
 *   2. 未设置 ⇒ **只有本机一台**（`{ <hostname>: [<hostname>] }`）。
 *
 * 为什么默认不带任何具体机名：这是给「别人装到自己的机器上」用的包，
 * 硬编码三台机的名字等于把某人的拓扑当成了协议。
 */
export function machineAliases(env = process.env) {
  const raw = envStr('BUTLER_MACHINE_ALIASES', env);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out = {};
        for (const [key, list] of Object.entries(parsed)) {
          const k = String(key).trim().toLowerCase();
          if (!k) continue;
          const aliases = Array.isArray(list) ? list : [list];
          out[k] = [...new Set([k, ...aliases.map((x) => String(x).trim().toLowerCase()).filter(Boolean)])];
        }
        if (Object.keys(out).length) return out;
      }
    } catch {
      // 坏 JSON 不静默改成别的口径 —— 明确回落到单机表，由调用方在报告里标出。
    }
  }
  const h = selfHost();
  return { [h]: [h] };
}

/** 别名表是否来自显式配置（false = 只有本机一台，跨机判定会因此判不出对端）。 */
export function machineAliasesConfigured(env = process.env) {
  return Boolean(envStr('BUTLER_MACHINE_ALIASES', env));
}
