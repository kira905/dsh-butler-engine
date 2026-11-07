// dsh-butler / lib/handoff-health.mjs —— 交接健康 + 记忆库 RPO（P9 §17.2 T5 / T6 落地）
//
// 存在理由（2026-09-15 卡「T5 记忆库 RPO 登记 + T6 时钟门降级路径」）：
//   · T6：时钟门 fail-closed 时**主人只看到 🔴 / 什么都看不到**，交接功能"实际瘫痪"这件事
//     没有任何一处界面说过 —— 因为判定散在交接器内部，没人聚合它。
//   · T5：记忆库 RPO 从未登记。方案 §5.7 时间语义表只有「会话 RPO」一行；`P9-H1b` L80 把
//     「memory.db 一律不推」当结论 ⇒ 记忆库（A 类！不可重建）的恢复点目标凭空消失了。
//
// 本模块 = **一处判定**（纯函数、零 IO），由三方共用（判定口径单一真相）：
//   ① 日报 `dsh-butler-panel/lib/checks.mjs#collectSync()` → 复用既有「📡 同步健康」段（不另造段）
//   ② 交接器 `handoff.mjs`（时钟门拒绝时取降级文案）
//   ③ 面板 / 自检（读同一份 facts）
//
// 时间语义口径 = 方案 §5.7（唯一权威口径，本模块不另立阈值）：
//   lastHeartbeatAt 陈旧 90min 🟡 · lastSuccessfulHandoffAt 24h 红条 / 72h 🔴
//   记忆库 RPO 阈值：**本卡新登记**（§5.7 新增行），取与会话 RPO 同档的 24h / 72h。
//
// ⚠️ 纪律：本模块**只判定不动作**（不写文件、不读文件、不发网络、不弹窗）——
//   动作全部由调用方按自己的失败分档执行（日报失败降级、交接器 fail-open）。
export const HANDOFF_HEALTH_VERSION = '0.2.0';

/** 阈值（毫秒）。全部来自 §5.7；记忆库 RPO 两档为本卡登记值。 */
export const HEALTH_THRESHOLDS = {
  /** 心跳陈旧（§5.7：90min = 热采 30min × 3）。 */
  heartbeatStaleMs: 90 * 60 * 1000,
  /** 交接陈旧两档（§5.7：24h 面板红条 / 72h 🔴 直推）。 */
  handoffWarnMs: 24 * 60 * 60 * 1000,
  handoffAlertMs: 72 * 60 * 60 * 1000,
  /** 记忆库 RPO 两档（T5 登记：记忆库属 A 类不可重建，取与会话同档）。 */
  memoryRpoWarnMs: 24 * 60 * 60 * 1000,
  memoryRpoAlertMs: 72 * 60 * 60 * 1000,
  /** 本机记忆库比仓内副本新多少 → 提示"有未随仓的增量"（热数据未备份窗口）。 */
  memoryDriftWarnMs: 6 * 60 * 60 * 1000,
  /** 双开嫌疑（§17.2 T4 口径）：心跳显著新于上次完整交接。 */
  dualActiveMs: 30 * 60 * 1000,
};

const LEVEL_RANK = { green: 0, yellow: 1, red: 2 };

/** 时间戳（ISO 串 / 数字 / Date）→ 毫秒 epoch；取不到 → null（**不判、不告警**）。 */
export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** 毫秒 → 人话（"3.2h" / "18min" / "2.1d"）。 */
export function humanAge(ms) {
  if (!Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}min`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

/** ISO → 本地短时间（日报可读性；失败回退原串）。 */
function fmt(ts) {
  const ms = toMs(ts);
  if (ms === null) return String(ts ?? '-');
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 交接健康 + 记忆库 RPO 判定（纯函数）。
 *
 * @param {{
 *   now?:number,
 *   host?:string,
 *   record?:object|null,              // 本机交接单（~/.dsh/butler-handoff.json）内容
 *   peerRecord?:object|null,          // 对端交接单内容（可选，仅用于文案）
 *   peerHost?:string|null,
 *   localMemory?:{mtimeMs?:number|null, bytes?:number|null}|null,   // 本机 memory.db 的 stat
 *   repoMemory?:{mtimeMs?:number|null, bytes?:number|null, path?:string|null}|null, // 仓1 副本 stat
 *   thresholds?:object,
 * }} input
 * @returns {{
 *   version:string, ok:true, level:'green'|'yellow'|'red',
 *   summary:string, lines:string[], reasons:{code:string,level:string,message:string}[],
 *   facts:object
 * }}
 */
export function judgeHandoffHealth(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const th = { ...HEALTH_THRESHOLDS, ...(input.thresholds ?? {}) };
  const rec = input.record && typeof input.record === 'object' ? input.record : null;
  const reasons = [];
  const lines = [];
  const add = (code, level, message, line) => {
    reasons.push({ code, level, message });
    lines.push(line ?? message);
  };

  const facts = {
    host: input.host ?? rec?.host ?? null,
    recordPresent: Boolean(rec),
    role: rec?.role ?? null,
    result: rec?.result ?? null,
    finishedAt: rec?.finishedAt ?? null,
    lastSuccessfulHandoffAt: rec?.lastSuccessfulHandoffAt ?? null,
    lastHeartbeatAt: rec?.lastHeartbeatAt ?? null,
    handoffAgeMs: null,
    heartbeatAgeMs: null,
    peer: null,
    clockGate: { ok: null, rejected: false, reason: null },
    merge: { enabled: rec?.merge?.enabled ?? null, skipped: rec?.merge?.skipped ?? null, clockOk: rec?.merge?.clockOk ?? null },
    memory: {
      rpoMs: null, asOfMs: null, asOfSource: null,
      localMtimeMs: null, repoMtimeMs: null, driftMs: null, bytes: null,
    },
    alerts: { total: 0, red: 0, yellow: 0 },
  };

  // ---- 交接单本体
  if (!rec) {
    add('handoff-record-missing', 'yellow',
      '本机无交接单（交接从未跑过 / 被清理）',
      '❔ 本机无交接单（状态目录下没有交接状态文件） —— 交接从未跑过或已被清理（接机/收工链路未接线？）');
  } else {
    const alerts = Array.isArray(rec.alerts) ? rec.alerts : [];
    facts.alerts.total = alerts.length;
    facts.alerts.red = alerts.filter((a) => a?.level === 'alert').length;
    facts.alerts.yellow = alerts.filter((a) => a?.level === 'warn').length;

    // ---- T6 · 时钟门（fail-closed 的降级可见性）
    const gateAlert = alerts.find((a) => a?.code === 'merge-clock-gate');
    const clockOk = rec?.merge?.clockOk;
    if (clockOk === false || gateAlert) {
      const why = String(rec?.merge?.reason ?? gateAlert?.message ?? '时钟门未过').replace(/^离线语义合并跳过：/, '').slice(0, 200);
      facts.clockGate = { ok: false, rejected: true, reason: why };
      add('clock-gate-rejected', 'red',
        `时钟门拒绝语义合并：${why}`,
        `🔴 **时钟门拒绝语义合并**（坑库 / 记忆库未合并）：${why}`);
      lines.push('　　└ 降级说明：**只读交接照常**（fetch/pull / 会话落地 / 分发不受影响）—— 本次仅"离线语义合并"整段跳过，**交接未瘫痪**；两机数据仍在各自机器上，未丢失');
      lines.push('　　└ 处置：先对时再重跑 —— 管理员 PowerShell 跑 `w32tm /resync`（本卡已支持交接器自动尝试，默认 dry-run：`DSH_HANDOFF_RESYNC=1` 才真跑）');
    } else if (clockOk === true) {
      facts.clockGate = { ok: true, rejected: false, reason: null };
    } else {
      facts.clockGate = { ok: null, rejected: false, reason: '未判（取不到可比时间戳或无 merge 段）' };
    }
    if (rec?.merge?.skipped === true && facts.clockGate.rejected !== true) {
      add('merge-skipped', 'yellow',
        `语义合并整段跳过（非时钟门）：${String(rec.merge.reason ?? '-').slice(0, 160)}`,
        `🟡 语义合并整段跳过（非时钟门）：${String(rec.merge.reason ?? '-').slice(0, 160)}`);
    }

    // ---- 交接新鲜度（§5.7 两档）
    const hs = toMs(rec.lastSuccessfulHandoffAt);
    if (hs !== null) {
      const age = now - hs;
      facts.handoffAgeMs = age;
      if (age > th.handoffAlertMs) {
        add('handoff-stale-72h', 'red',
          `上次完整交接距今 ${humanAge(age)}（> ${humanAge(th.handoffAlertMs)}）`,
          `🔴 上次完整交接距今 **${humanAge(age)}**（${fmt(hs)}）—— 超过 72h 阈值（§5.7），换机前先跑一次完整 Depart/Arrive`);
      } else if (age > th.handoffWarnMs) {
        add('handoff-stale-24h', 'yellow',
          `上次完整交接距今 ${humanAge(age)}（> ${humanAge(th.handoffWarnMs)}）`,
          `🟡 上次完整交接距今 **${humanAge(age)}**（${fmt(hs)}）—— 超过 24h 面板红条阈值（§5.7）`);
      }
    }
    // ---- 心跳（§5.7 90min）
    const hb = toMs(rec.lastHeartbeatAt);
    if (hb !== null) {
      const age = now - hb;
      facts.heartbeatAgeMs = age;
      if (age > th.heartbeatStaleMs) {
        add('heartbeat-stale-90m', 'yellow',
          `交接心跳陈旧 ${humanAge(age)}（> ${humanAge(th.heartbeatStaleMs)}）`,
          `🟡 交接心跳陈旧 **${humanAge(age)}**（${fmt(hb)}）—— 热采（30min/轮）可能没在跑（§5.7：90min = 30min × 3）`);
      }
    }
  }

  // ---- 对端（可选）：**双开嫌疑只看对端交接单** -----------------------------------
  //   §17.2 T4 口径 =「lastHeartbeatAt 显著新于 lastSuccessfulHandoffAt」，
  //   其语义是"**对端**在最后一次完整交接之后仍在活动"—— 所以必须拿**对端**的字段判。
  //   ⚠️ 2026-09-15 首版实测即踩坑：拿**本机** record 判时，本机热采每 30 分钟更新心跳、
  //     而完整交接是几小时前的事 ⇒ 差 2.7h **恒成立** ⇒ 每天都刷一条假的"疑似双开"。
  //     本机心跳新 = 本机在跑 = 正常形态，两者语义完全不同，此处按 T4 收窄到对端。
  const peer = input.peerRecord && typeof input.peerRecord === 'object' ? input.peerRecord : null;
  if (peer) {
    const phb = toMs(peer.lastHeartbeatAt);
    const phs = toMs(peer.lastSuccessfulHandoffAt);
    facts.peer = {
      host: input.peerHost ?? peer.host ?? null,
      lastHeartbeatAt: peer.lastHeartbeatAt ?? null,
      lastSuccessfulHandoffAt: peer.lastSuccessfulHandoffAt ?? null,
      handoffAgeMs: phs === null ? null : now - phs,
      dualActive: false,
    };
    if (phb !== null && phs !== null && phb - phs > th.dualActiveMs) {
      facts.peer.dualActive = true;
      add('dual-active-suspect', 'yellow',
        `对端心跳比它上次完整交接新 ${humanAge(phb - phs)}（疑似双开）`,
        `🟡 对端 **${facts.peer.host ?? '-'}** 的心跳比它自己上次完整交接新 **${humanAge(phb - phs)}**`
        + `（§17.2 T4 判据）—— 对端在最后一次完整交接后仍在活动：两台机同时开 DSH？此时热采 fail-closed 跳过`);
    }
    if (phs !== null && now - phs > th.handoffWarnMs) {
      add('peer-handoff-stale', 'yellow',
        `对端上次完整交接距今 ${humanAge(now - phs)}`,
        `🟡 对端 **${facts.peer.host ?? '-'}** 上次完整交接距今 **${humanAge(now - phs)}**（${fmt(phs)}）—— 对端可能崩在半路，或这几天没开机`);
    }
  }

  // ---- T5 · 记忆库 RPO（A 类 · 不可重建）
  //   asOf 口径（**复用既有 asOf 机制，不另造一套**）：
  //     ① 首选「仓1 工作副本里 dsh/memory/memory.db 的 mtime」= 记忆库**真正被搬进仓**的时刻
  //        （与面板 lib/shards.mjs 的 `asOf.memory = fileAsOf(memory.db)` 同为 file-mtime 口径）；
  //     ② 取不到 → 回退本机交接单 `lastSuccessfulHandoffAt`（= Depart 冷采时刻）；
  //     ③ 都没有 → null：**不判、不告警**（fail-safe，绝不凭猜报红）。
  const repoM = input.repoMemory && Number.isFinite(input.repoMemory.mtimeMs) ? input.repoMemory.mtimeMs : null;
  const localM = input.localMemory && Number.isFinite(input.localMemory.mtimeMs) ? input.localMemory.mtimeMs : null;
  const handoffMs = toMs(rec?.lastSuccessfulHandoffAt);
  facts.memory.localMtimeMs = localM;
  facts.memory.repoMtimeMs = repoM;
  facts.memory.bytes = input.localMemory?.bytes ?? input.repoMemory?.bytes ?? null;

  const asOfMs = repoM ?? handoffMs;
  const asOfSource = repoM !== null ? 'repo-copy-mtime' : (handoffMs !== null ? 'handoff-record' : null);
  facts.memory.asOfMs = asOfMs;
  facts.memory.asOfSource = asOfSource;
  if (asOfMs !== null) {
    const rpo = now - asOfMs;
    facts.memory.rpoMs = rpo;
    if (rpo > th.memoryRpoAlertMs) {
      add('memory-rpo-stale-72h', 'red',
        `记忆库 RPO ${humanAge(rpo)}（> ${humanAge(th.memoryRpoAlertMs)}）`,
        `🔴 **记忆库恢复点 ${humanAge(rpo)} 前**（asOf ${fmt(asOfMs)} · ${asOfSource}）—— 记忆库属 **A 类（不可重建）**，` +
        `比会话（30min 热采）差得多；这期间本机新增的记忆在拔电/盘损时**只存在于本机**`);
    } else if (rpo > th.memoryRpoWarnMs) {
      add('memory-rpo-stale-24h', 'yellow',
        `记忆库 RPO ${humanAge(rpo)}（> ${humanAge(th.memoryRpoWarnMs)}）`,
        `🟡 记忆库恢复点 **${humanAge(rpo)}** 前（asOf ${fmt(asOfMs)} · ${asOfSource}）—— 记忆库 A 类不可重建，RPO 见 §5.7 登记行`);
    }
  } else {
    lines.push('❔ 记忆库 RPO：不可判（仓副本与本机交接单都取不到时间）—— 不告警（fail-safe）');
  }
  // 热数据未随仓的增量窗口（本机比仓副本新多少）
  if (localM !== null && repoM !== null) {
    const drift = localM - repoM;
    facts.memory.driftMs = drift;
    if (drift > th.memoryDriftWarnMs) {
      add('memory-ahead-of-repo', 'yellow',
        `本机记忆库比仓内副本新 ${humanAge(drift)}`,
        `🟡 本机记忆库比仓内副本新 **${humanAge(drift)}**（本机 ${fmt(localM)} vs 仓 ${fmt(repoM)}）—— 这段增量只在本地，等下一次 Depart 才进仓`);
    }
  }

  const level = reasons.reduce((acc, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[acc] ? r.level : acc), 'green');
  const red = reasons.filter((r) => r.level === 'red').length;
  const yellow = reasons.filter((r) => r.level === 'yellow').length;
  const summary = reasons.length === 0
    ? `正常（上次完整交接 ${facts.handoffAgeMs === null ? '-' : humanAge(facts.handoffAgeMs) + ' 前'} · 记忆库 RPO ${facts.memory.rpoMs === null ? '-' : humanAge(facts.memory.rpoMs)}）`
    : `🔴 ${red} / 🟡 ${yellow}：${reasons[0].message}${reasons.length > 1 ? ` 等 ${reasons.length} 条` : ''}`;

  return {
    version: HANDOFF_HEALTH_VERSION,
    ok: true,
    level,
    summary,
    lines,
    reasons,
    facts,
  };
}
