#!/usr/bin/env node
// dsh-butler / pitfall-tick.mjs —— P4 会学习：翻车复盘 tick（卡 [2a]）
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §4 P4（行 689-774）
// 形态：**短命 tick**（计划任务 DSH-Butler-PitfallTick，30 分钟一次，窗口隐藏），无常驻进程。
//
// 一次 tick 的流程：
//   0. 版本闸门（gateComponent）→ 不匹配跳过该组件 + 告警
//   1. tick 互斥锁（抢不到 = 静默退出，exit 0）
//   2. 读扫描记账（按 sessionId）
//   3. 扫两棵树（sessions + _archived-sessions）→ 增量解帧 → 提取 isError → 签名聚类
//   4. 合并坑库（butler-pitfalls.json）/ 记账（butler-pitfall-scan.json）/ 健康（butler-sessions-health.json）
//   5. 生成升级候选（≥3 次跨 ≥2 会话；**永不自动改 persona / 技能**）
//   6. 渲染 docs\坑库\*.md + 踩坑大全索引 + README
//   7. 告警：会话文件损坏 🔴 / 新升级候选 🟡
//   8. 坑库**真有变动** ⇒ 置「向量该同步了」脏标记（记忆引擎 A2 第 9 步接线 · 2026-10-10）
//      只置标记、不触发编码；失败只记日志、不阻断主 job。消费方见 memory-engine/lib/tick-hook.mjs
//
// 【真源闸（V31-039 · 2026-11-04）】上面 1~8 步**之前**先判「坑库真源」：
//   `butler-pitfalls.json` **不存在 / 读不出来 / pitfalls 为 0 条目** ⇒ **一个文件都不写**（分类文件 / 踩坑大全 /
//   README 全不落盘）+ 走 `lib/alert.mjs` 报一条 🔴（文案带真源绝对路径）+ 返回 `{ok:false, refused:<原因码>}`。
//   为什么：改前这三种真源缺失的形态是 `ok:true` + 照常渲染 8 个文件（自动段空壳）+ 退出码 0 + **零告警**
//   —— 下一个 30 分钟 tick 就把 `docs\坑库\*.md` 的自动段洗掉，而手工段（实测 130,865 B）脚本永远产不出来。
//   ⚠️ 退出码：拒渲染 ⇒ **5**（不是 0 也不是 1）。tickd 的 `JOBS.pitfall` 已声明 `benignExitCodes:[5]`
//      ⇒ lastStatus=`deferred`、failures 不涨（否则 30 分钟一轮会每轮都算失败、把历史失败率刷爆）；
//      "一直拒"仍看得见 —— tickd-health 对连续让路给 🟡。⚠️ 该注册表是 tickd **启动时**读进内存的，
//      改完要 tickd 重启才生效（脚本本体是每轮 spawn 新进程 ⇒ 闸本身当轮生效，不必重启任何东西）。
//
// 用法：
//   node pitfall-tick.mjs                 # 增量 tick（正常入口）
//   node pitfall-tick.mjs --full          # 全量重扫并重建坑库（保留 seed 条目）
//   node pitfall-tick.mjs --dry-run       # 只扫描不写盘
//   node pitfall-tick.mjs --no-render     # 不渲染 docs
//   node pitfall-tick.mjs --json          # 输出结构化结果
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome, statePath, realOrResolve, newRunId } from '../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { readJson, updateJson, writeJsonAtomic, writeTextAtomic, acquireTickLock } from '../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../src/dsh-butler/lib/dual-write.mjs';
import { updateStateJson } from '../src/dsh-butler/lib/dual-write-store.mjs';
import { appendAudit } from '../src/dsh-butler/lib/audit.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { gateComponent } from '../src/dsh-butler/lib/version.mjs';
import { loadExcludeFixture } from '../src/dsh-butler/lib/pitfall-sign.mjs';
import { scanHome, deviceName } from '../src/dsh-butler/lib/pitfall-scan.mjs';
import {
  PITFALLS_SCHEMA, SCAN_SCHEMA, HEALTH_SCHEMA, CANDIDATES_SCHEMA,
  emptyPitfalls, emptyScanState, emptyHealth, emptyCandidates,
  applyScanToState, applyScanState, applyHealth, applyCandidates, summarizePitfalls,
} from './lib/pitfall-store.mjs';
import { defaultDocsRoot, renderAll } from './lib/pitfall-render.mjs';
import { hostTag } from '../src/dsh-butler/lib/host-tag.mjs';
import { firstH1Index, insertAtFor } from '../src/lib/generated-docs.mjs'; // §2.2 权威源（档级标记插入点）
import { rankPitfalls, topN } from './lib/pitfall-score.mjs';

export const VERSION = '0.1.0';
export const TICK_NAME = 'p4-pitfall';
export const TASK_NAME = 'DSH-Butler-PitfallTick';
export const COMPONENT = 'butler-pitfall';
/** 两次 tick 间隔（计划任务同值）。 */
export const INTERVAL_MS = 30 * 60_000;

/** 读「踩坑大全-<host>.md」现有全文（拿不到 ⇒ 空串）——**仅**用于 §2.2 档级标记插入点的计算。
 *  口径：踩坑大全的 H1 可能深在自动索引段之后（host-c 实测 H1 索引 44）⇒ 必须按真实文本夹紧。 */
function readPitfallIndexText(opts) {
  try {
    return fs.readFileSync(path.join(opts?.docsRoot ?? defaultDocsRoot(), `踩坑大全-${hostTag(opts ?? {})}.md`), 'utf8');
  } catch { return ''; }
}

export function filesFor(home) {
  return {
    pitfalls: statePath('butler-pitfalls.json', home),
    scan: resolveStatePath('butler-pitfall-scan.json', { home }).path,
    health: resolveStatePath('butler-sessions-health.json', { home }).path,
    candidates: resolveStatePath('butler-p4-candidates.json', { home }).path,
  };
}

/** 记忆引擎坑源脏标记**文件名**（与 `memory-engine/lib/tick-hook.mjs` 的 `MARKER_FILENAME` 同值）。
 *  这里复写一份只为让本文件的接线自解释（真正写盘用 memory-engine 的 `markerPathFor()`）；
 *  一致性由回归单测 `_test/test-pitfall-dirty-mark.mjs` 断言 —— 改名时两边一起改。 */
/** 名字常量 → 统一状态入口（覆盖窗口要它贴在上面；函数提升，供 filesFor 用）。 */
function stateFileOf(name, home) { return resolveStatePath(name, { home }).path; }

export const PITFALL_DIRTY_FILENAME = 'butler-pitfall-vector-dirty.json';

/**
 * 本轮坑库**变动量**（纯函数，可单测）：新增 / 计数或末次出现变化 / 被移除。
 * @param {object|null} before 本轮写盘之前的坑库状态
 * @param {object|null} after  本轮写盘之后的坑库状态
 * @returns {{added:number, updated:number, removed:number, total:number}}
 */
export function diffPitfalls(before, after) {
  const b = new Map((before?.pitfalls ?? []).map((p) => [p.id, p]));
  const a = new Map((after?.pitfalls ?? []).map((p) => [p.id, p]));
  let added = 0;
  let updated = 0;
  for (const [id, p] of a) {
    const prev = b.get(id);
    if (!prev) { added += 1; continue; }
    if ((Number(prev.count) || 0) !== (Number(p.count) || 0) || (prev.lastSeen ?? null) !== (p.lastSeen ?? null)) updated += 1;
  }
  let removed = 0;
  for (const id of b.keys()) if (!a.has(id)) removed += 1;
  return { added, updated, removed, total: a.size };
}

/**
 * 【记忆引擎 A2 · 第 9 步接线 · 2026-10-10】坑库真有变动 ⇒ 置「向量该同步了」脏标记。
 *
 * 语义与边界（方案 §4.1 A2 / `docs\现状-记忆引擎线-20261010.md` §2.4）：
 *   · **只在真有变动时置**（findings / 新增 / 计数变 / 移除 / `--full` 重建，任一 >0）——
 *     绝不每轮无条件置，否则每 30 分钟制造一次无意义同步；
 *   · **只置标记、不触发编码**：松耦合信号，消费方 = memory-engine 的 `runPitfallHook`
 *     或 CLI `pitfall-hook.mjs --run --apply`（本 job 不因此变慢）；
 *   · 置标记方必须写 `updatedAt`（`markDirty` 内置；清标记方的 stale 判定依赖它）；
 *   · **失败绝不阻断主 job**：模块缺失 / 路径不可写 / rename 失败 ⇒ 记一条审计 + 一行 stderr，
 *     主 job 照常收尾（≤1 条/轮，不会打爆日志）。
 * @returns {Promise<{marked:boolean, state:'marked'|'no-change'|'failed', path?:string, updatedAt?:number, reason?:string, error?:string}>}
 */
async function markVectorDirtyIfChanged({ home, delta, findings, full }) {
  const changed = findings > 0 || delta.added > 0 || delta.updated > 0 || delta.removed > 0 || full === true;
  if (!changed) return { marked: false, state: 'no-change' };
  const reason = `pitfall-tick: findings=${findings} +${delta.added} ~${delta.updated} -${delta.removed} total=${delta.total}${full ? '（--full 重建）' : ''}`;
  try {
    // 动态 import（不是 spawn）：不弹黑窗、不起子进程；memory-engine 侧缺失/加载失败只落 catch。
    const mod = await import('./ext/tick-hook.mjs');
    const file = stateFileOf(PITFALL_DIRTY_FILENAME, home);
    const r = mod.markDirty(file, {
      reason,
      by: 'dsh-butler/pitfall-tick.mjs',
      counters: { findings, added: delta.added, updated: delta.updated, removed: delta.removed, total: delta.total },
    });
    return { marked: true, state: 'marked', path: r.path, updatedAt: r.updatedAt, reason };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    try { appendAudit({ type: 'p4-dirty-mark-failed', reason, error: msg.slice(0, 300) }, { home, silent: true }); } catch { /* 审计失败也不许外溢 */ }
    console.error(`[p4] 坑库脏标记置失败（不阻断主 job）：${msg}`);
    return { marked: false, state: 'failed', error: msg, reason };
  }
}

// ------------------------------------------------------------------ 真源闸（V31-039 · 2026-11-04）
// 拒渲染原因码（写进返回值 `refused`；也是报告 / tickd 状态里能直接 grep 的判据字符串）。
export const REFUSED_MISSING = 'refused-missing-source';
export const REFUSED_UNREADABLE = 'refused-unreadable-source';
export const REFUSED_EMPTY = 'refused-empty-source';
/** 拒渲染退出码（CLI 用；与 `JOBS.pitfall.benignExitCodes:[5]` 同值，改一处必须同批改另一处）。 */
export const REFUSED_EXIT_CODE = 5;

/**
 * 坑库真源能不能拿来渲染（**纯读、零写**，可在任何写盘之前调）。
 *
 * 三种不满足形态各给一个原因码（别合并成一个 "bad"：换机缺文件 / 半截写坏 / 真空库，处置完全不同）：
 *   ① 文件不存在（ENOENT）                        ⇒ refused-missing-source
 *   ② 读不出来 / 不是合法 JSON / pitfalls 不是数组  ⇒ refused-unreadable-source
 *   ③ 0 字节 / 全空白 / pitfalls 长度 0            ⇒ refused-empty-source
 *
 * ⚠️ 刻意**不**沿用 `store.readJson` 的「0 字节 = 尚无状态、回退 defaultValue」宽容语义：那是给"状态文件"的。
 *    真源不在就是不在 —— 宽容一次 = 静默把坑库洗成空壳一次。
 * @param {string} file 真源绝对路径（= `filesFor(home).pitfalls`）
 * @returns {{ok:true, path:string, count:number, bytes:number}|{ok:false, code:string, path:string, detail:string}}
 */
export function checkPitfallSource(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const enoent = e?.code === 'ENOENT';
    return {
      ok: false,
      code: enoent ? REFUSED_MISSING : REFUSED_UNREADABLE,
      path: file,
      detail: enoent ? '文件不存在（ENOENT）' : `读不出来：${e?.code ?? e?.message ?? String(e)}`,
    };
  }
  if (!raw.trim()) return { ok: false, code: REFUSED_EMPTY, path: file, detail: '文件 0 字节 / 全空白（视为空真源）' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: REFUSED_UNREADABLE, path: file, detail: `不是合法 JSON：${e?.message ?? String(e)}` };
  }
  const list = data?.pitfalls;
  if (!Array.isArray(list)) {
    return { ok: false, code: REFUSED_UNREADABLE, path: file, detail: `pitfalls 不是数组（实得 ${Array.isArray(data) ? 'array' : typeof list}）` };
  }
  if (list.length === 0) return { ok: false, code: REFUSED_EMPTY, path: file, detail: 'pitfalls 长度 0（真源在、但一条都没有）' };
  return { ok: true, path: file, count: list.length, bytes: Buffer.byteLength(raw, 'utf8') };
}

/**
 * 跑一轮。
 * @param {{home?:string, now?:number, full?:boolean, dryRun?:boolean, render?:boolean, docsRoot?:string, maxFiles?:number}} [opts]
 */
export async function runTick(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const runId = newRunId('p4');
  const files = filesFor(home);

  const gate = gateComponent(COMPONENT, VERSION, { home });
  if (!gate.run) return { ok: false, skipped: 'version-gate', gate, runId };

  const lock = acquireTickLock(TICK_NAME, { ttlMs: 10 * 60_000, home });
  if (!lock.ok) return { ok: false, skipped: 'locked', reason: lock.reason, runId };

  try {
    // ── 真源闸（V31-039）：**必须在任何写盘之前**判 —— 命中即一个文件都不写、报 🔴、直接返回。
    //   · `dryRun` 不改行为（它本来就不写盘）：判定只作为诊断字段带出去，不把 dry-run 变成失败。
    //   · 位置刻意放在「读扫描记账 / 扫两棵树」之前：既然要拒，就别先白扫一遍 1.7 MB 记账 + 全部会话文件。
    const sourceGate = checkPitfallSource(files.pitfalls);
    if (!sourceGate.ok) {
      if (!opts.dryRun) {
        alert({
          level: 'error',
          source: 'butler-pitfall',
          message: `🔴 坑库真源不可用（${sourceGate.code}），本轮拒渲染、一个文件都没写：${sourceGate.path}（${sourceGate.detail}）`
            + ' ｜ 现在 docs\\坑库 里还是上一版旧内容，别以为是空的；补回真源后下一轮 tick（30 分钟）自动恢复',
          detail: {
            reason: sourceGate.code,
            detail: sourceGate.detail,
            sourceFile: sourceGate.path,
            docsRoot: opts.docsRoot ?? defaultDocsRoot(),
            recover: '换机拷贝 / 从备份恢复 butler-pitfalls.json（或 seed-pitfalls 重建）后，下一轮 tick 自动恢复渲染',
          },
        }, { home });
        return { ok: false, refused: sourceGate.code, refusal: sourceGate, runId, device: deviceName() };
      }
    }

    const fixture = loadExcludeFixture();
    if (!fixture.ok) {
      alert({ level: 'warn', source: 'butler-pitfall', message: `排除清单 fixture 加载失败，本轮「不排除任何错误」（保守多记）：${fixture.error}`, detail: { file: fixture.file } }, { home });
    }

    const scanState = readJson(files.scan, { schemaVersion: SCAN_SCHEMA, defaultValue: emptyScanState(), home });
    const device = deviceName();
    const scan = scanHome({ home, scanFiles: scanState?.files ?? {}, now, fixture, full: opts.full, maxFiles: opts.maxFiles });

    if (opts.dryRun) {
      return {
        ok: true, runId, dryRun: true, device, sourceGate,
        stats: scan.stats,
        files: scan.files.length, todo: scan.todo.length, skipped: scan.skipped.length,
        findings: scan.errors.length,
        corrupt: scan.health.filter((h) => h.status === 'corrupt' || h.status === 'unreadable').length,
      };
    }

    // 「本轮坑库变动量」的对照基线（记忆引擎 A2 第 9 步接线用）：在**任何写盘之前**读一次。
    // 只读、不改；dry-run 已在上面提前 return ⇒ 到这里必为真跑。
    const pitfallsBefore = readJson(files.pitfalls, { schemaVersion: PITFALLS_SCHEMA, defaultValue: emptyPitfalls(), home });

    // 全量重建：保留 seed 条目，其余清零重算（防重复累加 count）
    if (opts.full) {
      updateJson(files.pitfalls, (cur) => ({
        ...emptyPitfalls(),
        pitfalls: (cur?.pitfalls ?? []).filter((p) => p.source === 'seed'),
      }), { schemaVersion: PITFALLS_SCHEMA, defaultValue: emptyPitfalls(), home });
    }

    const pitfallsState = updateJson(
      files.pitfalls,
      (cur) => applyScanToState(cur ?? emptyPitfalls(), { errors: scan.errors, now, device, runId }),
      { schemaVersion: PITFALLS_SCHEMA, defaultValue: emptyPitfalls(), home },
    );

    updateStateJson('butler-pitfall-scan.json', files.scan,
      (cur) => applyScanState(cur ?? emptyScanState(), { scanUpdates: scan.scanUpdates, stats: scan.stats, runId, now, device }),
      { schemaVersion: SCAN_SCHEMA, defaultValue: emptyScanState(), home },
    );

    const healthState = updateStateJson('butler-sessions-health.json', files.health,
      (cur) => applyHealth(cur ?? emptyHealth(), { rows: scan.health, now, device }),
      { schemaVersion: HEALTH_SCHEMA, defaultValue: emptyHealth(), home },
    );

    const candRes = applyCandidates(readJson(files.candidates, { schemaVersion: CANDIDATES_SCHEMA, defaultValue: emptyCandidates(), home }) ?? emptyCandidates(), { pitfalls: pitfallsState.pitfalls, now });
    const dw = writeStateText('butler-p4-candidates.json', JSON.stringify(candRes.state, null, 2) + '\n', { home, write: (p, t) => writeTextAtomic(p, t) });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));

    // 告警：会话文件损坏（数据风险，参考 9/1 修复案）
    const broken = scan.health.filter((h) => h.status === 'corrupt' || h.status === 'unreadable');
    if (broken.length) {
      alert({
        level: 'error',
        source: 'butler-pitfall',
        message: `会话文件健康异常 ${broken.length} 个（帧 0 / 帧解不开 / 不可读）——数据风险，建议跑既有 restore 流程`,
        detail: { files: broken.slice(0, 5).map((b) => ({ sessionId: b.sessionId, status: b.status, frameErrors: b.frameErrors, error: b.error ?? null })) },
      }, { home });
    }
    // 告警：新升级候选
    if (candRes.added.length) {
      alert({
        level: 'warn',
        source: 'butler-pitfall',
        message: `新增升级候选 ${candRes.added.length} 个（≥3 次跨 ≥2 会话，需主人批准，不会自动改 persona / 技能）`,
        detail: { candidates: candRes.added.slice(0, 5).map((c) => ({ sig: `${c.sigKey.slice(0, 80)}`, count: c.count, sessions: c.sessionCount, suggested: c.suggested })) },
      }, { home });
    }

    // §2.2 档级标记（`pitfall` 族 · `踩坑大全-<host>.md`）：插入点**由本处用权威源 `insertAtFor()` 算出**
    //   并下传给渲染器（返回值**真参与档头写入行拼接** —— §3.3-2b 静态断言 A 在本族的调用点）。
    //   为什么由 tick 先算：踩坑大全的 H1 可能深在自动索引段之后（host-c 实测 H1 索引 44 ⇒ 夹紧落 L5）；
    //   本处与渲染器两个来源都经 §2.2 夹紧到 [0, N-1] ⇒ 恒落在前 N 行窗口内，不会静默失豁免。
    const docMarkAt = insertAtFor(firstH1Index(readPitfallIndexText(opts)));
    const render = opts.render === false ? null : renderAll({ pitfalls: pitfallsState.pitfalls, docsRoot: opts.docsRoot, now, docMarkAt });

    const summary = summarizePitfalls(pitfallsState, now);
    const top = topN(pitfallsState.pitfalls, 3, now).map((p) => ({ sig: `${p.name}|${p.code}`, count: p.count, sessions: p.sessionCount, score: p.score, lastSeen: p.lastSeen, category: p.category }));

    // 【记忆引擎 A2 · 第 9 步】坑库本轮真有变动 ⇒ 置脏标记（只置标记、不编码；失败不阻断主 job）
    const pitfallDelta = diffPitfalls(pitfallsBefore, pitfallsState);
    const dirtyMark = await markVectorDirtyIfChanged({
      home, delta: pitfallDelta, findings: scan.errors.length, full: opts.full === true,
    });

    appendAudit({
      type: 'p4-scan', runId, device,
      scanned: scan.stats.scanned, skipped: scan.skipped.length, bytes: scan.stats.bytes,
      findings: scan.errors.length, excluded: scan.stats.excluded,
      pitfallTotal: summary.total, recordable: summary.recordable, candidates: summary.candidates,
      corrupt: broken.length,
      pitfallDelta,
      dirtyMark: dirtyMark.state,
    }, { home, silent: true });

    return {
      ok: true, runId, device, full: opts.full === true,
      stats: scan.stats,
      roots: scan.roots,
      files: scan.files.length, todo: scan.todo.length, skipped: scan.skipped.length,
      findings: scan.errors.length,
      summary, top3: top,
      candidates: { added: candRes.added.length, pending: candRes.pending.length },
      health: { summary: healthState.summary, broken: broken.length },
      render,
      pitfallDelta,
      dirtyMark,
      sourceGate,
      filesOnDisk: files,
    };
  } finally {
    lock.release();
  }
}

/** 读坑库 + Top3（L1 开工简报用）。 */
export function readTop3(opts = {}) {
  const home = opts.home ?? dshHome();
  const state = readJson(filesFor(home).pitfalls, { schemaVersion: PITFALLS_SCHEMA, defaultValue: emptyPitfalls(), home });
  const now = opts.now ?? Date.now();
  return {
    ok: true,
    updatedAt: state?.updatedAt ?? null,
    summary: summarizePitfalls(state, now),
    top3: topN(state?.pitfalls ?? [], opts.n ?? 3, now),
    ranked: rankPitfalls(state?.pitfalls ?? [], now),
  };
}

// ------------------------------------------------------------------ CLI
const isMain = (() => {
  const a = process.argv[1] ? realOrResolve(process.argv[1]) : '';
  const b = realOrResolve(fileURLToPath(import.meta.url));
  return Boolean(a) && a === b;
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const opts = {
    full: argv.includes('--full') || argv.includes('--rebuild'),
    dryRun: argv.includes('--dry-run'),
    render: !argv.includes('--no-render'),
  };
  const asJson = argv.includes('--json');
  const r = await runTick(opts);
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else if (r.refused) {
    console.log(`[p4] 拒渲染: ${r.refused} —— ${r.refusal?.detail ?? ''}`);
    console.log(`[p4] 真源: ${r.refusal?.path ?? '?'}`);
    console.log('[p4] 一个文件都没写；docs\\坑库 仍是上一版旧内容（别以为是空的）');
  } else if (r.ok === false) {
    console.log(`[p4] skipped: ${r.skipped}${r.reason ? ` (${r.reason})` : ''}`);
  } else if (r.dryRun) {
    console.log(`[p4] dry-run: files=${r.files} todo=${r.todo} skipped=${r.skipped} findings=${r.findings} corrupt=${r.corrupt} elapsed=${r.stats.elapsedMs}ms`);
  } else {
    console.log(`[p4] runId=${r.runId} device=${r.device}`);
    console.log(`[p4] scanned=${r.stats.scanned}/${r.files} skipped=${r.skipped} bytes=${(r.stats.bytes / 1048576).toFixed(1)}MB frames=${r.stats.frames} frameErrors=${r.stats.frameErrors} elapsed=${r.stats.elapsedMs}ms`);
    console.log(`[p4] findings=${r.findings} excluded=${r.stats.excluded} 坑库=${r.summary.recordable}/${r.summary.total} 候选+${r.candidates.added}(待确认 ${r.candidates.pending})`);
    console.log(`[p4] 会话健康 ok=${r.health.summary.ok} warn=${r.health.summary.warn} corrupt=${r.health.summary.corrupt}`);
    if (r.top3.length) {
      console.log('[p4] Top3:');
      for (const t of r.top3) console.log(`   - ${t.sig} ｜ ${t.count} 次/${t.sessions} 会话 ｜ score ${t.score} ｜ ${t.category}`);
    }
    if (r.render) {
      console.log(`[p4] 坑库渲染（host=${r.render.host}）：${r.render.categories.map((c) => `${c.entries}${c.changed ? '*' : ''}`).join(' ')} ｜ 索引 ${r.render.index.entries} 条 ｜ README ${r.render.readme.changed ? '更新' : '未变'}`);
      console.log(`[p4] 落盘目录：${r.render.dir}（渲染物一律带主机短码；旧名单份文件已于 2026-09-14 清除，本版只写 host 名）`);
    }
    if (r.dirtyMark) {
      console.log(`[p4] 坑库脏标记：${r.dirtyMark.marked
        ? `已置 ${r.dirtyMark.path}（${r.dirtyMark.reason}）`
        : r.dirtyMark.state === 'failed'
          ? `置失败（不阻断主 job）：${r.dirtyMark.error}`
          : '未变（本轮坑库无变动 ⇒ 不置）'}`);
    }
  }
  // 退出码（tickd 的消费面，三态）：
  //   0 = 正常跑完 / `skipped='locked'`（抢不到锁 = 静默退出，既有口径）
  //   1 = 既有失败路径（版本闸不通过、异常抛出等）
  //   5 = **拒渲染**（真源缺失/读不出/空，V31-039）—— tickd `JOBS.pitfall` 声明 `benignExitCodes:[5]`
  //       ⇒ 记 `deferred`、不涨 failures；连续拒由 tickd-health 给 🟡（看得见，不静默）
  const exitCode = r?.refused
    ? REFUSED_EXIT_CODE
    : (r.ok === false && r.skipped !== 'locked' ? 1 : 0);
  process.exit(exitCode);
}
