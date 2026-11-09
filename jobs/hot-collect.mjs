#!/usr/bin/env node
// dsh-butler / hot-collect.mjs —— P9 H1b 热采（30 分钟档）
//
// 定位：把「本机生产状态」按 §8 的**逐文件快照口径**搬进仓1/仓3 工作副本并 push。
//   · 只搬**已闭合会话**（A12 判据见 lib/hot-collect.mjs 的 isClosedForHot）
//   · 账本**走 Host API 只读导出**（不复制文件）；memory.db **一律跳过**
//   · 审计流水做**行边界校验**；任何一项撞锁/校验不过 → 记 skipped，**不中断整轮**
//   · **绝不向生产分发**（那是 Arrive 的事）
//
// 触发源（〔订正注 · 2026-10-28〕原写「四类」，现查实际只有前两类真存在；单例锁 `tick-handoff.lock`
//   口径不变，§5.3 第 6 条 R12）：
//   ① tickd job `hot`（30 分钟档）—— **已关**（enabled:false，why=拆仓库钩子 20261028；六仓同日已删）
//   ② 手工 `node hot-collect.mjs` —— 现在是**唯一现役入口**
//   ③ 关机钩 Depart 自采、**不调本脚本**（撞上热采走 drain 等待，不并发）—— 2026-10-28 现查
//   ④ 外部通道远程收工 H5 —— **从未落地**（2026-10-28 现查）
//
// 用法：
//   node <pkg>\jobs\hot-collect.mjs [--dry-run] [--json]
//        [--skip-sessions] [--skip-ledger] [--limit <n>] [--no-push] [--status]
//
// 退出码：0 完成（result=ok；result=skipped 也算 0 —— 那是「备份根未配置」，见下）/ 3 deferred（有未完成项）或抢不到锁 / 1 失败
//
// 方案：docs\管家v2.5-P9会交接与云中继方案-20260910.md §8 / §5.3 / §5.7 / §17.2 T4
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import { gitBackupRoot } from './lib/ws-root.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { readJson, updateJson, acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { updateStateJson } from '../src/dsh-butler/lib/dual-write-store.mjs';
import { appendAudit } from '../src/dsh-butler/lib/audit.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { collectHot, HOT_COLLECT_VERSION, exportLedgerSnapshot, VOLUME_THRESHOLDS,
  COLLECT_REPO1, COLLECT_REPO3, SKIP_REPO2, REPO_RETIRE_NOTE } from './lib/hot-collect.mjs';
import { judgeDualActiveTransition } from '../src/dsh-butler/lib/handoff-version-gate.mjs';
import { readVersionFile, localVersionPath } from '../src/dsh-butler/lib/handoff-version.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';

const DSH_ROOT = process.env.BUTLER_HANDOFF_ROOT || workspaceRoot();
// 备份根：**「显式指定」与「缺省推导」必须能分开**（卡 B15）——
//   collectHot 只有知道「人到底有没有说过它在哪」，才能区分「没配置（干净机器的正常态）」
//   与「配了但坏了（真故障）」。派生值一旦混进来，这两种情况长得一模一样。
const GIT_BACKUP_RAW = String(process.env.BUTLER_HANDOFF_GITBACKUP ?? '').trim();
const GIT_BACKUP = GIT_BACKUP_RAW || gitBackupRoot();
const GIT_BACKUP_EXPLICIT = Boolean(GIT_BACKUP_RAW) || Boolean(String(process.env.DSH_GITBACKUP_ROOT ?? '').trim());
/** 【2c-B3】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
const stateFileOf = (name, home) => resolveStatePath(name, { home }).path;
const STATE_NAME = 'butler-handoff-hot.json';
const LOCK_TTL_MS = 45 * 60 * 1000;

const OUT = { json: null, lines: [] };
function log(msg = '') { OUT.lines.push(msg); process.stdout.write(msg + '\n'); }
function section(t) { log(''); log(`── ${t} ─────────────────────────────────`); }

const USAGE = [
  'dsh-handoff-hot —— P9 H1b 热采（只搬已闭合会话 + 小文件增量；不向生产分发）',
  '',
  '  node hot-collect.mjs [--dry-run] [--json] [--skip-sessions] [--skip-ledger]',
  '                       [--limit <n>] [--no-push] [--allow-divergence] [--no-pull-first] [--status]',
  '',
  '  --dry-run        只算计划、不写工作副本、不提交、不推送（pull-first 也只报结论、不快进）',
  '  --skip-sessions  跳过仓2 会话（只搬小文件）。⚠️ 2026-10-27 起仓2 由**代码层** SKIP_REPO2 硬挡，',
  '                   本参数不再是唯一开关（不带它也不会采仓2）',
  '  --skip-ledger    跳过 Host API 账本导出',
  '  --limit <n>      本轮最多检查多少个会话（默认 400）',
  '  --no-push        采集 + 提交，但不 push（沙箱/演练用）',
  '  --no-pull-first  关掉「采集前先把工作副本对齐远端」（回到旧行为：采前不 pull）',
  '  --allow-divergence  显式跳过「推前安全门」（远端分叉时仍要推：危险，需人工确认远端内容已分发或可弃）',
  '  --status         打印上次热采状态（不执行）',
  '  --json           stdout 末尾追加 JSON',
  '',
  '  推前安全门（默认开启）：采集前 + 推送前各判一次「远端是否有本机不了解的提交」（见 lib/push-guard.mjs）；',
  '  命中即本仓不采集/不推送并告警（fail-closed），逃生舱是 --allow-divergence（写审计流水）。',
  '  pull-first（默认开启 · 2026-10-10 S-14）：门判定后，若「本机落后 ∧ 工作树干净 ∧ 无本地未推提交」',
  '  则先 git merge --ff-only 把工作副本对齐远端**再复判**（判据与 dsh-backup-sync.ps1 -Sync 同源）。',
  '',
  '  【仓退役 · 2026-10-27 主人令】真源 = docs\\方案-仓退役与隧道常驻-20261027.md §3 批1',
  '    仓1 dsh-core    停采（COLLECT_REPO1=false）· 账本导出连带停（配置整包改走冷盘）',
  '    仓2 dsh-sessions 永不采集（SKIP_REPO2 代码层硬守卫，与调用参数无关）',
  '    仓3 dsh-workspace 保持采集（1-4 实测 text-sync 覆盖不足 ⇒ 不停采）',
  '  一键回滚：_archive\\repo-retire-20261027\\restore-hot-collect.mjs --apply（默认 dry-run）',
].join('\n');

function parseArgs(argv) {
  const o = { dryRun: false, json: false, skipSessions: false, skipLedger: false, noPush: false, limit: null, status: false, help: false, unknown: null, allowDivergence: false, noPullFirst: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--skip-sessions') o.skipSessions = true;
    else if (a === '--skip-ledger') o.skipLedger = true;
    else if (a === '--no-push') o.noPush = true;
    else if (a === '--no-pull-first') o.noPullFirst = true;
    else if (a === '--allow-divergence') o.allowDivergence = true;
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--status') o.status = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o.unknown = a;
  }
  return o;
}

/** 对端交接单（读仓1 工作副本里的 dsh/butler-handoff/*.json，排除本机那份）。 */
function readPeerRecords(host) {
  const dir = path.join(GIT_BACKUP, 'dsh-core', 'dsh', 'butler-handoff');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of names) {
    const peerHost = f.replace(/\.json$/, '');
    if (peerHost === host) continue;
    const rec = readJson(path.join(dir, f), { defaultValue: null });
    if (rec) out.push({ host: peerHost, record: rec });
  }
  return out;
}

async function cmdStatus() {
  const file = stateFileOf(STATE_NAME, dshHome());
  const st = readJson(file, { defaultValue: null });
  section('热采状态');
  if (!st) { log('    （尚无热采记录）'); OUT.json = { status: null }; return 0; }
  log(`    设备 ${st.host ?? '?'}　上次热采 ${st.updatedAt ?? '?'}　结果 ${st.lastResult ?? '?'}`);
  log(`    小文件：复制 ${st.files?.copied ?? 0} / 未变 ${st.files?.unchanged ?? 0} / 跳过 ${(st.files?.skipped ?? []).length}`);
  log(`    会话：闭合 ${st.sessions?.closed ?? 0} / 搬运 ${st.sessions?.moved ?? 0} / 未闭合跳过 ${st.sessions?.openSkipped ?? 0}`);
  const lgSt = st.ledger ?? null;
  // 档 C（2026-10-13）：节流轮 ok=true 但无 revision ⇒ 分开显示（否则会打出"revision undefined"）
  log(`    账本：${lgSt?.skipped === 'throttled'
    ? `本轮未到点（节流 ${(Number(lgSt.intervalMs) / 3600000).toFixed(1)}h，上次导出 ${new Date(Number(lgSt.lastAt)).toISOString()}）`
    : (lgSt?.ok ? `导出 ok（revision ${lgSt.revision}${lgSt.changed === false ? ' · 语义未变' : ''}）` : `未导出（${lgSt?.reason ?? '-'}）`)}`);
  const lv = readVersionFile(localVersionPath());
  log(`    本机 handoff-version.json：${lv ? `self=${lv.self} minSupported=${lv.minSupported ?? '-'}` : '（缺）'}`);
  OUT.json = { status: st, version: lv, versionFile: localVersionPath() };
  return 0;
}

export async function run(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (o.unknown) { process.stderr.write(`❌ 未知参数：${o.unknown}\n\n${USAGE}\n`); return 2; }
  if (o.status) return cmdStatus();

  const host = String(process.env.COMPUTERNAME ?? os.hostname() ?? 'unknown').toLowerCase();
  const t0 = Date.now();

  // 0) 单例锁（四类触发共用；tickd 侧持锁时走继承虚拟锁）
  const lock = acquireTickLock('handoff', { ttlMs: LOCK_TTL_MS });
  if (!lock.ok) {
    process.stderr.write(`⏸ 交接窗口被占用（${lock.reason}）→ 本轮热采跳过（不并发，§5.3 R12）\n`);
    OUT.json = { skipped: true, reason: lock.reason, holder: lock.holder ?? null };
    if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify(OUT.json, null, 2) + '\n');
    return 3;
  }

  try {
    // 1) 双开嫌疑（§17.2 T4 硬条款）：嫌疑期**禁止热采**（fail-closed），否则会拿旧增量去覆盖对端
    let dualActive = null;
    let peerHost = null;
    for (const p of readPeerRecords(host)) {
      const j = judgeDualActiveTransition(p.record, { now: t0 });
      if (j.suspected === true) { dualActive = j; peerHost = p.host; break; }
    }
    if (dualActive) {
      section('热采 · 中止（双开嫌疑 · fail-closed）');
      log(`    !! 对端 ${peerHost}：${dualActive.reason}`);
      if (!o.dryRun) {
        appendAudit({ type: 'handoff-hot', host, result: 'blocked', code: 'dual-active', peer: peerHost, reason: dualActive.reason });
        updateStateJson(STATE_NAME, stateFileOf(STATE_NAME, dshHome()), (cur) => ({
          ...(cur ?? {}),
          schemaVersion: 1, host, updatedAt: new Date().toISOString(), lastResult: 'blocked',
          reason: `dual-active:${peerHost}`,
        }), { schemaVersion: 1, defaultValue: {} });
      }
      OUT.json = { blocked: true, code: 'dual-active', peer: peerHost, reason: dualActive.reason };
      if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify(OUT.json, null, 2) + '\n');
      return 3;
    }

    section(`热采 · 开始（主机 ${host}${o.dryRun ? ' · DRY-RUN' : ''}）`);
    log(`    热采器版本 ${HOT_COLLECT_VERSION}；阈值 仓1 ${(VOLUME_THRESHOLDS['dsh-core'] / 1048576).toFixed(0)}MB / 仓3 ${(VOLUME_THRESHOLDS['dsh-workspace'] / 1048576).toFixed(0)}MB`);
    // ── 仓退役口径（2026-10-27 · 卡「批1停热采」1-2 / 1-1 / 1-4）────────────────────
    // 为什么在 CLI 打这三行：`hot` 的输出是运维/日报/主人判断"它还对不对"的唯一入口。
    //   不加这段的话，**停采仓1 的表现就是"仓1 那几行不见了"** —— 与"清单坏了 / 路径错了"长得一模一样。
    //   真源 = `lib/hot-collect.mjs` 的 COLLECT_REPO1 / COLLECT_REPO3 / SKIP_REPO2（改那里，别改这里）。
    section('仓退役口径（2026-10-27）');
    log(`    仓1 dsh-core：${COLLECT_REPO1 ? '✅ 采集' : '⏸ 停采（仓退役 · 配置整包改走冷盘；账本导出连带停）'}`);
    log(`    仓2 dsh-sessions：${SKIP_REPO2 ? '⛔ 永不采集（SKIP_REPO2 代码层硬守卫，与 --skip-sessions 参数无关）' : '… 按参数/开关'}`);
    log(`    仓3 dsh-workspace：${COLLECT_REPO3 ? '✅ 采集（1-4 实测：text-sync 覆盖不足 ⇒ 保持不停采）' : '⏸ 停采'}`);
    log(`    口径：${REPO_RETIRE_NOTE}`);

    const res = await collectHot({
      dshRoot: DSH_ROOT, gitBackup: GIT_BACKUP, gitBackupExplicit: GIT_BACKUP_EXPLICIT, host,
      dryRun: o.dryRun, skipSessions: o.skipSessions, skipLedger: o.skipLedger,
      maxSessions: o.limit ?? 400, push: o.noPush ? false : true,
      allowDivergence: o.allowDivergence,
      pullFirst: o.noPullFirst ? false : true,
      warnOnCap: o.limit === null,   // 显式 --limit 是用户主动限量：不当异常告警
    });

    section(`热采 · 结果 result=${res.result}（${res.durationMs ?? '-'}ms）`);
    // skipped = 备份根未配置（干净机器上的正常态，不是故障）⇒ 必须说清楚，别让人以为是"跑了但没采到"。
    if (res.result === 'skipped') {
      log(`    本轮跳过（${res.skippedReason ?? '未配置'}）：不是故障，未采集任何文件 —— 该设哪个变量见下面 info 行`);
    }
    if (res.gates?.enabled) {
      log(`    推前安全门：${res.gates.allowDivergence ? '⚠️ 已用 --allow-divergence 跳过' : '开启'}（分支 ${res.gates.branch}）`);
      for (const [repo, g] of Object.entries(res.gates.preCollect ?? {})) log(`      · 采集前 ${repo}: ${g.safe ? '🟢 ' + (g.basis ?? 'safe') : `${g.hard ? '🔴' : '🟡'} ${g.code}`} — ${g.reason}`);
      // pull-first（S-14）：常态（not-behind）不刷屏，只在真快进/快进失败/落后但没快进时打一行
      for (const [repo, pf] of Object.entries(res.gates.pullFirst ?? {})) {
        if (!pf || pf.action === 'not-behind') continue;
        const txt = pf.action === 'advanced' ? `已快进 ${String(pf.headAfter).slice(0, 8)}`
          : pf.action === 'would-advance' ? 'dry-run：真跑会先快进'
            : pf.action === 'advance-failed' ? `快进失败（${pf.error ?? '-'}）` : '不快进';
        log(`      · pull-first ${repo}: ${txt}（${pf.reason}）${pf.rejudged ? ' → 门已快进后复判' : ''}`);
      }
      for (const [repo, g] of Object.entries(res.gates.prePush ?? {})) log(`      · 推送前 ${repo}: ${g.safe ? '🟢 ' + (g.basis ?? 'safe') : `${g.hard ? '🔴' : '🟡'} ${g.code}`} — ${g.reason}`);
      for (const b of res.gates.blocked ?? []) {
        for (const c of (b.foreignCommits ?? [])) log(`        ↳ 外来提交 ${String(c.sha).slice(0, 8)} ${String(c.subject).slice(0, 90)}`);
        for (const f of (b.contentFiles ?? [])) log(`        ↳ 工作副本独有 ${f}`);
      }
    }
    log(`    小文件：复制 ${res.files.copied} / 未变 ${res.files.unchanged} / 跳过 ${res.files.skipped.length}`);
    const skipReasons = {};
    for (const s of res.files.skipped) skipReasons[s.reason] = (skipReasons[s.reason] ?? 0) + 1;
    for (const [r, n] of Object.entries(skipReasons)) log(`      · ${r}: ${n}`);
    log(`    会话：闭合 ${res.sessions.closed} / 搬运 ${res.sessions.moved} / 未闭合跳过 ${res.sessions.openSkipped} / 其它跳过 ${res.sessions.skipped}`);
    const lg = res.ledger;
    // 档 C（2026-10-13）：被节流时 ok=true 但**没导出**（无 revision）⇒ 单独一行，别让它显示成"导出 ok（revision undefined）"
    log(`    账本：${lg?.skipped === 'throttled'
      ? `本轮未到点 → 不导出（节流 ${(Number(lg.intervalMs) / 3600000).toFixed(1)}h，上次导出 ${new Date(Number(lg.lastAt)).toISOString()}）`
      : (lg?.ok
        ? `Host API 导出 ok（revision ${lg.revision}，${lg.changed ? '有变化' : '语义未变 → 零写入'}）`
        : `跳过（${lg?.reason ?? '-'}）`)}`);
    for (const v of res.volumes) log(`    体积 ${v.repo}: ${(v.sizeBytes / 1048576).toFixed(1)}MB / ${v.files} 文件${v.overThreshold ? '  ⚠️ 超阈值' : ''}`);
    for (const [n, c] of Object.entries(res.commits)) log(`    commit ${n}: ${c.committed ? '已提交' : (c.reason ?? '无变化')}${c.ok ? '' : ' ✗ ' + (c.error ?? '')}`);
    for (const [n, p] of Object.entries(res.pushed ?? {})) log(`    push   ${n}: ${p.ok ? (p.dryRun ? '（dry-run 不推送）' : (p.skipped ? '无需推送' : '已推送')) : (p.blocked ? `⛔ 安全门拦截（${p.code}）：${p.reason ?? ''}` : '✗ ' + (p.error ?? ''))}`);
    for (const a of res.alerts) log(`    ${a.level === 'info' ? '·' : '!!'} [${a.level}] ${a.code}: ${a.message}`);
    for (const d of res.deferred) log(`    … deferred: ${d}`);

    // 2) 状态 + 心跳（§5.3 第 6 条：任一成功 push 更新 lastHeartbeatAt）
    if (!o.dryRun) {
      const anyPushed = Object.values(res.pushed ?? {}).some((p) => p.ok && !p.skipped);
      const finishedAt = new Date().toISOString();
      updateStateJson(STATE_NAME, stateFileOf(STATE_NAME, dshHome()), (cur) => ({
        ...(cur ?? {}),
        schemaVersion: 1, host,
        updatedAt: finishedAt,
        lastResult: res.result,
        lastStartedAt: res.startedAt,
        lastDurationMs: res.durationMs,
        files: { copied: res.files.copied, unchanged: res.files.unchanged, skipped: res.files.skipped.slice(0, 100) },
        sessions: res.sessions,
        repoRetire: res.repoRetire ?? null,   // 2026-10-27 仓退役口径（CLI/日报/面板可读）
        ledger: res.ledger,
        volumes: res.volumes,
        alerts: res.alerts.slice(0, 50),
        deferred: res.deferred.slice(0, 50),
      }), { schemaVersion: 1, defaultValue: {} });

      // 本机交接单心跳（保留原记录其余字段；无记录则不动 —— 由 Depart/Arrive 建单）
      const hoFile = resolveStatePath('butler-handoff.json', { home: dshHome() }).path;
      const prevRec = readJson(hoFile, { defaultValue: null });
      if (prevRec && anyPushed) {
        updateStateJson('butler-handoff.json', hoFile, () => ({ ...prevRec, lastHeartbeatAt: finishedAt }), { schemaVersion: 1, defaultValue: null });
      }
      appendAudit({
        type: 'handoff-hot', host, result: res.result, copied: res.files.copied, sessionsMoved: res.sessions.moved,
        ledgerRevision: res.ledger?.revision ?? null, deferred: res.deferred.length, heartbeat: anyPushed ? finishedAt : null,
        gates: res.gates ? {
          blocked: res.gates.blocked.map((b) => `${b.stage}:${b.repo}:${b.code}`),
          repos: res.gates.blockedRepos,
          allowDivergence: res.gates.allowDivergence,
        } : null,
      });

      // 推前安全门命中 → 写独立告警通道（butler-alert.log：面板/日报/守夜可见，不依赖 stdout）
      for (const b of res.gates?.blocked ?? []) {
        try {
          alert({
            level: b.hard === false ? 'warn' : 'error',
            source: 'butler-hot-collect',
            message: `推前安全门：${b.stage} ${b.repo} 被拦（${b.code}）— ${b.reason}`,
            detail: {
              repo: b.repo, stage: b.stage, code: b.code,
              foreignCommits: (b.foreignCommits ?? []).slice(0, 5),
              contentFiles: (b.contentFiles ?? []).slice(0, 5),
            },
          }, { silent: true });
        } catch { /* 告警通道自身故障不影响热采结论 */ }
      }
    }

    OUT.json = { hot: res, version: HOT_COLLECT_VERSION };
    if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify(OUT.json, null, 2) + '\n');
    // skipped（= 备份根未配置）算**正常结束**：干净机器上「本机没开这个功能」不该以 1 退出（卡 B15）。
    if (res.result === 'skipped') return 0;
    return res.result === 'ok' || res.result === 'dry-run' ? 0 : (res.result === 'deferred' || res.result === 'blocked' ? 3 : 1);
  } finally {
    if (lock && typeof lock.release === 'function') lock.release();
  }
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
    process.stderr.write(`\n❌ 热采异常：${e?.stack ?? e}\n`);
    process.exitCode = 1;
  }
}

export { exportLedgerSnapshot };
