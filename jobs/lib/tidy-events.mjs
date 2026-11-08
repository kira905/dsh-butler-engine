// dsh-butler / lib/tidy-events.mjs —— P8「收纳」P2 事件（**报告段 · 零 KPI 污染**）
//
// ⚠️ 为什么**不进** `watch-events.mjs` 的 `EVENT_SPECS`（本文件第一条纪律，与 `lib/handoff-events.mjs`
//   同源）：`docs\P2会盯人-使用与验收-20260909.md` §四「新增事件前必读 · KPI 口径铁律」实测写明：
//   任何事件只要注册进主表，就会抬高裸跑期门槛②的分母，并在 4h 后（未 ack ⇒ 判定疑似误报）
//   抬高门槛③的分子。**天生"零 KPI 污染"的观测只有一条路：不进主表，走 writeReport 的报告段。**
//   ⇒ 本事件族由 watch tick 以 `writeReport({ extra })` 落地（`lib/watch-notify.mjs` 的 extra 通道）。
//   ⇒ 也正因如此，这里的事件规格**自带注册表**（`TIDY_EVENT_SPECS` / `TIDY_EVENT_IDS`），
//      供验收方读源码 / 单测 / registry 复核 —— "有注册"与"不进主表"两者同时成立。
//
// 注册范围（**口径先例 = K5b · 只注册执行类事件**，不注册候选提示类）：
//   `docs\交付报告-看板瘦身K5b登记-20260928.md` §2② —— `board-line-archive` 的 P2 事件注册
//   `kinds: ['auto-action-executed','auto-action-failed','auto-action-skip']`，理由是
//   "注册面过宽会抬高只读提示的告警分母"。本模块**逐条对应**这 3 类，**不另造第二套命名**：
//
//   | 本模块事件 id        | 类别     | 对应 K5b kind           | 触发场景 |
//   |----------------------|----------|-------------------------|----------|
//   | `tidy-move-applied`  | 执行     | `auto-action-executed`  | P8 L2 真搬完成（info · 只进报告，永不推送） |
//   | `tidy-move-failed`   | 失败     | `auto-action-failed`    | 真搬有失败项 / 搬后校验不一致 |
//   | `tidy-audit-skipped` | 跳过     | `auto-action-skip`      | 连续跨线让路（≥3 轮）⇒ 审计事实上没在跑 |
//
//   **明确不注册**（候选提示 / 只读提示类 —— 与 K5b 口径一致，登记在 `TIDY_NOT_REGISTERED`，
//   其事实仍由 `butler-tidy-state.json` + 面板「🗂 收纳」卡承载，不进 P2 事件池）：
//   `tidy-backlog` / `tidy-naming-drift` / `tidy-orphan-restore` / `tidy-policy-stale` / `tidy-data-risk`。
//   ⚠️ 这条是 2026-10-09 本卡（冲刺600·补C2C3）的**有意取舍**：原 `butler-tidy-tick.mjs#P2_EVENTS_POLICY`
//      的 `planned` 六类里，只有 3 类属"执行类"；把 5 类只读提示一起放开会让每次审计都往告警池里
//      倒一批"提示"，把真异常淹没（P2 验收档 §四的原话：噪声会抬高分母、稀释信号）。
//
// 纪律：本模块**只判定不动作**（纯函数；`planTidyObservation` 也不写盘——落盘由调用方决定）。
//   数据源只读：`~/.dsh/butler-tidy-state.json`（采集层 `watch-collect.mjs#collectTidy` 摘录）
//   + `~/.dsh/butler-audit/<YYYY-MM>.jsonl` 的 `tidy-move-apply` 行（真搬留痕，唯一源头是
//   `butler-tidy-move.mjs:236-242`；**本模块不重写它的字段口径**）。
import path from 'node:path';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';

export const TIDY_EVENTS_VERSION = '0.1.0';

/** 【2c-B2】运行键文件路径（统一入口；legacy 期 = 旧名）。 */
function tidyObsFileOf(home) {
  return resolveStatePath(TIDY_OBS_STATE_NAME, { home }).path;
}
/** 运行键（"同一批搬移只播报一次"/"让路轮次变了才再报"）；butler- 前缀 ⇒ 已在 P5 自指豁免清单内。 */
export const TIDY_OBS_STATE_NAME = 'butler-tidy-obs.json';
export const TIDY_OBS_SCHEMA = 1;

export const LEVEL = { RED: 'red', YELLOW: 'yellow', INFO: 'info' };
/** 走报告段的固定提示（每次 reportOnly 输出都带，便于日后复核"为什么没告警"）。 */
export const REPORT_ONLY_NOTE = '报告段（P8 收纳 · 零 KPI 污染：不进 EVENT_SPECS 主表）';

/** 连续让路到多少轮才值得报（默认 3 轮 ≈ 1.5 天 @12h 间隔）。低于此值属正常互斥，不报。 */
export const TIDY_SKIP_STREAK_DEFAULT = 3;

/** 已注册的 P2 事件种类（机器可核；`butler-tidy-tick.mjs#P2_EVENTS_POLICY.kinds` 取它，单一真相）。 */
export const TIDY_P2_EVENT_KINDS = Object.freeze(['tidy-move-applied', 'tidy-move-failed', 'tidy-audit-skipped']);

/** 明确**不注册**的候选提示 / 只读提示类（留痕：为什么它们不在池子里）。 */
export const TIDY_NOT_REGISTERED = Object.freeze([
  { id: 'tidy-backlog', why: '只读提示（_tmp 积压）：事实在 state.audit.findings + 面板卡，不占告警分母' },
  { id: 'tidy-naming-drift', why: '只读提示（命名规范漂移）：同上' },
  { id: 'tidy-orphan-restore', why: '只读提示（孤儿备份）：同上' },
  { id: 'tidy-policy-stale', why: '只读提示（策略文件陈旧）：同上' },
  { id: 'tidy-data-risk', why: '审计提示（⛔ block 计数）：属"只读审计结论"，非动作类 ⇒ 按 K5b 口径不注册' },
]);

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const tsLocal = (v) => {
  const t = num(v);
  if (t === null) return '?';
  try { return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return new Date(t).toISOString(); }
};

// ---------------------------------------------------------------- 事件规格注册表

/**
 * 事件规格注册表（机器可核）。judge(snapshot, opts) → null | {value, detail, evidence, level?}
 * snapshot 需含：`tidy`（采集层 `watch-collect.mjs#collectTidy` 的产出，见该函数头注）。
 */
export const TIDY_EVENT_SPECS = [
  {
    // 类别：执行（K5b `auto-action-executed`）。level=info ⇒ **只进报告段，永不推送、不动桌宠**。
    id: 'tidy-move-applied', title: '收纳搬移完成（留痕）', level: LEVEL.INFO, deliverable: 'report',
    category: 'tidy', dataSource: 'tidyMove',
    judge: (s) => {
      const m = s?.tidy?.moves?.last;
      if (!m) return null;
      const moved = num(m.moved) ?? 0;
      const failed = num(m.failed) ?? 0;
      if (moved <= 0 || failed > 0 || m.verified !== true) return null; // 有失败 ⇒ 归 tidy-move-failed
      return {
        value: `applied@${m.at}@${moved}`,
        level: LEVEL.INFO,
        detail: `P8 L2 真搬完成：${moved} 条 → \`${m.bucket ?? '?'}\`（跳过 ${num(m.skipped) ?? 0}）· 搬后校验 ✅ · 一键回滚见桶内 restore 脚本（by=${m.by ?? '?'}）`,
        evidence: { at: m.at ?? null, bucket: m.bucket ?? null, moved, skipped: num(m.skipped), failed, verified: m.verified === true, by: m.by ?? null, reason: m.reason ?? null },
      };
    },
  },
  {
    // 类别：失败（K5b `auto-action-failed`）。🔴 但 deliverable='report' ⇒ 只进报告段（P2 口径：
    //   "🔴 推"是对主表事件说的；本族按卡面「只进报告，别污染在跑的观测口径」处理）。
    id: 'tidy-move-failed', title: '收纳搬移失败 / 校验不一致', level: LEVEL.RED, deliverable: 'report',
    category: 'tidy', dataSource: 'tidyMove',
    judge: (s) => {
      const m = s?.tidy?.moves?.last;
      if (!m) return null;
      const failed = num(m.failed) ?? 0;
      const bad = m.verified !== true;
      if (failed <= 0 && !bad) return null;
      const bits = [];
      if (failed > 0) bits.push(`失败 ${failed} 条`);
      if (bad) bits.push('搬后校验不一致');
      return {
        value: `failed@${m.at}@${failed}@${m.verified === true ? 'ok' : 'bad'}`,
        level: LEVEL.RED,
        detail: `P8 L2 搬移出问题（${bits.join(' · ')}）· 桶 \`${m.bucket ?? '?'}\` · 共 ${num(m.moved) ?? 0} 条已搬 —— 先跑桶内 restore 脚本核对，别直接重跑（会把已搬的再搬一次）`,
        evidence: { at: m.at ?? null, bucket: m.bucket ?? null, moved: num(m.moved), skipped: num(m.skipped), failed, verified: m.verified === true, by: m.by ?? null, reason: m.reason ?? null },
      };
    },
  },
  {
    // 类别：跳过（K5b `auto-action-skip`）。判据 = 跨线让路**连续**多轮 ⇒ 审计事实上停摆。
    //   ⚠️ 单轮让路是**正常互斥**（交接窗口/TTL），只有连续 ≥N 轮才值得报——照 `repair-linger` 的
    //   "常态不报、异常才报"口径（方案 §3.1 的教训：把常态当异常 = 报警失去含义）。
    id: 'tidy-audit-skipped', title: '收纳审计连续让路（事实停摆）', level: LEVEL.YELLOW, deliverable: 'report',
    category: 'tidy', dataSource: 'tidyLane',
    judge: (s, opts = {}) => {
      const lane = s?.tidy?.lane;
      if (!lane || !lane.skipped) return null;
      const streak = num(lane.streak) ?? 1;
      const threshold = num(opts.tidySkipStreak) ?? TIDY_SKIP_STREAK_DEFAULT;
      if (streak < threshold) return null;
      const since = num(lane.sinceMs);
      const hours = since === null ? null : Math.round((s.now - since) / 3_600_000);
      return {
        value: `skipped@${lane.skipped}@${streak}`,
        level: lane.skipped === 'judge-unavailable' ? LEVEL.RED : LEVEL.YELLOW,
        detail: `收纳审计连续 ${streak} 轮让路（原因 \`${lane.skipped}\`${lane.owner ? ` · 让给 ${lane.owner}` : ''}${hours === null ? '' : ` · 自 ${tsLocal(since)} 起约 ${hours}h`}）—— 连续让路期间**审计没在跑**，_tmp / _archive 的账是旧的`,
        evidence: { skipped: lane.skipped, streak, owner: lane.owner ?? null, sinceMs: since, since: lane.since ?? null, reasons: lane.reasons ?? null, at: lane.at ?? null },
      };
    },
  },
];

/** 事件 id 清单（单测 / registry / 面板共用；**与主表 `EVENT_IDS` 必须零交集**）。 */
export const TIDY_EVENT_IDS = TIDY_EVENT_SPECS.map((e) => e.id);

/** 判定全部收纳事件（纯函数；单条判定抛错只丢该条，绝不让 tick 挂）。 */
export function judgeTidyEvents(snapshot, opts = {}) {
  const out = [];
  for (const spec of TIDY_EVENT_SPECS) {
    let r = null;
    try {
      r = spec.judge(snapshot, opts);
    } catch (e) {
      r = { value: 'judge-error', level: LEVEL.YELLOW, detail: `收纳事件 ${spec.id} 判定异常：${e?.message ?? e}`, evidence: { error: String(e?.message ?? e) } };
    }
    if (!r) continue;
    out.push({
      id: spec.id, title: spec.title,
      level: r.level ?? spec.level,
      category: spec.category, dataSource: spec.dataSource,
      reportOnly: spec.deliverable === 'report',
      value: r.value ?? null, detail: r.detail ?? '', evidence: r.evidence ?? {},
    });
  }
  return out;
}

// ---------------------------------------------------------------- 采集层契约（只写形状，不碰 IO）

/**
 * 采集层产出契约（`watch-collect.mjs#collectTidy` 必须按此形状给 `snap.tidy`）：
 *
 * ```js
 * {
 *   ok: boolean,            // false ⇒ 判定层一律不报（并可在报告段给"不可探测"显式出口）
 *   reason: string|null,    // ok=false 时的原因（**不许静默**）
 *   stateFile: string,
 *   stateMtimeMs: number|null,
 *   updatedAt: number|null, // state.updatedAt（epoch）
 *   counters: { runs, fails, skips } | null,
 *   lane: { skipped, streak, sinceMs, owner, reasons, at } | null,
 *   audit: { checkpoints, produced, block, warn, ok } | null,   // 上次审计的三色计数（只读）
 *   p2Events: { registered, reason, kinds } | null,             // 取自 state.lastRun.gate.p2Events
 *   moves: { last: MoveRow|null, tail: MoveRow[], error: string|null },  // 审计流水 tidy-move-apply
 * }
 * ```
 * `MoveRow` = `{ at, atMs, bucket, moved, skipped, failed, verified, by, reason }`（源头 = butler-tidy-move.mjs:236）。
 */
export const TIDY_SNAPSHOT_CONTRACT = 'lib/tidy-events.mjs 头部 §采集层契约';

// ---------------------------------------------------------------- 去重（防每 5 分钟刷一行）

/**
 * 计划「要不要写这一轮的报告段」（去重）。
 *
 * 去重键（**全部基于事件自带 value** —— 值不变量即"状态没变"）：
 *   · `tidy-move-applied` / `tidy-move-failed` —— `value` 含 `at` ⇒ 同一批搬移只播报一次；
 *   · `tidy-audit-skipped` —— `value` 含 `streak` ⇒ **streak 每增一轮才再报一次**（连续让路不刷屏，
 *     但也不静默：事实停摆会随轮次显形）。
 * ⚠️ 基础必须是 **next.runKeys**（本轮已累积的键），不是 prev.runKeys —— 这是 `lib/handoff-events.mjs`
 *   2026-09-28 实测踩过的坑（写成 prev 时，本轮前几个键被逐个覆盖 ⇒ 一轮多事件只剩最后一个键 ⇒
 *   下一轮其余事件全部重复播报）。本模块照抄修好后的写法。
 *
 * @param {Array} events judgeTidyEvents 的产出
 * @param {{prev?:object|null, now?:number, tidySkipStreak?:number}} [opts]
 * @returns {{lines:string[], picked:Array, next:object, changed:boolean}}
 */
export function planTidyObservation(events, opts = {}) {
  const prev = opts.prev && typeof opts.prev === 'object' ? opts.prev : {};
  const rows = Array.isArray(events) ? events : [];
  const lines = [];
  const next = { ...prev };
  const picked = [];
  for (const ev of rows) {
    const key = `${ev.id}@${ev.value ?? ''}`;
    if (prev.runKeys && prev.runKeys[key]) continue;
    next.runKeys = { ...(next.runKeys ?? prev.runKeys ?? {}), [key]: true };
    picked.push(ev);
  }
  // 运行键表限长（防无限增长；保留最近 50 条）
  if (next.runKeys) {
    const keys = Object.keys(next.runKeys);
    if (keys.length > 50) next.runKeys = Object.fromEntries(keys.slice(-50).map((k) => [k, true]));
  }
  if (picked.length) {
    lines.push(`**🧹 收纳 —— ${REPORT_ONLY_NOTE}**`);
    const icon = { red: '🔴', yellow: '🟡', info: '⬜' };
    for (const ev of picked) lines.push(`- ${icon[ev.level] ?? '⚪'} **${ev.title}**（\`${ev.id}\`）：${ev.detail}`);
    lines.push('');
  }
  return { lines, picked, next, changed: picked.length > 0 };
}

/**
 * **显式出口**（本卡的硬要求：绝不静默留空）。
 *
 * 报告段只在"有事件"时才写（`writeReport` 的语义：无内容不落盘）⇒ 光靠报告段，"今天收纳没事"
 * 与"收纳判定根本没接线"在纸面上不可区分。本函数给一条**任何时候都能读到的结论行**，
 * 供：① `lib\tidy-events.mjs --status`（只读 CLI）② `dsh-butler-watch.mjs --dry-run --json`
 * 的 `tidyStatus` 字段 ③ 单测。三种未触发形态各有明确措辞，**没有"什么都没写"这条路**。
 *
 * @param {object} snapshot 含 `tidy`
 * @param {{events?:Array, now?:number}} [opts]
 * @returns {{state:string, text:string}}
 *   state ∈ `not-wired`（快照没这字段）/ `undetectable`（采集失败）/ `idle`（接线正常、无事件）
 *           / `fired`（有事件）
 */
export function describeTidyStatus(snapshot, opts = {}) {
  const now = num(opts.now) ?? num(snapshot?.now) ?? Date.now();
  const t = snapshot?.tidy;
  const events = Array.isArray(opts.events) ? opts.events : judgeTidyEvents({ ...(snapshot ?? {}), now }, opts);
  if (!t || typeof t !== 'object') {
    return { state: 'not-wired', text: '收纳（P8）：❔ **未接线**（本快照没有 tidy 采集字段）—— 这不等于「收纳没事」，是判定入口没接上' };
  }
  if (t.ok !== true) {
    return { state: 'undetectable', text: `收纳（P8）：❔ **不可探测**（采集失败：${t.reason ?? '未知原因'}）—— 这是显式出口，**不是**「收纳没事」` };
  }
  const a = t.audit ?? {};
  const bits = [
    `上次审计 ${t.updatedAt ? tsLocal(t.updatedAt) : '?'}（检查点 ${a.produced ?? '?'}/${a.checkpoints ?? '?'} · ⛔${a.block ?? '?'} 🟡${a.warn ?? '?'} ✅${a.ok ?? '?'}）`,
    t.lane?.skipped ? `跨线让路 streak=${t.lane.streak ?? '?'}（${t.lane.skipped}）` : '未在让路',
    t.moves?.last ? `最近搬移 ${tsLocal(t.moves.last.atMs)}（搬 ${t.moves.last.moved ?? 0} · 失败 ${t.moves.last.failed ?? 0}）` : '无搬移记录',
    // ⚠️ 注册状态取**本模块的当前口径**（代码即真相），不读 `t.p2Events`（那是上次采集器跑时的历史快照）
    `P2 注册=${TIDY_P2_EVENT_KINDS.length} 类（报告段${t.p2Events?.registered === true ? ' · 采集器已记录' : ' · 采集器尚未刷新 state'}）`,
  ];
  if (events.length) {
    return { state: 'fired', text: `收纳（P8）：⚠️ 本轮 **${events.length}** 条事件 —— ${events.map((e) => `\`${e.id}\``).join('、')} · ${bits.join(' · ')}` };
  }
  return { state: 'idle', text: `收纳（P8）：✅ 无事件 · ${bits.join(' · ')}` };
}

/** 运行键文件路径（butler- 前缀 ⇒ 已豁免 P5 自指审计）。 */
export function tidyObsStatePath(opts = {}) {
  const home = opts.home
    ?? process.env.BUTLER_DSH_HOME
    ?? process.env.DSH_HOME
    ?? path.join(process.env.USERPROFILE ?? '', '.dsh');
  return opts.stateFile ?? tidyObsFileOf(home);
}

// ---------------------------------------------------------------- 只读 CLI（显式出口）

const HELP = [
  'tidy-events —— P8「收纳」P2 事件判定层（只读；报告段，零 KPI 污染）',
  '  node lib\\tidy-events.mjs --status [--json] [--home <dir>] [--root <dir>]',
  '    只读打印当前收纳判定（含"未触发"的显式出口）—— 不写任何文件。',
  '  node lib\\tidy-events.mjs --list',
  '    列出注册表：已注册 3 类（执行/失败/跳过）+ 明确不注册的候选提示类。',
].join('\n');

async function cli() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (!argv.length || has('--help')) { console.log(HELP); return 0; }
  if (has('--list')) {
    console.log('已注册（报告段 · 不进主表）：');
    for (const e of TIDY_EVENT_SPECS) console.log(`  · ${e.id} [${e.level}] ${e.title}（${e.dataSource}）`);
    console.log('明确不注册（候选提示 / 只读提示类）：');
    for (const e of TIDY_NOT_REGISTERED) console.log(`  · ${e.id} —— ${e.why}`);
    return 0;
  }
  if (has('--status')) {
    const C = await import('../../src/dsh-butler/lib/watch-collect.mjs');
    const snap = { now: Date.now(), tidy: C.collectTidy({ home: val('--home'), root: val('--root'), now: Date.now() }) };
    const evs = judgeTidyEvents(snap, {});
    const st = describeTidyStatus(snap, { events: evs, now: snap.now });
    if (has('--json')) {
      process.stdout.write(JSON.stringify({ status: st, events: evs, tidy: snap.tidy }, null, 2) + '\n');
    } else {
      console.log(st.text);
      for (const e of evs) console.log(`  - [${e.level}] ${e.id}：${e.detail}`);
    }
    return 0;
  }
  console.error(HELP);
  return 2;
}

// 入口守卫：junction 子目录里跑时 import.meta.url 会解析为物理路径，而 argv[1] 是逻辑路径
// ⇒ 双方 realpathSync 后再比（见 persona 铁律；否则脚本静默退出 0 无输出）。
const isMain = await (async () => {
  try {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const a = fs.realpathSync(process.argv[1] ?? '');
    const b = fs.realpathSync(url.fileURLToPath(import.meta.url));
    return a === b;
  } catch { return false; }
})();
if (isMain) process.exitCode = await cli();
