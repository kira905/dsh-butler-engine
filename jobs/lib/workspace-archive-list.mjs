/**
 * workspace-archive-list.mjs —— **只读**取「官方归档名单」（`workspace.json#global.archivedSessionIds`）
 *
 * 唯一源（2026-11-01 · 卡「会话标题与归档第一层」a/b 共用）：
 *   ① `tools\archive-session.mjs` —— 归档前判「是不是已经在名单里」（幂等 ⇒ rc 4，不重复打标记）
 *   ② `tools\dsh-butler\session-say.mjs` —— 投递闸：目标在名单里 ⇒ 拒投（rc 5）
 *
 * 🔴 红线：**一个字节都不写**。名单的写口只有主包自己的 `workspaceRegistry.setState()`
 *   （RPC `workspace/archiveSession` / `unarchiveSession`）⇒ 本件只 `readFileSync` + `JSON.parse`。
 *   本件也**不缓存**：调用方每次现读（一轮 tick / 一次投递只读一次，成本 = 一个 ≤20 KB 的 JSON）。
 *
 * 名单里的元素形态：主包存的是**裸 id 或 `session-<uuid>`**（两种都见过）⇒ 判据一律走
 * `sidKey()`（去 `session-` 前缀 + 小写 + trim），别拿原串直接比。
 *
 * `~` 目录口径：调用方自己解析（`tools\lib\dsh-home.mjs#resolveDshHome()`），本件只收显式 home。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 会话 id 的比较键：去 `session-` 前缀、trim、转小写（**唯一**比较口径） */
export function sidKey(v) {
  return String(v ?? '').trim().toLowerCase().replace(/^session-/, '');
}

/** 名单文件路径（`<home>\storages\workspace.json`） */
export function archiveListFile(home) {
  return path.join(String(home ?? ''), 'storages', 'workspace.json');
}

/**
 * 读归档名单（**只读、不抛**）。
 *
 * @param {string} home DSH home（`resolveDshHome()` 的结果）
 * @returns {{ok:boolean, ids:Set<string>, raw:string[], file:string, reason:string|null, count:number}}
 *   `ok:false` ⇒ 读不到 / 解析失败 / 形状不认识；`reason` 是给人看的一句话（调用方**必须**打印，不许静默放行）。
 *   `ids` = `sidKey()` 归一后的集合（`ok:false` 时为空集合，调用方据 `ok` 判「本次没做归档闸」）。
 */
export function readArchivedSessionIds(home) {
  const file = archiveListFile(home);
  const out = { ok: false, ids: new Set(), raw: [], file, reason: null, count: 0 };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    out.reason = `读不到 ${file}（${e?.code ?? e?.message ?? e}）`;
    return out;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    out.reason = `解析 ${file} 失败（${e?.message ?? e}）`;
    return out;
  }
  const arr = doc?.global?.archivedSessionIds;
  if (!Array.isArray(arr)) {
    // 形状不认识 ≠ 名单为空：宁可报「读不到」（调用方据此提示"本次未做归档闸"），也不假装"没有归档的"
    out.reason = `${file} 里没有 global.archivedSessionIds 数组（形状不认识）`;
    return out;
  }
  out.raw = arr.filter((x) => typeof x === 'string');
  for (const x of out.raw) out.ids.add(sidKey(x));
  out.count = out.raw.length;
  out.ok = true;
  return out;
}

export default { sidKey, archiveListFile, readArchivedSessionIds };
