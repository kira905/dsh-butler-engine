#!/usr/bin/env node
/**
 * _direct/place.mjs —— 「落位器」（**唯一会写目标目录的脚本**；对端 ssh 跑 / 本机夹具与回程也跑它）
 *
 * 规则（全部是"拒动优先"）：
 *   ① `job.apply !== true` ⇒ **dry-run**：只出计划，零写入（函数内第一道门）。
 *   ② 作用域锁死：目标根必须**逐字等于** `job.allowRoots[]` 里的一项；
 *      相对路径带盘符 / 绝对路径 / `..` / 空段 / 命中禁区名单 ⇒ 拒动。
 *   ③ reparse 闸门：从根往下任一段是链接 ⇒ 拒动（防"根里的路径"落到根外）。
 *   ④ 第三态拒动：`update` 的现值 sha 既不是清单里的 `expectOldSha`、也不已经等于新 sha ⇒ 拒动并留痕。
 *   ⑤ 覆盖前把旧件另存 `<原名>.bak-<stamp>`，**只留最近 1 份**（更老的同名备份同批清掉）；
 *      冲突副本写成 `<原名>.conflict-<发起方 host>-<stamp>`（**绝不覆盖对端原件**）。
 *   ⑥ 落位后把 mtime 回写成"源 mtime" ⇒ 下一轮 `size+mtime` 快路径直接判"没变"，不烧 sha。
 *   ⑦ 🔴 **绝不删除目标文件**（唯一的删除动作是 ⑤ 里清自己更老的 `.bak-*`）；
 *      绝不递归删目录、绝不删空目录。
 *
 * 输入 job：
 *   { mode:'place', runId, apply, stamp, allowRoots:[…],
 *     items:[{ specKey, root, packPath, entries:[{ relPath, action, targetRel?, expectOldSha?, sha256? }] }],
 *     resultPath }
 *   action = 'create'（对端没有 → 新建） | 'update'（本机较新 → 覆盖，先备份） | 'conflictCopy'（同名双写 → 只落副本）
 */
import fs from 'node:fs';
import path from 'node:path';
import { safeResolve, reparseGuard, isBlockedRel, finish, readJob } from './common.mjs';
import { loadPack, entryBuffer, sha256Buf } from './packfile.mjs';

const BAK_RE = /^(.*)\.bak-(\d{12})$/;

function shaOfFile(p) {
  try { return sha256Buf(fs.readFileSync(p)); } catch { return null; }
}

function sameRoot(root, allowRoots) {
  const r = path.resolve(String(root ?? ''));
  for (const a of allowRoots ?? []) {
    if (path.resolve(String(a)) === r) return true;
  }
  return false;
}

function pruneOlderBaks(dir, base, keepName) {
  const removed = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return removed; }
  for (const n of names) {
    const m = BAK_RE.exec(n);
    if (!m || m[1] !== base || n === keepName) continue;
    if (!/^\d{12}$/.test(m[2])) continue;
    const p = path.join(dir, n);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      fs.unlinkSync(p);
      removed.push(n);
    } catch { /* 删不掉就算了，不递归、不重试 */ }
  }
  return removed;
}

function main() {
  const job = readJob(process.argv);
  const apply = job.apply === true;
  const stamp = String(job.stamp ?? '');
  if (!/^\d{12}$/.test(stamp)) throw new Error(`stamp 不合法（要 yyyymmddHHMM）：${stamp}`);
  const allowRoots = Array.isArray(job.allowRoots) ? job.allowRoots.map(String) : [];
  if (!allowRoots.length) throw new Error('job.allowRoots 为空（拒绝无作用域的落位）');
  const originHost = String(job.originHost ?? job.host ?? 'peer');

  const placed = [];
  const backups = [];
  const refused = [];
  const skipped = [];
  const conflicts = [];
  const errors = [];

  for (const item of Array.isArray(job.items) ? job.items : []) {
    const specKey = String(item.specKey ?? '');
    const root = String(item.root ?? '');
    if (!sameRoot(root, allowRoots)) { refused.push({ specKey, relPath: '-', reason: `目标根不在 allowRoots 里（拒动）：${root}` }); continue; }
    let pack;
    try { pack = loadPack(String(item.packPath)); }
    catch (e) { errors.push({ specKey, packPath: item.packPath, err: String(e?.message ?? e) }); continue; }

    for (const ent of Array.isArray(item.entries) ? item.entries : []) {
      const relPath = String(ent.relPath ?? '');
      const action = String(ent.action ?? '');
      try {
        if (!['create', 'update', 'conflictCopy'].includes(action)) throw new Error(`未知 action：${action}`);
        const head = (pack.header.entries ?? []).find((h) => h.relPath === relPath);
        if (!head) throw new Error('批次包里没有这个 relPath');
        const buf = entryBuffer(pack, head);
        const bufSha = sha256Buf(buf);
        if (head.sha256 && bufSha !== head.sha256) throw new Error(`批次包条目 sha 不符（包内 ${head.sha256} / 实算 ${bufSha}）`);

        let targetRel = relPath;
        // 冲突副本名 = <原名>.conflict-<发起方host>-<stamp>-<内容sha前8>：名字里带内容指纹，
        // 下一轮"这份内容的副本是不是已经造过了"就能只看名字判断（幂等靠它）。
        if (action === 'conflictCopy') targetRel = `${relPath}.conflict-${originHost}-${stamp}-${bufSha.slice(0, 8)}`;
        if (ent.targetRel) targetRel = String(ent.targetRel);
        if (isBlockedRel(targetRel)) throw new Error('目标路径命中禁区名单（拒动）');

        // 冲突副本：先探重名（同名副本已存在就加 -2/-3…，绝不覆盖任何既有文件）
        if (action === 'conflictCopy') {
          const baseRel = targetRel;
          let n = 1;
          let candRel = baseRel;
          while (n < 50) {
            let exists = false;
            try { exists = fs.existsSync(safeResolve(root, candRel, 'targetRel')); } catch { exists = false; }
            if (!exists) break;
            n += 1;
            candRel = `${baseRel}-${n}`;
          }
          targetRel = candRel;
        }

        const abs = safeResolve(root, targetRel, 'targetRel');
        const bad = reparseGuard(root, abs);
        if (bad) throw new Error(bad);

        const curSha = fs.existsSync(abs) ? shaOfFile(abs) : null;
        const curIsFile = curSha !== null;

        if (action === 'create') {
          if (curIsFile && curSha === bufSha) { skipped.push({ specKey, relPath: targetRel, reason: 'already-same' }); continue; }
          if (curIsFile) { refused.push({ specKey, relPath: targetRel, reason: '目标已存在且内容不同（挑选后被改过？拒动）' }); continue; }
        } else if (action === 'update') {
          if (!curIsFile) { refused.push({ specKey, relPath: targetRel, reason: '要更新的旧件已不存在（拒动）' }); continue; }
          if (curSha === bufSha) { skipped.push({ specKey, relPath: targetRel, reason: 'already-same' }); continue; }
          const expect = ent.expectOldSha ? String(ent.expectOldSha) : null;
          if (!expect) { refused.push({ specKey, relPath: targetRel, reason: '缺少 expectOldSha，第三态无法校验（拒动）' }); continue; }
          if (curSha !== expect) { refused.push({ specKey, relPath: targetRel, reason: `第三态拒动：现值 ${curSha.slice(0, 12)} 既不是旧 sha ${expect.slice(0, 12)} 也不等于新 sha` }); continue; }
        } else if (action === 'conflictCopy') {
          // 幂等守卫：同目录里已经存在**同内容**的冲突副本 ⇒ 不再造第二份（否则每轮都多一份，幂等就废了）
          const origAbs = safeResolve(root, relPath, 'relPath');
          const dirAbs = path.dirname(origAbs);
          const baseName = path.basename(origAbs);
          let already = null;
          let names = [];
          try { names = fs.readdirSync(dirAbs); } catch { /* 目录还不存在 */ }
          for (const n of names) {
            if (!n.startsWith(`${baseName}.conflict-`)) continue;
            const p = path.join(dirAbs, n);
            try { const st = fs.lstatSync(p); if (!st.isFile() || st.isSymbolicLink()) continue; } catch { continue; }
            if (shaOfFile(p) === bufSha) { already = n; break; }
          }
          if (already) { skipped.push({ specKey, relPath: already, reason: 'conflict-copy-already' }); continue; }
        }

        if (!apply) {
          placed.push({ specKey, relPath: targetRel, action, sha256: bufSha, bytes: buf.length, dryRun: true });
          continue;
        }

        const dir = path.dirname(abs);
        fs.mkdirSync(dir, { recursive: true });

        if (action === 'update' && curIsFile) {
          const base = path.basename(abs);
          const bakName = `${base}.bak-${stamp}`;
          const bakAbs = path.join(dir, bakName);
          fs.copyFileSync(abs, bakAbs);
          backups.push({ specKey, relPath: path.relative(path.resolve(root), bakAbs).replace(/\\/g, '/'), of: targetRel });
          const pruned = pruneOlderBaks(dir, base, bakName);
          if (pruned.length) backups.push({ specKey, pruned: pruned.length, of: targetRel });
        }

        fs.writeFileSync(abs, buf);
        const written = shaOfFile(abs);
        if (written !== bufSha) throw new Error(`写后 sha 不符（写 ${bufSha} / 读 ${written}）`);
        const mt = Number(head.mtimeMs);
        if (Number.isFinite(mt) && mt > 0) {
          try { fs.utimesSync(abs, new Date(), new Date(mt)); } catch { /* 设不上不算失败 */ }
        }
        const rec = { specKey, relPath: targetRel, action, sha256: bufSha, bytes: buf.length };
        if (action === 'conflictCopy') conflicts.push(rec);
        placed.push(rec);
      } catch (e) {
        refused.push({ specKey, relPath, reason: String(e?.message ?? e) });
      }
    }
  }

  const created = placed.filter((p) => p.action === 'create' && !p.dryRun);
  return finish(job, {
    mode: 'place', ok: errors.length === 0, apply, runId: job.runId ?? null, stamp, originHost, allowRoots,
    placed, created, backups, refused, skipped, conflicts, errors,
    counts: {
      placed: placed.length, created: created.length,
      updated: placed.filter((p) => p.action === 'update').length,
      conflictCopies: conflicts.length, backups: backups.length,
      refused: refused.length, skipped: skipped.length, errors: errors.length,
    },
    dryRunNote: apply ? undefined : '未传 apply ⇒ dry-run：只出计划、零写入',
    note: '本脚本只写目标根内的文件；不删目标文件（只清自己更老的 .bak-*）',
  });
}

try {
  process.exitCode = main();
} catch (e) {
  process.stderr.write(`place 失败：${e?.stack ?? e}\n`);
  try {
    const job = readJob(process.argv);
    if (job?.resultPath) fs.writeFileSync(job.resultPath, `${JSON.stringify({ ok: false, mode: 'place', error: String(e?.message ?? e) }, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
  process.exitCode = 1;
}
