#!/usr/bin/env node
// dsh-butler / butler-queue-tick.mjs —— [Q1] 队列推进巡检 + 自动叫醒（B 主干）入口
//
// 定位：看板卡被 runner 结算成「待验收(review)」后**不叫醒任何人**，下一张 once 卡也不会自己起
//   → 本 tick（tickd 每 1 分钟）做「叫醒 + 滞留升级」。**只提醒，不自动验收、不自动起卡**
//   （自动接力属 P3，裸跑报告放行后才谈）。
//
// 三档（`~/.dsh/butler-queue.json` 的 mode，默认 observe，放权不许跳档）：
//   observe → 零对外副作用（只写台账 + 日志）      —— 先看判定准不准
//   report  → 落日报段 + 桌宠（不注入会话）        —— 主人确认判定无误后
//   notify  → 注入「标题以【运行】开头」的唯一会话（running=false 才发）—— 主人放行后
//
// 用法：
//   node butler-queue-tick.mjs                     跑一轮（tickd 默认入口）
//   node butler-queue-tick.mjs --dry-run           只判定不落盘不通知（零副作用）
//   node butler-queue-tick.mjs --json              机器可读输出
//   node butler-queue-tick.mjs --status            台账总览（谁在待验收、通知过谁、升级没升级）
//   node butler-queue-tick.mjs --health            同上 + tickd job 注册状态（合规快照）
//   node butler-queue-tick.mjs --mode report       设置档位并立即按新档跑一轮
//   node butler-queue-tick.mjs --mode notify --allow-skip-stage   跳档（需显式确认）
//   node butler-queue-tick.mjs --set-only --mode observe          只改档位不跑
//   node butler-queue-tick.mjs --prune-inbox       裁剪事件信箱（只在全部已消费时）
// 其它：--home <dir>（覆盖 DSH_HOME，单测用）/ --base-url <url>（默认 http://localhost:3080）
//      / --escalate-after-min <n>（临时覆盖升级阈值）/ --no-daily（本轮不刷日报段）
// 退出码：0 正常（含"抢不到 tick 锁"静默退出）/ 1 失败 / 2 用法错误
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { gateComponent, COMPONENT_VERSIONS } from '../src/dsh-butler/lib/version.mjs';
import { alert as sendAlert } from '../src/dsh-butler/lib/alert.mjs';
import { loadBindings, describeBindings, summarizeBindings, bindingsPath, BINDINGS_NAME } from '../src/dsh-butler/lib/queue-bindings.mjs';
import {
  QUEUE_VERSION, MODES, DEFAULT_BASE_URL,
  loadConfig, loadLedger, setMode, saveConfig, runTick, summarize, alertsOf,
  logLine, logFile, configPath, ledgerPath, inboxPath, pruneInbox,
  // 【V3功能面 · 失败卡通知档】开关读数（宽限 / TTL）——`--failed-notify status` 用它
  failedNotifySettings,
  // 【K-14】接力台账 TTL 巡检（本 job = 方案写死的独立驱动者）：只读展示 + 超时告警常量
  loadPendingHandoff, DEFAULT_REBIND_WARN_MS,
} from '../src/dsh-butler/lib/queue-watch.mjs';

const USAGE = `usage: node butler-queue-tick.mjs [--dry-run] [--json] [--status] [--alerts] [--health] [--mode <${MODES.join('|')}>]
       [--receipt on|off|status] [--failed-notify on|off|status] [--apply] [--allow-skip-stage] [--set-only] [--prune-inbox] [--no-daily] [--home <dir>]
       [--base-url <url>] [--escalate-after-min <n>] [--docs-root <dir>]`;

function parse(argv) {
  const o = {
    dryRun: false, json: false, status: false, health: false, mode: null, allowSkipStage: false,
    setOnly: false, pruneInbox: false, noDaily: false, home: null, baseUrl: DEFAULT_BASE_URL, escalateAfterMin: null,
    alerts: false,
    // 【N12 · 2026-10-10】叫醒存亡确认（重启后补投兜底）的唯一开关入口；`--apply` 才真写配置（默认 dry-run）
    receipt: null, apply: false,
    // 【V3功能面 · 失败卡通知档 · 2026-10-22】失败卡叫醒开关（缺省开；`off` = 一键关回旧行为）
    failedNotify: null,
    // 【Q6】日报段落点（默认 = <workspace>\docs\管家报告）。沙箱演练/测试**必须**显式指定，
    //   否则看板清账判定（runTick 第 7 步）会写生产日报 —— 实测踩过。
    docsRoot: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--status') o.status = true;
    else if (a === '--alerts') o.alerts = true;
    else if (a === '--health') o.health = true;
    else if (a === '--mode') o.mode = argv[++i] ?? '';
    else if (a === '--receipt') o.receipt = (argv[++i] ?? '').toLowerCase();
    else if (a === '--failed-notify') o.failedNotify = (argv[++i] ?? '').toLowerCase();
    else if (a === '--apply') o.apply = true;
    else if (a === '--allow-skip-stage') o.allowSkipStage = true;
    else if (a === '--set-only') o.setOnly = true;
    else if (a === '--prune-inbox') o.pruneInbox = true;
    else if (a === '--no-daily') o.noDaily = true;
    else if (a === '--home') o.home = argv[++i] ?? null;
    else if (a === '--base-url') o.baseUrl = argv[++i] ?? DEFAULT_BASE_URL;
    else if (a === '--escalate-after-min') o.escalateAfterMin = Number(argv[++i]);
    else if (a === '--docs-root') o.docsRoot = argv[++i] ?? undefined;
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
  if (args.escalateAfterMin !== null && !(Number.isFinite(args.escalateAfterMin) && args.escalateAfterMin > 0)) {
    process.stderr.write('--escalate-after-min 必须是正数（分钟）\n'); return 2;
  }

  if (args.receipt && !['on', 'off', 'status'].includes(args.receipt)) {
    process.stderr.write('--receipt 必须是 on|off|status\n' + USAGE + '\n'); return 2;
  }
  if (args.failedNotify && !['on', 'off', 'status'].includes(args.failedNotify)) {
    process.stderr.write('--failed-notify 必须是 on|off|status\n' + USAGE + '\n'); return 2;
  }

  const home = args.home ? args.home : dshHome();

  // ---- 【N12】叫醒存亡确认开关（唯一入口；默认 dry-run，`--apply` 才写配置）
  //   为什么单独一个开关：这是"重启把叫醒吞掉 ⇒ 补投一次"的**行为开关**，必须能一键关回；
  //   且它默认关（候选态）⇒ 未放行时整条新代码路径零 IO、零动作（逐字旧行为）。
  if (args.receipt) {
    const cfg = loadConfig({ home, quiet: true });
    const cur = cfg.wakeReceipt?.enabled === true;
    if (args.receipt === 'status') {
      process.stdout.write(`叫醒存亡确认（wakeReceipt）：${cur ? '🟢 开' : '⚪ 关'}`
        + ` · minAgeMs=${cfg.wakeReceipt?.minAgeMs ?? '-'} · minIdleMs=${cfg.wakeReceipt?.minIdleMs ?? '-'}`
        + ` · maxRetries=${cfg.wakeReceipt?.maxRetries ?? '-'}\n  配置文件：${configPath(home)}\n`);
      return 0;
    }
    const want = args.receipt === 'on';
    if (!args.apply) {
      process.stdout.write(`（dry-run）叫醒存亡确认：${cur ? '开' : '关'} → **${want ? '开' : '关'}**（未写入）\n`
        + `  真要改：node butler-queue-tick.mjs --receipt ${args.receipt} --apply\n`);
      return 0;
    }
    if (want === cur) { process.stdout.write(`叫醒存亡确认已是 ${want ? '开' : '关'}（无改动）\n`); return 0; }
    saveConfig({ wakeReceipt: { enabled: want } }, { home, actor: process.env.DSH_SESSION_ID ?? 'cli' });
    logLine(`叫醒存亡确认（wakeReceipt）${cur ? '开' : '关'} → ${want ? '开' : '关'}（actor=${process.env.DSH_SESSION_ID ?? 'cli'}）`, {});
    process.stdout.write(`✔ 叫醒存亡确认已${want ? '放行（开）' : '关回'}：${configPath(home)}\n`);
    return 0;
  }

  // ---- 【V3功能面 · 失败卡通知档】开关（唯一入口；默认 dry-run，`--apply` 才写配置）
  //   缺省**开**（未写 `failedNotify` 键 = 开）；`off` = 一键关回旧行为（整段不跑、台账无新增键）。
  //   对象形态 `{enabled,graceMs,ttlMs}` 可覆盖阈值，也直接生效（这里只负责 enabled 键）。
  if (args.failedNotify) {
    const cfg = loadConfig({ home, quiet: true });
    const settings = failedNotifySettings(cfg);
    const cur = settings.enabled === true;
    if (args.failedNotify === 'status') {
      process.stdout.write(`失败卡通知档（failedNotify）：${cur ? '🟢 开' : '⚪ 关'}`
        + ` · 宽限 ${Math.round(settings.graceMs / 60_000)} 分钟 · TTL ${Math.round(settings.ttlMs / 3_600_000)} 小时`
        + ` · 已叫醒累计 ${Number(loadLedger({ home }).stats?.failed ?? 0)} 次\n  配置文件：${configPath(home)}\n`);
      return 0;
    }
    const want = args.failedNotify === 'on';
    if (!args.apply) {
      process.stdout.write(`（dry-run）失败卡通知档：${cur ? '开' : '关'} → **${want ? '开' : '关'}**（未写入）\n`
        + `  真要改：node butler-queue-tick.mjs --failed-notify ${args.failedNotify} --apply\n`);
      return 0;
    }
    if (want === cur) { process.stdout.write(`失败卡通知档已是 ${want ? '开' : '关'}（无改动）\n`); return 0; }
    saveConfig({ failedNotify: want }, { home, actor: process.env.DSH_SESSION_ID ?? 'cli' });
    logLine(`失败卡通知档（failedNotify）${cur ? '开' : '关'} → ${want ? '开' : '关'}（actor=${process.env.DSH_SESSION_ID ?? 'cli'}）`, {});
    process.stdout.write(`✔ 失败卡通知档已${want ? '开' : '关回'}：${configPath(home)}\n`);
    return 0;
  }

  // 组件闸门：版本不匹配 → 跳过该组件 + 告警（其余组件照常）
  const gate = gateComponent('butler-queue', QUEUE_VERSION, { home });
  if (!gate.run) { process.stderr.write(`[butler-queue] 组件版本闸门未通过（${gate.reason}）→ 本轮跳过\n`); return 0; }

  // ---- 档位设置
  if (args.mode) {
    const r = setMode(args.mode, { home, allowSkipStage: args.allowSkipStage, actor: process.env.DSH_SESSION_ID ?? 'cli' });
    if (!r.ok) { process.stderr.write(`✘ ${r.error}\n`); return 2; }
    process.stdout.write(`✔ 档位：${r.previous} → ${r.mode}（${configPath(home)}）\n`);
    logLine(`档位变更 ${r.previous} → ${r.mode}`, {});
    if (args.setOnly) return 0;
  }

  if (args.pruneInbox) {
    const cfg = loadConfig({ home });
    const r = pruneInbox({ home, maxLines: cfg.inbox?.maxLines ?? 1000 });
    process.stdout.write(`🧹 prune-inbox：${JSON.stringify(r)}\n`);
    if (!args.status && !args.health && !args.alerts) return r.ok ? 0 : 1;
  }

  // ---- 只读总览（--alerts = 只打告警视图，面板红标同源输出；排障/冒烟用）
  if (args.status || args.health || args.alerts) {
    const alertsOnly = args.alerts && !args.status && !args.health;
    const ledger = loadLedger({ home });
    const cfg = loadConfig({ home });
    const sum = summarize(ledger, { now: Date.now() });
    const tickd = alertsOnly ? null : await tickdStatus();
    // A 段（叫醒目标绑定）：绑定表规模 + 条目（**不**在这里做校验采集：--status 保持纯本地只读）
    const bindings = alertsOnly ? null : loadBindings({ home });
    const bRows = bindings ? describeBindings(bindings, { now: Date.now() }) : [];
    // 告警视图（遗留① 面板红标通道同源）：`--status`/`--alerts` 与面板 core 片吃同一份输出
    const alerts = alertsOf(ledger, { now: Date.now(), cfg });
    const payload = {
      ok: true, component: 'butler-queue', version: QUEUE_VERSION,
      registeredVersion: COMPONENT_VERSIONS['butler-queue'] ?? null,
      mode: cfg.mode, home,
      alertsOnly,
      configFile: configPath(home), ledgerFile: ledgerPath(home), inboxFile: inboxPath(home), logFile: logFile(),
      bindingsFile: bindingsPath(home), bindingsName: BINDINGS_NAME,
      bindings: bindings
        ? { exists: bindings.exists, corrupt: bindings.corrupt, error: bindings.error ?? null, summary: summarizeBindings(bindings, { now: Date.now() }), rows: bRows.slice(0, 30) }
        : null,
      lastNotify: sum.lastNotify, bySource: sum.bySource,
      // 【K-14】接力台账待改绑条目（**纯只读**：--status 不做任何清理，清理在 tick 里）
      relayTtl: { pending: loadPendingHandoff({ home }) },
      alerts,
      entries: sum.entries, rows: sum.rows, stats: sum.stats, inbox: sum.inbox, day: sum.day, tickd,
    };
    if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else printStatus(payload);
    return 0;
  }

  // ---- tick（单例锁：抢不到静默退出，不排队不重试）
  const lock = acquireTickLock('queue', { ttlMs: 120_000, home });
  if (!lock.ok) { process.stdout.write(`[butler-queue] 上一轮还在跑（${lock.reason}）→ 本轮跳过\n`); return 0; }

  let exitCode = 0;
  try {
    const cfgOverride = {};
    if (args.escalateAfterMin) cfgOverride.escalateAfterMs = args.escalateAfterMin * 60_000;
    if (args.noDaily) cfgOverride.dailyReport = false;

    const r = await runTick({ home, baseUrl: args.baseUrl, dryRun: args.dryRun, cfgOverride, mode: args.mode ?? undefined, docsRoot: args.docsRoot });
    if (args.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else printTick(r);

    if (!r.ok) exitCode = 1;
    else if (r.action === 'collect-failed') {
      // 采集失败（dsh 没起 / 看板离线 / 采集抖动）→ 记一次告警，但不算 job 失败（避免 tickd 里堆 failures 噪声）。
      // 【Q6】告警**限流**：连败段首轮必发，其后每 30 分钟最多一条（判定在 runTick 的 `planCollectFailure`，
      //   结果随 `r.collectFailure` 带回）——此前是每轮一条，持续故障时 alert.log 会被刷屏。
      const cf = r.collectFailure ?? null;
      if (cf && cf.alert === false) {
        process.stderr.write(`[butler-queue] 🔇 采集失败告警已限流（连续 ${cf.streak} 轮）：${cf.reason ?? ''}\n`);
      } else {
        sendAlert({
          level: 'warn', source: 'butler-queue',
          message: `${r.error ?? '采集失败'}${cf ? `（连续 ${cf.streak} 轮）` : ''}`,
          detail: { board: r.board, sessions: r.sessions, collectFailure: cf },
        }, { home, silent: true });
      }
    }
  } catch (e) {
    exitCode = 1;
    process.stderr.write(`✘ butler-queue tick 异常：${e?.stack ?? e}\n`);
    try { sendAlert({ level: 'error', source: 'butler-queue', message: `tick 异常：${e?.message ?? e}` }, { home, silent: true }); } catch { /* ignore */ }
  } finally {
    lock.release();
  }
  return exitCode;
}

// ---------------------------------------------------------------- 输出

function printTick(r) {
  process.stdout.write(`🐳 队列推进巡检${r.dryRun ? '（dry-run）' : ''} · 档位 ${r.mode} · 待验收 ${r.board?.review ?? '?'} 张\n`);
  const n = r.notifier ?? {};
  process.stdout.write(`   目标会话（标题判据）：${n.kind === 'unique' ? `唯一 ${n.sessionId}（running=${n.running}）` : n.kind === 'none' ? '无（标题以【运行】开头的会话 = 0）' : `不唯一（${n.count} 个）→ 不发`}\n`);
  // A 段：逐卡目标来源（binding=卡级绑定 → line-owner=主线 owner → fallback=标题判据 → none）
  const t = r.targets ?? null;
  if (t) {
    process.stdout.write(`   目标来源（逐卡）：binding ${t.binding ?? 0} · line-owner ${t['line-owner'] ?? 0} · fallback ${t.fallback ?? 0} · none ${t.none ?? 0}\n`);
    for (const d of (t.degraded ?? []).slice(0, 5)) {
      process.stdout.write(`   ↳ 降级：${d.seq ?? d.taskId}（${(d.reasons ?? []).join('+')}）\n`);
    }
  }
  if (r.bindings) {
    process.stdout.write(`   绑定表：${r.bindings.exists ? '' : '未创建'}卡级 ${r.bindings.cards} / 主线 ${r.bindings.lines}${r.bindings.corrupt ? ' ⚠️ 损坏 → 按无绑定处理（绝不误发）' : ''}（${r.bindings.file}）\n`);
  }
  if (r.autobind && r.autobind.missing) {
    process.stdout.write(`   自动登记：${r.autobind.missing} 张进行中卡无绑定 → ${r.dryRun ? 'dry-run 未写' : `已记 ${r.autobind.bound} 条 source=cron（无会话身份，不猜）`}\n`);
  }
  if (r.inbox) process.stdout.write(`   事件信箱：新增 ${r.inbox.newEvents} 条（offset ${r.inbox.offset}/${r.inbox.size}${r.inbox.skipped ? `，${r.inbox.skipped}` : ''}）\n`);
  if (r.wakeLayer) {
    // C 口径（2026-09-17 叫醒通道合并）：notify 档的真注入只由动作层执行 —— 把这行打出来，
    //   治"档位已是 notify 但四门关 → 静默无动作"（V3 批次3 §4 第 5 条）。
    const wl = r.wakeLayer; const g = wl.moduleGate;
    process.stdout.write(
      `   叫醒执行者：动作层 queue-wake（C 口径 · 单一注入者）· ${wl.status}`
      + `${g ? ` · 模块门 ${g.allowed ? '🟢 开' : `🔴 关（${g.reason ?? ''}）`}` : ''}`
      + `${wl.injected ? ` · 注入 ${wl.injected}` : ''}${wl.blocked ? ` · 挡下 ${wl.blocked}` : ''}${wl.noop ? ` · 跳过 ${wl.noop}` : ''}`
      + `${wl.reason ? ` — ${String(wl.reason).replace(/\n+/g, ' ').slice(0, 120)}` : ''}\n`,
    );
  }
  // 【V3功能面 · 失败卡通知档】候选与去向（dry-run 时这就是"当前会被报的 failed 卡"清单）
  if (r.failedNotify) {
    const fn = r.failedNotify;
    process.stdout.write(`   失败卡通道：候选 ${fn.candidates ?? 0} · 注入 ${fn.injected ?? 0} / 落日报 ${fn.reported ?? 0} / 升级 ${fn.escalated ?? 0} / 排队 ${fn.deferred ?? 0} / 跳过 ${fn.skipped ?? 0}`
      + ` · 宽限 ${Math.round(Number(fn.switch?.graceMs ?? 0) / 60_000)} 分钟 · TTL ${Math.round(Number(fn.switch?.ttlMs ?? 0) / 3_600_000)} 小时`
      + `${(fn.candidates ?? 0) === 0 ? '（当前无 failed 卡）' : ''}\n`);
    for (const it of (fn.items ?? []).slice(0, 8)) {
      process.stdout.write(`   🗂 ${it.action ?? '?'}${it.reason ? `（${it.reason}）` : ''}：${it.seq ? `[${it.seq}] ` : ''}${it.title}`
        + `｜挂于 ${it.endedAt ? new Date(it.endedAt).toLocaleString('zh-CN', { hour12: false }) : '?'}`
        + `${it.errorFirstLine ? `｜${String(it.errorFirstLine).slice(0, 100)}` : ''}\n`);
    }
  }
  const acts = r.actions ?? [];
  if (!acts.length) process.stdout.write('   无动作\n');
  else {
    const by = {};
    for (const a of acts) by[a.action] = (by[a.action] ?? 0) + 1;
    process.stdout.write(`   动作 ${acts.length} 条：${Object.entries(by).map(([k, v]) => `${k}×${v}`).join(' · ')}\n`);
    for (const a of acts) {
      if (a.action === 'skip') continue;
      process.stdout.write(`   - ${a.action}${a.targetSource ? `［${a.targetSource}］` : ''}：${a.seq ? `[${a.seq}] ` : ''}${a.title}${a.ok === false ? ' ✘' : ''} — ${String(a.detail ?? a.reason ?? '').replace(/\n+/g, ' ').slice(0, 160)}\n`);
    }
  }
  const st = r.ledger?.stats ?? {};
  process.stdout.write(`   台账：${r.entries ?? 0} 条待验收在册 · 累计 notify ${st.notified ?? 0} / report ${st.reported ?? 0} / escalate ${st.escalated ?? 0} / cleanup ${st.cleaned ?? 0}${st.failed === undefined ? '' : ` / failed ${st.failed}`}\n`);
  if (st.lastNotify) {
    process.stdout.write(`   上次投递：${st.lastNotify.kind}${st.lastNotify.ok === false ? '（失败）' : ''} → ${st.lastNotify.sessionId ?? '（无）'} · 来源 ${st.lastNotify.source ?? 'none'}\n`);
  }
  // 【K-14】接力台账 TTL 巡检（本 job = 方案写死的独立驱动者：清超期 + 超 10 分钟未改绑告警）
  const rtt = r.relayTtl ?? null;
  if (rtt) {
    const pend = rtt.pending ?? null;
    const rw = rtt.rebindWarn ?? null;
    process.stdout.write(
      `   接力台账 TTL：${pend ? `待改绑 1 条（源 ${String(pend.sourceSessionId ?? '?').slice(0, 20)}… → 接手 ${String(pend.newSessionId ?? '?').slice(0, 20)}…）` : '无待改绑条目'}`
      + ` · 本轮清理 ${rtt.cleared ?? 0}`
      + `${rtt.sweepRan === false ? '（判定未跑）' : ''}`
      + `${rtt.readOnly ? ' · 只判不清（dry-run/observe）' : ''}`
      + `${rtt.rmwContention ? ' · ⚠️ 抢锁失败（条目保留，下轮重试）' : ''}`
      + `${rw?.due ? ` · ⚠️ 超 ${Math.round(Number(rw.warnMs ?? DEFAULT_REBIND_WARN_MS) / 60_000)} 分钟未改绑${rtt.warned ? '（本轮已告警）' : ''}` : ''}`
      + `${rtt.skipped ? ` · 跳过（${rtt.skipped}）${rtt.error ? `：${String(rtt.error).slice(0, 80)}` : ''}` : ''}\n`,
    );
  }
  if (r.daily?.action) process.stdout.write(`   日报段：${r.daily.action} → ${r.daily.file}\n`);
  if (r.error) process.stdout.write(`   ⚠️ ${r.error}\n`);
  // 【Q6】采集失败/恢复的留痕与限流状态（此前 stdout 只有一行报错，看不出"连续几轮"与"告警有没有发出去"）
  if (r.collectFailure) {
    process.stdout.write(`   ↳ 采集留痕：连续失败 ${r.collectFailure.streak} 轮（累计 ${r.collectFailure.count} 次，尝试 ${r.collectFailure.attempts} 次）`
      + ` · 告警${r.collectFailure.alert ? '已发' : '**限流中**'}${r.collectFailure.reason ? `（${r.collectFailure.reason}）` : ''}\n`);
  }
  if (r.collectRecovery) {
    process.stdout.write(`   ↳ 采集恢复：此前连续失败 ${r.collectRecovery.streak} 轮 → 连败段已清零\n`);
  }
}

function printStatus(p) {
  // --alerts：只读告警视图（面板红标同源输出）—— 不打印台账/绑定/tickd 等无关噪声，便于脚本与主人速读
  if (p.alertsOnly) {
    const al = p.alerts ?? { stats: {}, items: [] };
    const bl = al.stats?.byLevel ?? {};
    process.stdout.write(`🐳 队列告警视图（butler-queue ${p.version} · 与面板「② 待处理」红标同源）\n`);
    process.stdout.write(`   台账：${p.entries} 张在册 · 告警 ${al.stats?.count ?? 0} 项（🔴 ${bl.red ?? 0} / 🟡 ${bl.yellow ?? 0}）\n`);
    if ((al.stats?.count ?? 0) === 0) process.stdout.write('   ✅ 无告警（在册卡均不处于失败态）\n');
    for (const a of al.items ?? []) {
      process.stdout.write(`   ${a.level === 'red' ? '🔴' : '🟡'} ${a.label} · ${a.seq ? `[${a.seq}] ` : ''}${a.title}（滞留 ${a.ageMin} 分钟）\n`);
      process.stdout.write(`         ${a.detail}\n`);
    }
    return;
  }
  process.stdout.write(`🐳 队列推进巡检（butler-queue ${p.version}${p.registeredVersion ? ` / 产品登记 ${p.registeredVersion}` : ' / 未登记'}）\n`);
  process.stdout.write(`   档位：${p.mode}   （${p.configFile}）\n`);
  process.stdout.write(`   台账：${p.ledgerFile}\n`);
  process.stdout.write(`   信箱：${p.inboxFile}（offset ${p.inbox?.offset ?? 0} / size ${p.inbox?.size ?? 0}，已见 ${p.inbox?.eventsSeen ?? 0} 条）\n`);
  // A 段：绑定表（叫醒目标降级链的第一、二级）
  const b = p.bindings ?? null;
  if (b) {
    process.stdout.write(`   绑定表：${b.exists ? (b.corrupt ? '⚠️ 损坏（按"无绑定"走降级链，绝不误发）' : '正常') : '未创建（判定走降级链：标题唯一 → escalate）'} · 卡级 ${b.summary?.byKind?.card ?? 0} / 主线 ${b.summary?.byKind?.line ?? 0}（${p.bindingsFile}）\n`);
    if ((b.summary?.total ?? 0) > 0) {
      process.stdout.write('       （--status 只读本地表，**不校验**会话/看板存在性；要校验用 butler-bind-card.mjs --list）\n');
    }
    for (const r of (b.rows ?? []).slice(0, 10)) {
      const who = r.sessionId ? String(r.sessionId).slice(0, 24) : '（无主）';
      process.stdout.write(`       - ${r.kind === 'card' ? '卡' : '主线'} ${r.seq ? `[${r.seq}] ` : ''}${r.title ?? r.key} → ${who} · ${r.status}${r.ageMin !== null ? ` · ${r.ageMin} 分钟前` : ''}\n`);
    }
  }
  const ln = p.lastNotify;
  process.stdout.write(`   上次投递：${ln ? `${new Date(ln.at).toLocaleString('zh-CN', { hour12: false })} ${ln.kind}${ln.ok === false ? '（失败）' : ''} → ${ln.sessionId ?? '（无）'} · **来源 ${ln.source ?? 'none'}**${ln.title ? ` · 卡「${ln.title}」` : ''}` : '（**暂无记录** —— 从未投递过）'}\n`);
  // 【K-14】接力台账：待改绑条目（**只读** —— `--status` 不做任何清理，清理与超时告警在每轮 tick 里）
  const rtp = p.relayTtl ?? null;
  if (rtp) {
    process.stdout.write(rtp.pending
      ? `   接力台账：**待改绑 1 条** · 源 ${String(rtp.pending.sourceSessionId ?? '?').slice(0, 24)}… → 接手 ${String(rtp.pending.newSessionId ?? '?').slice(0, 24)}… · 交接 ${new Date(Number(rtp.pending.handoffAt) || Date.now()).toLocaleString('zh-CN', { hour12: false })}（超 ${Math.round(DEFAULT_REBIND_WARN_MS / 60_000)} 分钟未改绑 ⇒ 日报 + 桌宠；到 expireAt 自动清）\n`
      : '   接力台账：无待改绑条目\n');
  }
  const bs = p.bySource ?? {};
  process.stdout.write(`   目标来源累计：binding ${bs.binding ?? 0} · line-owner ${bs['line-owner'] ?? 0} · fallback ${bs.fallback ?? 0} · none ${bs.none ?? 0}${bs.failed === undefined ? '' : ` · failed ${bs.failed}`}\n`);
  process.stdout.write(`   日志：${p.logFile}\n`);
  process.stdout.write(`   tickd job：${p.tickd?.found ? `已注册（${p.tickd.every}，lastStatus=${p.tickd.lastStatus ?? '-'}，run ${p.tickd.runs} 次 / fail ${p.tickd.failures} 次）` : '未注册/未运行'}\n`);
  process.stdout.write(`   在册待验收：${p.entries} 张${p.rows.some((r) => r.execAlive) ? `（其中 ⏳ 疑似假结算 ${p.rows.filter((r) => r.execAlive).length} 张 — 执行会话仍在跑，不会叫醒）` : ''}\n`);
  // 告警视图（遗留①）：失败态一句话可见（面板「② 待处理」的红标同源）
  const al = p.alerts ?? null;
  if (al) {
    const bl = al.stats?.byLevel ?? {};
    if ((al.stats?.count ?? 0) === 0) {
      process.stdout.write('   告警视图：✅ 无（在册卡均不处于失败态）\n');
    } else {
      process.stdout.write(`   告警视图：🔴 ${bl.red ?? 0} · 🟡 ${bl.yellow ?? 0}（面板红标通道同源；明细见下）\n`);
      for (const a of al.items) {
        process.stdout.write(`   ${a.level === 'red' ? '🔴' : '🟡'} ${a.label} · ${a.seq ? `[${a.seq}] ` : ''}${a.title}（滞留 ${a.ageMin} 分钟）\n`);
        process.stdout.write(`         ${a.detail}\n`);
      }
      if ((al.stats?.count ?? 0) > (al.items ?? []).length) process.stdout.write(`         …… 其余 ${(al.stats?.count ?? 0) - al.items.length} 项未列出（上限 ${al.cap}）\n`);
    }
  }
  for (const r of p.rows) {
    process.stdout.write(`   - ${r.ageMin} 分钟${r.seq ? ` [${r.seq}]` : ''} ${r.title}\n`);
    const how = r.execAlive
      ? `⏳ 疑似假结算：执行会话 ${String(r.execSessionId ?? '?').slice(0, 20)}… 仍在运行（${r.execAliveReason ?? '?'}）→ 不叫醒，等它真结束`
      : r.notifiedAt
        ? `已提醒 ${new Date(r.notifiedAt).toLocaleString('zh-CN', { hour12: false })} → ${r.notifiedTo}`
        : (r.pendingSince ? `排队中（${new Date(r.pendingSince).toLocaleString('zh-CN', { hour12: false })} 起，目标在跑）` : '未提醒');
    process.stdout.write(`       ${how} · 目标来源 ${r.targetSource ?? '（未评估）'}${r.targetSessionId ? ` → ${String(r.targetSessionId).slice(0, 24)}` : ''}${r.escalatedAt ? ' · 已升级' : ''}\n`);
  }
  process.stdout.write(`   统计：tick ${p.stats?.ticks ?? 0} · notify ${p.stats?.notified ?? 0} · report ${p.stats?.reported ?? 0} · escalate ${p.stats?.escalated ?? 0} · cleanup ${p.stats?.cleaned ?? 0}${p.stats?.failed === undefined ? '' : ` · failed ${p.stats.failed}`} · 上次 ${p.stats?.lastTickAt ?? '-'}（${p.stats?.lastMode ?? '-'}）\n`);
  // 【V3功能面 · 失败卡通知档】在册失败卡状态（`--status` 不采集看板，只读台账自己的状态条目）
  const fnStat = p.stats?.failedNotify ?? null;
  if (fnStat && Object.keys(fnStat).length) {
    process.stdout.write(`   失败卡在册：${Object.keys(fnStat).length} 张（累计叫醒 ${Number(p.stats?.failed ?? 0)} 次 · 累计落日报 ${Number(p.stats?.failedReported ?? 0)} 次）\n`);
  }
  // 【Q6】采集健康（累计失败 / 当前连败 / 告警条数）——「队列为什么几轮没动」在这里一句可见
  const cfStat = Number(p.stats?.collectFailures ?? 0) || 0;
  if (cfStat > 0 || Number(p.stats?.collectFailStreak ?? 0) > 0) {
    process.stdout.write(`   采集健康：累计失败 ${cfStat} 轮 · 当前连败 ${p.stats?.collectFailStreak ?? 0} · 告警已发 ${p.stats?.collectAlertCount ?? 0} 条`
      + ` · 上次失败 ${p.stats?.collectFailLastAt ? new Date(p.stats.collectFailLastAt).toLocaleString('zh-CN', { hour12: false }) : '-'}`
      + `${p.stats?.collectFailLastReason ? `（${p.stats.collectFailLastReason}）` : ''}`
      + `${p.stats?.collectRecoveredAt ? ` · 最近恢复 ${new Date(p.stats.collectRecoveredAt).toLocaleString('zh-CN', { hour12: false })}` : ''}\n`);
  }
  // 「档位躺平」检测（2026-09-14 事故：tick 1355 次 / notify 0 次，没人知道）
  if ((p.stats?.ticks ?? 0) >= 60 && (p.stats?.notified ?? 0) === 0 && p.mode === 'observe') {
    process.stdout.write(`   ⚠️ 长期观察档：已 tick ${p.stats.ticks} 次、注入 0 次 —— 这是"只记账不注入"的设计，不是故障；要真叫醒请逐档升：--mode report → --mode notify\n`);
  }
  process.stdout.write(`   当日（${p.day?.day ?? '-'}）：事件 ${p.day?.events ?? 0} 条\n`);
}

/** tickd 里 queue job 的注册状态（只读；未注册 = 改动尚未部署）。 */
async function tickdStatus() {
  try {
    const mod = await import('../src/dsh-butler/butler-tickd.mjs');
    const job = (mod.JOBS ?? []).find((j) => j.id === 'queue');
    if (!job) return { found: false };
    let state = null;
    try {
      const dir = process.env.DSH_TICKD_DIR || path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-tickd');
      state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    } catch { /* 无状态文件 */ }
    const s = state?.jobs?.queue ?? null;
    return {
      found: true, intervalMs: job.intervalMs,
      every: job.intervalMs ? `${Math.round(job.intervalMs / 60000)}m` : (job.at ?? '?'),
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
  //    强杀会在 Windows 上打 libuv 断言噪声（实测 uv_async.c 断言）；自然退出 <1s，
  //    且能把真实退出码交给 tickd（既无噪声也不误记 failures）。
  main()
    .then((code) => { process.exitCode = typeof code === 'number' ? code : 0; })
    .catch((e) => { console.error(`butler-queue-tick 失败：${e?.stack ?? e}`); process.exitCode = 1; });
}
