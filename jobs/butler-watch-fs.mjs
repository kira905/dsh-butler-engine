#!/usr/bin/env node
// dsh-butler / butler-watch-fs.mjs —— P5 磁盘层兜底 watcher（方案 v2.4 补强）
//
// 为什么要有这一层：A 层（fs/* + tools/pre-execute 门）只覆盖 DSH 的 write / edit 工具，
//   pwsh + node writeFileSync 完全绕过 → **A 层失效不等于审计失效**，必须有独立于写入通道的兜底。
// 做法：按受管文件清单比对内容 hash（不依赖任何写入通道）→ 变更即跑同一套规则引擎
//   → 违规用「本机快照」回滚 + 🔴 告警。
//
// 两种模式：
//   --once   单次扫描比对（默认；适合计划任务，无常驻进程、无黑窗）
//   --watch  常驻 fs.watch 实时模式（可选）
//
// 回滚门（裸跑期「开关清单」③ · 方案 §5）：默认读 `~/.dsh/butler-autonomy.json` 的
//   `p5-auto-rollback` 有效值（= autoHealEnabled && p5AutoRollbackEnabled）。
//   **默认 false → 发现违规只告警 + 落审计，不自动回滚（降人工确认）**；
//   配置读不到 / 非法 = 关（fail-safe）。显式覆盖：`--rollback` / `--no-rollback`。
//   未回滚时采纳新 hash（避免每 tick 重复报同一条违规），旧快照保留（放开回滚即可回到最近合法内容）。
//
// 状态文件：~/.dsh/butler-watch-fs-state.json（schemaVersion 1，单机快照索引 → 禁止随仓1同步）
// 快照目录：<tmp>\butler-watch-snap\<sha1(路径)>\<文件名>
//
// 用法：
//   node butler-watch-fs.mjs [--once|--watch] [--json] [--dry-run] [--rollback|--no-rollback] [--home <dir>] [--dsh-root <dir>]
// 退出码：0 正常（含"发现违规并回滚"）/ 1 扫描自身失败 / 2 用法错误
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dshHome } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { readJson, writeJsonAtomic, writeTextAtomic } from '../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../src/dsh-butler/lib/dual-write.mjs';
import { appendAudit } from '../src/dsh-butler/lib/audit.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { loadRules } from './lib/audit-cli.mjs';
import { makeClassifier, DEFAULT_DSH_ROOT } from './lib/protected-paths.mjs';
import { isButlerWritten } from './lib/butler-write-paths.mjs';
import { autoAllowed } from '../src/dsh-butler/lib/autonomy.mjs';
// P9 H4（2026-09-28）：交接窗口单一真相（running / TTL / 超时自动恢复）——判定全在 lib/handoff-window.mjs
import { judgeHandoffRun, readHandoffRecord, HANDOFF_RUNNING_TTL_MS } from '../src/dsh-butler/lib/handoff-window.mjs';

export const WATCH_FS_VERSION = '0.1.0';
export const WATCH_FS_SCHEMA = 1;
/** 【2c-B3】状态路径统一入口（legacy 期 = 旧名，行为零变化）。 */
function stateFileOf(name, home) {
  return resolveStatePath(name, { home: home ?? dshHome() }).path;
}
export const STATE_NAME = 'butler-watch-fs-state.json';
const SNAP_DIR = path.join(os.tmpdir(), 'butler-watch-snap');
const TEXT_EXT = /\.(md|mjs|cjs|js|json|yml|yaml|ps1|cmd|bat|vbs|txt)$/i;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEBOUNCE_MS = 800;

const USAGE = [
  'butler-watch-fs —— P5 磁盘层兜底 watcher（不依赖写入通道）',
  '  node butler-watch-fs.mjs [--once|--watch] [--json] [--dry-run] [--rollback|--no-rollback] [--home <dir>] [--dsh-root <dir>]',
  '  回滚默认由总开关（autonomy 配置的 p5-auto-rollback）决定（裸跑期默认关 = 只告警）',
].join('\n');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function snapPathFor(file) {
  const key = sha256(Buffer.from(file, 'utf8')).slice(0, 16);
  return path.join(SNAP_DIR, key, path.basename(file));
}

/** 受管文件清单：A 层（persona / skills / 核心启动链）+ B 层（docs）。
 *  **自指豁免（方案 §4 P4 v2.4）**：管家自身写入的路径（坑库 / 管家报告 / 变更流水渲染视图 /
 *  审计 JSONL / butler-* 状态文件）不进受管清单——否则 P4 自动写坑库会被本层判违规并回滚（死循环）。 */
export function buildWatchList(opts = {}) {
  const home = opts.home ?? dshHome();
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const classify = makeClassifier({ home, dshRoot });
  // P9 §5.5「P5 自指闭环」第①层：交接**进行中**额外豁免"交接分发目标"（启动链 dsh-start/shutdown/restart）。
  //   为什么必须按窗口豁免（2026-09-16 H3 实测取舍）：启动链属 A 层保护区，**永久**豁免等于让 A 层对
  //   启动链失效（persona/技能测试明确要求「A 层绝不能被豁免」）⇒ 只在交接窗口内豁免，窗口真假由调用方判。
  const handoffActive = opts.handoffActive === true;
  const out = [];
  const exempt = (full) => isButlerWritten(full, { home, dshRoot, handoffActive }).hit === true;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(node_modules|\.git|_archive|generated|logs|snapshots|backups|_tmp)$/i.test(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && TEXT_EXT.test(e.name)) {
        const hit = classify(full);
        if (hit && !exempt(full)) out.push({ file: full, tier: hit.tier, zone: hit.id });
      }
    }
  };
  // A 层目录
  walk(path.join(home, '.agent-presets'), 0);
  walk(path.join(home, 'skills'), 0);
  // DSH 根：只取直属文件（不递归，避免 _archive/generated 等大目录）
  try {
    for (const e of fs.readdirSync(dshRoot, { withFileTypes: true })) {
      if (!e.isFile() || !TEXT_EXT.test(e.name)) continue;
      const full = path.join(dshRoot, e.name);
      const hit = classify(full);
      if (hit && !exempt(full)) out.push({ file: full, tier: hit.tier, zone: hit.id });
    }
  } catch { /* ignore */ }
  // docs（B 层）
  walk(path.join(dshRoot, 'docs'), 0);
  return out;
}

/** 跑规则（只读检查，不写盘）。 */
export async function runRulesOn(text, target) {
  const rules = loadRules();
  const findings = [];
  for (const r of rules) {
    try {
      const mod = await r.loader();
      const def = mod?.default ?? mod?.rule ?? null;
      if (!def || typeof def.check !== 'function') continue;
      const raw = await def.check({
        mode: 'watch-fs', file: target, target, text,
        sha256: sha256(Buffer.from(text, 'utf8')), bytes: Buffer.byteLength(text, 'utf8'), truncated: false,
        meta: { basename: path.basename(target) },
      });
      const list = Array.isArray(raw) ? raw : (raw && raw.ok === false ? [raw] : []);
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        findings.push({ rule: def.id ?? r.id, level: item.level ?? def.level ?? 'warn', message: item.message ?? '命中' });
      }
    } catch (e) {
      findings.push({ rule: r.id, level: 'error', message: `规则执行失败：${e?.message ?? e}` });
    }
  }
  return findings;
}

function ensureSnap(file, buf) {
  const dst = snapPathFor(file);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    return dst;
  } catch {
    return null;
  }
}

/**
 * 单次扫描（纯函数化便于单测：传入 opts.now / opts.home / opts.dshRoot / opts.dryRun）。
 * @returns {Promise<{ok:boolean, scanned:number, changed:number, violations:Array, rolledBack:number, firstSeen:number, errors:Array}>}
 */
export async function scanOnce(opts = {}) {
  const home = opts.home ?? dshHome();
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const stateFile = stateFileOf(STATE_NAME, home);
  const dryRun = opts.dryRun === true;
  // 回滚门（裸跑期「开关清单」③）：显式 CLI 优先，否则读自治配置（fail-safe：读不到 = 关）。
  const rollbackGate = opts.rollback === true ? { allowed: true, reason: 'cli:--rollback' }
    : opts.rollback === false ? { allowed: false, reason: 'cli:--no-rollback' }
      : (() => { const g = autoAllowed('p5-auto-rollback', { home }); return { allowed: g.allowed === true, reason: `autonomy:${g.reason}` }; })();
  const rollbackOn = !dryRun && rollbackGate.allowed === true;
  const log = opts.logger ?? (() => {});
  let state = { schemaVersion: WATCH_FS_SCHEMA, files: {}, updatedAt: null };
  try {
    const cur = readJson(stateFile, { schemaVersion: WATCH_FS_SCHEMA });
    if (cur && typeof cur === 'object') state = { ...state, ...cur, files: cur.files ?? {} };
  } catch { /* 首次运行 / 版本不符 → 重建（快照索引可重建，非权威数据） */ }

  // ---- P9 §5.5 自指闭环② / §17.2 T8：交接进行中 → 暂停"违规处置"（只告警不回滚）
  //   判据 = lib/handoff-window.mjs（交接锁为主信号 + TTL 30min；超时**自动恢复**，绝不永久暂停）。
  //   为什么暂停：交接器分发是"生产路径 → 生产路径"的合法写入，但 watcher 拿不到写入通道身份，
  //   若照常判违规并回滚，会把刚分发的内容**回滚掉**（正是 §5.5 要防的自指闭环）。
  let handoff = null;
  try {
    handoff = opts.handoff ?? judgeHandoffRun(readHandoffRecord({ home }), { home, now: opts.now });
  } catch (e) {
    handoff = { active: false, mode: 'absent', timedOut: false, reason: `交接窗口判定失败（fail-safe：不暂停）：${e?.message ?? e}` };
  }
  const handoffPaused = handoff?.active === true;
  // TTL 超时 → **自动恢复审计** + 一次性 🟡（T8 要求"超时自动恢复 + 可见"）
  let timeoutNotified = false;
  if (handoff?.timedOut === true && !dryRun) {
    try {
      const key = String(handoff.startedAtMs ?? 'unknown');
      const st0 = readJson(stateFile, { schemaVersion: WATCH_FS_SCHEMA, defaultValue: null });
      if (st0?.suspendTimeoutKey !== key) {
        appendAudit({ type: 'handoff-suspend-timeout', action: 'audit-resumed', reason: handoff.reason, mode: handoff.mode, source: handoff.source ?? null }, { home, silent: true });
        alert({
          level: 'warn', source: 'butler-watch-fs',
          message: `交接暂停态超时 → 磁盘层审计已自动恢复：${String(handoff.reason).slice(0, 160)}`,
          detail: { kind: 'handoff-suspend-timeout', mode: handoff.mode, source: handoff.source ?? null, startedAtMs: handoff.startedAtMs ?? null, ttlMs: handoff.ttlMs ?? HANDOFF_RUNNING_TTL_MS },
        }, { home, silent: true });
        timeoutNotified = true;
      }
    } catch { /* 通知失败不影响本轮审计 */ }
  }

  const list = buildWatchList({ home, dshRoot, handoffActive: handoffPaused });
  const result = {
    ok: true, scanned: 0, changed: 0, violations: [], rolledBack: 0, firstSeen: 0, errors: [],
    // P9 H4：交接窗口面（可见，不静默）—— 暂停期间命中的项单独登记，窗口结束后会被重新判定
    pausedViolations: [],
    handoffPaused,
    handoff: handoff ? { active: handoff.active === true, mode: handoff.mode, source: handoff.source ?? null, timedOut: handoff.timedOut === true, reason: handoff.reason, ttlMs: handoff.ttlMs ?? null } : null,
    handoffTimeoutNotified: timeoutNotified,
  };
  const nextFiles = { ...state.files };

  for (const item of list) {
    result.scanned++;
    let buf;
    let st;
    try {
      st = fs.statSync(item.file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const prev = state.files[item.file];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        nextFiles[item.file] = prev; // 未变 → 跳过读取
        continue;
      }
      buf = fs.readFileSync(item.file);
    } catch (e) {
      result.errors.push({ file: item.file, error: String(e?.message ?? e) });
      continue;
    }
    const hash = sha256(buf);
    const prev = state.files[item.file];
    if (!prev) {
      // 首见：建立快照（此后作为回滚基准）
      result.firstSeen++;
      const snap = ensureSnap(item.file, buf);
      nextFiles[item.file] = { hash, size: buf.length, mtimeMs: st.mtimeMs, snap, tier: item.tier, zone: item.zone, at: Date.now() };
      continue;
    }
    if (prev.hash === hash) {
      nextFiles[item.file] = { ...prev, size: buf.length, mtimeMs: st.mtimeMs, snap: prev.snap ?? ensureSnap(item.file, buf) };
      continue;
    }
    // 内容变更 → 跑规则（⚠️ 快照只在"变更通过校验后"才更新，否则回滚会恢复到违规内容）
    result.changed++;
    const text = buf.toString('utf8');
    const findings = await runRulesOn(text, item.file);
    const blocked = findings.filter((f) => f.level === 'block' || f.level === 'error');
    if (!blocked.length) {
      const snap = ensureSnap(item.file, buf);
      nextFiles[item.file] = { hash, size: buf.length, mtimeMs: st.mtimeMs, snap, tier: item.tier, zone: item.zone, at: Date.now() };
      if (findings.length) log(`🟡 ${item.file}：写后审计 ${findings.length} 条 warn`);
      continue;
    }
    // P9 H4 · §5.5 自指闭环②：交接窗口内**只登记、不回滚、不告警**。
    //   为什么连 hash 也不采纳：窗口结束后同一项会被重新判一次 → 真违规仍会被抓，
    //   而"交接器合法写入"已被 handoffActive 豁免（第①层）挡在前面 ⇒ 不会误回滚、也不会放过。
    if (handoffPaused) {
      result.pausedViolations.push({ file: item.file, zone: item.zone, tier: item.tier, findings: blocked.slice(0, 5) });
      if (!dryRun) {
        appendAudit({
          type: 'handoff-paused-skip', via: 'watch-fs', path: item.file, zone: item.zone, tier: item.tier,
          findings: blocked.slice(0, 5), reason: handoff.reason,
        }, { home, silent: true });
      }
      log(`⏸ ${item.file}：交接窗口内 → 暂停处置（不回滚 / 不告警；窗口结束后复核）`);
      continue;
    }
    result.violations.push({ file: item.file, zone: item.zone, tier: item.tier, findings: blocked.slice(0, 5) });
    let rolledBack = false;
    if (rollbackOn && prev.snap && fs.existsSync(prev.snap)) {
      try {
        fs.copyFileSync(prev.snap, item.file);
        rolledBack = true;
        result.rolledBack++;
        // 回滚后保持旧 hash（快照内容）
        nextFiles[item.file] = { ...prev, mtimeMs: Date.now(), at: Date.now() };
      } catch (e) {
        result.errors.push({ file: item.file, error: `回滚失败：${e?.message ?? e}` });
      }
    } else if (!dryRun) {
      // 回滚门关闭（裸跑期）或快照缺失：只告警等人批。
      // 采纳新 hash → 同一条违规不再每 tick 重复报；旧快照保留 → 放开回滚即可回到最近合法内容。
      nextFiles[item.file] = {
        ...prev, hash, size: buf.length, mtimeMs: st.mtimeMs, at: Date.now(),
        violation: { at: Date.now(), count: blocked.length, rolledBack: false, gate: rollbackGate.reason },
      };
    }
    if (!dryRun) {
      appendAudit({
        type: 'audit-guard', action: 'post-block', via: 'watch-fs', path: item.file, zone: item.zone, tier: item.tier,
        rolledBack, rollbackGate: { allowed: rollbackGate.allowed === true, reason: rollbackGate.reason }, findings: blocked.slice(0, 5),
      }, { home, silent: true });
      alert({
        level: 'error',
        source: 'butler-watch-fs',
        message: `磁盘层审计发现违规：${path.basename(item.file)}（${blocked.map((b) => b.message).join('；').slice(0, 160)}）${rolledBack ? ' 已回滚' : ' 未回滚（只告警，待人工确认）'}`,
        detail: { file: item.file, findings: blocked.slice(0, 5), rolledBack, rollbackAllowed: rollbackGate.allowed === true, rollbackReason: rollbackGate.reason, snapshot: prev.snap ?? null },
      }, { home, silent: true });
    }
    log(`🔴 ${item.file}：违规 ${blocked.length} 条${rolledBack ? '，已回滚' : (rollbackOn ? '，未回滚（无快照）' : '，未回滚（回滚门关闭 → 人工确认）')}`);
  }

  if (!dryRun) {
    try {
      const dw = writeStateText(STATE_NAME, JSON.stringify({
        // 超时通知去重键要跨轮保留（否则窗口超时后会每 tick 报一次）
        ...(state.suspendTimeoutKey ? { suspendTimeoutKey: state.suspendTimeoutKey } : {}),
        ...(timeoutNotified ? { suspendTimeoutKey: String(handoff?.startedAtMs ?? 'unknown') } : {}),
        schemaVersion: WATCH_FS_SCHEMA, files: nextFiles, updatedAt: Date.now(),
      }, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
      if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
    } catch (e) {
      result.ok = false;
      result.errors.push({ file: stateFile, error: String(e?.message ?? e) });
    }
  }
  result.rollbackAllowed = rollbackGate.allowed === true;
  result.rollbackReason = rollbackGate.reason;
  result.dryRun = dryRun;
  return result;
}

/** 常驻实时模式（可选）：fs.watch + 防抖后单次扫描。 */
async function watchLoop(opts = {}) {
  const home = opts.home ?? dshHome();
  const dshRoot = opts.dshRoot ?? DEFAULT_DASH_ROOT();
  const targets = [
    path.join(home, '.agent-presets'),
    path.join(home, 'skills'),
    path.join(dshRoot, 'docs'),
  ].filter((d) => fs.existsSync(d));
  let timer = null;
  let running = false;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) return;
      running = true;
      try {
        const r = await scanOnce({ ...opts, home, dshRoot });
        if (r.changed) console.log(`[watch-fs] scanned=${r.scanned} changed=${r.changed} violations=${r.violations.length} rolledBack=${r.rolledBack}`);
      } finally {
        running = false;
      }
    }, DEBOUNCE_MS);
  };
  for (const t of targets) {
    try {
      fs.watch(t, { recursive: true }, () => trigger());
      console.log(`[watch-fs] watching ${t}`);
    } catch (e) {
      console.error(`[watch-fs] watch 失败 ${t}：${e?.message ?? e}`);
    }
  }
  await scanOnce({ ...opts, home, dshRoot });
  console.log('[watch-fs] 初始扫描完成，进入实时监听（Ctrl+C 退出）');
}

function DEFAULT_DASH_ROOT() { return DEFAULT_DSH_ROOT; }

function isMainEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const argv = process.argv.slice(2);
  const opt = { json: false, dryRun: false, home: null, dshRoot: null, watch: false, rollback: null };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') opt.json = true;
      else if (a === '--dry-run') opt.dryRun = true;
      else if (a === '--rollback') opt.rollback = true;
      else if (a === '--no-rollback') opt.rollback = false;
      else if (a === '--once') opt.watch = false;
      else if (a === '--watch') opt.watch = true;
      else if (a === '--home') opt.home = argv[++i];
      else if (a === '--dsh-root') opt.dshRoot = argv[++i];
      else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
      else throw new Error(`未知参数：${a}`);
    }
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  try {
    if (opt.watch) {
      await watchLoop(opt);
    } else {
      const r = await scanOnce({ ...opt, logger: (m) => { if (!opt.json) console.log(m); } });
      if (opt.json) process.stdout.write(JSON.stringify(r) + '\n');
      else {
        console.log(`${r.violations.length ? '🔴' : '✅'} 磁盘层扫描：${r.scanned} 个受管文件，变更 ${r.changed}，违规 ${r.violations.length}，回滚 ${r.rolledBack}，首见 ${r.firstSeen}`);
        console.log(`   回滚门：${r.rollbackAllowed ? '🟢 允许自动回滚' : '🔴 关闭（只告警，待人工确认）'} · ${r.rollbackReason}${r.dryRun ? ' · dry-run（不写状态）' : ''}`);
        for (const v of r.violations) console.log(`   - ${v.file}：${v.findings.map((f) => f.message).join('；').slice(0, 160)}`);
        for (const e of r.errors.slice(0, 5)) console.log(`   ! ${e.file}：${e.error}`);
      }
      process.exit(r.ok ? 0 : 1);
    }
  } catch (e) {
    console.error(`butler-watch-fs 失败：${e?.message ?? e}`);
    process.exit(1);
  }
}
