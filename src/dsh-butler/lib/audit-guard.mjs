// dsh-butler / lib/audit-guard.mjs —— P5 拦截决策核心（纯函数，host 与单测共用）
//
// 方案 §4 P5 方案甲（真防护）+ 双层实现（主人 2026-09-09 拍板）：
//   ① fs/write-intent / fs/edit-intent 门（prepend 注册，否则被官方 observation-policy 单槽 veto）
//      —— 只拿得到路径，校验「该路径有有效凭证」→ 放行并**消耗**（一次性）。
//   ② tools/pre-execute 门（prepend 注册，官方 dsh-tool-jobs 同款姿势）
//      —— 拿得到 write/edit 的**待写入内容** → hash 与凭证比对 → 真内容级写前拦截。
//   两层顺序：pre-execute 先跑（校验不消耗）→ 工具体内 fs 门放行时消耗凭证。
//
// 本模块不做 IO（readFile 由调用方注入）、不依赖 cordis，纯判定 → 单测直接覆盖。
import { makeClassifier, normalizePath } from '../../../jobs/lib/protected-paths.mjs';
import { isButlerWritten } from '../../../jobs/lib/butler-write-paths.mjs';
import { CODES, blockMessage, contentHash } from '../../../jobs/lib/audit-token.mjs';

/** 带"待写入内容"的工具（内容级拦截对象）。其余工具由 fs 门兜底。 */
export const CONTENT_TOOLS = new Set(['write', 'edit']);

/** 从工具参数取目标路径（write/edit 用 file_path；str_replace_editor 用 path）。 */
export function toolTargetPath(toolName, args) {
  const a = args ?? {};
  const cand = [a.file_path, a.path, a.filePath];
  for (const c of cand) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

/** 从 FsTarget 取用于匹配的路径候选（targetKey 优先 = 本地后端 realpath）。 */
export function pathCandidates(target) {
  const out = [];
  if (target && typeof target.targetKey === 'string' && target.targetKey.trim()) out.push(target.targetKey);
  if (target && typeof target.displayPath === 'string' && target.displayPath.trim()) out.push(target.displayPath);
  return out;
}

/**
 * 命中保护区？（返回 {hit, pathKey, raw} 或 null）
 * @param {object|string} target FsTarget 或路径字符串
 */
export function resolveProtected(target, opts = {}) {
  const classify = makeClassifier(opts);
  const cands = typeof target === 'string' ? [target] : pathCandidates(target);
  for (const c of cands) {
    const hit = classify(c);
    if (hit) return { hit, pathKey: normalizePath(c), raw: c };
  }
  return null;
}

/**
 * 提取"即将写入的内容"。
 * write → content 直接可得；edit → 读原文件 + 应用替换（replace_all 语义）。
 * @param {{toolName:string, args:object, readFile?: (p:string)=>string}} input
 * @returns {{ok:true, text:string} | {ok:false, reason:string}}
 */
export function extractWriteContent(input) {
  const { toolName, args } = input;
  const a = args ?? {};
  if (toolName === 'write') {
    if (typeof a.content !== 'string') return { ok: false, reason: 'write 参数缺少 content' };
    return { ok: true, text: a.content };
  }
  if (toolName === 'edit') {
    const file = typeof a.file_path === 'string' ? a.file_path : null;
    const oldS = typeof a.old_string === 'string' ? a.old_string : null;
    const newS = typeof a.new_string === 'string' ? a.new_string : null;
    if (!file || oldS === null || newS === null) return { ok: false, reason: 'edit 参数不完整' };
    if (!input.readFile) return { ok: false, reason: 'no-reader' };
    let cur;
    try {
      cur = input.readFile(file);
    } catch (e) {
      return { ok: false, reason: `读原文件失败：${e?.message ?? e}` };
    }
    if (!cur.includes(oldS)) return { ok: false, reason: 'old_string 在目标文件中不存在（工具自身也会失败）' };
    const next = a.replace_all === true ? cur.split(oldS).join(newS) : cur.replace(oldS, () => newS);
    return { ok: true, text: next };
  }
  return { ok: false, reason: `未支持的内容工具：${toolName}` };
}

/**
 * fs 门决策（fs/write-intent + fs/edit-intent）。
 * @param {{target:object, tokens:import('../../../jobs/lib/audit-token.mjs').AuditTokenStore, off:{active:boolean}, event?:string, opts?:object}} input
 * @returns {{action:'allow', reason:string, pathKey?:string, hit?:object} | {action:'block', code:string, message:string, pathKey:string, hit:object}}
 */
export function decideFsIntent(input) {
  const { target, tokens, off } = input;
  const hitInfo = resolveProtected(target, input.opts ?? {});
  if (!hitInfo) return { action: 'allow', reason: 'not-protected' };
  if (hitInfo.hit.tier !== 'A') return { action: 'allow', reason: 'tier-b', pathKey: hitInfo.pathKey, hit: hitInfo.hit };
  if (off?.active) return { action: 'allow', reason: 'audit-off', pathKey: hitInfo.pathKey, hit: hitInfo.hit };
  const r = tokens.consume(hitInfo.pathKey);
  if (r.ok) return { action: 'allow', reason: 'token-consumed', pathKey: hitInfo.pathKey, hit: hitInfo.hit, entry: r.entry };
  return {
    action: 'block',
    code: r.code ?? CODES.NOT_PASSED,
    message: blockMessage(r.code ?? CODES.NOT_PASSED, { path: hitInfo.raw }),
    pathKey: hitInfo.pathKey,
    hit: hitInfo.hit,
  };
}

/**
 * pre-execute 内容门决策。
 * 语义：保护区 A 层目标必须携带「与待写入内容一致的审计凭证」。
 *   - 有凭证且 hash 匹配 → 放行（**不消耗**，交给 fs 门消耗，保证一次性语义只在一处）
 *   - 无凭证 / 过期 / hash 不匹配 → 拦截
 *   - 内容无法计算（edit 读不到原文件等）→ 退化为路径级校验（记录降级标记）
 * @returns {{action:'allow', reason:string, pathKey?:string, contentHash?:string, degraded?:string} |
 *           {action:'block', code:string, message:string, pathKey:string, hit:object}}
 */
export function decideToolCall(input) {
  const { exec, tokens, off } = input;
  const toolName = String(exec?.name ?? '');
  const args = exec?.arguments ?? {};
  const rawPath = toolTargetPath(toolName, args);
  if (!rawPath) return { action: 'allow', reason: 'no-target-path' };
  const hitInfo = resolveProtected(rawPath, input.opts ?? {});
  if (!hitInfo) return { action: 'allow', reason: 'not-protected' };
  if (hitInfo.hit.tier !== 'A') return { action: 'allow', reason: 'tier-b', pathKey: hitInfo.pathKey, hit: hitInfo.hit };
  if (off?.active) return { action: 'allow', reason: 'audit-off', pathKey: hitInfo.pathKey, hit: hitInfo.hit };

  let hash = null;
  let degraded = null;
  if (CONTENT_TOOLS.has(toolName)) {
    const ex = extractWriteContent({ toolName, args, readFile: input.readFile });
    if (ex.ok) hash = contentHash(ex.text);
    else degraded = ex.reason;
  } else {
    degraded = `工具 ${toolName} 无内容参数（仅路径级校验）`;
  }

  const r = tokens.verify(hitInfo.pathKey, hash);
  if (r.ok) return { action: 'allow', reason: hash ? 'token-hash-match' : 'token-path-match', pathKey: hitInfo.pathKey, hit: hitInfo.hit, contentHash: hash, degraded };
  const code = r.code ?? CODES.NOT_PASSED;
  return {
    action: 'block',
    code,
    message: blockMessage(code, { path: hitInfo.raw, tool: toolName }),
    pathKey: hitInfo.pathKey,
    hit: hitInfo.hit,
    degraded,
  };
}

/**
 * B 层（写后审计 / 写前备份）对象判定。
 *
 * **自指豁免（方案 §4 P4 v2.4 明确要求）**：大管家自身写入的路径（坑库 / 管家报告 /
 * 变更流水渲染视图 / 审计 JSONL / butler-* 状态文件）不参与 B 层写后审计——
 * 否则 P4 自动写坑库会被 P5 判违规并回滚 → 自动写又被写回 → 死循环。
 * 豁免清单权威源：`lib/butler-write-paths.mjs`。
 * @returns {null | {tier:'A'|'B', id:string, label:string, pathKey:string,
 *                   exempted?:boolean, exemptRule?:string|null, exemptWhy?:string|null}}
 */
export function resolveAuditTarget(target, opts = {}) {
  const hitInfo = resolveProtected(target, opts);
  if (!hitInfo) return null;
  const exempt = isButlerWritten(hitInfo.pathKey, opts);
  return {
    tier: hitInfo.hit.tier,
    id: hitInfo.hit.id,
    label: hitInfo.hit.label,
    pathKey: hitInfo.pathKey,
    exempted: exempt.hit === true,
    exemptRule: exempt.ruleId ?? null,
    exemptWhy: exempt.why ?? null,
  };
}
