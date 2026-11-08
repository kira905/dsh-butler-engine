#!/usr/bin/env node
// ============================================================================
// dsh-butler / ledger-line.mjs —— 主线流水小本本的**人用手写 CLI**（§5.3 唯一写入口）
//
// 出处：docs\方案-三层角色工作方式与主线流水-V9.md
//   §5.3（L319-384）唯一写入口 + 写者守卫 + rc 表（0 已记/跳重 · 2 参数 · 3 环境 · 4 锁被占）
//   §5.1（L199-265）`_lines.json` 容器 / `lineId` = `l-<hostTag()>-<NNN>` / `sid` 落盘裸 uuid
//   §5.2（L266-318）写序六步（抢锁 → 读尾 → 跳重判断 → append → 释放）
//   §14.2 P1（L1129）判据 ①~⑦
//
// 🔴 本文件**一个写盘 API 都不许有**（`appendFileSync` / `writeFileSync` / `mkdirSync` /
//   `renameSync` / `openSync` … 全部禁）：所有落盘一律调 `lib\mainline-ledger-writer.mjs`
//   （§5.0 不变量 2）。机械判据：
//     node <pkg>\jobs\ledger-writer-audit.mjs --root <workspace>\tools\dsh-butler --json
//   ⇒ 碰 `mainline-ledger\` 的直接写者**只允许** `lib\mainline-ledger-writer.mjs` 一个；
//     本文件应落在 `indirect`（import writer 并调它的写函数）。
//
// 三个 home 别混（这是本卡最容易踩错的一处）：
//   --home <dir>         **账本**家目录（缺省 `~/.dsh`；夹具一律传临时目录）
//   --board-home <dir>   **看板账本**家目录（缺省 = 真实 dsh home；`--from-task-board` 与
//                        cards 六计数都读它 —— 判据①要"并集 43 条线"，43 条只可能来自真账本）
//   会话日志始终读**真实** dsh home（`sessions\<ws>\<sid>\` 不在夹具里）
//
// 用法（rc 表见 §5.3 L372-379）：
//   node ledger-line.mjs --line <名或 lineId> --phase <10 态之一> [--did "…"] [--next "…"]
//        [--anchor <id>] [--ref <卡id/档>] [--by self|hook|scan] [--for-turn <n>]
//        [--voids "<裸uuid>#<turn>"] [--reason "…"] [--src gui|qq-c2c|qq-group|card|router|scan]
//        [--home <dir>] [--json] [--dry-run] [--no-cards]
//   node ledger-line.mjs --register-line [--from-task-board] [--line "字面值"] [--aliases "a,b"] [--dry-run]
//   node ledger-line.mjs --alias <lineId> --add "别名"            # 也收 --line <lineId> --aliases "a,b"；收 --dry-run
//   node ledger-line.mjs --claim --sid <裸uuid> --line <名或 lineId> [--dry-run]
//   node ledger-line.mjs --claim --pending <u-id> --line <名或 lineId> [--dry-run]
//
// 🔎 `--dry-run` 覆盖**全部四条写路径**（2026-11-04 修：此前只有"写一行流水"那条有 dry-run
//   分支，--register-line / --alias / --claim / --from-task-board 四条的参数被静默丢掉、
//   照样真写 ⇒ 「以为只是预演」结果落了盘）。落地方式 = 单点收口：所有落盘只经
//   `commitWriteLinesMap` / `commitAppendSid` / `commitAppendUnmapped` 三个口，
//   dry-run 时它们只做只读推演、连 writer 的 `ensureHome`（mkdir + _meta.json）都不调。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

import { dshHome, realOrResolve } from '../src/dsh-butler/lib/paths.mjs';
import { hostTag } from '../src/dsh-butler/lib/host-tag.mjs';
import { PHASES, isPhase } from './lib/ledger-phases.mjs';
import { readSessionHeader } from './lib/session-header.mjs';
import { readEvents } from './lib/session-events.mjs';
import { readArchivedCardsSync } from '../src/lib/board-archive-view.mjs';
import {
  appendRow,
  appendOps,
  appendSid,
  appendUnmapped,
  writeLinesMap,
  readLinesMap,
  readUnmappedLatest,
  ensureHome,
  isoWithOffset,
  normalizeSid,
  isLineId,
  isBareUuid,
  // 2026-11-04 修 dry-run：只读推演要用 writer 的同一套常量与归一函数（保证数字与真跑一致）
  LEDGER_DIR_NAME,
  LINES_FILE_NAME,
  SID_DEDUP_BYTES,
  ROW_VERSION,
  SID_HOW_VALUES,
  normalizeLinesMap,
} from './lib/mainline-ledger-writer.mjs';

const TOOL = 'ledger-line';
const SRC_VALUES = ['gui', 'qq-c2c', 'qq-group', 'card', 'router', 'scan'];
const CARD_STATUSES = ['backlog', 'todo', 'running', 'review', 'failed', 'done'];
const BOOL_FLAGS = new Set([
  'register-line', 'alias', 'claim', 'from-task-board', 'json', 'dry-run', 'no-cards', 'help',
]);
const VALUE_FLAGS = new Set([
  'line', 'phase', 'did', 'next', 'anchor', 'ref', 'by', 'for-turn', 'voids', 'reason', 'src',
  'home', 'board-home', 'aliases', 'add', 'sid', 'pending',
]);

// ---------------------------------------------------------------------------
// 参数 / 输出
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [], unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith('--')) { a._.push(tok); continue; }
    const name = tok.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { a[name] = ''; continue; }
      a[name] = v;
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(name)) { a[name] = true; continue; }
    a.unknown.push(name);
  }
  return a;
}

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const splitList = (s) => String(s ?? '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.length > n ? s.slice(0, n) : s;
};

/** 一次运行的输出上下文（`--json` 时只打一行 JSON） */
const OUT = { json: false };

// ---------------------------------------------------------------------------
// 🔎 dry-run 统一闸（2026-11-04 修：这四条写路径此前**根本没有** dry-run 分支）
//
// 缺陷原样：`--dry-run` 在 BOOL_FLAGS 白名单里（L62）⇒ 解析时被接受、不报错；但
//   `--register-line` / `--alias` / `--claim` / `--from-task-board` 四条路径上没有任何
//   分支消费它 ⇒ 参数被静默丢掉、照样真写 `_lines.json` / `_sids\*` / 未归线队列。
//   这是铁律「`--help` 对不认识的脚本无效 ⇒ 参数被忽略后直接执行真动作」的活样本。
//
// 为什么收成一个闸、而不是四个模式各写一遍：
//   `_lines.json` / `_sids` 都是 append-only、写错就是永久债，漏一个就是"以为预演、实际落盘"。
//   ⇒ 所有落盘只许过下面三个 commit*；将来新增模式也只许走这三个口。
//   守卫：`ledger-writer-audit.mjs` 仍须落在 indirect（本段只读：readFileSync / statSync，
//   **不出现任何写盘 API**）。
//
// 语义（与写行模式那条 dry-run 对齐）：打印 `🔎 dry-run（未写）` + 将要写的内容 · rc=0 ·
//   零字节落盘。连 writer 内部 `ensureHome` 的 mkdir + `_meta.json` 都不许发生 ⇒ dry-run 分支
//   一律不调 writer。
// ---------------------------------------------------------------------------
const RUN = { dryRun: false };
const isDry = () => RUN.dryRun === true;

/** `<home>\mainline-ledger\<rest…>`（与 writer.ledgerDir 同口径，只读用） */
function ledgerPath(home, ...rest) {
  return path.join(home, LEDGER_DIR_NAME, ...rest);
}

/** 只读：`_meta.json` 的 schemaVersion（缺失/坏 ⇒ null；dry-run 下代替 ensureHome().schemaVersion） */
function peekSchemaVersion(home) {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath(home, '_meta.json'), 'utf8'));
    const sv = Number(j?.schemaVersion ?? 1);
    return Number.isFinite(sv) ? sv : null;
  } catch {
    return null;
  }
}

/**
 * `_lines.json` 的干跑推演：算法与 writer.writeLinesMap 内部**同口径**
 *   （normalizeLinesMap(readLinesMap(home)) ⇒ mutator ⇒ normalizeLinesMap），只是不落盘。
 * 所以 dry-run 打出来的「新建 N / 已存在 M / 现有 T / next」就是真跑会得到的那组数。
 */
function planLinesMap(home, mutator) {
  const file = ledgerPath(home, LINES_FILE_NAME);
  const cur = normalizeLinesMap(readLinesMap(home));
  const nextRaw = mutator(cur);
  if (nextRaw && nextRaw.skip === true) {
    return { rc: 0, action: 'lines-unchanged', file, map: cur, reason: nextRaw.reason ?? null, dryRun: true };
  }
  return { rc: 0, action: 'dry-run', dryRun: true, file, map: normalizeLinesMap(nextRaw) };
}

/** 唯一 `_lines.json` 写口（dry-run ⇒ 只读推演） */
function commitWriteLinesMap(home, mutator) {
  if (!isDry()) return writeLinesMap(home, mutator);
  return planLinesMap(home, mutator);
}

/**
 * 只读：`_sids\<lineId>.jsonl` 尾部 `SID_DEDUP_BYTES` 内是否已有该 sid。
 * 判重窗口与 writer.appendSid 一致（截断进来时丢第一段半行，坏行跳过）。
 */
function sidAlreadyInFile(file, bare) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile() || st.size <= 0) return false;
  let text;
  try {
    const buf = fs.readFileSync(file);
    const start = Math.max(0, buf.length - SID_DEDUP_BYTES);
    text = buf.subarray(start).toString('utf8');
    if (start > 0) text = text.split(/\r?\n/).slice(1).join('\n');
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && String(o.sid) === bare) return true;
    } catch { /* 坏行/半行跳过，与 writer.parseJsonlTail 同口径 */ }
  }
  return false;
}

/** `_sids` 的干跑推演（判重照做 ⇒ 能提前说清"真跑会是 sid-dup-skip 还是 append"） */
function planAppendSid(home, lineId, bare, how) {
  const file = ledgerPath(home, '_sids', `${lineId}.jsonl`);
  if (sidAlreadyInFile(file, bare)) {
    return { rc: 0, action: 'sid-dup-skip', file, dryRun: true };
  }
  return {
    rc: 0, action: 'sid-appended', file, dryRun: true,
    wouldAppend: { v: ROW_VERSION, ts: isoWithOffset(), sid: bare, how: SID_HOW_VALUES.includes(how) ? how : 'claim' },
  };
}

/** 唯一 `_sids` 写口 */
function commitAppendSid(home, lineId, bare, how) {
  if (!isDry()) return appendSid(home, lineId, bare, how);
  return planAppendSid(home, lineId, bare, how);
}

/** 未归线队列的干跑推演（行内容与 writer.appendUnmapped 构造的 row 同形） */
function planAppendUnmapped(home, event) {
  const e = event ?? {};
  const file = ledgerPath(home, `${hostTag()}-unmapped.jsonl`);
  const id = clip(e.id ?? '', 80);
  let row;
  if (e.claimed === true) {
    row = { id, claimed: true, claimedAs: clip(e.claimedAs ?? '', 60), claimedAt: e.claimedAt || isoWithOffset() };
  } else {
    const bare = normalizeSid(e.sid);
    row = {
      id,
      ts: e.ts || isoWithOffset(),
      literal: clip(e.literal ?? '', 200),
      sid: isBareUuid(String(bare ?? '')) ? bare : null,
      turn: Number.isInteger(Number(e.turn)) ? Number(e.turn) : 0,
    };
  }
  return {
    rc: 0,
    action: e.claimed === true ? 'unmapped-claimed' : 'unmapped-appended',
    file, id, dryRun: true, wouldAppend: row,
  };
}

/** 唯一未归线队列写口 */
function commitAppendUnmapped(home, event) {
  if (!isDry()) return appendUnmapped(home, event);
  return planAppendUnmapped(home, event);
}

function emit(result, humanLines) {
  if (OUT.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    for (const l of humanLines) process.stdout.write(l + '\n');
  }
  process.exitCode = result.rc;
  return result;
}

/** 记一行 `.ops`（**best-effort**：ops 自己也写不下去只上 stderr，不覆盖原 rc） */
function noteOps(home, lineId, op) {
  if (isDry()) {
    // dry-run 也要零字节：bad-args / line-not-found / out-of-scope 这些路径都会走到这里
    process.stderr.write(`🔎 dry-run：跳过 .ops 写入（${op?.phase ?? 'ops'}）\n`);
    return { rc: 0, action: 'dry-run-skipped', file: null };
  }
  try {
    const r = appendOps(home, lineId, op);
    if (r.rc !== 0) process.stderr.write(`⚠️ .ops 写不下去（${r.action} / ${r.error ?? ''}）\n`);
    return r;
  } catch (e) {
    process.stderr.write(`⚠️ .ops 写不下去（${e?.code ?? e}）\n`);
    return { rc: 3, action: 'ops-write-failed' };
  }
}

function badArgs(home, reason, extra = {}, lineId = null) {
  noteOps(home, lineId, { phase: 'bad-args', reason, ...extra });
  return emit({ rc: 2, tool: TOOL, action: 'bad-args', reason, ...extra }, [`❌ 参数错（rc=2）：${reason}`]);
}

// ---------------------------------------------------------------------------
// `_lines.json` 解析（**只读**；写一律走 writer.writeLinesMap）
// ---------------------------------------------------------------------------
function resolveLine(home, literal) {
  const raw = String(literal ?? '').trim();
  if (!raw) return { lineId: null, via: null };
  if (isLineId(raw)) {
    const map = readLinesMap(home);
    const hit = (map?.lines ?? []).find((l) => l.lineId === raw);
    return { lineId: raw, line: hit?.line ?? null, via: 'lineId' };
  }
  const map = readLinesMap(home);
  const k = norm(raw);
  const lines = Array.isArray(map?.lines) ? map.lines : [];
  const exact = lines.find((l) => norm(l.line) === k);
  if (exact) return { lineId: exact.lineId, line: exact.line, via: 'line' };
  const byAlias = lines.find((l) => (l.aliases ?? []).some((x) => norm(x) === k));
  if (byAlias) return { lineId: byAlias.lineId, line: byAlias.line, via: 'alias' };
  return { lineId: null, via: null, lines: lines.length };
}

function lineAliasSet(home, lineId, line) {
  const map = readLinesMap(home);
  const hit = (map?.lines ?? []).find((l) => l.lineId === lineId);
  const names = new Set();
  if (line) names.add(line);
  if (hit?.line) names.add(hit.line);
  for (const a of hit?.aliases ?? []) names.add(a);
  return [...names].filter(Boolean);
}

// ---------------------------------------------------------------------------
// 会话侧：actor 判定（两形态都试）+ turn 取号 + 是否已 turn/end
// ---------------------------------------------------------------------------
function probeActor(sid, sessionHome) {
  const bare = normalizeSid(sid);
  if (!bare) return { known: false, reason: 'no-sid' };
  const forms = sid && sid.startsWith('session-') ? [sid, bare] : [bare, `session-${bare}`];
  for (const form of forms) {
    const h = readSessionHeader(form, sessionHome);
    if (h && h.header) {
      const header = h.header;
      const parts = String(h.file ?? '').split(/[\\/]/);
      const workspace = parts.length >= 3 ? parts[parts.length - 3] : null; // <home>\sessions\<ws>\<sid>\<log>
      return {
        known: true,
        form,
        file: h.file,
        workspace,
        isCardSession: /card-sessions/i.test(String(workspace ?? '')),
        isSubagent: header.origin === 'subagent' || Boolean(header.parentSession),
      };
    }
  }
  // §5.3 L361：两形态都不中 ⇒ 不猜，写行照做但标 scope:"unknown"
  return { known: false, reason: 'both-forms-missed' };
}

function sessionTurn(sid, sessionHome) {
  const r = readEvents(sid, { types: ['turn/start'], lastN: 1, home: sessionHome });
  const ev = r.events && r.events[0];
  const turn = Number(ev?.data?.turn);
  return {
    turn: Number.isInteger(turn) && turn > 0 ? turn : null,
    file: r.file,
    frames: r.frames,
    frameFail: r.stats?.frameFail ?? 0,
  };
}

/** 该轮是否已有 `turn/end`（有 ⇒ 行内标 `late:true`；补记还要 atTurn）。 */
function turnEnd(sid, turn, sessionHome) {
  const r = readEvents(sid, { types: ['turn/end'], lastN: 0, home: sessionHome });
  const hit = (r.events ?? []).filter((e) => Number(e?.data?.turn) === Number(turn)).pop();
  if (!hit) return null;
  const ms = Number(hit.time);
  return {
    ms: Number.isFinite(ms) ? ms : null,
    iso: Number.isFinite(ms) ? isoWithOffset(new Date(ms)) : null,
    kind: hit?.data?.reason?.kind ?? null,
  };
}

// ---------------------------------------------------------------------------
// cards 六计数（§7.3 合流口径：账本按 status 数；归档只补 done）
// ---------------------------------------------------------------------------
function computeCards(boardHome, lineNames) {
  const wanted = new Set((lineNames ?? []).map(norm).filter(Boolean));
  const counts = Object.fromEntries(CARD_STATUSES.map((k) => [k, 0]));
  const ledgerFile = path.join(boardHome, 'task-board', 'ledger-v2.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  } catch (e) {
    return { cards: {}, state: 'unavailable', reason: `board-ledger-${e?.code ?? 'ERR'}` };
  }
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : Object.values(raw?.tasks ?? {});
  for (const t of tasks) {
    if (!wanted.has(norm(t?.line))) continue;
    const st = String(t?.status ?? '');
    if (st in counts) counts[st] += 1;
  }
  try {
    const av = readArchivedCardsSync(boardHome);
    for (const c of av.cards ?? []) {
      if (String(c?.status) !== 'done') continue; // 归档里 failed 那 1 张不进任何一格（§7.3 第 3 条）
      if (wanted.has(norm(c?.line))) counts.done += 1;
    }
  } catch (e) {
    return { cards: counts, state: 'unavailable', reason: `archive-${e?.code ?? 'ERR'}` };
  }
  return { cards: counts, state: 'ok' };
}

// ---------------------------------------------------------------------------
// `--did` / `--next` 的软校验（§5.3 L345；T-49 未拍 ⇒ **只警告不拒写**）
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9]{32,}/, what: 'API key 片段（sk-…）' },
  { re: /Bearer\s+[A-Za-z0-9._-]{16,}/i, what: 'Bearer 令牌' },
  { re: /password\s*=/i, what: 'password=' },
  { re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.1[6-9]\.\d{1,3}\.\d{1,3})\b/, what: '内网地址' },
];

function softSecretCheck(fields) {
  const hits = [];
  for (const [name, value] of Object.entries(fields)) {
    const s = String(value ?? '');
    if (!s) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(s)) hits.push({ field: name, what: p.what });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 模式①：--register-line（建线 / 建线+别名）
// ---------------------------------------------------------------------------
function collectFromTaskBoard(boardHome) {
  const out = { board: new Set(), archived: new Set(), errors: [] };
  const ledgerFile = path.join(boardHome, 'task-board', 'ledger-v2.json');
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : Object.values(raw?.tasks ?? {});
    for (const t of tasks) {
      const s = String(t?.line ?? '').trim();
      if (s) out.board.add(s);
    }
  } catch (e) {
    out.errors.push(`账本读不到（${ledgerFile}）：${e?.code ?? e}`);
  }
  try {
    // 用原件 cards[]（不是 readArchivedLineCountsSync —— 它只有 byLine 计数、没有 status 维度）
    const av = readArchivedCardsSync(boardHome);
    for (const c of av.cards ?? []) {
      const s = String(c?.line ?? '').trim();
      if (s) out.archived.add(s);
    }
    if (av.errors?.length) out.errors.push(...av.errors.slice(0, 3));
  } catch (e) {
    out.errors.push(`归档读不到：${e?.code ?? e}`);
  }
  return out;
}

function cmdRegister(a, home) {
  const boardHome = a['board-home'] ? path.resolve(a['board-home']) : dshHome();
  const literals = [];
  let srcInfo = null;
  if (a['from-task-board']) {
    const scanned = collectFromTaskBoard(boardHome);
    srcInfo = {
      boardHome,
      boardLineValues: scanned.board.size,
      archivedLineValues: scanned.archived.size,
      union: new Set([...scanned.board, ...scanned.archived]).size,
      errors: scanned.errors,
    };
    for (const v of scanned.board) literals.push(v);
    for (const v of scanned.archived) literals.push(v);
  }
  if (a.line) literals.push(String(a.line).trim());

  // 去重（按归一化键；字面值保留首次出现的写法）
  const seenKey = new Set();
  const uniq = [];
  for (const raw of literals) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const k = norm(s);
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    uniq.push(s);
  }
  if (!uniq.length) return badArgs(home, '没有线名可建（给 --line 或 --from-task-board）');

  const aliasForSingle = uniq.length === 1 ? splitList(a.aliases ?? a.add ?? '') : [];
  const now = isoWithOffset();
  const created = [];
  const existed = [];
  const res = commitWriteLinesMap(home, (cur) => {
    const idx = new Map();
    for (const l of cur.lines) {
      idx.set(norm(l.line), l.lineId);
      for (const al of l.aliases ?? []) idx.set(norm(al), l.lineId);
    }
    let next = cur.next;
    const lines = cur.lines.slice();
    for (const literal of uniq) {
      const k = norm(literal);
      if (idx.has(k)) { existed.push(literal); continue; }
      const lineId = `l-${hostTag()}-${String(next).padStart(3, '0')}`;
      next += 1;
      lines.push({
        lineId,
        line: literal,
        aliases: aliasForSingle.slice(),
        createdAt: now,
        ledgerSince: now, // §5.1 L205：建线时设为"现在"，不许设成过去
      });
      idx.set(k, lineId);
      created.push({ lineId, line: literal });
    }
    if (!created.length) return { skip: true, reason: 'all-exist' };
    return { ...cur, next, lines };
  });

  if (res.rc !== 0) {
    return emit(
      { rc: res.rc, tool: TOOL, action: res.action, reason: res.reason ?? res.error ?? null },
      [`❌ 建线失败（rc=${res.rc}）：${res.action}`],
    );
  }
  const total = res.map?.lines?.length ?? 0;
  const dry = res.dryRun === true;
  const result = {
    rc: 0, tool: TOOL, action: dry ? 'dry-run' : 'lines-written', home, file: res.file,
    created: created.length, existed: existed.length, next: res.map?.next ?? null,
    total, src: srcInfo, createdLines: created,
    // dry-run 下**不许**调 ensureHome（它会 mkdir + 写 _meta.json）⇒ 只读读一眼
    schemaVersion: dry ? peekSchemaVersion(home) : ensureHome(home).schemaVersion,
  };
  if (dry) { result.dryRun = true; result.wouldAction = 'lines-written'; }
  const human = [
    dry
      ? `🔎 dry-run（未写）：将新建 ${created.length} 条 / 已存在 ${existed.length} 条 ⇒ 预计 ${total} 条线（next=${result.next}）`
      : `✅ 建线完成：新建 ${created.length} 条 / 已存在 ${existed.length} 条 ⇒ 现有 ${total} 条线（next=${result.next}）`,
    srcInfo
      ? `   口径（现跑）：账本 ${srcInfo.boardLineValues} 个 line 值 / 归档 ${srcInfo.archivedLineValues} 个 / 并集 ${srcInfo.union}`
      : `   口径：显式 --line（${uniq.length} 个）`,
    dry ? `   _lines.json（未写）：${res.file}` : `   _lines.json：${res.file}`,
  ];
  if (dry) for (const c of created) human.push(`   + ${c.lineId}  ${c.line}`);
  if (srcInfo?.errors?.length) human.push(`   ⚠️ ${srcInfo.errors.slice(0, 2).join('；')}`);
  return emit(result, human);
}

// ---------------------------------------------------------------------------
// 模式②：--alias（加别名）
// ---------------------------------------------------------------------------
function cmdAlias(a, home) {
  // 两种写法都收：`--alias <lineId> --add "a,b"` 与 `--alias --line <lineId> --aliases "a,b"`
  const positional = a._ && a._.length ? String(a._[0]).trim() : '';
  const target = String((a.alias && a.alias !== true ? a.alias : (a.line || positional)) ?? '').trim();
  const adds = splitList(a.add ?? a.aliases ?? '');
  if (!target) return badArgs(home, '--alias 需要 lineId（`--alias <lineId>` 或 `--line <lineId>`）');
  if (!adds.length) return badArgs(home, '--add / --aliases 为空', {}, isLineId(target) ? target : null);

  const state = { found: null, added: [] };
  const res = commitWriteLinesMap(home, (cur) => {
    const hit = cur.lines.find((l) => l.lineId === target)
      ?? cur.lines.find((l) => norm(l.line) === norm(target))
      ?? cur.lines.find((l) => (l.aliases ?? []).some((x) => norm(x) === norm(target)));
    if (!hit) return { skip: true, reason: 'line-not-found' };
    state.found = hit.lineId;
    const have = new Set([norm(hit.line), ...(hit.aliases ?? []).map(norm)]);
    const nextAliases = [...(hit.aliases ?? [])];
    for (const x of adds) {
      if (have.has(norm(x))) continue;
      have.add(norm(x));
      nextAliases.push(x);
      state.added.push(x);
    }
    if (!state.added.length) return { skip: true, reason: 'alias-exists' };
    hit.aliases = nextAliases;
    return cur;
  });

  const dry = res.dryRun === true;
  if (res.rc !== 0) {
    return emit({ rc: res.rc, tool: TOOL, action: res.action }, [`❌ 别名写入失败（rc=${res.rc}）：${res.action}`]);
  }
  if (res.action === 'lines-unchanged' && res.reason === 'line-not-found') {
    // noteOps 在 dry-run 下自己会跳过（见 noteOps 的口），rc 仍是 2（"我传错了"，与写不写无关）
    noteOps(home, isLineId(target) ? target : null, { phase: 'bad-args', reason: 'alias-line-not-found' });
    return emit({ rc: 2, tool: TOOL, action: 'line-not-found', target }, [`❌ 参数错（rc=2）：_lines.json 里没有这条线（${target}）`]);
  }
  if (res.action === 'lines-unchanged') {
    return emit(
      {
        rc: 0, tool: TOOL, action: dry ? 'dry-run' : 'alias-exists', lineId: state.found, added: [],
        ...(dry ? { dryRun: true, wouldAction: 'alias-exists' } : {}),
      },
      [dry
        ? `🔎 dry-run（未写）：已存在（${state.found}）：${adds.join('、')} 已在别名表里，真跑不重复写`
        : `已存在（${state.found}）：${adds.join('、')} 已在别名表里`],
    );
  }
  return emit(
    {
      rc: 0, tool: TOOL, action: dry ? 'dry-run' : 'alias-added', lineId: state.found, added: state.added, file: res.file,
      ...(dry ? { dryRun: true, wouldAction: 'alias-added' } : {}),
    },
    [dry
      ? `🔎 dry-run（未写）：将给 ${state.found} 加别名 ${state.added.join('、')}`
      : `✅ 已加别名（${state.found}）：${state.added.join('、')}`],
  );
}

// ---------------------------------------------------------------------------
// 模式③：--claim（--sid 直接登记 / --pending 认领未归线）
// ---------------------------------------------------------------------------
function cmdClaim(a, home) {
  if (a.pending) {
    const id = String(a.pending).trim();
    const q = readUnmappedLatest(home);
    const hit = q.events.get(id);
    if (!hit) return badArgs(home, `未归线队列里没有这个 id（${id}）`);
    if (hit.claimed === true) {
      return emit({ rc: 0, tool: TOOL, action: 'already-claimed', id, claimedAs: hit.claimedAs ?? null },
        [`已认领（${id} → ${hit.claimedAs ?? '?'}），不重复写`]);
    }
    if (!a.line) return badArgs(home, '--claim --pending 需要 --line 指定认领到哪条线');
    const r = resolveLine(home, a.line);
    if (!r.lineId) return badArgs(home, `未归线：--line 不认（${a.line}）`);
    const ev = commitAppendUnmapped(home, { id, claimed: true, claimedAs: r.lineId, claimedAt: isoWithOffset() });
    if (ev.rc !== 0) return emit({ rc: ev.rc, tool: TOOL, action: ev.action }, [`❌ 认领写不下去（rc=${ev.rc}）：${ev.action}`]);
    const dryPending = ev.dryRun === true;
    return emit(
      {
        rc: 0, tool: TOOL, action: dryPending ? 'dry-run' : 'unmapped-claimed', id, lineId: r.lineId, file: ev.file,
        ...(dryPending ? { dryRun: true, wouldAction: 'unmapped-claimed' } : {}),
      },
      [dryPending ? `🔎 dry-run（未写）：将认领（${id} → ${r.lineId}）` : `✅ 已认领（${id} → ${r.lineId}）`],
    );
  }

  const bare = a.sid ? normalizeSid(a.sid) : null;
  if (!bare) return badArgs(home, '--claim --sid 缺 sid（或给 --pending <id>）');
  if (!isBareUuid(bare)) return badArgs(home, `sid 不是裸 uuid：${clip(a.sid, 60)}`);
  if (!a.line) return badArgs(home, '--claim 需要 --line');
  const r = resolveLine(home, a.line);
  if (!r.lineId) return badArgs(home, `未归线：--line 不认（${a.line}）`);
  const res = commitAppendSid(home, r.lineId, bare, 'claim');
  const dry = res.dryRun === true;
  if (res.rc !== 0) {
    return emit({ rc: res.rc, tool: TOOL, action: res.action, reason: res.reason ?? null },
      [`❌ 登记失败（rc=${res.rc}）：${res.action}${res.reason ? ' / ' + res.reason : ''}`]);
  }
  if (res.action === 'sid-dup-skip') {
    return emit(
      {
        rc: 0, tool: TOOL, action: dry ? 'dry-run' : 'sid-dup-skip', lineId: r.lineId, sid: bare, file: res.file,
        ...(dry ? { dryRun: true, wouldAction: 'sid-dup-skip' } : {}),
      },
      [dry
        ? `🔎 dry-run（未写）：sid 已在列（${r.lineId}），真跑会是 sid-dup-skip、不重复 append`
        : `已登记（sid 已在列：${r.lineId}），不重复 append`],
    );
  }
  const body = { rc: 0, tool: TOOL, action: dry ? 'dry-run' : 'sid-appended', lineId: r.lineId, sid: bare, file: res.file };
  if (dry) {
    body.dryRun = true;
    body.wouldAction = 'sid-appended';
    body.wouldAppend = res.wouldAppend ?? null;
  } else {
    body.bytes = res.bytes; // 不带 dry-run 时字段与改前逐字一致
  }
  return emit(body, [dry ? `🔎 dry-run（未写）：将登记（${r.lineId} ← ${bare}）` : `✅ 已登记（${r.lineId} ← ${bare}）`]);
}

// ---------------------------------------------------------------------------
// 模式④：写一行流水（主路径）
// ---------------------------------------------------------------------------
function cmdWrite(a, home) {
  const sessionHome = dshHome(); // 会话日志恒读真实 home（夹具不放会话）
  const fixture = realOrResolve(home) !== realOrResolve(sessionHome);

  // ---- 参数与写者守卫（rc=2：都是"我传错了"）----
  if (!a.line) return badArgs(home, '--line 必填且无缺省（写端不猜线）');
  if (!a.phase) return badArgs(home, '--phase 必填（取值见 lib/ledger-phases.mjs 的 PHASES）');
  const phase = String(a.phase).trim();
  if (phase === 'recovered') {
    // §5.3 L337：recovered 不在 PHASES 里，只有 ledger-repair 的收据行才写它
    return badArgs(home, 'recovered 不在 PHASES 里（只有 ledger-repair --compact 的收据行才写它）');
  }
  if (!isPhase(phase)) {
    return badArgs(home, `--phase 不在 PHASES 白名单里：${clip(phase, 40)}（合法值 ${Object.keys(PHASES).join(' / ')}）`);
  }
  const def = PHASES[phase];
  const by = String(a.by ?? 'self').trim();
  if (!['self', 'hook', 'scan'].includes(by)) return badArgs(home, `--by 只认 self / hook / scan（收到 ${clip(by, 20)}）`);
  if (Array.isArray(def.byWhitelist) && !def.byWhitelist.includes(by)) {
    // 判据②：`--by self --phase scan-fill` ⇒ rc 2
    return badArgs(home, `--phase ${phase} 只许 --by ${def.byWhitelist.join('/')} 传（收到 --by ${by}）`);
  }
  const forTurnRaw = a['for-turn'];
  const forTurn = forTurnRaw == null || forTurnRaw === '' ? null : Number(forTurnRaw);
  if (forTurn != null && (!Number.isInteger(forTurn) || forTurn < 1)) return badArgs(home, `--for-turn 非法：${clip(forTurnRaw, 20)}`);
  if (forTurn != null && by !== 'scan') return badArgs(home, '--for-turn 只许 --by scan 传');
  if (phase === 'void') {
    const v = String(a.voids ?? '').trim();
    if (!v) return badArgs(home, '--phase void 必须带 --voids "<裸uuid>#<turn>"');
    if (!String(a.reason ?? '').trim()) return badArgs(home, '--phase void 必须带 --reason "一句为什么"');
    if (!/^[0-9a-fA-F-]{36}#\d+$/.test(v) || !isBareUuid(v.split('#')[0])) {
      return badArgs(home, `--voids 形状必须是 <裸uuid>#<turn>（收到 ${clip(v, 60)}）`);
    }
  }
  const src = String(a.src ?? (by === 'scan' ? 'scan' : 'gui')).trim();
  if (!SRC_VALUES.includes(src)) return badArgs(home, `--src 只认 ${SRC_VALUES.join(' / ')}（收到 ${clip(src, 20)}）`);
  if (a.unknown?.length) return badArgs(home, `不认识的参数：--${a.unknown.join(' --')}`);

  // ---- sid（rc=3：环境不对）----
  const bare = normalizeSid(process.env.DSH_SESSION_ID);
  if (!bare || !isBareUuid(bare)) {
    // §5.3 L355：缺失 ⇒ rc=3 + `.ops.jsonl` 记 no-sid（lineId 未定 ⇒ `_ops\_unknown-*.jsonl`）
    noteOps(home, null, { phase: 'no-sid', reason: bare ? 'sid-not-bare-uuid' : 'DSH_SESSION_ID-empty' });
    return emit({ rc: 3, tool: TOOL, action: 'no-sid', env: bare ? 'not-bare-uuid' : 'empty' },
      ['❌ 环境错（rc=3）：DSH_SESSION_ID 缺失或不是裸 uuid ⇒ 已在 .ops.jsonl 记 no-sid']);
  }

  // ---- turn（CLI 自己取，不收手工参数；唯一例外 = --by scan 的 --for-turn）----
  const t = sessionTurn(bare, sessionHome);
  if (t.turn == null) {
    noteOps(home, null, { phase: 'no-turn', reason: `session-log-unreadable:${t.file ?? 'not-found'}`, sid: bare, turn: 0 });
    return emit({ rc: 3, tool: TOOL, action: 'no-turn', sid: bare, logFile: t.file ?? null },
      [`❌ 环境错（rc=3）：读不到该会话的 turn/start（sid=${bare} / 日志=${t.file ?? '未找到'}）`]);
  }
  const turn = by === 'scan' && forTurn != null ? forTurn : t.turn;

  // ---- 线解析（查不到 ⇒ 未归线队列，rc=0，不拒写、不静默新建 lineId）----
  const resolved = resolveLine(home, a.line);
  if (!resolved.lineId) {
    const id = `u-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)}-${Math.random().toString(36).slice(2, 6)}`;
    const ev = appendUnmapped(home, { id, ts: isoWithOffset(), literal: clip(a.line, 200), sid: bare, turn });
    if (ev.rc !== 0) return emit({ rc: ev.rc, tool: TOOL, action: ev.action }, [`❌ 未归线队列写不下去（rc=${ev.rc}）`]);
    return emit(
      { rc: 0, tool: TOOL, action: 'unmapped', id, literal: String(a.line), sid: bare, turn, file: ev.file },
      [`未归线（进待认领队列 ${id}）：${a.line} —— 建线后再 --claim --pending ${id} --line <线>`],
    );
  }

  // ---- 作用域守卫（子代理 / 卡会话一律不写行）----
  const actor = probeActor(bare, sessionHome);
  const outOfScope = actor.known && (actor.isSubagent || actor.isCardSession);
  if (outOfScope && !fixture) {
    // §5.3 L357：rc=0 静默退出 + `.ops` 记一行 out-of-scope
    noteOps(home, resolved.lineId, {
      phase: 'out-of-scope',
      reason: actor.isSubagent ? 'subagent' : 'card-session',
      sid: bare, turn,
    });
    return emit(
      {
        rc: 0, tool: TOOL, action: 'out-of-scope', lineId: resolved.lineId,
        sid: bare, turn, why: actor.isSubagent ? 'subagent' : 'card-session', workspace: actor.workspace,
      },
      [`作用域外（${actor.isSubagent ? '子代理' : '卡会话'}）⇒ 不写行，已记 .ops out-of-scope`],
    );
  }

  // ---- 行内容 ----
  const secretHits = softSecretCheck({ did: a.did, next: a.next, anchor: a.anchor, ref: a.ref });
  if (secretHits.length) {
    process.stderr.write(`⚠️ --did/--next 命中禁写清单：${secretHits.map((h) => `${h.field}:${h.what}`).join('；')}`
      + ' ⇒ 按 §5.3 L345 应改写进 --ref；T-49 未拍 ⇒ 本次**只警告不拒写**\n');
  }
  const ended = turnEnd(bare, turn, sessionHome);
  const cardsArg = a['no-cards'] ? { cards: {}, state: 'unavailable', reason: 'flag-no-cards' }
    : computeCards(a['board-home'] ? path.resolve(a['board-home']) : sessionHome, lineAliasSet(home, resolved.lineId, resolved.line));

  const row = {
    v: 1,
    ts: isoWithOffset(),
    sid: bare,
    turn,
    lineId: resolved.lineId,
    phase,
    src,
    did: clip(String(a.did ?? ''), 500),
    next: clip(String(a.next ?? ''), 500),
    anchor: clip(String(a.anchor ?? ''), 120),
    ref: clip(String(a.ref ?? ''), 400),
    cards: cardsArg.cards,
    cardsState: cardsArg.state,
    by,
  };
  if (!a.src && by !== 'scan') row.srcSource = 'default';
  if (ended) row.late = true;
  if (by === 'scan') {
    row.forTurn = turn;
    const at = turnEnd(bare, turn, sessionHome);
    if (at?.ms) { row.atTurn = at.iso; row.atTurnMs = at.ms; }
  }
  row.scope = actor.known ? 'ok' : 'unknown';
  row.opId = `${bare.slice(0, 8)}-${turn}-${Date.now()}`;
  if (phase === 'void') {
    row.voids = String(a.voids).trim();
    row.reason = clip(String(a.reason ?? ''), 400);
  }

  if (a['dry-run']) {
    return emit(
      { rc: 0, tool: TOOL, action: 'dry-run', row, lineId: resolved.lineId, via: resolved.via, fixture, actor, cardsState: cardsArg.state },
      [`🔎 dry-run（未写）：${JSON.stringify(row)}`],
    );
  }

  const res = appendRow(home, resolved.lineId, row);
  const base = {
    rc: res.rc, tool: TOOL, action: res.action, lineId: resolved.lineId, via: resolved.via,
    sid: bare, turn: res.turn ?? turn, file: res.file ?? null, opId: row.opId,
    fixture, cardsState: cardsArg.state, scope: row.scope,
  };

  switch (res.action) {
    case 'appended':
      return emit({ ...base, revived: res.revived === true },
        [`✅ 已记（turn ${res.turn}${res.revived ? ' · 冲销后复活，后写者胜' : ''}）→ ${path.basename(res.file ?? '')}`]);
    case 'merged-scan':
      return emit(base, [`✅ 已记（turn ${res.turn} · 覆盖 scan 补记行 mergedFrom:"scan"）→ ${path.basename(res.file ?? '')}`]);
    case 'void-recorded':
      return emit(base, [`✅ 已记冲销（turn ${res.turn} · voids=${row.voids}）→ ${path.basename(res.file ?? '')}`]);
    case 'dup-skip':
      return emit({ ...base, prevBy: res.by ?? null },
        [`跳重（turn ${res.turn} 已存在${res.by ? `，by=${res.by}` : ''}）—— 本轮不重复写`]);
    case 'lock-missed':
      return emit({ ...base, opsFile: res.opsFile ?? null },
        ['锁被占 ⇒ 已让路（rc=4）：.ops.jsonl 记了一行 lock-missed，不阻塞会话']);
    case 'bad-args':
      return emit({ ...base, reason: res.reason ?? null }, [`❌ 参数错（rc=2）：${res.reason ?? 'bad-args'}`]);
    default:
      return emit({ ...base, reason: res.reason ?? res.error ?? null },
        [`❌ 写失败（rc=${res.rc}）：${res.action}${res.reason ? ' / ' + res.reason : ''}`]);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function usage() {
  return [
    'ledger-line —— 主线流水小本本的人用手写 CLI（V9 §5.3）',
    '',
    '写一行流水：',
    '  ledger-line --line <名或 lineId> --phase <10 态之一> [--did "…"] [--next "…"]',
    '              [--anchor <id>] [--ref <卡id/档>] [--by self|hook|scan] [--for-turn <n>]',
    '              [--src gui|qq-c2c|qq-group|card|router|scan] [--dry-run] [--no-cards]',
    '',
    '建线 / 别名 / 认领（四条写路径都支持 --dry-run：只算不写、零字节落盘）：',
    '  ledger-line --register-line --from-task-board [--board-home <dir>] [--dry-run]',
    '  ledger-line --register-line --line "字面值" [--aliases "a,b"] [--dry-run]',
    '  ledger-line --alias <lineId> --add "别名" [--dry-run]',
    '  ledger-line --claim --sid <裸uuid> --line <名或 lineId> [--dry-run]',
    '  ledger-line --claim --pending <u-id> --line <名或 lineId> [--dry-run]',
    '',
    '通用：--home <账本目录>（缺省 ~/.dsh）· --json（stdout 一行 JSON）',
    '      --dry-run 打印「🔎 dry-run（未写）」+ 将要写的内容；--json 里带 dryRun:true',
    '',
    `phase 合法值（${Object.keys(PHASES).length} 个）：${Object.keys(PHASES).join(' / ')}`,
    'rc：0 已记/跳重 · 2 参数或写者守卫 · 3 环境 · 4 锁被占（.ops 记 lock-missed）',
  ].join('\n');
}

function main(argv) {
  const a = parseArgs(argv);
  OUT.json = a.json === true;
  RUN.dryRun = a['dry-run'] === true; // 🔎 一次运行设一次；所有写口统一经 commit* 读它
  if (a.help) {
    process.stdout.write(usage() + '\n');
    process.exitCode = 0;
    return;
  }
  const home = a.home ? path.resolve(a.home) : dshHome();

  if (a['register-line']) { cmdRegister(a, home); return; }
  if (a.alias) { cmdAlias(a, home); return; }
  if (a.claim) { cmdClaim(a, home); return; }
  cmdWrite(a, home);
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));

export { main, parseArgs, resolveLine, computeCards, probeActor, sessionTurn, turnEnd };
