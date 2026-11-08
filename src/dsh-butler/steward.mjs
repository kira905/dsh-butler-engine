#!/usr/bin/env node
/**
 * steward.mjs —— 掌柜（协调线）的「脑子」· **甲层**（纯 Node 批处理，零模型调用）
 *
 * 真源：`docs/`（内容已到 v0.5；文件名还挂 v0.1，如实登记）
 *   §1.1 脑拆两层：本件 = 甲层（取数 / 排序 / 算收敛线 / 写流水账，**不花一个 token**）；
 *       乙层（生成「背景 / 选项 / 建议 / 代价」四段文字）= 下一张卡，**本件不接任何模型调用**。
 *   §2.0 不新造任何一份真相：本件的全部输入 = 现成的五件
 *         `standup.mjs`（资源账·晨报）/ `progress-status.mjs`（愿景）/ `stall-nudge.mjs`（停滞）
 *         / `said-ledger.mjs`（原话账）/ 看板 `line`（线谱）+ `docs/`（人写的年轮快照）。
 *   §4.1 排序四条：① failed 优先 ② ageDays 倒序 ③ 可恢复性（description grep `_archive\` / 「回滚」）
 *        ④ 卡 id 字典序。**「解锁价值」无源 ⇒ 输出 `unlockValue: unknown`，不许猜。**
 *   §4.1 规则 4 **口径一处**：`ageDays` 只许在 `standup.mjs` 里算一次 —— 本件**不自己算**，
 *        而是 `spawn` 跑 `standup.mjs --json` 把它的读数原样端过来。
 *   §6 判据 1 两条线分开报：**上桌线**（≤3 件）与**收敛线**（在途待拍板总数 = `totals.pendingDecision`）。
 *        收敛线**必须与 standup 同源**，红了不许装绿。
 *   §4.3③ 自举：本线（协调线 · 判据）自己的卡与能力账自指项**一律排除并计数**，输出明写。
 *   §2.3 硬规矩：state 文件六必填字段（登记在 `lib\state-files.mjs`）/ 写盘走 `store.writeTextAtomic`
 *        / 每 job 一把锁（登记在 `lib\butler-locks.mjs`）/ 幂等键 `sha16(卡id|动作|日期)`。
 *   §4.4 / §1.7.3（B1 订正）**并行可行性**：新增 `report.collision` —— 判据**在甲层内部用 `cards` Map 的
 *        卡面全文**算（`report.raised[]` 只带元数据、**没有 description**，乙层根本拿不到卡面 ⇒ 判法必须落在这里）。
 *        三件一起做：①否定式排除（命中词**前 6 字内**出现 不/无/需/勿/别/免/禁 ⇒ 不算命中；否则"不重启 dsh"
 *        这种全被判成独占）②收紧为**动作式短语**（`重启 dsh` / `改 persona` / `改启动链` / `改 guard`，
 *        不是光秃秃的名词）③输出 `hitRate`（独占+互斥 占参与判定的比例），**>30% 报黄**（说明判据在退化）。
 *   §4.5（含 02:2x 实现注）**在跑的会话**：新增 `report.sessions` —— 只读 `session.list` 的
 *        `projections.values.title` + `running` + `updatedAt` + `blank`；🔴 不读会话正文、不解 zstd、
 *        不 fs.stat；本线（标题含「统筹 / 掌柜」）排除并计数；拿不到就 fail-open（`ok:false` + 报黄，**不许崩**）。
 *   §1.7.1 **`report.cardText`**：每卡 `{title, desc400}`（description 去掉 DoR/DoD 标记块与 HTML 注释、
 *        截 600 字），只输出**已有的卡面原文**，不总结、不调模型（乙层写「背景」用）。
 *   §1.7.4 第一行（**C8 · 2026-11-02**）「乙层接进 08:20」：tickd job `steward` 跑完甲层**之后**，
 *        **同进程接着跑乙层**（不新增第二个 job —— 一次唤醒干完，少一个调度面）。
 *        落地口径 = 甲层成功收尾（写完 state + 打完 stdout + **释放 tick 锁**）后，`spawnSync` 一次
 *        `node steward-advice.mjs --apply`：`timeout = 60 s`（超时杀子进程，只记一行警告）·
 *        **fail-open**（乙层任何失败都只写 `state.lastAdviceHook` + stdout 一行，甲层照旧 rc=0）·
 *        总开关 `env STEWARD_ADVICE_HOOK=off`（或 `state.adviceHook.enabled=false`）。
 *        🔴 **必须锁外 spawn**：乙层 `persist()` 抢的是**同一把** `steward` 锁（advice L1013），
 *        持锁 spawn 会让乙层"模型调完却写不进账"（C5 的钱-账红线）。
 *        🔴 本件仍**零模型调用**：模型只在 `steward-advice.mjs` 里，这里只负责 spawn。
 *        非每日跑路径（`--json` / `--no-write` / `--selftest` / `--broadcast` / `--help` / `--attention-*`）
 *        **一律不触发**。
 *
 *   §3 第 1 条（**C10 · 2026-11-02**）**Attention 结构化**：
 *        真源 `docs/` §3 第 1 条 —— 「等人工决定」不许靠扫卡面文本。
 *        ① `state.attentions[]` = `{cardId, question, options[], askedAt, answeredAt}`（口径实现在 `lib\attentions.mjs`）；
 *        ② 写入口 `--attention-add / --attention-answer / --attention-list`（幂等：同 cardId 不产生重复条目）；
 *        ③ 晨报读数（`standup.mjs`）只从**未答** attentions 取数；卡面文本一个字节都不参与统计；
 *        ④ `mergeState` 的写死段清单必须显式带 `attentions`（B2 教训：不在清单里就会被次日 08:20 静默抹掉）。
 *        🔴 不碰看板 schema / 不追补存量卡 / 不给存量卡批量打标记（卡 C10 三条红线）。
 *
 *   §A-3 / §A-4（**C12-D · 2026-11-02**）**Disposition 行流（每条东西的去向）+ 两值副作用**：
 *        真源 `docs/` —— A-3「六值带副作用，先只做 blocked/failed」/
 *        A-4「原型是一张**每 trigger 一行**的表，同时回答『为什么没处理』『到了哪些卡』『一生』」。
 *        ① 行流 `~\.dsh\steward-disposition.jsonl`，每行 `{at, kind, cardId?, reason, detail?, runId}`，
 *           `kind` ∈ `evaluated / filtered / ignored / fanned-out / blocked / failed`（口径实现在
 *           `lib\disposition.mjs`）；`fanned-out` 只留词表位置，本件**不产生**（属于 C12-B 扇出段）。
 *        ② **接进甲层收尾**：每日真跑把这一屏「上桌的 / 排不上的 / 被挡下的 / failed 的」**各写一行**；
 *           **只增不改**（单次 appendFileSync，本件与 lib 里都没有清空 / 截断入口）。
 *        ③ **两值副作用**：`failed`（看板状态）/ `blocked`（执行会话报）⇒ 自动登记 `attentions[]`（C10 的
 *           `addAttention` 幂等；未答的**不再重复写**，已答的按"重新开问"处理 —— 卡还坏着就还得有人管）。
 *        ④ 副作用**必须在锁外跑**：`attentionAddEntry` 抢的是**同一把** `steward` 锁（与 C8 乙层同款理由）。
 *        ⑤ 非每日路径（`--json` / `--no-write` / `--selftest` / `--broadcast` / `--help` /
 *           `--attention-*` / `--disposition-*`）一律 0 行写入（判据做成纯函数 `dispositionGate`）。
 *        🔴 不碰看板 schema / 不碰 `host-runner.ts` / **不改 `attentions[]` 字段语义**（卡 C12-D 三条红线）。
 *
 * 🔴 本件**默认不做什么**（方案 §3.1 / §5，写死）：
 *   不叫停、不砍线、不重派（只能出"建议 + 依据"）· 不建卡 · 不验收卡 · 不动看板（只读 GET）
 *   · 不读任何主线的会话上下文（C6 起只读会话**标题**与 `updatedAt`，不读正文 —— 方案 §4.5 边界）
 *   · 不重启 dsh · 不碰对端机器 · 不跨机同步 · **不投给真人**
 * ⚠️ **唯一的"会发话"例外 = C7 的 `--broadcast`**（2026-11-02 · 卡「甲层C7」· 方案 §4.5.1 + §1.3）：
 *    它**会**经 `session-say.mjs` 给主线会话投一句话，但①只投 DSH 会话（`notify_external` 永不）②过判活三查才投
 *    ③逐条留回执 + 落 `instructions[]`④**默认干跑，`--apply` 才真投**。
 *    其余路径（甲层日报）照旧只登记 `status:'suggested'` 的建议（`channel:'none'`），一个字节都不发。
 *
 * 用法：
 *   node tools\dsh-butler\steward.mjs                  # 一屏人话 + 写 state（tickd job 的日常跑法）
 *   node tools\dsh-butler\steward.mjs --json           # 机读（含 collision / cardText / sessions 三段）
 *   node tools\dsh-butler\steward.mjs --no-write       # 只读不写（排障 / 验收）
 *   node tools\dsh-butler\steward.mjs --top N          # 上桌几件（默认 3，方案 §6 判据 1）
 *   node tools\dsh-butler\steward.mjs --stale-days N   # 超期门槛（默认 3，与 standup 默认对齐）
 *   node tools\dsh-butler\steward.mjs --selftest       # 全部夹具（含"改坏必须红"的双向验证）
 *   node tools\dsh-butler\steward.mjs --broadcast <file|->          # 广播一条结论（**默认干跑**：只列会投给谁 / 挡了谁）
 *   node tools\dsh-butler\steward.mjs --broadcast <file|-> --apply  # 真投 + 逐条落账（instructions[] 30 天窗口）
 *       广播可选：--min-age-days N（默认 3）· --max N（默认 9）· --include-cards · --json
 *                 · --only sid1,sid2（在**合格集合里**再收窄：救火单投 / 验收实测；**不能**绕过判活）
 *   node tools\dsh-butler\steward.mjs --attention-add --card <id> --question "<一句话>" [--option "<选项>"]*
 *       登记一条「等主人决定」（幂等：同 cardId 重复登记不产生重复条目、askedAt 保留）
 *   node tools\dsh-butler\steward.mjs --attention-answer --card <id>   # 销账（写 answeredAt，晨报 N 立刻 -1）
 *   node tools\dsh-butler\steward.mjs --attention-list [--json]        # 只读列出（未答 / 已答分开数）
 *   node tools\dsh-butler\steward.mjs --disposition-list [--tail N] [--json]   # 只读看最近 N 条去向（默认 20）
 *   node tools\dsh-butler\steward.mjs --disposition-add --kind blocked|failed --card <id> --reason <原因码>
 *        [--detail "<一句话>"] [--title "<卡标题>"]   # 执行会话报 blocked / 手工补一条去向（会顺手登记 Attention）
 *
 * 退出码：0=正常（含"锁被占"跳过 / 干跑 / 无可投）· 1=广播有投不出去的（失败可见，不许静默）
 *         · 2=selftest 有夹具没鉴别力 或 用法错 · 3=硬输入读不到（账本 / 晨报 / 广播正文 / session.list）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from './lib/store.mjs';
import { acquireTickLock } from './lib/store.mjs';
import { dshHome } from './lib/paths.mjs';
import { hostRpc } from '../lib/dsh-host-rpc.mjs';
import {
  ATTENTIONS_FIELD, ATTENTION_STATE_FILE, normalizeAttentions, unattendedAttentions,
  addAttention, answerAttention, readAttentionState,
} from './lib/attentions.mjs';
import {
  DISPOSITION_FILE, DISPOSITION_KINDS, SIDE_EFFECT_KINDS, REASON_CODES, isSideEffectKind,
  buildDispositions, buildRow, validateRow, appendRows, readRows, summarizeRows, titlesOf, attentionRequestFor,
} from './lib/disposition.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const DSH = path.resolve(HERE, '..', '..');

export const STEWARD_VERSION = '1.5.0';
export const STEWARD_STATE_FILE = ATTENTION_STATE_FILE;
/** 行流文件名（C12-D；`lib\disposition.mjs` 独立定义同值，避免循环 import）。 */
export const DISPOSITION_STATE_FILE = DISPOSITION_FILE;
export const SCHEMA_VERSION = 1;

/** 本线自己的 line 名（方案 §4.3③ 自举排除的对象）。看板上现取值 = `协调线 · 判据`。 */
const SELF_LINE = '协调线 · 判据';
/** 排除判据：`line` 去掉空白后以「协调线」开头（覆盖 `协调线 · 判据` / 将来可能的 `协调线 · 嘴`）。 */
export const isSelfLine = (line) => String(line ?? '').replace(/\s+/g, '').startsWith('协调线');

/** 方案 §4.2 生命周期：卡进 running / done（含 archived）⇒ 该待拍板项自动失效，本件只**判定不改卡**。 */
export const DEAD_STATUSES = new Set(['done', 'archived', 'running']);

/** 方案 §4.1 规则 ③ 可恢复性：description 里能 grep 到回滚点的近似判据（会漏，故只作同顺位加分）。 */
export const recoverableOf = (desc) => /_archive\\(?!\*)|回滚/.test(String(desc ?? ''));

/** 人工维护的年轮档：mtime 超过这个天数 ⇒ 标 unknown + 报黄，不许当读数用（方案 §6 判据 4 没源半）。 */
export const CAPABILITY_MAX_AGE_DAYS = 7;
/** 心跳 / 上桌计数只留 30 天（方案 §2.3 retention）。 */
export const HEARTBEAT_KEEP_DAYS = 30;

// ── C8（方案 §1.7.4 第一行「乙层接进 08:20」）：hook 三个常量 ────────────────────────
/** 乙层（steward-advice.mjs）单次上限。tickd `steward` 总预算 180 s、甲层基线 ≈5.2 s ⇒ 60 s 富余 ~2×。 */
export const ADVICE_HOOK_TIMEOUT_MS = 60_000;
/** 乙层脚本名（与本件同目录）。 */
export const ADVICE_SCRIPT_FILE = 'steward-advice.mjs';
/** 总开关的 env 名：留空/缺省=开；`off` / `0` / `false` / `no` = 关。 */
export const ADVICE_HOOK_ENV = 'STEWARD_ADVICE_HOOK';

// ── C12-D：disposition 行流（甲层收尾追加写）──────────────────────────────────────
/** 总开关的 env 名：留空/缺省=写；`off` / `0` / `false` / `no` = 不写（行流出问题时的逃生口）。 */
export const DISPOSITION_ENV = 'STEWARD_DISPOSITION';
/** `--disposition-list` 默认回看条数。 */
export const DISPOSITION_TAIL_DEFAULT = 20;

// ---------------------------------------------------------------- 小工具

const sha16 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
const ymd = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const hostName = () => process.env.COMPUTERNAME || 'unknown';
const DAY_MS = 864e5;

/** 纯函数：方案 §4.1 四条排序（稳定、可重放 —— 第四条是 id 字典序，不是"重要度"）。 */
export function compareItems(a, b) {
  const fa = a.status === 'failed' ? 0 : 1;
  const fb = b.status === 'failed' ? 0 : 1;
  if (fa !== fb) return fa - fb;                                   // ① failed 优先
  const aa = Number.isFinite(a.ageDays) ? a.ageDays : -1;
  const bb = Number.isFinite(b.ageDays) ? b.ageDays : -1;
  if (aa !== bb) return bb - aa;                                    // ② 阻塞时长倒序（unknown 排最后）
  const ra = a.recoverable ? 0 : 1;
  const rb = b.recoverable ? 0 : 1;
  if (ra !== rb) return ra - rb;                                    // ③ 能回滚的排前面
  const sa = String(a.id);
  const sb = String(b.id);
  return sa < sb ? -1 : sa > sb ? 1 : 0;                            // ④ id 字典序
}

/** 为什么它排在这儿 —— 给人读的依据串，**不许写"我觉得"**。 */
export function rationaleOf(item, allCount) {
  const bits = [];
  bits.push(item.status === 'failed' ? '①跑崩了（failed 优先）' : '①不是 failed（排在 failed 之后）');
  bits.push(item.ageDays === null ? '②阻塞时长 unknown（读不到 updatedAt）' : `②躺了 ${item.ageDays} 天`);
  bits.push(item.recoverable ? '③description 里有回滚点（敢推）' : '③没有回滚点迹象（推了要担风险）');
  bits.push('④同顺位按 id 字典序（可重放，不是"重要度"）');
  if (allCount <= 1) bits.push('（候选只有它 1 件）');
  return bits.join(' · ');
}

// ---------------------------------------------------------------- 取数（IO，全部只读）

/**
 * 跑 standup.mjs --json 拿晨报读数（**ageDays / pendingDecision 的唯一权威源**）。
 * ⚠️ 为什么要 spawn 而不是自己重算：方案 §4.1 规则 4 —— 同一件事只许一个读数，
 *    自己再写一份 ageDays 就是"第二份真源"（§2.1 明令禁止）。
 * @returns {{ok:boolean, data?:object, error?:string, ms?:number}}
 */
export function runStandup({ top = 100000, staleDays = 3, timeoutMs = 120_000 } = {}) {
  const standupPath = path.join(HERE, 'standup.mjs');
  if (!fs.existsSync(standupPath)) return { ok: false, error: `standup.mjs 不存在：${standupPath}` };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [standupPath, '--json', '--top', String(top), '--stale-days', String(staleDays)], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DSH_STEWARD_CHILD: '1' },
  });
  const ms = Date.now() - t0;
  if (r.error) return { ok: false, error: `spawn 失败：${r.error.message}`, ms };
  if (r.status !== 0) return { ok: false, error: `standup 退出码 ${r.status}：${String(r.stderr || r.stdout || '').trim().slice(0, 400)}`, ms };
  try {
    const data = JSON.parse(r.stdout);
    return { ok: true, data, ms };
  } catch (e) {
    return { ok: false, error: `standup 输出不是合法 JSON：${e.message}`, ms };
  }
}

/**
 * 看板卡面。优先 `GET /api/task-board/state`（卡面要求），失败回落账本文件并**报黄**（fail-open，不静默当空）。
 * ⚠️ 只取 `description/title/line/status` 用于 grep 与自线判定，**不取任何时间字段做计算**
 *    （`ageDays` 一律来自 standup）。
 * @returns {{ok:boolean, source:'api'|'file'|'none', byId:Map<string,object>, count:number, revision:number|null, error:string|null}}
 */
export async function loadCards({ home = dshHome(), httpTimeoutMs = 8000 } = {}) {
  const byId = new Map();
  const absorb = (arr) => {
    for (const t of arr) if (t && t.id) byId.set(String(t.id), t);
    return byId.size;
  };
  // ① HTTP（卡面要求的读法）
  try {
    const url = (process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '') + '/api/task-board/state';
    const res = await fetch(url, {
      headers: { origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin', accept: 'application/json' },
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const state = j && typeof j === 'object' && (j.tasks || j.state) ? (j.state ?? j) : null;
    if (!state || !Array.isArray(state.tasks)) throw new Error('返回体里没有 tasks[]');
    const n = absorb(state.tasks);
    return { ok: true, source: 'api', byId, count: n, revision: Number.isFinite(state.revision) ? state.revision : null, error: null };
  } catch (e) {
    const apiErr = e && e.message ? e.message : String(e);
    // ② 回落账本文件（standup 也是读它；这里只拿文本，不碰时间维）
    const ledgerPath = path.join(home, 'task-board', 'ledger-v2.json');
    try {
      const j = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const n = absorb(Array.isArray(j.tasks) ? j.tasks : []);
      return { ok: true, source: 'file', byId, count: n, revision: Number.isFinite(j.revision) ? j.revision : null,
        error: `API 读不到（${apiErr}）⇒ 已回落账本文件 ${ledgerPath}` };
    } catch (e2) {
      return { ok: false, source: 'none', byId, count: 0, revision: null,
        error: `API 读不到（${apiErr}）且账本也读不到（${e2 && e2.message}）` };
    }
  }
}

/**
 * 读一份年轮 json（**人写的**，见方案 §2.1 订正）。三种坏输入都必须不抛：
 * 缺失 / 坏 JSON / 字段缺 —— 交给调用方标 yellow（fail-open，不静默当空）。
 * @returns {{ok:boolean, data:object|null, mtimeMs:number|null, mtimeIso:string|null, error:string|null}}
 */
export function loadYearring(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return { ok: false, data: null, mtimeMs: null, mtimeIso: null, error: e && e.code === 'ENOENT' ? '文件不存在' : `stat 失败：${e && e.message}` };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, data: null, mtimeMs: st.mtimeMs, mtimeIso: new Date(st.mtimeMs).toISOString(), error: `读不到：${e && e.message}` };
  }
  if (!raw.trim()) return { ok: false, data: null, mtimeMs: st.mtimeMs, mtimeIso: new Date(st.mtimeMs).toISOString(), error: '文件是空的' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, data: null, mtimeMs: st.mtimeMs, mtimeIso: new Date(st.mtimeMs).toISOString(), error: `坏 JSON：${e && e.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, data: null, mtimeMs: st.mtimeMs, mtimeIso: new Date(st.mtimeMs).toISOString(), error: '顶层不是对象' };
  }
  return { ok: true, data, mtimeMs: st.mtimeMs, mtimeIso: new Date(st.mtimeMs).toISOString(), error: null };
}

/**
 * 能力账摘要（方案 §6 判据 4 没源半 · §4.3③ 自指排除）。
 * 铁律：**人工档即使新鲜也只报「读到 N 条人工登记，未自动核」，不计绿**；mtime > 7 天 ⇒ unknown + 黄。
 */
export function summarizeCapability(cap, { now = Date.now(), maxAgeDays = CAPABILITY_MAX_AGE_DAYS, isSelf = isSelfLine } = {}) {
  const out = { source: 'docs/', ok: false, fresh: false, status: 'unknown', items: [], excludedSelf: 0, ageDays: null, mtimeIso: null, note: '' };
  if (!cap) { out.note = '没传输入'; return out; }
  out.mtimeIso = cap.mtimeIso ?? null;
  if (cap.mtimeMs !== null && cap.mtimeMs !== undefined) out.ageDays = Math.floor((now - cap.mtimeMs) / DAY_MS);
  if (!cap.ok) {
    out.note = `读不到（${cap.error}）⇒ 这一半标 unknown，不许当读数`;
    return out;
  }
  const all = Array.isArray(cap.data?.capabilities) ? cap.data.capabilities : null;
  if (!all) {
    out.note = '字段缺：没有 capabilities[] 数组 ⇒ 标 unknown，不许当空';
    return out;
  }
  const fresh = out.ageDays !== null && out.ageDays <= maxAgeDays;
  out.ok = true;
  out.fresh = fresh;
  const self = all.filter((x) => isSelf(x?.from) || isSelf(x?.to));
  out.excludedSelf = self.length;
  out.items = all.filter((x) => !(isSelf(x?.from) || isSelf(x?.to)));
  out.status = fresh ? 'manual-unverified' : 'unknown';
  out.note = fresh
    ? `人工维护档（${out.ageDays} 天前改过）⇒ **读到 ${out.items.length} 条人工登记，未自动核**，不计绿`
    : `人工维护档已 ${out.ageDays} 天没改（>${maxAgeDays}）⇒ 标 unknown 报黄，不许当读数`;
  return out;
}

/** 愿景年轮（`docs/`）：只读它自己的 `asks[]`，坏输入报黄（fail-open）。 */
export function summarizeVision(vr) {
  const out = { source: 'docs/', ok: false, asks: [], mtimeIso: null, note: '' };
  if (!vr) { out.note = '没传输入'; return out; }
  out.mtimeIso = vr.mtimeIso ?? null;
  if (!vr.ok) { out.note = `读不到（${vr.error}）⇒ 报黄，不静默当空`; return out; }
  const asks = Array.isArray(vr.data?.asks) ? vr.data.asks : null;
  if (!asks) { out.note = '字段缺：没有 asks[] 数组 ⇒ 报黄'; return out; }
  out.ok = true;
  out.asks = asks;
  out.note = `读到 ${asks.length} 条 asks`;
  return out;
}

// ---------------------------------------------------------------- 并行可行性（方案 §4.4 / §1.7.3 B1 订正）

/**
 * 判据产出的四个值（方案 §4.4 表 + §1.7.3）。
 * 🔴 判法只能在**甲层内部**做：`report.raised[]` 只带元数据、**没有 description**，
 *    乙层拿不到卡面全文 ⇒ 这里用 `cards` Map 的全文判，结论写进 `report.collision[]` 给乙层读。
 */
export const COLLISION_VERDICTS = Object.freeze({ ALONE: '独占', MUTEX: '互斥', PARALLEL: '可并行', MANUAL: '待人工判' });
/** 命中率黄线（方案 §1.7.3：高于 30% ⇒ 判据区分度低，别当结论）。 */
export const COLLISION_HITRATE_YELLOW = 0.3;
/** 否定式排除窗口：命中词**前 6 个字**内出现这些字 ⇒ 不算命中（否则「不重启 dsh」全被判成独占）。 */
export const COLLISION_NEG_WINDOW = 6;
export const COLLISION_NEG_RE = /[不无需勿别免禁]/;

/** 动作式短语（收紧后，不是光秃秃的名词 —— 方案 §1.7.3 第 2 件）。 */
export const COLLISION_EXCLUSIVE_PATTERNS = [
  /重启\s*dsh/gi,
  /(?:改|修改|动|更新|换)\s*(?:一下\s*)?persona/gi,
  /(?:改|修改|动|更新)\s*(?:一下\s*)?启动链/g,
  /(?:改|修改|动|更新)\s*(?:一下\s*)?guard/gi,
];
export const COLLISION_PARALLEL_PATTERNS = [/只读/g, /只出文档/g, /只跑查询/g];

/** `cardText.desc400` 的截断长度（方案 §1.7.1 写"≤600 字"；字段名沿用 `desc400`，如实登记这处不一致）。 */
export const CARD_TEXT_MAX = 600;

/**
 * 泛键剪枝（2026-11-02 现跑实测后加，方案 §1.7.3「路径前缀相同」的落地订正）：
 * 现账本 1,136 张卡里，**775 张**都提到 `tools\dsh-butler`（因为收尾流程要求跑 `changelog-add.mjs`
 * ⇒ `tools\dsh-butler\changelog-add.mjs` ⇒ 目录键），518 张提到 `changelog-add.mjs`、458 张提到 `dsh\_archive`。
 * 不剪枝 ⇒ 互斥判据命中 **99.6%（1132/1136）**，等于"所有卡都撞车"，字段废掉。
 * ⇒ 出现在**全库 ≥ max(8, 2%×卡数)** 张卡里的路径前缀视为"全库惯例"，**不作为撞车依据**。
 * 阈值按全库规模自适应（夹具用 9 张假卡共享一条路径即可验剪枝生效）。
 */
export const COLLISION_KEY_MAX_DF_FLOOR = 8;
export const COLLISION_KEY_MAX_DF_RATIO = 0.02;

/** 一张卡的卡面全文（title + description + prompt）—— collision / cardText / 泛键统计都读这一份。 */
const cardTextOf = (card, fallbackTitle = '') =>
  [String(card?.title ?? fallbackTitle ?? ''), String(card?.description ?? ''), String(card?.prompt ?? '')].join('\n');

/** 取一段卡面原文当证据（≤max 字，压成单行）。 */
function snippetOf(text, index, len, max = 80) {
  const src = String(text ?? '');
  const s = src.slice(Math.max(0, index - 20), Math.min(src.length, index + len + 30)).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}
const headOf = (text, max = 60) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * 在一段文本里找「动作式」命中，**否定式排除**：命中词前 6 字内有 不/无/需/勿/别/免/禁 ⇒ 不算。
 * @returns {{index:number, needle:string, snippet:string}|null}
 */
export function findActionHit(text, patterns) {
  const src = String(text ?? '');
  for (const base of patterns) {
    const flags = base.flags.includes('g') ? base.flags : base.flags + 'g';
    const re = new RegExp(base.source, flags);
    let m;
    while ((m = re.exec(src)) !== null) {
      const i = m.index;
      const before = src.slice(Math.max(0, i - COLLISION_NEG_WINDOW), i);
      if (!COLLISION_NEG_RE.test(before)) return { index: i, needle: m[0], snippet: snippetOf(src, i, m[0].length) };
      if (m[0].length === 0) break;      // 防零宽死循环
    }
  }
  return null;
}

/** 路径前缀提取：`<盘>:\workspace\tools\dsh-butler\steward.mjs` 与 `tools\dsh-butler\…` 都要能对上。 */
const PATH_TOKEN_RE = /(?:[A-Za-z]:\\)?(?:[\w.\-]+\\)+[\w.\-]*/g;

/**
 * 抽出一张卡面里出现的「路径前缀键」（用于两两找互斥）。
 * 取法：路径串按 `\` 切段 ⇒ 同时看「含末段（可能是文件名）」与「只剩目录」两种切法，
 * 各取尾部 2~3 段拼成键（绝对/相对两种写法因此能对上：`<盘>:\workspace\tools\dsh-butler\a.mjs`
 * 与 `tools\dsh-butler\b.mjs` 都会产出 `tools\dsh-butler`）。
 * 🔴 只认 **ASCII 段链**，且**键的末段必须带 `-` / `.` / `_`** ——
 *    否则 `dsh\tools`、`dsh\docs` 这种"整个工作盘根目录都在其中"的泛键会让所有卡互斥（宁可判不出，不许瞎判）。
 * @returns {string[]}
 */
export function pathPrefixesOf(text) {
  const out = new Set();
  const toks = String(text ?? '').match(PATH_TOKEN_RE) || [];
  for (const raw of toks) {
    const noDrive = raw.replace(/^[A-Za-z]:\\/, '').toLowerCase();
    const segs = noDrive.split('\\').filter(Boolean);
    if (segs.length < 2) continue;
    for (const base of [segs, segs.slice(0, -1)]) {
      for (const w of [2, 3]) {
        if (base.length < w) continue;
        const win = base.slice(-w);
        const last = win[win.length - 1];
        if (!/[-._]/.test(last)) continue;          // 泛目录名（tools / docs / assets）不产键
        const key = win.join('\\');
        if (key.length < 6) continue;               // `a\b` 这种键没有区分度
        out.add(key);
      }
    }
  }
  return [...out];
}

/**
 * 算 `report.collision`（方案 §4.4 四条判据 · 全部按卡面文本近似）。
 * 🔴 判不出就写 `待人工判`，**不许编**；`rivals` 只在 `互斥` 时有值。
 * @param {{cards?:Map<string,object>, items?:Array<object|string>}} arg items = 参与判定的卡（raised[] + allPending[]）
 */
export function buildCollision({ cards = new Map(), items = [] } = {}) {
  const V = COLLISION_VERDICTS;
  // ① 全库泛键统计（df = 多少张卡提到这个路径前缀）—— 只统计，不改任何卡
  const df = new Map();
  if (cards instanceof Map) {
    for (const card of cards.values()) {
      for (const k of pathPrefixesOf(cardTextOf(card))) df.set(k, (df.get(k) || 0) + 1);
    }
  }
  const corpus = cards instanceof Map ? cards.size : 0;
  const maxDf = Math.max(COLLISION_KEY_MAX_DF_FLOOR, Math.ceil(COLLISION_KEY_MAX_DF_RATIO * corpus));
  const isSpecific = (k) => (df.get(k) || 0) <= maxDf;

  const judge = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const id = String(typeof it === 'string' ? it : (it?.id ?? ''));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const card = cards instanceof Map ? (cards.get(id) || null) : null;
    const title = String(card?.title ?? (typeof it === 'object' ? (it?.title ?? '') : ''));
    const text = cardTextOf(card, title);
    judge.push({ id, title, text, keys: pathPrefixesOf(text).filter(isSpecific) });
  }

  // ② 两两找「改同一批文件」⇒ 互斥（**只在"具体"路径前缀上判**，泛键已被剪）
  const rivals = new Map();   // id -> [{id, key}]
  const addRival = (a, b, key) => {
    if (!rivals.has(a)) rivals.set(a, []);
    rivals.get(a).push({ id: b, key });
  };
  for (let i = 0; i < judge.length; i++) {
    for (let j = i + 1; j < judge.length; j++) {
      const kj = new Set(judge[j].keys);
      const shared = judge[i].keys.find((k) => kj.has(k));
      if (!shared) continue;
      addRival(judge[i].id, judge[j].id, shared);
      addRival(judge[j].id, judge[i].id, shared);
    }
  }

  const out = judge.map((c) => {
    const ex = findActionHit(c.text, COLLISION_EXCLUSIVE_PATTERNS);
    if (ex) return { cardId: c.id, verdict: V.ALONE, guessed: true, evidence: ex.snippet, rivals: [] };
    const riv = rivals.get(c.id);
    if (riv && riv.length) {
      return {
        cardId: c.id, verdict: V.MUTEX, guessed: true,
        evidence: `同一路径前缀 ${riv[0].key}（与卡 ${riv[0].id.slice(0, 8)} 撞车）`.slice(0, 80),
        rivals: riv.map((x) => x.id).slice(0, 5),
      };
    }
    const par = findActionHit(c.text, COLLISION_PARALLEL_PATTERNS);
    if (par) return { cardId: c.id, verdict: V.PARALLEL, guessed: true, evidence: par.snippet, rivals: [] };
    return { cardId: c.id, verdict: V.MANUAL, guessed: true, evidence: headOf(c.text, 60), rivals: [] };
  });

  const hitCount = out.filter((x) => x.verdict === V.ALONE || x.verdict === V.MUTEX).length;
  const hitRate = out.length ? Number((hitCount / out.length).toFixed(4)) : 0;
  return {
    ok: cards instanceof Map && cards.size > 0,
    hitRate, hitCount, judgedCount: out.length,
    keyPruneMaxDf: maxDf,
    corpusCards: corpus,
    items: out,
    note: '按卡面文本近似判定，非结论（方案 §1.7.3；命中率高于 30% 已报黄）；'
      + `路径前缀出现在全库 >${maxDf} 张卡里的视为惯例、不作撞车依据（现账本实测不剪枝会命中 99.6%）`,
  };
}

/** 去掉 DoR/DoD 标记块与 HTML 注释，压成纯文本，截 max 字（乙层写「背景」用，**只输出卡面原文**）。 */
export function desc400Of(desc, max = CARD_TEXT_MAX) {
  let t = String(desc ?? '');
  t = t.replace(/<!--\s*DoR:begin\s*-->[\s\S]*?<!--\s*DoR:end\s*-->/gi, ' ');
  t = t.replace(/<!--\s*DoD:begin\s*-->[\s\S]*?<!--\s*DoD:end\s*-->/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** `report.cardText`：raised[] 全量 + allPending[] 前 10（同一张卡只出一次）。 */
export function buildCardText(cards, { raised = [], allPending = [], max = CARD_TEXT_MAX, pendingLimit = 10 } = {}) {
  const out = {};
  if (!(cards instanceof Map)) return out;
  const ids = [];
  const seen = new Set();
  const add = (x) => {
    const k = String(typeof x === 'string' ? x : (x?.id ?? ''));
    if (!k || seen.has(k)) return;
    seen.add(k); ids.push(k);
  };
  for (const x of raised) add(x);
  for (const x of allPending.slice(0, pendingLimit)) add(x);
  for (const id of ids) {
    const card = cards.get(id);
    if (!card) continue;
    out[id] = { title: String(card.title ?? ''), desc400: desc400Of(card.description, max) };
  }
  return out;
}

// ---------------------------------------------------------------- 在跑的会话（方案 §4.5 + 实现注）

/** 默认取数口（`session.list`）；夹具与"模拟不可达"用 `STEWARD_SESSION_BASE` 改道，**生产路径不变**。 */
export const SESSIONS_DEFAULT_BASE = 'http://localhost:3080';
/** 本线自举排除（§4.3③）：标题含「统筹 / 掌柜」的会话不算"别人在跑"。 */
export const SESSIONS_EXCLUDED_TITLE_RE = /统筹|掌柜/;
export const SESSIONS_LIMIT = 60;

// ---------------------------------------------------------------- 广播（方案 §4.5.1 判活三查 + §1.3 通道/落账）

/** 判活 ② 有内容：`updatedAt` 必须在 N 天内（方案 §4.5.1 用真实空壳标定出来的 3 天）。 */
export const BROADCAST_MIN_AGE_DAYS = 3;
/** 一次广播最多投几个（防手滑投给一大堆；方案里没有这个数，是本件自己加的手滑闸）。 */
export const BROADCAST_MAX_TARGETS = 9;
/** 判活 ① 的"三态"词表（快筛用：标题开头 `【X】` 的 X 落在这里才算"有状态"）。 */
export const BROADCAST_STATUS_MARKS = new Set(['运行', '完成', '待续']);
/** 卡执行会话的工作根：`cwd` 结尾是它 ⇒ 默认不当"主线"投（`--include-cards` 强开）。 */
export const CARD_SESSIONS_RE = /[\\/]card-sessions[\\/]*$/i;
/** 空壳常见的默认标题：剥掉 `【…】` 前缀后命中这些 ⇒ 不算"带项目名"。 */
export const DEFAULT_TITLE_RE = /^(新会话|未命名|无题|untitled|(会话|session)\s*\d*|\(无标题\)|（无标题）|无标题)$/i;
/** 广播唯一投递通道（复用现成件，不自己写 HTTP —— 卡面 ② 明令）。 */
export const SESSION_SAY_PATH = path.join(HERE, 'session-say.mjs');
/** 命令行传正文的硬上限（Windows 单个参数 32K，留足余量；超了宁可报错也别截断）。 */
export const BROADCAST_BODY_MAX_BYTES = 8000;

/**
 * 读「在跑的会话」（方案 §4.5 实现注**逐字**取数）：
 *   标题唯一来源 = `session.list` 的 `projections.values.title`（顶层 `title` 恒空）；
 *   只用 `sessionId / projections.values.title / running / updatedAt / blank`；
 *   🔴 不读会话正文、不解 `session.v4.jsonl.zstd`、不 `fs.stat`。
 * fail-open：取不到 ⇒ `{ok:false, reason}`，**绝不抛**（第二天 08:20 的 job 不能因为 dsh 没起就整轮失败）。
 * @param {{base?:string, timeoutMs?:number, rpc?:Function, now?:number, limit?:number}} [opts]
 */
export async function loadSessions({ base = process.env.STEWARD_SESSION_BASE || SESSIONS_DEFAULT_BASE, timeoutMs = 20_000, rpc = null, now = Date.now(), limit = SESSIONS_LIMIT } = {}) {
  const t0 = Date.now();
  const takenAt = new Date(now).toISOString();
  const note = '标题唯一来源 = session.list 的 projections.values.title；待回答为近似判定（title 含「待回答」，guessed:true）；'
    + 'blank 会话 / 标题含「统筹|掌柜」的本线会话 / 已【完成】的会话已排除并计数；按 运行→待回答→updatedAt 倒序，最多 60 条；'
    + 'mtime 用 updatedAt，不 fs.stat、不解 zstd、不读会话正文';
  try {
    const call = typeof rpc === 'function' ? rpc : hostRpc;
    const r = await call(base, 'session.list', {}, { timeoutMs });
    const status = Number(r?.status) || 0;
    const raw = r?.body?.result?.value?.items;
    if (!Array.isArray(raw)) throw new Error(`session.list HTTP ${status} 返回结构异常（没有 result.value.items）`);
    let excludedSelf = 0, blankExcluded = 0, completedSkipped = 0;
    const all = [];
    for (const it of raw) {
      const title = String(it?.projections?.values?.title ?? '');
      if (SESSIONS_EXCLUDED_TITLE_RE.test(title)) { excludedSelf++; continue; }
      if (it?.blank === true) { blankExcluded++; continue; }
      const mark = (title.match(/^【([^】]*)】/) || [])[1] || '';
      if (mark === '完成') { completedSkipped++; continue; }
      all.push({
        id: String(it?.sessionId ?? ''), title, mark,
        running: !!it?.running,
        updatedAt: Number.isFinite(it?.updatedAt) ? it.updatedAt : 0,
        blank: false,
        answeredPending: title.includes('待回答'),
        guessed: true,
      });
    }
    all.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0)
      || (b.answeredPending ? 1 : 0) - (a.answeredPending ? 1 : 0)
      || b.updatedAt - a.updatedAt);
    const items = all.slice(0, Math.max(1, limit));
    return {
      ok: true, takenAt, ms: Date.now() - t0, items,
      runningCount: all.filter((x) => x.running).length,
      answeredPendingCount: all.filter((x) => x.answeredPending).length,
      excludedSelf, blankExcluded, completedSkipped,
      truncated: Math.max(0, all.length - items.length), total: raw.length,
      note,
    };
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || '';
    const reason = `${String(e && e.message ? e.message : e)}${cause ? ` (${cause})` : ''}`.slice(0, 200);
    return {
      ok: false, takenAt, ms: Date.now() - t0, items: [], reason,
      runningCount: 0, answeredPendingCount: 0, excludedSelf: 0, blankExcluded: 0, completedSkipped: 0,
      truncated: 0, total: 0,
      note: 'session.list 拿不到 ⇒ fail-open（不崩、不写假数据）；本次「在跑的会话」这一路是空的，不能当成"没有会话在跑"',
    };
  }
}

/** 把 sessions 段挂到 report 上；取不到时补一条黄（fail-open，不崩）。 */
export function attachSessions(report, sess) {
  report.sessions = sess;
  if (!sess || !sess.ok) {
    report.warnings.push({ level: 'yellow', code: 'sessions-unavailable',
      message: `在跑的会话读不到（${sess?.reason ?? '未取'}）⇒ 「并行常态」这一路是空的，别当成"没有会话在跑"` });
  }
  return report;
}

// ---------------------------------------------------------------- 纯函数：算这一屏

/**
 * 把输入算成一屏结论。**纯函数、零 IO、零模型调用**（夹具直接喂它）。
 * @param {{standup:object, cards:(Map<string,object>|null), capability:object, vision:object, now?:number}} input
 * @param {{topN?:number, isDead?:(s:string)=>boolean, isSelf?:(l:string)=>boolean, recoverable?:(d:string)=>boolean}} [deps]
 */
export function computeReport(input, deps = {}) {
  const {
    topN = 3,
    isDead = (s) => DEAD_STATUSES.has(String(s ?? '')),
    isSelf = isSelfLine,
    recoverable = recoverableOf,
  } = deps;
  const now = input.now ?? Date.now();
  const standup = input.standup;
  const cards = input.cards instanceof Map ? input.cards : new Map();
  const warnings = [];

  const totals = standup?.totals ?? {};
  const pendingRaw = Array.isArray(standup?.pendingTop) ? standup.pendingTop : [];
  const convergenceTotal = Number.isFinite(totals.pendingDecision) ? totals.pendingDecision : null;

  // 口径自检：spawn 时给了超大 --top，候选条数必须等于 totals.pendingDecision，否则说明截断/漂移
  if (convergenceTotal !== null && pendingRaw.length !== convergenceTotal) {
    warnings.push({ level: 'yellow', code: 'pending-count-mismatch',
      message: `候选 ${pendingRaw.length} 条 ≠ 收敛线 ${convergenceTotal} 条（standup 的 --top 可能被截断，或口径漂了）⇒ 收敛线以 standup 的 totals 为准，候选按实际拿到的排` });
  }
  if (convergenceTotal === null) {
    warnings.push({ level: 'yellow', code: 'pending-total-missing', message: 'standup 没给 totals.pendingDecision ⇒ 收敛线标 unknown，不许猜' });
  }

  const excludedSelfCards = [];
  const droppedByDeadStatus = [];
  const candidates = [];
  for (const p of pendingRaw) {
    const card = cards.get(String(p.id)) || null;
    const line = p.line ?? card?.line ?? '(无主线)';
    const status = p.status ?? card?.status ?? 'unknown';
    const title = p.title ?? card?.title ?? '(无标题)';
    const description = String(card?.description ?? '');
    const item = {
      id: String(p.id),
      title,
      line,
      status,
      ageDays: Number.isFinite(p.ageDays) ? p.ageDays : null,
      recoverable: recoverable(description),
      hasCardText: Boolean(card),
      unlockValue: 'unknown',   // 方案 §4.1 ①：看板卡没有"依赖谁"字段 ⇒ 无源，不许猜
    };
    // 自举排除（§4.3③）：先排除本线，再判生命周期 —— 本线卡无论什么状态都不该占主人注意力
    if (isSelf(line)) { excludedSelfCards.push(item); continue; }
    if (isDead(status)) { droppedByDeadStatus.push(item); continue; }
    candidates.push(item);
  }

  const sorted = candidates.slice().sort(compareItems);
  const raised = sorted.slice(0, Math.max(0, topN));
  const backlog = Math.max(0, sorted.length - raised.length);
  const top = raised[0] ?? null;

  // 有源那一半（方案 §6 判据 4）：待办卡 ageDays >= N，源 = standup.stale[]
  const stale = Array.isArray(standup?.stale) ? standup.stale : [];
  const staleCross = stale.filter((s) => !isSelf(s.line));
  const staleSelf = stale.filter((s) => isSelf(s.line));
  // failed 卡另按 §4.1① 单列（复审3 口子 2：stale[] 只从 todo|backlog 切，failed 进不去）
  const failedCards = sorted.filter((x) => x.status === 'failed');

  // C12-D：账本里**全部** failed 卡（不要求卡面写「待拍板」）—— blocked/failed 副作用的输入。
  // 🔴 为什么不能复用上面那个 `failedCards`（2026-11-02 实测踩到）：它只从 `sorted` 里切，而 `sorted`
  //    来自 standup 的 `pendingTop`，standup 又只把**卡面写了「待拍板」**的卡塞进 pendingTop ⇒
  //    `pendingDecision=0` 的那天，账本里 5 张 failed 卡一张都进不来（"卡失败了"这件事彻底看不见）。
  //    口径：① 只认看板 `status==='failed'`；② 本线（协调线）自己的失败卡照旧排除（§4.3③ 自举）；
  //    ③ **ageDays 一律 null** —— 方案 §4.1 规则 4 的口径一处：ageDays 只许 standup 算，本件不自己算；
  //    ④ **已归档的 failed 卡不算**（2026-11-02 补 · 真源 `docs/` §2）：
  //       归档 = 人已经处理掉（放弃/关账）、已物理搬出主账本、点不进去 ⇒ 天天在晨报里报它是噪音；
  //       摘掉它之后 "晨报 / 乙层 / 行流 / 车况" 四路读到同一个数（此前账本级 6 vs 在板 5，差的就是这张）。
  const failedFromLedger = [];
  let failedSelfExcluded = 0;
  let failedArchivedExcluded = 0;
  for (const c of cards.values()) {
    if (String(c?.status ?? '') !== 'failed') continue;
    const line = c?.line ?? '(无主线)';
    // 「归档优先 · 互斥计数」（2026-11-02 收口 · 真源 `docs/` §3-A）：
    // 归档 ∧ 本线 双命中时**只算归档那一半**、本线不再计 ⇒ 闭合恒等式
    // `failedLedger + failedArchivedExcluded + failedSelfExcluded === 全量 failed` 恒成立，
    // 不会因同一张卡被数两次而多算 1；语义也对：已归档的卡本来就不该再算"本线在管"。
    if (c.archivedAt) { failedArchivedExcluded++; continue; }
    if (isSelf(line)) { failedSelfExcluded++; continue; }
    failedFromLedger.push({
      id: String(c?.id ?? ''), title: String(c?.title ?? '(无标题)'), line, status: 'failed',
      ageDays: null, recoverable: recoverable(String(c?.description ?? '')), hasCardText: true,
      unlockValue: 'unknown',
    });
  }
  failedFromLedger.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const cap = input.capability ?? summarizeCapability(null, { now, isSelf });
  if (cap.excludedSelf > 0) { /* 计数进位在输出里 */ }
  if (!cap.ok || !cap.fresh) warnings.push({ level: 'yellow', code: 'capability-unverified', message: `能力账：${cap.note}` });

  const vision = input.vision ?? summarizeVision(null);
  if (!vision.ok) warnings.push({ level: 'yellow', code: 'vision-unreadable', message: `愿景年轮：${vision.note}` });

  const lines = (Array.isArray(standup?.lines) ? standup.lines : [])
    .filter((g) => !isSelf(g.line))
    .map((g) => ({ line: g.line, cards: g.cards, running: g.running, failed: g.failed, pending: g.pending, oldestAgeDays: g.oldestAgeDays }))
    .sort((a, b) => (b.running * 100 + b.failed * 50 + b.pending * 20) - (a.running * 100 + a.failed * 50 + a.pending * 20));

  // 收敛线红绿（≤3 绿；>3 红）—— 两条线分开，红了不许装绿
  const convStatus = convergenceTotal === null ? 'unknown' : (convergenceTotal <= 3 ? 'green' : 'red');
  if (convStatus === 'red') {
    warnings.push({ level: 'red', code: 'convergence-red',
      message: `收敛线 ${convergenceTotal} 件 > 3 ⇒ 红。压着 ${backlog} 件，必须明写"它们分别卡在谁那里"，不许装绿` });
  }

  // 并行可行性 + 卡面摘要（方案 §4.4 / §1.7.3 B1 订正 / §1.7.1）—— 判据必须在**这里**用 cards 全文算
  const collision = buildCollision({ cards, items: [...raised, ...sorted] });
  if (collision.hitRate > COLLISION_HITRATE_YELLOW) {
    warnings.push({ level: 'yellow', code: 'collision-hitrate',
      message: `撞车判据命中率 ${(collision.hitRate * 100).toFixed(1)}%（${collision.hitCount}/${collision.judgedCount}），区分度低，别当结论（方案 §1.7.3）` });
  }
  const cardText = buildCardText(cards, { raised, allPending: sorted });

  return {
    generatedAt: new Date(now).toISOString(),
    host: hostName(),
    ledgerRevision: standup?.ledgerRevision ?? null,
    totals,
    lines,
    top: top ? { ...top, rationale: rationaleOf(top, sorted.length) } : null,
    raised,
    allPending: sorted,
    convergence: {
      total: convergenceTotal,          // 与 standup.totals.pendingDecision **同源**
      crossLine: sorted.length,         // 排除本线/死状态后的跨线待拍板
      raised: raised.length,
      backlog,
      status: convStatus,
      selfCardsExcludedFromTotal: excludedSelfCards.length,
    },
    stale: { cross: staleCross, self: staleSelf, thresholdDays: standup?.staleThresholdDays ?? null },
    failed: failedCards,
    // C12-D：账本级 failed（见上方说明）—— **只由 disposition 行流消费**，不改 `failed` 的既有语义
    failedLedger: failedFromLedger,
    failedSelfExcluded,
    // 同一次计算里"因归档被摘"的张数（见上方 ④）—— 闭合恒等式：
    //   failedLedger.length + failedArchivedExcluded + failedSelfExcluded === 看板全量 failed 张数
    failedArchivedExcluded,
    excluded: { selfCards: excludedSelfCards.length, selfCardsDetail: excludedSelfCards, deadStatus: droppedByDeadStatus.length, deadDetail: droppedByDeadStatus, selfCapability: cap.excludedSelf ?? 0 },
    capability: cap,
    vision,
    collision,
    cardText,
    warnings,
    unlockValue: 'unknown',
    unlockValueWhy: '看板卡没有"依赖谁"字段（方案 §4.1 ① 现查）⇒ 解锁价值无源，输出 unknown，不许猜',
  };
}

// ---------------------------------------------------------------- C8：乙层 hook（08:20 一次唤醒干完两件事）
//
// 真源：`docs/` §1.7.4 第一行 ——「tickd job `steward`（每天 08:20）
//   跑完甲层**之后**，同进程接着跑乙层」/「不新增第二个 job（一次唤醒干完，少一个调度面）」。
//
// 为什么是「甲层收尾 spawn」而不是「第二个 tickd job」：① 少一个调度面（方案原话）；
//   ② 乙层要吃的候选 `raised[]` / 收敛线正是甲层刚算出来的，分开跑要么重读 state、要么补一次握手，
//      都在制造第二个真相。
//
// 🔴 六条硬口径（卡 C8 判据，改这里之前先读完）：
//   ① 只在**每日真跑**路径触发 —— `--json` / `--no-write` / `--selftest` / `--broadcast` / `--help` 一律 0 次
//      （判据做成纯函数 `adviceHookGate`，夹具直接测它，不靠"看代码"）；
//   ② **锁外** spawn —— 调用点在 main 的 `finally { lock.release() }` **之后**：乙层 `persist()` 抢的是
//      **同一把** `steward` 锁（steward-advice.mjs L1013），持锁 spawn ⇒ 乙层"模型调完却写不进账"；
//   ③ `--apply` 显式带（不带 = 不写盘不调模型 = 白跑一次）；
//   ④ `timeout = ADVICE_HOOK_TIMEOUT_MS`（60 s），超时**杀子进程**、只记一行警告；
//   ⑤ **fail-open**：乙层任何失败（无凭证 / 超时 / 预算满 / 今天已跑过 / rc≠0 / spawn 炸）
//      都只落 `state.lastAdviceHook` + stdout 一行，甲层 rc **永远是它自己的**；
//   ⑥ 总开关默认开：`env STEWARD_ADVICE_HOOK=off`（或 state `adviceHook.enabled=false`）⇒ hook 0 次。

/** 总开关：env 优先，其次 state 里的 `adviceHook.enabled`；缺省开。 */
export function adviceHookEnabled({ env = process.env, state = null } = {}) {
  const raw = String(env?.[ADVICE_HOOK_ENV] ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no', 'disable', 'disabled'].includes(raw)) return { enabled: false, reason: `env:${ADVICE_HOOK_ENV}=${raw}` };
  if (state && state.adviceHook && state.adviceHook.enabled === false) return { enabled: false, reason: 'state:adviceHook.enabled=false' };
  return { enabled: true, reason: 'default-on' };
}

/**
 * 纯函数：这一轮该不该跑乙层。**这就是「非每日路径 0 次」的判据本体**（夹具直接调它）。
 * @returns {{run:boolean, reason:string}}
 */
export function adviceHookGate({ argv = [], noWrite = false, env = process.env, state = null } = {}) {
  const a = argv.map(String);
  if (a.includes('--help') || a.includes('-h')) return { run: false, reason: 'help' };
  if (a.includes('--selftest')) return { run: false, reason: 'selftest' };
  if (a.includes('--broadcast')) return { run: false, reason: 'broadcast' };
  // C10：attention 写入口是独立子命令（人工一次性动作）⇒ 绝不许顺带触发乙层（会花真钱）
  if (a.includes('--attention-add') || a.includes('--attention-answer') || a.includes('--attention-list')) {
    return { run: false, reason: 'attention' };
  }
  // C12-D：disposition 写/读入口同理（登记一条去向顺带花钱，谁都想不到）
  if (a.includes('--disposition-add') || a.includes('--disposition-list')) {
    return { run: false, reason: 'disposition' };
  }
  if (a.includes('--json')) return { run: false, reason: 'json' };
  if (noWrite) return { run: false, reason: 'no-write' };
  const en = adviceHookEnabled({ env, state });
  if (!en.enabled) return { run: false, reason: 'disabled', detail: en.reason };
  return { run: true, reason: 'daily' };
}

/**
 * 跑一次乙层（`steward-advice.mjs --apply`）。**永不抛**：任何失败都折成 `reason` 文本返回。
 * `spawnAdvice` 注入口给夹具用（**夹具里绝不真 spawn**）。
 * @returns {Promise<{at:string, rc:number|null, ms:number, skipped:boolean, reason:string}>}
 */
export async function runAdviceHook({
  spawnAdvice = null, home = dshHome(), env = process.env, now = Date.now(), timeoutMs = ADVICE_HOOK_TIMEOUT_MS,
} = {}) {
  const t0 = Date.now();
  const at = new Date(now).toISOString();
  const scriptPath = path.join(HERE, ADVICE_SCRIPT_FILE);
  const args = [scriptPath, '--apply'];                 // 🔴 口径③：--apply 显式带，别图省事去掉
  const spawnFn = typeof spawnAdvice === 'function' ? spawnAdvice : (a) => spawnSync(
    process.execPath, a,
    { encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024, cwd: HERE },
  );

  let r;
  try { r = spawnFn(args, { timeoutMs, home }); }
  catch (e) { return { at, rc: null, ms: Date.now() - t0, skipped: true, reason: `spawn-error:${e?.message ?? e}` }; }

  const ms = Date.now() - t0;
  const stdout = String(r?.stdout ?? '');
  const stderr = String(r?.stderr ?? '');
  const rc = Number.isInteger(r?.status) ? r.status : null;

  // ④ 超时：spawnSync 超时会自己 SIGTERM 掉子进程，并回 error.code='ETIMEDOUT'
  const errCode = String(r?.error?.code ?? '');
  if (errCode === 'ETIMEDOUT' || (r?.error && /timed?\s?out/i.test(String(r.error.message ?? '')))) {
    return { at, rc, ms, skipped: true, reason: `timeout（>${timeoutMs}ms，已杀子进程）`, killed: true };
  }
  if (r?.error) return { at, rc, ms, skipped: true, reason: `spawn-error:${errCode || r.error.message}` };

  // 今天有「日 1 次」闸：乙层自己会回这句并 rc=0 —— 归到 skipped（没花钱，不算失败）
  if (/今天已经跑过了/.test(stdout)) return { at, rc, ms, skipped: true, reason: 'already-ran' };
  if (rc !== 0) return { at, rc, ms, skipped: true, reason: `rc=${rc}${stderr ? ` · ${headOf(stderr, 120)}` : ''}` };
  return { at, rc: 0, ms, skipped: false, reason: 'ok' };
}

/**
 * 把 hook 结果写进 `state.lastAdviceHook`（甲层 state 已写完之后的**补写**）。
 * 拿不到锁 ⇒ 不写、只回 reason（fail-open：一行心跳丢得起，甲层不许为它返工）。
 */
export function persistAdviceHook(statePath, hook, { home = dshHome(), ttlMs = 30_000 } = {}) {
  const lock = acquireTickLock('steward', { ttlMs, home });
  if (!lock.ok) return { ok: false, reason: lock.reason ?? 'locked' };
  try {
    let st = {};
    try { if (fs.existsSync(statePath)) st = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; }
    catch { st = {}; }   // 读坏就只留 hook 这一格，不把整份 state 写坏（写坏由 mergeState 下一轮重建）
    st.lastAdviceHook = hook;
    writeTextAtomic(statePath, JSON.stringify(st, null, 2) + '\n', { retryDelaysMs: [50, 150, 400] });
    return { ok: true, path: statePath };
  } finally {
    try { lock.release(); } catch { /* TTL 兜底 */ }
  }
}

/** stdout 那一行（人话，一条就够）。 */
export function renderAdviceHookLine(hook) {
  if (!hook) return '[steward] 乙层（建议）：本轮没跑';
  const ms = Number.isFinite(hook.ms) ? `${hook.ms}ms` : '?';
  const rc = hook.rc === null || hook.rc === undefined ? 'rc=?' : `rc=${hook.rc}`;
  if (hook.skipped) return `[steward] 乙层（建议）跳过：${hook.reason}（${rc} · ${ms}）`;
  return `[steward] 乙层（建议）跑完：${hook.reason}（${rc} · ${ms}）`;
}

// ---------------------------------------------------------------- Attention 写入口（C10）

/**
 * 登记 / 销账 / 列出的 **IO 包装**（纯函数在 `lib\attentions.mjs`，这里是锁 + 读 + 写）。
 *
 * 三条硬口径：
 *  ① 拿 `steward` 锁（与 tickd job / 乙层同一把）—— 人工写入口不许和 08:20 抢写；
 *  ② 旧 state **读不出来就拒绝写**（坏 JSON 时不按空账覆盖：decisions[] 丢了就不可考）；
 *  ③ 写盘走 `writeTextAtomic`（方案 §2.3）。
 */
const attentionStatePath = ({ home = dshHome(), statePath = null } = {}) =>
  statePath || path.join(home, STEWARD_STATE_FILE);

/** state 文件不存在时的最小骨架（完整形状由次日 08:20 的 mergeState 重建；缺字段不阻塞登记）。 */
const emptyAttentionState = () => ({
  schemaVersion: SCHEMA_VERSION,
  generatedBy: `tools/dsh-butler/steward.mjs v${STEWARD_VERSION}`,
  persistence: 'persistent',
  sync: false,
  [ATTENTIONS_FIELD]: [],
});

function withAttentionLock({ home, lockTtlMs = 600_000 }, fn) {
  const lock = acquireTickLock('steward', { ttlMs: lockTtlMs, home });
  if (!lock.ok) return { ok: false, skipped: true, reason: lock.reason ?? 'locked',
    error: `另一实例正持锁（${lock.reason ?? 'locked'}）⇒ 这次不写（不排队）；稍后重跑一次即可` };
  try { return fn(); } finally { try { lock.release(); } catch { /* TTL 兜底 */ } }
}

/**
 * `--attention-add`：登记一条「等主人决定」。
 * @returns {{ok:boolean, skipped?:boolean, action?:string, reopened?:boolean, entry?:object,
 *            unattended?:number, total?:number, statePath?:string, error?:string, reason?:string}}
 */
export function attentionAddEntry({ cardId, question, options = [], home = dshHome(), statePath = null, now = Date.now(), lockTtlMs } = {}) {
  const p = attentionStatePath({ home, statePath });
  return withAttentionLock({ home, lockTtlMs }, () => {
    const rd = readAttentionState(p);
    if (!rd.ok) return { ok: false, error: `${rd.error}（拒绝覆盖；state：${p}）` };
    const r = addAttention(rd.exists ? rd.state : emptyAttentionState(), { cardId, question, options, now });
    if (!r.ok) return { ok: false, error: r.error };
    writeTextAtomic(p, JSON.stringify(r.state, null, 2) + '\n', { retryDelaysMs: [50, 150, 400] });
    return {
      ok: true, action: r.action, reopened: r.reopened, entry: r.entry, statePath: p,
      unattended: unattendedAttentions(r.state).length, total: normalizeAttentions(r.state).length,
    };
  });
}

/**
 * `--attention-answer`：销账（写 `answeredAt`）。**没有这条就拒绝**（不凭空创建）。
 * @returns {{ok:boolean, skipped?:boolean, action?:'answered'|'already', entry?:object,
 *            unattended?:number, total?:number, statePath?:string, error?:string, reason?:string}}
 */
export function attentionAnswerEntry({ cardId, home = dshHome(), statePath = null, now = Date.now(), lockTtlMs } = {}) {
  const p = attentionStatePath({ home, statePath });
  return withAttentionLock({ home, lockTtlMs }, () => {
    const rd = readAttentionState(p);
    if (!rd.ok) return { ok: false, error: `${rd.error}（拒绝覆盖；state：${p}）` };
    const r = answerAttention(rd.exists ? rd.state : {}, { cardId, now });
    if (!r.ok) return { ok: false, error: r.error };
    if (r.action === 'answered') {
      writeTextAtomic(p, JSON.stringify(r.state, null, 2) + '\n', { retryDelaysMs: [50, 150, 400] });
    }
    return {
      ok: true, action: r.action, entry: r.entry, statePath: p,
      unattended: unattendedAttentions(r.state).length, total: normalizeAttentions(r.state).length,
    };
  });
}

/** `--attention-list`：只读列出（未答 / 已答分开数）。 */
export function attentionList({ home = dshHome(), statePath = null } = {}) {
  const p = attentionStatePath({ home, statePath });
  const rd = readAttentionState(p);
  const all = normalizeAttentions(rd.state);
  return {
    ok: rd.ok, statePath: p, exists: rd.exists, reason: rd.reason ?? null, error: rd.error ?? null,
    unattended: all.filter((x) => !x.answeredAt), answered: all.filter((x) => x.answeredAt), total: all.length,
  };
}

/** 人话：登记 / 销账 / 列出三种结果。 */
export function renderAttention(r, mode = 'add') {
  if (!r || !r.ok) {
    if (r && r.skipped) return `[steward] ⏭ ${r.error || r.reason || '这次没写'}`;
    return `[steward] 🔴 ${r?.error || 'Attention 操作失败（原因不明）'}`;
  }
  if (mode === 'list') {
    const L = [`[steward] attentions · ${r.statePath}`];
    L.push(`  未答 ${r.unattended.length} 条 · 已答 ${r.answered.length} 条 · 共 ${r.total} 条${r.exists ? '' : '（文件不存在）'}`);
    for (const x of r.unattended) L.push(`  ● [未答] ${x.cardId}  ${x.question}${x.options.length ? `（选项：${x.options.join(' / ')}）` : ''}  问于 ${x.askedAt || '?'}`);
    for (const x of r.answered.slice(-10)) L.push(`  ○ [已答] ${x.cardId}  ${x.question}  答于 ${x.answeredAt}`);
    if (r.reason) L.push(`  🟡 ${r.reason}`);
    return L.join('\n');
  }
  const e = r.entry || {};
  if (mode === 'answer') {
    const head = r.action === 'already' ? '已经答过了（时间不变）' : '已销账';
    return `[steward] ✅ ${head}｜卡 ${e.cardId}｜答于 ${e.answeredAt}｜未答剩 ${r.unattended} 条｜state：${r.statePath}`;
  }
  const head = r.action === 'updated'
    ? (r.reopened ? '已重新开问（原 askedAt 保留）' : '已更新（幂等：没有重复条目）')
    : '已登记';
  const opts = Array.isArray(e.options) && e.options.length ? `｜选项：${e.options.join(' / ')}` : '';
  return `[steward] ✅ ${head}｜卡 ${e.cardId}｜问：${e.question}${opts}｜问于 ${e.askedAt}｜未答 ${r.unattended} 条｜state：${r.statePath}`;
}

// ---------------------------------------------------------------- Disposition 行流（C12-D）

/**
 * 纯函数：这一轮该不该往行流里写。**这就是「非每日路径 0 行」的判据本体**（夹具直接调它）。
 * 口径与 `adviceHookGate` 对齐（同一张"哪些 argv 算独立子命令"的名单），只多一个 env 逃生口。
 * @returns {{write:boolean, reason:string, detail?:string}}
 */
export function dispositionGate({ argv = [], noWrite = false, env = process.env } = {}) {
  const a = argv.map(String);
  if (a.includes('--help') || a.includes('-h')) return { write: false, reason: 'help' };
  if (a.includes('--selftest')) return { write: false, reason: 'selftest' };
  if (a.includes('--broadcast')) return { write: false, reason: 'broadcast' };
  if (a.includes('--attention-add') || a.includes('--attention-answer') || a.includes('--attention-list')) {
    return { write: false, reason: 'attention' };
  }
  if (a.includes('--disposition-add') || a.includes('--disposition-list')) return { write: false, reason: 'disposition' };
  if (a.includes('--json')) return { write: false, reason: 'json' };
  if (noWrite) return { write: false, reason: 'no-write' };
  const raw = String(env?.[DISPOSITION_ENV] ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no', 'disable', 'disabled'].includes(raw)) {
    return { write: false, reason: 'disabled', detail: `env:${DISPOSITION_ENV}=${raw}` };
  }
  return { write: true, reason: 'daily' };
}

/** 一次跑的 runId：同一天重跑会拿到不同的 runId（行流是流水，不是幂等表）——但**可归组、可复算**。 */
export function dispositionRunId({ now = Date.now(), host = hostName(), ledgerRevision = null } = {}) {
  return `run-${ymd(now)}-${sha16(`${now}|${host}|${ledgerRevision ?? 'unknown'}`)}`;
}

/**
 * 收尾那一步：**先追写行流，再跑两值副作用**。**永不抛**（行流写不进去也不许挡住甲层）。
 *
 * 三条口径：
 *  ① `write:false` ⇒ 一个字节都不写，只回分布（干跑 / `--json` / `--no-write` 都走这条）；
 *  ② 行流写失败 ⇒ 只记 `error`，**副作用照跑**（两件事互不牵连：一条是记录，一条是主人要看见）；
 *  ③ 副作用**在锁外**调用（`attentionAddEntry` 抢同一把 `steward` 锁）—— 调用点必须在 `lock.release()` 之后。
 *
 * @param {{rows:object[], report?:object, write?:boolean, reason?:string, home?:string, statePath?:string|null,
 *          filePath?:string, now?:number, addAttention?:Function, listAttention?:Function}} arg
 */
export function runDisposition({
  rows = [], report = null, write = true, reason = 'daily', home = dshHome(), statePath = null,
  filePath = null, now = Date.now(), addAttention = attentionAddEntry, listAttention = attentionList,
} = {}) {
  const file = filePath || path.join(home, DISPOSITION_STATE_FILE);
  const sum = summarizeRows(rows);
  const base = {
    ok: true, wrote: false, reason, file, total: sum.total,
    byKind: sum.byKind, byReason: sum.byReason, unknownReasons: sum.unknownReasons,
    appended: 0, bytes: 0, sideEffects: [], error: null,
  };
  if (!write) return base;

  // ① 行流（先写：它是最便宜、也最不会挡路的那半）
  let app = { ok: true, appended: 0, bytes: 0, path: file };
  try { app = appendRows(file, rows); }
  catch (e) { app = { ok: false, appended: 0, bytes: 0, path: file, error: `追写抛了：${e && e.message ? e.message : e}` }; }

  // ② 两值副作用：failed / blocked ⇒ 自动登记「等主人决定」
  const sideEffects = [];
  const titles = titlesOf(report);
  const targets = rows.filter((r) => isSideEffectKind(r?.kind));
  if (targets.length) {
    const cur = listAttention({ home, statePath });          // 只读：拿到"已经在等"的清单
    const pendingByCard = new Map((cur?.ok ? cur.unattended : []).map((x) => [String(x.cardId), x]));
    for (const row of targets) {
      const req = attentionRequestFor(row, { title: titles.get(String(row.cardId ?? '')) ?? '' });
      const cardId = String(row?.cardId ?? '');
      if (!req) { sideEffects.push({ cardId, kind: row.kind, ok: false, action: null, why: 'no-request（缺卡 id）' }); continue; }
      if (!cur?.ok) { sideEffects.push({ cardId, kind: row.kind, ok: false, action: null, why: `state 读不到：${cur?.error ?? '?'}` }); continue; }
      const already = pendingByCard.get(cardId);
      // 已经在等（未答）⇒ **不重复写**（否则每次 08:20 都把 state 重写一遍；attention 幂等也救不了噪声）
      if (already && already.question === req.question && Array.isArray(already.options)
        && already.options.join(',') === req.options.join(',')) {
        sideEffects.push({ cardId, kind: row.kind, ok: true, action: 'already', why: '未答条目已在，不重复写' });
        continue;
      }
      let res;
      try { res = addAttention({ cardId, question: req.question, options: req.options, home, statePath, now }); }
      catch (e) { res = { ok: false, error: `登记抛了：${e && e.message ? e.message : e}` }; }
      sideEffects.push({
        cardId, kind: row.kind, ok: Boolean(res?.ok), action: res?.action ?? null,
        reopened: Boolean(res?.reopened), skipped: Boolean(res?.skipped),
        why: res?.ok ? null : String(res?.error ?? res?.reason ?? '原因不明'),
      });
    }
  }

  const seOk = sideEffects.filter((x) => x.ok && x.action !== 'already').length;
  return {
    ...base,
    ok: app.ok !== false,
    wrote: true, appended: app.appended, bytes: app.bytes,
    sideEffects, sideEffectAdded: seOk,
    error: app.error ?? null,
  };
}

/** 只读：`--disposition-list`（回最近 N 条；`byKind` / `byReason` **按全量算**，不是只算回显的那几条）。 */
export function dispositionList({ home = dshHome(), filePath = null, tail = DISPOSITION_TAIL_DEFAULT } = {}) {
  const p = filePath || path.join(home, DISPOSITION_STATE_FILE);
  const full = readRows(p, { tail: 0 });                       // 汇总必须看全量（只算最近 N 条会把"一共记了什么"报小）
  const n = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : DISPOSITION_TAIL_DEFAULT;
  const sum = summarizeRows(full.rows);
  return { ok: full.ok, path: p, exists: full.exists, total: full.total, bad: full.bad, tail: n,
    rows: full.rows.slice(-n), byKind: sum.byKind, byReason: sum.byReason, unknownReasons: sum.unknownReasons,
    error: full.error ?? null };
}

/** 人话：收尾那一行（**只有一行**，不许把甲层 stdout 撑成三段）。 */
export function renderDispositionLine(r) {
  if (!r) return '[steward] 记录去向（disposition）：本轮没跑';
  const fmt = (o) => (Object.keys(o ?? {}).length ? Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' / ') : '无');
  if (!r.wrote) {
    return `[steward] 记录去向（disposition）：干跑 ${r.total} 行**未写**（${r.reason}）· kind：${fmt(r.byKind)} · 原因码：${fmt(r.byReason)}`;
  }
  const se = Array.isArray(r.sideEffects) ? r.sideEffects : [];
  const added = se.filter((x) => x.ok && x.action !== 'already').length;
  const already = se.filter((x) => x.action === 'already').length;
  const failed = se.filter((x) => !x.ok).length;
  const seTxt = se.length
    ? `· 自动登记待决定 ${added} 张${already ? `（已在 ${already}）` : ''}${failed ? ` · 🔴 失败 ${failed}` : ''}`
    : '';
  return `[steward] 记录去向（disposition）：记 ${r.appended} 行 → ${r.file}（kind：${fmt(r.byKind)}；原因码：${fmt(r.byReason)}）${seTxt}`
    + (r.error ? ` · 🟡 ${r.error}` : '');
}

/** `--disposition-add`：执行会话报 blocked / 手工补一条去向（**这才是 blocked 的产生口**）。 */
export function dispositionAddEntry({
  kind, cardId, reason, detail = '', title = '', home = dshHome(), statePath = null, filePath = null,
  now = Date.now(), runId = null, addAttention = attentionAddEntry, listAttention = attentionList,
} = {}) {
  const rid = runId || dispositionRunId({ now });
  const detailWithTitle = title ? `title=${String(title).replace(/\s+/g, ' ').trim()}${detail ? ` · ${detail}` : ''}` : detail;
  const r = buildRow({ kind, cardId, reason, detail: detailWithTitle, runId: rid, now });
  if (!r.ok) return { ok: false, error: r.error, file: filePath || path.join(home, DISPOSITION_STATE_FILE) };
  const row = r.row;
  const reportLike = { raised: [], allPending: [], failed: [{ id: row.cardId, title }] };
  const res = runDisposition({
    rows: [row], report: reportLike, write: true, reason: 'cli', home, statePath, filePath, now,
    addAttention, listAttention,
  });
  return { ...res, row };
}

/** 人话：`--disposition-add` / `--disposition-list` 两种结果。 */
export function renderDisposition(r, mode = 'add') {
  if (!r) return '[steward] 🔴 disposition 操作失败（原因不明）';
  if (mode === 'list') {
    if (!r.ok) return `[steward] 🔴 行流读不到：${r.error ?? '?'}`;
    const L = [`[steward] disposition · ${r.path}${r.exists ? '' : '（文件还不存在）'}`];
    L.push(`  共 ${r.total} 行${r.bad ? ` · 坏行 ${r.bad} 条（已跳过）` : ''} · 下面是最近 ${r.rows.length} 条`);
    if (Object.keys(r.byKind).length) L.push(`  kind：${Object.entries(r.byKind).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    if (Object.keys(r.byReason).length) L.push(`  原因码：${Object.entries(r.byReason).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    if (r.unknownReasons.length) L.push(`  🟡 未知原因码（表里没有，只提示不丢行）：${r.unknownReasons.join(', ')}`);
    for (const x of r.rows) L.push(`  · ${x.at}  ${x.kind.padEnd(9)}  ${x.reason.padEnd(22)}  ${x.cardId ?? '-'}${x.detail ? `  ${x.detail}` : ''}`);
    return L.join('\n');
  }
  if (!r.ok) return `[steward] 🔴 没记上：${r.error ?? '原因不明'}`;
  const se = (r.sideEffects ?? [])[0];
  const seTxt = se ? `｜副作用：${se.ok ? (se.action === 'already' ? '已在等（不重复登记）' : `已登记待决定（${se.action}）`) : `🔴 ${se.why}`}` : '';
  return `[steward] ✅ 已记一条去向｜${r.row.kind} · ${r.row.reason} · 卡 ${r.row.cardId ?? '-'}${seTxt}｜行流 ${r.file}`;
}

// ---------------------------------------------------------------- 幂等写账

/**
 * 合并 state（**幂等**：同 `id` 二次写入 = no-op，不新增行、不改时间）。
 * `id = sha16(<卡id>|<动作>|<日期>)`（方案 §4.3②）。
 */
export function mergeState(prev, report, { now = Date.now(), topN = 3 } = {}) {
  const date = ymd(now);
  const at = new Date(now).toISOString();
  const p = prev && typeof prev === 'object' ? prev : {};
  const decisions = Array.isArray(p.decisions) ? p.decisions.slice() : [];
  const instructions = Array.isArray(p.instructions) ? p.instructions.slice() : [];
  const raiseCounts = Array.isArray(p.raiseCounts) ? p.raiseCounts.slice() : [];
  const reports = Array.isArray(p.reports) ? p.reports.slice() : [];

  let addedInstructions = 0;
  let addedRaises = 0;

  // ① 上桌项 → instructions[]（**只登记建议，不发喊话**：channel:'none'）
  for (const item of report.raised) {
    const id = sha16(`${item.id}|suggest|${date}`);
    if (instructions.some((x) => x.id === id)) continue;                 // 幂等：同 id 二次 = no-op
    instructions.push({
      id, cardId: item.id, action: 'suggest', date, at,
      channel: 'none', status: 'suggested',                              // ⚠️ 不是投递回执，本件没有投递能力
      line: item.line, title: item.title, reason: item.rationale,
      note: '本件（甲层）只登记建议、不发喊话；真投递归乙层/嘴，且受 §1.3 两道闸',
    });
    addedInstructions++;
  }

  // ② 全量待拍板清单被列出即计一次（方案 §4.2 订正口径）；**同自然日同卡只计一次**（同日重跑不重复）
  const raisedIds = new Set(report.allPending.map((x) => x.id));
  for (const item of report.allPending) {
    const id = sha16(`${item.id}|raise|${date}`);
    if (raiseCounts.some((x) => x.id === id)) continue;
    const prevSame = raiseCounts.filter((x) => x.cardId === item.id);
    const distinctDates = new Set(prevSame.map((x) => x.date));
    distinctDates.add(date);
    raiseCounts.push({ id, cardId: item.id, date, count: distinctDates.size,
      firstDate: prevSame.length ? prevSame.map((x) => x.date).sort()[0] : date,
      lastDate: date, line: item.line, title: item.title });
    addedRaises++;
  }
  // count 是"被上桌过几轮"的累计（跨日期去重），这里按当前日志重算一遍，保证自洽
  const byCard = new Map();
  for (const r of raiseCounts) {
    if (!byCard.has(r.cardId)) byCard.set(r.cardId, new Set());
    byCard.get(r.cardId).add(r.date);
  }
  for (const r of raiseCounts) r.count = byCard.get(r.cardId).size;

  // ③ reports[]：同一日期只留一条（重跑覆盖，不新增条数 —— 幂等的可见部分）
  const snapshot = {
    date, at,
    ledgerRevision: report.ledgerRevision,
    pendingTotal: report.convergence.total,
    crossLinePending: report.convergence.crossLine,
    raised: report.convergence.raised,
    backlog: report.convergence.backlog,
    convergenceStatus: report.convergence.status,
    excludedSelfCards: report.excluded.selfCards,
    excludedSelfCapability: report.excluded.selfCapability,
    droppedDeadStatus: report.excluded.deadStatus,
    warnings: report.warnings.length,
  };
  const idx = reports.findIndex((x) => x.date === date);
  if (idx >= 0) reports[idx] = snapshot; else reports.push(snapshot);

  // ④ 30 天窗口（心跳 / 上桌计数只留 30 天；decisions 永久）
  const cutoff = now - HEARTBEAT_KEEP_DAYS * DAY_MS;
  const keepDate = (d) => {
    const t = Date.parse(`${d}T00:00:00+08:00`);
    return !Number.isFinite(t) || t >= cutoff - DAY_MS;
  };
  const reportsKept = reports.filter((x) => keepDate(x.date));
  const raiseKept = raiseCounts.filter((x) => keepDate(x.date));
  const instructionsKept = instructions.filter((x) => keepDate(x.date));   // 指令也是流水，同样 30 天

  const runs = Number.isFinite(p.heartbeat?.runs) ? p.heartbeat.runs + 1 : 1;

  // ⑤ 乙层（C5）两段：**原样透传**，本函数既不读写也不裁剪它们。
  //    🔴 B2（方案 §1.7.6 复审阻断）：`next` 是**写死段清单、不 spread 旧 state**，L801 又整份覆盖
  //    ⇒ 不在这个清单里的段会在次日 08:20 被静默抹掉。乙层的 `advices[]`（retention=永久）与
  //    `adviceSpend{ym,calls,cny}`（**唯一的钱闸**）必须在这里显式列名，否则"永久"只活到明早。
  //    ⚠️ 刻意**不**改成通用 `...prev` spread：写死段清单是既有防"野段"设计，动它要单独立卡。
  const advices = Array.isArray(p.advices) ? p.advices.slice() : [];
  const adviceSpend = (p.adviceSpend && typeof p.adviceSpend === 'object' && !Array.isArray(p.adviceSpend))
    ? { ...p.adviceSpend } : null;

  // ⑥ 乙层 hook 心跳（C8）：同 ⑤ 的道理 —— 不在写死段清单里就会被明早静默抹掉。
  //    本轮结果由 main 在**锁外**补写（`persistAdviceHook`），这里只负责把上一轮的带过去。
  const lastAdviceHook = (p.lastAdviceHook && typeof p.lastAdviceHook === 'object' && !Array.isArray(p.lastAdviceHook))
    ? { ...p.lastAdviceHook } : null;

  // ⑦ Attention（C10）：**同 ⑤⑥ 的 B2 教训** —— 写死段清单不 spread 旧 state，
  //    不在这里显式列名的话，人工登记过的「等主人决定」会被次日 08:20 静默抹掉（= 主人以为没人等他）。
  //    只做**规范化透传**：本函数既不答、不删、不排序（写入口在 `--attention-add / --attention-answer`）。
  const attentions = normalizeAttentions(p);

  const next = {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: `tools/dsh-butler/steward.mjs v${STEWARD_VERSION}`,
    persistence: 'persistent',
    retention: 'decisions[] 永久（要能回答"当时为什么这么拍"）· advices[] 永久（乙层建议内容与花费，C5）· '
      + 'adviceSpend{} 永久（月预算硬闸，跨月自动重置计数）· attentions[] 永久（等主人决定的唯一来源，C10；'
      + '已答的也留着，好回答"什么时候问过、什么时候答的"）· instructions[] / raiseCounts[] / reports[] 心跳类只留 30 天',
    sync: false,
    syncWhy: '本文件带"每轮去重（同 id 二次 no-op）+ 上桌次数 + 心跳"时间窗口语义，按 lib/state-files.mjs 判据**禁止跨机同步**'
      + '（双机共享会互相压制上桌计数）；第一版单机部署（方案 §1.4）',
    loss: '上桌计数与心跳归零（待拍板项"上桌过几次"回到 0，需重新累计）；decisions[] 丢失 = 拍板理由不可考，只能从档/会话里翻',
    heartbeat: { lastRunAt: at, lastRunHost: hostName(), runs, lastResult: 'ok', version: STEWARD_VERSION },
    lastReport: snapshot,
    decisions,
    instructions: instructionsKept,
    raiseCounts: raiseKept,
    reports: reportsKept,
    // 乙层两段（C5）—— 见上方 ⑤ 的 B2 说明：只透传、不裁剪、不清空
    advices,
    ...(adviceSpend ? { adviceSpend } : {}),
    // 乙层 hook 心跳（C8）—— 见上方 ⑥
    ...(lastAdviceHook ? { lastAdviceHook } : {}),
    // Attention 结构化（C10）—— 见上方 ⑦；**必须显式列名**，否则次日 08:20 静默抹掉
    [ATTENTIONS_FIELD]: attentions,
    // 便于人查：本轮的上桌排行（不入账，纯快照）
    lastRaised: report.raised.map((x) => ({ id: x.id, line: x.line, title: x.title, status: x.status, ageDays: x.ageDays })),
    counters: { pendingTotal: report.convergence.total, crossLinePending: report.convergence.crossLine, backlog: report.convergence.backlog },
    note: '写者：tickd job `steward` 独占（人手工排障可直跑，靠 tick 锁互斥）；"嘴"会话只读不写（方案 §2.3 并发设计）',
  };
  return { state: next, addedInstructions, addedRaises, instructionCount: instructionsKept.length, decisionCount: decisions.length, raiseCount: raiseKept.length };
}

// ---------------------------------------------------------------- 人话渲染

export function renderText(report, stateInfo = null) {
  const L = [];
  const T = report.totals || {};
  L.push(`🧠 掌柜脑子（甲层·零 token）· ${report.host} · ${new Date(report.generatedAt).toLocaleString('zh-CN')}`);
  L.push(`看板 rev ${report.ledgerRevision ?? '?'} · 在途 ${T.live ?? '?'} 张（跑着 ${T.running ?? '?'} / 待办 ${T.waiting ?? '?'} / 失败 ${T.failed ?? '?'}（主账本口径 · 含本线））· ${T.lines ?? '?'} 条主线（已排除本线）`);
  L.push('');

  // ── 在动的线
  L.push('━━ 哪几条线在动 ━━');
  const moving = report.lines.filter((g) => g.running || g.failed);
  if (!moving.length) L.push('  （没有跑着或失败的线）');
  for (const g of moving.slice(0, 6)) {
    const bits = [];
    if (g.running) bits.push(`跑着 ${g.running}`);
    if (g.failed) bits.push(`失败 ${g.failed}`);
    if (g.pending) bits.push(`待拍板 ${g.pending}`);
    if (g.cards) bits.push(`在板 ${g.cards}`);
    L.push(`  · ${g.line} —— ${bits.join(' / ')}`);
  }
  if (moving.length > 6) L.push(`  … 另有 ${moving.length - 6} 条线有在跑或失败的卡`);
  L.push('');

  // ── 今天建议推哪条
  L.push('━━ 今天建议先看这条 ━━');
  if (report.top) {
    const t = report.top;
    L.push(`  ⚠️ [${t.line}] ${t.title}`);
    L.push(`     卡 ${t.id.slice(0, 8)} · 状态 ${t.status} · 躺 ${t.ageDays === null ? 'unknown' : t.ageDays + ' 天'} · ${t.recoverable ? '有回滚点' : '没找到回滚点'}`);
    L.push(`     为什么是它：${t.rationale}`);
    L.push(`     ⚠️ 解锁价值 unlockValue: unknown —— 看板没有"依赖谁"字段，算不出，不猜`);
  } else {
    L.push('  （跨线待拍板清空了 —— 这不是"没事干"，是"没有待拍板项"，在跑的线看上面）');
  }
  L.push('');

  // ── 上桌
  L.push(`━━ 上桌（≤${Math.max(report.convergence.raised, 3)} 件 / 实际列 ${report.raised.length} 件）━━`);
  if (!report.raised.length) L.push('  （0 件）');
  report.raised.forEach((x, i) => {
    L.push(`  ${i + 1}. [${x.line}] ${x.title}`);
    L.push(`     ${x.status} · ${x.ageDays === null ? 'ageDays unknown' : x.ageDays + ' 天'} · ${x.recoverable ? '可回滚' : '无可回滚迹象'} · id ${x.id.slice(0, 8)}`);
    L.push(`     ⚠️ 四段（背景/选项/建议/代价）**留给乙层**：本件零模型调用，产不出这四段，不硬编`);
  });
  if (report.convergence.backlog > 0) {
    L.push(`  … 另有 ${report.convergence.backlog} 件压着（这就是"上桌线"与"收敛线"必须分开报的原因）`);
  }
  L.push('');

  // ── 谁在等谁
  L.push('━━ 谁在等谁（能力账 · 人工维护档，未自动核）━━');
  const cap = report.capability;
  if (!cap.ok || !cap.items.length) {
    L.push(`  🟡 ${cap.note || '没读到'}`);
  } else {
    for (const c of cap.items.slice(0, 6)) {
      const since = c.since ? ` · since ${c.since}` : '';
      L.push(`  · [${c.status || '?'}] ${c.from || '?'} → ${c.to || '?'}：${c.what || '?'}${since}`);
    }
    if (cap.items.length > 6) L.push(`  … 另有 ${cap.items.length - 6} 条（这是人工登记，未自动核）`);
    L.push(`  🟡 ${cap.note}`);
  }
  if (cap.excludedSelf) L.push(`  已排除本线能力账 ${cap.excludedSelf} 条（自指项不计成跨线阻塞）`);
  L.push('');

  // ── 超期两半（方案 §6 判据 4）
  L.push('━━ 超期无人催（分两半报，不许混成一条绿）━━');
  const sd = report.stale.thresholdDays ?? 3;
  L.push(`  ✅ 有源那半 · 待办卡（todo/backlog）躺 ≥${sd} 天：${report.stale.cross.length} 张`);
  for (const s of report.stale.cross.slice(0, 5)) L.push(`     · [${s.line}] ${String(s.title).slice(0, 50)}（${s.status} · ${s.ageDays} 天）`);
  if (report.stale.cross.length > 5) L.push(`     … 另有 ${report.stale.cross.length - 5} 张`);
  // failed 段 · 口径 = **账本级 · 在板**（`failedLedger`，已排除归档与本线 —— 真源 `docs/` §2）
  // 三重回落只为兼容老 state / 老夹具喂的 report（那时没有 failedLedger 字段，直接读会 TypeError）。
  // 🔴 renderText 必须保持**纯渲染**：走回落分支时只在这里多打一句，绝不往 report 里写东西
  //    （写 warning 会导致"渲染两次出两条"、且 `--json` 那条路径根本看不到）。
  const failedList = Array.isArray(report.failedLedger) ? report.failedLedger : (Array.isArray(report.failed) ? report.failed : []);
  if (failedList.length) {
    const fellBack = !Array.isArray(report.failedLedger);
    const exArchived = Number(report.failedArchivedExcluded) || 0;
    const exSelf = Number(report.failedSelfExcluded) || 0;
    const exBits = [];
    if (exArchived > 0) exBits.push(`归档 ${exArchived} 张不计`);
    if (exSelf > 0) exBits.push(`本线（未归档）${exSelf} 张已排除`);
    L.push(`  ⚠️ failed 卡（在板口径 · 已排除本线与归档）：${failedList.length} 张${exBits.length ? `（${exBits.join(' · ')}）` : ''}${fellBack ? '（⚠️ 已回落到候选口径 —— failedLedger 缺失）' : ''}`);
    // 明细行**不渲染 ageDays**：账本级 ageDays 恒 null（口径 §2-3），渲染出来只会是 "unknown 天"
    for (const f of failedList.slice(0, 5)) L.push(`     · [${f.line}] ${String(f.title).slice(0, 50)}`);
    if (failedList.length > 5) L.push(`     … 另有 ${failedList.length - 5} 张`);
  }
  L.push(`  🟡 没源那半 · 跨线等待：${cap.ok && cap.fresh ? `读到 ${cap.items.length} 条人工登记，**未自动核**（不计绿）` : 'capability.json 读不到 / 超 7 天 ⇒ unknown'}`);
  L.push('');

  // ── 收敛线
  L.push('━━ 待拍板 · 收敛线 ━━');
  const c = report.convergence;
  const flag = c.status === 'green' ? '🟢' : c.status === 'red' ? '🔴' : '🟡';
  L.push(`  ${flag} 收敛线：${c.total === null ? 'unknown' : c.total + ' 件'}（= \`standup.mjs --json\` 的 totals.pendingDecision，同源）`);
  L.push(`     其中本线自己的 ${c.selfCardsExcludedFromTotal} 张已排除 ⇒ 跨线 ${c.crossLine} 件`);
  L.push(`     上桌 ${c.raised} 件 / 压着 ${c.backlog} 件${c.status === 'red' ? ' —— 🔴 压着的比上桌的多，**不许装绿**' : ''}`);
  L.push(`  已排除本线卡 ${report.excluded.selfCards} 张 · 已排除本线能力账 ${report.excluded.selfCapability} 条 · 已失效剔除（done/archived/running）${report.excluded.deadStatus} 张`);
  if (stateInfo && stateInfo.state) {
    const attAll = normalizeAttentions(stateInfo.state);
    const attOpen = attAll.filter((x) => !x.answeredAt).length;
    L.push(`  attentions（C10 唯一来源 = state）：未答 ${attOpen} 条 / 已答 ${attAll.length - attOpen} 条 · 卡面文本不参与统计`);
  }
  L.push('');

  // ── 账本
  if (stateInfo) {
    L.push('━━ 流水账 ━━');
    L.push(`  decisions ${stateInfo.decisionCount} 条 · instructions ${stateInfo.instructionCount} 条（本轮新增 ${stateInfo.addedInstructions}）· raiseCounts ${stateInfo.raiseCount} 条（本轮新增 ${stateInfo.addedRaises}）`);
    L.push(`  本轮登记的 ${stateInfo.addedInstructions} 条建议 channel=none、status=suggested —— **本件不发喊话**（方案 §1.3）`);
    L.push(`  未投递（只是建议）：${stateInfo.state.instructions.filter((x) => x.status === 'suggested').length} 条`);
    L.push('');
  }

  // ── 并行可行性 + 在跑的会话（方案 §4.4 / §4.5 · 甲层 C6 新增）
  L.push('━━ 并行可行性（按卡面文本近似，非结论）━━');
  const col = report.collision || { hitRate: 0, hitCount: 0, judgedCount: 0, items: [] };
  const colPct = Math.round((col.hitRate || 0) * 100);
  L.push(`  命中率 ${colPct}%（独占+互斥 ${col.hitCount ?? 0}/${col.judgedCount ?? 0}）${colPct > 30 ? ' 🟡 区分度低，别当结论' : ''} · guessed=true：看板卡没有"我要改哪些文件"字段`);
  for (const x of (col.items || []).filter((i) => i.verdict !== '待人工判').slice(0, 5)) {
    const riv = x.rivals && x.rivals.length ? ` ⇄ ${x.rivals.map((r) => String(r).slice(0, 8)).join(',')}` : '';
    L.push(`     · ${x.verdict}：卡 ${String(x.cardId).slice(0, 8)}${riv} —— ${String(x.evidence).slice(0, 60)}`);
  }
  L.push('');

  L.push('━━ 在跑的会话（只读标题 + updatedAt，不读正文）━━');
  const ss = report.sessions;
  if (!ss) {
    L.push('  🟡 本次没取（report.sessions 缺失）⇒ 这一路是空的，别当成"没有会话在跑"');
  } else if (!ss.ok) {
    L.push(`  🟡 读不到：${ss.reason ?? '?'} ⇒ 这一路是空的，别当成"没有会话在跑"`);
  } else {
    L.push(`  ${ss.runningCount} 条 running · ${ss.answeredPendingCount} 条疑似"待回答" · 已排除本线 ${ss.excludedSelf} 条 / 空壳 ${ss.blankExcluded} 条 / 已完成 ${ss.completedSkipped} 条`);
    for (const s of ss.items.filter((x) => x.running || x.answeredPending).slice(0, 8)) {
      L.push(`     · [${s.mark || '—'}] ${String(s.title).replace(/^【[^】]*】\s*/, '').slice(0, 40)}${s.answeredPending ? '（疑似待回答）' : ''}`);
    }
  }
  L.push('');

  if (report.warnings.length) {
    L.push('━━ 黄 / 红（fail-open：报出来，不静默）━━');
    for (const w of report.warnings) L.push(`  ${w.level === 'red' ? '🔴' : '🟡'} ${w.message}`);
  } else {
    L.push('━━ 黄 / 红 ━━ 0 条');
  }
  L.push('');
  L.push(`（输出判据：方案 v0.5 §4.1 四条排序 / §6 两条线 / §4.3③ 自举排除 · 本件只读不写别人 · 不叫停不建卡不验收）`);
  return L.join('\n');
}

// ---------------------------------------------------------------- 广播（C7 · 方案 §4.5.1 判活三查 + §1.3 通道）
//
// 为什么有这一段（方案 §4.5.1 反例 + 2026-11-02 01:40 手工喊 9 条）：
//   `session-say` 只校验三件（存在 / 未归档 / 未交接）⇒ **空壳会话在这三条上全都"合格"**。
//   所以"一条结论派给所有活主线"必须先判活：缺一不投，挡掉的也要留回执。

/**
 * 判活 ① 的「带项目名」：剥掉**所有** `【…】` 前缀后剩下的实质文本。
 *   `【运行】【续】示例主线 · 赛博生活` ⇒ `示例主线 · 赛博生活`；`【运行】` 或默认标题 ⇒ `''`。
 * ⚠️ 只做**形状**判断（不判断项目真伪，判伪要读内容，撞 §5 第一条 policy）。
 */
export function projectNameOf(title) {
  let rest = String(title ?? '').trim();
  for (let i = 0; i < 3 && /^【[^】]*】/.test(rest); i++) rest = rest.replace(/^【[^】]*】\s*/, '');
  rest = rest.trim();
  if (!rest || DEFAULT_TITLE_RE.test(rest)) return '';
  return rest;
}

/**
 * 读广播候选 = **原始** `session.list`（不预先过滤）。
 * 与 C6 的 `loadSessions` 的区别：C6 服务于"在跑的会话"统计，会先剔掉 blank / 本线 / 已完成；
 *   广播要对**每条**都给回执（挡掉的也要写理由），所以这里拿原始条目，过滤交给 `planBroadcast`。
 * 取数字段 = `sessionId / projections.values.title / running / updatedAt / blank / cwd`；
 *   🔴 不读会话正文、不解 `session.v4.jsonl.zstd`、不 `fs.stat`。
 */
export async function loadSessionCandidates({ base = process.env.STEWARD_SESSION_BASE || SESSIONS_DEFAULT_BASE, timeoutMs = 20_000, rpc = null, now = Date.now() } = {}) {
  const t0 = Date.now();
  const note = '只取 sessionId/title/running/updatedAt/blank/cwd；不读正文、不解 zstd、不 fs.stat；'
    + '过不过判活由 planBroadcast 判（挡掉的也留回执）';
  try {
    const call = typeof rpc === 'function' ? rpc : hostRpc;
    const r = await call(base, 'session.list', {}, { timeoutMs });
    const raw = r?.body?.result?.value?.items;
    if (!Array.isArray(raw)) throw new Error(`session.list HTTP ${Number(r?.status) || 0} 返回结构异常（没有 result.value.items）`);
    const items = raw.map((it) => {
      const title = String(it?.projections?.values?.title ?? '');
      const updatedAt = Number.isFinite(it?.updatedAt) ? it.updatedAt : 0;
      return {
        sid: String(it?.sessionId ?? it?.id ?? ''),
        title,
        mark: (title.match(/^【([^】]*)】/) || [])[1] || '',
        running: !!it?.running,
        updatedAt,
        ageDays: updatedAt ? Math.max(0, (now - updatedAt) / DAY_MS) : null,
        blank: it?.blank === true,
        cwd: String(it?.cwd ?? ''),
      };
    }).filter((x) => x.sid);
    return { ok: true, takenAt: new Date(now).toISOString(), ms: Date.now() - t0, total: raw.length, items, reason: null, note };
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || '';
    return {
      ok: false, takenAt: new Date(now).toISOString(), ms: Date.now() - t0, total: 0, items: [],
      reason: `${String(e && e.message ? e.message : e)}${cause ? ` (${cause})` : ''}`.slice(0, 200),
      note: 'session.list 拿不到 ⇒ 整轮不投（不许猜目标），退出码非 0',
    };
  }
}

/** 读 `~\.dsh\queue-bindings.json`（判活 ③ 的唯一机械来源）；读不到 ⇒ fail-open，③ 只能靠标题。 */
export function loadBindings({ home = dshHome() } = {}) {
  const p = path.join(home, 'queue-bindings.json');
  const empty = { cards: {}, lines: {} };
  try {
    if (!fs.existsSync(p)) return { ok: false, path: p, error: '绑定档不存在', ...empty };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      ok: true, path: p, error: null,
      cards: j?.cards && typeof j.cards === 'object' ? j.cards : {},
      lines: j?.lines && typeof j.lines === 'object' ? j.lines : {},
    };
  } catch (e) {
    return { ok: false, path: p, error: `绑定档读不了（${e.message}）`, ...empty };
  }
}

/** 归属索引：一次遍历出 `sid -> Set(card:xxxxxxx / line:主线名)`，避免"500 张卡 × N 会话"的二次扫描。 */
export function buildOwnershipIndex(bindings) {
  const idx = new Map();
  const add = (sid, via) => {
    const k = String(sid ?? '').trim();
    if (!k) return;
    if (!idx.has(k)) idx.set(k, new Set());
    idx.get(k).add(via);
  };
  const cards = bindings?.cards && typeof bindings.cards === 'object' ? bindings.cards : {};
  for (const [cardId, b] of Object.entries(cards)) {
    const tag = `card:${String(cardId).slice(0, 8)}`;
    add(b?.initiatorSessionId, tag);   // 这张卡是谁发起的
    add(b?.boundBy, tag);              // 谁把它绑上的
  }
  const lines = bindings?.lines && typeof bindings.lines === 'object' ? bindings.lines : {};
  for (const [line, b] of Object.entries(lines)) add(b?.ownerSessionId, `line:${line}`);
  return idx;
}

/**
 * 判活三查（方案 §4.5.1，缺一不投）—— **纯函数**，夹具直接喂。
 *   ① 标题：三态 + 项目名 ⇒ `titleSoft`（**只是快筛**：②③ 都过就照投，见 §4.5.1 边界样本）
 *   ② 有内容：`updatedAt` 在 N 天内 且 `blank !== true`
 *   ③ 有归属：有卡级 / 主线绑定，或标题带项目名
 * 另有五条硬排除：`blank` / `excluded-self`（本线 + 自己）/ `handoff`（标题含【已交接】）/
 *   `card-session`（cwd 落在 card-sessions）/ `stale`。
 * ⚠️ `handoff` 不是本件新加的规矩，是 §1.3② 的落地：`session-say` 对【已交接】目标默认拒投 rc=5，
 *   而"硬闯（--allow-handoff）"被明令禁止 ⇒ 判活阶段就挡下、把"这条线没人接"写进回执（而不是投出去再吃 rc=5）。
 * ⚠️ 方案 §4.5.1 第 ② 条原文还要求"日志里有实质消息（`seq` 不近 0）"—— 那要读会话文件，撞 §5 第一条 policy
 *    ⇒ 本件只用 `blank` + `updatedAt` 两个**可用信号**近似，这条如实记欠账（见交付报告「未查证 / 欠账」）。
 */
export function judgeAlive(item, { now = Date.now(), minAgeDays = BROADCAST_MIN_AGE_DAYS, selfSid = '', index = new Map(), includeCards = false } = {}) {
  const reasons = [];
  if (item.blank === true) reasons.push('blank');
  if (selfSid && item.sid === selfSid) reasons.push('excluded-self');
  if (SESSIONS_EXCLUDED_TITLE_RE.test(item.title)) reasons.push('excluded-self');
  if (/已交接/.test(item.title)) reasons.push('handoff');
  if (!includeCards && CARD_SESSIONS_RE.test(item.cwd)) reasons.push('card-session');
  if (!item.updatedAt || !(item.updatedAt >= now - minAgeDays * DAY_MS)) reasons.push('stale');
  const projectName = projectNameOf(item.title);
  const ownerVia = [];
  const bound = index.get(item.sid);
  if (bound) for (const v of bound) ownerVia.push(v);
  if (projectName) ownerVia.push(`title:${projectName.slice(0, 24)}`);
  if (!ownerVia.length) reasons.push('no-owner');
  const titleSoft = BROADCAST_STATUS_MARKS.has(item.mark) && !!projectName;
  const uniq = [...new Set(reasons)];
  return {
    sid: item.sid, title: item.title, mark: item.mark, running: !!item.running,
    updatedAt: item.updatedAt,
    ageDays: Number.isFinite(item.ageDays) ? Math.round(item.ageDays * 10) / 10 : null,
    blank: !!item.blank, cwd: item.cwd, projectName, titleSoft, ownerVia,
    reasons: uniq, verdict: uniq.length ? 'blocked' : 'send',
  };
}

/**
 * 判活 + 排序（running 优先、再按最近活动）+ 手滑上限（**纯函数**：零 IO、零投递）。
 * `only` = 在**合格集合里**再收窄（救火单投 / 验收实测用）；它**不能**绕过判活（挡掉的照样挡）。
 */
export function planBroadcast({ items = [], bindings = null, now = Date.now(), minAgeDays = BROADCAST_MIN_AGE_DAYS, max = BROADCAST_MAX_TARGETS, includeCards = false, selfSid = '', only = null } = {}) {
  const index = buildOwnershipIndex(bindings);
  const judged = (Array.isArray(items) ? items : [])
    .map((it) => judgeAlive(it, { now, minAgeDays, selfSid, index, includeCards }));
  const onlyList = Array.isArray(only) ? only.map((s) => String(s).trim()).filter(Boolean) : [];
  const pool = onlyList.length ? judged.filter((x) => onlyList.includes(x.sid)) : judged;
  const notSelected = judged.length - pool.length;
  const sendable = pool.filter((x) => x.verdict === 'send')
    .sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.updatedAt - a.updatedAt);
  const cap = Math.max(1, Math.floor(Number(max)) || BROADCAST_MAX_TARGETS);
  const send = sendable.slice(0, cap);
  const overMax = sendable.slice(cap).map((x) => ({ ...x, verdict: 'blocked', reasons: ['over-max'] }));
  const blocked = [...pool.filter((x) => x.verdict === 'blocked'), ...overMax];
  const reasons = {};
  for (const x of blocked) for (const r of x.reasons) reasons[r] = (reasons[r] || 0) + 1;
  return {
    candidates: judged.length, pool: pool.length, notSelected,
    sendCount: send.length, blockedCount: blocked.length, overMax: overMax.length,
    max: cap, minAgeDays, includeCards, selfSid: selfSid || null, only: onlyList,
    titleSoftMiss: send.filter((x) => !x.titleSoft).length,
    send, blocked, reasons,
  };
}

/** 每条正文末尾追加投递标记行（卡面 ② 要求）：收件人一眼看出这是协调线广播。 */
export const broadcastTrailer = (date) => `（协调线广播 · ${date} · 与你无直接关系可忽略）`;

/** 正文组装：原文 + 空行 + 标记行（唯一入口，spawn 与字节数核算共用）。 */
export function makeBroadcastText(text, { date = ymd(Date.now()) } = {}) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  return `${body}\n\n${broadcastTrailer(date)}`;
}

/** `session-say` 回包 → 回执（**唯一**判定口；退出码表见 session-say.mjs「退出码」行）。 */
export function interpretSayResult({ status = -1, stdout = '', stderr = '' } = {}) {
  const out = String(stdout ?? '');
  const err = String(stderr ?? '');
  if (Number(status) === 0 && /accepted=true/.test(out)) return { accepted: true, rc: 0, reason: null };
  const tail = (err || out).split('\n').map((s) => s.trim()).filter(Boolean).slice(-2).join(' ').slice(0, 160) || '(无输出)';
  const tag = ({ 5: 'rejected:archived-or-handoff', 4: 'rejected:self', 3: 'rejected:not-found', 2: 'rejected:usage', 1: 'failed:deliver' })[Number(status)] || 'failed:unknown';
  return { accepted: false, rc: Number(status) || -1, reason: `${tag} — ${tail}` };
}

/** 默认投递口 = spawn `session-say.mjs --apply`。🔴 不带 `--allow-handoff`（§1.3②：已交接只许上报）。 */
export function defaultSpawnSay(args) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90_000, env: process.env, windowsHide: true });
}

/**
 * 把回执写进 `instructions[]`（方案 §1.3④ 失败可见）。
 * ⚠️ **不动 `mergeState`**：它段清单里已有 `instructions`（`slice()` 保留、元素原样带回）
 *    ⇒ 只要每条都带 `date` 和幂等 `id`，甲层下一次 merge 既不抹掉、也不会重复添加。夹具 13 现跑验这条。
 */
export function appendBroadcastLedger(prev, receipts, { now = Date.now(), date = null } = {}) {
  const d = date || ymd(now);
  const at = new Date(now).toISOString();
  const p = prev && typeof prev === 'object' ? prev : {};
  const instructions = Array.isArray(p.instructions) ? p.instructions.slice() : [];
  let added = 0;
  for (const rc of Array.isArray(receipts) ? receipts : []) {
    const digest = String(rc.digest ?? '').slice(0, 40);
    const id = sha16(`${d}|${rc.to}|${digest}`);             // 幂等键（卡面 ③ 原文口径）
    if (instructions.some((x) => x.id === id)) continue;      // 同日同内容同目标 ⇒ no-op
    instructions.push({
      id, at, date: d, kind: 'report', to: String(rc.to ?? ''),
      targetTitle: String(rc.targetTitle ?? ''), accepted: !!rc.accepted,
      rc: Number.isFinite(rc.rc) ? rc.rc : -1, reason: rc.reason ?? null, digest,
    });
    added++;
  }
  // 30 天窗口（与 mergeState 对 instructions 的保留口径一致，别让它永久膨胀）
  const cutoff = now - HEARTBEAT_KEEP_DAYS * DAY_MS;
  const keepDate = (x) => {
    const t = Date.parse(`${x}T00:00:00+08:00`);
    return !Number.isFinite(t) || t >= cutoff - DAY_MS;
  };
  const kept = instructions.filter((x) => keepDate(x.date ?? (x.at ? ymd(Date.parse(x.at)) : d)));
  return { state: { ...p, instructions: kept }, added, instructionCount: kept.length };
}

/**
 * 广播主流程。**干跑 = 零写盘、零投递**（卡面 ④）。
 * @param {{text?:string, apply?:boolean, minAgeDays?:number, max?:number, includeCards?:boolean,
 *          rpc?:Function, spawnSay?:Function, home?:string, now?:number, selfSid?:string, base?:string}} [opts]
 */
export async function runBroadcast(opts = {}) {
  const {
    text = '', apply = false, minAgeDays = BROADCAST_MIN_AGE_DAYS, max = BROADCAST_MAX_TARGETS,
    includeCards = false, rpc = null, spawnSay = null, home = null,
    now = Date.now(), selfSid = process.env.DSH_SESSION_ID || '', base, only = null,
  } = opts;
  const dHome = home || dshHome();
  const date = ymd(now);
  const rawText = String(text ?? '');
  const digest = rawText.replace(/\s+/g, ' ').trim().slice(0, 40);
  const payload = makeBroadcastText(rawText, { date });
  const bodyBytes = Buffer.byteLength(payload, 'utf8');

  const sess = await loadSessionCandidates({ rpc, now, ...(base ? { base } : {}) });
  const bindings = loadBindings({ home: dHome });
  const warnings = [];
  if (!bindings.ok) warnings.push(`判活 ③ 的机械来源读不到（${bindings.error}）⇒ 只剩标题判归属，可能多判 no-owner`);
  const plan = planBroadcast({ items: sess.items, bindings, now, minAgeDays, max, includeCards, selfSid, only });

  const result = {
    ok: true, mode: apply ? 'apply' : 'dry-run', date, at: new Date(now).toISOString(),
    digest, bodyBytes, plan, receipts: [], warnings,
    statePath: null, addedInstructions: 0, instructionCount: null,
    inputs: {
      sessions: { ok: sess.ok, ms: sess.ms, total: sess.total, reason: sess.reason ?? null },
      bindings: {
        ok: bindings.ok, error: bindings.error ?? null,
        cards: Object.keys(bindings.cards || {}).length, lines: Object.keys(bindings.lines || {}).length,
      },
    },
  };

  // 硬闸：取数 / 正文 —— 任一条不通 ⇒ 整轮不投（宁可报错，不许猜目标）
  if (!sess.ok) { result.ok = false; result.error = `session.list 拿不到：${sess.reason}`; return result; }
  if (!digest) { result.ok = false; result.error = '正文是空的（--broadcast 读到的文件 / stdin 没有内容）'; return result; }
  if (bodyBytes > BROADCAST_BODY_MAX_BYTES) { result.ok = false; result.error = `正文太大（${bodyBytes} B > ${BROADCAST_BODY_MAX_BYTES} B）`; return result; }
  if (!apply) return result;                        // 🔴 干跑到此为止：零 spawn、零写盘

  // 真投：逐条 spawn 现成通道；失败不许静默
  const say = typeof spawnSay === 'function' ? spawnSay : defaultSpawnSay;
  for (const t of plan.send) {
    let raw;
    try {
      raw = say([SESSION_SAY_PATH, '--to', t.sid, '--text', payload, '--apply'], { sid: t.sid });
    } catch (e) {
      raw = { status: -1, stdout: '', stderr: String(e && e.message ? e.message : e) };
    }
    const v = interpretSayResult({ status: raw?.status, stdout: raw?.stdout, stderr: raw?.stderr });
    result.receipts.push({ to: t.sid, targetTitle: t.title, digest, ...v });
  }

  // 落账（**失败也落**：accepted:false + reason 必须能查；§1.3④ 没有这一行 = 静默失败）
  const statePath = path.join(dHome, STEWARD_STATE_FILE);
  let prev = null;
  try { prev = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null; }
  catch (e) { result.warnings.push(`旧 state 读不到（${e.message}）⇒ 按空账追加（原档还在原地，需人工核）`); prev = null; }
  const led = appendBroadcastLedger(prev, result.receipts, { now, date });
  writeTextAtomic(statePath, JSON.stringify(led.state, null, 2) + '\n', { retryDelaysMs: [50, 150, 400] });
  result.statePath = statePath;
  result.addedInstructions = led.added;
  result.instructionCount = led.instructionCount;

  const failed = result.receipts.filter((x) => !x.accepted);
  result.ok = failed.length === 0;
  if (failed.length) result.error = `${failed.length}/${result.receipts.length} 条投不出去（回执里带原因，别当没发生）`;
  return result;
}

/** 人话：会投给谁 / 为什么投 / 谁被挡了及理由（卡面 ④）。 */
export function renderBroadcast(r) {
  const p = r.plan || {};
  const L = [];
  L.push(`📣 掌柜广播（${r.mode === 'apply' ? '真投' : '干跑'}）· ${hostName()} · ${new Date(r.at).toLocaleString('zh-CN')}`);
  L.push(`结论摘要：${r.digest || '（空）'} · ${r.bodyBytes ?? 0} B · 末尾附「${broadcastTrailer(r.date)}」`);
  L.push(`会话 ${r.inputs?.sessions?.total ?? '?'} 条（判活候选 ${p.candidates ?? 0}）· 通过 ${p.sendCount ?? 0} 条 · 挡掉 ${p.blockedCount ?? 0} 条${p.overMax ? `（其中超 --max ${p.max} 的 ${p.overMax} 条）` : ''}${p.only && p.only.length ? ` · --only 收窄到 ${p.pool} 条（未选中 ${p.notSelected} 条）` : ''}`);
  if (r.inputs && r.inputs.sessions && r.inputs.sessions.ok === false) L.push(`🔴 session.list 拿不到：${r.inputs.sessions.reason ?? '?'} ⇒ 整轮不投`);
  for (const w of r.warnings || []) L.push(`🟡 ${w}`);
  L.push('');

  L.push(`━━ 会投给谁（${p.sendCount ?? 0} 条）━━`);
  if (!p.sendCount) L.push('  （没有过三查的活会话 ⇒ 一条都不投）');
  (p.send || []).forEach((x, i) => {
    const soft = x.titleSoft ? '标题快筛 ✅' : '标题快筛 ⚠️ 无三态 / 项目名 —— ②③ 都过 ⇒ 照投（§4.5.1 边界样本）';
    L.push(`  ${i + 1}. ${x.running ? '▶' : ' '} ${x.sid}  ${String(x.title || '（无标题）').slice(0, 46)}`);
    L.push(`     归属：${x.ownerVia.join(' / ')} · 最近活动 ${x.ageDays ?? '?'} 天前 · ${soft}`);
  });
  L.push('');

  L.push(`━━ 挡了谁 & 为什么（${p.blockedCount ?? 0} 条）━━`);
  if (!p.blockedCount) L.push('  （一条都没挡）');
  for (const [k, n] of Object.entries(p.reasons || {}).sort((a, b) => b[1] - a[1])) L.push(`  · ${k}：${n} 条`);
  for (const x of (p.blocked || []).slice(0, 40)) {
    L.push(`  ✗ ${x.sid}  ${String(x.title || '（无标题）').slice(0, 40)} — ${x.reasons.join('+')}`);
  }
  if ((p.blocked || []).length > 40) L.push(`  …（还有 ${p.blocked.length - 40} 条，见 --json）`);
  L.push('');

  if (r.mode === 'apply') {
    L.push(`━━ 回执（${r.receipts.length} 条 · 落账新增 ${r.addedInstructions} 条 / 共 ${r.instructionCount} 条）━━`);
    if (!r.receipts.length) L.push('  （本轮没有投递记录）');
    for (const x of r.receipts) {
      L.push(`  ${x.accepted ? '✅' : '🔴'} ${x.to}  ${x.accepted ? 'accepted=true' : `这条投不出去（rc=${x.rc}）：${x.reason}`}`);
    }
    L.push(`  state：${r.statePath}`);
  } else {
    L.push('━━ 干跑：零写盘、零投递 ━━');
    L.push('  加 `--apply` 才真投（并逐条落 instructions[]）。');
  }
  if (r.error) {
    L.push('');
    L.push(`🔴 ${r.error}`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- 夹具

/** 极简断言：失败抛错（夹具靠它区分红绿）。 */
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const mkStandup = ({ pending = [], lines = [], stale = [], totals = {} } = {}) => ({
  ledgerRevision: 999,
  lines,
  stale,
  pendingTop: pending,
  totals: { tasks: 0, live: 0, running: 0, waiting: 0, failed: 0, lines: 0, pendingDecision: pending.length, ...totals },
  staleThresholdDays: 3,
});

/**
 * 三条夹具（卡面要求，缺一条不算完成）：
 *   ① 假卡：正文含「待拍板」+ 状态已 done ⇒ **必须不算待拍板**
 *   ② 自举：属于「协调线 · 判据」自己的假卡 ⇒ **必须被排除**，且输出明写"已排除本线 N 张"
 *   ③ 坏输入：年轮 json 缺失 / 坏 JSON / 字段缺 ⇒ **不崩、报黄**（fail-open）
 * 每条都做**双向验证**：把判据关掉后，结论必须反过来 —— 否则说明夹具没有鉴别力（= 红的真原因）。
 */
export async function selftest() {
  // 夹具里会多次 `acquireTickLock`，而 store.mjs 每次成功拿锁都挂一个 `process.once('exit')`（T2 锁泄漏修复）。
  // 生产每次跑只拿 1~2 次锁，测试一次拿十几次 ⇒ 只在这里把监听上限抬高，避免 Node 的
  // MaxListenersExceededWarning 噪声（不是泄漏：夹具结束 TMP_HOMES 全删、进程退出即释放）。
  try { process.setMaxListeners(Math.max(process.getMaxListeners(), 40)); } catch { /* 抬高失败不影响结论 */ }
  const results = [];
  const run = (name, fn) => {
    try { fn(); results.push({ name, ok: true, detail: '' }); }
    catch (e) { results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) }); }
  };
  /** 需要 IO / Promise 的夹具（C6 的 session.list 注入）走这条；结果仍然进同一个 results。 */
  const runAsync = async (name, fn) => {
    try { await fn(); results.push({ name, ok: true, detail: '' }); }
    catch (e) { results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) }); }
  };

  // ===== 夹具 1：done 卡不得算待拍板 =====
  run('夹具1 · 正文含"待拍板"但状态已 done ⇒ 不算待拍板', () => {
    const cards = new Map([['fake-done-0001', { id: 'fake-done-0001', status: 'done', line: '某条线',
      description: '这张卡写着「待拍板：走 A 还是 B」但已经做完了', title: '假卡·done' }]]);
    const standup = mkStandup({ pending: [{ id: 'fake-done-0001', title: '假卡·done', line: '某条线', status: 'done', ageDays: 1 }] });
    const r = computeReport({ standup, cards, now: Date.now() });
    assert(r.raised.every((x) => x.id !== 'fake-done-0001'), 'done 卡混进了上桌清单（判据失效）');
    assert(r.allPending.every((x) => x.id !== 'fake-done-0001'), 'done 卡混进了待拍板全量（判据失效）');
    assert(r.excluded.deadStatus === 1, `已失效剔除应为 1，实际 ${r.excluded.deadStatus}`);
    // 双向：关掉生命周期过滤 ⇒ 它必须出现（否则说明这条夹具测不到东西）
    const r2 = computeReport({ standup, cards, now: Date.now() }, { isDead: () => false });
    assert(r2.allPending.some((x) => x.id === 'fake-done-0001'), '双向验证失败：关掉 isDead 后 done 卡仍被剔除 ⇒ 这条夹具没有鉴别力');
  });

  // ===== 夹具 2：本线自举排除 + 明写计数 =====
  run('夹具2 · 本线（协调线 · 判据）的卡必须被排除且明写"已排除本线 N 张"', () => {
    const cards = new Map([['fake-self-0001', { id: 'fake-self-0001', status: 'backlog', line: SELF_LINE,
      description: '本线自己的卡', title: '假卡·本线' }]]);
    const standup = mkStandup({
      pending: [{ id: 'fake-self-0001', title: '假卡·本线', line: SELF_LINE, status: 'backlog', ageDays: 9 }],
      lines: [{ line: SELF_LINE, cards: 1, running: 0, failed: 0, pending: 1, oldestAgeDays: 9 }],
    });
    const r = computeReport({ standup, cards, now: Date.now() });
    assert(r.raised.every((x) => x.id !== 'fake-self-0001'), '本线卡混进了上桌（自举悖论没堵住）');
    assert(r.excluded.selfCards === 1, `已排除本线卡应为 1，实际 ${r.excluded.selfCards}`);
    assert(r.lines.every((g) => g.line !== SELF_LINE), '本线仍出现在"哪几条线在动"里');
    const txt = renderText(r);
    assert(/已排除本线卡 1 张/.test(txt), '输出里没有明写"已排除本线卡 1 张"');
    // 双向：关掉 isSelf ⇒ 它必须冒出来
    const r2 = computeReport({ standup, cards, now: Date.now() }, { isSelf: () => false });
    assert(r2.allPending.some((x) => x.id === 'fake-self-0001'), '双向验证失败：关掉 isSelf 后本线卡仍被排除 ⇒ 这条夹具没有鉴别力');
  });

  // ===== 夹具 3：坏输入（缺失 / 坏 JSON / 字段缺）⇒ 不崩 + 报黄 =====
  run('夹具3 · 年轮 json 缺失 / 坏 JSON / 字段缺 ⇒ 不崩、报黄（fail-open）', () => {
    const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'steward-selftest-'));
    try {
      const missing = loadYearring(path.join(tmp, 'nope.json'));
      assert(missing.ok === false && /不存在/.test(missing.error || ''), `缺失没被识别：${JSON.stringify(missing)}`);

      const badPath = path.join(tmp, 'bad.json');
      fs.writeFileSync(badPath, '{ 这不是 JSON ', 'utf8');
      const bad = loadYearring(badPath);
      assert(bad.ok === false && /坏 JSON/.test(bad.error || ''), `坏 JSON 没被识别：${JSON.stringify(bad)}`);

      const noFieldPath = path.join(tmp, 'nofield.json');
      fs.writeFileSync(noFieldPath, JSON.stringify({ generatedAt: '2026-11-02T00:51:00+08:00' }), 'utf8');
      const noField = loadYearring(noFieldPath);
      assert(noField.ok === true, '能解析的档应 ok=true（字段缺由上层判）');
      const capNoField = summarizeCapability(noField, { now: Date.now() });
      assert(capNoField.ok === false && capNoField.status === 'unknown' && /字段缺/.test(capNoField.note), `字段缺没被标 unknown：${JSON.stringify(capNoField)}`);

      const standup = mkStandup({ pending: [] });
      const r = computeReport({ standup, cards: new Map(), capability: capNoField, vision: summarizeVision(noField), now: Date.now() });
      assert(r.warnings.some((w) => w.code === 'capability-unverified'), '能力账坏输入没有报黄');
      assert(r.warnings.some((w) => w.code === 'vision-unreadable'), '愿景年轮字段缺没有报黄');
      const txt = renderText(r);
      assert(/🟡/.test(txt), '人话输出里没有黄标');

      // 双向：好输入 + 新鲜 mtime ⇒ 不能报"读不到/字段缺"那类黄
      const goodPath = path.join(tmp, 'good.json');
      fs.writeFileSync(goodPath, JSON.stringify({ capabilities: [{ from: 'A线', to: '主人', what: 'x', status: 'waiting' }] }), 'utf8');
      const good = loadYearring(goodPath);
      const capGood = summarizeCapability(good, { now: Date.now() });
      assert(capGood.ok === true && capGood.fresh === true, `好输入被误判：${JSON.stringify(capGood)}`);
      assert(capGood.status === 'manual-unverified', '人工档新鲜时也必须标 manual-unverified（不计绿）');
      // 双向 2：把 mtime 改成 8 天前 ⇒ 必须 unknown
      const old = Date.now() - 8 * DAY_MS;
      fs.utimesSync(goodPath, new Date(old), new Date(old));
      const stale = summarizeCapability(loadYearring(goodPath), { now: Date.now() });
      assert(stale.fresh === false && stale.status === 'unknown', `超 7 天没标 unknown：${JSON.stringify(stale)}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
    }
  });

  // ===== 附加夹具（卡面允许加，不算替代上面三条）：幂等 + 自指能力账排除 =====
  run('附加 · 同一天连跑两遍：instructions / raiseCounts 条数不变（幂等）', () => {
    const now = Date.now();
    const standup = mkStandup({
      pending: [
        { id: 'aa11bb22', title: '卡A', line: '某线', status: 'failed', ageDays: 5 },
        { id: 'cc33dd44', title: '卡B', line: '另一线', status: 'backlog', ageDays: 9 },
      ],
    });
    const r = computeReport({ standup, cards: new Map(), now });
    const s1 = mergeState(null, r, { now });
    const s2 = mergeState(s1.state, r, { now });
    assert(s1.instructionCount === s2.instructionCount, `instructions 条数变了：${s1.instructionCount} → ${s2.instructionCount}`);
    assert(s1.raiseCount === s2.raiseCount, `raiseCounts 条数变了：${s1.raiseCount} → ${s2.raiseCount}`);
    assert(s2.addedInstructions === 0 && s2.addedRaises === 0, '第二轮仍在新增（幂等键失效）');
    const s3 = mergeState(s2.state, r, { now: now + 864e5 });
    assert(s3.instructionCount > s2.instructionCount, '换了一天却不新增 ⇒ 幂等键按日期分桶这条没生效');
  });

  run('附加 · 能力账里 from/to 含本线的自指项也要排除并计数', () => {
    const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'steward-selftest-'));
    try {
      const p = path.join(tmp, 'cap.json');
      fs.writeFileSync(p, JSON.stringify({ capabilities: [
        { from: '协调线 脑子 steward.mjs', to: '协调线 方案复审', what: '方案 0 阻断', status: 'waiting-self' },
        { from: '智能客服', to: '主人', what: '停机窗口', status: 'waiting' },
      ] }), 'utf8');
      const cap = summarizeCapability(loadYearring(p), { now: Date.now() });
      assert(cap.ok === true && cap.items.length === 1, `应剩 1 条，实际 ${cap.items.length}`);
      assert(cap.excludedSelf === 1, `应排除 1 条自指，实际 ${cap.excludedSelf}`);
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  // ===== C6（2026-11-02 · 甲层两段）：并行可行性 collision + 卡面摘要 cardText + 在跑的会话 =====
  run('夹具4 · C6 · 卡面含「重启 dsh」⇒ 独占', () => {
    const cards = new Map([['c6-alone-0001', { id: 'c6-alone-0001', title: '假卡·重启',
      description: '改完以后要重启 dsh 才生效' }]]);
    const it = buildCollision({ cards, items: [{ id: 'c6-alone-0001' }] }).items[0];
    assert(it.verdict === '独占', `应判独占，实际 ${it.verdict}`);
    assert(it.guessed === true, '每一项都必须带 guessed:true');
    assert(/重启/.test(it.evidence || ''), `evidence 没带命中原文：${it.evidence}`);
    assert(it.rivals.length === 0, '独占不该带 rivals');
  });

  run('夹具5 · C6 · 「不 / 无需 / 别 重启 dsh」⇒ 不算独占（否定式排除）', () => {
    const negs = ['这张卡**不**重启 dsh，只改文档', '无需重启 dsh，热载即生效', '别重启 dsh，等下一轮 job', '禁止重启 dsh'];
    for (const desc of negs) {
      const cards = new Map([['c6-neg-0001', { id: 'c6-neg-0001', title: '假卡·否定', description: desc }]]);
      const v = buildCollision({ cards, items: ['c6-neg-0001'] }).items[0].verdict;
      assert(v !== '独占', `否定式没排除掉：「${desc}」⇒ ${v}`);
    }
    // 双向：把否定词去掉 ⇒ 必须判独占（否则这条夹具没有鉴别力）
    const cards2 = new Map([['c6-neg-0002', { id: 'c6-neg-0002', title: '假卡·肯定', description: '改完以后要重启 dsh 才生效' }]]);
    const v2 = buildCollision({ cards: cards2, items: ['c6-neg-0002'] }).items[0].verdict;
    assert(v2 === '独占', `双向验证失败：肯定式没判独占（实际 ${v2}）`);
  });

  run('夹具6 · C6 · 两张卡都碰 tools\\dsh-butler\\ ⇒ 互斥且 rivals 互相指对', () => {
    const cards = new Map([
      ['c6-mx-0001', { id: 'c6-mx-0001', title: '卡A', description: '改 <盘>:\\workspace\\tools\\dsh-butler\\steward.mjs 的两段' }],
      ['c6-mx-0002', { id: 'c6-mx-0002', title: '卡B', description: '动 tools\\dsh-butler\\standup.mjs 的排序' }],
      ['c6-mx-0003', { id: 'c6-mx-0003', title: '卡C', description: '把 <盘>:\\workspace\\docs/ 里那句补上' }],
    ]);
    const c = buildCollision({ cards, items: ['c6-mx-0001', 'c6-mx-0002', 'c6-mx-0003'] });
    const by = new Map(c.items.map((x) => [x.cardId, x]));
    assert(by.get('c6-mx-0001').verdict === '互斥' && by.get('c6-mx-0002').verdict === '互斥',
      `同目录两卡应互斥，实际 ${by.get('c6-mx-0001').verdict} / ${by.get('c6-mx-0002').verdict}`);
    assert(by.get('c6-mx-0001').rivals.includes('c6-mx-0002') && by.get('c6-mx-0002').rivals.includes('c6-mx-0001'), 'rivals 没互相指对');
    assert(by.get('c6-mx-0003').verdict === '待人工判', `无关卡不该被判撞车：${by.get('c6-mx-0003').verdict}`);
  });

  run('夹具7 · C6 · 卡面含「只读」⇒ 可并行', () => {
    const cards = new Map([['c6-par-0001', { id: 'c6-par-0001', title: '假卡·只读',
      description: '这张卡只读不写：跑一遍查询把读数贴出来' }]]);
    const it = buildCollision({ cards, items: ['c6-par-0001'] }).items[0];
    assert(it.verdict === '可并行', `应判可并行，实际 ${it.verdict}`);
    assert(/只读/.test(it.evidence || ''), `evidence 没带命中原词：${it.evidence}`);
  });

  run('夹具8 · C6 · 什么都不命中 ⇒ 待人工判（不许编）', () => {
    const cards = new Map([['c6-man-0001', { id: 'c6-man-0001', title: '假卡·判不出',
      description: '把这批截图按时间排好，顺手看看哪张更清楚' }]]);
    const it = buildCollision({ cards, items: ['c6-man-0001'] }).items[0];
    assert(it.verdict === '待人工判', `判不出就该写待人工判，实际 ${it.verdict}`);
    assert(it.rivals.length === 0, '待人工判不该带 rivals');
  });

  run('夹具9 · C6 · 4 张卡 3 张独占 ⇒ hitRate 0.75 > 0.3 ⇒ warnings 里有黄条', () => {
    const cards = new Map([
      ['c6-hr-0001', { id: 'c6-hr-0001', title: '卡1', description: '改完重启 dsh 生效' }],
      ['c6-hr-0002', { id: 'c6-hr-0002', title: '卡2', description: '顺手改 persona 的那一条' }],
      ['c6-hr-0003', { id: 'c6-hr-0003', title: '卡3', description: '改 guard 的判据' }],
      ['c6-hr-0004', { id: 'c6-hr-0004', title: '卡4', description: '只读：把读数贴出来' }],
    ]);
    const mkPending = (ids) => mkStandup({ pending: ids.map((id, i) => ({ id, title: `卡${i + 1}`,
      line: i % 2 ? '另一线' : '某线', status: 'backlog', ageDays: 3 })) });
    const r = computeReport({ standup: mkPending(['c6-hr-0001', 'c6-hr-0002', 'c6-hr-0003', 'c6-hr-0004']), cards, now: Date.now() });
    assert(r.collision.judgedCount === 4 && r.collision.hitCount === 3,
      `判据读数不对：${r.collision.hitCount}/${r.collision.judgedCount}`);
    assert(Math.abs(r.collision.hitRate - 0.75) < 1e-9, `hitRate 应为 0.75，实际 ${r.collision.hitRate}`);
    assert(r.warnings.some((w) => w.code === 'collision-hitrate' && w.level === 'yellow'), '命中率 >30% 没有报黄');
    // 双向：4 张全"只读" ⇒ hitRate 0 ⇒ 不许报黄
    const cards2 = new Map(['c6-hr-0001', 'c6-hr-0002', 'c6-hr-0003', 'c6-hr-0004']
      .map((id) => [id, { id, title: id, description: '只读：贴读数' }]));
    const r2 = computeReport({ standup: mkPending(['c6-hr-0001', 'c6-hr-0002', 'c6-hr-0003', 'c6-hr-0004']), cards: cards2, now: Date.now() });
    assert(r2.collision.hitRate === 0 && !r2.warnings.some((w) => w.code === 'collision-hitrate'),
      '双向验证失败：命中率 0 仍报黄 ⇒ 这条夹具没有鉴别力');
  });

  await runAsync('夹具10 · C6 · 假 session.list（注入，不连 3080）⇒ runningCount / excludedSelf / blank 过滤对', async () => {
    // 夹具注入方式 = `loadSessions({ rpc })`（**生产路径仍走 hostRpc**，不硬连任何东西）
    const fake = async () => ({ status: 200, body: { result: { ok: true, value: { items: [
      { sessionId: 'sess-run-0001', running: true, updatedAt: 1793557149070, blank: false,
        projections: { values: { title: '【运行】视频线 · 大改造' } } },
      { sessionId: 'sess-hand-0002', running: false, updatedAt: 1793557000000, blank: false,
        projections: { values: { title: '【已交接】一束光 · 第 5 棒' } } },
      { sessionId: 'sess-blank-0003', running: false, updatedAt: 1793556000000, blank: true,
        projections: { values: { title: '' } } },
      { sessionId: 'sess-self-0004', running: true, updatedAt: 1793557200000, blank: false,
        projections: { values: { title: '【运行】掌柜协调线 · 第 4 棒' } } },
      { sessionId: 'sess-ans-0005', running: false, updatedAt: 1793557300000, blank: false,
        projections: { values: { title: '【运行】关务 · 待回答：走 A 还是 B' } } },
    ] } } } });
    const s = await loadSessions({ rpc: fake, now: 1793557400000 });
    assert(s.ok === true, `应取到：${JSON.stringify(s).slice(0, 200)}`);
    assert(s.excludedSelf === 1, `本线会话应排除 1 条（标题含「掌柜」），实际 ${s.excludedSelf}`);
    assert(s.blankExcluded === 1, `空壳会话应排除 1 条，实际 ${s.blankExcluded}`);
    assert(s.items.every((x) => x.blank === false), 'items 里混进了 blank 会话');
    assert(s.items.some((x) => x.id === 'sess-run-0001' && x.mark === '运行' && x.running === true), '【运行】那条没正确解析 mark/running');
    assert(s.items.some((x) => x.id === 'sess-hand-0002' && x.mark === '已交接'), '【已交接】那条没正确解析 mark');
    assert(s.runningCount === 1, `runningCount 应为 1（另一条 running 是本线已排除），实际 ${s.runningCount}`);
    assert(s.answeredPendingCount === 1 && s.items.find((x) => x.answeredPending).guessed === true, '「待回答」近似判定/guessed 标没对');
    assert(s.items.every((x) => x.guessed === true), '每条 items 都必须带 guessed:true');
    assert(s.items[0].id === 'sess-run-0001', '排序应把 running 的排在最前');
  });

  await runAsync('夹具11 · C6 · session.list 抛错/超时 ⇒ ok:false + 黄条 + 不崩；desc400 去标记且 ≤600 字', async () => {
    const boom = async () => { throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3999'); };
    const s = await loadSessions({ rpc: boom, now: Date.now() });
    assert(s.ok === false && Array.isArray(s.items) && s.items.length === 0, '取不到时应 ok:false + 空 items');
    assert(s.reason && s.reason.length <= 200, `reason 必须是 ≤200 字的错误文本：${s.reason}`);
    const timeout = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
    const s2 = await loadSessions({ rpc: timeout });
    assert(s2.ok === false && /timeout/i.test(s2.reason || ''), `超时没走 fail-open：${s2.reason}`);

    const standup = mkStandup({ pending: [{ id: 'c6-txt-0001', title: '卡T', line: '某线', status: 'backlog', ageDays: 4 }] });
    const cards = new Map([['c6-txt-0001', { id: 'c6-txt-0001', title: '卡T', description:
      '<!-- DoR:begin -->\n- DoR 一堆模板\n<!-- DoR:end -->\n正文在这里：只读本文档。\n<!-- DoD:begin -->\n- DoD 十条\n<!-- DoD:end -->\n'
      + '补'.repeat(2000) }]]);
    const r = computeReport({ standup, cards, now: Date.now() });
    attachSessions(r, s);
    assert(r.sessions.ok === false, 'report.sessions 没挂上');
    assert(r.warnings.some((w) => w.code === 'sessions-unavailable' && w.level === 'yellow'), '取不到会话没有报黄');
    const txt = r.cardText['c6-txt-0001'];
    assert(txt && txt.title === '卡T', 'cardText 应带 title');
    assert(txt.desc400.length <= 600, `desc400 必须 ≤600 字，实际 ${txt.desc400.length}`);
    assert(!/<!--\s*Do[RD]:begin/.test(txt.desc400), 'desc400 里还留着 DoR/DoD 标记');
    assert(!/DoR 一堆模板|DoD 十条/.test(txt.desc400), 'desc400 没去掉 DoR/DoD 标记块的内容');
    assert(/正文在这里/.test(txt.desc400), 'desc400 把正文也删掉了（应只删标记块）');
    const human = renderText(r);
    assert(/在跑的会话/.test(human) && /读不到/.test(human), '人话输出没写出"会话读不到"');
  });

  run('夹具12 · C6 · 全库惯例路径（df ≥ max(8, 2%)）不进互斥判据（否则 99.6% 的卡都"撞车"）', () => {
    const boiler = '收尾要跑 <盘>:\\workspace\\tools\\dsh-butler\\changelog-add.mjs 记一行';
    const cards = new Map();
    for (let i = 0; i < 8; i++) cards.set(`c6-df-000${i}`, { id: `c6-df-000${i}`, title: `卡${i}`, description: boiler });
    for (const id of ['c6-df-9001', 'c6-df-9002']) cards.set(id, { id, title: id, description: boiler });
    const c = buildCollision({ cards, items: ['c6-df-9001', 'c6-df-9002'] });
    assert(c.keyPruneMaxDf === 8, `剪枝阈值应为 8，实际 ${c.keyPruneMaxDf}`);
    assert(c.items.every((x) => x.verdict === '待人工判'), `惯例路径不该判互斥：${JSON.stringify(c.items.map((x) => x.verdict))}`);
    // 双向：同样两张卡放进小库（df 小）⇒ 必须判互斥
    const small = new Map([['a1', { id: 'a1', title: 'a1', description: boiler }], ['a2', { id: 'a2', title: 'a2', description: boiler }]]);
    const c2 = buildCollision({ cards: small, items: ['a1', 'a2'] });
    assert(c2.items.every((x) => x.verdict === '互斥'), `双向验证失败：小库里同路径没判互斥 ⇒ ${JSON.stringify(c2.items.map((x) => x.verdict))}`);
  });

  // ===== C7（2026-11-02 · 广播器具）：判活三查 + 回执 + 落账 + 干跑 + 幂等 =====
  // 全部注入假数据：`rpc` 假 session.list、`spawnSay` 假投递器、`home` 临时目录（**不连真 3080、不写真 state**）。
  const TMP_HOMES = [];
  const mkSessItems = (list) => list.map((x) => ({
    sessionId: x.sid, updatedAt: x.updatedAt, running: !!x.running, blank: !!x.blank,
    cwd: x.cwd ?? '<盘>:\\workspace', projections: { values: { title: x.title } },
  }));
  const mkRpc = (list) => async () => ({ status: 200, body: { result: { ok: true, value: { items: mkSessItems(list) } } } });
  const mkHome = (bindings = null) => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'steward-bcast-'));
    TMP_HOMES.push(dir);
    if (bindings) fs.writeFileSync(path.join(dir, 'queue-bindings.json'), JSON.stringify(bindings), 'utf8');
    return dir;
  };
  const OK_SAY = { status: 0, stdout: '✅ 已投递（accepted=true · mode=queue）', stderr: '' };
  const mkSay = (behave = () => OK_SAY) => {
    const calls = [];
    const fn = (args, extra) => { calls.push({ args, extra }); return behave(args); };
    fn.calls = calls;
    return fn;
  };
  const NOW = 1793557400000;
  const LIVE = { sid: 'fixture-session-a', title: '【运行】示例主线 · 赛博生活',
    updatedAt: NOW - 3600e3, running: true, blank: false, cwd: '<盘>:\\workspace' };
  const live = (over = {}) => ({ ...LIVE, ...over });
  const shaOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  await runAsync('夹具13 · C7 · 判活三查全过 ⇒ 投；spawn 只调 1 次且参数含该 sid', async () => {
    const home = mkHome();
    const say = mkSay();
    const r = await runBroadcast({ text: '一条测试结论', apply: true, rpc: mkRpc([live()]), spawnSay: say, home, now: NOW });
    assert(r.plan.sendCount === 1 && r.plan.blockedCount === 0, `应 1 投 0 挡，实际 ${r.plan.sendCount}/${r.plan.blockedCount}`);
    assert(say.calls.length === 1, `spawn 应恰好 1 次，实际 ${say.calls.length}`);
    assert(say.calls[0].args.includes(LIVE.sid), 'spawn 参数里没有该 sid');
    assert(say.calls[0].args.includes('--apply'), '真投必须带 --apply');
    assert(!say.calls[0].args.includes('--allow-handoff'), '不许带 --allow-handoff（§1.3②）');
    assert(r.receipts[0].accepted === true && r.receipts[0].rc === 0, `回执不对：${JSON.stringify(r.receipts[0])}`);
    assert(r.ok === true, '全投成功时 ok 应为 true');
  });

  run('夹具14 · C7 · 标题无三态但 ②③ 过 ⇒ 仍投（§4.5.1 边界样本）', () => {
    const plan = planBroadcast({ items: [{ ...LIVE, title: '生活实例维护与排查', updatedAt: NOW - 3600e3, ageDays: 0.04 }], bindings: null, now: NOW, selfSid: '' });
    assert(plan.sendCount === 1, `应照投，实际 sendCount=${plan.sendCount}（理由 ${JSON.stringify(plan.blocked[0]?.reasons)}）`);
    assert(plan.send[0].titleSoft === false, '无三态时 titleSoft 必须为 false（快筛只是快筛）');
    assert(plan.send[0].ownerVia.some((v) => v.startsWith('title:')), '归属应来自标题项目名');
  });

  run('夹具15 · C7 · blank:true ⇒ 不投，回执写 blank', () => {
    const plan = planBroadcast({ items: [{ ...LIVE, blank: true, ageDays: 0.04 }], bindings: null, now: NOW, selfSid: '' });
    assert(plan.sendCount === 0, '空壳会话被投了');
    assert(plan.blocked[0].reasons.includes('blank'), `回执没写 blank：${JSON.stringify(plan.blocked[0].reasons)}`);
    assert(plan.reasons.blank === 1, '按理由计数里没有 blank');
  });

  run('夹具16 · C7 · updatedAt 超 3 天 ⇒ 不投，回执写 stale', () => {
    const old = { ...LIVE, updatedAt: NOW - 4 * DAY_MS };
    const plan = planBroadcast({ items: [old], bindings: null, now: NOW, selfSid: '' });
    assert(plan.sendCount === 0, '4 天没动的会话被投了');
    assert(plan.blocked[0].reasons.includes('stale'), `回执没写 stale：${JSON.stringify(plan.blocked[0].reasons)}`);
    // 双向：把时间改回 1 小时前 ⇒ 必须过（否则这条夹具没有鉴别力）
    const plan2 = planBroadcast({ items: [{ ...LIVE, updatedAt: NOW - 3600e3 }], bindings: null, now: NOW, selfSid: '' });
    assert(plan2.sendCount === 1, '双向验证失败：新鲜会话没被放行');
  });

  run('夹具17 · C7 · 无归属且标题无项目名 ⇒ 不投，回执写 no-owner', () => {
    const plan = planBroadcast({ items: [{ ...LIVE, title: '【运行】', ageDays: 0.04 }], bindings: null, now: NOW, selfSid: '' });
    assert(plan.sendCount === 0, '无主会话被投了');
    assert(plan.blocked[0].reasons.includes('no-owner'), `回执没写 no-owner：${JSON.stringify(plan.blocked[0].reasons)}`);
    // 双向：给同一 sid 一条主线绑定 ⇒ 必须放行（③ 的机械来源真的在用）
    const plan2 = planBroadcast({
      items: [{ ...LIVE, title: '【运行】', ageDays: 0.04 }],
      bindings: { cards: {}, lines: { '示例主线 · 赛博生活': { ownerSessionId: LIVE.sid } } }, now: NOW, selfSid: '',
    });
    assert(plan2.sendCount === 1 && plan2.send[0].ownerVia.some((v) => v.startsWith('line:')), '绑定没被识别成归属');
  });

  run('夹具18 · C7 · 本线会话 ⇒ 排除，回执写 excluded-self（标题 / 自己 sid 两条路）', () => {
    const byTitle = planBroadcast({ items: [{ ...LIVE, title: '【运行】掌柜协调线 · 第 5 棒', ageDays: 0.04 }], bindings: null, now: NOW, selfSid: '' });
    assert(byTitle.sendCount === 0 && byTitle.blocked[0].reasons.includes('excluded-self'), `标题含「掌柜」没排除：${JSON.stringify(byTitle.blocked[0])}`);
    const bySid = planBroadcast({ items: [live()], bindings: null, now: NOW, selfSid: LIVE.sid });
    assert(bySid.sendCount === 0 && bySid.blocked[0].reasons.includes('excluded-self'), '自己那条没排除（会投给自己）');
  });

  run('夹具19 · C7 · cwd 落在 card-sessions ⇒ 跳过（--include-cards 才放行）', () => {
    const card = { ...LIVE, cwd: '<盘>:\\workspace\\card-sessions' };
    const plan = planBroadcast({ items: [card], bindings: null, now: NOW, selfSid: '' });
    assert(plan.sendCount === 0 && plan.blocked[0].reasons.includes('card-session'), `卡执行会话没跳过：${JSON.stringify(plan.blocked[0])}`);
    const plan2 = planBroadcast({ items: [card], bindings: null, now: NOW, selfSid: '', includeCards: true });
    assert(plan2.sendCount === 1, '--include-cards 没生效');
  });

  await runAsync('夹具20 · C7 · session-say 回 rc=5 ⇒ 回执 rejected + ok=false（退出码不为 0）', async () => {
    const home = mkHome();
    const say = mkSay(() => ({ status: 5, stdout: '', stderr: '✗ 目标已归档（archivedSessionIds）⇒ 拒投' }));
    const r = await runBroadcast({ text: '一条测试结论', apply: true, rpc: mkRpc([live()]), spawnSay: say, home, now: NOW });
    assert(r.receipts.length === 1 && r.receipts[0].accepted === false, 'rc=5 被当成投递成功了');
    assert(r.receipts[0].rc === 5, `rc 记错了：${r.receipts[0].rc}`);
    assert(/rejected:archived-or-handoff/.test(r.receipts[0].reason || ''), `回执没写拒投原因：${r.receipts[0].reason}`);
    assert(r.ok === false, '有投不出去的时候 ok 必须 false（否则退出码会装绿）');
    assert(/投不出去/.test(renderBroadcast(r)), '人话输出没明写"这条投不出去"');
    // 失败也落账：accepted:false 的条目必须在 instructions[] 里
    const st = JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'));
    assert(st.instructions.length === 1 && st.instructions[0].accepted === false, '投失败的没落账（=静默失败）');
    assert(st.instructions[0].reason, '落账条目缺 reason');
  });

  await runAsync('夹具21 · C7 · 干跑 ⇒ spawn 次数 = 0 且 state 文件 sha 不变', async () => {
    const home = mkHome();
    const statePath = path.join(home, STEWARD_STATE_FILE);
    const seeded = { schemaVersion: 1, decisions: [{ id: 'keepme' }], instructions: [], reports: [], raiseCounts: [], heartbeat: { runs: 7 } };
    fs.writeFileSync(statePath, JSON.stringify(seeded, null, 2) + '\n', 'utf8');
    const before = shaOf(statePath);
    const say = mkSay();
    const r = await runBroadcast({ text: '一条测试结论', apply: false, rpc: mkRpc([live()]), spawnSay: say, home, now: NOW });
    const after = shaOf(statePath);
    assert(r.mode === 'dry-run', `mode 应为 dry-run，实际 ${r.mode}`);
    assert(say.calls.length === 0, `干跑却 spawn 了 ${say.calls.length} 次`);
    assert(before === after, `干跑改了 state（sha ${before.slice(0, 12)} → ${after.slice(0, 12)}）`);
    assert(r.statePath === null && r.addedInstructions === 0, '干跑不该记状态路径 / 落账条数');
    assert(r.plan.sendCount === 1, '干跑也要算出"会投给谁"（否则干跑没意义）');
    assert(/干跑/.test(renderBroadcast(r)), '人话输出没标干跑');
  });

  await runAsync('夹具22 · C7 · 幂等：同日同内容跑两遍 --apply ⇒ instructions[] 不重复（按 id）', async () => {
    const home = mkHome();
    const say = mkSay();
    const r1 = await runBroadcast({ text: '一条测试结论', apply: true, rpc: mkRpc([live()]), spawnSay: say, home, now: NOW });
    const r2 = await runBroadcast({ text: '一条测试结论', apply: true, rpc: mkRpc([live()]), spawnSay: say, home, now: NOW });
    assert(r1.addedInstructions === 1 && r1.instructionCount === 1, `第一遍落账不对：${r1.addedInstructions}/${r1.instructionCount}`);
    assert(r2.addedInstructions === 0 && r2.instructionCount === 1, `第二遍重复落账：added=${r2.addedInstructions} 共=${r2.instructionCount}`);
    const st = JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'));
    const ids = st.instructions.map((x) => x.id);
    assert(new Set(ids).size === ids.length, 'instructions[] 里出现重复 id');
    assert(st.instructions[0].kind === 'report' && st.instructions[0].to === LIVE.sid, `落账字段不对：${JSON.stringify(st.instructions[0])}`);
  });

  run('夹具23 · C7 · 超 --max ⇒ 多出来的记 over-max（防手滑投一大堆）', () => {
    const many = [0, 1, 2, 3].map((i) => ({ ...LIVE, sid: `fixture-bcast-${i}`, title: `【运行】第${i}条线 · 活`, updatedAt: NOW - (i + 1) * 60e3 }));
    const plan = planBroadcast({ items: many, bindings: null, now: NOW, selfSid: '', max: 2 });
    assert(plan.sendCount === 2 && plan.overMax === 2, `max=2 应 2 投 2 挡，实际 ${plan.sendCount}/${plan.overMax}`);
    assert(plan.reasons['over-max'] === 2, 'over-max 没进理由计数');
  });

  run('夹具24 · C7 · 广播落的 instructions[] 过一遍 mergeState 不被抹掉（B2 教训现跑验）', () => {
    const led = appendBroadcastLedger(null, [{ to: LIVE.sid, targetTitle: LIVE.title, digest: '摘要', accepted: true, rc: 0, reason: null }], { now: NOW });
    assert(led.state.instructions.length === 1, '落账没写进去');
    const r = computeReport({ standup: mkStandup({ pending: [] }), cards: new Map(), now: NOW });
    const merged = mergeState(led.state, r, { now: NOW });
    const kept = merged.state.instructions.find((x) => x.to === LIVE.sid);
    assert(kept, 'mergeState 把广播落账抹掉了（B2 复发）');
    assert(kept.accepted === true && kept.rc === 0 && kept.digest === '摘要', `mergeState 丢了字段：${JSON.stringify(kept)}`);
    assert(merged.state.instructions.every((x) => typeof x.date === 'string'), '每条 instructions 必须带 date（否则 30 天窗口算不出来）');
  });

  run('夹具25 · C7 · 标题含【已交接】⇒ 判活阶段就挡 handoff（§1.3② 不许硬闯，否则真投必吃 rc=5）', () => {
    const plan = planBroadcast({ items: [{ ...LIVE, title: '【已交接】一束光 · 第 5 棒', ageDays: 0.04 }], bindings: null, now: NOW, selfSid: '' });
    assert(plan.sendCount === 0, '已交接的会话被投了（session-say 会 rc=5，且 §1.3② 禁止 --allow-handoff 硬闯）');
    assert(plan.blocked[0].reasons.includes('handoff'), `回执没写 handoff：${JSON.stringify(plan.blocked[0].reasons)}`);
    // 双向：同一标题把「已交接」去掉 ⇒ 必须放行（否则说明这条判据把正常会话也挡了）
    const plan2 = planBroadcast({ items: [{ ...LIVE, title: '【待续】一束光 · 第 5 棒', ageDays: 0.04 }], bindings: null, now: NOW, selfSid: '' });
    assert(plan2.sendCount === 1, '双向验证失败：【待续】的活线被误挡了');
  });

  run('夹具26 · C7 · --only 只收窄合格集合（挡掉的照样挡，不许拿它绕过判活）', () => {
    const b = { ...LIVE, sid: 'fixture-session-b', title: '【运行】另一条线 · 活', updatedAt: NOW - 7200e3 };
    const plan = planBroadcast({ items: [live(), b], bindings: null, now: NOW, selfSid: '', only: [b.sid] });
    assert(plan.pool === 1 && plan.notSelected === 1, `pool/notSelected 不对：${plan.pool}/${plan.notSelected}`);
    assert(plan.sendCount === 1 && plan.send[0].sid === b.sid, '--only 没把投递范围收到那条');
    const staleOne = { ...LIVE, sid: 'fixture-session-c', title: '【运行】老线 · 活', updatedAt: NOW - 9 * DAY_MS };
    const plan2 = planBroadcast({ items: [b, staleOne], bindings: null, now: NOW, selfSid: '', only: [staleOne.sid] });
    assert(plan2.sendCount === 0 && plan2.blocked[0].reasons.includes('stale'), '--only 绕过判活了（stale 的还会被投）');
  });

  // ===== C8（2026-11-02 · 方案 §1.7.4 第一行「乙层接进 08:20」）：hook 六条 =====
  // 全部注入：`spawnAdvice` 假器具（**绝不真 spawn**、不连 3080）、home 临时目录（**不写真 state**）。
  const mkHome8 = () => {
    const d = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'steward-hook-'));
    TMP_HOMES.push(d);
    return d;
  };
  const mkHookSpawn = (behave = () => ({ status: 0, stdout: 'steward-advice\n  建议 2 条', stderr: '' })) => {
    const calls = [];
    const fn = (args, extra) => { calls.push({ args, extra }); return behave(args, extra); };
    fn.calls = calls;
    return fn;
  };
  const HOOK_NOW = 1793600400000;   // 固定时刻（夹具不读墙钟）

  await runAsync('夹具27 · C8 · 成功路径 ⇒ hook 恰好 1 次、参数含 --apply、skipped=false', async () => {
    const sp = mkHookSpawn();
    const h = await runAdviceHook({ spawnAdvice: sp, home: mkHome8(), now: HOOK_NOW });
    assert(sp.calls.length === 1, `hook 应恰好 1 次，实际 ${sp.calls.length}`);
    assert(sp.calls[0].args.includes('--apply'), 'hook 没带 --apply（不带 = 不写盘不调模型 = 白跑）');
    assert(sp.calls[0].args.some((a) => String(a).endsWith('steward-advice.mjs')), 'hook 没指向 steward-advice.mjs');
    assert(h.rc === 0 && h.skipped === false && h.reason === 'ok', `结果不对：${JSON.stringify(h)}`);
    assert(typeof h.ms === 'number' && typeof h.at === 'string' && /^\d{4}-/.test(h.at), 'at/ms 形状不对');
  });

  await runAsync('夹具28 · C8 · 乙层 rc≠0 ⇒ 甲层 rc 仍 0；lastAdviceHook 记 rc + reason', async () => {
    const sp = mkHookSpawn(() => ({ status: 2, stdout: '', stderr: '🔴 没有凭证 DEEPSEEK_API_KEY' }));
    const h = await runAdviceHook({ spawnAdvice: sp, home: mkHome8(), now: HOOK_NOW });
    assert(h.rc === 2 && h.skipped === true, `rc 应记 2 且 skipped：${JSON.stringify(h)}`);
    assert(/rc=2/.test(h.reason) && /没有凭证/.test(h.reason), `reason 要带 rc 与 stderr 摘录：${h.reason}`);
    // 甲层退出码不受影响：hook 结果里不许带任何"能改甲层 rc"的字段
    assert(!('exitCode' in h) && !('code' in h), 'hook 结果里不该带退出码字段（甲层 rc 只由甲层自己定）');
    // 乙层"今天已跑过"⇒ rc=0 但要标 skipped（没花钱，不算失败也不算跑过）
    const h2 = await runAdviceHook({ spawnAdvice: mkHookSpawn(() => ({ status: 0, stdout: '  今天已经跑过了（4 条记录），不重调模型。', stderr: '' })), home: mkHome8(), now: HOOK_NOW });
    assert(h2.rc === 0 && h2.skipped === true && h2.reason === 'already-ran', `已是"今天已跑过"没被识别：${JSON.stringify(h2)}`);
  });

  await runAsync('夹具29 · C8 · 子进程超时 ⇒ 记 timeout + killed，甲层不崩', async () => {
    const sp = mkHookSpawn(() => ({ status: null, stdout: '', stderr: '', signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }) }));
    const h = await runAdviceHook({ spawnAdvice: sp, home: mkHome8(), now: HOOK_NOW, timeoutMs: ADVICE_HOOK_TIMEOUT_MS });
    assert(h.killed === true && /timeout/.test(h.reason), `超时没被识别：${JSON.stringify(h)}`);
    assert(new RegExp(String(ADVICE_HOOK_TIMEOUT_MS)).test(h.reason), `reason 里应写明超时阈值：${h.reason}`);
    assert(ADVICE_HOOK_TIMEOUT_MS <= 120_000, '超时阈值超过了 tickd 180s 预算的合理占比（≥120s 就等于没上限）');
    // spawn 直接抛异常也不许把甲层带崩
    const h2 = await runAdviceHook({ spawnAdvice: () => { throw new Error('ENOENT node.exe'); }, home: mkHome8(), now: HOOK_NOW });
    assert(h2.skipped === true && /spawn-error/.test(h2.reason), `spawn 抛错没折成原因：${JSON.stringify(h2)}`);
  });

  run('夹具30 · C8 · 总开关关掉（env 四种写法 / state 布尔）⇒ hook 0 次；缺省必须开', () => {
    for (const v of ['off', '0', 'false', 'no']) {
      const g = adviceHookGate({ argv: [], noWrite: false, env: { [ADVICE_HOOK_ENV]: v } });
      assert(g.run === false && g.reason === 'disabled', `env=${v} 没关掉：${JSON.stringify(g)}`);
    }
    const g2 = adviceHookGate({ argv: [], noWrite: false, env: {}, state: { adviceHook: { enabled: false } } });
    assert(g2.run === false && g2.reason === 'disabled', `state 开关没生效：${JSON.stringify(g2)}`);
    // 双向：缺省就是开（否则"关掉的办法"这条判据测不出东西）
    const g3 = adviceHookGate({ argv: [], noWrite: false, env: {}, state: null });
    assert(g3.run === true && g3.reason === 'daily', `缺省没开：${JSON.stringify(g3)}`);
    const g4 = adviceHookGate({ argv: [], noWrite: false, env: { [ADVICE_HOOK_ENV]: 'on' }, state: { adviceHook: { enabled: true } } });
    assert(g4.run === true, `显式 on 竟没开：${JSON.stringify(g4)}`);
  });

  run('夹具31 · C8 · 非每日路径（--json / --no-write / --selftest / --broadcast / --help）⇒ hook 0 次', () => {
    const cases = [
      [['--json'], false, 'json'],
      [[], true, 'no-write'],
      [['--json', '--no-write'], false, 'json'],
      [['--selftest'], false, 'selftest'],
      [['--broadcast', '-', '--apply'], false, 'broadcast'],
      [['--help'], false, 'help'],
    ];
    for (const [argv, noWrite, want] of cases) {
      const g = adviceHookGate({ argv, noWrite, env: {}, state: null });
      assert(g.run === false, `${JSON.stringify(argv)} / noWrite=${noWrite} 竟然要跑 hook`);
      assert(g.reason === want, `${JSON.stringify(argv)} 的 reason 应为 ${want}，实际 ${g.reason}`);
    }
    // 反向：日常跑法（空 argv、非 --no-write）必须跑 —— 否则"0 次"是假绿
    const g0 = adviceHookGate({ argv: [], noWrite: false, env: {}, state: null });
    assert(g0.run === true && g0.reason === 'daily', '日常跑法竟然不跑 hook ⇒ 这条夹具没有鉴别力');
  });

  run('夹具32 · C8 · lastAdviceHook 写一次 → 跑 mergeState（模拟次日 08:20）⇒ 字段仍在（B2 教训）', () => {
    const r = computeReport({ standup: mkStandup({ pending: [] }), cards: new Map(), now: HOOK_NOW });
    const s1 = mergeState(null, r, { now: HOOK_NOW });
    const home = mkHome8();
    const statePath = path.join(home, STEWARD_STATE_FILE);
    fs.writeFileSync(statePath, JSON.stringify(s1.state), 'utf8');
    const hook = { at: new Date(HOOK_NOW).toISOString(), rc: 0, ms: 812, skipped: false, reason: 'ok' };
    const w = persistAdviceHook(statePath, hook, { home });
    assert(w.ok === true, `补写失败：${JSON.stringify(w)}`);
    const written = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert(written.lastAdviceHook && written.lastAdviceHook.ms === 812, `补写没落盘：${JSON.stringify(written.lastAdviceHook)}`);
    // 次日：mergeState 只拿 report、并不知道 hook ⇒ 必须透传（否则静默抹掉）
    const s2 = mergeState(written, r, { now: HOOK_NOW + 864e5 });
    assert(s2.state.lastAdviceHook && s2.state.lastAdviceHook.ms === 812 && s2.state.lastAdviceHook.rc === 0,
      `mergeState 把 lastAdviceHook 抹了（B2 复发）：${JSON.stringify(s2.state.lastAdviceHook)}`);
    // 反向：旧 state 没有这一段时，不许凭空写出来
    const s3 = mergeState(null, r, { now: HOOK_NOW });
    assert(!('lastAdviceHook' in s3.state), '空 state 竟写出了 lastAdviceHook');
  });

  run('夹具33 · C8 · stdout 只有一行（跑完/跳过两种措辞，且不含换行 ⇒ 不搅乱甲层输出）', () => {
    const a = renderAdviceHookLine({ at: 'x', rc: 0, ms: 812, skipped: false, reason: 'ok' });
    const b = renderAdviceHookLine({ at: 'x', rc: 0, ms: 900, skipped: true, reason: 'already-ran' });
    assert(/乙层/.test(a) && /跑完/.test(a), `跑完那行不对：${a}`);
    assert(/乙层/.test(b) && /跳过/.test(b) && /already-ran/.test(b), `跳过那行不对：${b}`);
    assert(!/[\r\n]/.test(a + b), '这一行里混进了换行（会把甲层输出切成两截）');
  });

  // ===== C10（2026-11-02 · Attention 结构化）：写入口 + 幂等 + 兼容 + 次日不被抹 =====
  const mkHome10 = () => {
    const d = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'steward-attn-'));
    TMP_HOMES.push(d);
    return d;
  };
  const ATTN_NOW = 1793600400000;   // 固定时刻（夹具不读墙钟）
  const readState10 = (home) => JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'));

  run('夹具34 · C10 · 登记 ⇒ attentions 落库（5 字段齐全）、未答 1 条', () => {
    const home = mkHome10();
    const r = attentionAddEntry({ cardId: 'card-x', question: '走 A 还是 B', options: ['A', 'B'], home, now: ATTN_NOW });
    assert(r.ok === true && r.action === 'added', `登记失败：${JSON.stringify(r)}`);
    const st = readState10(home);
    assert(Array.isArray(st[ATTENTIONS_FIELD]) && st[ATTENTIONS_FIELD].length === 1, `落库条数不对：${JSON.stringify(st[ATTENTIONS_FIELD])}`);
    const e = st[ATTENTIONS_FIELD][0];
    assert(e.cardId === 'card-x', `cardId 不对：${JSON.stringify(e)}`);
    assert(e.question === '走 A 还是 B', `question 不对：${JSON.stringify(e)}`);
    assert(Array.isArray(e.options) && e.options.join(',') === 'A,B', `options 不对：${JSON.stringify(e.options)}`);
    assert(typeof e.askedAt === 'string' && /^\d{4}-/.test(e.askedAt), `askedAt 不对：${JSON.stringify(e.askedAt)}`);
    assert(e.answeredAt === null, `answeredAt 应为 null：${JSON.stringify(e.answeredAt)}`);
    assert(r.unattended === 1 && r.total === 1, `计数不对：${JSON.stringify(r)}`);
  });

  run('夹具35 · C10 · 重复登记 ⇒ 不产生重复条目 / askedAt 保留 / question 更新；已答再登记 ⇒ 重开', () => {
    const home = mkHome10();
    const a1 = attentionAddEntry({ cardId: 'card-y', question: '第一版', options: ['A'], home, now: ATTN_NOW });
    assert(a1.ok === true, `第一次登记失败：${JSON.stringify(a1)}`);
    const a2 = attentionAddEntry({ cardId: 'card-y', question: '第二版', options: ['B', 'C'], home, now: ATTN_NOW + 3_600_000 });
    assert(a2.ok === true && a2.action === 'updated', `重复登记没走更新：${JSON.stringify(a2)}`);
    assert(a2.reopened === false, '没答过却报了"重开"');
    let st = readState10(home);
    assert(st[ATTENTIONS_FIELD].length === 1, `产生了重复条目：${st[ATTENTIONS_FIELD].length} 条`);
    assert(st[ATTENTIONS_FIELD][0].askedAt === a1.entry.askedAt, 'askedAt 被刷了（幂等失效）');
    assert(st[ATTENTIONS_FIELD][0].question === '第二版', 'question 没更新');
    assert(st[ATTENTIONS_FIELD][0].options.join(',') === 'B,C', 'options 没更新');
    assert(a2.unattended === 1, `未答数不对：${a2.unattended}`);
    const ans = attentionAnswerEntry({ cardId: 'card-y', home, now: ATTN_NOW + 7_200_000 });
    assert(ans.ok === true && ans.action === 'answered', `销账失败：${JSON.stringify(ans)}`);
    const a3 = attentionAddEntry({ cardId: 'card-y', question: '第三版', home, now: ATTN_NOW + 10_800_000 });
    assert(a3.ok === true && a3.action === 'updated' && a3.reopened === true, `已答再登记没重开：${JSON.stringify(a3)}`);
    st = readState10(home);
    assert(st[ATTENTIONS_FIELD].length === 1, '重开产生了第二条');
    assert(st[ATTENTIONS_FIELD][0].askedAt === a1.entry.askedAt, '重开把原 askedAt 刷掉了（卡面要求保留）');
    assert(st[ATTENTIONS_FIELD][0].answeredAt === null, '重开没把 answeredAt 归 null');
    assert(a3.unattended === 1, '重开后未答数应为 1');
  });

  run('夹具36 · C10 · 销账写 answeredAt；重复销账时间不变；不存在的卡拒绝且不被凭空创建', () => {
    const home = mkHome10();
    attentionAddEntry({ cardId: 'card-z', question: '要不要停这条线', home, now: ATTN_NOW });
    const a1 = attentionAnswerEntry({ cardId: 'card-z', home, now: ATTN_NOW + 1000 });
    assert(a1.ok === true && a1.action === 'answered' && a1.unattended === 0, `销账失败：${JSON.stringify(a1)}`);
    assert(typeof a1.entry.answeredAt === 'string' && /^\d{4}-/.test(a1.entry.answeredAt), 'answeredAt 没写');
    const a2 = attentionAnswerEntry({ cardId: 'card-z', home, now: ATTN_NOW + 90_000 });
    assert(a2.ok === true && a2.action === 'already', `重复销账应 already：${JSON.stringify(a2)}`);
    assert(a2.entry.answeredAt === a1.entry.answeredAt, '重复销账把时间刷了（幂等失效）');
    const a3 = attentionAnswerEntry({ cardId: 'nope-card', home, now: ATTN_NOW });
    assert(a3.ok === false && /没有这张卡/.test(a3.error || ''), `不存在的卡竟被销账：${JSON.stringify(a3)}`);
    const st = readState10(home);
    assert(st[ATTENTIONS_FIELD].length === 1, `"拒绝"时把新卡创建了：${st[ATTENTIONS_FIELD].length} 条`);
  });

  run('夹具37 · C10 · 兼容：文件不存在可写 / 坏 JSON 拒写且原档不动 / 老 state 无字段可登记且别的段不丢', () => {
    const home = mkHome10();
    const p = path.join(home, STEWARD_STATE_FILE);
    const r0 = attentionAddEntry({ cardId: 'c-new', question: '文件不存在也要能登记', home, now: ATTN_NOW });
    assert(r0.ok === true, `无 state 文件时登记失败：${JSON.stringify(r0)}`);

    fs.writeFileSync(p, '{ 坏掉的 state ', 'utf8');
    const before = fs.readFileSync(p);
    const r1 = attentionAddEntry({ cardId: 'c-bad', question: 'x', home, now: ATTN_NOW });
    assert(r1.ok === false && /拒绝覆盖/.test(r1.error || ''), `坏 JSON 没被拒绝：${JSON.stringify(r1)}`);
    assert(fs.readFileSync(p).equals(before), '🔴 坏 state 被覆盖了（decisions[] 会丢）');

    const old = { schemaVersion: 1, decisions: [{ id: 'd1' }], heartbeat: { runs: 3 } };
    fs.writeFileSync(p, JSON.stringify(old), 'utf8');
    const r2 = attentionAddEntry({ cardId: 'c-old', question: '老 state 也要能登记', home, now: ATTN_NOW });
    assert(r2.ok === true, `老 state（无字段）登记失败：${JSON.stringify(r2)}`);
    const st = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert(Array.isArray(st[ATTENTIONS_FIELD]) && st[ATTENTIONS_FIELD].length === 1, '老 state 没写上 attentions');
    assert(st.decisions.length === 1 && st.heartbeat.runs === 3, '登记把老 state 的其它段写丢了');
  });

  run('夹具38 · C10 · mergeState（模拟次日 08:20）⇒ attentions 原样带过去（B2 教训；已答也留）', () => {
    const r = computeReport({ standup: mkStandup({ pending: [] }), cards: new Map(), now: ATTN_NOW });
    const s1 = mergeState(null, r, { now: ATTN_NOW });
    assert(Array.isArray(s1.state[ATTENTIONS_FIELD]) && s1.state[ATTENTIONS_FIELD].length === 0, '空 state 应写出 attentions: []');
    const home = mkHome10();
    const p = path.join(home, STEWARD_STATE_FILE);
    fs.writeFileSync(p, JSON.stringify(s1.state), 'utf8');
    attentionAddEntry({ cardId: 'card-keep', question: '明天 08:20 不许把我抹掉', home, now: ATTN_NOW });
    const written = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s2 = mergeState(written, r, { now: ATTN_NOW + 864e5 });
    assert(s2.state[ATTENTIONS_FIELD].length === 1 && s2.state[ATTENTIONS_FIELD][0].cardId === 'card-keep',
      `mergeState 把 attentions 抹了（B2 复发）：${JSON.stringify(s2.state[ATTENTIONS_FIELD])}`);
    attentionAnswerEntry({ cardId: 'card-keep', home, now: ATTN_NOW + 1000 });
    const w2 = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s3 = mergeState(w2, r, { now: ATTN_NOW + 2 * 864e5 });
    assert(s3.state[ATTENTIONS_FIELD].length === 1 && s3.state[ATTENTIONS_FIELD][0].answeredAt,
      '已答条目被 mergeState 裁掉了（"什么时候问过/答过"就答不出）');
  });

  run('夹具39 · C10 · attention 子命令不许触发乙层（0 次）；--attention-list 只读不建文件', () => {
    const cases = [
      ['--attention-add', '--card', 'x', '--question', 'q'],
      ['--attention-answer', '--card', 'x'],
      ['--attention-list'],
    ];
    for (const argv of cases) {
      const g = adviceHookGate({ argv, noWrite: false, env: {}, state: null });
      assert(g.run === false && g.reason === 'attention', `${JSON.stringify(argv)} 竟要跑乙层：${JSON.stringify(g)}`);
    }
    const home = mkHome10();
    const r = attentionList({ home });
    assert(r.ok === true && r.exists === false && r.total === 0, `空目录列出错了：${JSON.stringify(r)}`);
    assert(fs.existsSync(path.join(home, STEWARD_STATE_FILE)) === false, '--attention-list 竟然建了 state 文件（不是只读）');
  });

  // ===== C12-D（2026-11-02 · disposition 行流 + 两值副作用）：格式 / 只增不改 / 覆盖 / 副作用 / 幂等 =====
  const mkHome12 = () => {
    const d = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'steward-disp-'));
    TMP_HOMES.push(d);
    return d;
  };
  const D12_NOW = 1793600400000;      // 固定时刻（夹具不读墙钟）
  /**
   * 一屏假 report：**五种去向各有样本**（用真 computeReport 造，不手搓形状 —— 手搓就等于测自己）。
   * topN=1 ⇒ 排序后 failed 优先上桌，于是：raised 1 / ignored 2 / filtered 2（本线 + done）/ failed 1。
   */
  const mkReport12 = () => {
    const cards = new Map([
      ['c-raised', { id: 'c-raised', status: 'todo', line: '某条线', title: '要拍板的卡', description: '回滚点见 _archive\\x' }],
      ['c-ignored', { id: 'c-ignored', status: 'todo', line: '某条线', title: '排不上的卡', description: '' }],
      ['c-failed', { id: 'c-failed', status: 'failed', line: '某条线', title: '失败的卡', description: '' }],
      ['c-self', { id: 'c-self', status: 'todo', line: SELF_LINE, title: '本线自己的卡', description: '' }],
      ['c-done', { id: 'c-done', status: 'done', line: '某条线', title: '做完了的卡', description: '待拍板：这句已经没有意义了' }],
    ]);
    const pending = [
      { id: 'c-raised', title: '要拍板的卡', line: '某条线', status: 'todo', ageDays: 9 },
      { id: 'c-failed', title: '失败的卡', line: '某条线', status: 'failed', ageDays: 2 },
      { id: 'c-ignored', title: '排不上的卡', line: '某条线', status: 'todo', ageDays: 5 },
      { id: 'c-self', title: '本线自己的卡', line: SELF_LINE, status: 'todo', ageDays: 1 },
      { id: 'c-done', title: '做完了的卡', line: '某条线', status: 'done', ageDays: 3 },
    ];
    return computeReport({ standup: mkStandup({ pending }), cards, now: D12_NOW }, { topN: 1 });
  };
  const rows12 = () => buildDispositions(mkReport12(), { runId: 'run-test-12d', now: D12_NOW });
  const dispFileOf = (home) => path.join(home, DISPOSITION_STATE_FILE);

  run('夹具40 · C12-D · 行流格式：六值词表 / 原因码在表里 / at·runId 齐全（改坏必须红）', () => {
    const rows = rows12();
    assert(rows.length > 0, '一行都没算出来');
    assert(DISPOSITION_KINDS.length === 6, `六值词表长度不对：${DISPOSITION_KINDS.length}`);
    for (const k of ['evaluated', 'filtered', 'ignored', 'blocked', 'failed', 'fanned-out']) {
      assert(DISPOSITION_KINDS.includes(k), `词表缺 ${k}`);
    }
    for (const r of rows) {
      assert(DISPOSITION_KINDS.includes(r.kind), `kind 不在词表：${JSON.stringify(r.kind)}`);
      assert(Object.prototype.hasOwnProperty.call(REASON_CODES, r.reason), `原因码不在表里：${r.reason}`);
      assert(typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)), `at 不是 ISO 时间：${JSON.stringify(r.at)}`);
      assert(r.runId === 'run-test-12d', `runId 没带上：${JSON.stringify(r.runId)}`);
      assert(validateRow(r).ok, `validateRow 说这行不合法：${JSON.stringify(validateRow(r))}`);
    }
    // 本件**不产生** fanned-out（那是 C12-B 扇出段的事；出现即口径漂了）
    assert(rows.every((r) => r.kind !== 'fanned-out'), 'fanned-out 不该由甲层产生');
    // 双向验证：把 kind / reason 改坏，校验器必须红（否则"格式对"这条是假绿）
    assert(validateRow({ ...rows[0], kind: 'done' }).ok === false, '野 kind 竟然通过了校验');
    assert(validateRow({ ...rows[0], reason: 'Raised Top' }).ok === false, '野原因码竟然通过了校验');
    assert(validateRow({ ...rows[0], runId: '' }).ok === false, '缺 runId 竟然通过了校验');
  });

  run('夹具41 · C12-D · 只增不改：两轮追写 ⇒ 既有字节一个不动；本件没有清空/截断入口', () => {
    const home = mkHome12();
    const file = dispFileOf(home);
    const r1 = appendRows(file, rows12());
    assert(r1.ok && r1.appended === rows12().length, `第一轮追写不对：${JSON.stringify(r1)}`);
    const buf1 = fs.readFileSync(file);
    const sha1 = crypto.createHash('sha256').update(buf1).digest('hex');
    const lines1 = String(buf1).split('\n').filter(Boolean).length;
    const r2 = appendRows(file, rows12().map((x) => ({ ...x, runId: 'run-test-12d-2' })));
    assert(r2.ok && r2.appended === lines1, `第二轮追写不对：${JSON.stringify(r2)}`);
    const buf2 = fs.readFileSync(file);
    assert(buf2.length > buf1.length, `文件没变长：${buf1.length} → ${buf2.length}`);
    const prefix = buf2.subarray(0, buf1.length);
    const shaPrefix = crypto.createHash('sha256').update(prefix).digest('hex');
    assert(shaPrefix === sha1, '既有行被改写了（只增不改被破坏）');
    assert(String(buf2).split('\n').filter(Boolean).length === lines1 * 2, '行数不是两轮之和');
    // 大写口径：本件与 lib 里**没有**清空/截断/覆盖入口（源码级判据；改代码才可能变红）
    const src = fs.readFileSync(path.join(HERE, 'lib', 'disposition.mjs'), 'utf8');
    for (const re of [/\bfs\.writeFileSync\s*\(/, /\bfs\.unlinkSync\s*\(/, /\btruncate\w*\s*\(/, /--clear/]) {
      assert(!re.test(src), `lib\\disposition.mjs 里出现了禁止的写口：${re}`);
    }
  });

  run('夹具42 · C12-D · 覆盖：pendingTop 每一张卡都至少有一行去向（含被挡下的两类）', () => {
    const rep = mkReport12();
    const rows = buildDispositions(rep, { runId: 'run-test-12d', now: D12_NOW });
    const covered = new Set(rows.map((r) => r.cardId).filter(Boolean));
    const want = new Set(rep.allPending.map((x) => x.id).concat(
      rep.excluded.selfCardsDetail.map((x) => x.id),
      rep.excluded.deadDetail.map((x) => x.id),
    ));
    // 这一屏里 5 张卡（3 张过了筛 + 本线 1 + done 1）—— 每张都得有去向
    for (const id of want) assert(covered.has(id), `卡 ${id} 没有任何去向（"为什么没处理"答不上）`);
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ['evaluated', 'ignored', 'filtered', 'failed']) {
      assert(kinds.has(k), `这一屏本该出现 ${k}，实际 ${JSON.stringify([...kinds])}`);
    }
    // 原因码也要"齐全"：被挡下的两类分开记，不许都叫 filtered-别的
    const reasons = new Set(rows.map((r) => r.reason));
    for (const code of ['raised-top', 'over-top-n', 'self-line', 'dead-status', 'card-status-failed']) {
      assert(reasons.has(code), `原因码 ${code} 没出现（分类糊在一起了）`);
    }
    // 双向验证：把"被挡下的名单"抽掉 ⇒ 那两类原因码必须消失（否则说明这两类是硬写死的）
    const rep3 = { ...rep, excluded: { ...rep.excluded, selfCardsDetail: [], deadDetail: [] } };
    const rows3 = buildDispositions(rep3, { runId: 'run-test-12d', now: D12_NOW });
    assert(!rows3.some((r) => r.reason === 'self-line' || r.reason === 'dead-status'),
      '名单抽掉了还冒出 filtered 行（说明去向不是从判据算出来的）');
  });

  run('夹具43 · C12-D · failed ⇒ 自动登记 Attention（问题带卡标题、选项齐全）', () => {
    const home = mkHome12();
    const rep = mkReport12();
    const rows = buildDispositions(rep, { runId: 'run-test-12d', now: D12_NOW });
    const r = runDisposition({ rows, report: rep, write: true, home, now: D12_NOW });
    assert(r.ok === true && r.wrote === true, `收尾那步没跑成：${JSON.stringify(r)}`);
    assert(r.appended === rows.length, `行数不对：${r.appended} ≠ ${rows.length}`);
    const st = JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'));
    const att = st[ATTENTIONS_FIELD];
    assert(Array.isArray(att) && att.length === 1, `attentions 应 1 条（只有 c-failed 带副作用），实际：${JSON.stringify(att)}`);
    assert(att[0].cardId === 'c-failed', `登记的卡不对：${att[0].cardId}`);
    assert(/失败的卡/.test(att[0].question), `问题里没带卡标题：${att[0].question}`);
    assert(att[0].options.join(',') === '重试,归档,先放着', `选项不对：${JSON.stringify(att[0].options)}`);
    assert(att[0].answeredAt === null, '刚登记就答了？');
    const se = r.sideEffects.filter((x) => x.cardId === 'c-failed');
    assert(se.length === 1 && se[0].ok && se[0].action === 'added', `副作用记录不对：${JSON.stringify(se)}`);
    // 问法必须**只认行里的 title=**（否则同一张卡在"候选"与"账本级 failed"两处措辞不同 ⇒ 每天被判 updated）
    const frow = rows.find((x) => x.kind === 'failed' && x.cardId === 'c-failed');
    const q1 = attentionRequestFor(frow, { title: '另一个完全不同的标题' }).question;
    const q2 = attentionRequestFor(frow, { title: '' }).question;
    assert(q1 === q2, `问法随外部标题漂了：\n${q1}\n${q2}`);
    assert(/失败的卡/.test(q1), `问法没按行内 title= 取：${q1}`);
  });

  run('夹具44 · C12-D · 重复不重复登：未答再不写；已答再失败 ⇒ 重开（answeredAt 归 null）', () => {
    const home = mkHome12();
    const rep = mkReport12();
    const rows = buildDispositions(rep, { runId: 'run-test-12d', now: D12_NOW });
    runDisposition({ rows, report: rep, write: true, home, now: D12_NOW });
    const askedAt1 = JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'))[ATTENTIONS_FIELD][0].askedAt;
    const stateBytes1 = fs.readFileSync(path.join(home, STEWARD_STATE_FILE));
    // 第二轮：同一张卡还在失败 ⇒ 不许重复登，也不许把 state 重写一遍
    const r2 = runDisposition({ rows: rows.map((x) => ({ ...x, runId: 'run-test-12d-b' })), report: rep, write: true, home, now: D12_NOW + 60_000 });
    const se2 = r2.sideEffects.find((x) => x.cardId === 'c-failed');
    assert(se2 && se2.ok && se2.action === 'already', `第二轮没走"已在等"：${JSON.stringify(se2)}`);
    const st2 = JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'));
    assert(st2[ATTENTIONS_FIELD].length === 1, `产生重复条目：${st2[ATTENTIONS_FIELD].length} 条`);
    assert(st2[ATTENTIONS_FIELD][0].askedAt === askedAt1, 'askedAt 被刷了');
    assert(fs.readFileSync(path.join(home, STEWARD_STATE_FILE)).equals(stateBytes1), '第二轮明明没事却把 state 重写了（噪声写）');
    // 第三轮：主人答过之后卡还坏着 ⇒ 重新开问（但 askedAt 保留，能回答"什么时候第一次问的"）
    const ans = attentionAnswerEntry({ cardId: 'c-failed', home, now: D12_NOW + 1000 });
    assert(ans.ok === true, `销账失败：${JSON.stringify(ans)}`);
    const r3 = runDisposition({ rows: rows.map((x) => ({ ...x, runId: 'run-test-12d-c' })), report: rep, write: true, home, now: D12_NOW + 120_000 });
    const se3 = r3.sideEffects.find((x) => x.cardId === 'c-failed');
    assert(se3 && se3.ok && se3.action === 'updated' && se3.reopened === true, `已答后没重开：${JSON.stringify(se3)}`);
    const st3 = JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'));
    assert(st3[ATTENTIONS_FIELD].length === 1 && st3[ATTENTIONS_FIELD][0].answeredAt === null, '重开没把 answeredAt 归 null');
    assert(st3[ATTENTIONS_FIELD][0].askedAt === askedAt1, '重开把原 askedAt 刷掉了');
  });

  run('夹具45 · C12-D · 干跑 0 行：gate 判据 + write:false 不建文件 + 日常必须写', () => {
    const cases = [
      [['--json'], false, 'json'],
      [[], true, 'no-write'],
      [['--selftest'], false, 'selftest'],
      [['--broadcast', '-', '--apply'], false, 'broadcast'],
      [['--help'], false, 'help'],
      [['--attention-add', '--card', 'x', '--question', 'q'], false, 'attention'],
      [['--disposition-add', '--kind', 'blocked', '--card', 'x', '--reason', 'executor-report-blocked'], false, 'disposition'],
      [['--disposition-list'], false, 'disposition'],
    ];
    for (const [argv, noWrite, want] of cases) {
      const g = dispositionGate({ argv, noWrite, env: {} });
      assert(g.write === false, `${JSON.stringify(argv)} / noWrite=${noWrite} 竟然要写行流`);
      assert(g.reason === want, `${JSON.stringify(argv)} 的 reason 应为 ${want}，实际 ${g.reason}`);
    }
    // env 逃生口
    for (const v of ['off', '0', 'false', 'no', 'disabled']) {
      const g = dispositionGate({ argv: [], noWrite: false, env: { [DISPOSITION_ENV]: v } });
      assert(g.write === false && g.reason === 'disabled', `env=${v} 没关掉：${JSON.stringify(g)}`);
    }
    // 反向：日常跑法必须写（否则"0 行"这条是假绿）
    const g0 = dispositionGate({ argv: [], noWrite: false, env: {} });
    assert(g0.write === true && g0.reason === 'daily', `日常跑法竟然不写：${JSON.stringify(g0)}`);
    // 干跑真的一个字节都不写
    const home = mkHome12();
    const dry = runDisposition({ rows: rows12(), report: mkReport12(), write: false, reason: 'no-write', home, now: D12_NOW });
    assert(dry.wrote === false && dry.total > 0, `干跑结果不对：${JSON.stringify(dry)}`);
    assert(fs.existsSync(dispFileOf(home)) === false, '干跑竟然建了行流文件');
    assert(fs.existsSync(path.join(home, STEWARD_STATE_FILE)) === false, '干跑竟然建了 state 文件');
  });

  run('夹具46 · C12-D · state 坏掉 ⇒ 副作用拒绝但行流照写（不崩、不覆盖坏档）', () => {
    const home = mkHome12();
    const statePath = path.join(home, STEWARD_STATE_FILE);
    fs.writeFileSync(statePath, '{ 这不是 JSON', 'utf8');
    const before = fs.readFileSync(statePath);
    const rep = mkReport12();
    const rows = buildDispositions(rep, { runId: 'run-test-12d', now: D12_NOW });
    let r;
    assert((() => { try { r = runDisposition({ rows, report: rep, write: true, home, now: D12_NOW }); return true; } catch { return false; } })(),
      'state 坏的时候直接抛了（不许崩）');
    assert(r.appended === rows.length, `行流没照写：${JSON.stringify(r)}`);
    assert(fs.readFileSync(dispFileOf(home), 'utf8').trim().split('\n').length === rows.length, '行流行数不对');
    const se = r.sideEffects.find((x) => x.cardId === 'c-failed');
    assert(se && se.ok === false, `state 坏了还登记成功了：${JSON.stringify(se)}`);
    assert(fs.readFileSync(statePath).equals(before), '坏 state 被覆盖了（应拒写、原档一字不动）');
  });

  run('夹具47 · C12-D · 与 C10 接口兼容：attentions 形状不变、别的段不丢、次日 mergeState 仍带过去', () => {
    const home = mkHome12();
    const statePath = path.join(home, STEWARD_STATE_FILE);
    // 先放一份"有别的段"的老 state
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1, decisions: [{ id: 'd1', cardId: 'c-x', note: '别把我抹了' }], advices: [], adviceSpend: { ym: '2026-11', calls: 0, cny: 0 },
    }), 'utf8');
    const rep = mkReport12();
    const r = runDisposition({ rows: buildDispositions(rep, { runId: 'r', now: D12_NOW }), report: rep, write: true, home, now: D12_NOW });
    assert(r.ok, `收尾失败：${JSON.stringify(r)}`);
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert(Array.isArray(st.decisions) && st.decisions.length === 1 && st.decisions[0].note === '别把我抹了', '别的段被写丢了');
    // 形状必须还是 C10 那五个字段（本卡**不改语义**）
    const norm = normalizeAttentions(st);
    assert(norm.length === 1, `normalizeAttentions 读不出来：${JSON.stringify(norm)}`);
    const keys = Object.keys(norm[0]).sort().join(',');
    assert(keys === 'answeredAt,askedAt,cardId,options,question', `attentions 形状被改了：${keys}`);
    // 次日 08:20：mergeState 只拿 report（不知道 attentions）⇒ 必须原样带过去
    const s2 = mergeState(st, rep, { now: D12_NOW + 864e5, topN: 1 });
    assert(s2.state[ATTENTIONS_FIELD].length === 1 && s2.state[ATTENTIONS_FIELD][0].cardId === 'c-failed',
      `mergeState 把自动登记的 Attention 抹了：${JSON.stringify(s2.state[ATTENTIONS_FIELD])}`);
  });

  run('夹具48 · C12-D · 子命令：不触发乙层 / --disposition-list 只读 / blocked 登记带副作用 / 缺参拒绝', () => {
    for (const argv of [['--disposition-add', '--kind', 'blocked', '--card', 'x', '--reason', 'executor-report-blocked'], ['--disposition-list']]) {
      const g = adviceHookGate({ argv, noWrite: false, env: {}, state: null });
      assert(g.run === false && g.reason === 'disposition', `${JSON.stringify(argv)} 竟要跑乙层：${JSON.stringify(g)}`);
    }
    const home = mkHome12();
    const l0 = dispositionList({ home });
    assert(l0.ok === true && l0.exists === false && l0.total === 0, `空目录列出错了：${JSON.stringify(l0)}`);
    assert(fs.existsSync(dispFileOf(home)) === false, '--disposition-list 竟然建了行流文件（不是只读）');
    assert(fs.existsSync(path.join(home, STEWARD_STATE_FILE)) === false, '--disposition-list 竟然建了 state 文件');
    // 缺参：buildRow 直接拒（不写行流、不写 state）
    const bad = dispositionAddEntry({ kind: 'blocked', cardId: 'c-b', reason: 'Bad Reason', home });
    assert(bad.ok === false && /原因码/.test(bad.error), `野原因码没收：${JSON.stringify(bad)}`);
    assert(fs.existsSync(dispFileOf(home)) === false, '缺参那条竟然写了行流');
    // blocked 正常登记：行流 1 行 + Attention 1 条（问法走 blocked 那套选项）
    const ok = dispositionAddEntry({ kind: 'blocked', cardId: 'c-blocked', reason: 'executor-report-blocked', detail: '卡说这条不归它', title: '卡死在半路的卡', home, now: D12_NOW });
    assert(ok.ok === true && ok.appended === 1, `blocked 没记上：${JSON.stringify(ok)}`);
    const rd = readRows(dispFileOf(home));
    assert(rd.total === 1 && rd.rows[0].kind === 'blocked' && rd.rows[0].cardId === 'c-blocked', `行流不对：${JSON.stringify(rd.rows)}`);
    const st = JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'));
    assert(st[ATTENTIONS_FIELD].length === 1 && /blocked/.test(st[ATTENTIONS_FIELD][0].question), `blocked 没自动登记：${JSON.stringify(st[ATTENTIONS_FIELD])}`);
    assert(st[ATTENTIONS_FIELD][0].options.join(',') === '操作者接着干,等主人,先放着', `blocked 选项不对：${JSON.stringify(st[ATTENTIONS_FIELD][0].options)}`);
  });

  run('夹具49 · C12-D · 候选为 0 时账本里的 failed 卡仍留行（2026-11-02 实测踩到的真缺口）', () => {
    // 真实现场：08:20 那天 pendingDecision=0（没人写「待拍板」），账本里 5 张卡却是 failed
    const cards = new Map([['c-dead-1', { id: 'c-dead-1', status: 'failed', line: '某条线', title: '坏掉的卡', description: '回滚点见 _archive\\x' }]]);
    const rep = computeReport({ standup: mkStandup({ pending: [] }), cards, now: D12_NOW }, { topN: 3 });
    assert(rep.allPending.length === 0, '这一屏本来就该没有候选');
    assert(Array.isArray(rep.failedLedger) && rep.failedLedger.length === 1, `账本级 failed 没取到：${JSON.stringify(rep.failedLedger)}`);
    const rows = buildDispositions(rep, { runId: 'r-empty', now: D12_NOW });
    const frow = rows.find((x) => x.kind === 'failed');
    assert(frow && frow.cardId === 'c-dead-1' && frow.reason === 'card-status-failed', `候选为空时 failed 卡没有去向：${JSON.stringify(rows)}`);
    const home = mkHome12();
    const r = runDisposition({ rows, report: rep, write: true, home, now: D12_NOW });
    const st = JSON.parse(fs.readFileSync(path.join(home, STEWARD_STATE_FILE), 'utf8'));
    assert(st[ATTENTIONS_FIELD].length === 1 && st[ATTENTIONS_FIELD][0].cardId === 'c-dead-1',
      `候选为空时没自动登记：${JSON.stringify(st[ATTENTIONS_FIELD])}`);
    // 双向验证：只看候选那一半（= 旧口径）⇒ 这行必然消失，说明补的那一段真的在起作用
    const repOld = { ...rep, failedLedger: undefined, failed: [] };
    assert(!buildDispositions(repOld, { runId: 'r-empty', now: D12_NOW }).some((x) => x.kind === 'failed'),
      '旧口径下竟然还有 failed 行 ⇒ 这条夹具测不到东西');
    // 本线自己的失败卡照旧排除（§4.3③），且计数写明
    const repSelf = computeReport({
      standup: mkStandup({ pending: [] }),
      cards: new Map([['c-mine', { id: 'c-mine', status: 'failed', line: SELF_LINE, title: '本线坏卡' }]]),
      now: D12_NOW,
    }, { topN: 3 });
    assert(repSelf.failedLedger.length === 0 && repSelf.failedSelfExcluded === 1, `本线失败卡没被排除：${JSON.stringify(repSelf.failedLedger)}`);
    // 🔴 2026-11-02 补两条断言（真源 `docs/` §3-D 的 ①②）：
    //    归档的 failed 卡 = 人已经处理掉（放弃/关账）⇒ 不算"卡失败了"，摘出 failedLedger 并单独计数。
    const repArch = computeReport({
      standup: mkStandup({ pending: [] }),
      cards: new Map([['c-arch', { id: 'c-arch', status: 'failed', line: '某条线', title: '归档掉的坏卡', archivedAt: D12_NOW - 3600000 }]]),
      now: D12_NOW,
    }, { topN: 3 });
    assert(repArch.failedLedger.length === 0 && repArch.failedArchivedExcluded === 1,
      `归档的失败卡没被摘：${JSON.stringify({ ledger: repArch.failedLedger, arch: repArch.failedArchivedExcluded })}`);
    //    归档 ∧ 本线 双命中 ⇒ **互斥口径：归档优先、本线不再计**（archived=1 ∧ self=0）。
    //    这条就是锁死"别改回双计"的守卫：双计会让闭合恒等式被同一张卡多算 1。
    const repBoth = computeReport({
      standup: mkStandup({ pending: [] }),
      cards: new Map([['c-mine-arch', { id: 'c-mine-arch', status: 'failed', line: SELF_LINE, title: '本线归档坏卡', archivedAt: D12_NOW - 3600000 }]]),
      now: D12_NOW,
    }, { topN: 3 });
    assert(repBoth.failedLedger.length === 0 && repBoth.failedArchivedExcluded === 1 && repBoth.failedSelfExcluded === 0,
      `归档∧本线双命中的计数不对（互斥口径：归档优先，本线不再计 ⇒ 恒等式不会被同一张卡多算）：${JSON.stringify({ ledger: repBoth.failedLedger, arch: repBoth.failedArchivedExcluded, self: repBoth.failedSelfExcluded })}`);
  });

  run('夹具50 · C12-D · `--disposition-list` 的分布按**全量**算（不是只算回显的那几条）', () => {
    const home = mkHome12();
    const file = dispFileOf(home);
    const r1 = buildRow({ kind: 'evaluated', cardId: 'a', reason: 'raised-top', runId: 'r1', now: D12_NOW });
    const r2 = buildRow({ kind: 'ignored', cardId: 'b', reason: 'over-top-n', runId: 'r1', now: D12_NOW });
    const r3 = buildRow({ kind: 'failed', cardId: 'c', reason: 'card-status-failed', detail: 'title=x', runId: 'r1', now: D12_NOW });
    appendRows(file, [r1.row, r2.row, r3.row]);
    const l = dispositionList({ home, tail: 1 });
    assert(l.total === 3, `total 不对：${l.total}`);
    assert(l.rows.length === 1, `回显条数不对：${l.rows.length}`);
    assert(l.byKind.evaluated === 1 && l.byKind.ignored === 1 && l.byKind.failed === 1,
      `分布被"只算回显那几条"截了：${JSON.stringify(l.byKind)}`);
    assert(l.byReason['over-top-n'] === 1 && l.byReason['raised-top'] === 1, `原因码分布不全：${JSON.stringify(l.byReason)}`);
    // 坏行不许让整本读不出（只计数）
    fs.appendFileSync(file, '这不是 JSON\n', 'utf8');
    const l2 = dispositionList({ home, tail: 5 });
    assert(l2.ok === true && l2.total === 3 && l2.bad === 1, `坏行处理不对：${JSON.stringify({ ok: l2.ok, total: l2.total, bad: l2.bad })}`);
  });

  for (const d of TMP_HOMES) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ } }

  const ok = results.every((x) => x.ok);
  return { ok, results, version: STEWARD_VERSION, stateFile: STEWARD_STATE_FILE, selfLine: SELF_LINE };
}

// ---------------------------------------------------------------- 主流程

function argValue(argv, name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** 取字符串型参数（`--broadcast <file|->`）；后面紧跟另一个 `--flag` 或空 ⇒ 当没给。 */
function argStr(argv, name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v === '' || String(v).startsWith('--')) return dflt;
  return String(v);
}

/** 取同一参数的全部取值（`--option A --option B`）。后面紧跟 `--flag` 或空 ⇒ 跳过。 */
function argValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    const v = argv[i + 1];
    if (v === undefined || v === '' || String(v).startsWith('--')) continue;
    out.push(String(v));
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node steward.mjs [--json] [--no-write] [--top N] [--stale-days N] [--selftest]');
    console.log('      node steward.mjs --broadcast <file|-> [--apply] [--min-age-days N] [--max N] [--include-cards] [--only sid1,sid2] [--json]');
    console.log('      广播默认干跑（只列会投给谁 / 挡了谁）；--apply 才真投 + 逐条落 instructions[]');
    console.log('      node steward.mjs --attention-add --card <id> --question "<一句话>" [--option "<选项>"]* [--state <path>] [--json]');
    console.log('      node steward.mjs --attention-answer --card <id> [--state <path>] [--json]');
    console.log('      node steward.mjs --attention-list [--state <path>] [--json]');
    console.log('      Attention = 卡 C10：晨报「今天要您拍的」唯一来源（state.attentions，卡面文本不参与）');
    console.log('      node steward.mjs --disposition-list [--tail N] [--file <path>] [--json]');
    console.log('      node steward.mjs --disposition-add --kind blocked|failed --card <id> --reason <原因码> [--detail "…"] [--title "…"] [--json]');
    console.log('      去向（disposition）= 卡 C12-D：甲层每天把「上桌 / 排不上 / 被挡下 / failed」各记一行（只增不改）');
    process.exitCode = 0;
    return;
  }

  if (argv.includes('--selftest')) {
    const r = await selftest();
    const L = [`=== steward.mjs --selftest (v${r.version}) ===`];
    for (const x of r.results) L.push(`${x.ok ? '✅' : '🔴'} ${x.name}${x.ok ? '' : ' —— ' + x.detail}`);
    L.push('');
    L.push(r.ok ? `[结论] 全过（${r.results.length} 条夹具，含双向验证）` : `[结论] 有夹具没过：${r.results.filter((x) => !x.ok).length} 条`);
    console.log(L.join('\n'));
    process.exitCode = r.ok ? 0 : 2;
    return;
  }

  // ── Attention（C10）：**独立子命令**，不跑甲层那套（computeReport / mergeState 一个字都不动）
  if (argv.includes('--attention-add') || argv.includes('--attention-answer') || argv.includes('--attention-list')) {
    const asJsonA = argv.includes('--json');
    const homeA = dshHome();
    const statePathA = argStr(argv, '--state', '') || null;
    const cardId = argStr(argv, '--card', '');
    const outA = (mode, r) => {
      if (asJsonA) console.log(JSON.stringify({ version: STEWARD_VERSION, mode, statePath: r?.statePath ?? statePathA, ...r }, null, 2));
      else console.log(renderAttention(r, mode));
      process.exitCode = r && r.ok ? 0 : (r && r.skipped ? 1 : 3);
    };
    if (argv.includes('--attention-list')) {
      outA('list', attentionList({ home: homeA, statePath: statePathA }));
      return;
    }
    const mode = argv.includes('--attention-add') ? 'add' : 'answer';
    if (!cardId) {
      const msg = '需要 --card <卡 id>';
      if (asJsonA) console.log(JSON.stringify({ ok: false, version: STEWARD_VERSION, mode, error: msg }, null, 2));
      else console.error(`[steward] 🔴 ${msg}`);
      process.exitCode = 2;
      return;
    }
    if (mode === 'add') {
      outA(mode, attentionAddEntry({
        cardId,
        question: argStr(argv, '--question', ''),
        options: argValues(argv, '--option'),
        home: homeA, statePath: statePathA,
      }));
    } else {
      outA(mode, attentionAnswerEntry({ cardId, home: homeA, statePath: statePathA }));
    }
    return;
  }

  // ── Disposition（C12-D）：**独立子命令**，不跑甲层那套（computeReport / mergeState 一个字都不动）
  if (argv.includes('--disposition-add') || argv.includes('--disposition-list')) {
    const asJsonD = argv.includes('--json');
    const homeD = dshHome();
    const statePathD = argStr(argv, '--state', '') || null;
    const fileD = argStr(argv, '--file', '') || null;
    const outD = (mode, r) => {
      if (asJsonD) console.log(JSON.stringify({ version: STEWARD_VERSION, mode, ...r }, null, 2));
      else console.log(renderDisposition(r, mode));
      process.exitCode = r && r.ok ? 0 : 3;
    };
    if (argv.includes('--disposition-list')) {
      outD('list', dispositionList({ home: homeD, filePath: fileD, tail: argValue(argv, '--tail', DISPOSITION_TAIL_DEFAULT) }));
      return;
    }
    const kindD = argStr(argv, '--kind', '');
    const cardD = argStr(argv, '--card', '');
    const reasonD = argStr(argv, '--reason', '');
    if (!kindD || !cardD || !reasonD) {
      const msg = '需要 --kind <blocked|failed> --card <卡 id> --reason <原因码>';
      if (asJsonD) console.log(JSON.stringify({ ok: false, version: STEWARD_VERSION, mode: 'add', error: msg }, null, 2));
      else console.error(`[steward] 🔴 ${msg}`);
      process.exitCode = 2;
      return;
    }
    outD('add', dispositionAddEntry({
      kind: kindD, cardId: cardD, reason: reasonD,
      detail: argStr(argv, '--detail', ''), title: argStr(argv, '--title', ''),
      home: homeD, statePath: statePathD, filePath: fileD,
    }));
    return;
  }

  // ── 广播（C7）：**独立子命令**，不跑甲层那套（computeReport / mergeState 一个字都不动）
  if (argv.includes('--broadcast')) {
    const asJsonB = argv.includes('--json');
    const file = argStr(argv, '--broadcast', '');
    if (!file) {
      console.error('--broadcast 需要正文文件路径（或用 `-` 从 stdin 读）');
      process.exitCode = 2;
      return;
    }
    let text = '';
    try {
      text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
    } catch (e) {
      if (asJsonB) console.log(JSON.stringify({ ok: false, version: STEWARD_VERSION, mode: 'broadcast', error: `正文读不到：${e.message}` }, null, 2));
      else console.error(`[steward] 🔴 广播正文读不到（${file}）：${e.message}`);
      process.exitCode = 3;
      return;
    }
    const applyB = argv.includes('--apply');
    const homeB = dshHome();
    // 干跑只读不写 ⇒ 不抢 tick 锁（否则 tickd 正在跑的时候连"看一眼"都看不到）；真投才拿同一把锁
    let lockB = null;
    if (applyB) {
      lockB = acquireTickLock('steward', { ttlMs: 600_000, home: homeB });
      if (!lockB.ok) {
        const reason = lockB.reason ?? 'locked';
        if (asJsonB) console.log(JSON.stringify({ ok: false, version: STEWARD_VERSION, mode: 'broadcast', skipped: true, reason }, null, 2));
        else console.log(`[steward] 另一实例正持锁（${reason}），本轮不投（不排队、不阻塞）`);
        process.exitCode = 0;
        return;
      }
    }
    try {
      const r = await runBroadcast({
        text, apply: applyB, home: homeB,
        minAgeDays: argValue(argv, '--min-age-days', BROADCAST_MIN_AGE_DAYS),
        max: argValue(argv, '--max', BROADCAST_MAX_TARGETS),
        includeCards: argv.includes('--include-cards'),
        only: (() => { const v = argStr(argv, '--only', ''); return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null; })(),
      });
      if (asJsonB) {
        console.log(JSON.stringify({
          ok: r.ok, version: STEWARD_VERSION, mode: r.mode,
          broadcast: {
            date: r.date, at: r.at, digest: r.digest, bodyBytes: r.bodyBytes,
            plan: r.plan, receipts: r.receipts, warnings: r.warnings, error: r.error ?? null,
          },
          statePath: r.statePath, addedInstructions: r.addedInstructions, instructionCount: r.instructionCount,
          inputs: r.inputs,
        }, null, 2));
      } else {
        console.log(renderBroadcast(r));
      }
      // 退出码：有投不出去的 ⇒ 1（失败可见）；硬输入不通 ⇒ 3；其余 0
      if (r.receipts.some((x) => !x.accepted)) process.exitCode = 1;
      else if (r.error) process.exitCode = 3;
      else process.exitCode = 0;
    } finally {
      try { if (lockB) lockB.release(); } catch { /* TTL 兜底 */ }
    }
    return;
  }

  const asJson = argv.includes('--json');
  const noWrite = argv.includes('--no-write');
  const topN = argValue(argv, '--top', 3);
  const staleDays = argValue(argv, '--stale-days', 3);
  const home = dshHome();
  const statePath = path.join(home, STEWARD_STATE_FILE);

  // ① 锁（方案 §2.3：同一时刻只有 tickd job 写；手工排障直跑靠这把锁与它互斥）
  const lock = acquireTickLock('steward', { ttlMs: 600_000, home });
  if (!lock.ok) {
    const msg = `[steward] 另一实例正持锁（${lock.reason ?? 'locked'}），本轮跳过（不排队、不阻塞）`;
    if (asJson) console.log(JSON.stringify({ skipped: true, reason: lock.reason ?? 'locked' }, null, 2));
    else console.log(msg);
    process.exitCode = 0;
    return;
  }

  // C8：stateInfo 提到 try 外 —— 乙层总开关要读 `state.adviceHook.enabled`（gate 在锁外/收尾后判）
  // C12-D：report / disposition 行同样提到 try 外 —— 收尾那步在**锁外**跑（副作用要拿同一把锁）
  let stateInfo = null;
  let report = null;
  let dispRows = null;
  let dispRunId = null;
  let dispNow = null;
  try {
    // ② 硬输入：晨报（standup = ageDays / pendingDecision 的唯一权威源）
    const su = runStandup({ top: Math.max(1000, topN * 200), staleDays });
    if (!su.ok) {
      const msg = `[steward] 🔴 晨报读不到：${su.error}`;
      if (asJson) console.log(JSON.stringify({ ok: false, error: su.error }, null, 2));
      else console.log(msg);
      process.exitCode = 3;   // 硬输入缺失不许假装正常
      return;
    }

    // ③ 软输入：卡面文本（API，失败回落账本）+ 两份年轮 json（坏输入报黄，不崩）
    const cardRes = await loadCards({ home });
    const capRaw = loadYearring(path.join(DSH, 'docs', '年轮', 'capability.json'));
    const visionRaw = loadYearring(path.join(DSH, 'docs', '年轮', '协调线.json'));
    const now = Date.now();
    const capability = summarizeCapability(capRaw, { now });
    const vision = summarizeVision(visionRaw);

    const report0 = computeReport({ standup: su.data, cards: cardRes.byId, capability, vision, now });
    report = report0;
    if (!cardRes.ok) report.warnings.push({ level: 'yellow', code: 'cards-unreadable', message: `看板卡面读不到（${cardRes.error}）⇒ 可恢复性一栏不可信` });
    else if (cardRes.error) report.warnings.push({ level: 'yellow', code: 'cards-fallback', message: cardRes.error });

    // ③-bis 在跑的会话（方案 §4.5 + 实现注）：只读标题 + updatedAt，不读正文；拿不到就 fail-open + 报黄
    const sess = await loadSessions({ now: Date.now() });
    attachSessions(report, sess);

    // ③-ter C12-D：这一屏的**全部去向**（每条候选 / 每条被挡下的各一行）。纯函数、不写盘。
    //   真写盘在**锁外**（⑥，与乙层同款理由：副作用要拿同一把 `steward` 锁）。
    dispNow = now;
    dispRunId = dispositionRunId({ now, ledgerRevision: report.ledgerRevision });
    dispRows = buildDispositions(report, { runId: dispRunId, now });

    // ④ 写账（幂等）
    if (!noWrite) {
      let prev = null;
      try {
        prev = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
      } catch (e) {
        report.warnings.push({ level: 'yellow', code: 'state-unreadable', message: `旧 state 读不到（${e.message}）⇒ 按空账重建（decisions 会丢，需人工核对）` });
        prev = null;
      }
      stateInfo = mergeState(prev, report, { now, topN });
      // 方案 §2.3：写盘一律走 writeTextAtomic（禁 fs.writeFileSync 直写）
      writeTextAtomic(statePath, JSON.stringify(stateInfo.state, null, 2) + '\n', { retryDelaysMs: [50, 150, 400] });
      report.warnings = report.warnings;   // （保持引用，不额外改）
    }

    if (asJson) {
      console.log(JSON.stringify({
        ok: true, version: STEWARD_VERSION, statePath: noWrite ? null : statePath,
        report, state: stateInfo ? {
          decisionCount: stateInfo.decisionCount, instructionCount: stateInfo.instructionCount,
          raiseCount: stateInfo.raiseCount, addedInstructions: stateInfo.addedInstructions, addedRaises: stateInfo.addedRaises,
        } : null,
        inputs: {
          standup: { ok: su.ok, ms: su.ms },
          cards: { source: cardRes.source, count: cardRes.count, revision: cardRes.revision, error: cardRes.error },
          capability: { ok: capRaw.ok, mtime: capRaw.mtimeIso, error: capRaw.error },
          vision: { ok: visionRaw.ok, mtime: visionRaw.mtimeIso, error: visionRaw.error },
          sessions: { ok: sess.ok, ms: sess.ms, reason: sess.reason ?? null },
        },
        // C12-D：去向**只报不写**（`--json` 是机读排障路径，与乙层同理：0 行写入）
        disposition: {
          runId: dispRunId, planned: dispRows.length, wrote: false,
          byKind: summarizeRows(dispRows).byKind, byReason: summarizeRows(dispRows).byReason,
        },
      }, null, 2));
    } else {
      console.log(renderText(report, stateInfo));
    }
    process.exitCode = 0;   // 甲层这轮的结论先钉死：乙层永远改不了它（fail-open 口径⑤）
  } finally {
    try { lock.release(); } catch { /* TTL 兜底 */ }
  }

  // ⑤-quater C12-D：去向行流 + 两值副作用 —— **锁外 · 甲层收尾后 · fail-open**
  //    为什么在锁外：`attentionAddEntry` 抢的正是 `steward` 这把锁（同乙层 C8 的洞）。
  //    为什么要等甲层写完：行流要记的是"这一轮**真的**评估过什么"，不是"打算评估什么"。
  //    `--json` 里已经用 JSON 字段报过（见上），这里只负责人话那一行。
  if (!asJson && report) {
    const dGate = dispositionGate({ argv, noWrite, env: process.env });
    const dRes = runDisposition({
      rows: dispRows ?? [], report, write: dGate.write, reason: dGate.reason,
      home, statePath, now: dispNow ?? Date.now(),
    });
    console.log(renderDispositionLine(dRes));
  }

  // ⑥ C8（方案 §1.7.4 第一行）：乙层接进 08:20 —— **锁外 · 甲层收尾后 · fail-open**
  //    锁外是硬要求：乙层 persist() 抢同一把 `steward` 锁（steward-advice.mjs L1013），
  //    持锁 spawn ⇒ 模型调完写不进账（C5 的钱-账红线）。
  //    ⚠️ `--json` 时**整段不执行**（一个字节都不许往机读 stdout 里掺人话、也不写盘）。
  if (!asJson) {
    const gate = adviceHookGate({ argv, noWrite, state: stateInfo?.state ?? null });
    let hook;
    if (gate.run) {
      hook = await runAdviceHook({ home });
    } else {
      hook = { at: new Date().toISOString(), rc: null, ms: 0, skipped: true, reason: gate.reason };
    }
    // 心跳只许在真跑路径落盘（`--no-write` 一个字节都不许写）
    const hookWrite = noWrite ? { ok: false, reason: 'no-write' } : persistAdviceHook(statePath, hook, { home });
    console.log(renderAdviceHookLine(hook) + (hookWrite.ok ? '' : ` · state 未记（${hookWrite.reason}）`));
  }
}

// main 守卫：被 import（夹具 / 别处复用）时不许自动跑
const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(SELF_PATH);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`[steward] 🔴 崩了：${e && e.stack ? e.stack : e}`);
    process.exitCode = 3;
  });
}
