// 2c · 状态文件路径解析层（S1 生产版 · 零调用点 ⇒ 运行时行为零变化）
// 设计真源：docs/ §3.2 / §3.3
//
// ⚠️ 与夹具版（docs/）的唯一区别 = 硬闸口径：
//   夹具版：FIXTURE_ROOT 硬闸，只许落在夹具树内；
//   生产版：**不限制**目标目录，但「解析后等于真实 ~/.dsh」必须显式 --allow-production，
//           否则调用方（CLI 入口）以 rc=2 拒跑。闸函数 `assertProductionHome`。
//   ⇒ 两者不可混用（方案 §6 脚本红线）。
//
// S1 边界：本文件**没有调用点**。库函数里只有 writeMode() 会写盘，S1/S2 无调用点；
//          读侧函数（resolveStatePath / readMode / inferMode）只读 home。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInfra, isKeepLegacy } from './state-exceptions.mjs';

export const NEW_PREFIX = 'ops-';
export const MIGRATION_META = 'ops-state-migration.json';

/** 状态文件根（与生产 dshHome() 同优先级）：BUTLER_DSH_HOME > DSH_HOME > ~/.dsh。 */
export function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}

/** 真实生产 home（不受 env 影响）—— 闸的对照物。 */
export function productionHome() {
  return path.join(os.homedir(), '.dsh');
}

/**
 * 路径归一（方案 §3.4 生产闸 I-6）：realpath（不存在则 resolve）→ 绝对 → 小写 → 去尾分隔符。
 * @returns {{abs:string, norm:string}} abs = 归一后的真实绝对路径（保留大小写），norm = 比较用
 */
export function normalizeHomePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new TypeError('home 必须是非空字符串');
  let abs = path.resolve(p.trim());
  try { abs = fs.realpathSync.native(abs); } catch { try { abs = fs.realpathSync(abs); } catch { /* 不存在时用 resolve 结果 */ } }
  abs = path.resolve(abs);
  return { abs, norm: abs.toLowerCase().replace(/[\\/]+$/, '') };
}

/** 一个路径的两种形态（resolved 与 realpath），各自归一 —— 「双侧归一」。 */
function homeVariants(p) {
  const out = new Set();
  try { out.add(normalizeHomePath(p).norm); } catch { /* ignore */ }
  try { out.add(normalizeHomePath(path.resolve(p)).norm); } catch { /* ignore */ }
  try { out.add(normalizeHomePath(fs.realpathSync.native(p)).norm); } catch { /* ignore */ }
  try { out.add(normalizeHomePath(fs.realpathSync(p)).norm); } catch { /* ignore */ }
  return out;
}

/**
 * 是否指向真实生产 ~/.dsh（junction / 8.3 短名 / 大小写 / 尾分隔符 都归一后再比）。
 * 判据 = 任一形态相等，防止「换一种写法绕过闸」。
 */
export function isProductionHome(home) {
  const target = homeVariants(home);
  const real = homeVariants(productionHome());
  for (const x of target) if (real.has(x)) return true;
  return false;
}

/**
 * 生产闸：解析后的 home 等于真实 ~/.dsh ⇒ 必须带 --allow-production，否则 rc=2。
 * **本函数不退出进程**（禁 process.exit）：CLI 入口拿到 ok=false 后自行 process.exitCode = 2。
 * 诊断一律走 stderr（--json 时 stdout 只许 JSON）。
 * @returns {{ok:boolean, rc:number, resolved:string, realHome:string, production:boolean}}
 */
export function assertProductionHome(home, opts = {}) {
  const { allowProduction = false, label = 'home', entry = 'state-paths' } = opts;
  const resolved = path.resolve(String(home ?? '').trim() || dshHome());
  const realHome = normalizeHomePath(productionHome()).abs;
  const production = isProductionHome(resolved);
  if (production && !allowProduction) {
    console.error(`[REFUSE] ${entry}: ${label} 解析到生产 ~/.dsh（${resolved}）`);
    console.error(`[REFUSE] 真实 home（realpath，归一后）= ${realHome}`);
    console.error('[REFUSE] 生产路径必须显式带 --allow-production（rc=2）');
    return { ok: false, rc: 2, resolved, realHome, production: true };
  }
  if (production) {
    console.error(`[ALLOW] ${entry}: 已带 --allow-production，目标 = 生产 ~/.dsh（${resolved}）`);
  }
  return { ok: true, rc: 0, resolved, realHome, production };
}

export const MODE_RANK = Object.freeze({ legacy: 0, dual: 1, new: 2 });
const MODES = ['legacy', 'dual', 'new'];
const normalizeMode = (m) => (MODES.includes(m) ? m : null);

function readRawMeta(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, MIGRATION_META), 'utf8')) || {}; } catch { return {}; }
}
export const readMeta = readRawMeta;

/**
 * 无元数据时的模式推断（换机 / 备份恢复 / 元数据被清）：
 *   只有 ops-*      ⇒ new
 *   两边都有        ⇒ dual（双写最安全，绝不丢任何一个名字）
 *   只有 butler-*   ⇒ legacy
 * 兜底永远不是"无条件 legacy"——R-3 的修法（状态写冻结的根因就是默认回退）。
 * I-1：排掉迁移/回滚基础设施 + 必须保留旧名的白名单条目。
 */
export function inferMode(home) {
  try {
    const names = fs.readdirSync(home).filter((n) => !isInfra(n) && !isKeepLegacy(n));
    const hasNew = names.some((n) => n.startsWith(NEW_PREFIX));
    const hasOld = names.some((n) => n.startsWith('butler-'));
    if (hasNew && !hasOld) return 'new';
    if (hasNew && hasOld) return 'dual';
    return 'legacy';
  } catch (e) {
    // B-3：绝不静默 —— 这里曾把 ReferenceError 吞掉，让 inferMode 恒返 legacy（假绿根因）
    // 【0.1.0】唯一豁免：ENOENT（状态根还不存在 = 全新机器 / 首次运行）是**正当情形**，
    //   此时按 legacy 兜底且不报噪声；其它错误（权限 / 路径非法 / 扫到一半被删）照旧 LOUD。
    if (e?.code !== 'ENOENT') console.error(`[LOUD] inferMode 失败（按 legacy 兜底）：${e?.message ?? e}`);
    return 'legacy';
  }
}

/**
 * 模式读取（单调高水位，R-3）：
 *   env DSH_STATE_MODE > 元数据 mode（与 floor 取高者）> 元数据 floor > inferMode > legacy
 * 显式 mode 低于 floor ⇒ 不静默降档：打 loud 告警并用 floor（降档只能由回滚器写 floor）。
 */
export function readMode(home) {
  const meta = readRawMeta(home);
  const floor = normalizeMode(meta.floor) || 'legacy';
  const env = normalizeMode(process.env.DSH_STATE_MODE);
  if (env) {
    if (MODE_RANK[env] < MODE_RANK[floor]) {
      console.error(`[LOUD] env DSH_STATE_MODE=${env} 低于 floor=${floor}，拒绝降档，按 ${floor} 执行`);
      return floor;
    }
    return env;
  }
  const m = normalizeMode(meta.mode);
  if (m) {
    if (MODE_RANK[m] < MODE_RANK[floor]) {
      console.error(`[LOUD] 模式降档被拒绝：mode=${m} < floor=${floor}（如确需回滚，请走 rollback 脚本显式降档）`);
      return floor;
    }
    return m;
  }
  if (meta.floor) return floor;
  return inferMode(home);
}

/**
 * 写模式元数据。floor 单调只升；只有显式 __allowDowngrade=true（回滚器专用）才降。
 * ⚠️ 唯一会写盘的函数；S1/S2 不应有调用点（模式由 set-state-mode.mjs 升）。
 */
export function writeMode(home, mode, extra = {}) {
  const f = path.join(home, MIGRATION_META);
  const cur = readRawMeta(home);
  const allowDowngrade = extra.__allowDowngrade === true;
  const prevFloor = normalizeMode(cur.floor) || 'legacy';
  const nextFloor = allowDowngrade
    ? mode
    : (MODE_RANK[mode] > MODE_RANK[prevFloor] ? mode : prevFloor);
  const payload = { ...cur, ...extra, mode, floor: nextFloor, updatedAt: new Date().toISOString() };
  delete payload.__allowDowngrade;
  fs.writeFileSync(f, JSON.stringify(payload, null, 1), 'utf8');
}

export function toNewName(name) {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith(NEW_PREFIX)) return n;
  return n.startsWith('butler-') ? NEW_PREFIX + n.slice('butler-'.length) : n;
}

export function toLegacyName(name) {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('butler-')) return n;
  return n.startsWith(NEW_PREFIX) ? 'butler-' + n.slice(NEW_PREFIX.length) : n;
}

function statOrNull(p) { try { return fs.statSync(p); } catch { return null; } }

/**
 * 入参断言（I-3）：只接受"相对名"（允许 `butler-locks/tick.lock` 这类一级子路径）。
 * 拒绝绝对路径 / 盘符 / `..` —— 调用点若传已 join 的绝对路径，toNewName 会原样返回 ⇒ 静默不迁移。
 */
export function assertStateName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('resolveStatePath: name 必须是非空字符串');
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) throw new TypeError(`resolveStatePath: 拒绝绝对路径 "${name}"（应传相对名）`);
  if (name.split(/[\\/]/).includes('..')) throw new TypeError(`resolveStatePath: 拒绝含 ".." 的路径 "${name}"`);
  return name.replace(/\\/g, '/');
}

/**
 * 解析状态文件路径（方案 §3.2 行为表）。
 * 读：new 存在 → new；否则 legacy 存在 → legacy；都无 → 按 mode 决定返回哪个（写路径）。
 * 两边都有 → 取 mtime 新者（同毫秒按新名优先），并返回 conflict=true（调用方记告警）。
 * @returns {{path:string, source:'new'|'legacy'|'missing', conflict:boolean, mtimeMs:number|null, newPath:string, legacyPath:string, mode:string}}
 */
export function resolveStatePath(name, opts = {}) {
  const home = opts.home ?? dshHome();
  const mode = opts.mode ?? readMode(home);
  const safeName = assertStateName(name);
  const nNew = toNewName(safeName);
  const nOld = toLegacyName(safeName);
  const pNew = path.join(home, nNew);
  const pOld = path.join(home, nOld);
  const sNew = statOrNull(pNew);
  const sOld = statOrNull(pOld);
  let chosen; let source; let conflict = false;
  if (sNew && sOld) {
    conflict = true;
    if (sNew.mtimeMs >= sOld.mtimeMs) { chosen = pNew; source = 'new'; }
    else { chosen = pOld; source = 'legacy'; }
  } else if (sNew) { chosen = pNew; source = 'new'; }
  else if (sOld) { chosen = pOld; source = 'legacy'; }
  else {
    // 都不存在：写路径由 mode 决定（legacy 期仍写旧名，与今天行为等价）
    chosen = mode === 'legacy' ? pOld : pNew;
    source = 'missing';
  }
  return { path: chosen, source, conflict, mtimeMs: (source === 'new' ? sNew : source === 'legacy' ? sOld : null)?.mtimeMs ?? null, newPath: pNew, legacyPath: pOld, mode };
}

/** 写目标（双写期返回两个路径）。写动作由 dual-write.mjs 负责，本函数只算路径。 */
export function writeTargets(name, opts = {}) {
  const home = opts.home ?? dshHome();
  const mode = opts.mode ?? readMode(home);
  const safeName = assertStateName(name);
  const pNew = path.join(home, toNewName(safeName));
  const pOld = path.join(home, toLegacyName(safeName));
  if (mode === 'legacy') return { mode, primary: pOld, mirrors: [] };
  if (mode === 'dual') return { mode, primary: pNew, mirrors: [pOld] };
  return { mode, primary: pNew, mirrors: [] };
}
