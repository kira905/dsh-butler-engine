// dsh-butler / lib / collect-failure-ledger.mjs —— 采集失败台账的**判定唯一源**（卡 AT16 · 2026-09-16）
//
// 背景：仓1/仓3（AT15）、仓2（AT16）的采集脚本在 robocopy 单文件失败时不再 throw 整轮，改为
//   「退避重试 + 逐文件补试 + 显式告警 + 计数 + 台账」。台账落在 `<workspace>\logs\backup-collect-failures-*.json`
//   （每轮覆盖写；logs 不进任何仓）。但**只有人跑收工时看得见** —— 无人值守下采集不完整会被静默错过。
//
// 本文件把「台账是否代表当前异常」的判定收在一处（纯函数 judgeCollectFailures + 薄 IO 采集），
//   日报（tools\dsh-butler-panel\report.mjs 的 📡 同步健康段）与面板**只渲染**，不复制判据。
//
// 判定口径（为什么这么定）：
//   · **新鲜窗口**（默认 48h）：台账是「每轮覆盖写」的**瞬时快照**，陈旧台账不再代表当前状态
//     （仓可能只是很久没采集）⇒ 超窗不报，避免常年噪音。
//   · **有失败 ⇒ 🔴**（采集不完整 = 数据没进仓，必须直给，不打折成 ⚠️）。
//   · **只有重试救回 ⇒ 🟡**（本轮没丢东西，但发生过瞬时占用，值得知道频度）。
//   · **全 0 ⇒ 不产生任何行**（无失败不产生噪音 —— 卡 AT16 验收③）。
//   · **台账读不出/解析失败 ⇒ 🟡 且写明"不等于没有失败"**：解析失败绝不能退化成"看起来一切正常"
//     （红线：降级不得掩盖失败）。
//   · 明细条数上限（默认 5 条），其余折成一行指向台账文件。
//
// 归属：库（判定）+ 日报/面板（渲染）。日志目录可用 DSH_BUTLER_COLLECT_LEDGER_DIR 覆盖（测试隔离）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 台账新鲜度窗口（小时）：超窗视为陈旧快照，不参与判定。 */
export const FRESH_HOURS = 48;
/** 明细最多列几条（其余折成汇总行）。 */
export const MAX_DETAIL = 5;
/** 台账文件名前缀（仓1 dsh-core / 仓3 dsh-workspace / 仓2 dsh-sessions）。 */
export const LEDGER_GLOB_PREFIX = 'backup-collect-failures-';

/** 台账目录：env 覆盖 > DSH_WORKSPACE\logs > <workspace>\logs。 */
export function defaultLedgerDir(env = process.env) {
  const override = env.DSH_BUTLER_COLLECT_LEDGER_DIR;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  const ws = env.DSH_WORKSPACE;
  if (ws && String(ws).trim()) return path.join(path.resolve(String(ws).trim()), 'logs');
  return path.join(os.homedir(), 'DSH', 'logs');
}

function fmtShort(ms) {
  try {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return '—'; }
}

/**
 * 判定台账条目（**纯函数**，便于单测）。
 * @param {{entries?: Array<object>, now?: number, freshHours?: number, maxDetail?: number}} [opts]
 *   entries 每项：{ file, repo?, host?, lastRunAtMs?, failureCount?, recoveredCount?, failures?, recovered?, parseError? }
 * @returns {{ok:boolean, level:'red'|'yellow'|'green'|'none', lines:string[], rows:object[], reds:number, yellows:number, stale:number, fresh:number, silent:number, unreadable:number, freshHours:number}}
 */
export function judgeCollectFailures(opts = {}) {
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const freshHours = Number.isFinite(opts.freshHours) ? Number(opts.freshHours) : FRESH_HOURS;
  const maxDetail = Number.isFinite(opts.maxDetail) ? Math.max(0, Number(opts.maxDetail)) : MAX_DETAIL;

  const rows = [];
  const reds = []; const yellows = []; const unreadables = [];
  let stale = 0; let fresh = 0; let silent = 0;

  for (const e of entries) {
    const file = e?.file ?? '(unknown)';
    if (e?.parseError) {
      const row = { file, level: 'unreadable', repo: null, reason: String(e.parseError) };
      unreadables.push(row); rows.push(row); continue;
    }
    const at = Number(e.lastRunAtMs);
    const ageH = Number.isFinite(at) ? (now - at) / 3600000 : Infinity;
    if (!Number.isFinite(at) || ageH > freshHours) {
      const row = { file, level: 'stale', repo: e.repo ?? null, ageHours: Number.isFinite(ageH) ? Math.round(ageH) : null };
      stale++; rows.push(row); continue;
    }
    fresh++;
    const fails = Number(e.failureCount ?? (Array.isArray(e.failures) ? e.failures.length : 0)) || 0;
    const rec = Number(e.recoveredCount ?? (Array.isArray(e.recovered) ? e.recovered.length : 0)) || 0;
    const row = {
      file, repo: e.repo ?? null, host: e.host ?? null, lastRunAtMs: at, ageHours: Math.round(ageH),
      failureCount: fails, recoveredCount: rec,
      level: fails > 0 ? 'red' : (rec > 0 ? 'yellow' : 'green')
    };
    if (row.level === 'red') reds.push({ ...row, failures: Array.isArray(e.failures) ? e.failures : [] });
    else if (row.level === 'yellow') yellows.push({ ...row, recovered: Array.isArray(e.recovered) ? e.recovered : [] });
    else silent++;
    rows.push(row);
  }

  const lines = [];
  for (const r of reds) {
    const repo = r.repo ?? path.basename(r.file);
    lines.push(`- 🔴 采集不完整：仓 \`${repo}\`${r.host ? `（${r.host}）` : ''} 本轮 **${r.failureCount}** 个文件**没有**采进仓 · 台账更新 ${fmtShort(r.lastRunAtMs)} · \`${r.file}\``);
    const list = r.failures.slice(0, maxDetail);
    for (const f of list) {
      const code = f?.code ? `ERROR ${f.code}` : 'copy-item';
      const stage = f?.stage ? ` · ${f.stage}` : '';
      lines.push(`  - \`${code}\`${stage} · \`${f?.path ?? '?'}\``);
    }
    if (!r.failures.length) lines.push('  - （台账里只有计数、没有明细条目 —— 按未知失败处理，别当"没有失败"）');
    if (r.failureCount > list.length) lines.push(`  - …另有 ${r.failureCount - list.length} 条，全量见台账 \`${r.file}\``);
    lines.push('  - → 下次采集会自动再试；持续失败先查占用者（mmap/杀毒扫描窗口），别用 -Prune 掩盖');
  }
  for (const r of yellows) {
    const repo = r.repo ?? path.basename(r.file);
    lines.push(`- 🟡 采集重试恢复：仓 \`${repo}\`${r.host ? `（${r.host}）` : ''} 本轮 ${r.recoveredCount} 个文件在整轮重试/逐文件补试后被采到（非失败）· 台账更新 ${fmtShort(r.lastRunAtMs)}`);
  }
  for (const r of unreadables) {
    lines.push(`- 🟡 采集失败台账不可解析：\`${r.file}\`（${r.reason}）—— 判定不可得，**不等于没有失败**`);
  }

  const level = reds.length ? 'red' : ((yellows.length || unreadables.length) ? 'yellow' : (fresh ? 'green' : 'none'));
  return { ok: true, level, lines, rows, reds: reds.length, yellows: yellows.length, stale, fresh, silent, unreadable: unreadables.length, freshHours };
}

/** 读台账目录 → 判定条目（薄 IO，不做判定）。 */
export function readCollectFailureLedgers(logsDir, { now = Date.now() } = {}) {
  const dir = logsDir || defaultLedgerDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e?.code === 'ENOENT') return { logsDir: dir, entries: [], missing: true };
    throw e;
  }
  const entries = [];
  for (const name of names) {
    if (!name.startsWith(LEDGER_GLOB_PREFIX) || !name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { entries.push({ file, parseError: `读取失败：${e?.message ?? e}` }); continue; }
    let obj;
    try { obj = JSON.parse(raw); }
    catch (e) { entries.push({ file, parseError: `JSON 解析失败：${e?.message ?? e}` }); continue; }
    if (!obj || typeof obj !== 'object') { entries.push({ file, parseError: '台账不是对象' }); continue; }
    const at = Date.parse(String(obj.lastRunAt ?? ''));
    entries.push({
      file,
      repo: obj.repo ?? null,
      host: obj.host ?? null,
      schema: obj.schema ?? null,
      lastRunAtMs: Number.isFinite(at) ? at : null,
      failureCount: Number(obj.failureCount ?? 0) || 0,
      recoveredCount: Number(obj.recoveredCount ?? 0) || 0,
      failures: Array.isArray(obj.failures) ? obj.failures : [],
      recovered: Array.isArray(obj.recovered) ? obj.recovered : []
    });
  }
  // 固定顺序（仓1 → 仓2 → 仓3 之类按文件名），保证日报行序稳定
  entries.sort((a, b) => String(a.file).localeCompare(String(b.file)));
  void now;
  return { logsDir: dir, entries, missing: false };
}

/**
 * 采集入口（checks.mjs 调用）：IO + 判定，失败返回 ok:false（日报显式标"不可探测"，绝不静默省略）。
 * @param {{logsDir?:string, now?:number, freshHours?:number, maxDetail?:number}} [opts]
 */
export async function collectCollectFailures(opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  try {
    const { logsDir, entries, missing } = readCollectFailureLedgers(opts.logsDir, { now });
    const judged = judgeCollectFailures({ entries, now, freshHours: opts.freshHours, maxDetail: opts.maxDetail });
    return { ...judged, logsDir, ledgerFiles: entries.length, missingDir: !!missing, now };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// CLI（巡检/验收用）：node collect-failure-ledger.mjs [--json] [--logs <dir>]
// ---------------------------------------------------------------------------
function isMainEntry() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return !!argv1 && self.toLowerCase() === argv1.toLowerCase();
  } catch { return false; }
}

if (isMainEntry()) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node collect-failure-ledger.mjs [--json] [--logs <dir>]');
    console.log('  读采集失败台账（<workspace>\\logs\\backup-collect-failures-*.json）并按日报同一口径判定（纯只读）');
    process.exitCode = 0;
  } else {
    let logsDir = null; let asJson = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--json') asJson = true;
      else if (argv[i] === '--logs') { logsDir = argv[++i] ?? null; }
    }
    const res = await collectCollectFailures({ logsDir });
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else if (!res.ok) console.log(`❔ 采集失败台账：不可探测（${res.reason}）`);
    else if (!res.lines.length) console.log(`✅ 采集失败台账：无异常（${res.ledgerFiles} 份台账 · 目录 ${res.logsDir} · 新鲜 ${res.fresh} / 陈旧 ${res.stale}）`);
    else { console.log(`采集失败台账（level=${res.level}）：`); for (const l of res.lines) console.log(l); }
    process.exitCode = 0;   // 只读巡检，不因发现失败而给非零码（免得被上游当"命令失败"）
  }
}
