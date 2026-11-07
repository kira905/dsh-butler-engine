#!/usr/bin/env node
/**
 * steward-advice.mjs —— 协调线 **乙层 · 四段建议器**（2026-11-02 · 卡 C5）
 *
 * 职责：甲层产物 → 组提示词 → **调一次** `llmText` → 三道机械闸 → 写 state + 人读 md。
 *
 * ── 设计真源（只此一份，本文件不复述口径）──────────────────────────────────────────
 *   `<butler-root>\docs/`
 *     §1.1  脑 = 两层（甲层零 token / 乙层一次调用）
 *     §1.7  乙层设计整节（1.7.1 取数白名单 · 1.7.2 输出契约三道闸 · 1.7.3 代价含并行影响
 *           · 1.7.4 日上限/预算 · 1.7.5 引不出规矩三档 · 1.7.6 落点 · 1.7.7 不做什么 · 1.7.8 欠账）
 *     §4.4  并行是常态（撞车判据的来历）
 *     §6    判据 2（每条"我替你拍了"都要引出已有规矩原文）/ 判据 6（"今天没事"必须可核）
 *
 * ── 本文件的硬约束（逐条能机械核）──────────────────────────────────────────────
 *   1. **零写板**：不建卡、不发 session-say、不改卡状态、不写看板（§1.7.7）；
 *   2. **不读会话内容**：`session.list` 那套是甲层 C6 的活；
 *   3. **规矩原文由脚本按 id 从判决表取**（带 `档:行`），模型只给 `citedRuleId`
 *      —— 转述 = 幻觉源，这是全卡最重要的一条（§1.7.2 第 2 闸）；
 *   4. **不自己判撞车**：`parallelImpact` 只翻译甲层 `report.collision`，
 *      判不出就照写"判不出"，**不许编**（§1.7.3 B1 订正）；
 *   5. 写盘一律 `lib\store.mjs#writeTextAtomic`，禁 `fs.writeFileSync` 直写 state。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node tools\dsh-butler\steward-advice.mjs --selftest         # 18 条夹具（零真实网络调用）
 *   node tools\dsh-butler\steward-advice.mjs --dry-run          # 打印提示词 + 估算 token，不写盘不调模型
 *   node tools\dsh-butler\steward-advice.mjs                    # 只读体检：说清"今天跑没跑/为什么没跑"，**不调模型**
 *   node tools\dsh-butler\steward-advice.mjs --apply            # 真跑一次（花几分钱）+ 写 state / md
 *   node tools\dsh-butler\steward-advice.mjs --apply --force-llm  # 今天跑过了也重调
 *   node tools\dsh-butler\steward-advice.mjs --apply --offline    # 绝不联网（只留降级痕迹）
 *   node tools\dsh-butler\steward-advice.mjs --apply --dump-raw <file>  # 顺带把模型原文留档
 *
 *   🔴 **不写盘就不调模型**：钱一花出去就必须落 `adviceSpend`，否则"日上限 1 次"与"月预算 ¥5"
 *      两道闸只是纸上的 —— 不带 `--apply` 白花一次还没账（2026-11-02 验收实测踩到，已改成硬闸）。
 *
 * ── 退出码 ───────────────────────────────────────────────────────────────────
 *   0 正常（含"今天没事"/"今天已跑过"） · 1 有 advice 被闸丢弃 · 2 模型未响应（退化成只列候选）
 *   3 硬输入读不到（甲层跑不出来） · 4 预算闸拦住 · 5 夹具失败
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeTextAtomic, acquireTickLock } from './lib/store.mjs';
import { dshHome } from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const DSH = path.resolve(HERE, '..', '..');

// ================================================================ 常量

export const ADVICE_VERSION = '1.0.0';

/** 甲层入口（同目录）。 */
const STEWARD_ENTRY = path.join(HERE, 'steward.mjs');

/** 判决表（§1.7.1 末行 · 规矩清单的唯一来源）。 */
export const RULE_TABLE_REL = 'docs/';

/** `id` 复合形态前缀 —— 纯 `R<N>` 不行（该表已从 v0.1 重排到 v1.0 一次，编号会漂）。 */
export const RULE_ID_PREFIX = '判决表v1.0#R';

/** 只解析这一段内的 `#### N.`（`## 二、候选` 的 `### C1.`~`C4.` **绝不进清单**）。 */
export const RULE_SECTION_HEADING = '## 一、已核判据';
export const RULE_CANDIDATE_HEADING = '## 二、候选';

/** 输入硬上限（§1.7.1）：中文约 1.2 万汉字 / 1.5 万字符 ≈ 8K token。 */
export const INPUT_TOKEN_BUDGET = 8000;
/** 换算口径（字符 → token）：15,000 字符 ≈ 8,000 token。 */
export const CHARS_PER_TOKEN = 15000 / INPUT_TOKEN_BUDGET;

/** 规矩清单字符预算（§1.7.1：只发 id+标题 ≈2.6K 字符；全量 17,355 字符会撑爆 2K token 预算）。 */
export const RULE_LIST_CHAR_BUDGET = 2600;
/** 标题截断长度（§1.7.1：标题 ≤40 字）。 */
export const RULE_TITLE_MAX = 40;

/** 单次输出 cap（§1.7.4）。 */
export const ADVICE_MAX_TOKENS = 3000;

/** 月预算硬闸 ¥5（§1.7.4）。 */
export const MONTH_CAP_CNY = 5;

/** 高峰价（每百万 token，美元）—— 🔴 一律按高峰估，保守上界（§1.7.4）。 */
export const PRICE_IN_USD_PER_M = 0.60;
export const PRICE_OUT_USD_PER_M = 1.20;
/** 汇率（§1.7.4 的记账公式写死 7.2）。 */
export const USD_CNY = 7.2;

/** 闸 2：乙层不许"替主人拍板"的口吻（除非真有 citedRule 撑着）。 */
export const DECLARATIVE_RE = /我拍了|已决定|已定下来|就此定了/;

/** 闸 3 合法值（§1.7.3 三值 + 甲层 `可并行` 直译 —— 见 README 与报告"第四值"登记）。 */
export const PARALLEL_IMPACT_LITERALS = Object.freeze(['独占', '判不出', '可并行']);
export const PARALLEL_IMPACT_MUTEX_PREFIX = '互斥：';

/** 甲层 collision verdict（与 steward.mjs 的 COLLISION_VERDICTS 对齐）。 */
const CV = Object.freeze({ ALONE: '独占', MUTEX: '互斥', PARALLEL: '可并行', MANUAL: '待人工判' });

/** 取数白名单里各段的条数上限（§1.7.1）。 */
export const WHITELIST_LIMITS = Object.freeze({
  staleCross: 10,
  failed: 10,
  capabilityItems: 20,
  lines: 20,
});

/** 人读落点（§1.7.6）。 */
export const REPORT_DIR_REL = 'docs\\reports';

/** 年轮档（"今天没事"要列 mtime · §6 判据 6）。 */
export const ARTIFACTS = Object.freeze({
  capability: 'docs/',
  tongchou: 'docs/',
});

// ================================================================ 小工具

export const sha16 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
export const ymd = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
/** 月度键 `YYYY-MM`（钱闸的分桶）。 */
export const ymOf = (ms) => ymd(ms).slice(0, 7);
export const hostName = () => process.env.COMPUTERNAME || 'unknown';
/** 字符 → token 的保守估算（上取整；口径见 §1.7.1）。 */
export const estTokens = (chars) => Math.ceil(Number(chars || 0) / CHARS_PER_TOKEN);

/** 单次成本（元）—— 用 `llmText` 返回的 usage，**不许估**（§1.7.4）。 */
export function costCny(usage) {
  const p = Number(usage?.promptTokens ?? 0);
  const c = Number(usage?.completionTokens ?? 0);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return 0;
  return (p * PRICE_IN_USD_PER_M + c * PRICE_OUT_USD_PER_M) / 1e6 * USD_CNY;
}

// ================================================================ ① 判决表解析（§1.7.1 末行）

/**
 * 解析判决表 → 规矩清单。
 *
 * 🔴 只认 `## 一、已核判据` 段内的 **`#### N.` 四级标题**。
 *    `## 二、候选` 段的 `### C1.`~`C4.` 一条都不许进来（表头原话「未核的一律标『候选』，
 *    不许当依据用」，且 `### C.` 分类与该段撞号）。
 *
 * @param {string} text 判决表全文
 * @returns {{rules:Array<{id:number,idStr:string,title:string,cls:string,lineNo:number,ruleText:string,ruleLine:number}>,warnings:Array}}
 */
export function parseRuleTable(text) {
  const lines = String(text ?? '').split('\n');
  const warnings = [];
  const rules = [];

  // ① 定位「已核」段（到下一个 `## ` 为止）
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(RULE_SECTION_HEADING)) { start = i; break; }
  }
  if (start < 0) {
    warnings.push({ level: 'yellow', code: 'rule-section-missing', message: `判决表里找不到「${RULE_SECTION_HEADING}」段 —— 清单为空，乙层只能出 suggest` });
    return { rules, warnings };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  // ①b 候选段若被误并进来，再切一刀（双保险：即便标题格式变了也不会把候选当依据）
  for (let i = start + 1; i < end; i++) {
    if (lines[i].trim().startsWith(RULE_CANDIDATE_HEADING)) { end = i; break; }
  }

  // ② 段内扫 `#### N. 标题`
  let curCls = '';
  let cur = null;
  const flush = () => {
    if (!cur) return;
    rules.push(cur);
    cur = null;
  };
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const cls = /^###\s+([A-Z])\.\s*(.*)$/.exec(line);
    if (cls) { curCls = cls[1]; flush(); continue; }
    const h = /^####\s+(\d+)\.\s*(.*)$/.exec(line);
    if (h) {
      flush();
      cur = {
        id: Number(h[1]),
        idStr: `${RULE_ID_PREFIX}${Number(h[1])}`,
        title: String(h[2] ?? '').trim(),
        cls: curCls,
        lineNo: i + 1,                     // 1-based，给人核
        ruleText: '',
        ruleLine: 0,
      };
      continue;
    }
    // `**判据**：` 必须同一行（复审已实测 24/24 不跨行）—— 跨行就如实登记，不拼
    if (cur && !cur.ruleText) {
      const m = /^\*\*判据\*\*\s*[：:]\s*(.+)$/.exec(line);
      if (m) { cur.ruleText = m[1].trim(); cur.ruleLine = i + 1; }
    }
  }
  flush();

  // ③ 体检：缺 `判据` / 编号不连续 ⇒ 报黄、不崩、不当空
  const missing = rules.filter((r) => !r.ruleText);
  if (missing.length) {
    warnings.push({
      level: 'yellow', code: 'rule-text-missing',
      message: `判决表有 ${missing.length} 条缺「**判据**：」原文（${missing.map((r) => r.idStr).join(',')}）—— 这些条被 cite 时 citedRuleText 只能为空，按 unverifiable 处理`,
    });
  }
  if (!rules.length) {
    warnings.push({ level: 'yellow', code: 'rule-list-empty', message: '已核段内 `#### N.` 一条都没解析出来 —— 乙层只能出 suggest（不许自己新增规矩，§1.7.7）' });
  }
  return { rules, warnings };
}

/**
 * 规矩清单渲染（**只放 id + 标题**，绝不放 `判据` 全文 — §1.7.1）。
 *
 * 截断三档：① 只发 id+标题（默认）；② 仍超字符预算 ⇒ 按 A→E 类**均摊**取前 N 条，头写「已截断」。
 *
 * @returns {{text:string,shown:number,total:number,truncated:boolean,chars:number}}
 */
export function buildRuleList(rules, { charBudget = RULE_LIST_CHAR_BUDGET } = {}) {
  const total = rules.length;
  const fmt = (r) => `- ${r.idStr} ${r.title.slice(0, RULE_TITLE_MAX)}`;
  const block = (list) => list.map(fmt).join('\n');

  let shown = rules;
  let truncated = false;
  if (block(rules).length > charBudget) {
    // 按类均摊：A→E 各自取前 n 条，轮转补齐，直到再取一条就超预算
    const byCls = new Map();
    for (const r of rules) {
      const k = r.cls || '?';
      if (!byCls.has(k)) byCls.set(k, []);
      byCls.get(k).push(r);
    }
    const clsOrder = [...byCls.keys()].sort();
    const picked = [];
    for (let round = 0; ; round++) {
      let added = false;
      for (const k of clsOrder) {
        const arr = byCls.get(k);
        if (round >= arr.length) continue;
        const cand = [...picked, arr[round]].sort((a, b) => a.id - b.id);
        if (block(cand).length > charBudget) continue;
        picked.push(arr[round]);
        added = true;
      }
      if (!added) break;
    }
    picked.sort((a, b) => a.id - b.id);
    shown = picked;
    truncated = true;
  }

  const head = truncated
    ? `清单已截断：只给了 ${shown.length}/${total} 条（按 A→E 类均摊；cite 清单外的 id 会被降级成 suggest）`
    : `可用规矩清单（${total} 条已核，全给）`;
  const text = `${head}\n${block(shown)}`;
  return { text, shown: shown.length, total, truncated, chars: text.length };
}

// ================================================================ ② 甲层取数（§1.7.1 白名单）

/**
 * 跑甲层（`steward.mjs --json --no-write`）拿 `report`。
 * 照 `steward.mjs` 里跑 `standup.mjs` 的同款做法（spawnSync + UTF-8）。
 *
 * @returns {{ok:boolean, report?:object, bytes?:number, reason?:string, raw?:string}}
 */
export function runSteward({ dsh = DSH, timeoutMs = 120_000, spawn = spawnSync } = {}) {
  const entry = path.join(dsh, 'tools', 'dsh-butler', 'steward.mjs');
  if (!fs.existsSync(entry)) return { ok: false, reason: `甲层脚本不存在：${entry}` };
  const r = spawn(process.execPath, [entry, '--json', '--no-write'], {
    cwd: dsh, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (r.error) return { ok: false, reason: `甲层起不来：${r.error.message}` };
  const stdout = String(r.stdout ?? '');
  if (!stdout.trim()) return { ok: false, reason: `甲层无输出（rc=${r.status}）${String(r.stderr || '').slice(0, 300)}`, raw: String(r.stderr || '').slice(0, 2000) };
  let j;
  try { j = JSON.parse(stdout); } catch (e) { return { ok: false, reason: `甲层输出不是 JSON：${e.message}`, raw: stdout.slice(0, 600) }; }
  const report = j.report || j;
  if (!report || !Array.isArray(report.raised)) return { ok: false, reason: '甲层 report 缺 raised[]（形状变了？）', raw: stdout.slice(0, 600) };
  return { ok: true, report, bytes: Buffer.byteLength(stdout, 'utf8') };
}

/**
 * 甲层 `collision` → 该项的撞车裁决。
 * ⚠️ 现跑实物是 **对象** `{ok,hitRate,hitCount,judgedCount,items[]}`（不是数组）—— 按实物取 `items[]`。
 */
export function collisionOf(report, cardId) {
  const col = report?.collision;
  const items = Array.isArray(col) ? col : (Array.isArray(col?.items) ? col.items : []);
  const hit = items.find((x) => x && x.cardId === cardId);
  if (!hit) return { verdict: CV.MANUAL, guessed: true, evidence: '（甲层 collision 里没有这张卡）', rivals: [], missing: true };
  return hit;
}

/**
 * 撞车裁决 → `parallelImpact` 文案（§1.7.3 表 · 乙层只翻译，不自己判）。
 * 甲层缺该项 / `待人工判` ⇒ `判不出`（**不许编**）。
 */
export function translateParallelImpact(col) {
  const v = col?.verdict;
  if (v === CV.ALONE) return '独占';
  if (v === CV.PARALLEL) return '可并行';
  if (v === CV.MUTEX) {
    const rival = (col.rivals || [])[0];
    const name = rival?.title || rival?.cardId || '';
    return name ? `${PARALLEL_IMPACT_MUTEX_PREFIX}${String(name).trim()}` : '判不出';
  }
  return '判不出';
}

/**
 * 组「喂给模型」的白名单负载（§1.7.1）。
 * 🔴 **不喂** `report.excluded`（本线自举排除项）· 会话内容 · 账本原文 · 指令通道。
 * 超 8K token 按 `raised → stale.cross → failed → warnings → lines` 顺序截断。
 *
 * @returns {{payload:object,chars:number,estTokens:number,truncatedCount:number,truncatedSections:string[]}}
 */
export function buildWhitelistPayload(report, { tokenBudget = INPUT_TOKEN_BUDGET } = {}) {
  const budgetChars = Math.floor(tokenBudget * CHARS_PER_TOKEN);

  let used = 0;
  let truncatedCount = 0;
  const truncatedSections = [];

  const take = (arr, limit, section) => {
    const src = Array.isArray(arr) ? arr.slice(0, limit) : [];
    const out = [];
    for (const x of src) {
      const size = JSON.stringify(x).length;
      if (used + size > budgetChars) { truncatedCount += src.length - out.length; truncatedSections.push(section); break; }
      out.push(x);
      used += size;
    }
    return out;
  };
  const takeAll = (arr, section) => {
    const src = Array.isArray(arr) ? arr : [];
    return take(src, src.length, section);
  };

  const raised = takeAll(report.raised, 'raised');
  const raisedIds = new Set(raised.map((x) => x.id));

  const payload = {
    host: report.host,
    generatedAt: report.generatedAt,
    ledgerRevision: report.ledgerRevision,
    totals: report.totals,
    convergence: report.convergence,
    raised,
    // `top` 是**单个对象**（= raised[0]），不是数组 —— 别照 `top[]` 写（§1.7.1 明确订正过）
    top: report.top ?? null,
  };

  payload.staleCross = take(report?.stale?.cross, WHITELIST_LIMITS.staleCross, 'stale.cross');
  // failed 段取数口径 = 甲层的 `failedLedger`（账本级 · 在板 · 已排除归档与本线），
  // 不是 `report.failed`（候选口径 —— 只含 standup.pendingTop 里的 failed 卡，候选为空那天整段是空的）。
  // 键名仍是 `failed`（模型侧文案不变）；`failedLedger` 缺省时回落旧字段，兼容老 state / 老夹具。
  // 真源：`docs/` §3-C。
  payload.failed = take(Array.isArray(report.failedLedger) ? report.failedLedger : report.failed, WHITELIST_LIMITS.failed, 'failed');
  payload.warnings = takeAll(report.warnings, 'warnings');
  payload.lines = take(
    (Array.isArray(report.lines) ? report.lines : []).map((g) => ({
      line: g.line, cards: g.cards, running: g.running, failed: g.failed, pending: g.pending, oldestAgeDays: g.oldestAgeDays,
    })),
    WHITELIST_LIMITS.lines, 'lines',
  );
  payload.capabilityItems = take(
    (report?.capability?.items || []).map((it) => ({
      from: it.from, to: it.to, what: it.what, status: it.status, since: it.since,
      card: it.card ?? it.cards, unlockWhen: it.unlockWhen,
    })),
    WHITELIST_LIMITS.capabilityItems, 'capability.items',
  );

  // C6 两段：撞车裁决 + 卡面摘要（乙层「代价」「背景」直接吃它，不自己判）
  payload.collision = raised.map((x) => collisionOf(report, x.id)).map((c, i) => ({
    cardId: raised[i].id, verdict: c.verdict, guessed: c.guessed !== false,
    evidence: String(c.evidence ?? '').slice(0, 200),
    rivals: (c.rivals || []).map((r) => ({ cardId: r.cardId, title: String(r.title ?? '').slice(0, 60) })),
  }));
  const cardText = report.cardText && typeof report.cardText === 'object' ? report.cardText : {};
  payload.cardText = {};
  for (const x of raised) {
    const t = cardText[x.id];
    if (t) payload.cardText[x.id] = { title: t.title, desc400: String(t.desc400 ?? '') };
  }

  // 🔴 自检：绝不把 excluded 带进来（这是本函数最容易退化的一处）
  const droppedKeys = ['excluded', 'sessions'];
  for (const k of droppedKeys) if (k in payload) delete payload[k];

  const chars = JSON.stringify(payload).length;
  return { payload, chars, estTokens: estTokens(chars), truncatedCount, truncatedSections };
}

// ================================================================ ③ 提示词（§1.7.2 输出契约）

export const SYSTEM_PROMPT = [
  '你是「掌柜」的乙层：只写文字，**不做决定**。',
  '',
  '规则（违章的输出会被机械闸整段丢弃，别试）：',
  '1. 你只能为「候选清单」里已有的卡写建议 —— `cardId` 必须逐字照抄清单里的 id，不许自造、不许改写别卡。',
  '2. 规矩原文**不许你转述**：你只能从「可用规矩清单」里挑一个 `citedRuleId` 填进 `citedRuleId` 字段；',
  '   原文由脚本按 id 去判决表取。清单里没有的 id 不要填 —— 填了会被降级。',
  '3. `verdict`：能从清单里引到规矩、且这条规矩真能支撑拍板 ⇒ `decide`；引不到 ⇒ `suggest`。',
  '   **`decide` 必须带 `citedRuleId`，否则整条作废**。',
  '4. `suggest` 时**禁止**出现「我拍了 / 已决定 / 已定下来 / 就此定了」这类替主人拍板的说法 —— 会被丢弃。',
  '5. `parallelImpact` 只能从这三类里选（照抄给值，不许编）：`独占` / `互斥：<另一件事>` / `判不出`。',
  '   数据里给了 `collision`（甲层的撞车裁决，都是近似判断），照它翻译成上面三类；拿不准就写 `判不出`。',
  '6. 输出**必须是纯 JSON**，不要 markdown 代码块、不要前后解释。形状：',
  '   {"advices":[{"cardId":"","background":"","options":[{"label":"","effect":"","cost":""}],',
  '     "recommend":"","why":"","citedRuleId":null,"parallelImpact":"","verdict":"suggest"}]}',
  '7. 四段里「代价」必须含**并行影响**（这件开工会不会让别的事动不了）；`options` 至少 2 项，每项写清「选它会怎样 + 代价」。',
  '8. 全部用大白话。术语要解释。别写客套话。',
].join('\n');

/**
 * 组提示词。
 * @returns {{system:string,user:string,chars:number,estTokens:number,truncatedCount:number,truncatedSections:string[]}}
 */
export function buildPrompt({ report, ruleList, tokenBudget = INPUT_TOKEN_BUDGET, collisionHint = null } = {}) {
  const built = buildWhitelistPayload(report, { tokenBudget });
  const parts = [];
  parts.push('## 甲层产物（白名单 · 已排除本线自举项 / 会话内容 / 账本原文 / 指令通道）');
  parts.push('```json');
  parts.push(JSON.stringify(built.payload, null, 1));
  parts.push('```');
  parts.push('');
  parts.push('## 可用规矩清单（只读 · 你只许选 id，不许自己写规矩原文）');
  parts.push(ruleList.text);
  parts.push('');
  parts.push('## 你要做的');
  parts.push(`为「candidate」里列出的 ${(report.raised || []).length} 张卡各写四段建议（背景 / 选项 / 建议 / 代价），按上面的 JSON 形状输出。`);
  parts.push('`cardId` 必须是下面这些之一，一个字都不许改：');
  for (const x of report.raised || []) parts.push(`- ${x.id} ｜ ${x.title}`);
  if (built.truncatedCount > 0) {
    parts.push('');
    parts.push(`⚠️ 已截断 ${built.truncatedCount} 条（${built.truncatedSections.join('/')}），你看到的信息不全。`);
  }
  if (collisionHint) { parts.push(''); parts.push(collisionHint); }
  const user = parts.join('\n');
  return {
    system: SYSTEM_PROMPT, user,
    chars: user.length + SYSTEM_PROMPT.length,
    estTokens: estTokens(user.length + SYSTEM_PROMPT.length),
    truncatedCount: built.truncatedCount,
    truncatedSections: built.truncatedSections,
  };
}

// ================================================================ ④ 解析 + 三道机械闸（§1.7.2）

/** 从模型原文里抠 JSON（容忍 ```json 围栏与前后废话）。 */
export function parseAdviceJSON(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let j = tryParse(raw);
  if (!j) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    if (fenced) j = tryParse(fenced[1].trim());
  }
  if (!j) {
    const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) j = tryParse(raw.slice(a, b + 1));
  }
  if (!j) return { ok: false, reason: 'bad-json', raw };
  if (!Array.isArray(j.advices)) return { ok: false, reason: 'bad-shape', raw };
  return { ok: true, advices: j.advices };
}

const adviceTextOf = (a) => [
  String(a.background ?? ''), String(a.why ?? ''), String(a.recommend ?? ''),
  ...(Array.isArray(a.options) ? a.options.map((o) => [o?.label, o?.effect, o?.cost].map((x) => String(x ?? '')).join(' ')) : []),
].join('\n');

const drop = (reason, extra = {}) => ({ ok: false, status: 'dropped', dropReason: reason, ...extra });

/**
 * 三道机械闸（§1.7.2）—— 任一不过 ⇒ 该条 `status='dropped'`（§1.7.5 第三档=该卡只列候选）。
 *
 * @param {object} a 模型给的一条
 * @param {{raisedIds:Set<string>, ruleById:Map<string,object>, collisionOf:(id)=>object}} ctx
 */
export function gateAdvice(a, ctx) {
  if (!a || typeof a !== 'object') return drop('not-an-object');

  // ── 闸 1：cardId 必须在本次 raised[] 里
  const cardId = String(a.cardId ?? '').trim();
  if (!ctx.raisedIds.has(cardId)) return drop('card-not-raised', { cardId });

  // ── 形状
  const background = String(a.background ?? '').trim();
  const why = String(a.why ?? '').trim();
  const recommend = String(a.recommend ?? '').trim();
  const options = (Array.isArray(a.options) ? a.options : [])
    .map((o) => ({ label: String(o?.label ?? '').trim(), effect: String(o?.effect ?? '').trim(), cost: String(o?.cost ?? '').trim() }))
    .filter((o) => o.label);
  if (!background) return drop('shape-background', { cardId });
  if (options.length < 1) return drop('shape-options', { cardId });
  if (!recommend) return drop('shape-recommend', { cardId });
  if (!why) return drop('shape-why', { cardId });

  let verdict = String(a.verdict ?? '').trim();
  if (verdict !== 'decide' && verdict !== 'suggest') return drop('shape-verdict', { cardId });

  // ── 闸 2：规矩原文不许由模型转述；原文由脚本按 id 取
  let citedRuleId = '';
  let citedRuleText = '';
  let citedRuleRef = '';
  let unverifiable = false;
  const rawId = a.citedRuleId == null ? '' : String(a.citedRuleId).trim();

  if (!rawId) {
    if (verdict === 'decide') return drop('decide-without-rule', { cardId });
    verdict = 'suggest';
  } else {
    const hit = ctx.ruleById.get(rawId);
    if (!hit) {
      // 清单外 / 查不到 ⇒ 强制降级 suggest（§1.7.1 截断档 ③ + §1.7.2 第 2 闸）
      verdict = 'suggest';
      unverifiable = true;
      citedRuleId = rawId;              // 留痕：记下模型 cite 了什么（人不许当依据，但审计要看）
    } else {
      citedRuleId = rawId;
      citedRuleText = hit.ruleText || '';
      citedRuleRef = `${RULE_TABLE_REL}:${hit.ruleLine || hit.lineNo}`;
      if (!citedRuleText) { verdict = 'suggest'; unverifiable = true; }   // 该条缺原文
    }
  }

  // 正文替主人拍板（在降级**之后**判 —— 降级成 suggest 之后再说"我拍了"就不合格）
  const body = [background, why, recommend, ...options.map((o) => `${o.label} ${o.effect} ${o.cost}`)].join('\n');
  if (verdict !== 'decide' && DECLARATIVE_RE.test(body)) return drop('declarative-without-rule', { cardId });

  // ── 闸 3：parallelImpact 非空 + 值域 + 与甲层 collision 一致（不许编）
  const pi = String(a.parallelImpact ?? '').trim();
  if (!pi) return drop('parallel-impact-empty', { cardId });
  const col = ctx.collisionOf(cardId);
  const expected = translateParallelImpact(col);
  const isMutex = pi.startsWith(PARALLEL_IMPACT_MUTEX_PREFIX) && pi.length > PARALLEL_IMPACT_MUTEX_PREFIX.length;
  if (!PARALLEL_IMPACT_LITERALS.includes(pi) && !isMutex) return drop('parallel-impact-out-of-vocab', { cardId });
  if (!parallelImpactConsistent(pi, expected)) return drop('parallel-impact-mismatch', { cardId });

  return {
    ok: true, status: 'ok', cardId, verdict, citedRuleId, citedRuleText, citedRuleRef, unverifiable,
    background, why, recommend, options, parallelImpact: pi,
  };
}

/** 模型给的 parallelImpact 是否与甲层裁决一致（互斥允许"前缀对上"：标题可能被截断）。 */
export function parallelImpactConsistent(got, expected) {
  if (got === expected) return true;
  if (expected === '判不出') return false;                        // 甲层判不出 ⇒ 只能是"判不出"
  if (expected === '独占') return false;                          // 甲层说独占 ⇒ 不许写成别的
  if (expected === '可并行') return got === '可并行';
  if (expected.startsWith(PARALLEL_IMPACT_MUTEX_PREFIX)) {
    // 甲层说互斥：模型必须也写"互斥：X"，且 X 与甲层给的对手名有交叠
    if (!got.startsWith(PARALLEL_IMPACT_MUTEX_PREFIX)) return false;
    const g = got.slice(PARALLEL_IMPACT_MUTEX_PREFIX.length).trim();
    const e = expected.slice(PARALLEL_IMPACT_MUTEX_PREFIX.length).trim();
    return !g || g.includes(e.slice(0, 6)) || e.includes(g.slice(0, 6));
  }
  return false;
}

// ================================================================ ⑤ 落点（§1.7.6）

/**
 * 把本轮结果合进 state —— **两个独立顶层段**（B3：不许合并、不许改名）：
 *   · `advices[]`     ：每条 `id = sha16(<日期>|<cardId>)`，同 id 二次写入 = no-op
 *   · `adviceSpend{}` ：钱闸 `{ym, calls, cny}`，单独一段
 */
export function mergeAdviceState(prev, { advices = [], spend = null, now = Date.now() } = {}) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const out = { ...p };                                     // ⚠️ 只用于乙层自己的写；甲层 mergeState 是写死段清单
  const date = ymd(now);

  const list = Array.isArray(p.advices) ? p.advices.slice() : [];
  let added = 0;
  for (const a of advices) {
    const id = a.id || sha16(`${date}|${a.cardId ?? '__run__'}`);
    const idx = list.findIndex((x) => x && x.id === id);
    if (idx >= 0) {
      // 幂等：同 id 二次 = no-op。但 `--force-llm` 显式重跑时允许覆盖内容（花过钱的那次要能留下）
      if (!a.overwrite) continue;
      list[idx] = { ...list[idx], ...a, id };
      continue;
    }
    list.push({ ...a, id });
    added++;
  }
  out.advices = list;

  if (spend) {
    const ym = spend.ym || ymOf(now);
    const prevSpend = p.adviceSpend && typeof p.adviceSpend === 'object' ? p.adviceSpend : null;
    const sameMonth = prevSpend && prevSpend.ym === ym;
    out.adviceSpend = {
      ym,
      calls: Number((sameMonth ? prevSpend.calls : 0) || 0) + Number(spend.calls || 0),
      cny: Math.round((Number((sameMonth ? prevSpend.cny : 0) || 0) + Number(spend.cny || 0)) * 1e6) / 1e6,
    };
  } else if (!p.adviceSpend) {
    out.adviceSpend = { ym: ymOf(now), calls: 0, cny: 0 };   // 首次也把段建出来（空段也算"已登记"）
  }
  return { state: out, added };
}

/**
 * 今天的建议记录（判"今天跑过没有"）。
 *
 * 🔴 不许用 `String(at).startsWith(本地日期)`：`at` 存的是 **UTC ISO**（`...Z`），而日期键是**本地**日期。
 *    东八区 20:00 以后 UTC 已经是前一天 ⇒ 前缀比对永远 false ⇒ "今天已跑过"失效 ⇒ 当天重复调模型、
 *    真金白银重复花（2026-11-02 本卡验收时实测踩到，当场多花 ¥0.042）。
 *    正确做法 = `Date.parse(at)` 拿到时刻，再用本地时区转日期。
 */
export function advicesToday(state, now = Date.now()) {
  const date = ymd(now);
  return (Array.isArray(state?.advices) ? state.advices : []).filter((a) => {
    const t = Date.parse(String(a?.at ?? ''));
    return Number.isFinite(t) && ymd(t) === date;
  });
}

/** 预算闸：本月已花 ≥ ¥5 ⇒ 停（`ym` 不同 = 新月，自动放行）。 */
export function budgetExceeded(state, now = Date.now()) {
  const s = state?.adviceSpend;
  if (!s || s.ym !== ymOf(now)) return { exceeded: false, ym: ymOf(now), cny: 0, calls: 0 };
  const cny = Number(s.cny || 0);
  return { exceeded: cny >= MONTH_CAP_CNY, ym: s.ym, cny, calls: Number(s.calls || 0) };
}

/** 读某份档的 mtime（"今天没事"要逐份列出来 — §6 判据 6）。 */
export function artifactMtimes({ dsh = DSH, home = dshHome(), report = null } = {}) {
  const rows = [];
  const add = (name, file, extra = '') => {
    let mtime = null; let exists = false;
    try { const st = fs.statSync(file); mtime = st.mtime.toISOString(); exists = true; } catch { /* 不存在 */ }
    rows.push({ name, path: file, exists, mtime, extra });
  };
  add('看板账本（revision 来源）', path.join(home, 'task-board', 'ledger-v2.json'),
    report?.ledgerRevision != null ? `revision=${report.ledgerRevision}` : '');
  add(`年轮 · capability.json`, path.join(dsh, ARTIFACTS.capability));
  add(`年轮 · 协调线.json`, path.join(dsh, ARTIFACTS.tongchou));
  add('甲层产物（本轮 spawn 的 stdout）', path.join(home, 'steward-state.json'),
    report?.generatedAt ? `report.generatedAt=${report.generatedAt}` : '');
  return rows;
}

// ================================================================ ⑥ 人读 md（§1.7.6）

export function renderAdviceMarkdown({ now = Date.now(), host = hostName(), report = null, results = [], banner = null, spend = null, artifacts = [] } = {}) {
  const L = [];
  const date = ymd(now);
  L.push(`# 掌柜乙层建议 · ${date} · ${host}`);
  L.push('');
  if (banner) { L.push(`> ${banner}`); L.push(''); }
  L.push(`> 生成：${new Date(now).toISOString()} · 模型 \`deepseek-v4-flash\`（legacy 名）`
    + ` · 本次 ¥${(spend?.cnyThis ?? 0).toFixed(6)} · 本月 ¥${(spend?.cnyMonth ?? 0).toFixed(4)}/¥${MONTH_CAP_CNY.toFixed(2)}`
    + `（${spend?.callsMonth ?? 0} 次）`);
  if (report) {
    const c = report.convergence || {};
    L.push(`> 甲层：看板 rev ${report.ledgerRevision ?? '?'} · 在途 ${report.totals?.live ?? '?'} 张`
      + ` · 收敛线 ${c.total ?? '?'} 件（${c.status ?? '?'}）· 候选 ${(report.raised || []).length} 件`);
  }
  L.push('');

  const okList = results.filter((r) => r.status === 'ok');
  const dropList = results.filter((r) => r.status === 'dropped');
  const failedList = results.filter((r) => r.status === 'failed');

  if (!okList.length && !dropList.length && !failedList.length) {
    L.push('## 建议');
    L.push('');
    L.push('（本轮没有生成建议）');
    L.push('');
  }

  okList.forEach((r, i) => {
    const t = (report?.raised || []).find((x) => x.id === r.cardId);
    L.push(`## ${i + 1}. ${t?.title ?? r.cardId}`);
    L.push('');
    L.push(`- **卡**：\`${r.cardId}\`（${t?.line ?? '?'} · ${t?.status ?? '?'} · 躺了 ${t?.ageDays ?? '?'} 天）`);
    L.push(`- **背景**：${r.background}`);
    L.push('- **选项**：');
    for (const o of r.options) L.push(`  - **${o.label}** —— 会怎样：${o.effect}　代价：${o.cost}`);
    L.push(`- **建议**：${r.recommend} —— 因为 ${r.why}`);
    L.push(`- **代价 / 并行影响**：${parallelImpactHuman(r.parallelImpact)}`);
    if (r.citedRuleText) {
      L.push(`- **依据**：\`${r.citedRuleId}\`（${r.citedRuleRef}）「${r.citedRuleText}」`);
    } else if (r.citedRuleId) {
      L.push(`- **依据**：\`${r.citedRuleId}\` ⚠️ **查不到原文**（unverifiable，只能当"建议你拍"）`);
    } else {
      L.push('- **依据**：无 —— 我找不到现成规矩，**这条请你定**');
    }
    L.push(`- **判定**：${r.verdict === 'decide' ? '我按规矩拍了' : '建议你拍'}`);
    L.push('');
  });

  for (const r of dropList) {
    L.push(`## ✂️ 被闸丢弃：\`${r.cardId ?? '?'}\``);
    L.push('');
    L.push(`- 原因：\`${r.dropReason}\``);
    L.push('- 处置：该卡**只列候选、不加任何建议**（方案 §1.7.5 第三档）');
    L.push('');
  }
  for (const r of failedList) {
    L.push(`## ❌ 本轮失败：${r.reason}`);
    L.push('');
  }

  // 「今天没事」必须可核（§6 判据 6）
  if (!okList.length) {
    L.push('## 读了哪几份产物（"今天没事"必须可核 · 方案 §6 判据 6）');
    L.push('');
    L.push('| 产物 | mtime | 备注 |');
    L.push('|---|---|---|');
    for (const a of artifacts) {
      const mt = a.exists ? a.mtime : '**不存在**';
      L.push(`| \`${a.name}\` | ${mt} | ${a.extra || ''} |`);
    }
    L.push('');
    L.push('> ⚠️ 任何一份 mtime 早于上一份晨报的时间 ⇒ 那份是旧的，不许当"一切正常"的证据。');
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('_本文件由 `tools\\dsh-butler\\steward-advice.mjs` 生成。乙层只写文字：不建卡、不发指令、不改卡状态、不写看板（方案 §1.7.7）。_');
  return L.join('\n') + '\n';
}

export function parallelImpactHuman(pi) {
  if (!pi) return '判不出';
  if (pi === '独占') return '**独占** —— 这件开工期间别的同时动不了';
  if (pi === '可并行') return '**可并行** —— 它只读/只出文档，和别的事不撞';
  if (pi === '判不出') return '**判不出** —— 甲层的近似判据没给出结论，**别当成"可以随便并行"**';
  if (pi.startsWith(PARALLEL_IMPACT_MUTEX_PREFIX)) return `**互斥** —— 它和「${pi.slice(PARALLEL_IMPACT_MUTEX_PREFIX.length)}」不能同时跑`;
  return pi;
}

// ================================================================ ⑦ 主流程

/**
 * 跑一轮乙层。
 *
 * @param {object} o
 * @param {boolean} [o.apply]        写盘（state + md）
 * @param {boolean} [o.dryRun]       只打印提示词，不写盘不调模型
 * @param {boolean} [o.forceLlm]     今天跑过也重调
 * @param {boolean} [o.offline]      绝不联网
 * @param {Function} [o.llm]         注入 `llmText`（夹具用）
 * @param {object}  [o.report]       注入甲层 report（夹具用；不给就 spawn 真甲层）
 */
export async function runCycle({
  apply = false, dryRun = false, forceLlm = false, offline = false,
  dsh = DSH, home = dshHome(), now = Date.now(),
  llm = null, report = null, ruleTableText = null, spawn = spawnSync,
} = {}) {
  const out = {
    ok: true, version: ADVICE_VERSION, dryRun, apply, offline,
    banner: null, bannerLevel: null,
    called: false, results: [], drops: 0,
    usage: null, costCny: 0,
    prompt: null, ruleList: null,
    spendBefore: null, spendAfter: null,
    artifacts: [], statePath: null, markdownPath: null,
    warnings: [],
    dsh,   // md 落点跟着它走（夹具注入临时目录 ⇒ 不许污染生产 docs\reports）
  };

  // ── 读 state
  const statePath = path.join(home, 'steward-state.json');
  let state = {};
  try { if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch (e) {
    out.warnings.push({ level: 'yellow', code: 'state-unreadable', message: `state 读不出来（${e.message}）—— 按空 state 处理，钱闸本月从 0 起算` });
  }
  const bud = budgetExceeded(state, now);
  out.spendBefore = { ym: bud.ym, cny: bud.cny, calls: bud.calls };

  // ── 甲层（干跑也要真跑一次：验收判据 2 要求"不含 excluded 任何字段"是对真产物说的）
  if (!report) {
    const r = runSteward({ dsh, spawn });
    if (!r.ok) {
      out.ok = false;
      out.banner = `🔴 今天没生成建议（甲层跑不出来：${r.reason}）`;
      out.bannerLevel = 'red';
      out.statePath = statePath;
      out.results = [{ status: 'failed', reason: `steward:${r.reason}` }];
      out.artifacts = artifactMtimes({ dsh, home, report: null });
      if (apply && !dryRun) await persist(out, { state, statePath, home, now, report: null, spend: null, extra: { status: 'steward-failed', reason: r.reason } });
      return out;
    }
    report = r.report;
    out.stewardBytes = r.bytes;
  }

  // ── 判决表
  let tableText = ruleTableText;
  if (tableText == null) {
    const tablePath = path.join(dsh, RULE_TABLE_REL);
    try { tableText = fs.readFileSync(tablePath, 'utf8'); } catch (e) {
      out.warnings.push({ level: 'yellow', code: 'rule-table-unreadable', message: `判决表读不出来（${e.message}）—— 清单为空，本轮只能出 suggest` });
      tableText = '';
    }
  }
  const parsed = parseRuleTable(tableText);
  out.warnings.push(...parsed.warnings);
  const ruleList = buildRuleList(parsed.rules);
  const ruleById = new Map(parsed.rules.map((r) => [r.idStr, r]));
  out.ruleList = { shown: ruleList.shown, total: ruleList.total, truncated: ruleList.truncated, chars: ruleList.chars };

  const prompt = buildPrompt({ report, ruleList });
  out.prompt = { system: prompt.system, user: prompt.user, chars: prompt.chars, estTokens: prompt.estTokens, truncatedCount: prompt.truncatedCount };
  out.artifacts = artifactMtimes({ dsh, home, report });

  // ── 干跑：到此为止（不写盘、不调模型）
  if (dryRun) {
    out.ok = true;
    out.banner = null;
    out.reportBrief = {
      ledgerRevision: report.ledgerRevision,
      raised: (report.raised || []).length,
      convergence: report.convergence || null,
      totals: report.totals || null,
    };
    return out;
  }

  const raisedIds = new Set((report.raised || []).map((x) => x.id));
  const colOf = (id) => collisionOf(report, id);

  // ── 空候选：零调用（§1.7.4）
  if (!raisedIds.size) {
    out.banner = null;
    out.results = [];
    out.spendAfter = out.spendBefore;
    if (apply) await persist(out, { state, statePath, home, now, report, spend: null, extra: { status: 'idle' } });
    return out;
  }

  // ── 预算闸（§1.7.4）
  if (bud.exceeded) {
    out.banner = `🔴 本月建议预算已用完（¥${bud.cny.toFixed(4)}/¥${MONTH_CAP_CNY.toFixed(2)}），今天只列候选`;
    out.bannerLevel = 'red';
    out.results = [];
    out.spendAfter = out.spendBefore;
    if (apply) await persist(out, { state, statePath, home, now, report, spend: null, extra: { status: 'budget-stop' } });
    out.budgetStop = true;
    return out;
  }

  // ── 今天已跑过：不重调（§1.7.4 幂等）
  //    ⚠️ 只认"真调过模型"的那些：`status==='ok'` 或 `runStatus==='ok'`（全被闸丢也算真调过）。
  //    `status==='failed'` 的运行记录**不挡重跑** —— 那是"没花到建议的钱"（如甲层跑不出来 / 模型未响应），
  //    留着当留痕，但不该让主人为了重试一句就得上 `--force-llm`。
  const today = advicesToday(state, now).filter((x) => x.status === 'ok' || x.runStatus === 'ok');
  if (today.length && !forceLlm) {
    out.banner = null;
    out.alreadyRan = true;
    out.results = today.map((a) => ({ ...a, status: a.status || 'ok' }));
    out.spendAfter = out.spendBefore;
    out.ok = true;
    return out;
  }

  // ── 调一次模型
  //    🔴 **不写盘就不许调模型**：钱一旦花出去就必须落到 `adviceSpend`，否则"日上限 1 次"和"月预算 ¥5"
  //       两道闸都只写在纸上 —— 不带 `--apply` 跑一遍就白花一次，还没账（2026-11-02 验收实测踩到）。
  if (!apply) {
    out.ok = true;
    out.needApply = true;
    out.banner = null;
    out.spendAfter = out.spendBefore;
    return out;
  }
  if (offline) {
    out.ok = false;
    out.banner = '🔴 今天没生成建议（--offline：本进程拒绝联网）';
    out.bannerLevel = 'red';
    out.results = [{ status: 'failed', reason: 'offline' }];
    out.spendAfter = out.spendBefore;
    if (apply) await persist(out, { state, statePath, home, now, report, spend: null, extra: { status: 'failed', reason: 'offline' } });
    return out;
  }

  const call = llm || (await import('../../llm-client.mjs')).llmText;
  out.called = true;
  let res;
  try {
    res = await call({ system: prompt.system, user: prompt.user, maxTokens: ADVICE_MAX_TOKENS });
  } catch (e) {
    res = { ok: false, reason: `throw:${e.message}` };
  }

  // ── 失败降级（§1.7.4）：退化成只列候选 + 首行标 reason，不许崩
  if (!res || !res.ok) {
    const reason = res?.reason || 'unknown';
    out.ok = false;
    out.banner = `🔴 今天没生成建议（模型未响应：${reason}）`;
    out.bannerLevel = 'red';
    out.results = [{ status: 'failed', reason }];
    out.spendAfter = out.spendBefore;
    if (apply) await persist(out, { state, statePath, home, now, report, spend: null, extra: { status: 'failed', reason } });
    return out;
  }

  out.usage = res.usage || null;
  out.model = res.model || null;
  out.costCny = costCny(out.usage);
  out.rawText = res.text;

  const parsedAdvice = parseAdviceJSON(res.text);
  if (!parsedAdvice.ok) {
    out.ok = false;
    out.banner = `🔴 今天没生成建议（模型回了但解析不了：${parsedAdvice.reason}）`;
    out.bannerLevel = 'red';
    out.results = [{ status: 'failed', reason: `parse:${parsedAdvice.reason}` }];
    out.spendAfter = out.spendBefore;
    if (apply) await persist(out, { state, statePath, home, now, report, spend: { ym: ymOf(now), calls: 1, cny: out.costCny }, extra: { status: 'failed', reason: `parse:${parsedAdvice.reason}` } });
    return out;
  }

  // ── 逐条过三道闸
  const ctx = { raisedIds, ruleById, collisionOf: colOf };
  const results = [];
  for (const a of parsedAdvice.advices) {
    const g = gateAdvice(a, ctx);
    results.push({
      ...g,
      at: new Date(now).toISOString(),
      model: out.model,
      usage: out.usage,
      cny: g.ok ? out.costCny / Math.max(1, parsedAdvice.advices.length) : 0,   // 单条按条数摊（总量仍记在 spend 里，不重复计）
    });
  }
  out.results = results;
  out.drops = results.filter((r) => r.status === 'dropped').length;
  const okCount = results.filter((r) => r.status === 'ok').length;

  if (!okCount) {
    out.ok = false;
    const reasons = [...new Set(results.map((r) => r.dropReason).filter(Boolean))].join(',');
    out.banner = `🔴 今天没生成建议（模型回了但三道闸全挡：${reasons || 'unknown'}）`;
    out.bannerLevel = 'red';
  } else if (out.drops) {
    out.warnings.push({ level: 'yellow', code: 'advice-dropped', message: `${out.drops} 条建议被闸丢弃（见 md）` });
  }

  if (apply) {
    await persist(out, {
      state, statePath, home, now, report,
      spend: { ym: ymOf(now), calls: 1, cny: out.costCny },
      extra: { status: 'ok' },
    });
  }
  return out;
}

/** 写 state + md（走 writeTextAtomic）。 */
async function persist(out, { state, statePath, home, now, report, spend, extra = {} }) {
  const date = ymd(now);
  const records = [];
  // ① 每条 advice（含 dropped：丢掉的也要留痕，否则"为什么今天少一条"查不到）
  for (const r of out.results || []) {
    records.push({
      id: sha16(`${date}|${r.cardId ?? '__run__'}`),
      at: r.at || new Date(now).toISOString(),
      cardId: r.cardId ?? null,
      verdict: r.verdict ?? null,
      citedRuleId: r.citedRuleId ?? null,
      citedRuleText: r.citedRuleText ?? '',
      citedRuleRef: r.citedRuleRef ?? '',
      unverifiable: Boolean(r.unverifiable),
      parallelImpact: r.parallelImpact ?? null,
      model: r.model ?? out.model ?? null,
      usage: r.usage ?? out.usage ?? null,
      cny: Number(r.cny ?? 0),
      status: r.status,
      dropReason: r.dropReason ?? null,
      runStatus: extra.status ?? null,
      runReason: extra.reason ?? null,
    });
  }
  // ② 失败 / 空跑的运行记录（也要能回答"今天到底跑没跑"）
  if (!records.length && extra.status) {
    records.push({
      id: sha16(`${date}|__run__`), at: new Date(now).toISOString(), cardId: null,
      verdict: null, citedRuleId: null, citedRuleText: '', citedRuleRef: '', unverifiable: false,
      parallelImpact: null, model: out.model ?? null, usage: out.usage ?? null,
      cny: Number(out.costCny || 0), status: extra.status === 'ok' ? 'ok' : 'failed',
      dropReason: extra.reason ?? null, runStatus: extra.status, runReason: extra.reason ?? null,
    });
  }

  // ③ 合并 + 落盘 —— 🔴 锁只包住「读-改-写」这一段。
  //    **不许**在 spawn 甲层之前拿锁：`steward.mjs` L1853 自己也拿同一把 `steward` 锁，
  //    先拿就会把甲层卡死（2026-11-02 真跑踩到：rc=2「甲层 report 缺 raised[]」，真因是锁撞车，
  //    不是形状变了 —— dry-run 不拿锁就正常，这个对照就是证据）。
  //    ⚠️ 锁内**重读** state：runCycle 开头读的那份可能已被甲层那一轮覆盖。
  const lock = acquireTickLock('steward', { ttlMs: 600_000, home });
  try {
    let base = state;
    try {
      if (fs.existsSync(statePath)) base = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
    } catch { /* 重读失败就用 runCycle 开头读的那份（已在 out.warnings 里登记过） */ }

    const merged = mergeAdviceState(base, { advices: records, spend, now });
    // 顺带把六必填头字段保住（甲层写的那份有；乙层只补不改）
    const next = { ...base, ...merged.state };
    if (!next.schemaVersion) next.schemaVersion = 1;

    writeTextAtomic(statePath, JSON.stringify(next, null, 2) + '\n', { retryDelaysMs: [50, 150, 400] });
    out.statePath = statePath;

    const cnyMonth = Number(next.adviceSpend?.cny || 0);
    const callsMonth = Number(next.adviceSpend?.calls || 0);
    out.spendAfter = { ym: next.adviceSpend?.ym, cny: cnyMonth, calls: callsMonth };

    // ④ 人读 md
    //    ⚠️ 落点必须跟着**注入的 `dsh`** 走，不许硬编码生产根：夹具里 dsh=临时目录，
    //    否则夹具跑一次就把假报告写进真的 `docs\reports\`（2026-11-02 本卡自测踩到并修）。
    const md = renderAdviceMarkdown({
      now, host: hostName(), report, results: out.results || [],
      banner: out.banner, spend: { cnyThis: out.costCny, cnyMonth, callsMonth },
      artifacts: out.artifacts || [],
    });
    const dir = path.join(out.dsh || DSH, REPORT_DIR_REL);
    const file = path.join(dir, `steward-${date}-${hostName()}.md`);
    writeTextAtomic(file, md, { retryDelaysMs: [50, 150, 400] });
    out.markdownPath = file;
    return out;
  } finally {
    if (lock && typeof lock.release === 'function') { try { lock.release(); } catch { /* 释放失败不影响结果 */ } }
  }
}

// ================================================================ ⑧ 夹具（14 条 · 全部注入假 llmText）

async function selftest() {
  // 夹具在同一进程里反复 `acquireTickLock`（lib/store 每次注册一个 exit 钩子）⇒ 会撞 Node 的
  // MaxListeners=10 警告。那只是**夹具**的形态（生产一轮只拿一次锁），放开上限即可，不动生产逻辑。
  if (typeof process.setMaxListeners === 'function') process.setMaxListeners(0);
  const T = [];
  const ok = (name, fn) => { T.push({ name, fn }); };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  const NOW = Date.parse('2026-11-02T08:30:00+08:00');
  const TMP = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'steward-advice-fixture-'));
  // 🔴 夹具的 md 落点必须跟着**临时 dsh** 走：否则跑一次夹具就往生产 docs\reports\ 写一份假报告
  //    （2026-11-02 本卡自测真踩到，已修）。
  const FIX_DSH = path.join(TMP, 'dsh');
  fs.mkdirSync(FIX_DSH, { recursive: true });
  const R = (o = {}) => runCycle({ dsh: FIX_DSH, ...o });

  const mkCard = (id, extra = {}) => ({
    id, title: `卡${id}`, line: 'L1', status: 'todo', ageDays: 5, recoverable: true, hasCardText: true, unlockValue: 'unknown',
    rationale: '①不是 failed · ②躺了 5 天', ...extra,
  });
  const mkReport = ({ raised = null, collision = null, cardText = null } = {}) => {
    const r = raised ?? [mkCard('c-001'), mkCard('c-002'), mkCard('c-003')];
    return {
      generatedAt: new Date(NOW).toISOString(), host: 'TESTHOST', ledgerRevision: 4242,
      totals: { live: 20, running: 2, waiting: 15, failed: 1, lines: 6 },
      lines: [{ line: 'L1', cards: 5, running: 1, failed: 0, pending: 2, oldestAgeDays: 19 }],
      top: r[0], raised: r,
      allPending: r,
      convergence: { total: 11, crossLine: 3, raised: 3, backlog: 8, status: 'red' },
      stale: { cross: [{ cardId: 'x-1', title: '超期张', line: 'L2', ageDays: 12 }], ageDays: 3 },
      failed: [{ cardId: 'f-1', title: '失败张', line: 'L3', ageDays: 5 }],
      excluded: { selfCards: ['s-1', 's-2'], selfCapability: 3, deadStatus: 7, note: '🔴 本线自举排除项 —— 绝不喂给模型' },
      capability: { ok: true, fresh: true, status: 'ok', ageDays: 1, mtimeIso: new Date(NOW).toISOString(),
        items: [{ from: 'A', to: '主人', what: 'W', status: 'waiting', since: '2026-10-29', card: '31cc424e', unlockWhen: '主人给窗口' }] },
      collision: {
        ok: true, hitRate: 0.1, hitCount: 1, judgedCount: 10, items:
          collision ?? [
            { cardId: 'c-001', verdict: '独占', guessed: true, evidence: '命中「重启 dsh」', rivals: [] },
            { cardId: 'c-002', verdict: '互斥', guessed: true, evidence: '同前缀 tools\\dsh-butler', rivals: [{ cardId: 'c-001', title: '卡c-001' }] },
            { cardId: 'c-003', verdict: '待人工判', guessed: true, evidence: '判不出', rivals: [] },
          ],
      },
      cardText: cardText ?? {
        'c-001': { title: '卡c-001', desc400: '这张卡的说明：要重启 dsh 才能生效' },
        'c-002': { title: '卡c-002', desc400: '这张卡的说明：改 tools\\dsh-butler 下的脚本' },
        'c-003': { title: '卡c-003', desc400: '这张卡的说明：只读查证' },
      },
      warnings: [{ level: 'yellow', code: 'w1', message: '示例警告' }],
      unlockValue: {}, unlockValueWhy: {}, sessions: { ok: true, items: [{ id: 'SECRET-SESSION-CONTENT' }] },
    };
  };

  const RULE_TABLE = [
    '## 一、已核判据（24 条）',
    '',
    '### A. 授权与边界：什么事该自己拍',
    '',
    '#### 1. 能自己拍的自己拍，攒成清单就是债',
    '',
    '**判据**：授权范围内的事当场做掉，不要攒成"待拍板清单"。',
    '',
    '#### 2. 拍板用四把尺子量，不是用"我怕"',
    '',
    '**判据**：拿不准要不要请示时，量四个维度 —— 风险 / 结果影响 / 可恢复性 / 可改性。',
    '',
    '### B. 交付与质量',
    '',
    '#### 3. 别偷懒选省事方案',
    '',
    '**判据**：省事方案省的是今天，欠的是明天。',
    '',
    '## 二、候选（未核 · 不许当依据用）',
    '',
    '### C1. 懂就停：解释完就收手',
    '',
    '**判据**：这是候选段，绝不许进清单。',
    '',
    '### C. 事实与证据',
    '',
    '### C2. 他的"没回"不是"同意"',
    '',
    '**判据**：候选段第二条。',
    '',
  ].join('\n');

  const rulesFrom = (t) => parseRuleTable(t).rules;
  const mkLlm = (payload, counter = { n: 0 }) => async () => {
    counter.n++;
    return typeof payload === 'function' ? payload() : payload;
  };
  const okLlm = (text, usage = { promptTokens: 4000, completionTokens: 900, totalTokens: 4900 }) =>
    ({ ok: true, text, model: 'deepseek-v4-flash', usage, finishReason: 'stop' });
  const adviceJSON = (arr) => '```json\n' + JSON.stringify({ advices: arr }, null, 1) + '\n```';

  // —— 夹具 1：正常 3 条全过、写 state（advices[] + adviceSpend）、写 md
  ok('1. 正常返回 3 条 ⇒ 三闸全过 · 写 advices[]+adviceSpend · 写 md', async () => {
    const home = path.join(TMP, 'h1'); fs.mkdirSync(home, { recursive: true });
    const report = mkReport();
    const text = adviceJSON([
      { cardId: 'c-001', background: '背景1', options: [{ label: 'A', effect: 'e', cost: 'c' }, { label: 'B', effect: 'e2', cost: 'c2' }], recommend: 'A', why: '理由1', citedRuleId: '判决表v1.0#R1', parallelImpact: '独占', verdict: 'decide' },
      { cardId: 'c-002', background: '背景2', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: '理由2', citedRuleId: null, parallelImpact: '互斥：卡c-001', verdict: 'suggest' },
      { cardId: 'c-003', background: '背景3', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: '理由3', citedRuleId: null, parallelImpact: '判不出', verdict: 'suggest' },
    ]);
    const r = await R({ apply: true, home, now: NOW, report, ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text)) });
    assert(r.results.filter((x) => x.status === 'ok').length === 3, `应有 3 条全过，实际 ${r.results.map((x) => x.status).join(',')}`);
    const st = JSON.parse(fs.readFileSync(path.join(home, 'steward-state.json'), 'utf8'));
    assert(Array.isArray(st.advices) && st.advices.length === 3, 'advices[] 应有 3 条');
    assert(st.adviceSpend && st.adviceSpend.calls === 1 && st.adviceSpend.cny > 0, 'adviceSpend 应记 1 次 + 正数成本');
    assert(st.advices.every((a) => typeof a.id === 'string' && a.id.length === 16), 'advice 幂等 id 应为 sha16');
    assert(st.advices.find((a) => a.cardId === 'c-001').verdict === 'decide', 'c-001 应为 decide');
    assert(/docs\/[^:]+:\d+/.test(st.advices.find((a) => a.cardId === 'c-001').citedRuleRef), 'citedRuleRef 应带 档:行');
    assert(r.markdownPath && fs.existsSync(r.markdownPath), 'md 应落盘');
    const md = fs.readFileSync(r.markdownPath, 'utf8');
    assert(md.includes('背景1') && md.includes('并行影响'), 'md 应含四段');
  });

  // —— 夹具 2：cardId 不在 raised ⇒ 丢弃
  ok('2. cardId 不在 raised 里 ⇒ 该条丢弃 · status=dropped', async () => {
    const home = path.join(TMP, 'h2'); fs.mkdirSync(home, { recursive: true });
    const text = adviceJSON([
      { cardId: 'c-999', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: null, parallelImpact: '判不出', verdict: 'suggest' },
    ]);
    const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text)) });
    assert(r.results[0].status === 'dropped' && r.results[0].dropReason === 'card-not-raised', `应 card-not-raised，实际 ${r.results[0].dropReason}`);
    const st = JSON.parse(fs.readFileSync(path.join(home, 'steward-state.json'), 'utf8'));
    assert(st.advices[0].status === 'dropped', 'state 里也应记 dropped（留痕）');
  });

  // —— 夹具 3：decide 但 citedRuleId=null ⇒ 丢弃
  ok('3. verdict=decide 但 citedRuleId=null ⇒ 丢弃', async () => {
    const home = path.join(TMP, 'h3'); fs.mkdirSync(home, { recursive: true });
    const text = adviceJSON([
      { cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: null, parallelImpact: '独占', verdict: 'decide' },
    ]);
    const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text)) });
    assert(r.results[0].dropReason === 'decide-without-rule', `应 decide-without-rule，实际 ${r.results[0].dropReason}`);
  });

  // —— 夹具 4：citedRuleId 不存在 ⇒ 降级 suggest + citedRuleText 空 + unverifiable
  ok('4. citedRuleId=判决表v1.0#R999（不存在）⇒ 降级 suggest · citedRuleText 空 · unverifiable', async () => {
    const home = path.join(TMP, 'h4'); fs.mkdirSync(home, { recursive: true });
    const text = adviceJSON([
      { cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: '判决表v1.0#R999', parallelImpact: '独占', verdict: 'decide' },
    ]);
    const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text)) });
    const x = r.results[0];
    assert(x.status === 'ok', `应保留但降级，实际 ${x.status}/${x.dropReason}`);
    assert(x.verdict === 'suggest', `应降级 suggest，实际 ${x.verdict}`);
    assert(x.citedRuleText === '', 'citedRuleText 必须为空（不许模型转述）');
    assert(x.unverifiable === true, '应标 unverifiable');
  });

  // —— 夹具 5：suggest 但正文写「我拍了」⇒ 丢弃
  ok('5. verdict=suggest 但正文写「我拍了」⇒ 丢弃', async () => {
    const home = path.join(TMP, 'h5'); fs.mkdirSync(home, { recursive: true });
    const text = adviceJSON([
      { cardId: 'c-001', background: '我拍了：就这样办', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: null, parallelImpact: '独占', verdict: 'suggest' },
    ]);
    const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text)) });
    assert(r.results[0].dropReason === 'declarative-without-rule', `应 declarative-without-rule，实际 ${r.results[0].dropReason}`);
  });

  // —— 夹具 6：parallelImpact 空 ⇒ 丢弃（另测：编造值 / 与甲层不一致也丢）
  ok('6. parallelImpact 空 ⇒ 丢弃（编造值 / 与甲层撞车裁决不一致同样丢）', async () => {
    const home = path.join(TMP, 'h6'); fs.mkdirSync(home, { recursive: true });
    const mk = (pi) => adviceJSON([{ cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: null, parallelImpact: pi, verdict: 'suggest' }]);
    let r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(mk(''))), forceLlm: true });
    assert(r.results[0].dropReason === 'parallel-impact-empty', `空应 parallel-impact-empty，实际 ${r.results[0].dropReason}`);
    r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(mk('大概能并行吧'))), forceLlm: true });
    assert(r.results[0].dropReason === 'parallel-impact-out-of-vocab', `编造值应 out-of-vocab，实际 ${r.results[0].dropReason}`);
    r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(mk('判不出'))), forceLlm: true });
    assert(r.results[0].dropReason === 'parallel-impact-mismatch', `甲层说独占而模型写判不出，应 mismatch，实际 ${r.results[0].dropReason}`);
  });

  // —— 夹具 7：llmText 失败 ⇒ 退化 + 晨报首行标 reason，不许崩
  ok('7. llmText 返回 {ok:false,reason:"timeout"} ⇒ 退化成只列候选 + 首行标 reason', async () => {
    const home = path.join(TMP, 'h7'); fs.mkdirSync(home, { recursive: true });
    const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm({ ok: false, reason: 'timeout' }) });
    assert(r.ok === false, 'ok 应为 false');
    assert(r.banner.includes('今天没生成建议') && r.banner.includes('timeout'), `首行应含 reason，实际 ${r.banner}`);
    assert(r.results[0].status === 'failed', 'results 应记 failed');
    const md = fs.readFileSync(r.markdownPath, 'utf8');
    const line3 = md.split('\n').filter((l) => l.startsWith('> '))[0] || '';
    assert(line3.includes('timeout'), `md 首行/次行应标 reason，实际 ${line3}`);
    const st = JSON.parse(fs.readFileSync(path.join(home, 'steward-state.json'), 'utf8'));
    assert(st.advices.length === 1 && st.advices[0].status === 'failed', 'state 应记一条 failed 运行记录');
  });

  // —— 夹具 8：raised=[] ⇒ 零调用 + "今天没事"带产物 mtime 列表
  ok('8. raised=[] ⇒ 零调用（假 llmText 调用次数=0）· "今天没事"必须带产物 mtime 列表', async () => {
    const home = path.join(TMP, 'h8'); fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(home, 'task-board'), { recursive: true });
    fs.writeFileSync(path.join(home, 'task-board', 'ledger-v2.json'), '{"revision":4242}', 'utf8');
    const counter = { n: 0 };
    const r = await R({ apply: true, home, now: NOW, report: mkReport({ raised: [], collision: [] }), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm('{}'), counter) });
    assert(counter.n === 0, `零调用断言失败：调了 ${counter.n} 次`);
    assert(r.called === false, 'called 应为 false');
    assert(Array.isArray(r.artifacts) && r.artifacts.length >= 3, `产物 mtime 列表应有 ≥3 行，实际 ${r.artifacts?.length}`);
    assert(r.artifacts.some((a) => a.name.includes('capability.json')), '应列 capability.json');
    assert(r.artifacts.some((a) => a.name.includes('协调线.json')), '应列 协调线.json');
    assert(r.artifacts.some((a) => a.name.includes('看板账本')), '应列看板账本 revision');
    const md = fs.readFileSync(r.markdownPath, 'utf8');
    assert(md.includes('读了哪几份产物') && md.includes('capability.json') && md.includes('协调线.json'), 'md 必须列产物 + mtime（否则是假绿）');
  });

  // —— 夹具 9：同一天跑两遍不重调；--force-llm 才重调
  ok('9. 同一天跑两遍 ⇒ 第二遍不重调（调用 1 次）· --force-llm 才 2 次', async () => {
    const home = path.join(TMP, 'h9'); fs.mkdirSync(home, { recursive: true });
    const counter = { n: 0 };
    const text = adviceJSON([
      { cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: '判决表v1.0#R1', parallelImpact: '独占', verdict: 'decide' },
    ]);
    const llm = mkLlm(okLlm(text), counter);
    await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm });
    assert(counter.n === 1, `第一遍应调 1 次，实际 ${counter.n}`);
    const r2 = await R({ apply: true, home, now: NOW + 3600_000, report: mkReport(), ruleTableText: RULE_TABLE, llm });
    assert(counter.n === 1, `同一天第二遍不该重调，实际 ${counter.n}`);
    assert(r2.alreadyRan === true, '第二遍应标 alreadyRan');
    await R({ apply: true, home, now: NOW + 3600_000, report: mkReport(), ruleTableText: RULE_TABLE, llm, forceLlm: true });
    assert(counter.n === 2, `--force-llm 应重调（共 2 次），实际 ${counter.n}`);
  });

  // —— 夹具 10：月预算超 ¥5 ⇒ 自动停 + 首行标红
  ok('10. 月预算超 ¥5 ⇒ 不调模型 · 首行标红', async () => {
    const home = path.join(TMP, 'h10'); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'steward-state.json'), JSON.stringify({
      schemaVersion: 1, adviceSpend: { ym: ymOf(NOW), calls: 9, cny: 5.5 },
    }, null, 2), 'utf8');
    const counter = { n: 0 };
    const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm('{}'), counter) });
    assert(counter.n === 0, `预算超闸不该调模型，实际调了 ${counter.n} 次`);
    assert(r.budgetStop === true, '应标 budgetStop');
    assert(r.banner.includes('本月建议预算已用完') && r.banner.startsWith('🔴'), `首行应标红，实际 ${r.banner}`);
    const md = fs.readFileSync(r.markdownPath, 'utf8');
    assert(md.split('\n').slice(0, 5).join('\n').includes('本月建议预算已用完'), 'md 首行/前几行应标预算满');
  });

  // —— 夹具 11：判决表解析 —— 候选段绝不进清单
  ok('11. 判决表解析：含「## 二、候选」的样本 ⇒ 清单里没有 C1~C4、只有已核条', async () => {
    const parsed = parseRuleTable(RULE_TABLE);
    const ids = parsed.rules.map((x) => x.idStr);
    assert(parsed.rules.length === 3, `应只解析出 3 条已核，实际 ${parsed.rules.length}（${ids.join(',')}）`);
    assert(!parsed.rules.some((r) => /^C\d/.test(r.idStr)), '候选段条目混进来了');
    assert(!ids.some((i) => i.includes('C1')), `清单里出现了 C1：${ids.join(',')}`);
    assert(ids[0] === '判决表v1.0#R1' && ids[2] === '判决表v1.0#R3', `id 形态应为 判决表v1.0#R<N>，实际 ${ids.join(',')}`);
    const r1 = parsed.rules[0];
    assert(r1.ruleText.includes('当场做掉'), '应取到 **判据**： 原文');
    assert(r1.ruleLine === 7, `ruleLine 应锚到「**判据**：」所在行（7），实际 ${r1.ruleLine}`);
    // 边界：换个标题写法也不许崩、不许把候选吃进来
    const weird = RULE_TABLE.replace('#### 2. 拍板用四把尺子量，不是用"我怕"', '#### 2. 拍板用四把尺子量');
    assert(parseRuleTable(weird).rules.length === 3, '标题变了也不该崩');
    assert(parseRuleTable('').rules.length === 0, '空输入应给空清单、不崩');
  });

  // —— 夹具 12（B2 必过）：写过一次后跑一遍 mergeState（模拟次日 08:20）⇒ 两段仍在、值不变
  ok('12. 🔴 B2 必过：写 advices/adviceSpend → 跑 mergeState（模拟次日 08:20）→ 两段仍在且值不变', async () => {
    const home = path.join(TMP, 'h12'); fs.mkdirSync(home, { recursive: true });
    const text = adviceJSON([
      { cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: '判决表v1.0#R1', parallelImpact: '独占', verdict: 'decide' },
    ]);
    await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text)) });
    let st = JSON.parse(fs.readFileSync(path.join(home, 'steward-state.json'), 'utf8'));
    const before = JSON.parse(JSON.stringify({ advices: st.advices, adviceSpend: st.adviceSpend }));
    assert(before.advices.length === 1 && before.adviceSpend.calls === 1, '前置：应已写入 1 条 + 1 次');

    // 模拟次日 08:20：甲层 mergeState（真函数，不是仿写）
    const { mergeState } = await import('./steward.mjs');
    const nextDay = NOW + 86400_000;
    const m = mergeState(st, mkReport(), { now: nextDay, topN: 3 });
    const after = m.state;
    assert(Array.isArray(after.advices), `🔴 B2：mergeState 后 advices 没了（${typeof after.advices}）—— 次日会被静默抹掉`);
    assert(after.advices.length === before.advices.length, `B2：advices 条数变少 ${before.advices.length} → ${after.advices.length}`);
    assert(JSON.stringify(after.advices) === JSON.stringify(before.advices), 'B2：advices 值被改写');
    assert(after.adviceSpend && after.adviceSpend.ym === before.adviceSpend.ym, 'B2：adviceSpend 段没了/被改');
    assert(after.adviceSpend.cny === before.adviceSpend.cny && after.adviceSpend.calls === before.adviceSpend.calls,
      `B2：钱闸值被改 ${JSON.stringify(before.adviceSpend)} → ${JSON.stringify(after.adviceSpend)}`);
    // 同时确认甲层的既有段还在（没有把整段改成通用 spread 而把别的弄丢）
    assert(Array.isArray(after.decisions) && Array.isArray(after.instructions), '甲层既有段被破坏');
  });

  // —— 夹具 13：段名独立性（B3）
  ok('13. 段名独立性（B3）：只写 advices 时 adviceSpend 不破；只更新 adviceSpend 时 advices 不丢', async () => {
    let st = {};
    let r = mergeAdviceState(st, { advices: [{ cardId: 'c-001', at: new Date(NOW).toISOString(), status: 'ok' }], spend: { ym: ymOf(NOW), calls: 1, cny: 0.01 }, now: NOW });
    st = r.state;
    assert(st.advices.length === 1 && st.adviceSpend.calls === 1, '首写应两段都在');
    // 只写 advices（spend 传 null）
    r = mergeAdviceState(st, { advices: [{ cardId: 'c-002', at: new Date(NOW).toISOString(), status: 'ok' }], spend: null, now: NOW });
    st = r.state;
    assert(st.advices.length === 2, 'advices 应累加到 2 条');
    assert(st.adviceSpend && st.adviceSpend.ym === ymOf(NOW) && st.adviceSpend.calls === 1, '只写 advices 不该破坏 adviceSpend');
    // 只更新 adviceSpend（advices 传空）
    r = mergeAdviceState(st, { advices: [], spend: { ym: ymOf(NOW), calls: 1, cny: 0.02 }, now: NOW });
    st = r.state;
    assert(st.advices.length === 2, '只更新 spend 不该丢 advices 条目');
    assert(Math.abs(st.adviceSpend.cny - 0.03) < 1e-9, `spend 应累加到 0.03，实际 ${st.adviceSpend.cny}`);
    // 幂等：同 id 二次写入 = no-op
    const one = { cardId: 'c-001', at: new Date(NOW).toISOString(), status: 'ok' };
    const dup = mergeAdviceState(st, { advices: [one], spend: null, now: NOW });
    assert(dup.state.advices.length === 2 && dup.added === 0, '同 id 二次写入应 no-op');
    // 跨月：新月 calls/cny 从 0 起算
    const nextMonth = Date.parse('2026-12-02T08:30:00+08:00');
    const nm = mergeAdviceState(st, { advices: [], spend: { ym: ymOf(nextMonth), calls: 1, cny: 0.05 }, now: nextMonth });
    assert(nm.state.adviceSpend.ym === ymOf(nextMonth) && nm.state.adviceSpend.calls === 1, '新月应重置计数');
  });

  // —— 夹具 14：清单截断 —— 规矩多到撑爆 2.6K ⇒ 只含 id+标题、均摊、头写已截断
  ok('14. 清单截断：规矩撑爆 2.6K ⇒ 只含 id+标题 · ≤2.6K 字符 · 头写「已截断」· 按类均摊', async () => {
    // ⚠️ 实测校准：24 条真规矩（id+标题 ≤40 字）只占 ~1K 字符，**碰不到 2.6K 预算** ⇒
    //    要触发档 ② 必须把条数放大到远超现实规模（这里 120 条）。
    const many = [];
    for (let i = 1; i <= 120; i++) {
      many.push({ id: i, idStr: `${RULE_ID_PREFIX}${i}`, title: `第${i}条标题` + '很长的标题'.repeat(8), cls: 'ABCDE'[i % 5], lineNo: i, ruleText: '这是判据全文，绝不许出现在清单里'.repeat(5), ruleLine: 100 + i });
    }
    const rl = buildRuleList(many);
    assert(rl.truncated === true, `120 条应超预算并标 truncated，实际 chars=${rl.chars}`);
    assert(rl.chars <= RULE_LIST_CHAR_BUDGET + 200, `清单字符数应 ≤2.6K（+头部余量），实际 ${rl.chars}`);
    assert(rl.text.includes('清单已截断'), `清单头应写「已截断」，实际首行 ${rl.text.split('\n')[0]}`);
    assert(!rl.text.includes('绝不许出现在清单里'), '🔴 清单里不许有「判据」全文');
    const bodyLines = rl.text.split('\n').slice(1).filter(Boolean);
    assert(bodyLines.every((l) => l.length <= 2 + 15 + 1 + RULE_TITLE_MAX + 2), `每行应只有 id+标题（标题截到 ${RULE_TITLE_MAX} 字），最长行 ${Math.max(...bodyLines.map((l) => l.length))}`);
    assert(rl.shown < 120 && rl.total === 120, `应只给 N/120，实际 ${rl.shown}/${rl.total}`);
    // 均摊：A→E 五类都得有（不是"从头切一刀"把后面几类全砍掉）
    const shownCls = new Set(bodyLines.map((l) => {
      const m = /#R(\d+)/.exec(String(l));
      return m ? many.find((x) => x.id === Number(m[1]))?.cls : null;
    }).filter(Boolean));
    assert(shownCls.size === 5, `均摊应覆盖 A→E 五类，实际只覆盖 ${[...shownCls].join('')}`);
    // 小清单不截断（现实规模就是这个）
    const small = buildRuleList(many.slice(0, 24));
    assert(small.truncated === false && small.shown === 24, `24 条不该截断，实际 truncated=${small.truncated}`);
  });

  // —— 附：白名单自检（§1.7.1 不喂 excluded / sessions）+ dry-run 不含 excluded
  ok('15. 白名单：payload 里绝无 excluded / sessions 字段（干跑同款断言）', async () => {
    const report = mkReport();
    const { payload } = buildWhitelistPayload(report);
    assert(!('excluded' in payload), '🔴 payload 里出现了 excluded');
    assert(!('sessions' in payload), '🔴 payload 里出现了 sessions');
    assert(JSON.stringify(payload).indexOf('SECRET-SESSION-CONTENT') < 0, '🔴 会话内容漏进来了');
    assert(Array.isArray(payload.staleCross) && payload.staleCross.length === 1, 'stale.cross 应取到 1 条');
    assert(payload.lines[0] && Object.keys(payload.lines[0]).sort().join(',') === 'cards,failed,line,oldestAgeDays,pending,running', `lines 应只留六字段，实际 ${Object.keys(payload.lines[0]).join(',')}`);
    assert(payload.capabilityItems[0].unlockWhen === '主人给窗口', 'capability 必须带 unlockWhen');
    assert(payload.collision.length === 3 && payload.cardText['c-001'], 'collision / cardText 应随 raised 一起喂');
    assert(payload.top && !Array.isArray(payload.top), 'top 必须是单个对象');
    // 截断：预算压到极小 ⇒ 必须报截断
    const tiny = buildWhitelistPayload(report, { tokenBudget: 100 });
    assert(tiny.truncatedCount > 0, '超预算应报截断条数');
  });

  // —— 附：--offline 断言（验收判据 1：零真实网络调用）
  ok('16. --offline ⇒ 拒绝联网（fetch 打了桩也不许被碰）· 降级不崩', async () => {
    const home = path.join(TMP, 'h16'); fs.mkdirSync(home, { recursive: true });
    const realFetch = globalThis.fetch;
    let touched = 0;
    globalThis.fetch = () => { touched++; throw new Error('夹具：不该联网'); };
    try {
      const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, offline: true });
      assert(touched === 0, `--offline 竟然碰了 fetch ${touched} 次`);
      assert(r.called === false, '--offline 不该标 called');
      assert(r.banner.includes('--offline'), `应标 offline，实际 ${r.banner}`);
      const st = JSON.parse(fs.readFileSync(path.join(home, 'steward-state.json'), 'utf8'));
      assert(st.advices.length === 1 && st.advices[0].status === 'failed', '应记一条 failed 运行记录');
    } finally { globalThis.fetch = realFetch; }
  });

  // —— 附：失败记录不该挡重跑（"防重复花钱" ≠ "挡住重试"）
  ok('17. 今天已有 failed 运行记录 ⇒ 仍允许重调（失败没花到建议的钱，不该逼人上 --force-llm）', async () => {
    const home = path.join(TMP, 'h17'); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'steward-state.json'), JSON.stringify({
      schemaVersion: 1,
      advices: [{ id: 'x', at: new Date(NOW).toISOString(), cardId: null, status: 'failed', runStatus: 'failed', runReason: 'steward:锁撞车' }],
      adviceSpend: { ym: ymOf(NOW), calls: 0, cny: 0 },
    }, null, 2), 'utf8');
    const counter = { n: 0 };
    const text = adviceJSON([{ cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: '判决表v1.0#R1', parallelImpact: '独占', verdict: 'decide' }]);
    const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text), counter) });
    assert(counter.n === 1, `失败记录不该挡重跑，实际调用 ${counter.n} 次`);
    assert(r.alreadyRan !== true, '不该标 alreadyRan');
    const st = JSON.parse(fs.readFileSync(path.join(home, 'steward-state.json'), 'utf8'));
    assert(st.advices.length === 2, `旧失败记录应留痕 + 新记录，实际 ${st.advices.length} 条`);
    // 反向：今天已有 ok 记录 ⇒ 挡（夹具 9 已覆盖，这里只确认 failed 与 ok 的判别是分开的）
    const r2 = await R({ apply: true, home, now: NOW + 60_000, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text), counter) });
    assert(counter.n === 1 && r2.alreadyRan === true, '有 ok 记录后应挡住重跑');
  });

  // —— 附：夹具绝不污染生产目录（本卡自测真踩过：md 硬编码 DSH 根 ⇒ 假报告写进真reports）
  ok('18. 夹具不污染生产：md 落在注入的临时 dsh 下 · 生产 docs\\reports 一个文件都不许多', async () => {
    const prodDir = path.join(DSH, 'docs', 'reports');
    const count = () => (fs.existsSync(prodDir) ? fs.readdirSync(prodDir).filter((f) => f.startsWith('steward-')).length : 0);
    const before = count();
    const home = path.join(TMP, 'h18'); fs.mkdirSync(home, { recursive: true });
    const text = adviceJSON([{ cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: '判决表v1.0#R1', parallelImpact: '独占', verdict: 'decide' }]);
    const r = await R({ apply: true, home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text)) });
    assert(r.markdownPath && r.markdownPath.startsWith(FIX_DSH), `md 应落在注入的 dsh 下，实际 ${r.markdownPath}`);
    assert(fs.existsSync(r.markdownPath), 'md 应真落盘（落在临时目录里）');
    assert(count() === before, `🔴 夹具往生产 docs\\reports 写文件了：${before} → ${count()}`);
  });

  // —— 🔴 时区边界：`at` 存 UTC ISO，日期键用本地日期 ⇒ 本地凌晨（UTC 还是前一天）必须仍判"同一天"
  ok('19. 时区边界：本地 03:00（UTC 还是前一天）⇒ 同一天第二遍仍不重调', async () => {
    // 2026-11-02T03:00+08:00 = UTC 2026-11-01T19:00Z ⇒ **字符串前缀比对会判成"昨天"**（本卡验收时真踩到）
    const NOW_EARLY = Date.parse('2026-11-02T03:00:00+08:00');
    const home = path.join(TMP, 'h19'); fs.mkdirSync(home, { recursive: true });
    const counter = { n: 0 };
    const text = adviceJSON([{ cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: '判决表v1.0#R1', parallelImpact: '独占', verdict: 'decide' }]);
    const llm = mkLlm(okLlm(text), counter);
    await R({ apply: true, home, now: NOW_EARLY, report: mkReport(), ruleTableText: RULE_TABLE, llm });
    assert(counter.n === 1, `第一遍应调 1 次，实际 ${counter.n}`);
    const st = JSON.parse(fs.readFileSync(path.join(home, 'steward-state.json'), 'utf8'));
    assert(String(st.advices[0].at).includes('T19:'), `前置：at 应是 UTC 2026-11-01T19:xxZ，实际 ${st.advices[0].at}`);
    const r2 = await R({ apply: true, home, now: NOW_EARLY + 3600_000, report: mkReport(), ruleTableText: RULE_TABLE, llm });
    assert(counter.n === 1, `🔴 本地凌晨把"今天"判成"昨天"了 —— 重复调模型 ${counter.n} 次`);
    assert(r2.alreadyRan === true, '应判 alreadyRan');
  });

  // —— 🔴 不写盘就不调模型（钱一花出去必须有账，否则日上限/月预算两道闸只是纸上）
  ok('20. 不带 apply ⇒ 零调用（不花钱）+ 提示要加 --apply', async () => {
    const home = path.join(TMP, 'h20'); fs.mkdirSync(home, { recursive: true });
    const counter = { n: 0 };
    const text = adviceJSON([{ cardId: 'c-001', background: 'b', options: [{ label: 'A', effect: 'e', cost: 'c' }], recommend: 'A', why: 'w', citedRuleId: '判决表v1.0#R1', parallelImpact: '独占', verdict: 'decide' }]);
    const r = await R({ home, now: NOW, report: mkReport(), ruleTableText: RULE_TABLE, llm: mkLlm(okLlm(text), counter) });
    assert(counter.n === 0, `🔴 不带 --apply 竟调了模型 ${counter.n} 次（花钱且没账）`);
    assert(r.needApply === true, '应标 needApply');
    assert(fs.existsSync(path.join(home, 'steward-state.json')) === false, '不带 apply 不该写 state');
  });

  // —— 🔴 failed 段取数口径：账本级 `failedLedger`（在板），不是 `failed`（候选口径）
  //    真源 `docs/` §3-C / §3-D 第 21 条。
  //    改前实测：两字段都在时取的是"候选口径"、候选为空那天整段是空的（"晨报一声不吭"的机制）。
  ok('21. failed 段读 failedLedger（账本级·在板）· 缺字段才回落 failed（双向）', async () => {
    const mkF = (id) => ({ id, title: `卡${id}`, line: 'L3', status: 'failed', ageDays: null, recoverable: false, hasCardText: true, unlockValue: 'unknown' });
    // ① 鉴别性：两字段都在且**内容不同** ⇒ 必须取 failedLedger（取到 CANDIDATE-A 就说明还在读旧字段）
    const pBoth = buildWhitelistPayload({ ...mkReport(), failed: [mkF('CANDIDATE-A')], failedLedger: [mkF('LEDGER-B')] });
    assert(Array.isArray(pBoth.payload.failed) && pBoth.payload.failed.length === 1 && pBoth.payload.failed[0].id === 'LEDGER-B',
      `乙层没读账本级 failedLedger：${JSON.stringify(pBoth.payload.failed?.map((x) => x.id))}`);
    // ② 现场那一种：候选口径空 + 账本级有 1 条 ⇒ 必须拿到那 1 条（改前这里是空 ⇒ 模型看不到"卡失败了"）
    const pLedgerOnly = buildWhitelistPayload({ ...mkReport(), failed: [], failedLedger: [mkF('LEDGER-ONLY')] });
    assert(pLedgerOnly.payload.failed.length === 1 && pLedgerOnly.payload.failed[0].id === 'LEDGER-ONLY',
      `候选为空时 failed 段又丢了：${JSON.stringify(pLedgerOnly.payload.failed)}`);
    // ③ 反向（防"改一半"）：failedLedger 缺省 ⇒ 回落 failed，别把老 state 打成空段
    const pOld = buildWhitelistPayload({ ...mkReport(), failed: [mkF('CANDIDATE-A')], failedLedger: undefined });
    assert(pOld.payload.failed.length === 1 && pOld.payload.failed[0].id === 'CANDIDATE-A',
      `failedLedger 缺省时没回落 failed：${JSON.stringify(pOld.payload.failed)}`);
    // ④ 键名没变：模型侧文案仍然只有 `failed`，不许顺手新增键
    assert(!('failedLedger' in pBoth.payload), 'payload 里多出了 failedLedger 键（键名必须保持 failed）');
  });

  let pass = 0; const fails = [];
  for (const t of T) {
    try { await t.fn(); pass++; console.log(`  ✅ ${t.name}`); }
    catch (e) { fails.push({ name: t.name, err: e }); console.log(`  ❌ ${t.name}\n     ${e.message}`); }
  }
  console.log('');
  console.log(`夹具：${pass}/${T.length} 通过${fails.length ? ` · ${fails.length} 失败` : ''}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 夹具临时目录清不掉也无妨 */ }
  return { pass, total: T.length, fails };
}

// ================================================================ ⑨ CLI

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node steward-advice.mjs [--dry-run] [--apply] [--force-llm] [--offline] [--selftest] [--json] [--dump-raw <file>]');
    return 0;
  }
  if (argv.includes('--selftest')) {
    console.log('steward-advice.mjs 夹具（全部注入假 llmText · 零真实网络调用）');
    console.log('');
    const r = await selftest();
    return r.fails.length ? 5 : 0;
  }

  const dryRun = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  const forceLlm = argv.includes('--force-llm');
  const offline = argv.includes('--offline');
  const asJson = argv.includes('--json');
  // `--dump-raw <file>`：把模型原文留一份（审计"模型到底说了什么"用；不落 state，只给人看）
  const rawIdx = argv.indexOf('--dump-raw');
  const rawPath = rawIdx >= 0 && argv[rawIdx + 1] && !argv[rawIdx + 1].startsWith('--') ? argv[rawIdx + 1] : null;

  // ⚠️ 锁**不在这里拿**：`steward.mjs` 取数时自己也拿同一把 `steward` 锁（L1853），
  //    在这里先拿就会把甲层 spawn 卡死（2026-11-02 真跑踩到，见 persist() 里的注释）。
  //    锁由 `persist()` 只包住「读-改-写」那一段 —— 与甲层串行，但不挡甲层取数。
  {
    const r = await runCycle({ apply, dryRun, forceLlm, offline });
    if (rawPath && r.rawText) {
      try {
        writeTextAtomic(rawPath, r.rawText, { retryDelaysMs: [50, 150, 400] });
        console.log(`  模型原文已留档：${rawPath}（${Buffer.byteLength(r.rawText, 'utf8')} B）`);
      } catch (e) { console.log(`  ⚠️ 模型原文留档失败：${e.message}`); }
    }
    if (asJson || dryRun) {
      if (dryRun) {
        console.log('━━ 会喂给模型的完整提示词（--dry-run：不写盘、不调模型）━━');
        console.log('');
        console.log('### SYSTEM ###');
        console.log(r.prompt.system);
        console.log('');
        console.log('### USER ###');
        console.log(r.prompt.user);
        console.log('');
        console.log('━━ 估算 ━━');
        console.log(`提示词 ${r.prompt.chars} 字符 ≈ ${r.prompt.estTokens} token（上限 ${INPUT_TOKEN_BUDGET}）· 截断 ${r.prompt.truncatedCount} 条`);
        console.log(`规矩清单：给了 ${r.ruleList.shown}/${r.ruleList.total} 条${r.ruleList.truncated ? '（已截断）' : ''} · ${r.ruleList.chars} 字符`);
        const rb = r.reportBrief || {};
        console.log(`甲层：看板 rev ${rb.ledgerRevision ?? '?'} · 在途 ${rb.totals?.live ?? '?'} 张 · 候选 ${rb.raised ?? '?'} 件 `
          + `· 收敛线 ${rb.convergence?.total ?? '?'} 件（${rb.convergence?.status ?? '?'}）· 产物 mtime ${r.artifacts.length} 份`);
        console.log('自检：payload 里 excluded / sessions 字段 = 0 处（见夹具 15）');
      } else {
        console.log(JSON.stringify(r, null, 2));
      }
      return 0;
    }

    // 人读输出
    if (r.banner) console.log(r.banner);
    if (!r.called) {
      if (r.alreadyRan) console.log(`  今天已经跑过了（${r.results.length} 条记录），不重调模型。要重调加 --apply --force-llm。`);
      else if (r.budgetStop) console.log('  本月预算用完 ⇒ 今天只列候选，**没调模型**（候选清单见甲层输出，这里不重复）。');
      else if (r.needApply) console.log('  没调模型：真跑（会花几分钱、写 state 与 md）要加 --apply；只想看会喂给模型什么就加 --dry-run。');
      else if (!r.results.length) console.log('  今天没事（候选 0 件）。读了哪几份产物：');
      if (!r.alreadyRan && !r.budgetStop && !r.needApply) for (const a of r.artifacts) console.log(`    · ${a.name}：${a.exists ? a.mtime : '不存在'} ${a.extra || ''}`);
    } else {
      const okN = r.results.filter((x) => x.status === 'ok').length;
      console.log(`  模型：${r.model || '?'} · 本次 ¥${r.costCny.toFixed(6)} · 本月 ¥${(r.spendAfter?.cny ?? 0).toFixed(4)}/${MONTH_CAP_CNY}`);
      console.log(`  建议 ${okN} 条 · 丢弃 ${r.drops} 条 · 失败 ${r.results.filter((x) => x.status === 'failed').length} 条`);
      for (const x of r.results) {
        if (x.status === 'ok') console.log(`    ✅ ${x.cardId} · ${x.verdict}${x.citedRuleId ? ` · ${x.citedRuleId}` : ''} · ${x.parallelImpact}`);
        else console.log(`    ✂️ ${x.cardId || '?'} · ${x.dropReason || x.reason}`);
      }
    }
    if (!apply && !dryRun) console.log('\n（未加 --apply：state / md 都没写）');
    if (r.statePath) console.log(`  state：${r.statePath}`);
    if (r.markdownPath) console.log(`  报告：${r.markdownPath}`);

    if (r.ok === false) return 2;
    if (r.budgetStop) return 4;
    if (r.drops > 0) return 1;
    return 0;
  }
}

const isMain = () => {
  try {
    const a = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    const b = fs.realpathSync(SELF_PATH);
    return a === b;
  } catch { return false; }
};

if (isMain()) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`🔴 steward-advice 崩了：${e?.stack || e}`);
    process.exitCode = 3;
  });
}
