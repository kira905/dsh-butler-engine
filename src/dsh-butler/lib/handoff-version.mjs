// dsh-butler / lib/handoff-version.mjs —— 交接版本门数据源（§5.3 第 1 条 + R10）
//
// 方案口径（唯一权威）：
//   数据源 = 本机 `~/.dsh/handoff-version.json`（权威：交接器版本 + 三仓采集脚本版本 + minSupported）
//          + 仓内 `dsh/handoff-version.json`（发布方写，随仓推送）。
//   旧版读到 `minSupported > self` → **拒绝执行**（fail-closed）。
//
// 本模块只做**数据源读写 + 版本解析**，判定一律交 `lib/handoff-version-gate.mjs` 的纯函数
//   （checkMinSupported / compareVersionTables）——单一判定真相，不许在别处另写一套比较。
//
// ⚠️ 实测教训（2026-09-14）：**绝不能拿版本字符串直接比大小**。
//   H1a 的初版写的是 `repoVer.minSupported > localVer.self`（字符串比较）——
//   `"0.9.0" > "0.10.0"` 为真、`"1.0.0" > "0.10.0"` 为假，两个方向都会判错。
//   一律走 compareVersions（按数字段比较）。
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from './paths.mjs';
import { dshRoot as dshRootCfg } from '../../lib/host-config.mjs';
import { readJsonSafe } from './handoff-core.mjs';
import { compareVersions } from './handoff-version-gate.mjs';

export const HANDOFF_VERSION_FILE_VERSION = 1;

/** 本机版本文件固定名（家目录下）。 */
export const LOCAL_VERSION_NAME = 'handoff-version.json';
/** 仓内版本文件**相对工作副本根**的路径。 */
export const REPO_VERSION_RELPATH = 'dsh/handoff-version.json';

/**
 * 三仓采集脚本（进版本门的 .ps1）。
 * ⚠️ 只登记**会写仓内容**的采集脚本；新增采集脚本必须在此加一行，否则版本门覆盖不到它。
 */
export const COLLECTOR_SCRIPTS = [
  { name: 'dsh-backup-sync.ps1', repo: 'dsh-core', rel: 'tools/dsh-backup-sync.ps1' },
  { name: 'dsh-backup-sessions.ps1', repo: 'dsh-sessions', rel: 'tools/dsh-backup-sessions.ps1' },
  { name: 'dsh-backup-workspace.ps1', repo: 'dsh-workspace', rel: 'tools/dsh-backup-workspace.ps1' },
];

/** 交接器版本（与 handoff.mjs 的 HANDOFF_VERSION / hot-collect 同源口径：各自声明、此处汇总）。 */
export const HANDOFF_TOOL_VERSION = '1.0.0';

export function localVersionPath(home = dshHome()) {
  return path.join(home, LOCAL_VERSION_NAME);
}

export function repoVersionPath(worktreeRoot) {
  return path.join(worktreeRoot, REPO_VERSION_RELPATH.split('/').join(path.sep));
}

/**
 * 读版本文件（缺失/损坏 → null，**不抛**）。
 * @returns {{schemaVersion?:number, product?:string, self?:string, minSupported?:string|null,
 *            collectors?:Record<string,string>, artifacts?:Record<string,string>, updatedAt?:string}|null}
 */
export function readVersionFile(file) {
  const j = readJsonSafe(file, null);
  if (!j || typeof j !== 'object') return null;
  return j;
}

/**
 * 构造版本文件内容（纯函数，便于单测）。
 * @param {{self?:string, minSupported?:string|null, collectors?:Record<string,string>, artifacts?:Record<string,string>,
 *          product?:string, now?:number}} [input]
 */
export function buildVersionFile(input = {}) {
  const now = input.now ?? Date.now();
  const collectors = { ...(input.collectors ?? {}) };
  for (const s of COLLECTOR_SCRIPTS) if (!collectors[s.name]) collectors[s.name] = 'unknown';
  return {
    schemaVersion: HANDOFF_VERSION_FILE_VERSION,
    product: input.product ?? 'dsh-handoff',
    self: input.self ?? HANDOFF_TOOL_VERSION,
    minSupported: input.minSupported ?? null,
    collectors,
    artifacts: { ...(input.artifacts ?? {}) },
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * 从**脚本文件内容**里抽版本号（不改采集脚本：正则抓 `$ScriptVersion = '1.2.3'` / `# version: 1.2.3`）。
 * 抓不到 → 'unknown'（**不猜**）。
 */
export function detectScriptVersion(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const patterns = [
      /\$ScriptVersion\s*=\s*['"]([0-9][0-9A-Za-z.\-+]*)['"]/,
      /\$Version\s*=\s*['"]([0-9][0-9A-Za-z.\-+]*)['"]/,
      /^#\s*version:\s*([0-9][0-9A-Za-z.\-+]*)/im,
      /^#\s*v([0-9][0-9A-Za-z.\-+]*)/im,
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) return m[1];
    }
    return 'unknown';
  } catch { return 'unknown'; }
}

/** 采集三仓脚本版本（写进版本文件）。 */
export function detectCollectorVersions(dshRoot = dshRootCfg()) {
  const out = {};
  for (const s of COLLECTOR_SCRIPTS) {
    out[s.name] = detectScriptVersion(path.join(dshRoot, s.rel.split('/').join(path.sep)));
  }
  return out;
}

/**
 * 确保本机版本文件存在且 self 与当前交接器版本一致，返回 `{created, updated, file, data}`。
 * 缺失 → 写一份（自举）；`self` 与当前版本不同 → 更新 self 并保留 minSupported。
 * **不覆盖** collectors 里已记录的非 unknown 值。
 *
 * @param {{home?:string, dshRoot?:string, now?:number, detect?:boolean}} [opts]
 *   ⚠️ `detect:false`（**热采路径必须用**）：不重扫 `<数据区>/tools/*.ps1` 取版本，
 *   直接用已有的 collectors（缺项补 'unknown'）。理由：热采每 30 分钟跑一轮，
 *   每轮都扫脚本会把版本文件搅动成"每次都有变化"，既拖慢一轮又要多提交一次 git。
 *   版本重扫只在 Arrive/Depart（低频、人可控）时做。
 */
export function ensureLocalVersionFile({ home = dshHome(), dshRoot = dshRootCfg(), now = Date.now(), detect = true } = {}) {
  const file = localVersionPath(home);
  const prev = readVersionFile(file);
  const detected = detect ? detectCollectorVersions(dshRoot) : {};
  const collectors = { ...(prev?.collectors ?? {}) };
  for (const [k, v] of Object.entries(detected)) {
    if (!collectors[k] || collectors[k] === 'unknown' || v !== 'unknown') collectors[k] = v;
  }
  const next = buildVersionFile({
    self: HANDOFF_TOOL_VERSION,
    minSupported: prev?.minSupported ?? null,
    collectors,
    artifacts: { 'handoff.mjs': HANDOFF_TOOL_VERSION, 'hot-collect.mjs': HANDOFF_TOOL_VERSION, ...(prev?.artifacts ?? {}) },
    now,
  });
  const same = prev && prev.self === next.self && prev.schemaVersion === next.schemaVersion
    && (prev.minSupported ?? null) === (next.minSupported ?? null)
    && JSON.stringify(prev.collectors ?? {}) === JSON.stringify(next.collectors)
    && JSON.stringify(prev.artifacts ?? {}) === JSON.stringify(next.artifacts);
  if (same) return { created: false, updated: false, file, data: prev };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { created: !prev, updated: !!prev, file, data: next };
}

/**
 * 版本门判定（§5.3 第 1 条，fail-closed）。
 *
 * ⚠️ 判定就两条：**仓内 minSupported 高于本机 self → 拒绝**；其余一律放行（缺文件 = 不设硬门）。
 *   这里刻意**不用字符串比较**（见文件头注释的实测教训）。
 *
 * @param {{home?:string, worktreeRoot?:string|object, self?:string, force?:boolean}} [opts]
 *   worktreeRoot 可为字符串（仓1 工作副本根）或 `{['dsh-core']:'<路径>'}` 映射。
 * @returns {{decision:'allow'|'reject', reason:string, self:string|null, minSupported:string|null,
 *            source:'repo'|'local'|'none', file:string|null, localFile:string|null, localData:object|null, repoData:object|null}}
 */
export function checkVersionGate(opts = {}) {
  const home = opts.home ?? dshHome();
  const localFile = localVersionPath(home);
  const localData = readVersionFile(localFile);
  const self = opts.self ?? localData?.self ?? null;

  const roots = opts.worktreeRoot ?? {};
  const root = typeof roots === 'string'
    ? roots
    : (roots['dsh-core'] ?? null);
  const repoFile = root ? repoVersionPath(root) : null;
  const repoData = repoFile ? readVersionFile(repoFile) : null;

  const minSupported = repoData?.minSupported ?? null;
  const base = { self, minSupported, file: repoFile, localFile, localData, repoData };

  if (!minSupported) {
    return { decision: 'allow', source: repoData ? 'repo' : 'none', reason: repoData ? '仓内未声明 minSupported（不设硬门）' : '仓内无 handoff-version.json（不设硬门）', ...base };
  }
  if (!self) {
    return { decision: 'reject', source: 'local', reason: '本机缺 handoffVersion，无法判定是否满足仓内 minSupported → fail-closed', ...base };
  }
  const cmp = compareVersions(self, minSupported);
  if (cmp === null) {
    return { decision: 'reject', source: 'repo', reason: `版本不可比较（本机 ${self} / minSupported ${minSupported}）→ fail-closed`, ...base };
  }
  if (cmp < 0) {
    return { decision: 'reject', source: 'repo', reason: `本机交接器 ${self} < 仓内 minSupported ${minSupported} → 拒绝执行（旧脚本读新数据会出错）`, ...base };
  }
  return { decision: 'allow', source: 'repo', reason: `本机 ${self} ≥ minSupported ${minSupported}`, ...base };
}
