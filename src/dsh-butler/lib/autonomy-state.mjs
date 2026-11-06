// dsh-butler / lib/autonomy-state.mjs —— 自治降档开关（全局唯一入口）
//
// 由来：docs/ §5 G7 / §13.1 E5 / §13.6 D3 / §13.8 吸收表
//   G7「降档联动（D3=A：先实现开关）」，E5 实测该文件**不存在**（9/9 就设计、至今未落地的公共件），
//   the operator拍板 D3=A：**先把这个开关实现出来**（本卡），接线（小护士 G7 / 3.6-C repair L2）另卡。
// 配套：docs/ §3.6-C / §9.7
//
// ⛔ **本模块不接线**：不 import repair / guard / 小护士，也不被它们调用。本卡只交付「开关本体 +
//   CLI + 单测」。接线是后续卡（避免半接线状态：一侧已按新口径拒动、另一侧还没接 = 行为不可预测）。
//
// ── 语义（写死，任何调用方必须照此判定）────────────────────────────────────
//   level: 'normal'   → 正常：自动动作按各自开关（lib/autonomy.mjs）与护栏判定
//   level: 'degraded' → **降档：暂停一切自主动作，仅允许诊断与报告**
//        ❌ 禁止：自动修复 / 自动重启 / 自动回滚 / 自动执行任何 L2+ 动作 / 自动起小护士
//        ✅ 允许：只读诊断、采集、生成报告与告警推送、the operator显式请求的动作（人工触发的入口不受降档影响）
//        「降档 ≠ 停机」：它是"动手能力"的闸，不是"观察能力"的闸。
//
// ── fail-safe（**缺文件与损坏都必须显式选定**，本卡定死并落文档）───────────
//   ① 缺文件（never-created / 被删）→ **degraded**（reason: file-missing）
//      理由：没有任何证据表明"可以自动动手"时，保守侧是拒动。与 lib/state-files.mjs 预登记条目
//      逐字一致（第 45-48 行：「loss: fail-safe：默认 degraded（原 %TEMP% 方案重启/清理后静默放行自动动作）」），
//      也与 butler-tidy-tick 的 P-1 口径（读不到 → fail-safe 视为降档）一致。
//      副作用（已知并接受）：本开关落地后，**从未写过该文件的机器 / 删掉该文件的机器一律为降档态**，
//      要恢复正常必须the operator显式 `node butler-autonomy-state-cli.mjs normal --by <who> --reason "<why>"`。
//      ⇒ 这正是"落地即保守"的设计意图，不许为了"省事"改成缺文件=normal。
//   ② 文件损坏（非法 JSON / 空文件 / 非对象 / schemaVersion 不符）→ **degraded**（reason: file-corrupt:*）
//      理由：损坏 = 状态不可知，不可知的自动动手比不动手更危险；且与缺文件同结论可避免"删文件就能绕过降档"。
//      写入时会先把损坏内容原样留档到 ~/.dsh/butler-autonomy-state.corrupt-<ts>.json（取证），再覆盖。
//   ③ 读失败（权限 / IO 异常）→ **degraded**（reason: read-error:*）。
//   ⚠️ v0.1.0（2026-09-09 计划稿）曾把"缺文件 → null（不判降档）"；v0.2.0 起统一为上述 degraded
//      ——旧读取方（barewatch-tick.mjs）因此不会再返回 null 分支，属预期收敛（该处本就要接降档态）。
//
// ── 落盘 ──────────────────────────────────────────────────────────────────
//   原子写走 butler-store.writeJsonAtomic；读-改-写全程持 RMW 锁（多会话/多 tick 并发不丢更新）。
//   写入方一律要求 by + reason（可溯源）；level 变更追加迁移历史（最近 100 条，见 state-files retention）。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { writeTextAtomic, acquireRmwLock } from './store.mjs';
import { writeStateText } from './dual-write.mjs';

export const AUTONOMY_STATE_VERSION = '0.2.0';
export const AUTONOMY_STATE_SCHEMA = 1;

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-autonomy-state.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

export const AUTONOMY_STATE_FILE = 'butler-autonomy-state.json';

/** 降档态合法取值（写死；不要扩展成第三态——第三态会让每个调用方都要重新判定）。 */
export const LEVELS = ['normal', 'degraded'];
export const LEVEL_NORMAL = 'normal';
export const LEVEL_DEGRADED = 'degraded';

/** 迁移历史保留条数（与 lib/state-files.mjs 登记表 retention 一致：「保留最近 100 条迁移」）。 */
export const HISTORY_KEEP = 100;

/**
 * 判定"读到的状态是否可用"——只有 ok:true 时 source 才是 'file'。
 * @param {{ok:boolean, source:'file'|'default'}} r
 */
export function isAvailable(r) {
  return r?.ok === true && r?.source === 'file';
}

export function autonomyStatePath(opts = {}) {
  return stateFileOf(AUTONOMY_STATE_FILE, opts);
}

/** 当前设备名（history/updatedBy 溯源用；与 handoff 的 host 口径一致）。 */
function deviceName() {
  try { return process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown'; } catch { return 'unknown'; }
}

/**
 * 一行的「降档态」对象（纯数据，供面板 / 日报 / 双判据用）。
 * @param {string} level
 * @param {object|null} raw
 * @param {string} reason
 */
function makeState(level, raw, reason, extra = {}) {
  return {
    level,
    file: null,
    source: 'default',
    reason,
    updatedAt: raw?.updatedAt ?? null,
    updatedBy: raw?.updatedBy ?? null,
    history: Array.isArray(raw?.history) ? raw.history : [],
    raw: raw ?? null,
    ...extra,
  };
}

/**
 * 读降档态。**永不抛**（任何异常都按 fail-safe 收敛为 degraded）。
 * @param {{home?:string}} [opts]
 * @returns {{ok:boolean, level:'normal'|'degraded', degraded:boolean, allowed:boolean, file:string,
 *            source:'file'|'default', reason:string, updatedAt:string|null, updatedBy:string|null,
 *            history:Array<object>, raw:object|null}}
 */
export function readAutonomyState(opts = {}) {
  const file = autonomyStatePath(opts);
  let raw = null;
  let reason = 'ok';
  try {
    if (!fs.existsSync(file)) reason = 'file-missing';
    else {
      const txt = fs.readFileSync(file, 'utf8');
      if (!txt.trim()) reason = 'file-corrupt:empty';
      else {
        let j = null;
        try { j = JSON.parse(txt); } catch (e) { reason = `file-corrupt:json:${e?.message ?? e}`; }
        if (j !== null) {
          if (!j || typeof j !== 'object' || Array.isArray(j)) reason = 'file-corrupt:not-object';
          else if (Number(j.schemaVersion ?? NaN) !== AUTONOMY_STATE_SCHEMA) reason = `file-corrupt:schema-mismatch:${j.schemaVersion}`;
          else if (!LEVELS.includes(j.level)) reason = `file-corrupt:bad-level:${j.level}`;
          else { raw = j; reason = 'ok'; }
        }
      }
    }
  } catch (e) {
    reason = `read-error:${e?.message ?? e}`;
  }

  const degraded = reason !== 'ok';
  if (degraded) {
    // fail-safe：复用损坏文件里**看起来可信**的审计字段做展示（level 一律不信）
    const hint = raw && typeof raw === 'object' ? raw : null;
    return {
      ok: false, level: LEVEL_DEGRADED, degraded: true, allowed: false, file,
      source: 'default', reason,
      updatedAt: hint?.updatedAt ?? null, updatedBy: hint?.updatedBy ?? null,
      history: Array.isArray(hint?.history) ? hint.history : [], raw: hint,
    };
  }
  const level = raw.level === LEVEL_DEGRADED ? LEVEL_DEGRADED : LEVEL_NORMAL;
  return {
    ok: true, level, degraded: level === LEVEL_DEGRADED, allowed: level === LEVEL_NORMAL, file,
    source: 'file', reason,
    updatedAt: raw.updatedAt ?? null, updatedBy: raw.updatedBy ?? null,
    history: Array.isArray(raw.history) ? raw.history : [], raw,
  };
}

/** 现值（'normal' | 'degraded'）。fail-safe 会返回 'degraded'。 */
export function getLevel(opts = {}) {
  return readAutonomyState(opts).level;
}

/**
 * 自动动作闸门：**任何自主动作（自动修复 / 自动重启 / 自动回滚 / 自动起小护士）动手前必须问这里**。
 * ⛔ 本卡只提供判定，不接线。接线后调用方的判据必须是 `{ allowed:true }` 才动手（fail-closed）。
 * @param {{home?:string, kind?:string}} [opts] kind 仅用于回显与日志溯源
 * @returns {{allowed:boolean, level:string, reason:string, hint:string, kind:string|null, file:string, state:object}}
 */
export function checkAutonomyAllowed(opts = {}) {
  const s = readAutonomyState(opts);
  const kind = opts.kind ?? null;
  return {
    allowed: s.level === LEVEL_NORMAL,
    level: s.level,
    reason: s.reason,
    hint: s.level === LEVEL_NORMAL
      ? '正常态：自主动作按各自开关与护栏判定'
      : '降档态：暂停一切自主动作，仅允许诊断与报告（人工触发的入口不受影响）',
    kind,
    file: s.file,
    state: s,
  };
}

/** 是否处于降档（= 是否必须拒动）。 */
export function isDegraded(opts = {}) {
  return readAutonomyState(opts).level === LEVEL_DEGRADED;
}

/** 历史条目规范化（兼容 v0.1.0 计划稿字段名 from/to，避免将来读取方分裂出两套字段）。 */
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    at: e.at ?? null,
    from: e.from ?? null,
    to: e.to ?? e.after ?? null,
    by: e.by ?? null,
    reason: e.reason ?? '',
    device: e.device ?? null,
    note: e.note ?? null,
  };
}

function appendHistory(next, entry) {
  const list = Array.isArray(next.history) ? next.history.map(normalizeEntry).filter(Boolean) : [];
  list.push({ device: deviceName(), ...entry });
  next.history = list.slice(-HISTORY_KEEP);
  return next;
}

/** 损坏文件留档（取证用；同一次损坏只留一份）。 */
function stashCorrupt(file, read) {
  if (read.ok) return null;
  if (!read.reason.startsWith('file-corrupt:')) return null; // 缺文件 / 读失败无内容可留
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const dest = path.join(path.dirname(file), `${AUTONOMY_STATE_FILE.replace(/\.json$/, '')}.corrupt-${ts}.json`);
  try {
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * 写降档态（唯一写入口）。持 RMW 锁 + 原子写 + 迁移历史。
 * @param {'normal'|'degraded'} level
 * @param {{home?:string, by?:string, reason?:string, now?:number, note?:string,
 *          hooks?:{beforeRename?:Function}, lock?:boolean}} [opts]
 * @returns {{ok:boolean, error?:string, file:string, action:'unchanged'|'changed'|'created',
 *            before:string, after:string, corruptStash:string|null, state:object}}
 */
export function setAutonomyState(level, opts = {}) {
  const file = autonomyStatePath(opts);
  if (!LEVELS.includes(level)) {
    return { ok: false, error: `level 只接受 ${LEVELS.join('|')}（实得 ${JSON.stringify(level)}）`, file };
  }
  const by = opts.by ?? opts.updatedBy ?? `cli:${process.env.USERNAME ?? process.env.USER ?? 'unknown'}`;
  const reason = String(opts.reason ?? '').trim();

  const lock = opts.lock === false ? null : acquireRmwLock(file, { home: opts.home });
  try {
    const read = readAutonomyState(opts);
    const stash = stashCorrupt(file, read);
    const before = read.raw && read.ok ? read.raw : null;
    const now = opts.now ?? Date.now();
    const iso = new Date(now).toISOString();

    const base = before ?? {
      schemaVersion: AUTONOMY_STATE_SCHEMA,
      product: 'dsh-butler',
      level: LEVEL_DEGRADED, // fail-safe 基线：无文件时按降档起草，再被本次 level 覆盖
      reason: read.reason,
      updatedAt: iso,
      updatedBy: null,
      history: [],
    };
    const next = {
      ...base,
      schemaVersion: AUTONOMY_STATE_SCHEMA,
      product: 'dsh-butler',
      level,
      reason: reason || base.reason || '',
      updatedAt: iso,
      updatedBy: by,
    };
    appendHistory(next, {
      at: iso,
      from: read.ok ? read.level : `unavailable:${read.reason}`,
      to: level,
      by,
      reason: reason || '',
      note: opts.note ?? (stash ? `损坏文件已留档：${path.basename(stash)}` : null),
    });
    const dw = writeStateText(AUTONOMY_STATE_FILE, JSON.stringify(next, null, 2) + '\n', {
      home: opts.home, write: (p, t) => writeTextAtomic(p, t, opts.hooks ? { hooks: opts.hooks } : {}),
    });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));

    const after = readAutonomyState(opts);
    return {
      ok: true, file,
      action: before ? (before.level === level ? 'unchanged' : 'changed') : 'created',
      before: read.ok ? read.level : `unavailable:${read.reason}`,
      after: after.level,
      corruptStash: stash,
      state: after,
    };
  } finally {
    try { lock?.release?.(); } catch { /* 释放失败由 TTL 兜底 */ }
  }
}

/**
 * 降档（= 暂停一切自主动作）。reason 必填语义上要求非空，函数不强制（CLI 强制）。
 * @param {{home?:string, by?:string, reason?:string, now?:number, note?:string, hooks?:object, lock?:boolean}} [opts]
 */
export function degrade(opts = {}) {
  return setAutonomyState(LEVEL_DEGRADED, opts);
}

/** 恢复正常（= 重新允许自主动作按各自开关判定）。**只有the operator/编排器显式调用才允许。** */
export function resume(opts = {}) {
  return setAutonomyState(LEVEL_NORMAL, opts);
}

/** 幂等建立基线文件（已存在且可读则不动；不存在或损坏则按当前有效值落盘）。 */
export function ensureAutonomyState(opts = {}) {
  const read = readAutonomyState(opts);
  if (read.ok) return { ok: true, action: 'exists', file: read.file, before: read.level, after: read.level, state: read, corruptStash: null };
  const r = setAutonomyState(read.level, { ...opts, reason: opts.reason ?? `ensure 基线（${read.reason}）`, note: opts.note ?? 'ensure 幂等建立' });
  return r.ok ? { ...r, action: 'created' } : r;
}

/** 一行摘要（面板 / 日报 / CLI）。 */
export function describeAutonomyState(opts = {}) {
  const s = readAutonomyState(opts);
  const last = s.history.length ? normalizeEntry(s.history[s.history.length - 1]) : null;
  return {
    file: s.file,
    level: s.level,
    degraded: s.degraded,
    allowed: s.allowed,
    ok: s.ok,
    source: s.source,
    reason: s.reason,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
    historyCount: s.history.length,
    lastChange: last,
  };
}
