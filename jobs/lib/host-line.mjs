// tools/dsh-butler/lib/host-line.mjs —— 能力档（U-6 · ④-4）读取与文案的**唯一源**
//
// 出处：`docs\升级链入家规包-方案-20260917.md` §3.6（U-6 · 能力档 · 跨机版本共存）
//   · ③ 包交办：「未升机读到新口径副本时，能力档 unknown ⇒ 按最保守口径运行 + 在日报显式标注」
//   · 不新建能力档 —— 复用 `tools\lib\host-adapter.mjs` 的 `hostLine()`（**唯一判定源，本文件不复制判定**）
//   · `unknown` 的处置（= "最保守"的具体含义）：
//       ① 定档结果按 🔴 处理（只出方案、不自动）；② 报告/日报**显式打一行**；③ **不执行任何写步骤**。
//     ⚠️ 落点约束（方案 §16-⑥/⑦）：①②③ **在闸门层实现**（`dsh-upgrade-orchestrator.mjs` 的第 0 道闸），
//        **禁止改写 `triage` 的 `tier` 字段或 `--triage` 的输出**（① 包冻结项④：唯一档位源 = `upgrade-triage`）。
//   · 可见化载体（方案 §16-⑦·② 改正）：`line` **落审计行**（append-only、天然不覆盖），**不塞升级锁的 `note`**
//        （`note` 是覆盖式的，且已被 `--note selfcheck-failed` 占用）；日报段另打一行。
//
// 本文件只做三件事：读本机主包**实体**版本 → 过 `hostLine()` → 给**统一文案**。
//   零 spawn、只读、**永不抛错**（读不到 ⇒ `unknown`，即"最保守口径"的输入态）。
//
// 维护责任缺口（方案 §3.6-2 附带条件 · D-6 待拍板）：
//   `host-adapter.mjs` 的 `HOST_LINES` 是**硬编码白名单**；主包升到白名单之外 ⇒ 本机恒为 `unknown`。
//   本文件的文案把这个态**明说成"白名单未同步"**（`read='unlisted'`），不再让"是不是白名单没同步"靠猜。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostLine as toHostLine, HOST_LINES } from '../../src/dsh-butler/lib/host-adapter.mjs';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';

/** 本库版本（改判定/文案时同步递增）。 */
export const HOST_LINE_VERSION = '1.0.0';

/** 能力档不可判定态。 */
export const UNKNOWN_LINE = 'unknown';

/** 主包名（实体版本读取对象）。 */
export const HOST_PKG_NAME = '@deepseek-ai/dsh';

/** 显式成段文案前缀（报告 / 日报 / stderr 三处共用；改文案只改本文件）。 */
export const CAPABILITY_NOTE_PREFIX = '⬆️ 升级链：主包行';

/** `unknown` 的标准口径句（判据 8 逐字要求输出含此句）。 */
export const UNKNOWN_LINE_TEXT = `${CAPABILITY_NOTE_PREFIX} unknown（读不到版本）→ 按最保守口径`;

/**
 * 主包实体 package.json 的候选位置（**按序探测，第一个读到的为准**）。
 * 顺序理由：① 显式声明（调用方/测试注入）② 实例内主包实体（多实例/测试环境各自的主包）
 *   ③ 全局 npm 根（现网形态；**与 `tools\dsh-upgrade-watch.mjs:162` 同口径** —— 主包版本只此两处读法）。
 * @param {{home?:string, appData?:string}} [o]
 */
export function hostPkgCandidates({ home, appData } = {}) {
  const h = home ?? dshHome();
  const app = appData ?? process.env.APPDATA ?? os.homedir();  return [
    path.join(h, 'profiles', 'web', 'node_modules', ...HOST_PKG_NAME.split('/'), 'package.json'),
    path.join(h, 'node_modules', ...HOST_PKG_NAME.split('/'), 'package.json'),
    path.join(app, 'npm', 'node_modules', ...HOST_PKG_NAME.split('/'), 'package.json'),
  ];
}

/** 读一个 package.json 的 version（静默失败）。 */
function readVersion(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))?.version;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch { return null; }
}

/**
 * 读本机主包**实体**版本并折算能力档。**零 spawn、只读、永不抛。**
 *
 * @param {{home?:string, version?:string, appData?:string}} [input]
 *   - `version`：显式版本串（调用方已知版本时直接给，跳过文件读取）
 *   - `home`：DSH home（默认 `dshHome()`，跟随 `BUTLER_DSH_HOME`）
 * @param {{readVersion?:Function}} [deps] 可注入读版本函数（单测用；默认读文件）
 * @returns {{ok:boolean, line:string, version:string|null, read:'explicit'|'entity'|'npm-root'|'no-version'|'unlisted',
 *            file:string|null, candidates:string[], hostLines:string[], note:string, hint:string|null}}
 */
export function probeHostLine(input = {}, deps = {}) {
  const inp = (input && typeof input === 'object') ? input : {};
  const read = deps.readVersion ?? readVersion;
  const candidates = hostPkgCandidates({ home: inp.home, appData: inp.appData });
  const base = { candidates, hostLines: [...HOST_LINES] };
  try {
    // ① 显式注入版本
    if (typeof inp.version === 'string' && inp.version.trim()) {
      const v = inp.version.trim();
      const line = toHostLine(v);
      return finish({ line, version: v, read: line === UNKNOWN_LINE ? 'unlisted' : 'explicit', file: null, ...base });
    }
    // ② / ③ 实体读取（按序取第一个读到的）
    for (let i = 0; i < candidates.length; i++) {
      const file = candidates[i];
      const v = read(file);
      if (!v) continue;
      const line = toHostLine(v);
      return finish({ line, version: v, read: line === UNKNOWN_LINE ? 'unlisted' : (i === candidates.length - 1 ? 'npm-root' : 'entity'), file, ...base });
    }
    // ④ 读不到 ⇒ unknown（最保守口径的输入态；**不是故障**，是"这条线上有什么我不知道"）
    return finish({ line: UNKNOWN_LINE, version: null, read: 'no-version', file: null, ...base });
  } catch {
    // 永不抛：任何意外一律折叠成最保守态
    return finish({ line: UNKNOWN_LINE, version: null, read: 'no-version', file: null, ...base });
  }
}

/** 组装返回值 + 统一文案（文案只有这一处，报告/日报/CLI 复用）。 */
function finish({ line, version, read, file, candidates, hostLines }) {
  const ok = line !== UNKNOWN_LINE;
  let note;
  let hint = null;
  if (ok) {
    note = `${CAPABILITY_NOTE_PREFIX} ${line}${version ? `（实体 ${version}）` : ''}`;
  } else if (read === 'unlisted') {
    // 读到版本但不在白名单 ⇒ 明说是"白名单未同步"，不是"读不到"（两种都含"主包行 unknown → 按最保守口径"词干）
    note = `${CAPABILITY_NOTE_PREFIX} unknown → 按最保守口径（实体 ${version} 不在能力档白名单 HOST_LINES 内）`;
    hint = `主包实体版本 ${version} 未登记在 tools\\lib\\host-adapter.mjs 的 HOST_LINES=[${hostLines.join(', ')}] ⇒ 属"白名单未同步"（方案 §3.6-2 维护责任缺口 / D-6 待拍板）。`
      + '处置：先同步 HOST_LINES（主包升级后由主会话负责），本入口不猜主包线。';
  } else {
    note = UNKNOWN_LINE_TEXT;
    hint = read === 'explicit'
      ? '调用方显式给的版本串不在 HOST_LINES 白名单内。'
      : `读不到主包实体版本（候选：${candidates.join(' ｜ ')}）⇒ 按最保守口径。`;
  }
  return { ok, line, version, read, file, candidates, hostLines, note, hint };
}

/**
 * 一段式文案（日报段 / 报告首屏一行用）。
 * @param {ReturnType<typeof probeHostLine>} res
 */
export function capabilityLine(res) {
  return res?.note ?? UNKNOWN_LINE_TEXT;
}

/**
 * `unknown` 时的告示段（报告/审计/日志用；正常态返回空数组 ⇒ **无噪音**）。
 * 入参可以是 `probeHostLine()` 的返回值（带 `ok`）或 `judgeCapabilityGate()` 的返回值（带 `pass`）——
 * 两者都按"不可判定"识别（`ok === false || pass === false`）。
 * @param {ReturnType<typeof probeHostLine>|{ok?:boolean,pass?:boolean}} res
 * @param {{bold?:boolean}} [opts]
 */
export function capabilityWarningLines(res, opts = {}) {
  const undecidable = res?.ok === false || res?.pass === false;
  if (!undecidable) return [];
  const b = opts.bold === false ? (s) => s : (s) => `**${s}**`;
  const L = [];
  L.push(`> ⚠️ ${b('能力档不可判定（主包行 unknown）')}——本链**不执行任何写步骤**（真升级一律拒），`
    + '🔴 处置 = 只出方案、等主人；请先修好版本读取或同步 HOST_LINES 白名单。');
  if (res?.hint) L.push(`> 判据：${res.hint}`);
  return L;
}

/** 供下游/单测断言：白名单是否登记某线（**只读事实，不含策略**）。 */
export function isKnownLine(line) {
  return HOST_LINES.includes(String(line));
}
