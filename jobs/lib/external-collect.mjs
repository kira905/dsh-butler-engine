// dsh-butler / lib/external-collect.mjs —— P6 采集层（抓取 + 归一化 + 快照 IO）
//
// 职责边界：本模块只「把外部源抓回来、整成可比较的快照」，不做判定/冷却/通知
//   （判定见 external-diff.mjs，通知复用 P2 的 lib/watch-policy.mjs + lib/watch-notify.mjs）。
//
// 三条硬约束：
//   1. **全只读**：只 GET 公开数据；.credentials.yaml 的 key 只在本机进程内使用（绝不落日志/快照/外发）。
//   2. **失败不抛**：任何采集失败都转成 {ok:false, reason, error}，由 tick 做连续失败计数（单次失败是网络常态）。
//   3. **page-diff 双读确认**：spike A3 实测 status.deepseek.com（Next.js）首轮偶发渲染抖动
//      （同一秒两次拉取 hash 不同）→ 默认采样 2~3 次、两次一致才认，抖动则本次不出结论。
//
// 纯 node fetch，0 token。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { DEFAULTS, snapshotRoot } from './external-sources.mjs';
import { ensureDir, dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { readJson, writeJsonAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { snapshotSignals } from './external-incident-lexicon.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../src/lib/production-guard.mjs';

/** 唯一删口（R-065）：dry-run 是本函数**第一条**可执行语句；被拒 ⇒ 返回 false（调用方按「没删」处理）。 */
function removeGuarded(target, { whitelist, reason = null, dryRun = false, allowReparse = false, op = '删文件' } = {}) {
  if (dryRun === true) return false;
  const g = gateDestructive({
    targets: [{ path: target, label: reason }], whitelist, op, scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return false;
  try { fs.rmSync(target, { force: true }); return true; } catch { return false; }
}

/** 唯一搬移口（R-065）：同卷 rename 的**原子替换**语义。dry-run 同样是第一条可执行语句。 */
function renameGuarded(from, to, { whitelist, reason = null, dryRun = false, allowReparse = false } = {}) {
  if (dryRun === true) return { ok: true, dryRun: true, code: 'dry-run', reason: 'dry-run（零动作）' };
  const g = gateDestructive({
    targets: [{ path: from, label: 'src' }, { path: to, label: 'dst' }], whitelist, op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return { ok: false, code: g.code, reason: g.reason };
  try { fs.renameSync(from, to); return { ok: true, code: null, reason: g.reason }; }
  catch (e) { return { ok: false, code: 'fs-error', reason: String(e?.message ?? e) }; }
}


export const EXTERNAL_COLLECT_VERSION = '0.1.0';

const UA = 'dsh-butler-external/0.1 (local read-only monitor)';

/** 状态页 indicator → 语义档（statuspage 标准四档 + unknown）。 */
export const STATUS_LEVELS = {
  none: { order: 0, label: '正常' },
  maintenance: { order: 1, label: '维护中' },
  minor: { order: 2, label: '部分降级' },
  major: { order: 3, label: '重大故障' },
  critical: { order: 4, label: '严重故障' },
};

// ------------------------------------------------------------------ 凭证

/**
 * 从本机 ~/.dsh/.credentials.yaml 的 refs 段取 key（**只在本机用**）。
 * 该文件是结构化 YAML（version / refs / records 三段），refs 项缩进 4 空格。
 * @returns {string|null}
 */
export function readCredentialRef(ref, opts = {}) {
  const name = String(ref ?? '').trim();
  if (!name) return null;
  const file = opts.credentialsFile ?? path.join(opts.home ?? dshHome(), '.credentials.yaml');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let inRefs = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^[A-Za-z_]/.test(line)) break; // 离开 refs 段（下一顶层键）
    if (!inRefs) continue;
    const m = new RegExp(`^\\s{2,}${name}\\s*:\\s*(.+?)\\s*,?\\s*$`).exec(line);
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v || null;
    }
  }
  return null;
}

/** 脱敏 key（日志/提示用；只暴露前 4 位）。 */
export function maskKey(key) {
  const s = String(key ?? '');
  if (!s) return '(missing)';
  return s.length <= 6 ? '***' : `${s.slice(0, 4)}***`;
}

// ------------------------------------------------------------------ 抓取

/**
 * 抓一个 URL（GET，只读）。永不抛。
 * @returns {Promise<{ok:boolean, status:number, bytes:number, text:string|null, ms:number,
 *                    error:string|null, reason:'network'|'http'|'too-large'|null, contentType:string}>}
 */
export async function fetchText(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULTS.timeoutMs);
  const maxBytes = Number(opts.maxBytes ?? DEFAULTS.maxBytes);
  const headers = { 'user-agent': UA, accept: '*/*', 'cache-control': 'no-cache', ...(opts.headers ?? {}) };
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = Date.now() - t0;
    const contentType = r.headers.get('content-type') ?? '';
    if (buf.length > maxBytes) {
      return { ok: false, status: r.status, bytes: buf.length, text: null, ms, contentType, reason: 'too-large', error: `响应 ${buf.length}B 超过上限 ${maxBytes}B` };
    }
    if (!r.ok) {
      return { ok: false, status: r.status, bytes: buf.length, text: buf.toString('utf8').slice(0, 400), ms, contentType, reason: 'http', error: `HTTP ${r.status}` };
    }
    return { ok: true, status: r.status, bytes: buf.length, text: buf.toString('utf8'), ms, contentType, reason: null, error: null };
  } catch (e) {
    return { ok: false, status: 0, bytes: 0, text: null, ms: Date.now() - t0, contentType: '', reason: 'network', error: e?.message ?? String(e) };
  }
}

// ------------------------------------------------------------------ 页面归一化（page-diff 去噪核心）

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/' };

function decodeCode(k) {
  try {
    const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  } catch { return ''; }
}

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#?[a-zA-Z0-9]+);/g, (m, k) => (ENTITIES[k] !== undefined ? ENTITIES[k] : (k[0] === '#' ? decodeCode(k) : m)));
}

/**
 * 正文归一化（方案 §4 P6：「只比对正文文本的归一化 hash，剥 script/style/时间戳类文本」）。
 * 归一化顺序：剥 script/style/svg/noscript/注释 → 剥标签 → 解码实体 → 动态元素归一 → 压空白。
 */
export function normalizePageText(html, opts = {}) {
  let t = String(html ?? '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<template[\s\S]*?<\/template>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<[^>]*>/g, ' ');
  t = decodeEntities(t);
  t = t.replace(/[ \t\u00a0]+/g, ' ');
  // 动态元素（时间戳 / 相对时间 / 计数 / 百分比 / 耗时）——否则整页 hash 天天变
  t = t.replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '<TS>');
  t = t.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<T>');
  t = t.replace(/\b\d+(?:\.\d+)?\s*(?:%|percent|ms|us|µs|ns|s|sec|secs|seconds?|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/gi, '<N>');
  t = t.replace(/\d+(?:\.\d+)?\s*(?:秒|分钟|小时|天|毫秒)/g, '<N>');
  // 计数器类（方案 v2.4 明确点名：时间戳 / 广告 / 计数器都会让整页 hash 敏感）
  // ⚠️ 中文量词后不能写 \b —— 汉字不是 \w，"次" 与行尾/标点之间不存在词边界（实测踩过）
  t = t.replace(/\d[\d,]*\s*(?:次|人|条|个|位)/g, '<N>');
  t = t.replace(/\b\d[\d,]*\s*(?:views?|visits?|hits?|count)\b/gi, '<N>');
  t = t.replace(/\b(?:just now|\d+\s+(?:seconds?|minutes?|hours?|days?)\s+ago)\b/gi, '<REL>');
  t = t.replace(/<TS>\s*<T>/g, '<TS>');
  t = t.replace(/\s+/g, ' ').trim();
  if (opts.maxChars && t.length > opts.maxChars) t = t.slice(0, opts.maxChars);
  return t;
}

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 页面正文的稳定短摘要（提示里附证据用，不解析语义）。 */
export function excerptOf(text, n = 180) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

// ------------------------------------------------------------------ 三类源采集

function asArray(v) { return Array.isArray(v) ? v : []; }

/** models-api：/v1/models → { ids, fields }。字段白名单外的（如 created）只记录不比对。 */
export function parseModelsBody(text, opts = {}) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return { ok: false, reason: 'format', error: `响应不是 JSON：${e?.message ?? e}` }; }
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null);
  if (!arr) return { ok: false, reason: 'format', error: '响应里没有 data 数组（不是 OpenAI 兼容的 /models 结构？）' };
  const tracked = opts.trackedFields ?? DEFAULTS.trackedModelFields;
  const ids = [];
  const fields = {};
  for (const m of arr) {
    const id = String(m?.id ?? '').trim();
    if (!id) continue;
    ids.push(id);
    const f = {};
    for (const k of tracked) if (m?.[k] !== undefined) f[k] = String(m[k]);
    fields[id] = f;
  }
  ids.sort();
  return { ok: true, ids, fields, count: ids.length, schemaShape: Object.keys(arr[0] ?? {}).sort() };
}

/** status-json：statuspage 标准 { page, status: { indicator, description } }。 */
export function parseStatusBody(text) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return { ok: false, reason: 'format', error: `响应不是 JSON：${e?.message ?? e}` }; }
  const indicator = j?.status?.indicator;
  if (typeof indicator !== 'string' || !indicator) {
    // 404 的 {"code":"RouteNotFound"} 也走这里 —— spike A3 实测 DeepSeek 状态站即此形态
    return { ok: false, reason: 'format', error: '缺少 status.indicator（不是 statuspage 的 api/v2/status.json 结构？建议把该源 kind 改成 page-diff）' };
  }
  const key = indicator.toLowerCase();
  return {
    ok: true,
    indicator: key,
    description: String(j?.status?.description ?? ''),
    pageName: j?.page?.name ?? null,
    pageUpdatedAt: j?.page?.updated_at ?? null,
    known: Object.prototype.hasOwnProperty.call(STATUS_LEVELS, key),
  };
}

/**
 * 采集一个源 → 快照对象。永不抛。
 * @param {object} src normalizeSource 过的源
 * @param {{now?:number, credentialsFile?:string, home?:string, fetchImpl?:Function}} [opts]
 * @returns {Promise<{ok:boolean, kind:string, snapshot:object|null, reason:string|null, error:string|null,
 *                    ms:number, notes:string[], raw:{bytes:number, status:number}}>}
 */
export async function collectSource(src, opts = {}) {
  const now = opts.now ?? Date.now();
  const notes = [];
  const t0 = Date.now();
  const headers = {};
  if (src.keyRef) {
    const key = readCredentialRef(src.keyRef, opts);
    if (!key) {
      return {
        ok: false, kind: src.kind, snapshot: null, reason: 'credential', ms: 0, raw: { bytes: 0, status: 0 },
        error: `凭证 ${src.keyRef} 不在 ~/.dsh/.credentials.yaml 的 refs（key 只在本机读取）`, notes,
      };
    }
    headers.authorization = `Bearer ${key}`;
  }

  if (src.kind === 'models-api') {
    const r = await fetchText(src.url, { ...opts, timeoutMs: src.timeoutMs, headers });
    if (!r.ok) return { ok: false, kind: src.kind, snapshot: null, reason: r.reason, error: r.error, ms: r.ms, raw: { bytes: r.bytes, status: r.status }, notes };
    const p = parseModelsBody(r.text, opts);
    if (!p.ok) return { ok: false, kind: src.kind, snapshot: null, reason: p.reason, error: p.error, ms: r.ms, raw: { bytes: r.bytes, status: r.status }, notes };
    const snapshot = {
      kind: 'models-api', fetchedAt: now, url: src.url, count: p.count, ids: p.ids, fields: p.fields,
      idsHash: hashText(p.ids.join('\n')), schemaShape: p.schemaShape ?? [],
    };
    return { ok: true, kind: src.kind, snapshot, reason: null, error: null, ms: Date.now() - t0, raw: { bytes: r.bytes, status: r.status }, notes };
  }

  if (src.kind === 'status-json') {
    const r = await fetchText(src.url, { ...opts, timeoutMs: src.timeoutMs, headers });
    if (!r.ok) return { ok: false, kind: src.kind, snapshot: null, reason: r.reason, error: r.error, ms: r.ms, raw: { bytes: r.bytes, status: r.status }, notes };
    const p = parseStatusBody(r.text);
    if (!p.ok) return { ok: false, kind: src.kind, snapshot: null, reason: p.reason, error: p.error, ms: r.ms, raw: { bytes: r.bytes, status: r.status }, notes };
    if (!p.known) notes.push(`未知 indicator "${p.indicator}"（按最保守档处理）`);
    const snapshot = {
      kind: 'status-json', fetchedAt: now, url: src.url,
      indicator: p.indicator, description: p.description, pageName: p.pageName, pageUpdatedAt: p.pageUpdatedAt,
    };
    return { ok: true, kind: src.kind, snapshot, reason: null, error: null, ms: Date.now() - t0, raw: { bytes: r.bytes, status: r.status }, notes };
  }

  if (src.kind === 'page-diff') {
    // 双读确认：同一秒两次渲染可能不同（实测 Next.js 状态页首轮抖动）→ 两次一致才认
    const attempts = Math.max(2, Math.min(4, Number(opts.doubleReadAttempts ?? DEFAULTS.doubleReadAttempts)));
    const samples = [];
    for (let i = 0; i < attempts; i += 1) {
      const r = await fetchText(src.url, { ...opts, timeoutMs: src.timeoutMs, headers });
      if (!r.ok) {
        if (samples.length) { notes.push(`双读第 ${i + 1} 次失败（${r.error}），用已有采样`); break; }
        return { ok: false, kind: src.kind, snapshot: null, reason: r.reason, error: r.error, ms: r.ms, raw: { bytes: r.bytes, status: r.status }, notes };
      }
      const text = normalizePageText(r.text);
      // R-048：正文故障语义（纯函数 · 词表集中在 lib/external-incident-lexicon.mjs）
      //   为什么在采集层算而不是判定层算：判定层只拿到快照（**不存全文**），
      //   而故障关键词可能在 excerpt 的 180 字之外 ⇒ 必须在有全文的这一层扫。
      const sample = { hash: hashText(text), textLen: text.length, excerpt: excerptOf(text), bytes: r.bytes, status: r.status, at: Date.now(), signals: snapshotSignals(text, { contextWindow: src.incidentContextWindow ?? DEFAULTS.incidentContextWindow }) };
      const dup = samples.find((s) => s.hash === sample.hash);
      samples.push(sample);
      if (dup) {
        return {
          ok: true, kind: src.kind, reason: null, error: null, ms: Date.now() - t0, notes,
          raw: { bytes: sample.bytes, status: sample.status },
          snapshot: { kind: 'page-diff', fetchedAt: now, url: src.url, hash: sample.hash, textLen: sample.textLen, excerpt: sample.excerpt, samples: samples.length, signals: sample.signals },
        };
      }
    }
    // 全部采样互不相同 = 页面渲染抖动 → 本次不出结论（不更新快照，不产生事件）
    notes.push(`双读 ${samples.length} 次 hash 互不相同（页面渲染抖动）→ 本次跳过，保留旧快照`);
    return {
      ok: true, kind: src.kind, reason: null, error: null, ms: Date.now() - t0, notes,
      unstable: true, snapshot: null, raw: { bytes: samples[samples.length - 1]?.bytes ?? 0, status: samples[samples.length - 1]?.status ?? 0 },
      sampleInfo: samples.map((s) => ({ hash: s.hash.slice(0, 12), textLen: s.textLen })),
    };
  }

  return { ok: false, kind: src.kind, snapshot: null, reason: 'kind', error: `未知 kind：${src.kind}`, ms: 0, raw: { bytes: 0, status: 0 }, notes };
}

// ------------------------------------------------------------------ 快照 IO

export function snapshotDirFor(src, opts = {}) {
  const root = opts.snapshotRoot ?? snapshotRoot(opts);
  return path.join(root, src.id);
}

/** 读最新快照（不存在 → null）。 */
export function readLatestSnapshot(src, opts = {}) {
  const file = path.join(snapshotDirFor(src, opts), 'latest.json');
  try {
    return readJson(file, { schemaVersion: null, home: opts.home });
  } catch { return null; }
}

/**
 * 写快照（原子写 + 保留最近 keepSnapshots 份）。
 * 文件名用本地时间 yyyymmdd-hhmmss（人可读、可排序）；latest.json 是同一份的副本。
 */
export function writeSnapshot(src, snapshot, opts = {}) {
  const now = opts.now ?? Date.now();
  const dir = snapshotDirFor(src, opts);
  ensureDir(dir);
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const file = path.join(dir, `${stamp}.json`);
  const payload = { schemaVersion: 1, sourceId: src.id, at: new Date(now).toISOString(), ...snapshot };
  writeJsonAtomic(file, payload, {});
  writeJsonAtomic(path.join(dir, 'latest.json'), payload, {});
  // 保留最近 N 份（按文件名倒序；latest.json 不算份数）
  const keep = Number(opts.keepSnapshots ?? DEFAULTS.keepSnapshots);
  let removed = 0;
  try {
    const files = fs.readdirSync(dir).filter((f) => /^\d{8}-\d{6}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      if (removeGuarded(path.join(dir, f), { whitelist: [dir], reason: '外部采集快照保留上限' })) removed += 1;
    }
  } catch { /* 清理失败不影响本次采集 */ }
  return { ok: true, file, removed };
}

/** 列出某源的快照（新→旧）。 */
export function listSnapshots(src, opts = {}) {
  const dir = snapshotDirFor(src, opts);
  try {
    return fs.readdirSync(dir).filter((f) => /^\d{8}-\d{6}\.json$/.test(f)).sort().reverse()
      .map((f) => ({ name: f, file: path.join(dir, f) }));
  } catch { return []; }
}

/** 本机标识（报告/状态输出用）。 */
export function deviceName() {
  return os.hostname();
}
