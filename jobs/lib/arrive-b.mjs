// dsh-butler / lib/arrive-b.mjs —— Arrive-B（接机后看板账本并回）判据层
//
// 来源：`docs\arrive-b接线-方案-20260917.md`（P9「H4 管家接入」子项；主人 2026-09-17 拍板
//   ①落点 = tickd job（不动 dsh-start.ps1 / dsh-shutdown.ps1）②无保守冲突自动 apply、有冲突只报告
//   ③交付时 job 默认关）。
//
// 为什么单独一层：判据要能被单测穷举（正例/反例/空态/幂等/双开门），IO 与 spawn 全留在
//   CLI 层 `handoff-arrive-b.mjs`。本模块**零 IO、零副作用**（不读写文件、不发网络）。
//
// 与既有件的关系（**只调用，不改语义**）：
//   · 双开嫌疑判据复用 `handoff-version-gate.mjs#judgeDualActiveTransition`（与热采同源）
//   · 账本并回一律走 `board-merge.mjs`（Host HTTP API；本模块只判它给回的 rc）
//   · 本模块不碰 board-merge / merge-memory / merge-pitfalls 的合并语义
import { judgeDualActiveTransition } from '../../src/dsh-butler/lib/handoff-version-gate.mjs';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';

export const ARRIVE_B_VERSION = '1.1.0';

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-arrive-b.json`）。 */
export function arriveBStatePath(home = dshHome()) { return resolveStatePath(ARRIVE_B_STATE_NAME, { home }).path; }

/** 状态文件 schemaVersion（丢失 = 重跑一次并回，保守幂等，无害）。 */
export const ARRIVE_B_SCHEMA = 1;
export const ARRIVE_B_STATE_NAME = 'butler-arrive-b.json';

export const ARRIVE_B_DEFAULTS = {
  /** 双开嫌疑窗口：90 分钟（方案 §9 默认，与 Arrive-A A2 心跳口径一致）。
   *  ⚠️ 现成判据 `judgeDualActiveTransition` 的默认是 30 分钟（热采量级）；本卡**显式传 90 分钟**
   *  —— 90 > 30 = 更保守（更容易判嫌疑 ⇒ 更容易拦下不写），符合"拿不准只报告不 apply"的档位。 */
  dualActiveWindowMs: 90 * 60 * 1000,
  /** 已处理签名容量（最近 N 条，超出丢最旧）。 */
  seenCapacity: 50,
  /** 状态文件里保留的告警条数。 */
  alertCapacity: 20,
  /** 报告里最多铺几条明细（冲突/新建/更新各段）。 */
  maxDetailLines: 20,
};

/** 快照来源优先级（方案 §3.3）：仓3 工作副本最稳，生产目录兜底。 */
export const SNAPSHOT_SOURCE_ORDER = ['repo-workspace', 'prod'];
export const SNAPSHOT_SOURCE_LABEL = {
  'repo-workspace': '仓3 工作副本（git-backup/dsh-workspace/tools/board-snapshots）',
  prod: '生产目录（DSH_ROOT/tools/board-snapshots）',
};

/** 退出码三态（照方案 §3.2；3 属 benign，见 tickd JOBS 的 benignExitCodes）。 */
export const ARRIVE_B_EXIT = {
  ok: 0,
  failed: 1,
  yield: 3,
};

// ---------------------------------------------------------------- 运行档位（H4b · 2026-09-21）

/**
 * 「只报告档」持久开关文件名（**长期运行档**；与 A6b 的 `butler-handoff-adopt.json` 同族形态）。
 * 落在 DSH_HOME 下（默认 `~/.dsh`）——理由与 A6b 相同：**人改文件即改档**，
 * 不改代码、不重启 tickd、且与 job 开关分离（开关管「跑不跑」，档位管「跑起来多强」）。
 */

/** 「只报告档」开关文件路径：统一入口（legacy 期 = `<home>\butler-arrive-b-mode.json`）。 */
export function arriveBModePath(home = dshHome()) { return resolveStatePath(ARRIVE_B_MODE_NAME, { home }).path; }

export const ARRIVE_B_MODE_NAME = 'butler-arrive-b-mode.json';

/**
 * 档位默认值 = `apply`（= H4a 交付时的既有行为）。
 * ⚠️ 为什么默认不是 `report`：本卡**不改变任何既有机器上 arrive-b 的既有行为**
 *   （本机 arrive-b 已由主人 2026-09-17 01:31 显式放行；对端「缺键自动开跑」另有治本见 tickd
 *   JOBS 的 `defaultWhenUnset`）。「默认要不要改成只报告」属口径决策 ⇒ 写进卡 description
 *   的「待拍板」段，由主人拍，不在实施里自行改默认。
 */
export const ARRIVE_B_MODE_DEFAULT = 'apply';

/**
 * `ARRIVE_B_REPORT_ONLY` 环境变量 → 档位。**空值 = 不表态**（回落下一级）；
 * **非空非法值 = fail-closed 按 `report`**（宁可少写账本，也不因一个错字把"只报告"误判成全功能）。
 * @param {string|null|undefined} v
 * @returns {'report'|'apply'|null}
 */
export function parseReportOnlyEnv(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (['1', 'true', 'yes', 'on', 'report', 'report-only'].includes(s)) return 'report';
  if (['0', 'false', 'no', 'off', 'apply'].includes(s)) return 'apply';
  return 'report';
}

/**
 * 解析本轮档位。**纯函数**（档位文件的原始文本由调用方读入 —— 本模块零 IO）。
 *
 * 优先级（照项目既有惯例 A6b `resolveAdoptMode`）：**单轮 CLI > 环境变量 > 持久档位文件 > 默认**。
 * ⚠️ CLI 与环境变量都**绝不写回**档位文件（防「单轮覆盖静默改掉长期口径」，与 A6b 同款铁律）。
 * ⚠️ 档位文件只认 `{"mode":"report"|"apply"}`；文件读不出 / 键非法 → **fail-closed 按 report**
 *   （source='file-invalid'，可见），与 A6b 的 state-invalid 同口径。
 *
 * @param {{cliFlag?:'report'|'apply'|null, envFlag?:string|null, fileRaw?:string|null}} input
 *        fileRaw = 档位文件原文；null / 空串 = 文件不存在
 * @returns {{mode:'report'|'apply', source:'cli'|'env'|'file'|'file-invalid'|'default'}}
 */
export function resolveArriveBMode(input = {}) {
  const cliFlag = input.cliFlag ?? null;
  if (cliFlag === 'report' || cliFlag === 'apply') return { mode: cliFlag, source: 'cli' };
  const env = parseReportOnlyEnv(input.envFlag ?? null);
  if (env) return { mode: env, source: 'env' };
  const raw = input.fileRaw ?? null;
  if (raw !== null && String(raw).trim() !== '') {
    try {
      const j = JSON.parse(raw);
      if (j?.mode === 'apply') return { mode: 'apply', source: 'file' };
      if (j?.mode === 'report') return { mode: 'report', source: 'file' };
      return { mode: 'report', source: 'file-invalid' };
    } catch { return { mode: 'report', source: 'file-invalid' }; }
  }
  return { mode: ARRIVE_B_MODE_DEFAULT, source: 'default' };
}

// ---------------------------------------------------------------- 快照选取

/**
 * 从文件名解析 host / 时间戳 / 标签。
 * 形态实测两类：`host-c-2026-09-16T07-11-23-depart.json`（Depart ②c）
 *              `host-a-2026-09-16T05-22-25-board-snapshot.json`（手工导出）。
 * @returns {{host:string, stamp:string, label:string, base:string}|null}
 */
export function parseSnapshotName(file) {
  const base = String(file ?? '').split(/[\\/]/).pop() ?? '';
  const m = base.match(/^([a-z0-9_-]+?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.json$/i);
  if (!m) return null;
  return { host: m[1].toLowerCase(), stamp: m[2], label: m[3], base };
}

/**
 * 选一份**对端**快照。规则（方案 §3.3）：按来源优先级取第一个有合格快照的目录，
 * 目录内取 mtime 最新的一份；**跳过本机自己导出的**（按 host 前缀判）。
 *
 * @param {{candidates?:Array<{kind:string,dir:string,file:string,mtimeMs:number}>, selfHost:string}} input
 * @returns {{ok:boolean, reason:string, picked:object|null, considered:Array<object>, rejected:Array<object>}}
 */
export function pickPeerSnapshot(input = {}) {
  const self = String(input.selfHost ?? '').toLowerCase();
  const list = Array.isArray(input.candidates) ? input.candidates : [];
  const considered = [];
  const rejected = [];
  for (const c of list) {
    const p = parseSnapshotName(c.file);
    if (!p) { rejected.push({ ...c, why: '文件名不是 <host>-<ISO>-<label>.json 形态' }); continue; }
    if (self && p.host === self) { rejected.push({ ...c, why: `本机自己导出的（${p.host}）` }); continue; }
    considered.push({ ...c, host: p.host, stamp: p.stamp, label: p.label });
  }
  if (!considered.length) {
    return {
      ok: false, picked: null, considered, rejected,
      reason: list.length
        ? `候选 ${list.length} 份里没有对端快照（全部被跳过：${rejected[0]?.why ?? '-'}）`
        : '候选目录里没有任何 .json 快照',
    };
  }
  for (const kind of SNAPSHOT_SOURCE_ORDER) {
    const same = considered.filter((c) => c.kind === kind);
    if (!same.length) continue;
    same.sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));
    return {
      ok: true, picked: same[0], considered, rejected,
      reason: `取自${SNAPSHOT_SOURCE_LABEL[kind] ?? kind}：${same[0].file}（对端 ${same[0].host} · ${same[0].stamp}）`,
    };
  }
  considered.sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));
  return {
    ok: true, picked: considered[0], considered, rejected,
    reason: `取自未知来源 ${considered[0].kind}：${considered[0].file}（对端 ${considered[0].host}）`,
  };
}

// ---------------------------------------------------------------- 幂等键

/**
 * 幂等键 = `<快照文件名>#<快照内账本 revision>`。
 * 为什么带上 revision：同名文件复现（重新导出的同名/同刻文件）时，内容仍可能变；
 * 带上账本版本号能把"同一份内容"钉死，同时让"对端账本又前进了"重新触发一次并回。
 */
export function snapshotKey({ file, revision } = {}) {
  const base = String(file ?? '').split(/[\\/]/).pop() ?? '';
  const rev = (revision === null || revision === undefined || revision === '') ? 'rev-unknown' : String(revision);
  return `${base}#${rev}`;
}

/** 该幂等键是否已处理过（`seen` 为 [{key,at}] 数组）。 */
export function hasSeen(seen, key) {
  const list = Array.isArray(seen) ? seen : [];
  return list.some((s) => s && s.key === key);
}

/** 追加幂等签名（保序、去重、容量截断）。 */
export function pushSeen(seen, key, at = new Date().toISOString(), capacity = ARRIVE_B_DEFAULTS.seenCapacity) {
  const list = (Array.isArray(seen) ? seen : []).filter((s) => s && s.key && s.key !== key);
  list.push({ key, at });
  while (list.length > capacity) list.shift();
  return list;
}

// ---------------------------------------------------------------- 双开嫌疑

/**
 * 双开门（方案 §3.3 门 2）：读仓内**对端**交接单，`lastHeartbeatAt` 显著新于
 * `lastSuccessfulHandoffAt` ⇒ 对端在最后一次完整交接后仍在活动 = 双开嫌疑 → fail-closed **不写生产**。
 *
 * 口径复用 `judgeDualActiveTransition`（与 hot-collect 同源，不另造一套），只把窗口显式调到 90min。
 * @param {{peerRecords?:Array<{host:string,record:object}>, now?:number, windowMs?:number}} input
 */
export function judgeDualOpen(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const windowMs = Number.isFinite(input.windowMs) ? input.windowMs : ARRIVE_B_DEFAULTS.dualActiveWindowMs;
  const peers = Array.isArray(input.peerRecords) ? input.peerRecords : [];
  for (const p of peers) {
    const j = judgeDualActiveTransition(p?.record, { now, windowMs });
    if (j.suspected === true) {
      return { suspected: true, peerHost: p?.host ?? null, reason: j.reason, windowMs, checked: peers.length };
    }
  }
  return {
    suspected: false, peerHost: null, windowMs, checked: peers.length,
    reason: peers.length ? `对端交接单 ${peers.map((p) => p?.host).filter(Boolean).join('/')} 无双开迹象` : '无可读的对端交接单（新机/仓未拉到）',
  };
}

// ---------------------------------------------------------------- 决策

/** 把一次运行的结论压成 state 用的 lastResult。
 *  `code` 可选：`report` 的两种来源语义相反（只报告档的干净干跑 vs 保守冲突），分开记便于面板/日报读。 */
export function resultOf(action, code = null) {
  if (action === 'report' && code === 'report-only-clean') return 'report-only';
  return ({
    yield: 'yielded',
    unchanged: 'unchanged',
    report: 'conflicts',
    noop: 'no-diff',
    applied: 'applied',
    fail: 'failed',
  })[action] ?? 'unknown';
}

/**
 * 逐门决策（方案 §3.3 门 1-5）。**纯函数**：调用方把各门取证结果传进来。
 *
 * @param {{
 *   hostOnline:boolean,                       // 门1：3080 有 Listen（Host 在线）
 *   dual?:{suspected:boolean, peerHost?:string, reason?:string},
 *   snapshot?:{ok:boolean, reason?:string, picked?:object},
 *   seen?:boolean,                            // 门4：幂等键已处理过
 *   force?:boolean,                           // --force：跳过幂等门（人工重放）
 *   mode?:'apply'|'report',                   // H4b：运行档位（'report' = 永不 apply，干跑干净也停在 report）
 *   dryRun?:null|{rc:number, planTotal?:number, conflicts?:number, failures?:number, reportFile?:string},
 * }} input
 * @returns {{action:'yield'|'unchanged'|'report'|'noop'|'apply'|'fail', code:string, rc:number, message:string, alert:object|null, markSeen:boolean}}
 *
 * ⚠️ `markSeen` 由**判据层**给出，IO 层不得按 action 名字猜（2026-09-17 实施期实测踩到：
 *   「双开嫌疑」与「保守冲突」都是 action='report'，但前者是**让路**（下轮必须重试，
 *   否则对端恢复正常后这份快照永远不再被并回），后者是**已定结论**（重复报告只是刷屏）。
 *   两者签名意图相反 ⇒ 必须显式带上，别用 action 名单推断。）
 */
export function decide(input = {}) {
  const dual = input.dual ?? null;
  const snap = input.snapshot ?? null;

  // 门1 环境门：Host 不在 → 让路（下次再来；不算失败）
  if (input.hostOnline !== true) {
    return { action: 'yield', code: 'no-host', rc: ARRIVE_B_EXIT.yield, alert: null, markSeen: false,
      message: '本机 Host（3080）不在线 → 本轮让路（DSH 未起 / 正在重启）' };
  }

  // 门2 双开门：fail-closed，只报告不写 + 🔴（**不写签名**：对端恢复正常后这份快照还要并）
  if (dual?.suspected === true) {
    return { action: 'report', code: 'dual-active-suspect', rc: ARRIVE_B_EXIT.yield, markSeen: false,
      alert: { level: 'alert', code: 'dual-active-suspect',
        message: `双开嫌疑（对端 ${dual.peerHost ?? '-'}）：${dual.reason ?? '-'} → fail-closed，本轮不写生产账本` },
      message: `双开嫌疑（对端 ${dual.peerHost ?? '-'}）→ fail-closed 不并回` };
  }

  // 门3 输入门：没有对端快照 → 让路（新机/对端没导出）
  if (snap?.ok !== true) {
    return { action: 'yield', code: 'no-peer-snapshot', rc: ARRIVE_B_EXIT.yield, alert: null, markSeen: false,
      message: `无对端快照 → 本轮让路（${snap?.reason ?? '未提供快照候选'}）` };
  }

  // 门4 幂等门
  if (input.seen === true && input.force !== true) {
    return { action: 'unchanged', code: 'already-processed', rc: ARRIVE_B_EXIT.ok, alert: null, markSeen: true,
      message: '该快照（同名 + 同账本 revision）已处理过 → 跳过（幂等）' };
  }

  // 门5 干跑门：以 board-merge --dry-run 的退出码为准
  const dr = input.dryRun ?? null;
  if (!dr) {
    return { action: 'apply', code: 'dry-run-pending', rc: ARRIVE_B_EXIT.ok, alert: null, markSeen: false,
      message: '各门已过 → 待执行 dry-run' };
  }
  if (dr.rc === 0) {
    const total = Number(dr.planTotal ?? 0);
    if (total <= 0) {
      return { action: 'noop', code: 'no-diff', rc: ARRIVE_B_EXIT.ok, alert: null, markSeen: true,
        message: 'dry-run 无差异（新建 0 / 更新 0）→ 无需 apply' };
    }
    // 只报告档（mode='report'）：**永不 apply** —— 结论已定（脚本覆盖不了账本）⇒ 落签名，
    //   否则每轮都会重跑 dry-run 并重复写报告段（刷屏）。这正是与 `--dry-run` 的关键区别：
    //   `--dry-run` 是人工观测档（不落签名、每轮重跑），本档是长期运行档（落签名、幂等）。
    if (input.mode === 'report') {
      return { action: 'report', code: 'report-only-clean', rc: ARRIVE_B_EXIT.ok, markSeen: true,
        alert: { level: 'info', code: 'report-only',
          message: `只报告档（mode=report）：dry-run 干净（计划 ${total} 项）→ 本轮**不 apply**，账本零写入` },
        message: `只报告档：dry-run 干净（计划 ${total} 项）→ 不 apply（人工核后手工跑 board-merge --apply）` };
    }
    return { action: 'apply', code: 'dry-run-clean', rc: ARRIVE_B_EXIT.ok, markSeen: false,
      alert: { level: 'info', code: 'apply-ready', message: `dry-run 干净（新建 ${dr.planTotal} 项计划）→ 进入 apply` },
      message: `dry-run 干净 → 进入 apply（计划 ${total} 项）` };
  }
  if (dr.rc === 2) {
    return { action: 'report', code: 'conflicts', rc: ARRIVE_B_EXIT.ok, markSeen: true,
      alert: { level: 'warn', code: 'conservative-conflicts',
        message: `保守冲突 ${dr.conflicts ?? '?'} 条（需人工核）→ 只报告，不 apply` },
      message: `保守冲突 ${dr.conflicts ?? '?'} 条 → 只报告不 apply（人工核后手工跑 board-merge --apply）` };
  }
  return { action: 'fail', code: 'dry-run-failed', rc: ARRIVE_B_EXIT.failed, markSeen: false,
    alert: { level: 'alert', code: 'dry-run-failed',
      message: `board-merge --dry-run 退出码 ${dr.rc}（真失败${dr.failures ? ` · ${dr.failures} 条失败项` : ''}）→ 不写生产` },
    message: `board-merge --dry-run 真失败（rc=${dr.rc}）` };
}

/**
 * apply 之后的判定（方案 §3.3 门 6/7）。apply 失败 或 复核 dry-run 非干净 → 真失败 + 🔴。
 * @param {{applyRc:number, applyFailures?:number, verifyRc:number|null, verifyConflicts?:number}} input
 */
export function judgeAfterApply(input = {}) {
  if (input.applyRc !== 0) {
    return { action: 'fail', code: 'apply-failed', rc: ARRIVE_B_EXIT.failed,
      applied: false, markSeen: false,
      alert: { level: 'alert', code: 'apply-failed',
        message: `board-merge --apply 退出码 ${input.applyRc}${input.applyFailures ? `（${input.applyFailures} 条真失败）` : ''} → 账本可能部分写入，看备份可回滚` },
      message: `apply 失败（rc=${input.applyRc}）` };
  }
  if (Number.isFinite(input.verifyRc) && input.verifyRc !== 0) {
    return { action: 'fail', code: 'verify-not-clean', rc: ARRIVE_B_EXIT.failed,
      applied: true, markSeen: false,
      alert: { level: 'alert', code: 'verify-not-clean',
        message: `apply 后复核 dry-run 仍有差异（rc=${input.verifyRc}${input.verifyConflicts ? ` · 冲突 ${input.verifyConflicts}` : ''}）→ 合并语义异常，人工核` },
      message: `apply 后复核不干净（rc=${input.verifyRc}）` };
  }
  return { action: 'applied', code: 'applied', rc: ARRIVE_B_EXIT.ok, applied: true, markSeen: true, alert: null,
    message: 'apply 成功且复核干净' };
}

// ---------------------------------------------------------------- board-merge 报告摘要

/**
 * 从 board-merge 的 merge-report.json 里抽摘要（best-effort：读不到就返回 null）。
 * 只读不判 —— 判据一律以 board-merge 的退出码为准（报告仅用于铺明细）。
 */
export function summarizeMergeReport(report) {
  if (!report || typeof report !== 'object') return null;
  const plan = report.plan ?? {};
  const details = report.details ?? {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    mode: report.mode ?? null,
    fromHost: report.snapshot?.fromHost ?? null,
    snapshotFile: report.snapshot?.file ? String(report.snapshot.file).split(/[\\/]/).pop() : null,
    exportedAt: report.snapshot?.exportedAt ?? null,
    sourceRevision: report.snapshot?.revision ?? null,
    taskCount: report.snapshot?.taskCount ?? null,
    localRevision: report.local?.revision ?? null,
    localTaskCount: report.local?.taskCount ?? null,
    create: num(plan.create), update: num(plan.update), unchanged: num(plan.unchanged),
    skipped: num(plan.skipped), skippedArchived: num(plan.skippedArchived), conflicts: num(plan.conflicts),
    planTotal: num(plan.create) + num(plan.update),
    createLines: Array.isArray(details.create) ? details.create : [],
    updateLines: Array.isArray(details.update) ? details.update : [],
    conflictLines: Array.isArray(details.conflicts) ? details.conflicts : [],
    failedLines: Array.isArray(report.failures) ? report.failures : [],
    appliedLines: Array.isArray(report.applied) ? report.applied : [],
    backupDir: report.backup?.dir ?? null,
    exit: report.exit ?? null,
  };
}

// ---------------------------------------------------------------- 状态文件

/** 空状态（首次运行）。 */
export function emptyState(host, now = new Date().toISOString()) {
  return {
    schemaVersion: ARRIVE_B_SCHEMA,
    host: host ?? null,
    createdAt: now,
    updatedAt: now,
    lastStartedAt: null,
    lastResult: null,
    lastCode: null,
    reason: null,
    lastSnapshot: null,
    stats: { runs: 0, applied: 0, unchanged: 0, conflicts: 0, reportOnly: 0, yielded: 0, noDiff: 0, failed: 0, lastApplyAt: null },
    seen: [],
    alerts: [],
  };
}

/**
 * 计算下一个状态（纯函数：不落盘）。
 * @param {object|null} prev 现有状态（null / 坏数据都能吃）
 * @param {{host?:string, at?:string, startedAt?:string, action?:string, code?:string, message?:string,
 *          snapshot?:object|null, key?:string|null, markSeen?:boolean, alert?:object|null, extra?:object}} patch
 */
export function nextState(prev, patch = {}) {
  const now = patch.at ?? new Date().toISOString();
  const base = (prev && typeof prev === 'object' && prev.schemaVersion === ARRIVE_B_SCHEMA)
    ? prev
    : emptyState(patch.host, now);
  const stats = { ...(base.stats ?? emptyState(patch.host, now).stats) };
  stats.runs = Number(stats.runs ?? 0) + 1;
  const action = patch.action ?? null;
  if (action === 'applied') { stats.applied += 1; stats.lastApplyAt = now; }
  else if (action === 'unchanged') stats.unchanged += 1;
  // 「只报告档的干净干跑」与「保守冲突」都是 action='report'，但结论语义相反（一个可并回、一个要人工核）
  // ⇒ 统计按 **code** 分流，别让只报告档把冲突计数灌胖（面板/日报读 conflicts 会失真）。
  else if (action === 'report') {
    if (patch.code === 'report-only-clean') stats.reportOnly = Number(stats.reportOnly ?? 0) + 1;
    else stats.conflicts += 1;
  }
  else if (action === 'yield') stats.yielded += 1;
  else if (action === 'noop') stats.noDiff += 1;
  else if (action === 'fail') stats.failed += 1;

  let seen = Array.isArray(base.seen) ? base.seen : [];
  // 只有「结论已确定」的路径才写签名（幂等跳过 / 无差异 / 冲突已报告 / apply 成功）。
  // 让路（环境/输入）与真失败**不写** → 下一轮重试（网络/环境类故障自愈，方案 §3.4）。
  const markSeen = patch.markSeen === true && Boolean(patch.key);
  if (markSeen) seen = pushSeen(seen, patch.key, now);

  let alerts = Array.isArray(base.alerts) ? base.alerts : [];
  if (patch.alert) {
    alerts = [...alerts, { at: now, ...patch.alert }];
    while (alerts.length > ARRIVE_B_DEFAULTS.alertCapacity) alerts.shift();
  }

  return {
    ...base,
    schemaVersion: ARRIVE_B_SCHEMA,
    host: patch.host ?? base.host ?? null,
    createdAt: base.createdAt ?? now,
    updatedAt: now,
    lastStartedAt: patch.startedAt ?? base.lastStartedAt ?? null,
    lastResult: resultOf(action, patch.code) === 'unknown' ? (base.lastResult ?? null) : resultOf(action, patch.code),
    lastCode: patch.code ?? base.lastCode ?? null,
    reason: patch.message ?? base.reason ?? null,
    lastSnapshot: patch.snapshot ?? base.lastSnapshot ?? null,
    stats,
    seen,
    alerts,
    ...(patch.extra ?? {}),
  };
}

// ---------------------------------------------------------------- 报告渲染

/** 渲染一轮运行的 Markdown 段（追加进 docs\管家报告\arrive-b-<日期>.md）。 */
export function renderRunSection(entry = {}) {
  const L = [];
  const at = entry.at ?? new Date().toISOString();
  const bad = entry.action === 'fail';
  // 「只报告档：干跑干净」是本档的**正常结论**，不是告警 ⇒ 用 ⚪ 而不是 ⚠️
  //   （⚠️ 专留给「保守冲突/双开嫌疑」这类要人看的）。
  const reportOnlyClean = entry.action === 'report' && entry.code === 'report-only-clean';
  const icon = bad ? '🔴' : (entry.action === 'applied' ? '✅' : (reportOnlyClean ? '⚪' : (entry.action === 'report' ? '⚠️' : '⚪')));
  L.push(`## ${icon} ${at} · ${entry.action ?? '-'}（${entry.code ?? '-'}）`);
  L.push('');
  L.push(`- 结论：${entry.message ?? '-'}`);
  if (entry.mode) {
    L.push(`- 运行档位：${entry.mode.mode === 'report' ? '**只报告（永不 apply）**' : '全功能（可 apply）'}`
      + `（来源 ${entry.mode.source}${entry.mode.dryRun ? ' · 本轮 --dry-run' : ''}）`);
  }
  if (entry.snapshot) {
    L.push(`- 快照：\`${entry.snapshot.file ?? '-'}\`（对端 ${entry.snapshot.fromHost ?? '-'} · rev ${entry.snapshot.revision ?? '-'} · 来源 ${entry.snapshot.kind ?? '-'}）`);
  }
  if (entry.key) L.push(`- 幂等键：\`${entry.key}\``);
  if (entry.dual) L.push(`- 双开门：${entry.dual.suspected ? '🔴 嫌疑' : '🟢 无'}（${entry.dual.reason ?? '-'}）`);
  if (entry.merge) {
    const m = entry.merge;
    L.push(`- 并回（${m.mode ?? '-'}）：新建 ${m.create} / 更新 ${m.update} / 无变化 ${m.unchanged} / 归档跳过 ${m.skippedArchived} / 冲突 ${m.conflicts}`);
    if (m.backupDir) L.push(`- 账本备份：\`${m.backupDir}\`（含 restore.mjs，需停 DSH 后执行）`);
    const sec = (title, arr) => {
      const lines = (arr ?? []).slice(0, ARRIVE_B_DEFAULTS.maxDetailLines);
      if (!lines.length) return;
      L.push('', `**${title}**${(arr?.length ?? 0) > lines.length ? `（前 ${lines.length} / 共 ${arr.length} 条）` : ''}`, '');
      for (const x of lines) L.push(`- ${x}`);
    };
    sec('将新建', m.createLines);
    sec('将更新', m.updateLines);
    sec('冲突（未写入，需人工核）', m.conflictLines);
    sec('失败项', m.failedLines);
  }
  if (entry.attachments && entry.attachments.checked) {
    const a = entry.attachments;
    L.push(`- 附件对账：${a.missing > 0 ? `⚠️ 缺失 ${a.missing} 个对象（${a.sessions ?? '?'} 个会话受影响）` : '✅ 无缺失'}`
      + `　补齐命令：\`node <workspace>\\tools\\attachments-fetch.mjs --all-missing\``);
  }
  if (entry.hookLogs && entry.hookLogs.copied?.length) {
    L.push(`- 钩子日志归档：复制 ${entry.hookLogs.copied.length} 份 → \`<workspace>\\logs\\handoff\\\``);
  }
  if (entry.alerts?.length) {
    L.push('', '**本轮告警**', '');
    for (const a of entry.alerts) L.push(`- ${a.level === 'alert' ? '🔴' : a.level === 'warn' ? '🟡' : 'ℹ️'} ${a.code ?? '-'}：${a.message ?? '-'}`);
  }
  L.push('');
  return L.join('\n');
}
