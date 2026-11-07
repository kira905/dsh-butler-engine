// dsh-butler / lib/ledger-api.mjs —— 看板账本 **Host API 客户端**（P3 唯一生产写路径）
//
// 依据：docs/（§3 覆盖度比对表 / §5.2 落地形态 / §5.3 四个细节）
//       docs/（路由 / 鉴权面 / 幂等语义 / 真写探针实测）
//
// 为什么有这一层（一句话）：**账本由 Host 权威持有**（`host-ledger.ts` 内存 document + 每次
//   action 末尾整份 commit 覆写文件）→ 任何直写文件的改动都会被 Host 的下一次提交**静默覆盖**
//   （无报错无日志）。所以 P3 的写一律 POST /api/task-board/action，由 Host 校验 + 串行落盘。
//
// 铁律（本模块遵守，调用方不得绕过）：
//   ① 同源头请求头**必须带**（`origin` = baseUrl + `sec-fetch-site: same-origin`），否则 403；
//   ② 生产一律用 `localhost`（本机铁律；`127.0.0.1` 只在隔离/mock 场景显式传入）；
//   ③ `requestId` 幂等：Host 按 `sha256(action)` 指纹缓存**成功**的 action → 同 requestId 同 action
//      重放不重复执行；**失败重试必须换新 requestId**（失败不进缓存），用读回 state 判定是否已生效；
//   ④ `expect` 是**管家侧元数据**（读回校验用），绝不进 envelope（Host 用 exactKeys 校验，多一键即 400）。
//
// ★★ K3 补充（2026-09-24 · 看板瘦身/归档物理化 · 方案 §8 #9 · `L2-3`/`L2-4`）：
//   ⑤ **`ACTION_KEYS` 必须随插件协议同步**：归档物理化给 `protocol.ts` 加了
//      `archive-many`（**语义升级为物理搬出**）/ `archive-compact` / `restore-many` 三个 kind，
//      漏一个的后果是**本地预校验直接判 `permanent` 且不重试**（`validateActionShape`）⇒
//      管家从此静默发不出该动作。本表已补全，并在 `_test\test-ledger-api.mjs` 里钉了用例。
//   ⑥ **读快照的 scope 决定 = 「默认不带（= Host 的 all）」**：物理归档之后 Host 的
//      `all` 是 `mergeBoardView(主账本, 全部归档批次)`（K2 已按方案 §3 D-10 (a) 落地）
//      ⇒ 本模块十余处消费方（日报/台账/进度/查重/并回）语义**逐字不变**；显式 `scope:'live'`
//      才只拿在板卡（**只在确实不需要归档卡时用**，否则等于把归档卡当不存在）。
//
// 错误分档（重试策略的唯一依据）：
//   ok        —— 2xx 且 body.ok !== false
//   offline   —— 连不上/超时（Host 不在线、DNS/连接被拒）→ 可重试
//   retryable —— 408 / 429 / 5xx（瞬时故障）→ 可重试
//   retryable —— **`body-unreadable`**：HTTP 200 但响应体解析不出（body 为空/截断，超时可能打在
//                「headers 已到、body 还在传」的窗口）→ 可重试（2026-10-10 起 fail-closed，
//                此前是"静默空账本"，见 readState 内 ★★ fail-closed 一段）
//   permanent —— 其余 4xx（校验拒绝：forbidden / invalid-action / task not found / archived …）→ **不重试**
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_API_VERSION = '0.1.0';

/** 生产默认（本机铁律：一律 localhost，不用 127.0.0.1）。 */
export const DEFAULT_BASE_URL = 'http://localhost:3080';
export const STATE_PATH = '/api/task-board/state';
export const ACTION_PATH = '/api/task-board/action';

/** Host 侧上限：requestId ≤ 256 字符（protocol.ts:184）。 */
export const MAX_REQUEST_ID_LEN = 256;

/** 默认重试策略（仅对 retryable/offline 生效）。 */
export const DEFAULT_RETRY = Object.freeze({ attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 });
export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * 读路径（`GET /state`）**单次**超时 —— 与写路径分开，写路径保持 8 s 一字不动。
 *
 * 为什么单独放宽（2026-10-10 · 多端线「看板 API 读路径健壮性」卡）：
 *   `/api/task-board/state` 响应体实测 **5.5 MB**、单次耗时实测 **0.9–5.0 s**；同一时刻往往还有
 *   别的 tickd job / 面板在读同一份 state ⇒ 偶发越过 8 s 是常态。后果不是"慢"，而是
 *   `dup-cards-merge` 这类 job **整轮 exit-1**（stdout：`看板 state 不可读（offline/TimeoutError）`）。
 */
export const READ_TIMEOUT_MS = 20_000;

/**
 * 读路径**总预算**：单次 `readState()` 的墙钟上限（含全部重试与退避）。
 *
 * 存在的理由：读路径现在也重试（`DEFAULT_RETRY.attempts` = 3），若每次都能等满 `READ_TIMEOUT_MS`，
 * 最坏会到 60 s，把 `dup-cards-merge`（观测基线 15 s）拖成一条超预算观测行。封顶 30 s 后最坏 ≈30 s，
 * 且**只在 Host 真卡死（收到请求但不响应）时才会走到** —— 连不上（ECONNREFUSED）是毫秒级返回，
 * 重试几乎零成本；真越线时 job 本来也已处于异常态。
 */
export const READ_TOTAL_BUDGET_MS = 30_000;

/**
 * 各 action kind 的**精确**键集（照 task-board `src\protocol.ts` 抄；多一键 Host 即拒）。
 *
 * ⚠️ **必须随插件协议同步**（K3 · 2026-09-24 补齐归档物理化引入的三个动作）：
 *   · `archive-many`（`:294-300`）—— **升级为物理搬出**（卡离开主账本进批次），2026-09-24 新加；
 *   · `archive-compact`（`:302-304`）—— 一次性迁移（把主账本里带 `archivedAt` 的老归档卡搬进批次）；
 *   · `restore-many`（`:305-308`）—— 批次级恢复（只带 `batchId`，**不带 taskId**）。
 * 漏一个的后果不是"少个功能"—— 是**本地预校验直接判 permanent 且不重试**（`validateActionShape`），
 * 管家从此静默发不出该动作。行号时点 = 2026-09-24 21:0x 亲核。
 */
const ACTION_KEYS = Object.freeze({
  import: ['kind', 'sourceId', 'tasks'],
  create: ['kind', 'id', 'input'],
  update: ['kind', 'taskId', 'patch'],
  'set-schedule': ['kind', 'taskId', 'patch'],
  move: ['kind', 'taskId', 'status'],
  confirm: ['kind', 'taskId'],
  reject: ['kind', 'taskId', 'note'],
  delete: ['kind', 'taskId'],
  archive: ['kind', 'taskId'],
  restore: ['kind', 'taskId'],
  run: ['kind', 'taskId'],
  rerun: ['kind', 'taskId'],
  // —— 归档物理化（K1 交付 · K3 同步进表）——
  'archive-many': ['kind', 'taskIds'],
  'archive-compact': ['kind'],
  'restore-many': ['kind', 'batchId'],
});

/**
 * 不需要 `taskId` 的 kind（`protocol.ts` 并没有一条"除 create/import 外一律要求 taskId"的
 * 普适规则 —— 它是**逐 kind 分支**判的；本模块用这份白名单反判，等价且更好维护）：
 *   `create`/`import` 带 id/sourceId；`archive-compact` 只带 kind；
 *   `restore-many` 带 `batchId`；**`archive-many` 带 `taskIds` 数组**（`:295-300`）。
 */
const KINDS_WITHOUT_TASK_ID = ['create', 'import', 'archive-compact', 'restore-many', 'archive-many'];

/** `archive-many` 的 taskIds 上限（`protocol.ts:298`：非空、≤500、每项非空且 ≤256 字符）。 */
const ARCHIVE_MANY_MAX_IDS = 500;
const TASK_ID_MAX_LEN = 256;

/**
 * batchId 形状（**与 Host `src/core/archive-id.ts` 逐字同源**：同一正则 + 同一 `..` 禁则）。
 * 本地比 Host 松 ⇒ 白挨一次 `permanent` 400；比 Host 紧 ⇒ 误拒合法批次。
 */
const ARCHIVE_BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isValidBatchIdShape(batchId) {
  return typeof batchId === 'string' && ARCHIVE_BATCH_ID_PATTERN.test(batchId) && !batchId.includes('..');
}

/** `update` patch 白名单（protocol.ts:163-171）。 */
const UPDATE_PATCH_KEYS = ['title', 'description', 'prompt', 'workspaceId', 'mode', 'permission', 'kind', 'schedule', 'line', 'seq'];
/** `set-schedule` patch 白名单（protocol.ts:173-179）。 */
const SCHEDULE_PATCH_KEYS = ['enabled', 'cron'];
/** 管家侧元数据键（**不进 wire**；`note` 不在其中——它是 `reject` 的合法 wire 字段）。 */
const META_KEYS = ['expect', 'label'];

// ---------------------------------------------------------------- 纯函数

/** 归一化 baseUrl（去尾斜杠；空 → 默认）。显式传入的 baseUrl **原样保留**（mock/测试实例要用 127.0.0.1:port）。 */
export function normalizeBaseUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return DEFAULT_BASE_URL;
  return s.replace(/\/+$/, '');
}

/** 同源头请求头（A12 §4 实测：缺了就是 403）。 */
export function sameOriginHeaders(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  return { origin: base, 'sec-fetch-site': 'same-origin' };
}

/**
 * 看板 scope 头（**只有显式 `'live'` 才带头**；其余一律不带 = Host 默认的 `all`）。
 *
 * 为什么默认不带而不是显式带 `all`：不改任何既有请求的字节（零行为变化）；
 * 且 Host 侧 `readScopeHeader` 本来就把"非 live"一律当 all。
 */
export function scopeHeaders(scope) {
  return scope === 'live' ? { 'x-dsh-board-scope': 'live' } : {};
}

/** action 指纹（与 Host 侧 `sha256(JSON.stringify(action))` 同口径——用于 requestId 生成与去重说明）。 */
export function actionFingerprint(action) {
  return crypto.createHash('sha256').update(JSON.stringify(action ?? null)).digest('hex');
}

/**
 * 生成 requestId。**确定性**：同 (prefix, action, attempt) → 同 id。
 * - 同一序列的同一动作重复提交（同 attempt）→ 同 id → Host 幂等返回，不重复执行；
 * - **失败重试换新 attempt** → 新 id（失败不进 Host 缓存，重试必须换 id 才不会被旧缓存挡）。
 * @param {object} action
 * @param {{prefix?:string, attempt?:number}} [opts]
 */
export function makeRequestId(action, opts = {}) {
  const prefix = String(opts.prefix ?? 'p3').replace(/[^\w.:-]/g, '_').slice(0, 48);
  const attempt = Math.max(0, Math.floor(Number(opts.attempt ?? 0)));
  const id = `${prefix}-${actionFingerprint(action).slice(0, 24)}-a${attempt}`;
  return id.length <= MAX_REQUEST_ID_LEN ? id : id.slice(0, MAX_REQUEST_ID_LEN);
}

/** 剥掉管家侧元数据（只保留 wire 允许的键；`expect` 绝不发给 Host）。 */
export function sanitizeAction(action) {
  if (!action || typeof action !== 'object') return action;
  const out = {};
  for (const [k, v] of Object.entries(action)) if (!META_KEYS.includes(k)) out[k] = v;
  if (out.patch && typeof out.patch === 'object') out.patch = { ...out.patch };
  return out;
}

/**
 * 本地协议预校验（照 Host 抄一遍）——**发请求之前**就知道会不会被拒，
 * 让「动作写错」表现为本地 permanent 错误而不是一次 400 往返。
 * @returns {{ok:boolean, error?:string}}
 */
export function validateActionShape(action) {
  if (!action || typeof action !== 'object') return { ok: false, error: 'invalid-action: 动作不是对象' };
  const kind = action.kind;
  const allowed = ACTION_KEYS[kind];
  if (!allowed) return { ok: false, error: `invalid-action: 未知 kind「${String(kind)}」` };
  const keys = Object.keys(sanitizeAction(action));
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) return { ok: false, error: `invalid-action: 不允许的键 ${extra.join(',')}` };
  // 非空 taskId：**不是"除 create/import 外一律"**（`protocol.ts` 是逐 kind 分支判的）——
  // `archive-many` 带 taskIds 数组、`archive-compact` 只带 kind、`restore-many` 带 batchId，
  // 三者都没有 taskId（K3 · 2026-09-24 订正；首个候选版漏了 archive-many，单测当场逮住）。
  if (!KINDS_WITHOUT_TASK_ID.includes(kind) && (typeof action.taskId !== 'string' || action.taskId === '')) {
    return { ok: false, error: 'invalid-action: 缺 taskId' };
  }
  if (kind === 'archive-many') {
    const ids = action.taskIds;
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'invalid-action: archive-many 缺 taskIds' };
    if (ids.length > ARCHIVE_MANY_MAX_IDS) return { ok: false, error: `invalid-action: taskIds 超上限 ${ARCHIVE_MANY_MAX_IDS}（拆批后再发）` };
    if (!ids.every((id) => typeof id === 'string' && id !== '' && id.length <= TASK_ID_MAX_LEN)) {
      return { ok: false, error: 'invalid-action: taskIds 含非法 id（须为非空字符串且 ≤256 字符）' };
    }
  }
  if (kind === 'restore-many' && !isValidBatchIdShape(action.batchId)) {
    return { ok: false, error: 'invalid-action: restore-many 的 batchId 形状非法（Host 会 400 invalid-action）' };
  }
  if (kind === 'update') {
    if (!action.patch || typeof action.patch !== 'object') return { ok: false, error: 'invalid-action: 缺 patch' };
    const pk = Object.keys(action.patch);
    const bad = pk.filter((k) => !UPDATE_PATCH_KEYS.includes(k));
    if (bad.length) return { ok: false, error: `invalid-action: update patch 不允许的键 ${bad.join(',')}` };
  }
  if (kind === 'set-schedule') {
    const pk = Object.keys(action.patch ?? {});
    const bad = pk.filter((k) => !SCHEDULE_PATCH_KEYS.includes(k));
    if (bad.length) return { ok: false, error: `invalid-action: set-schedule patch 不允许的键 ${bad.join(',')}` };
    if (typeof action.patch?.cron === 'string' && action.patch.cron.trim() === '') return { ok: false, error: 'invalid-action: cron 为空' };
  }
  return { ok: true };
}

/** 失败分档（纯函数，单测直接覆盖）。 */
export function classifyFailure({ status = null, body = null, error = null } = {}) {
  if (error) {
    // Node 的 fetch 失败是 `TypeError: fetch failed`，真因埋在 `cause`：
    // 单地址 → cause.code；多地址（localhost→::1,127.0.0.1）→ **AggregateError** 的 `cause.errors[]`。
    const codes = [];
    const collect = (e) => {
      if (!e) return;
      if (typeof e.code === 'string') codes.push(e.code);
      if (Array.isArray(e.errors)) for (const x of e.errors) collect(x);
    };
    collect(error.cause);
    collect(error);
    const OFFLINE_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EHOSTUNREACH', 'ENETUNREACH'];
    const causeText = String(error?.cause?.message ?? '');
    // fetch 的 "bad port" = URL 端口配置错（重试一万次也不会好）→ 归 permanent，别浪费重试
    if (/bad port/i.test(causeText)) return { kind: 'permanent', code: 'bad-port', error: causeText };
    const offline = codes.some((c) => OFFLINE_CODES.includes(c))
      || error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return { kind: offline ? 'offline' : 'retryable', code: codes[0] ?? String(error?.name ?? 'network-error'), error: error?.message ?? String(error) };
  }
  const st = Number(status ?? 0);
  const code = String(body?.error ?? '');
  if (st >= 200 && st < 300 && body?.ok !== false) return { kind: 'ok', code: code || 'ok' };
  if (st === 408 || st === 429 || st >= 500) return { kind: 'retryable', code: code || `http-${st}` };
  if (st === 0) return { kind: 'retryable', code: code || 'no-status' };
  return { kind: 'permanent', code: code || `http-${st}` };
}

/** 是否可重试（唯一判据，别在调用方另写一套）。 */
export function isRetryable(kind) {
  return kind === 'retryable' || kind === 'offline';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 客户端

/**
 * 建 Host API 客户端。
 * @param {{
 *   baseUrl?:string, fetchImpl?:Function, timeoutMs?:number,
 *   readTimeoutMs?:number, readBudgetMs?:number,
 *   retry?:{attempts?:number, baseDelayMs?:number, maxDelayMs?:number},
 *   logger?:(msg:string)=>void, dryRun?:boolean
 * }} [opts]
 *   `timeoutMs`：**写路径**单次超时（默认 8 s；显式传入时读路径也沿用它 = 老语义不变）。
 *   `readTimeoutMs`：**读路径**单次超时（默认 20 s；显式传 `timeoutMs` 时以那个为准）。
 *   `readBudgetMs`：读路径总预算（默认 30 s；仅供单测注入短预算）。
 */
export function createLedgerApi(opts = {}) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  // 写路径超时（**一字未动**）。
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // 读路径单次超时（2026-10-10 新增）。取值的保守之处：**调用方显式传了 `timeoutMs` 时，读也用那个值**
  // ⇒ 既有显式指定超时的调用方（单测 / 隔离夹具）语义逐字不变；只有"没指定"的（= 全部生产调用方）
  // 才拿到放宽后的 `READ_TIMEOUT_MS`。`readState({timeoutMs})` 形参优先级最高（见 `readState` 的 JSDoc）。
  const explicitTimeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : null;
  const readTimeoutMs = Number(opts.readTimeoutMs) > 0 ? Number(opts.readTimeoutMs) : (explicitTimeoutMs ?? READ_TIMEOUT_MS);
  // 读路径总预算（默认 `READ_TOTAL_BUDGET_MS`）。做成可注入**只为可测性**（单测用短预算验证"封顶真的生效"）；
  // 生产调用方一律不传 ⇒ 取值恒定 30 s。
  const readBudgetMs = Number(opts.readBudgetMs) > 0 ? Number(opts.readBudgetMs) : READ_TOTAL_BUDGET_MS;
  const retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};
  const dryRun = opts.dryRun === true;

  /** 每 step 的写入序列前缀（同一序列内重试保持同前缀，重试换 attempt）。 */
  let sequenceCounter = 0;
  function nextPrefix(label) {
    sequenceCounter += 1;
    return `p3-${String(label ?? 'seq').slice(0, 16)}-${sequenceCounter}`;
  }

  /**
   * 发一次请求。
   * @param {string} pathname
   * @param {object} init
   * @param {{timeoutMs?:number}} [o] 单次超时覆盖（**读路径专用**；缺省 = 客户端级 `timeoutMs`，
   *   写路径调用时一律不传 ⇒ 与改前逐字同行为）
   */
  async function request(pathname, init, o = {}) {
    const url = `${baseUrl}${pathname}`;
    const attemptTimeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : timeoutMs;
    try {
      const res = await fetchImpl(url, {
        ...init,
        headers: { ...sameOriginHeaders(baseUrl), ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { res, body, status: res.status, url };
    } catch (error) {
      return { res: null, body: null, status: 0, url, error };
    }
  }

  /**
   * 只读快照。**绝不写账本**（P3 的输出统计/备份都靠它）。
   *
   * ★读路径健壮性（2026-10-10 · 多端线卡「看板 API 读路径健壮性」）：
   *   本函数**自带 3 次退避重试**（策略复用 `DEFAULT_RETRY`：`baseDelayMs` 200 / `maxDelayMs` 2000），
   *   单次超时用**读专属**的 `READ_TIMEOUT_MS`(20 s) 而不是写路径的 8 s，两者合计受
   *   `READ_TOTAL_BUDGET_MS`(30 s) 封顶。治的是同一件事：`GET /state` 是 5.5 MB 的大响应，
   *   **一次抖动 = 整轮 job exit-1**。
   *   边界（刻意划死，防误读）：
   *     · **返回形状与语义逐字不变** —— 失败时 `kind`/`code` 取**最后一次尝试**的分类
   *       （与写路径"重试耗尽取末次"同口径），字段集合/顺序与改前一致，**不新增字段**；
   *     · `durationMs` = 本次读取的**总耗时**（含重试与退避；语义仍是"这次读花了多久"）；
   *     · **URL 一字不改**（不加 cache-busting 查询串 —— `url` 就在返回值里，被消费方读）；
   *     · 重试只对 `retryable`/`offline` 生效（`permanent` 一次都不重试，与写路径同判据）。
   *     · **唯一的语义变更（2026-10-10 · fail-closed）**：`res.ok && body === null`（响应体解析失败）
   *       过去返回 `ok:true + tasks:[]`（静默空账本 = 漏检且无留痕），现在归
   *       `retryable/body-unreadable` 并重试，重试耗尽仍读不出 ⇒ `ok:false`
   *       （消费方走**既有的**失败通道留痕）。正常路径（body 解得出）一字未改。
   *
   * ★scope（K3 · 2026-09-24 的**决定**，方案 §8 #9 / `L2-4`）：
   *   **默认不带 scope 头 = `all`** —— 物理归档之后，Host 端的 `all` 是
   *   `mergeBoardView(主账本, 全部归档批次)`（K2 已按方案 §3 D-10 (a) 落地）⇒ **仍是"整本"**，
   *   本模块那十余处消费方（日报 / 会话台账 / 进度 / 查重 / 并回 / 面板）语义**逐字不变**。
   *   故**刻意保持"不带头"**（而不是改成 live）：带 live 只会让它们**静默少看归档卡**，
   *   正是本次要防的那类退化。只要在板卡的读者（queue / card-watchdog / 主线清账）
   *   走的是各自模块里显式带 live 的读法，不经过这里。
   *
   * 🔎 **"谁该带 live / 谁不该带"的唯一判据（2026-10-10 全库盘点 · 真源 = `docs\交付报告-多端线-
   *   state取数体积收口-20261010.md` §2）**：问一句「**这个读者的输出/判定会不会因为'归档卡看不见'
   *   而改变？**」——会 ⇒ 不许带（实测带 live 后归档卡一张都拿不到：9,678,610 B/1014 张 → 1,078,013 B/156 张）；
   *   不会 ⇒ 应该带。盘点结论：**必须保持全量** = 查重(`board-dup-check`/`dup-cards`) · 并回(`board-merge`) ·
   *   归档工具(`board-archive-*`) · 快照导出(`hot-collect`) · 台账(`session-ledger`) · 进度/日报
   *   (`progress-extract`) · 统计(`estimate-audit`) · 按 id 操作的 CLI(`board-ops\*`/`board-tools\*`/`board-card.mjs`) ·
   *   自主链(`butler-auto-tick` —— **`jobDup` 的 `archivedTwins` 靠归档卡**，这条最硬)；**已经带 live** =
   *   `queue-watch.readBoard`（queue/card-watchdog/bind-card/board-cleanup）+ `board-line-archive` +
   *   `tidy-move`/`tidy-refcheck` + `wake-smart`（2026-10-10 补）。
   * @param {{timeoutMs?:number, scope?:'all'|'live'}} [o]
   *   `timeoutMs`：**单次尝试**的超时覆盖（按名字语义只作用于读路径；不传 = 客户端级 `readTimeoutMs`）。
   *   ⚠️ 该形参在 2026-10-10 之前**是摆设（声明了但没用）**，本次一并接上 —— 不传即与改前取值同源。
   */
  async function readState(o = {}) {
    const t0 = Date.now();
    const scope = o.scope === 'live' ? 'live' : 'all';
    const maxAttempts = Math.max(1, Number(retry.attempts));
    const baseDelay = Number(retry.baseDelayMs);
    const maxDelay = Number(retry.maxDelayMs);
    const perAttempt = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : readTimeoutMs;
    // 总预算：显式给了更长的单次超时时，预算跟着放宽（否则形参会被悄悄砍掉，违反直觉）。
    const deadline = t0 + Math.max(readBudgetMs, perAttempt);

    let last = null; // 末次失败（收尾按它构造返回值；成功路径不受影响）
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (Date.now() >= deadline) break; // 预算用尽：不再发起新尝试
      const attemptTimeout = Math.max(1, Math.min(perAttempt, deadline - Date.now()));
      const r = await request(STATE_PATH, { method: 'GET', headers: scopeHeaders(o.scope) }, { timeoutMs: attemptTimeout });
      if (r.res && r.res.ok && r.body !== null) {
        const tasks = Array.isArray(r.body?.tasks) ? r.body.tasks : [];
        return {
          ok: true, kind: 'ok', code: 'ok', status: r.status, url: r.url, durationMs: Date.now() - t0,
          scope,
          revision: Number(r.body?.revision ?? 0), tasks, scheduler: r.body?.scheduler ?? null, raw: r.body ?? null,
        };
      }
      // ★★ fail-closed（2026-10-10 · 多端线卡「看板 state 取数体积收口」· **行为变更**，方向 = 家规 fail-closed）：
      //   `request()` 里 `res.json()` 抛错会被吞成 `body = null`。当 `AbortSignal.timeout` 正好打在
      //   「headers 已到、body（当前 5.5 MB）还在传」的窗口时，这里过去会**走成功分支 + `tasks: []`**
      //   —— 一个静默的"空账本"：消费方（dup job / 日报 / 台账）看到的是"没有卡"（漏检）而不是
      //   "读不到"（报错），且**零留痕**。生产真机复现见 `_archive\_tmp-archive-20261010\
      //   readstate-bench-20261010\probe-gate.mjs`（门 1500 ms ⇒ 改前/改后都复现 `ok:true + tasks:0 + rawIsNull:true`）。
      //   现在：**视为可重试失败**（`kind='retryable'` / `code='body-unreadable'`），三次都读不出 ⇒ 返回
      //   失败，由各消费方**既有的**失败通道留痕（dup job 的「看板 state 不可读（…）」/ 日报「未取到：<code>」/
      //   tickd 子进程 stderr 尾部 …… 这些通道在"连不上/超时"时本来就在跑，不是新增分支）。
      //   ⚠️ 正常路径（body 解得出）的返回形状与语义**一字未改**；失败形状沿用既有"带 HTTP 状态码"那一支。
      else if (r.res && r.res.ok) {
        log(`[ledger-api] readState 第 ${attempt + 1} 次：HTTP ${r.status} 但 body 解析失败（body 为空/截断；超时可能打在「headers 已到、body 还在传」的窗口）→ 按可重试失败处理（fail-closed，不再当空账本）`);
        last = {
          kind: 'retryable', code: 'body-unreadable',
          error: `HTTP ${r.status}: 响应体解析失败（不是空账本，是读不出；body 为空/截断）`,
          url: r.url, status: r.status,
        };
      } else if (r.res) {
        const c = classifyFailure({ status: r.status, body: r.body });
        last = { kind: c.kind, code: c.code, error: bodyErrorText(r.body, r.status), url: r.url, status: r.status };
      } else {
        const c = classifyFailure({ error: r.error });
        last = { kind: c.kind, code: c.code, error: c.error, url: r.url, status: null };
      }
      if (!isRetryable(last.kind) || attempt === maxAttempts - 1) break;
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      if (Date.now() + delay >= deadline) break; // 连退避都会越预算 ⇒ 不再试
      log(`[ledger-api] readState 第 ${attempt + 1} 次失败（${last.kind}/${last.code}）→ ${delay}ms 后重试`);
      await sleep(delay);
    }

    // ⚠️ 形状与改前逐字一致：带 HTTP 状态码的分支才有 `status`，连不上（无 res）的分支不带。
    if (!last) {
      // 防御分支（时钟跳变等极端情形下才会到）：与"连不上"同形返回，绝不假装成功。
      return { ok: false, kind: 'offline', code: 'read-budget-exhausted', error: `读预算在首次尝试前耗尽（${READ_TOTAL_BUDGET_MS}ms 上限）`, url: `${baseUrl}${STATE_PATH}`, durationMs: Date.now() - t0, scope, tasks: [], revision: null };
    }
    if (last.status === null) {
      return { ok: false, kind: last.kind, code: last.code, error: last.error, url: last.url, durationMs: Date.now() - t0, scope, tasks: [], revision: null };
    }
    return { ok: false, kind: last.kind, code: last.code, status: last.status, error: last.error, url: last.url, durationMs: Date.now() - t0, scope, tasks: [], revision: null };
  }

  /**
   * 发一个 action（**带重试与读回校验**）。
   * @param {object} action 动作（可带 `expect` 元数据，会被剥离）
   * @param {{prefix?:string, attempt?:number, requestId?:string, readback?:(tasks:any[])=>boolean, retry?:object, scope?:'all'|'live'}} [o]
   *   requestId：显式钉住（重放/幂等自检；正常情况下让本模块生成）；
   *   readback：读回判定（Host 成功但响应丢失时用——「是否已生效」以账本为准）；
   *   scope：**默认不带头（all）**。传 `'live'` 会让 Host 只回在板卡 ⇒ 响应体从 5.85 MB 级
   *     降到 0.90 MB 级（判据 J14 的达标路径之一，K2 起 `POST /action` 也认这个头）；
   *     ⚠️ 只在"确实不需要归档卡"的调用方用，否则会把归档卡当不存在。
   */
  async function postAction(action, o = {}) {
    const wire = sanitizeAction(action);
    const shape = validateActionShape(wire);
    const started = Date.now();
    if (!shape.ok) {
      return { ok: false, kind: 'permanent', code: 'invalid-action', error: shape.error, action: wire, requestId: null, attempts: 0, durationMs: Date.now() - started, steps: [] };
    }
    if (dryRun) {
      return { ok: true, kind: 'dry-run', code: 'dry-run', dryRun: true, action: wire, requestId: null, attempts: 0, durationMs: 0, steps: [] };
    }

    const prefix = o.prefix ?? nextPrefix(wire.kind);
    const maxAttempts = Math.max(1, Number(o.retry?.attempts ?? retry.attempts));
    const baseDelay = Number(o.retry?.baseDelayMs ?? retry.baseDelayMs);
    const maxDelay = Number(o.retry?.maxDelayMs ?? retry.maxDelayMs);
    const attemptsLog = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // ⚠️ 每次重试换新 requestId（Host 只缓存成功的 action；同 id 会被"旧指纹"挡）；
      //    调用方可用 `o.requestId` 显式钉住（重放/幂等自检用）。
      const requestId = o.requestId ?? makeRequestId(wire, { prefix, attempt });
      const r = await request(ACTION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...scopeHeaders(o.scope) },
        body: JSON.stringify({ requestId, action: wire }),
      });
      const cls = r.res && r.res.ok
        ? classifyFailure({ status: r.status, body: r.body })
        : classifyFailure({ status: r.status, body: r.body, error: r.error });
      const row = { attempt, requestId, status: r.status, kind: cls.kind, code: cls.code, error: cls.error ?? null };
      attemptsLog.push(row);

      if (cls.kind === 'ok') {
        return {
          ok: true, kind: 'ok', code: cls.code, status: r.status, requestId, attempts: attempt + 1,
          revision: Number(r.body?.revision ?? 0), tasks: Array.isArray(r.body?.tasks) ? r.body.tasks : [],
          action: wire, durationMs: Date.now() - started, steps: attemptsLog, settledByReadback: false,
        };
      }

      // 读回判定：Host 已生效但响应丢了（超时/连接断）时，账本才是真相源
      if (typeof o.readback === 'function' && isRetryable(cls.kind)) {
        try {
          const st = await readState();
          if (st.ok && o.readback(st.tasks) === true) {
            log(`[ledger-api] ${wire.kind} 第 ${attempt + 1} 次响应失败（${cls.code}）但读回判定已生效 → 视为成功`);
            return {
              ok: true, kind: 'ok', code: 'settled-by-readback', status: r.status, requestId, attempts: attempt + 1,
              revision: st.revision, tasks: st.tasks, action: wire, durationMs: Date.now() - started,
              steps: attemptsLog, settledByReadback: true,
            };
          }
        } catch { /* 读回失败不影响重试决策 */ }
      }

      if (!isRetryable(cls.kind)) {
        return {
          ok: false, kind: cls.kind, code: cls.code, error: cls.error ?? bodyErrorText(r.body, r.status),
          status: r.status, requestId, attempts: attempt + 1, action: wire, durationMs: Date.now() - started, steps: attemptsLog,
        };
      }
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
        log(`[ledger-api] ${wire.kind} 第 ${attempt + 1} 次失败（${cls.kind}/${cls.code}）→ ${delay}ms 后用新 requestId 重试`);
        await sleep(delay);
      }
    }

    const last = attemptsLog[attemptsLog.length - 1];
    return {
      ok: false, kind: last?.kind ?? 'retryable', code: last?.code ?? 'retry-exhausted',
      error: `重试 ${attemptsLog.length} 次仍失败：${last?.error ?? last?.code ?? '未知'}`,
      status: last?.status ?? 0, requestId: last?.requestId ?? null, attempts: attemptsLog.length, action: wire,
      durationMs: Date.now() - started, steps: attemptsLog,
    };
  }

  /**
   * 依次执行动作序列（P3 的写语义：**两步序列，失败态安全**）。
   * - `permanent` 失败 → 立即停（后续步骤不发），返回 partial/failed；
   * - 每步可带 `expect`：读回校验（失败重试时判定是否已生效）；
   * - `onStep`：每步结果回调（审计用）。
   * @param {object[]} actions
   * @param {{prefix?:string, label?:string, onStep?:(row:object)=>void}} [o]
   */
  async function applySequence(actions, o = {}) {
    const list = Array.isArray(actions) ? actions : [];
    const prefix = o.prefix ?? nextPrefix(o.label ?? 'seq');
    const steps = [];
    if (!list.length) return { ok: true, kind: 'noop', changed: 0, steps, failedStep: null, revision: null, appliedCards: [] };

    let changed = 0;
    let revision = null;
    const appliedCards = new Set();
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const action = node.action ?? node;
      const readback = typeof node.expect === 'function'
        ? node.expect
        : (node.expect === undefined ? undefined : (tasks) => matchesExpect(tasks, action, node.expect));
      const r = await postAction(action, { prefix, readback });
      const row = { index: i, action: sanitizeAction(action), ...r };
      steps.push(row);
      if (typeof o.onStep === 'function') { try { o.onStep(row); } catch { /* 回调失败不影响序列 */ } }
      if (!r.ok) return { ok: false, kind: steps.length ? 'partial' : 'failed', changed, steps, failedStep: i, revision, appliedCards: [...appliedCards], error: r.error, errorKind: r.kind, code: r.code };
      if (r.dryRun) continue; // dry-run：只记录将发的动作，不计生效
      if (r.revision) revision = r.revision;
      if (String(action.kind) === 'update' && action.taskId) { changed += 1; appliedCards.add(String(action.taskId)); }
      if (String(action.kind) === 'set-schedule' && action.taskId) appliedCards.add(String(action.taskId));
    }
    return { ok: true, kind: changed > 0 ? 'applied' : 'noop', changed, steps, failedStep: null, revision, appliedCards: [...appliedCards] };
  }

  /** 落一份 `GET /state` 快照（备份机制：**不依赖拷文件**，回滚走 API）。 */
  async function snapshot(o = {}) {
    const st = await readState();
    if (!st.ok) return { ok: false, error: st.error, kind: st.kind };
    if (!o.dir) return { ok: true, revision: st.revision, file: null, bytes: null, tasks: st.tasks };
    try {
      fs.mkdirSync(o.dir, { recursive: true });
      const stamp = new Date(o.now ?? Date.now()).toISOString().replace(/[:.]/g, '-');
      const file = path.join(o.dir, `state-${st.revision}-${stamp}.json`);
      const text = JSON.stringify({ schemaVersion: 2, revision: st.revision, capturedAt: new Date().toISOString(), source: `${baseUrl}${STATE_PATH}`, tasks: st.tasks }, null, 1) + '\n';
      fs.writeFileSync(file, text, 'utf8');
      return { ok: true, revision: st.revision, file, bytes: Buffer.byteLength(text), tasks: st.tasks };
    } catch (e) {
      return { ok: false, error: `快照写盘失败：${e?.message ?? e}`, revision: st.revision };
    }
  }

  return {
    baseUrl,
    version: LEDGER_API_VERSION,
    retry,
    readState,
    postAction,
    applySequence,
    snapshot,
    dryRun,
    nextPrefix,
  };
}

/** 读回判定：动作的期望态是否已在账本上成立（`expect` 形状见 dropCards 的动作生成）。 */
export function matchesExpect(tasks, action, expect) {
  const list = Array.isArray(tasks) ? tasks : [];
  const card = list.find((c) => String(c?.id) === String(action?.taskId));
  if (!card) return false;
  if (expect?.description !== undefined) {
    const cur = String(card.description ?? '').trim();
    if (cur !== String(expect.description).trim()) return false;
  }
  if (expect?.scheduleEnabled !== undefined) {
    if ((card.schedule?.enabled === true) !== expect.scheduleEnabled) return false;
  }
  return true;
}

function bodyErrorText(body, status) {
  const code = body?.error;
  return code ? `HTTP ${status}: ${code}` : `HTTP ${status}`;
}
