#!/usr/bin/env node
// dsh-butler / progress-status.mjs —— 开发进度指示器（A 计划 · 卡【进度A·4】）· **只读**渲染器 CLI
//
// 它是什么：把「愿景条目（G<n>/R<n>）↔ 方案档 ↔ 看板卡」的登记（人写一次）+ 两端权威取数
//   （看板实况 / 总纲 §5.1·§6.1 原文）合成一张**每次重算、永不吃手写过期**的进度总表。
//   方案：docs/ §3.1 三层结构（本文件 = 第三层渲染层，权威=无，可随时删了重建）。
//
// 权威三分（照方案 §6 表 1，不改口径）：
//   · 卡现在什么状态  → **看板实况**（每次现拉，登记表里根本不许写）
//   · 缺口/工作域文字 → **总纲 §5.1 / §6.1 原文**（只读抽取；失败即判"不可用"，不回落手写副本）
//   · 条目↔档↔卡的映射、方案过审状态、等谁 → **登记表**（人写；过审状态只做**弱核对**，见下）
//
// CLI（方案 §3.6）：
//   node progress-status.mjs [--md|--json] [--verify] [--apply|--out <path>] [--only <key>]
//        [--base-url <URL>] [--registry <path>] [--host <tag>] [--as-of <YYYY-MM-DD>] [--help]
//   · 默认 **dry-run**：只往 stdout 写；`--apply` 才原子写 `docs/`
//   · `--verify` 恒不渲染（只出校验段，方案 §3.6 纪律 1）；`--only <key>` 只影响渲染行数、
//     全量校验照跑（纪律 3：要"只校验一条"须显式 `--verify --only <key>`）
//   · `--json` 时 **stdout 只有 JSON**（日志一律走 stderr —— persona 红线③）
//
// 退出码（**含优先级 4 > 3 > 2 > 0**，方案 §3.6）：
//   4 = 看板不可达（offline/retryable；降级渲染，卡状态列写「未取到」）
//   3 = 有校验差异（J1–J4 级 ❌ / 未定档条目 / 覆盖差集）—— **仍出表**（D7 已拍 ②）
//   2 = 用法或环境错（参数错 / 登记表缺失 / schemaVersion 不符 / 取数被 permanent 拒 / 写盘失败）
//   0 = 正常
//
// 判据映射（方案 §5）：J3 文档在 / J4 卡在 → crossCheckRegistry（A-3 模块）+ 本文件渲染；
//   J6 档位可重算 → deriveTier 纯函数（单测夹具改卡状态即变档，**没有任何档位是写死的**）；
//   J7 只读 → 只调 extractAll（内部只发 GET /api/task-board/state）；J8/J8b 不写 → 除 `--apply/--out` 目标外零写；
//   J9 幂等 → content-key（内容哈希）相同则跳过写；J10/J10b 降级诚实 → 档位不推卡维度 + DEGRADED 文件；
//   J11 编码 → UTF-8 无 BOM + LF；J13 错误分档 → 复用 extractBoard 的 permanent/offline 分档文案；
//   J16 测试不得碰生产输出 → env DSH_PROGRESS_TEST=1 且目标在生产 `docs\reports\` 下 ⇒ exit 2 拒绝；
//   J17 反向覆盖提示 → `--verify` 列"板上属于已登记主线却未登记的卡"（**只提示，不参与 exit 3**）。
//
// 三条实现纪律（踩过就写下来）：
//   ① **档位一律推导，绝不手写**：`deriveTier()` 是纯函数，输入 = 卡实况 + 登记表；规则表见 §3.4，
//      规则全不命中 ⇒ 写「⚠️ 未定档」并进 `--verify` 差异（**禁止默认落 ✅ 落地**，方案 §3.4 规则 6）。
//   ② **弱核对不是合格证**：过审状态权威 = 登记表 `review`（人写）；本文件只做两项弱核对
//      （证据档存在且非空 = 硬；档内有「过审结论」标题行 = 软）。文案固定写「**弱核对（不构成合格证）**」；
//      `review` 与证据档结论冲突时**取更保守的一方**（报忧不报喜，方案 §7.3 ③）。
//   ③ **未登记 ≠ 需求**：权威表（总纲）有、登记表没有的键，档位列写「⚠️ 未登记」并进差异 ——
//      不写成 🧠 需求（"还没登记"与"确认只是想法"是两件事，混起来就是假绿）。
//
// 2026-09-28 修（卡【进度表失真修复】· 实测见 `docs/` §0）：
//   ① **抽取面失效**：总纲 §5.1 按「只加订正注、不改原文」体例在**表体中间**插订正注 ⇒ 旧抽取器
//      「遇非表格行即 break」把表截断在 G13（表自报「13 条 → 登记 34 条」、21 行标「总纲对应行取不到」）。
//      修法 = 抽取层 `lib\progress-extract.mjs` 改为**跳过非表格行继续扫**（只有标题/围栏/水平线终结表块），
//      并把订正注**归属到被点名的键**（`G33` / 「第 23 项」）或紧邻上一行；本文件在「缺口」列附
//      **原状态词 + 订正注定位与首行摘要** ⇒ 三源合读（总纲原文 + 订正注 + 卡实况）。
//   ② **归档语义脱节**：K4（2026-09-27）把 486 张卡物理搬进归档批次后，旧档位推导把「卡带 `archivedAt`」
//      **优先**判成 📦「已归档（终态；不得判 ✅ 落地）」⇒ 44 条已完成条目一律不敢判落地。
//      修法 = **档位只按卡面 `status` 判，归档只作附注**（`/state` 对归档卡仍全量返回原状态）；
//      仅当卡连 `/state` 都取不到时才退回**归档批次卡面（归档前最后状态）**，并在档位注里标明来源。
//   回滚：`docs/`（默认 dry-run；加 `--go` 才写回）。
//
// 怎么回滚：删本文件即回滚（渲染物是派生视图，随时可重建；登记表是人工资产、不受本文件影响）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { writeTextAtomic } from './lib/store.mjs';
import { firstH1Index, insertAtFor, stampDocMark } from '../lib/generated-docs.mjs'; // §2.2 权威源（档级标记）
import { hostTag } from './lib/host-tag.mjs';
import {
  progressRegistryPath, readRegistry, crossCheckRegistry, checkCoverage,
  normalizeKey, resolveRepoPath, registryStat,
  DSH_ROOT_DEFAULT,
} from './lib/progress-registry.mjs';
import { extractAll, cellOf, DEFAULT_DOC_PATH, G_COLS, R_COLS, readArchivedCardsSafe } from './lib/progress-extract.mjs';

export const CLI_VERSION = '0.2.0';
export const OUT_SCHEMA_VERSION = 1;

/** 报告落点目录（生成物；命名命中 repo-superset 既有 FORKED 正则 —— 零改动过跨机门）。 */
export const DEFAULT_OUT_DIR = path.join(DSH_ROOT_DEFAULT, 'docs', 'reports');
/** 登记表所在目录。 */
export const DEFAULT_REGISTRY_DIR = path.join(DSH_ROOT_DEFAULT, 'tools', 'dsh-butler');
/** 本机生产 DSH web（铁律：localhost，不用 127.0.0.1）。 */
export const DEFAULT_BASE_URL = 'http://localhost:3080';

/** 核对强度固定文案（判据要求逐字可断言；改它 = 改口径，必须同步改单测）。 */
export const STRENGTH_LINE = '卡状态=硬（实况）· 缺口/域文字=硬（原文抽取）· 方案过审状态=人写 + 弱核对（不构成合格证）';
/** 弱核对未过通过时的固定提示。 */
export const WEAK_NOT_FOUND_TEXT = '⚠️ 未核到（自评？）';
/** 五档口径说明行（照 方案 §3.4 + §0#4；含卡描述点名的四细分）。 */
export const TIER_LEGEND = '🧠 需求 / 📄 方案（已过审·待审·未过审·审不合格） / 🎫 卡 / ✅ 落地 ｜ 横切 ⏸ 卡住 ｜ 附档 📦 已归档（**仅"状态取不到"时才落此档**；归档本身不降档，见下） / ❌ 未成 / ⚠️ 未定档 / ⚠️ 未登记';

/** 现值口径说明行（2026-09-28 修：两处失真的口径在头部显式写清，不藏在代码里）。 */
export const PRESENT_VALUE_LINE = '现值口径：**总纲原文 + 其后订正注 + 在途卡实况 三者合读** —— 总纲按「只加订正注、不改原文」体例，**原文状态词多为旧口径**；本表「缺口」列标出**原状态词**与**订正注定位**（全文见总纲 §5.1 表后）。';
/** 归档档位口径说明行。 */
export const ARCHIVE_TIER_LINE = '归档案位口径：**归档 ≠ 不落地** —— 档位按 `/state` **卡面 `status`** 判（K4 物理归档后 `/state` 仍返回归档卡的原状态）；只有卡**连 `/state` 都取不到**时才退回**归档批次卡面（归档前最后状态）**，并在档位注里**标明判据来源**。';

/** 在板「未完成」状态（方案 §3.4 规则 1）。 */
export const CARD_OPEN_STATUSES = Object.freeze(['todo', 'backlog', 'running', 'review']);
/** 卡终态：完成 / 未成（规则 2 / 2b）。 */
export const CARD_DONE_STATUSES = Object.freeze(['done']);
export const CARD_DEAD_STATUSES = Object.freeze(['failed', 'cancelled']);

/** 档位枚举（**推导产物**，不是人写字段；`review` 中文名供"方案档（过审）"列用）。 */
export const TIERS = Object.freeze({
  need: { code: 'need', label: '🧠 需求', rule: '5' },
  planApproved: { code: 'plan-approved', label: '📄 方案·已过审', rule: '3' },
  planPending: { code: 'plan-pending', label: '📄 方案·待审', rule: '4' },
  planFailed: { code: 'plan-failed', label: '📄 方案·审不合格', rule: '4b' },
  planDesign: { code: 'plan-design', label: '📄 方案·设计/交付档', rule: '4c' },
  card: { code: 'card', label: '🎫 卡', rule: '1' },
  done: { code: 'done', label: '✅ 落地', rule: '2' },
  archived: { code: 'archived', label: '📦 已归档', rule: '0' },
  dead: { code: 'dead', label: '❌ 未成', rule: '2b' },
  undeclared: { code: 'undeclared', label: '⚠️ 未登记', rule: '—' },
  undecided: { code: 'undecided', label: '⚠️ 未定档', rule: '6' },
});

/** `plans[].review` 五值的中文名（展示用；"未过审"= none，照 方案 §3.4 档位细分）。 */
export const REVIEW_LABEL = Object.freeze({
  approved: '已过审', pending: '待审', none: '未过审', failed: '审不合格', 'n/a': '设计/交付档',
});

/** `blocked.kind` 四值的中文提示（"等谁"列用）。 */
export const BLOCKED_LABEL = Object.freeze({
  decision: '拍板', window: '停机窗口', external: '物理条件', upstream: '上游',
});

/** 弱核对：证据档里的「过审结论」标题行（方案 §3.5.3 给的正则，逐字）。 */
export const REVIEW_HEADING_RE = /^#{1,6}\s*§?\d*\.?\s*过审结论/m;
/** 结论为"不合格"的判据（报忧不报喜：与 positive 同时命中时取它）。 */
const REVIEW_NEGATIVE_RE = /不合格|不通过|未通过|驳回|不予通过/;
const REVIEW_POSITIVE_RE = /已过审|通过|合格/;

// ---------------------------------------------------------------- 参数

/**
 * 解析 CLI 参数（纯函数，不碰文件系统）。
 * @param {string[]} argv
 * @returns {{help:boolean, verify:boolean, json:boolean, apply:boolean, out:string|null,
 *   only:string|null, baseUrl:string|null, registry:string|null, host:string|null, asOf:string|null,
 *   errors:string[]}}
 */
export function parseArgs(argv = []) {
  const errors = [];
  const has = (f) => argv.includes(f);
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const strOf = (f) => {
    const v = get(f);
    if (v === undefined) { errors.push(`${f} 缺参数值`); return null; }
    if (String(v).startsWith('--')) { errors.push(`${f} 缺参数值（收到「${v}」）`); return null; }
    return String(v);
  };
  const KNOWN = ['--help', '-h', '--md', '--json', '--verify', '--apply', '--out', '--only', '--base-url', '--registry', '--host', '--as-of'];
  for (const a of argv) {
    if (a.startsWith('--') && !KNOWN.includes(a)) errors.push(`未知参数「${a}」（用 --help 看用法）`);
  }
  const out = { help: has('--help') || has('-h'), verify: has('--verify'), json: has('--json'), apply: has('--apply') };
  out.out = has('--out') ? strOf('--out') : null;
  out.only = has('--only') ? strOf('--only') : null;
  out.baseUrl = has('--base-url') ? strOf('--base-url') : null;
  out.registry = has('--registry') ? strOf('--registry') : null;
  out.host = has('--host') ? strOf('--host') : null;
  out.asOf = has('--as-of') ? strOf('--as-of') : null;
  if (out.apply && out.out) errors.push('--apply 与 --out 互斥（--apply 落默认落点，--out 自定落点）');
  if (out.verify && out.apply) errors.push('--verify 恒不渲染、也不落盘（方案 §3.6 纪律 1）—— 要去掉 --apply');
  if (out.verify && out.out) errors.push('--verify 恒不渲染、也不落盘 —— 要去掉 --out');
  if (out.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(out.asOf)) errors.push(`--as-of「${out.asOf}」不是 YYYY-MM-DD`);
  return { ...out, errors };
}

/** `--help` 文本。 */
export function usageText() {
  return [
    '开发进度指示器（A 计划）· 只读渲染器',
    '',
    '用法：node <butler-root>\\tools\\dsh-butler\\progress-status.mjs [选项]',
    '  --md                 人读表（默认；写 stdout）',
    '  --json               机读 JSON（stdout 只有 JSON，日志走 stderr）',
    '  --verify             只校验（schema + 外键 + 文档存在 + 卡存在），**不渲染主表**',
    '  --apply              原子写 docs/（内容相同则跳过）',
    '  --out <path>         自定义落点（与 --apply 互斥）',
    '  --only <key>         只渲染一个条目（G4 / R12）；**全量校验照跑**（只校验一条用 --verify --only）',
    `  --base-url <URL>     看板地址（默认 ${DEFAULT_BASE_URL}；铁律 localhost，别用 127.0.0.1）`,
    '  --registry <path>    登记表路径（默认 tools\\dsh-butler\\progress-registry-<host>.json）',
    '  --host <tag>         覆盖 hostTag()（夹具/跨机核对用）',
    '  --as-of <date>       覆盖头部日期（**仅测试隔离用**；输出头会显式标"非实测时刻"）',
    '  --help',
    '',
    '退出码（优先级 4 > 3 > 2 > 0）：4 看板不可达（降级渲染）｜3 校验有差异（仍出表）｜2 用法/环境错｜0 正常',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- 小工具

/** 本地 `YYYY-MM-DD HH:mm`（可注入 now，测试固定时刻用）。 */
export function fmtLocalTime(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本地日期 `YYYY-MM-DD`。 */
export function fmtLocalDate(ms) {
  return fmtLocalTime(ms).slice(0, 10);
}

/** ISO → 本地 `MM-DD HH:mm`（数据源 as-of 行用；无效输入原样返回）。 */
export function fmtIsoShort(iso) {
  if (!iso) return '(取不到)';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  return fmtLocalTime(t).slice(5);
}

/** markdown 单元格转义（原文里的 `|` 与换行会拆表）。 */
export function mdCell(s, max = 120) {
  let t = String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  if (max > 0 && t.length > max) t = `${t.slice(0, max)}…`;
  return t;
}

/** uuid 短形（表格里只显示前 8 位；完整 id 进 `--json`）。 */
export function shortId(id) { return String(id ?? '').slice(0, 8); }

/** 相对 `<butler-root>` 的展示路径（登记表/证据档列用；跨盘或非 DSH 下则原样）。 */
export function relToRoot(abs, root = DSH_ROOT_DEFAULT) {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(abs));
    if (!rel || rel.startsWith('..')) return abs;
    return rel;
  } catch { return abs; }
}

/** 内容指纹（幂等键 = 内容哈希，方案 §6 表 4）。 */
export function contentKeyOf(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- 档位推导（J6：纯函数、可重算）

/**
 * 无卡维度：按 `plans[]` 的 `review` 推档（方案 §3.4 规则 3/4/4b/4c，**求值纪律①：混合取更保守**）。
 * 顺序说明：先看 failed（最保守）→ 再看 pending/none → 全 n/a（设计/交付档）→ 才是已过审。
 * ⚠️ 与 §3.4 表 4b 括号「且无 pending/none」的差异（如实记录）：本实现按**求值纪律①「混合取更保守」**
 *    把「failed + pending/none 混合」判 4b（审不合格），而严格按表序会落到规则 4（待审）。
 *    方向 = 更悲观 ⇒ 与「报忧不报喜」一致；此差异写进 `--verify` 提示行，不静默。
 * @param {{review:string, kind:string}[]} reviews
 */
export function deriveTierFromPlans(reviews = []) {
  if (!reviews.length) return { ...TIERS.need, note: '—' };
  const anyFailed = reviews.some((r) => r.review === 'failed');
  const anyOpen = reviews.some((r) => r.review === 'pending' || r.review === 'none');
  const allNa = reviews.every((r) => r.review === 'n/a');
  const hasApprovedPlan = reviews.some((r) => r.kind === 'plan' && r.review === 'approved');
  if (anyFailed) {
    const mixed = anyOpen;
    return { ...TIERS.planFailed, note: `${reviews.filter((r) => r.review === 'failed').length} 项审不合格${mixed ? '（与待审项混合，取更保守档）' : ''}` };
  }
  if (anyOpen) {
    const p = reviews.filter((r) => r.review === 'pending').length;
    const n = reviews.filter((r) => r.review === 'none').length;
    return { ...TIERS.planPending, note: `待审 ${p} / 未过审 ${n}` };
  }
  if (allNa) return { ...TIERS.planDesign, note: `${reviews.length} 份设计/交付档（不参与过审判定）` };
  if (hasApprovedPlan && reviews.every((r) => r.review === 'approved' || r.review === 'n/a')) {
    return { ...TIERS.planApproved, note: `${reviews.filter((r) => r.review === 'approved').length} 份已过审` };
  }
  return { ...TIERS.undecided, note: `plans 组合未被规则覆盖（review=${reviews.map((r) => r.review).join('/')}，kind=${reviews.map((r) => r.kind).join('/')}）` };
}

/**
 * 卡维度：按看板实况推档（方案 §3.4 规则 0/1/2/2b/6）。
 *
 * ⚠️ **2026-09-28 修（归档语义脱节 · 卡【进度表失真修复】②）**：旧实现把「关联卡全部 `archivedAt`
 *    非空」**优先**判成 📦 已归档档，并写死文案「终态；**不得判 ✅ 落地**」⇒ K4（2026-09-27）把
 *    486 张卡**物理搬进** `task-board\archive\<batchId>\cards.json` 后，本表把 **44 条已完成条目**
 *    一律降成「已归档、不敢判落地」（实测见 `docs/` §0 ②）。
 *
 * **现值口径 = 归档是"卡被搬出主账本"的附注，不是档位**：
 *   · ① **主判据 = 卡面 `status`（`/state` 实况）** —— state 对归档卡**仍全量返回** `status` + `archivedAt`；
 *   · ② **兜底判据 = 归档批次卡面（归档前最后状态）** —— 仅当卡连 `/state` 都取不到时启用
 *     （`statusSource==='archive-batch'`），且 note 里**显式标出这一来源**，不与卡面实况混同；
 *   · ③ **📦 已归档档**只保留给"卡在归档批次里、但批次里也没有可用 `status`"的情形（诚实降级，不猜落地）。
 *
 * @param {{found:boolean, status:string|null, archived:boolean, statusSource?:'board'|'archive-batch'|'none'}[]} cards 与 `entry.cards` 同序
 */
export function deriveTierFromCards(cards = []) {
  const total = cards.length;
  const inBoard = cards.filter((c) => c.found);                                          // ① 卡面实况
  const fromBatch = cards.filter((c) => !c.found && c.statusSource === 'archive-batch' && String(c.status ?? '').trim()); // ② 批次兜底
  const known = [...inBoard, ...fromBatch];
  const missing = total - known.length;
  const suffix = missing > 0 ? `（另有 ${missing} 张卡找不到 · J4）` : '';
  if (!known.length) {
    return { ...TIERS.undecided, note: `关联卡在账本与归档批次里都找不到（J4${total ? ` · ${total} 张` : ''}）` };
  }

  const archBoard = inBoard.filter((c) => c.archived).length;
  const archBatch = fromBatch.length;
  const archNote = (archBoard || archBatch)
    ? ` · 📦 已物理归档 ${archBoard + archBatch} 张（K4 批次）` + (archBatch
      ? `；其中 ${archBatch} 张**判据 = 归档批次卡面（归档前最后状态）**`
      : '；档位按**卡面 status** 判（归档 ≠ 不落地）')
    : '';

  const doneCount = known.filter((c) => c.status === 'done').length;
  const open = known.filter((c) => CARD_OPEN_STATUSES.includes(String(c.status)));
  if (open.length) return { ...TIERS.card, note: `${doneCount}/${total} 卡 done${archNote}${suffix}` };

  const final = known.every((c) => CARD_DONE_STATUSES.includes(String(c.status)) || CARD_DEAD_STATUSES.includes(String(c.status)));
  if (final && doneCount) return { ...TIERS.done, note: `${total}/${total} 卡终态（done ${doneCount}）${archNote}${suffix}` };
  if (final) return { ...TIERS.dead, note: `${known.length} 张失败/取消、无一张 done${archNote}${suffix}` };

  // 状态取不到（既非终态、也无开态）：卡仍在归档批次里 ⇒ 诚实落 📦（**不猜落地**）
  if (known.every((c) => !String(c.status ?? '').trim())) {
    return { ...TIERS.archived, note: `${known.length}/${total} 张已归档但**状态取不到**（判据 = 归档批次缺 status）⇒ 不得判 ✅ 落地` };
  }
  return { ...TIERS.undecided, note: `卡状态未被规则覆盖（${known.map((c) => c.status).join('/')}）${archNote}` };
}

/**
 * 档位推导（**唯一入口**；J6）。
 * @param {{entry:object, cardStates:object[]|null, boardAvailable:boolean, planReviews?:{review:string,kind:string}[]}} args
 */
export function deriveTier({ entry, cardStates, boardAvailable, planReviews = null }) {
  const reviews = planReviews ?? (Array.isArray(entry?.plans) ? entry.plans.map((p) => ({ review: p?.review, kind: p?.kind })) : []);
  const cards = cardStates ?? [];
  const blockedText = fmtBlocked(entry?.blocked);

  if (!boardAvailable) {
    // 方案 §3.4 边界③：看板不可达 → **不推卡维度**，按 plans 推档 + 前缀「（未含卡态）」
    const t = deriveTierFromPlans(reviews);
    return {
      ...t,
      label: `（未含卡态）${t.label}`,
      note: `看板不可达，卡维度未推${cards.length ? `（登记有 ${cards.length} 张卡，状态未取到）` : ''}；${t.note}`,
      blockedText,
      degraded: true,
    };
  }
  const tier = cards.length ? deriveTierFromCards(cards) : deriveTierFromPlans(reviews);
  return { ...tier, blockedText, degraded: false };
}

/** 「等谁」列文案（登记表 `blocked` 人写）。 */
export function fmtBlocked(blocked) {
  if (!blocked || typeof blocked !== 'object') return '—';
  const kind = BLOCKED_LABEL[String(blocked.kind)] ?? String(blocked.kind ?? '未知');
  const who = String(blocked.who ?? '').trim() || '（未写等谁）';
  const why = String(blocked.why ?? '').trim();
  return `⏸ 等${who}（${kind}${why ? `：${why}` : ''}）`;
}

// ---------------------------------------------------------------- 弱核对（§3.5.3；**不构成合格证**）

/** 默认读文本（失败 → null；弱核对不能因为读不到就崩）。 */
function defaultReadText(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

/** 默认探测（与 progress-registry 同口径：存在且非空文件）。 */
function defaultProbe(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { exists: false, bytes: 0, error: 'not-a-file' };
    return { exists: true, bytes: st.size, error: null };
  } catch (e) { return { exists: false, bytes: 0, error: e?.code ?? String(e?.message ?? e) }; }
}

/**
 * 单份 plan 的弱核对（硬 = 档存在且非空；软 = 档内有「过审结论」标题行 + 结论倾向）。
 * @param {object} plan
 * @param {{root?:string, probePath?:Function, readText?:Function}} [opts]
 * @returns {{hard:boolean, hardReason:string|null, target:string, targetAbs:string,
 *            heading:'found'|'missing', conclusion:'passed'|'failed'|'unknown', text:string}}
 */
export function weakReviewCheck(plan, opts = {}) {
  const root = opts.root ?? DSH_ROOT_DEFAULT;
  const probePath = typeof opts.probePath === 'function' ? opts.probePath : defaultProbe;
  const readText = typeof opts.readText === 'function' ? opts.readText : defaultReadText;
  // 证据优先（`evidence.path`），没有则退回该 plan 自身 path（方案 §3.5.3「evidence.path 或 plan.path」）
  const target = String(plan?.evidence?.path ?? plan?.path ?? '');
  const targetAbs = target ? resolveRepoPath(root, target) : '';
  if (!targetAbs) {
    return { hard: false, hardReason: '无路径可核', target, targetAbs, heading: 'missing', conclusion: 'unknown', text: '（无证据档路径）' };
  }
  const probe = probePath(targetAbs);
  if (!probe.exists || !probe.bytes) {
    return { hard: false, hardReason: probe.exists ? '证据档是空文件' : `证据档不存在（${probe.error ?? 'ENOENT'}）`, target, targetAbs, heading: 'missing', conclusion: 'unknown', text: '（档读不到）' };
  }
  const text = readText(targetAbs);
  if (text == null) {
    return { hard: false, hardReason: '证据档读不到（编码/权限）', target, targetAbs, heading: 'missing', conclusion: 'unknown', text: '（读失败）' };
  }
  const m = REVIEW_HEADING_RE.exec(text);
  if (!m) {
    return { hard: true, hardReason: null, target, targetAbs, heading: 'missing', conclusion: 'unknown', text: WEAK_NOT_FOUND_TEXT };
  }
  const after = text.slice(m.index + m[0].length);
  const seg = after.split(/\n#{1,6}\s/)[0] ?? '';
  const negative = REVIEW_NEGATIVE_RE.test(seg);
  const positive = REVIEW_POSITIVE_RE.test(seg);
  const conclusion = negative ? 'failed' : (positive ? 'passed' : 'unknown');
  return {
    hard: true, hardReason: null, target, targetAbs, heading: 'found', conclusion,
    text: conclusion === 'failed' ? '已核对 · **结论=不合格**（报忧不报喜）'
      : (conclusion === 'passed' ? '已核对 · 结论=通过' : '已核对（结论文字未识别，请人工读）'),
  };
}

/**
 * 对登记表全量做弱核对，产出：每条 entry 的逐 plan 结果 + **保守化后的 review**（J 判据 R-6 / §7.3③）。
 * @returns {{byEntry:Map<string, object[]>, overrides:Map<string, Map<number,'failed'>>, warnings:object[]}}
 */
export function weakCheckRegistry(data, opts = {}) {
  const byEntry = new Map();
  const overrides = new Map();
  const warnings = [];
  for (const entry of Array.isArray(data?.entries) ? data.entries : []) {
    const nk = normalizeKey(entry?.key);
    const key = nk.ok ? nk.canon : String(entry?.key ?? '(缺键)');
    const list = [];
    (Array.isArray(entry?.plans) ? entry.plans : []).forEach((p, i) => {
      const r = weakReviewCheck(p, opts);
      list.push({ index: i, plan: p, ...r });
      const review = String(p?.review ?? '');
      // 报忧不报喜：登记说 approved（或 pending/none，即"还没审"）但证据档结论是不合格 → 保守化
      if (r.conclusion === 'failed' && review !== 'failed' && review !== 'n/a') {
        if (!overrides.has(key)) overrides.set(key, new Map());
        overrides.get(key).set(i, 'failed');
        warnings.push({
          code: 'WEAK_REVIEW_CONFLICT',
          message: `${key}.plans[${i}] 登记 review=${review}（${REVIEW_LABEL[review] ?? review}）但证据档结论为「不合格」→ 按更保守的一方显示（报忧不报喜，§7.3③）`,
          at: key,
        });
      }
      if (r.hard && r.heading === 'missing' && review === 'approved') {
        warnings.push({
          code: 'WEAK_REVIEW_HEADING_MISSING',
          message: `${key}.plans[${i}] 登记 review=approved，但证据档内**未核到**「过审结论」标题 → 弱核对未通过（${WEAK_NOT_FOUND_TEXT}），请人工确认；本列**不构成合格证**`,
          at: key,
        });
      }
      if (!r.hard && review === 'approved') {
        warnings.push({
          code: 'WEAK_REVIEW_HARD_FAIL',
          message: `${key}.plans[${i}] 登记 review=approved，但${r.hardReason}（J3 硬失败）`,
          at: key,
        });
      }
    });
    byEntry.set(key, list);
    if (Array.isArray(entry?.plans) && entry.plans.length > 1) {
      warnings.push({
        code: 'WEAK_REVIEW_MULTI_PLAN',
        message: `${key} 有 ${entry.plans.length} 份 plan → 档位取更保守的一方（求值纪律①）`,
        at: key,
      });
    }
  }
  return { byEntry, overrides, warnings };
}

// ---------------------------------------------------------------- 模型（把两端事实 + 登记表合成一张可渲染结构）

/**
 * 建模型（**只读**：读登记表 + 只读取看板/总纲）。所有路径/取数均可注入（单测隔离生产）。
 * @param {{
 *   argv?:string[], args?:object, host?:string, registry?:string, registryExplicit?:boolean,
 *   baseUrl?:string, docPath?:string, root?:string, now?:number, fetchImpl?:Function, timeoutMs?:number,
 *   probePath?:Function, readText?:Function, env?:object, outDir?:string, out?:string|null,
 *   apply?:boolean, only?:string|null, asOf?:string|null, mode?:'render'|'verify', format?:'md'|'json',
 *   home?:string, archive?:boolean, archiveView?:{byId:Map<string,object>, ok?:boolean, source?:string, reason?:string, count?:number, batches?:number, errors?:string[], home?:string}
 * }} opts
 */
export async function buildModel(opts = {}) {
  const env = opts.env ?? process.env;
  const now = Number(opts.now ?? Date.now());
  const root = opts.root ?? DSH_ROOT_DEFAULT;
  const host = String(opts.host ?? hostTag({ host: opts.args?.host ?? env.DSH_HOST_TAG }));
  const registryExplicit = opts.registryExplicit ?? Boolean(opts.registry ?? opts.args?.registry);
  const registryFile = path.resolve(String(opts.registry ?? opts.args?.registry ?? progressRegistryPath({ host, dir: DEFAULT_REGISTRY_DIR })));
  const baseUrl = String(opts.baseUrl ?? opts.args?.baseUrl ?? DEFAULT_BASE_URL);
  const docPath = path.resolve(String(opts.docPath ?? DEFAULT_DOC_PATH));
  const asOfDate = String(opts.asOf ?? opts.args?.asOf ?? '');
  const onlyRaw = opts.only !== undefined ? opts.only : (opts.args?.only ?? null);
  const apply = opts.apply ?? Boolean(opts.args?.apply);
  const outArg = opts.out !== undefined ? opts.out : (opts.args?.out ?? null);
  const outDir = path.resolve(String(opts.outDir ?? DEFAULT_OUT_DIR));

  // ① 登记表（唯一读入口；**显式 --registry 时 host 校验降级为只校验 schema.host** —— 方案 §3.6 纪律 2）
  const reg = readRegistry(registryFile, {
    host,
    expectedHost: registryExplicit ? null : host,
    now,
  });

  // ② 两端权威取数（看板 + 总纲；降级不抛错）。`api` 可注入（单测喂 stub readState，判据 J14）。
  const all = await extractAll({
    baseUrl, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, docPath, now, api: opts.api,
  });

  // ③ 弱核对（读证据档；在这一步就把"保守化后的 review"算出来供档位推导用）
  const weak = weakCheckRegistry(reg.data ?? { entries: [] }, { root, probePath: opts.probePath, readText: opts.readText });

  // ③b 归档面（K4）：**只在「登记了但 /state 里找不到」的卡存在时才读**归档批次（懒加载 · 零常态开销）
  const registeredIds = new Set();
  for (const e of Array.isArray(reg.data?.entries) ? reg.data.entries : []) {
    for (const c of Array.isArray(e?.cards) ? e.cards : []) if (c?.id) registeredIds.add(String(c.id));
  }
  const missingIds = all.board.available
    ? [...registeredIds].filter((id) => !all.board.tasks.some((t) => String(t?.id) === id))
    : [];
  let archivedById = null;
  let archiveInfo = null;
  if (missingIds.length && opts.archive !== false) {
    const av = opts.archiveView ?? readArchivedCardsSafe({ home: opts.home });
    archivedById = av.byId;
    archiveInfo = {
      ok: av.ok, source: av.source, reason: av.reason, home: av.home,
      count: av.count, batches: av.batches, errors: av.errors, usedFor: missingIds.length,
    };
  }

  // ④ 条目标目（权威表键集为骨架 + 登记表键为补充）
  const entries = [];
  const gTable = all.doc.g;
  const rTable = all.doc.r;
  const regByKey = new Map();
  for (const e of Array.isArray(reg.data?.entries) ? reg.data.entries : []) {
    const nk = normalizeKey(e?.key);
    if (nk.ok) regByKey.set(nk.canon, e);
  }

  const buildRow = ({ canon, quote, seg, docRow, docStatus = null }) => {
    const entry = regByKey.get(canon) ?? null;
    const registered = Boolean(entry);
    const plans = Array.isArray(entry?.plans) ? entry.plans : [];
    const cardDefs = Array.isArray(entry?.cards) ? entry.cards : [];
    const states = cardDefs.map((c) => {
      const id = String(c?.id ?? '');
      const t = all.board.available ? all.board.tasks.find((x) => String(x?.id) === id) : null;
      // 归档批次兜底（K4 物理归档）：**仅当 /state 里找不到该卡**时用，判据 = 归档前最后状态
      const batch = !t && archivedById ? archivedById.get(id) : null;
      return {
        id,
        titleSnapshot: c?.titleSnapshot ?? null,
        role: c?.role ?? null,
        found: Boolean(t),
        status: t ? String(t.status ?? '(空)') : (batch ? String(batch?.status ?? '') : null),
        statusSource: t ? 'board' : (batch ? 'archive-batch' : 'none'),
        line: t ? (t.line ?? null) : (batch?.line ?? null),
        seq: t ? (t.seq ?? null) : (batch?.seq ?? null),
        title: t ? (t.title ?? null) : (batch?.title ?? null),
        updatedAt: t ? (t.updatedAt ?? null) : (batch?.updatedAt ?? null),
        archived: Boolean(t?.archivedAt) || Boolean(batch?.archivedAt),
        archivedAt: t?.archivedAt ?? batch?.archivedAt ?? null,
        titleDrift: Boolean(t && typeof c?.titleSnapshot === 'string' && c.titleSnapshot !== t.title),
      };
    });
    const planReviews = plans.map((p, i) => ({
      kind: String(p?.kind ?? ''),
      review: String(weak.overrides.get(canon)?.get(i) ?? p?.review ?? ''),
      rawReview: String(p?.review ?? ''),
      downgraded: Boolean(weak.overrides.get(canon)?.get(i)),
    }));
    let tier;
    if (!registered) {
      tier = { ...TIERS.undeclared, note: '登记表里没有这一条（总纲有 · 登记无）→ J1 覆盖差集', degraded: false };
    } else {
      tier = deriveTier({ entry, cardStates: all.board.available ? states : null, boardAvailable: all.board.available, planReviews });
    }
    return {
      key: canon, seg, registered, quote: quote ?? null, docRow: docRow ?? null,
      /** 总纲 §5.1「状态」列原文词（**多为旧口径** —— 与订正注、卡实况合读，见头部现值口径行）。 */
      docStatus: docStatus ?? null,
      /** 该行之后（或点名该键）的总纲订正注块（**抽取层已归属**；渲染层只做摘要展示）。 */
      docNotes: (Array.isArray(docRow?.docNotes) ? docRow.docNotes : [])
        .map((b) => ({
          fromLine: b.fromLine, toLine: b.toLine, lineCount: b.lines.length,
          attributedBy: b.attributedBy, attributedTo: b.attributedTo, mentionKeys: b.mentionKeys,
          strongKeys: b.strongKeys ?? [],
          head: String(b.lines?.[0] ?? '').replace(/^>\s*/, ''),
        }))
        // 强点名（`` `G33` `` / `**G33**` / 「G33 行」）优先展示；同级别保持表内原序（sort 稳定）
        .sort((a, b) => (b.attributedBy === 'mentioned-strong' ? 1 : 0) - (a.attributedBy === 'mentioned-strong' ? 1 : 0)),
      docLine: docRow?.line ?? null,
      tier: { code: tier.code, label: tier.label, rule: tier.rule, note: tier.note ?? null, degraded: Boolean(tier.degraded) },
      blockedText: registered ? fmtBlocked(entry?.blocked) : '—',
      blocked: entry?.blocked ?? null,
      note: entry?.note ?? null,
      plans: plans.map((p, i) => ({
        path: String(p?.path ?? ''), kind: String(p?.kind ?? ''), review: String(p?.review ?? ''),
        reviewLabel: REVIEW_LABEL[String(p?.review ?? '')] ?? String(p?.review ?? '?'),
        effectiveReview: planReviews[i].review, downgraded: planReviews[i].downgraded,
        evidence: p?.evidence ?? null, asOf: p?.asOf ?? null,
        weak: (() => { const w = weak.byEntry.get(canon)?.[i]; return w ? { hard: w.hard, hardReason: w.hardReason, heading: w.heading, conclusion: w.conclusion, text: w.text, target: w.target } : null; })(),
      })),
      cards: states,
      /** 该条目是否参与"未定档"差异（方案 §3.4 规则 6：规则全不命中 ⇒ 列进 --verify 差异）。 */
      undecided: tier.code === 'undecided',
    };
  };

  // G 段（权威表在 → 以其行序为骨架；权威表不可用 → 落到登记表自己的 G 段条目）
  {
    const gDocKeys = gTable.available ? gTable.keys : [];
    const seen = new Set();
    for (const k of gDocKeys) {
      seen.add(k);
      const docRow = gTable.rows.find((r) => r.canonKey === k) ?? null;
      entries.push(buildRow({
        canon: k, seg: 'G', quote: cellOf(gTable, k, G_COLS.gap), docRow,
        docStatus: cellOf(gTable, k, G_COLS.status),
      }));
    }
    for (const [k, e] of regByKey) {
      const nk = normalizeKey(e?.key);
      if (!nk.ok || nk.seg !== 'G' || seen.has(k)) continue;
      seen.add(k);
      entries.push(buildRow({ canon: k, seg: 'G', quote: null }));
    }
    // R 段
    const rDocKeys = rTable.available ? rTable.keys : [];
    const seenR = new Set();
    for (const k of rDocKeys) {
      seenR.add(k);
      const docRow = rTable.rows.find((r) => r.canonKey === k) ?? null;
      entries.push(buildRow({ canon: k, seg: 'R', quote: cellOf(rTable, k, R_COLS.item), docRow }));
    }
    for (const [k, e] of regByKey) {
      const nk = normalizeKey(e?.key);
      if (!nk.ok || nk.seg !== 'R' || seenR.has(k)) continue;
      seenR.add(k);
      entries.push(buildRow({ canon: k, seg: 'R', quote: null }));
    }
  }

  // ⑤ 校验（复用 A-3 的两个校验器）
  const coverage = checkCoverage(Array.isArray(reg.data?.entries) ? reg.data.entries : [], {
    gKeys: gTable.available ? gTable.keys : [],
    rKeys: rTable.available ? rTable.keys : [],
  });
  const cc = crossCheckRegistry(reg.data ?? { entries: [] }, {
    ...all.crossCheckContext,
    root,
    probePath: opts.probePath,
  });
  const weakWarnings = weak.warnings;

  // 未定档 / 未登记 的键（进差异）
  const undecidedKeys = entries.filter((e) => e.registered && e.undecided).map((e) => e.key);
  const undeclaredKeys = entries.filter((e) => !e.registered).map((e) => e.key);

  // ⑥ 反向覆盖提示（J17：只提示、**不参与 exit 3**）
  const registeredCardIds = new Set();
  for (const e of Array.isArray(reg.data?.entries) ? reg.data.entries : []) {
    for (const c of Array.isArray(e?.cards) ? e.cards : []) registeredCardIds.add(String(c?.id ?? ''));
  }
  const linesOfRegistered = new Set();
  if (all.board.available) {
    for (const id of registeredCardIds) {
      const t = all.board.tasks.find((x) => String(x?.id) === id);
      if (t && t.line) linesOfRegistered.add(String(t.line));
    }
  }
  const unregisteredCards = all.board.available && linesOfRegistered.size
    ? all.board.tasks
      .filter((t) => !t.archivedAt && t.line && linesOfRegistered.has(String(t.line)) && !registeredCardIds.has(String(t.id)))
      .map((t) => ({ id: String(t.id), title: String(t.title ?? ''), status: String(t.status ?? ''), line: String(t.line ?? ''), seq: t.seq ?? null }))
    : null;

  // ⑦ 落点与核对强度
  const date = asOfDate || fmtLocalDate(now);
  const degraded = !all.board.available;
  const target = outArg
    ? path.resolve(String(outArg))
    : path.join(outDir, `${date}-progress-${host}${degraded ? '.DEGRADED' : ''}.md`);

  // ⑧ 退出码（优先级 4 > 3 > 2 > 0）
  const boardErrCode = all.board.available ? 0 : (all.board.exitCodeHint === 2 ? 2 : 4);
  const hardDiff = [
    ...coverage.missingG, ...coverage.extraG, ...coverage.missingR, ...coverage.extraR,
  ];
  const diffCount = cc.errors.length + hardDiff.length + undecidedKeys.length;
  let exitCode = 0;
  if (boardErrCode) exitCode = boardErrCode;
  else if (diffCount > 0) exitCode = 3;
  else if (reg.fatal.length) exitCode = 2;

  /** 总纲订正注识别统计（抽取面修复的可见性；`--json` 可直接读）。 */
  const docNoteStats = {
    gBlocks: (gTable.noteBlocks ?? []).length,
    rBlocks: (rTable.noteBlocks ?? []).length,
    total: (gTable.noteBlocks ?? []).length + (rTable.noteBlocks ?? []).length,
    gRowsWithNotes: gTable.rows.filter((r) => (r.docNotes ?? []).length > 0).length,
    rRowsWithNotes: rTable.rows.filter((r) => (r.docNotes ?? []).length > 0).length,
    gRows: gTable.keys.length,
    rRows: rTable.keys.length,
  };

  const model = {
    schemaVersion: OUT_SCHEMA_VERSION,
    kind: 'progress-status',
    cliVersion: CLI_VERSION,
    mode: opts.mode ?? (opts.args?.verify ? 'verify' : 'render'),
    format: opts.format ?? (opts.args?.json ? 'json' : 'md'),
    host,
    generatedAt: new Date(now).toISOString(),
    generatedAtText: fmtLocalTime(now),
    date,
    asOfOverride: asOfDate || null,
    baseUrl,
    baseUrlIsDefault: baseUrl.replace(/\/+$/, '') === DEFAULT_BASE_URL,
    registry: {
      file: registryFile, relFile: relToRoot(registryFile, root), explicit: registryExplicit,
      exists: reg.exists, bytes: reg.bytes, mtime: reg.mtime, mtimeText: reg.mtime ? fmtIsoShort(reg.mtime) : null,
      asOf: reg.data?.asOf ?? null, host: reg.data?.host ?? null, entryCount: Array.isArray(reg.data?.entries) ? reg.data.entries.length : 0,
      fatal: reg.fatal, errors: reg.errors, warnings: reg.warnings,
      stat: registryStat(registryFile),
    },
    doc: {
      path: docPath, relPath: relToRoot(docPath, root), mtime: all.doc.mtime, mtimeText: all.doc.mtime ? fmtIsoShort(all.doc.mtime) : null,
      available: all.doc.available, gAvailable: gTable.available, rAvailable: rTable.available,
      gCount: gTable.keys.length, rCount: rTable.keys.length, errors: all.doc.errors, parseNotes: [...(gTable.notes ?? []), ...(rTable.notes ?? [])],
    },
    board: {
      available: all.board.available, tasksTrustworthy: all.board.tasksTrustworthy,
      kind: all.board.kind, code: all.board.code, error: all.board.error,
      reasonText: all.board.reasonText, detail: all.board.detail, exitCodeHint: all.board.exitCodeHint,
      url: all.board.url ?? null, baseUrl, revision: all.board.revision, durationMs: all.board.durationMs,
      asOf: all.board.asOf, asOfText: fmtIsoShort(all.board.asOf), counts: all.board.counts,
    },
    /** 归档面（K4）：`null` = 本次无需读（登记卡全部在 `/state` 里）；非空 = 有卡需走批次兜底。 */
    archive: archiveInfo,
    docNoteStats,
    entries,
    verify: {
      ok: cc.errors.length === 0 && hardDiff.length === 0 && undecidedKeys.length === 0 && reg.fatal.length === 0,
      normalizationRule: coverage.rule,
      docNoteStats,
      coverage: {
        registeredG: coverage.registeredG, registeredR: coverage.registeredR,
        docGCount: coverage.docGCount, docRCount: coverage.docRCount,
        rRegisteredEmpty: coverage.rRegisteredEmpty,
        missingG: coverage.missingG, extraG: coverage.extraG,
        missingR: coverage.missingR, extraR: coverage.extraR,
        missingRWhenRegistered: coverage.missingRWhenRegistered,
      },
      fatal: reg.fatal, errors: cc.errors, warnings: [...cc.warnings, ...weakWarnings, ...reg.warnings],
      undeclaredKeys, undecidedKeys, unregisteredCards,
    },
    tierCounts: (() => {
      const c = {};
      for (const e of entries) c[e.tier.code] = (c[e.tier.code] ?? 0) + 1;
      return c;
    })(),
    apply: { requested: apply, target, outDir, wrote: false, skipped: false, generation: null },
    exitCode,
  };
  model.contentKey = contentKeyOf({
    host, date, baseUrl, revision: model.board.revision, boardAvailable: model.board.available,
    regMtime: model.registry.mtime, docMtime: model.doc.mtime,
    rows: entries.map((e) => [e.key, e.tier.code, e.tier.note, e.blockedText, e.plans.map((p) => `${p.path}|${p.kind}|${p.review}|${p.effectiveReview}`), e.cards.map((c) => `${c.id}|${c.found}|${c.status}|${c.archived}|${c.title}`)]),
    verify: { fatal: model.verify.fatal.map((x) => x.code), errors: model.verify.errors.map((x) => x.code), warnings: model.verify.warnings.map((x) => x.code), undecidedKeys, undeclaredKeys },
  });
  return model;
}

// ---------------------------------------------------------------- 渲染（md）

/**
 * 「缺口 / 工作域」单元格 = 总纲原文摘要 + **原状态词**（§5.1 有「状态」列）+ **订正注定位与首行摘要**。
 *
 * 三件合读才是现值（总纲按「只加订正注、不改原文」体例，原文状态词大量是旧口径 ——
 * 例：G33 行仍写「未过审」、G32 仍写「未焊入 persona」，而现值早已翻转）。**全文订正注在总纲表后**，
 * 本表只给定位（行号）+ 首行摘要，不复制全文（避免造第二处真相）。
 */
function fmtDocQuoteCell(row) {
  const base = row.quote == null
    ? (row.registered ? '（总纲对应行取不到 / 不在权威表 —— 见 §3 校验）' : '（不在总纲权威表 —— 见 §3 校验）')
    : mdCell(row.quote, 90);
  const bits = [];
  if (row.docStatus) bits.push(`<br><sub>原状态词：${mdCell(row.docStatus, 60)}</sub>`);
  if (row.docNotes?.length) {
    const at = row.docNotes.map((b) => `L${b.fromLine}${b.toLine === b.fromLine ? '' : `-${b.toLine}`}`).join(' · ');
    bits.push(`<br><sub>⚠️ 总纲订正注 ${row.docNotes.length} 条（${at}）：${mdCell(row.docNotes[0].head, 80)}</sub>`);
  }
  return base + bits.join('');
}

function fmtPlanCell(row, opts) {
  if (!row.plans.length) return '—';
  const cell = row.plans.map((p) => {
    const shown = p.effectiveReview !== p.review ? `${REVIEW_LABEL[p.effectiveReview] ?? p.effectiveReview}（登记 ${REVIEW_LABEL[p.review] ?? p.review}，证据档口径更保守）` : `${REVIEW_LABEL[p.review] ?? p.review}`;
    const kindTag = p.kind === 'plan' ? '' : `${p.kind === 'design' ? '设计' : (p.kind === 'delivery' ? '交付' : p.kind)}：`;
    const weakTag = (p.review === 'approved' || p.downgraded) && p.weak
      ? `（弱核对：${p.heading === 'found' ? p.weak.text : p.weak.text}）`
      : '';
    return `${kindTag}\`${p.path}\`（${shown}）${weakTag}`;
  }).join('；');
  return opts?.max ? mdCell(cell, opts.max) : cell;
}

function fmtCardCell(row, boardAvailable) {
  if (!row.cards.length) return '—';
  if (!boardAvailable) return '未取到（看板不可达）';
  return row.cards.map((c) => {
    if (!c.found) {
      // 归档批次兜底：卡已不在 /state，但批次里有它的**归档前最后状态** ⇒ 如实标出来源
      if (c.statusSource === 'archive-batch') {
        return [`【${c.title ?? c.titleSnapshot ?? '(无题)'}】`, String(c.status ?? '(空)'), c.line || '—', c.seq || '—', `{${shortId(c.id)}}`, '📦 判据=归档批次（/state 已无此卡）'].join(' · ');
      }
      return `❌ 卡 ${shortId(c.id)} 在账本里找不到（J4）`;
    }
    const bits = [`【${c.title ?? c.titleSnapshot ?? '(无题)'}】`, String(c.status ?? '(空)'), c.line || '—', c.seq || '—', `{${shortId(c.id)}}`];
    if (c.archived) bits.push('已归档（K4 批次）');
    if (c.titleDrift) bits.push('⚠️ 标题快照漂移');
    return bits.join(' · ');
  }).join('；');
}

/** 渲染头部（md）。`generation` 非空时追加"当日第 N 次生成"行。 */
function renderHeader(model, generation = null) {
  const L = [];
  L.push(`# 管家开发进度（${model.host} · ${model.asOfOverride ? `${model.date}（--as-of 覆盖）` : model.generatedAtText}）`);
  L.push('');
  L.push(`> ⚙️ 自动生成 · **请勿手改本文件** —— 改登记表后重跑（登记表：\`${model.registry.relFile}\`${model.registry.exists ? '' : ' · ⚠️ 当前**不存在**，按空表继续'}）`);
  const boardLine = model.board.available
    ? `只读 GET \`${model.baseUrl}\`/api/task-board/state（as-of ${model.board.asOfText} · revision ${model.board.revision} · ${model.board.counts.total} 卡 / 在板 ${model.board.counts.live} / 归档 ${model.board.counts.archived}）`
    : `只读 GET \`${model.baseUrl}\`/api/task-board/state（**未取到**：${model.board.reasonText ?? model.board.code}）`;
  L.push(`> 数据源：${boardLine}· 只读解析 总纲 §5.1/§6.1（as-of ${model.doc.mtimeText ?? '取不到'}）· 登记表（as-of ${model.registry.mtimeText ?? '取不到'}）`);
  L.push(`> 核对强度：${STRENGTH_LINE}`);
  L.push(`> 档位口径：${TIER_LEGEND}`);
  L.push(`> ${PRESENT_VALUE_LINE}`);
  L.push(`> ${ARCHIVE_TIER_LINE}`);
  if (model.archive) {
    L.push(`> 📦 本次读了**归档批次卡面**（${model.archive.batches} 批 / ${model.archive.count} 张 · source=${model.archive.source}${model.archive.ok ? '' : ' ⚠️ 部分读取失败'}）：有 ${model.archive.usedFor} 张登记卡在 \`/state\` 里找不到 ⇒ 按批次里的**归档前最后状态**判，档位注已标出来源。`);
  }
  if (!model.baseUrlIsDefault) {
    L.push(`> ⚠️ 本次取数**不是**默认 host：\`--base-url ${model.baseUrl}\`（非本机生产实例的数据）`);
  }
  if (model.asOfOverride) {
    L.push(`> ⚠️ **--as-of 覆盖，非实测时刻**（头部日期取 ${model.asOfOverride}；数据源 as-of 仍是真取数时刻；本项仅测试隔离用）`);
  }
  if (!model.board.available) {
    L.push(`> ⚠️ **降级渲染**：看板不可达 ⇒ 卡维度**未推**，档位列带前缀「（未含卡态）」；含卡条目**不得**当成"没开工"读`);
  }
  if (!model.doc.gAvailable || !model.doc.rAvailable) {
    L.push(`> ⚠️ 总纲解析降级：§5.1 ${model.doc.gAvailable ? 'OK' : '**不可用**'} · §6.1 ${model.doc.rAvailable ? 'OK' : '**不可用**'}（取值不回落手写副本，见原档）`);
  }
  if (model.registry.fatal.length) {
    L.push(`> ⚠️ 登记表环境错：${model.registry.fatal.map((f) => f.code).join(' / ')}（退出码 2；详见 §3 校验结果）`);
  }
  if (generation) L.push(`> 本文件为当日第 ${generation} 次生成，历史版本不保留（同日多次 \`--apply\` = 整份覆写）`);
  L.push(`> <!-- progress-content-key: ${model.contentKey} -->`);
  return L;
}

function tierSummaryLine(model) {
  const order = ['done', 'card', 'planApproved', 'planPending', 'planFailed', 'planDesign', 'need', 'archived', 'dead', 'undeclared', 'undecided'];
  const parts = order
    .map((k) => {
      const t = TIERS[k];
      const n = model.tierCounts[t.code] ?? 0;
      return n ? `${t.label} ${n}` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : '（无条目）';
}

/** 渲染一张条目表（`--only` 时只出一行）。 */
function renderEntryTable(model, seg, title, opts = {}) {
  const rows = model.entries.filter((e) => e.seg === seg && (!opts.only || e.key === opts.only));
  const L = [];
  const docCount = seg === 'G' ? model.doc.gCount : model.doc.rCount;
  const registered = rows.filter((r) => r.registered).length;
  L.push(`## ${title}（总纲 ${seg === 'G' ? '§5.1' : '§6.1'} · ${docCount} ${seg === 'G' ? '条' : '项'} → 登记 ${registered} ${seg === 'G' ? '条' : '项'}${opts.only ? ` · **--only ${opts.only}**` : ''}）`);
  L.push('');
  L.push(`| 钥匙 | ${seg === 'G' ? '缺口（原文摘要 · 原状态词 · 订正注定位）' : '工作域（总纲 §6.1 原文摘要）'} | 档位 | 方案档（过审 · 弱核对） | 卡（标题 · 状态 · 主线 · 节点） | 等谁 |`);
  L.push('|---|---|---|---|---|---|');
  if (!rows.length) {
    L.push(`| — | （无） | — | — | — | — |`);
  }
  for (const r of rows) {
    L.push(`| ${r.key} | ${fmtDocQuoteCell(r)} | ${r.tier.label}${r.tier.note ? `<br><sub>${mdCell(r.tier.note, 70)}</sub>` : ''} | ${fmtPlanCell(r)} | ${mdCell(fmtCardCell(r, model.board.available), 300)} | ${mdCell(r.blockedText, 60)} |`);
  }
  L.push('');
  return L;
}

/** 渲染校验段（`--verify` 用；渲染模式的 §3 段共用）。 */
function renderVerifySection(model) {
  const L = [];
  const v = model.verify;
  L.push('## §3 校验结果（--verify 段）');
  L.push('');
  L.push(`归一化规则：${String(v.normalizationRule).replace(/^归一化规则：/, '')}`);
  L.push('');
  L.push('| 段 | 权威源 | 登记 | 缺（权威有 · 登记无） | 多（登记有 · 权威无） |');
  L.push('|---|---|---|---|---|');
  L.push(`| G（§5.1） | ${v.coverage.docGCount} | ${v.coverage.registeredG.length} | ${v.coverage.missingG.join(', ') || '—'} | ${v.coverage.extraG.join(', ') || '—'} |`);
  L.push(`| R（§6.1） | ${v.coverage.docRCount} | ${v.coverage.registeredR.length}${v.coverage.rRegisteredEmpty ? '（R 段尚未登记，按 J1 原文不据此报差集）' : ''} | ${v.coverage.missingR.join(', ') || '—'} | ${v.coverage.extraR.join(', ') || '—'} |`);
  L.push('');
  if (v.docNoteStats) {
    L.push(`> 📌 **总纲订正注识别**（抽取面修复的可见性）：§5.1 **${v.docNoteStats.gBlocks} 块**（覆盖 ${v.docNoteStats.gRowsWithNotes}/${v.docNoteStats.gRows} 行）· §6.1 **${v.docNoteStats.rBlocks} 块**（覆盖 ${v.docNoteStats.rRowsWithNotes}/${v.docNoteStats.rRows} 行）；抽到行数 §5.1 ${v.coverage.docGCount} / §6.1 ${v.coverage.docRCount}。`);
    L.push('');
  }
  const rows = [];
  for (const f of v.fatal) rows.push(['❌', `**${f.code}**：${f.message}`]);
  for (const e of v.errors) rows.push(['❌', `**${e.code}**：${e.message}`]);
  for (const w of v.warnings) rows.push(['⚠️', `**${w.code}**：${w.message}`]);
  if (!rows.length) rows.push(['✅', 'schema / 外键 / 文档存在 / 卡存在 / 覆盖 —— **无差异**']);
  L.push('| 级别 | 内容 |');
  L.push('|---|---|');
  for (const [lv, msg] of rows) L.push(`| ${lv} | ${mdCell(msg, 400)} |`);
  L.push('');
  if (v.undecidedKeys.length) {
    L.push(`> ⚠️ **未定档**（规则全不命中，禁止默认落 ✅ 落地）：${v.undecidedKeys.join(', ')}`);
  }
  if (v.undeclaredKeys.length) {
    L.push(`> ⚠️ **未登记**（总纲有、登记表没有）：${v.undeclaredKeys.join(', ')} —— J1 覆盖差集即此；"未登记"≠"需求"档`);
  }
  L.push('');
  L.push('## §3b 反向覆盖提示（J17 · **只提示不阻断**，不参与退出码）');
  L.push('');
  if (v.unregisteredCards == null) {
    L.push('- （看板不可达 或 无已登记主线的卡 → 无法计算）');
  } else if (!v.unregisteredCards.length) {
    L.push('- 板上属于已登记主线的卡，**全部已登记**');
  } else {
    L.push(`- 板上属于已登记主线的卡中，**未登记的 ${v.unregisteredCards.length} 张**：`);
    for (const c of v.unregisteredCards.slice(0, 20)) L.push(`  - 【${mdCell(c.title, 60)}】${c.status} · ${c.line} · ${c.seq ?? '—'} · {${shortId(c.id)}}`);
    if (v.unregisteredCards.length > 20) L.push(`  - …（共 ${v.unregisteredCards.length} 张，只列前 20）`);
  }
  L.push('');
  return L;
}

/** 渲染人读 markdown（**纯函数**：同一 model → 同一文本）。 */
export function renderMarkdown(model, opts = {}) {
  const only = opts.only ?? null;
  const generation = opts.generation ?? null;
  const L = [];
  if (model.mode === 'verify') {
    L.push(...renderHeader(model, generation));
    L.push(`> 模式：**--verify**（只校验，不渲染主表${only ? ` · --only ${only}（仍跑全量校验）` : ''}）`);
    L.push('');
    L.push(...renderVerifySection(model));
  } else {
    L.push(...renderHeader(model, generation));
    if (only) L.push(`> 模式：**--only ${only}**（只渲染该行；**校验与汇总仍是全量**）`);
    L.push('');
    L.push(`> 汇总：档位分布 = ${tierSummaryLine(model)}`);
    L.push('');
    L.push(...renderEntryTable(model, 'G', '§1 剩余缺口', { only }));
    L.push(...renderEntryTable(model, 'R', '§2 工作域', { only }));
    L.push(...renderVerifySection(model));
  }
  L.push(`---`);
  L.push(`<sub>生成：progress-status.mjs v${CLI_VERSION} · ${model.generatedAtText}${model.asOfOverride ? '（--as-of 覆盖）' : ''} · 退出码 ${model.exitCode}</sub>`);
  L.push('');
  return `${L.join('\n')}`;
}

/** 机读 JSON（**stdout 只有它**；模型里的 Map/Set 都已转成数组/对象）。 */
export function renderJson(model) {
  return `${JSON.stringify(model, null, 2)}\n`;
}

// ---------------------------------------------------------------- 写盘（--apply / --out）

/** 从既有报告里读"当日第 N 次生成"（拿不到 → null）。 */
export function parseGeneration(text) {
  const m = /本文件为当日第\s*(\d+)\s*次生成/.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

/** 从既有报告里读 content-key（拿不到 → null）。 */
export function parseContentKey(text) {
  const m = /<!--\s*progress-content-key:\s*([0-9a-f]{8,64})\s*-->/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** 是否落在生产报告目录下（J16 用）。 */
export function isProductionOut(abs, outDir = DEFAULT_OUT_DIR) {
  const a = path.resolve(abs).toLowerCase();
  const r = path.resolve(outDir).toLowerCase();
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * 落盘（**唯一写路径**；非 `--apply/--out` 时根本不会被调用 → J8）。
 * - 幂等：既有文件 content-key 与新 key 相同 ⇒ 跳过写（mtime 不变，J9）
 * - 降级保护：看板不可达时目标已由调用方改成 `.DEGRADED.md`（J10b）
 * @returns {{ok:boolean, wrote:boolean, skipped:boolean, file:string, generation:number|null, bytes?:number, reason?:string}}
 */
export function writeReport(model, text, opts = {}) {
  const file = String(opts.file ?? model.apply.target);
  const writeText = opts.writeText ?? ((f, t) => writeTextAtomic(f, t, opts.writeOpts ?? {}));
  const readText = opts.readText ?? ((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } });

  // J16：测试模式不得写生产报告目录（机器强制，不靠自觉）。
  // ⚠️ 判定基数**必须是生产常量**，**不吃 `opts.outDir` 注入** —— 否则"注入一个临时 outDir"
  //    就把守门绕过去了。这一条是踩过的坑：本卡首版按可注入 outDir 判定，单测当轮真的把
  //    `j16-probe-testhost.md` 写进了生产 `docs\reports\`（2026-09-17 15:01 实测，已删除）。
  const env = opts.env ?? process.env;
  if (String(env.DSH_PROGRESS_TEST ?? '') === '1' && isProductionOut(file)) {
    return { ok: false, wrote: false, skipped: false, file, generation: null, reason: 'J16：测试模式（DSH_PROGRESS_TEST=1）拒绝写生产报告目录（用 --out <tmp> 注入临时路径）' };
  }

  const existing = readText(file);
  if (existing != null && parseContentKey(existing) === model.contentKey) {
    return { ok: true, wrote: false, skipped: true, file, generation: parseGeneration(existing), reason: '内容哈希相同 → 跳过写（幂等键 = content-key）' };
  }
  const generation = existing != null ? (parseGeneration(existing) ?? 0) + 1 : 1;
  // §2.2 档级标记（`progress` 族 · 方案 §3.1）：插入点由权威源 `insertAtFor()` 按文档真实 H1 定（落点 L2）
  const stamped = stampDocMark(text, 'progress', insertAtFor(firstH1Index(text)));
  const body = stamped.replace('<!-- generation-slot -->', `> 本文件为当日第 ${generation} 次生成，历史版本不保留（同日多次 \`--apply\` = 整份覆写）\n`);
  try {
    const r = writeText(file, body);
    return { ok: true, wrote: true, skipped: false, file, generation, bytes: r?.bytes ?? Buffer.byteLength(body, 'utf8') };
  } catch (e) {
    return { ok: false, wrote: false, skipped: false, file, generation, reason: `写盘失败：${e?.message ?? e}` };
  }
}

// ---------------------------------------------------------------- 入口

/**
 * 跑一次（**不直接 exit**：返回 {exitCode, stdout, stderr}，供单测与 CLI 共用）。
 * @param {object} opts 见 buildModel；另有 argv（CLI 用）与 log
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, model:object|null}>}
 */
export async function runProgressStatus(opts = {}) {
  const env = opts.env ?? process.env;
  const args = opts.argv ? { ...parseArgs(opts.argv) } : { ...(opts.args ?? {}), errors: opts.args?.errors ?? [] };
  const logLines = [];
  const log = (m) => { logLines.push(String(m)); if (typeof opts.log === 'function') opts.log(String(m)); };

  if (args.help) return { exitCode: 0, stdout: usageText(), stderr: '', model: null };
  if (args.errors?.length) {
    return { exitCode: 2, stdout: '', stderr: `${args.errors.map((e) => `progress-status: ${e}`).join('\n')}\n${usageText()}`, model: null };
  }
  // --only 提前归一（非法键 = 用法错；不进入取数）
  let only = null;
  if (args.only) {
    const nk = normalizeKey(args.only);
    if (!nk.ok) {
      return { exitCode: 2, stdout: '', stderr: `progress-status: --only 键非法：${nk.error}\n`, model: null };
    }
    only = nk.canon;
  }

  let model;
  try {
    model = await buildModel({ ...opts, args, only, mode: args.verify ? 'verify' : 'render', format: args.json ? 'json' : 'md', apply: args.apply, out: args.out });
  } catch (e) {
    return { exitCode: 2, stdout: '', stderr: `progress-status: 取数/建模失败（未捕获）：${e?.stack ?? e}\n`, model: null };
  }

  if (only && !model.entries.some((e) => e.key === only)) {
    return { exitCode: 2, stdout: '', stderr: `progress-status: --only ${only} 在总纲权威表与登记表里都不存在（键形态合法但查无此条）\n`, model };
  }

  // 落盘：仅 --apply / --out 时才碰文件（J8）
  if (args.apply || args.out) {
    {
      const rendered = renderMarkdown(model, { only, generation: null });
      const withSlot = rendered.replace(
        `> <!-- progress-content-key: ${model.contentKey} -->`,
        `<!-- generation-slot -->> <!-- progress-content-key: ${model.contentKey} -->`,
      );
      const r = writeReport(model, withSlot, { file: model.apply.target, env, outDir: opts.outDir ?? DEFAULT_OUT_DIR });
      model.apply = { ...model.apply, requested: true, ...r };
      if (!r.ok) {
        log(`progress-status: ${r.reason}（目标 ${r.file}）`);
        model.exitCode = 2;   // 写盘失败/被 J16 拒绝 = 环境错
      } else if (r.skipped) {
        log(`progress-status: 幂等跳过（${r.file} 内容未变）`);
      } else {
        log(`progress-status: 已写 ${r.file}（当日第 ${r.generation} 次）`);
      }
    }
  }

  const text = model.format === 'json' ? renderJson(model) : renderMarkdown(model, { only, generation: model.apply.generation });
  // 生成行：md 直接渲染时用真 N；写盘路径已由 writeReport 注入（渲染文本只用于 stdout）
  const stderr = logLines.length ? `${logLines.join('\n')}\n` : '';
  return { exitCode: model.exitCode, stdout: text, stderr, model };
}

/** 是不是本文件被直接执行（junction 下 `import.meta.url` 是物理路径、`argv[1]` 是逻辑路径 ⇒ 必须 realpath 双方再比）。 */
function isMainEntry() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]).toLowerCase() : '';
    return Boolean(argv1) && self === argv1;
  } catch { return false; }
}

async function main() {
  const r = await runProgressStatus({ argv: process.argv.slice(2) });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.exitCode;   // ⚠️ 用 exitCode，禁用 process.exit()（Windows + undici 的 libuv 断言坑）
}

if (isMainEntry()) {
  main().catch((e) => {
    process.stderr.write(`progress-status: 未捕获异常：${e?.stack ?? e}\n`);
    process.exitCode = 2;
  });
}

export default runProgressStatus;
