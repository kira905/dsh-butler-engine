// dsh-butler / lib/butler-write-paths.mjs —— 管家「自身写入路径」豁免清单（自指豁免）
//
// 方案 §4 P4「自指豁免（v2.4 补）」：
//   坑库文件是 P5 B 层写后审计的对象，而 P4 会自动写它 → 审计器必须豁免
//   「管家自身写入的路径」（坑库 / 管家报告 / 变更流水渲染视图 / 审计 JSONL），
//   否则自动写会被自己判违规并回滚，形成死循环。
//   豁免清单与 §3.6.2 的权威源划分保持一致。
//
// 用法（P5 写后审计）：
//   import { isButlerWritten } from '<pkg>/src/dsh-butler/lib/butler-write-paths.mjs';
//   const w = isButlerWritten(absPath);
//   if (w.hit) { /* 跳过审计，记一行 skip 原因 */ }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { COMPONENT_ROOT } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';

export const WRITE_PATHS_VERSION = '0.1.0';

/** DSH 根（<DSH>/tools/dsh-butler → <DSH>）。 */
export function dshRoot() {
  return path.resolve(COMPONENT_ROOT, '..', '..');
}

/**
 * 豁免项。kind: dir = 目录前缀；file = 精确文件；glob = 后缀/模式。
 * why = 为什么豁免（写进审计 skip 记录，便于复核）。
 */
export function butlerWrittenPaths(opts = {}) {
  const root = opts.dshRoot ?? dshRoot();
  // DSH 数据根默认值：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（2026-09-14 环境边界修复；
  // 原先默认硬编码 ~/.dsh → 测试/金丝雀实例里豁免清单会指生产，判定静默失准）。
  const home = opts.home
    ?? process.env.BUTLER_DSH_HOME
    ?? process.env.DSH_HOME
    ?? path.join(os.homedir(), '.dsh');
  return [
    { id: 'pitfall-docs', kind: 'dir', path: path.join(root, 'docs', '坑库'), why: 'P4 自动写坑库主题文件' },
    { id: 'butler-reports', kind: 'dir', path: path.join(root, 'docs', '管家报告'), why: '管家日报/周报自动写' },
    { id: 'changelog-view', kind: 'dir', path: path.join(root, 'docs', '变更流水'), why: '管家渲染视图（P3/P4 自动追加）' },
    { id: 'butler-audit', kind: 'dir', path: path.join(home, 'butler-audit'), why: '审计流水 append-only，自身产物' },
    { id: 'butler-state', kind: 'file-prefix', path: path.join(home, 'butler-'), why: '管家状态文件（butler-*.json）' },
    { id: 'butler-locks', kind: 'dir', path: path.join(home, 'butler-locks'), why: 'tick/RMW 锁' },
    { id: 'butler-alert', kind: 'file', path: resolveStatePath('butler-alert.log', { home }).path, why: '管家告警日志' },
    { id: 'butler-tools', kind: 'dir', path: path.join(root, 'tools', 'dsh-butler'), why: '管家自身代码/测试/备份' },
  ];
}

/** 归一化：realpath（存在时）+ 统一分隔符 + 去尾分隔符 + 小写（Windows 大小写不敏感）。 */
export function normalizePath(p) {
  let full = String(p ?? '');
  try { full = fs.realpathSync(full); } catch { full = path.resolve(full); }
  full = full.replace(/[\\/]+/g, path.sep);
  if (full.length > 3 && full.endsWith(path.sep)) full = full.slice(0, -1);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/**
 * 交接分发目标（P9 §5.5「P5 自指闭环」第①层）。
 *
 * ⚠️ **默认不生效**：只有调用方显式传 `isButlerWritten(p, { handoffActive: true })` 才命中。
 *   理由（2026-09-16 H3 实测取舍）：启动链属 A 层保护区，**永久**豁免等于让 A 层对启动链失效
 *   （persona/技能的测试明确要求「A 层绝不能被豁免」）。而交接器分发启动链是**时间窗口事件**
 *   （Arrive 进行中）→ 只能按窗口豁免，且窗口真假由调用方判定。
 *   接线点（H4 管家接入）由 P5 侧读取交接单 `role/startedAt/finishedAt` 判定 handoffActive。
 *
 * 【2026-10-14 卡 R8 扩充 6 → 9 件】同族三件 `dsh-desktop.cmd` / `dsh-plugin.cmd` /
 *   `dsh-guard.cmd` 一并纳入：交接分发时它们同属「启动链面」，且与 `tools\dsh-wrapup.ps1`
 *   收尾自检用的根目录白名单（权威源 `butler-tidy-policy.json` 的 `rootWhitelist`）**同口径**
 *   —— 两处必须一致，否则收尾自检会误报（来源：`docs\交付报告-愿景核查-R7-同族cmd改齐-20261014.md`
 *   §9.5 → R8 卡）。⚠️ 注意：本清单是**P5 窗口豁免面**，不等于交接器实际分发清单
 *   （后者 = `handoff-manifest.json` 的文件级启动链条目，目前仍是 6 条）。可执行文件判据：
 *   三件的 `.cmd` 在 DSH 根、命中 `dsh-*.cmd` 形态正则，与 start/shutdown/restart 同族。
 */
export function handoffDispatchTargets(opts = {}) {
  const root = opts.dshRoot ?? dshRoot();
  return [
    path.join(root, 'dsh-start.ps1'),
    path.join(root, 'dsh-start.cmd'),
    path.join(root, 'dsh-shutdown.ps1'),
    path.join(root, 'dsh-shutdown.cmd'),
    path.join(root, 'dsh-restart.ps1'),
    path.join(root, 'dsh-restart.cmd'),
    path.join(root, 'dsh-desktop.cmd'),
    path.join(root, 'dsh-plugin.cmd'),
    path.join(root, 'dsh-guard.cmd'),
  ];
}

/**
 * 该路径是否属于「管家自身写入」。
 * @param {string} p
 * @param {{dshRoot?:string, home?:string, handoffActive?:boolean}} [opts] handoffActive=true 时额外豁免交接分发目标
 * @returns {{hit:boolean, ruleId:string|null, why:string|null, normalized:string}}
 */
export function isButlerWritten(p, opts = {}) {
  const norm = normalizePath(p);
  if (opts.handoffActive === true) {
    for (const t of handoffDispatchTargets(opts)) {
      if (norm === normalizePath(t)) {
        return { hit: true, ruleId: 'handoff-dispatch-target', why: '交接进行中的分发目标（P9 §5.5 自指闭环①，仅窗口内豁免）', normalized: norm };
      }
    }
  }
  for (const rule of butlerWrittenPaths(opts)) {
    const rp = normalizePath(rule.path);
    if (rule.kind === 'dir' && (norm === rp || norm.startsWith(rp + path.sep))) {
      return { hit: true, ruleId: rule.id, why: rule.why, normalized: norm };
    }
    if (rule.kind === 'file' && norm === rp) {
      return { hit: true, ruleId: rule.id, why: rule.why, normalized: norm };
    }
    if (rule.kind === 'file-prefix') {
      const dir = path.dirname(rp);
      if (path.dirname(norm) === dir && path.basename(norm).startsWith(path.basename(rp))) {
        return { hit: true, ruleId: rule.id, why: rule.why, normalized: norm };
      }
    }
  }
  return { hit: false, ruleId: null, why: null, normalized: norm };
}
