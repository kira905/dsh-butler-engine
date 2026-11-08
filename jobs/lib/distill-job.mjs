// dsh-butler / lib/distill-job.mjs —— 记忆提炼 job 的执行体（记忆引擎 v2 · S3c）
//
// 形态（方案 §3.5 第 3 条 · P1 已拍）：**`butler-auto-tick.mjs --job distill`**
//   ⇒ 这样才有"真正的 job 级模块门"（tickd 的模块门只认 `tickd-jobs` 一个 id），
//     并复用既有 tick 调度器的**锁 + 失败隔离 + 日报**三条通道；
//     成本闸（调用次数 / token）则由引擎侧自带（本生态第一个"无人值守调 LLM 的 tickd job"）。
//
// 闸门（三道，缺一不可；全部 fail-closed）：
//   ① **L0 降档闸**：`butler-autonomy-state.json` 的 level≠normal ⇒ 一律拒动（同 runAction 口径）
//   ② **L2 模块门 `memory-distill`**：
//        · 配置文件（`butler-autonomy.json`）**读得到、且没有该模块的显式覆盖项** ⇒ **放行**
//          （默认关的唯一权威层 = `jobs['memory-distill'].enabled=false`；本卡不另立第二把默认关闸）
//        · 显式写了 `modules['memory-distill'].enabled=false` ⇒ **挡住**（这才是名副其实的 kill switch）
//        · 配置文件**读不到 / 损坏** ⇒ **挡住**（fail-safe 方向 = 判关；宁可不动，不瞎花无人值守的钱）
//   ③ 引擎入口存在（`tools/memory-engine/cli/distill.mjs`）—— 缺失 ⇒ 安全跳过（exit 3 语义，不计失败）
//
// ⚠️ 为什么不走 `runAction()`：`memory-distill` 不属生态四键所管的"有闸自主动作"
//    （`lib/autonomy-modules.mjs` 该行的 noOwnerWhy 已写明"放行由 jobs 段单键决定"），
//    强行叠四键会出现"两把总闸谁说话"的歧义；本 job 的闸门就是上面三道 + tickd 的 job 开关。
import fs from 'node:fs';
import { workspaceRoot } from './ws-root.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { readModules } from '../../src/dsh-butler/lib/autonomy-modules.mjs';
import { checkAutonomyAllowed } from '../../src/dsh-butler/lib/autonomy-state.mjs';
// 【2026-10-10 · 补坑库联动BCD】D 点：同一 job 内加独立 phase `p4-digest`
//   （接入点选择真源 = 方案 §D.2 第 7 行「本方案选"加 phase"：phase = 'distill' | 'p4-digest'」）
import { runP4Digest } from './p4-digest.mjs';
// 【V3.0.0 地基 · D-8（2026-10-19）】P4 段缺省接**自家链** LLM（`llm-client.mjs#llmText`）。
//   `p.p4LlmCall === null` 才表示显式关；`undefined`（= 调用方没传）⇒ 接适配器。
import { makeP4LlmCall } from './p4-llm-call.mjs';

export const DISTILL_JOB_VERSION = '0.1.0';

/** 本 job 的 phase（方案 §D.2-7）；`all` = 两段都跑，各自独立 try/catch */
export const DISTILL_PHASES = Object.freeze(['distill', 'p4-digest', 'all']);

/** 引擎目录解析：显式参数 > 环境变量 > `<workspace>\tools\memory-engine`（跨机同口径，不写主机名常量）。 */
export function resolveEngineDir(explicit = null, env = process.env) {
  if (explicit) return path.resolve(String(explicit));
  if (env.MEMORY_ENGINE_DIR) return path.resolve(String(env.MEMORY_ENGINE_DIR));
  return path.join(workspaceRoot(), 'tools', 'memory-engine');
}

/**
 * L2 模块门判定（**本文件是唯一实现**；口径见文件头 ②）。
 * @returns {{allowed:boolean, reason:string, source:string, enabled:boolean|null, explicit:boolean}}
 */
export function moduleGate(home) {
  const r = readModules({ home });
  const id = 'memory-distill';
  if (!r.ok) return { allowed: false, reason: `自治配置不可用（${r.reason}）⇒ 判关`, source: 'fail-safe', enabled: null, explicit: false };
  const cell = r.modules?.[id] ?? null;
  if (!cell) return { allowed: true, reason: '模块未在配置里显式覆盖 ⇒ 由 jobs 段单键决定（本卡不另立默认关）', source: 'baseline', enabled: null, explicit: false };
  if (cell.source === 'file' && cell.enabled === false) {
    return { allowed: false, reason: `L2 模块显式关（modules['${id}'].enabled=false${cell.why ? `: ${cell.why}` : ''}）`, source: 'file', enabled: false, explicit: true };
  }
  return { allowed: true, reason: `L2 模块未显式关闭（source=${cell.source}）`, source: cell.source, enabled: cell.enabled === true, explicit: false };
}

/** 三道闸门汇总（只读，零副作用；供 job 与单测共用）。 */
export function resolveDistillGates({ home = dshHome() } = {}) {
  const l0 = checkAutonomyAllowed({ home });
  const mod = moduleGate(home);
  const gates = {
    l0: { allowed: l0.allowed === true, level: l0.level, reason: l0.reason },
    module: mod,
  };
  if (!gates.l0.allowed) return { allowed: false, reason: `L0 降档中（level=${l0.level}）：${l0.hint}`, blockedBy: 'l0', gates };
  if (!mod.allowed) return { allowed: false, reason: mod.reason, blockedBy: 'module', gates };
  return { allowed: true, reason: 'ok', blockedBy: null, gates };
}

/** 引擎 CLI 的默认参数（路径全部可注入 ⇒ 隔离 home / 副本库测试不必改代码）。 */
export function buildEngineArgs({ memoryDb, vectorsDb, stateFile, now, windowHours, limit, maxCalls, maxTokens, snapshotDir, apply }) {
  const args = ['--db', memoryDb, '--json'];
  if (vectorsDb) args.push('--vectors-db', vectorsDb);
  if (stateFile) args.push('--state', stateFile);
  if (now) args.push('--now', new Date(Number(now)).toISOString());
  if (windowHours != null) args.push('--window-hours', String(windowHours));
  if (limit != null) args.push('--limit', String(limit));
  if (maxCalls != null) args.push('--max-calls', String(maxCalls));
  if (maxTokens != null) args.push('--max-tokens', String(maxTokens));
  if (snapshotDir) args.push('--snapshot-dir', snapshotDir);
  args.push(apply ? '--apply' : '--dry-run');
  return args;
}

/**
 * 跑一轮提炼（**真的只做三件事**：判闸 → spawn 引擎 CLI → 归一结果）。
 *
 * @param {object} p
 * @param {string} p.home           butler home（判定与 state 的基准）
 * @param {number} p.now            时间戳（调度的"现在"）
 * @param {boolean} p.dryRun        true ⇒ 引擎也走 --dry-run（零写入、零调用）
 * @param {string} [p.engineDir]
 * @param {string} [p.memoryDb]     记忆库（**测试/开发一律副本**；缺省 = <home>/memory/memory.db）
 * @param {Function} [p.run]        注入式 runner（单测用；生产走 spawnSync）
 * @param {number} [p.timeoutMs]
 * @returns {{ok:boolean, status:string, reason:string|null, detail:object, summary:string}}
 */
export function runMemoryDistill(p = {}) {
  const home = p.home ?? dshHome();
  const now = Number(p.now ?? Date.now());
  const dryRun = p.dryRun === true;
  const engineDir = resolveEngineDir(p.engineDir);
  const cli = path.join(engineDir, 'cli', 'distill.mjs');
  const memoryDb = p.memoryDb ? path.resolve(String(p.memoryDb)) : path.join(home, 'memory', 'memory.db');
  const vectorsDb = p.vectorsDb ? path.resolve(String(p.vectorsDb)) : path.join(home, 'memory-vectors', 'vectors.db');
  const stateFile = p.stateFile ? path.resolve(String(p.stateFile)) : resolveStatePath('butler-distill-state.json', { home }).path;

  const gate = resolveDistillGates({ home });
  const detailBase = {
    engineDir, cli, memoryDb, vectorsDb, stateFile, dryRun, gates: gate.gates,
  };

  if (!gate.allowed) {
    return {
      ok: true, status: 'blocked', reason: gate.reason,
      detail: { ...detailBase, blockedBy: gate.blockedBy },
      summary: `memory-distill：blocked（${gate.reason}）`,
    };
  }
  if (!fs.existsSync(cli)) {
    // 环境态"让路"：引擎没装 ⇒ 什么都不做（tickd 记 ok，不刷红；与 memory-vectors job 同口径）
    return {
      ok: true, status: 'skipped-no-engine', reason: `引擎入口缺失：${cli}`,
      detail: { ...detailBase },
      summary: 'memory-distill：skipped-no-engine（引擎未部署 ⇒ 安全跳过）',
    };
  }
  if (!fs.existsSync(memoryDb)) {
    return {
      ok: true, status: 'skipped-missing-db', reason: `记忆库不存在：${memoryDb}`,
      detail: { ...detailBase },
      summary: 'memory-distill：skipped-missing-db（本机没有记忆库 ⇒ 安全跳过）',
    };
  }

  const args = buildEngineArgs({
    memoryDb, vectorsDb, stateFile, now,
    windowHours: p.windowHours, limit: p.limit, maxCalls: p.maxCalls, maxTokens: p.maxTokens,
    snapshotDir: p.snapshotDir, apply: !dryRun,
  });

  let proc;
  if (typeof p.run === 'function') {
    proc = p.run({ cli, args, cwd: engineDir, env: process.env });
  } else {
    proc = spawnSync(process.execPath, [cli, ...args], {
      cwd: engineDir,
      encoding: 'utf8',
      timeout: Number(p.timeoutMs ?? 30 * 60_000),
      windowsHide: true,
      env: { ...process.env },
    });
  }
  const stdout = String(proc.stdout ?? '');
  const stderr = String(proc.stderr ?? '');
  const exitCode = proc.status ?? (proc.error ? 1 : 0);
  let parsed = null;
  try { parsed = JSON.parse(stdout.trim()); } catch { /* 非 JSON：留给失败分支报错 */ }

  if (exitCode !== 0 || !parsed || parsed.ok === false) {
    return {
      ok: false, status: 'collect-failed',
      reason: (parsed && (parsed.stopping || `引擎退出码 ${exitCode}`)) || proc.error?.message || `引擎退出码 ${exitCode}`,
      detail: { ...detailBase, exitCode, args, stdoutTail: stdout.slice(-600), stderrTail: stderr.slice(-600), engine: parsed },
      summary: `memory-distill：失败（引擎退出码 ${exitCode}）`,
    };
  }

  const written = Number(parsed.written ?? 0);
  const cost = parsed.cost ?? {};
  const used = Number(cost.promptTokens ?? 0) + Number(cost.completionTokens ?? 0);
  const limits = parsed.limits ?? {};
  const status = dryRun ? 'dry-run' : (parsed.stopping ? 'stopped' : 'ok');
  return {
    ok: true, status, reason: parsed.stopping ?? null,
    detail: {
      ...detailBase,
      exitCode,
      mode: parsed.mode,
      inputs: parsed.inputs,
      clusterStats: parsed.clusterStats,
      dirty: parsed.dirty,
      planned: parsed.planned,
      calls: parsed.calls,
      written,
      writtenIds: parsed.writtenIds,
      cost,
      stopping: parsed.stopping,
      warnings: parsed.warnings,
      dailyLine: parsed.dailyLine,
      ownerUser: parsed.ownerUser,
      ownerSource: parsed.ownerSource,
      engine: { mode: parsed.mode, model: parsed.model, limits },
    },
    summary: `memory-distill：${status} · 提炼 ${written} 条 · 输入 ${parsed.inputs?.accepted ?? 0} 条`
      + ` · 当日调用 ${cost.calls ?? 0}/${limits.callsPerDay ?? '?'} · token ${used}/${limits.tokensPerDay ?? '?'}`
      + (parsed.stopping ? ` · 停机：${parsed.stopping}` : ''),
  };
}

// ───────────────────────── D 点：phase = 'p4-digest'（方案 §6 / §D.2-7） ─────────────────────────
//
// 设计要点（逐条对着方案原文）：
//   · **独立 try/catch**：本段抛错 / 超时 / LLM 不可用 ⇒ 只影响本段的 `status`，
//     **`memory-distill` 的 job 状态仍写 ok**（§D.5 的 gate 顺序断言）；
//   · **默认不拖垮主段**：P4 段默认关（闸文件 `~/.dsh/butler-p4-digest.json` 缺省 = 关）
//     ⇒ 关着时本段返回 `skipped-disabled`，**`summary` 与 `ok/status` 一字不改**（默认行为等价）；
//   · 两段出口写进同一 `summary` 的两行（§D.2-7）。

/**
 * 跑 P4 消化段（**永不抛错**：异常一律收敛成 `status:'p4-error'`）。
 * @param {object} p 与 `runMemoryDistill` 同族的可注入参数 + `phase` 相关项
 */
export async function runP4DigestSegment(p = {}) {
  const home = p.home ?? dshHome();
  const now = Number(p.now ?? Date.now());
  try {
    // D-8：缺省接自家链（`p4LlmCall === null` = 显式关；传函数 = 注入/演练）
    // ⚠️ job 的 dry-run 缺省**不调 LLM**（零花费 = dry-run 的应有语义）；要预览真实结论请显式注入 `p4LlmCall`。
    const llmCall = p.p4LlmCall !== undefined
      ? p.p4LlmCall
      : (p.dryRun === true ? null : makeP4LlmCall());
    return await runP4Digest({
      home,
      now,
      dryRun: p.dryRun === true,
      minCount: p.p4MinCount,
      triageFile: p.triageFile ?? null,
      pitfallsFile: p.pitfallsFile ?? null,
      clustersFile: p.clustersFile ?? null,
      llmCall,
      maxCalls: p.maxCalls,
      maxTokens: p.maxTokens,
      lock: p.lock !== false,
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    return {
      ok: true,
      status: 'p4-error',
      reason: msg,
      detail: { home, phase: 'p4-digest', error: msg },
      summary: `p4-digest：段内异常（**不影响主段**）：${msg.slice(0, 160)}`,
      suggestions: [],
      written: false,
    };
  }
}

/**
 * 跑整个 job（两段编排）。**这是 job 的入口**；`runMemoryDistill` 保留为「只看 distill 段」的同步实现
 * （既有单测与调用方**一字不改** ⇒ 满足「参数化前后行为对照」）。
 *
 * @param {object} p 全部透传；新增 `phase`（缺省 `'all'`）
 * @returns {Promise<object>} `{ok, status, reason, detail, summary, p4}` —— 形状与 `runMemoryDistill` 同族
 */
export async function runDistillJob(p = {}) {
  const raw = String(p.phase ?? 'all');
  const phase = DISTILL_PHASES.includes(raw) ? raw : 'all';
  const wantDistill = phase === 'distill' || phase === 'all';
  const wantP4 = phase === 'p4-digest' || phase === 'all';

  let base = null;
  if (wantDistill) {
    base = runMemoryDistill(p);
  } else {
    base = {
      ok: true,
      status: 'skipped-phase',
      reason: 'phase=p4-digest：未请求 distill 段',
      detail: { home: p.home ?? dshHome(), phase },
      summary: null,
    };
  }

  let p4 = null;
  if (wantP4) p4 = await runP4DigestSegment(p);

  // P4 段：**只在真的跑了（非"默认关跳过"）时**才往 summary 加一行 —— 默认关 ⇒ summary 与旧行为逐字一致
  const p4Line = p4 && p4.status !== 'skipped-disabled' ? p4.summary : null;
  const mergedSummary = base.summary == null ? (p4?.summary ?? 'memory-distill：未执行任何段')
    : (p4Line ? `${base.summary}\n${p4Line}` : base.summary);

  return {
    ...base,
    ok: base.ok, // ⚠️ P4 段不参与 job 成败判定（§D.5 断言）
    detail: {
      ...(base.detail ?? {}),
      phase,
      ...(p4 ? {
        p4Digest: {
          status: p4.status,
          reason: p4.reason ?? null,
          written: p4.written === true,
          suggestions: Array.isArray(p4.suggestions) ? p4.suggestions.length : 0,
          detail: p4.detail ?? null,
        },
      } : {}),
    },
    summary: mergedSummary,
    p4: p4 ?? null,
  };
}
