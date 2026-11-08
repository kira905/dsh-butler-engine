// dsh-butler / lib/external-discovery.mjs —— P6 自动探源（卡：源清单随本机实况自动变化）
//
// 方案与五轮审核：docs\P6自动探源-方案与审核-20260912.md
//
// 职责边界（**只做发现，不做启用**）：
//   ① 依据指纹（凭证键名 / settings.yaml 渠道结构 / 模板库）判断「要不要复核」——不做每小时傻扫；
//   ② 对**已知模板**里「有凭证或渠道在用、但源清单没有」的供应商，按模板探测候选端点；
//   ③ 探测通过（判据见 evaluateProbe）→ 只落**候选**（注册表顶层 candidates，enabled 概念不存在）；
//   ④ 模板里没有的供应商 → 只报 unknown，绝不探测（无模板 = 不许把 key 发到未登记域名）。
//
// 硬约束（与 external-collect 一致）：
//   · 全只读外部数据；key 只在本机进程内使用，绝不落日志/状态/日报；
//   · 探测端点白名单 = 模板里出现过的 URL 集合（严格相等），永不按输入拼域名；
//   · 失败不抛：任何异常都转成 {ok:false, state, detail}，由调用方决定怎么记；
//   · **发现结果永不进 P2 的 events 管道**（否则会触发推送/冷却，变成打扰）。
//
// 依赖方向：本模块 → external-sources（定义/注册表）+ external-collect（抓取/解析）。
// 反向依赖不存在（external-collect 只依赖 external-sources），故不构成循环。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  PROVIDER_TEMPLATES, normalizeSource, readRegistry, readCredentialKeyNames, suggestSources, templateSources,
} from './external-sources.mjs';
import {
  fetchText, readCredentialRef, parseModelsBody, parseStatusBody, normalizePageText, hashText,
} from './external-collect.mjs';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';

export const EXTERNAL_DISCOVERY_VERSION = '0.1.0';

/** 探测与容量参数（写死；单测可覆盖）。 */
export const DISCOVERY_DEFAULTS = {
  /** 单请求超时（比采集的 20s 短——发现是后台动作，不许拖 tick）。 */
  probeTimeoutMs: 8_000,
  /** 一轮发现的网络总预算：超过就停手，剩下的候选留到下一轮。 */
  totalBudgetMs: 20_000,
  /** 一轮最多发几个请求（page-diff 双读算 2 个）。 */
  maxRequests: 4,
  /** 候选上限（超出丢最旧且未被否的）。 */
  maxCandidates: 20,
  /** 否决名单上限。 */
  maxRejected: 50,
  /** 指纹不变时的兜底复核间隔（只在上轮「有未决」时才跑）。 */
  fallbackMs: 7 * 86_400_000,
  /** page-diff 候选的归一化正文门槛（反例：status.bigmodel.cn 归一化仅 14 字，是 JS 空壳页）。 */
  pageDiffMinChars: 300,
};

const API_KEY_RE = /(_API_KEY|_KEY|_TOKEN|_SECRET)$/i;

function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/** 只留 host 判定用：是否本地地址（本地栈不是「外部源」）。 */
export function isLocalHost(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local');
  } catch { return false; }
}

// ------------------------------------------------------------------ 实况：渠道事实

/**
 * 读 settings.yaml 里的**渠道实况**（只取结构：渠道名 / apiKeyEnv / baseURL / apiUrl；绝不取值）。
 * 覆盖两处：
 *   · `llm-pi-ai.providers.<name>.{apiKeyEnv,baseURL}`（对话/模型渠道）
 *   · `dsh-imagegen.channels[].{id,name,apiUrl}`（生图渠道）
 * 本地地址（localhost/127.0.0.1）一律标 local 并由调用方过滤。
 * @returns {{ok:boolean, file:string, channels:Array<{provider:string,keyRef:string|null,baseURL:string|null,origin:string|null,source:string,local:boolean}>, error?:string}}
 */
export function readChannelFacts(opts = {}) {
  const file = opts.settingsFile ?? path.join(opts.home ?? dshHome(), 'settings.yaml');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, file, channels: [], error: 'unreadable' }; }
  const lines = raw.split(/\r?\n/);
  const map = new Map();
  const push = (provider, patch) => {
    const cur = map.get(provider) ?? { provider, keyRef: null, baseURL: null, source: patch.source };
    map.set(provider, { ...cur, ...patch });
  };
  const blockAfter = (idx, indent) => {
    const out = [];
    for (let j = idx + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (!l.trim()) continue;
      const ind = l.length - l.trimStart().length;
      if (ind <= indent) break;
      out.push({ text: l, indent: ind });
    }
    return out;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^(\s*)([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (!head) continue;
    const indent = head[1].length;
    const key = head[2];
    if (key === 'providers') {
      const block = blockAfter(i, indent);
      let cur = null;
      for (const { text, indent: ind } of block) {
        const m = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(text);
        if (!m) continue;
        const val = m[2].trim().replace(/^['"]|['"]$/g, '');
        if (ind === indent + 2 && !val) { cur = m[1]; push(cur, { source: 'llm-pi-ai.providers' }); continue; }
        if (!cur) continue;
        if (m[1] === 'apiKeyEnv' && val) push(cur, { keyRef: val });
        if (m[1] === 'baseURL' && val) push(cur, { baseURL: val, origin: originOf(val) });
      }
    } else if (key === 'channels') {
      const block = blockAfter(i, indent);
      let cur = null;
      for (const { text } of block) {
        const idm = /^\s*-\s*id:\s*(\S+)\s*$/.exec(text);
        if (idm) { cur = idm[1].replace(/['"]/g, ''); push(cur, { source: 'dsh-imagegen.channels' }); continue; }
        if (!cur) continue;
        const m = /^\s*(apiUrl|baseURL):\s*(\S+)\s*$/.exec(text);
        if (m) push(cur, { baseURL: m[2].replace(/['"]/g, ''), origin: originOf(m[2]) });
      }
    }
  }
  const channels = [...map.values()].map((c) => ({
    ...c,
    local: c.baseURL ? isLocalHost(c.baseURL) : false,
    origin: c.baseURL ? originOf(c.baseURL) : null,
  }));
  return { ok: true, file, channels };
}

function originOf(url) {
  try { const u = new URL(String(url)); return `${u.protocol}//${u.host}`; } catch { return null; }
}

// ------------------------------------------------------------------ 指纹

/**
 * 依据指纹（三份；**只哈希键名与结构，不含任何 key 值**）。
 * 任一份变化 = 主人动了实况（增删凭证 / 装渠道 / 换 baseURL / 模板升级）→ 该复核源清单。
 */
export function discoveryBasis(opts = {}) {
  const home = opts.home ?? dshHome();
  const keys = opts.keys ?? readCredentialKeyNames({ home, credentialsFile: opts.credentialsFile });
  const ch = opts.channelFacts ?? readChannelFacts({ home, settingsFile: opts.settingsFile });
  const templates = opts.templates ?? PROVIDER_TEMPLATES;
  const channelLines = (ch.channels ?? [])
    .filter((c) => !c.local)
    .map((c) => `${c.source}:${c.provider}:${c.keyRef ?? '-'}:${c.baseURL ?? '-'}`)
    .sort();
  return {
    credHash: sha256([...keys].sort().join('\n')),
    channelHash: sha256(channelLines.join('\n')),
    templatesHash: sha256(templates.map((t) => `${t.provider}|${t.modelsUrl ?? '-'}|${t.statusUrl ?? '-'}|${(t.keyRefs ?? []).join(',')}`).sort().join('\n')),
  };
}

/** 两份指纹是否不同（键缺失视为不同 → 首跑会跑）。 */
export function basisChanged(prev, cur) {
  if (!prev || typeof prev !== 'object') return true;
  return ['credHash', 'channelHash', 'templatesHash'].some((k) => String(prev[k] ?? '') !== String(cur[k] ?? ''));
}

/** 是否该跑本轮发现（纯函数，单测覆盖）。 */
export function shouldDiscover(prev, cur, now = Date.now(), opts = {}) {
  const fallbackMs = Number(opts.fallbackMs ?? DISCOVERY_DEFAULTS.fallbackMs);
  if (opts.force) return { run: true, reason: 'manual' };
  if (!prev || !prev.lastRunAt) return { run: true, reason: 'first-run' };
  if (basisChanged(prev.basis, cur)) {
    const k = ['credHash', 'channelHash', 'templatesHash'].find((x) => String(prev.basis?.[x] ?? '') !== String(cur[x] ?? ''));
    return { run: true, reason: { credHash: 'credential-changed', channelHash: 'channel-changed', templatesHash: 'templates-changed' }[k] ?? 'basis-changed' };
  }
  const pending = Number(prev.failures ?? 0) > 0 || Number(prev.pending ?? 0) > 0;
  if (pending && now - Number(prev.lastRunAt) >= fallbackMs) return { run: true, reason: 'fallback-7d' };
  return { run: false, reason: 'basis-unchanged' };
}

// ------------------------------------------------------------------ 探测

/** 候选去重键（重探幂等靠它）。 */
export function candidateKey(c) { return `${c?.id ?? ''}|${c?.url ?? ''}`; }

/**
 * 探测单个候选。返回 {ok, state, detail, evidence, requests}
 * state 取值：ok | http-error | network | no-key | format | thin-page | unstable | not-allowed
 * @param {{id:string,url:string,kind:string,keyRef?:string|null,provider?:string}} cand
 */
export async function probeCandidate(cand, opts = {}) {
  const D = { ...DISCOVERY_DEFAULTS, ...(opts.defaults ?? {}) };
  const timeoutMs = Math.max(500, Math.min(Number(opts.timeoutMs ?? D.probeTimeoutMs), Number(opts.budgetLeftMs ?? D.probeTimeoutMs)));
  const home = opts.home ?? dshHome();
  const allow = opts.allowedUrls ?? null; // 白名单集合（未提供 = 不校验，仅内部/测试用）
  const url = String(cand?.url ?? '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, state: 'not-allowed', detail: '端点必须是 http(s)', requests: 0 };
  if (!/^https:/i.test(url) && !isLocalHost(url)) return { ok: false, state: 'not-allowed', detail: '非 https 且非本地端点，拒绝探测', requests: 0 };
  if (allow && !allow.has(url)) return { ok: false, state: 'not-allowed', detail: '端点不在模板白名单内', requests: 0 };

  const kind = String(cand.kind ?? '');
  if (kind === 'models-api') {
    const key = cand.keyRef ? readCredentialRef(cand.keyRef, { home, credentialsFile: opts.credentialsFile }) : null;
    if (cand.keyRef && !key) return { ok: false, state: 'no-key', detail: `凭证 ${cand.keyRef} 有键名但读不到值`, requests: 0 };
    const r = await fetchText(url, { timeoutMs, headers: key ? { authorization: `Bearer ${key}` } : {} });
    if (!r.ok) return { ok: false, state: r.reason === 'network' ? 'network' : 'http-error', detail: r.error ?? `HTTP ${r.status}`, requests: 1 };
    const p = parseModelsBody(r.text);
    if (!p.ok) return { ok: false, state: 'format', detail: p.error ?? '解析失败', requests: 1 };
    if (!(p.count >= 1)) return { ok: false, state: 'format', detail: '模型列表为空', requests: 1 };
    return { ok: true, state: 'ok', detail: `${p.count} 个模型 · 首条 ${p.ids[0]}`, evidence: { count: p.count, first: p.ids[0] }, requests: 1 };
  }
  if (kind === 'status-json') {
    const r = await fetchText(url, { timeoutMs });
    if (!r.ok) return { ok: false, state: r.reason === 'network' ? 'network' : 'http-error', detail: r.error ?? `HTTP ${r.status}`, requests: 1 };
    const p = parseStatusBody(r.text);
    if (!p.ok) return { ok: false, state: 'format', detail: p.error ?? '解析失败', requests: 1 };
    if (!p.known) return { ok: false, state: 'format', detail: `indicator 不在已知白名单：${p.indicator}`, requests: 1 };
    return { ok: true, state: 'ok', detail: `indicator=${p.indicator}`, evidence: { indicator: p.indicator }, requests: 1 };
  }
  if (kind === 'page-diff') {
    const minChars = Number(opts.pageDiffMinChars ?? D.pageDiffMinChars);
    let used = 0;
    const read = async () => {
      const r = await fetchText(url, { timeoutMs });
      used += 1;
      if (!r.ok) return { ok: false, state: r.reason === 'network' ? 'network' : 'http-error', detail: r.error ?? `HTTP ${r.status}` };
      const text = normalizePageText(r.text);
      return { ok: true, text, len: text.length, hash: hashText(text) };
    };
    const a = await read();
    if (!a.ok) return { ...a, requests: used };
    if (a.len < minChars) return { ok: false, state: 'thin-page', detail: `归一化正文仅 ${a.len} 字（门槛 ${minChars}；多半是 JS 空壳页）`, requests: used };
    const b = await read();
    if (!b.ok) return { ...b, requests: used };
    if (a.hash !== b.hash) return { ok: false, state: 'unstable', detail: '双读正文不一致（渲染抖动），本轮不落候选', requests: used };
    return { ok: true, state: 'ok', detail: `归一化 ${a.len} 字 · hash ${a.hash.slice(0, 10)}`, evidence: { chars: a.len, hash: a.hash }, requests: used };
  }
  return { ok: false, state: 'format', detail: `未知 kind：${kind}`, requests: 0 };
}

// ------------------------------------------------------------------ 主流程

/**
 * 跑一轮发现（**不写任何文件**；registry/state 的落盘由调用方决定）。
 * @param {{home?:string, now?:number, registry?:object, keys?:string[], force?:boolean, dryRun?:boolean,
 *          prev?:object, templates?:object[], credentialsFile?:string, settingsFile?:string,
 *          allowedUrls?:Set<string>, fetchImpl?:Function, defaults?:object}} [opts]
 */
export async function runDiscovery(opts = {}) {
  const D = { ...DISCOVERY_DEFAULTS, ...(opts.defaults ?? {}) };
  const now = Number(opts.now ?? Date.now());
  const home = opts.home ?? dshHome();
  const templates = opts.templates ?? PROVIDER_TEMPLATES;
  const registry = opts.registry ?? readRegistry({ home });
  const sources = (registry?.sources ?? []).map((s) => normalizeSource(s));
  const keys = opts.keys ?? readCredentialKeyNames({ home, credentialsFile: opts.credentialsFile });
  const channelFacts = opts.channelFacts ?? readChannelFacts({ home, settingsFile: opts.settingsFile });
  const basis = discoveryBasis({ home, keys, channelFacts, templates });
  const prev = opts.prev ?? null;

  const due = shouldDiscover(prev, basis, now, { force: opts.force, fallbackMs: D.fallbackMs });
  if (!due.run) {
    return { ran: false, reason: due.reason, basis, probed: [], candidates: [], unknown: [], missing: [], requests: 0 };
  }
  // dry-run：只算判断，不发请求、不落任何东西（生产只读验收靠这条）
  if (opts.dryRun) {
    const sug = suggestSources({ registry: { sources }, keys, templates });
    return {
      ran: false, reason: `${due.reason}（dry-run 不探测）`, basis, dryRun: true,
      probed: [], candidates: [], unknown: sug.unknown, missing: sug.missing.map((m) => m.provider), requests: 0,
    };
  }

  const sug = suggestSources({ registry: { sources }, keys, templates });
  const covered = new Set(sources.map((s) => s.provider));
  const rejected = new Set((prev?.rejected ?? []).map(String));
  const known = new Set([
    ...sources.map((s) => candidateKey({ id: s.id, url: s.url })),
    ...(registry?.candidates ?? []).map((c) => candidateKey(c)),
  ]);

  // 渠道实况里「模板库与源清单都没有」的供应商（人工探源），给 URL 套路
  const unmatchedChannels = (channelFacts.channels ?? [])
    .filter((c) => !c.local && c.baseURL && !covered.has(c.provider) && !templates.some((t) => t.provider === c.provider))
    .map((c) => ({ provider: c.provider, baseURL: c.baseURL, keyRef: c.keyRef ?? null, source: c.source, candidates: suggestUrlsFor(c) }));

  const allowedUrls = opts.allowedUrls ?? new Set(templates.flatMap((t) => [t.modelsUrl, t.statusUrl].filter(Boolean)));
  const probePlan = [];
  for (const m of sug.missing) {
    const tpl = templates.find((t) => t.provider === m.provider);
    if (!tpl) continue;
    for (const c of templateSources(tpl, m.keyRef)) {
      if (rejected.has(candidateKey(c)) || known.has(candidateKey(c))) continue;
      probePlan.push({ ...c, provider: m.provider, label: `${m.provider}（自动发现）` });
    }
  }
  // models 优先（信息量最大），同 kind 内保持模板顺序
  probePlan.sort((a, b) => (a.kind === 'models-api' ? 0 : 1) - (b.kind === 'models-api' ? 0 : 1));

  // 预算基准用**真实时钟**（now 参数在测试里是固定值，拿它算耗时必然误判）
  const t0 = Date.now();
  const probed = [];
  let requests = 0;
  for (const cand of probePlan) {
    const spent = Date.now() - t0;
    const left = D.totalBudgetMs - spent;
    if (left <= 500) { probed.push({ ...brief(cand), ok: false, state: 'budget', detail: '本轮预算用尽，留待下一轮' }); continue; }
    const need = cand.kind === 'page-diff' ? 2 : 1;
    if (requests + need > D.maxRequests) { probed.push({ ...brief(cand), ok: false, state: 'budget', detail: '本轮请求数已满，留待下一轮' }); continue; }
    let r;
    try { r = await probeCandidate(cand, { home, credentialsFile: opts.credentialsFile, timeoutMs: D.probeTimeoutMs, budgetLeftMs: left, allowedUrls, pageDiffMinChars: D.pageDiffMinChars, defaults: D, fetchImpl: opts.fetchImpl }); }
    catch (e) { r = { ok: false, state: 'exception', detail: e?.message ?? String(e), requests: 0 }; }
    requests += Number(r.requests ?? 0);
    probed.push({ ...brief(cand), ok: r.ok === true, state: r.state, detail: r.detail ?? null, evidence: r.evidence ?? null, at: new Date().toISOString() });
  }

  const candidates = probed.filter((p) => p.ok).map((p) => ({
    id: p.id, provider: p.provider, kind: p.kind, url: p.url, keyRef: p.keyRef ?? null,
    label: `${p.label ?? p.provider} · ${p.kind === 'models-api' ? '模型列表' : '状态页'}`,
    discoveredAt: new Date(now).toISOString(),
    probe: { status: 200, evidence: p.detail, at: p.at },
  }));
  const failures = probed.filter((p) => !p.ok && p.state !== 'budget').length;
  const pending = probed.filter((p) => !p.ok).length;

  return {
    ran: true, reason: due.reason, basis, at: new Date(now).toISOString(),
    probed, candidates, requests, failures, pending,
    missing: sug.missing.map((m) => m.provider),
    unknown: sug.unknown,
    unmatchedChannels,
    keysInUse: sug.providersInUse,
  };
}

function brief(c) { return { id: c.id, provider: c.provider, kind: c.kind, url: c.url, keyRef: c.keyRef ?? null, label: c.label }; }

/** 未知渠道的「探源套路」提示（不探测、不落候选）。 */
export function suggestUrlsFor(channel) {
  const origin = channel?.origin ?? originOf(channel?.baseURL ?? '') ?? null;
  if (!origin) return [];
  const host = (() => { try { return new URL(origin).hostname; } catch { return null; } })();
  const apex = host ? host.split('.').slice(-2).join('.') : null;
  const out = [{ id: `${channel.provider}-models`, kind: 'models-api', url: `${origin}/v1/models`, keyRef: channel.keyRef ?? null }];
  if (apex) out.push({ id: `${channel.provider}-status`, kind: 'status-json', url: `https://status.${apex}/api/v2/status.json`, keyRef: null, note: '404 则降级 page-diff 读 https://status.<域名>/' });
  return out;
}

// ------------------------------------------------------------------ 落库（纯函数）

/** 候选去重 + 上限（纯函数）。返回新 candidates 数组。 */
export function mergeCandidates(existing, incoming, opts = {}) {
  const D = { ...DISCOVERY_DEFAULTS, ...(opts.defaults ?? {}) };
  const rejected = new Set((opts.rejected ?? []).map(String));
  const byKey = new Map();
  for (const c of existing ?? []) {
    if (!c?.id || !c?.url) continue;
    if (rejected.has(candidateKey(c))) continue;
    byKey.set(candidateKey(c), c);
  }
  for (const c of incoming ?? []) {
    if (!c?.id || !c?.url) continue;
    if (rejected.has(candidateKey(c))) continue;
    const k = candidateKey(c);
    byKey.set(k, { ...(byKey.get(k) ?? {}), ...c }); // 重探 = 刷新证据，不重复堆
  }
  const list = [...byKey.values()].sort((a, b) => String(b.discoveredAt ?? '').localeCompare(String(a.discoveredAt ?? '')));
  return list.slice(0, D.maxCandidates);
}

/** 把发现结果合并进注册表副本（**只动 candidates**，绝不碰 sources/enabled）。 */
export function applyDiscovery(registry, result, opts = {}) {
  const reg = { ...(registry ?? {}) };
  const rejected = opts.rejected ?? [];
  reg.candidates = mergeCandidates(reg.candidates, result?.candidates ?? [], { rejected, defaults: opts.defaults });
  return reg;
}

/**
 * 候选转正：把候选提升为源（enabled:true）。
 * 安全闸：同 id 已存在且 url/kind 不同 → 拒绝（防覆盖主人手写源）。
 */
export function acceptCandidate(registry, id, opts = {}) {
  const reg = { ...(registry ?? {}) };
  const cands = Array.isArray(reg.candidates) ? reg.candidates : [];
  const targets = id === 'all' ? cands : cands.filter((c) => c.id === id);
  if (!targets.length) return { ok: false, reason: 'not-found', errors: [`候选不存在：${id}`], registry: reg };
  const sources = (reg.sources ?? []).map((s) => normalizeSource(s));
  const accepted = [];
  for (const c of targets) {
    const hit = sources.find((s) => s.id === c.id);
    if (hit && (hit.url !== c.url || hit.kind !== c.kind)) {
      return { ok: false, reason: 'conflict', errors: [`源 ${c.id} 已存在且配置不同（url/kind）：${hit.url} ≠ ${c.url}；请先 --remove-source ${c.id} 或改用别的候选 id`], registry: reg };
    }
    const src = normalizeSource({ ...c, enabled: true, note: `${c.note ?? ''}自动发现 ${String(c.discoveredAt ?? '').slice(0, 10)} 探测通过（${c.probe?.evidence ?? '—'}）；由 --accept 转正`.trim() });
    delete src.discoveredAt; delete src.probe;
    if (hit) sources[sources.findIndex((s) => s.id === c.id)] = { ...hit, ...src };
    else sources.push(src);
    accepted.push(c.id);
  }
  reg.sources = sources;
  reg.candidates = cands.filter((c) => !accepted.includes(c.id));
  return { ok: true, accepted, registry: reg };
}

/** 否决候选（候选区移除 + 记入 rejected，防下次复活）。 */
export function rejectCandidate(registry, id, opts = {}) {
  const D = { ...DISCOVERY_DEFAULTS, ...(opts.defaults ?? {}) };
  const reg = { ...(registry ?? {}) };
  const cands = Array.isArray(reg.candidates) ? reg.candidates : [];
  const hit = id === 'all' ? cands : cands.filter((c) => c.id === id);
  if (!hit.length) return { ok: false, reason: 'not-found', registry: reg };
  const keys = new Set([...(opts.rejected ?? []), ...hit.map(candidateKey)]);
  reg.candidates = cands.filter((c) => !hit.includes(c));
  return { ok: true, rejected: [...keys].slice(-D.maxRejected), removed: hit.map((c) => c.id), registry: reg };
}

/** 发现结果 → state.discovery（覆盖写，保留累计项）。 */
export function discoveryState(result, prev = null, opts = {}) {
  if (!result?.ran) return prev ?? null;
  const base = {
    schemaVersion: 1,
    lastRunAt: Number(opts.now ?? Date.now()),
    reason: result.reason,
    basis: result.basis,
    missing: result.missing ?? [],
    unknown: result.unknown ?? [],
    unmatchedChannels: result.unmatchedChannels ?? [],
    probed: result.probed ?? [],
    failures: Number(result.failures ?? 0),
    pending: Number(result.pending ?? 0),
    requests: Number(result.requests ?? 0),
    rejected: [...new Set((prev?.rejected ?? []).map(String))].slice(-DISCOVERY_DEFAULTS.maxRejected),
  };
  return base;
}

/** 人话摘要（CLI / 日报共用）。 */
export function summarizeDiscovery(disc) {
  if (!disc) return { candidates: [], unknown: [], unmatched: [], lastRunAt: null, lines: [] };
  const cands = (disc.probed ?? []).filter((p) => p.ok);
  const lines = [];
  for (const c of cands) lines.push(`候选 ${c.id}（${c.detail ?? '探测通过'}）`);
  for (const u of disc.unknown ?? []) lines.push(`未知供应商凭证 ${u}`);
  for (const u of disc.unmatchedChannels ?? []) lines.push(`渠道未覆盖 ${u.provider}（${u.baseURL}）`);
  return { candidates: cands, unknown: disc.unknown ?? [], unmatched: disc.unmatchedChannels ?? [], lastRunAt: disc.lastRunAt ?? null, lines };
}

export { API_KEY_RE, originOf };
