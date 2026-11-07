// dsh-butler / lib/authorize-compose.mjs —— 授权合成 `min(对象 S 档, actor 矩阵, 动作 L 级)`
//
// 真源口径 = v2 方案 §3.5.6 / §3.5.7「自治光谱 S0–S5」+ 域档 `I-v2宪法与产品层.md` idx 5
//   原话：「授权合成 min(对象S档, actor矩阵, 动作L级)｜取最保守者胜，先拒后降级」。
//
// 【为什么存在（缺口原话）】主档 A 域 L154：三元里 **actor 矩阵 + 动作 L 级** 两元已落地
//   （`lib/manual-actions.mjs`：`ACTORS` 白名单 + L1/L2/L3），**第一元「对象 S 档」缺位** ——
//   `lib/monitor-registry.mjs` 只把 S 档落成 CI 的 `sTier` **数据列**（该模块头注自陈「不属本模块」），
//   全库无「对象 S 档」判定函数 ⇒ 三项合成缺一项。本模块 = 那第一元 + 合成器（**唯一真源**）。
//
// 【轴统一 —— 本模块最要紧的一句话】三元统一换算到同一条「**允许的自治档**」轴上（0..5，越大越自主）：
//   · 对象 S 档  → 该对象**允许的最大**自治档（实体列 `butler-monitor-registry.json#cis[].sTier`）；
//   · actor 矩阵 → 该 actor **允许的最大**自治档（对齐 `lib/manual-actions.mjs` 的 `ACTORS` 语义）；
//   · 动作 L 级  → 该动作**要求的**自治档（方案 §3.5.6 明文映射：L1→S2 / L2→S3 / L3→S4）。
//   合成 = 前两者取小 `cap = min(对象, actor)`（**取最保守者胜**），再拿 cap 与动作门槛比：
//     · `cap >= required` ⇒ **放行**，且放行档 = **门槛本身**（不放大到 cap —— 仍是"最保守者胜"）；
//     · `cap <  required` ⇒ **先拒**；只有调用方**显式**给 `onDeny:'degrade'` 才降到 cap 撑得住的最高动作级（降级）。
//
// 【fail-closed】对象查不到（未登记 / 注册表缺失 / `sTier` 非法）⇒ 一律回落 **S0**（全人工），
//   且 `basis` 逐字写明来源（不许用"大概 S3"糊过去）。`sTier` 是**声明**，注册表缺失 ≠ 默认放开。
//
// 【边界】本模块**只读 + 纯函数**：不写任何文件、不改任何开关、不 spawn。消费点（tickd 侧自检）
//   只把结果写进 `%TEMP%\dsh-butler-tickd\state.json`（非 `~/.dsh` 状态文件面 ⇒ 不进 state-files 登记）。
import { dshHome } from './paths.mjs';
import { readRegistry } from './monitor-registry.mjs';

export const AUTHORIZE_COMPOSE_VERSION = '0.1.0';

/**
 * 自治光谱 S0–S5（方案 §3.5.6）。`value` 越大 = 越自主（人干预越少）；
 * 合成一律走 `value`，字符串档位只在接口层出现（便于人读）。
 */
export const S_TIERS = Object.freeze({
  S0: Object.freeze({ value: 0, label: '全人工', note: '只读陈列；任何写动作都须操作者/面板显式发起' }),
  S1: Object.freeze({ value: 1, label: '只告警', note: '可自动发现并告警，不得自行动手' }),
  S2: Object.freeze({ value: 2, label: '可预览级自动', note: '方案 §3.5.6 映射：L1 动作（可回滚、低风险）所需档' }),
  S3: Object.freeze({ value: 3, label: '可常规自动', note: '方案 §3.5.6 映射：L2 动作所需档' }),
  S4: Object.freeze({ value: 4, label: '可涉意图自动', note: '方案 §3.5.6 映射：L3 动作（涉意图 / 难撤销）所需档' }),
  S5: Object.freeze({ value: 5, label: '全自动', note: '无人值守自主闭环（本版无对象上到此档）' }),
});

/** 档位名 → 数值（非法规格一律 null，由调用方 fail-closed）。 */
export function sTierValue(tier) {
  const t = String(tier ?? '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(S_TIERS, t) ? S_TIERS[t].value : null;
}

/** 数值 → 档位名（用于回写人读结果）。 */
export function sTierName(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const hit = Object.entries(S_TIERS).find(([, d]) => d.value === v);
  return hit ? hit[0] : null;
}

/**
 * 动作 L 级 → 该动作**要求**的自治档（方案 §3.5.6 明文映射，**不是**拍脑袋）。
 * 与 `lib/manual-actions.mjs` 的 `level` 字段同域（L1/L2/L3）。
 */
export const ACTION_L_TIER = Object.freeze({ L1: 2, L2: 3, L3: 4 });

/**
 * actor 矩阵 → 该 actor **允许的最大**自治档。
 * 对齐 `lib/manual-actions.mjs` 现有语义（本表只做"同一件事的数值化"，不改任何既有闸门）：
 *   · `owner-panel`    = 面板按钮（操作者亲自点）⇒ 不设上限（S5）；
 *   · `main-session`   = 主线会话 ⇒ 方案里最高到"涉意图"（S4）；
 *   · `scheduled-task` = 计划任务 ⇒ 常规自动（S3，对 L2）；
 *   · `subagent`       = 子代理 ⇒ manual-actions 明文「只能调 L1」⇒ 上限 S2。
 */
export const ACTOR_CEILING = Object.freeze({
  'owner-panel': 5,
  'main-session': 4,
  'scheduled-task': 3,
  subagent: 2,
});

/** 合法 actor（与 `lib/manual-actions.mjs#ACTORS` 同名单；此处是**只读副本**，用于合成取值）。 */
export const COMPOSE_ACTORS = Object.freeze(Object.keys(ACTOR_CEILING));

/** 合法动作级。 */
export const COMPOSE_ACTION_LEVELS = Object.freeze(Object.keys(ACTION_L_TIER));

/** 规范化名（与 monitor-registry 同款：小写 + 去空白/下划线）。 */
function norm(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[\s_]+/g, '');
}

/**
 * 【第一元】**对象 S 档判定函数**。
 *
 * @param {string|object} subject CI id / 别名 / 规范化名 / 直接给 `{id, sTier}` 或 `{sTier}` 的对象
 * @param {{home?:string, file?:string, doc?:object}} [opts] `doc` 显式注入时**不读盘**（单测/夹具用）
 * @returns {{ok:boolean, found:boolean, id:string|null, sTier:string, value:number,
 *            basis:string, why:string, registryFile:string|null, registryOk:boolean|null}}
 */
export function judgeObjectSTier(subject, opts = {}) {
  // ① 调用方直接给了 sTier（最直接：CI 行本身）
  if (subject && typeof subject === 'object' && subject.sTier !== undefined) {
    const v = sTierValue(subject.sTier);
    if (v !== null) {
      return {
        ok: true, found: true, id: subject.id ?? null, sTier: String(subject.sTier).toUpperCase(), value: v,
        basis: 'ci-object', why: `对象自带 sTier 列（${subject.sTier}）⇒ 与注册表同源`,
        registryFile: null, registryOk: null,
      };
    }
    return {
      ok: true, found: true, id: subject.id ?? null, sTier: 'S0', value: 0,
      basis: 'ci-object-illegal-tier', why: `对象自带 sTier 非法（${JSON.stringify(subject.sTier)}）⇒ fail-closed 回落 S0`,
      registryFile: null, registryOk: null,
    };
  }

  // ② 从注册表读（显式 doc 优先；否则现读盘）
  let doc = opts.doc ?? null;
  let registryFile = null;
  let registryOk = null;
  if (!doc) {
    const read = readRegistry({ home: opts.home ?? dshHome(), file: opts.file });
    registryFile = read.file ?? null;
    registryOk = read.ok === true;
    if (read.ok) doc = read.data;
  } else {
    registryOk = true;
  }

  if (!doc) {
    return {
      ok: false, found: false, id: null, sTier: 'S0', value: 0,
      basis: 'registry-unavailable-fail-closed',
      why: `注册表不可读（${registryFile ?? '?'}）⇒ **读不到就按最保守**：对象档回落 S0（全人工）`,
      registryFile, registryOk,
    };
  }

  const want = norm(typeof subject === 'string' ? subject : subject?.id);
  const cis = Array.isArray(doc.cis) ? doc.cis : [];
  const hit = cis.find((c) => norm(c.id) === want)
    ?? cis.find((c) => (c.aliases ?? []).some((a) => norm(a) === want))
    ?? cis.find((c) => norm(String(c.id).replace(/^(res|exp|risk)-/, '').replace(/-[^-]+$/, '')) === want);
  if (!hit) {
    return {
      ok: false, found: false, id: null, sTier: 'S0', value: 0,
      basis: 'object-unregistered-fail-closed',
      why: `注册表里没有对象「${typeof subject === 'string' ? subject : subject?.id ?? '?'}」（候选集 ${cis.length} 条）⇒ 未登记一律按最保守 S0`,
      registryFile, registryOk,
    };
  }
  const v = sTierValue(hit.sTier);
  if (v === null) {
    return {
      ok: false, found: true, id: hit.id, sTier: 'S0', value: 0,
      basis: 'registered-tier-illegal-fail-closed',
      why: `对象 ${hit.id} 已登记但 sTier 非法（${JSON.stringify(hit.sTier)}）⇒ fail-closed 回落 S0`,
      registryFile, registryOk,
    };
  }
  return {
    ok: true, found: true, id: hit.id, sTier: String(hit.sTier).toUpperCase(), value: v,
    basis: 'registry',
    why: `对象 ${hit.id} 的 sTier = ${hit.sTier}（注册表 ${registryFile ?? opts.file ?? '?le'} 现读）`,
    registryFile, registryOk,
  };
}

/**
 * 【合成器】`min(对象 S 档, actor 矩阵, 动作 L 级)` —— 取最保守者胜、先拒后降级。
 *
 * @param {{subject:string|object, actor:string, actionL:string, onDeny?:'reject'|'degrade'}} req
 * @param {{home?:string, file?:string, doc?:object}} [opts]
 * @returns {{allowed:boolean, action:'allow'|'reject'|'degrade', effectiveTier:string|null,
 *            effectiveValue:number|null, requiredTier:string|null, capTier:string|null, capValue:number|null,
 *            winner:'object'|'actor'|'actionL', parts:object, reason:string, object:object}}
 */
export function composeAuthorization(req = {}, opts = {}) {
  const obj = judgeObjectSTier(req.subject, opts);
  const actor = String(req.actor ?? '');
  const actionL = String(req.actionL ?? '').toUpperCase();
  const onDeny = req.onDeny === 'degrade' ? 'degrade' : 'reject';

  const actorCeil = Object.prototype.hasOwnProperty.call(ACTOR_CEILING, actor) ? ACTOR_CEILING[actor] : null;
  const required = Object.prototype.hasOwnProperty.call(ACTION_L_TIER, actionL) ? ACTION_L_TIER[actionL] : null;

  const parts = {
    object: { sTier: obj.sTier, value: obj.value, basis: obj.basis, why: obj.why },
    actor: { name: actor, ceilingTier: actorCeil === null ? null : sTierName(actorCeil), ceilingValue: actorCeil },
    actionL: { level: actionL, requiredTier: required === null ? null : sTierName(required), requiredValue: required },
  };

  if (actorCeil === null) {
    return {
      allowed: false, action: 'reject', effectiveTier: null, effectiveValue: null,
      requiredTier: required === null ? null : sTierName(required), capTier: null, capValue: null,
      winner: 'actor', parts, object: obj,
      reason: `未知/缺 actor（${JSON.stringify(req.actor)}）⇒ **一律拒**（与 lib/manual-actions.mjs 同款 fail-closed；合法 = ${COMPOSE_ACTORS.join(' / ')}）`,
    };
  }
  if (required === null) {
    return {
      allowed: false, action: 'reject', effectiveTier: null, effectiveValue: null,
      requiredTier: null, capTier: null, capValue: null,
      winner: 'actionL', parts, object: obj,
      reason: `未知动作级（${JSON.stringify(req.actionL)}）⇒ **一律拒**（合法 = ${COMPOSE_ACTION_LEVELS.join(' / ')}）`,
    };
  }

  const capValue = Math.min(obj.value, actorCeil);
  const capTier = sTierName(capValue);
  const winner = obj.value <= actorCeil ? 'object' : 'actor';

  if (capValue >= required) {
    return {
      allowed: true, action: 'allow', effectiveTier: sTierName(required), effectiveValue: required,
      requiredTier: sTierName(required), capTier, capValue, winner, parts, object: obj,
      reason: `${actionL} 动作要求 ${sTierName(required)}；cap = min(对象 ${obj.sTier}, actor ${sTierName(actorCeil)}) = ${capTier} ≥ ${sTierName(required)} ⇒ **放行**（放行档取门槛本身 = 最保守者胜）`,
    };
  }

  if (onDeny === 'degrade') {
    // 降级：降到 cap 撑得住的**最高**动作级（≤ cap 的最大 required）
    const fit = Object.entries(ACTION_L_TIER)
      .filter(([, v]) => v <= capValue)
      .sort((a, b) => b[1] - a[1])[0] ?? null;
    return {
      allowed: fit !== null, action: 'degrade',
      effectiveTier: capTier, effectiveValue: capValue,
      requiredTier: sTierName(required), capTier, capValue, winner, parts, object: obj,
      degradeTo: fit ? fit[0] : null,
      reason: fit
        ? `cap ${capTier} < ${actionL} 要求的 ${sTierName(required)} ⇒ **降级**到 ${fit[0]}（cap 撑得住的最高动作级），不放行原动作`
        : `cap ${capTier} < ${actionL} 要求的 ${sTierName(required)}，且 cap 连 L1（S2）都不够 ⇒ 降无可降 ⇒ **拒**`,
    };
  }

  return {
    allowed: false, action: 'reject', effectiveTier: null, effectiveValue: null,
    requiredTier: sTierName(required), capTier, capValue, winner, parts, object: obj,
    reason: `cap = min(对象 ${obj.sTier}, actor ${sTierName(actorCeil)}) = ${capTier} < ${actionL} 要求的 ${sTierName(required)} ⇒ **先拒**（要降级须显式 onDeny:'degrade'）；压住额度的是 ${winner === 'object' ? '对象 S 档' : 'actor 矩阵'}`,
  };
}

/**
 * 只读自检：拿**注册表全部 CI** 跑一遍合成（默认 actor = scheduled-task、动作 = L1），
 * 出「合成器在现行注册表上是否自洽」的读数；供 tickd 侧周期落 `state.authorizeAudit`。
 *
 * @param {{home?:string, file?:string, doc?:object, actor?:string, actionL?:string, now?:number}} [opts]
 */
export function authorizeSelfCheck(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const actor = opts.actor ?? 'scheduled-task';
  const actionL = opts.actionL ?? 'L1';
  const read = opts.doc ? { ok: true, file: opts.file ?? null, data: opts.doc } : readRegistry({ home: opts.home ?? dshHome(), file: opts.file });
  const cis = Array.isArray(read.data?.cis) ? read.data.cis : [];
  const rows = [];
  let allowed = 0; let denied = 0; let failClosed = 0;
  let tiersLegal = 0;
  for (const ci of cis) {
    const r = composeAuthorization({ subject: ci, actor, actionL }, opts);
    if (r.allowed) allowed += 1; else denied += 1;
    if (r.parts.object.basis !== 'ci-object') failClosed += 1;
    if (sTierValue(ci.sTier) !== null) tiersLegal += 1;
    rows.push({ id: ci.id, sTier: ci.sTier, allowed: r.allowed, action: r.action, cap: r.capTier, reason: r.reason });
  }
  return {
    at: new Date(now).toISOString(),
    source: 'tools/dsh-butler/lib/authorize-compose.mjs',
    version: AUTHORIZE_COMPOSE_VERSION,
    registry: { ok: read.ok === true, file: read.file ?? null },
    probe: { actor, actionL },
    counts: { cis: cis.length, tiersLegal, failClosed, allowed, denied },
    rows,
    // 注册表读不到 ⇒ 明确判"不可用"，**不许判绿**（与 registry-audit 同款纪律）
    ok: read.ok === true && cis.length > 0 && tiersLegal === cis.length,
    problems: [
      ...(read.ok !== true ? [`注册表不可读：${read.error ?? read.file ?? '?'}`] : []),
      ...(cis.length === 0 && read.ok === true ? ['注册表里 0 条 CI ⇒ 第一元无判定对象'] : []),
      ...cis.filter((c) => sTierValue(c.sTier) === null).map((c) => `CI ${c.id} 的 sTier 非法：${JSON.stringify(c.sTier)}`),
    ],
  };
}

// ---------------------------------------------------------------- 自检（--self-check）
if (process.argv.includes('--self-check')) {
  const t = (name, cond, extra = '') => console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` · ${extra}` : ''}`);
  t('S5 值最大 / S0 值最小', sTierValue('S5') === 5 && sTierValue('S0') === 0);
  t('非法档位回落 null', sTierValue('S9') === null && sTierValue(undefined) === null);
  t('动作 L 映射 = 方案 §3.5.6', ACTION_L_TIER.L1 === 2 && ACTION_L_TIER.L2 === 3 && ACTION_L_TIER.L3 === 4);
  const doc = { cis: [{ id: 'exp-a-host', aliases: ['A'], sTier: 'S1' }, { id: 'exp-b-host', sTier: 'S5' }] };
  t('对象 S 档判定（注册表）', judgeObjectSTier('exp-b-host', { doc }).value === 5);
  t('未登记对象 ⇒ fail-closed S0', judgeObjectSTier('nope', { doc }).value === 0 && judgeObjectSTier('nope', { doc }).ok === false);
  const r1 = composeAuthorization({ subject: { sTier: 'S1' }, actor: 'main-session', actionL: 'L2' }, { doc });
  t('min 取最保守（对象压住）', r1.allowed === false && r1.capTier === 'S1' && r1.winner === 'object');
  const r2 = composeAuthorization({ subject: { sTier: 'S5' }, actor: 'subagent', actionL: 'L2' }, { doc });
  t('min 取最保守（actor 压住）', r2.allowed === false && r2.capTier === 'S2' && r2.winner === 'actor');
  const r3 = composeAuthorization({ subject: { sTier: 'S3' }, actor: 'scheduled-task', actionL: 'L2' }, { doc });
  t('cap ≥ 门槛 ⇒ 放行且取门槛', r3.allowed === true && r3.effectiveTier === 'S3');
  const r4 = composeAuthorization({ subject: { sTier: 'S1' }, actor: 'main-session', actionL: 'L2', onDeny: 'degrade' }, { doc });
  t('显式降级才降级', r4.action === 'degrade' && r4.allowed === false && r4.degradeTo === null);
  const r5 = composeAuthorization({ subject: { sTier: 'S3' }, actor: 'main-session', actionL: 'L3', onDeny: 'degrade' }, { doc });
  t('降级到 cap 撑得住的最高级', r5.action === 'degrade' && r5.degradeTo === 'L2');
  t('缺 actor 一律拒', composeAuthorization({ subject: { sTier: 'S5' }, actor: '', actionL: 'L1' }, { doc }).allowed === false);
}
