#!/usr/bin/env node
// dsh-butler / restart-coordinator.mjs —— P0 重启统筹协调器（卡 [1]）
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §4 P0（行 380-433）
// 形态：**短命 tick**（计划任务 DSH-Butler-RestartTick 每分钟一次，窗口隐藏），无常驻进程。
//
// 一次 tick 的流程：
//   0. 版本闸门（gateComponent）→ 不匹配跳过该组件 + 告警
//   1. tick 互斥锁（抢不到 = 静默退出，exit 0）
//   2. 写心跳（管家健康监控据此判「协调器被停/被拦」）
//   3. 维护窗口处理（优先）：就绪 → 清窗口 + 补发通知；超时 → 🔴 未正常结束
//   4. 读 <tmp>\dsh-guard\restart-request.json（无请求 <100ms 快速退出）
//   5. 过期清理（24h 未执行自动作废）
//   6. 扫描会话 → 活跃判定（排除发起者）→ 低水位 / 合并批次
//   7. 空闲或 force → 写维护窗口 → 取打断快照 → 调 dsh-restart.ps1 → 等就绪 → 多播通知 + 写打断清单
//      排队 → 落排队状态（面板读）+ 超 30 分钟提醒一次
//
// 三条硬约束（不得违反）：
//   1. 重启 = 硬杀（taskkill /F），无优雅退出。
//   2. 「通知活跃会话快收尾」禁止——发消息会让会话重新变活跃（产生新回合），协调器永远等不到空闲。
//      （重启完成后的多播通知不在此列：那时会话已被重启，queue 不会制造干扰空闲判定的回合。）
//   3. 发起重启的会话自身必然在跑 → 活跃判定必须排除发起者。
//
// 禁止项（方案 §4）：不动守护鱼代码；不新增常驻进程；不在无守护鱼时 taskkill dsh。
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import { hostRpc, hostRpcJson } from '../src/lib/dsh-host-rpc.mjs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { dshHome, ensureDir, realOrResolve } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { readJson, updateJson, writeJsonAtomic, acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { updateStateJson } from '../src/dsh-butler/lib/dual-write-store.mjs';
import { appendAudit } from '../src/dsh-butler/lib/audit.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { gateComponent } from '../src/dsh-butler/lib/version.mjs';
// T2（§17.1）：交接窗口内协调器必须回 busy、不得发起重启（判定在纯函数库里，便于单测）
import { restartGuard } from '../src/dsh-butler/lib/handoff-version-gate.mjs';
import {
  RESTART_VERSION, RESTART_STATE_SCHEMA, RESTART_REQUEST_SCHEMA,
  DEFAULT_POLICY, TURN_BOUNDARY_TYPES, SESSION_END_TYPES,
  isSessionActive, planRestart, isRequestExpired,
  makeMaintenanceWindow, writeMaintenanceWindow, readMaintenanceWindow, clearMaintenanceWindow, maintenancePhase, isReady,
  buildInterruptionList, interruptionNotice, completionNotice, queueNotice, inFallbackWindow,
  // [Q4] v0.1.2：活跃集合多源并集（文件判据 + 主包 running + 看板 running 卡）
  mergeActiveSources, extractRunningCardSessions,
  // [D17 / 2026-09-23] 旁路通知（近 N 分钟有活动但重启瞬间没在跑的会话 → 补一条自查提醒）
  selectStaleWaitSessions, staleWaitNotice, normSessionId, scanSessionActivityTimes,
  // 【修·V3判据① / 2026-09-24】会话日志族名的**唯一源**（旧名 session.jsonl.zstd / 新名 session.v3.jsonl.zstd）
  scanSessionLogFiles,
  // 【加急档·A2 / 2026-09-28】执行层：软保护求值（独立 v3 输入面 · D-3=a）+ 排队提醒指纹（§3.8）
  //   + 红线断言（J3：打断清单里不得出现"非发起者"的卡执行会话 ⇒ 审计 `interruptedCards` 恒 0）
  evaluateSoftProtect, remindFingerprint, findInterruptedCardViolations,
  // 【加急档·A4 前置 / 2026-09-28】每日升档上限：本地日切键（唯一源）+ 闸门 reason 常量
  localDayKey, URGENT_DAILY_REASONS,
  // 【加急档·A4 放行 / 2026-09-28】策略求值唯一入口（策略文件 ⊕ 显式 opts.policy ⊕ DEFAULT_POLICY）
  //   `loadRestartPolicy` 也在此导出，供 CLI / 预演脚本读"当前放行值"用
  resolveRestartPolicy, loadRestartPolicy,
} from '../src/dsh-butler/lib/restart.mjs';
// 【本卡 · 通知面卡会话豁免 / 2026-09-23】卡执行会话判定唯一源（fail-open：拿不到索引 ⇒ 不排除任何人）
import { emptyCardSessionIndex, loadCardSessionIndex } from '../src/dsh-butler/lib/card-session.mjs';

export const VERSION = RESTART_VERSION;
export const TICK_NAME = 'restart-coordinator';
export const TASK_NAME = 'DSH-Butler-RestartTick';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DEFAULT_DSH_URL = 'http://localhost:3080';
const RESTART_SCRIPT = path.join(workspaceRoot(), 'dsh-restart.ps1');
// dsh-restart.ps1 每次运行都会写这一行日志（mtime = 运行时刻）—— 用它当"重启到底有没有发生"的足迹，
// 判断孤儿 executing 该结算还是该重试（2026-09-11 幽灵重启修复）。
const RESTART_LOG_PATH = path.join(workspaceRoot(), 'logs', 'dsh-restart.log');

// ------------------------------------------------------------------ 路径

function guardDir() {
  return path.join(process.env.TEMP || os.tmpdir(), 'dsh-guard');
}
function requestFilePath() {
  return path.join(guardDir(), 'restart-request.json');
}
function stateFilePath(home) {
  return resolveStatePath('butler-restart-state.json', { home }).path;
}

/** 默认状态骨架。 */
export function emptyState() {
  return {
    schemaVersion: RESTART_STATE_SCHEMA,
    heartbeat: null,
    queue: null,
    pendingNotify: null,
    lastBatch: null,
    counters: { ticks: 0, restarts: 0, queued: 0, expired: 0, notified: 0 },
    reminded: [],
  };
}

// ══════════════════════════════════════════════════════════════════════════
// ★【G33·加急档 · A4 前置 · 2026-09-28】每日升档**计数器**（复审 R-4 三件之二）
//   真源口径：方案 `docs\重启闸门加急档-方案-20260922.md` §3.3（`urgentMaxPerDay` = 拍板 5 次/天）
//   ＋ 复审 R-4「放行前必须有计数器 + 闸门 + 可见性」。
//   ⚠️ **不是开关、不改任何生效语义**：计数器只在**已经决定要执行加急档**时记账；闸门（判据层
//      `gateUrgentEscalation`）在达上限时**拒绝升档、退回 queue 档**。升档本身仍默认关
//      （`urgentEscalateMs: null`）⇒ 放行 = A4（乙档 · 等主人拍板）。
//   ⚠️ **落点同源**：写**本组件既有状态文件**（`butler-restart-state.json`）的顶层 `urgent` 段，
//      **不另起新根、不新增开关**；日切 = 本地时区（`lib\restart.mjs#localDayKey`，唯一源）。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 读**当日**加急计数（只读；dry-run 也安全）。
 *
 * @returns {{ok:boolean, day:string, counterDay:string|null, used:number, escalated:number,
 *            explicit:number, denied:number, limit:number, reset:boolean, error?:string}}
 *
 * 【跨日重置口径】**不做后台清零任务**：读时如果 `urgent.day !== 今天` ⇒ `used` 视为 0
 *   （`reset:true` 仅表示"文件里那份是旧日期的"，下次写入时自然被新一天覆盖）；
 *   这样"昨天用满 5 次"绝不会误挡今天，也不需要一个常驻清零器。
 * 【fail-safe 方向】文件损坏 / 读失败 ⇒ `ok:false`（**不是** ok:true+0）⇒ 闸门据此**拒绝升档**。
 *   读不到就当"额度不明" ⇒ 宁可不升档，也不让上限形同虚设（与软保护 `unavailable` 同向）。
 */
export function readUrgentDaily(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const today = localDayKey(now);
  const p = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const nLimit = Number(p.urgentMaxPerDay);
  const limit = (Number.isFinite(nLimit) && nLimit >= 0) ? nLimit : Number(DEFAULT_POLICY.urgentMaxPerDay);
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  try {
    const st = readJson(stateFilePath(home), { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() }) ?? emptyState();
    const cur = st.urgent ?? null;
    const counterDay = (typeof cur?.day === 'string' && cur.day) ? cur.day : null;
    const sameDay = counterDay === today;
    return {
      ok: true, day: today, counterDay, reset: counterDay !== null && !sameDay, limit,
      used: sameDay ? n(cur?.escalated) : 0,
      escalated: sameDay ? n(cur?.escalated) : 0,
      explicit: sameDay ? n(cur?.explicit) : 0,
      denied: sameDay ? n(cur?.denied) : 0,
    };
  } catch (e) {
    return {
      ok: false, day: today, counterDay: null, used: 0, escalated: 0, explicit: 0, denied: 0, limit, reset: false,
      error: String(e?.message ?? e),
    };
  }
}

/**
 * 当日加急计数 **+1**（原子读-改-写；跨日自动开新的一天）。
 *
 * @param {{home?:string, now?:number, policy?:object, kind?:'escalated'|'explicit'|'denied'}} opts
 * @returns {{ok:boolean, day:string, escalated:number, explicit:number, denied:number,
 *            limit:number, lastKind:string, error?:string}}
 *
 * 【为什么执行前才算】口径 = 「**每天最多执行几次**」（方案 §3.3 字面）⇒ 记账点必须在
 *   "已经决定执行、且执行前校验也过了"之后、"真的动进程"之前 —— 判定阶段只读不写。
 * 【写失败不静默】返回 `ok:false`，调用方**必须**放弃本次升档执行 + 落审计
 *   （`restart-urgent-counter-failed`）：计数写不进 = 上限不可信 ⇒ 宁可不升档。
 */
export function bumpUrgentDaily(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const kind = ['escalated', 'explicit', 'denied'].includes(opts.kind) ? opts.kind : 'escalated';
  const today = localDayKey(now);
  const p = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const nLimit = Number(p.urgentMaxPerDay);
  const limit = (Number.isFinite(nLimit) && nLimit >= 0) ? nLimit : Number(DEFAULT_POLICY.urgentMaxPerDay);
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  try {
    const next = updateStateJson('butler-restart-state.json', stateFilePath(home), (cur) => {
      const s = { ...emptyState(), ...(cur ?? {}) };
      const prev = (s.urgent && s.urgent.day === today) ? s.urgent : null;
      const cell = {
        day: today,
        escalated: n(prev?.escalated) + (kind === 'escalated' ? 1 : 0),
        explicit: n(prev?.explicit) + (kind === 'explicit' ? 1 : 0),
        denied: n(prev?.denied) + (kind === 'denied' ? 1 : 0),
        limit,
        lastAt: now,
        lastKind: kind,
      };
      return { ...s, urgent: cell };
    }, { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() });
    return {
      ok: true, day: today,
      escalated: n(next?.urgent?.escalated), explicit: n(next?.urgent?.explicit), denied: n(next?.urgent?.denied),
      limit: Number.isFinite(Number(next?.urgent?.limit)) ? Number(next.urgent.limit) : limit,
      lastKind: kind,
    };
  } catch (e) {
    return { ok: false, day: today, escalated: 0, explicit: 0, denied: 0, limit, lastKind: kind, error: String(e?.message ?? e) };
  }
}

// ------------------------------------------------------------------ 会话扫描（spike A15 结论：目录名 = sessionId）

/**
 * 枚举 <home>/sessions/<workspace>/<sessionId>/ 的会话日志，**每个会话目录取同族最新 mtime 的那个**
 * （认全世代：旧名 `session.jsonl.zstd` / 当前名 `session.v3.jsonl.zstd` / 未来 `session.vN…`；
 * 判据的**生态单一真源** = `tools/lib/session-file-name.mjs`，本函数经 `lib/restart.mjs#scanSessionLogFiles`
 * 消费它 —— 全生态只准有一套判据，别在这里另写正则）。
 *
 * 【为什么改 · 2026-09-24「修·V3判据①」】旧实现把旧文件名写死、`statSync` 不到就 `continue`
 * ⇒ 主包 0.1.5 换代后 **v3 会话目录整条被跳过**（生产实测：227 个会话目录**全部**只有
 * `session.v3.jsonl.zstd` ⇒ 本函数返回 0 行）⇒ `collectSessions()` → `mergeActiveSources`
 * 的「活跃判定文件源」恒空（夜批·10 卡生产实测 `sources.file=0`）。
 * 返回结构不变（`{sessionId, workspace, file, mtimeMs, size}`）⇒ 下游 `readTailEvents(file)` 自动跟随。
 */
export function scanSessionDirs(home) {
  const out = [];
  for (const rec of scanSessionLogFiles(home).values()) {
    out.push({ sessionId: rec.sessionId, workspace: rec.workspace, file: rec.filePath, mtimeMs: rec.mtimeMs, size: rec.size });
  }
  return out;
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return read === length ? buf : buf.subarray(0, read);
  } finally { fs.closeSync(fd); }
}

function parseJsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j.type === 'string') out.push(j);
    } catch { /* 半截行跳过 */ }
  }
  return out;
}

/**
 * 读会话尾部事件（只解尾部若干帧；遇到回合边界即停 → 单会话通常 1-3 帧）。
 * v0.1.2（[Q4]）新增 `newestFrameBad`：最新一段解压失败（读取时正在写入的半截帧、
 * 或压缩数据里出现假 magic 导致切分错位）时置 true，交给 isSessionActive 保守处理。
 * @returns {{events:object[], truncated:boolean, frames:number, newestFrameBad:boolean, error?:string}}
 */
export function readTailEvents(file, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_POLICY.tailBytes;
  let st;
  try { st = fs.statSync(file); } catch (e) { return { events: [], truncated: false, frames: 0, newestFrameBad: false, error: e?.code ?? 'stat' }; }
  let limit = Math.min(maxBytes, st.size);
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = Math.max(0, st.size - limit);
    const buf = readRange(file, start, st.size - start);
    const offsets = [];
    let i = buf.indexOf(ZSTD_MAGIC, 0);
    while (i !== -1) { offsets.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 1); }
    if (!offsets.length) {
      if (start === 0) return { events: [], truncated: false, frames: 0, newestFrameBad: false };
      limit = st.size; continue;
    }
    const collected = [];
    let boundary = false;
    let frames = 0;
    let newestFrameBad = false;
    for (let k = offsets.length - 1; k >= 0; k--) {
      const s = offsets[k];
      const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
      let text;
      try { text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); }
      catch {
        // ⚠️ 别悄悄回落到更早的回合边界——那会把"正在写日志的活跃会话"判成"回合已收尾"（[Q4] 同类漏判）
        if (k === offsets.length - 1) newestFrameBad = true;
        continue;
      }
      frames++;
      const recs = parseJsonLines(text);
      if (recs.length) collected.unshift(...recs);
      // 解压成功却一行事件都解析不出来（半截/损坏/错位）→ 与解压失败同样是"最新帧读不出来"
      else if (k === offsets.length - 1) newestFrameBad = true;
      if (recs.some((r) => TURN_BOUNDARY_TYPES.has(r.type) || SESSION_END_TYPES.has(r.type))) { boundary = true; break; }
    }
    if (boundary || start === 0) {
      collected.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
      return { events: collected, truncated: start > 0, frames, newestFrameBad };
    }
    limit = st.size; // 尾部窗口内没有边界 → 扩到全文件再试一次
  }
  return { events: [], truncated: true, frames: 0, newestFrameBad: false };
}

/**
 * 会话标题状态前缀（主人 2026-09-11 定）：标题形如「【运行】xxx」= 正在跑，「【完成】xxx」= 已收尾。
 * 生产者是会话自己（agent 用 tools/session-mark.mjs 打标；被硬杀时来不及改回【完成】，
 * 标题卡在【运行】正是「被打断」的客观证据）。这里只做**读取与展示**：
 * **不参与低水位闸门判定**（[Q4] 后仍不参与）—— 标记靠 agent 自觉，忘了打【完成】就会让重启永远排队；
 * 参与判定的是三源并集：文件判据 / 主包 running / 看板 running 卡（见 lib/restart.mjs mergeActiveSources）。
 */
export const TITLE_MARKS = { '【运行】': 'running', '【完成】': 'done' };
export function titleMark(title) {
  const t = String(title ?? '').trim();
  for (const [prefix, state] of Object.entries(TITLE_MARKS)) if (t.startsWith(prefix)) return state;
  return null;
}

/**
 * 收集全部会话的活跃状态（**只做文件判据**；多源并集见 lib/restart.mjs mergeActiveSources）。
 * 优化：mtime 早于 activeMtimeMs 的会话不读文件（活跃判定本就要求新鲜）。
 *
 * v0.1.2（[Q4]）⚠️ 调用方必须传**判定时刻的即时时钟**当 now：旧实现传 tick 启动时刻 t0，
 * 而 t0 到这里的 HTTP 往返实测 0.8–11.6 秒，期间活跃会话写文件 → mtime 越过 t0 →
 * `now - mtime < 0` → 旧判据 `ageMs >= 0` 把它判成 stale（越活跃越漏判）。
 */
export function collectSessions(opts = {}) {
  const home = opts.home ?? dshHome();
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const now = opts.now ?? Date.now();
  const titles = opts.titles ?? new Map();
  const rows = [];
  for (const d of scanSessionDirs(home)) {
    const ageMs = now - d.mtimeMs;
    const title = titles.get(d.sessionId) ?? '';
    // v0.1.2（[Q4] 根因修复）：负 ageMs = 文件在 now 之后被写过 = 刚写完，**最新鲜**，不是过期。
    if (!(ageMs < policy.activeMtimeMs)) {
      rows.push({ ...d, title, mark: titleMark(title), active: false, state: 'stale', tail: null, lastType: null, ageMs, reason: `stale(${Math.round(ageMs / 1000)}s)` });
      continue;
    }
    const tail = readTailEvents(d.file, { maxBytes: policy.tailBytes });
    const v = isSessionActive(tail.events, { now, mtimeMs: d.mtimeMs, policy, newestFrameBad: tail.newestFrameBad === true });
    rows.push({ ...d, title, mark: titleMark(title), active: v.active, state: v.state, tail: v.tail, lastType: v.lastType, ageMs: v.ageMs, reason: v.reason });
  }
  return rows;
}

/**
 * 读看板「正在执行的卡」的执行会话（[Q4]）；纯只读，绝不改 ledger。
 * 账本损坏/缺失 → 返回空 Map（不阻塞重启：文件判据 + 主包 running 仍在）。
 * @returns {{map:Map<string,object>, ok:boolean, error?:string, file:string}}
 */
export function readBoardCardSessions(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.ledgerPath ?? path.join(home, 'task-board', 'ledger-v2.json');
  try {
    const raw = opts.ledger ?? JSON.parse(fs.readFileSync(file, 'utf8'));
    return { map: extractRunningCardSessions(raw), ok: true, file };
  } catch (e) {
    return { map: new Map(), ok: false, error: e?.code ?? e?.message ?? String(e), file };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 【加急档（分层低水位）· 卡【加急档·A2】执行层 / 2026-09-28】
//   方案 §3.2 判据 / §3.4 红线 2 + 红线 3 / §3.7 可观测 / §5 J10；复审 R-1（真传账本 + degraded 可见）。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 卡执行会话索引（**账本全量 · fail-safe 方向**）—— 加急档"可打断性"判据的输入。
 *
 * 【为什么与 `readBoardCardSessions` 分开】两者**故意不同源、不同方向**：
 *   · `readBoardCardSessions`（活跃判定用，`board-card` 源）= 只认 `status==='running'` 卡 + **fail-open**
 *     （账本读不到 ⇒ 不计入活跃，不阻塞重启）；
 *   · 本函数（**可打断性判定**用）= 账本**全量**卡执行会话（`extractAllCardSessions`，不看卡状态）
 *     + **fail-safe**（账本读不到 ⇒ `ok:false` ⇒ 消费侧一律判为卡执行会话 ⇒ **不打断**）。
 *   理由（红线 2）：卡被**假结算**成 `review` 时执行会话可能仍在跑，只看 running 会把它误判成
 *   "非卡会话"而打断 ⇒ 制造新的假结算。方向语义的**唯一实现在 `lib/card-session.mjs`**，此处只传方向。
 *
 * ⚠️ 复审 R-1 的教训：**必须真把索引传进 `planRestart()`**；不传 ⇒ `classifyActiveByCard` 落 `degraded`
 *   ⇒ 全部活跃判为卡会话 ⇒ 加急档**永不执行且不可见**。故本函数的结果同时进决策、审计与面板。
 *
 * @returns {{index:object, ok:boolean, error:string|null, count:number}}
 */
export function loadFailSafeCardIndex(opts = {}) {
  try {
    const index = loadCardSessionIndex({ home: opts.home ?? dshHome(), direction: 'fail-safe' });
    return { index, ok: index.ok === true, error: index.error ?? null, count: index.bySession?.size ?? 0 };
  } catch (e) {
    const index = emptyCardSessionIndex(e?.message ?? String(e), { source: 'ledger', direction: 'fail-safe' });
    return { index, ok: false, error: index.error ?? String(e), count: 0 };
  }
}

/**
 * **执行前二次校验**（方案 §3.4 红线 3 / J10 判据；纯判据，不写任何状态、不碰进程）。
 *
 * 【为什么需要】`planRestart()` 的判定发生在 **`judgeNow`**，而真正调脚本在之后（DSH 忙时 HTTP
 *   往返历史 0.8–11.6 秒）。这段窗口里**新起的卡执行会话**（新 run 的卡）会让 `cardActive` 从 0 变正
 *   ⇒ 照旧执行就会**打断真在跑的卡**（假结算）。故在执行时刻用**同一判据**再算一次。
 *
 * 【校验点必须早于】`makeMaintenanceWindow()` / `writeMaintenanceWindow()` / 批次状态落盘 /
 *   请求标 `executing` / 调 `dsh-restart.ps1` —— 否则 abort 会留下"请求 executing 但重启没发生"的
 *   脏状态（只能靠 `classifyStaleExecuting()` 事后兜）。调用点见 `tick()` 的 7.5 段。
 *
 * 【判据】重新扫会话（文件源）+ 复用主包 running 视图 + 重新读看板 running 卡 ⇒ 三源并集 ⇒
 *   `planRestart()` 再跑一遍（**软保护也重算**：决策后主人开始打字的会话同样要放过）：
 *   · `plan2.action === 'restart'` ⇒ 放行；
 *   · 卡执行会话 > 0 ⇒ `aborted-late-card`（方案写死的 reason）；
 *   · 软保护导致排队 ⇒ `aborted-late-hold-user-input`；
 *   · 其它（普通活跃会话重新出现）⇒ `aborted-late-active`。
 *   ⚠️ 后两条是**本卡自决的收严**（方案原文只定义 `aborted-late-card`）：方向上只多等一个 tick，
 *      不会多打断任何人 ⇒ 属 fail-safe 一侧；已登记在交付报告「口径补充」段。
 *   ⚠️ **force 档不校验**（红线 1 的唯一例外：人工显式强制 = 全打断，是它自己的语义）。
 *
 * @returns {{aborted:boolean, reason:string|null, cardActive:string[], heldForUserInput:number,
 *            holdIds:string[], newActive:number, plan2Action:string, plan2Reason:string,
 *            cardSessionIndexOk:boolean, cardSessionDegraded:boolean, softProtectMode:string|null,
 *            scanned:number, sources:object|null, error:string|null}}
 *
 * ⚠️ 调用方**不要**传决策时刻的 `cardIdx`：本函数必须**重新读账本 + 重新扫会话**，才可能看见
 *   "决策之后新起的卡"（传旧索引 = 校验形同虚设 —— 这是实现红线，不是优化点）。
 *   单测可直接传 `cardIdx` 构造夹具（测试专用）。
 */
export function revalidateBeforeExecute(opts = {}) {
  const home = opts.home ?? dshHome();
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const live = Array.isArray(opts.live) ? opts.live : [];
  const views = opts.views ?? { titles: new Map(), runningIds: new Set(), listedIds: new Set(), rpcOk: false };
  const base = {
    aborted: false, reason: null, cardActive: [], heldForUserInput: 0, holdIds: [], newActive: 0,
    plan2Action: null, plan2Reason: null, cardSessionIndexOk: false, cardSessionDegraded: true,
    softProtectMode: null, scanned: 0, sources: null, error: null,
  };
  try {
    const board = readBoardCardSessions({ home });
    const scanned = collectSessions({ home, now, policy, titles: views.titles });
    const merged = mergeActiveSources(scanned, {
      runningIds: views.runningIds, listedSessionIds: views.listedIds, sessionListKnown: views.rpcOk === true,
      cardSessionIds: board.map, now, policy,
    });
    const idx = opts.cardIdx ?? loadFailSafeCardIndex({ home }).index;
    // 第一趟：拿到"新的非卡活跃集合"（软保护的输入是 `active − cardActive`）
    //   【A4 前置】`urgentDaily` 与本 tick 主判定**同一次读到的额度**（tick 有互斥锁 ⇒ 同 tick 内不会漂移）；
    //   不透传的话二次校验会把"已达上限"的升档重新翻回来 ⇒ 绕过闸门。
    const plan2a = planRestart({ requests: live, sessions: merged.sessions, now, policy, cardSessions: idx, urgentDaily: opts.urgentDaily ?? null });
    let soft;
    try {
      soft = evaluateSoftProtect(plan2a.softActive, { home, now, policy });
    } catch (e) {
      soft = {
        mode: 'unavailable', holdSessionIds: new Set(), holdIds: [], holdCount: 0,
        disabled: false, unavailable: true, windowMs: null, source: `eval-error:${e?.message ?? e}`,
      };
    }
    const plan2 = planRestart({ requests: live, sessions: merged.sessions, now, policy, cardSessions: idx, softProtect: soft, urgentDaily: opts.urgentDaily ?? null });
    const cardActive = (plan2.cardActive ?? []).map((s) => normSessionId(s?.sessionId)).filter(Boolean);
    const holdIds = [...(plan2.softProtect?.holdSessionIds ?? [])];
    const plan2Reason = String(plan2.reason ?? '');
    let reason = null;
    if (plan2.action !== 'restart') {
      if (plan2Reason.includes('waiting-cards')) reason = 'aborted-late-card';
      else if (plan2Reason === 'soft-protect-unavailable' || plan2Reason.includes('hold-user-input')) reason = 'aborted-late-hold-user-input';
      else reason = 'aborted-late-active';
    }
    return {
      ...base,
      aborted: reason !== null, reason,
      cardActive, heldForUserInput: holdIds.length, holdIds,
      newActive: merged.active.length,
      plan2Action: plan2.action, plan2Reason,
      cardSessionIndexOk: plan2.cardSessionIndexOk === true,
      cardSessionDegraded: plan2.cardSessionDegraded === true,
      softProtectMode: plan2.softProtect?.mode ?? null,
      scanned: scanned.length,
      sources: { file: merged.stats.file, agentRunning: merged.stats.agentRunning, boardCard: merged.stats.boardCard, hostLivenessKnown: merged.stats.hostLivenessKnown },
    };
  } catch (e) {
    // 校验自身出错 ⇒ **fail-safe：不执行本轮**（宁可多等一分钟，也不在"判据不可用"时硬闯）
    return { ...base, aborted: true, reason: 'aborted-revalidate-error', error: e?.message ?? String(e) };
  }
}

// ------------------------------------------------------------------ 请求文件

function emptyRequestFile() {
  return { schemaVersion: RESTART_REQUEST_SCHEMA, requests: [] };
}

export function readRequests(file = requestFilePath(), opts = {}) {
  try {
    const data = readJson(file, { schemaVersion: RESTART_REQUEST_SCHEMA, home: opts.home, defaultValue: emptyRequestFile() });
    if (!data || !Array.isArray(data.requests)) return emptyRequestFile();
    return data;
  } catch (e) {
    alert({ level: 'warn', source: 'butler-restart', message: `重启请求文件读取失败（按无请求处理）：${e?.message ?? e}`, detail: { file } }, { home: opts.home });
    return emptyRequestFile();
  }
}

/**
 * 把「超期 executing 请求」分成该结算的与该重试的（纯函数，单测入口）。
 * 判据 = dsh-restart.ps1 的运行足迹：`<workspace>\logs\dsh-restart.log` 的 mtime ≥ 请求 startedAt
 * 说明脚本真的跑过（重启已发起）→ 结算 done；否则才是「标 executing 后没来得及调脚本」→ 回滚重试。
 * 背景（2026-09-11）：旧实现一律回滚 pending，会让**已经重启过**的孤儿请求在 20 分钟后
 * 又变成待执行请求 → 凭空再重启一次（幽灵重启）。测试可用 opts.restartLogPath 注入足迹。
 */
export function classifyStaleExecuting(requests, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const staleMs = Number(opts.staleMs ?? 20 * 60_000);
  const restartLogMtimeMs = Number(opts.restartLogMtimeMs ?? 0);
  const list = (Array.isArray(requests) ? requests : []).filter(
    (r) => r && r.state === 'executing' && Number(r.startedAt ?? 0) > 0 && now - Number(r.startedAt) > staleMs,
  );
  return {
    stale: list,
    settle: list.filter((r) => restartLogMtimeMs >= Number(r.startedAt)),
    revert: list.filter((r) => restartLogMtimeMs < Number(r.startedAt)),
  };
}

/**
 * 结算某批次的 executing 请求。
 * ⚠️ 2026-09-09 修复重启风暴（本卡自伤事故）：原实现把 executing 也算作"待执行"，
 * 且重启完成后从不标 done → 同一请求每分钟被重新执行一次（实测连续 5 次重启）。
 * 现在：pending 才是待执行；executing 由维护窗口清除/超时分支结算为 done；
 * 脚本失败则回滚为 pending 供重试。
 */
function settleBatchRequests(reqFile, batchId, opts = {}) {
  if (!batchId) return { changed: 0 };
  const target = opts.state ?? 'done';
  try {
    let changed = 0;
    mutateRequests(reqFile, (base) => ({
      requests: base.requests.map((r) => {
        if (r.state !== 'executing' || r.batchId !== batchId) return r;
        changed++;
        return { ...r, state: target, settledAt: opts.now ?? Date.now(), settleReason: opts.reason ?? null };
      }),
    }), { home: opts.home });
    return { changed, state: target };
  } catch (e) {
    alert({ level: 'warn', source: 'butler-restart', message: `批次请求结算失败（${target}）：${e?.message ?? e}`, detail: { batchId } }, { home: opts.home, silent: true });
    return { changed: 0, error: e?.message ?? String(e) };
  }
}

function mutateRequests(file, fn, opts = {}) {
  return updateJson(file, (cur) => {
    const base = cur && Array.isArray(cur.requests) ? cur : emptyRequestFile();
    const next = fn(base);
    return next === undefined ? undefined : { ...base, ...next, schemaVersion: RESTART_REQUEST_SCHEMA };
  }, { schemaVersion: RESTART_REQUEST_SCHEMA, home: opts.home, defaultValue: emptyRequestFile() });
}

// ------------------------------------------------------------------ HTTP（就绪探测 / 多播通知）

// ══════════════════════════════════════════════════════════════════════════
// ★【2026-11-05 · P0 闸门就绪探测】探测超时可配 + 「服务活着」与「能投递」分层
//   事故：批次 rst-20261105043535-9b2s（12:35:35 发起 / 12:37:15 completed）重启确实成功，
//     但 `pendingNotify.notified=[]` 一条都没投出去 ⇒ 两个发起会话收不到「重启完成」。
//   根因（定位到行）：本函数原先用**同一个** `opts.timeoutMs ?? 5000` 判 `session.prompt` 之外的
//     `session.list`，而本机 831+ 会话时 `session.list` 实测 4.3 s / 5.1 s —— **正好顶在 5 s 超时线上**，
//     机器一忙就翻红 ⇒ `isReady()` 判「DSH 没起来」⇒ 欠条永远不兑现（DSH 其实活得好好的：
//     同一时刻 `GET /` 只要 7~138 ms，`port=true rpc=false` 在 tick 日志里连刷三次）。
//   修法（**不改重启完成判定语义**）：
//     ① 超时可配（fail-open）：`DSH_BUTLER_PROBE_TIMEOUT_MS`（默认 12000，原 5000）
//        + 端口/RPC 可分别覆盖 `DSH_BUTLER_PROBE_PORT_MS`（默认 3000，维持原值）/ `…_RPC_MS`；
//        非法值（非数 / ≤0 / 空）⇒ 回落默认，**绝不因配错把探测打成永久失败**。
//     ② 判据分层：`portReachable` = 服务活着（重启完成判定用，`isReady()` 仍要求 RPC，一个字不改）；
//        `rpcOk` = 能投递。**通知投递的门**改看 `portReachable` —— 投递本身另有超时与
//        「失败保留下轮重试（maxAttempts=3）」机制，本来就不该被慢 RPC 一票否决。
// ══════════════════════════════════════════════════════════════════════════
const DEFAULT_PROBE_TIMEOUT_MS = 12_000;
const DEFAULT_PROBE_PORT_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_ENV = 'DSH_BUTLER_PROBE_TIMEOUT_MS';
const PROBE_PORT_ENV = 'DSH_BUTLER_PROBE_PORT_MS';
const PROBE_RPC_ENV = 'DSH_BUTLER_PROBE_RPC_MS';

/** 读一个「毫秒数」env（fail-open：非法值 ⇒ 回落 fallback，不抛、不告警刷屏）。 */
function envTimeoutMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// ⚠️ 导出面（本卡 2026-11-05 新增）：`probeTimeouts` / `probeReadiness` / `probeDigest` / `canDeliverNotify`
//   由夹具 `_tmp\p0-notify-probe-20261105\` 直接调用（假 fetch / 假 hostRpc 注入，不打生产）。
/**
 * 解析本次探测的两段超时。
 * 兼容旧调用：显式 `opts.timeoutMs`（老夹具 / 老调用方）⇒ 两段都用它，行为与改动前逐字一致。
 * 顺序：显式单段（portTimeoutMs / rpcTimeoutMs）＞ 显式 timeoutMs ＞ env ＞ 默认。
 */
export function probeTimeouts(opts = {}) {
  const legacy = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Math.floor(Number(opts.timeoutMs)) : null;
  const total = legacy ?? envTimeoutMs(PROBE_TIMEOUT_ENV, DEFAULT_PROBE_TIMEOUT_MS);
  const portMs = Number.isFinite(Number(opts.portTimeoutMs)) && Number(opts.portTimeoutMs) > 0
    ? Math.floor(Number(opts.portTimeoutMs))
    : (legacy ?? envTimeoutMs(PROBE_PORT_ENV, DEFAULT_PROBE_PORT_TIMEOUT_MS));
  const rpcMs = Number.isFinite(Number(opts.rpcTimeoutMs)) && Number(opts.rpcTimeoutMs) > 0
    ? Math.floor(Number(opts.rpcTimeoutMs))
    : (legacy ?? envTimeoutMs(PROBE_RPC_ENV, total));
  const source = legacy ? 'caller' : 'env/default';
  return { portMs, rpcMs, timeoutMs: total, source };
}

/**
 * 就绪探测：一次 GET / 判「服务活着」，一次 Host RPC `session.list` 判「能投递」。
 * @param {object} opts
 *   `baseUrl` / `timeoutMs`（旧单一档）/ `portTimeoutMs` / `rpcTimeoutMs`
 *   `fetchImpl` / `rpcImpl`：**仅供夹具注入**（默认 = 真 fetch / 真 hostRpc）；
 *     夹具用假实现就能在「不打生产」的前提下复现慢 RPC / 端口不通。
 * @returns {Promise<{portReachable:boolean, rpcOk:boolean, items?:object[], ms:{port:number|null, rpc:number|null},
 *   timeouts:{portMs:number, rpcMs:number}, portStatus:number|null, rpcError:string|null, error:string|null}>}
 */
export async function probeReadiness(opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_DSH_URL;
  const t = probeTimeouts(opts);
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  const doRpc = typeof opts.rpcImpl === 'function' ? opts.rpcImpl : hostRpc;
  const out = {
    portReachable: false, rpcOk: false,
    ms: { port: null, rpc: null },
    timeouts: { portMs: t.portMs, rpcMs: t.rpcMs },
    portStatus: null, rpcError: null, error: null,
  };
  const t0 = Date.now();
  try {
    const r = await doFetch(`${baseUrl}/`, { method: 'GET', signal: AbortSignal.timeout(t.portMs) });
    out.portReachable = r.status > 0;
    out.portStatus = r.status;
  } catch (e) {
    out.ms.port = Date.now() - t0;
    out.error = e?.message ?? String(e);
    return out;
  }
  out.ms.port = Date.now() - t0;
  const t1 = Date.now();
  try {
    // 0.1.5 换线（2026-09-22）：适配层（新端点 + cookie，旧主包自动回落）
    const { body: j } = await doRpc(baseUrl, 'session.list', {}, { timeoutMs: t.rpcMs });
    out.rpcOk = Array.isArray(j?.result?.value?.items);
    if (out.rpcOk) out.items = j.result.value.items;
  } catch (e) {
    out.rpcError = e?.message ?? String(e); // rpcOk 保持 false（「能投递」不成立，但不影响「服务活着」）
  }
  out.ms.rpc = Date.now() - t1;
  return out;
}

/** 探测结果的可落盘摘要（只留判据与读数，不带 831 条 items）。 */
export function probeDigest(probe) {
  if (!probe || typeof probe !== 'object') return null;
  return {
    portReachable: probe.portReachable === true,
    rpcOk: probe.rpcOk === true,
    portStatus: probe.portStatus ?? null,
    portMs: probe.ms?.port ?? null,
    rpcMs: probe.ms?.rpc ?? null,
    portTimeoutMs: probe.timeouts?.portMs ?? null,
    rpcTimeoutMs: probe.timeouts?.rpcMs ?? null,
    error: probe.error ?? null,
    rpcError: probe.rpcError ?? null,
  };
}

/**
 * 通知投递的门（**本卡唯一放宽的判据**）：只要 **服务活着** 就试着投 —— 不等 RPC 探测。
 * 为什么安全：投递（`notifySession`）自己有 10 s 超时 + 失败计数（`maxAttempts=3`，不改），
 *   所以「RPC 慢但能投」这类抖动不会再吃掉一整批通知；真死了（端口不通）则照样跳过、下轮再试。
 */
export function canDeliverNotify(probe) {
  return probe?.portReachable === true;
}

/**
 * 一次 `/api/session.list` 往返同时取「标题表」与「主包 running 集合」（[Q4] v0.1.2）。
 * running 是**主包内存态权威标志**（它知道当前有没有回合在跑），比"猜文件尾巴"可靠，
 * 直接参与活跃集合的多源并集 —— 也让 HTTP 只跑一次，少一段"时钟空窗"。
 */
async function fetchSessionViews(opts = {}) {
  const titles = new Map();
  const runningIds = new Set();
  const listedIds = new Set();
  const probe = await probeReadiness(opts);
  for (const it of probe.items ?? []) {
    const id = String(it?.sessionId ?? '');
    if (!id) continue;
    listedIds.add(id);
    const t = it?.projections?.values?.title;
    if (typeof t === 'string' && t.trim()) titles.set(id, t.trim());
    if (it?.running === true) runningIds.add(id);
  }
  return { titles, runningIds, listedIds, items: probe.items ?? [], rpcOk: probe.rpcOk === true };
}

/**
 * 多播通知（方案 §4 实证：POST /api/session.prompt 支持指定任意会话，无需新 API）。
 * ⚠️ 实测修正（2026-09-09）：该端点走 **client-request RPC 信封**，不是扁平 body——
 *   body = {type:'client-request', method:'session.prompt', rpcId, payload:{sessionId, mode, content}}
 *   扁平 {sessionId,...} 会被拒为 "invalid client-request message"（探针实测 HTTP 200 + result.ok=false）。
 * payload 形状（0.1.5 契约 = dsh-api-session-controller#session/prompt 的 SessionPromptRequest）：
 *   {requestId, sessionId, mode:'queue'|'steer', content:[{type:'text',text}]}
 *   ⚠️ **requestId 必填**（客户端铸造的消息身份）——旧形状没有该字段，缺了会被 typert 边界校验
 *   拒成 `gateway/input-invalid`（2026-09-22 实测）。
 * 此时会话已被重启，queue 不存在"制造新回合干扰空闲判定"的问题。
 */
export async function notifySession(sessionId, text, opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_DSH_URL;
  const body = {
    type: 'client-request',
    method: 'session.prompt',
    rpcId: `butler-restart-notify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    payload: {
      requestId: `butler-restart-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId, mode: 'queue', content: [{ type: 'text', text }],
    },
  };
  try {
    // 0.1.5 换线（2026-09-22）：适配层（新端点 /api/session/prompt + cookie；旧主包自动回落）
    // `rpcImpl` 仅供夹具注入（假投递，不打生产）；生产路径恒等 `hostRpc`。
    const doRpc = typeof opts.rpcImpl === 'function' ? opts.rpcImpl : hostRpc;
    const r = await doRpc(baseUrl, 'session.prompt', body.payload, { timeoutMs: opts.timeoutMs ?? 10_000 });
    const j = r.body;
    const ok = r.status === 200 && j?.result?.ok === true;
    return { ok, status: r.status, error: ok ? null : (j?.result?.error?.code ?? j?.result?.error?.message ?? `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  }
}

/** 桌宠触达（whale-on-desk 只有 poke 无 say → 用动作吸引注意，文本走面板/告警）。 */
async function pokeWhale(opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_DASH_URL();
  try {
    const r = await fetch(`${baseUrl}/whale/poke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ antics: 'chase-fish' }),
      signal: AbortSignal.timeout(3000),
    });
    return { ok: r.ok, status: r.status };
  } catch { return { ok: false, status: 0 }; }
}
function DEFAULT_DASH_URL() { return DEFAULT_DSH_URL; }

// ------------------------------------------------------------------ 重启执行

/**
 * 构造传给 dsh-restart.ps1 的干净环境（纯函数，单测入口）。
 * 规则：**先删除继承来的 DSH_SESSION_ID**，仅当本次批次有发起者会话时才注入它。
 * 无发起者（面板无目标 / 双击 cmd / 崩溃恢复）→ 不注入 → 脚本清空 guard-session.id
 * → 守护鱼找不到目标 → 宁可不发，也不发错（主人既定偏好）。
 */
export function buildRestartEnv(baseEnv, requesterSessionId) {
  const env = { ...(baseEnv ?? {}) };
  delete env.DSH_SESSION_ID;
  const sid = String(requesterSessionId ?? '').trim();
  if (sid) env.DSH_SESSION_ID = sid;
  return env;
}

/**
 * 调 dsh-restart.ps1（唯一重启执行入口）。
 * ⚠️ 2026-09-11（卡 [S*·重启通知]）：必须显式传 env —— 协调器 tick 由常驻调度进程
 * spawn，若那个进程当初是在**某个会话里**被拉起的，它就会把那个会话的 DSH_SESSION_ID
 * 一路继承给脚本，脚本再把一个与本次重启无关的旧会话写进 guard-session.id
 * （2026-09-11 09:37 就把 53ac8faa 写成了"发起者"）。调用方用 buildRestartEnv()
 * 构造干净环境：删掉继承值，只注入**本次批次**的发起者。
 */
export function runRestartScript(opts = {}) {
  const script = opts.script ?? RESTART_SCRIPT;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(opts.shell ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: opts.env ?? process.env,
      });
    } catch (e) {
      return resolve({ ok: false, error: `spawn failed: ${e?.message ?? e}` });
    }
    let out = '';
    let settled = false;
    const done = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    const cap = (b) => { out += String(b); if (out.length > 8000) out = out.slice(-8000); };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, opts.timeoutMs ?? 120_000);
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: e?.message ?? String(e), output: out }); });
    // ⚠️ 2026-09-09 实测坑：用 'close' 会被孙进程吊死——dsh-restart.ps1 会启动守护鱼（长期运行），
    // 它继承 stdout/stderr 管道 → 管道永不关闭 → 'close' 永不触发 → 协调器卡死并持有 tick 锁
    // （17:41 那次重启后协调器挂到 17:44 被手动杀掉）。改用 'exit'（子进程自身退出即触发）。
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      setTimeout(() => done({ ok: code === 0, code, signal, output: out.trim() }), 300);
    });
  });
}

async function waitForReady(opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const intervalMs = opts.intervalMs ?? 2500;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeReadiness(opts);
    if (isReady(last)) return { ready: true, probe: last };
    // 黑匣子：等待期每轮留痕——若 tick 进程死在等待中，日志会停在这里（而不是停在 script done）
    writeTickLog(`wait probe: port=${last.portReachable === true} rpc=${last.rpcOk === true}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ready: false, probe: last };
}

// ------------------------------------------------------------------ 主 tick

function parseArgs(argv) {
  const o = { dryRun: false, json: false, force: false, noLock: false, home: null, baseUrl: null, skipWait: false, now: null, verbose: false, noLog: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--force') o.force = true;
    else if (a === '--no-lock') o.noLock = true;
    else if (a === '--skip-wait') o.skipWait = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--no-log') o.noLog = true;
    else if (a === '--home') o.home = argv[++i];
    else if (a === '--dsh-url') o.baseUrl = argv[++i];
    else if (a === '--now') o.now = Number(argv[++i]);
    else return { error: `unknown arg: ${a}` };
  }
  return o;
}

/** 自管日志（计划任务用隐藏窗口启动，无法靠 shell 重定向；>512KB 自动截断保留尾部）。 */
export function tickLogPath() {
  return process.env.DSH_BUTLER_RESTART_LOG || path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-restart.log');
}
function writeTickLog(line) {
  const file = tickLogPath();
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
      const keep = fs.readFileSync(file, 'utf8').split('\n').slice(-500).join('\n');
      fs.writeFileSync(file, keep, 'utf8');
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/**
 * 一次 tick。永不抛（返回结构化结果，便于单测与冒烟）。
 * @param {object} opts
 */
export async function tick(opts = {}) {
  const t0 = Date.now();
  const now = opts.now ?? t0;
  const home = opts.home ?? dshHome();
  const baseUrl = opts.baseUrl ?? DEFAULT_DSH_URL;
  // 【加急档·A4 放行 / 2026-09-28】策略来源接线：`~/.dsh/butler-restart-policy.json`（缺失/坏/非法键 ⇒
  //   回落 DEFAULT_POLICY，fail-safe）⊕ 调用方显式 `opts.policy`（显式最优先，单测/预演注入面）⊕ DEFAULT。
  //   本卡之前这里的写法是 `{ ...DEFAULT_POLICY, ...(opts.policy ?? {}) }` —— 即**没有文件入口**，
  //   加急档只能靠改代码生效。接线后：放行 = 写文件（下一轮 tick ≤1 分钟自动生效，无需重启任何进程，
  //   因为 tickd 每轮 spawn 本脚本子进程），关回 = 删文件或把键设回 null。
  const policyResolved = resolveRestartPolicy({ home, policy: opts.policy ?? null, file: opts.policyFile ?? null });
  const policy = policyResolved.policy;
  const result = { at: new Date(now).toISOString(), action: 'noop', reason: '', durationMs: 0, home, baseUrl };
  // 策略来源投影（可见性）：`--json` / 面板 / 单测都能直接读到"为什么是现在这个值"
  result.policy = {
    source: policyResolved.source, file: policyResolved.file,
    applied: policyResolved.applied, overriddenByCaller: policyResolved.overriddenByCaller,
    ignored: policyResolved.ignored.map((it) => it.key), rejected: policyResolved.rejected.map((it) => it.key),
    warnings: policyResolved.warnings,
    escalateMs: policy.urgentEscalateMs ?? null, urgentMaxPerDay: policy.urgentMaxPerDay ?? null,
  };

  const stateFile = stateFilePath(home);
  const reqFile = opts.requestFile ?? requestFilePath();

  // ---- 0. 版本闸门
  const gate = gateComponent('butler-restart-coordinator', VERSION, { home });
  if (!gate.run) return { ...result, action: 'skip', reason: gate.reason, durationMs: Date.now() - t0 };

  // ---- 1. tick 互斥
  let lock = { release: () => {} };
  if (!opts.noLock) {
    const l = acquireTickLock(TICK_NAME, { ttlMs: opts.lockTtlMs ?? 180_000, home });
    if (!l.ok) return { ...result, action: 'locked', reason: l.reason, durationMs: Date.now() - t0 };
    lock = l;
  }

  try {
    // ---- 1.4【A4 放行 / 2026-09-28】策略文件写坏了必须**看得见**（不许静默回落默认值）
    //   场景：主人手改这个文件免不了手滑 —— JSON 少个逗号、键名拼错、值写成字符串。此时行为 = 老默认
    //   （升档关），与"我以为放行了"不一致 ⇒ 必须留痕（tick 日志 + 告警 + result.policy）。
    if (policyResolved.warnings.length && !opts.dryRun) {
      for (const w of policyResolved.warnings) writeTickLog(`policy WARN ${w}`);
      alert({
        level: 'warn', source: 'butler-restart',
        message: `重启策略文件有问题 ⇒ 已回落默认值（升档默认关）：${policyResolved.warnings[0]}`,
        detail: { file: policyResolved.file, source: policyResolved.source, warnings: policyResolved.warnings, ignored: policyResolved.ignored, rejected: policyResolved.rejected },
      }, { home, silent: true });
      result.policy.warned = true;
    } else if (policyResolved.warnings.length) {
      result.policy.warned = true; // dry-run：只投影，不写日志/告警
    }

    // ---- 1.45 【2026-09-29 修 · 重启通知补齐】交接窗口内**先兑现待补发通知**
    //   现象（2026-09-29 09:46 实测）：批次 rst-20260929014640-b8w3 重启成功（dsh pid 43120→12160），
    //     但 `pendingNotify.notified = []` 一条都没投出去 ⇒ 发起方/被打断会话收不到「重启完成」。
    //   根因（本卡独立复算）：兑现欠条原本只有三条支路（维护窗口 cleared / overdue / 3.5 notify-retry），
    //     **全部排在本步之下**，而 1.5 交接窗口判定会在窗口 active 时直接 `busy` 返回
    //     （实测重启前后 `tick-handoff.lock` 正被 pid 19508 持有）⇒ 整轮不兑现。
    //     另两条支路的"够不到"场景（维护窗口 `pending` 相位）必然伴随 DSH 未就绪 ⇒ 兑现本来也做不成，
    //     故**唯一需要补的阻断点就是交接窗口**。
    //   修法：本步与 1.5 **同源同判据**（复用同一个 `restartGuard` 结果，不双读锁）——
    //     窗口 active（= 下面必 `busy` 早退）⇒ 先把欠条兑现掉，再照常走 1.5 回 busy；
    //     窗口不 active ⇒ **完全不介入**（原路径逐字不变，零行为变更）。
    //   判据（**为什么这样就不会再被吞**）：欠条的兑现条件收敛为"tick 在跑 + 有欠条 + DSH 可达"，
    //     与交接窗口 / 维护窗口相位 / restart job 是否残留 `running` 全部解耦；
    //     `flushPendingNotify` 自带幂等（`notified` 去重）+ 未就绪即跳过 ⇒ 重复调用零副作用。
    //   语义边界：**只兑现欠条，不做任何重启决策**（不读请求、不发起重启、不清维护窗口、不改 busy 判定）。
    let hgPre = null;
    if (!opts.dryRun && opts.skipPendingNotify !== true && !opts.skipHandoffGuard) {
      hgPre = restartGuard({ home, now });
      if (hgPre.action === 'busy') {
        const np = await priorityNotifyPass({ home, baseUrl, stateFile, now, opts });
        if (np.consumed) {
          // 可观测：busy 返回里带上"本轮顺手兑现了欠条"（否则从 action 上看不出补发发生过）
          result.notifyPriority = { batchId: np.batchId, ageMs: np.ageMs, targets: np.targets, reason: np.reason };
          appendAudit({
            type: 'restart-notify-priority', correlationId: np.batchId, batchId: np.batchId,
            notified: np.flushed?.notified?.length ?? 0, failed: np.flushed?.failed?.length ?? 0,
            ageMs: np.ageMs, targets: np.targets, during: 'handoff-window',
          }, { home });
        }
      }
    }

    // ---- 1.5 【T2·§17.1】交接窗口：回 busy，绝不拉起 DSH（放在心跳之前 —— 窗口期不动任何状态）
    const hg = opts.skipHandoffGuard
      ? { action: 'proceed', reason: 'guard-skipped', window: { active: false }, audit: null }
      : (hgPre ?? restartGuard({ home, now }));
    if (hg.action === 'busy') {
      if (!opts.dryRun && hg.audit) appendAudit(hg.audit, { home });
      return { ...result, action: 'busy', reason: `handoff-window: ${hg.reason}`, handoffWindow: { active: true, reason: hg.reason, expiresInMs: hg.window?.expiresInMs ?? null }, durationMs: Date.now() - t0 };
    }

    // ---- 2. 心跳（先写：即使后续崩，健康监控也能看到最后活着的时刻）
    const beat = (extra = {}) => {
      if (opts.dryRun) return null;
      try {
        return updateStateJson('butler-restart-state.json', stateFile, (cur) => {
          const s = { ...emptyState(), ...(cur ?? {}) };
          return {
            ...s,
            heartbeat: { at: Date.now(), pid: process.pid, version: VERSION, task: TASK_NAME, ...extra },
            counters: { ...s.counters, ticks: (s.counters?.ticks ?? 0) + (extra.tick === false ? 0 : 1) },
          };
        }, { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() });
      } catch (e) {
        alert({ level: 'warn', source: 'butler-restart', message: `心跳写入失败：${e?.message ?? e}`, detail: { stateFile } }, { home, silent: true });
        return null;
      }
    };

    // ---- 3. 维护窗口优先处理
    const win = readMaintenanceWindow({ home });
    if (win) {
      const probe = await probeReadiness({ baseUrl });
      const ready = isReady(probe);
      const phase = maintenancePhase(win, { now, ready });
      result.window = { phase: phase.phase, correlationId: win.correlationId, remainingMs: phase.remainingMs };
      if (phase.phase === 'cleared') {
        const flushed = opts.dryRun ? { skipped: true } : await flushPendingNotify({ home, baseUrl, correlationId: win.correlationId, now });
        const settled = opts.dryRun ? { changed: 0 } : settleBatchRequests(reqFile, win.correlationId, { home, now, state: 'done', reason: 'window-cleared' });
        if (!opts.dryRun) clearMaintenanceWindow({ home });
        beat({ tick: false, windowCleared: win.correlationId });
        if (!opts.dryRun) appendAudit({ type: 'restart-window-cleared', correlationId: win.correlationId, ready: true, flushed, settled }, { home });
        return { ...result, action: 'window-cleared', reason: 'ready', flushed, settled, durationMs: Date.now() - t0 };
      }
      if (phase.phase === 'overdue') {
        if (!opts.dryRun) {
          alert({ level: 'error', source: 'butler-restart', message: `🔴 重启维护窗口未正常结束（correlationId=${win.correlationId}，until=${new Date(win.until).toISOString()}）——3080 未就绪或 RPC 失败`, detail: { probe, win } }, { home });
          appendAudit({ type: 'restart-window-overdue', correlationId: win.correlationId, probe }, { home });
          const flushed = await flushPendingNotify({ home, baseUrl, correlationId: win.correlationId, now });
          const settled = settleBatchRequests(reqFile, win.correlationId, { home, now, state: 'done', reason: 'window-overdue' });
          clearMaintenanceWindow({ home });
          beat({ tick: false, windowOverdue: win.correlationId });
          return { ...result, action: 'window-overdue', reason: 'not-ready', flushed, settled, durationMs: Date.now() - t0 };
        }
        return { ...result, action: 'window-overdue', reason: 'not-ready(dry-run)', durationMs: Date.now() - t0 };
      }
      // pending：窗口期不做新决策（避免嵌套重启）
      beat({ tick: false, windowPending: win.correlationId });
      return { ...result, action: 'window-pending', reason: phase.phase, durationMs: Date.now() - t0 };
    }

    // ---- 3.5 待补发通知重试（重启已完成但个别会话没送达，如仍 agent-busy）
    if (!opts.dryRun) {
      const st0 = readState(stateFile, { home });
      const pn = st0.pendingNotify;
      if (pn) {
        // 通知目标三种：被打断会话 + 批次发起者 + 【D17/2026-09-23】旁路名单（近窗有活动但没被打断）
        const hasTargets = (pn.interrupted?.length ?? 0) + (pn.requesters?.length ?? 0) + (pn.staleWait?.length ?? 0) > 0;
        if (!hasTargets) {
          // 无通知目标 → 直接收尾，不需要等 DSH 就绪（否则残留会拖到下次可达才清）
          const flushed0 = await flushPendingNotify({ home, baseUrl, now });
          beat({ tick: false, notifyNoTargets: true });
          return { ...result, action: 'notify-retry', reason: 'no-targets', flushed: flushed0, durationMs: Date.now() - t0 };
        }
        const probe0 = await probeReadiness({ baseUrl });
        // 【2026-11-05 本卡】同样改看「服务活着」：慢 RPC 不该阻断"试着补发一次"。
        if (canDeliverNotify(probe0)) {
          const flushed0 = await flushPendingNotify({ home, baseUrl, now });
          if (!flushed0.skipped) {
            beat({ tick: false, notifyRetry: flushed0.attempts ?? 0 });
            return { ...result, action: 'notify-retry', reason: `notified=${flushed0.notified?.length ?? 0} failed=${flushed0.failed?.length ?? 0}`, flushed: flushed0, durationMs: Date.now() - t0 };
          }
        }
      }
    }

    // ---- 4. 读请求（无请求 → 快速退出）
    // ⚠️ 只有 pending 才算"待执行"；executing = 批次已发起、等维护窗口结算（2026-09-09 重启风暴修复）
    const reqData = readRequests(reqFile, { home });
    const all = Array.isArray(reqData.requests) ? reqData.requests : [];
    const pending = all.filter((r) => r.state === 'pending');
    // 兜底：无维护窗口却有超期 executing —— 先判"重启到底有没有真的发生"，再决定结算还是重试：
    //   ① dsh-restart.log 的 mtime ≥ 该请求 startedAt → 脚本确实跑过（重启已发起）→ **结算 done**
    //      （绝不能回滚 pending：20 分钟后它会变成新请求 → 凭空再重启一次 = 幽灵重启；
    //      2026-09-11 10:25 那批孤儿 executing 就是这种形态）。
    //   ② 脚本根本没跑过 → 才是"标记 executing 后没来得及调脚本" → 回滚 pending 让下一 tick 重试。
    const restartLogMtimeMs = (() => { try { return fs.statSync(opts.restartLogPath ?? RESTART_LOG_PATH).mtimeMs; } catch { return 0; } })();
    const orphans = classifyStaleExecuting(all, { now, restartLogMtimeMs, staleMs: opts.staleExecutingMs });
    const orphanSettled = orphans.settle;
    const orphanRevert = orphans.revert;
    if (orphanSettled.length && !opts.dryRun) {
      const ids = new Set(orphanSettled.map((x) => x.id));
      mutateRequests(reqFile, (base) => ({
        requests: base.requests.map((r) => (ids.has(r.id) ? { ...r, state: 'done', settledAt: now, settleReason: 'orphan-executing-but-restart-happened' } : r)),
      }), { home });
      appendAudit({ type: 'restart-request-orphan-settled', ids: [...ids], note: 'executing 超期但 dsh-restart.log 证明重启已发生 → 结算 done（不重试，避免幽灵重启）' }, { home });
    }
    if (orphanRevert.length && !opts.dryRun) {
      const ids = new Set(orphanRevert.map((x) => x.id));
      mutateRequests(reqFile, (base) => ({
        requests: base.requests.map((r) => (ids.has(r.id) ? { ...r, state: 'pending', recoveredAt: now } : r)),
      }), { home });
      appendAudit({ type: 'restart-request-recovered', ids: [...ids], note: 'executing 超期且脚本未跑过 → 回滚 pending 重试' }, { home });
    }
    if (!pending.length) {
      if (!opts.dryRun && all.length) {
        // 只有已结束/已作废的请求 → 保留最近 50 条，清理其余（防文件无限增长）
        mutateRequests(reqFile, (base) => ({ requests: base.requests.slice(-50) }), { home });
      }
      beat();
      return { ...result, action: 'idle', reason: 'no-request', durationMs: Date.now() - t0 };
    }

    // ---- 5. 过期清理（24h 未执行自动作废）
    const expiredIds = [];
    for (const r of all) {
      if (r.state === 'pending' && isRequestExpired(r, now, policy)) { r.state = 'expired'; r.expiredAt = now; expiredIds.push(r.id); }
    }
    const live = all.filter((r) => r.state === 'pending');
    if (expiredIds.length && !opts.dryRun) {
      mutateRequests(reqFile, () => ({ requests: all }), { home });
      appendAudit({ type: 'restart-request-expired', ids: expiredIds, ttlMs: policy.requestTtlMs }, { home });
      result.expired = expiredIds;
    }
    if (!live.length) {
      beat();
      return { ...result, action: 'idle', reason: 'all-expired', expired: expiredIds, durationMs: Date.now() - t0 };
    }

    // ---- 6. 会话扫描 + 多源活跃判定 + 决策（[Q4] v0.1.2 重写）
    // ⚠️ 判定时钟必须**即时取**，不能用 tick 启动时刻 t0：
    //    t0 到这里的 HTTP 往返（fetchSessionViews）实测 0.8–11.6 秒，期间活跃会话持续写会话文件 →
    //    mtime 越过 t0 → `now - mtime < 0` → 旧判据把它判成 stale → 越活跃越被判"不活跃" →
    //    active=0 → `low-watermark-zero` 立即重启、打断在跑的卡（11:52:44 / 14:58:28 两次事故的根因）。
    const judgeNow = opts.now ?? Date.now();
    let views = { titles: new Map(), runningIds: new Set(), listedIds: new Set(), items: [], rpcOk: false };
    try { views = await fetchSessionViews({ baseUrl }); } catch { /* 降级：仍有文件判据 + 卡会话判据 */ }
    const board = readBoardCardSessions({ home });
    if (!board.ok) writeTickLog(`board-ledger unreadable（${board.error}）→ 卡会话本轮不计入（fail-open，不阻塞重启）`);
    const scanned = collectSessions({ home, now: judgeNow, policy, titles: views.titles });
    const merged = mergeActiveSources(scanned, {
      runningIds: views.runningIds, listedSessionIds: views.listedIds, sessionListKnown: views.rpcOk === true,
      cardSessionIds: board.map, now: judgeNow, policy,
    });
    const sessions = merged.sessions;
    // ---- 6.1【加急档·A2 · 复审 R-1】卡执行会话判据**必须真传**（账本全量 + fail-safe 方向）
    //   ⚠️ 不传 ⇒ `classifyActiveByCard` 落 `degraded` ⇒ 全部活跃判为卡会话 ⇒ **加急档永不执行**，
    //     而且面板/审计看不出原因（这正是复审 R-1 点出的"接不上且不可见"）。
    //   ⚠️ 与上面 `board`（只认 running 卡、fail-open，服务**活跃判定**）**故意不同源**：见 lib 说明。
    const cardIdx = loadFailSafeCardIndex({ home });
    // ---- 6.2【加急档·A2 · P-2 / D-3=a】软保护求值：独立 v3 输入面（**不并入活跃判据**）
    //   两趟法：第一趟只为拿到 `softActive`（软保护的输入 = `active − cardActive`，已排除发起者），
    //   第二趟把求值结果注入 ⇒ 得到**唯一权威**的 planner 结果（不在协调器里另写一份排除逻辑）。
    //   求值不可用 / 抛错 ⇒ `unavailable` ⇒ 加急档一律退回 queue（fail-safe，**不静默**）。
    // ---- 6.15【加急档·A4 前置 · 复审 R-4】当日升档额度（**只读**；判据层闸门的输入）
    //   · 台账口径 = 同源状态文件 `butler-restart-state.json` 的 `urgent` 段（无新根、无新开关）。
    //   · 读失败 ⇒ `ok:false` ⇒ 闸门**fail-safe 拒绝升档**（"读不到就放行"等于上限形同虚设）。
    //   · 跨日 ⇒ `used=0`（文件里那份是昨天的）；`reset:true` 只用于日志。
    //   · **本段零写入**：判定阶段只读，记账在执行前（见 8.05 之后的 8.06 段）。
    const urgentDaily = readUrgentDaily({ home, now: judgeNow, policy });
    if (!urgentDaily.ok) {
      writeTickLog(`decide urgent-daily counter UNAVAILABLE（${urgentDaily.error ?? 'unknown'}）→ 加急档 fail-safe：本轮**不自动升档**（退回 queue 档）`);
    } else if (urgentDaily.reset) {
      writeTickLog(`decide urgent-daily reset：文件里是 ${urgentDaily.counterDay} 的账（≠ 今天 ${urgentDaily.day}）⇒ 当日用量按 0 起算`);
    }
    const plan0 = planRestart({ requests: live, sessions, now: judgeNow, policy, cardSessions: cardIdx.index, urgentDaily });
    let softEval;
    try {
      softEval = evaluateSoftProtect(plan0.softActive, { home, now: judgeNow, policy });
    } catch (e) {
      softEval = {
        mode: 'unavailable', holdSessionIds: new Set(), holdIds: [], holdCount: 0,
        disabled: false, unavailable: true, windowMs: null, source: `eval-error:${e?.message ?? e}`,
      };
    }
    const plan = planRestart({ requests: live, sessions, now: judgeNow, policy, cardSessions: cardIdx.index, softProtect: softEval, urgentDaily });
    result.plan = {
      action: plan.action, reason: plan.reason, batchId: plan.batch?.batchId,
      activeCount: plan.active.length, waitingMs: plan.waitingMs, inFallbackWindow: plan.inFallbackWindow,
      judgeClockLagMs: judgeNow - t0,
      // 【加急档·A2】档位 / 卡与非卡分流 / 软保护三态 / 卡索引退化态 —— 全部投影到面板与日志
      tier: plan.tierEffective, tierRequested: plan.tierRequested, escalated: plan.tierEscalated,
      cardActiveCount: plan.cardActive.length, softActiveCount: plan.softActive.length,
      cardSessionIndexOk: plan.cardSessionIndexOk === true, cardSessionDegraded: plan.cardSessionDegraded === true,
      cardSessionCount: cardIdx.count,
      // 【加急档·A4 前置 · 复审 R-4】当日升档额度（闸门的输入与结论）：面板 / 日报 / 审计都读它
      urgentDaily: {
        ok: urgentDaily.ok === true, day: urgentDaily.day, used: urgentDaily.used, limit: urgentDaily.limit,
        reached: plan.urgentDaily?.reached === true, reset: urgentDaily.reset === true,
        escalated: urgentDaily.escalated, explicit: urgentDaily.explicit, denied: urgentDaily.denied,
      },
      tierEscalationApplied: plan.tierEscalationApplied === true,
      tierEscalationDenied: plan.tierEscalationDenied === true,
      urgentDeniedReason: plan.urgentDeniedReason ?? null,
      softProtect: {
        mode: plan.softProtect?.mode ?? null, source: plan.softProtect?.source ?? null,
        holdCount: plan.softProtect?.holdCount ?? 0,
        disabled: plan.softProtect?.disabled === true, unavailable: plan.softProtect?.unavailable === true,
      },
      sources: {
        file: merged.stats.file, agentRunning: merged.stats.agentRunning, boardCard: merged.stats.boardCard,
        synthesized: merged.stats.synthesized, droppedCards: merged.stats.droppedStaleCards.length,
        droppedByHost: merged.stats.droppedByHostLiveCheck, hostLivenessKnown: merged.stats.hostLivenessKnown,
      },
    };
    // 卡索引退化态**必须外露**（复审 R-1②：degraded 不许静默）
    if (result.plan.cardSessionDegraded) {
      writeTickLog(`decide card-session index DEGRADED（${cardIdx.error ?? 'unavailable'}）→ 加急档按 fail-safe 判：全部活跃视为卡执行会话（一律 queue）`
        + `；面板提示 cardSessionDegraded=true；账本文件 = ${path.join(home, 'task-board', 'ledger-v2.json')}`);
    }
    const allActive = merged.active;
    // 决策日志（[Q4] 可观测性）：每次判定留一行明细 —— 下次再出"低水位误判"能直接看现场，不用靠猜
    writeTickLog(`decide ${plan.action} reason=${plan.reason} active=${plan.active.length}/${scanned.length} judgeLag=${judgeNow - t0}ms`
      + ` tier=${plan.tierEffective} escalated=${plan.tierEscalated} cards=${plan.cardActive.length} soft=${plan.softActive.length} sp=${plan.softProtect?.mode ?? '-'}`
      // 【A4 放行 / 2026-09-28】策略来源 + 当前升档阈值（可见性：翻日志就知道"升档开着没 / 阈值多少 / 值从哪来"）
      + ` policy=${policyResolved.source}${policy.urgentEscalateMs ? `@${Math.round(policy.urgentEscalateMs / 60_000)}min` : '@off'}`
      // 【A4 前置】当日升档额度随决策行落盘（可见性：翻日志就能看出"为什么没升档"）
      + ` urgent=${urgentDaily.ok ? `${urgentDaily.used}/${urgentDaily.limit}` : 'unavailable'}`
      + `${plan.tierEscalationDenied ? ` urgentDenied=${plan.urgentDeniedReason}` : ''}`
      + ` sources=${JSON.stringify(result.plan.sources)} rpcOk=${views.rpcOk}`
      + ` :: ${plan.active.map((s) => `${String(s.sessionId).slice(8, 16)}[${s.activeSource}]${s.state}${Number.isFinite(s.ageMs) ? '@' + Math.round(s.ageMs / 1000) + 's' : ''}`).join(' ')}`);
    if (merged.stats.droppedStaleCards.length) writeTickLog(`decide dropped-cards ${JSON.stringify(merged.stats.droppedStaleCards).slice(0, 600)}`);

    // ---- 6.3【加急档·A4 前置 · 复审 R-4】升档被每日上限挡下 ⇒ **审计留痕 + 计数**（禁止静默）
    //   方案 §3.3：达 `urgentMaxPerDay` ⇒ 拒绝升档、退回 queue 档（`planRestart` 已把档位退回）；
    //   这里负责"让人看得见"：审计 `restart-urgent-denied` + `reason=urgent-daily-limit`，
    //   并把当日 `denied` 计数 +1（失败只告警、不影响主流程 —— 拒绝本身已是 fail-safe 方向）。
    if (plan.tierEscalationDenied === true) {
      const deniedReason = plan.urgentDeniedReason ?? URGENT_DAILY_REASONS.LIMIT;
      result.plan.urgentDenied = {
        reason: deniedReason, used: plan.urgentDaily?.used ?? null, limit: plan.urgentDaily?.limit ?? null,
        day: plan.urgentDaily?.day ?? null, counted: null,
      };
      writeTickLog(`decide urgent-escalation DENIED reason=${deniedReason} used=${plan.urgentDaily?.used ?? '?'}/${plan.urgentDaily?.limit ?? '?'}`
        + ` ⇒ 退回 queue 档（本 tick 不按升档执行；档位回落 tier=${plan.tierEffective}）`);
      if (!opts.dryRun) {
        appendAudit({
          type: 'restart-urgent-denied', correlationId: plan.batch?.batchId ?? null, reason: deniedReason,
          tierRequested: plan.tierRequested, tierEffective: plan.tierEffective,
          used: plan.urgentDaily?.used ?? null, limit: plan.urgentDaily?.limit ?? null, day: plan.urgentDaily?.day ?? null,
          counterOk: urgentDaily.ok === true, waitingMs: plan.waitingMs, action: plan.action, planReason: plan.reason,
          note: '每日常升档上限闸门（复审 R-4）：拒绝本次**自动升档**、退回 queue 档；人显式 --priority urgent 不受本闸门约束（口径见 lib\\restart.mjs 注释）',
        }, { home });
        const counted = bumpUrgentDaily({ home, now: judgeNow, policy, kind: 'denied' });
        result.plan.urgentDenied.counted = counted.ok === true;
        if (!counted.ok) {
          writeTickLog(`decide urgent-denied counter write FAILED（${counted.error ?? 'unknown'}）—— 拒绝已生效（fail-safe），计数缺失已告警`);
          alert({ level: 'warn', source: 'butler-restart', message: `加急档 denied 计数写盘失败：${counted.error ?? 'unknown'}`, detail: { stateFile } }, { home, silent: true });
        }
      }
    }

    // ---- 6.35【2026-10-26 主人令】加急档自动喊话：等久了升到 urgent 却还停在 queue（卡在跑 /
    //   等用户输入）⇒ 自动替人跑一次 `drain-freeze.mjs --send`，断掉「卡跑完 → 接下一张」这条死锁链。
    //   为什么要有这段：加急档（策略 `urgentEscalateMs`）早就能用，但「喊话」只能人工跑 ⇒ 升档之后
    //     活跃数依然不归零，闸门永远等不到重启（2026-10-23 的排空协议就是为这个死锁写的）。
    //   触发（三条同时成立，缺一不发）：
    //     ① `tierEscalated` = 等久了**自动**升的档（人显式 `--priority urgent` 不在此列）；
    //     ② `tierEffective === 'urgent'` = 升档没被「每日升档上限」闸门拒；
    //     ③ `action === 'queue'` = 还在等（没到低水位，或还卡在卡执行会话 / 用户输入上）。
    //   幂等：同一 `batchId` 只喊一次（状态文件 `queue.drainFreeze` 留痕；失败按 10 分钟冷却重试）。
    //   开关：默认开；关回 = env `DSH_RESTART_AUTO_DRAIN_FREEZE=0|off`（优先）或策略文件
    //     `"autoDrainFreeze": false`。**读不到就开**（别改成读不到就关）。
    //   ⚠️ fail-open 硬要求：整段 try/catch 全包，任何失败只写 tick 日志 + 记 `ok:false`，
    //     **绝不 throw、绝不改 plan、绝不阻塞第 7 段起的判定** —— 这段跑在每分钟的 tick 里，
    //     它崩了重启就永远落不了地。
    try {
      const adf = await maybeAutoDrainFreeze({
        home, stateFile, plan, policy, now: judgeNow, opts, log: writeTickLog,
      });
      if (adf) result.autoDrainFreeze = adf;
    } catch (e) {
      // 双保险：helper 自身已全包，这里再兜一层（绝不冒泡到 tick 最外层把 action 打成 error）
      writeTickLog(`auto-drain-freeze 自动喊话失败（外层兜底：${e?.message ?? e}）—— 本轮判定不受影响（fail-open）`);
      result.autoDrainFreeze = { ok: false, error: e?.message ?? String(e) };
    }

    // ---- 7. 排队
    if (plan.action === 'queue') {
      // 【加急档·A2 · 方案 §3.8 附修】提醒去重键 = **稳定的请求集合指纹**（不再是 `batch.batchId`）：
      //   `mergeBatch()` 每 tick 都 `makeBatchId()` ⇒ batchId 去重**永不命中**（2026-09-22 实测
      //   15:14–15:42 连刷 23 条「⏳ 排队超 30 分钟」+ 桌宠被反复戳）。指纹不变 ⇒ 同一请求集合
      //   **只提醒一次**（**有意设计**，信息不丢：面板排队明细实时显示在等谁 / 等了多久）。
      //   ⚠️ 指纹是**运行键/提醒键**，与去重键 `batchId` **不复用同一字段**（规程 §3.4）。
      const fingerprint = remindFingerprint(plan);
      // 【2026-10-26 · 6.35 配套】本轮之前的状态：`queue.drainFreeze`（自动喊话幂等记录）必须原样带上
      //   —— 下面这次 safeUpdateState 会把 `queue` **整份换成本轮的 queueInfo**，
      //   不带上就等于每分钟抹一次「本批次已喊过」，自动喊话会重复打扰。
      const stPrev = opts.dryRun ? emptyState() : readState(stateFile, { home });
      const queueInfo = {
        batchId: plan.batch.batchId,
        correlationId: plan.batch.batchId,
        remindFingerprint: fingerprint,
        since: plan.batch.waitingSince,
        waitingMs: plan.waitingMs,
        active: plan.active.map((s) => ({ sessionId: s.sessionId, title: s.title, tail: s.tail, ageMs: s.ageMs, activeSource: s.activeSource ?? null, state: s.state ?? null })),
        // 【加急档·A2】排队显示**分两类**（方案 §3.7）：卡执行会话（不可打断）/ 普通会话（可加急打断）
        //   + 档位 / 升档标记 / 软保护三态 / 卡索引退化态（复审 R-1② 面板明示）
        tier: plan.tierEffective,
        tierRequested: plan.tierRequested,
        escalated: plan.tierEscalated,
        cardActive: plan.cardActive.map((s) => ({ sessionId: s.sessionId, title: s.title, tail: s.tail, ageMs: s.ageMs, activeSource: s.activeSource ?? null })),
        softActive: plan.softActive.map((s) => ({ sessionId: s.sessionId, title: s.title, tail: s.tail, ageMs: s.ageMs, activeSource: s.activeSource ?? null })),
        cardSessionIndexOk: plan.cardSessionIndexOk === true,
        cardSessionDegraded: plan.cardSessionDegraded === true,
        softProtect: {
          mode: plan.softProtect?.mode ?? null, source: plan.softProtect?.source ?? null,
          holdCount: plan.softProtect?.holdCount ?? 0, holdIds: plan.softProtect?.holdIds ?? [],
        },
        excluded: plan.excluded,
        reasons: plan.batch.reasons,
        inFallbackWindow: plan.inFallbackWindow,
        // 【2026-10-26 · 6.35】加急档自动喊话留痕（同一 batchId 只喊一次；见 maybeAutoDrainFreeze）
        drainFreeze: stPrev.queue?.drainFreeze ?? null,
        updatedAt: now,
      };
      const reminded = new Set(stPrev.reminded ?? []);
      const needRemind = plan.needRemind && !reminded.has(fingerprint);
      if (!opts.dryRun) {
        // 【A4 前置 / 2026-09-28】改用 `safeUpdateState()`：状态文件被写坏时**不许**把整个 tick 打成
        //   `action:'error'` —— 否则"加急档因计数器不可用而拒绝升档（fail-safe）"这条真语义会被错误码盖掉。
        safeUpdateState(stateFile, home, (cur) => {
          const s = { ...emptyState(), ...(cur ?? {}) };
          return {
            ...s,
            heartbeat: { at: Date.now(), pid: process.pid, version: VERSION, task: TASK_NAME },
            queue: queueInfo,
            counters: { ...s.counters, ticks: (s.counters?.ticks ?? 0) + 1, queued: (s.counters?.queued ?? 0) + 1 },
            // 【加急档·A2 · §3.8】去重键 = **请求集合指纹**（稳定）；batchId 只作批次标识、不再当提醒键
            reminded: needRemind ? [...new Set([...(s.reminded ?? []), fingerprint])].slice(-50) : (s.reminded ?? []),
          };
        });
      }
      if (needRemind) {
        const text = queueNotice(plan);
        if (!opts.dryRun) {
          alert({ level: 'warn', source: 'butler-restart', message: `⏳ 重启请求排队超 ${Math.round(policy.queueTimeoutMs / 60000)} 分钟未执行（等 ${plan.active.length} 个活跃会话）`, detail: { queue: queueInfo, text } }, { home });
          appendAudit({ type: 'restart-queue-timeout', correlationId: plan.batch.batchId, active: plan.active.map((s) => s.sessionId), waitingMs: plan.waitingMs }, { home });
          await pokeWhale({ baseUrl }); // 桌宠触达（无文本 API → 动作吸引注意，文本在面板/告警）
        }
        result.reminded = true;
      }
      return { ...result, action: 'queue', reason: plan.reason, queue: queueInfo, needRemind, remindFingerprint: fingerprint, durationMs: Date.now() - t0 };
    }

    // ---- 8. 执行重启
    const interruptions = buildInterruptionList(allActive, { now });
    // 【加急档·A2 · 方案 §5 J3 / §3.7】红线断言（**非发起者**的卡执行会话不得进打断清单）：
    //   在**执行时刻**用账本全量判据扫一遍打断清单 ⇒ `interruptedCards` 进审计（恒 0）。
    //   ⚠️ 断言口径 = 集合式 `interrupted ∩ 卡执行会话 ⊆ {发起者}`（**不是空集**）：发起者本人是卡会话时
    //     仍会被打断（现状语义，拍板 ⑤=a / D-5=a）⇒ `interruptedCardSessions` 单列留痕、不参与恒 0。
    const j3 = findInterruptedCardViolations({
      interruptions, cardSessions: cardIdx.index, requesterIds: plan.batch.requesterIds,
    });
    if (!j3.ok) {
      writeTickLog(`exec ${plan.batch.batchId}: ⛔ J3 违规（${j3.violations.length}）—— 非发起者的卡执行会话进了打断清单：${j3.violations.join(',')}`);
    }
    // ---- 8.0 旁路通知名单【D17 / 2026-09-23 主人点名 A 方案】----
    //   活跃判据只覆盖"重启瞬间在跑"的会话（三源并集）；**回合间隙里等通知 / 等卡完成的会话**
    //   三源全不命中 ⇒ 既不在打断名单、也不是发起者 ⇒ 一条通知都收不到、静默停摆
    //   （2026-09-22 01:31:56 批次实测：主会话在等 L-2 验收通知，被打断后静默 6.5 小时）。
    //   这里只**多挑一路通知目标**（纯加法）：不改活跃判据 / 低水位 / force 语义 / 打断口径。
    //   判据与 collectSessions 同源（同一批 scanned 行、同一个判定时钟 judgeNow），只放宽时间窗。
    //   ⚠️ fail-open 铁律：取名单/计算失败 ⇒ **只少发通知** + 审计一条 staleWaitError，
    //      **绝不允许影响重启主流程**（不许 fail-closed 卡住重启、不许因此改 force/低水位判据）。
    //   ⚠️ 初始值**不得触碰 policy.staleWaitNoticeMs**：策略键若被注入成异常值（读 .valueOf 就抛），
    //      在这里求值会直接炸 tick 主流程 —— 而 fail-open 要求"只少发通知"。真值一律在 try 里算。
    let staleWait = { enabled: true, windowMs: 0, list: [], stats: { skipped: 'not-computed' } };
    let staleWaitError = null;
    try {
      const excludeIds = [...new Set([
        ...interruptions.map((x) => x?.sessionId),
        ...(plan.batch.requesterIds ?? []),
      ].filter(Boolean))];
      // 活动时间补充源（D17 专用）：主包 0.1.5 起会话日志名换代为 `session.v3.jsonl.zstd`，
      // 而 `collectSessions` 只认旧名（生产实测旧文件 mtime 全停在 9 小时前 ⇒ 近窗恒为空）。
      // 命中同族最新 mtime 时，只覆盖**旁路输入行**的 mtimeMs/ageMs；
      // ⚠️ `scanned` 本身、`isSessionActive`、`mergeActiveSources`、低水位、force 一概不动。
      const activity = scanSessionActivityTimes(home);
      // ---- 8.0.1【本卡 · 通知面卡会话豁免 / 2026-09-23】卡执行会话索引（唯一源 lib/card-session.mjs）----
      //   已结算的卡执行会话（卡 done/review/failed）**不进旁路名单**；未结算的卡会话照旧进（不误伤）。
      //   ⚠️ fail-open 双层：① 读不到账本 → 索引 ok:false → 一个都不排除（保持改动前语义）；
      //      ② 读取本身再包一层 try —— 取索引失败**不得**把整段 staleWait 打成 error（那会少发全部旁路通知）。
      let cardIndex = emptyCardSessionIndex('not-read', { source: 'ledger' });
      try {
        cardIndex = loadCardSessionIndex({ home });
      } catch (e) {
        cardIndex = emptyCardSessionIndex(e?.message ?? String(e), { source: 'ledger' });
      }
      if (!cardIndex.ok) {
        try { writeTickLog(`card-session index unavailable（${cardIndex.error}）→ 卡会话豁免本轮不生效（fail-open，不排除任何会话）`); } catch { /* 日志失败不影响主流程 */ }
      }
      let activityOverridden = 0;
      const hasActivity = new Set();
      const sideRows = scanned.map((row) => {
        const hit = activity.get(row.sessionId);
        if (!hit) return row;
        hasActivity.add(row.sessionId);
        if (Number.isFinite(row.mtimeMs) && row.mtimeMs >= hit.mtimeMs) return row;
        activityOverridden++;
        return { ...row, mtimeMs: hit.mtimeMs, ageMs: judgeNow - hit.mtimeMs, activityFile: hit.file };
      });
      // 真机实测（2026-09-23）：54 个会话目录里 **25 个只有 v3 文件** ⇒ `collectSessions` 完全看不见它们，
      // 光换时间源还不够 —— "回合间隙 + 只有 v3 文件"的会话仍会永远收不到提醒（正是 D17 要治的形态）。
      // 故为它们**合成一行**（active:false / state:'activity-only'），**只喂旁路名单**；
      // ⚠️ 合成行不进 `scanned`、不进 `mergeActiveSources`、不参与低水位 ⇒ 活跃判据依旧一字不动。
      let activityOnly = 0;
      for (const [id, hit] of activity) {
        if (hasActivity.has(id)) continue;
        activityOnly++;
        sideRows.push({
          sessionId: id, title: '', mark: null, active: false, state: 'activity-only',
          tail: null, lastType: null, mtimeMs: hit.mtimeMs, ageMs: judgeNow - hit.mtimeMs,
          activityFile: hit.file, synthesizedFor: 'stale-wait',
        });
      }
      staleWait = selectStaleWaitSessions(sideRows, { now: judgeNow, policy, excludeIds, cardSessions: cardIndex });
      staleWait.stats = { ...staleWait.stats, activitySource: { dirs: activity.size, overridden: activityOverridden, activityOnly } };
    } catch (e) {
      staleWaitError = e?.message ?? String(e);
      staleWait = { enabled: true, windowMs: 0, list: [], stats: { error: staleWaitError, skipped: 'fail-open' } };
      try { writeTickLog(`staleWait fail-open: ${staleWaitError}（只少发通知，重启不受影响）`); } catch { /* 日志失败也不能炸主流程 */ }
      if (!opts.dryRun) {
        try {
          appendAudit({ type: 'staleWaitError', correlationId: plan.batch.batchId, error: staleWaitError, note: 'fail-open：只少发通知，不影响重启主流程' }, { home });
        } catch { /* 审计本身失败也不能炸主流程 */ }
      }
    }
    result.staleWait = {
      enabled: staleWait.enabled, windowMs: staleWait.windowMs,
      count: staleWait.list.length, ids: staleWait.list.map((x) => x.sessionId),
      list: staleWait.list, stats: staleWait.stats, error: staleWaitError,
    };
    if (!opts.dryRun) {
      writeTickLog(`exec ${plan.batch.batchId}: staleWait candidates=${staleWait.list.length}/${scanned.length}（窗口 ${Math.round(staleWait.windowMs / 1000)}s`
        + ` · 已结算卡会话豁免 ${staleWait.stats?.settledCardSessions ?? 0}）`
        + ` :: ${staleWait.list.map((x) => `${String(x.sessionId).slice(8, 16)}@${Math.round(x.ageMs / 1000)}s`).join(' ')}`);
    }
    // ---- 8.05【加急档·A2 · 方案 §3.4 红线 3 / J10】**执行前二次校验**
    //   为什么在这里：`planRestart()` 的判定发生在 `judgeNow`，而调脚本在之后（DSH 忙时 HTTP 往返
    //   历史 0.8–11.6 秒）。这段窗口里**新起的卡执行会话**（新 run 的卡）会让 `cardActive` 由 0 变正 ——
    //   照旧执行就会打断真在跑的卡（假结算）。
    //   ⚠️ **校验点必须早于**：`makeMaintenanceWindow()` / `writeMaintenanceWindow()` / 批次状态落盘 /
    //      请求标 `executing` / 调 `dsh-restart.ps1`（全部在下面）。晚一步退回 queue 就会留下
    //      "请求 executing 但重启没发生"的脏状态（只能靠 `classifyStaleExecuting()` 事后兜）。
    //   ⚠️ 校验失败 ⇒ **零状态写入**（不写窗口 / 不写批次状态 / 不改请求状态）+ 审计 `restart-aborted-late`
    //      + 退回 queue（下一 tick 重判）。宁可多等一分钟，不制造假结算。
    //   ⚠️ **force 档不校验**：红线 1 的唯一例外 = 人工显式强制（"全打断"就是它的语义）。
    let revalidate = null;
    if (!plan.batch.force && plan.tierEffective !== 'force') {
      revalidate = revalidateBeforeExecute({ home, policy, live, views, now: Date.now(), plan });
      result.revalidate = revalidate;
      if (!opts.dryRun) {
        writeTickLog(`exec ${plan.batch.batchId}: revalidate aborted=${revalidate.aborted} reason=${revalidate.reason ?? '-'}`
          + ` cards=${revalidate.cardActive.length} hold=${revalidate.heldForUserInput} active=${revalidate.newActive}`
          + `${revalidate.error ? ` error=${revalidate.error}` : ''}`);
      }
      if (revalidate.aborted) {
        if (!opts.dryRun) {
          appendAudit({
            type: 'restart-aborted-late', correlationId: plan.batch.batchId, reason: revalidate.reason,
            abortedLateCard: revalidate.reason === 'aborted-late-card',
            cardActive: revalidate.cardActive, heldForUserInput: revalidate.heldForUserInput, holdIds: revalidate.holdIds,
            newActive: revalidate.newActive, plan2Action: revalidate.plan2Action, plan2Reason: revalidate.plan2Reason,
            cardSessionIndexOk: revalidate.cardSessionIndexOk, cardSessionDegraded: revalidate.cardSessionDegraded,
            softProtectMode: revalidate.softProtectMode, sources: revalidate.sources, error: revalidate.error,
            note: '执行前二次校验未过 → 放弃本次执行（**零状态写入**）并退回 queue；下一 tick 重判',
          }, { home });
          const fpAbort = remindFingerprint(plan);
          updateStateJson('butler-restart-state.json', stateFile, (cur) => {
            const s = { ...emptyState(), ...(cur ?? {}) };
            return {
              ...s,
              heartbeat: { at: Date.now(), pid: process.pid, version: VERSION, task: TASK_NAME },
              queue: {
                batchId: plan.batch.batchId, correlationId: plan.batch.batchId, remindFingerprint: fpAbort,
                since: plan.batch.waitingSince, waitingMs: plan.waitingMs,
                active: plan.active.map((x) => ({ sessionId: x.sessionId, title: x.title, tail: x.tail, ageMs: x.ageMs, activeSource: x.activeSource ?? null, state: x.state ?? null })),
                tier: plan.tierEffective, tierRequested: plan.tierRequested, escalated: plan.tierEscalated,
                cardActive: revalidate.cardActive.map((id) => ({ sessionId: id })),
                softActive: [],
                cardSessionIndexOk: revalidate.cardSessionIndexOk, cardSessionDegraded: revalidate.cardSessionDegraded,
                softProtect: { mode: revalidate.softProtectMode, source: null, holdCount: revalidate.heldForUserInput, holdIds: revalidate.holdIds },
                excluded: plan.excluded, reasons: plan.batch.reasons, inFallbackWindow: plan.inFallbackWindow,
                abortedLate: { reason: revalidate.reason, at: Date.now() },
                updatedAt: now,
              },
              counters: { ...s.counters, ticks: (s.counters?.ticks ?? 0) + 1, queued: (s.counters?.queued ?? 0) + 1 },
            };
          }, { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() });
        }
        return {
          ...result, action: 'queue', reason: revalidate.reason,
          abortedLateCard: revalidate.reason === 'aborted-late-card', revalidate,
          durationMs: Date.now() - t0,
        };
      }
    }
    // ---- 8.06【加急档·A4 前置 · 复审 R-4】执行前**记账**（当日加急次数 +1）
    //   口径 = 「每天最多**执行**几次」（方案 §3.3 字面）⇒ 记账点必须落在"已决定执行 + 执行前二次校验
    //   也过了"之后、且**尚未写任何重启状态**之前（早于维护窗口 / 批次状态 / 请求 executing / 调脚本）。
    //   · `escalated` = **因排队超时把档位真抬上去**的执行（`tierEscalationApplied`）；闸门约束的就是它。
    //   · `explicit` = 人显式 `--priority urgent` 的执行（**不受闸门约束**，只计数以便可见与复盘）。
    //   · 写失败 ⇒ **放弃本次执行**（退回 queue、零状态写入、审计 `restart-urgent-counter-failed`）：
    //     计数写不进 = 上限不可信 ⇒ 宁可不加急（fail-safe，与软保护 `unavailable` 同向）。
    let urgentExec = null;
    if (plan.tierEffective === 'urgent') {
      const kind = plan.tierEscalationApplied === true ? 'escalated' : 'explicit';
      const bump = opts.dryRun
        ? { ok: null, skipped: true, day: localDayKey(now), limit: plan.urgentDaily?.limit ?? null, escalated: null, explicit: null, denied: null }
        : bumpUrgentDaily({ home, now: Date.now(), policy, kind });
      urgentExec = { kind, ...bump };
      result.urgentExec = urgentExec;
      if (opts.dryRun) {
        writeTickLog(`exec ${plan.batch.batchId}: urgent-exec dry-run kind=${kind}（不写盘）`);
      } else if (!bump.ok) {
        appendAudit({
          type: 'restart-urgent-counter-failed', correlationId: plan.batch.batchId, reason: URGENT_DAILY_REASONS.COUNTER_FAILED,
          kind, aborted: true, error: bump.error ?? null,
          used: plan.urgentDaily?.used ?? null, limit: plan.urgentDaily?.limit ?? null, day: plan.urgentDaily?.day ?? null,
          note: '当日加急计数写盘失败 ⇒ 放弃本次加急执行（退回 queue + **零状态写入**）；下一 tick 重判',
        }, { home });
        writeTickLog(`exec ${plan.batch.batchId}: urgent counter FAILED（${bump.error ?? 'unknown'}）⇒ 放弃执行、退回 queue`);
        alert({ level: 'warn', source: 'butler-restart', message: `加急档计数写盘失败，已放弃本次执行：${bump.error ?? 'unknown'}`, detail: { stateFile, kind } }, { home, silent: true });
        safeUpdateState(stateFile, home, (cur) => {
          const s = { ...emptyState(), ...(cur ?? {}) };
          return {
            ...s,
            heartbeat: { at: Date.now(), pid: process.pid, version: VERSION, task: TASK_NAME },
            queue: {
              batchId: plan.batch.batchId, correlationId: plan.batch.batchId, remindFingerprint: remindFingerprint(plan),
              since: plan.batch.waitingSince, waitingMs: plan.waitingMs,
              active: plan.active.map((x) => ({ sessionId: x.sessionId, title: x.title, tail: x.tail, ageMs: x.ageMs, activeSource: x.activeSource ?? null, state: x.state ?? null })),
              tier: plan.tierEffective, tierRequested: plan.tierRequested, escalated: plan.tierEscalated,
              cardActive: plan.cardActive.map((x) => ({ sessionId: x.sessionId })),
              softActive: plan.softActive.map((x) => ({ sessionId: x.sessionId })),
              cardSessionIndexOk: plan.cardSessionIndexOk === true, cardSessionDegraded: plan.cardSessionDegraded === true,
              softProtect: { mode: plan.softProtect?.mode ?? null, source: plan.softProtect?.source ?? null, holdCount: plan.softProtect?.holdCount ?? 0, holdIds: plan.softProtect?.holdIds ?? [] },
              excluded: plan.excluded, reasons: plan.batch.reasons, inFallbackWindow: plan.inFallbackWindow,
              urgentCounterFailed: { kind, error: bump.error ?? null, at: Date.now() },
              updatedAt: now,
            },
            counters: { ...s.counters, ticks: (s.counters?.ticks ?? 0) + 1, queued: (s.counters?.queued ?? 0) + 1 },
          };
        });
        return { ...result, action: 'queue', reason: URGENT_DAILY_REASONS.COUNTER_FAILED, urgentExec, durationMs: Date.now() - t0 };
      } else {
        writeTickLog(`exec ${plan.batch.batchId}: urgent-exec counted kind=${kind}`
          + ` used=escalated ${bump.escalated}/${bump.limit} · explicit ${bump.explicit}`);
      }
    }
    const winRec = makeMaintenanceWindow({ correlationId: plan.batch.batchId, now, policy, reason: plan.batch.reasons.join('；') || 'butler restart request' });
    result.execute = {
      batchId: plan.batch.batchId, interruptions: interruptions.length, forced: plan.batch.force,
      // 【A4 前置】本次加急记账（null = 本次不是加急档执行）
      urgentKind: urgentExec?.kind ?? null, urgentUsedToday: urgentExec?.escalated ?? null,
    };

    if (opts.dryRun) {
      return { ...result, action: 'restart', reason: plan.reason, dryRun: true, window: winRec, interruptions, staleWait: result.staleWait, durationMs: Date.now() - t0 };
    }

    // 8.1 维护窗口（先写：P2 静默 + 超时判定都靠它）
    // 通知目标（本批次发起者会话）先算好：它要同时进 8.2 批次状态、8.4 脚本 env、审计
    const notifyTarget = (plan.batch.requesterIds ?? [])[0] ?? null;
    const notifyTargets = plan.batch.requesterIds ?? [];
    writeMaintenanceWindow(winRec, { home });
    writeTickLog(`exec ${plan.batch.batchId}: window written`);
    // 8.2 批次落状态（重启后靠它补发通知）
    updateStateJson('butler-restart-state.json', stateFile, (cur) => {
      const s = { ...emptyState(), ...(cur ?? {}) };
      return {
        ...s,
        heartbeat: { at: Date.now(), pid: process.pid, version: VERSION, task: TASK_NAME },
        queue: null,
        pendingNotify: {
          batchId: plan.batch.batchId, correlationId: plan.batch.batchId, createdAt: now,
          mode: plan.batch.force ? 'force' : 'queue', reasons: plan.batch.reasons,
          interrupted: interruptions, requesters: plan.batch.requesterIds,
          // 【加急档·A2】档位随批次落盘（重启后 `flushPendingNotify` 的文案要用它；normal/force 档下不参与文案）
          tier: plan.tierEffective, escalated: plan.tierEscalated, waitingMs: plan.waitingMs,
          heldForUserInput: plan.softProtect?.holdCount ?? 0, interruptedCards: j3.violations.length,
          // 旁路通知名单【D17 / 2026-09-23】：重启前 N 分钟内有活动、但重启瞬间没在跑、
          // 且未另有通知（不在 interrupted / 不是发起者）的会话 → 重启后补一条自查提醒。
          // 快照（含 ageMs/why）随批次落盘，重启后由 flushPendingNotify 消费。
          staleWait: staleWait.list ?? [],
          staleWaitStats: staleWait.stats ?? null,
          // 发起者显示名（通知文案用）与本次写入 guard-session.id 的目标（守护鱼去重判据）
          requesterLabels: notifyTargets.map((id) => views.titles.get(id) ?? null),
          guardTarget: notifyTarget,
          notified: [],
        },
        counters: { ...s.counters, ticks: (s.counters?.ticks ?? 0) + 1, restarts: (s.counters?.restarts ?? 0) + 1 },
      };
    }, { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() });
    // ---- 黑匣子（2026-09-11 排查"执行了重启却没留账"）：8.x 分步落日志，
    //      下次复现时一眼看出 tick 是在哪一步之后断的（tick 日志在 <tmp>\dsh-butler-restart.log）。
    writeTickLog(`exec ${plan.batch.batchId}: pendingNotify written (requester=${notifyTarget ?? 'none'})`);
    // 8.3 请求标记 executing
    mutateRequests(reqFile, () => ({ requests: all.map((r) => (r.state === 'pending' ? { ...r, state: 'executing', batchId: plan.batch.batchId, startedAt: now } : r)) }), { home });
    writeTickLog(`exec ${plan.batch.batchId}: requests marked executing (${plan.batch.requestIds.length})`);
    // ---- 【施工卡 ①-3 · P-2③】双值留痕：预计 N（UI）+ 实际 N（执行时刻）+ 打断列表 ----
    //   口径差**如实记录、不当 bug**（①包 §3.2 轮五 E13 实测）：
    //     · 预计值 = 面板签发确认令牌时的 `resolvePanelTarget().activeCount`（= 面板即时视图的活跃会话数）
    //     · 实际值 = 这里的 `allActive = merged.active`（**未排除发起者**，:697）
    //     · 计划值 `plan.active` 则**排除发起者**（`lib/restart.mjs:366-371`，且只对非 panel 发起者排除）
    //   ⇒ 会话内 `--force` 场景下"预计 N"与"实际 N"**天生差 1**（正常，不是 bug）。
    //   预计值来源 = 面板请求对象上的 `expectedActive`（`state.js requestRestart` 写入）；取不到就是 null，**不补 0**。
    const batchReqs = (Array.isArray(all) ? all : []).filter((r) => (plan.batch.requestIds ?? []).includes(r?.id));
    const expectedAll = batchReqs.map((r) => (Number.isFinite(r?.expectedActive) ? r.expectedActive : null)).filter((x) => x !== null);
    const expectedActive = expectedAll.length ? Math.max(...expectedAll) : null;
    const expectedSource = batchReqs.find((r) => Number.isFinite(r?.expectedActive))?.expectedSource ?? null;
    appendAudit({
      type: 'restart-execute', correlationId: plan.batch.batchId, reason: plan.reason,
      requesterIds: plan.batch.requesterIds, requestIds: plan.batch.requestIds,
      // 【加急档·A2 · 方案 §3.7 可观测字段】"为什么在等 / 凭什么敢打断 / 有没有碰到卡"一眼可见
      tier: plan.tierEffective, tierRequested: plan.tierRequested, escalated: plan.tierEscalated,
      // 【A4 前置 · 复审 R-4】本次加急的记账口径与当日用量（`escalated`=排队超时升档 / `explicit`=人显式加急）
      urgentKind: urgentExec?.kind ?? null,
      urgentEscalationApplied: plan.tierEscalationApplied === true,
      urgentUsedToday: urgentExec?.escalated ?? null,
      urgentLimit: urgentExec?.limit ?? plan.urgentDaily?.limit ?? null,
      cardActive: plan.cardActive.map((x) => x.sessionId), softActive: plan.softActive.map((x) => x.sessionId),
      // 复审 R-1②：卡索引退化态**必须可见**（degraded ⇒ 全部活跃按卡会话处理 ⇒ 加急档一律 queue）
      cardSessionIndexOk: plan.cardSessionIndexOk === true, cardSessionDegraded: plan.cardSessionDegraded === true,
      // 软保护三态（复审 N-6）：`off` = 显式关闭 / `unavailable` = 输入面不可用（fail-safe 退回 queue）
      softProtectMode: plan.softProtect?.mode ?? null,
      softProtectDisabled: plan.softProtect?.disabled === true,
      softProtectUnavailable: plan.softProtect?.unavailable === true,
      heldForUserInput: plan.softProtect?.holdCount ?? 0, holdIds: plan.softProtect?.holdIds ?? [],
      // J3 红线断言（**恒 0** = 非发起者的卡执行会话未进打断清单）；`interruptedCardSessions` 含
      // "发起者本人是卡会话"的现状语义（拍板 ⑤=a），单列留痕、不参与恒 0。
      interruptedCards: j3.violations.length,
      interruptedCardSessions: j3.cardSessionIds,
      interruptedCardAssert: j3.assert,
      cardIndexDegradedForAssert: j3.degraded,
      abortedLateCard: false, // 本批已过二次校验才走到这里（被 abort 的批次直接 return，不会有本行）
      revalidate: revalidate
        ? { aborted: revalidate.aborted, reason: revalidate.reason, cardActive: revalidate.cardActive, heldForUserInput: revalidate.heldForUserInput, newActive: revalidate.newActive, sources: revalidate.sources }
        : null,
      // 本次写进 guard-session.id 的目标（= 守护鱼/协调器共同的通知对象）
      notifyTarget, notifyTargets,
      interrupted: interruptions.map((x) => x.sessionId), forced: plan.batch.force,
      activeBefore: allActive.length,
      // 【D17 / 2026-09-23】旁路通知候选（快照时刻的名单 + 排除计数）：复盘"当时挑了谁、为什么没挑谁"
      staleWait: staleWait.list.map((x) => x.sessionId),
      staleWaitCount: staleWait.list.length,
      staleWaitStats: staleWait.stats ?? null,
      // 双值留痕（①-3）：预计值来自面板确认框签发令牌时的即时视图；实际值 = activeBefore/打断列表
      interruptedCount: interruptions.length,
      expectedActive, expectedSource, expectedAll,
      expectedFrom: expectedActive === null ? null : 'panel-confirm-token',
    }, { home });

    // 8.4 调 dsh-restart.ps1（守护鱼必须一直活着——脚本内部会先确保 guard 在跑）
    //     ⚠️ env 必须净化：本次批次的发起者 → guard-session.id 的唯一真相
    const rr = await runRestartScript({ script: opts.restartScript, timeoutMs: opts.restartTimeoutMs ?? 120_000, env: buildRestartEnv(process.env, notifyTarget) });
    result.restart = { ok: rr.ok, code: rr.code, tail: (rr.output ?? '').slice(-400) };
    writeTickLog(`exec ${plan.batch.batchId}: restart script done ok=${rr.ok} code=${rr.code ?? '-'}`);
    if (!rr.ok) {
      alert({ level: 'error', source: 'butler-restart', message: `dsh-restart.ps1 执行失败：${rr.error ?? 'exit ' + rr.code}`, detail: { output: rr.output } }, { home });
      appendAudit({ type: 'restart-script-failed', correlationId: plan.batch.batchId, code: rr.code, error: rr.error ?? null }, { home });
      // 重启没发起 → 清窗口 + 清待通知 + 请求回滚 pending（下一 tick 可重试，不会卡死）
      clearMaintenanceWindow({ home });
      settleBatchRequests(reqFile, plan.batch.batchId, { home, state: 'pending', reason: 'script-failed' });
      updateStateJson('butler-restart-state.json', stateFile, (cur) => ({ ...emptyState(), ...(cur ?? {}), pendingNotify: null }), { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() });
      return { ...result, action: 'restart-failed', reason: rr.error ?? `exit ${rr.code}`, durationMs: Date.now() - t0 };
    }

    // 8.5 等就绪 → 多播通知 + 写打断清单
    if (opts.skipWait) return { ...result, action: 'restart', reason: 'restarted(skip-wait)', durationMs: Date.now() - t0 };
    const wait = await waitForReady({ baseUrl, timeoutMs: opts.readyTimeoutMs ?? 120_000 });
    result.ready = wait.ready;
    writeTickLog(`exec ${plan.batch.batchId}: ready=${wait.ready}`);
    if (!wait.ready) {
      appendAudit({ type: 'restart-not-ready', correlationId: plan.batch.batchId, probe: wait.probe }, { home });
      return { ...result, action: 'restart', reason: 'restarted-but-not-ready', durationMs: Date.now() - t0 };
    }
    const flushed = await flushPendingNotify({ home, baseUrl, correlationId: plan.batch.batchId, now: Date.now() });
    // 【2026-11-05 本卡】日志带上探测读数（port/rpc 各自 ms 与超时）—— 下次再遇到"欠条悬挂"，
    //   看一眼 tick 日志就能分清「服务真没起来」还是「RPC 慢过线」，不用再翻代码复算。
    const pd = flushed.probe ?? null;
    writeTickLog(`exec ${plan.batch.batchId}: flushed notified=${flushed.notified?.length ?? 0} failed=${flushed.failed?.length ?? 0} skipped=${flushed.skipped ? flushed.reason ?? 'yes' : 'no'}`
      + (pd ? ` probe=${pd.portReachable ? 'port' : 'noport'}/rpc=${pd.rpcOk ? 'ok' : 'no'} portMs=${pd.portMs ?? '-'} rpcMs=${pd.rpcMs ?? '-'} budget=${pd.portTimeoutMs ?? '-'}/${pd.rpcTimeoutMs ?? '-'}` : ''));
    const settled = settleBatchRequests(reqFile, plan.batch.batchId, { home, now: Date.now(), state: 'done', reason: 'restart-completed' });
    clearMaintenanceWindow({ home });
    appendAudit({ type: 'restart-completed', correlationId: plan.batch.batchId, ready: true, notified: flushed.notified?.length ?? 0, failed: flushed.failed?.length ?? 0, settled }, { home });
    return { ...result, action: 'restart', reason: 'completed', flushed, settled, durationMs: Date.now() - t0 };
  } catch (e) {
    // 黑匣子：tick 中途抛错也要留痕（否则只写 alert，翻起来慢）
    try { writeTickLog(`error ${e?.message ?? e}`); } catch { /* noop */ }
    alert({ level: 'error', source: 'butler-restart', message: `tick 异常：${e?.message ?? e}`, detail: { stack: (e?.stack ?? '').split('\n').slice(0, 4).join(' | ') } }, { home });
    return { ...result, action: 'error', reason: e?.message ?? String(e), durationMs: Date.now() - t0 };
  } finally {
    lock.release();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ★【2026-10-26 主人令】加急档自动喊话（`drain-freeze.mjs --send` 的自动触发面）
//   真源：`docs\交付报告-加急档自动喊话-20261026.md`；唯一调用方 = tick 的 6.35 段。
//   ⚠️ 本段**只做副作用**（跑一次现成工具 + 记一条留痕），不改任何判定：
//      档位 / 低水位 / 卡与非卡分流全在 `planRestart()`（lib\restart.mjs）里，这里一个字不碰；
//      选人（该喊谁、卡执行会话一律不喊）全在 `drain-freeze.mjs` 里，这里也不自己造投递。
// ══════════════════════════════════════════════════════════════════════════

/** 子进程超时（drain-freeze 是短命脚本：取数 + 几次 RPC，60s 足够）。 */
const AUTO_DRAIN_TIMEOUT_MS = 60_000;
/**
 * **同一会话**的喊话冷却窗（主人 2026-10-26 定死 = 30 分钟）。
 * ⚠️ 幂等键必须落在 **sid** 上，不能是 batchId：`mergeBatch()` 每 tick 重新 `makeBatchId()`，
 *    而且**任何主线新增/结算请求**都会重算批次 —— 包括会话照指令去 `request-restart` **领通知**
 *    新建的那条请求（实测 rst-20261026020602-3901 → rst-20261026020717-eeo0）
 *    ⇒ 按批次判幂等会变成「领一次 → 批次变 → 再发一轮」的死循环。
 */
const AUTO_DRAIN_SID_COOLDOWN_MS = 30 * 60_000;
/** **整次喊话失败**后的重试冷却（防每分钟刷一个注定失败的子进程；成功则只受 sid 冷却约束）。 */
const AUTO_DRAIN_RETRY_COOLDOWN_MS = 10 * 60_000;
/** 喊话工具（唯一投递面；**不绕过它自己写投递**）。 */
const AUTO_DRAIN_SCRIPT_DEFAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drain-freeze.mjs');
/** 关回开关的 env 键（值 ∈ 0/off/false/no 判关；其余非空值一律判开）。 */
const AUTO_DRAIN_ENV_KEY = 'DSH_RESTART_AUTO_DRAIN_FREEZE';
const AUTO_DRAIN_OFF_VALUES = new Set(['0', 'off', 'false', 'no']);

/**
 * 开关求值：① env（**优先**）② 策略文件 `autoDrainFreeze` ③ 缺省 = **开**（主人令）。
 * ⚠️ 默认方向写死为"开"：读不到 / 值奇怪 ⇒ 开（这正是主人要的默认行为）；
 *    关回必须**显式**给 env=0 或策略文件 false。
 * @returns {{enabled:boolean, source:string}}
 */
export function autoDrainFreezeSwitch({ policy = null, env = process.env } = {}) {
  const raw = env?.[AUTO_DRAIN_ENV_KEY];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const v = raw.trim().toLowerCase();
    return { enabled: !AUTO_DRAIN_OFF_VALUES.has(v), source: `env:${AUTO_DRAIN_ENV_KEY}=${raw.trim()}` };
  }
  if (policy && policy.autoDrainFreeze === false) return { enabled: false, source: 'policy:autoDrainFreeze=false' };
  return { enabled: true, source: 'default(开)' };
}

/**
 * 触发判据（三条同时成立）：
 *   ① `tierEscalated`（等久了**自动**升的档；人显式 urgent 不在此列）
 *   ② `tierEffective === 'urgent'`（升档没被每日限额闸门拒）
 *   ③ `action === 'queue'`（还在等，没到低水位）
 * @returns {{fire:boolean, why:string, batchId?:string}}
 */
export function autoDrainFreezeTrigger(plan) {
  if (!plan) return { fire: false, why: 'no-plan' };
  if (plan.tierEscalated !== true) return { fire: false, why: `not-escalated(tier=${plan.tierEffective ?? '?'})` };
  if (plan.tierEffective !== 'urgent') return { fire: false, why: `escalation-blocked(effective=${plan.tierEffective ?? '?'}${plan.urgentDeniedReason ? `,${plan.urgentDeniedReason}` : ''})` };
  if (plan.action !== 'queue') return { fire: false, why: `action=${plan.action ?? '?'}` };
  const batchId = plan.batch?.batchId ? String(plan.batch.batchId) : null;
  if (!batchId) return { fire: false, why: 'no-batchId' };
  return { fire: true, why: `escalated-urgent-queue(${plan.reason ?? '-'})`, batchId };
}

/** 从 `--json` 输出里取一段 JSON（工具只打一段；容错容忍前面有杂行）。解析不出 ⇒ null。 */
function parseDrainFreezeJson(stdout) {
  const s = String(stdout ?? '').trim();
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

/**
 * 跑一次 `node drain-freeze.mjs --send --json`：**窗口隐藏 + 超时 + 收 stdout/stderr**。
 * 永不抛（spawn 失败 / 超时 / 非 0 退出全部落成返回值）。
 * @returns {Promise<{ok:boolean,code:number|null,signal:string|null,error:string|null,
 *                    stdout:string,stderr:string,timedOut:boolean,durationMs:number}>}
 */
async function runDrainFreezeOnce(opts = {}) {
  const {
    script = AUTO_DRAIN_SCRIPT_DEFAULT,
    extraArgs = [],
    timeoutMs = AUTO_DRAIN_TIMEOUT_MS,
    env = process.env,
  } = opts;
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const out = { ok: false, code: null, signal: null, error: null, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
    let settled = false;
    const done = (patch) => {
      if (settled) return;
      settled = true;
      resolve({ ...out, ...patch, durationMs: Date.now() - t0 });
    };
    let child;
    try {
      child = spawn(process.execPath, [script, '--send', '--json', ...(Array.isArray(extraArgs) ? extraArgs : [])], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
      });
    } catch (e) {
      done({ error: `spawn 失败：${e?.message ?? e}` });
      return;
    }
    const timer = setTimeout(() => {
      out.timedOut = true;
      try { child.kill(); } catch { /* noop */ }
      done({ error: `超时 ${Math.round((Number(timeoutMs) || AUTO_DRAIN_TIMEOUT_MS) / 1000)}s 未退出（已 kill）` });
    }, Math.max(5_000, Number(timeoutMs) || AUTO_DRAIN_TIMEOUT_MS));
    if (typeof timer.unref === 'function') timer.unref();
    // 收集输出（封顶 200KB：`--json` 含正文，正常 < 20KB；防异常刷屏把内存吃光）
    const CAP = 200_000;
    const push = (cur, chunk) => (cur.length >= CAP ? cur : cur + String(chunk));
    child.stdout?.on('data', (c) => { out.stdout = push(out.stdout, c?.toString?.() ?? c); });
    child.stderr?.on('data', (c) => { out.stderr = push(out.stderr, c?.toString?.() ?? c); });
    child.on('error', (e) => { clearTimeout(timer); done({ error: `子进程错误：${e?.message ?? e}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? null, signal: signal ?? null, ok: code === 0, error: code === 0 ? null : `exit ${code ?? signal ?? '?'}` });
    });
  });
}

/**
 * 加急档自动喊话（6.35 段主体）。**永不抛**：所有异常在这里收口成 `ok:false` + 一行 tick 日志。
 *
 * 幂等口径（主人 2026-10-26 定死 · 由实测缺陷驱动）：
 *   · 幂等键 = **sid**，不是 batchId —— `mergeBatch()` 每 tick 重新 `makeBatchId()`，而且任何主线
 *     新增/结算请求（**包括"领通知"新建的那条**）都会重算批次（实测 rst-…020602-3901 →
 *     rst-…020717-eeo0）⇒ 按批次判幂等从根上不可靠。
 *   · 状态文件 `queue.drainFreeze.sids = { <sid>: <lastSentAt> }`：同一 sid 在 **30 分钟冷却窗**
 *     内只喊一次（冷却中的 sid 落临时名单，交 drain-freeze 的 `--skip-sids-file` 跳过）。
 *   · 清空时机 = **重启执行完成 / lastBatch 落地**（`autoDrainSidsCleared()`，见 `flushPendingNotify`）
 *     ⇒ 下一轮等待期还会喊。
 *   · 整次喊话失败 ⇒ 10 分钟冷却后才重试（成功不受此限，只受 sid 冷却约束）。
 *
 * @returns {Promise<object>} 投影（写进 `tick()` 的 `result.autoDrainFreeze`，也给单测/演练看）
 */
export async function maybeAutoDrainFreeze({ home, stateFile, plan, policy = null, now = Date.now(), opts = {}, log = writeTickLog } = {}) {
  const sw = autoDrainFreezeSwitch({ policy, env: opts.env ?? process.env });
  const trig = autoDrainFreezeTrigger(plan);
  const batchId = trig.batchId ?? (plan?.batch?.batchId ? String(plan.batch.batchId) : null);
  const roundKey = plan?.batch?.waitingSince ? String(plan.batch.waitingSince) : null;
  const summary = { enabled: sw.enabled, switchSource: sw.source, trigger: trig.why, fire: trig.fire === true, batchId, roundKey };
  const iso = (t) => new Date(t).toISOString();
  const short = (sid) => String(sid ?? '').replace(/^session-/, '').slice(0, 8);
  let skipFile = null;
  // 开关关着：**只有真的够触发条件时**才留一行（否则每分钟刷一行噪音）
  if (!sw.enabled) {
    if (trig.fire === true) log(`auto-drain-freeze OFF（开关 ${sw.source}）⇒ 本轮不喊话（本该喊批次 ${batchId}）`);
    return { ...summary, ok: true, skipped: 'switch-off' };
  }
  if (trig.fire !== true) return { ...summary, skipped: 'not-triggered' };
  if (opts.dryRun === true) {
    log(`auto-drain-freeze DRY-RUN：本该喊话批次 ${batchId}（${trig.why}）—— 演练不 spawn、不写状态`);
    return { ...summary, skipped: 'dry-run' };
  }
  try {
    const prevRec = readState(stateFile, { home })?.queue?.drainFreeze ?? null;
    // ① 整次失败的重试冷却（与 sid 冷却无关；防每分钟 spawn 一个注定失败的子进程）
    if (prevRec && prevRec.ok === false) {
      const failAt = Date.parse(prevRec.failureAt ?? prevRec.at ?? '') || 0;
      const ageMs = Math.max(0, now - failAt);
      if (ageMs < AUTO_DRAIN_RETRY_COOLDOWN_MS) {
        log(`auto-drain-freeze SKIP：上轮喊话失败、冷却中（${Math.round(ageMs / 1000)}s < ${Math.round(AUTO_DRAIN_RETRY_COOLDOWN_MS / 60_000)}min，批次 ${batchId}）⇒ 本轮不重试`);
        return { ...summary, skipped: 'retry-cooldown', previous: prevRec };
      }
    }
    // ② sid 冷却表：只保留仍在 30 分钟窗内的（过期项释放 ⇒ 同一会话下一轮还能再喊）
    const prevSids = (prevRec && prevRec.sids && typeof prevRec.sids === 'object') ? prevRec.sids : {};
    const cooling = {};
    const dropped = [];
    for (const [sid, at] of Object.entries(prevSids)) {
      const ts = Date.parse(at);
      if (!Number.isFinite(ts)) continue;
      if (now - ts < AUTO_DRAIN_SID_COOLDOWN_MS) cooling[String(sid)] = at;
      else dropped.push(String(sid));
    }
    const coolingList = Object.keys(cooling);
    // 日志必须打出 batchId + sid 冷却命中（主人要求；也是"批次号会变"这条坑的现场证据）
    log(`auto-drain-freeze 喊话准备：批次 ${batchId}（round=${roundKey ?? '-'}；批次号每 tick 重算、领通知新建请求也会重算）`
      + ` tier=urgent+escalated action=queue ‖ sid 冷却命中 ${coolingList.length}/${Object.keys(prevSids).length}`
      + `${coolingList.length ? ` ⇒ ${coolingList.map(short).join(',')}` : ''}`
      + `${dropped.length ? `（过期释放 ${dropped.map(short).join(',')}）` : ''}`);
    // ③ 冷却名单落临时文件（选人/投递全交给 drain-freeze，这里不自己造投递）
    if (coolingList.length) {
      skipFile = path.join(os.tmpdir(), `dsh-auto-drain-skip-${process.pid}-${now}.json`);
      fs.writeFileSync(skipFile, JSON.stringify({ sids: coolingList, batchId, roundKey }, null, 1), 'utf8');
    }
    const extraArgs = ['--ledger', path.join(home, 'butler-drain-freeze.json')];
    if (skipFile) extraArgs.push('--skip-sids-file', skipFile);
    if (Array.isArray(opts.drainFreezeArgs)) extraArgs.push(...opts.drainFreezeArgs);
    // ④ 真跑一次现成工具（不自己投递、不 --force、不 taskkill）
    const run = await runDrainFreezeOnce({
      script: opts.drainFreezeScript ?? AUTO_DRAIN_SCRIPT_DEFAULT,
      extraArgs,
      timeoutMs: opts.drainFreezeTimeoutMs ?? AUTO_DRAIN_TIMEOUT_MS,
      env: opts.env ?? process.env,
    });
    const parsed = parseDrainFreezeJson(run.stdout);
    const delivered = Array.isArray(parsed?.delivered) ? parsed.delivered : [];
    const sendList = Array.isArray(parsed?.send) ? parsed.send : [];
    const skipList = Array.isArray(parsed?.skip) ? parsed.skip : [];
    const sentRows = delivered.filter((d) => d?.ok === true);
    const sent = sentRows.length;
    const failed = delivered.length - sent;
    // 空集 = 本轮没有"未冷却且挡门"的会话 ⇒ drain-freeze 自检 ④ 会 rc=2。**这不是故障**：
    //   语义是"本轮没新对象要喊"，按成功记账（否则会一路重试到批次变更）。
    const emptySet = run.code === 2 && sendList.length === 0 && parsed?.selfCheck?.pass === false;
    const ok = run.code === 0 || emptySet;
    // ⑤ 冷却表推进：成功投递的 sid 记 now；未过期的保留；本轮失败的**不记**（下一轮还要再试）
    const nextSids = { ...cooling };
    if (ok) for (const d of sentRows) nextSids[String(d.sid)] = iso(now);
    const rec = {
      batchId, roundKey, at: iso(now), ok,
      sent, failed, skipped: skipList.length, coolingHit: coolingList.length,
      code: run.code ?? null, error: run.error ?? null,
      emptySet, timedOut: run.timedOut === true, durationMs: run.durationMs,
      sids: nextSids,
      failureAt: ok ? null : iso(now),
    };
    const wrote = safeUpdateState(stateFile, home, (cur) => ({ ...(cur ?? {}), queue: { ...((cur ?? {}).queue ?? {}), drainFreeze: rec } }));
    const tail = (txt) => String(txt ?? '').replace(/\s+/g, ' ').trim().slice(-260);
    log(`auto-drain-freeze ${ok ? '自动喊话成功' : '自动喊话失败'}：批次 ${batchId}（round=${roundKey ?? '-'}）`
      + ` sent=${sent} failed=${failed} skipped=${skipList.length} 冷却命中=${coolingList.length} rc=${run.code ?? '-'}`
      + `${emptySet ? '（空集：本轮没有未冷却的挡门会话 ⇒ drain-freeze 自检④ rc=2，按成功记账）' : run.error ? ` err=${run.error}` : ''}`
      + ` 冷却表=${Object.keys(nextSids).length}人 ${run.durationMs}ms`
      + `${wrote ? '' : '（状态留痕写盘失败，已告警）'}${run.stderr ? ` stderr=${tail(run.stderr)}` : ''}`);
    return { ...summary, ok, sent, failed, skipped: skipList.length, coolingHit: coolingList.length, code: run.code ?? null, emptySet, wrote: !!wrote };
  } catch (e) {
    // 兜底：任何异常都只留痕 + 记 ok:false，绝不冒泡（fail-open 硬要求）
    const msg = e?.message ?? String(e);
    log(`auto-drain-freeze 自动喊话失败（异常：${msg}）—— 本轮判定不受影响（fail-open）`);
    try {
      safeUpdateState(stateFile, home, (cur) => ({
        ...(cur ?? {}),
        queue: {
          ...((cur ?? {}).queue ?? {}),
          drainFreeze: {
            ...(((cur ?? {}).queue ?? {}).drainFreeze ?? {}),
            batchId, roundKey, at: iso(now), ok: false, failureAt: iso(now), error: msg,
          },
        },
      }));
    } catch { /* 写不进也不许抛 */ }
    return { ...summary, ok: false, error: msg };
  } finally {
    if (skipFile) { try { fs.unlinkSync(skipFile); } catch { /* 临时件删不掉不影响任何判定 */ } }
  }
}

/**
 * 【2026-10-26】自动喊话的 **sid 冷却表清空**（主人定死的清空时机 = 「重启执行完成 / lastBatch 落地」）。
 * 目的：清空后**下一轮等待期还会喊**；不清空则一次重启完成后 30 分钟内谁都喊不到。
 * ⚠️ 只在"重启真的走完了"的路径上调用（`flushPendingNotify` 的两处 lastBatch 落地点），
 *    每 tick 都调等于没有冷却。
 */
function autoDrainSidsCleared(queue, reason, now = Date.now()) {
  return {
    ...(queue ?? {}),
    drainFreeze: { sids: {}, clearedAt: new Date(now).toISOString(), clearedReason: reason },
  };
}

function readState(file, opts = {}) {
  try { return readJson(file, { schemaVersion: RESTART_STATE_SCHEMA, home: opts.home, defaultValue: emptyState() }) ?? emptyState(); }
  catch { return emptyState(); }
}

/**
 * 状态文件**安全写入**包装（与 `beat()` 同体例）：写失败 ⇒ 记日志 + 告警（**不静默**），
 * 但**不把整个 tick 打成 `action:'error'`** —— 判定结论（`result.plan` / 加急档额度闸门的
 * `urgent-daily-unavailable`）已经在内存里，该报的照报。
 *
 * 【为什么需要 · 2026-09-28】执行层单测暴露：状态文件被写坏（坏 JSON）时，`updateJson` 里的
 *   `readJson` 会抛 `StoreError`；排队分支那次写入若裸调，异常会一路冒到 `tick()` 的最外层
 *   catch ⇒ 返回值变成 `action:'error'`，把"加急档因计数器不可用而拒绝升档"这条**真语义**盖成
 *   一个看起来像"协调器崩了"的错误码（同时队列信息也没了）。本包装只用于**本卡新增/改造**的写入点，
 *   既有写入点一概不动（零回归）。
 */
function safeUpdateState(file, home, fn) {
  try {
    return updateStateJson('butler-restart-state.json', file, fn, { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() });
  } catch (e) {
    writeTickLog(`state write failed: ${e?.message ?? e}`);
    alert({ level: 'warn', source: 'butler-restart', message: `状态写盘失败（本轮判定不受影响，已继续）：${e?.message ?? e}`, detail: { file } }, { home, silent: true });
    return null;
  }
}

/** 发起者显示名（优先会话标题，退化到短 id）——通知文案「发起者：X」用。 */
function requesterLabel(pending, sessionId) {
  const ids = Array.isArray(pending?.requesters) ? pending.requesters : [];
  const idx = ids.indexOf(sessionId);
  const label = idx >= 0 ? pending?.requesterLabels?.[idx] : null;
  return String(label ?? '').trim() || String(sessionId ?? '').slice(0, 16);
}

/** 欠条滞留告警阈值（默认 15 分钟 ≈ 10~20 轮 tick，足够排除"重启后短暂未就绪"的正常延迟）。 */
const DEFAULT_NOTIFY_STUCK_MS = 15 * 60_000;

/**
 * 【2026-09-29 修 · 重启通知补齐】`pendingNotify` 欠条的**优先兑现**（每轮 tick 的独立前置步骤）。
 *
 * 为什么需要：`pendingNotify` = "重启已发起、通知还没送达"的欠条。原实现只有三条兑现支路
 *   （维护窗口 `cleared` / `overdue` / 3.5 `notify-retry`），**全部排在交接窗口判定之后**：
 *   ① 交接窗口 active（`tick-handoff.lock` 被持，TTL 45~60 分钟）时 tick 的 1.5 步直接 `busy` 返回
 *      ⇒ 整轮不兑现（2026-09-29 实测：重启前后 `tick-handoff.lock` 正被 pid 19508 持有）；
 *   ② 维护窗口处于 `pending` 相位时第 3 步提前返回 ⇒ 也不兑现。
 *   2026-09-29 09:46 实测（批次 rst-20260929014640-b8w3）：重启确实成功（dsh pid 43120→12160），
 *   但 `pendingNotify.notified = []` 一条都没投出。
 *
 * 判据（**为什么这样就不会再被吞**）：本步的生效条件只有三条 —— **tick 在跑**、**有欠条**、
 *   **DSH 可达**；与维护窗口相位 / 交接窗口 / restart job 是否残留 `running` **完全解耦**，
 *   且它位于 tick 最前段（策略告警之后、交接窗口之前、任何分支 return 之前）。
 *   `flushPendingNotify` 自带幂等（`notified` 集合去重）与"未就绪即跳过"，重复调用零副作用。
 *
 * 语义边界：**只兑现欠条，不做任何重启决策**（不读请求、不发起重启、不清维护窗口）。
 * @returns {Promise<{consumed:boolean, reason:string, batchId?:string, ageMs?:number, targets?:number, flushed?:object}>}
 *   `consumed=true` 仅当**本轮真的兑现了**（含"无目标 ⇒ 收尾清空"与"投递完成"两种）；
 *   `skipped`（如 DSH 未就绪）时返回 false，**不阻断**后续流程。
 */
export async function priorityNotifyPass({ home, baseUrl, stateFile, now, opts = {} }) {
  const pn = readState(stateFile, { home }).pendingNotify;
  if (!pn) return { consumed: false, reason: 'no-pending' };
  const ageMs = Math.max(0, now - Number(pn.createdAt ?? now));
  // 目标三种：被打断会话 + 批次发起者 + 旁路名单（与 3.5 步同口径）
  const targets = (pn.interrupted?.length ?? 0) + (pn.requesters?.length ?? 0) + (pn.staleWait?.length ?? 0);
  let flushed;
  if (targets === 0) {
    // 无目标 ⇒ flushPendingNotify 内部直接收尾清空（不需要等 DSH 就绪，否则残留会拖到下次可达）
    flushed = await flushPendingNotify({ home, baseUrl, now });
  } else {
    // 【2026-11-05 本卡】前置闸门与 `flushPendingNotify` 同源判定（`canDeliverNotify`）——
    //   **只要求服务活着**。原先这里用 `isReady`（要求 RPC 也真）⇒ 慢 RPC 时本步直接 skip，
    //   连"试着投一次"的机会都没有（本卡事故的第二道阻断点）。
    const probe = await probeReadiness({ baseUrl, fetchImpl: opts.fetchImpl, rpcImpl: opts.rpcImpl, portTimeoutMs: opts.portTimeoutMs, rpcTimeoutMs: opts.rpcTimeoutMs, timeoutMs: opts.probeTimeoutMs });
    flushed = canDeliverNotify(probe)
      ? await flushPendingNotify({ home, baseUrl, now, fetchImpl: opts.fetchImpl, rpcImpl: opts.rpcImpl, notifyImpl: opts.notifyImpl, portTimeoutMs: opts.portTimeoutMs, rpcTimeoutMs: opts.rpcTimeoutMs, probeTimeoutMs: opts.probeTimeoutMs })
      : { skipped: true, reason: 'not-ready', notified: [], failed: [], probe: probeDigest(probe) };
  }
  // 【2026-11-05 本卡】摘要带探测读数（判"截在服务没起来"还是"截在 RPC 慢"）—— 与 exec 侧同一口径。
  const pd = flushed.probe ?? null;
  const probeNote = pd ? ` probe=${pd.portReachable ? 'port' : 'noport'}/rpc=${pd.rpcOk ? 'ok' : 'no'} rpcMs=${pd.rpcMs ?? '-'}/${pd.rpcTimeoutMs ?? '-'}` : '';
  const summary = (flushed.skipped
    ? `skipped:${flushed.reason ?? 'yes'}`
    : `notified=${flushed.notified?.length ?? 0} failed=${flushed.failed?.length ?? 0}`) + probeNote;
  // 留痕：每一轮"试没试、结果如何、欠条挂了多久"都写进 tick 日志（复盘时不用猜）
  writeTickLog(`notify-priority ${pn.batchId}: ${summary} ageMs=${ageMs} targets=${targets}`);
  // ⚠️ `no-targets` 也返回 `skipped:true`（`flushPendingNotify` 的既有口径），但它是**成功收尾**
  //   （欠条已清空 + lastBatch 留痕）⇒ 必须算"已兑现"，否则会误判成滞留并触发告警。
  const consumed = flushed.skipped !== true || flushed.reason === 'no-targets';
  if (consumed) return { consumed: true, reason: summary, batchId: pn.batchId, ageMs, targets, flushed };
  notifyStuckAlert({ home, stateFile, pending: pn, ageMs, reason: flushed.reason ?? 'skipped', now, stuckMs: opts.notifyStuckMs });
  return { consumed: false, reason: summary, batchId: pn.batchId, ageMs, targets, flushed };
}

/**
 * 【可见化】欠条久未兑现 ⇒ 🔴 告警 + 审计（**同一批次只告一次**）。
 *
 * 为什么需要：2026-09-29 那次事故里，`pendingNotify` 从 09:46 一路挂到 10:30 无人知晓 ——
 *   通知投不出去是**静默**的。本函数把"没人兑现"变成能看见的事件。
 * 边界：只观察不改变投递行为；`ageMs < 阈值` 或本批次已告过 ⇒ 直接返回 false。
 */
function notifyStuckAlert({ home, stateFile, pending, ageMs, reason, now, stuckMs }) {
  const limit = Number(stuckMs) > 0 ? Number(stuckMs) : DEFAULT_NOTIFY_STUCK_MS;
  if (ageMs < limit) return false;
  if (readState(stateFile, { home }).notifyStuckAlertedBatch === pending.batchId) return false;
  try {
    alert({
      level: 'error', source: 'butler-restart',
      message: `🔴 重启通知欠条未兑现（批次 ${pending.batchId} 已挂 ${Math.round(ageMs / 60_000)} 分钟；本轮原因=${reason}）`
        + ' —— 重启已完成但发起/被打断会话收不到「重启完成」通知。先查 tickd 是否在跑：'
        + 'node <pkg>/jobs/butler-tickd.mjs --status（不在=补发链整条停摆，--ensure 拉起）',
      detail: {
        batchId: pending.batchId, ageMs, reason, limitMs: limit,
        targets: { interrupted: pending.interrupted?.length ?? 0, requesters: pending.requesters?.length ?? 0, staleWait: pending.staleWait?.length ?? 0 },
        notified: pending.notified ?? [],
      },
    }, { home });
  } catch { return false; }
  safeUpdateState(stateFile, home, (cur) => ({
    ...(cur ?? emptyState()),
    notifyStuckAlertedBatch: pending.batchId,
    notifyStuckAlertedAt: new Date(now).toISOString(),
  }));
  return true;
}

/**
 * 重启后补发：多播通知被打断会话 + 写打断清单（幂等：已通知过的会话不重复发）。
 */
export async function flushPendingNotify(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = stateFilePath(home);
  const state = readState(file, { home });
  const pending = state.pendingNotify;
  const interrupted = Array.isArray(pending?.interrupted) ? pending.interrupted : [];
  const requesters = Array.isArray(pending?.requesters) ? pending.requesters : [];
  // 【D17 / 2026-09-23】旁路名单（近窗有活动、重启瞬间没在跑、未另有通知的会话）。
  //   写入快照时已排除打断/发起者，这里再**独立去重一次**：旧状态文件（本字段缺失 ⇒ 空数组，
  //   行为与改动前逐字一致）或异常路径都可能留下重叠 ⇒ 同一会话同批次只发一条。
  const staleWaitRaw = Array.isArray(pending?.staleWait) ? pending.staleWait : [];
  const interruptedIds = new Set(interrupted.map((e) => normSessionId(e?.sessionId)).filter(Boolean));
  const requesterSet = new Set(requesters.map((n) => normSessionId(n)).filter(Boolean));
  const staleWait = [];
  {
    const seenSide = new Set();
    for (const e of staleWaitRaw) {
      const id = normSessionId(e?.sessionId);
      if (!id) continue;
      if (interruptedIds.has(id) || requesterSet.has(id) || seenSide.has(id)) continue;
      seenSide.add(id);
      staleWait.push({ ...e, sessionId: id });
    }
  }
  const sideIds = new Set(staleWait.map((e) => e.sessionId));
  const staleWaitWindowMs = Number(pending?.staleWaitStats?.windowMs) > 0 ? Number(pending.staleWaitStats.windowMs) : null;
  if (!pending) return { skipped: true, reason: 'no-pending', notified: [], failed: [] };
  if (!interrupted.length && !requesters.length && !staleWait.length) {
    // 无通知目标（重启时没有活跃会话被打断 + 请求来自面板无发起者会话）→ 正常收尾。
    // ⚠️ 2026-09-09 实测：原实现直接 return，pendingNotify 永久残留 → 每次 tick 白跑一次 probe。
    updateStateJson('butler-restart-state.json', file, (cur) => {
      const s = { ...emptyState(), ...(cur ?? {}) };
      return {
        ...s,
        pendingNotify: null,
        // 【2026-10-26】自动喊话的 sid 冷却表清空时机 ①：lastBatch 落地（重启这一轮真的走完了）
        queue: s.queue ? autoDrainSidsCleared(s.queue, 'restart-completed(lastBatch:no-targets)', opts.now ?? Date.now()) : s.queue,
        lastBatch: {
          batchId: pending.batchId, correlationId: pending.correlationId, createdAt: pending.createdAt,
          mode: pending.mode, reasons: pending.reasons, interrupted: pending.interrupted ?? [],
          // 【D17/2026-09-23】旁路名单（no-targets 分支下必为空，留痕口径统一）
          staleWait: [],
          guardTarget: pending.guardTarget ?? null,
          notified: [], failed: [], noTargets: true, finishedAt: opts.now ?? Date.now(),
        },
      };
    }, { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() });
    appendAudit({
      type: 'restart-notify', correlationId: pending.correlationId, notified: [], failed: [], reason: 'no-targets',
      // 【D17/2026-09-23】旁路口径随留痕（本分支恒为 0）
      staleWaitNotified: [], staleWaitCandidates: 0,
      staleWaitExcluded: pending.staleWaitStats ? { ...pending.staleWaitStats, dupFiltered: staleWaitRaw.length } : { dupFiltered: 0 },
    }, { home });
    return { skipped: true, reason: 'no-targets', notified: [], failed: [], batchId: pending.batchId };
  }
  // 【2026-11-05 本卡】门从 `isReady`（端口 + RPC 都真）改为 `canDeliverNotify`（**服务活着**即可投）。
  //   为什么：慢 RPC 会把「能投递」误判成「DSH 没起来」⇒ 通知欠条悬挂（rst-20261105043535-9b2s 实测）。
  //   为什么安全：投递自带超时 + 失败保留下轮重试（`maxAttempts=3` 不变）⇒ 放宽的是"要不要试"，
  //   不是"失败就不重试"，更不是"无限重试"。
  const probe = await probeReadiness({
    baseUrl: opts.baseUrl,
    timeoutMs: opts.probeTimeoutMs,
    portTimeoutMs: opts.portTimeoutMs,
    rpcTimeoutMs: opts.rpcTimeoutMs,
    fetchImpl: opts.fetchImpl,
    rpcImpl: opts.rpcImpl,
  });
  if (!canDeliverNotify(probe)) return { skipped: true, reason: 'not-ready', notified: [], failed: [], probe: probeDigest(probe) };
  const done = new Set(pending.notified ?? []);
  // 目标 = 被打断会话（逐条「尾巴停在 X」）+ 批次发起者（若没被打断，收「重启完成」）
  //        + 【D17/2026-09-23】旁路名单（近窗有活动但重启瞬间没在跑 ⇒ 收「等待可能已失效」提醒）
  // 三路在构造前**已互相去重**（interrupted / requester / staleWait 三集合两两不重叠），
  // 且每轮投递再过 `done` 集合 ⇒ 同一会话同批次**只发一条**。
  const targets = [
    ...interrupted.map((e) => ({ entry: e, kind: 'interrupted' })),
    ...requesters.filter((id) => !interrupted.some((e) => e.sessionId === id)).map((id) => ({ entry: { sessionId: id }, kind: 'requester' })),
    ...staleWait.map((e) => ({ entry: e, kind: 'stale-wait' })),
  ];
  const notified = [];
  const failed = [];
  // 【加急档·A2】通知文案的档位上下文（方案 §3.6）：`normal` / `force` 档下这些字段不改变任何输出
  //   （`interruptionNotice` / `completionNotice` 只在 `tier==='urgent'` 时追加说明行）。
  const tierInfo = {
    tier: pending.tier ?? null,
    escalated: pending.escalated === true,
    waitingMs: Number.isFinite(Number(pending.waitingMs)) ? Number(pending.waitingMs) : 0,
    heldForUserInput: Number.isFinite(Number(pending.heldForUserInput)) ? Number(pending.heldForUserInput) : 0,
  };
  for (const { entry, kind } of targets) {
    if (done.has(entry.sessionId)) continue;
    const text = kind === 'interrupted'
      ? interruptionNotice({ batchId: pending.batchId, reasons: pending.reasons, ...tierInfo }, entry)
      : kind === 'stale-wait'
        ? staleWaitNotice({ batchId: pending.batchId, reasons: pending.reasons, staleWaitWindowMs: staleWaitWindowMs ?? undefined }, entry, { windowMs: staleWaitWindowMs ?? undefined })
        : completionNotice({ batchId: pending.batchId, reasons: pending.reasons, ...tierInfo }, {
          interruptedCount: interrupted.length,
          requesterLabel: requesterLabel(pending, entry.sessionId),
          ...tierInfo,
        });
    // `notifyImpl` 仅供夹具注入（默认 = 真投递 `notifySession`）
    const notify = typeof opts.notifyImpl === 'function' ? opts.notifyImpl : notifySession;
    const r = await notify(entry.sessionId, text, { baseUrl: opts.baseUrl, rpcImpl: opts.rpcImpl, timeoutMs: opts.notifyTimeoutMs });
    if (r.ok) { notified.push(entry.sessionId); done.add(entry.sessionId); }
    else failed.push({ sessionId: entry.sessionId, status: r.status, error: r.error ?? null });
  }
  const attempts = (pending.attempts ?? 0) + 1;
  const maxAttempts = opts.maxAttempts ?? 3;
  const gaveUp = failed.length > 0 && attempts >= maxAttempts;
  const stillPending = failed.length > 0 && !gaveUp;
  updateStateJson('butler-restart-state.json', file, (cur) => {
    const s = { ...emptyState(), ...(cur ?? {}) };
    return {
      ...s,
      // 部分失败（如被打断会话仍 agent-busy）→ 保留待补发，下次 tick 重试；超过上限才放弃
      pendingNotify: stillPending ? { ...pending, notified: [...done], attempts, lastFailed: failed } : null,
      // 【2026-10-26】自动喊话的 sid 冷却表清空时机 ②：重启执行完成 + lastBatch 落地
      //   ⇒ 清空后**下一轮等待期还会喊**（不清空则一次重启完成后 30 分钟内谁都喊不到）
      queue: s.queue ? autoDrainSidsCleared(s.queue, 'restart-completed(lastBatch)', opts.now ?? Date.now()) : s.queue,
      lastBatch: {
        batchId: pending.batchId, correlationId: pending.correlationId, createdAt: pending.createdAt,
        mode: pending.mode, reasons: pending.reasons, interrupted: pending.interrupted,
        // 【D17/2026-09-23】旁路名单（快照）留痕：复盘"这一批都通知了谁"
        staleWait: staleWait.map((e) => e.sessionId),
        guardTarget: pending.guardTarget ?? null,
        notified: [...done], failed, gaveUp, attempts, finishedAt: opts.now ?? Date.now(),
      },
      counters: { ...s.counters, notified: (s.counters?.notified ?? 0) + notified.length },
    };
  }, { schemaVersion: RESTART_STATE_SCHEMA, home, defaultValue: emptyState() });
  // 【D17 / 2026-09-23】审计增字段：`staleWaitNotified` = 本批**实际送达**的旁路会话；
  //   `staleWaitExcluded` = 候选/排除计数（谁被排除了、为什么，复盘口径）。
  //   哈希链完整性不受影响（appendAudit 对整条内容哈希）。
  const staleWaitNotified = notified.filter((id) => sideIds.has(id));
  appendAudit({
    type: 'restart-notify', correlationId: pending.correlationId, notified, failed, attempts, stillPending,
    staleWaitNotified,
    staleWaitCandidates: staleWait.length,
    staleWaitExcluded: {
      raw: staleWaitRaw.length,
      dupFiltered: staleWaitRaw.length - staleWait.length,
      ...(pending.staleWaitStats
        ? {
          windowMs: pending.staleWaitStats.windowMs,
          excludedNotified: pending.staleWaitStats.excludedNotified,
          outsideWindow: pending.staleWaitStats.outsideWindow,
          noMtime: pending.staleWaitStats.noMtime,
          noSession: pending.staleWaitStats.noSession,
          duplicate: pending.staleWaitStats.duplicate,
        }
        : {}),
    },
  }, { home });
  return { notified, failed, batchId: pending.batchId, attempts, stillPending, staleWaitNotified, probe: probeDigest(probe) };
}

// ------------------------------------------------------------------ 入口

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.error) { process.stderr.write(`${args.error}\n`); return 2; }
  const res = await tick(args);
  const line = `${res.action} ${res.reason ?? ''} (${res.durationMs}ms)`;
  if (!args.noLog && (args.verbose || res.action !== 'idle')) writeTickLog(line);
  if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else if (args.verbose || res.action !== 'idle') process.stdout.write(`[butler-restart] ${line}\n`);
  return res.action === 'error' || res.action === 'restart-failed' ? 1 : 0;
}

const isMainEntry = (() => {
  try {
    const a = realOrResolve(process.argv[1] ?? '');
    const b = realOrResolve(fileURLToPath(import.meta.url));
    return a === b;
  } catch { return false; }
})();

if (isMainEntry) {
  main().then((code) => process.exit(code)).catch((e) => {
    try { alert({ level: 'error', source: 'butler-restart', message: `入口异常：${e?.message ?? e}` }, {}); } catch { /* noop */ }
    try { writeTickLog(`error ${e?.message ?? e}`); } catch { /* noop */ }
    process.stderr.write(String(e?.stack ?? e) + '\n');
    process.exit(1);
  });
}
