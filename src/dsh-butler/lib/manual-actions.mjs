// dsh-butler / lib/manual-actions.mjs —— P1「会动手」（写操作 · 手动动作统一闸门）
//
// 方案：`docs\大管家v2方案-从只读到真管家-20260909.md` §4 P1（行 454-495）+ §3.6.2/§3.6.3/§3.6.5
// 卡：P1 会动手（写操作，4 个手动动作）
//
// 本模块是**手动动作的唯一实现**（host 侧薄路由 `POST /api/dsh-butler/v1/action` 只做转发）：
//   · 动作注册表 MANUAL_ACTIONS：{id, 标题, 级别, maxAffected, exec(ctx)}
//   · 统一入口 runManualAction()：actor 校验 → 权限矩阵 → 默认 dryRun → 爆炸半径 → 子集断言
//     → TOCTOU 重预览 → 执行 → 审计（append-only JSONL 哈希链，复用 lib/audit.mjs）
//
// 五条硬口径（逐条对应方案原文，改这里前先读方案）：
//   ① **默认 dryRun:true**（缺省即预览），必须显式 `dryRun:false` 才真执行；执行还必须带
//      `expectedPlanHash`（= 上一次预览回给前端的 `planHash`）—— 没有它一律拒（不许"盲执行"）。
//   ② **单一实现不分预览/执行两个函数**（方案 §4 P1 技术方案第 2 条 · 审核 §三-5）：
//      每个动作只有一个 `exec(ctx)`，由 `ctx.dryRun` 决定返回"将做什么"还是真做；
//      真做前用 `ctx.assertWithinPlanned()` 断言「本次算出的动作集 ⊆ 预览动作集」，超出即中止 + 🔴。
//   ③ **TOCTOU**（方案 §4 P1 技术方案第 3 条）：执行请求带的 `expectedPlanHash` 与本次重算的计划
//      不一致 ⇒ 不弹死报错，而是**返回新预览**（`drift:true`，前端提示"状态已变化，请重新确认"）；
//      同一 (actor, 动作, 参数) 连续 2 次漂移 ⇒ 拒（`drift-too-frequent`）+ 记审计（防死循环）。
//   ④ **actor 校验 fail-close**（矩阵 §3.6.3）：actor ∈ {owner-panel, main-session, subagent,
//      scheduled-task}；**缺 actor / 未知 actor 一律拒**；subagent 禁 L2/L3；scheduled-task 只允许
//      `preRegistered:true` 的动作（P1 的四个动作一个都不预登记 ⇒ 计划任务一律拒）。
//      `butler-auto`（P3 自动动作）**不走本通道** —— 它有自己的闸门 lib/autonomy-actions.mjs。
//   ⑤ **爆炸半径**（§3.6.5）：注册表每项带 `maxAffected`；预览/执行都用 `affected.length` 比对，
//      超限**拒绝**并提示分批（`over-max-affected`），没有 force 通路（本卡不做 allowBatch）。
//
// 只读面：本模块的所有"判断"数据都来自只读来源（看板 Host API 的 /state、会话日志、审计键）。
// 写面只有三处：① 看板 Host API `POST /api/task-board/action`（**不直写账本**）
//   ② 升级预检报告 md（只读审计的产物） ③ 审计 JSONL（lib/audit.mjs）。
//
// 零副作用约定：`deps` 全可注入（board / fs / spawn / now），单测一律用假 board + 沙箱 home。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dshHome, ensureDir, COMPONENT_ROOT } from './paths.mjs';

/** 升级样本目录缺省：<home 的父级>/DSH/upgrade-canary/tarballs（env DSH_L0_TARBALLS 优先）。 */
const DEFAULT_TARBALLS_DIR = path.join(path.dirname(dshHome()), 'DSH', 'upgrade-canary', 'tarballs');
import { resolveStatePath } from './state-paths.mjs';
import { appendAudit } from './audit.mjs';
import { alert } from './alert.mjs';
import { discoverSessionFiles, decodeZstdFrames, extractUsage, summarizeUsage } from '../../../jobs/lib/token-usage.mjs';

export const MANUAL_ACTIONS_VERSION = '0.1.0';

// ───────────────────────── §1 常量与阈值（改这里 = 改口径，先读方案）─────────────────────────
const DAY = 86_400_000;

/** 挂起判定天数 —— 与面板 `lib/state.js` 的 `OVERDUE_DAYS` 同值（同口径，改一处必须改两处）。 */
export const OVERDUE_DAYS = 3;

/** 动作级：成本强确认 / 拒绝阈值（方案 §4 P1 细则②：>¥1 强确认，>¥5 拒绝并建议人工开会话）。 */
export const COST_STRONG_CONFIRM_CNY = 1;
export const COST_REFUSE_CNY = 5;

/** TOCTOU：同一 (actor, 动作, 参数) 连续漂移达到此数 ⇒ 拒 + 审计（方案 §4 P1 技术方案第 3 条）。 */
export const DRIFT_MAX_STREAK = 2;
/** 漂移计数窗口（内存态，不落盘：漂移是会话级即时现象，跨进程无需共享）。 */
const DRIFT_WINDOW_MS = 5 * 60_000;

/** 允许的 actor 集合（矩阵 §3.6.3；`butler-auto` 不在其中 —— 自动动作走 lib/autonomy-actions.mjs）。 */
export const ACTORS = Object.freeze(['owner-panel', 'main-session', 'subagent', 'scheduled-task']);

/** L3 手动动作的**显式声明清单**（方案 §3.6.3 矩阵的 L3 列 = 涉意图 / 难撤销）。
 *  ⚠️ 2026-10-10 卡「冲刺600·补核心库」（gap-1-06）：本版**没有 L3 手动动作** —— 现行 7 个动作
 *     全是 L1/L2（`upgrade-precheck` = L1，其余 L2）。此处把「没有」写成**可断言的事实**而非一句注释：
 *     ① 注册表将来新增 L3 动作时，**必须**同时在 `L3_ACTIONS` 登记并带非空 `l3Why` 理由，否则
 *        `runManualAction` 闸门 3.5 **fail-close 拒绝**；
 *     ② `l3Declaration()` 给单测 / 巡检器一个「声明 vs 注册表实况」的比对读数（一致才算通过）。
 *     矩阵原文 = `docs\大管家v2方案-从只读到真管家-20260909.md` §3.6.3。 */
export const L3_ACTIONS = Object.freeze([]);

/**
 * 模型价目（**每百万 token · 美元**；来源 `docs\API资产与定价.md` §10.2，官方定价页 2026-09-21）。
 * ⚠️ 一律取**高峰价**（保守 = 高估成本 ⇒ 更容易触发强确认/拒绝，fail-safe 方向正确）；
 *    价格变动时**必须回来同步本表**（唯一改动点，别在别处再写一份价格）。
 * 未知模型 → 按本表最贵档（pro）估，宁可高估。
 */
export const MODEL_PRICES_USD_PER_M = Object.freeze({
  'deepseek-flash': { inputMiss: 0.30, inputHit: 0.006, output: 1.20 },
  'deepseek-v4-pro': { inputMiss: 1.32, inputHit: 0.044, output: 3.96 },
  __default__: { inputMiss: 1.32, inputHit: 0.044, output: 3.96 },
});
/** 美元 → 人民币（口径 `docs\API资产与定价.md` 换算惯例 ≈7.2；只用于"估算成本"的量级判断）。 */
export const USD_TO_CNY = 7.2;

/** 看板 Host API 基址（测试实例 3090 由 env 覆盖；生产 = 本机 3080）。 */
export const BOARD_BASE_DEFAULT = 'http://localhost:3080';

// ───────────────────────── §2 看板 Host API 客户端（跨插件 HTTP，spike A12 已实测）─────────────
/**
 * task-board 的路由 fence（`dsh-task-board-local` 的 `isTrustedTaskBoardRequest`）要求：
 *   loopback socket + loopback Host 头 + **浏览器同源标记**（`origin` 或 `sec-fetch-site: same-origin`）。
 * 实测（2026-09-28 · 本卡 spike A12）：
 *   · 带 `origin`+`sec-fetch-site` → 通过（非法 action 返回 400 invalid-action = 已进解析层）
 *   · 不带头 → 403 forbidden
 *   · `GET /api/task-board/state` → 200（revision/tasks 正常）
 * 结论：**跨插件 HTTP 通路可用，无需退路**（退路=只读账本+一键跳转手动操作）。
 */
export function makeBoardClient({
  baseUrl = process.env.DSH_BUTLER_BOARD_URL || BOARD_BASE_DEFAULT,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const headers = { origin: base, 'sec-fetch-site': 'same-origin' };

  async function call(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, cache: 'no-store', signal: ctrl.signal });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, ok: res.ok, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl: base,
    /** 只读：看板全量状态（**含已归档卡**，带 `archivedAt`；调用方自行过滤）。 */
    async getState() {
      const r = await call(`${base}/api/task-board/state`);
      if (!r.ok || !r.json || !Array.isArray(r.json.tasks)) {
        throw new Error(`task-board state 不可达（HTTP ${r.status}）`);
      }
      return r.json;
    },
    /** 写：单个 action（**逐条发**，便于审计与错误定位；task-board 无批量信封）。 */
    async dispatch(action, requestId) {
      // ⚠️ **剥内部字段再上线**（2026-09-28 真机实测踩过）：动作项里带的本模块内部字段
      //   `targetKey`（用于子集断言/planHash 身份）**不在 task-board 的白名单里**，
      //   一起发出去会被 `parseActionEnvelope` 的 `exactKeys` 判掉 → 服务端回 `invalid-action`。
      //   这里统一剥，避免每个动作各记一次。
      const { targetKey: _targetKey, ...wire } = action ?? {};
      const r = await call(`${base}/api/task-board/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, action: wire }),
      });
      if (!r.ok || r.json?.ok === false) {
        throw new Error(r.json?.error ?? r.json?.message ?? `task-board action HTTP ${r.status}`);
      }
      return r.json;
    },
  };
}

// ───────────────────────── §3 通用工具 ─────────────────────────
/** 稳定序列化（键排序）—— planHash / 子集断言的唯一规范化口径。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 动作项的身份键：`targetKey`（动作自己给的语义键）优先，否则 kind + 目标 id。
 * **子集断言与 planHash 都用它** —— 于是"随机新建 id"这类不确定字段不会造成假漂移。
 */
export function actionKey(item) {
  if (!item || typeof item !== 'object') return 'invalid';
  if (typeof item.targetKey === 'string' && item.targetKey) return `${item.kind}|${item.targetKey}`;
  const id = item.taskId ?? item.sessionId ?? item.id ?? '';
  return `${item.kind}|${id}`;
}

/** 计划摘要：动作集（key + 载荷）规范化后 sha256 前 16 位。 */
export function planDigest(affected) {
  const normalized = (Array.isArray(affected) ? affected : [])
    .map((a) => ({ key: actionKey(a), payload: a.payload ?? a.patch ?? a.input ?? a.status ?? null }))
    .sort((x, y) => (x.key === y.key ? 0 : x.key < y.key ? -1 : 1));
  return createHash('sha256').update(stableStringify(normalized), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 「实际动作集 ⊆ 预览动作集」守卫（方案 §4 P1 技术方案第 2 条 · 审核 §三-5）。
 * 纯函数、可单测；runner 在每个动作真执行前调用它。超集 ⇒ 抛 `action-set-exceeds-preview`。
 */
export function assertSubset(planned, actual) {
  const allowed = new Set((Array.isArray(planned) ? planned : []).map(actionKey));
  const extra = (Array.isArray(actual) ? actual : []).map(actionKey).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    const err = new Error(`实际动作集超出预览集：${extra.join(', ')}`);
    err.code = 'action-set-exceeds-preview';
    err.extraKeys = extra;
    throw err;
  }
  return true;
}

/**
 * 重试成本门（纯函数，与 execCardRetry **共用同一套判据**，避免"预览说能跑、执行被拒"的分裂）。
 * @param {number|null} costCny 估算成本（null = 估不出来）
 * @param {boolean} ackCost 调用方是否已明确确认成本
 * @returns {{allow:boolean, needConfirm:boolean, code?:string, message?:string}}
 */
export function judgeRetryCost(costCny, ackCost) {
  if (Number.isFinite(costCny) && costCny > COST_REFUSE_CNY) {
    return {
      allow: false, needConfirm: false, code: 'cost-over-limit',
      message: `上次执行约 ${cny(costCny)}（> ${cny(COST_REFUSE_CNY)} 上限）：本入口拒绝自动重跑，建议人工开一个会话盯着跑（或去任务看板手动 run）。`,
    };
  }
  const needConfirm = !(Number.isFinite(costCny) && costCny <= COST_STRONG_CONFIRM_CNY);
  if (needConfirm && ackCost !== true) {
    return {
      allow: false, needConfirm: true, code: 'cost-needs-confirm',
      message: `${costCny === null ? '成本估不出来' : `预计消耗 ${cny(costCny)}`}（阈值 ${cny(COST_STRONG_CONFIRM_CNY)}）：重试会真开一个会话烧 token —— 需要带上 ackCost:true 明确确认后才执行。`,
    };
  }
  return { allow: true, needConfirm };
}

/** 参数摘要（漂移计数键用）。 */
function paramsDigest(params) {
  return createHash('sha256').update(stableStringify(params ?? {}), 'utf8').digest('hex').slice(0, 16);
}

/** 本地日期键 YYYY-MM-DD。 */
export function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 千分位/小数裁剪，给预览文案用。 */
function cny(n) {
  if (!Number.isFinite(n)) return '?';
  return n >= 0.01 ? `¥${n.toFixed(2)}` : `¥${n.toFixed(4)}`;
}

/**
 * 从会话日志读"最近一次执行"的 token 用量（只读、0 token、0 网络）。
 * 数据源 = 本机会话日志的 usage 事件（`lib/token-usage.mjs` 同一套适配层解析，不另造一份）。
 * @returns {{ok:boolean, usage?:object, model?:string, reason?:string}}
 */
export function readSessionUsage(sessionId, { home = dshHome() } = {}) {
  if (!sessionId || typeof sessionId !== 'string') return { ok: false, reason: 'missing-session-id' };
  let files = [];
  try { files = discoverSessionFiles(home); } catch (e) { return { ok: false, reason: `discover-failed:${e?.message ?? e}` }; }
  const hit = files.filter((f) => f.sessionId === sessionId);
  if (hit.length === 0) return { ok: false, reason: 'session-log-not-found' };
  const byDay = {};
  let bytes = 0;
  let model = null;
  for (const f of hit.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)).slice(0, 1)) {
    let buf;
    try { buf = fs.readFileSync(f.file); } catch (e) { return { ok: false, reason: `read-failed:${e?.message ?? e}` }; }
    bytes += buf.length;
    let decoded;
    try { decoded = decodeZstdFrames(buf); } catch (e) { return { ok: false, reason: `decode-failed:${e?.message ?? e}` }; }
    extractUsage({ text: decoded.text, sinceSeq: -1, byDay });
    // 顺带捞模型名（事件里带 model 字段时用；取不到就走默认档）
    for (const line of String(decoded.text ?? '').split('\n')) {
      if (!line.trim()) continue;
      const m = /"model"\s*:\s*"([^"]{1,80})"/.exec(line);
      if (m) model = m[1];
    }
  }
  const usage = summarizeUsage(byDay);
  const total = Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0)
    + Number(usage?.cacheReadTokens ?? 0) + Number(usage?.reasoningTokens ?? 0);
  if (!(total > 0)) return { ok: false, reason: 'no-usage-events', bytes };
  return { ok: true, usage, model, bytes, files: hit.length };
}

/**
 * 用量 → 人民币估算（**保守取高峰价**；未知模型按最贵档）。
 * @returns {{cny:number, usd:number, model:string, source:string, priced:boolean}}
 */
export function estimateUsageCost(usage, model = null) {
  const key = String(model ?? '').trim().toLowerCase();
  const price = MODEL_PRICES_USD_PER_M[key] ?? MODEL_PRICES_USD_PER_M.__default__;
  const missIn = Number(usage?.inputTokens ?? 0) / 1e6 * price.inputMiss;
  const hitIn = Number(usage?.cacheReadTokens ?? 0) / 1e6 * price.inputHit;
  const out = (Number(usage?.outputTokens ?? 0) + Number(usage?.reasoningTokens ?? 0)) / 1e6 * price.output;
  const usd = missIn + hitIn + out;
  return {
    cny: usd * USD_TO_CNY,
    usd,
    model: key || '__default__',
    source: `价目 docs\\API资产与定价.md §10.2（高峰价，保守）· 汇率 ${USD_TO_CNY}`,
    priced: Object.prototype.hasOwnProperty.call(MODEL_PRICES_USD_PER_M, key),
  };
}

// ───────────────────────── §4 动作定义 ─────────────────────────
// 每个动作只有一个 exec(ctx)：
//   · ctx.dryRun === true  → 必须 return ctx.preview({affected, summary, ...})，**零写操作**
//   · ctx.dryRun === false → 必须 **先** ctx.assertWithinPlanned(actions) 再逐条 deps.board.dispatch
// 任何"只读检查失败"都用 ctx.reject(code, message)（返回结构化拒绝，不抛异常）。

/** 从看板 state 里找一张未归档的卡。 */
function findCard(state, taskId) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  return tasks.find((t) => t && t.id === taskId && !t.archivedAt) ?? null;
}

/** 追加一行到卡描述（保留原文，只加一行 —— 回滚 = 删掉这一行）。 */
export function appendLine(description, line) {
  const base = typeof description === 'string' ? description : '';
  const sep = base.length === 0 || base.endsWith('\n') ? '' : '\n';
  return `${base}${sep}${line}`;
}

/**
 * ①a 挂起卡催办：给 todo/backlog 且 3 天没动的卡追加一条催办备注。
 * ⚠️「催办即续命」：备注写入会刷新 `updatedAt` ⇒ 3 天计时重置（属预期，预览里必须写明）。
 */
async function execCardNudge(ctx) {
  const taskId = String(ctx.params?.taskId ?? '').trim();
  if (!taskId) return ctx.reject('missing-taskId', '缺少 taskId：催办必须指定一张卡。');
  const state = await ctx.deps.board.getState();
  const card = findCard(state, taskId);
  if (!card) return ctx.reject('card-not-found', '这张卡不在看板（可能已被归档或删除）：请刷新后重试。');
  if (card.status !== 'todo' && card.status !== 'backlog') {
    return ctx.reject('card-not-pending', `「${card.title ?? taskId}」当前状态是 ${card.status}（不是待办/积压），催办不适用。`);
  }
  const now = ctx.now();
  const staleDays = Math.floor((now - Number(card.updatedAt ?? 0)) / DAY);
  if (!(staleDays >= OVERDUE_DAYS)) {
    return ctx.reject('card-not-overdue', `「${card.title ?? taskId}」最近 ${Math.max(staleDays, 0)} 天有更新（判定线 ${OVERDUE_DAYS} 天），不需要催办。`);
  }
  const stamp = `⏰ 大管家催办 ${localDayKey(now)}：这张卡 ${staleDays} 天没动了`;
  const actions = [{
    kind: 'update',
    targetKey: `card:${card.id}`,
    taskId: card.id,
    patch: { description: appendLine(card.description, stamp) },
  }];
  if (ctx.dryRun) {
    return ctx.preview({
      affected: actions,
      summary: `给「${card.title ?? card.id}」追加一条催办备注`,
      details: [
        `卡：${card.title ?? '(无标题)'}（${card.id}）`,
        `状态：${card.status} · 已挂起 ${staleDays} 天（最后更新 ${new Date(Number(card.updatedAt ?? 0)).toISOString()}）`,
        `将追加的备注：${stamp}`,
      ],
      warnings: [
        `⚠️ 催办即续命：写入备注会刷新 updatedAt ⇒ 该卡的 ${OVERDUE_DAYS} 天计时**立刻重置**，它会从"挂起"清单里消失一轮。`,
        '催办只加备注、不改状态、不通知任何人（不会打扰卡上的会话）。',
      ],
      rollback: { reversible: true, how: `删掉 description 里以「⏰ 大管家催办」开头的那一行 —— node <workspace>\\tools\\dsh-butler\\manual-action-rollback.mjs --correlation ${ctx.correlationId}（缺省 dry-run，真回滚加 --apply，**打生产树必须显式加 --allow-production**）` },
    });
  }
  ctx.assertWithinPlanned(actions);
  await ctx.deps.board.dispatch(actions[0], `${ctx.correlationId}-1`);
  return {
    applied: actions,
    summary: `已给「${card.title ?? card.id}」追加催办备注（updatedAt 已刷新，计时重置）`,
    // 结构化旧值（回滚用 · 2026-10-10）：写入的那一行**原文** + 卡 id
    //   ⇒ 回滚按"整行精确相等"定位，不再只靠行首前缀 + 审计日期猜（多行命中时旧法只能拒绝）。
    rollbackData: { taskId: card.id, nudgeLine: stamp },
  };
}

/**
 * ①b 改期：给**有定时**的卡改 cron / 停启用。
 * ⚠️ 看板 `set-schedule` 的 patch 只有 `{enabled, cron}` —— **没有"单次日期改期"语义**，
 *    所以文案只说"重复定时从 A 改到 B"，绝不写"从 09-15 改到 09-20"（方案 §4 P1 细则①的 v2.4 修正）。
 */
async function execCardReschedule(ctx) {
  const taskId = String(ctx.params?.taskId ?? '').trim();
  if (!taskId) return ctx.reject('missing-taskId', '缺少 taskId：改期必须指定一张卡。');
  const nextCronRaw = ctx.params?.cron;
  const nextCron = typeof nextCronRaw === 'string' ? nextCronRaw.trim() : '';
  const enabledRaw = ctx.params?.enabled;
  if (!nextCron && typeof enabledRaw !== 'boolean') {
    return ctx.reject('missing-patch', '缺少 cron（新定时）或 enabled（停/启用）：至少给一个。');
  }
  if (nextCron && !isPlausibleCron(nextCron)) {
    return ctx.reject('bad-cron', `cron 不像 5 段（分 时 日 月 周）表达式：${nextCron}（例：\`0 9 * * *\` = 每天 09:00）`);
  }
  const state = await ctx.deps.board.getState();
  const card = findCard(state, taskId);
  if (!card) return ctx.reject('card-not-found', '这张卡不在看板（可能已被归档或删除）：请刷新后重试。');
  if (card.kind === 'interactive') {
    // 方案 §4 P1 细则①：看板禁给 interactive 卡加定时 ⇒ 改期对它无意义（前端对它只出「催办」）
    return ctx.reject('interactive-no-schedule', `「${card.title ?? taskId}」是 interactive 卡（看板禁给它加定时），只能催办、不能改期。`);
  }
  const schedule = card.schedule && typeof card.schedule === 'object' ? card.schedule : null;
  if (!schedule) {
    return ctx.reject('card-no-schedule', `「${card.title ?? taskId}」没有重复定时（不是 recurring 卡），改期不适用；需要定时请去任务看板设置。`);
  }
  const patch = {};
  if (nextCron) patch.cron = nextCron;
  if (typeof enabledRaw === 'boolean') patch.enabled = enabledRaw;
  const oldCron = schedule.cron ?? '(未设置)';
  const oldEnabled = schedule.enabled === true;
  const actions = [{ kind: 'set-schedule', targetKey: `card:${card.id}`, taskId: card.id, patch }];
  const changeText = [
    nextCron ? `重复定时从 \`${oldCron}\` 改为 \`${nextCron}\`` : null,
    typeof enabledRaw === 'boolean' && enabledRaw !== oldEnabled ? `定时${enabledRaw ? '启用' : '停用'}` : null,
  ].filter(Boolean).join('；') || '（无实际变化）';
  if (ctx.dryRun) {
    return ctx.preview({
      affected: actions,
      summary: `把「${card.title ?? card.id}」的${changeText}`,
      details: [
        `卡：${card.title ?? '(无标题)'}（${card.id}）· kind=${card.kind ?? '?'} · 状态=${card.status}`,
        `当前：cron=\`${oldCron}\` · enabled=${oldEnabled}${schedule.nextRunAt ? ` · 下次触发 ${new Date(schedule.nextRunAt).toISOString()}` : ''}`,
        `将改为：cron=\`${nextCron || oldCron}\` · enabled=${typeof enabledRaw === 'boolean' ? enabledRaw : oldEnabled}`,
      ],
      warnings: [
        '看板的定时只有「重复 cron」一种语义 —— 本动作**不能**把某次执行挪到某个日期（没有"单次改期"）。',
        '改 cron 会按新表达式重算下次触发；停用（enabled:false）后卡会留在看板上但不再自动跑。',
      ],
      rollback: { reversible: true, how: `把 cron 改回 \`${oldCron}\`、enabled 改回 ${oldEnabled}；命令：node <workspace>\\tools\\dsh-butler\\manual-action-rollback.mjs --correlation ${ctx.correlationId}（缺省 dry-run，真回滚加 --apply，**打生产树必须显式加 --allow-production**）` },
    });
  }
  ctx.assertWithinPlanned(actions);
  await ctx.deps.board.dispatch(actions[0], `${ctx.correlationId}-1`);
  return {
    applied: actions,
    summary: `已把「${card.title ?? card.id}」的${changeText}`,
    // 结构化旧值（回滚用 · 2026-10-10）：改前 cron / enabled —— **原样记**（含「(未设置)」这种真值；
    //   回滚侧遇到它照样 fail-closed 拒绝，不会拿它去写一个假表达式）。
    rollbackData: { taskId: card.id, cron: oldCron, enabled: oldEnabled },
  };
}

/** 5 段 cron 的**粗校验**（分 时 日 月 周）；真正的合法性由看板负责（它拒绝会报错回来）。 */
export function isPlausibleCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[0-9A-Za-z*,\-/?#]+$/.test(p));
}

/**
 * ② 失败卡重试：给 `failed` 列的卡重跑一次。
 * token 预估（方案 §4 P1 细则②）：执行前读**上次执行**的 usage → 估 ¥
 *   · > ¥5  → **拒绝**，建议人工开会话
 *   · > ¥1  → 需要**强确认**（params.ackCost === true 才放行）
 * 估不出来时：按"未知 = 可能很贵"处理 —— 需要强确认（不拒绝，因为无据拒会挡住正常重试）。
 */
async function execCardRetry(ctx) {
  const taskId = String(ctx.params?.taskId ?? '').trim();
  if (!taskId) return ctx.reject('missing-taskId', '缺少 taskId：重试必须指定一张卡。');
  const state = await ctx.deps.board.getState();
  const card = findCard(state, taskId);
  if (!card) return ctx.reject('card-not-found', '这张卡不在看板（可能已被归档或删除）：请刷新后重试。');
  if (card.status !== 'failed') {
    return ctx.reject('card-not-failed', `「${card.title ?? taskId}」当前状态是 ${card.status}（不是 failed），重试不适用。`);
  }
  const execs = Array.isArray(card.executions) ? card.executions : [];
  const lastFailed = [...execs].reverse().find((e) => e && e.result === 'failed') ?? [...execs].reverse()[0] ?? null;

  // ── token 预估（只读）──
  let cost = null;
  if (lastFailed?.sessionId) {
    const u = readSessionUsage(lastFailed.sessionId, { home: ctx.deps.home });
    if (u.ok) cost = { ...estimateUsageCost(u.usage, u.model), sessionId: lastFailed.sessionId, tokens: u.usage, basis: '上次执行的真实 usage（会话日志）' };
    else cost = { cny: null, usd: null, unknown: true, reason: u.reason, sessionId: lastFailed.sessionId, basis: '估不出来（会话日志缺失/无 usage）' };
  } else {
    cost = { cny: null, usd: null, unknown: true, reason: 'no-session-id', basis: '估不出来（该卡上次执行没有会话 id）' };
  }
  const costCny = Number.isFinite(cost.cny) ? cost.cny : null;
  const costLine = costCny === null
    ? `成本估不出来（${cost.reason}）—— 保守起见需要你确认后才跑`
    : `预计消耗约 ${cny(costCny)}${cost.unknown ? '' : ''}（模型 ${cost.model}，${cost.basis}）`;
  const failReason = typeof lastFailed?.error === 'string' && lastFailed.error.trim() ? lastFailed.error.trim().slice(0, 200) : '（无错误摘要）';
  // `rerun`（而非方案字面的 `run`）：实测 `dsh-task-board-local/src/host-ledger.ts` L809-818 —— 两者都收敛到
  // 同一个"建会话"入口，差别只在状态基：`rerun` 先把卡置回 `todo` 再跑，`run` 保持原状态。
  // failed 卡要的正是"重跑一次" ⇒ 取 `rerun`（同一条 else 分支，风险相同）。两者都硬拒 running / 有未收尾执行的卡。
  const actions = [{ kind: 'rerun', targetKey: `card:${card.id}`, taskId: card.id }];

  // ── 成本门（判据 = judgeRetryCost 纯函数；预览与执行共用，避免"预览说能跑、执行被拒"的分裂）──
  const verdict = judgeRetryCost(costCny, ctx.params?.ackCost);
  // 超限：预览与执行都拒（预览就要拦住，不能等确认）；需确认：只有**执行**才拒（预览要照常展示"需要确认"）。
  if (verdict.code === 'cost-over-limit' || (!ctx.dryRun && verdict.code === 'cost-needs-confirm')) {
    return ctx.reject(verdict.code, `「${card.title ?? taskId}」${verdict.message}`, { cost, needConfirm: verdict.needConfirm === true });
  }
  const needConfirm = verdict.needConfirm === true;

  if (ctx.dryRun) {
    return ctx.preview({
      affected: actions,
      summary: `重新运行「${card.title ?? card.id}」`,
      details: [
        `卡：${card.title ?? '(无标题)'}（${card.id}）· 已失败 ${execs.filter((e) => e?.result === 'failed').length} 次`,
        `上次失败于 ${lastFailed?.endedAt ? new Date(lastFailed.endedAt).toISOString() : '(未知时间)'}：${failReason}`,
        costLine,
        needConfirm ? `⚠️ 超过强确认阈值（${cny(COST_STRONG_CONFIRM_CNY)}）：确认时须带 ackCost: true` : '成本在强确认阈值以内',
      ],
      warnings: [
        '重试会**新建一次执行**（会开真会话、烧 token）；原执行记录不会删除。',
        `超过 ${cny(COST_REFUSE_CNY)} 的卡本入口直接拒绝（建议人工开会话）。`,
      ].filter(Boolean),
      cost,
      needsAck: needConfirm,
      rollback: { reversible: false, how: '重试本身不可回滚（会话已经跑起来了）；不满意就等它跑完按正常流程 reject 收尾。' },
    });
  }
  ctx.assertWithinPlanned(actions);
  await ctx.deps.board.dispatch(actions[0], `${ctx.correlationId}-1`);
  return { applied: actions, summary: `已重新运行「${card.title ?? card.id}」（${costLine}）` };
}

/**
 * ③ 升级项 L0 预检：跑只读符号审计（`tools\dsh-upgrade-audit.mjs`），把报告落
 * `docs\升级预检报告-<date>.md`。全程只读（tarball 采样到盘外 canary 目录，不动生产 profile）。
 */
async function execUpgradePrecheck(ctx) {
  const pending = await ctx.deps.upgradeInputs.pendingUpgrades();
  if (!pending.ok) {
    return ctx.reject('upgrades-cache-unavailable',
      `读不到升级体检数据：${pending.error ?? '未知原因'}（数据源 = 生态面板 /api/dsh-ecosystem-panel/state 的 upgrades 组）。先确认生态面板在跑，再重试。`);
  }
  const requested = Array.isArray(ctx.params?.packages) && ctx.params.packages.length
    ? ctx.params.packages.map((x) => String(x))
    : pending.items.map((x) => x.name);
  if (requested.length === 0) {
    return ctx.reject('no-pending-upgrades', '生态面板缓存里没有 🟡/🔴 升级项（升级体检全绿）：没有什么可预检的。');
  }
  const reportFile = path.join(ctx.deps.docsDir, `升级预检报告-${localDayKey(ctx.now())}.md`);
  const actions = [{
    kind: 'upgrade-precheck',
    targetKey: `upgrades:${localDayKey(ctx.now())}`,
    packages: requested,
    reportFile,
  }];
  if (ctx.dryRun) {
    return ctx.preview({
      affected: actions,
      summary: `对 ${requested.length} 个待升级包跑只读 L0 符号审计`,
      details: [
        `待预检：${requested.map((p) => {
          const it = pending.items.find((x) => x.name === p);
          return it ? `${p}（${it.local} → ${it.latest}${it.status === 'red' ? ' · 🔴' : ' · 🟡'}）` : p;
        }).join('、')}`,
        `样本来源：${ctx.deps.upgradeInputs.tarballsDir}（旧样本可复用；缺样本的包按"证据缺口"如实标注）`,
        `报告落点：${reportFile}`,
      ],
      warnings: [
        '全程只读：不装包、不改 profile、不碰生产插件实体，只在盘外 canary 目录采样。',
        '无 tarball 样本时审计会给"证据缺口"结论（那是**判不了**，不等于没问题）。',
      ],
      rollback: { reversible: true, how: `删掉报告文件 ${reportFile} —— node <workspace>\\tools\\dsh-butler\\manual-action-rollback.mjs --correlation ${ctx.correlationId}（缺省 dry-run，真回滚加 --apply，**打生产树必须显式加 --allow-production**）` },
    });
  }
  ctx.assertWithinPlanned(actions);
  const r = await ctx.deps.upgradeInputs.runAudit({ packages: requested });
  const md = ctx.deps.upgradeInputs.renderReport({ report: r, packages: requested, at: ctx.now(), pending: pending.items });
  ensureDir(path.dirname(reportFile));
  fs.writeFileSync(reportFile, md, 'utf8');
  const bytes = Buffer.byteLength(md, 'utf8');
  return {
    applied: actions,
    summary: `L0 预检完成：${r.ok ? `断裂符号命中 ${Object.keys(r.brokenByPackage ?? {}).length} 个包` : `审计未完成（${r.reason}）`}`,
    outputs: [{ file: reportFile, bytes }],
    auditResult: r.ok ? 'ok' : 'partial',
    // 结构化旧值（回滚用 · 2026-10-10）：本动作"反向所需的旧值"= 报告文件路径 + 字节数
    //   —— 与 `outputs[{file,bytes}]` 同源（不是第二份判据）；回滚侧 outputs 读不到时拿它兜底。
    rollbackData: { reportFile, bytes },
  };
}

/**
 * ④ 中断会话转卡（**已有功能，纳入统一注册表保持一致**）。
 * 与既有 `POST /api/dsh-butler/card` 行为一致：同 sessionId 已有在途卡 → 拒绝（不重复建卡）。
 */
async function execSessionToCard(ctx) {
  const sessionId = String(ctx.params?.sessionId ?? '').trim();
  if (!sessionId) return ctx.reject('missing-sessionId', '缺少 sessionId：转卡必须指定一个会话。');
  const state = await ctx.deps.board.getState();
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const INFLIGHT = ['backlog', 'todo', 'running', 'review'];
  const dup = tasks.filter((t) => t && !t.archivedAt && INFLIGHT.includes(t.status)
    && typeof t.description === 'string' && t.description.includes(sessionId));
  if (dup.length > 0) {
    return ctx.reject('duplicate-inflight',
      `该会话已有在途卡「${dup[0].title ?? dup[0].id}」（${dup[0].status}）：不重复建卡。`,
      { cards: dup.map((t) => ({ id: t.id, title: t.title, status: t.status })) });
  }
  const meta = ctx.deps.sessionMeta ? await ctx.deps.sessionMeta(sessionId) : { sessionId, title: '', group: '?', lastActiveLabel: '' };
  const cardTitle = meta.title && String(meta.title).trim()
    ? `[续] ${String(meta.title).trim().slice(0, 40)}`
    : `会话 ${sessionId.slice(0, 8)} 续做`;
  const desc = `大管家一键转卡：疑似中断会话 ${sessionId}（工作区 ${meta.group ?? '?'}${meta.lastActiveLabel ? '，最后活动 ' + meta.lastActiveLabel : ''}）。`
    + (meta.title ? `会话标题：${meta.title}。` : '');
  const prompt = `来自大管家「疑似中断会话」转卡。目标：接续会话 ${sessionId}（在 DSH 侧边栏会话列表可搜到该 id，工作区 ${meta.group ?? '?'}）并把它遗留的工作推进/收尾。若 GUI 中该会话已无法打开，按卡片 description 的人工信息尽力续做并说明。完成标准：遗留任务处理完毕（做完或明确结论），结算时写清做了什么、是否需主人确认。`;
  const ws = tasks.find((t) => t?.workspaceId)?.workspaceId ?? ctx.deps.fallbackWorkspaceId ?? '';
  const cardId = ctx.deps.newId();
  const actions = [{
    kind: 'create',
    targetKey: `session:${sessionId}`,
    id: cardId,
    input: { title: cardTitle, description: desc, prompt, workspaceId: ws, permission: 'workspace-write' },
  }];
  if (ctx.dryRun) {
    return ctx.preview({
      affected: actions,
      summary: `把会话 ${sessionId.slice(0, 8)} 转成一张看板待办卡`,
      details: [
        `标题：${cardTitle}`,
        `工作区：${ws || '(未知 · 看板会拒绝)'}`,
        `卡 id：${cardId}`,
      ],
      warnings: ['转卡会建一张待办卡（真会话执行时才烧 token）；同会话已有在途卡时会被拒绝。'],
      rollback: { reversible: true, how: `把这张卡删掉/归档（卡 id ${cardId}）—— node <workspace>\\tools\\dsh-butler\\manual-action-rollback.mjs --correlation ${ctx.correlationId}（缺省 dry-run，真回滚加 --apply，**打生产树必须显式加 --allow-production**；缺省按 archive 收尾）` },
    });
  }
  ctx.assertWithinPlanned(actions);
  const r = await ctx.deps.board.dispatch({
    kind: 'create', id: cardId,
    input: { title: cardTitle, description: desc, prompt, workspaceId: ws, permission: 'workspace-write' },
  }, `${ctx.correlationId}-1`);
  // ── 回读**真实**卡 id（2026-10-10 卡「冲刺600·D域配套」）──
  //   预览阶段那个 `cardId` 是随机 uuid（每次调用 newId 都不同）⇒ **绝不能**当回滚依据写进审计。
  //   真执行这里发出的 `id` 才是看板实际建的卡；为稳妥**再回读一次看板确认**（只读）。
  //   回读不到/读失败 ⇒ 如实回落成"发出的那个 id"并记 readBack 状态（建卡已成功，不因此整条动作失败）。
  let realCardId = cardId;
  let readBack = 'ok';
  try {
    const after = await ctx.deps.board.getState();
    const hit = (Array.isArray(after?.tasks) ? after.tasks : []).find((t) => t && t.id === cardId);
    if (hit) realCardId = hit.id; else readBack = 'not-found-fallback';
  } catch (e) { readBack = `readback-failed:${e?.message ?? e}`; }
  return {
    applied: actions,
    summary: `已建卡「${cardTitle}」`,
    result: { cardId, revision: r?.revision ?? null },
    // 结构化旧值（回滚用 · 2026-10-10）：卡 id = **回读确认过的真值**（readBack 如实标状态）
    rollbackData: { sessionId, cardId: realCardId, readBack },
  };
}

// ─────────────────── P4「坑升级候选」采纳 / 忽略（2026-10-09 · 卡「冲刺600·批4-1」）───────────────────
// 面板「🐋 管家」Tab「坑升级候选」段两个按钮的服务端实现（前端只渲染服务端算完的结果）。
//
// 【写入口复用（硬要求）】真写一律走既有 CLI `tools\dsh-butler\mark-p4-adopted.mjs`
//   （RMW 锁 + 原子写 + 幂等 + 可回滚报告）——本模块**不另写一套写库逻辑**。
//   缺 `--apply` 的 CLI 调用本身就是 dry-run ⇒ 预览路径零副作用。
//
// 【硬红线】只改候选池状态（status/decision/decidedAt/decidedBy）；
//   **绝不自动改 persona / 技能**（A 层保护区，只能人工过 P5 门）。
//   ⚠️ 语义说清：「采纳」= 标记这条候选已被主人决策采纳，**不等于自动落地** ——
//   真正的落地（做检查项 / 内联技能 / 焊 persona）仍由人另走各自流程。
//   因此本动作属于「登记决策」，不是「执行修改」。
//
// 【幂等】已是目标状态 ⇒ CLI 按幂等跳过（不写盘、不产生报告）——重复点两次按钮是安全的。
/** decision 白名单（与 CLI `DECISIONS` 同域；`--reject` 缺省 not-pitfall）。 */
const P4_DECISIONS = Object.freeze(['landed', 'obsolete', 'not-pitfall']);
/** 候选池写入器（既有 CLI）绝对路径 —— 与大管家组件同根。 */
const P4_CLI_PATH = path.join(COMPONENT_ROOT, 'mark-p4-adopted.mjs');

/** 单行裁剪（面板文案用）。 */
function clip(s, n) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

/** 候选池依赖：`readPool()` 只读；`run(args)` 真调 CLI。单测可整体注入假实现（沙箱 home + 沙箱池）。 */
function makeP4CandidatesCli(homeOverride) {
  const home = homeOverride ?? dshHome();
  const file = resolveStatePath('butler-p4-candidates.json', { home }).path;
  return {
    file,
    async readPool() {
      try {
        if (!fs.existsSync(file)) return { ok: false, reason: `候选池不存在（${file}）` };
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ok: true, candidates: Array.isArray(j?.candidates) ? j.candidates : [] };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    },
    run(args) {
      const r = spawnSync(process.execPath, [P4_CLI_PATH, ...args], { encoding: 'utf8', timeout: 60_000 });
      let json = null;
      try { json = JSON.parse(r.stdout ?? ''); } catch { json = null; }
      return {
        rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
        json, error: r.error ? String(r.error.message ?? r.error) : null,
      };
    },
  };
}

/** 采纳 / 忽略的**同一实现**（`mode` 决定方向；单一 exec 由 `ctx.dryRun` 决定预览还是真做）。 */
async function execP4CandidateDecide(ctx, mode) {
  const reject = mode === 'reject';
  const id = String(ctx.params?.candidateId ?? '').trim();
  if (!id) return ctx.reject('missing-candidate-id', '缺少 candidateId：采纳 / 忽略一次只针对一条候选（本入口没有"全量采纳"通路）。');
  const decision = String(ctx.params?.decision ?? (reject ? 'not-pitfall' : 'landed'));
  if (!P4_DECISIONS.includes(decision)) {
    return ctx.reject('bad-decision', `decision 非法：${decision}（允许 ${P4_DECISIONS.join(' / ')}）。`);
  }
  const cli = ctx.deps.p4Candidates;
  const pool = await cli.readPool();
  if (!pool.ok) return ctx.reject('candidate-pool-unreadable', `候选池读不到，拒动：${pool.reason}`);
  const cand = pool.candidates.find((c) => c?.id === id);
  if (!cand) {
    return ctx.reject('candidate-not-found',
      `候选 ${id} 不在候选池里（当前 ${pool.candidates.length} 条）—— 池可能刚被 P4 tick 重算过，请刷新面板再点。`);
  }

  const fromStatus = cand.status ?? 'pending';
  const toStatus = reject ? 'rejected' : 'adopted';
  const head = `${String(cand.code ?? cand.name ?? '?')}｜${clip(cand.normText ?? cand.sigKey ?? '', 70)}`;
  const args = ['--id', id, '--file', cli.file, '--json', ...(reject ? ['--reject'] : ['--decision', decision])];

  // —— 预览 / 执行前 probe：调既有 CLI 的 dry-run（零写盘）拿"将做什么"
  const pv = cli.run(args);
  if (pv.error) return ctx.reject('p4-cli-unavailable', `候选池写入器不可用：${pv.error}`);
  if (!pv.json) return ctx.reject('p4-cli-bad-output', `候选池写入器返回非 JSON（rc=${pv.rc}）：${clip(pv.stderr || pv.stdout, 160)}`);
  if (pv.json.ok === false) return ctx.reject('p4-cli-refused', `候选池写入器拒绝：${pv.json.error}`);

  // ⚠️ 动作项里**只放预览时就能确定的字段**（from/to/decision）——执行后才有的东西（报告路径、changed 数）
  //    一律不进 affected，否则预览与执行的 planHash 必然不同 ⇒ 假漂移。`input` 参与 planHash：
  //    fromStatus 变了（tick 重算过池）就会触发 drift ⇒ 正是 TOCTOU 想要的"请重新确认"。
  const actions = [{
    kind: reject ? 'p4-candidate-reject' : 'p4-candidate-adopt',
    targetKey: `p4cand:${id}`,
    candidateId: id,
    fromStatus,
    toStatus,
    decision,
    input: { id, from: fromStatus, to: toStatus, decision },
  }];
  const details = [
    `候选：${head}`,
    `状态流转：${fromStatus} → ${toStatus}（decision=${decision}）`,
    `数据：${cand.count ?? '?'} 次 / ${cand.sessionCount ?? '?'} 会话 · 建议形态 ${cand.suggested ?? '?'}`,
    fromStatus === toStatus ? '（该候选已是此状态：执行时按幂等跳过，不会重复写盘）' : '',
  ].filter(Boolean);
  // 统一入口（D 域 · 2026-10-10）：按 correlationId 从审计回溯并反向做掉本动作（缺省 dry-run）。
  const rollbackUnified = `node <workspace>\\tools\\dsh-butler\\manual-action-rollback.mjs --correlation ${ctx.correlationId}`;
  const rollbackHow = `node <workspace>\\tools\\dsh-butler\\mark-p4-adopted.mjs --rollback "<执行后返回的报告路径>" --apply（该 CLI 自 2026-10-10 起**缺省即 dry-run**，真回滚必须显式 --apply；也可用统一入口：${rollbackUnified} —— 缺省 dry-run，真回滚加 --apply，**打生产树必须显式加 --allow-production**）`;
  const summary = reject
    ? `忽略候选「${head}」（只标记不采纳；**不改任何技能 / persona**）`
    : `采纳候选「${head}」（**只登记决策；落不落地仍需人工**，本动作不碰 persona / 技能）`;

  if (ctx.dryRun) return ctx.preview({ affected: actions, summary, details, rollback: { reversible: true, how: rollbackHow } });

  // —— 真执行：子集断言 → CLI 带 --apply
  ctx.assertWithinPlanned(actions);
  // 报告路径显式给（可回滚依据 + 归档到 _archive；测试可注入沙箱目录 ⇒ 不污染生产归档）
  const reportFile = path.join(ctx.deps.p4ArchiveDir, `${reject ? 'reject' : 'adopt'}-${id}-${ctx.correlationId}.json`);
  const ex = cli.run([...args, '--report', reportFile, '--apply']);
  if (ex.error) throw new Error(`候选池写入器不可用：${ex.error}`);
  if (!ex.json) throw new Error(`候选池写入器返回非 JSON（rc=${ex.rc}）：${clip(ex.stderr || ex.stdout, 160)}`);
  if (ex.json.ok === false) throw new Error(`候选池写入失败：${ex.json.error}`);
  const changed = Array.isArray(ex.json.changed) ? ex.json.changed : [];
  const report = ex.json.report ?? null;
  return {
    applied: actions,
    summary: changed.length
      ? `${reject ? '已忽略' : '已采纳'}「${head}」（${fromStatus} → ${toStatus}）`
      : `「${head}」已是 ${toStatus}：本次幂等跳过，未改盘`,
    details,
    rollback: { reversible: true, how: report ? `node <workspace>\\tools\\dsh-butler\\mark-p4-adopted.mjs --rollback "${report}" --apply（缺省 dry-run，真回滚必须加 --apply；也可用统一入口：${rollbackUnified} —— 缺省 dry-run，真回滚加 --apply，**打生产树必须显式加 --allow-production**）` : rollbackHow },
    outputs: report ? [{ kind: 'p4-decision-report', file: report }] : [],
    result: { candidateId: id, fromStatus, toStatus, decision, changed: changed.length, report },
  };
}

/**
 * 动作注册表（**唯一清单**；新增动作 = 加一行 + 补文档表 + 补单测）。
 * `level` 分级口径见方案 §3.6.3；`preRegistered` = 是否允许 scheduled-task 调用（P1 全 false）。
 */
export const MANUAL_ACTIONS = Object.freeze({
  'card-nudge': {
    id: 'card-nudge', title: '挂起卡催办', level: 'L2', maxAffected: 1, preRegistered: false,
    description: '给 3 天没动的待办/积压卡追加一条催办备注（只刷时间戳，不改状态、不打扰任何人）',
    exec: execCardNudge,
  },
  'card-reschedule': {
    id: 'card-reschedule', title: '重复定时改期', level: 'L2', maxAffected: 1, preRegistered: false,
    description: '改卡的重复 cron / 停启用（看板没有"单次改到某日"的语义）',
    exec: execCardReschedule,
  },
  'card-retry': {
    id: 'card-retry', title: '失败卡重试', level: 'L2', maxAffected: 1, preRegistered: false,
    description: '重跑 failed 列的卡（成本 >¥1 需强确认、>¥5 直接拒绝）',
    exec: execCardRetry,
  },
  'upgrade-precheck': {
    id: 'upgrade-precheck', title: '升级项 L0 预检', level: 'L1', maxAffected: 1, preRegistered: false,
    description: '对生态面板缓存里的 🟡/🔴 升级项跑只读符号审计，报告落 docs\\升级预检报告-<日期>.md',
    exec: execUpgradePrecheck,
  },
  'session-to-card': {
    id: 'session-to-card', title: '中断会话转卡', level: 'L2', maxAffected: 1, preRegistered: false,
    description: '把疑似中断的会话转成一张看板待办卡（与既有面板「转卡」按钮同行为 + 去重）',
    exec: execSessionToCard,
  },
  // —— 2026-10-09（卡「冲刺600·批4-1 面板坑升级候选段」）：面板「🐋 管家」Tab 的两个按钮 ——
  'p4-candidate-adopt': {
    id: 'p4-candidate-adopt', title: '坑升级候选采纳', level: 'L2', maxAffected: 1, preRegistered: false,
    description: '把一条 P4 升级候选标记为已采纳（写入口 = 既有 CLI mark-p4-adopted.mjs；**绝不自动改 persona / 技能**）',
    exec: (ctx) => execP4CandidateDecide(ctx, 'adopt'),
  },
  'p4-candidate-reject': {
    id: 'p4-candidate-reject', title: '坑升级候选忽略', level: 'L2', maxAffected: 1, preRegistered: false,
    description: '把一条 P4 升级候选标记为已忽略（不采纳；同样只改候选池状态，不碰 persona / 技能）',
    exec: (ctx) => execP4CandidateDecide(ctx, 'reject'),
  },
});

export const MANUAL_ACTION_IDS = Object.freeze(Object.keys(MANUAL_ACTIONS));

/**
 * L3 声明 vs 注册表实况的比对读数（gap-1-06 · 纯函数，零副作用）。
 * 单测 / registry-audit 用它把「本版无 L3 手动动作」变成可机械校验的事实。
 * @param {Record<string, {id:string, level:string}>} [registry]
 * @returns {{declared:string[], present:string[], undeclared:string[], ok:boolean, reason:string}}
 */
export function l3Declaration(registry = MANUAL_ACTIONS) {
  const present = Object.values(registry)
    .filter((a) => a && a.level === 'L3')
    .map((a) => a.id)
    .sort();
  const declared = [...L3_ACTIONS].sort();
  const undeclared = present.filter((id) => !declared.includes(id));
  const missing = declared.filter((id) => !present.includes(id));
  return {
    declared, present, undeclared,
    ok: undeclared.length === 0 && missing.length === 0,
    reason: undeclared.length
      ? `注册表有未声明的 L3 动作：${undeclared.join(', ')}`
      : (missing.length ? `L3_ACTIONS 声明了注册表里不存在的动作：${missing.join(', ')}` : '本版无 L3 手动动作（显式声明，与注册表一致）'),
  };
}

// ───────────────────────── §5 统一闸门 runManualAction ─────────────────────────
/** 漂移计数（进程内；窗口 5 分钟）。 */
const driftStreaks = new Map();
function bumpDrift(key) {
  const now = Date.now();
  const cur = driftStreaks.get(key);
  const next = cur && now - cur.at < DRIFT_WINDOW_MS ? { n: cur.n + 1, at: now } : { n: 1, at: now };
  driftStreaks.set(key, next);
  return next.n;
}
function clearDrift(key) { driftStreaks.delete(key); }
/** 单测用：清空漂移计数。 */
export function __resetDrift() { driftStreaks.clear(); }

/**
 * 统一入口。
 * @param {{
 *   actionId:string, params?:object, dryRun?:boolean, actor:string,
 *   expectedPlanHash?:string, correlationId?:string
 * }} input
 * @param {{board?:object, home?:string, now?:()=>number, newId?:()=>string, sessionMeta?:Function,
 *          docsDir?:string, upgradeInputs?:object, deps?:object, auditSilent?:boolean}} [opts]
 * @returns {Promise<object>} 结构化结果（`ok:false` 时带 `code` / `message` / `http`）
 */
export async function runManualAction(input, opts = {}) {
  const startedAt = Date.now();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const home = opts.home ?? dshHome();
  const correlationId = typeof input?.correlationId === 'string' && input.correlationId
    ? input.correlationId
    : `p1-${new Date(now()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const params = input?.params && typeof input.params === 'object' ? input.params : {};
  const actionId = typeof input?.actionId === 'string' ? input.actionId : '';
  const actor = typeof input?.actor === 'string' ? input.actor.trim() : '';
  const dryRun = input?.dryRun !== false; // ★ 默认预览

  /** 审计一行（**预览 / 执行 / 拒绝都记**；方案 §3.6.2 的 actionId 域）。 */
  const audit = (fields) => {
    try {
      appendAudit({
        component: 'butler-manual-action',
        actionId: actionId || null,
        actor: actor || null,
        params,
        dryRun,
        correlationId,
        version: MANUAL_ACTIONS_VERSION,
        ...fields,
      }, { home, silent: opts.auditSilent === true, chainAlert: opts.auditSilent !== true });
    } catch (e) {
      alert({ level: 'warn', source: 'butler-manual-action', message: `审计写入异常：${e?.message ?? e}`, detail: { actionId, correlationId } }, { home });
    }
  };
  const fail = (http, code, message, extra = {}) => {
    audit({ result: 'rejected', code, message: String(message).slice(0, 300), ...extra });
    return { ok: false, http, code, message, actionId, actor, dryRun, correlationId, ...extra };
  };

  // ── 闸门 1：actor（fail-close，方案 §3.6.3）──
  if (!actor) return fail(400, 'missing-actor', '缺少 actor 字段：一律拒绝（fail-close）。调用方必须声明自己的身份。');
  if (!ACTORS.includes(actor)) {
    return fail(400, 'unknown-actor', `未知 actor「${actor}」：允许 ${ACTORS.join(' / ')}（大管家自动动作走 lib/autonomy-actions.mjs，不经本通道）。`);
  }
  // ── 闸门 2：动作登记（`opts.actions` 仅供单测注入假动作，生产不传）──
  const registry = opts.actions ?? MANUAL_ACTIONS;
  const spec = registry[actionId];
  if (!spec) return fail(400, 'unknown-action', `未登记的动作「${actionId}」：允许 ${Object.keys(registry).join(' / ')}。`);
  // ── 闸门 3：权限矩阵 ──
  if (actor === 'subagent' && spec.level !== 'L1') {
    return fail(403, 'subagent-forbidden', `subagent 只能调 L1 动作：本动作是 ${spec.level}（可回滚/涉意图）⇒ 拒绝。`);
  }
  if (actor === 'scheduled-task' && spec.preRegistered !== true) {
    return fail(403, 'scheduled-not-preregistered', `scheduled-task 只能跑预登记动作：本动作未预登记（需要人判断）⇒ 拒绝。`);
  }
  // ── 闸门 3.5：L3 显式声明（gap-1-06 · 2026-10-10）──
  //    方案 §3.6.3 的 L3 = 涉意图 / 难撤销（只有 owner-panel / main-session 可调用，且需确认）。
  //    本版声明「无 L3 手动动作」（L3_ACTIONS = []）⇒ 任何 L3 动作都必须先显式登记 + 写明 l3Why，
  //    否则视为**未声明**，fail-close 拒绝（防将来有人顺手加个 L3 却绕过矩阵）。
  //    `opts.l3Declared` 仅供单测注入声明清单（生产不传）—— 与 `opts.actions` 同款注入面。
  const l3Declared = Array.isArray(opts.l3Declared) ? opts.l3Declared : L3_ACTIONS;
  if (spec.level === 'L3'
    && !(l3Declared.includes(spec.id) && typeof spec.l3Why === 'string' && spec.l3Why.trim())) {
    return fail(403, 'l3-not-declared', `L3 动作「${spec.id}」未显式声明：L3 = 涉意图/难撤销，必须先登记进 L3_ACTIONS 并写明 l3Why（理由）⇒ 拒绝。`);
  }

  const deps = { ...(opts.deps ?? {}), home, now, correlationId };
  deps.board = opts.board ?? deps.board ?? makeBoardClient();
  deps.newId = opts.newId ?? deps.newId ?? (() => cryptoRandomId());
  deps.sessionMeta = opts.sessionMeta ?? deps.sessionMeta ?? null;
  deps.docsDir = opts.docsDir ?? deps.docsDir ?? defaultDocsDir();
  deps.upgradeInputs = opts.upgradeInputs ?? deps.upgradeInputs ?? (await loadUpgradeInputs());
  // P4「坑升级候选」采纳 / 忽略的写入口依赖（2026-10-09 卡「冲刺600·批4-1」）——单测可注入假实现。
  //   ⚠️ 必须把**已解析的 home** 传进去（而不是让依赖自己再读一次 env）：单测的沙箱 home 才能生效，
  //      否则测试会真去读/写生产候选池（隔离失效）。
  deps.p4Candidates = opts.p4Candidates ?? deps.p4Candidates ?? makeP4CandidatesCli(home);
  // 决策报告（可回滚依据）落 `<workspace>\_archive\p4-candidate-decisions\`；测试注入沙箱目录。
  deps.p4ArchiveDir = opts.p4ArchiveDir ?? deps.p4ArchiveDir ?? path.resolve(defaultDocsDir(), '..', '_archive', 'p4-candidate-decisions');

  let plannedActions = null;
  const makeCtx = (isDry) => ({
    params, dryRun: isDry, deps, now, correlationId, actionId, actor,
    /** 预览返回：动作集 + 文案 + 附加信息。 */
    preview: (p) => ({ kind: 'preview', ...p, affected: Array.isArray(p.affected) ? p.affected : [] }),
    /** 结构化拒绝（不抛）。 */
    reject: (code, message, extra = {}) => ({ kind: 'reject', code, message, ...extra }),
    /** 执行前子集断言：本次动作集必须 ⊆ 预览集（超集 ⇒ 抛错中止，见 assertSubset）。 */
    assertWithinPlanned: (actions) => assertSubset(plannedActions, actions),
  });

  try {
    // ── 预览路径 ──
    if (dryRun) {
      const out = await spec.exec(makeCtx(true));
      if (out?.kind === 'reject') {
        return fail(200, out.code, out.message, { preview: null, level: spec.level, ...pickExtra(out) });
      }
      const affected = out.affected ?? [];
      if (affected.length > spec.maxAffected) {
        return fail(200, 'over-max-affected',
          `本动作一次最多影响 ${spec.maxAffected} 项，本次算出 ${affected.length} 项：请分批（本入口没有强制放行通路）。`,
          { affectedCount: affected.length, maxAffected: spec.maxAffected });
      }
      const planHash = planDigest(affected);
      audit({ result: 'preview', planHash, affectedCount: affected.length, maxAffected: spec.maxAffected, rollbackScript: out.rollback?.how ?? null });
      return {
        ok: true, http: 200, dryRun: true, actionId, actor, correlationId, level: spec.level,
        title: spec.title, planHash, affectedCount: affected.length, maxAffected: spec.maxAffected,
        summary: out.summary ?? '', details: out.details ?? [], warnings: out.warnings ?? [],
        affected, cost: out.cost ?? null, rollback: out.rollback ?? null,
        // `needsAck` = 前端执行时必须补 `ackCost:true`（成本超过强确认阈值）；判据在动作里算，前端照抄即可。
        needsAck: out.needsAck === true,
        expectedPlanHashRequired: true,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // ── 执行路径：必须先有预览回执（expectedPlanHash）──
    const expected = typeof input?.expectedPlanHash === 'string' ? input.expectedPlanHash.trim() : '';
    if (!expected) {
      return fail(400, 'missing-plan-hash',
        '执行缺 expectedPlanHash：必须先 dryRun 预览、把回执里的 planHash 一起带回来（本入口不接受"盲执行"）。');
    }
    // 执行前重算一次计划（**同一 exec**），用于子集断言与漂移检测
    const probe = await spec.exec(makeCtx(true));
    if (probe?.kind === 'reject') return fail(200, probe.code, probe.message, { level: spec.level, ...pickExtra(probe) });
    plannedActions = probe.affected ?? [];
    const freshHash = planDigest(plannedActions);
    const driftKey = `${actor}|${actionId}|${paramsDigest(params)}`;
    if (freshHash !== expected) {
      const streak = bumpDrift(driftKey);
      audit({ result: 'drift', planHash: freshHash, expectedPlanHash: expected, streak, affectedCount: plannedActions.length });
      if (streak >= DRIFT_MAX_STREAK) {
        clearDrift(driftKey);
        return fail(409, 'drift-too-frequent',
          `目标状态反复变化（连续 ${streak} 次预览与实际不一致）：建议稍后再试。`,
          { drift: true, planHash: freshHash, affectedCount: plannedActions.length });
      }
      return {
        ok: false, http: 409, code: 'drift', drift: true, actionId, actor, correlationId,
        message: '目标状态已变化，请重新确认（下面是新的预览）。',
        planHash: freshHash, affectedCount: plannedActions.length, maxAffected: spec.maxAffected,
        summary: probe.summary ?? '', details: probe.details ?? [], warnings: probe.warnings ?? [],
        affected: plannedActions, cost: probe.cost ?? null, rollback: probe.rollback ?? null,
        needsAck: probe.needsAck === true,
        driftStreak: streak, dryRun: true, level: spec.level, title: spec.title,
      };
    }
    if (plannedActions.length > spec.maxAffected) {
      return fail(200, 'over-max-affected',
        `本动作一次最多影响 ${spec.maxAffected} 项，本次 ${plannedActions.length} 项：请分批。`,
        { affectedCount: plannedActions.length, maxAffected: spec.maxAffected });
    }
    // ── 真执行 ──
    const out = await spec.exec(makeCtx(false));
    if (out?.kind === 'reject') {
      return fail(out.http ?? 409, out.code, out.message, { level: spec.level, ...pickExtra(out) });
    }
    clearDrift(driftKey);
    const applied = out.applied ?? [];
    audit({
      result: out.auditResult ?? 'ok', planHash: freshHash, affectedCount: applied.length,
      applied: applied.map(actionKey), outputs: out.outputs ?? null,
      // 【2026-10-10 · 卡「冲刺600·D域配套」】真执行额外落**结构化旧值** `rollbackData`
      //   —— 回滚脚本（manual-action-rollback.mjs）优先读它、读不到才回落解析 `rollbackScript` 文案。
      //   口径：**只加字段**（既有字段/语义一字未动）；旧审计行没有该字段 ⇒ 照走文案兜底，保持可用。
      //   值为 null = 该动作自报"没有结构化旧值"（回滚侧必须回落文案路径）。
      rollbackData: rollbackDataOf(out),
      rollbackScript: probe.rollback?.how ?? null, message: String(out.summary ?? '').slice(0, 300),
    });
    return {
      ok: true, http: 200, dryRun: false, actionId, actor, correlationId, level: spec.level, title: spec.title,
      planHash: freshHash, affectedCount: applied.length, maxAffected: spec.maxAffected,
      summary: out.summary ?? '', applied: applied.map(actionKey),
      outputs: out.outputs ?? null, result: out.result ?? null,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (e) {
    const code = e?.code === 'action-set-exceeds-preview' ? 'action-set-exceeds-preview' : 'runtime-error';
    audit({ result: 'failed', code, message: String(e?.message ?? e).slice(0, 300) });
    alert({ level: 'warn', source: 'butler-manual-action', message: `动作执行异常（${actionId}）：${e?.message ?? e}`, detail: { correlationId, actor } }, { home });
    return { ok: false, http: code === 'action-set-exceeds-preview' ? 500 : 500, code, message: String(e?.message ?? e), actionId, actor, dryRun, correlationId };
  }
}

function pickExtra(out) {
  const extra = {};
  if (out?.cost) extra.cost = out.cost;
  if (out?.cards) extra.cards = out.cards;
  if (out?.needConfirm) extra.needConfirm = true;
  return extra;
}

/**
 * 取动作给出的**结构化旧值**（回滚依据 · 2026-10-10 卡「冲刺600·D域配套」）。
 * 只认 plain object；缺省/数组/非对象一律视为"没有"⇒ null（**绝不把脏形态写进审计**）。
 * 审计行只在**真执行**（dryRun=false）时带本字段；预览行不带（与既有行为一致）。
 * @param {{rollbackData?:unknown}} out 动作 exec() 的返回值
 */
export function rollbackDataOf(out) {
  const d = out?.rollbackData;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  return d;
}

function cryptoRandomId() {
  // 看板卡的 id 惯例是 uuid（面板既有实现用 randomUUID）；不用自造短 id，避免与账本校验口径打架。
  return randomUUID();
}

/** DSH 根下的 docs 目录（可用 DSH_BUTLER_DSH_ROOT 覆盖；缺省按组件根上溯一级 = <workspace>\docs）。 */
export function defaultDocsDir() {
  const root = process.env.DSH_BUTLER_DSH_ROOT;
  if (root && root.trim()) return path.join(root.trim(), 'docs');
  // lib/manual-actions.mjs → 组件根（<workspace>\tools\dsh-butler）→ 上两级 = <workspace> → docs
  return path.resolve(COMPONENT_ROOT, '..', '..', 'docs');
}

/**
 * 升级预检依赖（**动态 import**：`tools\lib\upgrade-inputs.mjs` 在 dsh-butler 之外，
 * 静态 import 会踩 ESM 绝对路径坑；取不到时返回"不可用"依赖，动作会给出证据缺口的拒绝）。
 */
async function loadUpgradeInputs() {
  const toolsLib = path.resolve(defaultDocsDir(), '..', 'tools', 'lib', 'upgrade-inputs.mjs');
  const fallback = {
    available: false,
    tarballsDir: process.env.DSH_L0_TARBALLS || DEFAULT_TARBALLS_DIR,
    async pendingUpgrades() { return { ok: false, items: [], error: 'upgrade-inputs 不可用' }; },
    async runAudit() { return { ok: false, reason: 'upgrade-inputs 不可用（tools\\lib\\upgrade-inputs.mjs 缺失）' }; },
    renderReport() { return '# 升级预检报告（依赖不可用）\n\n未取到 tools\\lib\\upgrade-inputs.mjs，本次未执行任何审计。\n'; },
  };
  let mod = null;
  try { mod = await import(pathToFileURL(toolsLib).href); } catch { return fallback; }
  const collectAudit = mod?.collectAudit;
  if (typeof collectAudit !== 'function') return fallback;
  return {
    available: true,
    tarballsDir: process.env.DSH_L0_TARBALLS || DEFAULT_TARBALLS_DIR,
    /** 读生态面板的升级体检结果（🟡/🔴 项）—— 只读、缓存命中、不触发 npm。 */
    async pendingUpgrades() {
      // ⚠️ 2026-09-28 实测：`~/.dsh/ecosystem-panel-upgrade-cache.json` **只有 name→version 映射**
      //    （顶层 at / latest / highest），**没有** local/status 判定 ⇒ 读它判不出 🟡/🔴。
      //    唯一可用的判定源 = 生态面板 `/api/dsh-ecosystem-panel/state` 的 `groups.upgrades`
      //    （与面板 lib/state.js 的 collectUpgradeHealth 同源 —— 不另造第二份判据）。
      const base = (process.env.DSH_BUTLER_BOARD_URL || BOARD_BASE_DEFAULT).replace(/\/+$/, '');
      try {
        const res = await fetch(`${base}/api/dsh-ecosystem-panel/state`, {
          headers: { origin: base, 'sec-fetch-site': 'same-origin' }, cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const items = (j?.groups?.upgrades ?? [])
          .filter((x) => x && x.status !== 'green')
          .map((x) => ({ name: x.name, status: x.status, local: x.local ?? '', latest: x.latest ?? '', label: x.verdictLabel ?? '' }));
        return { ok: true, items, cacheAt: j?.upgradesMeta?.cacheAt ?? null, fetchedAt: j?.upgradesMeta?.fetchedAt ?? null };
      } catch (e) {
        return { ok: false, items: [], error: `生态面板不可达：${e?.message ?? e}` };
      }
    },
    async runAudit() { return collectAudit({ tarballs: process.env.DSH_L0_TARBALLS || DEFAULT_TARBALLS_DIR }); },
    renderReport({ report, packages, at, pending }) {
      const L = [];
      L.push(`# 升级预检报告（L0 符号审计 · ${localDayKey(at)}）`);
      L.push('');
      L.push('> 由大管家 P1「升级项 L0 预检」动作生成（只读；**不改任何生产插件实体**）。');
      L.push(`> 生成时间：${new Date(at).toISOString()} · 动作版本：${MANUAL_ACTIONS_VERSION}`);
      L.push(`> 样本目录：\`${process.env.DSH_L0_TARBALLS || DEFAULT_TARBALLS_DIR}\``);
      L.push('');
      L.push('## 一、本次预检的包');
      L.push('');
      L.push('| 包 | 本地版本 | npm 最新 | 体检结论 |');
      L.push('|---|---|---|---|');
      for (const p of packages) {
        const it = (pending ?? []).find((x) => x.name === p) ?? {};
        L.push(`| \`${p}\` | ${it.local ?? '?'} | ${it.latest ?? '?'} | ${it.status === 'red' ? '🔴' : it.status === 'yellow' ? '🟡' : '（未知/无缓存）'} |`);
      }
      L.push('');
      L.push('## 二、L0 审计结论');
      L.push('');
      if (!report?.ok) {
        L.push(`- ⚠️ **证据缺口（判不了，不等于没问题）**：${report?.reason ?? '未知原因'}`);
      } else {
        const broken = report.brokenByPackage ?? {};
        const names = Object.keys(broken);
        L.push(`- 审计脚本退出码：${report.exitCode ?? '?'} · 报告源：\`${report.report}\``);
        if (names.length === 0) L.push('- ✅ 未检出 🔴 断裂符号（本次样本范围内）');
        else {
          L.push(`- 🔴 断裂命中 **${names.length}** 个包：`);
          L.push('');
          L.push('| 包 | 命中说明 |');
          L.push('|---|---|');
          for (const n of names) L.push(`| \`${n}\` | ${broken[n].join(' / ').slice(0, 400)} |`);
        }
        if ((report.globalNotes ?? []).length) {
          L.push('');
          L.push('**其它 🔴 行（全局）**：');
          for (const g of report.globalNotes.slice(0, 20)) L.push(`- ${g}`);
        }
      }
      L.push('');
      L.push('## 三、怎么读这份报告');
      L.push('');
      L.push('- 🔴 断裂 = 目标版少了一个本地代码 import 的符号 ⇒ 升级后该插件**起不来**（升级前必须先出方案）。');
      L.push('- 证据缺口 = 没有目标版 tarball 样本 ⇒ **判不了**；缺样本时任何"看起来没问题"都不成立。');
      L.push('- 本报告只覆盖**符号面**；决策表禁升区 / 魔改补丁 / 词表差异另有专门闸门（见 `docs\\升级分级授权-生效口径-20260915.md`）。');
      L.push('');
      return L.join('\n');
    },
  };
}

/** 供单测/CLI 用：把动作清单渲染成一行行说明。 */
export function describeManualActions() {
  return MANUAL_ACTION_IDS.map((id) => {
    const s = MANUAL_ACTIONS[id];
    return { id, title: s.title, level: s.level, maxAffected: s.maxAffected, preRegistered: s.preRegistered, description: s.description };
  });
}

export { dshHome, appendAudit };
