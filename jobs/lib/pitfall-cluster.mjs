// dsh-butler / lib/pitfall-cluster.mjs —— P4 坑聚类升级（方案 §5 C 点 · sigKey 精确匹配 → 向量二级聚类）
//
// 要替代的东西：现役 `signatureOf()`（`lib\pitfall-sign.mjs`）= `name|code|normText` 的**精确字符串**，
//   sigKey 不同就是两个坑 ⇒ 同源坑在候选池里分裂成好几条（实测：搜索路径 5 条 / 看图 7 条 /
//   改文件状态 4 条 / 网页检索 3 条），人工核对时还得再合并一次（30 条 → 10 个动作）。
//
// 铁的边界（方案 §C.6 第一行，本文件照此实现）：
//   聚类结果**只做「收敛展示」**（候选列表折叠 / 建议批量处理），
//   **不得**修改任何坑的 `count` / `excluded` / 候选 status —— 本模块是**纯函数**，零 IO。
//
// 算法（方案 §C.3）：余弦距离（向量已 L2 归一化 ⇒ 直接点积）；
//   贪心聚合（按 count 降序取种子，把 cos ≥ eps 且未归属的成员并入）；
//   全量百级条目 ⇒ O(n²) ≈ 毫秒级，**不需要 HNSW 等索引**。
import crypto from 'node:crypto';

export const PITFALL_CLUSTER_VERSION = '0.1.0';
/** eps 候选（方案 §C.3；标定后取满足判据的最大者 = 最保守、最不容易误并） */
export const EPS_CANDIDATES = [0.8, 0.85, 0.9];
/** 单条成族 = 无合并意义（方案 §C.3 minSize） */
export const DEFAULT_MIN_SIZE = 2;

/** 余弦相似度（向量若已归一化则退化为点积；未归一化时两侧各自归一化 ⇒ 与点积同口径） */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/** 稳定排序键：`(count 降序, lastSeen 降序, id 字典序升序)` —— 判据 3「同输入重跑逐字一致」靠它 */
export function stableSeedOrder(rows) {
  return rows.slice().sort((a, b) =>
    (Number(b.count) || 0) - (Number(a.count) || 0)
    || (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0)
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

/** 族代表 = 族内 `count` 最大、并列取最新 `lastSeen`、再并列取 id 字典序最小（可复现） */
export function representativeOf(memberIds, byId) {
  const sorted = memberIds.slice().sort((a, b) => {
    const ra = byId.get(a) || {};
    const rb = byId.get(b) || {};
    return (Number(rb.count) || 0) - (Number(ra.count) || 0)
      || (Number(rb.lastSeen) || 0) - (Number(ra.lastSeen) || 0)
      || (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  });
  return sorted[0] ?? null;
}

/** clusterId 由成员集合决定（排序后哈希）⇒ 幂等、可复现、与遍历顺序无关 */
export function clusterIdOf(memberIds) {
  const h = crypto.createHash('sha1').update(memberIds.slice().sort().join(','), 'utf8').digest('hex');
  return `c-${h.slice(0, 8)}`;
}

/** 族主题（收敛展示用）= 代表条目的 category；缺则取 normText 前 24 字 */
export function themeOf(repRow) {
  if (!repRow) return '(未知)';
  const cat = String(repRow.category || '').trim();
  if (cat && cat !== '其他') return cat;
  const t = String(repRow.normText || '').trim();
  return t ? t.slice(0, 24) : '(未知)';
}

/**
 * 向量二级聚类（**纯函数**：向量由调用方传入）。
 *
 * @param {object} p
 * @param {Array<{id:string, count?:number, lastSeen?:number, category?:string, normText?:string}>} p.rows 坑元数据
 * @param {Array<{refId:string, vec:ArrayLike<number>|Float32Array}>|object} p.vectors 向量（数组形式或矩阵形式）
 * @param {number} [p.eps=0.85] 相似度阈值
 * @param {number} [p.minSize=2] 成族最小规模（不足者单条成族）
 * @returns {{clusters:Array, stats:object}}
 */
export function clusterPitfalls({ rows = [], vectors = [], eps = 0.85, minSize = DEFAULT_MIN_SIZE } = {}) {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const vecById = new Map();
  if (Array.isArray(vectors)) {
    for (const v of vectors) {
      const refId = String(v.refId ?? v.id);
      const vec = v.vec ?? v.vector ?? null;
      if (refId && vec) vecById.set(refId, vec);
    }
  } else if (vectors && vectors.data && vectors.refIds) {
    const { refIds, data, dim } = vectors;
    const n = Number(dim) || 0;
    refIds.forEach((id, i) => {
      if (n > 0) vecById.set(String(id), data.subarray(i * n, (i + 1) * n));
    });
  }

  const order = stableSeedOrder(rows);
  const assigned = new Set();
  const groups = [];
  let pairwise = 0;

  for (const seed of order) {
    const sid = String(seed.id);
    if (assigned.has(sid)) continue;
    const svec = vecById.get(sid) || null;
    const members = [sid];
    assigned.add(sid);
    if (svec) {
      for (const other of order) {
        const oid = String(other.id);
        if (assigned.has(oid)) continue;
        const ovec = vecById.get(oid);
        if (!ovec) continue;
        pairwise += 1;
        if (cosine(svec, ovec) >= eps) {
          members.push(oid);
          assigned.add(oid);
        }
      }
    }
    groups.push({ memberIds: members });
  }

  // 未在 rows 里出现、却带向量的条目：不参与（聚类输入以 rows 为准），如实记数
  const unclustered = [];
  for (const id of vecById.keys()) if (!byId.has(id)) unclustered.push(id);

  const clusters = groups.map((g) => {
    const rep = representativeOf(g.memberIds, byId);
    const total = g.memberIds.reduce((a, id) => a + (Number(byId.get(id)?.count) || 0), 0);
    return {
      clusterId: clusterIdOf(g.memberIds),
      memberIds: g.memberIds.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      representativeId: rep,
      theme: themeOf(byId.get(rep)),
      size: g.memberIds.length,
      totalCount: total,
      merged: g.memberIds.length >= Math.max(2, Number(minSize) || 2),
    };
  });
  // 输出顺序稳定（判据 3）：按 (size 降序, totalCount 降序, clusterId 升序)
  clusters.sort((a, b) => b.size - a.size || b.totalCount - a.totalCount
    || (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0));

  const mergedClusters = clusters.filter((c) => c.merged);
  return {
    clusters,
    stats: {
      eps: Number(eps),
      minSize: Number(minSize),
      rows: rows.length,
      withVector: vecById.size,
      clusters: clusters.length,
      mergedClusters: mergedClusters.length,
      singletons: clusters.filter((c) => !c.merged).length,
      maxSize: clusters.reduce((m, c) => Math.max(m, c.size), 0),
      pairwiseCompared: pairwise,
      unclusteredVectorIds: unclustered.length,
    },
  };
}

/**
 * 恒等聚类（**优雅降级**，方案 §C.6 第二行）：
 * 无向量库 / 库损坏 ⇒ 输出「单条成族」的恒等聚类（= 现状），并给出日志一行用的 `reason`；
 * **不报错给主人**。
 */
export function identityClusters(rows = [], reason = 'no-vectors') {
  const clusters = stableSeedOrder(rows).map((r) => ({
    clusterId: clusterIdOf([String(r.id)]),
    memberIds: [String(r.id)],
    representativeId: String(r.id),
    theme: themeOf(r),
    size: 1,
    totalCount: Number(r.count) || 0,
    merged: false,
  }));
  return {
    clusters,
    stats: {
      eps: null,
      minSize: null,
      rows: rows.length,
      withVector: 0,
      clusters: clusters.length,
      mergedClusters: 0,
      singletons: clusters.length,
      maxSize: 1,
      pairwiseCompared: 0,
      degraded: true,
      reason: String(reason),
    },
  };
}
