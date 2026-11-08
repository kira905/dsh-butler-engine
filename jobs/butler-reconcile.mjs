#!/usr/bin/env node
// dsh-butler / butler-reconcile.mjs —— P7「会照应」对账器 CLI（卡 [8]）
//
// 用法：
//   node butler-reconcile.mjs --check                 # 跑一轮对账（日报同口径；含落盘去噪记账）
//   node butler-reconcile.mjs --check --json          # 机器可读
//   node butler-reconcile.mjs --check --dry-run       # 不写状态、也不落盘索引（一个字节也不写，只看结果）
//   node butler-reconcile.mjs --check --no-cooldown   # 跳过去噪（排查为什么没提示）
//   node butler-reconcile.mjs --card <taskId>         # 单卡对账：此卡与哪些既有内容同实体
//   node butler-reconcile.mjs --rebuild               # 强制全量重建实体索引
//   node butler-reconcile.mjs --status                # 索引 / 状态 / 忽略规则总览
//   node butler-reconcile.mjs --ignore coupling:guard2 --reason "已知重叠"
//   node butler-reconcile.mjs --ignore triad:调研-xxx.md --reason "决定已在上文写死"
//   node butler-reconcile.mjs --unignore coupling:guard2
//
// 四类输出：耦合预警 / 落地缺口 / 脱管任务 / 三件套缺项（决定·归属·触发，V3.1.0 §13 D1）。
// 只落 stdout / 日报段（⬜ 级：统筹提示不是告警，不推送、不写 alert.log）。
// 退出码：0 正常（含"无提示"）/ 1 参数错或内部异常 / 2 索引 schema 不符（跳过该模块）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

function usage(code = 0) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(code);
}
if (has('--help') || has('-h')) usage(0);

const BUTLER_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, path.sep));
const LIB = (n) => pathToFileURL(path.join(BUTLER_DIR, 'lib', n)).href;

let rc = 0;
try {
  const rec = await import(LIB('reconcile.mjs'));
  const ent = await import(LIB('entities.mjs'));
  const home = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

  if (has('--status')) {
    const st = rec.statusSummary(home);
    const idx = st.index ?? {};
    console.log(`索引文件：${st.indexFile}`);
    if (idx && !idx.error) {
      console.log(`索引：${idx.carriers} 载体 / ${idx.entities} 实体 / 高频(只索引不提示) ${idx.highFreq} · IDF 上限 ${idx.params?.idfLimit ?? '?'}`
        + ` · 建于 ${idx.builtAt ? new Date(idx.builtAt).toLocaleString('zh-CN') : '—'}`);
      for (const e of (idx.errors ?? [])) console.log(`  ⚠️ 采集降级：${e.kind} → ${e.error}`);
    } else {
      console.log(`索引：${idx?.error ?? '不存在（跑 --rebuild）'}`);
    }
    console.log(`状态文件：${st.stateFile}`);
    console.log(`上次对账：${st.lastRunAt ? new Date(st.lastRunAt).toLocaleString('zh-CN') : '—'}`
      + `${st.lastShown !== null ? ` · 展开 ${st.lastShown} 条` : ''} · 去噪表 ${st.seenCount} 条`);
    console.log(`忽略规则 ${st.rules.length} 条${st.rules.length ? '：' + st.rules.map((r) => r.match).join(' ') : ''}`);
    // 按可判类别分组（triad 是本轮新增的第 4 类：三件套缺项）
    const kinds = rec.KINDS ?? [];
    const byKind = Object.fromEntries(kinds.map((k) => [k, 0]));
    for (const r of st.rules) {
      const k = String(r?.match ?? '').split(':')[0];
      if (k in byKind) byKind[k] += 1;
    }
    console.log(`可判类别 ${kinds.length} 类：` + kinds.map((k) => `${k}（${rec.KIND_LABEL?.[k] ?? ''} · 忽略 ${byKind[k] ?? 0} 条）`).join(' / '));
    process.exit(0);
  }

  if (has('--ignore') || has('--unignore')) {
    const match = valOf('--ignore') ?? valOf('--unignore');
    if (!match) usage(1);
    if (has('--ignore')) {
      rec.updateIgnored((cur) => ({ ...cur, ignored: rec.addIgnoreRule(cur.ignored, match, valOf('--reason') ?? '') }), home);
      console.log(`已忽略：${match}（之后该键不再提示；--unignore 可撤销）`);
    } else {
      rec.updateIgnored((cur) => ({ ...cur, ignored: rec.removeIgnoreRule(cur.ignored, match) }), home);
      console.log(`已撤销忽略：${match}`);
    }
    process.exit(0);
  }

  if (has('--rebuild')) {
    const r = ent.ensureIndex({ home, force: true });
    console.log(`索引已重建：${r.index.counts.carriers} 载体 / ${r.index.counts.entities} 实体 / 高频 ${r.index.counts.highFreq}`
      + ` · 词表 ${r.index.counts.vocab} · IDF 上限 ${r.index.params.idfLimit}`);
    process.exit(0);
  }

  // ---- 单卡对账
  const card = valOf('--card');
  if (card) {
    const { ensureIndex, entitiesOf, bootstrapVocabulary, entitiesPath } = ent;
    const r = ensureIndex({ home });
    const idx = r.index;
    const c = (idx._carriers ?? []).find((x) => x.id === `board:${card}` || x.id === card);
    if (!c) { console.error(`找不到卡：${card}（用看板卡 id；或先 --rebuild 刷新索引）`); process.exit(1); }
    // 词表：从索引里的实体键重建（索引不含词表本身，用实体键当词表足够）
    const vocab = new Set(Object.keys(idx.entities));
    const mine = [...entitiesOf([c.title, c.text], vocab)];
    const cmap = new Map((idx._carriers ?? []).map((x) => [x.id, x]));
    console.log(`卡：${c.title}`);
    if (!mine.length) { console.log('（此卡未命中任何索引实体）'); process.exit(0); }
    const rows = [];
    for (const e of mine) {
      const info = idx.entities[e];
      if (!info) continue;
      const others = (info.sample ?? []).map((id) => cmap.get(id)).filter((x) => x && x.id !== c.id);
      if (!others.length) continue;
      rows.push({ e, info, others });
    }
    rows.sort((a, b) => (b.info.core - a.info.core) || (b.info.carriers - a.info.carriers));
    console.log(`同实体既有内容 ${rows.length} 个实体：`);
    for (const { e, info, others } of rows.slice(0, 12)) {
      console.log(`  · 「${e}」共 ${info.carriers} 处（核心 ${info.core}）`);
      for (const o of others.slice(0, 4)) console.log(`      ${o.kind}: ${String(o.title).slice(0, 60)}`);
    }
    process.exit(0);
  }

  // ---- 跑一轮对账（默认动作）
  const result = rec.reconcile({
    home,
    persist: !has('--dry-run'),
    // --dry-run 的语义 = 一个字节也不写。仅 persist:false 只挡状态文件；
    //   索引重建走 ensureIndex()（`lib\entities.mjs:750` 的 `opts.dryRun !== true` 才是它的开关）
    //   ⇒ 必须同样透传，否则语料一变就会**重建并落盘生产索引**（2026-10-11 夹具实测复现）。
    indexOpts: { dryRun: has('--dry-run') },
    noCooldown: has('--no-cooldown'),
    maxItems: Number(valOf('--max-items') ?? 0) || undefined,
  });
  if (has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(rec.summaryLine(result));
    for (const line of rec.dailySectionLines(result, { withHeader: false })) console.log(line);
  }
  rc = 0;
} catch (e) {
  if (e?.name === 'SchemaMismatchError') {
    console.error(`[butler-reconcile] 状态文件 schema 不符，跳过本模块：${e.message}`);
    rc = 2;
  } else {
    console.error(`[butler-reconcile] 失败：${e?.stack ?? e?.message ?? e}`);
    rc = 1;
  }
}
process.exit(rc);
