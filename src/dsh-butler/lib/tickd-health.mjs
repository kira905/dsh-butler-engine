// dsh-butler / lib/tickd-health.mjs —— tickd 调度健康（单一判定口径）
//
// 为什么存在（2026-09-11，看板卡「imagegen 冷备 · 对端可用 + 失败可见」）：
//   tickd 的 job 失败原先**只落在 %TEMP%\dsh-butler-tickd\state.json 里没人看**——
//   实测现场：对端 imagegen job 连续失败 3 次（冷备根写死 H:，本机无 H 盘），
//   直到有人手动跑 --status 才发现，图片/索引已白丢一天。
//   本模块把「哪些 job 该报警」收敛成一条口径，供**日报段**与**面板健康卡**共用，
//   避免两处各写一套判据（P2 裸跑期冻结，所以不碰 P2 事件族，只做只读展示）。
//
// 判据（卡里拍板的口径）：
//   `failures >= FAIL_WARN(2)` 且 `lastStatus !== 'ok'` → 报警
//     · failures >= FAIL_RED(5) → 🔴，否则 🟡
//   `lastStatus` 为 'locked' / 'busy' 时**不算失败**：这两种是"让路"语义（锁被别的入口持着 /
//     交接窗口内不发起重启），tickd 明确不把它们计入 failures；若已累计的 failures 让它们
//     误报，等于把"正常让路"报成故障，可见性会掉价（夹具里专门断言了这一条）。
//
//   【2026-09-16 · 卡 AT19】再加一个同类状态 `deferred`，来源 = tickd 的 `benignExitCodes` 声明
//     （当前仅 `hot`：热采 exit 3 = 抢不到交接锁 / 双开嫌疑 fail-closed / 推前安全门拦住整仓推送）。
//     这一类过去被当成"job 失败"→ 日报「⏱ tick 调度健康」段**常驻 🔴 假红**（实测 31 次全为此类，
//     审计流水 30 blocked + 1 deferred、零真失败）。现在：①不算失败、不涨 failures ；
//     ②**但连续 ≥ BENIGN_STREAK_WARN 次**时给 🟡（"让路"不等于"没事"，长期未完成要看得见）；
//     ③真失败（未声明的退出码 / spawn 异常 / exit 1）照旧计失败并报红——本口径**不是"永远绿"**，
//     反向锚见 `_test/test-tickd-benign-exit.mjs`。
//   tickd 常驻未运行（心跳过期/锁丢失）→ 整体 🔴（所有 tick 停摆，比单个 job 失败更严重）。
//   读不到 state.json（从未跑过 / 路径不同）→ ❔ 不可探测，不虚报。
//
// 【M4 · 2026-09-27 · 卡 2d95848f】**`session-mirror` 这个 job 不再读 `tickd state` 的良性计数**。
//   病根（实测口径）：该 job 走 `lockRunner` 包装层 —— `lib\tick-job-runner.mjs` L212 起 `exitCode = RUNNER_EXIT.OK`、
//   L218 `await import()` 不抛即恒 OK、L267 `process.exitCode = await main()` 把子脚本自己设的 `process.exitCode = 3`
//   **覆盖掉** ⇒ tickd 侧 `benignExits` 恒 null / `consecutiveBenign` 恒 0 / `lastStatus` 恒 ok。
//   ⇒ 2026-09-23 实测：镜像脚本 `lastResult=unreachable`（停摆 13.6 h），而日报全绿、`consecutiveBenign=0`
//      —— **镜像停摆看不见**；且下面 `BENIGN_STATUSES` 那条分支对它是死路（`lastStatus='ok'` 会先返回 green）。
//   ⇒ 本模块对该 job **改读脚本自写的状态文件** `~\.dsh\butler-session-mirror.json`：
//      `lastResult` + `consecutiveUnreachable`（连续不可达轮数）。
//   · **单一口径**：默认路径与 env 覆盖（`DSH_SESSION_MIRROR_STATE`）与写方 `tools\dsh-session-mirror.mjs` **同源**
//     （一边读 tickd state、一边读 json = 口径漂移的种子，方案 §13-Z1 尾注禁止）。
//   · 阈值 **N = 3**（连续 ≥3 轮不可达 ⇒ 🟡）与 M5 的告警判据**同一份载体、同一个 N**（方案 §5 阶段 0b · M5 行）。
//   · ⚠️ **失真登记（§5.5 [N5]）**：`~\.dsh\butler-tickd\state.json` 的 `session-mirror` 行健康语义**已知失真**，
//     **禁止**再作健康判据（日报 / 面板真值一律取 `butler-session-mirror.json`）。本模块对该 job 的
//     `benignExits` / `consecutiveBenign` 字段**不再消费**（字段仍随 job 列表带出，只作诊断）。
//   · **真失败优先级不变**：`failures >= FAIL_WARN_THRESHOLD` 仍先报红黄（不因换判据源而把真失败藏起来）。
//   · 判据不可读（json 缺失 / 损坏）⇒ 该 job 判 `info`「判据源不可读」且**不进 failing**（不虚报、**不回落** tickd state）。
//
// 只读：不写任何文件、不改 tickd 状态、不触发 job。
//
// 【2026-09-13 补 · 卡 4a12fc8c】再加一类可见事件：**running 残留**
//   tickd 的 `jobs.<id>.running` 只在本进程收到子进程 exit 时清零 → tickd 被杀 / exit 事件丢失
//   都会让它残留，job 被永久跳过且 `failures` 仍为 0（实测 barewatch 停摆 15h+、restart 2h+，日报全绿）。
//   本模块只做**只读展示**：① 仍挂着且超阈值 → 🟡「疑似残留未清」② 已被 tickd 自动复位 →
//   ⚪ 记一行（附次数与最近时间，24h 窗口）。阈值复用 tickd 的 staleRunningThresholdMs()，
//   不在日报里复制第二套数字、也不参与 P2 判定口径。复位过属"已自愈"⇒ 级别用 info，不改整体级别。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStatePath } from './state-paths.mjs';

// 调度表与 pid 存活判定**不在这里复制**：直接复用 tickd 自己的导出（单一数据源）。
// 【卡 拷问 1.5（2026-09-16）】再复用它的 `calendarLag()` —— 「该跑没跑」的日期口径只有一份实现。
// 【卡「冷盘窗」（2026-09-20）】`every` 展示改用 `describeSchedule()` —— 加了 days / window 之后，
//   只打 `at` 或只打 `60m` 会藏掉"什么时候真会跑"（`60m · 窗 08:30-18:00` 与 `60m` 是两回事）。
import { JOBS, isPidAlive, isStaleRunning, staleRunningThresholdMs, calendarLag, describeSchedule } from '../butler-tickd.mjs';

export const TICKD_HEALTH_VERSION = '0.2.0';

/** 心跳新鲜度门槛（与 butler-tickd.mjs 的 isRunning 同口径）。 */
export const STALE_MS = 180_000;

/** 报警门槛：累计失败 >= 2 且最近一次不是 ok。 */
export const FAIL_WARN_THRESHOLD = 2;
/** 升级为 🔴 的累计失败数。 */
export const FAIL_RED_THRESHOLD = 5;
/** "让路"状态：不算失败（见文件头注释）。 */
// 【卡 AT19（2026-09-16）】追加 `deferred` —— 该状态由 tickd 的 `benignExitCodes` 声明产生
//   （当前仅 `hot`：热采 exit 3 = 抢不到交接锁 / 双开嫌疑 fail-closed / 推前安全门拦住整仓推送），
//   与 locked/busy **同类语义**（"这一轮没干成，但不是它坏了"），故一并排除出失败计分。
//   未声明 `benignExitCodes` 的 job 永远不会产出该状态（它们的非 0 码仍是 `exit-<n>`，照旧报红）。
// 【B7（2026-11-09）】追加 `skipped-missing-src` —— tickd 三级解析（jobs/ → BUTLER_JOBS_DIR →
//   job.dir）找不到作业脚本时的状态。开源包默认**不附带**大部分作业脚本，这是"没装这件东西"
//   而不是"这东西坏了" ⇒ 与 locked/busy **同类**：不涨 failures、不计入失败。真坏了仍是
//   `exit-<n>` / `spawn-error`（照旧报红）。
export const BENIGN_STATUSES = ['locked', 'busy', 'deferred', 'skipped-missing-src'];

/** 连续让路达到该次数 → 从 ✅ 升为 🟡（"一直没完成"要看得见，但仍不计失败、不进红档）。 */
export const BENIGN_STREAK_WARN = 3;

// ---- 【M4】镜像 job 的判据面（**真源 = 脚本自写的状态文件**，见文件头 M4 段）
/** 镜像 job id（写死一处，避免多处字符串漂移导致判据静默失配）。 */
export const SESSION_MIRROR_JOB_ID = 'session-mirror';
/** 连续 `unreachable` 达到该次数 ⇒ 🟡。**N = 3**，与 M5 的告警判据同源同值（方案 §5 阶段 0b · M5 行）。 */
export const MIRROR_UNREACHABLE_STREAK_WARN = 3;

// 【卡 拷问 1.5（2026-09-16）】「该跑没跑」判据：日历型 job 落后 ≥ WARN 天 → 🟡，≥ RED 天 → 🔴。
//   为什么单列一条：`failures` 只反映"跑过但失败了"，**停机窗口 / tickd 停摆期完全不产生失败**
//   ⇒ 现场 `rollback-offsite` 两天没跑、`lastStatus=ok`、`failures=0`，日报照写「✅ 最近一次打包成功」。
//   判定实现复用 tickd 的 `calendarLag()`（本地日期口径唯一真源）；被开关关掉的 job 由调用方排除。
export const CALENDAR_LAG_WARN_DAYS = 1;
export const CALENDAR_LAG_RED_DAYS = 2;
/** 等待子进程结束后的宽限：running=true 的 job 不算失败。 */
export const LEVEL_ICON = { green: '✅', yellow: '⚠️', red: '🔴', unknown: '❔', info: '⚪' };

/** 残留复位的展示窗口：最近 24h 内复位过就值得在日报里留一行（更早的视作历史，不再占版面）。 */
export const STALE_RESET_WINDOW_MS = 24 * 3600_000;

/** tickd 状态目录（与 tickd 同一口径；DSH_TICKD_DIR 可注入——夹具靠它，永不碰生产状态）。 */
export function tickdStateDir(opts = {}) {
  return opts.dir ?? process.env.DSH_TICKD_DIR
    ?? path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-tickd');
}

/** 读 tickd 状态文件（只读）。 */
export function readTickdState(opts = {}) {
  const dir = tickdStateDir(opts);
  const file = path.join(dir, 'state.json');
  try {
    return { ok: true, dir, file, state: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, dir, file, error: String(e?.message ?? e), state: null };
  }
}

/** 读 tickd 单例锁（只读）。 */
export function readTickdLock(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'lock'), 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------- 【M4】镜像健康判据面（只读）
/**
 * 镜像状态文件路径（**与写方 `tools\dsh-session-mirror.mjs` 同源**）。
 * 优先级：`opts.mirrorFile`（夹具注入）> `opts.mirrorHome`（夹具家目录）> env `DSH_SESSION_MIRROR_STATE`
 *        > 默认 `%USERPROFILE%\.dsh\butler-session-mirror.json`。
 * ⚠️ 别改成 `DSH_HOME`：写方只看 `USERPROFILE`（方案 §15.5 [N2] 点名的坑）——
 *    两边必须逐字同源，否则会出现"脚本写 A、判据读 B"的口径漂移（§13-Z1 尾注禁止）。
 */
export function sessionMirrorStateFile(opts = {}) {
  if (opts.mirrorFile) return opts.mirrorFile;
  if (opts.mirrorHome) return resolveStatePath('butler-session-mirror.json', { home: path.join(opts.mirrorHome, '.dsh') }).path;
  if (process.env.DSH_SESSION_MIRROR_STATE) return process.env.DSH_SESSION_MIRROR_STATE;
  return resolveStatePath('butler-session-mirror.json', { home: path.join(process.env.USERPROFILE || os.homedir(), '.dsh') }).path;
}

/** 读镜像状态文件（只读；**失败不抛**，返回 `{ok:false, error}` ⇒ 调用方判「判据源不可读」）。 */
export function readSessionMirrorState(opts = {}) {
  const file = sessionMirrorStateFile(opts);
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { ok: false, file, state: null, error: `状态文件内容不是对象（${Array.isArray(state) ? '数组' : typeof state}）` };
    }
    return { ok: true, file, state, error: null };
  } catch (e) {
    return { ok: false, file, state: null, error: String(e?.message ?? e) };
  }
}

/**
 * 常驻调度器是否在跑（只读探活）。
 * 口径与 butler-tickd.mjs 的 isRunning() 完全一致（pid 存活 + 心跳新鲜 ≤ STALE_MS），
 * 差别只在**目录可注入**：tickd 的 isRunning 用模块加载时固化的 STATE_DIR（DSH_TICKD_DIR），
 * 夹具/多实例场景下必须能指向别处，否则会读到另一个目录的锁给出假结论。
 */
export function probeTickdRunning(opts = {}) {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? STALE_MS;
  const dir = opts.dir ?? tickdStateDir();
  const lock = readTickdLock(dir);
  if (!lock || !isPidAlive(lock.pid)) return { ok: false, reason: lock ? 'stale-pid' : 'no-lock', lock, dir };
  const st = opts.state ?? readTickdState({ dir }).state;
  const beat = st?.lastLoopAt ? Date.parse(st.lastLoopAt) : Date.parse(lock.startedAt ?? '');
  if (Number.isFinite(beat) && now - beat > staleMs) return { ok: false, reason: 'stale-heartbeat', lock, beat, dir };
  return { ok: true, reason: 'alive', lock, beat, dir };
}

/** 单个 job 的健康判定（纯函数）。
 *  @param {object} job JOBS 条目
 *  @param {object} jobState `state.jobs[<id>]`
 *  @param {number} [now]
 *  @param {{blocked?:boolean, mirror?:object}} [opts]
 *    · `blocked:true` = 该 job 被开关显式关掉 ⇒ **不判**「该跑没跑」
 *    · `mirror` = 【M4】`readSessionMirrorState()` 的结果，**只对 `session-mirror` 生效**
 *      （该 job 的判据源已换成状态文件；缺省 ⇒ 该 job 判「判据源不可读」，不回落 tickd state） */
export function judgeJob(job, jobState, now = Date.now(), opts = {}) {
  const s = jobState ?? null;
  const failures = Number(s?.failures ?? 0);
  const lastStatus = s?.lastStatus ?? null;
  // 【卡 拷问 1.5】「该跑没跑」：被开关关掉的 job 除外（故意不跑 ≠ 该跑没跑）
  const lag = opts.blocked === true ? null : calendarLag(job, s, now);
  const base = {
    id: job.id, label: job.label, every: describeSchedule(job),
    runs: Number(s?.runs ?? 0), failures, lastStatus, lastError: s?.lastError ?? null,
    lastEndAt: s?.lastEndAt ?? null, running: s?.running === true,
    // 【卡 4a12fc8c】残留证据：当前标记起始时间 / 复位次数 / 最近复位时间
    lastStartAt: s?.lastStartAt ?? null,
    staleRunningResets: Number(s?.staleRunningResets ?? 0),
    staleRunningResetAt: s?.staleRunningResetAt ?? null,
    // 【卡 AT19】让路计数（只有声明了 benignExitCodes 的 job 才会写这两项）
    //   ⚠️【M4】对 `session-mirror` 这两项**已知失真、不再消费**（lockRunner 包装层恒返 OK ⇒ 恒 0/null；
    //      见文件头 M4 段）。它们仍然带出来，仅为诊断展示，**不得**再作该 job 的健康判据。
    benignExits: Number(s?.benignExits ?? 0),
    consecutiveBenign: Number(s?.consecutiveBenign ?? 0),
    lastBenignAt: s?.lastBenignAt ?? null,
    // 【M4】镜像判据面信息（仅 session-mirror 会被填；见 judgeMirrorJob）
    mirror: null,
    // 【卡 拷问 1.5】日历滞后（null = 不落后 / 非日历 job / 被开关关掉）
    lag, blocked: opts.blocked === true,
  };
  if (!s || lastStatus === null) {
    // 【M4】镜像 job 例外：它的判据源**不在 tickd state**（在 butler-session-mirror.json）
    //   ⇒ tickd 还没记过它，也不能因此把镜像判据跳过（否则"new job 没跑过"= 判据面静默失效）。
    if (job.id === SESSION_MIRROR_JOB_ID) return judgeMirrorJob(job, base, opts.mirror, s, now);
    return { ...base, level: 'info', reason: '暂无运行记录' };
  }
  if (base.running) {
    // 「正在运行」也可能是**残留标记**：tickd 每轮都会复位超阈值的残留，所以这里还看得到老化标记
    // = 清理没生效（tickd 自身停摆 / 复位后又被写脏）→ 报出来，别装作在跑。
    if (isStaleRunning(job, s, now)) {
      const sinceMs = Date.parse(String(s.lastStartAt ?? s.lastRunAt ?? ''));
      const mins = Number.isFinite(sinceMs) ? Math.round((now - sinceMs) / 60000) : null;
      return {
        ...base, level: 'yellow',
        reason: `running 标记${mins === null ? '' : `已挂 ${mins} 分钟`}未收尾（疑似残留 · 阈值 ${Math.round(staleRunningThresholdMs(job) / 60000)} 分钟）`,
      };
    }
    return { ...base, level: 'green', reason: '正在运行' };
  }
  // ★【卡 拷问 1.5】「该跑没跑」必须排在 `ok → green` **之前**：现场形态就是"lastStatus=ok 但两天没跑"。
  if (lag) {
    return {
      ...base,
      level: lag.lagDays >= CALENDAR_LAG_RED_DAYS ? 'red' : 'yellow',
      reason: `**该跑没跑**：${lag.reason}（日历型 job 落后；lastStatus=${lastStatus} 不代表跑过）`,
    };
  }
  // ★【M4】镜像 job：判据源 = 脚本自写的状态文件 —— **必须排在 `lastStatus === 'ok'` 之前**：
  //   tickd state 的 `session-mirror.lastStatus` 恒 'ok'（包装层恒返 OK）⇒ 先判 ok 就永远 green，
  //   而"镜像停摆看不见"正是本卡要治的病（2026-09-23 现场：停摆 13.6 h、日报全绿）。
  if (job.id === SESSION_MIRROR_JOB_ID) return judgeMirrorJob(job, base, opts.mirror, s, now);
  if (lastStatus === 'ok') return { ...base, level: 'green', reason: 'ok' };
  if (BENIGN_STATUSES.includes(lastStatus)) {
    // 【卡 AT19】连续让路 ≥ BENIGN_STREAK_WARN 次 → 🟡：让路**不是失败**（不涨 failures、不进红档），
    //   但"连续 N 次都没干成"说明有件事一直没人处置（实测：hot 连续 31 次被推前安全门拦住 =
    //   远端分叉待收口）——完全静默等于把该处置的事藏起来。
    if (base.consecutiveBenign >= BENIGN_STREAK_WARN) {
      const err = String(s?.lastError ?? '').split('\n')[0].slice(0, 80);
      return {
        ...base, level: 'yellow',
        reason: `连续 ${base.consecutiveBenign} 次让路/未完成（${lastStatus}，不计失败）—— 非故障，但该事项一直未完成${err ? `（${err}）` : ''}`,
      };
    }
    return { ...base, level: 'green', reason: `让路状态 ${lastStatus}（不计失败）` };
  }
  if (failures >= FAIL_WARN_THRESHOLD) {
    return {
      ...base,
      level: failures >= FAIL_RED_THRESHOLD ? 'red' : 'yellow',
      reason: `连续/累计失败 ${failures} 次，最近 ${lastStatus}`,
    };
  }
  // 只失败过 1 次（未达门槛）：记录但不报警，避免噪声
  return { ...base, level: 'info', reason: `失败 ${failures} 次（未达门槛 ${FAIL_WARN_THRESHOLD}），最近 ${lastStatus}` };
}

// ---------------------------------------------------------------- 【M4】镜像 job 判据（判据面真源 = 状态文件）
/**
 * 【M4】镜像 job 的健康判定（纯函数）—— 判据源 = `~\.dsh\butler-session-mirror.json`（**不读 tickd state 的良性计数**）。
 *
 * 判定顺序（写死；改顺序 = 改口径）：
 *   ① 真失败（tickd 记账 `failures ≥ 门槛`）→ 🔴/🟡 —— 优先级最高，换判据源**不许藏真失败**
 *   ② 判据源不可读 → ℹ️「判据源不可读」（**不虚报、不回落** tickd state）
 *   ③ `lastResult === 'unreachable'` 且 `consecutiveUnreachable ≥ N(=3)` → 🟡 + 四段式文案
 *   ④ `lastResult === 'unreachable'` 未达阈值 → ✅（让路不是故障，但计数写进 reason）
 *   ⑤ 其它有结果（ok / partial / verify-failed …）→ ✅「对端可达」
 *   ⑥ 无 `lastResult` → ℹ️（脚本尚未跑过）
 * @param {object} job JOBS 条目
 * @param {object} base judgeJob 已算好的公共字段
 * @param {{ok?:boolean, file?:string, state?:object, error?:string}} [mirror] `readSessionMirrorState()` 的结果
 * @param {object} [s] tickd 的 jobState（仅用于兜底展示 lastError）
 */
export function judgeMirrorJob(job, base, mirror, s = null, now = Date.now()) {
  const st = mirror?.state ?? null;
  const lastResult = st?.lastResult ?? null;
  const raw = Number(st?.consecutiveUnreachable);
  const streak = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const info = {
    source: 'butler-session-mirror.json',
    file: mirror?.file ?? null,
    readable: mirror?.ok === true,
    readError: mirror?.ok === true ? null : (mirror?.error ?? '未提供判据源（opts.mirror 缺失）'),
    lastResult,
    consecutiveUnreachable: streak,
    lastRunAt: st?.lastRunAt ?? null,
    lastUnreachableAt: st?.lastUnreachableAt ?? null,
    // 【卡「冲刺600·P4」2026-10-09】该 job 是否被开关关停：关停时轮数会**冻结**（不再有新判据），
    //   告警文案必须说清这一点，否则读者会把"job 早被关掉"误读成"对端刚掉线"（现场误判主因）。
    blocked: base.blocked === true,
  };
  const out = { ...base, mirror: info };
  const err = String(s?.lastError ?? '').split('\n')[0].slice(0, 80);

  // ① 真失败优先
  if (base.failures >= FAIL_WARN_THRESHOLD) {
    return {
      ...out, level: base.failures >= FAIL_RED_THRESHOLD ? 'red' : 'yellow',
      reason: `镜像任务自身连续/累计失败 ${base.failures} 次（tickd 记账，最近 ${base.lastStatus}）${err ? `（${err}）` : ''}`,
    };
  }
  // ② 判据源不可读
  if (mirror?.ok !== true) {
    return {
      ...out, level: 'info',
      reason: `镜像判据源**不可读**（${info.readError}）· ${info.file} —— 健康不可判（**不回落**到已知失真的 tickd state）`,
    };
  }
  // ③ 连续不可达 ≥ N ⇒ 🟡（文案四段模板，与 M5 同源）
  if (lastResult === 'unreachable' && streak >= MIRROR_UNREACHABLE_STREAK_WARN) {
    return { ...out, level: 'yellow', reason: mirrorAlarmText(info, { now }) };
  }
  // ④ 不可达未达阈值
  if (lastResult === 'unreachable') {
    return {
      ...out, level: 'green',
      reason: `镜像对端连续 ${streak} 轮不可达（未达告警阈值 ${MIRROR_UNREACHABLE_STREAK_WARN}）—— 不计失败；判据 ${info.source}`,
    };
  }
  // ⑤ 有结果且非 unreachable ⇒ 对端可达
  if (lastResult) return { ...out, level: 'green', reason: `镜像最近一轮 ${lastResult}（对端可达 · ${info.source}）` };
  // ⑥ 判据面无结果
  return { ...out, level: 'info', reason: `镜像判据面无 lastResult（脚本尚未跑过）· ${info.file}` };
}

/**
 * 【卡「冲刺600·P4 备份链恢复」2026-10-09 · 时间口径修复】把「时长（毫秒）」渲染成自适应单位。
 *
 * 为什么必须有这个函数：**时长与轮数是两个量纲**，绝不能互相换算（见 mirrorAlarmText 的订正注）。
 * 单位切换点写死：< 90 分钟 → 分钟；< 48 小时 → 小时（一位小数）；否则 → 天（一位小数，括注小时）。
 * 无效输入（NaN / Infinity / null）→ `null`（调用方必须走显式兜底文案，**不许猜一个数**）。
 * @param {number} ms
 * @returns {string|null}
 */
export function formatSpanText(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return null;
  const mins = v / 60_000;
  if (mins < 90) return `${Math.round(mins)} 分钟`;
  const hours = v / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)} 小时`;
  const days = hours / 24;
  return `${days.toFixed(1)} 天（${Math.round(hours)} 小时）`;
}

/**
 * 【M4 / M5 共用】**镜像停摆告警文案（四段模板 · 方案 §5 阶段 0b 的 [C-3]）**：
 * 现象 / 影响 / 建议动作 / 依据。
 * M5 的日报段与面板红标**复用本函数**（不复制文案 —— 复制 = 下次口径漂移的种子）。
 *
 * ⚠️ **【订正注 · 2026-10-09 · 卡「冲刺600·P4 备份链恢复」】影响段的"停摆时长"口径已换掉**
 *   （旧实现见回滚点 `docs/`）：
 *   · **旧口径（错）**：`job 每 60 分钟一轮 ⇒ 至少已停摆约 ${n} 小时`（n = `consecutiveUnreachable` **轮数**）
 *     —— 把**轮数**直接当**时长**，隐含假设「job 一直按点跑、每轮恰好 60 分钟」。该假设一旦被打破
 *     （job 被开关关停 / tickd 停摆 / 机器关机 ⇒ 轮数**冻结**而墙上时间照走），误差就没有上界。
 *   · **现场实据（2026-10-09 16:0x 一手读数）**：生产 `butler-session-mirror.json` =
 *     `consecutiveUnreachable=3` + `lastUnreachableAt=2026-09-28T02:06:16Z`（job 于 09-28 10:19 被主人令关停
 *     ⇒ 轮数冻结在 3）⇒ 旧文案报「至少已停摆约 **3 小时**」，而真实跨度 = **270.0 小时 ≈ 11.25 天**
 *     ⇒ **量级错 90 倍**（卡片记录的"11 天报成 3 小时"）。
 *   · **新口径（本函数）**：时长一律 = `now − (lastUnreachableAt ?? lastRunAt)` 的**真实时间跨度**，
 *     经 `formatSpanText()` 自适应单位渲染；轮数**只作为判据计数**出现在现象段与依据段，不再换算成时长。
 *     `opts.now` 可注入（单测用；缺省 = 真实时间）。起点取不到（字段缺失/非法）⇒ 显式说"时长不可判"。
 *   · 另：`info.blocked === true`（该 job 当前被开关关停）时**额外注明轮数已冻结**——现场误读的主因
 *     是读者以为"对端掉线了"，而真相往往是"这个 job 早就被关掉了"。**判据级别不变**（仍是 🟡，不静默）。
 * @param {{consecutiveUnreachable?:number, file?:string, lastUnreachableAt?:string|null, lastRunAt?:string|null, blocked?:boolean}} info
 * @param {{now?:number}} [opts]
 */
export function mirrorAlarmText(info, opts = {}) {
  const n = Number(info?.consecutiveUnreachable ?? 0);
  const now = Number(opts?.now ?? Date.now());
  // ⚠️ 时间口径：**必须走 `fmtLocalTime()`**（卡 0 · B6③ 定的"段内时间口径 = 本地时区"）——
  //   直接吐 ISO 原文会让人把 UTC 当本地（差 8 小时），排障时误判"这轮是凌晨跑的"。
  const at = info?.lastUnreachableAt ? `（末次 ${fmtLocalTime(info.lastUnreachableAt)}）` : '';
  // 停摆起点：优先"末次不可达时刻"；退化到"末次运行时刻"（老状态文件可能只有后者）。
  const startIso = info?.lastUnreachableAt ?? info?.lastRunAt ?? null;
  const startMs = startIso ? Date.parse(String(startIso)) : NaN;
  const span = Number.isFinite(startMs) && Number.isFinite(now) ? formatSpanText(now - startMs) : null;
  const frozen = info?.blocked === true ? '；⚠️ 该 job 现被开关关停 ⇒ 轮数已冻结，**时长以时间跨度为准**（不是轮数×1 小时）' : '';
  const impact = span
    ? `｜影响：会话与附件**没有异地副本**（自末次判据起已 **${span}**${frozen}）`
    : '｜影响：会话与附件**没有异地副本**（判据缺末次不可达/运行时刻 ⇒ **停摆时长不可判**；'
      + `仅知连续 ${n} 轮不可达 —— 轮数 ≠ 时长，别据此推算）`;
  return `镜像停摆：对端连续 ${n} 轮不可达${at}`
    + impact
    + '｜建议动作：确认 <peer> 是否在线（`ssh <user>@<peer-b> echo ok`；对端重启 / 主人外出属常态）'
    + '—— 恢复后计数**自动归零**，无需手工清'
    + `｜依据：${info?.file ?? '会话镜像状态文件'}#consecutiveUnreachable=${n}`;
}

/**
 * 汇总健康（纯函数，夹具可注入 jobs/state/running）。
 * @param {{state?:object, jobs?:Array, running?:{ok?:boolean,reason?:string,lock?:object,beat?:number}, read?:object, now?:number}} [opts]
 */
export function judgeTickdHealth(opts = {}) {
  const jobs = opts.jobs ?? JOBS;
  const read = opts.read ?? readTickdState(opts);
  const now = opts.now ?? Date.now();
  // 【M4】镜像判据面：**只读一次**、逐 job 复用（真源 = butler-session-mirror.json）。
  //   jobs 里没有 session-mirror（夹具）⇒ 根本不读，避免夹具误碰生产状态文件。
  const mirror = opts.mirror !== undefined ? opts.mirror
    : (jobs.some((j) => j.id === SESSION_MIRROR_JOB_ID) ? readSessionMirrorState(opts) : null);
  const st = opts.state ?? read.state ?? {};
  const running = opts.running ?? (opts.state !== undefined
    ? { ok: true, reason: 'injected' }                       // 夹具注入 state：不受本机 tickd 影响
    : (() => {
      try { return probeTickdRunning({ dir: read.dir, state: st, now }); } catch (e) { return { ok: false, reason: `probe-error:${e?.message ?? e}` }; }
    })());

  if (!read.ok && !opts.state) {
    return {
      ok: false, level: 'unknown', reason: `读不到 tickd 状态（${read.error}）`,
      stateDir: read.dir, stateFile: read.file, running: { ok: false, reason: running.reason },
      jobs: [], failing: [], healthyCount: 0, unknownCount: 0, idleCount: 0,
    };
  }
  const states = st.jobs ?? {};
  // 【卡 拷问 1.5】被开关显式关掉的 job（tickd 每轮写 `blockedJobs`）→ **不判**「该跑没跑」。
  //   缺该字段（旧 state / 夹具）时不假定"未被关"：滞后判据照常生效（宁可多报，也不静默）。
  const blockedJobs = Array.isArray(st.blockedJobs) ? st.blockedJobs : null;
  const list = jobs.map((j) => judgeJob(j, states[j.id], now, { blocked: blockedJobs ? blockedJobs.includes(j.id) : false, mirror }));
  const failing = list.filter((x) => x.level === 'red' || x.level === 'yellow');
  // 【卡 拷问 1.5】日历滞后清单（含在 failing 里，这里单列供日报/面板直说"该跑没跑"）
  const lagging = list.filter((x) => x.lag);
  // 【卡 拷问 1.5】tickd 冷启动写的停摆台账（最近一条 = 上次停摆窗口）
  const stallWindows = Array.isArray(st.stallWindows) ? st.stallWindows : [];
  const lastStall = stallWindows.length ? stallWindows[stallWindows.length - 1] : null;
  const unknown = list.filter((x) => x.level === 'info' && !x.runs);
  const healthy = list.filter((x) => x.level === 'green');
  // 【卡 4a12fc8c】近 24h 内被 tickd 自动复位过 running 残留的 job（只读展示，不改整体级别）
  const staleResets = list
    .filter((x) => x.staleRunningResets > 0
      && Number.isFinite(Date.parse(String(x.staleRunningResetAt ?? '')))
      && now - Date.parse(String(x.staleRunningResetAt)) <= STALE_RESET_WINDOW_MS)
    .map((x) => ({ id: x.id, label: x.label, resets: x.staleRunningResets, at: x.staleRunningResetAt, lastSince: x.lastStartAt }));

  // 整体级别：调度器没在跑 = 🔴（比单 job 失败更严重）；否则取最严重 job
  let level = 'green';
  if (!running.ok) level = 'red';
  else if (failing.some((x) => x.level === 'red')) level = 'red';
  else if (failing.length) level = 'yellow';

  return {
    ok: true, level,
    reason: !running.ok ? `tickd 常驻未运行（${running.reason}）`
      : failing.length ? `${failing.length} 个 job 需要关注`
        : '全部正常',
    stateDir: read.dir, stateFile: read.file,
    running: { ok: running.ok === true, reason: running.reason ?? null, pid: running.lock?.pid ?? null },
    tickdVersion: st.version ?? null,
    startedAt: st.startedAt ?? null,
    lastLoopAt: st.lastLoopAt ?? null,
    loopCount: st.loopCount ?? 0,
    jobCount: list.length,
    healthyCount: healthy.length,
    unknownCount: unknown.length,
    jobs: list,
    failing,
    lagging,
    blockedJobs,
    lastStall,
    stallWindowCount: stallWindows.length,
    staleResets,
    // 【M4】镜像停摆判据面汇总（**M5 的日报段 / 面板红标直接消费本字段**，不重算、不复制判据）
    sessionMirror: (() => {
      const mj = list.find((x) => x.id === SESSION_MIRROR_JOB_ID) ?? null;
      if (!mj) return null;
      return { id: mj.id, label: mj.label, level: mj.level, reason: mj.reason, ...(mj.mirror ?? {}) };
    })(),
    checks: [
      { id: 'tickd-running', level: running.ok ? 'green' : 'red', label: 'tickd 常驻进程', value: running.ok ? '运行中' : `未运行（${running.reason}）` },
      { id: 'tickd-failing-jobs', level: failing.length ? (failing.some((x) => x.level === 'red') ? 'red' : 'yellow') : 'green', label: '失败 job', value: failing.length ? failing.map((x) => `${x.id}(${x.lastStatus}, ${x.failures} 次)`).join('、') : '无' },
      { id: 'tickd-calendar-lag', level: lagging.length ? (lagging.some((x) => x.level === 'red') ? 'red' : 'yellow') : 'green', label: '该跑没跑（日历型 job）', value: lagging.length ? lagging.map((x) => `${x.id}(落后 ${x.lag.lagDays} 天)`).join('、') : '无' },
      { id: 'tickd-idle-jobs', level: 'info', label: '未运行过', value: unknown.length ? unknown.map((x) => x.id).join('、') : '无' },
      { id: 'tickd-stale-running', level: 'info', label: 'running 残留复位', value: staleResets.length ? staleResets.map((x) => `${x.id}(${x.resets} 次)`).join('、') : '无（近 24h）' },
    ],
  };
}

/** 一行摘要（面板 / CLI / 日志用）。 */
export function healthLine(h) {
  const icon = LEVEL_ICON[h.level] ?? '⚪';
  if (!h.ok) return `${icon} tickd 调度健康：不可探测（${h.reason}）`;
  const bits = [];
  if (!h.running.ok) bits.push(`常驻未运行（${h.running.reason}）`);
  if (h.failing.length) bits.push(`失败 ${h.failing.length} 个：${h.failing.map((x) => `${x.id}=${x.lastStatus}`).join('、')}`);
  // 【卡 拷问 1.5】滞后单独说一句（lastStatus 可能是 ok，被失败那句话掩盖）
  if (h.lagging?.length) bits.push(`该跑没跑 ${h.lagging.map((x) => `${x.id}(落后 ${x.lag.lagDays} 天)`).join('、')}`);
  if (h.unknownCount) bits.push(`未运行过 ${h.unknownCount} 个`);
  if (h.staleResets?.length) bits.push(`running 残留已复位 ${h.staleResets.map((x) => x.id).join('、')}`);
  return `${icon} tickd 调度健康：${h.reason}${bits.length ? `（${bits.join(' · ')}）` : ''} · 心跳 ${fmtLocalTime(h.lastLoopAt)}`;
}

/**
 * 【卡 0 · B6③（2026-09-14）】tickd 状态文件里的时间戳是 **UTC ISO**（tickd 用 toISOString() 写），
 * 直接打印会让人看到"末次 2026-09-14T03:47:45.901Z"——和本地墙上时钟差 8 小时，
 * 排障时极易误判成"这条 tick 是凌晨跑的"（实测：本地 11:47 跑的 daily job，状态里是 03:47Z）。
 *
 * 这里只做**只读展示侧**修正：解析 UTC → 按本地时区渲染。**不改状态文件的存法**
 * （改存法要同时动 tickd 与所有读取方，风险大；若将来要改，走独立卡 + 主人拍板）。
 * 解析失败 → 原样返回字符串（不吞掉原始证据）。
 * @param {string|number|null} iso
 */
export function fmtLocalTime(iso) {
  if (iso === null || iso === undefined || iso === '') return '—';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return String(iso);
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 本地`;
}

/**
 * 【M5】会话异地镜像的**日报常驻行**（单行摘要；四段式全文仍由 `failing` 循环输出）。
 *
 * 判定**不在这里重做**：入参 = `judgeTickdHealth().sessionMirror`（= M4 已算好的 `judgeMirrorJob()` 结果），
 * 本函数只把它渲染成一行 markdown（与面板「⏱ tickd 调度」卡消费同一份字段，口径不漂移）。
 * @param {object} m `h.sessionMirror`
 */
export function sessionMirrorDailyLine(m) {
  const id = m?.id ?? SESSION_MIRROR_JOB_ID;
  const n = Number(m?.consecutiveUnreachable ?? 0);
  const N = MIRROR_UNREACHABLE_STREAK_WARN;
  if (m?.readable === false) {
    return `- ❔ 会话异地镜像（\`${id}\`）：**判据源不可读**（${m?.readError ?? '未知'}）—— 健康不可判（不回落 tickd state）`;
  }
  if (m?.level === 'yellow' || m?.level === 'red') {
    return `- ⚠️ **会话异地镜像停摆**（\`${id}\`）：对端连续不可达 **${n}** 轮（告警阈值 ${N}）—— 四段式文案见上方该 job 行`;
  }
  if (m?.lastResult === 'unreachable') {
    return `- ${LEVEL_ICON.green} 会话异地镜像（\`${id}\`）：对端连续 ${n} 轮不可达（未达阈值 ${N} · 不计失败）`;
  }
  if (m?.lastResult) {
    return `- ✅ 会话异地镜像（\`${id}\`）：对端可达（最近一轮 ${m.lastResult} · 连续不可达 ${n} 轮）· 末次 ${fmtLocalTime(m.lastRunAt)}`;
  }
  return `- ⚪ 会话异地镜像（\`${id}\`）：判据面无 lastResult（镜像脚本尚未跑过）`;
}

/** 日报段（markdown 行数组）——与 upgrade-lock 的 dailySectionLines 同形态，方便 report.mjs 直接铺。
 *  @param {object} h judgeTickdHealth 的返回值
 *  @param {{now?:number}} [opts] now 可注入（单测用；默认真实时间） */
export function dailySectionLines(h, opts = {}) {
  const now = opts.now ?? Date.now();
  const L = [];
  L.push('## ⏱ tick 调度健康（tickd）');
  L.push('');
  if (!h?.ok) {
    L.push(`- ❔ 不可探测：${h?.reason ?? '未知'}${h?.stateFile ? `（${h.stateFile}）` : ''}`);
    L.push('');
    return L;
  }
  const icon = LEVEL_ICON[h.level] ?? '⚪';
  // 【卡「tickd 停摆治本」2026-09-23】引擎未运行必须**第一行**就说，且与「job 失败」分开说：
  //   实测 2026-09-22 tickd 停 2h+，而 state 里所有 job 的 lastStatus 仍然是 ok / failures=0
  //   ⇒ 段里只有一行藏在中间的「🔴 常驻未运行」，紧邻的却是一行 ✅「无失败 job」——
  //   读者一眼扫过去就是"没事"（这就是静默停摆的最后一道可见性缺口）。
  //   判据不新造：直接用 judgeTickdHealth() 已经算好的 h.running / h.level。
  if (h.running.ok !== true) {
    L.push(`- 🔴 **引擎未运行**（${h.running.reason ?? '未知'}）—— 调度器整个没在跑，下面所有 job 状态都是**上次运行时的残留快照**，`
      + '不代表现在在跑；恢复：`node <butler-root>/tools/dsh-butler/butler-tickd.mjs --ensure`');
  }
  if (h.failing.length) {
    for (const f of h.failing) {
      const err = String(f.lastError ?? '').split('\n')[0].slice(0, 160);
      L.push(`- ${LEVEL_ICON[f.level] ?? '⚠️'} job \`${f.id}\`（${f.label}）**${f.reason}** · 共 run ${f.runs} 次 / fail ${f.failures} 次`
        + `${err ? ` · 最后错误：${err}` : ''} · 末次 ${fmtLocalTime(f.lastEndAt)}`);
    }
  } else if (h.running.ok !== true) {
    // 引擎没跑时**不许**给 ✅（见上面那段注释）：这份"无失败"只是残留快照
    L.push(`- ⚪ 无失败 job（${h.jobCount} 个 job：正常 ${h.healthyCount}${h.unknownCount ? ` · 未运行过 ${h.unknownCount}` : ''}）`
      + ' —— 引擎未运行，此"正常"为残留快照，不可信');
  } else {
    L.push(`- ${icon} 无失败 job（${h.jobCount} 个 job：正常 ${h.healthyCount}${h.unknownCount ? ` · 未运行过 ${h.unknownCount}` : ''}）`);
  }
  L.push(`- ${h.running.ok ? '✅' : '🔴'} tickd 常驻：${h.running.ok ? `运行中（PID ${h.running.pid ?? '?'}）` : `**未运行**（${h.running.reason}）`} · 心跳 ${fmtLocalTime(h.lastLoopAt)} · loop ${h.loopCount} · 状态文件 \`${h.stateFile}\``);
  // 【M5】会话异地镜像**常驻行**：无论绿黄都在段里留一行（"停摆看不见"正是本族要治的病）。
  //   为什么要有常驻行：告警只在 `failing` 里出现 ⇒ 未达阈值 / 判据源不可读时，段里**一个字都不提镜像**
  //   （读者无法区分"镜像好着"与"压根没在看"）。四段式告警文案仍由上面的 failing 循环原样输出（不重复、不复制判据）。
  if (h.sessionMirror) L.push(sessionMirrorDailyLine(h.sessionMirror));
  // 【卡 拷问 1.5】「该跑没跑」单列一行：这条与"失败"是两回事（停机窗口不产生失败，只有滞后）
  if (h.lagging?.length) {
    L.push(`- ⏳ **该跑没跑**：${h.lagging.map((x) => `\`${x.id}\`（落后 ${x.lag.lagDays} 天 · ${x.lag.reason}）`).join('、')} —— 日历型 job；\`lastStatus\` 可能是 ok，别当成"最近跑过"`);
  } else if (h.jobCount) {
    L.push('- ⏳ 该跑没跑：无（日历型 job 均未落后）');
  }
  // 【卡 拷问 1.5】停摆窗口台账（tickd 冷启动写的"上一进程空档"）
  if (h.lastStall?.from) {
    const mins = Math.round(Number(h.lastStall.gapMs ?? 0) / 60000);
    L.push(`- ⏸ tickd 上次停摆窗口：${fmtLocalTime(h.lastStall.from)} → ${fmtLocalTime(h.lastStall.to)}（${mins} 分钟`
      + `${h.lastStall.missedCount ? ` · 窗口内该跑没跑 ${h.lastStall.missedCount} 个：${(h.lastStall.missed ?? []).map((m) => m.id).join('、')}` : ' · 窗口内无日历 job 到期'}）`);
  }
  // 【卡 0 · B6③】状态文件里存的是 UTC ISO；上面两处显示已统一转本地（避免"凌晨跑过 job"的误判）。
  L.push('- ⏰ 段内时间口径：**本地时区**（状态文件存 UTC ISO，展示时已换算；换算函数 `fmtLocalTime`）');
  if (h.unknownCount) {
    L.push(`- ⚪ 未运行过：${h.jobs.filter((x) => x.level === 'info' && !x.runs).map((x) => `\`${x.id}\``).join('、')}`);
  }
  // 【卡 4a12fc8c】残留被自动复位也要留痕：否则"曾经停摆过"这件事随状态被改写而消失
  if (h.staleResets?.length) {
    L.push(`- ⚪ 曾自动复位 running 残留：${h.staleResets.map((x) => `\`${x.id}\`（${x.resets} 次 · 最近 ${fmtLocalTime(x.at)}）`).join('、')} —— 复位后下一轮已重新入队（tickd stale 兜底）`);
  }
  if (h.lastLoopAt) {
    const ageMin = Math.round((now - Date.parse(h.lastLoopAt)) / 60000);
    if (Number.isFinite(ageMin) && ageMin > 10) L.push(`- ⚠️ 心跳已停 ${ageMin} 分钟（> 10 分钟，调度可能已停摆）`);
  }
  L.push('');
  return L;
}

export default judgeTickdHealth;
