// dsh-butler / lib/queue-bindings.mjs —— 卡 ↔ 发起会话 绑定表（P3 叫醒目标绑定 · A 段）
//
// 问题（方案 docs/ §1）：P3 叫醒目标靠**猜标题**（「标题以【运行】开头且恰好 1 个」），
//   实测两个失效模式：① 档位停在 observe 无人发现；② 目标不唯一（2026-09-14 15:37 实测 5 个【运行】）→ 一次都没发。
//   根因：**通知目标 ≠ 语义归属** —— run 卡时没人记录"谁发起的"，只能回头猜标题。
//   对照：重启统筹之所以准，是因为请求本身带身份（`lib\restart.mjs` 的 `requesterIds`）。
//
// 本模块 = 那张缺失的**数据**（不是投递 —— 投递复用 lib/watch-notify.mjs，与重启统筹同源）。
//
// 【两条铁律（改本文件前必读）】
//   ① **fail-safe 方向 = 无绑定**：读不到 / 坏文件 / 版本不符 / 半截 JSON → 一律当作"无绑定"，
//      **绝不因此误发**（判定侧降级到标题判据；标题判据再多目标就 escalate，宁可不发）。
//   ② **不许猜**：没有会话身份的登记（cron / 面板 / 未知）必须**显式** `source:'cron'` 且
//      `initiatorSessionId:null`，由调用方写清，本模块不替谁补一个"看起来像"的会话 id。
//
// 载体：`~/.dsh/queue-bindings.json`（**单机事实**，sync:false —— 会话 id 只在本机有意义；
//   卡随账本跨机同步 → 对端必然"无绑定"是设计而非缺陷，见方案 §4）。
//
// 两级绑定（方案 §2.1）：
//   卡级   cards[cardId] = { initiatorSessionId, boundAt, source, title, seq, line, previousInitiator }
//   主线级 lines[line]   = { ownerSessionId,      boundAt, source, previousOwner }
//
// 读写一律走 lib/store.mjs（原子写 + RMW 锁），禁止自写目标文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dshHome } from './paths.mjs';
import { readJson, updateJson, acquireRmwLock, writeJsonAtomic } from './store.mjs';

export const BINDINGS_VERSION = '0.1.0';
export const BINDINGS_SCHEMA = 1;
export const BINDINGS_NAME = 'queue-bindings.json';
/** 合法来源：manual（the operator/主人手登记）· panel（面板）· cron（无会话身份的调度，**显式声明无主**）。 */
export const BINDING_SOURCES = ['manual', 'panel', 'cron'];
/** 表规模上限（超出按 boundAt 淘汰最旧；防无限增长）。 */
export const MAX_CARDS = 500;
export const MAX_LINES = 200;
/** 变更审计保留条数（方案 §6 默认项：台账保留最近 50 条变更）。 */
export const MAX_AUDIT = 50;

/** 标准卡 id 形状（账本里的完整 UUID）。**写入侧 / 判定侧共用这一份判据**，别各写一套正则。
 *  背景（2026-10-29 事故）：`bindCard` 曾把 `--card` 的原始字符串直接当键（`e3cf23b2`、`mainline`、`auto`），
 *  而消费侧（P0 / queue-watch / card-watchdog / queue-wake）一律用完整 UUID 查 ⇒ 同一张卡长出两把钥匙。 */
export const CARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 是不是完整 UUID（大小写不敏感；账本侧是小写）。 */
export function isStandardCardId(v) {
  return CARD_ID_RE.test(String(v ?? '').trim());
}

/** 非标准键的警告文案（不阻断，只提示）。 */
export function nonStandardCardIdWarning(id) {
  return `⚠️ 非标准卡 id（${String(id ?? '').trim()}），建议用完整 UUID（否则 P0/queue-watch 查不到）`;
}

export function hostName() {
  try { return os.hostname(); } catch { return process.env.COMPUTERNAME ?? 'unknown'; }
}

export function bindingsPath(home = dshHome()) {
  return path.join(home, BINDINGS_NAME);
}

/** 空表（缺失/损坏时的统一形状 —— 判定侧拿到的永远是"无绑定"）。 */
export function emptyBindings(opts = {}) {
  const file = opts.file ?? bindingsPath(opts.home ?? dshHome());
  return {
    schemaVersion: BINDINGS_SCHEMA,
    device: hostName(),
    updatedAt: null,
    cards: {},
    lines: {},
    audit: [],
    file,
    exists: false,
    corrupt: false,
    error: null,
  };
}

/**
 * 读绑定表（**fail-safe：任何异常都退化为空表**）。
 * @returns {{schemaVersion:number, device:string|null, updatedAt:string|null, cards:object, lines:object,
 *            audit:Array, file:string, exists:boolean, corrupt:boolean, error:string|null}}
 */
export function loadBindings(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.file ?? bindingsPath(home);
  const base = emptyBindings({ home, file });
  let raw;
  try {
    if (!fs.existsSync(file)) return base;
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ...base, exists: true, corrupt: true, error: `读取失败：${e?.message ?? e}` };
  }
  if (!raw.trim()) return { ...base, exists: true };        // 0 字节 = 尚无状态（非损坏）
  let data = null;
  try {
    data = readJson(file, { schemaVersion: BINDINGS_SCHEMA, home, defaultValue: null });
  } catch (e) {
    return { ...base, exists: true, corrupt: true, error: `${e?.name ?? 'Error'}：${e?.message ?? e}` };
  }
  if (!data || typeof data !== 'object') return { ...base, exists: true, corrupt: true, error: '内容不是对象' };
  const onlyObj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return {
    schemaVersion: BINDINGS_SCHEMA,
    device: data.device ?? null,
    updatedAt: data.updatedAt ?? null,
    cards: onlyObj(data.cards),
    lines: onlyObj(data.lines),
    audit: Array.isArray(data.audit) ? data.audit : [],
    file,
    exists: true,
    corrupt: false,
    error: null,
  };
}

/** 归一 + 裁剪（写盘前统一收口；audit 最新在前）。 */
export function normalizeBindings(data, opts = {}) {
  const now = opts.now ?? Date.now();
  const onlyObj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const cards = onlyObj(data?.cards);
  const lines = onlyObj(data?.lines);
  const trimBy = (obj, max) => {
    const ent = Object.entries(obj);
    if (ent.length <= max) return obj;
    return Object.fromEntries(ent.sort((a, b) => Number(a[1]?.boundAt ?? 0) - Number(b[1]?.boundAt ?? 0)).slice(-max));
  };
  return {
    schemaVersion: BINDINGS_SCHEMA,
    device: data?.device ?? hostName(),
    updatedAt: new Date(now).toISOString(),
    cards: trimBy(cards, MAX_CARDS),
    lines: trimBy(lines, MAX_LINES),
    audit: (Array.isArray(data?.audit) ? data.audit : []).slice(0, MAX_AUDIT),
  };
}

/** 原子写（RMW；禁止直写目标）。dryRun → 只回报将要写到哪。
 *  ⚠️ `force`：绑定表损坏/schema 不符时 `updateJson` 的读侧会抛（这正是它防脏写的作用）——
 *  只有调用方显式 `--force` 时才允许绕过读校验覆盖：仍走 RMW 锁 + 原子写，不退化为裸写。 */
export function saveBindings(data, opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.file ?? bindingsPath(home);
  const now = opts.now ?? Date.now();
  const next = normalizeBindings(data, { now });
  if (opts.dryRun) return { ok: true, file, dryRun: true, data: next };
  if (opts.force === true) {
    let lock = null;
    try {
      lock = acquireRmwLock(file, { home, ttlMs: opts.lockTtlMs ?? 10_000, waitMs: opts.lockWaitMs ?? 5000 });
      writeJsonAtomic(file, next, {});
    } catch (e) {
      return { ok: false, file, error: e?.message ?? String(e) };
    } finally {
      try { lock?.release(); } catch { /* ignore */ }
    }
    return { ok: true, file, data: next, forced: true };
  }
  try {
    updateJson(file, () => next, { schemaVersion: BINDINGS_SCHEMA, home, defaultValue: next, lockWaitMs: opts.lockWaitMs ?? 5000 });
  } catch (e) {
    return { ok: false, file, error: e?.message ?? String(e) };
  }
  return { ok: true, file, data: next };
}

function normSource(source) {
  const s = String(source ?? 'manual').trim().toLowerCase();
  return BINDING_SOURCES.includes(s) ? s : null;
}

function pushAudit(bindings, record) {
  const audit = Array.isArray(bindings.audit) ? bindings.audit : [];
  return [record, ...audit].slice(0, MAX_AUDIT);
}

/**
 * 登记卡级绑定（幂等键 = cardId；重复登记 = 覆盖，并记 `previousInitiator`）。
 *
 * @param {string} cardId
 * @param {string|null} initiatorSessionId 发起会话；`null` 仅允许配 `source:'cron'`（显式无主）
 * @param {{source?:'manual'|'panel'|'cron', home?:string, now?:number, actor?:string, title?:string|null,
 *          seq?:string|null, line?:string|null, note?:string|null, force?:boolean, dryRun?:boolean}} [opts]
 */
export function bindCard(cardId, initiatorSessionId, opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const id = String(cardId ?? '').trim();
  if (!id) return { ok: false, error: '--card 必填（卡 id）' };
  const sid = (initiatorSessionId == null || String(initiatorSessionId).trim() === '') ? null : String(initiatorSessionId).trim();
  const source = normSource(opts.source);
  if (!source) return { ok: false, error: `--source 必须是 ${BINDING_SOURCES.join('|')}` };
  if (!sid && source !== 'cron') {
    return { ok: false, error: `没有会话身份时必须显式 --source cron（不许猜）：card=${id}` };
  }
  const cur = loadBindings({ home });
  if (cur.corrupt && opts.force !== true) {
    return { ok: false, corrupt: true, error: `绑定表损坏（${cur.error}）→ 拒绝写入以免覆盖；先修复或删除 ${cur.file}（确认可弃时加 --force）` };
  }
  const prev = cur.cards[id] && typeof cur.cards[id] === 'object' ? cur.cards[id] : null;
  const entry = {
    initiatorSessionId: sid,
    boundAt: now,
    source,
    title: opts.title ?? prev?.title ?? null,
    seq: opts.seq ?? prev?.seq ?? null,
    line: opts.line ?? prev?.line ?? null,
    boundBy: opts.actor ?? process.env.DSH_SESSION_ID ?? 'cli',
    note: opts.note ?? null,
    previousInitiator: prev?.initiatorSessionId ?? null,
  };
  const next = {
    ...cur,
    device: cur.device ?? hostName(),
    cards: { ...cur.cards, [id]: entry },
    audit: pushAudit(cur, {
      at: now, action: prev ? 'rebind-card' : 'bind-card', cardId: id,
      from: prev?.initiatorSessionId ?? null, to: sid, source, by: entry.boundBy,
    }),
  };
  const r = saveBindings(next, { home, now, dryRun: opts.dryRun, force: opts.force === true });
  // 【D 报警 · 2026-10-29】键不是标准 UUID ⇒ 带一行警告（**不阻断**：上游调用方可能传别的前缀形态，
  //   阻断会把它们一并误伤）。CLI 侧负责把这句打给人看。
  const idWarning = isStandardCardId(id) ? null : nonStandardCardIdWarning(id);
  if (!r.ok) return { ...r, idWarning };
  return { ok: true, action: prev ? 'rebound' : 'bound', cardId: id, entry, previous: prev, file: r.file, dryRun: r.dryRun === true, forced: r.forced === true, idWarning };
}

/** 登记主线 owner（方案 §2.1 兜底级：这条主线由哪个会话推进）。 */
export function bindLine(line, ownerSessionId, opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const key = String(line ?? '').trim();
  if (!key) return { ok: false, error: '--line 必填（主线名）' };
  const sid = (ownerSessionId == null || String(ownerSessionId).trim() === '') ? null : String(ownerSessionId).trim();
  const source = normSource(opts.source);
  if (!source) return { ok: false, error: `--source 必须是 ${BINDING_SOURCES.join('|')}` };
  if (!sid) return { ok: false, error: '主线 owner 必须有会话身份（--session <sid|auto>）' };
  const cur = loadBindings({ home });
  if (cur.corrupt && opts.force !== true) {
    return { ok: false, corrupt: true, error: `绑定表损坏（${cur.error}）→ 拒绝写入以免覆盖；先修复或删除 ${cur.file}（确认可弃时加 --force）` };
  }
  const prev = cur.lines[key] && typeof cur.lines[key] === 'object' ? cur.lines[key] : null;
  const entry = {
    ownerSessionId: sid,
    boundAt: now,
    source,
    boundBy: opts.actor ?? process.env.DSH_SESSION_ID ?? 'cli',
    previousOwner: prev?.ownerSessionId ?? null,
  };
  const next = {
    ...cur,
    device: cur.device ?? hostName(),
    lines: { ...cur.lines, [key]: entry },
    audit: pushAudit(cur, {
      at: now, action: prev ? 'rebind-line' : 'bind-line', line: key,
      from: prev?.ownerSessionId ?? null, to: sid, source, by: entry.boundBy,
    }),
  };
  const r = saveBindings(next, { home, now, dryRun: opts.dryRun, force: opts.force === true });
  if (!r.ok) return r;
  return { ok: true, action: prev ? 'rebound' : 'bound', line: key, entry, previous: prev, file: r.file, dryRun: r.dryRun === true, forced: r.forced === true };
}

/** 删一条卡级绑定（--forget --card）。 */
export function unbindCard(cardId, opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const id = String(cardId ?? '').trim();
  if (!id) return { ok: false, error: '--card 必填' };
  const cur = loadBindings({ home });
  if (!cur.cards[id]) return { ok: true, action: 'missing', cardId: id, file: cur.file };
  const cards = { ...cur.cards };
  delete cards[id];
  const next = {
    ...cur,
    cards,
    audit: pushAudit(cur, { at: now, action: 'forget-card', cardId: id, from: cur.cards[id]?.initiatorSessionId ?? null, to: null, source: null, by: opts.actor ?? process.env.DSH_SESSION_ID ?? 'cli' }),
  };
  const r = saveBindings(next, { home, now, dryRun: opts.dryRun });
  if (!r.ok) return r;
  return { ok: true, action: 'forgotten', cardId: id, file: r.file, dryRun: r.dryRun === true };
}

/** 删一条主线绑定（--forget --line）。 */
export function unbindLine(line, opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const key = String(line ?? '').trim();
  if (!key) return { ok: false, error: '--line 必填' };
  const cur = loadBindings({ home });
  if (!cur.lines[key]) return { ok: true, action: 'missing', line: key, file: cur.file };
  const lines = { ...cur.lines };
  delete lines[key];
  const next = {
    ...cur,
    lines,
    audit: pushAudit(cur, { at: now, action: 'forget-line', line: key, from: cur.lines[key]?.ownerSessionId ?? null, to: null, source: null, by: opts.actor ?? process.env.DSH_SESSION_ID ?? 'cli' }),
  };
  const r = saveBindings(next, { home, now, dryRun: opts.dryRun });
  if (!r.ok) return r;
  return { ok: true, action: 'forgotten', line: key, file: r.file, dryRun: r.dryRun === true };
}

// ---------------------------------------------------------------- 只读解析（判定侧用）

/** 卡级绑定原始条目（无 → null）。
 *
 *  【B · 查侧容错（兜底）2026-10-29】历史存量里存在**短键**（`e3cf23b2` / `mainline` / `auto` 等），
 *  而消费侧一律用账本里的**完整 UUID** 来查。精确未命中时再做一次**前缀唯一**匹配：
 *    · 恰好 1 个键命中 ⇒ 返回该条目（**非破坏性**：浅拷贝 + 追加 `matchedBy:'prefix'` / `matchedKey`，原条目字段一个不动）
 *    · 0 个或多个 ⇒ `null`（**绝不猜**：歧义宁可当作"没绑定"，判定侧照旧降级到主线 owner / 标题判据）
 *  仍然是**纯函数、零 IO**；调用形状（`(bindings, cardId)` → 条目|null）不变，四处调用方照旧只判 truthy / 取会话 id。 */
export function resolveCardBinding(bindings, cardId) {
  const cards = bindings?.cards;
  const raw = String(cardId ?? '');
  const exact = cards?.[raw];
  if (exact && typeof exact === 'object') return exact;          // 精确命中优先（含空表/坏表：精确在就先精确）
  if (!cards || typeof cards !== 'object') return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  const hits = Object.keys(cards).filter((k) => (
    k !== raw && k.toLowerCase().startsWith(key) && cards[k] && typeof cards[k] === 'object'
  ));
  if (hits.length !== 1) return null;                            // 0 个或多个 → 不猜
  const hitKey = hits[0];
  return { ...cards[hitKey], matchedBy: 'prefix', matchedKey: hitKey };
}

/** 主线 owner 原始条目（无 → null）。 */
export function resolveLineOwner(bindings, line) {
  if (!line) return null;
  const b = bindings?.lines?.[String(line)];
  return (b && typeof b === 'object') ? b : null;
}

/**
 * 列出绑定有效性（**纯函数**，给 `--list` 与 prune 共用）。
 * 状态：effective（会话存在）/ session-missing（会话不在本机 → 判定时降级）/ no-initiator（显式无主 → 降级）
 *      / card-closed（卡已 done/failed/归档）/ card-missing（看板查不到）
 * @param {{cards:object, lines:object}} bindings
 * @param {{tasks?:Array|null, sessions?:Array|null, now?:number}} [ctx] tasks/sessions 为 null = 不校验该维度
 */
export function describeBindings(bindings, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const tasks = Array.isArray(ctx.tasks) ? ctx.tasks : null;
  const sessions = Array.isArray(ctx.sessions) ? ctx.sessions : null;
  const byId = new Map((tasks ?? []).map((t) => [String(t?.id), t]));
  const sidSet = new Set((sessions ?? []).map((s) => String(s?.sessionId)));
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

  const rows = [];
  for (const [cardId, b] of Object.entries(bindings?.cards ?? {})) {
    const sid = b?.initiatorSessionId ?? null;
    const t = tasks ? byId.get(cardId) : null;
    // 逐条列出命中的原因（主状态取优先级最高的一条；`reasons` 给 `--list` / prune 报告写明全部理由）
    const reasons = [];
    if (!sid) reasons.push('no-initiator');
    else if (sessions && !sidSet.has(String(sid))) reasons.push('session-missing');
    if (tasks && !t) reasons.push('card-missing');
    else if (t && (t.archivedAt || t.status === 'done' || t.status === 'failed')) reasons.push('card-closed');
    const status = ['card-missing', 'card-closed', 'session-missing', 'no-initiator'].find((k) => reasons.includes(k)) ?? 'effective';
    rows.push({
      kind: 'card', key: cardId, sessionId: sid, source: b?.source ?? null, status, reasons,
      boundAt: num(b?.boundAt), ageMin: num(b?.boundAt) ? Math.max(0, Math.round((now - num(b.boundAt)) / 60_000)) : null,
      title: t?.title ?? b?.title ?? null, seq: t?.seq ?? b?.seq ?? null, line: t?.line ?? b?.line ?? null,
      cardStatus: t?.status ?? null,
      previousInitiator: b?.previousInitiator ?? null,
      boundBy: b?.boundBy ?? null,
    });
  }
  for (const [line, b] of Object.entries(bindings?.lines ?? {})) {
    const sid = b?.ownerSessionId ?? null;
    const reasons = [];
    if (!sid) reasons.push('no-initiator');
    else if (sessions && !sidSet.has(String(sid))) reasons.push('session-missing');
    rows.push({
      kind: 'line', key: line, sessionId: sid, source: b?.source ?? null,
      status: reasons[0] ?? 'effective', reasons,
      boundAt: num(b?.boundAt), ageMin: num(b?.boundAt) ? Math.max(0, Math.round((now - num(b.boundAt)) / 60_000)) : null,
      title: null, seq: null, line, cardStatus: null,
      previousInitiator: b?.previousOwner ?? null, boundBy: b?.boundBy ?? null,
    });
  }
  return rows.sort((a, b) => (b.ageMin ?? -1) - (a.ageMin ?? -1));
}

/**
 * 清理（方案 §3 幂等行 + §1 口径）：
 *   · 卡级：卡已 done/failed/归档（`card-closed`）或看板查不到（`card-missing`）
 *   · 任一级：绑定的会话已不存在（`session-missing`）—— 归档会话也算不存在（判定时同样无效）
 * ⚠️ **`no-initiator`（显式 cron 无主）不是清理理由**：它是"这张卡没有已知发起者"的**当前有效事实**
 *    （cron 自动登记写的），清掉下轮又会被写回来 —— 清它只会制造噪声，不解决任何问题。
 * **默认 dry-run**（`apply:true` 才写）；`tasks`/`sessions` 传 null 表示该维度不参与判定（采集失败时不许乱清）。
 */
export const PRUNABLE_STATUS = ['card-closed', 'card-missing', 'session-missing'];

export function pruneBindings(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const apply = opts.apply === true;
  const cur = loadBindings({ home });
  if (cur.corrupt) return { ok: false, corrupt: true, error: `绑定表损坏（${cur.error}）→ 拒绝清理（先修复或删除 ${cur.file}）`, file: cur.file };

  const rows = describeBindings(cur, { tasks: opts.tasks ?? null, sessions: opts.sessions ?? null, now });
  const prunable = (r) => (r.reasons ?? [r.status]).some((x) => PRUNABLE_STATUS.includes(x));
  const removed = rows.filter(prunable);
  const kept = rows.filter((r) => !prunable(r));
  const result = {
    ok: true, dryRun: !apply, file: cur.file, now,
    removed: removed.map((r) => ({ kind: r.kind, key: r.key, sessionId: r.sessionId, status: r.status, reasons: r.reasons ?? [] })),
    kept: kept.length, total: rows.length,
    skippedNoInitiator: kept.filter((r) => (r.reasons ?? []).includes('no-initiator')).length,
  };
  if (!removed.length) return { ...result, action: 'nothing-to-prune' };
  if (!apply) return { ...result, action: 'dry-run' };

  const cards = { ...cur.cards };
  const lines = { ...cur.lines };
  for (const r of removed) {
    if (r.kind === 'card') delete cards[r.key]; else delete lines[r.key];
  }
  const audit = removed.slice(0, MAX_AUDIT).map((r) => ({
    at: now, action: 'prune', kind: r.kind, cardId: r.kind === 'card' ? r.key : null, line: r.kind === 'line' ? r.key : null,
    status: r.status, from: r.sessionId ?? null, to: null, source: null, by: opts.actor ?? process.env.DSH_SESSION_ID ?? 'cli',
  }));
  const next = { ...cur, cards, lines, audit: [...audit, ...(cur.audit ?? [])].slice(0, MAX_AUDIT) };
  const w = saveBindings(next, { home, now });
  if (!w.ok) return { ...result, ok: false, error: w.error, action: 'save-failed' };
  return { ...result, action: 'pruned', removed: result.removed };
}

/** 表规模摘要（CLI --list 头 / 日报用）。 */
export function summarizeBindings(bindings, ctx = {}) {
  const rows = describeBindings(bindings, ctx);
  const by = { card: 0, line: 0 };
  const st = { effective: 0, 'session-missing': 0, 'no-initiator': 0, 'card-closed': 0, 'card-missing': 0 };
  for (const r of rows) {
    by[r.kind] = (by[r.kind] ?? 0) + 1;
    st[r.status] = (st[r.status] ?? 0) + 1;
  }
  return { total: rows.length, byKind: by, byStatus: st, file: bindings?.file ?? null, exists: bindings?.exists === true, corrupt: bindings?.corrupt === true };
}
