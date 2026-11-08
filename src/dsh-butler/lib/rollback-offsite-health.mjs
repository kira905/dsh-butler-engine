// dsh-butler / lib/rollback-offsite-health.mjs —— 回滚点异地化：状态、失败可见性、日报段（单一判定口径）
//
// 来源：《自愈与回滚-验收缺口与整改方案-20260911》§3.3（D5=A 冷盘存数据 + 仓3 只存脚本/manifest）
//   + §3.3「盘不在线的降级分支（T18 硬要求）：盘不可达 → **不静默**：写状态 + 当日日报段标记 +
//     **连续失败 3 次升级告警**（沿用 imagegen 冷备「退出码 3 + tickd 健康段」先例）」
//   + §5 验收 3「从冷盘快照独立复原一个回滚点，真的回滚成功一次；盘不在线时必须显式报警而非静默」。
//
// 为什么单独一个 lib：判级别 / 文案 / 阈值必须**只有一处**——打包器（写状态）、日报段、CLI、单测
//   全都读这一份，避免「脚本说成功、日报说没事、其实一周没写进去」这类静默失败（照 tickd-health.mjs 先例）。
//
// 只读纪律：本模块的 judge/dailySectionLines **不写任何文件**；只有 recordRun/writeState 写状态文件，
//   且只写本机状态（`~/.dsh/rollback-offsite-<host>.json`，带 host 短码 —— 两台机各存一份、互不覆盖）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostTag } from './host-tag.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../lib/production-guard.mjs';

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


export const ROLLBACK_OFFSITE_HEALTH_VERSION = '0.1.0';

/** 连续失败升级门槛（方案 §3.3 T18 写死的数字）。 */
export const ESCALATE_AFTER_FAILURES = 3;
/** 连续失败到该数即 🔴（与升级门槛同值，但语义分开写，便于将来只调一处）。 */
export const RED_AFTER_FAILURES = 3;
/** 「久未成功」门槛：超过这几天没有一次成功 = 调度可能停摆（只报黄，不当作失败）。 */
export const STALE_SUCCESS_DAYS = 8;
/** 状态里保留的最近运行记录条数。 */
export const HISTORY_KEEP = 20;
export const LEVEL_ICON = { green: '✅', yellow: '⚠️', red: '🔴', unknown: '❔', info: '⚪' };

/** DSH 数据根（与 imagegen-backup.mjs 同口径：BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）。 */
export function dshHome(env = process.env) {
  return env.BUTLER_DSH_HOME || env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 本机状态文件（带 host 短码；**不在仓1 白名单内**，跨机天然互不覆盖）。 */
export function stateFilePath(opts = {}) {
  if (opts.file) return opts.file;
  const env = opts.env ?? process.env;
  const tag = hostTag({ host: opts.host });
  return path.join(opts.home ?? dshHome(env), `rollback-offsite-${tag}.json`);
}

/** 升级告警流水（append-only，给人看的一行一条；失败也能落痕，不受 DSH 是否在跑影响）。 */
export function alertLogPath(opts = {}) {
  const root = opts.dshRoot ?? process.env.DSH_WORKSPACE ?? path.join(os.homedir(), 'DSH');
  return opts.alertLog ?? path.join(root, 'logs', 'rollback-offsite-alert.log');
}

/** 读状态（只读，坏文件不抛）。 */
export function readState(opts = {}) {
  const file = stateFilePath(opts);
  try {
    return { ok: true, file, state: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, file, state: null, error: String(e?.message ?? e) };
  }
}

/**
 * 原子写 JSON。
 * ⚠️ Windows 上 `renameSync` 可能被杀软/索引短暂占用而失败（实测偶发）→ 重试 3 次；
 *   最终仍失败**抛给调用方**（绝不在这里静默吞掉，否则"没记上"比没跑还危险）。
 */
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(obj, null, 1);
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    const tmp = `${file}.${process.pid}.${i}.tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      const gr = renameGuarded(tmp, file, { whitelist: [path.dirname(file)], reason: '写异地回滚健康状态' });
      if (!gr.ok) throw new Error(gr.reason);
      return;
    } catch (e) {
      lastErr = e;
      try { removeGuarded(tmp, { whitelist: [path.dirname(file)], reason: '写失败回收 tmp' }) } catch { /* ignore */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30) } catch { /* 小睡 30ms */ }
    }
  }
  throw lastErr ?? new Error('atomicWriteJson failed');
}

/**
 * 记一次运行结果并落状态（打包器唯一写入口）。
 * `keep`（可选，2026-09-20 卡 ③-3.3）= keep 段（`_archive\handoff-keep` 凭据保留区）的异地化统计：
 *   `{ at, status:'ok'|'skipped'|'failed'|'partial', points, packed, unchanged, empty, failed, bytes, dir, reason }`
 *   状态里落 `keep`（最近一轮）与 `keepLastSuccessAt`（该段自己的最近成功时间，日报「🧊」段要显示）。
 * @param {{status:'ok'|'drive-unavailable'|'error'|'partial', reason?:string|null, now?:number,
 *          host?:string, home?:string, env?:object, file?:string, alertLog?:string,
 *          root?:string, rootSource?:string, stats?:object, keep?:object|null, dryRun?:boolean}} run
 * @returns {object} 新状态
 */
export function recordRun(run = {}) {
  const opts = { host: run.host, home: run.home, env: run.env, file: run.file };
  const prev = readState(opts).state ?? {};
  const now = run.now ?? Date.now();
  const at = new Date(now).toISOString();
  const failed = run.status !== 'ok' && run.status !== 'partial';
  const consecutiveFailures = failed ? Number(prev.consecutiveFailures ?? 0) + 1 : 0;
  const history = Array.isArray(prev.history) ? prev.history.slice(-(HISTORY_KEEP - 1)) : [];
  history.push({ at, status: run.status, reason: run.reason ? String(run.reason).slice(0, 400) : null });

  // keep 段（凭据保留区异地化）统计：本轮给了就用本轮的；没给（如只跑回滚点段）沿用上一轮，**不虚构**
  const keep = (run.keep && typeof run.keep === 'object') ? run.keep : (prev.keep ?? null);
  const keepOk = keep?.status === 'ok';

  const next = {
    ...prev,
    schemaVersion: 1,
    host: hostTag({ host: run.host }),
    lastRunAt: at,
    lastStatus: run.status,
    lastError: run.reason ? String(run.reason).slice(0, 400) : null,
    consecutiveFailures,
    escalated: consecutiveFailures >= ESCALATE_AFTER_FAILURES,
    lastSuccessAt: failed ? (prev.lastSuccessAt ?? null) : at,
    lastSuccessStatus: failed ? (prev.lastSuccessStatus ?? null) : run.status,
    packagedAt: failed ? (prev.packagedAt ?? null) : at,
    root: run.root ?? prev.root ?? null,
    rootSource: run.rootSource ?? prev.rootSource ?? null,
    stats: run.stats ?? prev.stats ?? null,
    keep,
    keepLastSuccessAt: keepOk ? (keep?.at ?? at) : (prev.keepLastSuccessAt ?? null),
    dryRun: run.dryRun === true,
    history,
  };
  let writeError = null;
  if (!run.dryRun) {
    try { atomicWriteJson(stateFilePath(opts), next); } catch (e) {
      // **不静默**：状态写失败必须能被看见（stderr + 返回值），但仍不阻断打包主流程
      writeError = String(e?.code ?? e?.message ?? e);
      try { process.stderr.write(`!! 回滚点异地化：状态文件写入失败（${writeError}）：${stateFilePath(opts)}\n`) } catch { /* ignore */ }
    }
  }
  if (writeError) next.writeError = writeError;
  // 升级告警：连续失败首次达到门槛 → 写一行给人看的流水（不静默）
  if (failed && consecutiveFailures === ESCALATE_AFTER_FAILURES) {
    try {
      const line = `[${at}] 🔴 回滚点异地化连续失败 ${consecutiveFailures} 次：${run.status} · ${run.reason ?? '(无原因)'} · 冷盘根 ${run.root ?? prev.root ?? '(未知)'}\n`;
      const f = alertLogPath({ alertLog: run.alertLog });
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, line, 'utf8');
    } catch { /* 告警写失败不阻断 */ }
  }
  return next;
}

/**
 * 健康判定（纯函数，夹具可注入 state/now）。
 * @param {{state?:object, read?:object, now?:number, file?:string}} [opts]
 */
export function judgeOffsiteHealth(opts = {}) {
  const now = opts.now ?? Date.now();
  const read = opts.read
    ?? (opts.state !== undefined ? { ok: true, file: opts.file ?? null, state: opts.state } : readState(opts));
  const s = read.state ?? null;
  const base = {
    ok: read.ok, file: read.file ?? null,
    host: s?.host ?? null, lastRunAt: s?.lastRunAt ?? null, lastStatus: s?.lastStatus ?? null,
    lastError: s?.lastError ?? null, consecutiveFailures: Number(s?.consecutiveFailures ?? 0),
    lastSuccessAt: s?.lastSuccessAt ?? null, root: s?.root ?? null, rootSource: s?.rootSource ?? null,
    stats: s?.stats ?? null, keep: s?.keep ?? null, keepLastSuccessAt: s?.keepLastSuccessAt ?? null,
    history: Array.isArray(s?.history) ? s.history : [],
    expectedFile: opts.file ?? stateFilePath(opts),
  };
  if (!read.ok || !s) {
    return {
      ...base, level: 'unknown',
      reason: `从未跑过（读不到状态：${read.error ?? '无文件'}）`,
      escalated: false, staleDays: null,
    };
  }
  const staleDays = base.lastSuccessAt
    ? Math.floor((now - Date.parse(base.lastSuccessAt)) / 86400_000)
    : null;
  const escalated = base.consecutiveFailures >= ESCALATE_AFTER_FAILURES;
  if (base.consecutiveFailures > 0) {
    return {
      ...base,
      level: escalated ? 'red' : 'yellow',
      escalated,
      staleDays,
      reason: escalated
        ? `连续失败 ${base.consecutiveFailures} 次（已达升级门槛 ${ESCALATE_AFTER_FAILURES}）— 最近 ${base.lastStatus}`
        : `失败 ${base.consecutiveFailures} 次（未达门槛 ${ESCALATE_AFTER_FAILURES}）— 最近 ${base.lastStatus}`,
    };
  }
  // 没在失败，但很久没成功过 → 调度可能停摆（例如 job 没注册 / tickd 没跑）
  if (staleDays !== null && staleDays > STALE_SUCCESS_DAYS) {
    return { ...base, level: 'yellow', escalated: false, staleDays, reason: `已 ${staleDays} 天没有一次成功打包（调度可能停摆）` };
  }
  if (base.lastStatus === 'ok') {
    return { ...base, level: 'green', escalated: false, staleDays, reason: '最近一次打包成功' };
  }
  return { ...base, level: 'info', escalated: false, staleDays, reason: `最近状态 ${base.lastStatus ?? '(未知)'}` };
}

/** 一行摘要（面板 / CLI 用）。 */
export function healthLine(h) {
  const icon = LEVEL_ICON[h?.level] ?? '⚪';
  if (!h) return `${icon} 回滚点异地化：不可探测`;
  if (!h.ok || h.level === 'unknown') return `${icon} 回滚点异地化：${h.reason}`;
  const st = h.stats ?? {};
  const bits = [];
  if (st.points != null) bits.push(`点 ${st.points}`);
  if (st.packed != null) bits.push(`本次打包 ${st.packed}`);
  if (st.bytes != null) bits.push(`${(st.bytes / 1048576).toFixed(1)} MB`);
  // keep 段（凭据保留区异地化）：只在真有异地副本时报数（没对象/失败另有日报行，不在这里虚报）
  if (h.keep?.status === 'ok' && h.keep.points != null) bits.push(`keep ${h.keep.points} 份`);
  return `${icon} 回滚点异地化：${h.reason}${bits.length ? `（${bits.join(' · ')}）` : ''} · 冷盘 ${h.root ?? '—'}`;
}

/** 日报段（markdown 行数组）——report.mjs 直接铺，判定口径不复制。 */
export function dailySectionLines(h, opts = {}) {
  const L = [];
  L.push('## 🧊 回滚点异地化（冷盘 + 仓3 脚本）');
  L.push('');
  if (!h || !h.ok || h.level === 'unknown') {
    L.push(`- ❔ 不可探测：${h?.reason ?? '未知'}（状态文件 ${h?.expectedFile ?? '?'}）—— 打包器还没跑过，或 job 未注册`);
    L.push('');
    return L;
  }
  const icon = LEVEL_ICON[h.level] ?? '⚪';
  const st = h.stats ?? {};
  L.push(`- ${icon} **${h.reason}** · 冷盘根 \`${h.root ?? '—'}\`${h.rootSource ? `（来源 ${h.rootSource}）` : ''} · 主机 \`${h.host ?? '?'}\``);
  if (st.points != null || st.bytes != null) {
    L.push(`- 快照：回滚点 **${st.points ?? '?'}** 个 · 本次打包 ${st.packed ?? '?'} / 跳过 ${st.skippedUnchanged ?? 0} · ${((st.bytes ?? 0) / 1048576).toFixed(1)} MB${st.pruned ? ` · 清理 ${st.pruned}` : ''}`);
  }
  L.push(`- 最近运行 ${h.lastRunAt ?? '—'} · 最近成功 ${h.lastSuccessAt ?? '—'}${h.consecutiveFailures ? ` · **连续失败 ${h.consecutiveFailures} 次**` : ''}`);
  // keep 段（`_archive\handoff-keep` 凭据保留区异地化 · 2026-09-20 卡 ③-3.3）：**同一段不新开段**
  //   为什么必须在这里：保留区是"删桶后仅凭据可回滚"的唯一手，而它与被删桶同盘同树
  //   （方案 §3.4 注 T6）——它有没有异地副本，必须和回滚点一起被看见。
  L.push(...keepSectionLines(h));
  if (h.level === 'red') {
    L.push(`- 🔴 **升级告警（连续失败 ≥${ESCALATE_AFTER_FAILURES}）**：冷盘不在线或写入失败 → 回滚点仍是**单点**（\`<workspace>\\_archive\` 所在盘，方案 §3.3 T18）。`);
    L.push(`  - 处置：插回冷盘（本机 = H: 外接 SSD / 另一台 = F: 内置盘）后手动补跑 \`node <workspace>\\tools\\rollback-points-offsite.mjs --backup --prune\``);
    L.push(`  - 临时改道：环境变量 \`ROLLBACK_POINTS_ROOT=<另一个可写目录>\`（解析口径见 \`tools/lib/rollback-points-root.mjs\`）`);
    L.push(`  - 告警流水：\`${alertLogPath(opts)}\``);
  } else if (h.lastError) {
    L.push(`- 最近错误：${String(h.lastError).split('\n')[0].slice(0, 160)}`);
  }
  L.push('');
  return L;
}

/**
 * keep 段（`_archive\handoff-keep` 凭据保留区异地化）的日报行 —— **唯一真源**
 *   （日报「🧊」段与 CLI `--status` 共用同一句；口径不在别处复制）。
 * 三种态：ok（有异地副本）/ skipped（还没有对象：GC 未真删过桶）/ failed（最近一轮没镜像上）。
 * 冷盘不在线时（h.level === 'red'）追加一句"保留区同样没有异地副本"——T6 那句话必须随红态出现。
 * @param {object} h judgeOffsiteHealth() 的返回
 * @returns {string[]} markdown 行（不含尾部空行）
 */
export function keepSectionLines(h) {
  const L = [];
  const k = h?.keep ?? null;
  const when = (x) => String(x ?? '—').replace('T', ' ').slice(0, 16);
  const mb = (n) => ((Number(n) || 0) / 1048576).toFixed(2);
  if (!k) {
    L.push('- ⚪ 凭据保留区 `handoff-keep`（异地副本）：尚无记录 —— 随每日 `--backup` 自动镜像（本机保留区由 handoff 桶 GC 首次真删时创建）');
  } else if (k.status === 'ok') {
    L.push(`- ✅ 凭据保留区 \`handoff-keep\`（异地副本）：**${k.points ?? '?'} 份 / ${mb(k.bytes)} MB**`
      + `（本次打包 ${k.packed ?? 0} · 未变 ${k.unchanged ?? 0}）· 冷盘 \`${k.dir ?? '—'}\` · 最近成功 ${when(h.keepLastSuccessAt ?? k.at)}`);
  } else if (k.status === 'skipped') {
    L.push(`- ⚪ 凭据保留区 \`handoff-keep\`（异地副本）：尚无对象 —— ${k.reason ?? '保留区未创建（GC 还没真删过桶）'}`);
  } else {
    L.push(`- ⚠️ 凭据保留区 \`handoff-keep\`（异地副本）：**最近一轮失败**（${k.reason ?? '未知'}）`
      + `· 冷盘 \`${k.dir ?? '—'}\` · 最近成功 ${when(h.keepLastSuccessAt)}`);
  }
  // ⚠️ 冷盘不在线时必须**无条件**出现这句（卡 ③-3.3 硬要求）：盘不可达 ⇒ 保留区也没有异地副本，
  //   它退回"同盘同树"（T6）—— 不能因为"状态里还没有 keep 记录"就少说这一句（2026-09-20 单测首跑抓到）。
  if (h?.level === 'red') {
    L.push('- 冷盘不在线 ⇒ 保留区**同样没有异地副本**（它与被删桶同盘同树 = P8「同盘同树假备份」形态，方案 §3.4 注 T6）；插回冷盘后跑一次 `--backup` 即可补镜像');
  }
  return L;
}

export default judgeOffsiteHealth;
