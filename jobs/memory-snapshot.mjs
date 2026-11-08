#!/usr/bin/env node
// dsh-butler / memory-snapshot.mjs —— 记忆库每日热采（tickd job `memory-snapshot`）
//
// 定位：把 A 类不可重建资产 `memory.db` 的 RPO 从「Depart 冷采（最坏丢一天）」升到
//   「每日 1 次热采 + **内容未变不推**」—— 见 lib/memory-snapshot.mjs 文件头（为什么）。
//   本文件只是**薄 CLI**：解析参数 → 调 lib 的 runMemorySnapshot → 打印摘要 + 退出码。
//
// 触发源：tickd JOBS 的 `memory-snapshot`（每日 04:20，避开 hot/queue/pitfall 的整点与半点）。
//   手工可随时跑（幂等；与 hot / handoff 共用 `tick-handoff.lock`，抢不到=跳过不并发）。
//
// 用法：
//   node <pkg>\jobs\memory-snapshot.mjs            # 正常一轮（有变化才落仓 + 推）
//   node <pkg>\jobs\memory-snapshot.mjs --dry-run  # 只算：做快照 + 比对，不写任何文件
//   node <pkg>\jobs\memory-snapshot.mjs --status   # 只读打印状态
//   node <pkg>\jobs\memory-snapshot.mjs --json     # 末尾追加 JSON
//   node <pkg>\jobs\memory-snapshot.mjs --force    # 内容未变也强制落仓/推送
//   （沙箱/单测可注入：--home / --src / --repo / --tmp / --state）
//
// 退出码：0 完成（含"内容未变"与 dry-run）/ 3 让路（锁被占 / git-crypt 未 unlock / 推前安全门拦截）/ 1 失败
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMemorySnapshot, statePathOf, MEMORY_SNAPSHOT_VERSION } from './lib/memory-snapshot.mjs';
import { readJson } from '../src/dsh-butler/lib/store.mjs';
import { dshHome } from '../src/dsh-butler/lib/paths.mjs';

const USAGE = [
  'dsh-memory-snapshot —— 记忆库每日热采（VACUUM INTO 快照 + 内容未变不推）',
  '',
  '  node memory-snapshot.mjs [--dry-run] [--json] [--status] [--force] [--no-push] [--no-lock]',
  '                           [--home <dir>] [--src <memory.db>] [--repo <仓1 工作副本>] [--tmp <dir>] [--state <file>]',
  '',
  '  --dry-run   做快照 + 比对，但不写仓副本、不提交、不推送（生产 memory.db 始终只读）',
  '  --status    只读打印状态文件（不执行）',
  '  --force     内容未变也强制落仓 + 推送（默认：未变 → 零写入 / 零提交 / 不推）',
  '  --no-push   提交但不推送（演练用）',
  '  --no-lock   跳过单例锁（**仅单测/沙箱**；生产会被 hot/交接并发踩工作副本）',
  '  --json      stdout 末尾追加 JSON',
  '',
  '  退出码：0 完成 / 3 让路（锁被占 / git-crypt 未 unlock / 推前安全门拦截）/ 1 失败',
].join('\n');

function parseArgs(argv) {
  const o = {
    dryRun: false, json: false, status: false, force: false, noPush: false, noLock: false, help: false, unknown: null,
    home: null, src: null, repo: null, tmp: null, state: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--status') o.status = true;
    else if (a === '--force') o.force = true;
    else if (a === '--no-push') o.noPush = true;
    else if (a === '--no-lock') o.noLock = true;
    else if (a === '--home') o.home = argv[++i];
    else if (a === '--src') o.src = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--tmp') o.tmp = argv[++i];
    else if (a === '--state') o.state = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else o.unknown = a;
  }
  return o;
}

export async function run(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (o.unknown) { process.stderr.write(`❌ 未知参数：${o.unknown}\n\n${USAGE}\n`); return 2; }

  const home = o.home ?? dshHome();
  const stateFile = o.state ?? statePathOf(home);

  if (o.status) {
    const st = readJson(stateFile, { defaultValue: null });
    process.stdout.write(`── 记忆库热采状态（${stateFile}）\n`);
    if (!st) { process.stdout.write('    （尚无记录）\n'); if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify({ status: null }, null, 2) + '\n'); return 0; }
    process.stdout.write(`    设备 ${st.host ?? '?'}　上次 ${st.lastRunAt ?? '?'}　结果 ${st.lastResult ?? '?'}\n`);
    process.stdout.write(`    原因 ${st.lastReason ?? '-'} / 阶段 ${st.lastStage ?? '-'} / 耗时 ${st.lastDurationMs ?? '-'}ms\n`);
    process.stdout.write(`    计数 runs=${st.runs ?? 0} 推送=${st.pushedCount ?? 0} 未变=${st.unchangedCount ?? 0} 让路=${st.blockedCount ?? 0} 失败=${st.failedCount ?? 0}\n`);
    process.stdout.write(`    快照 ${st.snapshotBytes ?? '-'} B sha=${String(st.snapshotSha ?? '-').slice(0, 16)} / 仓副本 sha=${String(st.repoCopySha ?? '-').slice(0, 16)}\n`);
    if (st.lastError) process.stdout.write(`    ⚠️ 上次错误：${st.lastError}\n`);
    if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify({ status: st }, null, 2) + '\n');
    return 0;
  }

  const res = await runMemorySnapshot({
    home,
    srcDb: o.src ?? undefined,
    repoDir: o.repo ?? undefined,
    tmpDir: o.tmp ?? undefined,
    stateFile,
    dryRun: o.dryRun, force: o.force, noPush: o.noPush, lock: !o.noLock,
  });

  const icon = { ok: '✅', unchanged: '🟢', 'dry-run': '🧪', blocked: '⏸', failed: '❌' }[res.result] ?? '❔';
  process.stdout.write(`\n${icon} 记忆库热采 result=${res.result}（${res.durationMs}ms）\n`);
  process.stdout.write(`    版本 ${MEMORY_SNAPSHOT_VERSION}　源库 ${res.paths.src}\n`);
  if (res.snapshot) process.stdout.write(`    快照 ${res.snapshot.bytes ?? '-'} B（VACUUM ${res.snapshot.vacuumMs ?? '-'}ms × ${res.snapshot.vacuumAttempts ?? '-'}）sha=${String(res.snapshot.sha256 ?? '').slice(0, 16)}\n`);
  if (res.counts) process.stdout.write(`    条数 memories=${res.counts.snapshot?.memories ?? '-'}　integrity=${res.integrity?.ok ? 'ok' : 'FAIL'}　与源库一致=${res.counts.equal}\n`);
  if (res.repo) process.stdout.write(`    仓副本 ${res.repo.beforeBytes ?? '-'} → ${res.repo.afterBytes ?? '-'} B　before=${String(res.repo.beforeSha ?? '-').slice(0, 12)} after=${String(res.repo.afterSha ?? '-').slice(0, 12)} ahead=${res.repo.ahead ?? 0}\n`);
  if (res.decision) process.stdout.write(`    判定 ${res.decision.action}：${res.decision.reason}\n`);
  if (res.commit) process.stdout.write(`    提交 ${res.commit.committed ? '已提交' : `未提交（${res.commit.reason ?? '-'}）`}\n`);
  if (res.push) process.stdout.write(`    推送 ${res.push.ok ? '✅ 既有链路（dsh-backup-sync.ps1 -Push）已推' : (res.push.blocked ? '⏸ 被推前安全门拦下' : `❌ 失败（${res.push.code}）`)}\n`);
  for (const d of res.deferred) process.stdout.write(`    … ${d}\n`);
  for (const a of res.alerts) process.stdout.write(`    !! [${a.level}] ${a.code}: ${a.message}\n`);
  process.stdout.write(`    生产 memory.db 只读自证：${res.sourceUnchanged === true ? '跑前跑后 sha 一致 ✅' : (res.sourceUnchanged === false ? '⚠️ 期间有写入（DSH 自己写的，非本 job）' : '-')}\n`);
  if (res.error) process.stdout.write(`    ❌ ${res.error}\n`);

  if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify({ memorySnapshot: res }, null, 2) + '\n');
  return res.exitCode ?? 1;
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  try {
    process.exitCode = await run();
  } catch (e) {
    process.stderr.write(`\n❌ 记忆库热采异常：${e?.stack ?? e}\n`);
    process.exitCode = 1;
  }
}
