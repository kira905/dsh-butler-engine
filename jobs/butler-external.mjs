// dsh-butler / butler-external.mjs —— P6「会望风」外部信号感知（载体：独立低频扫描，非 P2 的 5 分钟 tick）
//
// 方案：docs\管家v2方案-从只读到真管家-20260909.md §4 P6（行 856-881）
// 计划任务：DSH-Butler-External（每小时跑一次；内部按源各自节流：模型列表/公告 24h、状态页 30m）
// 纯 node fetch，**0 token**；全只读（拉公开数据 + 用本机 key 拉自己的模型列表）。
//
// 用到的公共底座（禁止另起一套）：
//   lib/store.mjs       状态文件读写唯一入口（原子写 / tick 互斥 / schemaVersion）
//   lib/version.mjs     gateComponent 版本自检
//   lib/watch-policy.mjs / lib/watch-notify.mjs  冷却 / 日上限 / 免打扰 / ack / 三通道推送（P2 通道机制）
//   lib/state-files.mjs 状态文件登记（external-sources.json / butler-external-snapshots/ / butler-external-state.json）
//
// 契约（README 同款）：所有状态文件走 readJson / updateJson / writeJsonAtomic；脚本永不抛到进程外。
//
// CLI：
//   node butler-external.mjs                    按节流跑一轮（默认）
//   node butler-external.mjs --force            忽略节流，全跑
//   node butler-external.mjs --only <id,...>    只跑指定源
//   node butler-external.mjs --dry-run          只读演练（不写状态/快照/报告，不推送）
//   node butler-external.mjs --status           只读总览
//   node butler-external.mjs --list             列出源注册表
//   node butler-external.mjs --add-source '{"id":"x","url":"…","kind":"page-diff","interval":"24h"}'
//   node butler-external.mjs --remove-source <id> | --enable <id> | --disable <id>
//   node butler-external.mjs --ack <token|all>  确认告警（复用 P2 ack 语义）
//   node butler-external.mjs --false-positive <eventId|sourceId> --note "原因"
//   node butler-external.mjs --unmute <sourceId>  解除「只存档不提示」
//   node butler-external.mjs --json            机器可读输出

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { readJson, writeJsonAtomic, acquireTickLock, updateJson } from '../src/dsh-butler/lib/store.mjs';
import { dshHome, ensureDir } from '../src/dsh-butler/lib/paths.mjs';
import { gateComponent } from '../src/dsh-butler/lib/version.mjs';
import { firstH1Index, insertAtFor, stampDocMark } from '../src/lib/generated-docs.mjs'; // §2.2 权威源（档级标记）
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { appendAudit } from '../src/dsh-butler/lib/audit.mjs';
import { applyPolicy, emptyWatchState, ackEvents, markFalsePositive } from './lib/watch-policy.mjs';
import { deliverPush, appendFalsePositive } from '../src/dsh-butler/lib/watch-notify.mjs';
import {
  DEFAULT_SOURCES, DEFAULTS, KINDS, KIND_LABEL, EXTERNAL_SOURCES_VERSION,
  STATE_FILE, SOURCES_FILE,
  ensureRegistry, readRegistry, writeRegistry, validateRegistry, normalizeSource,
  upsertSource, removeSource, setEnabled, findSource, sourcesPath, sourcesFileName, legacySourcesPath,
  externalStatePath, snapshotRoot, formatInterval,
  suggestSources, PROVIDER_TEMPLATES,
} from './lib/external-sources.mjs';
import {
  EXTERNAL_COLLECT_VERSION, collectSource, readLatestSnapshot, writeSnapshot, listSnapshots, maskKey, readCredentialRef,
} from './lib/external-collect.mjs';
import {
  EXTERNAL_DIFF_VERSION, judgeSource, applyFetchFailure, applyFetchSuccess, releaseEvents, summarizeTick,
  EV, formatTs, bumpMuteStreak, makeAutoMutedEvent, judgeBatchFetchFailure, judgePersistentFetchFailure,
  LEDGER, modelsFingerprint, judgeLedgerReview,
} from './lib/external-diff.mjs';
import {
  EXTERNAL_DISCOVERY_VERSION, DISCOVERY_DEFAULTS, runDiscovery, discoveryBasis, shouldDiscover, discoveryState,
  applyDiscovery, acceptCandidate, rejectCandidate, summarizeDiscovery,
} from './lib/external-discovery.mjs';

export const VERSION = '0.1.0';
export const EXTERNAL_STATE_SCHEMA = 1;
export const COMPONENT = 'butler-external';

/** P6 的告警策略（复用 P2 语义，独立一份状态文件 → 不与 P2 tick 抢同一文件）。 */
export const EXTERNAL_POLICY = {
  cooldownMs: 4 * 3_600_000,
  dailyCap: 10,
  quietHours: { startHour: 23, endHour: 7 },
  ackEscalateMs: 4 * 3_600_000,
  maxEscalations: 3,
  suppression: { maintenanceActive: false, diskFull: false, networkDown: false },
};

// ------------------------------------------------------------------ 状态文件

export function emptyExternalState(now = Date.now()) {
  return {
    schemaVersion: EXTERNAL_STATE_SCHEMA,
    updatedAt: new Date(now).toISOString(),
    tickCount: 0,
    lastTickAt: null,
    sources: {},
    policy: emptyWatchState(now),
    gates: {},
    digest: { day: dayKey(now), items: [], suppressed: 0, muted: [] },
  };
}

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function readExternalState(opts = {}) {
  const file = externalStatePath(opts);
  const raw = readJson(file, { schemaVersion: EXTERNAL_STATE_SCHEMA, defaultValue: null, home: opts.home });
  const base = raw && typeof raw === 'object' ? raw : emptyExternalState(opts.now);
  return {
    ...emptyExternalState(opts.now),
    ...base,
    sources: { ...(base.sources ?? {}) },
    gates: { ...(base.gates ?? {}) },
    policy: base.policy ?? emptyWatchState(opts.now),
    digest: base.digest ?? { day: dayKey(opts.now), items: [], suppressed: 0, muted: [] },
  };
}

export function writeExternalState(state, opts = {}) {
  const file = externalStatePath(opts);
  const payload = { ...state, schemaVersion: EXTERNAL_STATE_SCHEMA, updatedAt: new Date(opts.now ?? Date.now()).toISOString() };
  writeJsonAtomic(file, payload, {});
  return { ok: true, file };
}

// ------------------------------------------------------------------ tick

/** 源是否到期（内部节流）。 */
export function isDue(src, state, now) {
  const rt = state?.sources?.[src.id] ?? {};
  const last = Number(rt.lastRunAt ?? 0);
  if (!last) return true;
  return now - last >= src.intervalMs;
}

function snapshotBrief(snap) {
  if (!snap) return null;
  if (snap.kind === 'models-api') return `${snap.count} 模型`;
  if (snap.kind === 'status-json') return `${snap.indicator}`;
  if (snap.kind === 'page-diff') return `hash ${String(snap.hash).slice(0, 10)} · ${snap.textLen} 字`;
  return snap.kind;
}

/**
 * 跑一轮扫描。永不抛。
 * @param {{home?:string, now?:number, force?:boolean, only?:string[]|null, dryRun?:boolean,
 *          credentialsFile?:string, doubleReadAttempts?:number, noPush?:boolean, noReport?:boolean,
 *          batchFailMinSources?:number, singleFailMinCount?:number}} [opts]
 */
export async function runTick(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? dshHome();
  const dryRun = opts.dryRun === true;
  const out = {
    ok: true, at: new Date(now).toISOString(), dryRun, device: os.hostname(),
    results: [], events: [], push: [], reportOnly: [], suppressed: [], notes: [], recovered: [], errors: [],
    failedSources: [], counts: null, report: null, delivery: null, discovery: null,
  };

  // 1) 注册表（缺失 → 落默认；被手改坏 → 明确报错，绝不猜）
  //    host 分文件：external-sources-<host>.json；host 文件不存在但旧单文件名在 → 以旧文件为种子迁移
  const ens = ensureRegistry({ home, now, write: !dryRun });
  out.sourcesFile = ens.file;
  if (ens.migratedFrom) out.registryMigratedFrom = ens.migratedFrom;
  const validated = validateRegistry(ens.registry);
  if (!validated.ok) {
    out.ok = false;
    out.errors = validated.errors;
    alert({ level: 'error', source: COMPONENT, message: `源注册表校验失败（${sourcesFileName({ home })}）：${validated.errors.slice(0, 3).join('；')}`, detail: { file: sourcesPath({ home }) } }, { home });
    return out;
  }
  if (validated.warnings.length) out.warnings = validated.warnings;

  let state = readExternalState({ home, now });

  const selected = validated.sources.filter((s) => s.enabled && (!opts.only || opts.only.includes(s.id)));
  if (!selected.length) out.notes.push('没有启用中的源（或 --only 未命中）');

  const events = [];
  const recoveredIds = [];
  for (const src of selected) {
    const rt = state.sources[src.id] ?? {};
    const lastRunAt = Number(rt.lastRunAt ?? 0);
    if (!opts.force && lastRunAt && now - lastRunAt < src.intervalMs) {
      out.results.push({
        id: src.id, label: src.label, kind: src.kind, skipped: true,
        reason: `未到期（间隔 ${formatInterval(src.intervalMs)}，上次 ${formatTs(lastRunAt)}）`,
      });
      continue;
    }
    let r;
    try {
      r = await collectSource(src, {
        now, home,
        credentialsFile: opts.credentialsFile,
        doubleReadAttempts: opts.doubleReadAttempts,
      });
    } catch (e) {
      r = { ok: false, kind: src.kind, snapshot: null, reason: 'exception', error: e?.message ?? String(e), ms: 0, notes: [], raw: { bytes: 0, status: 0 } };
    }
    const rtBase = { ...(state.sources[src.id] ?? {}), lastRunAt: now, lastAttemptAt: now, lastMs: r.ms ?? 0 };
    state = { ...state, sources: { ...state.sources, [src.id]: rtBase } };

    if (!r.ok) {
      const f = applyFetchFailure(state, src, r, { now });
      state = { ...state, sources: f.sources };
      if (f.event) {
        events.push(f.event);
        state = { ...state, sources: { ...state.sources, [src.id]: { ...state.sources[src.id], failNotifiedAt: now } } };
        out.failedSources.push(src.id);
      }
      out.results.push({
        id: src.id, label: src.label, kind: src.kind, ok: false, reason: r.reason, error: r.error,
        failCount: f.count, ms: r.ms, note: f.reason,
      });
      out.notes.push(`[${src.id}] 采集失败（${r.reason}）：${r.error}`);
      continue;
    }
    if (r.unstable) {
      out.results.push({ id: src.id, label: src.label, kind: src.kind, ok: true, unstable: true, ms: r.ms, note: (r.notes ?? []).join('；') });
      out.notes.push(...(r.notes ?? []).map((n) => `[${src.id}] ${n}`));
      continue;
    }

    // 成功：清失败态（可能带恢复事件）+ 判定 diff
    const okRes = applyFetchSuccess(state, src, { now });
    state = { ...state, sources: okRes.sources };
    events.push(...okRes.events);
    recoveredIds.push(...okRes.recovered);
    // 【R-048 B 补遗】单源长期失败（🔴）的恢复解除：与「采集恢复」同一时机。
    //   判据用**本轮前**的 failCount（rt 是循环开头读的旧值）；releaseEvents 对不存在的事件记录是 no-op，
    //   所以这里无条件追加是安全的（不会凭空造记录）。
    if (Number(rt?.failCount ?? 0) > 0) recoveredIds.push(EV.persistentFail(src.id));

    const prev = readLatestSnapshot(src, { home });

    // 自动降噪（page-diff）：被标误报后连续 3 次「有变化」→ 该源降为只存档不提示。
    // 顺序很重要：先算计数并写进 state，judge 才能读到最新的 muted 标志。
    if (src.kind === 'page-diff' && prev && r.snapshot && prev.hash !== r.snapshot.hash) {
      const evId = EV.pageChange(src.id);
      const ms = bumpMuteStreak(state, src.id, evId, { threshold: Number(opts.muteThreshold ?? 3) });
      state = { ...state, sources: { ...state.sources, [src.id]: { ...(state.sources[src.id] ?? {}), muteStreak: ms.streak, muted: ms.muted || ms.justMuted } } };
      if (ms.justMuted) {
        events.push(makeAutoMutedEvent(src, ms.streak, now, { threshold: ms.threshold }));
        out.notes.push(`[${src.id}] 连续 ${ms.streak} 次变化被标误报 → 自动降为只存档不提示`);
      }
    }

    let judged = { events: [], notes: [], suppressed: [] };
    try {
      judged = judgeSource(src, prev, r.snapshot, { now, state, gates: state.gates });
    } catch (e) {
      out.errors.push(`[${src.id}] 判定异常：${e?.message ?? e}`);
    }
    events.push(...(judged.events ?? []));
    if (judged.recovered) recoveredIds.push(...judged.recovered);
    if (judged.suppressed?.length) out.suppressed.push(...judged.suppressed.map((x) => ({ ...x, source: src.id })));
    out.notes.push(...(judged.notes ?? []).map((n) => `[${src.id}] ${n}`));
    if (r.notes?.length) out.notes.push(...r.notes.map((n) => `[${src.id}] ${n}`));

    // R-049③：模型清单**指纹**落到 state（只存 sha1，不存全量清单）——
    //   台账 14 天兜底复核时靠它回答"这 14 天里清单到底变没变"，而不是空喊"该复核了"。
    if (src.kind === 'models-api' && r.snapshot) {
      const fp = modelsFingerprint(r.snapshot.ids ?? [], r.snapshot.fields ?? null);
      state = {
        ...state,
        sources: {
          ...state.sources,
          [src.id]: {
            ...(state.sources[src.id] ?? {}), modelFp: fp,
            modelCount: r.snapshot.count ?? (r.snapshot.ids ?? []).length, modelAt: now,
          },
        },
      };
    }

    // 快照（dry-run 不落盘）
    if (!dryRun) {
      try { writeSnapshot(src, r.snapshot, { home, now, keepSnapshots: opts.keepSnapshots }); } catch (e) { out.errors.push(`[${src.id}] 快照写入失败：${e?.message ?? e}`); }
    }
    out.results.push({
      id: src.id, label: src.label, kind: src.kind, ok: true, ms: r.ms, bytes: r.raw?.bytes ?? 0,
      snapshot: snapshotBrief(r.snapshot), notes: (judged.notes ?? []).length,
    });
  }

  // 1.4) 【R-049③ · 2026-10-21】模型 / 计费台账 14 天兜底复核（防 P6 自身漏报）
  //   主路 = judgeModels 在「清单有变化」的事件里点名去复核台账；本段是**兜底**：到点没复核过就提醒一次。
  //   放在逐源循环之后、applyPolicy 之前 ⇒ 与其它事件共用同一套冷却/日上限/免打扰，**不另建限流**。
  //   计时器 = state.ledgerReview.lastAt（首次成功评估时建基线；只在**到期触发**时前移，不提前重置）。
  const modelsApiSources = validated.sources.filter((s) => s.kind === 'models-api');
  const modelStates = modelsApiSources.map((s) => ({
    id: s.id,
    fp: state.sources?.[s.id]?.modelFp ?? null,
    count: state.sources?.[s.id]?.modelCount ?? null,
  }));
  const ledgerRes = judgeLedgerReview({
    now, ledgerReview: state.ledgerReview ?? null, models: modelStates,
    intervalDays: opts.ledgerReviewDays ?? LEDGER.intervalDays,
  });
  out.ledgerReview = {
    doc: LEDGER.doc, intervalDays: opts.ledgerReviewDays ?? LEDGER.intervalDays,
    baseline: ledgerRes.baseline, due: ledgerRes.due, drift: ledgerRes.drift,
    fired: Boolean(ledgerRes.event), modelSources: modelStates.map((m) => m.id),
    next: ledgerRes.next, notes: ledgerRes.notes,
  };
  if (ledgerRes.event) events.push(ledgerRes.event);
  out.notes.push(...(ledgerRes.notes ?? []));
  if (!dryRun) state = { ...state, ledgerReview: ledgerRes.next };

  // 1.45) 【R-048 B 补遗 · 2026-10-15】单源**连续**失败达阈值 ⇒ 升 🔴
  //       补的是「只有一个源挂了三天」这个哑火面；与下面的跨源聚合**并列且互不替代**（各出各的事件，可同时成立）。
  //       同样走既有 applyPolicy（4h 冷却 + 日上限 10 + 免打扰）—— **不另建限流**。
  const persistent = judgePersistentFetchFailure(out.results, state, {
    minFailures: opts.singleFailMinCount ?? DEFAULTS.singleFailMinCount,
    registry: validated.sources,
  });
  out.persistentFail = {
    count: persistent.count, threshold: persistent.threshold, sources: persistent.sources,
    fired: persistent.events.length > 0, hits: persistent.hits,
  };
  if (persistent.events.length) { events.push(...persistent.events); out.notes.push(persistent.reason); }

  // 1.5) R-048 ②：跨源聚合 —— 同一轮 ≥N 个源同时采集失败 ⇒ 升 🔴（否则「多源同时瞎」只在报告里留一行）
  //      刻意放在逐源循环之后、策略之前：聚合要看全这一轮，且必须进同一套冷却/日上限/免打扰。
  const batch = judgeBatchFetchFailure(out.results, { minSources: opts.batchFailMinSources ?? DEFAULTS.batchFailMinSources });
  out.batchFail = { count: batch.count, threshold: batch.threshold, sources: batch.sources, fired: Boolean(batch.event) };
  if (batch.event) { events.push(batch.event); out.notes.push(batch.reason); }

  // 2) 策略（复用 P2 状态机）+ 恢复解除
  const policyRes = applyPolicy(events, state.policy ?? emptyWatchState(now), { now, policy: EXTERNAL_POLICY });
  let policyState = policyRes.state;
  const rel = releaseEvents(policyState, recoveredIds, { now, reason: 'external-recovered' });
  policyState = rel.state;
  state = { ...state, policy: policyState };

  out.events = events;
  out.push = policyRes.push;
  out.reportOnly = policyRes.reportOnly;
  out.deferred = policyRes.deferred;
  out.escalated = policyRes.escalated;
  out.cooling = policyRes.cooling;
  out.skipped = policyRes.skipped;
  out.quiet = policyRes.quiet;
  out.recovered = rel.released;

  // 3) 投递（桌宠 + 会话；dry-run 不推）
  //    `pushImpl` = 单轮可注入的投递实现（**测试夹具用**：断言"决策=推送"而不真给主人发通知）。
  //    缺省永远是生产实现 deliverPush —— 生产链路上没有任何分支读它。
  if (!dryRun && !opts.noPush && policyRes.push.length) {
    const pushFn = typeof opts.pushImpl === 'function' ? opts.pushImpl : deliverPush;
    try { out.delivery = await pushFn(policyRes.push, { home, now }); }
    catch (e) { out.errors.push(`推送失败：${e?.message ?? e}`); }
  }

  // 4) 24h 门更新：本轮真正「提示」过的事件记时间（push ∪ reportOnly ∪ deferred）
  const notifiedIds = new Set([...policyRes.push, ...policyRes.reportOnly, ...policyRes.deferred].map((x) => x.id));
  const gates = { ...state.gates };
  for (const id of notifiedIds) gates[id] = { ...(gates[id] ?? {}), lastNotifiedAt: now };
  state = { ...state, gates };

  // 4.5) 自动探源（卡：源清单随本机实况自动变化）
  //   硬边界：**只落候选**（注册表顶层 candidates），绝不动 sources / enabled；结果**永不进 events**
  //   （进了就会触发 P2 冷却/日上限/推送链 → 打扰）；失败只记 out.errors，不影响采集。
  if (!opts.noDiscovery) {
    try {
      const disc = await runDiscovery({
        home, now,
        registry: ens.registry,
        prev: state.discovery,
        force: opts.forceDiscovery === true,
        dryRun,
        credentialsFile: opts.credentialsFile,
        settingsFile: opts.settingsFile,
        templates: opts.templates,
        defaults: opts.discoveryDefaults,
      });
      if (disc.ran) {
        const next = applyDiscovery(ens.registry, disc, { rejected: state.discovery?.rejected ?? [], defaults: opts.discoveryDefaults });
        const before = JSON.stringify(ens.registry?.candidates ?? []);
        const after = JSON.stringify(next.candidates ?? []);
        if (before !== after && !dryRun) {
          try {
            writeRegistry(next, { home, now });
            out.registryCandidates = (next.candidates ?? []).length;
          } catch (e) { out.errors.push(`候选落盘失败：${e?.message ?? e}`); }
        }
        state = { ...state, discovery: discoveryState(disc, state.discovery, { now }) };
        out.discovery = {
          ran: true, reason: disc.reason, detail: { ran: true, reason: disc.reason },
          candidates: disc.candidates.map((c) => c.id),
          unknown: disc.unknown ?? [],
          unmatched: (disc.unmatchedChannels ?? []).map((u) => u.provider),
          failures: disc.failures ?? 0, requests: disc.requests ?? 0,
          probed: disc.probed ?? [],
        };
      } else {
        out.discovery = { ran: false, reason: disc.reason, candidates: [], unknown: disc.unknown ?? [], unmatched: [], failures: 0, requests: 0, probed: [] };
      }
    } catch (e) {
      out.errors.push(`自动探源失败：${e?.message ?? e}`);
      out.discovery = { ran: false, reason: 'exception', candidates: [], unknown: [], unmatched: [], failures: 0, error: e?.message ?? String(e) };
    }
  }

  // 5) 日报摘要（digest）
  state = { ...state, digest: mergeDigest(state.digest, { now, events, push: policyRes.push, reportOnly: policyRes.reportOnly, suppressed: out.suppressed, results: out.results }) };

  // 6) 落状态（dry-run 不写）
  state = { ...state, tickCount: Number(state.tickCount ?? 0) + 1, lastTickAt: new Date(now).toISOString() };
  if (!dryRun) {
    try { writeExternalState(state, { home, now }); } catch (e) { out.errors.push(`状态写入失败：${e?.message ?? e}`); }
    try { appendAudit({ type: 'external-tick', tick: COMPONENT, runId: null, executed: out.results.filter((r) => !r.skipped).length, failed: out.failedSources.length, events: events.map((e) => e.id), pushed: policyRes.push.map((e) => e.id), sourceCount: selected.length, discovery: out.discovery ? { ran: out.discovery.ran, reason: out.discovery.reason, candidates: out.discovery.candidates ?? [], unknown: (out.discovery.unknown ?? []).length, unmatched: (out.discovery.unmatched ?? []).length, failures: out.discovery.failures ?? 0 } : null }, { home, silent: true }); } catch { /* 审计失败不影响 */ }
  }
  out.counts = summarizeTick(out.results, now);

  // 7) P6 自己的报告文件（人类可读；日报另有「🌐 外部信号」段）
  if (!dryRun && !opts.noReport) {
    try { out.report = writeExternalReport({ now, home, out, results: out.results, events, push: policyRes.push, reportOnly: policyRes.reportOnly, suppressed: out.suppressed, tick: state.tickCount, reportDir: opts.reportDir }); }
    catch (e) { out.errors.push(`报告写入失败：${e?.message ?? e}`); }
  }
  return out;
}

/** 合并当天日报摘要（同日累积；换日重置）。 */
export function mergeDigest(prev, { now, events, push, reportOnly, suppressed, results }) {
  const day = dayKey(now);
  const base = prev && prev.day === day ? prev : { day, items: [], suppressed: 0, muted: [] };
  const items = [...(base.items ?? [])];
  const upsert = (it) => {
    const i = items.findIndex((x) => x.id === it.id);
    if (i >= 0) items[i] = { ...items[i], ...it };
    else items.push(it);
  };
  for (const e of events) {
    upsert({
      id: e.id, level: e.level, title: e.title, detail: e.detail, url: e.url ?? null,
      source: e.evidence?.source ?? null, at: now, delivered: push.some((p) => p.id === e.id) ? 'push' : (reportOnly.some((p) => p.id === e.id) ? 'report' : 'detail'),
    });
  }
  const muted = [...new Set([...(base.muted ?? []), ...(events.filter((e) => e.id.startsWith('ext.auto-muted.')).map((e) => e.evidence?.source).filter(Boolean))])];
  return {
    day,
    generatedAt: now,
    items: items.slice(-80),
    suppressed: Number(base.suppressed ?? 0) + (suppressed?.length ?? 0),
    muted,
    sources: (results ?? []).map((r) => ({
      id: r.id, label: r.label ?? null, ok: r.ok !== false, skipped: r.skipped === true,
      snapshot: r.snapshot ?? null, failCount: r.failCount ?? 0, note: r.note ?? null,
    })),
  };
}

// ------------------------------------------------------------------ 报告

/** 报告目录（可用 opts.reportDir 覆盖 —— 测试必须指向临时目录，否则会污染生产 docs）。 */
export const DEFAULT_REPORT_DIR = path.join(process.env.DSH_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME || '.', 'dsh-workspace'), 'docs', '管家报告');

export function reportPath(now = Date.now(), reportDir = DEFAULT_REPORT_DIR) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return path.join(reportDir, `external-${day}-${os.hostname()}.md`);
}

/** 追加一节到 P6 专属报告（只在有事件/失败时写）。 */
export function writeExternalReport(input = {}) {
  const { now, events = [], push = [], reportOnly = [], suppressed = [], results = [], tick, reportDir } = input;
  const meaningful = events.length || results.some((r) => r.ok === false && !r.skipped) || suppressed.length;
  const file = reportPath(now, reportDir ?? DEFAULT_REPORT_DIR);
  if (!meaningful) return { ok: true, file, written: false, reason: 'no-events' };
  const t = new Date(now);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const L = [];
  L.push(`## ${hhmm} · tick #${tick ?? '?'} · ${os.hostname()}`);
  L.push('');
  const icon = (lv) => (lv === 'red' ? '🔴' : lv === 'yellow' ? '🟡' : '⚪');
  const row = (x) => `- ${icon(x.level)} **${x.title}**（\`${x.id}\`）：${x.detail}${x.url ? ` · ${x.url}` : ''}`;
  if (push.length) { L.push(`**🔴 已推送（${push.length}）**`); push.forEach((x) => L.push(row(x))); L.push(''); }
  if (reportOnly.length) { L.push(`**🟡 只进报告（${reportOnly.length}）**`); reportOnly.forEach((x) => L.push(row(x))); L.push(''); }
  const failed = results.filter((r) => r.ok === false && !r.skipped);
  if (failed.length) {
    L.push(`**⚠️ 采集失败（${failed.length}）**`);
    failed.forEach((x) => L.push(`- \`${x.id}\`（${x.failCount ?? '?'} 次）：${x.error ?? x.note ?? ''}`));
    L.push('');
  }
  if (suppressed.length) { L.push(`**⏳ 抑制（${suppressed.length}）**：${suppressed.map((s) => `${s.source}(${s.reason})`).join('、')}`); L.push(''); }
  const body = L.join('\n');
  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) {
      // §2.2 档级标记（`external` 族 · 方案 §3.1）：**仅首次建模板时写一次**（纯追加型，已发布行不动）；
      //   ⚠️ `external` 的 `exemptEligible = false` ⇒ 有标记也**不豁免**（§4.4-6 负向判据）
      const headerBody = [
        `# 管家外部信号报告 ${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
        '',
        '> 由 `<pkg>/src/dsh-butler/butler-external.mjs` 按源节流追加（P6 会望风；无事件时不写）。',
        '> 源注册表：`~/.dsh/' + sourcesFileName({}) + '`（host 分文件；加一行即入扫）；推送/冷却/日上限沿用 P2 通道。',
        '',
      ].join('\n');
      fs.writeFileSync(file, stampDocMark(headerBody, 'external', insertAtFor(firstH1Index(headerBody))), 'utf8');
    }
    fs.appendFileSync(file, body, 'utf8');
    return { ok: true, file, written: true, bytes: Buffer.byteLength(body, 'utf8') };
  } catch (e) {
    return { ok: false, file, written: false, error: e?.message ?? String(e) };
  }
}

// ------------------------------------------------------------------ 只读视图

/** 只读总览（--status / 面板用）。 */
export function buildStatus(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? dshHome();
  const ens = ensureRegistry({ home, now, write: false });
  const validated = validateRegistry(ens.registry);
  const state = readExternalState({ home, now });
  const rows = validated.sources.map((s) => {
    const rt = state.sources?.[s.id] ?? {};
    const lastRunAt = Number(rt.lastRunAt ?? 0);
    let credential = null;
    if (s.keyRef) credential = maskKey(readCredentialRef(s.keyRef, { home }));
    return {
      id: s.id, label: s.label, kind: s.kind, kindLabel: KIND_LABEL[s.kind] ?? s.kind,
      enabled: s.enabled, interval: formatInterval(s.intervalMs), url: s.url, keyRef: s.keyRef ?? null, credential,
      lastRunAt: lastRunAt || null, lastRunLabel: lastRunAt ? formatTs(lastRunAt) : '从未',
      due: isDue(s, state, now), failCount: Number(rt.failCount ?? 0), lastError: rt.lastError ?? null,
      lastOkAt: Number(rt.lastOkAt ?? 0) || null, muted: rt.muted === true, muteStreak: Number(rt.muteStreak ?? 0),
      latestSnapshot: readLatestSnapshot(s, { home }) ? snapshotBrief(readLatestSnapshot(s, { home })) : null,
      snapshotCount: listSnapshots(s, { home }).length,
    };
  });
  return {
    ok: validated.ok, version: VERSION, component: COMPONENT, at: new Date(now).toISOString(), device: os.hostname(),
    files: { sources: sourcesPath({ home }), state: externalStatePath({ home }), snapshots: snapshotRoot({ home }) },
    errors: validated.errors, warnings: validated.warnings,
    policy: state.policy?.daily ?? null,
    tickCount: Number(state.tickCount ?? 0), lastTickAt: state.lastTickAt ?? null,
    digest: state.digest ?? null,
    // R-049③：台账复核计时器（null = 还没建基线）
    ledgerReview: {
      doc: LEDGER.doc, intervalDays: LEDGER.intervalDays,
      lastAt: Number(state.ledgerReview?.lastAt ?? 0) || null,
      lastAtLabel: state.ledgerReview?.lastAt ? formatTs(Number(state.ledgerReview.lastAt)) : null,
      modelFp: state.ledgerReview?.modelFp ?? null,
      nextDueAt: state.ledgerReview?.lastAt
        ? Number(state.ledgerReview.lastAt) + LEDGER.intervalDays * 86_400_000 : null,
    },
    sources: rows,
    enabledCount: rows.filter((r) => r.enabled).length,
  };
}

export function formatStatus(st) {
  const L = [];
  L.push(`dsh-butler-external ${st.version} · ${st.device} · 源 ${st.sources.length}（启用 ${st.enabledCount}）· tick #${st.tickCount}（上次 ${st.lastTickAt ? formatTs(Date.parse(st.lastTickAt)) : '从未'}）`);
  L.push(`注册表 ${st.files.sources}`);
  if (st.errors.length) L.push(`⚠️ 校验错误 ${st.errors.length}：${st.errors.slice(0, 3).join('；')}`);
  if (st.warnings?.length) L.push(`· 提示 ${st.warnings.length}：${st.warnings.slice(0, 3).join('；')}`);
  if (st.ledgerReview) {
    const lr = st.ledgerReview;
    const dueTxt = lr.lastAt
      ? `上次复核 ${lr.lastAtLabel} · 下次到期 ${formatTs(lr.nextDueAt)}`
      : '基线未建（等模型源一次成功采集后自动建）';
    L.push(`📒 台账兜底复核（R-049③ · ${lr.intervalDays} 天）：${dueTxt} · ${lr.doc}`);
  }
  L.push('');
  for (const r of st.sources) {
    const flag = !r.enabled ? '⏸ 停用' : (r.failCount > 0 ? `🔴 连续失败 ${r.failCount}` : (r.due ? '⏰ 待扫' : '✅ 正常'));
    L.push(`- [${r.id}] ${r.kindLabel}${r.keyRef ? ` · key ${r.credential}` : ''}`);
    L.push(`    ${flag} · 间隔 ${r.interval} · 上次 ${r.lastRunLabel} · 快照 ${r.latestSnapshot ?? '无'}（${r.snapshotCount} 份）${r.muted ? ' · 🔇 已降噪只存档' : ''}`);
    L.push(`    ${r.url}`);
    if (r.lastError) L.push(`    最后错误：${r.lastError}`);
  }
  if (st.policy) L.push(`\n今日：推送 ${st.policy.pushed ?? 0} / 只进报告 ${st.policy.reportOnly ?? 0}`);
  if (st.digest?.items?.length) {
    L.push('今日外部信号：');
    for (const it of st.digest.items.slice(-10)) L.push(`  - ${it.level === 'red' ? '🔴' : '🟡'} ${it.title}：${it.detail}`);
  }
  return L.join('\n');
}

// ------------------------------------------------------------------ CLI

const USAGE = [
  'dsh-butler-external —— P6 会望风（外部信号感知，只读 0 token）',
  '',
  '用法：',
  '  node butler-external.mjs [--force] [--only <id,...>] [--dry-run] [--json] [--no-push]',
  '  node butler-external.mjs [--home <隔离目录>] [--report-dir <目录>] [--batch-fail-min <N>] [--single-fail-min <N>]',
  '                                               --home = 隔离演练（状态/快照/源表/报告全落该目录，绝不碰生产 ~/.dsh）',
  '                                                   ⚠️ 隔离 home 需先放一份产品版本台账（可从状态目录复制）：',
  '                      缺它会被版本闸门 fail-closed 跳过（打印「组件 butler-external 版本不匹配已跳过」）',
  '                                               --batch-fail-min = 批量采集失败阈值 N（缺省 2；≥N 个源同一轮失败 ⇒ 🔴 送达）',
  '                                               --single-fail-min = 单源连续失败阈值 N（缺省 3；某源连续失败 ≥N 次 ⇒ 🔴 送达）',
  '  node butler-external.mjs --status | --list',
  '  node butler-external.mjs --suggest          探源建议（只读）：本机凭证实况 vs 源清单，谁被漏了 / 谁是环境信号',
  '  node butler-external.mjs --discover [--force] [--dry-run] [--json]',
  '                                               自动探源：按实况指纹复核 → 探测已知模板的候选端点',
  '                                               （只落**候选**，绝不自动启用；结果只进日报，不推送）',
  '  node butler-external.mjs --candidates        列出候选（只读）',
  '  node butler-external.mjs --accept <id|all>   候选转正为源（enabled:true，下轮 tick 入扫）',
  '  node butler-external.mjs --reject <id|all> | --clear-rejected   否决候选 / 清空否决名单',
  '  node butler-external.mjs --add-source \'{"id":"x","url":"https://…","kind":"page-diff","interval":"24h"}\'',
  '  node butler-external.mjs --remove-source <id> | --enable <id> | --disable <id>',
  '  node butler-external.mjs --ack <token|all> | --false-positive <id> --note "…" | --unmute <sourceId>',
  '',
  `kind 取值：${KINDS.join(' | ')}（${KINDS.map((k) => `${k}=${KIND_LABEL[k]}`).join('，')}）`,
  'interval 写法："30m" / "24h" / "7d"（也接受数字 ms）',
].join('\n');

export function parseArgs(argv = []) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--force') a.force = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--json') a.json = true;
    else if (v === '--status') a.status = true;
    else if (v === '--list') a.list = true;
    else if (v === '--suggest') a.suggest = true;
    else if (v === '--discover') a.discover = true;
    else if (v === '--candidates') a.candidates = true;
    else if (v === '--accept') a.accept = argv[++i];
    else if (v === '--reject') a.reject = argv[++i];
    else if (v === '--clear-rejected') a.clearRejected = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--only') a.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '--add-source') a.addSource = argv[++i];
    else if (v === '--remove-source') a.removeSource = argv[++i];
    else if (v === '--enable') a.enable = argv[++i];
    else if (v === '--disable') a.disable = argv[++i];
    else if (v === '--ack') a.ack = argv[++i];
    else if (v === '--false-positive') a.falsePositive = argv[++i];
    else if (v === '--unmute') a.unmute = argv[++i];
    else if (v === '--note') a.note = argv[++i];
    else if (v === '--credentials-file') a.credentialsFile = argv[++i];
    else if (v === '--no-push') a.noPush = true;
    // 【R-048】隔离 home：状态 / 快照 / 源注册表全部落在 <home> 下（**测试与排障用**；
    //   给 `--home` 时报告默认也改落到 <home>\butler-external-reports，避免演练污染生产报告目录）
    else if (v === '--home') a.home = argv[++i];
    else if (v === '--report-dir') a.reportDir = argv[++i];
    else if (v === '--batch-fail-min') a.batchFailMin = Number(argv[++i]);
    else if (v === '--single-fail-min') a.singleFailMin = Number(argv[++i]);
    else a._.push(v);
  }
  return a;
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv);
  // `--home` = 隔离 home（测试/排障）：状态、快照、源注册表全落该目录；
  //   此时报告目录默认也改落 <home>\butler-external-reports（**不让演练写进生产报告目录**）
  const home = args.home ?? opts.home ?? dshHome();
  const reportDir = args.reportDir ?? (args.home ? path.join(home, 'butler-external-reports') : undefined);
  const now = Date.now();
  const print = (s) => { process.stdout.write(`${s}\n`); };

  if (args.help) { print(USAGE); return 0; }

  // 版本闸门（不匹配 → 跳过该组件 + 告警，其余照常）
  const gate = gateComponent(COMPONENT, VERSION, { home });
  if (!gate.run) { print(`⏭ 组件 ${COMPONENT} 版本不匹配已跳过：${gate.message}`); return 0; }

  if (args.list || args.status) {
    const st = buildStatus({ home, now });
    if (args.json) print(JSON.stringify(st, null, 2));
    else if (args.list) {
      print(`源注册表（${st.sources.length}）：`);
      for (const r of st.sources) print(`  ${r.enabled ? '✅' : '⏸'} ${r.id.padEnd(24)} ${r.kind.padEnd(12)} ${r.interval.padEnd(5)} ${r.url}`);
      print(`\n文件：${st.files.sources}`);
    } else print(formatStatus(st));
    return st.ok ? 0 : 1;
  }

  // ---- 探源建议（只读；主人 2026-09-11 定：源清单随 dsh 实况动态变化） ----
  if (args.suggest) {
    const sug = suggestSources({ home });
    if (args.json) { print(JSON.stringify(sug, null, 2)); return 0; }
    print('🔭 探源建议（本机凭证实况 vs 源清单）');
    print(`  在用供应商（凭证）：${sug.providersInUse.join('、') || '（未识别）'}`);
    print(`  源清单覆盖：        ${sug.covered.join('、') || '（空）'}`);
    if (sug.missing.length) {
      print('\n⚠ 有凭证但没有源（建议补，加一行即入扫）：');
      for (const m of sug.missing) {
        print(`  · ${m.provider}（${m.keyRef}）`);
        for (const c of m.candidates) print(`      ${c.id.padEnd(22)} kind=${c.kind.padEnd(12)} ${c.url}${c.keyRef ? ` (keyRef=${c.keyRef})` : ''}`);
      }
    } else print('\n✅ 有凭证的供应商都已有源覆盖');
    if (sug.stale.length) {
      print('\nℹ 有源但本机无对应凭证（多半是环境信号源，非主人供应商）：');
      for (const s of sug.stale) print(`  · ${s.provider} → ${s.sources.join(', ')}`);
    }
    if (sug.unknown.length) {
      print('\n❓ 有凭证但模板里没有该供应商（需人工探源后加 PROVIDER_TEMPLATES 一行）：');
      for (const k of sug.unknown) print(`  · ${k}`);
    }
    print(`\n模板库：${PROVIDER_TEMPLATES.length} 家（deepseek / siliconflow / zhipu / openai …；新增供应商在 lib/external-sources.mjs 的 PROVIDER_TEMPLATES 加一行）`);
    return 0;
  }

  // ---- 自动探源：跑一轮发现（与 tick 共用互斥锁；dry-run = 只判断不探测、不写盘） ----
  if (args.discover) {
    const lock = acquireTickLock(COMPONENT, { ttlMs: 20 * 60_000, home });
    if (!lock.ok) { print(`⏭ 另一个 tick / 发现正在跑（${lock.reason}），本次静默退出`); return 0; }
    try {
      const ens = ensureRegistry({ home, now, write: !args.dryRun });
      const state = readExternalState({ home, now });
      const disc = await runDiscovery({
        home, now, registry: ens.registry, prev: state.discovery,
        force: args.force, dryRun: args.dryRun,
        credentialsFile: args.credentialsFile, settingsFile: args.settingsFile,
      });
      if (args.json && !disc.ran) { print(JSON.stringify({ ran: false, reason: disc.reason, basis: disc.basis, dryRun: disc.dryRun === true }, null, 2)); return 0; }
      if (!disc.ran) {
        print(`⏭ 本轮不需要复核：${disc.reason}${args.dryRun ? '' : '（指纹未变；--force 可强制）'}`);
        return 0;
      }
      const next = applyDiscovery(ens.registry, disc, { rejected: state.discovery?.rejected ?? [] });
      if (!args.dryRun) {
        if (JSON.stringify(next.candidates ?? []) !== JSON.stringify(ens.registry?.candidates ?? [])) writeRegistry(next, { home, now });
        writeExternalState({ ...state, discovery: discoveryState(disc, state.discovery, { now }) }, { home, now });
      }
      const cands = (next.candidates ?? []).map((c) => c.id);
      if (args.json) { print(JSON.stringify({ ...disc, registryCandidates: cands }, null, 2)); return 0; }
      print('🔭 自动探源（本机实况 vs 源清单）');
      print(`  理由：${disc.reason} · 请求 ${disc.requests} 次 · 指纹 cred=${String(disc.basis.credHash).slice(0, 8)} channel=${String(disc.basis.channelHash).slice(0, 8)} templates=${String(disc.basis.templatesHash).slice(0, 8)}`);
      for (const p of disc.probed ?? []) print(`  ${p.ok ? '✅' : '⚠️'} ${String(p.id).padEnd(22)} ${p.detail ?? p.state}`);
      if (cands.length) {
        print(`\n待确认候选（${cands.length}）：`);
        for (const c of next.candidates ?? []) print(`  · ${c.id.padEnd(22)} ${c.kind.padEnd(12)} ${c.url}｜${c.probe?.evidence ?? '—'}`);
        print(`  确认入扫：node butler-external.mjs --accept <id>（或 --accept all）`);
      } else print('\n无新增候选');
      if ((disc.unknown ?? []).length) print(`\n❓ 有凭证但模板库没有（需人工探源，见 --suggest）：${disc.unknown.join('、')}`);
      for (const u of disc.unmatchedChannels ?? []) {
        print(`\nℹ 渠道未覆盖：${u.provider}（${u.baseURL}）→ 人工探源套路：`);
        for (const c of u.candidates) print(`      ${c.kind.padEnd(12)} ${c.url}${c.keyRef ? ` (keyRef=${c.keyRef})` : ''}`);
      }
      return 0;
    } finally { lock.release(); }
  }

  // ---- 候选管理（只读列出 / 转正 / 否决） ----
  if (args.candidates || args.accept || args.reject || args.clearRejected) {
    const ens = ensureRegistry({ home, now, write: false });
    const reg = ens.registry;
    let state = readExternalState({ home, now });
    const cands = Array.isArray(reg.candidates) ? reg.candidates : [];

    if (args.candidates) {
      const rej = state.discovery?.rejected ?? [];
      if (args.json) { print(JSON.stringify({ file: ens.file, candidates: cands, rejected: rej }, null, 2)); return 0; }
      print(`🔭 候选（${cands.length}）· ${ens.file}`);
      if (!cands.length) print('  （无；跑 --discover 复核实况）');
      for (const c of cands) {
        print(`  · ${String(c.id).padEnd(22)} ${String(c.kind).padEnd(12)} ${c.url}`);
        print(`      ${c.keyRef ? `keyRef=${c.keyRef} · ` : ''}探测：${c.probe?.evidence ?? '—'}（${c.discoveredAt ?? '?'}）`);
      }
      if (rej.length) print(`\n已被否决（${rej.length}）：${rej.join('、')}`);
      print('\n转正：--accept <id|all>｜否决：--reject <id|all>｜清空否决：--clear-rejected');
      return 0;
    }
    if (args.accept) {
      const r = acceptCandidate(reg, args.accept);
      if (!r.ok) { print(`✗ 转正失败：${(r.errors ?? [r.reason]).join('；')}`); return 2; }
      writeRegistry(r.registry, { home, now });
      print(`✅ 已转正 ${r.accepted.join(', ')}（下一轮 tick 自动入扫；首轮只建基线不报变化）`);
      return 0;
    }
    if (args.reject) {
      const r = rejectCandidate(reg, args.reject, { rejected: state.discovery?.rejected ?? [] });
      if (!r.ok) { print(`✗ 候选不存在：${args.reject}`); return 2; }
      writeRegistry(r.registry, { home, now });
      state = { ...state, discovery: { ...(state.discovery ?? {}), rejected: r.rejected } };
      writeExternalState(state, { home, now });
      print(`✅ 已否决 ${r.removed.join(', ')}（不再提示；--clear-rejected 可清空）`);
      return 0;
    }
    if (args.clearRejected) {
      const n = (state.discovery?.rejected ?? []).length;
      state = { ...state, discovery: { ...(state.discovery ?? {}), rejected: [] } };
      writeExternalState(state, { home, now });
      print(`✅ 已清空否决名单（清掉 ${n} 条；下次发现会重新探测这些端点）`);
      return 0;
    }
  }

  // ---- 注册表写操作（源管理，全部走 butler-store） ----
  if (args.addSource || args.removeSource || args.enable || args.disable) {
    const ens = ensureRegistry({ home, now });
    let reg = ens.registry;
    if (args.addSource) {
      let src;
      try { src = JSON.parse(args.addSource); }
      catch (e) { print(`✗ --add-source 需要一段 JSON：${e?.message ?? e}`); return 2; }
      const r = upsertSource(reg, src);
      if (!r.ok) { print(`✗ 源校验失败：\n  ${r.errors.join('\n  ')}`); return 2; }
      reg = r.registry;
      writeRegistry(reg, { home, now });
      print(`✅ ${r.created ? '已新增' : '已更新'}源 ${normalizeSource(src).id}（下次 tick 自动入扫，无需重启/改代码）`);
      return 0;
    }
    if (args.removeSource) {
      const r = removeSource(reg, args.removeSource);
      if (!r.ok) { print(`✗ 没有这个源：${args.removeSource}`); return 2; }
      writeRegistry(r.registry, { home, now });
      print(`✅ 已删除源 ${args.removeSource}（默认源不会自动复活）`);
      return 0;
    }
    const id = args.enable ?? args.disable;
    const enabled = Boolean(args.enable);
    const r = setEnabled(reg, id, enabled);
    if (!r.ok) { print(`✗ 没有这个源：${id}`); return 2; }
    writeRegistry(r.registry, { home, now });
    print(`✅ 源 ${id} 已${enabled ? '启用' : '停用'}`);
    return 0;
  }

  // ---- ack / 误报 / 解除降噪 ----
  if (args.ack || args.falsePositive || args.unmute) {
    let state = readExternalState({ home, now });
    if (args.ack) {
      const r = ackEvents(state.policy ?? emptyWatchState(now), args.ack, { now });
      state = { ...state, policy: r.state };
      writeExternalState(state, { home, now });
      print(`✅ 已确认 ${r.acked.length} 条（清 deferred ${r.deferredCleared}）${r.acked.length ? `：${r.acked.join(', ')}` : ''}`);
      return 0;
    }
    if (args.falsePositive) {
      const key = String(args.falsePositive).trim();
      // 支持三种写法：事件 id（ext.page-change.<src>）/ ackToken / 源 id（自动映射到该源的 page 事件）
      const bySource = findSourceFromState(state, key);
      const target = bySource ? bySource.eventId : key;
      const r = markFalsePositive(state.policy ?? emptyWatchState(now), target, { now, note: args.note ?? null, source: 'cli', device: os.hostname() });
      state = { ...state, policy: r.state };
      if (bySource) {
        // 源级降噪计数归零 + 解除已有降噪（主人显式标注 → 重新给这个源一次机会）
        const cur = state.sources[bySource.id] ?? {};
        state = { ...state, sources: { ...state.sources, [bySource.id]: { ...cur, muteStreak: 0, muted: false } } };
      }
      writeExternalState(state, { home, now });
      appendFalsePositive({ ...r.record, source: 'external' }, { home });
      print(`✅ 已标误报：${r.matched ? r.record.eventId : target}${args.note ? `（${args.note}）` : ''}`);
      print('   （该源再连续 3 次「有变化」→ 自动降为只存档不提示；现在 muteStreak 已归零）');
      return 0;
    }
    if (args.unmute) {
      const sid = String(args.unmute);
      const cur = state.sources?.[sid];
      if (!cur) { print(`✗ 状态里没有这个源：${sid}`); return 2; }
      state = { ...state, sources: { ...state.sources, [sid]: { ...cur, muted: false, muteStreak: 0 } } };
      writeExternalState(state, { home, now });
      print(`✅ 源 ${sid} 已恢复提示（muteStreak 归零）`);
      return 0;
    }
  }

  // ---- 默认：跑一轮 tick（互斥锁；抢不到静默退出） ----
  const lock = acquireTickLock(COMPONENT, { ttlMs: 20 * 60_000, home });
  if (!lock.ok) { print(`⏭ 另一个 tick 正在跑（${lock.reason}），本次静默退出`); return 0; }
  let out;
  try {
    out = await runTick({
      home, now, force: args.force, only: args.only, dryRun: args.dryRun, noPush: args.noPush,
      credentialsFile: args.credentialsFile, reportDir,
      batchFailMinSources: Number.isFinite(args.batchFailMin) ? args.batchFailMin : undefined,
      singleFailMinCount: Number.isFinite(args.singleFailMin) ? args.singleFailMin : undefined,
    });
  } finally {
    lock.release();
  }
  if (args.json) { print(JSON.stringify(out, null, 2)); return out.ok ? 0 : 1; }

  // tick 输出同时落到 <tmp>\dsh-butler-external.log（计划任务是隐藏窗口，stdout 会丢）
  const logLines = [];
  const emit = (s) => { print(s); logLines.push(s); };

  const c = out.counts ?? {};
  emit(`🐳 P6 会望风 · ${out.device} · 源 ${c.total ?? 0}（扫 ${(c.total ?? 0) - (c.skipped ?? 0)} · 跳过 ${c.skipped ?? 0}${c.unstable ? ` · 抖动 ${c.unstable}` : ''}${c.failed ? ` · 失败 ${c.failed}` : ''}）`);
  for (const r of out.results) {
    const tag = r.skipped ? '⏭' : (r.ok === false ? '⚠️' : '✅');
    emit(`  ${tag} [${r.id}] ${r.skipped ? r.reason : (r.ok === false ? `${r.reason}：${r.error}` : `${r.snapshot ?? ''}${r.unstable ? '（渲染抖动，本次跳过）' : ''}`)}`);
  }
  if (out.events.length) {
    emit(`\n事件 ${out.events.length} 条：`);
    for (const e of out.events) emit(`  ${e.level === 'red' ? '🔴' : '🟡'} ${e.title}：${e.detail}`);
  }
  if (out.recovered.length) emit(`🟢 恢复解除：${out.recovered.join(', ')}`);
  if (out.discovery?.ran) {
    const d = out.discovery;
    if ((d.candidates ?? []).length) emit(`🔭 探源：候选 ${d.candidates.length} 个待确认（${d.candidates.join(', ')}）→ 确认后 --accept <id>`);
    else if ((d.unknown ?? []).length || (d.unmatched ?? []).length) emit(`🔭 探源：${(d.unknown ?? []).length} 个凭证无模板 / ${(d.unmatched ?? []).length} 个渠道未覆盖 → 需人工探源`);
    else if (d.failures) emit(`🔭 探源：本轮 ${d.failures} 个探测未通过（留待下轮或 7 天兜底）`);
    else emit('🔭 探源：复核完成，无新增候选');
  }
  if (out.suppressed.length) emit(`⏳ 抑制：${out.suppressed.map((s) => `${s.source}(${s.reason})`).join('、')}`);
  if (out.persistentFail?.fired) emit(`🔴 单源长期失败：${out.persistentFail.sources.join('、')} 连续失败 ≥ ${out.persistentFail.threshold} 次（阈值 --single-fail-min）`);
  if (out.batchFail?.fired) emit(`🔴 批量采集失败：本轮 ${out.batchFail.count} 个源同时失败（阈值 ${out.batchFail.threshold}）→ ${out.batchFail.sources.join('、')}`);

  if (out.notes.length && (args.force || out.events.length)) emit(`\n注：${out.notes.slice(0, 12).join(' | ')}`);
  if (out.errors.length) emit(`\n⚠️ 内部错误：${out.errors.join(' | ')}`);
  if (!args.dryRun) appendTickLog(logLines, { now });
  return out.ok ? 0 : 1;
}

// ------------------------------------------------------------------ tick 日志（隐藏窗口下的唯一可见痕迹）

export const DEFAULT_LOG_FILE = () => path.join(os.tmpdir(), 'dsh-butler-external.log');

/**
 * 追加一轮 tick 的日志并做简单轮转（>512KB 时只留末 400 行）。
 * 静默失败：日志写不进去绝不能影响采集本身。
 */
export function appendTickLog(lines, opts = {}) {
  const file = opts.logFile ?? process.env.DSH_BUTLER_EXTERNAL_LOG ?? DEFAULT_LOG_FILE();
  const d = new Date(opts.now ?? Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
  try {
    fs.appendFileSync(file, `[${stamp}] ${text.replace(/\n/g, '\n    ')}\n`, 'utf8');
    const st = fs.statSync(file);
    if (st.size > 512 * 1024) {
      const all = fs.readFileSync(file, 'utf8').split('\n');
      fs.writeFileSync(file, `${all.slice(-400).join('\n')}\n`, 'utf8');
    }
    return { ok: true, file, bytes: st.size };
  } catch (e) {
    return { ok: false, file, error: e?.message ?? String(e) };
  }
}

function findSourceFromState(state, key) {
  const k = String(key).toLowerCase();
  const hit = Object.keys(state?.sources ?? {}).find((id) => id.toLowerCase() === k);
  if (!hit) return null;
  return { id: hit, eventId: EV.pageChange(hit) };
}

// 入口守卫：junction / 实体化场景下 import.meta.url 是物理路径、argv[1] 是逻辑路径 → 必须 realpath 双方再比
const isMain = (() => {
  try {
    const here = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const arg = fs.realpathSync(process.argv[1] ?? '');
    return here === arg;
  } catch { return false; }
})();

// 出口收尾（2026-09-12 修 · 卡 86fcff20）：
//   原先这里用 `process.exit(code)` 强退。本脚本一轮要发 8+ 次 fetch（undici），
//   请求结束→进程立即强退时，Windows 上 libuv 的 async handle 关闭竞态会打
//   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76`，
//   进程以 0xC0000409 结束（nodejs/node#56645 同款；实测该断言**只在退出阶段**出现，
//   采集结果与状态文件都已正确落盘）。
//   修法 = 不抢跑：只设 process.exitCode，让事件循环自然排空（undici socket 自行收尾），
//   自然退出 <1s，退出码如实交给调用方（tickd 不会误记 failures）。
//   同仓先例：butler-queue-tick.mjs（L224 注释）/ butler-auto-cli.mjs（L373）已是此写法。
//   注意：catch 分支同样不得强退 —— 异常路径下句柄更可能处于中间态，强退同样会崩。
if (isMain) {
  main().then((code) => { process.exitCode = typeof code === 'number' ? code : 0; }).catch((e) => {
    try { alert({ level: 'error', source: COMPONENT, message: `未捕获异常：${e?.message ?? e}` }, {}); } catch { /* ignore */ }
    process.stderr.write(`✗ ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
