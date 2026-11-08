/**
 * 仓体积阈值与 Gitee 配额口径 —— **单一真源**（2026-09-16 拷问 P1 修复）
 *
 * ## 为什么单独立件
 * 2026-09-16 拷问发现同一张阈值表被**抄成两份**（`handoff.mjs` 与 `lib/hot-collect.mjs`），
 * 「保持同口径」只靠注释维系；且**口径本身从没写清**：实测 `dsh-sessions` 全树 1003.5MB
 * 而 `.git` 只有 596.8MB —— 两者差 40%+，按全树算提前误报、按 `.git` 算才是真配额。
 *
 * ## 配额口径（判据只看 `.git`）
 * Gitee 单仓配额 1024MB 是**服务端仓库对象总大小**。实测 2026-09-16 旧仓被拒时服务端报
 * `1138.273MB > quota 1024MB`，而本地旧仓 `.git` = 1136.6MB（工作副本另计）
 * ⇒ **本地 `.git` 大小与配额同量纲**。工作树（tree）只作参考信息展示，**不参与告警判据**。
 *
 * ## 两层判据
 * ① 绝对阈值 `VOLUME_THRESHOLDS`（各仓经验水位，防"平时就很大"的仓天天红）；
 * ② 配额余量比 `QUOTA_*_RATIO`（对 Gitee 1024MB 的真实占用，防"突然撞硬线"）。
 * 二者取**更严的一档**。
 */

import fs from 'node:fs';
import path from 'node:path';

/** Gitee 单仓硬配额（服务端仓库对象总大小）。 */
export const GITEE_QUOTA_BYTES = 1024 * 1024 * 1024;

/**
 * 绝对阈值（口径 = `.git` 目录大小，见 `measureGitVolume`）。
 * ⚠️ 2026-09-16 改为 `.git` 口径后按实测值重定：旧值是按"全树"标的（dsh-sessions 800MB
 * 全树 ≈ 596MB .git），换口径后若不动会整体偏松。
 */
export const VOLUME_THRESHOLDS = {
  'dsh-core': 400 * 1024 * 1024,
  'dsh-sessions': 700 * 1024 * 1024,
  'dsh-workspace': 400 * 1024 * 1024,
};

/** 配额占用比 ≥ 此值 → 🟡（余量 <40%，该安排治理了）。 */
export const QUOTA_NOTICE_RATIO = 0.6;
/** 配额占用比 ≥ 此值 → 🔴（余量 <20%，随时可能被 pre-receive 硬拒）。 */
export const QUOTA_ALERT_RATIO = 0.8;

/**
 * 测量一个仓的 `.git` 目录大小（递归 stat，跳过不可读项）。
 * @param {string} repoDir 工作副本根目录
 * @returns {{bytes:number, files:number, ok:boolean, reason:string|null}}
 */
export function measureGitVolume(repoDir) {
  const gitDir = path.join(repoDir, '.git');
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch { /* 占用/权限：跳过单文件，不影响总体积口径 */ }
      }
    }
  };
  if (!fs.existsSync(gitDir)) return { bytes: 0, files: 0, ok: false, reason: 'no-.git' };
  walk(gitDir);
  return { bytes, files, ok: true, reason: null };
}

/**
 * 单个仓的体积判定（纯函数，便于单测）。
 * @param {{repo:string, gitBytes:number, treeBytes?:number|null, thresholdBytes?:number|null}} input
 */
export function judgeRepoVolume(input) {
  const repo = input.repo;
  const gitBytes = Number(input.gitBytes) || 0;
  const treeBytes = Number.isFinite(input.treeBytes) ? Number(input.treeBytes) : null;
  const thresholdBytes = input.thresholdBytes ?? VOLUME_THRESHOLDS[repo] ?? null;
  const quotaBytes = GITEE_QUOTA_BYTES;
  const quotaRatio = gitBytes / quotaBytes;
  const remainBytes = Math.max(0, quotaBytes - gitBytes);
  const overThreshold = thresholdBytes ? gitBytes > thresholdBytes : false;

  let level = 'ok';
  let why = '配额与阈值均正常';
  if (quotaRatio >= QUOTA_ALERT_RATIO) {
    level = 'red';
    why = `配额占用 ${(quotaRatio * 100).toFixed(1)}%（余量 ${fmtMB(remainBytes)}）—— 随时可能被 Gitee 硬拒`;
  } else if (overThreshold) {
    level = 'yellow';
    why = `超过绝对阈值 ${fmtMB(thresholdBytes)}（当前 ${fmtMB(gitBytes)}）`;
  } else if (quotaRatio >= QUOTA_NOTICE_RATIO) {
    level = 'yellow';
    why = `配额占用 ${(quotaRatio * 100).toFixed(1)}%（余量 ${fmtMB(remainBytes)}）—— 该安排治理`;
  }

  return {
    repo,
    gitBytes,
    treeBytes,
    thresholdBytes,
    overThreshold,
    quotaBytes,
    quotaRatio,
    remainBytes,
    level,
    why,
    message: `${repo} .git ${fmtMB(gitBytes)} / 配额 ${(quotaRatio * 100).toFixed(1)}%（余量 ${fmtMB(remainBytes)}）· ${why}`,
  };
}

/**
 * 从体积历史采样估算增速与"撞线时间"（纯函数）。
 * @param {Array<{at:number, gitBytes:number}>} history 时间正序
 * @param {number} currentBytes 当前值
 * @param {number} [targetRatio] 目标占用比（默认 QUOTA_ALERT_RATIO）
 * @returns {{mbPerHour:number|null, hoursToTarget:number|null, sampleCount:number, windowHours:number|null}}
 */
export function estimateGrowth(history, currentBytes, targetRatio = QUOTA_ALERT_RATIO) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((r) => Number.isFinite(r?.at) && Number.isFinite(r?.gitBytes))
    .sort((a, b) => a.at - b.at);
  if (rows.length < 2) return { mbPerHour: null, hoursToTarget: null, sampleCount: rows.length, windowHours: null };
  const first = rows[0];
  const last = rows[rows.length - 1];
  const hours = (last.at - first.at) / 3_600_000;
  if (!(hours > 0.05)) return { mbPerHour: null, hoursToTarget: null, sampleCount: rows.length, windowHours: null };
  // 用首尾差（对单次抖动更稳），且只统计增长段
  const deltaBytes = Math.max(0, (Number(currentBytes) || last.gitBytes) - first.gitBytes);
  const mbPerHour = deltaBytes / 1048576 / hours;
  const target = GITEE_QUOTA_BYTES * targetRatio;
  const cur = Number(currentBytes) || last.gitBytes;
  const hoursToTarget = mbPerHour > 0.01 && cur < target
    ? (target - cur) / 1048576 / mbPerHour
    : (cur >= target ? 0 : null);
  return { mbPerHour, hoursToTarget, sampleCount: rows.length, windowHours: hours };
}

/** 体积历史最多保留条数（30 分钟一采样 ⇒ 96 条 ≈ 2 天）。 */
export const VOLUME_HISTORY_MAX = 96;

/** 追加一条体积采样并裁剪（纯函数，返回新数组）。 */
export function pushVolumeHistory(history, entry, max = VOLUME_HISTORY_MAX) {
  const rows = (Array.isArray(history) ? history : []).filter((r) => Number.isFinite(r?.at));
  rows.push({ at: Number(entry.at), gitBytes: Number(entry.gitBytes) || 0, treeBytes: Number(entry.treeBytes) || 0 });
  return rows.slice(-max);
}

export function fmtMB(n) {
  const v = Number(n) || 0;
  return v >= 1024 * 1024 * 1024 ? `${(v / 1073741824).toFixed(2)}GB` : `${(v / 1048576).toFixed(1)}MB`;
}
