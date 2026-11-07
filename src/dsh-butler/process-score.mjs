#!/usr/bin/env node
// ============================================================================
//  process-score.mjs —— 「过程评分四数」（H-7 · **只算只报 · 零生产写入**）
//  ----------------------------------------------------------------------------
//  口径真源：`docs/` §1.6 H-7 行 + 其后「拍板注」
//            （2026-10-22 17:28 主人「就这样吧」：不学 PRM、只算四个数、
//              **四数只当镜子，不当考核、不当封版闸门**）
//  交付报告：`docs/`
//
//  【本件是什么】把「干活过程好不好」压成四个可复算的比值。每个数都给
//  **分子 / 分母 / 样本数 / 排除原因**，末尾一句人话结论。**不打分、不排名、不逐卡下结论。**
//
//  【为什么只有四个数】PRM（过程奖励模型）要训练 + 逐步人工标注；TRAIL（arXiv:2505.08638）
//  的 20 个错误类别要「逐 span 人工标注（4 名专家 + 4 轮复核）」或强 LLM 裁判
//  （其最好模型 joint 准确率仅 11%）。两条都不适合本生态 ⇒ 只借它一条类别
//  `Resource Abuse（repeated tool calls）` 当「重复读同一文件率」的学理锚点，其余不借。
//  见 `TRAIL_BORROW`。
//
//  【只读承诺】零写库、零改配置、零重启；不写 `%USERPROFILE%\.dsh` 下任何状态文件；
//  不碰 memory.db；不改看板账本（只发一条 `GET /api/task-board/state`，scope=all ⇒ 含归档卡）；
//  本件只在 stdout 出数（`--json` 也只出 stdout）。
//
//  用法：
//    node <butler-root>\tools\dsh-butler\process-score.mjs --days 7 [--json]
//    node <butler-root>\tools\dsh-butler\process-score.mjs --days 30
//    夹具/隔离（全部脱开生产，零 fs 写）：
//    node ... --session-roots <目录>[,...] --board-file <json> \
//             --changelog-dir <目录> --docs-dir <目录>[,...] --until <ISO>
//
//  退出码：0 正常（③④ 取不到也照出 ①②，并在输出里写明未取到原因）
//          2 用法错 / 输入读不到
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { rankSessionFilesInDir, isSessionFileName } from '../lib/session-file-name.mjs';
import { scanZstdFrames } from '../lib/zstd-frames.mjs';
import { resolveDshHome } from '../lib/dsh-home.mjs';
import { createLedgerApi } from './lib/ledger-api.mjs';

export const SCORE_VERSION = '1.0.0';
export const DEFINITION_VERSION = '2026-10-23-draft1';   // 「口径未定稿」标记：拿不准处一律取最保守

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// 一、四个数的定义（器具常量 · 报告各抄一份）
//    每个字段都必须能回答：分子怎么取、分母怎么取、数据从哪读、哪些样本被排除。
// ---------------------------------------------------------------------------
export const METRIC_DEFS = Object.freeze([
  {
    id: 'repeat-read',
    name: '重复读同一文件率',
    formula: '同一会话内对同一路径「第 2 次及以后」的 read 次数 ÷ 该会话 read 总次数（先按会话算，再全库相加）',
    numerator: '该会话内某路径第 2 次及以后的 `read` 工具调用条数（`tool/call` ∧ `name=="read"`）',
    denominator: '该会话 `read` 工具调用总条数（同口径）',
    source: '会话日志 `%USERPROFILE%\\.dsh\\sessions\\**\\session*.jsonl.zstd` + `_archived-sessions\\**`（多世代文件名走 `tools\\lib\\session-file-name.mjs`，逐帧解压走 `tools\\lib\\zstd-frames.mjs`）',
    excludes: [
      '参数里没有 `file_path`（或解析不出）的 read：分子分母**都不计入**，单列「参数不可解析」计数',
      '路径先归一化再比较：绝对路径原样、相对路径按会话头 `cwd` 解析；`\\`/`/`、大小写、尾部反斜杠归一；`<butler-root>\\card-sessions\\X` 折叠成 `<butler-root>\\X`（本机 junction 的同名双写法）',
      '只认工具名精确等于 `read` 的调用（`read_image` / `read_document` 不算「读同一文件」）',
      '窗口按事件自带 `time` 过滤（见「窗口」），无 `time` 的事件只能计入',
    ],
    note: '学理锚点 = TRAIL 类别 `Resource Abuse（repeated tool calls）`。口径未定稿：按「路径字符串归一」判同文件，不做 realpath 解析（realpath 随文件增删而变 ⇒ 破坏幂等）。',
  },
  {
    id: 'tool-failure',
    name: '工具失败率',
    formula: '`isError === true` 的 tool_result 条数 ÷ 工具调用（tool/call）总条数',
    numerator: '`tool/result` 事件里「失败」标记为真的条数（同一 `toolCallId` 重复出现只算一次）。**失败标记认两代形状**：新世代 `data.message.isError=true`；老世代在内容块里 `data.message.content[i].isError=true`（0.1.x 归档会话大量是这种）',
    denominator: '`tool/call` 事件条数（同一 `toolCallId` 只算一次）',
    source: '同上（会话日志）；另按 `toolCallId` 关联出「失败集中在哪个工具」，只用于一句话结论',
    excludes: [
      '同一 `toolCallId` 的重复 result（流式/重投）：分子分母都只算一次，重复条数单列',
      '「调用有、结果没有」的调用仍进分母（口径原文就是「工具调用总数」），不另扣',
      '不区分 benign 退出码（那是 H-9「环境性失败」的活），本件**不做**良性别除 ⇒ 数字偏保守（偏高）',
    ],
    note: '口径未定稿：错误判据只认事件里的 `isError` 布尔（两代形状都认），不解析结果正文（正文写 `Error:` 但 `isError=false` 的不算）。',
  },
  {
    id: 'trace-leaving',
    name: '留痕率',
    formula: '「既有交付报告、又有变更流水行」的卡 ÷ 有执行记录的卡',
    numerator: '同时满足 ① 卡 `description` 里点到 `交付报告-*.md` 且该文件在 docs 索引里找得到 ② 变更流水全文里能找到该报告文件名或其卡 id 前 8 位 —— 的卡数',
    denominator: '有 ≥1 条执行记录（`executions[]` 非空）且末次执行时间落在窗口内的卡数',
    source: '看板 `GET http://localhost:3080/api/task-board/state`（**不带** `x-dsh-board-scope: live` ⇒ scope=all，含归档卡；走 `tools\\dsh-butler\\lib\\ledger-api.mjs#readState`，只读）+ `docs/` 全文 + docs 目录文件名索引',
    excludes: [
      '无执行记录的卡（人工直接搬状态的）：不进分母',
      '报告只写在别的仓（如 `<work-root>\\docs`）且该目录不在 `--docs-dir` 里的：按「没有报告」算（保守）',
      '流水只认 `docs/`（现存月文件 = 2026-09 / 2026-10）；更早月份的卡按「无流水行」算（保守）',
      '只认 `description`（卡面备注/交付段），**不认 `prompt`** —— prompt 是开工前写的计划，不是留痕',
    ],
    note: '口径未定稿：证据 = 卡面自己点的路径 + 磁盘/流水实际存在；不判报告内容质量。',
  },
  {
    id: 'first-time-right',
    name: '一次做对率',
    formula: '未经 reject 直接 confirm 的卡 ÷ 已 confirm 的卡',
    numerator: '分母里 `description` **不含** `[打回 ` 标记的卡数',
    denominator: '状态为 `done`（= 人工点过「验收通过」）且 ≥1 条执行记录、末次执行时间落在窗口内的卡数',
    source: '看板 state（同上）；「被打回过」的判据 = 看板插件 `reject` 动作会往 `description` 追加 `[打回 <本地时间>] <备注>`（`tools\\dsh-task-board-local\\src\\host-ledger.ts:730`，现查核过）',
    excludes: [
      '`done` 但无执行记录（人工直接搬的）：不进分母，单列计数',
      '🔴 **已知盲区（现查源码确认）**：看板插件 `reject` 只在**带备注**时才往 `description` 追加 `[打回 …]`（`host-ledger.ts:728-730` 三元判断）⇒ **不带备注的打回、或事后被人删掉那段的，都会漏判成「一次做对」** ⇒ 本数**偏高**（方向已知）',
      '只看「有没有被打回过」，不看被打回几次、也不看打回理由是否合理',
    ],
    note: '口径未定稿：账本不存 confirm 时间戳 ⇒ 窗口用「末次执行结束时间」近似。另给一条**口径外敏感性**（把「无打回标记但跑过 ≥2 轮」全当返工 ⇒ 本数下界），只报不判。',
  },
]);

// ---------------------------------------------------------------------------
// 二、TRAIL（arXiv:2505.08638）核对结论 —— 只借一条
// ---------------------------------------------------------------------------
export const TRAIL_BORROW = Object.freeze({
  paper: 'TRAIL: Trace Reasoning and Agentic Issue Localization（arXiv:2505.08638v3 · 2025-06-23 · MIT）',
  authors: 'Darshan Deshpande, Varun Gangal, Hersh Mehta, Jitin Krishnan, Anand Kannappan, Rebecca Qian（Patronus AI）',
  data: '148 条人工标注 trace（GAIA 118 + SWE-Bench 30）· 1,987 个 OpenTelemetry span / 575 个 span 带 ≥1 个错误 · 共 841 个错误',
  taxonomy3: ['Reasoning Errors', 'System Execution Errors', 'Planning and Coordination Errors'],
  leafTypes: [
    'Hallucinations: Language-only / Tool-related',
    'Information Processing: Poor Information Retrieval / Tool Output Misinterpretation',
    'Decision Making: Incorrect Problem Identification / Tool Selection Errors',
    'Output Generation: Formatting Errors / Instruction Non-compliance',
    'Configuration: Tool Definition Issues / Environment Setup Errors',
    'API Issues: Rate Limiting(429) / Authentication Errors(401,403) / Service Errors(500) / Resource Not Found(404)',
    'Resource Management: Resource Exhaustion / Timeout Issues',
    'Context Management: Context Handling Failures / Resource Abuse(repeated tool calls)',
    'Task Management: Goal Deviation / Task Orchestration',
    'Domain Specific Errors（兜底叶）',
  ],
  needsHumanAnnotation: '要。每一条错误都由 4 名专家标注器**逐 span** 标（span id + 类别 + 证据 + 描述 + 影响级 Low/Medium/High），另 4 轮 ML 研究者复核；trace 级还打 4 个分（instruction adherence / plan optimality / security / reliability）。标注对象是 OpenTelemetry(OpenInference) 结构化 span。',
  reuseWithoutChangingData: '不能整包复用。① schema 不同：它吃 OTel span，我们的会话日志是 `tool/call` + `tool/result` 事件（无 span id / 无影响级）；② 20 个叶子类别里绝大多数要人读上下文判语义（决策、幻觉、目标偏离），我们没有那层标注预算；③ 它自己测出强 LLM 当裁判 joint 准确率也只有 11%（最好 gemini-2.5-pro）⇒ 不能拿 LLM 自动判类别顶替人工。',
  verdict: '借 / 只借一条：`Resource Abuse（repeated tool calls）`——按它这条类别的语义做「重复读同一文件率」（机械可数、零标注成本）。其余 19 类**不借**（要人工逐 span 标注，本版不做；登记见报告「范围外」）。',
});

// ---------------------------------------------------------------------------
// 三、会话日志：发现 → 解压 → 解析
// ---------------------------------------------------------------------------

/** 会话日志候选根：活跃树 + 归档树（归档树里才是「超过 24h 的老会话」，不算进来会系统性漏样本）。 */
export function defaultSessionRoots(home, { includeArchive = true } = {}) {
  const roots = [path.join(home, 'sessions')];
  if (includeArchive) roots.push(path.join(home, '_archived-sessions'));
  return roots;
}

/**
 * 收集「窗口内还在动」的会话目录，并对每个目录给出**要读的候选文件链**。
 * 两代并存时新世代可能只是「补写壳」（`session-file-name.mjs` 有实测登记）⇒ 调用方要按内容挑最全那份。
 * @returns {{dir:string, files:{file:string,bytes:number,mtimeMs:number,generation:number}[], mtimeMs:number}[]}
 */
export function discoverSessionDirs(roots, sinceMs) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      if (!isSessionFileName(e.name)) continue;
      // 该目录里至少有一个会话文件 ⇒ 交给 rankSessionFilesInDir 统一取链
      const files = rankSessionFilesInDir(d);
      if (!files.length) continue;
      const mtimeMs = Math.max(...files.map((f) => f.mtimeMs));
      if (mtimeMs < sinceMs) continue;
      out.push({ dir: d, files, mtimeMs });
      return; // 本目录已收，不再往下走（会话目录不嵌套）
    }
  };
  for (const root of roots) walk(root);
  out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return out;
}

/** 解一份会话日志的全部事件（多帧 zstd 逐帧解；坏帧/半帧丢弃，绝不猜）。 */
export function decodeSessionEvents(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  const events = [];
  let badFrames = 0;
  for (const f of frames) {
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'); } catch { badFrames++; continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      // 只 JSON.parse 关心的三类事件：整份日志里绝大多数是投递回执/step 事件，全量 parse 太贵
      if (!line.includes('"tool/call"') && !line.includes('"tool/result"') && !line.includes('"type":"session"')) continue;
      try { events.push(JSON.parse(line)); } catch { /* 半行（尾部正在写）忽略 */ }
    }
  }
  return { events, badFrames, frames: frames.length };
}

const DSH_ROOT = process.env.BUTLER_ROOT || path.join(os.homedir(), 'dsh');

const JUNCTION_FOLDS = [
  // 可选折叠：<root>\card-sessions\ 与 <root>\ 是同一份（卡会话工作根与主根的同名双写法）
  [`${DSH_ROOT}\\card-sessions\\`.toLowerCase(), `${DSH_ROOT}\\`.toLowerCase()],
];

/** 路径归一化（只做字符串级；不做 realpath —— 那会随文件增删变化，破坏幂等）。 */
export function normalizePath(p, cwd) {
  if (p === undefined || p === null) return null;
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) {
    // 绝对路径：原样
  } else {
    const base = (cwd && /^[a-zA-Z]:[\\/]/.test(String(cwd))) ? String(cwd) : DSH_ROOT;
    s = path.resolve(base, s);
  }
  s = s.replace(/\//g, '\\').replace(/\\{2,}/g, '\\').replace(/\\$/, '').toLowerCase();
  for (const [from, to] of JUNCTION_FOLDS) if (s.startsWith(from)) { s = to + s.slice(from.length); break; }
  return s;
}

function parseArgsJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * tool_result 是否失败 —— **认两个世代的事件形状**（2026-10-23 现查，踩过）：
 *   新形状（0.2.x）：`data.message.isError = true`、`role="tool"`、`data.toolCallId`；
 *   老形状（0.1.x，归档树里大量）：`isError` 在**内容块**里 —— `data.message.content[i] = {type:"tool-result", toolCallId, content:[…], isError:true}`。
 * 只认 `message.isError` 会把老会话的失败**全部漏掉**（实测：30 天窗口下 12 vs 应有 ~2,000）。
 */
export function resultIsError(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.isError === true) return true;
  if (Array.isArray(message.content)) {
    for (const b of message.content) if (b && b.isError === true) return true;
  }
  return false;
}

/** tool_result 的 callId（同样认两代形状）。 */
export function resultCallId(data, message) {
  if (data?.toolCallId) return data.toolCallId;
  if (message?.toolCallId) return message.toolCallId;
  if (Array.isArray(message?.content)) {
    for (const b of message.content) if (b?.toolCallId) return b.toolCallId;
  }
  return null;
}

/**
 * 一个会话的事件流 → 过程统计（不判好坏、不下结论）。
 * @param {{events:object[]}} input
 * @param {{sinceMs?:number, untilMs?:number}} win  事件级窗口（`time` 不在窗口内的丢弃；无 time 的保留）
 */
export function scoreSessionEvents({ events }, win = {}) {
  const since = win.sinceMs ?? -Infinity;
  const until = win.untilMs ?? Infinity;
  const inWin = (e) => {
    const t = Number(e?.time ?? e?.at ?? NaN);
    if (!Number.isFinite(t)) return true;   // 无时间戳：无从判断，计入（保守）
    return t >= since && t <= until;
  };

  let cwd = null;
  const readSeen = new Set();
  const callIds = new Set();
  const resultIds = new Set();
  const stats = {
    id: null, cwd: null,
    reads: 0, repeatReads: 0, readUnparsable: 0,
    calls: 0, errors: 0, dupResults: 0, unpairedErrors: 0,
    errByTool: new Map(),
    firstEventTime: null, lastEventTime: null,
  };

  // toolCallId → 工具名（失败归因用）
  const nameByCall = new Map();
  const pendingCalls = [];

  for (const e of events) {
    if (!inWin(e)) continue;
    if (e.type === 'session' && (e.id || e.cwd)) {
      stats.id = stats.id ?? (e.id ?? null);
      cwd = cwd ?? (e.cwd ?? null);
      continue;
    }
    const t = Number(e?.time ?? NaN);
    if (Number.isFinite(t)) {
      if (stats.firstEventTime === null || t < stats.firstEventTime) stats.firstEventTime = t;
      if (stats.lastEventTime === null || t > stats.lastEventTime) stats.lastEventTime = t;
    }
    if (e.type === 'tool/call') {
      const d = e.data ?? {};
      const cid = d.callId ?? d.toolCallId ?? null;
      if (cid) { if (callIds.has(cid)) continue; callIds.add(cid); }
      stats.calls++;
      const name = d.name ?? null;
      if (cid) nameByCall.set(cid, name);
      pendingCalls.push({ cid, name });
      if (name === 'read') {
        const args = parseArgsJson(d.arguments);
        const raw = args?.file_path ?? args?.path ?? null;
        const key = normalizePath(raw, cwd);
        if (!key) { stats.readUnparsable++; continue; }
        stats.reads++;
        if (readSeen.has(key)) stats.repeatReads++;
        else readSeen.add(key);
      }
    } else if (e.type === 'tool/result') {
      const m = e.data?.message ?? {};
      const cid = resultCallId(e.data, m);
      if (cid) { if (resultIds.has(cid)) { stats.dupResults++; continue; } resultIds.add(cid); }
      if (resultIsError(m)) {
        stats.errors++;
        const name = (cid && nameByCall.get(cid)) ?? e.data?.name ?? '(unknown)';
        stats.errByTool.set(name, (stats.errByTool.get(name) ?? 0) + 1);
        if (cid && !callIds.has(cid)) stats.unpairedErrors++;
      }
    }
  }
  stats.cwd = cwd;
  return stats;
}

// ---------------------------------------------------------------------------
// 四、看板：留痕率 / 一次做对率
// ---------------------------------------------------------------------------
const RE_REPORT = /交付报告-[^\s`"'）)，,。；;：|<>【】]+\.md/g;
const RE_REJECTED = /\[打回\s/;

function readChangelogText(dir) {
  let ents;
  try { ents = fs.readdirSync(dir); } catch { return { text: '', months: [] }; }
  const months = ents.filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort();
  const parts = [];
  for (const f of months) {
    try { parts.push(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* 读不到就少一份 */ }
  }
  return { text: parts.join('\n'), months };
}

function buildDocsIndex(dirs) {
  const names = new Set();
  const real = [];
  for (const d of dirs) {
    let ents;
    try { ents = fs.readdirSync(d); } catch { continue; }
    real.push(d);
    for (const f of ents) names.add(f.toLowerCase());
  }
  return { names, dirs: real };
}

/**
 * 看板卡 → 留痕 / 一次做对。
 * @param {object[]} tasks 看板 state 的 tasks[]
 * @param {{changelogText:string, changelogMonths:string[], docsIndex:{names:Set<string>,dirs:string[]}, sinceMs:number, untilMs:number}} ctx
 */
export function scoreBoardCards(tasks, ctx) {
  const { changelogText, docsIndex, sinceMs, untilMs } = ctx;
  const cardTime = (t) => {
    const ex = Array.isArray(t.executions) ? t.executions : [];
    let m = 0;
    for (const e of ex) m = Math.max(m, Number(e.endedAt ?? e.startedAt ?? 0) || 0);
    return m || Number(t.updatedAt ?? t.createdAt ?? 0) || 0;
  };
  const inWin = (t) => { const m = cardTime(t); return m >= sinceMs && m <= untilMs; };

  const trace = {
    denominator: 0, both: 0,
    hasReport: 0, hasChangelog: 0,
    missNoReport: 0, missNoChangelog: 0,
    excludedNoExec: 0, outsideWindow: 0,
  };
  const ftr = {
    denominator: 0, clean: 0, rejected: 0, reworkSuspected: 0,
    excludedNoExec: 0, outsideWindow: 0,
  };

  for (const t of tasks ?? []) {
    const ex = Array.isArray(t.executions) ? t.executions : [];
    const desc = String(t.description ?? '');
    const reports = [...desc.matchAll(RE_REPORT)].map((m) => path.basename(m[0]).toLowerCase());
    const repOk = reports.some((b) => docsIndex.names.has(b));
    const clHit = reports.some((b) => changelogText.includes(b))
      || changelogText.includes(String(t.id ?? '').slice(0, 8));

    if (!inWin(t)) { trace.outsideWindow++; ftr.outsideWindow++; continue; }
    if (!ex.length) {
      trace.excludedNoExec++;
      if (t.status === 'done') ftr.excludedNoExec++;
      continue;
    }
    trace.denominator++;
    if (repOk) trace.hasReport++;
    if (clHit) trace.hasChangelog++;
    if (repOk && clHit) trace.both++;
    if (!repOk) trace.missNoReport++;
    else if (!clHit) trace.missNoChangelog++;

    if (t.status === 'done') {
      ftr.denominator++;
      if (RE_REJECTED.test(desc)) ftr.rejected++;
      else {
        ftr.clean++;
        // 口径外诊断（不进分子分母）：这张卡跑过 ≥2 轮 ⇒ 要么被打回（无备注 ⇒ 本口径看不见）、
        // 要么失败重跑；账本没给 kind（定时卡验收后也回 todo 再跑）⇒ 只能当**上界**给个敏感性读数。
        if (ex.length >= 2) ftr.reworkSuspected++;
      }
    }
  }
  return { trace, ftr };
}

// ---------------------------------------------------------------------------
// 五、汇总 → 输出
// ---------------------------------------------------------------------------
const pct = (num, den) => (den > 0 ? num / den : null);
const fmtPct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (n) => Number(n ?? 0).toLocaleString('en-US');

function isoLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把两半（会话侧 + 看板侧）合成最终结果对象（纯函数，便于夹具断言）。 */
export function buildResult({ days, sinceMs, untilMs, sessions, board, trail = TRAIL_BORROW }) {
  const reads = sessions.reduce((a, s) => a + s.reads, 0);
  const repeats = sessions.reduce((a, s) => a + s.repeatReads, 0);
  const unparsable = sessions.reduce((a, s) => a + s.readUnparsable, 0);
  const calls = sessions.reduce((a, s) => a + s.calls, 0);
  const errors = sessions.reduce((a, s) => a + s.errors, 0);
  const dupResults = sessions.reduce((a, s) => a + s.dupResults, 0);
  const unpaired = sessions.reduce((a, s) => a + s.unpairedErrors, 0);
  const errByTool = new Map();
  for (const s of sessions) for (const [k, v] of s.errByTool) errByTool.set(k, (errByTool.get(k) ?? 0) + v);
  const topErr = [...errByTool.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0] ?? null;

  const m1 = {
    id: 'repeat-read', name: '重复读同一文件率',
    numerator: repeats, denominator: reads, rate: pct(repeats, reads),
    samples: sessions.filter((s) => s.reads > 0).length,
    exclusions: { unparsableReads: unparsable, sessionsWithoutRead: sessions.length - sessions.filter((s) => s.reads > 0).length },
  };
  const m2 = {
    id: 'tool-failure', name: '工具失败率',
    numerator: errors, denominator: calls, rate: pct(errors, calls),
    samples: sessions.filter((s) => s.calls > 0).length,
    exclusions: { duplicateResults: dupResults, unpairedErrors: unpaired, topFailingTool: topErr ? topErr[0] : null, topFailingToolCount: topErr ? topErr[1] : 0 },
  };
  const t = board?.trace ?? null;
  const f = board?.ftr ?? null;
  const m3 = {
    id: 'trace-leaving', name: '留痕率',
    numerator: t?.both ?? null, denominator: t?.denominator ?? null,
    rate: t ? pct(t.both, t.denominator) : null,
    samples: t ? t.denominator : null,
    exclusions: t ? { noExecutionRecord: t.excludedNoExec, outsideWindow: t.outsideWindow, hasReportOnly: t.hasReport - t.both, hasChangelogOnly: t.hasChangelog - t.both, missNoReport: t.missNoReport, missNoChangelog: t.missNoChangelog } : null,
    status: board?.ok ? 'ok' : 'unavailable',
    reason: board?.ok ? null : (board?.reason ?? 'board-unreadable'),
  };
  const m4 = {
    id: 'first-time-right', name: '一次做对率',
    numerator: f?.clean ?? null, denominator: f?.denominator ?? null,
    rate: f ? pct(f.clean, f.denominator) : null,
    samples: f ? f.denominator : null,
    exclusions: f ? { rejected: f.rejected, reworkSuspected: f.reworkSuspected ?? 0, doneWithoutExecution: f.excludedNoExec, outsideWindow: f.outsideWindow } : null,
    // 敏感性（口径外，只报不判）：把「无打回标记但跑过 ≥2 轮」全当返工 ⇒ ④ 的**下界**
    sensitivity: f ? { worstCaseRate: pct(Math.max(0, f.clean - (f.reworkSuspected ?? 0)), f.denominator), assumedRework: f.reworkSuspected ?? 0 } : null,
    status: board?.ok ? 'ok' : 'unavailable',
    reason: board?.ok ? null : (board?.reason ?? 'board-unreadable'),
  };

  const metrics = [m1, m2, m3, m4];
  const topStr = topErr ? `${topErr[0]}（${num(topErr[1])} 次）` : '无';
  const s1 = m2.denominator > 0
    ? `最近 ${days} 天工具失败率 ${fmtPct(m2.rate)}，失败主要来自 ${topStr}。`
    : `最近 ${days} 天没读到任何工具调用（日志窗口为空或有台数问题），四数不可判。`;
  const s2 = `重复读 ${fmtPct(m1.rate)}、留痕 ${fmtPct(m3.rate)}、一次做对 ${fmtPct(m4.rate)}（只当镜子：不打分、不排名、不对单张卡下结论）。`;

  return {
    ok: true,
    version: SCORE_VERSION,
    definitionVersion: DEFINITION_VERSION,
    days,
    window: { fromMs: sinceMs, toMs: untilMs, from: isoLocal(sinceMs), to: isoLocal(untilMs) },
    metrics,
    conclusion: s1 + s2,
    definitions: METRIC_DEFS,
    trail: { paper: trail.paper, verdict: trail.verdict },
    notes: [
      '窗口终点取整到小时 ⇒ 同一小时内两跑输出一致（日志/账本在此期间新增的事件不进本窗口）。',
      '四数只当镜子：不当考核、不当封版闸门；本器具不打分、不排名、不给单张卡下结论。',
    ],
  };
}

function renderText(res) {
  const L = [];
  L.push(`过程评分四数（只算只报 · 镜子档）  口径 ${res.definitionVersion}`);
  L.push(`窗口 ${res.window.from} → ${res.window.to}（${res.days} 天 · 事件级按 time 过滤）`);
  if (res.scan) {
    const s = res.scan;
    L.push(`扫描：会话目录 ${num(s.sessionDirs)} 个 · 读日志 ${num(s.sessionFilesRead)} 份 · 计分会话 ${num(s.sessionsScored)} 个 · 坏帧 ${num(s.badFrames)} 个 · 两代并存目录 ${num(s.multiGenerationDirs)} 个 · 空壳跳过 ${num(s.skippedNoEvents)} 个`);
  }
  L.push('');
  const tag = ['①', '②', '③', '④'];
  res.metrics.forEach((m, i) => {
    if (m.status === 'unavailable') {
      L.push(`${tag[i]} ${m.name.padEnd(9, ' ')} 未取到（${m.reason}）`);
      return;
    }
    const ex = m.exclusions ?? {};
    const bits = [];
    if (m.id === 'repeat-read') {
      bits.push(`重读 ${num(m.numerator)} 次`, `read ${num(m.denominator)} 次`, `有 read 的会话 ${num(m.samples)} 个`);
      bits.push(`排除：参数不可解析 ${num(ex.unparsableReads)} 次 · 无 read 的会话 ${num(ex.sessionsWithoutRead)} 个`);
    } else if (m.id === 'tool-failure') {
      bits.push(`isError ${num(m.numerator)} 条`, `tool/call ${num(m.denominator)} 条`, `有调用的会话 ${num(m.samples)} 个`);
      bits.push(`排除：重复 result ${num(ex.duplicateResults)} 条 · 未配对失败 ${num(ex.unpairedErrors)} 条`);
    } else if (m.id === 'trace-leaving') {
      bits.push(`报告+流水齐 ${num(m.numerator)} 张`, `有执行记录 ${num(m.denominator)} 张`);
      bits.push(`缺报告 ${num(ex.missNoReport)} 张 · 有报告无流水 ${num(ex.missNoChangelog)} 张 · 无执行记录排除 ${num(ex.noExecutionRecord)} 张`);
    } else {
      bits.push(`未打回 ${num(m.numerator)} 张`, `已验收且有执行记录 ${num(m.denominator)} 张`);
      bits.push(`被打回过 ${num(ex.rejected)} 张 · done 无执行记录排除 ${num(ex.doneWithoutExecution)} 张`);
      if (m.sensitivity) {
        bits.push(`口径外敏感性：无打回标记但跑过 ≥2 轮 ${num(m.sensitivity.assumedRework)} 张 ⇒ 若全判返工，本数下界 ${fmtPct(m.sensitivity.worstCaseRate)}（口径不变、只给区间）`);
      }
    }
    L.push(`${tag[i]} ${m.name}  ${fmtPct(m.rate)}   （${bits.join(' · ')}）`);
  });
  L.push('');
  L.push(`结论：${res.conclusion}`);
  L.push(`TRAIL 借用：${res.trail.verdict}`);
  L.push('口径：只当镜子、不当考核；不打分、不排名、不给单张卡下结论。');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 六、CLI
// ---------------------------------------------------------------------------
const USAGE = `process-score —— 「过程评分四数」（H-7 · 只算只报 · 零生产写入）

用法：
  node <butler-root>\\tools\\dsh-butler\\process-score.mjs --days 7 [--json]
  node <butler-root>\\tools\\dsh-butler\\process-score.mjs --days 30

选项：
  --days <N>            窗口天数（默认 7）
  --json                只输出 JSON（结构稳定，便于夹具/二次消费）
  --until <ISO>         窗口终点（默认 = 现在**取整到小时**；夹具用固定时刻）
  --home <目录>         DSH home（默认 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）
  --session-roots <a,b> 会话日志根目录（默认 <home>\\sessions + <home>\\_archived-sessions）
  --no-archive          不扫归档树（只扫活跃树）
  --board-file <json>   夹具：直接吃 {tasks:[...]} 或 [...]（不联网）
  --board-url <url>     看板 baseUrl（默认 http://localhost:3080）
  --changelog-dir <目录> 变更流水目录（默认 <butler-root>\\docs\\变更流水）
  --docs-dir <a,b>      报告索引目录（默认 <butler-root>\\docs + <work-root>\\docs）
  --help

只读：不写任何文件（含状态文件）、不碰 memory.db、不改看板账本、不重启。`;

function parseArgv(argv) {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const all = (k) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === k && i + 1 < argv.length) out.push(...String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean));
    return out;
  };
  const untilRaw = val('--until', null);
  const untilMs = untilRaw ? Date.parse(untilRaw) : Math.floor(Date.now() / HOUR) * HOUR;
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    json: argv.includes('--json'),
    days: Math.max(1, Number(val('--days', 7)) || 7),
    untilMs,
    home: val('--home', resolveDshHome()),
    sessionRoots: all('--session-roots'),
    includeArchive: !argv.includes('--no-archive'),
    boardFile: val('--board-file', null),
    boardUrl: val('--board-url', null),
    changelogDir: val('--changelog-dir', path.join(DSH_ROOT, 'docs', 'changelog')),
    docsDirs: all('--docs-dir'),
  };
}

async function runCli(argv) {
  const o = parseArgv(argv);
  if (o.help) { console.log(USAGE); return 0; }
  if (!Number.isFinite(o.untilMs)) { console.error('--until 解析失败'); return 2; }
  const sinceMs = o.untilMs - o.days * DAY;

  // ① 会话侧
  const roots = o.sessionRoots.length ? o.sessionRoots : defaultSessionRoots(o.home, { includeArchive: o.includeArchive });
  const dirs = discoverSessionDirs(roots, sinceMs);
  const sessions = [];
  let filesRead = 0; let badFrames = 0; let multiGen = 0; let skippedNoEvents = 0; let dedupById = 0;
  const seenIds = new Set();
  for (const d of dirs) {
    // 两代并存：挑「事件最多」那份（新世代可能只是补写壳）
    let best = null;
    if (d.files.length > 1) multiGen++;
    for (const f of d.files) {
      const dec = decodeSessionEvents(f.file);
      filesRead++;
      badFrames += dec.badFrames;
      const st = scoreSessionEvents(dec, { sinceMs, untilMs: o.untilMs });
      const evCount = dec.events.length;
      if (!best || evCount > best.evCount) best = { st, evCount };
    }
    if (!best || best.evCount === 0) { skippedNoEvents++; continue; }
    const id = best.st.id ?? d.dir;
    if (seenIds.has(id)) { dedupById++; continue; }
    seenIds.add(id);
    sessions.push(best.st);
  }

  // ② 看板侧
  let board;
  try {
    let tasks = null; let reason = null;
    if (o.boardFile) {
      const raw = JSON.parse(fs.readFileSync(o.boardFile, 'utf8'));
      tasks = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : null);
      if (!tasks) reason = 'board-file 里没有 tasks[]';
    } else {
      const api = createLedgerApi({ baseUrl: o.boardUrl ?? 'http://localhost:3080' });
      const st = await api.readState();      // scope=all（不带头）⇒ 含归档卡
      if (st.ok) tasks = st.tasks; else reason = `${st.kind}/${st.code}`;
    }
    if (tasks) {
      const cl = readChangelogText(o.changelogDir);
      const docsDirs = o.docsDirs.length ? o.docsDirs : [path.join(DSH_ROOT, 'docs')];
      const docsIndex = buildDocsIndex(docsDirs);
      const sc = scoreBoardCards(tasks, { changelogText: cl.text, changelogMonths: cl.months, docsIndex, sinceMs, untilMs: o.untilMs });
      board = { ok: true, ...sc, meta: { cards: tasks.length, changelogMonths: cl.months, docsDirs: docsIndex.dirs } };
    } else {
      board = { ok: false, reason: reason ?? 'board-unreadable' };
    }
  } catch (err) {
    board = { ok: false, reason: `board-error: ${String(err?.message ?? err).slice(0, 160)}` };
  }

  const res = buildResult({ days: o.days, sinceMs, untilMs: o.untilMs, sessions, board });
  res.scan = { sessionDirs: dirs.length, sessionFilesRead: filesRead, sessionsScored: sessions.length, badFrames, multiGenerationDirs: multiGen, skippedNoEvents, dedupById };

  if (o.json) console.log(JSON.stringify(res, null, 2));
  else console.log(renderText(res));
  return 0;
}

// junction 下 `import.meta.url` 是物理路径、argv[1] 是逻辑路径 ⇒ 双方 realpath 再比
function isMain() {
  const a = process.argv[1];
  if (!a) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return fs.realpathSync(path.resolve(a)) === self;
  } catch { return false; }
}

if (isMain()) {
  runCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('process-score 失败：' + (err?.stack ?? err)); process.exitCode = 2; });
}
