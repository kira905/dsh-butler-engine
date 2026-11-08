// dsh-butler / lib/secretary-health.mjs —— 服务面健康 **唯一判定入口**（⑤ 包 S-7）
//
// 口径真源：`docs\服务面隐私包-方案-20260917.md`
//   §3.7（S-7 · 唯一判定入口 + 三挂点：面板分片 / 日报段 / CLI）
//   §3.9（S-9 · 家人用量与推送台账）
//   §4.1 第 3/5 条（① 包冻结项：「面板只渲染、不自算判定」「日报禁 HTTP」）
//   §16-B1（挂点 1 落点在**采集层**注入、metrics 只渲染 —— 本库不 import 面板任何东西）
//   §16-B10（退出码数字**自定义并写明**，只照 `closure-check` 的"形态"）
//
// 本文件干什么（**只读**）：自检服务面三件事 + S-9 的按人用量读法
//   ① 探针可达性（探针件 + SDK 在**本地可解析**）
//   ② 凭据是否在位（只报键在不在，**绝不输出密钥值**）
//   ③ 发送链路是否配置齐全（服务面自有闸 + tickd job 闸 + 通道 + 预算/免打扰/去重）
//   ④ 台账留痕（`secretary-push.jsonl`：真送达 / 失败 / 坏行）
//   ⑤ 长连接常驻形态（**批1b 起接心跳文件** `~/.dsh/wecom-hub/hub-state.json`）—— `readHubHeartbeat()`
//   ⑥ S-9 家人用量（身份表 + 按人用量台账）——`collectFamilyUsage()`
//
// 硬边界（本卡红线，写死在代码里）：
//   · **零网络**：不建连接、不发请求、不调企微 —— 本文件的"探针可达性"= 探针件与 SDK 在本地
//     能解析（`createRequire().resolve`），**不是**真连通性；真连通性只能靠真发一次（发送面，本卡不碰）。
//   · **零写盘**：不写任何文件 / 状态 / 审计 / 台账 / 日志；本文件只有 `fs.readFileSync|existsSync|readdirSync|statSync`。
//   · **不读密钥值**：凭据只报"必需键在不在"，`secret` / `access_token` 一个字符都不进输出。
//   · **载体不存在 ⇒ 显式成段，绝不判绿**（① 包 P-5「不可用必须显式成段」）。
//
// 状态四档（`CHECK_STATES`）：
//   `ok`          可用且正常
//   `degraded`    可用但有降级（闸关着 / 有坏行 / 有连续失败 / 备用链缺件）
//   `unavailable` **该有的载体却不在或坏了** ⇒ 判红项
//   `declared`    **未落但已有明确口径说明为什么现在不该有**（主人已拍「暂缓」/ 归别的线在建）
//                 ⚠️ 这一档**不是绿**：它必须显式成段、必须带出处；缺省不计入退出码，
//                 `--strict` 下按 `unavailable` 计入 ⇒ 两种口径都能拿到（见 §16-B10「数字自定义并写明」）。
//
// 退出码（**自定义并写明**，不照抄 closure-check 的数字）：
//   0 = 可用链路全绿（允许存在 `declared` 项 —— 它们显式成段）
//   1 = 有降级（`degraded`）
//   2 = 有不可用（`unavailable`；`--strict` 时 `declared` 也计）
//   3 = **环境不可用**（判定自身跑不起来：库加载失败 / home 读不到）—— 与 2 分开，别混
//
// 三挂点接线现状（如实）：
//   · 挂点 2 日报段：已接 —— `dsh-butler-panel\report.mjs` 的「📱 服务面」
//   · 挂点 3 CLI：已接 —— `tools\butler-secretary-health.mjs`（+ `tools\dsh-butler\butler-secretary-health.mjs` 薄转发）
//   · 挂点 1 面板 `service` 分片：**未接**（落点在 `dsh-butler-panel\lib\shards.mjs#collectMetricSources`，
//     面板跑实体副本 ⇒ 要 deploy + 重启 dsh 才生效，超出本卡红线）⇒ 登记为待办，未假装已接。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { COMPONENT_ROOT, dshHome as defaultDshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';

export const SECRETARY_HEALTH_VERSION = '0.1.0';

export const CHECK_STATES = Object.freeze({
  OK: 'ok',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
  DECLARED: 'declared',
});

/** 退出码（§16-B10：数字自定义并写明）。 */
export const HEALTH_EXIT = Object.freeze({ OK: 0, DEGRADED: 1, UNAVAILABLE: 2, ENVIRONMENT: 3 });

const TOOLS_ROOT = path.resolve(COMPONENT_ROOT, '..');
const NOTIFY_PATH = path.join(TOOLS_ROOT, 'secretary-notify.mjs');
const AIBOT_DIR = path.join(TOOLS_ROOT, 'wecom-aibot');
const AUTO_MODULES_PATH = path.join(COMPONENT_ROOT, 'lib', 'autonomy-modules.mjs');

/** 常驻形态口径出处（declared 档何时才适用；**2026-10-10 批1b 已订正**）。 */
export const CHANNEL_DECLARED_REASON = '**订正（2026-10-10 · 批1b）**：长连接常驻形态**已落地** —— 唯一持连接者 = '
  + '对端机 上的 `wecom-hub`（Windows 计划任务 `DSH-WecomHub` 开机自启 · S4U）'
  + '（出处：`docs\\方案-企微三机翻译官-手机遥控与家人档-20261010.md` §5.1 看护行 / §12.5-I3 + '
  + '`docs\\交付报告-翻译官批1b-hub常驻化-20261010.md`）⇒ **只有"本机不持连接"时**才落 declared 档（读数请用 `WECOM_HUB_PEER_STATE`）。'
  + '｜历史口径（已被上文取代）：主人 2026-10-09 拍板「企微长连接常驻形态 暂缓 · 不做 B」'
  + '（出处：主档 Q 域「企微长连接常驻形态」行 + 缺口台账-2 §4 第 39 项）';

const DECLARED_SOURCES = Object.freeze({
  channel: CHANNEL_DECLARED_REASON,
  'family-users': '身份表 `~/.dsh/secretary-users.json` 归 W1 家人档线（⑤ 包 §2.5 / §3.3 · `docs\\小秘书-家人档设计增补-2026-09-17.md` §3.3），未落',
  'usage-ledger': '按人用量台账 `secretary-usage-<host>.jsonl` 的写者 = 家人助手进程（W1 线，⑤ 包 §3.9），未落',
  retractions: '撤回台账 `~/.dsh/memory/retractions.jsonl` 归 S-5 撤回链（⑤ 包 §3.5）；且 §16-B2 判定：现有 schema 无「已应用」标记 ⇒ 队列长度**算不出来**',
});

const pad = (n) => String(n).padStart(2, '0');

/** 本地日（与 secretary-notify / report.mjs 同口径：本地时区）。 */
export function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** home 解析：显式入参 > BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（复用 lib/paths.mjs 的唯一口径）。 */
function resolveHome(opts = {}) {
  if (opts.home && String(opts.home).trim()) return path.resolve(String(opts.home).trim());
  return defaultDshHome();
}

/** 安全读 JSON（只读；坏文件不抛，把原因带出来）。 */
function readJsonSafe(file) {
  const out = { file, exists: false, ok: false, value: null, error: null, bytes: null, mtimeMs: null };
  try {
    out.exists = fs.existsSync(file);
    if (!out.exists) return out;
    const st = fs.statSync(file);
    out.bytes = st.size;
    out.mtimeMs = st.mtimeMs;
    const txt = fs.readFileSync(file, 'utf8');
    if (!txt.trim()) { out.error = 'file-empty'; return out; }
    const j = JSON.parse(txt);
    if (!j || typeof j !== 'object' || Array.isArray(j)) { out.error = 'not-object'; return out; }
    out.value = j; out.ok = true;
    return out;
  } catch (e) {
    out.error = String(e?.message ?? e);
    return out;
  }
}

/** 凭据文件体检：必需键在不在（**不读值**）。 */
function credCheck(file, required) {
  const r = readJsonSafe(file);
  if (!r.exists) return { file, exists: false, ok: false, present: [], missing: required.slice(), keys: [], bytes: null, mtimeMs: null, error: 'file-missing' };
  if (!r.ok) return { file, exists: true, ok: false, present: [], missing: required.slice(), keys: [], bytes: r.bytes, mtimeMs: r.mtimeMs, error: r.error };
  const keys = Object.keys(r.value ?? {});
  const present = [];
  const missing = [];
  for (const k of required) {
    const v = r.value?.[k];
    const has = v !== undefined && v !== null && String(v).length > 0;
    (has ? present : missing).push(k);
  }
  return { file, exists: true, ok: missing.length === 0, present, missing, keys, bytes: r.bytes, mtimeMs: r.mtimeMs, error: missing.length ? 'key-missing' : null };
}

/** 台账行解析（坏行计数，不静默）。 */
function readLedgerRows(file) {
  const out = { file, exists: false, rows: [], bad: 0, bytes: null, mtimeMs: null, error: null };
  try {
    out.exists = fs.existsSync(file);
    if (!out.exists) return out;
    const st = fs.statSync(file);
    out.bytes = st.size; out.mtimeMs = st.mtimeMs;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && typeof o === 'object') out.rows.push(o); else out.bad++; } catch { out.bad++; }
    }
    return out;
  } catch (e) { out.error = String(e?.message ?? e); return out; }
}

/** 真送达（R6.1b 判据，与 secretary-notify 的 isRealSend 同口径；此处独立判一次是为了不依赖 notify 是否加载成功）。 */
function isRealSend(row) {
  return !!row && row.status === 'sent' && row.test !== true && row.dryRun !== true;
}

/**
 * 探针件/SDK 本地可解析性（**不联网**）。
 *
 * ⚠️ 口径订正（2026-10-10 本卡实跑踩到，**别再照想象的判**）：
 *   判据**不是** `tools\wecom-aibot\index.js` 在不在 —— 那个路径在 `secretary-notify.mjs:485` 里只是
 *   `createRequire()` 的**解析起点**（`createRequire` 不要求起点文件存在），真判据 = `@wecom/aibot-node-sdk`
 *   能否解析（SDK 实体在 `tools\wecom-aibot\node_modules\`）。本机实测：`index.js` 不在，但 10-09 早报
 *   真送达 `errcode=0` ⇒ 拿"index.js 不存在"当红项会**误报生产故障**。故本函数按 SDK 解析结果判，
 *   `index.js` 存在与否只作旁证（信息项）。
 */
function probeResolvable() {
  const anchor = path.join(AIBOT_DIR, 'index.js');
  const out = { anchor, anchorExists: fs.existsSync(anchor), sdk: null, error: null };
  try {
    const require = createRequire(anchor);
    out.sdk = require.resolve('@wecom/aibot-node-sdk');
  } catch (e) { out.error = `sdk-unresolvable:${String(e?.message ?? e)}`; }
  return out;
}

/**
 * 身份表形态判读（**只回计数/形态，不回任何 userid/姓名**）。
 * 口径真源 = 方案 §5.6 `{version, default:"deny", users:{<userid>:{…}}}`；三形态（users-map / users 数组 /
 * 平面 map / 数组根）都认 —— 与 `memory-scope.mjs#useridsFromIdentityDoc`、`secretary-feed.mjs#readIdentityRoster` 同解。
 */
export function describeIdentityShape(doc) {
  const out = { shape: 'unknown', count: 0, family: 0, notified: 0 };
  const META = new Set(['version', 'schemaVersion', 'default', 'product', 'updatedAt', 'note', '$schema']);
  const seen = new Set();
  const take = (uid, rec) => {
    const u = String(uid ?? '').trim();
    if (!u || u.startsWith('_') || META.has(u) || seen.has(u)) return;
    seen.add(u);
    if (rec?.role === 'family') out.family++;
    if (rec?.notified === true) out.notified++;
  };
  if (Array.isArray(doc)) {
    out.shape = 'array';
    for (const u of doc) take(typeof u === 'string' ? u : (u?.userid ?? u?.user ?? u?.id), u);
  } else if (doc && typeof doc === 'object') {
    const inner = doc.users ?? doc.members ?? null;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      out.shape = 'object.users-map';
      for (const [uid, rec] of Object.entries(inner)) take(uid, rec);
    } else if (Array.isArray(inner)) {
      out.shape = 'object.users';
      for (const u of inner) take(typeof u === 'string' ? u : (u?.userid ?? u?.user ?? u?.id), u);
    } else {
      out.shape = 'flat-map';
      for (const [uid, rec] of Object.entries(doc)) { if (typeof rec === 'string') { take(rec, {}); continue; } take(uid, rec); }
    }
  }
  out.count = seen.size;
  return out;
}

function mkCheck(id, title, state, detail, evidence = {}, asOf) {
  return { id, title, state, detail, evidence, asOf };
}

/**
 * hub 心跳读法（批1b · §12.5-I3「服务面健康要接既有唯一入口，不自造看护」）。
 * 🔴 **唯一载体** = `~/.dsh/wecom-hub/hub-state.json`（路径真源 = `tools\wecom-hub\lib\paths.mjs#hubStatePath`，
 *    这里动态 import 取真源；取不到才用**同口径**回落 —— 绝不另造第二套健康判定）。
 *
 * 读序：本机 hub-state.json 优先 ⇒ 本机没有再看 `WECOM_HUB_PEER_STATE`（跨机快照**由人/别的工具注入**，
 *   本库守"零网络"边界**不主动跨机取数**）。
 * 判据（缺一不可判绿）：① 心跳新鲜（默认 5 分钟）② `connected === true`。
 *
 * @returns {Promise<object>} 只读读数（含 source / at / ageMs / fresh / connected / 今日入站 / 丢线次数）
 */
export async function readHubHeartbeat(home, now = Date.now()) {
  const staleMs = Number(process.env.WECOM_HUB_HEARTBEAT_STALE_MS ?? 300000);
  let stateFile = path.join(home, 'wecom-hub', 'hub-state.json');
  try {
    const m = await import(pathToFileURL(path.join(TOOLS_ROOT, 'wecom-hub', 'lib', 'paths.mjs')).href);
    if (typeof m.hubStatePath === 'function') stateFile = m.hubStatePath({ home });
  } catch { /* 回落：与 paths.mjs 同口径的目录结构（<home>/wecom-hub/hub-state.json） */ }
  const cfgFile = path.join(path.dirname(stateFile), 'hub-config.json');
  const own = readJsonSafe(stateFile);
  const peerFile = process.env.WECOM_HUB_PEER_STATE ?? null;
  const peer = peerFile ? readJsonSafe(peerFile) : { file: null, exists: false, ok: false, value: null, error: 'not-given' };
  const cfg = readJsonSafe(cfgFile);
  const host = String(os.hostname() ?? '').toLowerCase();
  const hold = Array.isArray(cfg.value?.holdConnectionHosts)
    ? cfg.value.holdConnectionHosts.map((s) => String(s).toLowerCase())
    : null;
  // 判"本机**该不该**持长连接"（决定缺心跳时判 `unavailable` 还是 `declared`）：
  //   ① 白名单非空 ⇒ 以白名单为准（在名单里 = 该持）；
  //   ② 白名单空/缺（旧配置）⇒ 退回看**本机有没有 hub 部署痕迹**（config/token/lock/state 任一）；
  //   ③ 都没有 ⇒ 本机没部署 hub ⇒ **declared**（首期唯一持连接者 = 对端机 那台，不是缺陷）。
  //   ⚠️ 为什么不一律判红：本机 这类"有代码副本、不持连接"的机器若天天报红，就是**假红**，
  //      会把真告警淹掉（与服务面健康"不可用必须显式成段"并不冲突 —— declared 同样显式成段、且 --strict 计入）。
  const dir = path.dirname(stateFile);
  const deployedHere = own.exists
    || fs.existsSync(path.join(dir, 'hub-config.json'))
    || fs.existsSync(path.join(dir, 'hub-token'))
    || fs.existsSync(path.join(dir, 'hub.lock'));
  const expectedHere = hold && hold.length ? hold.includes(host) : deployedHere;
  const pick = own.ok ? { source: 'local', value: own.value } : (peer.ok ? { source: 'peer', value: peer.value } : null);
  const v = pick?.value ?? null;
  const at = v?.at ?? v?.updatedAt ?? v?.lastHeartbeatAt ?? null;
  const ageMs = at ? now - Date.parse(at) : null;
  const fresh = Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs <= staleMs;
  return {
    source: pick?.source ?? 'none',
    stateFile, peerFile, cfgFile,
    holdConnectionHosts: hold, expectedHere,
    ok: Boolean(v), at, ageMs, fresh, staleMs,
    connected: v?.connected === true,
    host: v?.host ?? null, pid: v?.pid ?? null,
    todayInbound: v?.todayInbound ?? null,
    disconnectCount: v?.disconnectCount ?? null,
    kickedCount: v?.kickedCount ?? null,
    lastMsgAt: v?.lastMsgAt ?? v?.lastInboundAt ?? null,
    credSource: v?.credSource ?? null,
    takeover: v?.takeover ?? null,
    stoppedBy: v?.stoppedBy ?? null,
    readError: own.exists && !own.ok ? (own.error ?? 'parse-error') : null,
  };
}

// ---------------------------------------------------------------- 判定：服务面健康

/**
 * 服务面健康判定（**纯只读**；`deps` 可注入便于单测）。
 * @param {{home?:string, now?:number, host?:string, deps?:{notifyMod?:object, autoMod?:object, probe?:object}}} [opts]
 * @returns {Promise<{ok:boolean, state:string, exitCode:number, asOf:string, host:string, home:string,
 *                    counts:object, checks:object[], environment:{ok:boolean, error:string|null}}>}
 */
export async function collectHealth(opts = {}) {
  const now = opts.now ?? Date.now();
  const asOf = new Date(now).toISOString();
  const home = resolveHome(opts);
  const host = opts.host ?? os.hostname();
  const checks = [];
  const environment = { ok: true, error: null };

  // 依赖：服务面出口（读闸/读台账）+ 自治 job 闸。加载失败 ⇒ 环境不可用（≠ 服务面坏了）
  let notifyMod = opts.deps?.notifyMod ?? null;
  let autoMod = opts.deps?.autoMod ?? null;
  if (!notifyMod) {
    try { notifyMod = await import(pathToFileURL(NOTIFY_PATH).href); }
    catch (e) { environment.ok = false; environment.error = `secretary-notify 未加载：${String(e?.message ?? e)}`; }
  }
  if (!autoMod) {
    try { autoMod = await import(pathToFileURL(AUTO_MODULES_PATH).href); }
    catch { autoMod = null; /* job 闸拿不到 ⇒ 该项降级，不拖成环境不可用 */ }
  }

  // ---- ① 探针可达性（本地解析，不联网）
  {
    const p = opts.deps?.probe ?? probeResolvable();
    const anchorNote = p.anchorExists ? `（解析起点 \`${p.anchor}\` 在）` : `（解析起点 \`${p.anchor}\` 不在 —— 只是旁证，**不构成故障**：SDK 在 \`node_modules\` 里即可）`;
    if (!p.sdk) {
      checks.push(mkCheck('probe', '探针可达性', CHECK_STATES.UNAVAILABLE,
        `SDK 本地解析失败：${p.error}${anchorNote} ⇒ 发送链必然不可用（**不联网**判定：文件 + SDK 本地可解析性）`,
        { sdk: null, anchor: p.anchor, anchorExists: p.anchorExists, error: p.error }, asOf));
    } else {
      checks.push(mkCheck('probe', '探针可达性', CHECK_STATES.OK,
        `SDK 本地可解析 \`@wecom/aibot-node-sdk\`${anchorNote}（未联网验证真连通性 —— 真连通性只能靠真发一次，属发送面）`,
        { sdk: p.sdk, anchor: p.anchor, anchorExists: p.anchorExists }, asOf));
    }
  }

  // ---- ② 凭据是否在位
  {
    const aibot = credCheck(path.join(home, 'wecom-aibot.json'), ['botId', 'secret']);
    const notify = credCheck(path.join(home, 'wecom-notify.json'), ['corpid', 'agentid', 'secret', 'touser']);
    const tokenFile = path.join(home, 'wecom-notify-token.json');
    const token = readJsonSafe(tokenFile);
    let tokenState = 'missing';
    if (token.ok) {
      const exp = Number(token.value?.expiresAt);
      tokenState = Number.isFinite(exp) ? (exp > now ? 'fresh' : 'expired') : 'unparsable';
    } else if (token.exists) tokenState = `bad:${token.error}`;
    const keysOf = (c) => [...c.present, ...c.missing.map((k) => `${k}!`)].join(',') || '-';
    const ev = {
      aibot: { file: 'wecom-aibot.json', exists: aibot.exists, keys: aibot.present, missing: aibot.missing },
      notify: { file: 'wecom-notify.json', exists: notify.exists, keys: notify.present, missing: notify.missing },
      token: { file: 'wecom-notify-token.json', exists: token.exists, state: tokenState, bytes: token.bytes },
    };
    if (!aibot.exists || !aibot.ok) {
      checks.push(mkCheck('credentials', '凭据在位', CHECK_STATES.UNAVAILABLE,
        `主通道凭据不可用（\`wecom-aibot.json\` ${aibot.exists ? `缺键：${aibot.missing.join(',') || aibot.error}` : '不存在'}）⇒ 早报发不出去`,
        ev, asOf));
    } else if (!notify.exists || !notify.ok) {
      checks.push(mkCheck('credentials', '凭据在位', CHECK_STATES.DEGRADED,
        `主通道凭据齐（${keysOf(aibot)}），但备用通道 \`wecom-notify.json\` ${notify.exists ? `缺键：${notify.missing.join(',')}` : '不存在'}`,
        ev, asOf));
    } else {
      checks.push(mkCheck('credentials', '凭据在位', CHECK_STATES.OK,
        `主通道 \`wecom-aibot.json\`（${keysOf(aibot)}）· 备用 \`wecom-notify.json\`（${keysOf(notify)}）· token 缓存=${tokenState}`
        + (tokenState === 'expired' ? '（过期仅提示：发送时会重取）' : ''),
        ev, asOf));
    }
  }

  // ---- ③ 发送链路配置齐全（两层闸 + 通道 + 预算/免打扰/去重）
  {
    const gate = notifyMod?.readGate ? notifyMod.readGate({ home }) : null;
    let jobCell = null;
    try { jobCell = autoMod?.readJobSwitches ? (autoMod.readJobSwitches({ home })?.jobs?.['secretary-morning'] ?? null) : null; } catch { jobCell = null; }
    const latestJobSwitch = jobCell ? (jobCell.enabled === true) : null;
    const ev = {
      gateFile: resolveStatePath('butler-secretary.json', { home }).path,
      gateExists: gate?.exists ?? null,
      push: gate?.pushEnabled ?? null,
      channelAibot: gate?.channelEnabled ?? null,
      budget: gate?.budget ?? null,
      quiet: gate?.quiet ?? null,
      dedup: gate?.dedup ? { enabled: gate.dedup.enabled, kinds: gate.dedup.kinds } : null,
      job: { id: 'secretary-morning', enabled: latestJobSwitch, source: jobCell ? 'butler-autonomy.json#jobs' : 'unavailable' },
    };
    if (!gate) {
      checks.push(mkCheck('push-chain', '发送链路配置', CHECK_STATES.UNAVAILABLE,
        environment.ok ? '闸读取入口不可用（为什么：secretary-notify 未加载）' : `闸读取入口不可用：${environment.error}`, ev, asOf));
    } else if (!gate.exists || gate.ok !== true) {
      checks.push(mkCheck('push-chain', '发送链路配置', CHECK_STATES.UNAVAILABLE,
        `服务面自有闸（服务面配置） ${gate.exists ? `不可用（${gate.reason}）` : '不存在'} —— 缺省即默认关，**不判绿**`,
        { ...ev, gateReason: gate.reason }, asOf));
    } else {
      const parts = [];
      if (!gate.pushEnabled) parts.push('总闸 `switches.push` = 关（缺省即关）');
      if (!gate.channelEnabled) parts.push('通道 `channels.aibot.enabled` = 关');
      if (latestJobSwitch === false) parts.push('tickd job 闸 `jobs.secretary-morning.enabled` = 关');
      if (latestJobSwitch === null) parts.push('job 闸读不到（autonomy 配置的 jobs 段无该行 ⇒ 按缺省判关）');
      checks.push(mkCheck('push-chain', '发送链路配置',
        parts.length ? CHECK_STATES.DEGRADED : CHECK_STATES.OK,
        parts.length
          ? `链路配好了但闸关着：${parts.join(' · ')}（**开关关着 ≠ 生效**，不判绿）`
          : `两层闸皆开 · 通道 aibot 开 · 预算 ${gate.budget.maxPerDay}/天 · 同类冷却 ${gate.budget.cooldownMs / 3600000}h · 免打扰 ${gate.quiet.startHour}–${gate.quiet.endHour} · 去重 ${gate.dedup.enabled ? `开(${gate.dedup.kinds.join('/')})` : '关'}`,
        ev, asOf));
    }
  }

  // ---- ④ 台账留痕（真送达 / 失败 / 坏行）
  {
    const led = readLedgerRows(path.join(home, 'secretary-push.jsonl'));
    const real = led.rows.filter(isRealSend);
    const last = led.rows[led.rows.length - 1] ?? null;
    const today = localDay(now);
    const sentToday = real.filter((r) => localDay(Date.parse(r.at)) === today).length;
    let consecutiveFail = 0;
    for (let i = led.rows.length - 1; i >= 0; i--) {
      const st = String(led.rows[i]?.status ?? '');
      if (st === 'rejected' || st === 'transport') consecutiveFail++;
      else break;
    }
    const recent = led.rows.slice(-10).map((r) => String(r?.status ?? '?'));
    const ev = {
      file: path.join(home, 'secretary-push.jsonl'),
      exists: led.exists, bytes: led.bytes, mtimeMs: led.mtimeMs,
      rows: led.rows.length, bad: led.bad,
      realSends: real.length, sentToday,
      lastAt: last?.at ?? null, lastStatus: last?.status ?? null,
      consecutiveFail, recent10: recent,
    };
    if (led.error) {
      checks.push(mkCheck('push-delivery', '台账留痕', CHECK_STATES.UNAVAILABLE, `台账读失败：${led.error}`, ev, asOf));
    } else if (!led.exists) {
      checks.push(mkCheck('push-delivery', '台账留痕', CHECK_STATES.UNAVAILABLE,
        '台账 `secretary-push.jsonl` 不存在 ⇒ 没有任何投递留痕（**这不等于"没有推送"**，是载体没了）', ev, asOf));
    } else if (consecutiveFail >= 3) {
      checks.push(mkCheck('push-delivery', '台账留痕', CHECK_STATES.DEGRADED,
        `最近连续失败 ${consecutiveFail} 条（status=rejected/transport）⇒ 投递在红`, ev, asOf));
    } else if (led.bad > 0) {
      checks.push(mkCheck('push-delivery', '台账留痕', CHECK_STATES.DEGRADED,
        `台账有 ${led.bad} 行坏行（不是合法 JSON）⇒ 统计口径可能偏`, ev, asOf));
    } else {
      checks.push(mkCheck('push-delivery', '台账留痕', CHECK_STATES.OK,
        `台账 ${led.rows.length} 行 · 真送达 ${real.length} 条（今日 ${sentToday}）· 最后一条 ${last?.at ?? '-'}（${last?.status ?? '-'}）`
        + (real.length === 0 ? ' ⚠️ 从没真送达过' : ''),
        ev, asOf));
    }
  }

  // ---- ⑤ 常驻形态（批1b：**接心跳文件** —— ⑤包 §3.7 `channel` 检查项的唯一载体）----
  {
    const hb = await readHubHeartbeat(home, now);
    const ev = {
      source: hb.source, stateFile: hb.stateFile, peerFile: hb.peerFile, hubConfigFile: hb.cfgFile,
      holdConnectionHosts: hb.holdConnectionHosts, expectedHere: hb.expectedHere,
      at: hb.at, ageMs: hb.ageMs, fresh: hb.fresh, staleMs: hb.staleMs, connected: hb.connected,
      host: hb.host, pid: hb.pid, todayInbound: hb.todayInbound, disconnectCount: hb.disconnectCount,
      kickedCount: hb.kickedCount, lastMsgAt: hb.lastMsgAt, credSource: hb.credSource,
      takeover: hb.takeover ?? null, stoppedBy: hb.stoppedBy ?? null, readError: hb.readError,
    };
    const sec = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)} 秒` : '?');
    const srcWord = hb.source === 'peer' ? `对端快照（\`${hb.peerFile}\`）` : '本机';
    if (hb.source === 'none') {
      if (hb.expectedHere) {
        checks.push(mkCheck('channel', '长连接常驻形态', CHECK_STATES.UNAVAILABLE,
          `**应持长连接但心跳文件不存在**：\`${hb.stateFile}\``
          + `${hb.readError ? `（文件在但读不了：${hb.readError}）` : '（常驻进程没起 / 没跑到写心跳那一步）'}`
          + '｜判据 = 心跳文件（⑤ 包 §3.7 唯一载体）⇒ 本项**不判绿**；起法 `node <workspace>\\tools\\wecom-hub\\hub-ctl.mjs start --apply`',
          ev, asOf));
      } else {
        checks.push(mkCheck('channel', '长连接常驻形态', CHECK_STATES.DECLARED,
          '本机**不持长连接**（首期设计如此）：白名单 `holdConnectionHosts` = '
          + `${(hb.holdConnectionHosts ?? []).join(' / ') || '（空）'} 不含本机 ⇒ 唯一持连接者在另一台`
          + '｜要跨机看读数：把对端 `hub-state.json` 用 env `WECOM_HUB_PEER_STATE=<file>` 注入'
          + '（本库守"零网络"边界，**不主动跨机取数**）'
          + `｜出处：${DECLARED_SOURCES.channel}`,
          ev, asOf));
      }
    } else if (!hb.fresh) {
      checks.push(mkCheck('channel', '长连接常驻形态', CHECK_STATES.DEGRADED,
        `心跳**陈旧**（${srcWord}读数 ${sec(hb.ageMs)} 前 · 阈值 ${sec(hb.staleMs)}）⇒ 常驻进程很可能已死或卡住`
        + `｜at=\`${hb.at ?? '?'}\` · pid=${hb.pid ?? '?'} · 文件 \`${hb.source === 'peer' ? hb.peerFile : hb.stateFile}\``,
        ev, asOf));
    } else if (!hb.connected) {
      checks.push(mkCheck('channel', '长连接常驻形态', CHECK_STATES.DEGRADED,
        `心跳新鲜（${sec(hb.ageMs)} 前）但 **\`connected=false\`** ⇒ 进程在跑、**长连接没建立**（闸关/凭证缺/被踢后退避中）`
        + `${hb.stoppedBy ? `｜state.stoppedBy=\`${hb.stoppedBy}\`` : ''}`
        + `${hb.lastMsgAt ? `｜最近一条消息 ${hb.lastMsgAt}` : '｜今日还没有消息进来'}`,
        ev, asOf));
    } else {
      checks.push(mkCheck('channel', '长连接常驻形态', CHECK_STATES.OK,
        `心跳 ${sec(hb.ageMs)} 前 · **connected=true** · ${srcWord}进程 pid ${hb.pid ?? '?'} · 主机 ${hb.host ?? '?'}`
        + `｜今日入站 ${hb.todayInbound ?? '?'} 条 · 丢线 ${hb.disconnectCount ?? '?'} 次 · 被踢 ${hb.kickedCount ?? 0} 次`
        + `${hb.credSource ? ` · 凭证来源 \`${hb.credSource}\`` : ''}`
        + `${hb.takeover?.used ? ` · ⚠️ **接管模式**（peer ${hb.takeover.peerStateFile ?? '?'}）` : ''}`
        // ⚠️ 这条只对**本机自己**的读数成立：peer 快照是**别人的** hub，用本机白名单去判它 = 误报。
        + `${hb.source === 'local' && !hb.expectedHere ? ' · ⚠️ **本机不在持连接白名单里却持着连接**（互踢风险：查是否有人手工起了 hub）' : ''}`
        + `｜载体 \`${hb.source === 'peer' ? hb.peerFile : hb.stateFile}\``,
        ev, asOf));
    }
  }

  // ---- ⑥ 身份表（两态：**不在** = 未落·已声明；**在** = 汇报人数/形态，坏表判不可用）----
  //   口径真源：⑤ 包 §3.3 / 方案 §5.6。2026-10-11 卡【翻译官·批4·家人档地基】把本项从"恒 declared"
  //   改成两态 —— 表落地后仍判 declared 会让日报**永远**说"未落"，那是假读数（本文件自己禁止的一类）。
  {
    const f = path.join(home, 'secretary-users.json');
    const r = readJsonSafe(f);
    if (!r.exists) {
      checks.push(mkCheck('family-users', '家人身份表', CHECK_STATES.DECLARED,
        `**未落 · 已声明**：${DECLARED_SOURCES['family-users']}`
        + `｜现值：\`secretary-users.json\` **不在** ⇒ 所有人（含主人本人）都算"未登记" ⇒ 家人档一律拒`
        + '（fail-closed；这与"没人用过"是两回事）',
        { file: f, exists: false, declared: true, source: DECLARED_SOURCES['family-users'] }, asOf));
    } else if (!r.ok) {
      checks.push(mkCheck('family-users', '家人身份表', CHECK_STATES.UNAVAILABLE,
        `文件在但**读不动/形态认不出**（${r.error ?? 'unknown'}）⇒ 家人档按"谁都不认"处理（fail-closed）`
        + `｜文件 \`secretary-users.json\`（${r.bytes ?? '?'} B）`,
        { file: f, exists: true, error: r.error ?? null }, asOf));
    } else {
      const shape = describeIdentityShape(r.value);
      const n = shape.count;
      checks.push(mkCheck('family-users', '家人身份表', CHECK_STATES.OK,
        `在（形态 \`${shape.shape}\`）· **${n} 人**`
        + `｜family ${shape.family} · 已完成首聊告知 ${shape.notified}`
        + `${n === 0 ? '｜⚠️ 表是空的 ⇒ 任何人（含主人）都算"未登记"（fail-closed，不是"没人用"）' : ''}`
        + `｜文件 \`secretary-users.json\`（只报计数与形态，**不回 userid/姓名**）`,
        { file: f, exists: true, shape: shape.shape, count: n, family: shape.family, notified: shape.notified }, asOf));
    }
  }

  // ---- ⑦ 按人用量台账（declared：无写者）
  {
    const u = findUsageLedger(home, host);
    checks.push(mkCheck('usage-ledger', '按人用量台账', CHECK_STATES.DECLARED,
      `**未落 · 已声明**：${DECLARED_SOURCES['usage-ledger']}`
      + `｜现值：本机 \`secretary-usage-${host}.jsonl\` ${u.found ? '在' : '不在'}${u.others.length ? `（另有其它主机台账 ${u.others.length} 个）` : ''}`
      + ' ⇒ 今日"谁用了多少/被拒几条"**无可读数**（不是"没人用"）',
      { file: u.file, exists: u.found, others: u.others, declared: true, source: DECLARED_SOURCES['usage-ledger'] }, asOf));
  }

  // ---- ⑧ 撤回台账（declared：S-5 未落 + §16-B2 判据算不出来）
  {
    const f = path.join(home, 'memory', 'retractions.jsonl');
    const exists = fs.existsSync(f);
    checks.push(mkCheck('retractions', '撤回台账', CHECK_STATES.DECLARED,
      `**未落 · 已声明**：${DECLARED_SOURCES.retractions}`
      + `｜现值：\`memory\\retractions.jsonl\` ${exists ? '在' : '不在'}`,
      { file: f, exists, declared: true, source: DECLARED_SOURCES.retractions }, asOf));
  }

  const counts = {
    ok: checks.filter((c) => c.state === CHECK_STATES.OK).length,
    degraded: checks.filter((c) => c.state === CHECK_STATES.DEGRADED).length,
    unavailable: checks.filter((c) => c.state === CHECK_STATES.UNAVAILABLE).length,
    declared: checks.filter((c) => c.state === CHECK_STATES.DECLARED).length,
    total: checks.length,
  };
  const state = !environment.ok
    ? 'environment-unavailable'
    : (counts.unavailable > 0 ? CHECK_STATES.UNAVAILABLE : (counts.degraded > 0 ? CHECK_STATES.DEGRADED : CHECK_STATES.OK));

  return {
    ok: environment.ok && counts.unavailable === 0,
    state, exitCode: exitCodeOf({ state, counts, environment }), asOf, host, home, counts, checks, environment,
  };
}

/** 退出码计算（`--strict` 时 `declared` 也按不可用计）。 */
export function exitCodeOf(health, { strict = false } = {}) {
  if (!health?.environment?.ok) return HEALTH_EXIT.ENVIRONMENT;
  const c = health.counts ?? {};
  if ((c.unavailable ?? 0) > 0) return HEALTH_EXIT.UNAVAILABLE;
  if (strict && (c.declared ?? 0) > 0) return HEALTH_EXIT.UNAVAILABLE;
  if ((c.degraded ?? 0) > 0) return HEALTH_EXIT.DEGRADED;
  return HEALTH_EXIT.OK;
}

/** 状态词（人话 + 图标）。 */
export function stateWord(state) {
  return ({
    ok: '🟢 正常',
    degraded: '🟡 有降级',
    unavailable: '🔴 不可用',
    'environment-unavailable': '❔ 环境不可用',
  }[state] ?? '❔ 未知');
}

/** 单条检查的状态图标（declared 用 ⚪：**故意不用 ✅** —— 未落实不是绿）。 */
export function checkIcon(state) {
  return ({ ok: '✅', degraded: '⚠️', unavailable: '🔴', declared: '⚪' }[state] ?? '❔');
}

// ---------------------------------------------------------------- 渲染：日报段（挂点 2）与人话

/**
 * 「📱 服务面」日报段行（**纯渲染**，不读文件、不发请求）。
 * ⚠️ 与 CLI 同一份判定：`collectHealth()` 只算一次，本函数只排版（① 包冻结项「只渲染、不自算」）。
 * @param {object} health `collectHealth()` 的返回值
 * @param {{limit?:number, asOf?:string}} [opts]
 * @returns {string[]}
 */
export function healthSectionLines(health, opts = {}) {
  if (!health || typeof health !== 'object') {
    return ['## 📱 服务面', '', '- 🔴 **判定不可用**（collectHealth 无输出 —— 这不是"服务面正常"）'];
  }
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 6;
  const c = health.counts ?? {};
  const L = [];
  L.push('## 📱 服务面');
  L.push('');
  L.push(`- ${stateWord(health.state)} · 判定 \`${health.state}\` · 可用项 ✅${c.ok ?? 0} / 降级 ⚠️${c.degraded ?? 0} / 不可用 🔴${c.unavailable ?? 0} / 未落⚪${c.declared ?? 0} · asOf \`${health.asOf}\`（设备 \`${health.host}\`）`);
  const shown = (health.checks ?? []).filter((x) => x.state !== CHECK_STATES.DECLARED).slice(0, limit);
  for (const x of shown) L.push(`- ${checkIcon(x.state)} \`${x.id}\` **${x.title}**：${x.detail}`);
  if ((health.checks ?? []).filter((x) => x.state !== CHECK_STATES.DECLARED).length > shown.length) {
    L.push(`- …另有 ${(health.checks ?? []).filter((x) => x.state !== CHECK_STATES.DECLARED).length - shown.length} 项（跑 CLI 看全量）`);
  }
  const declared = (health.checks ?? []).filter((x) => x.state === CHECK_STATES.DECLARED);
  if (declared.length) {
    L.push(`- ⚪ **未落 · 已声明 ${declared.length} 项**（**不判绿、也不算缺陷**；出处见各项）：` + declared.map((x) => `\`${x.id}\``).join(' · '));
    for (const x of declared) L.push(`  - \`${x.id}\`：${x.detail.split('｜')[0]}`);
  }
  if (!health.environment?.ok) L.push(`- ❔ **环境不可用**：${health.environment?.error ?? '未知'}（判定自身跑不起来，与"服务面坏了"分开看）`);
  L.push(`> 口径：唯一判定入口 \`tools\\dsh-butler\\lib\\secretary-health.mjs\`（日报**只渲染、不自算判定**；零网络、零写盘、不读密钥值）。`
    + `退出码 0 全绿 / 1 有降级 / 2 有不可用 / 3 环境不可用（数字自定义，见 ⑤ 包 §16-B10；\`--strict\` 时"未落"也计入 2）。`
    + `手动看：\`node <workspace>\\tools\\butler-secretary-health.mjs\``);
  return L;
}

/** CLI 人话渲染（与日报段同源，排版更详细）。 */
export function healthHumanLines(health, { strict = false } = {}) {
  const L = [];
  const c = health?.counts ?? {};
  L.push(`🐳 服务面健康自检（只读）· ${health?.asOf ?? '?'} · 设备 ${health?.host ?? '?'} · home ${health?.home ?? '?'}`);
  L.push(`判定：${stateWord(health?.state)} · 退出码 ${exitCodeOf(health, { strict })}${strict ? '（--strict：未落项按不可用计）' : ''}`);
  L.push(`可用 ✅${c.ok ?? 0} · 降级 ⚠️${c.degraded ?? 0} · 不可用 🔴${c.unavailable ?? 0} · 未落⚪${c.declared ?? 0}（共 ${c.total ?? 0} 项）`);
  L.push('');
  for (const x of health?.checks ?? []) {
    L.push(`${checkIcon(x.state)} [${x.state}] ${x.id} · ${x.title}`);
    L.push(`    ${x.detail}`);
  }
  if (!health?.environment?.ok) L.push(`❔ 环境不可用：${health?.environment?.error ?? '未知'}`);
  L.push('');
  L.push('硬边界：零网络（"探针可达性"= 本地可解析，不是真连通性）· 零写盘 · 不输出任何密钥值。');
  L.push('退出码：0 全绿 / 1 有降级 / 2 有不可用 / 3 环境不可用（--strict 把"未落⚪"也算 2）。');
  return L;
}

// ---------------------------------------------------------------- S-9：家人用量（只读）

/** 定位本机用量台账（host 不区分大小写；顺带报出其它主机台账）。 */
export function findUsageLedger(home, host) {
  const want = `secretary-usage-${host}.jsonl`.toLowerCase();
  let all = [];
  try { all = fs.readdirSync(home).filter((n) => /^secretary-usage-.*\.jsonl$/i.test(n)); } catch { /* 目录不可读 ⇒ 按未落处理 */ }
  const exact = all.find((n) => n.toLowerCase() === want) ?? null;
  return {
    file: path.join(home, exact ?? `secretary-usage-${host}.jsonl`),
    found: exact !== null,
    others: all.filter((n) => n !== exact).map((n) => path.join(home, n)),
  };
}

/**
 * 家人用量只读读数（身份表 + 按人用量台账 + 推送台账旁证）。
 * @param {{home?:string, now?:number, host?:string, deps?:{notifyMod?:object}}} [opts]
 */
export async function collectFamilyUsage(opts = {}) {
  const now = opts.now ?? Date.now();
  const asOf = new Date(now).toISOString();
  const home = resolveHome(opts);
  const host = opts.host ?? os.hostname();
  const today = localDay(now);

  // 身份表
  const idFile = path.join(home, 'secretary-users.json');
  const idRaw = readJsonSafe(idFile);
  let users = [];
  let idShape = null;
  if (idRaw.ok) {
    // ⚠️ 三形态都认（2026-10-11 卡【翻译官·批4·家人档地基】补）：方案 §5.6 定稿的新表是
    //    `{version, default:"deny", users:{<userid>:{…}}}` —— **`users` 是 map 不是数组**。
    //    旧实现只认"数组根 / `{users:[…]}`" ⇒ 新表落盘会被判成 `unknown-shape`（= 读成"0 人"，
    //    而日报会照 0 人渲染 —— 那是**假读数**，属本文件自己禁止的那一类）。
    const v = idRaw.value;
    const META = new Set(['version', 'schemaVersion', 'default', 'product', 'updatedAt', 'note', '$schema']);
    const rows = [];
    const take = (uid, rec) => {
      const u = String(uid ?? '').trim();
      if (!u || u.startsWith('_') || META.has(u)) return;
      rows.push({ userid: u, name: rec?.name ?? rec?.displayName ?? null, role: rec?.role ?? null, enabled: rec?.enabled !== false, caps: rec?.caps ?? null, notified: rec?.notified === true });
    };
    if (Array.isArray(v)) {
      idShape = 'array';
      for (const u of v) take(typeof u === 'string' ? u : (u?.userid ?? u?.user ?? u?.id), u);
    } else if (v && typeof v === 'object') {
      const inner = v.users ?? v.members ?? null;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        idShape = 'object.users-map';
        for (const [uid, rec] of Object.entries(inner)) take(uid, rec);
      } else if (Array.isArray(inner)) {
        idShape = 'object.users';
        for (const u of inner) take(typeof u === 'string' ? u : (u?.userid ?? u?.user ?? u?.id), u);
      } else {
        idShape = 'flat-map';
        for (const [uid, rec] of Object.entries(v)) { if (typeof rec === 'string') { take(rec, {}); continue; } take(uid, rec); }
      }
    } else idShape = 'unknown-shape';
    users = rows;
  }
  const nameOf = (userid) => users.find((u) => u.userid === userid)?.name ?? null;

  // 用量台账
  const u = findUsageLedger(home, host);
  const led = readLedgerRows(u.file);
  const perUser = new Map();
  let totalTurns = 0; let totalTokens = 0; let rejected = 0; let badRows = led.bad;
  for (const r of led.rows) {
    const userid = String(r?.userid ?? '').trim() || '(未标记)';
    const turns = Number(r?.turns) || 0;
    const tokens = Number(r?.tokens) || 0;
    const isToday = localDay(Date.parse(r?.at ?? '')) === today;
    const cell = perUser.get(userid) ?? { userid, name: nameOf(userid), turnsToday: 0, turnsAll: 0, tokensToday: 0, rejectedToday: 0, lastAt: null };
    cell.turnsAll += turns;
    if (isToday) {
      cell.turnsToday += turns;
      cell.tokensToday += tokens;
      if (r?.rejected === true || String(r?.result ?? '') === 'rejected') cell.rejectedToday++;
    }
    if (cell.lastAt === null || String(r?.at ?? '') > cell.lastAt) cell.lastAt = r?.at ?? null;
    perUser.set(userid, cell);
    if (isToday) { totalTurns += turns; totalTokens += tokens; if (r?.rejected === true || String(r?.result ?? '') === 'rejected') rejected++; }
  }

  // 推送台账旁证（今日真送达）
  let notifyMod = opts.deps?.notifyMod ?? null;
  let pushedToday = null; let pushedAll = null; let pushError = null;
  try {
    if (!notifyMod) notifyMod = await import(pathToFileURL(NOTIFY_PATH).href);
    const p = readLedgerRows(path.join(home, 'secretary-push.jsonl'));
    const real = p.rows.filter(isRealSend);
    pushedAll = real.length;
    pushedToday = real.filter((r) => localDay(Date.parse(r.at)) === today).length;
  } catch (e) { pushError = String(e?.message ?? e); }

  const state = (!idRaw.exists || !u.found) ? CHECK_STATES.DECLARED : CHECK_STATES.OK;
  return {
    asOf, host, home, day: today, state,
    identity: { file: idFile, exists: idRaw.exists, ok: idRaw.ok, error: idRaw.error, shape: idShape, count: users.length, users },
    usage: {
      file: u.file, exists: u.found, otherHostFiles: u.others, rows: led.rows.length, badRows, error: led.error,
      totalTurnsToday: totalTurns, totalTokensToday: totalTokens, rejectedToday: rejected,
      perUser: [...perUser.values()].sort((a, b) => b.turnsAll - a.turnsAll),
    },
    push: { sentToday: pushedToday, sentAll: pushedAll, error: pushError },
  };
}

/**
 * 「👨‍👩‍👧 家人用量」日报段行（**纯渲染**）。
 * @param {object} u `collectFamilyUsage()` 的返回值
 * @returns {string[]}
 */
export function familyUsageSectionLines(u) {
  if (!u || typeof u !== 'object') {
    return ['## 👨‍👩‍👧 家人用量', '', '- 🔴 **判定不可用**（collectFamilyUsage 无输出 —— 这不是"今天没人用"）'];
  }
  const L = [];
  L.push('## 👨‍👩‍👧 家人用量');
  L.push('');
  L.push(`- ⏱ 统计日 \`${u.day}\` · 设备 \`${u.host}\` · asOf \`${u.asOf}\` · 数据源：身份表 \`secretary-users.json\` + 按人台账 \`secretary-usage-${u.host}.jsonl\``);
  if (!u.identity.exists) {
    L.push(`- ⚪ 身份表 \`secretary-users.json\` **未落（已声明）**：${DECLARED_SOURCES['family-users']} ⇒ 只能报原始 userid，映射不出人名`);
  } else if (!u.identity.ok) {
    L.push(`- 🔴 身份表在但读不动（${u.identity.error}）⇒ 按人映射不可用`);
  } else {
    L.push(`- ✅ 身份表 ${u.identity.count} 人（形态 \`${u.identity.shape}\`）`
      + (u.identity.count ? `：${u.identity.users.slice(0, 6).map((x) => `${x.name ?? x.userid}${x.enabled === false ? '(停用)' : ''}`).join(' · ')}` : '（表是空的 ⇒ 任何人都算"未登记"）'));
  }
  if (!u.usage.exists) {
    L.push(`- ⚪ 用量台账 \`secretary-usage-${u.host}.jsonl\` **未落（已声明）**：${DECLARED_SOURCES['usage-ledger']}`
      + ` ⇒ 今日按人用量**无可读数**（**这不是"今天没人用"**）`);
  } else if (u.usage.error) {
    L.push(`- 🔴 用量台账读失败：${u.usage.error}`);
  } else {
    L.push(`- 📊 今日：回合 **${u.usage.totalTurnsToday}** · tokens **${u.usage.totalTokensToday}** · 被拒 **${u.usage.rejectedToday}** 条 · 台账 ${u.usage.rows} 行（坏行 ${u.usage.badRows}）`);
    if (u.usage.perUser.length) {
      for (const p of u.usage.perUser.slice(0, 5)) {
        L.push(`  - ${p.name ? `**${p.name}**` : `\`${p.userid}\``}（${p.userid}）：今日 ${p.turnsToday} 回合 / ${p.tokensToday} tokens · 被拒 ${p.rejectedToday} · 累计 ${p.turnsAll} 回合 · 末次 ${p.lastAt ?? '-'}`);
      }
    } else L.push('  - （台账里还没有任何行）');
  }
  L.push(`- 📮 推送台账旁证：今日真送达 **${u.push.sentToday ?? '?'}** 条 · 累计 **${u.push.sentAll ?? '?'}** 条`
    + (u.push.error ? `（读失败：${u.push.error}）` : '') + '（口径：`status==="sent"` 且非 test/dry-run）');
  L.push('> 口径：唯一读入口 `tools\\dsh-butler\\lib\\secretary-health.mjs#collectFamilyUsage`（日报**只渲染、不自算**，零网络零写盘）；'
    + '载体不存在 ⇒ 显式成段写「无可读数」，**绝不渲染成"没有家人使用"**（那是把"没有载体"说成"没有使用"）。');
  return L;
}
