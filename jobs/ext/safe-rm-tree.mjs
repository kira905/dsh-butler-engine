#!/usr/bin/env node
// tools / safe-rm-tree.mjs —— 安全删除件（递归删目录 / 文件），**默认 dry-run**
//
// 为什么要有它：2026-10-19 23:48 的事故里，`Remove-Item -Recurse` / `/MIR` 这类"一把梭"删除
//   跟着 junction 把目标内容一起删掉，4,000+ 件不可恢复。本件是唯一被允许的递归删除入口。
//
// 三条硬约束（任一不满足即**拒动**，不是警告）：
//   ① 目标必须落在**允许根**之下（逻辑路径或 realpath 任一命中即可 —— junction 下 realpath 会解析到
//      物理盘那一侧，只按 realpath 判会把 `<workspace>\_archive\...` 误判成越界，见 persona junction 坑）；
//   ② 树里遇到 **junction / 符号链接** 一律拒删（`--allow-reparse` 才允许，且只删链接本身、绝不跟随）；
//   ③ 默认 dry-run：只列出"将删 N 件 / X 字节"，必须显式 `--apply` 才真动手。
//
// 删除顺序：自底向上（先 unlink 文件/链接，再 rmdir 空目录），单件失败不中断其余、最后汇总 rc。
//
// 用法：
//   node safe-rm-tree.mjs --path <目标> [--path <目标> ...] [--root <允许根> ...]
//     [--apply] [--dry-run] [--json] [--allow-reparse] [--reason "<为什么要删>"]
//   缺省允许根 = `<workspace>` 与 `<tmp>`；给了 `--root` 就**替换**默认值（不给则用默认）。
// 退出码：0 成功（含 dry-run 规划完成）/ 1 删除执行出错 / 2 用法或安全校验拒动。
// **收尾一律 process.exitCode**（house rule：禁 process.exit）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAFE_RM_VERSION = '0.1.0';
export const SAFE_RM_SCHEMA = 1;

export const DEFAULT_ROOTS = Object.freeze([process.env.DSH_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME || '.', 'dsh-workspace'), os.tmpdir()]);

const USAGE = [
  'safe-rm-tree —— 安全删除件（递归；默认 dry-run；拒 junction；必须在允许根下）',
  '  node safe-rm-tree.mjs --path <目标> [--path <目标> ...] [--root <允许根> ...]',
  '    [--apply] [--dry-run] [--json] [--allow-reparse] [--reason "<原因>"]',
  '  缺省允许根 = <workspace> 与 <tmp>；--root 出现时替换默认值。',
].join('\n');

function realOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function cmpLower(a, b) {
  return String(a).replace(/[\\/]+$/, '').toLowerCase();
}

/** 逻辑路径判据（不解析链接）。 */
export function underLogical(target, root) {
  const a = cmpLower(target);
  const b = cmpLower(root);
  return a === b || a.startsWith(b + path.sep);
}

/** 物理路径判据（realpath 后）。junction 下与逻辑判据可能不一致，故两者都试。 */
export function underReal(target, root) {
  const a = cmpLower(realOr(target));
  const b = cmpLower(realOr(root));
  return a === b || a.startsWith(b + path.sep);
}

function lstatSafe(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

/**
 * 规划一次删除（只读）。
 * @returns {{ok:boolean, code?:number, error?:string, target?:string, files?:Array, dirs?:Array,
 *            symlinks?:Array, bytes?:number, roots?:Array}}
 */
export function planRemove(target, opts = {}) {
  const roots = (Array.isArray(opts.roots) && opts.roots.length ? opts.roots : DEFAULT_ROOTS).map((r) => path.resolve(r));
  const allowReparse = opts.allowReparse === true;
  const abs = path.resolve(target);
  const st = lstatSafe(abs);
  if (!st) return { ok: false, code: 2, error: `目标不存在：${abs}`, target: abs };

  const inRoot = roots.some((r) => underLogical(abs, r) || underReal(abs, r));
  if (!inRoot) {
    return { ok: false, code: 2, error: `拒动：目标不在允许根之下（${abs}）；允许根 = ${roots.join(' / ')}`, target: abs };
  }

  const files = [];
  const dirs = [];
  const symlinks = [];
  const errors = [];
  let bytes = 0;

  const visit = (p) => {
    const s = lstatSafe(p);
    if (!s) { errors.push({ path: p, error: 'lstat 失败（并发删除？）' }); return; }
    if (s.isSymbolicLink()) {
      symlinks.push(p);
      if (allowReparse) return;              // 只删链接本身，不进目录
      return;                                // 由下面的拒动判定统一处理
    }
    if (s.isDirectory()) {
      let ents = [];
      try { ents = fs.readdirSync(p); } catch (e) { errors.push({ path: p, error: `readdir 失败：${e?.message ?? e}` }); return; }
      for (const name of ents) visit(path.join(p, name));
      dirs.push(p);
      return;
    }
    files.push(p);
    bytes += Number(s.size ?? 0);
  };
  visit(abs);

  if (symlinks.length && !allowReparse) {
    return {
      ok: false, code: 2, target: abs,
      error: `拒动：树里含 ${symlinks.length} 个 junction/符号链接（跟随删除会连目标一起删）。`
        + `确认只删链接本身再传 --allow-reparse。首个：${symlinks[0]}`,
      symlinks,
    };
  }

  return {
    ok: true, code: 0, target: abs, roots, allowReparse,
    files, dirs, symlinks, bytes,
    errors: errors.length ? errors : undefined,
  };
}

/** 执行删除（自底向上；单件失败不中断）。 */
export function applyRemove(plan, opts = {}) {
  const dryRun = opts.dryRun !== false;      // 缺省 dry-run（fail-safe）
  const out = { applied: !dryRun, removedFiles: 0, removedLinks: 0, removedDirs: 0, errors: [] };
  if (!plan?.ok) { out.errors.push({ path: plan?.target ?? '?', error: plan?.error ?? '规划未通过' }); return out; }
  if (dryRun) return out;

  for (const p of plan.files) {
    try { fs.unlinkSync(p); out.removedFiles++; } catch (e) { out.errors.push({ path: p, error: String(e?.message ?? e) }); }
  }
  for (const p of plan.symlinks) {
    try { fs.unlinkSync(p); out.removedLinks++; } catch (e) { out.errors.push({ path: p, error: String(e?.message ?? e) }); }
  }
  for (const p of plan.dirs) {
    try { fs.rmdirSync(p); out.removedDirs++; } catch (e) { out.errors.push({ path: p, error: String(e?.message ?? e) }); }
  }
  return out;
}

/** 便捷入口：规划 + （可选）执行。 */
export function safeRemoveTree(target, opts = {}) {
  const plan = planRemove(target, opts);
  if (!plan.ok) return { plan, result: null, ok: false };
  const result = applyRemove(plan, { dryRun: opts.dryRun !== false });
  return { plan, result, ok: true, remaining: fs.existsSync(plan.target) };
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

function isMainEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

function main() {
  const argv = process.argv.slice(2);
  const opt = { paths: [], roots: [], apply: false, json: false, allowReparse: false, reason: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') opt.paths.push(argv[++i]);
    else if (a === '--root') opt.roots.push(argv[++i]);
    else if (a === '--apply') opt.apply = true;
    else if (a === '--dry-run') opt.apply = false;
    else if (a === '--json') opt.json = true;
    else if (a === '--allow-reparse') opt.allowReparse = true;
    else if (a === '--reason') opt.reason = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
    else { console.error(`未知参数：${a}`); console.error(USAGE); return 2; }
  }
  if (!opt.paths.length) { console.error('缺少 --path'); console.error(USAGE); return 2; }
  if (opt.paths.some((p) => !p)) { console.error('--path 值不能为空'); return 2; }

  const dryRun = opt.apply !== true;
  const results = [];
  let rc = 0;
  for (const p of opt.paths) {
    const plan = planRemove(p, { roots: opt.roots, allowReparse: opt.allowReparse });
    if (!plan.ok) {
      results.push({ path: path.resolve(p), ok: false, error: plan.error, code: plan.code });
      rc = Math.max(rc, plan.code === 2 ? 2 : 1);
      continue;
    }
    const result = applyRemove(plan, { dryRun });
    const remaining = fs.existsSync(plan.target);
    results.push({
      path: plan.target, ok: result.errors.length === 0, dryRun,
      files: plan.files.length, dirs: plan.dirs.length, symlinks: plan.symlinks.length,
      bytes: plan.bytes, removed: result, remaining, reason: opt.reason,
    });
    if (result.errors.length) rc = 1;
  }

  if (opt.json) process.stdout.write(JSON.stringify({ schemaVersion: SAFE_RM_SCHEMA, version: SAFE_RM_VERSION, dryRun, results }, null, 2) + '\n');
  else {
    for (const r of results) {
      if (r.ok === false && r.error) { console.error(`[safe-rm-tree] ❌ ${r.path}\n  ${r.error}`); continue; }
      console.log(`[safe-rm-tree] ${r.dryRun ? 'dry-run（未删）' : '已删除'} ${r.path}`);
      console.log(`  文件 ${r.files} · 目录 ${r.dirs} · 链接 ${r.symlinks} · ${fmtBytes(r.bytes)}`
        + (r.reason ? ` · 原因：${r.reason}` : ''));
      if (!r.dryRun) console.log(`  实删：文件 ${r.removed.removedFiles} / 链接 ${r.removed.removedLinks} / 目录 ${r.removed.removedDirs}`
        + ` · 目标仍在=${r.remaining}`);
      if (r.removed?.errors?.length) for (const e of r.removed.errors.slice(0, 10)) console.error(`  ! ${e.path}：${e.error}`);
    }
  }
  return rc;
}

if (isMainEntry()) {
  try { process.exitCode = main(); } catch (e) {
    console.error(`safe-rm-tree 失败：${e?.stack ?? e?.message ?? e}`);
    process.exitCode = 1;
  }
}
