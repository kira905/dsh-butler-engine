// dsh-butler / lib/ledger-write.mjs —— 看板账本**直写**工具（⚠️ 仅测试/隔离用，**已退出生产链路**）
//
// ❗ 2026-09-13（卡 S5·[6a-实施] · 主人拍板 P3-②）：本模块**不再是看板账本的写入口**。
//   原因（docs\P3写账本路线对齐-20260911.md §1.2）：账本由 Host 权威持有——Host 进程内存里有一份
//   document，每次 action 末尾**整份 commit 覆写文件**（`host-ledger.ts:584` / `repairSchedules` 亦自行
//   commit）⇒ 任何在两次 Host 动作之间直写文件的改动，会被下一次 Host 动作**静默覆盖**（无报错、无日志）。
//   P3 的生产写路径 = **Host API 调用序列**（`lib\ledger-api.mjs` 的 `applySequence`）。
//
// 保留本文件的原因：**隔离测试 / 离线夹具 / 历史恢复脚本**仍需要一个"在临时 home 里造一份账本、
//   直接落盘"的工具（`_test\test-*.mjs` 用它制备夹具与做直写版对照）。生产路径**零引用**——
//   由 `_test\test-auto.mjs` 的「零直写断言」守着（grep 生产文件不得 import 本模块的写函数）。
//
// 注意：`readLedger()` 只是"读文件"，生产只读场景请优先走 `lib\ledger-api.mjs` 的 `readState()`
//   （Host 权威态）；文件读只作为 Host 不在线时的 fail-soft 兜底（见 butler-auto-tick.readBoardSoft）。
//
// 原实现说明（保留，供隔离使用参考）：
//   ① 账本是 task-board 插件的活文件（Host 进程也在写）→ 必须走 butler-store 的 RMW 锁 + 原子写，
//      绝不能裸 fs.writeFileSync（会把 Host 刚写的改动冲掉）。
//   ② P3 的 L1/L2 动作都要「先备份 → 再写 → 记审计（含回滚数据）」三步不可拆。
//   ③ **schemaVersion 不传**：账本有自己的 revision 字段与不变式（task-board 的 invariant.js），
//      我们只做最小 patch（description / schedule）+ revision+1，绝不重写整份结构。
import fs from 'node:fs';
import path from 'node:path';

import { readJson, updateJson } from '../../src/dsh-butler/lib/store.mjs';
import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';

export const LEDGER_WRITE_VERSION = '0.2.0';

/** ⚠️ 生产路径禁用标记（供"零直写断言"与代码审查用；生产模块不得引用本模块的写函数）。 */
export const ISOLATION_ONLY = true;

/** 账本默认位置（可被 --ledger 覆盖，用于隔离验证）。 */
export function defaultLedgerPath(opts = {}) {
  return opts.ledgerFile ?? path.join(opts.home ?? dshHome(), 'task-board', 'ledger-v2.json');
}

/**
 * 只读快照（dry-run 用）。**不走 store 的 schema 校验**（账本 schemaVersion 由插件管）。
 * @returns {{ok:boolean, file:string, ledger:object|null, revision:number|null, error?:string}}
 */
export function readLedger(ledgerFile) {
  try {
    if (!ledgerFile || !fs.existsSync(ledgerFile)) return { ok: false, file: ledgerFile ?? '', ledger: null, revision: null, error: 'ledger-missing' };
    const ledger = readJson(ledgerFile, { audit: false });
    return { ok: true, file: ledgerFile, ledger, revision: Number(ledger?.revision ?? 0) };
  } catch (e) {
    return { ok: false, file: ledgerFile ?? '', ledger: null, revision: null, error: e?.message ?? String(e) };
  }
}

/**
 * 备份账本到指定目录（L1 也强制留一份 —— 方案「可逆」的最小保障）。
 * @returns {{ok:boolean, backup?:string, bytes?:number, error?:string}}
 */
export function backupLedger(ledgerFile, backupDir) {
  try {
    if (!fs.existsSync(ledgerFile)) return { ok: false, error: 'ledger-missing' };
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupDir, `ledger-v2.${stamp}.bak.json`);
    fs.copyFileSync(ledgerFile, dest);
    const st = fs.statSync(dest);
    return { ok: true, backup: dest, bytes: st.size };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * 读-改-写账本（⚠️ **仅测试/隔离用**；生产写路径 = lib/ledger-api.mjs）。
 * @param {string} ledgerFile
 * @param {(ledger:object)=>(object|undefined)} fn
 * @param {{home?:string, backupDir?:string, now?:number, lockTtlMs?:number, lockWaitMs?:number}} [opts]
 * @returns {{ok:boolean, changed:boolean, revision:number|null, backup:string|null, error?:string}}
 */
export function writeLedger(ledgerFile, fn, opts = {}) {
  let backup = null;
  if (opts.backupDir) {
    const b = backupLedger(ledgerFile, opts.backupDir);
    if (!b.ok) return { ok: false, changed: false, revision: null, backup: null, error: `备份失败，拒绝写入：${b.error}` };
    backup = b.backup;
  }
  try {
    const next = updateJson(ledgerFile, (cur) => {
      const out = fn(cur);
      if (out === undefined) return undefined; // 只读事务
      return {
        ...out,
        revision: Number(cur?.revision ?? 0) + 1,
        updatedAt: opts.now ?? Date.now(),
      };
    }, {
      home: opts.home ?? dshHome(),
      lockTtlMs: opts.lockTtlMs ?? 15_000,
      lockWaitMs: opts.lockWaitMs ?? 8_000,
      audit: false, // 审计走管家自己的 butler-audit（lib/audit.mjs）
    });
    return { ok: true, changed: true, revision: Number(next?.revision ?? 0), backup };
  } catch (e) {
    return { ok: false, changed: false, revision: null, backup, error: e?.message ?? String(e) };
  }
}

/**
 * writer 工厂（⚠️ **仅测试/隔离用**）。
 * 2026-09-13 起 `lib\dup-cards.applyDuplicateMerge` 已改为「Host API 动作序列」（`apply` 执行器契约），
 * 不再消费 `writer(fn)`；本工厂保留给隔离测试自己做直写版对照/造夹具。
 * @param {string} ledgerFile
 * @param {{home?:string, backupDir?:string, now?:number}} [opts]
 */
export function makeLedgerWriter(ledgerFile, opts = {}) {
  const calls = [];
  const writer = (fn) => {
    let changedCount = 0;
    const r = writeLedger(ledgerFile, (cur) => {
      // 先拍快照（**必须在 fn 之前**：fn 会原地改写 tasks 元素，事后快照会失真）
      const before = new Map((cur?.tasks ?? []).map((c) => [String(c.id), { ...c }]));
      const out = fn(cur);
      if (out && Array.isArray(out.tasks)) {
        for (const c of out.tasks) {
          const prev = before.get(String(c.id));
          if (!prev) { changedCount++; continue; }
          if (prev.description !== c.description
            || (prev.schedule ?? null) !== (c.schedule ?? null)
            || prev.status !== c.status
            || prev.title !== c.title
            || prev.prompt !== c.prompt) changedCount++;
        }
      }
      return out;
    }, opts);
    calls.push({ ...r, changedCount });
    return { ...r, changed: r.ok && changedCount > 0, changedCount, calls: calls.length };
  };
  writer.calls = calls;
  /** 只读快照（隔离夹具预判用）。 */
  writer.readLedger = () => readLedger(ledgerFile).ledger;
  return writer;
}
