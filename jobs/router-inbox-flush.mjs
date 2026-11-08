#!/usr/bin/env node
// dsh-butler / router-inbox-flush.mjs —— 「静默批」唤醒（2026-11-06 · 卡「Router 静默收信」）
//
// 干什么：tickd 每 5 分钟跑它一次；有未认领的静默来信 ⇒ 用 `session-say` 给 Router 投**一条**唤醒
//   正文形如「静默批 · 未认领 7 条｜最近 3：…（按 /静默批处置 办）」。没信 ⇒ 零动作、零成本。
//
// 方案真源：`docs\方案-统筹线-Router静默收信-20261106-V3.md` §4.7（**六条闸按序判**，别自行加闸）。
//
// 六条闸（顺序固定，命中即返回不投）：
//   ① `.off` 在            ② 无未认领            ③ 今日 ≥96 批 / 本小时 ≥12 批（**到顶走降级，不攒到次日**）
//   ④ Router running=true  ⑤ Router 已归档 / 标题含【已交接】（不投 + 刷 target 档）  ⑥ 其余 ⇒ 投
//
// 投递三死规定（方案 §4.7「投递这一行的三个死规定」，缺一条就是「跑完全无动静」）：
//   1. 🔴 必须带 `--apply`（session-say 缺省 dry-run **且 rc 0** ⇒ 漏了会打印预览、判成功、额度白吃）
//   2. 🔴 必须带 `--no-from`（tickd 没有 DSH_SESSION_ID，否则正文首行拼出 `[from: session-unknown…]`）
//   3. 🔴 成功判据**不是 rc 0**，而是 stdout 含「✅ 已投递」（`session-say.mjs:371` 真投才打这一行）
//
// 记账：限流档 `router-inbox-flush.json`（**与认领 state 分两档**：写 state 会把游标打回 null）
//   投递失败 ⇒ `router-ops.jsonl` 一行 `flush-failed` + **不动游标**（下轮重投同批）；连 3 次进告警。
//
// 夹具/干跑：`ROUTER_INBOX_FLUSH_DRY=1` ⇒ 只打印"本该投什么"，**不真投**（J6 靠它）。
//           `ROUTER_SAY_BIN` 同 `router-act` 的现成做法（换成桩，验"到底 spawn 了什么"）。
//
// 退出码：0 正常（含"不投"） · 1 投递失败 · 2 用法错

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '../src/lib/dsh-home.mjs';
import { pickSessionFileInDir } from '../src/lib/session-file-name.mjs';
import { readArchivedSessionIds, sidKey } from './lib/workspace-archive-list.mjs';
import { acquireTickLock, writeJsonAtomic } from '../src/dsh-butler/lib/store.mjs';
import { splitInbox, parseInboxLine, readState, computeUnread, resolveRouterTarget, isRouterTitle } from './router-inbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAY_BIN = process.env.ROUTER_SAY_BIN || path.join(HERE, 'session-say.mjs');

/** 软闸（方案 §4.7 / §9-3：5 分钟一批 · 每小时 ≤12 · 每日 ≤96；到顶降级为每小时 1 批） */
export const BATCH_PER_DAY_MAX = 96;
export const BATCH_PER_HOUR_MAX = 12;
/** 同一批（未认领末条 id 未变）多久内不重复提醒 */
export const SAME_BATCH_WINDOW_MS = 30 * 60 * 1000;
/** 唤醒正文里带几条「一句话」 */
export const TEXT_ITEMS = 3;
export const TEXT_WIDTH = 60;
/** 投递成功的唯一判据（现读 `session-say.mjs:371`：真投才打印这一行） */
export const DELIVERED_MARK = '✅ 已投递';

const norm = (v) => String(v ?? '').trim();

function paths() {
  const home = resolveDshHome();
  return {
    home,
    inbox: path.join(home, 'router-inbox.jsonl'),
    state: path.join(home, 'router-inbox-state.json'),
    flush: path.join(home, 'router-inbox-flush.json'),
    off: path.join(home, 'router-inbox.off'),
    target: path.join(home, 'router-inbox-target.json'),
    ops: process.env.ROUTER_OPS_FILE || path.join(home, 'router-ops.jsonl'),
    alert: path.join(home, 'feiyu-mood', 'slots-alert.log'),
  };
}

const readFileSafe = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJsonSafe = (f) => { try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); return o && typeof o === 'object' ? o : null; } catch { return null; } };

const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hourKey = (ms) => String(new Date(ms).getHours());

export function emptyFlushState() {
  return { schemaVersion: 1, day: '', batches: 0, hour: '', hourBatches: 0, lastFlush: null, consecutiveFailures: 0 };
}

function readFlushState(file) {
  const o = readJsonSafe(file);
  if (!o || typeof o !== 'object') return emptyFlushState();
  return {
    schemaVersion: 1,
    day: typeof o.day === 'string' ? o.day : '',
    batches: Number(o.batches) || 0,
    hour: typeof o.hour === 'string' ? o.hour : '',
    hourBatches: Number(o.hourBatches) || 0,
    // ⚠️ lastFlush 要**保全部键**（at/throughId/sid/turnsAtFlush/checkedAt）：只挑两个会让
    //    J10⑤ 的软失败复查永远读不到"投递那一刻的 turn/start"（退化成 never-check）
    lastFlush: o.lastFlush && o.lastFlush.at ? { ...o.lastFlush, at: String(o.lastFlush.at) } : null,
    consecutiveFailures: Number(o.consecutiveFailures) || 0,
  };
}

function appendOps(rec) {
  const p = paths();
  try {
    fs.appendFileSync(p.ops, JSON.stringify({ at: new Date().toISOString(), source: 'router-inbox-flush', ...rec }) + '\n', 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
}

function alertOnce(sig, message, now = Date.now()) {
  const file = paths().alert;
  let last = 0;
  for (const raw of readFileSafe(file).split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    try { const o = JSON.parse(s); if (o && String(o.sig ?? '') === String(sig)) last = Math.max(last, Number(o.at) || 0); } catch { /* ignore */ }
  }
  if (last && now - last < 6 * 60 * 60 * 1000) return { wrote: false, reason: 'dedup' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: now, iso: new Date(now).toISOString(), level: 'warn', source: 'router-inbox-flush', sig: String(sig), message: String(message ?? '').slice(0, 500) }) + '\n', 'utf8');
    return { wrote: true };
  } catch (e) { return { wrote: false, error: e?.message ?? String(e) }; }
}

// ── 纯函数区（夹具直接 import，零副作用）────────────────────────────────────

/** 按显示宽度截断（CJK 记 2；逐 code point 迭代 ⇒ 不切坏中文/emoji） */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
export function dispWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += WIDE.test(ch) ? 2 : 1;
  return n;
}
export function clipWidth(s, width) {
  const str = String(s);
  if (dispWidth(str) <= width) return str;
  let out = '';
  let n = 0;
  for (const ch of str) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (n + cw > width - 1) break;
    out += ch;
    n += cw;
  }
  return out + '…';
}

/** 一句话：`线名 → 正文前 60 显示宽` */
export function oneLiner(o, width = TEXT_WIDTH) {
  const line = norm(o?.line) || 'unknown';
  const text = String(o?.text ?? '').replace(/\s+/g, ' ').trim();
  return `${line} → ${clipWidth(text, width)}`;
}

/** 静默批正文（末 3 条，按文件行序 —— **不按 kind / 时刻排**，方案 §4.4 同口径） */
export function buildBatchText(unread, { items = TEXT_ITEMS, width = TEXT_WIDTH, alerts = 0 } = {}) {
  const n = Array.isArray(unread) ? unread.length : 0;
  const picks = (unread ?? []).slice(-items).map((o) => oneLiner(o, width)).join('；');
  const base = `静默批 · 未认领 ${n} 条${picks ? `｜最近 ${Math.min(n, items)}：${picks}` : ''}（按 /静默批处置 办）`;
  // 方案 §7-J10④：`slots-alert.log` 24h 内有新条目 ⇒ **并进下一批摘要**（给它一个消费者）
  return alerts > 0 ? `${base}\n⚠️ 槽位告警 ${alerts} 条（24h，见 feiyu-mood/slots-alert.log）` : base;
}

/**
 * 六条闸的**唯一判据**（纯函数）。
 * @param {object} o
 * @param {boolean} o.offExists            `.off` 是否在
 * @param {object[]} o.unread              未认领行（文件行序）
 * @param {object} o.flushState            限流档
 * @param {number} o.now                   当前毫秒
 * @param {null|{sid:string,title:string,running:boolean,archived:boolean,handoff:boolean}} o.router
 * @returns {{deliver:boolean, reason:string, text?:string, throughId?:string, degraded?:boolean}}
 */
export function decideDelivery({ offExists = false, unread = [], flushState = emptyFlushState(), now = Date.now(), router = null, alerts = 0 } = {}) {
  if (offExists) return { deliver: false, reason: 'off' };
  if (!unread.length) return { deliver: false, reason: 'no-unread' };

  const day = ymd(now);
  const hour = hourKey(now);
  const st = flushState ?? emptyFlushState();
  const batches = st.day === day ? st.batches : 0;
  const hourBatches = st.day === day && st.hour === hour ? st.hourBatches : 0;

  let degraded = false;
  if (batches >= BATCH_PER_DAY_MAX) {
    // 日额度用尽 ⇒ **降级为每小时整点投一批**（不是停止；不许攒到次日零点）
    degraded = true;
    const lastAt = st.lastFlush?.at ? Date.parse(st.lastFlush.at) : NaN;
    if (Number.isFinite(lastAt) && ymd(lastAt) === day && hourKey(lastAt) === hour) {
      return { deliver: false, reason: 'daily-cap-hourly-degraded', degraded: true };
    }
  } else if (hourBatches >= BATCH_PER_HOUR_MAX) {
    return { deliver: false, reason: 'hour-cap' };
  }

  const lastRow = unread[unread.length - 1];
  const throughId = lastRow?.id ?? null;
  const lastAt = st.lastFlush?.at ? Date.parse(st.lastFlush.at) : NaN;
  if (throughId && st.lastFlush?.throughId === throughId && Number.isFinite(lastAt) && now - lastAt < SAME_BATCH_WINDOW_MS) {
    return { deliver: false, reason: 'same-batch' };
  }

  if (!router) return { deliver: false, reason: 'no-target' };
  if (router.archived || router.handoff) return { deliver: false, reason: 'router-gone' };
  if (router.running) return { deliver: false, reason: 'router-running' };

  return { deliver: true, reason: 'ok', text: buildBatchText(unread, { alerts }), throughId, degraded };
}

// ── J10 反向判据的观测器（方案 §7-J10 ②④⑤⑥；纯函数，夹具直接 import）──────

/** 把 router-ops 里 `inbox-push` 行汇总成「24h 成功数 / 前 7 天日均」 */
export function summarizeOps(raw, { now = Date.now() } = {}) {
  const rows = [];
  for (const line of String(raw ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && o.verb === 'inbox-push') rows.push(o);
    } catch { /* 坏行忽略 */ }
  }
  const at = (o) => Date.parse(o.at ?? '') || 0;
  const DAY = 24 * 3600 * 1000;
  const last24h = rows.filter((o) => o.ok === true && now - at(o) <= DAY).length;
  const prev7d = rows.filter((o) => o.ok === true && now - at(o) > DAY && now - at(o) <= 8 * DAY).length;
  return { last24h, prev7d, perDay7d: prev7d / 7, total: rows.length };
}

/** 静默通道健康告警（② 失灵 / ⑥ 归档膨胀）；返回 [{sig,message}]，由调用方落 alert */
export function healthWarnings({ opsRaw = '', archiveCount = 0, archiveBytes = 0, now = Date.now() } = {}) {
  const w = [];
  const s = summarizeOps(opsRaw, { now });
  if (s.last24h === 0 && s.perDay7d >= 1) {
    w.push({
      sig: 'inbox:stale-push',
      message: `静默通道疑似失灵：24h 内 inbox-push 成功 0 次（前 7 天日均 ${s.perDay7d.toFixed(1)} 次）`,
    });
  }
  if (archiveCount > 20 || archiveBytes > 15 * 1024 * 1024) {
    w.push({
      sig: 'inbox:archive-growth',
      message: `静默来信归档增长：${archiveCount} 个档 / ${(archiveBytes / 1048576).toFixed(1)} MB（阈值 20 个 / 15 MB）`,
    });
  }
  return w;
}

/** slots-alert.log 近 24h 条数（J10④ 的消费口：并进下一批摘要） */
export function recentAlerts(raw, { now = Date.now(), ms = 24 * 3600 * 1000 } = {}) {
  let n = 0;
  for (const line of String(raw ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && now - Number(o.at) <= ms) n++;
    } catch { /* ignore */ }
  }
  return n;
}

/** J10⑤ 软失败是否该查了：上一批投递已过 grace（6 分钟）且还没查过 */
export function shouldCheckSoftFail(lastFlush, { now = Date.now(), graceMs = 6 * 60 * 1000 } = {}) {
  if (!lastFlush || !lastFlush.at || lastFlush.checkedAt) return false;
  const at = Date.parse(lastFlush.at);
  if (!Number.isFinite(at)) return false;
  return now - at >= graceMs;
}

/** 投递成功的**唯一**判据（不是 rc 0！见文件头三死规定第 3 条） */
export function looksDelivered(stdout) {
  return String(stdout ?? '').includes(DELIVERED_MARK);
}

/** session-say 的 argv（夹具据此断言 `--apply` / `--no-from` 在不在） */
export function buildSayArgs({ sid, file, apply = true, mode = 'queue', noFrom = true } = {}) {
  const args = [SAY_BIN, '--to', sid, '--file', file, '--mode', mode];
  if (apply) args.push('--apply');
  if (noFrom) args.push('--no-from');
  return args;
}

// ── 取数 ──────────────────────────────────────────────────────────────────

function sessionList() {
  // 夹具钩子：`ROUTER_SESSION_LIST_FILE` 指向一份 session.list 形状的 JSON ⇒ 不调 Host（J6 全程离线）
  const f = process.env.ROUTER_SESSION_LIST_FILE;
  if (f) {
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      const items = Array.isArray(o) ? o : o?.items ?? o?.body?.result?.value?.items;
      return Promise.resolve(Array.isArray(items) ? items : []);
    } catch { return Promise.resolve([]); }
  }
  // 与 router-inbox 同一条路（session.list）；失败 ⇒ 空表（下面按"判不出"处理）
  return import('../src/lib/dsh-host-rpc.mjs').then(({ hostRpc }) => {
    const base = (process.env.DSH_WEB_URL ?? 'http://localhost:3080').replace('127.0.0.1', 'localhost');
    return hostRpc(base, 'session.list', {}).then((r) => {
      const v = r?.body?.result?.value ?? r?.body?.value ?? {};
      return Array.isArray(v.items) ? v.items : [];
    }).catch(() => []);
  }).catch(() => []);
}

const titleOf = (it) => { const t = it?.projections?.values?.title ?? it?.title; return typeof t === 'string' ? t : ''; };
const sidOf = (it) => String(it?.sessionId ?? it?.id ?? '');

// ── J10⑤ 软失败探测：投递后 6 分钟看该 Router 的 turn/start 有没有涨（多帧 zstd，与 J5 同款）──
function findSessionDir(home, sid) {
  const id = String(sid).replace(/^session-/, '');
  const names = ['session-' + id, id];
  for (const root of [path.join(home, 'sessions'), path.join(home, '_archived-sessions')]) {
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of subs) {
      if (!e.isDirectory()) continue;
      if (names.includes(e.name)) return path.join(root, e.name);
      for (const n of names) {
        const cand = path.join(root, e.name, n);
        try { if (fs.statSync(cand).isDirectory()) return cand; } catch { /* 不在这一层 */ }
      }
    }
  }
  return null;
}

/** 数 turn/start（读不到任何东西 ⇒ null，**不当软失败** —— 宁可漏报也不误报） */
export function countRouterTurns(sid, home = resolveDshHome()) {
  try {
    if (!sid) return null;
    const dir = findSessionDir(home, sid);
    if (!dir) return null;
    const file = pickSessionFileInDir(dir);
    if (!file) return null;
    const buf = fs.readFileSync(file);
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const starts = [];
    for (let i = 0; (i = buf.indexOf(MAGIC, i)) !== -1; i += 4) starts.push(i);
    if (!starts.length) return null;
    let n = 0;
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : buf.length;
      let txt = '';
      try { txt = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { continue; }
      for (const ln of txt.split(/\r?\n/)) if (ln.includes('"turn/start"')) n++;
    }
    return n;
  } catch { return null; }
}

/** 归档档总数 / 总量（J10⑥） */
function archiveStats(home) {
  let count = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(home)) {
      if (!/^router-inbox-\d{6}-\d{2}\.jsonl$/.test(f)) continue;
      count++;
      try { bytes += fs.statSync(path.join(home, f)).size; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { count, bytes };
}

/** 一轮观测（J10②④⑤⑥）。**任何异常都不影响主流程**（返回已采集到的部分）。 */
function runObservers({ now = Date.now(), p, out = () => {} } = {}) {
  const res = { alerts24h: 0, warnings: [] };
  try {
    const opsRaw = readFileSafe(p.ops);
    const alertRaw = readFileSafe(p.alert);
    const ast = archiveStats(p.home);
    res.alerts24h = recentAlerts(alertRaw, { now });
    res.warnings = healthWarnings({ opsRaw, archiveCount: ast.count, archiveBytes: ast.bytes, now });
    for (const w of res.warnings) {
      alertOnce(w.sig, w.message, now);
      appendOps({ verb: 'inbox-health-warn', ok: false, rc: 0, sig: w.sig });
    }
    if (ast.count || ast.bytes) out(`[flush] 归档档 ${ast.count} 个 / ${(ast.bytes / 1048576).toFixed(1)} MB · slots-alert 24h ${res.alerts24h} 条\n`);
  } catch { /* 观测失败不报错 */ }
  return res;
}

/** J10⑤ 软失败：上一批投了、6 分钟过去、turn/start 没涨 ⇒ 记一行（游标本来也没动） */
function checkSoftFail({ now = Date.now(), p, out = () => {} } = {}) {
  try {
    const st = readFlushState(p.flush);
    if (!shouldCheckSoftFail(st.lastFlush, { now })) return;
    const sid = st.lastFlush.sid ?? readJsonSafe(p.target)?.sid ?? null;
    const turns = countRouterTurns(sid, p.home);
    const before = Number(st.lastFlush.turnsAtFlush);
    if (Number.isFinite(before) && typeof turns === 'number') {
      if (turns <= before) {
        appendOps({ verb: 'flush-soft-fail', ok: false, rc: 0, through: st.lastFlush.throughId ?? null, turnsBefore: before, turnsAfter: turns });
        alertOnce('flush:soft-fail', `静默批投了但 6 分钟没起回合：turn/start ${before} → ${turns}（through=${st.lastFlush.throughId ?? '-'}）`, now);
        out(`[flush] ⚠️ 软失败：投了但 6 分钟没起回合（turn/start ${before} → ${turns}）\n`);
      } else {
        out(`[flush] 软失败复查：turn/start ${before} → ${turns}（已起回合 ✅）\n`);
      }
    }
    const lock = acquireTickLock('router-inbox', { waitMs: 200, ttlMs: 30_000 });
    if (!lock.ok) return;
    try {
      const s2 = readFlushState(p.flush);
      if (s2.lastFlush && !s2.lastFlush.checkedAt) {
        writeJsonAtomic(p.flush, { ...s2, lastFlush: { ...s2.lastFlush, checkedAt: new Date(now).toISOString() } });
      }
    } finally {
      try { lock.release(); } catch { /* ignore */ }
    }
  } catch { /* 探测失败不报错 */ }
}


/** 真正投递（锁外 spawn；成功后回锁里记一批） */
function spawnSay({ sid, text, apply = true, sayBin = SAY_BIN }) {  const tmp = path.join(os.tmpdir(), `router-inbox-flush-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    const args = buildSayArgs({ sid, file: tmp, apply });
    if (sayBin !== SAY_BIN) args[0] = sayBin;
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    return {
      rc: typeof r.status === 'number' ? r.status : null,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? '') || (r.error ? String(r.error.message ?? r.error) : ''),
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * 一轮完整流程（生产入口）。
 * ⚠️ 判定与投递**分开两次取锁**：投递要 spawn 几十秒，绝不能持着 `router-inbox` 锁
 *   （持着会把各线的 push 全堵住 —— 方案 §4.7-2 专门警告过"两把锁别混"）。
 */
export async function main(argv = process.argv.slice(2)) {
  const dryRun = process.env.ROUTER_INBOX_FLUSH_DRY === '1' || argv.includes('--dry-run');
  const sayBin = process.env.ROUTER_SAY_BIN || SAY_BIN;
  const p = paths();
  const out = (s) => process.stdout.write(s);
  const now = Date.now();

  // ── 0：观测（J10 反向判据 ②④⑤⑥）—— 每轮都跑，**无来信也跑**（失灵就是"没信"的形态）
  const obs = runObservers({ now, p, out });
  checkSoftFail({ now, p, out });

  // ── A：判定（锁内）
  let decision = { deliver: false, reason: 'unknown' };
  let routerSid = null;
  const lockA = acquireTickLock('router-inbox', { waitMs: 200, ttlMs: 30_000 });
  if (!lockA.ok) {
    out(`[flush] 抢不到数据锁（${lockA.reason}）⇒ 本轮让路\n`);
    return 0;
  }
  try {
    const offExists = fs.existsSync(p.off);
    const lines = splitInbox(readFileSafe(p.inbox));
    const state = readState(p.state);
    const { unread } = computeUnread(lines, state);
    const flushState = readFlushState(p.flush);
    const arch = readArchivedSessionIds(p.home);
    const cached = readJsonSafe(p.target);
    let router = null;
    if (cached && cached.sid) {
      const items = await sessionList();
      const it = items.find((x) => sidOf(x) === cached.sid);
      const title = it ? titleOf(it) : String(cached.title ?? '');
      const archived = !!(arch.ok && arch.ids.has(sidKey(cached.sid)));
      router = { sid: cached.sid, title, running: !!(it && it.running), archived, handoff: title.includes('【已交接】') };
      if (archived || !it || router.handoff) {
        const fresh = await resolveRouterTarget({ apply: true });
        router = fresh ? { sid: fresh.sid, title: fresh.title, running: false, archived: false, handoff: false } : null;
        appendOps({ verb: 'inbox-target-refresh', ok: !!fresh, rc: fresh ? 0 : 6, sid: fresh?.sid ?? null });
      }
    }
    decision = decideDelivery({ offExists, unread, flushState, now, router, alerts: obs.alerts24h });
    routerSid = router?.sid ?? null;
    // 降级文案（槽位段也会自己算一份；这里只打印给人看）
  } finally {
    try { lockA.release(); } catch { /* ignore */ }
  }

  out(`[flush] ${decision.deliver ? '投' : '不投'}（${decision.reason}）${decision.degraded ? ' · 日额度已尽 ⇒ 降级为每小时一批' : ''}\n`);
  if (!decision.deliver) {
    if (decision.reason === 'router-gone' || decision.reason === 'no-target') appendOps({ verb: 'inbox-flush-skip', ok: true, rc: 0, reason: decision.reason });
    return 0;
  }
  out(`[flush] 目标 ${routerSid}\n  正文：${decision.text}\n`);
  if (dryRun) {
    out('[flush] DRY（ROUTER_INBOX_FLUSH_DRY=1）⇒ 只打印，不真投\n');
    return 0;
  }

  // ── B：投递（锁外）
  const r = spawnSay({ sid: routerSid, text: decision.text, sayBin });
  const ok = looksDelivered(r.stdout);
  // ── C：记账（锁内；成功才计数 + lastFlush；失败不动游标、不计数）
  const lockC = acquireTickLock('router-inbox', { waitMs: 200, ttlMs: 30_000 });
  if (!lockC.ok) {
    out(`[flush] 投后抢不到数据锁（${lockC.reason}）⇒ 本轮不记账（下轮会重投同一批）\n`);
    appendOps({ verb: 'flush-count-deferred', ok: false, rc: 1, reason: 'lock-busy' });
    return ok ? 0 : 1;
  }
  try {
    const st = readFlushState(p.flush);
    const day = ymd(now);
    const hour = hourKey(now);
    const next = {
      schemaVersion: 1,
      day,
      batches: (st.day === day ? st.batches : 0),
      hour,
      hourBatches: (st.day === day && st.hour === hour ? st.hourBatches : 0),
      lastFlush: st.lastFlush,
      consecutiveFailures: ok ? 0 : (st.consecutiveFailures || 0) + 1,
    };
    if (ok) {
      next.batches += 1;
      next.hourBatches += 1;
      // J10⑤：记下"投递那一刻"的 turn/start，6 分钟后下一轮复查有没有涨
      next.lastFlush = {
        at: new Date(now).toISOString(),
        throughId: decision.throughId,
        sid: routerSid,
        turnsAtFlush: countRouterTurns(routerSid, p.home),
        checkedAt: null,
      };
      out(`[flush] ✅ 已投（第 ${next.batches} 批 / 本小时 ${next.hourBatches}）through=${decision.throughId}\n`);
    } else {
      out(`[flush] ✗ 投递失败（rc=${r.rc}，stdout 无「${DELIVERED_MARK}」）⇒ 不动游标，下轮重投同批\n${r.stderr.slice(0, 300)}\n`);
      if (next.consecutiveFailures >= 3) {
        alertOnce('flush:fail-streak', `静默批连续 ${next.consecutiveFailures} 次投递失败（最后一轮 rc=${r.rc}）—— 游标没动，信还在档里`);
      }
    }
    writeJsonAtomic(p.flush, next);
    appendOps({
      verb: ok ? 'flush-deliver' : 'flush-failed', ok, rc: ok ? 0 : (r.rc ?? 1),
      through: decision.throughId, batches: next.batches, hourBatches: next.hourBatches,
      ...(ok ? {} : { stderr: r.stderr.slice(0, 200) }),
    });
  } finally {
    try { lockC.release(); } catch { /* ignore */ }
  }
  return ok ? 0 : 1;
}

function isDirectRun() {
  try {
    const self = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).toLowerCase();
    const entry = process.argv[1];
    if (!entry) return false;
    return fs.realpathSync(entry).toLowerCase() === self;
  } catch { return false; }
}

if (isDirectRun()) {
  main().then((rc) => { process.exitCode = rc ?? 0; }).catch((e) => {
    process.stderr.write(`✗ ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}
