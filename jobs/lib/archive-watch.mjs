// dsh-butler / lib/archive-watch.mjs —— P3 L2 自动动作：归档出错自动重试（一次，不无限重试）
//                                     ＋【2026-09-28 · M2 遗留②】写库失败 → **只补写、不重跑归档**
//
// 方案 §4 P3「L2 自动动作：归档出错自动重试」（扩面后第一个 L2）：
//   - 判定：`.auto-archive.json` 的 `lastResult.errors > 0`（非空）→ 自动重跑 `/auto/run` 一次
//     → 仍错 → 🔴 推 + 落报告（**不无限重试**）
//   - 审计：`.auto-archive.json` 自带 lastResult（含 batch 时间戳）+ 补一行变更流水
//
// 事实来源（2026-09-11 本机实测）：
//   状态文件 = `~/.dsh\_archived-sessions\.auto-archive.json`
//     { config:{enabled,dryRun,hours,intervalMs,minSizeMb,maxPerRun}, state:{lastRunAt,lastResult:{scanned,candidates[],archived[],skipped[],errors[],batch,movedMb},totalArchived} }
//   执行入口 = 插件 dsh-archive-sessions 的 host 路由 `POST /api/dsh-archive-sessions/auto/run`
//
// 三个**不可越过**的边界：
//   ① 自动归档自身 `config.enabled=false` 时 → **绝不代它打开**（那是改主人配置 = L3 语义）；
//      本模块只报「不可重试：归档功能已关闭」。
//   ② dry-run 一律不发 HTTP 请求（交付纪律：开发期只算不动）。
//   ③ 重试动作**带去重签名**（batch + errors 数）→ 同一批次只重试一次（不无限重试的实现保证）。
//
// 【2026-09-28 · M2 遗留②】两类失败**语义分流**（方案 §8 第 2 条：`errors ∪ writeFailedStreak > 0`）：
//   · `lastResult.errors`（归档**动作**失败：搬移/权限/…）→ 归档没搬成功 ⇒ 重跑 `/auto/run` 有意义。
//   · `state.metaStore.writeFailedStreak`（**写库**失败：加速缓存写不进）→ 会话**已经搬走了**，
//     重跑 `/auto/run` = 空转再报错（还会重复扫描）⇒ 只走**补写**（读侧惰性补写）。
//   判据分流字段 = `retryMode: 'archive' | 'meta-backfill' | 'none'`（`retryable` 保留 = `retryMode !== 'none'`）。
//   ⚠️ **向后兼容**：状态文件**没有** `state.metaStore` 段时（2026-09-28 生产现状），
//      `retryMode` 恒 `'none'`、`retryable/blockedReason/decisions` 与扩展前**逐字一致**
//      （守门用例：`_test/test-archive-watch.mjs` ① 段）。
//
// 补写入口选择（2026-09-28，**先只读核实再写代码**）：
//   选 **归档插件的 `/list` 读侧惰性补写**（`GET /api/dsh-archive-sessions/list`，**不带** `?lazy=0`），
//   两个候选的取舍见 `docs\交付报告-归档元数据库M2遗留②-archive-watch判据扩展-20260928.md` §2：
//     · `tools\archive-meta-backfill.mjs --apply` = 全量重扫归档区（无预算帽）+ 每跑一次落一个
//       `_archive\archive-meta-backfill-<ts>\` 备份目录 ⇒ 作为**每 tick 可能触发**的自动动作不合适（垃圾累积 + 慢）。
//     · `/list` 惰性补写 = 插件为"库向目录对齐"设计的兜底路径：**幂等**（补完即静默）、带**慢路径预算帽**
//       （超预算顺延下轮，不拖死 tick）、**库损坏即禁写**（fail-safe）⇒ 天然满足"只补写、绝不重跑归档"。
//   已知副作用（如实登记在报告里）：它**顺带**会把"库有、目录已无"的条目反标 `restored`（带在途防护窗），
//   这是插件既有的库↔目录对齐行为（面板每次打开都会做），不是本动作新增的破坏面；读数在返回里透出（`rebound`）。
import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from '../../src/dsh-butler/lib/paths.mjs';

export const ARCHIVE_WATCH_VERSION = '0.2.0';

/** 补写入口路径（**故意不带** `?lazy=0`——带了就是"只读、不补写"）。 */
export const META_BACKFILL_PATH = '/api/dsh-archive-sessions/list';

/** 宽松数字（`undefined`/`NaN` → null；`null` → 0，调用方按语义兜底）。 */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** 归档自动化的状态文件位置。 */
export function archiveStateFile(opts = {}) {
  return opts.file ?? path.join(opts.home ?? dshHome(), '_archived-sessions', '.auto-archive.json');
}

/** 只读读取归档自动化状态（文件缺失 → 视为"无归档活动"，不是错误）。 */
export function readArchiveAutoState(opts = {}) {
  const file = archiveStateFile(opts);
  try {
    if (!fs.existsSync(file)) return { ok: false, file, fileExists: false, error: 'state-missing' };
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, file, fileExists: true, raw: j };
  } catch (e) {
    return { ok: false, file, fileExists: true, error: e?.message ?? String(e) };
  }
}

/**
 * 归档状态摘要 + 重试判定（纯只读，供 dry-run 与闸门判定共用）。
 * 【2026-09-28 · M2 遗留②】新增 `retryMode` 分流字段与 `metaStore` 摘要（口径见文件头注释）。
 * @returns {{
 *   ok:boolean, file:string, fileExists:boolean, enabled:boolean|null, dryRun:boolean|null,
 *   lastRunAt:number|null, batch:string|null, scanned:number, archived:number, errors:number,
 *   errorSamples:any[], metaStore:{writeFailedStreak:number,writeFailedTotal:number,lastWriteError:any,lastWriteAt:number|null}|null,
 *   lastMetaStore:{attempted:number|null,written:number|null,failed:number|null}|null,
 *   retryMode:'archive'|'meta-backfill'|'none',
 *   retryable:boolean, blockedReason:string, decisions:string[]
 * }}
 */
export function gatherArchiveAutoStatus(opts = {}) {
  const r = readArchiveAutoState(opts);
  if (!r.ok) {
    return {
      ok: false, file: r.file, fileExists: r.fileExists, enabled: null, dryRun: null,
      lastRunAt: null, batch: null, scanned: 0, archived: 0, errors: 0, errorSamples: [],
      metaStore: null, lastMetaStore: null, retryMode: 'none',
      retryable: false, decisions: [], blockedReason: r.error ?? 'unknown',
    };
  }
  const cfg = r.raw?.config ?? {};
  const st = r.raw?.state ?? {};
  const lr = st.lastResult ?? {};
  const errors = Array.isArray(lr.errors) ? lr.errors.length : (lr.errors ? 1 : 0);

  // ── 写库失败（M2 §4.2-③ 通道②）：持久累计落在 `state.metaStore`，**不进** `lastResult.errors`
  //    （errors = "要不要重发 /auto/run" 的判据；写库失败与归档动作无关）。
  //    本模块判据 = `writeFailedStreak > 0`；日报告警面（watch-events.mjs）用 `≥ 2` 防抖。
  //    刻意不同阈：**告警要防抖、自动补写要趁早**（补写幂等 + 带签名去重，不会因阈值低而刷动作）。
  const rawMeta = st?.metaStore && typeof st.metaStore === 'object' ? st.metaStore : null;
  const metaStore = rawMeta === null ? null : {
    writeFailedStreak: num(rawMeta.writeFailedStreak) ?? 0,
    writeFailedTotal: num(rawMeta.writeFailedTotal) ?? 0,
    lastWriteError: rawMeta.lastWriteError ?? null,
    lastWriteAt: num(rawMeta.lastWriteAt),
  };
  const rawLast = lr?.metaStore && typeof lr.metaStore === 'object' ? lr.metaStore : null;
  const lastMetaStore = rawLast === null ? null : {
    attempted: num(rawLast.attempted), written: num(rawLast.written), failed: num(rawLast.failed),
  };

  const decisions = [];
  let retryMode = 'none';
  let retryable = false;
  let blockedReason = '';

  if (errors > 0) {
    // ① 归档**动作**失败 → 重跑归档（**既有行为，一字未改**）
    if (cfg.enabled !== true) {
      blockedReason = '归档功能已关闭（config.enabled=false）——代它打开属于 L3 改配置，管家不做';
      decisions.push(blockedReason);
    } else if (cfg.dryRun === true) {
      blockedReason = '归档处于 dryRun 模式：重试同样只会空跑，先让主人关掉 dryRun';
      decisions.push(blockedReason);
    } else {
      retryable = true;
      retryMode = 'archive';
      decisions.push('将重试一次 POST /api/dsh-archive-sessions/auto/run');
    }
  } else if (metaStore !== null && metaStore.writeFailedStreak > 0) {
    // ② 归档动作成功、**只有写库失败** → 只补写（会话已搬走，重跑＝空转再报错）
    const streak = metaStore.writeFailedStreak;
    if (cfg.enabled !== true) {
      blockedReason = '归档功能已关闭（config.enabled=false）——元数据库补写一并暂缓'
        + '（关掉归档功能期间不做后台写库）；代它打开属于 L3，管家不做。'
        + `开一次归档面板即由读侧惰性补写自然补齐（writeFailedStreak=${streak}）`;
      decisions.push(blockedReason);
    } else if (cfg.dryRun === true) {
      blockedReason = `归档处于 dryRun 模式：补写同样只算不动（dry-run 一律不发请求）——writeFailedStreak=${streak}`;
      decisions.push(blockedReason);
    } else {
      retryable = true;
      retryMode = 'meta-backfill';
      decisions.push(`元数据库写失败（writeFailedStreak=${streak} · 累计 ${metaStore.writeFailedTotal}）`
        + `→ **只补写、不重跑归档**（归档动作已成功，重跑＝空转再报错）：GET ${META_BACKFILL_PATH}`);
    }
  } else {
    decisions.push('末次归档无错误（errors=0）→ 无需重试');
  }

  return {
    ok: true,
    file: r.file,
    fileExists: true,
    enabled: cfg.enabled === true,
    dryRun: cfg.dryRun === true,
    intervalMs: Number(cfg.intervalMs ?? 0) || null,
    lastRunAt: Number(st.lastRunAt ?? 0) || null,
    batch: lr.batch ?? null,
    scanned: Number(lr.scanned ?? 0),
    archived: Array.isArray(lr.archived) ? lr.archived.length : 0,
    candidates: Array.isArray(lr.candidates) ? lr.candidates.length : 0,
    skipped: Array.isArray(lr.skipped) ? lr.skipped.length : 0,
    movedMb: Number(lr.movedMb ?? 0),
    errors,
    errorSamples: (Array.isArray(lr.errors) ? lr.errors : []).slice(0, 5),
    totalArchived: Number(st.totalArchived ?? 0),
    metaStore,
    lastMetaStore,
    retryMode,
    retryable,
    blockedReason,
    decisions,
  };
}

/**
 * 执行一次重试（**真发 HTTP**；调用方必须先过 lib/autonomy-actions.runAction 闸门）。
 * @param {{baseUrl?:string, home?:string, now?:number, timeoutMs?:number, fetchImpl?:Function, dryRun?:boolean}} opts
 */
export async function attemptArchiveRetry(opts = {}) {
  const base = String(opts.baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const url = `${base}/api/dsh-archive-sessions/auto/run`;
  if (opts.dryRun) return { ok: false, dryRun: true, mode: 'archive', url, reason: 'dry-run：未发请求' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, trigger: 'butler-p3-retry' }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const after = gatherArchiveAutoStatus({ home: opts.home });
    return {
      ok: res.ok && body?.ok !== false,
      mode: 'archive',
      url, status: res.status, durationMs: Date.now() - t0,
      result: body?.result ?? body ?? null,
      errorsAfter: after.errors,
      stillFailing: after.errors > 0,
      escalation: after.errors > 0 ? '🔴 重试后仍有错误 → 推主人 + 落报告（不再重试）' : '重试成功',
    };
  } catch (e) {
    return { ok: false, mode: 'archive', url, durationMs: Date.now() - t0, error: e?.message ?? String(e), stillFailing: true, escalation: '🔴 重试请求失败 → 推主人 + 落报告（不再重试）' };
  }
}

/**
 * 【2026-09-28 · M2 遗留②】执行一次**元数据库补写**（只补写、**绝不重跑归档**）。
 *
 * 入口 = 归档插件的读侧惰性补写（`GET /api/dsh-archive-sessions/list`）——**故意不带 `?lazy=0`**
 * （带了即"只读、不补写"）。它会：① 目录有、库无/字段缺 ⇒ 补条目（慢路径带预算帽）
 * ② 库有、目录无 ⇒ 反标 `restored`（带在途防护窗）③ 一次原子写 ④ 库损坏 ⇒ 禁写。
 * **不碰归档区任何文件、不发 `/auto/run`** ⇒ 与"归档动作已成功"的事实不冲突。
 *
 * ⚠️ 与 `attemptArchiveRetry` 的分工是**互斥**的：调用方按 `gatherArchiveAutoStatus().retryMode` 二选一。
 * ⚠️ 真发 HTTP；调用方必须先过 `lib/autonomy-actions.runAction` 闸门（kind 复用 `archive-retry`，
 *    靠 `detail.mode` / `sigKey` 前缀区分，不新增动作矩阵条目）。
 *
 * @param {{baseUrl?:string, home?:string, timeoutMs?:number, fetchImpl?:Function, dryRun?:boolean, streakBefore?:number}} opts
 */
export async function attemptMetaBackfill(opts = {}) {
  const base = String(opts.baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const url = `${base}${META_BACKFILL_PATH}`;
  if (opts.dryRun) return { ok: false, dryRun: true, mode: 'meta-backfill', url, reason: 'dry-run：未发请求' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const m = body?.metaStore ?? null;
    const after = gatherArchiveAutoStatus({ home: opts.home });
    const streakAfter = after.metaStore?.writeFailedStreak ?? 0;
    const writeOk = m?.writeOk !== false;
    return {
      ok: res.ok && m !== null && writeOk,
      mode: 'meta-backfill',
      url, status: res.status, durationMs: Date.now() - t0,
      // 补写读数（插件 `/list` 的 lazyMetaSync 回显；null = 该版本插件没回显，不代表没做）
      backfilled: m?.backfilled ?? null,
      rebound: m?.rebound ?? null,
      regenerated: m?.regenerated ?? null,
      slowSkipped: m?.slowSkipped ?? null,
      attempted: m?.attempted ?? null,
      written: m?.written ?? null,
      failed: m?.failed ?? null,
      writeOk: m?.writeOk ?? null,
      writeReason: m?.writeReason ?? null,
      metaStoreState: body?.metaStoreState ?? null,
      streakBefore: Number.isFinite(Number(opts.streakBefore)) ? Number(opts.streakBefore) : null,
      streakAfter,
      stillFailing: streakAfter > 0,
      escalation: streakAfter > 0
        ? '🔴 补写后写库仍失败 → 推主人 + 落报告（**不重跑归档**：先查 .bak / 磁盘权限）'
        : '补写成功（写库失败计数未再增长）',
      note: '只补写（读侧惰性补写）；**不发** /auto/run ⇒ 归档区零搬移',
    };
  } catch (e) {
    return {
      ok: false, mode: 'meta-backfill', url, durationMs: Date.now() - t0,
      error: e?.message ?? String(e), stillFailing: true,
      escalation: '🔴 补写请求失败 → 推主人 + 落报告（**不重跑归档**）',
    };
  }
}
