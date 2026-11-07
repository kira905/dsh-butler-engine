#!/usr/bin/env node
/**
 * steward-threads.mjs —— 协调线 C12-A：「Thread 与订阅」的**数据面地基**（纯 Node，零模型调用）
 *
 * 真源两份（开工前已读）：
 *   ① `docs/` §A-5：「难的次序 = ①Thread 与 trigger_thread
 *      关系表 ②订阅表 ③扇出通道；①最贵，②③顺手」。⇒ 本件只做 ① 的**最小可落地形态**。
 *   ② `docs/` §2 第 3 行（订阅直通建议抄、放最后）。
 *
 * C12 拆三段（主人 2026-11-02 定「不按简单的做」）：**A 建地基 · B 做扇出 · C 做唤醒**。
 * 🔴 本件做 A + B + C：A = 数据面（new/bind/unbind/list/show）；B = **扇出通道**（--thread-post，投在跑的）；
 *     C = **唤醒段**（同一条 `--thread-post --apply` 里，把该 thread 下**已结束**的订阅卡按闸重新跑起来）。
 *     唤醒通道只走看板自己的 `POST /api/task-board/action {kind:'run'}`（**禁自造起卡**）。
 *     三道闸（缺一不许上线）：① 单条消息最多唤 2 张 ② 同一张卡 30 分钟冷却（判据 = 该卡 executions 末条时间）
 *     ③ `--no-wake` 一键关（关掉 = 完全回到 C12-B 行为：已结束的卡只跳过 + 点名）。
 *
 * 本件做的四件事（数据面 + 读法 + 扇出 + 唤醒）：
 *   · 数据文件 `~/.dsh/steward-threads.json`（**本件是唯一写者**）
 *       { version:1, threads:[ { id:'th-<8hex>', title, line, createdAt, cards:[], messages:[] } ] }
 *     - `messages` 由 `--thread-post --apply` 追加记录（**干跑永远不写**）；两类条目靠 `via` 分清：
 *       投递 `{ threadId, cardId, sessionId, title, at, ok, via:'session-say', error?, text }`；
 *       唤醒 `{ threadId, cardId, cardTitle, kind:'wake', at, ok, via:'board-run',
 *              statusBefore, executionsBeforeCount, executionsAfterCount, executionId, sessionId,
 *              statusAfter, gate:{…}, error?, text }`（闸门挡下时 `ok:false` + `blocked` + `note`，**不算失败**）；
 *     - 文件不存在 ⇒ 首次写时自动建；**坏 JSON / 顶层形状不对 ⇒ 拒绝写、原档一个字节不动、非 0 退出**
 *       （教训同 C10 夹具37：坏 state 被覆盖 = decisions[] 直接丢）。
 *   · CLI 六个动作（前五个幂等、全部支持 `--json`）：new / bind / unbind / list / show / **post**。
 *   · `--thread-show <id>` 的**反查**：每张卡现况从 `GET /api/task-board/state` **只读**取
 *     status（**显式带 `x-dsh-board-scope: live`**，与 `lib\ledger-api.mjs#scopeHeaders('live')` 同口径；
 *     只拿在板卡 ⇒ 不惊动归档批次、响应小一个数量级）。取不到 ⇒ 标 `unknown` + 报黄，**绝不崩**。
 *   · `--thread-post` 的**扇出判据**（B 段 · 三道闸，缺一不投）：
 *       ① 该 thread 的 cards[] ⇒ 每张卡 `executions[]` **末条**的 sessionId（从同一条 live GET 顺带取）；
 *       ② 只投**当前在跑**的：`session.list` 的 `running === true`（与 `tools\board-ops\session-state.mjs`
 *          同源同字段；未命中 ⇒ 按弱判据算"不在跑"，**不猜**）；
 *       ③ 去向只走 `tools\dsh-butler\session-say.mjs --to <sid> --text … --apply`（**禁自造投递**）。
 *     **已结束的会话一律跳过**，回执点名「归 C12-C 唤醒段」。
 *   · `--thread-post` 的**唤醒判据**（C 段 · 只唤"订阅且已结束"的卡，三道闸）：
 *       ① 单条消息最多唤 `WAKE_MAX_PER_MESSAGE`(=2) 张，超出的**只记账** + 打印「N 张因上限未唤」；
 *       ② 同一张卡 `WAKE_COOLDOWN_MIN`(=30) 分钟冷却，判据 = 该卡 `executions[]` 末条的 `endedAt ?? startedAt`；
 *       ③ `--no-wake` 一键关（关掉 = 完全回到 C12-B：已结束的卡只跳过 + 点名，一个 POST 都不发）。
 *     通道**只走** `POST /api/task-board/action { kind:'run', taskId }`（看板自己的起卡接口，**不自造**）；
 *     在跑的卡不动（那是 B 段的事）· 没跑过的不唤（不算"已结束"）· 待验收(review)/backlog 不唤；
 *     失败**如实记 ok:false + error**，**单条消息内不重试**（不 sleep、不补第二发）。
 *
 * 🔴 本件**默认不做什么**（卡面红线，写死在代码里）：
 *   不改看板源码/schema · 不改 `ledger-v2.json` · 不改 `host-runner.ts` · 不读任何会话正文
 *   · 对看板**只有两种请求**：一条 `GET /state`（读）+ 唤醒时每张卡一条 `POST /action{kind:'run'}`（**唯一写面**，
 *     无其它写动作：不改状态/不 confirm/不 move/不 update/不 archive）
 *   · 不改 `session-say.mjs`（只 spawn 它、按它的 rc/首行 stderr 记账）· 不改 `steward.mjs` 任何既有行为
 *   · **缺省 = 干跑**：不给 `--apply` 就只打印清单，不写 messages、不 spawn 投递、**不发唤醒**。
 *
 * 用法：
 *   node tools\dsh-butler\steward-threads.mjs --thread-new --title "<一句话>" [--line "<主线>"]
 *   node tools\dsh-butler\steward-threads.mjs --thread-bind   --thread <id> --card <cardId>
 *   node tools\dsh-butler\steward-threads.mjs --thread-unbind --thread <id> --card <cardId>
 *   node tools\dsh-butler\steward-threads.mjs --thread-list [--json]
 *   node tools\dsh-butler\steward-threads.mjs --thread-show <id> [--json]
 *   node tools\dsh-butler\steward-threads.mjs --thread-post --thread <id> --text "<一句话>" [--from "<来源>"] [--apply] [--no-wake] [--json]
 *   node tools\dsh-butler\steward-threads.mjs --self-test [--json]
 *
 * 退出码：0=成功（**含幂等无变化**，如重复 bind / 重复 unbind；也含扇出"全跳过、0 投"、唤醒"全被闸挡"）
 *         · 2=用法错（无参数 / 缺 --title / 缺 --thread / 缺 --card / 缺 --text / 未知参数）
 *         · 3=数据面读不到（坏 JSON / 顶层形状不对 / IO 错）⇒ **拒绝写、原档不动**
 *         · 4=业务拒绝（thread 不存在 / 这张卡已属另一本 thread）⇒ **拒绝写、原档不动**
 *         · 5=self-test 有夹具没鉴别力
 *         · 6=跑完了但有**投递失败或唤醒失败**（messages 里已记 ok:false + error，**不静默**）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/store.mjs';
import { dshHome } from './lib/paths.mjs';
import { hostRpc } from '../lib/dsh-host-rpc.mjs';

export const VERSION = '1.2.0';
/** 数据文件名（`~/.dsh` 下；已登记进 `lib\state-files.mjs`，sync:false + onDemand）。 */
export const THREADS_FILE = 'steward-threads.json';
export const THREADS_VERSION = 1;
/** thread id 形状：`th-` + 8 位小写 hex（卡面写死）。 */
export const THREAD_ID_RE = /^th-[0-9a-f]{8}$/;
/** 卡 id 只做「非空」校验：**不**拿看板去验存在性（`--thread-show` 才解析现况，取不到就 unknown）。 */
export const MAX_ID_LEN = 256;
/** 唤醒段闸①：单条消息最多唤几张（超出**只记账**，不唤）。 */
export const WAKE_MAX_PER_MESSAGE = 2;
/** 唤醒段闸②：同一张卡的冷却分钟数（判据 = 该卡 executions 末条时间）。 */
export const WAKE_COOLDOWN_MIN = 30;
/** 看板起卡接口（**唯一写面**）—— 唤醒只走它，绝不自己起会话、绝不改账本。 */
export const BOARD_ACTION_PATH = '/api/task-board/action';

const USAGE = [
  'steward-threads.mjs v' + VERSION + ' —— 协调线 C12-A/B/C · Thread 数据面 + 扇出通道 + 唤醒段',
  '',
  '用法（六个动作，都支持 --json）：',
  '  node tools\\dsh-butler\\steward-threads.mjs --thread-new --title "<一句话>" [--line "<主线>"]',
  '  node tools\\dsh-butler\\steward-threads.mjs --thread-bind   --thread <id> --card <cardId>',
  '  node tools\\dsh-butler\\steward-threads.mjs --thread-unbind --thread <id> --card <cardId>',
  '  node tools\\dsh-butler\\steward-threads.mjs --thread-list [--json]',
  '  node tools\\dsh-butler\\steward-threads.mjs --thread-show <id> [--json]',
  '  node tools\\dsh-butler\\steward-threads.mjs --thread-post --thread <id> --text "<一句话>" [--from "<来源>"] [--apply] [--no-wake]',
  '  node tools\\dsh-butler\\steward-threads.mjs --self-test [--json]',
  '',
  '--thread-post：把一句话扇给这本 thread 里**当前还在跑**的卡执行会话；已结束的订阅卡按闸**重新跑起来**。',
  '  · 缺省 = 干跑：只打印"会投给谁 / 会唤醒谁 / 跳过谁 / 为什么"，不写 messages、不投话、不唤醒',
  '  · 投递去向只走 session-say.mjs；唤醒只走看板 POST /api/task-board/action {kind:"run"}（不自造起卡）',
  '  · 唤醒三道闸：① 单条最多 ' + WAKE_MAX_PER_MESSAGE + ' 张（超出只记账 + 打印「N 张因上限未唤」）',
  '    ② 同一张卡 ' + WAKE_COOLDOWN_MIN + ' 分钟冷却（判据 = 该卡 executions 末条时间）③ --no-wake 一键关',
  '  · 在跑的卡不动（归 B 段投话）· 没跑过的/待验收的/backlog 的卡不唤 · 唤失败如实记 ok:false + error，不重试',
  '',
  '退出码：0=成功(含幂等/0 投/全被闸挡) · 2=用法错 · 3=数据面读不到(拒绝写) · 4=业务拒绝(拒绝写) · 5=self-test 红',
  '        · 6=跑完了但有投递失败或唤醒失败（messages 已记 ok:false + error）',
].join('\n');

// ---------------------------------------------------------------- 数据面（纯函数）

/** 空文档（首次写时用它起手）。 */
export function emptyDoc() {
  return { version: THREADS_VERSION, threads: [] };
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)));

/** 形状校验（写前置闸）：顶层必须能当文档用，否则**拒绝覆盖**。 */
function checkDocShape(doc) {
  if (!isObj(doc)) return '顶层不是对象';
  if ('threads' in doc && !Array.isArray(doc.threads)) return 'threads 不是数组（拒绝按空账覆盖）';
  return null;
}

/** 读侧规范化：**永不抛**（坏条目丢弃并计数，绝不把读侧变成异常源）。 */
export function normalizeThreads(doc) {
  const arr = isObj(doc) && Array.isArray(doc.threads) ? doc.threads : [];
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    if (!isObj(t)) continue;
    const id = str(t.id).trim();
    if (!THREAD_ID_RE.test(id)) continue;      // id 形状不对 = 无法用 --thread 指到它
    if (seen.has(id)) continue;                // 防御性去重：同一本不许算两遍
    seen.add(id);
    out.push({
      id,
      title: str(t.title),
      line: str(t.line),
      createdAt: str(t.createdAt) || null,
      cards: Array.isArray(t.cards) ? t.cards.map(str).filter(Boolean) : [],
      messages: Array.isArray(t.messages) ? t.messages : [],   // 读侧只透传，写侧永不 touch
    });
  }
  return out;
}

/**
 * 容错读数据文件（**只读**，不抛）。
 * @returns {{ok:boolean, exists:boolean, doc:object|null, path:string, reason?:string, error?:string}}
 */
export function readThreadsDoc(file) {
  const p = str(file);
  if (!p) return { ok: false, exists: false, doc: null, path: p, error: '没给数据文件路径' };
  if (!fs.existsSync(p)) return { ok: true, exists: false, doc: null, path: p, reason: '数据文件还不存在（首次写时自动建）' };
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); }
  catch (e) { return { ok: false, exists: true, doc: null, path: p, error: `数据文件读不到：${e && e.message ? e.message : e}` }; }
  if (!txt.trim()) return { ok: false, exists: true, doc: null, path: p, error: '数据文件是空的（拒绝按空账覆盖）' };
  let j;
  try { j = JSON.parse(txt); }
  catch (e) { return { ok: false, exists: true, doc: null, path: p, error: `数据文件不是合法 JSON：${e && e.message ? e.message : e}` }; }
  const bad = checkDocShape(j);
  if (bad) return { ok: false, exists: true, doc: null, path: p, error: `数据文件${bad}` };
  return { ok: true, exists: true, doc: j, path: p, reason: null };
}

/** 把一份文档落盘（原子写；`messages` 原样透传，本件永不改写它的内容）。 */
export function writeThreadsDoc(file, doc) {
  const out = {
    version: Number.isFinite(doc && doc.version) ? doc.version : THREADS_VERSION,
    threads: Array.isArray(doc && doc.threads) ? doc.threads : [],
  };
  const r = writeJsonAtomic(file, out);
  return { ok: true, file, bytes: r.bytes, version: out.version, threads: out.threads.length };
}

/** 生成一个新 id（`th-<8hex>`），与已有 id 撞了就重抽。 */
export function makeThreadId(threads = [], rnd = crypto.randomBytes) {
  const used = new Set((Array.isArray(threads) ? threads : []).map((t) => str(t && t.id)));
  for (let i = 0; i < 64; i++) {
    const id = 'th-' + rnd(4).toString('hex');
    if (!used.has(id)) return id;
  }
  // 64 次都撞（真实概率 ~0）⇒ 退化为时间派生，仍守 th-8hex 形状
  return 'th-' + crypto.createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8);
}

/**
 * 新建一本 thread（纯函数）。
 * @returns {{ok:boolean, code?:string, thread?:object, error?:string}}
 */
export function newThread(doc, { title, line = '', now = Date.now(), id = null } = {}) {
  const t = str(title).trim();
  if (!t) return { ok: false, code: 'no-title', error: '缺一句话标题（--title）—— 空标题建不了一本 thread' };
  const base = isObj(doc) ? { ...doc } : emptyDoc();
  const threads = Array.isArray(base.threads) ? base.threads.slice() : [];
  const tid = id && THREAD_ID_RE.test(str(id)) ? str(id) : makeThreadId(threads);
  if (threads.some((x) => isObj(x) && str(x.id) === tid)) {
    return { ok: false, code: 'dup-id', error: `id ${tid} 已存在（拒绝建第二本同 id）` };
  }
  const entry = {
    id: tid,
    title: t,
    line: str(line).trim(),
    createdAt: new Date(now).toISOString(),
    cards: [],
    messages: [],     // 🔴 本件只建空数组，永不写入（那是 B 卡的事）
  };
  threads.push(entry);
  return { ok: true, thread: entry, doc: { ...base, version: Number.isFinite(base.version) ? base.version : THREADS_VERSION, threads } };
}

const cardsOf = (t) => (isObj(t) && Array.isArray(t.cards) ? t.cards.map(str) : []);

/** 找出持有这张卡的**其它** thread（用于「不许静默改归属」）。 */
export function otherThreadsHolding(doc, cardId, exceptId) {
  const id = str(cardId);
  return normalizeThreads(doc).filter((t) => t.id !== exceptId && t.cards.includes(id));
}

/**
 * 绑定卡（纯函数，**幂等**）。
 * - 同一对本已存在 ⇒ `action:'already'`（不写盘、不动字节）
 * - 卡已属**另一本** thread ⇒ 拒绝（`code:'card-bound-elsewhere'`，**不许静默改归属**）
 * @returns {{ok:boolean, action?:'bound'|'already', code?:string, thread?:object, rival?:object, error?:string, doc?:object}}
 */
export function bindCard(doc, { threadId, cardId, now = Date.now() } = {}) {
  const tid = str(threadId).trim();
  const cid = str(cardId).trim();
  if (!tid) return { ok: false, code: 'no-thread', error: '缺 thread id（--thread）' };
  if (!cid) return { ok: false, code: 'no-card', error: '缺卡 id（--card）' };
  if (cid.length > MAX_ID_LEN) return { ok: false, code: 'bad-card', error: `卡 id 太长（>${MAX_ID_LEN} 字符）` };
  if (!THREAD_ID_RE.test(tid)) return { ok: false, code: 'no-thread', error: `thread id 形状不对（要 th-<8 位小写 hex>）：${tid}` };
  const base = isObj(doc) ? doc : emptyDoc();
  const threads = Array.isArray(base.threads) ? base.threads : [];
  const i = threads.findIndex((x) => isObj(x) && str(x.id) === tid);
  if (i < 0) return { ok: false, code: 'no-thread', error: `没有这本 thread：${tid}（先用 --thread-list 看一眼）` };
  const cur = cardsOf(threads[i]);
  if (cur.includes(cid)) {
    return { ok: true, action: 'already', thread: normalizeThreads({ threads: [threads[i]] })[0] || threads[i] };
  }
  const rival = otherThreadsHolding({ threads }, cid, tid)[0] || null;
  if (rival) {
    return {
      ok: false, code: 'card-bound-elsewhere', rival, thread: threads[i],
      error: `这张卡已经属于另一本 thread（${rival.id}《${rival.title}》）—— 不动它的归属`,
    };
  }
  const next = { ...threads[i], cards: [...cur, cid] };
  const outThreads = threads.slice();
  outThreads[i] = next;
  return {
    ok: true, action: 'bound', thread: next, now: new Date(now).toISOString(),
    doc: { ...base, version: Number.isFinite(base.version) ? base.version : THREADS_VERSION, threads: outThreads },
  };
}

/**
 * 解绑（纯函数，**幂等**）：卡本来就不在这本 ⇒ `action:'absent'`（不写盘、不报错）。
 * @returns {{ok:boolean, action?:'unbound'|'absent', code?:string, thread?:object, error?:string, doc?:object}}
 */
export function unbindCard(doc, { threadId, cardId } = {}) {
  const tid = str(threadId).trim();
  const cid = str(cardId).trim();
  if (!tid) return { ok: false, code: 'no-thread', error: '缺 thread id（--thread）' };
  if (!cid) return { ok: false, code: 'no-card', error: '缺卡 id（--card）' };
  const base = isObj(doc) ? doc : emptyDoc();
  const threads = Array.isArray(base.threads) ? base.threads : [];
  const i = threads.findIndex((x) => isObj(x) && str(x.id) === tid);
  if (i < 0) return { ok: false, code: 'no-thread', error: `没有这本 thread：${tid}` };
  const cur = cardsOf(threads[i]);
  if (!cur.includes(cid)) {
    return { ok: true, action: 'absent', thread: normalizeThreads({ threads: [threads[i]] })[0] || threads[i] };
  }
  const next = { ...threads[i], cards: cur.filter((x) => x !== cid) };
  const outThreads = threads.slice();
  outThreads[i] = next;
  return {
    ok: true, action: 'unbound', thread: next,
    doc: { ...base, version: Number.isFinite(base.version) ? base.version : THREADS_VERSION, threads: outThreads },
  };
}

// ---------------------------------------------------------------- 看板现况（只读）

/** 看板基址（缺省本机 3080；与各处 board 脚本同口径，**不带尾斜杠**）。 */
const boardBase = (baseUrl = '') => str(baseUrl || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '');

/**
 * 从看板取这几张卡的现况。**只有一条 GET**，显式带 `x-dsh-board-scope: live`。
 * 任何失败（网络 / 非 200 / 坏 JSON / 没有 tasks[]）⇒ `ok:false` + `error`，调用方标 `unknown`，**不抛**。
 * @returns {Promise<{ok:boolean, source:'api'|'none', byId:Map<string,object>, count:number, error:string|null}>}
 */
export async function fetchCardStatuses({ cardIds = [], fetchImpl = globalThis.fetch, baseUrl = '', timeoutMs = 8000 } = {}) {
  const byId = new Map();
  const base = boardBase(baseUrl);
  const want = new Set((Array.isArray(cardIds) ? cardIds : []).map(str).filter(Boolean));
  let res;
  try {
    res = await fetchImpl(`${base}/api/task-board/state`, {
      method: 'GET',
      // 同源头（缺了是 403）+ live 视图（只拿在板卡）
      headers: { origin: base, 'sec-fetch-site': 'same-origin', accept: 'application/json', 'x-dsh-board-scope': 'live' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    return { ok: false, source: 'none', byId, count: 0, error: `看板读不到：${e && e.message ? e.message : e}` };
  }
  if (!res || !res.ok) {
    return { ok: false, source: 'none', byId, count: 0, error: `看板读不到：HTTP ${res ? res.status : '(无响应)'}` };
  }
  let j;
  try { j = await res.json(); }
  catch (e) { return { ok: false, source: 'none', byId, count: 0, error: `看板返回不是合法 JSON：${e && e.message ? e.message : e}` }; }
  const tasks = Array.isArray(j && j.tasks) ? j.tasks : (Array.isArray(j && j.state && j.state.tasks) ? j.state.tasks : null);
  if (!tasks) return { ok: false, source: 'none', byId, count: 0, error: '看板返回体里没有 tasks[]' };
  let count = 0;
  for (const t of tasks) {
    if (!isObj(t) || !t.id) continue;
    count++;
    if (want.size && !want.has(str(t.id))) continue;   // 只留这次要反查的卡（不把整本账端进内存语义）
    // B 段扇出要的「这张卡最后一次执行是谁」：`executions[]` 末条的 sessionId
    //（与 `tools\board-tools\board-card-status.mjs`、`board-ops\card-state.mjs` 同字段口径）
    const exs = Array.isArray(t.executions) ? t.executions : [];
    const lastEx = exs.length ? exs[exs.length - 1] : null;
    // C 段唤醒要的「这张卡是不是已结束 + 冷却锚点」——同一个末条记录顺带取，**不多发请求**
    const endedAt = isObj(lastEx) ? lastEx.endedAt : undefined;
    const startedAt = isObj(lastEx) ? lastEx.startedAt : undefined;
    const openExecution = isObj(lastEx) && (endedAt === undefined || endedAt === null);
    const anchorRaw = Number(endedAt ?? startedAt);
    byId.set(str(t.id), {
      id: str(t.id), status: str(t.status) || 'unknown', title: str(t.title), line: str(t.line),
      lastSessionId: lastEx ? str(lastEx.sessionId) : '',
      lastResult: lastEx ? str(lastEx.result) : '',
      execCount: exs.length,
      openExecution,
      lastExecAt: Number.isFinite(anchorRaw) && anchorRaw > 0 ? anchorRaw : 0,   // 冷却锚点（末条 endedAt ?? startedAt）
    });
  }
  return { ok: true, source: 'api', byId, count, error: null };
}

// ---------------------------------------------------------------- 扇出（B 段）

/** 去向唯一通道：同目录的 session-say.mjs（**只 spawn，不改它**）。名字拼装 —— 见夹具16 的源码闸。 */
const SAY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), ['session', 'say'].join('-') + '.mjs');
/** messages 里 `via` 的取值（同样拼装：让"手打通道名去自造投递"在源码闸下无处躲）。 */
export const VIA_SAY = ['session', 'say'].join('-');

/**
 * 取会话表的 running 判据（**与 `tools\board-ops\session-state.mjs` 同源同字段**：`session.list` 的 `running`）。
 * 一次拿全量、按 sid 精确匹配（会话表是窗口制 ⇒ 未命中 = 弱判据，不当"已结束"用，见 classifyFanout）。
 * 任何失败 ⇒ `ok:false` + `error`，**不抛**。
 * @returns {Promise<{ok:boolean, byId:Map<string,{sid:string,title:string,running:boolean}>, count:number, error:string|null}>}
 */
export async function fetchSessionStates({ rpcImpl = hostRpc, baseUrl = '', timeoutMs = 20000 } = {}) {
  const base = str(baseUrl || process.env.DSH_WEB_URL || 'http://localhost:3080').replace('127.0.0.1', 'localhost').replace(/\/+$/, '');
  const byId = new Map();
  let r;
  try {
    r = await rpcImpl(base, 'session.list', {}, { timeoutMs });
  } catch (e) {
    return { ok: false, byId, count: 0, error: `会话表读不到：${e && e.message ? e.message : e}` };
  }
  const v = r?.body?.result?.value ?? r?.body?.value ?? {};
  const items = Array.isArray(v.items) ? v.items : [];
  if (!items.length) return { ok: false, byId, count: 0, error: '会话表是空的（拿不到 running 判据 ⇒ 本工具不会瞎投）' };
  for (const it of items) {
    if (!isObj(it)) continue;
    const sid = str(it.sessionId ?? it.id);
    if (!sid) continue;
    const proj = it.projections && it.projections.values ? it.projections.values.title : null;
    const title = typeof proj === 'string' && proj ? proj : str(it.title);
    byId.set(sid, { sid, title, running: it.running === true });
  }
  return { ok: true, byId, count: byId.size, error: null };
}

/**
 * 扇出分类（**纯函数**，判据全在这里，夹具直接喂假 board/sessions）。
 *
 * 三道闸按顺序：
 *   ① 卡在不在板（`boardById` 里没有 ⇒ 可能已归档）⇒ skip `card-not-live`
 *   ② 卡的最后一次执行是谁（`executions[]` 末条 sessionId）⇒ 没有 ⇒ skip `never-ran`
 *   ③ 那个会话**现在还在跑吗** ⇒ `running !== true` ⇒ skip `ended`（理由点名归 C12-C）
 * 另两条安全闸：目标是自己 ⇒ skip `self`；同一会话被多张卡指向 ⇒ **只投一次**（不重复打扰）。
 *
 * @returns {{deliver:Array<object>, skip:Array<object>}}
 */
export function classifyFanout({ cards = [], boardById = new Map(), sessionsById = new Map(), selfSid = '' } = {}) {
  const deliver = [];
  const skip = [];
  const seen = new Map();          // sessionId → 该会话已被哪张卡占了（同一会话只投一次）
  for (const cid of (Array.isArray(cards) ? cards : []).map(str).filter(Boolean)) {
    const c = boardById.get(cid) || null;
    const base = { cardId: cid, sessionId: '', title: '', cardTitle: c ? c.title : '' };
    if (!c) {
      skip.push({ ...base, reason: 'card-not-live', note: '这张卡不在在板清单里（可能已归档）—— 不投' });
      continue;
    }
    const sid = str(c.lastSessionId);
    if (!sid) {
      skip.push({ ...base, reason: 'never-ran', note: '这张卡还没有任何执行记录（executions 为空）—— 没人可投' });
      continue;
    }
    const s = sessionsById.get(sid) || null;
    const row = { ...base, sessionId: sid, title: s ? s.title : '' };
    if (selfSid && sid === selfSid) {
      skip.push({ ...row, reason: 'self', note: '这就是本工具所在的会话 —— 不投给自己' });
      continue;
    }
    if (!s) {
      skip.push({ ...row, reason: 'session-unknown', note: '会话表里没这条（窗口制 · 弱判据：不代表已结束）—— 不投' });
      continue;
    }
    if (s.running !== true) {
      skip.push({ ...row, reason: 'ended', note: '已结束 ⇒ 扇出不投话（归 C12-C 唤醒段：唤不唤由那一段的闸决定）' });
      continue;
    }
    const dup = seen.get(sid);
    if (dup) {
      skip.push({ ...row, reason: 'dup-session', note: `同一会话已被卡 ${short(dup)} 认领 ⇒ 只投一次（不重复打扰）` });
      continue;
    }
    seen.set(sid, cid);
    deliver.push({ ...row, running: true });
  }
  return { deliver, skip };
}

/** 扇出正文：头两行说明来源（收件方一眼看出这不是私人喊话，是协调线扇出）。 */
export function composeFanoutText({ thread, from = '', text = '' }) {
  const id = str(thread && thread.id);
  const title = str(thread && thread.title) || '(无标题)';
  const who = str(from).trim() || 'the operator';
  return `【协调线扇出 · ${id}《${title}》 · 来源：${who}】\n${str(text)}`;
}

/**
 * 真投一条：**只 spawn `session-say.mjs`**，不自己拼 RPC、不自己造投递。
 * @returns {{ok:boolean, code:number, stdout:string, stderr:string, error:string|null}}
 */
export function defaultSayRunner({ sid, text, nodeBin = process.execPath, sayScript = SAY_SCRIPT, env = process.env, timeoutMs = 60000 } = {}) {
  let r;
  try {
    r = spawnSync(nodeBin, [sayScript, '--to', str(sid), '--text', str(text), '--apply'], {
      encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true,
    });
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: '', error: `调 session-say 抛错：${e && e.message ? e.message : e}` };
  }
  const out = str(r.stdout);
  const err = str(r.stderr);
  const code = typeof r.status === 'number' ? r.status : (r.error ? -1 : 1);
  const firstErr = (err.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0]) || '';
  if (code === 0) return { ok: true, code, stdout: out, stderr: err, error: null };
  // 🔴 失败不静默：错误原因取 stderr 首行；没有 stderr 就退回 spawn 自带 error / stdout 首行 / rc
  const reason = firstErr || (r.error ? str(r.error.message) : '') || (out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0]) || `session-say 退出码 ${code}`;
  return { ok: false, code, stdout: out, stderr: err, error: reason };
}

/** 往这本 thread 的 `messages[]` 追加投递记录（**其它 thread / 其它字段一个字节不动**）。 */
export function appendMessages(doc, threadId, records = []) {
  const base = isObj(doc) ? doc : emptyDoc();
  const threads = Array.isArray(base.threads) ? base.threads : [];
  const i = threads.findIndex((x) => isObj(x) && str(x.id) === str(threadId));
  if (i < 0) return { ok: false, code: 'no-thread', error: `没有这本 thread：${threadId}` };
  const cur = Array.isArray(threads[i].messages) ? threads[i].messages : [];
  const next = { ...threads[i], messages: [...cur, ...records] };
  const outThreads = threads.slice();
  outThreads[i] = next;
  return { ok: true, thread: next, doc: { ...base, version: Number.isFinite(base.version) ? base.version : THREADS_VERSION, threads: outThreads } };
}

// ---------------------------------------------------------------- 唤醒（C 段 · 只唤订阅且已结束的卡）

/** messages 里唤醒记录的 `via` 取值（照实写明是哪条通道起的卡）。 */
export const VIA_BOARD_RUN = 'board-run';

/**
 * 唤醒分类（**纯函数**，判据全在这里，夹具直接喂假 board）。
 *
 * 三段互斥：
 *   `wake`    = 通过所有闸、该唤的（按 thread 里的卡序，最多 `maxPerMessage` 张）
 *   `blocked` = 到了闸门被挡（**要记账**：上限 / 冷却）—— `gate.blocked` 说明挡在哪一道
 *   `skip`    = 结构上不该唤（不记账，只打印）：不在板 / 在跑 / 没跑过 / 待验收 / backlog
 *
 * 判据（顺序即优先级）：
 *   ① 卡在不在板（`boardById` 无 ⇒ 可能已归档）⇒ skip `card-not-live`
 *   ② 还在跑吗（status==='running' 或末条执行没有 endedAt）⇒ skip `running`（**B 段管，唤醒段不碰**）
 *   ③ 跑过吗（executions 为空 ⇒ 不叫"已结束"）⇒ skip `never-ran`
 *   ④ status==='review' ⇒ skip `awaiting-review`（等主人验收的活不许被重新跑一遍）
 *      status==='backlog' ⇒ skip `backlog`（没排期，不替主人排）
 *   ⑤ 冷却：`now - (末条 endedAt ?? startedAt) < cooldownMin` ⇒ blocked `cooldown`；锚点缺失 ⇒ blocked `no-anchor`
 *   ⑥ 上限：已经排了 `maxPerMessage` 张 ⇒ blocked `max-per-message`
 *
 * @returns {{wake:Array<object>, blocked:Array<object>, skip:Array<object>}}
 */
export function classifyWake({ cards = [], boardById = new Map(), now = Date.now(), maxPerMessage = WAKE_MAX_PER_MESSAGE, cooldownMin = WAKE_COOLDOWN_MIN } = {}) {
  const wake = [];
  const blocked = [];
  const skip = [];
  const cdMs = Number(cooldownMin) * 60000;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  for (const cid of (Array.isArray(cards) ? cards : []).map(str).filter(Boolean)) {
    const c = boardById.get(cid) || null;
    const base = { cardId: cid, cardTitle: c ? c.title : '', status: c ? c.status : 'unknown' };
    if (!c) {
      skip.push({ ...base, reason: 'card-not-live', note: '这张卡不在在板清单里（可能已归档）—— 不唤' });
      continue;
    }
    if (c.status === 'running' || c.openExecution === true) {
      skip.push({ ...base, reason: 'running', note: '这张卡现在还在跑（会话还活着，归 B 段投话）—— 唤醒段不动它' });
      continue;
    }
    if (!c.execCount) {
      skip.push({ ...base, reason: 'never-ran', note: '这张卡一次都没跑过（没有"已结束"这回事）—— 不唤' });
      continue;
    }
    if (c.status === 'review') {
      skip.push({ ...base, reason: 'awaiting-review', note: '这张卡在等主人验收 —— 唤醒段不许把待签的活又跑一遍' });
      continue;
    }
    if (c.status === 'backlog') {
      skip.push({ ...base, reason: 'backlog', note: '这张卡是 backlog（还没排期）—— 唤醒段不替主人排期' });
      continue;
    }
    const anchor = Number(c.lastExecAt) || 0;
    const gate = {
      maxPerMessage: Number(maxPerMessage),
      cooldownMin: Number(cooldownMin),
      anchorAt: anchor ? new Date(anchor).toISOString() : null,
      elapsedMin: anchor ? Math.round((nowMs - anchor) / 60000) : null,
    };
    if (!anchor) {
      // 锚点读不到 ⇒ 无法证明冷却已过 ⇒ **宁可不唤**（保守方向：少起一张卡，不是多起一张）
      blocked.push({ ...base, executionsBeforeCount: c.execCount, gate: { ...gate, blocked: 'no-anchor' }, note: '这张卡的末条执行没有可用时间戳 ⇒ 判断不了冷却 —— 不唤' });
      continue;
    }
    const elapsedMs = nowMs - anchor;
    if (elapsedMs < cdMs) {
      const remainingMin = Math.max(0, Math.ceil((cdMs - elapsedMs) / 60000));
      blocked.push({
        ...base, executionsBeforeCount: c.execCount, lastExecAt: anchor,
        gate: { ...gate, blocked: 'cooldown', remainingMin },
        note: `同一张卡 ${cooldownMin} 分钟内不重复唤醒（上次执行 ${Math.max(0, Math.floor(elapsedMs / 60000))} 分钟前，还差 ${remainingMin} 分钟）`,
      });
      continue;
    }
    if (wake.length >= Number(maxPerMessage)) {
      blocked.push({
        ...base, executionsBeforeCount: c.execCount, lastExecAt: anchor,
        gate: { ...gate, blocked: 'max-per-message' },
        note: `单条消息最多唤 ${maxPerMessage} 张 —— 这张因上限未唤`,
      });
      continue;
    }
    wake.push({ ...base, executionsBeforeCount: c.execCount, lastExecAt: anchor, gate });
  }
  return { wake, blocked, skip };
}

/**
 * 真唤一张：**只走看板自己的起卡接口** `POST /api/task-board/action {kind:'run', taskId}`。
 * 不自己起会话、不写账本、不改卡内容 —— 看板接受后由它自己的 runner 起卡（与 `board-ops/card-run.mjs` 同一条路）。
 * @returns {Promise<{ok:boolean, tasks?:Array<object>, revision?:number|null, error?:string}>}  **不抛**
 */
export async function defaultWakeRunner({ cardId, baseUrl = '', requester = '', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const base = boardBase(baseUrl);
  const action = { kind: 'run', taskId: str(cardId) };
  if (str(requester)) action.requester = str(requester);    // 与 card-run 同口径：没 requester 就不带该字段
  let res;
  try {
    res = await fetchImpl(`${base}${BOARD_ACTION_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin',
        accept: 'application/json', 'x-dsh-board-scope': 'live',   // 回执只要在板卡，别把整本历史端回来
      },
      body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    return { ok: false, error: `唤醒调用抛错：${e && e.message ? e.message : e}` };
  }
  let body = null;
  try { body = res && res.json ? await res.json() : null; } catch { body = null; }
  if (!res || !res.ok) {
    const why = isObj(body) && str(body.error) ? str(body.error) : '';
    return { ok: false, error: `看板拒绝唤醒：${why || 'HTTP ' + (res ? res.status : '(无响应)')}` };
  }
  if (!isObj(body)) return { ok: false, error: '唤醒返回不是合法 JSON（无法核实执行记录）' };
  if (body.ok === false) return { ok: false, error: `看板拒绝唤醒：${str(body.error) || '未给原因'}` };
  const tasks = Array.isArray(body.tasks) ? body.tasks
    : (Array.isArray(body.state && body.state.tasks) ? body.state.tasks : []);
  return { ok: true, tasks, revision: Number.isFinite(body.revision) ? body.revision : null };
}

/**
 * 核实"真的唤起来了"（纯函数）：**判据 = 该卡 executions 多了一条且末条是新的**。
 * 只看接口回 200 不算数（回到旧账本 / 幂等空转都能回 200）。
 * @returns {{ok:boolean, error?:string, executionsAfterCount?:number|null, executionId?:string|null, sessionId?:string|null, statusAfter?:string|null}}
 */
export function judgeWake({ cardId, executionsBeforeCount = 0, res = null } = {}) {
  if (!res || res.ok !== true) return { ok: false, error: str(res && res.error) || '唤醒失败（未给原因）' };
  const tasks = Array.isArray(res.tasks) ? res.tasks : [];
  const t = tasks.find((x) => isObj(x) && str(x.id) === str(cardId)) || null;
  if (!t) return { ok: false, error: '唤醒被接受，但看板回执里没有这张卡（无法核实执行记录）' };
  const exs = Array.isArray(t.executions) ? t.executions : [];
  const after = exs.length;
  const before = Number(executionsBeforeCount) || 0;
  if (after <= before) {
    return { ok: false, error: `唤醒被接受，但执行记录没有增加（${before} → ${after}）—— 不当成功`, executionsAfterCount: after, statusAfter: str(t.status) };
  }
  const last = exs[after - 1];
  return {
    ok: true, executionsAfterCount: after,
    executionId: isObj(last) && last.id ? str(last.id) : null,
    sessionId: isObj(last) && last.sessionId ? str(last.sessionId) : null,   // 起卡是异步的：这一刻可能还没 sessionId
    statusAfter: str(t.status),
  };
}

/** 组装一条唤醒记录（成功 / 失败 / 被闸挡共用；**字段齐、不编造**）。 */
export function wakeRecord({ threadId, row = {}, at, text = '' } = {}) {
  const ok = row.ok === true;
  const gateName = str(row.blocked) || str(isObj(row.gate) ? row.gate.blocked : '');
  const gated = !ok && Boolean(gateName);              // 闸门挡下（**不算失败**：不写 error，写 blocked + note）
  const rec = {
    threadId: str(threadId), cardId: str(row.cardId), cardTitle: str(row.cardTitle), kind: 'wake',
    at: str(at), ok, via: VIA_BOARD_RUN,
    statusBefore: str(row.status), executionsBeforeCount: row.executionsBeforeCount ?? null,
    executionsAfterCount: row.executionsAfterCount ?? null,
    executionId: row.executionId ?? null, sessionId: row.sessionId ?? null, statusAfter: row.statusAfter ?? null,
    gate: isObj(row.gate) ? { ...row.gate } : {},
    text: str(text),
  };
  if (!ok && !gated) rec.error = str(row.error) || '唤醒失败（未给原因）';   // 🔴 失败如实记，不静默
  if (gated) { rec.blocked = gateName; rec.note = str(row.note); }
  return rec;
}

// ---------------------------------------------------------------- CLI

const FLAGS = ['--thread-new', '--thread-bind', '--thread-unbind', '--thread-list', '--thread-show', '--thread-post', '--self-test'];

function valueAfter(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) return null;
  return v;
}
const short = (id) => (String(id).length > 12 ? `${String(id).slice(0, 8)}…` : String(id));

/**
 * 跑一次 CLI（**纯函数式**：可注入 home / file / fetchImpl，self-test 靠这个隔离生产）。
 * @returns {Promise<{code:number, stdout:string}>}
 */
export async function runCli(argv = [], opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.file ?? path.join(home, THREADS_FILE);
  const asJson = argv.includes('--json');
  const lines = [];
  const say = (s = '') => lines.push(String(s));
  const emit = (obj, human) => {
    if (asJson) say(JSON.stringify(obj, null, 2));
    else say(human);
    return { code: obj.ok === false ? (obj.exitCode || 0) : 0, stdout: lines.join('\n') };
  };
  const usage = (why) => {
    if (why) say(`❌ ${why}`);
    say(USAGE);
    return { code: 2, stdout: lines.join('\n'), payload: { ok: false, code: 'usage', error: why || 'no-argument' } };
  };

  // ① 用法闸
  const hit = FLAGS.filter((f) => argv.includes(f));
  if (!argv.length) return usage('没有任何参数 —— 这个工具不会自己动数据（先看一眼用法）');
  if (hit.length > 1) return usage(`一次只能干一件事（同时给了 ${hit.join(' / ')}）`);
  if (!hit.length) return usage(`不认识的参数：${argv.filter((a) => a.startsWith('--') || !a.startsWith('-')).join(' ')}`);

  const action = hit[0].slice(2);

  // ② --self-test 自己走（不进数据面）
  if (action === 'self-test') {
    const r = await runSelfTest({ ...opts, home, file });
    if (asJson) say(JSON.stringify({ ok: r.ok, version: VERSION, file, results: r.results }, null, 2));
    else {
      for (const x of r.results) say(`${x.ok ? '  ✓' : '  ✗'} ${x.name}${x.note ? ` —— ${x.note}` : ''}`);
      const bad = r.results.filter((x) => !x.ok).length;
      say(`\nself-test：${r.results.length - bad}/${r.results.length} 通过（v${VERSION} · 数据文件 ${file}）`);
    }
    return { code: r.ok ? 0 : 5, stdout: lines.join('\n') };
  }

  // ③ --thread-list / --thread-show 只读（不建文件）
  if (action === 'thread-list') {
    const rd = readThreadsDoc(file);
    const threads = rd.ok ? normalizeThreads(rd.doc) : [];
    const payload = {
      ok: rd.ok !== false || rd.exists === false,
      action: 'list', file, exists: rd.exists === true, version: THREADS_VERSION,
      total: threads.length,
      threads: threads.map((t) => ({ id: t.id, title: t.title, line: t.line, createdAt: t.createdAt, cards: t.cards.length })),
      error: rd.ok ? null : rd.error,
    };
    if (asJson) { say(JSON.stringify(payload, null, 2)); return { code: rd.ok ? 0 : 3, stdout: lines.join('\n') }; }
    if (!rd.ok) {
      say(`❌ 数据面读不到，什么都不列（原档不动）：${rd.error}`);
      return { code: 3, stdout: lines.join('\n') };
    }
    if (!threads.length) {
      say(`· 还没有任何 thread（${rd.exists ? '文件在、是空的' : '文件还没建'}）`);
      say(`  要建第一本：--thread-new --title "<一句话>"`);
      return { code: 0, stdout: lines.join('\n') };
    }
    say(`thread 共 ${threads.length} 本（${file}）`);
    threads.forEach((t, i) => {
      const cards = t.cards.length;
      say(`  ${i + 1}) ${t.id}《${t.title}》  主线：${t.line || '(未写)'}  卡 ${cards} 张  建于 ${t.createdAt || '(无)'}`);
      for (const c of t.cards) say(`       ├ ${c}`);
    });
    return { code: 0, stdout: lines.join('\n') };
  }

  if (action === 'thread-show') {
    const id = valueAfter(argv, '--thread-show');
    if (!id) return usage('--thread-show 后面要跟一个 thread id');
    const rd = readThreadsDoc(file);
    if (!rd.ok) {
      say(`❌ 数据面读不到（原档不动）：${rd.error}`);
      return { code: 3, stdout: lines.join('\n') };
    }
    const t = normalizeThreads(rd.doc).find((x) => x.id === id);
    if (!t) {
      const msg = `没有这本 thread：${id}（--thread-list 看现有哪些）`;
      if (asJson) say(JSON.stringify({ ok: false, action: 'show', exitCode: 4, code: 'no-thread', error: msg }, null, 2));
      else say(`❌ ${msg}`);
      return { code: 4, stdout: lines.join('\n') };
    }
    const board = await fetchCardStatuses({ cardIds: t.cards, fetchImpl: opts.fetchImpl, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs });
    const cards = t.cards.map((cid) => {
      const c = board.byId.get(cid) || null;
      return {
        cardId: cid,
        status: c ? c.status : 'unknown',          // 取不到 ⇒ unknown（**不崩、不猜**）
        title: c ? c.title : '',
        line: c ? c.line : '',
        inBoard: Boolean(c),
      };
    });
    const payload = {
      ok: true, action: 'show', file,
      thread: { id: t.id, title: t.title, line: t.line, createdAt: t.createdAt, messages: t.messages.length },
      board: { ok: board.ok, source: board.source, count: board.count, error: board.error },
      cards,
    };
    if (asJson) { say(JSON.stringify(payload, null, 2)); return { code: 0, stdout: lines.join('\n') }; }
    say(`${t.id}《${t.title}》  主线：${t.line || '(未写)'}  建于 ${t.createdAt || '(无)'}  messages ${t.messages.length} 条（B 卡前恒 0）`);
    if (!cards.length) say('  （这本还没绑任何卡）');
    else {
      say(`  卡片 ${cards.length} 张：`);
      for (const c of cards) {
        const tag = c.inBoard ? c.status : 'unknown';
        say(`   ├ ${c.cardId}  status=${tag}${c.title ? `  ${c.title}` : ''}`);
      }
    }
    if (board.ok) say(`  看板读数：live（GET /api/task-board/state · 在板 ${board.count} 张）`);
    else say(`  ⚠️ 看板现况没读到 ⇒ 上面 status 全标 unknown（${board.error}）—— 卡本身没丢，只是没读数`);
    return { code: 0, stdout: lines.join('\n') };
  }

  // ③b --thread-post（B 段 · 扇出 + C 段 · 唤醒）：缺省**干跑**；只有 --apply 才真投 / 真唤 / 写 messages
  if (action === 'thread-post') {
    const tid = valueAfter(argv, '--thread') || '';
    const text = str(valueAfter(argv, '--text') ?? '');
    const from = str(valueAfter(argv, '--from') ?? '').trim() || 'the operator';
    const apply = argv.includes('--apply');
    const noWake = argv.includes('--no-wake');              // 闸③：一键关唤醒段（= 回到 C12-B 行为）
    const nowMs = Number(opts.now ?? Date.now());
    const selfSid = str(opts.selfSid ?? process.env.DSH_SESSION_ID);
    const requester = str(opts.requester ?? process.env.DSH_SESSION_ID ?? '').trim();
    const at = new Date(nowMs).toISOString();

    const bail = (exitCode, code, error, human) => {
      const payload = { ok: false, action: 'post', exitCode, code, error, file };
      if (asJson) say(JSON.stringify(payload, null, 2));
      else say(human || `❌ ${error}`);
      return { code: exitCode, stdout: lines.join('\n') };
    };

    if (!tid) return bail(2, 'no-thread', '--thread-post 必须带 --thread <id>', '❌ --thread-post 必须带 --thread <id>（先 --thread-list 看一眼有哪些本）');
    if (!THREAD_ID_RE.test(tid)) return bail(4, 'bad-thread-id', `thread id 形状不对（要 th-<8 位小写 hex>）：${tid}`, `❌ thread id 形状不对（要 th-<8 位小写 hex>）：${tid}`);
    if (!text.trim()) return bail(2, 'no-text', '--thread-post 必须带 --text "<一句话>"', '❌ 缺正文（--text）—— 空正文不投：扇出是**真打扰别的会话**，不许空投');

    const rd = readThreadsDoc(file);
    if (!rd.ok) return bail(3, 'unreadable', rd.error, `❌ 数据面读不到，拒绝动（原档一个字节不动）：${rd.error}\n   档：${file}`);
    const t = normalizeThreads(rd.doc).find((x) => x.id === tid);
    if (!t) return bail(4, 'no-thread', `没有这本 thread：${tid}（--thread-list 看现有哪些）`, `❌ 没有这本 thread：${tid}（--thread-list 看现有哪些）`);

    // 两次只读：看板（live，一次 GET） + 会话表（session.list，判 running）
    const sessionsFn = opts.fetchSessions || fetchSessionStates;
    const tasks = [];
    if (t.cards.length) {
      tasks.push(fetchCardStatuses({ cardIds: t.cards, fetchImpl: opts.fetchImpl, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs }));
    } else {
      tasks.push(Promise.resolve({ ok: true, source: 'none', byId: new Map(), count: 0, error: null }));
    }
    tasks.push(sessionsFn({ baseUrl: opts.baseUrl, timeoutMs: opts.sessionTimeoutMs ?? 20000, rpcImpl: opts.rpcImpl }));
    const [board, sess] = await Promise.all(tasks);

    const plan = classifyFanout({ cards: t.cards, boardById: board.byId, sessionsById: sess.byId, selfSid });
    const body = composeFanoutText({ thread: t, from, text });
    const msgBefore = Array.isArray(t.messages) ? t.messages.length : 0;

    // 🔴 会话表读不到 ⇒ **一个都投不出去**（running 判据没有 = 会瞎投）。此时绝不进 apply。
    if (!sess.ok && plan.deliver.length) {
      // 理论上走不到（sessionsById 空 ⇒ 全落 session-unknown / ended），留作双保险
      plan.skip.push(...plan.deliver.map((d) => ({ ...d, running: false, reason: 'session-unknown', note: '会话表读不到 ⇒ 不投' })));
      plan.deliver.length = 0;
    }

    // apply：逐条 spawn session-say（**只走它**），失败记 ok:false + error 首行
    const results = plan.deliver.map((d) => ({ ...d, ok: null, error: null }));
    if (apply && results.length) {
      const runner = opts.sayRunner || defaultSayRunner;
      for (const row of results) {
        const r = await runner({ sid: row.sessionId, text: body });
        row.ok = r && r.ok === true;
        row.error = row.ok ? null : str(r && r.error) || 'session-say 失败（未给原因）';
        row.rc = r && typeof r.code === 'number' ? r.code : null;
      }
    }
    const failed = results.filter((r) => r.ok === false).length;

    // ---- C 段唤醒：只唤"订阅且已结束"的卡，三道闸（上限 / 冷却 / --no-wake）
    const wakePlan = noWake
      ? { wake: [], blocked: [], skip: [] }
      : classifyWake({ cards: t.cards, boardById: board.byId, now: nowMs, maxPerMessage: WAKE_MAX_PER_MESSAGE, cooldownMin: WAKE_COOLDOWN_MIN });
    const wakeRows = wakePlan.wake.map((w) => ({ ...w, ok: null, error: null }));
    if (apply && wakeRows.length) {
      const wakeR = opts.wakeRunner || defaultWakeRunner;
      for (const row of wakeRows) {                 // 🔴 只走一遍：**单条消息内不重试**（失败如实记，不补第二发）
        let res;
        try {
          res = await wakeR({ cardId: row.cardId, baseUrl: opts.baseUrl, requester, fetchImpl: opts.fetchImpl, timeoutMs: opts.wakeTimeoutMs ?? 15000 });
        } catch (e) {
          res = { ok: false, error: `唤醒调用抛错：${e && e.message ? e.message : e}` };
        }
        const v = judgeWake({ cardId: row.cardId, executionsBeforeCount: row.executionsBeforeCount, res });
        row.ok = v.ok === true;
        row.error = row.ok ? null : (str(v.error) || '唤醒失败（未给原因）');
        row.executionsAfterCount = v.executionsAfterCount ?? null;
        row.executionId = v.executionId ?? null;
        row.sessionId = v.sessionId ?? null;
        row.statusAfter = v.statusAfter ?? null;
      }
    }
    const wakeFailed = wakeRows.filter((r) => r.ok === false).length;
    const woken = wakeRows.filter((r) => r.ok === true).length;
    // 被闸挡下（上限/冷却）**也要记账**：账面上能看出"这条消息本来还有人该唤、为什么没唤"
    const wakeBlockedRecords = apply && !noWake ? wakePlan.blocked.map((b) => wakeRecord({ threadId: t.id, row: { ...b, ok: false }, at, text })) : [];
    const capBlocked = wakePlan.blocked.filter((b) => b.gate && b.gate.blocked === 'max-per-message');

    // 写 messages（**只有 apply 且有投递或唤醒记录**；干跑一个字节都不写）
    let bytes = null;
    const deliverRecords = apply ? results.map((r) => ({
      threadId: t.id, cardId: r.cardId, sessionId: r.sessionId,
      title: r.title || r.cardTitle || '',
      at, ok: r.ok, via: VIA_SAY,
      ...(r.ok ? {} : { error: r.error || '未知失败' }),
      text,
    })) : [];
    const wakeRecords = apply ? [...wakeRows.map((r) => wakeRecord({ threadId: t.id, row: r, at, text })), ...wakeBlockedRecords] : [];
    const msgRecords = [...deliverRecords, ...wakeRecords];
    if (msgRecords.length) {
      const ap = appendMessages(rd.doc, t.id, msgRecords);
      if (!ap.ok) return bail(4, ap.code || 'no-thread', ap.error, `❌ 追加 messages 失败：${ap.error}`);
      const w = writeThreadsDoc(file, ap.doc);
      bytes = w.bytes;
    }

    const totalFailed = failed + wakeFailed;
    const payload = {
      ok: totalFailed === 0, action: 'post', apply, dryRun: !apply,
      exitCode: totalFailed ? 6 : 0,
      file, from, textChars: text.length, textBytes: Buffer.byteLength(body, 'utf8'),
      thread: { id: t.id, title: t.title, line: t.line, cards: t.cards.length },
      board: { ok: board.ok, source: board.source, count: board.count, error: board.error },
      sessions: { ok: sess.ok, count: sess.count, error: sess.error },
      deliver: results.map((r) => ({
        cardId: r.cardId, sessionId: r.sessionId, title: r.title || r.cardTitle || '',
        cardTitle: r.cardTitle || '', running: true,
        ...(apply ? { ok: r.ok, error: r.error, rc: r.rc ?? null } : {}),
      })),
      skip: plan.skip,
      wake: {
        enabled: !noWake, maxPerMessage: WAKE_MAX_PER_MESSAGE, cooldownMin: WAKE_COOLDOWN_MIN,
        requester: requester || null, via: VIA_BOARD_RUN,
        candidates: wakeRows.map((r) => ({
          cardId: r.cardId, cardTitle: r.cardTitle, statusBefore: r.status,
          executionsBeforeCount: r.executionsBeforeCount,
          ...(apply ? { ok: r.ok, executionsAfterCount: r.executionsAfterCount, executionId: r.executionId, sessionId: r.sessionId, statusAfter: r.statusAfter, error: r.error } : {}),
        })),
        woken: apply ? woken : 0,
        failed: apply ? wakeFailed : 0,
        blocked: wakePlan.blocked,
        capBlocked: capBlocked.length,
        skip: wakePlan.skip,
      },
      messages: { before: msgBefore, after: msgRecords.length ? msgBefore + msgRecords.length : msgBefore, written: msgRecords.length, bytes, deliver: deliverRecords.length, wake: wakeRecords.length },
      touched: msgRecords.length > 0,
    };
    if (asJson) { say(JSON.stringify(payload, null, 2)); return { code: totalFailed ? 6 : 0, stdout: lines.join('\n') }; }

    // ---- 人话 ----
    const head = apply ? `[apply] ${t.id}《${t.title}》 —— 真投` : `[干跑] ${t.id}《${t.title}》 —— 什么都没写（加 --apply 才真投 / 真唤）`;
    say(head);
    say(`  来源：${from}   卡片 ${t.cards.length} 张   正文 ${payload.textBytes} B`);
    if (results.length) {
      say(`  会投给 ${results.length} 个在跑的会话：`);
      for (const r of results) {
        const st = apply ? (r.ok ? '✅' : '✗ ') : '  →';
        say(`    ${st} ${r.sessionId}  ${(r.title || '(无标题)').slice(0, 50)}`);
        say(`        卡 ${r.cardId}${r.cardTitle ? `  ${r.cardTitle.slice(0, 40)}` : ''}${r.ok === false ? `\n        失败：${r.error}` : ''}`);
      }
    } else {
      say('  会投给 0 个会话（没有在跑的订阅卡）');
    }
    if (plan.skip.length) {
      say(`  跳过 ${plan.skip.length} 张（在跑判据这边）：`);
      for (const s of plan.skip) {
        say(`    · ${s.cardId}${s.sessionId ? ` → ${s.sessionId}` : ''}  ${s.note || s.reason}`);
      }
    }
    if (!sess.ok) say(`  ⚠️ 会话表读不到（${sess.error}）⇒ running 判据没有，本条一个会话都不会投。`);
    if (!board.ok) say(`  ⚠️ 看板现况没读到（${board.error}）⇒ 卡的末次执行会话未知，全按跳过处理。`);

    // ---- 唤醒段人话 ----
    if (noWake) {
      say('  唤醒段：已关（--no-wake）⇒ 回到 C12-B 行为：已结束的卡只跳过、不唤。');
    } else if (wakeRows.length) {
      say(`  ${apply ? '已唤醒' : '会唤醒'} ${wakeRows.length} 张已结束的订阅卡（单条上限 ${WAKE_MAX_PER_MESSAGE} 张 · 冷却 ${WAKE_COOLDOWN_MIN} 分钟 · via 看板 run）：`);
      for (const r of wakeRows) {
        const st = apply ? (r.ok ? '✅' : '✗ ') : '  →';
        const after = apply ? (r.executionsAfterCount ?? '?') : '?';
        say(`    ${st} ${r.cardId}  ${(r.cardTitle || '(无标题)').slice(0, 46)}`);
        say(`        status ${r.status} · 执行记录 ${r.executionsBeforeCount} → ${after}${r.executionId ? ` · 新执行 ${short(r.executionId)}` : ''}${r.ok === false ? `\n        失败：${r.error}` : ''}`);
      }
    } else {
      say(wakePlan.blocked.length
        ? `  唤醒段：0 张真唤（${wakePlan.blocked.length} 张被闸挡，见下）`
        : '  唤醒段：没有可唤醒的已结束订阅卡（在跑的不动、没跑过的不唤、待验收/backlog 不唤）');
    }
    if (capBlocked.length) say(`  ${capBlocked.length} 张因上限未唤（单条最多 ${WAKE_MAX_PER_MESSAGE} 张）：${capBlocked.map((b) => short(b.cardId)).join(' / ')}`);
    const cdBlocked = wakePlan.blocked.filter((b) => b.gate && b.gate.blocked === 'cooldown');
    for (const b of cdBlocked) say(`  · ${b.cardId} 被冷却挡：${b.note}`);
    const otherBlocked = wakePlan.blocked.filter((b) => !b.gate || !['cooldown', 'max-per-message'].includes(b.gate.blocked));
    for (const b of otherBlocked) say(`  · ${b.cardId} 不唤：${b.note}`);
    if (wakePlan.skip.length) {
      say(`  跳过 ${wakePlan.skip.length} 张（唤醒判据这边，不记账）：`);
      for (const s of wakePlan.skip) say(`    · ${s.cardId}  status=${s.status}  ${s.note || s.reason}`);
    }

    say('  正文（投出去 / 唤醒时带的那句话）：');
    say('---');
    for (const ln of body.split('\n')) say(ln);
    say('---');
    if (!apply) say('  （干跑：没写 messages、没调 session-say、没唤任何卡。要真投/真唤加 --apply）');
    else say(`  ✅ 已写 messages：${msgBefore} → ${payload.messages.after} 条（投递 ${deliverRecords.length} · 唤醒 ${wakeRecords.length}）${failed ? `，其中 ${failed} 条投递失败` : ''}${wakeFailed ? `，${wakeFailed} 张唤醒失败` : ''}${failed || wakeFailed ? '（ok:false 已记账，不静默）' : ''}`);
    if (!results.length && plan.skip.length && noWake) {
      say('  ⇒ 没有在跑的会话可投；已结束的那些**归 C12-C 唤醒段**（本命令加了 --no-wake ⇒ 不唤）。');
    }
    return { code: totalFailed ? 6 : 0, stdout: lines.join('\n') };
  }

  // ④ 三个写动作：先读（坏档就地拒绝），再纯函数算，再原子写
  const threadId = valueAfter(argv, '--thread') || (action === 'thread-new' ? '' : '');
  const cardId = valueAfter(argv, '--card') || '';
  const title = valueAfter(argv, '--title') || '';
  const lineArg = valueAfter(argv, '--line') ?? '';

  if (action === 'thread-new' && !title.trim()) return usage('--thread-new 必须带 --title "<一句话>"');
  if (action !== 'thread-new' && !threadId) return usage(`--${action} 必须带 --thread <id>`);
  if (action !== 'thread-new' && !cardId) return usage(`--${action} 必须带 --card <cardId>`);

  const rd = readThreadsDoc(file);
  if (!rd.ok) {
    // 🔴 坏 JSON / 形状不对 / IO 错 ⇒ 一个字节都不写
    if (asJson) say(JSON.stringify({ ok: false, action, exitCode: 3, code: 'unreadable', error: rd.error, file }, null, 2));
    else say(`❌ 数据面读不到，拒绝写（原档一个字节不动）：${rd.error}\n   档：${file}`);
    return { code: 3, stdout: lines.join('\n') };
  }
  const doc = rd.doc;

  if (action === 'thread-new') {
    const r = newThread(doc, { title, line: lineArg, now: opts.now ?? Date.now() });
    if (!r.ok) return usage(r.error);
    const w = writeThreadsDoc(file, r.doc);
    const payload = { ok: true, action: 'new', file, thread: r.thread, total: w.threads };
    return emit(payload, [
      `✅ 新 thread：${r.thread.id}`,
      `   标题：${r.thread.title}`,
      `   主线：${r.thread.line || '(未写)'}`,
      `   落点：${file}（现有 ${w.threads} 本）`,
    ].join('\n'));
  }

  if (action === 'thread-bind') {
    const r = bindCard(doc, { threadId, cardId, now: opts.now ?? Date.now() });
    if (!r.ok) {
      const payload = { ok: false, action: 'bind', exitCode: r.code === 'no-thread' ? 4 : 4, code: r.code, error: r.error, file, thread: threadId, card: cardId, rival: r.rival ? { id: r.rival.id, title: r.rival.title } : null };
      const human = r.code === 'card-bound-elsewhere'
        ? [`❌ 拒绝：这张卡已经属于另一本 thread，**不动它的归属**。`,
          `   卡：${cardId}`,
          `   现属：${r.rival.id}《${r.rival.title}》`,
          `   目标：${threadId}《${(r.thread && r.thread.title) || ''}》`,
          `   ⇒ 真要改归属，先 --thread-unbind 从原来那本摘掉，再绑到这里。`].join('\n')
        : `❌ 拒绝：${r.error}`;
      if (asJson) say(JSON.stringify(payload, null, 2)); else say(human);
      return { code: 4, stdout: lines.join('\n') };
    }
    if (r.action === 'already') {
      const payload = { ok: true, action: 'bind', result: 'already', idempotent: true, file, thread: threadId, card: cardId, cards: cardsOf(r.thread).length };
      return emit(payload, `· 已经是这个关系，什么都没改（幂等）：卡 ${short(cardId)} 本来就在 ${threadId} 里（仍 ${cardsOf(r.thread).length} 张卡）`);
    }
    const w = writeThreadsDoc(file, r.doc);
    const payload = { ok: true, action: 'bind', result: 'bound', idempotent: false, file, thread: threadId, card: cardId, cards: cardsOf(r.thread).length, bytes: w.bytes };
    return emit(payload, `✅ 已绑定：卡 ${short(cardId)} → ${threadId}《${r.thread.title}》（现有 ${cardsOf(r.thread).length} 张卡）`);
  }

  // thread-unbind
  const r = unbindCard(doc, { threadId, cardId });
  if (!r.ok) {
    const payload = { ok: false, action: 'unbind', exitCode: 4, code: r.code, error: r.error, file, thread: threadId, card: cardId };
    if (asJson) say(JSON.stringify(payload, null, 2)); else say(`❌ 拒绝：${r.error}`);
    return { code: 4, stdout: lines.join('\n') };
  }
  if (r.action === 'absent') {
    const payload = { ok: true, action: 'unbind', result: 'absent', idempotent: true, file, thread: threadId, card: cardId, cards: cardsOf(r.thread).length };
    return emit(payload, `· 这本里本来就没有这张卡，什么都没改（幂等）：${threadId} 仍 ${cardsOf(r.thread).length} 张卡`);
  }
  const w = writeThreadsDoc(file, r.doc);
  const payload = { ok: true, action: 'unbind', result: 'unbound', idempotent: false, file, thread: threadId, card: cardId, cards: cardsOf(r.thread).length, bytes: w.bytes };
  return emit(payload, `✅ 已解绑：卡 ${short(cardId)} 已从 ${threadId}《${r.thread.title}》摘掉（剩 ${cardsOf(r.thread).length} 张卡）`);
}

// ---------------------------------------------------------------- self-test

/**
 * 夹具（全部跑在临时 home 里，生产 `~/.dsh` 零写入；看板一律注入假 fetch，**不碰真接口**）。
 * 每条都带"改坏必须红"的对照断言（不然只知道过、不知道有没有鉴别力）。
 */
export async function runSelfTest(opts = {}) {
  const results = [];
  const tmp = [];
  const mkHome = () => {
    const d = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'threads-st-'));
    tmp.push(d);
    return d;
  };
  const run = async (name, fn) => {
    try { await fn(); results.push({ ok: true, name }); }
    catch (e) { results.push({ ok: false, name, note: e && e.message ? e.message : String(e) }); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const NOW = 1793600400000;       // 固定时刻（夹具不读墙钟）
  const write = (home, obj) => {
    fs.mkdirSync(home, { recursive: true });
    const p = path.join(home, THREADS_FILE);
    fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    return p;
  };
  const read = (home) => JSON.parse(fs.readFileSync(path.join(home, THREADS_FILE), 'utf8'));
  const call = async (argv, extra = {}) => {
    const home = extra.home || mkHome();
    const r = await runCli(argv, { home, now: NOW, fetchImpl: extra.fetchImpl, baseUrl: extra.baseUrl, timeoutMs: 50, ...extra });
    return { ...r, home, lines: r.stdout.split('\n') };
  };
  // 假看板：记录请求，供"只有 GET + 带 live 头"的断言用
  const mkFetch = (fn) => {
    const calls = [];
    const impl = async (url, init = {}) => {
      calls.push({ url, method: (init.method || 'GET').toUpperCase(), headers: init.headers || {} });
      return fn(url, init);
    };
    impl.calls = calls;
    return impl;
  };
  const okJson = (tasks) => async () => ({ ok: true, status: 200, json: async () => ({ tasks }) });

  await run('夹具01 · 无参数 ⇒ usage + rc 2，且**不**建数据文件', async () => {
    const home = mkHome();
    const r = await call([], { home });
    assert(r.code === 2, `无参数应 rc=2，实际 ${r.code}`);
    assert(/用法/.test(r.stdout) && /--thread-new/.test(r.stdout), 'usage 没打出来');
    assert(fs.existsSync(path.join(home, THREADS_FILE)) === false, '🔴 无参数竟然建了数据文件（不是只读）');
  });

  await run('夹具02 · 未知参数 / 一次给两个动作 ⇒ 都是 usage rc 2', async () => {
    const a = await call(['--nope']);
    assert(a.code === 2 && /不认识的参数/.test(a.stdout), `未知参数没被挡：${a.code} ${a.stdout.slice(0, 80)}`);
    const b = await call(['--thread-list', '--thread-new', '--title', 'x']);
    assert(b.code === 2 && /一次只能干一件事/.test(b.stdout), `两个动作没被挡：${b.code}`);
  });

  await run('夹具03 · --thread-new：文件不存在自动建、id 形状 th-8hex、messages 是空数组、version=1', async () => {
    const r = await call(['--thread-new', '--title', '第一本', '--line', '协调线 · 判据']);
    assert(r.code === 0, `建 thread 失败：${r.code} ${r.stdout}`);
    const doc = read(r.home);
    assert(doc.version === 1, `version 应为 1，实际 ${doc.version}`);
    assert(Array.isArray(doc.threads) && doc.threads.length === 1, `threads 条数不对：${JSON.stringify(doc.threads)}`);
    const t = doc.threads[0];
    assert(THREAD_ID_RE.test(t.id), `id 形状不对：${t.id}`);
    assert(t.title === '第一本' && t.line === '协调线 · 判据', `标题/主线不对：${JSON.stringify(t)}`);
    assert(typeof t.createdAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(t.createdAt), `createdAt 不是 ISO：${t.createdAt}`);
    assert(Array.isArray(t.cards) && t.cards.length === 0, 'cards 应为空数组');
    assert(Array.isArray(t.messages) && t.messages.length === 0, 'messages 应为空数组（B 卡前不允许有内容）');
  });

  await run('夹具04 · --thread-new 缺 --title ⇒ rc 2 拒绝且不落盘', async () => {
    const home = mkHome();
    const r = await call(['--thread-new'], { home });
    assert(r.code === 2 && /--title/.test(r.stdout), `缺 title 没被挡：${r.code}`);
    assert(fs.existsSync(path.join(home, THREADS_FILE)) === false, '🔴 被拒的 --thread-new 还是建了文件');
  });

  await run('夹具05 · bind 成功；再 bind 同一对 ⇒ 幂等（条目数不变、**文件字节一个不动**）', async () => {
    const home = mkHome();
    const a = await call(['--thread-new', '--title', 'A'], { home });
    const id = read(home).threads[0].id;
    assert(a.code === 0, 'A 没建成');
    const b1 = await call(['--thread-bind', '--thread', id, '--card', 'card-1'], { home });
    assert(b1.code === 0 && /已绑定/.test(b1.stdout), `第一次 bind 失败：${b1.stdout}`);
    assert(read(home).threads[0].cards.join(',') === 'card-1', 'cards 没写对');
    const before = fs.readFileSync(path.join(home, THREADS_FILE));
    const b2 = await call(['--thread-bind', '--thread', id, '--card', 'card-1'], { home });
    assert(b2.code === 0 && /幂等/.test(b2.stdout), `重复 bind 没走幂等：${b2.code} ${b2.stdout}`);
    const after = fs.readFileSync(path.join(home, THREADS_FILE));
    assert(read(home).threads[0].cards.length === 1, `产生了重复条目：${JSON.stringify(read(home).threads[0].cards)}`);
    assert(before.equals(after), '🔴 幂等路径竟然改了文件字节（幂等应零写入）');
  });

  await run('夹具06 · 卡已在另一本 ⇒ 拒绝（rc 4）、报错点名两本、**原档不动**', async () => {
    const home = mkHome();
    await call(['--thread-new', '--title', 'A'], { home });
    const idA = read(home).threads[0].id;
    await call(['--thread-bind', '--thread', idA, '--card', 'card-x'], { home });
    await call(['--thread-new', '--title', 'B'], { home });
    const idB = read(home).threads[1].id;
    const before = fs.readFileSync(path.join(home, THREADS_FILE));
    const r = await call(['--thread-bind', '--thread', idB, '--card', 'card-x'], { home });
    assert(r.code === 4, `跨本绑定应 rc=4，实际 ${r.code}`);
    assert(/另一本/.test(r.stdout) && r.stdout.includes(idA), `人话没点名原属那本：${r.stdout}`);
    const after = fs.readFileSync(path.join(home, THREADS_FILE));
    assert(before.equals(after), '🔴 被拒的跨本绑定改了文件（静默改归属）');
    assert(read(home).threads[1].cards.length === 0, '目标本竟被写进了卡');
  });

  await run('夹具07 · unbind：解掉后条目 -1；再解 ⇒ 幂等 absent 且 rc 0、文件不动', async () => {
    const home = mkHome();
    await call(['--thread-new', '--title', 'A'], { home });
    const id = read(home).threads[0].id;
    await call(['--thread-bind', '--thread', id, '--card', 'c1'], { home });
    const u1 = await call(['--thread-unbind', '--thread', id, '--card', 'c1'], { home });
    assert(u1.code === 0 && /已解绑/.test(u1.stdout), `解绑失败：${u1.stdout}`);
    assert(read(home).threads[0].cards.length === 0, '解绑后 cards 应为 0');
    const before = fs.readFileSync(path.join(home, THREADS_FILE));
    const u2 = await call(['--thread-unbind', '--thread', id, '--card', 'c1'], { home });
    assert(u2.code === 0 && /幂等/.test(u2.stdout), `重复解绑没走幂等：${u2.code} ${u2.stdout}`);
    assert(before.equals(fs.readFileSync(path.join(home, THREADS_FILE))), '🔴 幂等解绑改了文件');
  });

  await run('夹具08 · 指向不存在的 thread ⇒ rc 4 拒绝（bind / unbind 都拒，且不建文件）', async () => {
    const home = mkHome();
    const a = await call(['--thread-bind', '--thread', 'th-deadbeef', '--card', 'c1'], { home });
    assert(a.code === 4 && /没有这本 thread/.test(a.stdout), `bind 到不存在的本没被拒：${a.code} ${a.stdout}`);
    const b = await call(['--thread-unbind', '--thread', 'th-deadbeef', '--card', 'c1'], { home });
    assert(b.code === 4, `unbind 到不存在的本没被拒：${b.code}`);
    // 正对照：'th-deadbeef' 形状合法 ⇒ 上面两条拒的理由必须是"没有这本 thread"，不能是形状闸顺手挡掉
    assert(THREAD_ID_RE.test('th-deadbeef') === true, '（正对照失效）th-deadbeef 应当形状合法');
    const c = await call(['--thread-bind', '--thread', 'th-bad', '--card', 'c1'], { home });
    assert(c.code === 4 && /形状不对/.test(c.stdout), `形状不对的 id 应报形状：${c.code} ${c.stdout}`);
    assert(fs.existsSync(path.join(home, THREADS_FILE)) === false, '🔴 被拒的动作建了文件');
  });

  await run('夹具09 · 坏 JSON ⇒ 三个写动作全拒（rc 3）、原档逐字节不动', async () => {
    const home = mkHome();
    const p = write(home, '{ 坏掉的数据面 ');
    const before = fs.readFileSync(p);
    const cases = [
      ['--thread-new', '--title', 'x'],
      ['--thread-bind', '--thread', 'th-1234abcd', '--card', 'c'],
      ['--thread-unbind', '--thread', 'th-1234abcd', '--card', 'c'],
    ];
    for (const argv of cases) {
      const r = await call(argv, { home });
      assert(r.code === 3, `${JSON.stringify(argv)} 在坏 JSON 下应 rc=3，实际 ${r.code}`);
      assert(/拒绝写/.test(r.stdout), `${JSON.stringify(argv)} 没说"拒绝写"：${r.stdout.slice(0, 120)}`);
    }
    assert(fs.readFileSync(p).equals(before), '🔴 坏 JSON 被覆盖了（数据面直接丢）');
  });

  await run('夹具10 · 顶层形状不对（threads 不是数组 / 顶层是数组 / 空文件）⇒ 一律拒写 rc 3', async () => {
    for (const bad of [{ version: 1, threads: {} }, [1, 2, 3], '']) {
      const home = mkHome();
      const p = write(home, bad === '' ? '' : bad);
      const before = fs.readFileSync(p);
      const r = await call(['--thread-new', '--title', 'x'], { home });
      assert(r.code === 3, `${JSON.stringify(bad)} 应 rc=3，实际 ${r.code}`);
      assert(fs.readFileSync(p).equals(before), `🔴 ${JSON.stringify(bad)} 被覆盖`);
    }
  });

  await run('夹具11 · --thread-list 只读：文件不存在时不建文件；--json 可机读', async () => {
    const home = mkHome();
    const r = await call(['--thread-list'], { home });
    assert(r.code === 0 && /还没有任何 thread/.test(r.stdout), `空列不对：${r.stdout}`);
    assert(fs.existsSync(path.join(home, THREADS_FILE)) === false, '🔴 list 建了文件');
    const j = await call(['--thread-list', '--json'], { home });
    const obj = JSON.parse(j.stdout);
    assert(obj.ok === true && obj.total === 0 && obj.exists === false, `--json 形状不对：${j.stdout}`);
  });

  await run('夹具12 · --thread-show：只发**一条 GET**、带 x-dsh-board-scope: live、status 映射正确', async () => {
    const home = mkHome();
    await call(['--thread-new', '--title', 'A'], { home });
    const id = read(home).threads[0].id;
    await call(['--thread-bind', '--thread', id, '--card', 'card-1'], { home });
    await call(['--thread-bind', '--thread', id, '--card', 'card-2'], { home });
    const f = mkFetch(okJson([
      { id: 'card-1', status: 'done', title: '干完了的卡', line: '协调线 · 判据' },
      { id: 'card-2', status: 'running', title: '在跑的卡', line: '协调线 · 判据' },
      { id: 'card-other', status: 'todo', title: '无关卡' },
    ]));
    const r = await call(['--thread-show', id], { home, fetchImpl: f });
    assert(r.code === 0, `show 失败：${r.code} ${r.stdout}`);
    assert(f.calls.length === 1, `应只发一条请求，实际 ${f.calls.length} 条（不许多打）`);
    assert(f.calls[0].method === 'GET', `看板只许 GET，实际 ${f.calls[0].method}`);
    assert(f.calls[0].headers['x-dsh-board-scope'] === 'live', 'live 头丢了（会读到整本含归档卡）');
    assert(/status=done/.test(r.stdout) && /status=running/.test(r.stdout), `status 没映射对：${r.stdout}`);
    const j = JSON.parse((await call(['--thread-show', id, '--json'], { home, fetchImpl: f })).stdout);
    assert(j.ok === true && j.cards.length === 2, `--json cards 条数不对：${j.cards.length}`);
    assert(j.cards[0].status === 'done' && j.cards[1].status === 'running', '--json status 不对');
    assert(j.cards[0].title === '干完了的卡', '--json 没带标题（反查就没意义了）');
  });

  await run('夹具13 · --thread-show 看板不可达 ⇒ status 全 unknown、rc 0、**不崩**', async () => {
    const home = mkHome();
    await call(['--thread-new', '--title', 'A'], { home });
    const id = read(home).threads[0].id;
    await call(['--thread-bind', '--thread', id, '--card', 'card-1'], { home });
    const boom = async () => { throw new Error('ECONNREFUSED 127.0.0.1:3080'); };
    const r = await call(['--thread-show', id], { home, fetchImpl: boom });
    assert(r.code === 0, `看板挂了就崩：rc=${r.code}`);
    assert(/status=unknown/.test(r.stdout), `没标 unknown：${r.stdout}`);
    assert(/ECONNREFUSED/.test(r.stdout), '没把原因说出来（fail-open 要报黄）');
    const http500 = mkFetch(async () => ({ ok: false, status: 500 }));
    const r2 = await call(['--thread-show', id], { home, fetchImpl: http500 });
    assert(r2.code === 0 && /status=unknown/.test(r2.stdout) && /HTTP 500/.test(r2.stdout), `HTTP 500 路径不对：${r2.stdout}`);
    const noTasks = mkFetch(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
    const r3 = await call(['--thread-show', id], { home, fetchImpl: noTasks });
    assert(r3.code === 0 && /status=unknown/.test(r3.stdout) && /tasks/.test(r3.stdout), `没有 tasks[] 路径不对：${r3.stdout}`);
  });

  await run('夹具14 · 多本并存：list 计数与每本的卡都对；同一张卡不许跨本（全局唯一归属）', async () => {
    const home = mkHome();
    await call(['--thread-new', '--title', '甲'], { home });
    await call(['--thread-new', '--title', '乙', '--line', '别的线'], { home });
    const [idA, idB] = read(home).threads.map((t) => t.id);
    await call(['--thread-bind', '--thread', idA, '--card', 'c1'], { home });
    await call(['--thread-bind', '--thread', idB, '--card', 'c2'], { home });
    await call(['--thread-bind', '--thread', idB, '--card', 'c3'], { home });
    const doc = read(home);
    assert(doc.threads[0].cards.join(',') === 'c1', `甲本 cards 不对：${JSON.stringify(doc.threads[0].cards)}`);
    assert(doc.threads[1].cards.join(',') === 'c2,c3', `乙本 cards 不对：${JSON.stringify(doc.threads[1].cards)}`);
    const list = JSON.parse((await call(['--thread-list', '--json'], { home })).stdout);
    assert(list.total === 2, `list 本数不对：${list.total}`);
    assert(list.threads[0].cards === 1 && list.threads[1].cards === 2, `list 卡数不对：${JSON.stringify(list.threads)}`);
    // 全局唯一：c1 想进乙本 ⇒ 必须被拒（这是"不许静默改归属"的跨本侧面）
    const r = await call(['--thread-bind', '--thread', idB, '--card', 'c1'], { home });
    assert(r.code === 4 && /另一本/.test(r.stdout), `跨本没被拒：${r.code}`);
  });

  await run('夹具15 · 写动作**不碰** messages；也不给没绑卡的 thread 凭空补 messages 条目', async () => {
    const home = mkHome();
    await call(['--thread-new', '--title', 'A'], { home });
    const id = read(home).threads[0].id;
    assert(read(home).threads[0].messages.length === 0, 'messages 一上来就不是空的');
    await call(['--thread-bind', '--thread', id, '--card', 'c1'], { home });
    await call(['--thread-unbind', '--thread', id, '--card', 'c1'], { home });
    assert(read(home).threads[0].messages.length === 0, '🔴 写动作往 messages 里塞了东西（B 卡范围）');
    assert(read(home).threads[0].cards.length === 0, 'cards 应回到 0');
  });

  // ---------------- C12-B 追加：扇出通道（6 条必检 + 2 条加强） ----------------
  // 全部注入假 board / 假会话表 / 假 sayRunner：**不碰真接口、不真投一句话**。
  const mkSess = (rows) => async () => ({
    ok: true, error: null, count: rows.length,
    byId: new Map(rows.map((x) => [x.sid, { sid: x.sid, title: x.title || '', running: x.running === true }])),
  });
  const mkRunner = (behavior = 'ok') => {
    const calls = [];
    const fn = async ({ sid, text }) => {
      calls.push({ sid, text });
      if (behavior === 'ok') return { ok: true, code: 0, stdout: '✅ 已投递', stderr: '', error: null };
      if (behavior === 'throw') throw new Error('spawn 直接抛了（超时/ENOENT）');
      return { ok: false, code: 5, stdout: '', stderr: '✗ 目标已在归档名单（global.archivedSessionIds）—— 已归档的会话不投\n第二行噪声', error: '✗ 目标已在归档名单（global.archivedSessionIds）—— 已归档的会话不投' };
    };
    fn.calls = calls;
    return fn;
  };
  const boardOf = (execSid, extra = {}) => okJson([
    { id: 'card-1', status: 'running', title: '在跑的卡', line: '协调线 · 判据', executions: [{ sessionId: execSid, result: 'running' }], ...extra },
  ]);
  const mkThreadWith = async (cards = ['card-1']) => {
    const home = mkHome();
    await call(['--thread-new', '--title', '扇出用'], { home });
    const id = read(home).threads[0].id;
    for (const c of cards) await call(['--thread-bind', '--thread', id, '--card', c], { home });
    return { home, id };
  };

  await run('夹具17 · 有在跑卡 ⇒ 应投：只 spawn 一次 session-say、正文带扇出头、messages 追加 1 条且字段齐', async () => {
    const { home, id } = await mkThreadWith();
    const f = mkFetch(boardOf('session-aaaa'));
    const sess = mkSess([{ sid: 'session-aaaa', title: '卡执行会话', running: true }]);
    const runner = mkRunner('ok');
    const r = await call(['--thread-post', '--thread', id, '--text', '这条该投出去', '--apply'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: runner });
    assert(r.code === 0, `apply 应 rc=0，实际 ${r.code}\n${r.stdout}`);
    assert(runner.calls.length === 1, `应只投一次，实际 ${runner.calls.length} 次`);
    assert(runner.calls[0].sid === 'session-aaaa', `投给了谁：${runner.calls[0].sid}`);
    assert(/【协调线扇出/.test(runner.calls[0].text) && /这条该投出去/.test(runner.calls[0].text), `正文没带扇出头或正文丢了：${runner.calls[0].text}`);
    const m = read(home).threads[0].messages;
    assert(m.length === 1, `messages 应 1 条，实际 ${m.length}`);
    const e = m[0];
    assert(e.ok === true && e.via === VIA_SAY, `记录字段不对：${JSON.stringify(e)}`);
    assert(e.sessionId === 'session-aaaa' && e.cardId === 'card-1', `sid/cardId 不对：${JSON.stringify(e)}`);
    assert(e.title === '卡执行会话', `title 没取会话标题：${e.title}`);
    assert(typeof e.at === 'string' && /^\d{4}-\d\d-\d\dT/.test(e.at), `at 不是 ISO：${e.at}`);
    assert(!('error' in e), `成功记录不该带 error：${JSON.stringify(e)}`);
    // 对看板仍只一条 GET、仍带 live 头（B 段没放开看板写权限）
    assert(f.calls.length === 1 && f.calls[0].method === 'GET', `看板请求数/方法不对：${f.calls.length}`);
    assert(f.calls[0].headers['x-dsh-board-scope'] === 'live', 'B 段把 live 头弄丢了');
  });

  await run('夹具18 · 全已结束 ⇒ 0 投 + 明说归 C12-C 唤醒段 + messages 零写入（apply 也不写）', async () => {
    const { home, id } = await mkThreadWith();
    const f = mkFetch(boardOf('session-bbbb'));
    const sess = mkSess([{ sid: 'session-bbbb', title: '已经散场的会话', running: false }]);
    const runner = mkRunner('ok');
    const p = path.join(home, THREADS_FILE);
    const before = fs.readFileSync(p);
    const r = await call(['--thread-post', '--thread', id, '--text', '没人接的话', '--apply'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: runner });
    assert(r.code === 0, `全跳过应 rc=0（不是错误），实际 ${r.code}`);
    assert(runner.calls.length === 0, `🔴 已结束的会话被投了 ${runner.calls.length} 次`);
    assert(/C12-C/.test(r.stdout), `没写明归 C12-C 唤醒段：${r.stdout.slice(0, 300)}`);
    assert(fs.readFileSync(p).equals(before), '🔴 0 投竟然改了数据文件');
    const j = JSON.parse((await call(['--thread-post', '--thread', id, '--text', 'x', '--apply', '--json'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: runner })).stdout);
    assert(j.deliver.length === 0 && j.skip.length === 1 && j.skip[0].reason === 'ended', `--json 分类不对：${JSON.stringify(j.skip)}`);
    assert(j.messages.written === 0 && j.touched === false, `--json 说写了：${JSON.stringify(j.messages)}`);
    assert(j.ok === true && j.exitCode === 0, `--json ok 口径不对：${JSON.stringify({ ok: j.ok, ec: j.exitCode })}`);
  });

  await run('夹具19 · thread 不存在 ⇒ rc 4 人话点名 + 不建文件', async () => {
    const home = mkHome();
    const runner = mkRunner('ok');
    const r = await call(['--thread-post', '--thread', 'th-deadbeef', '--text', 'hi', '--apply'], { home, sayRunner: runner });
    assert(r.code === 4, `应 rc=4，实际 ${r.code}`);
    assert(/没有这本 thread/.test(r.stdout), `人话不对：${r.stdout.slice(0, 120)}`);
    assert(runner.calls.length === 0, '🔴 指向不存在的本还在投');
    assert(fs.existsSync(path.join(home, THREADS_FILE)) === false, '🔴 被拒的 post 建了文件');
    const bad = await call(['--thread-post', '--thread', 'th-bad', '--text', 'hi'], { home, sayRunner: runner });
    assert(bad.code === 4 && /形状不对/.test(bad.stdout), `形状不对的 id 应报形状：${bad.code} ${bad.stdout.slice(0, 80)}`);
  });

  await run('夹具20 · text 为空 ⇒ rc 2 拒绝，且不建文件、不投、不写 messages', async () => {
    const { home, id } = await mkThreadWith();
    const p = path.join(home, THREADS_FILE);
    const before = fs.readFileSync(p);
    const runner = mkRunner('ok');
    for (const argv of [
      ['--thread-post', '--thread', id, '--apply'],
      ['--thread-post', '--thread', id, '--text', '   ', '--apply'],
      ['--thread-post', '--thread', id, '--text', '', '--apply'],
    ]) {
      const r = await call(argv, { home, sayRunner: runner });
      assert(r.code === 2, `${JSON.stringify(argv)} 应 rc=2，实际 ${r.code}`);
      assert(/空正文|缺正文/.test(r.stdout), `没说清为什么拒：${r.stdout.slice(0, 120)}`);
    }
    assert(runner.calls.length === 0, '🔴 空正文竟然投出去了');
    assert(fs.readFileSync(p).equals(before), '🔴 空正文改了数据文件');
  });

  await run('夹具21 · 缺省干跑 ⇒ 不写文件（逐字节相同）、不投、清单里有人、--json dryRun=true', async () => {
    const { home, id } = await mkThreadWith();
    const p = path.join(home, THREADS_FILE);
    const before = fs.readFileSync(p);
    const f = mkFetch(boardOf('session-cccc'));
    const sess = mkSess([{ sid: 'session-cccc', title: '在跑的会话', running: true }]);
    const runner = mkRunner('ok');
    const r = await call(['--thread-post', '--thread', id, '--text', '干跑演示'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: runner });
    assert(r.code === 0, `干跑应 rc=0，实际 ${r.code}`);
    assert(runner.calls.length === 0, `🔴 干跑投出去了 ${runner.calls.length} 次`);
    const after = fs.readFileSync(p);
    assert(before.equals(after), '🔴 干跑改了数据文件（sha 必须逐字节相同）');
    assert(/干跑/.test(r.stdout) && /会投给 1 个/.test(r.stdout), `干跑没列清单：${r.stdout.slice(0, 300)}`);
    assert(r.stdout.includes('session-cccc'), '清单里没写会投给哪个会话');
    assert(fs.existsSync(p), '（对照）文件应还在');
    const j = JSON.parse((await call(['--thread-post', '--thread', id, '--text', '干跑演示', '--json'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: runner })).stdout);
    assert(j.apply === false && j.dryRun === true, `--json 没标干跑：${JSON.stringify({ a: j.apply, d: j.dryRun })}`);
    assert(j.deliver.length === 1 && j.touched === false && j.messages.written === 0, `--json 干跑语义不对：${JSON.stringify(j.messages)}`);
    assert(runner.calls.length === 0, '🔴 --json 干跑也投出去了');
  });

  await run('夹具22 · 投递失败 ⇒ ok=false + error 有值（stderr 首行）、不抛、rc 6、messages 照记', async () => {
    const { home, id } = await mkThreadWith();
    const f = mkFetch(boardOf('session-dddd'));
    const sess = mkSess([{ sid: 'session-dddd', title: '投不进去的会话', running: true }]);
    const runner = mkRunner('fail');
    const r = await call(['--thread-post', '--thread', id, '--text', '这条会失败', '--apply'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: runner, });
    assert(r.code === 6, `有投递失败应 rc=6，实际 ${r.code}`);
    assert(/失败/.test(r.stdout), `人话没报失败：${r.stdout.slice(0, 200)}`);
    const m = read(home).threads[0].messages;
    assert(m.length === 1, `失败也要记一条（不静默），实际 ${m.length}`);
    assert(m[0].ok === false, '失败记录的 ok 应是 false');
    assert(typeof m[0].error === 'string' && m[0].error.length > 0, '🔴 失败记录没有 error');
    assert(m[0].error.includes('归档名单') && !m[0].error.includes('第二行'), `error 应是 stderr 首行，实际：${m[0].error}`);
    // 抛错的 runner 也不许把 CLI 崩掉
    const boom = mkRunner('throw');
    const r2 = await call(['--thread-post', '--thread', id, '--text', '抛错演示', '--apply'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: async () => { try { return await boom({}); } catch (e) { return { ok: false, code: -1, error: String(e.message) }; } } });
    assert(r2.code === 6, `runner 抛错时应被兜住成 rc=6，实际 ${r2.code}`);
  });

  await run('夹具23 · 同一会话被两张卡指向 ⇒ 只投一次（第二次归 dup-session）', async () => {
    const { home, id } = await mkThreadWith(['card-1', 'card-2']);
    const f = mkFetch(okJson([
      { id: 'card-1', status: 'running', title: '卡甲', executions: [{ sessionId: 'session-same' }] },
      { id: 'card-2', status: 'running', title: '卡乙', executions: [{ sessionId: 'session-same' }] },
    ]));
    const sess = mkSess([{ sid: 'session-same', title: '一条会话带两张卡', running: true }]);
    const runner = mkRunner('ok');
    const r = await call(['--thread-post', '--thread', id, '--text', '别投两遍', '--apply'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: runner });
    assert(r.code === 0, `rc 不对：${r.code}`);
    assert(runner.calls.length === 1, `🔴 同一会话被投了 ${runner.calls.length} 次（重复打扰）`);
    const j = JSON.parse((await call(['--thread-post', '--thread', id, '--text', '别投两遍', '--json'], { home, fetchImpl: f, fetchSessions: sess, sayRunner: runner })).stdout);
    assert(j.deliver.length === 1 && j.skip.some((s) => s.reason === 'dup-session'), `dup 分类不对：${JSON.stringify(j.skip)}`);
  });

  await run('夹具24 · 会话表读不到 ⇒ 一个都不投（不瞎投）、rc 0、报黄不崩', async () => {
    const { home, id } = await mkThreadWith();
    const f = mkFetch(boardOf('session-eeee'));
    const dead = async () => ({ ok: false, byId: new Map(), count: 0, error: '会话表读不到：ECONNREFUSED 127.0.0.1:3080' });
    const runner = mkRunner('ok');
    const r = await call(['--thread-post', '--thread', id, '--text', '没有判据就别投', '--apply'], { home, fetchImpl: f, fetchSessions: dead, sayRunner: runner });
    assert(runner.calls.length === 0, `🔴 会话表坏了还投了 ${runner.calls.length} 次`);
    assert(r.code === 0, `应 rc=0 报黄不崩，实际 ${r.code}`);
    assert(/会话表读不到/.test(r.stdout), `没报黄：${r.stdout.slice(0, 200)}`);
  });

  // ---------------- C12-C 追加：唤醒段（6 条必检 + 2 条加强） ----------------
  // 假看板**会真的涨执行记录**：POST {kind:'run'} ⇒ 该卡 status→running + executions 追加一条（夹具25/26 靠这个断言）。
  const mkWakeBoard = (tasks, { postFail = null, noAppend = false } = {}) => {
    const st = { tasks: JSON.parse(JSON.stringify(tasks)), posts: [], gets: 0 };
    const impl = async (url, init = {}) => {
      const method = str(init && init.method ? init.method : 'GET').toUpperCase();
      if (method === 'GET') {
        st.gets++;
        return { ok: true, status: 200, json: async () => ({ tasks: JSON.parse(JSON.stringify(st.tasks)) }) };
      }
      const body = JSON.parse(str(init && init.body) || '{}');
      st.posts.push({ url, body, headers: (init && init.headers) || {} });
      if (postFail) return { ok: false, status: 400, json: async () => ({ ok: false, error: postFail }) };
      const a = isObj(body.action) ? body.action : {};
      const t = st.tasks.find((x) => x.id === a.taskId) || null;
      if (a.kind !== 'run' || !t) return { ok: false, status: 400, json: async () => ({ ok: false, error: 'invalid-action' }) };
      if (!noAppend) {
        t.status = 'running';
        t.executions = [...(t.executions || []), { id: `ex-${a.taskId}-${(t.executions || []).length + 1}`, startedAt: NOW }];
      }
      return { ok: true, status: 200, json: async () => ({ schemaVersion: 2, revision: 7, tasks: JSON.parse(JSON.stringify(st.tasks)) }) };
    };
    impl.st = st;
    return impl;
  };
  const endedCard = (cid, { status = 'done', minutesAgo = 120, title = '', execCount = 1, ended = true } = {}) => {
    const endedAt = NOW - minutesAgo * 60000;
    return {
      id: cid, status, title: title || `卡 ${cid}`,
      executions: Array.from({ length: execCount }, (_, i) => ({
        id: `ex-${cid}-${i + 1}`, sessionId: `session-${cid}`, startedAt: endedAt - 60000,
        ...(ended ? { endedAt, result: 'succeeded' } : {}),
      })),
    };
  };
  const wakeMsgs = (home) => read(home).threads[0].messages.filter((x) => x.kind === 'wake');

  await run('夹具25 · 唤 1 张成功：真发一条 POST{kind:run}、执行记录 1→2、messages 记 ok:true via=board-run', async () => {
    const { home, id } = await mkThreadWith(['card-1']);
    const f = mkWakeBoard([endedCard('card-1', { title: '已结束的订阅卡' })]);
    const sess = mkSess([{ sid: 'session-card-1', title: '已经散场的会话', running: false }]);
    const r = await call(['--thread-post', '--thread', id, '--text', '唤醒演示', '--apply'], { home, fetchImpl: f, fetchSessions: sess });
    assert(r.code === 0, `rc 不对：${r.code}\n${r.stdout}`);
    assert(f.st.posts.length === 1, `应发 1 条唤醒 POST，实际 ${f.st.posts.length}`);
    const post = f.st.posts[0];
    assert(isObj(post.body) && isObj(post.body.action) && post.body.action.kind === 'run' && post.body.action.taskId === 'card-1', `唤醒动作不对：${JSON.stringify(post.body)}`);
    assert(typeof post.body.requestId === 'string' && post.body.requestId.length > 0, '缺 requestId（看板会当非法请求）');
    assert(post.headers['content-type'] === 'application/json' && Boolean(post.headers.origin), 'POST 缺 content-type/origin（会被 415/403 挡）');
    assert(post.headers['x-dsh-board-scope'] === 'live', '唤醒回执没要 live（会把整本历史端回来）');
    const t = f.st.tasks.find((x) => x.id === 'card-1');
    assert(t.executions.length === 2 && t.status === 'running', `🔴 执行记录没有真的多一条：${JSON.stringify(t.executions.map((e) => e.id))}`);
    const w = wakeMsgs(home);
    assert(w.length === 1, `应记 1 条唤醒记录，实际 ${w.length}`);
    const e = w[0];
    assert(e.ok === true && e.via === VIA_BOARD_RUN, `记录字段不对：${JSON.stringify(e)}`);
    assert(e.executionsBeforeCount === 1 && e.executionsAfterCount === 2, `执行记录数没记对：${JSON.stringify(e)}`);
    assert(e.executionId === 'ex-card-1-2', `新执行 id 没记：${e.executionId}`);
    assert(isObj(e.gate) && e.gate.maxPerMessage === WAKE_MAX_PER_MESSAGE && e.gate.cooldownMin === WAKE_COOLDOWN_MIN, `gate 没记：${JSON.stringify(e.gate)}`);
    assert(!('error' in e), `成功记录不该带 error：${JSON.stringify(e)}`);
    assert(typeof e.at === 'string' && /^\d{4}-\d\d-\d\dT/.test(e.at), `at 不是 ISO：${e.at}`);
    assert(/已唤醒 1 张/.test(r.stdout) && /1 → 2/.test(r.stdout), `人话没报唤醒/没报记录数：${r.stdout.slice(0, 600)}`);
  });

  await run('夹具26 · 3 张都该唤 ⇒ 只唤 2 张；第 3 张被上限挡（记账 blocked + 打印「1 张因上限未唤」）', async () => {
    const { home, id } = await mkThreadWith(['card-1', 'card-2', 'card-3']);
    const f = mkWakeBoard([endedCard('card-1'), endedCard('card-2'), endedCard('card-3')]);
    const sess = mkSess([]);
    const r = await call(['--thread-post', '--thread', id, '--text', '三张都该唤', '--apply'], { home, fetchImpl: f, fetchSessions: sess });
    assert(r.code === 0, `闸挡不算失败 ⇒ rc 应 0，实际 ${r.code}\n${r.stdout}`);
    assert(f.st.posts.length === WAKE_MAX_PER_MESSAGE, `🔴 单条消息唤了 ${f.st.posts.length} 张（上限 ${WAKE_MAX_PER_MESSAGE}）`);
    const ids = f.st.posts.map((p) => p.body.action.taskId).join(',');
    assert(ids === 'card-1,card-2', `唤醒顺序/张数不对：${ids}`);
    const third = f.st.tasks.find((x) => x.id === 'card-3');
    assert(third.executions.length === 1 && third.status === 'done', `🔴 超上限的第 3 张被执行了：${JSON.stringify(third)}`);
    const blocked = wakeMsgs(home).filter((x) => x.blocked === 'max-per-message');
    assert(blocked.length === 1 && blocked[0].cardId === 'card-3', `上限挡的那张没记账：${JSON.stringify(wakeMsgs(home))}`);
    assert(blocked[0].ok === false && isObj(blocked[0].gate) && blocked[0].gate.blocked === 'max-per-message', `记账形状不对：${JSON.stringify(blocked[0])}`);
    assert(/1 张因上限未唤/.test(r.stdout), `没打印「N 张因上限未唤」：${r.stdout.slice(0, 800)}`);
  });

  await run('夹具27 · 同一张卡 10 分钟前刚执行完 ⇒ 冷却挡（不发 POST、记账 blocked=cooldown）', async () => {
    const { home, id } = await mkThreadWith(['card-1']);
    const f = mkWakeBoard([endedCard('card-1', { minutesAgo: 10 })]);
    const sess = mkSess([]);
    const r = await call(['--thread-post', '--thread', id, '--text', '冷却演示', '--apply'], { home, fetchImpl: f, fetchSessions: sess });
    assert(r.code === 0, `冷却挡不算失败 ⇒ rc 应 0，实际 ${r.code}\n${r.stdout}`);
    assert(f.st.posts.length === 0, `🔴 冷却期里还是发了 ${f.st.posts.length} 条唤醒 POST`);
    const b = wakeMsgs(home);
    assert(b.length === 1 && b[0].blocked === 'cooldown', `冷却没记账：${JSON.stringify(b)}`);
    assert(b[0].gate.remainingMin === WAKE_COOLDOWN_MIN - 10, `剩余冷却分钟算错：${JSON.stringify(b[0].gate)}`);
    assert(/冷却/.test(r.stdout), `人话没提冷却：${r.stdout.slice(0, 600)}`);
    // 正对照：同样的卡，吃满 30 分钟之后就该放行（不然"冷却"可能只是"永远不唤"）
    const f2 = mkWakeBoard([endedCard('card-1', { minutesAgo: WAKE_COOLDOWN_MIN + 1 })]);
    const r2 = await call(['--thread-post', '--thread', id, '--text', '冷却过了', '--apply'], { home, fetchImpl: f2, fetchSessions: sess });
    assert(r2.code === 0 && f2.st.posts.length === 1, `冷却过了却仍不唤：posts=${f2.st.posts.length} ${r2.stdout.slice(0, 300)}`);
  });

  await run('夹具28 · --no-wake ⇒ 一张都不唤（0 POST、无 wake 记录、文件逐字节不动）', async () => {
    const { home, id } = await mkThreadWith(['card-1', 'card-2']);
    const f = mkWakeBoard([endedCard('card-1'), endedCard('card-2')]);
    const sess = mkSess([]);
    const p = path.join(home, THREADS_FILE);
    const before = fs.readFileSync(p);
    const r = await call(['--thread-post', '--thread', id, '--text', '关掉唤醒', '--apply', '--no-wake'], { home, fetchImpl: f, fetchSessions: sess });
    assert(r.code === 0, `rc 不对：${r.code}`);
    assert(f.st.posts.length === 0, `🔴 --no-wake 还发了 ${f.st.posts.length} 条唤醒 POST`);
    assert(wakeMsgs(home).length === 0, `🔴 --no-wake 还写了唤醒记录`);
    assert(fs.readFileSync(p).equals(before), '🔴 --no-wake 改了数据文件（等于没回到 C12-B 行为）');
    assert(/--no-wake/.test(r.stdout) && /已关/.test(r.stdout), `没说清唤醒段关了：${r.stdout.slice(0, 400)}`);
    const j = JSON.parse((await call(['--thread-post', '--thread', id, '--text', '关掉唤醒', '--json', '--no-wake'], { home, fetchImpl: f, fetchSessions: sess })).stdout);
    assert(j.wake.enabled === false && j.wake.candidates.length === 0 && f.st.posts.length === 0, `--json 里唤醒段没关：${JSON.stringify(j.wake).slice(0, 200)}`);
  });

  await run('夹具29 · 唤醒失败 ⇒ ok:false + error（看板给的原因）、rc 6、**单条消息内不重试**', async () => {
    const { home, id } = await mkThreadWith(['card-1']);
    const f = mkWakeBoard([endedCard('card-1')], { postFail: 'task is already running or missing' });
    const sess = mkSess([]);
    const r = await call(['--thread-post', '--thread', id, '--text', '这条会唤失败', '--apply'], { home, fetchImpl: f, fetchSessions: sess });
    assert(r.code === 6, `唤醒失败应 rc=6，实际 ${r.code}\n${r.stdout}`);
    assert(f.st.posts.length === 1, `🔴 失败后重试了（${f.st.posts.length} 次）—— 单条消息内不许重发`);
    const w = wakeMsgs(home);
    assert(w.length === 1 && w[0].ok === false, `失败没记账：${JSON.stringify(w)}`);
    assert(typeof w[0].error === 'string' && w[0].error.includes('already running'), `🔴 失败记录的 error 没带看板原因：${JSON.stringify(w[0])}`);
    assert(/失败/.test(r.stdout) && /唤醒失败/.test(r.stdout), `人话没报唤醒失败：${r.stdout.slice(0, 600)}`);
  });

  await run('夹具30 · 已结束但**非订阅**的卡 ⇒ 不唤（只认这本 thread 的 cards[]）', async () => {
    const { home, id } = await mkThreadWith(['card-1']);
    const f = mkWakeBoard([endedCard('card-1'), endedCard('card-other', { title: '没订阅的卡' })]);
    const sess = mkSess([]);
    const r = await call(['--thread-post', '--thread', id, '--text', '只唤订阅的', '--apply'], { home, fetchImpl: f, fetchSessions: sess });
    assert(r.code === 0, `rc 不对：${r.code}\n${r.stdout}`);
    assert(f.st.posts.length === 1, `🔴 唤了 ${f.st.posts.length} 张（应只唤订阅的 1 张）`);
    assert(f.st.posts[0].body.action.taskId === 'card-1', `唤错卡了：${f.st.posts[0].body.action.taskId}`);
    const other = f.st.tasks.find((x) => x.id === 'card-other');
    assert(other.executions.length === 1 && other.status === 'done', '🔴 非订阅卡被执行了');
    assert(!wakeMsgs(home).some((x) => x.cardId === 'card-other'), '🔴 非订阅卡进了唤醒账');
  });

  await run('夹具31 · 加强：回执 200 但执行记录没涨 ⇒ 判失败（不假成功）；干跑一张都不唤', async () => {
    const { home, id } = await mkThreadWith(['card-1']);
    const sess = mkSess([]);
    // ① 看板回 200 却没真的起卡（旧账本/幂等空转）⇒ 不许当成功
    const f = mkWakeBoard([endedCard('card-1')], { noAppend: true });
    const r = await call(['--thread-post', '--thread', id, '--text', '回执骗人', '--apply'], { home, fetchImpl: f, fetchSessions: sess });
    assert(r.code === 6, `执行记录没涨应 rc=6，实际 ${r.code}\n${r.stdout}`);
    const w = wakeMsgs(home);
    assert(w.length === 1 && w[0].ok === false && /执行记录没有增加/.test(w[0].error), `假成功没被逮到：${JSON.stringify(w)}`);
    // ② 干跑：一张都不唤、文件不动、清单里写明会唤醒谁
    const home2 = mkHome();
    await call(['--thread-new', '--title', '干跑用'], { home: home2 });
    const id2 = read(home2).threads[0].id;
    await call(['--thread-bind', '--thread', id2, '--card', 'card-1'], { home: home2 });
    const p2 = path.join(home2, THREADS_FILE);
    const before2 = fs.readFileSync(p2);
    const f2 = mkWakeBoard([endedCard('card-1', { title: '干跑该列出这张' })]);
    const r2 = await call(['--thread-post', '--thread', id2, '--text', '干跑演示'], { home: home2, fetchImpl: f2, fetchSessions: sess });
    assert(r2.code === 0, `干跑 rc 不对：${r2.code}`);
    assert(f2.st.posts.length === 0, `🔴 干跑唤了 ${f2.st.posts.length} 张`);
    assert(fs.readFileSync(p2).equals(before2), '🔴 干跑改了数据文件');
    assert(/会唤醒 1 张/.test(r2.stdout) && r2.stdout.includes('card-1'), `干跑没列出会唤醒谁：${r2.stdout.slice(0, 600)}`);
  });

  await run('夹具16 · 源码闸：看板唯一写面是起卡接口 / 投递与唤醒各走唯一出口 / 不读会话正文', async () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');   // 只查非注释行
    // ⚠️ 禁止词拼装：直写会让夹具**自己**命中自己（自查命令自身命中，2026-10-14 封板表踩过同款）
    const banned = ['notify' + '_external', 'ledger' + '-v2.json', 'host' + '-runner'];
    for (const w of banned) {
      assert(!code.includes(w), `🔴 源码（非注释行）出现禁止词：${w}`);
    }
    // 🔴 C12-B 口径：`session-say` 允许出现在**文案/记录值**里（help、错误串、messages.via），
    //    但**只许经拼装常量 SAY_SCRIPT + 唯一一处 spawnSync 调用** —— 手打路径另开通道会被这两条逮到。
    const starts = code.match(/spawnSync\(/g) || [];
    assert(starts.length === 1, `🔴 投递出口应唯一（一处 spawnSync），实际 ${starts.length} 处`);
    const stitches = code.match(/\['session', 'say'\]\.join\('-'\)/g) || [];
    // 两处：① SAY_SCRIPT = 脚本路径 ② VIA_SAY = messages.via 取值（同一个通道名，两处用途）
    assert(stitches.length === 2, `🔴 通道名应只在这两处拼装（脚本路径 / via 取值），实际 ${stitches.length} 处`);
    assert(/spawnSync\(nodeBin, \[sayScript, '--to'/.test(code), 'spawn 的参数不是 session-say 的 --to 形态（投递被改道了？）');
    assert(code.includes("'--apply'"), 'spawn 参数里没有 --apply（会变成只预览、假投递）');
    // 🔴 C12-C 口径：看板唯一写面 = 起卡接口（每张卡一条 POST），别的写方法一律不许出现
    const posts = code.match(/method:\s*'POST'/g) || [];
    assert(posts.length === 1, `🔴 唤醒出口应唯一（一处 POST），实际 ${posts.length} 处`);
    assert(code.includes('`${base}${BOARD_ACTION_PATH}`'), 'POST 的目标不是看板 action 路由（自造起卡接口？）');
    assert(/kind:\s*'run'/.test(code), '唤醒动作不是 {kind:"run"}（自造 rerun/起卡语义？）');
    const postAt = code.indexOf(['method:', "'POST'"].join(' '));   // 拼装：别让夹具自己命中自己
    const urlAt = code.indexOf('`${base}${BOARD_ACTION_PATH}`');
    assert(urlAt >= 0 && postAt > urlAt && postAt - urlAt < 400, '🔴 POST 没有紧贴看板 action 端点 ⇒ 疑似第二套起卡通道');
    const otherWrites = code.match(/method:\s*'PUT'|method:\s*'PATCH'|method:\s*'DELETE'|kind:\s*'update'|kind:\s*'confirm'|kind:\s*'move'/g) || [];
    assert(otherWrites.length === 0, `🔴 出现别的看板写动作：${otherWrites.join(',')}`);
    const gets = code.match(/method:\s*'GET'/g) || [];
    assert(gets.length === 1, `看板读法应只有一处显式 GET，实际 ${gets.length} 处`);
    assert(code.includes("'x-dsh-board-scope': 'live'"), 'live 头不在源码里');
    assert(!/execSync\(|execFileSync\(|execFile\(/.test(code), '🔴 出现了第二套进程调用（exec*）—— 投递通道必须唯一');
  });

  for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ } }
  const ok = results.every((x) => x.ok);
  return { ok, results, version: VERSION, file: opts.file ?? path.join(opts.home ?? dshHome(), THREADS_FILE) };
}

// ---------------------------------------------------------------- 入口

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    // junction 铁律：两边都过 realpath 再比（否则 import.meta.url 是物理路径、argv[1] 是逻辑路径 ⇒ 守卫静默不触发）
    const a = fs.realpathSync(fileURLToPath(import.meta.url));
    const b = fs.realpathSync(process.argv[1]);
    return a === b;
  } catch { return false; }
})();

if (isMain) {
  runCli(process.argv.slice(2))
    .then((r) => { process.stdout.write(r.stdout + '\n'); process.exitCode = r.code; })
    .catch((e) => { process.stderr.write(`steward-threads 崩了：${e && e.stack ? e.stack : e}\n`); process.exitCode = 1; });
}
