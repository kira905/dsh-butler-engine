// dsh-butler / pitfall-cluster-tick.mjs —— P4 坑聚类（方案 §5 C 点）的独立 CLI
//
// 干什么：读坑库 + `source='pitfall'` 向量库 → 向量二级聚类 → 写 `~/.dsh/butler-p4-clusters.json`。
//   **只写自己的文件**（唯一的写者，方案 §C.2-4）；坑库/候选池/向量库**一律只读**。
//
// 写入方约定（方案 §C.2-4 的 C5）：
//   · 本脚本 = `butler-p4-clusters.json` 的**唯一写者**；
//   · **原子写**（`store.writeJsonAtomic`：临时文件 + rename，读者看不到半截）；
//   · 互斥 = 锁名 `tick-pitfall-cluster`（手动跑与 job 不得同时写同一个文件）。
//
// 优雅降级（方案 §C.6 第二行）：无向量库 / 库损坏 ⇒ 输出「单条成族」的**恒等聚类**（= 现状）
//   + 日志一行，**不报错给主人**（exit 0）。
//
// 用法：
//   node pitfall-cluster-tick.mjs --dsh-home <workspace>\_tmp\iso --json
//   node pitfall-cluster-tick.mjs --home ~/.dsh --dry-run     # 只算不写
//   node pitfall-cluster-tick.mjs --eps 0.9 --home <dir>                  # 换阈值
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dshHome, statePath } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { writeJsonAtomic, writeTextAtomic } from '../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../src/dsh-butler/lib/dual-write.mjs';
import { acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { clusterPitfalls, identityClusters, EPS_CANDIDATES, DEFAULT_MIN_SIZE } from './lib/pitfall-cluster.mjs';

export const CLUSTERS_SCHEMA = 1;
/** 名字常量 → 统一状态入口（覆盖窗口要它贴在上面；函数提升供 runClusterTick 用）。 */
function stateFileOf(name, home) { return resolveStatePath(name, { home }).path; }

export const CLUSTERS_FILE = 'butler-p4-clusters.json';
export const LOCK_NAME = 'tick-pitfall-cluster';
export const ADVISORY_NOTICE = '⚠️ advisoryOnly：本文件只是「收敛展示」的建议，不得据此修改任何坑的 count/excluded/候选 status。';

function isMainEntry(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(importMetaUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      flags[body] = argv[i + 1];
      i += 1;
    } else flags[body] = true;
  }
  return flags;
}

/** 只读打开向量库，取某来源的全部向量（矩阵形式；顺序按 ref_id 稳定排序） */
export function loadVectorMatrix(dbPath, source = 'pitfall') {
  if (!fs.existsSync(dbPath)) return { ok: false, reason: `向量库不存在：${dbPath}`, refIds: [], data: new Float32Array(0), dim: 0, count: 0 };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000;');
    // ⚠️ 稳定排序：ref_id 是 16 位 hex，`CAST(... AS INTEGER)` 恒为 0 ⇒ 不能用它（方案 §1.3-③.2 / 判据 3）
    const rows = db.prepare('SELECT ref_id, dim, vec FROM vectors WHERE source = ? ORDER BY ref_id ASC').all(source);
    if (!rows.length) return { ok: true, reason: 'no-vectors-for-source', refIds: [], data: new Float32Array(0), dim: 0, count: 0 };
    const dim = Number(rows[0].dim);
    const data = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => {
      const buf = r.vec;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const v = new Float32Array(ab);
      if (v.length !== dim) throw new Error(`向量 blob 长度异常：ref_id=${r.ref_id} len=${v.length} 期望 ${dim}`);
      data.set(v, i * dim);
    });
    return { ok: true, refIds: rows.map((r) => String(r.ref_id)), data, dim, count: rows.length };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e), refIds: [], data: new Float32Array(0), dim: 0, count: 0 };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function readPitfalls(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: `坑库不存在：${file}`, rows: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.pitfalls) ? raw.pitfalls : null;
    if (!list) return { ok: false, reason: `坑库结构不认识（应含 pitfalls 数组）：${file}`, rows: [] };
    return { ok: true, rows: list.filter((x) => x && x.id != null) };
  } catch (e) {
    return { ok: false, reason: `坑库解析失败：${file}（${String(e && e.message ? e.message : e)}）`, rows: [] };
  }
}

function tsCompact(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function runClusterTick({
  home = dshHome(),
  vectorsDb = null,
  pitfallsFile = null,
  outFile = null,
  eps = 0.85,
  minSize = DEFAULT_MIN_SIZE,
  dryRun = false,
  now = Date.now(),
} = {}) {
  const vdb = vectorsDb || path.join(home, 'memory-vectors', 'vectors.db');
  const pfile = pitfallsFile || statePath('butler-pitfalls.json', home);
  const out = outFile || stateFileOf(CLUSTERS_FILE, home);
  const runId = `${tsCompact(new Date(now))}-${crypto.randomBytes(3).toString('hex')}`;
  const log = [`[memv2] cluster run runId=${runId} eps=${eps} home=${home}`];

  const pj = readPitfalls(pfile);
  if (!pj.ok) {
    log.push(`[memv2] cluster fail reason=${pj.reason}`);
    return { ok: false, status: 'pitfalls-unreadable', reason: pj.reason, runId, log, written: false };
  }

  const vm = loadVectorMatrix(vdb, 'pitfall');
  let result;
  let degraded = false;
  if (!vm.ok || !vm.count) {
    degraded = true;
    result = identityClusters(pj.rows, vm.ok ? 'no-vectors-for-source' : vm.reason);
    log.push(`[memv2] cluster degraded reason=${result.stats.reason}（恒等聚类，= 现状；不报错）`);
  } else {
    const entries = vm.refIds.map((refId, i) => ({ refId, vec: vm.data.subarray(i * vm.dim, (i + 1) * vm.dim) }));
    let byIdMap = new Map();
    try {
      byIdMap = new Map(pj.rows.map((r) => [String(r.id), r]));
      const r = clusterPitfalls({ rows: pj.rows, vectors: entries, eps: Number(eps), minSize: Number(minSize) });
      result = r;
    } catch (e) {
      degraded = true;
      result = identityClusters(pj.rows, `cluster-error: ${String(e && e.message ? e.message : e)}`);
      log.push(`[memv2] cluster degraded reason=${result.stats.reason}`);
    } finally {
      byIdMap.clear();
    }
  }

  const doc = {
    schemaVersion: CLUSTERS_SCHEMA,
    advisoryOnly: true,
    notice: ADVISORY_NOTICE,
    generatedAt: new Date(now).toISOString(),
    asOf: new Date(now).toISOString(),
    runId,
    source: {
      pitfallsFile: pfile,
      vectorsDb: vdb,
      pitfallRows: pj.rows.length,
      vectorCount: vm.ok ? vm.count : 0,
      vectorDbError: vm.ok ? null : vm.reason,
    },
    params: { eps: Number(eps), minSize: Number(minSize), epsCandidates: EPS_CANDIDATES },
    stats: result.stats,
    clusters: result.clusters,
  };

  log.push(`[memv2] cluster ok clusters=${result.stats.clusters} merged=${result.stats.mergedClusters} singletons=${result.stats.singletons} maxSize=${result.stats.maxSize} degraded=${degraded}`);
  if (dryRun) {
    return { ok: true, status: 'dry-run', runId, log, written: false, doc };
  }
  const dw = writeStateText(CLUSTERS_FILE, JSON.stringify(doc, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return { ok: true, status: degraded ? 'ok-degraded' : 'ok', runId, log, written: true, outFile: out, doc };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const json = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const home = flags.home ? path.resolve(String(flags.home)) : (flags['dsh-home'] ? path.resolve(String(flags['dsh-home'])) : dshHome());
  const say = (s) => { if (json) process.stderr.write(s + '\n'); else process.stdout.write(s + '\n'); };

  const lock = acquireTickLock(LOCK_NAME, { home, ttlMs: 10 * 60_000 });
  if (!lock.ok) {
    const payload = { ok: true, status: 'locked', reason: `另一实例持锁（${lock.reason}）`, lockPath: lock.lockPath };
    if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else say(`跳过：另一实例持锁（${lock.reason}）`);
    process.exitCode = 0;
    return;
  }

  try {
    const r = runClusterTick({
      home,
      vectorsDb: flags['vectors-db'] ? path.resolve(String(flags['vectors-db'])) : null,
      pitfallsFile: flags['pitfalls-file'] ? path.resolve(String(flags['pitfalls-file'])) : null,
      outFile: flags['out'] ? path.resolve(String(flags['out'])) : null,
      eps: flags.eps ? Number(flags.eps) : 0.85,
      minSize: flags['min-size'] ? Number(flags['min-size']) : DEFAULT_MIN_SIZE,
      dryRun,
    });
    for (const l of r.log) say(l);
    if (json) {
      process.stdout.write(JSON.stringify({
        ok: r.ok, status: r.status, reason: r.reason ?? null, runId: r.runId, written: r.written,
        outFile: r.outFile ?? null, stats: r.doc?.stats ?? null,
      }, null, 2) + '\n');
    } else if (r.doc) {
      say(`聚类：${r.doc.stats.clusters} 族（合并 ${r.doc.stats.mergedClusters} / 单条 ${r.doc.stats.singletons}）`);
      for (const c of r.doc.clusters.slice(0, 12)) say(`  · ${c.theme}（${c.size} 条，代表 ${c.representativeId}，合计 count ${c.totalCount}）`);
      say(dryRun ? '（dry-run：未写文件）' : `已写：${r.outFile}`);
    }
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    lock.release();
  }
}

if (isMainEntry(import.meta.url)) await main();
