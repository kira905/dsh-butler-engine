// dsh-butler / lib/session-header.mjs —— 会话身份判定（P5 force 权限用）
//
// 方案 §4 P5 逃生舱：「仅主会话 / 面板可 force，subagent 一律拒」→ 必须能判定会话身份。
// 判据（主包 @deepseek-ai/dsh-subagent 实证）：
//   会话首帧 header 携带 origin（'subagent' | ...）与 parentSession（子会话有值）。
//   目录结构 <home>/sessions/<workspace>/<sessionId>/<会话日志>，首帧 = header。
//   ⚠️ 会话日志名**世代化**（0.1.5 起 `session.jsonl.zstd` → `session.v3.jsonl.zstd`）⇒
//     文件定位一律走判据真源 `tools\lib\session-file-name.mjs#pickSessionFileInDir()`
//     （认全世代 + 取"当前那份"），**禁在本文件写死文件名**（卡「修·V3判据③」2026-09-24）。
//
// 只读、失败即 fail-closed（调用方把 undefined 当"无法判定"→ 拒绝 force）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { pickSessionFileInDir } from '../../src/lib/session-file-name.mjs';

/** 在 sessions 下按 sessionId 找会话文件（两层：workspace/sessionId）。 */
export function findSessionFile(sessionId, home = dshHome()) {
  const id = String(sessionId ?? '').trim();
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) return null;
  const root = path.join(home, 'sessions');
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    const file = pickSessionFileInDir(path.join(root, ws, id));
    if (file) return file;
  }
  return null;
}

/** 读会话首帧 header（zstd 首帧即 header；解失败返回 null）。 */
export function readSessionHeader(sessionId, home = dshHome()) {
  const file = findSessionFile(sessionId, home);
  if (!file) return null;
  try {
    const buf = fs.readFileSync(file);
    const text = zlib.zstdDecompressSync(buf).toString('utf8');
    const firstLine = text.split('\n').find((l) => l.trim());
    if (!firstLine) return null;
    const rec = JSON.parse(firstLine);
    // 首帧可能是 header 记录本体，也可能包在 {type:'header', data:{...}} 里
    const h = rec?.data && typeof rec.data === 'object' && (rec.data.id || rec.data.origin) ? rec.data : rec;
    return { file, header: h, raw: rec };
  } catch {
    return null;
  }
}

/**
 * 判定 actor 身份（force 权限用）。
 * @returns {{sessionId:string, known:boolean, origin:string|null, parentSession:string|null, isSubagent:boolean}}
 */
export function classifyActor(sessionId, home = dshHome()) {
  const id = String(sessionId ?? '').trim();
  const h = id ? readSessionHeader(id, home) : null;
  const header = h?.header ?? null;
  const origin = typeof header?.origin === 'string' ? header.origin : null;
  const parentSession = typeof header?.parentSession === 'string' && header.parentSession ? header.parentSession : null;
  return {
    sessionId: id || null,
    known: Boolean(header),
    origin,
    parentSession,
    isSubagent: origin === 'subagent' || Boolean(parentSession),
  };
}
