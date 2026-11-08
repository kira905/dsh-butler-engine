// dsh-butler / lib/handoff-events.mjs —— P2「交接」事件（P9 H4 · **只进报告**）
//
// ⚠️ 为什么**不进** `watch-events.mjs` 的 `EVENT_SPECS`（本文件的第一条纪律）：
//   `docs\P2会盯人-使用与验收-20260909.md` §四「新增事件前必读 · KPI 口径铁律」实测写明：
//   任何事件只要注册进主表，就会抬高裸跑期门槛②的分母，并在 4h 后（未 ack ⇒ 判定疑似误报）
//   抬高门槛③的分子。**天生"零 KPI 污染"的观测只有一条路：不进主表，走 writeReport 的报告段。**
//   ⇒ 本事件族由 watch tick 以 `writeReport({ extra })` 落地（`lib/watch-notify.mjs` 的 extra 通道）。
//   ⇒ 也正因如此，这里的事件规格**自带注册表**（`HANDOFF_EVENT_SPECS` / `HANDOFF_EVENT_IDS`），
//      供验收方读源码 / 单测 / registry 复核——"有注册"与"不进主表"两者同时成立。
//
// 覆盖（方案 §5.5「可见性铁律」+ §5.7 时间语义表）：
//   · 交接完成 —— Arrive/Depart 收尾后**无条件播报一行**（不是告警；本模块按状态变化播报一次）
//   · 交接失败 / 分叉 / 版本门 / 双开嫌疑 / 时钟门拒绝 —— 🔴（§5.5 要求 🔴 直推；本卡按卡面
//     「新增事件只进报告或按 §5.6 规则降级，别污染在跑的观测口径」落在报告段 + 面板卡 + 日报段）
//   · 交接陈旧 —— lastSuccessfulHandoffAt 超 §5.7 两档（24h 🟡 / 72h 🔴）
//   · 交接进行中 —— ⬜ 信息项（喂面板卡；**不写报告**，属正常短暂状态）
//
// 纪律：本模块**只判定不动作**（纯函数；`planHandoffObservation` 也不写盘——落盘由调用方决定）。
import path from 'node:path';

import { toMs, judgeHandoffRun, HANDOFF_RUNNING_TTL_MS } from '../../src/dsh-butler/lib/handoff-window.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';

export const HANDOFF_EVENTS_VERSION = '0.1.0';

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-handoff-obs.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home }).path; }

/** 运行键（"同一轮交接只播报一次"/"陈旧档位变了才再报"）；butler- 前缀 ⇒ 已在 P5 自指豁免清单内。 */
export const HANDOFF_OBS_STATE_NAME = 'butler-handoff-obs.json';
export const HANDOFF_OBS_SCHEMA = 1;

export const LEVEL = { RED: 'red', YELLOW: 'yellow', INFO: 'info' };
/** 走报告段的固定提示（每次 reportOnly 输出都带，便于日后复核"为什么没告警"）。 */
export const REPORT_ONLY_NOTE = '报告段（P9 H4 · 零 KPI 污染：不进 EVENT_SPECS 主表）';

/** §5.5 明列的「🔴 直推」触发码：分叉 / 版本门失败 / 解密自检失败 / 双开嫌疑 / 时钟门拒绝。 */
export const FATAL_ALERT_CODES = Object.freeze(new Set([
  'diverge', 'diverged', 'fork', 'forked', 'push-rejected', 'pull-rejected',
  'version-gate', 'version-gate-failed', 'decrypt-selfcheck', 'decrypt-failed',
  'dual-active', 'dual-open', 'merge-clock-gate', 'merge-clock-resync', 'clock-gate',
]));

const FATAL_RE = /diverge|fork|version|decrypt|dual|clock|分叉|版本门|解密|双开|时钟/i;

/**
 * 本地日（`YYYY-MM-DD`）—— 与 `lib/autonomy-actions.mjs#localDay` **同口径**（本地时区，**不是** UTC）。
 * 用 `toISOString().slice(0,10)` 会在东八区错 8 小时 ⇒ 跨零点那 8 小时里"今天"是昨天。
 */
function localDay(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 判定一条 alert 是否致命（🔴）。 */
export function isFatalAlert(a) {
  if (!a || typeof a !== 'object') return false;
  const code = String(a.code ?? '').toLowerCase();
  if (code && FATAL_ALERT_CODES.has(code)) return true;
  const level = String(a.level ?? '').toLowerCase();
  if (level === 'alert' || level === 'error' || level === 'fatal') return true;
  if (level === 'warn' || level === 'warning') return false;
  return FATAL_RE.test(`${a.code ?? ''} ${a.message ?? ''}`);
}

/**
 * 事件规格注册表（机器可核）。judge(snapshot, opts) → null | {value, detail, evidence, level?}
 * snapshot 需含：`handoff`（本模块的 collect 产出，见 watch-collect 的 `snap.handoff`）。
 */
export const HANDOFF_EVENT_SPECS = [
  {
    id: 'handoff-run-failed', title: '交接失败 / 分叉', level: LEVEL.RED, deliverable: 'report',
    category: 'handoff', dataSource: 'handoff',
    judge: (s) => {
      const h = s.handoff;
      if (!h || !h.ok || !h.record) return null;
      const run = h.run ?? judgeHandoffRun(h.record, { now: s.now });
      // 只在**已收尾**的交接上判（进行中的失败无从谈起）；超时中断单独一条。
      if (run.mode !== 'finished') return null;
      const rec = h.record;
      const alerts = Array.isArray(rec.alerts) ? rec.alerts : [];
      const fatal = alerts.filter(isFatalAlert);
      const failed = rec.result === 'failed';
      if (!failed && fatal.length === 0) return null;
      const bits = [];
      if (failed) bits.push('result=failed');
      if (fatal.length) bits.push(`致命告警 ${fatal.length} 条：${fatal.slice(0, 3).map((a) => a.code ?? a.message ?? '?').join('、')}`);
      return {
        value: `failed@${rec.finishedAt}@${rec.role ?? '?'}`,
        level: LEVEL.RED,
        detail: `交接（${rec.role ?? '?'}）于 ${rec.finishedAt ?? '?'} 以失败收尾 · ${bits.join(' · ')}`,
        evidence: { role: rec.role ?? null, result: rec.result ?? null, finishedAt: rec.finishedAt ?? null, alerts: fatal.slice(0, 5), alertCount: alerts.length, deferred: (rec.deferred ?? []).length },
      };
    },
  },
  {
    id: 'handoff-run-interrupted', title: '交接中断未收尾', level: LEVEL.YELLOW, deliverable: 'report',
    category: 'handoff', dataSource: 'handoff',
    judge: (s) => {
      const h = s.handoff;
      if (!h || !h.ok) return null;
      const run = h.run;
      if (!run || run.timedOut !== true) return null;
      return {
        value: `interrupted@${h.record?.startedAt ?? '?'}`,
        level: LEVEL.YELLOW,
        detail: `交接（${h.record?.role ?? '?'}）起于 ${h.record?.startedAt ?? '?'} 但**未写 finishedAt**，已超 TTL ${Math.round((run.ttlMs ?? HANDOFF_RUNNING_TTL_MS) / 60000)} 分钟 —— 暂停态已自动恢复（§17.2 T8）`,
        evidence: { startedAt: h.record?.startedAt ?? null, ageMs: run.ageMs ?? null, ttlMs: run.ttlMs ?? null, role: h.record?.role ?? null },
      };
    },
  },
  {
    id: 'handoff-run-deferred', title: '交接降级（未推项 / 落地跳过）', level: LEVEL.YELLOW, deliverable: 'report',
    category: 'handoff', dataSource: 'handoff',
    judge: (s) => {
      const h = s.handoff;
      if (!h || !h.ok || !h.record) return null;
      const rec = h.record;
      const run = h.run ?? judgeHandoffRun(rec, { now: s.now });
      if (run.mode !== 'finished') return null;
      const deferred = Array.isArray(rec.deferred) ? rec.deferred : [];
      const applied = Array.isArray(rec.applied) ? rec.applied : [];
      // ⚠️ 口径与面板/日报同源（2026-09-28 实测修正）：`unchanged`（与仓内一致）**不是跳过**——
      //   首版按 `status!=='ok'` 统计，把 311 项正常态算成"落地跳过 365 项"，数字完全失真。
      const skipped = applied.filter((a) => a && typeof a.status === 'string' && /^skipped[-_]/i.test(a.status));
      if (rec.result !== 'deferred' && deferred.length === 0 && skipped.length === 0) return null;
      return {
        value: `deferred@${rec.finishedAt}@${deferred.length}@${skipped.length}`,
        level: LEVEL.YELLOW,
        detail: `交接（${rec.role ?? '?'}）有未推 / 跳过：result=${rec.result ?? '?'} · deferred ${deferred.length} 项 · 落地跳过 ${skipped.length} 项`,
        evidence: {
          result: rec.result ?? null, finishedAt: rec.finishedAt ?? null,
          deferred: deferred.slice(0, 10), skipped: skipped.slice(0, 10).map((a) => ({ key: a.key ?? null, status: a.status, reason: a.reason ?? null })),
          unchangedCount: applied.filter((a) => a?.status === 'unchanged').length,
        },
      };
    },
  },
  {
    id: 'handoff-stale', title: '交接陈旧', level: LEVEL.YELLOW, deliverable: 'report',
    category: 'handoff', dataSource: 'handoff', worseWhen: 'increase',
    judge: (s) => {
      const h = s.handoff;
      if (!h || !h.ok) return null;
      const hh = h.health;
      const ageMs = hh?.facts?.handoffAgeMs ?? null;
      if (!Number.isFinite(ageMs)) return null;
      const th = hh.thresholds ?? {};
      const level = ageMs > (th.handoffAlertMs ?? 72 * 3600 * 1000) ? LEVEL.RED
        : (ageMs > (th.handoffWarnMs ?? 24 * 3600 * 1000) ? LEVEL.YELLOW : null);
      if (!level) return null;
      return {
        value: `${level}@${Math.round(ageMs / 3600000)}h`,
        level,
        detail: `上次完整交接距今 ${(ageMs / 3600000).toFixed(1)}h（§5.7：24h 🟡 / 72h 🔴）· lastSuccessfulHandoffAt=${h.record?.lastSuccessfulHandoffAt ?? '?'}`,
        evidence: { handoffAgeMs: ageMs, lastSuccessfulHandoffAt: h.record?.lastSuccessfulHandoffAt ?? null, thresholds: th, level },
      };
    },
  },
];

/** 信息项（⬜，只喂面板 / 不写报告）：交接进行中。 */
export const HANDOFF_INFO_SPECS = [
  {
    id: 'handoff-running', title: '交接进行中', level: LEVEL.INFO, deliverable: 'none',
    category: 'handoff', dataSource: 'handoff',
    judge: (s) => {
      const h = s.handoff;
      if (!h || !h.ok || !h.run?.active) return null;
      return {
        value: `running@${h.record?.startedAt ?? '?'}`,
        level: LEVEL.INFO,
        detail: `交接（${h.record?.role ?? '?'}）进行中 ${Math.round((h.run.ageMs ?? 0) / 1000)}s`,
        evidence: { role: h.record?.role ?? null, startedAt: h.record?.startedAt ?? null, ageMs: h.run.ageMs ?? null },
      };
    },
  },
];

export const HANDOFF_EVENT_IDS = [...HANDOFF_EVENT_SPECS, ...HANDOFF_INFO_SPECS].map((e) => e.id);

/** 判定全部交接事件（纯函数；返回 firing 的事件，含 INFO）。 */
export function judgeHandoffEvents(snapshot, opts = {}) {
  const out = [];
  for (const spec of [...HANDOFF_EVENT_SPECS, ...HANDOFF_INFO_SPECS]) {
    let r = null;
    try {
      r = spec.judge(snapshot, opts);
    } catch (e) {
      r = { value: `judge-error`, level: LEVEL.YELLOW, detail: `交接事件 ${spec.id} 判定异常：${e?.message ?? e}`, evidence: { error: String(e?.message ?? e) } };
    }
    if (!r) continue;
    out.push({
      id: spec.id,
      title: spec.title,
      level: r.level ?? spec.level,
      category: spec.category,
      dataSource: spec.dataSource,
      reportOnly: spec.deliverable === 'report',
      value: r.value ?? null,
      detail: r.detail ?? '',
      evidence: r.evidence ?? {},
    });
  }
  return out;
}

/**
 * 计划「要不要写这一轮的报告段」（去重，防每 5 分钟刷一行）。
 *
 * 去重键：
 *   · 失败/降级 —— `runKey = <id>@<finishedAt>`；同一轮交接只播报一次。
 *   · 陈旧 —— 只在**档位变化**（无→🟡→🔴）时播报。
 *   · 中断 —— 同一 startedAt 只播报一次。
 *   · running —— 永不写报告（只喂面板）。
 * @param {Array} events judgeHandoffEvents 的产出
 * @param {{prev?:object|null, now?:number}} [opts] prev = 上次的运行键状态
 */
export function planHandoffObservation(events, opts = {}) {
  const prev = opts.prev && typeof opts.prev === 'object' ? opts.prev : {};
  const rows = Array.isArray(events) ? events : [];
  const lines = [];
  const next = { ...prev };
  const picked = [];
  for (const ev of rows) {
    if (ev.id === 'handoff-running') continue; // 信息项：只喂面板
    if (ev.id === 'handoff-stale') {
      const lv = String(ev.level ?? '');
      const day = localDay(Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now());
      // 【2026-10-09 修 · 卡「冲刺600·补C2C3」】原口径 = **只在档位变化**时播报一次 ⇒ 一旦进了 🔴，
      //   只要不再更坏就**永久静默**。生产实证：`~/.dsh/butler-handoff-obs.json` 的 `staleLevel`
      //   自 2026-09-28 起一直是 `'red'`，而交接自 09-24 起停摆 15 天 —— P2 报告段**一行都没有**
      //   ⇒ 最该被看见的"长期停摆"形态反而最安静（当日管家日报有 🔴 段，但 P2 侧看不到）。
      //   现口径：**档位变化 或 每本地日复报一次**（每天最多一条，tick=5min 不会刷屏）。
      if (prev.staleLevel === lv && prev.staleDay === day) continue;
      next.staleLevel = lv;
      next.staleDay = day;
      picked.push(ev);
      continue;
    }
    const key = `${ev.id}@${ev.value ?? ''}`;
    if (prev.runKeys && prev.runKeys[key]) continue;
    // ⚠️ 基础必须是 **next.runKeys**（本轮已累积的键），不是 prev.runKeys：
    //   2026-09-28 实测踩坑 —— 写 `{ ...(prev.runKeys ?? {}), [key]: true }` 时，prev 里没有的本轮
    //   前几个键会被**逐个覆盖**，一轮多事件只剩最后一个键 ⇒ 下一轮其余事件全部重复播报
    //   （生产实证：tick #3361 播了 failed+deferred+stale，tick #3362 又播了一次 failed）。
    next.runKeys = { ...(next.runKeys ?? prev.runKeys ?? {}), [key]: true };
    picked.push(ev);
  }
  // 运行键表限长（防无限增长；保留最近 50 条）
  if (next.runKeys) {
    const keys = Object.keys(next.runKeys);
    if (keys.length > 50) {
      const keep = keys.slice(-50);
      next.runKeys = Object.fromEntries(keep.map((k) => [k, true]));
    }
  }
  if (picked.length) {
    lines.push(`**🤝 交接 —— ${REPORT_ONLY_NOTE}**`);
    const icon = { red: '🔴', yellow: '🟡', info: '⬜' };
    for (const ev of picked) lines.push(`- ${icon[ev.level] ?? '⚪'} **${ev.title}**（\`${ev.id}\`）：${ev.detail}`);
    lines.push('');
  }
  return { lines, picked, next, changed: picked.length > 0 };
}

/** 运行键文件路径（butler- 前缀 ⇒ 已豁免 P5 自指审计）。 */
export function handoffObsStatePath(opts = {}) {
  const home = opts.home
    ?? process.env.BUTLER_DSH_HOME
    ?? process.env.DSH_HOME
    ?? path.join(process.env.USERPROFILE ?? '', '.dsh');
  return opts.stateFile ?? stateFileOf(HANDOFF_OBS_STATE_NAME, { home });
}
