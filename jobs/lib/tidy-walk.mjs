// dsh-butler / lib/tidy-walk.mjs —— P8 收纳：统一递归遍历器（**唯一实现**，所有动作复用）
//
// 方案：docs\管家v2.5-P8会收纳设计-20260909.md §5.4（递归遍历的 junction 防护）+ §15.2 P-2
//   P-2 的前半句：「遍历器区分『挂载点 junction』与『内容 reparse point』」。
//
// 为什么必须分两种（2026-09-10 实测）：
//   - <workspace> 根下 6 个目录（_archive/_tmp/generated/logs/snapshots/backups）是**挂载点 junction**
//     → 指向 <offsync>\…，是生产数据的正式所在，**必须跟随**（不跟随 = 计数全 0，<workspace>目录规范.md §一 明写"绝不能删/不能实体化"）。
//   - 归档区/临时区**内部**再出现的 junction 是**内容 reparse point**（历史 HOST-B 迁移沙箱等）
//     → 递归进去会跑到本目录树之外，**一律不穿透**（不进、不删、不搬）。
//   - 判定 = 深度 1 且名字在挂载点白名单 → 跟随；其余任何 reparse point → 跳过并记账。
//
// 另：所有「路径相等」判断必须 realpath 归一（junction 字符串比较会静默失效，2026-09-07 实测）——
//   本模块只做遍历，不替调用方判等；需要判等请用 paths.mjs 的 realOrResolve()。
import fs from 'node:fs';
import path from 'node:path';

export const TIDY_WALK_VERSION = '0.1.0';

/** <workspace> 根的挂载点 junction（<workspace>目录规范.md §一 junction 清单，8 条中的 6 条根级项）。 */
export const DEFAULT_MOUNT_POINTS = Object.freeze(['_archive', '_tmp', 'generated', 'logs', 'snapshots', 'backups']);

/** reparse point（junction / symlink）判定：lstat 是链接即真；不存在/不可读 → false（调用方不必 try）。 */
export function isReparsePoint(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** junction 指向的真实目标（跨 junction 的"路径相等"判断一律先过这里）。 */
export function linkTarget(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/**
 * 递归遍历。**不穿透内容 reparse point**；根级挂载点 junction 按白名单跟随。
 *
 * @param {string} root 起点目录
 * @param {{
 *   mountPoints?: string[]|Set<string>,  // 允许跟随的根级挂载点名字（默认 DEFAULT_MOUNT_POINTS）
 *   maxDepth?: number,                   // 相对 root 的深度上限（0 = 只看 root 自己）
 *   followMountPoints?: boolean,         // false = 连挂载点也不跟随（默认 true）
 *   onSkip?: (info:{path:string,depth:number,type:'mount'|'link',target:string|null})=>void
 * }} [opts]
 * @returns {{root:string, exists:boolean, files:{path:string,size:number,mtimeMs:number}[], fileCount:number, bytes:number,
 *            dirCount:number, mounts:{path:string,target:string|null}[], skipped:{path:string,target:string|null}[],
 *            errors:{path:string,error:string}[], elapsedMs:number}}
 */
export function walkTree(root, opts = {}) {
  const t0 = Date.now();
  const mountPoints = new Set(opts.mountPoints ?? DEFAULT_MOUNT_POINTS);
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : Infinity;
  const followMounts = opts.followMountPoints !== false;
  const out = { root, exists: fs.existsSync(root), files: [], fileCount: 0, bytes: 0, dirCount: 0, mounts: [], skipped: [], errors: [], elapsedMs: 0 };
  if (!out.exists) { out.elapsedMs = Date.now() - t0; return out; }

  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      out.errors.push({ path: dir, error: String(e?.message ?? e) });
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const isLink = e.isSymbolicLink();
      const isDir = e.isDirectory();
      if (isLink) {
        const isMount = depth === 0 && mountPoints.has(e.name);
        let targetDir = false;
        if (followMounts && isMount) {
          try { targetDir = fs.statSync(full).isDirectory(); } catch { targetDir = false; }
        }
        if (isMount && targetDir) {
          const target = linkTarget(full);
          out.mounts.push({ path: full, target });
          if (opts.onSkip) opts.onSkip({ path: full, depth, type: 'mount', target });
          out.dirCount++;
          if (depth + 1 <= maxDepth) walk(full, depth + 1);
          continue;
        }
        // 内容 reparse point（含"挂载点但目标不是目录"）→ 不穿透，记账
        const target = linkTarget(full);
        out.skipped.push({ path: full, target });
        if (opts.onSkip) opts.onSkip({ path: full, depth, type: 'link', target });
        continue;
      }
      if (isDir) {
        out.dirCount++;
        if (depth + 1 <= maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue; // 管道 / 设备 / 未知类型：不计不读
      let size = 0;
      let mtimeMs = 0;
      try { const st = fs.statSync(full); size = st.size; mtimeMs = st.mtimeMs; } catch { /* 竞态：文件刚消失 */ }
      out.files.push({ path: full, size, mtimeMs });
      out.fileCount++;
      out.bytes += size;
    }
  };

  walk(root, 0);
  out.elapsedMs = Date.now() - t0;
  return out;
}

/** 只统计不收集明细（大目录用；返回 {fileCount, bytes, skipped, mounts, errors}）。 */
export function countTree(root, opts = {}) {
  const r = walkTree(root, opts);
  return { root: r.root, exists: r.exists, fileCount: r.fileCount, bytes: r.bytes, dirCount: r.dirCount, mounts: r.mounts, skipped: r.skipped, errors: r.errors, elapsedMs: r.elapsedMs };
}
