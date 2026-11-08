#!/usr/bin/env node
/**
 * _direct/unplace.mjs —— 回滚器在对端/本机的「删除腿」（**全项目唯一会删目标文件的脚本**）
 *
 * 只干一件事：把 `manifest` 里记的 **本次新建** 文件按 sha 校验后删掉。
 *
 * 拒动（任一命中即拒，绝不"尽量删"）：
 *   · 目标根不在 allowRoots 里 · 相对路径带盘符/绝对/`..`/空段 · 命中禁区名单
 *   · 路径段或文件本身是链接（reparse）
 *   · 目标不是普通文件（目录一律拒：**绝不递归删目录、空目录也不删**）
 *   · sha 与清单不符（说明这份文件已经不是"我们建的那份"了）
 *
 * ⚠️ 默认 dry-run；`job.apply === true` 才真删（主件里 `--apply` 是全局语义）。
 *
 * 输入 job：
 *   { mode:'unplace', runId, apply:bool, allowRoots:[…],
 *     items:[{ root, relPath, sha256 }], resultPath }
 */
import fs from 'node:fs';
import path from 'node:path';
import { safeResolve, reparseGuard, finish, readJob } from './common.mjs';
import { sha256FileAbs } from './packfile.mjs';

function main() {
  const job = readJob(process.argv);
  const apply = job.apply === true;
  const allowRoots = Array.isArray(job.allowRoots) ? job.allowRoots.map(String) : [];
  if (!allowRoots.length) throw new Error('job.allowRoots 为空（拒绝无作用域的删除）');

  const deleted = [];
  const refused = [];
  const missing = [];
  const errors = [];

  for (const it of Array.isArray(job.items) ? job.items : []) {
    const root = String(it.root ?? '');
    const relPath = String(it.relPath ?? '');
    try {
      if (!allowRoots.some((a) => path.resolve(a) === path.resolve(root))) throw new Error(`目标根不在 allowRoots 里（拒动）：${root}`);
      const abs = safeResolve(root, relPath, 'relPath');
      const bad = reparseGuard(root, abs);
      if (bad) throw new Error(bad);
      let st;
      try { st = fs.lstatSync(abs); } catch { missing.push({ root, relPath }); continue; }
      if (st.isSymbolicLink()) throw new Error('目标是链接（拒动）');
      if (!st.isFile()) throw new Error('目标不是普通文件（拒动；本脚本绝不递归删目录）');
      const cur = sha256FileAbs(abs);
      const want = it.sha256 ? String(it.sha256) : null;
      if (!want) throw new Error('清单里没有 sha256（第三态无法校验，拒动）');
      if (cur !== want) throw new Error(`sha 不符（清单 ${want.slice(0, 12)} / 现值 ${cur.slice(0, 12)}）⇒ 拒删`);
      if (!apply) { deleted.push({ root, relPath, sha256: cur, dryRun: true }); continue; }
      fs.unlinkSync(abs);
      deleted.push({ root, relPath, sha256: cur });
    } catch (e) {
      refused.push({ root, relPath, reason: String(e?.message ?? e) });
    }
  }

  return finish(job, {
    mode: 'unplace', ok: errors.length === 0, apply, runId: job.runId ?? null, allowRoots,
    deleted, refused, missing, errors,
    counts: { deleted: deleted.length, refused: refused.length, missing: missing.length, errors: errors.length },
    dryRunNote: apply ? undefined : '未传 apply ⇒ dry-run：只列清单、一个文件都没删',
    note: '只删清单里 sha 对得上的普通文件；不删目录、不递归、不删不在清单里的任何东西',
  });
}

try {
  process.exitCode = main();
} catch (e) {
  process.stderr.write(`unplace 失败：${e?.stack ?? e}\n`);
  try {
    const job = readJob(process.argv);
    if (job?.resultPath) fs.writeFileSync(job.resultPath, `${JSON.stringify({ ok: false, mode: 'unplace', error: String(e?.message ?? e) }, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
  process.exitCode = 1;
}
