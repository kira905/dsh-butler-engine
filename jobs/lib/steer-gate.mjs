// dsh-butler / lib/steer-gate.mjs —— 「硬限插话（steer）开关 + 危险动作豁免名单」唯一判据源
//
// 由来（卡：夜批03 · 投递分级实现 / 2026-09-24 · 主人 D27 = (b′) 拍板）：
//   把 `ctx-guard` 的**硬限**档从「只发 queue 文本」升级为**可 steer 插话** ——
//   `session.prompt { mode:'steer' }` 在**当前 step 跑完时**插话（**不 abort 进行中的工具**；真机实测见
//   `docs\交付报告-夜批02-投递分级真机实测-20260923.md` §2.2 / §8.2）。D27 的三条硬要求落在这里：
//     ① **默认关**（未配置 ⇒ 行为与"单档 queue"逐字节等价）；
//     ② **危险动作豁免名单**（审核 N-3）：(a) 取什么信号 + 登记在哪 + 判不出时的默认方向
//        (b) 硬限投递**落账**（走 `runAction` 既有记账 + 日报段）
//        (c) **判据不可用 ⇒ 回落 queue 并记 `exempt-unknown`**；
//     ③ **卡执行会话不进硬限插话名单** —— 复用 `lib/card-session.mjs` 既有判据（唯一源，绝不重写一份）。
//
// 【信号集（N-3 (a) 的答案）】
//   信号 1（硬要求）：**卡执行会话**（账本 `executions[].sessionId`，判据源 = `lib/card-session.mjs`）。
//   信号 2（人工点名）：**豁免名单** `sessions[]` —— 关键时刻（升级/部署/跨机迁移等长序列）由主人或本工具
//     把一个会话加进来，此后它不进硬限插话名单。
//   信号 3（判不出）：上两条任一**不可读 / 形状不认** ⇒ fail-open（**不插话**、回落 `queue`、记
//     `exempt-unknown`）—— 方向刻意选"更保守"：能问不出的，宁可不插话。
//   ⚠️ **未采纳**的候选信号（如实登记）：①「当前 step 是否处于多步不可中断序列」的**自动探测**（无低成本
//     只读观测面：`session.list` 投影不含工具在跑状态，读会话日志对 2 分钟一轮的 tick 太贵）；
//     ② 全局「升级锁 held」（`lib/upgrade-lock.mjs`）—— 与"某会话正在跑危险序列"不是同一件事，
//     且升级期 DSH 常处于重启窗口，收益低于耦合成本。两者都登记在交付报告 §3「未采纳信号」。
//
// 【载体 = `butler-autonomy-limits.json` 的 `ctxGuard.steer`（**零新增状态文件**）】
//   为什么不新建 `butler-steer-gate.json`：`lib/state-files.mjs:6` 的登记义务 ⇒ 新状态文件必须登记
//   ⇒ `sync-ignore.mjs` 生成的仓1 工作副本 `.gitignore` 多一行 ⇒ 制造跨仓派生改动（本卡红线：不推仓、
//   不给他线收工添挡）。而 `butler-autonomy-limits.json` **已登记**（`persistence: persistent` /
//   `sync:false` / `retention: 1 份（主人设定）`），语义正是「主人设定的护栏」⇒ 开关与名单放这里
//   零派生改动。**未配置 = 默认关**（连配置文件都不必动）。
//
// 【判定顺序】（先到先判；每条都带 reason，全部落账可见）
//   ① 载体不可读（limits 读取 fallback / `steer` 字段形状不认）→ fail-open：**不插话** + `exempt-unknown`
//   ② `enabled !== true`（含"未配置"）→ `steer-disabled`（默认关；**不**记 exempt-unknown）
//   ③ 卡执行会话索引不可用（`ok:false`）→ fail-open：**不插话** + `exempt-unknown`
//      ⚠️ 与 `card-session.mjs` 自身的 fail-open 方向**相反**是刻意的：那里是"不排除任何人"（宁多通知），
//        这里问的是"要不要插话"⇒ 问不出就不插话（宁少打扰）。
//   ④ 命中卡执行会话（`isCardSession()`）→ `card-session`
//   ⑤ 命中人工豁免名单 → `manual-exempt`
//   ⑥ 其余 → `ok`（允许 steer）
//
// 【零副作用承诺】本模块**只读**（`readSteerGate` / `assessSteerExempt`）；唯一的写路径
//   `planSteerGateWrite()` 返回计划、由 CLI 显式落盘（默认 dry-run）。模块**永不抛**。
import fs from 'node:fs';
import path from 'node:path';

import { readLimits } from '../../src/dsh-butler/lib/autonomy-actions.mjs';
import { asCardSessionIndex, isCardSession, normCardSessionId } from '../../src/dsh-butler/lib/card-session.mjs';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';

export const STEER_GATE_VERSION = '0.2.0';

/** 载体键路径：`butler-autonomy-limits.json` → `ctxGuard.steer`。 */
export const STEER_LIMITS_KEY = 'ctxGuard';
export const STEER_LIMITS_SUBKEY = 'steer';

/** 默认态（**未配置 = 关**；与交付前的单档 queue 行为逐字节等价）。 */
export const STEER_DEFAULT = Object.freeze({ schemaVersion: 1, enabled: false, sessions: [] });

/** 判定 reason 取值域（预览/记账/日报共用一套字面量）。 */
export const STEER_REASONS = Object.freeze(['ok', 'steer-disabled', 'card-session', 'manual-exempt', 'exempt-unknown']);

/** reason → 人话（只翻译，不改判定）。 */
export const STEER_REASON_TEXT = Object.freeze({
  ok: '允许 steer 插话（step 边界生效，不 abort 进行中的工具）',
  'steer-disabled': '硬限插话开关未开（默认关）→ 回落 queue（与旧行为一致）',
  'card-session': '看板卡执行会话 → 不进硬限插话名单（卡会话一路做完，复用 lib/card-session.mjs 判据）',
  'manual-exempt': '在人工豁免名单里 → 不插话',
  'exempt-unknown': '豁免判据不可用 → fail-open：不插话、回落 queue（记 exempt-unknown）',
});

const note = (reason) => STEER_REASON_TEXT[reason] ?? reason;

/** 空 gate（fail-open 载体：`ok:false` ⇒ 判定恒返 `exempt-unknown`）。 */
export function emptySteerGate(error = 'no-gate', extra = {}) {
  return {
    ok: false,
    error: String(error ?? 'no-gate'),
    enabled: false,
    configured: false,
    sessions: [],
    source: extra.source ?? 'none',
    file: extra.file ?? null,
    note: `fail-open：开关/名单不可读（${String(error ?? 'no-gate')}）⇒ 不插话、回落 queue`,
  };
}

/**
 * 从 `limits` 对象取 gate（**纯函数**，单测入口）。
 * @param {object} limits `readLimits()` 的产物（含 `_source`）
 * @param {{file?:string}} [meta]
 */
export function steerGateOf(limits, meta = {}) {
  const file = meta.file ?? limits?._file ?? null;
  const source = String(limits?._source ?? 'unknown');
  // ① 载体不可读：`readLimits` 的 fallback 分支（文件损坏 / 解析失败）⇒ 判不出
  if (source === 'fallback') {
    return emptySteerGate(`limits 读取失败（_source=fallback）`, { source: 'fallback', file });
  }
  const raw = limits?.[STEER_LIMITS_KEY]?.[STEER_LIMITS_SUBKEY];
  // 未配置 = 默认关（**不是**判不出）：`_source` ∈ {default(文件不存在), file(文件里没这个键)}
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      return emptySteerGate(`limits.${STEER_LIMITS_KEY}.${STEER_LIMITS_SUBKEY} 形状不认（期望对象，实得 ${Array.isArray(raw) ? 'array' : typeof raw}）`,
        { source, file });
    }
    return {
      ok: true, error: null, enabled: false, configured: false, sessions: [],
      source: source === 'file' ? 'file(未配置)' : 'default', file,
      note: '未配置 ⇒ 默认关（硬限仍走 queue，与交付前逐字节等价）',
    };
  }
  if (raw.schemaVersion !== undefined && Number(raw.schemaVersion) !== 1) {
    return emptySteerGate(`schemaVersion 不认（${JSON.stringify(raw.schemaVersion)} ≠ 1）`, { source, file });
  }
  if (raw.sessions !== undefined && !Array.isArray(raw.sessions)) {
    return emptySteerGate(`sessions 形状不认（期望数组，实得 ${typeof raw.sessions}）`, { source, file });
  }
  const sessions = [...new Set((Array.isArray(raw.sessions) ? raw.sessions : [])
    .map((x) => normCardSessionId(x)).filter(Boolean))].sort();
  const enabled = raw.enabled === true;
  return {
    ok: true, error: null, enabled, configured: true, sessions,
    source: 'limits.ctxGuard.steer', file,
    why: raw.why === undefined || raw.why === null ? null : String(raw.why),
    by: raw.by === undefined || raw.by === null ? null : String(raw.by),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : null,
    note: enabled ? '硬限插话已开（仅对非卡会话、不在豁免名单里的会话）' : '硬限插话开关=关 ⇒ 回落 queue',
  };
}

/**
 * 读 gate（**只读**；`limits` 可注入以省一次读盘）。
 * @param {{home?:string, limits?:object}} opts
 */
export function readSteerGate(opts = {}) {
  let limits = opts.limits;
  try {
    if (!limits || typeof limits !== 'object') limits = readLimits({ home: opts.home });
  } catch (e) {
    return emptySteerGate(`readLimits 抛错：${e?.message ?? e}`, { source: 'read-error' });
  }
  try {
    return steerGateOf(limits, { file: limits?._file ?? null });
  } catch (e) {
    return emptySteerGate(`gate 解析抛错：${e?.message ?? e}`, { source: 'parse-error' });
  }
}

/**
 * 硬限插话豁免判定（**纯函数**；N-3 的唯一判据实现）。
 *
 * @param {{sessionId?:string|null, gate?:object, cardSessions?:any}} input
 *        `gate` = {@link readSteerGate} 产物（缺省 / 不可读 ⇒ fail-open）
 *        `cardSessions` = 卡执行会话索引（`lib/card-session.mjs`；缺省 / `ok:false` ⇒ fail-open）
 * @returns {{allow:boolean, reason:string, note:string, detail:string|null, gateOk:boolean, cardIndexOk:boolean}}
 */
export function assessSteerExempt(input = {}) {
  // 「永不抛」的入口护栏：null / 非对象 一律当空输入（判定仍走 fail-open 分支）
  const spec = input && typeof input === 'object' ? input : {};
  const gate = spec.gate && typeof spec.gate === 'object' && 'ok' in spec.gate
    ? spec.gate
    : emptySteerGate('gate-missing');
  const sid = normCardSessionId(spec.sessionId);
  const cardIdx = asCardSessionIndex(spec.cardSessions);
  const base = { allow: false, reason: 'exempt-unknown', note: note('exempt-unknown'), detail: null, gateOk: gate.ok === true, cardIndexOk: cardIdx.ok === true };

  // ① 载体不可读
  if (gate.ok !== true) {
    return { ...base, detail: `开关/名单不可读：${gate.error ?? 'unknown'} ⇒ 记 exempt-unknown（fail-open：不插话）` };
  }
  // ② 默认关（含未配置）
  if (gate.enabled !== true) {
    return { ...base, reason: 'steer-disabled', note: note('steer-disabled'), detail: '开关未开 ⇒ 回落 queue（默认关语义，不记 exempt-unknown）' };
  }
  // ③ 会话 id 缺失 ⇒ 判不出（与"开关关了"不同：这是异常路径，必须留痕）
  if (!sid) {
    return { ...base, detail: '会话 id 缺失 ⇒ 无法判定卡会话/豁免名单 ⇒ 记 exempt-unknown' };
  }
  // ④ 卡执行会话索引不可用 ⇒ 判不出（方向：不插话）
  if (cardIdx.ok !== true) {
    return { ...base, detail: `卡执行会话索引不可用（${cardIdx.error ?? 'unknown'}）⇒ 记 exempt-unknown（无法确认是不是卡会话）` };
  }
  // ⑤ 卡执行会话（**复用既有唯一判据**）
  if (isCardSession(sid, cardIdx)) {
    return { ...base, reason: 'card-session', note: note('card-session'), detail: `卡执行会话（账本命中，卡 ${cardIdx.bySession.get(sid)?.cardId ?? '?'}）⇒ 不进硬限插话名单` };
  }
  // ⑥ 人工豁免名单
  if ((gate.sessions ?? []).includes(sid)) {
    return { ...base, reason: 'manual-exempt', note: note('manual-exempt'), detail: '命中 limits.ctxGuard.steer.sessions 人工豁免名单' };
  }
  // ⑦ 放行
  return { allow: true, reason: 'ok', note: note('ok'), detail: null, gateOk: true, cardIndexOk: true };
}

/**
 * 写计划的**纯函数**部分（CLI 落盘前先算 before/after；默认 dry-run）。
 * @param {{limits?:object, enabled?:boolean, sessions?:string[], why?:string, by?:string, now?:number}} input
 */
export function planSteerGateWrite(input = {}) {
  const limits = input.limits ?? {};
  const before = steerGateOf(limits, { file: limits?._file ?? null });
  const prevRaw = limits?.[STEER_LIMITS_KEY]?.[STEER_LIMITS_SUBKEY];
  const prevSessions = Array.isArray(prevRaw?.sessions) ? prevRaw.sessions : [];
  const enabled = input.enabled === undefined ? (prevRaw?.enabled === true) : input.enabled === true;
  const sessions = input.sessions === undefined
    ? [...new Set(prevSessions.map((x) => normCardSessionId(x)).filter(Boolean))].sort()
    : [...new Set((input.sessions ?? []).map((x) => normCardSessionId(x)).filter(Boolean))].sort();
  const now = Number(input.now ?? Date.now());
  const next = {
    schemaVersion: 1,
    enabled,
    sessions,
    updatedAt: now,
    by: input.by !== undefined ? String(input.by) : 'butler-ctx-guard CLI',
    why: input.why !== undefined ? String(input.why) : (prevRaw?.why ?? undefined),
  };
  // 只保留有值的可选键（`undefined` 不进 JSON）
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const same = JSON.stringify({ enabled: prevRaw?.enabled === true, sessions: prevSessions.map((x) => normCardSessionId(x)).filter(Boolean).sort() })
    === JSON.stringify({ enabled: next.enabled, sessions: next.sessions });
  return { before, after: next, changed: !same, idempotent: same };
}

/**
 * 落盘（**只在 CLI `--apply` 路径调用**；默认 dry-run 不落）。
 * 用 `updateJson`（带锁 + 原子写 + schemaVersion 校验），只改 `ctxGuard.steer` 一个键。
 * @param {{home?:string, file?:string, enabled?:boolean, sessions?:string[], why?:string, by?:string, now?:number}} opts
 */
export async function applySteerGateWrite(opts = {}) {
  const { updateStateJson } = await import('../../src/dsh-butler/lib/dual-write-store.mjs');
  const { limitsPath, LIMITS_FILE } = await import('../../src/dsh-butler/lib/autonomy-actions.mjs');
  const file = opts.file ?? limitsPath({ home: opts.home });
  const limits = readLimits({ home: opts.home });
  const plan = planSteerGateWrite({ limits, enabled: opts.enabled, sessions: opts.sessions, why: opts.why, by: opts.by, now: opts.now });
  if (plan.idempotent) return { ok: true, changed: false, file, ...plan };
  let written = false;
  updateStateJson(LIMITS_FILE, file, (cur) => {
    const base = cur && typeof cur === 'object' ? cur : {};
    const parent = base[STEER_LIMITS_KEY] && typeof base[STEER_LIMITS_KEY] === 'object' ? base[STEER_LIMITS_KEY] : {};
    written = true;
    return { ...base, schemaVersion: base.schemaVersion ?? 1, [STEER_LIMITS_KEY]: { ...parent, [STEER_LIMITS_SUBKEY]: plan.after } };
  }, { schemaVersion: 1, home: opts.home, audit: false });
  // 写后回读（不信自己写的）
  const rt = readSteerGate({ home: opts.home, limits: readLimits({ home: opts.home }) });
  const ok = rt.ok === true && rt.enabled === plan.after.enabled
    && JSON.stringify(rt.sessions ?? []) === JSON.stringify(plan.after.sessions ?? []);
  return { ok, changed: true, file, ...plan, afterRead: { ok: rt.ok, enabled: rt.enabled, sessions: rt.sessions } };
}

/** 人读行（CLI `--steer-status` / 日报段）。 */
export function steerGateLines(gate) {
  const g = gate ?? emptySteerGate('no-gate');
  const L = [];
  L.push(`🔔 硬限插话（steer）开关：${g.ok !== true ? '❔ 判据不可用（fail-open：不插话）'
    : (g.enabled ? '✅ 已开' : '⛔ 关（默认）')}`);
  L.push(`   载体：\`${g.file ?? '?'}\` · \`${STEER_LIMITS_KEY}.${STEER_LIMITS_SUBKEY}\` · 来源 ${g.source ?? '?'}`);
  if (g.ok !== true) L.push(`   ⚠️ ${g.error ?? 'unknown'} —— 判定恒返 \`exempt-unknown\`（回落 queue）`);
  if (Array.isArray(g.sessions) && g.sessions.length) L.push(`   人工豁免名单（${g.sessions.length}）：${g.sessions.join(', ')}`);
  if (g.ok === true && !g.configured) L.push(`   说明：${g.note ?? ''}`);
  return L;
}

/** 文件是否存在（只读旁证；CLI / 单测用）。 */
export function steerGateFileExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

// ---------------------------------------------------------------- 落账读取（日报段唯一渲染源）

/** 落账里"与非默认通道有关"的 reason（`steer-disabled` 不入流水：默认关不产生记录）。 */
export const STEER_LEDGER_REASONS = Object.freeze(['card-session', 'manual-exempt', 'exempt-unknown']);

/**
 * 从 `butler-auto-actions.json` 的 `lastResults` 里提炼"硬限插话"流水（**只读**；N-3 (b)）。
 *
 * 为什么读这个文件：`runAction` 是**唯一**闸门与唯一记账点（`lastResults[].detail = {result, preview, revertHint}`）
 *   ⇒ 硬限投递的通道信息天然落在那里，**零新增状态文件**（无需动 state-files / .gitignore / 仓1）。
 * 只保留"值得人看"的行：`delivery === 'steer'`（真插话）或 reason ∈
 *   {`card-session`, `manual-exempt`, `exempt-unknown`}（豁免/回落）；**默认关时不产生任何行**。
 *
 * @param {{home?:string, file?:string, now?:number, windowMs?:number, kind?:string}} opts
 * @returns {{ok:boolean, file:string, error:string|null, windowMs:number, rows:Array, steer:number, fallback:number}}
 */
export function collectSteerDeliveries(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.file ?? resolveStatePath('butler-auto-actions.json', { home }).path;
  const now = Number(opts.now ?? Date.now());
  const windowMs = Number(opts.windowMs ?? 24 * 3600 * 1000);
  const kind = opts.kind ?? 'ctx-guard';
  const empty = { ok: false, file, error: null, windowMs, rows: [], steer: 0, fallback: 0 };
  let ledger = null;
  try {
    ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ...empty, error: e?.code ?? (e?.message ?? String(e)) };
  }
  const rows = [];
  for (const rec of Array.isArray(ledger?.lastResults) ? ledger.lastResults : []) {
    if (String(rec?.kind ?? '') !== kind) continue;
    const at = Number(rec?.at ?? 0);
    if (windowMs > 0 && (!(at > 0) || now - at > windowMs)) continue;
    const d = rec?.detail && typeof rec.detail === 'object' ? rec.detail : {};
    const preview = d.preview && typeof d.preview === 'object' ? d.preview : null;
    const result = d.result && typeof d.result === 'object' ? d.result : null;
    const delivery = preview?.delivery ?? result?.delivery ?? null;
    const steerReason = preview?.steerReason ?? result?.steerReason ?? null;
    const interesting = delivery === 'steer' || (steerReason !== null && STEER_LEDGER_REASONS.includes(steerReason));
    if (!interesting) continue;
    rows.push({
      at,
      sessionId: preview?.sessionId ?? result?.sessionId ?? null,
      level: preview?.level ?? result?.level ?? null,
      delivery: delivery ?? 'queue',
      steerReason,
      status: rec?.status ?? null,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return {
    ok: true, file, error: null, windowMs, rows,
    steer: rows.filter((r) => r.delivery === 'steer').length,
    fallback: rows.filter((r) => r.delivery !== 'steer').length,
  };
}

/**
 * 日报段文本（**只在有流水时返回非空**；默认关 / 无事件 ⇒ `[]` ⇒ 日报里本段不存在）。
 * 判定与文案在这一处，日报只渲染（家规：日报不复制判定）。
 */
export function steerDeliverySectionLines(state, opts = {}) {
  const s = state ?? {};
  const rows = Array.isArray(s.rows) ? s.rows : [];
  if (s.ok !== true || rows.length === 0) return [];
  const max = Number(opts.maxRows ?? 8);
  const hhmm = (t) => {
    const d = new Date(Number(t) || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const L = [];
  L.push('## 🔔 上下文看门投递（steer 插话）');
  L.push('');
  L.push(`> 只在"硬限插话"真的发生过（或豁免判定记了回落原因）时出现（近 ${Math.round((s.windowMs ?? 0) / 3600_000)}h：`
    + `steer ${s.steer ?? 0} · 回落 queue ${s.fallback ?? 0}）。默认关时本段不存在。`);
  L.push(`> 台账源：\`${s.file}\`（只读；判定与文案 = \`lib/steer-gate.mjs\`）。`);
  for (const r of rows.slice(0, max)) {
    const tag = r.delivery === 'steer' ? '**steer 插话**' : `回落 queue（${r.steerReason ?? 'unknown'}）`;
    L.push(`- ${hhmm(r.at)} · \`${r.sessionId ?? '?'}\` · ${r.level ?? '?'} · ${tag}${r.status ? ` · ${r.status}` : ''}`);
  }
  if (rows.length > max) L.push(`- …另有 ${rows.length - max} 条（本段最多列 ${max} 条）`);
  return L;
}
