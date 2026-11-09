// dsh-butler / lib/reconcile.mjs —— P7「会照应」对账器（卡 [8]）
//
// 契约来源：docs\大管家v2方案-从只读到真管家-20260909.md §4 P7（行 884-904）
//   四类输出（全部 🟡，⬜ 级：只落日报/文件，不推送）：
//     1. 耦合预警：此卡/文档与 N 处既有内容同实体
//     2. 落地缺口：方案说了 X 但无卡认领
//     3. 脱管任务：有卡在做 X 但方案没提
//     4. 三件套缺项：docs\调研-*.md / 待办-*.md / 交接-*.md§6 缺「决定 / 归属 / 触发」（V3.1.0 §13 D1）
//   防噪音：同实体同类型 24h 只提示一次；阈值 = 耦合 ≥2 处且该实体非高频词；
//           IDF 过滤（>idfRatio 载体不提示）；误报走「忽略并记录」沉淀忽略规则。
//   后置自检：建卡 / 建档 / 改方案后必跑一次（动作链固定一步）。
//
// 依赖：lib/entities.mjs（索引）+ lib/store.mjs（状态读写唯一入口）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { butlerPaths, dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { readJson, writeTextAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { updateStateJson } from '../../src/dsh-butler/lib/dual-write-store.mjs';
import { writeStateText } from '../../src/dsh-butler/lib/dual-write.mjs';
import {
  COMPONENT_VERSION, ENTITIES_SCHEMA, buildIndex, ensureIndex, entitiesPath, readIndex,
  normalizeText, CORE_KINDS, HIGH_FREQ_MIN, dshRoot,
} from './entities.mjs';

export const COMPONENT_NAME = 'butler-reconcile';
export const RECONCILE_SCHEMA = 1;

/** 四类输出的 id 前缀（进状态 / 去噪 / 忽略规则的键）。 */
export const KINDS = ['coupling', 'gap', 'orphan', 'triad'];
export const KIND_LABEL = {
  coupling: '耦合预警', gap: '落地缺口', orphan: '脱管任务', triad: '三件套缺项',
};
export const KIND_ICON = {
  coupling: '🔗', gap: '🕳', orphan: '🪁', triad: '🧩',
};

/** 24h 去噪窗口（同实体同类型只提示一次）。 */
export const COOLDOWN_MS = 24 * 3600 * 1000;
/** 单轮每类输出上限（防刷屏；超出只计数）。 */
export const DEFAULT_MAX_ITEMS = 8;
/** 忽略记录上限。 */
const MAX_IGNORED = 200;
const MAX_SEEN = 500;

export function reconcileStatePath(home = dshHome()) {
  return resolveStatePath('butler-reconcile-state.json', { home }).path;
}

// ---------------------------------------------------------------- 纯函数：候选筛选

/** 实体是否可参与提示（非高频 + 非泛词残渣）。 */
export function isHintable(e) {
  return Boolean(e) && e.highFreq !== true;
}

/**
 * 耦合候选：单个实体 → 它把哪些载体串在一起。
 *
 * **判据（spike A4 三轮校准后的严格口径，2026-09-12）**：
 *   ① 非高频（IDF 过滤后）
 *   ② **≥2 张看板卡的标题**都提到它（kindsTitle.board ≥ boardTitleMin）
 *      —— 单卡提到只是"这条卡的事"，多卡提到才是"有人在管同一件事"
 *   ③ 它还出现在别的**职责型载体**（卡/方案节/文档）里：coreTitle ≥ coreTitleMin
 *   ④ 全局占比 ≤ maxRatio（默认 5%）：`tick`/`部署`/`插件` 这类跨领域词载体数太多，
 *      比值判据比绝对阈值稳（语料从 600 涨到 945，绝对阈值 10% 实测只滤掉 4 个实体）
 *
 * 为什么这么严：945 载体规模下裸「≥2 处」几乎恒真。三轮人工抽查（每轮 20 条）显示
 * 判据从「≥2 处」→「标题锚点」→「多卡标题 + 占比」后误报率从 ~50% → ~30% → 目标 ≤20%。
 * 更严的另一面是漏掉部分低价值耦合（如 `git`、`tickd` 卡间重叠）—— 那是可接受的取舍：
 * 统筹提示宁可少而准（⬜ 级语义），漏掉的仍留在索引里供 `--card` 单卡对账查。
 */
export function couplingCandidates(index, opts = {}) {
  const boardTitleMin = opts.boardTitleMin ?? 2;
  const coreTitleMin = opts.coreTitleMin ?? 3;
  const minCarriers = opts.minCarriers ?? 3;
  const maxRatio = opts.maxRatio ?? 0.03;
  /**
   * 占比过滤的绝对地板：命中数 ≤ 此值的实体一律不判高频。
   * 为什么必须有地板：小语料（夹具 / 新机器首建 / 刚起步的看板）里任何实体都容易"占比很高"，
   * 按比例一刀切会把真实体全部误杀（2026-09-12 单测实测：27 载体的夹具里 guard2 占 26% → 被过滤光）。
   * 真实语料（≈1000 载体）下 20 处 ≈ 2%，离 5% 阈值还有距离，不影响"大词过滤"。
   */
  const ratioFloorHits = opts.ratioFloorHits ?? 20;
  const total = index?.counts?.carriers ?? 0;
  const out = [];
  for (const e of Object.values(index?.entities ?? {})) {
    if (!isHintable(e)) continue;
    if (e.carriers < minCarriers) continue;
    if (total && e.carriers > ratioFloorHits && e.carriers / total > maxRatio) continue;
    const boardTitle = e.kindsTitle?.board ?? 0;
    if (boardTitle < boardTitleMin) continue;
    // 两条等价路径：
    //   ① 多卡 + 有文档/方案标题命中 → 典型的「卡 ↔ 文档/方案」照应
    //   ② 核心标题命中 ≥3 → 命中面足够广（卡 + 方案节 + 文档）
    const withDoc = (boardTitle >= boardTitleMin && ((e.kindsTitle?.docs ?? 0) + (e.kindsTitle?.plan ?? 0)) >= 1);
    if (!withDoc && (e.coreTitle ?? 0) < coreTitleMin) continue;
    out.push({
      entity: e.key, carriers: e.carriers, core: e.core ?? 0, coreTitle: e.coreTitle ?? 0,
      boardTitle, kinds: e.kinds ?? {}, kindsTitle: e.kindsTitle ?? {}, sample: e.sample ?? [],
    });
  }
  return out.sort((a, b) => (b.boardTitle - a.boardTitle) || (b.coreTitle - a.coreTitle) || (b.carriers - a.carriers) || a.entity.localeCompare(b.entity));
}

/**
 * 核心 → 辅助降权匹配（脱管任务判据）。
 * 理由：一个词只有同时出现在"卡 + 方案/文档"里才叫"方案没提"，只跟记忆撞词是巧合。
 */
const downgrade = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 词段边界字符（归一化文本里判定"完整词段"用）。 */
const SEG_BOUNDARY = ' \u0001\u3000-—–_/,、。;；:：()（）[]【】|';

/**
 * 归一化文本里是否含该**完整词段**（两侧为边界或串首尾）。
 * 与全局子串匹配的区别：`modlens` 不会命中 `modlens-3254-upgrade` 之外的语境？——会，
 * 但不会命中 `amodlensx` 这类粘连；真正的作用是拒绝"标题里只当普通子串出现"的巧合。
 */
export function hasSegment(text, segment) {
  const hay = normalizeText(text);
  const needle = normalizeText(segment);
  if (!hay || !needle) return false;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? '' : hay[i - 1];
    const after = i + needle.length >= hay.length ? '' : hay[i + needle.length];
    const okBefore = !before || SEG_BOUNDARY.includes(before);
    const okAfter = !after || SEG_BOUNDARY.includes(after);
    if (okBefore && okAfter) return true;
    from = i + 1;
  }
}

/**
 * 脱管任务候选：有卡在做 X（**卡标题**里出现）但方案/文档没提。
 *
 * 判据（2026-09-12 实测校准）：
 *   · 非高频（IDF + 泛词黑名单）
 *   · kindsTitle.board ≥ minBoardTitle（默认 2）：至少两张卡**在标题里**提到它
 *   · 方案/文档**标题**都未命中（docsTitle + planTitle == 0）—— 只在正文撞词不算"提过"
 *   · 辅助侧（archive / memory）**标题里显式含**该实体
 *
 * 为什么不用"降权匹配"（原 v1 判据）：`restore` / `running` / `home` 这类词在卡描述里
 * 到处出现，降权匹配后仍会刷屏。改成「卡标题命中」后只剩真正的项目词。
 */
export function orphanCandidates(index, opts = {}) {
  const minBoardTitle = opts.minBoardTitle ?? 3;
  const minAux = opts.minAux ?? 2;
  /** "方案没提"的严格口径：docs + plan **标题**命中数必须 < 此值才算没提（1 条提过不算）。 */
  const docsTitleMin = opts.docsTitleMin ?? 1;
  const out = [];
  const cmap = new Map((index?._carriers ?? []).map((c) => [c.id, c]));
  for (const e of Object.values(index?.entities ?? {})) {
    if (!isHintable(e)) continue;
    // 门槛用"在途卡标题命中"（≥3 张卡在标题里提到它）
    const boardTitle = e.liveBoardTitle ?? 0;
    if (boardTitle < minBoardTitle) continue;
    if (((e.kindsTitle?.docs ?? 0) + (e.kindsTitle?.plan ?? 0)) >= docsTitleMin) continue;
    const core = downgrade(e.key);
    if (core.length < 3) continue;
    const sample = (e.sample ?? []).map((id) => cmap.get(id)).filter(Boolean);
    // 辅助侧要求"标题里作为**完整词段**出现"（不是全局子串降权匹配 —— 那样 modlens
    // 会因为标题里写过 modlens 的升级记录而被当"提过"，把卡判成脱管是误报）
    const aux = sample.filter((c) => c.kind === 'archive' || c.kind === 'memory')
      .filter((c) => hasSegment(c.title, e.key));
    if (aux.length < minAux) continue;
    out.push({
      entity: e.key, carriers: e.carriers, core: e.core ?? 0, kinds: e.kinds ?? {},
      boardTitle,
      boards: sample.filter((c) => c.kind === 'board'),
      aux: aux.slice(0, 3),
    });
  }
  return out.sort((a, b) => (b.boardTitle - a.boardTitle) || a.entity.localeCompare(b.entity));
}

/** 方案登记的工程节点（方案文档里声明的 P 编号 / 有卡前缀）。 */
export function planNodes(index) {
  const nodes = [];
  for (const c of (index?._carriers ?? [])) {
    if (c.kind !== 'plan') continue;
    const m = /#(P\d+(?:\.\d+)?)$/.exec(c.id);
    if (m) nodes.push({ node: m[1], title: c.title, carrierId: c.id, path: c.path, line: c.line });
  }
  return nodes.sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }));
}

/**
 * 卡是否有"认领"某节点：卡标题里出现该节点编号。
 *
 * 判据细节（不这么做会误判）：先把标题里所有 P 编号形态抠出来再比集合 ——
 *   「[1.5] 升级锁 + 中断检测」→ {P1.5}；搜「P1」时若用"含 P1 即算"，
 *   就会把 P1.5 的卡误判成 P1 的认领者。
 */
export function nodeClaimed(node, boardTitles) {
  const target = String(node).trim().toUpperCase();
  const re = /[Pp]\d+(?:\.\d+)?|\[\d+(?:\.\d+)?\]/g;
  for (const raw of boardTitles) {
    const t = String(raw ?? '').toUpperCase();
    for (const m of t.matchAll(re)) {
      const token = m[0].replace(/^\[|\]$/g, '');
      const norm = token.startsWith('P') ? token.slice(1) : token;
      if (`P${norm}` === target) return true;
    }
  }
  return false;
}

/**
 * 落地缺口候选：方案声明的节点在途卡里无人认领（"方案无主"）。
 * 判据：方案节 P 编号 ∉ 任何**非归档**卡标题；且该节尚未被忽略。
 */
export function gapCandidates(index, opts = {}) {
  const nodeMap = new Map(planNodes(index).map((n) => [n.node, n]));
  const boards = (index?._carriers ?? []).filter((c) => c.kind === 'board' && !c.archived);
  const titles = boards.map((c) => c.title);
  const out = [];
  for (const [node, info] of nodeMap) {
    if (nodeClaimed(node, titles)) continue;
    out.push({ node, title: info.title, path: info.path, line: info.line, carrierId: info.carrierId });
  }
  return out.sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }));
}

// ---------------------------------------------------------------- 纯函数：三件套缺项（D1）

/**
 * 三件套（V3.1.0 需求收集 §13 **D1**）：每份「要留话给未来」的档必须含三样。
 *   · 决定：做 / 不做 / 待拍板（**写死不做也算决定**）
 *   · 归属：哪条线 / 哪张卡 / 谁
 *   · 触发：什么条件回来看
 * 缺任一样 ⇒ 报黄（🟡 / ⬜ 级"统筹提示"，不是告警）。
 *
 * 🔴 本判据**只做缺项体检**：不评价决定合不合理、不补内容、不改被扫的档、不建卡，
 *    也不取代 rulecheck / dor / dod（它们是"文档格式/建卡前置/验收"的判据，各自真源）。
 *
 * **认不出的写法怎么办（2026-11-02 卡定 · 二选一里的 ①）**：**放过（宁可漏）**。
 *   判据 = 单元里三样标记**一个都认不出来** ⇒ 整份不报，只计入 `triadStats.skippedNoMarker`。
 *   代价：真的写了决定/归属/触发、但用了本表没收的词（英文表述、"结论：做"这类）会被漏掉；
 *   换来的是**不误报**——没认出来就不下结论，符合"宁可漏不可错"。
 */
export const TRIAD_PARTS = ['decision', 'owner', 'trigger'];
export const TRIAD_PART_LABEL = { decision: '决定', owner: '归属', trigger: '触发' };

/**
 * 三件套标记**宽词表**（宽 = 宁可漏；每条都写清为什么收它）。
 * 文档要求"决定"是本鱼自己定的口径：收常见同义写法，认不出的走上面那条"放过"。
 */
export const TRIAD_PATTERNS = {
  decision: [
    /决定/,                     // 最直白
    /拍板/,                     // 「待拍板」「已拍板」——待拍板也是决定的一种取值
    /定案|已定|定为/,            // 「已定案 / 暂定为」
    /不做|不采纳|不采用|不开卡|不建卡/, // 写死不做也算决定（§13 D1 原文）
    /采纳|采用/,                 // 「采纳 A 案」
    /确认为/,                    // 「确认为现用生产管线」（存量修法实际用词）
  ],
  owner: [
    /归属|归口/,                 // 「归属：XX 线」
    /认领/,                      // 看板语义：卡认领某节
    /负责人|责任人|跟进人|执行人/,
    /\bowner\b/i,
    /由[^\n]{0,20}(负责|跟进|来做|推进|承接|接手)/, // 「由画面线跟进」
  ],
  trigger: [
    /触发|回落/,                 // 「触发条件：…」
    /回来(再|看|查|读|评)/,        // 「什么时候回来再看」
    /回头看|回看/,
    /复查|复看|复评|复验/,
    /(重新|再)评估|再复核/,
    /什么(时候|条件下)/,          // 「什么情况下回来」半句
  ],
};

/** 扫描对象：三处（缺哪处都不完整）。`unit` = 判整份 / 只判某段。 */
export const TRIAD_TARGETS = [
  { prefix: '调研-', unit: 'file', label: '调研档' },
  { prefix: '待办-', unit: 'file', label: '待办档' },
  { prefix: '交接-', unit: 'section', label: '交接档 §6' },
];

/** 交接档里"待主人拍板"段的标题判据（只认 2 级及更深；`#` 一级是文档标题不是段）。 */
export const TRIAD_SECTION_RE = /^#{2,6}\s*[^\n]*(待主人拍板|待拍板)/;
/** 已办结/已关闭的段不判（宁可漏：段被封了却还报缺项只会吵）。 */
const TRIAD_SECTION_CLOSED_RE = /办结|已关|关闭|作废|已收尾/;

/** 行号从 1 开始；返回 {start,end,heading}（end 含）。 */
function sectionsOf(lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m) heads.push({ line: i + 1, level: m[1].length, text: m[2].trim() });
  }
  const out = [];
  for (let k = 0; k < heads.length; k += 1) {
    const h = heads[k];
    if (h.level < 2) continue;
    if (!TRIAD_SECTION_RE.test(lines[h.line - 1])) continue;
    if (TRIAD_SECTION_CLOSED_RE.test(h.text)) continue;
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j += 1) {
      if (heads[j].level <= h.level) { end = heads[j].line - 1; break; }
    }
    out.push({ start: h.line, end, heading: h.text });
  }
  return out;
}

/** 单元内找某个 part 的首个命中行（单元标题行本身不算内容）。 */
function firstHit(lines, unit, patterns) {
  const from = unit.heading ? unit.start + 1 : unit.start;
  for (let i = from; i <= unit.end && i <= lines.length; i += 1) {
    const text = lines[i - 1] ?? '';
    if (!text.trim()) continue;
    for (const re of patterns) {
      if (re.test(text)) return { line: i, text: text.trim() };
    }
  }
  return null;
}

/**
 * 三件套缺项候选（**只读**：不写任何被扫的档、不改索引）。
 *
 * @param {{dshRoot?:string, docsDir?:string, docs?:string[], readFile?:(p:string)=>string}} [opts]
 * @returns {{items:Array, stats:object}}
 *   items[]: { key, file, path, line, missing[], missingParts[], found[], unit, section }
 *     · `file` 形如 `docs\调研-xxx.md`，`line` 是「该看哪一行」——
 *       交接档指向 §6 段标题行（"这一段"缺什么），调研/待办指向第一个已写标记的行（往后补）。
 */
export function triadCandidates(opts = {}) {
  const root = opts.dshRoot ?? dshRoot();
  const docsDir = opts.docsDir ?? path.join(root, 'docs');
  const readFile = opts.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const names = opts.docs ?? (() => {
    try { return fs.readdirSync(docsDir); } catch { return []; }
  })();
  const stats = {
    filesSeen: 0, filesScanned: 0, units: 0,
    skippedNoSection: 0, skippedNoMarker: 0, complete: 0, missing: 0,
  };
  const out = [];
  for (const name of names) {
    const target = TRIAD_TARGETS.find((t) => String(name).startsWith(t.prefix) && /\.md$/i.test(String(name)));
    if (!target) continue;
    stats.filesSeen += 1;
    let text;
    try { text = readFile(path.join(docsDir, String(name))); } catch { continue; }
    const lines = String(text ?? '').split(/\r?\n/);
    const units = target.unit === 'section'
      ? sectionsOf(lines)
      : [{ start: 1, end: lines.length, heading: null }];
    if (!units.length) { stats.skippedNoSection += 1; continue; } // 没有 §6 待拍板段 ⇒ 判据不适用
    stats.filesScanned += 1;
    const unit = units[0]; // 一份档只判第一个符合条件的段（多段时取最上面那段，口径写进报告）
    stats.units += 1;
    const found = {};
    for (const part of TRIAD_PARTS) {
      const hit = firstHit(lines, unit, TRIAD_PATTERNS[part]);
      if (hit) found[part] = hit;
    }
    const foundParts = TRIAD_PARTS.filter((p) => found[p]);
    if (!foundParts.length) { stats.skippedNoMarker += 1; continue; } // 认不出 ⇒ 放过（宁可漏）
    const missingParts = TRIAD_PARTS.filter((p) => !found[p]);
    if (!missingParts.length) { stats.complete += 1; continue; }
    stats.missing += 1;
    out.push({
      key: String(name),
      file: `docs\\${name}`,
      path: path.join(docsDir, String(name)),
      line: unit.heading ? unit.start : found[foundParts[0]].line,
      missing: missingParts.map((p) => TRIAD_PART_LABEL[p]),
      missingParts,
      found: foundParts.map((p) => TRIAD_PART_LABEL[p]),
      foundLines: Object.fromEntries(foundParts.map((p) => [TRIAD_PART_LABEL[p], found[p].line])),
      unit: target.unit,
      section: unit.heading,
    });
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { items: out, stats };
}

// ---------------------------------------------------------------- 纯函数：去噪 / 忽略

/** 提示项 id（稳定，供 24h 去噪与忽略规则）：kind + 主键（不含数值/时间）。 */
export function itemId(kind, key) {
  return `${kind}:${String(key).toLowerCase()}`;
}

/** 忽略规则匹配（完全匹配 key / 前缀 *）。 */
export function isIgnored(item, rules = []) {
  const id = itemId(item.kind, item.key);
  return rules.some((r) => {
    const pat = String(r?.match ?? '').toLowerCase();
    if (!pat) return false;
    if (pat.endsWith('*')) return id.startsWith(pat.slice(0, -1));
    return id === pat;
  });
}

/**
 * 24h 去噪：同实体同类型 24h 只提示一次。
 * @param {Array} items
 * @param {object} state 状态文件内容（带 seen 段）
 * @param {number} now
 * @returns {{kept:Array, suppressed:Array}}
 */
export function applyCooldown(items, state, now = Date.now()) {
  const seen = state?.seen ?? {};
  const kept = [];
  const suppressed = [];
  for (const it of items) {
    const id = itemId(it.kind, it.key);
    const last = Number(seen[id]?.at ?? 0);
    if (last && now - last < COOLDOWN_MS) suppressed.push({ ...it, id, suppressedUntil: last + COOLDOWN_MS });
    else kept.push({ ...it, id });
  }
  return { kept, suppressed };
}

/** 记录本轮提示（供下一轮去噪）。 */
export function markSeen(state, items, now = Date.now()) {
  const next = { ...(state ?? {}) };
  const seen = { ...(next.seen ?? {}) };
  for (const it of items) seen[itemId(it.kind, it.key)] = { at: now, kind: it.kind, key: it.key };
  // 裁剪：只留最近的 MAX_SEEN 条
  const entries = Object.entries(seen).sort((a, b) => Number(b[1]?.at ?? 0) - Number(a[1]?.at ?? 0));
  next.seen = Object.fromEntries(entries.slice(0, MAX_SEEN));
  next.seenTrimmedAt = entries.length > MAX_SEEN ? now : (next.seenTrimmedAt ?? null);
  return next;
}

/** 忽略规则增删（CLI 用）。 */
export function addIgnoreRule(rules, match, reason, now = Date.now()) {
  const m = String(match ?? '').trim().toLowerCase();
  if (!m) throw new Error('忽略规则的 match 不能为空');
  const rest = (rules ?? []).filter((r) => String(r?.match ?? '').toLowerCase() !== m);
  const next = [{ match: m, reason: String(reason ?? '').trim(), at: now }, ...rest];
  return next.slice(0, MAX_IGNORED);
}

export function removeIgnoreRule(rules, match) {
  const m = String(match ?? '').trim().toLowerCase();
  return (rules ?? []).filter((r) => String(r?.match ?? '').toLowerCase() !== m);
}

// ---------------------------------------------------------------- 载体标题解析（输出用）

function carrierTitleMap(index) {
  return new Map((index?._carriers ?? []).map((c) => [c.id, c]));
}

function shortTitle(t, n = 46) {
  const s = String(t ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------------------------------------------------------------- 主对账流程

/**
 * 跑一轮对账（纯计算 + 可选落盘；不推送）。
 * @param {{
 *   home?:string, dshRoot?:string, now?:number,
 *   index?:object,              // 复用已建索引（测试用）
 *   categories?:string[],       // 只跑某几类（默认三类全跑）
 *   ignoreRules?:Array,         // 覆盖忽略规则（默认读状态文件）
 *   noCooldown?:boolean,        // 单测用：跳过去噪
 *   maxItems?:number,
 *   persist?:boolean,           // 默认 true：写 butler-reconcile-state.json
 *   indexOpts?:object,          // 透传给 ensureIndex
 * }} [opts]
 * @returns {object} 对账结果
 */
export function reconcile(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const cats = (opts.categories ?? KINDS).filter((c) => KINDS.includes(c));
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;

  // —— 索引：复用或重建（tick 每日一次时用 ensureIndex 做增量校验）
  let index = opts.index ?? null;
  let indexInfo = { rebuilt: false, reused: false };
  if (!index) {
    const r = ensureIndex({ home, dshRoot: opts.dshRoot, now, ...(opts.indexOpts ?? {}) });
    index = r.index;
    indexInfo = { rebuilt: r.rebuilt, reused: !r.rebuilt, errors: r.errors };
  }

  const statePrev = (() => {
    try { return readJson(reconcileStatePath(home), { schemaVersion: RECONCILE_SCHEMA, defaultValue: null, home }) ?? {}; }
    catch { return {}; }
  })();
  const rules = opts.ignoreRules ?? statePrev.ignored ?? [];

  const cmap = carrierTitleMap(index);
  const items = [];
  const counts = { coupling: 0, gap: 0, orphan: 0, triad: 0 };
  const ignoredHits = [];
  let triadStats = null;

  // ① 耦合预警
  if (cats.includes('coupling')) {
    for (const c of couplingCandidates(index, opts.coupling)) {
      counts.coupling += 1;
      const carriers = (c.sample ?? []).map((id) => cmap.get(id)).filter(Boolean);
      const kinds = carriers.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] ?? 0) + 1; return acc; }, {});
      items.push({
        kind: 'coupling', key: c.entity, entity: c.entity,
        carriers: c.carriers, core: c.core, kinds, carriersSample: carriers.slice(0, 4),
        title: `与 ${c.core} 处既有内容同实体「${c.entity}」`,
      });
    }
  }

  // ② 落地缺口（方案说了 X 但无卡认领）
  if (cats.includes('gap')) {
    for (const g of gapCandidates(index)) {
      counts.gap += 1;
      items.push({
        kind: 'gap', key: g.node, entity: g.node,
        title: `方案第 ${g.node} 节「${shortTitle(g.title, 40)}」无卡认领`,
        detail: `${path.basename(String(g.path ?? ''))}:${g.line}`,
      });
    }
  }

  // ③ 脱管任务（有卡在做 X 但方案没提）
  if (cats.includes('orphan')) {
    for (const o of orphanCandidates(index, opts.orphan)) {
      counts.orphan += 1;
      items.push({
        kind: 'orphan', key: o.entity, entity: o.entity,
        carriers: o.carriers, core: o.core, kinds: o.kinds,
        title: `有卡在做「${o.entity}」但方案/文档未提`,
        boards: (o.boards ?? []).map((b) => shortTitle(b.title, 38)),
        aux: (o.aux ?? []).map((a) => `${a.kind}:${shortTitle(a.title, 30)}`),
      });
    }
  }

  // ④ 三件套缺项（决定 / 归属 / 触发 · V3.1.0 §13 D1）
  //   · 只读扫 docs\调研-*.md / 待办-*.md / 交接-*.md§6；不改档、不补内容、不建卡
  //   · 每条必带 file + line（"档 + 行号"），只报文件名不算数
  if (cats.includes('triad')) {
    const tri = opts.triad ?? triadCandidates({ dshRoot: opts.dshRoot });
    triadStats = tri.stats ?? null;
    for (const t of tri.items ?? []) {
      counts.triad += 1;
      items.push({
        kind: 'triad', key: t.key, entity: t.key,
        file: t.file, line: t.line, path: t.path,
        missing: t.missing, missingParts: t.missingParts,
        found: t.found, foundLines: t.foundLines,
        section: t.section,
        // 排序用：缺两件 > 缺一件；调研/待办档（整份可补）> 交接档 §6（历史快照多）
        core: (t.missingParts ?? []).length,
        order: t.unit === 'file' ? 0 : 1,
        title: `${t.file}:${t.line} 缺「${(t.missing ?? []).join('」「')}」`,
      });
    }
  }

  // —— 忽略规则
  const afterIgnore = [];
  for (const it of items) {
    if (isIgnored(it, rules)) ignoredHits.push({ ...it, ignoredBy: rules.find((r) => isIgnored(it, [r]))?.match ?? null });
    else afterIgnore.push(it);
  }

  // —— 24h 去噪
  const cooldown = opts.noCooldown
    ? { kept: afterIgnore, suppressed: [] }
    : applyCooldown(afterIgnore, statePrev, now);

  // —— 每类取前 maxItems（其余只计数）
  const kept = [];
  const overflow = [];
  const perKind = {};
  for (const it of cooldown.kept) {
    perKind[it.kind] = (perKind[it.kind] ?? 0) + 1;
    if (perKind[it.kind] <= maxItems) kept.push(it); else overflow.push(it);
  }
  // 排序：耦合按 core 降序，其余按 key（三件套额外用 order：调研/待办 先于 交接§6）
  kept.sort((a, b) => (a.kind === b.kind)
    ? ((b.core ?? 0) - (a.core ?? 0)
      || (a.order ?? 0) - (b.order ?? 0)
      || String(a.key).localeCompare(String(b.key)))
    : KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));

  const result = {
    schemaVersion: RECONCILE_SCHEMA,
    at: now,
    index: {
      builtAt: index.builtAt ?? null,
      carriers: index.counts?.carriers ?? 0,
      entities: index.counts?.entities ?? 0,
      highFreq: index.counts?.highFreq ?? 0,
      idfLimit: index.params?.idfLimit ?? null,
      rebuilt: indexInfo.rebuilt === true,
      errors: indexInfo.errors ?? index.errors ?? [],
    },
    counts,
    shown: kept.length,
    items: kept,
    overflow: overflow.length,
    suppressed: cooldown.suppressed.length,
    ignored: ignoredHits.length,
    ignoredHits: ignoredHits.slice(0, 5),
    rulesCount: rules.length,
    triadStats,
  };

  if (opts.persist !== false) {
    try {
      const next = markSeen({
        ...statePrev,
        schemaVersion: RECONCILE_SCHEMA,
        lastRunAt: now,
        lastCounts: counts,
        lastShown: kept.length,
        lastSuppressed: result.suppressed,
        lastIgnored: result.ignored,
      }, kept, now);
      const dw = writeStateText('butler-reconcile-state.json', JSON.stringify(next, null, 2) + '\n', {
        home, write: (p, t) => writeTextAtomic(p, t),
      });
      if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
    } catch (e) {
      result.persistError = String(e?.message ?? e);
    }
  }
  return result;
}

// ---------------------------------------------------------------- 日报段 / 文本渲染

/**
 * 日报「💡 统筹提示」段（P7 输出 = 日报语义，不是告警语义）。
 * @param {object} result reconcile() 结果
 * @param {{maxLines?:number, withHeader?:boolean}} [opts]
 * @returns {string[]}
 */
export function dailySectionLines(result, opts = {}) {
  const L = [];
  if (opts.withHeader !== false) {
    L.push('## 💡 统筹提示（P7 会照应）');
    L.push('');
  }
  if (!result) {
    L.push('_（对账器未就绪）_');
    L.push('');
    return L;
  }
  const total = KINDS.reduce((acc, k) => acc + (result.counts?.[k] ?? 0), 0);
  const idx = result.index ?? {};
  if (!result.items?.length) {
    L.push(total === 0
      ? `- ✅ 无跨载体耦合 / 落地缺口 / 脱管任务 / 三件套缺项（索引 ${idx.carriers ?? 0} 载体 · ${idx.entities ?? 0} 实体`
        + `${idx.idfLimit ? ` · IDF 上限 ${idx.idfLimit}` : ''}）`
      : `- ✅ 本类无新提示（本轮候选 ${total} 条，${result.suppressed ?? 0} 条被 24h 去噪、${result.ignored ?? 0} 条被忽略规则拦下）`);
    L.push('');
    return L;
  }
  for (const it of result.items) {
    const lines = [];
    if (it.kind === 'coupling') {
      const where = (it.carriersSample ?? []).map((c) => `${c.kind}:${shortTitle(c.title, 34)}`).join(' ｜ ');
      lines.push(`- ${KIND_ICON.coupling} ${it.title}`);
      if (where) lines.push(`  - ${where}`);
    } else if (it.kind === 'gap') {
      lines.push(`- ${KIND_ICON.gap} ${it.title}${it.detail ? `（${it.detail}）` : ''}`);
    } else if (it.kind === 'triad') {
      // 硬要求：指名到「档 + 行号」（title 里已经是 `docs\xxx.md:123 缺「触发」`）
      lines.push(`- ${KIND_ICON.triad} ${it.title}${(it.found ?? []).length ? `（已写：${it.found.join('、')}）` : ''}`);
      if (it.section) lines.push(`  - 段：${shortTitle(it.section, 40)}`);
    } else {
      lines.push(`- ${KIND_ICON.orphan} ${it.title}`);
      if ((it.boards ?? []).length) lines.push(`  - 卡：${it.boards.join(' ｜ ')}`);
      if ((it.aux ?? []).length) lines.push(`  - 其它：${it.aux.join(' ｜ ')}`);
    }
    L.push(...lines);
  }
  const extra = [];
  if (result.overflow) extra.push(`另有 ${result.overflow} 条同类未展开（每天每类最多 ${DEFAULT_MAX_ITEMS} 条）`);
  if (result.suppressed) extra.push(`${result.suppressed} 条被「同实体 24h 一次」去噪`);
  if (result.ignored) extra.push(`${result.ignored} 条被忽略规则拦下`);
  // 兜底文案必须先落位（既有单测与读者都认它），三件套统计只往后追加、不顶掉它
  if (!extra.length) extra.push(`本轮候选 ${total} 条已全部展开（24h 内同实体同类型不重复提示）`);
  const ts = result.triadStats;
  if (ts) extra.push(`三件套：扫 ${ts.filesScanned} 份（${ts.complete} 齐 / ${ts.missing} 缺项），`
    + `${ts.skippedNoSection} 份无 §6 待拍板段、${ts.skippedNoMarker} 处认不出（按「宁可漏」放过）`);
  L.push(`- （${extra.join(' · ')}）`);
  L.push('');
  return L;
}

/** CLI / 面板用的一行摘要。 */
export function summaryLine(result) {
  if (!result) return '对账器未就绪';
  const c = result.counts ?? {};
  return `耦合 ${c.coupling ?? 0} · 落地缺口 ${c.gap ?? 0} · 脱管任务 ${c.orphan ?? 0} · 三件套缺项 ${c.triad ?? 0}`
    + `（展开 ${result.shown ?? 0} 条 · 去噪 ${result.suppressed ?? 0} · 忽略 ${result.ignored ?? 0}）`
    + `｜索引 ${result.index?.carriers ?? 0} 载体 / ${result.index?.entities ?? 0} 实体`;
}

// ---------------------------------------------------------------- 状态文件（CLI 用）

export function readReconcileState(home = dshHome()) {
  return readJson(reconcileStatePath(home), { schemaVersion: RECONCILE_SCHEMA, defaultValue: null, home }) ?? {
    schemaVersion: RECONCILE_SCHEMA, seen: {}, ignored: [],
  };
}

/** 忽略规则增删（走 store.updateJson：RMW 锁 + 原子写）。 */
export function updateIgnored(mutator, home = dshHome()) {
  return updateStateJson('butler-reconcile-state.json', reconcileStatePath(home), (cur) => {
    const base = cur ?? { schemaVersion: RECONCILE_SCHEMA, seen: {}, ignored: [] };
    const next = mutator({ ...base, ignored: base.ignored ?? [], seen: base.seen ?? {} });
    return next;
  }, { schemaVersion: RECONCILE_SCHEMA, defaultValue: { schemaVersion: RECONCILE_SCHEMA, seen: {}, ignored: [] }, home });
}

/** 状态摘要（--status 用）。 */
export function statusSummary(home = dshHome()) {
  const st = readReconcileState(home);
  let indexInfo = null;
  try {
    const idx = readIndex({ home });
    indexInfo = idx ? {
      builtAt: idx.builtAt, carriers: idx.counts?.carriers ?? 0, entities: idx.counts?.entities ?? 0,
      highFreq: idx.counts?.highFreq ?? 0, params: idx.params ?? {}, errors: idx.errors ?? [],
    } : null;
  } catch (e) {
    indexInfo = { error: String(e?.message ?? e) };
  }
  return {
    ok: true,
    index: indexInfo,
    indexFile: entitiesPath(home),
    stateFile: reconcileStatePath(home),
    lastRunAt: st.lastRunAt ?? null,
    lastCounts: st.lastCounts ?? null,
    lastShown: st.lastShown ?? null,
    seenCount: Object.keys(st.seen ?? {}).length,
    rules: st.ignored ?? [],
  };
}

export { HIGH_FREQ_MIN, CORE_KINDS };
