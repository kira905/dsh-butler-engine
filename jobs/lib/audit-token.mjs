// dsh-butler / lib/audit-token.mjs —— P5 审计凭证 + 逃生舱（纯逻辑，可单测）
//
// 方案 §4 P5「凭证模式实现细则」：
//   凭证 = 拦截方内存 Map path → {hash, expiresAt}；审计工具跑完 POST /audit-pass 发证；
//   拦截器校验「path 在 Map 且 hash 匹配」→ 放行并删凭证（一次性）。
//
// 本模块只做**判定**（无 IO 热路径 / 无插件依赖），host 插件与 CLI 都从这里 import。
//   - 内存态（重启即失效，不落盘 —— 凭证不应跨进程/跨重启存活）
//   - 暂停开关落 ~/.dsh/butler-audit-off.json（走 butler-store 契约，已在 state-files 登记）
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { readJson, writeTextAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../../src/dsh-butler/lib/dual-write.mjs';

/** 凭证有效期（方案硬编码值）。 */
export const AUDIT_TOKEN_TTL = 600_000;
/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-audit-off.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

/** 暂停开关状态文件（单机时间窗口状态 → 禁止随仓1同步）。 */
export const AUDIT_OFF_FILE = 'butler-audit-off.json';
export const AUDIT_OFF_SCHEMA = 1;
// ─────────────────────────────────────────────── 暂停开关的 TTL 硬上限 / 缺省值（写死在服务端）
// 【卡「冲刺600 · audit-off 限时」· 2026-10-09】控制室口径包 §3.1 / §7.3②（主人 2026-09-17 拍板）：
//   「必填理由 + 服务端 clamp TTL ≤30min（默认值写死）+ 顶栏常驻横幅 + 升级告警」。
// 根因（①-3 报告 §四·1 缺口）：改前 `until = off && ttlMs>0 ? now+ttlMs : null` ⇒ **不传即永不过期**
//   （面板前端 client.js 本来就不传 ttlMs）⇒ clamp **必须在服务端**，前端补传不算修好。
// 这两个数是**唯一真源**：面板路由 / 任何直接调用本库的写路径，都从这里取，别各写一份。
/** 暂停写入审计的硬上限 = 30 分钟（服务端 clamp，任何输入都不会超过它）。 */
export const AUDIT_OFF_MAX_MS = 30 * 60 * 1000;
/** 暂停写入审计的缺省时长（不传 / 传空 ⇒ 取它，**绝不无限**）。 */
export const AUDIT_OFF_DEFAULT_MS = 30 * 60 * 1000;
/** TTL 非法输入的错误码（fail-closed 拒写 + 调用方留痕）。 */
export const AUDIT_OFF_TTL_INVALID = 'AUDIT_OFF_TTL_INVALID';

export const CODES = {
  NOT_PASSED: 'AUDIT_NOT_PASSED',
  EXPIRED: 'AUDIT_EXPIRED',
  HASH_MISMATCH: 'AUDIT_HASH_MISMATCH',
  OFF: 'AUDIT_DISABLED',
  FORCE_NO_ACTOR: 'FORCE_NO_ACTOR',
  FORCE_SUBAGENT_DENIED: 'FORCE_SUBAGENT_DENIED',
  FORCE_UNVERIFIED: 'FORCE_UNVERIFIED',
};

/** 面向模型/主人的标准报错文案（含下一步指引）。 */
export function blockMessage(code, { path: p, tool } = {}) {
  const where = p ? `「${p}」` : '目标路径';
  switch (code) {
    case CODES.NOT_PASSED:
      return `${code}: ${where}在写入保护区（persona / 技能 / 核心启动链）。请先落临时文件再跑审计：\n`
        + '  1) 把待写入内容写到 <tmp>\\butler-audit-stage\\<name>\n'
        + '  2) node <pkg>/src/dsh-butler/butler-audit-cli.mjs --staged <临时文件> --target "<目标路径>" --pass\n'
        + '  3) 审计通过后 10 分钟内，用 write 工具把**同一份内容**写到目标路径\n'
        + '     （DSH write 工具自身是原子发布：staging 目录 + rename，无中间态；且只有它走 A 层门。\n'
        + '      不要用 pwsh/node renameSync 就位——那会绕过事件门，A 层拦不到，只能靠 B 层事后审计）\n'
        + `  逃生舱：主人可在面板「暂停写入审计」，或用 --force "<原因>"（仅主会话 / 面板）。`;
    case CODES.EXPIRED:
      return `${code}: ${where}的审计凭证已过期（TTL 10 分钟），请重跑审计工具。`;
    case CODES.HASH_MISMATCH:
      return `${code}: 待写入内容与审计通过的内容不一致（${where}）。`
        + '审计对象必须是"即将写入的同一份内容"（逐字节一致，含换行）：先落临时文件 → 审计 → 用 write 工具写同一内容。';
    default:
      return `${code}: ${where}${tool ? `（工具 ${tool}）` : ''}写入被管家审计拦截。`;
  }
}

/** 内容哈希（sha256 hex）。字符串按 UTF-8；Buffer 按字节原样。 */
export function contentHash(text) {
  return createHash('sha256').update(Buffer.isBuffer(text) ? text : String(text), 'utf8').digest('hex');
}

/**
 * 凭证存储（一次性 + TTL + 上限保护）。
 * 热路径只做 Map 查 + 数值比较（P95 <5ms 预算，实测 0.0001ms）。
 */
export class AuditTokenStore {
  constructor(opts = {}) {
    this.ttlMs = Number(opts.ttlMs ?? AUDIT_TOKEN_TTL);
    this.now = opts.now ?? (() => Date.now());
    this.max = Number(opts.max ?? 500);
    /** @type {Map<string, {pathKey:string, hash:string, expiresAt:number, at:number, actor:object, source:string, reason:string|null}>} */
    this.map = new Map();
  }

  /** 发证（审计通过后由 host 路由调用）。同路径重复发证 → 覆盖（最后一次审计为准）。 */
  issue(pathKey, hash, meta = {}) {
    const key = String(pathKey);
    const now = this.now();
    if (this.map.size >= this.max) this.purge();
    if (this.map.size >= this.max) {
      // 仍满：丢最旧一条（防御性上限，正常不会触发）
      const oldest = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.map.delete(oldest[0]);
    }
    const entry = {
      pathKey: key,
      hash: String(hash ?? '').toLowerCase(),
      expiresAt: now + this.ttlMs,
      at: now,
      actor: meta.actor ?? null,
      source: meta.source ?? 'cli',
      reason: meta.reason ?? null,
    };
    this.map.set(key, entry);
    return entry;
  }

  /** 查（不消耗）；过期即删。 */
  peek(pathKey) {
    const key = String(pathKey);
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return e;
  }

  /**
   * 校验（不消耗）。hash 为空 = 只校验路径（fs 门拿不到内容时的语义）。
   * @returns {{ok:boolean, code?:string, entry?:object, message?:string}}
   */
  verify(pathKey, hash) {
    const key = String(pathKey);
    const raw = this.map.get(key);
    if (!raw) return { ok: false, code: CODES.NOT_PASSED };
    if (raw.expiresAt <= this.now()) {
      this.map.delete(key);
      return { ok: false, code: CODES.EXPIRED };
    }
    if (hash && raw.hash && String(hash).toLowerCase() !== raw.hash) {
      return { ok: false, code: CODES.HASH_MISMATCH, entry: raw };
    }
    return { ok: true, entry: raw };
  }

  /** 校验并消耗（一次性；fs 门放行时调用）。 */
  consume(pathKey, hash) {
    const r = this.verify(pathKey, hash);
    if (r.ok) this.map.delete(String(pathKey));
    return r;
  }

  purge() {
    const now = this.now();
    for (const [k, v] of [...this.map.entries()]) if (v.expiresAt <= now) this.map.delete(k);
    return this.map.size;
  }

  stats() {
    this.purge();
    return { size: this.map.size, ttlMs: this.ttlMs, paths: [...this.map.keys()] };
  }
}

// ------------------------------------------------------------------ 逃生舱 ① 暂停开关

/**
 * 读暂停开关。
 * @param {{home?:string, now?:number}} [opts]
 * @returns {{active:boolean, off:boolean, reason:string|null, by:string|null, since:number|null, until:number|null, file:string}}
 */
export function readAuditOff(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = stateFileOf(AUDIT_OFF_FILE, { home });
  const now = opts.now ?? Date.now();
  let data = null;
  try {
    data = readJson(file, { schemaVersion: AUDIT_OFF_SCHEMA });
  } catch {
    // schema 不符 / 文件坏 → fail-safe：视为**未暂停**（审计照常，宁可多拦不可漏拦）
    data = null;
  }
  const off = data?.off === true;
  const until = Number.isFinite(data?.until) ? Number(data.until) : null;
  const expired = until !== null && until <= now;
  return {
    active: off && !expired,
    off,
    reason: data?.reason ?? null,
    by: data?.by ?? null,
    since: Number.isFinite(data?.since) ? Number(data.since) : null,
    until,
    file,
    expired,
  };
}

/**
 * 归一化「暂停写入审计」的 TTL（**纯函数**，单测入口）。
 * 口径（控制室口径包 §3.1 / §7.3②，主人 2026-09-17 拍板）：
 *   · 不传 / null / 空串          → 取缺省值（30min），**绝不无限**（改前不传即 until=null=永不过期）；
 *   · 合法正数但 > 上限           → **clamp 到上限**（不拒绝：主人要的 ≤30min 语义）；
 *   · 非法（非数字 / NaN / ≤0 / 布尔 / 对象 / 乱字符串）→ `ok:false`（调用方 fail-closed 拒 + 留痕）。
 *   · `defaultMs` / `maxMs` 可注入（测试用），生产缺省即上面两个常量。
 * @param {unknown} ttlMs 原始输入
 * @param {{maxMs?:number, defaultMs?:number}} [opts]
 * @returns {{ok:true, ttlMs:number, source:'default'|'input'|'clamp', clamped:boolean, requested:unknown}
 *          |{ok:false, code:string, message:string, requested:unknown, maxMs:number, defaultMs:number}}
 */
export function normalizeAuditOffTtl(ttlMs, opts = {}) {
  const maxMs = Number.isFinite(opts.maxMs) ? Number(opts.maxMs) : AUDIT_OFF_MAX_MS;
  const defaultMs = Math.min(Number.isFinite(opts.defaultMs) ? Number(opts.defaultMs) : AUDIT_OFF_DEFAULT_MS, maxMs);
  const blank = ttlMs === undefined || ttlMs === null || (typeof ttlMs === 'string' && ttlMs.trim() === '');
  if (blank) return { ok: true, ttlMs: defaultMs, source: 'default', clamped: false, requested: null };
  const isNumberish = typeof ttlMs === 'number'
    || (typeof ttlMs === 'string' && ttlMs.trim() !== '' && Number.isFinite(Number(ttlMs)));
  const n = isNumberish ? Number(ttlMs) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return {
      ok: false,
      code: AUDIT_OFF_TTL_INVALID,
      message: `暂停时长非法（ttlMs=${safeTtlText(ttlMs)}）：只接受正数毫秒；不传则取缺省 ${Math.round(defaultMs / 60000)} 分钟（上限 ${Math.round(maxMs / 60000)} 分钟）。已 fail-closed 拒绝，未改动任何状态。`,
      requested: ttlMs, maxMs, defaultMs,
    };
  }
  const clamped = n > maxMs;
  return { ok: true, ttlMs: clamped ? maxMs : Math.round(n), source: clamped ? 'clamp' : 'input', clamped, requested: n };
}

/** 把任意输入渲染成可安全进日志/审计的短文本（防巨大对象刷屏）。 */
function safeTtlText(v) {
  try {
    if (typeof v === 'object' && v !== null) return Array.isArray(v) ? '数组' : '对象';
    return String(v).slice(0, 40);
  } catch { return '(不可渲染)'; }
}

/**
 * 写暂停开关（面板按钮 / CLI 调用）。
 * 【卡「冲刺600 · audit-off 限时」】改点：TTL 一律经 `normalizeAuditOffTtl()` 归一化 ——
 *   `until` 只有两种取值：`off ? now + ttlMs : null`，其中 `ttlMs` **永远 ∈ (0, 30min]**。
 *   非法输入（且 `off !== false`）⇒ **抛错**（fail-closed，**不写文件**）；调用方必须接住并留痕。
 *   `off:false`（恢复保护）**永远不因 TTL 被挡**（救命路径不能被参数校验卡死）。
 * @param {{home?:string, off:boolean, reason?:string, by?:string, ttlMs?:number, now?:number}} input
 */
export function writeAuditOff(input = {}) {
  const home = input.home ?? dshHome();
  const now = input.now ?? Date.now();
  const off = input.off !== false;
  const ttl = normalizeAuditOffTtl(input.ttlMs);
  if (off && !ttl.ok) {
    const e = new Error(ttl.message);
    e.code = ttl.code;
    e.requested = ttl.requested;
    throw e;
  }
  const data = {
    schemaVersion: AUDIT_OFF_SCHEMA,
    off,
    since: off ? now : null,
    until: off ? now + ttl.ttlMs : null,
    reason: String(input.reason ?? '').slice(0, 200) || (off ? '主人暂停写入审计' : null),
    by: String(input.by ?? 'panel').slice(0, 64),
  };
  const dw = writeStateText(AUDIT_OFF_FILE, JSON.stringify(data, null, 2) + '\n', {
    home, write: (p, t) => writeTextAtomic(p, t),
  });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return {
    ...data,
    file: stateFileOf(AUDIT_OFF_FILE, { home }),
    ttlMs: off ? ttl.ttlMs : null,
    ttlSource: off ? ttl.source : null,
    ttlClamped: off ? ttl.clamped : false,
    ttlRequested: off ? ttl.requested : null,
    maxTtlMs: AUDIT_OFF_MAX_MS,
    defaultTtlMs: AUDIT_OFF_DEFAULT_MS,
  };
}

// ------------------------------------------------------------------ 逃生舱 ② force 权限

/**
 * force 权限判定（纯函数，单测入口）。
 * 口径（方案 §4 P5）：「逃生舱 = 主人专用，Agent 自己不能 force 自己」
 *   - 面板操作（主人点击）→ 允许
 *   - 子会话（subagent）→ 拒绝
 *   - 主会话（origin=main 且无 parentSession）→ 允许
 *   - 无法判定身份 → **fail-closed 拒绝**（宁可不放行）
 * @param {{viaPanel?:boolean, sessionId?:string|null, origin?:string|null, parentSession?:string|null, isSubagent?:boolean}} actor
 */
export function judgeForce(actor = {}) {
  if (actor.viaPanel === true) return { allowed: true, reason: 'panel', code: null };
  if (actor.isSubagent === true || actor.origin === 'subagent' || actor.parentSession) {
    return { allowed: false, code: CODES.FORCE_SUBAGENT_DENIED, message: 'force 仅限主人（面板 / 主会话）：子会话（subagent）一律拒绝。' };
  }
  if (!actor.sessionId) {
    return { allowed: false, code: CODES.FORCE_NO_ACTOR, message: 'force 需要 --actor-session <会话id>（无法判定身份时 fail-closed 拒绝）。' };
  }
  if (actor.origin === 'main') return { allowed: true, reason: 'main-session', code: null };
  return { allowed: false, code: CODES.FORCE_UNVERIFIED, message: `force 身份未验证（会话 ${actor.sessionId}）：仅主会话 / 面板可 force。` };
}
