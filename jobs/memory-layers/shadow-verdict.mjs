/**
 * shadow-verdict.mjs —— **写入判定·影子态**（R-072 记忆六条标配之「写入判定 ADD/UPDATE/DELETE/NOOP」· V3 功能面 H-2）
 *
 * 一句话：每条经 `memory_write` 要落库的新记忆，**先跟库里现有条目比一遍**，判出 ADD / NOOP_DUP / NOOP_TOPIC /
 * UPDATE_NEW / UPDATE_OLD 之一，把判定结果**追加进旁挂日志**（`~/.dsh/memory-shadow/verdicts.jsonl`），
 * **然后照旧落库、绝不拦截、绝不修改任何已有记忆**。
 *
 * 为什么先做影子态（主人 2026-10-22 真源 `docs\补封稿-记忆与自进化需求轨补齐-20261022.md` §1 H-2）：
 *   判太严会挡掉该记的（这比脏账更糟）⇒ 先只算只报、跑出读数再谈放行真写；**放行须另报主人**。
 *
 * 硬边界（本模块刻意做成这样，且每条都有断言兜着）：
 *   ① **零写库**：本模块只有 `readOnly` 打开、只有 SELECT（`rg -n 'INSERT|UPDATE |DELETE|CREATE|ALTER'` 可证）。
 *   ② **永不抛**：任何异常（库打不开/超时/JSON 坏）一律吞掉并写一行 `error` 记录 —— 写入路径不许被它拖垮。
 *   ③ **不阻塞**：调用方 await 它，但内部有 ms 预算；超预算就放弃本轮判定（记 `verdict: 'SKIP_TIMEOUT'`）。
 *   ④ **幂等**：同一 `id` 已有判定 ⇒ 不重复记（重跑/重放不会污染读数）。
 *   ⑤ **数据分级**：判定日志只记 `id / verdict / 相似度 / 命中伙伴 id / 命中过的关键词组 / 正文前 120 字`，
 *      **不记全文**（旁挂日志可能随仓同步）。
 *
 * 判据口径（与离线器具 `tools/memory-eval/write-verdict.mjs` v1.1 **逐字对齐**，数字才可比）：
 *   文本规范化 = 去【设备：…】→ 去空白 → 去中英标点；切 **6-gram** 字符 shingle；Jaccard = |A∩B| / |A∪B|
 *   · NOOP_DUP   ：Jaccard ≥ 0.90 ⇒ 硬重复（**将来放行时**会拒写并回显已有 id）
 *   · NOOP_TOPIC ：0.74 ≤ Jaccard < 0.90 ⇒ 疑似同题（只报告，放行）
 *   · UPDATE_NEW ：本条正文含订正类标记并点名 `#<旧id>`（E1 句内共现）⇒ 将来会给旧条打 `superseded-by:<新id>`
 *   · UPDATE_OLD ：本条**被**别的现存条目点名订正（反向命中）
 *   · ADD        ：都不命中 ⇒ 正常记
 *   候选筛选：近 `windowDays` 天内更新过的条目（默认 90 天）+ 同一套"设备/日期噪声过滤后的主题键"同主题条目，
 *   两者并集再算 Jaccard（1,800 条全量两两比太慢，写入路径上不能这么干）。
 *
 * 本文件同样被「后台整理 dream」复用（它调 `similarityOf` 等纯函数），因此**纯函数与 IO 分开**。
 */
import { hostTokenPattern } from '../lib/ws-root.mjs';

/** 阈值：与离线器具 v1.1 默认值一致（改这里 = 改口径，须同步 `tools/memory-eval/write-verdict.mjs` 的默认参数）。 */
export const THRESHOLDS = Object.freeze({ dup: 0.90, sim: 0.74, shingle: 6, windowDays: 90, maxCandidates: 400 });

const CORRECTION_MARKERS = ['订正', '推翻', '取代', '勘误', '作废', '纠正', '修正', '已改', '过时', '不再成立'];
const REF_RE = /(?:记忆\s*)?#(\d{4,9})/g;
const STALE_GROUPS = [
  { key: 'old-schtasks', re: /schtasks|计划任务|Task\s*Scheduler/i },
  { key: 'baidu-sync', re: /百度/ },
  { key: 'nutstore', re: /坚果云/ },
  { key: 'old-drive-testroot', re: /[EFH]:[\\/]DSH-test/i },
];

/** 纯函数：规范化（与离线器具同口径）。 */
export function normalizeText(s) {
  return String(s)
    .replace(/【设备[：:][^】]*】/g, '')
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？（）【】《》""''`\-—…·.,;:!?()\[\]<>"']/g, '');
}

/** 纯函数：6-gram shingle 集合。 */
export function shingles(text, k = THRESHOLDS.shingle) {
  const t = normalizeText(text);
  const set = new Set();
  for (let i = 0; i + k <= t.length; i++) set.add(t.slice(i, i + k));
  if (t.length < k && t.length) set.add(t);
  return set;
}

/** 纯函数：Jaccard。
 * ⚠️ 与离线器具的**唯一差异**：对方 `shingles()` 返回 Set，这里为了省内存返回的也是 Set，
 *    但**倒排剪枝**会先用共享 shingle 数粗筛（`minsh`），所以两边的数值口径一致。 */
export function jaccard(A, B) {
  if (!A || !B || !A.size || !B.size) return 0;
  let inter = 0;
  if (A.size > B.size) return jaccard(B, A);
  for (const s of A) if (B.has(s)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 纯函数：主题键（tags 去设备/日期噪声后按字母序拼接；空键不参与"同主题"判定）。 */
export function topicKey(tags) {
  const toks = String(tags || '')
    .split(/[\s,，]+/)
    .filter(Boolean)
    .filter((t) => !hostTokenPattern().test(t))
    .filter((t) => !/^\d{8}$/.test(t))
    .filter((t) => !/^(core|recall|archival):/i.test(t)) // 层标签不是主题
    .map((t) => t.toLowerCase());
  return toks.sort().join('+');
}

/** 纯函数：E1 句内共现（正文含订正类标记 + 同一句里点名现存 `#id`）。 */
export function detectE1(text, selfId, existingIds) {
  const out = new Set();
  for (const s of String(text || '').split(/(?<=[。；！？\n])/)) {
    if (!CORRECTION_MARKERS.some((k) => s.includes(k))) continue;
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(s))) {
      const id = Number(m[1]);
      if (id !== Number(selfId) && existingIds.has(id)) out.add(id);
    }
  }
  return [...out];
}

/** 纯函数：过期关键词组命中（只用于报告，不改任何东西）。 */
export function staleHits(text) {
  return STALE_GROUPS.filter((g) => g.re.test(String(text))).map((g) => g.key);
}

/**
 * 纯函数：给定新条目与候选集，判出四类之一（**不含 IO**）。
 * @param {{text:string, selfId?:number, tags?:string}} proposed
 * @param {{id:number, tags:string, text?:string, shingles?:Set<string>}} candidates 已带 shingles 的候选
 * @param {{existingIds?:Set<number>, dup?:number, sim?:number}} opts
 */
export function classifyWrite(proposed, candidates, opts = {}) {
  const dup = opts.dup ?? THRESHOLDS.dup;
  const sim = opts.sim ?? THRESHOLDS.sim;
  const A = shingles(proposed.text);
  // ⚠️ 实测坑（2026-10-22）：**必须逐条判、不能 if/else**。第一版写成「命中硬重复就不再判同题」，
  //   结果同一条记忆既有 ≥0.90 的伙伴、又有 0.74~0.90 的伙伴时，那个 0.80 的伙伴会把后面
  //   "同主题但被新事实取代"的候选提前吃掉 ⇒ 判成 NOOP_TOPIC，E1/E3 的 UPDATE 永远判不出来。
  let bestDup = null;
  let bestTopic = null;
  for (const c of candidates) {
    const B = c.shingles || shingles(c.text || '');
    const jac = jaccard(A, B);
    if (jac >= dup) { if (!bestDup || jac > bestDup.jac) bestDup = { id: Number(c.id), jac }; }
    else if (jac >= sim) { if (!bestTopic || jac > bestTopic.jac) bestTopic = { id: Number(c.id), jac }; }
  }
  const e1 = detectE1(proposed.text, proposed.selfId ?? -1, opts.existingIds ?? new Set(candidates.map((c) => Number(c.id))));
  const stale = staleHits(proposed.text);
  // 判定优先级（2026-10-22 定）：**硬重复 > 点名订正 > 疑似同题 > 普通新增**。
  // 为什么"点名订正"要压过"疑似同题"：一条记忆若明确写「本条订正 #N 的口径」，那就是 UPDATE 语义，
  // 即便它跟另一条恰好 0.8 相似，报成 NOOP_TOPIC 也会把"该更新"这个信号埋掉（实测踩过）。
  if (bestDup) return { verdict: 'NOOP_DUP', jaccard: round(bestDup.jac), partnerId: bestDup.id, wouldBlock: true, e1, staleGroups: stale };
  if (e1.length) return { verdict: 'UPDATE_NEW', jaccard: bestTopic ? round(bestTopic.jac) : 0, partnerId: e1[0], wouldBlock: false, e1, staleGroups: stale };
  if (bestTopic) return { verdict: 'NOOP_TOPIC', jaccard: round(bestTopic.jac), partnerId: bestTopic.id, wouldBlock: false, e1, staleGroups: stale };
  return { verdict: 'ADD', jaccard: 0, partnerId: null, wouldBlock: false, e1, staleGroups: stale };
}

const round = (x) => Number(Number(x).toFixed(4));

/**
 * 候选取数（**只读**）：近 N 天 ∪ 同主题键 ∪ 被本条点名的旧条（点名的一定要进候选，否则 E1 判不出来）。
 * @returns {{id:number, tags:string, text:string, shingles:Set<string>}[]}
 */
export function loadCandidates(db, proposed, opts = {}) {
  const windowDays = opts.windowDays ?? THRESHOLDS.windowDays;
  const max = opts.maxCandidates ?? THRESHOLDS.maxCandidates;
  const since = Date.now() - windowDays * 24 * 3600 * 1000;
  const named = [...String(proposed.text || '').matchAll(REF_RE)].map((m) => Number(m[1]));
  const rows = db.prepare(`
    SELECT id, tags, text FROM memories
    WHERE (updated_at >= ? OR id IN (${named.length ? named.map(() => '?').join(',') : 'NULL'}))
      AND id <> ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(since, ...named, Number(proposed.selfId ?? -1), max);
  const tk = topicKey(proposed.tags);
  const rowsTopic = tk
    ? db.prepare('SELECT id, tags, text FROM memories WHERE tags LIKE ? AND id <> ? ORDER BY updated_at DESC LIMIT 200')
      .all(`%${tk.split('+').filter(Boolean).slice(0, 1).join('')}%`, Number(proposed.selfId ?? -1))
    : [];
  const byId = new Map();
  for (const r of [...rows, ...rowsTopic]) {
    if (byId.has(Number(r.id))) continue;
    byId.set(Number(r.id), { id: Number(r.id), tags: r.tags, text: r.text, shingles: shingles(r.text) });
  }
  return [...byId.values()];
}

/** 旁挂日志（**只追加**；JSONL；不记全文）。 */
export function appendVerdict(logPath, rec, fsImpl) {
  const fs = fsImpl;
  fs.mkdirSync(logPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(rec) + '\n', 'utf8');
}
