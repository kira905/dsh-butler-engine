#!/usr/bin/env node
// dsh-butler / router-inbox.mjs —— 「Router 静默来信」档的唯一读写口（2026-11-06 · 卡「Router 静默收信」）
//
// 干什么：各线的**机械汇报**（普通进度 / 完成通报 / 回执 / @@rep）不再各占 Router 一个回合，
//   而是追加成一行落在 `<DSH_HOME>\router-inbox.jsonl`；Router 每 5 分钟被叫醒一批处理
//   （`router-inbox-flush.mjs` + tickd job）。主人 / 岸的话**不经这里**（照旧实时唤醒）。
//
// 方案真源：`docs\方案-统筹线-Router静默收信-20261106-V3.md` §4.2（**逐条照它实现，不许自行改设计**）。
//
// 四档 + 两缓存（全部在 `<DSH_HOME>` 下）：
//   主档   router-inbox.jsonl             只追加；**唯一切档时整份重写一次**（唯一的 append-only 例外）
//   归档   router-inbox-<YYYYMM>-<NN>.jsonl  只读、永不删；NN = 该月已有归档档数 + 1（同月二次切分不撞名）
//   认领   router-inbox-state.json        {schemaVersion:1, claimedThrough, prevClaimedThrough, updatedAt}
//   限流   router-inbox-flush.json        {schemaVersion:1, day, batches, hour, hourBatches, lastFlush}
//   开关   router-inbox.off               空文件在 = 关（渲染与写入都看它）
//   目标   router-inbox-target.json       {sid,title,updatedAt}（只是缓存，超 7 天作废 ⇒ 现查 session.list）
//
// 并发（方案 §4.2 末段）：写路径统一 `acquireTickLock('router-inbox', {waitMs:200})` ⇒
//   append / claim / rotate / flush 计数四件互斥；抢不到 200ms ⇒ rc 1（**调用方退回实时投递**，不静默吞）。
//   ⚠️ 这把锁**不是 job 锁**（不在 LOCK_REGISTRY 里：审计只要求「调度表里的 job 有登记」）；
//      flush 那个 job 自己的锁叫 `router-inbox-flush` —— **两把锁两个名字**，别混。
//
// 退出码：0 成功/dry-run · 1 写失败或抢锁超时（调用方退回实时） · 2 用法错
//          · 4 claim --through 的 id 失效（游标不动） · 6 判不出 Router · 7 .off 在（通道关闭）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hostRpc } from '../src/lib/dsh-host-rpc.mjs';
import { resolveDshHome } from '../src/lib/dsh-home.mjs';
import { readArchivedSessionIds, sidKey } from './lib/workspace-archive-list.mjs';
import { acquireTickLock, writeJsonAtomic } from '../src/dsh-butler/lib/store.mjs';

export const VERSION = '1.0.0';
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, STALE_ID: 4, NO_TARGET: 6, OFF: 7 };

/** 行格式版本（与行里的 `v` 同值） */
export const LINE_VERSION = 1;
/** kind 封闭三值：report=进度/完成通报 · receipt=回执 · ask=求拍板（发送方填，收端不猜） */
export const KINDS = ['report', 'receipt', 'ask'];
/** 单条正文上限：超了**截断**（rc 仍 0），不拒收 —— 方案 §4.2「'拒绝'与'截断'二选一，本版选截断」 */
export const TEXT_MAX = 4000;
/** 主档切档阈值（体积；行数不作触发条件） */
export const ROTATE_MAX_BYTES = 512 * 1024;
/**
 * Router 标题判据（唯一源：session-say 的 `--silent` 与这里共用）。
 * 🔴 必须是**完整串** `Router · 主路由`，不许缩成「主路由」—— 现网实测有 5 个历史审核会话的标题里
 *    也带「主路由」（「主路由滚动清空方案 v2 追审」…）⇒ 缩成两个字会让 `session.list` 判出 6 个候选、
 *    永远 rc 6（2026-11-06 本卡施工时实测）。
 */
export const ROUTER_TITLE_MARK = 'Router · 主路由';
const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ALERT_DEDUP_MS = 6 * 60 * 60 * 1000;

export function isRouterTitle(title) {
  return String(title ?? '').includes(ROUTER_TITLE_MARK);
}

// ── 路径（**每次调用现算**，夹具可在 import 后改 DSH_HOME）──────────────────
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

/** 夹具钩子：只有 `ROUTER_INBOX_TEST=1` 时才采信 N（生产不带这两个 env ⇒ 恒定 512 KB / 4 KB） */
function rotateMaxBytes(override) {
  if (Number.isFinite(override) && override > 0) return override;
  if (process.env.ROUTER_INBOX_TEST === '1') {
    const n = Number(process.env.ROUTER_INBOX_MAX_BYTES);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return ROTATE_MAX_BYTES;
}

const nowIso = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
};

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function readFileSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJsonSafe(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

/** 主档全文 → 行数组（**丢掉末尾的空串**，保留中间坏行原样） */
export function splitInbox(raw) {
  const lines = String(raw ?? '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 解析一行：坏行 / 缺 id ⇒ null（读侧跳过，写侧从不产生） */
export function parseInboxLine(raw) {
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (!o.id || typeof o.id !== 'string') return null;
    return o;
  } catch { return null; }
}

/** 认领 state（缺省形状钉死；读坏了按"从没认领"处理 = fail-safe 宁可重看） */
export function emptyState() {
  return { schemaVersion: 1, claimedThrough: null, prevClaimedThrough: null, updatedAt: null };
}

export function readState(file) {
  const o = readJsonSafe(file);
  if (!o || typeof o !== 'object') return emptyState();
  return {
    schemaVersion: 1,
    claimedThrough: o.claimedThrough && o.claimedThrough.id
      ? { id: String(o.claimedThrough.id), at: o.claimedThrough.at ?? null } : null,
    prevClaimedThrough: o.prevClaimedThrough && o.prevClaimedThrough.id
      ? { id: String(o.prevClaimedThrough.id), at: o.prevClaimedThrough.at ?? null } : null,
    updatedAt: o.updatedAt ?? null,
    // 附加键（不属方案四档，只用于「连续 3 次切档搬 0 行」告警，见方案 §4.2 切档末两条）
    rotateZeroStreak: Number(o.rotateZeroStreak) || 0,
  };
}

/**
 * 未认领区间（**纯函数**）：游标之后的行。
 * 游标为 null / 游标不在主档 ⇒ **全部未认领**（fail-safe：宁可重看，不可漏看 —— 方案 §4.2）。
 * @returns {{unread:object[], total:number, cursorIndex:number, cursorMissing:boolean}}
 */
export function computeUnread(lines, state) {
  const parsed = lines.map((raw) => parseInboxLine(raw));
  const cursorId = state?.claimedThrough?.id ?? null;
  if (!cursorId) return { unread: parsed.filter(Boolean), total: parsed.filter(Boolean).length, cursorIndex: -1, cursorMissing: false };
  const idx = parsed.findIndex((o) => o && o.id === cursorId);
  if (idx < 0) return { unread: parsed.filter(Boolean), total: parsed.filter(Boolean).length, cursorIndex: -1, cursorMissing: true };
  const unread = parsed.slice(idx + 1).filter(Boolean);
  return { unread, total: parsed.filter(Boolean).length, cursorIndex: idx, cursorMissing: false };
}

// ── 流水 / 告警（不碰 butler-alert.log，只写自家 slots-alert.log）────────────

function appendOps(rec) {
  const p = paths();
  try {
    fs.appendFileSync(p.ops, JSON.stringify({ at: nowIso(), source: 'router-inbox', ...rec }) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** 同 sig 6h 去重（与 dsh-feiyu-mood/lib/slots.js#alertSlot 同格式；本件**不 import 插件包**） */
function alertOnce(sig, message, { file = paths().alert, now = Date.now() } = {}) {
  const key = String(sig || 'unknown');
  let last = 0;
  try {
    for (const raw of readFileSafe(file).split('\n')) {
      const s = raw.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && String(o.sig ?? '') === key) last = Math.max(last, Number(o.at) || 0);
      } catch { /* 坏行忽略 */ }
    }
  } catch { /* 档不存在 = 第一次 */ }
  if (last && now - last < ALERT_DEDUP_MS) return { wrote: false, reason: 'dedup' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      at: now, iso: new Date(now).toISOString(), level: 'warn', source: 'router-inbox', sig: key,
      message: String(message ?? '').slice(0, 500),
    }) + '\n', 'utf8');
    return { wrote: true, file };
  } catch (e) {
    return { wrote: false, error: e?.message ?? String(e) };
  }
}

// ── Router 判定（target 档 → 现查 session.list 兜底）────────────────────────

function titleOf(item) {
  const t = item?.projections?.values?.title ?? item?.title;
  return typeof t === 'string' ? t : '';
}
function sidOf(item) {
  return String(item?.sessionId ?? item?.id ?? '');
}

async function sessionList() {
  // 夹具钩子：`ROUTER_SESSION_LIST_FILE` ⇒ 直接吃一份 session.list 形状的 JSON（不调 Host）
  const f = process.env.ROUTER_SESSION_LIST_FILE;
  if (f) {
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      const items = Array.isArray(o) ? o : o?.items ?? o?.body?.result?.value?.items;
      return Array.isArray(items) ? items : [];
    } catch { return []; }
  }
  const base = (process.env.DSH_WEB_URL ?? 'http://localhost:3080').replace('127.0.0.1', 'localhost');
  const r = await hostRpc(base, 'session.list', {});
  const v = r?.body?.result?.value ?? r?.body?.value ?? {};
  return Array.isArray(v.items) ? v.items : [];
}

/**
 * 判出 Router 会话（**必须在 `router-inbox` 锁内调用**：它可能顺手刷新 target 档）。
 * 顺序：① target 档（≤7 天 且 不在归档名单）② 现查 session.list（标题含 `主路由` 且唯一命中）
 * 判到 ⇒ 写档；判不到 ⇒ null（调用方 rc 6）。
 */
export async function resolveRouterTarget({ apply = true } = {}) {
  const p = paths();
  const arch = readArchivedSessionIds(p.home);
  const archived = (sid) => !!(arch.ok && sid && arch.ids.has(sidKey(sid)));
  const cached = readJsonSafe(p.target);
  if (cached && cached.sid && !archived(cached.sid)) {
    const at = Date.parse(cached.updatedAt ?? '');
    if (Number.isFinite(at) && Date.now() - at <= CURSOR_MAX_AGE_MS) return cached;
  }
  let items = [];
  try { items = await sessionList(); } catch { items = []; }
  const hits = items.filter((it) => isRouterTitle(titleOf(it)) && !archived(sidOf(it)));
  if (hits.length !== 1) return null;
  const next = { sid: sidOf(hits[0]), title: titleOf(hits[0]), updatedAt: nowIso() };
  if (apply) {
    try { writeJsonAtomic(p.target, next); } catch { /* 写档失败不影响本轮判定；下轮再刷 */ }
  }
  return next;
}

// ── 切档（只搬「游标及之前」· 顺序不能反）────────────────────────────────────

function yyyymm(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 该月归档档路径列表（按 NN 升序） */
function listArchives(home, ym) {
  const re = new RegExp(`^router-inbox-${ym}-(\\d{2})\\.jsonl$`);
  let names = [];
  try { names = fs.readdirSync(home); } catch { names = []; }
  return names
    .map((n) => { const m = n.match(re); return m ? { name: n, nn: Number(m[1]) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.nn - b.nn)
    .map((x) => ({ ...x, file: path.join(home, x.name) }));
}

/** 该月全部归档档里已有的 id 集合（去重键：id —— 重试不重复搬） */
function archivedIds(home, ym) {
  const set = new Set();
  for (const a of listArchives(home, ym)) {
    for (const raw of splitInbox(readFileSafe(a.file))) {
      const o = parseInboxLine(raw);
      if (o) set.add(o.id);
    }
  }
  return set;
}

/**
 * 切档（**必须在锁内调用**）。返回 {rotated, reason?, moved, archive?}。
 * 🔴 顺序：① 分两段（游标那一行归归档侧）② 去重后 append 到归档档 ③ tmp→fsync→rename 覆盖主档。
 * 🔴 游标 null / 游标不在主档 ⇒ **本次不切**（fail-safe：宁可体积大，也不许把未认领的信搬走）。
 */
export function rotateLocked({ maxBytes, apply = true } = {}) {
  const p = paths();
  const limit = rotateMaxBytes(maxBytes);
  let size = 0;
  try { size = fs.statSync(p.inbox).size; } catch { return { rotated: false, reason: 'no-inbox', size: 0 }; }
  if (size <= limit) return { rotated: false, reason: 'below-threshold', size };

  const raw = readFileSafe(p.inbox);
  const lines = splitInbox(raw);
  const state = readState(p.state);
  const cursorId = state.claimedThrough?.id ?? null;
  if (!cursorId) return { rotated: false, reason: 'no-cursor', size };
  const idx = lines.findIndex((l) => parseInboxLine(l)?.id === cursorId);
  if (idx < 0) {
    alertOnce('rotate:cursor-missing', `主档里找不到游标 ${cursorId}（已 rename / 被外部换）⇒ 视为全部未认领，本次不切`);
    return { rotated: false, reason: 'cursor-missing', size };
  }
  const moveRows = lines.slice(0, idx + 1);
  if (!moveRows.length) return { rotated: false, reason: 'nothing-to-move', size };

  const ym = yyyymm(new Date());
  const archs = listArchives(p.home, ym);
  const nn = (archs.length ? archs[archs.length - 1].nn : 0) + 1;
  const archFile = path.join(p.home, `router-inbox-${ym}-${String(nn).padStart(2, '0')}.jsonl`);
  const seen = archivedIds(p.home, ym);
  const toAppend = moveRows.filter((l) => {
    const o = parseInboxLine(l);
    return !o || !seen.has(o.id);  // 坏行（无 id）没有归属 ⇒ 跟游标侧一起搬走，别让它永远占着主档
  });
  const keepRows = lines.slice(idx + 1);

  if (apply) {
    if (toAppend.length) {
      const fd = fs.openSync(archFile, 'a');
      try { fs.writeFileSync(fd, toAppend.join('\n') + '\n', 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    // ② tmp → fsync → 原子 rename 覆盖主档（🔴 禁先 truncate 原档：挂载会话的 renderInbox 随时在读）
    const tmp = `${p.inbox}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, keepRows.length ? keepRows.join('\n') + '\n' : '', 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p.inbox);
  }
  return { rotated: true, moved: toAppend.length, kept: keepRows.length, archive: archFile, size };
}

/** 切档后的告警/记账（「主档超阈值且连续 3 次搬 0 行」⇒ 主档已无上界，必须有人知道） */
function noteRotateResult(r, { apply = true } = {}) {
  const p = paths();
  if (r.rotated) {
    if (apply) {
      const st = readState(p.state);
      if (st.rotateZeroStreak) {
        st.rotateZeroStreak = 0;
        try { writeJsonAtomic(p.state, st); } catch { /* 记不上不影响 */ }
      }
    }
    appendOps({ verb: 'rotate', ok: true, rc: 0, moved: r.moved, archive: r.archive });
    return;
  }
  if (r.reason === 'no-cursor' || r.reason === 'cursor-missing') {
    appendOps({ verb: 'rotate-deferred', ok: false, rc: 0, reason: r.reason, size: r.size });
    if (!apply) return;
    const st = readState(p.state);
    st.rotateZeroStreak = (Number(st.rotateZeroStreak) || 0) + 1;
    try { writeJsonAtomic(p.state, st); } catch { /* ignore */ }
    if (st.rotateZeroStreak >= 3) {
      alertOnce('rotate:zero-streak', `主档 ${r.size} B 超阈值但连续 ${st.rotateZeroStreak} 次切档搬 0 行（${r.reason}）—— Router 一直没认领，主档已无上界`);
      appendOps({ verb: 'rotate-no-progress', ok: false, rc: 0, streak: st.rotateZeroStreak, reason: r.reason });
    }
  }
}

// ── 行构造函数 ─────────────────────────────────────────────────────────────

/** 从标题剥 `【运行】` 这类状态前缀，再剥尾部状态词，作为 line 缺省值 */
export function lineFromTitle(title) {
  const t = String(title ?? '').replace(/^(\s*【[^】]{1,12}】\s*)+/, '').trim();
  return t || 'unknown';
}

/**
 * 组装一行（**纯函数**）：v/id/at/line/from/kind/text/truncated。
 * @returns {{row:object, truncated:boolean}}
 */
export function buildRow({ text, line, from = null, kind = 'report', id = newId(), at = nowIso() } = {}) {
  const raw = String(text ?? '');
  const truncated = raw.length > TEXT_MAX;
  const body = truncated ? raw.slice(0, TEXT_MAX) : raw;
  const row = { v: LINE_VERSION, id, at, line: String(line || 'unknown'), kind };
  if (from && (from.sid || from.title)) row.from = { sid: from.sid ?? null, title: from.title ?? null };
  row.text = body;
  row.truncated = truncated;
  return { row, truncated };
}

// ── 动词 ──────────────────────────────────────────────────────────────────

const HELP = `Router 静默来信档（router-inbox）

用法：node router-inbox.mjs <动词> [参数]
  push --text "…" [--from <sid>] [--title <标题>] [--line <线名>] [--kind report|receipt|ask]
        追加一行（真写）· 打印 id · 抢锁失败 rc 1 / 通道关闭 rc 7 / 判不出 Router rc 6
  list [--tail N] [--unread] [--line <子串>] [--json]   列（文件行序，不按时刻排）
  show <id>                                              一条全文（主档 / 归档档都找）
  claim --through <id> [--apply]                         推游标（缺省 dry-run）
  claim --all --i-read-all [--apply]                     认掉全部（未认领 >3 条 ⇒ rc 2）
  unclaim [--last-batch | --all] [--apply]               回退游标（缺省 dry-run）
  drop --last [--apply]                                  删主档末行（唯一手工修数据口）
  count [--json]                                         未认领 / 总数 / 最新 3
  rotate [--max-bytes N] [--apply]                        手动切档（缺省 dry-run；生产别带 N）
  off | on                                              关 / 开通道（.off 文件）

退出码：0 成功/dry-run · 1 写失败或抢锁超时（调用方退回实时） · 2 用法错
        · 4 claim --through 的 id 失效（游标不动） · 6 判不出 Router · 7 .off 在`;

function argvHas(argv, f) { return argv.includes(f); }
function argvVal(argv, f, d) { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; }

async function withDataLock(fn) {
  const lock = acquireTickLock('router-inbox', { waitMs: 200, ttlMs: 30_000 });
  if (!lock.ok) return { ok: false, rc: EXIT.FAIL, reason: `抢锁失败（${lock.reason}）` };
  try {
    return await fn();
  } finally {
    try { lock.release(); } catch { /* ignore */ }
  }
}

async function cmdPush(argv) {
  const text = argvVal(argv, '--text');
  const kind = String(argvVal(argv, '--kind', 'report') ?? 'report').toLowerCase();
  if (!text || !String(text).trim()) {
    process.stderr.write('❌ 缺 --text（空正文不静默：静默一条空行等于吞掉一次汇报）\n');
    return EXIT.USAGE;
  }
  if (!KINDS.includes(kind)) {
    process.stderr.write(`❌ --kind 只支持 ${KINDS.join('|')}；收到 "${kind}"\n`);
    return EXIT.USAGE;
  }
  const fromSid = argvVal(argv, '--from', null);
  const fromTitle = argvVal(argv, '--title', null);
  const line = argvVal(argv, '--line', null) || lineFromTitle(fromTitle);
  const res = await withDataLock(async () => {
    const p = paths();
    if (fs.existsSync(p.off)) {
      process.stderr.write('✗ 静默通道关闭（router-inbox.off 在）—— 调用方应退回实时投递，别丢信\n');
      appendOps({ verb: 'inbox-push', ok: false, rc: EXIT.OFF, bytes: 0, line, reason: 'off' });
      return EXIT.OFF;
    }
    const target = await resolveRouterTarget({ apply: true });
    if (!target) {
      process.stderr.write('✗ 判不出 Router（target 档缺/过期 且 session.list 里没有唯一的「主路由」）—— 调用方应退回实时投递\n');
      appendOps({ verb: 'inbox-push', ok: false, rc: EXIT.NO_TARGET, bytes: 0, line, reason: 'no-target' });
      return EXIT.NO_TARGET;
    }
    const { row, truncated } = buildRow({
      text, line, kind,
      from: fromSid || fromTitle ? { sid: fromSid, title: fromTitle } : null,
    });
    try {
      fs.mkdirSync(p.home, { recursive: true });
      fs.appendFileSync(p.inbox, JSON.stringify(row) + '\n', 'utf8');
    } catch (e) {
      process.stderr.write(`✗ 写入失败：${e?.message ?? e}\n`);
      appendOps({ verb: 'inbox-push', ok: false, rc: EXIT.FAIL, bytes: 0, line, reason: 'write-error' });
      return EXIT.FAIL;
    }
    const bytes = Buffer.byteLength(row.text, 'utf8');
    appendOps({ verb: 'inbox-push', ok: true, rc: 0, bytes, line, id: row.id, kind, truncated });
    process.stdout.write(`${row.id}\n`);
    if (truncated) process.stderr.write(`⚠️ 正文超 ${TEXT_MAX} 字 ⇒ 已截断入库（rc 仍 0）\n`);
    // 切档执行者 = push 自己（方案 §4.2 切档第一行）
    try {
      const r = rotateLocked({ apply: true });
      noteRotateResult(r, { apply: true });
    } catch (e) {
      appendOps({ verb: 'rotate-deferred', ok: false, rc: 0, reason: 'exception', error: e?.message ?? String(e) });
    }
    return EXIT.OK;
  });
  if (res?.ok === false) {
    process.stderr.write(`✗ ${res.reason}\n`);
    return res.rc ?? EXIT.FAIL;
  }
  return typeof res === 'number' ? res : EXIT.OK;
}

function fmtRow(o, { full = false } = {}) {
  const t = full ? String(o.text ?? '') : String(o.text ?? '').replace(/\s+/g, ' ').slice(0, 100);
  const from = o.from?.title ? ` ‹${o.from.title}›` : '';
  return `[${o.id}] ${o.at ?? ''} · ${o.line ?? 'unknown'}${from} · ${o.kind ?? '?'}${o.truncated ? ' · 截断' : ''}\n    ${t}`;
}

async function cmdList(argv) {
  const asJson = argvHas(argv, '--json');
  const unreadOnly = argvHas(argv, '--unread');
  const lineFilter = argvVal(argv, '--line', '');
  const tailN = Number(argvVal(argv, '--tail', '20'));
  const p = paths();
  const lines = splitInbox(readFileSafe(p.inbox));
  const state = readState(p.state);
  const { unread } = computeUnread(lines, state);
  let rows = unreadOnly ? unread : lines.map(parseInboxLine).filter(Boolean);
  if (lineFilter) rows = rows.filter((o) => String(o.line ?? '').includes(lineFilter));
  const total = rows.length;
  if (Number.isFinite(tailN) && tailN > 0) rows = rows.slice(-tailN);
  if (asJson) {
    process.stdout.write(JSON.stringify({
      total, shown: rows.length, unread: unread.length,
      claimedThrough: state.claimedThrough ?? null, items: rows,
    }, null, 2) + '\n');
    return EXIT.OK;
  }
  process.stdout.write(`静默来信：共 ${total} 条${lineFilter ? `（--line "${lineFilter}"）` : ''} · 未认领 ${unread.length} · 游标 ${state.claimedThrough?.id ?? '(无)'}\n`);
  for (const o of rows) process.stdout.write(fmtRow(o) + '\n');
  if (!rows.length) process.stdout.write('（空）\n');
  return EXIT.OK;
}

async function cmdShow(argv) {
  const id = String(argv[1] ?? '').trim();
  if (!id || id.startsWith('--')) {
    process.stderr.write('❌ 用法：router-inbox show <id>\n');
    return EXIT.USAGE;
  }
  const p = paths();
  for (const raw of splitInbox(readFileSafe(p.inbox))) {
    const o = parseInboxLine(raw);
    if (o && o.id === id) { process.stdout.write(fmtRow(o, { full: true }) + '\n'); return EXIT.OK; }
  }
  const ym = yyyymm(new Date());
  for (const a of listArchives(p.home, ym)) {
    for (const raw of splitInbox(readFileSafe(a.file))) {
      const o = parseInboxLine(raw);
      if (o && o.id === id) {
        process.stdout.write(fmtRow(o, { full: true }) + `\n（已在归档档 ${path.basename(a.file)}）\n`);
        return EXIT.OK;
      }
    }
  }
  process.stderr.write(`✗ 找不到 ${id}（主档与本月归档档都没有）\n`);
  return EXIT.FAIL;
}

async function cmdClaim(argv) {
  const apply = argvHas(argv, '--apply');
  const all = argvHas(argv, '--all');
  const through = argvVal(argv, '--through', null);
  const iReadAll = argvHas(argv, '--i-read-all');
  const p = paths();
  const lines = splitInbox(readFileSafe(p.inbox));
  const state = readState(p.state);
  const { unread, cursorIndex } = computeUnread(lines, state);

  if (all) {
    if (!iReadAll) {
      process.stderr.write('❌ claim --all 必须同时给 --i-read-all（防手滑一把清空）\n');
      return EXIT.USAGE;
    }
    if (unread.length > 3) {
      process.stderr.write(`❌ 未认领 ${unread.length} 条 > 3 ⇒ 拒接 --all（先读、再用 --through <id> 一条条推）\n`);
      return EXIT.USAGE;
    }
    process.stderr.write(`⚠️ 红字提醒：claim --all 会把**未读的 ${unread.length} 条也一起认掉**（游标推到末条）\n`);
    const lastRow = parseInboxLine(lines[lines.length - 1]);
    if (!lastRow) { process.stderr.write('✗ 主档空（没有可认领的行）\n'); return EXIT.FAIL; }
    if (!apply) {
      process.stdout.write(`[dry-run] 将把游标从 ${state.claimedThrough?.id ?? '(无)'} 推到末条 ${lastRow.id}\n（加 --apply 真写）\n`);
      return EXIT.OK;
    }
    return withDataLock(async () => {
      const s = readState(p.state);
      const next = { ...s, prevClaimedThrough: s.claimedThrough ?? null, claimedThrough: { id: lastRow.id, at: nowIso() }, updatedAt: nowIso(), schemaVersion: 1 };
      writeJsonAtomic(p.state, next);
      appendOps({ verb: 'inbox-claim', ok: true, rc: 0, through: lastRow.id, mode: 'all' });
      process.stdout.write(`✅ 游标 → ${lastRow.id}（--all）\n`);
      return EXIT.OK;
    });
  }

  if (!through) {
    process.stderr.write('❌ 用法：claim --through <id> [--apply]（或 claim --all --i-read-all）\n');
    return EXIT.USAGE;
  }
  // 三态：① 等于当前游标 ⇒ 幂等 rc 0 ② 主档里找不到 ⇒ rc 4（游标不动）③ 在归档档 ⇒ rc 4 + 提示
  const idx = lines.findIndex((l) => parseInboxLine(l)?.id === through);
  const curId = state.claimedThrough?.id ?? null;
  if (curId && curId === through) {
    process.stdout.write(`（幂等）游标已经是 ${through}\n`);
    return EXIT.OK;
  }
  if (idx < 0) {
    const inArch = archivedIds(p.home, yyyymm(new Date())).has(through);
    if (inArch) process.stderr.write(`✗ ${through} 已在归档档（说明这条早就认领过）—— 别再认它，游标不动\n`);
    else process.stderr.write(`✗ ${through} 不在主档 —— 游标不动（禁"找不到就推末尾"：那等于吞未读）\n`);
    return EXIT.STALE_ID;
  }
  if (curId) {
    const curIdx = lines.findIndex((l) => parseInboxLine(l)?.id === curId);
    if (curIdx >= 0 && idx <= curIdx) {
      process.stdout.write(`（幂等）${through} 不晚于当前游标 ${curId}（第 ${idx + 1} 行 vs 第 ${curIdx + 1} 行）⇒ 不后退\n`);
      return EXIT.OK;
    }
  }
  if (!apply) {
    process.stdout.write(`[dry-run] 将把游标 ${curId ?? '(无)'} → ${through}（那时未认领 ${unread.length} 条）\n（加 --apply 真写）\n`);
    return EXIT.OK;
  }
  return withDataLock(async () => {
    const s = readState(p.state);
    const next = { ...s, prevClaimedThrough: s.claimedThrough ?? null, claimedThrough: { id: through, at: nowIso() }, updatedAt: nowIso(), schemaVersion: 1 };
    writeJsonAtomic(p.state, next);
    appendOps({ verb: 'inbox-claim', ok: true, rc: 0, through, mode: 'through' });
    process.stdout.write(`✅ 游标 → ${through}\n`);
    return EXIT.OK;
  });
}

async function cmdUnclaim(argv) {
  const apply = argvHas(argv, '--apply');
  const all = argvHas(argv, '--all');
  const p = paths();
  const state = readState(p.state);
  if (all) {
    process.stderr.write('⚠️ 红字警告：unclaim --all 会清空游标 ⇒ 全历史重新算未认领（槽位会出现一大批）\n');
    if (!apply) { process.stdout.write('[dry-run] 将清空游标\n（加 --apply 真写）\n'); return EXIT.OK; }
    return withDataLock(async () => {
      const s = readState(p.state);
      writeJsonAtomic(p.state, { ...s, prevClaimedThrough: s.claimedThrough ?? null, claimedThrough: null, updatedAt: nowIso(), schemaVersion: 1 });
      appendOps({ verb: 'inbox-unclaim', ok: true, rc: 0, mode: 'all' });
      process.stdout.write('✅ 游标已清空\n');
      return EXIT.OK;
    });
  }
  const prev = state.prevClaimedThrough ?? null;
  if (!apply) {
    process.stdout.write(`[dry-run] 将把游标 ${state.claimedThrough?.id ?? '(无)'} 回退到 ${prev?.id ?? '(无 = 清空)'}（--last-batch）\n（加 --apply 真写）\n`);
    return EXIT.OK;
  }
  return withDataLock(async () => {
    const s = readState(p.state);
    writeJsonAtomic(p.state, {
      ...s,
      claimedThrough: s.prevClaimedThrough ?? null,
      prevClaimedThrough: null,
      updatedAt: nowIso(),
      schemaVersion: 1,
    });
    appendOps({ verb: 'inbox-unclaim', ok: true, rc: 0, mode: 'last-batch' });
    process.stdout.write(`✅ 游标已回退到 ${s.prevClaimedThrough?.id ?? '(清空)'}\n`);
    return EXIT.OK;
  });
}

async function cmdDrop(argv) {
  if (!argvHas(argv, '--last')) { process.stderr.write('❌ 用法：drop --last [--apply]（唯一允许的手工修数据口）\n'); return EXIT.USAGE; }
  const apply = argvHas(argv, '--apply');
  const p = paths();
  const lines = splitInbox(readFileSafe(p.inbox));
  if (!lines.length) { process.stdout.write('（主档空，没得删）\n'); return EXIT.OK; }
  const last = lines[lines.length - 1];
  const o = parseInboxLine(last);
  if (!apply) {
    process.stdout.write(`[dry-run] 将删主档末行：${o ? `[${o.id}] ${String(o.line ?? '')} · ${String(o.text ?? '').slice(0, 60)}` : '（坏行）'}\n（加 --apply 真写）\n`);
    return EXIT.OK;
  }
  return withDataLock(async () => {
    const all = splitInbox(readFileSafe(p.inbox));
    const keep = all.slice(0, -1);
    const tmp = `${p.inbox}.tmp`;
    fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
    fs.renameSync(tmp, p.inbox);
    appendOps({ verb: 'inbox-drop', ok: true, rc: 0, id: o?.id ?? null });
    process.stdout.write(`✅ 已删末行${o ? ` ${o.id}` : ''}\n`);
    return EXIT.OK;
  });
}

async function cmdCount(argv) {
  const p = paths();
  const lines = splitInbox(readFileSafe(p.inbox));
  const state = readState(p.state);
  const { unread } = computeUnread(lines, state);
  const latest = unread.slice(-3).map((o) => ({ id: o.id, line: o.line, kind: o.kind, text: String(o.text ?? '').slice(0, 80) }));
  if (argvHas(argv, '--json')) {
    process.stdout.write(JSON.stringify({ unread: unread.length, total: lines.length, latest, claimedThrough: state.claimedThrough ?? null }, null, 2) + '\n');
    return EXIT.OK;
  }
  process.stdout.write(`未认领 ${unread.length} 条 · 主档 ${lines.length} 行 · 游标 ${state.claimedThrough?.id ?? '(无)'}\n`);
  for (const o of unread.slice(-3)) process.stdout.write(`  · ${o.line} → ${String(o.text ?? '').replace(/\s+/g, ' ').slice(0, 60)}\n`);
  return EXIT.OK;
}

async function cmdRotate(argv) {
  const apply = argvHas(argv, '--apply');
  const mb = Number(argvVal(argv, '--max-bytes', '0'));
  const r = rotateLocked({ maxBytes: Number.isFinite(mb) && mb > 0 ? mb : undefined, apply });
  const p = paths();
  process.stdout.write(`${apply ? '[apply]' : '[dry-run]'} rotate：${r.rotated
    ? `将搬 ${r.moved} 行 → ${path.basename(r.archive ?? '')}，主档留 ${r.kept} 行`
    : `不切（${r.reason}${r.size ? ` · 主档 ${r.size} B` : ''}）`}\n`);
  if (!apply) {
    if (!r.rotated && (r.reason === 'no-cursor' || r.reason === 'cursor-missing')) process.stdout.write('（游标没推进过 / 找不到 ⇒ 按方案不切；这是 fail-safe）\n');
    else process.stdout.write('（加 --apply 真切）\n');
    return EXIT.OK;
  }
  noteRotateResult(r, { apply: true });
  return r.rotated ? EXIT.OK : EXIT.OK;
}

function cmdOffOn(on) {
  const p = paths();
  try {
    fs.mkdirSync(p.home, { recursive: true });
    if (on) {
      if (fs.existsSync(p.off)) fs.unlinkSync(p.off);
      process.stdout.write('✅ 静默通道已开（.off 已摘）\n');
    } else {
      fs.writeFileSync(p.off, '', 'utf8');
      process.stdout.write('✅ 静默通道已关（写 .off；此时 push rc 7、槽位段为空 —— 调用方退回实时投递）\n');
    }
    return EXIT.OK;
  } catch (e) {
    process.stderr.write(`✗ 写 .off 失败：${e?.message ?? e}\n`);
    return EXIT.FAIL;
  }
}

async function main(argv = process.argv.slice(2)) {
  const verb = argv[0];
  if (!verb || verb === '--help' || verb === '-h') {
    process.stdout.write(HELP + '\n');
    return verb ? EXIT.OK : EXIT.USAGE;
  }
  if (verb === 'push') return await cmdPush(argv);
  if (verb === 'list') return await cmdList(argv);
  if (verb === 'show') return await cmdShow(argv);
  if (verb === 'claim') return await cmdClaim(argv);
  if (verb === 'unclaim') return await cmdUnclaim(argv);
  if (verb === 'drop') return await cmdDrop(argv);
  if (verb === 'count') return await cmdCount(argv);
  if (verb === 'rotate') return await cmdRotate(argv);
  if (verb === 'off') return cmdOffOn(false);
  if (verb === 'on') return cmdOffOn(true);
  process.stderr.write(`未知动词：${verb}\n\n${HELP}\n`);
  return EXIT.USAGE;
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

export { paths, cmdOffOn };
