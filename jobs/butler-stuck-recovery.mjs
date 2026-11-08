#!/usr/bin/env node
// dsh-butler / butler-stuck-recovery.mjs —— 卡死会话自愈链（tickd job 入口 / 手动只读入口）
//
// 方案真源：`docs\方案-卡死会话自愈链-20261010.md`
// 判定与执行体：`lib/stuck-recovery.mjs`（本文件只是薄壳：参数解析 + 输出）
//
// 用法：
//   node <pkg>\jobs\butler-stuck-recovery.mjs              # 只读（dry-run）：只算不动
//   node <pkg>\jobs\butler-stuck-recovery.mjs --apply      # 真执行（tickd job 用这个）
//   node <pkg>\jobs\butler-stuck-recovery.mjs --status     # 只看开关/状态
//   node <pkg>\jobs\butler-stuck-recovery.mjs --json       # 机读
//
// 退出码：0 正常（含 noop/disabled）· 1 采集或执行失败 · 2 用法错
import { runStuckRecovery, summarizeStuckRecovery, loadCfg, loadState, cfgPath, statePath } from './lib/stuck-recovery.mjs';
import { dshHome } from '../src/dsh-butler/lib/paths.mjs';

const HELP = `卡死会话自愈链（默认只读）

用法：node butler-stuck-recovery.mjs [--apply] [--status] [--json] [--home <dir>]
  （无选项 = dry-run：只算不动，打印"将要做什么"）
  --apply   真执行（注入提醒 / 登记自动重启事由 / 升级报警）
  --status  只看总开关与链状态
  --json    机读输出`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
} else {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const home = val('--home', dshHome());
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  const statusOnly = argv.includes('--status');

  if (statusOnly) {
    const cfg = loadCfg({ home });
    const st = loadState({ home });
    const chains = Object.values(st.chains ?? {});
    const live = chains.filter((c) => !c.recoveredAt);
    const out = {
      enabled: cfg.enabled === true,
      cfgFile: cfgPath(home), stateFile: statePath(home),
      stuckMs: cfg.stuckMs, nudgeSteerMs: cfg.nudgeSteerMs, restartMs: cfg.restartMs,
      maxNudgesPerSessionPerDay: cfg.maxNudgesPerSessionPerDay, onlyWhenOvernight: cfg.onlyWhenOvernight,
      chains: { total: chains.length, live: live.length },
      live: live.map((c) => ({ sessionId: c.sessionId, idleMs: c.idleMs, nudges: c.nudges, restartIntentAt: c.restartIntentAt ?? null, reinjectAt: c.reinjectAt ?? null, escalateAt: c.escalateAt ?? null })),
    };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`总开关：${out.enabled ? '🟢 开' : '⚪ 关（缺省）'}  ${out.cfgFile}`);
      console.log(`阈值：卡死 ≥ ${Math.round(out.stuckMs / 60000)}min · 二次提醒 +${Math.round(out.nudgeSteerMs / 60000)}min · 重启事由 +${Math.round(out.restartMs / 60000)}min · 每会话每天 ${out.maxNudgesPerSessionPerDay} 次 · 自动重启仅整夜 ${out.onlyWhenOvernight}`);
      console.log(`链：共 ${out.chains.total} · 在链 ${out.chains.live}`);
      for (const c of out.live) console.log(`  - ${c.sessionId} 空闲 ${Math.round((c.idleMs ?? 0) / 60000)}min 提醒 ${c.nudges ?? 0} 次${c.restartIntentAt ? ' · 已登记重启事由' : ''}${c.reinjectAt ? ' · 已补注入' : ''}${c.escalateAt ? ' · 已报警' : ''}`);
    }
  } else {
    const r = await runStuckRecovery({ home, dryRun: !apply });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(summarizeStuckRecovery(r));
      if (r.status === 'disabled') console.log(`  （总开关关闭 ⇒ 零动作；放行：node <pkg>/jobs/stuck-recovery-cli.mjs on --apply）`);
      if (r.status === 'collect-failed') console.log(`  （采集失败：${r.reason}）`);
      // 2026-10-14 补（卡「管家 V2.9.X 收口 · tickd 双红灯真因」）：views-failed 此前只打状态、**不打原因**
      //   ⇒ tickd 失败留痕（`<tmp>\dsh-butler-tickd\last-error\<job>.log`，只留 stdout 尾部）里看不出
      //   这轮到底是 `fetch failed`（dsh 不可达）还是 `empty-list`（会话索引未就绪）—— 实测 2026-10-14
      //   09:26:30 那次 stuck-recovery exit-1 的原因因此无从判读（判据缺口）。
      //   纯**增量输出**：退出码（`r.ok === false ? 1 : 0`）与判定语义一字不动。
      if (r.status === 'views-failed') console.log(`  （视图读取失败（fail-closed，零动作）：${r.reason}）`);
      for (const it of r.items ?? []) console.log(`  - [${it.action}] ${it.sessionId.slice(0, 24)}… → ${it.status}${it.reason ? ` · ${it.reason}` : ''}`);
      for (const h of r.hints ?? []) console.log(`  · hint: ${h}`);
    }
    process.exitCode = r.ok === false ? 1 : 0;
  }
}
