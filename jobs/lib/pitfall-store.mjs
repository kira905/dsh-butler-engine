// dsh-butler / lib/pitfall-store.mjs —— P4 状态聚合：坑库 / 扫描记账 / 会话健康 / 升级候选
//
// 状态文件（state-files.mjs 登记）：
//   butler-pitfalls.json        坑数据（跨机同步；schemaVersion 1）
//   butler-pitfall-scan.json    扫描记账（按本机会话，禁止同步；schemaVersion 1）
//   butler-sessions-health.json 会话文件健康（按本机，禁止同步；schemaVersion 1）
//   butler-p4-candidates.json   升级候选（跨机同步；schemaVersion 1）
//
// 本模块只做**纯聚合**（applyScanToState 等），读写一律由调用方走 store.mjs 的
// readJson / updateJson / writeJsonAtomic（底座三条强制契约，禁止自己 parse 后写回）。
import { buildCandidate, decayScore, isRecordable, ladderStage, rankPitfalls } from './pitfall-score.mjs';
import { signatureOf } from '../../src/dsh-butler/lib/pitfall-sign.mjs';

export const PITFALL_STORE_VERSION = '0.1.0';

export const PITFALLS_SCHEMA = 1;
export const SCAN_SCHEMA = 1;
export const HEALTH_SCHEMA = 1;
export const CANDIDATES_SCHEMA = 1;

/** 每个坑最多留几个现场样本（防状态文件膨胀）。 */
export const MAX_SAMPLES = 3;
/** 每个坑最多记多少会话 id。 */
export const MAX_SESSION_IDS = 400;
/** 会话健康保留天数。 */
export const HEALTH_RETENTION_DAYS = 90;

export function emptyPitfalls() {
  return { schemaVersion: PITFALLS_SCHEMA, updatedAt: null, device: null, counters: { scans: 0, findings: 0, excluded: 0 }, pitfalls: [] };
}
export function emptyScanState() {
  return { schemaVersion: SCAN_SCHEMA, device: null, updatedAt: null, lastRunId: null, files: {}, counters: { runs: 0, scanned: 0, skipped: 0, bytes: 0 } };
}
export function emptyHealth() {
  return { schemaVersion: HEALTH_SCHEMA, device: null, updatedAt: null, files: {}, summary: { ok: 0, warn: 0, corrupt: 0, unreadable: 0 } };
}
export function emptyCandidates() {
  return { schemaVersion: CANDIDATES_SCHEMA, generatedAt: null, candidates: [] };
}

function trim(s, n) {
  const v = String(s ?? '');
  return v.length > n ? v.slice(0, n) : v;
}

/**
 * 把一次扫描的 findings 合并进坑库（纯函数，可单测）。
 * count 口径 = 同签名总出现次数（同会话重复也计）；lastSeen 取末次出现时间。
 * @param {object} state 现有坑库（emptyPitfalls() 或读盘结果）
 * @param {{errors:object[], now:number, device:string, runId?:string, source?:'scan'|'seed'}} opts
 * @returns {object} 新状态
 */
export function applyScanToState(state, opts) {
  const base = state && typeof state === 'object' ? state : emptyPitfalls();
  const now = Number(opts.now ?? Date.now());
  const device = opts.device ?? 'unknown-host';
  const byId = new Map((base.pitfalls ?? []).map((p) => [p.id, { ...p }]));

  for (const e of opts.errors ?? []) {
    const prev = byId.get(e.id);
    const t = Number(e.time) || now;
    if (!prev) {
      byId.set(e.id, {
        id: e.id,
        sigKey: e.sigKey,
        name: e.name || 'Error',
        code: e.code || 'NO_CODE',
        normText: e.normText ?? '',
        category: e.category ?? '其他',
        tools: { [e.tool ?? '(unlinked)']: 1 },
        count: 1,
        firstSeen: t,
        lastSeen: t,
        sessions: e.sessionId ? [e.sessionId] : [],
        devices: [e.device ?? device],
        samples: [{
          sessionId: e.sessionId, device: e.device ?? device, seq: e.seq, time: t,
          tool: e.tool ?? '(unlinked)', argsHead: trim(e.argsHead, 200), text: trim(e.text, 300),
        }],
        source: opts.source ?? 'scan',
        excluded: false,
      });
      continue;
    }
    prev.count = (Number(prev.count) || 0) + 1;
    if (t > (prev.lastSeen ?? 0)) prev.lastSeen = t;
    if (t < (prev.firstSeen ?? t)) prev.firstSeen = t;
    const tool = e.tool ?? '(unlinked)';
    prev.tools = { ...(prev.tools ?? {}), [tool]: (Number(prev.tools?.[tool]) || 0) + 1 };
    const dev = e.device ?? device;
    if (!Array.isArray(prev.devices)) prev.devices = [];
    if (!prev.devices.includes(dev)) prev.devices.push(dev);
    if (e.sessionId && Array.isArray(prev.sessions) && !prev.sessions.includes(e.sessionId) && prev.sessions.length < MAX_SESSION_IDS) {
      prev.sessions.push(e.sessionId);
    }
    if (!Array.isArray(prev.samples)) prev.samples = [];
    if (prev.samples.length < MAX_SAMPLES) {
      prev.samples.push({
        sessionId: e.sessionId, device: dev, seq: e.seq, time: t,
        tool, argsHead: trim(e.argsHead, 200), text: trim(e.text, 300),
      });
    }
    // 新出现的现场若归到了别的主题（关键词变化），保持首次归类稳定，不来回跳
  }

  const pitfalls = [...byId.values()];
  return {
    ...base,
    schemaVersion: PITFALLS_SCHEMA,
    updatedAt: new Date(now).toISOString(),
    device,
    counters: {
      scans: (Number(base.counters?.scans) || 0) + 1,
      findings: (Number(base.counters?.findings) || 0) + (opts.errors?.length ?? 0),
      excluded: Number(base.counters?.excluded) || 0,
    },
    pitfalls,
  };
}

/** 扫描记账合并（按 sessionId 键；归档移动后 sessionId 不变 → 不重扫）。 */
export function applyScanState(state, { scanUpdates, stats, runId, now, device }) {
  const base = state && typeof state === 'object' ? state : emptyScanState();
  const files = { ...(base.files ?? {}) };
  for (const [sid, rec] of Object.entries(scanUpdates ?? {})) files[sid] = rec;
  return {
    schemaVersion: SCAN_SCHEMA,
    device: device ?? base.device ?? null,
    updatedAt: new Date(now ?? Date.now()).toISOString(),
    lastRunId: runId ?? base.lastRunId ?? null,
    files,
    counters: {
      runs: (Number(base.counters?.runs) || 0) + 1,
      scanned: Number(base.counters?.scanned) || 0,
      skipped: Number(base.counters?.skipped) || 0,
      bytes: Number(base.counters?.bytes) || 0,
    },
    lastStats: stats ?? base.lastStats ?? null,
  };
}

/** 会话健康合并 + 过期清理（保留 90 天）。 */
export function applyHealth(state, { rows, now, device }) {
  const base = state && typeof state === 'object' ? state : emptyHealth();
  const files = { ...(base.files ?? {}) };
  for (const r of rows ?? []) files[r.sessionId] = r;
  const cutoff = (now ?? Date.now()) - HEALTH_RETENTION_DAYS * 86_400_000;
  for (const [sid, r] of Object.entries(files)) {
    if (Number(r?.checkedAt ?? 0) < cutoff) delete files[sid];
  }
  const summary = { ok: 0, warn: 0, corrupt: 0, unreadable: 0 };
  for (const r of Object.values(files)) {
    const k = r?.status ?? 'ok';
    if (summary[k] === undefined) summary[k] = 0;
    summary[k]++;
  }
  return {
    schemaVersion: HEALTH_SCHEMA,
    device: device ?? base.device ?? null,
    updatedAt: new Date(now ?? Date.now()).toISOString(),
    files,
    summary,
  };
}

/**
 * 生成/更新升级候选（≥3 次且跨 ≥2 会话；**永不自动改 persona / 技能**）。
 * 已存在的候选保留原 status / decidedAt（幂等）。
 * @param {object} state 现有候选文件
 * @param {{pitfalls:object[], now:number}} opts
 * @returns {{state:object, added:object[], pending:object[]}}
 */
export function applyCandidates(state, { pitfalls, now }) {
  const base = state && typeof state === 'object' ? state : emptyCandidates();
  const existing = new Map((base.candidates ?? []).map((c) => [c.id, c]));
  const added = [];
  const ranked = rankPitfalls(pitfalls ?? [], now);
  for (const p of ranked) {
    if (p.source === 'seed') continue;
    if (!isRecordable(p)) continue;
    if (ladderStage(p.count, p.sessionCount) !== 'candidate') continue;
    if (existing.has(p.id)) {
      const cur = existing.get(p.id);
      // 次数/权重/分类会变，刷新数值与派生字段；status 保持不变（主人已采纳/忽略的不重开）
      // 2026-09-12：**pending 候选的「建议形态」也随 tick 刷新**——形态判据（错误码映射表）升级后，
      //   面板/候选 JSON 不能还留着旧结论（实测 AUDIT_* 曾被猜成「路径存在性预检」）。
      //   已 decided（adopted/ignored）的候选冻结，保留主人当时的决策依据。
      const fresh = cur.status === 'pending' ? buildCandidate(p, now) : null;
      const formFields = fresh ? { suggested: fresh.suggested, why: fresh.why, options: fresh.options } : {};
      existing.set(p.id, {
        ...cur,
        ...formFields,
        sigKey: p.sigKey, name: p.name, code: p.code, normText: p.normText, category: p.category,
        count: p.count, sessionCount: p.sessionCount, score: p.score, tools: p.tools,
        updatedAt: new Date(now).toISOString(),
      });
      continue;
    }
    const c = buildCandidate(p, now);
    if (!c) continue;
    existing.set(c.id, c);
    added.push(c);
  }
  const candidates = [...existing.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return {
    state: { schemaVersion: CANDIDATES_SCHEMA, generatedAt: new Date(now).toISOString(), candidates },
    added,
    pending: candidates.filter((c) => c.status === 'pending'),
  };
}

/** 坑库概览（面板 / 简报用）。 */
export function summarizePitfalls(state, now) {
  const ranked = rankPitfalls(state?.pitfalls ?? [], now ?? Date.now());
  const recordable = ranked.filter((p) => isRecordable(p) && !p.excluded);
  const byCategory = {};
  for (const p of recordable) byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
  return {
    total: ranked.length,
    recordable: recordable.length,
    surfaced: recordable.filter((p) => p.stage !== 'recorded').length,
    candidates: recordable.filter((p) => p.stage === 'candidate').length,
    likelyFixed: recordable.filter((p) => p.likelyFixed).length,
    byCategory,
    updatedAt: state?.updatedAt ?? null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// R-1 · 手动插入入口（卡 A44 · 2026-10-26 主人拍板「其他按建议」）
//
// 为什么要它：P4 坑库以前**只有一条写入口** —— `applyScanToState`（翻会话日志里捕获的错误自动扫）。
//   人工发现的坑（已经写进 `docs\坑库\*.md`、但自动扫不到的那些）因此**进不了 store** ⇒
//   Top3 / 追溯 CLI 都看不见它（实例：C25「spawnSync ssh 默认 stdio:'pipe' ⇒ 空等 stdin 撞 90s」）。
//
// 口径 —— **不另起一套，与自动路径同一套**：
//   · 签名与 id 复用 `signatureOf({name, code, text})`（lib/pitfall-sign.mjs）⇒ 人工条与自动条
//     只要 (name, code, normText) 相同就**合并成同一条**（不会一坑两条、不会双份 count）。
//   · count 累加 / firstSeen 取更早 / lastSeen 取更晚 / samples ≤ MAX_SAMPLES / sessions ≤ MAX_SESSION_IDS
//     —— 与 applyScanToState 完全同语义。
//   · `source: 'manual'` 是新值（区别于 'scan' / 'seed'）：**评分算法不认它**
//     （pitfall-score.mjs 只有 `source === 'seed'` 走基准权重分支；'manual' 与 'scan' 同走 count × 衰减）。
//   · `excluded: true` ⇒ 不进榜（topN 与渲染都滤 excluded），但**追溯 CLI 仍能查到**（它不滤 excluded）
//     —— 这就是「测试条能验证链路、却不污染榜单」的做法。
//   · 纯增量键：`sourceDoc`（出处 `档:行`）/ `note`（一句话主题）/ `counters.manualInserts`。
export const MANUAL_SOURCE = 'manual';
/** 分类名长度上限（防手滑粘一整段进来把渲染撑开）。 */
export const MAX_CATEGORY_LEN = 24;

/** 把「一次手动插入」折进坑库计数器（纯函数；落盘由调用方走 store.mjs 的 updateJson）。
 *  ⚠️ `counters.manualInserts` 是**累计**计数（历史上一共经这个入口插过几次），
 *     **不是"当前库里有多少 manual 条"** ⇒ 撤销（removeManualPitfall）不回退它。
 *     要看当前 manual 条数：`pitfalls.filter(p => p.source === 'manual').length`。 */
function withManualCounters(base, inserted) {
  const c = base.counters ?? {};
  return {
    scans: Number(c.scans) || 0,
    findings: Number(c.findings) || 0,
    excluded: Number(c.excluded) || 0,
    manualInserts: (Number(c.manualInserts) || 0) + (inserted ? 1 : 0),
  };
}

/**
 * 手动插入 / 累加一条坑。
 * @param {object} state 现有坑库（emptyPitfalls() 或读盘结果）
 * @param {{text:string, name?:string, code?:string, category?:string, count?:number,
 *          tool?:string, sessionId?:string, sample?:string, argsHead?:string,
 *          sourceDoc?:string, note?:string, excluded?:boolean,
 *          device?:string, now?:number}} opts
 *   `text` 必填 = 报错原文 / 检索用原文（会过 normalizeErrorText，路径/时间/PID 会被归一）。
 * @returns {{state:object, action:'inserted'|'updated', pitfall:object}}
 */
export function insertManualPitfall(state, opts = {}) {
  const base = state && typeof state === 'object' ? state : emptyPitfalls();
  const now = Number(opts.now ?? Date.now());
  const device = String(opts.device ?? base.device ?? 'unknown-host');
  const text = String(opts.text ?? '').trim();
  if (!text) throw new Error('insertManualPitfall：缺 text（报错原文 / 检索用原文）');

  const toolName = String(opts.tool ?? '').trim() || '(unlinked)';
  const sig = signatureOf({ name: opts.name ?? 'Error', code: opts.code ?? 'NO_CODE', text });
  const addCount = Math.max(1, Math.trunc(Number(opts.count) || 1));
  const category = trim(String(opts.category ?? '').trim() || '其他', MAX_CATEGORY_LEN);
  const sample = {
    sessionId: opts.sessionId ?? null,
    device,
    seq: null,
    time: now,
    tool: toolName,
    argsHead: trim(opts.argsHead ?? '', 200),
    text: trim(opts.sample ?? text, 300),
  };

  const byId = new Map((base.pitfalls ?? []).map((p) => [p.id, { ...p }]));
  const prev = byId.get(sig.id);

  if (!prev) {
    const p = {
      id: sig.id,
      sigKey: sig.sigKey,
      name: sig.name,
      code: sig.code,
      normText: sig.normText,
      category,
      tools: { [toolName]: addCount },
      count: addCount,
      firstSeen: now,
      lastSeen: now,
      sessions: opts.sessionId ? [String(opts.sessionId)] : [],
      devices: [device],
      samples: [sample],
      source: MANUAL_SOURCE,
      excluded: opts.excluded === true,
      sourceDoc: opts.sourceDoc ? trim(String(opts.sourceDoc), 200) : null,
      note: opts.note ? trim(String(opts.note), 200) : null,
    };
    byId.set(p.id, p);
    return {
      state: {
        ...base,
        schemaVersion: PITFALLS_SCHEMA,
        updatedAt: new Date(now).toISOString(),
        device,
        counters: withManualCounters(base, true),
        pitfalls: [...byId.values()],
      },
      action: 'inserted',
      pitfall: p,
    };
  }

  // 已有同签名 ⇒ 累加（人工条与自动条撞同一签名时也走这里，绝不另建第二条）
  const p = { ...prev };
  p.count = (Number(p.count) || 0) + addCount;
  p.lastSeen = Math.max(Number(p.lastSeen) || 0, now);
  p.firstSeen = Math.min(Number(p.firstSeen) || now, now);
  p.tools = { ...(p.tools ?? {}), [toolName]: (Number(p.tools?.[toolName]) || 0) + addCount };
  if (!Array.isArray(p.devices)) p.devices = [];
  if (!p.devices.includes(device)) p.devices.push(device);
  if (!Array.isArray(p.sessions)) p.sessions = [];
  if (opts.sessionId && !p.sessions.includes(String(opts.sessionId)) && p.sessions.length < MAX_SESSION_IDS) {
    p.sessions.push(String(opts.sessionId));
  }
  if (!Array.isArray(p.samples)) p.samples = [];
  if (p.samples.length < MAX_SAMPLES) p.samples.push(sample);
  // 人工这次给的信息可以补/改（归类与出处以最近一次人工为准）；source / firstSeen 保持首次不动
  if (opts.category) p.category = category;
  if (opts.sourceDoc) p.sourceDoc = trim(String(opts.sourceDoc), 200);
  if (opts.note) p.note = trim(String(opts.note), 200);
  if (opts.excluded !== undefined) p.excluded = opts.excluded === true;
  byId.set(p.id, p);
  return {
    state: {
      ...base,
      schemaVersion: PITFALLS_SCHEMA,
      updatedAt: new Date(now).toISOString(),
      device,
      counters: withManualCounters(base, false),
      pitfalls: [...byId.values()],
    },
    action: 'updated',
    pitfall: p,
  };
}

/**
 * 撤掉一条**人工插进来的**坑（测试条 / 插错了）。
 * 🔴 只许删 `source === 'manual'` 的条目 —— 自动扫出来的坑是"真踩过"的证据，
 *    这个入口不是给它用的（要走就直接改库，别拿随手 CLI 抹证据）。
 * @param {object} state
 * @param {{id:string|string[], now?:number}} opts `id` 支持完整 id 或**唯一前缀**
 * @returns {{state:object, action:'removed'|'not-found'|'ambiguous'|'refused-not-manual', removed?:object, hits:string[], source?:string}}
 */
export function removeManualPitfall(state, opts = {}) {
  const base = state && typeof state === 'object' ? state : emptyPitfalls();
  const now = Number(opts.now ?? Date.now());
  const wanted = (Array.isArray(opts.id) ? opts.id : [opts.id]).map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) throw new Error('removeManualPitfall：缺 id（完整 id 或唯一前缀）');
  const keys = wanted.map((q) => q);
  const hits = (base.pitfalls ?? []).filter((p) => {
    const id = String(p.id ?? '').toLowerCase();
    return keys.some((q) => id === q) || (keys.length === 1 && id.startsWith(keys[0]));
  });
  if (!hits.length) return { state: base, action: 'not-found', hits: [] };
  if (hits.length > 1) return { state: base, action: 'ambiguous', hits: hits.map((p) => p.id) };
  const target = hits[0];
  if (target.source !== MANUAL_SOURCE) {
    return { state: base, action: 'refused-not-manual', hits: [target.id], source: target.source ?? 'unknown' };
  }
  const rest = (base.pitfalls ?? []).filter((p) => String(p.id) !== String(target.id));
  return {
    state: {
      ...base,
      schemaVersion: PITFALLS_SCHEMA,
      updatedAt: new Date(now).toISOString(),
      counters: withManualCounters(base, false),
      pitfalls: rest,
    },
    action: 'removed',
    removed: target,
    hits: [target.id],
  };
}

export { decayScore };
