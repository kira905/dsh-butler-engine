// dsh-butler / lib/protected-paths.mjs —— P5 保护区清单（单一数据源）
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §4 P5（行 775-855）
// 定位（v2.4 阻断级结论，必须接受）：P5 = 防手滑 + 事后审计，**不宣称防绕过**——
//   fs/* 事件门只覆盖 DSH 的 write / edit 工具；pwsh + node writeFileSync 完全绕过。
//
// 两层对象：
//   A 层（写入前拦截 + 凭证）：persona / 技能 / DSH 核心启动链 —— 写坏 = 全局崩
//   B 层（写后审计 + 回滚）：docs 类文档 —— 写坏 = 规范漂移，可回滚
//
// 管家自身目录（<pkg>/src/dsh-butler/）**不纳入保护区**（务实取舍，写进文档）：
//   自举/升级期间会被自己拦住；该目录有 Gitee 仓3备份 + verify.mjs 单测兜底。
//
// ── 【R-068 · 2026-10-16（主人拍板口径 (b)）】上述取舍**部分收窄** ────────────────────
//   管家自身目录**整体仍不纳入**保护区（自举/升级期不自己拦自己 —— 理由如上，未变）；
//   但其中**「闸门本体」6 个文件**（见下方 {@link GATE_CORE_FILES}）已纳入 **A 层**。
//   〔**锁12 · 2026-10-16 补第 6 支**〕新增 `tools/dsh-butler/restart-gate-notice.mjs`（重启闸门**判据唯一实现**）：
//     它**不拦任何东西**（R-063 拍板 = 留痕 + 告警），但改它 = 改"什么样的重启被记成绕过闸门、告警发给谁"
//     ⇒ **语义上等价于改闸门**，与另 5 支同风险等级，故一并纳入。
//   为什么是这 5 个、而不是整个目录：它们是「门」本身 —— 改它们 = 改闸门语义（谁被拦、谁被审计、
//   谁能推远端仓、部署放不放行）；其余文件是"门的用户"，改动面属常规开发，不该自锁。
//   **边界照旧、一字不夸**：A 层仍只覆盖 DSH 的 `write` / `edit` 工具；
//     `pwsh` + `node writeFileSync` 直写照样绕过（外援在宿主层走的就是这条路 ⇒ 本改动对它零影响）。
//   ⚠️ **自举风险（已知、接受、有逃生路）**：闸门本体这些文件写入前要过 P5 门领凭证，而门的清单由本文件供给
//     ⇒ 若本文件被写坏（语法错），宿主侧 import 失败、常规领凭证路径随之失效。
//     逃生路径**不依赖本文件**：把 `~/.dsh/butler-autonomy.json` 的
//     `modules['p5-protected-paths'].enabled` 置 false（node 直写即可，不经 write/edit 工具）⇒ 清单清空、门放行。
//   决定与理由、生效路径、回退方式：`docs\交付报告-V3机器锁9-R068闸门本体上锁-20261016.md`。
//
// ── 【GUARD-T · 2026-10-28】人格**本源**从"运行时临时登记"搬进内置清单（tier A）────────
//   对象：`tools\presets-src\flip\xiaoxi-life.agent.cordis.yml`（α″ 人格本源 · 卡 FLIP2-E 起的单一真源）。
//   改前状态：它**只**靠 `~/.dsh/butler-autonomy.json#protectedPaths.include` 里 id `flip-baseline` 那一条
//     ⇒ 运行时登记 = 谁把那行删掉，保护就静默消失（"记得加"不是机制）。
//   改后：本文件 {@link FLIP_BASELINE_REL} 内置一条规则 ⇒ **默认就在保护里**，不再依赖任何人记得加。
//   口径边界（FLIP2-E 定，别扩）：**只精确护这一份文件**；同目录的块文件（B1~B7 / B2a~B4b）、
//     `work-overlay.md` / `life-overlay.md` / `manifest.json` / `make-manifest.mjs` / `build-flip.mjs`
//     全部照旧 **NOT_PROTECTED** —— 它们是日常改的载体，把整个 `presets-src\flip\` 罩住会把自己锁死。
//   生效：闸门本体在 boot 进内存 ⇒ **改完要重启 dsh 才生效**（重启走 P0 闸门，不归本组件）。
//   运行时 include 那条**保留**当双保险（要不要删 = 待主人拍板）；两条同 id/label/层级 ⇒ 判定结果无歧义。
//   交付报告：`docs\交付报告-护栏治本-protected-paths内置flip本源-20261028.md`。
//
// ── 运行时开关 / 清单覆盖（2026-09-13 卡④：给保护区清单装活开关）──────────────
// 原先清单是**模块常量**：临时放宽/收紧保护区必须改代码 + 重启 dsh（SLA 表 ④e 缺口）。
// 现在每次 `makeClassifier()`（= 每一次写事件判定）都现读同一个真相源
// `~/.dsh/butler-autonomy.json`（不新增第二套存储）：
//   · `modules['p5-protected-paths'].enabled === false` → **清单清空**（A 层不拦、B 层不审）= 关闭本组件；
//   · `protectedPaths.exclude: [<路径前缀>]`  → 这些路径移出保护区（临时放宽）；
//   · `protectedPaths.include: [{path,tier}]` → 这些路径加入保护区（临时收紧）。
// 读盘走 **mtime + 3s 时窗缓存**（照 P5 暂停开关的范式：面板/手改文件 ≤3s 生效）。
//
// fail-safe 方向（**与自主动作类相反，必须记住**）：本组件是"保护类"，它的保守方向是
//   **继续保护**。故配置缺失 / 读失败 / 损坏 → 覆盖项一律忽略、保持内置清单（绝不因读不到
//   配置而放松保护）；只有**显式写进文件的 enabled:false**（带 since/by/why）才清空清单。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';

/** 运行时开关的读缓存时窗（毫秒）。= 「改文件 ≤3s 生效」SLA。 */
export const RUNTIME_CACHE_MS = 3000;
/** 【2c-B2】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, opts = {}) {
  return resolveStatePath(name, { home: opts.home ?? dshHome() }).path;
}
/** 真相源文件名（同管家自治开关：唯一一套开关存储）。 */
export const AUTONOMY_FILE = 'butler-autonomy.json';

/** DSH 根目录默认值（HOST-B/HOST-A 同构；可用 opts.dshRoot 覆盖，便于单测）。 */
export const DEFAULT_DSH_ROOT = process.env.DSH_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME || '.', 'dsh-workspace');

/**
 * DSH 根「核心启动链」文件名白名单（与 persona 的目录白名单铁律一致）。
 * 只匹配根目录直属文件，不递归子目录。
 */
export const CORE_ROOT_BASENAME_RE = /^(?:dsh-[\w.-]+|guard[\w.-]*|repair[\w.-]*|knowledge|l2-actions|llm-client|fix-workspace-local|migrate-session-cwd)\.(?:cmd|bat|ps1|mjs|vbs)$/i;

/**
 * 【R-068 · 2026-10-16】「闸门本体」= 保护区里的**门本身**（相对 `dshRoot` 的路径，正斜杠书写、判定前归一化）。
 *
 * ⚠️ 判据是**文件级精确匹配**（`abs === normalizePath(join(dshRoot, rel))`），
 *    **不是**把 `tools\` 整树或 `lib\` 整目录纳入（那是 R-068 方向 (c)，主人 2026-10-16 未选）。
 *    ⇒ 同目录下的其它文件（`changelog-add.mjs` / `lib\paths.mjs` / `tools\lib\dsh-home.mjs` …）**照旧不受拦**。
 *
 * 各是什么门（逐条见 {@link GATE_CORE_FILES}）：
 *   · `tools/lib/deploy-guard.mjs`           部署门禁（fail-closed 参数 / 逃逸 import 扫 / 部署位置冒烟）
 *   · `tools/dsh-butler/lib/audit-guard.mjs` P5 审计门（A 层 fs 门 + A⁺ 内容门）
 *   · `tools/dsh-butler/lib/lane-gate.mjs`   跨线闸（守护鱼 / 护士 / 静默窗同一消费口径）
 *   · `tools/dsh-butler/lib/protected-paths.mjs` 保护区清单本体（单一真源 —— 本文件）
 *   · `tools/dsh-butler/lib/push-guard.mjs`  挡推门
 *   · `tools/dsh-butler/restart-gate-notice.mjs` 重启闸门**判据唯一实现**（R-063）—— 本件不拦任何东西
 *     （拍板档位 = 留痕 + 告警），但它决定「**什么样的重启会被记成绕过闸门、告警发给谁**」
 *     ⇒ 改它**语义上等价于改闸门**，故与另 5 支同等级纳入（详见文件头 §锁12 注）。
 *
 * ⚠️ 另有「危险脚本清单」一项：**只读取证确认它没有独立文件**（散在 `docs\交付报告-0.1.5遗留L21*`
 *    §6 表格与各脚本自身的 fail-closed 参数里）⇒ 本清单**不登记臆造路径**，如实登记"无独立文件"。
 */
export const GATE_CORE_FILES = [
  'tools/lib/deploy-guard.mjs',
  'tools/dsh-butler/lib/audit-guard.mjs',
  'tools/dsh-butler/lib/lane-gate.mjs',
  'tools/dsh-butler/lib/protected-paths.mjs',
  'tools/dsh-butler/lib/push-guard.mjs',
  'tools/dsh-butler/restart-gate-notice.mjs',
];

/**
 * 【GUARD-T · 2026-10-28】人格**本源**（相对 `dshRoot` 的路径，正斜杠书写、判定前归一化）。
 * = α″ 人格真源翻转后的单一真源；改它 = 改所有人格注入的内容 ⇒ A 层（写前拦截 + P5 凭证）。
 * ⚠️ 判据是**文件级精确匹配**：`presets-src\flip\` 下其它文件（块文件 / 两个 overlay / 清单器）
 *    照旧 NOT_PROTECTED —— 口径边界见文件头 GUARD-T 注。
 */
export const FLIP_BASELINE_REL = 'tools/presets-src/flip/xiaoxi-life.agent.cordis.yml';

/** 路径归一化（Windows 大小写不敏感 + 统一反斜杠），所有"路径相等"判断必须走这里。 */
export function normalizePath(p) {
  return path.resolve(String(p)).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** abs 是否等于 base 或位于 base 之下（两端都必须已 normalizePath）。 */
function isUnder(abs, bases) {
  for (const b of bases) {
    if (abs === b || abs.startsWith(b + '\\')) return true;
  }
  return false;
}

/** 真相源文件绝对路径（与 lib/paths.mjs 的 home 口径一致）。 */
export function autonomyFilePath(opts = {}) {
  return stateFileOf(AUTONOMY_FILE, { home: opts.home });
}

const RUNTIME_CACHE = new Map(); // file → { at, mtimeMs, value }

/**
 * 解析真相源里的运行时覆盖（纯函数，便于单测）。
 * @param {string} file
 * @param {number} mtimeMs -1 = 文件不存在
 * @param {string} [txt] 已读到的文本（读取失败时 undefined）
 * @param {string} [readError]
 */
export function parseRuntimeOverride(file, mtimeMs, txt, readError) {
  const out = {
    ok: false, reason: '', file, mtimeMs, disabled: false,
    exclude: [], include: [], by: null, why: null, since: null,
  };
  if (readError) { out.reason = `read-error:${readError}`; return out; }
  if (mtimeMs < 0) { out.reason = 'file-missing'; return out; }
  if (typeof txt !== 'string' || !txt.trim()) { out.reason = 'file-empty'; return out; }
  try {
    const j = JSON.parse(txt);
    if (!j || typeof j !== 'object') { out.reason = 'file-not-object'; return out; }
    if (Number(j.schemaVersion ?? 1) !== 1) { out.reason = `schema-mismatch:${j.schemaVersion}`; return out; }
    out.ok = true;
    out.reason = 'ok';
    const mod = j.modules && typeof j.modules === 'object' ? j.modules['p5-protected-paths'] : null;
    if (mod && typeof mod === 'object') {
      out.disabled = mod.enabled === false; // 只有**显式** false 才关（true / 缺失 = 照常保护）
      out.by = mod.by ?? null; out.why = mod.why ?? null; out.since = mod.since ?? null;
    }
    const ov = (j.protectedPaths && typeof j.protectedPaths === 'object') ? j.protectedPaths : {};
    out.exclude = Array.isArray(ov.exclude)
      ? ov.exclude.filter((x) => typeof x === 'string' && x.trim()).map((x) => normalizePath(x))
      : [];
    out.include = Array.isArray(ov.include)
      ? ov.include
        .filter((x) => x && typeof x === 'object' && typeof x.path === 'string' && x.path.trim())
        .map((x) => ({
          id: typeof x.id === 'string' && x.id.trim() ? x.id : 'runtime-include',
          label: typeof x.label === 'string' && x.label.trim() ? x.label : '运行时加入保护区（protectedPaths.include）',
          tier: x.tier === 'B' ? 'B' : 'A',
          path: normalizePath(x.path),
        }))
      : [];
  } catch (e) {
    out.reason = `parse-error:${e?.message ?? e}`;
  }
  return out;
}

/**
 * 读运行时开关 / 覆盖（mtime + {@link RUNTIME_CACHE_MS} 时窗缓存）。
 * fail-safe：任何读失败 → ok=false 且 disabled=false / 覆盖为空（**保持内置清单 = 继续保护**）。
 */
export function readRuntimeOverride(opts = {}) {
  const file = autonomyFilePath(opts);
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = -1; }
  const now = Date.now();
  const hit = RUNTIME_CACHE.get(file);
  if (hit && hit.mtimeMs === mtimeMs && now - hit.at < (opts.cacheMs ?? RUNTIME_CACHE_MS)) return hit.value;

  let txt;
  let readError = null;
  if (mtimeMs >= 0) {
    try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { readError = e?.message ?? String(e); }
  }
  const value = parseRuntimeOverride(file, mtimeMs, txt, readError);
  RUNTIME_CACHE.set(file, { at: now, mtimeMs, value });
  return value;
}

/** 清缓存（单测 / 面板需要立即重读时用）。 */
export function clearRuntimeCache() { RUNTIME_CACHE.clear(); }

/**
 * 构造分类器：给定任意路径 → 保护区条目或 null。
 * **每次调用都现读运行时开关**（3s 缓存）→ 改配置 ≤3s 生效，无需重启。
 * @param {{home?:string, dshRoot?:string, cacheMs?:number}} [opts]
 * @returns {(p:string) => null | {id:string, label:string, tier:'A'|'B'}}
 */
export function makeClassifier(opts = {}) {
  const home = opts.home ?? dshHome();
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const presetsDir = normalizePath(path.join(home, '.agent-presets'));
  const skillsDir = normalizePath(path.join(home, 'skills'));
  const docsDir = normalizePath(path.join(dshRoot, 'docs'));
  const root = normalizePath(dshRoot);
  // 【R-068】闸门本体 = dshRoot 下 `GATE_CORE_FILES` 清单里的具体文件（文件级精确匹配；不是整个 lib\ 目录）。
  const gateCore = GATE_CORE_FILES.map((rel) => normalizePath(path.join(dshRoot, rel)));
  // 【GUARD-T · 2026-10-28】人格本源：单文件精确匹配（不是目录语义）
  const flipBaseline = normalizePath(path.join(dshRoot, FLIP_BASELINE_REL));
  const rt = readRuntimeOverride(opts);

  return function classify(p) {
    if (typeof p !== 'string' || !p.trim()) return null;
    // ① 模块显式关闭 → 清单清空（不拦不审）
    if (rt.disabled) return null;
    const abs = normalizePath(p);
    // ② 运行时移出（exclude）：命中即不保护
    if (rt.exclude.length > 0 && isUnder(abs, rt.exclude)) return null;
    // ③ 内置清单
    if (abs === presetsDir || abs.startsWith(presetsDir + '\\')) {
      return { id: 'persona', label: 'persona（.agent-presets）', tier: 'A' };
    }
    if (abs === skillsDir || abs.startsWith(skillsDir + '\\')) {
      return { id: 'skills', label: '技能（.dsh\\skills）', tier: 'A' };
    }
    // 根目录直属核心启动链（不递归）
    if (path.dirname(abs) === root && CORE_ROOT_BASENAME_RE.test(path.basename(abs))) {
      return { id: 'core-root', label: 'DSH 核心启动链', tier: 'A' };
    }
    // 闸门本体（R-068）：**文件级精确匹配**（等价于 abs === gateCore[i]，不用前缀/目录语义）
    if (gateCore.includes(abs)) {
      return { id: 'gate-core', label: '闸门本体（R-068）', tier: 'A' };
    }
    // 【GUARD-T · 2026-10-28】人格本源（flip 基线）：文件级精确匹配，**只护这一份**
    if (abs === flipBaseline) {
      return { id: 'flip-baseline', label: '人格本源（flip 基线）', tier: 'A' };
    }
    if (abs === docsDir || abs.startsWith(docsDir + '\\')) {
      return { id: 'docs', label: 'docs 文档', tier: 'B' };
    }
    // ④ 运行时加入（include）：内置清单之外再收紧
    for (const inc of rt.include) {
      if (abs === inc.path || abs.startsWith(inc.path + '\\')) {
        return { id: inc.id, label: inc.label, tier: inc.tier };
      }
    }
    return null;
  };
}

/** 运行时开关快照（面板 / 单测 / 排障用：只读）。 */
export function describeRuntime(opts = {}) {
  const rt = readRuntimeOverride(opts);
  return {
    file: rt.file, ok: rt.ok, reason: rt.reason, disabled: rt.disabled,
    exclude: [...rt.exclude], include: rt.include.map((x) => ({ ...x })),
    source: rt.ok ? (rt.disabled ? 'file(disabled)' : 'file') : 'fail-safe(keep-builtin)',
    by: rt.by, why: rt.why, since: rt.since,
  };
}

/** 是否 A 层（写前拦截）对象。 */
export function isProtectedA(p, opts = {}) {
  const hit = makeClassifier(opts)(p);
  return hit && hit.tier === 'A' ? hit : null;
}

/** 是否 B 层（写后审计）对象。 */
export function isAuditedB(p, opts = {}) {
  const hit = makeClassifier(opts)(p);
  return hit && hit.tier === 'B' ? hit : null;
}

/**
 * 保护区条目清单（人类可读，用于面板 / 文档 / 单测断言）。
 * @param {{home?:string, dshRoot?:string}} [opts]
 */
export function describeProtection(opts = {}) {
  const home = opts.home ?? dshHome();
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  return [
    { id: 'persona', tier: 'A', path: path.join(home, '.agent-presets'), rule: '目录递归（agent.cordis.yml 等 preset 文件）' },
    { id: 'skills', tier: 'A', path: path.join(home, 'skills'), rule: '目录递归（SKILL.md 及技能自带脚本）' },
    { id: 'core-root', tier: 'A', path: dshRoot, rule: `根目录直属匹配 ${CORE_ROOT_BASENAME_RE}` },
    { id: 'gate-core', tier: 'A', path: path.join(dshRoot, 'tools'), rule: `闸门本体 ${GATE_CORE_FILES.length} 个文件（文件级精确匹配 · R-068）：${GATE_CORE_FILES.join(' / ')}` },
    { id: 'flip-baseline', tier: 'A', path: path.join(dshRoot, FLIP_BASELINE_REL), rule: '人格本源（flip 基线 · 文件级精确匹配 · GUARD-T）；同目录块文件与两个 overlay 不受拦' },
    { id: 'docs', tier: 'B', path: path.join(dshRoot, 'docs'), rule: '目录递归 *.md（写后审计）' },
  ];
}
