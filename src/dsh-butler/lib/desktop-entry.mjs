// lib/desktop-entry.mjs —— 桌面恢复入口目录的统一口径
//
//   背景：桌面根会被 restore-*.cmd 堆满。约定统一收纳到「桌面\<子目录>」。
//   口径：
//     · 写入口（deploy 系列）→ desktopEntryDir()：桌面基目录下的子文件夹，不存在则创建
//     · 读/扫/删入口（restore 系列 / 审计）→ desktopEntryDirs()：子文件夹优先 + 桌面根回退
//   回退保留的原因：子文件夹是后来才引入的，旧入口可能仍在桌面根或被别处引用。
//
//   本文件零依赖，仅用 node 内置模块。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 子目录名（可用 `BUTLER_DESKTOP_SUBDIR` 覆盖）。 */
export const DESKTOP_SUBDIR = (() => {
  const v = process.env.BUTLER_DESKTOP_SUBDIR;
  return v && v.trim() ? v.trim() : 'DSH-restore';
})();

/** 桌面基目录候选（本机 Desktop、OneDrive\Desktop），只返回真实存在的。 */
export function desktopBases() {
  return [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'OneDrive', 'Desktop')]
    .filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

/**
 * 读/扫/删场景的候选目录列表：先子文件夹（存在的），再桌面基目录本身。
 * @returns {string[]}
 */
export function desktopEntryDirs() {
  const bases = desktopBases();
  const out = [];
  for (const b of bases) {
    const sub = path.join(b, DESKTOP_SUBDIR);
    try { if (fs.existsSync(sub)) out.push(sub); } catch { /* ignore */ }
  }
  for (const b of bases) out.push(b);
  return out;
}

/**
 * 写入口场景的目标目录：第一个桌面基目录下的子文件夹。
 * @param {{mkdir?: boolean}} [opts] mkdir=false 时只查不建（不存在返回 null）
 * @returns {string|null}
 */
export function desktopEntryDir(opts = {}) {
  const { mkdir = true } = opts;
  const base = desktopBases()[0];
  if (!base) return null;
  const sub = path.join(base, DESKTOP_SUBDIR);
  if (mkdir) {
    try { fs.mkdirSync(sub, { recursive: true }); } catch { return null; }
  } else if (!fs.existsSync(sub)) {
    return null;
  }
  return sub;
}

/** 给定桌面基目录，返回"该目录 + 其 <子目录>"——供审计类调用方一次扫两处。 */
export function dirsIncludingSubdir(desktop) {
  if (!desktop) return [];
  const out = [path.join(desktop, DESKTOP_SUBDIR), desktop];
  return out;
}
