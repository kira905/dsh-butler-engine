// dsh-butler / lib/ctx-guard.mjs —— 「上下文看门」动作（L2 模块 `ctx-guard` 的执行体）
//
// 由来（主人 2026-09-16 提出）：单一会话上下文超过约 500K 之后模型明显变傻（思考打转、出错率上升）。
//   本机 deepseek 路由 contextWindow = 1,000,000，而 `compaction-basic` 的自动压缩阈值 = 0.8×窗口
//   = **800K 才压缩**，远在「变傻」之后 → 需要一层**软限提醒**：到阈值时主动叫正在干活的 agent
//   把工作移交到新会话（落卡/落文档 → 提示主人开新会话续做）。
//
// 【动作语义（与 queue-wake 刻意相反，见下）】
//   每 **2 分钟**扫一遍全部会话 → 对 `running === true` 且**投影用量**超过软限的会话投递一条
//   「该移交了」的提醒；越过硬限再催一次（措辞更强：明确「下一步不要开新活，先把活交出去」）。
//   ⚠️ **周期订正（2026-09-24 · 卡「夜批03」顺手项 S-2）**：本文件头部原写「每 5 分钟」= 过期注释；
//      现行 tick = **2 分钟**（`butler-tickd.mjs` 的 JOBS 条目 `{ id:'ctx-guard', intervalMs: 2*MIN }`；
//      2026-09-22 由 5 分钟收紧，见 `docs\交付报告-接力轴保留与超限周期收紧-20260922.md`）。
//   **投递通道分两档（2026-09-24 · 卡「夜批03 · 投递分级实现」）**：
//     · 软限 = `queue`：排队等当前回合结束后由 agent 读到，**不打断** —— 与交付前逐字节等价；
//     · 硬限 = **可 steer**：`session.prompt { mode:'steer' }` —— **当前 step 跑完时插话**，
//       **不 abort 进行中的工具**（真机实测 `docs\交付报告-夜批02-投递分级真机实测-20260923.md` §2.2）；
//       但**默认关**（开关 = `butler-autonomy-limits.json` 的 `ctxGuard.steer.enabled`，未配置即关），
//       并受**危险动作豁免名单**约束（判据唯一源 = `lib\steer-gate.mjs`；卡执行会话一律不进名单）。
//
//   · queue-wake 的哲学：只叫 `running === false` 的**空闲**会话，且「目标唯一」才发（防误发）。
//   · ctx-guard 的哲学：**瞄准 `running === true` 的会话，逐个各自投递** —— 自己提醒自己，
//     不需要唯一性判据（每个超阈值的在跑会话各得一条）。故 `decide()` / `pickNotifier()` **不复用**，
//     本文件自带 `planCtxGuard()`（纯函数）。
//   · 但**去重、限额、闸门一律复用** `lib/autonomy-actions.mjs` 的 `runAction()`（唯一闸门），
//     不另造第二套口径。
//
// 【采集重试（2026-09-17 · 采集抖动收口）】tickd 每 **2 分钟** spawn 一轮（周期见动作语义段的订正注），
//   实测采集耗时 0.5~2.2s
//   （110 会话 / ~159KB payload），离 10s 超时很远；4 次失败全部发生在 **DSH 重启中 / 停摆窗口
//   刚结束 / HTTP/1.1 连接池饱和** 这类短暂不可达窗口。故在**本文件自己的采集入口**加一次有限重试
//   （默认 `retries=1` + 退避 `1500ms`，均可参数化）；**超时值不动**（仍是 10s/次）。
//   三条红线（本卡）：
//     ① **失败语义不许回退**：重试后仍失败 → 仍返回 `ok:false` + 原样文案
//        `采集失败（session.list=…）→ 本轮不规划任何投递` → `collect-failed` → exit 1 → 报警。
//        绝不改成 `ok:true` / 记 benign / 静默（那正是 2026-09-16 拷问 1.7 修掉的东西）。
//     ② **共享函数一行不改**：`readSessions()` 被 queue-wake / card-watchdog / session-ledger 复用，
//        默认行为、超时、空列表 fail-closed 全部保持原样；改动只在 ctx-guard 的采集入口。
//     ③ **不开旁路**：不引入"空列表降级""失败返回缓存"之类旁路 —— 空列表 = 不可信是既有纪律。
//
// 【数据源】`/api/session.list` → `items[].projections.values.contextPressure`（与 GUI 输入框旁的
//   上下文圆环同源）：
//     · `pressureTokens`  = 上一次请求实测的提示词规模（provider 值锚定）
//     · `projectedTokens` = **下一个请求的预计用量（判定用这个）**
//     · `contextWindow`   = 该路由容量（本机 = 1,000,000）
//   采集复用 `lib/queue-watch.mjs` 的 `readSessions()`（本卡为它补了 `contextPressure` 映射）。
//
// 🔴【数据源订正 · 2026-11-08 · 卡「运维自检-ctx-guard 数据源修复」】上面这段**只对 ≤0.2.1 成立**：
//   主包 **0.2.2-rc.1** 把 `contextPressure` 这个投影单元的 `wire.summary` 标成了 `false`
//   （源码 `dsh-token-meter/lib/types/usage-projection.js` 的 `contextPressureProjectionDefinition`），
//   而 `dsh-session-projection` 的 `summaryKeys()` 会**跳过**所有 `summary=false` 的键、
//   `dsh-api-session-controller/lib/types/list.js#projectionsFor` 只按 `summaryKeys()` 出值
//   ⇒ **`session.list` 的 `projections.values` 里从此没有 `contextPressure`**（实测 0/718）。
//   后果：本模块 `readPressure()` 全员走 `no-pressure` ⇒ **提醒彻底静默**（718/718 跳过、面板一片 ok）。
//   现行双源（`enrichContextPressure()`，见下）：
//     ① **首选仍读列表投影**（老主包 / 将来主包若把 summary 改回来，零额外开销直接命中）；
//     ② 列表没给 ⇒ 逐会话补采 `session.projections { sessionId }`
//        （服务端 `usingObservation({projection:true})` = `projectionMode:'all'`，**不受 summary 过滤**）。
//   ⚠️ 补采是**抽样**不是全量（默认 `DEFAULT_PROBE_MAX` 条：在跑的排前面、其余按 updatedAt 倒序）
//      —— 理由：`runAction` 只在 `running===true` 时投递（`includeRunningOnly`），全量 700+ 次 RPC/2min
//      纯属压宿主；而"数据源是否还活着"用 40 条样本判定足够。**未补采 ≠ 数据源坏了**，两者必须分开计：
//      未补采 → `no-pressure`（benign，不告警）；补采了但**投影键都没有** → 计 `absent`（→ `dataSourceMissing`）；
//      补采读失败（超时/报错）→ 计 `unreadable`（**不进告警分母**，慢 ≠ 坏了）；投影在但为空（新会话）→ `empty`（benign）。
//
// 【投递通道】`lib/watch-notify.mjs` 的 `notifySession`（内部即 `session.prompt` + `payload.mode`）——
//   与 queue-wake 生产在用的同一函数。**两档**（2026-09-24 · 卡「夜批03」）：
//     · 软限 → `mode:'queue'`（与交付前一致）；· 硬限 → `mode:'steer'`（**默认关 + 危险动作豁免名单**）。
//   ⚠️ 本模块（及其调用链）**绝不调用** `session/cancel` —— 那是唯一会 abort 进行中回合的通道；
//      源码级断言见 `_test\test-ctx-guard.mjs`（"不许 abort"红线）。
//
// 【闸门（fail-safe 方向更严，不是更松）】
//   · 模块级：`checkModuleAllowed('ctx-guard')` = L0 降档 × L1 `p3AutoEnabled` × L2 `modules['ctx-guard']`
//     （L2 模块登记 `baseline: false` = **默认关**）
//   · 动作级：`runAction({kind:'ctx-guard'})` 内置 p3-auto 总闸 + 24h 去重 + 单日上限 + token 预算门
//
// 【三条红线（persona 铁律）】
//   ① **观察档（emit=false）不得消费去重/冷却配额**：计划函数带 `emit` 开关；`emit=false` 时
//      `runCtxGuard` 走只算不动通道（`runAction({dryRun:true})`，`consumesQuota:false`，**不写签名**），
//      每条 superthreshold 会话只标 `verdict='observe'`（would-deliver），一条配额都不占。
//   ② **单轮 CLI 覆盖参数不落盘**：`--threshold` / `--limit` 只写进本次进程的 `cfg` 对象，
//      绝不回写 `butler-autonomy-limits.json` 或任何配置（落盘口径只取台账那份）。
//   ③ **`--json` 时日志只落文件、不上 stdout**（日志函数由 CLI 传 `quiet`）。
//
// 【本卡红线（2026-09-16）】**不放行、不重启**：只交付「能跑但默认关」——
//   代码进生产 + 开关默认关 + 单测/夹具 + dry-run 可跑 + 生产零动作强断言 + 回滚点 + 登记 + 流水。
//
// 【本卡追加（2026-09-23 · 主人拍板）】**卡执行会话一律不提醒**：
//   卡执行会话「一路做完」——上下文涨到 0.8×窗口（`dsh-compaction-basic` DEFAULT_THRESHOLD_RATIO）由主包
//   自己压缩，ctx-guard 的「写档 → 接力 → 停手」提醒对它语义错位、还会打断卡流程。判据唯一源 =
//   `lib/card-session.mjs`（账本 `executions[]` + 卡 status ∈ {done, review, failed} 等）；
//   `input.cardSessions` 缺省 / 索引 `ok:false` ⇒ **不排除任何会话**（fail-open，保持改动前语义）。
//   ⚠️ 阈值（300K/450K）、去重/额度判定、影子记账、`includeRunningOnly` 语义**一字未动**；
//     `level` 保留（观测面 overSoft/soft/hard 与改动前一致），只把 verdict 落成 `skip`。
import fs from 'node:fs';
import { workspaceRoot } from './ws-root.mjs';
import os from 'node:os';
import path from 'node:path';

import { dshHome, ensureDir } from '../../src/dsh-butler/lib/paths.mjs';
import { checkModuleAllowed } from '../../src/dsh-butler/lib/autonomy-modules.mjs';
import {
  runAction, checkDailyLimit, checkSignature, readActionsState, readLimits, localDay, sigKeyOf,
  appendQuotaDegrades,
} from '../../src/dsh-butler/lib/autonomy-actions.mjs';
import { readSessions, DEFAULT_BASE_URL } from '../../src/dsh-butler/lib/queue-watch.mjs';
// 【2026-11-08 · ctx-guard 数据源修复】0.2.2-rc.1 起 `contextPressure` 被标成 `wire.summary=false`
//   ⇒ 不再随 `session.list` 回来（见本文件【数据源】段订正注）。逐会话补采走 `session.projections`
//   （服务端 `projectionMode:'all'`，不受 summary 过滤）。与 queue-watch 同一个 RPC 客户端件。
import { hostRpc } from '../../src/lib/dsh-host-rpc.mjs';
import { notifySession } from '../../src/dsh-butler/lib/watch-notify.mjs';
// 【2026-09-17 · Q6 抽共享】重试循环原为本文件私有实现；Q6 卡要求"单一实现"⇒ 已抽到
//   `lib/collect-retry.mjs`（ctx-guard 与 queue tick 共用一份，数值口径一字不改）。
import { collectWithRetry, DEFAULT_RETRIES, DEFAULT_RETRY_DELAY_MS } from '../../src/dsh-butler/lib/collect-retry.mjs';
// 【本卡 · 通知面卡会话豁免 / 2026-09-23】卡执行会话判定唯一源（fail-open：拿不到索引 ⇒ 不排除任何人）
import { asCardSessionIndex, emptyCardSessionIndex, isCardSession, loadCardSessionIndex } from '../../src/dsh-butler/lib/card-session.mjs';
// 【夜批03 · 投递分级实现 / 2026-09-24】硬限插话开关 + 危险动作豁免名单（判据唯一源；N-3 四要素）
import { assessSteerExempt, readSteerGate, STEER_REASON_TEXT } from './steer-gate.mjs';

export const CTX_GUARD_VERSION = '0.2.0';
/** 动作 kind（与 AUTO_ACTION_KINDS 的键同名；L2 模块 id 亦同名 —— 矩阵 §3 列口径要求"同名才能对齐开关"）。 */
export const CTX_KIND = 'ctx-guard';
/**
 * 风险级（矩阵 §3 表口径）。
 *
 * 【2026-09-24 · 卡「夜批03 · 投递分级实现」升档 L1 → L2（主人 D27 (b′)："风险级必须如实升档"）】
 *   升档理由：硬限档现在**有能力在 step 边界插话**（`mode:'steer'`）⇒ 旧口径「只注入提醒文本、
 *   不改数据、**不打断回合**」不再成立。但它仍然**不 abort 进行中的工具**、不改任何会话数据、
 *   关掉开关即恢复旧行为 ⇒ 落在 **L2**（`LEVELS.L2`：有损可回滚 / 自动执行 + 留痕），
 *   不是 L3（L3 = 永不自动执行，会把能力直接废掉）。
 *   ⚠️ 两侧必须一致：`lib\autonomy-actions.mjs` 的 `AUTO_ACTION_KINDS['ctx-guard'].level` 同为 `'L2'`；
 *      一致性由 `_test\test-ctx-guard.mjs`（"模块自报风险级与登记表一致"）与
 *      `_test\test-4-3-upgrade-registration.mjs` 钉死。
 */
export const CTX_LEVEL = 'L2';

/** 判定档：soft = 建议移交；hard = 再催一次（措辞更硬）。 */
export const CTX_LEVELS = ['soft', 'hard'];
export const SOFT = 'soft';
export const HARD = 'hard';

/** 计划条目判定值（预览里逐会话可见）。 */
export const CTX_VERDICTS = ['deliver', 'queue', 'observe', 'skip'];

/** 配置默认值（**全部可配**；本卡交付时全部走默认 = 软限 300K / 硬限 450K）。 */
export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  softLimitTokens: 300_000,
  hardLimitTokens: 450_000,
  /** 每会话每日上限（口径 = soft / hard 各一条，靠 24h 签名窗口天然达成；此处只作回报与文案）。 */
  maxPerSessionPerDay: 2,
  /** 只对 `running === true` 的会话投递（本动作的哲学：提醒正在干活的 agent）。 */
  includeRunningOnly: true,
};

/** 仅在调用方未传 limits 时用的兜底值（与 lib/autonomy-actions.mjs 的 defaultLimits() 同口径）。 */
export const FALLBACK_MAX_PER_DAY = 5;
export const FALLBACK_MAX_PER_TICK = 2;
export const FALLBACK_DEDUP_MS = 24 * 3600 * 1000;

export const PREVIEW_MAX_ITEMS = 10;
const LOG_MAX_BYTES = 1024 * 1024;

/**
 * 采集重试默认值（2026-09-17 采集抖动收口）。
 *   · `retries = 1` ⇒ 最多 **2 次尝试**（最坏 2×10s 超时 + 1×1.5s 退避 = 21.5s ≪ 锁 TTL 900s）；
 *   · 两者都可用 `scanContext({ retries, retryDelayMs })` 覆盖（测试注入 `retries:0` 关掉重试）。
 *
 * ⚠️【2026-09-17 · Q6】实现已抽到 `lib/collect-retry.mjs`（单一实现），这里只做**同值别名导出**——
 *   对外常量名/取值/语义与批次17 完全一致，既有单测 `import { DEFAULT_SCAN_RETRIES }` 不受影响。
 */
export const DEFAULT_SCAN_RETRIES = DEFAULT_RETRIES;
export const DEFAULT_SCAN_RETRY_DELAY_MS = DEFAULT_RETRY_DELAY_MS;

/** 判定 reason → 人话（预览里逐会话可见；**只做翻译，不改判定**）。 */
export const NOTE_BY_REASON = {
  'no-session-id': '会话记录没有 sessionId → 不投递（拿不准就不发）',
  'no-pressure': '会话没有 contextPressure 投影 → 用量未知，跳过（绝不猜）',
  'no-projected': 'contextPressure 里没有可用数值（projectedTokens / pressureTokens 均缺）→ 跳过',
  'not-running': '会话不在跑（running≠true）→ 本动作只提醒正在干活的会话',
  // 【本卡 · 通知面卡会话豁免 / 2026-09-23】卡执行会话**一律**不提醒（不论卡是否结算）
  'card-session': '看板卡执行会话 → 一律不提醒：卡会话「一路做完」，上下文到自动压缩阈值（0.8×窗口）由主包自己压缩，不靠 ctx-guard 催移交',
  'under-soft': '未达软限 → 无事可做',
  'duplicate-signature': '24h 去重窗口内已提醒过同一档（soft/hard 各一条）→ 跳过',
  'quota-day': '单日自动动作上限已达 → 本轮排队，不投递',
  'quota-tick': '本轮并发上限（maxActionsPerTick）→ 本轮排队，下轮再投',
  'observe-only': '观察档（emit=false）：只算不投递，不消费配额',
  delivering: '将投递（queue 模式：排队等当前回合结束，不打断）',
};

// ---------------------------------------------------------------- 小工具

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 可空的数值解析（0 也算合法值；不可解析 → null）。 */
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 千分位（判定与文案统一口径）。 */
export function fmtTokens(n) {
  const v = Math.round(numOrNull(n) ?? 0);
  return v.toLocaleString('en-US');
}

/** 百分比保留一位小数（窗口不可得 → '?'）。 */
export function fmtPct(part, total) {
  const t = numOrNull(total);
  const p = numOrNull(part);
  if (!(t > 0) || p === null) return '?';
  return ((p / t) * 100).toFixed(1);
}

/** 日志文件（<tmp>，不占 .dsh 状态、不进备份；DSH_CTX_GUARD_LOG 可覆盖）。 */
export function logFile() {
  return process.env.DSH_CTX_GUARD_LOG || path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-ctx-guard.log');
}

/**
 * 写一行日志（1MB 轮转）。
 * 红线③：`--json` 时调用方传 `quiet:true` → **只落文件、不上 stdout**（否则机器读不出 JSON）。
 */
export function logLine(msg, opts = {}) {
  const line = `[${new Date(opts.now ?? Date.now()).toISOString()}] ${msg}`;
  try {
    const file = opts.file ?? logFile();
    ensureDir(path.dirname(file));
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > LOG_MAX_BYTES) fs.writeFileSync(file, '', 'utf8');
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch { /* 日志失败绝不影响主流程 */ }
  if (opts.quiet !== true) {
    try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 提醒文案（写给 agent 看）

/**
 * 会话上下文用量的读数（纯函数：从 readSessions 的条目里提取判定与文案要用的字段）。
 * @returns {{sessionId:string|null, title:string|null, running:boolean,
 *            projectedTokens:number|null, pressureTokens:number|null, contextWindow:number|null,
 *            ratio:number|null, reason:string|null}}
 */
export function readPressure(session) {
  const sid = session?.sessionId ? String(session.sessionId) : null;
  const out = {
    sessionId: sid,
    title: session?.title ? String(session.title) : null,
    running: session?.running === true,
    projectedTokens: null, pressureTokens: null, contextWindow: null, ratio: null, reason: null,
  };
  if (!sid) { out.reason = 'no-session-id'; return out; }
  const cp = session?.contextPressure ?? null;
  if (!cp || typeof cp !== 'object') { out.reason = 'no-pressure'; return out; }
  const projected = numOrNull(cp.projectedTokens);
  const pressure = numOrNull(cp.pressureTokens);
  const window = numOrNull(cp.contextWindow);
  // 判定用 projectedTokens（下一个请求的预计用量）；它缺失时回退 pressureTokens（上一次实测）。
  const use = projected ?? pressure;
  if (use === null) { out.reason = 'no-projected'; return out; }
  out.projectedTokens = use;
  out.pressureTokens = pressure;
  out.contextWindow = window;
  out.ratio = window > 0 ? use / window : null;
  return out;
}

/**
 * 可注入常量（方案 §4.7 配套改动 2：**测试断言不硬编码生产路径**）。
 * 文案里的默认值必须与方案 §4.7 的**逐字**文本一致；注入只用于测试/换机，不改默认口径。
 */
export const DEFAULT_RELAY_CLI = path.join(workspaceRoot(), 'tools', 'session-relay.mjs');
export const DEFAULT_HANDOFF_DOC_DIR = path.join(workspaceRoot(), 'docs');

/**
 * 提醒文案（**写给 agent 看，不是给人看**）。
 *
 * 【2026-09-22 卡 S1 · 方案 §4.7 B3 已拍：改为「带交接动作」的文案 —— **逐字**落地】
 *   现状问题：原文案只说"建议现在收尾 / 告诉主人该开新会话"，**没有交接动作** ⇒ agent 收到也不知道该跑什么。
 *   改后 = 三步走（写档 → 跑 `session-relay.mjs` → 回一句并停手）；硬限档 = 两件事（立刻交接 + 停手等接手会话）。
 *   ⚠️ 改文案**必须同步** `_test\test-ctx-guard.mjs` 的**逐字断言**（文案改了断言没改 ⇒ 红）。
 * @param {{level:string, projectedTokens:number, contextWindow?:number|null, cfg?:object, sessionId?:string|null,
 *          relayCli?:string, handoffDir?:string, delivery?:'queue'|'steer'}} ctx
 *   `delivery`（2026-09-24 新增，**默认 `'queue'`**）：硬限走 steer 时把收尾口径写清楚
 *   （"当前 step 跑完时插话，不打断进行中的工具"）——默认值下文案与交付前**逐字相同**。
 */
export function formatCtxGuardText(ctx = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(ctx.cfg ?? {}) };
  const level = ctx.level === HARD ? HARD : SOFT;
  const delivery = ctx.delivery === 'steer' ? 'steer' : 'queue';
  const projected = numOrNull(ctx.projectedTokens) ?? 0;
  const window = numOrNull(ctx.contextWindow);
  const used = `${fmtTokens(projected)}${window ? ` / ${fmtTokens(window)}` : ''}`
    + `${window ? `（${fmtPct(projected, window)}%）` : ''}`;
  const relayCli = typeof ctx.relayCli === 'string' && ctx.relayCli.trim() ? ctx.relayCli.trim() : DEFAULT_RELAY_CLI;
  const handoffDir = typeof ctx.handoffDir === 'string' && ctx.handoffDir.trim() ? ctx.handoffDir.trim() : DEFAULT_HANDOFF_DOC_DIR;
  const cap = delivery === 'steer'
    ? `（ctx-guard · 每会话每日上限 ${cfg.maxPerSessionPerDay} 次 · **steer 插话**：当前 step 跑完时插话，不打断进行中的工具）`
    : `（ctx-guard · 每会话每日上限 ${cfg.maxPerSessionPerDay} 次 · queue 模式投递，不占当前回合）`;
  if (level === HARD) {
    return [
      `🛑 上下文看门·硬限提醒（管家自动投递）：本会话上下文已用约 ${used}，已越过硬限 ${fmtTokens(cfg.hardLimitTokens)}。`,
      '不要再开新活。只做两件事：',
      '① 立刻按上一档口径执行自动交接（写档 → 跑 session-relay）；档来不及写全时，**至少写「已完成 + 下一步」两段**；',
      '② 交接完成后停手，等接手会话（【续】<主线名>）继续。',
      cap,
    ].join('\n');
  }
  return [
    `⚠️ 上下文看门提醒（管家自动投递）：本会话上下文已用约 ${used}。`,
    '请现在走「自动交接」，三步：',
    `① 写交接档 ${handoffDir}\\交接-<主线名>-<日期>.md（七段模板；第 5 段「下一步」必须写，写不出就**不要**开新会话，改为提示主人）；`,
    `② 运行 node ${relayCli} --handoff <该档路径>（它会开新会话 + 打【续】标题；**在途卡改绑由接手会话做**，不是旧会话做）；`,
    '③ 回一句「已接力 → 【续】<主线名>」给主人，然后停手（**别再开新的大话题**）。',
    cap,
  ].join('\n');
}

// ------------------------------------------------ 上下文规模补采（0.2.2 数据源迁移 · 2026-11-08）

/** 每轮最多补采多少个会话（见文件头【数据源订正】的"抽样"理由）。 */
export const DEFAULT_PROBE_MAX = 24;
/** 补采并发（本地 127.0.0.1 RPC，6 路足够快又不至于把宿主压出连接池问题）。 */
export const DEFAULT_PROBE_CONCURRENCY = 6;
/**
 * 单条补采超时。
 *
 * ⚠️【2026-11-08 实测】`session.projections` 对**冷会话**（已换出内存/久未动）要先把整条日志
 *   折叠一遍（`projectionMode:'all'`），是真的慢。现跑 70 条均匀采样（超时放到 30s 只为测真值）：
 *   **中位 360ms / p90 751ms / 最快 7ms，但有 3 条 >3s（10.8s、10.4s、7.9s）**，都是 11-06 之后再没动过的冷会话。
 *   ⇒ 选 5s + 下面的**总预算**双保险：单条超 5s 记 `unreadable`（不进行告警分母），
 *   尾巴上那几条冷会话放弃掉不影响任何判定。
 *   **这对投递无影响**：投递只发生在 `running===true` 的会话上，而活动会话在内存里（实测 7~80ms）。
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
/**
 * 一轮补采的**总时长预算**（毫秒）。超预算 ⇒ 剩下的不再发起，记 `skippedByCap`（benign）。
 *
 * 为什么要它（2026-11-08 实测踩到）：本机 `session.list` 在 6 个长会话并发时实测 **25.4s**
 *   （既有超时 10s ⇒ 直接 collect-failed）。宿主本来就吃紧的时候，**采集器不该再往上加压**。
 *   有了总预算，最坏情况每轮只多花 ~8s，绝不会因为"补采遇到一堆冷会话"而拖成几十秒。
 */
export const DEFAULT_PROBE_BUDGET_MS = 8000;
/** 「数据源消失」告警阈值：样本量下限（少于这个数不出告警，样本太小没有统计意义）。 */
export const DATA_SOURCE_MISSING_MIN_SAMPLE = 20;
/** 「数据源消失」告警阈值：缺失占比（> 这个比例才告警）。 */
export const DATA_SOURCE_MISSING_RATE = 0.5;

/**
 * 读**单个**会话的 `contextPressure`（走 `session.projections`，全投影不受 summary 过滤）。
 *
 * 返回**三分态**（这是一次踩坑换来的：把"读失败"和"读到了但没这个投影"混成一个 null，
 * 会让告警分母失真 —— 慢 ≠ 坏了）：
 *   · `state:'ok'`        —— 拿到了可用数值（`pressureTokens/projectedTokens/contextWindow`）
 *   · `state:'empty'`     —— 投影**在**、但还没有任何数值（该会话还没发过请求 / 刚建）→ **benign**
 *   · `state:'absent'`    —— 投影**键都没有** → **这才是升级回归的特征**（主包改名/摘掉 summary）
 *   · `state:'unreadable'`—— RPC 报错 / 超时 / 没有 values → 算**读失败**，不进告警分母
 * ⚠️ `empty` 与 `absent` 必须分开：全新会话的 `contextPressure` 初值就是 `{}`（合法空），
 *    若把它算成"缺失"，一批新会话就能把告警顶起来。
 *
 * @returns {Promise<{state:'ok'|'empty'|'absent'|'unreadable', pressureTokens?:number|null,
 *                     projectedTokens?:number|null, contextWindow?:number|null, reason?:string}>}
 */
export async function readSessionContextPressure(sessionId, opts = {}) {
  const unreadable = (reason) => ({ state: 'unreadable', reason });
  if (!sessionId) return unreadable('no-session-id');
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let body; let r;
  try {
    const res = await hostRpc(baseUrl, 'session.projections', { sessionId: String(sessionId) }, {
      timeoutMs: Math.max(1, num(opts.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS)),
      ...(typeof fetchImpl === 'function' ? { fetchImpl } : {}),
    });
    body = res?.body;
  } catch (e) {
    return unreadable(`rpc:${e?.message ?? String(e)}`);   // 网络/超时：读失败，不算"没有投影"
  }
  r = body?.result?.value ?? body?.result ?? null;
  if (!r) return unreadable('no-result');
  if (r.ok === false) return unreadable(`host:${r.error?.code ?? r.error?.message ?? 'error'}`);
  const values = r.values ?? r.projections?.values ?? null;
  if (!values || typeof values !== 'object') return unreadable('no-values');
  const cp = values.contextPressure;
  // ★ 键都不在 = 投影没了（0.2.2 升级后的真正症状）；键在但空 = 合法空态
  if (cp === undefined) return { state: 'absent', reason: 'key-missing' };
  if (cp === null || typeof cp !== 'object') return { state: 'absent', reason: 'key-not-object' };
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const out = {
    pressureTokens: n(cp.pressureTokens),
    projectedTokens: n(cp.projectedTokens),
    contextWindow: n(cp.contextWindow),
  };
  if (out.pressureTokens === null && out.projectedTokens === null && out.contextWindow === null) {
    return { state: 'empty' };
  }
  return { state: 'ok', ...out };
}

/**
 * 给 `readSessions()` 的结果**补齐** `contextPressure`（**不修改入参数组的元素**，返回浅拷贝）。
 *
 * 挑选顺序（谁更可能"该提醒"谁先补）：
 *   ① `running === true` 的会话**全部**补（投递只发生在它们身上，不能漏）；
 *   ② 其余按 `updatedAt` 倒序补齐到上限 `maxProbe` 条（越新越可能是"正在被用的会话"）。
 * 列表投影已给的会话**不补**（老主包 / 主包改回 summary 时零额外开销）。
 *
 * @param {Array} items `readSessions().items`
 * @returns {Promise<{items:Array, stats:object}>} stats = 本轮补采留痕（进 summary，供"不静默"判据）
 */
export async function enrichContextPressure(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const maxProbeRaw = num(opts.maxProbe, DEFAULT_PROBE_MAX);
  const maxProbe = maxProbeRaw < 0 ? 0 : Math.trunc(maxProbeRaw);
  const concurrency = Math.max(1, Math.trunc(num(opts.concurrency, DEFAULT_PROBE_CONCURRENCY)));
  const stats = {
    total: list.length,
    fromList: 0,      // 列表投影直接命中（不需要补采）
    attempted: 0,     // 真去补采的条数
    resolved: 0,      // 补采拿到可用数值
    empty: 0,         // 投影在但还没有数值（新会话，benign）
    absent: 0,        // 投影**键都没有** → 数据源回归特征（**告警分子**）
    unreadable: 0,    // RPC 报错/超时/没有 values（读失败，**不进告警分母**）
    skippedByCap: 0,  // 因上限没补的（benign，不算缺失）
    probedRunning: 0,
    source: 'list+projections',
  };

  const out = list.map((s) => ({ ...s }));
  const need = [];
  for (let i = 0; i < out.length; i += 1) {
    const cp = out[i]?.contextPressure;
    if (cp && typeof cp === 'object') { stats.fromList += 1; out[i].pressureProbe = out[i].pressureProbe ?? 'list'; continue; }
    need.push(i);
  }

  // 排序：在跑的先；其余按 updatedAt 倒序（0/缺失排最后）
  need.sort((ia, ib) => {
    const a = out[ia]; const b = out[ib];
    const ar = a?.running === true ? 1 : 0;
    const br = b?.running === true ? 1 : 0;
    if (ar !== br) return br - ar;
    return num(b?.updatedAt, 0) - num(a?.updatedAt, 0);
  });

  const picked = need.slice(0, maxProbe);
  stats.skippedByCap = need.length - picked.length;

  // 小并发跑（顺序无关：结果按索引写回，不依赖完成次序）
  // ⚠️ 每发起一条之前先看**总预算**：超预算就直接放弃后面的（记 skippedByCap，benign）。
  //   这样"补采撞上一堆冷会话"最坏也只花 budgetMs，不会把加载中的宿主再拖慢。
  const budgetMs = Math.max(0, num(opts.budgetMs, DEFAULT_PROBE_BUDGET_MS));
  const startedAt = Date.now();
  let cursor = 0;
  let budgetStopped = 0;
  const worker = async () => {
    for (;;) {
      const k = cursor;
      cursor += 1;
      if (k >= picked.length) return;
      if (budgetMs > 0 && Date.now() - startedAt > budgetMs) { budgetStopped += 1; continue; }
      const idx = picked[k];
      const s = out[idx];
      if (!s?.sessionId) continue;   // 没 id 无法补采，也不算 attempted
      stats.attempted += 1;
      if (s.running === true) stats.probedRunning += 1;
      const cp = await readSessionContextPressure(s.sessionId, opts);
      if (cp.state === 'ok') {
        s.contextPressure = {
          pressureTokens: cp.pressureTokens ?? null,
          projectedTokens: cp.projectedTokens ?? null,
          contextWindow: cp.contextWindow ?? null,
        };
        s.pressureSource = 'projections-rpc';
        s.pressureProbe = 'projections-rpc';
        stats.resolved += 1;
        continue;
      }
      if (cp.state === 'empty') { stats.empty += 1; s.pressureProbe = 'empty'; continue; }
      if (cp.state === 'absent') { stats.absent += 1; s.pressureProbe = 'absent'; continue; }
      stats.unreadable += 1;
      s.pressureProbe = 'unreadable';
      s.pressureProbeError = cp.reason ?? null;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, picked.length)) }, () => worker()));
  stats.skippedByCap += budgetStopped;   // 预算放弃的也算"我们没看"，绝不算缺失
  stats.budgetStopped = budgetStopped;
  stats.elapsedMs = Date.now() - startedAt;

  return { items: out, stats };
}

/**
 * 「数据源消失」判定（**纯函数**）：补采样本里「投影键都不见了」的比例异常 ⇒ 告警。
 *
 * 为什么要有它：0.2.2 升级后 ctx-guard **静默**失效了整整一轮（718/718 走 no-pressure，
 * 面板/日报全绿），主人 21:47 亲自发现。**静默是这次最糟糕的地方**，必须显式化。
 *
 * 判据（两个都要满足，防小样本误报）：
 *   · 分母 `readable = resolved + empty + absent`（**读成功**的条数）`>= minSample`（默认 20）
 *   · `absent / readable > rate`（默认 0.5）
 *
 * 三个口径钉子（都是踩出来的，别合并）：
 *   ① **`unreadable` 不进分母** —— RPC 超时/报错是"读失败"，不是"没有这个投影"；
 *      混进来就会把"冷会话回溯慢"误报成"数据源没了"（实测 3s 超时造成 20/70 假缺失）。
 *   ② **`empty` 不算缺失** —— 全新会话的 `contextPressure` 初值合法地就是 `{}`。
 *      算成缺失的话，一批新会话就能把告警顶起来。
 *   ③ **因上限没补的不进分母** —— "我们选择不看" ≠ "看了没有"。
 *
 * @returns {{present:boolean, readable:number, absentCount:number, unreadable:number,
 *            rate:number|null, reason:string}}
 */
export function assessDataSourceMissing(stats, opts = {}) {
  const minSample = num(opts.minSample, DATA_SOURCE_MISSING_MIN_SAMPLE);
  const limitRate = num(opts.rate, DATA_SOURCE_MISSING_RATE);
  const resolved = num(stats?.resolved, 0);
  const empty = num(stats?.empty, 0);
  const absentCount = num(stats?.absent, 0);
  const unreadable = num(stats?.unreadable, 0);
  const readable = resolved + empty + absentCount;
  const out = { present: false, readable, absentCount, unreadable, rate: null, reason: 'ok' };
  if (readable <= 0) { out.reason = 'no-sample'; return out; }
  out.rate = absentCount / readable;
  if (readable < minSample) { out.reason = 'sample-too-small'; return out; }
  if (out.rate > limitRate) {
    out.present = true;
    out.reason = `contextPressure 投影缺失 ${absentCount}/${readable}（${Math.round(out.rate * 100)}% > ${Math.round(limitRate * 100)}%）`;
    return out;
  }
  out.reason = 'ok';
  return out;
}

// ---------------------------------------------------------------- 只读采集

/**
 * 只读采集会话列表（**零副作用**：只发只读请求，不写任何文件）。
 * 判定口径全部在 `planCtxGuard()`（纯函数）里，本函数只负责"取数"。
 *
 * 【有限重试·2026-09-17 抖动收口】采集失败时**重试同一个约定**（`readSessions` 本体一行不动）：
 *   · `opts.retries`（默认 {@link DEFAULT_SCAN_RETRIES}=1 ⇒ 最多 2 次尝试）
 *   · `opts.retryDelayMs`（默认 {@link DEFAULT_SCAN_RETRY_DELAY_MS}=1500；仅**失败后**才等待，
 *     成功即返回、不额外延迟；`retries:0` 即完全关掉 —— 测试用这个做关闭路径）
 *   · 每次尝试**沿用既有超时**（`opts.timeoutMs` 透传给 `readSessions`，默认 10s）——**不为重试调大超时**。
 *   · 只对"采集失败"重试；空列表属于 `readSessions` 的 fail-closed 失败（红线③，不开旁路），
 *     重试后仍失败即照旧整体失败。
 *   · `opts.onRetry(info)` 是**纯观察钩子**（默认不存在；钩子自身抛错被吞掉，绝不影响主流程）；
 *     本函数**自己不写任何文件/日志**（零副作用承诺不变）。
 *
 * 失败语义**不回退**（红线①）：重试后仍失败 → 仍 `ok:false` + 原样文案
 * `采集失败（session.list=…）→ 本轮不规划任何投递`（调用方据此记 `collect-failed` → exit 1 → 报警）。
 * @param {{baseUrl?:string, fetchImpl?:Function, timeoutMs?:number, retries?:number, retryDelayMs?:number,
 *          onRetry?:Function, cfg?:object}} opts
 * @returns {Promise<{ok:boolean, error?:string, attempts:number, retries:number, cfg:object,
 *                    sessions:Array, total:number, withPressure:number}>}
 */
export async function scanContext(opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.cfg ?? {}) };
  // 【2026-09-17 · Q6】重试循环改用共享实现（`lib/collect-retry.mjs`）——语义与批次17 逐字一致：
  //   retries/retryDelayMs 解析同值、成功即返回、失败才退避、onRetry 钩子照传、异常照抛不吞。
  const retries = Math.max(0, Math.trunc(num(opts.retries, DEFAULT_SCAN_RETRIES)));
  const retryDelayMs = Math.max(0, num(opts.retryDelayMs, DEFAULT_SCAN_RETRY_DELAY_MS));
  const maxAttempts = retries + 1;

  const cx = await collectWithRetry(
    () => readSessions({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }),
    { retries, retryDelayMs, onRetry: opts.onRetry },
  );
  const r = cx.result ?? { ok: false, error: 'no-result' };
  const attempts = cx.attempts;
  const maxAttemptsSeen = cx.maxAttempts;
  if (maxAttemptsSeen !== maxAttempts) {
    throw new Error(`scanContext：重试参数解析不一致（${maxAttemptsSeen} != ${maxAttempts}）`);   // 不可能发生；宁可炸也不静默
  }

  if (!r.ok) {
    // ⚠️ 红线①：文案与旧口径**逐字一致**（失败不会被重试掩掉；attempts/retries 只作旁证，不进文案）。
    return {
      ok: false,
      error: `采集失败（session.list=${r.error}）→ 本轮不规划任何投递`,
      attempts, retries,
      cfg, sessions: [], total: 0, withPressure: 0,
    };
  }
  const sessionsRaw = r.items ?? [];
  // 【2026-11-08 · 数据源修复】列表投影在 0.2.2-rc.1 已不返回 `contextPressure`（见文件头【数据源订正】）
  //   ⇒ 在这里**补采**（只改本采集入口，`readSessions` 一行不动 —— 文件头红线②）。
  //   `opts.probe === false` 可关掉（测试/离线演练用；关掉即回到"只有列表投影"的老语义）。
  const enrich = opts.probe === false
    ? { items: sessionsRaw, stats: { total: sessionsRaw.length, fromList: sessionsRaw.filter((s) => s?.contextPressure).length, attempted: 0, resolved: 0, empty: 0, absent: 0, unreadable: 0, skippedByCap: 0, probedRunning: 0, source: 'list-only' } }
    : await enrichContextPressure(sessionsRaw, {
      baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl,
      maxProbe: opts.maxProbe, concurrency: opts.probeConcurrency, timeoutMs: opts.probeTimeoutMs,
      budgetMs: opts.probeBudgetMs,
    });
  const sessions = enrich.items;
  return {
    ok: true, attempts, retries, cfg, sessions, total: sessions.length,
    withPressure: sessions.filter((s) => s?.contextPressure && typeof s.contextPressure === 'object').length,
    // 补采留痕：`planCtxGuard({pressureSource})` 据此判「数据源是否消失」（不许再静默）
    pressureSource: enrich.stats,
  };
}

// ---------------------------------------------------------------- 规划（纯函数）

/**
 * 规划一轮（**纯函数，零副作用**）：给定会话列表 / 限额 / 台账 → 逐会话计划。
 *
 * 判定顺序（逐会话，先到先判；**每条都写进 `reason`，预览里逐条可见**）：
 *   ① 无 sessionId            → skip
 *   ② 无 `contextPressure`     → skip（用量未知，绝不猜）
 *   ③ 无可用数值              → skip
 *   ④ `running !== true`      → skip（本动作只提醒**正在干活**的会话）
 *   ⑤ 未达软限                → skip
 *   ⑥ 24h 去重（同一档 soft/hard 各一条）→ skip（**`emit=false` 时不看这条**：观察档不消费配额）
 *   ⑦ `emit=true` 时再套两层限额（都取自既有护栏，不新增口径）：
 *        · 单日上限 `maxAutoActionsPerDay`（`checkDailyLimit` 同源）
 *        · 一轮并发上限 `maxActionsPerTick`（沿用既有护栏字段语义）
 *
 * ⚠️ **红线①**：`emit=false`（观察档）时**不做**去重/限额降级判定 → `verdict='observe'`，
 *    条目只标"若开启会投递"，不消费任何配额（调用方也走只读通道，不写签名）。
 *
 * @returns {{kind:string, now:number, day:string, emit:boolean, cfg:object, quota:object,
 *            limits:object, softLimitTokens:number, hardLimitTokens:number, summary:object,
 *            items:Array, deliverable:Array<string>}}
 */
export function planCtxGuard(input = {}) {
  const now = num(input.now, Date.now());
  const emit = input.emit === true;
  const cfg = { ...DEFAULT_CONFIG, ...(input.cfg ?? {}) };
  const limits = input.limits ?? {};
  const state = input.state ?? {};
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  // 【卡执行会话豁免（2026-09-23 · 主人拍板）】判据唯一源 = `card-session.mjs`（账本 executions + 卡 status）。
  //   卡执行会话**一律**不进软限/硬限名单（无论卡是否结算）——卡会话「一路做完」，到 80% 窗口由主包
  //   `dsh-compaction-basic` 自动压缩，ctx-guard 的「写档 → 接力 → 停手」提醒对它语义错位、且打断卡流程。
  //   ⚠️ fail-open：`input.cardSessions` 缺失 / 索引 `ok:false`（账本读不到）⇒ 一个都不排除（保持改动前语义）。
  const cardIdx = asCardSessionIndex(input.cardSessions);
  // 【夜批03 · 投递分级实现 / 2026-09-24】硬限插话（steer）开关 + 危险动作豁免名单。
  //   `steerActive` 的两种取值来源（**都要求"进了决策路径"才写新字段** ⇒ 默认关时输出与交付前逐字节相同）：
  //     · 开关**已开**（`gate.ok && gate.enabled`）→ 正常判定；
  //     · 开关/名单**不可读**（`gate.ok === false`）→ 判据不可用 ⇒ **恒返 `exempt-unknown`**（fail-open：
  //       不插话、回落 queue；N-3 (c)）。此路径只在 limits 文件损坏/形状不认时出现，不影响"未配置=默认关"。
  const steerGate = input.steerGate && typeof input.steerGate === 'object' ? input.steerGate : null;
  const steerActive = Boolean(steerGate) && (steerGate.enabled === true || steerGate.ok !== true);
  const steerCount = { steer: 0, fallback: 0 };
  const soft = num(cfg.softLimitTokens, DEFAULT_CONFIG.softLimitTokens);
  const hard = Math.max(num(cfg.hardLimitTokens, DEFAULT_CONFIG.hardLimitTokens), soft);
  const maxPerDay = num(limits.maxAutoActionsPerDay, FALLBACK_MAX_PER_DAY);
  const maxPerTick = num(limits.maxActionsPerTick, FALLBACK_MAX_PER_TICK);
  const dedupWindowMs = num(limits.dedupWindowMs, FALLBACK_DEDUP_MS);
  // 【施工卡 ⑥-3】分池：本动作判自己的 kind 池（`pools.eco.kinds['ctx-guard'].maxPerDay`）+ 生态总闸；
  //   `pools` 未配置 ⇒ 与改动前逐字节一致（方案 §9 风险 1 的缓解措施）。
  const daily = checkDailyLimit(state, localDay(now), maxPerDay, { kind: CTX_KIND, pools: limits.pools });

  const items = [];
  let planned = 0;

  for (const session of sessions) {
    const p = readPressure(session);
    const item = {
      sessionId: p.sessionId,
      title: p.title,
      running: p.running,
      projectedTokens: p.projectedTokens,
      pressureTokens: p.pressureTokens,
      contextWindow: p.contextWindow,
      ratio: p.ratio,
      percent: p.contextWindow > 0 && p.projectedTokens !== null ? fmtPct(p.projectedTokens, p.contextWindow) : null,
      level: null,
      verdict: 'skip',
      reason: p.reason ?? 'under-soft',
      sigKey: null,
      dedup: null,
      // 【本卡 · 通知面卡会话豁免】是否卡执行会话（true 时本条一律 skip；索引不可用 → null）
      cardSession: null,
      // 【施工卡 ⑥-1】额度降级标记（`null` / `'quota-day'` / `'quota-tick'`）——**只加字段、不改判定**：
      //   判定条件与 verdict 一个字没动，台账（lib/autonomy-actions.mjs appendQuotaDegrades）认这个字段。
      quotaGate: null,
      emit: false,
      note: '',
      text: null,
    };

    if (p.reason) {
      item.note = NOTE_BY_REASON[p.reason] ?? p.reason;
      // 【2026-11-08 · 数据源修复】「我们选择不看」与「看了却没有」必须让人眼能分开：
      //   补采了仍拿不到 ⇒ 明说数据源存疑（而不是伪装成"这个会话没有用量"）。
      if (p.reason === 'no-pressure' && session?.pressureProbe === 'absent') {
        item.pressureProbe = 'absent';
        item.note = '补采 session.projections：**投影键 contextPressure 不存在** → 数据源疑似回归（不是「这个会话没用量」）';
      } else if (p.reason === 'no-pressure' && session?.pressureProbe === 'unreadable') {
        item.pressureProbe = 'unreadable';
        item.note = `补采读失败（${session?.pressureProbeError ?? 'rpc'}）→ 用量未知，跳过（读失败 ≠ 没有投影）`;
      }
      items.push(item);
      continue;
    }
    if (cfg.includeRunningOnly !== false && p.running !== true) {
      item.reason = 'not-running';
      item.note = NOTE_BY_REASON['not-running'];
      items.push(item);
      continue;
    }
    if (p.projectedTokens < soft) {
      item.reason = 'under-soft';
      item.note = `${NOTE_BY_REASON['under-soft']}（${fmtTokens(p.projectedTokens)} < 软限 ${fmtTokens(soft)}）`;
      items.push(item);
      continue;
    }

    item.level = p.projectedTokens >= hard ? HARD : SOFT;
    item.sigKey = sigKeyOf(CTX_KIND, p.sessionId, item.level);
    item.text = formatCtxGuardText({
      level: item.level, projectedTokens: p.projectedTokens, contextWindow: p.contextWindow, cfg,
    });

    // 【本卡 · 通知面卡会话豁免 / 2026-09-23】卡执行会话**一律**不投递（无论卡是否结算）：
    //   卡会话「一路做完」—— 到自动压缩阈值由主包自己压缩，催它「写档 → 接力 → 停手」语义错位。
    //   · `level` **故意保留**：观测面（overSoft/soft/hard 计数）与改动前一致，可继续看见"卡会话超限数"；
    //   · `sigKey` 置 null：本条不投递 ⇒ 不写 24h 签名、不消费任何去重/额度配额（skip 发生在去重判定之前）；
    //   · fail-open：索引不可用（ok:false）⇒ isCardSession 恒 false ⇒ 走原有路径（保持改动前语义）。
    if (isCardSession(p.sessionId, cardIdx)) {
      item.cardSession = true;
      item.sigKey = null;
      item.reason = 'card-session';
      item.note = NOTE_BY_REASON['card-session'];
      items.push(item);
      continue;
    }

    // 【夜批03 · 投递分级实现 / 2026-09-24】硬限插话判定（**只改通道，不改"投不投递"**）：
    //   · 软限恒走 `queue`（无害档，不动）；
    //   · 硬限在开关开启时走豁免名单（判据唯一源 = lib/steer-gate.mjs；卡执行会话不进名单）；
    //     未获准 ⇒ **回落 `queue`**（绝不静默：`steerReason` 落进记账 detail 与日报段）。
    //   ⚠️ 默认关（未配置）时 `steerActive=false` ⇒ 本条**不产生任何新字段**（与交付前逐字节等价）。
    if (steerActive && item.level === HARD) {
      const a = assessSteerExempt({ sessionId: p.sessionId, gate: steerGate, cardSessions: cardIdx });
      item.delivery = a.allow ? 'steer' : 'queue';
      item.steerReason = a.reason;
      item.steerNote = a.note;
      item.steerDetail = a.detail ?? null;
      item.steerText = STEER_REASON_TEXT[a.reason] ?? null;
      if (a.allow) {
        steerCount.steer += 1;
        // steer 档文案与 queue 档只差"收尾口径"一句（默认值下逐字相同）
        item.text = formatCtxGuardText({
          level: item.level, projectedTokens: p.projectedTokens, contextWindow: p.contextWindow, cfg,
          delivery: 'steer',
        });
      } else {
        steerCount.fallback += 1;
      }
    }

    // 观察档：只算不投递，**不消费配额、不判去重**（红线①）
    if (!emit) {
      item.reason = 'observe-only';
      item.verdict = 'observe';
      item.emit = false;
      item.note = `${NOTE_BY_REASON['observe-only']}（若开启会投递 ${item.level} 档）`;
      items.push(item);
      continue;
    }

    const dup = checkSignature(state, item.sigKey, now, dedupWindowMs);
    item.dedup = { dup: dup.dup, lastAt: dup.lastAt, reason: dup.reason };
    if (dup.dup) {
      item.reason = 'duplicate-signature';
      item.note = `${NOTE_BY_REASON['duplicate-signature']}：${dup.reason}`;
      items.push(item);
      continue;
    }
    if (daily.reached) {
      item.reason = 'quota-day';
      // 【施工卡 ⑥-3】`quotaGate` 细分由唯一判定函数给出（`quota-day` / `quota-kind` / `quota-reserve`）；
      //   `reason` 保持老值域 `'quota-day'`、note 老前缀原样保留（下游文案与断言零波及），池维度落在括号里。
      item.quotaGate = daily.gate ?? 'quota-day';   // 【施工卡 ⑥-1】额度降级落点①（日额度）
      item.verdict = 'queue';
      item.note = `${NOTE_BY_REASON['quota-day']}（${daily.reason}）`;
      items.push(item);
      continue;
    }
    if (planned >= maxPerTick) {
      item.reason = 'quota-tick';
      item.quotaGate = 'quota-tick';         // 【施工卡 ⑥-1】额度降级落点②（单轮并发上限）
      item.verdict = 'queue';
      item.note = `${NOTE_BY_REASON['quota-tick']}（maxActionsPerTick=${maxPerTick}）`;
      items.push(item);
      continue;
    }

    item.reason = 'delivering';
    item.verdict = 'deliver';
    item.emit = true;
    item.note = NOTE_BY_REASON.delivering;
    planned += 1;
    items.push(item);
  }

  const byVerdict = (v) => items.filter((i) => i.verdict === v).length;
  const byReason = (r) => items.filter((i) => i.reason === r).length;
  const summary = {
    sessions: items.length,
    running: items.filter((i) => i.running).length,
    overSoft: items.filter((i) => i.level !== null).length,
    soft: items.filter((i) => i.level === SOFT).length,
    hard: items.filter((i) => i.level === HARD).length,
    deliver: byVerdict('deliver'),
    queue: byVerdict('queue'),
    observe: byVerdict('observe'),
    skip: byVerdict('skip'),
    noPressure: byReason('no-pressure') + byReason('no-projected'),
    notRunning: byReason('not-running'),
    deduped: byReason('duplicate-signature'),
    underSoft: byReason('under-soft'),
    cardSession: byReason('card-session'),
  };
  // 【2026-11-08 · 数据源修复】「数据源消失」显式化 —— 只在**本轮真有补采样本**时才加键
  //   （`input.pressureSource` 缺失 = 纯函数测试/老调用方 ⇒ summary 键集与改动前逐字节相同）。
  //   这次最糟糕的地方就是**静默**：718/718 走 no-pressure，面板与日报全绿，主人自己发现的。
  if (input.pressureSource && typeof input.pressureSource === 'object') {
    const ds = assessDataSourceMissing(input.pressureSource, cfg.dataSourceMissing ?? {});
    summary.dataSourceAttempted = num(input.pressureSource.attempted, 0);
    summary.dataSourceReadable = ds.readable;
    summary.dataSourceAbsent = ds.absentCount;
    summary.dataSourceUnreadable = ds.unreadable;
    summary.dataSourceMissing = ds.present;
    summary.dataSourceNote = ds.reason;
    summary.pressureFromList = num(input.pressureSource.fromList, 0);
    summary.pressureFromProbe = num(input.pressureSource.resolved, 0);
    summary.pressureSkippedByCap = num(input.pressureSource.skippedByCap, 0);
  }
  // 【夜批03】只在 steer 决策路径激活时才追加这两个计数（默认关 ⇒ summary 键集与交付前逐字相同）
  const out = {
    kind: CTX_KIND,
    now,
    day: localDay(now),
    emit,
    mode: emit ? 'emit' : 'observe',
    cfg: { softLimitTokens: soft, hardLimitTokens: hard, maxPerSessionPerDay: num(cfg.maxPerSessionPerDay, 2), includeRunningOnly: cfg.includeRunningOnly !== false },
    softLimitTokens: soft,
    hardLimitTokens: hard,
    quota: daily,
    limits: { maxAutoActionsPerDay: maxPerDay, maxActionsPerTick: maxPerTick, dedupWindowMs },
    // 【本卡 · 通知面卡会话豁免】索引来源留痕（dry-run / 观测都能看出"本轮豁免生效没"）
    cardSessionSource: {
      ok: cardIdx.ok, count: cardIdx.count, settledCount: cardIdx.settledCount,
      source: cardIdx.source, error: cardIdx.error ?? null,
    },
    summary,
    items,
    deliverable: items.filter((i) => i.emit).map((i) => i.sessionId),
  };
  if (steerActive) {
    summary.steer = steerCount.steer;
    summary.steerFallback = steerCount.fallback;
    out.steerGate = {
      ok: steerGate.ok === true,
      enabled: steerGate.enabled === true,
      configured: steerGate.configured === true,
      sessions: Array.isArray(steerGate.sessions) ? steerGate.sessions.length : 0,
      source: steerGate.source ?? null,
      error: steerGate.error ?? null,
    };
  }
  return out;
}

/** 精简单条计划（dry-run 记账 / 执行记账用；**必须可 JSON 化**）。 */
export function slimItem(item) {
  const out = {
    sessionId: item.sessionId, title: item.title, running: item.running,
    level: item.level, verdict: item.verdict, reason: item.reason,
    projectedTokens: item.projectedTokens, pressureTokens: item.pressureTokens,
    contextWindow: item.contextWindow, percent: item.percent,
    sigKey: item.sigKey, emit: item.emit, note: item.note,
  };
  // 【夜批03】投递通道只在 steer 决策路径激活时出现（默认关 ⇒ 键集与交付前逐字相同）
  if (item.delivery !== undefined && item.delivery !== null) out.delivery = item.delivery;
  if (item.steerReason !== undefined && item.steerReason !== null) out.steerReason = item.steerReason;
  return out;
}

/**
 * 预览形状（dry-run / 观察档的"将要做什么"）。
 * @returns {{action:string, mode:string, at:number, day:string, emit:boolean,
 *            softLimitTokens:number, hardLimitTokens:number, quota:object, summary:object,
 *            items:Array, truncated:number, note:string}}
 */
export function ctxGuardPreview(plan, opts = {}) {
  const maxItems = opts.maxItems ?? PREVIEW_MAX_ITEMS;
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const mode = opts.mode ?? plan?.mode ?? (plan?.emit ? 'emit' : 'observe');
  return {
    action: CTX_KIND,
    mode,
    at: opts.now ?? plan?.now ?? Date.now(),
    day: plan?.day ?? null,
    emit: plan?.emit === true,
    softLimitTokens: plan?.softLimitTokens ?? null,
    hardLimitTokens: plan?.hardLimitTokens ?? null,
    // 【本卡 · 通知面卡会话豁免】索引来源随预览/记账落出（生产 job 路径也能看出"本轮豁免生效没"）
    cardSessionSource: plan?.cardSessionSource ?? null,
    quota: plan?.quota ? { used: plan.quota.used, max: plan.quota.max, reached: plan.quota.reached } : null,
    summary: plan?.summary ?? null,
    items: items.slice(0, maxItems).map(slimItem),
    truncated: Math.max(0, items.length - maxItems),
    note: mode === 'observe'
      ? '观察档（emit=false）：只算不动 —— 以下 verdict=observe 的条目是若开启会投递的目标；**未消费任何去重/额度配额**，未产生任何真实注入'
      : 'dry-run：只算不动 —— 以下 emit=true 的条目就是若放行会被投递的目标；未产生任何真实注入',
  };
}

// ---------------------------------------------------------------- 动作入口（唯一闸门）

/** 读卡执行会话索引（**永不抛**；失败 → `ok:false` 空索引 = 不排除任何会话，fail-open）。 */
function readCardSessionIndexSafe(home) {
  try { return loadCardSessionIndex({ home }); } catch (e) { return emptyCardSessionIndex(e?.message ?? String(e), { source: 'ledger' }); }
}

/**
 * 跑一轮「上下文看门」动作。
 *
 * 四条路径（语义与 runAction 一致）：
 *   dryRun:true            → 永远可跑：只算不动，写一条 dry-run 影子记账，**零注入**
 *   emit:false（观察档）    → 同样零注入、零配额消费（红线①），只是语义上报 'observe'
 *   模块门关 / 四门任一关    → status='blocked'，**零副作用**（不写记账、不占额度、不注入）
 *   模块门开 + 有待投递会话  → 逐会话执行（每次 runAction：24h 去重 + 每日额度 + 预算门）
 *
 * @param {{
 *   home?:string, now?:number, dryRun?:boolean, emit?:boolean, baseUrl?:string,
 *   cfg?:object, limits?:object, state?:object, scan?:object, plan?:object, autonomy?:object,
 *   fetchImpl?:Function, deps?:{inject?:Function}, injectTimeoutMs?:number, executeTimeoutMs?:number,
 *   quiet?:boolean
 * }} spec
 */
export async function runCtxGuard(spec = {}, opts = {}) {
  const now = num(opts.now ?? spec.now, Date.now());
  const home = opts.home ?? spec.home ?? dshHome();
  const dryRun = spec.dryRun === true || opts.dryRun === true;
  // 红线①：dry-run 优先 —— 只有"显式要求投递"且不是 dry-run 时才真投递
  const emit = (spec.emit === true || opts.emit === true) && !dryRun;
  const quiet = spec.quiet === true || opts.quiet === true;
  const cfg = { ...DEFAULT_CONFIG, ...(spec.cfg ?? {}) };
  const limits = spec.limits ?? readLimits({ home });
  const state = spec.state ?? readActionsState({ home });

  const out = {
    kind: CTX_KIND, version: CTX_GUARD_VERSION, ok: true, dryRun, emit,
    status: null, reason: null, home, now, day: localDay(now),
    moduleGate: null, plan: null, action: null, preview: null,
    scan: null,   // { attempts, retries }：采集尝试次数旁证（2026-09-17 抖动收口）
    cardSessionSource: null,   // 【本卡】卡执行会话索引摘要（豁免是否生效的唯一旁证）
    quotaLedger: null,   // 【施工卡 ⑥-1】额度降级台账写入结果（{ok,written,skipped,error}）
    results: [], injected: 0, failed: 0, blocked: 0, noop: 0,
  };

  // 1) 只读采集（失败 → 本轮不规划，不写任何东西）
  //    【2026-09-17 抖动收口】重试参数可透传（默认 retries=1 / 1500ms，见 scanContext）；
  //    `spec.scan` 注入夹具时按旧口径走（夹具自报 attempts 缺失 → 记 1 次尝试）。
  const scan = spec.scan ?? await scanContext({
    home, cfg, baseUrl: spec.baseUrl, fetchImpl: spec.fetchImpl,
    retries: spec.retries, retryDelayMs: spec.retryDelayMs,
    // 【2026-11-08 · 数据源修复】补采参数透传（`probe:false` 即回到"只有列表投影"的老语义，
    //   夹具/离线演练用；`maxProbe` 默认 40，见 DEFAULT_PROBE_MAX）。
    probe: spec.probe, maxProbe: spec.maxProbe,
    probeConcurrency: spec.probeConcurrency, probeTimeoutMs: spec.probeTimeoutMs,
    probeBudgetMs: spec.probeBudgetMs,
  });
  out.scan = { attempts: num(scan.attempts, 1), retries: num(scan.retries, 0) };
  if (!scan.ok) return { ...out, ok: false, status: 'collect-failed', reason: scan.error };

  // 2) 规划（纯函数，零副作用）
  //   【卡执行会话豁免 / 2026-09-23】索引唯一源 = lib/card-session.mjs（账本只读）；
  //   读取失败 **不阻断** 本轮（fail-open：不排除任何会话，保持改动前语义）。
  const cardSessions = spec.cardSessions ?? readCardSessionIndexSafe(home);
  // 【夜批03 · 投递分级实现 / 2026-09-24】硬限插话开关（**只读**；复用上面已读的 limits，不二次读盘）。
  //   未配置 ⇒ `enabled:false` ⇒ plan 输出与交付前**逐字节相同**（连键都不多）。
  const steerGate = spec.steerGate ?? readSteerGate({ home, limits });
  const plan = spec.plan ?? planCtxGuard({
    sessions: scan.sessions, now, cfg, limits, state, emit, cardSessions, steerGate,
    // 【2026-11-08 · 数据源修复】把补采留痕带进判定层 → summary.dataSourceMissing（不许再静默）
    //   `spec.scan` 注入夹具时该字段缺失 ⇒ plan 不加那组键（纯函数测试逐字节不变）。
    pressureSource: scan.pressureSource,
  });
  out.plan = plan;
  out.cardSessionSource = plan?.cardSessionSource ?? null;
  // 【夜批03】只有在 steer 决策路径被激活时（开关开启 / 判据不可读）才回带 gate 摘要 ——
  //   默认关时 `out` 键集与交付前逐字相同（等价对照的一个判据）。
  if (plan?.steerGate !== undefined) out.steerGate = plan.steerGate;

  // 3) 模块级闸门（L0 降档 × L1 × L2）；dry-run / 观察档**不受闸门限制**（只算不动）
  const moduleGate = checkModuleAllowed(CTX_KIND, { home, autonomy: spec.autonomy });
  out.moduleGate = moduleGate;

  // 4a) 只算不动通道（dry-run 或观察档）：一条轮级影子记账，**零注入、零签名、零额度**（红线①）
  if (dryRun || !emit) {
    const mode = dryRun ? 'dry-run' : 'observe';
    const preview = spec.preview ?? ctxGuardPreview(plan, { now, mode });
    const r = await runAction({
      kind: CTX_KIND, level: CTX_LEVEL, dryRun: true, home, now,
      detail: preview, preview: () => preview,
    }, { home, now });
    out.action = r;
    out.status = mode;
    out.reason = dryRun
      ? 'dry-run 通道：只算不动（预览见 preview）'
      : `观察档（emit=false）：只算不投递，不消费去重/额度配额（${plan.summary.observe} 条本会投递）`;
    out.preview = preview;
    return out;
  }

  // 4b) 模块门（真执行路径才判）
  if (!moduleGate.allowed) {
    return {
      ...out, status: 'blocked',
      reason: `L2 模块闸门关闭：${moduleGate.reason}`,
      blocked: plan.summary.overSoft,
    };
  }

  // 4b-2) 【施工卡 ⑥-1 · ⑥ 包 §7.1③】额度降级台账：写在**共用执行函数内**（不是入口），
  //   位置固定在**模块门放行之后** —— 依据 ⑤ 包 §4.4-X2「先闸门后额度」：被闸门拦下的动作
  //   根本没轮到额度判定，记它 = 白记；dry-run / 观察档在上面已经 return（红线①：观察档不消费任何配额）。
  //   写失败**不阻断**本轮降级（appendQuotaDegrades 内部 alert(warn) 后返回 ok:false）。
  out.quotaLedger = appendQuotaDegrades(plan, { home, now });

  // 4c) 无待投递 → noop（不写签名、不占额度、零副作用）
  const targets = plan.items.filter((i) => i.emit);
  if (!targets.length) {
    return {
      ...out, status: 'noop',
      reason: `本轮无待投递会话（扫 ${plan.summary.sessions} 个会话：超软限 ${plan.summary.overSoft} / 在跑且超限 ${plan.summary.deliver + plan.summary.queue} / 去重跳过 ${plan.summary.deduped}）`,
    };
  }

  // 4d) 逐会话执行（每次 runAction：独立 sigKey + 独立占用每日额度）
  const inject = spec.deps?.inject ?? ((sid, text, o) => notifySession(sid, text, { baseUrl: spec.baseUrl, ...o }));
  for (const item of targets) {
    const r = await runAction({
      kind: CTX_KIND, level: CTX_LEVEL, dryRun: false, home, now,
      consumesQuota: true,
      sigKey: item.sigKey,
      detail: slimItem(item),
      // 【夜批03】revertHint 只在**真的走 steer** 时换文案（默认关 ⇒ 与交付前逐字相同）
      revertHint: item.delivery === 'steer'
        ? '本动作只注入提醒文本（steer 插话：当前 step 跑完时插入，不 abort 进行中的工具）：不改会话数据、不改看板、不改配置 → 要停就在 limits.ctxGuard.steer.enabled 关掉开关'
        : '本动作只注入提醒文本（queue 模式，排队不打断）：不改会话数据、不改看板、不改配置 → 误提醒忽略即可，无数据变更',
      execute: async () => injectOne(item, { inject, now, timeoutMs: spec.injectTimeoutMs }),
    }, { home, now, executeTimeoutMs: spec.executeTimeoutMs });
    out.results.push({
      sessionId: item.sessionId, level: item.level, status: r.status, reason: r.reason,
      ok: r.status === 'executed',
    });
    if (r.status === 'executed') out.injected += 1;
    else if (r.status === 'failed') { out.failed += 1; out.ok = false; }
    else if (r.status === 'noop') out.noop += 1;   // 去重窗口内跳过 / 每日上限（runAction 的护栏）
    else out.blocked += 1;                          // 闸门关闭
    if (quiet !== true) logLine(`投递 ${item.sessionId}（${item.level}）：${r.status} —— ${r.reason}`, { now, quiet });
  }
  out.action = out.results.length
    ? { kind: CTX_KIND, status: out.failed ? 'failed' : (out.injected ? 'executed' : 'blocked') }
    : null;
  out.status = out.failed
    ? 'failed'
    : (out.injected ? 'executed' : ((out.noop > 0 && out.blocked === 0) ? 'noop' : 'blocked'));
  // 【2026-09-16 拷问 1.7】原文案写「有 N 条投递失败（下轮重试）」——与当时的实现**自相矛盾**：
  //   那时失败也照写 24h 签名 + 占每日额度 ⇒ 下轮不但不会重试，还会被自己的去重窗口挡住。
  //   现在两件事对齐成一句客观描述：失败不写签名、不占额度 ⇒ 下轮**确实**会重新评估（但不承诺必然投递，
  //   要不要投由下一轮的压力判定说了算）。措辞只陈述事实，不吹"会自动重试"。
  out.reason = out.failed
    ? `有 ${out.failed} 条投递失败（本轮未投出；失败不写 24h 签名、不占每日额度，下轮按当时压力重新评估）`
    : (out.injected
      ? `已投递 ${out.injected} 条上下文看门提醒`
      : ((out.noop > 0 && out.blocked === 0) ? `全部跳过（去重窗口 / 已达上限）：${out.noop} 条` : `全部被闸门挡住：${out.blocked} 条`));
  return out;
}

/** 单条投递（execute 体；只在闸门放行后被 runAction 调用）。 */
async function injectOne(item, ctx) {
  const { inject, timeoutMs } = ctx;
  const text = item.text ?? formatCtxGuardText(item);
  // 【夜批03】投递方式只由 `item.delivery` 决定（plan 已判完）：
  //   `'steer'` = step 边界插话（**不 abort 工具**）；其余（含默认）⇒ queue —— 且 queue 时**不传 mode**，
  //   保证注入参数与交付前逐字相同（`notifySession` 的默认值即 `'queue'`）。
  const steer = item?.delivery === 'steer';
  const opts = { timeoutMs: timeoutMs ?? 10_000 };
  if (steer) opts.mode = 'steer';
  const r = await inject(item.sessionId, text, opts);
  const ok = r?.ok === true;
  const out = {
    kind: CTX_KIND, ok, injected: ok ? 1 : 0, failed: ok ? 0 : 1,
    sessionId: item.sessionId, level: item.level,
    error: ok ? null : (r?.error ?? 'inject-failed'),
    note: steer
      ? 'steer 插话（当前 step 跑完时插入，不 abort 进行中的工具）'
      : 'queue 模式投递（排队等当前回合结束，不打断）',
  };
  // 【夜批03】投递通道字段**只在 steer 决策路径激活时出现**（默认关 ⇒ 返回值键集与交付前逐字相同，
  //   这是"默认关逐字节等价"的一部分：记账文件里不多一个字段）。
  if (item?.delivery !== undefined) {
    out.delivery = steer ? 'steer' : 'queue';
    out.steerReason = item?.steerReason ?? null;
  }
  return out;
}

/** 一轮摘要（CLI / 报表用；纯只读）。 */
export function summarizeCtxGuard(result) {
  const p = result?.plan ?? null;
  const s = p?.summary ?? {
    sessions: 0, running: 0, overSoft: 0, soft: 0, hard: 0, deliver: 0, queue: 0, observe: 0, skip: 0,
    noPressure: 0, notRunning: 0, deduped: 0, underSoft: 0, cardSession: 0,
  };
  const out = {
    kind: CTX_KIND, mode: p?.mode ?? null, dryRun: result?.dryRun === true, emit: result?.emit === true,
    status: result?.status ?? null, reason: result?.reason ?? null,
    sessions: s.sessions, running: s.running, overSoft: s.overSoft, soft: s.soft, hard: s.hard,
    deliver: s.deliver, queue: s.queue, observe: s.observe, skip: s.skip,
    noPressure: s.noPressure, notRunning: s.notRunning, deduped: s.deduped, underSoft: s.underSoft,
    // 【本卡 · 通知面卡会话豁免】卡执行会话被豁免的条数 + 索引来源（dry-run 对照用）
    cardSession: s.cardSession ?? 0,
    // 【2026-11-08 · 数据源修复】上下文规模采集留痕 + 「数据源消失」**显式**标记。
    //   `null` = 本轮没有补采样本（夹具/关掉补采），不是"没问题"、也不是"有问题"。
    dataSourceMissing: s.dataSourceMissing ?? null,
    dataSourceNote: s.dataSourceNote ?? null,
    dataSourceAttempted: s.dataSourceAttempted ?? null,
    dataSourceReadable: s.dataSourceReadable ?? null,
    dataSourceAbsent: s.dataSourceAbsent ?? null,
    dataSourceUnreadable: s.dataSourceUnreadable ?? null,
    pressureFromList: s.pressureFromList ?? null,
    pressureFromProbe: s.pressureFromProbe ?? null,
    cardSessionSource: result?.cardSessionSource ?? p?.cardSessionSource ?? null,
    softLimitTokens: p?.softLimitTokens ?? null, hardLimitTokens: p?.hardLimitTokens ?? null,
    quota: p?.quota ?? null,
    injected: result?.injected ?? 0, failed: result?.failed ?? 0,
    blocked: result?.blocked ?? 0, noop: result?.noop ?? 0,
    moduleGate: result?.moduleGate?.reason ?? null,
  };
  // 【夜批03】steer 计数/开关摘要只在决策路径激活时出现（默认关 ⇒ 键集与交付前逐字相同）
  if (s.steer !== undefined) {
    out.steer = s.steer;
    out.steerFallback = s.steerFallback ?? 0;
    out.steerGate = result?.steerGate ?? p?.steerGate ?? null;
  }
  return out;
}

/** 人读报告行（CLI 非 --json 时用；不写盘）。 */
export function formatCtxGuardReport(result) {
  const s = summarizeCtxGuard(result);
  const lines = [];
  lines.push(`🐳 上下文看门（ctx-guard）· ${String(s.status ?? '?').toUpperCase()}${s.dryRun ? ' · DRY-RUN（只算不动）' : ''}`);
  lines.push(`  软限 ${fmtTokens(s.softLimitTokens)} / 硬限 ${fmtTokens(s.hardLimitTokens)} · 档位 ${s.mode}`
    + `（emit=${s.emit ? 'true' : 'false'}）· 额度 ${s.quota?.used ?? 0}/${s.quota?.max ?? '?'}`);
  lines.push(`  扫 ${s.sessions} 个会话（在跑 ${s.running}）→ 超软限 ${s.overSoft}（soft ${s.soft} / hard ${s.hard}）`
    + ` · 本次投递 ${s.deliver} / 排队 ${s.queue} / 观察 ${s.observe} / 跳过 ${s.skip}`);
  if (s.moduleGate) lines.push(`  模块门：${s.moduleGate}`);
  // 【2026-11-08 · 数据源修复】**绝不静默**：拿不到上下文规模的比例异常时大字报出来。
  //   这一行就是"这次失效整整一轮没人发现"的解药 —— 它出现在日报段里，眼睛能看见。
  if (s.dataSourceMissing === true) {
    lines.push(`  🔴 数据源告警（dataSourceMissing）：读数可用的 ${s.dataSourceReadable ?? '?'} 条里`
      + ` ${s.dataSourceAbsent ?? '?'} 条**投影键 contextPressure 直接不见** —— ${s.dataSourceNote ?? ''}。`
      + ' **本轮的"无上下文压力"不可信，先查主包投影是否又改名/摘掉 summary**（见 lib/ctx-guard.mjs 文件头【数据源订正】）。');
  } else if (s.dataSourceAttempted !== null && s.dataSourceAttempted !== undefined) {
    lines.push(`  上下文规模来源：列表投影 ${s.pressureFromList ?? 0} 条 / 逐会话补采 ${s.pressureFromProbe ?? 0} 条`
      + `（补采尝试 ${s.dataSourceAttempted}，可用 ${s.dataSourceReadable ?? 0}，`
      + `投影缺失 ${s.dataSourceAbsent ?? 0}，读失败 ${s.dataSourceUnreadable ?? 0}）`);
  }
  // 【夜批03】硬限插话档（只在决策路径激活时输出，默认关 ⇒ 报告文本与交付前逐字相同）
  if (s.steer !== undefined) {
    const g = s.steerGate ?? {};
    lines.push(`  硬限插话（steer）：${g.enabled === true ? '已开' : (g.ok === false ? '判据不可用（fail-open）' : '关（默认）')}`
      + ` · 本次 steer ${s.steer ?? 0} / 回落 queue ${s.steerFallback ?? 0}`
      + `（豁免名单 ${g.sessions ?? 0} 条）`);
  }
  lines.push(`  原因：${s.reason ?? '-'}`);
  const items = result?.plan?.items ?? [];
  for (const it of items.filter((x) => x.verdict !== 'skip').slice(0, PREVIEW_MAX_ITEMS)) {
    lines.push(`   · [${it.verdict}] ${it.sessionId} ${it.percent ?? '?'}%（${fmtTokens(it.projectedTokens)}）`
      + `${it.level ? ` ${it.level}` : ''} —— ${it.note}`);
  }
  return lines.join('\n');
}
