// tools/lib/repo-superset.mjs
// 三仓「推前超集体检」核心逻辑 —— 供 CLI（check-repo-superset.mjs）与 PowerShell 挡推（dsh-backup-sync.ps1 -Push）共用。
//
// 为什么：三个采集脚本用 robocopy /E（增量、不 purge）把**生产目录覆盖到工作副本**。
//   仓里若存在生产所没有的内容，下一次 -Sync 就会抹掉它，再 -Push 就永久丢失。
//   实测两次事故：一台机的 -Sync 覆盖掉对端版 8 份文档；仓1 有 9 项「仓里更全」被覆盖。
//
// 判读（五类）：
//   uniqueLines  = 真内容独有行（仓里有、生产没有）→ 报告里**全量列出**不缩水；
//                  CLI 不带 --blocking-only 时的退出码口径（严格档，供人工体检/回归锚点用）
//   recoverableLines（子集，2026-09-16 新增）= 其中的「可回退旧版」：仓侧独有行全部来自
//                  **本机已提交且已推送**的版本 ⇒ 采集覆盖后可用 git 找回 ⇒ **不挡**
//                  （判据与安全边界见下方「可回退旧版」一节）
//   blockingLines = uniqueLines 里**判不出可回退**的那些（= 真·会丢）→ **挡推**
//                  （Depart 前置体检与 .ps1 -Push 门**共用这个口径**：CLI `--blocking-only`）
//   rewriteLines = 疑似改写（两侧都有独有行，但归一化后仓侧独有行消失/降到 20% 以下，
//                  即本机把某行改写后的新旧两版）→ **不挡推，但报告里照样显眼列出**（2026-09-12 新增）
//   onlyInRepo   = 仓里有该文件、生产没有 → 不挡推，但本机看不到它的内容
//   forkedLines  = 分叉类（单机状态文件）→ 不挡推，但覆盖同样会丢仓方独有行，需人工判断
//
// 退出码约定由调用方决定；本模块只返回结构化报告。

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolveDshHome } from "./dsh-home.mjs";
import { dshRoot, repoRoot } from "./host-config.mjs";

// DSH 数据根：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（2026-09-17 环境边界修复，
// 卡：自研组件去 os.homedir() 硬编码）。本模块把仓里的 `dsh/…` 映射回**本机数据根**
// 再比内容 —— 原为 `os.homedir()`，于是带隔离 home 跑体检时比的是**生产**数据。
// ⚠️ 语义变更：HOME 现在 = DSH 数据根（…\.dsh），下游拼接**不要再补一层 .dsh**。
// 不设环境变量时 resolveDshHome() 回落 ~/.dsh，路径与改造前逐字节一致。
export const HOME = resolveDshHome();

/** 三仓工作副本根（`$BUTLER_REPO_ROOT` > `~/dsh-repos`）。 */
export const REPO_ROOT = repoRoot();
/** 数据区根（工作副本里 `ws/` 前缀映射回这里）。 */
export const WORKSPACE_ROOT = dshRoot();

/** 仓根路径（工作副本）。 */
export const REPOS = {
  "dsh-core": {
    root: path.join(REPO_ROOT, "dsh-core"),
    // 仓1 只有 dsh/ 子树映射到 ~/.dsh；两个「按主机名前缀采集」的目录需要映射回去：
    //   · butler-audit：采集时重命名为 <host>-YYYY-MM.jsonl（见 dsh-backup-sync.ps1 Copy-AuditDir）
    //   · butler-barewatch：采集时重命名为 <host>-{ledger.jsonl,state.json}（见 Copy-BarewatchFiles）
    // 映射到本机同名文件后，本机那份参与真比对；对方机器那份会落到"仅仓内有/分叉类"（不挡推，人工知情）。
    map: (rel) => {
      if (!rel.startsWith("dsh/")) return null;
      const sub = rel.slice(4);
      const m = /^butler-audit\/[a-z0-9._-]+-(\d{4}-\d{2}\.jsonl)$/i.exec(sub);
      if (m) return path.join(HOME, "butler-audit", m[1]);
      const b = /^butler-barewatch\/[^/]+-(ledger\.jsonl|state\.json)$/i.exec(sub);
      if (b) return path.join(HOME, `butler-barewatch-${b[1]}`);
      return path.join(HOME, sub);
    },
  },
  "dsh-sessions": {
    root: path.join(REPO_ROOT, "dsh-sessions"),
    map: (rel) => path.join(HOME, rel.replace(/\//g, "\\")),
  },
  "dsh-workspace": {
    root: path.join(REPO_ROOT, "dsh-workspace"),
    map: (rel) => path.join(WORKSPACE_ROOT, rel.replace(/\//g, "\\")),
  },
};

// 「分叉类」= 单机状态文件：两台机各自持续写入，永远不可能互为超集，且 git-crypt 密文 blob 无法内容合并。
// ⚠️ 不等于「推了没事」：覆盖同样会丢掉仓方独有的行（谁推谁赢），只是需人工判断是否可接受；
//    与「真内容独有行」同属推前必看项，分栏只为降噪（否则 ledger/growth 每次刷屏）。
export const FORKED_PATTERNS = [
  /^dsh\/storages\//,
  /^dsh\/task-board\/ledger/, /^dsh\/task-board\/scheduler/,
  /^dsh\/api-balance-stats\.json$/,
  /^dsh\/whale-on-desk\/growth\.json$/,
  /^dsh\/llm-deepseek\/files-v3\.json$/,
  /^dsh\/memory\/memory\.db$/,
  /^dsh\/butler-/, /^dsh\/\.anonymous-user-id$/,
  /^sessions\//,
  // 2026-09-11（对端首次真机 depart 被挡后补）：**两机各自 tick 重生成的产物**，永远不可能互为超集，
  // 但覆盖是安全的（内容不丢）——故归「分叉类」不挡推：
  //   · docs/坑库/**             = dsh-butler P4 全自动渲染（页眉带"生成时间/条目数"，每轮 tick 必变）
  //   · docs/踩坑大全.md         = P4 在顶部注入自动索引段（butler-auto:begin…end），原文完整保留
  //   · dsh/external-sources.json = P6 源注册表，每次 tick bump updatedAt；源定义本身跨机共享（2026-09-11 已把对端版对齐成本机超集）
  // ⚠️ 数据层不丢的前提：butler-pitfalls.json 按 P9 §4.3 / §14 A4「双口径」合并后，
  //    本机渲染出的坑库 ⊇ 对方数据（合并脚本见 _tmp 下的临时脚本）
  // 2026-09-11 晚 · 根治（卡「tick 产物 host 分文件」）：上面这些产物已改为 **host 分文件** ——
  //   docs/坑库/<主题>-<host>.md · docs/坑库/README-<host>.md · docs/踩坑大全-<host>.md ·
  //   docs/管家报告/watch-<date>-<host>.md · ~/.dsh/external-sources-<host>.json。
  //   两机各写各的文件名 ⇒ 天然不互为超集、也不再互相覆盖 ⇒ **新文件不再需要豁免**（走真比对）。
  // 2026-09-13 · 收口（卡「跨机同步 · host 分文件收口」）：旧名单份渲染物已删
  //   （本机 + 仓 git rm；备份与一键恢复见 _archive\host-split-retire-20260913-0210\）——
  //   原先那 4 条「只匹配旧名单份文件名」的**兼容期豁免随之删除**：此后同类差异若再出现即真问题，
  //   不再被掩盖（host 文件形态的豁免见本清单末尾 4 条）。
  // 2026-09-12（实测 Depart 被挡 21 个文件后补）：上面四条只覆盖**旧名单份文件名**，
  //   而 host 分文件形态（`<主题>-<host>.md`）在**同一台机的跨轮次**比对里同样必然分叉 ——
  //   P4/P2 每轮 tick 重渲染，页眉「生成时间」+ 计数/score 浮点必变 ⇒ 每次 tick 后都报
  //   「真内容独有行」⇒ Depart 的推前体检（跑在采集**之前**）每轮 fail-closed 挡推。
  //   ⚠️ 修正 2026-09-11 改造时的判断「新文件不再需要豁免（走真比对）」：那条只考虑了
  //   「两机互覆」，漏了「同机上一轮生成 vs 这一轮生成」—— 而后者的覆盖**本就是正确方向**
  //   （本机渲染物永远取自本机最新数据源）。
  //   安全性：host 文件按机器名分文件，本机那份永远是最新；对端的 host 文件不在本机生产里
  //   （走 onlyInRepo，本就不参与行比对）⇒ 豁免不存在跨机丢内容。
  /^docs\/坑库\/.+-[a-z0-9][a-z0-9-]*\.md$/,
  /^docs\/踩坑大全-[a-z0-9][a-z0-9-]*\.md$/,
  /^docs\/管家报告\/watch-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/,
  /^dsh\/external-sources-[a-z0-9][a-z0-9-]*\.json$/,
  // 2026-09-16（卡 AT11）· 补登记两条**每机自写**的管家报告类文件：
  //   ⚠️ 它们不是"旧名遗留"——`report.mjs` 每日刷新 `<YYYY-MM-DD>-<设备>.md`（butler-locks 登记为日报产出），
  //   `.advice-config.json` 记录**本机**最近一次 LLM 调用。当年 host 分文件收口只给坑库/踩坑大全/watch 报告
  //   加了豁免，漏了这两条 ⇒ 对端每轮 depart / -Push 都被判「真内容独有行」（日报那份还会以
  //   「♻ 可回退旧版」刷屏）。
  //   为什么覆盖安全：日报文件名带**本机 host**（`<date>-<HOST>.md`），
  //   每机只写自己那份；对端生产里若有同名文件，那是早期同步过去的**化石**，覆盖它不损失任何跨机内容。
  //   ⚠️ host 段必须容忍大写（日报用原始主机名；watch 用小写短码）。
  //   反向边界（**不豁免**，走真比对）：无 host 后缀的 `周报-<日期>.md`、`P2.5验收取证-*.json` 等
  //   （夹具 F4/F5 锚定）。同类但未纳入的观察项：`docs/管家报告/external-<date>-<host>.md`（P6 探源报告）。
  /^docs\/管家报告\/\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*\.md$/,
  /^docs\/管家报告\/\.advice-config\.json$/,
];

export const isForked = (rel) => FORKED_PATTERNS.some((re) => re.test(rel));

// ============================================================================
// 「疑似改写」判定（2026-09-12 · 卡「超集门判定器改进」改动点 A）
//
// 根因：判据是行集合比对（「仓里的行是否原样存在于生产」）。本机把一行**改写**后：
//   · 新行 → 生产有、仓没有（只在 localOnly，从不报警）
//   · 旧行 → 仓有、生产没有（被报成「仓独有」→ 硬挡推）
//   ⇒ 纯改写被误判成「仓方内容要丢」。2026-09-12 实测 22 项挡推里约 15 项属此类。
//
// 判据：两侧**都有**独有行（排除「本机是仓的严格超集」这一本就安全的情形），且把两侧行做
//   **归一化**（全角→半角、数字→<N>、标点/引号归一、去空白、大小写归一）后，仓侧独有行
//   降为 0 或 ≤ 原值 20% ⇒ 判「疑似改写」，从唯一硬挡栏降级到 rewriteLines（只报告、不挡推）。
//
// ⚠️ 硬约束：**只降噪、绝不自动放行**。
//   · 残余（归一化后仍独有）行照旧进 uniqueLines（硬挡），文件级仍挡推；
//   · 降级项必须出现在报告的显眼位置，并在 conclusion 文本里计数提示。
// ============================================================================

/** 归一化后仓侧独有行的容忍比例：≤20% 视为「改写型为主」（残余部分仍硬挡）。 */
export const REWRITE_RESIDUAL_RATIO = 0.2;

/**
 * 行归一化：抹掉「同一行的不同版本」差异（时间戳 / 计数 / 浮点 / 标点 / 引号 / 大小写 / 空白）。
 * 只做**同形归一**，不做语义判断——A/B 这类实质不同的内容不会被归一成同一行。
 */
export function normalizeLine(line) {
  return String(line)
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字→半角（否则 \d 匹配不到）
    // 数字及其内部分隔符统一占位：须连 `3.2`（版本号）/ `2026-09-12`（日期）/ `00:17`（时间）/ `1.5x` 一起吃掉，
    // 否则「v3 vs v3.2」会归一成 `<N> vs <N>.<N>` 而漏判（夹具单测实测踩到）。
    .replace(/\d+(?:[.:\-_/]\d+)*/g, "<N>")
    .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"')
    .replace(/[\u2018\u2019\u2039\u203a`]/g, "'")
    .replace(/\u3002/g, ".").replace(/[\uFF0C\u3001]/g, ",").replace(/\uFF1A/g, ":")
    .replace(/\uFF1B/g, ";").replace(/\uFF01/g, "!").replace(/\uFF1F/g, "?")
    .replace(/\uFF08/g, "(").replace(/\uFF09/g, ")").replace(/\u3010/g, "[").replace(/\u3011/g, "]")
    .replace(/[\u2014\u2013\uFF0D\u2212]/g, "-").replace(/[\uFF5E\u301C\u223C]/g, "~")
    .replace(/\s+/g, "") // 去所有空白（\s 已含全角空格 U+3000）
    .toLowerCase();
}

/** 一个文本差异文件的逐行统计：仓独有 / 本机独有 / 归一化后仓侧仍独有。 */
export function diffLineStats(repoText, prodText) {
  const split = (t) => String(t).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const repoLines = split(repoText);
  const prodLines = split(prodText);
  const prodSet = new Set(prodLines);
  const repoSet = new Set(repoLines);
  const repoOnly = repoLines.filter((l) => !prodSet.has(l));
  const localOnly = prodLines.filter((l) => !repoSet.has(l));
  const prodNorm = new Set(prodLines.map(normalizeLine));
  const repoNormOnly = repoOnly.filter((l) => !prodNorm.has(normalizeLine(l)));
  return { repoOnly, localOnly, repoNormOnly };
}

/**
 * 挡推形态判定（改动点 B 用）：blocker 是否属「**本机积压未推**」形态。
 * 两个条件**或**关系（任务口径）：
 *   ① 仓独有行全部落在「疑似改写」降级栏（无残余硬挡行）⇒ 差异方向明确是本机改写/追加；
 *   ② 本机独有行总数 ≥ 仓独有行总数 × 3 ⇒ 本机内容明显更多（典型「本机新版 vs 仓内旧快照」）。
 * ⚠️ 条件②**不要求**存在降级项：实测 2026-09-12 的 22 项里降级项为 0，但 handoff.mjs（本机独有 73 行 /
 *    仓独有 4 行）正是最该提示「先 -Sync」的形态——若把降级项当前置，这类真积压反而提示不出来。
 * @param {object} report checkRepo 的返回
 * @returns {boolean}
 */
export function isLocalBacklog(report) {
  const repoOnly = report?.repoOnlyLines ?? 0;
  const localOnly = report?.localOnlyLines ?? 0;
  if (!report || repoOnly === 0) return false;
  // 条件 ①：仓独有行全部落进降级栏
  if ((report.uniqueLines?.length ?? 0) === 0 && (report.rewriteLines?.length ?? 0) > 0) return true;
  // 条件 ②：本机独有行 ≥ 仓独有行 × 3
  return localOnly >= repoOnly * 3;
}

// ============================================================================
// 「正当重写」登记（2026-10-19 · 卡「V3·地基 D-6」/ 需求 R-053）
//
// 现场：本机把某个文件**有意重写/拆薄**后（例：脱敏器迁共享件后本文件改成 `export *` 薄转发；
//   host-rpc 按刀口④拆成「客户端件 + 壳」；0.2.0 迁移后删掉一条已不存在的 peer inject），
//   生产那份**行数远少于**仓里的旧版 ⇒ `classifyBlocking` 的**形态守卫**（本机独有行 ≥ 仓独有行 × ½）
//   判「形态可疑：本机内容明显更少」⇒ 永久硬挡 ⇒ Depart 前置体检每轮 fail-closed 中止，
//   只能靠 `--force-collect` 强推绕过（等于把门关掉）。
//
// 修法（**登记制**，不是放宽判据）：形态守卫遇到「本机独有行偏少」时多问一句 ——
//   该文件是否在 `tools\lib\repo-superset-rewrites.json` 里**显式登记**为「正当重写」？
//   登记命中 **且** git 判「可回退」（已提交且已推送）**才**放行；任一不满足 ⇒ 照旧硬挡（fail-closed）。
//
// 为什么登记 + git 双条件就够安全：登记只免掉「行数形态」这一层怀疑，**没有**免掉
//   「内容是否还能找回」—— 仓侧旧版仍必须已提交已推送（`git show <rev>:<path>` 可取回）。
//   真正会永久丢的两种形态（未提交 / 未推送）照旧挡。
//
// 登记项的**自动过期**（防「登记一次永久放行」）：
//   · `until`（YYYY-MM-DD）到期 ⇒ 登记失效，回落形态守卫硬挡；
//   · `prodSha256` 与生产侧当前内容不符 ⇒ 说明生产那份又被改过、形态已变 ⇒ 登记失效（要求重新登记）。
//   · 登记文件缺失 / JSON 坏 / 形态不合法 ⇒ **零登记**（fail-closed），不影响既有判定。
// ⚠️ 只新增栏位与放行通道：`uniqueLines` / `hasRealRisk` / 既有 blocking 判据一字不改。
// ============================================================================

/** 登记文件（默认躺在 lib 旁边；`REPO_SUPERSET_REWRITES` 可指向夹具，供单测用）。 */
export const REWRITE_REGISTRY_FILENAME = "repo-superset-rewrites.json";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 生效的登记文件路径（env 优先 = 夹具注入点；生产不设 = lib 同目录）。 */
export function rewriteRegistryPath() {
  const fromEnv = process.env.REPO_SUPERSET_REWRITES;
  return fromEnv && String(fromEnv).trim() ? String(fromEnv) : path.join(MODULE_DIR, REWRITE_REGISTRY_FILENAME);
}

/** 本机当天（YYYY-MM-DD，本地时区）—— `until` 过期比较用。 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 读登记文件（每次 checkRepo 调一次，不缓存 ⇒ 改登记后下一次体检立即生效）。
 * @returns {{path:string, ok:boolean, entries:Array<{rel:string,asOf?:string,until?:string,owner?:string,reason?:string,prodSha256?:string}>, error:string|null}}
 */
export function loadRewriteRegistry() {
  const p = rewriteRegistryPath();
  const res = { path: p, ok: false, entries: [], error: null };
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch (e) { res.error = e?.code === "ENOENT" ? "登记文件不存在（零登记）" : `登记文件读不到：${e?.message ?? e}`; return res; }
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { res.error = `登记文件 JSON 损坏（零登记）：${e?.message ?? e}`; return res; }
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.entries) ? j.entries : null);
  if (!arr) { res.error = "登记文件缺 entries 数组（零登记）"; return res; }
  res.entries = arr.filter((e) => e && typeof e.rel === "string" && e.rel.trim()).map((e) => ({ ...e, rel: e.rel.trim() }));
  res.ok = true;
  return res;
}

/**
 * 判断某 rel 的「正当重写」登记此刻是否**有效**。
 * @returns {{status:'none'|'ok'|'expired'|'stale', entry?:object, note?:string}}
 */
function judgeRegistryEntry(registry, rel, prodPath) {
  const entry = registry?.entries?.find((e) => e.rel === rel);
  if (!entry) return { status: "none", note: "未登记为正当重写" };
  const today = todayStr();
  if (entry.until && /^\d{4}-\d{2}-\d{2}$/.test(String(entry.until)) && String(entry.until) < today) {
    return { status: "expired", entry, note: `登记已于 ${entry.until} 过期` };
  }
  if (entry.prodSha256) {
    let sha = null;
    try { sha = createHash("sha256").update(fs.readFileSync(prodPath)).digest("hex"); } catch { sha = null; }
    if (!sha) return { status: "stale", entry, note: "生产侧该文件读不到（sha 复核失败）" };
    if (sha !== String(entry.prodSha256).toLowerCase()) {
      return { status: "stale", entry, note: `生产侧内容已变（现 sha ${sha.slice(0, 12)}… ≠ 登记值 ${String(entry.prodSha256).slice(0, 12)}…）⇒ 需重新登记` };
    }
  }
  return { status: "ok", entry };
}

// ============================================================================
// 「可回退旧版」判定（2026-09-16 · 卡「修 P9 交接的 Depart 前置超集体检假阳性」）
//
// 现场：Depart 的推前体检跑在采集**之前**，比的是「仓工作副本 vs 本机生产」。本机改了生产文件
//   却还没 -Sync 时，仓里那份就是**本机上一次推送的旧版本** ⇒ 每次都要报「真内容独有行」⇒
//   每轮 fail-closed 挡整轮 Depart（2026-09-16 实测：7 个文件 / 44 行，形态 288 行本机独有 : 45 行仓独有，
//   明确是本机积压）。
//   ⚠️ 不能靠「把体检挪到采集之后」修：robocopy /E 一跑，仓里那份就被覆盖了，体检再也看不见它 ——
//      真正会丢的内容（工作副本里**未提交**的改动）当场消失 = 等于放行。必须在**采集之前**判、且判得准。
//
// 判据（三条件全过才判「可回退」；任一判不出 / git 报错 → 不可回退 = 照旧 fail-closed）：
//   ① **已提交**：工作副本该文件相对 HEAD 无未提交改动 ⇒ 仓侧那批独有行都在 git 对象库里，
//      采集覆盖后可用 `git show <rev>:<path>` 找回。**真正会永久丢的只有未提交内容**（含未提交的手工编辑）。
//   ② **已推送**：该文件 HEAD 版本 == refs/remotes/origin/master 版本 ⇒ 远端另有一份备份。
//   ③ **形态可信**：本机独有行数 ≥ 仓独有行数的 **½**（`REVERSIBLE_SHAPE_RATIO`）⇒ 挡住「仓里有 100 行新内容、
//      本机只有 1 行差异」这种最需要人看的形态（与 rewriteLines 的 balanced 方向性守卫**同口径**）。
//      ⚠️ 这里用 ½ 而不是 1×：本机「重写/精简」同一份内容时行数会减少，1× 口径过严——2026-09-16 实测
//      `dsh/repair-knowledge/20260915-114146-entry.json`（仓独有 6 行 / 本机独有 5 行，单机 repair 记录被本机重写）
//      就被 1× 口径误挡，而它的 git 侧两条件全过（已提交 + 已推送 ⇒ 可恢复）。
//
// ⚠️ 硬约束：
//   · **只新增栏位，uniqueLines 语义一字不改** ⇒ 报告全量列出、严格档 `hasRealRisk` 行为不变。
//   · 2026-09-16 卡「push-gate 对齐」：`dsh-backup-*.ps1 -Push` 挡推门**也**改用 `hasBlockingRisk`
//     （经 CLI `--blocking-only`）⇒ Depart 前置体检与 -Push 门**同一套口径**，不再「同一个门两套判据」。
//   · 放行项一律**显眼列出 + 计数提示**，绝不静默（同 rewriteLines：只降噪、不隐瞒）。
//   · 判不出（非 git 仓 / 无 HEAD / 无上游 ref / git 报错）→ 不可回退（fail-closed）。
//   · 已知边界：本机若刚 `git pull` 了对端内容但**还没分发回生产**，该内容在仓里已提交且已推送 ⇒
//     本判据会判「可回退」放行（内容可在远端/对端找回，非永久丢失）。这是刻意的取舍：此形态归
//     Arrive 分发负责（§5.1 A3），不靠 Depart 挡推兜底；如需收紧，可在 handler 层用对端交接单基线排除。
// ============================================================================

/** 上游 ref（与 dsh-backup-*.ps1 / handoff 的口径一致）。 */
export const UPSTREAM_REF = "refs/remotes/origin/master";

/** 跑一条只关心成败的 git 命令（stdio 全丢）。 */
function gitOk(root, args, timeoutMs = 60_000) {
  const r = spawnSync("git", ["-C", root, ...args], { stdio: "ignore", windowsHide: true, timeout: timeoutMs });
  return r.status === 0;
}

/**
 * 仓级 git 状态快检：repoClean（工作副本相对 HEAD 无改动）+ headPushed（HEAD == 上游）。
 * 两者同时为真 ⇒ 所有 tracked 文件都可判「可回退」（省掉逐文件 git 调用）。
 */
export function probeGitState(root) {
  const st = { available: false, hasHead: false, upstream: UPSTREAM_REF, repoClean: false, headPushed: false };
  try {
    if (!gitOk(root, ["rev-parse", "--verify", "--quiet", "HEAD"])) return st;
    st.hasHead = true;
    st.repoClean = gitOk(root, ["diff", "--quiet", "HEAD"]);
    st.headPushed = gitOk(root, ["diff", "--quiet", "HEAD", UPSTREAM_REF]);
    st.available = true;
  } catch { /* 任何异常都收敛成「不可回退」 */ }
  return st;
}

/**
 * 单文件可回退判定（`root` 下 tracked 文件 `rel`）。
 * @returns {{reversible: boolean, why: string}}
 */
export function fileReversible(root, rel, state) {
  let s = state;
  if (!s) { try { s = probeGitState(root); } catch { s = null; } }
  if (!s?.available || !s.hasHead) return { reversible: false, why: "git 不可用 / 仓无 HEAD（判不出 → fail-closed）" };
  if (s.repoClean && s.headPushed) return { reversible: true, why: "已提交且已推送（仓级快检）" };
  if (!gitOk(root, ["diff", "--quiet", "HEAD", "--", rel])) return { reversible: false, why: "工作副本该文件有未提交改动（覆盖即永久丢失）" };
  if (!gitOk(root, ["diff", "--quiet", "HEAD", UPSTREAM_REF, "--", rel])) return { reversible: false, why: "该文件本地版本尚未推送（上游无备份）" };
  return { reversible: true, why: "已提交且已推送（逐文件核）" };
}

/** 形态可信比例下限：本机独有行数 ≥ 仓独有行数 × 此比例（与 rewriteLines 的 balanced 守卫同口径）。 */
export const REVERSIBLE_SHAPE_RATIO = 0.5;

/** 把一条硬挡项分类（可回退 / 真挡）；判不出 → 真挡。 */
function classifyBlocking(root, rel, gitState, uniqueCount, localCount, ctx = {}) {
  const minLocal = Math.ceil(uniqueCount * REVERSIBLE_SHAPE_RATIO);
  if (localCount < minLocal) {
    // 形态守卫先问一句「是不是正当重写」（2026-10-19 · D-6/R-053）：登记有效 + git 可回退 ⇒ 放行；
    // 任一不满足 ⇒ 照旧硬挡，并把「为什么不放」写进 why（别让人猜）。
    const reg = judgeRegistryEntry(ctx.registry, rel, ctx.prodPath);
    if (reg.status === "ok") {
      const rv = fileReversible(root, rel, gitState);
      if (rv.reversible) {
        const e = reg.entry;
        return {
          reversible: true,
          viaRegistry: e,
          why: `重写登记（${e.asOf ?? "未标日期"}）放行：形态可疑（本机独有 ${localCount} < 仓独有 ${uniqueCount}），但已登记为正当重写 · ${rv.why}${e.reason ? ` · 理由：${e.reason}` : ""}`,
        };
      }
      return { reversible: false, why: `本机独有行 ${localCount} < 仓独有行 ${uniqueCount} 的 ${REVERSIBLE_SHAPE_RATIO * 100}%（下限 ${minLocal}）—— 形态可疑：本机内容明显更少；重写登记命中但内容不可回退（${rv.why}）` };
    }
    const note = reg.status === "none" ? "" : `；登记不可用：${reg.note}`;
    return { reversible: false, why: `本机独有行 ${localCount} < 仓独有行 ${uniqueCount} 的 ${REVERSIBLE_SHAPE_RATIO * 100}%（下限 ${minLocal}）—— 形态可疑：本机内容明显更少${note}` };
  }
  return fileReversible(root, rel, gitState);
}

function isGitCrypt(buf) {
  return buf.length > 16 && buf.subarray(0, 10).toString("latin1").includes("GITCRYPT");
}

function readMaybeText(p) {
  const buf = fs.readFileSync(p);
  if (isGitCrypt(buf)) return { encrypted: true };
  if (buf.includes(0)) return { binary: true, buf };
  return { text: buf.toString("utf8") };
}

/**
 * 体检单个仓。
 * @param {string} name 仓名（REPOS 的键）
 * @param {{root?: string, prod?: string}} [opts] fixture 覆盖：root = 仓路径；prod = 生产根（rel 去掉 dsh/ 前缀后 join）
 * @returns {object} 报告
 */
export function checkRepo(name, opts = {}) {
  const spec = REPOS[name];
  if (!spec && !opts.root) return { repo: name, error: "unknown repo" };
  const root = opts.root ?? spec.root;
  const mapFn = opts.root
    ? (rel) => path.join(opts.prod ?? "", rel.replace(/^dsh\//, ""))
    : spec.map;

  if (!fs.existsSync(path.join(root, ".git"))) return { repo: name, root, error: "工作副本不存在（或不是 git 仓）" };

  const raw = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const files = raw.split("\0").filter(Boolean);

  const res = {
    repo: name, root, tracked: files.length, checked: 0, same: 0,
    onlyInRepo: [], uniqueLines: [], rewriteLines: [], forkedLines: [], binaryDiff: [], forkedBinary: [],
    // 2026-09-16 新增：uniqueLines 的**分类视图**（uniqueLines 本身语义不变，供 .ps1 旧口径继续使用）
    recoverableLines: [], blockingLines: [],
    // 2026-10-19 新增（D-6/R-053）：按「重写登记」放行的项（显式列出，绝不静默）+ 本次生效的登记摘要
    rewriteOverrides: [], registry: null,
    encrypted: 0, skipped: 0, missingInRepo: 0,
    // 行数汇总（供「本机积压未推」形态判定；rewriteLines 降级项也计入 repoOnlyLines）
    repoOnlyLines: 0, localOnlyLines: 0,
    gitState: null,
  };

  // git 状态一次探好（供「可回退旧版」判定；探不出 → 全部按不可回退处理 = fail-closed）
  try { res.gitState = probeGitState(root); } catch { res.gitState = { available: false, hasHead: false, repoClean: false, headPushed: false, upstream: UPSTREAM_REF }; }
  // 重写登记（2026-10-19 · D-6/R-053）：读不出 / JSON 坏 / 形态不合法 ⇒ 零登记（fail-closed，回落形态守卫）
  let registry;
  try { registry = loadRewriteRegistry(); }
  catch (e) { registry = { path: rewriteRegistryPath(), ok: false, entries: [], error: `登记读取异常（零登记）：${e?.message ?? e}` }; }
  res.registry = { path: registry.path, ok: registry.ok, count: registry.entries.length, error: registry.error };

  for (const rel of files) {
    const repoPath = path.join(root, rel);
    const prodPath = mapFn(rel);
    if (!prodPath) { res.skipped++; continue; }
    if (!fs.existsSync(repoPath)) { res.missingInRepo++; continue; }
    res.checked++;
    if (!fs.existsSync(prodPath)) { res.onlyInRepo.push(rel); continue; }

    const a = readMaybeText(repoPath);
    if (a.encrypted) { res.encrypted++; continue; }
    const b = readMaybeText(prodPath);
    if (a.binary || b.binary) {
      if (!fs.readFileSync(repoPath).equals(fs.readFileSync(prodPath))) {
        (isForked(rel) ? res.forkedBinary : res.binaryDiff).push(rel);
      } else { res.same++; }
      continue;
    }
    if (a.text === b.text) { res.same++; continue; }
    const st = diffLineStats(a.text, b.text);
    /** 登记一条硬挡项 + 分类（可回退 / 真挡）；uniqueLines 照旧全收（旧口径不变）。 */
    const pushUnique = (entry) => {
      const cls = classifyBlocking(root, rel, res.gitState, entry.nRaw ?? entry.n, st.localOnly.length, { registry, prodPath });
      res.uniqueLines.push(entry);
      if (cls.reversible) {
        res.recoverableLines.push({ ...entry, why: cls.why });
        if (cls.viaRegistry) {
          res.rewriteOverrides.push({
            rel, n: entry.n, nRaw: entry.nRaw ?? entry.n, localN: st.localOnly.length,
            asOf: cls.viaRegistry.asOf ?? null, reason: cls.viaRegistry.reason ?? null,
          });
        }
      } else res.blockingLines.push({ ...entry, why: cls.why });
    };
    const unique = st.repoOnly;
    if (!unique.length) continue; // 本机是仓的严格超集：仓里没有生产没有的内容 → 无可丢（原行为）
    // 分叉类不参与形态判定：它们**不产生 blocker**（单机状态文件本就预期分叉），
    // 若把它们的独有行计进汇总，会把「本机积压」的真实比例稀释掉（实测：混算 2.60× vs 只算非分叉 6.5×）。
    if (isForked(rel)) { res.forkedLines.push({ rel, n: unique.length, sample: unique.slice(0, 3) }); continue; }
    res.repoOnlyLines += unique.length;
    res.localOnlyLines += st.localOnly.length;
    if (st.localOnly.length > 0) {
      // 两侧**都有**独有行 → 可能只是「本机把这一行改写了」（新旧两版各占一侧），而非「仓方内容要丢」
      // 方向性守卫（保守闸）：改写场景下新旧行**一一对应**，两侧独有行数量级应相当。
      //   若本机独有行远少于仓独有行（< ½）⇒ 本机内容确实更少 ⇒ 可能真丢内容 ⇒ 不降级、照旧硬挡。
      //   注：同时挡住「仓里有 100 行新内容、本机只有 1 行差异」这种最需要人看的形态。
      const balanced = st.localOnly.length >= Math.ceil(unique.length * 0.5);
      const residual = st.repoNormOnly;
      const ratio = residual.length / unique.length;
      if (balanced && (residual.length === 0 || ratio <= REWRITE_RESIDUAL_RATIO)) {
        const rewritten = unique.length - residual.length;
        res.rewriteLines.push({
          rel, n: rewritten, nRaw: unique.length, residual: residual.length,
          localN: st.localOnly.length, sample: unique.slice(0, 3),
        });
        if (residual.length === 0) continue; // 纯改写：仓侧独有行全部有本机新版本对应 → 不挡推
        // ⚠️ 残余：归一化后仓侧**仍独有**的行 → 照旧硬挡（绝不自动放行）
        pushUnique({
          rel, n: residual.length, nRaw: unique.length, rewritten,
          localN: st.localOnly.length, sample: residual.slice(0, 3),
        });
        continue;
      }
    }
    pushUnique({ rel, n: unique.length, nRaw: unique.length, localN: st.localOnly.length, sample: unique.slice(0, 3) });
  }
  return res;
}

/** 严格档：只要 uniqueLines 非空即视为有风险（不缩水口径；CLI 默认退出码 + 回归锚点用）。 */
export function hasRealRisk(report) {
  return (report?.uniqueLines?.length ?? 0) > 0;
}

/**
 * 是否有「**不可回退**的真内容风险」= **唯一挡推判据**（2026-09-16 新增；同日卡「push-gate 对齐」起
 * Depart 前置体检与 `dsh-backup-*.ps1 -Push` 门**共用**这一套）。
 * 与严格档 hasRealRisk 的差别：仓侧独有行若全部来自「本机已提交且已推送」的旧版本 ⇒ git 能找回 ⇒ 不算 blocking。
 * 旧报告对象（无 blockingLines 栏）→ 退回 hasRealRisk 语义（fail-closed，绝不静默放行）。
 */
export function hasBlockingRisk(report) {
  const b = report?.blockingLines;
  if (Array.isArray(b)) return b.length > 0;
  return hasRealRisk(report);
}

/** 人类可读报告行（CLI 打印；.ps1 里用于列文件）。 */
export function formatReport(r) {
  const lines = [];
  if (r.error) { lines.push(`### ${r.repo}: ${r.error}`); lines.push(""); return lines; }
  const risk = r.uniqueLines.length;
  const rewritten = r.rewriteLines?.length ?? 0;
  const recoverable = r.recoverableLines?.length ?? 0;
  const blocking = r.blockingLines?.length ?? 0;
  const overrides = r.rewriteOverrides?.length ?? 0;
  lines.push(`### ${r.repo}  (tracked=${r.tracked} 实检=${r.checked})`);
  lines.push(`  完全相同=${r.same}  仅仓内有=${r.onlyInRepo.length}  **真内容独有行=${risk}**（不可回退 ${blocking} / 可回退旧版 ${recoverable}）  重写登记放行=${overrides}  疑似改写=${rewritten}（不挡推）  二进制不同=${r.binaryDiff.length}  预期分叉=${r.forkedLines.length + r.forkedBinary.length}  加密跳过=${r.encrypted}`);
  if (r.onlyInRepo.length) {
    lines.push("  --- 仅仓内有（未分发回生产；/E 不 purge 不会删，但本机生产看不到）---");
    for (const f of r.onlyInRepo.slice(0, 30)) lines.push("    " + f);
    if (r.onlyInRepo.length > 30) lines.push(`    ...共 ${r.onlyInRepo.length}`);
  }
  if (risk) {
    const recSet = new Set((r.recoverableLines ?? []).map((x) => x.rel));
    lines.push("  --- ⚠️ 真内容独有行（仓里有、生产没有 → -Sync 会丢！推前必须先分发；♻ = 可回退旧版，见下栏）---");
    for (const u of r.uniqueLines.slice(0, 30)) {
      lines.push(`    ${u.rel}  (${u.n} 行)${u.rewritten ? `  ← 同文件另有 ${u.rewritten} 行属改写型（见«疑似改写»栏）` : ""}${recSet.has(u.rel) ? "  ♻" : ""}`);
      for (const s of u.sample) lines.push("        | " + s.slice(0, 100));
    }
    if (r.uniqueLines.length > 30) lines.push(`    ...共 ${r.uniqueLines.length} 个文件`);
  }
  if (recoverable) {
    // 2026-09-16：这类**不参与** Depart 前置体检的挡推判据（hasBlockingRisk），但仍显眼列出——
    // 判据是「本机已提交且已推送」⇒ 覆盖后 git 能找回；只会丢「未提交」内容，那类在 blockingLines 里。
    lines.push("  --- ♻ 可回退旧版（仓侧独有行全部来自**本机已提交且已推送**的版本 ⇒ 采集覆盖后可用 git 找回，**Depart 前置体检不挡**；仍需人眼扫一眼）---");
    for (const u of r.recoverableLines.slice(0, 20)) {
      lines.push(`    ${u.rel}  (${u.n} 行 / 本机独有 ${u.localN} 行；${u.why})`);
      for (const s of u.sample) lines.push("        | " + s.slice(0, 100));
    }
    if (recoverable > 20) lines.push(`    ...共 ${recoverable} 个文件`);
  }
  if (rewritten) {
    // 只降噪、不自动放行：这一栏**不**参与挡推判据，但要显眼列出（明细见下）
    lines.push("  --- ✎ 疑似改写（两侧都有独有行 + 归一化后仓侧独有行消失/≤20% ⇒ 疑为本机改写版本；**不挡推**，仍需人眼扫一眼）---");
    for (const u of r.rewriteLines.slice(0, 20)) {
      lines.push(`    ${u.rel}  (规整差异 ${u.n} 行 / 本机独有 ${u.localN} 行${u.residual ? `；另 ${u.residual} 行归一化后仍独有 → 已按硬挡处理` : ""})`);
      for (const s of u.sample) lines.push("        | " + s.slice(0, 100));
    }
    if (r.rewriteLines.length > 20) lines.push(`    ...共 ${r.rewriteLines.length} 个文件`);
  }
  if (overrides) {
    // 2026-10-19（D-6/R-053）：形态守卫本该硬挡，但该文件已登记为「正当重写」+ git 判可回退 ⇒ 放行。
    // 一律显眼列出（绝不静默放行）：谁被免、按什么理由、登记日期。
    lines.push("  --- 🧾 重写登记放行（形态可疑「本机内容更少」，但**已登记为正当重写**且已提交已推送 ⇒ git 可找回；**不挡推**）---");
    for (const u of r.rewriteOverrides.slice(0, 20)) {
      lines.push(`    ${u.rel}  (仓独有 ${u.nRaw} 行 / 本机独有 ${u.localN} 行；登记 ${u.asOf ?? "未标日期"}${u.reason ? `：${u.reason}` : ""})`);
    }
    if (overrides > 20) lines.push(`    ...共 ${overrides} 个文件`);
  }
  if (r.binaryDiff.length) {
    lines.push("  --- 二进制不同（人工确认哪边新）---");
    for (const f of r.binaryDiff.slice(0, 15)) lines.push("    " + f);
  }
  if (r.forkedLines.length || r.forkedBinary.length) {
    lines.push("  --- ⟳ 分叉类（单机状态文件；⚠️ 覆盖同样会丢仓方独有行，是否可接受需人工判断）---");
    for (const u of r.forkedLines.slice(0, 20)) lines.push(`    ${u.rel}  (${u.n} 行独有)`);
    for (const f of r.forkedBinary.slice(0, 10)) lines.push("    " + f + "  (二进制)");
    if (r.forkedLines.length > 20) lines.push(`    ...共 ${r.forkedLines.length} 个文本文件`);
  }
  lines.push("");
  return lines;
}

/**
 * 结论行 + 建议退出码。
 * @param {object[]} reports
 * @param {{gate?: 'unique'|'blocking'}} [opts]
 *   · gate='unique'（默认，严格档）：`uniqueLines` 非空即 1 —— 人工体检 / 回归锚点口径；
 *   · gate='blocking'：只有 `blockingLines`（判不出可回退的那部分）非空才 1 —— **挡推门口径**
 *     （CLI `--blocking-only`；`dsh-backup-*.ps1 -Push` 与 Depart 前置体检共用）。
 */
export function conclusion(reports, opts = {}) {
  const gate = opts.gate === 'blocking' ? 'blocking' : 'unique';
  const risky = reports.reduce((a, r) => a + (r.uniqueLines?.length ?? 0), 0);
  const forkedTotal = reports.reduce((a, r) => a + ((r.forkedLines?.length ?? 0) + (r.forkedBinary?.length ?? 0)), 0);
  // 「疑似改写」只降噪、不挡推 → 单独计数提示（绝不因它放行，也绝不因它静默）
  const rewriteTotal = reports.reduce((a, r) => a + (r.rewriteLines?.length ?? 0), 0);
  const rewriteNote = rewriteTotal
    ? `；另有 ${rewriteTotal} 项「疑似改写」（归一化后与生产高度重合，不挡推——明细见清单，仍需人眼扫一眼）`
    : "";
  const forkedNote = forkedTotal ? `；另有 ${forkedTotal} 项「分叉类」见清单：覆盖同样会丢仓方独有行，需人工判断可接受性` : "";
  const recoverableTotal = reports.reduce((a, r) => a + (r.recoverableLines?.length ?? 0), 0);
  // 「重写登记放行」= 可回退旧版的**子集**（形态可疑但已登记为正当重写 + git 可回退）→ 单独点名，别静默
  const overridesTotal = reports.reduce((a, r) => a + (r.rewriteOverrides?.length ?? 0), 0);
  const rewriteOverrideNote = overridesTotal
    ? `；其中 ${overridesTotal} 项按「🧾 重写登记」放行（已登记为正当重写 + 已提交且已推送 ⇒ git 可找回，明细见清单）`
    : "";
  const blockingTotal = reports.reduce((a, r) => a + (r.blockingLines?.length ?? 0), 0);
  // 「可回退旧版」在两档口径下说法不同（否则读的人会问「为什么这条没挡」）：
  //   · blocking 档 = 挡推门 → 这类**已放行**；
  //   · unique 档   = 严格档（人工体检）→ 这类仍计入该退出码，需放行请显式加 --blocking-only。
  const recoverableNote = recoverableTotal
    ? (gate === "blocking"
      ? `；另有 ${recoverableTotal} 项属「♻ 可回退旧版」（已提交且已推送 ⇒ 覆盖后 git 可找回，**本门已放行**）`
      : `；其中 ${recoverableTotal} 项属「♻ 可回退旧版」（已提交且已推送 ⇒ 覆盖后 git 可找回；本退出码沿用旧口径，需按挡推门口径放行请加 --blocking-only）`)
    : "";
  const text = gate === "blocking"
    ? (blockingTotal === 0
      ? `✅ 结论：无「不可回退」的真内容独有行 —— 挡推门放行（可照常 -Sync / push）${recoverableNote}${rewriteOverrideNote}${rewriteNote}${forkedNote}`
      : `❌ 结论：${blockingTotal} 个文件存在**不可回退**的真内容独有行（另有 ${recoverableTotal} 项可回退旧版已放行）—— 先分发回生产（或确认可弃）再继续，否则会**永久丢内容**${recoverableNote}${rewriteOverrideNote}${rewriteNote}${forkedNote}`)
    : (risky === 0
      ? `✅ 结论：无「真内容独有行」—— 可安全 -Sync${recoverableNote}${rewriteOverrideNote}${rewriteNote}${forkedNote}`
      : `❌ 结论：${risky} 个文件存在真内容独有行（不可回退 ${blockingTotal} / 可回退旧版 ${recoverableTotal}）—— 先分发回生产（或确认可弃）再 -Sync，否则会丢内容${recoverableNote}${rewriteOverrideNote}${rewriteNote}${forkedNote}`);
  const gateTotal = gate === "blocking" ? blockingTotal : risky;
  return { exitCode: gateTotal === 0 ? 0 : 1, text, gate, gateTotal, risky, rewriteTotal, forkedTotal, recoverableTotal, overridesTotal, blockingTotal };
}
