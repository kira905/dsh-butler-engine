// dsh-butler / lib/version.mjs —— 产品版本与组件启动自检（方案 §5.1 版本策略）
//
// 产品版本号（dsh-butler X.Y.Z）写在 ~/.dsh/butler-version.json；
// 各组件启动时自检「我的版本 ⊆ 产品版本」。
//
// 2026-10-09（卡「冲刺600·批4-4」产品化纳管）改了三件事，别当没看见：
//   ① 纳管面从 13 条扩到 **15 条**（+ 插件侧 butler-host / butler-panel，原 PENDING_COMPONENTS 清空）；
//   ② 产品版本文件多写一个 `roster`（v2 §5.1 的「8 个组件」= 8 条能力域，见 PRODUCT_ROSTER）；
//   ③ 自检读数新增 `unmanagedCount` / `mismatchCount` / `roster`（口径见 selfCheck）。
//   ⚠️ 产品版本号本身**没动**（仍是 0.1.0）：动它要连带改两个 npm 包版本 + verify.mjs 的不变量，
//      属独立变更、须the operator拍板 —— 建议与理由见交付报告 §版本建议。
//
// 不匹配处置（the operator 2026-09-09 拍板 · v2.3 修订）：
//   **跳过该组件、其余照常启动 + 告警**（不是"拒绝启动整套"）。
//   告警通道必须独立于butler自身组件 → 走 lib/alert.mjs（写 butler-alert.log + stderr），
//   不 import 面板 / host / 日报。
//
// 与 schemaVersion 解耦：产品升级不必然改状态文件 schema；改 schema 必须有 migrate-*.cjs。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PRODUCT_VERSION as PKG_VERSION } from './product.mjs';
import { butlerPaths, dshHome } from './paths.mjs';
import { writeJsonAtomic } from './store.mjs';
import { alert } from './alert.mjs';

export const PRODUCT = 'dsh-butler';
export const PRODUCT_VERSION = PKG_VERSION;

/** 本包纳管组件版本（新增**本仓库**组件必须在此登记，否则 checkComponent 视为 unmanaged）。
 *  插件侧组件（实体在别的 npm 包）走 PLUGIN_COMPONENTS，别塞进来 —— 见该表头注。 */
export const COMPONENT_VERSIONS = {
  'butler-store': '0.1.0',
  'butler-scheduler': '0.1.0',
  'butler-audit-cli': '0.1.0',
  // 0.1.0 保持不变（verify.mjs 要求「登记表组件版本全部 == 产品版本」）：
  // 2026-09-11 卡 [Q4] 修的是 butler-restart-coordinator 的活跃判据（多源并集 + mtime-in-future），
  // 属实现内修复、不动版本号；要单独 bump 必须先改 verify.mjs 那条规范并经the operator拍板。
  'butler-restart-coordinator': '0.1.0',
  // 卡 [2a] P4：坑库扫描 + 签名聚类 + 阶梯升级（含 pitfall-tick.mjs 入口）
  'butler-pitfall': '0.1.0',
  // 卡 [3a] P2：会盯人（16 类事件判定 + 冷却/上限/免打扰/ack + 三通道推送）
  'butler-watch': '0.1.0',
  // 卡 [4] 裸跑期观测：全局自治开关（四项默认关）+ 观测采集器
  'butler-autonomy': '0.1.0',
  'butler-barewatch': '0.1.0',
  // 卡 [7] P6：会望风（外部信号感知：模型列表 / 状态页 / 公告 diff + 源注册表）
  'butler-external': '0.1.0',
  // 卡 [10] P8：会收纳（收纳审计采集器 butler-tidy-tick.mjs；纯只读段）
  'butler-tidy': '0.1.0',
  // 卡 [Q1] 队列推进巡检 + 自动叫醒（B 主干）：review 滞留叫醒（三档 observe/report/notify）
  'butler-queue': '0.1.0',
  // 卡 [6] P3：会派活（L1/L2 自动动作统一闸门 + 分级/去重/上限/预算护栏 + token 用量监测）
  //   裸跑期纪律：代码进生产，但四把自治开关（lib/autonomy.mjs）保持全关 → 交付即待命
  //   2026-09-13 卡 [6a-实施]：账本写路径 = Host API 调用序列（lib/ledger-api.mjs），不再直写文件。
  //   ⚠️ **版本号不随单卡改动升**：`verify.mjs` 的不变量是「全部登记组件版本 == 产品版本」
  //      （此处与 product.mjs 的 PRODUCT_VERSION 必须一致），改造只在注释/变更流水中留痕。
  'butler-auto': '0.1.0',
  // 卡 E1（P0）：看板主线清账判定 + report 档通知（lib/board-cleanup.mjs + butler-board-cleanup.mjs CLI 入口）
  //   交付边界：只读判定；不自动归档、不自动恢复。（原文「不注册 P2 事件（P2_EVENTS_POLICY）」**已由
  //   2026-09-28 K5b 订正**：`P2_EVENTS_POLICY.registered` 现为 `true`，**只注册执行类事件**，
  //   候选提示类仍不注册 —— 见 lib/board-cleanup.mjs 该常量与 docs/）
  //   ⚠️ 版本号不随单卡改动升：verify.mjs 的不变量是「全部登记组件版本 == 产品版本」。
  'butler-board-cleanup': '0.1.0',
};

// ─────────────────────────────────────────────────────────────────────────────
// 插件侧组件（2026-10-09 卡「冲刺600·批4-4」正式纳管 —— 原在 PENDING_COMPONENTS）
//
// 为什么单列一张表：butler-host / butler-panel 的**实体在另一个 npm 包**（dsh-butler-panel）里，
// 版本真值不在本仓库 ⇒ 不在 COMPONENT_VERSIONS 里重复硬编码；这里只登记「真源在哪 + 期望值」，
// 自检时**读实体核对**（漂移可见，见 resolvePluginComponentVersion）。
//
// ⚠️ 三条口径（别顺手改）：
//   1. 本表版本**不参与** verify.mjs §7「登记表组件版本全部 == 产品版本」那条不变量 ——
//      那条只管本仓库组件（COMPONENT_VERSIONS），改了它等于改产品口径。
//   2. `fallback` = 代码**声明的期望值**（写进 butler-version.json 的就是它）；
//      自检拿「实体真值 vs 声明值」比 ⇒ 实体升版而声明没跟 ⇒ version-mismatch（这才是想要的信号）。
//   3. 产品版本号（PRODUCT_VERSION）本次**保持不变**；统一升版（含两个包 npm 版本 + 上面那条不变量）
//      属独立变更、须the operator拍板 —— 见 `docs/` §版本建议。
// ─────────────────────────────────────────────────────────────────────────────
export const PLUGIN_COMPONENTS = {
  'butler-host': {
    label: '插件 host 侧（/api/dsh-butler/v1/* 路由 + P5 写入守门）',
    entity: 'dsh-butler-panel',
    source: { kind: 'esm-const', file: 'lib/host-adapter.mjs', name: 'HOST_ADAPTER_VERSION' },
    fallback: '0.3.1',
  },
  'butler-panel': {
    label: '插件 client 侧（面板 8 Tab + 首屏）',
    entity: 'dsh-butler-panel',
    source: { kind: 'json-field', file: 'package.json', field: 'version' },
    fallback: '0.9.0',
  },
};

/** 全部纳管组件（本仓库 13 条 + 插件侧 2 条）—— 写产品版本文件 / 自检 / 统一恢复入口都用它。 */
export const MANAGED_COMPONENTS = {
  ...COMPONENT_VERSIONS,
  ...Object.fromEntries(Object.entries(PLUGIN_COMPONENTS).map(([k, v]) => [k, v.fallback])),
};

/**
 * v2 方案 §5.1「8 个组件是一个产品」的产品清单：**8 条能力域** → members 覆盖 MANAGED_COMPONENTS 全表。
 * （方案原文的「8 个」与 P 计数对不上是方案自己承认的；这里把它落成可校验的 8 类，见 rosterCoverage()。）
 */
export const PRODUCT_ROSTER = [
  { id: 'butler-host', label: 'host 插件（路由 + P5 拦截器）', members: ['butler-host'] },
  { id: 'butler-panel', label: '面板插件（client）', members: ['butler-panel'] },
  { id: 'butler-store', label: '共享库：状态读写唯一入口', members: ['butler-store'] },
  { id: 'butler-scheduler', label: '共享调度器：统一 tick 契约', members: ['butler-scheduler'] },
  { id: 'butler-tick-suite', label: '短命 tick 脚本族（P0/P2/P4/P6/P8）', members: ['butler-restart-coordinator', 'butler-watch', 'butler-pitfall', 'butler-external', 'butler-tidy'] },
  { id: 'butler-queue-suite', label: '队列/看板推进族', members: ['butler-queue', 'butler-board-cleanup'] },
  { id: 'butler-autonomy-suite', label: '自治闸门与自动动作族', members: ['butler-autonomy', 'butler-auto', 'butler-barewatch'] },
  { id: 'butler-audit-cli', label: '审计/写入守门 CLI 入口', members: ['butler-audit-cli'] },
];

/** 尚未纳入产品版本登记的既有组件。2026-10-09 批4-4 起**为空**（host/panel 已进 PLUGIN_COMPONENTS）。 */
export const PENDING_COMPONENTS = [];

/** 产品清单 ↔ 登记表 双向覆盖自检（漏一条或没归类都算红）。 */
export function rosterCoverage() {
  const listed = PRODUCT_ROSTER.flatMap((r) => r.members);
  const registered = Object.keys(MANAGED_COMPONENTS);
  const missing = listed.filter((n) => !registered.includes(n));
  const unlisted = registered.filter((n) => !listed.includes(n));
  const dup = listed.filter((n, i) => listed.indexOf(n) !== i);
  return { ok: missing.length === 0 && unlisted.length === 0 && dup.length === 0, rosterIds: PRODUCT_ROSTER.map((r) => r.id), rosterCount: PRODUCT_ROSTER.length, listed: listed.length, registered: registered.length, missing, unlisted, dup };
}

/** 插件实体根（按优先级）：**生产实体** → 仓库源目录兜底（隔离 home / 沙箱下实体不存在时）。 */
export function pluginEntityRoots(entity, opts = {}) {
  const home = opts.home ?? dshHome();
  return [
    { kind: 'entity', root: path.join(home, 'profiles', 'web', 'node_modules', entity) },
    { kind: 'source', root: path.join(opts.toolsRoot ?? process.env.BUTLER_TOOLS_ROOT ?? path.join(os.homedir(), 'dsh', 'tools'), entity) },
  ];
}

/**
 * 解析插件侧组件的**版本真值**（只读，永不抛）。
 * @returns {{ok:boolean, version:string|null, kind:'entity'|'source'|'fallback', file:string|null,
 *            declared:string|null, drift:boolean}}
 *   drift = 实体/源码真值 ≠ 代码声明值（fallback）⇒ 声明该跟了。
 */
export function resolvePluginComponentVersion(name, opts = {}) {
  const spec = PLUGIN_COMPONENTS[name];
  if (!spec) return { ok: false, version: null, kind: 'fallback', file: null, declared: null, drift: false };
  const declared = spec.fallback ?? null;
  for (const { kind, root } of pluginEntityRoots(spec.entity, opts)) {
    const file = path.join(root, spec.source.file);
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      let version = null;
      if (spec.source.kind === 'json-field') {
        version = JSON.parse(raw)?.[spec.source.field] ?? null;
      } else {
        const m = raw.match(new RegExp(`export\\s+const\\s+${spec.source.name}\\s*=\\s*['"]([^'"]+)['"]`));
        version = m ? m[1] : null;
      }
      if (typeof version === 'string' && version) {
        return { ok: true, version, kind, file, declared, drift: version !== declared };
      }
    } catch { /* 读不了 → 试下一个根 */ }
  }
  return { ok: false, version: declared, kind: 'fallback', file: null, declared, drift: false };
}

/** 读产品版本文件。 */
export function readProductVersion(opts = {}) {
  const file = butlerPaths(opts.home).versionFile;
  try {
    if (!fs.existsSync(file)) return { ok: false, file, error: 'missing' };
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { ok: false, file, error: 'empty' };
    const j = JSON.parse(raw);
    if (!j || typeof j.version !== 'string' || !j.version) return { ok: false, file, error: 'no-version' };
    return { ok: true, file, version: j.version, components: j.components ?? {}, product: j.product ?? PRODUCT, updatedAt: j.updatedAt ?? null };
  } catch (e) {
    return { ok: false, file, error: e?.message ?? String(e) };
  }
}

/** 写产品版本文件（部署 / 纳管刷新用；原子写，schemaVersion v1）。 */
export function writeProductVersion(opts = {}) {
  const home = opts.home ?? dshHome();
  const file = butlerPaths(home).versionFile;
  const data = {
    schemaVersion: 1,
    product: PRODUCT,
    version: opts.version ?? PRODUCT_VERSION,
    components: opts.components ?? { ...MANAGED_COMPONENTS },
    // 2026-10-09 批4-4：把「8 个组件是一个产品」的 8 条能力域一并落盘，供面板/报告直接读
    roster: opts.roster ?? PRODUCT_ROSTER.map((r) => ({ id: r.id, label: r.label, members: r.members })),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(file, data, {});
  return { ok: true, file, data };
}

/**
 * 组件启动自检：我的版本 ⊆ 产品版本？
 * @param {string} name 组件名
 * @param {string} myVersion 组件自报版本
 * @param {{home?:string}} [opts]
 * @returns {{ok:boolean, action:'run'|'skip'|'unmanaged', reason:string,
 *            productVersion?:string, myVersion?:string, file?:string}}
 */
export function checkComponent(name, myVersion, opts = {}) {
  const pv = readProductVersion(opts);
  if (!pv.ok) {
    return { ok: false, action: 'skip', reason: `product-version-${pv.error}`, file: pv.file, myVersion };
  }
  const registered = pv.components?.[name];
  if (registered === undefined) {
    // 未登记 = 产品版本还没纳管它（如既有 butler-panel 1.4.x）→ 不拦、不告警
    return { ok: true, action: 'unmanaged', reason: 'component-not-registered', productVersion: pv.version, myVersion, file: pv.file };
  }
  if (!myVersion) {
    return { ok: false, action: 'skip', reason: 'component-version-missing', productVersion: pv.version, myVersion, file: pv.file };
  }
  if (registered !== myVersion) {
    return { ok: false, action: 'skip', reason: 'version-mismatch', productVersion: pv.version, registered, myVersion, file: pv.file };
  }
  return { ok: true, action: 'run', reason: 'ok', productVersion: pv.version, myVersion, file: pv.file };
}

/**
 * 组件启动闸门：不通过 → 告警（独立通道）+ 返回 {run:false}。
 * 用法（每个组件的入口）：
 *   const gate = gateComponent('butler-store', VERSION);
 *   if (!gate.run) return gate;         // 跳过该组件，其余照常启动
 */
export function gateComponent(name, myVersion, opts = {}) {
  const r = checkComponent(name, myVersion, opts);
  if (r.action === 'skip') {
    const message = `组件 ${name} 版本不匹配（本地 ${myVersion ?? '?'} / 产品登记 ${r.registered ?? r.productVersion ?? '?'}），已跳过`;
    alert({ level: 'warn', source: `butler-version:${name}`, message, detail: r }, { home: opts.home });
    return { run: false, ...r, message };
  }
  return { run: true, ...r };
}

/**
 * 自检报告（verify / 部署后自检 / 面板读数用）：登记表 vs 产品版本文件。
 *
 * 2026-10-09 批4-4 起覆盖**全部纳管组件**（含插件侧 host/panel，此前它们 reading 恒为 unmanaged）：
 *   - 本仓库组件：拿 COMPONENT_VERSIONS 的声明值比；
 *   - 插件侧组件：读实体真值比（读不到回落声明值）⇒ `live` / `liveFrom` / `drift` 三个字段可读。
 * `unmanagedCount` 是本卡验收②的直接读数（目标 = 0）。
 */
export function selfCheck(opts = {}) {
  const pv = readProductVersion(opts);
  const rows = [];
  let ok = pv.ok;
  for (const [name, declared] of Object.entries(MANAGED_COMPONENTS)) {
    if (PLUGIN_COMPONENTS[name]) {
      const live = resolvePluginComponentVersion(name, opts);
      const myVersion = live.ok ? live.version : declared;
      const r = checkComponent(name, myVersion, opts);
      rows.push({ name, myVersion, declared, live: live.version, liveFrom: live.kind, liveFile: live.file, drift: live.drift, ...r });
      if (r.action === 'skip') ok = false;
      continue;
    }
    const r = checkComponent(name, declared, opts);
    rows.push({ name, myVersion: declared, declared, ...r });
    if (r.action === 'skip') ok = false;
  }
  const unmanagedCount = rows.filter((r) => r.action === 'unmanaged').length;
  const mismatchCount = rows.filter((r) => r.reason === 'version-mismatch').length;
  const roster = rosterCoverage();
  const pkgMatches = PRODUCT_VERSION === COMPONENT_VERSIONS['butler-store'];
  // 未纳管 / 产品清单漏项 ⇒ 不掩盖（本卡的目标态就是两者皆为 0）
  if (unmanagedCount > 0 || !roster.ok) ok = false;
  // 【gap-1-17 · 2026-10-10 卡「冲刺600·补核心库」】方案 §5.1 版本不匹配处置**第 4 步**：
  //   · **日报红项**：数据源 = 此处的 `redLines`（渲染侧统一读它，别各写一套判据）；
  //   · **告警**：只在不匹配时写（正常态零噪音），走独立通道 lib/alert.mjs（不依赖面板 / 日报）；
  //   · **降档联动**：只给**建议**、不自动执行（见 `suggestDegradeOnMismatch`）——自动降档 = 改自治行为，归the operator。
  const mismatchRows = rows.filter((r) => r.reason === 'version-mismatch');
  const redLines = mismatchRows.length
    ? [`🔴 组件版本不匹配 ${mismatchRows.length} 项：${mismatchRows.map((r) => `${r.name}（实体 ${r.myVersion} / 产品登记 ${r.registered}）`).join('；')}`]
    : [];
  if (redLines.length) {
    alert({
      level: 'error', source: 'butler-version:self-check',
      message: `组件版本不匹配 ${mismatchRows.length} 项（任一不匹配即日报红项）：${mismatchRows.map((r) => r.name).join(', ')}`,
      detail: { mismatch: mismatchRows.map((r) => ({ name: r.name, myVersion: r.myVersion, registered: r.registered })) },
    }, { home: opts.home });
  }
  return {
    ok: ok && pkgMatches,
    redLines,
    mismatchRows: mismatchRows.map((r) => ({ name: r.name, myVersion: r.myVersion, registered: r.registered, file: r.file ?? null })),
    productVersion: PRODUCT_VERSION,
    file: pv.file,
    productFileOk: pv.ok,
    productUpdatedAt: pv.updatedAt ?? null,
    managedCount: rows.length,
    unmanagedCount,
    mismatchCount,
    roster,
    rows,
  };
}

// ---------------------------------------------------------------- 版本不匹配处置第 4 步（gap-1-17）

/**
 * 「任一组件不匹配 ⇒ 日报红项」的**唯一数据源**（2026-10-10 · gap-1-17）。
 * 渲染侧（日报 / 面板 / 巡检）直接读 `lines`，**不要**各自再写一套判据（防两处口径漂移）。
 * 纯只读：内部只调 `selfCheck`（不写状态文件；不匹配时 selfCheck 会写一条独立通道告警）。
 * @param {{home?:string}} [opts]
 * @returns {{red:boolean, lines:string[], mismatchCount:number, unmanagedCount:number, ok:boolean}}
 */
export function versionRedLines(opts = {}) {
  const sc = selfCheck(opts);
  return {
    red: sc.redLines.length > 0,
    lines: sc.redLines,
    mismatchCount: sc.mismatchCount,
    unmanagedCount: sc.unmanagedCount,
    ok: sc.ok,
  };
}

/**
 * 「组件不匹配 ⇒ 是否该联动 L0 降档」的**建议**（gap-1-17 · **只给建议，绝不自动执行**）。
 *
 * 为什么不在本模块自动降档：降档会改**自治行为**（L0 降档期一切自动动作转通知），属the operator口径；
 * 且 `lib/version.mjs` 是低层模块，反向 import `lib/autonomy-state.mjs` 会造成环依赖。
 * 调用方（人 / 上游链路）拿到 `suggested` 后自行决定是否 `degrade()`。
 * @param {{home?:string}} [opts]
 * @returns {{suggested:boolean, level:'degraded'|null, why:string, components:string[]}}
 */
export function suggestDegradeOnMismatch(opts = {}) {
  const sc = selfCheck(opts);
  const mismatch = sc.mismatchCount > 0;
  return {
    suggested: mismatch,
    level: mismatch ? 'degraded' : null,
    why: mismatch
      ? `组件版本不匹配 ${sc.mismatchCount} 项（${sc.mismatchRows.map((r) => r.name).join(', ')}）：产品版本登记与实体不一致 ⇒ 建议联动 L0 降档（lib/autonomy-state.mjs#degrade）。本函数只给建议、不自动执行。`
      : '无版本不匹配：无需降档联动',
    components: sc.mismatchRows.map((r) => r.name),
  };
}
