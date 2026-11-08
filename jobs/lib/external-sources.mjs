// dsh-butler / lib/external-sources.mjs —— P6「会望风」源注册表
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §4 P6（行 856-881）
//   「源注册表 ~/.dsh\external-sources.json，每源 {id, url, kind, key-ref?, interval, enabled}
//     —— 新增源 = 加一行注册，不写代码」。
//
// 本模块只负责「注册表的定义 / 读取 / 校验 / 增删改」，不抓取、不判定（分别见 external-collect / external-diff）。
// 读写一律走 butler-store（readJson / writeJsonAtomic / updateJson），禁止自行 JSON.parse + 写回。
//
// 【host 分文件（2026-09-11）】注册表每 tick 都 bump updatedAt → 两台机同名必然分叉，
//   每次 depart 都被推前超集门挡（取证 _archive\docs-retired-20260915-0130\接机-收工挡推裁决请求-20260911.md §2/§3，已归档）。
//   根治：本机注册表文件名带主机短码 —— `external-sources-<host>.json`（照 butler-barewatch 先例）。
//   旧名 `external-sources.json` 在 HOST-A 侧升级前仍是它的生产文件 → 本版**只读不写、不删**：
//     ① 升级后首次运行：host 文件不存在 → 以旧文件内容为种子落到 host 文件（保住主人手改的源）
//     ② 旧文件从此冻结（继续作为 HOST-A 版本的落点，采集侧见 dsh-backup-sync.ps1 的白名单注释）
//   迁移与弃用流程见 docs\tick产物host分文件-20260911.md。
//
// 状态文件登记：lib/state-files.mjs → `external-sources.json` 条目（schemaVersion 1，sync:true：
//   源定义跨机共享；**实际落盘名 = external-sources-<host>.json**）。
//
// spike A3 结论（2026-09-10 实测，决定默认源的 kind）：
//   · status.deepseek.com/api/v2/status.json → 404 RouteNotFound（自建站，非 statuspage）
//     → DeepSeek 状态源降级 `page-diff`（正文归一化 hash，双读确认）
//   · status.siliconflow.cn/api/v2/status.json → 连接失败（无公开状态页）→ 用官网公告页 page-diff
//   · status.openai.com/api/v2/status.json → 200 标准 statuspage 格式 → `status-json` 活样本源
//   · /models（DeepSeek 2 条 / 硅基流动 96 条）→ 200，`models-api` 可用

import fs from 'node:fs';
import { readJson, writeJsonAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { dshHome, statePath } from '../../src/dsh-butler/lib/paths.mjs';
import { hostTag } from '../../src/dsh-butler/lib/host-tag.mjs';

export const EXTERNAL_SOURCES_VERSION = '0.1.0';
export const SOURCES_SCHEMA = 1;
/** 旧单文件名（无主机码）：兼容期只读不写（HOST-A 侧生产文件），本机新写法见 sourcesFileName()。 */
export const SOURCES_FILE = 'external-sources.json';
export const SNAPSHOT_DIR = 'butler-external-snapshots';
export const STATE_FILE = 'butler-external-state.json';

/** 三类源（方案 §4 P6 表的代码化）。 */
export const KINDS = ['models-api', 'status-json', 'page-diff'];

export const KIND_LABEL = {
  'models-api': '结构化 · 模型列表',
  'status-json': '结构化 · 状态页 JSON',
  'page-diff': '非结构化 · 页面正文 hash',
};

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 默认阈值（单位 ms；源可用 minNotifyIntervalMs 覆盖 page-diff 的「24h 同源一次」）。 */
export const DEFAULTS = {
  /** page-diff 源两次「变化提示」之间的最短间隔（方案：24h 内同源只提示一次）。 */
  pageMinNotifyMs: 24 * HOUR,
  /** 连续失败多少次才提示（单次失败是网络常态，静默跳过）。 */
  failThreshold: 3,
  /** 采集超时。 */
  timeoutMs: 20_000,
  /** 响应体上限（防超大页吃内存）。 */
  maxBytes: 4 * 1024 * 1024,
  /** page-diff 双读确认的最多采样次数（首轮 spike 实测 Next.js 状态页偶发渲染抖动）。 */
  doubleReadAttempts: 3,
  /** 每源保留的快照份数（方案 §6.5 登记口径）。 */
  keepSnapshots: 30,
  /** 模型字段变化的比对白名单（created 每次重建都可能变，只会造成噪音，故不比对）。 */
  trackedModelFields: ['object', 'owned_by'],
  /** 【R-048 ②】同一轮「≥N 个源同时采集失败」⇒ 升级为需送达事件（🔴）；N 缺省 2。 */
  batchFailMinSources: 2,
  /** 【R-048 B 补遗 · 2026-10-15】单个源**连续**失败达 N 次 ⇒ 升级为需送达事件（🔴）；N 缺省 3。
   *  与 failThreshold（= 3）的区别：后者是「逐源 🟡 事件的静默门槛」，本值管「要不要喊人（🔴 推送）」——
   *  语义不同、可各自单轮覆盖（CLI：--single-fail-min），**别互相替代**。 */
  singleFailMinCount: 3,

  /** 【R-048 ①】故障语义词表的上下文窗口（命中点前后各 N 字符内出现解除词 ⇒ 该次命中作废）。 */
  incidentContextWindow: 60,
};

/**
 * 首批源（主人点名 + spike A3 实测校准）。
 * ⚠️ 新增源 = 在 external-sources.json 里加一行，不需要改本文件。
 */
export const DEFAULT_SOURCES = [
  {
    id: 'deepseek-models', label: 'DeepSeek 模型列表', provider: 'deepseek', kind: 'models-api',
    url: 'https://api.deepseek.com/v1/models', keyRef: 'DEEPSEEK_API_KEY',
    interval: '24h', enabled: true, note: '模型下线 🔴 / 新增 🟡（影响 DSH 配置与推荐链）',
  },
  {
    id: 'siliconflow-models', label: '硅基流动 模型列表', provider: 'siliconflow', kind: 'models-api',
    url: 'https://api.siliconflow.cn/v1/models', keyRef: 'SILICONFLOW_API_KEY',
    interval: '24h', enabled: true, note: 'key 仅本机使用，不外发',
  },
  {
    id: 'deepseek-status', label: 'DeepSeek 状态页', provider: 'deepseek', kind: 'page-diff',
    url: 'https://status.deepseek.com/', interval: '30m', enabled: true,
    note: 'spike A3：该站无 api/v2/status.json（404），降级 page-diff（双读确认）',
  },
  {
    id: 'deepseek-updates', label: 'DeepSeek 更新日志', provider: 'deepseek', kind: 'page-diff',
    url: 'https://api-docs.deepseek.com/zh-cn/updates', interval: '24h', enabled: true,
    note: '公告/模型发布（只提示有变化，不解析内容）',
  },
  {
    id: 'siliconflow-announce', label: '硅基流动 官网公告', provider: 'siliconflow', kind: 'page-diff',
    url: 'https://www.siliconflow.cn/', interval: '24h', enabled: true,
    note: 'spike A3：无公开状态页，改用官网正文 hash',
  },
  {
    id: 'openai-status', label: 'OpenAI 状态页', provider: 'openai', kind: 'status-json',
    url: 'https://status.openai.com/api/v2/status.json', interval: '30m', enabled: true,
    note: 'statuspage 标准格式（status-json 类的活样本源）；不需要 key',
  },
];

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEYREF_RE = /^[A-Z0-9_]{2,64}$/;

/** '30m' / '24h' / '7d' / 数字(ms) → 毫秒。不可解析 → fallback。 */
export function parseInterval(v, fallbackMs = DAY) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v);
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(v ?? '').trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = String(m[2] ?? 'm').toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: HOUR, d: DAY }[unit] ?? 60_000;
  const ms = Math.round(n * mult);
  return ms > 0 ? ms : fallbackMs;
}

/** 人类可读间隔（状态输出用）。 */
export function formatInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '?';
  if (n % DAY === 0) return `${n / DAY}d`;
  if (n % HOUR === 0) return `${n / HOUR}h`;
  if (n % 60_000 === 0) return `${n / 60_000}m`;
  if (n % 1000 === 0) return `${n / 1000}s`;
  return `${n}ms`;
}

/** 本机注册表文件名（host 分文件）：external-sources-<host>.json。 */
export function sourcesFileName(opts = {}) {
  return `external-sources-${hostTag(opts)}.json`;
}
/** 本机注册表路径（写路径只此一个）。 */
export function sourcesPath(opts = {}) { return statePath(sourcesFileName(opts), opts.home ?? dshHome()); }
/** 旧单文件名路径（兼容期只读；HOST-A 侧旧代码仍写它）。 */
export function legacySourcesPath(opts = {}) { return statePath(SOURCES_FILE, opts.home ?? dshHome()); }
export function snapshotRoot(opts = {}) { return statePath(SNAPSHOT_DIR, opts.home ?? dshHome()); }
export function externalStatePath(opts = {}) { return statePath(STATE_FILE, opts.home ?? dshHome()); }

/** 规范化单源（填默认值 + 兼容 `key-ref` 写法）。返回新对象，不改入参。 */
export function normalizeSource(src = {}) {
  const out = { ...src };
  out.id = String(out.id ?? '').trim();
  out.url = String(out.url ?? '').trim();
  out.kind = String(out.kind ?? '').trim();
  out.label = out.label ? String(out.label) : out.id;
  out.provider = out.provider ? String(out.provider) : out.id.split('-')[0];
  out.enabled = out.enabled !== false;
  out.intervalMs = parseInterval(out.interval, DAY);
  // 兼容 `key-ref` / `key_ref` 两种手写方式（方案原文写的是 key-ref）
  const kr = out.keyRef ?? out['key-ref'] ?? out.key_ref ?? null;
  out.keyRef = kr ? String(kr).trim() : null;
  delete out['key-ref']; delete out.key_ref;
  out.minNotifyIntervalMs = Number.isFinite(Number(out.minNotifyIntervalMs))
    ? Number(out.minNotifyIntervalMs)
    : (out.kind === 'page-diff' ? DEFAULTS.pageMinNotifyMs : 0);
  out.timeoutMs = Number.isFinite(Number(out.timeoutMs)) ? Number(out.timeoutMs) : DEFAULTS.timeoutMs;
  return out;
}

/** 校验单源。返回错误数组（空 = 通过）。 */
export function validateSource(src = {}) {
  const errors = [];
  const s = normalizeSource(src);
  if (!ID_RE.test(s.id)) errors.push(`id 非法（只允许小写字母/数字/._-）：${s.id || '(空)'}`);
  if (!/^https?:\/\//i.test(s.url)) errors.push(`url 必须 http(s)：${s.url || '(空)'}`);
  if (!KINDS.includes(s.kind)) errors.push(`kind 必须是 ${KINDS.join(' | ')}：${s.kind || '(空)'}`);
  if (s.keyRef && !KEYREF_RE.test(s.keyRef)) errors.push(`keyRef 非法（大写字母/数字/下划线）：${s.keyRef}`);
  if (!Number.isFinite(s.intervalMs) || s.intervalMs <= 0) errors.push('interval 必须为正（如 "30m" / "24h"）');
  return errors;
}

/** 空注册表（含默认源）。 */
export function defaultRegistry(now = Date.now()) {
  return {
    schemaVersion: SOURCES_SCHEMA,
    updatedAt: new Date(now).toISOString(),
    removedDefaults: [],
    sources: DEFAULT_SOURCES.map((s) => normalizeSource(s)),
  };
}

/**
 * 读取注册表（不存在/损坏 → 默认；损坏时抛给调用方决定）。
 * host 文件不存在时**回退读旧单文件名**（升级后首次运行、或旧文件是唯一来源时）——
 * 只读回退不写旧文件；落盘永远走 sourcesPath()。
 */
export function readRegistry(opts = {}) {
  const file = sourcesPath(opts);
  const cur = readJson(file, { schemaVersion: SOURCES_SCHEMA, defaultValue: null, home: opts.home });
  if (cur && Array.isArray(cur.sources)) return cur;
  const legacy = readJson(legacySourcesPath(opts), { schemaVersion: SOURCES_SCHEMA, defaultValue: null, home: opts.home });
  if (legacy && Array.isArray(legacy.sources)) return legacy;
  return cur ?? null;
}

/** 原子写本机注册表（host 文件名）。 */
export function writeRegistry(reg, opts = {}) {
  const file = sourcesPath(opts);
  const data = {
    schemaVersion: SOURCES_SCHEMA,
    updatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    host: hostsTagOf(opts),
    removedDefaults: [...new Set((reg?.removedDefaults ?? []).map(String))],
    // 落盘不写派生字段 intervalMs（运行期由 normalizeSource 计算），保留手写的 interval 便于人读/手改
    sources: (reg?.sources ?? []).map((s) => {
      const { intervalMs, ...rest } = normalizeSource(s);
      return rest;
    }),
  };
  // 自动探源候选（2026-09-12）：**必须随写一起落**，否则 tick 下一轮就把它们抹掉。
  const cands = (reg?.candidates ?? []).filter((c) => c && c.id && c.url).map((c) => ({ ...c }));
  if (cands.length) data.candidates = cands;
  writeJsonAtomic(file, data, {});
  return { ok: true, file, data };
}

/** 落盘用的主机短码（写进文件里便于人一眼看出这份是谁的）。 */
function hostsTagOf(opts = {}) { return hostTag(opts); }

/**
 * 保证注册表存在且包含默认源（幂等）：
 *   · 首次 → 落默认注册表
 *   · host 文件不存在但旧单文件名存在 → **以旧文件为种子迁移**（保住主人手改的源；旧文件保留不删）
 *   · 已存在 → 补齐缺失的默认源（主人对手改过的源不做覆盖）
 *   · 主人删掉的默认源记在 removedDefaults，不再自动复活（尊重手改）
 */
export function ensureRegistry(opts = {}) {
  const now = opts.now ?? Date.now();
  const file = sourcesPath(opts);
  const legacyFile = legacySourcesPath(opts);
  const existing = readRegistry(opts);
  const migratedFrom = (!fs.existsSync(file) && fs.existsSync(legacyFile)) ? legacyFile : null;
  if (!existing || !Array.isArray(existing.sources)) {
    const reg = defaultRegistry(now);
    if (opts.write !== false) writeRegistry(reg, { ...opts, now });
    return { ok: true, created: true, registry: reg, added: reg.sources.map((s) => s.id), file, migratedFrom };
  }
  const removed = new Set((existing.removedDefaults ?? []).map(String));
  const have = new Set((existing.sources ?? []).map((s) => String(s?.id ?? '')));
  const added = [];
  const merged = (existing.sources ?? []).map((s) => normalizeSource(s));
  for (const d of DEFAULT_SOURCES) {
    if (have.has(d.id) || removed.has(d.id)) continue;
    merged.push(normalizeSource(d));
    added.push(d.id);
  }
  const reg = {
    schemaVersion: SOURCES_SCHEMA,
    updatedAt: new Date(now).toISOString(),
    removedDefaults: [...removed],
    sources: merged,
    // 候选区（自动探源）原样带过，绝不在 ensure 路径上丢
    ...(Array.isArray(existing.candidates) && existing.candidates.length ? { candidates: existing.candidates } : {}),
  };
  // 迁移（首次生成 host 文件）也必须落盘，否则下一 tick 又去读旧文件
  if ((added.length || migratedFrom) && opts.write !== false) writeRegistry(reg, { ...opts, now });
  return { ok: true, created: false, registry: reg, added, file, migratedFrom };
}

/** 全量校验（读到的注册表可能被手改坏 → 明确报出来，不猜）。 */
export function validateRegistry(reg = {}) {
  const errors = [];
  const warnings = [];
  const list = Array.isArray(reg?.sources) ? reg.sources : [];
  if (!list.length) errors.push('sources 为空');
  const seen = new Set();
  for (const s of list) {
    const sid = String(s?.id ?? '');
    for (const e of validateSource(s)) errors.push(`[${sid || '?'}] ${e}`);
    if (seen.has(sid)) errors.push(`[${sid}] id 重复`);
    seen.add(sid);
    const n = normalizeSource(s);
    if (typeof s?.interval === 'number') warnings.push(`[${sid}] interval 用数字（ms）；建议写 "30m" / "24h" 更直观`);
    if (n.kind === 'models-api' && !n.keyRef) warnings.push(`[${sid}] models-api 建议配 keyRef（否则可能 401）`);
    if (n.kind !== 'models-api' && n.keyRef) warnings.push(`[${sid}] ${n.kind} 不需要 keyRef`);
  }
  return { ok: errors.length === 0, errors, warnings, sources: list.map((s) => normalizeSource(s)) };
}

/** 增/改一个源（按 id 覆盖或追加）。返回新注册表（纯函数）。 */
export function upsertSource(reg, src, opts = {}) {
  const errors = validateSource(src);
  if (errors.length) return { ok: false, errors, registry: reg };
  const n = normalizeSource(src);
  const list = (reg?.sources ?? []).map((s) => normalizeSource(s));
  const idx = list.findIndex((s) => s.id === n.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...n };
  else list.push(n);
  const removed = new Set((reg?.removedDefaults ?? []).map(String));
  removed.delete(n.id); // 重新加回来的源不再算「已删除的默认源」
  return {
    ok: true,
    created: idx < 0,
    registry: { ...(reg ?? {}), sources: list, removedDefaults: [...removed] },
  };
}

/** 删源（记入 removedDefaults，防 ensureRegistry 复活默认源）。 */
export function removeSource(reg, id) {
  const list = (reg?.sources ?? []).map((s) => normalizeSource(s));
  const hit = list.find((s) => s.id === id);
  if (!hit) return { ok: false, reason: 'not-found', registry: reg };
  const removed = new Set((reg?.removedDefaults ?? []).map(String));
  if (DEFAULT_SOURCES.some((d) => d.id === id)) removed.add(id);
  return {
    ok: true,
    removed: hit,
    registry: { ...(reg ?? {}), sources: list.filter((s) => s.id !== id), removedDefaults: [...removed] },
  };
}

/** 启用/禁用。 */
export function setEnabled(reg, id, enabled) {
  const list = (reg?.sources ?? []).map((s) => normalizeSource(s));
  const hit = list.find((s) => s.id === id);
  if (!hit) return { ok: false, reason: 'not-found', registry: reg };
  hit.enabled = enabled !== false;
  return { ok: true, source: hit, registry: { ...(reg ?? {}), sources: list } };
}

export function findSource(reg, id) {
  const s = (reg?.sources ?? []).map((x) => normalizeSource(x)).find((x) => x.id === id);
  return s ?? null;
}

// ------------------------------------------------------------------ 探源发现
// 主人 2026-09-11 定：「探源应该随着 dsh 使用动态变化——谁也不知道啥时候又加了新模型或新 API」。
// 落点 = 把「本机在用什么（凭证实况）」与「源清单覆盖了什么」对起来，随时能问「我漏了谁」：
//   · 有凭证、没源   → missing（可直接按模板补）
//   · 有源、没凭证   → stale（多半是环境信号源，如 openai-status）
//   · 有凭证、无模板 → unknown（新供应商，需人工探源后加模板一行）
// 本轮只做「只读建议」；自动探测并落源见后续卡（避免未经确认就改配置）。

/**
 * 已知供应商模板（**新供应商在这里加一行即可被 --suggest 认出来**）。
 * modelsUrl/keyRef 用于「有 key 没源」时给出可直接补的源定义。
 */
export const PROVIDER_TEMPLATES = [
  { provider: 'deepseek', keyRefs: ['DEEPSEEK_API_KEY'], modelsUrl: 'https://api.deepseek.com/v1/models', statusUrl: 'https://status.deepseek.com/', statusKind: 'page-diff' },
  { provider: 'siliconflow', keyRefs: ['SILICONFLOW_API_KEY'], modelsUrl: 'https://api.siliconflow.cn/v1/models', statusUrl: null, statusKind: null },
  { provider: 'zhipu', keyRefs: ['ZHIPU_API_KEY'], modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models', statusUrl: 'https://status.bigmodel.cn/', statusKind: 'page-diff' },
  { provider: 'openai', keyRefs: ['OPENAI_API_KEY'], modelsUrl: 'https://api.openai.com/v1/models', statusUrl: 'https://status.openai.com/api/v2/status.json', statusKind: 'status-json' },
];

/**
 * 读本机凭证文件里的 **key 名**（只取名字，绝不取值、绝不外发）。
 * 兼容两种形态：顶层 `XXX_API_KEY: <值>`、refs 段的缩进键名。
 * 2026-09-12：顶层判定从 `_KEY$` 扩到 `_KEY|_TOKEN|_SECRET$`（少数供应商不叫 KEY）。
 * @returns {string[]}
 */
export function readCredentialKeyNames(opts = {}) {
  const target = opts.credentialsFile ?? `${opts.home ?? dshHome()}/.credentials.yaml`;
  let raw = '';
  try { raw = fs.readFileSync(target, 'utf8'); } catch { return []; }
  const names = new Set();
  let inRefs = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    const topKey = /^([A-Za-z0-9_]+)\s*:\s*\S/.exec(line);
    if (topKey) {
      if (/^[A-Za-z_]/.test(line) && !/^refs\s*:/.test(line)) inRefs = false;
      if (/(_KEY|_TOKEN|_SECRET)$/i.test(topKey[1])) names.add(topKey[1]);
      else continue;
    } else if (inRefs) {
      const m = /^\s+([A-Za-z0-9_]+)\s*:/.exec(line);
      if (m) names.add(m[1]);
    }
  }
  return [...names].sort();
}

/** 按模板生成「可直接补的源定义」（不含 label/note，调用方补人话）。自动探源复用（lib/external-discovery.mjs）。 */
export function templateSources(tpl, keyRef) {
  const out = [];
  if (tpl.modelsUrl) {
    out.push({ id: `${tpl.provider}-models`, provider: tpl.provider, kind: 'models-api', url: tpl.modelsUrl, keyRef });
  }
  if (tpl.statusUrl) {
    out.push({ id: `${tpl.provider}-status`, provider: tpl.provider, kind: tpl.statusKind ?? 'page-diff', url: tpl.statusUrl, keyRef: null });
  }
  return out;
}

/**
 * 探源建议（只读）：本机凭证实况 vs 源清单覆盖。
 * @returns {{ok:true, keysInUse:string[], providersInUse:string[], covered:string[],
 *            missing:Array<{provider:string,keyRef:string|null,candidates:object[]}>,
 *            stale:Array<{provider:string,sources:string[]}>, unknown:string[]}}
 */
export function suggestSources(opts = {}) {
  const templates = opts.templates ?? PROVIDER_TEMPLATES;
  const reg = opts.registry ?? readRegistry(opts);
  const sources = (reg?.sources ?? []).map((s) => normalizeSource(s));
  const keys = opts.keys ?? readCredentialKeyNames(opts);
  const covered = new Set(sources.map((s) => s.provider));
  const providersInUse = [];
  const missing = [];
  const stale = [];
  for (const tpl of templates) {
    const keyRef = tpl.keyRefs.find((k) => keys.includes(k)) ?? null;
    const hasSource = covered.has(tpl.provider);
    if (keyRef) {
      providersInUse.push(tpl.provider);
      if (!hasSource) missing.push({ provider: tpl.provider, keyRef, candidates: templateSources(tpl, keyRef) });
    } else if (hasSource) {
      stale.push({ provider: tpl.provider, sources: sources.filter((s) => s.provider === tpl.provider).map((s) => s.id) });
    }
  }
  const unknown = keys.filter((k) => /(_API_KEY|_KEY|_TOKEN|_SECRET)$/i.test(k) && !templates.some((t) => t.keyRefs.includes(k)));
  return { ok: true, keysInUse: keys, providersInUse, covered: [...covered], missing, stale, unknown };
}
