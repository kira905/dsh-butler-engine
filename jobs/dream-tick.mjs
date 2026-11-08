#!/usr/bin/env node
/**
 * dream-tick.mjs —— **后台 dream 整理**（R-072 记忆六条标配之「后台整理 distill + dream phase」· V3 功能面 H-5）
 *
 * 一句话：空闲时（每天 04:35，接在 memory-distill 04:10 / memory-snapshot 04:20 之后）**回头翻全库**，
 * 算出三样东西并出一份报告：① **重复/同题合并建议** ② **陈旧标记建议**（过期关键词组 + 很久没动 + 已被点名订正）
 * ③ **三层分布**（core / recall / archival 各多少、多少条还没分层）。**所有建议都只写报告，写库 0 条**。
 *
 * 判据修正（2026-10-22 · 卡：V3 功能面 · dream 判据修正）—— 修前现跑 66 对里 **35 对**是「判据12 归并留下的
 * 标记副本」在互相比（正文带 `【重复·已并入 #x】` / `【已合并进 #x】`），同一内容被算成好几对
 * （`#373` / `#1000004` / `#1000566` 三个 id 两两成对 = 1 组算 3 对）。改三处：
 *   · **跳过已作废副本**：任一侧正文命中 `superseded-by:` / `【重复·已并入` / `【已合并进` ⇒ 该对不进合并建议，
 *     并在报告与 dry-run 摘要里单列「跳过已作废副本 N 对」（**不许静默少算**，数字可追溯）。
 *   · **三档**：`DUP`（≥ dup）/ `GRAY`（sim ~ dup，原「疑似同题」）/ 跳过。灰区落
 *     `_tmp\dream-gray-<YYYYMMDD>.json`，每条 `{a,b,jaccard,tier,headA,headB}`、head 截 **200 字**
 *     （**不抄全文**，避免库内容扩散到临时文件）—— 后续「灰区交 LLM 判」卡的输入契约，字段名别改。
 *   · **陈旧口径**：每组只报「命中 N 条」+「其中已带 `superseded-by:` 的 M 条」（已处理过的不再提），
 *     措辞改成「需人判」（删掉「给其中已失效的打标记」这种需要外部事实的建议）。
 *
 * 为什么要"写回需人审"：合并/标陈旧都会改已有记忆的语义（打 `superseded-by:` 就是宣判旧条作废），
 * 判错一次就永久污染上下文。⇒ 本 job **只出建议**；真写回要人看报告点头后另跑器具（本卡不提供真写口）。
 *
 * 硬边界（本文件永久口径，改之前先看这四条）：
 *   ① **只读库**：`DatabaseSync({ readOnly: true })`；本文件不出现任何 INSERT/UPDATE/DELETE（`rg` 可证；
 *      唯一例外是 `--self-test` 里的夹具库建表，逐行标注）。
 *   ② **零写库**：写入只有两处 —— ① `docs\管家报告\dream-<日期>.md`（`--dry-run` 不写）；
 *      ② 灰区清单 `_tmp\dream-gray-<YYYYMMDD>.json`（`--no-gray` 可关；每侧只留 head 截 200 字的开头，不含全文）。
 *   ③ **不改生产技能/persona/配置**：一个字节都不碰。
 *   ④ **失败不刷红**：单条记忆异常 ⇒ 跳过并计数；只有"库打不开"才 rc=3。
 *
 * 用法：
 *   node dream-tick.mjs                    # 真跑一轮（读生产库 + 写报告）
 *   node dream-tick.mjs --dry-run          # 只算不写报告（打印摘要；仍落灰区清单，--no-gray 可关）
 *   node dream-tick.mjs --json             # 摘要走 JSON（日志不上 stdout）
 *   node dream-tick.mjs --self-test        # 夹具自测（不碰生产库/不写报告）
 *   node dream-tick.mjs --db <path> --out-dir <dir> --gray-dir <dir> --dup 0.90 --sim 0.74 --stale-days 180 --settle-days 14
 *
 * 退出码：0 ok（含"没建议"）· 1 self-test 失败 · 2 用法错 · 3 库不可读
 */
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { THRESHOLDS, shingles, jaccard, topicKey, staleHits, normalizeText } from './memory-layers/shadow-verdict.mjs';

export const DREAM_VERSION = 2; // 2 = 2026-10-22 判据修正（跳过已作废副本 / 三档 DUP-GRAY / 陈旧需人判）
const CARD_REF = '卡：V3 功能面 · H-5 后台 dream 整理（2026-10-22）';

const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const num = (f, d) => { const v = arg(f); return v === null ? d : Number(v); };
const has = (f) => argv.includes(f);

/**
 * 「已作废副本」标记（2026-10-22 判据修正）：正文里出现其一 = 该条已被归并/取代，
 * **不该再拿去跟原文互相比**（否则同一内容被算成好几对）。三种标记都来自判据12 的归并动作。
 */
export const SUPERSEDED_MARKERS = Object.freeze([
  { key: 'superseded-by', re: /superseded-by:/i },
  { key: 'merged-dup', re: /【重复·已并入/ },
  { key: 'merged-into', re: /【已合并进/ },
]);

/** 纯函数：正文命中的作废标记（空数组 = 干净条目）。 */
export function supersededMarkers(text) {
  const t = String(text || '');
  return SUPERSEDED_MARKERS.filter((m) => m.re.test(t)).map((m) => m.key);
}

/** 灰区清单每侧的截断长度（字段 `headA` / `headB`）——**只留开头、不抄全文**。 */
export const GRAY_HEAD_CHARS = 200;

/** 纯函数：灰区清单条目（字段名 = 后续 LLM 判卡的输入契约，**别改名**）。 */
export function makeGrayEntry(p, byId) {
  const head = (id) => String((byId.get(Number(id)) || {}).text || '').replace(/\s+/g, ' ').slice(0, GRAY_HEAD_CHARS);
  return { a: Number(p.a), b: Number(p.b), jaccard: Number(p.jaccard), tier: p.tier, headA: head(p.a), headB: head(p.b) };
}

/** 选项（全部可注入 ⇒ 隔离/夹具测试不必改代码）。 */
export function resolveOptions(over = {}) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return {
    db: over.db || path.join(home, 'memory', 'memory.db'),
    outDir: over.outDir || '<workspace>\\docs\\管家报告',
    dup: over.dup ?? THRESHOLDS.dup,
    sim: over.sim ?? THRESHOLDS.sim,
    staleDays: over.staleDays ?? 180,      // 陈旧候选：多久没动过
    settleDays: over.settleDays ?? 14,     // 冷却：刚写过的不许马上被判陈旧
    maxPairs: over.maxPairs ?? 40,         // 报告里最多列多少对
    noWrite: over.noWrite ?? false,
    grayDir: over.grayDir || path.join(workspaceRoot(), '_tmp'),   // 灰区清单落点（后续「灰区交 LLM 判」卡的输入）
    noGray: over.noGray ?? false,
    now: over.now ?? Date.now(),
  };
}

/**
 * 跑一轮整理（**纯读**）：返回建议集合 + 统计。任何异常向外抛（由 CLI 收敛成 rc）。
 */
export function runDream(opts = resolveOptions()) {
  const t0 = Date.now();
  const db = new DatabaseSync(opts.db, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    const rows = db.prepare('SELECT id, text, tags, pinned, created_at, updated_at FROM memories ORDER BY id').all();
    const count = rows.length;
    const chars = rows.reduce((s, r) => s + String(r.text || '').length, 0);
    const maxId = rows.reduce((m, r) => Math.max(m, Number(r.id)), 0);

    // ── ① 层分布（用共享分层判定的**同口径**；这里不 import 插件文件，只用它的规则）──
    const layerOf = (r) => {
      const toks = String(r.tags || '').split(/[\s,，]+/).filter(Boolean).map((t) => t.toLowerCase());
      for (const t of toks) {
        if (t.startsWith('core:') || t === 'layer:core') return { layer: 'core', source: 'tag' };
        if (t.startsWith('recall:') || t === 'layer:recall') return { layer: 'recall', source: 'tag' };
        if (t.startsWith('archival:') || t === 'layer:archival') return { layer: 'archival', source: 'tag' };
      }
      return r.pinned ? { layer: 'core', source: 'pinned' } : { layer: 'recall', source: 'default' };
    };
    const layers = { core: 0, recall: 0, archival: 0 };
    const layerSources = { tag: 0, pinned: 0, default: 0 };
    for (const r of rows) { const l = layerOf(r); layers[l.layer] += 1; layerSources[l.source] = (layerSources[l.source] || 0) + 1; }

    // ── ② 合并/同题建议：倒排 + 共享 shingle 计数（与离线器具同法）──
    const sh = new Map();
    for (const r of rows) sh.set(Number(r.id), shingles(r.text));
    const inv = new Map();
    for (const [id, set] of sh) for (const s of set) { let a = inv.get(s); if (!a) inv.set(s, (a = [])); if (a.length < 25) a.push(id); }
    const shared = new Map();
    for (const a of inv.values()) {
      if (a.length < 2) continue;
      for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
        const k = a[i] < a[j] ? `${a[i]}|${a[j]}` : `${a[j]}|${a[i]}`;
        shared.set(k, (shared.get(k) || 0) + 1);
      }
    }
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    // 被引用数（别的记忆正文里点名 #id）——合并时优先留被引用的那条
    const refs = new Map();
    for (const r of rows) {
      const seen = new Set();
      for (const m of String(r.text).matchAll(/(?:记忆\s*)?#(\d{4,9})/g)) {
        const id = Number(m[1]);
        if (id !== Number(r.id) && byId.has(id)) seen.add(id);
      }
      for (const id of seen) refs.set(id, (refs.get(id) || 0) + 1);
    }
    const pairs = [];
    const skippedPairs = [];
    for (const [k, c] of shared) {
      if (c < 6) continue;
      const [a, b] = k.split('|').map(Number);
      const jac = Number(jaccard(sh.get(a), sh.get(b)).toFixed(4));
      if (jac < opts.sim) continue;
      const A = byId.get(a); const B = byId.get(b);
      // ① 跳过「已作废副本」（2026-10-22 判据修正）：任一侧带归并/取代标记 ⇒ 不进合并建议。
      //    为什么：判据12 归并留下的标记副本跟原文几乎逐字相同，同一内容会被算成好几对
      //    （实测 #373 / #1000004 / #1000566 三个 id 两两成对 = 1 组算 3 对）。
      const marksA = supersededMarkers(A.text); const marksB = supersededMarkers(B.text);
      if (marksA.length || marksB.length) {
        skippedPairs.push({
          a, b, jaccard: jac,
          side: marksA.length && marksB.length ? 'both' : (marksA.length ? 'a' : 'b'),
          markedIds: [...(marksA.length ? [a] : []), ...(marksB.length ? [b] : [])],
          marks: [...new Set([...marksA, ...marksB])],
        });
        continue;
      }
      const score = (x) => [Number(refs.get(Number(x.id)) || 0), String(x.text).length, -Number(x.id)];
      const better = (x, y) => { const sx = score(x); const sy = score(y); for (let i = 0; i < 3; i++) if (sx[i] !== sy[i]) return sx[i] > sy[i] ? x : y; return x; };
      const keep = better(A, B); const drop = keep === A ? B : A;
      const isDup = jac >= opts.dup;
      pairs.push({
        a, b, jaccard: jac, tier: isDup ? 'DUP' : 'GRAY',
        keep: Number(keep.id), drop: Number(drop.id),
        action: isDup ? '建议合并（留被引用多 / 正文长 / id 小者）' : '灰区（sim~dup）：交 LLM 判 / 人工复核，不自动合并',
        keepHead: String(keep.text).replace(/\s+/g, ' ').slice(0, 80),
        dropHead: String(drop.text).replace(/\s+/g, ' ').slice(0, 80),
        sameTopicKey: Boolean(topicKey(A.tags)) && topicKey(A.tags) === topicKey(B.tags),
      });
    }
    pairs.sort((x, y) => y.jaccard - x.jaccard);
    skippedPairs.sort((x, y) => y.jaccard - x.jaccard);
    // 灰区清单（全量，不按 maxPairs 截断 —— 后续卡的工量得按真实条数算）
    const gray = pairs.filter((p) => p.tier === 'GRAY').map((p) => makeGrayEntry(p, byId));

    // ── ③ 陈旧标记建议（三组证据，全部只报告）──
    const nowDay = opts.now;
    const stale = { byGroup: {}, tooOld: [], superseded: [] };
    for (const r of rows) {
      for (const g of staleHits(r.text)) {
        stale.byGroup[g] = stale.byGroup[g] || [];
        stale.byGroup[g].push(Number(r.id));
      }
      const ageDays = Math.floor((nowDay - Number(r.updated_at)) / 86400000);
      if (ageDays >= opts.staleDays && !r.pinned) stale.tooOld.push({ id: Number(r.id), ageDays, tags: r.tags, head: String(r.text).replace(/\s+/g, ' ').slice(0, 60) });
      // 被别的条目点名订正：`订正 ... #<本 id>` 的句内共现
      const named = [];
      for (const s of String(r.text).split(/(?<=[。；！？\n])/)) {
        if (!/订正|推翻|取代|勘误|作废|纠正|修正|已改|过时|不再成立/.test(s)) continue;
        for (const m of s.matchAll(/(?:记忆\s*)?#(\d{4,9})/g)) if (Number(m[1]) !== Number(r.id)) named.push(Number(m[1]));
      }
      if (named.length) stale.superseded.push({ id: Number(r.id), named });
    }
    stale.byGroup = Object.fromEntries(Object.entries(stale.byGroup).map(([k, v]) => [k, [...new Set(v)]]));
    // 每组「其中已带 superseded-by: 的 M 条」+「另计带归并标记的 K 条」（已处理过的不再提，两个数分开记 ⇒ 数字对得上）
    const byGroupDetail = {};
    for (const [g, ids] of Object.entries(stale.byGroup)) {
      let supersededBy = 0; let mergeMarked = 0;
      for (const id of ids) {
        const marks = supersededMarkers((byId.get(Number(id)) || {}).text);
        if (marks.includes('superseded-by')) supersededBy += 1;
        if (marks.includes('merged-dup') || marks.includes('merged-into')) mergeMarked += 1;
      }
      byGroupDetail[g] = { total: ids.length, supersededBy, mergeMarked };
    }
    stale.tooOld.sort((x, y) => y.ageDays - x.ageDays);

    const evidence = {
      countBefore: count,
      countAfter: (() => { const c = db.prepare('SELECT COUNT(*) n FROM memories').get(); return Number(c.n); })(),
      rowsSha256: shaOfRows(rows),
      zeroWrite: true, // 本器只读打开；countAfter 由同一连接再数一遍（并发写入不算本器写）
    };
    return {
      ok: true,
      version: DREAM_VERSION,
      generatedAt: new Date(opts.now).toISOString(),
      db: { path: path.resolve(opts.db), openMode: 'DatabaseSync({readOnly:true})' },
      thresholds: { dup: opts.dup, sim: opts.sim, staleDays: opts.staleDays, settleDays: opts.settleDays },
      stats: {
        total: count, chars, maxId,
        layers, layerSources,
        unlayered: layerSources.tag === 0 ? count : count - layerSources.tag,
        pairs: {
          total: pairs.length,
          dup: pairs.filter((p) => p.tier === 'DUP').length,
          gray: pairs.filter((p) => p.tier === 'GRAY').length,
          skippedSuperseded: skippedPairs.length,
          skippedBothSides: skippedPairs.filter((p) => p.side === 'both').length,
        },
        grayListed: gray.length,
        stale: {
          byGroup: Object.fromEntries(Object.entries(stale.byGroup).map(([k, v]) => [k, v.length])),
          byGroupDetail,
          tooOld: stale.tooOld.length,
          supersededMentions: stale.superseded.length,
          settleDays: opts.settleDays,
        },
        mergeSuggestions: Math.min(pairs.length, opts.maxPairs),
        staleSuggestions: Object.keys(stale.byGroup).length + stale.tooOld.length + stale.superseded.length,
        written: 0, // ⚠️ 恒为 0：写回需人审（本 job 不提供真写口）
        elapsedMs: Date.now() - t0,
      },
      pairs: pairs.slice(0, opts.maxPairs),
      skippedPairs: skippedPairs.slice(0, opts.maxPairs),
      gray,
      grayPath: null, // CLI 落盘后回填（renderReport 用它写灰区清单路径）
      stale,
      evidence,
    };
  } finally {
    db.close();
  }
}

function shaOfRows(rows) {
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(`${r.id}|${r.updated_at}|${r.pinned}|${r.tags}|${r.text}\n`);
  return h.digest('hex');
}

/** 渲染报告（Markdown；只写 docs\管家报告\）。 */
export function renderReport(r) {
  const s = r.stats;
  const L = [];
  L.push(`# 记忆 dream 整理报告 · ${r.generatedAt.slice(0, 10)}`);
  L.push('');
  L.push(`> 自动生成（${CARD_REF}）。**本报告只出建议，记忆库写回 0 条** —— 合并 / 标陈旧都要人看过再动手。`);
  L.push(`> 库：\`${r.db.path}\`（${r.db.openMode}）· 阈值 dup≥${r.thresholds.dup} · sim≥${r.thresholds.sim} · 陈旧线 ${r.thresholds.staleDays} 天`);
  L.push('');
  L.push('## 1. 这一轮扫了什么');
  L.push('');
  L.push(`- 全库 **${s.total} 条 / ${s.chars} 字符**（maxId ${s.maxId}；单轮耗时 ${s.elapsedMs} ms）`);
  L.push(`- 三层分布：**core ${s.layers.core} · recall ${s.layers.recall} · archival ${s.layers.archival}**（其中打层标签的 ${s.layerSources.tag} 条，未分层 ${s.unlayered} 条）`);
  L.push(`- 写入库：**${s.written} 条**（恒 0：写回需人审）`);
  L.push('');
  L.push('## 2. 合并 / 同题建议');
  L.push('');
  L.push(`共 **${s.pairs.total} 对**（硬重复 DUP ${s.pairs.dup} · 灰区 GRAY ${s.pairs.gray}），下面列前 ${r.pairs.length} 对：`);
  L.push('');
  L.push(`> **跳过已作废副本 ${s.pairs.skippedSuperseded} 对**（任一侧正文带 \`superseded-by:\` / 【重复·已并入】/【已合并进】；同一内容被算成好几对的就是它们，明细见 2.2 节）。`);
  L.push(`> 数字可追溯：${s.pairs.total} + ${s.pairs.skippedSuperseded} = **${s.pairs.total + s.pairs.skippedSuperseded} 对**（= 修前口径的总对数）。`);
  L.push('');
  L.push(`灰区 GRAY ${s.pairs.gray} 条已单独落盘：\`${r.grayPath || '（未落盘）'}\` —— 每条 \`{a,b,jaccard,tier,headA,headB}\`，head 截 ${GRAY_HEAD_CHARS} 字，供后续「灰区交 LLM 判」卡消费。`);
  L.push('');
  L.push('| 相似度 | 档 | 建议保留 | 建议被并 | 保留条目开头 | 被并条目开头 |');
  L.push('|---|---|---|---|---|---|');
  for (const p of r.pairs) L.push(`| ${p.jaccard} | ${p.tier} | #${p.keep} | #${p.drop} | ${p.keepHead.replace(/\|/g, '丨')} | ${p.dropHead.replace(/\|/g, '丨')} |`);
  L.push('');
  L.push('### 2.2 跳过明细（已作废副本）');
  L.push('');
  if (!r.skippedPairs.length) L.push('- 无（本轮没踩到已作废副本）');
  else {
    L.push('| 相似度 | #A | #B | 带标记的一侧 | 标记 |');
    L.push('|---|---|---|---|---|');
    for (const p of r.skippedPairs) L.push(`| ${p.jaccard} | #${p.a} | #${p.b} | ${p.side === 'both' ? '两侧' : `#${p.markedIds[0]}`} | ${p.marks.join(' / ')} |`);
  }
  L.push('');
  L.push('## 3. 陈旧标记建议');
  L.push('');
  const gname = { 'old-schtasks': '旧计划任务', 'baidu-sync': '百度盘同步', nutstore: '坚果云', 'old-drive-testroot': '老盘符测试根' };
  L.push('> 口径（2026-10-22 修）：每组只报「命中 N 条」+「其中已带 `superseded-by:` 的 M 条」（已处理过的不再提）；判定交人 —— **需人判：这 N 条里哪些是历史存档语气 / 已被现行口径替代**。');
  L.push('');
  for (const [k, d] of Object.entries(s.stale.byGroupDetail)) {
    const extra = d.mergeMarked ? ` · 另计带归并标记 \`【重复·已并入】\`/\`【已合并进】\` 的 ${d.mergeMarked} 条已处理，不再提` : '';
    L.push(`- 命中 **${gname[k] || k}** 的 ${d.total} 条（其中已带 \`superseded-by:\` 的 ${d.supersededBy} 条${extra}）。需人判：这 ${d.total} 条里哪些是历史存档语气 / 已被现行口径替代。`);
  }
  L.push(`- 超过 ${r.thresholds.staleDays} 天没动过的非 pinned 条目 **${s.stale.tooOld} 条**（需人判：哪些该降权 / 转 archival 层；冷却 ${s.stale.settleDays} 天：刚写过的不判陈旧）`);
  L.push(`- 正文点名订正了别的条目 **${s.stale.supersededMentions} 条**（需人判：被点名的那些是否真的已被取代）`);
  L.push('');
  L.push('## 4. 写回（需人审）');
  L.push('');
  L.push('本 job **不写库**。要落地任一条：把它抄进一张施工卡，走「备份 → 改 → 核 COUNT → `restore.mjs` 回滚点」的老流程。');
  L.push('');
  L.push(`<!-- dream: evidence countBefore=${r.evidence.countBefore} countAfter=${r.evidence.countAfter} rowsSha256=${r.evidence.rowsSha256} -->`);
  return L.join('\n') + '\n';
}

/** 夹具自测：**建临时库**（唯一出现 INSERT/CREATE 的地方，且落在 <tmp>）。 */
export function selfTest() {
  const steps = [];
  const ok = (c, label) => steps.push({ ok: Boolean(c), label });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3mem4-dream-'));
  const dbPath = path.join(tmp, 'fixture.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT \'\', pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    const base = '记忆 dream 整理夹具：这段文字足够长，用来制造一对高相似重复，验证合并建议能被算出来。再补足一些填充内容，让字符级六元组的数量稳定在几十个以上，确保相似度不会被少量填充词洗掉。';
    const now = Date.now();
    const ins = db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    ins.run(base, 'core:pref 夹具', 1, now, now);
    ins.run(base, 'recall:auto 夹具', 0, now, now);
    ins.run('夹具·旧计划任务那条：用 schtasks 建的，早就废了', 'recall:auto 夹具', 0, now, now);
    ins.run('夹具·很老的一条：半年前的东西，从来没动过', 'recall:auto 旧', 0, now, now - 200 * 86400000);
    ins.run('本条订正记忆 #1000201 的口径', 'recall:auto 夹具', 0, now, now);
    ins.run('夹具·归档层：要查才翻的东西', 'archival:auto 夹具', 0, now, now);
    // ── 判据修正夹具（2026-10-22）：① 已作废副本（该跳过，不许跟原文成对）② 灰区对（0.74~0.90 该判 GRAY）──
    ins.run(`【重复·已并入 #1000001 · 夹具】${base}`, 'recall:auto 夹具', 0, now, now);
    const gBase = '灰区夹具：这两条讲的是同一件事但细节不同，相似度该落在中间档，交给复核判定而不是直接合并。';
    ins.run(gBase, 'recall:auto 灰区', 0, now, now);
    ins.run(gBase + '另外一句补充。', 'recall:auto 灰区', 0, now, now);
    db.close();
    const opts = resolveOptions({ db: dbPath, outDir: tmp, now });
    const r = runDream(opts);
    ok(r.stats.total === 9, `扫到 9 条（实际 ${r.stats.total}）`);
    ok(r.stats.pairs.dup === 1, `硬重复恰 1 对（脏副本不算；实际 ${r.stats.pairs.dup}）`);
    ok(r.stats.pairs.skippedSuperseded === 2, `跳过已作废副本 2 对（标记副本分别与两条原文成对；实际 ${r.stats.pairs.skippedSuperseded}）`);
    ok(r.stats.pairs.gray === 1, `灰区恰 1 对（实际 ${r.stats.pairs.gray}）`);
    ok(r.gray.length === 1 && r.gray[0].tier === 'GRAY', `灰区清单 1 条且 tier=GRAY（实际 ${r.gray.length}）`);
    ok(Object.keys(r.gray[0]).sort().join(',') === 'a,b,headA,headB,jaccard,tier', `灰区字段名 = 契约（实际 ${Object.keys(r.gray[0]).join(',')}）`);
    ok(r.gray[0].headA.length <= 200 && r.gray[0].headB.length <= 200, `head 截 200 字（实际 ${r.gray[0].headA.length}/${r.gray[0].headB.length}）`);
    ok(r.skippedPairs.length === 2 && r.skippedPairs.every((p) => p.marks.includes('merged-dup')), '跳过明细带标记类型（可追溯）');
    ok(r.stats.written === 0, '写入库恒 0');
    ok(r.stats.layers.core === 1 && r.stats.layers.recall === 7 && r.stats.layers.archival === 1, `三层分布正确（core ${r.stats.layers.core} / recall ${r.stats.layers.recall} / archival ${r.stats.layers.archival}）`);
    ok(r.stats.stale.byGroup['old-schtasks'] === 1 && r.stats.stale.byGroupDetail['old-schtasks'].supersededBy === 0, '陈旧组「旧计划任务」命中 1 条 + 已带 superseded-by 0 条');
    ok(r.stats.stale.tooOld === 1, '超龄条目 1 条');
    ok(r.evidence.countBefore === r.evidence.countAfter && fs.existsSync(dbPath), '只读：前后条数相等');
    const grayFixture = path.join(tmp, 'dream-gray-fixture.json');
    fs.writeFileSync(grayFixture, JSON.stringify(r.gray, null, 1), 'utf8');
    ok(JSON.parse(fs.readFileSync(grayFixture, 'utf8')).length === 1, '灰区 JSON 可落盘并读回 1 条');
    const md = renderReport({ ...r, grayPath: grayFixture });
    ok(md.includes('写入库：**0 条**') && md.includes('需人审'), '报告里写明"写 0 条 / 需人审"');
    ok(md.includes('跳过已作废副本 2 对') && md.includes('2.2 跳过明细'), '报告写明跳过数 + 明细节');
    ok(md.includes('需人判：这 1 条里哪些是历史存档语气'), '陈旧口径改成"需人判"措辞');
    ok(!md.includes('给其中已失效的打'), '旧的「给其中已失效打标记」措辞已删');
    const pass = steps.filter((s) => s.ok).length;
    for (const s of steps) console.log(`  ${s.ok ? '✅' : '❌'} ${s.label}`);
    console.log(`[dream --self-test] ${pass}/${steps.length} ${pass === steps.length ? 'PASS' : 'FAIL'}`);
    return pass === steps.length ? 0 : 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function main() {
  if (has('--self-test')) return selfTest();
  const opts = resolveOptions({
    db: arg('--db'),
    outDir: arg('--out-dir'),
    dup: num('--dup', undefined),
    sim: num('--sim', undefined),
    staleDays: num('--stale-days', undefined),
    noWrite: has('--dry-run'),
    grayDir: arg('--gray-dir'),
    noGray: has('--no-gray'),
  });
  if (!fs.existsSync(opts.db)) { console.error(`[库不可读] ${opts.db}`); return 3; }
  let r;
  try { r = runDream(opts); } catch (e) { console.error(`[运行错误] ${e && e.message}`); return 3; }
  let outPath = null;
  let grayPath = null;
  if (!opts.noGray) {
    fs.mkdirSync(opts.grayDir, { recursive: true });
    grayPath = path.join(opts.grayDir, `dream-gray-${new Date(opts.now).toISOString().slice(0, 10).replace(/-/g, '')}.json`);
    fs.writeFileSync(grayPath, JSON.stringify(r.gray, null, 1), 'utf8');
    r.grayPath = grayPath;
  }
  if (!has('--dry-run')) {
    fs.mkdirSync(opts.outDir, { recursive: true });
    outPath = path.join(opts.outDir, `dream-${new Date(opts.now).toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(outPath, renderReport(r), 'utf8');
  }
  const summary = {
    ok: true,
    version: r.version,
    scanned: r.stats.total,
    chars: r.stats.chars,
    layers: r.stats.layers,
    pairs: r.stats.pairs.total,
    dupPairs: r.stats.pairs.dup,
    grayPairs: r.stats.pairs.gray,
    skippedSuperseded: r.stats.pairs.skippedSuperseded,
    skippedBothSides: r.stats.pairs.skippedBothSides,
    grayPath,
    grayCount: r.gray.length,
    staleSuggestions: r.stats.staleSuggestions,
    staleBreakdown: {
      groups: Object.keys(r.stats.stale.byGroup).length,
      tooOld: r.stats.stale.tooOld,
      supersededMentions: r.stats.stale.supersededMentions,
    },
    written: r.stats.written,
    report: outPath,
    elapsedMs: r.stats.elapsedMs,
  };
  if (has('--json')) { console.error(`[dream] 报告：${outPath ?? '（dry-run 未写）'}`); console.log(JSON.stringify(summary, null, 1)); }
  else {
    console.log(`=== 记忆 dream 整理（只读 · 写库 0）===`);
    console.log(`库：${r.db.path}`);
    console.log(`扫了 ${summary.scanned} 条 / ${summary.chars} 字符（${summary.elapsedMs} ms）`);
    console.log(`三层：core ${r.stats.layers.core} · recall ${r.stats.layers.recall} · archival ${r.stats.layers.archival}（未分层 ${r.stats.unlayered}）`);
    console.log(`合并建议 ${summary.pairs} 对（硬重复 ${summary.dupPairs} · 灰区 ${summary.grayPairs}）｜跳过已作废副本 ${summary.skippedSuperseded} 对`);
    console.log(`陈旧标记建议 ${summary.staleSuggestions} 项（关键词组 ${summary.staleBreakdown.groups} · 超龄 ${summary.staleBreakdown.tooOld} · 点名订正 ${summary.staleBreakdown.supersededMentions}）`);
    console.log(`实际写入库：${summary.written} 条（写回需人审）`);
    console.log(`灰区清单：${summary.grayPath ?? '（--no-gray 未落盘）'}（算出 ${summary.grayCount} 条）`);
    console.log(`报告：${outPath ?? '（dry-run 未写）'}`);
  }
  return 0;
}

const isMain = (() => {
  try {
    const a = process.argv[1];
    if (!a) return false;
    return fs.realpathSync(a) === fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch { return false; }
})();
if (isMain) process.exitCode = main();
