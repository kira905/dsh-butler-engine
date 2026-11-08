#!/usr/bin/env node
/**
 * _direct/select.mjs —— 阶段 B「只读挑选器」（随主件 scp 到对端跑；本机夹具模式也跑它）
 *
 * 🔴 本脚本**永不写目标目录**：它只读两边的 stat、必要时算 sha，
 *    唯一写的东西是「结果 JSON」（`job.resultPath`，在暂存目录里）。
 *
 * 输入（job.json，由主件生成）：
 *   { mode:'select', runId, apply:false,
 *     sameMtimeToleranceMs: 2000, maxSha: 8000,
 *     specs:[ { key, root, skipDirs:[], exts:[], allowNoExt:bool,
 *               local:{ entries:[{relPath,size,mtimeMs}], files, bytes } } ],
 *     resultPath }
 *
 * 输出：
 *   { ok, host, at, runId, specs:[ { key, root,
 *       peer:{ files, bytes, inScopeFiles },
 *       groups:{
 *         new:[relPath…],                                        // 对端没有
 *         same:{ count, bytes },                                 // size+mtime 快路径判"没变"
 *         differ:[{relPath,peerSize,peerMtimeMs,localSize,localMtimeMs,peerSha}], // 同名但不像同一份
 *         peerOnly:[{relPath,size,mtimeMs,sha256}]               // 对端有、本机没有（且在本口径内）
 *       } } ],
 *     errors:[] }
 *
 * `peerSha` 只在「已经不像同一份」的条目上算（本地侧同理只对这些条目算），
 * 这就是「sha 只对可能要被传的算」的落点 —— 稳态下 differ 接近 0，两端都不烧 IO。
 */
import fs from 'node:fs';
import path from 'node:path';
import { walkFiles, inScopeExt, finish, readJob } from './common.mjs';
import { sha256FileAbs } from './packfile.mjs';

function main() {
  const job = readJob(process.argv);
  const sameTol = Number(job.sameMtimeToleranceMs ?? 2000);
  const maxSha = Number(job.maxSha ?? 8000);
  const errors = [];
  let shaBudget = maxSha;
  let shaSkipped = 0;

  const maybeSha = (abs) => {
    if (shaBudget <= 0) { shaSkipped++; return null; }
    shaBudget--;
    try { return sha256FileAbs(abs); } catch (e) { errors.push({ at: abs, err: String(e?.message ?? e) }); return null; }
  };

  const specs = [];
  const artifactsSink = [];
  for (const spec of Array.isArray(job.specs) ? job.specs : []) {
    const root = String(spec.root);
    const exts = (spec.exts ?? []).map((e) => String(e).toLowerCase());
    const allowNoExt = spec.allowNoExt === true;
    const peerMap = walkFiles(root, { skipDirs: spec.skipDirs ?? [], artifacts: artifactsSink });
    const localEntries = Array.isArray(spec?.local?.entries) ? spec.local.entries : [];
    const localMap = new Map(localEntries.map((e) => [String(e.relPath), e]));

    const groups = { new: [], same: { count: 0, bytes: 0 }, differ: [], peerOnly: [], artifacts: artifactsSink.slice(0, 20000) };
    artifactsSink.length = 0;
    let peerBytes = 0;
    let peerInScope = 0;
    for (const [rel, st] of peerMap) {
      peerBytes += st.size;
      if (inScopeExt(rel, exts, allowNoExt)) peerInScope++;
    }

    for (const [rel, le] of localMap) {
      const p = peerMap.get(rel);
      if (!p) { groups.new.push(rel); continue; }
      const sameSize = p.size === Number(le.size);
      const closeMtime = Math.abs(Number(p.mtimeMs) - Number(le.mtimeMs)) < sameTol;
      if (sameSize && closeMtime) { groups.same.count++; groups.same.bytes += Number(le.size) || 0; continue; }
      groups.differ.push({
        relPath: rel,
        peerSize: p.size,
        peerMtimeMs: Math.round(Number(p.mtimeMs)),
        localSize: Number(le.size) || 0,
        localMtimeMs: Math.round(Number(le.mtimeMs) || 0),
        peerSha: maybeSha(path.join(root, rel)),
      });
    }

    for (const [rel, p] of peerMap) {
      if (localMap.has(rel)) continue;
      if (!inScopeExt(rel, exts, allowNoExt)) continue;
      groups.peerOnly.push({
        relPath: rel, size: p.size, mtimeMs: Math.round(Number(p.mtimeMs)),
        sha256: maybeSha(path.join(root, rel)),
      });
    }

    specs.push({
      key: String(spec.key), root,
      peer: { files: peerMap.size, bytes: peerBytes, inScopeFiles: peerInScope },
      local: { files: localMap.size, bytes: Number(spec?.local?.bytes) || 0 },
      groups,
    });
  }

  const counts = {
    new: specs.reduce((a, s) => a + s.groups.new.length, 0),
    differ: specs.reduce((a, s) => a + s.groups.differ.length, 0),
    peerOnly: specs.reduce((a, s) => a + s.groups.peerOnly.length, 0),
    same: specs.reduce((a, s) => a + s.groups.same.count, 0),
    peerFiles: specs.reduce((a, s) => a + s.peer.files, 0),
  };

  return finish(job, {
    mode: 'select', ok: errors.length === 0, runId: job.runId ?? null,
    sameMtimeToleranceMs: sameTol, shaBudgetLeft: shaBudget, shaSkipped, errors, specs, counts,
    readOnly: true,
    note: '只读挑选器：不写任何目标文件；仅把结果 JSON 写进暂存目录（job.resultPath）',
  });
}

try {
  process.exitCode = main();
} catch (e) {
  process.stderr.write(`select 失败：${e?.stack ?? e}\n`);
  try {
    const job = readJob(process.argv);
    if (job?.resultPath) fs.writeFileSync(job.resultPath, `${JSON.stringify({ ok: false, mode: 'select', error: String(e?.message ?? e) }, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
  process.exitCode = 1;
}
