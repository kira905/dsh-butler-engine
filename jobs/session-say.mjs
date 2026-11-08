#!/usr/bin/env node
// dsh-butler / session-say.mjs —— 「跨会话喊话」CLI：给指定会话定向投一条消息
//
// 它是什么：`session.prompt` 的最小封装。**在"源会话已【已交接】⇒ queue 通知判定失配"时，它是唯一仍能即时送达的通道**
//（queue 通知依赖 绑定 / 主线 owner / 标题唯一 的判定链，源会话交棒后极易失配）。
//
// 三用：
//   ① 交棒后**拦截下家**（2026-09-28 实战：源会话 relay 后仍能喊住新会话「先别开卡」）
//   ② 给**卡执行会话**纠偏 / 喊停（跑偏、越界时当场叫停，不必等它撞墙）
//   ③ 跨会话催办（比 queue 通知更直接：有明确目标、不看绑定脸色）
//
// 边界（务必守）：
//   ✅ 给自己的**接力下家** / 自己建的**卡执行会话** ⇒ 合情合理；
//   ⚠️ 给**别人的会话**投消息 = 干预他人 ⇒ **须主人明说**；
//   🚫 别拿它绕过 queue 通知做常规派活（会架空整套通知判定）。
//
// 用法：
//   node session-say.mjs --list [--grep <子串>]                        # 只读：列会话（id / running / 标题）
//   node session-say.mjs --to <完整sid|短前缀|标题子串> --text "…"       # 默认 dry-run（只预览、不投）
//   node session-say.mjs --to <…> --file <路径> [--mode steer] --apply
//
// 身份自校验（2026-10-29 新增）：
//   拿 `DSH_SESSION_ID`（本进程所在会话）与解析出的目标比 —— **相等即拦**，rc=4（**dry-run 也拦**）。
//   由来：2026-10-28 23:41–23:57 生活线连续 5 次把 `--to` 填成自己的 sid，五轮答复全投给自己，
//   而"预览看着完全正常"⇒ 拦点必须放在**打印预览之前**，不能只拦 `--apply`。
//   短前缀 / 标题子串命中自己同样拦（三条定位路都走同一个判据）。
//   真要自测自投：显式加 `--allow-self`（默认不给）。
//   取不到 `DSH_SESSION_ID` ⇒ 跳过校验，并在预览里明确说一句（不静默）。
//
// 来源头（2026-10-29 新增）：真投递正文首行自动加
//   `[from: session-<自己sid前8> · <自己会话标题> · <ISO8601 本地时间带时区偏移> · new|reply]`
//   让收件方一眼看出是谁发的。`--reply-to <sid|短前缀>` ⇒ reply（头里带对方短 id）；`--no-from` 关掉（默认开）。
//
// 模式（`--mode`）：
//   queue（默认）= 目标**当前回合跑完**再送到（不打扰在跑的活）
//   steer        = ⚡**step 边界插话**（紧急用；**不 abort 进行中的工具** —— 2026-09-28 真机实测）
//
// 两道投递闸（2026-11-01 新增 · 卡「会话标题与归档第一层」b）：
//   ① **归档闸**：目标在 `workspace.json#global.archivedSessionIds` 里 ⇒ 拒投（rc=5）。
//   ② **已交接闸**：目标标题含【已交接】⇒ 默认拒投（rc=5）；显式 `--allow-handoff` 放行。
//   落点纪律（与身份闸同）：**都在打印预览之前** —— 预览看着正常就等于没拦（2026-10-28 事故形态）。
//   归档名单**只读**本地 `~\.dsh\storages\workspace.json`（共享件 `tools\lib\workspace-archive-list.mjs`）；
//   读不到 / 解析失败 ⇒ 打印一行「⚠️ 读不到归档名单，本次未做归档闸」，**已交接闸照常生效**
//   （两道闸互为兜底，绝不静默放行）。
//   ③【2026-11-06 · 会话归档第 5 棒】**候选池预筛**：按 id 前缀 / 标题找目标时，先把「已归档」与
//      （未给 --allow-handoff 时的）「标题含【已交接】」的候选从池里剔掉再数唯一性。为什么：同一条主线
//      每交棒一次就多一个同名会话，现网实测 4 个候选里 3 个是旧棒 ⇒ 一律 rc 3「目标不唯一」，
//      按标题喊话等于废掉。剔完：活的那个成为唯一 ⇒ 正常投；全被剔 ⇒ rc 3 + 一句「命中的 N 个候选
//      都已归档或已交棒」。🔴 精确 sid（完整 `session-<uuid>`）**不预筛**，照旧交给闸门拒 rc=5。
//
// 退出码：0 成功/dry-run · 1 投递失败 · 2 用法错 · 3 目标不唯一或找不到（含「候选都已归档/已交接」）· 4 目标是自己（要自测加 --allow-self）
//         · 5 目标已归档或已交接（新增；两个理由分开打印）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hostRpc } from '../src/lib/dsh-host-rpc.mjs';
import { resolveDshHome } from '../src/lib/dsh-home.mjs';
import { readArchivedSessionIds, sidKey } from './lib/workspace-archive-list.mjs';
// `--silent` 的落点（2026-11-06 · 卡「Router 静默收信」）：只 import 一个**纯函数**判据，
// 不在这里实现第二套静默档逻辑（写档只有 `router-inbox.mjs push` 一个口）。
import { isRouterTitle } from './router-inbox.mjs';

const BASE = (process.env.DSH_WEB_URL ?? 'http://localhost:3080').replace('127.0.0.1', 'localhost');

/** 退出码（**含义不可变**：0/1/2/3 沿用历史口径，4 = 2026-10-29 新增「目标是自己」，5 = 2026-11-01 新增「已归档/已交接」，
 *  6 = 2026-11-06 新增「--silent 的目标不是 Router」——判据在方案 §4.3；4/5 已占，不复用） */
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NOT_FOUND: 3, SELF: 4, ARCHIVED: 5, SILENT_TARGET: 6 };
/** 静默档脚本（写档的**唯一**口；`ROUTER_INBOX_BIN` 是夹具钩子，生产不设） */
const INBOX_SCRIPT = process.env.ROUTER_INBOX_BIN || path.join(path.dirname(fileURLToPath(import.meta.url)), 'router-inbox.mjs');
/** 合法的 --mode 取值 */
export const MODES = ['queue', 'steer'];
/** --list 里自己那条的行尾标记（**保留条目**，只加标记） */
export const SELF_MARK = '  (self · 别投给自己)';
/** 取不到 DSH_SESSION_ID 时预览里必须出现的那一句 */
export const NO_SELF_NOTE = '⚠️ 取不到 DSH_SESSION_ID，本次未做自校验';
/** 「已交接」标记：`session-relay` 交棒时把它写进标题（判据是**子串**，前后缀不限） */
export const HANDOFF_MARK = '【已交接】';
/** 两道闸的话术（唯一源：CLI 打印与夹具断言都用这一份，别各写一份） */
export const GATE_MSG = {
  archived: '✗ 目标已在归档名单（global.archivedSessionIds）—— 已归档的会话不投（投进去没人读）。\n'
    + '  真要投：先 node tools\\archive-session.mjs --sid <…> --unarchive 复位，或换一条活的会话。',
  handoff: '✗ 目标标题含【已交接】（旧棒）—— 默认拒投。\n'
    + '  确认你就是要投旧棒：显式加 --allow-handoff。',
  noList: '⚠️ 读不到归档名单，本次未做归档闸（已交接闸照常生效）',
  allowHandoff: '⚠️ --allow-handoff：目标标题含【已交接】，已放行（确认你就是要投旧棒）',
};

const HELP = `跨会话喊话（session.prompt 最小封装）

用法：node session-say.mjs <目标> <内容> [模式] [--apply]
  --list                只读列会话（可配 --grep <子串>）
  --to <目标>           完整 sessionId / 短前缀 / 标题子串（不唯一会列候选）
  --text "…" | --file <路径>   消息正文（二选一；--file 支持长文）
  --mode queue|steer    默认 queue（跑完再送）；steer＝⚡step 边界插话（不 abort 工具）
  --apply               真投递（**缺省 = dry-run，只预览**）
  --allow-self          显式放行「投给自己」（自测用；默认拦）
  --allow-handoff       显式放行「投给标题含【已交接】的旧棒」（默认拦）
  --reply-to <sid|前缀>  标成 reply（来源头里带对方短 id）
  --no-from             不加正文首行来源头（默认加）
  --silent              **静默投**：落 <DSH_HOME>\\router-inbox.jsonl（不进会话页面、不占回合），
                        给 Router 攒「静默批」；只对 Router 生效（别的会话 rc=6）。与 --mode steer 互斥（rc=2）。
  --kind report|receipt|ask  --silent 时标这条的性质（缺省 report；ask = 求拍板，别乱标）
  --line <线名>          --silent 时显式给线名（不给 = 从发送方会话标题剥【…】前缀）

身份自校验：目标 == 你所在会话（DSH_SESSION_ID）⇒ 拦，rc=4（dry-run 也拦）。
取不到 DSH_SESSION_ID ⇒ 跳过校验并提示。

两道投递闸（rc=5，同样在预览之前拦）：
  ① 目标在归档名单（workspace.json#global.archivedSessionIds）⇒ 拒投；
  ② 目标标题含【已交接】⇒ 拒投（--allow-handoff 放行）。
  读不到归档名单 ⇒ 提示「本次未做归档闸」，已交接闸照常生效。

边界：给自己的下家 / 自己建的卡会话 = 合理；给别人的会话 = 干预他人，须主人明说。

退出码：0=成功/dry-run · 1=投递失败 · 2=用法错 · 3=目标不唯一或找不到 · 4=目标是自己 · 5=目标已归档或已交接`;

// ─────────────────────────── 纯函数区（夹具可 import · 不连 Host / 不落盘） ───────────────────────────

async function sessionList() {
  const r = await hostRpc(BASE, 'session.list', {});
  const v = r?.body?.result?.value ?? r?.body?.value ?? {};
  return Array.isArray(v.items) ? v.items : [];
}

/** 会话 id 取值的唯一来源（Host 有时给 sessionId、构造夹具时给 id） */
export function sidOf(item) {
  return String(item?.sessionId ?? item?.id ?? '');
}

// 标题取值的**唯一**来源：Host 的 session.list 把标题塞在 projections.values.title，
// 顶层 title 恒空（D-1 根因）⇒ --list 渲染 / --grep / --to 三处共用这一份，禁各写一份。
export function titleOf(item) {
  const t = item?.projections?.values?.title ?? item?.title;
  return typeof t === 'string' ? t : '';
}

/**
 * 把 `--to` 解析成唯一目标（纯函数，夹具直接 import）。
 *
 * 【2026-11-06 · 会话归档第 5 棒】加第三个可选参数 `opts.skip(item) => boolean`：
 *   **只对「按 id 前缀 / 按标题」候选生效**，用来先把「已归档 / 已交接」的旧棒从候选池里剔掉。
 *   为什么（现网实测）：同一条主线每交棒一次就多攒一个同名会话，按标题喊话时 4 个候选里 3 个是
 *   已归档的旧棒 ⇒ 一律 rc 3「目标不唯一」，**按标题这条路等于废掉**（虽然没投错）。
 *   剔掉之后：活的那个成为唯一候选 ⇒ 正常投；全被剔 ⇒ `skipped>0` 让调用方报「候选都已归档/已交接」。
 *   🔴 精确 sid（完整 `session-<uuid>`）**不走 skip**：那条路必须照旧让投递闸拒（rc=5），
 *      否则「知道 sid 也投不进去」的口径会被悄悄改掉。
 *
 * @param {Array} items session.list 的 items
 * @param {string} to   完整 sid / 短前缀 / 标题子串
 * @param {{skip?: (item:any)=>boolean}} [opts]
 * @returns {{hit:any|null, cands:any[], skipped:number}}
 */
export function resolveTarget(items, to, opts = {}) {
  const norm = (s) => String(s ?? '');
  const sid = sidOf;
  const skip = typeof opts.skip === 'function' ? opts.skip : null;
  if (/^session-[0-9a-f-]{36}$/i.test(to)) return { hit: items.find((it) => sid(it) === to) ?? null, cands: [], skipped: 0 };
  const byId = items.filter((it) => sid(it).startsWith(to) || sid(it).replace(/^session-/, '').startsWith(to));
  const byTitle = items.filter((it) => titleOf(it).includes(to));
  const matched = [...byId, ...byTitle.filter((x) => !byId.includes(x))];
  const all = skip ? matched.filter((it) => !skip(it)) : matched;
  if (all.length === 1) return { hit: all[0], cands: [], skipped: matched.length - all.length };
  return { hit: null, cands: all, skipped: matched.length - all.length };
}

/** sid 的短标签：去 `session-` 前缀后取前 8 位 */
export function sid8(sid) {
  return norm(sid).replace(/^session-/, '').slice(0, 8);
}

function norm(v) {
  return String(v ?? '').trim();
}

/** 目标是不是「我自己」：两边都非空且逐字相等 */
export function isSelf(targetSid, selfSid) {
  const a = norm(targetSid);
  const b = norm(selfSid);
  return !!a && !!b && a === b;
}

/** --list 行尾标记（自己那条保留条目、只加标记） */
export function selfMark(sid, selfSid) {
  return isSelf(sid, selfSid) ? SELF_MARK : '';
}

/** ISO 8601 本地时间，**带时区偏移**（如 2026-10-29T00:31:07+08:00） */
export function isoLocal(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  const p = (n, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/**
 * 正文首行来源头。
 * new  = `[from: session-<self8> · <标题> · <iso> · new]`
 * reply= `[from: session-<self8> · <标题> · <iso> · reply→session-<peer8>]`
 * `noFrom` ⇒ 空串（调用方据此判定"不加头"）。
 */
export function fromHeader({ selfSid = '', selfTitle = '', when = new Date(), replyTo = '', noFrom = false } = {}) {
  if (noFrom) return '';
  const selfTag = norm(selfSid) ? `session-${sid8(selfSid)}` : 'session-unknown';
  const title = String(selfTitle ?? '').replace(/[\r\n]+/g, ' ').trim() || '（无标题）';
  const kind = norm(replyTo) ? `reply→session-${sid8(replyTo)}` : 'new';
  return `[from: ${selfTag} · ${title} · ${isoLocal(when)} · ${kind}]`;
}

/** 拼正文：有头就在最前面加一行（头为空 ⇒ 原样返回） */
export function composeMessage(text, header) {
  const body = String(text ?? '');
  return header ? `${header}\n${body}` : body;
}

/**
 * 身份闸决策（**纯函数**，是 CLI 拦点的唯一判据）。
 * @returns {{blocked:boolean, reason:'no-self-id'|'self'|'allow-self'|'ok'}}
 */
export function guardDecision({ targetSid = '', selfSid = '', allowSelf = false } = {}) {
  const me = norm(selfSid);
  if (!me) return { blocked: false, reason: 'no-self-id' };
  if (isSelf(targetSid, me)) return allowSelf ? { blocked: false, reason: 'allow-self' } : { blocked: true, reason: 'self' };
  return { blocked: false, reason: 'ok' };
}

/**
 * 两道投递闸（归档闸 → 已交接闸）的**唯一判据**（纯函数）。
 *
 * 顺序固定：**先归档、后已交接**（归档是事实、更是硬状态；`--allow-handoff` 只放开后者，
 * 不许它顺带把"已归档"也放开 —— 那会让"投进归档会话"变成一句开关的事）。
 *
 * @param {object} o
 * @param {string} o.targetSid            解析出来的目标 sessionId
 * @param {string} [o.targetTitle]        目标标题（Host 的 `projections.values.title`）
 * @param {Set<string>|string[]|null} [o.archivedIds]
 *        归档名单（`sidKey()` 归一后的集合）。`null`/`undefined` = **本次没读到**（不拦，但理由回 `no-archive-list`，
 *        调用方必须把这句打印出来 —— 静默放行就是 2026-10-28 那类事故的形态）。
 * @param {boolean} [o.allowHandoff]      显式放行【已交接】（默认 false）
 * @returns {{blocked:boolean, reason:'archived'|'handoff'|'allow-handoff'|'no-archive-list'|'ok'}}
 */
export function deliveryGuard({ targetSid = '', targetTitle = '', archivedIds = null, allowHandoff = false } = {}) {
  let set = null;
  if (archivedIds instanceof Set) set = archivedIds;
  else if (Array.isArray(archivedIds)) set = new Set(archivedIds.map((x) => sidKey(x)));
  const key = sidKey(targetSid);
  if (set && key && set.has(key)) return { blocked: true, reason: 'archived' };
  const title = String(targetTitle ?? '');
  if (title.includes(HANDOFF_MARK)) return allowHandoff ? { blocked: false, reason: 'allow-handoff' } : { blocked: true, reason: 'handoff' };
  return { blocked: false, reason: set ? 'ok' : 'no-archive-list' };
}

/** 用法错的退出码判定（纯函数）：缺 --to/--text 或 --mode 非法 或 --silent+steer ⇒ 2，否则 0 */
export function usageErrorCode({ to, text, mode = 'queue', silent = false } = {}) {
  if (!to || !text) return EXIT.USAGE;
  if (!MODES.includes(mode)) return EXIT.USAGE;
  // 静默档没有 steer 概念 —— 不做"静默降级"（方案 §4.3）
  if (silent && mode === 'steer') return EXIT.USAGE;
  return EXIT.OK;
}

// ─────────────────────────────────────────── CLI 主体 ───────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const SELF_SID = norm(process.env.DSH_SESSION_ID);

  if (has('--help') || has('-h') || (!argv.length)) {
    console.log(HELP);
    return (process.exitCode = argv.length ? EXIT.OK : EXIT.USAGE);
  }

  if (has('--list')) {
    const items = await sessionList();
    const grep = val('--grep', '');
    const rows = items.filter((it) => !grep || titleOf(it).includes(grep) || sidOf(it).includes(grep));
    console.log(`会话 ${items.length} 个${grep ? `（--grep "${grep}" ⇒ ${rows.length}）` : ''}：`);
    for (const it of rows) {
      const sid = sidOf(it);
      console.log(`${it.running ? '▶' : ' '} ${sid}  ${titleOf(it).slice(0, 60) || '（无标题）'}${selfMark(sid, SELF_SID)}`);
    }
    if (!SELF_SID) console.log(`\n${NO_SELF_NOTE}（--list 无法标出"自己"那条）`);
    const noTitle = rows.filter((it) => !titleOf(it)).length;
    if (noTitle) console.log(`\n⚠️ ${noTitle} 个会话确实没有标题（空壳 / 未命名）⇒ 这些只能用 sessionId 定位。`);
    return (process.exitCode = EXIT.OK);
  }

  const TO = val('--to');
  const MODE = val('--mode', 'queue');
  const APPLY = has('--apply');
  const FILE = val('--file');
  const ALLOW_SELF = has('--allow-self');
  const ALLOW_HANDOFF = has('--allow-handoff');
  const NO_FROM = has('--no-from');
  const SILENT = has('--silent');
  const KIND = norm(val('--kind', 'report')) || 'report';
  const LINE = norm(val('--line', ''));
  const REPLY_TO = norm(val('--reply-to', ''));
  let text = val('--text');
  if (FILE) {
    try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) {
      console.error('读 --file 失败：' + e.message);
      process.exitCode = EXIT.USAGE;
    }
  }
  if (process.exitCode === EXIT.USAGE) return EXIT.USAGE;
  if (usageErrorCode({ to: TO, text, mode: MODE, silent: SILENT }) !== EXIT.OK) {
    if (!TO || !text) console.error(HELP);
    else if (SILENT && MODE === 'steer') console.error('--silent 与 --mode steer 不能同给（静默档没有 steer 概念，不做静默降级）');
    else console.error(`--mode 只支持 queue|steer，收到 "${MODE}"`);
    return (process.exitCode = EXIT.USAGE);
  }

  const items = await sessionList();
  // 归档名单**先读**（2026-11-06 第 5 棒）：既给投递闸用，也给候选池预筛用（见 resolveTarget 的 skip）
  const archiveList = readArchivedSessionIds(resolveDshHome());
  const { hit, cands, skipped } = resolveTarget(items, TO, {
    skip: (it) => {
      const s = sidOf(it);
      if (archiveList.ok && archiveList.ids.has(sidKey(s))) return true
      if (!ALLOW_HANDOFF && titleOf(it).includes(HANDOFF_MARK)) return true
      return false
    },
  });
  if (!hit) {
    if (cands.length) {
      console.error(`目标不唯一（${cands.length} 个候选），请用更长的前缀或完整 id：`)
      for (const it of cands.slice(0, 10)) console.error(`  ${it.running ? '▶' : ' '} ${sidOf(it)}  ${titleOf(it).slice(0, 60)}`)
    } else if (skipped > 0) {
      console.error(`✗ 命中的 ${skipped} 个候选都已归档或已交棒（默认不投）。`)
      console.error('  要投旧棒：加 --allow-handoff（只放开「已交接」）；已归档的必须先 archive-session.mjs --unarchive 复位。')
    } else {
      console.error(`找不到目标："${TO}"`)
    }
    return (process.exitCode = EXIT.NOT_FOUND)
  }

  const sid = sidOf(hit);
  // 🔴 身份闸：位置必须在**打印预览之前**（2026-10-28 事故：预览看着正常 ⇒ 五轮全投给自己）
  const gate = guardDecision({ targetSid: sid, selfSid: SELF_SID, allowSelf: ALLOW_SELF });
  if (gate.reason === 'no-self-id') console.log(NO_SELF_NOTE);
  if (gate.blocked) {
    console.error(`✗ 目标就是你自己（${sid}），没投。要自测请显式加 --allow-self`);
    return (process.exitCode = EXIT.SELF);
  }
  if (gate.reason === 'allow-self') console.log('⚠️ --allow-self：目标就是你自己，已放行（仅自测用）');

  // 🔴 两道投递闸：**位置同样在打印预览之前**（预览看着正常 ⇒ 等于没拦，2026-10-28 的形态）
  //   归档名单只读本地 workspace.json（共享件，入口处已读一次，这里复用同一份）——
  //   读不到 ⇒ 说明白 + 已交接闸照常生效，绝不静默放行。
  const deliver = deliveryGuard({
    targetSid: sid,
    targetTitle: titleOf(hit),
    archivedIds: archiveList.ok ? archiveList.ids : null,
    allowHandoff: ALLOW_HANDOFF,
  });
  if (!archiveList.ok) console.log(`${GATE_MSG.noList}（${archiveList.reason}）`);
  if (deliver.blocked && deliver.reason === 'archived') {
    console.error(GATE_MSG.archived);
    return (process.exitCode = EXIT.ARCHIVED);
  }
  if (deliver.blocked && deliver.reason === 'handoff') {
    console.error(GATE_MSG.handoff);
    return (process.exitCode = EXIT.ARCHIVED);
  }
  if (deliver.reason === 'allow-handoff') console.log(GATE_MSG.allowHandoff);

  // 🔴 --silent 只对 Router 生效（方案 §4.3）：别的会话静默 = 信进了一个没人读的档 ⇒ rc 6。
  //    判据用标题「主路由」（与 router-inbox.mjs 的 isRouterTitle 同一份纯函数，别各写一份）。
  if (SILENT && !isRouterTitle(titleOf(hit))) {
    console.error(`✗ --silent 只对 Router 生效：目标「${(titleOf(hit) || sid).slice(0, 60)}」不是 Router · 主路由\n`
      + '  别的会话请照常实时投（去掉 --silent）；静默档只给 Router 攒「静默批」。');
    return (process.exitCode = EXIT.SILENT_TARGET);
  }

  const selfItem = SELF_SID ? items.find((it) => isSelf(sidOf(it), SELF_SID)) : null;
  // 静默档**不拼** `[from: …]` 头（来源走 --from / --title 字段；方案 §4.3）
  const header = SILENT ? '' : fromHeader({ selfSid: SELF_SID, selfTitle: selfItem ? titleOf(selfItem) : '', when: new Date(), replyTo: REPLY_TO, noFrom: NO_FROM });
  const body = composeMessage(text, header);

  console.log(`[${APPLY ? 'apply' : 'dry-run'}] 目标 ${sid}${hit.running ? '（▶在跑）' : '（空闲）'}`);
  console.log(`  标题：${(titleOf(hit) || '（无标题）').slice(0, 70)}`);
  console.log(`  模式：${MODE}${MODE === 'steer' ? ' ⚡step 边界插话（不 abort 工具）' : '（当前回合跑完再送）'}`);
  console.log(`  来源头：${header || (SILENT ? '（--silent：不拼来源头，来源走字段）' : '（--no-from：不加来源头）')}`);
  if (SILENT) console.log(`  静默：落 <DSH_HOME>\\router-inbox.jsonl（kind=${KIND}；不进会话页面、不占回合）`);
  console.log(`  正文（${Buffer.byteLength(body, 'utf8')} B）：\n---\n${body}\n---`);
  if (!APPLY) {
    // 方案 §4.3：dry-run 带 --silent ⇒ 多打一行"将被静默落入档（预览，未写盘）"，**不写 jsonl**
    console.log(SILENT
      ? '\n（将被静默落入档（预览，未写盘）；加 --apply 真写）'
      : '\n（未投递；加 --apply 真投）');
    return (process.exitCode = EXIT.OK);
  }

  // ── --silent 的真写分支（方案 §4.3：L366/L367 之间）⇒ 走 router-inbox push，**不调 session.prompt** ──
  if (SILENT) {
    const args = [INBOX_SCRIPT, 'push', '--text', body, '--kind', KIND];
    if (LINE) args.push('--line', LINE);
    if (SELF_SID) args.push('--from', SELF_SID);
    const selfTitle = selfItem ? titleOf(selfItem) : '';
    if (selfTitle) args.push('--title', selfTitle);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    const stdout = String(r.stdout ?? '').trim();
    const stderr = String(r.stderr ?? '') || (r.error ? String(r.error.message ?? r.error) : '');
    if (r.status === 0) {
      console.log(`\n✅ 已静默入档 ${stdout.split(/\s+/)[0] || '(未打印 id)'}`);
      return (process.exitCode = EXIT.OK);
    }
    console.error(`\n✗ 静默入档失败（rc=${r.status ?? 'null'}）—— **请退回实时投递**（去掉 --silent 或改天再说），别让信丢在口头`);
    if (stderr) console.error(stderr.slice(0, 400));
    return (process.exitCode = typeof r.status === 'number' ? r.status : EXIT.FAIL);
  }

  const r = await hostRpc(BASE, 'session.prompt', {
    requestId: randomUUID(), sessionId: sid, mode: MODE, content: [{ type: 'text', text: body }],
  });
  const ok = r?.status === 200 && r?.body?.result?.ok === true;
  if (ok) { console.log(`\n✅ 已投递（accepted=true · mode=${MODE}）`); return (process.exitCode = EXIT.OK); }
  console.error(`\n✗ 投递失败：${JSON.stringify(r).slice(0, 400)}`);
  return (process.exitCode = EXIT.FAIL);
}

// 只有**直接运行**才执行 CLI（被夹具 import 时不许有副作用 —— 更不许真投递）。
// ⚠️ junction 下 argv[1] 是逻辑路径、import.meta.url 是物理路径 ⇒ 双方都过 realpath 再比。
function isDirectRun() {
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = process.argv[1];
    if (!entry) return false;
    return fs.realpathSync(entry).toLowerCase() === fs.realpathSync(self).toLowerCase();
  } catch { return false; }
}

if (isDirectRun()) await main();
