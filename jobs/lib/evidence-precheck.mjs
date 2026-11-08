// dsh-butler / lib/evidence-precheck.mjs —— P3 L1 自动动作③：待验收自动预检（防假完成）
//
// 方案 §4 P3「L1 自动动作（学习项④）：待验收自动预检 —— 完成证据验证」：
//   「看板卡结算进「待验收」时自动跑**只读证据预检**（非 LLM、0 token）——按卡类型验：
//     改脚本类 → node --check / PS Parser；建档类 → 引用的文件存在 / 产物路径非空；
//     迁移 / 备份类 → hash / 链接校验。验不过 → 卡标 🟡「证据缺失」并附检查输出。」
//   实现 = 复用 P5 写后审计同款规则引擎（规则表在 lib/evidence-rules.mjs，共享），只换触发点。
//   级别 = L1 无害只读（**只标注不阻断**，验收仍以人眼为准）。
//
// **为什么不做**「把 🟡 写回卡的 description」：那是改卡 = L3（方案明令不自动）。
//   本模块只把预检结果落到 `~/.dsh/butler-precheck.json`（面板 / 主人可查），卡本身不动。
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { readJson } from '../../src/dsh-butler/lib/store.mjs';
import { updateStateJson } from '../../src/dsh-butler/lib/dual-write-store.mjs';
import { sha256 } from '../../src/dsh-butler/lib/dup-cards.mjs';
import { checkEvidencePath, runAuditRules, ruleForPath } from './evidence-rules.mjs';

export const PRECHECK_VERSION = '0.1.0';
export const PRECHECK_SCHEMA = 1;

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-precheck.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

export const PRECHECK_FILE = 'butler-precheck.json';

/** 单卡最多检查的路径数（成本闸；也防 prompt 里贴了大段日志时把 precheck 拖长）。 */
export const MAX_PATHS_PER_CARD = 10;
/** 单卡耗时上限（超了剩余路径标 skipped）。 */
export const MAX_CARD_MS = 20_000;

export function precheckPath(opts = {}) { return stateFileOf(PRECHECK_FILE, opts); }

export function emptyPrecheckState() {
  return { schemaVersion: PRECHECK_SCHEMA, cards: {}, lastRunAt: null, stats: { checked: 0, warned: 0, skipped: 0 } };
}

/**
 * 是否像"本机绝对路径"（保守判据）。
 * 关键排除：URL 里的域名残渣（如 `s://example.com/<drive>/fake/path` 中的 `.com/D:` 段），
 * 那种字符集正则一旦误判就会天天误报 🟡 —— 误报率是裸跑期第一 KPI。
 */
export function isPlausibleLocalPath(p) {
  if (!p) return false;
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(p)) return false;   // 任意 scheme://（http/file/...）
  if (!/^[A-Za-z]:[\\/]/.test(p)) return false;          // 只认绝对路径（相对路径歧义太大，不猜）
  const rest = p.slice(2);
  if (rest.includes('://')) return false;                // URL 残渣（如 s://example.com/<drive>/fake/path）
  if (/\.(com|org|net|io|cn|dev|app|top|xyz)[\\/]/i.test(rest)) return false; // 域名段（形如 a.com\X:\x）
  if (/^[\\/]?$/.test(rest)) return false;               // 光秃秃的盘符
  if (p.includes('*') || p.includes('?') || p.includes('%')) return false; // 通配符 / 环境变量不猜
  const norm = p.replace(/\//g, '\\').replace(/\\+$/, '');
  if (/[\\/]$/.test(norm)) return false;                 // 结尾是分隔符 → 多半从句子截断
  if (norm.length < 5 || norm.length > 260) return false;
  if (/\s{2,}/.test(norm)) return false;
  return true;
}

/**
 * 证据路径提取（保守：只认"看起来是路径"的 token，且必须带盘符或已是绝对路径）。
 * @param {string} text
 * @param {{max?:number}} [opts]
 * @returns {string[]}
 */
export function extractEvidencePaths(text, opts = {}) {
  const max = opts.max ?? MAX_PATHS_PER_CARD;
  const src = String(text ?? '');
  if (!src.trim()) return [];
  const found = new Map();

  const push = (raw) => {
    if (!raw) return;
    let p = String(raw).trim();
    p = p.replace(/^[`'"（(【\[<]+/, '').replace(/[`'"）)】\]>]+$/, '');
    p = p.replace(/[，。；、！？：]+$/, '');          // 中文标点尾巴
    p = p.replace(/[.,;:]+$/, '');                    // 半角标点尾巴（不含 \ 与 /）
    // 去掉 :: 行号 / #L12 行锚
    p = p.replace(/::\d+.*$/, '').replace(/#L\d+$/, '');
    if (!p) return;
    if (!isPlausibleLocalPath(p)) return;
    const norm = p.replace(/\//g, '\\').replace(/\\+$/, '');
    if (!found.has(norm.toLowerCase())) found.set(norm.toLowerCase(), norm);
  };

  // ① 反引号 / 双引号 / 单引号包裹
  for (const re of [/[`"']([A-Za-z]:[\\/][^`"'\n\r]{2,240})[`"']/g]) {
    for (const m of src.matchAll(re)) push(m[1]);
  }
  // ② 裸路径（到空格/换行/常见分隔符为止；中文标点也断）
  for (const m of src.matchAll(/[A-Za-z]:[\\/][^\s"'`|<>*?\n\r，。；、！？：（）【】]*/g)) push(m[0]);
  // ③ markdown 链接 / 行内代码里的路径已由 ①② 覆盖

  return [...found.values()].slice(0, max);
}

/** 从卡里收集用于提取证据的文本（description + prompt）。 */
export function cardEvidenceText(card) {
  const parts = [];
  if (typeof card?.description === 'string') parts.push(card.description);
  if (typeof card?.prompt === 'string') parts.push(card.prompt);
  if (typeof card?.title === 'string') parts.push(card.title);
  return parts.join('\n');
}

/**
 * 卡内容指纹（预检去重键之一：内容变了才重检）。
 * ⚠️ 只用**账本侧稳定字段**（id/status/title/description）——prompt 不参与：
 * 生产预检拿到的卡来自账本（可能不含 prompt），若把 prompt 计入指纹会永远对不上 → 每轮重检。
 */
export function cardFingerprint(card) {
  return sha256([card?.id, card?.status, card?.title, card?.description].map((x) => String(x ?? '')).join('\u0000')).slice(0, 32);
}

/**
 * 预检一张卡（只读 + 可在测试里注入 rule 运行器）。
 * @param {object} card
 * @param {{home?:string, now?:number, runAudit?:Function, maxPaths?:number, maxCardMs?:number, skipAuditRules?:boolean}} [opts]
 */
export async function precheckCard(card, opts = {}) {
  const now = opts.now ?? Date.now();
  const t0 = Date.now();
  const text = cardEvidenceText(card);
  const paths = extractEvidencePaths(text, { max: opts.maxPaths ?? MAX_PATHS_PER_CARD });
  const checks = [];
  for (const p of paths) {
    if (Date.now() - t0 > (opts.maxCardMs ?? MAX_CARD_MS)) {
      checks.push({ path: p, ruleId: 'budget', ok: true, skipped: true, detail: '超出单卡耗时预算，剩余路径跳过' });
      continue;
    }
    checks.push(checkEvidencePath(p, opts));
  }
  const failed = checks.filter((c) => !c.ok && !c.skipped);

  // P5 同款规则引擎（同规则、换触发点）：对"主产物"跑一遍审计规则
  let audit = { ran: 0, findings: [], errors: [], ok: true };
  const primary = paths[0] ?? null;
  if (!opts.skipAuditRules && primary) {
    const runner = opts.runAudit ?? runAuditRules;
    try {
      let auditText = null;
      try { auditText = fs.readFileSync(primary, 'utf8').slice(0, 200000); } catch { auditText = null; }
      audit = await runner({ target: primary, text: auditText });
      if (!Array.isArray(audit?.findings)) audit = { ran: 0, findings: [], errors: [], ok: true };
    } catch (e) {
      audit = { ran: 0, findings: [], errors: [{ error: e?.message ?? String(e) }], ok: true };
    }
  }
  const blockFindings = (audit.findings ?? []).filter((f) => f.level === 'block');

  const verdict = failed.length || blockFindings.length ? 'evidence-missing'
    : (paths.length === 0 ? 'no-evidence-declared' : 'ok');

  return {
    cardId: String(card?.id ?? ''),
    title: typeof card?.title === 'string' ? card.title : '',
    status: card?.status ?? null,
    fingerprint: cardFingerprint(card),
    checkedAt: now,
    verdict,
    declaredPaths: paths,
    checks,
    failed: failed.map((c) => ({ path: c.path, checker: c.checker, message: c.message, ruleId: c.ruleId })),
    audit: { ran: audit.ran ?? 0, findings: (audit.findings ?? []).slice(0, 10), errors: audit.errors ?? [] },
    ruleIds: [...new Set(checks.map((c) => c.ruleId))],
    durationMs: Date.now() - t0,
  };
}

/** 人读摘要（面板 / 变更流水 / dry-run 输出共用）。 */
export function summarizePrecheck(rec) {
  if (!rec) return '（无记录）';
  const icon = rec.verdict === 'evidence-missing' ? '🟡 证据缺失' : (rec.verdict === 'ok' ? '✅ 证据齐' : '⏭ 未声明证据');
  const lines = [`${icon} · ${rec.title || rec.cardId}`, `  路径 ${rec.declaredPaths?.length ?? 0} 个 · 检查 ${rec.checks?.length ?? 0} 项 · 失败 ${rec.failed?.length ?? 0} 项`];
  for (const f of (rec.failed ?? []).slice(0, 5)) lines.push(`  ❌ ${f.path} → ${f.message}`);
  for (const f of (rec.audit?.findings ?? []).filter((x) => x.level === 'block').slice(0, 3)) lines.push(`  ❌ [规则 ${f.ruleId}] ${f.message}`);
  return lines.join('\n');
}

/**
 * 扫账本里处于 review（待验收）的卡，做只读证据预检（**只算不动**：不写卡，只写 butler-precheck.json）。
 * @param {object} ledger
 * @param {{home?:string, now?:number, force?:boolean, maxCards?:number, runAudit?:Function, state?:object}} [opts]
 */
export async function precheckReviewCards(ledger, opts = {}) {
  const now = opts.now ?? Date.now();
  const cards = (Array.isArray(ledger?.tasks) ? ledger.tasks : []).filter((c) => String(c?.status ?? '') === 'review');
  const state = opts.state ?? readPrecheckState(opts);
  const results = [];
  const pending = [];
  for (const card of cards) {
    const fp = cardFingerprint(card);
    const prev = state.cards?.[String(card.id)];
    if (!opts.force && prev && prev.fingerprint === fp) continue;
    pending.push({ card, fp });
  }
  const budget = Number.isFinite(opts.maxCards) ? opts.maxCards : pending.length;
  for (const { card, fp } of pending.slice(0, budget)) {
    const rec = await precheckCard(card, opts);
    results.push(rec);
  }
  return {
    reviewCards: cards.length,
    pending: pending.length,
    checked: results.length,
    warned: results.filter((r) => r.verdict === 'evidence-missing').length,
    results,
    now,
  };
}

export function readPrecheckState(opts = {}) {
  const file = opts.file ?? precheckPath(opts);
  try {
    if (!fs.existsSync(file)) return { ...emptyPrecheckState(), _file: file };
    const j = readJson(file, { audit: false });
    return { ...emptyPrecheckState(), ...(j ?? {}), cards: { ...(j?.cards ?? {}) }, _file: file };
  } catch {
    return { ...emptyPrecheckState(), _file: file };
  }
}

/** 写入预检结果（走 butler-store 原子写；保留最近 200 条卡记录）。 */
export function recordPrecheck(results, opts = {}) {
  const now = opts.now ?? Date.now();
  const file = opts.file ?? precheckPath(opts);
  const out = updateStateJson(PRECHECK_FILE, file, (cur) => {
    const base = { ...emptyPrecheckState(), ...(cur ?? {}) };
    const cards = { ...(base.cards ?? {}) };
    for (const r of results) {
      if (!r?.cardId) continue;
      cards[r.cardId] = { ...r, firstCheckedAt: cards[r.cardId]?.firstCheckedAt ?? r.checkedAt };
    }
    const entries = Object.entries(cards).sort((a, b) => Number(b[1]?.checkedAt ?? 0) - Number(a[1]?.checkedAt ?? 0));
    const kept = Object.fromEntries(entries.slice(0, 200));
    return {
      ...base, cards: kept, lastRunAt: now, schemaVersion: PRECHECK_SCHEMA,
      stats: {
        checked: Number(base.stats?.checked ?? 0) + results.length,
        warned: Number(base.stats?.warned ?? 0) + results.filter((r) => r?.verdict === 'evidence-missing').length,
        skipped: Number(base.stats?.skipped ?? 0) + results.filter((r) => r?.verdict === 'no-evidence-declared').length,
        lastResults: results.length,
      },
    };
  }, { schemaVersion: PRECHECK_SCHEMA, defaultValue: emptyPrecheckState(), home: opts.home ?? dshHome(), audit: false });
  return { ok: true, file, lastRunAt: out?.lastRunAt ?? null, cards: Object.keys(out?.cards ?? {}).length };
}

export { ruleForPath };
