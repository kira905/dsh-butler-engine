// dsh-butler / lib/autonomy.mjs —— 全局自治开关（裸跑期「开关清单」唯一入口）
//
// 方案：docs/ §5「裸跑期」（行 943-959）
//   「一律关闭」四项统一由 p3AutoEnabled + autoHealEnabled 控制，默认全 false：
//     ① P3 全部 L1/L2 自动动作          → p3AutoEnabled
//     ② P0 低水位自动重启（无操作者显式请求）→ p3AutoEnabled && p0AutoRestartEnabled
//     ③ P5 B 层自动回滚（降人工确认）     → autoHealEnabled && p5AutoRollbackEnabled
//     ④ 组件自修复的自动修复分支         → autoHealEnabled
//   【第五项 · P8 [12] · 2026-09-28】P8 临时区自动收纳（L2 搬移）→ **p8AutoEnabled（独立）**，
//     操作者 2026-09-10 16:36 拍板「p8-auto 独立自主」+ §15.1 D2。**默认 false**。
//     它与其他四项是并列关系：`p3AutoEnabled` 关不掉它、也开不了它（详见 AUTO_KINDS 上方注释）。
//
// **fail-safe 铁律（裸跑期放行判定的前提）**：文件缺失 / 读失败 / schema 不符 / 字段非 true
//   → 一律按「关」处理。宁可少做一次自动动作，不可在未放行时自动执行。
//
// 写盘走 butler-store.writeJsonAtomic（原子写）；改开关必须带 by/reason 并落审计。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './paths.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { writeTextAtomic } from './store.mjs';
import { writeStateText } from './dual-write.mjs';
import { appendAudit } from './audit.mjs';

export const AUTONOMY_VERSION = '0.1.0';
export const AUTONOMY_SCHEMA = 1;

/** 状态文件路径：统一入口（legacy 期 = `<home>\butler-autonomy.json`）。 */
function stateFileOf(name, opts = {}) { return resolveStatePath(name, { home: opts.home ?? dshHome() }).path; }

export const AUTONOMY_FILE = 'butler-autonomy.json';

/**
 * 五项「自动执行」的口径（kind → 人类可读 + 归属开关）。
 *
 * 【P8 [12] · 2026-09-28 · 第五项 `p8-auto` 登记】操作者 **2026-09-10 16:36 拍板**：
 *   **p8-auto 独立自主**（不挂在 `p3-auto` 之下）—— P8 的 L2 搬移只搬不删、可一键回滚、
 *   带引用检查与 24h 活跃保护，风险面与 P3「派活」不同量级，故单独给钥匙。
 *   ⇒ `owner` / `raw` **都是 `p8AutoEnabled`**（不是 `p3AutoEnabled`）。
 *   ⚠️ 与 `p3-auto` 的关系（`docs/` §15.1 D2 + §11 订正注）：
 *     · 这里是**通道级**（`autoAllowed`）第五项，与四键**并列**、不叠加；
 *     · 搬移动作**不并 `runAction` 四键**（保独立自主）⇒ P8 动作体自己过
 *       `autoAllowed('p8-auto')` + `checkModuleAllowed('p8-tidy')` + L0 降档，
 *       **不**走 `runAction()` 的那道恒查 `p3-auto`。
 *   ⇒ 后果：`p3AutoEnabled=false` 时 **P8 搬移仍可独立放行**（这正是拍板要的效果）；
 *     反过来 `p8AutoEnabled=false` 时，`p3` 开不开都搬不动。
 */
export const AUTO_KINDS = {
  'p3-auto': { label: 'P3 全部 L1/L2 自动动作', owner: 'p3AutoEnabled', raw: 'p3AutoEnabled' },
  'p0-auto-restart': { label: 'P0 低水位自动重启（无操作者显式请求）', owner: 'p3AutoEnabled', raw: 'p0AutoRestartEnabled' },
  'p5-auto-rollback': { label: 'P5 B 层自动回滚', owner: 'autoHealEnabled', raw: 'p5AutoRollbackEnabled' },
  'auto-heal': { label: '组件自修复的自动修复分支', owner: 'autoHealEnabled', raw: 'autoHealEnabled' },
  'p8-auto': { label: 'P8 临时区自动收纳（L2 搬移 · 只搬不删 · 独立自主）', owner: 'p8AutoEnabled', raw: 'p8AutoEnabled' },
};

/** 默认（裸跑期）配置：五项全 false。 */
export function defaultAutonomy(now = Date.now()) {
  return {
    schemaVersion: AUTONOMY_SCHEMA,
    product: 'dsh-butler',
    phase: 'bare-run',
    p3AutoEnabled: false,
    p0AutoRestartEnabled: false,
    p5AutoRollbackEnabled: false,
    autoHealEnabled: false,
    p8AutoEnabled: false,
    bareRun: {
      startedAt: null,
      minDays: 3,
      device: null,
      note: '裸跑期：只盯人 + 只审计 + 只统筹，一律不自动执行；放行需操作者拍板（方案 §5）',
    },
    updatedAt: new Date(now).toISOString(),
    updatedBy: null,
  };
}

export function autonomyPath(opts = {}) {
  return stateFileOf(AUTONOMY_FILE, opts);
}

/**
 * 计算有效开关（含联动：主开关关 → 从开关强制关）。
 * ⚠️ `p8-auto` **不参与任何联动**（独立自主拍板）：它既不被 `p3AutoEnabled` 挟制，
 *   也不挟制别人 —— 与其他四项是**并列**关系。改动这里前先读 AUTO_KINDS 上方的拍板注。
 * @param {object|null} raw
 * @returns {{p3AutoEnabled:boolean, p0AutoRestartEnabled:boolean, p5AutoRollbackEnabled:boolean,
 *            autoHealEnabled:boolean, p8AutoEnabled:boolean, effective:Record<string,boolean>}}
 */
export function computeEffective(raw) {
  const p3 = raw?.p3AutoEnabled === true;
  const heal = raw?.autoHealEnabled === true;
  const p0 = p3 && raw?.p0AutoRestartEnabled === true;
  const p5 = heal && raw?.p5AutoRollbackEnabled === true;
  const p8 = raw?.p8AutoEnabled === true;
  return {
    p3AutoEnabled: p3,
    p0AutoRestartEnabled: p0,
    p5AutoRollbackEnabled: p5,
    autoHealEnabled: heal,
    p8AutoEnabled: p8,
    effective: {
      'p3-auto': p3,
      'p0-auto-restart': p0,
      'p5-auto-rollback': p5,
      'auto-heal': heal,
      'p8-auto': p8,
    },
  };
}

/**
 * 读自治配置。**任何异常都不抛**（fail-safe：读不到 = 全关）。
 * @param {{home?:string}} [opts]
 * @returns {{ok:boolean, file:string, raw:object, effective:Record<string,boolean>,
 *            switches:{p3AutoEnabled:boolean,p0AutoRestartEnabled:boolean,p5AutoRollbackEnabled:boolean,autoHealEnabled:boolean},
 *            source:'file'|'default', reason:string, phase:string, bareRun:object|null, updatedAt:string|null}}
 */
export function readAutonomy(opts = {}) {
  const file = autonomyPath(opts);
  const base = { ok: false, file, raw: defaultAutonomy(), source: 'default', reason: '', phase: 'bare-run', bareRun: null, updatedAt: null };
  let raw = null;
  let reason = '';
  try {
    if (!fs.existsSync(file)) reason = 'file-missing';
    else {
      const txt = fs.readFileSync(file, 'utf8');
      if (!txt.trim()) reason = 'file-empty';
      else {
        const j = JSON.parse(txt);
        if (!j || typeof j !== 'object') reason = 'file-not-object';
        else if (Number(j.schemaVersion ?? AUTONOMY_SCHEMA) !== AUTONOMY_SCHEMA) reason = `schema-mismatch:${j.schemaVersion}`;
        else { raw = j; reason = 'ok'; }
      }
    }
  } catch (e) {
    reason = `read-error:${e?.message ?? e}`;
  }
  if (!raw) raw = defaultAutonomy();
  const eff = computeEffective(raw);
  return {
    ...base,
    ok: reason === 'ok',
    raw,
    ...eff,
    source: reason === 'ok' ? 'file' : 'default',
    reason,
    phase: typeof raw.phase === 'string' ? raw.phase : 'bare-run',
    bareRun: raw.bareRun ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

/** 幂等创建默认配置（已存在则不动）。 */
export function ensureAutonomy(opts = {}) {
  const file = autonomyPath(opts);
  if (fs.existsSync(file)) {
    const cur = readAutonomy(opts);
    return { ok: true, action: 'exists', file, autonomy: cur };
  }
  const data = { ...defaultAutonomy(opts.now), ...(opts.patch ?? {}) };
  const dw = writeStateText(AUTONOMY_FILE, JSON.stringify(data, null, 2) + '\n', {
    home: opts.home, write: (p, t) => writeTextAtomic(p, t),
  });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  appendAudit({ type: 'autonomy-ensure', file, data }, { home: opts.home, silent: true });
  return { ok: true, action: 'created', file, autonomy: readAutonomy(opts) };
}

/**
 * 改开关（唯一写入口）。
 * @param {object} patch 只允许四个开关 + phase / bareRun / updatedBy
 * @param {{home?:string, by?:string, reason?:string, now?:number}} [opts]
 */
export function setAutonomy(patch = {}, opts = {}) {
  const file = autonomyPath(opts);
  const before = readAutonomy(opts);
  const allowed = ['p3AutoEnabled', 'p0AutoRestartEnabled', 'p5AutoRollbackEnabled', 'autoHealEnabled', 'p8AutoEnabled', 'phase', 'bareRun'];
  const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (unknown.length) return { ok: false, error: `不允许的字段：${unknown.join(', ')}`, file };
  const next = {
    ...(before.ok ? before.raw : defaultAutonomy(opts.now)),
    ...patch,
    schemaVersion: AUTONOMY_SCHEMA,
    product: 'dsh-butler',
    updatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    updatedBy: opts.by ?? opts.updatedBy ?? null,
  };
  for (const k of ['p3AutoEnabled', 'p0AutoRestartEnabled', 'p5AutoRollbackEnabled', 'autoHealEnabled', 'p8AutoEnabled']) {
    next[k] = next[k] === true;
  }
  const dw = writeStateText(AUTONOMY_FILE, JSON.stringify(next, null, 2) + '\n', {
    home: opts.home, write: (p, t) => writeTextAtomic(p, t),
  });
  if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  const after = readAutonomy(opts);
  appendAudit({
    type: 'autonomy-set', file, by: opts.by ?? null, reason: opts.reason ?? null,
    changed: Object.fromEntries(Object.keys(patch).map((k) => [k, { from: before.raw?.[k] ?? null, to: next[k] ?? null }])),
    effective: after.effective,
  }, { home: opts.home, silent: true });
  return { ok: true, action: 'set', file, before: before.raw, after: after.raw, effective: after.effective };
}

/**
 * 自动执行闸门：任何「自动执行」动作在动手前必须问这里。
 * @param {'p3-auto'|'p0-auto-restart'|'p5-auto-rollback'|'auto-heal'|'p8-auto'} kind
 * @returns {{allowed:boolean, reason:string, kind:string, owner:string, phase:string, autonomy:object}}
 */
export function autoAllowed(kind, opts = {}) {
  const meta = AUTO_KINDS[kind];
  if (!meta) throw new Error(`unknown auto kind: ${kind}`);
  const a = readAutonomy(opts);
  const allowed = a.effective[kind] === true;
  // 【2026-09-29 卡「CLI 开关文案」】reason 必须分清三种「关」，旧文案把 ② 混说成 ①：
  //   ① 文件里**有**这个键且非 true ⇒ 「配置显式关闭」（说得清是谁关的）
  //   ② 文件读到了、但**没有**这个键 ⇒ 「缺键 ⇒ fail-safe 关（未注册）」（不是谁显式关的）
  //   ③ 文件压根读不到 ⇒ 「配置不可用」（fail-safe 全关）
  //   为什么必须分：2026-09-29 实测生产 `butler-autonomy.json` 顶层**没有** `p8AutoEnabled`
  //     （只有四个键），旧文案把 ② 说成「配置显式关闭」⇒ 将来要放行 P8 真搬的人会以为
  //     「把 false 改成 true 就行」，实际要**新增一个键**。
  //   ⚠️ 本改动只动文案：`allowed` 与两处分支条件一字未改（判定逻辑零变化）。
  const registered = typeof a.raw?.[meta.owner] === 'boolean';
  const reason = allowed
    ? '开关已放行'
    : (a.effective[meta.owner] !== true
      ? `${meta.owner}=false（${a.source === 'file'
        ? (registered ? '配置显式关闭' : '缺键 ⇒ fail-safe 关（未注册）')
        : `配置不可用：${a.reason}`}）`
      : `${meta.raw}=false`);
  return { allowed, reason, kind, owner: meta.owner, phase: a.phase, autonomy: a };
}

/**
 * 五项 L1 开关键（顺序 = 展示顺序；与 defaultAutonomy() 的字段逐字一致）。
 * 【2026-09-29】仅供 describeAutonomy().switchesRaw 使用（呈现用，不参与任何判定）。
 */
const SWITCH_KEYS = ['p3AutoEnabled', 'p0AutoRestartEnabled', 'p5AutoRollbackEnabled', 'autoHealEnabled', 'p8AutoEnabled'];

/** 一行摘要（面板 / 日报 / CLI 用）。 */
export function describeAutonomy(opts = {}) {
  const a = readAutonomy(opts);
  const rows = Object.entries(AUTO_KINDS).map(([kind, meta]) => ({
    kind, label: meta.label, owner: meta.owner, allowed: a.effective[kind] === true,
  }));
  const off = rows.filter((r) => !r.allowed).length;
  return {
    file: a.file, source: a.source, reason: a.reason, phase: a.phase, bareRun: a.bareRun,
    updatedAt: a.updatedAt, switches: {
      p3AutoEnabled: a.p3AutoEnabled, p0AutoRestartEnabled: a.p0AutoRestartEnabled,
      p5AutoRollbackEnabled: a.p5AutoRollbackEnabled, autoHealEnabled: a.autoHealEnabled,
      p8AutoEnabled: a.p8AutoEnabled,
    },
    // 【2026-09-29 卡「CLI 开关文案」】**原始键视图**（纯追加，既有键集与取值一字未动）：
    //   · present = 文件里真有这个键（`source === 'file'` 且类型是 boolean）——「缺键」就是 present=false；
    //   · value   = **文件真值**（不是 switches 那种联动后的 effective），呈现「原始开关」必须用它。
    //   为什么：`switches` 的值是 computeEffective 后的结果（p0/p5 会随主键联动，source≠file 时全是兜底值），
    //   拿它当「原始」印出来，缺键与显式关就分不开了（实测生产 p8AutoEnabled 键根本不存在）。
    switchesRaw: SWITCH_KEYS.map((k) => ({
      key: k,
      present: a.source === 'file' && typeof a.raw?.[k] === 'boolean',
      value: a.raw?.[k] === true,
    })),
    rows, allOff: off === rows.length, offCount: off, total: rows.length,
  };
}
