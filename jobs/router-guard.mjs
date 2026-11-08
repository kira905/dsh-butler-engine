#!/usr/bin/env node
/**
 * dsh-butler / router-guard.mjs —— 统筹线 R1-6 · Router 守护与巡检
 *
 * 方案真源 = `docs\方案-Router Session-20261102.md`
 *   §3 分期表 R1-6 行（L233）：守护五项 = 置顶复位 / 归档保护 / 会话身份漂移 / Bot ready / cwd 还在
 *   §4 R1（24h 归档会把 Router 会话搬走）· §4 R2（QQ 掉线判据）· §6 R10（会话身份漂移）
 *
 * ── 一句话语义 ───────────────────────────────────────────────────────────────
 *   一条命令把 Router 那套「不该坏的东西」现读一遍；坏了能自己拨回来就拨回来（记一行），
 *   拨不回来就报警一行。默认 **dry-run**（只看不动），`--apply` 才动作；tickd job 带 `--apply`。
 *
 * ── 五项判据（一律现读：读文件 / 调 RPC / 读日志，不许用缓存、不许"上次是好的"）──
 *   1 置顶复位    : `workspace.json#global.workspaceIds` 里 Router 工作区**不是第一个**
 *                   ⇒ `workspace.insertBefore` 挪回第 1 位（顺序即置顶，**没有硬 pin 字段**）。
 *   2 归档保护    : `archivedSessionIds` 含**当前 Router 会话** ⇒ `workspace.unarchiveSession`
 *                   复原（归档只是标记、moveFiles=false，复原零成本）+ 记一行。
 *                   ⚠️ 只认「当前 Router 会话」，**不去复活**工作区里历史被归档的旧会话
 *                   （它们本轮就该躺在归档里；复活 = 每天把旧会话翻出来）。
 *   3 身份漂移    : `~/.dsh-qqbot/model-prefs.json#sessionIds["qqbot:<appId>:<通道>:<openid>"]`
 *                   是否**逐字等于**当前 Router 会话 uuid；不等 ⇒ 重写成当前 uuid + 记一行 +
 *                   报警「下次重启生效」（写 prefs 要重启才被插件读到；**本件不重启**）。
 *                   ⚠️ **2026-11-02 第 12 棒扩面**：原来只认 `:c2c:` 一种键 ⇒ **群键 `:group:` 完全裸奔**，
 *                   群里漂到死会话也报 ok。现在按 `qqbot:<appId>:` 前缀收**全部**对端键（c2c + group +
 *                   以后新增的通道），任一键不等就修；输出分别报 c2c / group 的个数。
 *   4 Bot ready   : 最新一份 `<workspace>\logs\dsh-web-*.log` 里有没有
 *                   `[im-qqbot] Bot ready! appId=<appId>`；只有 `Starting bot` = 连不上
 *                   ⇒ 只报警（重启是 P0 闸门的事，本件绝不自己重启），报警文案带兜底
 *                   「回 GUI 用同一个 Router 会话」。
 *   5 cwd 还在    : `<workspace>\assets\router` 存在 **且** 当前 Router 会话 header.cwd 仍是它
 *                   ⇒ 假就只报警（**不自动建目录**，免得将错就错把会话钉到一个空目录）。
 *
 * ── 三种结局 + 一个兜底（输出口径）─────────────────────────────────────────────
 *   `ok` / `已复位` / `报警` / `unknown`（某一项读不到 ⇒ 记 unknown 继续下一项，**整脚本不崩**）。
 *
 * ── 幂等 ─────────────────────────────────────────────────────────────────────
 *   复位动作全部是「只在不对时才动」的形态：复位后再跑一次 = 五项全 ok、零动作、零新增报警。
 *
 * ── 报警出口（与其它 job 同一条）─────────────────────────────────────────────
 *   `lib\alert.mjs#alert()` ⇒ `~/.dsh/butler-alert.log` 追加一行 JSON
 *   `{at, level, source:'router-guard', message, detail}` + stderr 一行。
 *   ⚠️ 本件**挂了就去重**：同一条「站着的报警」（sig 相同）6 小时内只落一行，免得每 30 分钟
 *      刷一遍同样的话；`--no-dedupe` / `--dedupe-min 0` 可关掉（演练用）。「已复位」不受去重约束
 *      ——它是一次性事件，每次都要能看见。
 *
 * ── 失败即让路（fail-open）──────────────────────────────────────────────────
 *   workspace.json / prefs / 日志 / 会话 header 任何一处读不到 ⇒ 该项 `unknown`，其它项照跑。
 *   `workspace.json` 与 `prefs` **两处都读不到** ⇒ 环境未就绪，退出码 3（tickd 侧
 *   `benignExitCodes:[3]` ⇒ 本轮让路、不涨 failures）；其余情况退出码 0（"有报警"不是脚本失败）。
 *
 * ── CLI ────────────────────────────────────────────────────────────────────
 *   node router-guard.mjs                     # dry-run：只报「该复位什么」
 *   node router-guard.mjs --apply             # 真复位（tickd job 走这条）
 *   node router-guard.mjs --json              # 机读（stdout 纯 JSON）
 *   node router-guard.mjs --once              # 兼容 tickd 的固定形态（无额外语义）
 *   node router-guard.mjs --quiet             # 不打 stderr 告警回声（落盘照旧）
 *   node router-guard.mjs --no-dedupe          # 不做报警去重（演练取证用）
 *   node router-guard.mjs --dedupe-min 0      # 同上，显式给窗口
 *
 * ── 夹具钩子（只见于测试，生产不设）────────────────────────────────────────
 *   ROUTER_GUARD_WS_FILE / ROUTER_GUARD_PREFS_FILE / ROUTER_GUARD_LOGS_DIR /
 *   ROUTER_GUARD_ROOT / ROUTER_GUARD_APP_ID / ROUTER_GUARD_STATE_FILE
 *   ROUTER_GUARD_OFFLINE_RPC=1  ⇒ 所有写 RPC 直接返回 offline（夹具里跑 --apply 不碰生产）
 *   BUTLER_DSH_HOME / DSH_HOME  ⇒ 状态件与报警件的 home 口径（隔离测试用）
 *
 * ── 锁 ──────────────────────────────────────────────────────────────────────
 *   脚本自身 `acquireTickLock('router-guard')`（登记在 `lib\butler-locks.mjs`）；
 *   手工直跑与 tickd 并发时后来者记 locked、本轮跳过（退出码 0，不算失败）。
 *   **刻意不加 `lockRunner`**：包装层再抢同一把锁会让子进程永远判 locked（steward 同款先例）。
 */
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import { hostRpc } from '../src/lib/dsh-host-rpc.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { findSessionFile, readSessionHeader } from './lib/session-header.mjs';

const VERSION = '1.1.0'; // 1.0.0 = R1-6 五项；**1.1.0 = 2026-11-02 第12棒**：第 3 项从「只认 c2c 键」扩到「appId 前缀下全部对端键」（c2c + group），输出分别报 c2c / group 个数
const HOME = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || dshHome();

function envStr(name, fallback) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

const CFG = {
  home: HOME,
  wsFile: envStr('ROUTER_GUARD_WS_FILE', path.join(HOME, 'storages', 'workspace.json')),
  prefsFile: envStr('ROUTER_GUARD_PREFS_FILE', path.join(os.homedir(), '.dsh-qqbot', 'model-prefs.json')),
  logsDir: envStr('ROUTER_GUARD_LOGS_DIR', path.join(workspaceRoot(), 'logs')),
  routerPath: envStr('ROUTER_GUARD_ROOT', path.join(workspaceRoot(), 'assets', 'router')),
  appId: envStr('ROUTER_GUARD_APP_ID', '1906133643'),
  base: envStr('DSH_WEB_URL', 'http://localhost:3080'),
  stateFile: envStr('ROUTER_GUARD_STATE_FILE', path.join(HOME, 'router-guard-state.json')),
  offlineRpc: process.env.ROUTER_GUARD_OFFLINE_RPC === '1',
  dedupeMs: 6 * 3_600_000,
  /** 重启后多久之内只认「启动中」不报警（避免每次 P0 重启后第一轮误报一次掉线） */
  graceMs: 180_000,
  ttlMs: 120_000,
  rpcTimeoutMs: 20_000,
};

// ── CLI ────────────────────────────────────────────────────────────────────
const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const JSON_OUT = ARGV.includes('--json');
const QUIET = ARGV.includes('--quiet');
const NO_DEDUPE = ARGV.includes('--no-dedupe');
const HELP = ARGV.includes('--help') || ARGV.includes('-h');

function argNum(name) {
  const i = ARGV.indexOf(name);
  if (i < 0) return null;
  const v = Number(ARGV[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
const DEDUPE_MS = NO_DEDUPE ? 0 : (argNum('--dedupe-min') !== null ? argNum('--dedupe-min') * 60_000 : CFG.dedupeMs);

// ── 状态词 ─────────────────────────────────────────────────────────────────
const OK = 'ok';
const FIXED = 'fixed';
const ALARM = 'alarm';
const UNKNOWN = 'unknown';
const LABEL = { ok: 'ok', fixed: '已复位', alarm: '报警', unknown: 'unknown' };

const ITEM_ORDER = ['pin', 'archive', 'drift', 'botready', 'cwd'];
const ITEM_NAME = {
  pin: '置顶复位',
  archive: '归档保护',
  drift: '身份漂移',
  botready: 'Bot ready',
  cwd: 'cwd 还在',
};

// ── 小工具 ─────────────────────────────────────────────────────────────────
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

function clip(s, n = 220) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function shortSid(sid) {
  const s = String(sid ?? '');
  return s.length > 24 ? `${s.slice(0, 16)}…` : s;
}

function stamp(ms = Date.now()) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Windows 路径规范化比较（大小写不敏感；junction 走 realpath） */
function canon(p) {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    try {
      return path.resolve(String(p)).toLowerCase();
    } catch {
      return String(p).toLowerCase();
    }
  }
}

/**
 * 一组会话里「最近写过」的那个（**只 stat 文件、不解压**，所以便宜）。
 * 用途：工作区会话全被归档时，仍能认出「刚才还在用的」是哪一个。
 * 全部读不到 ⇒ null（调用方再退一步）。
 */
function newestSessionByMtime(sids) {
  let best = null;
  for (const sid of sids) {
    try {
      const file = findSessionFile(sid, CFG.home);
      if (!file) continue;
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { sid, mtimeMs };
    } catch { /* 单个会话文件读不到就跳过 */ }
  }
  return best?.sid ?? null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 原子写 JSON（同盘 tmp + rename；跨盘 rename 会 EXDEV，本件写的一律同目录 tmp） */
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
  try {
    return { ok: true, value: readJson(file) };
  } catch (e) {
    return { ok: false, error: `${e?.code ?? ''} ${e?.message ?? e}`.trim(), value: null };
  }
}

/** 落盘可能有几十毫秒延迟（RPC 先回、文件后写）⇒ 回读带重试 */
async function readWsSettled(tries = 10, waitMs = 250) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = readJsonSafe(CFG.wsFile);
    if (r.ok && r.value?.global?.workspaceIds) return r.value;
    last = r;
    if (i < tries - 1) await new Promise((res) => setTimeout(res, waitMs));
  }
  if (last?.ok) return last.value;
  return null;
}

/** 唯一一处写 RPC 入口（离线夹具 / 失败统一在这里收口） */
async function rpc(method, payload) {
  if (CFG.offlineRpc) return { ok: false, error: 'offline（ROUTER_GUARD_OFFLINE_RPC=1，夹具模式不碰生产）' };
  try {
    const { status, body } = await hostRpc(CFG.base, method, payload, { timeoutMs: CFG.rpcTimeoutMs });
    if (status !== 200) return { ok: false, error: `HTTP ${status}` };
    const r = body?.result;
    if (r?.ok !== true) {
      const err = r?.error;
      return { ok: false, error: err ? `${err.code}: ${err.message}` : clip(JSON.stringify(body), 200) };
    }
    return { ok: true, value: r.value };
  } catch (e) {
    return { ok: false, error: `${e?.message ?? e}` };
  }
}

function result(id, status, reason, extra = {}) {
  return { id, label: ITEM_NAME[id], status, reason: clip(reason, 400), ...extra };
}

// ── 现状解析（一次读全，五项共用；读不到留 null 由各项自己判 unknown）───────
async function resolveState() {
  const st = {
    ws: null, wsError: null, wsId: null, wsRec: null,
    archived: new Set(), wsSessionIds: [],
    prefs: null, prefsError: null, pinKeys: [], pinSid: null,
    currentSid: null, sidWhy: '',
  };

  const ws = readJsonSafe(CFG.wsFile);
  if (ws.ok && ws.value && typeof ws.value === 'object') {
    st.ws = ws.value;
    const want = canon(CFG.routerPath);
    for (const [id, rec] of Object.entries(ws.value?.tables?.workspaces ?? {})) {
      if (rec?.path && canon(rec.path) === want) {
        st.wsId = id;
        st.wsRec = rec;
        break;
      }
    }
    const arch = Array.isArray(ws.value?.global?.archivedSessionIds) ? ws.value.global.archivedSessionIds : [];
    st.archived = new Set(arch.map(String));
    st.wsSessionIds = Array.isArray(st.wsRec?.sessionIds) ? st.wsRec.sessionIds.map(String) : [];
  } else {
    st.wsError = ws.error ?? '解析不出对象';
  }

  const pf = readJsonSafe(CFG.prefsFile);
  if (pf.ok && pf.value && typeof pf.value === 'object') {
    st.prefs = pf.value;
    // 🔴 2026-11-02 第 12 棒：原来只扫 `c2c:` 后缀 ⇒ **群键**（`…:group:<openid>`）完全不在巡检覆盖里，
    //   群里哪天漂到死会话/派生野会话也照样报 ok（第 11 棒 §3 口径 4：c2c 与 group 是**两个 key**）。
    //   改成按 appId 前缀收**全部**对端键（c2c + group + 以后新增的通道类型）。
    const prefix = `qqbot:${CFG.appId}:`;
    st.pinKeys = Object.keys(st.prefs?.sessionIds ?? {}).filter((k) => String(k).startsWith(prefix));
    // pinSid 只作"认不出当前会话"时的兜底锚 ⇒ 优先取 c2c 键（主通道），没有才取第一个
    st.pinSid = st.pinKeys.length
      ? String(st.prefs.sessionIds[st.pinKeys.find((k) => k.includes(':c2c:')) ?? st.pinKeys[0]] ?? '') || null
      : null;
  } else {
    st.prefsError = pf.error ?? '解析不出对象';
  }

  // 「当前 Router 会话」= 工作区里**唯一一个未被归档**的会话（R1-2 验收口径：组里只有 1 个）。
  //   ⚠️ 「被归档了」这件事本身会让它从 live 里消失 ⇒ 不能只靠 live 反推，否则**归档 + 钉子被改坏
  //      同时发生**时第 2 项会误判 ok（2026-11-02 夹具当场抓到）。所以 0 个可见时按这个顺序回落：
  //      ① 工作区里**最近写过**的那个会话（文件 mtime；被归档的会话文件还在，mtime 仍可读）
  //      ② 读不到 mtime ⇒ 工作区 sessionIds 的第一个
  //      ③ 工作区一个会话都没登记 ⇒ prefs 钉子
  //   >1 个可见 ⇒ 若钉子在其中就以钉子为准（不多话），否则判「认不出来」⇒ 依赖它的项记 unknown。
  const live = st.wsSessionIds.filter((s) => !st.archived.has(s));
  if (live.length === 1) {
    st.currentSid = live[0];
    st.sidWhy = '工作区唯一未归档会话';
  } else if (live.length === 0) {
    const newest = newestSessionByMtime(st.wsSessionIds);
    if (newest) {
      st.currentSid = newest;
      st.sidWhy = '工作区没有未归档会话（回落到最近写过的那个）';
    } else if (st.wsSessionIds.length) {
      st.currentSid = st.wsSessionIds[0];
      st.sidWhy = '工作区没有未归档会话（mtime 读不到，回落到 sessionIds[0]）';
    } else {
      st.currentSid = st.pinSid ?? null;
      st.sidWhy = '工作区没有登记会话（回落到 prefs 钉子）';
    }
  } else if (st.pinSid && live.includes(st.pinSid)) {
    st.currentSid = st.pinSid;
    st.sidWhy = `工作区有 ${live.length} 个未归档会话（以 prefs 钉子为准）`;
  } else {
    st.currentSid = null;
    st.sidWhy = `工作区有 ${live.length} 个未归档会话、钉子不在其中 ⇒ 认不出当前 Router 会话`;
  }
  st.liveCount = live.length;
  return st;
}

// ── 第 1 项 · 置顶复位 ─────────────────────────────────────────────────────
async function checkPin(st) {
  const id = 'pin';
  if (!st.ws) return result(id, UNKNOWN, `workspace.json 读不到（${st.wsError}）：${CFG.wsFile}`, { sig: 'unknown|pin' });
  if (!st.wsId) {
    return result(id, ALARM, `Router 工作区未登记：${CFG.routerPath} 不在 workspace.json 的 tables.workspaces 里`, { sig: 'pin|not-registered' });
  }
  const ids = (st.ws.global?.workspaceIds ?? []).map(String);
  const idx = ids.indexOf(st.wsId);
  if (idx === 0) return result(id, OK, `已在第 1 位（共 ${ids.length} 组）`);
  if (idx < 0) {
    return result(id, ALARM, `工作区在 tables 里但不在 workspaceIds 顺序表里（侧边栏看不见）`, { sig: 'pin|not-in-order' });
  }
  const detail = `当前第 ${idx + 1} 位（共 ${ids.length} 组，第 1 位 ${shortSid(ids[0])}）`;
  if (!APPLY) {
    return result(id, ALARM, `${detail} —— dry-run 未动，加 --apply 会挪回第 1 位`, { sig: 'pin|not-first', wouldFix: true });
  }
  const r = await rpc('workspace.insertBefore', { workspaceId: st.wsId, beforeWorkspaceId: ids[0] });
  if (!r.ok) return result(id, ALARM, `${detail}；insertBefore 失败：${r.error}`, { sig: 'pin|not-first' });
  const after = await readWsSettled(8, 250);
  const top = after?.global?.workspaceIds?.[0] ?? null;
  if (top === st.wsId) return result(id, FIXED, `已挪回第 1 位（原第 ${idx + 1} 位）`);
  return result(id, ALARM, `insertBefore 回执 ok，但回读第 1 位仍是 ${shortSid(top)}（${CFG.wsFile}）`, { sig: 'pin|not-first' });
}

// ── 第 2 项 · 归档保护 ─────────────────────────────────────────────────────
async function checkArchive(st) {
  const id = 'archive';
  if (!st.ws) return result(id, UNKNOWN, `workspace.json 读不到（${st.wsError}）`, { sig: 'unknown|archive' });
  if (!st.currentSid) {
    return result(id, UNKNOWN, `认不出当前 Router 会话（${st.sidWhy}）`, { sig: 'unknown|archive' });
  }
  const counts = `工作区 ${st.wsSessionIds.length} 个会话 / 未归档 ${st.liveCount} 个`;
  if (!st.archived.has(st.currentSid)) {
    return result(id, OK, `当前 Router 会话 ${shortSid(st.currentSid)} 未被归档（${counts}）`);
  }
  if (!APPLY) {
    return result(id, ALARM, `当前 Router 会话 ${shortSid(st.currentSid)} 在 archivedSessionIds 里 —— dry-run 未动，加 --apply 复原`, {
      sig: 'archive|archived', wouldFix: true,
    });
  }
  const r = await rpc('workspace.unarchiveSession', { sessionId: st.currentSid });
  if (!r.ok) return result(id, ALARM, `会话 ${shortSid(st.currentSid)} 已被归档；unarchiveSession 失败：${r.error}`, { sig: 'archive|archived' });
  const after = await readWsSettled(8, 250);
  const still = new Set((after?.global?.archivedSessionIds ?? []).map(String));
  if (!still.has(st.currentSid)) {
    return result(id, FIXED, `已摘掉归档标记（会话 ${shortSid(st.currentSid)}；归档只是标记、文件没搬，复原零成本）`);
  }
  return result(id, ALARM, `unarchiveSession 回执 ok，但回读 archivedSessionIds 里仍有 ${shortSid(st.currentSid)}`, { sig: 'archive|archived' });
}

// ── 第 3 项 · 会话身份漂移 ─────────────────────────────────────────────────
/** 把钉子键按通道分类计数（c2c / group / 其他）—— 2026-11-02 第 12 棒加，让输出看得出群键有没有被覆盖 */
function pinBreakdown(keys) {
  const n = { c2c: 0, group: 0, other: 0 };
  for (const k of keys) {
    if (k.includes(':c2c:')) n.c2c++;
    else if (k.includes(':group:')) n.group++;
    else n.other++;
  }
  const parts = [];
  if (n.c2c) parts.push(`${n.c2c} 个 c2c 键`);
  if (n.group) parts.push(`${n.group} 个 group 键`);
  if (n.other) parts.push(`${n.other} 个其他键`);
  return parts.join(' + ') || '0 个键';
}

async function checkDrift(st) {
  const id = 'drift';
  if (!st.prefs) return result(id, UNKNOWN, `prefs 读不到（${st.prefsError}）：${CFG.prefsFile}`, { sig: 'unknown|drift' });
  if (!st.pinKeys.length) {
    return result(id, ALARM, `prefs 里没有任何 qqbot:${CFG.appId}: 对端键（c2c / group 都没有）—— QQ 钉子整个没了（消息会落进派生会话）`, { sig: 'drift|no-key' });
  }
  if (!st.currentSid) {
    return result(id, UNKNOWN, `认不出当前 Router 会话（${st.sidWhy}）⇒ 无法判定是否漂移`, { sig: 'unknown|drift' });
  }
  const bad = st.pinKeys.filter((k) => String(st.prefs.sessionIds[k] ?? '') !== st.currentSid);
  const presetNote = (() => {
    const off = st.pinKeys.filter((k) => st.prefs?.presets?.[k] !== 'router');
    return off.length ? `（注：presets 键 ${off.length} 个 ≠ router，本件不改、只报）` : '';
  })();
  if (!bad.length) {
    return result(id, OK, `prefs 钉子 == 当前 Router 会话 ${shortSid(st.currentSid)}（${pinBreakdown(st.pinKeys)}）${presetNote}`);
  }
  const oldList = bad.map((k) => shortSid(st.prefs.sessionIds[k])).join(' / ');
  if (!APPLY) {
    return result(id, ALARM, `钉子指向 ${oldList}，当前 Router 会话是 ${shortSid(st.currentSid)} —— dry-run 未动${presetNote}`, {
      sig: 'drift|mismatch', wouldFix: true,
    });
  }
  for (const k of bad) st.prefs.sessionIds[k] = st.currentSid;
  try {
    writeJsonAtomic(CFG.prefsFile, st.prefs);
  } catch (e) {
    return result(id, ALARM, `重写 prefs 失败：${e?.message ?? e}`, { sig: 'drift|mismatch' });
  }
  const back = readJsonSafe(CFG.prefsFile);
  const ok = back.ok && st.pinKeys.every((k) => String(back.value?.sessionIds?.[k] ?? '') === st.currentSid);
  if (ok) {
    return result(id, FIXED, `钉子已从 ${oldList} 改写成 ${shortSid(st.currentSid)}（**下次重启生效**，本件不自己重启）${presetNote}`);
  }
  return result(id, ALARM, `重写 prefs 后回读仍不一致（${CFG.prefsFile}）`, { sig: 'drift|mismatch' });
}

// ── 第 4 项 · Bot ready ────────────────────────────────────────────────────
function readNewestWebLog() {
  let names = [];
  try {
    names = fs.readdirSync(CFG.logsDir).filter((n) => /^dsh-web-.*\.log$/i.test(n));
  } catch (e) {
    return { error: `日志目录读不到（${e?.message ?? e}）：${CFG.logsDir}` };
  }
  if (!names.length) return { error: `日志目录里没有 dsh-web-*.log：${CFG.logsDir}` };
  let best = null;
  for (const n of names) {
    const file = path.join(CFG.logsDir, n);
    try {
      const stt = fs.statSync(file);
      if (!best || stt.mtimeMs > best.mtimeMs) best = { file, name: n, mtimeMs: stt.mtimeMs };
    } catch { /* 单个文件读不到就跳过 */ }
  }
  if (!best) return { error: `日志文件都 stat 不到：${CFG.logsDir}` };
  try {
    best.text = fs.readFileSync(best.file, 'utf8');
  } catch (e) {
    return { error: `最新日志读不到（${e?.message ?? e}）：${best.file}` };
  }
  return best;
}

async function checkBotReady() {
  const id = 'botready';
  const log = readNewestWebLog();
  if (log.error) return result(id, UNKNOWN, log.error, { sig: 'unknown|botready' });
  const ready = new RegExp(`\\[im-qqbot\\]\\s+Bot ready!\\s+appId=${CFG.appId}\\b`);
  if (ready.test(log.text)) {
    return result(id, OK, `最新日志 ${log.name} 有 Bot ready! appId=${CFG.appId}`);
  }
  const ageMs = Date.now() - log.mtimeMs;
  const ageS = Math.max(0, Math.round(ageMs / 1000));
  const starting = /\[im-qqbot\]\s+Starting bot/.test(log.text);
  if (starting && ageMs < CFG.graceMs) {
    // 重启瞬间的正常过渡：刚起来还没 ready，别把重启后的第一轮巡检当成掉线
    return result(id, OK, `启动中（日志 ${ageS}s 新、${Math.round(CFG.graceMs / 1000)}s 宽限内不报警）：${log.name}`);
  }
  const why = starting
    ? `只有 Starting bot、没有 Bot ready!（凭据错 / 网络 / 被别处同 appId 顶掉）`
    : `日志里既没有 Bot ready! 也没有 Starting bot（QQ 插件可能没加载）`;
  return result(
    id,
    ALARM,
    `${why} · 最新日志 ${log.name}（${ageS}s 前）· 兜底：回 GUI 用同一个 Router 会话照样能干（QQ 只是第二条腿，断腿不瘫）`,
    { sig: starting ? 'botready|no-ready' : 'botready|no-im-qqbot', log: log.name, ageS },
  );
}

// ── 第 5 项 · cwd 还在 ─────────────────────────────────────────────────────
async function checkCwd(st) {
  const id = 'cwd';
  let exists = false;
  try {
    exists = fs.existsSync(CFG.routerPath);
  } catch (e) {
    return result(id, UNKNOWN, `Test-Path 失败（${e?.message ?? e}）：${CFG.routerPath}`, { sig: 'unknown|cwd' });
  }
  if (!st.currentSid) {
    return result(id, UNKNOWN, `认不出当前 Router 会话（${st.sidWhy}）⇒ 只能验目录（目录${exists ? '在' : '不在'}）`, { sig: 'unknown|cwd' });
  }
  const h = readSessionHeader(st.currentSid, CFG.home);
  if (!h) {
    return result(id, UNKNOWN, `会话 header 读不到（${shortSid(st.currentSid)}；会话文件缺失或解压失败）`, { sig: 'unknown|cwd' });
  }
  const cwd = h.header?.cwd ?? null;
  if (!cwd) return result(id, UNKNOWN, `会话 header 里没有 cwd 字段（${shortSid(st.currentSid)}）`, { sig: 'unknown|cwd' });
  const same = canon(cwd) === canon(CFG.routerPath);
  if (!exists) {
    return result(id, ALARM, `目录不在了：${CFG.routerPath}（header.cwd=${cwd}）—— 本件**不自动建目录**，免得将错就错`, { sig: 'cwd|missing' });
  }
  if (!same) {
    return result(id, ALARM, `会话 header.cwd=${cwd} ≠ 工作区路径 ${CFG.routerPath}`, { sig: 'cwd|mismatch' });
  }
  return result(id, OK, `${CFG.routerPath} 存在，且会话 header.cwd 一致`);
}

// ── 报警去重（只对「站着的报警」；已复位不去重）──────────────────────────────
function loadState() {
  const r = readJsonSafe(CFG.stateFile);
  const v = r.ok && r.value && typeof r.value === 'object' ? r.value : {};
  return {
    version: v.version ?? 1,
    updatedAt: v.updatedAt ?? null,
    lastRun: v.lastRun ?? null,
    alertMarks: v.alertMarks && typeof v.alertMarks === 'object' ? v.alertMarks : {},
  };
}

function shouldEmit(state, sig, now = Date.now()) {
  if (state.mode === 'fixed') return true;
  if (!DEDUPE_MS) return true;
  const last = Number(state.marks[sig] ?? 0);
  return !(last && now - last < DEDUPE_MS);
}

function pruneMarks(marks, now = Date.now()) {
  const keep = Math.max(DEDUPE_MS, 7 * 86_400_000);
  const out = {};
  for (const [k, v] of Object.entries(marks)) {
    // ⚠️ 标记一律存 **epoch 毫秒数**（2026-11-02 夹具抓到：存 ISO 串的话 `Number(v) = NaN`，
    //    去重永不命中 ⇒ 每轮都把同一句报警再落一遍）。老格式（ISO 串）也认，顺手迁移。
    const t = Number.isFinite(Number(v)) ? Number(v) : Date.parse(String(v));
    if (Number.isFinite(t) && now - t < keep) out[k] = t;
  }
  return out;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
function usage() {
  return [
    'router-guard.mjs —— 统筹线 R1-6 · Router 守护与巡检',
    '',
    '用法：node router-guard.mjs [--apply] [--json] [--once] [--quiet] [--no-dedupe] [--dedupe-min N]',
    '',
    '  --apply        真复位（缺省 dry-run：只报该复位什么）',
    '  --json         机读输出（stdout 纯 JSON）',
    '  --once         兼容 tickd 固定形态（无额外语义）',
    '  --quiet        不打 stderr 告警回声（落盘照旧）',
    '  --no-dedupe    不做报警去重（演练取证）',
    '',
    '五项：置顶复位 / 归档保护 / 身份漂移 / Bot ready / cwd 还在',
  ].join('\n');
}

async function main() {
  if (HELP) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const t0 = Date.now();

  const lock = acquireTickLock('router-guard', { ttlMs: CFG.ttlMs, home: CFG.home });
  if (!lock.ok) {
    if (JSON_OUT) {
      process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: lock.reason ?? 'locked', version: VERSION }, null, 2)}\n`);
    } else if (!QUIET) {
      process.stdout.write(`[router-guard] 跳过：锁被占（${lock.reason ?? 'locked'}）—— 另一轮正在跑\n`);
    }
    return 0;
  }

  const st = await resolveState();
  const items = [];
  const checks = [
    ['pin', checkPin],
    ['archive', checkArchive],
    ['drift', checkDrift],
    ['botready', checkBotReady],
    ['cwd', checkCwd],
  ];
  for (const [id, fn] of checks) {
    try {
      items.push(await fn(st));
    } catch (e) {
      items.push(result(id, UNKNOWN, `本项异常（fail-open 记 unknown 继续下一项）：${e?.message ?? e}`, { sig: `unknown|${id}` }));
    }
  }

  // 报警出口
  const state = loadState();
  const now = Date.now();
  const marks = { ...state.alertMarks };
  for (const it of items) {
    if (it.status === OK) continue;
    const sig = it.sig || `${it.id}|${it.status}`;
    const head = it.status === FIXED ? '已复位' : it.status === ALARM ? '报警' : '未知';
    const level = it.status === ALARM ? 'warn' : 'info';
    const emit = shouldEmit({ marks, mode: it.status === FIXED ? 'fixed' : 'standing' }, sig, now);
    if (!emit) {
      it.alerted = 'deduped';
      continue;
    }
    const res = alert(
      {
        level,
        source: 'router-guard',
        message: `${head} · ${it.label}：${it.reason}`,
        detail: { item: it.id, status: it.status, sig, apply: APPLY, version: VERSION, at: new Date(now).toISOString() },
      },
      { home: CFG.home, silent: QUIET },
    );
    it.alerted = res.ok ? 'written' : `failed:${res.error}`;
    if (it.status === FIXED) {
      // 拨回来了 ⇒ 摘掉这一项的「站着」标记，下次真坏还要能报
      for (const k of Object.keys(marks)) if (k.startsWith(`${it.id}|`)) delete marks[k];
    } else {
      marks[sig] = now;
    }
  }

  const tally = { ok: 0, fixed: 0, alarm: 0, unknown: 0 };
  for (const it of items) tally[it.status] = (tally[it.status] ?? 0) + 1;
  const elapsed = Date.now() - t0;
  const envReady = Boolean(st.ws) || Boolean(st.prefs);

  const summary = {
    at: new Date(now).toISOString(),
    atLocal: stamp(now),
    apply: APPLY,
    version: VERSION,
    routerPath: CFG.routerPath,
    workspaceId: st.wsId,
    currentSession: st.currentSid,
    sessionWhy: st.sidWhy,
    tally,
    elapsedMs: elapsed,
    items: items.map((it) => ({
      id: it.id, label: it.label, status: it.status, reason: it.reason,
      wouldFix: it.wouldFix === true, alerted: it.alerted ?? null,
    })),
  };

  // 状态件（fail-open：写不进去不影响结论）
  try {
    writeJsonAtomic(CFG.stateFile, {
      version: 1,
      updatedAt: new Date(now).toISOString(),
      lastRun: { at: new Date(now).toISOString(), apply: APPLY, tally, workspaceId: st.wsId, currentSession: st.currentSid },
      alertMarks: pruneMarks(marks, now),
    });
  } catch { /* 状态件读不到/写不进都不影响巡检结论 */ }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ok: envReady, ...summary }, null, 2)}\n`);
  } else {
    const lines = [];
    lines.push(`[router-guard] ${summary.atLocal} · apply=${APPLY ? 'ON（会复位）' : 'OFF（dry-run，只看不动）'} · v${VERSION}`);
    lines.push(`  Router 工作区：${CFG.routerPath}${st.wsId ? `（${st.wsId}）` : '（未登记）'} · 会话：${st.currentSid ? shortSid(st.currentSid) : '认不出'}（${st.sidWhy}）`);
    items.forEach((it, i) => {
      lines.push(`  ${i + 1}. ${padW(it.label, 10)} ${padW(LABEL[it.status] ?? it.status, 7)} ${it.reason}`);
    });
    lines.push(
      `  汇总：ok ${tally.ok} · 已复位 ${tally.fixed} · 报警 ${tally.alarm} · unknown ${tally.unknown}` +
      ` · 用时 ${elapsed}ms${tally.alarm + tally.fixed + tally.unknown ? '' : ' · 全绿，无需动作'}`,
    );
    const deduped = items.filter((it) => it.alerted === 'deduped').length;
    if (deduped) lines.push(`  （${deduped} 条报警 6 小时内报过，本次只记状态不重复落盘；--no-dedupe 可强制）`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  return envReady ? 0 : 3;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    try { process.stderr.write(`[router-guard] 崩了：${e?.stack ?? e}\n`); } catch { /* stderr 不可写就算了 */ }
    process.exitCode = 1;
  });
