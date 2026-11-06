// 2c · 状态文件命名迁移 —— 例外白名单「唯一真源」（S1 生产版 · 零调用点）
// 设计真源：docs/ §3.1
//
// 三份清单的共同输入（方案 §3.1 I-2）：
//   ①迁移脚本的 skip 白名单 ②S5 清除白名单 ③覆盖检查器的「例外已登记」
//   ⇒ 只许 import 本文件，禁止各写一份副本。
//
// 逐条核 §3.1 例外表（7 行 → 两张表）：
//   butler-l3-reminder.json  → KEEP_LEGACY（方案推荐「保留旧名」）
//   butler-attach-scan.json  → COORDINATION_REQUIRED（同批改 tools\attachments-audit.mjs，属 2d 范围）
//   butler-sessions-land.json→ KEEP_LEGACY（已开源件 sessions-land-skip.mjs 在读，须 ≥2 个发布周期）
//   butler-ignored.json      → COORDINATION_REQUIRED（面板 dsh-butler-panel + dsh-backup-sync.ps1）
//   butler-external-state.json→ COORDINATION_REQUIRED（dsh-backup-sync.ps1 排除项，须同源化）
//   butler-l3-reminder.log   → KEEP_LEGACY（插件追加写；未改插件前保留旧名）
//   butler-pitfalls.json     → KEEP_LEGACY（插件只读坑库；读不到＝提醒退化、不报错）
//
// 两张表的语义**不同**，不许混用：
//   · KEEP_LEGACY          = 永远不迁、不清（迁移记 action='keep-legacy'，回滚跳过）
//   · COORDINATION_REQUIRED = 要迁，但必须先改掉外部读写方（S2/S3 同批协调），
//                             在协调完成前**不得单独迁走**（不参与 KEEP_LEGACY 判定）

/** 必须长期保留旧名的条目（迁移：不 copy/不改名；回滚：跳过；S5：不清理）。 */
export const KEEP_LEGACY = Object.freeze([
  'butler-l3-reminder.json',
  'butler-l3-reminder.log',
  'butler-pitfalls.json',
  'butler-sessions-land.json',
]);

/**
 * KEEP_LEGACY 逐条理由 + 外部读写方（§3.6「白名单每条必须带 reason + owner」）。
 * 键与 KEEP_LEGACY 一一对应；缺一条即视为不合规（覆盖检查器会报）。
 */
export const KEEP_LEGACY_REASONS = Object.freeze({
  'butler-l3-reminder.json': Object.freeze({
    owner: 'tools\\dsh-l3-pitfall-reminder\\lib\\store.mjs:37',
    reason: '插件直读；体量小、非核心，方案 §3.1 推荐保留旧名（P4）',
  }),
  'butler-l3-reminder.log': Object.freeze({
    owner: 'tools\\dsh-l3-pitfall-reminder\\lib\\store.mjs:9,43',
    reason: '插件追加写；未改插件前保留旧名，否则提醒日志静默丢失',
  }),
  'butler-pitfalls.json': Object.freeze({
    owner: 'tools\\dsh-l3-pitfall-reminder\\lib\\store.mjs:8,40',
    reason: '插件只读坑库；改名后插件读不到＝提醒退化且不报错',
  }),
  'butler-sessions-land.json': Object.freeze({
    owner: 'tools\\lib\\sessions-land-skip.mjs:29（已开源发布件）',
    reason: '已开源件读旧名；须至少保留 2 个发布周期（方案 §3.1 例外表）',
  }),
});

/**
 * 要迁但必须先协调外部读写方的条目（不参与 KEEP_LEGACY / oldBroken 判定）。
 * 语义：迁移前必须先改掉 owner 指向的读取方，否则改名即静默失联（E 类风险）。
 */
export const COORDINATION_REQUIRED = Object.freeze([
  'butler-attach-scan.json',
  'butler-ignored.json',
  'butler-external-state.json',
]);

export const COORDINATION_REASONS = Object.freeze({
  'butler-attach-scan.json': Object.freeze({
    owner: 'tools\\attachments-audit.mjs:47（CACHE_NAME）',
    action: '同批改该工具的缓存名（属 2d 范围，方案 §3.1）',
    reason: '改名后审计缓存读不到＝每次全量重扫（退化不报错）',
  }),
  'butler-ignored.json': Object.freeze({
    owner: 'dsh-butler-panel\\lib\\index.js:155 + tools\\dsh-backup-sync.ps1',
    action: '同批改面板 + 备份清单',
    reason: '面板读不到显示为空；备份漏采集＝换机丢忽略名单',
  }),
  'butler-external-state.json': Object.freeze({
    owner: 'tools\\dsh-backup-sync.ps1（排除项）',
    action: '备份清单同源化（方案 §3.7）',
    reason: '清单写死旧名 ⇒ 新名不被采集或被误采集',
  }),
});

/**
 * 迁移/回滚自己的基础设施，不是「状态文件」。
 * inferMode() 判模式时必须排掉（否则"只有旧名 + 两个备份根"会被误判成 dual，方案 I-1）。
 */
export const INFRA_NAMES = Object.freeze([
  'ops-state-migration.json',
  'ops-state-migration-manifest.json',
  'ops-state-migrate-backups',
  'ops-state-rollback-backups',
  'ops-state-write-audit.jsonl',
  'ops-state-read-audit.json',
]);

const norm = (name) => String(name ?? '').replace(/\\/g, '/');

/** 取顶层条目名：`butler-locks/tick.lock` → `butler-locks`；`/butler-x.json` → `butler-x.json`。 */
export function topLevelEntry(name) {
  const n = norm(name).replace(/^\/+/, '');
  return n.split('/')[0];
}

const KEY = (name) => topLevelEntry(name).toLowerCase();

export function isKeepLegacy(name) {
  return KEEP_LEGACY.includes(KEY(name));
}

export function isCoordinationRequired(name) {
  return COORDINATION_REQUIRED.includes(KEY(name));
}

export function isInfra(name) {
  return INFRA_NAMES.includes(KEY(name));
}

/** 白名单/例外条目的一句话理由；未登记返回 null。 */
export function reasonFor(name) {
  const k = KEY(name);
  if (KEEP_LEGACY_REASONS[k]) return { table: 'keep-legacy', ...KEEP_LEGACY_REASONS[k] };
  if (COORDINATION_REASONS[k]) return { table: 'coordination', ...COORDINATION_REASONS[k] };
  if (INFRA_NAMES.includes(k)) return { table: 'infra', owner: '2c 迁移/回滚自身', reason: '基础设施，不是状态文件' };
  return null;
}

/** 自检：KEEP_LEGACY 每条都有 reason（§3.6 合规要求）。返回缺失条目数组。 */
export function missingReasons() {
  return KEEP_LEGACY.filter((n) => !KEEP_LEGACY_REASONS[n]).concat(
    COORDINATION_REQUIRED.filter((n) => !COORDINATION_REASONS[n]),
  );
}
