#!/usr/bin/env node
/**
 * _direct/pack.mjs —— 回程（from-peer）用的「打包器」（对端侧）
 *
 * 🔴 它**只写暂存目录**（`job.packsDir`，主件会断言它在本次 runId 的暂存根里），
 *    绝不写任何目标目录 —— 目标目录的唯一写入口是 `place.mjs`。
 *
 * 输入 job：
 *   { mode:'pack', runId, apply:true, stamp, packsDir, maxBatchBytes,
 *     wanted:[{ specKey, root, relPath }], resultPath }
 * 输出：
 *   { ok, packs:[{ file, bytes, specKey, entries:[{relPath,size,mtimeMs,sha256}] }],
 *     counts:{packs,files,bytes}, errors:[] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { safeResolve, reparseGuard, finish, readJob } from './common.mjs';
import { writePack } from './packfile.mjs';

function main() {
  const job = readJob(process.argv);
  const apply = job.apply === true;
  const packsDir = String(job.packsDir ?? '');
  if (!packsDir) throw new Error('job 缺少 packsDir');
  const stagingRoot = String(job.stagingRoot ?? '');
  const absPacks = path.resolve(packsDir);
  // 暂存根断言：packsDir 必须在本次 runId 的暂存根下（否则打包器就成了"到处能写"的工具）
  if (stagingRoot) {
    const rel = path.relative(path.resolve(stagingRoot), absPacks);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`packsDir 跑到暂存根外（拒动）：${packsDir}`);
  }
  const maxBatch = Math.max(64 * 1024, Number(job.maxBatchBytes ?? 32 * 1024 * 1024));
  const wanted = Array.isArray(job.wanted) ? job.wanted : [];

  const errors = [];
  const bySpec = new Map();
  for (const w of wanted) {
    const key = String(w.specKey);
    if (!bySpec.has(key)) bySpec.set(key, []);
    bySpec.get(key).push(w);
  }

  const packs = [];
  for (const [specKey, list] of bySpec) {
    let batch = [];
    let batchBytes = 0;
    const flush = () => {
      if (!batch.length) return;
      const idx = String(packs.length + 1).padStart(4, '0');
      const file = path.join(absPacks, `${String(job.stamp ?? 'x')}-${specKey}-${idx}.pk`);
      if (apply) {
        const w = writePack(file, { specKey, stamp: job.stamp ?? null, files: batch });
        packs.push({ file, bytes: w.bytes, specKey, entries: w.header.entries.map((e) => ({ relPath: e.relPath, size: e.size, mtimeMs: e.mtimeMs, sha256: e.sha256 })) });
      } else {
        packs.push({ file, bytes: batchBytes, specKey, entries: batch.map((b) => ({ relPath: b.relPath, size: b.bytes, mtimeMs: b.mtimeMs, sha256: null })), dryRun: true });
      }
      batch = [];
      batchBytes = 0;
    };
    for (const w of list) {
      let abs;
      try {
        abs = safeResolve(w.root, w.relPath, 'relPath');
        const bad = reparseGuard(w.root, abs);
        if (bad) throw new Error(bad);
        const st = fs.statSync(abs);
        if (!st.isFile()) throw new Error('不是普通文件');
        if (batch.length && batchBytes + st.size > maxBatch) flush();
        batch.push({ relPath: w.relPath, absPath: abs, mtimeMs: st.mtimeMs, bytes: st.size });
        batchBytes += st.size;
      } catch (e) {
        errors.push({ specKey, relPath: w.relPath, err: String(e?.message ?? e) });
      }
    }
    flush();
  }

  return finish(job, {
    mode: 'pack', ok: errors.length === 0, apply, runId: job.runId ?? null, stagingRoot: stagingRoot || null,
    packs,
    counts: {
      packs: packs.length,
      files: packs.reduce((a, p) => a + p.entries.length, 0),
      bytes: packs.reduce((a, p) => a + p.bytes, 0),
      errors: errors.length,
    },
    errors,
    dryRunNote: apply ? undefined : '未传 --apply ⇒ 只算不写（打包器默认 dry-run）',
  });
}

try {
  process.exitCode = main();
} catch (e) {
  process.stderr.write(`pack 失败：${e?.stack ?? e}\n`);
  try {
    const job = readJob(process.argv);
    if (job?.resultPath) fs.writeFileSync(job.resultPath, `${JSON.stringify({ ok: false, mode: 'pack', error: String(e?.message ?? e) }, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
  process.exitCode = 1;
}
