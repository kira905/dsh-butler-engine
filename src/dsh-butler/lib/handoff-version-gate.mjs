// dsh-butler / lib/handoff-version-gate.mjs —— 交接版本门比较器 + 交接窗口判定（纯函数库）
//
// 来源：docs/
//   §5.3 第 1 条（版本门：本机/仓内 handoff-version.json + minSupported，fail-closed）
//   §5.3 第 6 条（触发源互斥 + drain 语义；心跳双字段 lastHeartbeatAt / lastSuccessfulHandoffAt）
//   §5.3 R10（DSH 主程序版本 + 关键插件版本进门禁 → 不一致 = 🟡 告警 + 合并前人工确认）
//   §17.1 T2（RestartTick 在交接窗口内必须回 busy、不得拉起 DSH）
//   §17.2 T4（双开嫌疑：心跳显著新于最后一次完整交接 → 禁止热采，fail-closed）
//
// 本卡（S5·H1b-prep）范围：**只交付纯函数库 + 单测，不接线**。
//   - 不读生产配置做副作用（detectHandoffWindow 只读文件、绝不写）
//   - 不接 Arrive/Depart（H1b 的事）
//   - 接线点见文件末尾 §接线点清单
//
// 设计口径（务必与方案一致，别自行发明语义）：
//   verdict 四态：exact（一致）/ forked（分叉）/ missing（缺数据）/ not-applicable（一侧没有该字段）
//   → **分叉与缺失都要人工确认**（R10 原文：「不自动拒绝：正常灰度升级不该被卡死，但必须让人看见」）
//   → 只有 **minSupported 版本门** 才是 fail-closed（旧版读到 `minSupported > self` → 拒绝执行）
import fs from 'node:fs';
import path from 'node:path';

export const HANDOFF_GATE_VERSION = '0.1.0';

/**
 * 关键插件版本表（§5.3 R10：这三类 schema 跟主包/插件版本绑，双机版本差会让合并器按旧 schema 解新数据）。
 * `key` = 交接单 `pluginVersions{}` 里的键名（H1b 接线时必须与此一致）。
 */
export const CRITICAL_PLUGINS = [
  { key: 'task-board', label: '任务看板（账本 schema）', package: '@linxin666/dsh-task-board-local',
    aliases: ['dsh-task-board-local', '@linxin666/dsh-task-board-local'] },
  { key: 'butler-panel', label: 'Butler panel', package: 'dsh-butler-panel',
    aliases: ['dsh-butler-panel'] },
  { key: 'imagegen', label: 'AI 生图（历史/画廊索引）', package: 'dsh-imagegen',
    aliases: ['@dickpy/dsh-imagegen', 'dsh-imagegen'] },
];

/**
 * 从一个"包名 → 版本"表里挑出关键插件版本，键名统一成 CRITICAL_PLUGINS[].key。
 * 2026-09-14 实测教训：现网 `profiles/web/package.json` 里的实际包名是
 * `dsh-task-board-local` / `@dickpy/dsh-imagegen` / `dsh-butler-panel` ——
 * **与 CRITICAL_PLUGINS 声明的 npm 包名不同**（自建 fork / 换 scope）。
 * 只按 `package` 精确匹配会一个都挑不出来（版本门形同虚设），故走 aliases + 后缀包含兜底。
 * @param {Record<string,string>} table
 * @returns {Record<string,string>}
 */
export function pickCriticalPluginVersions(table = {}) {
  const out = {};
  const entries = Object.entries(table ?? {});
  for (const p of CRITICAL_PLUGINS) {
    const names = [p.package, ...(p.aliases ?? [])];
    // ① 精确命中别名
    let hit = entries.find(([k]) => names.includes(k) || names.includes(k.replace(/^@[^/]+\//, '')));
    // ② 兜底：包名（去 scope）以 key 结尾（如 dsh-task-board-local 以 task-board-local 结尾）
    if (!hit) hit = entries.find(([k]) => { const b = k.replace(/^@[^/]+\//, ''); return b === p.key || b.endsWith(p.key) || b.includes(p.key); });
    if (hit) out[p.key] = String(hit[1]);
  }
  return out;
}

/** 判定取值（枚举，供下游 switch）。 */
export const VERDICT = Object.freeze({
  EXACT: 'exact',
  FORKED: 'forked',
  MISSING: 'missing',
  NA: 'not-applicable',
});

// ---------------------------------------------------------------- 版本解析 / 比较

/**
 * 解析版本字符串。
 * - `0.1.2` / `1.45.1` / `v0.1.2` → {main:[0,1,2], pre:[], preLabel:null, valid:true}
 * - `0.1.2-rc.1` / `0.1.5-rc.1+build` → 主段 [0,1,5]，preLabel='rc.1'
 * - 非 semver（`latest` / `^1.2` / 空）→ valid:false（**不猜**，由调用方判 missing/分叉）
 * @param {any} raw
 * @returns {{valid:boolean, raw:string, main:number[]|null, preLabel:string|null}}
 */
export function parseVersion(raw) {
  const rawStr = raw === null || raw === undefined ? '' : String(raw).trim();
  const s = rawStr.replace(/^v/i, '');
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return { valid: false, raw: rawStr, main: null, preLabel: null };
  const main = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
  // 去掉尾部全零（0.1.2.0 == 0.1.2）
  while (main.length > 3 && main[main.length - 1] === 0) main.pop();
  return { valid: true, raw: rawStr, main, preLabel: m[5] ?? null };
}

/**
 * 数字段比较。**预发布标签不参与判定**（按 semver 规则 `0.1.5-rc.1 < 0.1.5`，但交接场景里
 * 这才是"正在灰度升级"的正常态 —— 由调用方读 preLabel 单独呈现，别在这里替人拍板）。
 * @returns {-1|0|1|null} null = 任一侧不可解析
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa.valid || !pb.valid) return null;
  const n = Math.max(pa.main.length, pb.main.length);
  for (let i = 0; i < n; i++) {
    const x = pa.main[i] ?? 0;
    const y = pb.main[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 比较一对版本 → 结构化结论。
 * @param {any} self
 * @param {any} peer
 * @param {{label?:string, requirePeer?:boolean}} [opts] requirePeer=true 时缺对端 → missing
 * @returns {{label:string, self:string|null, peer:string|null, verdict:string, same:boolean|null,
 *            order:'self>peer'|'self<peer'|'equal'|null, preLabel:{self:string|null, peer:string|null},
 *            reason:string, needHuman:boolean}}
 */
export function classifyPair(self, peer, opts = {}) {
  const label = opts.label ?? 'version';
  const pSelf = parseVersion(self);
  const pPeer = parseVersion(peer);
  const sOut = pSelf.valid ? pSelf.raw : (self ? String(self) : null);
  const pOut = pPeer.valid ? pPeer.raw : (peer ? String(peer) : null);
  const pre = { self: pSelf.preLabel, peer: pPeer.preLabel };

  if (!self && !peer) {
    return { label, self: null, peer: null, verdict: VERDICT.MISSING, same: null, order: null, preLabel: pre, reason: '两侧都没有值', needHuman: false };
  }
  if (!peer) {
    // 对端缺数据：requirePeer 时算缺失（要人看），否则只是"对端还没登记"
    const hard = opts.requirePeer !== false;
    return {
      label, self: sOut, peer: null, verdict: hard ? VERDICT.MISSING : VERDICT.NA, same: null, order: null, preLabel: pre,
      reason: '对端缺该字段', needHuman: hard,
    };
  }
  if (!self) {
    const hard = opts.requirePeer !== false;
    return {
      label, self: null, peer: pOut, verdict: hard ? VERDICT.MISSING : VERDICT.NA, same: null, order: null, preLabel: pre,
      reason: '本机缺该字段', needHuman: hard,
    };
  }
  if (!pSelf.valid || !pPeer.valid) {
    const bad = [!pSelf.valid ? `本机「${sOut}」` : null, !pPeer.valid ? `对端「${pOut}」` : null].filter(Boolean).join(' + ');
    return { label, self: sOut, peer: pOut, verdict: VERDICT.MISSING, same: null, order: null, preLabel: pre, reason: `${bad} 不是可比较的版本号`, needHuman: true };
  }
  const cmp = compareVersions(sOut, pOut);
  const same = cmp === 0;
  return {
    label, self: sOut, peer: pOut,
    verdict: same ? VERDICT.EXACT : VERDICT.FORKED,
    same,
    order: same ? 'equal' : (cmp > 0 ? 'self>peer' : 'self<peer'),
    preLabel: pre,
    reason: same ? '一致' : `分叉（本机 ${sOut} / 对端 ${pOut}）`,
    needHuman: !same,
  };
}

// ---------------------------------------------------------------- 聚合：单机/双机版本对比

/**
 * 版本对比（§5.3 第 1 条 + R10）。**纯函数**：输入两侧的版本表，输出判定与差异清单。
 *
 * @param {{
 *   self?: {host?:string, dshVersion?:string, pluginVersions?:Record<string,string>, handoffVersion?:string},
 *   peer?: {host?:string, dshVersion?:string, pluginVersions?:Record<string,string>, handoffVersion?:string},
 *   plugins?: Array<{key:string,label?:string}>,
 *   requirePeer?:boolean
 * }} input
 * @returns {{
 *   verdict:'exact'|'forked'|'missing',
 *   same:boolean,
 *   needHumanConfirm:boolean,
 *   selfHost:string|null, peerHost:string|null,
 *   diffs: object[],
 *   summaryLine:string,
 *   counts:{exact:number, forked:number, missing:number, na:number}
 * }}
 */
export function compareVersionTables(input = {}) {
  const self = input.self ?? {};
  const peer = input.peer ?? {};
  const plugins = Array.isArray(input.plugins) && input.plugins.length ? input.plugins : CRITICAL_PLUGINS;
  const requirePeer = input.requirePeer !== false;

  const diffs = [];

  // ① DSH 主包版本（R10）
  const dsh = classifyPair(self.dshVersion, peer.dshVersion, { label: 'dshVersion（主包）', requirePeer });
  diffs.push({ key: 'dshVersion', kind: 'core', ...dsh });

  // ② 交接器自身版本（H1b 的 minSupported 门用它的数值；此处只比"两侧是否同一版"）
  const ho = classifyPair(self.handoffVersion, peer.handoffVersion, { label: 'handoffVersion（交接器）', requirePeer: false });
  diffs.push({ key: 'handoffVersion', kind: 'core', ...ho });

  // ③ 关键插件（R10）
  for (const p of plugins) {
    const key = p.key;
    const label = p.label ? `${key}（${p.label}）` : key;
    const r = classifyPair(self.pluginVersions?.[key], peer.pluginVersions?.[key], { label, requirePeer });
    diffs.push({ key, kind: 'plugin', package: p.package ?? null, ...r });
  }

  const counts = { exact: 0, forked: 0, missing: 0, na: 0 };
  for (const d of diffs) counts[d.verdict] = (counts[d.verdict] ?? 0) + 1;

  // 整体判定：任一分叉 → forked；否则任一缺失（且要人看）→ missing；否则 exact
  const hardMissing = diffs.filter((d) => d.verdict === VERDICT.MISSING && d.needHuman);
  const forked = counts.forked > 0;
  const verdict = forked ? VERDICT.FORKED : (hardMissing.length ? VERDICT.MISSING : VERDICT.EXACT);
  const same = verdict === VERDICT.EXACT;
  // R10：分叉 → 🟡 告警 + **合并前要求人工确认**（不自动拒绝）
  const needHumanConfirm = !same;

  const bad = diffs.filter((d) => d.verdict !== VERDICT.EXACT && d.verdict !== VERDICT.NA);
  const summaryLine = same
    ? `版本门：一致（主包 ${dsh.self ?? '?'} + ${plugins.length} 个关键插件）`
    : `版本门：${verdict === VERDICT.FORKED ? '分叉' : '数据缺失'}（${bad.length} 项，需人工确认后才能合并）：`
      + bad.map((d) => `${d.key}=${d.self ?? '∅'}/${d.peer ?? '∅'}`).join('、');

  return {
    verdict, same, needHumanConfirm,
    selfHost: self.host ?? null,
    peerHost: peer.host ?? null,
    diffs, counts, summaryLine,
  };
}

/**
 * minSupported 硬门（§5.3 第 1 条，**fail-closed**）。
 * @param {{self?:{handoffVersion?:string}, peerVersionFile?:any, reference?:string}} input
 *   peerVersionFile = 仓内 dsh/handoff-version.json（发布方写）；reference = 本机 self 版本（缺省取 self.handoffVersion）
 * @returns {{ok:boolean, decision:'allow'|'reject', reason:string, self:string|null, minSupported:string|null, maxKnown:string|null, detail:object}}
 */
export function checkMinSupported(input = {}) {
  const selfVer = input.self?.handoffVersion ?? null;
  const file = input.peerVersionFile ?? null;
  const minSupported = file?.minSupported ?? null;
  const maxKnown = file?.maxKnown ?? null;
  const detail = { minSupported, maxKnown, keys: file && typeof file === 'object' ? Object.keys(file) : [] };

  if (!minSupported) {
    return { ok: true, decision: 'allow', reason: '仓内未声明 minSupported（视为不设硬门）', self: selfVer, minSupported: null, maxKnown, detail };
  }
  if (!selfVer) {
    return { ok: false, decision: 'reject', reason: '本机缺 handoffVersion，无法判定是否满足 minSupported', self: null, minSupported, maxKnown, detail };
  }
  const cmp = compareVersions(selfVer, minSupported);
  if (cmp === null) {
    return { ok: false, decision: 'reject', reason: `版本不可比较（本机 ${selfVer} / minSupported ${minSupported}）→ fail-closed`, self: selfVer, minSupported, maxKnown, detail };
  }
  if (cmp < 0) {
    return { ok: false, decision: 'reject', reason: `本机交接器 ${selfVer} < minSupported ${minSupported} → 拒绝执行（读新数据会出错）`, self: selfVer, minSupported, maxKnown, detail };
  }
  return { ok: true, decision: 'allow', reason: `本机 ${selfVer} ≥ minSupported ${minSupported}`, self: selfVer, minSupported, maxKnown, detail };
}

/**
 * 双开嫌疑（§17.2 T4 放宽口径）：**lastHeartbeatAt 显著新于 lastSuccessfulHandoffAt**
 * = 对端在最后一次完整交接之后仍在活动。
 * 注：正常 Depart→Arrive 流程里，心跳只会在 Depart 结束时与 successful 同刻更新，不会误伤。
 * @param {{lastHeartbeatAt?:string|number, lastSuccessfulHandoffAt?:string|number}} peerRecord
 * @param {{windowMs?:number, now?:number}} [opts]
 * @returns {{suspected:boolean|null, reason:string, heartbeatAt:number|null, handoffAt:number|null}}
 */
export function judgeDualActiveTransition(peerRecord, opts = {}) {
  const windowMs = opts.windowMs ?? 30 * 60 * 1000; // 与热采周期同量级
  const now = opts.now ?? Date.now();
  const hb = toMs(peerRecord?.lastHeartbeatAt);
  const ho = toMs(peerRecord?.lastSuccessfulHandoffAt);
  if (hb === null) return { suspected: null, reason: '对端无心跳记录（新机/冷启动）→ 放行', heartbeatAt: null, handoffAt: ho };
  if (ho === null) return { suspected: false, reason: '对端只有心跳、从无完整交接记录 → 不判双开', heartbeatAt: hb, handoffAt: null };
  if (hb - ho > windowMs) {
    return { suspected: true, reason: `心跳比最后一次完整交接新 ${Math.round((hb - ho) / 60000)} 分钟（>${Math.round(windowMs / 60000)}）→ 双开嫌疑，禁止热采（fail-closed）`, heartbeatAt: hb, handoffAt: ho };
  }
  return { suspected: false, reason: `心跳与最后一次完整交接相差 ${Math.round(Math.abs(hb - ho) / 60000)} 分钟（正常）`, heartbeatAt: hb, handoffAt: ho, now };
}

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------- 交接窗口判定（RestartTick 用）

/** 交接窗口的**唯一权威信号** = 交接器自己持有的 tick 锁（`tick-handoff.lock`，TTL 60 分钟）。 */
export const HANDOFF_TICK_LOCK = 'handoff';

/**
 * 检测是否处于交接窗口。**只读、无副作用**。
 *
 * 为什么用锁文件而不是另建状态文件：H1a 的 `handoff.mjs` 在 Arrive/Depart 全程持有
 * `butler-locks/tick-handoff.lock`（TTL 60 分钟）——这已经是"交接进行中"的现成权威标记。
 * T2 本卡边界内**不允许改 handoff.mjs**，也不允许另造第二份真相（§5.3 纪律），故直接读它。
 * ⚠️ H1b 接线时若给交接器加了显式 `running` 状态（§17.2 T8 建议），应把那里作为第一信号源，
 *    本函数作为兜底 —— 见文件末尾接线点 §3。
 *
 * @param {{home?:string, now?:number, isAlive?:(pid:number)=>boolean, extraSignals?:object[]}} [opts]
 * @returns {{active:boolean, reason:string, lockPath:string|null, holder:object|null, expiresInMs:number|null, signals:object[]}}
 */
export function detectHandoffWindow(opts = {}) {
  const home = opts.home ?? process.env.BUTLER_DSH_HOME ?? process.env.DSH_HOME ?? null;
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const signals = Array.isArray(opts.extraSignals) ? [...opts.extraSignals] : [];

  if (!home) {
    return { active: false, reason: '无法确定 DSH home（不判窗口）', lockPath: null, holder: null, expiresInMs: null, signals };
  }
  const lockPath = path.join(home, 'butler-locks', `tick-${HANDOFF_TICK_LOCK}.lock`);
  let holder = null;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    holder = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return { active: false, reason: '无交接锁（不在交接窗口）', lockPath, holder: null, expiresInMs: null, signals };
  }
  if (!holder || typeof holder !== 'object') {
    return { active: false, reason: '交接锁为空/损坏（视为不在窗口）', lockPath, holder: null, expiresInMs: null, signals };
  }
  const startedAt = Number(holder.startedAt ?? 0);
  const ttl = Number(holder.ttl ?? 0);
  const age = now - startedAt;
  const expired = !Number.isFinite(age) || !ttl || age > ttl;
  const alive = isAlive(Number(holder.pid));
  const expiresInMs = ttl && Number.isFinite(age) ? Math.max(0, ttl - age) : null;

  if (expired) {
    return { active: false, reason: `交接锁已过期（${Math.round(age / 1000)}s > ttl ${Math.round(ttl / 1000)}s）`, lockPath, holder, expiresInMs: 0, signals };
  }
  if (!alive) {
    // 持有者已死但 TTL 未到：**保守判为窗口内**（宁可 3 分钟不发重启，不可撞上正在收尾的交接）
    return { active: true, reason: `交接锁持有者 pid=${holder.pid} 已退出但 TTL 未到 → 保守判窗口内`, lockPath, holder, expiresInMs, signals: [...signals, { kind: 'holder-dead', pid: holder.pid }] };
  }
  return { active: true, reason: `交接进行中（pid=${holder.pid}，剩余 ${Math.round((expiresInMs ?? 0) / 1000)}s）`, lockPath, holder, expiresInMs, signals };
}

function defaultIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * 重启发起前的守卫（**纯判定**，调用方负责"回 busy"这个动作）。
 * 接线点：`restart-coordinator.mjs` 的 `tick()`，抢到 tick 锁之后 / 做任何决策之前。
 * @param {{home?:string, now?:number, isAlive?:(pid:number)=>boolean, dryRun?:boolean}} [opts]
 * @returns {{action:'proceed'|'busy', reason:string, window:object, audit:{type:string, reason:string, at:string}}}
 */
/** 【D6 治本 · 2026-10-13】持有者已退出后的宽限期（超过它就不再当"交接窗口内"）。 */
export const DEAD_HOLDER_GRACE_MS = 120_000;

/**
 * 【D6 治本 · 2026-10-13】"锁的持有者已死、但锁的 TTL 还没到"⇒ 是否已经够久、可以放行。
 *
 * 背景（2026-10-13 停机窗口实测）：持有者被**关机链 / 杀进程**干掉时锁会残留到 TTL
 *   （本次 `ttl=1200000` = **20 分钟**），而下面 `restartGuard` 原本死守这条
 *   「持有者已死但 TTL 未到 ⇒ 保守判窗口内」⇒ **重启闸门被白堵整一个 TTL**。
 *   同族的 D4（hot 卡住抱锁）也是这把锁。
 *
 * 语义：持有者进程已死 ⇒ 它那一轮临界区**必然已结束**（临界区不可能活在死进程里）；
 *   留 `graceMs` 宽限只为覆盖原设计担心的极端情形（孤儿子进程还在收尾）。
 *
 * 边界：**只给重启闸门用**（`restartGuard`），**不改** `detectHandoffWindow()` 的默认保守行为
 *   ⇒ 交接窗口的其它消费者（watch / watch-fs / queue / cross-lane / p0-auto…）**行为零变化**。
 *
 * @param {object} win `detectHandoffWindow()` 的结果
 * @param {{now?:number, deadHolderGraceMs?:number}} [opts]
 * @returns {boolean} true = 已过宽限、可放行
 */
export function deadHolderGraceExceeded(win, opts = {}) {
  const sig = Array.isArray(win?.signals) ? win.signals.find((s) => s && s.kind === 'holder-dead') : null;
  if (!sig) return false;                                    // 不是"持有者已死"形态 ⇒ 不参与
  const grace = Number.isFinite(opts.deadHolderGraceMs) ? Math.max(0, opts.deadHolderGraceMs) : DEAD_HOLDER_GRACE_MS;
  const startedAt = Number(win?.holder?.startedAt);
  if (!Number.isFinite(startedAt)) return false;              // 取不到起始时刻 ⇒ 不擅自放行（保守）
  const ageMs = (Number.isFinite(opts.now) ? opts.now : Date.now()) - startedAt;
  return ageMs >= grace;
}

export function restartGuard(opts = {}) {
  const win = detectHandoffWindow(opts);
  const at = new Date(opts.now ?? Date.now()).toISOString();
  // 【D6 治本 · 2026-10-13】陈旧持有者：锁在 + 持有者已死 + **已过宽限** ⇒ 视为过期、放行重启。
  //   原行为 = 死守 TTL（本次实测白堵 20 分钟）⇒ 本次**只对这一支**放宽，其余路径逐字不变。
  //   审计类型沿用 restart-handoff-clear（不引入新 type ⇒ 消费方零风险），区别写在 reason 里。
  if (win.active && deadHolderGraceExceeded(win, opts)) {
    const graceMs = Number.isFinite(opts.deadHolderGraceMs) ? Math.max(0, opts.deadHolderGraceMs) : DEAD_HOLDER_GRACE_MS;
    const ageS = Math.round(((Number.isFinite(opts.now) ? opts.now : Date.now()) - Number(win.holder?.startedAt)) / 1000);
    const why = `交接锁持有者 pid=${win.holder?.pid} 已退出且已过宽限（已持 ${ageS}s ≥ ${Math.round(graceMs / 1000)}s）⇒ 视为过期、放行重启（不清锁：留给停机链清理或下次持锁者覆盖）`;
    return {
      action: 'proceed', reason: why, window: { ...win, active: false, staleHolder: true },
      audit: { type: 'restart-handoff-clear', reason: why, at },
    };
  }
  if (win.active) {
    return {
      action: 'busy', reason: win.reason, window: win,
      audit: { type: 'restart-yield-handoff', reason: win.reason, at },
    };
  }
  return { action: 'proceed', reason: win.reason, window: win, audit: { type: 'restart-handoff-clear', reason: win.reason, at } };
}

// ---------------------------------------------------------------- 报告渲染（给人工确认用）

/**
 * 把 compareVersionTables 的结果渲染成 Markdown（交接单 / 面板 / 日报共用同一段文本）。
 * @param {ReturnType<typeof compareVersionTables>} cmp
 * @param {{title?:string}} [opts]
 */
export function renderVersionReport(cmp, opts = {}) {
  const title = opts.title ?? '版本门对比';
  const L = [];
  L.push(`### ${title}`);
  L.push('');
  L.push(`- 判定：**${cmp.verdict}**（${cmp.same ? '两侧一致' : '需人工确认后才能合并'}）`);
  L.push(`- 本机：\`${cmp.selfHost ?? '?'}\`　对端：\`${cmp.peerHost ?? '?'}\``);
  L.push(`- 计数：一致 ${cmp.counts.exact} / 分叉 ${cmp.counts.forked} / 缺失 ${cmp.counts.missing} / 不适用 ${cmp.counts.na}`);
  L.push('');
  L.push('| 项 | 本机 | 对端 | 判定 | 说明 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const d of cmp.diffs) {
    L.push(`| ${d.label} | \`${d.self ?? '∅'}\` | \`${d.peer ?? '∅'}\` | ${d.verdict} | ${d.reason} |`);
  }
  if (cmp.needHumanConfirm) {
    L.push('');
    L.push('> ⚠️ 按 §5.3 R10：分叉/缺失 **不自动拒绝**，但**合并前必须人工确认**（口径见方案 §5.5 人工裁决四步）。');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- 接线点清单（H1b 照此接）
//
// §1 版本门强校验（H1b 主卡）
//     - 数据源：本机 `~/.dsh/handoff-version.json`（handoffVersion + 三仓采集脚本版本 + minSupported）
//               + 仓内 `dsh/handoff-version.json`（发布方写）。
//     - 读法：`checkMinSupported({ self:{handoffVersion}, peerVersionFile })` → decision==='reject' 就停（fail-closed）。
//     - 交接单：`pluginVersions{}` 的键必须用 `CRITICAL_PLUGINS[].key`（task-board / butler-panel / imagegen）。
//     - Arrive 比对：`compareVersionTables({ self, peer })` → `needHumanConfirm` 为真时，**合并前**要求人确认。
//
// §2 交接窗口（RestartTick 回 busy）
//     - `restart-coordinator.mjs` 的 `tick()`：抢到 tick 锁后立刻跑 `restartGuard({ home })`，
//       `action==='busy'` → 写 `action:'busy'` 结果 + `appendAudit(guard.audit)` 后 return，
//       绝不进入维护窗口/批量决策分支。（本卡已在 tickd 侧做了同一判定，双保险。）
//
// §3 触发源互斥 + drain 语义（§5.3 第 6 条）
//     - 四类触发（开机钩 Arrive / 关机钩 Depart / 热采 tick / 企微远程）共用 `tick-handoff.lock`；
//     - 关机钩撞热采 → 等其结束（上限 = 剩余预算），**不许并发**；
//     - ⚠️ drain 需要"等待"能力，本卡只交付判定；`acquireTickLock` 当前 waitMs=0（不排队），
//       H1b 若需要等待式获取，应新增 `acquireTickLockWait()` 而不是改 `acquireTickLock` 的默认语义。
//
// §4 双开嫌疑（`judgeDualActiveTransition`）
//     - 热采/合并前置：`suspected === true` → 禁止自动写（fail-closed，§17.2 T4）。
//
// §5 本卡**不做**：Arrive/Depart 接线、P2 判定口径、看板账本结构、任何写操作。
