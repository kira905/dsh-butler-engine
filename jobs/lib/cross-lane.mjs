// dsh-butler / lib/cross-lane.mjs —— 跨线写者判定原语（家规 R8 的唯一判据源）
//
// 方案依据：docs\跨线契约包-方案-20260917.md §3.2 C-2（落地卡 ③-1）
//   家规 R8（§3.1）：任何会**写生产文件**的动作线，动手前必须声明自己占了哪块生产面、
//   并让路给更上游的线；**判据唯一源 = 本模块**；**判据不可用 → 保守让路（宁可不动，不可赌）**。
//
// ── 本模块是什么（薄壳，不发明语义）─────────────────────────────────────────────
//   它是**只读判定 + 一处抢锁**：所有核心语义都复用既有件，本文件不复制它们的算法：
//     · 升级线占位凭证 `~/.dsh/upgrade-lock` → 复用 lib/upgrade-lock.mjs 的 `readLock()` + `evaluate()`
//       （pidSource / 心跳 TTL / interrupted / uncertain / unknown 的判定一字不改）
//     · 交接线占位凭证 `butler-locks/tick-handoff.lock` → 复用 lib/handoff-version-gate.mjs 的
//       `detectHandoffWindow()`（"交接窗口的唯一权威信号"就是那把锁，见其 §2 注释）
//     · 静默窗 `upgrade-silence-state.json` → 只读解析（兼容 v1 单 phase / v2 holders）
//     · 抢锁式占位 → 复用 lib/store.mjs 的 `acquireTickLock()`（与 tick 自己的互斥语义同一把锁）
//
// ── 三条硬口径（照抄既有先例，不发明）──────────────────────────────────────────
//   ① **抢锁 = 唯一判定**（先例 lib/single-writer.mjs:12-16）：只读探测（锁文件年龄/pid/状态文件）
//      只作**旁证与解释**，不承担"能不能动手"的判定；要动手就先 `acquireLaneGuard()` 抢锁。
//   ② **显式 `env:{}` —— 两个变量都要屏蔽**（审方案意见 T2 · 轮五实证 E6）：`acquireTickLock` 的
//      虚拟锁继承有**两条**通道 —— `DSH_BUTLER_TICK_LOCK_HELD`（列表含本锁名）**或**
//      `DSH_HANDOFF_LOCK_HELD === '1'`（handoff 专用直通）。只屏蔽第一个 ⇒ 在交接线自己设过第二个
//      变量的进程里会**静默拿到假锁**、护栏形同虚设。store 内部两个变量都读 `opts.env`，
//      故本模块一律 `env:{}`（一次屏蔽两个）。
//   ③ **fail-safe = 保守让路**：`judgeLane()` 抛错 / 判据文件不可解析 / 结构不符 ⇒
//      `verdict:'yield'` + `judgeUnavailable:true`，**绝不允许"判不了就当没事"**。
//      （方案 §4.3 实测口径：tick 锁结构 `{pid,startedAt,ttl,kind:'tick',name}` / RMW 锁
//       `{pid,startedAt,ttl,kind:'rmw',target}`；**字段缺失或 kind 不符 ⇒ 判据不可用 ⇒ yield**，
//      不许当成"锁不存在"。）
//
// ── 边界（红线圈）──────────────────────────────────────────────────────────────
//   · **零主包依赖**：本模块只 import node 内置 + 本目录 lib（guard.mjs 要在 DSH 崩掉时也能 import
//     它，方案 §3.5(a) 的闸 1 就挂在这条链上）。
//   · **零副作用**：不写状态文件、不写审计、不发 alert、不改开关值。四类事件（让路 / 被让 / 冲突 /
//     判据不可用）的**可见性由调用方落**（审计由发起动作的线写、日报段由 `laneSectionLines()` 铺）——
//     本模块自己写审计会与 ③-2「tidy 让路不写审计行」的口径打架。
//   · **纯函数可注入**：`home` / `now` / `pidAlive` 全部可传参 ⇒ 单测零 I/O、可穷举六态。
//   · 唯一非只读函数 = `acquireLaneGuard()`（它要真抢锁；这是"唯一判定"的必要代价）。
//
// ── verdict 三态的定义（本卡定义，写清以便调用方按档行事）──────────────────────
//   · `clear`   = 无更高优先写者在场 ⇒ 可以动手。
//   · `yield`   = 有更高优先写者 ⇒ **本线让路**（整轮跳过 / 只报告不写），或判据不可用时的保守让路。
//   · `blocked` = 有更高优先写者，且**本线做不到"让路后照跑"**（守护鱼接管 / 小护士 apply）
//                 ⇒ 必须放弃该动作本身（不接管 / 拒启）。映射见 `LANE_SELF_PROFILES`。
//   · `observe`（画像，不是 verdict）= 只读观测线（日报/面板呈现）：永不给 blocked，只如实报"谁在占位"。
//   ⚠️ **判据不可用永远给 `yield`**（不给 `blocked`）：保守方向是"不动"，而不是"改走另一条动作"。
//
// ── 一处与方案字面的收窄（如实标注，别当已拍）──────────────────────────────────
//   方案 §3.2 的 `judgeLane()` 返回类型里 `owner` 含 `'nurse'`；但同方案 §3.1 契约表明写小护士
//   "低优先、最后动手、**它必须让给谁**=升级链/交接"，**没有任何线必须让给它**，且静默窗被明写为
//   "是闸门不是写者"（让路档 `—`）⇒ 本实现**不产生 owner='nurse'**：静默窗持有者只作证据与提示。
//   若后续卡（③-4/③-5）需要"护士占位让别人让路"，属新增口径，须先改方案再改本模块。

import fs from 'node:fs';
import path from 'node:path';
import { butlerPaths, dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { acquireTickLock } from '../../src/dsh-butler/lib/store.mjs';
import { describeLock, evaluate, readLock } from './upgrade-lock.mjs';
import { HANDOFF_TICK_LOCK, detectHandoffWindow } from '../../src/dsh-butler/lib/handoff-version-gate.mjs';

export const CROSS_LANE_VERSION = '0.1.0';

/** 日报段标题锚点（幂等刷新/测试锚点用）。 */
export const LANE_SECTION_TITLE = '## 🔗 跨线契约（R8 单写者）';

/** 升级锁六态（穷举口径真源；与 lib/upgrade-lock.mjs 的 evaluate() 返回值同集）。 */
export const UPGRADE_SIX_STATES = Object.freeze(['none', 'held', 'uncertain', 'interrupted', 'done', 'unknown']);
/** 三态=占位（方案 §3.5(a)：**三态全禁** —— held 正在写 profile / uncertain 挂着没进展 / interrupted 半升级现场）。 */
export const UPGRADE_HOLDING_STATES = Object.freeze(['held', 'uncertain', 'interrupted']);

export const SILENCE_STATE_BASENAME = 'upgrade-silence-state.json';
/** 抢锁式占位的默认 TTL（临界区短：一次搬移/一次采集；由调用方按实际预算覆盖）。 */
export const LANE_GUARD_TTL_MS = 120_000;

/**
 * 本线画像（决定"有窗口时该 yield 还是 blocked"）：
 *   top     = 最高优先，不吃任何让路（升级链自己读锁只为"有没有第二把"）
 *   peer    = 就是该窗口的线本身（交接线读交接锁 = 读自己的锁，不算被挡）
 *   skip    = 让路后照跑（跳过整轮），P8 采集/搬移属此
 *   refuse  = 让路后没法照跑，只能放弃该动作（守护鱼"不接管" / 护士 apply"拒启"）
 *   observe = **只读观测线**（日报/面板的呈现）：不写生产面、不产生任何动作 ⇒ 永不给 blocked，
 *             只把"谁在占位、谁该让路"如实报出来。红线：observe 档**不消费任何去重/冷却配额、
 *             不写任何状态文件**（本模块本就不写；调用方也不许因为"呈现"而写配额）。
 * ⚠️ **未知 self 一律按 `refuse`**（保守方向：不认识就宁可不接管/拒启）。
 */
export const LANE_SELF_PROFILES = Object.freeze({
  upgrade: 'top',
  handoff: 'peer',
  tidy: 'skip',
  p8: 'skip',
  nurse: 'refuse',
  guard: 'refuse',
  report: 'observe',
  panel: 'observe',
  observe: 'observe',
});

/** self 名 → 画像（未知 → 'refuse'）。 */
export function selfProfile(self) {
  const key = String(self ?? '').trim();
  return Object.prototype.hasOwnProperty.call(LANE_SELF_PROFILES, key) ? LANE_SELF_PROFILES[key] : 'refuse';
}

const msgOf = (e) => String(e?.message ?? e ?? '未知错误');

// ---------------------------------------------------------------- 三个载体的只读解析

/**
 * 升级线状态（占位凭证 = `~/.dsh/upgrade-lock`）。
 * 复用 upgrade-lock 的 readLock + evaluate：**判定语义不在本模块复制**。
 * @param {string|null} home
 * @param {{now?:number, pidAlive?:boolean, home?:string}} [opts]
 * @returns {{state:string, step:string|null, phase:string|null, ageMs:number|null, heartbeatAgeMs:number|null,
 *            ttlMs:number|null, pid:number|null, pidAlive:boolean|null, file:string, exists:boolean,
 *            corrupt:string|null, summary:string, holding:boolean, judgeUnavailable:boolean, unavailableWhy:string|null,
 *            abandoned:boolean, abandonWhy:string|null,
 *            abandonSignal:'both'|'pid-dead'|'heartbeat-stale'|null,
 *            heartbeatStale:boolean, pidDeadSignaled:boolean}}
 */
export function readUpgradeState(home = null, opts = {}) {
  const h = home ?? opts.home ?? dshHome();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const r = readLock({ home: h });
  const pidOpt = opts.pidAlive === undefined ? {} : { pidAlive: opts.pidAlive === true };
  const ev = evaluate(r.lock, { now, ...pidOpt });

  let judgeUnavailable = false;
  let unavailableWhy = null;
  if (r.corrupt) {
    judgeUnavailable = true;
    unavailableWhy = `升级锁不可解析（${r.corrupt}）`;
  } else if (r.exists && !r.lock) {
    judgeUnavailable = true;
    unavailableWhy = '升级锁文件存在但内容为空/非对象';
  } else if (ev.state === 'unknown') {
    judgeUnavailable = true;
    unavailableWhy = '升级锁时间戳不可解析（evaluate → unknown）';
  }
  const state = r.corrupt ? 'unknown' : ev.state;
  // 文案修正：文件在但读不出 ≠「无锁」——describeLock(null) 会说"（无锁）"，那会让日报误导
  //（实测 e2e 场景 C：段里出现「unknown · （无锁）」）。故坏锁/空锁一律显式写清。
  const summary = (r.corrupt || (r.exists && !r.lock))
    ? `（锁文件存在但不可解析 → 判据不可用）`
    : describeLock(r.lock);

  // ---------------------------------------------------------------- 【卡「升级链健壮性1」· 2026-10-16】中断现场判据
  // 事故背景：`（内部事故档）` —— 跑升级的那一端断网消失，
  //   锁留在对端、持锁进程 pid 已退出，但守护鱼的让路判据只认「锁在不在」⇒ **服务停了 48 分钟**。
  //
  // 判据（**唯一源，只此一份**）：锁处于在途态（held/uncertain/interrupted）且满足任一「没人管」信号：
  //   ① `heartbeat-stale` —— 心跳已超 TTL（heartbeatAgeMs > ttlMs）
  //   ② `pid-dead`        —— 持锁进程已退出（`evaluate()` 的 pidAlive === false；pid 缺失/null 同判）
  // 全部输入都是 `evaluate()` 的产物 ⇒ **不重写锁语义**（六态 / pidSource / TTL 判定一字未改）。
  // ⚠️ 判据不可用（unknown / 坏锁）**不算**中断现场 —— 那时不猜，仍走保守让路。
  // 🔴 **两个信号必须恒分别暴露**（这就是 `abandonSignal` 存在的理由）：
  //   守则/档案 `docs\升级锁与中断检测-20260911.md` §三.2 + §七.4 写明：升级链**每一步都是一次独立
  //   CLI 调用**，锁里默认记的 pid = `process.ppid`（**短命**：调用它的 shell 一退出就死），而
  //   `updateLock()` **不刷新 pid 字段**（只刷 step/phase/heartbeatAt）。⇒ 在**完全正常的升级里**，
  //   「pid 已死 + 心跳新鲜」是**常规形态**（长步骤如 `npm install` 期间尤其如此）。
  //   ⇒ 若在这里就把 pid-dead 当成"中断现场"，守护鱼会在真升级进行中接管拉起 dsh = **踩本卡头号红线**。
  //   ⇒ 故本函数只**如实报告信号**；「哪些信号足以放行」由消费侧开关决定（gateDecision）：
  //      默认只认 `heartbeat-stale`（TTL 是创建方自己声明的"我多久不打心跳就不算在跑"），
  //      `pid-dead` 是**默认关**的激进档（想更快自愈才开，代价见交付报告 §风险）。
  const holding = UPGRADE_HOLDING_STATES.includes(state);
  const pidDead = ev.pidAlive === false;
  const hbStale = Number.isFinite(ev.heartbeatAgeMs) && Number.isFinite(ev.ttlMs) && ev.heartbeatAgeMs > ev.ttlMs;
  const abandoned = holding && !judgeUnavailable && (pidDead || hbStale);
  const minsLeft = (Number.isFinite(ev.heartbeatAgeMs) && Number.isFinite(ev.ttlMs))
    ? Math.max(0, Math.round((ev.ttlMs - ev.heartbeatAgeMs) / 60_000)) : null;
  const minsOver = (Number.isFinite(ev.heartbeatAgeMs) && Number.isFinite(ev.ttlMs))
    ? Math.max(0, Math.round((ev.heartbeatAgeMs - ev.ttlMs) / 60_000)) : null;
  const pidTxt = `pid ${r.lock?.pid ?? '（锁里没记）'}`;
  const abandonSignal = !abandoned ? null
    : ((pidDead && hbStale) ? 'both' : (pidDead ? 'pid-dead' : 'heartbeat-stale'));
  const abandonWhy = !abandoned ? null
    : (pidDead && hbStale
      ? `${pidTxt} 已退出 · 心跳已超 TTL ${minsOver} 分钟（state=${state}）`
      : (pidDead
        ? `${pidTxt} 已退出（心跳仍有 ${minsLeft} 分钟余量，state=${state}）⚠️ ppid 形态下这是正常形态，须开关放行`
        : `心跳已超 TTL ${minsOver} 分钟（${pidTxt} ${ev.pidAlive === true ? '仍活着' : '状态未知'}，state=${state}）`));

  return {
    state,
    step: ev.step, phase: ev.phase,
    ageMs: ev.ageMs, heartbeatAgeMs: ev.heartbeatAgeMs, ttlMs: ev.ttlMs,
    pid: r.lock?.pid ?? null, pidAlive: ev.pidAlive,
    file: r.file, exists: r.exists, corrupt: r.corrupt,
    summary,
    holding,
    // 【卡「升级链健壮性1」】中断现场：锁在但没人管（心跳超 TTL 或 持锁进程已退出）
    abandoned, abandonWhy, abandonSignal,
    // 两个信号**分开**暴露给消费侧（默认档只认 heartbeat-stale；pid-dead 是激进档）
    heartbeatStale: hbStale, pidDeadSignaled: pidDead,
    judgeUnavailable, unavailableWhy,
  };
}

/**
 * 交接窗口（占位凭证 = `butler-locks/tick-handoff.lock`，4 入口共用单例）。
 * 先做**结构校验**（方案 §4.3：字段缺失/kind 不符 ⇒ 判据不可用 ⇒ yield），
 * 过了校验才把判定交给既有唯一权威 `detectHandoffWindow()`。
 * @param {string|null} home
 * @param {{now?:number, pidAlive?:boolean, home?:string}} [opts]
 * @returns {{lockPath:string, active:boolean, holders:object[], ageMs:number|null, ttlMs:number|null,
 *            stale:boolean, expiresInMs:number|null, reason:string, judgeUnavailable:boolean,
 *            unavailableWhy:string|null, corrupt:string|null}}
 */
export function readHandoffWindow(home = null, opts = {}) {
  const h = home ?? opts.home ?? dshHome();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lockPath = path.join(butlerPaths(h).locks, `tick-${HANDOFF_TICK_LOCK}.lock`);
  /** @type {any} */
  const base = {
    lockPath, active: false, holders: [], ageMs: null, ttlMs: null, stale: false,
    expiresInMs: null, reason: '无交接锁（不在交接窗口）',
    judgeUnavailable: false, unavailableWhy: null, corrupt: null,
  };
  let exists = false;
  try { exists = fs.existsSync(lockPath); } catch { exists = false; }
  if (!exists) return base;

  let raw = null;
  try {
    const text = fs.readFileSync(lockPath, 'utf8');
    raw = text.trim() ? JSON.parse(text) : null;
  } catch (e) {
    return {
      ...base, judgeUnavailable: true, corrupt: msgOf(e),
      reason: '交接锁不可解析 → 判据不可用（保守让路）',
      unavailableWhy: `交接锁不可解析（${msgOf(e)}）`,
    };
  }

  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('内容非对象（空/损坏）');
  } else {
    if (raw.kind !== 'tick') problems.push(`kind=${JSON.stringify(raw.kind)} ≠ 'tick'`);
    if (raw.name !== HANDOFF_TICK_LOCK) problems.push(`name=${JSON.stringify(raw.name)} ≠ '${HANDOFF_TICK_LOCK}'`);
    if (!Number.isFinite(Number(raw.startedAt)) || Number(raw.startedAt) <= 0) problems.push('startedAt 缺失/非数');
    if (!Number.isFinite(Number(raw.ttl)) || Number(raw.ttl) <= 0) problems.push('ttl 缺失/非数');
  }
  if (problems.length) {
    return {
      ...base, judgeUnavailable: true, corrupt: problems.join('；'),
      reason: '交接锁结构不符 → 判据不可用（保守让路）',
      unavailableWhy: `交接锁结构不符（${problems.join('；')}）`,
    };
  }

  const win = detectHandoffWindow({
    home: h, now,
    ...(opts.pidAlive === undefined ? {} : { isAlive: () => opts.pidAlive === true }),
  });
  const ageMs = now - Number(raw.startedAt);
  const ttlMs = Number(raw.ttl);
  return {
    lockPath,
    active: win.active === true,
    holders: [{ pid: Number(raw.pid) || null, name: String(raw.name), startedAt: Number(raw.startedAt), ttl: ttlMs, ageMs }],
    ageMs, ttlMs,
    stale: ageMs > ttlMs,
    expiresInMs: win.expiresInMs ?? null,
    reason: win.reason,
    signals: win.signals ?? [],
    judgeUnavailable: false,
    unavailableWhy: null,
    corrupt: null,
  };
}

/**
 * 静默窗持有者（闸门，**不是写者** ⇒ 不参与让路判定，只作证据与提示）。
 * 兼容读 v1（无 `holders` 单 phase）与 v2（`holders{}` 引用计数）——方案 §3.5(c)。
 * @param {string|null} home
 * @param {{home?:string}} [opts]
 * @returns {{file:string, exists:boolean, open:boolean|null, holders:{id:string,at:string|null,reason:string|null}[],
 *            schemaVersion:number|null, legacy:boolean, phase:string|null, anomaly:string|null,
 *            error:string|null, judgeUnavailable:boolean, reason:string}}
 */
export function readSilenceHolders(home = null, opts = {}) {
  const h = home ?? opts.home ?? dshHome();
  const file = path.join(h, SILENCE_STATE_BASENAME);
  const base = {
    file, exists: false, open: false, holders: [], staleHolders: [], schemaVersion: null,
    legacy: false, phase: null, anomaly: null, error: null, judgeUnavailable: false,
    reason: '无静默窗状态文件（未开过窗）',
  };
  let exists = false;
  try { exists = fs.existsSync(file); } catch { exists = false; }
  if (!exists) return base;

  let st = null;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { ...base, exists: true, open: null, error: msgOf(e), reason: `静默窗状态不可解析（${msgOf(e)}）→ 只作证据缺失，不阻断跨线判定` };
  }
  if (!st || typeof st !== 'object' || Array.isArray(st)) {
    return { ...base, exists: true, open: null, error: 'not-object', reason: '静默窗状态非对象 → 只作证据缺失，不阻断跨线判定' };
  }

  const phase = st.phase ?? null;
  const isV2 = Number(st.schemaVersion) >= 2 || (st.holders && typeof st.holders === 'object' && !Array.isArray(st.holders));
  // 超期判定（卡 ③-4 第 7 条 · 方案 §3.5(c)「任一 holder 持有 > 4h ⇒ alert + 日报段」）：
  // 本库只做**只读呈现**（alert 由 `dsh-upgrade-silence.mjs --check-stale` 发），判定不在日报里复制。
  const nowMs = Date.now();
  const STALE_MS = 4 * 3600 * 1000;
  const markStale = (arr) => arr.map((h) => {
    const t = h.at ? Date.parse(h.at) : NaN;
    const ageMs = Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
    return { ...h, ageMs, stale: ageMs !== null && ageMs > STALE_MS };
  });
  const staleNote = (arr) => {
    const s = arr.filter((h) => h.stale).map((h) => h.id);
    return s.length ? `；⚠️ 疑似残留（持有 >4h）：${s.join(' / ')}` : '';
  };
  if (isV2) {
    const raw = st.holders && typeof st.holders === 'object' && !Array.isArray(st.holders) ? st.holders : {};
    const holders = markStale(Object.keys(raw).map((id) => {
      const v = (raw[id] && typeof raw[id] === 'object') ? raw[id] : {};
      return { id, at: v.at ?? null, reason: v.reason ?? null };
    }));
    const open = holders.length > 0;
    const anomaly = (phase === 'disabled' && holders.length === 0)
      ? 'half-open（phase=disabled 但 holders 为空 → 半完成态，③-4 的 --ensure 兜底对象）'
      : ((phase !== 'disabled' && holders.length > 0) ? 'phase≠disabled 但仍有 holders（疑似残留）' : null);
    return {
      file, exists: true, open, holders,
      staleHolders: holders.filter((h) => h.stale).map((h) => h.id),
      schemaVersion: Number(st.schemaVersion) || 2, legacy: false, phase, anomaly, error: null,
      judgeUnavailable: false,
      reason: (open ? `静默窗开启（${holders.length} 个持有者）` : '静默窗未开') + staleNote(holders),
    };
  }

  // 兼容读 v1：无 holders → 视为单一 holder `legacy`（方案 §3.5(c) 原文；不迁移历史）
  const open = phase === 'disabled';
  const legacyHolders = markStale(open ? [{ id: 'legacy', at: st.disabledAt ?? null, reason: 'v1-single-phase' }] : []);
  return {
    file, exists: true, open,
    holders: legacyHolders,
    staleHolders: legacyHolders.filter((h) => h.stale).map((h) => h.id),
    schemaVersion: Number(st.schemaVersion) || 1, legacy: true, phase, anomaly: null, error: null,
    judgeUnavailable: false,
    reason: (open ? '静默窗开启（v1 单 phase → 单一 holder legacy）' : '静默窗未开（v1 文件）') + staleNote(legacyHolders),
  };
}

// ---------------------------------------------------------------- 汇总判定

/**
 * 汇总跨线判定（**纯只读**；判据抛错/不可用 ⇒ 保守让路）。
 * @param {{home?:string, self?:string, now?:number, pidAlive?:boolean}} [opts]
 * @returns {{at:string, self:string, profile:string, verdict:'clear'|'yield'|'blocked',
 *            owner:'upgrade'|'handoff'|null, reasons:string[], judgeUnavailable:boolean,
 *            evidence:{home:string, upgrade:object, handoff:object, silence:object}, summary:string}}
 */
export function judgeLane(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const self = String(opts.self ?? 'unknown');
  const profile = selfProfile(self);
  const reasons = [];
  let failure = null;

  let upgrade = null;
  try { upgrade = readUpgradeState(home, { now, pidAlive: opts.pidAlive }); }
  catch (e) { failure = `升级锁判据抛错：${msgOf(e)}`; }
  let handoff = null;
  try { handoff = readHandoffWindow(home, { now, pidAlive: opts.pidAlive }); }
  catch (e) { failure = failure ?? `交接窗口判据抛错：${msgOf(e)}`; }
  let silence = null;
  try { silence = readSilenceHolders(home, {}); }
  catch (e) {
    silence = {
      file: path.join(home, SILENCE_STATE_BASENAME), exists: false, open: null, holders: [],
      schemaVersion: null, legacy: false, phase: null, anomaly: null, error: msgOf(e),
      judgeUnavailable: false, reason: `静默窗读取抛错（${msgOf(e)}）→ 只作证据缺失`,
    };
  }

  /** @type {{owner:'upgrade'|'handoff'|null, code:string, because:string}[]} */
  const blocking = [];
  if (failure) {
    blocking.push({ owner: null, code: 'judge-unavailable', because: failure });
  } else {
    if (upgrade.judgeUnavailable) {
      blocking.push({ owner: 'upgrade', code: 'upgrade-judge-unavailable', because: upgrade.unavailableWhy });
    } else if (upgrade.holding && self !== 'upgrade') {
      blocking.push({
        owner: 'upgrade', code: `upgrade-${upgrade.state}`,
        because: `升级链占位（${upgrade.state}）· ${upgrade.summary}`
          + (upgrade.abandoned ? ` · ⚠️中断现场：${upgrade.abandonWhy}` : ''),
      });
      // 【卡「升级链健壮性1」】中断现场**如实登记**，但本函数的 verdict **逐字不变** ——
      //   「要不要据此放行」是各线的消费决策（唯一入口 = lane-gate.gateDecision 的开关），
      //   判据层只负责把事实说清楚（避免"两条线各写一份 if"）。
      if (upgrade.abandoned) {
        reasons.push(`⚠️ 升级锁判为**中断现场**（${upgrade.abandonWhy}）—— 该锁不作"升级进行中"凭据；`
          + '能否据此接管由各线消费口径决定（守护鱼侧开关：`guard.interruptTakeover`）');
      }
    }
    if (handoff.judgeUnavailable) {
      blocking.push({ owner: 'handoff', code: 'handoff-judge-unavailable', because: handoff.unavailableWhy });
    } else if (handoff.active && self !== 'handoff' && self !== 'upgrade') {
      blocking.push({ owner: 'handoff', code: 'handoff-window', because: `交接窗口活跃 · ${handoff.reason}` });
    }
  }

  const judgeUnavailable = failure !== null
    || upgrade?.judgeUnavailable === true
    || handoff?.judgeUnavailable === true;

  let verdict = 'clear';
  let owner = null;
  if (blocking.length === 0) {
    verdict = 'clear';
  } else if (judgeUnavailable) {
    // 硬口径：**判据不可用永远保守让路**（不给 blocked —— 保守方向是"不动"，不是"改走另一条动作"）
    verdict = 'yield';
    owner = blocking[0].owner;
    reasons.push('⚠️ 判据不可用 → 保守让路（宁可不动，不可赌；方案 §3.2 硬口径③）');
  } else {
    owner = blocking[0].owner;
    verdict = profile === 'refuse' ? 'blocked' : 'yield';
  }
  for (const b of blocking) reasons.push(`让路给 \`${b.owner ?? '?'}\`（${b.code}）：${b.because}`);

  // 静默窗只作证据（闸门不是写者 ⇒ 不产生让路）
  if (silence.open) {
    reasons.push(`静默窗开启：持有者 ${silence.holders.map((x) => `\`${x.id}\`${x.at ? `@${x.at}` : ''}`).join(' / ')}（闸门，不参与让路判定）`);
    if (upgrade && !upgrade.holding && !upgrade.judgeUnavailable) {
      reasons.push('⚠️ 静默窗有持有者但升级锁不在场（疑似残留 → ③-4 的 --ensure/超期告警对象；本判定不因此阻断）');
    }
  }
  if (silence.anomaly) reasons.push(`⚠️ 静默窗异常：${silence.anomaly}`);
  if (silence.error) reasons.push(`⚠️ 静默窗读不到（${silence.error}）→ 只作证据缺失`);
  if (verdict === 'clear') reasons.push('无更高优先写者在场 → 本线可动手（方案 §3.2：要动手仍须 `acquireLaneGuard()` 抢锁，只读探测不承担判定）');

  const summary = verdict === 'clear'
    ? `clear（self=${self}，无更高优先写者）`
    : `${verdict}（self=${self}，owner=${owner ?? '?'}${judgeUnavailable ? '，判据不可用' : ''}）`;

  return {
    at: new Date(now).toISOString(),
    self, profile, verdict, owner,
    reasons, judgeUnavailable,
    evidence: { home, upgrade, handoff, silence },
    summary,
  };
}

// ---------------------------------------------------------------- 抢锁式占位（唯一判定）

/**
 * 抢锁式占位（= 唯一判定）：抢到 → 临界区内不可能有第二写者；抢不到 → **拒动作，不排队**。
 *
 * ⚠️ 必须走**真实锁**：`env:{}` 一次屏蔽 `DSH_BUTLER_TICK_LOCK_HELD` 与 `DSH_HANDOFF_LOCK_HELD`
 *    两条虚拟锁继承通道（方案意见 T2 · 实证 E6），否则护栏形同虚设。
 * ⚠️ `holderId` **不改锁文件结构**（tick 锁 `{pid,startedAt,ttl,kind,name}` 是 store 的公共契约，
 *    其它读者按它解析；本模块不往里塞字段）——它只进返回值，供调用方写审计/呈现。
 * @param {{lockName?:string, holderId?:string, ttlMs?:number, waitMs?:number, home?:string}} [opts]
 * @returns {{ok:boolean, mode:'held'|'busy', reason:string, lockPath:string|null, lockName:string,
 *            holderId:string|null, inherit:boolean, waitedMs:number, holder:object|null, release:Function}}
 */
export function acquireLaneGuard(opts = {}) {
  const home = opts.home ?? dshHome();
  const lockName = String(opts.lockName ?? HANDOFF_TICK_LOCK);
  const ttlMs = Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : LANE_GUARD_TTL_MS;
  const waitMs = Number.isFinite(opts.waitMs) ? Number(opts.waitMs) : 0;
  const holderId = opts.holderId ?? null;
  const t0 = Date.now();
  let lock = null;
  let err = null;
  try {
    lock = acquireTickLock(lockName, { ttlMs, waitMs, home, env: {}, autoReleaseOnExit: true });
  } catch (e) { err = e; }
  const waitedMs = Date.now() - t0;

  if (err || !lock?.ok) {
    return {
      ok: false, mode: 'busy', lockName, holderId, inherit: false, waitedMs,
      reason: err
        ? `抢锁抛错（${msgOf(err)}）→ 拒动作（保守）`
        : `抢不到 \`tick-${lockName}.lock\`（${lock?.reason ?? 'unknown'}）→ 拒动作（不排队）`,
      lockPath: lock?.lockPath ?? null,
      holder: lock?.holder ?? null,
      release: () => false,
    };
  }
  return {
    ok: true, mode: 'held', lockName, holderId,
    inherit: lock.inherit === true,
    waitedMs,
    reason: `已持有 \`tick-${lockName}.lock\`（TTL ${Math.round(ttlMs / 1000)}s）→ 临界区内无第二写者`,
    lockPath: lock.lockPath,
    holder: null,
    release: () => { try { return lock.release() === true; } catch { return false; } },
  };
}

// ---------------------------------------------------------------- 呈现（日报段 / 摘要行）

const minutes = (ms) => {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
};
const iconOf = (verdict) => (verdict === 'clear' ? '✅' : (verdict === 'blocked' ? '🔴' : '⚠️'));

/**
 * 日报段行（**供 dsh-butler-panel/report.mjs 直接 push**；不含尾部空行，与 lib/upgrade-lock.mjs 同款）。
 * @param {object} lane judgeLane() 的返回值（或 null → 降级行）
 * @param {{now?:number}} [opts]
 * @returns {string[]}
 */
export function laneSectionLines(lane, opts = {}) {
  const L = [LANE_SECTION_TITLE, ''];
  if (!lane || typeof lane !== 'object') {
    L.push('- ❔ 跨线判定不可用（judgeLane 未返回结果）→ 保守让路：本线不许动手');
    return L;
  }
  L.push(`- ${iconOf(lane.verdict)} 判定：**${lane.verdict}**（self=\`${lane.self}\` · 本线让路档 \`${lane.profile}\`${lane.owner ? ` · **让路给 \`${lane.owner}\`**` : ''}${lane.judgeUnavailable ? ' · 🔴 **判据不可用（保守让路）**' : ''}）`);
  for (const r of lane.reasons ?? []) L.push(`  - ${r}`);

  const up = lane.evidence?.upgrade;
  if (up) {
    const upIcon = up.judgeUnavailable ? '🔴' : (up.holding ? '⏳' : (up.state === 'none' ? '✅' : '🟡'));
    L.push(`- ${upIcon} 升级链占位：**${up.state}**${up.holding ? '（占位中 → 全体让路）' : ''} · ${up.summary}`);
    if (up.heartbeatAgeMs !== null || up.ageMs !== null) {
      L.push(`  - 心跳 ${minutes(up.heartbeatAgeMs)}前 · 起于 ${minutes(up.ageMs)}前 · TTL ${minutes(up.ttlMs)}${up.judgeUnavailable ? ` · 判据不可用：${up.unavailableWhy}` : ''}`);
    } else if (up.judgeUnavailable) {
      L.push(`  - 判据不可用：${up.unavailableWhy}`);
    }
  } else {
    L.push('- ❔ 升级链占位：读不到（判据抛错）');
  }

  const ho = lane.evidence?.handoff;
  if (ho) {
    const hoIcon = ho.judgeUnavailable ? '🔴' : (ho.active ? '⏳' : (ho.stale ? '🟡' : '✅'));
    L.push(`- ${hoIcon} 交接窗口：${ho.active ? `**活跃**（${ho.reason}）` : (ho.stale ? `已过期（stale · ${ho.reason}）` : '无（不在交接窗口）')}${ho.judgeUnavailable ? ` · 判据不可用：${ho.unavailableWhy}` : ''}`);
    if (ho.holders?.length) {
      L.push(`  - 持有者：${ho.holders.map((x) => `pid=${x.pid ?? '?'} name=\`${x.name}\``).join(' / ')}${ho.expiresInMs !== null ? ` · 剩余 ${minutes(ho.expiresInMs)}` : ''}`);
    }
  } else {
    L.push('- ❔ 交接窗口：读不到（判据抛错）');
  }

  const si = lane.evidence?.silence;
  if (si) {
    const siIcon = si.open === null ? '❔' : (si.open ? '🧊' : '✅');
    const who = (si.holders ?? []).map((x) => `${x.stale ? '⚠️' : ''}\`${x.id}\`${x.at ? `@${x.at}` : ''}${x.reason ? `（${x.reason}）` : ''}`).join(' / ');
    L.push(`- ${siIcon} 静默窗（闸门，不参与让路判定）：${si.open === null ? `读不到（${si.error}）` : (si.open ? `开启 · ${si.holders.length} 个持有者${si.legacy ? '（v1 兼容读 → legacy）' : ''}` : '未开')}${who ? ` — ${who}` : ''}`);
    if (si.anomaly) L.push(`  - ⚠️ ${si.anomaly}`);
    // 「静默窗疑似残留」出口（卡 ③-4 第 7 条）：>4h 的持有者在日报里**显式成段**（判定只读派生自 holders）
    const stale = (si.holders ?? []).filter((x) => x.stale);
    if (stale.length) {
      L.push(`  - ⚠️ **静默窗疑似残留**：${stale.map((x) => `\`${x.id}\`（持有 ${minutes(x.ageMs)}）`).join(' / ')} 已超 4h`
        + ' → 处置：`node <workspace>\\tools\\dsh-upgrade-silence.mjs --check-stale` 发告警 / `--enable --holder <id>` 释放自己的持有；确认是误开窗才用 `--force-enable --reason "<原因>"`（审计 + 告警）');
    }
  } else {
    L.push('- ❔ 静默窗：读不到（判据抛错）');
  }

  L.push('- 判据源：`~/.dsh/upgrade-lock` · `butler-locks/tick-handoff.lock` · `upgrade-silence-state.json`（判定唯一实现在 `tools/dsh-butler/lib/cross-lane.mjs`，各线**只许调它**，不得各写一份 if）');
  L.push('- 口径：判据不可用 → **保守让路（宁可不动，不可赌）**；让路/冲突必须可见（审计由发起线写 + 本段）');
  return L;
}

/** 摘要行（供日报「## 摘要」段复用；本卡暂不接线，保留给后续卡的段序收口）。 */
export function summaryLine(lane) {
  if (!lane || typeof lane !== 'object') return '- 🔗 跨线契约：❔ 不可探测';
  return `- 🔗 跨线契约：${iconOf(lane.verdict)} **${lane.verdict}**${lane.owner ? `（让给 ${lane.owner}）` : ''}${lane.judgeUnavailable ? ' · 🔴 判据不可用' : ''}`;
}

export default {
  CROSS_LANE_VERSION,
  LANE_SECTION_TITLE,
  UPGRADE_SIX_STATES,
  UPGRADE_HOLDING_STATES,
  LANE_SELF_PROFILES,
  selfProfile,
  readUpgradeState,
  readHandoffWindow,
  readSilenceHolders,
  judgeLane,
  acquireLaneGuard,
  laneSectionLines,
  summaryLine,
};
