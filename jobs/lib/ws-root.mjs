// ============================================================
//  ws-root.mjs —— 工作区根 / 盘外副本根 / 快照前缀的中性口径（单点定义）
//  ------------------------------------------------------------
//  为什么单独一件：作业脚本里到处要「数据区在哪」。写死一次，换个人用就得改源码。
//  优先级统一：环境变量 > 用户目录推导。
//
//  | 变量 | 含义 | 缺省 |
//  |---|---|---|
//  | `DSH_WORKSPACE`      | 工作区根（含 docs/ tools/ _archive/） | `~/DSH` |
//  | `DSH_GITBACKUP_ROOT` | 盘外副本 / 冷备根                      | `~/dsh-git-backup` |
//  | `DSH_SNAPSHOT_PREFIX`| 记忆快照文件名前缀                     | `mem-snapshot` |
//  | `DSH_HOST_TOKENS`    | 「设备名标签」正则（主题聚类时剔除）    | `^$`（不剔任何） |
//  ============================================================
import os from 'node:os';
import path from 'node:path';

const str = (name, env) => {
  const v = env?.[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** 工作区根（放 docs/、tools/、_archive/ 的那棵树）。 */
export function workspaceRoot(env = process.env) {
  const explicit = str('DSH_WORKSPACE', env);
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), 'DSH');
}

/** 盘外副本 / 冷备根（不进同步目录的那种）。 */
export function gitBackupRoot(env = process.env) {
  const explicit = str('DSH_GITBACKUP_ROOT', env);
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), 'dsh-git-backup');
}

/** 记忆快照文件名前缀（形如 `mem-snapshot-YYYYMMDD-HHMMSS-<sha8>.db`）。 */
export function snapshotPrefix(env = process.env) {
  return str('DSH_SNAPSHOT_PREFIX', env) ?? 'mem-snapshot';
}

/** 「设备名」标签正则：主题聚类时把这些标签当噪声剔掉。缺省不剔任何东西。 */
export function hostTokenPattern(env = process.env) {
  const raw = str('DSH_HOST_TOKENS', env);
  try {
    return new RegExp(raw ?? '^$', 'i');
  } catch {
    return new RegExp('^$', 'i');
  }
}
