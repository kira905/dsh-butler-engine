#!/usr/bin/env node
/**
 * _direct/common.mjs —— 对端三件（select / pack / place / unplace）共用的小块（随主件 scp 到对端）
 *
 * 只放**无副作用**的东西：遍历、名字过滤、路径闸门、结果落盘。
 * 规则本体（覆盖 / 第三态 / 作用域）留在各自脚本里，便于逐个审。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 我们自己的产物（备份件 / 冲突副本）—— **永不入清单**，否则会自己同步自己。 */
export const ARTIFACT_RE = /\.(?:bak-\d{12}|conflict-[^\\/]+-\d{12}(?:-[0-9a-f]{8})?)$/i;

/**
 * 永不入清单、永不落位的名字（凭据 / 热库 / 会话 / 看板 / 私钥）。
 * 判据按**路径段**，不是子串 —— 避免把 `keys.md` 这种正文文档误杀。
 */
const BLOCKED_SEGMENT_RE = /^(?:keys|sessions|task-board)$/i;
const BLOCKED_FILE_RE = /^(?:\.credentials.*|memory\.db(?:-wal|-shm)?|.*\.key|.*\.pem|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|id_ecdsa.*)$/i;

export function isBlockedRel(relPath) {
  const segs = String(relPath).replace(/\\/g, '/').split('/').filter(Boolean);
  for (const s of segs) {
    if (BLOCKED_SEGMENT_RE.test(s)) return true;
    if (BLOCKED_FILE_RE.test(s)) return true;
  }
  return false;
}

/** 遍历一个根，返回 Map<relPath(正斜杠), {size, mtimeMs}>（**只收普通文件**，链接/设备一律不碰）。 */
export function walkFiles(root, { skipDirs = [], artifacts = null } = {}) {
  const skip = new Set((skipDirs ?? []).map((s) => String(s)));
  const out = new Map();
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? path.join(root, rel) : root;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (skip.has(ent.name)) continue;
        stack.push(r);
        continue;
      }
      if (!ent.isFile()) continue;
      // 自己的产物：不入清单，但把**名字**交给调用方（冲突副本靠名字判"这轮还要不要再造一份"）
      if (ARTIFACT_RE.test(ent.name)) { if (Array.isArray(artifacts)) artifacts.push(r); continue; }
      if (isBlockedRel(r)) continue;
      let st;
      try { st = fs.statSync(path.join(root, r)); } catch { continue; }
      out.set(r, { size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** 扩展名是否在口径里（`allowNoExt` = presets 那种允许无扩展名小文件）。 */
export function inScopeExt(relPath, exts, allowNoExt) {
  const base = String(relPath).replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot <= 0 ? '' : base.slice(dot).toLowerCase();
  if (ext === '') return allowNoExt === true;
  return exts.includes(ext);
}

/**
 * 🔴 作用域闸门：把一个「根 + 相对路径」解析成绝对路径，并证明它**真在这个根里面**。
 * 拒动条件（任一命中即抛）：相对路径是绝对路径 / 带盘符 / 含 `..` / 含空段 / 名字被 BLOCKED 命中 /
 * 解析结果爬出根外。**只要有一处不确定就抛** —— 调用方按拒动处理。
 */
export function safeResolve(root, relPath, label = 'relPath') {
  const raw = String(relPath ?? '');
  if (!raw.trim()) throw new Error(`${label} 为空`);
  if (/^[A-Za-z]:/.test(raw)) throw new Error(`${label} 带盘符（拒动）：${raw}`);
  if (path.isAbsolute(raw)) throw new Error(`${label} 是绝对路径（拒动）：${raw}`);
  if (raw.includes('\u0000')) throw new Error(`${label} 含 NUL`);
  const segs = raw.replace(/\\/g, '/').split('/');
  for (const s of segs) {
    if (s === '' || s === '.' ) throw new Error(`${label} 含空段/当前目录段（拒动）：${raw}`);
    if (s === '..') throw new Error(`${label} 含 .. （拒动）：${raw}`);
  }
  if (isBlockedRel(raw)) throw new Error(`${label} 命中禁区名单（凭据/热库/会话/看板/私钥，拒动）：${raw}`);
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, ...segs);
  const rel = path.relative(rootAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${label} 解析后跑到根外（拒动）：${raw}`);
  return abs;
}

/**
 * reparse point（符号链接 / junction）闸门：从根往下逐段 lstat，**任一段是链接就拒动**。
 * 理由：链接会让我们写成"在根里的路径"实际落在根外（例如 `docs/` 下若挂了链接）。
 * @returns {string|null} null = 干净；字符串 = 拒动原因
 */
export function reparseGuard(root, absTarget) {
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, path.resolve(absTarget));
  if (!rel || rel.startsWith('..')) return `不在根内：${absTarget}`;
  const segs = rel.split(path.sep);
  let cur = rootAbs;
  // 根自己是不是链接也查一下（根下的 `docs/` 本身若是 junction ⇒ 写进去的落点不可信）
  try { if (fs.lstatSync(rootAbs).isSymbolicLink()) return `根本身是链接：${rootAbs}`; } catch { /* 根不存在不算错（place 会 mkdir） */ }
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { continue; }          // 不存在的段 ⇒ 后面 mkdir 会建，不拦
    if (st.isSymbolicLink()) return `路径段是链接（拒动）：${cur}`;
  }
  return null;
}

/** 结果 JSON 落盘（**只写调用方给的 resultPath**，即暂存目录内）。 */
export function writeResult(resultPath, obj) {
  if (!resultPath) throw new Error('job 缺少 resultPath');
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/** 读 job（唯一入参；**路径由主件写在 job 里，不进命令行**，躲开 cmd 引号与中文坑）。 */
export function readJob(argv) {
  const p = argv[2];
  if (!p) { process.stderr.write('用法: node <script> <job.json>\n'); process.exit(2); }
  const job = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!job || typeof job !== 'object') throw new Error(`job 不是对象：${p}`);
  job.__jobPath = p;
  return job;
}

/** 统一收尾：结果落盘 + 一行 stdout（对端 ssh 只回收这一行，便于日志取证）。 */
export function finish(job, result) {
  const r = { schemaVersion: 1, at: new Date().toISOString(), host: os.hostname(), ...result };
  writeResult(job.resultPath, r);
  process.stdout.write(`${result.mode ?? job.mode} ok=${r.ok === true} `
    + `${r.counts ? JSON.stringify(r.counts) : ''}\n`);
  return r.ok === false ? 1 : 0;
}
