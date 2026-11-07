#!/usr/bin/env node
/**
 * stall-nudge.mjs —— 主线停滞提醒 v1（只提醒、不动手）
 *
 * 背景（主人 2026-10-23 11:05）：
 *   「很多主线做着做着我就忘了推进了，其实这些事才是应该你主动来找我的。」
 *   现有自动化都在管**卡**（queue 叫醒 / card-watchdog / 失败通知），没有一个在看
 *   「**主线**是不是停摆了」—— 交接档写完也没人读它的「§5 下一步」。
 *
 * 本工具只做三件事：
 *   ① 判：四类停滞信号（todo 久置 / failed / 假 running / 交接档久置）；
 *   ② 报：`docs/` 列**全部候选**；
 *   ③ 推：Top N 走**通知注入点**（`lib/notify.mjs`；本包不带具体通道，宿主用 `setNotifier()` 接）。
 *   **绝不替主人推进任何事**：不 run / confirm / reject / move / update 任何卡，不写看板账本。
 *
 * 纪律（照本仓习惯）：
 *   · 缺省 dry-run：零写盘、零网络；`--apply` 才写状态 + 报告；再加 `--push` 才真发。
 *   · `--json` 时 stdout 只有 JSON；`--md` 时 stdout 只有报告正文；日志一律 stderr。
 *   · 三道闸：① 每个工作日只推一次（lastPushDate）② 推送只取 Top N ③ 同 key 24h 内不重复。
 *   · 通道只有一个注入点：默认实现 = console + no-op（`error:'no-channel'`），**不假装发出去了**。
 *
 * 用法：
 *   node stall-nudge.mjs [--days 3] [--top 3] [--json|--md] [--apply] [--push]
 *                        [--snooze <key> --hours 24] [--list-snooze]
 *                        [--base-url <URL>] [--home <dir>] [--now <ISO>] [--help]
 *
 * 退出码：0 OK / 1 运行失败（读不到看板等）/ 2 用法错
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readBoard, readSessions } from './lib/queue-watch.mjs';
import { notify } from './lib/notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEFAULT_DAYS = 3;
const DEFAULT_TOP = 3;
const FAKE_RUNNING_MS = 2 * HOUR_MS;
const STATE_NAME = 'butler-stall-nudge.json';
const SCHEMA_VERSION = 1;
const DEFAULT_DOCS_DIR = process.env.BUTLER_DOCS_DIR || path.join(os.homedir(), 'dsh', 'docs');
const DEFAULT_REPORT_DIR = process.env.BUTLER_REPORT_DIR || path.join(DEFAULT_DOCS_DIR, 'reports');
const MESSAGE_MAX = 300;

export const TIERS = Object.freeze({
  failed: { weight: 0, label: 'failed', tag: '[失败]' },
  fakeRunning: { weight: 1, label: 'fake-running', tag: '[假跑]' },
  todo: { weight: 2, label: 'todo', tag: '[待办]' },
  handoff: { weight: 3, label: 'handoff', tag: '[交接]' },
});

// ---------------------------------------------------------------- 小工具

export function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
}

export function statePath(home = dshHome()) {
  return path.join(home, STATE_NAME);
}

export function reportPath(reportDir = DEFAULT_REPORT_DIR, now = Date.now()) {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(reportDir, `stall-${day}.md`);
}

function localDate(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDateTime(ms) {
  if (!Number(ms)) return '—';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function daysBetween(now, then) {
  const n = Number(then) || 0;
  if (!n) return 0;
  return Math.max(0, Math.floor((now - n) / DAY_MS));
}

function oneLine(s, cap = 200) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

function stripMarkdown(s) {
  return String(s ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([ xX])\]\s*/g, '')
    .replace(/^\s*(?:[-*+]|\d+[.)、])\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*#+\s*/, '')
    .trim();
}

function stripComments(md) {
  return String(md ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

/** 占位词不算「下一步」（否则「（无）」会被当成一条内容）。 */
function isPlaceholder(s) {
  const t = String(s ?? '').replace(/[\s（）()【】\[\]]/g, '').trim();
  return !t || /^(?:无|暂无|没有|待补|空|—+|-+|N\/A|NA|TODO)$/i.test(t);
}

// ---------------------------------------------------------------- 状态文件（原子写）

export function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, lastPushDate: null, items: {} };
}

export function readState(home = dshHome()) {
  const file = statePath(home);
  try {
    if (!fs.existsSync(file)) return { state: defaultState(), ok: true, reason: 'missing' };
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return { state: defaultState(), ok: false, reason: 'not-object' };
    return {
      state: {
        schemaVersion: Number(j.schemaVersion) || SCHEMA_VERSION,
        lastPushDate: j.lastPushDate ? String(j.lastPushDate) : null,
        updatedAt: j.updatedAt ? String(j.updatedAt) : null,
        items: (j.items && typeof j.items === 'object' && !Array.isArray(j.items)) ? j.items : {},
      },
      ok: true,
      reason: 'ok',
    };
  } catch (e) {
    return { state: defaultState(), ok: false, reason: `read-error:${e?.message ?? e}` };
  }
}

/** 原子写：同目录 tmp + rename（不跨盘）。 */
export function writeStateAtomic(home, state, now = Date.now()) {
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = {
    schemaVersion: SCHEMA_VERSION,
    lastPushDate: state.lastPushDate ?? null,
    updatedAt: new Date(now).toISOString(),
    items: state.items ?? {},
  };
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------- 段落解析（容错）

/**
 * 解析「第 n 段」正文。认：
 *   `## 5. 下一步` / `## 5 ` / `### 5.` / `## 5、`；
 *   段内 `### 5.1` 之类的子标题不截断，遇到「不是 5 开头」的标题才结束。
 */
export function parseNumberedSection(md, num = 5) {
  const lines = String(md ?? '').split(/\r?\n/);
  const head = new RegExp(`^#{1,4}\\s*${num}(?:[.、)]|\\s)\\s*(.*)$`);
  let start = -1;
  let title = '';
  for (let i = 0; i < lines.length; i += 1) {
    const m = head.exec(lines[i]);
    if (m) { start = i; title = (m[1] ?? '').trim(); break; }
  }
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const h = /^(#{1,4})\s*(.*)$/.exec(lines[i]);
    if (h) {
      const text = (h[2] ?? '').trim();
      // 5.x 子标题继续收；其它编号/标题结束
      if (!new RegExp(`^${num}(?:[.、)]|\\d|\\s)`).test(text)) break;
      continue;
    }
    body.push(lines[i]);
  }
  return { title, body: body.join('\n') };
}

/** 从一段正文里取第一条「下一步」：优先列表项，其次首个非空段落。 */
export function firstItemFromBody(body) {
  const lines = stripComments(body).split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-=*_]{3,}$/.test(line)) continue;
    if (/^>/.test(line)) continue;
    if (/^\|/.test(line)) continue;
    const m = /^(?:[-*+]|\d+[.)、])\s+(.*)$/.exec(line);
    if (m) {
      const t = stripMarkdown(m[1]);
      if (t && !isPlaceholder(t)) items.push(t);
    }
  }
  if (items.length) return oneLine(items[0], 220);
  const para = lines.map((l) => l.trim()).find((l) => l && !/^#/.test(l) && !/^>/.test(l) && !/^\|/.test(l) && !/^[-=*_]{3,}$/.test(l));
  if (!para || isPlaceholder(stripMarkdown(para))) return null;
  return oneLine(stripMarkdown(para), 220);
}

/** 取「现状」首段：跳过标题 / 列表 / 引用 / 表格 / 注释；没有就返回 null。 */
export function firstParagraph(md) {
  const lines = stripComments(md).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#/.test(line)) continue;
    if (/^>/.test(line)) continue;
    if (/^\|/.test(line)) continue;
    if (/^[-=*_]{3,}$/.test(line)) continue;
    if (/^(?:[-*+]|\d+[.)、])\s+/.test(line)) continue;
    // 卡面元数据（不表达"现状"）：建议档位 / 方案闸（--no-plan）
    if (/^(?:\*\*)?(?:建议档位|方案闸)(?:\*\*)?\s*[:：]/.test(line)) continue;
    const t = oneLine(stripMarkdown(line), 120);
    if (t) return t;
  }
  return null;
}

/** 从 description 里找「下一步 / 待办」段首条；支持标题式与行内式。 */
export function nextStepFromDescription(desc) {
  const text = stripComments(desc);
  const lines = text.split(/\r?\n/);
  const label = '(?:下一步|待办事项|待办|后续步骤|剩余事项|剩余清单)';
  const inline = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:：]\\s*(.+)$`);
  const heading = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:：]?\\s*$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = inline.exec(lines[i]);
    if (m) {
      const t = stripMarkdown(m[1]);
      if (t && !isPlaceholder(t)) return oneLine(t, 220);
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!heading.test(lines[i])) continue;
    const body = [];
    for (let k = i + 1; k < lines.length; k += 1) {
      if (/^\s*#{1,6}\s+/.test(lines[k])) break;
      body.push(lines[k]);
    }
    const item = firstItemFromBody(body.join('\n'));
    if (item) return item;
  }
  return null;
}

/** prompt 第一句（去掉标题井号与方括号壳；截到句号/分号）。 */
export function firstSentence(prompt) {
  const line = stripComments(prompt).split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  if (!line) return null;
  let t = stripMarkdown(line);
  t = t.replace(/^【([^】]{1,60})】\s*/, '$1：');
  const cut = t.split(/[。；;]/)[0];
  const out = oneLine(cut || t, 120);
  return out || null;
}

// ---------------------------------------------------------------- 候选判定（纯函数）

function lastExecution(task) {
  const ex = Array.isArray(task?.executions) ? task.executions : [];
  return ex.length ? ex[ex.length - 1] : null;
}

function execEndMs(ex) {
  return Number(ex?.endedAt) || Number(ex?.startedAt) || 0;
}

export function buildSessionIndex(sessions) {
  if (!sessions || sessions.ok !== true) return { trusted: false, map: new Map(), reason: sessions?.error ?? 'unavailable' };
  const map = new Map();
  for (const s of sessions.items ?? []) {
    if (s?.sessionId) map.set(String(s.sessionId), s.running === true);
  }
  return { trusted: map.size > 0, map, reason: map.size ? 'ok' : 'empty-list' };
}

function makeCandidate(fields) {
  return {
    key: fields.key,
    tier: fields.tier,
    tierWeight: TIERS[fields.tier].weight,
    kind: fields.kind,
    title: oneLine(fields.title, 120),
    line: fields.line ?? null,
    status: fields.status ?? null,
    stagnDays: fields.stagnDays,
    referenceAt: fields.referenceAt,
    lastWhere: fields.lastWhere,
    nextStep: fields.nextStep,
    detail: fields.detail ?? null,
  };
}

/**
 * 单张卡 → 候选 / null / {skip}。
 * @param {object} task 看板卡
 * @param {{now:number, days:number, sessions:{trusted:boolean, map:Map}}} ctx
 */
export function classifyCard(task, ctx) {
  if (!task || task.archivedAt) return null;
  const now = Number(ctx.now);
  const days = Number(ctx.days);
  const status = String(task.status ?? '');
  const ex = lastExecution(task);
  const startedAt = Number(ex?.startedAt) || 0;
  const createdAt = Number(task.createdAt) || 0;
  const base = {
    key: `card:${task.id}`,
    kind: 'card',
    title: String(task.title ?? task.id ?? ''),
    line: task.line ?? null,
    status,
  };
  const desc = String(task.description ?? '');
  const nextStep = nextStepFromDescription(desc) || firstSentence(task.prompt);
  const statusLine = firstParagraph(desc) || String(task.title ?? '').trim();
  const lastExec = ex
    ? `末次执行 ${fmtDateTime(execEndMs(ex))}${ex.result ? `（${ex.result}）` : ''}`
    : `${fmtDateTime(createdAt)} 建卡 · 未执行`;
  const lastWhere = `${lastExec} · ${oneLine(statusLine, 90)}`;

  const withParts = (extra) => {
    if (!lastWhere || !nextStep) return { skip: !nextStep ? 'no-next-step' : 'no-last-where' };
    return makeCandidate({ ...base, ...extra, lastWhere, nextStep });
  };

  if (status === 'failed') {
    const ref = execEndMs(ex) || Number(task.updatedAt) || createdAt;
    return withParts({
      tier: 'failed',
      stagnDays: daysBetween(now, ref),
      referenceAt: ref,
      detail: ex?.error ? oneLine(ex.error, 140) : null,
    });
  }

  if (status === 'running') {
    const sessionId = ex?.sessionId ? String(ex.sessionId) : null;
    const staleByTime = now - (startedAt || createdAt) >= FAKE_RUNNING_MS;
    let sessionGone = false;
    if (sessionId && ctx.sessions?.trusted) sessionGone = ctx.sessions.map.get(sessionId) !== true;
    if (!sessionGone && !staleByTime) return null;
    const ref = startedAt || createdAt;
    return withParts({
      tier: 'fakeRunning',
      stagnDays: daysBetween(now, ref),
      referenceAt: ref,
      detail: [
        sessionId ? `执行会话 ${sessionId} ${sessionGone ? '已不在跑' : '仍在列表（按起跑时长判）'}` : '无执行会话记录',
        staleByTime ? `起跑已 ${Math.round((now - (startedAt || createdAt)) / HOUR_MS)}h` : null,
      ].filter(Boolean).join(' · '),
    });
  }

  if (status === 'todo') {
    const sch = task.schedule;
    if (sch && sch.enabled !== false && Number(sch.nextRunAt) > now) {
      return { skip: 'scheduled', key: base.key };
    }
    const execAt = execEndMs(ex);
    const ref = Math.max(createdAt, execAt);
    if (!ref || now - ref < days * DAY_MS) return null;
    return withParts({
      tier: 'todo',
      stagnDays: daysBetween(now, ref),
      referenceAt: ref,
      detail: ex ? `末次执行结果 ${ex.result ?? '—'}` : '从未执行',
    });
  }

  return null;
}

/**
 * 单个交接档 → 候选 / null / {skip}。
 * 解析不出 §5「下一步」⇒ skip:no-next-step（该档不进清单）。
 */
export function classifyHandoff(doc, ctx) {
  const name = doc.name;
  const mtime = Number(doc.mtimeMs) || 0;
  const now = Number(ctx.now);
  if (!mtime || now - mtime < Number(ctx.days) * DAY_MS) return null;
  const md = String(doc.text ?? '');
  const section5 = parseNumberedSection(md, 5);
  const nextStep = section5 ? firstItemFromBody(section5.body) : null;
  if (!nextStep) return { skip: 'no-next-step', key: `handoff:${name}` };
  const section2 = parseNumberedSection(md, 2);
  const two = section2 ? firstItemFromBody(section2.body) : null;
  const statusLine = two || firstParagraph(md);
  if (!statusLine) return { skip: 'no-last-where', key: `handoff:${name}` };
  const h1 = /^#\s+(.+)$/m.exec(stripComments(md));
  return makeCandidate({
    key: `handoff:${name}`,
    tier: 'handoff',
    kind: 'handoff',
    title: h1 ? stripMarkdown(h1[1]) : name.replace(/\.md$/, ''),
    status: 'handoff',
    stagnDays: daysBetween(now, mtime),
    referenceAt: mtime,
    lastWhere: `${fmtDateTime(mtime)} 最后改动 · ${oneLine(statusLine, 90)}`,
    nextStep,
    detail: name,
  });
}

/** 同主线只留最新一档（交接档是快照，旧档的 §5 已被新档取代）。 */
export function handoffTopic(name) {
  return String(name)
    .replace(/^交接-/, '')
    .replace(/\.md$/, '')
    .replace(/-20\d{6}.*$/, '')
    .trim();
}

/** 归一化后才比对（中点/空格/括号/横线都不算差异）。 */
export function normLine(s) {
  return String(s ?? '').replace(/[\s·•（）()【】\[\]「」:：\-—_/]/g, '').toLowerCase();
}

/** 看板上「还活着」的主线：在途状态 ∪ 近 30 天有更新的卡。 */
export function activeMainlines(tasks, now, windowDays = 30) {
  const out = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const line = String(t?.line ?? '').trim();
    if (!line) continue;
    const live = ['backlog', 'todo', 'running', 'review', 'failed'].includes(String(t.status));
    const recent = now - Number(t.updatedAt || 0) <= windowDays * DAY_MS;
    if (live || recent) out.set(line, { line, live: out.get(line)?.live === true || live });
  }
  return out;
}

export function matchMainline(topic, lines) {
  const nt = normLine(topic);
  if (nt.length < 2) return null;
  let best = null;
  for (const line of lines) {
    const nl = normLine(line);
    if (nl.length < 2) continue;
    if (nl.includes(nt) || nt.includes(nl)) {
      if (!best || nl.length > normLine(best).length) best = line;
    }
  }
  return best;
}

/**
 * 交接档归并：
 *   · scope='active'（默认）：只看看板上仍有在途/近 30 天活动的主线；**每条主线只留最新一档**。
 *     理由：库里 300+ 条历史交接档大多属于早已收尾的主线，全列会把日报灌成几千行，
 *     真正「做忘了」的反而不见了。要看全量：--handoff-scope all。
 *   · scope='all'：按原始主题归并（不按看板过滤）。
 * @returns {{groups:Array, collapsed:Array, unmatched:Array}}
 */
export function collectHandoffLatest(files, opts = {}) {
  const scope = opts.scope === 'all' ? 'all' : 'active';
  const lines = opts.lines ?? [];
  const groups = new Map();
  const collapsed = [];
  const unmatched = [];
  for (const f of files) {
    const topic = handoffTopic(f.name) || f.name;
    const key = scope === 'all' ? topic : matchMainline(topic, lines);
    if (!key) { unmatched.push(f); continue; }
    const prev = groups.get(key);
    const row = { ...f, topic, groupKey: key };
    if (!prev) groups.set(key, row);
    else if (Number(row.mtimeMs) > Number(prev.mtimeMs)) { collapsed.push(prev); groups.set(key, row); }
    else collapsed.push(row);
  }
  return { groups: [...groups.values()], collapsed, unmatched };
}

export function sortCandidates(list) {
  return [...list].sort((a, b) => {
    if (a.tierWeight !== b.tierWeight) return a.tierWeight - b.tierWeight;
    if (b.stagnDays !== a.stagnDays) return b.stagnDays - a.stagnDays;
    return String(a.key).localeCompare(String(b.key), 'zh');
  });
}

// ---------------------------------------------------------------- 推送文案（≤300 字）

export function composePushText(items, opts = {}) {
  const now = opts.now ?? Date.now();
  const d = new Date(now);
  const head = `🪧 主线停滞（${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}）`;
  const shortLast = (c) => {
    const at = fmtDateTime(c.referenceAt).slice(5, 16); // MM-DD HH:MM
    if (c.tier === 'handoff') return `档 ${at} 最后改动`;
    if (c.tier === 'todo' && /从未执行/.test(String(c.detail ?? ''))) return `${at} 建卡·未执行`;
    return `末次 ${at}`;
  };
  const lines = [head];
  items.forEach((c, i) => {
    const tag = TIERS[c.tier]?.tag ?? '';
    lines.push(`${i + 1}.${tag} ${oneLine(c.title, 20)}（停${c.stagnDays}天）`);
    lines.push(` 上：${shortLast(c)}`);
    lines.push(` 下：${oneLine(c.nextStep, 30)}`);
  });
  lines.push('（完整清单见 stall 日报）');
  let text = lines.join('\n');
  if (text.length > MESSAGE_MAX) text = `${text.slice(0, MESSAGE_MAX - 1)}…`;
  return text;
}

export function alertRecipient() {
  // 收件人由宿主决定：本包不带任何白名单。调用方可传 `recipient`，或由注入的 notifier 自己解析。
  return null;
}
function appendAlertLog(home, line) {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(path.join(home, 'butler-alert.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch { /* 告警日志写不了也不阻断主流程 */ }
}

/**
/**
 * 真发（Top N 汇总一条）。**成功判据 = 注入的 notifier 回 `ok:true`**；失败落告警日志，绝不静默。
 * 开源版不带任何具体通道：默认实现 = console + no-op（回 `error:'no-channel'`），
 * 宿主用 `setNotifier()` 注入自己的通道（或单轮传 `sendNotification` 覆盖）。
 * @returns {Promise<{ok:boolean, serverId:string|null, account:string|null, attempts:Array, error:string|null}>}
 */
export async function sendNudge({ text, home = dshHome(), recipient = null, log = () => {} }) {
  const r = await notify({ level: 'warn', title: 'stall-nudge', body: text, channel: 'alert', home });
  if (r.ok) {
    log(`已发送：msgid=${r.msgid ?? '-'}`);
    return { ok: true, serverId: r.msgid ?? null, account: recipient ?? null, attempts: [r], error: null };
  }
  const msg = r.error ?? 'no-channel';
  appendAlertLog(home, `stall-nudge 发送失败：${msg}`);
  return { ok: false, serverId: null, account: null, attempts: [r], error: msg };
}
// ---------------------------------------------------------------- 看板 / 交接档采集

function readHandoffFiles(docsDir) {
  let names = [];
  try {
    names = fs.readdirSync(docsDir).filter((n) => /^交接-.*\.md$/.test(n));
  } catch { return { ok: false, error: 'docs-dir-unreadable', files: [] }; }
  const files = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(docsDir, name));
      if (st.isFile()) files.push({ name, mtimeMs: st.mtimeMs, fullPath: path.join(docsDir, name) });
    } catch { /* 跳过读不到的 */ }
  }
  return { ok: true, files };
}

// ---------------------------------------------------------------- 报告

function renderReport(result) {
  const L = [];
  const c = result.counts;
  L.push(`# 主线停滞提醒 · ${result.date}`);
  L.push('');
  L.push(`- 生成时间：${fmtDateTime(result.now)}`);
  L.push(`- 参数：\`--days ${result.params.days} --top ${result.params.top}\``);
  L.push(`- 看板：${c.boardTasks} 张在板卡（todo ${c.boardTodo} / failed ${c.boardFailed} / running ${c.boardRunning}）`);
  L.push(`- 交接档：扫 ${c.handoffFiles} 个文件 → 判定范围 \`${c.handoffScope}\` → 主线组 ${c.handoffTopics} 条${c.handoffUnmatched ? `（另有 ${c.handoffUnmatched} 条档的主题在看板上无在途卡且近 30 天无活动，未纳入）` : ''} → 停滞候选 ${c.handoffCandidates} 条`);
  L.push(`- 候选合计：**${c.candidates} 条**（failed ${c.byTier.failed} / 假 running ${c.byTier.fakeRunning} / todo ${c.byTier.todo} / 交接档 ${c.byTier.handoff}）`);
  const pushed = result.pushed ?? [];
  L.push(`- 本次推送：**${pushed.length} 条**（原因：${result.pushReason}${result.weekend ? ' · 周末不推' : ''}）`);
  if (result.alert?.attempts?.length) {
    const a = result.alert;
    L.push(`- 通知：${a.ok ? `✅ 已发 msgid=${a.msgid ?? a.serverId ?? '-'}` : `❌ 未发出（${a.error}）`}（尝试 ${a.attempts.length} 次）`);
  } else {
    L.push(`- 通知：未发送（${result.pushReason}）`);
  }
  L.push('');
  L.push('## 本次推送（Top N）');
  if (!pushed.length) {
    L.push('');
    L.push(result.pushReason === 'today-pushed' ? '今天已经推过一次（同一工作日只推一次）。' : `无（${result.pushReason}）。`);
  } else {
    L.push('');
    for (const [i, x] of pushed.entries()) L.push(`${i + 1}. \`${x.key}\` ${x.title}`);
  }
  L.push('');
  L.push(`## 完整候选清单（${result.candidates.length} 条）`);
  L.push('');
  if (!result.candidates.length) {
    L.push('（无候选：没有超过阈值的停滞信号。）');
  }
  result.candidates.forEach((x, i) => {
    const marks = [];
    if (x.pushStatus === 'pushed') marks.push('已推送');
    if (x.pushStatus === 'snoozed') marks.push(`已搁置至 ${fmtDateTime(Date.parse(x.snoozedUntil))}`);
    if (x.pushStatus === 'cooldown') marks.push('24h 内已提醒');
    if (x.pushStatus === 'not-top') marks.push('未进 Top N');
    if (x.pushStatus === 'not-pushed') marks.push('本次未推送');
    L.push(`### ${i + 1}. [${TIERS[x.tier].label}] \`${x.key}\` · 停滞 ${x.stagnDays} 天${marks.length ? ` · ${marks.join(' · ')}` : ''}`);
    L.push('');
    L.push(`- 标题：${x.title}`);
    if (x.line) L.push(`- 主线：${x.line}`);
    L.push(`- 上次到哪：${x.lastWhere}`);
    L.push(`- 下一步：${x.nextStep}`);
    if (x.detail) L.push(`- 信号：${x.detail}`);
    L.push('');
  });
  L.push('## 扫描与过滤');
  L.push('');
  L.push(`- 看板读取：${result.board.ok ? '✅' : `❌ ${result.board.error}`}${result.board.revision ? `（revision ${result.board.revision}）` : ''}`);
  L.push(`- 会话列表：${result.sessions.trusted ? `✅ ${result.sessions.size} 个会话` : `⚠️ 不可用（${result.sessions.reason}）⇒ 假 running 只按「起跑 ≥2h」判`}`);
  L.push(`- 过滤计数：${Object.entries(result.skipCounts).map(([k, v]) => `${k} ${v}`).join(' · ') || '无'}`);
  if (result.collapsed?.length) {
    L.push(`- 交接档归并（同主线只留最新）：${result.collapsed.length} 条被更近的同题档取代`);
  }
  if (result.counts.handoffScope === 'active') {
    L.push('- 交接档范围说明：默认只看看板上「仍有在途卡或近 30 天有更新」的主线（避免把已收尾的 300+ 历史档全灌进日报）；全量请加 `--handoff-scope all`。');
  }
  L.push('');
  L.push('> 只提醒、不动手：本工具不 run / confirm / reject / move / update 任何卡，不写看板账本。');
  return L.join('\n');
}

// ---------------------------------------------------------------- 主流程

function normalizeArgs(opts = {}) {
  return {
    now: opts.now ?? Date.now(),
    days: opts.days ?? DEFAULT_DAYS,
    top: opts.top ?? DEFAULT_TOP,
    apply: opts.apply === true,
    push: opts.push === true,
    home: path.resolve(opts.home ?? dshHome()),
    docsDir: path.resolve(opts.docsDir ?? DEFAULT_DOCS_DIR),
    reportDir: path.resolve(opts.reportDir ?? DEFAULT_REPORT_DIR),
    handoffScope: opts.handoffScope === 'all' ? 'all' : 'active',
    baseUrl: opts.baseUrl ?? 'http://localhost:3080',
    board: opts.board,
    sessions: opts.sessions,
    sendNotification: opts.sendNotification,
    recipient: opts.recipient,
    log: opts.log ?? ((m) => process.stderr.write(`${m}\n`)),
  };
}

export async function runStallNudge(opts = {}) {
  const o = normalizeArgs(opts);
  const { now, days, top, home, docsDir, reportDir } = o;
  const log = o.log;
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days 必须是正数');
  if (!Number.isInteger(top) || top <= 0) throw new Error('--top 必须是正整数');

  // ① 看板 + 会话列表（并行取，单次最多 6s；读不到就降级，不拖垮 tickd budget）
  const boardInjected = Array.isArray(o.board) || (o.board && typeof o.board === 'object' && Array.isArray(o.board.tasks));
  let board;
  let sessionsRaw = o.sessions;
  if (boardInjected) {
    board = Array.isArray(o.board)
      ? { ok: true, tasks: o.board, revision: null }
      : { ok: true, tasks: o.board.tasks, revision: o.board.revision ?? null };
  }
  if (!boardInjected && !sessionsRaw) {
    const [b, s] = await Promise.all([
      readBoard({ baseUrl: o.baseUrl, timeoutMs: 6000 }),
      readSessions({ baseUrl: o.baseUrl, timeoutMs: 6000 }),
    ]);
    board = b;
    sessionsRaw = s;
  } else {
    if (!boardInjected) board = await readBoard({ baseUrl: o.baseUrl, timeoutMs: 6000 });
    if (!sessionsRaw) sessionsRaw = await readSessions({ baseUrl: o.baseUrl, timeoutMs: 6000 });
  }
  if (!board.ok) log(`⚠️ 看板读取失败：${board.error}（交接档仍会判定）`);
  const tasks = board.ok ? board.tasks : [];
  const sessions = buildSessionIndex(sessionsRaw);

  // ③ 卡候选
  const ctx = { now, days, sessions };
  const skips = [];
  const cardCandidates = [];
  for (const t of tasks) {
    const r = classifyCard(t, ctx);
    if (r && r.skip) skips.push({ key: r.key ?? `card:${t.id}`, reason: r.skip });
    else if (r) cardCandidates.push(r);
  }

  // ④ 交接档候选（同主线只留最新一档）
  const hf = readHandoffFiles(docsDir);
  const mainlines = activeMainlines(tasks, now);
  const latest = collectHandoffLatest(hf.files, { scope: o.handoffScope, lines: [...mainlines.keys()] });
  const collapsed = latest.collapsed;
  const handoffCandidates = [];
  for (const doc of latest.groups) {
    if (now - doc.mtimeMs < days * DAY_MS) continue; // 新档 ⇒ 该主线不算停滞
    let text = '';
    try { text = fs.readFileSync(doc.fullPath, 'utf8'); } catch (e) {
      skips.push({ key: `handoff:${doc.name}`, reason: `read-error:${e?.message ?? e}` });
      continue;
    }
    const r = classifyHandoff({ ...doc, text }, ctx);
    if (r && r.skip) skips.push({ key: r.key, reason: r.skip });
    else if (r) handoffCandidates.push(r);
  }

  const all = sortCandidates([...cardCandidates, ...handoffCandidates]);
  const skipCounts = {};
  for (const s of skips) skipCounts[s.reason] = (skipCounts[s.reason] ?? 0) + 1;

  // ⑤ 三道闸（只对推送；报告留完整清单）
  const st = readState(home);
  const state = st.state;
  const date = localDate(now);
  const weekday = new Date(now).getDay();
  const weekend = weekday === 0 || weekday === 6;

  const enriched = all.map((x) => {
    const item = state.items[x.key];
    const notifiedAt = item?.lastNotifiedAt ? Date.parse(item.lastNotifiedAt) : 0;
    const snoozedUntil = item?.snoozedUntil ? Date.parse(item.snoozedUntil) : 0;
    let pushStatus = 'eligible';
    if (Number.isFinite(snoozedUntil) && snoozedUntil > now) pushStatus = 'snoozed';
    else if (Number.isFinite(notifiedAt) && notifiedAt && now - notifiedAt < 24 * HOUR_MS) pushStatus = 'cooldown';
    return { ...x, pushStatus, snoozedUntil: item?.snoozedUntil ?? null };
  });

  const candidates = enriched.map(({ pushStatus, snoozedUntil, ...rest }) => ({
    ...rest, pushStatus, snoozedUntil,
  }));

  let pushReason = 'dry-run';
  let pushed = [];
  let alert = null;
  if (o.push && !o.apply) throw new Error('--push 需要同时给 --apply');
  const eligible = candidates.filter((x) => x.pushStatus === 'eligible');
  if (o.push) {
    if (weekend) pushReason = 'weekend';
    else if (state.lastPushDate === date) pushReason = 'today-pushed';
    else if (!eligible.length) pushReason = 'no-candidates';
    else {
      pushed = eligible.slice(0, top);
      const text = composePushText(pushed, { now });
      const send = o.sendNotification ?? ((a) => sendNudge({ ...a, home, recipient: o.recipient, log }));
      alert = await send({ text, home, recipient: o.recipient });
      if (alert?.ok && alert?.serverId) {
        pushReason = 'ok';
        // 只在真有 serverId 时记 lastPushDate / lastNotifiedAt（失败要能重试）
        state.lastPushDate = date;
        for (const x of pushed) {
          state.items[x.key] = {
            ...(state.items[x.key] ?? {}),
            lastNotifiedAt: new Date(now).toISOString(),
            title: x.title,
          };
        }
      } else {
        pushReason = 'send-failed';
        pushed = [];
      }
    }
  }
  // 给报告标推送状态（snoozed / cooldown 保留原标记）
  const pushedKeys = new Set(pushed.map((x) => x.key));
  for (const x of candidates) {
    if (pushedKeys.has(x.key)) x.pushStatus = 'pushed';
    else if (x.pushStatus === 'snoozed' || x.pushStatus === 'cooldown') continue;
    else if (o.push && pushReason === 'ok') x.pushStatus = 'not-top';
    else x.pushStatus = 'not-pushed';
  }

  const result = {
    ok: true,
    now,
    date,
    weekday,
    weekend,
    params: { days, top },
    counts: {
      boardTasks: tasks.length,
      boardTodo: tasks.filter((t) => t.status === 'todo').length,
      boardFailed: tasks.filter((t) => t.status === 'failed').length,
      boardRunning: tasks.filter((t) => t.status === 'running').length,
      handoffFiles: hf.files.length,
      handoffTopics: latest.groups.length,
      handoffUnmatched: latest.unmatched.length,
      handoffScope: o.handoffScope,
      handoffCandidates: handoffCandidates.length,
      candidates: candidates.length,
      byTier: {
        failed: candidates.filter((x) => x.tier === 'failed').length,
        fakeRunning: candidates.filter((x) => x.tier === 'fakeRunning').length,
        todo: candidates.filter((x) => x.tier === 'todo').length,
        handoff: candidates.filter((x) => x.tier === 'handoff').length,
      },
    },
    board: { ok: board.ok, error: board.error ?? null, revision: board.revision ?? null },
    sessions: { trusted: sessions.trusted, size: sessions.map.size, reason: sessions.reason },
    candidates,
    pushed,
    pushReason,
    alert,
    skips,
    skipCounts,
    collapsed,
    statePath: statePath(home),
    reportPath: reportPath(reportDir, now),
    stateWritten: false,
    reportWritten: false,
  };

  if (o.apply) {
    writeStateAtomic(home, state, now);
    result.stateWritten = true;
    fs.mkdirSync(path.dirname(result.reportPath), { recursive: true });
    fs.writeFileSync(result.reportPath, renderReport(result) + '\n', 'utf8');
    result.reportWritten = true;
    log(`报告已写：${result.reportPath}`);
    log(`状态已写：${result.statePath}`);
  }

  return result;
}

// ---------------------------------------------------------------- 状态操作（搁置）

export function normalizeKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^(card|handoff):/.test(s)) return s;
  return `card:${s}`;
}

export function snoozeKey({ home, key, hours, now = Date.now(), apply = false }) {
  if (!Number.isFinite(hours) || hours <= 0) {
    const e = new Error('--hours 必须是正数（>0）');
    e.code = 2;
    throw e;
  }
  const k = normalizeKey(key);
  if (!k) {
    const e = new Error('--snooze 需要 key（card:<id> / handoff:<档名>）');
    e.code = 2;
    throw e;
  }
  const st = readState(home);
  const until = new Date(now + hours * HOUR_MS).toISOString();
  const next = {
    ...st.state,
    items: { ...st.state.items, [k]: { ...(st.state.items[k] ?? {}), snoozedUntil: until } },
  };
  if (apply) writeStateAtomic(home, next, now);
  return { key: k, snoozedUntil: until, apply, statePath: statePath(home) };
}

export function listSnooze({ home, now = Date.now() }) {
  const st = readState(home);
  const rows = Object.entries(st.state.items)
    .filter(([, v]) => v?.snoozedUntil)
    .map(([key, v]) => {
      const until = Date.parse(v.snoozedUntil);
      return { key, title: v.title ?? null, snoozedUntil: v.snoozedUntil, active: Number.isFinite(until) && until > now };
    });
  return { statePath: statePath(home), lastPushDate: st.state.lastPushDate, rows };
}

// ---------------------------------------------------------------- CLI

const HELP = `stall-nudge · 主线停滞提醒 v1（只提醒不动手）

用法：
  node stall-nudge.mjs [--days 3] [--top 3] [--json|--md] [--apply] [--push]
                       [--snooze <key> --hours 24] [--list-snooze]
                       [--base-url <URL>] [--home <dir>] [--now <ISO>] [--help]

参数：
  --days N       停滞阈值（天，默认 3）
  --top N        推送条数（默认 3；报告始终列全部候选）
  --json         stdout 只输出 JSON（日志走 stderr）
  --md           stdout 只输出 Markdown 报告
  --apply        写状态文件 + docs/（缺省 dry-run 零写盘）
  --push         真发通知（需要 --apply；只取 Top N；工作日每天最多一次）
  --snooze K     「先放着」：把 card:<id> / handoff:<档名> 搁置 N 小时（配合 --hours，写盘需 --apply）
  --list-snooze  只读列出搁置项与 lastPushDate
  --base-url     看板地址（默认 http://localhost:3080）
  --handoff-scope active|all  交接档判定范围（默认 active = 只看仍有在途/近 30 天活动的主线）
  --home         DSH home（默认 ~/.dsh；夹具用）
  --now          以指定时间判定（ISO，夹具用）

四类信号：failed > 假 running > todo 久置 > 交接档久置。
通道：通知注入点（lib/notify.mjs）；本包不带具体通道，默认 console + no-op。
退出码：0 OK / 1 运行失败 / 2 用法错
`;

function parseArgv(argv) {
  const o = {
    days: DEFAULT_DAYS, top: DEFAULT_TOP, json: false, md: false, apply: false, push: false,
    snooze: null, hours: null, listSnooze: false, help: false,
    baseUrl: undefined, home: undefined, now: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = (name) => {
      const j = argv.indexOf(`--${name}`);
      return j >= 0 && argv[j + 1] !== undefined ? argv[j + 1] : null;
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--md') o.md = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--push') o.push = true;
    else if (a === '--list-snooze') o.listSnooze = true;
    else if (a === '--days') { o.days = Number(val('days')); i += 1; }
    else if (a === '--top') { o.top = Number(val('top')); i += 1; }
    else if (a === '--snooze') { o.snooze = val('snooze'); i += 1; }
    else if (a === '--hours') { o.hours = Number(val('hours')); i += 1; }
    else if (a === '--base-url') { o.baseUrl = val('base-url'); i += 1; }
    else if (a === '--handoff-scope') {
      const v = val('handoff-scope');
      if (v !== 'active' && v !== 'all') throw Object.assign(new Error('--handoff-scope 只认 active|all'), { code: 2 });
      o.handoffScope = v; i += 1;
    }
    else if (a === '--home') { o.home = val('home'); i += 1; }
    else if (a === '--now') { o.now = val('now'); i += 1; }
    else if (a.startsWith('--')) throw Object.assign(new Error(`未知参数：${a}`), { code: 2 });
  }
  if (!Number.isFinite(o.days) || o.days <= 0) throw Object.assign(new Error('--days 必须是正数'), { code: 2 });
  if (!Number.isInteger(o.top) || o.top <= 0) throw Object.assign(new Error('--top 必须是正整数'), { code: 2 });
  if (o.now !== undefined) {
    const t = Date.parse(String(o.now));
    if (!Number.isFinite(t)) throw Object.assign(new Error('--now 需要合法 ISO 时间'), { code: 2 });
    o.now = t;
  }
  if (o.push && !o.apply) throw Object.assign(new Error('--push 需要同时给 --apply'), { code: 2 });
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  const log = (m) => process.stderr.write(`${m}\n`);
  let o;
  try { o = parseArgv(argv); } catch (e) {
    log(`[stall-nudge] ${e.message}`);
    return e.code ?? 2;
  }
  if (o.help) { process.stdout.write(HELP); return 0; }

  if (o.listSnooze) {
    const r = listSnooze({ home: path.resolve(o.home ?? dshHome()), now: o.now ?? Date.now() });
    if (o.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
    const L = [`搁置项（${r.statePath}）`, `lastPushDate: ${r.lastPushDate ?? '—'}`];
    if (!r.rows.length) L.push('（无）');
    for (const x of r.rows) L.push(`  ${x.active ? '⏸ 生效' : '⌛ 已过期'}  ${x.key}  → ${x.snoozedUntil}${x.title ? `  ${x.title}` : ''}`);
    process.stdout.write(L.join('\n') + '\n');
    return 0;
  }

  if (o.snooze !== null) {
    const now = o.now ?? Date.now();
    try {
      const r = snoozeKey({ home: path.resolve(o.home ?? dshHome()), key: o.snooze, hours: o.hours, now, apply: o.apply });
      process.stdout.write(`${o.apply ? '已搁置' : 'DRY-RUN · 将搁置'} ${r.key} → ${r.snoozedUntil}\n${o.apply ? '' : '（真写盘请加 --apply）\n'}`);
      return 0;
    } catch (e) {
      log(`[stall-nudge] ${e.message}`);
      return e.code ?? 2;
    }
  }

  let result;
  try {
    result = await runStallNudge({ ...o, log });
  } catch (e) {
    log(`[stall-nudge] ${e.message}`);
    return e.code ?? 1;
  }
  if (o.json) {
    const slim = {
      ok: result.ok, now: result.now, date: result.date, params: result.params, counts: result.counts,
      pushed: result.pushed.map((x) => ({ key: x.key, title: x.title, tier: x.tier })),
      pushReason: result.pushReason, alert: result.alert,
      candidates: result.candidates.map((x) => ({
        key: x.key, tier: x.tier, title: x.title, stagnDays: x.stagnDays,
        lastWhere: x.lastWhere, nextStep: x.nextStep, pushStatus: x.pushStatus,
      })),
      skips: result.skips, skipCounts: result.skipCounts,
      reportPath: result.reportPath, statePath: result.statePath,
      reportWritten: result.reportWritten, stateWritten: result.stateWritten,
    };
    process.stdout.write(JSON.stringify(slim, null, 2) + '\n');
  } else if (o.md) {
    process.stdout.write(renderReport(result) + '\n');
  } else {
    const L = [
      `主线停滞提醒 · ${result.date}（候选 ${result.counts.candidates} 条）`,
      `  推送：${result.pushed.length} 条 · 原因 ${result.pushReason}`,
      ...result.pushed.map((x, i) => `    ${i + 1}. [${TIERS[x.tier].label}] ${x.title}（停滞 ${x.stagnDays} 天）`),
      `  报告：${result.reportWritten ? result.reportPath : '（dry-run 未写）'}`,
      `  状态：${result.stateWritten ? result.statePath : '（dry-run 未写）'}`,
    ];
    process.stdout.write(L.join('\n') + '\n');
  }
  return 0;
}

// 入口守卫：junction 下 import.meta.url（物理）与 argv[1]（逻辑）realpath 后比较
function isMainEntry() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1] ?? ''));
  } catch { return false; }
}

if (isMainEntry()) {
  main().then((code) => { process.exitCode = code ?? 0; }, (e) => {
    process.stderr.write(`[stall-nudge] 未捕获错误：${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
