// dsh-butler / lib/auto-heal.mjs —— 「组件自修复（auto-heal）」动作本体（L2 模块 `auto-heal` 的执行体）
//
// 由来：`docs\管家-开关矩阵与放行判据-20260913.md` §3.1 待实现动作清单第 4 项（卡：V3 全量开发 批次 8）；
//   规则 R2「锁后交付」：代码进生产 + 开关默认关 + 单测/夹具 + dry-run 可跑 + 生产零动作强断言 + 回滚点 + 演练 + 登记 + 流水。
//
// 【动作语义（照 2026-09-13 主人批准的语义边界，**一字不扩大**）】
//   Kubernetes reconcile 哲学：**只把实际状态推向「我们有单一真相源、且能声明期望状态」的地方；禁止推断式修复**。
//   ✅ 可做（= 本文件全部能力）：
//     ① 幂等补丁重打：把生态面板 PATCH_MANIFEST 声明过、且**被证明特征丢失**的补丁，
//        重跑它声明的那个幂等脚本（`tools\patch-*.mjs` / `re-patch-*.mjs`；已打过的脚本自己会跳过）；
//     ② 声明式指向重建：闭包 junction 指向 / package-map 指向 —— 期望状态可枚举、可校验，
//        修法**只跑已声明的修复入口**：先 `POINTER_ENTRY_DECL`（工具链侧 `tools\repair-*.mjs`，批次 11 补齐），
//        再退到 `lib\closure-links.mjs` 的 `repairCommands()` 探测（环境资产）；两者都没有 → 只报告；
//     ③ 修完必须自检（同源判定复检） + **失败即停（不许连环修）** + 单轮动作上限 + 全部落审计。
//   ❌ 绝不做：不改 persona / 技能 / 文档内容，不改配置值，不升/降任何包版本，**不删任何东西**。
//   一句话判据：**「能证明坏在哪、且能证明修完对」才动手；只要需要「猜」，就只出报告。**
//
// 【判定源（单一真相源，本文件不另造第二套）】
//   · 补丁特征健康 = 生态面板 `lib\state.js` 的 PATCH_MANIFEST 校验结果（本轮判定它、修完也用它复核）。
//     读取通道 = HTTP `GET /api/dsh-ecosystem-panel/state` 的 `groups.patches`
//     （与管家既有「生态升级体检」取面板 state 的做法同源；取不到 → 该类**只报告不修**）。
//   · 闭包 junction 指向 = `tools\lib\closure-links.mjs` 的 `scanClosureLinks()`（干净态 = 全部指向全局 npm 主包依赖）。
//   · package-map 指向 = `<profile>\node_modules\.package-map.json` 每条目的 `url` 必须解析到存在目录。
//
// 【「不猜」的落地规则（三条，改本文件前先读）】
//   ① patch 类：只有 `status === 'yellow'`（特征丢失 = 被插件更新冲掉，**可证可修**）才进候选；
//      `status === 'red'`（补丁目标文件缺失 = 插件可能已卸载/换自研版）→ **只报告**（修法无法证明"修完对"）；
//      `status === 'retired'`（面板已登记**结构性退休** = 上游换实现、锚点消失，非漂移）→ **跳过、不参与判定**
//      （2026-09-29 卡补：登记源 = 面板 `PATCH_RETIREMENTS`；不认它会把"退休"当"特征丢失"每轮重打⇒必失败⇒
//       因"失败即停"挡住同轮后面所有待修项。详见 classifyPatches 里的三条理由）。
//   ② 修法入口必须是「已声明 + 存在 + 形状合法」：patch 走 PATCH_MANIFEST.script 且文件名匹配
//      `^(patch-|re-patch-)[\w.-]+\.mjs$` 且文件在 tools 目录里真实存在；pointer 走既有修复脚本探测结果。
//      任一不满足 → 只报告（绝不手打路径、绝不临场编一条命令）。
//   ③ 自检失败（修完复检仍不健康 / 期望状态源不可得）→ **立刻停**，后续候选一律不动（不许连环修）。
//
// 【闸门（两道串联，fail-safe 方向更严）】
//   · 模块级：`checkModuleAllowed('auto-heal')` = L0 降档 × L1 owner（`autoHealEnabled`）× L2 `modules['auto-heal']`
//   · 动作级：`runAction({kind:'auto-heal'})` 内置 L0 降档闸（批次 6 G7）+ p3-auto 总闸 + 24h 去重 + 单日上限 + token 预算门
//   ⇒ 真实放行 = `p3AutoEnabled` && `autoHealEnabled`（两把键）+ `modules['auto-heal']`；
//     模块 owner 与 `AUTO_KINDS['auto-heal'].raw` 同名（`autoHealEnabled`）⇒ **无批次 4/5 那种归属不一致**。
//
// 【本卡红线（2026-09-14 批次 8）】**不接线到任何 tick**（`butler-tickd.mjs` 一行不动）；
//   不放行任何开关（`butler-autonomy.json` 键值一字未动）；不改主包/插件实体；不推 Gitee。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { checkModuleAllowed } from '../../src/dsh-butler/lib/autonomy-modules.mjs';
import {
  runAction, checkDailyLimit, checkSignature, readActionsState, readLimits, localDay, sigKeyOf, sha256,
} from '../../src/dsh-butler/lib/autonomy-actions.mjs';
import { appendAudit } from '../../src/dsh-butler/lib/audit.mjs';
import { runEntry } from './auto-heal-channel.mjs';
import { scanClosureLinks, repairCommands, defaultLinkRoot, defaultSourceRoot } from './closure-links.mjs';

// ⚠️ 版本号与底座自检的关系：`verify.mjs` 要求"登记表里所有组件版本 == 产品版本"，
//    故本模块**不单独 bump**（同 lib/queue-wake.mjs / lib/p0-auto-restart.mjs / lib/p5-auto-rollback.mjs 口径）。

/** 动作 kind（与 `AUTO_ACTION_KINDS` 的键同名；L2 模块 id 亦同名 —— 矩阵 §3 列口径「同名才能对齐开关」）。 */
export const HEAL_KIND = 'auto-heal';
/** 风险级（矩阵 §3 表：L2 = 有损可回滚；补丁脚本自带备份、指向重建走既有修复脚本的回滚清单）。 */
export const HEAL_LEVEL = 'L2';
/** 目标档（矩阵 §3 表）——只作展示与放行判据的记录，不参与运行时判定。 */
export const HEAL_TARGET_STAGE = 'S3';
/** **单轮动作上限（硬上限）**：一轮最多动几个候选（红线「单轮动作上限」；再取 limits.maxActionsPerTick 的更小值）。 */
export const HEAL_MAX_ITEMS_PER_ROUND = 3;
/** 单个修法入口的超时（防把 tick 挂死）。 */
export const HEAL_ENTRY_TIMEOUT_MS = 120_000;
/** 预览里最多列几个候选/报告项。 */
export const PREVIEW_MAX_ITEMS = 8;

/** 两类可修漂移（照批准边界两项，**不多不少**）。 */
export const HEAL_CLASSES = {
  patch: '① 幂等补丁重打（声明源 = 生态面板 PATCH_MANIFEST；只重打"被证明特征丢失"的那些）',
  pointer: '② 声明式指向重建（闭包 junction 指向 / package-map 指向；只跑已声明的既有修复入口）',
};

/** 可修候选的入口声明式白名单正则（patch 类）。 */
export const PATCH_SCRIPT_RE = /^(patch-|re-patch-)[A-Za-z0-9._-]+\.mjs$/;

// ─────────────────────────────────────────────────────────────────────────────
// 【pointer 类「已声明修法入口」登记表（批次 11 · 2026-09-14）】
//
// 批次 8 定下的形状（**别另造一套**）：每一个可修候选都必须带一个"已声明 + 存在 + 形状合法"的执行入口——
//   · patch 类   → 生态面板 PATCH_MANIFEST 声明的 `patch-*` / `re-patch-*` 脚本（PATCH_SCRIPT_RE 白名单）；
//   · pointer 类 → **本表**声明的脚本（闭包 / package-map 各一条；表里没有或文件不在 → 退回
//                  `lib/closure-links.mjs` 的 `repairCommands()` 探测；再没有 → 该类别只报告）。
// 两道校验与 patch 类同纪律：
//   ① 脚本名必须匹配 POINTER_SCRIPT_RE（声明式白名单，杜绝"临场手打路径"）；
//   ② 文件必须在 `toolsRoot`（默认 `<workspace>\tools`）里**真实存在**，否则视为"本机无修法入口"。
// 入口参数**写死在表里**（`['--apply']`），且必须落在 `lib/auto-heal-channel.mjs` 的 ALLOWED_ARGS 白名单内。
//
// 【为什么入口只有 --apply、没有 --force 之类旁路】「能证明坏在哪、且能证明修完对」才动手：
//   两个脚本都自带 dry-run（默认只读）、写入前备份 / 回滚清单、修完自校验；判不了就退出码 3 拒绝执行。
//
// 【package-map 的额外前置（`precondition:'dsh-stopped'`）】
//   `.package-map.json` 是 **Host 运行期文件**（装载/重载插件时自己重写）⇒ 并发写会互相覆盖。
//   故其**真执行**要求 DSH 已停。该前置由**脚本自身 fail-closed**（探测 3080 可连接即拒绝、退出码 3），
//   本动作只把它标进候选的 `precondition` 字段（**仅展示/审计，不参与判定** —— 判定逻辑一字未改）。
//
// dry-run 示例输出（`node lib\auto-heal.mjs --dry-run`，漂移存在时；本机 2026-09-14 实跑口径）：
//   [auto-heal] dry-run（只算不动；未跑任何修法脚本、未改任何文件）
//     可修候选    ：
//       - [pointer] pointer:closure：闭包 junction 指向
//           闭包指向漂移：污染 3 / 断链 0（期望 = 全部指向全局 npm 主包依赖）
//           入口：<workspace>\tools\repair-closure-links.mjs --apply
//       - [pointer] pointer:package-map：package-map 指向
//           package-map 有 2 条指向解析不到实体（期望 = 每条 url 都能解析到存在目录）；修法入口 = 声明式脚本，**真执行需 DSH 已停**
//           入口：<workspace>\tools\repair-package-map-pointers.mjs --apply
// ─────────────────────────────────────────────────────────────────────────────

/** pointer 类入口的脚本名白名单（声明式；与 PATCH_SCRIPT_RE 同纪律）。 */
export const POINTER_SCRIPT_RE = /^(repair-|re-)[A-Za-z0-9._-]+\.mjs$/;

/** 已声明的 pointer 修法入口（ref → 声明）；`args` 必须在 auto-heal-channel 的参数白名单内。 */
export const POINTER_ENTRY_DECL = {
  closure: {
    script: 'repair-closure-links.mjs',
    args: ['--apply'],
    verify: 'closure-scan',
    label: '闭包指向重建（tools 侧声明式入口；只动指向测试/金丝雀的链接本体，生产闭包无同名包则只删链接不造物）',
  },
  'package-map': {
    script: 'repair-package-map-pointers.mjs',
    args: ['--apply'],
    verify: 'package-map-scan',
    label: 'package-map 指向重建（tools 侧声明式入口；只重写解析不到实体的 url 字段）',
    precondition: 'dsh-stopped',
    preconditionNote: '真执行需 DSH 已停（该文件是 Host 运行期文件，避免并发写）；脚本自身 fail-closed：探测 3080 可连接即拒绝（退出码 3）',
  },
};

/** precondition 取值 → 人话（**只作展示与审计**，不参与任何判定）。 */
export const POINTER_PRECONDITIONS = {
  'dsh-stopped': '需 DSH 已停（避免与 Host 并发写同一文件）',
};

/** 判定值（预览里可见）。 */
export const DECISIONS = ['heal', 'idle', 'report-only', 'blocked', 'quota-exhausted', 'dedup'];

/** 判定 reason → 人话（预览里可见；**只做翻译，不改判定**）。 */
export const NOTE_BY_REASON = {
  'no-drift': '两类期望状态（补丁特征 / 声明式指向）本轮都没漂移 → 无事可做',
  'report-only': '有漂移，但**没有可证明"修完对"的修法**（或期望状态源不可得）→ 只出报告，不动手',
  'module-gate-off': 'L2 模块闸门关闭（L0 降档 / L1 归属 / L2 模块任一关）→ 不执行',
  'daily-limit': '单日上限已用尽 → 不执行',
  dedup: '24h 内同一批候选已处理过 → 去重跳过',
  pending: '存在可证明的漂移且修法入口齐备 → 可修',
};

/** 只在调用方未传 limits 时用的兜底值（与 lib/autonomy-actions.mjs 的 defaultLimits() 同口径）。 */
export const FALLBACK_MAX_PER_DAY = 5;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 只读直读 JSON（**纯只读**：不 alert、不写盘、不修复；读不到一律降级为 null）。 */
function readJsonQuiet(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const txt = fs.readFileSync(file, 'utf8');
    if (!txt.trim()) return null;
    const j = JSON.parse(txt);
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : null;
  } catch {
    return null;
  }
}

/** tools 目录（补丁脚本住这儿；`DSH_TOOLS_DIR` 与生态面板同口径，便于跨机/沙箱）。 */
export function toolsRootOf(opts = {}) {
  return opts.toolsRoot ?? process.env.DSH_TOOLS_DIR ?? path.join('D:', 'DSH', 'tools');
}

/** 生态面板 state 的 URL（判定源；`DSH_WEB_URL` 与既有体检同口径）。 */
export function panelStateUrl(opts = {}) {
  const base = opts.baseUrl ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
  return `${String(base).replace(/\/$/, '')}/api/dsh-ecosystem-panel/state`;
}

// ---------------------------------------------------------------- 判定源读取（纯只读）

/**
 * 读生态面板 state 的 `groups.patches`（**补丁特征的唯一真相源**）。
 * 取不到 → `{ok:false}`：调用方据此**只报告不修**（fail-safe：判不了就不动）。
 * @returns {Promise<{ok:boolean, reason:string, url:string, patches:Array|null, generatedAt:string|null}>}
 */
export async function readPanelState(opts = {}) {
  const url = opts.panelUrl ?? panelStateUrl(opts);
  if (typeof opts.deps?.patchState === 'function') {
    try {
      const r = await opts.deps.patchState();
      if (r && Array.isArray(r.patches)) return { ok: true, reason: r.reason ?? 'deps.patchState', url: r.url ?? '(injected)', patches: r.patches, generatedAt: r.generatedAt ?? null };
      return { ok: false, reason: `注入的判定源无效：${r?.reason ?? 'patches 非数组'}`, url: '(injected)', patches: null, generatedAt: null };
    } catch (e) {
      return { ok: false, reason: `注入的判定源抛错：${e?.message ?? e}`, url: '(injected)', patches: null, generatedAt: null };
    }
  }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 4000), cache: 'no-store' });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}`, url, patches: null, generatedAt: null };
    const j = await r.json();
    const patches = Array.isArray(j?.groups?.patches) ? j.groups.patches : null;
    if (!patches) return { ok: false, reason: '面板 state 里没有 groups.patches', url, patches: null, generatedAt: null };
    return { ok: true, reason: 'ok', url, patches, generatedAt: j?.generatedAt ?? null };
  } catch (e) {
    return { ok: false, reason: `请求失败：${e?.message ?? e}`, url, patches: null, generatedAt: null };
  }
}

/**
 * 补丁漂移判定（**纯函数**：只分类，不做任何写）。
 * 规则见文件头「不猜」①②：yellow 才可修；red / 脚本缺失 / 脚本未声明 → 只报告；**`status:'retired'`（面板已登记结构性退休）→ 跳过（不参与判定）**。
 * @returns {{candidates:Array<object>, reportOnly:Array<object>, skipped:Array<object>}}
 */
export function classifyPatches(patches, opts = {}) {
  const toolsRoot = toolsRootOf(opts);
  const out = { candidates: [], reportOnly: [], skipped: [] };
  for (const p of Array.isArray(patches) ? patches : []) {
    if (!p || typeof p !== 'object') continue;
    const ref = String(p.id ?? '');
    if (!ref) continue;
    const title = String(p.title ?? ref);
    const problems = Array.isArray(p.problems) ? p.problems : [];
    if (p.healthy === true) { out.skipped.push({ id: `patch:${ref}`, class: 'patch', ref, title, reason: 'healthy' }); continue; }
    // 【2026-09-29 卡：auto-heal 认「已退休」】`retired` = 面板已登记**结构性退休**的补丁
    //   （真源 = 生态面板 `lib\state.js` 的 `PATCH_RETIREMENTS` ⇒ 判定表现 `status:'retired'` + `retired` 元信息对象）。
    //   **为什么 retired 必须归 skipped（三条，改这条前先读）**：
    //     ① 它不是"漂移"：特征是**上游换实现导致锚点消失**（例：主包 0.1.5 把 Windows 子进程管理重写成 Win32 Job 容器
    //        ⇒ `patch-dsh-subprocess-windowshide.mjs` 的旧锚点不存在），属**预期状态**；面板已把它排除出红黄绿判定、
    //        不计入漂移计数 ⇒ 本文件若仍把它当候选，等于绕过面板的登记口径。
    //     ② 重打必然失败且**不可修**：实测该脚本 `--dry-run` ⇒ `ANCHOR NOT FOUND — source changed? Abort.`（exit 2）。
    //     ③ 代价是"挡住整轮"而非"只是噪音"：auto-heal 是**失败即停**，所以每轮都停在这第 1 项，
    //        同一轮后面的真漂移（如 `pointer:package-map` 指向重建）**永远轮不到**（实测 2026-09-29 00:03 那轮：
    //        `healed:0 failed:1 stopped:true stoppedBy:"patch:subprocess-winhide: 入口退出码 2"`）。
    //   ⇒ 归类语义：既非"漂移"（不进 reportOnly、不报假信号），更非"可修"（不进 candidates），
    //      而是"**不参与判定**"= skipped（与 `healthy` 同类落点）。
    //   ⚠️ `status` 是单一真相源：显式给了 `status`（yellow/red/green）一律以 `status` 为准 —— `retired` 对象只作
    //      兜底（`status` 缺失时才认），这样"把 status 改成 yellow"能立刻回到 candidates（负样例守门，防"整类免检"）。
    const retiredMeta = p.retired && typeof p.retired === 'object' ? p.retired : null;
    if (p.status === 'retired' || (p.status == null && retiredMeta)) {
      out.skipped.push({
        id: `patch:${ref}`, class: 'patch', ref, title, reason: 'retired',
        note: `面板已登记结构性退休${retiredMeta?.date ? `（${retiredMeta.date}）` : ''} ⇒ 不参与判定、不重打（真源见 retired.source / L-16 报告）`,
        retired: retiredMeta ? { date: retiredMeta.date ?? null, source: retiredMeta.source ?? null, revisit: retiredMeta.revisit ?? null } : null,
      });
      continue;
    }
    const script = typeof p.script === 'string' && p.script.trim() ? p.script.trim() : null;
    const scriptPath = script ? path.join(toolsRoot, script) : null;
    const base = { id: `patch:${ref}`, class: 'patch', ref, title, problems, script, before: { status: p.status ?? null, healthy: p.healthy === true } };
    if (p.status === 'red') {
      out.reportOnly.push({
        ...base, reason: 'target-missing',
        note: '补丁**目标文件缺失**（插件可能已卸载 / 已换自研实现）→ 重打补丁不能证明"修完对"，只报告',
      });
      continue;
    }
    if (!script) { out.reportOnly.push({ ...base, reason: 'script-undeclared', note: '声明源没给脚本名 → 不知道跑什么，只报告' }); continue; }
    if (!PATCH_SCRIPT_RE.test(script)) { out.reportOnly.push({ ...base, reason: 'script-undeclared', note: `脚本名不在声明式白名单（${PATCH_SCRIPT_RE}）：${script} → 拒绝执行` }); continue; }
    if (!fs.existsSync(scriptPath)) { out.reportOnly.push({ ...base, reason: 'script-missing', note: `声明的补丁脚本不存在：${scriptPath} → 只报告` }); continue; }
    out.candidates.push({
      ...base,
      entry: { type: 'node-script', path: scriptPath, args: [], cwd: toolsRoot },
      verify: { kind: 'patch-health', ref },
      why: `补丁特征丢失（面板 status=yellow）：${problems.slice(0, 3).join('；') || '（无明细）'}`,
    });
  }
  return out;
}

/**
 * 闭包 junction 指向扫描（**纯只读**；判定口径 = `tools\lib\closure-links.mjs`，不另写一套）。
 * @returns {{ok:boolean, reason:string, level:string, total:number, matched:number, polluted:Array, broken:Array, linkRoot:string, sourceRoot:string}}
 */
export function scanClosure(opts = {}) {
  if (typeof opts.deps?.scanClosure === 'function') {
    try { return opts.deps.scanClosure(); } catch (e) { return { ok: false, reason: `注入的闭包扫描抛错：${e?.message ?? e}`, level: 'warn', total: 0, matched: 0, polluted: [], broken: [], linkRoot: String(opts.linkRoot ?? ''), sourceRoot: '' }; }
  }
  try {
    const r = scanClosureLinks({ linkRoot: opts.linkRoot ?? defaultLinkRoot(), sourceRoot: opts.sourceRoot ?? defaultSourceRoot() });
    return { ...r, polluted: r.polluted ?? [], broken: r.broken ?? [] };
  } catch (e) {
    return { ok: false, reason: `闭包扫描异常：${e?.message ?? e}`, level: 'warn', total: 0, matched: 0, polluted: [], broken: [], linkRoot: String(opts.linkRoot ?? ''), sourceRoot: '' };
  }
}

/** 已声明的闭包修复入口（探测结果；空 = 本机没有已声明入口 → 只报告）。 */
export function closureRepairEntries(opts = {}) {
  if (typeof opts.deps?.repairCommands === 'function') {
    try { return opts.deps.repairCommands() ?? []; } catch { return []; }
  }
  try { return repairCommands(opts.env ?? process.env, { toolsRoot: opts.toolsRoot ?? undefined }) ?? []; } catch { return []; }
}

/**
 * 取「已声明的 pointer 修法入口」（**纯只读**：只查声明表 + 文件存在性，绝不手打路径）。
 * 两道校验 = POINTER_SCRIPT_RE 白名单 + 文件在 `toolsRoot` 里真实存在；任一不满足 → `null`（= 无修法入口 → 只报告）。
 * @param {'closure'|'package-map'} ref
 * @returns {{path:string, args:Array<string>, label:string, ref:string, verify:string, precondition:string|null, preconditionNote:string|null}|null}
 */
export function declaredPointerEntry(ref, opts = {}) {
  const decl = POINTER_ENTRY_DECL[ref];
  if (!decl) return null;
  if (!POINTER_SCRIPT_RE.test(decl.script)) return null;
  const p = path.join(toolsRootOf(opts), decl.script);
  if (!fs.existsSync(p)) return null;
  return {
    path: p, args: [...decl.args], label: decl.label, ref, verify: decl.verify,
    precondition: decl.precondition ?? null, preconditionNote: decl.preconditionNote ?? null,
  };
}

/** 已声明的 pointer 入口总览（面板/日报/单测用；只读）。 */
export function pointerEntryOverview(opts = {}) {
  return Object.keys(POINTER_ENTRY_DECL).map((ref) => {
    const hit = declaredPointerEntry(ref, opts);
    return { ref, script: POINTER_ENTRY_DECL[ref].script, declared: true, present: Boolean(hit), path: hit?.path ?? null, precondition: POINTER_ENTRY_DECL[ref].precondition ?? null };
  });
}

/**
 * package-map 指向漂移（**纯只读**）：每条目 `url` 必须解析到存在的路径。
 * 期望状态 = "map 里声明的每条指向都存在"（可枚举、可校验）；修法**无已声明入口** → 只报告。
 */
export function scanPackageMapDrift(opts = {}) {
  const home = opts.home ?? dshHome();
  const nm = path.join(opts.profileDir ?? path.join(home, 'profiles', 'web'), 'node_modules');
  const file = path.join(nm, '.package-map.json');
  const j = readJsonQuiet(file);
  const out = { ok: false, reason: 'file-missing', file, nm, entries: 0, broken: [] };
  if (!j) { out.reason = fs.existsSync(file) ? 'file-unreadable-or-not-object' : 'file-missing'; return out; }
  const pkgs = (j.packages && typeof j.packages === 'object') ? j.packages : null;
  if (!pkgs) { out.reason = 'no-packages-section'; return out; }
  for (const [key, cell] of Object.entries(pkgs)) {
    const url = typeof cell?.url === 'string' ? cell.url.trim() : '';
    out.entries++;
    if (!url) { out.broken.push({ key, url: null, reason: 'no-url' }); continue; }
    let resolved;
    try {
      if (/^file:\/\//i.test(url)) resolved = fileURLToPath(url);
      else if (path.isAbsolute(url)) resolved = url;
      else resolved = path.resolve(nm, url);
    } catch (e) {
      out.broken.push({ key, url, reason: `url 解析失败：${e?.message ?? e}` });
      continue;
    }
    if (!fs.existsSync(resolved)) out.broken.push({ key, url, resolved, reason: 'target-missing' });
  }
  out.ok = true;
  out.reason = 'ok';
  return out;
}

// ---------------------------------------------------------------- 只读采集（纯只读，零副作用）

/**
 * 采集两类漂移（**纯只读**：只读面板 state / 闭包链接 / package-map；不写任何文件）。
 * @returns {Promise<object>}
 */
export async function scanDrift(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = num(opts.now, Date.now());
  const toolsRoot = toolsRootOf(opts);
  const out = {
    ok: true, error: null, home, now, day: localDay(now), toolsRoot,
    sources: {
      patch: { ok: false, reason: 'not-checked', url: null, checked: 0, drifted: 0 },
      closure: { ok: false, reason: 'not-checked', level: null, total: 0, matched: 0, polluted: 0, broken: 0 },
      packageMap: { ok: false, reason: 'not-checked', file: null, entries: 0, broken: 0 },
    },
    candidates: [], reportOnly: [], skipped: [],
    summary: { patchChecked: 0, patchDrifted: 0, pointerChecked: 0, pointerDrifted: 0, candidates: 0, reportOnly: 0, skipped: 0 },
  };

  // ── ① 补丁特征（声明源 = 生态面板 PATCH_MANIFEST 校验结果）
  const ps = await readPanelState({ ...opts, deps: opts.deps });
  out.sources.patch = { ok: ps.ok === true, reason: ps.reason, url: ps.url, generatedAt: ps.generatedAt ?? null, checked: 0, drifted: 0 };
  if (ps.ok) {
    const cls = classifyPatches(ps.patches, { toolsRoot });
    out.candidates.push(...cls.candidates);
    out.reportOnly.push(...cls.reportOnly);
    out.skipped.push(...cls.skipped);
    out.sources.patch.checked = Array.isArray(ps.patches) ? ps.patches.length : 0;
    out.sources.patch.drifted = cls.candidates.length + cls.reportOnly.length;
  } else {
    // 期望状态源不可得 → **不猜**：既不能说"没漂移"，也不动手，只报告
    out.reportOnly.push({
      id: 'patch:source-unavailable', class: 'patch', ref: null, title: '补丁特征（期望状态源不可得）',
      reason: 'source-unavailable',
      note: `生态面板 state 取不到（${ps.reason}）→ 这一类的期望状态判不了，本轮只报告、不修`,
    });
  }

  // ── ② 声明式指向：闭包 junction
  const sc = scanClosure(opts);
  const closureDrifted = (sc.polluted?.length ?? 0) + (sc.broken?.length ?? 0);
  out.sources.closure = { ok: sc.ok === true, reason: sc.reason ?? 'ok', level: sc.level ?? null, total: sc.total ?? 0, matched: sc.matched ?? 0, polluted: sc.polluted?.length ?? 0, broken: sc.broken?.length ?? 0, linkRoot: sc.linkRoot ?? null };
  if (!sc.ok) {
    out.reportOnly.push({
      id: 'pointer:closure', class: 'pointer', ref: 'closure', title: '闭包 junction 指向',
      reason: 'source-unavailable', note: `闭包指向扫描不可用（${sc.reason}）→ 只报告、不修`,
    });
  } else if (closureDrifted > 0) {
    // 入口优先级（批次 11 起）：①本表声明的 tools 侧脚本 → ②`closure-links.repairCommands()` 既有探测（环境资产）
    const declared = declaredPointerEntry('closure', opts);
    const entries = declared ? [] : closureRepairEntries(opts);
    const pick = declared ?? entries.find((e) => e && typeof e.path === 'string' && fs.existsSync(e.path)) ?? null;
    const base = {
      id: 'pointer:closure', class: 'pointer', ref: 'closure', title: '闭包 junction 指向',
      problems: [
        ...(sc.polluted ?? []).slice(0, 3).map((l) => `污染：${l.rel} → ${l.target}`),
        ...(sc.broken ?? []).slice(0, 3).map((l) => `断链：${l.rel} → ${l.target}`),
      ],
      before: { level: sc.level, polluted: sc.polluted?.length ?? 0, broken: sc.broken?.length ?? 0 },
    };
    if (!pick) {
      out.reportOnly.push({
        ...base, reason: 'no-repair-entry',
        note: '闭包指向确有漂移，但本机**没有已声明的修复入口**（`closure-links.repairCommands()` 为空）→ 只报告（修法入口需主人拍板后才接）',
      });
    } else {
      out.candidates.push({
        ...base,
        entry: { type: 'node-script', path: pick.path, args: ['--apply'] },
        entryLabel: pick.label ?? null,
        verify: { kind: 'closure-scan', ref: 'closure' },
        why: `闭包指向漂移：污染 ${sc.polluted?.length ?? 0} / 断链 ${sc.broken?.length ?? 0}（期望 = 全部指向全局 npm 主包依赖）`,
      });
    }
  } else {
    out.skipped.push({ id: 'pointer:closure', class: 'pointer', ref: 'closure', title: '闭包 junction 指向', reason: 'healthy' });
  }

  // ── ② 声明式指向：package-map
  const pm = scanPackageMapDrift(opts);
  out.sources.packageMap = { ok: pm.ok === true, reason: pm.reason, file: pm.file, entries: pm.entries ?? 0, broken: pm.broken?.length ?? 0 };
  if (!pm.ok) {
    // 文件缺失/不可读：可能是"这个 profile 没装插件"这类正常态，也可能真丢了 —— 判不了 → 只报告
    if (opts.reportPackageMapUnavailable !== false) {
      out.reportOnly.push({
        id: 'pointer:package-map', class: 'pointer', ref: 'package-map', title: 'package-map 指向',
        reason: 'source-unavailable', note: `package-map 不可读（${pm.reason}：${pm.file}）→ 只报告、不修`,
      });
    }
  } else if ((pm.broken?.length ?? 0) > 0) {
    const decl = declaredPointerEntry('package-map', opts);
    const pmBase = {
      id: 'pointer:package-map', class: 'pointer', ref: 'package-map', title: 'package-map 指向',
      problems: (pm.broken ?? []).slice(0, 3).map((b) => `${b.key} → ${b.url ?? '(空)'}（${b.reason}）`),
      before: { entries: pm.entries, broken: pm.broken.length },
    };
    if (!decl) {
      out.reportOnly.push({
        ...pmBase, reason: 'no-repair-entry',
        note: `package-map 有 ${pm.broken.length} 条指向解析不到实体；期望状态可枚举，但本机**没有已声明的修法入口**（${POINTER_ENTRY_DECL['package-map'].script} 不在 tools 目录）→ 只报告`,
      });
    } else {
      out.candidates.push({
        ...pmBase,
        entry: { type: 'node-script', path: decl.path, args: decl.args },
        entryLabel: decl.label ?? null,
        verify: { kind: decl.verify, ref: 'package-map' },
        precondition: decl.precondition ?? null,
        preconditionNote: decl.preconditionNote ?? null,
        why: `package-map 有 ${pm.broken.length} 条指向解析不到实体（期望 = 每条 url 都能解析到存在目录）；修法入口 = 已声明脚本${decl.precondition ? `，**真执行需 DSH 已停**` : ''}`,
      });
    }
  } else {
    out.skipped.push({ id: 'pointer:package-map', class: 'pointer', ref: 'package-map', title: 'package-map 指向', reason: 'healthy' });
  }

  out.summary = {
    patchChecked: out.sources.patch.checked,
    patchDrifted: out.sources.patch.drifted,
    pointerChecked: 2,
    pointerDrifted: closureDrifted + ((pm.broken?.length ?? 0) > 0 ? 1 : 0),
    candidates: out.candidates.length,
    reportOnly: out.reportOnly.length,
    skipped: out.skipped.length,
  };
  return out;
}

// ---------------------------------------------------------------- 规划（纯函数）

/** 候选集合 → 去重签名（同一批候选 = 同一签名；集合变了 = 自动归零重算）。 */
export function candidateSigKey(candidates) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((c) => `${c.id}:${JSON.stringify(c.before ?? null)}`)
    .sort();
  return sigKeyOf(HEAL_KIND, 'batch', sha256(list.join('\n')).slice(0, 32));
}

/**
 * 规划一轮修复（**纯函数，零副作用**）。
 * 决策树（顺序即优先级）：
 *   1. 无可修候选 → `idle`（无漂移）或 `report-only`（有漂移但没有可证明的修法）
 *   2. L2 模块闸门关闭 → `blocked`
 *   3. 单日上限已用尽 → `quota-exhausted`
 *   4. 24h 内同批候选已处理 → `dedup`
 *   5. 否则 → `heal`（单轮最多 min(HEAL_MAX_ITEMS_PER_ROUND, limits.maxActionsPerTick) 项）
 */
export function planHeal(scan = {}, opts = {}) {
  const now = num(opts.now ?? scan.now, Date.now());
  const limits = opts.limits ?? {};
  const state = opts.state ?? {};
  const maxPerDay = num(limits.maxAutoActionsPerDay, FALLBACK_MAX_PER_DAY);
  const maxPerTickRaw = num(limits.maxActionsPerTick, HEAL_MAX_ITEMS_PER_ROUND);
  const maxItems = Math.max(1, Math.min(HEAL_MAX_ITEMS_PER_ROUND, maxPerTickRaw > 0 ? maxPerTickRaw : HEAL_MAX_ITEMS_PER_ROUND));
  // 【施工卡 ⑥-3】分池：判自己的 kind 池 + 生态总闸（`pools` 未配置 ⇒ 与改动前逐字节一致）
  const daily = checkDailyLimit(state, localDay(now), maxPerDay, { kind: HEAL_KIND, pools: limits.pools });
  const candidates = Array.isArray(scan.candidates) ? scan.candidates : [];
  const reportOnly = Array.isArray(scan.reportOnly) ? scan.reportOnly : [];
  const skipped = Array.isArray(scan.skipped) ? scan.skipped : [];
  const moduleGate = opts.moduleGate ?? { allowed: false, reason: '未判定（调用方须传 moduleGate）' };

  const base = {
    kind: HEAL_KIND, now, day: localDay(now),
    decision: 'idle', reason: 'no-drift', wouldHeal: false, note: NOTE_BY_REASON['no-drift'],
    sigKey: null, items: [], reportOnly, skipped, deferred: 0, truncated: 0,
    gate: { module: moduleGate }, sources: scan.sources ?? null,
    quota: daily, limits: { maxAutoActionsPerDay: maxPerDay, maxItemsPerRound: maxItems },
    summary: scan.summary ?? null,
    classes: HEAL_CLASSES,
  };

  // 1) 无可修候选
  if (!candidates.length) {
    if (reportOnly.length) {
      return { ...base, decision: 'report-only', reason: 'report-only', note: `${NOTE_BY_REASON['report-only']}（报告项 ${reportOnly.length} 条）` };
    }
    return base;
  }

  const sigKey = candidateSigKey(candidates);
  const planned = candidates.slice(0, maxItems);
  const withItems = {
    ...base, sigKey,
    items: planned,
    deferred: Math.max(0, candidates.length - planned.length),
    truncated: Math.max(0, candidates.length - planned.length),
  };

  // 2) L2 模块闸门
  if (!moduleGate.allowed) {
    return { ...withItems, decision: 'blocked', reason: 'module-gate-off', note: `${NOTE_BY_REASON['module-gate-off']}：${moduleGate.reason}` };
  }
  // 3) 单日上限
  if (daily.reached) {
    return { ...withItems, decision: 'quota-exhausted', reason: 'daily-limit', note: `${NOTE_BY_REASON['daily-limit']}（${daily.reason}）` };
  }
  // 4) 24h 去重（同批候选）
  const dup = checkSignature(state, sigKey, now, num(limits.dedupWindowMs, 24 * 3600 * 1000));
  if (dup.dup) {
    return { ...withItems, decision: 'dedup', reason: 'dedup', note: `${NOTE_BY_REASON.dedup}：${dup.reason}` };
  }
  // 5) 可修
  return {
    ...withItems, decision: 'heal', reason: 'pending', wouldHeal: true, note: NOTE_BY_REASON.pending,
    items: planned.map((i) => ({ ...i, willHeal: true, healed: false })),
  };
}

/** 精简单项（dry-run 记账 / 执行记账用；**必须可 JSON 化**）。 */
function slimItem(i) {
  return {
    id: i.id, class: i.class, ref: i.ref, title: i.title ?? null,
    reason: i.reason ?? null, note: i.note ?? null, why: i.why ?? null,
    script: i.script ?? null, entryPath: i.entry?.path ?? null, entryArgs: i.entry?.args ?? null,
    entryLabel: i.entryLabel ?? null,
    verifyKind: i.verify?.kind ?? null,
    precondition: i.precondition ?? null, preconditionNote: i.preconditionNote ?? null,
    problems: (i.problems ?? []).slice(0, 3),
    before: i.before ?? null,
    willHeal: i.willHeal === true, healed: i.healed === true,
  };
}

/** 预览形状（dry-run 的"若开启会修什么"）。 */
export function healPreview(plan, opts = {}) {
  const maxItems = num(opts.maxItems, PREVIEW_MAX_ITEMS);
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const reportOnly = Array.isArray(plan?.reportOnly) ? plan.reportOnly : [];
  return {
    action: HEAL_KIND,
    at: num(opts.now ?? plan?.now, Date.now()),
    day: plan?.day ?? null,
    decision: plan?.decision ?? null,
    reason: plan?.reason ?? null,
    wouldHeal: plan?.wouldHeal === true,
    note: plan?.note ?? null,
    gate: plan?.gate ?? null,
    sources: plan?.sources ?? null,
    classes: HEAL_CLASSES,
    quota: plan?.quota ? { day: plan.quota.day, used: plan.quota.used, max: plan.quota.max, reached: plan.quota.reached } : null,
    limits: plan?.limits ?? null,
    summary: plan?.summary ?? null,
    items: items.slice(0, maxItems).map(slimItem),
    reportOnly: reportOnly.slice(0, maxItems).map(slimItem),
    skipped: (plan?.skipped ?? []).slice(0, maxItems).map(slimItem),
    deferred: plan?.deferred ?? 0,
    truncated: Math.max(0, items.length - maxItems),
    note2: 'dry-run：只算不动 —— `items[].willHeal=true` 就是若放行会被执行的修复项；未执行任何脚本、未写任何状态',
  };
}

// ---------------------------------------------------------------- 执行体（唯一闸门）

/** 默认修法执行器（**薄壳**：真进程在 lib/auto-heal-channel.mjs；测试可注入 deps.runRepair）。 */
export function defaultRunRepair(item, ctx = {}) {
  if (typeof ctx.deps?.runRepair === 'function') return ctx.deps.runRepair(item, ctx);
  return runEntry(item.entry, { timeoutMs: ctx.entryTimeoutMs ?? HEAL_ENTRY_TIMEOUT_MS });
}

/**
 * 默认自检（**同源判定复检**：修完用"判它坏的那一套"再判一次）。
 * 失败/判不了 → `{ok:false}` → 调用方**立刻停**。
 */
export async function defaultVerifyItem(item, ctx = {}) {
  if (item.class === 'patch') {
    const ps = await readPanelState({ ...ctx, deps: ctx.deps });
    if (ps.ok !== true) return { ok: false, reason: `期望状态源不可得（${ps.reason}）→ 无法证明修完对` };
    const row = (ps.patches ?? []).find((p) => String(p?.id ?? '') === item.ref);
    if (!row) return { ok: false, reason: `面板补丁表里已找不到 ${item.ref} → 无法证明` };
    return row.healthy === true
      ? { ok: true, reason: '面板复检 healthy=true' }
      : { ok: false, reason: `面板复检仍不健康（${row.status}）：${(row.problems ?? []).slice(0, 2).join('；')}` };
  }
  if (item.class === 'pointer' && item.ref === 'closure') {
    const sc = scanClosure(ctx);
    if (sc.ok !== true) return { ok: false, reason: `闭包扫描不可用（${sc.reason}）→ 无法证明修完对` };
    const drifted = (sc.polluted?.length ?? 0) + (sc.broken?.length ?? 0);
    return drifted === 0
      ? { ok: true, reason: '闭包复检干净（污染 0 / 断链 0）' }
      : { ok: false, reason: `闭包复检仍有漂移（污染 ${sc.polluted?.length ?? 0} / 断链 ${sc.broken?.length ?? 0}）` };
  }
  if (item.class === 'pointer' && item.ref === 'package-map') {
    // 同源复检：用"判它坏的那一套"（scanPackageMapDrift）再判一次
    const pm = scanPackageMapDrift(ctx);
    if (pm.ok !== true) return { ok: false, reason: `package-map 不可读（${pm.reason}）→ 无法证明修完对` };
    return pm.broken.length === 0
      ? { ok: true, reason: 'package-map 复检：全部 url 可命中（断指 0）' }
      : { ok: false, reason: `package-map 复检仍有 ${pm.broken.length} 条断指` };
  }
  // 其它（未来的）类：**判不了就不算修好**（fail-closed）
  return { ok: false, reason: `没有为 ${item.class}/${item.ref} 定义自检口径 → 按未修好处理（fail-closed）` };
}

/** 单项修复 + 自检 + 审计（**执行面唯一的写点**）。 */
async function healOne(item, ctx = {}) {
  const now = num(ctx.now, Date.now());
  const out = {
    id: item.id, class: item.class, ref: item.ref, title: item.title ?? null,
    ok: false, changed: false, exitCode: null, ms: null, error: null,
    entry: item.entry?.path ?? null, entryArgs: item.entry?.args ?? null,
    verify: null, before: item.before ?? null, after: null, at: now,
  };
  // 执行前的**二次入口校验**（TOCTOU 式：规划与执行之间入口可能被删/被改）
  let ran;
  try {
    ran = defaultRunRepair(item, ctx);
  } catch (e) {
    ran = { ok: false, exitCode: null, error: `入口执行抛错：${e?.message ?? e}`, ms: 0 };
  }
  out.exitCode = ran?.exitCode ?? null;
  out.ms = ran?.ms ?? null;
  out.rejected = ran?.rejected === true;
  const execOk = ran?.ok === true;
  if (!execOk) {
    out.error = ran?.error ?? `入口退出码 ${ran?.exitCode}`;
    if (ran?.stderr) out.error = `${out.error}｜stderr: ${String(ran.stderr).slice(-300)}`;
  } else {
    // 修完**立刻自检**（同源判定）；自检判不了 = 没修好（fail-closed）
    let v;
    try {
      v = typeof ctx.deps?.verifyItem === 'function' ? await ctx.deps.verifyItem(item, ctx) : await defaultVerifyItem(item, ctx);
    } catch (e) {
      v = { ok: false, reason: `自检抛错：${e?.message ?? e}` };
    }
    out.verify = v;
    out.ok = v?.ok === true;
    // 「changed」= 改动生效**且被自检证明**（自检不过不算修好、也不算 changed）
    out.changed = out.ok === true;
    out.after = { verified: out.ok, reason: v?.reason ?? null };
    if (!out.ok) out.error = `自检未通过：${v?.reason ?? 'unknown'}`;
  }
  try {
    appendAudit({
      type: 'auto-heal', item: out.id, class: out.class, ref: out.ref,
      entry: out.entry, entryArgs: out.entryArgs,
      ok: out.ok, exitCode: out.exitCode, ms: out.ms, rejected: out.rejected === true,
      error: out.error, verify: out.verify, before: out.before, after: out.after,
    }, { home: ctx.home, silent: true });
  } catch { /* 审计失败不反噬修复本身 */ }
  return out;
}

/**
 * 跑一轮「组件自修复」动作。
 *   三条路径（语义与 runAction 一致）：
 *     dryRun:true      → 永远可跑：只算不动，写一条 dry-run 影子记账（供影子视图/日报），**零执行**
 *     四门任一关        → status='blocked'，**零副作用**（不写记账、不占额度、不跑任何脚本）
 *     四门全开 + 有漂移 → runAction 放行后逐项修复（**每项修完立即自检，失败即停**）
 */
export async function runAutoHeal(spec = {}, opts = {}) {
  const now = num(opts.now ?? spec.now, Date.now());
  const home = opts.home ?? spec.home ?? dshHome();
  const dryRun = spec.dryRun === true || opts.dryRun === true;
  const limits = spec.limits ?? readLimits({ home });
  const state = spec.state ?? readActionsState({ home });

  const out = {
    kind: HEAL_KIND, ok: true, dryRun, status: null, reason: null,
    home, now, day: localDay(now), moduleGate: null, plan: null, action: null, preview: null,
    candidates: 0, healed: 0, failed: 0, stopped: false, blocked: 0, noop: 0, results: [],
  };

  // 1) 只读采集（失败 → 本轮不规划、不写任何东西）
  const scan = spec.scan ?? await scanDrift({ home, now, toolsRoot: spec.toolsRoot, deps: spec.deps, linkRoot: spec.linkRoot, sourceRoot: spec.sourceRoot, profileDir: spec.profileDir, panelUrl: spec.panelUrl, baseUrl: spec.baseUrl, env: spec.env });
  if (!scan.ok) return { ...out, ok: false, status: 'collect-failed', reason: scan.error };

  // 2) 模块级闸门（L0 × L1 × L2）；dry-run **不受闸门限制**（只算不动）
  const moduleGate = checkModuleAllowed(HEAL_KIND, { home, autonomy: spec.autonomy });
  out.moduleGate = moduleGate;

  // 3) 规划（纯函数，零副作用）
  const plan = spec.plan ?? planHeal(scan, { now, limits, state, moduleGate });
  out.plan = plan;
  out.candidates = plan.items.length;

  if (!dryRun && !moduleGate.allowed) {
    return { ...out, ok: true, status: 'blocked', reason: `L2 模块闸门关闭：${moduleGate.reason}`, blocked: plan.items.length };
  }

  // 4a) dry-run：一条轮级影子记账（明细在 detail 里），零执行
  if (dryRun) {
    const preview = healPreview(plan, { now });
    out.preview = preview;
    const r = await runAction({
      kind: HEAL_KIND, level: HEAL_LEVEL, dryRun: true, home, now,
      detail: preview, preview: () => preview,
    }, { home, now });
    out.action = r;
    out.status = r.status;
    out.reason = r.reason;
    return out;
  }

  // 4b) 决策不是 heal → noop（不写签名、不占额度、零副作用）
  if (!plan.wouldHeal) {
    return {
      ...out, status: 'noop', decision: plan.decision,
      reason: `本轮不修复（decision=${plan.decision}：${plan.note || plan.reason}）`,
      noop: 1,
    };
  }

  // 4c) 执行（唯一闸门 runAction → 内含 L0 降档闸 + p3-auto 总闸 + 去重 + 上限 + 预算）
  const ctx = {
    home, now, deps: spec.deps, entryTimeoutMs: spec.entryTimeoutMs,
    toolsRoot: spec.toolsRoot, linkRoot: spec.linkRoot, sourceRoot: spec.sourceRoot,
    profileDir: spec.profileDir, panelUrl: spec.panelUrl, baseUrl: spec.baseUrl, env: spec.env,
  };

  const r = await runAction({
    kind: HEAL_KIND, level: HEAL_LEVEL, dryRun: false, home, now,
    consumesQuota: true,
    sigKey: plan.sigKey,
    detail: healPreview(plan, { now }),
    revertHint: '回滚 = 补丁脚本自带的备份（各 patch 脚本自动留档）+ 闭包修复脚本自带的回滚清单；本动作自身不删任何东西',
    execute: async () => {
      const results = [];
      let stopped = false;
      let stoppedBy = null;
      for (const item of plan.items) {
        if (stopped) {                                    // **失败即停：不许连环修**
          results.push({ id: item.id, ok: false, changed: false, skipped: true, reason: `前一项失败即停（${stoppedBy}）` });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const one = await healOne(item, ctx);
        results.push(one);
        if (one.ok !== true) { stopped = true; stoppedBy = `${item.id}: ${one.error ?? '未知失败'}`; }
      }
      const healed = results.filter((x) => x.ok === true && x.changed === true).length;
      const failed = results.filter((x) => !x.ok && !x.skipped).length;
      const skipped = results.filter((x) => x.skipped).length;
      return {
        // ⚠️ 只有"一项都没尝试"才算 noop；尝试过但自检不过 = 真失败（必须回报 failed，不许伪装成"没事做"）
        kind: (healed > 0 || failed > 0) ? HEAL_KIND : 'noop',
        ok: failed === 0,
        changed: healed,
        healed, failed, stopped, stoppedBy, skipped,
        total: results.length,
        deferred: plan.deferred,
        results,
        error: failed ? `${failed} 项修复失败（已按"失败即停"停手）` : null,
      };
    },
  }, { home, now, executeTimeoutMs: spec.executeTimeoutMs });

  out.action = r;
  out.status = r.status;
  out.reason = r.reason;
  out.healed = num(r.result?.healed, 0);
  out.failed = num(r.result?.failed, 0);
  out.stopped = r.result?.stopped === true;
  out.results = r.result?.results ?? [];
  if (r.status === 'executed') out.ok = out.failed === 0;
  else if (r.status === 'failed') out.ok = false;
  else if (r.status === 'noop') out.noop = 1;
  else out.blocked = plan.items.length;

  // 轮级审计（逐项审计在 healOne 里；这里留一条轮摘要，便于"这一轮发生了什么"一眼可查）
  try {
    appendAudit({
      type: 'auto-heal-round', status: r.status, decision: plan.decision, sigKey: plan.sigKey,
      items: plan.items.length, deferred: plan.deferred,
      healed: out.healed, failed: out.failed, stopped: out.stopped,
      moduleGate: moduleGate.reason, dryRun: false,
    }, { home, silent: true });
  } catch { /* 审计失败不反噬 */ }
  return out;
}

/** 一轮摘要（CLI / 报表用；纯只读）。 */
export function summarizeAutoHeal(result) {
  const p = result?.plan ?? null;
  return {
    kind: HEAL_KIND, dryRun: result?.dryRun === true, status: result?.status ?? null, reason: result?.reason ?? null,
    decision: p?.decision ?? null, decisionReason: p?.reason ?? null, wouldHeal: p?.wouldHeal === true,
    patchChecked: p?.sources?.patch?.checked ?? null, patchSourceOk: p?.sources?.patch?.ok ?? null,
    closureLevel: p?.sources?.closure?.level ?? null,
    closurePolluted: p?.sources?.closure?.polluted ?? null, closureBroken: p?.sources?.closure?.broken ?? null,
    packageMapEntries: p?.sources?.packageMap?.entries ?? null, packageMapBroken: p?.sources?.packageMap?.broken ?? null,
    candidates: p?.items?.length ?? 0, reportOnly: p?.reportOnly?.length ?? 0, skipped: p?.skipped?.length ?? 0,
    deferred: p?.deferred ?? 0, maxItemsPerRound: p?.limits?.maxItemsPerRound ?? null,
    quota: p?.quota ?? null,
    healed: result?.healed ?? 0, failed: result?.failed ?? 0, stopped: result?.stopped === true,
    blocked: result?.blocked ?? 0, noop: result?.noop ?? 0,
    moduleGate: result?.moduleGate?.reason ?? null,
  };
}

// ---------------------------------------------------------------- CLI（恒 dry-run）

/**
 * CLI 参数解析（**纯函数，单测入口**；顺序扫描：flag 与取值成对消费，剩下的才算未知）。
 * @returns {{help:boolean, json:boolean, home:string|null, toolsRoot:string|null, panelUrl:string|null, unknown:Array<string>}}
 */
export function parseCliArgs(argv = []) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const boolFlags = new Set(['--dry-run', '--json', '--help', '-h']);
  const valueFlags = new Set(['--home', '--tools-root', '--panel-url']);
  const out = { help: list.includes('-h') || list.includes('--help'), json: list.includes('--json'), home: null, toolsRoot: null, panelUrl: null, unknown: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (boolFlags.has(a)) continue;
    if (valueFlags.has(a)) {
      const v = list[i + 1];
      const hasValue = v !== undefined && !boolFlags.has(v) && !valueFlags.has(v);
      i += 1;
      if (!hasValue) { out.unknown.push(`${a}（缺取值）`); continue; }
      if (a === '--home') out.home = v;
      else if (a === '--tools-root') out.toolsRoot = v;
      else out.panelUrl = v;
      continue;
    }
    out.unknown.push(a);
  }
  return out;
}

function printUsage() {
  process.stdout.write([
    '用法: node <dsh-butler>/lib/auto-heal.mjs [--dry-run] [--json] [--home <dir>] [--tools-root <dir>] [--panel-url <url>]',
    '',
    '  --dry-run     默认行为（只算不动：写一条 dry-run 影子记账；**不跑任何脚本、不改任何文件**）',
    '  --json        以 JSON 输出完整计划',
    '  --home        指定 home（默认 ~/.dsh）；**单测/沙箱演示用**，不改变生产',
    '  --tools-root  补丁脚本所在目录（默认 <workspace>\\tools 或 $DSH_TOOLS_DIR）',
    '  --panel-url   生态面板 state URL（默认 http://127.0.0.1:3080/api/dsh-ecosystem-panel/state）',
    '',
    '⚠️ 本 CLI **只提供 dry-run**：真实修复只能由动作调用方（将来的 tick 接线）走 runAutoHeal()。',
    '   四门全关时任何真实执行路径一律 blocked 且零副作用（红线）。',
    '',
  ].join('\n'));
}

async function cliMain(argv) {
  const args = parseCliArgs(argv);
  if (args.help) { printUsage(); return 0; }
  if (args.unknown.length) {
    process.stderr.write(`未知参数：${args.unknown.join(' ')}\n`);
    printUsage();
    return 2;
  }
  const now = Date.now();
  const home = args.home ? path.resolve(args.home) : dshHome();
  const result = await runAutoHeal({ home, now, dryRun: true, toolsRoot: args.toolsRoot ?? undefined, panelUrl: args.panelUrl ?? undefined });
  const sum = summarizeAutoHeal(result);
  const p = result.plan ?? null;

  if (args.json) {
    process.stdout.write(JSON.stringify({
      home, device: process.env.COMPUTERNAME ?? null, summary: sum,
      result: { ...result, plan: p ? { ...p, skipped: p.skipped } : null, scan: undefined },
    }, null, 2) + '\n');
    return result.ok ? 0 : 1;
  }

  const yn = (b) => (b === true ? '是' : '否');
  const L = [
    '[auto-heal] dry-run（只算不动；未跑任何修法脚本、未改任何文件）',
    `  home        : ${home}`,
    `  决策        : ${p?.decision ?? '?'}`,
    `  理由        : ${p?.reason ?? '?'}（${p?.note ?? ''}）`,
    `  会修复      : ${yn(p?.wouldHeal)}（单轮上限 ${p?.limits?.maxItemsPerRound ?? '?'} 项）`,
    `  期望状态源  : 补丁 ${p?.sources?.patch?.ok ? `ok（校验 ${p.sources.patch.checked} 项 / 漂移 ${p.sources.patch.drifted} 项）` : `不可得（${p?.sources?.patch?.reason}）`}`,
    `              : 闭包 ${p?.sources?.closure?.ok ? `${p.sources.closure.level}（${p.sources.closure.total} 链接 / 污染 ${p.sources.closure.polluted} / 断链 ${p.sources.closure.broken}）` : `不可用（${p?.sources?.closure?.reason}）`}`,
    `              : package-map ${p?.sources?.packageMap?.ok ? `${p.sources.packageMap.entries} 条目 / 断指 ${p.sources.packageMap.broken}` : `不可读（${p?.sources?.packageMap?.reason}）`}`,
    `  L2 模块门   : allowed=${result.moduleGate?.allowed ?? '?'}（${result.moduleGate?.reason ?? '?'}）`,
    `  配额        : 今日 ${p?.quota?.used ?? 0}/${p?.quota?.max ?? 0}${p?.quota?.reached ? '（已用尽）' : ''}`,
    '  可修候选    ：',
  ];
  const cands = p?.items ?? [];
  if (!cands.length) L.push('    （无）');
  for (const c of cands.slice(0, PREVIEW_MAX_ITEMS)) {
    L.push(`    - [${c.class}] ${c.id}：${c.title ?? ''}`);
    L.push(`        ${c.why ?? c.note ?? ''}`);
    L.push(`        入口：${c.entry?.path ?? '（无）'}${(c.entry?.args ?? []).length ? ' ' + c.entry.args.join(' ') : ''}`);
    if (c.precondition) L.push(`        前置：${POINTER_PRECONDITIONS[c.precondition] ?? c.precondition}`);
  }
  if ((p?.deferred ?? 0) > 0) L.push(`    … 另有 ${p.deferred} 项超单轮上限，留到下一轮`);
  const rep = p?.reportOnly ?? [];
  L.push('  只报告（不动手）：');
  if (!rep.length) L.push('    （无）');
  for (const r of rep.slice(0, PREVIEW_MAX_ITEMS)) L.push(`    - [${r.class}] ${r.id}：${r.reason} —— ${r.note ?? ''}`);
  L.push(`  dry-run 记账：${result.status === 'dry-run' ? '已写 1 条（dryRun=true，不占额度、不写签名）' : `未写（status=${result.status}）`}`);
  process.stdout.write(L.join('\n') + '\n');
  return result.ok ? 0 : 1;
}

// 入口守卫：junction/实体化场景下 import.meta.url 会解析为物理路径，而 argv[1] 是逻辑路径
// ⇒ 必须双方 realpath 后再比（persona 铁律：字符串直比会静默退出 0）
const isMainEntry = (() => {
  try {
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return Boolean(argv1) && argv1 === self;
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  cliMain(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      process.stderr.write(`[auto-heal] 失败：${e?.stack ?? e}\n`);
      process.exitCode = 1;
    });
}
