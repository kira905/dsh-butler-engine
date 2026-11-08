// dsh-butler / lib/handoff-core.mjs —— P9 H1a 手动交接器 · 纯函数层
//
// 方案：docs\大管家v2.5-P9会交接与云中继方案-20260910.md
//   §4.2 落地层五动作（拉取 / 合并 / 分发 / 部署 C 类 / 自检）
//   §5.1 Arrive A1–A7、§5.2 Depart 5 步、§5.3 技术强制
//   §5.4 交接单字段白名单 + handoff-record.schema.json
//   §17.1 T3（重复 Arrive 静默覆盖本机改动 → 需要 Arrive 侧对偶门）
//
// 本文件只做**纯函数 + 只读 IO**（哈希 / 清单展开 / 对偶门规划 / schema 校验 / 记录构造）。
// 一切写盘（分发落地、备份、交接单落盘）由 handoff.mjs 编排，便于单测与复核。
//
// 铁律（写死在实现里）：
//   1. 交接单**绝不写生产绝对路径**（字段只有 host 名 / 仓内相对路径 / key / 哈希 / 条数）。
//      实现层用 `assertNoAbsolutePaths()` 在写盘前硬校验（命中即拒绝写入）。
//   2. 文本文件哈希一律**规范化 LF 后**计算（仓检出自带 CRLF，直接 sha256 必然误报 —— §4.2 阻断 B8）。
//   3. 禁镜像语义：本模块只做"覆盖 / 新增"，**任何路径都不删除目标端多余文件**（无 purge、无 delete）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMPONENT_ROOT, dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';

export const HANDOFF_CORE_VERSION = '0.1.0';
export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_TOOL_NAME = 'dsh-handoff';

/** 本机交接单路径：统一入口（legacy 期 = `<home>\butler-handoff.json`）。 */
export function handoffStatePath(home = dshHome()) { return resolveStatePath(HANDOFF_STATE_NAME, { home }).path; }

/** 本机交接单（schemaVersion 1）；`sync:false` —— 单机文件，随仓同步的是 dsh/butler-handoff/<host>.json。 */
export const HANDOFF_STATE_NAME = 'butler-handoff.json';
/** 仓1（dsh-core）内跨机副本目录（按主机名前缀，与 butler-audit/ 同款）。 */
export const HANDOFF_REPO_SUBDIR = 'dsh/butler-handoff';
/** 允许的锚点：`dsh` → ~/.dsh（生产），`ws` → 数据区根。清单与交接单只出现锚点 + 相对路径。 */
export const ANCHORS = ['dsh', 'ws'];
export const HANDOFF_SCHEMA_FILE = path.join(COMPONENT_ROOT, 'handoff-record.schema.json');
export const HANDOFF_MANIFEST_FILE = path.join(COMPONENT_ROOT, 'handoff-manifest.json');

/** 分发时跳过的目录名 / 文件模式（与仓3 采集排除口径一致，避免把依赖闭包与备份搬回生产）。 */
export const SKIP_DIR_RE = /^(node_modules|\.git|_archive|_tmp|generated|logs|snapshots|backups)$/i;
export const SKIP_FILE_RE = /(\.bak|\.bak-|\.tmp|\.orig|\.old|\.before-restore|\.corrupt-)/i;

/** 当前主机名（小写短名，跨机文件名用）。 */
export function currentHost(env = process.env) {
  const raw = env.DSH_HANDOFF_HOST || env.COMPUTERNAME || env.HOSTNAME;
  return String(raw ?? 'unknown-host').trim().toLowerCase();
}

// ---------------------------------------------------------------- 哈希（规范化）

/**
 * 内容哈希：文本 → CRLF 归一为 LF 后哈希；二进制 → 原字节哈希。
 * @param {Buffer} buf
 * @returns {{sha256:string, normalized:boolean, bytes:number}}
 */
export function hashBuffer(buf) {
  const binary = buf.includes(0);
  const payload = binary ? buf : Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return {
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    normalized: !binary,
    bytes: buf.length,
  };
}

/** 文件哈希（不存在 / 读失败 → null；绝不抛）。 */
export function hashFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { ...hashBuffer(fs.readFileSync(file)), path: file, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- .ps1 BOM 门（H3 · 2026-09-16）

/**
 * UTF-8 BOM 字节 `EF BB BF`。
 * 为什么必须有这道门（方案 §5.3 / docs\换机必补清单.md 的实测结论）：
 *   带中文注释 / 中文字符串的 `.ps1` 在 **PowerShell 5.1** 下按 ANSI(GBK) 解读 —— 少了 BOM
 *   会乱码甚至解析崩（`dsh-start.ps1` / `dsh-shutdown.ps1` 都是带中文的核心启动链）。
 *   分发是**字节覆盖**：源缺 BOM 就会把对端的正确文件换成坏的 → 必须**拒绝分发并告警**。
 * ⚠️ `.cmd` / `.bat` 恰恰相反（必须纯 ASCII、**不要** BOM），故只对 `.ps1` 设门。
 */
export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const BOM_REQUIRED_RE = /\.ps1$/i;

/** 该路径是否需要 UTF-8 BOM（判据只看扩展名，不看内容）。 */
export function bomRequired(file) {
  return BOM_REQUIRED_RE.test(String(file ?? ''));
}

/** 文件是否以 UTF-8 BOM 开头（读不到 → null，绝不抛）。 */
export function fileHasUtf8Bom(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(3);
      const n = fs.readSync(fd, buf, 0, 3, 0);
      return n === 3 && buf.equals(UTF8_BOM);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 文件是否含非 ASCII 字节（≥0x80；读不到 → null）。
 * 这是 BOM 门的**风险判据**：纯 ASCII 的 `.ps1` 没有 BOM 也能被 PS5.1 正确解析，
 * 只有含中文/全角字符的才必须带 BOM（实测 2026-09-16：本机 `_test/*.ps1` 三个夹具是纯 ASCII，
 * 一刀切要求 BOM 会把他们误判成 `skipped-no-bom`）。
 */
export function fileHasNonAsciiBytes(file) {
  try {
    const buf = fs.readFileSync(file);
    for (const b of buf) if (b >= 0x80) return true;
    return false;
  } catch {
    return null;
  }
}

/**
 * 分发前的 BOM 门：只有 `.ps1` 且**含非 ASCII 字节**时才必须带 BOM。
 * @returns {{required:boolean, hasBom:boolean|null, nonAscii:boolean|null, risky:boolean}}
 *   risky=true → 调用方必须拒绝分发（源缺 BOM 会把对端的正确文件换成 PS5.1 读不懂的）
 */
export function checkBomRequirement(src) {
  if (!bomRequired(src)) return { required: false, hasBom: null, nonAscii: null, risky: false };
  const hasBom = fileHasUtf8Bom(src) === true;
  if (hasBom) return { required: true, hasBom: true, nonAscii: fileHasNonAsciiBytes(src), risky: false };
  const nonAscii = fileHasNonAsciiBytes(src);
  return { required: true, hasBom: false, nonAscii, risky: nonAscii !== false };
}

// ---------------------------------------------------------------- JSON / 清单

/** 读 JSON（容错；空文件 / 损坏 → defaultValue，绝不抛）。 */
export function readJsonSafe(file, defaultValue = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return defaultValue;
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

/** 读交接单 schema（缺文件即视为配置缺失，调用方必须显式处理）。 */
export function loadSchema(file = HANDOFF_SCHEMA_FILE) {
  const schema = readJsonSafe(file, null);
  if (!schema || typeof schema !== 'object') {
    throw new Error(`交接单 schema 不存在或非法：${file}`);
  }
  return schema;
}

/** 读分发清单（同一份 JSON 随仓3 同步；机器可读 + 人工可复核）。 */
export function loadManifest(file = HANDOFF_MANIFEST_FILE) {
  const m = readJsonSafe(file, null);
  if (!m || typeof m !== 'object' || !Array.isArray(m.entries)) {
    throw new Error(`分发清单不存在或非法：${file}`);
  }
  return m;
}

// ---------------------------------------------------------------- schema 校验（JSON Schema 子集）

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function walkSchema(schema, value, at, errors) {
  const wanted = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : null);
  if (wanted) {
    const actual = typeOf(value);
    const ok = wanted.some((t) => t === actual || (t === 'integer' && actual === 'number' && Number.isInteger(value)));
    if (!ok) {
      errors.push(`${at}: 期望 ${wanted.join('|')}，实际 ${actual}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${at}: 值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof schema.maxLength === 'number' && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(`${at}: 字符串长度 ${value.length} 超过 maxLength ${schema.maxLength}`);
  }
  if (schema.type === 'object' || (wanted && wanted.includes('object'))) {
    const props = schema.properties ?? {};
    const obj = value ?? {};
    for (const r of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, r)) errors.push(`${at}: 缺必需字段 ${r}`);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) walkSchema(props[k], v, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) {
        errors.push(`${at}.${k}: 白名单外字段（§5.4 字段白名单只允许 ${Object.keys(props).join(', ')}）`);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${at}: 数组长度 ${value.length} 超过 maxItems ${schema.maxItems}`);
    }
    value.forEach((v, i) => walkSchema(schema.items, v, `${at}[${i}]`, errors));
  }
}

/** 按 schema 校验交接单（多余字段 = 拒绝写入，§5.4「字段白名单要机器可校验」）。 */
export function validateRecord(record, schema = loadSchema()) {
  const errors = [];
  walkSchema(schema, record, '$', errors);
  return { ok: errors.length === 0, errors };
}

/**
 * 生产绝对路径扫描（§5.4「绝不写生产绝对路径」的机器判据）。
 * 命中 → 调用方必须拒绝写入（不是告警）。
 */
export const ABS_PATH_RE = /(?:^|[\s"'([=:])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+\\|\/(?:home|Users|mnt)\/)/;

export function findAbsolutePaths(value, at = '$', out = []) {
  if (typeof value === 'string') {
    if (ABS_PATH_RE.test(value)) out.push({ at, sample: value.slice(0, 120) });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findAbsolutePaths(v, `${at}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findAbsolutePaths(v, `${at}.${k}`, out);
  }
  return out;
}

/** 写盘前硬校验：schema 白名单 + 无绝对路径。返回 {ok, errors}。 */
export function assertWritableRecord(record, schema = loadSchema()) {
  const errors = [];
  const v = validateRecord(record, schema);
  if (!v.ok) errors.push(...v.errors.map((e) => `schema: ${e}`));
  const abs = findAbsolutePaths(record);
  for (const a of abs) errors.push(`绝对路径违规: ${a.at} = ${a.sample}`);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- 锚点 / 清单展开

/** 锚点 → 生产根目录（`dsh` = ~/.dsh，`ws` = 数据区根）。 */
export function anchorRoot(anchor, ctx) {
  if (anchor === 'dsh') return ctx.dshHome;
  if (anchor === 'ws') return ctx.dshRoot;
  return null;
}

function toForward(p) {
  return String(p).replace(/\\/g, '/');
}

/** 递归列目录下的普通文件（相对/正斜杠；跳过排除项）。 */
export function listFilesRecursive(root, relBase = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIR_RE.test(e.name)) continue;
      out.push(...listFilesRecursive(path.join(root, e.name), rel));
    } else if (e.isFile()) {
      if (SKIP_FILE_RE.test(e.name)) continue;
      out.push(rel);
    }
  }
  return out;
}

/**
 * 展开一个清单条目 → 逐文件项（key 跨机同义：`<anchor>:<生产相对路径>`）。
 * @param {{key:string, repo:string, repoPath:string, anchor:string, rel:string, type:'file'|'dir', enabled?:boolean, note?:string}} entry
 * @param {{workDirs:Record<string,string>, dshHome:string, dshRoot:string}} ctx
 * @returns {{files:Array<object>, error:string|null}}
 */
export function expandManifestEntry(entry, ctx) {
  if (entry.enabled === false) return { files: [], error: null, disabled: true };
  const root = anchorRoot(entry.anchor, ctx);
  if (!root) return { files: [], error: `未知锚点 ${entry.anchor}` };
  const srcRoot = path.join(ctx.workDirs[entry.repo] ?? '', toForward(entry.repoPath));
  const rels = entry.type === 'dir' ? listFilesRecursive(srcRoot) : [''];
  if (!rels.length) return { files: [], error: `仓内源路径为空或不存在：${entry.repo}:${entry.repoPath}` };
  const files = rels.map((r) => {
    const prodRel = r ? `${toForward(entry.rel).replace(/\/+$/, '')}/${r}` : toForward(entry.rel);
    return {
      key: `${entry.anchor}:${prodRel}`,
      repo: entry.repo,
      repoPath: r ? `${toForward(entry.repoPath).replace(/\/+$/, '')}/${r}` : toForward(entry.repoPath),
      prodRel,
      anchor: entry.anchor,
      src: path.join(srcRoot, r.replace(/\//g, path.sep)),
      dst: path.join(root, prodRel.replace(/\//g, path.sep)),
    };
  });
  return { files, error: null };
}

/** 展开整份清单（enabled 条目 → 文件项；disabled 条目进 skippedEntries 供复核）。 */
export function expandManifest(manifest, ctx) {
  const files = [];
  const errors = [];
  const disabled = [];
  for (const entry of manifest.entries ?? []) {
    if (entry.enabled === false) {
      disabled.push({ key: entry.key, note: entry.note ?? '' });
      continue;
    }
    const r = expandManifestEntry(entry, ctx);
    if (r.error) errors.push(`${entry.key}: ${r.error}`);
    else files.push(...r.files);
  }
  return { files, errors, disabled };
}

// ---------------------------------------------------------------- T3 对偶门

/**
 * Arrive 分发前的**对偶门**（§17.1 T3）：把"上一次交接单记录的 sha256"与"目标生产文件当前 hash"比对。
 *
 * 判据（全部 fail-closed —— 不确定时一律不覆盖）：
 *   - 目标不存在                → `applied`（新增，无覆盖风险）
 *   - 内容与仓内一致             → `unchanged`（不写盘）
 *   - 有基线且基线 == 当前 hash  → `applied`（本机未改动）
 *   - 有基线但基线 != 当前 hash  → `skipped-diverged`（本机在两次交接之间改过）→ 需人工确认
 *   - 无基线且内容不同           → `skipped-unrecorded`（无法证明本机没改）→ 需人工确认（`--adopt-unrecorded`）
 *
 * @param {Array<{key:string, src:string, dst:string, repoPath:string}>} files
 * @param {Record<string,{sha256?:string, mode?:string, status?:string}>} baseline 上一次交接单 applied[] 索引
 * @param {{confirmDiverged?:boolean, adoptUnrecorded?:boolean}} [opts]
 */
export function planDispatch(files, baseline = {}, opts = {}) {
  const plan = [];
  const alerts = [];
  for (const f of files) {
    const src = hashFile(f.src);
    if (!src) {
      plan.push({ ...f, action: 'skipped-missing-src', reason: '仓内文件不存在（未采集或清单过期）', sha256: null, bytes: 0 });
      alerts.push({ level: 'warn', code: 'missing-src', message: `清单项在仓内缺失：${f.key}` });
      continue;
    }
    const dst = hashFile(f.dst);
    const base = { ...f, sha256: src.sha256, bytes: src.bytes };
    // BOM 门（H3）：源 .ps1 **含非 ASCII 字节却缺 BOM** → 拒绝分发（字节覆盖会把对端的好文件换成坏的）
    const bom = checkBomRequirement(f.src);
    if (bom.risky) {
      plan.push({ ...base, action: 'skipped-no-bom', reason: '源 .ps1 含非 ASCII 字节但缺 UTF-8 BOM（EF BB BF）→ 拒绝覆盖（PS5.1 读中文会乱码/崩）', dstSha256: dst?.sha256 ?? null, prevSha256: baseline[f.key]?.sha256 ?? null, bom });
      alerts.push({ level: 'alert', code: 'ps1-missing-bom', message: `分发被拒：${f.key} 的仓内源 .ps1 缺 UTF-8 BOM（先修仓内文件再重跑 Arrive）` });
      continue;
    }
    if (!dst) {
      plan.push({ ...base, action: 'applied', reason: '目标不存在（新增）', dstSha256: null });
      continue;
    }
    if (dst.sha256 === src.sha256) {
      plan.push({ ...base, action: 'unchanged', reason: '与仓内一致', dstSha256: dst.sha256 });
      continue;
    }
    const prev = baseline[f.key];
    const prevSha = prev && typeof prev.sha256 === 'string' ? prev.sha256 : null;
    if (!prevSha) {
      if (opts.adoptUnrecorded) {
        plan.push({ ...base, action: 'applied', reason: '无交接基线（人工确认覆盖）', dstSha256: dst.sha256, prevSha256: null, unrecorded: true });
      } else {
        plan.push({ ...base, action: 'skipped-unrecorded', reason: '无交接基线且内容不同 → 拒绝覆盖（人工确认）', dstSha256: dst.sha256, prevSha256: null });
        alerts.push({ level: 'warn', code: 'unrecorded', message: `无交接基线的文件被跳过（需人工确认）：${f.key}` });
      }
      continue;
    }
    if (prevSha === dst.sha256) {
      plan.push({ ...base, action: 'applied', reason: '本机未改动（与基线一致）', dstSha256: dst.sha256, prevSha256: prevSha });
      continue;
    }
    if (opts.confirmDiverged) {
      plan.push({ ...base, action: 'applied', reason: '本机已改动但人工确认覆盖（--confirm-diverged）', dstSha256: dst.sha256, prevSha256: prevSha, diverged: true });
    } else {
      plan.push({ ...base, action: 'skipped-diverged', reason: '本机在两次交接之间有改动（基线不符）→ 跳过不覆盖', dstSha256: dst.sha256, prevSha256: prevSha });
      alerts.push({ level: 'alert', code: 'diverged', message: `本机改动将被覆盖风险，已跳过：${f.key}` });
    }
  }
  return { plan, alerts };
}

/** 把 apply 结果汇总成交接单 applied[]（§5.4：{key, repoPath, sha256, ok} + 本交接器的 status/mode/bytes）。
 *
 * sha256 语义 = **本机生产文件在本次交接结束时的"已交接基线"**：
 *   · applied / unchanged → 仓内哈希（= 写入后目标内容）
 *   · skipped-*           → **保留上一次的基线值**（本机改动不算已被交接；下次仍会判 diverged）
 *                          没有旧基线 → null（下次判 unrecorded）
 */
export function toAppliedRows(plan, mode = 'arrive-distribute') {
  return plan.map((p) => {
    const ok = p.action === 'applied' || p.action === 'unchanged';
    const sha256 = ok ? (p.sha256 ?? null) : (p.prevSha256 ?? null);
    return {
      key: p.key,
      repoPath: p.repoPath,
      sha256,
      ok,
      status: p.action,
      mode,
      bytes: p.bytes ?? 0,
    };
  });
}

/** 上一次交接单 applied[] → 基线索引（后写覆盖先写；无 sha256 的项不建立基线）。 */
export function baselineFromRecord(record) {
  const map = {};
  for (const row of record?.applied ?? []) {
    if (!row || typeof row.key !== 'string') continue;
    if (typeof row.sha256 !== 'string' || !row.sha256) continue;
    map[row.key] = { sha256: row.sha256, mode: row.mode ?? null, status: row.status ?? null };
  }
  return map;
}

// ---------------------------------------------------------------- 记录构造

/** 空交接单骨架（字段与 handoff-record.schema.json 一一对应）。 */
export function emptyRecord(host = currentHost(), now = new Date().toISOString()) {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    host,
    role: 'arrive',
    startedAt: now,
    finishedAt: null,
    result: 'failed',
    repos: [],
    volumes: [],
    dshVersion: null,
    pluginVersions: {},
    merged: [],
    applied: [],
    bootstrap: [],
    handedOffSessions: [],
    deferred: [],
    alerts: [],
    lastHeartbeatAt: null,
    lastSuccessfulHandoffAt: null,
  };
}

/** 仓体积（遍历工作副本全树，含 .git —— §5.4 R6 的体积阈值口径就是"这个仓占多少盘"）。 */
export function measureRepoVolume(root) {
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch { /* 占用/权限：跳过单文件，不影响总体积口径 */ }
      }
    }
  };
  walk(root);
  return { sizeBytes: bytes, files };
}

/** RFC3339 → epoch ms（非法 → null）。 */
export function tsToMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 心跳新鲜度判定（§5.7 唯一权威口径：90min 陈旧阈值 / 24h 面板红条）。 */
export function judgeHeartbeat(peerRecord, { startedAtMs = Date.now(), staleHeartbeatMs = 90 * 60 * 1000, staleHandoffMs = 24 * 3600 * 1000 } = {}) {
  const out = { dualActive: false, heartbeatStale: null, handoffStale: null, reasons: [] };
  if (!peerRecord) {
    out.reasons.push('对端无记录（新机 / 冷启动）→ 放行');
    return out;
  }
  const hb = tsToMs(peerRecord.lastHeartbeatAt);
  const sh = tsToMs(peerRecord.lastSuccessfulHandoffAt);
  const now = Date.now();
  if (hb === null) out.reasons.push('对端无心跳字段 → 放行');
  else if (hb > startedAtMs) {
    out.dualActive = true;
    out.reasons.push('对端心跳在本机 Arrive 进行中被更新 → 双开嫌疑（fail-closed）');
  } else if (now - hb > staleHeartbeatMs) {
    out.heartbeatStale = true;
    out.reasons.push(`对端心跳陈旧 ${Math.round((now - hb) / 60000)} 分钟（阈值 ${Math.round(staleHeartbeatMs / 60000)}）`);
  } else {
    out.reasons.push('对端心跳新鲜但早于本次 Arrive 起点 → 不判双开');
  }
  if (sh !== null && now - sh > staleHandoffMs) {
    out.handoffStale = true;
    out.reasons.push(`对端上次完整交接距今 ${(Math.round((now - sh) / 360000) / 10).toFixed(1)} 小时（阈值 ${Math.round(staleHandoffMs / 3600000)}h）→ 对端可能崩在半路`);
  }
  return out;
}

export { COMPONENT_ROOT };
