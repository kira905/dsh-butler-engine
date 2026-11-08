#!/usr/bin/env node
/**
 * yearring-index.mjs —— 年轮目录索引（**纯只读** · 2026-11-03 · 统筹线 YB2-R3）
 *
 * 干什么：把 `docs\年轮\*.json` 扫成「每线一行」的索引，供 Router 现读（`router-act.mjs brief --gaps` 也用它的扫描函数）。
 * 不干什么（硬边界，别改）：
 *   · **绝不写盘**：不建档、不改档、不补字段；坏 JSON 也只报黄、不修
 *   · **不新造真源**：真源是各条线自己写的 `愿景-<线>.md` + 同名 `.json`；本件只是索引
 *   · 不联网、不读看板、不碰会话
 *
 * 判据（对齐方案 §2.1「缺 / 字段缺 / 坏 JSON 都不崩、都报黄」）：
 *   目录不存在 ⇒ rc=0、lines 空、note 说明；坏 JSON ⇒ jsonStatus='broken'、rc=0；
 *   字段缺（无 line / 无 asks[]）⇒ jsonStatus='missing'、rc=0。
 *
 * 跑法：
 *   node <pkg>\jobs\yearring-index.mjs [--json] [--dir <path>]
 */
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';

/** 默认目录：与 `router-act.mjs` 的 `DIGEST_DIR` 同一个（结论档 + 愿景 json 都在这儿） */
export const DEFAULT_DIR = path.join(workspaceRoot(), 'docs', '年轮');

/**
 * `kind` → 等级（现状只有这三种，2026-11-03 现读 `统筹线.json` 实测：blocked-by-owner 8 / capability-gap 7 / self-todo 16）。
 * 别的 kind 一律当 B，并在 `warnings` 里点名（不许静默吞）。
 */
export const KIND_TIER = {
  'blocked-by-owner': 'A',   // 卡主人手上：只上桌，不进「该推」
  'capability-gap': 'B',     // 能力缺口
  'self-todo': 'C',          // 自己能干的：最该推
};

const TIER_RANK = { C: 0, B: 1, A: 2 };

/** 未知 kind ⇒ 'B'；第二个返回值标明是不是猜的 */
export function tierOfKind(kind) {
  const k = String(kind ?? '').trim();
  const t = KIND_TIER[k];
  return t ? { tier: t, known: true } : { tier: 'B', known: false };
}

/** ask 的正文：愿景件里叫 `what`（现读 31/31 都有）；别的名字只作兜底，别当主口径 */
export function askTextOf(a) {
  return String(a?.what ?? a?.text ?? a?.next ?? '').trim();
}

/**
 * 一条线内部「哪条 ask 排第一」：C（自己能干）＞ B（能力缺口）＞ A（等主人），同档按数组原序。
 *
 * 🔴 为什么 C 优先而不是 A 优先：`brief --gaps` 回答的是"**下一步该推哪条**"。
 *    A 类是"卡在主人手上、推也推不动"的，它们该出现在「上桌」语义里（渲染成「等主人：…」），
 *    不该抢走"该推"的位置。只有**整条线只剩 A 类**时，排第一的才是 A —— 那时如实标「等主人」。
 */
export function rankAsks(asks) {
  const arr = (Array.isArray(asks) ? asks : []).map((a, i) => ({
    id: String(a?.id ?? '').trim() || '?',
    kind: String(a?.kind ?? '').trim(),
    tier: tierOfKind(a?.kind).tier,
    known: tierOfKind(a?.kind).known,
    text: askTextOf(a),
    i,
  }));
  return arr.sort((x, y) => (TIER_RANK[x.tier] - TIER_RANK[y.tier]) || (x.i - y.i));
}

/** humanDoc 指的那份人读档在不在（相对路径按「年轮目录」与「<workspace>」两处各试一次；都不在 = false，不猜） */
function humanDocExists(humanDoc, dir) {
  const rel = String(humanDoc ?? '').trim();
  if (!rel) return false;
  const cands = path.isAbsolute(rel)
    ? [rel]
    : [path.resolve(dir, rel), path.resolve(workspaceRoot(), rel)];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return true; } catch { /* 试下一个 */ }
  }
  return false;
}

/** 中日韩全角按 2 显示宽算（人读列要对齐；emoji 不追求精确） */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const dispWidth = (s) => {
  let n = 0;
  for (const ch of String(s ?? '')) n += WIDE.test(ch) ? 2 : 1;
  return n;
};
const pad = (s, w) => {
  const str = String(s ?? '');
  return str + ' '.repeat(Math.max(0, w - dispWidth(str)));
};
const clip = (s, w) => {
  const str = String(s ?? '');
  if (dispWidth(str) <= w) return str;
  let out = '';
  let n = 0;
  for (const ch of str) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (n + cw > w - 1) break;
    out += ch;
    n += cw;
  }
  return `${out}…`;
};

/**
 * 扫描年轮目录。**永不抛**（任何一条读不动都只进 warnings）。
 *
 * @param {string} dir 目录（默认 `<workspace>\docs\年轮`）
 * @param {number} at  时点（ms，只为 `at` 字段）
 * @returns {{at:string, dir:string, lines:Array, totals:object, note:string, warnings:string[]}}
 */
export function scanYearring(dir = DEFAULT_DIR, at = Date.now()) {
  const out = {
    at: new Date(at).toISOString(),
    dir: String(dir),
    lines: [],
    totals: { files: 0, vision: 0, ok: 0, missing: 0, broken: 0, asksTotal: 0, askA: 0, askB: 0, askC: 0 },
    note: '',
    warnings: [],
  };

  let files;
  try {
    files = fs.readdirSync(out.dir).filter((f) => /\.json$/i.test(f)).sort();
  } catch (e) {
    out.note = `目录不存在或读不动：${out.dir}（${e?.code ?? e?.message ?? 'ERR'}）`;
    out.warnings.push(out.note);
    return out;
  }
  out.totals.files = files.length;
  if (!files.length) {
    out.note = `目录里没有 .json：${out.dir}`;
    out.warnings.push(out.note);
    return out;
  }

  for (const f of files) {
    const file = path.join(out.dir, f);
    const base = { file, jsonStatus: 'ok', line: '', version: '', updatedAt: '', humanDoc: '', humanDocExists: false, asksTotal: 0, askA: 0, askB: 0, askC: 0, askTop: null, isVision: false, warnings: [] };

    let txt;
    try {
      txt = fs.readFileSync(file, 'utf8');
    } catch (e) {
      out.lines.push({ ...base, file: f, line: `${f}（读不动）`, jsonStatus: 'broken', warnings: [`读不动：${e?.code ?? e?.message ?? 'ERR'}`] });
      out.totals.broken += 1;
      out.warnings.push(`${f}：读不动（${e?.code ?? e?.message ?? 'ERR'}）`);
      continue;
    }

    let obj;
    try {
      obj = JSON.parse(txt);
    } catch (e) {
      out.lines.push({ ...base, file: f, line: `${f}（坏 JSON）`, jsonStatus: 'broken', warnings: [`坏 JSON：${e?.message ?? e}`] });
      out.totals.broken += 1;
      out.warnings.push(`${f}：坏 JSON（${e?.message ?? e}）—— 报黄不修，谁写的谁修`);
      continue;
    }

    const lineName = typeof obj?.line === 'string' ? obj.line.trim() : '';
    const asks = Array.isArray(obj?.asks) ? obj.asks : null;
    const humanDoc = typeof obj?.humanDoc === 'string' ? obj.humanDoc.trim() : '';
    const miss = [];
    if (!lineName) miss.push('line');
    if (!asks) miss.push('asks[]');

    const entry = {
      ...base,
      file: f,
      line: lineName || `(无 line：${f})`,
      version: typeof obj?.version === 'string' ? obj.version : '',
      updatedAt: typeof obj?.updatedAt === 'string' ? obj.updatedAt : '',
      humanDoc,
      humanDocExists: humanDocExists(humanDoc, out.dir),
    };

    if (miss.length) {
      entry.jsonStatus = 'missing';
      entry.warnings.push(`字段缺：${miss.join(' / ')}`);
      out.lines.push(entry);
      out.totals.missing += 1;
      out.warnings.push(`${f}：字段缺（${miss.join(' / ')}）—— 不是愿景件，不入 R2 的「愿景差距」`);
      continue;
    }

    entry.isVision = true;
    entry.asksTotal = asks.length;
    for (const a of asks) {
      const t = tierOfKind(a?.kind);
      if (t.tier === 'A') entry.askA += 1;
      else if (t.tier === 'C') entry.askC += 1;
      else entry.askB += 1;
      if (!t.known) entry.warnings.push(`未映射 kind："${String(a?.kind ?? '').trim() || '(空)'}"（按 B 计）`);
    }
    const ranked = rankAsks(asks);
    entry.askTop = ranked.length
      ? { id: ranked[0].id, kind: ranked[0].kind, tier: ranked[0].tier, text: ranked[0].text }
      : null;
    if (entry.warnings.length) out.warnings.push(`${f}：${[...new Set(entry.warnings)].join('；')}`);

    out.lines.push(entry);
    out.totals.vision += 1;
    out.totals.ok += 1;
    out.totals.asksTotal += entry.asksTotal;
    out.totals.askA += entry.askA;
    out.totals.askB += entry.askB;
    out.totals.askC += entry.askC;
  }

  return out;
}

/** 人读：每线一行 `线名 / 版本 / 更新于 / 总 / A / C / 人读档 / json状态`（另加一列「愿景」说明口径） */
export function renderHuman(idx) {
  const L = [];
  L.push(`年轮索引 · ${idx.dir}`);
  L.push(`（纯只读：本件不写盘、不改任何文件 · ${idx.at}）`);
  if (!idx.lines.length) {
    L.push('');
    L.push(`⚠️ ${idx.note || '没有可索引的 json'}`);
    return L.join('\n');
  }
  L.push('');
  const head = `${pad('线名', 20)} ${pad('版本', 7)} ${pad('更新于', 12)} ${pad('总', 3)} ${pad('A', 2)} ${pad('C', 2)} ${pad('人读档', 6)} ${pad('json', 8)} 愿景`;
  L.push(head);
  L.push('─'.repeat(Math.min(96, head.length + 6)));
  for (const r of idx.lines) {
    const when = r.updatedAt ? String(r.updatedAt).slice(0, 10) : '—';
    L.push([
      pad(clip(r.line, 20), 20),
      pad(r.version || '—', 7),
      pad(when, 12),
      pad(r.asksTotal, 3),
      pad(r.askA, 2),
      pad(r.askC, 2),
      pad(r.humanDoc ? (r.humanDocExists ? '有' : '缺') : '—', 6),
      pad(r.jsonStatus, 8),
      r.isVision ? '是' : `非愿景（${r.jsonStatus === 'missing' ? '缺字段' : r.jsonStatus}）`,
    ].join(' '));
  }
  const t = idx.totals;
  L.push('─'.repeat(48));
  L.push(`合计 json ${t.files} 个 · 愿景线 ${t.vision} 条（ok ${t.ok}）· 坏 ${t.broken} · 缺字段 ${t.missing}`
    + ` ｜ asks ${t.asksTotal}（A${t.askA}/B${t.askB}/C${t.askC}）`);
  L.push('口径：只有带 `line` + `asks[]` 的 json 才算愿景件（`capability.json` 不是愿景件，标「非愿景」但仍列出，不静默丢）。');
  if (idx.note) L.push(`⚠️ ${idx.note}`);
  for (const w of idx.warnings) L.push(`⚠️ ${w}`);
  return L.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

  if (has('--help') || has('-h')) {
    process.stdout.write(`yearring-index v${VERSION} —— 年轮目录索引（纯只读）

  node <pkg>/jobs/yearring-index.mjs [--json] [--dir <path>]

  --dir <path>  扫哪个目录（默认 ${DEFAULT_DIR}）；夹具/演练用，生产别带
  --json        机器可读：{ at, dir, lines:[...], totals:{...}, note, warnings }

判据：目录不存在 / 坏 JSON / 字段缺 ⇒ 报黄、rc 恒 0（绝不因为一个坏 json 整条崩）。
🔴 本件只读：不写盘、不改任何文件、不联网、不碰会话。
`);
    return 0;
  }

  const dir = String(val('--dir', '') ?? '').trim() || DEFAULT_DIR;
  const idx = scanYearring(dir);
  process.stdout.write((has('--json') ? JSON.stringify(idx, null, 2) : renderHuman(idx)) + '\n');
  return 0;   // 🔴 恒 0：坏 JSON 也只报黄
}

const isMain = (() => {
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1] ?? '')).toLowerCase();
    const b = fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
    return a === b;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = main() ?? 0;
  } catch (e) {
    // 兜底：连扫描函数都炸了也只报黄、不给非零码（对齐「不崩」判据）
    process.stdout.write(`⚠️ yearring-index 内部错误（仍 rc=0）：${e?.message ?? e}\n`);
    process.exitCode = 0;
  }
}

export { pad as _pad, clip as _clip };
