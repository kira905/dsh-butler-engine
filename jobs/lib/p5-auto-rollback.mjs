// dsh-butler / lib/p5-auto-rollback.mjs —— P5 B 层写后审计违规「自动回滚」动作（L2 模块 `p5-auto-rollback` 的执行体）
//
// 由来：`docs\管家-开关矩阵与放行判据-20260913.md` §3.1 待实现动作清单第 3 项（卡：V3 全量开发 批次 5）。
//   规则 R2「锁后交付」：代码进生产 + 开关默认关 + 单测/夹具 + dry-run 可跑 + 生产零动作强断言 + 回滚点 + 演练 + 登记 + 流水。
//
// 【动作语义（照矩阵 §3 表，不自创）】
//   矩阵 §3 表该行：`p5-auto-rollback` = 「P5 B 层自动回滚（写后审计发现违规自动回滚）」，护栏 = 「写前快照 + 审计链」。
//   落地成一句话：**把「B 层磁盘 watcher 已判违规、但当时回滚门关着（只告警）的文件」用既有快照回滚回最近合法内容。**
//     · 数据源 = `~/.dsh/butler-watch-fs-state.json` 的 `files[<path>].violation`（只认 `rolledBack !== true` 的未处理违规）
//     · 判定口径 = 本文件自己的纯函数（**不回滚任何东西**），执行 = 复用既有快照文件（见下方"边界①②"）
//     · 审计链校验（矩阵该行放行判据原文「需审计链校验单测」）：链断 / 篡改 → **拒绝自动回滚**（fail-safe）
//     · 24h 去重（按"候选集合"签名）+ 单日上限 + token 预算门（后三条由 runAction 既有护栏承担）
//
// 【边界（改本文件前必读）】
//   ① **回滚能力已经存在，本文件只做薄封装**：真实回滚 = 把 `state.files[file].snap` 快照文件
//      `copyFileSync` 回原路径 —— 与 `butler-watch-fs.mjs scanOnce()` 的回滚分支**同一算法**（同一份快照、同一落点）。
//      `butler-watch-fs.mjs` **一行不改**（本卡红线），本文件**不重写第二套回滚算法**（无新规则引擎、无新快照机制）。
//      备份侧也没有第二套：快照由 `scanOnce()` 的 `ensureSnap()` 建立，本文件只读它的路径。
//   ② 执行前**必须**重新核对"计划时的现状 hash == 执行时的现状 hash"（TOCTOU 守卫）：规划与执行之间文件
//      若又被写过（尤其可能又被写坏），宁可不回滚也不能拿旧快照覆盖新内容 —— 直接用 `sha256` 比对。
//   ③ 所有执行走 `lib/autonomy-actions.mjs` 的 `runAction()` **唯一闸门**：dry-run 永远可跑（只算不动）；
//      `dryRun:false` 时四门任一关 → `blocked` 且零副作用（不写记账、不占额度、不回滚任何文件）。
//
// 【闸门（两道串联 + 一道校验，fail-safe 方向更严）】
//   · 模块级：`checkModuleAllowed('p5-auto-rollback')` = L0 降档 × L1 owner（`autoHealEnabled`）× L2 `modules['p5-auto-rollback']`
//   · 动作级：`runAction({kind:'p5-auto-rollback'})` 内置 p3-auto 总闸 + 24h 去重 + 单日上限 + token 预算门
//   · 数据级：**审计链校验**（`butler-audit-verify.mjs` 的 `verifyChain()`）—— 链不完整 → 不自动回滚
//     【L-13 2026-09-23】该道判据已认「**已知历史断点白名单**」（`lib/known-chain-breaks.json`，
//     与 `butler-audit-verify.mjs` / `lib/audit-chain-watch.mjs` **共用同一份清单与同一套匹配**）：
//     清单内已定性的既成断点放行、**清单外任何新断点（含坏行 / hash-mismatch）照旧拦**。改前不认白名单
//     ⇒ 只要流水历史上留过已定性断点就恒 fail-closed ⇒ P5 自动回滚永久不可用。
//
// ⚠️ 【L1 归属的已知不一致 —— 本卡**只报告不修改**（改开关归属属放行面，须主人拍板）】
//     矩阵 §3 表该行「归属 L1 总开关」列写 `p5AutoRollbackEnabled`；`lib/autonomy-modules.mjs:58` 的 `owner`
//     写 `autoHealEnabled`；而 `lib/autonomy.mjs:28/66` 的真实口径是**两把键与**（`autoHealEnabled && p5AutoRollbackEnabled`）。
//     ⇒ `checkModuleAllowed()` 只读 `owner` 一把键 ⇒ 漏了 raw 键 `p5AutoRollbackEnabled`；而 `runAction()`
//     第三道闸恒查 `autoAllowed('p3-auto')`（`p3AutoEnabled`）—— 二者都与矩阵声明列不一致。
//     本文件**按现状调用**（不复刻第二套、不擅自改归属）；实测结论与建议见本卡交付报告「验收 6」。
//
// 【本卡红线（2026-09-13 批次 5）】**不接线到任何 tick**（`butler-tickd.mjs` 一行不动）；
//   `butler-watch-fs.mjs` / `lib/audit.mjs` / `butler-audit-verify.mjs` 及 `butler-watch-fs-state.json`
//   的 schema **一行/一字段不动**；真实回滚**只允许发生在沙箱 home + 沙箱 dshRoot**（单测夹具强断言）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome, butlerPaths, monthKey } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { checkModuleAllowed } from '../../src/dsh-butler/lib/autonomy-modules.mjs';
import {
  runAction, checkDailyLimit, checkSignature, readActionsState, readLimits, localDay, sigKeyOf, sha256,
} from '../../src/dsh-butler/lib/autonomy-actions.mjs';
import { appendAudit } from '../../src/dsh-butler/lib/audit.mjs';
// 【L-13 2026-09-23】白名单**唯一源** = 本模块的 `loadKnownBreaks()`（清单 lib/known-chain-breaks.json）+
//   `verifyChain()` 内的匹配逻辑（index + reason + 签名三者全等，签名口径来自 lib/audit-chain-watch.mjs
//   的 `chainProblemSig()`）。p5 侧**不解析、不匹配第二套**——只 import 复用（与 butler-audit-verify.mjs /
//   audit-chain-watch.mjs「两处一套写法」的既有先例同款）。
import { verifyChain, loadKnownBreaks, DEFAULT_KNOWN_BREAKS_FILE } from '../butler-audit-verify.mjs';

// ⚠️ 版本号与底座自检的关系：`verify.mjs` 要求"登记表里所有组件版本 == 产品版本"，
//    故本模块**不单独 bump**（同 lib/queue-wake.mjs / lib/p0-auto-restart.mjs 的口径）；
//    本卡交付靠注释 + 变更流水 + 交付报告追溯。

/** 动作 kind（与 `AUTO_ACTION_KINDS` 的键同名；L2 模块 id 亦同名 —— 矩阵 §3 列口径要求"同名才能对齐开关"）。 */
export const ROLLBACK_KIND = 'p5-auto-rollback';
/** 风险级（矩阵 §3 表：L2 = 有损可回滚；回滚会覆盖文件内容，但快照保证可再改回来）。 */
export const ROLLBACK_LEVEL = 'L2';
/** 目标档（矩阵 §3 表）——只作展示与放行判据的记录，不参与运行时判定。 */
export const ROLLBACK_TARGET_STAGE = 'S3';
/** 【2c-B2】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, opts = {}) {
  return resolveStatePath(name, { home: opts.home ?? dshHome() }).path;
}
/** B 层快照索引状态文件（**只读**；schema 由 butler-watch-fs.mjs 定义，本文件不改一字）。 */
export const WATCH_FS_STATE_NAME = 'butler-watch-fs-state.json';
/** 判定值（预览里可见）。 */
export const DECISIONS = ['rollback', 'idle', 'blocked', 'quota-exhausted', 'dedup'];

/** 仅在调用方未传 limits 时用的兜底值（与 lib/autonomy-actions.mjs 的 defaultLimits() 同口径）。 */
export const FALLBACK_MAX_PER_DAY = 5;
/** 预览里最多列几个候选文件。 */
export const PREVIEW_MAX_ITEMS = 8;
/**
 * 审计链校验读取的记录上限（超限只取尾部 + 记 truncated）。
 * ⚠️ 截断态有两个后果，都必须如实标注（见 `readAuditRecords` / `verifyAuditChain`）：
 *   ① 尾部首条会被当成"链起点" ⇒ **断链可能被静默放过**（结论仅作参考）；
 *   ② **历史断点白名单自动停用**——records 被 slice 后 index 与流水行号偏移，放行即误匹配。
 * 残留风险与处置（**2026-09-23 主人拍板 = 方案 A：提高上限**）：流水是**逐月累积**的（2026-09 已 10078 行），
 * 全量读取口径下数月内就会触到原上限 20000（粗算 **10 月中下旬**）⇒ 白名单再度失效、P5 自动回滚回到 fail-closed。
 * ⇒ 本常量 **20000 → 200000**（约 20 个月余量；代价 = 上限触顶时多读几 MB，当前全量约 1 秒级）。
 * 方案 B（按「月文件 + 起始偏移」锚定 index）能彻底摆脱"行号偏移"约束，但要动共享的 `verifyChain` 口径与 CLI，
 * 本次**未做**（留作将来可选升级）。真源：`docs\交付报告-0.1.5遗留治理执行-4-20260923.md` §5。
 */
export const AUDIT_RECORDS_MAX = 200000;

/** 判定 reason → 人话（预览里可见；**只做翻译，不改判定**）。 */
export const NOTE_BY_REASON = {
  'no-violation': 'watch-fs 状态里没有"未处理的违规"→ 本轮无事可做',
  'no-snapshot': '有未处理违规，但条目的快照路径缺失 → 无法回滚（只能人工处理）',
  'audit-chain-broken': '审计链校验未通过（断链 / 篡改，且不在「已知历史断点」清单内）→ 拒绝自动回滚（fail-safe）',
  'module-gate-off': 'L2 模块闸门关闭（L0 降档 / L1 归属 / L2 模块任一关）→ 不执行',
  'daily-limit': '单日上限已用尽 → 不执行',
  dedup: '24h 内同一批候选已回滚过 → 去重跳过',
  pending: '存在未处理的违规且快照齐备 → 可回滚',
};

function num(v, d) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return d;
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

/** 文件 sha256（读不到 → null）。 */
function fileSha(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

// ---------------------------------------------------------------- 审计链（数据级闸门：复用既有校验器）

/**
 * 读审计流水记录（**纯只读**）。
 *
 * 为什么读整月/全量而不是尾巴：`verifyChain()` 要求链条从"链起点"（旧记录，无 hash/prev）开始连续校验；
 * 只取尾部会让第一条被当成链起点，**断链会被静默放过**。故默认全月份逐行读取，仅在超过 AUDIT_RECORDS_MAX
 * 条这种病态体量下才退化为"取尾部 + 记 truncated"（此时**历史断点白名单停用**——index 会偏移，见
 * verifyAuditChain 的三个前提）。
 * 月口径：默认**全部月份**（白名单 index 是 CLI 的"全月份逐行"口径，两处必须一致）；显式给 `opts.month`
 * 时只读该月、`opts.allMonths === false` 时只读当前月（两种都会让白名单自动停用）。
 * 【L-13 2026-09-23 口径变更（坏行入列 + 默认全月份）】见函数内注释与
 *   `docs\交付报告-0.1.5遗留L13-P5回滚认白名单-20260923.md` §根因。
 * @returns {{records:Array, rawLines:Array<string>, files:Array<string>, truncated:boolean,
 *            unparsable:number, allMonths:boolean, error:string|null}}
 */
export function readAuditRecords(opts = {}) {
  const home = opts.home ?? dshHome();
  const dir = butlerPaths(home).auditDir;
  const out = { records: [], rawLines: [], files: [], truncated: false, unparsable: 0, allMonths: false, error: null };
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
  } catch (e) {
    out.error = `audit-dir-unreadable:${e?.message ?? e}`;
    return out;
  }
  const only = opts.month ?? monthKey();
  out.allMonths = opts.allMonths === true;
  const picked = out.allMonths ? names : names.filter((n) => n.startsWith(only));
  for (const n of picked) {
    out.files.push(n);
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // 【L-13 2026-09-23 口径变更】坏行**入列占位**（null）+ 同索引原始行，不再静默跳过：
      //   ① `verifyChain()` 的 index = 数组下标 ⇒ 只有 records 与流水行**一一对应**时它才等于
      //      「流水行号」，才能与 lib/known-chain-breaks.json 的 index 同口径（CLI 就是逐行占位口径）。
      //   ② 跳坏行会让其后所有 index 左移 ⇒ 白名单永远匹配不上。本卡实测（同一条生产链）：
      //      白名单登记 4483(unparsable)/4484/6012/8655，p5 报的是 4483/6011/8654 —— 差 1，全部失配。
      //   ③ 坏行本身就是 `unparsable` 断点类型，跳过它 = 静默放行一个真实断点（fail-open 方向），
      //      而本模块的数据级闸门是 fail-closed：宁可多报，不可漏报。
      out.rawLines.push(line);
      try { out.records.push(JSON.parse(line)); } catch { out.records.push(null); out.unparsable++; }
    }
  }
  const max = num(opts.max, AUDIT_RECORDS_MAX);
  if (max > 0 && out.records.length > max) {
    out.records = out.records.slice(-max);
    out.rawLines = out.rawLines.slice(-max);      // rawLines 与 records **始终同索引**（签名要用它算）
    out.truncated = true;
  }
  return out;
}

/**
 * 审计链校验（复用 `butler-audit-verify.mjs` 的 `verifyChain()` + `loadKnownBreaks()`；
 * 本文件**不重写校验算法、也不重写白名单匹配**）。
 *
 * 【L-13 2026-09-23：认「已知历史断点白名单」】改前本函数只调 `verifyChain(records)`、**不传白名单** ⇒
 * 只要审计流水历史上存在过**已定性**的断点（L-1 卡处置的 4 处：09-17 物理写坏空洞 + 09-20/09-22 两次
 * 并发分叉），判据就恒 fail-closed ⇒ **P5 自动回滚永久不可用**（既有行为，非某批引入）。改后：
 *   · 命中 `lib/known-chain-breaks.json`（index + reason + 签名三者全等）⇒ 记 known、**不算失败**；
 *   · **清单外的任何断点**（新 chain-break / 新坏行 / hash-mismatch）**照旧判失败** —— fail-closed 不变；
 *   · 放行条目必须自带成因 + 证据（`normalizeKnownBreaks()` 校验，缺一不生效，防"随手加一行"放行）。
 * 白名单启用的三个前提（任一不满足 ⇒ 严格口径，宁可报红、绝不误放行）：
 *   ① 调用方没显式关（`opts.useKnownBreaks === false`，对照验证用）；
 *   ② **未截断**（`truncated` 时 records 被 slice 成尾部 ⇒ index 相对流水行号偏移 ⇒ 不许放行）；
 *   ③ **全局读取口径**（只读单月时 index 同样偏移；CLI 的白名单也是"全月份逐行"口径）。
 * @returns {{ok:boolean, checked:number, problems:number, legacy:number, tail:string|null,
 *            files:Array<string>, truncated:boolean, error:string|null, reason:string, samples:Array,
 *            knownBreaksEnabled:boolean, knownBreaksFile:string|null, knownBreaksAvailable:number,
 *            knownBreaksRejected:number, knownBreaksError:string|null, knownAccepted:Array<object>}}
 */
export function verifyAuditChain(opts = {}) {
  // 读取范围：显式给 month ⇒ 只读该月（白名单随后自动停用）；默认全月份（与白名单同一 index 口径）
  const readOpts = opts.month ? { ...opts } : { ...opts, allMonths: opts.allMonths !== false };
  const src = readAuditRecords(readOpts);
  // 白名单唯一源：清单文件路径 + 解析 + 合法性校验都在 butler-audit-verify.mjs（本文件只消费）
  const reg = loadKnownBreaks(opts.registry ?? opts.knownBreaksFile ?? DEFAULT_KNOWN_BREAKS_FILE);
  const knownEnabled = opts.useKnownBreaks !== false
    && src.truncated !== true
    && src.allMonths === true
    && src.error === null
    && reg.error === null;
  const v = verifyChain(src.records, {
    rawLines: src.rawLines,
    ...(knownEnabled ? { knownBreaks: reg.entries } : {}),
  });
  const problems = Array.isArray(v.problems) ? v.problems : [];
  const accepted = Array.isArray(v.known) ? v.known : [];
  let ok = problems.length === 0;
  let reason;
  if (!ok) reason = `${problems.length} 条问题（${problems.slice(0, 3).map((p) => p.reason).join('、')}）`;
  else if (accepted.length) reason = `ok（清单内历史断点放行 ${accepted.length} 处）`;
  else reason = 'ok';
  if (src.truncated) {
    // 截断场景：尾部起点会被误当链起点 → 结论不可全信，如实标注；**白名单同时停用**（index 偏移）
    reason += '｜记录被截断（仅校验尾部，历史断点白名单已停用）';
  }
  if (knownEnabled && reg.rejected.length) reason += `｜清单有 ${reg.rejected.length} 条不生效`;
  if (src.error) { ok = false; reason = src.error.replace('audit-dir-unreadable', '审计目录不可读'); }
  return {
    ok, checked: num(v.checked, 0), problems: problems.length, legacy: num(v.legacy, 0),
    tail: v.tail ?? null, files: src.files, truncated: src.truncated, error: src.error,
    reason, samples: problems.slice(0, 5),
    knownBreaksEnabled: knownEnabled,
    knownBreaksFile: knownEnabled ? reg.file : null,
    knownBreaksAvailable: reg.entries.length,
    knownBreaksRejected: reg.rejected.length,
    knownBreaksError: reg.error,
    knownAccepted: accepted.map((k) => ({
      index: k.index, reason: k.reason, at: k.at ?? null, sig: k.sig ?? null,
      cause: k.cause ?? null, evidence: k.evidence ?? null,
    })),
  };
}

// ---------------------------------------------------------------- 只读采集（纯只读，零副作用）

/**
 * 采集「待回滚的违规」（**纯只读**：只读 watch-fs 状态 + 快照存在性 + 审计链；不写任何文件）。
 *
 * 数据源 = `butler-watch-fs-state.json`（由 `butler-watch-fs.mjs` 维护）。条目的 `violation` 形如
 *   `{ at, count, rolledBack:false, gate:'autonomy:…' }`
 * 语义：**B 层发现违规时回滚门是关的 → 只告警**，状态里就此留下一条"未处理违规"痕迹；
 * 本条目就是本动作的候选。判据（逐条）：
 *   · `violation` 存在且 `rolledBack !== true` → 未处理
 *   · `snap` 路径存在且非空 → 有快照可用（否则 skipped: no-snapshot）
 *   · 快照内容 hash 与条目记录的 `hash` 一致 → 快照就是"最近合法内容"（否则 skipped: snapshot-mismatch，
 *     宁可不回滚也不拿不可信快照覆盖文件）
 *   · 当前文件 hash == **快照 hash** → 已经是合法内容（skipped: already-legal，无需回滚）
 *
 * ⚠️ 与 watch-fs 的口径差异（如实说明）：watch-fs 判违规用**规则引擎**（`runRulesOn` + 保护区分类器）。
 *    本动作**不重跑规则引擎**——它消费的是 watcher 已经判定的结论（这样才不会出现"两个判定源"）。
 * @returns {{
 *   ok:boolean, error:string|null, home:string, now:number, day:string,
 *   stateFile:string, stateFound:boolean, stateUpdatedAt:number|null, watchSchemaVersion:number|null,
 *   scanned:number, violationMarked:number, candidates:Array<object>, skipped:Array<object>,
 *   auditChain:object
 * }}
 */
export function scanViolations(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = num(opts.now, Date.now());
  const stateFile = stateFileOf(WATCH_FS_STATE_NAME, { home });
  const raw = readJsonQuiet(stateFile);
  const files = (raw && raw.files && typeof raw.files === 'object') ? raw.files : null;
  const out = {
    ok: true, error: null, home, now, day: localDay(now),
    stateFile, stateFound: raw !== null, stateUpdatedAt: num(raw?.updatedAt, null),
    watchSchemaVersion: num(raw?.schemaVersion, null),
    scanned: files ? Object.keys(files).length : 0,
    violationMarked: 0, candidates: [], skipped: [],
    auditChain: null,
  };
  if (!files) {
    // 状态文件缺失/损坏 = 没有"已判定的违规"可言（fail-closed 方向：不猜、不回滚）
    out.auditChain = opts.skipAuditChain === true ? null : verifyAuditChain({ home, now });
    return out;
  }

  for (const [file, cell] of Object.entries(files)) {
    if (!cell || typeof cell !== 'object') continue;
    const vio = cell.violation;
    if (!vio || typeof vio !== 'object') continue;
    if (vio.rolledBack === true) continue;          // 已回滚过 → 无需再回滚
    out.violationMarked++;
    const snap = typeof cell.snap === 'string' && cell.snap.trim() ? cell.snap : null;
    const recordHash = typeof cell.hash === 'string' ? cell.hash : null;
    const item = {
      file, snap, recordHash,
      zone: cell.zone ?? null, tier: cell.tier ?? null,
      violationAt: num(vio.at, null), findingCount: num(vio.count, 0),
      gate: vio.gate ?? null, timeMs: num(cell.timeMs ?? cell.mtimeMs, null),
      curHash: null, snapHash: null,
    };
    if (!snap) { out.skipped.push({ file, reason: 'no-snapshot', note: '条目的 snap 字段缺失 → 无法回滚' }); continue; }
    if (!fs.existsSync(snap)) { out.skipped.push({ file, reason: 'no-snapshot', note: `快照文件不存在：${snap}` }); continue; }
    item.snapHash = fileSha(snap);
    // 快照"可信"的口径：条目没记 hash（旧状态）→ 无基准可驳，按可信；记了 → 必须与快照内容一致
    const snapTrusted = !recordHash || item.snapHash === recordHash;
    if (!snapTrusted) {
      out.skipped.push({ file, reason: 'snapshot-mismatch', note: `快照内容与条目记录 hash 不一致（snap=${String(item.snapHash).slice(0, 12)}… / 记录=${recordHash.slice(0, 12)}…）→ 不拿不可信快照覆盖文件` });
      continue;
    }
    if (!fs.existsSync(file)) {
      out.skipped.push({ file, reason: 'file-missing', note: '目标文件已不存在（可能已删/改名）→ 回滚无意义，交人工' });
      continue;
    }
    item.curHash = fileSha(file);
    // 「已还原」判据 = 文件现状**已经等于快照内容**（快照即"最近合法内容"的权威基准）。
    //   ① 不能用记录里的 `hash` 判：回滚门关着时 watch-fs 会把**违规内容的 hash** 采纳进状态
    //      （避免每 tick 重复告警），记录 hash ≠ 合法基线 → 拿它比会把"回滚后又被写坏"误判成已合法。
    //   ② 用 `curHash === snapHash` 则两面对：回滚过的文件（现状==快照）判已还原跳过；
    //      被再次写坏的文件（现状≠快照）照常进候选。
    //   ⚠️ 已知残留：回滚后**状态文件不会**被本动作改写（watch-fs 的 schema 归它自己管），
    //      故 `violation` 痕迹仍在 → 下轮候选集不变 → 靠 24h 去重签名(按现状 hash) 兜住；待接线时评估。
    if (item.snapHash && item.curHash === item.snapHash) {
      out.skipped.push({ file, reason: 'already-legal', note: '当前内容已等于快照内容（最近合法）→ 无需回滚' });
      continue;
    }
    out.candidates.push(item);
  }
  out.candidates.sort((a, b) => String(a.file).localeCompare(String(b.file)));
  out.skipped.sort((a, b) => String(a.file).localeCompare(String(b.file)));
  out.auditChain = opts.skipAuditChain === true ? null : verifyAuditChain({ home, now });
  return out;
}

// ---------------------------------------------------------------- 规划（纯函数）

/** 候选集合 → 去重签名（同一批候选 = 同一签名；集合变了 = 自动归零重算，无需过期机制）。 */
export function candidateSigKey(candidates) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((c) => `${c.file}:${String(c.curHash ?? '').slice(0, 12)}`)
    .sort();
  return sigKeyOf(ROLLBACK_KIND, 'batch', sha256(list.join('\n')).slice(0, 32));
}

/**
 * 规划一轮回滚（**纯函数，零副作用**）：给定采集结果 / 闸门判定 / 限额 → 出决策与候选清单。
 *
 * 决策树（顺序即优先级）：
 *   1. 候选为空            → `idle`（无事可做；没有未处理违规或快照不可用）
 *   2. 审计链校验未通过    → `blocked`（reason=audit-chain-broken；数据级 fail-safe，绝不用不可信审计做回滚决策）
 *   3. L2 模块闸门关闭      → `blocked`（reason=module-gate-off）
 *   4. 单日上限已用尽       → `quota-exhausted`
 *   5. 24h 内同批候选已回滚 → `dedup`
 *   6. 否则                → `rollback`（wouldRollback=true）
 * @returns {{
 *   kind:string, now:number, day:string, decision:string, reason:string, wouldRollback:boolean,
 *   note:string, sigKey:string|null, candidates:Array<object>, skipped:Array<object>,
 *   gate:object, auditChain:object|null, quota:object, limits:object,
 *   summary:{scanned:number, violationMarked:number, candidates:number, skipped:number}, truncated:number
 * }}
 */
export function planRollback(scan = {}, opts = {}) {
  const now = num(opts.now ?? scan.now, Date.now());
  const limits = opts.limits ?? {};
  const state = opts.state ?? {};
  const maxPerDay = num(limits.maxAutoActionsPerDay, FALLBACK_MAX_PER_DAY);
  // 【施工卡 ⑥-3】分池：判自己的 kind 池 + 生态总闸（`pools` 未配置 ⇒ 与改动前逐字节一致）
  const daily = checkDailyLimit(state, localDay(now), maxPerDay, { kind: ROLLBACK_KIND, pools: limits.pools });
  const candidates = Array.isArray(scan.candidates) ? scan.candidates : [];
  const skipped = Array.isArray(scan.skipped) ? scan.skipped : [];
  const moduleGate = opts.moduleGate ?? { allowed: false, reason: '未判定（调用方须传 moduleGate）' };
  const auditChain = scan.auditChain ?? null;

  const base = {
    kind: ROLLBACK_KIND, now, day: localDay(now),
    decision: 'idle', reason: 'no-violation', wouldRollback: false, note: NOTE_BY_REASON['no-violation'],
    sigKey: null, candidates: [], skipped,
    gate: { module: moduleGate, auditChain },
    auditChain, quota: daily, limits: { maxAutoActionsPerDay: maxPerDay },
    summary: {
      scanned: num(scan.scanned, 0),
      violationMarked: num(scan.violationMarked, 0),
      candidates: candidates.length,
      skipped: skipped.length,
    },
    truncated: Math.max(0, candidates.length - PREVIEW_MAX_ITEMS),
  };

  // 1) 无可回滚候选
  if (!candidates.length) {
    const why = num(scan.violationMarked, 0) > 0 ? 'no-snapshot' : 'no-violation';
    return { ...base, reason: why, note: NOTE_BY_REASON[why] };
  }

  const sigKey = candidateSigKey(candidates);
  const withItems = { ...base, sigKey, candidates };

  // 2) 审计链（数据级闸门）
  if (auditChain && auditChain.ok !== true) {
    return { ...withItems, decision: 'blocked', reason: 'audit-chain-broken', note: `${NOTE_BY_REASON['audit-chain-broken']}（${auditChain.reason}）` };
  }

  // 3) L2 模块闸门
  if (!moduleGate.allowed) {
    return { ...withItems, decision: 'blocked', reason: 'module-gate-off', note: `${NOTE_BY_REASON['module-gate-off']}：${moduleGate.reason}` };
  }

  // 4) 单日上限
  if (daily.reached) {
    return { ...withItems, decision: 'quota-exhausted', reason: 'daily-limit', note: `${NOTE_BY_REASON['daily-limit']}（${daily.reason}）` };
  }

  // 5) 24h 去重（同批候选）
  const dup = checkSignature(state, sigKey, now, num(limits.dedupWindowMs, 24 * 3600 * 1000));
  if (dup.dup) {
    return { ...withItems, decision: 'dedup', reason: 'dedup', note: `${NOTE_BY_REASON.dedup}：${dup.reason}` };
  }

  // 6) 可回滚
  return {
    ...withItems, decision: 'rollback', reason: 'pending', wouldRollback: true,
    note: NOTE_BY_REASON.pending,
    candidates: candidates.map((c) => ({ ...c, willRollback: true, rolledBack: false })),
  };
}

/** 精简单候选（dry-run 记账 / 执行记账用；**必须可 JSON 化**，不带大对象）。 */
function slimCandidate(c) {
  return {
    file: c.file, snap: c.snap, zone: c.zone, tier: c.tier,
    violationAt: c.violationAt, findingCount: c.findingCount,
    curHash: c.curHash, snapHash: c.snapHash,
    willRollback: c.willRollback === true, rolledBack: c.rolledBack === true,
    note: c.note ?? null,
  };
}

/**
 * 预览形状（dry-run 的"若开启会回滚什么"）。
 * @returns {{action:string, at:number, day:string, decision:string, reason:string, wouldRollback:boolean,
 *            note:string, gate:object|null, auditChain:object|null, quota:object|null,
 *            summary:object, candidates:Array<object>, skipped:Array<object>, truncated:number, note2:string}}
 */
export function rollbackPreview(plan, opts = {}) {
  const maxItems = num(opts.maxItems, PREVIEW_MAX_ITEMS);
  const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
  const skipped = Array.isArray(plan?.skipped) ? plan.skipped : [];
  const ac = plan?.auditChain ?? null;
  return {
    action: ROLLBACK_KIND,
    at: num(opts.now ?? plan?.now, Date.now()),
    day: plan?.day ?? null,
    decision: plan?.decision ?? null,
    reason: plan?.reason ?? null,
    wouldRollback: plan?.wouldRollback === true,
    note: plan?.note ?? null,
    gate: plan?.gate ?? null,
    auditChain: ac ? { ok: ac.ok, checked: ac.checked, problems: ac.problems, legacy: ac.legacy, reason: ac.reason, files: ac.files } : null,
    quota: plan?.quota ? { day: plan.quota.day, used: plan.quota.used, max: plan.quota.max, reached: plan.quota.reached } : null,
    summary: plan?.summary ?? null,
    candidates: candidates.slice(0, maxItems).map(slimCandidate),
    skipped: skipped.slice(0, maxItems),
    truncated: Math.max(0, candidates.length - maxItems),
    note2: 'dry-run：只算不动 —— 以上"willRollback=true 的候选"就是若放行会被回滚的文件；未回滚任何文件、未写任何状态',
  };
}

// ---------------------------------------------------------------- 执行体（唯一闸门）

/**
 * 回滚单个候选（**默认实现**：与 `butler-watch-fs.mjs scanOnce()` 的回滚分支同一算法 —— 快照 copyFileSync 回原位）。
 *
 * 三步：① TOCTOU 守卫（执行时重算现状 hash，与规划时不一致 → 不覆盖）② 从快照还原 ③ 落审计
 * （记录格式与 watch-fs 同构：`type:'audit-guard'` / `action:'post-block'` / `rolledBack:true`）。
 * @returns {{ok:boolean, file:string, changed:boolean, error:string|null,
 *            beforeHash:string|null, afterHash:string|null, expectedHash:string|null, audit:object|null}}
 */
export function rollbackCandidate(candidate, opts = {}) {
  const file = String(candidate?.file ?? '');
  const snap = String(candidate?.snap ?? '');
  const home = opts.home ?? dshHome();
  const now = num(opts.now, Date.now());
  const gateReason = opts.gateReason ?? 'unknown';
  const out = {
    ok: false, file, snap, changed: false, error: null,
    expectedHash: candidate?.curHash ?? null, beforeHash: null, afterHash: null, audit: null,
  };
  try {
    if (!fs.existsSync(snap)) throw new Error(`快照不存在：${snap}`);
    if (!fs.existsSync(file)) throw new Error('目标文件已不存在');
    out.beforeHash = fileSha(file);
    // ① TOCTOU 守卫：规划之后文件若又被改写，绝不拿旧快照覆盖（先人工看，别自动盖）
    if (candidate?.curHash && out.beforeHash !== candidate.curHash) {
      out.error = `plan-stale：执行时现状 hash(${String(out.beforeHash).slice(0, 12)}…) ≠ 规划时 hash(${String(candidate.curHash).slice(0, 12)}…) → 不覆盖`;
      appendAudit({
        type: 'audit-guard', action: 'post-block', via: 'p5-auto-rollback', path: file,
        zone: candidate?.zone ?? null, tier: candidate?.tier ?? null,
        rolledBack: false, rollbackGate: { allowed: true, reason: gateReason },
        findings: [{ rule: 'p5-auto-rollback', level: 'warn', message: out.error }],
      }, { home, silent: true });
      return out;
    }
    // ② 从既有快照还原（与 watch-fs 同一落点）
    fs.copyFileSync(snap, file);
    out.afterHash = fileSha(file);
    out.changed = out.afterHash !== out.beforeHash;
    out.ok = candidate?.snapHash ? out.afterHash === candidate.snapHash : true;
  } catch (e) {
    out.error = String(e?.message ?? e);
  }
  // ③ 落审计（无论成败都留痕；审计失败不反噬回滚本身）
  try {
    out.audit = appendAudit({
      type: 'audit-guard', action: 'post-block', via: 'p5-auto-rollback', path: file,
      zone: candidate?.zone ?? null, tier: candidate?.tier ?? null,
      rolledBack: out.ok === true && out.changed === true,
      rollbackGate: { allowed: true, reason: gateReason },
      snapshot: snap, beforeHash: out.beforeHash, afterHash: out.afterHash,
      findings: [{ rule: 'p5-auto-rollback', level: 'ok', message: out.error ?? '快照回滚完成' }],
    }, { home, silent: true });
  } catch { /* 审计失败不反噬 */ }
  return out;
}

/**
 * 跑一轮「P5 B 层自动回滚」动作。
 *
 * 三条路径（语义与 runAction 一致）：
 *   dryRun:true        → 永远可跑：只算不动，写一条 dry-run 影子记账（供影子视图/日报），**零回滚**
 *   四门任一关          → status='blocked'，**零副作用**（不写记账、不占额度、不回滚）
 *   四门全开 + 有候选   → runAction 放行后逐候选回滚（每个候选独立落审计；TOCTOU 守卫在回滚体里）
 *
 * @param {{
 *   home?:string, dshRoot?:string, now?:number, dryRun?:boolean, limits?:object, state?:object,
 *   scan?:object, plan?:object, autonomy?:object, deps?:{rollback?:Function}, executeTimeoutMs?:number
 * }} spec
 */
export async function runAutoRollback(spec = {}, opts = {}) {
  const now = num(opts.now ?? spec.now, Date.now());
  const home = opts.home ?? spec.home ?? dshHome();
  const dryRun = spec.dryRun === true || opts.dryRun === true;
  const limits = spec.limits ?? readLimits({ home });
  const state = spec.state ?? readActionsState({ home });

  const out = {
    kind: ROLLBACK_KIND, ok: true, dryRun, status: null, reason: null,
    home, now, day: localDay(now), moduleGate: null, plan: null, action: null, preview: null,
    candidates: 0, rolledBack: 0, failed: 0, blocked: 0, noop: 0, results: [],
  };

  // 1) 只读采集（失败 → 本轮不规划，不写任何东西）
  const scan = spec.scan ?? scanViolations({ home, now });
  if (!scan.ok) return { ...out, ok: false, status: 'collect-failed', reason: scan.error };

  // 2) 模块级闸门（L0 × L1 × L2）；dry-run **不受闸门限制**（只算不动 —— 与 runAction 同一语义）
  const moduleGate = checkModuleAllowed(ROLLBACK_KIND, { home, autonomy: spec.autonomy });
  out.moduleGate = moduleGate;

  // 3) 规划（纯函数，零副作用）
  const plan = spec.plan ?? planRollback(scan, {
    now, limits, state, moduleGate,
  });
  out.plan = plan;
  out.candidates = plan.candidates.length;

  if (!dryRun && !moduleGate.allowed) {
    return {
      ...out, ok: true, status: 'blocked',
      reason: `L2 模块闸门关闭：${moduleGate.reason}`,
      blocked: plan.candidates.length,
    };
  }

  // 4a) dry-run：一条轮级影子记账（明细在 detail.candidates 里），零回滚
  if (dryRun) {
    const preview = rollbackPreview(plan, { now });
    out.preview = preview;
    const r = await runAction({
      kind: ROLLBACK_KIND, level: ROLLBACK_LEVEL, dryRun: true, home, now,
      detail: preview, preview: () => preview,
    }, { home, now });
    out.action = r;
    out.status = r.status;
    out.reason = r.reason;
    return out;
  }

  // 4b) 决策不是 rollback → noop（不写签名、不占额度、零副作用）
  if (!plan.wouldRollback) {
    return {
      ...out, status: 'noop',
      decision: plan.decision,
      reason: `本轮不回滚（decision=${plan.decision}：${plan.note || plan.reason}）`,
      noop: 1,
    };
  }

  // 4c) 数据级闸门复核（与执行之间可能被改写；与"规划时"同源函数，非第二套判据）
  const chainNow = verifyAuditChain({ home, now });
  const gateReason = `module:${moduleGate.reason}|audit:${chainNow.reason}`;
  const rollback = spec.deps?.rollback ?? rollbackCandidate;

  const r = await runAction({
    kind: ROLLBACK_KIND, level: ROLLBACK_LEVEL, dryRun: false, home, now,
    consumesQuota: true,
    sigKey: plan.sigKey,
    detail: rollbackPreview(plan, { now }),
    revertHint: '回滚 = 用 B 层快照把文件还原成"最近合法内容"；再改回来的办法 = 重新写入合法内容（快照本身不被本动作改动）',
    execute: async () => {
      if (chainNow.ok !== true) {
        // 数据级闸门不通过 = 预期内的拒绝（记 noop，不记 failed：这是保护而非故障）
        return {
          kind: 'noop', ok: true, changed: 0, rejected: true, action: ROLLBACK_KIND,
          where: 'audit-chain-precheck', reason: chainNow.reason,
          note: '审计链校验未通过 → 不自动回滚',
        };
      }
      const results = [];
      for (const c of plan.candidates) {
        // eslint-disable-next-line no-await-in-loop
        const one = await rollback(c, { home, now, gateReason });
        results.push({
          file: c.file, ok: one?.ok === true, changed: one?.changed === true,
          error: one?.error ?? null,
          beforeHash: one?.beforeHash ?? null, afterHash: one?.afterHash ?? null,
        });
      }
      const changed = results.filter((x) => x.changed).length;
      const failed = results.filter((x) => !x.ok);
      return {
        kind: ROLLBACK_KIND,
        ok: failed.length === 0,
        changed,
        rolledBack: changed,
        failed: failed.length,
        total: results.length,
        results,
        error: failed.length ? `${failed.length} 个候选回滚失败` : null,
      };
    },
  }, { home, now, executeTimeoutMs: spec.executeTimeoutMs });

  out.action = r;
  out.status = r.status;
  out.reason = r.reason;
  out.rolledBack = num(r.result?.rolledBack, 0);
  out.failed = num(r.result?.failed, 0);
  out.results = r.result?.results ?? [];
  if (r.status === 'executed') out.ok = out.failed === 0;
  else if (r.status === 'failed') out.ok = false;
  else if (r.status === 'noop') out.noop = 1;
  else out.blocked = plan.candidates.length;
  return out;
}

/** 一轮摘要（CLI / 报表用；纯只读）。 */
export function summarizeAutoRollback(result) {
  const p = result?.plan ?? null;
  return {
    kind: ROLLBACK_KIND, dryRun: result?.dryRun === true, status: result?.status ?? null, reason: result?.reason ?? null,
    decision: p?.decision ?? null, decisionReason: p?.reason ?? null,
    wouldRollback: p?.wouldRollback === true,
    scanned: p?.summary?.scanned ?? 0,
    violationMarked: p?.summary?.violationMarked ?? 0,
    candidates: p?.summary?.candidates ?? 0,
    skipped: p?.summary?.skipped ?? 0,
    auditChainOk: p?.auditChain ? p.auditChain.ok === true : null,
    auditChainChecked: p?.auditChain?.checked ?? null,
    auditChainProblems: p?.auditChain?.problems ?? null,
    quota: p?.quota ?? null,
    rolledBack: result?.rolledBack ?? 0, failed: result?.failed ?? 0,
    blocked: result?.blocked ?? 0, noop: result?.noop ?? 0,
    moduleGate: result?.moduleGate?.reason ?? null,
  };
}

// ---------------------------------------------------------------- CLI（恒 dry-run）

/**
 * CLI 参数解析（**纯函数，单测入口**；顺序扫描：flag 与取值成对消费，剩下的才算未知）。
 * @returns {{help:boolean, json:boolean, home:string|null, unknown:Array<string>}}
 */
export function parseCliArgs(argv = []) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const boolFlags = new Set(['--dry-run', '--json', '--help', '-h']);
  const valueFlags = new Set(['--home', '--dsh-root']);
  const out = { help: list.includes('-h') || list.includes('--help'), json: list.includes('--json'), home: null, dshRoot: null, unknown: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (boolFlags.has(a)) continue;
    if (valueFlags.has(a)) {
      const v = list[i + 1];
      const hasValue = v !== undefined && !boolFlags.has(v) && !valueFlags.has(v);
      i += 1;
      if (!hasValue) { out.unknown.push(a); continue; }
      if (a === '--home') out.home = v; else out.dshRoot = v;
      continue;
    }
    out.unknown.push(a);
  }
  return out;
}

function printUsage() {
  process.stdout.write([
    '用法: node <dsh-butler>/lib/p5-auto-rollback.mjs [--dry-run] [--json] [--home <dir>]',
    '',
    '  --dry-run  默认行为（只算不动：写一条 dry-run 影子记账；**不回滚任何文件**）',
    '  --json     以 JSON 输出完整计划',
    '  --home     指定 home（默认 ~/.dsh）；**单测/沙箱演示用**，不改变生产',
    '',
    '⚠️ 本 CLI **只提供 dry-run**：真实回滚只能由动作调用方（将来的 tick 接线）走 runAutoRollback()。',
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
  const result = await runAutoRollback({ home, now, dryRun: true });
  const sum = summarizeAutoRollback(result);
  const p = result.plan ?? null;

  if (args.json) {
    process.stdout.write(JSON.stringify({
      home, device: process.env.COMPUTERNAME ?? null,
      result: { ...result, plan: p ? { ...p, skipped: p.skipped } : null, scan: undefined },
      summary: sum,
    }, null, 2) + '\n');
    return result.ok ? 0 : 1;
  }

  const yn = (b) => (b === true ? '是' : '否');
  const ac = p?.auditChain ?? null;
  const L = [
    '[p5-auto-rollback] dry-run（只算不动；未回滚任何文件）',
    `  home      : ${home}`,
    `  决策      : ${p?.decision ?? '?'}`,
    `  理由      : ${p?.reason ?? '?'}（${p?.note ?? ''}）`,
    `  会回滚    : ${yn(p?.wouldRollback)}`,
    `  采集      : watch-fs 状态 ${p?.summary?.scanned ?? 0} 条目 / 标违规 ${p?.summary?.violationMarked ?? 0} / 候选 ${p?.summary?.candidates ?? 0} / 跳过 ${p?.summary?.skipped ?? 0}`,
    `  审计链    : ${ac ? `ok=${yn(ac.ok)} 校验 ${ac.checked} 条（旧记录 ${ac.legacy} / 问题 ${ac.problems}）· ${ac.reason}` : '未校验'}`,
    `  L2 模块门 : allowed=${result.moduleGate?.allowed ?? '?'}（${result.moduleGate?.reason ?? '?'}）`,
    `  配额      : 今日 ${p?.quota?.used ?? 0}/${p?.quota?.max ?? 0}${p?.quota?.reached ? '（已用尽）' : ''}`,
    `  候选文件  ：`,
  ];
  const cands = p?.candidates ?? [];
  if (!cands.length) L.push('    （无）');
  for (const c of cands.slice(0, PREVIEW_MAX_ITEMS)) {
    L.push(`    - ${c.file}  [${c.zone ?? '?'}/${c.tier ?? '?'}]  违规 ${c.findingCount} 条 → 快照 ${c.snap ?? '缺'}`);
  }
  if ((p?.truncated ?? 0) > 0) L.push(`    … 其余 ${p.truncated} 个候选省略`);
  const skips = p?.skipped ?? [];
  L.push(`  跳过      ：${skips.length ? skips.map((s) => `${s.file}(${s.reason})`).join('、') : '无'}`);
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
      process.stderr.write(`[p5-auto-rollback] 失败：${e?.stack ?? e}\n`);
      process.exitCode = 1;
    });
}
