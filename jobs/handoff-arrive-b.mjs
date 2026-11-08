#!/usr/bin/env node
/**
 * handoff-arrive-b.mjs —— Arrive-B：接机后「对端看板快照 → 本机账本」并回自动化（P9 §5.1）
 *
 * 为什么需要它（2026-09-17 主人问「交接是不是只用开关机脚本」时查实）：
 *   〔订正注 · 2026-10-28〕**以下 5 行是历史口径**（保留原文：它记的是当时的判据链，不是现在的实况）。
 *   入站四件事里 A6 分发 / A5 会话落地 / A5b 坑库+记忆库合并都已在开机链（Arrive-A）自动跑，
 *   **唯独看板账本并回没有** —— 因为账本走 Host HTTP API，必须在 DSH **起来之后**跑，
 *   而 Arrive-A 的插入点在 `guard-ctl start` 之前（DSH 未起）。
 *   本脚本 = Arrive-B：常驻 tickd job（DSH 在线后）自动「找对端最新快照 → 干跑 → 无冲突就并回、
 *   有冲突只报告」。补上这一环后，接机不再需要任何人记得手跑 board-merge。
 *
 *   🔴 2026-10-28 现查实况（与上面历史口径不同，**排障以本段为准**）：
 *     · **开机链里没有 Arrive 钩子挂载**（关机链同理没有 Depart 挂载，现查实测）⇒「A6/A5/A5b 已在开机链
 *       自动跑」这句对当前开机链**不成立**；这套 Arrive 机制**只有人工入口**
 *       （`node handoff-arrive-b.mjs --apply`）。
 *     · 本件对应的 tickd job `arrive-b` **已关**（enabled:false，why=拆仓库钩子 20261028），同日六个私有
 *       Gitee 仓全部删除 ⇒ 下文「找对端最新快照」不再有自动跑的一方。
 *     · 替代件 = `board-handoff-merge.mjs`（**尚未落地**），方案见
 *       `docs\方案-账本并回信号与换机一条命令-20261028.md`。
 *     真源：`docs\交付报告-拆仓库钩子方案过审-20261028.md` §6.1 #11。
 *
 * 用法：
 *   node handoff-arrive-b.mjs [--dry-run] [--json] [--port 3080] [--force] [--status]
 *                            [--report-only | --apply]     # 运行档位（单轮覆盖，不写回档位文件）
 *                            [--snapshot <快照.json>]   # 显式指定快照（测试/复核用）
 *
 * 运行档位（H4b · 2026-09-21）：**放行可分级**——「跑不跑」由 job 开关管，「跑起来多强」由档位管。
 *   · 全功能（默认）：干跑干净 → apply（H4a 既有行为）；
 *   · **只报告**：走完门序、干跑、写日志与报告，但**永不 apply**（账本零写入）。
 *   优先级（照 A6b `resolveAdoptMode` 惯例）：`--report-only`/`--apply` > 环境变量 `ARRIVE_B_REPORT_ONLY`
 *   > 持久档位文件 `~/.dsh/butler-arrive-b-mode.json` 的 `mode` > 默认 `apply`。
 *   ⚠️ 单轮 CLI / 环境变量**绝不写回**档位文件。⚠️ 档位文件读不出 / 键非法 → fail-closed 按「只报告」。
 *   ⚠️ `--dry-run` 是**人工观测档**（不落幂等签名、每轮重跑），优先级高于档位；长期运行请用档位文件。
 *
 * 默认会真 apply（无保守冲突时）；`--dry-run` = 只干跑不写账本（人工观测/验收用）。
 *
 * 退出码（照方案 §3.2）：
 *   0 完成（含「无差异」「已处理过」「有保守冲突仅报告」—— 冲突是**人工待核的正常结论**，不是失败）
 *   3 让路（Host 不在 / 双开嫌疑 / 无对端快照 / 交接锁被占）→ tickd 声明 benignExitCodes:[3]，不计 failures
 *   1 真失败（board-merge 真失败 / apply 失败 / apply 后复核不干净 / 脚本自身异常）
 *
 * 环境变量（沙箱与跨机用；生产一律走默认值）：
 *   DSH_ROOT                    生产根（默认 <workspace>）—— board-snapshots / logs / docs / _archive 的基准
 *   BUTLER_DSH_HOME / DSH_HOME  状态根（默认 ~/.dsh）—— 状态文件与档位文件落点
 *   ARRIVE_B_REPORT_ONLY        运行档位（1/true/report = 只报告；0/false/apply = 全功能；空 = 不表态）
 *   ARRIVE_B_MODE_FILE          档位文件路径覆盖（沙箱用；默认 <DSH_HOME>/butler-arrive-b-mode.json）
 *   ARRIVE_B_GIT_BACKUP         仓3 工作副本根（默认 <offsync>\git-backup）
 *   ARRIVE_B_BOARD_MERGE        board-merge.mjs 路径（沙箱可换成假件）
 *   ARRIVE_B_ATTACH_AUDIT       attachments-audit.mjs 路径
 *   ARRIVE_B_LOG_DIR / ARRIVE_B_REPORT_DIR   日志 / 报告落点
 *   ARRIVE_B_TEMP_HANDOFF       Arrive-A/Depart 钩子日志目录（默认 <tmp>\dsh-handoff）
 *   DSH_PORT                    端口（--port 优先）
 *
 * 红线（本卡拍板，违反即打回）：
 *   · 不碰 dsh-start.ps1 / dsh-shutdown.ps1（落点就是 tickd job，不动启动链）
 *   · 绝不手改 ledger-v2.json —— 一律经 board-merge.mjs 走 Host HTTP API
 *   · 不改 board-merge / merge-memory / merge-pitfalls 的合并语义（只调用）
 *   · 双开嫌疑 fail-closed（对端心跳新鲜 → 不写生产，只报告）
 *   · 本脚本默认关：job 开关 false；放行用 butler-autonomy-cli.mjs job on arrive-b（不改代码）
 *
 * 判据层在 `lib/arrive-b.mjs`（纯函数、零 IO）——本文件只做 IO / spawn / 落盘。
 */
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import { gitBackupRoot } from './lib/ws-root.mjs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ARRIVE_B_VERSION, ARRIVE_B_SCHEMA, ARRIVE_B_STATE_NAME, ARRIVE_B_DEFAULTS,
  ARRIVE_B_MODE_NAME, resolveArriveBMode,
  parseSnapshotName, pickPeerSnapshot, snapshotKey, hasSeen, judgeDualOpen,
  decide, judgeAfterApply, summarizeMergeReport, nextState, emptyState, renderRunSection,
} from './lib/arrive-b.mjs';
import { acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { writeJsonAtomic } from '../src/dsh-butler/lib/store.mjs';
import { appendAudit } from '../src/dsh-butler/lib/audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DSH_ROOT = process.env.DSH_ROOT || workspaceRoot();
const GIT_BACKUP = process.env.ARRIVE_B_GIT_BACKUP || gitBackupRoot();
const LOG_DIR = process.env.ARRIVE_B_LOG_DIR || path.join(DSH_ROOT, 'logs', 'handoff');
const REPORT_DIR = process.env.ARRIVE_B_REPORT_DIR || path.join(DSH_ROOT, 'docs', '管家报告');
const BOARD_MERGE = process.env.ARRIVE_B_BOARD_MERGE || path.join(DSH_ROOT, 'tools', 'board-merge.mjs');
const ATTACH_AUDIT = process.env.ARRIVE_B_ATTACH_AUDIT || path.join(DSH_ROOT, 'tools', 'attachments-audit.mjs');
const TEMP_HANDOFF = process.env.ARRIVE_B_TEMP_HANDOFF || path.join(os.tmpdir(), 'dsh-handoff');
/** 交接锁 TTL：本 job 最长正常执行 = 1 次 dry-run + 1 次 apply + 复核（秒级~分钟级，账本 2.4MB）。 */
const LOCK_TTL_MS = 30 * 60 * 1000;
/** board-merge 单次调用的硬超时（账本大时慢，给足）。 */
const MERGE_TIMEOUT_MS = 15 * 60 * 1000;

/** 状态文件绝对路径（口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh，与 store.mjs 同源）。 */
function stateFile() {
  const home = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, ARRIVE_B_STATE_NAME);
}
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return (j && typeof j === 'object') ? j : null;
  } catch { return null; }
}
/** 档位文件绝对路径（H4b）：`ARRIVE_B_MODE_FILE`（沙箱）> <DSH_HOME>/butler-arrive-b-mode.json。 */
function modeFile() {
  if (process.env.ARRIVE_B_MODE_FILE) return process.env.ARRIVE_B_MODE_FILE;
  const home = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, ARRIVE_B_MODE_NAME);
}
/** 读档位文件原文（读不到 = null → 判据层按"文件不存在"回落默认；判据/校验全在纯函数里）。 */
function readModeFileRaw() {
  try { return fs.readFileSync(modeFile(), 'utf8'); } catch { return null; }
}
function selfHostName() {
  return String(process.env.COMPUTERNAME ?? os.hostname() ?? 'unknown').toLowerCase();
}
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* 已存在 */ } }
function logLine(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    ensureDir(LOG_DIR);
    fs.appendFileSync(path.join(LOG_DIR, `arrive-b-${dayKey()}.log`), line, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
  process.stdout.write(line);
}
function appendReport(section) {
  try {
    ensureDir(REPORT_DIR);
    const file = path.join(REPORT_DIR, `arrive-b-${dayKey()}.md`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# Arrive-B 看板账本并回日报（${dayKey()}）\n\n`
        + `> 由 tickd job \`arrive-b\` / CLI \`handoff-arrive-b.mjs\` 自动追加。`
          + `每段 = 一轮运行；「无对端快照 / 已处理过 / Host 不在线」这类空转不写段（见 \`<workspace>\\logs\\handoff\\arrive-b-<日期>.log\`）。\n\n`, 'utf8');
    }
    fs.appendFileSync(file, section, 'utf8');
    return file;
  } catch (e) {
    process.stderr.write(`⚠ 报告写入失败：${e?.message ?? e}\n`);
    return null;
  }
}

// ---------------------------------------------------------------- 只读探查

/** Host 是否在监听（门 1）。不依赖 HTTP，纯 TCP 探活（DSH 刚起未就绪时也能判）。 */
function probeHost(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolve({ ok, reason });
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true, 'listen'));
    sock.on('timeout', () => finish(false, 'timeout'));
    sock.on('error', (e) => finish(false, e?.code ?? String(e)));
  });
}

/** 扫候选目录（只读）。 */
function listSnapshotCandidates() {
  const dirs = [
    { kind: 'repo-workspace', dir: path.join(GIT_BACKUP, 'dsh-workspace', 'tools', 'board-snapshots') },
    { kind: 'prod', dir: path.join(DSH_ROOT, 'tools', 'board-snapshots') },
  ];
  const out = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d.dir).filter((f) => f.toLowerCase().endsWith('.json')); } catch { continue; }
    for (const f of names) {
      try {
        const st = fs.statSync(path.join(d.dir, f));
        out.push({ kind: d.kind, dir: d.dir, file: path.join(d.dir, f), mtimeMs: st.mtimeMs });
      } catch { /* 单个文件不可读则跳过 */ }
    }
  }
  return out;
}

/** 读对端交接单（仓1 工作副本 `dsh/butler-handoff/*.json`，排除本机那份）——与 hot-collect 同口径。 */
function readPeerRecords(host) {
  const dir = path.join(GIT_BACKUP, 'dsh-core', 'dsh', 'butler-handoff');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')); } catch { return out; }
  for (const f of names) {
    const peerHost = f.replace(/\.json$/i, '');
    if (peerHost.toLowerCase() === host) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (rec && typeof rec === 'object') out.push({ host: peerHost, record: rec });
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** 读快照头部字段（kind / sourceRevision / fromHost）——只读，best-effort。 */
function readSnapshotMeta(file) {
  try {
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!spec || spec.kind !== 'task-board-merge-snapshot' || !Array.isArray(spec.tasks)) {
      return { ok: false, reason: `不是有效的并回快照（kind=${spec?.kind ?? 'null'} / tasks 非数组）` };
    }
    return {
      ok: true,
      kind: spec.kind,
      revision: spec.sourceRevision ?? spec.revision ?? null,
      fromHost: spec.fromHost ?? null,
      exportedAt: spec.exportedAt ?? null,
      taskCount: Array.isArray(spec.tasks) ? spec.tasks.length : null,
    };
  } catch (e) {
    return { ok: false, reason: `快照不可读：${e?.message ?? e}` };
  }
}

// ---------------------------------------------------------------- 调用既有件

/** 跑 board-merge（走 Host API；本脚本只读它的退出码与产物）。 */
function runBoardMerge({ snapshot, apply, port }) {
  const args = [BOARD_MERGE, '--snapshot', snapshot, '--port', String(port)];
  args.push(apply ? '--apply' : '--dry-run');
  const r = spawnSync(process.execPath, args, {
    cwd: path.dirname(BOARD_MERGE), encoding: 'utf8', windowsHide: true,
    timeout: MERGE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DSH_ROOT },
  });
  return {
    rc: Number.isFinite(r.status) ? r.status : -1,
    stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''),
    error: r.error ? String(r.error.message ?? r.error) : null,
  };
}

/** 取最新一份 board-merge dry-run 报告 JSON（best-effort：只用于铺明细，判据以 rc 为准）。 */
function readLatestDryRunReport(notBeforeMs) {
  const base = path.join(DSH_ROOT, '_archive');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base)
      .filter((n) => n.startsWith('board-merge-dryrun-'))
      .map((n) => ({ n, m: fs.statSync(path.join(base, n)).mtimeMs }))
      .filter((x) => x.m >= notBeforeMs)
      .sort((a, b) => b.m - a.m);
  } catch { return null; }
  if (!dirs.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(base, dirs[0].n, 'merge-report.json'), 'utf8')); } catch { return null; }
}

/** apply 的账本备份目录（从 stdout 抓；抓不到不影响结论）。 */
function parseBackupDir(stdout) {
  const m = String(stdout ?? '').match(/已备份账本\s*→\s*(.+?)(?:（|$)/m);
  return m ? m[1].trim() : null;
}

/** 附件对账（只读、只报告，不自动取；方案 §4）。 */
function runAttachAudit() {
  if (!fs.existsSync(ATTACH_AUDIT)) return { checked: false, reason: '脚本不存在' };
  try {
    const r = spawnSync(process.execPath, [ATTACH_AUDIT], {
      encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, DSH_ROOT },
    });
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const m = text.match(/缺失对象\s*(\d+)/);
    const s = text.match(/受影响会话\s*(\d+)/);
    return {
      checked: true, rc: Number.isFinite(r.status) ? r.status : -1,
      missing: m ? Number(m[1]) : null, sessions: s ? Number(s[1]) : null,
    };
  } catch (e) {
    return { checked: false, reason: String(e?.message ?? e) };
  }
}

/**
 * 把 Arrive-A/Depart 钩子日志（`<tmp>\dsh-handoff\*.log`）**复制**一份到持久目录。
 * 治「失败静默」：该目录实测 0 个文件 = 钩子日志没留住；只读复制，不改任何 .ps1。
 */
function archiveHookLogs() {
  const copied = [];
  const skipped = [];
  let names = [];
  try { names = fs.readdirSync(TEMP_HANDOFF).filter((f) => f.toLowerCase().endsWith('.log')); } catch { return { copied, skipped, tempDir: TEMP_HANDOFF }; }
  for (const f of names) {
    const src = path.join(TEMP_HANDOFF, f);
    const dst = path.join(LOG_DIR, `hook-${f}`);
    try {
      const s = fs.statSync(src);
      if (fs.existsSync(dst) && fs.statSync(dst).size === s.size) { skipped.push(f); continue; }
      ensureDir(LOG_DIR);
      fs.copyFileSync(src, dst);
      copied.push(f);
    } catch { skipped.push(f); }
  }
  return { copied, skipped, tempDir: TEMP_HANDOFF };
}

// ---------------------------------------------------------------- 参数

const USAGE = [
  'handoff-arrive-b.mjs —— 接机后看板账本并回（Arrive-B）',
  '',
  '用法： node handoff-arrive-b.mjs [--dry-run] [--report-only|--apply] [--json] [--port 3080] [--force] [--status] [--snapshot <file>]',
  '  --dry-run      只干跑，不写生产账本（人工观测/验收；不落幂等签名 → 每轮都重跑）',
  '  --report-only  运行档位=只报告：走完门序、干跑出结论、写日志与报告，但**永不 apply**（长期运行档）',
  '  --apply        运行档位=全功能（覆盖持久档位文件；默认档位即 apply）',
  '  --force        忽略幂等门（同一快照重放一次）',
  '  --status       只打印状态文件与当前档位，不做任何事',
  '  --json         末尾输出单行 JSON 结论',
  '  --snapshot     显式指定快照（跳过自动选快照）',
  '',
  '档位优先级：--report-only/--apply > 环境变量 ARRIVE_B_REPORT_ONLY > 档位文件 <DSH_HOME>/ 下的到达档位文件'
    + '（{"mode":"report"}） > 默认 apply。单轮 CLI/环境变量不写回档位文件。',
  '退出码：0 完成（含无差异 / 已处理过 / 有冲突仅报告 / 只报告档干净干跑）· 3 让路（benign）· 1 真失败',
].join('\n');

function parseArgs(argv) {
  const o = { dryRun: false, json: false, force: false, status: false, snapshot: null, port: null, help: false, unknown: null,
    modeFlag: null };   // H4b：单轮档位覆盖（'report'|'apply'|null=跟随 env/档位文件/默认）
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--force') o.force = true;
    else if (a === '--status') o.status = true;
    else if (a === '--report-only') o.modeFlag = 'report';
    else if (a === '--apply') o.modeFlag = 'apply';
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--snapshot') o.snapshot = argv[++i] ?? null;
    else if (a === '--port') o.port = argv[++i] ?? null;
    else o.unknown = a;
  }
  return o;
}

// ---------------------------------------------------------------- 主流程

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (o.unknown) { process.stderr.write(`❌ 未知参数：${o.unknown}\n\n${USAGE}\n`); return 2; }

  const host = selfHostName();
  const port = Number(o.port ?? process.env.DSH_PORT ?? 3080);

  // H4b · 运行档位：单轮 CLI > 环境变量 > 档位文件 > 默认（判据与校验全在纯函数 resolveArriveBMode）
  const modeRes = resolveArriveBMode({
    cliFlag: o.modeFlag,
    envFlag: process.env.ARRIVE_B_REPORT_ONLY ?? null,
    fileRaw: readModeFileRaw(),
  });
  // ⚠️ `--dry-run` **优先于档位**：它是人工观测档（不落幂等签名、每轮重跑），语义已定，
  //    不能被档位文件改写成"长期档"；反过来档位也拦不住 --dry-run（它本来就不写账本）。
  const effMode = o.dryRun ? 'apply' : modeRes.mode;
  const modeInfo = { mode: modeRes.mode, source: modeRes.source, effective: effMode, dryRun: o.dryRun === true, file: modeFile() };

  if (o.status) {
    const st = readState();
    const out = st ?? emptyState(host);
    process.stdout.write(`arrive-b v${ARRIVE_B_VERSION} · 设备 ${host} · 状态文件 ${stateFile()}\n`);
    process.stdout.write(`  运行档位 ${modeRes.mode === 'report' ? '只报告（永不 apply）' : '全功能（可 apply）'}（来源 ${modeRes.source}）`
      + ` · 本轮生效 ${effMode === 'report' ? '只报告' : (o.dryRun ? '干跑（--dry-run）' : '全功能')}\n`);
    process.stdout.write(`  档位文件 ${modeFile()}${fs.existsSync(modeFile()) ? '' : '（不存在 → 走上一级默认）'}\n`);
    process.stdout.write(`  上次结果 ${out.lastResult ?? '-'}（${out.lastCode ?? '-'}）· 运行 ${out.stats?.runs ?? 0} 次 · `
      + `apply ${out.stats?.applied ?? 0} / 冲突 ${out.stats?.conflicts ?? 0} / 只报告 ${out.stats?.reportOnly ?? 0} / `
      + `让路 ${out.stats?.yielded ?? 0} / 失败 ${out.stats?.failed ?? 0}\n`);
    if (out.lastSnapshot) process.stdout.write(`  上次快照 ${out.lastSnapshot.file ?? '-'}（对端 ${out.lastSnapshot.fromHost ?? '-'} · rev ${out.lastSnapshot.revision ?? '-'}）\n`);
    for (const a of (out.alerts ?? []).slice(-5)) process.stdout.write(`  [${a.level}] ${a.code}：${a.message}\n`);
    if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  const startedAt = new Date().toISOString();
  const state0 = readState();
  const entry = { at: startedAt, action: null, code: null, message: null, snapshot: null, key: null, dual: null, merge: null, alerts: [], mode: modeInfo };
  const jsonOut = { version: ARRIVE_B_VERSION, host, at: startedAt, dryRun: o.dryRun, mode: modeInfo };

  // 0) 先把钩子日志捞进持久目录（不需要 Host，任何一轮都做；治「失败静默」）
  const hookLogs = archiveHookLogs();
  jsonOut.hookLogs = { copied: hookLogs.copied.length, skipped: hookLogs.skipped.length };

  // 1) 单例锁（与 hot / depart 共用 `handoff` 锁：都读写仓工作副本；tickd 侧走继承虚拟锁）
  const lock = acquireTickLock('handoff', { ttlMs: LOCK_TTL_MS });
  const finish = (rc, action, code, message, extra = {}) => {
    entry.action = action; entry.code = code; entry.message = message;
    entry.hookLogs = hookLogs;
    Object.assign(entry, extra);
    const next = nextState(state0, {
      host, at: new Date().toISOString(), startedAt,
      action, code, message,
      snapshot: entry.snapshot, key: entry.key,
      markSeen: extra.markSeen === true, alert: extra.alertForState ?? null,
    });
    try { writeJsonAtomic(stateFile(), next); } catch (e) { process.stderr.write(`⚠ 状态写入失败：${e?.message ?? e}\n`); }
    logLine(`result=${action} code=${code} :: ${message}`);
    const shouldReport = ['applied', 'report', 'fail', 'noop'].includes(action) || (entry.alerts?.length > 0);
    if (shouldReport) {
      const f = appendReport(renderRunSection(entry));
      if (f) jsonOut.reportFile = f;
    }
    try {
      appendAudit({ type: 'handoff-arrive-b', host, result: action === 'fail' ? 'fail' : (action === 'applied' ? 'ok' : action),
        code, snapshot: entry.key, dryRun: o.dryRun === true, message });
    } catch { /* 审计失败不影响 */ }
    jsonOut.result = { action, code, message, exit: rc };
    if (o.json) process.stdout.write('\n---JSON---\n' + JSON.stringify(jsonOut, null, 2) + '\n');
    return rc;
  };

  if (!lock.ok) {
    entry.alerts.push({ level: 'info', code: 'lock-busy', message: `交接锁被占（${lock.reason}）→ 本轮让路` });
    return finish(3, 'yield', 'lock-busy', `交接锁被占（${lock.reason}）→ 本轮让路（不并发，§5.3 R12）`);
  }

  try {
    // 门1 环境门：
    const hostProbe = await probeHost(port);
    jsonOut.hostOnline = hostProbe.ok;

    // 门2 双开门（只在 Host 在线时才需要——离线本来就不写）
    const dual = hostProbe.ok ? judgeDualOpen({ peerRecords: readPeerRecords(host) }) : { suspected: false, reason: 'host 不在线，未判', checked: 0 };
    entry.dual = dual;

    // 门3 输入门
    let snapPick;
    if (o.snapshot) {
      const p = parseSnapshotName(o.snapshot);
      snapPick = {
        ok: fs.existsSync(o.snapshot),
        picked: fs.existsSync(o.snapshot)
          ? { kind: 'explicit', dir: path.dirname(o.snapshot), file: o.snapshot, mtimeMs: 0, host: p?.host ?? null, stamp: p?.stamp ?? null, label: p?.label ?? null }
          : null,
        reason: fs.existsSync(o.snapshot) ? `显式指定：${o.snapshot}` : `显式指定的快照不存在：${o.snapshot}`,
        considered: [], rejected: [],
      };
    } else {
      snapPick = pickPeerSnapshot({ candidates: listSnapshotCandidates(), selfHost: host });
    }

    let seen = false;
    let key = null;
    let meta = null;
    if (snapPick.ok) {
      meta = readSnapshotMeta(snapPick.picked.file);
      if (!meta.ok) {
        entry.alerts.push({ level: 'warn', code: 'bad-snapshot', message: `快照不可用：${meta.reason}` });
      } else {
        key = snapshotKey({ file: snapPick.picked.file, revision: meta.revision });
        seen = hasSeen(state0?.seen, key);
        entry.snapshot = {
          file: path.basename(snapPick.picked.file), fromHost: meta.fromHost ?? snapPick.picked.host,
          revision: meta.revision, kind: snapPick.picked.kind, taskCount: meta.taskCount, exportedAt: meta.exportedAt,
        };
        entry.key = key;
      }
    }

    const d1 = decide({
      hostOnline: hostProbe.ok,
      dual,
      snapshot: meta?.ok ? { ok: true, reason: snapPick.reason, picked: snapPick.picked } : { ok: false, reason: meta?.reason ?? snapPick.reason },
      seen, force: o.force, mode: effMode,
    });
    jsonOut.decide1 = { action: d1.action, code: d1.code };
    if (d1.action !== 'apply') {
      if (d1.alert) entry.alerts.push(d1.alert);
      return finish(d1.rc, d1.action, d1.code, d1.message, {
        alertForState: d1.alert, alerts: entry.alerts, markSeen: d1.markSeen === true && Boolean(key),
      });
    }

    // 门5 干跑（board-merge --dry-run）
    const t0 = Date.now();
    const dry = runBoardMerge({ snapshot: snapPick.picked.file, apply: false, port });
    const dryReport = summarizeMergeReport(readLatestDryRunReport(t0 - 2000));
    entry.merge = dryReport;
    jsonOut.dryRunMerge = { rc: dry.rc, planTotal: dryReport?.planTotal ?? null, conflicts: dryReport?.conflicts ?? null };
    if (dry.rc !== 0 && dry.stderr) logLine(`     board-merge dry-run stderr：${dry.stderr.slice(0, 400).replace(/\s+/g, ' ')}`);

    const d2 = decide({
      hostOnline: true, dual, snapshot: { ok: true, picked: snapPick.picked }, seen, force: o.force, mode: effMode,
      dryRun: { rc: dry.rc, planTotal: dryReport?.planTotal ?? 0, conflicts: dryReport?.conflicts ?? 0, failures: dryReport?.failedLines?.length ?? 0 },
    });
    jsonOut.decide2 = { action: d2.action, code: d2.code };

    // 附件对账（走到这一步才做：Host 在、快照在、有新内容要处理；代价 ~2s）
    let attach = null;
    if (['apply', 'report', 'noop'].includes(d2.action)) {
      attach = runAttachAudit();
      entry.attachments = attach;
      if (attach.checked && attach.missing > 0) {
        entry.alerts.push({ level: 'warn', code: 'attachments-missing',
          message: `附件实体缺失 ${attach.missing} 个（${attach.sessions ?? '?'} 个会话受影响）→ 只对账不自动取（两机不同时在线，需带介质）` });
      }
    }

    if (d2.action !== 'apply') {
      if (d2.alert) entry.alerts.push(d2.alert);
      return finish(d2.rc, d2.action, d2.code, d2.message, {
        alertForState: d2.alert, alerts: entry.alerts, markSeen: d2.markSeen === true && Boolean(key),
      });
    }

    // --dry-run（人工观测）：到此为止，不写账本
    if (o.dryRun) {
      entry.alerts.push({ level: 'info', code: 'dry-run-only', message: '本轮为 --dry-run：干跑干净但**未 apply**（未写生产账本）' });
      return finish(0, 'noop', 'dry-run-only', `干跑干净（计划 ${dryReport?.planTotal ?? '?'} 项）但本轮为 --dry-run，未 apply`, {
        alerts: entry.alerts, markSeen: false,
      });
    }

    // 门6 apply（board-merge 自带账本备份 + 生成 restore.mjs）
    //
    // 【H4b · 双保险】只报告档**在判据层已经拦下**（decide 在 mode='report' 时把"干跑干净"返回成
    //   action='report'/code='report-only-clean' ⇒ 上面 `d2.action !== 'apply'` 分支已 return）。
    //   真走到这里 = 判据层的档位口径被改坏 ⇒ **绝不 apply**，按 🔴 失败报出来（fail-closed）。
    //   为什么不做成"静默 return"：那会让口径回归被藏进日志，只剩账本"看起来没被写"。
    if (effMode === 'report') {
      const guard = { level: 'alert', code: 'report-only-guard',
        message: '只报告档走到了 apply 分支（判据层档位口径异常）→ fail-closed 未写账本，请人工核 lib\\arrive-b.mjs#decide' };
      entry.alerts.push(guard);
      return finish(1, 'fail', 'report-only-guard', '只报告档命中第二道保险（判据层异常）→ 未 apply', {
        alertForState: guard, alerts: entry.alerts, markSeen: false,
      });
    }
    const app = runBoardMerge({ snapshot: snapPick.picked.file, apply: true, port });
    const backupDir = parseBackupDir(app.stdout);
    let appReport = null;
    if (backupDir) {
      try { appReport = summarizeMergeReport(JSON.parse(fs.readFileSync(path.join(backupDir, 'merge-report.json'), 'utf8'))); }
      catch { appReport = null; }   // 备份目录里没报告 → 用 dry-run 的计划数兜底
    }
    const planned = appReport ?? dryReport;
    if (backupDir) entry.merge = { ...(entry.merge ?? {}), backupDir };

    // 门7 复核（apply 后再干跑一次，应无差异/无冲突）
    let verify = { rc: null };
    if (app.rc === 0) {
      const t2 = Date.now();
      const v = runBoardMerge({ snapshot: snapPick.picked.file, apply: false, port });
      const vReport = summarizeMergeReport(readLatestDryRunReport(t2 - 2000));
      verify = { rc: v.rc, conflicts: vReport?.conflicts ?? null, planTotal: vReport?.planTotal ?? null };
    }

    const after = judgeAfterApply({ applyRc: app.rc, applyFailures: appReport?.failedLines?.length ?? 0, verifyRc: verify.rc, verifyConflicts: verify.conflicts });
    jsonOut.after = { action: after.action, code: after.code, verify };
    if (after.alert) entry.alerts.push(after.alert);
    if (after.action === 'applied') {
      entry.merge = { ...(planned ?? {}), backupDir: backupDir ?? planned?.backupDir ?? null };
      entry.alerts.push({ level: 'info', code: 'applied',
        message: `已并回：新建 ${planned?.create ?? '?'} / 更新 ${planned?.update ?? '?'}（来自 ${entry.snapshot?.fromHost ?? '?'}）` });
    }
    return finish(after.rc, after.action, after.code, after.message, {
      alertForState: after.alert, alerts: entry.alerts, markSeen: after.markSeen === true && Boolean(key),
    });
  } catch (e) {
    entry.alerts.push({ level: 'alert', code: 'exception', message: `脚本异常：${e?.message ?? e}` });
    return finish(1, 'fail', 'exception', `脚本异常：${e?.message ?? e}`, {
      alertForState: { level: 'alert', code: 'exception', message: String(e?.message ?? e) },
      alerts: entry.alerts,
    });
  }
}

// ---------------------------------------------------------------- 入口（junction 安全的 main 守卫）

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

export { main, probeHost, listSnapshotCandidates, readPeerRecords, archiveHookLogs, readSnapshotMeta, stateFile, modeFile, readModeFileRaw };

if (isMain) {
  // 收尾一律用 exitCode（自然退出）：Windows 上发过 spawn/网络 I/O 的脚本强退会概率性崩（libuv 断言）。
  main().then((rc) => { process.exitCode = Number.isFinite(rc) ? rc : 0; })
    .catch((e) => { process.stderr.write(`✖ Arrive-B 失败：${e?.stack ?? e}\n`); process.exitCode = 1; });
}
