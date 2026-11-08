#!/usr/bin/env node
/**
 * 统筹线 R1-2 / R1-2b / R1-5 · Router 会话的**唯一受控手**
 *
 * 主 Router 不亲自施工（不建卡、不验收、不改代码）。它想干任何事，只能跑这一支：
 *   node <pkg>\jobs\router-act.mjs <动词>
 *
 * 动词白名单（封闭，加一个动词 = 一次改动一次审）：
 *   status     读看板 + 两个 steward 文件，按主线一屏报车况（只读，零写入）      ← R1-2
 *   brief      三行摘要（每次开口先跑）                                          ← R1-2b
 *   say        指名投话给某条主线（复用 session-say.mjs · 默认 dry-run）        ← R1-5
 *   wake       叫醒某本 thread 里已睡着的卡（复用 steward-threads.mjs）           ← R1-5
 *   card-show  只读看一张卡的一句话摘要（≤20 行，不搬卡面全文）                  ← R1-5
 *   digest     把一条线的「一句结论」追加进结论档（幂等键 = 线名+日期）          ← R1-7
 *   reset      槽位 + 待拍板写成「接续头」进结论档（**不清空任何东西**）        ← R1-7
 *
 * 版本：1.0.0 = R1-2 / R1-2b（status · brief）；**1.1.0 = R1-5**（+ say / wake / card-show + 动作流水）；
 *       **1.2.0 = R1-2d**（动作流水 + 字段 `decidedBy` / `--decided-by`）；
 *       **1.3.0 = R1-7**（+ digest / reset · 结论档 `docs\年轮\router-<YYYYMM>.md` + 一行槽位）
 *       **1.4.0 = 槽位回写一期**（2026-11-03）：`digest --replace`（就地改当天那行，缺省关闭）·
 *              `reset` 同一天只留一段接续头 · `decidedBy` 加第三值 `plugin` · 档头/接续头改「到 15% 宿主自动压」口径
 *              ⚠️ 订正注（2026-11-05 · 只标注不改上行原文）：阈值当日已由 0.15 调到 0.20，上行「15%」是**当时**口径；
 *                 现行文案一律引用 `cordis.patch.yml` 的 `thresholdRatio`、不写死百分比（改点见 1.7.x 之后的文案）。
 *       **1.5.0 = YB2-R1/R2**（2026-11-03）：`digest --ask <askId>`（槽位加 6 字符愿景指针 · 缺省一个字符都不加）·
 *              `brief --gaps`（愿景差距 Top-3 · **默认三行逐字不变**）+ `--json` 恒带 `visionGaps[]` ·
 *              `digest --dir <path>`（夹具钩子，生产别带）
 *       **1.6.0 = 年轮判据 A-1 / A-3**（2026-11-05 · 卡「Router 年轮 A1A3」）：
 *              A-1 → `brief` 第 3 行「要你定」**最多 3 条明细**、超出折叠成计数；**失败卡不当主项**
 *                    （`lib\disposition.mjs#attentionRequestFor` 那种「执行失败（failed）」条目只进折叠计数）；
 *              A-3 → 新增 `digest --auto`：把**每条有活主线**的一行结论机械写进槽位（零模型调用），
 *                    仍走 digest 那一条写盘路径（幂等键 = 线名 + 日期；槽位 ≤16 行 × 每行 ≤120 显示宽）。
 *       **1.6.1 = A-3 补缺：收口顺手刷接续头**（2026-11-05 · 卡「RouterA3接续头刷新」）：
 *              `digest --auto --apply` / `digest --line --apply` / `--replace --apply` 写完结论后，
 *              把档里**最新那段接续头的「#### 一行槽位」段**就地重渲染成当前槽位（`refreshResumeHeadSlots`）——
 *              只换那一段（时间戳 / 待拍板 / 结论区历史行一个字节不动），渲染与 `reset` 共用 `renderSlotBlock`
 *              ⇒ 逐字同构；渲染结果与档里相同就不写盘（同日重跑 sha 不变）。修的是「档里槽位停在老日期、
 *              Router 念出来还是 4 条老数据」这个缺（reset 只在收口那一刻写头，之后只往结论区追加）。
 *       **1.6.2 = A-3 取舍口径：有活的线优先**（2026-11-05 · 同一张卡打回后补）：
 *              `readSlots(max, dir, prefer)` 加第三参：给了活线集合 ⇒ **活线先占 16 个名额**，静线（今天更早
 *              也收口过、此刻无在途卡）只在活线不满时补位；组内仍按日期降序（稳定排序）。不给 ⇒ 逐字同 1.6.1。
 *              三处收口（`--auto` / `--line` / `--replace`）与 `reset` 都传同一份看板活线集合（`activeLineSetOrNull`，
 *              取数带 `x-dsh-board-scope: live`；拿不到就退回纯日期口径，不停收口）。
 *              动机：A-3 要「在跑的主线都在槽位里」，不能因为一条静线当天更早收口过就被挤出 16 名。
 *       **1.6.3 = attentions 陈旧账：读取侧兜底销账**（2026-11-05 · 卡「attentions 陈旧账兜底销账」）：
 *              `readAttentions()` 增加 stale 拆分 —— 未答 attention 的卡**已归档/删卡/不在板**（本地账本里没有）
 *              或**已完成（status=done）** ⇒ 归入 `stale`、不计入 `open`；账本读不到 / 解析失败 ⇒ **fail-open**
 *              （一条都不销，open 原样返回，`ledgerChecked=false`）。
 *              `brief` 第 1 行「等拍板 N 件」后面追加「（另有 N 件卡已归档/完成/不在板，不计入）」；
 *              `brief --json` 的 `needsOwner` 加 `staleAttentions{count,cardIds,checked}`（只加键，老键一个不动）。
 *              🔴 只做**读取侧**：不写 steward-state.json、不写 answeredAt、不删 attention、不联网（账本是本地文件）。
 *       **1.7.0 = 上手活 inflight**（2026-11-05 · 卡「Router上手活抗压缩」）：
 *              + `inflight set|show|clear` —— 把「在写什么 / 做到哪 / 下一步」记成一行文件
 *              `~/.dsh/router-inflight.json`；**由情绪插件的槽位 section 每轮重读并注入**
 *              （`dsh-feiyu-mood/lib/slots.js#renderInflight`）。为什么需要它：宿主的压缩按 token
 *              水位自动触发、**不看手上有没有未落盘的活**；section 每轮重算、不进历史 ⇒ 压完也看得见。
 *              🔴 **只加动词**：status / brief / digest / say / wake / card-show / reset 一个字节不改；
 *              写路径固定、不接受命令行传路径（免得变成通用写盘口）；`ROUTER_INFLIGHT_FILE` 只是夹具钩子。
 *
 * ── 动作流水（R1-5 新增）────────────────────────────────────────────────
 *   每跑一次 say / wake（**含 dry-run、含失败**）就追加一行到 `~/.dsh/router-ops.jsonl`：
 *     {"at":"<ISO>","verb":"say|wake","target":"…","sid":"…|null","ok":true,
 *      "source":"router-act","dryRun":true,"decidedBy":"router|owner|plugin","id":"<短号>","format":"envelope|raw|free", …}
 *   `decidedBy`（R1-2d · 2026-11-02）＝「**谁拍的**」：`router` = Router 自己拍的小决定（默认）；
 *     `owner` = 主人定的 / 主人派下来的；`plugin` = 插件/机器写的（2026-11-03 加，别让机器行冒充 Router）。
 *     CLI 用 `--decided-by owner` 显式声明。
 *     🔴 **只加字段、不改已有键名**：老行没有这个键就算老行，不重写历史。
 *   只增不改、永不重写整份文件。写失败 ⇒ 打印告警 + rc 非 0，但**绝不撤销已经真投出去的话**（如实记）。
 *   🔴 **不写进 C12-D 的 `~/.dsh/steward-disposition.jsonl`**：那份的 `kind` 是六值封闭词表，
 *      Router 的 say 没有 cardId，硬塞会污染统计（方案 §D3）。⇒ 另开一路，两条互不干涉。
 *
 * ── 投话信封（R1-5 · 主人 2026-11-02 14:48 追加要求）──────────────────────
 *   派活（两行制：第 1 行人话，第 2 行机器可判）：
 *     【派·统筹线→<线名>】<一句话：要它干什么>
 *     @@cmd=<ask|do|report|notify>; id=<短号>; reply=统筹线; prio=<now|today|when-free>; due=<YYYY-MM-DD HH:MM|->; ref=<卡id 或 报告路径|->
 *   回执：
 *     【回·<线名>→统筹线】<一句话结论>
 *     @@rep id=<同一短号>; state=<done|blocked|failed|need-decide>; out=<卡id 或 报告路径|->
 *   词表**封闭**（cmd 四值 / state 四值，不造第五个）。`say` 默认按参数自动套信封；
 *   `--raw` 是逃生口（主人自己写的整段话原样投、不套）。回执**宽容解析**：对方回自然语言也照收
 *   （`parseReply()` 导出，`format:"free"`），绝不为"没守格式"丢消息 / 报错 / 拒收。
 *
 * ── 只读边界 ─────────────────────────────────────────────────────────────
 *   status / brief / card-show **全程零写入**（不发写 RPC、不动配置）。
 *   say 的写面只有一个：[spawn] session-say.mjs（它自带身份/归档/已交接三道闸）。
 *   wake 的写面只有一个：steward-threads.mjs --thread-post（C12-C 的三道闸原样生效）。
 *   ⇒ 本件**永远不发**看板 POST：不 run / 不 move / 不 confirm。那条路只有 wake 经 thread 走。
 */
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomInt, createHash } from 'node:crypto';
import { hostRpc } from '../src/lib/dsh-host-rpc.mjs';
import { resolveTarget, sidOf, titleOf } from './session-say.mjs';
// YB2-R2：扫描年轮 json 复用 R3 的只读件（别写第二份解析逻辑）；它**永不抛**，坏 json 只报黄
import { scanYearring } from './yearring-index.mjs';

const VERSION = '1.7.0';

// 本件做 R1-5 时用了这两个常量：
//   BASE  —— status/brief 的看板取数（沿用 R1-2 口径，127.0.0.1，**不许改**：改了就是动既有动词的行为）
//   WEB   —— 新动词（card-show / 会话表）用，本机 window 口径 = localhost（卡面明确：别用 127.0.0.1）
const BASE = 'http://127.0.0.1:3080';
const WEB = (process.env.DSH_WEB_URL ?? 'http://localhost:3080').replace('127.0.0.1', 'localhost');
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const STATE_URL = `${BASE}/api/task-board/state`;
const THREADS_FILE = path.join(HOME, 'steward-threads.json');
const STEWARD_FILE = path.join(HOME, 'steward-state.json');
/**
 * 看板账本（**纯本地文件**）。2026-11-05 卡「attentions 陈旧账兜底销账」新增：
 * `readAttentions()` 用它判断一条未答 attention 的卡还在不在板。
 * 🔴 **只读本地文件，不联网、不调看板 API** —— 与 readAttentions 同一条设计原则（dsh 起不来也能收口）。
 */
const LEDGER_FILE = process.env.ROUTER_LEDGER_FILE || path.join(HOME, 'task-board', 'ledger-v2.json');
/** R1-5 · Router 自己的动作流水（**与 C12-D 的 steward-disposition.jsonl 互不相干**） */
const OPS_FILE = process.env.ROUTER_OPS_FILE || path.join(HOME, 'router-ops.jsonl');
/**
 * 上手活档（2026-11-05 · 卡「Router上手活抗压缩」）。
 * 写路径**固定** `~/.dsh/router-inflight.json`（`DSH_HOME` 优先，与 `dsh-feiyu-mood/lib/slots.js`
 * 的 `INFLIGHT_FILE` 同一口径）—— **不接受命令行传路径**，免得本件变成通用写盘口。
 * `ROUTER_INFLIGHT_FILE` 只是**夹具钩子**（换到临时目录跑测试，生产不设它）。
 */
const INFLIGHT_FILE = process.env.ROUTER_INFLIGHT_FILE || path.join(HOME, 'router-inflight.json');

/**
 * R1-7 · 结论档目录（方案 §D6：`docs\年轮\router-<YYYYMM>.md`）。
 * `ROUTER_DIGEST_DIR` 只是**夹具钩子**（换目录跑幂等测试，不碰生产档），生产不设它。
 */
const DIGEST_DIR = process.env.ROUTER_DIGEST_DIR || path.join(workspaceRoot(), 'docs', '年轮');
/** 槽位上限（方案 §D6 · 主人建议值 = 16 行、每行 ≤120 字；要调就调这两个常量 + persona 那段） */
export const SLOT_MAX = 16;
export const SLOT_CHARS = 120;
const BOARD_HEADERS = {
  origin: BASE,
  'sec-fetch-site': 'same-origin',
  'x-dsh-board-scope': 'live',
};
const TIMEOUT_MS = 30_000;

/** 本目录（投递/唤醒都 spawn 同目录的兄弟脚本，不开第二条通道） */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 投递脚本路径。**缺省就是同目录的 session-say.mjs**；
 * `ROUTER_SAY_BIN` 只是**夹具钩子**（换成记录用桩，验证"apply 到底 spawn 了什么"而不真投）。
 * 生产环境不设这个变量 ⇒ 行为与不写它时逐字一致。
 */
const SAY_SCRIPT = process.env.ROUTER_SAY_BIN || path.join(HERE, 'session-say.mjs');
/**
 * 静默来信档脚本（2026-11-06 · 卡「Router 静默收信」· 方案 §4.6）。
 * `inbox` 动词**只透传**它，不在这里实现第二套读写；`ROUTER_INBOX_BIN` 是**夹具钩子**
 * （照 `ROUTER_SAY_BIN` 的现成做法：换成记录用桩，验"到底 spawn 了什么"而不真写档）。
 */
const INBOX_SCRIPT = process.env.ROUTER_INBOX_BIN || path.join(HERE, 'router-inbox.mjs');
const THREADS_SCRIPT = path.join(HERE, 'steward-threads.mjs');

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 中日韩全角字符按 2 显示宽度算（对齐够用；emoji 不追求精确） */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function dispWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

function padW(s, width) {
  const str = String(s);
  return str + ' '.repeat(Math.max(0, width - dispWidth(str)));
}

/** 按显示宽度截断（结尾补 …） */
function clipW(s, width) {
  const str = String(s);
  if (dispWidth(str) <= width) return str;
  let out = '';
  let n = 0;
  for (const ch of str) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (n + cw > width - 1) break;
    out += ch;
    n += cw;
  }
  return out + '…';
}

function ago(ms) {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = Date.now() - ms;
  if (d < 0) return '刚刚';
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}小时前`;
  return `${Math.floor(d / 86_400_000)}天前`;
}

function stamp(ms = Date.now()) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const norm = (v) => String(v ?? '').trim();

// ── 取数 ──────────────────────────────────────────────────────────────────

async function fetchBoard() {
  const res = await fetch(STATE_URL, { headers: BOARD_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`看板 state 取数失败：HTTP ${res.status}`);
  const j = await res.json();
  // 插件端点两种外壳都见过：{result:{value}} 与裸对象
  const top = j?.result?.value ?? j;
  if (!top || !Array.isArray(top.tasks)) throw new Error('看板 state 结构异常：缺 tasks[]');
  return top;
}

/** cardId → thread.line，给卡面没写 line 的卡兜底归线 */
function readThreadLineMap() {
  const j = readJson(THREADS_FILE);
  const map = new Map();
  for (const t of j?.threads ?? []) {
    for (const c of t?.cards ?? []) map.set(c, String(t?.line ?? ''));
  }
  return map;
}

/** 「等拍板」只认未答的（answeredAt 空）—— 纯函数，夹具可测 */
function openAttentions(all) {
  return (Array.isArray(all) ? all : []).filter((a) => !a?.answeredAt);
}

/**
 * 读本地账本里「还在板」的卡：cardId → status（**只读本地文件**）。
 * @returns {Map<string,string>|null} `null` = **没核成**（文件读不到 / 解析失败 / 没有 `tasks` 数组）
 *   ⇒ 调用方必须 fail-open（一条都不销），绝不把「核不了」当成「卡不在」。
 */
export function readLedgerCardStatus(file = LEDGER_FILE) {
  const j = readJson(file);
  const tasks = j?.tasks;
  if (!Array.isArray(tasks)) return null;
  const map = new Map();
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    if (id) map.set(id, String(t?.status ?? ''));
  }
  return map;
}

/**
 * 卡已「收口」的状态：它还留在账本里，但 attention 不该再算「等主人拍板」。
 * done = 已完成（C12-D 只登记不销账，完成卡的老 attention 留着就是假信号）。
 * ⚠️ 其余状态（backlog/todo/running/review/failed/blocked）**一律保留 open** —— 宁可多报，不许误销。
 */
const CLOSED_CARD_STATUS = new Set(['done']);

/**
 * 读取侧兜底销账：把「卡已不在板」的未答 attention 拆出 stale（纯函数，夹具可测）。
 * 判据（任一命中即 stale，**不计入 open**）：
 *   ① cardId **不在**账本 `tasks[].id` 里（已归档 / 删卡 / 从来不存在）；
 *   ② cardId 在账本里但 `status=done`（完成卡不该再问「重试/归档/先放着」）。
 * 🔴 **fail-open**：`ledger` 为 null（没核成）⇒ 一条都不销，open 原样返回、stale=[]、checked=false。
 * 🔴 纯读：不写 steward-state.json、不写 answeredAt、不碰账本。
 * @param {Array} open 未答 attention
 * @param {Map<string,string>|null} ledger readLedgerCardStatus 的结果
 * @returns {{open:Array, stale:Array, staleCount:number, checked:boolean}}
 */
export function splitStaleAttentions(open = [], ledger = null) {
  const list = Array.isArray(open) ? open : [];
  if (!ledger) return { open: list, stale: [], staleCount: 0, checked: false };
  const fresh = [];
  const stale = [];
  for (const a of list) {
    const st = ledger.get(String(a?.cardId ?? ''));
    if (st === undefined || CLOSED_CARD_STATUS.has(st)) stale.push(a);
    else fresh.push(a);
  }
  return { open: fresh, stale, staleCount: stale.length, checked: true };
}

/**
 * 读 attentions + 读取侧兜底销账（**纯读本地文件，不联网**）。
 * @param {{stateFile?:string, ledgerFile?:string}} [opt] 夹具钩子；生产零参调用，行为与旧版一致（只说 open 数变了）
 * @returns {{open:Array, all:Array, stale:Array, staleCount:number, ledgerChecked:boolean}}
 */
function readAttentions(opt = {}) {
  const j = readJson(opt.stateFile ?? STEWARD_FILE);
  const all = Array.isArray(j?.attentions) ? j.attentions : [];
  const split = splitStaleAttentions(openAttentions(all), readLedgerCardStatus(opt.ledgerFile ?? LEDGER_FILE));
  return { open: split.open, all, stale: split.stale, staleCount: split.staleCount, ledgerChecked: split.checked };
}

// ── 聚合 ──────────────────────────────────────────────────────────────────

function bucketOf(status) {
  switch (status) {
    case 'running': return 'run';
    case 'todo': return 'todo';
    case 'backlog': return 'todo';   // 未排期也算「待」
    case 'review': return 'review';  // 干完卡在验收
    case 'failed': return 'failed';
    default: return null;            // done / 其它状态不进车况
  }
}

function aggregate(tasks, threadLine, threads) {
  const rows = new Map();
  const ensure = (line) => {
    const key = line || '(未归线)';
    let r = rows.get(key);
    if (!r) {
      r = { line: key, run: 0, todo: 0, review: 0, failed: 0, done: 0, lastAt: 0, cards: 0 };
      rows.set(key, r);
    }
    return r;
  };

  for (const t of tasks) {
    const direct = String(t?.line ?? '').trim();
    const line = direct || String(threadLine.get(t?.id) ?? '').trim();
    const r = ensure(line);
    r.cards += 1;
    const b = bucketOf(String(t?.status ?? ''));
    if (b) r[b] += 1;
    if (String(t?.status) === 'done') r.done += 1;
    const at = Number(t?.updatedAt ?? 0);
    if (at > r.lastAt) r.lastAt = at;
  }

  // thread 里没挂卡、但有人开过的本，也算一条线（只用来提示，不计车况）
  for (const t of threads) {
    const line = String(t?.line ?? '').trim();
    if (!line) continue;
    if (!rows.has(line)) {
      rows.set(line, { line, run: 0, todo: 0, review: 0, failed: 0, done: 0, lastAt: 0, cards: 0 });
    }
  }
  return [...rows.values()];
}

const activeCount = (r) => r.run + r.todo + r.review + r.failed;

/** 排序：失败优先（要人管）→ 在跑 → 卡验收 → 只在待 → 其余；同档按最后活动降序 */
function priority(r) {
  if (r.failed > 0) return 0;
  if (r.run > 0) return 1;
  if (r.review > 0) return 2;
  if (r.todo > 0) return 3;
  return 4;
}

// ── 输出 ──────────────────────────────────────────────────────────────────

/** attentions 的 question 里卡名是建 attention 时截断过的 ⇒ 用 cardId 回查看板真卡名 */
function attentionLabel(a, titleById) {
  const real = titleById.get(String(a?.cardId ?? ''));
  if (real) {
    const opts = Array.isArray(a?.options) && a.options.length ? a.options.join('/') : '等你定';
    return `${real} → ${opts}`;
  }
  return String(a?.question ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 「没算进等拍板」的那句说明（`brief` 第 1 行 / `status` 等拍板块共用）。
 * 三种情形：①有陈旧账被销掉 ⇒ 说清件数；②账本没核成 ⇒ 说清「没核成」（fail-open 必须露痕迹）；
 * ③都干净 ⇒ 空串（老输出一个字符都不多）。
 */
function staleNoteOf(attn) {
  if (attn?.ledgerChecked === false) return '（陈旧账没核成：账本读不到，按原样全算）';
  if (Number(attn?.staleCount) > 0) return `（另有 ${attn.staleCount} 件卡已归档/完成/不在板，不计入）`;
  return '';
}

function renderHuman(board, rows, attn, maxLines) {
  const lines = [];
  const active = rows.filter((r) => activeCount(r) > 0).sort((a, b) => {
    const d = priority(a) - priority(b);
    return d !== 0 ? d : b.lastAt - a.lastAt;
  });
  const idle = rows.filter((r) => activeCount(r) === 0);
  const totals = active.reduce(
    (acc, r) => ({ run: acc.run + r.run, todo: acc.todo + r.todo, review: acc.review + r.review, failed: acc.failed + r.failed }),
    { run: 0, todo: 0, review: 0, failed: 0 },
  );

  // 预算：标题 1 + 表头 1 + 主线 + 溢出 1 + 分隔 1 + 等拍板(标题1+条目+溢出1) + 口径注 1
  const attnMax = 3;
  const attnLines = 1 + Math.min(attn.open.length, attnMax) + (attn.open.length > attnMax ? 1 : 0);
  const fixed = 1 + 1 + 1 + 1 + attnLines + 1; // 标题/表头/分隔/口径注 + 等拍板块
  const room = Math.max(1, maxLines - fixed - 1); // 再留 1 行给溢出提示
  const show = active.slice(0, room);
  const cut = active.length - show.length;

  const lineW = 24;
  lines.push(`Router · 主线车况    ${stamp()}`);
  lines.push(`${padW('线名', lineW)} 跑  待  卡  败   最后活动`);

  for (const r of show) {
    lines.push(
      `${padW(clipW(r.line, lineW + 1), lineW)} ` +
      `${padW(r.run, 2)}  ${padW(r.todo, 2)}  ${padW(r.review, 2)}  ${padW(r.failed, 2)}   ${ago(r.lastAt)}`,
    );
  }
  if (cut > 0) {
    const rest = active.slice(room);
    const rt = rest.reduce(
      (acc, r) => ({ run: acc.run + r.run, todo: acc.todo + r.todo, review: acc.review + r.review, failed: acc.failed + r.failed }),
      { run: 0, todo: 0, review: 0, failed: 0 },
    );
    lines.push(`…另有 ${cut} 条有活主线（跑${rt.run} 待${rt.todo} 卡${rt.review} 败${rt.failed}）`.slice(0, 80));
  }

  lines.push('─'.repeat(48));

  if (attn.open.length === 0) {
    lines.push(`等拍板 0 件（没有卡在等主人）${staleNoteOf(attn)}`);
  } else {
    const titleById = new Map((board?.tasks ?? []).map((t) => [String(t?.id ?? ''), String(t?.title ?? '')]));
    lines.push(`等拍板 ${attn.open.length} 件（未答 · steward attentions）${staleNoteOf(attn)}`);
    for (const a of attn.open.slice(0, attnMax)) {
      lines.push(` · ${clipW(attentionLabel(a, titleById), 72)}`);
    }
    if (attn.open.length > attnMax) lines.push(` …还有 ${attn.open.length - attnMax} 件（全部问句看 --json）`);
  }

  lines.push(`口径 跑=running 待=todo+backlog 卡=review 败=failed ｜ 合计 跑${totals.run} 待${totals.todo} 卡${totals.review} 败${totals.failed} ｜ 静线${idle.length}条`);

  // 🔴 硬上限：宁可砍行，不许超
  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines - 1);
    keep.push(`…已截断（原始 ${lines.length} 行，--max-lines 调）`);
    return keep.join('\n');
  }
  return lines.join('\n');
}

/** cardId → 该卡所属的线（卡面 line 为空时走 thread） */
function lineOfCardMap(tasks, threadLine) {
  const map = new Map();
  for (const t of tasks) {
    const direct = String(t?.line ?? '').trim();
    map.set(String(t?.id ?? ''), direct || String(threadLine.get(t?.id) ?? '').trim() || '(未归线)');
  }
  return map;
}

/**
 * 「先看哪条」—— brief 第 2 行。
 *
 * 排序（卡 R1-2b 口径）：等主人拍板的线 → 有失败卡的 → 卡在验收的 → 还在跑的；
 * 同档取 **lastAt 最早**（等得最久的那条先看）。只有 todo/backlog 的线不当首选。
 *
 * @param {Array} rows aggregate 的结果
 * @param {Array} open 未答的 attentions
 * @param {Map<string,string>} lineOfCard cardId → 线名
 * @returns {{line:string, tier:number, why:string, lastAt:number}|null}
 */
function pickFocus(rows, open, lineOfCard) {
  const active = rows.filter((r) => activeCount(r) > 0);
  if (active.length === 0) return null;
  const attnLines = new Set(
    (Array.isArray(open) ? open : []).map((a) => lineOfCard.get(String(a?.cardId ?? ''))).filter(Boolean),
  );
  const tierOf = (r) => {
    if (attnLines.has(r.line)) return { tier: 0, why: '在等主人拍板' };
    if (r.failed > 0) return { tier: 1, why: `${r.failed} 张失败卡` };
    if (r.review > 0) return { tier: 2, why: `${r.review} 张卡等验收` };
    if (r.run > 0) return { tier: 3, why: `${r.run} 张在跑` };
    return { tier: 4, why: `只有 ${r.todo} 张排队` };
  };
  const cands = active.map((r) => ({ line: r.line, lastAt: r.lastAt, ...tierOf(r) }));
  cands.sort((a, b) => (a.tier - b.tier) || (a.lastAt - b.lastAt));
  return cands[0];
}

// ── 年轮判据 A-1（2026-11-05）：第 3 行「要你定」最多 3 条明细 ────────────────
//   判据原文（`docs\年轮\愿景-统筹线.md` A-1 · 逐字）：
//     「主人**一次只看到 ≤3 件要拍的板**（不是一屏失败卡清单）」
//   两条硬要求：
//     ① 明细 ≤3 条，超出折叠成计数（不许一屏铺开）；
//     ② 🔴 **执行失败卡不当主项** —— 那是机器该自己重试/归因的事，不是主人的板；
//        它们只进折叠计数（`失败卡 N 件机器自管`），一个都不进明细。
//   排序口径（写清、可测）：
//     第 1 档 = 真等主人拍的（`steward-state.json#attentions` 里未答、且不是失败卡派生）—— 等得最久的先摆；
//     第 2 档 = 待验收的卡（看板 status=review）—— 同样等得最久的先摆；
//     两档之后一律折叠成计数。同一档内不改原序（稳定排序）。
export const BRIEF_ASK_MAX = 3;

/** 失败卡派生的 attention 文案（口径实现 = `lib\disposition.mjs#attentionRequestFor`，这里只认字面） */
const FAILED_ATTN_RE = /执行失败（failed）|执行失败\(failed\)/;

/**
 * 这条 attention 是不是「执行失败卡」派生出来的？
 * 三条机械判据（任一命中即算 —— 卡可能已被归档/删掉，所以不能只靠看板状态）：
 *   ① 看板里同 id 的卡 status === 'failed'；
 *   ② 问句里带 `执行失败（failed）`（disposition.mjs 的固定文案）；
 *   ③ 选项恰好是 `重试/归档/先放着`（同一处固定写的三个选项）。
 */
export function isFailedCardAttention(a, statusById = new Map()) {
  const st = statusById.get(String(a?.cardId ?? '')) ?? '';
  if (st === 'failed') return true;
  if (FAILED_ATTN_RE.test(String(a?.question ?? ''))) return true;
  const opts = Array.isArray(a?.options) ? a.options.join('/') : '';
  return opts === '重试/归档/先放着';
}

/**
 * 把「要主人定的事」拆成两档 + 失败卡（纯函数，夹具直接喂假数据）。
 * @returns {{asks:Array, reviews:Array, failed:Array, statusById:Map<string,string>}}
 */
export function partitionBriefAttn({ open = [], tasks = [] } = {}) {
  const statusById = new Map((tasks || []).map((t) => [String(t?.id ?? ''), String(t?.status ?? '')]));
  const asks = [];
  const failed = [];
  for (const a of open || []) (isFailedCardAttention(a, statusById) ? failed : asks).push(a);
  const askedAt = (a) => Date.parse(String(a?.askedAt ?? '')) || 0;
  asks.sort((x, y) => askedAt(x) - askedAt(y));       // 等得最久的先摆
  const reviews = (tasks || [])
    .filter((t) => String(t?.status ?? '') === 'review')
    .map((t) => ({ cardId: String(t?.id ?? ''), title: String(t?.title ?? ''), at: Number(t?.updatedAt ?? 0) }))
    .sort((x, y) => x.at - y.at);                      // 同样：等得最久的先摆
  return { asks, reviews, failed, statusById };
}

/** 第 3 行渲染（≤3 条明细 + 折叠计数）—— 纯函数，夹具可测 */
export function renderNeedsOwner(board, attn) {
  const tasks = board?.tasks ?? [];
  const { asks, reviews, failed } = partitionBriefAttn({ open: attn?.open ?? [], tasks });
  const titleById = new Map(tasks.map((t) => [String(t?.id ?? ''), String(t?.title ?? '')]));
  const items = [
    ...asks.map((a) => clipW(attentionLabel(a, titleById), 34)),
    ...reviews.map((r) => clipW(`卡「${r.title}」待验收`, 34)),
  ];
  const shown = items.slice(0, BRIEF_ASK_MAX);
  const foldedPrimary = items.length - shown.length;
  const failedN = failed.length;
  // 序号隔开（2026-11-05 小修：原用固定「②」当分隔符 ⇒ 三条明细渲染成「①②②」重号）
  const MARKS = ['①', '②', '③'];
  const body = shown.length ? ` ${shown.map((s, i) => `${MARKS[i] ?? '·'} ${s}`).join(' ')}` : ' 0 件';
  const tail = (foldedPrimary + failedN) > 0
    ? `（另有 ${foldedPrimary + failedN} 件${failedN ? `：其中失败卡 ${failedN} 件只报数、不占你的板（没有自动重试，长期不动要点开看）` : ''}；router-act brief --json 看全量）`
    : '';
  return `要你定${body}${tail}`;
}

/**
 * `brief` —— 每次开口先跑的三行摘要（硬上限 3 行）。
 *   ①车况一行（各主线 跑/待/卡/败 + 等拍板件数）
 *   ②建议先看哪条（含理由与"多久没动"）
 *   ③要主人定的事（**最多 3 条明细**，超出折叠成计数 —— 年轮判据 A-1：
 *      「主人一次只看到 ≤3 件要拍的板」，不是一屏失败卡清单）
 */
function renderBrief(board, rows, attn, lineOfCard, maxLines = 3) {
  const active = rows.filter((r) => activeCount(r) > 0);
  const totals = active.reduce(
    (acc, r) => ({ run: acc.run + r.run, todo: acc.todo + r.todo, review: acc.review + r.review, failed: acc.failed + r.failed }),
    { run: 0, todo: 0, review: 0, failed: 0 },
  );
  const lines = [];
  lines.push(
    `车况 ${active.length} 线有活 · 跑${totals.run} 待${totals.todo} 卡${totals.review} 败${totals.failed} ｜ 等拍板 ${attn.open.length} 件${staleNoteOf(attn)}`,
  );

  const focus = pickFocus(rows, attn.open, lineOfCard);
  lines.push(focus ? `先看 ${clipW(focus.line, 28)}（${focus.why}，${ago(focus.lastAt)}）` : '先看 — 没有在途活');

  lines.push(renderNeedsOwner(board, attn));

  if (lines.length > maxLines) return lines.slice(0, maxLines).join('\n');
  return lines.join('\n');
}

// ── 愿景差距（YB2-R2 · 2026-11-03）──────────────────────────────────────────
//   源 = `docs\年轮\*.json` 里**带 `asks[]`** 的愿景件（只读；扫描复用 `yearring-index.mjs`，不写第二份解析）
//   公式 = `docs\交付报告-统筹线-年轮盘点-20261103.md` §3.4，**写死、可复现**
//   ⚠️ 只在 `brief --gaps` / `brief --json` 时才算：缺省 `brief` 仍严格三行、逐字不变
//      （主人 2026-11-02 定的「人读硬上限 3 行 · 别每句都甩车况」不许破）。

export const VISION_GAP_TOP = 3;
export const VISION_GAP_TEXT_CHARS = 40;

/** 截 N 个**字符**（不是显示宽；报告 §3.4 写的是「截 40 字」） */
function clipChars(s, n) {
  const a = [...String(s ?? '')];
  return a.length <= n ? a.join('') : `${a.slice(0, n).join('')}…`;
}

/**
 * `~/.dsh/steward-state.json#ownerPriority.items` —— **只读**。
 * 🔴 这字段**现在还不存在**（2026-11-03 现读：键列表里没有它），它属待拍板项：
 *    缺 ⇒ 按空数组处理（= 权重 0），**不报错、不写这个文件、不猜**。
 */
export function readOwnerPriorityItems() {
  const j = readJson(STEWARD_FILE);
  const items = j?.ownerPriority?.items;
  return Array.isArray(items) ? items.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
}

/** 比线名用：去掉空白与中点（"统筹线 · 判据" vs "统筹线" 才能对上） */
const keyOf = (s) => String(s ?? '').toLowerCase().replace(/[\s·・]/g, '');

/** 命中 ownerPriority：线名与条目**互为子串**即算（条目是主人随口说的短语，不会一字不差等于线名） */
export function ownerPriorityHit(line, items) {
  const l = keyOf(line);
  if (!l) return false;
  return (items || []).some((it) => {
    const s = keyOf(it);
    return !!s && (s.includes(l) || l.includes(s));
  });
}

/** 「上次收口」= 结论档里该线最新那一行；线名对不上时取**最长**的互为子串匹配，都没有 ⇒ null（不猜） */
function lastDigestOf(line, slots) {
  const l = keyOf(line);
  let best = null;
  let bestLen = -1;
  for (const s of slots || []) {
    const k = keyOf(s?.line);
    if (!k) continue;
    if (s.line === line) return s.date;
    if (l && (l.includes(k) || k.includes(l)) && k.length > bestLen) {
      bestLen = k.length;
      best = s.date;
    }
  }
  return best;
}

/**
 * 算「愿景差距」排序（纯函数，夹具直接喂假数据）。
 *
 * score(线) = 3 × C类ask数 + 2 × (在途卡数>0) + 0.5 × min(活动天数,7) − 0.2 × A类ask数 + 5 × (命中 ownerPriority)
 *
 * 「该线排名第一的 ask」= `askTop`（yearring-index 的 rankAsks：C ＞ B ＞ A，同档按原序）。
 * ⇒ A 类只有在**整条线只剩 A** 时才当第一，那时渲染成「等主人：…」而不是「差：…」。
 */
export function computeVisionGaps({ lines = [], rows = [], ownerItems = [], slots = [], now = Date.now() } = {}) {
  const inFlight = new Map();
  const lastAt = new Map();
  for (const r of rows || []) {
    inFlight.set(r.line, activeCount(r));
    lastAt.set(r.line, Number(r.lastAt) || 0);
  }

  const out = [];
  for (const L of lines || []) {
    if (!L || L.jsonStatus !== 'ok' || !L.isVision || !L.asksTotal || !L.askTop) continue;
    const line = String(L.line ?? '').trim();
    if (!line) continue;
    const cards = inFlight.get(line) ?? 0;
    const at = lastAt.get(line) ?? 0;
    const activityDays = at > 0 ? Math.max(0, Math.floor((now - at) / 86_400_000)) : 0;
    const hit = ownerPriorityHit(line, ownerItems);
    const raw = 3 * L.askC
      + 2 * (cards > 0 ? 1 : 0)
      + 0.5 * Math.min(activityDays, 7)
      - 0.2 * L.askA
      + (hit ? 5 : 0);
    out.push({
      line,
      askId: L.askTop.id,
      kind: L.askTop.kind,
      tier: L.askTop.tier,
      text: L.askTop.text,
      score: Math.round(raw * 100) / 100,
      activityDays,
      lastDigest: lastDigestOf(line, slots),
      asksTotal: L.asksTotal, askA: L.askA, askB: L.askB, askC: L.askC,
      cards,
      ownerPriority: hit,
    });
  }
  // 分数降序；同分按线名（保证**可复现**，不靠数组顺序碰运气）
  out.sort((a, b) => (b.score - a.score) || String(a.line).localeCompare(String(b.line), 'zh-Hans-CN'));
  return out;
}

/** 人读那一段：标题 + ≤3 行；没有数据时**明确写一行**，不硬凑 */
export function renderVisionGaps(gaps = [], { note = '' } = {}) {
  const L = ['愿景差距（Top-3）：'];
  const top = (gaps || []).slice(0, VISION_GAP_TOP);
  if (!top.length) {
    L.push(note || '（没有可读的年轮 json：本轮没有该推的线，先看 A 类上桌）');
    return L.join('\n');
  }
  for (const g of top) {
    const label = g.tier === 'A' ? '等主人' : '差';
    const text = clipChars(String(g.text ?? '').replace(/\s+/g, ' ').trim(), VISION_GAP_TEXT_CHARS);
    L.push(`· ${g.line}｜${label}：${text}（${g.askId} · ${g.tier}）｜活动 ${g.activityDays} 天前｜上次收口 ${g.lastDigest || '—'}`);
  }
  if (gaps.length > VISION_GAP_TOP) L.push(`（另有 ${gaps.length - VISION_GAP_TOP} 条线未展开：完整排序看 brief --json 的 visionGapsAll）`);
  else if (note) L.push(note);
  return L.join('\n');
}

/**
 * 现读年轮目录 + 车况 ⇒ 愿景差距。
 * 🔴 扫描件永不抛（坏 json 只报黄）；这里再包一层 try ⇒ **一个坏 json 不许把 brief 整条打死**。
 */
export function buildVisionGaps({ dir = DIGEST_DIR, rows = [], now = Date.now() } = {}) {
  let idx;
  try {
    idx = scanYearring(dir, now);
  } catch (e) {
    idx = { at: new Date(now).toISOString(), dir, lines: [], totals: {}, note: `扫描年轮目录失败：${e?.message ?? e}`, warnings: [] };
  }
  let slots = [];
  try { slots = readSlots(SLOT_MAX, dir); } catch { slots = []; }
  const gaps = computeVisionGaps({ lines: idx.lines, rows, ownerItems: readOwnerPriorityItems(), slots, now });

  let note = '';
  if (!gaps.length) {
    const anyVision = (idx.lines || []).some((l) => l?.isVision);
    note = anyVision
      ? '（年轮 json 里没有带 asks 的线：本轮没有该推的线，先看 A 类上桌）'
      : '（没有可读的年轮 json：本轮没有该推的线，先看 A 类上桌）';
    if (idx.note) note += `（${idx.note}）`;
  } else if (gaps.length > VISION_GAP_TOP) {
    note = `（另有 ${gaps.length - VISION_GAP_TOP} 条线未展开）`;
  }
  return { idx, gaps, note };
}

function renderJson(board, rows, attn) {
  const active = rows.filter((r) => activeCount(r) > 0).sort((a, b) => {
    const d = priority(a) - priority(b);
    return d !== 0 ? d : b.lastAt - a.lastAt;
  });
  return JSON.stringify({
    at: new Date().toISOString(),
    boardRevision: board?.revision ?? null,
    totals: {
      cards: board?.tasks?.length ?? 0,
      run: rows.reduce((a, r) => a + r.run, 0),
      todo: rows.reduce((a, r) => a + r.todo, 0),
      review: rows.reduce((a, r) => a + r.review, 0),
      failed: rows.reduce((a, r) => a + r.failed, 0),
    },
    lines: active.map((r) => ({
      line: r.line, run: r.run, todo: r.todo, review: r.review, failed: r.failed,
      done: r.done, cards: r.cards, lastAt: r.lastAt, lastAtISO: r.lastAt ? new Date(r.lastAt).toISOString() : null,
    })),
    attention: {
      open: attn.open.length,
      total: attn.all.length,
      items: attn.open.map((a) => ({ cardId: a.cardId ?? null, question: a.question ?? '', askedAt: a.askedAt ?? null, options: a.options ?? [] })),
    },
  }, null, 2);
}

// ══════════════════════════════════════════════════════════════════════════
// R1-5 新区：动作流水 · 投话信封 · 三个新动词
// ══════════════════════════════════════════════════════════════════════════

/** 短号：6 位 base36（派活/回执配对用；不是安全用途，collision 概率 ~1/2e9） */
export function shortId(n = 6) {
  let s = '';
  while (s.length < n) s += randomInt(0, 36).toString(36);
  return s.slice(0, n);
}

/** 封闭词表（**不许自造第五个**） */
export const CMD_WORDS = ['ask', 'do', 'report', 'notify'];
export const REPLY_STATES = ['done', 'blocked', 'failed', 'need-decide'];
export const PRIO_WORDS = ['now', 'today', 'when-free'];
/** R1-2d · 「谁拍的」（封闭三值）：router = 它自己拍的小决定；owner = 主人定的/派下来的；
 *  plugin = **机器/插件写的**（2026-11-03 槽位回写一期新增：别让机器行冒充 Router 本人的决定） */
export const DECIDED_BY = ['router', 'owner', 'plugin'];

/**
 * 追加一行动作流水（只增不改、永不重写整份文件）。
 * 🔴 写失败**不静默**：返回 ok:false + 原因，调用方必须打印告警并把 rc 抬起来。
 *    ⚠️ 但**绝不因为流水写失败就撤销已经真投出去的话** —— 如实记才是对的。
 * @returns {{ok:boolean, file:string, error:string|null}}
 */
export function appendOps(rec, file = OPS_FILE) {
  const line = JSON.stringify(rec) + '\n';
  try {
    fs.appendFileSync(file, line, 'utf8');
    return { ok: true, file, error: null };
  } catch (e) {
    return { ok: false, file, error: e && e.message ? e.message : String(e) };
  }
}

/** 流水行的标准形状（8 个必含字段 + decidedBy + 可选附加，顺序固定便于人看） */
export function opsRecord({
  at = new Date().toISOString(), verb, target = '', sid = null, ok = true,
  dryRun = true, decidedBy = 'router', id = null, format = null, extra = null,
  oldText = null, rollId = null,
} = {}) {
  const rec = {
    at, verb, target, sid: sid || null, ok: ok === true, source: 'router-act', dryRun: dryRun !== false,
    decidedBy: DECIDED_BY.includes(decidedBy) ? decidedBy : 'router',
  };
  if (id) rec.id = id;
  if (format) rec.format = format;
  // ⭐ 2026-11-03（槽位回写一期）：`digest --replace` 要能还原"改前长什么样"、还要能按批次追。
  //    · oldText = 被替换掉的那**整行**（≤200 字，超了截；空值不落键）
  //    · rollId  = 调用方给的批次号（`--run-id`），不给就不落
  if (oldText) rec.oldText = String(oldText).slice(0, 200);
  if (rollId) rec.rollId = String(rollId);
  if (extra && typeof extra === 'object') rec.extra = extra;
  return rec;
}

/** 单个 kv 串解析：`a=1; b=2` → {a:'1', b:'2'}（宽容：缺分号、多余空格都不炸） */
function parseKv(s) {
  const out = {};
  const re = /([A-Za-z_]+)=([^;]*)/g;
  let m;
  while ((m = re.exec(String(s ?? '')))) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}

const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? '';

/**
 * 回执**宽容解析**（R1-5 · 硬要求 4）。
 *
 * 🔴 绝不因为对方"没守格式"就丢消息/报错/拒收：
 *   - 有 `@@rep` 且字段齐全 ⇒ `{format:'envelope', id, state, out}`
 *   - 有 `@@rep` 但 state 是野值 ⇒ 照样返回（`state:null` + `rawState` 原文），**不抛错**
 *   - 整段自然语言、没有 `@@rep` ⇒ `{format:'free'}`，`oneLine` 里带他那句话
 * @param {string} text 回话原文
 * @returns {{format:'envelope'|'free', id:string|null, state:string|null, out:string|null, rawState:string|null, oneLine:string}}
 */
export function parseReply(text) {
  const raw = String(text ?? '');
  const m = raw.match(/@@rep\b([^\n]*)/i);
  if (!m) return { format: 'free', id: null, state: null, out: null, rawState: null, oneLine: firstLine(raw) };
  const kv = parseKv(m[1]);
  const st = kv.state ?? null;
  return {
    format: 'envelope',
    id: kv.id ?? null,
    state: REPLY_STATES.includes(st) ? st : null,
    out: kv.out ?? null,
    rawState: st,
    oneLine: firstLine(raw),
  };
}

/**
 * 派活信封（第 1 行人话 · 第 2 行机器可判）。
 * 词表封闭：cmd 四值；非法值由调用方在参数闸里拦下（这里不再兜，避免"静默改成 do"）。
 */
export function buildEnvelope({
  to = '', text = '', cmd = 'do', id = '', reply = '统筹线',
  prio = 'today', due = '-', ref = '-',
} = {}) {
  const human = `【派·${reply}→${to}】${String(text ?? '').trim()}`;
  const head = `@@cmd=${cmd}; id=${id}; reply=${reply}; prio=${prio}; due=${due || '-'}; ref=${ref || '-'}`;
  return `${human}\n${head}`;
}

/** 回执原文示例（help 里给主人看，也是子 Router 抄的形状） */
export function buildReplyExample({ to = '<线名>', id = 'k3f9a1', state = 'done', out = '<卡id 或 报告路径|->' } = {}) {
  return `【回·${to}→统筹线】<一句话结论>\n@@rep id=${id}; state=${state}; out=${out}`;
}

/** `--to` 看起来像不像会话 id（`session-` 前缀 / 纯 uuid）—— 只影响提示文案与线名取值 */
export function looksLikeSid(s) {
  const t = norm(s);
  return /^session-[0-9a-f-]{36}$/i.test(t) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
}

/** 信封里的 `<线名>`：给的是名字就用名字；给的是 id 就用会话标题（剥掉【运行】【已交接】这类状态前缀再截 16） */
export function lineNameOf(to, targetTitle) {
  if (!looksLikeSid(to)) return norm(to);
  const bare = norm(targetTitle).replace(/^(\s*【[^】]{1,12}】\s*)+/, '').trim();
  return clipW(bare || norm(targetTitle) || norm(to), 16);
}

async function sessionList() {
  const r = await hostRpc(WEB, 'session.list', {});
  const v = r?.body?.result?.value ?? r?.body?.value ?? {};
  return Array.isArray(v.items) ? v.items : [];
}

/** 把正文落临时文件再交给 session-say（**避免命令行转义把换行/引号吃掉**——信封是两行制） */
function writeTempBody(body) {
  const p = path.join(os.tmpdir(), `router-say-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

/**
 * 投递出口：**只 spawn session-say.mjs**（本件不实现第二套投递）。
 * @returns {{ok:boolean, rc:number|null, out:string, err:string}}
 */
export function sayViaSessionSay({ sid, body, mode = 'queue', allowSelf = false, apply = true }) {
  const tmp = writeTempBody(body);
  try {
    const args = [SAY_SCRIPT, '--to', sid, '--file', tmp, '--mode', mode];
    if (apply) args.push('--apply');
    if (allowSelf) args.push('--allow-self');
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    return {
      ok: r.status === 0,
      rc: typeof r.status === 'number' ? r.status : null,
      out: String(r.stdout ?? ''),
      err: String(r.stderr ?? '') || (r.error ? String(r.error.message ?? r.error) : ''),
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清不掉不影响结论 */ }
  }
}

// ── say ───────────────────────────────────────────────────────────────────

async function cmdSay(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

  const TO = norm(val('--to', ''));
  const id = norm(val('--id', '')) || shortId();
  const RAW = has('--raw');
  const APPLY = has('--apply');
  const JSONOUT = has('--json');
  const RECEIPT = val('--receipt', null);
  const ALLOW_SELF = has('--allow-self');
  const MODE = norm(val('--mode', 'queue'));
  const CMD = norm(val('--cmd', 'do')).toLowerCase();
  const PRIO = norm(val('--prio', 'today')).toLowerCase();
  const DUE = norm(val('--due', '-')) || '-';
  const REF = norm(val('--ref', '-')) || '-';
  const REPLY = norm(val('--reply', '统筹线')) || '统筹线';
  const DECIDED = norm(val('--decided-by', 'router')).toLowerCase();
  const TEXT = String(val('--text', '') ?? '');

  // ① 用法闸
  if (RECEIPT === null && !TEXT.trim()) {
    process.stderr.write('❌ 缺正文（--text "一句话"）—— 空正文不投：投话是**真打扰别的会话**，不许空投\n');
    return 2;
  }
  if (MODE !== 'queue' && MODE !== 'steer') {
    process.stderr.write(`❌ --mode 只支持 queue|steer，收到 "${MODE}"\n`);
    return 2;
  }
  if (!RAW && !CMD_WORDS.includes(CMD)) {
    process.stderr.write(`❌ --cmd 只支持 ${CMD_WORDS.join('|')}（词表封闭，不许自造第五个）；收到 "${CMD}"\n`);
    return 2;
  }
  if (!RAW && !PRIO_WORDS.includes(PRIO)) {
    process.stderr.write(`❌ --prio 只支持 ${PRIO_WORDS.join('|')}；收到 "${PRIO}"\n`);
    return 2;
  }
  if (!DECIDED_BY.includes(DECIDED)) {
    process.stderr.write(`❌ --decided-by 只支持 ${DECIDED_BY.join('|')}（router = 你自决 / owner = 主人定的）；收到 "${DECIDED}"\n`);
    return 2;
  }

  // ② 记回执模式（--receipt）：只落流水，不投递
  if (RECEIPT !== null) {
    const parsed = parseReply(RECEIPT);
    const rec = opsRecord({
      verb: 'say', target: TO || '(未指定)', sid: null, ok: true, dryRun: true, decidedBy: DECIDED,
      id: parsed.id || id, format: parsed.format,
      extra: { action: 'receipt', state: parsed.state, out: parsed.out, oneLine: clipW(parsed.oneLine, 80) },
    });
    const w = appendOps(rec);
    if (JSONOUT) process.stdout.write(JSON.stringify({ verb: 'say', action: 'receipt', ...parsed, ops: w }, null, 2) + '\n');
    else {
      process.stdout.write(`记回执（format=${parsed.format}${parsed.state ? ` · state=${parsed.state}` : ''}${parsed.id ? ` · id=${parsed.id}` : ''}）\n`);
      process.stdout.write(`  ${clipW(parsed.oneLine, 100)}\n`);
      if (parsed.format === 'free') process.stdout.write('  （对方没守 @@rep 格式 —— 照收，流水标 format:free，不丢不报错）\n');
      process.stdout.write(`  流水：${w.ok ? w.file : `✗ 写失败 ${w.error}`}\n`);
    }
    return w.ok ? 0 : 1;
  }

  // ③ 解析目标：会话 id 直投；名字必须命中**恰好 1 个**，否则列候选、不猜
  if (!TO) {
    process.stderr.write('❌ 缺目标（--to <主线名|会话id>）\n');
    return 2;
  }
  let items;
  try {
    items = await sessionList();
  } catch (e) {
    process.stderr.write(`✗ 取会话表失败：${e?.message ?? e}\n`);
    appendOps(opsRecord({ verb: 'say', target: TO, sid: null, ok: false, dryRun: !APPLY, decidedBy: DECIDED, id, format: RAW ? 'raw' : 'envelope', extra: { error: 'session.list 失败' } }));
    return 1;
  }
  const { hit, cands } = resolveTarget(items, TO);
  if (!hit) {
    const ambiguous = cands.length > 0;
    process.stderr.write(ambiguous
      ? `✗ 目标不唯一（${cands.length} 个候选）—— **绝不猜**。用完整 id 或更长的名字：\n`
      : `✗ 找不到目标："${TO}"（看候选：node tools\\dsh-butler\\session-say.mjs --list）\n`);
    for (const it of cands.slice(0, 10)) {
      process.stderr.write(`  ${it.running ? '▶' : ' '} ${sidOf(it)}  ${clipW(titleOf(it), 60) || '（无标题）'}\n`);
    }
    const w = appendOps(opsRecord({
      verb: 'say', target: TO, sid: null, ok: false, dryRun: !APPLY, decidedBy: DECIDED, id,
      format: RAW ? 'raw' : 'envelope', extra: { error: ambiguous ? 'ambiguous-target' : 'not-found', candidates: cands.length },
    }));
    if (!w.ok) process.stderr.write(`⚠️ 动作流水写失败（${w.error}）—— 这次拦下没投，账没记上\n`);
    return 3;
  }

  const sid = sidOf(hit);
  const lineName = lineNameOf(TO, titleOf(hit));
  const body = RAW ? TEXT : buildEnvelope({ to: lineName, text: TEXT, cmd: CMD, id, reply: REPLY, prio: PRIO, due: DUE, ref: REF });
  const bodyLines = body.split(/\r?\n/).length;

  if (!JSONOUT) {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] Router 投话 · ${APPLY ? '真投' : '只预览，不投'}\n`);
    process.stdout.write(`  目标：${sid}${hit.running ? '（▶在跑）' : '（空闲）'}  ${clipW(titleOf(hit), 60) || '（无标题）'}\n`);
    process.stdout.write(`  线名：${lineName}  短号：${id}  模式：${MODE}\n`);
    process.stdout.write(`  信封：${RAW ? '--raw（原样投，不套）' : `两行制（人话 + @@cmd）· cmd=${CMD} · prio=${PRIO} · due=${DUE} · ref=${REF}`}\n`);
    process.stdout.write(`  ── 正文（${Buffer.byteLength(body, 'utf8')} B / ${bodyLines} 行）──\n${body}\n  ──\n`);
  }

  let ok = true;
  let rc = 0;
  let detail = '';
  if (APPLY) {
    const r = sayViaSessionSay({ sid, body, mode: MODE, allowSelf: ALLOW_SELF, apply: true });
    ok = r.ok;
    rc = r.rc ?? (ok ? 0 : 1);
    detail = (r.err || r.out).trim();
    if (!JSONOUT) {
      process.stdout.write(r.out.endsWith('\n') ? r.out : r.out + '\n');
      if (!r.ok) process.stderr.write(`✗ 投递失败（rc=${rc}）：${clipW(detail, 300)}\n`);
    }
  } else if (!JSONOUT) {
    process.stdout.write('  （未投递；加 --apply 真投）\n');
  }

  const w = appendOps(opsRecord({
    verb: 'say', target: lineName, sid, ok, dryRun: !APPLY, decidedBy: DECIDED, id,
    format: RAW ? 'raw' : 'envelope',
    extra: { to: TO, cmd: RAW ? null : CMD, prio: RAW ? null : PRIO, due: RAW ? null : DUE, ref: RAW ? null : REF, rc: APPLY ? rc : null },
  }));

  if (JSONOUT) {
    process.stdout.write(JSON.stringify({
      verb: 'say', ok, dryRun: !APPLY, rc: APPLY ? rc : 0, sid, target: lineName, id, decidedBy: DECIDED,
      format: RAW ? 'raw' : 'envelope', body, ops: w, detail: detail ? clipW(detail, 400) : '',
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  }
  if (!w.ok) {
    process.stderr.write(`⚠️ 动作流水写失败：${w.error}\n   （${APPLY && ok ? '话已经投出去了，账没记上 —— 不撤销，如实报' : '本次没有真投'}）\n`);
    return 1;
  }
  return ok ? 0 : 1;
}

// ── wake ──────────────────────────────────────────────────────────────────

async function cmdWake(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

  const THREAD = norm(val('--thread', ''));
  const TEXT = String(val('--text', '') ?? '');
  const APPLY = has('--apply');
  const JSONOUT = has('--json');
  const NO_WAKE = has('--no-wake');
  const DECIDED = norm(val('--decided-by', 'router')).toLowerCase();
  const id = norm(val('--id', '')) || shortId();

  const NO_THREAD_HINT = '没有 thread 的活请改用 `say` 投给该主线会话，由它自己去跑卡'
    + '（`router-act.mjs say --to <主线名> --text "…" --apply`）。';

  if (!THREAD) {
    process.stderr.write(`❌ 缺 --thread <threadId>（先看有哪些本：node tools\\dsh-butler\\steward-threads.mjs --thread-list）\n`
      + `   ${NO_THREAD_HINT}\n`
      + '   🔴 本动词**只**唤「已经在某个 thread 里的卡」：不做「任意卡直接唤醒」（那会绕开 C12-C 的三道闸）。\n');
    return 2;
  }
  if (!TEXT.trim()) {
    process.stderr.write('❌ 缺正文（--text "一句话"）—— 空正文不唤：唤醒是**真去 POST 起卡**，不许空发\n');
    return 2;
  }
  if (!DECIDED_BY.includes(DECIDED)) {
    process.stderr.write(`❌ --decided-by 只支持 ${DECIDED_BY.join('|')}（router = 你自决 / owner = 主人定的）；收到 "${DECIDED}"\n`);
    return 2;
  }

  const { runCli } = await import('../src/dsh-butler/steward-threads.mjs');
  const args = ['--thread-post', '--thread', THREAD, '--text', TEXT, '--json'];
  if (APPLY) args.push('--apply');
  if (NO_WAKE) args.push('--no-wake');

  let payload = null;
  let code = 1;
  let stdout = '';
  try {
    const r = await runCli(args, {});
    code = r.code;
    stdout = r.stdout;
    try { payload = JSON.parse(stdout); } catch { payload = null; }
  } catch (e) {
    process.stderr.write(`✗ 唤醒调用崩了：${e?.message ?? e}\n`);
    appendOps(opsRecord({ verb: 'wake', target: THREAD, sid: null, ok: false, dryRun: !APPLY, decidedBy: DECIDED, id, extra: { error: 'threw' } }));
    return 1;
  }

  const wake = payload?.wake ?? {};
  const cands = Array.isArray(wake.candidates) ? wake.candidates : [];
  const woke = cands.filter((c) => c.ok === true);
  const firstSid = (woke[0]?.sessionId ?? null) || null;
  const ok = (payload?.ok === true) || (code === 0 && cands.length === 0);

  if (!JSONOUT) {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] Router 唤醒 · thread ${THREAD}（${APPLY ? '真跑' : '只干跑，不 POST'}）\n`);
    if (payload?.thread) {
      process.stdout.write(`  本子：《${clipW(payload.thread.title, 50)}》 主线 ${payload.thread.line || '(未写)'} 订卡 ${payload.thread.cards} 张\n`);
    }
    process.stdout.write(`  扇出：${Array.isArray(payload?.deliver) ? payload.deliver.length : 0} 条（running 的会话）\n`);
    process.stdout.write(`  唤醒候选：${cands.length} 张${wake.enabled === false ? '（--no-wake：唤醒段已关）' : ''}\n`);
    for (const c of cands.slice(0, 8)) {
      const mark = APPLY ? (c.ok === true ? '✓' : '✗') : '·';
      process.stdout.write(`    ${mark} ${c.cardId ?? '?'}  ${clipW(c.cardTitle ?? c.title ?? '', 40)}${c.gate?.blocked ? `  [闸：${c.gate.blocked}]` : ''}\n`);
    }
    process.stdout.write(`  短号：${id}\n`);
    if (code === 4 || payload?.code === 'no-thread') {
      process.stderr.write(`✗ 没有这本 thread：${THREAD}。${NO_THREAD_HINT}\n`);
    } else if (code !== 0) {
      process.stderr.write(`${stdout.split('\n').slice(0, 6).join('\n')}\n`);
    }
  }

  const w = appendOps(opsRecord({
    verb: 'wake', target: THREAD, sid: firstSid, ok, dryRun: !APPLY, decidedBy: DECIDED, id,
    extra: { candidates: cands.length, woken: APPLY ? woke.length : null, rc: code },
  }));

  if (JSONOUT) {
    process.stdout.write(JSON.stringify({ verb: 'wake', ok, dryRun: !APPLY, rc: code, thread: THREAD, id, decidedBy: DECIDED, candidates: cands.length, woken: APPLY ? woke.length : null, ops: w }, null, 2) + '\n');
  } else {
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  }
  if (!w.ok) {
    process.stderr.write(`⚠️ 动作流水写失败：${w.error}（唤醒动作本身已${APPLY ? '真跑' : '干跑'}，不撤销）\n`);
    return 1;
  }
  return ok ? 0 : 1;
}

// ── card-show ─────────────────────────────────────────────────────────────

/**
 * 从 description 里摘「待拍板」段（**只要这一段，别的都不要**）。
 *
 * 🔴 判据是「**这一行以『待拍板』开头**」（允许 Markdown 标记 `#` / `-` / `>` 与 `【】` 包裹），
 *    不是「这一行里出现『待拍板』三个字」—— 后者命中率过高：卡面验收表里随便一句
 *    「只给标题/状态/待拍板」就会被当成段首，把验收表整段搬出来（R1-5 实测踩到）。
 * 🔴 有多段时取**最后一段**：卡 description 是**追加式**留痕（`card-note.mjs` 只追加不改原文），
 *    最早那段往往是建卡时的模板（「待拍板：无」），最新那段才是当下的拍板项（R1-5 实测踩到）。
 * 命中后：标题行跳过标题、从其后的正文收集；遇下一个标题或空行即停；最多 maxLines 行。
 */
export function pendingBlock(desc, maxLines = 10) {
  const all = String(desc ?? '').split(/\r?\n/);
  const HEAD = /^\s*(?:#{1,6}\s*|[-*+]\s+|>\s*)?[【\[]?\s*待拍板\s*[】\]]?\s*[:：]?\s*(.*)$/;
  let start = -1;
  for (let i = 0; i < all.length; i++) {
    if (HEAD.test(all[i])) start = i;       // 不 break：取最后一段
  }
  if (start < 0) return null;
  const isHeading = (s) => /^\s*(#{1,6}\s|---+\s*$)/.test(s);
  const out = [];
  // 命中行后面还跟着内容（`待拍板：xxx` / `- 待拍板 xxx`）⇒ 该行本身就是条目
  const inline = (all[start].match(HEAD)?.[1] ?? '').trim();
  if (inline && !isHeading(all[start])) out.push(clipW(inline, 110));
  const from = isHeading(all[start]) || inline ? start + 1 : start;
  for (let i = from; i < all.length && out.length < maxLines; i++) {
    const ln = all[i];
    if (!ln.trim()) continue;                                 // 段内空行只是排版，不算段结束
    if (out.length && isHeading(ln)) break;                   // 遇下一个标题才停
    out.push(clipW(ln.replace(/\s+/g, ' ').trim(), 110));
  }
  return out.length ? out : null;
}

/** 只读：把一张卡压成 ≤maxLines 行（**不含 prompt / description 全文**） */
export function renderCard(rest, { id = '', maxLines = 20 } = {}) {
  const t = rest ?? {};
  const execs = Array.isArray(t.executions) ? t.executions : [];
  const last = execs.length ? execs[execs.length - 1] : null;
  const head = `卡 ${String(t.id ?? id).slice(0, 8)}  ${clipW(String(t.title ?? '(无标题)'), 60)}`;
  const lines = [head];
  lines.push(`  status ${String(t.status ?? '?')} · line ${String(t.line ?? '—')} · seq ${String(t.seq ?? '—')} · 执行 ${execs.length} 次 · kind ${String(t.kind ?? '—')}`);
  if (last) {
    const res = last.result == null ? '—' : (typeof last.result === 'string' ? last.result : JSON.stringify(last.result)).slice(0, 24);
    const at = last.endedAt ? stamp(Number(last.endedAt)) : (last.startedAt ? `${stamp(Number(last.startedAt))} 起` : '—');
    lines.push(`  最近执行 #${String(last.id ?? last.executionId ?? '?').slice(0, 8)} ${res} · ${at}${last.error ? ` · err ${clipW(String(last.error), 40)}` : ''}`);
  } else {
    lines.push('  最近执行 —（还没跑过）');
  }
  const blk = pendingBlock(t.description, Math.min(10, Math.max(1, maxLines - lines.length - 2)));
  if (blk) {
    lines.push('  ── 待拍板 ──');
    lines.push(...blk.map((x) => `   · ${x}`));
  }
  lines.push(`  （全文别搬：要看自己跑 node tools\\board-ops\\card-state.mjs ${String(t.id ?? id)}）`);

  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines - 1);
    keep.push(`…已截断（原始 ${lines.length} 行，--max-lines 调，上限 40）`);
    return keep;
  }
  return lines;
}

async function cmdCardShow(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const CARD = norm(val('--card', ''));
  const JSONOUT = has('--json');
  let maxLines = 20;
  const mi = argv.indexOf('--max-lines');
  if (mi >= 0) {
    const n = Number(argv[mi + 1]);
    if (Number.isFinite(n) && n >= 3) maxLines = Math.min(40, Math.floor(n));   // 🔴 硬上限 40
  }

  if (!/^[0-9a-f-]{36}$/i.test(CARD)) {
    process.stderr.write('❌ 缺 --card <cardId>（36 位 uuid）\n');
    return 2;
  }

  const board = await fetchBoard();
  const t = (board.tasks ?? []).find((x) => String(x.id) === CARD);
  if (!t) {
    process.stderr.write(`✗ 看板上没有这张卡：${CARD}\n`);
    return 1;
  }
  if (JSONOUT) {
    process.stdout.write(JSON.stringify({
      id: t.id, title: t.title ?? '', status: t.status ?? null, line: t.line ?? null, seq: t.seq ?? null,
      kind: t.kind ?? null, executions: (t.executions ?? []).length,
      last: (t.executions ?? []).length ? t.executions[t.executions.length - 1] : null,
      pending: pendingBlock(t.description, 10),
    }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(renderCard(t, { id: CARD, maxLines }).join('\n') + '\n');
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════
// R1-7 新区：滚动记忆（一行槽位 · 结论档 · 重置）
//   🔴 这一区**从不碰会话**：不调 session.compact、不删会话、不归档、不发任何会话 RPC。
//      「清空上下文」2026-11-03 起**不用人按**了：到阈值由宿主 `compaction-basic` 自动原地压
//      （阈值真源 = `profiles\web\cordis.patch.yml` 的 `compaction-basic.config.thresholdRatio`；
//       2026-11-05 已由 0.15 调到 0.20 ⇒ **此处及以下文案一律不写死百分比**，避免再出现两套说法）。
//      本区仍然什么都不做 —— 压是宿主干的，这里只读档/写档。
// ══════════════════════════════════════════════════════════════════════════

const p2 = (x) => String(x).padStart(2, '0');

/** 本地日期 YYYY-MM-DD（**本地时区**，不是 UTC —— 收口日期要是人看到的那一天） */
function ymd(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 年月 YYYYMM（结论档按月份开档） */
function ymOf(ms = Date.now()) {
  return ymd(ms).slice(0, 7).replace('-', '');
}

/** 结论档路径：`<年轮>\router-<YYYYMM>.md`（`dir` 只为夹具/演练换目录；生产不传 = DIGEST_DIR） */
function digestDocPath(ym, dir = DIGEST_DIR) {
  return path.join(dir, `router-${ym}.md`);
}

/** 档头（只在建新档时写一次）：为什么要这份档、入口在哪、幂等键是什么 */
function digestHeader(ym) {
  return [
    `# Router 结论档 · ${ym}`,
    '',
    '> **这份档只放结论**：哪条线 + 一句结论 + 指向卡/报告的链接。**过程一律不进**（过程留在子线自己那边）。',
    '> 写入口（只有这一个）：`node <pkg>/jobs/router-act.mjs digest --line <线名> --text "<一句结论>" [--ref <卡id/报告路径>] --apply`',
    '> 幂等键 = **线名 + 日期** ⇒ 同一天同一条线重复收口不会重复追加。',
    '> 槽位口径：主 Router 上下文里对每条线只留 1 行（**每行 ≤60 汉字 / 显示宽 ≤120**），上限 16 行；',
    '> 这 16 行**每轮由插件自动注入**（`dsh-feiyu-mood` 的「槽位注入」现读本档 ⇒ 进系统提示、不进历史）—— 她自己不必背。',
    '> 那 16 行只是「上次收口的结论」、**不是活数据** —— 车况每次现跑 `router-act.mjs brief` 现取。',
    '> `reset` 会把当前槽位 + 待主人拍的事写成一段「接续头」放进本档末尾；**同一天只留一段**，重跑就整段替换。',
    '> 每日收口（`digest --auto --apply`）写完之后会**顺手把最新那段接续头的「一行槽位」刷成当前槽位**（只换那一段、段外不动 · 2026-11-05 起）；手工 `digest --line` / `--replace` 同样刷。',
    '> **本档按月开档、月内不轮转**（`router-<YYYYMM>.md`）；读的时候会读全部月份档 ⇒ 跨月那几天不会掉线。',
    '> **清空上下文不用人管**：到阈值由宿主 `compaction-basic` 自动原地压（阈值真源 = `cordis.patch.yml` 的 `thresholdRatio`，2026-11-05 现为 0.20；压完按 `retainRatio` 留尾巴）；本件从不调 session.compact、不删会话、不归档。',
    '',
    '---',
    '',
    '',
  ].join('\n');
}

/**
 * 一行结论的格式：`- 2026-11-02｜线名｜一句结论｜ask=A2｜ref：docs/xx.md`
 *
 * 🔴 YB2-R1（2026-11-03）：`ask` 是**可选**的 6 字符愿景指针（指向该线 `愿景-<线>.json` 里某条 ask 的 id）。
 *    `ask` 为空 ⇒ **一个字符都不加** ⇒ 与改前逐字相同（「默认等价」就靠这一句，夹具钉着）。
 *    ⚠️ 正文里本来就有 `ask=` 字样时这里不管：渲染只管拼，防误判在 `parseDigestLine` 那边。
 */
export function digestRow({ date, line, text, ref, ask }) {
  const raw = ask === null || ask === undefined ? '' : String(ask).trim();
  const A = raw === '-' ? '' : raw;          // `-` 也算「没有」⇒ 别让 `｜ask=-｜` 混进结论档
  return `- ${date}｜${line}｜${text}${A ? `｜ask=${A}` : ''}${ref ? `｜ref：${ref}` : ''}`;
}

const ASK_SEG = '｜ask=';

/**
 * 从一行正文里把「`｜ask=<≤6 字>`」这一**整段**摘出来 —— **从右往左**找，绝不全局贪婪。
 *
 * 判据（按卡的硬要求）：
 *   · 只认**紧跟正文尾**的那一段（摘掉 ref 后，`ask=` 后面必须再没有 `｜`，且长度 1~6）；
 *   · 正文里出现 `ask=` 字样（不带前导全角竖线 / 后面接长文）⇒ **不当指针**，一律留在正文里；
 *   · `ask=-` 也算「没有」（接续头里旧行渲染成 `ask=-`，读回来要还原成 null）。
 */
function splitAskSegment(body) {
  const s = String(body ?? '');
  let idx = s.lastIndexOf(ASK_SEG);
  while (idx >= 0) {
    const tail = s.slice(idx + ASK_SEG.length);
    if (/^[^\n｜]{1,6}$/.test(tail)) {
      const ask = tail.trim();
      return { text: s.slice(0, idx), ask: ask === '-' ? null : ask };
    }
    idx = idx > 0 ? s.lastIndexOf(ASK_SEG, idx - 1) : -1;
  }
  return { text: s, ask: null };
}

/** 解析一行结论（宽容：ask / ref 段都可省；结论里自带全角竖线也不会拆坏）—— 纯函数，夹具可测 */
export function parseDigestLine(raw) {
  const s = String(raw ?? '');
  const m = s.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*｜/);
  if (!m) return null;
  const parts = s.slice(m[0].length).split('｜');
  const line = norm(parts.shift() ?? '');
  if (!line) return null;
  const rest = parts.join('｜');
  const rm = rest.match(/^([\s\S]*?)\s*｜\s*ref：\s*([\s\S]*)$/);
  const body = rm ? rm[1] : rest;
  const { text, ask } = splitAskSegment(body);      // YB2-R1：先摘 ask，再当正文
  return { date: m[1], line, text: norm(text), ref: rm ? norm(rm[2]) : '', ask };
}

/** 读一个结论档里的全部结论行（档不存在/读不动 ⇒ 空数组，绝不抛） */
function readDocRows(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of txt.replace(/\r\n/g, '\n').split('\n')) {
    const r = parseDigestLine(l);
    if (r) out.push(r);
  }
  return out;
}

// ── 就地改写（2026-11-03 · 槽位回写一期）────────────────────────────────────
//   🔴 为什么必须就地替换而不是"再追加一行更新的"：`readSlots` 同日同线**先出现者胜**
//      （`:996`），追加的那行永远读不回来（审核档 §4-11）。
//   这三件都**不碰行尾/BOM**：按原文 eol 切行、写回再按同一 eol 拼 ⇒ 逐字还原。

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 读整份档的**原始字节**（字节级 sha 用；`toString` 后再写回不会动 BOM） */
function readDocBuf(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

/** 按原文行尾切行（CRLF / LF 各自保住；不统一成 LF） */
function splitLinesKeepEol(txt) {
  const eol = String(txt).includes('\r\n') ? '\r\n' : '\n';
  return { eol, lines: String(txt).split(eol) };
}

/** 在给定行里找「日期 + 线名」全等的结论行（返回 0-based 行号，可能 0/1/多行） */
function findRowIndexes(lines, date, line) {
  const out = [];
  lines.forEach((l, i) => {
    const r = parseDigestLine(l);
    if (r && r.date === date && r.line === line) out.push(i);
  });
  return out;
}

/** 原子写：**同目录** `.tmp` → `rename`（崩在中间也不会留半份） */
function writeFileAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 🔴 **结论档唯一写盘路径**（`digest --line` 与 `digest --auto` 共用这一支，2026-11-05 抽出）。
 *   档不在 ⇒ 先写档头；再追加一行。行为与抽出前**逐字等价**（同样是 existsSync / mkdirSync / appendFileSync）。
 * @returns {{wrote:boolean, err:string|null}}
 */
function appendRowToDoc({ doc, ym, row }) {
  let wrote = false;
  let err = null;
  try {
    if (!fs.existsSync(doc)) {
      fs.mkdirSync(path.dirname(doc), { recursive: true });
      fs.writeFileSync(doc, digestHeader(ym), 'utf8');
    }
    fs.appendFileSync(doc, row + '\n', 'utf8');
    wrote = true;
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }
  return { wrote, err };
}

/**
 * 当前「一行槽位」= 结论档里**每条线最新那一行**，按日期降序取前 max 条。
 * 读全部 `router-*.md`（跨月也能拼出槽位）；同线多条取日期最大者（同日取后出现的）。
 *
 * ⭐ 2026-11-05（A-3 打回后补 · 1.6.2）：第三参 `prefer` = 当前**有活**的线名集合（看板现读）。
 *   · 给了它 ⇒ **有活的线先占名额**（组内仍按日期降序、稳定排序），无活的历史行排在后面补位；
 *     名额只有 max 个时，无活的历史行要让位 —— A-3 要的是「在跑的主线都在槽位里」，
 *     不能让一条静线（当天更早收口过）把活线挤出去。
 *   · 不给（缺省 null）⇒ **行为与加这个参数之前逐字相同**（纯日期降序），`reset` 的既有输出靠这一条钉住。
 *   · 拿不到看板（调用方传 null）⇒ 同样退回纯日期口径，绝不阻断收口。
 * @param {number} max 槽位上限
 * @param {string} dir 结论档目录（夹具/演练钩子）
 * @param {Set<string>|string[]|null} prefer 有活的线名集合
 */
export function readSlots(max = SLOT_MAX, dir = DIGEST_DIR, prefer = null) {
  const files = (() => {
    try {
      return fs.readdirSync(dir).filter((f) => /^router-\d{6}\.md$/.test(f)).sort().reverse();
    } catch { return []; }
  })();
  const latest = new Map();
  for (const f of files) {
    for (const r of readDocRows(path.join(dir, f))) {
      const cur = latest.get(r.line);
      if (!cur || r.date > cur.date) latest.set(r.line, r);
    }
  }
  const rows = [...latest.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  // ⭐ 有活的线优先（2026-11-05 · A-3 打回后）：先按「是不是活线」分组，组内保持上面的日期降序
  //    （`filter` 保序 ⇒ 组内相对次序不重排）。活线一条都没有 ⇒ 不改变原口径。
  const ps = prefer ? (prefer instanceof Set ? prefer : new Set(prefer)) : null;
  if (ps && ps.size) {
    const live = rows.filter((r) => ps.has(r.line));
    if (live.length) return [...live, ...rows.filter((r) => !ps.has(r.line))].slice(0, Math.max(1, max));
  }
  return rows.slice(0, Math.max(1, max));
}

/**
 * 现读看板拿「有活」的线名集合（给 `readSlots` 的 `prefer` 用）。
 * 🔴 拿不到就返回 `null`（调用方退回纯日期口径）—— 收口绝不能因为看板取数失败而停。
 * ⚠️ 契约：请求带 `x-dsh-board-scope: live`（见 BOARD_HEADERS）⇒ 归档卡不返回。
 *    不带这个 header 会读到 1544 张（含 794 张 `archivedAt` 已在的旧卡），把「已关账归档的
 *    failed 卡」当成有活线 —— 2026-11-05 01:28 那次打回（判「本工具人格统一」被挤掉）就是这么来的：
 *    那张卡 ca11bb31 的 `archivedAt` = 2026-11-04T02:00:46Z，早在 11-04 10:0x 就关账归档了。
 */
async function activeLineSetOrNull() {
  try {
    const board = await fetchBoard();
    const rows = aggregate(board.tasks ?? [], readThreadLineMap(), readJson(THREADS_FILE)?.threads ?? []);
    return new Set(rows.filter((r) => activeCount(r) > 0).map((r) => r.line));
  } catch {
    return null;
  }
}

/**
 * 「接续头」：下次开机读它就够（槽位 + 待拍板 + 怎么继续）。
 * 这一段是**给人贴**的，所以用 markdown；路径一律正斜杠（反斜杠在 markdown 里会被转义吃掉）。
 */
/**
 * 「一行槽位」段的渲染 —— **`reset` 与每日收口刷新共用这一支**（2026-11-05 · 年轮判据 A-3 补缺）。
 *   共用 ⇒ 两处产物**逐字同构**：接续头里那一段永远就是 `reset` 会写的那一段，不是第二套格式。
 *   返回值**含段尾那一个空行**（与 `renderResumeHead` 原来的拼法逐字相同 ⇒ 老输出零变化）。
 */
function renderSlotBlock(slots = []) {
  const L = [];
  L.push(`#### 一行槽位（每条线 1 行 · 上限 ${SLOT_MAX} · 每行 ≤${SLOT_CHARS / 2} 汉字 / 显示宽 ≤${SLOT_CHARS} · 只是"上次收口的结论"，不是活数据）`);
  // ⚠️ 槽位行**故意用「·」而不是「-」开头**：`- 日期｜线名｜…` 是 digest 结论行的形状，
  //    接续头若照抄那种形状，下次 readSlots 会把接续头里的副本也当结论读回来（自身污染）。
  if (!slots.length) L.push('· （结论档里还没有任何收口；先跑 digest 记一条）');
  for (const r of slots) {
    const over = dispWidth(r.text) > SLOT_CHARS ? ' ⚠️超长' : '';
    // YB2-R1：槽位行加 `ask=` 指针（报告 §3.2 口径）。旧行没有 ask ⇒ 如实写 `ask=-`，**不回填、不猜**。
    // ⚠️ 行首仍是「·」：改成「-」会被 readSlots 当结论行读回来（自身污染）。
    L.push(`· ${r.line}｜${r.text}｜ask=${r.ask || '-'}｜${r.date}${r.ref ? `｜ref：${r.ref}` : ''}${over}`);
  }
  if (slots.length >= SLOT_MAX) L.push(`· （槽位已满 ${SLOT_MAX} 行：要加新线，先收口最旧那条）`);
  L.push('');
  return L;
}

export function renderResumeHead({ slots = [], attnOpen = [], at = Date.now(), doc = '' } = {}) {
  const L = [];
  L.push(`### 接续头 · ${stamp(at)}（上次收口时间）`);
  L.push('');
  L.push(...renderSlotBlock(slots));
  L.push('#### 待主人拍的事（现读 `~/.dsh/steward-state.json` 的 attentions，只列未答的）');
  if (!attnOpen.length) L.push('1. （没有未答的拍板请求）');
  attnOpen.slice(0, 20).forEach((a, i) => {
    const opts = Array.isArray(a?.options) && a.options.length ? ` → 选 ${a.options.join('/')}` : '';
    L.push(`${i + 1}. [卡 ${String(a?.cardId ?? '?').slice(0, 8)}] ${norm(a?.question).replace(/\s+/g, ' ')}${opts}`);
  });
  if (attnOpen.length > 20) L.push(`（还有 ${attnOpen.length - 20} 件，跑 status 看全）`);
  L.push('');
  L.push('#### 怎么继续（三句）');
  L.push('- 车况**现跑**：`node <pkg>/jobs/router-act.mjs brief`（别拿上面槽位当现状）');
  L.push(`- 结论**现读**：${doc ? doc.replace(/\\/g, '/') : 'docs/年轮/router-<YYYYMM>.md'}`);
  L.push('- 清空上下文**不用人管**：到阈值由宿主 `compaction-basic` 自动原地压（阈值见 `cordis.patch.yml` 的 `thresholdRatio`，2026-11-05 现为 0.20）；本件仍不删会话、不归档。');
  return L.join('\n');
}

/**
 * 把结论档里**最新那段接续头**的「#### 一行槽位」段就地重渲染成「当前槽位」（2026-11-05 · 年轮 A-3 补缺）。
 *
 * 为什么要有它：`reset` 只在收口那一刻写接续头，之后 `digest` 只往结论区追加 ⇒ 档里的槽位段会一直停在
 * 上一次 `reset` 那天（2026-11-05 实测：档里槽位还是 11-02 的 4 条老数据，Router 念出来也是那 4 条）。
 * 本函数让**每次收口写完之后**顺手把那段刷成最新的，A-3「每条在跑的主线都有一行结论在槽位里」才真成立。
 *
 * 🔴 只换那一段 —— 段外**一个字节都不动**：
 *   · 结论区是 append-only（历史行只许追加，不许重写）；
 *   · 接续头的时间戳 / 待拍板清单 / 「怎么继续」归 `reset`（谁写整段谁负责），这里不冒充。
 *   · 更早的接续头段是历史 ⇒ 只刷新**最后一段**，前面几段原样留着。
 * 幂等：渲染结果与档里逐字相同 ⇒ **不写盘**（同一天重跑，前后 sha 相同）。
 *
 * @returns {{ok:boolean, reason:string|null, changed:boolean, wrote:boolean, err:string|null,
 *            slotSections:number, atLine:number, beforeLines:number, afterLines:number,
 *            shaBefore:string, shaAfter:string}}
 */
export function refreshResumeHeadSlots({ doc, slots = [], apply = true } = {}) {
  const r = {
    ok: true, reason: null, changed: false, wrote: false, err: null,
    slotSections: 0, atLine: 0, beforeLines: 0, afterLines: 0, shaBefore: '', shaAfter: '',
  };
  const buf = readDocBuf(doc);
  if (!buf) { r.ok = false; r.reason = 'no-doc'; return r; }
  const { eol, lines } = splitLinesKeepEol(buf.toString('utf8'));
  const starts = [];
  lines.forEach((l, i) => { if (/^####\s+一行槽位/.test(l)) starts.push(i); });
  r.slotSections = starts.length;
  if (!starts.length) { r.ok = false; r.reason = 'no-slot-section'; return r; }
  const i = starts[starts.length - 1];
  let j = lines.length;
  for (let k = i + 1; k < lines.length; k++) { if (/^#{3,4}\s+/.test(lines[k])) { j = k; break; } }
  const oldBlock = lines.slice(i, j);
  const newBlock = renderSlotBlock(slots);
  r.atLine = i + 1;
  r.beforeLines = oldBlock.filter((l) => l.startsWith('· ')).length;
  r.afterLines = newBlock.filter((l) => l.startsWith('· ')).length;
  r.shaBefore = sha256(Buffer.from(oldBlock.join('\n'), 'utf8'));
  r.shaAfter = sha256(Buffer.from(newBlock.join('\n'), 'utf8'));
  r.changed = oldBlock.join('\n') !== newBlock.join('\n');
  if (!r.changed) { r.reason = 'unchanged'; return r; }
  if (!apply) { r.reason = 'dry-run'; return r; }
  try {
    writeFileAtomic(doc, [...lines.slice(0, i), ...newBlock, ...lines.slice(j)].join(eol));
    r.wrote = true;
  } catch (e) {
    r.ok = false;
    r.err = e && e.message ? e.message : String(e);
  }
  return r;
}

// ── digest ────────────────────────────────────────────────────────────────

/**
 * `digest --replace` 的实现（2026-11-03 · 槽位回写一期）。**不带 --replace 时压根不走这里**。
 *
 * 规则（方案 v2 §3.3）：
 *   · 定位 = 同日同线那**一行**；命中数必须 ==1（0 或 >1 ⇒ rc=3，**一个字节都不写**）
 *   · 改法 = 用 `digestRow()` **整行重渲染**（禁正则改子串 —— 子串替换会把行尾/竖线改坏）
 *   · 写盘 = 读全文 → 换掉该行 → 同目录 `.tmp` → `rename`（原子；崩在中间不留半份）
 *   · 并发 = 读时记 sha256、写前重算；不一致 ⇒ rc=3 放弃（宁可不改，也不覆盖别人的改动）
 */
async function replaceDigestRow({ APPLY, JSONOUT, DECIDED, RUN_ID, DATE, LINE, TEXT, ref, ask, askGiven, row, doc, dir = DIGEST_DIR }) {
  const bufBefore = readDocBuf(doc);
  if (!bufBefore) {
    process.stderr.write(`❌ --replace 要改的档不存在：${doc}\n`);
    appendOps(opsRecord({
      verb: 'digest', target: LINE, sid: null, ok: false, dryRun: !APPLY, decidedBy: DECIDED, rollId: RUN_ID,
      extra: { date: DATE, doc, replace: true, wrote: false, skipped: 'no-doc', error: null },
    }));
    return 3;
  }

  const { eol, lines } = splitLinesKeepEol(bufBefore.toString('utf8'));
  const hits = findRowIndexes(lines, DATE, LINE);

  // 定位闸：必须恰好一行（0 行 = 没这条；多行 = 老 append 时代留下的脏数据，都不许猜）
  if (hits.length !== 1) {
    process.stderr.write(hits.length === 0
      ? `❌ --replace 没找到「${DATE}｜${LINE}」这一行（命中 0 行，什么都没改）\n`
        + '   ⇒ 先用不带 --replace 的 digest 追加一条；或核对 --date / --line（线名要一字不差）\n'
      : `❌ --replace 命中 ${hits.length} 行「${DATE}｜${LINE}」（必须恰好 1 行，什么都没改）\n`
        + '   ⇒ 档里同一天同一条线有多行（老 append 时代留下的），先人工清到一行再来\n');
    appendOps(opsRecord({
      verb: 'digest', target: LINE, sid: null, ok: false, dryRun: !APPLY, decidedBy: DECIDED, rollId: RUN_ID,
      extra: {
        date: DATE, doc, ref: ref || null, chars: TEXT.length, replace: true, wrote: false,
        ask: ask || null, skipped: hits.length ? 'replace-ambiguous' : 'replace-miss', hits: hits.length, error: null,
      },
    }));
    return 3;
  }

  const idx = hits[0];
  const oldRow = lines[idx];
  const 旧 = parseDigestLine(oldRow) || { text: '', ref: '', ask: null };
  // 🔴 YB2-R1「改 A 拽断 B」防护：`--replace` 但**没给 `--ask`** ⇒ 继承旧行那一格，不许静默丢；
  //    要清空就显式 `--ask -`（这时 ASK 已是 null、askGiven 为 true）。
  const effAsk = askGiven ? (ask || null) : (旧.ask ?? null);
  const effRow = digestRow({ date: DATE, line: LINE, text: TEXT, ref, ask: effAsk });
  if (effRow !== row) row = effRow;      // 早先按「没有 ask」渲染过的那一版作废，ledger/JSON 都用这一版
  const nextLines = [...lines];
  nextLines[idx] = row;      // ← 整行重渲染（不是子串替换）

  if (!JSONOUT) {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] digest --replace · ${LINE} · ${DATE}\n`);
    process.stdout.write(`  结论档：${doc}（第 ${idx + 1} 行）\n`);
    process.stdout.write(`  改前：${oldRow}\n`);
    process.stdout.write(`  改后：${row}\n`);
    if (dispWidth(TEXT) > SLOT_CHARS) process.stdout.write(`  ⚠️ 这句 ${dispWidth(TEXT)} 显示宽 > ${SLOT_CHARS}：槽位一行放不下，建议压到一句\n`);
    if (!APPLY) process.stdout.write('  （未写；加 --apply 才就地替换）\n');
  }

  let wrote = false;
  let err = null;
  let sha = null;
  if (APPLY) {
    try {
      const bufNow = fs.readFileSync(doc);
      if (sha256(bufNow) !== sha256(bufBefore)) {
        sha = 'changed-under-us';                    // 读→写这几毫秒里被别人改了 ⇒ 放弃
      } else {
        writeFileAtomic(doc, nextLines.join(eol));   // 同目录 tmp + rename
        wrote = true;
      }
    } catch (e) { err = e && e.message ? e.message : String(e); }
  }
  // ⭐ A-3 补缺（2026-11-05）：就地换行也是「收口」⇒ 换完之后把接续头里那段槽位刷一遍
  //    （--replace 改的是结论行，槽位是该线最新那行 ⇒ 这一段会跟着变）。幂等：没变不写盘。
  // ⭐ 1.6.2（A-3 打回后）：槽位取舍同样**有活的线优先**（夹具 `--dir` 不现读看板 ⇒ 退回纯日期口径）
  const head = (err || sha) ? { ok: false, reason: 'replace-failed', changed: false, wrote: false, afterLines: 0 }
    : refreshResumeHeadSlots({ doc, slots: readSlots(SLOT_MAX, dir, dir === DIGEST_DIR ? await activeLineSetOrNull() : null), apply: APPLY });

  const w = appendOps(opsRecord({
    verb: 'digest', target: LINE, sid: null, ok: !err && !sha, dryRun: !APPLY, decidedBy: DECIDED,
    oldText: oldRow,        // ⭐ 改前那一整行（opsRecord 会截到 200 字）
    rollId: RUN_ID,
    extra: {
      date: DATE, doc, ref: ref || null, chars: TEXT.length, replace: true, wrote,
      lineNo: idx + 1, oldRef: 旧.ref || null, ask: effAsk, oldAsk: 旧.ask ?? null,
      eol: eol === '\r\n' ? 'crlf' : 'lf', sha, error: err,
      // ⭐ 2026-11-05（A-3 补缺）：接续头槽位段这一跑的结果（只加键）
      head: head.ok ? (head.wrote ? 'refreshed' : head.reason) : head.reason,
      headChanged: head.changed, headWrote: head.wrote,
    },
  }));

  if (JSONOUT) {
    process.stdout.write(JSON.stringify({
      verb: 'digest', replace: true, line: LINE, date: DATE, text: TEXT, ref: ref || null, ask: effAsk, doc, row,
      lineNo: idx + 1, oldRow, ok: !err && !sha, dryRun: !APPLY, wrote,
      eol: eol === '\r\n' ? 'crlf' : 'lf', sha, error: err,
      head: { ok: head.ok, reason: head.reason, changed: head.changed, wrote: head.wrote, atLine: head.atLine ?? 0, afterLines: head.afterLines },
      decidedBy: DECIDED, rollId: RUN_ID, ops: w,
    }, null, 2) + '\n');
  } else {
    if (head.wrote) process.stdout.write(`  接续头里的槽位段：已就地刷新（${head.afterLines} 行 · 段外未动）\n`);
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  }
  if (sha) {
    process.stderr.write('❌ 结论档在「读到写」的这几毫秒里被别的写入者改过（sha256 不符）⇒ 本次放弃，rc=3；档一个字节都没动\n');
    return 3;
  }
  if (err) { process.stderr.write(`✗ 替换结论档失败：${err}\n`); return 1; }
  if (!w.ok) { process.stderr.write(`⚠️ 动作流水写失败：${w.error}\n`); return 1; }
  return 0;
}

// ── digest --auto（2026-11-05 · 年轮判据 A-3：每线一行，纯机械） ────────────────
//   判据原文（`docs\年轮\愿景-统筹线.md` A-3 · 逐字）：
//     「每条在跑的主线**都有一行结论**在槽位里（不是只记 4 条）」
//   做法（**零模型调用**：只有取数 + 字符串拼接，没有任何 LLM / 外部网络请求）：
//     · 输入 = 当前「有活的主线」集合 —— 与 `brief` 车况**同一套**（aggregate + activeCount>0），不另造口径；
//     · 每条线一行 = 该线**最近一张 done 卡**的标题（截断 ≤120 显示宽）+ 卡 id 作 ref；
//       没有 done 卡的线**不编结论**，退化成「该线最近一张卡 + 它的状态词」（同样是机械摘取）；
//     · 幂等 = digest 既有幂等键（线名 + 日期）⇒ 同一天同一条线重复跑**零新增行**；
//     · 上限 = 槽位既有口径（≤16 行 · 每行 ≤120 显示宽）；超了按既有方式滚动并**明写**哪几条出窗，
//       不悄悄截断（下满 16 行时哪条线没写也逐条打印）。
export const AUTO_STATUS_WORD = {
  running: '在跑', review: '待验收', todo: '排队', backlog: '排队', failed: '失败', done: '已完成',
};

/**
 * 机械摘取「每条有活主线一行结论」—— 纯函数（夹具直接喂假数据；**不读盘、不联网**）。
 * @param {{tasks?:Array, rows?:Array, lineOfCard?:Map<string,string>}} opts
 * @returns {Array<{line:string, text?:string, ref?:string, kind?:string, at?:number, skip?:string}>}
 *   `skip:'no-card'` = 这条线一张卡都没有（不编，交给调用方如实打印）。
 */
export function buildAutoDigestRows({ tasks = [], rows = [], lineOfCard = new Map() } = {}) {
  const doneBy = new Map();
  const lastBy = new Map();
  for (const t of tasks || []) {
    const line = String(lineOfCard.get(String(t?.id ?? '')) ?? '').trim();
    if (!line) continue;
    const at = Number(t?.updatedAt ?? 0);
    const cur = lastBy.get(line);
    if (!cur || at > Number(cur.updatedAt ?? 0)) lastBy.set(line, t);
    if (String(t?.status ?? '') !== 'done') continue;
    const d = doneBy.get(line);
    if (!d || at > Number(d.updatedAt ?? 0)) doneBy.set(line, t);
  }
  const active = (rows || [])
    .filter((r) => activeCount(r) > 0)
    .sort((a, b) => (priority(a) - priority(b)) || (b.lastAt - a.lastAt));
  const out = [];
  for (const r of active) {
    const d = doneBy.get(r.line);
    const src = d ?? lastBy.get(r.line);
    if (!src) { out.push({ line: r.line, skip: 'no-card' }); continue; }
    const word = d ? '已完成' : (AUTO_STATUS_WORD[String(src.status ?? '')] ?? '最近');
    const title = String(src.title ?? '').replace(/\s+/g, ' ').trim();
    out.push({
      line: r.line,
      text: clipW(`${word}：${title}`, SLOT_CHARS),
      ref: String(src.id ?? ''),
      kind: d ? 'done' : String(src.status ?? ''),
      at: Number(src.updatedAt ?? 0),
    });
  }
  return out;
}

/** `digest --auto` 的完整流程（唯一写盘仍是 `appendRowToDoc`） */
async function runAutoDigest({ APPLY, JSONOUT, DIR, DATE }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE) || Number.isNaN(Date.parse(`${DATE}T00:00:00`))) {
    process.stderr.write(`❌ --auto 的 --date 要 YYYY-MM-DD，收到 "${DATE}"\n`);
    return 2;
  }
  const [board, threadLine] = await Promise.all([fetchBoard(), Promise.resolve(readThreadLineMap())]);
  const threadsJson = readJson(THREADS_FILE)?.threads ?? [];
  const tasks = board.tasks ?? [];
  const rows = aggregate(tasks, threadLine, threadsJson);
  const lineOfCard = lineOfCardMap(tasks, threadLine);
  const plan = buildAutoDigestRows({ tasks, rows, lineOfCard });

  const ym = DATE.slice(0, 7).replace('-', '');
  const doc = digestDocPath(ym, DIR);
  const existedKeys = new Set(readDocRows(doc).map((r) => `${r.date}｜${r.line}`));

  // 槽位容量：读者按日期降序只留最新 SLOT_MAX 行 ⇒ 今天的行都排在前面；
  //   别的线若今天已有行也占名额，先扣掉（那几个名额不归本轮）。
  const activeSet = new Set(plan.filter((p) => !p.skip).map((p) => p.line));
  const slotsAll = readSlots(10_000, DIR, activeSet);
  const otherToday = new Set(
    slotsAll.filter((s) => s.date === DATE && !activeSet.has(s.line)).map((s) => s.line),
  ).size;
  const room = Math.max(0, SLOT_MAX - otherToday);
  const planned = plan.filter((p) => !p.skip);
  const capped = planned.slice(0, room);
  const overflow = planned.slice(room);
  const noCard = plan.filter((p) => p.skip).map((p) => p.line);

  const out = [];
  let wrote = 0;
  let skipped = 0;
  for (const p of capped) {
    const key = `${DATE}｜${p.line}`;
    const existed = existedKeys.has(key);
    const row = digestRow({ date: DATE, line: p.line, text: p.text, ref: p.ref });
    let w = { wrote: false, err: null };
    if (APPLY && !existed) w = appendRowToDoc({ doc, ym, row });
    if (existed) skipped += 1;
    if (w.wrote) { wrote += 1; existedKeys.add(key); }
    out.push({ line: p.line, kind: p.kind, ref: p.ref, row, existed, wrote: w.wrote, error: w.err });
  }

  // 收尾：现读槽位核覆盖（判据「每条有活主线都有一行」的现场读数）
  //   dry-run 时槽位还没写 ⇒ 覆盖按「写完之后会是什么样」**投影**，并如实标「预计」。
  // ⭐ 1.6.2（A-3 打回后）：槽位取舍 = **有活的线优先**（activeSet 就是本轮刚算出的活线集合），
  //    静线（今天更早也收口过、但此刻无在途卡）只在活线不满 16 名时补位。
  const slots = readSlots(SLOT_MAX, DIR, activeSet);
  // ⭐ A-3 补缺（2026-11-05）：结论区写完 ⇒ 顺手把**接续头里那段槽位**刷新成当前槽位。
  //    只换那一段（段外一个字节不动：时间戳 / 待拍板 / 结论区历史行都不碰）；渲染结果与档里相同 ⇒ 不写盘。
  //    ⚠️ 即便本轮零新增行（今天这 15 条线都已在档里）也照刷 —— 补的就是「档里的槽位停在老日期」这个缺。
  const head = refreshResumeHeadSlots({ doc, slots, apply: APPLY });
  const cover = new Set(slots.map((s) => s.line));
  if (!APPLY) for (const p of capped) cover.add(p.line);
  const missing = [...activeSet].filter((l) => !cover.has(l));
  const beforeLines = new Set(slotsAll.map((s) => s.line));
  const rolled = APPLY ? [...beforeLines].filter((l) => !cover.has(l)) : [];
  const errs = out.filter((x) => x.error);
  if (head.err) errs.push({ line: '(接续头)', error: head.err });

  if (!JSONOUT) {
    const L = [];
    L.push(`[${APPLY ? 'apply' : 'dry-run'}] digest --auto · ${DATE} · 有活主线 ${activeSet.size} 条`);
    L.push(`  结论档：${doc}`);
    L.push(`  将写 ${planned.length} 行（槽位上限 ${SLOT_MAX} 行 · 已有今天同一行的跳过）：`);
    for (const x of out) L.push(`    ${x.row}${x.existed ? '   ← 幂等跳过（今天已有这行）' : ''}`);
    if (skipped) L.push(`  幂等跳过 ${skipped} 行（同一天同一条线只留一行）`);
    if (noCard.length) L.push(`  ⚠️ 一张卡都没有、不编结论：${noCard.join('、')}`);
    if (overflow.length) L.push(`  ⚠️ 槽位满 ${SLOT_MAX} 行 ⇒ 今天这 ${overflow.length} 条线没写：${overflow.map((p) => p.line).join('、')}`);
    if (rolled.length) L.push(`  滚动出窗 ${rolled.length} 条旧结论（仍在结论档里，没删）：${rolled.slice(0, 6).join('、')}${rolled.length > 6 ? ' …' : ''}`);
    L.push(`  槽位现状${APPLY ? '' : '（dry-run 按写完后投影）'}：${slots.length}/${SLOT_MAX} 行 · 覆盖有活线 ${activeSet.size - missing.length}/${activeSet.size}`);
    if (missing.length) L.push(`  ⚠️ 槽位里还差这些有活主线：${missing.join('、')}`);
    if (!head.ok) {
      L.push(`  ⚠️ 接续头里的槽位段没刷（${head.reason === 'no-slot-section' ? '档里还没有接续头 ⇒ 先跑一次 reset' : head.reason === 'no-doc' ? '结论档不存在' : head.reason}）`);
    } else if (head.reason === 'unchanged') {
      L.push(`  接续头里的槽位段：与当前槽位逐字相同 ⇒ 不动（第 ${head.atLine} 行起 · ${head.beforeLines} 行）`);
    } else {
      L.push(`  接续头里的槽位段：第 ${head.atLine} 行起 ${head.beforeLines} → ${head.afterLines} 行${APPLY ? '（已就地刷新，段外未动）' : '（dry-run：只是预计）'}`);
    }
    if (!APPLY) L.push('  （未写；加 --apply 才追加）');
    process.stdout.write(`${L.join('\n')}\n`);
  }

  const w = appendOps(opsRecord({
    verb: 'digest', target: '(auto)', sid: null, ok: !errs.length, dryRun: !APPLY, decidedBy: 'plugin',
    extra: {
      auto: true, date: DATE, doc, active: activeSet.size, planned: planned.length,
      wrote, skipped, overflow: overflow.length, missing: missing.length, eol: null, error: errs[0]?.error ?? null,
      // ⭐ 2026-11-05（A-3 补缺）：接续头槽位段这一跑的结果（只加键）
      head: head.ok ? (head.wrote ? 'refreshed' : head.reason) : head.reason,
      headChanged: head.changed, headWrote: head.wrote, headLines: head.afterLines,
    },
  }));

  if (JSONOUT) {
    process.stdout.write(JSON.stringify({
      verb: 'digest', auto: true, date: DATE, doc, ok: !errs.length, dryRun: !APPLY,
      activeLines: activeSet.size, rows: out, noCard, overflow: overflow.map((p) => p.line),
      rolledOut: rolled, slot: { lines: slots.length, max: SLOT_MAX, missing },
      // ⭐ 2026-11-05（A-3 补缺）：接续头槽位段的刷新读数（只加键）
      head: {
        ok: head.ok, reason: head.reason, changed: head.changed, wrote: head.wrote,
        slotSections: head.slotSections, atLine: head.atLine,
        beforeLines: head.beforeLines, afterLines: head.afterLines,
        shaBefore: head.shaBefore, shaAfter: head.shaAfter, error: head.err,
      },
      ops: w,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  }
  if (errs.length) { process.stderr.write(`✗ 写结论档失败：${errs[0].error}\n`); return 1; }
  if (!w.ok) { process.stderr.write(`⚠️ 动作流水写失败：${w.error}\n`); return 1; }
  return 0;
}

/**
 * `digest --auto` 的外壳：**先抢 tick 锁**（锁名 `router-digest`，登记在 `lib\butler-locks.mjs`），
 * 抢不到 = 另一轮正在跑 ⇒ 本轮让路、退出码 0（不算失败）。
 * 手工 `--auto` 与 tickd 的每日 job 走同一条路、抢同一把锁 ⇒ 不会双写同一份结论档。
 */
async function cmdDigestAuto(opts) {
  let lock = null;
  try {
    const { acquireTickLock } = await import('../src/dsh-butler/lib/store.mjs');
    lock = acquireTickLock('router-digest', { ttlMs: 120_000 });
  } catch (e) {
    process.stderr.write(`⚠️ router-digest 抢锁失败（${e?.message ?? e}）—— 照常继续（本动作幂等）\n`);
  }
  if (lock && !lock.ok) {
    process.stdout.write(`[router-digest] 跳过：锁被占（${lock.reason ?? 'locked'}）—— 另一轮正在跑\n`);
    return 0;
  }
  try {
    return await runAutoDigest(opts);
  } finally {
    try { lock?.release?.(); } catch { /* 释放失败由 ttl 兜底 */ }
  }
}

async function cmdDigest(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

  const LINE = norm(val('--line', ''));
  const RAW_TEXT = String(val('--text', '') ?? '');
  const REF = norm(val('--ref', ''));
  const DATE = norm(val('--date', '')) || ymd();
  const APPLY = has('--apply');
  const JSONOUT = has('--json');
  const DECIDED = norm(val('--decided-by', 'router')).toLowerCase();
  // ⭐ 2026-11-03（槽位回写一期）：`--replace` = **就地替换当天那一行**。
  //    🔴 缺省不带 ⇒ 下面每一条路径与改前**一字不差**（老调用方零感知）。
  const REPLACE = has('--replace');
  const RUN_ID = norm(val('--run-id', '')) || null;
  // ⭐ YB2-R1（2026-11-03）：`--ask <askId>` = 6 字符愿景指针；缺省 / 空 / `-` ⇒ null（**旧行逐字不变**）。
  const ASK_RAW = norm(val('--ask', ''));
  // `--dir` 同样只是**夹具/演练钩子**（不污染生产结论档 `docs\年轮\router-YYYYMM.md`）；生产不传。
  const DIR = norm(val('--dir', '')) || DIGEST_DIR;

  // ⭐ 年轮判据 A-3（2026-11-05）：`--auto` = 每条「有活的主线」机械写一行结论（**零模型调用**）。
  //    🔴 与 `--line` 互斥；写盘仍走同一支 appendRowToDoc ⇒ 老路径一个字节都不变。
  const AUTO = has('--auto');
  if (AUTO) {
    if (LINE) {
      process.stderr.write('❌ --auto 与 --line 互斥（--auto 自己按主线取行；要手写某一条线就别带 --auto）\n');
      return 2;
    }
    return await cmdDigestAuto({ APPLY, JSONOUT, DIR, DATE });
  }

  // ① 用法闸：**空结论不收**（这档只放结论，空行等于污染）
  if (!LINE) {
    process.stderr.write('❌ 缺线名（--line <线名>）—— 一条线一行，线名就是槽位的第一格\n');
    return 2;
  }
  if (dispWidth(LINE) > 60) {
    process.stderr.write(`❌ 线名太长（${dispWidth(LINE)} > 60）：写主线名，别把整句话塞进线名\n`);
    return 2;
  }
  const textLines = RAW_TEXT.replace(/\r\n/g, '\n').split('\n');
  const TEXT = norm(textLines[0]);
  const extraLines = textLines.slice(1).filter((l) => l.trim()).length;
  if (!TEXT) {
    process.stderr.write('❌ 缺结论（--text "一句结论"）—— 空结论不收：这档只放结论\n');
    return 2;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE) || Number.isNaN(Date.parse(`${DATE}T00:00:00`))) {
    process.stderr.write(`❌ --date 要 YYYY-MM-DD，收到 "${DATE}"\n`);
    return 2;
  }
  if (!DECIDED_BY.includes(DECIDED)) {
    process.stderr.write(`❌ --decided-by 只支持 ${DECIDED_BY.join('|')}；收到 "${DECIDED}"\n`);
    return 2;
  }
  // `--ask` 收口闸（与 --date / --decided-by 同一风格：拒收 ⇒ rc=2、**一个字节都不写**）
  let ASK = null;
  if (ASK_RAW && ASK_RAW !== '-') {
    if (/[｜\r\n]/.test(ASK_RAW) || /\s/.test(ASK_RAW)) {
      process.stderr.write(`❌ --ask 不许含全角竖线 / 空白（会拆坏行格式），收到 "${ASK_RAW}"\n`);
      return 2;
    }
    if ([...ASK_RAW].length > 6) {
      process.stderr.write(`❌ --ask 最多 6 字符（愿景件里 ask 的 id），收到 "${ASK_RAW}"（${[...ASK_RAW].length} 字符）\n`);
      return 2;
    }
    ASK = ASK_RAW;
  }

  const ref = REF.replace(/\\/g, '/');           // 档是 markdown：反斜杠会被吃掉 ⇒ 统一正斜杠
  const row = digestRow({ date: DATE, line: LINE, text: TEXT, ref, ask: ASK });
  const doc = digestDocPath(DATE.slice(0, 7).replace('-', ''), DIR);

  // ② 幂等：同一天同一条线已经有了 ⇒ 不重复追加（dry-run 也照实说）
  //    ⚠️ 这条是**老路径**（不带 --replace）的判据，行为一字不改（S6 / 判据 J7·J10）。
  const existed = readDocRows(doc).some((r) => r.date === DATE && r.line === LINE);

  // ②b --replace：就地替换当天那一行 —— 走独立函数，老路径一个字节都不碰
  if (REPLACE) {
    return await replaceDigestRow({ APPLY, JSONOUT, DECIDED, RUN_ID, DATE, LINE, TEXT, ref, ask: ASK, askGiven: has('--ask'), row, doc, dir: DIR });
  }

  // ③ 写（只有 --apply + 不是重复才落盘）
  let wrote = false;
  let err = null;
  if (APPLY && !existed) {
    const r = appendRowToDoc({ doc, ym: DATE.slice(0, 7).replace('-', ''), row });
    wrote = r.wrote;
    err = r.err;
  }
  // ⭐ A-3 补缺（2026-11-05）：手工收口（--line）写完之后**同样**把接续头里那段槽位刷一遍 ——
  //    收口动作不论自动还是手工，产物都该同构。幂等：槽位没变就不写盘；档里还没接续头（没跑过
  //    reset）⇒ 静默跳过（不发明新段，那归 reset）。
  // ⭐ 1.6.2（A-3 打回后）：槽位取舍同样**有活的线优先**（夹具 `--dir` 不现读看板 ⇒ 退回纯日期口径）
  const head = err ? { ok: false, reason: 'doc-error', changed: false, wrote: false, afterLines: 0 }
    : refreshResumeHeadSlots({ doc, slots: readSlots(SLOT_MAX, DIR, DIR === DIGEST_DIR ? await activeLineSetOrNull() : null), apply: APPLY });

  if (!JSONOUT) {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] digest · ${LINE} · ${DATE}\n`);
    process.stdout.write(`  结论档：${doc}\n`);
    if (existed) {
      // 幂等命中：打印**档里已有的那一行**，别让人误以为刚输入的新文本进了档
      const cur = readDocRows(doc).find((r) => r.date === DATE && r.line === LINE);
      process.stdout.write(`  幂等：同一天同一条线已有 ⇒ 跳过（不重复追加）\n`);
      if (cur) process.stdout.write(`  已有：${digestRow(cur)}\n`);
      process.stdout.write(`  今回给的（**没进档**）：${row}\n`);
    } else {
      process.stdout.write(`  这一行：${row}\n`);
    }
    if (extraLines > 0) process.stdout.write(`  ⚠️ --text 有多行，只收第一行（其余 ${extraLines} 行没进档：过程不进结论档）\n`);
    if (dispWidth(TEXT) > SLOT_CHARS) process.stdout.write(`  ⚠️ 这句 ${dispWidth(TEXT)} 显示宽 > ${SLOT_CHARS}：槽位一行放不下，建议压到一句\n`);
    if (head.wrote) process.stdout.write(`  接续头里的槽位段：已就地刷新（${head.afterLines} 行 · 段外未动）\n`);
    if (!APPLY) process.stdout.write('  （未写；加 --apply 才追加）\n');
  }

  const w = appendOps(opsRecord({
    verb: 'digest', target: LINE, sid: null, ok: !err, dryRun: !APPLY, decidedBy: DECIDED,
    extra: {
      date: DATE, doc, ref: ref || null, chars: TEXT.length, wrote, ask: ASK || null,
      skipped: existed ? 'duplicate' : null, error: err,
      // ⭐ 2026-11-05（A-3 补缺）：接续头槽位段这一跑的结果（只加键）
      head: head.ok ? (head.wrote ? 'refreshed' : head.reason) : head.reason,
      headChanged: head.changed, headWrote: head.wrote,
    },
  }));

  if (JSONOUT) {
    process.stdout.write(JSON.stringify({
      verb: 'digest', line: LINE, date: DATE, text: TEXT, ref: ref || null, ask: ASK || null, doc, row,
      ok: !err, dryRun: !APPLY, wrote, skipped: existed ? 'duplicate' : null, error: err,
      head: { ok: head.ok, reason: head.reason, changed: head.changed, wrote: head.wrote, atLine: head.atLine ?? 0, afterLines: head.afterLines },
      decidedBy: DECIDED, ops: w,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  }
  if (err) { process.stderr.write(`✗ 写结论档失败：${err}\n`); return 1; }
  if (!w.ok) { process.stderr.write(`⚠️ 动作流水写失败：${w.error}\n`); return 1; }
  return 0;
}

// ── reset ─────────────────────────────────────────────────────────────────

/**
 * 把「接续头」写进结论档：**同一天只留一段**（2026-11-03 · 方案 v2 §3.4）。
 *
 * 老行为是每次 `appendFileSync` 追一段、**永不出列**（一天 48 次就能长 60 KB，而 `readSlots` 每次全量读）。
 * 新行为：把档切成「第一个 `### ` 之前 = 头」+「每个 `### ` 起的段」——
 *   **当天所有「接续头」段全删**，新段放到该天**原来第一段**的位置；
 *   **别的天一个字节都不动**（判据 J15）。写盘同 `--replace`：同目录 `.tmp` + `rename`。
 *
 * @returns {{ok:boolean, wrote:boolean, err:string|null, replacedSegments:number, created:boolean}}
 */
function writeResumeHeadDoc(doc, head, at) {
  const 今天 = ymd(at);
  let created = false;
  try {
    let txt;
    try {
      txt = fs.readFileSync(doc, 'utf8');
    } catch {
      created = true;
      fs.mkdirSync(path.dirname(doc), { recursive: true });
      txt = digestHeader(ymOf(at));
    }
    const { eol, lines } = splitLinesKeepEol(txt);
    const starts = [];
    lines.forEach((l, i) => { if (/^###\s+/.test(l)) starts.push(i); });
    const 头 = lines.slice(0, starts.length ? starts[0] : lines.length);
    const 段们 = starts.map((s, i) => lines.slice(s, i + 1 < starts.length ? starts[i + 1] : lines.length));
    const 段日期 = (seg) => {
      const m = String(seg[0] || '').match(/^###\s+接续头\s*·\s*(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };

    const 保留 = [];
    let 插入点 = -1;
    let replacedSegments = 0;
    for (const seg of 段们) {
      if (段日期(seg) === 今天) {
        if (插入点 < 0) 插入点 = 保留.length;   // 放在该天**原来第一段**的位置
        replacedSegments++;
        continue;
      }
      保留.push(seg);
    }
    if (插入点 < 0) 插入点 = 保留.length;

    // 新段 = 接续头正文 + 尾空行；前面**按需**补一个空行（前一段已留空行就别再补，免得连出两个）
    const 新段正文 = head.split(/\r?\n/);
    const 前段 = 插入点 > 0 ? 保留[插入点 - 1] : 头;
    const 前已留空 = 前段.length > 0 && 前段[前段.length - 1] === '';
    const 新段 = 前已留空 ? [...新段正文, ''] : ['', ...新段正文, ''];

    // 头末尾的空行让位给新段自己的前导空行（只动这一条缝，别处的空行原样保留）
    const 头收 = [...头];
    if (!前已留空) while (头收.length && 头收[头收.length - 1] === '') 头收.pop();

    保留.splice(插入点, 0, 新段);
    writeFileAtomic(doc, [...头收, ...保留.flat()].join(eol));
    return { ok: true, wrote: true, err: null, replacedSegments, created };
  } catch (e) {
    return { ok: false, wrote: false, err: e && e.message ? e.message : String(e), replacedSegments: 0, created };
  }
}

async function cmdReset(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

  const APPLY = has('--apply');
  const JSONOUT = has('--json');
  const DECIDED = norm(val('--decided-by', 'router')).toLowerCase();
  if (!DECIDED_BY.includes(DECIDED)) {
    process.stderr.write(`❌ --decided-by 只支持 ${DECIDED_BY.join('|')}；收到 "${DECIDED}"\n`);
    return 2;
  }

  const at = Date.now();
  // ⭐ 1.6.2（A-3 打回后）：reset 与收口**同一套取舍** —— 有活的线优先，活线不满 16 名时静线补位。
  //    拿不到看板（fetch 失败）⇒ null ⇒ 退回纯日期口径（reset 不能因为取数失败而不干活）。
  //    格式（除槽位行内容）与 1.6.1 逐字相同：渲染仍走 renderSlotBlock。
  const slots = readSlots(SLOT_MAX, DIGEST_DIR, await activeLineSetOrNull());
  const attn = readAttentions();                 // 本地文件；**不联网**（dsh 起不来也能收口）
  const doc = digestDocPath(ymOf(at));
  const head = renderResumeHead({ slots, attnOpen: attn.open, at, doc });

  // ⭐ 2026-11-03：同一天只留一段 —— 替换/收敛都在 writeResumeHeadDoc 里（tmp + rename 原子写）
  let wrote = false;
  let err = null;
  let 替换了几段 = 0;
  if (APPLY) {
    const r = writeResumeHeadDoc(doc, head, at);
    wrote = r.wrote;
    err = r.err;
    替换了几段 = r.replacedSegments;
  }

  const w = appendOps(opsRecord({
    verb: 'reset', target: '(router)', sid: null, ok: !err, dryRun: !APPLY, decidedBy: DECIDED,
    extra: {
      doc, slots: slots.length, attentions: attn.open.length, wrote, error: err,
      replacedSegments: 替换了几段,   // ⭐ 2026-11-03：同一天被替换掉的旧接续头段数（0 = 当天头一回）
      sessionTouched: false,   // 如实声明：这一跑没碰任何会话
    },
  }));

  if (JSONOUT) {
    process.stdout.write(JSON.stringify({
      verb: 'reset', ok: !err, dryRun: !APPLY, doc, slots: slots.length, attentions: attn.open.length,
      wrote, replacedSegments: 替换了几段, error: err, decidedBy: DECIDED, head, ops: w, sessionTouched: false,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] reset · 槽位 ${slots.length} 行 · 待拍板 ${attn.open.length} 件\n`);
    process.stdout.write(`  结论档：${doc}\n`);
    process.stdout.write(APPLY
      ? (wrote ? `  已把这段「接续头」写进档（同一天只留一段：本次替换掉 ${替换了几段} 段旧段）。\n` : `  ✗ 写档失败：${err}\n`)
      : '  （dry-run：没写；加 --apply 才写进档）\n');
    process.stdout.write('  ── 接续头（直接贴给下一次的自己）──\n');
    process.stdout.write(head + '\n');
    process.stdout.write('  ──\n');
    process.stdout.write('  🔴 没有清空任何东西：不调 session.compact、不删会话、不归档。到阈值由宿主自动压（阈值见 cordis.patch.yml 的 thresholdRatio，现 0.20），不用人按。\n');
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  }
  if (err) return 1;
  if (!w.ok) { process.stderr.write(`⚠️ 动作流水写失败：${w.error}\n`); return 1; }
  return 0;
}

// ── 上手活 inflight（2026-11-05 · 卡「Router上手活抗压缩」）──────────────────
//
// 干什么：把「我正在写什么、做到哪、下一步」记成一行文件；情绪插件的槽位 section 每轮重读它、
//        打进系统提示（`dsh-feiyu-mood/lib/slots.js#renderInflight`）。
// 为什么：宿主压缩按 token 水位自动触发、**不看手上有没有未落盘的活**。section 每轮重算、不进历史
//        ⇒ 压掉历史也不会丢这一行。不记的话，压完就不记得自己写到哪了。
// 只读面：show 只读文件；set/clear 只碰这一个文件，**不发任何会话 RPC、不动看板、不记 ops 流水**
//        （ops 是 say/wake/digest/reset 的账，别把新动词塞进去污染统计）。

/** 本地时区 ISO（形如 2026-11-05T11:34:00+08:00 —— 与 card/persona 里给的样例同形） */
function isoLocal(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = Math.floor(Math.abs(off) / 60);
  const om = Math.abs(off) % 60;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(oh)}:${p(om)}`;
}

async function cmdInflight(argv) {
  const sub = String(argv[1] ?? '').toLowerCase();
  const file = INFLIGHT_FILE;

  if (sub === 'set') {
    const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
    // `--text` 只收**一句**：多行压成 ` ⏎ `（与 slots.js 的显示口径一致，单行才不会撑坏槽位段）
    const text = norm(val('--text', '')).replace(/\r\n?/g, '\n').replace(/\n/g, ' ⏎ ');
    if (!text) {
      process.stderr.write('✗ inflight set 要 --text "<一句话：在写什么、做到哪、下一步>"\n');
      return 2;
    }
    const rec = { text, at: isoLocal(), by: 'router' };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(rec, null, 2) + '\n');   // 原子写：同目录 .tmp → rename（见 writeFileAtomic）
    } catch (e) {
      process.stderr.write(`✗ 写上手活失败：${e?.message ?? e}\n`);
      return 1;
    }
    process.stdout.write(`✅ 上手活已记（${rec.at}）：${text}\n`);
    process.stdout.write('   它每轮由槽位 section 注入、压缩不吃；干完记得清：node <pkg>/jobs/router-act.mjs inflight clear\n');
    return 0;
  }

  if (sub === 'clear') {
    let existed = false;
    try { existed = fs.existsSync(file); } catch { /* 读不到当不存在 */ }
    try {
      if (existed) fs.rmSync(file, { force: true });
      // 顺手清掉原子写可能留下的半成品（只清自己这一支，别去扫目录）
      try { fs.rmSync(file + '.tmp', { force: true }); } catch { /* ignore */ }
    } catch (e) {
      process.stderr.write(`✗ 清上手活失败：${e?.message ?? e}\n`);
      return 1;
    }
    process.stdout.write(existed ? `✅ 上手活已清（删了 ${file}）\n` : '（本来就没有上手活，幂等 rc 0）\n');
    return 0;
  }

  if (sub === 'show' || sub === '' || sub === '-h' || sub === '--help') {
    const j = readJson(file);
    const text = norm(j?.text);
    if (!text) {
      const st = fs.existsSync(file) ? '文件在、但 text 空（或 JSON 坏）' : '文件不存在';
      process.stdout.write(`（当前没有上手活：${st} · ${file}）\n`);
      return 0;
    }
    process.stdout.write(`🔧 上手活：${text}\n   记于 ${j?.at || '时间未记'} · by ${j?.by || 'unknown'}\n   文件：${file}\n`);
    return 0;
  }

  process.stderr.write(`未知 inflight 子命令：${sub}（只认 set / show / clear）\n`);
  return 2;
}

// ── inbox：静默来信（**只透传** router-inbox.mjs，方案 §4.6）────────────────
/**
 * `router-act inbox [--tail N] [--unread] [--line <子串>] [--claim --through <id>] [--apply]`
 * `router-act inbox show <id>`（与 `router-inbox show <id>` 同形：看全文走位置参数）
 *
 * 为什么透传而不在本件重实现：静默档的读写只有一个口（`router-inbox.mjs`），
 *   第二份实现必然口径漂移（认领三态 / 切档只搬已认领 / rc 6·7 语义）。
 * 退出码原样透传（0/1/2/4/6/7）—— Router 与夹具读到的 rc 与直跑 router-inbox 完全一致。
 */
export async function cmdInbox(argv) {
  const rest = argv.slice(1);   // 去掉 `inbox` 这一层动词
  // 形状映射（方案 §4.6：`router-act inbox [...]` 与 `router-inbox list [...]` 同义）：
  //   `inbox show <id>`            → `router-inbox show <id>`
  //   `inbox --claim --through x`  → `router-inbox claim --through x`（--claim 是旗标，不是子动词）
  //   `inbox --tail 50 --unread`   → `router-inbox list --tail 50 --unread`（缺省就是 list）
  let mapped;
  if (rest[0] === 'show') mapped = rest;
  else if (rest.includes('--claim')) mapped = ['claim', ...rest.filter((x) => x !== '--claim')];
  else mapped = ['list', ...rest];
  try {
    const r = spawnSync(process.execPath, [INBOX_SCRIPT, ...mapped], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    if (r.stdout) process.stdout.write(String(r.stdout));
    if (r.stderr) process.stderr.write(String(r.stderr));
    if (typeof r.status === 'number') return r.status;
    process.stderr.write(`✗ inbox 透传失败：${r.error ? String(r.error.message ?? r.error) : '无退出码'}\n`);
    return 1;
  } catch (e) {
    process.stderr.write(`✗ inbox 透传异常：${e?.message ?? e}\n`);
    return 1;
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────

const USAGE = `Router 动作入口 v${VERSION}（主 Router 的唯一受控手 · 白名单动词）

  node <pkg>/jobs/router-act.mjs brief     [--json] [--gaps]
  node <pkg>/jobs/router-act.mjs status    [--json] [--max-lines N]
  node <pkg>/jobs/router-act.mjs say       --to <主线名|会话id> --text "<一句话>" [选项]
  node <pkg>/jobs/router-act.mjs wake      --thread <threadId> --text "<一句话>" [--apply]
  node <pkg>/jobs/router-act.mjs card-show --card <cardId> [--max-lines N]
  node <pkg>/jobs/router-act.mjs digest    --line <线名> --text "<一句结论>" [--ref <卡id或报告路径>] [--ask <askId>] [--date YYYY-MM-DD] [--apply] [--replace] [--run-id <批次号>] [--dir <path>]
  node <pkg>/jobs/router-act.mjs digest    --auto [--date YYYY-MM-DD] [--apply] [--json] [--dir <path>]
  node <pkg>/jobs/router-act.mjs reset     [--apply] [--json]
  node <pkg>/jobs/router-act.mjs inflight  set --text "<一句话>" | show | clear
  node <pkg>/jobs/router-act.mjs inbox     [--tail N] [--unread] [--line <子串>] [--claim --through <id>] [--apply]
  node <pkg>/jobs/router-act.mjs inbox     show <id>

  brief       三行摘要（每次开口先跑）：车况一行 + 建议先看哪条 + 要主人定的事（**≤3 条明细**）
  status      读看板 + 两个 steward 文件，按主线一屏报车况（只读，零写入）
  say         指名投话给某条主线 —— **默认 dry-run**（只预览，不投）；--apply 才真投
  wake        叫醒某本 thread 里已睡着的卡 —— **默认 dry-run**（只干跑，不 POST）；--apply 才真跑
  card-show   只读看一张卡的一句话摘要（默认 ≤20 行，--max-lines 上限 40）
  digest      把一条线的「一句结论」追加进结论档 —— **默认 dry-run**，--apply 才写；--replace 就地改当天那行
  digest --auto  每条「有活的主线」各写一行结论（机械摘取 · **零模型调用** · 幂等键 = 线名+日期）
  reset       槽位 + 待拍板写成「接续头」写进结论档（**同一天只留一段**）—— **默认 dry-run**；🔴 不清空任何东西
  inflight    上手活：记 / 看 / 清「我在写什么、做到哪、下一步」—— 挂在系统提示里，**上下文被压缩也不丢**
  inbox       静默来信：list / show <id> / claim --through <id> --apply —— **透传** router-inbox.mjs（形状与它逐字一致）
  --json      机器可读输出（不限行数）
  --gaps      brief 才认：三行之后追加「愿景差距（Top-3）」；**不带它就是严格三行**
  --max-lines 人类可读模式的硬上限（status 默认 20；card-show 默认 20、上限 40）

── say 细节 ────────────────────────────────────────────────────────────────
  目标解析（**绝不猜**）：
    · --to 给的是会话 id（session- 前缀 或 纯 uuid）⇒ 直接投那一条；
    · --to 给的是主线名 ⇒ 在会话表里按「标题子串 / sid 子串」找候选（与 session-say --list --grep 同一判据）；
      **命中恰好 1 个才投**；命中 0 个 ⇒ rc=3 并提示看候选；命中多个 ⇒ rc=3、列出候选、**一个都不投**。
  投递通道：只 spawn 同目录的 session-say.mjs（它自带三道闸：目标==自己 / 已归档 / 已交接），
    本件不实现第二套投递。--allow-self 原样透传（仅自测用）。

  --text "<一句话>"        第 1 行的**人话**（主人也读得懂）。信封第 2 行由参数自动生成。
  --cmd ask|do|report|notify   要它干什么（封闭四值，默认 do）
  --id <短号>              配对号（默认自动生成 6 位 base36）
  --prio now|today|when-free   多急（默认 today）
  --due "YYYY-MM-DD HH:MM"     截止（默认 - 表示不定）
  --ref <卡id 或 报告路径>      依据/出处（默认 -）
  --reply <名字>           回话署名（默认「统筹线」）
  --raw                    🔴 逃生口：--text 原样投，**不套信封**（主人自己写的整段话用这个）
  --mode queue|steer       默认 queue（跑完再送）；steer = step 边界插话
  --apply                  真投（缺省 dry-run）
  --receipt "<回话原文>"     不投递，只把对方的回话记进流水（宽容解析：没有 @@rep 也照收，format=free）
  --decided-by router|owner|plugin  这行动作**是谁拍的**（默认 router = 你自决；主人定的/派下来的写 owner；机器写的写 plugin）

  派活信封（两行制 · 词表封闭）：
    【派·统筹线→<线名>】<一句话：要它干什么>
    @@cmd=<ask|do|report|notify>; id=<短号>; reply=统筹线; prio=<now|today|when-free>; due=<YYYY-MM-DD HH:MM|->; ref=<卡id 或 报告路径|->

  回执（子 Router 照这个形状回；**不守格式也不会被丢**，只是流水里标 format:free）：
    【回·<线名>→统筹线】<一句话结论>
    @@rep id=<同一短号>; state=<done|blocked|failed|need-decide>; out=<卡id 或 报告路径|->

  完整来回例子（照着抄就行）：
    $ router-act.mjs say --to 视频线 --text "把管家V3安装器片脚本 v6 的配音时长核一遍" --cmd do --prio today --ref <卡id> --apply
    投出去的正文：
      【派·统筹线→视频线】把管家V3安装器片脚本 v6 的配音时长核一遍
      @@cmd=do; id=k3f9a1; reply=统筹线; prio=today; due=-; ref=<卡id>
    视频线回：
      【回·视频线→统筹线】核完 173.4s，报告已落 docs\\交付报告-xxx.md
      @@rep id=k3f9a1; state=done; out=docs\\交付报告-xxx.md
    要把它记进 Router 的账：
      $ router-act.mjs say --to 视频线 --receipt "<上面那两行原样粘进来>"

── wake 细节 ───────────────────────────────────────────────────────────────
  node router-act.mjs wake --thread <threadId> --text "<一句话>" [--apply] [--no-wake] [--json]
    🔴 **只唤「已经在某个 thread 里的卡」**（C12-C 的唤醒挂在 thread 上，thread 的成员是**卡 id、不是会话**）。
       不做「任意卡直接唤醒」——那等于绕开 thread 直接 POST run，会把 C12-C 的三道闸（单条≤2 张 /
       同卡 30 分钟冷却 / --no-wake）架空。方案明确不做，本件也不加。
    ⚠️ **没有 thread 的活 ⇒ 改用 say**：把话投给那条主线会话，由它自己去跑卡：
       router-act.mjs say --to <主线名> --text "…" --apply
    干跑/真跑约定沿用 steward-threads.mjs（它本身缺省就是干跑，只有 --apply 才真投/真唤）。
    --no-wake  只扇话、不唤醒（原样透传）
    --decided-by router|owner|plugin  同 say（谁拍的，默认 router）
    --text 不套信封（信封只加在 say 的正文层）；它会**同时**扇给该 thread 里 running 的会话。

── card-show 细节 ──────────────────────────────────────────────────────────
  只读，**绝不发任何 POST**（不 run / 不 move / 不 confirm）。输出：卡 id / 标题 / status / line+seq /
  执行数 / 最近一次执行结果 / description 的「待拍板」段（若有，≤10 行）。
  🔴 默认 ≤20 行，--max-lines 上限 40；**不搬卡面 / description 全文 / prompt 正文**。

── digest 细节（R1-7 · 结论档）──────────────────────────────────────────────
  node router-act.mjs digest --line <线名> --text "<一句结论>" [--ref <卡id或报告路径>] [--ask <askId>] [--date YYYY-MM-DD] [--apply] [--replace] [--run-id <批次号>] [--dir <path>]
    写到 <workspace>/docs/年轮/router-<YYYYMM>.md（按 --date 的月份；档不存在会自动建 + 写档头说明）。
    · 一行 = 哪条线 + 一句结论 + 指向卡/报告的链接；**过程一律不进**（过程留在子线自己那边）。
    · 幂等键 = **线名 + 日期** ⇒ 同一天同一条线重复 digest 不重复追加（打印「幂等：…跳过」）。
    · --text 只收**第一行**（多行其余部分不进档，会告警）；空结论直接 rc=2 不收。
    · 默认 dry-run（只打印将追加的那一行）；--apply 才写。
    · 写成功/跳过都向 ~/.dsh/router-ops.jsonl 记一行（verb=digest，含 decidedBy）。
    · **--replace（2026-11-03 新增，缺省关闭）**：把**当天那一行**就地换掉，而不是再追加一行。
        - 定位 = 同日同线**恰好 1 行**；命中 0 或 >1 ⇒ rc=3、**一个字节都不写**；
        - 改法 = 用 digestRow() 整行重渲染（不做子串替换）；行尾/BOM 逐字保留；
        - 写盘 = 同目录 .tmp → rename（原子）；写前核 sha256，读→写之间被别人改过 ⇒ rc=3 放弃；
        - 流水多两个键：「oldText」（改前那一整行，≤200 字）、「rollId」（--run-id 给的批次号，可省）。
        - 🔴 为什么必须就地改：readSlots 同日同线**先出现者胜** ⇒「追加一行更新的」永远读不回来。
    · --decided-by router|owner|plugin：plugin = 机器/插件写的（别让机器行冒充 Router 本人拍的）。
    · **--ask <askId>（2026-11-03 · YB2-R1）**：槽位多一个 6 字符「愿景指针」，指向该线「愿景-<线>.json」里某条 ask 的 id。
        - 行格式：「- <YYYY-MM-DD>｜<线名>｜<结论>｜ask=<askId>｜ref：<…>」；
        - **≤6 字符**；空串或「-」⇒ 存 null（**行里一个字符都不加，与改前逐字相同**）；超 6 字符 ⇒ rc=2 拒收、不写盘；
        - --replace 也认 ask：**没给 --ask ⇒ 继承旧行那一格**（不许替换一次就把字段丢了）；要清空写 --ask -；
          --json 输出多一个 ask 字段。
    · **--dir <path>（2026-11-03）**：换结论档目录（默认 <workspace>/docs/年轮）。
        🔴 **只给夹具/演练用** —— 生产别带：带了就不会写进正式件 router-YYYYMM.md。

── digest --auto 细节（2026-11-05 · 年轮判据 A-3 · 零模型）──────────────────────
  node router-act.mjs digest --auto [--date YYYY-MM-DD] [--apply] [--json] [--dir <path>]
    干什么：把**每条「有活的主线」**各写一行结论进结论档（docs/年轮/router-<YYYYMM>.md）。
    · 输入口径 = 与 brief 车况**同一套**（aggregate + activeCount>0），不另造一套；
    · 每行内容 = 该线**最近一张 done 卡**的标题（截断 ≤120 显示宽）+ 卡 id 作 ref；
      没有 done 卡的线**不编结论**：退化成「该线最近一张卡 + 它的状态词」（在跑/待验收/排队/失败）；
    · 幂等 = 既有幂等键（**线名 + 日期**）⇒ 同一天同一条线重复跑零新增行（前后 sha 相同）；
    · 上限 = 既有槽位口径（**≤16 行** · 每行 ≤120 显示宽）：满 16 行时逐条打印「哪几条线今天没写」，
      并把被挤出 16 行窗口的旧结论列出来（**仍在结论档里，没删**）⇒ 不悄悄截断掉线；
    · 🔴 **零模型调用**：没有任何 LLM / 外部网络请求；取数只用既有的本机看板 GET（brief 同一条）。
    · 抢锁：router-digest（lib/butler-locks.mjs 登记）—— 手工跑与 tickd 每日 job 并发时后来者让路（rc 0）。
    · 默认 dry-run（打印"将要写哪几行"）；--apply 才写。**tickd job id = router-digest（每天 22:10）**。

── brief --gaps 细节（2026-11-03 · YB2-R2 · 愿景差距）──────────────────────
  node router-act.mjs brief [--gaps] [--json]
    · **不带 --gaps、不带 --json ⇒ 严格三行、逐字不变**（人读硬上限 3 行不许破）。
    · --gaps ⇒ 三行之后追加：
        愿景差距（Top-3）：
        · <线名>｜差：<该线排名第一的 ask 文本，截 40 字>（<askId> · <A|B|C>）｜活动 <N> 天前｜上次收口 <YYYY-MM-DD>
      排序公式（报告 §3.4，写死可复现）：
        score = 3×C类ask数 + 2×(在途卡数>0) + 0.5×min(活动天数,7) − 0.2×A类ask数 + 5×(命中 ownerPriority)
    · **A 类不推**：kind=blocked-by-owner 的线渲染成「等主人：…」（只上桌）；只有整条线只剩 A 时它才排第一。
    · 数据源 = docs/年轮/*.json 里带 asks[] 的愿景件（capability.json 不是愿景件，不参与）；
      坏 json / 缺字段只报黄、不炸 brief。
    · **第 3 行「要你定」口径（2026-11-05 · 年轮判据 A-1）**：明细**≤3 条**，超出折叠成计数；
      排序 = 真等主人拍的（attentions 未答）在前 → 待验收的卡（status=review）其次，同档等得最久的先摆；
      🔴 **执行失败卡不当主项**（「执行失败（failed）」那种 disposition attention 只进折叠计数：失败卡 N 件机器自管）。
    · **--json 恒带**：visionGaps[]（Top-3）、visionGapsAll（完整排序）、visionGapsNote（无数据/被截断的原因）；
      另有 needsOwner{asks,reviewCards,failedAttentions,shownMax,line}（只加键，老键一个不动）。

── reset 细节（R1-7 · 重置）────────────────────────────────────────────────
  node router-act.mjs reset [--apply] [--json]
    干什么：① 从结论档里取「每条线最新一行」拼出当前槽位（上限 16 行）
            ② 现读 ~/.dsh/steward-state.json 的 attentions（未答的）当「待主人拍的事」
            ③ 渲染一段「接续头」（槽位 + 待拍板 + 怎么继续）→ --apply 时写进结论档
            ④ 把这段接续头打到 stdout，主人可以直接贴给下一次的自己
    🔴 **它不清空任何东西**：不调 session.compact、不删会话、不归档、不发任何会话 RPC。
       清空上下文**不用人管**：到阈值由宿主 compaction-basic 自动原地压（阈值真源 = cordis.patch.yml 的 thresholdRatio，2026-11-05 现为 0.20；压完按 retainRatio 留尾巴）。
    · **同一天只留一段接续头**（2026-11-03 改）：当天已有段 ⇒ 整段替换（历史遗留的多段一起收敛成一段），
      别的天一个字节都不动；写盘同 --replace（同目录 tmp + rename）。
    · 全程**不联网**（只用本地文件）⇒ dsh 起不来也能收口。
    · 默认 dry-run；段头带时间戳，人可辨先后。

── inflight 细节（2026-11-05 · 卡「Router上手活抗压缩」）────────────────────────
  node router-act.mjs inflight set --text "<一句话：在写什么、做到哪、下一步>"
  node router-act.mjs inflight show
  node router-act.mjs inflight clear
    · 档 = ~/.dsh/router-inflight.json（DSH_HOME 优先）· **写路径固定**，不接受命令行传路径
      （免得本件变成通用写盘口）；ROUTER_INFLIGHT_FILE 只是夹具钩子，生产别设。
    · set 原子写（同目录 .tmp → rename）：崩在中间不会留半份；text 多行压成「 ⏎ 」存一行。
    · clear 幂等（本来就清、或本来没有，都 rc 0）；show 只读。
    · 为什么有用：宿主压缩按 token 水位自动触发、**不看手上有没有未落盘的活**；这段挂在系统提示里
      （dsh-feiyu-mood 的槽位 section，每轮现算、**不进历史**）⇒ 压完照样看得见。
    · 显示口径：整段显示宽 ≤300，超出截断补「…」；**没有 / 空 / JSON 坏 ⇒ 槽位输出与不加这段时逐字相同**。

── 滚动记忆口径（方案 §D6）────────────────────────────────────────────────
  主 Router 上下文里**对每条子线只留 1 行**：「线名｜一句话现状｜日期」，上限 **16 行 · 每行 ≤60 汉字（显示宽 ≤120）**。
  那 16 行只是「上次收口的结论」，**不是活数据** —— 车况每次现跑 brief 现取，别拿旧行当现状。
  这 16 行**每轮由插件自动注入**（dsh-feiyu-mood 的「槽位注入」现读结论档，进系统提示、不进历史）。
  结论档**按月开档、月内不轮转**（router-<YYYYMM>.md）；读的时候读全部月份档 ⇒ 跨月那几天不会掉线。

── 动作流水 ────────────────────────────────────────────────────────────────
  每跑一次 say / wake / digest / reset（含 dry-run、含失败）追加一行到 ~/.dsh/router-ops.jsonl：
    {"at":"<ISO>","verb":"say|wake","target":"…","sid":"…|null","ok":true,"source":"router-act","dryRun":true,"decidedBy":"router|owner|plugin","id":"<短号>","format":"envelope|raw|free"}
    · decidedBy = 谁拍的：router = 你自决的小决定（默认）/ owner = 主人定的或主人派下来的 / plugin = 插件或机器写的。
    · digest --replace 另加两个顶层键：oldText（被换掉的那一整行，≤200 字）、rollId（--run-id 的批次号）。
    · 老行没有这个键 ⇒ 就是 R1-2d 之前的行，不重写、不补写。
  只增不改。写失败 ⇒ 告警 + rc≠0，但**不撤销已经真投出去的话**。
  🔴 不写 ~/.dsh/steward-disposition.jsonl（那是 C12-D 的六值封闭词表，Router 的 say 没有 cardId）。`;

/** brief：三行摘要，数据源与 status 完全同一套（`--gaps` 才追加「愿景差距」；`--json` 恒带 visionGaps[]） */
async function cmdBrief(argv) {
  const asJson = argv.includes('--json');
  const withGaps = argv.includes('--gaps');
  const [board, threadLine, attn] = await Promise.all([
    fetchBoard(),
    Promise.resolve(readThreadLineMap()),
    Promise.resolve(readAttentions()),
  ]);
  const threadsJson = readJson(THREADS_FILE)?.threads ?? [];
  const rows = aggregate(board.tasks ?? [], threadLine, threadsJson);
  const lineOfCard = lineOfCardMap(board.tasks ?? [], threadLine);
  // ⚠️ 缺省（既没 --gaps 也没 --json）**不算**这一段：老调用方零感知、三行逐字不变
  const gapInfo = (asJson || withGaps) ? buildVisionGaps({ dir: DIGEST_DIR, rows, now: Date.now() }) : null;
  if (!asJson) {
    let out = renderBrief(board, rows, attn, lineOfCard);
    if (withGaps) out += `\n${renderVisionGaps(gapInfo.gaps, { note: gapInfo.note })}`;
    process.stdout.write(`${out}\n`);
    return 0;
  }
  const focus = pickFocus(rows, attn.open, lineOfCard);
  const active = rows.filter((r) => activeCount(r) > 0);
  // A-1（2026-11-05）：拆成「真等主人拍 / 待验收 / 失败卡」三堆 —— **只加键，老键一个不动**（有消费者）
  const parts = partitionBriefAttn({ open: attn.open, tasks: board.tasks ?? [] });
  const titleById = new Map((board.tasks ?? []).map((t) => [String(t?.id ?? ''), String(t?.title ?? '')]));
  process.stdout.write(JSON.stringify({
    at: new Date().toISOString(),
    lines: active.length,
    totals: active.reduce(
      (acc, r) => ({ run: acc.run + r.run, todo: acc.todo + r.todo, review: acc.review + r.review, failed: acc.failed + r.failed }),
      { run: 0, todo: 0, review: 0, failed: 0 },
    ),
    attention: attn.open.length,
    focus: focus ? { line: focus.line, why: focus.why, tier: focus.tier, lastAt: focus.lastAt || null } : null,
    open: attn.open.slice(0, 10).map((a) => ({ cardId: a.cardId ?? null, question: a.question ?? '' })),
    needsOwner: {
      shownMax: BRIEF_ASK_MAX,
      asks: parts.asks.map((a) => ({ cardId: a.cardId ?? null, question: a.question ?? '', askedAt: a.askedAt ?? null, label: clipW(attentionLabel(a, titleById), 60) })),
      reviewCards: parts.reviews.map((r) => ({ cardId: r.cardId, title: r.title, updatedAt: r.at })),
      failedAttentions: { count: parts.failed.length, cardIds: parts.failed.map((a) => a.cardId ?? null) },
      // 2026-11-05 卡「attentions 陈旧账兜底销账」：卡已归档/完成/不在板的老 attention（**只加键，老键一个不动**）
      staleAttentions: {
        count: attn.staleCount ?? 0,
        cardIds: (attn.stale ?? []).map((a) => a.cardId ?? null),
        checked: attn.ledgerChecked !== false,   // false = 账本没核成（fail-open），stale 一件都没销
      },
      line: renderNeedsOwner(board, attn),
    },
    // YB2-R2：Top-3（= 渲染出去的那三条）与完整排序都带上，别让 JSON 丢信息
    visionGaps: gapInfo.gaps.slice(0, VISION_GAP_TOP),
    visionGapsAll: gapInfo.gaps,
    visionGapsNote: gapInfo.note,
  }, null, 2) + '\n');
  return 0;
}

async function cmdStatus(argv) {
  const asJson = argv.includes('--json');
  const mi = argv.indexOf('--max-lines');
  let maxLines = 20;
  if (mi >= 0) {
    const n = Number(argv[mi + 1]);
    if (Number.isFinite(n) && n >= 5) maxLines = Math.floor(n);
  }

  const [board, threadLine, attn] = await Promise.all([
    fetchBoard(),
    Promise.resolve(readThreadLineMap()),
    Promise.resolve(readAttentions()),
  ]);
  const threadsJson = readJson(THREADS_FILE)?.threads ?? [];
  const rows = aggregate(board.tasks ?? [], threadLine, threadsJson);

  process.stdout.write(asJson ? renderJson(board, rows, attn) + '\n' : renderHuman(board, rows, attn, maxLines) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  if (!verb || verb === '--help' || verb === '-h') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (verb === 'status') return (await cmdStatus(argv)) ?? 0;
  if (verb === 'brief') return (await cmdBrief(argv)) ?? 0;
  if (verb === 'say') return await cmdSay(argv);
  if (verb === 'wake') return await cmdWake(argv);
  if (verb === 'card-show') return await cmdCardShow(argv);
  if (verb === 'digest') return await cmdDigest(argv);
  if (verb === 'reset') return await cmdReset(argv);
  if (verb === 'inflight') return await cmdInflight(argv);
  if (verb === 'inbox') return await cmdInbox(argv);
  process.stderr.write(`未知动词：${verb}\n\n${USAGE}\n`);
  return 2;
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
  main().then((rc) => { process.exitCode = rc ?? 0; }).catch((e) => {
    process.stderr.write(`✗ ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}

export {
  aggregate, bucketOf, openAttentions, renderHuman, renderJson, renderBrief,
  lineOfCardMap, pickFocus, fetchBoard, readAttentions, readThreadLineMap,
  VERSION, OPS_FILE, INFLIGHT_FILE,
};
// YB2-R1/R2（2026-11-03）新增的可测件**都用行内 `export` 导出**（别在这里再列一遍 ⇒ 会 Duplicate export）：
//   parseDigestLine / readSlots / renderResumeHead / computeVisionGaps / renderVisionGaps /
//   buildVisionGaps / ownerPriorityHit / readOwnerPriorityItems / VISION_GAP_TOP
