// dsh-butler / lib/monitor-registry.mjs —— 注册制监视器实体（v2 方案 §3.5.5「注册制 monitor-registry」）
//
// 形态：`%USERPROFILE%\.dsh\butler-monitor-registry.json`；每个被管对象 = 一个 CI：
//   `{id, aliases[], 型, 探针, 期望值/风险阈值, S档, owner, state, provenance, edges[], 关联流水, schemaVersion}`
//
// 【2026-10-10 · 卡「冲刺600·A域宪章层三件」】本模块 = 该实体的**唯一生成器 + 校验器**：
//   · `discover()`  只读探针 → CI 清单（**候选集驱动**，不是全网扫描）；
//   · `revalidate()` 双向对账：注册了却不在候选/已退役 = 幽灵项；候选探到活的却未登记 = 漏网项；
//   · `selfCheck()`  供 registry-audit / 面板 / 单测读**同一份**判据（防两处口径漂移）。
//
// ⚠️ 本版**诚实边界**（别把它读成"全自动 CMDB"）：
//   ① 发现范围 = `DISCOVERY_SCOPE` **显式候选清单**（端口 / 状态文件两类探针）。
//      ⇒「漏网项」的准确含义 = "**候选集**里探到活的、但注册表没有"，**不等于**"系统里所有活对象都已登记"。
//   ② 探针只用 **TCP connect(127.0.0.1)** 与 **状态文件 stat**：零写盘、零外部进程、不 spawn。
//   ③ 方案 §3.5.5「建模地基四件」本版落地 = id 规则 / state 状态机 / edges / provenance **四列齐**；
//      edges 只写**有确凿证据**的边（宁少不假）；provenance 首批一律 `self-built` 并附证据串。
//   ④ 「对象三型 / 自治光谱 S0–S5」另两件**不属本模块**（主档 A 域另两行、仍待the operator拍板）；
//      本版只把它们落成 CI 的 `type` / `sTier` 两列（S 档 = 该对象被允许的最大自治度，方案 §3.5.7）。
//
// 写盘口径：唯一写口 = `writeRegistry()`（走 `lib/store.mjs#writeJsonAtomic` 原子写）。
//   CLI 缺省 dry-run（只打印发现结果，零写入）；`--apply` 才落盘。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { writeTextAtomic } from './store.mjs';
import { writeStateText } from './dual-write.mjs';

export const MONITOR_REGISTRY_VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-monitor-registry.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

export const REGISTRY_FILE = 'butler-monitor-registry.json';
/** 对象三型（方案 §3.5.2）。 */
export const CI_TYPES = Object.freeze(['resource', 'expect', 'risk']);
/** CI id 前缀（方案 §3.5.5 地基①）。 */
export const ID_PREFIX = Object.freeze({ resource: 'res', expect: 'exp', risk: 'risk' });
/** state 状态机（方案 §3.5.5 地基②，对齐 ITIL status accounting）。 */
export const CI_STATES = Object.freeze(['discovered', 'configured', 'active', 'degraded', 'upgrading', 'deprecated', 'retired']);
/** edges 关系边取值（方案 §3.5.5 地基③）。 */
export const EDGE_RELS = Object.freeze(['depends-on', 'patched-by', 'exposes', 'owned-by', 'supersedes']);
/** provenance 来源血缘取值（方案 §3.5.5 地基④）。 */
export const PROVENANCES = Object.freeze(['official', 'community', 'self-built', 'manually-patched', 'unknown']);

export function registryPath(home = dshHome()) {
  return stateFileOf(REGISTRY_FILE, { home });
}

/** 规范化名（方案 §3.5.5 地基①：小写 + 去空格/下划线；中文保留原字）。 */
export function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[\s_]+/g, '');
}

/** CI id = `<型前缀>-<规范化名>-<设备短码>`（id 一经分配永不变更，改名走 aliases）。 */
export function makeCiId(type, name, hostShort) {
  if (!ID_PREFIX[type]) throw new Error(`未知对象型：${type}`);
  return `${ID_PREFIX[type]}-${normalizeName(name)}-${normalizeName(hostShort)}`;
}

// ---------------------------------------------------------------- 探针（只读）

/** TCP connect 探针（127.0.0.1）：能连上 = 端口在听。零写盘、不 spawn。 */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok, kind: 'port', target: `${host}:${port}`, ms: Date.now() - started, fresh: null, detail });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, 'connect 成功'));
    sock.once('timeout', () => finish(false, `timeout ${timeoutMs}ms`));
    sock.once('error', (e) => finish(false, String(e?.code ?? e?.message ?? e)));
  });
}

/** 状态文件探针：存在 + 新鲜度。`maxAgeMs === null` = **不判新鲜度**（只判"在不在"）。 */
export function probeStateFile(file, opts = {}) {
  const maxAgeMs = opts.maxAgeMs === undefined ? 10 * 60 * 1000 : opts.maxAgeMs;
  const now = opts.now ?? Date.now();
  try {
    const st = fs.statSync(file);
    const ageMs = now - st.mtimeMs;
    const fresh = maxAgeMs === null ? null : ageMs <= maxAgeMs;
    return {
      ok: true, kind: 'statefile', target: file, ms: 0, fresh,
      detail: fresh === null
        ? `mtime ${new Date(st.mtimeMs).toISOString()}（age ${Math.round(ageMs / 1000)}s · 本探针不判新鲜度）`
        : `mtime ${new Date(st.mtimeMs).toISOString()}（age ${Math.round(ageMs / 1000)}s / 阈值 ${Math.round(maxAgeMs / 1000)}s）`,
      ageMs: Math.round(ageMs), bytes: st.size,
    };
  } catch (e) {
    return { ok: false, kind: 'statefile', target: file, ms: 0, fresh: false, detail: String(e?.code ?? e?.message ?? e), ageMs: null };
  }
}

// ---------------------------------------------------------------- 候选发现范围

/**
 * 候选发现范围（**显式清单**，方案 §3.5.5「自动发现」的最小可用形态）。
 * 每条 = 一个候选 CI 的静态声明；探针结果由 discover() 现跑填入。
 * @returns {Array<object>}
 */
export function discoveryScope(opts = {}) {
  const home = opts.home ?? dshHome();
  const tmp = opts.tmp ?? os.tmpdir();
  return [
    {
      name: 'dsh-web', type: 'expect', aliases: ['dsh web', 'DSH GUI', '3080'],
      probe: { kind: 'port', port: 3080, host: '127.0.0.1' },
      expect: '在听（掉线 = 服务不可用）', sTier: 'S1', owner: 'the operator',
      provenance: 'self-built', provenanceEvidence: 'DSH 主包（npm @deepseek-ai/dsh）+ dsh-start.ps1 启动链',
      edges: [{ to: 'exp-guard-daemon', rel: 'owned-by', evidence: 'guard.mjs 判活并拉起 dsh（进程 + 端口判据）' }],
      why: '期望型：应当在线，掉线才告警',
    },
    {
      name: 'guard-daemon', type: 'expect', aliases: ['守护鱼', 'guard.mjs', 'guard2'],
      // ⚠️ 本探针**只判"状态文件在位"**（`maxAgeMs: null` = 不判新鲜度）—— 理由：guard-state.json
      //   只在重启窗口/事件时写（实测 2026-10-10 15:13 最后一次），日志也是**事件驱动**
      //   （正常态约每小时一行），拿"新鲜度"当判据会天天假 degraded。
      //   守护鱼**判活的真源 = `lib/tickd-health.mjs`**，本 CI 只做存在性陈列（故 S0，不告警）。
      probe: { kind: 'statefile', file: path.join(tmp, 'dsh-guard', 'guard-state.json'), maxAgeMs: null },
      expect: '状态文件在位（判活真源见 lib/tickd-health.mjs）', sTier: 'S0', owner: '计划任务',
      provenance: 'self-built', provenanceEvidence: 'guard.mjs + dsh-start.ps1（第 0 步）',
      edges: [], why: '期望型：守护鱼停摆 = 没人拉起 dsh（本 CI 只陈列"实体在不在"）',
    },
    {
      name: 'tickd-scheduler', type: 'expect', aliases: ['tickd', 'butler-tickd'],
      probe: { kind: 'statefile', file: path.join(tmp, 'dsh-butler-tickd', 'state.json'), maxAgeMs: 10 * 60 * 1000 },
      expect: '状态文件新鲜（≤10min）', sTier: 'S1', owner: '计划任务',
      provenance: 'self-built', provenanceEvidence: 'butler-tickd.mjs（冷启动由 dsh-start.ps1 --ensure）',
      edges: [], why: '期望型：tickd 停摆 = 全部周期 job 静默停摆',
    },
    {
      name: 'local-image-stack', type: 'resource', aliases: ['ComfyUI', 'openai-bridge', '8199'],
      probe: { kind: 'port', port: 8199, host: '127.0.0.1' },
      expect: null, sTier: 'S0', owner: 'operator',
      provenance: 'self-built', provenanceEvidence: 'tools\\start-local-stack.ps1 + openai-bridge.mjs（按需起，不常驻）',
      edges: [], why: '资源型：开≠好、关≠坏 ⇒ 只进总览 + 预检，绝不告警',
    },
    {
      name: 'clash-proxy', type: 'resource', aliases: ['Clash', '7897'],
      probe: { kind: 'port', port: 7897, host: '127.0.0.1' },
      expect: null, sTier: 'S0', owner: 'the operator',
      provenance: 'manually-patched', provenanceEvidence: 'tools\\dsh-proxy.ps1（按需起；节点配置本地维护）',
      edges: [], why: '资源型：按需开，关掉不是故障',
    },
    {
      name: 'phone-channel', type: 'resource', aliases: ['手机访问', '手机通道', '3081'],
      probe: { kind: 'port', port: 3081, host: '127.0.0.1' },
      expect: null, sTier: 'S0', owner: 'the operator',
      provenance: 'self-built', provenanceEvidence: 'tools\\dsh-phone.mjs on/off（默认关；用完即关）',
      edges: [], why: '资源型：默认关是常态',
    },
    {
      name: 'dsh-home', type: 'expect', aliases: ['~/.dsh', 'DSH_HOME'],
      probe: { kind: 'statefile', file: resolveStatePath('butler-version.json', { home }).path, maxAgeMs: null },
      expect: '产品版本文件存在', sTier: 'S0', owner: 'operator',
      provenance: 'self-built', provenanceEvidence: 'lib/version.mjs#writeProductVersion（部署 / 纳管刷新时写）',
      edges: [], why: '期望型：产品版本文件是「8 个组件是一个产品」的落点（内容长期不变 ⇒ 只陈列存在性）',
    },
  ];
}

/** 按探测结果定 state（方案 §3.5.5 地基②）。 */
export function deriveState(type, probe) {
  if (type === 'resource') return probe.ok ? 'active' : 'configured';
  if (type === 'risk') return probe.ok ? 'active' : 'configured';
  // expect：在线且新鲜 = active；否则 degraded（离线 / 状态陈旧）
  return (probe.ok && (probe.fresh === null || probe.fresh)) ? 'active' : 'degraded';
}

/** 默认探针实现（可注入替换，夹具/单测用）。 */
export async function defaultProbe(spec, opts = {}) {
  if (spec.kind === 'port') return await probePort(spec.port, { host: spec.host, timeoutMs: opts.timeoutMs ?? 800 });
  if (spec.kind === 'statefile') return probeStateFile(spec.file, { maxAgeMs: spec.maxAgeMs });
  return { ok: false, kind: String(spec.kind ?? 'unknown'), target: '', ms: 0, fresh: false, detail: '未知探针类型' };
}

/**
 * 只读发现：候选集 → CI 清单（不写任何文件）。
 * @returns {Promise<{cis:Array<object>, host:string, hostShort:string, at:string, scopeCount:number}>}
 */
export async function discover(opts = {}) {
  const host = opts.host ?? os.hostname();
  const hostShort = opts.hostShort ?? String(host).toLowerCase();
  const at = new Date().toISOString();
  const probe = opts.probe ?? defaultProbe;
  const scope = opts.scope ?? discoveryScope({ home: opts.home, tmp: opts.tmp });
  const cis = [];
  for (const s of scope) {
    const pr = await probe(s.probe, opts);
    const ci = {
      id: makeCiId(s.type, s.name, hostShort),
      aliases: s.aliases ?? [],
      type: s.type,
      probe: s.probe.kind === 'port'
        ? { kind: 'port', host: s.probe.host ?? '127.0.0.1', port: s.probe.port }
        : { kind: 'statefile', file: s.probe.file, maxAgeMs: s.probe.maxAgeMs ?? null },
      expect: s.expect ?? null,
      sTier: s.sTier,
      owner: s.owner,
      state: deriveState(s.type, pr),
      provenance: s.provenance,
      provenanceEvidence: s.provenanceEvidence ?? null,
      edges: (s.edges ?? []).map((e) => ({ to: `${normalizeName(e.to)}-${normalizeName(hostShort)}`, rel: e.rel, evidence: e.evidence })),
      lastProbe: { at, ok: pr.ok, fresh: pr.fresh, detail: pr.detail, ms: pr.ms },
      discoveredAt: at,
      updatedAt: at,
      why: s.why ?? null,
    };
    cis.push(ci);
  }
  return { cis, host, hostShort, at, scopeCount: scope.length };
}

// ---------------------------------------------------------------- 读 / 写

/** 读注册表（只读；不抛）。 */
export function readRegistry(opts = {}) {
  const file = opts.file ?? registryPath(opts.home ?? dshHome());
  try {
    if (!fs.existsSync(file)) return { ok: false, file, error: 'missing' };
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return { ok: true, file, data, bytes: Buffer.byteLength(raw) };
  } catch (e) {
    return { ok: false, file, error: String(e?.message ?? e) };
  }
}

/** 写注册表（唯一写口；原子写）。 */
export function writeRegistry(data, opts = {}) {
  const file = opts.file ?? registryPath(opts.home ?? dshHome());
  const dw = writeStateText(REGISTRY_FILE, JSON.stringify(data, null, 2) + '\n', {
    home: opts.file ? path.dirname(file) : (opts.home ?? dshHome()),
    write: (p, t) => writeTextAtomic(p, t),
  });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return { ok: true, file, bytes: fs.statSync(file).size };
}

/** 由 discover 结果构造落盘文档。 */
export function buildDocument(found, prev = null) {
  const byType = {}; const byState = {};
  for (const ci of found.cis) {
    byType[ci.type] = (byType[ci.type] ?? 0) + 1;
    byState[ci.state] = (byState[ci.state] ?? 0) + 1;
  }
  // discoveredAt 首次落盘时间**不因刷新而变**（id 稳定 ⇒ 首次发现时间应稳定）
  const prevById = new Map((prev?.cis ?? []).map((c) => [c.id, c]));
  for (const ci of found.cis) {
    const old = prevById.get(ci.id);
    if (old?.discoveredAt) ci.discoveredAt = old.discoveredAt;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    product: 'dsh-butler',
    generator: 'tools/dsh-butler/lib/monitor-registry.mjs',
    host: found.host,
    hostShort: found.hostShort,
    updatedAt: found.at,
    discovery: {
      mode: 'candidate-scope',
      note: '候选集驱动（DISCOVERY_SCOPE 显式清单：端口 + 状态文件），不是全网扫描；'
        + '「漏网项」只指候选集里探到活的却未登记的对象。',
      scopeCount: found.scopeCount,
    },
    counts: { total: found.cis.length, byType, byState },
    cis: found.cis,
  };
}

// ---------------------------------------------------------------- 双向对账（revalidate）

/**
 * 注册表 ↔ 实况 双向对账（方案 §3.5.5「验证审计 CMDB revalidate」）。
 * @param {object} doc 注册表文档（readRegistry().data）
 * @param {object} found discover() 结果
 * @returns {{ghost:Array, missing:Array, drifted:Array, counts:object}}
 */
export function revalidate(doc, found) {
  const cis = Array.isArray(doc?.cis) ? doc.cis : [];
  const registered = new Map(cis.map((c) => [c.id, c]));
  const scopeById = new Map(found.cis.map((c) => [c.id, c]));
  const ghost = cis
    .filter((c) => c.state !== 'retired' && !scopeById.has(c.id))
    .map((c) => ({ id: c.id, state: c.state, why: '注册了但不在候选发现范围里（幽灵项：对象已消失 / 候选集缩了）' }));
  const missing = found.cis
    .filter((c) => c.lastProbe?.ok === true && !registered.has(c.id))
    .map((c) => ({ id: c.id, type: c.type, detail: c.lastProbe?.detail ?? '', why: '候选集里探到活的，但注册表没有（漏网项）' }));
  const drifted = found.cis
    .filter((c) => registered.has(c.id) && registered.get(c.id).state !== c.state)
    .map((c) => ({ id: c.id, was: registered.get(c.id).state, now: c.state, why: '状态迁移（正常会随时间变化，仅报告、不判红）' }));
  return {
    ghost, missing, drifted,
    counts: { registered: cis.length, scope: found.cis.length, ghost: ghost.length, missing: missing.length, drifted: drifted.length },
  };
}

/**
 * **静态**双向对账（不需要探针）：只用「候选清单的 id 集合」与注册表比对。
 *
 * 与 `revalidate()` 的分工：`revalidate` 吃实况探针（CLI / 巡检用，**异步**）；
 * 本函数**纯同步**，供 `lib/registry-audit.mjs` 这类同步判定点复用**同一份口径**
 * （两处判据若各写一套，必然漂移 —— 方案 §3.5.5「验证审计」的口径必须单点）。
 */
export function staticReconcile(doc, opts = {}) {
  const hostShort = opts.hostShort ?? String(opts.host ?? os.hostname()).toLowerCase();
  const scope = opts.scope ?? discoveryScope({ home: opts.home, tmp: opts.tmp });
  const scopeIds = new Set(scope.map((s) => makeCiId(s.type, s.name, hostShort)));
  const cis = Array.isArray(doc?.cis) ? doc.cis : [];
  const registered = new Set(cis.map((c) => c.id));
  const ghost = cis
    .filter((c) => c.state !== 'retired' && !scopeIds.has(c.id))
    .map((c) => ({ id: c.id, state: c.state }));
  const missing = [...scopeIds].filter((id) => !registered.has(id)).map((id) => ({ id }));
  const unprobed = cis.filter((c) => !c.lastProbe?.at).map((c) => ({ id: c.id }));
  return {
    ghost, missing, unprobed,
    counts: { scope: scopeIds.size, registered: cis.length, ghost: ghost.length, missing: missing.length, unprobed: unprobed.length },
  };
}

/** 结构自检（schema / id / 型 / state / edges / provenance 合法性）+ 双向对账。 */
export function selfCheck(opts = {}) {
  const read = readRegistry(opts);
  const problems = [];
  if (!read.ok && read.error !== 'missing') problems.push({ check: 'MR1 注册表可读', detail: `读失败：${read.error}` });
  const doc = read.data ?? null;
  if (doc) {
    if (doc.schemaVersion !== SCHEMA_VERSION) problems.push({ check: 'MR1 schemaVersion 合法', detail: `期望 ${SCHEMA_VERSION}，实际 ${doc.schemaVersion}` });
    const ids = new Set();
    for (const c of doc.cis ?? []) {
      if (!c.id) { problems.push({ check: 'MR2 CI id 齐备', detail: '存在无 id 的 CI' }); continue; }
      if (ids.has(c.id)) problems.push({ check: 'MR2 CI id 唯一', detail: `重复 id：${c.id}` });
      ids.add(c.id);
      if (!CI_TYPES.includes(c.type)) problems.push({ check: 'MR2 对象型合法', detail: `${c.id}: ${c.type}` });
      if (!CI_STATES.includes(c.state)) problems.push({ check: 'MR2 state 合法', detail: `${c.id}: ${c.state}` });
      if (!PROVENANCES.includes(c.provenance)) problems.push({ check: 'MR2 provenance 合法', detail: `${c.id}: ${c.provenance}` });
      for (const e of c.edges ?? []) {
        if (!EDGE_RELS.includes(e.rel)) problems.push({ check: 'MR2 edges.rel 合法', detail: `${c.id}: ${e.rel}` });
        if (!e.evidence) problems.push({ check: 'MR2 edges 必须带证据', detail: `${c.id} → ${e.to}` });
      }
    }
  }
  return { ok: problems.length === 0, read, doc, problems };
}
