// dsh-butler / lib/merge-memory.mjs —— 记忆库（SQLite memory.db）跨机语义合并（P9 §4.3 / §17.1 T1 / §17.4 D2）
//
// 定位：**纯函数为主**（去重键、四类分类、并集计划、超集判据、运行键读写），IO 集中在文件尾部。
// 本模块只处理「记忆库」这一个 A 类对象；账本合并仍归 H2b 卡（走 Host API + 单写者窗口）。
//
// 口径（逐条对应卡片，详见 docs\merge-memory跨机合并-使用与验收-20260911.md）：
//   1. 超集判定    本机内容哈希集合 ⊇ 对端 → 整段跳过（isSuperset）
//   2. 内容哈希主键（D2）  规范化正文（trim + 换行归一）sha256 前 16 位为主键；原 id 降级为「显示别名」
//   3. 冲突         同 id、内容哈希不同（= D2 的 id 空间分叉）→ **不自动决胜**，但按 D2=②
//                   （2026-09-15 拍板：id 仅作「显示别名」）**自动并存**：对端内容照样插入，
//                   它的显示 id 在**高位段**（DISPLAY_ID_BASE=1000000 起）按确定性规则分配，
//                   对端原 id 存为显示别名（remoteId/aliasId）。文本本身仍无「谁新谁赢」
//                   —— 时间戳只用于 clockUntrusted 标注（<5min）与 created/updated 极值。
//   4. T1 运行键    {object, remoteCommit, mergedAt}；同一 remoteCommit 已应用 → 整段跳过；
//                   计数/统计类**每次从当前基线重算 + 覆盖写**，绝不 += 累加
//   5. 快照         合并前 VACUUM INTO（由 CLI 调 vacuumIntoSnapshot 落地）
//   6. 标志位       pinned 取并集（任一为真即真）；tags 空格分词取并集（保序：本机在前），报告单列
//   7. 新列（⑤ 包 §3.3 / 施工卡 ⑤-4 增量）  `owner_user` / `visibility` **按列存在性动态读取**（PRAGMA
//                   table_info）—— 旧六列库照旧工作，加列后不再"读不到也写不回"：
//                   插入时带上对端的 owner_user/visibility；**both 场景不覆盖**（visibility 不取并集 =
//                   不扩大可见范围，owner 以本机为准），只在报告里单列。
//   8. 撤回优先（⑤ 包 §3.5c / 施工卡 ⑤-4 增量）  撤回台账（tombstone）参与合并判定：
//                   · `isSuperset` 加优先项：**对端有本机没有的撤回行 ⇒ 不得整段跳过**（否则"本机删了
//                     却被判超集跳过"或"对端删了本机照插"都无人发现）；
//                   · `mergeMemories` 按 `hash + owner` 判据：本机命中 ⇒ 进 `retractPlan`（待删、不保留）；
//                     对端命中 ⇒ 进 `suppressed`（**不许并回**）；对端台账里本机没有的行 ⇒ `adoptedRetractions`
//                     （由 CLI 先写进本机台账，再删——顺序铁律与 memory-retract.mjs 一致）。
//
//   9. 归属过滤（V3 功能面 I3 · 方案 §4 I3 + §9.1 B6 + §9.2，2026-10-22）  **默认关**：
//                   边缘机只收「自己的条目（machine:<本机>）+ 指针（ptr:*）」，中心机全收。
//                   · **未配置 / enabled 不是严格 true ⇒ 一个字节都不变**（mergeMemories 原样返回、
//                     isSuperset 不多一个键）—— 这是本卡的验收底线；
//                   · **fail-closed**：无 `machine:` 标、正文首行也无【设备：…】⇒ `unlabeled`，边缘机不收；
//                   · **接受面 / 转发面分离**（B6）：过滤只决定「哪些条写进本机库」；转发给他机的 payload
//                     必须仍含被过滤的条（`partition.forward.rows` = 未过滤的合并结果 + `auditForwardIntegrity` 实测）；
//                   · **超集闸**：边缘模式下「对端有需过滤的条（filtered>0）」⇒ `isSuperset` 一律 false
//                     （§9.2：否则假稳定 —— 永远超集、永远不写）。
//
//   10. 指针最小件（V3 功能面 I4 前置 · 2026-10-22 16:35「先指针，然后造通道」）  **edge 专用兜底**：
//                   edge 模式下每跳过一条 `foreign` 远端条 ⇒ 计划层产一条 ≤220 字的**指针记忆**
//                   （正文 `【指针】<源机>：<原条前 200 字>`，tags 恰好一个 `ptr:<源机>:<hash16>`，pinned 恒 0）。
//                   只出计划（`partition.pointers.planned`），**写入只在 `--apply` 那一路**（`applyPointerToDb`）；
//                   指针**不算** inserted（自洽式 `onlyRemote = inserted + skipped.total` 一字不破）；
//                   `unlabeled` 无源机 ⇒ 不产指针，单列计数（fail-closed 缺口，见报告「待拍板」）。
//
//   11. 拓扑守卫（V3 功能面 · 2026-10-22 · 评审发现 B / 方案 §9.1 B6 的「防中转」那一半）
//                   配置里只有「我是谁」（`partition.host`），没有「谁是中心」⇒ 新增 `partition.hubHost`。
//                   守卫判据（纯函数 `checkTopologyGuard`）：`enabled===true` ∧ `mode==='edge'` ∧ 本机 role=`driver`
//                   ∧ 对端 hostname 认得出 ∧ 对端 ≠ `hubHostCanonical` ⇒ **拦**（`edge-driver-non-hub`）。
//                   **fail-open 的两态**（写进报告待拍板）：`hubHost` 没配 / 对端 hostname 认不出 ⇒ 只 warning 不拦 ——
//                   今天生产根本没配 hubHost，fail-closed 会把正常同步一刀切断。
//                   `hubHost` 与 `host` **同一套别名归一**（`MACHINE_ALIASES`），坏值只回 warnings 不抛。
//
//   12. 转发副本填充（V3 功能面 · 2026-10-22 · 16:35「然后造通道」）
//                   driver 投递的 `self-memory.db` 是**本机库快照**；edge 模式下本机库没有 foreign 行 ⇒ 快照缺事实。
//                   `applyForwardRowsToDb` 把「未过滤的合并结果」**只插进这份投递副本**（按内容哈希幂等去重 +
//                   `MAX(id)+1` 分配 id，与 `applyPointerToDb` 同一套写库口径），**绝不写回本机库**。
//                   填充失败 ⇒ 上层（`mem-sync-tick`）**整轮不投**（宁可不投，也不让中心悄悄少事实）。
//
//   13. unpin 墓碑（R36-B · 2026-10-30 · 真源 docs\交付报告-r36B-unpin墓碑-20261030.md）
//                   问题：口径 6 的 pinned 并集 ⇒ **单边摘 pin 必然无效**（对端那条还 1，下一轮抬回 1）。
//                   机制：命中「生效墓碑」的 hash，合并结果 `pinned` 恒 0（both 分支 + 插入计划；
//                   **onlyLocal 不压** —— 对端没有这条就没有"被抬回"这个动作）。
//                   载体：记忆库自己的表 `pin_tombstones(hash, unpinned_at, revoked_at, reason, by)`；
//                   跨机靠 `VACUUM INTO` 整库快照自带（零新增传输、零第二个写点）。
//                   撤销：清墓碑写 `revoked_at`（不是删行）—— 撤销也必须能传播，否则重新 pin 会来回抖动。
//                   **默认等价**：清单为空 / 未传 ⇒ 计划逐字段不变、`isSuperset` 不多一个键、报告不出现该段。
//                   转发面体检：墓碑压 0 **不算** `pinnedDowngraded`（单列 `pinnedTombstoned`），否则 edge 会整轮不投。
//
// 与 H2a（lib/merge-pitfalls.mjs）的**语义差异（重要）**：
//   H2a 的基线要「剥离上次注入的远端贡献」，因为坑库 count 是**累加量**；
//   记忆库的合并是**集合插入**（内容哈希去重 + 只补缺），注入过的记忆就是本机真实资产、不该剥离。
//   所以本模块的「基线」= 每次运行重算的本机内容哈希集合，每次**覆盖写**进运行键；`--force` 重跑结果恒等。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { retractionKey, indexRetractions, retractionsDiffKeys } from './retractions.mjs';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../lib/production-guard.mjs';
import { machineAliases as machineAliasesCfg } from '../../lib/host-config.mjs';
import { resolveStatePath } from './state-paths.mjs';
import { writeStateText } from './dual-write.mjs';

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


export const MERGE_MEMORY_LIB_VERSION = '0.6.0';
/** I3 归属过滤子面版本（分类器 / 配置载体 / 转发面体检 / 拓扑守卫 / 转发副本填充；与主版本分开演进）。 */
export const MERGE_MEMORY_PARTITION_VERSION = '0.3.0';
/** R36-B unpin 墓碑子面版本（与主版本分开演进；无墓碑输入时行为与 0.5.0 逐字段相同）。 */
export const MERGE_MEMORY_PIN_TOMBSTONE_VERSION = '0.1.0';
export const MERGE_MEMORY_STATE_SCHEMA = 1;

/** 状态文件路径：统一入口（legacy 期 = `<home>\.dsh\butler-memory-merge-state.json`）。 */
function stateFileOf(name, root) { return resolveStatePath(name, { home: root }).path; }

export const MERGE_MEMORY_STATE_BASENAME = 'butler-memory-merge-state.json';
export const MERGE_MEMORY_OBJECT = 'memories';
export const HASH_PREFIX = 'sha256:';
/** 时钟不可信区（与方案 §4.3 账本口径同源）：updated_at 差 < 5min 视为不可分辨。 */
export const CLOCK_UNTRUSTED_MS = 5 * 60 * 1000;
/** 冲突类型：对端条目 id 已被本机「另一条内容」占用（D2 的历史 id 分叉）。 */
export const CONFLICT_ID_COLLISION = 'id-collision';
/**
 * D2=②（2026-09-15 拍板）：「显示 id 高位段」基址。
 *
 * 撞车条目的显示 id 从这里起按「首个未被占用」确定性分配（升序、跳过已占号）。
 * 为什么不用「本机 max(id)+1」（旧 suggestedId 口径）：对端 id 是 SQLite AUTOINCREMENT 连续递增的，
 * `max+1` 恰是**对端下一个新 id**，下一轮合并又是一次撞车 → 同一内容反复换号、破坏 id 稳定。
 * 高位段 1000000+ 远离两侧现役 id（实测 583/589 量级），分配一次即长期稳定。
 */
export const DISPLAY_ID_BASE = 1_000_000;
/** 撞车已自动并存的处置名（写进 conflicts[].resolution，便于下游区分「历史转人工」与「新口径」）。 */
export const RESOLUTION_RENAMED_DISPLAY_ID = 'renamed-display-id';
/** 治本（C36）：**所有**搬入行都重编号到高位段 → aliases[].kind 用这个值，与「撞车重命名」区分开。 */
export const ALIAS_KIND_BANDED = 'imported-band-renumbered';
/**
 * 号段天花板（治本 C36 · 审核「重要 ①」）：显示 id 只许在 [DISPLAY_ID_BASE, DISPLAY_ID_BAND_LIMIT) 内分配。
 * 为什么必须有：`usedIds` 里同时装着**对端 id**（L1041-1042）⇒ 对端行自带 1e6 号时会把游标推高，
 * 1e6 段消耗近似翻倍（探针 S9 实测：本机从 1000005 起分配）。若不设上限，1e6 段涨到 2e6 就会**静默顶穿**
 * 本机 seq 基数（2e6/3e6/4e6）—— 正是 C36 要治的病。⇒ 追到上限即抛错（fail-closed），绝不换段。
 */
export const DISPLAY_ID_BAND_LIMIT = 1_500_000;
/** 仓1 工作副本里记忆库的相对路径（--from 传目录时自动找）。 */
export const REMOTE_DB_RELATIVE = ['dsh', 'memory', 'memory.db'];
/** SQLite 文件魔数（解密自检用：git-crypt 密文不匹配 → 明确报"未解密"）。 */
export const SQLITE_MAGIC = 'SQLite format 3\0';
/** 记忆库表结构（各机实测一致；单测可用它建临时库）。 */
export const MEMORIES_SCHEMA_DDL = `CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
CREATE INDEX IF NOT EXISTS memories_recent ON memories (updated_at DESC, id DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(text, tags, content='memories', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
  END;`;

// ────────────────────────────── 基础工具（纯） ──────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 数组保底。 */
export function arr(v) {
  return Array.isArray(v) ? v : [];
}

/** 整数化（容错：非法 → dflt）。 */
export function toInt(v, dflt = null) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/** 空格分词（tags 实际形态 = 空格分隔的字符串；实测两侧 365/359 条无逗号分隔）。 */
export function splitTags(tags) {
  return String(tags ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** tags 并集（保序：本机在前；大小写不敏感去重，保留首个原形）。 */
export function unionTags(localTags, remoteTags) {
  const out = [];
  const seen = new Set();
  for (const t of [...splitTags(localTags), ...splitTags(remoteTags)]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.join(' ');
}

/** min/max（null 容错：忽略 null，两侧皆 null → null）。 */
export function minMs(a, b) {
  const xs = [a, b].filter((v) => v !== null && v !== undefined);
  return xs.length ? Math.min(...xs) : null;
}
export function maxMs(a, b) {
  const xs = [a, b].filter((v) => v !== null && v !== undefined);
  return xs.length ? Math.max(...xs) : null;
}

// ────────────────────────────── 规范化 / 内容哈希主键（纯） ──────────────────────────────

/**
 * 正文规范化（D2 口径）：剥 BOM → 换行归一（CRLF / CR → LF）→ trim 首尾空白。
 * 只做这两件事，不做大小写/标点/内部空白的进一步归一（避免把不同记忆误判成同一实体）。
 */
export function normalizeText(text) {
  let s = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, '\n');
  return s.trim();
}

/**
 * 内容哈希主键：规范化正文的 sha256 前 16 位。
 * 16 hex = 64 bit：365+359 条量级的碰撞概率 ~1e-15，可忽略；报告与运行键里更好读。
 */
export function contentHashOf(text) {
  const hex = crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
  return HASH_PREFIX + hex.slice(0, 16);
}

/** 单行归一化：DB 行（snake_case 或驼峰）→ 内部结构；无效行 → null（不抛）。 */
export function normalizeRow(raw) {
  if (!isObj(raw)) return null;
  const id = toInt(raw.id);
  if (id === null) return null;
  if (typeof raw.text !== 'string') return null;
  const text = normalizeText(raw.text);
  return {
    id,
    text,
    tags: unionTags(raw.tags, ''),
    pinned: toInt(raw.pinned) === 1 || raw.pinned === true ? 1 : 0,
    createdAt: toInt(raw.created_at ?? raw.createdAt),
    updatedAt: toInt(raw.updated_at ?? raw.updatedAt),
    hash: contentHashOf(text),
    // ⑤ 包 §3.3 两列（列不存在 / 未迁移时为 null —— 撤回判据要求 owner，缺失由调用方 fail-closed 处理）
    ownerUser: typeof raw.owner_user === 'string' ? raw.owner_user
      : (typeof raw.ownerUser === 'string' ? raw.ownerUser : null),
    visibility: typeof raw.visibility === 'string' ? raw.visibility : null,
  };
}

/**
 * 读入一批行：归一化 + 按 id 升序 + 统计无效/重复。
 * @returns {{rows:object[], invalid:number, dupIds:number[]}}
 */
export function readRows(input) {
  const rows = [];
  let invalid = 0;
  for (const raw of arr(input)) {
    const r = normalizeRow(raw);
    if (!r) { invalid += 1; continue; }
    rows.push(r);
  }
  const seen = new Set();
  const dupIds = [];
  for (const r of rows) {
    if (seen.has(r.id)) dupIds.push(r.id);
    else seen.add(r.id);
  }
  rows.sort((a, b) => a.id - b.id);
  return { rows, invalid, dupIds };
}

/** 集合指纹（顺序无关）：内容哈希 + id + pinned + tags 排序后 sha256 前 16 位。 */
export function listFingerprint(input) {
  const rows = arr(input).map((r) => (isObj(r) && r.hash ? r : normalizeRow(r))).filter(Boolean);
  const norm = rows
    .map((r) => `${r.hash}|${r.id}|${r.pinned}|${r.tags}`)
    .sort();
  return HASH_PREFIX + crypto.createHash('sha256').update(norm.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

// ─────────────────────── 跨机单向收敛：归属分类器（I3 · 纯函数） ───────────────────────
//
// 为什么要有这个：同一批笔记在三台机各存一份，查一件事要在 1800 条里翻三遍（方案 §2）。
// I3 的目标 = 边缘机只收「自己的条目 + 指针」，中心机全收。
//
// 三条硬口径（本卡验收底线，改之前先读）：
//   ① **默认关**：配置没写 / `enabled` 不是严格 `true` ⇒ mergeMemories 原样返回、isSuperset 不多一个键。
//   ② **fail-closed**：没有 `machine:` 标、正文首行也没有【设备：…】⇒ 记 `unlabeled`，边缘机**不收**。
//      理由：存量 1800 条几乎都没标，把它当 own 等于开关根本没生效。
//   ③ **接受面 / 转发面分离**（§9.1 B6）：过滤只作用于「本机可见面」。
//      转发 payload 必须是未过滤的那份 —— 否则 A 机当桥时，B 机的记忆在中心永久消失。

/** 过滤模式。`edge` = 只收自己 + 指针；`hub` = 全收（但照样计数，便于对账）。 */
export const PARTITION_MODES = Object.freeze(['edge', 'hub']);
/** 配置载体文件名（走 resolveStatePath：legacy 期 = `butler-merge-config.json`）。 */
export const PARTITION_CONFIG_BASENAME = 'butler-merge-config.json';
/** 四类归属桶（顺序固定，报告按这个顺序打）。 */
export const PARTITION_BUCKETS = Object.freeze(['own', 'pointer', 'foreign', 'unlabeled']);

/**
 * host 别名表（方案 §9.2：OS hostname 与正文约定**两套都认**，一律小写归一后比）。
 *
 * 来源 = `$BUTLER_MACHINE_ALIASES`（JSON：`{ 规范名: [别名…] }`）；未配置时**只有本机一台**
 * （见 `lib/host-config.mjs#machineAliases`）—— 开源版不预设任何具体机名，拓扑由使用者声明。
 * ⚠️ 新机器请写进环境变量，别在调用点硬编码字符串。
 */
export const MACHINE_ALIASES = Object.freeze(machineAliasesCfg());

/** 任意写法（hostname / 正文约定 / 大小写 / 全角）→ 规范机名（= 别名表的键）；认不出 → null。 */
export function canonicalMachine(value) {
  const raw = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
  const v = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  for (const [key, aliases] of Object.entries(MACHINE_ALIASES)) {
    if (v === key || aliases.includes(v)) return key;
  }
  return null;
}

/** tags 里的 `machine:<值>`（取第一个；大小写不敏感前缀）。没有 → null。 */
export function machineTagOf(tags) {
  const t = splitTags(tags).find((x) => /^machine:/i.test(x));
  if (!t) return null;
  const i = t.indexOf(':');
  return i < 0 ? null : t.slice(i + 1).trim();
}

/**
 * 正文首行里的【设备：xxx】兜底取值（方案 §9.2：存量条只打了正文标、没打 tag）。
 * 括号注释要剥掉：实测存量里有 `【设备：<本机>（含跨机事实）】` 这种写法。
 *
 * 2026-11-02 · 卡「一束光 · 设备行识别补齐」三条补丁（**只增不减**；真源 `docs\判据3尾巴-unknown归因-20261101.md` §4）：
 *   · **P1** 串长上限 80 → 300：存量 5 条设备串 108~261 字，被长度闸整条挡掉 ⇒ 整条判成 unlabeled。
 *   · **P2** 接受半角 `[设备：…]`（存量 2 条是 `[设备：<本机>]` 开头），
 *          并且**匹配必须从行首起**（`^` + `m`）。
 *          为什么锚定：正文里讲代码/举例写出来的 `[设备：…]` 不能当真的设备行。
 *          为什么是"任意一行"的行首：单测 `test-memory-partition.mjs` 要求"第 2 行写设备行也认"。
 *          为什么不干脆把 `[`/`]` 全文替换成全角：实测会把**设备串内部**的方括号也换掉
 *          （#2000325 / #2000340 / #2000341 的设备串里写着 `[M7]` / `[P8-4]`），
 *          于是取值在 `[M7` 处被腰斩 ⇒ 改成正则**按开括号配对**认（全角一套、半角一套），不动正文。
 *          ⚠️ 已量过的代价：存量命中里只有 3 条（#1119/#1120/#1469，形如 `[标题] 【设备：…】`）是非行首命中，
 *             且它们都另有 `machine:*` 标签 ⇒ 桶不变（via=tag），只少一条 cross-check 证据。
 *   · **P3** 首行 `【机器名】`（省了"设备："）兜底：**括号内恰好等于**机器名/别名才认，**不认"包含"**。
 *          🔴 反例守护（这条是 P3 的存在意义）：`【某图进度·2026-09-04 主机B】` 语义是
 *          "关于 主机B 的进度"，不是"在 主机B 写的"；严格版正确地不收它 —— 收进来就是把别台的事记成本机亲历，
 *          比"判不了"糟得多。
 */
export function deviceLineOf(text) {
  const s = normalizeText(text);
  if (!s) return null;
  const firstLine = s.split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? '';
  const win = s.slice(0, 400);
  // P1（上限 300）+ P2（行首锚定 · 全角/半角两套）：首行先试，再试正文前 400 字（任意一行行首）
  const m = DEVICE_LINE_RE_FULL.exec(firstLine) || DEVICE_LINE_RE_HALF.exec(firstLine)
    || DEVICE_LINE_RE_FULL.exec(win) || DEVICE_LINE_RE_HALF.exec(win);
  if (m) return m[1].trim();
  // P3：首行【…】里恰好就是机器名/别名（严格"等于"，不认"包含"）
  const m3 = DEVICE_LINE_NAME_RE.exec(firstLine);
  if (m3 && canonicalMachine(m3[1])) return m3[1].trim();
  return null;
}

/** 设备行主正则（P1 长度上限 300 · P2 行首锚定）。`m` = 行首可以是**任意一行**的行首。 */
const DEVICE_LINE_RE_FULL = /^【设备\s*[：:]\s*([^】\n]{1,300})】/m;
/** 半角版本（P2）：payload 里的 `】` 不算终结符，`]` 才算；两套分开写，避免互相腰斩。 */
const DEVICE_LINE_RE_HALF = /^\[设备\s*[：:]\s*([^\]\n]{1,300})\]/m;
/** P3 兜底：首行【…】不超过 20 字（机器名/别名最长 12 字，20 是安全余量）。 */
const DEVICE_LINE_NAME_RE = /^【([^】]{1,20})】/;

/**
 * 设备串 → 规范机名（剥括号注释 + 按 `/` 切段后认；认不出返回 null）。
 *
 * 2026-11-02 · **P1 的强制配套**：`canonicalMachine` 按整串比，而存量设备串有
 * `<主机A> / <主线名> · …` 这种写法 ⇒ 不切段就永远认不出。🔴 **没有这一条，P1 必须整个放弃**：
 * 放宽长度后那 5 条会从 `unlabeled`（诚实说"不知道"）变成 `foreign`（**谎称"别人的"**），
 * 收益 0 且读数是错的（评估档 §5.1）。
 * 切段只用来**找得到机器**，不改写原串。与 `attrib-ledger.mjs` 的 `parseDeviceString` 同思路；
 * 差别：那边切得更宽（`/ ／ → > + ＋ 、 , ， · |` 与括号、还能拆词），本件只切 `/ ／ ·`
 * —— 宽切段的影响面大两个数量级（评估档 §5.3：另会多认回约 241 条），不在本卡范围内。
 *
 * 🔴 为什么必须在 `/ ／` 之外再认 `·`（2026-11-02 实测，不是拍脑袋）：P1 新放进来的 9 条里
 *   有 2 条写成 `<主机A> · 判据 14-b …` —— 只切 `/` 的话它们会从
 *   `unlabeled` 变成 `foreign`，正是本卡禁止的"把诚实的不知道变成撒谎说是别人的"。
 *   实测把 `·` 加进切段集合 ⇒ 9/9 全部认成 `<主机A>`。
 */
export function machineFromDevice(dev) {
  if (!dev) return null;
  const raw = String(dev);
  const direct = canonicalMachine(raw);
  if (direct) return direct;
  const stripped = stripParenAnnotation(raw);
  const byStrip = canonicalMachine(stripped);
  if (byStrip) return byStrip;
  // P1 配套：`<主机A> / <主线名> · …` —— 按 分隔符拆段，**书写顺序里第一台认得出的**就是它
  const segs = stripped.split(/[\/／·]/);
  if (segs.length > 1) {
    for (const seg of segs) {
      const m = canonicalMachine(seg) ?? canonicalMachine(stripParenAnnotation(seg));
      if (m) return m;
    }
  }
  return null;
}

/** 剥括号注释：`<主机A>（含跨机事实）` → `<主机A>`。 */
function stripParenAnnotation(str) {
  return String(str ?? '').replace(/[（(].*$/, '').replace(/[)）].*$/, '').trim();
}

/**
 * 归属分类（纯）：`own` / `pointer` / `foreign` / `unlabeled`。
 *
 * 判定顺序（**顺序即口径**，改动要同步报告）：
 *   1. tags 里有 `ptr:*` ⇒ `pointer`（指针是「转述给别人看的」，优先于机标；
 *      这样 `ptr:host-b:42 machine:host-b` 这种行在本机上仍会被收 —— 否则「边缘收 ptr」就落不了地）
 *   2. tags 里有 `machine:<值>` ⇒ 值 ≡ 本机 → `own`，否则（含认不出的值、`machine:unknown`）→ `foreign`
 *   3. 正文首行【设备：…】⇒ 值 ≡ 本机 → `own`，否则 → `foreign`
 *   4. 以上都没有 ⇒ `unlabeled`（fail-closed：边缘机不收）
 *
 * @param {{tags?:string, text?:string}} row
 * @param {{host?:string}} [opts] host = 本机（OS 主机名或正文约定都认）
 * @returns {{bucket:'own'|'pointer'|'foreign'|'unlabeled', via:'ptr'|'tag'|'device-line'|'none', machine:string|null, tag:string|null, host:string|null}}
 */
export function classifyOwnership(row, opts = {}) {
  const host = canonicalMachine(opts.host ?? null);
  const r = isObj(row) ? row : {};
  const tags = splitTags(r.tags);
  const ptrTag = tags.find((t) => /^ptr:/i.test(t)) ?? null;
  if (ptrTag) return { bucket: 'pointer', via: 'ptr', machine: null, tag: ptrTag, host };
  const mTag = machineTagOf(r.tags);
  if (mTag !== null && mTag !== '') {
    const m = canonicalMachine(mTag);
    return { bucket: (m && host && m === host) ? 'own' : 'foreign', via: 'tag', machine: m, tag: `machine:${mTag}`, host };
  }
  const dev = deviceLineOf(r.text);
  if (dev) {
    const m = machineFromDevice(dev);
    return { bucket: (m && host && m === host) ? 'own' : 'foreign', via: 'device-line', machine: m, tag: dev, host };
  }
  return { bucket: 'unlabeled', via: 'none', machine: null, tag: null, host };
}

/**
 * 配置归一（纯）：把任意输入（config 对象 / 布尔）变成确定的开关状态。
 * **任何拿不准的情形都回到 off**（fail-closed 到旧行为 —— 少过滤只是没收敛，多过滤会丢数据）。
 * @returns {{enabled:boolean, mode:string|null, host:*, hostCanonical:string|null, reason:string, warnings:string[]}}
 */
export function resolvePartition(opts = {}) {
  const p = isObj(opts) ? opts : {};
  const off = { enabled: false, mode: null, host: null, hostCanonical: null, reason: 'not-configured', warnings: [] };
  if (p.enabled !== true) return { ...off, reason: p.enabled === false ? 'disabled' : 'not-configured' };
  const mode = typeof p.mode === 'string' ? p.mode.trim().toLowerCase() : '';
  if (!PARTITION_MODES.includes(mode)) {
    return {
      ...off,
      reason: `invalid-mode:${String(p.mode)}`,
      warnings: [`partition.mode=${JSON.stringify(p.mode ?? null)} 不在 ${PARTITION_MODES.join('|')} ⇒ 按 off 执行（行为零变化）`],
    };
  }
  const hostRaw = p.host ?? null;
  const hostCanonical = canonicalMachine(hostRaw);
  if (mode === 'edge' && !hostCanonical) {
    return {
      ...off,
      reason: 'host-unknown',
      warnings: [`partition.mode=edge 但 host=${JSON.stringify(hostRaw)} 认不出（支持 ${Object.keys(MACHINE_ALIASES).join('|')} 及其别名）`
        + '⇒ 按 off 执行（拒绝"认不出主机就把对端全丢掉"）'],
    };
  }
  return { enabled: true, mode, host: hostRaw, hostCanonical, reason: 'enabled', warnings: [] };
}

/** 一批行按归属分桶（桶内元素 = `{row, bucket, via, machine, tag, host}`）。 */
export function partitionRows(rows, opts = {}) {
  const part = resolvePartition(opts);
  const counts = { own: 0, pointer: 0, foreign: 0, unlabeled: 0 };
  const buckets = { own: [], pointer: [], foreign: [], unlabeled: [] };
  const list = arr(rows);
  for (const r of list) {
    const c = classifyOwnership(r, { host: part.hostCanonical ?? opts.host ?? null });
    counts[c.bucket] += 1;
    buckets[c.bucket].push({ row: r, ...c });
  }
  return { enabled: part.enabled, mode: part.mode, host: part.hostCanonical, total: list.length, counts, buckets };
}

/** 配置载体路径（与运行键同一套状态文件口径：legacy 期 `butler-merge-config.json`，迁移期 `ops-merge-config.json`）。 */
export function partitionConfigPath(home = process.env.USERPROFILE) {
  return stateFileOf(PARTITION_CONFIG_BASENAME, path.join(home, '.dsh'));
}

/**
 * 中心机身份归一（纯）：只认 `partition.hubHost` 这一个键，与 `host` **同一套别名归一**（`MACHINE_ALIASES`）。
 *
 * 三条 fail-open 口径（本卡验收底线）：
 *   · 没配（缺键 / `null` / 空串）⇒ `hubHostReason='missing'`，**不抛、不改任何既有字段语义**；
 *   · 写了个认不出的值 ⇒ `hubHostReason='unknown'` + 一条 warning（同样不抛）；
 *   · 只回 warnings —— 守卫侧据此"放行 + 告警"（今天生产没配 hubHost，fail-closed 会一刀切断正常同步）。
 *
 * @param {*} hubRaw `partition.hubHost` 的原值
 * @returns {{hubHost:string|null, hubHostCanonical:string|null, hubHostReason:'ok'|'missing'|'unknown', warnings:string[]}}
 */
export function resolveHubHost(hubRaw) {
  const raw = typeof hubRaw === 'string' ? hubRaw.trim() : (hubRaw === null || hubRaw === undefined ? '' : String(hubRaw).trim());
  if (!raw) return { hubHost: null, hubHostCanonical: null, hubHostReason: 'missing', warnings: [] };
  const c = canonicalMachine(raw);
  if (!c) {
    return {
      hubHost: raw, hubHostCanonical: null, hubHostReason: 'unknown',
      warnings: [`partition.hubHost=${JSON.stringify(raw)} 认不出（支持 ${Object.keys(MACHINE_ALIASES).join('|')} 及其别名）`
        + '⇒ 拓扑守卫降级为「放行 + 告警」（不阻断同步）'],
    };
  }
  return { hubHost: raw, hubHostCanonical: c, hubHostReason: 'ok', warnings: [] };
}

/** 从任意 partition 配置（`readPartitionConfig` 产物 / 手写对象）取中心机规范名（纯；取不到 → null）。 */
export function hubHostOf(partition) {
  const p = isObj(partition) ? partition : {};
  if (typeof p.hubHostCanonical === 'string' && p.hubHostCanonical) return p.hubHostCanonical;
  const r = resolveHubHost(p.hubHost ?? p.hubHostCanonical ?? null);
  return r.hubHostCanonical;
}

/**
 * 读配置载体（**只读**；文件不存在 ⇒ off）。
 *
 * 形状：`{ "partition": { "enabled": true, "mode": "edge|hub", "host": "<本机>", "hubHost": "<中心机>" } }`
 * 未写 `partition` 键 / JSON 坏 / 形态不对 ⇒ 一律 off（旧行为），只回 warnings 不抛。
 *
 * 纯增量字段（v0.3.0 起，**既有字段语义一字未动**）：`hubHost` / `hubHostCanonical` / `hubHostReason`。
 * @param {string} file
 * @param {{host?:string}} [opts] host 缺省值（CLI 传 `COMPUTERNAME ?? os.hostname()`）
 */
export function readPartitionConfig(file, opts = {}) {
  const hostDefault = opts.host ?? null;
  const base = {
    path: file ?? null, exists: false, source: 'missing', enabled: false, mode: null,
    host: hostDefault, hostCanonical: canonicalMachine(hostDefault), reason: 'not-configured', warnings: [], raw: null,
    hubHost: null, hubHostCanonical: null, hubHostReason: 'not-configured',
  };
  if (!file) return base;
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return base; }
  const head = { ...base, exists: true, source: 'file' };
  let j;
  try { j = JSON.parse(txt); } catch (e) {
    return { ...head, source: 'corrupt', reason: 'invalid-json', warnings: [`配置读不出 JSON（${e?.message ?? e}）⇒ 按 off 执行：${file}`] };
  }
  if (!isObj(j)) return { ...head, source: 'invalid', reason: 'not-object', warnings: [`配置不是 JSON 对象 ⇒ 按 off 执行：${file}`] };
  const p = isObj(j.partition) ? j.partition : null;
  if (!p) return { ...head, source: 'no-partition-key', reason: 'not-configured' };
  const hostRaw = p.host ?? hostDefault;
  const r = resolvePartition({ enabled: p.enabled, mode: p.mode, host: hostRaw });
  const hub = resolveHubHost(p.hubHost);
  return {
    ...head, enabled: r.enabled, mode: r.mode, host: hostRaw, hostCanonical: r.hostCanonical, reason: r.reason,
    warnings: [...r.warnings, ...hub.warnings], raw: p,
    hubHost: hub.hubHost, hubHostCanonical: hub.hubHostCanonical, hubHostReason: hub.hubHostReason,
  };
}

// ─────────────────────────── 拓扑守卫（纯 · 防「边缘机当中转」） ───────────────────────────
//
// 为什么要有（评审 2026-10-22 发现 B / 方案 §9.1 B6）：
//   B6 的原话是「边缘过滤会切断转发 ⇒ 中心收不全」。它成立的前提是**有一台非中心机做中转**：
//   edge 机同时是 driver ⇒ 它把「自己库的快照」推给"不是中心"的那台 ⇒ 被它过滤掉的事实就永远到不了中心。
//   双机拓扑（A=driver 只推 B=中心；C 无角色）**没有中转这一环** ⇒ 病不存在；
//   所以本件做的不是治病，而是**把"将来变成中转"这种错误配置机械拦住**（一条判据就够）。

/** 守卫判定结果的 reason 取值（报告与夹具都按这些字符串断言，改名要同步夹具）。 */
export const TOPOLOGY_GUARD_REASONS = Object.freeze({
  BLOCKED: 'edge-driver-non-hub',   // ← 唯一会**拦**的一态
  PARTITION_OFF: 'partition-off',   // 归属过滤没开 ⇒ 不适用
  MODE_NOT_EDGE: 'mode-not-edge',   // hub / 全收侧 ⇒ 放行
  ROLE_NOT_DRIVER: 'role-not-driver', // follower 不往外推 ⇒ 放行
  HUB_MISSING: 'hub-host-missing',  // 中心没钉 ⇒ 放行 + warning（待拍板）
  HUB_UNKNOWN: 'hub-host-unknown',  // 中心写坏 ⇒ 放行 + warning
  PEER_UNKNOWN: 'peer-host-unknown', // 对端认不出 ⇒ 放行 + warning
  PEER_IS_HUB: 'peer-is-hub',       // 正是中心 ⇒ 放行
  PEER_UNREACHABLE: 'peer-unreachable', // 对端没连上 ⇒ 本轮没判定（上游自己记 deferred）
});

/**
 * 拓扑守卫（纯 · 可单测）：`edge` 模式的 driver **只许**把快照投给中心机。
 *
 * 拦的判据（缺一不拦）：`partition.enabled===true` ∧ `mode==='edge'` ∧ `role==='driver'`
 *   ∧ 对端 hostname 认得出 ∧ 对端 ≠ `hubHostCanonical`。
 *
 * **fail-open 的两态**（故意的，写进报告「待拍板」）：`hubHost` 没配 / 对端认不出 ⇒ 放行 + warning。
 * 理由：今天生产**根本没配 hubHost**，fail-closed 会把正常同步一刀切断（比"暂时不拦"危险得多）。
 *
 * @param {{hostname?:string, role?:string, partition?:object, peerHostname?:string}} [opts]
 * @returns {{blocked:boolean, reason:string, detail:string, hostname:*, hostCanonical:string|null,
 *            role:string|null, peerHostname:*, peerCanonical:string|null, hubHost:string|null,
 *            hubHostCanonical:string|null, warnings:string[]}}
 */
export function checkTopologyGuard(opts = {}) {
  const { hostname = null, role = null, partition = null, peerHostname = null } = isObj(opts) ? opts : {};
  const p = isObj(partition) ? partition : {};
  const roleL = typeof role === 'string' ? role.trim().toLowerCase() : '';
  const hostCanonical = canonicalMachine(hostname);
  const hub = resolveHubHost(p.hubHost ?? p.hubHostCanonical ?? null);
  const hubCanonical = (typeof p.hubHostCanonical === 'string' && p.hubHostCanonical) ? p.hubHostCanonical : hub.hubHostCanonical;
  const peerCanonical = canonicalMachine(peerHostname);
  const warnings = [];
  const out = {
    blocked: false, reason: '', detail: '',
    hostname: hostname ?? null, hostCanonical, role: roleL || null,
    peerHostname: peerHostname ?? null, peerCanonical,
    hubHost: hub.hubHost, hubHostCanonical: hubCanonical ?? null, warnings,
  };

  if (p.enabled !== true) {
    return { ...out, reason: TOPOLOGY_GUARD_REASONS.PARTITION_OFF, detail: '归属过滤没开（partition.enabled !== true）⇒ 拓扑守卫不适用（放行）' };
  }
  const mode = typeof p.mode === 'string' ? p.mode.trim().toLowerCase() : '';
  if (mode !== 'edge') {
    return { ...out, reason: TOPOLOGY_GUARD_REASONS.MODE_NOT_EDGE, detail: `partition.mode=${JSON.stringify(p.mode ?? null)} 不是 edge（中心侧全收）⇒ 放行` };
  }
  if (roleL !== 'driver') {
    return { ...out, reason: TOPOLOGY_GUARD_REASONS.ROLE_NOT_DRIVER, detail: `本机角色=${JSON.stringify(role ?? null)} 不是 driver（follower 不往外推）⇒ 放行` };
  }
  // ── 以下 = edge + driver：这才需要知道"中心是谁" ──
  if (!hubCanonical) {
    const why = hub.hubHostReason === 'unknown'
      ? `partition.hubHost=${JSON.stringify(hub.hubHost)} 认不出`
      : 'partition.hubHost 没配';
    warnings.push(`${why} ⇒ 拓扑守卫降级为「放行 + 告警」（无法机械判"对端是不是中心"）`);
    if (!peerCanonical) warnings.push(`对端 hostname=${JSON.stringify(peerHostname ?? null)} 认不出 ⇒ 本轮同样不阻断`);
    return {
      ...out,
      reason: hub.hubHostReason === 'unknown' ? TOPOLOGY_GUARD_REASONS.HUB_UNKNOWN : TOPOLOGY_GUARD_REASONS.HUB_MISSING,
      detail: `${why}；本机 ${hostCanonical ?? hostname ?? '?'} 是 driver、对端 ${peerCanonical ?? peerHostname ?? '?'} —— 放行但请补 partition.hubHost`,
    };
  }
  if (!peerCanonical) {
    warnings.push(`对端 hostname=${JSON.stringify(peerHostname ?? null)} 认不出（支持 ${Object.keys(MACHINE_ALIASES).join('|')} 及其别名）`
      + '⇒ 无法机械判"是不是中心"，放行 + 告警');
    return {
      ...out, reason: TOPOLOGY_GUARD_REASONS.PEER_UNKNOWN,
      detail: `对端 hostname=${JSON.stringify(peerHostname ?? null)} 认不出，中心=${hubCanonical} ⇒ 放行 + 告警（不阻断同步）`,
    };
  }
  if (peerCanonical === hubCanonical) {
    return { ...out, reason: TOPOLOGY_GUARD_REASONS.PEER_IS_HUB, detail: `对端 ${peerCanonical} = 中心（partition.hubHost）⇒ 放行` };
  }
  return {
    ...out, blocked: true, reason: TOPOLOGY_GUARD_REASONS.BLOCKED,
    detail: `本机 ${hostCanonical ?? hostname ?? '?'} 是 edge 模式的 driver，但投递目标是 ${peerCanonical}（≠ 中心 ${hubCanonical}）`
      + '⇒ 拒绝把"本机已过滤的快照"当中转投出去（B6：中心会永久少事实）',
  };
}


/**
 * 转发面体检（纯 · B6 的判据本体）：检查投递 payload 是否**原样**保住了每一条对端条目。
 *
 * 判据：对端每个唯一内容哈希都能在 payload 里找到同哈希行，且 `text` 逐字相同、`pinned` 没有被降级。
 * （`tags` 允许变大 —— 合并口径是并集，加标不算丢信息；`id` 允许不同 —— 撞车按 D2=② 换显示 id。）
 *
 * @param {object[]} forwardRows 投递 payload 的行（= 未过滤的合并结果）
 * @param {object[]} remoteInput 对端快照行
 * @param {{host?:string}} [opts]
 */
export function auditForwardIntegrity(forwardRows, remoteInput, opts = {}) {
  const fwdByHash = new Map();
  for (const raw of arr(forwardRows)) {
    const r = normalizeRow(raw);
    if (!r) continue;
    // 行里**自称**的 hash 优先登记：这样"正文被改过、hash 还写着旧值"能被 textMismatch 精确抓到；
    // 没自称 hash（纯文本行）就按正文算 —— 那种情况下改动会表现为 missing，同样是红。
    const claimed = isObj(raw) && typeof raw.hash === 'string' && raw.hash ? raw.hash : r.hash;
    if (!fwdByHash.has(claimed)) fwdByHash.set(claimed, { ...r, hash: claimed });
    if (!fwdByHash.has(r.hash)) fwdByHash.set(r.hash, r);
  }
  const remoteByHash = new Map();
  for (const r of readRows(remoteInput).rows) if (!remoteByHash.has(r.hash)) remoteByHash.set(r.hash, r);
  const missing = [];
  const textMismatch = [];
  const pinnedDowngraded = [];
  // R36-B：墓碑压 0 **不是降级**（有意为之，且 payload 照样保住了这条事实）⇒ 单列 pinnedTombstoned。
  //   否则 edge 模式下体检必红 ⇒ mem-sync-tick 判"副本不完整" ⇒ 整轮不投（把治本变成断流）。
  const tombEffective = effectivePinTombstones(opts.pinTombstones);
  const pinnedTombstoned = [];
  const buckets = { own: 0, pointer: 0, foreign: 0, unlabeled: 0 };
  for (const [hash, r] of remoteByHash) {
    buckets[classifyOwnership(r, { host: opts.host ?? null }).bucket] += 1;
    const f = fwdByHash.get(hash);
    if (!f) { missing.push(hash); continue; }
    if (f.text !== r.text) textMismatch.push(hash);
    if (Number(f.pinned) < Number(r.pinned)) {
      if (Number(f.pinned) === 0 && tombEffective.has(hash)) pinnedTombstoned.push(hash);
      else pinnedDowngraded.push(hash);
    }
  }
  return {
    ok: missing.length === 0 && textMismatch.length === 0 && pinnedDowngraded.length === 0,
    remoteUnique: remoteByHash.size,
    forwardUnique: fwdByHash.size,
    preserved: remoteByHash.size - missing.length,
    missing,
    textMismatch,
    pinnedDowngraded,
    buckets,
    // 无墓碑 ⇒ 这一项不出现（键集合与改前一致）
    ...(tombEffective.size ? { pinnedTombstoned } : {}),
  };
}

// ─────────────────── R36-B unpin 墓碑（治本：摘掉的 pin 不许被对端抬回来） ───────────────────
//
// 问题（2026-10-30 查实）：合并口径是 **pinned 取并集**（口径 6）。所以**单边**摘 pin 必然无效 ——
//   对端那条 `pinned=1`，下一轮合并把它抬回 1，还把 updated_at 刷成对端值（取 max）⇒ 时间戳最新、占住注入池前排。
//   运行键读数：2026-10-26 `flagChanges=21` / 2026-10-30 `flagChanges=18`，而 `resultPinned` **恒 29**。
//
// 机制：**墓碑（tombstone）** —— 「这条被明确摘过 pin」写成一行
//   `{hash, unpinned_at, revoked_at, reason, by}`；合并时命中墓碑的 hash 结果一律 `pinned=0`（不管对端是不是 1）。
//
// 三条硬口径：
//   ① **默认等价**：清单不存在 / 为空（`effective.size === 0`）⇒ 合并计划**逐字段不变**、`isSuperset` 不多一个键、
//      报告的 `pinTombstones` 段不出现。这是本件验收底线（夹具 [1] 有可现跑证明）。
//   ② **跨机靠快照自带**：墓碑写进**记忆库自己的表** `pin_tombstones`，而跨机传的是 `VACUUM INTO` 整库快照
//      ⇒ 墓碑随同一份文件自动双向传播，零新增传输、零第二个写点。理由与代价见交付报告 §2.2。
//   ③ **可撤销且撤销能传播**：清墓碑不是删行而是写 `revoked_at`（LWW：`revoked_at >= unpinned_at` ⇒ 不再压制）。
//      只删行的话对端那份会把它并回来，「哪天想重新 pin」就永远抖动（每轮压 0 → 抬 1 → 再压 0）。
//
// 判定点：`mergeCore` 的 ① both 分支（`pinned = 本地||对端`）与 ② onlyRemote 插入计划。
//   **onlyLocal 不压** —— 对端没有这条就没有「被抬回」这个动作；等它出现在对端那一轮再压（不丢，只延后）。
//   `pinnedDowngraded`（转发面体检）**语义不变**：被墓碑压的 hash 另立 `pinnedTombstoned`，仍算「没降级」
//   （否则 edge 模式下体检必红 ⇒ `mem-sync-tick` 会整轮不投）。

export const PIN_TOMBSTONES_TABLE = 'pin_tombstones';
export const PIN_TOMBSTONES_SCHEMA_DDL = `CREATE TABLE IF NOT EXISTS pin_tombstones (
    hash TEXT PRIMARY KEY,
    unpinned_at INTEGER NOT NULL,
    revoked_at INTEGER,
    reason TEXT,
    by TEXT
  );`;

/** 归一化一条墓碑（DB 行 snake_case / 内部驼峰都认）；坏行 → null（不抛）。 */
export function normalizePinTombstone(raw) {
  if (!isObj(raw)) return null;
  const hash = typeof raw.hash === 'string' ? raw.hash.trim() : '';
  if (!hash) return null;
  const unpinnedAt = toInt(raw.unpinned_at ?? raw.unpinnedAt);
  if (unpinnedAt === null) return null;
  const revokedAt = toInt(raw.revoked_at ?? raw.revokedAt);
  return {
    hash,
    unpinnedAt,
    revokedAt: revokedAt === null ? null : revokedAt,
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
    by: typeof raw.by === 'string' && raw.by ? raw.by : null,
  };
}

/**
 * 墓碑并集（hash 为键）：`unpinnedAt` / `revokedAt` 各取**较大**（= 最近一次动作），reason/by 随较新的摘除。
 * `unpinnedAt` 取 max 而不是 min：重新摘一次必须能覆盖旧的撤销，否则"摘了又摘"永远压不住。
 */
export function mergePinTombstones(...lists) {
  const byHash = new Map();
  for (const list of lists) {
    for (const raw of arr(list)) {
      const t = normalizePinTombstone(raw);
      if (!t) continue;
      const cur = byHash.get(t.hash);
      if (!cur) { byHash.set(t.hash, { ...t }); continue; }
      const newer = t.unpinnedAt >= cur.unpinnedAt;
      byHash.set(t.hash, {
        hash: t.hash,
        unpinnedAt: maxMs(cur.unpinnedAt, t.unpinnedAt),
        revokedAt: maxMs(cur.revokedAt, t.revokedAt),
        reason: (newer ? t.reason : cur.reason) ?? cur.reason ?? null,
        by: (newer ? t.by : cur.by) ?? cur.by ?? null,
      });
    }
  }
  return [...byHash.values()].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}

/**
 * 这条墓碑**此刻生效**吗？
 * 判据 = 没有撤销，或撤销**早于**最近一次摘除。同毫秒（`revokedAt === unpinnedAt`）按**撤销优先**
 *   —— 宁可少压一次（可再摘一次），也别压住一个明确要 pin 回的人。
 */
export function pinTombstoneEffective(raw) {
  const t = normalizePinTombstone(raw);
  if (!t) return false;
  if (t.revokedAt === null || t.revokedAt === undefined) return true;
  return t.revokedAt < t.unpinnedAt;
}

/** 生效集合（Hash Set）：合并/超集判定的唯一输入形态。空集 ⇒ 一切照旧。 */
export function effectivePinTombstones(list) {
  const out = new Set();
  for (const raw of arr(list)) {
    const t = normalizePinTombstone(raw);
    if (t && pinTombstoneEffective(t)) out.add(t.hash);
  }
  return out;
}

// ────────────────────────────── 超集判定（纯） ──────────────────────────────

/**
 * 超集判定：本机内容哈希集合 ⊇ 对端 → 无需合并（整段跳过）。
 *
 * ⚠️ **撤回优先项（⑤ 包 §3.5c 第 2 条 · 施工卡 ⑤-4 增量）**：内容超集**不足以**跳过 —— 只要
 *    「对端有本机没有的撤回行」（`opts.remoteRetractions` ∖ `opts.localRetractions`）⇒ `superset=false`，
 *    必须走到合并计划里去应用撤回。理由（§2.4-③）：本机撤回某条后本机集合不再含该 hash，若无此优先项，
 *    下一轮"本机 ⊇ 对端"成立就整段跳过，撤回永远不传播（或对端删了的条被本机照插回来）。
 *
 * @param {object[]} localInput
 * @param {object[]} remoteInput
 * @param {{localRetractions?:object[], remoteRetractions?:object[]}} [opts]
 * @returns {{superset:boolean, missing:string[], retractionBlock:boolean, missingRetractions:string[], …}}
 */
export function isSuperset(localInput, remoteInput, opts = {}) {
  const local = readRows(localInput).rows;
  const remote = readRows(remoteInput).rows;
  const L = new Set(local.map((r) => r.hash));
  const R = new Map();
  for (const r of remote) if (!R.has(r.hash)) R.set(r.hash, r);
  const missing = [...R.keys()].filter((h) => !L.has(h)).sort();
  // 撤回优先：对端台账里本机尚未知晓（未并入）的撤回行
  const missingRetractions = retractionsDiffKeys(arr(opts.localRetractions), arr(opts.remoteRetractions));
  const retractionBlock = missingRetractions.length > 0;
  // 归属过滤闸（I3 · 方案 §9.2）：边缘模式下对端有 `foreign`/`unlabeled` 条 ⇒ **过滤计数 > 0**
  //   ⇒ 不许判超集。否则会假稳定（永远超集、永远不写，也永远看不到"被滤掉多少"）。
  //   注意分母 = 对端**全部唯一行**（不是"本机缺的那些"）—— 只要对端带着需过滤的条就算。
  const part = resolvePartition(opts.partition);
  let partitionBlock = false;
  let partitionInfo = null;
  if (part.enabled) {
    const b = partitionRows([...R.values()], part);
    const filtered = b.counts.foreign + b.counts.unlabeled;
    partitionBlock = part.mode === 'edge' && filtered > 0;
    partitionInfo = { mode: part.mode, host: part.hostCanonical, ...b.counts, filtered };
  }
  // 墓碑优先（R36-B · 2026-10-30）：本机某条 pin 着、生效墓碑压着它、**且这条对端也有** ⇒ 不许整段跳过。
  //   否则「本机超集」把撤销挡在门外，对端的墓碑永远传不过来（假稳定：永远超集、永远不写）。
  //   只挡「两侧都有」的条：只有本机有的那些按口径**不被墓碑压**（onlyLocal 不压，见墓碑段注释），挡了白跑。
  const tombMerged = mergePinTombstones(arr(opts.localPinTombstones), arr(opts.remotePinTombstones));
  const tombEffective = effectivePinTombstones(tombMerged);
  const tombActive = tombEffective.size > 0;
  const tombstoneBlock = tombActive
    && local.some((r) => r.pinned === 1 && R.has(r.hash) && tombEffective.has(r.hash));
  const out = {
    superset: missing.length === 0 && !retractionBlock && !partitionBlock && !tombstoneBlock,
    contentSuperset: missing.length === 0,
    retractionBlock,
    missingRetractions,
    missing,
    localHashes: L.size,
    remoteHashes: R.size,
    bothHashes: R.size - missing.length,
    onlyLocalHashes: [...L].filter((h) => !R.has(h)).length,
    localFingerprint: listFingerprint(local),
    remoteFingerprint: listFingerprint(remote),
  };
  // 未配置 ⇒ 返回值**一个键都不多**（"未配置 = off、行为与今天一字不差"的可机械验证形态）
  if (part.enabled) {
    out.partitionBlock = partitionBlock;
    out.partition = partitionInfo;
  }
  // 无墓碑 ⇒ 同样一个键都不多（与上面 partition 口径同源）
  if (tombActive) {
    out.tombstoneBlock = tombstoneBlock;
    out.pinTombstones = { merged: tombMerged.length, effective: [...tombEffective].sort() };
  }
  return out;
}

// ────────────────────────────── 合并计划（纯 · 核心） ──────────────────────────────

/**
 * 记忆库合并**主入口** = `mergeCore` + 可选归属过滤（I3 · 方案 §4 I3 / §9.1 B6）。
 *
 * `opts.partition`（`{enabled, mode, host}`）未给、或 `enabled !== true` ⇒ **直接返回 mergeCore 的原对象**
 * （不新增任何字段、不算一次分类）—— 这就是"未配置 = off、行为与今天一字不差"的机械判据。
 * 启用 ⇒ 走 `applyPartitionToPlan`：只过滤「写进本机库」的那部分，另把**未过滤**的转发 payload 一起带出。
 *
 * @param {object[]} localInput
 * @param {object[]} remoteInput
 * @param {{nowMs?:number, localRetractions?:object[], remoteRetractions?:object[],
 *          partition?:{enabled?:boolean, mode?:'edge'|'hub', host?:string}}} [opts]
 */
export function mergeMemories(localInput, remoteInput, opts = {}) {
  const plan = mergeCore(localInput, remoteInput, opts);
  const part = resolvePartition(opts.partition);
  // 未配置 / 关 ⇒ **原样返回**（连一个键都不多）—— "未配置 = off" 的可机械验证形态
  if (!part.enabled) return plan;
  // 墓碑要一起带下去：转发面体检靠它区分「墓碑压 0」与「真降级」（R36-B）
  return applyPartitionToPlan(plan, part, remoteInput, { pinTombstones: plan.pinTombstones?.merged ?? [] });
}

/**
 * 生成合并计划（不碰磁盘）：
 *   - 本机全量保留（顺序按 id 升序）
 *   - 双侧同内容（both）→ pinned / tags 取并集、created_at 取 min、updated_at 取 max
 *   - 仅对端且 id 空闲（onlyRemote）→ 待插入（保留对端 id）
 *   - 仅对端但 id 已被本机另一条内容占用（id 撞车）→ **D2=② 自动并存**：
 *       照样插入，显示 id 取高位段 [DISPLAY_ID_BASE, ∞) 的最小空闲号（确定性），
 *       对端原 id 存为显示别名（conflicts[].aliasId / insertPlan[].remoteId）。
 *       文本本身仍不自动决胜（无「谁新谁赢」）—— 时间戳只用于 clockUntrusted 标注与极值。
 *
 * ⚠️ 内部件：对外一律走 `mergeMemories`（它才带归属过滤）。直接调本函数 = 旧行为（不过滤）。
 *
 * @param {object[]} localInput  本机行（DB 行或内部结构）
 * @param {object[]} remoteInput 对端行
 * @param {{nowMs?:number, localRetractions?:object[], remoteRetractions?:object[]}} [opts]
 *        `localRetractions` / `remoteRetractions` = 两侧撤回台账行（`lib/retractions.mjs` 的 schema）。
 * @returns {{rows:object[], stats:object, aliases:object[], conflicts:object[],
 *            flagChanges:object[], insertPlan:object[], warnings:string[]}}
 */
// ─────────────────── 指针最小件：边缘机「不收别人事实」的兜底（V3 功能面 I4 前置） ───────────────────
//
// 为什么要有这个（2026-10-22 16:35 拍板「**先指针，然后造通道**」）：
//   edge 的接受面 = `machine:<本机>` + `ptr:*`；而 `ptr:` 此前**只有消费者、没有生产者**
//   ⇒ 一开 edge，被过滤的远端条直接消失、本机连"曾经有过这条事实"都不知道 = 边缘机无声变瞎。
//   本件补的就是「每跳过一条别人的事实，就在本机留一条 ≤220 字的指针，且 memory_search 能搜到」。
//
// 形态（**定死**，改动必须同步报告与夹具）：
//   · 触发：`partition.mode === 'edge'` 且该远端行被判 `foreign` 被跳过
//   · 正文：`【指针】<源机规范名>：<原条正文单行化后前 200 字>`，总长 ≤ 220
//   · tags：**恰好一个** `ptr:<源机>:<原条内容哈希前 16 hex>`（不加 `machine:*` —— 会被二次过滤；不碰 pinned 语义）
//   · pinned：恒 0；幂等键 = 这个 `ptr:` 标
//   · 计数：`partition.pointers = {planned, written, skippedExisting, noSourceHost, unlabeledSkipped}`
//   · 指针**不算** insertPlan / inserted（那是"合并进来的行"）⇒ 自洽式不破。

/** 指针正文前缀。 */
export const POINTER_TEXT_PREFIX = '【指针】';
/** 指针正文总长上限（字符）。 */
export const POINTER_TEXT_MAX_CHARS = 220;
/** 原文引用部分上限（字符；留出 `【指针】`+源机名+全角冒号+省略号的余量）。 */
export const POINTER_BODY_MAX_CHARS = 200;
/** 空正文占位（坏输入也不许崩）。 */
export const POINTER_EMPTY_BODY = '（空正文）';

/**
 * 指针正文里引用的那一段（纯）：
 *   `normalizeText`（剥 BOM / 换行归一 / trim）→ **全部连续空白折叠成单空格**（单行化：指针自己不许带换行）
 *   → 取前 200 字（超长补 `…` 表示截断）→ 规范化后为空则用 `（空正文）`。
 * @param {string} text 原条正文
 */
export function pointerBodyOf(text) {
  const s = normalizeText(text).replace(/\s+/g, ' ').trim();
  if (!s) return POINTER_EMPTY_BODY;
  return s.length > POINTER_BODY_MAX_CHARS ? `${s.slice(0, POINTER_BODY_MAX_CHARS)}…` : s;
}

/** 原条内容哈希的 16 位短形（与 `contentHashOf` 同源，去掉 `sha256:` 前缀）。 */
export function pointerHash16Of(text) {
  return contentHashOf(text).slice(HASH_PREFIX.length);
}

/**
 * 由一条被跳过的远端行生成指针（纯 · 可单测）。
 * @param {{text?:string, tags?:string}} row 被跳过的那条远端行
 * @param {{host?:string}} opts host = **源机**规范名（取 `classifyOwnership().machine`）
 * @returns {{row:object|null, key:string|null, sourceHost:string|null, reason:string|null}}
 *          源机认不出（`machine:foo` 这种）⇒ `row=null` + `reason='source-host-unknown'`
 */
export function buildPointerRow(row, opts = {}) {
  const sourceHost = canonicalMachine(opts.host ?? null);
  if (!sourceHost) return { row: null, key: null, sourceHost: null, reason: 'source-host-unknown' };
  const body = pointerBodyOf(row?.text);
  const hash16 = pointerHash16Of(row?.text);
  const text = `${POINTER_TEXT_PREFIX}${sourceHost}：${body}`.slice(0, POINTER_TEXT_MAX_CHARS);
  const key = `ptr:${sourceHost}:${hash16}`;
  return {
    row: {
      text, tags: key, pinned: 0, hash: contentHashOf(text), key, sourceHost,
      sourceHash: `${HASH_PREFIX}${hash16}`,
    },
    key, sourceHost, reason: null,
  };
}

/**
 * 把归属过滤落到合并计划上（纯）：**只动接受面**，转发面留原样。
 *
 * 接受面（本机可见面）= `rows` / `insertPlan`：边缘模式下 `foreign` / `unlabeled` 条目**不写本机库**，
 * 计入 `partition.skipped`；本机原有行**一条不删**（过滤是"收不收"，不是"清不清"）。
 *
 * 转发面（B6）= `partition.forward.rows`：**未经过滤**的合并结果（= 关闭过滤时会产出的那份）。
 * 为什么不能顺手过滤它：driver 投递 payload 取自本机库快照（`mem-sync-tick.mjs` 第 648-668 行调
 * `mem-snapshot-remote.mjs` 产 `self-memory.db`）⇒ 若本机库已滤掉对端条，投给中心的那份也丢了
 * ⇒ 对端的记忆在中心永久消失。故本函数把"该转发的那份"**显式留在结果对象里**，并当场体检。
 *
 * 计数口径（写死在报告里，别猜）：
 *   · `partition.own/pointer/foreign/unlabeled` = 对端**全部唯一行**的分类（分母 = `stats.remoteHashes`）
 *   · `stats.onlyRemote` / `union` / `remoteHashes` 保持**未过滤**口径（分母不因过滤而缩小）
 *   · `stats.inserted` / `stats.resultRows` = 过滤后的**真实**写入数
 *   ⇒ 自洽式：`onlyRemote = inserted + skipped.total`
 */
function applyPartitionToPlan(plan, part, remoteInput, opts = {}) {
  const edge = part.mode === 'edge';
  const seen = new Set();
  const counts = { own: 0, pointer: 0, foreign: 0, unlabeled: 0 };
  for (const r of readRows(remoteInput).rows) {
    if (seen.has(r.hash)) continue;
    seen.add(r.hash);
    counts[classifyOwnership(r, { host: part.hostCanonical }).bucket] += 1;
  }
  const accepted = [];
  const skippedRows = [];
  const skipIds = new Set();
  // 指针最小件：被跳过的 foreign 条 → 一条指针候选（transient：不入 insertPlan / 不进 rows）
  const pointerCandidates = [];
  let pointerNoSourceHost = 0;
  for (const it of plan.insertPlan) {
    const c = classifyOwnership(it, { host: part.hostCanonical });
    if (edge && (c.bucket === 'foreign' || c.bucket === 'unlabeled')) {
      skipIds.add(it.id);
      skippedRows.push({
        id: it.id, hash: it.hash, bucket: c.bucket, via: c.via, tag: c.tag,
        machine: c.machine ?? null, textHead: it.textHead,
      });
      // 只有 foreign 才有「源机」可指；unlabeled 无源机 ⇒ 不产指针（单列计数，见报告「待拍板」）
      if (c.bucket === 'foreign') {
        const p = buildPointerRow(it, { host: c.machine });
        if (p.row) pointerCandidates.push({ ...p.row, skippedId: it.id, skippedHash: it.hash });
        else pointerNoSourceHost += 1;
      }
      continue;
    }
    accepted.push(it);
  }
  const rows = plan.rows.filter((r) => !skipIds.has(r.id));
  // 转发面体检（B6 判据本体）：被过滤的条**必须**仍在 payload 里，且 text/pinned 不被降级
  const audit = auditForwardIntegrity(plan.rows, remoteInput, { host: part.hostCanonical, pinTombstones: opts.pinTombstones ?? [] });
  const warnings = [...plan.warnings];
  if (skippedRows.length) {
    warnings.push(`归属过滤（mode=edge · host=${part.hostCanonical}）：对端 ${skippedRows.length} 条不写本机库`
      + `（foreign ${skippedRows.filter((s) => s.bucket === 'foreign').length} / unlabeled ${skippedRows.filter((s) => s.bucket === 'unlabeled').length}）`
      + `；转发 payload 仍完整（${audit.preserved}/${audit.remoteUnique} 条对端条目在 partition.forward.rows）`);
  }
  if (pointerCandidates.length) {
    warnings.push(`指针最小件：${pointerCandidates.length} 条被跳过的 foreign 条已排入指针计划`
      + `（≤${POINTER_TEXT_MAX_CHARS} 字 / tags 只带 ptr:<源机>:<hash16> / pinned=0）`
      + '；写入只在 --apply 那一路');
  }
  if (pointerNoSourceHost) {
    warnings.push(`指针最小件：${pointerNoSourceHost} 条 foreign 条的源机名认不出（如 machine:foo）⇒ **不产指针**`
      + '（拒绝造 `ptr:unknown:*` 这种假指针）');
  }
  if (skippedRows.some((s) => s.bucket === 'unlabeled')) {
    warnings.push(`指针最小件：${skippedRows.filter((s) => s.bucket === 'unlabeled').length} 条 unlabeled 条被跳过但**无指针**`
      + '（无源机可指；fail-closed 的知识缺口，见交付报告「待拍板」）');
  }
  if (!audit.ok) warnings.push(`⚠️ 转发面体检未过：missing ${audit.missing.length} / text 不一致 ${audit.textMismatch.length} / pinned 降级 ${audit.pinnedDowngraded.length}`);
  return {
    ...plan,
    rows,
    insertPlan: accepted,
    stats: {
      ...plan.stats,
      inserted: accepted.length,
      resultRows: rows.length,
      partitionSkipped: skippedRows.length,
    },
    resultFingerprint: listFingerprint(rows),
    warnings,
    partition: {
      enabled: true,
      mode: part.mode,
      host: part.hostCanonical,
      hostRaw: part.host,
      ...counts,
      remoteUnique: seen.size,
      accepted: accepted.length,
      skipped: {
        total: skippedRows.length,
        foreign: skippedRows.filter((s) => s.bucket === 'foreign').length,
        unlabeled: skippedRows.filter((s) => s.bucket === 'unlabeled').length,
      },
      skippedRows,
      failedClosed: true,
      // 指针最小件（edge 专用兜底）：**只出计划**，写入只在 --apply（applyPointerToDb）那一路。
      //   `rows` = 指针候选行（内存件，供 CLI apply 用；不进 report.json 的 partition 段）
      pointers: {
        planned: pointerCandidates.length,
        written: 0,
        skippedExisting: 0,
        noSourceHost: pointerNoSourceHost,
        unlabeledSkipped: skippedRows.filter((s) => s.bucket === 'unlabeled').length,
        maxChars: POINTER_TEXT_MAX_CHARS,
        bodyMaxChars: POINTER_BODY_MAX_CHARS,
        note: 'dry-run 只出 planned；written/skippedExisting 由 --apply 那一路回填',
        rows: pointerCandidates,
      },
      // 转发面：未过滤的那份（B6 的正解）+ 当场体检结果
      forwardedIntact: audit.ok,
      forward: {
        rows: plan.rows,
        fingerprint: plan.resultFingerprint,
        count: plan.rows.length,
        ok: audit.ok,
        peerRowsPreserved: audit.preserved,
        peerRowsUnique: audit.remoteUnique,
        missing: audit.missing,
        textMismatch: audit.textMismatch,
        note: '转发 payload = **未过滤**的合并结果；过滤只作用于 rows/insertPlan（本机可见面）',
      },
    },
  };
}

/** mergeCore 的正文从这里开始（上方是归属性更强的内部件定义，故意放在前面便于阅读）。 */
function mergeCore(localInput, remoteInput, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const localRead = readRows(localInput);
  const remoteRead = readRows(remoteInput);
  const localRows = localRead.rows;
  const remoteRows = remoteRead.rows;
  const warnings = [];

  // 本机索引：hash → 代表行（id 最小者）、id → 行
  const localByHash = new Map();
  const localById = new Map();
  for (const r of localRows) {
    if (!localByHash.has(r.hash)) localByHash.set(r.hash, r);
    localById.set(r.id, r);
  }
  // 对端索引：hash → 代表行（id 最小者）；其余同 hash 行 = 对端内部重复
  const remoteByHash = new Map();
  const remoteDupRows = [];
  for (const r of remoteRows) {
    if (!remoteByHash.has(r.hash)) remoteByHash.set(r.hash, r);
    else remoteDupRows.push(r);
  }

  const aliases = [];
  const conflicts = [];
  const flagChanges = [];
  const insertPlan = [];
  let both = 0;
  let onlyLocal = 0;

  // ⓪-2 墓碑（R36-B）：两侧清单并集 → 生效集合。**空集 ⇒ 下面每一处 if 都进不去，计划逐字段不变**。
  //   被压的 hash 记进 suppressedHashes（both 一侧）+ suppressedInsertHashes（插入一侧），供报告核对。
  const tombMerged = mergePinTombstones(arr(opts.localPinTombstones), arr(opts.remotePinTombstones));
  const tombEffective = effectivePinTombstones(tombMerged);
  const tombActive = tombEffective.size > 0;
  const suppressedHashes = [];
  const suppressedInsertHashes = [];
  /** 插入计划里的 pinned：撞上生效墓碑 ⇒ 0（并记账）。无墓碑时原样返回（一字节不变）。 */
  const pinnedForInsert = (hash, pinned) => {
    if (pinned !== 1 || !tombEffective.has(hash)) return pinned;
    suppressedInsertHashes.push(hash);
    return 0;
  };

  // ⓪ 撤回优先（⑤ 包 §3.5c · 施工卡 ⑤-4 增量）
  //   判据 = `hash + owner` 双条件（§3.5a）；索引 = 本机台账 ∪ 对端台账（两侧都已撤回的条一视同仁）。
  const localRetractions = arr(opts.localRetractions);
  const remoteRetractions = arr(opts.remoteRetractions);
  const retractIndex = indexRetractions([...localRetractions, ...remoteRetractions]);
  const localRetractKeys = new Set(localRetractions.map((r) => retractionKey(r)).filter(Boolean));
  /** 对端台账里本机没有的行 → 由 CLI **先**并入本机台账，再执行删除（顺序铁律）。 */
  const adoptedRetractions = remoteRetractions.filter((r) => {
    const k = retractionKey(r);
    return k && !localRetractKeys.has(k);
  });
  /** 本机命中撤回判据的条 → 待删（绝不进合并结果集）。 */
  const retractPlan = [];
  /** 对端命中撤回判据的条 → **不许并回**（既不 both 也不 onlyRemote）。 */
  const suppressed = [];

  const keptLocal = [];
  for (const r of localRows) {
    const key = r.ownerUser ? retractionKey({ hash: r.hash, owner: r.ownerUser }) : null;
    if (key && retractIndex.has(key)) {
      retractPlan.push({
        id: r.id, hash: r.hash, owner: r.ownerUser, textHead: textHead(r.text),
        via: localRetractKeys.has(key) ? 'local-ledger' : 'remote-ledger',
      });
      continue;
    }
    keptLocal.push(r);
  }
  if (retractIndex.size && localRows.some((r) => !r.ownerUser)) {
    warnings.push(`本机库有 ${localRows.filter((r) => !r.ownerUser).length} 条无 owner_user（库未加列？）⇒ `
      + '这些条**无法**按「hash + owner」判据匹配撤回（fail-closed：不删、只是撤不掉）');
  }

  // ① 本机侧：both / onlyLocal，并做标志位并集（撤回命中的条已在 ⓪ 被剔除）
  const outRows = keptLocal.map((r) => {
    const remote = remoteByHash.get(r.hash);
    if (!remote) {
      onlyLocal += 1;
      return { ...r };
    }
    if (r.id !== remote.id) {
      aliases.push({
        hash: r.hash,
        localId: r.id,
        remoteId: remote.id,
        kind: 'same-content-different-id',
        textHead: textHead(r.text),
      });
    }
    const tags = unionTags(r.tags, remote.tags);
    let pinned = r.pinned || remote.pinned ? 1 : 0;
    // 墓碑压制（R36-B）：这个 hash 被明确摘过 pin ⇒ 结果里不许出现 1（对端是不是 1 都一样）。
    const tombSuppressed = pinned === 1 && tombEffective.has(r.hash);
    if (tombSuppressed) { pinned = 0; suppressedHashes.push(r.hash); }
    const createdAt = minMs(r.createdAt, remote.createdAt);
    const updatedAt = maxMs(r.updatedAt, remote.updatedAt);
    if (pinned !== r.pinned || tags !== r.tags || updatedAt !== r.updatedAt) {
      flagChanges.push({
        localId: r.id,
        remoteId: remote.id,
        hash: r.hash,
        textHead: textHead(r.text),
        pinnedBefore: r.pinned,
        pinnedAfter: pinned,
        tagsBefore: r.tags,
        tagsAfter: tags,
        updatedAtBefore: r.updatedAt,
        updatedAtAfter: updatedAt,
        pinnedGained: r.pinned === 0 && pinned === 1,
        // 只有被墓碑压过的那条才带这个键（无墓碑时 flagChanges 形状与改前逐字段相同）
        ...(tombSuppressed ? { pinnedSuppressed: true } : {}),
      });
    }
    return { ...r, tags, pinned, createdAt, updatedAt, mergedFromRemoteId: remote.id };
  });

  // ② 对端侧：both 计数 / onlyRemote 待插入 / id 撞车 → D2=② **自动并存**（显示 id 取高位段）
  //
  // 【D2=② 落地（2026-09-15 拍板）】id 只作显示别名 ⇒ 撞车不再挂起等人拍，而是照样插入，
  //   给它分配一个**确定性**的显示 id：
  //     · 取值区间 = 高位段 [DISPLAY_ID_BASE, ∞)（远离两侧现役 id，分配一次长期稳定）；
  //     · 顺序 = 对端条目按 id 升序（与遍历顺序一致）；
  //     · 规则 = 每个撞车条目取「当前未被占用」的最小号（占用集 = 本机 id ∪ 对端 id ∪ 本轮已分配）。
  //   同一份输入的分配结果与遍历/时钟无关 ⇒ 幂等（同一 remote 连跑两次分配一致）。
  const usedIds = new Set();
  for (const r of localRows) usedIds.add(r.id);
  for (const r of remoteRows) usedIds.add(r.id);
  let displayCursor = DISPLAY_ID_BASE;
  const allocDisplayId = () => {
    while (usedIds.has(displayCursor)) displayCursor += 1;
    // 治本（C36）· 天花板 fail-closed：号段耗尽**不许静默换段**（换段 = 把本机新记忆拖进别人的号段）。
    if (displayCursor >= DISPLAY_ID_BAND_LIMIT) {
      const msg = `显示 id 号段耗尽：[${DISPLAY_ID_BASE}, ${DISPLAY_ID_BAND_LIMIT}) 内无空闲号（游标 ${displayCursor}）⇒ 拒绝分配（治本 C36 天花板 · 号段治理见 V31-012）`;
      warnings.push(msg);
      throw new Error(msg);
    }
    const id = displayCursor;
    usedIds.add(id);
    displayCursor += 1;
    return id;
  };
  for (const [hash, r] of [...remoteByHash.entries()].sort((a, b) => a[1].id - b[1].id)) {
    // 撤回优先（⑤ 包 §3.5c）：对端条命中「hash + owner」撤回判据 ⇒ **不许并回**（§2.4-③ 的直接修补）
    const rk = r.ownerUser ? retractionKey({ hash: r.hash, owner: r.ownerUser }) : null;
    if (rk && retractIndex.has(rk)) {
      suppressed.push({
        id: r.id, hash: r.hash, owner: r.ownerUser, textHead: textHead(r.text),
        via: localRetractKeys.has(rk) ? 'local-ledger' : 'remote-ledger',
      });
      continue;
    }
    if (localByHash.has(hash)) { both += 1; continue; }
    const occupied = localById.get(r.id);
    if (occupied) {
      const deltaMs = bothTimesKnown(occupied.updatedAt, r.updatedAt)
        ? Math.abs(occupied.updatedAt - r.updatedAt)
        : null;
      const assignedId = allocDisplayId();
      conflicts.push({
        type: CONFLICT_ID_COLLISION,
        resolution: RESOLUTION_RENAMED_DISPLAY_ID,
        id: r.id,
        aliasId: r.id,
        assignedId,
        remoteHash: r.hash,
        localHash: occupied.hash,
        remoteTextHead: textHead(r.text),
        localTextHead: textHead(occupied.text),
        remoteUpdatedAt: r.updatedAt,
        localUpdatedAt: occupied.updatedAt,
        deltaMs,
        clockUntrusted: deltaMs === null ? null : deltaMs < CLOCK_UNTRUSTED_MS,
        autoResolved: true,
        reason: 'D2=②（2026-09-15 拍板）：id 仅作显示别名 → 撞车条目自动并存、显示 id 取高位段首个空闲号；'
          + '文本本身仍不自动决胜（记忆库无「谁新谁赢」）',
        suggestedId: assignedId,
      });
      aliases.push({
        hash: r.hash,
        localId: assignedId,
        remoteId: r.id,
        kind: RESOLUTION_RENAMED_DISPLAY_ID,
        textHead: textHead(r.text),
      });
      insertPlan.push({
        id: assignedId,
        displayId: assignedId,
        remoteId: r.id,
        aliasId: r.id,
        renamedFromId: r.id,
        renamed: true,
        hash: r.hash,
        text: r.text,
        tags: r.tags,
        // 墓碑压制（R36-B）：对端新条落进来时也不许带 1
        pinned: pinnedForInsert(r.hash, r.pinned),
        createdAt: r.createdAt ?? nowMs,
        updatedAt: r.updatedAt ?? nowMs,
        textHead: textHead(r.text),
        // ⑤ 包 §3.3 两列：随插入落地（列不存在时 applyMergeToDb 会自动退回六列 INSERT）
        ownerUser: r.ownerUser ?? null,
        visibility: r.visibility ?? null,
      });
      continue;
    }
    // 治本（C36）：不撞车也**不保留源 id** —— 源 id 可能是别人的号段（3e6 / 4e6），
    // 显式插入会把本机 sqlite_sequence 顶上去（AUTOINCREMENT 取 max(seq, max(rowid))+1）。
    // 一律落高位段 [DISPLAY_ID_BASE, DISPLAY_ID_BAND_LIMIT)：1e6 < 各机 seq 基数（2e6/3e6/4e6）⇒ seq 不动。
    const bandId = allocDisplayId();
    aliases.push({
      hash: r.hash,
      localId: bandId,
      remoteId: r.id,
      kind: ALIAS_KIND_BANDED,
      textHead: textHead(r.text),
    });
    insertPlan.push({
      id: bandId,
      displayId: bandId,
      remoteId: r.id,
      renamedFromId: r.id,
      renamed: true,
      banded: true,
      hash: r.hash,
      text: r.text,
      tags: r.tags,
      // 墓碑压制（R36-B）：同上 —— 号段重编号这条路也不许把 pin 带进来
      pinned: pinnedForInsert(r.hash, r.pinned),
      createdAt: r.createdAt ?? nowMs,
      updatedAt: r.updatedAt ?? nowMs,
      textHead: textHead(r.text),
      ownerUser: r.ownerUser ?? null,
      visibility: r.visibility ?? null,
    });
  }
  // 治本（C36）报表：搬入重编号 ≠ 撞车重命名 ⇒ 两条语义分开报（conflicts/autoRenamed 仍只数撞车）。
  const bandedCount = insertPlan.filter((p) => p.banded === true).length;
  const aliasCollisions = aliases.filter((a) => a.kind === RESOLUTION_RENAMED_DISPLAY_ID).length;
  if (bandedCount) {
    warnings.push(`搬入重编号 ${bandedCount} 条 → 落 1e6 段（治本 C36；**不是撞车**，撞车计数见 conflicts/autoRenamed）`);
  }

  const rows = [...outRows, ...insertPlan.map((p) => ({ ...p }))]
    .sort((a, b) => a.id - b.id)
    .map((r) => ({
      id: r.id,
      text: r.text,
      tags: r.tags,
      pinned: r.pinned,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      hash: r.hash,
      // ⑤ 包 §3.3 两列：无该列（未迁移）时恒为 null，报告与插入计划据此判断要不要带列
      ownerUser: r.ownerUser ?? null,
      visibility: r.visibility ?? null,
    }));

  const collisions = idCollisions(localRows, remoteRows);
  // D2=②：撞车条目现在全部自动并存（autoResolved=true）→ renamedCount = 本轮自动重命名的条数；
  //        conflicts.length 保留"仍未解决"的语义（新口径下恒为 0，仅旧调用方/历史数据可能非 0）。
  const renamedCount = conflicts.filter((c) => c.autoResolved === true).length;
  if (localRead.invalid || remoteRead.invalid) {
    warnings.push(`存在无效行被跳过（缺 id/text）：本机 ${localRead.invalid} / 对端 ${remoteRead.invalid}`);
  }
  if (localRead.dupIds.length) warnings.push(`本机存在重复 id（理论不该出现）：${localRead.dupIds.slice(0, 5).join(', ')}`);
  if (remoteDupRows.length) warnings.push(`对端内部存在重复内容（同哈希多行）：${remoteDupRows.length} 行，已按 id 最小者参与合并`);
  if (renamedCount) warnings.push(`id 撞车 ${renamedCount} 条 → 按 D2=② 自动并存（显示 id 取高位段 ${DISPLAY_ID_BASE}+，对端原 id 存为别名；不再转人工挂起）`);
  if (conflicts.length - renamedCount > 0) warnings.push(`id 撞车 ${conflicts.length - renamedCount} 条未解决（应恒为 0，请查实现）`);
  if (collisions.length) warnings.push(`两侧 id 空间分叉 ${collisions.length} 个 id（同 id 不同内容；诊断清单见 idCollisions，D2=② 已不据此挂起合并）`);
  if (retractPlan.length) warnings.push(`撤回优先：本机 ${retractPlan.length} 条命中撤回判据（hash+owner）→ 进 retractPlan 待删，**不参与合并结果**`);
  if (suppressed.length) warnings.push(`撤回优先：对端 ${suppressed.length} 条命中撤回判据 → **不许并回**（suppressed）`);
  if (adoptedRetractions.length) warnings.push(`撤回台账：对端 ${adoptedRetractions.length} 行本机未知 → 需并入本机台账（顺序：先写台账 → 再删）`);

  const pinnedLocal = localRows.filter((r) => r.pinned === 1).length;
  const pinnedRemote = remoteRows.filter((r) => r.pinned === 1).length;
  const stats = {
    localRows: localRows.length,
    remoteRows: remoteRows.length,
    localHashes: localByHash.size,
    remoteHashes: remoteByHash.size,
    // 四类计数（按唯一内容哈希计）
    // ⚠️ D2=② 后 union **不含 conflicts**：撞车条目已自动并存、计入 onlyRemote/insertPlan，
    //    再加一次会把并集算大（单测 [3] 有自洽式断言）。
    union: both + onlyLocal + insertPlan.length,
    both,
    onlyLocal,
    onlyRemote: insertPlan.length,
    conflicts: conflicts.length,
    // D2=② 结果分解：撞车自动重命名（并存）条数 —— 四类计数里算在 onlyRemote/inserted 内
    autoRenamed: renamedCount,
    // 新口径下恒为 0（保留字段供旧调用方与历史报告做自洽式：remoteRows = both + onlyRemote + unresolvedConflicts）
    unresolvedConflicts: conflicts.length - renamedCount,
    // id 空间分叉（D2 证据；独立于四类计数）
    idCollisions: collisions.length,
    // 结果
    inserted: insertPlan.length,
    resultRows: rows.length,
    aliases: aliases.length,
    // 治本（C36）报表三分类（方案 §2.2；上面那个原号保留，别删）：搬入重编号 / 同内容异号 / 撞车重命名
    //   · banded    = 不撞车也照样落 1e6 的行（本轮新语义）
    //   · idDrift   = 同内容两侧 id 不同（第二轮起每条 both 带一条）
    //   · collision = 真撞车重命名（与 autoRenamed 同源）
    banded: bandedCount,
    aliasesBanded: bandedCount,
    aliasesCollision: aliasCollisions,
    aliasesIdDrift: aliases.length - bandedCount - aliasCollisions,
    flagChanges: flagChanges.length,
    pinned: {
      local: pinnedLocal,
      remote: pinnedRemote,
      merged: rows.filter((r) => r.pinned === 1).length,
      gained: flagChanges.filter((f) => f.pinnedGained).length,
    },
    dupLocalRows: localRows.length - localByHash.size,
    dupRemoteRows: remoteDupRows.length,
    invalidLocalRows: localRead.invalid,
    invalidRemoteRows: remoteRead.invalid,
    // 撤回优先（⑤ 包 §3.5c · 施工卡 ⑤-4 增量）—— 与四类计数的自洽式：
    //   localRows  = keptLocal + retracted
    //   remoteRows = both + onlyRemote(insertPlan) + suppressed + 未解决冲突 + 对端内部重复
    retracted: retractPlan.length,
    suppressed: suppressed.length,
    retractionsAdopted: adoptedRetractions.length,
    localRowsKept: keptLocal.length,
  };
  // R36-B：只在这轮**真有生效墓碑**时才多这个字段（无墓碑 ⇒ 计划逐字段与 0.5.0 相同）
  if (tombActive) {
    stats.pinTombstones = {
      merged: tombMerged.length,
      effective: tombEffective.size,
      suppressed: suppressedHashes.length,
      suppressedInserted: suppressedInsertHashes.length,
    };
    if (suppressedHashes.length || suppressedInsertHashes.length) {
      warnings.push(`unpin 墓碑：压住 ${suppressedHashes.length + suppressedInsertHashes.length} 条 pin`
        + `（对端 pinned=1 也照样落 0；both ${suppressedHashes.length} / 插入 ${suppressedInsertHashes.length}）`);
    }
  }

  return {
    rows,
    stats,
    aliases,
    conflicts,
    idCollisions: collisions,
    flagChanges,
    insertPlan,
    updates: flagChanges.map((f) => ({
      id: f.localId,
      tags: f.tagsAfter,
      pinned: f.pinnedAfter,
      pinnedBefore: f.pinnedBefore,
      tagsBefore: f.tagsBefore,
      updatedAt: f.updatedAtAfter,
      hash: f.hash,
      textHead: f.textHead,
      pinnedGained: f.pinnedGained,
    })),
    localFingerprint: listFingerprint(localRows),
    remoteFingerprint: listFingerprint(remoteRows),
    resultFingerprint: listFingerprint(rows),
    warnings,
    // 撤回优先产物（无撤回输入时三者恒为空 ⇒ 既有调用方零行为变化）
    retractPlan,
    suppressed,
    adoptedRetractions,
    retractions: { local: localRetractions.length, remote: remoteRetractions.length, index: retractIndex.size },
    // R36-B unpin 墓碑（**无生效墓碑 ⇒ 这个键不出现**，与 partition 口径同源）
    ...(tombActive ? {
      pinTombstones: {
        merged: tombMerged.map((t) => ({ ...t })),
        effective: [...tombEffective].sort(),
        suppressed: { count: suppressedHashes.length, hashes: suppressedHashes },
        suppressedInserted: { count: suppressedInsertHashes.length, hashes: suppressedInsertHashes },
      },
    } : {}),
  };
}

/**
 * id 撞车榜（独立于四类计数）：同一个 id 在两侧都存在、但内容哈希不同。
 * 这是 **D2 的历史 id 空间分叉** 的直接证据，供收口参考；`conflicts` 只装"被挡下没插入"的那些。
 */
export function idCollisions(localInput, remoteInput) {
  const localRows = readRows(localInput).rows;
  const remoteRows = readRows(remoteInput).rows;
  const remoteById = new Map(remoteRows.map((r) => [r.id, r]));
  const out = [];
  for (const l of localRows) {
    const r = remoteById.get(l.id);
    if (!r || r.hash === l.hash) continue;
    const deltaMs = bothTimesKnown(l.updatedAt, r.updatedAt) ? Math.abs(l.updatedAt - r.updatedAt) : null;
    out.push({
      id: l.id,
      localHash: l.hash,
      remoteHash: r.hash,
      localTextHead: textHead(l.text),
      remoteTextHead: textHead(r.text),
      localUpdatedAt: l.updatedAt,
      remoteUpdatedAt: r.updatedAt,
      deltaMs,
      clockUntrusted: deltaMs === null ? null : deltaMs < CLOCK_UNTRUSTED_MS,
    });
  }
  return out;
}

function bothTimesKnown(a, b) {
  return Number.isFinite(a) && Number.isFinite(b);
}

function textHead(text) {
  return normalizeText(text).replace(/\s+/g, ' ').slice(0, 48);
}

// ────────────────────────────── 运行键 / 状态文件（IO） ──────────────────────────────

/** 运行键状态文件路径（本机 ~/.dsh）。 */
export function mergeStatePath(home = process.env.USERPROFILE) {
  return stateFileOf(MERGE_MEMORY_STATE_BASENAME, path.join(home, '.dsh'));
}

/** 本机记忆库默认路径。 */
export function localDbPath(home = process.env.USERPROFILE) {
  return path.join(home, '.dsh', 'memory', 'memory.db');
}

export function emptyMergeState(device = null) {
  return { schemaVersion: MERGE_MEMORY_STATE_SCHEMA, device, updatedAt: null, objects: {} };
}

/** 远端快照标识（remoteCommit 的实际取值）：文件内容 sha256 前 16 位。 */
export function snapshotIdOfBuffer(buf) {
  return HASH_PREFIX + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

export function snapshotIdOfFile(file) {
  return snapshotIdOfBuffer(fs.readFileSync(file));
}

/** 组合运行键：同一 remoteCommit 判定同时锁定「对象 + 对端内容」。 */
export function runKeyOf(object, remoteCommit) {
  return `${object}@${remoteCommit}`;
}

/** 该远端快照是否已应用过（幂等门）。 */
export function isApplied(state, object, remoteCommit) {
  return arr(state?.objects?.[object]?.applied).some((a) => a?.remoteCommit === remoteCommit);
}

export function appliedRecords(state, object) {
  return arr(state?.objects?.[object]?.applied);
}

/** 读运行键状态（不存在 / 损坏 → 空状态，不抛）。 */
export function readMergeState(file) {
  if (!file || !fs.existsSync(file)) return { state: emptyMergeState(), ok: true, existed: false, corrupt: false };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObj(j)) return { state: emptyMergeState(), ok: false, existed: true, corrupt: true };
    return {
      state: {
        schemaVersion: j.schemaVersion ?? MERGE_MEMORY_STATE_SCHEMA,
        device: j.device ?? null,
        updatedAt: j.updatedAt ?? null,
        objects: isObj(j.objects) ? j.objects : {},
      },
      ok: true,
      existed: true,
      corrupt: false,
    };
  } catch {
    return { state: emptyMergeState(), ok: false, existed: true, corrupt: true };
  }
}

/** 原原子写（实现不改）：同目录 tmp → rename；EPERM 回退 copyFile。text 由调用方给一次。 */
function writeMergeStateAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  const pre = gateDestructive({
    targets: [{ path: tmp, label: 'src' }, { path: file, label: 'dst' }], whitelist: [dir], op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse: false, ledgerBypass: false, reason: 'merge-memory 写运行键状态',
  });
  if (!pre.ok) {
    removeGuarded(tmp, { whitelist: [dir], reason: '写状态被拒→回收 tmp' });
    throw new Error(`merge-memory 状态写入被三件套拒绝（${pre.code}）：${pre.reason}`);
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try { removeGuarded(tmp, { whitelist: [dir], reason: 'rename 回退后回收 tmp' }); } catch { /* 忽略 */ }
  }
}

/** 写运行键状态（2c-B8-1：写目标交 dual-write；序列化只发生一次，无尾换行口径不变）。 */
export function writeMergeState(file, state) {
  const r = writeStateText(MERGE_MEMORY_STATE_BASENAME, JSON.stringify(state, null, 2), {
    home: path.dirname(file), write: (p, t) => writeMergeStateAtomic(p, t),
  });
  if (!r.ok) throw new Error(`双写失败（${r.kind ?? 'unknown'}）：${(r.failures?.[0] ?? {}).error ?? 'unknown'}`);
  return file;
}

/**
 * 写一条 apply 运行记录（对象级）。
 * 计数/统计类字段（stats / baseline / digest）**每次覆盖写**，绝不累加（T1）。
 * @returns {object} 新状态（不改原对象）
 */
export function recordApplied(state, {
  object = MERGE_MEMORY_OBJECT, remoteCommit, mergedAt, source = null, remoteDevice = null,
  stats = null, baseline = null, lastOutputFingerprint = null, lastOutputDigest = null,
  lastRemoteRetractionsSha = undefined,
} = {}) {
  const base = isObj(state) ? state : emptyMergeState();
  const objects = { ...(isObj(base.objects) ? base.objects : {}) };
  const cur = isObj(objects[object]) ? objects[object] : { applied: [] };
  const applied = arr(cur.applied).filter((a) => a?.remoteCommit !== remoteCommit);
  applied.push({
    object,
    remoteCommit,
    mergedAt: mergedAt ?? new Date().toISOString(),
    source,
    remoteDevice,
    stats: stats ?? null,
  });
  objects[object] = {
    ...cur,
    applied: applied.slice(-50),
    // 以下三项 = 「从当前基线重算 + 覆盖写」
    stats: stats ?? null,
    baseline: baseline ?? null,
    baselineUpdatedAt: mergedAt ?? new Date().toISOString(),
    lastOutputFingerprint: lastOutputFingerprint ?? cur.lastOutputFingerprint ?? null,
    lastOutputDigest: lastOutputDigest ?? null,
    // ⑤-4：对端撤回台账指纹（幂等门的第二个输入；未给则保留旧值）
    lastRemoteRetractionsSha: lastRemoteRetractionsSha === undefined
      ? (cur.lastRemoteRetractionsSha ?? null)
      : lastRemoteRetractionsSha,
  };
  return { ...base, schemaVersion: base.schemaVersion ?? MERGE_MEMORY_STATE_SCHEMA, updatedAt: new Date().toISOString(), objects };
}

// ────────────────────────────── 对端来源解析（IO） ──────────────────────────────

/**
 * 解析 --from：单个 memory.db 文件，或仓1 工作副本目录（自动找 dsh/memory/memory.db）。
 * @returns {{kind:'file'|'dir', root:string, db:string, gitHead:string|null, encrypted:boolean}}
 */
export function resolveRemoteSource(fromPath) {
  if (!fromPath) throw new Error('--from 需要路径');
  const abs = path.resolve(fromPath);
  if (!fs.existsSync(abs)) throw new Error(`--from 路径不存在：${abs}`);
  const st = fs.statSync(abs);
  let db = null;
  let kind = 'file';
  if (st.isFile()) {
    db = abs;
  } else {
    kind = 'dir';
    const cands = [
      path.join(abs, ...REMOTE_DB_RELATIVE),
      path.join(abs, 'memory', 'memory.db'),
      path.join(abs, 'memory.db'),
    ];
    db = cands.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) ?? null;
    if (!db) throw new Error(`--from 目录里找不到记忆库（试过：${cands.join(' | ')}）`);
  }
  const encrypted = !looksLikeSqlite(db);
  return { kind, root: abs, db, gitHead: kind === 'dir' ? readGitHead(abs) : null, encrypted };
}

/** SQLite 魔数自检（对应方案 §4.3 的「解密自检门」：git-crypt 密文一律拒绝合并）。 */
export function looksLikeSqlite(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === SQLITE_MAGIC;
  } catch {
    return false;
  }
}

/** 尽力读 git HEAD（只读文件，不调 git；失败 → null）。 */
export function readGitHead(dir) {
  try {
    let d = dir;
    for (let i = 0; i < 4; i += 1) {
      const headFile = path.join(d, '.git', 'HEAD');
      if (fs.existsSync(headFile)) {
        const head = fs.readFileSync(headFile, 'utf8').trim();
        const m = /^ref:\s*(.+)$/.exec(head);
        if (!m) return head.slice(0, 40);
        const refFile = path.join(d, '.git', m[1].trim());
        if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim().slice(0, 40);
        return null;
      }
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  } catch { /* 忽略 */ }
  return null;
}

// ────────────────────────────── 记忆库读写（IO · node:sqlite） ──────────────────────────────

async function sqliteModule() {
  return import('node:sqlite');
}

/** 读记忆库（只读）：行 + 元信息。库不存在 → 抛。
 * ⑤-4 增量：列清单走 `PRAGMA table_info`，`owner_user` / `visibility` **存在才读**（旧六列库照旧）。 */
export async function readMemoryDb(dbPath) {
  const { DatabaseSync } = await sqliteModule();
  const st = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
  if (!st || !st.isFile()) throw new Error(`记忆库不存在：${dbPath}`);
  if (!looksLikeSqlite(dbPath)) throw new Error(`不是 SQLite 文件（疑似未解密 / 格式错）：${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.name);
    const extra = ['owner_user', 'visibility'].filter((c) => columns.includes(c));
    const sel = ['id', 'text', 'tags', 'pinned', 'created_at', 'updated_at', ...extra].join(', ');
    const rows = db.prepare(`SELECT ${sel} FROM memories ORDER BY id`).all();
    const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'memories'").get();
    return {
      rows,
      path: dbPath,
      columns,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      seq: seqRow?.seq ?? null,
      count: rows.length,
      pinned: rows.filter((r) => Number(r.pinned) === 1).length,
    };
  } finally {
    db.close();
  }
}

/**
 * 运行键**实际落点**（R36-B 顺带订正 2026-10-30）。
 *
 * 为什么需要：`writeMergeState(file, …)` 走 `dual-write` 的 `writeStateText(BASENAME, …, {home: dirname(file)})`
 *   ⇒ 真正写的是 **`dirname(file)/<状态名>`**，**不是 `file` 本身**。生产里 `--state` 的默认值恰好就是
 *   `<home>\.dsh\butler-memory-merge-state.json` ⇒ `dirname` = `<home>\.dsh` ⇒ 读写同一个文件（零变化）。
 *   但在**沙箱**（夹具传 `--state <tmp>/x-state.json`）里，写落在 `<tmp>/butler-memory-merge-state.json`、
 *   读却去找 `<tmp>/x-state.json` ⇒ **幂等门永远读不到**（T1 在测试里形同虚设）。
 *   本函数按写侧同一口径算读侧落点：读它，读写才一致。
 */
export function mergeStateWritePath(file) {
  return resolveStatePath(MERGE_MEMORY_STATE_BASENAME, { home: path.dirname(path.resolve(String(file))) }).path;
}

// ─────────────────── 墓碑表读写（IO · 写口只有 CLI 调用；合并器只读） ───────────────────

/**
 * 读墓碑清单（只读）。
 * 表不存在 / 库不存在 / 不是 SQLite ⇒ `{items:[], tablePresent:false}`（**不抛**）——
 * 这是「旧版库 / 从没写过墓碑的库」的正常形态，不是错误。
 */
export async function readPinTombstones(dbPath) {
  const base = { items: [], tablePresent: false, path: dbPath ?? null };
  if (!dbPath || !fs.existsSync(dbPath) || !looksLikeSqlite(dbPath)) return base;
  const { DatabaseSync } = await sqliteModule();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const present = Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(PIN_TOMBSTONES_TABLE));
    if (!present) return base;
    const rows = db.prepare(`SELECT hash, unpinned_at, revoked_at, reason, by FROM ${PIN_TOMBSTONES_TABLE}`).all();
    const items = rows
      .map(normalizePinTombstone)
      .filter(Boolean)
      .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    return { items, tablePresent: true, path: dbPath };
  } finally {
    db.close();
  }
}

/**
 * 写墓碑（upsert · 单事务）。
 *
 * 🔴 **空清单 = 零字节变化**：不建表、不写一行（默认等价口径的机械保证 —— 合并器 apply 段会拿它写回并集，
 *    清单为空时必须一个字节都不动，否则"没墓碑的轮次"也会改库）。
 *
 * 幂等：按 hash upsert，取值口径与 `mergePinTombstones` 一致（unpinnedAt / revokedAt 各取较大）。
 *
 * @param {string} dbPath 记忆库（本机库）
 * @param {object[]} items `{hash, unpinnedAt, revokedAt?, reason?, by?}`
 * @returns {Promise<{ok:boolean, written:number, skipped:boolean, tablePresent:boolean, path:string|null}>}
 */
export async function writePinTombstones(dbPath, items) {
  const raw = arr(items).map(normalizePinTombstone).filter(Boolean);
  if (!raw.length) return { ok: true, written: 0, skipped: true, tablePresent: false, path: dbPath ?? null };
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`记忆库不存在：${dbPath ?? '(未给路径)'}`);
  const { DatabaseSync } = await sqliteModule();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(PIN_TOMBSTONES_SCHEMA_DDL);
    const existing = db.prepare(`SELECT hash, unpinned_at, revoked_at, reason, by FROM ${PIN_TOMBSTONES_TABLE}`).all()
      .map(normalizePinTombstone).filter(Boolean);
    const merged = new Map(mergePinTombstones(existing, raw).map((t) => [t.hash, t]));
    const up = db.prepare(`INSERT INTO ${PIN_TOMBSTONES_TABLE} (hash, unpinned_at, revoked_at, reason, by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET unpinned_at = excluded.unpinned_at, revoked_at = excluded.revoked_at,
        reason = excluded.reason, by = excluded.by`);
    let written = 0;
    for (const t of raw) {
      const row = merged.get(t.hash);
      if (!row) continue;
      up.run(row.hash, row.unpinnedAt, row.revokedAt, row.reason, row.by);
      written += 1;
    }
    db.exec('COMMIT');
    return { ok: true, written, skipped: false, tablePresent: true, path: dbPath };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw e;
  } finally {
    db.close();
  }
}

/**
 * 清墓碑 = 写 `revoked_at`（**不是删行**）。
 *
 * 为什么不能删行：墓碑要能**传播**（写进库 → 随 VACUUM 快照到对端）。只在本机删行的话，对端那份下一轮
 * 会把它并回来 ⇒「哪天想重新 pin」变成每轮压 0 → 抬 1 → 再压 0 的抖动。撤销时间戳才是可传播的「反墓碑」。
 *
 * @param {object} opts
 *   `hashes` 指定 hash；`all` 全部；`dryRun`（**默认 true**，函数内第一道门）只算不写。
 * @returns {Promise<{tablePresent:boolean, willRevoke:number, revoked:number, hashes:string[], dryRun:boolean}>}
 */
export async function clearPinTombstones(dbPath, { hashes = null, all = false, revokedAt = Date.now(), dryRun = true } = {}) {
  const out = {
    tablePresent: false, willRevoke: 0, revoked: 0, hashes: [],
    dryRun: dryRun !== false, revokedAt, path: dbPath ?? null,
  };
  if (!dbPath || !fs.existsSync(dbPath) || !looksLikeSqlite(dbPath)) return out;
  const { DatabaseSync } = await sqliteModule();
  const db = new DatabaseSync(dbPath);
  try {
    const present = Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(PIN_TOMBSTONES_TABLE));
    out.tablePresent = present;
    if (!present) return out;
    const rows = db.prepare(`SELECT hash, unpinned_at, revoked_at, reason, by FROM ${PIN_TOMBSTONES_TABLE}`).all()
      .map(normalizePinTombstone).filter(Boolean);
    const want = new Set(arr(hashes).map((h) => String(h).trim()).filter(Boolean));
    const targets = rows.filter((t) => {
      if (!pinTombstoneEffective(t)) return false;   // 已撤销的不用重复写（幂等）
      return all === true ? true : want.has(t.hash);
    });
    out.willRevoke = targets.length;
    out.hashes = targets.map((t) => t.hash);
    if (dryRun !== false || !targets.length) return out;
    db.exec('BEGIN IMMEDIATE');
    const up = db.prepare(`UPDATE ${PIN_TOMBSTONES_TABLE} SET revoked_at = ? WHERE hash = ?`);
    for (const t of targets) { up.run(revokedAt, t.hash); out.revoked += 1; }
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw e;
  } finally {
    db.close();
  }
}

/**
 * VACUUM INTO 一致性快照（方案 §4.3/§8：合并前必须先快照；WAL 下也安全）。
 * @returns {string} 快照文件路径
 */
export async function vacuumIntoSnapshot(srcDbPath, destFile) {
  const { DatabaseSync } = await sqliteModule();
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (fs.existsSync(destFile)) throw new Error(`快照目标已存在，不覆盖：${destFile}`);
  const db = new DatabaseSync(srcDbPath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${String(destFile).replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  if (!fs.existsSync(destFile)) throw new Error(`VACUUM INTO 未产出快照：${destFile}`);
  return destFile;
}

/**
 * 把合并计划落到库上（**单事务**）：插入 onlyRemote + 更新 both 的标志位/时间（+ ⑤-4：按计划删除撤回命中的条）。
 * FTS 由 memories_ai / memories_au / memories_ad 触发器同步，无需手工维护。
 *
 * ⑤ 包 §3.3 两列（施工卡 ⑤-4 增量）：**按库实际列存在性**决定要不要带上 `owner_user` / `visibility` ——
 *   旧六列库（未迁移）行为与旧版**逐字段一致**；加列后对端条自带的两列值会随插入落地（不再"读不到也写不回"）。
 *   ⚠️ `both` 场景**不覆盖**本机两列（`visibility` 不取并集 = 不扩大可见范围，owner 以本机为准），只在报告里单列。
 *
 * @param {string} dbPath
 * @param {object} plan mergeMemories 的产物
 * @param {{deletions?:Array<number|{id:number}>, applyRetractions?:boolean}} [opts]
 *        `deletions` 显式给出待删 id；`applyRetractions:true` 则取 `plan.retractPlan`。
 *        两者都不给 ⇒ **零删除**（默认行为，与旧版一致）。
 * @returns {{inserted:number, updated:number, deleted:number}}
 */
export async function applyMergeToDb(dbPath, plan, opts = {}) {
  const { DatabaseSync } = await sqliteModule();
  const db = new DatabaseSync(dbPath);
  const out = { deletedIds: [] };
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  try {
    const cols = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.name);
    const extra = ['owner_user', 'visibility'].filter((c) => cols.includes(c));
    const delSrc = arr(opts.deletions).length ? arr(opts.deletions) : (opts.applyRetractions ? arr(plan?.retractPlan) : []);
    const delIds = delSrc.map((d) => (typeof d === 'number' ? d : d?.id)).filter((n) => Number.isFinite(n));
    const sqlPlain = 'INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)';
    const sqlExtra = extra.length
      ? `INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, ${extra.join(', ')}) VALUES (?, ?, ?, ?, ?, ?${extra.map(() => ', ?').join('')})`
      : sqlPlain;
    db.exec('BEGIN IMMEDIATE');
    const insPlain = db.prepare(sqlPlain);
    const insExtra = extra.length ? db.prepare(sqlExtra) : null;
    for (const it of arr(plan.insertPlan)) {
      const vals = extra.map((c) => (c === 'owner_user' ? it.ownerUser : it.visibility));
      const allPresent = extra.length > 0 && vals.every((v) => typeof v === 'string' && v.length > 0);
      const base = [it.id, it.text, it.tags ?? '', it.pinned ? 1 : 0, it.createdAt ?? 0, it.updatedAt ?? 0];
      if (allPresent) insExtra.run(...base, ...vals);
      else insPlain.run(...base); // 缺值 ⇒ 不带该列（走库默认值，避免撞 NOT NULL）
      inserted += 1;
    }
    const upd = db.prepare('UPDATE memories SET tags = ?, pinned = ?, updated_at = ? WHERE id = ? AND (tags <> ? OR pinned <> ? OR updated_at <> ?)');
    for (const it of arr(plan.updates)) {
      const r = upd.run(it.tags ?? '', it.pinned ? 1 : 0, it.updatedAt ?? 0, it.id, it.tags ?? '', it.pinned ? 1 : 0, it.updatedAt ?? 0);
      updated += Number(r?.changes ?? 0);
    }
    // ⑤-4 撤回优先：删除命中 (hash + owner) 的本机条（FTS 靠 memories_ad 触发器同步）
    const deletedIds = [];
    if (delIds.length) {
      const del = db.prepare('DELETE FROM memories WHERE id = ?');
      for (const id of delIds) {
        const n = Number(del.run(id)?.changes ?? 0);
        deleted += n;
        if (n > 0) deletedIds.push(id);
      }
    }
    db.exec('COMMIT');
    out.deletedIds = deletedIds;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw e;
  } finally {
    db.close();
  }
  return { inserted, updated, deleted, deletedIds: out.deletedIds };
}

/**
 * 把**指针计划**落到库上（单事务）：指针最小件的唯一写口（只有 CLI `--apply` 会调）。
 *
 * 为什么单独一个函数 / 单独一个事务（而不是塞进 `applyMergeToDb`）：
 *   · `applyMergeToDb` 的返回被 CLI 的自洽式与期望行数直接用（`inserted/deleted/updated`），
 *     指针**不是**"合并进来的行" ⇒ 混进去会把 `onlyRemote = inserted + skipped.total` 的口径搅浑；
 *   · 指针写失败**不该**连累已经合并好的行 —— 单独事务 + 单独计数，失败只退指针这一批（事务内 ROLLBACK）。
 *
 * id 分配（方案二选一，本件选 ①，理由见下）：
 *   ① **同事务内 `COALESCE(MAX(id),0)+1` 递增**（本件采用）
 *   ② 复用既有分配器 —— **不存在**：`memories.id` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`，
 *      库里没有任何显式 id 分配器（`DISPLAY_ID_BASE` 那套只用于「合并撞车的显示 id」，是内存计划件、不写库）。
 *   ⇒ 用 ①：单事务内取 max 再逐条 +1，天然不撞既有 id、不改既有行 id；
 *     显式插入后 SQLite 会把 `sqlite_sequence` 推到「已插入的最大 id」⇒ 后续 AUTOINCREMENT 继续顺延，不冲突。
 *   ⚠️ 并发写者（DSH 主进程）在同一时刻插入时由 SQLite 写锁串行化；`BEGIN IMMEDIATE` 先取写锁再读 max。
 *
 * 幂等：幂等键 = 指针自带的 `ptr:<源机>:<hash16>` 标签。
 *   命中判定 = `(' ' || tags || ' ') LIKE '% <key> %'`（按**空格分隔的整词**匹配，不是子串 —— hash16 前缀相同的另一条不会被误判）。
 *   已存在 ⇒ `skippedExisting += 1`，**不新增、不改既有行**。
 *
 * FTS：`memories_ai` 触发器自动同步（`MEMORIES_SCHEMA_DDL` L121-123）；夹具 [7] 用 `MATCH` 实测召回。
 *
 * @param {string} dbPath
 * @param {object[]} pointers `plan.partition.pointers.rows`（`{text, tags, pinned, key, sourceHost, sourceHash}`）
 * @param {{nowMs?:number}} [opts]
 * @returns {{written:number, skippedExisting:number, ids:number[]}}
 */
export async function applyPointerToDb(dbPath, pointers, opts = {}) {
  const { DatabaseSync } = await sqliteModule();
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const out = { written: 0, skippedExisting: 0, ids: [] };
  const list = arr(pointers).filter((p) => isObj(p) && typeof p.text === 'string' && typeof p.key === 'string' && p.key);
  if (!list.length) return out;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const hit = db.prepare("SELECT id FROM memories WHERE (' ' || tags || ' ') LIKE ? LIMIT 1");
    const ins = db.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    let next = Number(db.prepare('SELECT COALESCE(MAX(id), 0) m FROM memories').get().m) + 1;
    for (const p of list) {
      if (hit.get(`% ${p.key} %`)) { out.skippedExisting += 1; continue; }
      ins.run(next, p.text, p.tags ?? p.key, p.pinned ? 1 : 0, nowMs, nowMs);
      out.ids.push(next);
      out.written += 1;
      next += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw e;
  } finally {
    db.close();
  }
  return out;
}

/**
 * 把**转发面**（未过滤的合并结果）填进**投递副本**（单事务）—— 转发通道的唯一写口（V3 · B6 正解）。
 *
 * 为什么写在副本上而不是本机库：投递 payload = driver 的 `self-memory.db`（本机库的 `VACUUM INTO` 副本）。
 *   edge 模式下本机库**故意**不含 foreign 行 ⇒ 这份副本天然缺那些事实 ⇒ 中心收不全（B6）。
 *   把 `partition.forward.rows` 只插进副本，**本机库一个字节都不写**（"边缘机不收别人事实"的语义不被破）。
 *
 * 写库口径与 `applyPointerToDb` 同源（不手写另一套 SQL）：
 *   · 单事务 `BEGIN IMMEDIATE`；id = 同事务内 `COALESCE(MAX(id),0)+1` 递增（不改既有行 id）；
 *   · 幂等：按**内容哈希**（`contentHashOf(text)`）判已在副本里 ⇒ `skippedExisting += 1`（不新增、不改行）；
 *   · ⑦ 包两列（`owner_user` / `visibility`）**按列存在性**决定带不带（旧六列副本照样能写）；
 *   · FTS 由 `memories_ai` 触发器自动同步。
 *
 * 失败语义（**故意 fail-loud**）：副本不存在 / 不是记忆库 / 行里有无效条 ⇒ **抛错**。
 *   上层（`mem-sync-tick`）据此**整轮不投**，绝不拿"不完整副本"冒充完整（宁可中心晚一轮，也不静默少事实）。
 *
 * @param {string} dbPath 投递副本路径（`<tmp>/self-memory.db`）
 * @param {object[]} forwardRows `plan.partition.forward.rows`（`{id,text,tags,pinned,createdAt,updatedAt,hash,...}`）
 * @param {{nowMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, inserted:number, skippedExisting:number, invalid:number, ids:number[],
 *            existingHashes:number, beforeRows:number|null, afterRows:number|null, file:string}>}
 */
export async function applyForwardRowsToDb(dbPath, forwardRows, opts = {}) {
  const { DatabaseSync } = await sqliteModule();
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const list = arr(forwardRows);
  const out = {
    ok: true, inserted: 0, skippedExisting: 0, invalid: 0, ids: [],
    existingHashes: 0, beforeRows: null, afterRows: null, file: dbPath ?? null,
  };
  if (!list.length) return out;
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`投递副本不存在：${dbPath ?? '(未给路径)'}（拒绝在没有副本时"假装填好"）`);
  if (!looksLikeSqlite(dbPath)) throw new Error(`投递副本不是 SQLite：${dbPath}`);
  const db = new DatabaseSync(dbPath);
  try {
    const cols = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.name);
    if (!cols.includes('id') || !cols.includes('text')) throw new Error(`投递副本不是记忆库形态（缺 id/text 列）：${dbPath}`);
    const extra = ['owner_user', 'visibility'].filter((c) => cols.includes(c));
    const existing = new Set(db.prepare('SELECT text FROM memories').all().map((r) => contentHashOf(r.text)));
    out.existingHashes = existing.size;
    out.beforeRows = Number(db.prepare('SELECT COUNT(*) n FROM memories').get().n);
    const norm = [];
    for (const raw of list) {
      const r = normalizeRow(raw);
      if (!r) { out.invalid += 1; continue; }
      norm.push(r);
    }
    // fail-loud：无效行 = 我们算不出这条事实的哈希 ⇒ 无法保证"副本完整" ⇒ 拒绝写、让上层整轮不投
    if (out.invalid) throw new Error(`forward 行里有 ${out.invalid} 条无效（缺 id 或 text）⇒ 拒绝把"不完整副本"投出去`);
    const sqlPlain = 'INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)';
    const sqlExtra = extra.length
      ? `INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, ${extra.join(', ')}) VALUES (?, ?, ?, ?, ?, ?${extra.map(() => ', ?').join('')})`
      : sqlPlain;
    db.exec('BEGIN IMMEDIATE');
    const insPlain = db.prepare(sqlPlain);
    const insExtra = extra.length ? db.prepare(sqlExtra) : null;
    let next = Number(db.prepare('SELECT COALESCE(MAX(id), 0) m FROM memories').get().m) + 1;
    for (const r of norm) {
      if (existing.has(r.hash)) { out.skippedExisting += 1; continue; }
      const base = [next, r.text, r.tags ?? '', r.pinned ? 1 : 0, r.createdAt ?? nowMs, r.updatedAt ?? nowMs];
      const vals = extra.map((c) => (c === 'owner_user' ? r.ownerUser : r.visibility));
      const allPresent = extra.length > 0 && vals.every((v) => typeof v === 'string' && v.length > 0);
      if (allPresent) insExtra.run(...base, ...vals);
      else insPlain.run(...base);          // 缺值 ⇒ 不带该列（走库默认值，避免撞 NOT NULL）
      existing.add(r.hash);
      out.ids.push(next);
      out.inserted += 1;
      next += 1;
    }
    db.exec('COMMIT');
    out.afterRows = Number(db.prepare('SELECT COUNT(*) n FROM memories').get().n);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    out.ok = false;
    throw e;
  } finally {
    db.close();
  }
  return out;
}

/**
 * 合并后校验：integrity_check + 行数 + FTS 一致性。
 * 注：FTS5 的 `integrity-check` 走 INSERT 语句触发 → **需要读写连接**（SQLite 视为写事务）；
 *     拿不到写连接时该项标记 skipped 且不计失败（其余检查照跑），不会让校验假红。
 */
export async function verifyMemoryDb(dbPath, { expectRows = null, expectPinned = null } = {}) {
  const { DatabaseSync } = await sqliteModule();
  let db;
  let openedReadOnly = false;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    db = new DatabaseSync(dbPath, { readOnly: true });
    openedReadOnly = true;
  }
  const out = { ok: true, checks: [], failures: [] };
  const push = (name, ok, detail = '') => {
    out.checks.push({ name, ok, detail });
    if (!ok) { out.ok = false; out.failures.push(`${name}${detail ? `：${detail}` : ''}`); }
  };
  try {
    const integ = db.prepare('PRAGMA integrity_check').all();
    const integOk = integ.length === 1 && String(integ[0].integrity_check).toLowerCase() === 'ok';
    push('integrity_check', integOk, integOk ? '' : JSON.stringify(integ).slice(0, 120));
    const n = db.prepare('SELECT COUNT(*) n FROM memories').get().n;
    const p = db.prepare('SELECT COUNT(*) n FROM memories WHERE pinned = 1').get().n;
    push('row_count', expectRows === null || Number(n) === Number(expectRows), `实际 ${n} / 期望 ${expectRows ?? '—'}`);
    push('pinned_count', expectPinned === null || Number(p) === Number(expectPinned), `实际 ${p} / 期望 ${expectPinned ?? '—'}`);
    // FTS 一致性：fts5 integrity-check（external content 表支持）
    if (openedReadOnly) {
      out.checks.push({ name: 'fts_integrity_check', ok: true, skipped: true, detail: '只读连接跳过（FTS integrity-check 需写事务）' });
    } else {
      try {
        db.exec("INSERT INTO memories_fts (memories_fts) VALUES ('integrity-check')");
        push('fts_integrity_check', true, '');
      } catch (e) {
        push('fts_integrity_check', false, String(e?.message ?? e).slice(0, 120));
      }
    }
    const ftsN = db.prepare('SELECT COUNT(*) n FROM memories_fts').get().n;
    push('fts_row_parity', Number(ftsN) >= Number(n), `fts 索引 ${ftsN} / memories ${n}`);
    out.rows = n;
    out.pinned = p;
  } finally {
    db.close();
  }
  return out;
}

export default {
  MERGE_MEMORY_LIB_VERSION,
  DISPLAY_ID_BASE,
  RESOLUTION_RENAMED_DISPLAY_ID,
  CONFLICT_ID_COLLISION,
  normalizeText,
  contentHashOf,
  normalizeRow,
  readRows,
  listFingerprint,
  unionTags,
  splitTags,
  isSuperset,
  retractionKey,
  indexRetractions,
  retractionsDiffKeys,
  idCollisions,
  mergeMemories,
  // I3 归属过滤（默认关）：分类器 + 配置载体 + 转发面体检
  PARTITION_MODES,
  PARTITION_BUCKETS,
  PARTITION_CONFIG_BASENAME,
  MACHINE_ALIASES,
  canonicalMachine,
  machineTagOf,
  deviceLineOf,
  machineFromDevice,
  classifyOwnership,
  resolvePartition,
  partitionRows,
  partitionConfigPath,
  readPartitionConfig,
  // 拓扑守卫（V3 · 评审发现 B）：中心机身份 + 纯判据
  resolveHubHost,
  hubHostOf,
  TOPOLOGY_GUARD_REASONS,
  checkTopologyGuard,
  auditForwardIntegrity,
  // 指针最小件（edge 兜底）：形态常量 + 纯函数 + 唯一写口
  POINTER_TEXT_PREFIX,
  POINTER_TEXT_MAX_CHARS,
  POINTER_BODY_MAX_CHARS,
  POINTER_EMPTY_BODY,
  pointerBodyOf,
  pointerHash16Of,
  buildPointerRow,
  mergeStatePath,
  localDbPath,
  emptyMergeState,
  snapshotIdOfBuffer,
  snapshotIdOfFile,
  runKeyOf,
  isApplied,
  appliedRecords,
  readMergeState,
  writeMergeState,
  recordApplied,
  resolveRemoteSource,
  looksLikeSqlite,
  readGitHead,
  readMemoryDb,
  vacuumIntoSnapshot,
  applyMergeToDb,
  applyPointerToDb,
  applyForwardRowsToDb,
  verifyMemoryDb,
  // R36-B unpin 墓碑（纯函数 + 唯一写口）：默认等价（无墓碑 ⇒ 计划逐字段不变）
  MERGE_MEMORY_PIN_TOMBSTONE_VERSION,
  PIN_TOMBSTONES_TABLE,
  PIN_TOMBSTONES_SCHEMA_DDL,
  normalizePinTombstone,
  mergePinTombstones,
  pinTombstoneEffective,
  effectivePinTombstones,
  readPinTombstones,
  writePinTombstones,
  clearPinTombstones,
};
