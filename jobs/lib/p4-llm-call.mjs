// dsh-butler / lib/p4-llm-call.mjs —— P4「消化」段的 LLM 适配器（**只走自家链**）
//
// 背景（V3.0.0 地基 · 技术债 D-8 / 方案 `docs\方案-V3地基-D8接线与D10降档闸-20261019.md` §3 第 2 行）：
//   P4 段的 `llmCall` 注入点早就留好，但生产一直传 `null`（纯规则模板）。
//   本文件把注入点接到 `<workspace>\llm-client.mjs` 的 `llmText()`（**自家链**：deepseek 官方端点，
//   凭据 `~\.dsh\.credentials.yaml` 只读复用）—— 口径铁律 = **不外送第三方 LLM**（2026-09-23 已拍）。
//
// 设计约束（逐条对应方案原文）：
//   ① **路径不写死盘符**：用 `import.meta.url` + `path.resolve` 相对定位 `../../../llm-client.mjs`
//      （本文件在 `<pkg>\jobs\lib\` ⇒ 上三级 = `<workspace>`）。
//   ② **动态 import**：只在真调用时才加载（单测/纯规则路径零加载、零副作用）。
//   ③ **任何异常一律收敛** 成 `{ok:false, reason}` ⇒ 调用方（`p4-digest.mjs`）回退规则模板，段不失败。
//   ④ `tokens = usage.totalTokens ?? promptTokens + completionTokens`（成本闸记账口径，与 llmText 返回一致）。
//   ⑤ 固定中文 system：3~4 行内说清「共同根因 + 该怎么改 + 一句风险」，**禁止臆造文件路径**。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const P4_LLM_CALL_VERSION = '0.1.0';
/** 单次输出封顶（3~4 行中文建议 ≈ 100~200 token；留余量防截断） */
export const P4_LLM_MAX_TOKENS = 600;

/**
 * 固定 system 提示（**中文、固定**；改它等于改产出形态 ⇒ 须同步夹具与方案）。
 * 「禁止臆造路径」是本条的核心约束：模型只看见症状文本，没有文件系统上下文。
 */
export const P4_LLM_SYSTEM = [
  '你是 DSH 生态的管家助手，正在给「坑库消化」结果写一条处置建议。',
  '只输出 3~4 行中文，不要客套、不要标题、不要 markdown 代码块：',
  '第 1 行写这批坑的共同根因（一句话）；',
  '第 2~3 行写该怎么改（三选一或组合：补纪律 / 补检查项 / 改代码），要可执行；',
  '最后 1 行写一句风险（不改会怎样）。',
  '硬约束：不要臆造任何文件路径、函数名、行号或配置键——你不掌握真实仓库结构，',
  '不确定的地方就写「需人工定位」。结论只是「待主人确认」的建议，绝不声称已落地。',
  '禁令（2026-10-19 加）：**除了坑原文里已经出现过的名字**（文件名 / 技能名 / 命令名 / 配置键），',
  '一律不许点名任何具体文件、技能或文档——例如不许写「写进 xxx 技能」「补到 yyy 档」；',
  '要指落点就写「按检查项类 / 纪律类处置，落点需人工定位」。',
].join('\n');

let cachedLlmText = null;

/** 自家链入口绝对路径（**不写死盘符**；本文件 → lib → dsh-butler → DSH 根）。 */
export function resolveLlmClientPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'llm-client.mjs');
}

/** 懒加载 `llm-client.mjs`（失败抛错 ⇒ 由适配器收敛成 {ok:false}）。 */
async function loadLlmText() {
  if (cachedLlmText) return cachedLlmText;
  const target = resolveLlmClientPath();
  const mod = await import(pathToFileURL(target).href);
  if (typeof mod.llmText !== 'function') throw new Error(`llm-client.mjs 未导出 llmText（${target}）`);
  cachedLlmText = mod.llmText;
  return cachedLlmText;
}

/**
 * 造一个 P4 LLM 调用器。
 * @param {{llmText?:Function, maxTokens?:number, temperature?:number}} [opts]
 *   `llmText` 可注入（单测/演练**零外发**）；不传则动态加载自家链。
 * @returns {(req:{prompt?:string, meta?:object}) => Promise<{ok:boolean, text?:string, tokens?:number, model?:string|null, reason?:string}>}
 */
export function makeP4LlmCall({ llmText = null, maxTokens = P4_LLM_MAX_TOKENS, temperature = 0.2 } = {}) {
  return async function p4LlmCall({ prompt, meta } = {}) {
    try {
      const fn = typeof llmText === 'function' ? llmText : await loadLlmText();
      const user = String(prompt ?? '');
      const extra = meta && typeof meta === 'object'
        ? `\n[上下文] ${Object.entries(meta).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}`
        : '';
      const r = await fn({ system: P4_LLM_SYSTEM, user: `${user}${extra}`, maxTokens, temperature });
      if (!r || r.ok !== true) {
        return { ok: false, reason: String(r?.reason ?? 'llm-failed'), tokens: 0 };
      }
      const text = String(r.text ?? '').trim();
      if (!text) return { ok: false, reason: 'empty', tokens: 0 };
      const usage = r.usage ?? {};
      const tokens = Number(
        usage.totalTokens ?? ((Number(usage.promptTokens) || 0) + (Number(usage.completionTokens) || 0)),
      ) || 0;
      return { ok: true, text, tokens, model: r.model ?? null };
    } catch (e) {
      return { ok: false, reason: `exception:${String(e && e.message ? e.message : e).slice(0, 200)}`, tokens: 0 };
    }
  };
}
