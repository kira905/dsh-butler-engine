#!/usr/bin/env node
// dsh-butler / butler-card-watchdog-tick.mjs —— 看板卡「假结算 / 假 running」常驻巡检入口（tickd job `card-watchdog`）
//
// 定位：外部打断（DSH 重启 / abort）会让卡状态撒谎 —— `review` 但执行会话还在跑（假结算）、
//   `running` 但执行会话早死了（假 running / 僵尸卡，且**无法自愈**：rerun 报 already running、move 被拒）。
//   本 tick 全量巡检这两类，**只巡检 + 通知，绝不自动改卡状态**，取代"人肉盯卡"。
//   判定真源 = `lib/queue-watch.mjs` 的 `isExecutionAlive`（与 queue tick 同源，不复制逻辑）。
//
// 三档（**默认 observe** = 零对外副作用；升档只能显式动作：`--mode` 或配置文件。
//        可选 `followQueue:true` 让档位跟随 `~/.dsh/butler-queue.json`）：
//   observe → 只写台账 + 日志（零对外副作用）
//   report  → 日报段（`## 🐕 盯卡巡检`）+ 桌宠
//   notify  → 走既有 queue 目标降级链（卡级绑定 → 主线 owner → 标题【运行】唯一）注入会话
//
// 用法：
//   node butler-card-watchdog-tick.mjs                    跑一轮（tickd 默认入口）
//   node butler-card-watchdog-tick.mjs --dry-run          只判定，不落盘不通知（零副作用）
//   node butler-card-watchdog-tick.mjs --json             机器可读输出
//   node butler-card-watchdog-tick.mjs --status           台账总览（在册异常 / 投递过谁）
//   node butler-card-watchdog-tick.mjs --mode report      设置档位并立即按新档跑一轮
//   node butler-card-watchdog-tick.mjs --set-only --mode observe   只改档位不跑
//   node butler-card-watchdog-tick.mjs --board-file b.json --sessions-file s.json --home <隔离> --docs-root <隔离>
//                                                         隔离演练（不碰生产账本 / 不碰生产日报）
// 其它：--home <dir> / --base-url <url>（默认 http://localhost:3080）/ --no-daily
//      / --grace-min <n>（假 running 宽限）/ --no-exec-grace-min <n>（无 execution 记录宽限）
//      / --kinds fake-settled,fake-running（只巡某一类）
// 退出码：0 正常（含"抢不到 tick 锁"静默退出）/ 1 失败 / 2 用法错误
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { alert as sendAlert } from '../src/dsh-butler/lib/alert.mjs';
import { bindingsPath, loadBindings, describeBindings } from '../src/dsh-butler/lib/queue-bindings.mjs';
import {
  CARD_WATCHDOG_VERSION, LOCK_NAME, MODES, LEDGER_DEFAULT,
  loadConfig, loadLedger, setMode, runTick, summarize, logLine, logFile, ledgerPath,
} from './lib/card-watchdog.mjs';

const USAGE = `usage: node butler-card-watchdog-tick.mjs [--dry-run] [--json] [--status] [--mode <${MODES.join('|')}>]
       [--allow-skip-stage] [--set-only] [--no-daily] [--home <dir>] [--base-url <url>]
       [--grace-min <n>] [--no-exec-grace-min <n>] [--kinds <fake-settled,fake-running>]
       [--board-file <json>] [--sessions-file <json>] [--docs-root <dir>]`;

function parse(argv) {
  const o = {
    dryRun: false, json: false, status: false, mode: null, allowSkipStage: false, setOnly: false,
    noDaily: false, home: null, baseUrl: null, graceMin: null, noExecGraceMin: null, kinds: null,
    boardFile: null, sessionsFile: null, docsRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--status') o.status = true;
    else if (a === '--mode') o.mode = argv[++i] ?? '';
    else if (a === '--allow-skip-stage') o.allowSkipStage = true;
    else if (a === '--set-only') o.setOnly = true;
    else if (a === '--no-daily') o.noDaily = true;
    else if (a === '--home') o.home = argv[++i] ?? null;
    else if (a === '--base-url') o.baseUrl = argv[++i] ?? null;
    else if (a === '--grace-min') o.graceMin = Number(argv[++i]);
    else if (a === '--no-exec-grace-min') o.noExecGraceMin = Number(argv[++i]);
    else if (a === '--kinds') o.kinds = String(argv[++i] ?? '');
    else if (a === '--board-file') o.boardFile = argv[++i] ?? null;
    else if (a === '--sessions-file') o.sessionsFile = argv[++i] ?? null;
    else if (a === '--docs-root') o.docsRoot = argv[++i] ?? null;
    else if (a === '-h' || a === '--help') return { help: true };
    else return { error: `unknown arg: ${a}` };
  }
  return o;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (args.error) { process.stderr.write(args.error + '\n' + USAGE + '\n'); return 2; }
  if (args.mode && !MODES.includes(args.mode)) { process.stderr.write(`--mode 必须是 ${MODES.join('|')}\n`); return 2; }
  if (args.graceMin !== null && !(Number.isFinite(args.graceMin) && args.graceMin >= 0)) { process.stderr.write('--grace-min 必须是非负数（分钟）\n'); return 2; }
  if (args.noExecGraceMin !== null && !(Number.isFinite(args.noExecGraceMin) && args.noExecGraceMin >= 0)) { process.stderr.write('--no-exec-grace-min 必须是非负数（分钟）\n'); return 2; }

  const home = args.home ? args.home : dshHome();

  // ---- 档位设置（写独立配置文件；缺省 = 跟随 queue）
  if (args.mode) {
    const r = setMode(args.mode, { home, allowSkipStage: args.allowSkipStage, actor: process.env.DSH_SESSION_ID ?? 'cli' });
    if (!r.ok) { process.stderr.write(`✘ ${r.error}\n`); return 2; }
    process.stdout.write(`✔ 档位：${r.previous} → ${r.mode}（${r.file}）\n`);
    logLine(`档位变更 ${r.previous} → ${r.mode}`, {});
    if (args.setOnly) return 0;
  }

  // ---- 只读总览
  if (args.status) {
    const ledger = loadLedger({ home });
    const cfg = loadConfig({ home });
    const sum = summarize(ledger, { now: Date.now() });
    const bindings = loadBindings({ home });
    const rows = describeBindings(bindings, { now: Date.now() });
    const payload = {
      ok: true, component: 'card-watchdog', version: CARD_WATCHDOG_VERSION,
      mode: cfg.mode, modeSource: cfg.modeSource ?? null,
      home, ledgerFile: ledgerPath(home), logFile: logFile(), bindingsFile: bindingsPath(home),
      bindings: { exists: bindings.exists, corrupt: bindings.corrupt, cards: Object.keys(bindings.cards ?? {}).length, lines: Object.keys(bindings.lines ?? {}).length, rows: rows.slice(0, 10) },
      entries: sum.entries, kindCounts: sum.kindCounts, rows: sum.rows, stats: sum.stats, day: sum.day,
      tickd: await tickdStatus(),
    };
    if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else printStatus(payload);
    return 0;
  }

  // ---- tick（单例锁：抢不到静默退出，不排队不重试）
  const lock = acquireTickLock(LOCK_NAME, { ttlMs: 120_000, home });
  if (!lock.ok) { process.stdout.write(`[card-watchdog] 上一轮还在跑（${lock.reason}）→ 本轮跳过\n`); return 0; }

  let exitCode = 0;
  try {
    const cfgOverride = {};
    if (args.graceMin !== null) cfgOverride.graceMs = args.graceMin * 60_000;
    if (args.noExecGraceMin !== null) cfgOverride.noExecGraceMs = args.noExecGraceMin * 60_000;
    if (args.kinds) {
      const want = args.kinds.split(',').map((s) => s.trim()).filter(Boolean);
      cfgOverride.kinds = { 'fake-settled': want.includes('fake-settled'), 'fake-running': want.includes('fake-running') };
    }
    const r = await runTick({
      home, baseUrl: args.baseUrl ?? undefined, dryRun: args.dryRun, cfgOverride, mode: args.mode ?? undefined,
      boardFile: args.boardFile, sessionsFile: args.sessionsFile, docsRoot: args.docsRoot,
      noDaily: args.noDaily,
    });
    if (args.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else printTick(r);

    if (!r.ok) {
      exitCode = r.action === 'collect-failed' ? 0 : 1;   // 采集失败（DSH 没起）不算 job 失败，避免 tickd 堆 failures
      if (r.action === 'collect-failed') {
        sendAlert({ level: 'warn', source: 'card-watchdog', message: r.error ?? '采集失败', detail: { board: r.board, sessions: r.sessions } }, { home, silent: true });
      } else {
        process.stderr.write(`✘ card-watchdog tick 失败：${r.error}\n`);
      }
    }
  } catch (e) {
    exitCode = 1;
    process.stderr.write(`✘ card-watchdog tick 异常：${e?.stack ?? e}\n`);
    try { sendAlert({ level: 'error', source: 'card-watchdog', message: `tick 异常：${e?.message ?? e}` }, { home, silent: true }); } catch { /* ignore */ }
  } finally {
    lock.release();
  }
  return exitCode;
}

// ---------------------------------------------------------------- 输出

function printTick(r) {
  process.stdout.write(`🐕 盯卡巡检${r.dryRun ? '（dry-run）' : ''} · 档位 ${r.mode}（${r.modeSource ?? 'default'}）\n`);
  if (!r.ok) { process.stdout.write(`   ⚠️ ${r.action ?? 'error'}：${r.error}\n`); return; }
  const a = r.anomalies ?? {};
  process.stdout.write(`   扫描：${a.scanned ?? 0} 张卡（review ${a.byStatus?.review ?? 0} / running ${a.byStatus?.running ?? 0}）`
    + ` → 假结算 ${a.fakeSettled?.length ?? 0} · 假 running ${a.fakeRunning?.length ?? 0}\n`);
  const acts = r.actions ?? [];
  const real = acts.filter((x) => x.action !== 'skip');
  if (!real.length) process.stdout.write('   动作：无（无异常或已通知过）\n');
  else {
    for (const x of real) {
      process.stdout.write(`   - ${x.action}［${x.kind}］${x.seq ? `[${x.seq}] ` : ''}${x.title}`
        + ` · ${x.reason}${x.targetSource ? ` · 目标来源 ${x.targetSource}` : ''}${x.targetSessionId ? ` → ${String(x.targetSessionId).slice(0, 24)}…` : ''}`
        + `${x.ok === false ? ' ✘' : ''}${x.detail ? ` — ${String(x.detail).replace(/\n+/g, ' ').slice(0, 120)}` : ''}\n`);
    }
  }
  const st = r.stats ?? {};
  process.stdout.write(`   台账：${r.entries ?? 0} 条在册 · tick ${st.ticks ?? 0} · 注入 ${st.notified ?? 0} / 日报 ${st.reported ?? 0} / 升级 ${st.escalated ?? 0} / 清理 ${st.cleaned ?? 0}\n`);
  if (st.lastNotify) {
    const ln = st.lastNotify;
    process.stdout.write(`   上次投递：${ln.kind}${ln.ok === false ? '（失败）' : ''}${ln.title ? ` · 卡「${ln.title}」` : ''}${ln.sessionId ? ` → ${ln.sessionId}` : ''} · 来源 ${ln.source ?? 'none'}\n`);
  }
  process.stdout.write(`   台账文件：${r.ledgerFile}\n`);
  if (r.daily?.action) process.stdout.write(`   日报段：${r.daily.action} → ${r.daily.file}\n`);
}

function printStatus(p) {
  process.stdout.write(`🐕 盯卡巡检（card-watchdog ${p.version}）\n`);
  process.stdout.write(`   档位：${p.mode}（来源 ${p.modeSource ?? 'default'}）\n`);
  process.stdout.write(`   台账：${p.ledgerFile}\n   日志：${p.logFile}\n`);
  const st = p.stats ?? LEDGER_DEFAULT.stats;
  process.stdout.write(`   累计：tick ${st.ticks ?? 0} · 注入 ${st.notified ?? 0} · 日报 ${st.reported ?? 0} · 升级 ${st.escalated ?? 0} · 清理 ${st.cleaned ?? 0}`
    + `（fake-settled ${st.byKind?.['fake-settled'] ?? 0} / fake-running ${st.byKind?.['fake-running'] ?? 0}）\n`);
  process.stdout.write(`   上次投递：${st.lastNotify ? `${new Date(st.lastNotify.at).toLocaleString('zh-CN', { hour12: false })} ${st.lastNotify.kind}${st.lastNotify.ok === false ? '（失败）' : ''}${st.lastNotify.title ? ` · 卡「${st.lastNotify.title}」` : ''}${st.lastNotify.sessionId ? ` → ${st.lastNotify.sessionId}` : ''} · 来源 ${st.lastNotify.source ?? 'none'}` : '（暂无记录）'}\n`);
  process.stdout.write(`   绑定表：${p.bindings.exists ? (p.bindings.corrupt ? '⚠️ 损坏（按无绑定走降级链）' : `正常 · 卡级 ${p.bindings.cards} / 主线 ${p.bindings.lines}`) : '未创建'}\n`);
  process.stdout.write(`   tickd job：${p.tickd?.found ? `已注册（${p.tickd.every}，lastStatus=${p.tickd.lastStatus ?? '-'}，run ${p.tickd.runs} 次 / fail ${p.tickd.failures} 次）` : '未注册/未运行'}\n`);
  process.stdout.write(`   在册异常：${p.entries} 条${p.entries ? `（${Object.entries(p.kindCounts ?? {}).map(([k, v]) => `${k} ${v}`).join(' / ')}）` : ''}\n`);
  for (const r of p.rows) {
    const how = r.notifiedAt ? `已注入 ${new Date(r.notifiedAt).toLocaleString('zh-CN', { hour12: false })} → ${r.notifiedTo}`
      : r.escalatedAt ? `已升级（${r.reason}）`
        : r.reportedAt ? '已进日报段'
          : r.dedupeReason ? `与 queue 去重（${r.dedupeReason}）` : '未处置';
    process.stdout.write(`   - ${r.ageMin} 分钟 ${r.kind} [${r.seq ?? '-'}] ${r.title} · ${r.reason} · 会话 ${String(r.sessionId ?? '（无）').slice(0, 24)} → ${how} · 来源 ${r.targetSource ?? '（未评估）'}\n`);
  }
}

/** tickd 里 card-watchdog job 的注册状态（只读；未注册 = 改动尚未生效）。 */
async function tickdStatus() {
  try {
    const mod = await import('../src/dsh-butler/butler-tickd.mjs');
    const job = (mod?.JOBS ?? []).find((j) => j.id === 'card-watchdog');
    if (!job) return { found: false };
    let state = null;
    try {
      const dir = process.env.DSH_TICKD_DIR || path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-tickd');
      state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    } catch { /* 无状态文件 */ }
    const s = state?.jobs?.['card-watchdog'] ?? null;
    return {
      found: true, intervalMs: job.intervalMs,
      // 【卡「冷盘窗」2026-09-20】用 mod 自己的 describeSchedule（days / window 也要在 --status 看得见）
      every: typeof mod.describeSchedule === 'function' ? mod.describeSchedule(job) : (job.at ?? `${Math.round(job.intervalMs / 60000)}m`),
      script: job.script, lastStatus: s?.lastStatus ?? null, lastEndAt: s?.lastEndAt ?? null,
      runs: s?.runs ?? 0, failures: s?.failures ?? 0,
    };
  } catch (e) {
    return { found: false, error: e?.message ?? String(e) };
  }
}

// 入口守卫：junction 下 import.meta.url（物理）与 argv[1]（逻辑）必须 realpath 后比较
function isMainEntry() {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1] ?? ''));
  } catch { return false; }
}

if (isMainEntry()) {
  // ⚠️ 不用 process.exit() 强杀：tick 里发过 fetch（undici handle 仍在收尾），
  //    强杀会在 Windows 上打 libuv 断言噪声；自然退出即可把真实退出码交给 tickd。
  main()
    .then((code) => { process.exitCode = typeof code === 'number' ? code : 0; })
    .catch((e) => { console.error(`butler-card-watchdog-tick 失败：${e?.stack ?? e}`); process.exitCode = 1; });
}
