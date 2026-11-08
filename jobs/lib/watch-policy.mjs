// dsh-butler / lib/watch-policy.mjs —— P2 告警策略状态机（纯函数：冷却 / 上限 / 免打扰 / ack / 升级）
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §4 P2（行 484-543）
//   · 只报状态变化（每事件类型记住「上次状态值」）        → 冷却窗口同类 4h 不重复推
//   · 每日上限 10 条（超了只落报告）                      → 免打扰 23:00-07:00 只落报告
//   · 可延迟维度：安全类/数据丢失类穿透免打扰 → 落报告 + 置顶次日开机首句 + 面板红标（不推桌宠/会话）
//   · ack：每条推送带 ackToken；未 ack 且持续 >4h → 升级（红标 + 下次开机第一句）
//
// 本模块**只做状态变换，不写盘**（写盘走 butler-store.updateJson，由 tick 调用）。
// 所有时间参数可由 opts 覆盖，单测用固定 now 驱动。

import { inQuietHours, DELIVER, LEVEL } from './watch-events.mjs';

export const WATCH_POLICY_VERSION = '0.1.0';
export const WATCH_STATE_SCHEMA = 1;

export const DEFAULT_WATCH_POLICY = {
  /** 同类事件冷却窗口（4h）。 */
  cooldownMs: 4 * 3_600_000,
  /** 全局每日推送上限。 */
  dailyCap: 10,
  /** 免打扰时段（本地时间）。 */
  quietHours: { startHour: 23, endHour: 7 },
  /** 未 ack 且持续超过该时长 → 升级。 */
  ackEscalateMs: 4 * 3_600_000,
  /** 单事件最多升级几次（之后只落报告，防刷屏）。 */
  maxEscalations: 3,
  /** 维护窗口/守护鱼异常等根因条件（由 tick 注入，见 watch-events 的抑制表）。 */
  suppression: { maintenanceActive: false, diskFull: false, networkDown: false },
};

/** 空状态（schemaVersion 1；与 lib/state-files.mjs 登记一致）。 */
export function emptyWatchState(now = Date.now()) {
  return {
    schemaVersion: WATCH_STATE_SCHEMA,
    updatedAt: new Date(now).toISOString(),
    lastTickAt: null,
    lastHeavyAt: null,
    tickCount: 0,
    events: {},
    daily: { day: dayKey(now), pushed: 0, reportOnly: 0, items: [] },
    deferred: [],
    lastTick: null,
  };
}

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function makeAckToken(seed = Math.random) {
  return Math.floor(seed() * 0xffffff).toString(16).padStart(6, '0');
}

/** 集合型 value 的「新增项」（worseWhen='increase' 用）。 */
function newItems(prev, cur) {
  const p = new Set(String(prev ?? '').split('|').filter(Boolean));
  return String(cur ?? '').split('|').filter(Boolean).filter((x) => !p.has(x));
}

/**
 * 应用策略，得到本轮该推什么 / 该落报告什么。
 * @param {Array} events judgeAll 输出（已过抑制表）
 * @param {object} state 当前 butler-watch-state.json 内容
 * @param {{now?:number, policy?:object, maintenance?:object|null}} [opts]
 * @returns {{state:object, push:Array, deferred:Array, reportOnly:Array, escalated:Array,
 *            skipped:Array, cooling:Array, capped:Array, dayReset:boolean}}
 */
export function applyPolicy(events, state, opts = {}) {
  const now = opts.now ?? Date.now();
  const policy = { ...DEFAULT_WATCH_POLICY, ...(opts.policy ?? {}) };
  const base = state && typeof state === 'object' ? state : emptyWatchState(now);
  const next = {
    ...base,
    schemaVersion: WATCH_STATE_SCHEMA,
    events: { ...(base.events ?? {}) },
    daily: { ...(base.daily ?? { pushed: 0, reportOnly: 0, items: [] }) },
    deferred: [...(base.deferred ?? [])],
  };
  const today = dayKey(now);
  let dayReset = false;
  if (next.daily.day !== today) {
    next.daily = { day: today, pushed: 0, reportOnly: 0, items: [] };
    dayReset = true;
  }

  const quiet = inQuietHours(now, policy.quietHours);
  const push = [];
  const deferred = [];
  const reportOnly = [];
  const escalated = [];
  const skipped = [];
  const cooling = [];
  const capped = [];

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || !ev.id) continue;
    const prev = next.events[ev.id] ?? null;
    const sameValue = prev !== null && prev.lastValue === ev.value;
    const worsened = ev.worseWhen === 'increase' ? newItems(prev?.lastValue, ev.value).length > 0 : !sameValue;
    const firstSeen = prev === null;
    const lastNotifyAt = Number(prev?.lastNotifyAt ?? 0);
    const acked = Number(prev?.ackedAt ?? 0) >= lastNotifyAt && lastNotifyAt > 0;

    // 2) ack 升级（同事件未 ack 且持续 > ackEscalateMs）——独立于「是否重复推送」，
    //    否则「值没变」的持续异常永远升不了级（2026-09-09 单测实测）。
    //    升级自身也有冷却（escalatedAt），否则每次 tick 都会再升级一次。
    const lastEscalatedAt = Number(prev?.escalatedAt ?? 0);
    let upgraded = false;
    if (lastNotifyAt > 0 && !acked && now - lastNotifyAt >= policy.ackEscalateMs
      && now - lastEscalatedAt >= policy.ackEscalateMs
      && Number(prev?.escalations ?? 0) < policy.maxEscalations) {
      escalated.push({
        id: ev.id, title: ev.title, level: ev.level, deliverable: ev.deliverable,
        detail: ev.detail, ackToken: prev?.ackToken ?? makeAckToken(),
        reason: `未确认超过 ${Math.round(policy.ackEscalateMs / 3_600_000)}h`,
        since: lastNotifyAt,
      });
      upgraded = true;
    }
    const markUpgrade = (base) => (upgraded
      ? { ...base, escalations: Number(prev?.escalations ?? 0) + 1, escalatedAt: now }
      : base);

    // 1) 只报状态变化：值没变（或 increase 型没有新增项）→ 不推
    if (!firstSeen && !worsened) {
      next.events[ev.id] = markUpgrade({ ...prev, lastSeenAt: now, lastValue: ev.value });
      skipped.push({ id: ev.id, reason: 'unchanged' });
      continue;
    }

    // 3) 冷却窗口（同类 4h 不重复推）
    if (lastNotifyAt > 0 && now - lastNotifyAt < policy.cooldownMs) {
      next.events[ev.id] = markUpgrade({ ...prev, lastValue: ev.value, lastSeenAt: now });
      cooling.push({ id: ev.id, remainMs: policy.cooldownMs - (now - lastNotifyAt) });
      continue;
    }

    const isRed = ev.level === LEVEL.RED;
    const isDeferrable = ev.deliverable === DELIVER.DEFERRABLE;
    const record = {
      id: ev.id, title: ev.title, level: ev.level, deliverable: ev.deliverable,
      category: ev.category ?? null, detail: ev.detail, evidence: ev.evidence ?? null,
      value: ev.value, at: now,
    };

    // 4) 🟡 一律只进报告（主人 2026-09-09 拍板：🔴 推 / 🟡 进日报）
    if (!isRed) {
      reportOnly.push(record);
      next.events[ev.id] = markUpgrade({ ...prev, lastValue: ev.value, lastSeenAt: now, lastReportAt: now, ackToken: prev?.ackToken ?? null });
      next.daily.reportOnly += 1;
      next.daily.items.push({ id: ev.id, at: now, level: ev.level, kind: 'report' });
      continue;
    }

    // 5) 免打扰：不推桌宠/会话；可延迟类（安全/数据丢失）进「次日开机首句」队列
    if (quiet) {
      if (isDeferrable) {
        deferred.push({ ...record, reason: 'quiet-hours-deferrable' });
        next.deferred.push({ id: ev.id, title: ev.title, level: ev.level, detail: ev.detail, at: now, ackToken: prev?.ackToken ?? makeAckToken(), reason: 'quiet-hours-deferrable' });
      } else {
        reportOnly.push({ ...record, reason: 'quiet-hours' });
      }
      next.events[ev.id] = markUpgrade({ ...prev, lastValue: ev.value, lastSeenAt: now, lastReportAt: now });
      next.daily.items.push({ id: ev.id, at: now, level: ev.level, kind: 'report' });
      continue;
    }

    // 6) 每日上限（超了只落报告，不推送）
    if (next.daily.pushed >= policy.dailyCap) {
      capped.push(record);
      reportOnly.push({ ...record, reason: 'daily-cap' });
      next.events[ev.id] = markUpgrade({ ...prev, lastValue: ev.value, lastSeenAt: now, lastReportAt: now });
      next.daily.items.push({ id: ev.id, at: now, level: ev.level, kind: 'report' });
      continue;
    }

    // 7) 真推送：新 ackToken（每次推送一个新令牌，便于「知道了」精确对应）
    const ackToken = makeAckToken();
    push.push({ ...record, ackToken });
    next.daily.pushed += 1;
    next.daily.items.push({ id: ev.id, at: now, level: ev.level, kind: 'push', ackToken });
    next.events[ev.id] = {
      ...prev,
      lastValue: ev.value,
      // 2026-09-14：记录里补写「人话三件套」。此前 events 记录只存机器值（lastValue/时间/token），
      //   title/level/detail 只写在 push 与 deferred 里 ⇒ 面板读记录渲染「未 ack 列表」时
      //   标题恒空、级别恒 null（实测：首页两条只有英文 id + 灰点的空白行，主人看不懂）。
      //   这里补写后，新推送的记录自带中文标题 / 级别 / 详情。
      title: ev.title ?? prev?.title ?? null,
      level: ev.level ?? prev?.level ?? null,
      detail: ev.detail ?? prev?.detail ?? null,
      lastSeenAt: now,
      lastNotifyAt: now,
      notifyCount: Number(prev?.notifyCount ?? 0) + 1,
      ackToken,
      ackedAt: null,
      escalations: 0,
    };
  }

  // 未在事件列表中的历史事件：保留记录（供 ack / 升级判定），但清理过老的
  const RETENTION_MS = 90 * 86_400_000;
  for (const [id, rec] of Object.entries(next.events)) {
    const seen = Number(rec?.lastSeenAt ?? rec?.lastNotifyAt ?? 0);
    if (seen > 0 && now - seen > RETENTION_MS) delete next.events[id];
  }

  // 次日开机首句队列：只保留最近 7 天
  next.deferred = next.deferred.filter((d) => now - Number(d.at ?? 0) <= 7 * 86_400_000);
  for (const e of escalated) {
    next.deferred.push({ id: e.id, title: e.title, level: e.level, detail: e.detail, at: now, ackToken: e.ackToken, reason: `escalated:${e.reason}` });
  }

  next.lastTickAt = new Date(now).toISOString();
  next.updatedAt = new Date(now).toISOString();
  next.tickCount = Number(base.tickCount ?? 0) + 1;
  next.lastTick = {
    at: now, quiet,
    fired: (Array.isArray(events) ? events : []).map((e) => e.id),
    pushed: push.map((e) => e.id),
    reportOnly: reportOnly.map((e) => e.id),
    deferred: deferred.map((e) => e.id),
    escalated: escalated.map((e) => e.id),
    suppressed: [],
  };
  return { state: next, push, deferred, reportOnly, escalated, skipped, cooling, capped, dayReset, quiet };
}

/**
 * 「知道了」：按 ackToken / 事件 id / 重投清单确认。返回新状态（纯函数、不写盘）。
 *
 * 【2026-11-06 · 告警 ack 链自锁修复（卡「运维自检·告警ack链自锁」）】
 *   第三类匹配面：`state.daily.items` 里 `kind:'push'` 且 `ackToken` 命中的记录（= `deferred-recap` 重投）。
 *   · 有 `covers:[id…]` ⇒ 按清单**精确清**这些 id 的 deferred 项 + 给 `events[id].ackedAt` 落值；
 *   · 无 `covers`（存量老记录，例如 2026-11-06 11:06 那条 `1271c3`）⇒ **不猜**，
 *     返回 `reason:'recap-no-covers'`，由 CLI 报错（rc 3）并提示改用 `--ack <id|all>`。
 *
 *   为什么必须有这条：告警文案让人 ack 的是 recap 的 token，而那个 token 只落在 `daily.items`，
 *   `events` / `deferred` 两处都够不着 ⇒ 每次重投换一个新 token、永远 ack 不掉，4h 一个闭环。
 *
 *   🔴 `daily.items` 是 append-only 的配额账：本函数**只读**它，一个字段都不回写。
 *   ⚠️ `--ack all` 与空输入的语义**逐字节不变**（仍是"命中 events 全部 + deferred 按原三条件清"）。
 *
 * @param {object} state butler-watch-state.json 内容
 * @param {string} tokenOrId ackToken / 事件 id / 'all' / 重投清单 token
 * @param {{now?:number}} [opts]
 * @returns {{state:object, acked:string[], deferredCleared:number,
 *            matched:boolean, recapMatched:boolean, reason:null|'no-match'|'recap-no-covers'}}
 */
export function ackEvents(state, tokenOrId, opts = {}) {
  const now = opts.now ?? Date.now();
  const key = String(tokenOrId ?? '').trim().toLowerCase();
  const base = state && typeof state === 'object' ? state : emptyWatchState(now);
  const next = { ...base, events: { ...(base.events ?? {}) }, deferred: [...(base.deferred ?? [])] };
  const acked = [];

  // ① 第三类匹配面：重投记录（daily.items）→ 取它声明的 covers 清单（只读）
  const coverIds = [];
  let recapNoCovers = false;
  if (key && key !== 'all') {
    const items = Array.isArray(next.daily?.items) ? next.daily.items : [];
    for (const it of items) {
      if (!it || it.kind !== 'push') continue;
      if (String(it?.ackToken ?? '').toLowerCase() !== key) continue;
      if (Array.isArray(it.covers) && it.covers.length > 0) {
        for (const cid of it.covers) {
          const s = String(cid ?? '').trim();
          if (s) coverIds.push(s);
        }
      } else {
        recapNoCovers = true;   // 存量老记录：不知道它覆盖了哪几条 ⇒ 不猜
      }
    }
  }
  const coverSet = new Set(coverIds.map((s) => s.toLowerCase()));

  // ② 事件：事件 id / events 里的 token / covers 命中的 id
  for (const [id, rec] of Object.entries(next.events)) {
    const tok = String(rec?.ackToken ?? '').toLowerCase();
    if (!key || key === 'all' || key === id.toLowerCase() || (tok && tok === key) || coverSet.has(id.toLowerCase())) {
      next.events[id] = { ...rec, ackedAt: now };
      acked.push(id);
    }
  }

  // ③ deferred：id / deferred 里的 token / covers 命中的 id
  const before = next.deferred.length;
  next.deferred = next.deferred.filter((d) => {
    const tok = String(d?.ackToken ?? '').toLowerCase();
    const did = String(d?.id ?? '').toLowerCase();
    return !(key === 'all' || key === did || (tok && tok === key) || (coverSet.size > 0 && coverSet.has(did)));
  });
  const deferredCleared = before - next.deferred.length;
  next.updatedAt = new Date(now).toISOString();
  const matched = acked.length > 0 || deferredCleared > 0;
  return {
    state: next, acked, deferredCleared,
    matched,
    recapMatched: coverIds.length > 0,
    // 未命中原因只给调用方看（命中时恒 null）：`recap-no-covers` = token 是对上了，但那条记录没清单
    reason: matched ? null : (recapNoCovers ? 'recap-no-covers' : 'no-match'),
  };
}

/**
 * 取「次日开机首句」应置顶的延迟项（未 ack 的）。
 *
 * 【2026-10-09 · 冲刺600 补C1】新增**可选去噪门**（两个参数都不给 = 与改前逐字节同语义）：
 *   · `opts.cooldownMs` —— 队列项已投递过（`deliveredAt`）且距今 < 冷却窗 ⇒ 本轮不取。
 *     （`deliveredAt` 由 `dsh-butler-watch.mjs` 真推后写入；此前是**只写不读的死字段**。）
 *   · `opts.dailyCap`   —— `state.daily.pushed >= dailyCap` ⇒ 一条都不取（日上限；与正常事件**共用**
 *     同一个 `daily.pushed` 预算，所以合并提醒不可能把当天的额度挤爆）。
 * 为什么默认关：另一个调用方 `firstLine()`（次日开机首句**文本**，日报/开机钩子用）语义是
 *   「把所有没确认的延迟项列出来」，与「往桌宠/会话推」不是一回事 —— 本次不动它。
 *   方案与取舍：`docs\方案-冲刺600-C1延迟播报冷却-20261009.md` §三。
 */
export function pendingDeferred(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const cooldownMs = Math.max(0, Number(opts.cooldownMs ?? 0) || 0);
  const cap = Number(opts.dailyCap);
  const capReached = Number.isFinite(cap) && Number(state?.daily?.pushed ?? 0) >= cap;
  return (state?.deferred ?? []).filter((d) => {
    if (!d || d.ackedAt) return false;
    if (now - Number(d.at ?? 0) > 7 * 86_400_000) return false;
    if (capReached) return false;
    const deliveredAt = Number(d.deliveredAt ?? 0);
    if (cooldownMs > 0 && deliveredAt > 0 && now - deliveredAt < cooldownMs) return false;
    return true;
  });
}

/**
 * 【2026-10-09 · 冲刺600 补C1】延迟补推（`deferred-recap`）去噪门 —— 纯函数、不写盘、不新增状态键。
 *
 * 背景（实测）：合并提醒此前只在调用侧判 `!quiet`，**没走冷却/日上限** ⇒ 2026-10-09 的
 *   `watch-2026-10-09-host-a.md` **93 个 tick 节 93/93 都写「🔴 已推送（deferred-recap）」**、
 *   审计里桌宠被推 64+ 次，而同一份状态只记 `daily.pushed=3` ⇒ 与方案 §P2（L519-521「同类 4h 不重复推 /
 *   ≤10 条/天」、L585「通知刷屏」风险条款）**明文冲突**。本函数把延迟队列摆进**同一套**判据。
 *
 * 三分类（互斥；并集 = 旧口径的全部未 ack 项）：
 *   · `items`   —— 本轮该推的（没投递过，或距上次投递已过冷却窗）
 *   · `cooling` —— 冷却窗内（不推，等窗口过）
 *   · `capped`  —— 日上限已满（不推、**只落报告**；与 `applyPolicy` 的 daily-cap 同款语义）
 *
 * 复用的是同一份 `DEFAULT_WATCH_POLICY`（冷却 4h / 日上限 10）与同一个 `deliveredAt` 字段 ——
 * **不另造第二套冷却表/计数器**。
 *
 * @param {object} state butler-watch-state.json 内容
 * @param {{now?:number, policy?:object}} [opts]
 * @returns {{ok:boolean, items:Array, cooling:Array, capped:Array,
 *            reason:'push'|'cooldown'|'daily-cap'|'none',
 *            cooldownMs:number, dailyCap:number, dailyPushed:number}}
 */
export function planDeferredRecap(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const policy = { ...DEFAULT_WATCH_POLICY, ...(opts.policy ?? {}) };
  const all = pendingDeferred(state, { now });   // 旧口径 = 分母（未 ack + 7 天内）
  const items = pendingDeferred(state, { now, cooldownMs: policy.cooldownMs, dailyCap: policy.dailyCap });
  const picked = new Set(items);                 // 同一数组的元素 ⇒ 引用相等，直接按对象判
  const capped = Number(state?.daily?.pushed ?? 0) >= Number(policy.dailyCap) ? all : [];
  const cooling = capped.length ? [] : all.filter((d) => !picked.has(d));
  const reason = items.length ? 'push' : (capped.length ? 'daily-cap' : (cooling.length ? 'cooldown' : 'none'));
  return {
    ok: true, items, cooling, capped, reason,
    cooldownMs: Number(policy.cooldownMs),
    dailyCap: Number(policy.dailyCap),
    dailyPushed: Number(state?.daily?.pushed ?? 0),
  };
}

/**
 * 【v1.1 · B4#1】未 ack 事件清单 —— **唯一权威源**（2026-09-14 面板 v2 分片卡新增）。
 *
 * 为什么必须有这个函数：`ackedAt >= lastNotifyAt && lastNotifyAt > 0` 这条判据散落在
 * 面板/日报各处的复算里，口径一飘就会出现"面板说 N 件、日报说 M 件"。此处收敛成纯函数，
 * **面板与指标一律调它，禁止自算**。
 *   · 只有真正推送过的记录（`lastNotifyAt > 0`）才需要 ack；🟡 只进日报、无 lastNotifyAt → 不在此列。
 *   · `deferred`（免打扰延迟项，含升级项）默认一并计入（它们同样"等人确认"），`includeDeferred:false` 可排除。
 *   · 同一 id 同时以事件与 deferred 出现时，保留事件记录（更权威），deferred 只补位。
 *   · **可读性兜底（2026-09-14）**：老状态文件里 events 记录不一定有 title/level/detail
 *     （此前只在 push/deferred 里写）。缺了就按 `opts.eventTitles` / `opts.eventLevels`
 *     （调用方传事件表 id→中文名/级别）兜底，再兜底 `lastValue`（人话机器值）——
 *     绝不再返回空标题，否则面板渲染出来就是一行看不懂的英文 id。
 * 纯函数、不写盘、不读盘（state 由调用方传入）。
 *
 * @param {object} state butler-watch-state.json 内容
 * @param {{now?:number, includeDeferred?:boolean, levels?:string[],
 *          eventTitles?:Record<string,string>, eventLevels?:Record<string,string>}} [opts]
 * @returns {{ok:boolean, count:number, oldestAt:number|null, deduped:number, items:Array}}
 */
export function listUnacked(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const wantLevels = Array.isArray(opts.levels) && opts.levels.length > 0 ? new Set(opts.levels) : null;
  const fallbackTitle = (id) => opts.eventTitles?.[id] || id;
  const fallbackLevel = (id) => opts.eventLevels?.[id] ?? null;
  const items = [];
  for (const [id, rec] of Object.entries(state?.events ?? {})) {
    const lastNotifyAt = Number(rec?.lastNotifyAt ?? 0);
    if (!(lastNotifyAt > 0)) continue;
    if (Number(rec?.ackedAt ?? 0) >= lastNotifyAt) continue;
    const level = rec?.level ?? fallbackLevel(id);
    if (wantLevels && !wantLevels.has(level)) continue;
    items.push({
      id,
      level,
      title: rec?.title || fallbackTitle(id),
      at: lastNotifyAt,
      ackToken: rec?.ackToken ?? null,
      detail: rec?.detail ?? rec?.lastValue ?? null,
      unackedMs: Math.max(0, now - lastNotifyAt),
      escalations: Number(rec?.escalations ?? 0),
      source: 'event',
    });
  }
  if (opts.includeDeferred !== false) {
    for (const d of state?.deferred ?? []) {
      if (!d || d.ackedAt) continue;
      const did = String(d.id ?? '');
      const dlevel = d.level ?? fallbackLevel(did);
      if (wantLevels && !wantLevels.has(dlevel)) continue;
      const at = Number(d.at ?? 0);
      items.push({
        id: did,
        level: dlevel,
        title: d.title || fallbackTitle(did),
        at,
        ackToken: d.ackToken ?? null,
        detail: d.detail ?? null,
        unackedMs: Math.max(0, now - at),
        escalations: String(d.reason ?? '').startsWith('escalated:') ? 1 : 0,
        reason: d.reason ?? null,
        source: 'deferred',
      });
    }
  }
  const byId = new Map();
  let deduped = 0;
  for (const it of items) {
    const prev = byId.get(it.id);
    if (!prev) { byId.set(it.id, it); continue; }
    deduped++;
    // 事件记录恒胜 deferred（deferred 只是同一事件在免打扰期落下的排队项）
    if (prev.source === 'deferred' && it.source === 'event') byId.set(it.id, it);
  }
  const out = [...byId.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return {
    ok: true,
    count: out.length,
    oldestAt: out.length > 0 ? (out[out.length - 1].at ?? null) : null,
    deduped,
    items: out,
  };
}

/** 误报反馈记录（写盘由调用方 appendJsonl 到 butler-falsepositives.jsonl）。 */
export function markFalsePositive(state, tokenOrId, opts = {}) {
  const now = opts.now ?? Date.now();
  const key = String(tokenOrId ?? '').trim().toLowerCase();
  const base = state && typeof state === 'object' ? state : emptyWatchState(now);
  const hit = Object.entries(base.events ?? {}).find(([id, rec]) => id.toLowerCase() === key
    || String(rec?.ackToken ?? '').toLowerCase() === key);
  const record = {
    at: new Date(now).toISOString(),
    eventId: hit ? hit[0] : null,
    ackToken: hit ? (hit[1]?.ackToken ?? null) : (key || null),
    note: opts.note ?? null,
    value: hit ? (hit[1]?.lastValue ?? null) : null,
    source: opts.source ?? 'cli',
    device: opts.device ?? null,
  };
  const next = { ...base, events: { ...(base.events ?? {}) } };
  if (hit) next.events[hit[0]] = { ...hit[1], falsePositiveAt: now };
  return { state: next, record, matched: Boolean(hit) };
}
