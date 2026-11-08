#!/usr/bin/env node
// dsh-butler / butler-repair-linger-tick.mjs —— 【F-B2 · 2026-10-10 · 卡 01c658b1「补守护鱼」】
// 分身「僵留」自动收官（tickd job `repair-linger`）。
//
// 【为什么有它】repair.mjs 设计上是"修完挂起等验收"（linger 不自杀）⇒ 若没人执行 `repair-ctl finish`，
//   分身会**永远留着**：生产实录 2026-10-10 14:33 tick「修复分身 1 个（PID 6888）跑完未收尾：
//   本轮报告已落盘 819 分钟（> 15 分钟）」—— 僵留 13.6 小时没人收。方案口径是"先观测 7 天"，
//   观察期已过（约 18 天）仍未闭环 ⇒ 本 job 补上"跑完就该收"的这一环。
//
// 【性质】新增**自治动作** ⇒ 三件齐：① 一键关回 ② 日报/留痕一行 ③ 默认**关**（候选态）。
//   放行（改真动作）由主人在意时执行：`--on` 写 ~/.dsh/butler-repair.json#lingerAutoFinish=true。
//
// 【安全设计（四道）】
//   ① **默认关**：配置缺失/false ⇒ 只打印判定，**零动作**（rc 0）。
//   ② **双闸**：tickd 走 `--tick`（认配置）；CLI 裸跑**默认 dry-run**，`--go` 才真动作（生态铁律）。
//   ③ **判据保守**：只在「已有分身 ∧ 报告已落盘 ∧ 报告龄 > T（默认 15 min）∧ 无生效挂起锁
//      ∧ 无 finish 标记」时才收；任何一项读不到 ⇒ 不动（fail-closed）。
//   ④ **动作走既有 CLI**（`repair-ctl.mjs finish`），不自写标记、不杀进程 —— 收官语义由分身自己处理。
//
// 用法：
//   node butler-repair-linger-tick.mjs                  # 判定 + 打印（dry-run，零动作）
//   node butler-repair-linger-tick.mjs --go             # 真执行（需配置为开；配合 --force 可单次绕过）
//   node butler-repair-linger-tick.mjs --tick           # tickd 档：认配置（开=真动作）
//   node butler-repair-linger-tick.mjs --status|--on|--off
//   node butler-repair-linger-tick.mjs --self-test      # 夹具自测（不碰生产）
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectRepairState } from './dsh-butler-watch.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { writeStateText } from '../src/dsh-butler/lib/dual-write.mjs';

export const VERSION = '0.1.0';
/** 【2c-B3】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
const BUTLER_HOME = path.join(os.homedir(), '.dsh');
const stateFileOf = (name) => resolveStatePath(name, { home: BUTLER_HOME }).path;
export const CFG_FILE = stateFileOf('butler-repair.json');
export const LEDGER_FILE = stateFileOf('butler-repair-linger.json');
export const LINGER_MIN_DEFAULT = 15;            // 与 watch 判据同口径（report 落盘 > 15 min 即"跑完没收")

const REPAIR_CTL = path.join(workspaceRoot(), 'repair-ctl.mjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));

function readCfg(file = CFG_FILE) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; }
  catch { return {}; }
}
function writeCfg(patch, file = CFG_FILE) {
  const cur = readCfg(file);
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dw = writeStateText(path.basename(file), JSON.stringify(next, null, 2) + '\n', {
    home: path.dirname(file),
    write: (p, t) => fs.writeFileSync(p, t, 'utf8'),
  });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  return next;
}
function appendLedger(row, file = LEDGER_FILE) {
  let cur = { version: VERSION, history: [] };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object') cur = { ...cur, ...j }; } catch { /* 首次 */ }
  cur.version = VERSION;
  cur.lastRunAt = new Date().toISOString();
  cur.lastVerdict = row.verdict;
  cur.lastDetail = row.detail ?? null;
  cur.history = [...(Array.isArray(cur.history) ? cur.history : []), row].slice(-20);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); const dw = writeStateText(path.basename(file), JSON.stringify(cur, null, 2), { home: path.dirname(file), write: (p, t) => fs.writeFileSync(p, t, 'utf8') }); if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown')); } catch { /* 只读不致命 */ }
  return cur;
}

/**
 * 纯判定（单测主战场）。输入 = 采集快照，输出 = 该不该收。
 * @param {{repair:object, now?:number, lingerMin?:number, finishMarkerExists?:boolean}} input
 */
export function decide(input = {}) {
  const now = Number(input.now ?? Date.now());
  const lingerMin = Number(input.lingerMin ?? LINGER_MIN_DEFAULT);
  const r = input.repair ?? {};
  if (r.ok !== true) return { verdict: 'skip-undetectable', detail: `分身扫描不可用：${r.error ?? '未知原因'}（fail-closed：不动）`, act: false };
  const count = Number(r.count ?? 0);
  if (!(count > 0)) return { verdict: 'skip-no-agent', detail: '无僵留分身', act: false };
  if (input.finishMarkerExists === true) return { verdict: 'skip-marker-exists', detail: `已有 finish 标记，分身会自行退出（分身 ${count} 个）`, act: false };
  const h = r.hold ?? {};
  if (h.exists && (h.expiresAtMs === null || Number(h.expiresAtMs) > now)) {
    return { verdict: 'skip-hold', detail: '挂起锁生效中（有人明确要求"先别自动收官"）', act: false };
  }
  const m = Number(r.reportMtimeMs);
  if (!Number.isFinite(m) || m <= 0) return { verdict: 'skip-no-report', detail: '本轮报告未落盘（修还没跑完 / 报告目录不可读）', act: false };
  const ageMin = Math.floor((now - m) / 60000);
  if (ageMin <= lingerMin) return { verdict: 'skip-too-young', detail: `报告才落盘 ${ageMin} 分钟（阈值 ${lingerMin} 分钟）`, act: false };
  return {
    verdict: 'linger-detected', act: true,
    detail: `分身 ${count} 个（PID ${(r.pids ?? []).slice(0, 3).join('、') || '?'}）跑完未收尾：报告已落盘 ${ageMin} 分钟（> ${lingerMin} 分钟）`,
  };
}

/** 收官（走既有 CLI，不自写标记）。 */
function doFinish({ repairCtl = REPAIR_CTL, spawn = spawnSync, log = console.log } = {}) {
  const r = spawn(process.execPath, [repairCtl, 'finish', '--wait-ms', '10000'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const ok = r?.status === 0;
  log(`[repair-linger] 执行 repair-ctl finish → exit=${r?.status ?? '?'}${ok ? '' : ' !! ' + String(r?.stderr ?? '').slice(0, 200)}`);
  return { ok, status: r?.status ?? null };
}

/** 夹具自测：只调纯判定，不碰生产 */
export function selfTest(log = console.log) {
  const now = 1_700_000_000_000;
  const base = { ok: true, count: 1, pids: ['1234'], reportMtimeMs: now - 20 * 60000, hold: { exists: false }, error: null };
  const cases = [
    ['无分身 ⇒ skip', { repair: { ...base, count: 0 } }, 'skip-no-agent'],
    ['扫描不可用 ⇒ skip（fail-closed）', { repair: { ...base, ok: false, error: 'ETIMEDOUT' } }, 'skip-undetectable'],
    ['挂起锁生效 ⇒ skip', { repair: { ...base, hold: { exists: true, expiresAtMs: now + 60000 } } }, 'skip-hold'],
    ['挂起锁过期 ⇒ 收', { repair: { ...base, hold: { exists: true, expiresAtMs: now - 1000 } } }, 'linger-detected'],
    ['报告太新 ⇒ skip', { repair: { ...base, reportMtimeMs: now - 5 * 60000 } }, 'skip-too-young'],
    ['已有 finish 标记 ⇒ skip', { repair: base, finishMarkerExists: true }, 'skip-marker-exists'],
    ['报告未落盘 ⇒ skip', { repair: { ...base, reportMtimeMs: null } }, 'skip-no-report'],
    ['正常僵留 ⇒ 收', { repair: base }, 'linger-detected'],
  ];
  let bad = 0;
  for (const [name, input, want] of cases) {
    const got = decide({ ...input, now }).verdict;
    const ok = got === want;
    if (!ok) bad++;
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} → ${got}${ok ? '' : `（期望 ${want}）`}`);
  }
  log(`自测：${cases.length - bad}/${cases.length} PASS`);
  return { total: cases.length, failed: bad };
}

// ---------------------------------------------------------------- CLI
const isMain = (() => {
  try {
    const a1 = process.argv[1];
    if (!a1) return false;
    return fs.realpathSync(a1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const cfg = readCfg();
  const enabled = cfg.lingerAutoFinish === true;

  if (has('--self-test')) { process.exitCode = selfTest().failed ? 1 : 0; }
  else if (has('--status')) {
    console.log(`repair-linger 自动收官：${enabled ? 'ON' : 'OFF（默认 · 候选态）'}`);
    console.log(`配置        : ${CFG_FILE}${fs.existsSync(CFG_FILE) ? '' : '  (absent)'}`);
    console.log(`阈值        : 报告落盘 > ${cfg.lingerMin ?? LINGER_MIN_DEFAULT} 分钟`);
    console.log(`动作        : node ${REPAIR_CTL} finish --wait-ms 10000（收官语义由分身自己处理）`);
    console.log(`关回        : node ${path.join(HERE, 'butler-repair-linger-tick.mjs')} --off`);
  } else if (has('--on') || has('--off')) {
    const want = has('--on');
    writeCfg({ lingerAutoFinish: want });
    console.log(`repair-linger 自动收官 -> ${want ? 'ON' : 'OFF'}  (${CFG_FILE})`);
    console.log(want ? 'effect: tickd job repair-linger 会在判定命中时真执行 repair-ctl finish' : 'effect: 只判定不动作（零副作用）');
  } else {
    const tickMode = has('--tick');
    const force = has('--force');
    // 真动作条件：tickd 档认配置；CLI 档需 --go（生态铁律：动生产一律默认 dry-run）。--force 供单次演练。
    const willAct = force || (tickMode ? enabled : (has('--go') && enabled));
    const snap = collectRepairState({ timeoutMs: 30_000 });
    const finishMarkerExists = fs.existsSync(path.join(snap.stateDir, 'repair-finish.json'));
    const dec = decide({ repair: snap, lingerMin: cfg.lingerMin ?? LINGER_MIN_DEFAULT, finishMarkerExists });
    console.log(`[repair-linger] ${dec.verdict}：${dec.detail}`);
    let result = null;
    if (dec.act && willAct) result = doFinish();
    else if (dec.act) console.log(`[repair-linger] 判定命中但**未放行**（tickd 档看配置 lingerAutoFinish / CLI 档需 --go）⇒ 零动作`);
    appendLedger({
      at: new Date().toISOString(), verdict: dec.verdict, detail: dec.detail,
      acted: !!(dec.act && willAct), finish: result, enabled, tickMode,
    });
    process.exitCode = result && result.ok === false ? 1 : 0;
  }
}

export { doFinish };
