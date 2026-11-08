// dsh-butler / lib/queue-wake.mjs —— 队列推进「自动叫醒」动作（L2 模块 `queue-wake` 的执行体）
//
// 由来：`docs\管家-开关矩阵与放行判据-20260913.md` §3.1 待实现动作清单第 1 项（卡：V3 全量开发 批次 2）。
//   规则 R2「锁后交付」：代码进生产 + 开关默认关 + 单测/夹具 + dry-run 可跑 + 生产零动作强断言 + 回滚点 + 登记 + 流水。
//
// 【动作语义（照矩阵 §3 表，不自创）】
//   把「待验收卡 + 空闲会话」推进到叫醒：
//     · 只叫 `running=false` 的**空闲**会话（目标 = 标题以【运行】开头的**唯一**会话，复用 queue-watch.pickNotifier）
//     · `running=true` 只排队、绝不打断（decide 的 `target-busy` 分支）
//     · 滞留 ≥ `cfg.escalateAfterMs`（默认 30 分钟）升级一次（decide 的 `escalate` 分支）
//     · 单日上限（`butler-autonomy-limits.json` 的 `maxAutoActionsPerDay`）+ 一轮并发上限（`maxActionsPerTick`）
//
// 【边界（三条，改本文件前必读）】
//   ① **判定口径一律复用** `lib/queue-watch.mjs`：pickReviewCards / isExecutionAlive / pickNotifier /
//      decide / nextInQueue / formatInjectText —— 本文件**不复制**任何候选判定逻辑（复制 = 第二套口径，
//      矩阵 R1 冻结面与本卡红线都明令禁止）。
//   ② 本文件只做「叫醒」这一件事：**不验收、不起卡、不改看板、不写 queue 台账**。
//      queue 台账（`~/.dsh/butler-queue-notify.json`）的唯一写者仍是 `butler-queue-tick.mjs`。
//      ⚠️ 接线前置（真接线进 tick 时必做）：注入成功后由 tick 把该卡 entry 的 `notifiedAt` 落台账，
//         否则下一轮会重复叫醒同一张卡（本动作自带的 24h 去重签名只能兜一层）。
//      升级提醒（桌宠 + alert）**也不由本动作代发** —— 那是 tick 通知通道的职责，两条通道同发 = 双重升级。
//
// 【接线现状 · 2026-09-17 卡「裸跑 L1 放行收尾」· 叫醒通道合并 C 口径】
//   `lib/queue-watch.mjs` 的 `runTick()` 在 **notify 档内**调本文件的
//   `runQueueWake({ dryRun:false, rows })` —— `rows` 是 tick 的 `planTick()` 结果（判定仍只有一份实现），
//   本动作只负责"限额判定 + runAction 闸门 + 逐卡注入"。由此成立三条：
//     ① **唯一注入执行体 = 本文件**（tick 不再自己调 `deps.inject`）；
//     ② 四门（L0 降档 / `p3AutoEnabled` / `modules['queue-wake']` / 档位 notify）任一关 → 零注入、零副作用；
//     ③ 台账回写按边界②落地：`status==='executed'` 由 tick 写 `notifiedAt/notifiedTo`（写者不变）。
//   ③ 所有执行走 `lib/autonomy-actions.mjs` 的 `runAction()` **唯一闸门**：
//      dry-run 永远可跑（只算不动，产出"将要做什么"）；`dryRun:false` 时四门任一关 → blocked 且零副作用。
//
// 【闸门（fail-safe 方向更严，不是更松）】
//   · 模块级：`checkModuleAllowed('queue-wake')` = L0 降档 × L1 `p3AutoEnabled` × L2 `modules['queue-wake']`
//   · 动作级：`runAction({kind:'queue-wake'})` 内置 p3-auto 总闸 + 24h 去重 + 单日上限 + token 预算门
//
// 【本卡红线（2026-09-13 批次 2）】**不接线到 tick**：`butler-queue-tick.mjs` 保持 observe 档，
//   本文件只交付"实现 + dry-run 路径 + 单测"；四门全关时不得发生任何真实叫醒（单测夹具强断言）。
import { dshHome } from './paths.mjs';
import { checkModuleAllowed } from './autonomy-modules.mjs';
import {
  runAction, checkDailyLimit, readActionsState, readLimits, localDay, sigKeyOf,
  appendQuotaDegrades,
} from './autonomy-actions.mjs';
import {
  DEFAULT_CONFIG, loadConfig, loadLedger, readBoard, readSessions, isExecutionAlive,
  pickNotifier, pickTarget, sessionIndex, resolveBinding, decide, nextInQueue, formatInjectText,
  // 【G3 · 候选 B 第 5/7 行】卡被打断 ⇒ 待重跑 的注入文案（唯一调用点 = 本文件 injectOne）
  formatInterruptedText,
  // 【N12 · 2026-10-10】叫醒存亡确认（补投）的注入文案（唯一调用点同样 = 本文件 injectOne）
  formatReceiptText,
  // 【V3功能面 · 失败卡通知档 · 2026-10-22】failed 卡的注入文案（唯一调用点同样 = 本文件 injectOne）
  formatFailedText,
} from './queue-watch.mjs';
import { loadBindings, resolveCardBinding, resolveLineOwner } from './queue-bindings.mjs';
import { notifySession } from './watch-notify.mjs';

export const QUEUE_WAKE_VERSION = '0.1.0';
/** 动作 kind（与 AUTO_ACTION_KINDS 的键同名；L2 模块 id 亦同名 —— 矩阵 §3 列口径要求"同名才能对齐开关"）。 */
export const WAKE_KIND = 'queue-wake';
/** 风险级（矩阵 §3 表：L1 = 无害可逆；只注入提醒文本，不改数据）。 */
export const WAKE_LEVEL = 'L1';
/** 计划条目判定值（预览里逐卡可见）。 */
export const WAKE_VERDICTS = ['wake', 'queue', 'escalate', 'skip'];

/** 仅在调用方未传 limits 时用的兜底值（与 lib/autonomy-actions.mjs 的 defaultLimits() 同口径）。 */
export const FALLBACK_MAX_PER_DAY = 5;
export const FALLBACK_MAX_PER_TICK = 2;

export const PREVIEW_MAX_ITEMS = 8;

/** 判定 reason → 人话（预览里逐卡可见；**只做翻译，不改判定**）。 */
export const NOTE_BY_REASON = {
  'target-busy': '目标会话在跑（running=true）→ 绝不打断，只排队',
  'execution-alive': '疑似假结算（卡的执行会话仍在 running）→ 不叫醒',
  'execution-resolved': '假结算标记已解除 → 本轮无事可做',
  'no-target': '没有可叫醒的目标（标题标【运行】的会话 = 0）',
  'ambiguous-target': '目标不唯一（标题标【运行】的会话不止 1 个）→ 宁可不发',
  observed: 'observe 语义下的"已见过"',
  waiting: '未达升级阈值',
  escalated: '已升级过（只升级一次）',
  'not-in-review': '卡已不在待验收',
  // 【G3 · 打断待重跑通道】reason → 人话（只做翻译，不改判定）
  'interrupt-target-idle': '卡被打断回待办 + 目标空闲 → 注入提醒',
  'interrupt-no-target': '卡被打断但无可投递目标（无绑定 / 无唯一【运行】会话）→ 落日报段（不静默）',
  'interrupt-ambiguous-target': '卡被打断但目标不唯一 → 落日报段（宁可不发）',
  'interrupt-target-busy': '目标会话在跑 → 只排队，下轮再试',
  'interrupt-expired': '打断已超 12h 新鲜度窗口 → 落日报段（不注入）',
  'interrupt-day-limit': '打断通知当日已达 ≤6 条上限 → 落日报段（不注入）',
  'interrupt-already-notified': '同一次打断（同一 executionId）已通知过 → 不重复',
  'interrupt-storm-summarized': '本轮打断 ≥3 张 → 已并入汇总条（逐卡明细进日报）',
  'interrupt-execution-alive': '末条 execution 标 interrupted、执行会话仍在跑 → 下轮再看',
  'interrupt-too-fresh': '打断刚发生（不足 1 个 tick）→ 下轮再判',
  'interrupt-observe-mode': '非 notify 档（observe/report/dry-run）→ 只登记不动作',
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ---------------------------------------------------------------- 只读采集（复用 queue-watch 判据）

/**
 * 只读采集待叫醒候选（**零副作用**：只发只读请求，不写任何文件）。
 * 判定一律走 `queue-watch` 的既有函数，本函数只负责"取数 + 拼装"。
 * @returns {Promise<{ok:boolean, error?:string, cfg:object, board:object|null, sessions:object|null,
 *                    cards:Array, notifier:object, fakeSettled:number}>}
 */
export async function scanQueue(opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.cfg ?? loadConfig({ home: opts.home, quiet: true })) };
  const [board, sessions] = await Promise.all([
    readBoard({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }),
    readSessions({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }),
  ]);
  if (!board.ok || !sessions.ok) {
    return {
      ok: false,
      error: `采集失败（board=${board.ok ? 'ok' : board.error} / sessions=${sessions.ok ? 'ok' : sessions.error}）→ 本轮不规划任何叫醒`,
      cfg, board, sessions, cards: [], notifier: { kind: 'none', count: 0, candidates: [] }, fakeSettled: 0,
    };
  }
  // 双判据第二半（假结算）：执行会话仍在跑 → 绝不叫醒（口径来自 queue-watch.isExecutionAlive，不另写）
  // 【C 口径 · 2026-09-17 叫醒通道合并】叫醒目标降级链与 tick 同源：卡级绑定 → 主线 owner → 标题唯一。
  //   ⚠️ 必须用与 `queue-watch.planTick()` **同一组** resolveBinding/pickTarget：
  //     相邻两个触发入口（tick notify 档 / tickd job `queue-wake`）若给同一张卡算出**不同 target**，
  //     就会算出不同 sigKey（`sigKeyOf(kind, taskId, target)`）→ 24h 去重互相挡不住
  //     ⇒ 同一张待验收卡被注入两次（本卡验收 1 的判据）。
  const bindings = opts.bindings ?? loadBindings({ home: opts.home });
  const sidx = sessionIndex(sessions.items);
  const cards = (board.review ?? []).map((c) => ({
    ...c,
    exec: isExecutionAlive(c, sessions.items, { enabled: cfg.checkExecutionAlive !== false }),
    binding: resolveBinding(resolveCardBinding(bindings, c.id), sidx, { source: 'binding' }),
    lineOwner: resolveBinding(resolveLineOwner(bindings, c.line), sidx, { source: 'line-owner' }),
  }));
  const notifier = pickNotifier(sessions.items, { targetPrefix: cfg.targetPrefix });
  return {
    ok: true, cfg, board, sessions, cards, notifier,
    bindings: { file: bindings.file, exists: bindings.exists === true, corrupt: bindings.corrupt === true, error: bindings.error ?? null },
    fakeSettled: cards.filter((c) => c.exec?.alive === true).length,
  };
}

// ---------------------------------------------------------------- 规划（纯函数）

/** 显示用的"进待验收多久了"（只用于预览文案；判定基线一律由 decide 自己算）。 */
function ageBaseMs(itemCtx) {
  const { entry, card, now } = itemCtx;
  const t = [entry?.settledAt, card?.settledAt, entry?.firstSeenAt, card?.firstSeenAt, now]
    .map((x) => Number(x ?? 0)).filter((n) => n > 0);
  return t.length ? Math.min(...t) : now;
}

/**
 * 逐项翻译成计划条目（**纯函数**）：verdict 映射与两层限额**只有这一份实现** ——
 * `planWake()`（动作自己判定）与 `planWakeFromTick()`（复用 tick 已算好的判定）共用同一套语义。
 * @param {Array<{card:object, entry:object|null, decision:object, target:string|null, targetRunning:boolean|null}>} rows
 * @param {{now:number, cfg:object, board:object|null, notifier:object, daily:object, maxPerTick:number}} ctx
 * @returns {{items:Array, planned:number}}
 */
/**
 * 【G3 · §3.10 规则 1】review 优先排序：同轮 `maxActionsPerTick` 名额先给既有 review 行，
 * 打断行 / 失败卡行排其后。纯加法：既有输入域（全 review 行）排序后**原序不变**
 * （Array#sort 自 ES2019 起规范保证稳定），只有 `interrupt-notify` / `failed-notify` 行被后移；
 * 被挤掉的打断行有 12h 新鲜度窗口兜底、失败卡行有 6h TTL 兜底，晚一轮（≤60s）不算漏。
 */
function sortInterruptLast(rows) {
  const rank = (r) => ((r?.decision?.action === 'interrupt-notify' || r?.decision?.action === 'failed-notify') ? 1 : 0);
  rows.sort((a, b) => rank(a) - rank(b));
  return rows;
}

function buildItems(rows, ctx) {
  const { now, cfg, board, notifier, daily, maxPerTick } = ctx;
  const items = [];
  let planned = 0;
  for (const row of rows) {
    const card = row.card;
    const entry = row.entry ?? null;
    const d = row.decision ?? {};
    const target = row.target ?? null;
    const item = {
      taskId: String(card.id),
      title: String(card.title ?? ''),
      seq: card.seq ?? null,
      line: card.line ?? null,
      decision: d.action,
      reason: d.reason,
      target,
      targetRunning: row.targetRunning ?? null,
      settledAt: Number(entry?.settledAt ?? card.settledAt ?? 0) || null,
      // 【2026-09-21 · 去重键带"本轮事件"】本轮「进待验收事件」的令牌：
      //   首选 `decision.patch.firstSeenAt` —— 它是 decide 本轮给出的**最终台账条目形态**
      //     （无条目 ⇒ newEntry 写 now；已有条目 ⇒ 保留旧值），所以"同事件稳定、新事件必变"；
      //   ⚠️ 不能用 `row.entry.firstSeenAt` 代替：卡刚重新进 review / 首次见到时 row.entry 是 null，
      //     那样令牌会退化成常量（'na'）⇒ 新一轮事件与上一轮撞成同一个键，修复失效（实测踩到）。
      //   再退 `entry.settledAt` → `card.settledAt` → 0（0 → 'na'，等价旧语义）。
      //   消费方 = `runQueueWake()` 的 24h 签名（见该处注释：治"补件再进待验收被上一轮签名静默挡住"）。
      eventKey: Number(d?.patch?.firstSeenAt ?? 0) || Number(entry?.firstSeenAt ?? 0)
        || Number(entry?.settledAt ?? card?.settledAt ?? 0) || 0,
      // 【G3 · R7 · 令牌类型错配】打断通道的事件令牌 = `executionId`（UUID 字符串），
      //   **不能灌既有 `eventKey`**：它是 `Number()` 数字语义 ⇒ UUID → NaN → `|| 0` ⇒ 签名段退化成常量 'na'
      //   ⇒ 同卡 24h 内第二次打断被静默挡（§1 目标 3 失效）。新键**只增不改**：既有 `eventKey` 一字不动。
      eventKeyRaw: String(d?.patch?.executionId ?? d?.patch?.receiptToken ?? '') || null,
      // 【G3】打断事实（卡名/时刻/原因）——只在本轮内存里传给注入文案，**不落 queue 台账**
      //   （§3.9 载体归属：result/endedAt/error 的真源仍是看板 executions[]）。
      interrupted: d?.detail?.interrupted ?? null,
      // 【V3功能面 · 失败卡通知档】失败事实（时刻/错误首行/产物线索）——同样只在本轮内存里传给注入文案
      failed: d?.detail?.failed ?? null,
      // 【N12 · 2026-10-10】叫醒存亡确认的证据（仅补投项有）——只在本轮内存里传给注入文案，不落台账
      receipt: d?.detail?.receipt ?? null,
      ageMin: Math.max(0, Math.round((now - ageBaseMs({ entry, card, now })) / 60_000)),
      next: nextInQueue(board, card),
      execAlive: card.exec?.alive === true,
      verdict: 'skip',
      inject: false,
      // 【施工卡 ⑥-1】额度降级标记（`null` / `'quota-day'` / `'quota-tick'`）——**只加字段、不改判定**：
      //   本函数的 reason 是 decide 的原判定（不是额度原因），故降级**必须用独立字段**表达，
      //   不能被 note 文案猜（台账抽取认这个字段，见 lib/autonomy-actions.mjs extractQuotaDegrades）。
      quotaGate: null,
      note: '',
    };

    // 【G3 · v4·R10】动作层**唯一**注入判定：打断项必须一并放行（只扩这一行；下方 `planned >= maxPerTick`
    //   / `escalate` / `skip` / `else` 四处**一字不动**）。`interrupt-report` 刻意**不扩** ⇒ 落 else（verdict=skip、不注入），
    //   它的可见性由 tick 侧 stats.interrupted + 日报段承担。
    // 【V3功能面 · 失败卡通知档】`failed-notify` 同款放行（`failed-report` / `failed-skip` 不扩 ⇒ 落 else，只算不发）。
    if (d.action === 'notify' || d.action === 'interrupt-notify' || d.action === 'failed-notify') {
      if (daily.reached) {
        item.verdict = 'queue';
        // 【施工卡 ⑥-3】gate 细分由唯一判定函数给出（`quota-day` / `quota-kind` / `quota-reserve` / `quota-pool`）；
        //   本项 `reason` 保持老值域，池维度的原因落在 note（老文案前缀「单日上限已达」原样保留）。
        item.quotaGate = daily.gate ?? 'quota-day';   // 【施工卡 ⑥-1】额度降级落点①（日额度）
        item.note = `单日上限已达：${daily.reason} → 只排队，不注入`;
      } else if (planned >= maxPerTick) {
        item.verdict = 'queue';
        item.quotaGate = 'quota-tick';      // 【施工卡 ⑥-1】额度降级落点②（单轮并发上限）
        item.note = `本轮并发上限（maxActionsPerTick=${maxPerTick}）→ 本轮排队，下轮再叫`;
      } else {
        item.verdict = 'wake';
        item.inject = true;
        planned += 1;
      }
    } else if (d.action === 'escalate') {
      item.verdict = 'escalate';
      item.note = `滞留 ≥ ${Math.round(num(cfg.escalateAfterMs, DEFAULT_CONFIG.escalateAfterMs) / 60_000)} 分钟 → 升级提醒一次；`
        + '升级文案由 tick 通知通道代发（本动作不代发，避免双重升级）';
    } else if (d.action === 'skip') {
      item.verdict = 'skip';
      item.note = NOTE_BY_REASON[d.reason] ?? d.reason;
    } else {
      // decide 的其余判定（report / cleanup …）都不属于"叫醒"职责：只标记，不执行
      item.verdict = 'skip';
      const why = NOTE_BY_REASON[d.reason];
      item.note = why
        ? `${why}（判定=${d.action}）`
        : `判定=${d.action}/${d.reason}（不在本动作职责内：本动作只叫醒）`;
    }
    items.push(item);
  }
  return { items, planned };
}

/** 计划汇总（两个计划入口共用同一形状）。 */
function assemblePlan({ now, cfg, limits, daily, notifier, items }) {
  const byVerdict = (v) => items.filter((i) => i.verdict === v).length;
  return {
    kind: WAKE_KIND,
    now,
    day: localDay(now),
    mode: cfg.mode,
    // 放行判据（矩阵 §3 该行）：真接线前须先在 notify 档观测一段时间 → 此处如实回报档位，不做隐式放行
    stageReady: cfg.mode === 'notify',
    quota: daily,
    limits: {
      maxAutoActionsPerDay: num(limits.maxAutoActionsPerDay, FALLBACK_MAX_PER_DAY),
      maxActionsPerTick: num(limits.maxActionsPerTick, FALLBACK_MAX_PER_TICK),
    },
    target: notifier.kind === 'unique'
      ? { kind: 'unique', sessionId: notifier.sessionId ?? null, running: notifier.running === true, title: notifier.title ?? null }
      : { kind: notifier.kind ?? 'none', count: notifier.count ?? 0 },
    notifierKind: notifier.kind ?? 'none',
    summary: {
      cards: items.length,
      wake: byVerdict('wake'),
      queue: byVerdict('queue'),
      escalate: byVerdict('escalate'),
      skip: byVerdict('skip'),
      execAlive: items.filter((i) => i.execAlive).length,
    },
    items,
    injectables: items.filter((i) => i.inject).map((i) => i.taskId),
  };
}

/**
 * 规划一轮（**纯函数，零副作用**）：给定候选/台账/目标/限额 → 逐卡计划（**动作自己判定**的入口）。
 *
 * 判定全部来自 `queue-watch.decide({mode:'notify'})`（= 本动作等价于 tick 的 notify 档"叫醒"环节）：
 *   decide → notify   : 唯一目标且空闲 → 本动作可叫醒
 *   decide → skip     : target-busy（目标在跑，排队）/ execution-alive（假结算）/ no-target / ambiguous-target
 *   decide → escalate : 滞留 ≥ 阈值（≥30min）升级一次（升级由 tick 通知通道代发，本动作只标记）
 *
 * 【C 口径 · 2026-09-17 叫醒通道合并】目标判定走 `pickTarget()` 降级链
 *   （卡级绑定 → 主线 owner → 标题唯一）—— **与 tick 的 `planTick()` 同源**：
 *   两个触发入口（tick notify 档 / tickd job `queue-wake`）对同一张卡算出**同一 target** ⇒ 同一 sigKey
 *   ⇒ 24h 签名去重能互相兜住（否则同一张待验收卡会被注入两次）。
 *
 * 本动作在 decide 之上**只加两层限额**（都取自既有护栏，不新增口径）：
 *   · 单日上限 `maxAutoActionsPerDay`（用 autonomy-actions.checkDailyLimit 同一函数判，同源）；
 *   · 一轮并发上限 `maxActionsPerTick`（沿用既有护栏字段语义）。
 * @returns {{kind:string, now:number, day:string, mode:string, stageReady:boolean,
 *            quota:object, limits:object, summary:object, target:object, notifierKind:string,
 *            items:Array, injectables:Array<string>}}
 */
export function planWake(input = {}) {
  const now = num(input.now, Date.now());
  const cfg = { ...DEFAULT_CONFIG, ...(input.cfg ?? {}) };
  const limits = input.limits ?? {};
  const state = input.state ?? {};
  const cards = Array.isArray(input.cards) ? input.cards : [];
  const entries = (input.entries && typeof input.entries === 'object') ? input.entries : {};
  const notifier = input.notifier ?? { kind: 'none', count: 0, candidates: [] };
  const board = input.board ?? null;
  // 【施工卡 ⑥-3】分池：判自己的 kind 池（保底预留直接对症 09-17 08:18「叫醒被挤掉」）+ 生态总闸
  const daily = checkDailyLimit(state, localDay(now), num(limits.maxAutoActionsPerDay, FALLBACK_MAX_PER_DAY), { kind: WAKE_KIND, pools: limits.pools });

  const rows = cards.map((card) => {
    const entry = entries[card.id] ?? null;
    const binding = card.binding ?? null;
    const lineOwner = card.lineOwner ?? null;
    // 判定函数与 tick 同源（decide）；绑定链前两级由 scanQueue 解析后挂在 card 上
    const d = decide({ entry, card, notifier, binding, lineOwner, now, mode: 'notify', cfg, exec: card.exec ?? null });
    const t = pickTarget({ binding, lineOwner, notifier });
    return {
      card, entry, decision: d,
      target: t.kind === 'unique' ? (t.sessionId ?? null) : null,
      targetRunning: t.kind === 'unique' ? t.running === true : null,
    };
  });
  sortInterruptLast(rows);   // 【G3 · §3.10 规则 1】review 优先
  const { items } = buildItems(rows, {
    now, cfg, board, notifier, daily,
    maxPerTick: num(limits.maxActionsPerTick, FALLBACK_MAX_PER_TICK),
  });
  return assemblePlan({ now, cfg, limits, daily, notifier, items });
}

/**
 * 【C 口径 · 2026-09-17 叫醒通道合并】把 **tick 已算好的判定**翻译成动作计划。
 *
 * 与 `planWake()` 的唯一差别 = **判定来源**：本函数**不调 decide**（判定由 `queue-watch.planTick()`
 * 在 tick 里做完，含叫醒目标降级链与事件信箱给的 settledAt），只做 verdict 映射 + 两层限额。
 * 这样 tick notify 档与动作层的判定口径就是同一份，不存在第二套口径。
 *
 * @param {{rows:Array, board?:object, notifier?:object, now?:number, cfg?:object, limits?:object, state?:object}} input
 *   rows = `queue-watch.planTick()` 的逐项结果 `{card, entry, decision}`（`card` 为 null 的清理项跳过）
 * @returns 同 `planWake()`
 */
export function planWakeFromTick(input = {}) {
  const now = num(input.now, Date.now());
  const cfg = { ...DEFAULT_CONFIG, ...(input.cfg ?? {}) };
  const limits = input.limits ?? {};
  const state = input.state ?? {};
  const board = input.board ?? null;
  const notifier = input.notifier ?? { kind: 'none', count: 0, candidates: [] };
  // 【施工卡 ⑥-3】分池：判自己的 kind 池（保底预留直接对症 09-17 08:18「叫醒被挤掉」）+ 生态总闸
  const daily = checkDailyLimit(state, localDay(now), num(limits.maxAutoActionsPerDay, FALLBACK_MAX_PER_DAY), { kind: WAKE_KIND, pools: limits.pools });

  const rows = (Array.isArray(input.rows) ? input.rows : [])
    .filter((r) => r && r.card && r.decision)
    .map((r) => {
      const d = r.decision;
      const tg = d.detail?.notifier ?? null;                 // per-card 目标（tick 的降级链结果）
      return {
        card: r.card,
        entry: r.entry ?? null,
        decision: d,
        target: d.patch?.targetSessionId ?? tg?.sessionId ?? null,
        targetRunning: tg ? tg.running === true : null,
      };
    });
  sortInterruptLast(rows);   // 【G3 · §3.10 规则 1】review 优先（tick 通道）
  const { items } = buildItems(rows, {
    now, cfg, board, notifier, daily,
    maxPerTick: num(limits.maxActionsPerTick, FALLBACK_MAX_PER_TICK),
  });
  return assemblePlan({ now, cfg, limits, daily, notifier, items });
}

/** 精简单卡计划（dry-run 记账 / 执行记账用；**必须可 JSON 化**，不带 board 等大对象）。 */
function slimItem(item) {
  return {
    taskId: item.taskId, title: item.title, seq: item.seq,
    verdict: item.verdict, decision: item.decision, reason: item.reason,
    target: item.target, targetRunning: item.targetRunning,
    ageMin: item.ageMin, settledAt: item.settledAt,
    // 去重键的事件令牌（诊断用：看得见"本轮是哪一次进待验收"）——只加字段，不改判定
    eventKey: item.eventKey ?? null,
    // 【G3】字符串令牌（打断通道 = executionId）——诊断用：看得见"本轮令牌是哪一次打断"
    eventKeyRaw: item.eventKeyRaw ?? null,
    inject: item.inject, note: item.note,
  };
}

/**
 * 预览形状（dry-run 的"将要做什么"）。
 * @returns {{action:string, at:number, day:string, stage:string, stageReady:boolean,
 *            quota:object, target:object, summary:object, items:Array, truncated:number, note:string}}
 */
export function wakePreview(plan, opts = {}) {
  const maxItems = opts.maxItems ?? PREVIEW_MAX_ITEMS;
  const items = Array.isArray(plan?.items) ? plan.items : [];
  return {
    action: WAKE_KIND,
    at: opts.now ?? plan?.now ?? Date.now(),
    day: plan?.day ?? null,
    stage: plan?.mode ?? null,
    stageReady: plan?.stageReady === true,
    target: plan?.target ?? null,
    quota: plan?.quota ? { used: plan.quota.used, max: plan.quota.max, reached: plan.quota.reached } : null,
    summary: plan?.summary ?? null,
    items: items.slice(0, maxItems).map(slimItem),
    truncated: Math.max(0, items.length - maxItems),
    note: 'dry-run：只算不动 —— 以下"inject=true 的条目"就是若放行会被叫醒的目标；未产生任何真实注入',
  };
}

// ---------------------------------------------------------------- 动作入口（唯一闸门）

/**
 * 跑一轮「自动叫醒」动作。
 *
 * 三条路径（语义与 runAction 一致）：
 *   dryRun:true        → 永远可跑：只算不动，写一条 dry-run 影子记账（供影子视图/日报），**零注入**
 *   四门任一关          → status='blocked'，**零副作用**（不写记账、不占额度、不注入）
 *   四门全开 + 有待叫醒 → 逐卡执行（每卡一次 runAction：24h 去重 + 每日额度 + 预算门）
 *
 * @param {{
 *   home?:string, now?:number, dryRun?:boolean, baseUrl?:string, cfg?:object, limits?:object,
 *   state?:object, ledger?:object, scan?:object, plan?:object, rows?:Array, autonomy?:object,
 *   fetchImpl?:Function, deps?:{inject?:Function}, injectTimeoutMs?:number, executeTimeoutMs?:number
 * }} spec
 */
export async function runQueueWake(spec = {}, opts = {}) {
  const now = num(opts.now ?? spec.now, Date.now());
  const home = opts.home ?? spec.home ?? dshHome();
  const dryRun = spec.dryRun === true || opts.dryRun === true;
  const cfg = { ...DEFAULT_CONFIG, ...(spec.cfg ?? loadConfig({ home, quiet: true })) };
  const limits = spec.limits ?? readLimits({ home });
  const ledger = spec.ledger ?? loadLedger({ home });
  const state = spec.state ?? readActionsState({ home });

  const out = {
    kind: WAKE_KIND, version: QUEUE_WAKE_VERSION, ok: true, dryRun, status: null, reason: null,
    home, now, day: localDay(now), moduleGate: null, plan: null, action: null,
    quotaLedger: null,   // 【施工卡 ⑥-1】额度降级台账写入结果（{ok,written,skipped,error}）
    results: [], injected: 0, failed: 0, blocked: 0, noop: 0,
  };

  // 1) 只读采集（失败 → 本轮不规划，不写任何东西）
  const scan = spec.scan ?? await scanQueue({ home, cfg, baseUrl: spec.baseUrl, fetchImpl: spec.fetchImpl });
  if (!scan.ok) return { ...out, ok: false, status: 'collect-failed', reason: scan.error };

  // 2) 规划（纯函数，零副作用）
  //    · spec.rows（**C 口径 · 2026-09-17**：调用方 = tick，已用 `planTick()` 判完）→ 只翻译、不再判定；
  //    · spec.plan（单测/夹具直接给计划）；
  //    · 都没有 → 本动作自己判定（`planWake()`，同样复用 decide + pickTarget 降级链，无第二套口径）。
  const plan = spec.plan ?? (Array.isArray(spec.rows)
    ? planWakeFromTick({ rows: spec.rows, board: scan.board, notifier: scan.notifier, now, cfg, limits, state })
    : planWake({ cards: scan.cards, entries: ledger.entries, notifier: scan.notifier, board: scan.board, now, cfg, limits, state }));
  out.plan = plan;

  // 3) 模块级闸门（L0 × L1 × L2）；dry-run **不受闸门限制**（只算不动 —— 与 runAction 同一语义）
  const moduleGate = checkModuleAllowed(WAKE_KIND, { home, autonomy: spec.autonomy });
  out.moduleGate = moduleGate;
  const wakeItems = plan.items.filter((i) => i.inject);

  if (!dryRun && !moduleGate.allowed) {
    return {
      ...out, ok: true, status: 'blocked',
      reason: `L2 模块闸门关闭：${moduleGate.reason}`,
      blocked: plan.items.length,
    };
  }

  // 4b-2) 【施工卡 ⑥-1 · ⑥ 包 §7.1③】额度降级台账：写在**共用执行函数内**（本函数是 queue-wake 的
  //   唯一执行收口，覆盖 `planWake` / `planWakeFromTick` 两条 plan 入口 —— 挂某个入口必漏）。
  //   位置 = 模块门放行之后（⑤ 包 §4.4-X2「先闸门后额度」：被闸门拦下的根本没轮到额度判定 ⇒ 记它 = 白记）；
  //   dry-run 不写（只算不动，不占额度也不记降级）。写失败**不阻断**降级（内部 alert(warn)）。
  out.quotaLedger = dryRun ? null : appendQuotaDegrades(plan, { home, now });

  // 4a) dry-run：一条轮级影子记账（明细在 detail.items 里），零注入
  if (dryRun) {
    const preview = wakePreview(plan, { now });
    const r = await runAction({
      kind: WAKE_KIND, level: WAKE_LEVEL, dryRun: true, home, now,
      detail: preview, preview: () => preview,
    }, { home, now });
    out.action = r;
    out.status = r.status;
    out.reason = r.reason;
    out.preview = preview;
    return out;
  }

  // 4b) 无待叫醒项 → noop（不写签名、不占额度、零副作用）
  if (!wakeItems.length) {
    return { ...out, status: 'noop', reason: `本轮无待叫醒项（${plan.summary.cards} 张待验收卡：wake 0 / queue ${plan.summary.queue} / escalate ${plan.summary.escalate} / skip ${plan.summary.skip}）` };
  }

  // 4c) 逐卡执行（每卡一次 runAction：独立 sigKey + 独立占用每日额度）
  const inject = spec.deps?.inject ?? ((sid, text, o) => notifySession(sid, text, { baseUrl: spec.baseUrl, ...o }));
  for (const item of wakeItems) {
    const r = await runAction({
      kind: WAKE_KIND, level: WAKE_LEVEL, dryRun: false, home, now,
      consumesQuota: true,
      // 【2026-09-21 · 24h 去重键带"本轮事件"】—— 治「补件再进待验收被上一轮签名静默挡住」。
      //   · 旧键 = `kind|卡|目标`：同一张卡在 24h 内**第二次**进待验收（reject 后补件、重跑）时，
      //     业务层判"该通知"（卡离开 review 时台账条目已被 cleanup、notifiedAt 归零 ⇒ decide 判 notify），
      //     动作层却按旧键判"24h 内已处理" ⇒ `status=noop` 被静默挡掉；且签名 24h 内一直有效、
      //     **没有任何重试窗口** ⇒ 卡一路"判 notify → 被 noop 挡 → 不写 notifiedAt"空转到次日。
      //     实测（2026-09-20/21）：卡 a3ef6816 被挡 323 次、f694f5a0 被挡 264 次（每 5 分钟一轮），
      //     S2c 卡 01:47 补件再进待验收 → 到 08:16 才靠别的路径升档，主人干等 6.5 小时。
      //   · 新键 = `kind|卡|目标#事件令牌`：语义变成"**这一次**进待验收已经通知过该目标"——
      //     同一事件内重复注入仍被挡（护栏不弱化），新一轮事件是新键 ⇒ 立即放行。
      // 【G3 · R7】令牌优先级：新字符串键 `eventKeyRaw`（打断通道 = executionId）→ 回落既有数字键 `eventKey`
      //   ⇒ review 行（`eventKeyRaw` 为 null）的签名**逐字不变**（既有输入域零变化，纯加法）。
      sigKey: sigKeyOf(WAKE_KIND, item.taskId, `${item.target ?? 'no-target'}#${item.eventKeyRaw || item.eventKey || 'na'}`),
      detail: slimItem(item),
      revertHint: '本动作只注入提醒文本：不改看板、不验收、不起卡、不写 queue 台账 → 误叫醒忽略即可，无数据变更',
      execute: async () => injectOne(item, { inject, cfg, ledger, now, timeoutMs: spec.injectTimeoutMs }),
    }, { home, now, executeTimeoutMs: spec.executeTimeoutMs });
    // `error`：注入失败的**原始错误**（runAction → execute → inject 的返回），
    //   调用方（tick）要拿它写台账 `lastInjectError`（诊断用，绝不吞掉根因）。
    out.results.push({
      taskId: item.taskId, seq: item.seq, target: item.target,
      status: r.status, reason: r.reason, error: r.result?.error ?? null,
      ok: r.status === 'executed',
    });
    if (r.status === 'executed') out.injected += 1;
    else if (r.status === 'failed') { out.failed += 1; out.ok = false; }
    else if (r.status === 'noop') out.noop += 1;      // 去重窗口内跳过 / 每日上限（runAction 的护栏）
    else out.blocked += 1;                            // 闸门关闭
  }
  out.action = out.results.length ? { kind: WAKE_KIND, status: out.failed ? 'failed' : (out.injected ? 'executed' : 'blocked') } : null;
  out.status = out.failed
    ? 'failed'
    : (out.injected ? 'executed' : ((out.noop > 0 && out.blocked === 0) ? 'noop' : 'blocked'));
  out.reason = out.failed
    ? `有 ${out.failed} 张叫醒失败（下轮重试）`
    : (out.injected
      ? `已叫醒 ${out.injected} 张`
      : ((out.noop > 0 && out.blocked === 0) ? `全部跳过（去重窗口 / 已达上限）：${out.noop} 张` : `全部被闸门挡住：${out.blocked} 张`));
  return out;
}

/** 单卡注入（execute 体；只在闸门放行后被 runAction 调用）。 */
async function injectOne(item, ctx) {
  const { inject, cfg, ledger, now, timeoutMs } = ctx;
  const card = { id: item.taskId, title: item.title, seq: item.seq, line: item.line, settledAt: item.settledAt };
  const entry = ledger?.entries?.[item.taskId] ?? null;
  // 【G3 · 候选 B 第 7 行】按条目类型选文案：打断项走 `formatInterruptedText`（注入文案的唯一调用点在这里）
  // 【N12 · 2026-10-10】补投项走 `formatReceiptText`（说清"上一次叫醒被打断吞了，本条是补发"）
  // 【V3功能面 · 失败卡通知档】failed 项走 `formatFailedText`（说清"哪张卡 · 何时挂 · 错误首行 · 产物缺口 · 可重跑"）
  const text = item.decision === 'interrupt-notify'
    ? formatInterruptedText({ card, interrupted: item.interrupted, entry, now, cfg })
    : item.decision === 'failed-notify'
      ? formatFailedText({ card, failed: item.failed ?? null, now, cfg })
      // ⚠️ 补投项的 `decision` 仍是 `'notify'`（走同一条注入通道），区分靠 `reason`（buildItems 原样带过来）
      : item.reason === 'receipt-retry'
        ? formatReceiptText({ card, next: item.next, entry, now, cfg, receipt: item.receipt ?? null })
        : formatInjectText({ card, next: item.next, entry, now, cfg });
  const r = await inject(item.target, text, { timeoutMs: timeoutMs ?? 10_000 });
  const ok = r?.ok === true;
  return {
    kind: WAKE_KIND, ok, injected: ok ? 1 : 0, failed: ok ? 0 : 1,
    taskId: item.taskId, seq: item.seq, target: item.target,
    error: ok ? null : (r?.error ?? 'inject-failed'),
    note: '注入成功与否由 tick 落 queue 台账（本动作不写台账）',
  };
}

/** 一轮摘要（CLI / 报表用；纯只读）。 */
export function summarizeWake(result) {
  const p = result?.plan ?? null;
  const s = p?.summary ?? { cards: 0, wake: 0, queue: 0, escalate: 0, skip: 0, execAlive: 0 };
  return {
    kind: WAKE_KIND, dryRun: result?.dryRun === true, status: result?.status ?? null, reason: result?.reason ?? null,
    stage: p?.mode ?? null, stageReady: p?.stageReady === true,
    cards: s.cards, wake: s.wake, queue: s.queue, escalate: s.escalate, skip: s.skip, execAlive: s.execAlive,
    target: p?.target ?? null, quota: p?.quota ?? null,
    injected: result?.injected ?? 0, failed: result?.failed ?? 0, blocked: result?.blocked ?? 0,
    noop: result?.noop ?? 0,
    moduleGate: result?.moduleGate?.reason ?? null,
  };
}
