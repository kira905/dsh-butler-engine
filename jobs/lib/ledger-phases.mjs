// ============================================================================
// dsh-butler / lib/ledger-phases.mjs —— 主线流水「phase」词表的**单点真源**
//
// 出处：docs\方案-三层角色工作方式与主线流水-V9.md
//   §5.3（L335）「`--phase` 白名单 = Object.keys(PHASES)，**不再硬编码一份"10 个值"的字符串**」
//   §7.1（L665-673）「词表单点真源 = 本文件」+ 数据模型 {desc, dir, byWhitelist?, requires?}
//   §7.2（L703-717）11 行表 / 10 个 phase（第 9 行 `reason` 不是 phase）+ 反例
//   §14.2 P1 行（L1129）把「ledger-phases」列在 P1 交付面内
//
// 为什么必须单独一个文件：CLI 若自己写一份"10 个值"的字符串，将来新增第 11 个 phase 时
//   那一份立刻过时，而**绕过 CLI 直接 append** 正是方案明令禁止的路（§5.3）。
//   白名单只能有一份，且 CLI / 读端都 import 它。
//
// 本文件是**两张词表的单点真源**（别的地方不许再写一份字符串数组）：
//   · `PHASES`        —— 10 个 phase key（P1-b 落的，写端 `--phase` 白名单）
//   · `LEDGER_STATES` —— 12 个读端态 key（P1-c 落的，§5.5 判据；**顺序 = 判定优先级**）
//
// 判据（P1-c 卡面要求，现跑可验）：`rg "PHASES\s*=\s*\{" <workspace>\tools -l` ⇒ **恰 1 个文件**。
//   ⚠️ 本机 rg 不在 PATH（术语 'rg' 不会被识别）⇒ 用 node 器具/Select-String 跑同一条。
//
// §7.1 同段还点了 SUSPECT_RULES / PUSH_RULES 两个导出，它们属 §7.3 的范围（后续卡），
//   且方案自身对条数有两种说法（§7.1 写 `SUSPECT_RULES.length === 5`，§7.3 结尾写 `=== 6`）
//   ⇒ 仍不落，避免把一个还没裁定的口径焊进代码。⚠️ 未查证项已记进交付报告。
// ============================================================================

/**
 * phase 词表（**10 个 key**，顺序与方案 §7.2 表一致）。
 *
 * 数据模型：
 *   desc          给人读的一句话定义
 *   dir           'human' = 人会写的主态/标记；'ops' = 只给机器写
 *   byWhitelist   只许列出的 `--by` 传（缺省 = self / hook / scan 都行）
 *   requires      必带的行内字段（CLI 缺则 rc=2）
 *   mark          §7.2 的"标记"类（closed / wait-card）—— 只是给人看的分类位，不参与守卫
 *
 * ⚠️ `recovered` **不在**本表里，且 `--phase recovered` 永远 rc=2：
 *    它是 `ledger-repair.mjs --compact` 的收据行标记（§5.5 读策略第 3 条），
 *    **只有那一个器具会写它**，不经 CLI 传入（§5.3 L337 / §7.1 L672）。
 */
export const PHASES = {
  handoff: {
    desc: '本轮跑了交棒/接力，本会话退役',
    dir: 'human',
  },
  'handed-off': {
    desc: '已交棒，本会话只回话不接活（跨多轮）',
    dir: 'human',
  },
  'await-decision': {
    desc: '等主人拍决定/口径，下一步是我做',
    dir: 'human',
  },
  'await-action': {
    desc: '等主人做一下（权限/身份/平台限制），我做不到',
    dir: 'human',
  },
  'await-window': {
    desc: '等一个可停机/可重启的窗口',
    dir: 'human',
  },
  idle: {
    desc: '本会话活着、手上无活',
    dir: 'human',
  },
  closed: {
    desc: '这条线结项了，不再接活（标记）',
    dir: 'human',
    mark: true,
  },
  'wait-card': {
    desc: '名下有卡在跑，等它进待验收（标记）',
    dir: 'human',
    mark: true,
  },
  'scan-fill': {
    desc: '这一轮被漏掉了，B 路补的账（只许 --by scan）',
    dir: 'ops',
    byWhitelist: ['scan'],
  },
  void: {
    desc: '冲销某一行（行序语义：只作废它之前那一行）',
    dir: 'ops',
    requires: ['voids', 'reason'],
  },
};

/** 全部合法 phase key（数组；顺序 = 表序）。 */
export const PHASE_KEYS = Object.freeze(Object.keys(PHASES));

/** `--phase` 是不是词表内的 key（`recovered` 等一律 false）。 */
export function isPhase(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(PHASES, key);
}

/** 取某一 phase 的定义（不存在 ⇒ null）。 */
export function phaseDef(key) {
  return isPhase(key) ? PHASES[key] : null;
}

/** 单测/守卫用的自检（不通过就 throw，避免"词表悄悄变了没人知道"）。 */
export function assertPhaseContract() {
  const n = Object.keys(PHASES).length;
  if (n !== 10) throw new Error(`PHASES 应为 10 个 key，实际 ${n}`);
  if (Object.prototype.hasOwnProperty.call(PHASES, 'recovered')) throw new Error('recovered 不在 PHASES 里（§5.3）');
  if (!Array.isArray(PHASES['scan-fill'].byWhitelist) || PHASES['scan-fill'].byWhitelist.join(',') !== 'scan') {
    throw new Error('scan-fill 必须 byWhitelist:["scan"]');
  }
  const req = PHASES.void.requires ?? [];
  if (!(req.includes('voids') && req.includes('reason'))) throw new Error('void 必须 requires:["voids","reason"]');
  return true;
}

// ============================================================================
// LEDGER_STATES —— 读端 12 态（**顺序就是 §5.5 读策略第 0 条"判定优先级"**）
//
// 出处：V9 §5.4 L395-406（态枚举 = 12 个）· §5.5 L419-448（判据 / 报什么 / 为什么分开 / 谁收拾）
//       §5.5 L451（`orphan-file` 为什么排在 `ledger-broken` 前）· L452（`scan-stale` 为什么排在 `missing-round` 前）
//
// 数据模型：
//   desc    给人读的一句话判据
//   level   'red' | 'orange' | 'yellow' | 'gray' | 'silent' | 'ok' —— 只用来"多线汇总时取最严重的那个"
//   report  落点（§5.5「每行的落点」表：报给谁 + 多久没人确认算失效）
//   rc      读端 CLI 的退出码（⚠️ 方案只钉死了 `lines-map-missing ⇒ rc=3`，其余是本卡定的，
//           写在表里 === 单点，不许在 CLI 里另写一份 if/else）
//
// ⚠️ 三条**不许改**：
//   ① key 数 = 12（`Object.keys(LEDGER_STATES).length === 12` 是 §5.4 L397 的单测断言）
//   ② **key 的书写顺序 = 判定优先级**（`LEDGER_STATE_ORDER` 直接取 keys 顺序 ⇒ 别为了"看着整齐"重排）
//   ③ `ledger-missing` **作废**（§5.4 L404），既不是 key 也不许当别名
// ============================================================================
export const LEDGER_STATES = {
  'lines-map-missing': {
    desc: '`_lines.json` 缺失 / 解析失败 / `_meta.json` 版本不认 —— 映射表没了，谁是谁都不知道',
    level: 'red',
    report: 'router + 日报 + 晨报（立即）',
    rc: 3,
  },
  absent: {
    desc: '连 `mainline-ledger\\` 目录都不存在（全员首跑都是这个态，报了就是 25 条红）',
    level: 'silent',
    report: '静默（首跑）',
    rc: 0,
  },
  'rotated-new': {
    desc: '有**上月**文件但**当月**文件不存在（每月 1 号常见）',
    level: 'gray',
    report: '当日只提示一次（不喊人）',
    rc: 0,
  },
  empty: {
    desc: '目录在、但该 `lineId` 当月文件不存在 / 0 行 —— "这条线还没开始记账"',
    level: 'yellow',
    report: '日报（黄 · `ledger-new`）',
    rc: 0,
  },
  'orphan-file': {
    desc: '`mainline-ledger\\` 顶层（非递归、跳过 `_` 开头）有**不属于任何 `lineId`** 的 `<文件名>.jsonl`',
    level: 'yellow',
    report: '日报（黄）；连续 7 天 ⇒ 升级',
    rc: 6,
  },
  'ledger-broken': {
    desc: '文件整份不可用：坏行 ≥50%，或**第 1 行就坏**',
    level: 'red',
    report: 'router + 日报 + 晨报（立即）',
    rc: 8,
  },
  'ok-gapped': {
    desc: '有坏行但坏行 <50% 且第 1 行可解析 ⇒ 跳过坏行继续读，账本仍可用',
    level: 'yellow',
    report: '日报（黄）；连续 7 天或 `badLines` 增长 ⇒ 升级',
    rc: 5,
  },
  'tail-broken': {
    desc: '只有**最后一行**不完整（写到一半被杀/断电），且该文件 mtime 已稳定 ≥5 秒',
    level: 'yellow',
    report: '日报（黄，不喊人）',
    rc: 6,
  },
  'scan-stale': {
    desc: '**这条线自己**多久没被扫到（`_cursor.json#lines[<lineId>]` 超龄 > 6 分钟，或 dirtyUnread>0 且连续 3 轮没扫）',
    level: 'orange',
    report: 'router + 日报（橙）；连续 3 天 ⇒ 升级',
    rc: 7,
  },
  'missing-round': {
    desc: '文件有历史行，但距最后一条成功解析的行已 > N 分钟（默认 30）**且**该窗口内本线有新 `turn/end`',
    level: 'orange',
    report: 'router + 日报（橙）；连续 3 天 ⇒ 升级',
    rc: 7,
  },
  'logs-archived': {
    desc: '本线 `archivedSids > 0`（判据 = **读归档标记**，不许按"日志文件搬到哪去了"判）',
    level: 'gray',
    report: '日报（灰）',
    rc: 0,
  },
  ok: {
    desc: '全部行解析成功、无缺失、无孤儿、扫描未停 —— **兜底态，不列在 §5.5 表里**',
    level: 'ok',
    report: '—',
    rc: 0,
  },
};

/** 12 个态 key（数组；**顺序 = 判定优先级**，见 §5.5 读策略第 0 条） */
export const LEDGER_STATE_KEYS = Object.freeze(Object.keys(LEDGER_STATES));

/** 判定优先级（与 key 顺序同一份，别另抄） */
export const LEDGER_STATE_ORDER = LEDGER_STATE_KEYS;

/** 等级 → 严重度数字（多线汇总时取 max；同分再按优先级取靠前的） */
const LEVEL_SEVERITY = { red: 5, orange: 4, yellow: 3, gray: 2, silent: 1, ok: 0 };

/** 是不是 12 态之一（`ledger-missing` 等作废词一律 false） */
export function isLedgerState(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(LEDGER_STATES, key);
}

/** 取某个态的严重度（非法 key ⇒ 抛，别静默当 ok） */
export function stateSeverity(key) {
  if (!isLedgerState(key)) throw new Error(`stateSeverity: 不是 LEDGER_STATES 的 key = ${String(key)}`);
  return LEVEL_SEVERITY[LEDGER_STATES[key].level];
}

/**
 * 汇总多个态 ⇒ 最严重的那个（同分取 `LEDGER_STATE_ORDER` 里靠前的）。
 * 空数组 ⇒ `ok`。
 */
export function worstState(states) {
  let best = 'ok';
  for (const s of states ?? []) {
    if (!isLedgerState(s)) continue;
    const a = stateSeverity(s);
    const b = stateSeverity(best);
    if (a > b || (a === b && LEDGER_STATE_ORDER.indexOf(s) < LEDGER_STATE_ORDER.indexOf(best))) best = s;
  }
  return best;
}

/** 12 态的守卫自检（不通过就 throw） */
export function assertStateContract() {
  const keys = Object.keys(LEDGER_STATES);
  if (keys.length !== 12) throw new Error(`LEDGER_STATES 应为 12 个 key，实际 ${keys.length}`);
  if (keys.includes('ledger-missing')) throw new Error('ledger-missing 已作废（§5.4），不许当 key');
  const head = keys.slice(0, 2).join(',');
  if (head !== 'lines-map-missing,absent') throw new Error(`判定优先级前两位应为 lines-map-missing → absent，实际 ${head}`);
  const iOrphan = keys.indexOf('orphan-file');
  const iBroken = keys.indexOf('ledger-broken');
  if (!(iOrphan >= 0 && iBroken >= 0 && iOrphan < iBroken)) throw new Error('orphan-file 必须排在 ledger-broken 前（§5.5 L451）');
  const iScan = keys.indexOf('scan-stale');
  const iMissing = keys.indexOf('missing-round');
  if (!(iScan >= 0 && iMissing >= 0 && iScan < iMissing)) throw new Error('scan-stale 必须排在 missing-round 前（§5.5 L452）');
  if (keys[keys.length - 1] !== 'ok') throw new Error('ok 必须是最后一个（兜底）');
  for (const k of keys) {
    const d = LEDGER_STATES[k];
    if (!d || typeof d.desc !== 'string' || !d.desc) throw new Error(`LEDGER_STATES.${k} 缺 desc`);
    if (!(d.level in LEVEL_SEVERITY)) throw new Error(`LEDGER_STATES.${k} 的 level 不合法（${d.level}）`);
    if (!Number.isInteger(d.rc)) throw new Error(`LEDGER_STATES.${k} 缺 rc`);
  }
  return true;
}

export default PHASES;

