#!/usr/bin/env node
// ============================================================================
// butler-doc-discipline-cli.mjs —— 文档纪律 · 豁免台账【只读读取器】（C4·卡乙）
// ----------------------------------------------------------------------------
// 背景：家规第 10 条（紧急豁免通道）要求「7 天未补审 ⇒ 告警（tick 或日报段）」，
//   但台账 `~/.dsh/butler-doc-discipline.json` 此前**零读取器**（备料 §四 G-3 实证：
//   `recallDueBy` 全工具面只出现 1 次，就在一句注释里）⇒ 到期账没人算。
//   本文件 = 读取器（只读、零依赖、零副作用）；日报段接线见
//   `tools/dsh-butler-panel/lib/checks.mjs` 的 collectDocDiscipline()。
//
// 真源（实现逐条对应，改口径先改真源）：
//   · `docs\审核与回修文档纪律-方案-改版-20260924.md` 第 10 条 = 紧急豁免通道（冻结版）
//   · `docs\方案审核规程-横切四表与五环演练-20260910.md:291` = 落地权威清单（同文字 + 细则）
//   · `docs\审核与回修文档纪律-方案-20260924.md:118` = 早期版第 12 条（细则最全）
//   口径摘录：
//     ① 记录七字段 = at / by / reason / affectedDocs[] / recallCardId / recallDueBy / roundNo
//     ② `recallDueBy` = 登记日 + 7 天（补审期限）
//     ③ `recallCardId` 取值域 = 合法卡号 ｜ "待建"（**必填 recallDueBy**）｜ 其余（缺字段 / 空串）⇒ 拒登
//     ④ 7 天未补审 ⇒ 告警；**空态不得静默** —— `recallCardId` 为 "待建" 照报警
//        （真源写死文案「补审卡待建超期」），不得因「查不到卡」跳过
//
// 只读保证（红线）：
//   · 本文件不写任何文件（无 fs.write*）；不改台账；不查卡状态（那不属只读面）
//   · `--json` 时 stdout 只有 JSON —— 人类提示 / 告警一律走 stderr（不污染机器人读）
//
// 用法：
//   node <workspace>\tools\dsh-butler\butler-doc-discipline-cli.mjs --list
//   node <workspace>\tools\dsh-butler\butler-doc-discipline-cli.mjs --due [--within N]
//   node <workspace>\tools\dsh-butler\butler-doc-discipline-cli.mjs --list --json
//   node <workspace>\tools\dsh-butler\butler-doc-discipline-cli.mjs --due --today 2026-10-06   # 验算用
//   任选其一以外的路径参数：--ledger <文件>（默认 %USERPROFILE%\.dsh\butler-doc-discipline.json）
//
// 退出码：0 = 无到期/超期项（含空态）· 3 = 有到期/超期项 · 2 = 台账不可读或形态不认识 · 4 = 用法错误
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStatePath } from './lib/state-paths.mjs';

/** 真源七字段（顺序即真源书写顺序） */
const FIELDS = ['at', 'by', 'reason', 'affectedDocs', 'recallCardId', 'recallDueBy', 'roundNo'];
/** 真源写死的告警文案（"待建" 照报警用，逐字） */
const TEXT_CARD_PENDING = '补审卡待建超期';

const log = (msg) => process.stderr.write(msg + '\n'); // 人类输出一律 stderr（stdout 留给 JSON/报告）

// ---------------------------------------------------------------------------
// 路径与参数
// ---------------------------------------------------------------------------
function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}
function defaultLedger() {
  return resolveStatePath('butler-doc-discipline.json', { home: dshHome() }).path;
}

function parseArgs(argv) {
  const a = { list: false, due: false, json: false, within: 0, ledger: defaultLedger(), today: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--list') a.list = true;
    else if (t === '--due') a.due = true;
    else if (t === '--json') a.json = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--within') { const v = Number(argv[++i]); if (!Number.isFinite(v)) return { err: `--within 需要数字，收到 ${argv[i]}` }; a.within = v; }
    else if (t === '--ledger') { const v = argv[++i]; if (!v) return { err: '--ledger 需要路径' }; a.ledger = path.resolve(v); }
    else if (t === '--today') { const v = argv[++i]; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { err: `--today 需要 YYYY-MM-DD，收到 ${v}` }; a.today = v; }
    else return { err: `未知参数：${t}` };
  }
  if (!a.list && !a.due) a.list = true; // 默认 --list
  return a;
}

// ---------------------------------------------------------------------------
// 日期（日历日口径：两端都归一到 UTC 午夜，避免本地时区/夏令时把天数算歪）
// ---------------------------------------------------------------------------
function isoToUTCms(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}
function todayLocalISO(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
/** 目标日 - 今天 = 剩余天数（负 = 已超期） */
function daysLeft(dueISO, todayISO) {
  const d = isoToUTCms(dueISO);
  const t = isoToUTCms(todayISO);
  if (d === null || t === null) return null;
  return Math.round((d - t) / 86400000);
}

// ---------------------------------------------------------------------------
// 读台账 + 形态识别（认不出形态必须显式报，绝不静默放过 —— 与卡甲 G-1 同理念）
// ---------------------------------------------------------------------------
export function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, shape: 'unreadable', records: [], error: `读不到台账：${String(e?.message ?? e)}`, file };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, shape: 'bad-json', records: [], error: `JSON 解析失败：${String(e?.message ?? e)}`, file, bytes: Buffer.byteLength(text) };
  }
  const bytes = Buffer.byteLength(text);
  if (json && typeof json === 'object' && Array.isArray(json.records)) {
    return { ok: true, shape: 'records', schemaVersion: json.schemaVersion ?? null, records: json.records, file, bytes, note: '真源形态（{schemaVersion, records:[…]}）' };
  }
  if (json && typeof json === 'object' && FIELDS.some((f) => Object.prototype.hasOwnProperty.call(json, f))) {
    return { ok: true, shape: 'single', records: [json], file, bytes, note: '顶层单条记录形（历史形态 · check-rounds --ledger 认的那种）' };
  }
  return {
    ok: false, shape: 'unknown', records: [], file, bytes,
    error: `台账形态不认识（顶层键：${json && typeof json === 'object' ? Object.keys(json).join(', ') || '(无)' : typeof json}）—— 既非 {records:[…]} 也非单条记录形，本工具不猜`,
  };
}

// ---------------------------------------------------------------------------
// 逐条评估（只报不算、不改）
// ---------------------------------------------------------------------------
export function evaluateRecord(raw, todayISO) {
  const rec = raw && typeof raw === 'object' ? raw : {};
  const missing = FIELDS.filter((f) => rec[f] === undefined || rec[f] === null || (typeof rec[f] === 'string' && rec[f].trim() === ''));
  const cardIdRaw = rec.recallCardId;
  const cardId = typeof cardIdRaw === 'string' ? cardIdRaw.trim() : cardIdRaw === undefined ? null : String(cardIdRaw);
  const dueBy = typeof rec.recallDueBy === 'string' ? rec.recallDueBy.trim() : null;
  const isPending = cardId === '待建'; // 真源合法值之一（另一支 = 合法卡号）
  const dl = dueBy ? daysLeft(dueBy, todayISO) : null;

  // 真源拒登判据：recallCardId 缺字段 / 空串 ⇒ 拒登（"待建" 是合法值）
  //   "待建" 还额外要求「必填 recallDueBy」（真源 §12 / 改版第 10 条）
  const hard = [];
  if (cardId === null || cardId === '') hard.push('recallCardId 缺失或空串 ⇒ 真源判「拒登」');
  if (isPending && !dueBy) hard.push('recallCardId="待建" 但缺 recallDueBy ⇒ 真源判「拒登」');
  if (dueBy && dl === null) hard.push(`recallDueBy 不是 YYYY-MM-DD（收到 ${JSON.stringify(dueBy)}）`);

  // 软缺（其余字段真源未给拒登判据，只如实提示）
  const soft = missing.filter((f) => f !== 'recallCardId' && !(isPending && f === 'recallDueBy'));

  let status = 'upcoming';
  if (!dueBy || dl === null) status = 'undated';
  else if (dl < 0) status = 'overdue';
  else if (dl === 0) status = 'due-today';

  const affected = Array.isArray(rec.affectedDocs) ? rec.affectedDocs : rec.affectedDocs ? [rec.affectedDocs] : [];

  return {
    at: rec.at ?? null,
    by: rec.by ?? null,
    reason: typeof rec.reason === 'string' ? rec.reason : rec.reason === undefined ? null : String(rec.reason),
    affectedDocs: affected,
    recallCardId: cardId,
    recallDueBy: dueBy,
    roundNo: rec.roundNo === undefined ? null : rec.roundNo,
    daysLeft: dl,
    status,
    missingHard: hard,
    missingSoft: soft,
    pendingCard: isPending,
    // 真源「空态不得静默」：待建项到期后照报警，文案逐字用真源的
    alarm: status !== 'upcoming' && isPending ? TEXT_CARD_PENDING : null,
    raw: rec,
  };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const STATUS_CN = { overdue: '🔴 已超期', 'due-today': '🔴 今日到期', upcoming: '🟡 未到期', undated: '⚠️ 无到期日' };

function lineOf(r, i) {
  const out = [];
  const round = r.roundNo === null ? '—' : String(r.roundNo);
  const seat = r.recallDueBy ?? '(无)';
  const left = r.daysLeft === null ? '' : r.daysLeft < 0 ? `（超期 ${-r.daysLeft} 天）` : r.daysLeft === 0 ? '（今日到期）' : `（剩 ${r.daysLeft} 天）`;
  out.push(`  ${i + 1}) ${STATUS_CN[r.status]} ｜ 卡=${r.recallCardId ?? '(缺)'} ｜ 到期=${seat}${left} ｜ by=${r.by ?? '(缺)'} ｜ roundNo=${round} ｜ 登记=${r.at ?? '(缺)'}`);
  if (r.pendingCard) out.push(`     ⚠️ recallCardId="待建" ⇒ 真源「空态不得静默」：不得因查不到卡跳过${r.alarm ? `（告警文案：${r.alarm}）` : ''}`);
  if (r.reason) out.push(`     理由：${r.reason.length > 120 ? r.reason.slice(0, 120) + '…' : r.reason}`);
  out.push(`     受影响档：${r.affectedDocs.length} 件${r.affectedDocs.length ? `（${r.affectedDocs.slice(0, 3).map(String).join(' · ')}${r.affectedDocs.length > 3 ? ' …' : ''}）` : ''}`);
  if (r.missingHard.length) out.push(`     🔴 不合规：${r.missingHard.join('；')}`);
  if (r.missingSoft.length) out.push(`     ⚠️ 未填（真源七字段之一，本工具如实提示、不判拒登）：${r.missingSoft.join(', ')}`);
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.err) {
    log(`用法错误：${a.err}`);
    log('用法：--list | --due [--within N] [--json] [--ledger <file>] [--today YYYY-MM-DD]');
    return 4;
  }
  if (a.help) {
    log('文档纪律·豁免台账 只读读取器（真源 = 家规第 10 条）');
    log('  --list            列出全部记录（默认）');
    log('  --due [--within N] 列出到期/超期项（N=提前窗口天数，默认 0 = 今日到期与已超期）');
    log('  --json            机器可读（stdout 只放 JSON，人类提示走 stderr）');
    log('  --ledger <file>   指定台账文件（默认：状态目录下的文档纪律台账）');
    log('  --today <date>    指定"今天"（验算用，默认本机当日）');
    log('  ⚠️ 只读：本工具绝不写任何文件');
    return 0;
  }

  const todayISO = a.today ?? todayLocalISO();
  const led = readLedger(a.ledger);

  if (!led.ok) {
    const payload = { ok: false, file: led.file, shape: led.shape, error: led.error, today: todayISO };
    if (a.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else log(`🔴 台账读取失败：${led.error}\n   文件：${led.file}`);
    return 2;
  }

  const records = led.records.map((r) => evaluateRecord(r, todayISO));
  const selected = a.due
    ? records.filter((r) => r.status !== 'upcoming' || (r.daysLeft !== null && r.daysLeft <= a.within))
    : records;
  const overdue = records.filter((r) => r.status === 'overdue' || r.status === 'due-today');
  // 真源：7 天未补审（= 到期/超期）⇒ 告警；待建项到期后照报警（文案逐字用真源的）
  const alarming = overdue;

  if (a.json) {
    const payload = {
      ok: true,
      mode: a.due ? 'due' : 'list',
      today: todayISO,
      within: a.within,
      file: led.file,
      bytes: led.bytes,
      shape: led.shape,
      schemaVersion: led.schemaVersion ?? null,
      count: records.length,
      selectedCount: selected.length,
      dueCount: overdue.length,
      alarmCount: alarming.length,
      fieldOrder: FIELDS,
      records: selected,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    // 人类提示照走 stderr（铁律：--json 时 stdout 只放 JSON）
    log(`[doc-discipline] ${a.due ? '--due' : '--list'} · 台账 ${records.length} 条 · 选中 ${selected.length} · 到期/超期 ${overdue.length}`);
  } else {
    process.stdout.write(`文档纪律 · 豁免台账（只读；真源 = 家规第 10 条 / 记录七字段）\n`);
    process.stdout.write(`台账：${led.file}\n`);
    process.stdout.write(`形态：${led.shape}${led.note ? `（${led.note}）` : ''} ｜ 大小 ${led.bytes} B ｜ schemaVersion=${led.schemaVersion ?? '—'} ｜ 今天=${todayISO}\n`);
    if (!records.length) {
      process.stdout.write(`\n✅ **0 条**（空态：台账还没有任何豁免记录）—— 空态不静默：本行即"已读且确认为空"的证据。\n`);
      process.stdout.write(`   ⇒ 无到期账可算；家规第 10 条的「7 天未补审 ⇒ 告警」当前无判定对象。\n`);
    } else {
      process.stdout.write(`\n共 ${records.length} 条${a.due ? `（--due：命中 ${selected.length} 条，窗口 ${a.within} 天）` : ''}\n\n`);
      for (let i = 0; i < selected.length; i++) for (const l of lineOf(selected[i], i)) process.stdout.write(l + '\n');
      if (!selected.length) process.stdout.write('  （无到期/超期项）\n');
      const hardBad = records.filter((r) => r.missingHard.length);
      process.stdout.write(`\n汇总：超期/今日到期 **${overdue.length}** 条 ｜ 不合规（真源拒登形态）**${hardBad.length}** 条 ｜ 待建卡 ${records.filter((r) => r.pendingCard).length} 条\n`);
      for (const r of alarming) if (r.alarm) process.stdout.write(`🔔 告警文案（真源逐字）：${r.alarm} —— 卡=${r.recallCardId} 到期=${r.recallDueBy}\n`);
      if (hardBad.length) process.stdout.write(`⚠️ 有 ${hardBad.length} 条属真源「拒登」形态（recallCardId 缺/空串）：登记方应先在写入器侧拒登（本工具只读，不改）。\n`);
    }
    process.stdout.write('\n（本工具只读：不改台账、不查卡状态；到期告警的执行者另有其人 —— 真源写「tick 或日报段」。）\n');
  }
  return overdue.length ? 3 : 0;
}

// 入口守卫：junction 下 import.meta.url = 物理路径、argv[1] = 逻辑路径 ⇒ 必须 realpath 双方再比
function isMain() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const arg = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return self.toLowerCase() === arg.toLowerCase();
  } catch {
    return false;
  }
}
if (isMain()) process.exitCode = main();
