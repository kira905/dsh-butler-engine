// dsh-butler / lib/upgrade-lock.mjs —— B3 主包升级的独占锁 + 中断检测（2026-09-11）
//
// 方案依据：docs\升级方案-2026-09-10.md
//   §4.3「升级锁与执行边界」（R2）：建立 ~/.dsh/upgrade-lock（PID / 会话 id / 开始时间 / 当前步骤）；
//        锁存在时任何入口不得再发起升级；升级只允许主会话执行。
//   §4.1④（R3）：升级 = 多步骤非原子 → 中断后必须先判定"停在哪一步"再选最小回滚面。
//   §3.10（E3/R3）：升级过程不可观测 → 本锁同时充当"步骤日志"（每次 update 写 step/phase + 审计一行）。
//
// 为什么要有它：升级中途被打断（主包已换、插件实体/profile 未对齐）会停在**半升级态**——
//   dsh 起不来，且事后无法判断卡在哪一步。锁文件是判定的唯一权威源（不是猜）。
//
// 三条设计口径（与 L1 资产包 / 方案对齐）：
//   1. **原子写**：所有写入走 butler-store 的 updateJson（RMW 锁 + writeJsonAtomic：临时文件 → fsync → rename）。
//      单测用 writeJsonAtomic 的 hooks.beforeRename 验证"rename 前被打断 → 目标仍是旧完整内容、绝无半截 JSON"。
//   2. **pid 语义分两种，判定链随之不同**（本模块最容易踩错的地方）：
//        升级流程每步都是一次独立 CLI 调用，默认记的 pid = process.ppid（**短命**：pwsh 一退出就死）。
//        若拿这种 pid 的存活当"是否在跑"的判据，正常升级会在每两步之间被误判成中断 → 噪音。
//      故锁里显式记 `pidSource`：
//        · `'ppid'`（默认兜底）：pid 死**不算证据**，判定以心跳为主 ——
//              心跳新鲜（heartbeatAt/updatedAt/startedAt + ttl 内） → held（进行中）
//              心跳过期 + pid 不活                                  → interrupted（中断现场）
//              心跳过期 + pid 活                                    → uncertain（挂着但没进展，人工确认）
//        · `'caller'`（调用方 `--pid` 显式声明"这是升级执行者本身"）：pid 一死**立即**判 interrupted，
//              不必等 ttl —— 想让"升级中途崩掉"被立刻发现，就该传 --pid。
//      B3 流程要求每步 update（顺带刷心跳）；单个长步骤可 `create --ttl-min` 调大 ttl。
//   3. **不静默覆盖中断现场**：锁已存在且判为中断时，新的 create 一律**拒绝**并回报锁信息 +
//      回滚文案；要接管必须显式 `--takeover`（写审计 + 告警），保证"中断证据"不会被悄悄抹掉。
//
// 与 ~/.dsh/upgrade-progress.json（方案 §4.3 另一提法）的关系：**本锁即进度**（step/phase/updatedAt）——
//   不再另立一份进度文件，避免双源分叉（两处写、两处对不上时谁准？）。要读进度就读本锁。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { readJson, updateJson, writeJsonAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { appendAudit } from '../../src/dsh-butler/lib/audit.mjs';
import { alert } from '../../src/dsh-butler/lib/alert.mjs';
// 能力档（U-6 · ④-4）：日报段标明"本机在哪条主包线上"——unknown ⇒ 最保守口径（显式成段，不许静默）。
import { probeHostLine, capabilityLine } from './host-line.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../src/lib/production-guard.mjs';

/** 唯一删口（R-065）：dry-run 是本函数**第一条**可执行语句；被拒 ⇒ 返回 false（调用方按「没删」处理）。 */
function removeGuarded(target, { whitelist, reason = null, dryRun = false, allowReparse = false, op = '删文件' } = {}) {
  if (dryRun === true) return false;
  const g = gateDestructive({
    targets: [{ path: target, label: reason }], whitelist, op, scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return false;
  try { fs.rmSync(target, { force: true }); return true; } catch { return false; }
}

/** 唯一搬移口（R-065）：同卷 rename 的**原子替换**语义。dry-run 同样是第一条可执行语句。 */
function renameGuarded(from, to, { whitelist, reason = null, dryRun = false, allowReparse = false } = {}) {
  if (dryRun === true) return { ok: true, dryRun: true, code: 'dry-run', reason: 'dry-run（零动作）' };
  const g = gateDestructive({
    targets: [{ path: from, label: 'src' }, { path: to, label: 'dst' }], whitelist, op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return { ok: false, code: g.code, reason: g.reason };
  try { fs.renameSync(from, to); return { ok: true, code: null, reason: g.reason }; }
  catch (e) { return { ok: false, code: 'fs-error', reason: String(e?.message ?? e) }; }
}


export const LOCK_NAME = 'upgrade-lock';
export const LOCK_SCHEMA = 1;
/** 心跳 TTL：超过它没有 update/心跳 → 视为"没在推进"（默认 45 分钟，覆盖 npm 装包这类慢步）。 */
export const DEFAULT_HEARTBEAT_TTL_MS = 45 * 60_000;
/** 硬上限：升级从开始算起超过 24h 一定是尸体（即使 pid 恰好被复用成活进程）。 */
export const MAX_UPGRADE_AGE_MS = 24 * 3600_000;

/** 建议步骤（B3 标准序列；write 时不强制，非清单内步骤只警告 —— 别为合法性挡住现场记录）。 */
export const SUGGESTED_STEPS = [
  'precheck',
  'silence-window',
  'backup-verify',
  'mainpkg-install',
  'mainpkg-verify',
  'plugin-upgrade',
  'entity-verify',
  'patch-replay',
  'restart',
  'post-verify',
  'release',
];

/** 锁文件绝对路径（~/.dsh/upgrade-lock）。 */
export function lockPath(home = dshHome()) {
  return path.join(home, LOCK_NAME);
}

/**
 * pid 是否存活（与 butler-tickd 同语义：kill(pid,0) / EPERM = 活）。
 * @param {number} pid
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

const iso = (ms) => new Date(ms).toISOString();

/** 构造一条锁记录（缺省值集中在这里，便于单测与文档对齐）。 */
export function makeLock(input = {}, now = Date.now()) {
  const at = iso(now);
  return {
    schemaVersion: LOCK_SCHEMA,
    pid: Number(input.pid ?? process.ppid ?? 0) || null,
    pidSource: input.pidSource ?? 'ppid',
    sessionId: input.sessionId ?? null,
    startedAt: input.startedAt ?? at,
    updatedAt: at,
    heartbeatAt: at,
    heartbeatTtlMs: Number(input.heartbeatTtlMs ?? input.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS),
    step: input.step ?? 'precheck',
    phase: input.phase ?? 'running',
    fromVersion: input.fromVersion ?? null,
    targetVersion: input.targetVersion ?? null,
    backupDir: input.backupDir ?? null,
    host: input.host ?? os.hostname(),
    note: input.note ?? null,
  };
}

/**
 * 纯函数判定：锁处于什么状态（不碰磁盘，便于单测穷举）。
 * @param {object|null} lock
 * @param {{now?:number, heartbeatTtlMs?:number, maxAgeMs?:number, pidAlive?:boolean}} [opts]
 * @returns {{
 *   state:'none'|'held'|'uncertain'|'interrupted'|'done'|'unknown',
 *   pidAlive:boolean|null, heartbeatAgeMs:number|null, ageMs:number|null, ttlMs:number|null,
 *   staleMs:number|null, expired:boolean, step:string|null, phase:string|null, lock:object|null
 * }}
 */
export function evaluate(lock, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  if (!lock || typeof lock !== 'object') {
    return {
      state: 'none', pidAlive: null, heartbeatAgeMs: null, ageMs: null, ttlMs: null,
      staleMs: null, expired: false, step: null, phase: null, lock: null,
    };
  }
  const ttlMs = Number(lock.heartbeatTtlMs ?? opts.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS);
  const maxAgeMs = Number(opts.maxAgeMs ?? MAX_UPGRADE_AGE_MS);
  const pidAlive = opts.pidAlive === undefined ? isPidAlive(lock.pid) : opts.pidAlive === true;
  const startedMs = Date.parse(lock.startedAt ?? '');
  const hbRaw = lock.heartbeatAt ?? lock.updatedAt ?? lock.startedAt;
  const hbMs = Date.parse(hbRaw ?? '');
  const base = {
    pidAlive,
    ttlMs: Number.isFinite(ttlMs) ? ttlMs : DEFAULT_HEARTBEAT_TTL_MS,
    heartbeatAgeMs: Number.isFinite(hbMs) ? Math.max(0, now - hbMs) : null,
    ageMs: Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null,
    staleMs: Number.isFinite(hbMs) ? Math.max(0, now - hbMs) : null,
    expired: Number.isFinite(startedMs) ? (now - startedMs) > maxAgeMs : false,
    step: lock.step ?? null,
    phase: lock.phase ?? null,
    lock,
  };
  // 时间戳不可解析 = 锁文件被写坏或人手改过 → 不猜，交给人工看（报 unknown）
  if (!Number.isFinite(hbMs)) return { ...base, state: 'unknown' };
  const fresh = base.heartbeatAgeMs <= base.ttlMs;
  if (lock.phase === 'done') return { ...base, state: 'done' };
  // pidSource='caller' = 调用方显式声明"这个 pid 是升级执行者" → 它死了就是中断（不必等心跳过期）
  if (lock.pidSource === 'caller' && !pidAlive) return { ...base, state: 'interrupted', deadCaller: true };
  if (fresh) return { ...base, state: 'held' };
  if (pidAlive) return { ...base, state: 'uncertain' };
  return { ...base, state: 'interrupted' };
}

/**
 * 读锁（唯一入口走 store.readJson；损坏/版本不符不抛，转成 corrupt 描述）。
 * @param {{home?:string, now?:number}} [opts]
 */
export function readLock(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = lockPath(home);
  let lock = null;
  let corrupt = null;
  let exists = false;
  try { exists = fs.existsSync(file); } catch { exists = false; }
  if (exists) {
    try {
      lock = readJson(file, { schemaVersion: LOCK_SCHEMA, home, defaultValue: null, migrateWrite: false });
    } catch (e) {
      corrupt = `${e?.code ?? e?.name ?? 'ERROR'}: ${e?.message ?? e}`;
    }
  }
  return { file, exists, lock: lock ?? null, corrupt };
}

/** 人类可读的锁信息（CLI / 面板 / 日报共用一句话口径）。 */
export function describeLock(lock) {
  if (!lock) return '（无锁）';
  const bits = [`step=${lock.step ?? '?'}`, `phase=${lock.phase ?? '?'}`];
  if (lock.fromVersion || lock.targetVersion) bits.push(`${lock.fromVersion ?? '?'} → ${lock.targetVersion ?? '?'}`);
  if (lock.pid) bits.push(`pid=${lock.pid}`);
  if (lock.sessionId) bits.push(`session=${lock.sessionId}`);
  if (lock.startedAt) bits.push(`起于 ${lock.startedAt}`);
  return bits.join(' · ');
}

/**
 * 回滚提示文案（卡片验收①要求：文案里带「上次升级中断于 step=X，回滚用 <backupDir>\restore-upgrade.mjs」）。
 * @param {object|null} lock
 * @param {{ev?:object}} [opts]
 */
export function rollbackHint(lock, opts = {}) {
  const ev = opts.ev ?? evaluate(lock);
  const step = lock?.step ?? '?';
  const when = lock?.startedAt ?? '?';
  const head = `上次升级中断于 step=${step}（phase=${lock?.phase ?? '?'}，起于 ${when}）`;
  const dir = lock?.backupDir ?? null;
  if (!dir) {
    return `${head}；锁里没记 backupDir → 回退资产包见 docs\\升级L1-资产与回滚-20260911.md（回滚三件套：主包 + profile 四件套 + 插件实体）`;
  }
  const restore = path.join(dir, 'restore-upgrade.mjs');
  const exists = (() => { try { return fs.existsSync(restore); } catch { return false; } })();
  const tail = exists
    ? `回滚用 ${restore}（先 --check 对账，再 --all 三件套同批还原）`
    : `回滚用 ${restore}（⚠️ 该文件当前不存在，先确认备份目录是否已被归档/搬走）`;
  const extra = ev.state === 'interrupted'
    ? '；确认无需回滚则跑 upgrade-lock-cli.mjs clear 释放锁（别让它一直挂着）'
    : '';
  return `${head}，${tail}${extra}`;
}

/**
 * 锁状态总览（含判定 + 文案；CLI / 面板 / 日报的唯一数据源）。
 * @param {{home?:string, now?:number, heartbeatTtlMs?:number, maxAgeMs?:number}} [opts]
 */
export function status(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const r = readLock(opts);
  const ev = evaluate(r.lock, { now, heartbeatTtlMs: opts.heartbeatTtlMs, maxAgeMs: opts.maxAgeMs });
  const state = r.corrupt ? 'unknown' : ev.state;
  return {
    ...ev,
    state,
    file: r.file,
    exists: r.exists,
    corrupt: r.corrupt,
    summary: describeLock(r.lock),
    hint: state === 'interrupted' || state === 'uncertain' || state === 'unknown'
      ? rollbackHint(r.lock, { ev })
      : null,
    canUpgrade: state === 'none' || state === 'done',
  };
}

// ---------------------------------------------------------------- 写操作

function audit(type, payload, home, silent = true) {
  return appendAudit({ type, ...payload }, { home, silent });
}

/**
 * 创建锁（升级开始）。**防并发**：锁已存在且判为 held → 拒绝并回报锁信息（卡片验收③）。
 * 锁存在但判为 interrupted/uncertain/unknown → 一律拒绝，要接管必须显式 takeover（写审计 + 告警）。
 * @param {{
 *   home?:string, now?:number, pid?:number, sessionId?:string, step?:string, phase?:string,
 *   fromVersion?:string, targetVersion?:string, backupDir?:string, ttlMin?:number, note?:string,
 *   takeover?:boolean, takeoverReason?:string
 * }} [opts]
 * @returns {{ok:boolean, reason?:string, lock?:object, state?:string, previous?:object, hint?:string, file:string, tookOver?:boolean, wrote:boolean}}
 */
export function createLock(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = Number(opts.now ?? Date.now());
  const file = lockPath(home);
  const pid = Number(opts.pid ?? process.ppid ?? 0) || null;
  const pidSource = opts.pid === undefined || opts.pid === null ? 'ppid' : 'caller';
  let outcome = null;

  const decide = (cur) => {
    if (cur && typeof cur === 'object') {
      const ev = evaluate(cur, { now });
      if (ev.state === 'held') {
        outcome = {
          ok: false, reason: 'held', state: 'held', lock: cur, file, wrote: false,
          // held 是硬保护：即使 --takeover 也不接管 —— 两个升级并发写全局 npm = 包目录撕裂。
          // 真要把"其实已经停了的升级"推开，先 clear 释放现场（那一步会留审计），再重新 create。
          hint: `已有升级在跑（${describeLock(cur)}）→ 本次请求被拒（--takeover 也不能抢正在跑的锁）`
            + '；确认它其实已停（进程僵死/主人确认）就先 clear 释放现场，再重新 create',
        };
        return undefined;
      }
      if (!opts.takeover) {
        outcome = {
          ok: false,
          reason: ev.state === 'done' ? 'not-cleared' : (ev.state === 'uncertain' ? 'uncertain' : 'interrupted'),
          state: ev.state, lock: cur, file, wrote: false,
          hint: ev.state === 'done'
            ? `上一把锁已收尾（phase=done）但没释放（${describeLock(cur)}）→ 先 clear 再建新锁`
            : rollbackHint(cur, { ev }),
        };
        return undefined;
      }
    }
    const next = makeLock({
      pid,
      pidSource,
      sessionId: opts.sessionId,
      step: opts.step,
      phase: opts.phase,
      fromVersion: opts.fromVersion,
      targetVersion: opts.targetVersion,
      backupDir: opts.backupDir,
      heartbeatTtlMs: opts.ttlMin ? Number(opts.ttlMin) * 60_000 : undefined,
      note: opts.note,
    }, now);
    outcome = { ok: true, state: 'held', lock: next, file, wrote: true, previous: cur ?? null, tookOver: Boolean(cur) };
    return next;
  };

  try {
    updateJson(file, decide, { schemaVersion: LOCK_SCHEMA, defaultValue: null, home });
  } catch (e) {
    if (e?.code === 'CORRUPT_STATE') {
      // 锁文件不是合法 JSON（被写坏/人为改坏）：不猜内容 → 拒建；--takeover 时直接原子覆盖
      if (opts.takeover) {
        const next = makeLock({ pid, pidSource, sessionId: opts.sessionId, step: opts.step, phase: opts.phase, fromVersion: opts.fromVersion, targetVersion: opts.targetVersion, backupDir: opts.backupDir, heartbeatTtlMs: opts.ttlMin ? Number(opts.ttlMin) * 60_000 : undefined, note: opts.note }, now);
        writeJsonAtomic(file, next, {});
        outcome = { ok: true, state: 'held', lock: next, file, wrote: true, previous: null, tookOver: true, corrupt: true };
      } else {
        outcome = {
          ok: false, reason: 'corrupt', state: 'unknown', lock: null, file, wrote: false,
          hint: `锁文件不是合法 JSON（${file}）→ 人工看一眼再决定（要覆盖请显式 --takeover）`,
        };
      }
    } else if (e?.code === 'SCHEMA_MISMATCH') {
      outcome = {
        ok: false, reason: 'schema-mismatch', state: 'unknown', lock: null, file, wrote: false,
        hint: `锁文件 schemaVersion 不是 ${LOCK_SCHEMA}（${e?.message ?? e}）→ 人工确认，别自动迁移锁`,
      };
    } else {
      throw e;
    }
  }

  if (outcome?.wrote) {
    audit('upgrade-lock-create', {
      step: outcome.lock.step, phase: outcome.lock.phase, pid: outcome.lock.pid,
      sessionId: outcome.lock.sessionId, targetVersion: outcome.lock.targetVersion,
      backupDir: outcome.lock.backupDir, tookOver: Boolean(outcome.tookOver),
      previous: outcome.previous ? { step: outcome.previous.step, pid: outcome.previous.pid, startedAt: outcome.previous.startedAt } : null,
    }, home);
    if (outcome.tookOver) {
      alert({
        level: 'warn', source: 'upgrade-lock',
        message: `升级锁被接管（--takeover）：新 step=${outcome.lock.step}${outcome.previous ? `，接管前 ${describeLock(outcome.previous)}` : ''}`,
        detail: { file, reason: opts.takeoverReason ?? null, previous: outcome.previous ?? null },
      }, { home });
    }
    if (opts.step && !SUGGESTED_STEPS.includes(opts.step)) {
      process.stderr.write(`[upgrade-lock] 提示：step=${opts.step} 不在建议序列（${SUGGESTED_STEPS.join(' → ')}），已按现场记录\n`);
    }
  }
  return outcome;
}

/**
 * 更新步骤 / 刷心跳（升级流程每步调用；同时是"进度日志"的写入点）。
 * `phase` 新进入 `'failed'` 时自动摊"失败态三处视图"（见 `failureViews`）：
 *   alert 无条件落；日报段**只在显式传 `dailyFile` 时**才刷（沙箱安全 —— 不传就绝不碰日报文件）。
 *   直调本函数的调用方（如自动升级编排器）若需要日报段可见，**必须自己传 `dailyFile`**。
 * @param {{home?:string, now?:number, pid?:number, step?:string, phase?:string, note?:string,
 *          heartbeat?:boolean, ttlMin?:number, force?:boolean, dailyFile?:string|null, dryRun?:boolean}} [opts]
 * @returns {object} 成功时含 `failureViews`（仅当本次新进入 failed）
 */
export function updateLock(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = Number(opts.now ?? Date.now());
  const file = lockPath(home);
  let outcome = null;
  const pid = opts.pid === undefined ? null : Number(opts.pid);
  try {
    updateJson(file, (cur) => {
      if (!cur || typeof cur !== 'object') {
        outcome = { ok: false, reason: 'no-lock', file, wrote: false, hint: '没有锁可更新：升级入口应先 create' };
        return undefined;
      }
      if (pid !== null && cur.pid !== null && cur.pid !== undefined && Number(cur.pid) !== pid && !opts.force) {
        outcome = { ok: false, reason: 'not-owner', lock: cur, file, wrote: false, hint: `锁由 pid=${cur.pid} 持有，调用方 pid=${pid} → 拒绝改（要强行改请 --force）` };
        return undefined;
      }
      const next = {
        ...cur,
        step: opts.step ?? cur.step,
        phase: opts.phase ?? cur.phase,
        note: opts.note ?? cur.note ?? null,
        updatedAt: iso(now),
        heartbeatAt: iso(now),
        heartbeatTtlMs: opts.ttlMin ? Number(opts.ttlMin) * 60_000 : cur.heartbeatTtlMs,
      };
      outcome = { ok: true, lock: next, previous: cur, file, wrote: true };
      return next;
    }, { schemaVersion: LOCK_SCHEMA, defaultValue: null, home });
  } catch (e) {
    if (e?.code === 'CORRUPT_STATE') {
      return { ok: false, reason: 'corrupt', file, wrote: false, hint: `锁文件不是合法 JSON（${file}）→ 人工确认（要覆盖请 --takeover）` };
    }
    throw e;
  }
  if (outcome?.wrote) {
    const stepChanged = outcome.previous?.step !== outcome.lock.step || outcome.previous?.phase !== outcome.lock.phase;
    if (stepChanged || opts.auditHeartbeat === true) {
      audit('upgrade-lock-step', {
        step: outcome.lock.step, phase: outcome.lock.phase,
        prevStep: outcome.previous?.step ?? null, prevPhase: outcome.previous?.phase ?? null,
        heartbeatOnly: !stepChanged,
      }, home);
    }
    // ③ 包 C-6（卡 ③-6）· 失败态三处视图：**只在"新进入 failed"时摊一次**
    //   （重复 update（如收尾前再刷心跳）不重复告警；`previous.phase === 'failed'` ⇒ 已摊过）。
    if (outcome.lock.phase === 'failed' && outcome.previous?.phase !== 'failed') {
      outcome.failureViews = failureViews(outcome.lock, {
        home, now,
        dailyFile: opts.dailyFile ?? null,
        dryRun: opts.dryRun === true,
      });
    }
  }
  return outcome;
}

/**
 * 释放锁（升级正常收尾 / 中断后确认无需回滚）。
 * 安全口径：锁还"活着"（held）且 pid 不是自己 → 拒绝（除非 force）。
 * @param {{home?:string, now?:number, pid?:number, force?:boolean, reason?:string}} [opts]
 */
export function clearLock(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = Number(opts.now ?? Date.now());
  const file = lockPath(home);
  const cur = readLock({ home, now });
  if (!cur.exists) return { ok: true, reason: 'none', file, removed: false, hint: '本来就没有锁' };
  if (cur.corrupt) {
    if (!opts.force) {
      return { ok: false, reason: 'corrupt', file, removed: false, hint: `锁文件不是合法 JSON（${cur.corrupt}）→ 确认后 --force 删除` };
    }
    if (!removeGuarded(file, { whitelist: [path.dirname(file)], reason: '清损坏锁（forced）' })) {
      return { ok: false, reason: 'refused', file, removed: false, hint: '被 R-065 三件套拒绝（未删除）' };
    }
    audit('upgrade-lock-clear', { forced: true, reason: opts.reason ?? null, corrupt: cur.corrupt }, home);
    alert({ level: 'warn', source: 'upgrade-lock', message: `锁文件损坏，已按 --force 删除：${file}`, detail: { corrupt: cur.corrupt } }, { home });
    return { ok: true, reason: 'cleared-corrupt', file, removed: true };
  }
  const ev = evaluate(cur.lock, { now });
  const callerPid = opts.pid === undefined || opts.pid === null ? null : Number(opts.pid);
  // "释放别人的活锁"保护：只在**显式声明了 pid 且与锁持有者不同**时才拒绝。
  // 不传 pid = 调用方未声明身份（CLI 收尾的常见形态）→ 放行：误清的后果（另一场升级失去互斥）
  // 远小于"收尾步骤被自己的保护卡死、逼人用 --force 把审计写成 forced"的代价。
  if (ev.state === 'held' && callerPid !== null && cur.lock.pid && callerPid !== Number(cur.lock.pid) && !opts.force) {
    return {
      ok: false, reason: 'held', lock: cur.lock, file, removed: false,
      hint: `升级还在跑（${describeLock(cur.lock)}）且调用方声明了另一个 pid=${callerPid} → 拒绝释放（要强制释放请 --force）`,
    };
  }
  if (!removeGuarded(file, { whitelist: [path.dirname(file)], reason: '释放升级锁' })) {
    return { ok: false, reason: 'refused', file, removed: false, hint: '被 R-065 三件套拒绝（未删除）' };
  }
  audit('upgrade-lock-clear', {
    forced: Boolean(opts.force), reason: opts.reason ?? null,
    state: ev.state, step: cur.lock.step, pid: cur.lock.pid, startedAt: cur.lock.startedAt,
  }, home);
  return { ok: true, reason: 'cleared', file, removed: true, state: ev.state, lock: cur.lock };
}

/**
 * 中断检测（启动链路 / 人工调用）。判为中断 → 报警（lib/alert.mjs 通道）+ 返回回滚文案。
 * 噪音口径：只有**判到中断**（pid 是声明过的升级执行者且已死 / 心跳过期且 pid 不活）与
 * **锁不可判定**（unknown：写坏/schema 不符）才落 alert；`uncertain`（进程还活着只是没进展）
 * 只返回提示、不报警 —— 否则正常升级的每一步之间都会刷告警，把真信号淹掉。
 * @param {{home?:string, now?:number, silent?:boolean}} [opts]
 * @returns {{interrupted:boolean, warn:boolean, alerted:boolean, state:string, status:object, message:string|null}}
 */
export function detectInterrupted(opts = {}) {
  const st = status(opts);
  const interrupted = st.state === 'interrupted';
  const warn = st.state === 'uncertain' || st.state === 'unknown' || st.state === 'done';
  let message = null;
  let alerted = false;
  if (interrupted) {
    message = `检测到升级中断：${st.hint}`;
    alert({
      level: 'error', source: 'upgrade-lock', message,
      detail: { file: st.file, lock: st.lock, hint: st.hint },
    }, { home: opts.home, silent: opts.silent });
    alerted = true;
  } else if (st.state === 'unknown') {
    message = `升级锁状态无法判定（${st.corrupt ?? '时间戳不可解析'}）→ 人工看 ${st.file}`;
    alert({
      level: 'warn', source: 'upgrade-lock', message,
      detail: { file: st.file, lock: st.lock, corrupt: st.corrupt },
    }, { home: opts.home, silent: opts.silent });
    alerted = true;
  } else if (warn) {
    message = st.state === 'uncertain'
      ? `升级锁心跳过期但进程仍活（${describeLock(st.lock)}）→ 可能在长步骤里卡住，确认下再决定回滚/释放`
      : `上一把锁已收尾（phase=done）但未释放（${describeLock(st.lock)}）→ 跑 clear 收尾`;
  }
  return { interrupted, warn, alerted, state: st.state, status: st, message };
}

// ---------------------------------------------------------------- 日报段（report.mjs 与检测脚本共用同一口径）

/** 日报段标题锚点（幂等刷新用；改这里必须同步 report.mjs 的 push 标题）。 */
export const DAILY_SECTION_TITLE = '## 🔒 升级锁（B3 前置）';

/**
 * 生成日报段正文（纯函数，不带换行尾部）。
 * @param {object} st status() 的返回值
 * @param {{daily?:boolean, cap?:object, capability?:boolean, home?:string, version?:string}} [opts]
 *   - `cap`：已探好的能力档结果（幂等/可注入，避免重复读盘）
 *   - `capability:false`：显式关闭该行（仅供 A/B 对照；生产不允许关）
 */
export function dailySectionLines(st, opts = {}) {
  const L = [DAILY_SECTION_TITLE, ''];
  // 能力档（U-6 · ④-4 · 方案 §3.6-2 ②「报告/日报显式打一行」）：
  //   跨机版本共存下"未升机读到新口径副本"时，`unknown` 会让全链按最保守口径跑 —— 日报必须写在脸上。
  const cap = resolveCapability(opts);
  if (cap) L.push(`- ${capabilityLine(cap)}${cap.ok === false ? ' → **真升级一律拒（不执行任何写步骤）**' : ''}`);
  const icon = st.state === 'interrupted' ? '🔴' : (st.state === 'uncertain' || st.state === 'unknown' ? '🟡' : (st.state === 'held' ? '⏳' : '✅'));
  if (st.state === 'none') {
    L.push('- ✅ 无锁：没有升级在进行（上一次升级已正常收尾）');
    L.push(`- 路径：\`~/.dsh/${LOCK_NAME}\``);
  } else {
    L.push(`- ${icon} 状态：**${st.state}** · ${st.summary}`);
    if (st.state === 'interrupted') {
      L.push(`- 回滚口径：${st.hint}`);
      L.push('- 判据：心跳过期（> ' + Math.round((st.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS) / 60000) + ' 分钟无 update）且 pid 已不在 → 判为中断现场');
    } else if (st.state === 'held') {
      L.push('- 判据：心跳新鲜（升级流程每步 update 会刷新）→ 视为升级进行中；此刻不应再发起第二次升级');
    } else if (st.state === 'uncertain') {
      L.push(`- 注意：${st.hint}`);
    } else if (st.state === 'done') {
      L.push('- 说明：锁 phase=done 但未释放 → 跑 `node <workspace>\\tools\\dsh-butler\\upgrade-lock-cli.mjs clear` 收尾');
    } else {
      L.push(`- 注意：${st.hint ?? '锁状态无法判定'}`);
    }
    L.push(`- 路径：\`${st.file}\``);
  }
  return L;
}

/**
 * 探能力档（日报段用，**永不抛**）：默认读本机主包实体版本；
 * 调用方可传已探好的 `opts.cap`（幂等/可注入），或 `opts.capability:false` 显式关闭该行。
 * @returns {object|null}
 */
function resolveCapability(opts = {}) {
  if (opts.cap) return opts.cap;
  if (opts.capability === false) return null;
  try { return probeHostLine({ home: opts.home, version: opts.version }); } catch { return null; }
}

/**
 * 幂等刷新已存在日报里的「🔒 升级锁」段（找不到日报/锚点则跳过，绝不新建文件）。
 * @param {string} file
 * @param {object} st status() 的返回值
 * @param {{dryRun?:boolean}} [opts]
 */
export function refreshDailySection(file, st, opts = {}) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'daily-missing', file };
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*🔒\s*升级锁/.test(l));
  const block = dailySectionLines(st, opts);
  let next;
  if (start < 0) {
    // 日报由 report.mjs 每次覆盖重写 → 段不存在是正常情况（新加的段），此时不硬插（避免与生成器打架）
    return { ok: false, reason: 'anchor-missing', file };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
  }
  next = [...lines.slice(0, start), ...block, '', ...lines.slice(end)].join(eol).replace(/\n{3,}/g, '\n\n');
  next = next.replace(/\r?\n{3,}/g, eol + eol);
  if (next === raw) return { ok: true, action: 'unchanged', file };
  if (opts.dryRun) return { ok: true, action: 'would-update', file };
  fs.writeFileSync(file, next, 'utf8');
  return { ok: true, action: 'updated', file };
}

/** 当天日报路径（与 report.mjs 同口径：docs\管家报告\<YYYY-MM-DD>-<host>.md）。 */
export function dailyPath(now = Date.now(), docsRoot = '<workspace>\\docs\\管家报告') {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return path.join(docsRoot, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${os.hostname()}.md`);
}

// ---------------------------------------------------------------- 失败态三处视图（③ 包 C-6 · 卡 ③-6）

/** 升级失败态的段名（③ 包 `§3.6` C-6 三段；锁内 `note` 是判段的唯一依据）。 */
export const FAILURE_SEGMENTS = {
  selfcheck: '① 自检未过（执行者自动回滚）',
  undecidable: '② 自检不可判定（守护鱼冻结现场）',
  rollbackFailed: '③ 回滚失败（停手等人工）',
};

/**
 * **失败态三处视图**（③ 包 C-6 · 卡 ③-6）—— 载体唯一源 = 本锁；本函数只做"把锁里的失败事实摊到人看得见的地方"：
 *   ① **alert**（`lib/alert.mjs` 通道，独立于管家自身组件；lock 写不进时也照发）
 *   ② **日报段**（**显式传 `dailyFile` 才刷** —— 沙箱安全：不传就绝不碰任何日报文件；幂等刷新既有段）
 *   ③ **待你操作清单**（`docs\待你操作-<设备>.md` 由 `tools\owner-todo-scan.mjs` 采集本锁生成 —— 本函数**不写文档**，避免与清单生成器整体重写打架）
 *
 * 口径（不许改）：**不改判定语义**（不读盘、不写锁，只用传入的锁快照）；**幂等**由调用方门控
 * （`updateLock` 用 `previous.phase !== 'failed'` ⇒ 同一次失败只摊一次，重复 `update` 不重复告警）。
 *
 * @param {object} lock updateLock 写盘后的锁快照
 * @param {{home?:string, dailyFile?:string|null, now?:number, dryRun?:boolean}} [opts]
 * @returns {{segment:string, alertLevel:'error'|'warn', alerted:boolean, alertFile:string|null, daily:object|null, message:string}}
 */
export function failureViews(lock, opts = {}) {
  const home = opts.home ?? dshHome();
  const now = Number(opts.now ?? Date.now());
  const note = lock?.note ?? null;
  // 段③（回滚失败）＝ 已尝试回滚仍失败 ⇒ 人的事（🔴）；段①（自检未过）＝ 有自动化出路 ⇒ ⚠️。
  const rollbackFailed = String(note ?? '').includes('rollback-failed');
  const segment = rollbackFailed ? FAILURE_SEGMENTS.rollbackFailed : FAILURE_SEGMENTS.selfcheck;
  const alertLevel = rollbackFailed ? 'error' : 'warn';
  const message = rollbackFailed
    ? `升级回滚失败（段③）：停在 step=${lock?.step ?? '?'}（${describeLock(lock)}）→ 停手不重试、保留现场；处置入口 = 桌面 DSH急救.cmd`
    : `升级自检未过（段①）：停在 step=${lock?.step ?? '?'}（${describeLock(lock)}）→ 按锁内 backupDir 回滚`;
  const r = alert({
    level: alertLevel, source: 'upgrade-lock', message,
    detail: { file: lockPath(home), phase: lock?.phase ?? null, note, step: lock?.step ?? null, backupDir: lock?.backupDir ?? null, segment, lock: lock ?? null },
  }, { home });
  let daily = null;
  if (opts.dailyFile) {
    daily = refreshDailySection(opts.dailyFile, status({ home, now }), { dryRun: opts.dryRun === true });
  }
  return { segment, alertLevel, alerted: r.ok === true, alertFile: r.file ?? null, daily, message };
}
