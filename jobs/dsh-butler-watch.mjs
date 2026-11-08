#!/usr/bin/env node
// dsh-butler / dsh-butler-watch.mjs —— P2「会盯人」watch tick（卡 [3a]）
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §4 P2（行 477-554）
// 形态：**短命 tick**（计划任务 DSH-Butler-WatchTick 每 5 分钟，窗口隐藏），无常驻进程。
//
// 一次 tick：
//   0. 版本闸门（gateComponent）→ 不匹配跳过该组件 + 独立告警
//   1. tick 互斥锁（抢不到 = 静默退出 exit 0）
//   2. 采集快照（轻量每 tick；重量 30 分钟一次：会话健康/结构/盘余量/升级 HTTP）
//   3. 判定 17 类事件（lib/watch-events.mjs，纯函数）
//      ⚠️ 第 17 类 `repair-linger`（修复分身僵留）2026-09-21 新增（方案 §3.1 B1 案，只报警不动手）：
//         数据源 = 本文件 collectRepairState()（分身进程 + 本轮报告 mtime + 挂起锁，全只读）。
//   4. 抑制表（根因压派生）→ 策略状态机（只报变化 / 冷却 / 上限 / 免打扰 / ack）
//   5. 投递：桌宠 /whale/say + DSH 会话 + 报告文件（三通道，任一失败不影响其余）
//   6. 状态落盘（butler-watch-state.json，走 butler-store 原子写）
//
// 用法：
//   node dsh-butler-watch.mjs                 # 正常 tick（计划任务入口）
//   node dsh-butler-watch.mjs --dry-run       # 采集 + 判定，不推送不写状态
//   node dsh-butler-watch.mjs --json          # 输出结构化结果
//   node dsh-butler-watch.mjs --force-heavy   # 强制跑重量采集
//   node dsh-butler-watch.mjs --ack <token|all>          # 「知道了」（未命中 ⇒ rc 3 + 打印可 ack 清单）
//   node dsh-butler-watch.mjs --list [--json]            # 待确认清单（**只读**；口径复用 listUnacked）
//   node dsh-butler-watch.mjs --false-positive <token|id> --note "原因"
//   node dsh-butler-watch.mjs --first-line    # 输出次日开机首句（日报/开机钩子用）
//   node dsh-butler-watch.mjs --health        # 健康自检（面板/日报用）
//   node dsh-butler-watch.mjs --dry-run --json # 采集+判定但不推送不写状态（B1 演练/复核用）
//   # B1（修复分身僵留）口径覆盖 —— 只走 CLI，不新增配置键：
//   #   --repair-linger-min N   僵留阈值 T（分钟，默认 15）
//   #   --repair-state-dir DIR  分身状态目录（默认 <tmp>\dsh-guard）· --repair-report-dir DIR 报告目录（默认 <workspace>\logs）
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { dshHome, statePath, realOrResolve, newRunId } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { readJson, writeJsonAtomic, writeTextAtomic, acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../src/dsh-butler/lib/dual-write.mjs';
import { appendAudit } from '../src/dsh-butler/lib/audit.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { gateComponent } from '../src/dsh-butler/lib/version.mjs';
import { readMaintenanceWindow } from '../src/dsh-butler/lib/restart.mjs';
import { judgeAll, applySuppression, buildPreflight, REPAIR_LINGER_DEFAULT_MS, REPAIR_LINGER_EVENT_ID, EVENT_SPECS } from './lib/watch-events.mjs';
import { applyPolicy, emptyWatchState, WATCH_STATE_SCHEMA, pendingDeferred, planDeferredRecap, DEFAULT_WATCH_POLICY, ackEvents, markFalsePositive, makeAckToken, listUnacked } from './lib/watch-policy.mjs';
import { collectSnapshot } from '../src/dsh-butler/lib/watch-collect.mjs';
import { deviceName } from '../src/dsh-butler/lib/pitfall-scan.mjs';
import { deliverPush, writeReport, appendFalsePositive, buildSessionHeartbeat } from '../src/dsh-butler/lib/watch-notify.mjs';
// P9 H4（2026-09-28）：交接事件 = **只进报告段**（零 KPI 污染，见 lib/handoff-events.mjs 头部）
//   + §5.6 标记文件（butler-handoff-imported.json）落盘 + 抑制窗口（§5.6）由 collectSnapshot 带出。
import { judgeHandoffEvents, planHandoffObservation, handoffObsStatePath, HANDOFF_OBS_SCHEMA, HANDOFF_OBS_STATE_NAME } from './lib/handoff-events.mjs';
import { writeImportedMark } from '../src/dsh-butler/lib/handoff-window.mjs';
// P8 收纳（2026-10-09 · 卡「冲刺600·补C2C3」）：与交接同款的**只进报告段**通道（零 KPI 污染）。
//   背景：`grep tidy lib\watch-events.mjs` = 0 命中 ⇒ 收纳出事时 P2 侧没有任何出口；本卡按 K5b 口径
//   只注册执行/失败/跳过三类（见 lib/tidy-events.mjs 头部表），候选提示类**不注册**。
import { judgeTidyEvents, planTidyObservation, describeTidyStatus, tidyObsStatePath, TIDY_OBS_SCHEMA, TIDY_OBS_STATE_NAME } from './lib/tidy-events.mjs';
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 解释器统一优选（pwsh 7 优先，找不到才回退 5.1）：
//   360 企业版 EDR 把 `powershell.exe`(5.1) 的每次 -Command 判为「PowerShell 命令执行攻击」并弹窗，
//   本文件是**最高频来源**（watch 每 5 分钟一 tick，见 collectRepairState 的分身扫描）⇒ 走统一工具。
import { powerShellExe } from './lib/powershell-exe.mjs';
// 记忆召回命中留痕（P1·A0 · 2026-10-23）：只取**日报一行读数**（`hit 采集：N 行/天 · 坏行 M · 停跑 K 分钟`）。
//   真源 = 方案 §7.3「可见读数」；口径与采集器同一份实现（`memory-hit-collect.mjs`，只读 + 自身 fail-open），
//   这里绝不自己重算，也绝不因它失败（返回 ❔ 行，永不抛）。
import { hitStatsLine } from './memory-hit-collect.mjs';

export const VERSION = '0.1.0';
export const COMPONENT = 'butler-watch';
export const TICK_NAME = 'p2-watch';
export const TASK_NAME = 'DSH-Butler-WatchTick';
export const INTERVAL_MS = 5 * 60_000;
export const HEAVY_INTERVAL_MS = 30 * 60_000;
export const LOG_FILE = path.join(os.tmpdir(), 'dsh-butler-watch.log');
const LOG_MAX_LINES = 2000;

export function filesFor(home) {
  return {
    state: resolveStatePath('butler-watch-state.json', { home }).path,
    log: LOG_FILE,
  };
}

function logTick(line) {
  try {
    const rows = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean) : [];
    rows.push(line);
    const keep = rows.slice(-LOG_MAX_LINES);
    fs.writeFileSync(LOG_FILE, keep.join('\n') + '\n', 'utf8');
  } catch { /* 日志失败不影响 tick */ }
}

// ------------------------------------------------------------------ 修复分身事实采集（B1 · 只读）

/**
 * 分身进程扫描匹配式 —— **逐字复用** `<workspace>\repair-ctl.mjs:32` 的 `findRepairProcs()`。
 * ⚠️ 方案 R-B1-2 明写「**复用不重写**」：第 1 轮审核者实测，自己重写口径（`-match 'repair'`）
 *    会被**自身的 pwsh 命令行**骗到 ⇒ 必须限定 `node.exe` + 命令行含 `repair\.mjs`
 *    + 排除 `repair-ctl\.mjs` 与 `--check`。
 * ⚠️ 改这里必须与 `repair-ctl.mjs` 同步改（两处不一致 = 同一台机上"有没有分身"两个答案）。
 * @param {number} me 自身 pid（排除自己；与 repair-ctl 同款防线）
 */
export const REPAIR_PROC_PS = (me) => `$ps=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'repair\\.mjs' -and $_.CommandLine -notmatch 'repair-ctl\\.mjs' -and $_.CommandLine -notmatch '--check' }; foreach($p in $ps){ if($p.ProcessId -ne ${me}){ '{0}|{1}' -f $p.ProcessId,($p.CommandLine -replace '\\\\','\\\\\\\\') } }`;

/**
 * 采集「修复分身」事实（只读）：分身进程 + 本轮报告 mtime + 挂起锁 + ready/wake 基线。
 *
 * 为什么采集必须独立成函数（方案 §3.1 改动面 #3）：判定层（`lib/watch-events.mjs`）是**纯函数、零 IO**，
 *   所以"有没有分身 / 报告何时落盘 / 有没有挂锁"这三类文件事实必须在外围算好注入 ——
 *   判定函数只做比较，扫描与读盘全在这里（将来 B2 收尾脚本复用同一份）。
 *
 * 失败语义（**不许静默**）：进程扫描失败 ⇒ `ok:false`（判定层据此产出「不可探测」事件，**绝不当 0**）；
 *   报告目录读不到 ⇒ `reportError` + `reportMtimeMs:null`（判定层按"本轮未落盘"处理，不报）；
 *   锁文件读不动（非 ENOENT）⇒ `hold.exists:true, expiresAtMs:null`（判定层保守当"有效锁"，宁可不报）。
 *
 * @param {{procs?:Array<{pid:number|string}>, reportDir?:string, stateDir?:string,
 *          timeoutMs?:number, spawn?:Function, exe?:string}} [opts]
 *   · `procs` 注入 ⇒ 跳过真实扫描（单测 / 隔离演练；即方案 §3.1 演练要求的"替换扫描根"）
 *   · `exe` 注入 ⇒ 覆盖 PowerShell 解释器（默认 tools/lib/powershell-exe.mjs 优选 pwsh 7）
 *   · `reportDir` 缺省 = env `REPAIR_REPORT_DIR` > `<workspace>\logs`（与 repair.mjs:41 同源，不新增配置项）
 *   · `stateDir`  缺省 = `<tmp>\dsh-guard`（与 repair-ctl.mjs:18 同源）
 * @returns {{ok:boolean,count:number,pids:string[],reportFile:?string,reportMtimeMs:?number,
 *            readyAtMs:?number,wakeAtMs:?number,hold:object,stateDir:string,reportDir:string,error:?string}}
 */
export function collectRepairState(opts = {}) {
  const reportDir = opts.reportDir ?? process.env.REPAIR_REPORT_DIR ?? path.join(workspaceRoot(), 'logs');
  const stateDir = opts.stateDir ?? path.join(os.tmpdir(), 'dsh-guard');
  const out = {
    ok: true, count: 0, pids: [], reportFile: null, reportMtimeMs: null,
    readyAtMs: null, wakeAtMs: null, reportError: null,
    hold: { exists: false, expiresAtMs: null, by: null, reason: null },
    stateDir, reportDir, probe: 'cim', error: null,
  };

  // ① 分身进程（node.exe + repair.mjs；匹配式复用 repair-ctl）
  if (Array.isArray(opts.procs)) {
    out.probe = 'injected';
    const pids = opts.procs.map((p) => Number(p?.pid ?? p)).filter((n) => Number.isFinite(n) && n > 0);
    out.count = pids.length;
    out.pids = pids.map(String);
  } else {
    try {
      const spawn = opts.spawn ?? spawnSync;
      // 【2026-10-09 · 卡「360弹窗治本-pwsh7」】原为裸 `spawn('powershell.exe', …)`（= 5.1）——
      //   被 360 企业版 EDR 判为「PowerShell 命令执行攻击」每 5.5 分钟弹一次窗。
      //   改走统一工具：pwsh 7 优先（本机 7.6.6），解析不到才回退 5.1；`opts.exe` 供单测/演练注入假件。
      // 【F-B1 加韧 · 2026-10-10 · 卡 01c658b1】偶发超时不再一次判"不可探测"：CIM 查询在冷启动 /
      //   高负载下会偶发超 20 s（生产实录 `spawnSync pwsh ETIMEDOUT` ⇒ 报告里"分身进程扫描不可用"
      //   ⇒ 真僵留被静默）。改为 **超时 30 s + 失败重试 1 次**（`opts.probeAttempts` 可注入，默认 2）。
      const exe = opts.exe ?? powerShellExe();
      const attempts = Math.max(1, Number(opts.probeAttempts ?? 2) || 2);
      let r = null;
      for (let ai = 1; ai <= attempts; ai++) {
        r = spawn(exe, ['-NoProfile', '-Command', REPAIR_PROC_PS(process.pid)], {
          encoding: 'utf8', windowsHide: true, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024,
        });
        const bad = r?.error ? String(r.error?.message ?? r.error)
          : (r?.status !== 0 ? `powershell exit ${r?.status}: ${String(r?.stderr ?? '').slice(0, 200)}` : null);
        if (!bad) break;
        out.error = bad;
        if (ai < attempts) out.retried = true;   // 留痕：这次读数靠重试才拿到
      }
      if (r?.error) { out.ok = false; out.error = String(r.error?.message ?? r.error); }
      else if (r?.status !== 0) { out.ok = false; out.error = `powershell exit ${r?.status}: ${String(r?.stderr ?? '').slice(0, 200)}`; }
      else {
        const pids = [];
        for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const i = line.indexOf('|');
          const pid = Number(i >= 0 ? line.slice(0, i) : line);
          if (Number.isFinite(pid) && pid > 0) pids.push(pid);
        }
        out.count = pids.length;
        out.pids = pids.map(String);
      }
    } catch (e) { out.ok = false; out.error = e?.message ?? String(e); }
  }
  if (!out.ok) { out.count = 0; out.pids = []; }

  // ② 本轮报告 —— **只看 mtimeMs（epoch）**：文件名的时间戳是本地时间、状态字段是 UTC，
  //    解析文件名会差 8 小时 ⇒ 判据恒假（方案 §1.7.3 / 第 1 轮审核重要-2）
  try {
    const rows = fs.readdirSync(reportDir).filter((f) => /^repair-report-.*\.md$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(reportDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (rows.length) { out.reportFile = path.join(reportDir, rows[0].f); out.reportMtimeMs = Math.round(rows[0].m); }
  } catch (e) { out.reportError = e?.code === 'ENOENT' ? 'missing' : (e?.message ?? String(e)); }

  // ③ 本轮基线 max(readyAt, wakeAt)（epoch；只用于"这份报告是不是本轮的那份"）
  const readEpoch = (file, keys) => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of keys) { const t = Date.parse(j?.[k]); if (Number.isFinite(t)) return t; }
      return null;
    } catch { return null; }
  };
  out.readyAtMs = readEpoch(path.join(stateDir, 'repair-ready.json'), ['at', 'readyAt']);
  out.wakeAtMs = readEpoch(path.join(stateDir, 'repair-wake.json'), ['wokenAt', 'at']);

  // ④ 挂起锁（方案 §2.1 定稿 schema：{schemaVersion, by, reason, createdAt, expiresAt, pid}）
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, 'repair-hold.json'), 'utf8'));
    const t = Date.parse(j?.expiresAt);
    out.hold = { exists: true, expiresAtMs: Number.isFinite(t) ? t : null, by: j?.by ?? null, reason: j?.reason ?? null };
  } catch (e) {
    out.hold = e?.code === 'ENOENT'
      ? { exists: false, expiresAtMs: null, by: null, reason: null }
      : { exists: true, expiresAtMs: null, by: null, reason: null, error: e?.message ?? String(e) };
  }
  return out;
}

/** 读 watch 健康（面板 / 日报 / 开机钩子用；纯读）。 */
export function readWatchHealth(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const file = filesFor(home).state;
  let state = null;
  let error = null;
  try { state = readJson(file, { schemaVersion: WATCH_STATE_SCHEMA, home, defaultValue: null, migrateWrite: false }); } catch (e) { error = e?.message ?? String(e); }
  const lastTickAt = state?.lastTickAt ? Date.parse(state.lastTickAt) : null;
  const ageMs = lastTickAt ? now - lastTickAt : null;
  const staleAfterMs = opts.staleAfterMs ?? 15 * 60_000;
  return {
    ok: Boolean(state),
    file,
    error,
    lastTickAt,
    ageMs,
    stale: ageMs === null ? true : ageMs > staleAfterMs,
    tickCount: Number(state?.tickCount ?? 0),
    pendingDeferred: (state?.deferred ?? []).length,
    lastTick: state?.lastTick ?? null,
  };
}

/** 次日开机首句（未确认的延迟项）。 */
export function firstLine(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const state = readJson(filesFor(home).state, { schemaVersion: WATCH_STATE_SCHEMA, home, defaultValue: emptyWatchState(now), migrateWrite: false });
  const pending = pendingDeferred(state ?? emptyWatchState(now), { now });
  if (!pending.length) return { ok: true, text: null, items: [] };
  const text = `🐳 管家提醒（${pending.length} 条待处理）：\n` + pending.map((d) => `- ${d.title}：${d.detail}`).join('\n');
  return { ok: true, text, items: pending };
}

/** 跑一轮 tick。 */
export async function runTick(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const runId = newRunId('p2');
  const files = filesFor(home);

  const gate = gateComponent(COMPONENT, VERSION, { home });
  if (!gate.run) return { ok: false, skipped: 'version-gate', gate, runId };

  const lock = acquireTickLock(TICK_NAME, { ttlMs: 10 * 60_000, home });
  if (!lock.ok) return { ok: false, skipped: 'locked', reason: lock.reason, runId };

  const t0 = Date.now();
  try {
    let state = readJson(files.state, { schemaVersion: WATCH_STATE_SCHEMA, home, defaultValue: emptyWatchState(now) }) ?? emptyWatchState(now);
    const lastHeavy = Number(state.lastHeavyAt ?? 0);
    const heavy = opts.forceHeavy === true || (now - lastHeavy >= (opts.heavyIntervalMs ?? HEAVY_INTERVAL_MS));

    const snapshot = opts.snapshot ?? await collectSnapshot({
      home, now, heavy,
      baseUrl: opts.baseUrl,
      tasks: opts.tasks,
      scanFiles: state.sessionScan ?? {},
      sessionMaxFiles: opts.sessionMaxFiles,
      keyFile: opts.keyFile,
      ledgerFile: opts.ledgerFile,
      archiveFile: opts.archiveFile,
    });

    // ── B1（卡「自愈-分身僵留B1」· 2026-09-21）：注入「修复分身」事实（只读采集）
    //   优先级：显式注入 opts.repair（单测 / 隔离演练）> 快照自带 repair（夹具）> 真采集。
    //   ⚠️ 采集失败也必须**注入到快照里**（`ok:false` ⇒ 判定层产出「不可探测」）—— 绝不静默当 0。
    if (opts.repair !== undefined) {
      snapshot.repair = opts.repair;
    } else if (snapshot.repair === undefined) {
      try {
        snapshot.repair = collectRepairState({ reportDir: opts.repairReportDir, stateDir: opts.repairStateDir });
      } catch (e) {
        snapshot.repair = { ok: false, error: e?.message ?? String(e), count: 0, pids: [] };
      }
    }

    // 维护窗口（P0）：重启/迁移期间预期抖动不告警（白名单口径见 restart.mjs）
    let maintenance = null;
    try { maintenance = readMaintenanceWindow({ home }); } catch { maintenance = null; }
    const maintenanceActive = Boolean(maintenance && maintenance.active !== false && maintenance.phase && maintenance.phase !== 'done');

    const fired = judgeAll(snapshot, {
      interruptThreshold: opts.interruptThreshold,
      overdueMs: opts.overdueMs,
      contextPct: opts.contextPct,
      tunnelIdleHours: opts.tunnelIdleHours,
      guardHeartbeatMs: opts.guardHeartbeatMs,
      ungroupedThreshold: opts.ungroupedThreshold,
      repairLingerMs: opts.repairLingerMs,   // B1：僵留阈值 T（缺省 15 分钟，见 watch-events）
    });
    const { kept, suppressed } = applySuppression(fired, {
      maintenanceActive,
      diskFull: snapshot.disk?.ok === true && [snapshot.disk.cFreeGb, snapshot.disk.dFreeGb].some((v) => Number(v) < 5),
      networkDown: snapshot.network?.ok === true && snapshot.network.reachable === false,
    });

    const policy = { ...(opts.policy ?? {}) };
    const applied = applyPolicy(kept, state, { now, policy });

    // 次日开机首句：非免打扰时段把未确认的延迟项补推一次（方案「置顶次日开机首句」）
    // 【2026-10-09 · 冲刺600 补C1】这条合并提醒**纳入同一套冷却 + 日上限**：
    //   此前只在调用侧判 `!quiet`、`pendingDeferred` 又只判 `!ackedAt` ⇒ 每轮 tick 重推
    //   （实测 2026-10-09 报告 93/93 tick 节都写「已推送（deferred-recap）」、桌宠被推 64+ 次，
    //    而配额只记 daily.pushed=3）⇒ 与方案 §P2「4h 不重推 / ≤10 条/天 / 防刷屏」明文冲突。
    //   现在判据复用 lib\watch-policy.mjs 的 planDeferredRecap()：冷却窗 = policy.cooldownMs（4h），
    //   日上限 = policy.dailyCap（10，与正常告警共用同一个 daily.pushed 预算）。
    //   ⚠️ 免打扰门（!applied.quiet）与 ack/升级语义**原样保留**，只多两道门槛。
    const recapPlan = planDeferredRecap(applied.state, { now, policy: { ...DEFAULT_WATCH_POLICY, ...policy } });
    const recapItems = recapPlan.items;
    const recap = (!applied.quiet && recapItems.length)
      ? [{
        id: 'deferred-recap', title: '待处理延迟告警', level: 'red', deliverable: 'immediate',
        category: 'recap', detail: recapItems.map((d) => d.title).join('、'),
        ackToken: makeAckToken(), value: String(recapItems.length),
      }]
      : [];
    // 被日上限挡下 ⇒ **只落报告**（与 applyPolicy :171-177 的 daily-cap 同款措辞/同款去路）
    const recapCapped = (!applied.quiet && recap.length === 0 && recapPlan.capped.length)
      ? [{
        id: 'deferred-recap', title: '待处理延迟告警', level: 'red', deliverable: 'immediate',
        category: 'recap', reason: 'daily-cap',
        detail: `${recapPlan.capped.length} 条延迟项未推送：今日推送已达上限（${recapPlan.dailyPushed}/${recapPlan.dailyCap}）`,
      }]
      : [];
    const reportOnlyAll = recapCapped.length ? [...applied.reportOnly, ...recapCapped] : applied.reportOnly;

    const pushAll = [...applied.push, ...recap];
    const preflight = buildPreflight(snapshot).lines;
    const elapsedMs = Date.now() - t0;

    // ---- P9 H4 · 交接事件（**只进报告段**：`writeReport({ extra })`，永不进 EVENT_SPECS 主表 ⇒
    //      不抬高裸跑期 KPI 分母/分子，见 P2 验收档 §四「新增事件前必读 · KPI 口径铁律」）。
    //      去重键走 `~/.dsh/butler-handoff-obs.json`（butler- 前缀 ⇒ 已豁免 P5 自指审计）。
    const obsFile = handoffObsStatePath({ home });
    let handoffObs = { lines: [], picked: [], next: null, changed: false, error: null };
    try {
      const evs = judgeHandoffEvents(snapshot, { now });
      const prevObs = readJson(obsFile, { schemaVersion: HANDOFF_OBS_SCHEMA, defaultValue: null });
      handoffObs = planHandoffObservation(evs, { prev: prevObs, now });
      // §5.6 标记文件：交接刚收尾就登记一次（幂等；本卡红线不改交接器 ⇒ 由观测侧生成）
      if (!opts.dryRun) {
        try { writeImportedMark(snapshot.handoff?.record, { home, now }); } catch { /* 标记失败不阻断 tick */ }
      }
    } catch (e) {
      handoffObs = { lines: [], picked: [], next: null, changed: false, error: String(e?.message ?? e) };
    }

    // ---- P8 收纳事件（2026-10-09 · 卡「冲刺600·补C2C3」）——
    //   与交接同款：**只进报告段**（`writeReport({ extra })`），永不进 EVENT_SPECS 主表 ⇒ 零 KPI 污染。
    //   去重键走 `~/.dsh/butler-tidy-obs.json`（butler- 前缀 ⇒ 已豁免 P5 自指审计）。
    //   `tidyStatus` = **显式出口**：报告段只在有事件时才写（可能什么都不写），故"未触发"另给一条
    //   任何时候都能读到的结论行（`--dry-run --json` / `lib\tidy-events.mjs --status`）。
    const tidyObsFile = tidyObsStatePath({ home });
    let tidyObs = { lines: [], picked: [], next: null, changed: false, error: null };
    let tidyStatus = { state: 'not-wired', text: '收纳（P8）：❔ 未接线' };
    try {
      const tEvents = judgeTidyEvents(snapshot, { now });
      const prevTObs = readJson(tidyObsFile, { schemaVersion: TIDY_OBS_SCHEMA, defaultValue: null });
      tidyObs = planTidyObservation(tEvents, { prev: prevTObs, now });
      tidyStatus = describeTidyStatus(snapshot, { events: tEvents, now });
    } catch (e) {
      tidyObs = { lines: [], picked: [], next: null, changed: false, error: String(e?.message ?? e) };
      tidyStatus = { state: 'undetectable', text: `收纳（P8）：❔ 判定入口异常（${String(e?.message ?? e)}）—— 这是显式出口，不是"收纳没事"` };
    }

    // ---- 记忆召回命中留痕（P1·A0 · 2026-10-23）——
    //   与交接/收纳同款：**只进报告段**（`writeReport({ extra })`），永不进 EVENT_SPECS 主表 ⇒ 零 KPI 污染。
    //   读数口径唯一真源 = 方案 §7.3「可见读数」`hit 采集：N 行/天 · 坏行 M · 停跑 K 分钟`；
    //   口径实现只有采集器一份（这里不重算）。`hitStatsLine` 自身 fail-open（读不到就打印 ❔ 行），
    //   ⇒ 日报**永不**因它失败（日志/目录不在也只多一行，不红）。
    let hitLine = null;
    try { hitLine = hitStatsLine({ home, now }); } catch { hitLine = null; }

    if (opts.dryRun) {
      return {
        ok: true, runId, dryRun: true, heavy, device: snapshot.device, elapsedMs,
        fired: fired.map((e) => e.id), kept: kept.map((e) => e.id),
        suppressed: suppressed.map((x) => ({ id: x.event.id, by: x.by })),
        push: pushAll.map((e) => ({ id: e.id, level: e.level, detail: e.detail, ackToken: e.ackToken ?? null })),
        reportOnly: reportOnlyAll.map((e) => e.id),
        recap: { reason: recapPlan.reason, items: recapItems.length, cooling: recapPlan.cooling.length, capped: recapPlan.capped.length, dailyPushed: recapPlan.dailyPushed, cooldownMs: recapPlan.cooldownMs, dailyCap: recapPlan.dailyCap },
        deferred: applied.deferred.map((e) => e.id),
        escalated: applied.escalated.map((e) => e.id),
        cooling: applied.cooling.map((x) => x.id),
        skipped: applied.skipped.map((x) => x.id),
        preflight,
        // B1：把采集事实与判定结果一并吐出来（`--dry-run --json` 复核用；只读、无副作用）
        repair: snapshot.repair ?? null,
        repairEvent: fired.find((e) => e.id === REPAIR_LINGER_EVENT_ID) ?? null,
        // H4：交接面（`--dry-run --json` 可核；handoffExtra = 真要写进报告段的内容）
        handoff: snapshot.handoff ?? null,
        handoffEvents: handoffObs.picked?.map((e) => ({ id: e.id, level: e.level, detail: e.detail })) ?? [],
        handoffExtra: handoffObs.lines ?? [],
        handoffError: handoffObs.error ?? null,
        // P8 收纳面（同款：采集事实 + 判定结果 + 显式出口，`--dry-run --json` 可核；只读、无副作用）
        tidy: snapshot.tidy ?? null,
        tidyStatus,
        tidyEvents: tidyObs.picked?.map((e) => ({ id: e.id, level: e.level, detail: e.detail })) ?? [],
        tidyExtra: tidyObs.lines ?? [],
        tidyError: tidyObs.error ?? null,
        // 记忆 hit 采集读数行（`--dry-run --json` 可核；真跑时进报告段 extra）
        hitLine,
      };
    }

    const deliver = opts.noPush === true
      ? { whale: { ok: false, skipped: true }, session: { ok: false, skipped: true } }
      : await deliverPush(pushAll, { home, now, baseUrl: opts.baseUrl });

    // 【2026-10-10 · 冲刺600·补可观测 B3】出口四段式闸可能降级若干条（文案缺段 ⇒ 只进报告、不推）：
    //   报告 / 台账 / 状态 / 返回体**一律用"实际推出去的那批"**，否则会出现
    //   "报告说推了 N 条、实际只推 M 条"的显示偏差；降级项改走 reportOnly，可见性不丢（只是不打扰）。
    const pushDelivered = deliver.pushAllEffective ?? pushAll;
    const reportOnlyDelivered = deliver.downgraded?.length
      ? [...reportOnlyAll, ...deliver.downgraded]
      : reportOnlyAll;

    const report = writeReport({
      now, docsRoot: opts.docsRoot, tick: applied.state.tickCount, device: snapshot.device,
      push: pushDelivered, reportOnly: reportOnlyDelivered, deferred: applied.deferred,
      escalated: applied.escalated, suppressed, cooling: applied.cooling, skipped: applied.skipped,
      preflight,
      extra: [...handoffObs.lines, ...tidyObs.lines, ...(hitLine ? [hitLine] : [])],   // H4 · 🤝 交接段 + P8 · 🧹 收纳段 + 🧠 hit 采集读数（报告段，零 KPI 污染）
    });

    // 交接观测运行键（只在真有播报时落盘；同一轮交接不重复报）
    if (handoffObs.next && handoffObs.changed) {
      try { const dw = writeStateText(HANDOFF_OBS_STATE_NAME, JSON.stringify({ schemaVersion: HANDOFF_OBS_SCHEMA, ...handoffObs.next, updatedAt: now }, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) }); if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown')); }
      catch { /* 运行键写失败只影响去重，不影响 tick */ }
    }
    // P8 收纳观测运行键（同上：只在真有播报时落盘）
    if (tidyObs.next && tidyObs.changed) {
      try { const dw = writeStateText(TIDY_OBS_STATE_NAME, JSON.stringify({ schemaVersion: TIDY_OBS_SCHEMA, ...tidyObs.next, updatedAt: now }, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) }); if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown')); }
      catch { /* 运行键写失败只影响去重，不影响 tick */ }
    }

    // 状态落盘（延迟项补推后标记 deliveredAt）
    // 【2026-10-09 · 补C1】只给**本轮真推到**的那几条打 deliveredAt（此前是"整队列一律打"，
    //   而 deliveredAt 又没人读 ⇒ 等于白写）。这份时间戳就是下一轮的冷却锚。
    //   同时把合并提醒**计入当天额度**（此前完全不计数 ⇒ 日报「今日 3/10」与桌宠被推次数对不上）。
    const nextState = { ...applied.state };
    nextState.daily = { ...(nextState.daily ?? { pushed: 0, reportOnly: 0, items: [] }) };
    if (recap.length) {
      const touched = new Set(recapItems.map((d) => `${d.id}@${d.at}`));
      nextState.deferred = (nextState.deferred ?? []).map((d) => (touched.has(`${d.id}@${d.at}`) ? { ...d, deliveredAt: now } : d));
      nextState.daily.pushed = Number(nextState.daily.pushed ?? 0) + 1;
      // 【2026-11-06 · 告警 ack 链自锁修复】这条重投记录必须自己声明「我覆盖了哪几条 deferred」：
      //   `covers` = **add-only 新字段**（老字段一字不改；`daily.items` 仍 append-only，**绝不回写老记录**）。
      //   没有它，ack 这个 token 时 policy 侧不知道要清哪几条 ⇒ 告警文案给的 token 永远 ack 不动（4h 一闭环）。
      const recapCovers = [...new Set(recapItems.map((d) => String(d?.id ?? '')).filter(Boolean))];
      nextState.daily.items = [...(nextState.daily.items ?? []), { id: 'deferred-recap', at: now, level: 'red', kind: 'push', ackToken: recap[0].ackToken, covers: recapCovers }];
    } else if (recapCapped.length) {
      nextState.daily.reportOnly = Number(nextState.daily.reportOnly ?? 0) + 1;
      nextState.daily.items = [...(nextState.daily.items ?? []), { id: 'deferred-recap', at: now, level: 'red', kind: 'report' }];
    }
    if (heavy) {
      nextState.lastHeavyAt = now;
      if (snapshot.sessionHealth?.ok && snapshot.sessionHealth.scanUpdates) {
        nextState.sessionScan = { ...(nextState.sessionScan ?? {}), ...snapshot.sessionHealth.scanUpdates };
      }
    }
    // 【2026-10-21 · V3 功能面 C2「会话通道心跳目标」】把「最近活跃会话 id + 活动时间」写进本状态文件
    //   （**已登记状态文件，零新增**）⇒ `lib\watch-notify.mjs#resolveNotifySession()` 在
    //   `<DSH>\logs\guard-session.id` 陈旧时读它兜底（那条文件只在"从会话内触发重启"时写一次，
    //   dsh 长跑 15 分钟后就判死 ⇒ 会话通道结构性不可达）。
    //   ⚠️ `at` 用**会话文件 mtime**（真实活动时间），不是 now —— 写 now 等于心跳永不陈旧、偷偷放宽 TTL。
    //   ⚠️ 判不出（无活跃会话 / 快照没有 latestActive）⇒ 保留上一轮心跳，由 15 分钟窗自然判死。
    const heartbeat = buildSessionHeartbeat(snapshot.sessions, { now });
    if (heartbeat) nextState.sessionHeartbeat = heartbeat;
    const hbView = nextState.sessionHeartbeat
      ? {
        sessionId: nextState.sessionHeartbeat.sessionId ?? null,
        at: nextState.sessionHeartbeat.at ?? null,
        ageMs: Number.isFinite(Number(nextState.sessionHeartbeat.at)) ? now - Number(nextState.sessionHeartbeat.at) : null,
        wroteThisTick: Boolean(heartbeat),
      }
      : null;
    nextState.lastResult = {
      runId, at: new Date(now).toISOString(), heavy, elapsedMs,
      fired: fired.length, kept: kept.length, pushed: pushDelivered.length, reportOnly: reportOnlyDelivered.length,
      deferred: applied.deferred.length, suppressed: suppressed.length,
      recap: { reason: recapPlan.reason, items: recapItems.length, cooling: recapPlan.cooling.length, capped: recapPlan.capped.length },
      // 【2026-10-21 · C 段】`whaleEnabled/whaleReason` = 通道**开关状态**（与"发没发成功"分开记）：
      //   桌宠默认关 ⇒ whale=false 不再等于"失败"，读状态时别把两者混成一条。
      channels: {
        whale: deliver.whale?.ok ?? false,
        whaleEnabled: deliver.channel?.whale?.enabled === true,
        whaleReason: deliver.whale?.reason ?? deliver.channel?.whale?.reason ?? null,
        // 【2026-10-21 · C 补】外部通道（第四路 · hub 长连接）：`external=false` 且 `externalEnabled=true`
        //   才叫"发失败"；`externalEnabled=false` = 默认关（设计如此）。`externalStage` 记失败在哪一段
        //   （hub-token / hub-connect / send），事后一眼能定位是"没配好"还是"通道不通"。
        external: deliver.external?.ok ?? false,
        externalEnabled: deliver.channel?.external?.enabled === true,
        externalReason: deliver.external?.reason ?? deliver.channel?.external?.reason ?? null,
        externalStage: deliver.external?.stage ?? null,
        externalError: deliver.external?.ok === false && deliver.external?.skipped !== true ? String(deliver.external?.error ?? '').slice(0, 200) : null,
        session: deliver.session?.ok ?? false,
        // C2：`sessionTarget` = 这轮命中哪条判据（file / heartbeat / env / none），`targetReason` = 判不出来时为什么。
        //   有了它，事后能直接看"这条会话通道是被心跳兜底救回来的"还是"guard-session.id 本来就新鲜"。
        sessionTarget: deliver.session?.target ?? null,
        sessionTargetReason: deliver.session?.targetReason ?? null,
        // C2：心跳现状（`wroteThisTick=false` = 本轮没新活动，沿用上一轮；`ageMs` 超 15 分钟即判死）
        sessionHeartbeat: hbView,
        report: report.written === true,
      },
    };
    const dw = writeStateText('butler-watch-state.json', JSON.stringify(nextState, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));

    appendAudit({
      type: 'p2-watch', runId, device: snapshot.device, heavy, elapsedMs,
      fired: fired.map((e) => e.id), pushed: pushDelivered.map((e) => e.id),
      reportOnly: reportOnlyDelivered.map((e) => e.id), deferred: applied.deferred.map((e) => e.id),
      suppressed: suppressed.map((x) => ({ id: x.event.id, by: x.by })),
      channels: nextState.lastResult.channels,
      // B3：四段式闸的读数（降了几条 / 短告警几条）—— 审计里可回溯，别只看 pushed 少了几条
      templateGate: deliver.templateGate ?? null,
      downgraded: deliver.downgraded?.map((x) => ({ id: x.id, missing: x.missing })) ?? [],
    }, { home, silent: true });

    // 【2026-10-21 · C 段】"推不出去"的判据要分清**通道关**与**通道失败**：
    //   桌宠默认关（判据"桌宠不再背告警"）⇒ whale=false 是设计如此，不是故障；
    //   真正要报警的是「会话通道也失败」——那时才等于"这轮真没喊到人"（报告/日志仍兜底）。
    if (pushDelivered.length && !(deliver.session?.ok)) {
      const whaleOn = deliver.channel?.whale?.enabled === true;
      const whaleWhy = whaleOn
        ? `桌宠 ${deliver.whale?.ok ? 'ok' : (deliver.whale?.error ?? '-')}`
        : '桌宠通道已关（默认 · C 段判据）';
      // 【2026-10-21 · C 补】外部通道这条通 = 人已经在手机上收到了 ⇒ **不再报"没喊到人"**（判据 6 的目的已达成）；
      //   只有"会话失败 且 外部通道也没成"才是真故障。外部通道关着（默认）时行为与 C 段逐字一致。
      const externalOn = deliver.channel?.external?.enabled === true;
      const externalOk = deliver.external?.ok === true;
      const externalWhy = externalOn
        ? `外部通道 ${externalOk ? 'ok' : `${deliver.external?.stage ?? '?'}:${String(deliver.external?.error ?? '-').slice(0, 80)}`}`
        : '外部通道未注入（本包不含具体通道实现）';
      if (!externalOk) {
        alert({
          level: 'warn', source: 'butler-watch',
          message: `会话通道投递失败（${deliver.session?.error ?? '-'}${deliver.session?.targetReason ? ` / ${deliver.session.targetReason}` : ''}）· ${whaleWhy} · ${externalWhy} · 已落报告兜底（${path.basename(String(report.file ?? ''))}）`,
          detail: { report: report.file, session: deliver.session ?? null, whale: deliver.whale ?? null, whaleEnabled: whaleOn, external: deliver.external ?? null, externalEnabled: externalOn },
        }, { home, silent: true });
      }
    }

    const line = `[${new Date(now).toISOString()}] tick #${nextState.tickCount} device=${snapshot.device} heavy=${heavy} fired=${fired.length} kept=${kept.length} pushed=${pushDelivered.length} report=${reportOnlyDelivered.length} deferred=${applied.deferred.length} suppressed=${suppressed.length} recap=${recapPlan.reason} elapsed=${elapsedMs}ms`;
    logTick(line);

    return {
      ok: true, runId, device: snapshot.device, heavy, elapsedMs,
      tick: nextState.tickCount,
      fired: fired.map((e) => e.id),
      kept: kept.map((e) => e.id),
      suppressed: suppressed.map((x) => ({ id: x.event.id, by: x.by })),
      push: pushDelivered.map((e) => ({ id: e.id, level: e.level, detail: e.detail, ackToken: e.ackToken ?? null })),
      reportOnly: reportOnlyDelivered.map((e) => e.id),
      deferred: applied.deferred.map((e) => e.id),
      escalated: applied.escalated.map((e) => e.id),
      cooling: applied.cooling.map((x) => x.id),
      skipped: applied.skipped.map((x) => x.id),
      recap: { reason: recapPlan.reason, items: recapItems.length, cooling: recapPlan.cooling.length, capped: recapPlan.capped.length, dailyPushed: recapPlan.dailyPushed, dailyCap: recapPlan.dailyCap, cooldownMs: recapPlan.cooldownMs },
      channels: nextState.lastResult.channels,
      report: report.file,
      log: line,
      preflight,
      repair: snapshot.repair ?? null,
      repairEvent: fired.find((e) => e.id === REPAIR_LINGER_EVENT_ID) ?? null,
    };
  } finally {
    lock.release();
  }
}

/**
 * 「知道了」。
 *
 * 【2026-11-06 · 告警 ack 链自锁修复】未命中 ⇒ **不写盘** + 返回 `ok:false`（CLI 据此 rc 3）。
 *   此前 `--ack zzzzzz` = rc 0 + 「ack 0 个事件」，把上一棒骗成「没有 ack CLI」——
 *   静默成功比报错贵得多。判据复用 `ackEvents(...).matched`（含 recap covers 命中）。
 */
export function ack(tokenOrId, opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const files = filesFor(home);
  const base = readJson(files.state, { schemaVersion: WATCH_STATE_SCHEMA, home, defaultValue: emptyWatchState(now) }) ?? emptyWatchState(now);
  const res = ackEvents(base, tokenOrId, { now });
  if (!res.matched) {
    // 未命中：一个字节都不写（状态件 sha 必须与调用前一致），审计也不落（避免刷噪音）
    return { ok: false, matched: false, reason: res.reason ?? 'no-match', acked: [], deferredCleared: 0, file: files.state, input: String(tokenOrId ?? '') };
  }
  const dw = writeStateText('butler-watch-state.json', JSON.stringify(res.state, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  appendAudit({ type: 'p2-ack', token: String(tokenOrId), acked: res.acked, deferredCleared: res.deferredCleared, recapMatched: res.recapMatched }, { home, silent: true });
  return { ok: true, matched: true, acked: res.acked, deferredCleared: res.deferredCleared, file: files.state };
}

/**
 * 待确认清单（`--list`）：**只读、不写盘**。
 * 口径**只此一份**：复用 `lib/watch-policy.mjs#listUnacked`（面板也调它），这里绝不另写统计。
 * `eventTitles` / `eventLevels` 取自 `EVENT_SPECS`，只用于老记录缺 title/level 时的中文兜底。
 */
export function listAckables(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const file = filesFor(home).state;
  let state = null;
  try {
    state = readJson(file, { schemaVersion: WATCH_STATE_SCHEMA, home, defaultValue: emptyWatchState(now), migrateWrite: false });
  } catch (e) {
    return { ok: false, file, now, error: e?.message ?? String(e), count: 0, items: [], oldestAt: null, deduped: 0 };
  }
  const eventTitles = {};
  const eventLevels = {};
  for (const spec of EVENT_SPECS ?? []) {
    if (!spec?.id) continue;
    eventTitles[spec.id] = spec.title;
    eventLevels[spec.id] = spec.level;
  }
  const list = listUnacked(state ?? emptyWatchState(now), { now, eventTitles, eventLevels });
  return { ok: true, file, now, ...list };
}

/** 未确认时长（人读）。`--list` 与 `--ack` 未命中报错共用同一格式化。 */
function fmtUnacked(ms) {
  const m = Math.max(0, Number(ms) || 0);
  if (m >= 86_400_000) return `${(m / 86_400_000).toFixed(1)}d`;
  if (m >= 3_600_000) return `${(m / 3_600_000).toFixed(1)}h`;
  return `${Math.max(1, Math.round(m / 60_000))}m`;
}

/** 人读清单行（id / 级别 / 标题 / token / 未确认时长 / 来源 / 升级次数）—— 两个出口共用。 */
function ackListLines(list) {
  const icons = { red: '🔴', yellow: '🟡' };
  return (list?.items ?? []).map((it, i) => `  ${i + 1}. ${it.id}  ${icons[it.level] ?? '·'} ${it.title || it.id}`
    + `  token=${it.ackToken ?? '-'}  未确认 ${fmtUnacked(it.unackedMs)}`
    + `  来源=${it.source}  升级 ${Number(it.escalations ?? 0)}`);
}

/** 标误报。 */
export function falsePositive(tokenOrId, opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const files = filesFor(home);
  const base = readJson(files.state, { schemaVersion: WATCH_STATE_SCHEMA, home, defaultValue: emptyWatchState(now) }) ?? emptyWatchState(now);
  const res = markFalsePositive(base, tokenOrId, { now, note: opts.note, device: deviceName(), source: opts.source ?? 'cli' });
  const dw = writeStateText('butler-watch-state.json', JSON.stringify(res.state, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  const append = appendFalsePositive(res.record, { home });
  return { ok: append.ok, matched: res.matched, record: res.record, file: append.file };
}

// ------------------------------------------------------------------ CLI
const isMain = (() => {
  const a = process.argv[1] ? realOrResolve(process.argv[1]) : '';
  const b = realOrResolve(fileURLToPath(import.meta.url));
  return Boolean(a) && a === b;
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const asJson = has('--json');
  const home = valOf('--home');
  const now = valOf('--now') ? Number(valOf('--now')) : undefined;

  if (has('--ack')) {
    const input = valOf('--ack');
    const r = ack(input, { home, now });
    if (asJson) {
      console.log(JSON.stringify(r, null, 2));
    } else if (!r.ok) {
      // 🔴 未命中必须"叫出来"：rc 3 + stderr 说清 + 列清单。
      //    此前这里 rc 0 + 「ack 0 个事件」⇒ 照做了也看不出来，上一棒就是这么被误导的。
      const list = listAckables({ home, now });
      const why = r.reason === 'recap-no-covers'
        ? '它是一条**缺少 covers 清单的存量重投记录**（2026-11-06 之前写下的 deferred-recap）：本工具不猜它清了哪几条。'
        : '它既不是事件 id、也不是 events / deferred 里的 ackToken。';
      console.error(`[p2] 没有匹配的待确认项：${String(input ?? '')}`);
      console.error(`[p2] ${why}`);
      console.error(`[p2] 当前可 ack 的清单（共 ${list.count} 件 · 状态文件 ${list.file}）：`);
      if (list.count) for (const line of ackListLines(list)) console.error(line);
      else console.error('  （没有待确认项 —— 可能已经清干净了）');
      console.error('[p2] 用法：--ack <id|token> 确认单条；--ack all 全部确认；--list 只读清单。');
    } else {
      console.log(`[p2] ack ${r.acked.length} 个事件（清理延迟项 ${r.deferredCleared}）`);
    }
    process.exit(r.ok ? 0 : 3);
  }
  if (has('--list')) {
    const list = listAckables({ home, now });
    if (asJson) {
      console.log(JSON.stringify(list, null, 2));
    } else if (list.ok === false) {
      console.error(`[p2] 读不到状态文件：${list.error}`);
    } else {
      console.log(`[p2] 待确认清单（${list.count} 件 · 只读） · ${list.file}`);
      if (list.count) for (const line of ackListLines(list)) console.log(line);
      else console.log('  （没有需要 ack 的告警）');
      console.log('[p2] 怎么 ack：node dsh-butler-watch.mjs --ack <id|token>（或 --ack all 全确认）');
    }
    process.exit(list.ok === false ? 3 : 0);
  }
  if (has('--false-positive')) {
    const r = falsePositive(valOf('--false-positive'), { home, now, note: valOf('--note') });
    console.log(asJson ? JSON.stringify(r, null, 2) : `[p2] 误报已记录（匹配=${r.matched}）→ ${r.file}`);
    process.exit(0);
  }
  if (has('--first-line')) {
    const r = firstLine({ home, now });
    console.log(asJson ? JSON.stringify(r, null, 2) : (r.text ?? '(无待处理延迟项)'));
    process.exit(0);
  }
  if (has('--health')) {
    const r = readWatchHealth({ home, now });
    console.log(asJson ? JSON.stringify(r, null, 2) : `[p2] lastTick=${r.lastTickAt ? new Date(r.lastTickAt).toISOString() : 'never'} age=${r.ageMs === null ? '?' : Math.round(r.ageMs / 1000) + 's'} stale=${r.stale} ticks=${r.tickCount} 待处理=${r.pendingDeferred}`);
    process.exit(0);
  }

  const r = await runTick({
    home, now,
    dryRun: has('--dry-run'),
    forceHeavy: has('--force-heavy'),
    noPush: has('--no-push'),
    baseUrl: valOf('--dsh-url'),
    docsRoot: valOf('--docs-root'),
    interruptThreshold: valOf('--interrupt-threshold') ? Number(valOf('--interrupt-threshold')) : undefined,
    // B1（修复分身僵留）：口径覆盖**只走 CLI**（不新增任何配置键）—— 方案 §3.1 隔离演练要能替换扫描根/阈值
    repairLingerMs: valOf('--repair-linger-min') !== undefined ? Number(valOf('--repair-linger-min')) * 60_000 : undefined,
    repairStateDir: valOf('--repair-state-dir'),
    repairReportDir: valOf('--repair-report-dir'),
  });

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else if (r.ok === false) {
    console.log(`[p2] skipped: ${r.skipped}${r.reason ? ` (${r.reason})` : ''}`);
  } else if (r.dryRun) {
    console.log(`[p2] dry-run heavy=${r.heavy} elapsed=${r.elapsedMs}ms fired=${r.fired.length} kept=${r.kept.length}`);
    console.log(`[p2] would-push: ${r.push.map((x) => `${x.id}(${x.level})`).join(', ') || '(none)'}`);
    console.log(`[p2] report-only: ${r.reportOnly.join(', ') || '(none)'} | deferred: ${r.deferred.join(', ') || '(none)'} | cooling: ${r.cooling.join(', ') || '(none)'} | suppressed: ${r.suppressed.map((x) => `${x.id}<-${x.by}`).join(', ') || '(none)'}`);
    // B1：分身事实 + 该事件判定（人读一份；`--json` 是机器读的一份）
    if (r.repair) {
      const hold = r.repair.hold ?? {};
      console.log(`[p2] repair: 分身 ${r.repair.count} 个${r.repair.ok ? '' : '（**不可探测**）'} · 本轮报告 ${r.repair.reportMtimeMs ? new Date(r.repair.reportMtimeMs).toISOString() : '未落盘'} · 挂起锁 ${hold.exists ? (hold.expiresAtMs ? '生效中' : '存在（无 TTL）') : '无'} · 阈值 T=${Math.round(REPAIR_LINGER_DEFAULT_MS / 60_000)} 分钟`);
      console.log(`[p2] repair-linger: ${r.repairEvent ? `${r.repairEvent.level} ${r.repairEvent.detail}` : '未命中（无僵留 / 报告未落盘 / 未满 T / 挂锁生效中 / 不可探测且未报）'}`);
    }
  } else {
    console.log(r.log);
    if (r.push.length) console.log(`[p2] pushed: ${r.push.map((x) => `${x.id}(${x.ackToken ?? '-'})`).join(', ')} → whale=${r.channels.whale}${r.channels.whaleEnabled === false ? '(off:默认关)' : ''} external=${r.channels.external}${r.channels.externalEnabled === false ? '(off:默认关)' : (r.channels.external ? '' : `(${r.channels.externalStage ?? '?'})`)} session=${r.channels.session} report=${r.channels.report}`);
    if (r.reportOnly.length) console.log(`[p2] report-only: ${r.reportOnly.join(', ')}`);
    if (r.deferred.length) console.log(`[p2] deferred: ${r.deferred.join(', ')}`);
    if (r.suppressed.length) console.log(`[p2] suppressed: ${r.suppressed.map((x) => `${x.id}<-${x.by}`).join(', ')}`);
  }
  // ⚠️ 收尾一律 process.exitCode（自然退出），**禁 process.exit()**：本路径发过 fetch（undici），
  //   强退会概率性触发 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`、退出码 0xC0000409
  //   （tickd 侧表现为 watch job 反复 "exit-3221226505" 假失败）。同仓先例：butler-queue-tick.mjs / butler-auto-cli.mjs。
  //   注：上面的子命令分支（--ack / --false-positive / --first-line / --health）只读写本地文件、不发网络，
  //   保留 process.exit(0) 是安全的。
  process.exitCode = r.ok === false && r.skipped !== 'locked' ? 1 : 0;
}
