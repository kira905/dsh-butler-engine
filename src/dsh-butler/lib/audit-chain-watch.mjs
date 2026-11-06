// dsh-butler / lib/audit-chain-watch.mjs —— 审计链尾部巡检 + 「新断链」告警（P-1/P-2 · 2026-09-23）
//
// ── 两个职责 ─────────────────────────────────────────────────────────────────
//   ① **新断链告警**（P-1 的兜底半边）：`appendAudit()` 写完立刻扫一次**文件尾窗口**（默认最后 8 条），
//      发现"相邻两条不接链"或"尾部坏行"就告警一次 —— **同一断点只告警一次**（按签名去重）。
//      为什么要有它：写锁只能防"未来的分叉"，防不住**已经**发生的分叉与坏行；没有告警的话
//      链断了没人知道（这正是 09-17~09-22 三次断链"躺在流水里二十天"的根因）。
//      为什么只扫尾窗口而不是全量：append 是热路径。尾窗口足够 —— 新断链必然出现在尾部附近，
//      且窗口里出现过就会记住签名，滑出窗口也不会重复告警。
//   ② **签名口径**（P-2 的单一数据源）：`chainProblemSig()` 同时被
//      `butler-audit-verify.mjs`（历史断点白名单匹配）与本模块（告警去重）使用 —— 两处**一套写法**，
//      避免"同一处断链在白名单里叫 A、在告警里叫 B"。
//
// ── 铁律 ─────────────────────────────────────────────────────────────────────
//   ① **绝不抛**：巡检是辅助设施，任何异常都吞掉并返回 `ok:false`（绝不影响审计写入结果）。
//   ② **正常（无断链）时零额外 I/O**：不读状态文件、不写状态文件 —— 热路径不因巡检变慢。
//   ③ **`emit:false` 时只算不落**（不写状态、不告警）：观察档不得消费去重配额（
//      "没人看到"却把签名记下 = 白盖一次告警机会）。
//   ④ 状态文件写入用「临时文件 + rename」，失败静默（不因状态写失败而影响主流程）。
import fs from 'node:fs';
import path from 'node:path';
// 【R-065 三件套 · 锁6-E1（2026-10-19）】删除 / 搬移唯一口：dry-run 第一道门 + reparse 拒删 + 白名单拒跑。
//   共享闸 = 动态 import（可选依赖）：本文件在 tools 目录损坏时也要能跑；加载失败 ⇒ 拒动作（fail-closed），绝不裸删。
const PG_DESTRUCTIVE = await import('../../lib/production-guard.mjs').catch(() => null);
function guardedDestructive({ targets, whitelist, op = '删', reason, dryRun = false, action }) {
  const list = targets.map((t) => (typeof t === 'string' ? { path: t, label: reason } : t));
  if (dryRun === true) { try { console.log('[plan] ' + op + ' ' + list.map((t) => t.path).join(' ; ')); } catch {} return false; }
  if (!PG_DESTRUCTIVE) throw new Error('R-065 闸不可用（production-guard.mjs 加载失败）⇒ 拒绝' + op);
  const g = PG_DESTRUCTIVE.gateDestructive({
    targets: list, whitelist, op, scope: ['file'], requires: ['file'], dryRun: false,
    allowProduction: true, allowReparse: false, ledgerBypass: false, reason,
  });
  if (!g.ok) throw new Error('R-065 拒' + op + '（' + (g.code ?? 'blocked') + '）：' + String(g.reason).split('\n')[0]);
  if (typeof action === 'function') action();
  return true;
}

import { createHash } from 'node:crypto';
import { alert } from './alert.mjs';

/** 尾窗口读取字节上限（与 lib/audit.mjs 的 lastHash 同量级）。 */
export const TAIL_WINDOW_BYTES = 16 * 1024;
/** 尾窗口记录条数上限。 */
export const TAIL_WINDOW_RECORDS = 8;
/** 告警去重状态文件名（与审计流水同目录）。 */
export const CHAIN_ALERT_STATE_BASENAME = '.chain-alert-state.json';
/** 已告警签名记忆上限（FIFO 淘汰）。 */
export const MAX_REMEMBERED_SIGS = 50;
/** 「写锁 fail-open」告警冷却（同一状态文件里记 lockAlertAt）。 */
export const LOCK_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/** 状态文件绝对路径（与流水同目录）。 */
export function chainAlertStatePath(file) {
  return path.join(path.dirname(file), CHAIN_ALERT_STATE_BASENAME);
}

function sha16(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 断链签名（**唯一口径**：verify 的白名单与 watch 的告警去重都走它）。
 *   · `unparsable`  → `raw:<内容 sha16>`（无原始行可读时 `raw:unknown` ⇒ 永远不匹配白名单 = 保守报红）
 *   · `chain-break` → `chain-break|at:<ISO>|got:<本行 prev 前 12 位>`
 *   · 其它          → `<reason>|at:<ISO>`（白名单不允许登记这两类以外，见 normalizeKnownBreaks）
 * @param {{reason?:string, at?:string|null, gotPrev?:string|null, index?:number}} problem
 * @param {{rawLine?:string|null}} [opts]
 */
export function chainProblemSig(problem, opts = {}) {
  const reason = String(problem?.reason ?? 'unknown');
  if (reason === 'unparsable') {
    const raw = opts.rawLine;
    return raw == null ? 'raw:unknown' : `raw:${sha16(raw)}`;
  }
  if (reason === 'chain-break') {
    return `chain-break|at:${problem?.at ?? 'null'}|got:${String(problem?.gotPrev ?? 'null').slice(0, 12)}`;
  }
  return `${reason}|at:${problem?.at ?? 'null'}`;
}

/**
 * 读审计流水尾部窗口（只读，绝不抛）。
 *
 * ⚠️ 从文件中间开始读时**必须丢掉首行**：那行多半是被字节窗口切掉半截的（否则每次巡检都会
 *    把一个"半截 JSON"误判成坏行 → 假断链告警）。
 *
 * @returns {{ok:boolean, size:number, entries:Array<{raw:string, rec:object|null}>,
 *            lastHash:string|null, truncated:boolean, error?:string}}
 */
export function readTailWindow(file, opts = {}) {
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : TAIL_WINDOW_BYTES;
  const maxRecords = Number(opts.maxRecords) > 0 ? Number(opts.maxRecords) : TAIL_WINDOW_RECORDS;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (st.size <= 0) return { ok: true, size: 0, entries: [], lastHash: null, truncated: false };
    const size = Math.min(st.size, maxBytes);
    const truncated = st.size > size;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    let lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    if (truncated) lines = lines.slice(1);            // ← 丢掉被字节窗口切半的首行（见上方 ⚠️）
    const picked = lines.slice(-maxRecords);
    const entries = picked.map((raw) => {
      try { return { raw, rec: JSON.parse(raw) }; } catch { return { raw, rec: null }; }
    });
    const last = entries[entries.length - 1];
    const lastHash = last && last.rec && typeof last.rec.hash === 'string' ? last.rec.hash : null;
    return { ok: true, size: st.size, entries, lastHash, truncated };
  } catch (e) {
    return { ok: false, size: 0, entries: [], lastHash: null, truncated: false, error: e?.message ?? String(e) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 窗口内断链检测（**必须与 `verifyChain()` 同口径**，否则告警会与校验器各说各话）。
 * 同口径三条：① 无法解析的行 = `unparsable`，且**不重置**锚点（所以它后面那条会报 `chain-break`，
 * 这正是 09-17 空洞 → 4484 次生断链的成因）；② 无 `hash` 的旧记录（legacy）**重置**锚点、不算断链；
 * ③ 窗口第一条只作锚点，不与窗口外比较（没有前一条信息）。
 * @param {Array<{raw:string, rec:object|null}>} entries
 * @returns {Array<{relIndex:number, reason:string, at:string|null, expectPrev:string|null, gotPrev:string|null, sig:string}>}
 */
export function detectChainBreaks(entries = []) {
  const out = [];
  let lastHash = null;
  let first = true;
  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    if (!cur || !cur.rec) {
      out.push({
        relIndex: i, reason: 'unparsable', at: null, expectPrev: null, gotPrev: null,
        sig: chainProblemSig({ reason: 'unparsable' }, { rawLine: cur?.raw ?? null }),
      });
      continue;   // 锚点与 first 都不动（同 verifyChain）
    }
    const rec = cur.rec;
    if (typeof rec.hash !== 'string') { lastHash = null; first = true; continue; }   // legacy：重置锚点
    if (!first && (rec.prev ?? null) !== lastHash) {
      const at = rec.at ?? null;
      out.push({
        relIndex: i, reason: 'chain-break', at,
        expectPrev: lastHash, gotPrev: rec.prev ?? null,
        sig: chainProblemSig({ reason: 'chain-break', at, gotPrev: rec.prev ?? null }),
      });
    }
    lastHash = rec.hash;
    first = false;
  }
  return out;
}

function readState(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      sigs: Array.isArray(o?.sigs) ? o.sigs.filter((s) => typeof s === 'string') : [],
      lockAlertAt: Number.isFinite(Number(o?.lockAlertAt)) ? Number(o.lockAlertAt) : null,
      at: typeof o?.at === 'string' ? o.at : null,
    };
  } catch {
    return { sigs: [], lockAlertAt: null, at: null };
  }
}

function writeState(file, st) {
  try {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', 'utf8');
    guardedDestructive({ targets: [{ path: tmp, label: 'audit-chain state tmp' }, { path: file, label: 'audit-chain state' }], whitelist: [path.dirname(file)], op: '搬移', reason: 'audit-chain-watch: write state atomically', action: () => fs.renameSync(tmp, file) });
    return true;
  } catch { return false; }
}

/**
 * 尾部巡检（绝不抛）。发现**未告警过**的断点 → 告警一次并记住签名。
 * @param {string} file 审计流水文件
 * @param {{home?:string, silent?:boolean, emit?:boolean, maxBytes?:number, maxRecords?:number}} [opts]
 * @returns {{ok:boolean, scanned:number, breaks:Array, fresh:Array, alerted:boolean, error?:string}}
 */
export function inspectAuditChain(file, opts = {}) {
  try {
    const win = readTailWindow(file, opts);
    if (!win.ok) return { ok: false, scanned: 0, breaks: [], fresh: [], alerted: false, error: win.error };
    const breaks = detectChainBreaks(win.entries);
    if (!breaks.length) return { ok: true, scanned: win.entries.length, breaks: [], fresh: [], alerted: false };

    const stateFile = chainAlertStatePath(file);
    const st = readState(stateFile);
    const known = new Set(st.sigs);
    const fresh = breaks.filter((b) => !known.has(b.sig));
    if (!fresh.length) return { ok: true, scanned: win.entries.length, breaks, fresh: [], alerted: false };

    // 铁律③：emit=false 只算不落（不写状态、不告警）
    if (opts.emit === false) {
      return { ok: true, scanned: win.entries.length, breaks, fresh, alerted: false, suppressed: true };
    }
    writeState(stateFile, {
      ...st,
      sigs: [...st.sigs, ...fresh.map((b) => b.sig)].slice(-MAX_REMEMBERED_SIGS),
      at: new Date().toISOString(),
    });
    alert({
      level: 'warn',
      source: 'butler-audit',
      message: `审计哈希链出现新断链 ${fresh.length} 处（同签名只告警一次；历史已定性的断点见 lib/known-chain-breaks.json）`,
      detail: {
        file,
        windowRecords: win.entries.length,
        fresh: fresh.map((b) => ({ sig: b.sig, reason: b.reason, at: b.at, gotPrev: b.gotPrev ?? null })),
      },
    }, { home: opts.home, silent: opts.silent });
    return { ok: true, scanned: win.entries.length, breaks, fresh, alerted: true, suppressed: false };
  } catch (e) {
    return { ok: false, scanned: 0, breaks: [], fresh: [], alerted: false, error: e?.message ?? String(e) };
  }
}

/**
 * 「审计写锁 fail-open」告警（带冷却去重）。**fail-open 本身已在调用方完成**（照样追加），
 * 本函数只负责"让人知道锁出过问题"，且同一小时内不刷屏。
 * @param {string} file
 * @param {object} lock acquireAppendLock() 的返回值
 * @returns {{alerted:boolean, reason:string}}
 */
export function alertAppendLockFailOpen(file, lock, opts = {}) {
  try {
    if (opts.emit === false) return { alerted: false, reason: 'emit-off' };
    const stateFile = chainAlertStatePath(file);
    const st = readState(stateFile);
    const now = Date.now();
    if (st.lockAlertAt !== null && now - st.lockAlertAt < LOCK_ALERT_COOLDOWN_MS) {
      return { alerted: false, reason: 'cooldown' };
    }
    writeState(stateFile, { ...st, lockAlertAt: now, at: new Date(now).toISOString() });
    alert({
      level: 'warn',
      source: 'butler-audit',
      message: `审计写锁未取得（mode=${lock?.mode ?? 'unknown'}）—— 已 fail-open 照样追加，仅告警`,
      detail: {
        file,
        lockPath: lock?.lockPath ?? null,
        mode: lock?.mode ?? null,
        waitedMs: lock?.waitedMs ?? null,
        takeovers: lock?.takeovers ?? null,
        holder: lock?.holder ?? null,
        error: lock?.error ?? null,
      },
    }, { home: opts.home, silent: opts.silent });
    return { alerted: true, reason: 'alerted' };
  } catch {
    return { alerted: false, reason: 'error' };
  }
}

export default {
  TAIL_WINDOW_BYTES,
  TAIL_WINDOW_RECORDS,
  CHAIN_ALERT_STATE_BASENAME,
  MAX_REMEMBERED_SIGS,
  LOCK_ALERT_COOLDOWN_MS,
  chainProblemSig,
  chainAlertStatePath,
  readTailWindow,
  detectChainBreaks,
  inspectAuditChain,
  alertAppendLockFailOpen,
};
