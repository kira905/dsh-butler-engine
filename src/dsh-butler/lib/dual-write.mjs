// 双写器（I-5）：dual 期唯一写入口。三条铁律：
//   ① **序列化一次**，同一份字节写两个名字（禁止两次独立 JSON.stringify —— 时间戳/键序会让两名字节不同）；
//   ② 每次写都原子（同目录 temp + rename）；
//   ③ 失败必须记账：新名失败 ⇒ dualWriteStale（新名落后，S4 前要对账）；旧名失败 ⇒ dualWritePartial。
//
// 【2c-B8-A 扩展 · 2026-10-19】照真源设计 `docs/` §3 实现，只加三个入口：
//   · writeState(name, data, { stringify?, write? })  —— 只加注入，**默认路径逐字节不变**；
//   · writeStateText(name, text, { write? })          —— B 层：text 是入参 ⇒ 结构上禁止两次序列化（I-3）；
//   · appendStateText(name, text, { write?, seed? })  —— C 层：先种子拷贝、再双 append（旧历史不许丢）。
//   ⚠️ 本卡**不接线任何调用点**（接线属 B8-1..4）；生产 mode 仍 legacy，`dual-write.mjs` 现役 import = 0。
//
// 口径（读者别猜）：
//   · `once` = 「**去重后只有 1 个写目标**」这个事实：legacy 期恒 true；dual 期只有「非 `butler-` 前缀名」
//     （`toNewName` 恒等 ⇒ primary === 旧名路径）才 true。它**不是**「名字恒等」的专用标记。
//   · 种子拷贝只在 `mode !== 'legacy' && !once && opts.seed !== 'none'` 时做（`new` 期整份拷贝归 S4）。
//   · 种子失败 ⇒ **绝不产生半份新名**：只 append 旧名 + 记 `dualWriteStale` + `seedFailed` + `ok:false`。
//   · 审计（`ops-state-write-audit.jsonl`）**只在失败时**追加：正常写不落审计，避免流水爆炸。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, readMode, toLegacyName, toNewName, writeTargets } from './state-paths.mjs';

export const WRITE_AUDIT = 'ops-state-write-audit.jsonl';

const errMsg = (e) => (e?.message ?? String(e));
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const defaultStringify = (d) => JSON.stringify(d, null, 1);   // 现行为：1 空格、无尾换行

/** 极简原子写（现役默认写器，行为不变）；`opts.fsync === true` 时才额外 fsync（默认关）。 */
function atomicWriteText(p, text, opts = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  if (opts.fsync === true) {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } else {
    fs.writeFileSync(tmp, text, 'utf8');
  }
  try { fs.renameSync(tmp, p); } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}

function appendAudit(home, rec) {
  fs.appendFileSync(path.join(home, WRITE_AUDIT), JSON.stringify(rec) + '\n', 'utf8');
}

/** I-7 三态：新名失败 ⇒ stale（新名落后）/ 旧名失败 ⇒ partial（旧名落后）/ 两侧都失败 ⇒ failed。 */
function kindOf(failures) {
  const primaryFailed = failures.some((f) => f.role === 'primary');
  const mirrorFailed = failures.some((f) => f.role === 'mirror');
  if (primaryFailed && mirrorFailed) return 'dualWriteFailed';
  return primaryFailed ? 'dualWriteStale' : 'dualWritePartial';
}

/**
 * 算写目标（含去重）：`toNewName` 对非 `butler-` 前缀是恒等 ⇒ primary 与旧名同路径 ⇒ 只写一次。
 * @returns {{home:string, mode:string, primary:string, mirrors:string[], once:boolean, targets:string[]}}
 */
function planTargets(name, opts = {}) {
  const home = opts.home ?? dshHome();
  const mode = opts.mode ?? readMode(home);
  const { primary, mirrors } = writeTargets(name, { home, mode });
  const targets = [primary, ...mirrors].filter((p, i, a) => a.indexOf(p) === i);
  return { home, mode, primary: targets[0], mirrors: targets.slice(1), once: targets.length === 1, targets };
}

/**
 * 写一个 JSON 状态（A 层：1 空格 / 无尾换行，**现行为**）。
 * @param {{home?:string, mode?:string, stringify?:(data:any)=>string, write?:(p:string,t:string)=>void, fsync?:boolean, audit?:boolean}} [opts]
 * @returns {{ok:boolean, kind?:string, name:string, mode:string, primary:string, mirrors:string[], failures:object[], text:string, home:string}}
 */
export function writeState(name, data, opts = {}) {
  const home = opts.home ?? dshHome();
  const mode = opts.mode ?? readMode(home);
  const { primary, mirrors } = writeTargets(name, { home, mode });
  const stringify = opts.stringify ?? defaultStringify;
  const write = opts.write ?? ((p, t) => atomicWriteText(p, t, opts));
  const text = stringify(data);                    // ← 只序列化一次
  const failures = [];
  try { write(primary, text); }
  catch (e) { failures.push({ role: 'primary', path: primary, error: errMsg(e) }); }
  for (const m of mirrors) {
    try { write(m, text); }
    catch (e) { failures.push({ role: 'mirror', path: m, error: errMsg(e) }); }
  }
  const out = { ok: failures.length === 0, name, mode, primary, mirrors, failures, text, home };
  if (failures.length) {
    out.kind = kindOf(failures);
    if (opts.audit !== false) appendAudit(home, { ts: new Date().toISOString(), kind: out.kind, name, mode, failures });
  }
  return out;
}

/**
 * 写一份**已序列化**的文本到该状态名的全部目标（B 层主用）。
 * 序列化与原子写都留在调用方：`text` 是入参 ⇒ 结构上不可能两次序列化（I-3）；
 * 生产调用方传 `write: (p, t) => writeTextAtomic(p, t, {...})`（保留 fsync / 破坏性闸 / 重试）。
 * @returns {{ok:boolean, kind?:string, name:string, mode:string, primary:string, mirrors:string[], failures:object[], once:boolean, bytes:number, home:string}}
 */
export function writeStateText(name, text, opts = {}) {
  if (typeof text !== 'string') throw new TypeError('writeStateText: text 必须是已序列化字符串（本函数不做序列化，I-3）');
  const { home, mode, primary, mirrors, once, targets } = planTargets(name, opts);
  const write = opts.write ?? ((p, t) => atomicWriteText(p, t, opts));
  const bytes = Buffer.byteLength(text, 'utf8');
  const failures = [];
  for (let i = 0; i < targets.length; i++) {
    try { write(targets[i], text); }
    catch (e) { failures.push({ role: i === 0 ? 'primary' : 'mirror', path: targets[i], error: errMsg(e) }); }
  }
  const out = { ok: failures.length === 0, name, mode, primary, mirrors, failures, once, bytes, home };
  if (failures.length) {
    out.kind = kindOf(failures);
    if (opts.audit !== false) appendAudit(home, { ts: new Date().toISOString(), kind: out.kind, name, mode, failures });
  }
  return out;
}

/**
 * 追加一份**已序列化**的文本（C 层主用）：先种子拷贝、再「先新名(primary) 后旧名(mirror)」双 append。
 *
 * 种子拷贝（只在 `mode !== 'legacy' && !once && opts.seed !== 'none'`）：新名不存在 && 旧名存在 时，
 *   读旧名整份 → 写 `新名.seed-<pid>` → **复核新名仍不存在** → `renameSync` 原子就位；别人已种过 ⇒ 丢弃 tmp。
 *   种子失败 ⇒ 只 append 旧名 + `dualWriteStale` + `seedFailed` + `ok:false`（新名一个字节都不写）。
 * @param {{home?:string, mode?:string, write?:(p:string,t:string)=>void, seed?:'copy-legacy'|'none', audit?:boolean}} [opts]
 * @returns {{ok:boolean, kind?:string, name:string, mode:string, primary:string, mirrors:string[], failures:object[], seeded:boolean, once:boolean, bytes:number, home:string}}
 */
export function appendStateText(name, text, opts = {}) {
  if (typeof text !== 'string') throw new TypeError('appendStateText: text 必须是已序列化字符串（本函数不做序列化，I-3）');
  const { home, mode, primary, mirrors, once, targets } = planTargets(name, opts);
  const doWrite = opts.write ?? ((p, t) => fs.appendFileSync(p, t, 'utf8'));
  const bytes = Buffer.byteLength(text, 'utf8');
  const failures = [];
  let seeded = false;

  if (mode !== 'legacy' && !once && opts.seed !== 'none') {
    const pNew = path.join(home, toNewName(name));
    const pOld = path.join(home, toLegacyName(name));
    if (!exists(pNew) && exists(pOld)) {
      try {
        const legacyBytes = fs.readFileSync(pOld);          // 整份旧历史（Buffer ⇒ 逐字节保真）
        fs.mkdirSync(path.dirname(pNew), { recursive: true });
        const tmpSeed = pNew + '.seed-' + process.pid;
        fs.writeFileSync(tmpSeed, legacyBytes);             // ① 先写 tmp（半份只可能落在 tmp 上）
        if (exists(pNew)) {
          try { fs.unlinkSync(tmpSeed); } catch { /* 别人已种过，丢弃 tmp */ }
        } else {
          fs.renameSync(tmpSeed, pNew);                     // ② 复核后原子就位 ⇒ 种子要么没有、要么是整份
          seeded = true;
        }
      } catch (e) {
        // 🔴 种子失败 ⇒ 绝不写半份新名：只 append 旧名 + 记 stale + seedFailed
        try { doWrite(pOld, text); } catch (e2) { failures.push({ role: 'primary', path: pOld, error: errMsg(e2) }); }
        const kind = failures.length ? 'dualWriteFailed' : 'dualWriteStale';
        if (opts.audit !== false) {
          appendAudit(home, { ts: new Date().toISOString(), kind, name, mode, seedFailed: errMsg(e), failures });
        }
        return { ok: false, kind, name, mode, primary: pOld, mirrors: [], failures, seeded: false, once, bytes, home };
      }
    }
  }

  for (let i = 0; i < targets.length; i++) {
    try { doWrite(targets[i], text); }
    catch (e) { failures.push({ role: i === 0 ? 'primary' : 'mirror', path: targets[i], error: errMsg(e) }); }
  }
  const out = { ok: failures.length === 0, name, mode, primary, mirrors, failures, seeded, once, bytes, home };
  if (failures.length) {
    out.kind = kindOf(failures);
    if (opts.audit !== false) appendAudit(home, { ts: new Date().toISOString(), kind: out.kind, name, mode, failures });
  }
  return out;
}
