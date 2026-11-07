// dsh-butler / lib/notify.mjs —— 通知注入点（本包唯一出口）
//
// 为什么有这个模块（2026-11-07 · 开源批 2）：
//   上游本体把「提醒发到人」这件事直接写进了一段私有通道代码（服务面推送出口），
//   那段代码绑定具体账号与凭证，**不随开源发布**。本包保留"要提醒"这件事，
//   但**不带任何具体通道**：宿主注入一个 notifier 函数，就能把提醒接到自己的通道上。
//
// 两个层次的接口：
//   ① 高层：`notify({ level, title, body, dedupeKey, channel })`
//      —— 业务侧只说"发什么、多急、同一件事别重复发"，不关心发到哪。
//   ② 低层：`setNotifier(fn)` / `getNotifier()`
//      —— 宿主用自己的实现替换默认实现；`fn(request) => Promise<result>`。
//
// 默认实现 = **console + no-op**：
//   · 往 stderr 打一行 `[butler:notify] <level> <title> — <body 首行>`（看得见，人当场能发现）；
//   · 返回值 `{ ok: false, skipped: true, error: 'no-channel' }`（**不假装发出去了**）。
//   ⇒ 没有注入通道时，调用方的"失败可重试"逻辑照常生效，不会出现"以为发了其实没发"。
//
// 通道开关（默认关，与上游同款语义）：
//   · 载体 `<home>/butler-alert.json`，键 `channels.alert`：`true|'on'` 开 / 其它关；
//     缺文件 = 关。`<home>` = `opts.home` 或 `resolveDshHome()`。
//   · 单轮覆盖：`opts.alertChannel` / `opts.channels.alert`（夹具与实验用，不落盘）。
//
// 去重（跨进程也去重）：
//   · 给了 `dedupeKey` ⇒ 同一 key 在**同一本地日**只真正发一次；
//     状态落 `<home>/butler-notify-dedupe.json`（只留当天的 key，读取失败按"没发过"处理）。
//   · 没有 `dedupeKey` ⇒ 不去重（调用方自己已经过了一道闸的场景）。
//
// 本模块零第三方依赖，只 import node: 内置模块。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NOTIFY_VERSION = '0.1.0';
export const NOTIFY_CHANNELS = Object.freeze(['alert', 'pet', 'console']);
/** 正文硬上限（字节）。与上游"一条手机通知能看全"的口径一致。 */
export const MAX_BODY_BYTES = 400;
/** 单进程内去重窗口（同一 key 的并发/连发）。 */
const MEMO_TTL_MS = 6 * 3_600_000;

let customNotifier = null;
const memo = new Map(); // dedupeKey -> atMs

/** 默认 home（与包的其它模块同口径：`<DSH_HOME>` → `~/.dsh`）。 */
function defaultHome(opts = {}) {
  if (typeof opts.home === 'string' && opts.home) return opts.home;
  const env = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (env) return env;
  return path.join(os.homedir(), '.dsh');
}

function localDay(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function truncateBytes(text, max = MAX_BODY_BYTES) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = s;
  while (Buffer.byteLength(out + '…', 'utf8') > max) out = out.slice(0, -1);
  return out + '…';
}

function oneLine(s, max = 200) {
  const t = String(s ?? '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ───────────────────────────────────────────── 注入面

/**
 * 注入宿主自己的通知实现。
 * @param {null|((req:{level:string,title:string,body:string,dedupeKey:string|null,channel:string,now:number})=>Promise<any>|any)} fn
 *   `null` = 恢复默认（console + no-op）。
 * @returns {{ok:boolean, previous:string}}
 */
export function setNotifier(fn) {
  if (fn !== null && typeof fn !== 'function') {
    return { ok: false, previous: customNotifier ? 'custom' : 'default', error: 'notifier-must-be-function-or-null' };
  }
  const previous = customNotifier ? 'custom' : 'default';
  customNotifier = fn;
  return { ok: true, previous };
}

/** 当前注入的是谁（`'custom'` / `'default'`）。 */
export function getNotifier() {
  return customNotifier;
}

/** 是否已注入（供调用方决定要不要走"失败可重试"分支）。 */
export function hasNotifier() {
  return typeof customNotifier === 'function';
}

// ───────────────────────────────────────────── 通道开关

/**
 * 读通道开关（默认关）。
 * @param {{home?:string, alertChannel?:unknown, channels?:{alert?:unknown}, now?:number}} [opts]
 * @returns {{enabled:boolean, channel:string, reason:string, source:string}}
 */
export function resolveAlertChannel(opts = {}) {
  const fileName = path.join(defaultHome(opts), 'butler-alert.json');
  const norm = (v) => {
    if (v === true) return true;
    if (v === false || v === undefined || v === null) return false;
    const s = String(v).trim().toLowerCase();
    return s === 'on' || s === 'true' || s === '1' || s === 'yes';
  };
  const override = opts.alertChannel ?? (opts.channels && opts.channels.alert);
  if (override !== undefined && override !== null) {
    return { enabled: norm(override), channel: 'alert', reason: `override:${override}`, source: 'override' };
  }
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(fileName, 'utf8')); } catch { /* 缺文件 / 坏文件 = 关 */ }
  const raw = cfg && cfg.channels ? cfg.channels.alert : undefined;
  const enabled = norm(raw);
  return {
    enabled,
    channel: 'alert',
    reason: cfg ? (enabled ? 'config:on' : 'config:off') : 'config-missing',
    source: 'config',
    file: fileName,
  };
}

// ───────────────────────────────────────────── 去重

function dedupeFile(home) {
  return path.join(home, 'butler-notify-dedupe.json');
}

function readDedupe(home) {
  try {
    const j = JSON.parse(fs.readFileSync(dedupeFile(home), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function seenToday(home, key, day) {
  const j = readDedupe(home);
  const at = j[key];
  return typeof at === 'string' && at.startsWith(day);
}

function markToday(home, key, day, iso) {
  const j = readDedupe(home);
  const next = { [key]: iso };
  for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && v.startsWith(day) && k !== key) next[k] = v;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(dedupeFile(home), `${JSON.stringify(next, null, 1)}\n`, 'utf8');
  } catch { /* 去重状态写不了 ⇒ 最多多发一次，不阻断发送 */ }
}

// ───────────────────────────────────────────── 默认实现

function consoleNotifier(req) {
  const body = oneLine(req.body, 160);
  process.stderr.write(`[butler:notify] ${req.level} ${req.title}${body ? ` — ${body}` : ''}\n`);
  return { ok: false, skipped: true, error: 'no-channel', channel: req.channel };
}

// ───────────────────────────────────────────── 主入口

/**
 * 发一条通知。
 *
 * @param {{level?:'info'|'warn'|'error'|'alert', title?:string, body?:string,
 *          dedupeKey?:string|null, channel?:string, home?:string, now?:number,
 *          dryRun?:boolean, alertChannel?:unknown, channels?:object, force?:boolean}} req
 * @returns {Promise<{ok:boolean, skipped?:boolean, deduped?:boolean, error:string|null, channel:string,
 *   channelEnabled:boolean, reason?:string, bytes:number, ms:number, msgid:string|null, stage?:string}>}
 */
export async function notify(req = {}) {
  const started = Date.now();
  const now = Number.isFinite(req.now) ? req.now : Date.now();
  const channel = String(req.channel ?? 'alert');
  const level = String(req.level ?? 'info');
  const title = String(req.title ?? '');
  const body = truncateBytes(req.body ?? '');
  const bytes = Buffer.byteLength(body, 'utf8');
  const home = defaultHome(req);
  const gate = resolveAlertChannel({ ...req, home });
  const base = {
    channel, channelEnabled: gate.enabled, reason: gate.reason,
    bytes, ms: 0, msgid: null, error: null,
  };

  // ① 通道开关：默认关 ⇒ 连一个字节都不发（与上游同款语义，不算故障）
  if (!gate.enabled && channel !== 'console') {
    return { ...base, ok: false, skipped: true, error: 'channel-off', stage: 'gate', ms: Date.now() - started };
  }
  // ② 去重：同一 key 同一本地日只真发一次
  const day = localDay(now);
  const key = req.dedupeKey ? String(req.dedupeKey) : null;
  if (key && req.force !== true) {
    const m = memo.get(key);
    if (m && now - m < MEMO_TTL_MS) {
      return { ...base, ok: false, deduped: true, error: 'dedupe', stage: 'dedupe', ms: Date.now() - started };
    }
    if (seenToday(home, key, day)) {
      return { ...base, ok: false, deduped: true, error: 'dedupe', stage: 'dedupe', ms: Date.now() - started };
    }
  }
  // ③ 发送（注入的优先；没有就是 console + no-op）
  const fn = typeof customNotifier === 'function' ? customNotifier : consoleNotifier;
  let r;
  try {
    r = await fn({ level, title, body, dedupeKey: key, channel, now, home });
  } catch (e) {
    r = { ok: false, error: `THROW: ${e?.message ?? e}` };
  }
  const ok = r?.ok === true;
  if (key && ok) {
    memo.set(key, now);
    markToday(home, key, day, new Date(now).toISOString());
  }
  return {
    ...base,
    ok,
    error: ok ? null : String(r?.error ?? 'send-failed'),
    msgid: r?.msgid ?? null,
    stage: ok ? null : String(r?.stage ?? 'send'),
    ms: Date.now() - started,
  };
}

/**
 * 便捷包装：一段文本走 alert 通道。
 * 形状对齐上游"单一出口发一段话"的返回（`ok/skipped/error/channelEnabled/bytes/ms/msgid`），
 * 方便调用点从旧实现平移到本模块。
 */
export async function sayAlert(text, opts = {}) {
  const req = {
    level: opts.level ?? 'alert',
    title: opts.title ?? 'butler',
    body: text,
    dedupeKey: opts.dedupeKey ?? null,
    channel: 'alert',
    home: opts.home,
    now: opts.now,
    dryRun: opts.dryRun,
    alertChannel: opts.alertChannel,
    channels: opts.channels,
    force: opts.force,
  };
  const gate = resolveAlertChannel({ ...opts, home: defaultHome(opts) });
  if (!gate.enabled) {
    return {
      ok: false, skipped: true, error: 'channel-off', reason: gate.reason, channelEnabled: false,
      channel: 'alert', bytes: Buffer.byteLength(String(text ?? ''), 'utf8'), ms: 0, msgid: null, stage: 'gate',
    };
  }
  if (opts.dryRun === true) {
    return {
      ok: false, error: 'dry-run', channelEnabled: true, reason: gate.reason, channel: 'alert',
      bytes: Buffer.byteLength(String(text ?? ''), 'utf8'), ms: 0, msgid: null, stage: 'dry-run',
    };
  }
  const r = await notify(req);
  return { ...r, reason: r.reason ?? gate.reason };
}

export default { notify, sayAlert, setNotifier, getNotifier, hasNotifier, resolveAlertChannel, NOTIFY_CHANNELS };
