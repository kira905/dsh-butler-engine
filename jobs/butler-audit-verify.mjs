#!/usr/bin/env node
// dsh-butler / butler-audit-verify.mjs —— 审计流水哈希链完整性校验（P5 R·回归）
//
// 方案 §4 P5：「哈希链审计完整性校验脚本 butler-audit-verify.mjs」。
// 逐条校验：① hash 字段 = 记录内容（不含 hash）的 sha256 ② prev = 上一条 hash。
// 旧记录（P5 之前写的）无 hash/prev → 记为 chainStart，不算失败（向后兼容）。
//
// P-2 增补（2026-09-23，真源 docs\交付报告-P5审计链治本-20260923.md）：
//   2026-09-17 的空洞（NTFS 未落盘）+ 09-20/09-22 的两次并发分叉共 4 处**历史既成断点**，
//   已逐条取证并登记在 `lib/known-chain-breaks.json`（index + reason + 签名 + 成因 + 证据）。
//   它们**不是篡改**（无 hash-mismatch），也**不可原地修**（改一条要级联重算 9000+ 行 hash，
//   会毁掉整份流水的防篡改取证价值 —— 见复核报告 §4.3）⇒ 校验器对**清单内**这 4 处放行
//   （记为 known，不算失败），**清单外任何断链一律照旧报红**。
//   `--no-known`（=忽略白名单，全量报红）/ `--registry <file>`（换一份登记清单）用于对照验证。
//
// 用法：
//   node butler-audit-verify.mjs [--json] [--home <dshHome>] [--file <jsonl>] [--limit N]
//                                [--no-known] [--registry <file>]
// 退出码：0 完整（含"清单内历史断点"）/ 1 发现断链 / 2 用法错误
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_ROOT, butlerPaths, dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { recordHash } from '../src/dsh-butler/lib/audit.mjs';
import { chainProblemSig } from '../src/dsh-butler/lib/audit-chain-watch.mjs';

const USAGE = [
  'butler-audit-verify —— 审计流水哈希链校验',
  '  node butler-audit-verify.mjs [--json] [--home <dir>] [--file <jsonl>] [--limit N]',
  '                               [--no-known] [--registry <file>]',
  '',
  '  --no-known           忽略「已知历史断点」白名单（全量报红；用于对照验证）',
  '  --registry <file>    指定登记清单（默认 lib/known-chain-breaks.json）',
  '  ⚠️ --limit 与白名单不兼容（切片后 index 会偏移）⇒ 该模式下自动按严格口径校验',
].join('\n');

/** 默认登记清单（lib/known-chain-breaks.json）。 */
export const DEFAULT_KNOWN_BREAKS_FILE = path.join(COMPONENT_ROOT, 'lib', 'known-chain-breaks.json');
/** 允许登记的断点类型（hash-mismatch = 疑似篡改，**永不允许登记**）。 */
export const REGISTRABLE_REASONS = ['unparsable', 'chain-break'];
/** 登记条目必须附的成因/证据最短长度（防"随手加一行"绕过报红）。 */
export const MIN_CAUSE_CHARS = 8;

/**
 * 登记清单归一化 + 合法性校验。
 * **不完整的登记条目一律不生效**（宁可疑红，也不放任"登记=万能放行"）。
 * @param {object|Array} raw 清单文件内容（`{entries:[...]}` 或裸数组）
 * @returns {{entries:Array, rejected:Array, version:any, note:any}}
 */
export function normalizeKnownBreaks(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
  const entries = [];
  const rejected = [];
  for (const e of list) {
    const index = Number(e?.index);
    const reason = String(e?.reason ?? '');
    const sig = String(e?.sig ?? '');
    const cause = String(e?.cause ?? '').trim();
    const evidence = String(e?.evidence ?? '').trim();
    if (!Number.isFinite(index) || index < 0) { rejected.push({ entry: e, why: 'index 非法' }); continue; }
    if (!REGISTRABLE_REASONS.includes(reason)) { rejected.push({ entry: e, why: `reason 不允许登记（只允许 ${REGISTRABLE_REASONS.join(' / ')}）` }); continue; }
    if (!sig) { rejected.push({ entry: e, why: '缺签名 sig' }); continue; }
    if (cause.length < MIN_CAUSE_CHARS) { rejected.push({ entry: e, why: `缺成因（cause 需 ≥${MIN_CAUSE_CHARS} 字）` }); continue; }
    if (evidence.length < MIN_CAUSE_CHARS) { rejected.push({ entry: e, why: `缺证据（evidence 需 ≥${MIN_CAUSE_CHARS} 字）` }); continue; }
    entries.push({ index, reason, sig, at: e?.at ?? null, cause, evidence, note: e?.note ?? null });
  }
  return { entries, rejected, version: raw?.version ?? null, note: raw?.note ?? null };
}

/** 读登记清单（读不到/坏掉 ⇒ 空清单 + error，**绝不因清单问题放行任何断点**）。 */
export function loadKnownBreaks(file = DEFAULT_KNOWN_BREAKS_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const norm = normalizeKnownBreaks(raw);
    return { ...norm, file, error: null };
  } catch (e) {
    return { entries: [], rejected: [], version: null, note: null, file, error: e?.message ?? String(e) };
  }
}

/**
 * 逐条校验哈希链。
 * @param {Array} records 记录数组（无法解析的行请传 null）
 * @param {{knownBreaks?:Array|object, rawLines?:string[]}} [opts]
 *   `knownBreaks` = normalizeKnownBreaks 的 entries（或 `{entries}`）；`rawLines` = 与 records 同索引的原始行
 *   （unparsable 的签名要用它算内容哈希；不传则该类断点签名退化为 `raw:unknown` ⇒ 永远报红，保守）
 * @returns {{checked:number, problems:Array, known:Array, legacy:number, legacySamples:Array, tail:string|null}}
 */
export function verifyChain(records, opts = {}) {
  const problems = [];
  const knownHits = [];
  const legacy = [];
  const known = Array.isArray(opts.knownBreaks) ? opts.knownBreaks
    : (Array.isArray(opts.knownBreaks?.entries) ? opts.knownBreaks.entries : []);
  const rawLines = Array.isArray(opts.rawLines) ? opts.rawLines : null;
  let checked = 0;
  let prevHash = null;
  let first = true;

  // 单条问题落位：命中清单（index + reason + 签名三者全等）→ known；否则 problems（报红）
  const settle = (problem) => {
    const sig = chainProblemSig(problem, { rawLine: rawLines ? rawLines[problem.index] ?? null : null });
    const hit = known.find((k) => k.index === problem.index && k.reason === problem.reason && k.sig === sig);
    if (hit) knownHits.push({ ...problem, sig, cause: hit.cause, evidence: hit.evidence });
    else problems.push({ ...problem, sig });
  };

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || typeof rec !== 'object') {
      settle({ index: i, reason: 'unparsable' });
      continue;
    }
    if (typeof rec.hash !== 'string') {
      legacy.push({ index: i, at: rec.at ?? null });
      prevHash = null;
      first = true;
      continue;
    }
    const expect = recordHash(rec);
    if (expect !== rec.hash) {
      settle({ index: i, at: rec.at ?? null, reason: 'hash-mismatch', expect, got: rec.hash });
    }
    if (!first && (rec.prev ?? null) !== prevHash) {
      settle({ index: i, at: rec.at ?? null, reason: 'chain-break', expectPrev: prevHash, gotPrev: rec.prev ?? null });
    }
    prevHash = rec.hash;
    first = false;
    checked++;
  }
  return { checked, problems, known: knownHits, legacy: legacy.length, legacySamples: legacy.slice(0, 3), tail: prevHash };
}

function isMainEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function loadRecords(file) {
  const records = [];
  const rawLines = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { records, rawLines }; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    rawLines.push(line);                      // 与 records **同索引**（unparsable 的签名要用原始内容）
    try { records.push(JSON.parse(line)); } catch { records.push(null); }
  }
  return { records, rawLines };
}

if (isMainEntry()) {
  const argv = process.argv.slice(2);
  const opt = { json: false, home: null, file: null, limit: 0, known: true, registry: null, help: false };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') opt.json = true;
      else if (a === '--home') opt.home = argv[++i];
      else if (a === '--file') opt.file = argv[++i];
      else if (a === '--limit') opt.limit = Number(argv[++i]);
      else if (a === '--no-known') opt.known = false;
      else if (a === '--registry') opt.registry = argv[++i];
      else if (a === '--help' || a === '-h') opt.help = true;
      else throw new Error(`未知参数：${a}`);
    }
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exitCode = 2;
  }

  if (opt.help) {
    console.log(USAGE);
  } else if (process.exitCode !== 2) {
    const home = opt.home ?? dshHome();
    let files = [];
    if (opt.file) files = [path.resolve(opt.file)];
    else {
      const dir = butlerPaths(home).auditDir;
      try {
        files = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort().map((n) => path.join(dir, n));
      } catch { files = []; }
    }
    const records = [];
    const rawLines = [];
    for (const f of files) {
      const one = loadRecords(f);
      records.push(...one.records);
      rawLines.push(...one.rawLines);
    }
    const sliced = opt.limit > 0 ? records.slice(-opt.limit) : records;
    const slicedRaw = opt.limit > 0 ? rawLines.slice(-opt.limit) : rawLines;

    // ⚠️ --limit 会让 index 相对整月偏移 ⇒ 白名单（按 index 匹配）在该模式下**自动停用**（宁可报红，不放行）。
    const limitMode = opt.limit > 0;
    const useKnown = opt.known && !limitMode;
    const reg = loadKnownBreaks(opt.registry ? path.resolve(opt.registry) : DEFAULT_KNOWN_BREAKS_FILE);

    const result = {
      ok: true,
      files: files.map((f) => path.basename(f)),
      records: sliced.length,
      knownBreaksEnabled: useKnown,
      knownBreaksFile: useKnown ? reg.file : null,
      knownBreaksRejected: useKnown ? reg.rejected.length : 0,
      ...verifyChain(sliced, useKnown ? { knownBreaks: reg.entries, rawLines: slicedRaw } : {}),
    };
    result.ok = result.problems.length === 0;

    if (opt.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      console.log(`${result.ok ? '✅' : '⛔'} 审计流水哈希链校验：${result.records} 条（校验 ${result.checked} 条，旧记录 ${result.legacy} 条）`);
      for (const p of result.problems.slice(0, 20)) {
        console.log(`   - 第 ${p.index} 条 ${p.at ?? ''} ${p.reason}${p.expect ? ` expect=${p.expect.slice(0, 12)}… got=${String(p.got).slice(0, 12)}…` : ''}`);
      }
      if (result.problems.length > 20) console.log(`   … 其余 ${result.problems.length - 20} 条省略`);
      if (result.known.length) {
        console.log(`   ℹ️ 清单内历史断点放行 ${result.known.length} 处（${path.basename(reg.file)}）：${result.known.map((k) => `第 ${k.index} 条 ${k.reason}`).join('、')}`);
        if (limitMode) console.log('   ⚠️ 本次带 --limit，白名单未启用（index 会偏移）—— 上面若是"放行"说明有 bug');
      } else if (useKnown) {
        console.log(`   ℹ️ 白名单已启用（${path.basename(reg.file)}，${reg.entries.length} 条登记）—— 本次无命中`);
      } else if (limitMode) {
        console.log('   ⚠️ 带 --limit ⇒ 白名单自动停用（严格口径）；要放行历史断点请去掉 --limit');
      }
      if (reg.error) console.log(`   ⚠️ 登记清单读取失败（${reg.error}）⇒ 已按严格口径校验（不放行任何断点）`);
      if (result.knownBreaksRejected) console.log(`   ⚠️ 登记清单有 ${result.knownBreaksRejected} 条**不生效**（缺成因/证据或 reason 不允许）—— 见 --json 的 knownBreaksRejected`);
      console.log(`   文件：${result.files.join(', ') || '(无)'}`);
    }
    process.exitCode = result.ok ? 0 : 1;
  }
}

export { USAGE };
