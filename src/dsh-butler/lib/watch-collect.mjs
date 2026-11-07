// dsh-butler / lib/watch-collect.mjs —— P2 采集层（真实环境探测；每项独立 try/catch 降级）
//
// 方案：docs/ §4 P2（行 488-489）
//   轻量事件（每 tick 查，毫秒级）：计划任务结果码 / 守护鱼进程数 + 3080 监听 / key 文件 / 隧道进程
//   重量事件（30 分钟或 mtime 增量）：ledger / 归档状态 / 会话健康 / 结构健康 / 升级体检 / 盘余量
//
// 约定：每个采集段返回 { ok:boolean, ...data }，ok:false = 数据源不可用 → 判定层返回 null（不误报）。
// 任何采集函数都不抛错（tick 永不 reject），也不写任何状态文件。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { classifyTail } from './restart.mjs';
// ★ P9 H4（2026-09-28）：交接窗口单一真相（running / 抑制窗口）——判定全在 lib/handoff-window.mjs，
//   本文件只做 IO 采集。handoff-health 同样是纯函数（T5/T6 已落地的判定单一真相），此处只取它的 facts。
import { readHandoffRecord, judgeHandoffRun, judgeSessionSuppression, isSessionSuppressed, HANDOFF_SUPPRESS_MS } from './handoff-window.mjs';
import { judgeHandoffHealth, HEALTH_THRESHOLDS } from './handoff-health.mjs';
// ★ P0/P1 宿主适配层（2026-09-14 / 09-15）：主包事件名一律不在此处出现（R4）——族判定走适配层。
import { EV, isAssistantProduction, isTurnStart } from './host-adapter.mjs';
import { discoverSessionFiles, decodeZstdFrames, scanHome, deviceName } from './pitfall-scan.mjs';

export const WATCH_COLLECT_VERSION = '0.1.2';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ───────────────────────── 小护士安全模式面**显式排除**（G11 · 2026-09-21 P2-A 补）─────────────
// 【为什么要有这一段】方案 §7 V10 的验收（"watch 采集不把 nurse 的 home/端口判成异常（含 watch 侧单测）"）
//   此前**从未被断言过**：实测采集根**全部取自 `home`**（= `~/.dsh`；见 :244 ledger / :278 archive /
//   :598 profiles / :211 `%TEMP%\dsh-guard`），`~/.dsh-safe` 恰好不在采集面内 ⇒
//   今天的"不污染"是**采集面恰好没覆盖它**，不是被设计排除（`grep -rn 'dsh-safe' tools\dsh-butler`
//   仅命中 `lib\lane-gate.mjs` 自身路径口径 3 处 ⇒ 无排除代码、无单测）。
//   风险：一旦采集面扩到进程/端口级（`collectPreflightPorts` 已是 heavy 档），
//   3091 上跑着的 nurse 实例就可能被算成「异常实例 / 端口占用」，而**没有测试会先红**。
// ⇒ 本段把排除**写成代码 + 单测**（判据集中在这里，消费方一律调这些函数，别再各写各的字符串）。
/** 小护士安全 home（可被 `DSH_NURSE_SAFE_ROOT` 覆盖 —— 与 `nurse-orchestrate.mjs` / `lane-gate.mjs` 同口径）。 */
export const NURSE_SAFE_HOME_DEFAULT = path.join(os.homedir(), '.dsh-safe');
/** 小护士安全实例端口（写死排除；3090=测试实例 / 3092=金丝雀 / 3080=生产，都不在此列）。 */
export const NURSE_PORTS = Object.freeze([3091]);
/** 采集体检端口表（不含任何 NURSE_PORTS 项）。 */
export const PREFLIGHT_PORTS = Object.freeze([7897, 8199, 8188, 3081]);

/** 当前生效的护士安全根（显式参数 > DSH_NURSE_SAFE_ROOT > 默认 ~/.dsh-safe）。 */
export function nurseSafeHome(opts = {}) {
  const override = opts.safeHome ?? process.env.DSH_NURSE_SAFE_ROOT;
  return override ? path.resolve(String(override)) : NURSE_SAFE_HOME_DEFAULT;
}

/** 路径是否落在护士安全根内（用于"采集面不许把护士的 home 当生产"的判定；容错大小写与斜杠）。 */
export function isNursePath(p, opts = {}) {
  if (typeof p !== 'string' || !p) return false;
  const root = nurseSafeHome(opts).toLowerCase().replace(/[\\/]+$/, '');
  const abs = path.resolve(p).toLowerCase();
  return abs === root || abs.startsWith(root + path.sep) || abs.startsWith(root + '/');
}

/**
 * 进程是否属于小护士（安全实例 / 编排器 / 采集器 / 现场包日志）。
 * 判据（任一命中即算）：
 *   · 命令行含 `.dsh-safe`（DSH_HOME 虽在环境变量里，但 `--profile nurse` 与日志路径会留在命令行）；
 *   · 命令行含 `--profile nurse`（nurse-ctl 起的实例形态）；
 *   · 命令行含 `dsh-nurse\` / `nurse-*.mjs`（编排器 / 采集器 / 验收器）。
 * ⚠️ 只用于**排除**（把护士自己从"生产异常实例"候选里摘出去），不用于任何"判定它健康"的正向用途。
 */
export function isNurseProcess(cmd, opts = {}) {
  const s = String(cmd ?? '');
  if (!s) return false;
  if (opts.safeHomeDefault !== false && /[\\/]\.dsh-safe([\\/]|$)/i.test(s)) return true;
  if (opts.safeHome !== undefined && opts.safeHome && s.toLowerCase().includes(String(opts.safeHome).toLowerCase())) return true;
  if (/--profile\s+nurse\b/i.test(s)) return true;
  if (/[\\/]dsh-nurse[\\/]/i.test(s)) return true;
  if (/\bnurse-(ctl|orchestrate|verify)\.mjs\b/i.test(s)) return true;
  if (/\bcollect-case\.mjs\b/i.test(s) && /dsh-nurse/i.test(s)) return true;
  return false;
}

/** 从进程清单里剔除护士自身的进程（返回 { kept, excluded }；不修改入参）。 */
export function excludeNurseProcesses(processes = [], opts = {}) {
  const kept = [];
  const excluded = [];
  for (const p of processes) {
    if (isNurseProcess(p?.cmd, opts)) excluded.push(p);
    else kept.push(p);
  }
  return { kept, excluded };
}

// ─────────────────────── 守护鱼进程形态判定（小修·8 · 2026-09-23）───────────────────────
// 【为什么改】RED 事件 `guard-unhealthy` 的判据是 `processCount !== 1`（"双守护鱼会互相误杀"），
//   而 processCount 原由**命令行全文子串**正则 `/dsh-guard|guard\.mjs|guard-ctl/i` 数出来
//   ⇒ 三类**不是守护鱼**的进程被数成"第二只守护鱼"（本机 2026-09-23 实测：真守护鱼 1 只，却报 processCount=4）：
//     ① **guard-launcher**（`node -e "<launcherMain 源码>" … --pid-file …\Temp\dsh-guard\dsh-launcher-pid.json`）
//        —— 它的**参数**里含 `dsh-guard` 目录；它只是"给 dsh 一个隐藏控制台"的载体（见 guard-launcher.mjs），不是守卫。
//     ② **dsh runner**（`…\dsh-subprocess-local\lib\runner.js -- pwsh … -Command "…node …\guard.mjs…"`）
//        —— 它**承载的命令文本**里含 `guard.mjs`。
//     ③ 名字恰好含 `guard.mjs` 的诊断脚本（实测本卡取证脚本 `probe-guard.mjs` 也被算了进去）。
//   ⇒ 旧判据量的是"命令行里出现过这些字"，而不是"这个进程是不是守护鱼本体"。
// 【新判据】只看**入口脚本**：node 解释器之后第一个非选项参数（`node -e` / `--` 之后没有入口脚本）。
//   入口 basename 命中 `^(dsh-)?guard\.mjs$` ⇒ 守护鱼本体。
//   旧口径的「命令行里出现过这些字」被彻底弃用：**参数里提到 dsh-guard 目录**、
//   **名字里含 guard 的脚本**（`probe-guard.mjs` / `guard-switch.mjs` / …）一律不入选。
//   反向保证：**真·双守护鱼（两条 `node …\guard.mjs --state-dir …`）仍命中 2 条** ⇒ RED 判据能力不变（有单测断言）。
// 【候选 C 的取舍（2026-09-24 本卡复收紧）】前一轮曾用 `^(dsh-)?guard(-core|-ctl)?\.mjs$`（把
//   `guard-ctl.mjs` / `guard-core.mjs` 也算本体）。**为什么又收掉**——三条实证：
//     ① **与守护鱼自身口径不一致**：`guard.mjs:61` 的同类判据是 `RE_DIVIDER = /[\\/]guard\.mjs/`，
//        注释逐字写着「精确匹配 guard.mjs 路径（**guard-ctl.mjs 天然不中**）」；`findGuardProcs()`
//        （`:83`）同款 `-match 'guard\.mjs' -and -notmatch 'guard-ctl\.mjs'`。本采集面是它的观测面，
//        判据必须与本体口径同源，否则"什么算第二只守护鱼"会有两套答案。
//     ② `guard-ctl.mjs` 是**短命 CLI**（`stop/start/status/repair-status/repair-finish`，秒级退出），
//        不是常驻守卫 ⇒ 它运行的那一 tick 会被数成第二只 ⇒ 同族误报（与 launcher 误报同根）。
//     ③ `guard-core.mjs` 是**被 import 的纯状态机模块**（`guard.mjs:22` / `guard-ctl.mjs:17`），
//        正常不以入口形态常驻；单独跑它没有 main 逻辑、不会成为守卫。
//   取舍代价（如实记录）：若将来守护鱼改由**别的入口名**常驻（如拆分出第二个守卫进程），本判据会漏数
//     —— 但那种改动**必须同批改 `guard.mjs` 的 `findGuardProcs`/`RE_DIVIDER`**（否则守护鱼自己会互相误杀），
//     所以两侧天然同进同退；单测里有「入口名漂移即红」的锚（样例 `guard-ctl.mjs`/`guard-core.mjs` 断言不计）。
// 【已否决的候选】候选「命令行排除 launcher 特征（launcherMain / dsh-launcher-pid）」不治本（② ③ 照样误报，
//   且以后每个提到 guard 的脚本都要再加一条黑名单）；候选「用 guard-state.json 交叉验证 pid」**不可行**——
//   实测该文件只记 **dsh 的** pid（`lastPid`），不记守护鱼自己的 pid；且双守护鱼时它只写一个 ⇒ 会漏报真事故。
/** 守护鱼入口脚本 basename（只认本体 `guard.mjs` / `dsh-guard.mjs`；与 `guard.mjs:61` RE_DIVIDER 同口径）。 */
export const GUARD_ENTRY_RE = /^(dsh-)?guard\.mjs$/i;
/** guard-launcher 形态特征（`node -e "<launcherMain 源码>"`）。 */
export const GUARD_LAUNCHER_RE = /launcherMain|dsh-launcher-pid/i;
/** node 里"带一个值"的选项（解析入口脚本时需连值一起跳过；`--x=y` 写法以 `-` 开头天然被跳过）。 */
const NODE_OPTS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader',
  '--max-old-space-size', '--max-semi-space-size', '--stack-size', '--openssl-config', '--icu-data-dir',
  '--title', '--env-file', '--env-file-if-exists', '--conditions', '--inspect-port']);

/** 命令行分词（保留引号内空格；`\"` 视为转义引号；任何输入都返回数组、不抛错）。 */
export function splitCommandLine(cmd) {
  const s = String(cmd ?? '');
  const out = [];
  let cur = '';
  let inQuote = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '"') { cur += '"'; i++; started = true; continue; }
    if (c === '"') { inQuote = !inQuote; started = true; continue; }
    if (!inQuote && /\s/.test(c)) {
      if (started || cur) out.push(cur);
      cur = ''; started = false; continue;
    }
    cur += c; started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

/** node 的入口脚本路径；`node -e/--eval/-p/--print`（内联代码）或 `--` 之后无入口 ⇒ null。 */
export function nodeEntryScript(cmd) {
  const toks = splitCommandLine(cmd);
  const ni = toks.findIndex((t) => /(^|[\\/])node(\.exe)?$/i.test(t));
  if (ni < 0) return null;
  for (let i = ni + 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--') return null;                                                          // 之后全是程序参数
    if (t === '-e' || t === '-p' || t === '--eval' || t === '--print') return null;        // 内联代码
    if (t.startsWith('-')) { if (NODE_OPTS_WITH_VALUE.has(t)) i++; continue; }
    return t;
  }
  return null;
}

/** 单条命令行分类：{ kind: 'guard' | 'launcher' | null, entry, reason }。 */
export function classifyGuardProcess(cmd) {
  const s = String(cmd ?? '');
  const entry = nodeEntryScript(s);
  const base = entry ? path.basename(entry) : null;
  if (base && GUARD_ENTRY_RE.test(base)) return { kind: 'guard', entry, reason: `入口脚本 ${base}` };
  if (entry === null && s && GUARD_LAUNCHER_RE.test(s)) return { kind: 'launcher', entry: null, reason: 'node -e 内联 + launcher 特征' };
  return { kind: null, entry, reason: base ? `入口脚本 ${base} 非守护鱼` : '无 node 入口脚本' };
}

/** 从进程清单挑守护鱼本体（返回 { guards, launchers, mentions }；纯函数，不修改入参）。
 *  `mentions` = 命令行里提到过 guard 字样但本体不是守护鱼的进程（旧判据会误数，留作回归对照）。 */
export function pickGuardProcesses(processes = []) {
  const guards = [];
  const launchers = [];
  const mentions = [];
  for (const p of processes) {
    const c = classifyGuardProcess(p?.cmd);
    if (c.kind === 'guard') guards.push(p);
    else if (c.kind === 'launcher') launchers.push(p);
    else if (/dsh-guard|guard\.mjs|guard-ctl/i.test(String(p?.cmd ?? ''))) mentions.push(p);
  }
  return { guards, launchers, mentions };
}

/** 快照里的自证字段（"本轮采集面确实按设计排除了护士"；watch 报告 / 面板可读）。 */
export function nurseExclusions(opts = {}) {
  return {
    safeHome: nurseSafeHome(opts),
    ports: [...NURSE_PORTS],
    collectedRoot: path.resolve(opts.home ?? dshHome()),
    excluded: true,
    why: 'G11 观测隔离：小护士 home 与 3091 端口写死排除在采集面外（避免"修复窗口内护士实例被算成异常实例/端口占用"）',
  };
}

/** 被监控的计划任务（新增计划任务时在此登记）。 */
export const DEFAULT_TASKS = [
  'DSH-Butler-Daily',
  'DSH-Butler-Weekly',
  'DSH-Butler-RestartTick',
  'DSH-Butler-PitfallTick',
  'DSH-Butler-WatchFs',
  'DSH-Butler-WatchTick',
];

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

// ------------------------------------------------------------------ 基础探测

/** TCP 端口探测（无副作用，800ms 超时）。 */
export function probePort(port, opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? 800;
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const fin = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
  });
}

/** 进程列表（CIM 只查 node.exe / cloudflared.exe，避免全量 WMI 慢查询）。 */
export function listProcesses(opts = {}) {
  const shell = opts.shell ?? 'pwsh';
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cloudflared.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  try {
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: opts.timeoutMs ?? 12_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) return { ok: false, error: (r.stderr ?? '').slice(0, 200) || `exit ${r.status}` };
    let j = JSON.parse(r.stdout.trim() || '[]');
    if (!Array.isArray(j)) j = [j];
    return {
      ok: true,
      processes: j.map((p) => ({ pid: num(p.ProcessId), name: String(p.Name ?? ''), cmd: String(p.CommandLine ?? '') })),
    };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** 极简 CSV 解析（schtasks /fo CSV /v 用；支持引号转义）。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * 计划任务结果码（每 tick，轻量）。
 * ⚠️ 两个实测坑（2026-09-09）：
 *   ① `/fo CSV /v` 不转义字段内嵌引号（`wscript.exe "D:\..."`）→ 引号状态机错位、全表 exists:false；
 *   ② 从 Node spawnSync 调用时输出是**控制台代码页 GBK**（字段名 "任务名"/"上次结果"），
 *      而 pwsh 交互式调用显示英文 —— 必须 GBK 解码 + 中英文字段名双兼容。
 * 改用 `/fo LIST /v`：按空行分块 + 正则取字段。
 */
/**
 * 解析 schtasks /query /fo LIST /v 输出（纯函数，便于单测）。
 * ⚠️ 中文 Windows 下字段名也是中文（GBK 解码后）：
 *    任务名 / 模式 / 上次运行时间 / 上次结果 / 计划任务状态
 *    「模式」            = 英文版 Status（就绪 Ready / 正在运行 Running / 已禁用 Disabled）
 *    「计划任务状态」     = 英文版 Scheduled Task State（已启用 Enabled / 已禁用 Disabled）
 * 2026-09-10 实测坑（本卡）：原来只匹配 Status|状态 → 中文下 status 恒为 null，
 *   「任务被禁用」判定形同死代码（fixture 能过、生产拿不到值）。中英双字段名都要认。
 */
export function parseSchedulesText(text, names = DEFAULT_TASKS) {
  const RE = {
    name: /^(?:TaskName|任务名):\s*(.+)$/m,
    result: /^(?:Last Result|上次结果):\s*(-?\d+)\s*$/m,
    lastRun: /^(?:Last Run Time|上次运行时间):\s*(.+)$/m,
    nextRun: /^(?:Next Run Time|下次运行时间):\s*(.+)$/m,
    status: /^(?:Status|模式):\s*(.+)$/m,
    state: /^(?:Scheduled Task State|计划任务状态):\s*(.+)$/m,
  };
  const blocks = String(text ?? '').split(/\r?\n\r?\n+/);
  const found = new Map();
  for (const b of blocks) {
    const name = RE.name.exec(b)?.[1]?.trim();
    if (!name) continue;
    const short = name.replace(/^[\u005c]+/, '');
    if (!names.includes(short)) continue;
    const result = RE.result.exec(b)?.[1];
    found.set(short, {
      name: short,
      exists: true,
      lastResult: result === undefined ? null : Number(result),
      lastRunAt: parseSchTime(RE.lastRun.exec(b)?.[1]),
      nextRunAt: parseSchTime(RE.nextRun.exec(b)?.[1]),
      status: RE.status.exec(b)?.[1]?.trim() ?? null,   // 模式：就绪/正在运行/已禁用
      state: RE.state.exec(b)?.[1]?.trim() ?? null,     // 计划任务状态：已启用/已禁用
    });
  }
  return names.map((n) => found.get(n) ?? { name: n, exists: false, lastResult: null, lastRunAt: null, nextRunAt: null });
}

export function collectSchedules(opts = {}) {
  const names = opts.tasks ?? DEFAULT_TASKS;
  try {
    const r = spawnSync('schtasks', ['/query', '/fo', 'LIST', '/v'], {
      windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer',
    });
    if (r.status !== 0 || !r.stdout?.length) {
      return { ok: false, error: `schtasks exit ${r.status}`, tasks: [] };
    }
    return { ok: true, tasks: parseSchedulesText(decodeConsole(r.stdout), names) };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), tasks: [] };
  }
}

/** 控制台输出解码：中文 Windows 下 schtasks 是 GBK；TextDecoder 不支持时退 latin1。 */
export function decodeConsole(buf) {
  try {
    const t = new TextDecoder('gbk').decode(buf);
    if (t && !/\uFFFD/.test(t.slice(0, 2000))) return t;
  } catch { /* 无 gbk 支持 */ }
  return buf.toString('latin1');
}

/** schtasks 时间字符串 → epoch ms（解析失败返回 null）。 */
export function parseSchTime(v) {
  const s = String(v ?? '').trim();
  if (!s || /^N\/A$/i.test(s)) return null;
  // 形如 2026/9/9 23:00:00
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** 守护鱼 / dsh 存活（每 tick，轻量）。 */
export async function collectGuard(opts = {}) {
  const home = opts.home ?? dshHome();
  const out = { ok: false, port3080: null, processCount: null, pids: [], heartbeatAt: null, heartbeatAgeMs: null, phase: null };
  try {
    // 复用 tick 已取的进程列表（避免每 tick 调两次 CIM）
    const procs = Array.isArray(opts.processes) ? { ok: true, processes: opts.processes } : listProcesses(opts);
    if (procs.ok) {
      // 【G11】先把护士自身的进程摘出去（否则修复窗口内 3091 实例的 node 进程会进"生产进程面"）
      const split = excludeNurseProcesses(procs.processes, opts);
      // 【小修·8】守护鱼只认「入口脚本本体」（见上方判据段）：guard-launcher / dsh runner /
      //   名字含 guard 的诊断脚本都不再计入（旧正则实测把 1 只真守护鱼数成 4 ⇒ RED「双守护鱼」误报 11 次）。
      const picked = pickGuardProcesses(split.kept);
      const guards = picked.guards;
      out.processCount = guards.length;
      out.pids = guards.map((p) => p.pid);
      out.guardEntries = guards.map((p) => ({ pid: p.pid, entry: nodeEntryScript(p.cmd) }));
      out.launcherProcesses = picked.launchers.length;             // guard-launcher 载体：不参与判定，仅作证据
      if (picked.launchers.length) out.launcherPids = picked.launchers.map((p) => p.pid);
      out.ignoredGuardMentions = picked.mentions.length;           // 旧判据会误数、新判据不计的进程（回归对照）
      if (picked.mentions.length) out.ignoredGuardMentionPids = picked.mentions.map((p) => p.pid);
      out.processes = split.kept;
      out.nurseExcludedProcesses = split.excluded.length;
      if (split.excluded.length) out.nurseExcludedPids = split.excluded.map((p) => p.pid);
      out.ok = true;
    }
  } catch { /* ok 保持 false */ }
  try {
    out.port3080 = await probePort(3080, opts);
    out.ok = true;
  } catch { /* 保持 */ }
  try {
    const f = path.join(os.tmpdir(), 'dsh-guard', 'guard-state.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const at = Date.parse(String(j?.updatedAt ?? ''));
      if (Number.isFinite(at)) {
        out.heartbeatAt = at;
        out.heartbeatAgeMs = Math.max(0, (opts.now ?? Date.now()) - at);
        out.phase = j?.phase ?? null;
        out.downSince = j?.downSince ? Date.parse(String(j.downSince)) : null;
        out.downCount = num(j?.downCount);
        out.crashCount = num(j?.crashCount);
        out.ok = true;
      }
    }
    // 守护鱼日志 mtime（心跳只在状态变化时写，WATCH 静默期不更新 → 日志活跃度才是"还在干活"的判据）
    for (const n of ['guard2.log', 'guard.log']) {
      const lf = path.join(os.tmpdir(), 'dsh-guard', n);
      try {
        const st = fs.statSync(lf);
        if (out.logMtimeMs === undefined || st.mtimeMs > out.logMtimeMs) out.logMtimeMs = Math.round(st.mtimeMs);
      } catch { /* 日志不存在 */ }
    }
    if (out.logMtimeMs !== undefined) {
      out.logAgeMs = Math.max(0, (opts.now ?? Date.now()) - out.logMtimeMs);
      out.ok = true;
    }
  } catch { /* 心跳不可读不影响端口判定 */ }
  return out;
}

/** 看板 ledger（每 tick，读文件 ~200KB）。 */
export function collectLedger(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.ledgerFile ?? path.join(home, 'task-board', 'ledger-v2.json');
  try {
    const st = fs.statSync(file);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tasks = Array.isArray(j?.tasks) ? j.tasks : [];
    const recurringLow = [];
    for (const t of tasks) {
      if (!t || (t.kind ?? '') !== 'recurring') continue;
      const ex = (Array.isArray(t.executions) ? t.executions : []).slice(-10);
      if (ex.length < 3) continue; // 样本太少不判
      const okN = ex.filter((e) => e?.result === 'succeeded').length;
      const rate = okN / ex.length;
      if (rate < 0.7) recurringLow.push({ id: t.id, title: t.title ?? null, rate: Math.round(rate * 100), runs: ex.length });
    }
    const sch = j?.scheduler ?? {};
    const schLast = num(sch.lastTickAt);
    return {
      ok: true, file, mtimeMs: Math.round(st.mtimeMs), revision: num(j?.revision),
      tasks, recurringLow,
      scheduler: {
        lastTickAt: schLast,
        // ⚠️ 反面教材：error 常驻旧错（corrupt ledger was quarantined）→ 只看「error 存在且 tick 已停」才算故障
        error: sch.error ? String(sch.error) : null,
        errorStale: sch.error ? (schLast !== null && (opts.now ?? Date.now()) - schLast < 15 * MIN_MS) : null,
      },
    };
  } catch (e) {
    return { ok: false, file, error: e?.code === 'ENOENT' ? 'missing' : (e?.message ?? String(e)), tasks: [], recurringLow: [] };
  }
}

/** 自动归档状态（每 tick，读文件）。
 *
 *  ⚠️ **层级口径（2026-09-23 小修·3 修）**：插件（dsh-archive-sessions）写的生产文件是**两层**结构
 *     `{ config:{enabled,dryRun,hours,intervalMs,…}, state:{lastRunAt,lastResult,totalArchived} }`；
 *     早期/手工形态则是把同一批键铺在**顶层**（扁平）。
 *     旧实现**只读顶层** ⇒ 对生产文件恒得 `enabled:false` / `intervalMs:null` / `lastResult:null`
 *     ⇒ 两条 P2 事件（`archive-error` / `archive-stalled`）**永不触发**（通道静默）。
 *     现读法：**层级优先、扁平兜底**（`j.config?.x ?? j.x`；state 段同理）——两种形态都给真值。
 *     判据来源：事件 `archive-error` 用 `ok/lastResult/lastRunAt/intervalMs`、`archive-stalled` 用
 *     `ok/enabled/intervalMs/lastRunAt`（见 lib/watch-events.mjs）；字段形状不变，只修取数层级。
 */
export function collectArchive(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = opts.archiveFile ?? path.join(home, '_archived-sessions', '.auto-archive.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cfg = j?.config ?? {};
    const st = j?.state ?? {};
    const lastResult = st?.lastResult ?? j?.lastResult ?? null;
    // 【2026-09-28 · M2 归档元数据库】写库失败的**持久累计**（§4.2-③ 通道②）：
    //   落在 `.auto-archive.json` 的 `state.metaStore`（**不进 `errors`**——errors 是"要不要重发
    //   /auto/run"的判据，写库失败与归档动作本身无关，R2-3）。日报判据 = `writeFailedStreak ≥ 2`。
    const rawMeta = st?.metaStore && typeof st.metaStore === 'object' ? st.metaStore : null;
    const metaStore = rawMeta === null ? null : {
      writeFailedTotal: num(rawMeta.writeFailedTotal) ?? 0,
      writeFailedStreak: num(rawMeta.writeFailedStreak) ?? 0,
      lastWriteError: rawMeta.lastWriteError ?? null,
      lastWriteAt: num(rawMeta.lastWriteAt),
    };
    return {
      ok: true, file,
      enabled: (cfg?.enabled ?? j?.enabled) === true,
      dryRun: (cfg?.dryRun ?? j?.dryRun) === true,
      intervalMs: num(cfg?.intervalMs ?? j?.intervalMs),
      lastRunAt: num(st?.lastRunAt ?? j?.lastRunAt ?? lastResult?.at),
      lastResult,
      scanned: num(lastResult?.scanned),
      metaStore,
      // 单轮只读展示（§4.2-③ 通道①；与面板 `last.metaStore` 同源）
      lastMetaStore: lastResult?.metaStore && typeof lastResult.metaStore === 'object' ? lastResult.metaStore : null,
      metaStoreState: readMetaStoreState(home),
    };
  } catch (e) {
    return { ok: false, file, error: e?.code === 'ENOENT' ? 'missing' : (e?.message ?? String(e)) };
  }
}

/**
 * 元数据库状态词（§7-②：`ok | missing | corrupted | version-mismatch`）——**只读**判读。
 *
 * ⚠️ **口径同源声明**：本函数是 `tools\lib\archive-meta-store.mjs` 的 `readStore()/stateOf()`
 *    在**管家底座**里的**同步只读镜像**（底座是每 tick 跑的同步采集，不能 await 动态 import；
 *    而静态 import 会在共享件缺失时把整个采集链拖崩）。**改一处必须同步另一处**；
 *    真源 = 共享件 §4.3-② 的四态契约。
 */
export function readMetaStoreState(home) {
  const file = path.join(home, '_archived-sessions', 'archive-meta.json');
  if (!fs.existsSync(file)) return { state: 'missing', file, live: 0, total: 0 };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { state: 'missing', file, live: 0, total: 0 };
    const j = JSON.parse(raw);
    const ver = num(j?.schemaVersion);
    if (ver === null) return { state: 'corrupted', file, live: 0, total: 0, reason: 'structure: schemaVersion-missing' };
    if (ver > 1) return { state: 'version-mismatch', file, live: 0, total: 0, found: ver, expected: 1 };
    const sessions = j?.sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
      return { state: 'corrupted', file, live: 0, total: 0, reason: 'structure: sessions-not-object' };
    }
    let live = 0;
    for (const v of Object.values(sessions)) {
      const s = v && typeof v === 'object' ? (v.state ?? 'archived') : 'archived';
      if (s === 'archived' || s === 'restoring') live += 1;
    }
    return { state: 'ok', file, live, total: Object.keys(sessions).length };
  } catch (e) {
    return { state: 'corrupted', file, live: 0, total: 0, reason: e?.message ?? String(e) };
  }
}

/** git-crypt key 健康（每 tick，秒级 stat）。 */
export function collectGitcrypt(opts = {}) {
  const file = opts.keyFile ?? '<offsync-root>\\git-backup\\keys\\dsh-core.key';
  try {
    const st = fs.statSync(file);
    return { ok: true, path: file, exists: true, bytes: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, path: file, exists: false, bytes: null, mtimeMs: null };
    return { ok: false, path: file, error: e?.message ?? String(e) };
  }
}

/** 手机隧道（每 tick，复用进程列表）。 */
export function collectTunnel(opts = {}, processes = null) {
  const procs = processes ?? (listProcesses(opts).processes ?? []);
  const cf = procs.filter((p) => /cloudflared/i.test(`${p.name} ${p.cmd}`));
  let state = null;
  try {
    const f = path.join(opts.home ?? dshHome(), 'phone-tunnel-state.json');
    if (fs.existsSync(f)) state = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { /* 状态文件缺失不影响进程判定 */ }
  const lastReq = num(state?.lastRequestAt ?? state?.startedAt);
  const now = opts.now ?? Date.now();
  return {
    ok: true,
    running: cf.length > 0,
    pids: cf.map((p) => p.pid),
    startedAt: num(state?.startedAt),
    lastRequestAt: lastReq,
    idleHours: lastReq === null ? null : Math.max(0, (now - lastReq) / HOUR_MS),
  };
}

// ------------------------------------------------------------------ 重量采集

/** 会话尾部事件（读文件尾部 + 逐帧解 zstd）。 */
export function readSessionTail(file, opts = {}) {
  const tailBytes = opts.tailBytes ?? 256 * 1024;
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - tailBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const dec = decodeZstdFrames(buf);
  const events = [];
  let badLines = 0;
  for (const line of dec.text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev.type === 'string') events.push(ev);
    } catch { badLines++; }
  }
  events.sort((a, b) => Number(a?.seq ?? 0) - Number(b?.seq ?? 0));
  return {
    events, badLines, frames: dec.frames, frameErrors: dec.frameErrors.length,
    empty: dec.empty, bytes: st.size, mtimeMs: Math.round(st.mtimeMs), truncated: start > 0,
  };
}

/** 轻量会话扫描：只扫近期活跃会话（卡死 / 超长 / 上下文），每 tick 成本毫秒级。 */
// ---------------------------------------------------------------------------
// P9 H4 · 交接快照（P2 事件 / §5.6 抑制窗口 / P0 互斥 / P5 暂停 共用的采集面）
//   判定全在 lib/handoff-window.mjs（running / 抑制）+ lib/handoff-health.mjs（新鲜度 / RPO），
//   本函数只做「读交接单 + 调判定 + 拼一份快照」，**不复制任何阈值**。
//   任何失败都返回 ok:false（判定层据此不报），**绝不让 P2 tick 抛错**。
// ---------------------------------------------------------------------------
/**
 * @param {{home?:string, now?:number, recordFile?:string, ttlMs?:number, suppressMs?:number,
 *          record?:object|null, memoryFile?:string, repoMemoryFile?:string, skipHealth?:boolean}} [opts]
 */
export function collectHandoff(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? dshHome();
  let record = null;
  try {
    record = opts.record !== undefined ? opts.record : readHandoffRecord({ home, recordFile: opts.recordFile });
  } catch (e) {
    return { ok: false, reason: `读交接单失败：${e?.message ?? e}`, record: null };
  }
  const run = judgeHandoffRun(record, { now, ttlMs: opts.ttlMs });
  const suppression = judgeSessionSuppression(record, { now, windowMs: opts.suppressMs ?? HANDOFF_SUPPRESS_MS });
  let health = null;
  if (opts.skipHealth !== true) {
    try {
      // 记忆库 asOf 两源（与面板 checks.collectHandoffHealth 同口径：仓1 副本 mtime 优先）；
      // 仓1 工作副本路径由调用方可注入，取不到 → 交给判定层 fail-safe（不判、不告警）。
      const repoMemoryFile = opts.repoMemoryFile ?? path.join(BACKUP_ROOT(), 'dsh-core', 'dsh', 'memory', 'memory.db');
      const statOrNull = (p) => { try { const st = fs.statSync(p); return { path: p, mtimeMs: st.mtimeMs, bytes: st.size }; } catch { return null; } };
      health = judgeHandoffHealth({
        now, record,
        localMemory: statOrNull(opts.memoryFile ?? path.join(home, 'memory', 'memory.db')),
        repoMemory: statOrNull(repoMemoryFile),
      });
      health.thresholds = { ...HEALTH_THRESHOLDS, ...(health.thresholds ?? {}) };
    } catch (e) {
      health = { ok: false, reason: `交接健康判定失败：${e?.message ?? e}` };
    }
  }
  return { ok: true, record, run, suppression, health, home, now };
}

// ---------------------------------------------------------------------------
// P8 收纳（tidy）· 快照采集（**只读**）—— 2026-10-09 卡「冲刺600·补C2C3」新增
//
//   判定全在 `lib/tidy-events.mjs`（纯函数）；本函数只做两件 IO：读 P8 状态文件 + 读真搬留痕。
//   【为什么必须补这一层】2026-10-09 只读盘点实测：P8 采集器（`butler-tidy-tick.mjs`）自身
//   **没有任何 P2 出口**（只写 `butler-tidy-state.json` + 自己的审计行），`grep tidy lib\watch-events.mjs`
//   = 0 命中、当日管家日报「收纳」段 0 行 ⇒ 收纳出事时 P2 完全看不见。本函数 + tidy-events 就是那条出口。
//   失败语义（**不许静默**）：状态文件不在/读不动 ⇒ `ok:false` + `reason`（判定层给"不可探测"显式出口，
//   绝不当"收纳没事"）。
// ---------------------------------------------------------------------------
/** 【2c-B2】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, opts = {}) {
  return resolveStatePath(name, { home: opts.home ?? dshHome() }).path;
}
/** P8 收纳状态文件名（与 `butler-tidy-tick.mjs#STATE_NAME` 同源；此处不 import 采集器，免拉起调度器）。 */
export const TIDY_STATE_NAME = 'butler-tidy-state.json';
/** 审计流水尾部读取上限（只读尾 256KB；与 `decodeFirstFrame` 的保守策略同款）。 */
export const AUDIT_TAIL_BYTES = 256 * 1024;
/** 真搬留痕的审计 type（源头 = `butler-tidy-move.mjs:236` 的 `type: 'tidy-move-apply'`，口径不重写）。 */
export const TIDY_MOVE_AUDIT_TYPE = 'tidy-move-apply';

const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** 读一个 jsonl 的**尾巴**（只读；返回解析成功的对象数组，文件中最早的在前）。坏行/半行忽略。 */
export function readJsonlTail(file, maxBytes = AUDIT_TAIL_BYTES) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  if (!st.isFile() || st.size <= 0) return [];
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  const rows = [];
  for (let i = start > 0 ? 1 : 0; i < lines.length; i++) {  // start>0 时首行大概率是被截断的半行
    const ln = lines[i].trim();
    if (!ln) continue;
    try { rows.push(JSON.parse(ln)); } catch { /* 半行/坏行忽略 */ }
  }
  return rows;
}

/** 取当月 + 上月两个审计 jsonl，筛出真搬留痕（跨月边界也能看到最近一次搬移）。 */
function readMoveAuditTail(home) {
  const dir = resolveStatePath('butler-audit', { home }).path;
  const now = new Date();
  const name = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`;
  const files = [name(now), name(new Date(now.getFullYear(), now.getMonth() - 1, 1))];
  const rows = [];
  for (const f of files) {
    for (const j of readJsonlTail(path.join(dir, f))) {
      if (String(j.type ?? '') !== TIDY_MOVE_AUDIT_TYPE) continue;
      const atMs = j.at ? Date.parse(j.at) : NaN;
      rows.push({
        at: j.at ?? null,
        atMs: Number.isFinite(atMs) ? atMs : null,
        bucket: j.bucket ?? null,
        moved: numOrNull(j.moved), skipped: numOrNull(j.skipped),
        failed: numOrNull(j.failed), verified: j.verified === true,
        by: j.by ?? null, reason: j.reason ?? null,
      });
    }
  }
  rows.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  return rows;
}

/**
 * 采集 P8 收纳事实（只读）。形状契约见 `lib/tidy-events.mjs` 头部 §采集层契约。
 * @param {{home?:string, stateFile?:string, auditHome?:string}} [opts]
 */
export function collectTidy(opts = {}) {
  const home = opts.home ?? dshHome();
  const stateFile = opts.stateFile ?? stateFileOf(TIDY_STATE_NAME, { home });
  const out = {
    ok: true, reason: null, stateFile, stateMtimeMs: null, updatedAt: null,
    counters: null, lane: null, audit: null, p2Events: null,
    moves: { last: null, tail: [], error: null },
  };
  try {
    out.stateMtimeMs = Math.round(fs.statSync(stateFile).mtimeMs);
  } catch (e) {
    out.ok = false;
    out.reason = e?.code === 'ENOENT'
      ? `P8 状态文件不存在（${stateFile}）—— 采集器从未跑过或未放行（**不是**"收纳没事"）`
      : `P8 状态文件 stat 失败：${e?.message ?? e}`;
  }
  if (out.ok) {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const upd = s?.updatedAt ? Date.parse(s.updatedAt) : NaN;
      out.updatedAt = Number.isFinite(upd) ? upd : null;
      out.counters = s?.counters ?? null;
      const lane = s?.lane ?? null;
      const since = lane?.since ? Date.parse(lane.since) : NaN;
      out.lane = lane ? {
        skipped: lane.skipped ?? null,
        streak: numOrNull(lane.streak),
        sinceMs: Number.isFinite(since) ? since : null,
        since: lane.since ?? null,
        owner: lane.owner ?? null,
        reasons: lane.reasons ?? null,
        at: lane.at ?? null,
      } : null;
      const a = s?.lastRun?.audit ?? null;
      out.audit = a ? {
        checkpoints: numOrNull(a.checkpoints), produced: numOrNull(a.produced),
        block: numOrNull(a.summary?.block), warn: numOrNull(a.summary?.warn), ok: numOrNull(a.summary?.ok),
        missingCheckpoints: a.missingCheckpoints ?? null,
        runAt: numOrNull(s?.lastRun?.at), runId: s?.lastRun?.runId ?? null,
      } : null;
      out.p2Events = s?.lastRun?.gate?.p2Events ?? null;
    } catch (e) {
      out.ok = false;
      out.reason = `P8 状态文件读/解析失败：${e?.message ?? e}`;
    }
  }
  try {
    const rows = readMoveAuditTail(opts.auditHome ?? home);
    out.moves.tail = rows.slice(-5);
    out.moves.last = rows.length ? rows[rows.length - 1] : null;
  } catch (e) {
    out.moves.error = `真搬留痕读取失败：${e?.message ?? e}`;
  }
  return out;
}

/** 仓1 工作副本根（与面板 checks.mjs 的 BACKUP_ROOT 同口径；env 可覆盖）。 */
function BACKUP_ROOT() {
  return process.env.BUTLER_BACKUP_ROOT || '<offsync-root>\\git-backup';
}

// ---------------------------------------------------------------------------
// 【2026-10-30 新增】「在等工具」判据（治本）
//
// 病灶：`idleMs = now - f.mtimeMs`。长思考 / 长工具调用（max 档推理、生图、下载、跨机 ssh、
//   大文件写入前）期间会话**不写盘** ⇒ 10 分钟无写入就被判「回合未闭合且卡死」，发提醒、
//   20 分钟后还会往 P0 闸门塞重启事由。2026-10-30 主人反馈「误投放好像变多了」，
//   实锤样本 `a64aae60`（【续】<mainline>线）10:23 被提醒、10:54 还在正常干活。
//
// 判据（只看尾部事件，不猜、不超时猜状态）：
//   ① 收齐所有 `tool/result` 回答掉的 callId；
//   ② 从尾部往前找**最后一条** `tool/call`：它的 callId 已答 ⇒ 不算在等；
//   ③ 它之后出现 `assistant/message` ⇒ 也不算（工具确实返回了，只是那条 result 落在尾部窗口外）；
//   ④ 该 call 的事件 `time` 距今 **< maxWaitMs（缺省 30 分钟）** ⇒ 「在等工具」；
//      ≥ 该值 ⇒ 照旧判卡死（等这么久就不是正常工具调用了）。
//   ⚠️ 事件没有 `time` / 时间戳在未来（时钟错位）⇒ 不算在等，走原判据（宁可漏判，
//      也不让"读不动"变成永久豁免重启的挡箭牌 —— 与 ask-wait 同一条取舍）。
// ---------------------------------------------------------------------------

/** 从一条 `tool/result` 里取出它回答掉的 callId（两处写法都取，兼容不同世代）。 */
export function toolResultCallIds(ev) {
  const out = [];
  const src = ev?.data?.message?.source?.callId;
  if (typeof src === 'string' && src) out.push(src);
  const direct = ev?.data?.message?.toolCallId;
  if (typeof direct === 'string' && direct) out.push(direct);
  const content = ev?.data?.message?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const id = c?.toolCallId;
      if (typeof id === 'string' && id) out.push(id);
    }
  }
  return out;
}

/**
 * 纯函数：尾巴是否「在等工具返回」（不判卡死）。
 * @param {Array<{type:string,time?:number,data?:any}>} events 尾部事件（seq 升序）
 * @param {{now?:number, maxWaitMs?:number}} [opts]
 * @returns {{waiting:boolean, reason:string, tool:string|null, callId:string|null, waitedMs:number|null}}
 */
export function detectWaitingTool(events, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 30 * MIN_MS;
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e.type === 'string') : [];
  const none = (reason) => ({ waiting: false, reason, tool: null, callId: null, waitedMs: null });
  if (!list.length) return none('no-events');
  const answered = new Set();
  for (const e of list) {
    if (e.type !== 'tool/result') continue;
    for (const id of toolResultCallIds(e)) answered.add(id);
  }
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].type === 'tool/call') { idx = i; break; }
  if (idx < 0) return none('no-tool-call');
  const call = list[idx];
  const callId = String(call?.data?.callId ?? '') || null;
  const tool = String(call?.data?.name ?? '') || null;
  if (callId && answered.has(callId)) return { waiting: false, reason: 'answered', tool, callId, waitedMs: null };
  for (let i = idx + 1; i < list.length; i += 1) {
    if (list[i].type === 'assistant/message') return { waiting: false, reason: 'model-continued', tool, callId, waitedMs: null };
  }
  const at = Number(call?.time ?? 0) || 0;
  if (!at) return { waiting: false, reason: 'no-call-time', tool, callId, waitedMs: null };
  const waitedMs = now - at;
  if (waitedMs < 0) return { waiting: false, reason: 'clock-skew', tool, callId, waitedMs: null };
  if (waitedMs >= maxWaitMs) return { waiting: false, reason: 'tool-wait-expired', tool, callId, waitedMs };
  return { waiting: true, reason: 'waiting-tool', tool, callId, waitedMs };
}

export function collectSessionsLight(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const activeWindowMs = opts.activeWindowMs ?? 6 * HOUR_MS;
  const stuckMs = opts.stuckMs ?? 10 * MIN_MS;
  const interruptMinMs = opts.interruptMinMs ?? 5 * MIN_MS;
  const interruptMaxMs = opts.interruptMaxMs ?? 3 * DAY_MS;
  const longMs = opts.longMs ?? 2 * HOUR_MS;
  const longToolCalls = opts.longToolCalls ?? 200;
  const contextPct = opts.contextPct ?? 70;
  const loopMaxAgeMs = opts.loopMaxAgeMs ?? 2 * HOUR_MS;
  // 【2026-10-30】「在等工具」豁免窗口：末条 tool/call 距今不到这么久 ⇒ 视为在等，不判卡死。
  const toolWaitMaxMs = opts.toolWaitMaxMs ?? 30 * MIN_MS;

  // P9 §5.6 · 会话交接抑制窗口（24h）：窗口内把"被交接出去的会话"从「被打断」里降级，
  //   避免每次换机都在对方机器刷出一片"被打断"噪声。**降级不等于静默**：计数如实带出
  //   （`suppressedCount` / `suppression`），面板与日报都要显示"其中 N 个因交接窗口降级"。
  //   判定口径单一真相 = lib/handoff-window.mjs；调用方可用 opts.suppression 注入（避免重复 IO）。
  let suppression = opts.suppression ?? null;
  if (!suppression) {
    try { suppression = judgeSessionSuppression(readHandoffRecord({ home }), { now, windowMs: opts.suppressMs ?? HANDOFF_SUPPRESS_MS }); }
    catch { suppression = { inWindow: false, reason: '读交接单失败 → 不抑制' }; }
  }

  let files;
  try { files = discoverSessionFiles(home); } catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
  // 按 mtime 降序取前 maxFiles 个（146 个会话全读会拖慢 tick；近 40 个足够覆盖卡死/空转）
  const maxFiles = opts.sessionMaxFiles ?? 40;
  const recent = files
    // v0.1.2（2026-09-13 修，裸跑期稳态真误报根因）：**归档区会话不是「活跃会话」** ——
    //   discoverSessionFiles 同时扫 sessions\** 与 _archived-sessions\**（后者是 P4 坑库的富矿），
    //   但归档会话天然「尾巴停在历史 turn + 长期无新事件」⇒ 对 session-spin / session-long 恒成立，
    //   制造每轮必现的稳态真误报（报告 docs/ 实证 2 条同源）。
    //   此处只保留活跃树；归档区仍由 pitfall-scan/P4 单独消费，互不影响。
    .filter((f) => f.root !== 'archived')
    .filter((f) => now - f.mtimeMs <= Math.max(activeWindowMs, interruptMaxMs))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);
  // 【2026-10-21 · V3 功能面 C2「会话通道心跳目标」】**最近活跃会话** = 活跃树里 mtime 最新的那个
  //   （`recent` 已按 mtime 降序、已排除归档树）⇒ 这里零额外 IO，直接带出去给写心跳用。
  //   ⚠️ 语义 = "最近有活动"，**不是**"活着且在等消息"（后者要读尾巴/turn 状态，属另一件事）。
  const latestActive = recent.length
    ? { sessionId: recent[0].sessionId, mtimeMs: recent[0].mtimeMs, file: recent[0].file, root: recent[0].root }
    : null;
  const stuck = [];
  // 【2026-10-30】在等工具的会话：**不进** stuck（不提醒、不重启事由），只在这里如实带出（可观测不打扰）。
  const waitingTool = [];
  const long = [];
  const contextHigh = [];
  let interruptedCount = 0;
  const interruptedIds = [];
  // §5.6 降级计数（**不是**丢弃：单独登记，报告/面板要如实显示）
  let suppressedCount = 0;
  const suppressedIds = [];
  const scanErrors = [];

  for (const f of recent) {
    if (now - f.mtimeMs > interruptMaxMs) continue;
    let tail;
    try { tail = readSessionTail(f.file, opts); } catch (e) { scanErrors.push({ sessionId: f.sessionId, error: e?.message ?? String(e) }); continue; }
    if (!tail.events.length) continue;
    const cls = classifyTail(tail.events);
    const idleMs = now - f.mtimeMs;
    // v0.1.1（2026-09-11）：被打断的会话尾部常常是 turn/end(reason.kind=interrupted|aborted|error)
    //   —— 旧判据只认 open，这类被打断会话全被吞掉（面板 + P2 会盯人同源漏报）；现在 interrupted 也计入。
    const tailInterrupted = cls.state === 'open' || cls.state === 'interrupted';
    if (tailInterrupted) {
      if (idleMs >= interruptMinMs && idleMs <= interruptMaxMs) {
        // P9 §5.6：本会话若落在"刚跑完的一次交接"的抑制窗口内（且在窗口前就已停住）→ 降级，
        //   不计入 interruptedCount（避免对方机器每次换机都刷一片"被打断"），但如实登记。
        if (isSessionSuppressed(f.sessionId, f.mtimeMs, suppression)) {
          suppressedCount++; suppressedIds.push(f.sessionId);
        } else {
          interruptedCount++; interruptedIds.push(f.sessionId);
        }
      }
    }
    // 「卡死」仍只认 open：被打断的回合已经结束，不是卡住（否则会和 above 的 interrupted 重复计数）
    if (cls.state === 'open' && idleMs >= stuckMs) {
      // ★【2026-10-30 治本】先问一句"它是不是在等工具"：长工具调用期间会话不写盘，
      //   旧判据把这种"健康的安静"当成卡死（`a64aae60` 就是活样本）。
      const wt = detectWaitingTool(tail.events, { now, maxWaitMs: toolWaitMaxMs });
      if (wt.waiting) {
        waitingTool.push({
          sessionId: f.sessionId,
          reason: `等待工具返回（${wt.tool ?? '工具'} 已发出 ${Math.round((wt.waitedMs ?? 0) / MIN_MS)} 分钟、还没有结果）`,
          idleMs, tool: wt.tool, callId: wt.callId, waitedMs: wt.waitedMs,
          toolCalls: countToolCalls(tail.events),
        });
      } else {
        stuck.push({ sessionId: f.sessionId, reason: `回合未闭合且 ${Math.round(idleMs / MIN_MS)} 分钟无新事件`, idleMs, toolCalls: countToolCalls(tail.events) });
      }
    }
    // 工具死循环：同签名 tool/call ≥5 次且无 assistant/message 产出
    const spin = detectToolLoop(tail.events, opts);
    if (spin) stuck.push({ sessionId: f.sessionId, reason: spin.reason, idleMs, toolCalls: spin.calls });
    // reasoning 原地绕圈（2026-09-10）：只对近期会话计算，省每 tick 成本
    if (now - f.mtimeMs <= loopMaxAgeMs) {
      const rloop = detectReasoningLoop(tail.events, { ...opts, now });
      if (rloop) {
        stuck.push({
          sessionId: f.sessionId, reason: rloop.reason, idleMs, toolCalls: rloop.calls,
          kind: 'reasoning-loop', step: rloop.step, chars: rloop.chars, repeat: Math.round(rloop.repeat * 1000) / 1000,
        });
      }
    }
    // 超长会话
    const tcs = countToolCalls(tail.events);
    const turnStart = findLastTurnStart(tail.events);
    const runningMs = turnStart ? now - turnStart : null;
    if (cls.state === 'open' && ((runningMs !== null && runningMs >= longMs) || tcs >= longToolCalls)) {
      long.push({ sessionId: f.sessionId, hours: runningMs === null ? null : Math.round(runningMs / HOUR_MS * 10) / 10, toolCalls: tcs });
    }
    // 上下文健康
    const ctx = extractContext(tail.events);
    if (ctx && ctx.pct >= contextPct) contextHigh.push({ sessionId: f.sessionId, pct: ctx.pct, contextWindow: ctx.contextWindow, totalTokens: ctx.totalTokens });
  }
  return {
    ok: true, scanned: recent.length, total: files.length,
    // C2：写心跳用（`lib\watch-notify.mjs#buildSessionHeartbeat()` 消费；没有活跃会话 = null）
    latestActive,
    interruptedCount, interruptedIds, stuck, long, contextHigh, scanErrors,
    // 【2026-10-30】在等工具的会话（本轮不判卡死，可观测）：`stuck-recovery` 据此给读数提示。
    waitingTool,
    // §5.6 交接窗口降级（可见，不静默）
    suppressedCount,
    suppressedIds: suppressedIds.slice(0, 50),
    suppression: {
      inWindow: suppression?.inWindow === true,
      source: suppression?.source ?? null,
      byTime: suppression?.byTime === true,
      reason: suppression?.reason ?? null,
    },
  };
}

export function countToolCalls(events) {
  let n = 0;
  for (const e of events ?? []) if (e?.type === EV.TOOL_CALL) n++;
  return n;
}

export function findLastTurnStart(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events[i];
    if (isTurnStart(e?.type)) return num(e.time) ?? null;
  }
  return null;
}

/**
 * 同工具同签名短时 ≥5 次且无 assistant 产出 → 死循环信号。
 *
 * ★ P0 宿主适配层（2026-09-14）：第 456 行原写死 `assistant/message || assistant/chunk`，
 *   已改为适配层族判定 `isAssistantProduction`（`assistant/*` 族）。**为什么必须改**：
 *   0.1.5 删了 `assistant/chunk`、新增结算式的 `assistant/attempt` ⇒ 旧判据 `lastAssistant` 恒 -1，
 *   于是 `detectToolLoop` 从**会话开头**起算 → 误报（行为反转，直撞 P2 误报率 KPI）。
 *   档 A 等价性：0.1.1-rc.2 词表里 `assistant/*` 恰为 chunk / message 两项，族判定与旧枚举等价
 *   （回归差异 0 条，见 `_archive\adapter-p0-20260914-1536\regression\`）。
 */
export function detectToolLoop(events, opts = {}) {
  const limit = opts.loopThreshold ?? 5;
  const counts = new Map();
  let lastAssistant = -1;
  const list = events ?? [];
  for (let i = 0; i < list.length; i++) {
    if (isAssistantProduction(list[i]?.type)) lastAssistant = i;
  }
  for (let i = lastAssistant + 1; i < list.length; i++) {
    const e = list[i];
    if (e?.type !== EV.TOOL_CALL) continue;
    const d = e.data ?? {};
    const args = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '');
    const sig = `${d.name ?? '?'}|${args.slice(0, 200)}`;
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  for (const [sig, n] of counts) {
    if (n >= limit) return { reason: `同工具同签名连续 ${n} 次（${sig.split('|')[0]}），无产出`, calls: n };
  }
  return null;
}

// ── reasoning 原地绕圈检测（2026-09-10 新增）────────────────────────────
//
// 背景：2026-09-09 23:56 会话 <session-id>（TUF会话同步后丢失问题）在 reasoning
//   阶段原地绕圈：单 step 14.4 万字符、120 字符块重复率 0.899，而既有四条判据全部不命中
//   —— ①回合未闭合 + 10min 无新事件（绕圈时 reasoning chunk 一直在写，idle 只有秒级）
//      ②同工具同签名 ≥5 次（绕圈不产生 tool/call）③超长会话（step 数并不多）
//      ④上下文 ≥70%（该会话只到 23%）。
//
// 阈值依据（2026-09-10 实测近 6h 共 40 个会话，256KB 尾部窗口按 step 分组）：
//   仅该循环会话 maxBlock=0.624，其余 39 个全部 0.000 → 块重复率是干净判据；
//   ⚠️ topGram（最高频 8-gram 密度）不可用：正常会话最高 0.574，会误报。
//
// 只统计尾部窗口（readSessionTail 默认 256KB）内的文本：绕圈时窗口内几乎全是复读内容，
// 不必读全文件（每 tick 扫 40 个会话，成本毫秒级）。

/** 120 字符块重复率（不重叠滑窗）；样本不足 3 块返回 null。 */
export function blockRepeatRate(text, size = 120) {
  if (typeof text !== 'string' || text.length < size * 3) return null;
  const seen = new Map();
  let total = 0;
  let dup = 0;
  for (let i = 0; i + size <= text.length; i += size) {
    const b = text.slice(i, i + size);
    total++;
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    if (n >= 2) dup++;
  }
  return total ? dup / total : null;
}

/** 尾部窗口内按 turn/step 聚合 reasoning 文本（优先 assistant/message 的完整块）。 */
export function reasoningByStep(events) {
  const steps = new Map();
  for (const ev of events ?? []) {
    const d = ev?.data ?? {};
    const turn = num(d.turn);
    const step = num(d.step);
    if (turn === null || step === null) continue;
    const key = `${turn}/${step}`;
    if (!steps.has(key)) steps.set(key, { key, msg: '', chunk: '', tools: 0, lastTime: null });
    const s = steps.get(key);
    const t = num(ev.time);
    if (t !== null && (s.lastTime === null || t > s.lastTime)) s.lastTime = t;
    if (ev.type === EV.TOOL_CALL) s.tools++;
    if (ev.type === EV.ASSISTANT_MESSAGE && Array.isArray(d.message?.content)) {
      for (const p of d.message.content) if (p?.type === 'reasoning' && typeof p.text === 'string') s.msg += p.text;
    }
    if (ev.type === EV.LEGACY_ASSISTANT_CHUNK) {
      const c = d.chunk ?? {};
      if (c.type === 'block-end' && c.block?.type === 'reasoning' && typeof c.block.text === 'string') s.chunk += c.block.text;
    }
  }
  return [...steps.values()].map((s) => ({ key: s.key, text: s.msg || s.chunk, tools: s.tools, lastTime: s.lastTime }));
}

/**
 * reasoning 原地绕圈判定（只取窗口内最强的一个 step）。
 * @returns {null | {step:string, chars:number, repeat:number, tools:number, calls:number, lastTime:number|null, reason:string}}
 */
export function detectReasoningLoop(events, opts = {}) {
  const minChars = opts.loopMinChars ?? 3000;
  const size = opts.loopBlockSize ?? 120;
  const threshold = opts.loopRepeatThreshold ?? 0.3;
  const maxAgeMs = opts.loopMaxAgeMs ?? 2 * HOUR_MS;
  const now = opts.now ?? Date.now();
  let best = null;
  for (const s of reasoningByStep(events)) {
    if (!s.text || s.text.length < minChars) continue;
    if (s.lastTime !== null && now - s.lastTime > maxAgeMs) continue;
    const repeat = blockRepeatRate(s.text, size);
    if (repeat === null || repeat < threshold) continue;
    if (!best || repeat > best.repeat) best = { step: s.key, chars: s.text.length, repeat, tools: s.tools, lastTime: s.lastTime };
  }
  if (!best) return null;
  return {
    ...best,
    calls: best.tools,
    reason: `推理原地绕圈（step ${best.step}：reasoning ${best.chars} 字符，重复块 ${Math.round(best.repeat * 100)}%，工具调用 ${best.tools} 次）`,
  };
}

/** 从尾部事件提取上下文占用（request/context + assistant/message usage）。 */
export function extractContext(events) {
  let contextWindow = 0;
  let totalTokens = 0;
  for (const e of events ?? []) {
    const d = e?.data ?? {};
    if (e?.type === EV.REQUEST_CONTEXT && num(d.contextWindow) > 0) contextWindow = num(d.contextWindow);
    if (e?.type === EV.ASSISTANT_MESSAGE && num(d.usage?.total_tokens) !== null) totalTokens = num(d.usage.total_tokens);
  }
  if (!contextWindow || !totalTokens) return null;
  return { contextWindow, totalTokens, pct: Math.min(100, Math.round((100 * totalTokens) / contextWindow)) };
}

/** 会话文件健康（heavy：复用 P4 增量扫描）。 */
export function collectSessionHealth(opts = {}) {
  const home = opts.home ?? dshHome();
  try {
    const scan = scanHome({ home, scanFiles: opts.scanFiles ?? {}, now: opts.now ?? Date.now(), fixture: opts.fixture, maxFiles: opts.maxFiles });
    const corrupt = [];
    const warn = [];
    for (const h of scan.health ?? []) {
      if (h.status === 'corrupt' || h.status === 'unreadable') corrupt.push(h);
      else if (h.status === 'warn') warn.push(h);
    }
    return { ok: true, corrupt, warn, scanned: scan.stats?.scanned ?? 0, scanUpdates: scan.scanUpdates ?? {} };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), corrupt: [], warn: [] };
  }
}

/**
 * 「已知形态」的本地 fork 白名单（2026-11-06 · Router 20:13 拍板）。
 *
 * 判据：这些包在 profile 里把依赖声明写成 `0.0.0-local` **占位版是故意的** ——
 *   ① 让 npm 认不出、插件市场不提示"待升级"；② 升级/`pnpm add` 不会覆盖本地魔改；
 *   ③ 实体装的是真版本号（`1.1.0-local` / `0.2.0` / `0.1.2`）⇒ 声明 ≠ 实体**属设计如此**。
 * 处置：命中本表 ⇒ 只进 `versionDriftKnown`（进报告与证据面），**不进 `versionDrift`**（不触发告警）。
 *
 * ⚠️ 加新条目请写清「为什么这个是已知形态」；**别把真错配塞进来当白名单**（那等于关掉体检）。
 */
export const KNOWN_LOCAL_FORK = new Map([
  ['dsh-feiyu-mood', 'the assistant心情插件 · 已彻底自建 fork（`<butler-root>\\dsh-feiyu-mood-src`，1.1.0-local），声明 0.0.0-local 是占位、防市场覆盖'],
  ['dsh-feiyu-shape', 'the assistant形态插件 · 本地魔改（实体 0.2.0），声明 0.0.0-local 是占位、防市场覆盖'],
  ['dsh-feiyu-moodread', 'the assistant情绪读数外挂（实体 0.1.2），声明 0.0.0-local 是占位、防市场覆盖'],
]);

/** 结构健康（heavy：junction 目标 / 版本漂移 / 未分组）。 */
export function collectStructure(opts = {}) {
  const home = opts.home ?? dshHome();
  const profileDir = opts.profileDir ?? path.join(home, 'profiles', 'web');
  const nm = path.join(profileDir, 'node_modules');
  const out = { ok: true, missingJunctions: [], versionDrift: [], versionDriftKnown: [], ungroupedCount: null, junctionChecked: 0, junctionTotal: 0 };
  try {
    const limit = opts.junctionLimit ?? 80;
    const entries = fs.readdirSync(nm, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isSymbolicLink()) continue;
      out.junctionTotal++;
      if (out.junctionChecked >= limit) continue;
      out.junctionChecked++;
      const full = path.join(nm, e.name);
      try {
        const st = fs.statSync(full); // 目标不存在 → 抛 ENOENT
        if (!st) out.missingJunctions.push(e.name);
      } catch { out.missingJunctions.push(e.name); }
    }
  } catch (e) {
    out.ok = false;
    out.error = e?.message ?? String(e);
  }
  // profile 声明 vs 实体版本漂移
  //
  // 【2026-11-06 · Router 20:13 拍板 · 白名单化】两类「不算漂移」的情况，都**只报不警**：
  //   ① **链接声明**（`link:` / `file:` / `workspace:` / `portal:`）—— 它们根本不是版本号，
  //      与实体版本没有「漂移」语义。本判据从实现起就跳过它们（见下方 continue），
  //      这里把它写成**显式注释**，免得以后有人"看到版本对不上"又把它算进来。
  //      ⚠️ 实测警戒线：`@deepseek-ai/dsh-time-context`（link → 主包内）与 `dsh-emoji`
  //      （link → `<butler-root>\dsh-emoji-plugin`）两条属于此列；**若哪天体检把它们报进漂移，那是判据被改坏了**。
  //   ② **已知形态的本地 fork**（见 `KNOWN_LOCAL_FORK`）—— 它们是本地魔改件，profile 里
  //      **故意**把依赖声明写成 `0.0.0-local` 占位版，让 npm 认不出、插件市场不提示"待升级"、
  //      升级也不覆盖定制；实体装的是真版本号 ⇒ 声明 ≠ 实体是**设计如此**，不是故障。
  //      这类只进 `versionDriftKnown`（进报告/证据面），**不进 `versionDrift`**（后者才触发告警）。
  try {
    const pkgFile = path.join(profileDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [name, declared] of Object.entries(deps)) {
      const decl = String(declared);
      // 链接声明 = 不是版本号 ⇒ 永远不参与漂移判定（见上方 ①）
      if (/^(link:|file:|workspace:|portal:)/.test(decl)) continue;
      const dir = name.startsWith('@') ? path.join(nm, ...name.split('/')) : path.join(nm, name);
      const ent = path.join(dir, 'package.json');
      if (!fs.existsSync(ent)) continue;
      try {
        const v = JSON.parse(fs.readFileSync(ent, 'utf8')).version;
        const want = decl.replace(/^[\^~]/, '');
        if (!v || !want || decl.includes(v) || v === want) continue;
        const known = KNOWN_LOCAL_FORK.get(name);
        if (known) out.versionDriftKnown.push({ name, declared: decl, entity: v, reason: known });
        else out.versionDrift.push({ name, declared: decl, entity: v });
      } catch { /* 单个包读坏跳过 */ }
    }
  } catch { /* 无 profile package.json 则跳过 */ }
  return out;
}

/** 磁盘余量（heavy）。 */
export function collectDisk(opts = {}) {
  try {
    const drives = opts.drives ?? ['C', 'D'];
    const out = { ok: true, cFreeGb: null, dFreeGb: null };
    for (const d of drives) {
      const root = `${d}:\\`;
      if (!fs.existsSync(root)) continue;
      const st = fs.statfsSync(root);
      const gb = (Number(st.bavail) * Number(st.bsize)) / (1024 ** 3);
      if (d === 'C') out.cFreeGb = Math.round(gb * 10) / 10;
      if (d === 'D') out.dFreeGb = Math.round(gb * 10) / 10;
    }
    return out;
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * 开工预检端口（heavy，只报状态）。
 *
 * 【G11 · 2026-09-21 P2-A】**护士面显式排除**：`NURSE_PORTS`（3091）一律不探 ——
 *   即便调用方把 3091 塞进 `portList`，这里也会把它拦在探测之外并如实记录（`excluded.blockedFromRequest`）。
 *   为什么需要："修复窗口内 3091 上跑着护士实例"是**设计内**状态，若被采成"端口占用/异常实例"，
 *   就是 V10「观测不污染」失守；此前无代码约束、无单测 ⇒ 本函数即那处约束。
 * @param {{portList?:number[], probe?:Function}} [opts] portList 覆盖待探端口表；probe 注入探针（单测用）
 */
export async function collectPreflightPorts(opts = {}) {
  const want = (Array.isArray(opts.portList) ? opts.portList : PREFLIGHT_PORTS).map(Number);
  const blocked = want.filter((p) => NURSE_PORTS.includes(p));
  const probeOne = async (port) => {
    if (!want.includes(port) || NURSE_PORTS.includes(port)) return false; // 未请求 / 护士面 → 不探
    if (typeof opts.probe === 'function') return (await opts.probe(port)) === true;
    return probePort(port, opts);
  };
  const [proxy, bridge, comfy, lan] = await Promise.all([probeOne(7897), probeOne(8199), probeOne(8188), probeOne(3081)]);
  return {
    proxy: { ok: true, listening: proxy },
    localStack: { ok: true, bridge, comfy },
    phone: { ok: true, lanProxy: lan },
    excluded: {
      ports: [...NURSE_PORTS], blockedFromRequest: blocked,
      safeHome: nurseSafeHome(opts),
      why: 'G11：护士安全实例端口写死排除（修复窗口内 3091 在监听是设计内状态，不算异常）',
    },
  };
}

/** 网络可达（heavy，仅 TCP 探测，不抓页面）。 */
export async function collectNetwork(opts = {}) {
  const host = opts.netHost ?? 'gitee.com';
  const port = opts.netPort ?? 443;
  const reachable = await probePort(port, { host, timeoutMs: opts.timeoutMs ?? 2500 });
  return { ok: true, reachable, host, port };
}

/** 升级体检：优先面板 HTTP（权威分级），失败降级缓存（只认主包）。 */
export async function collectUpgrade(opts = {}) {
  const baseUrl = opts.baseUrl ?? 'http://127.0.0.1:3080';
  try {
    const r = await fetch(`${baseUrl}/api/dsh-ecosystem-panel/state`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 4000) });
    const j = await r.json();
    const items = Array.isArray(j?.groups?.upgrades) ? j.groups.upgrades : [];
    const red = items.filter((x) => x?.status === 'red').map((x) => String(x.name ?? '?'));
    const yellow = items.filter((x) => x?.status === 'yellow').map((x) => String(x.name ?? '?'));
    return { ok: true, dataSource: 'panel-http', red: [...new Set(red)].sort(), yellow: [...new Set(yellow)].sort(), cacheAt: num(j?.upgradesMeta?.cacheAt) };
  } catch (e) {
    // 降级：读缓存文件，只把「主包落后」粗判为 red
    try {
      const f = opts.cacheFile ?? path.join(opts.home ?? dshHome(), 'ecosystem-panel-upgrade-cache.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const local = readLocalMainVersion(opts);
      const latest = j?.highest?.['@deepseek-ai/dsh'] ?? j?.latest?.['@deepseek-ai/dsh'] ?? null;
      const red = local && latest && local !== latest ? ['@deepseek-ai/dsh'] : [];
      return { ok: true, dataSource: 'cache-fallback', red, yellow: [], cacheAt: num(j?.at), fallbackError: e?.message ?? String(e), local, latest };
    } catch (e2) {
      return { ok: false, dataSource: 'none', red: [], yellow: [], error: e2?.message ?? String(e2) };
    }
  }
}

function readLocalMainVersion(opts = {}) {
  try {
    const f = opts.mainPkgFile ?? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')).version ?? null;
  } catch { /* 读不到就 null */ }
  return null;
}

// ------------------------------------------------------------------ 汇总

/**
 * 采集一份完整快照。
 * @param {{home?:string, now?:number, heavy?:boolean, tasks?:string[], scanFiles?:object, fixture?:object,
 *          baseUrl?:string, keyFile?:string, ledgerFile?:string, archiveFile?:string}} [opts]
 */
export async function collectSnapshot(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? dshHome();
  const snap = { ok: true, now, home, device: deviceName(), heavy: opts.heavy === true };
  // 【G11 自证】把"本采集面按设计排除了护士 home/端口"写进快照（报告/面板/单测都能读到）
  snap.nurseExclusions = nurseExclusions({ ...opts, home });

  const procs = listProcesses(opts);
  const [guard, upgrade, ports, net] = await Promise.all([
    collectGuard({ ...opts, home, now, processes: procs }),
    collectUpgrade({ ...opts, home }),
    opts.heavy ? collectPreflightPorts(opts) : Promise.resolve({}),
    opts.heavy ? collectNetwork(opts) : Promise.resolve({ ok: false, skipped: true }),
  ]);

  snap.schedules = collectSchedules(opts);
  snap.guard = guard;
  snap.ledger = collectLedger({ ...opts, home, now });
  snap.archive = collectArchive({ ...opts, home });
  snap.gitcrypt = collectGitcrypt(opts);
  snap.tunnel = collectTunnel({ ...opts, home, now }, procs.processes ?? []);
  snap.upgrade = upgrade;
  // P9 H4 · 交接快照**先采**（sessions 的 §5.6 抑制窗口要用同一份判定 ⇒ 交接单只读一次）
  try {
    snap.handoff = collectHandoff({ ...opts, home, now });
  } catch (e) {
    snap.handoff = { ok: false, reason: `交接采集失败：${e?.message ?? e}` };
  }
  snap.sessions = collectSessionsLight({ ...opts, home, now, suppression: snap.handoff?.suppression });
  // P8 收纳（2026-10-09 卡「冲刺600·补C2C3」）：只读 state + 真搬留痕；失败 ⇒ ok:false（判定层给显式出口）
  try {
    snap.tidy = collectTidy({ ...opts, home });
  } catch (e) {
    snap.tidy = { ok: false, reason: `收纳采集失败：${e?.message ?? e}`, stateFile: null, moves: { last: null, tail: [], error: null } };
  }

  if (opts.heavy) {
    snap.sessionHealth = collectSessionHealth({ ...opts, home, now, scanFiles: opts.scanFiles });
    snap.structure = collectStructure({ ...opts, home });
    snap.disk = collectDisk(opts);
    snap.proxy = ports.proxy ?? { ok: false };
    snap.localStack = ports.localStack ?? { ok: false };
    snap.phone = { ...(ports.phone ?? { ok: false }), tunnel: snap.tunnel.running };
    snap.network = net;
  } else {
    snap.sessionHealth = { ok: false, skipped: true, corrupt: [], warn: [] };
    snap.structure = { ok: false, skipped: true };
    snap.disk = { ok: false, skipped: true };
    snap.proxy = { ok: false, skipped: true };
    snap.localStack = { ok: false, skipped: true };
    snap.phone = { ok: false, skipped: true };
    snap.network = { ok: false, skipped: true };
  }
  return snap;
}
