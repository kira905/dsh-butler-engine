// dsh-butler / lib/pitfall-render.mjs —— P4 坑库渲染（docs\坑库\*.md + 踩坑大全索引 + README）
//
// 方案 §4 P4「坑库组织（主人拍板 A：索引法）」：
//   docs\坑库\{pwsh,插件,会话,守护鱼,同步,其他}.md —— 自动追加
//   docs\踩坑大全.md 降级为索引：保留经典坑 + 高频自动条目摘要 + 指路
//   每条坑字段：现象 / 错误签名 / 触发工具 / 样本 / 次数 / 首末次 / 涉及会话
//
// 【host 分文件（2026-09-11，2026-09-15 收口订正）】两台机各跑 tick，渲染物含「生成时间/条目数」→ 同名文件必然分叉，
//   每次 depart 都被超集门挡（见 _archive\docs-retired-20260915-0130\接机-收工挡推裁决请求-20260911.md §3/§7，已归档）。
//   根治：渲染物一律带主机短码，照 butler-barewatch 的 <host>-ledger.jsonl 先例 ——
//     docs\坑库\<主题>-<host>.md / docs\坑库\README-<host>.md / docs\踩坑大全-<host>.md
//   **旧名单份文件已全部清除**（HOST_A 2026-09-12、HOST_C 2026-09-14，见 docs\tick产物host分文件-20260911.md §8 与
//   docs\host分文件收口-HOST_C侧-20260914.md）→ 本版**只写** host 文件名，不再写旧名；保留的仅是
//   「首次生成 host 文件时，若旧名文件意外存在则继承其自动区块之外的手工内容」这条兜底（旧文件本身不动、不删）。
//
// 【seed 降权（2026-09-15）】`source:'seed'` 的历史文字坑（8/25 前无会话原料：踩坑大全 / persona 铁律 / 记忆）
//   `count` 恒为 0、score 由固定基准权重衰减得出 —— 与真坑（会话聚类）**不同质**，混在一张表里会稀释可读性。
//   故渲染时单独成组、降到文件末尾（标「🧬 历史种子（非高频）」），且不进索引「高频坑 Top 5」。
//   判定真源 = isSeedPitfall()；改判定改这里，**不手改渲染物**（区内每 30 分钟被覆盖）。
//
// 幂等：自动区块用 <!-- butler-auto:begin --> / <!-- butler-auto:end --> 标记；
//       内容无变化 → 不写盘（避免 mtime 抖动 + 变更流水噪音）。
import fs from 'node:fs';
import path from 'node:path';

import { COMPONENT_ROOT, ensureDir } from '../../src/dsh-butler/lib/paths.mjs';
import { writeTextAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { CATEGORIES } from '../../src/dsh-butler/lib/pitfall-sign.mjs';
import { isRecordable, rankPitfalls, suggestForm } from './pitfall-score.mjs';
import { hostTag } from '../../src/dsh-butler/lib/host-tag.mjs';
import { firstH1Index, insertAtFor, stampDocMark, isDocMarkLine } from '../../src/lib/generated-docs.mjs'; // §2.2 权威源（档级标记）

export const PITFALL_RENDER_VERSION = '0.1.0';

export const AUTO_BEGIN = '<!-- butler-auto:begin -->';
export const AUTO_END = '<!-- butler-auto:end -->';

/** 默认 docs 根（<DSH>/tools/dsh-butler → <DSH>/docs）。 */
export function defaultDocsRoot() {
  return path.resolve(COMPONENT_ROOT, '..', '..', 'docs');
}

/**
 * 主机短码（小写主机名）—— host 分文件的文件名后缀。
 * 实现统一在 lib/host-tag.mjs（三处渲染物共用一套口径，避免同机多写法再分叉）。
 * @param {{host?:string}} [opts] 单测可显式指定。
 */
export { hostTag };

function fmtTime(ms) {
  if (!Number.isFinite(Number(ms)) || !ms) return '—';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDay(ms) {
  if (!Number.isFinite(Number(ms)) || !ms) return '—';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const code = (s) => `\`${String(s ?? '').replace(/`/g, "'")}\``;

// e2e 验收探针样本判据（2026-09-11 复盘）：端到端脚本自测造出的探针错误（_p5-e2e-probe*）是
// 测试数据、不是本工具踩的坑 → 渲染端一并滤除，存量样本不上屏。
// 扫描端（未来不再入库）口径见 `_test/fixtures/pitfall-exclude.json` 的 `e2e-probe-self-test`。
const E2E_PROBE_RE = /_p5-e2e-/i;
/** 该样本是否来自 e2e 探针（看路径线索：argsHead / text）。 */
export function isProbeSample(s) {
  return E2E_PROBE_RE.test(`${s?.argsHead ?? ''} ${s?.text ?? ''}`);
}
/** 可上屏的样本（滤掉 e2e 探针样本）。 */
export function usableSamples(p) {
  return (p?.samples ?? []).filter((s) => !isProbeSample(s));
}

// ── seed 条目（历史文字坑）判据（2026-09-15）────────────────────────────────
// 权威判据 = `source:'seed'`（seed-pitfalls.mjs 写入）。name/sigKey 前缀是**兜底**：
// 跨机同步来的旧数据、或手工导入的 seed 可能只带 `seed|` 形态而没有 source 字段。
export function isSeedPitfall(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.source === 'seed') return true;
  if (String(p.name ?? '') === 'seed') return true;
  return String(p.sigKey ?? '').startsWith('seed|');
}

/** 一条坑在索引表里的一行（真坑编号 1..n；seed 编号 S1..Sm，与真坑一眼可分）。 */
function pitfallRow(p, no, seed) {
  const st = seed ? '🧬历史种子'
    : p.likelyFixed ? '🟡疑似已修复'
      : p.stage === 'candidate' ? '🚀候选' : p.stage === 'surfaced' ? '⬆️上浮' : '📝记录';
  const digest = (p.normText ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 70);
  return `| ${no} | ${code(`${p.name}|${p.code}`)} | ${code(digest)} | ${p.count} | ${p.sessionCount ?? p.sessions?.length ?? 0} | ${p.score} | ${fmtDay(p.lastSeen)} | ${st} |`;
}

/** 主题文件里「历史种子」小节的固定导语（写清它为什么被降权）。 */
const SEED_SECTION_TITLE = '## 🧬 历史种子（非高频，仅供参考）';
const SEED_SECTION_NOTE = '> **下列条目不是会话聚类出来的高频坑**：来自 8/25 前无会话原料的历史文字坑'
  + '（`踩坑大全` / persona 铁律 / 记忆）**seed 导入**，`count` 恒为 0、score 由固定基准权重衰减得出'
  + ' → 不参与主榜排序，**永不生成升级候选**，只作查阅线索。';

/** 单条坑的 Markdown 块。 */
export function renderPitfall(p, idx) {
  const seed = isSeedPitfall(p);
  const tools = Object.entries(p.tools ?? {}).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join('、') || '—';
  const flag = seed ? `🧬 历史种子（非高频：\`count\` 恒为 0，不参与主榜与升级候选）｜来源：${code(p.seedRef ?? p.origin ?? 'seed 导入')}`
    : p.likelyFixed ? '🟡 疑似已修复（30 天未再踩，已降权沉底，不删除）'
      : p.stage === 'candidate' ? '🚀 已达升级候选（≥3 次且跨 ≥2 会话 → 见面板「坑升级候选」）'
        : p.stage === 'surfaced' ? '⬆️ 已上浮（≥2 次）' : '📝 已记录';
  const sampleLines = usableSamples(p).slice(0, 2).map((s) => {
    const where = s.sessionId ? `${String(s.sessionId).replace(/^session-/, '')}#seq${s.seq ?? '?'}` : '—';
    return `  - ${code(where)} ${code(s.tool ?? '—')} ${s.time ? `@${fmtTime(s.time)}` : ''}\n    - ${code((s.text ?? '').replace(/\n/g, ' ').slice(0, 180))}`;
  }).join('\n');
  const sess = (p.sessions ?? []).slice(0, 6).map((s) => String(s).replace(/^session-/, '')).join('、');
  const more = (p.sessions?.length ?? 0) > 6 ? ` …（共 ${p.sessions.length} 个）` : '';
  const title = (p.normText ?? '').replace(/\n/g, ' ').slice(0, 80) || `${p.name}|${p.code}`;
  return [
    `### ${idx}. ${code(title)} ｜ ${p.count} 次 / ${p.sessionCount ?? p.sessions?.length ?? 0} 会话 ｜ score ${p.score}${seed ? ' ｜ 🧬 历史种子' : ''}`,
    '',
    `- **现象**：${code((usableSamples(p)[0]?.text ?? p.normText ?? '').replace(/\n/g, ' ').slice(0, 200))}`,
    `- **错误签名**：${code(p.sigKey)}`,
    `- **触发工具**：${tools}`,
    `- **样本**：`,
    sampleLines || '  - —',
    `- **次数**：${p.count} ｜ **首末次**：${fmtDay(p.firstSeen)} → ${fmtDay(p.lastSeen)}`,
    `- **涉及会话**：${sess || '—'}${more}`,
    `- **状态**：${flag}`,
    '',
  ].join('\n');
}

/**
 * 单个主题文件的自动区块内容。
 *
 * 分区（2026-09-15 起）：主榜只放**会话聚类**出来的真坑；`source:'seed'` 的历史文字坑单独成组、
 * 置于文件末尾并标「非高频」——它们 count 恒为 0，与真坑同表会稀释可读性（审计 P4/P8）。
 */
export function renderCategoryBlock(list, { category, now, meta, host }) {
  const all = list ?? [];
  const seeds = all.filter(isSeedPitfall);
  const hot = all.filter((p) => !isSeedPitfall(p));
  const head = [
    `> 本区块由 **dsh-butler P4** 自动生成/覆盖（手工内容请写在 ${code(AUTO_BEGIN)} 之外）。`,
    `> 主机：${code(host ?? hostTag())} ｜ 生成时间：${fmtTime(now)} ｜ 数据源：${code('~/.dsh/butler-pitfalls.json')} ｜ 会话聚类：${hot.length} 条 ｜ 历史种子：${seeds.length} 条`,
    '',
  ];
  if (!all.length) {
    head.push('_本主题暂无达到门槛（≥2 次）的坑。_', '');
    return head.join('\n');
  }
  head.push('## 📈 主榜（会话聚类 · ≥2 次）', '');
  if (hot.length) {
    head.push('| # | 错误签名 | 现象摘要 | 次数 | 会话 | score | 末次 | 状态 |', '|---|---|---|---|---|---|---|---|');
    hot.forEach((p, i) => head.push(pitfallRow(p, i + 1, false)));
  } else {
    head.push(`_本主题暂无达到门槛（≥2 次）的会话聚类坑${seeds.length ? `——下方 ${seeds.length} 条是历史种子（非高频），不代表本主题没踩过坑` : ''}。_`);
  }
  head.push('', '---', '');
  hot.forEach((p, i) => head.push(renderPitfall(p, i + 1)));
  if (seeds.length) {
    head.push(SEED_SECTION_TITLE, '');
    head.push(SEED_SECTION_NOTE, '');
    head.push('| # | 错误签名 | 现象摘要 | 次数 | 会话 | score | 末次 | 状态 |', '|---|---|---|---|---|---|---|---|');
    seeds.forEach((p, i) => head.push(pitfallRow(p, `S${i + 1}`, true)));
    head.push('', '---', '');
    seeds.forEach((p, i) => head.push(renderPitfall(p, `S${i + 1}`)));
  }
  if (meta?.note) head.push(`> ${meta.note}`, '');
  return head.join('\n');
}

/** 读文本（不存在/读失败 → 空串）。 */
function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * 剥掉自动区块，只留「块外的手工内容」。
 * 用途：host 文件**首次生成**时，从旧名单份文件继承主人手写/历史沉淀的正文
 * （经典坑原文、批注），但不继承旧自动块（那是上一版渲染物，会被新块整段替换）。
 */
export function stripAutoBlock(text) {
  const old = String(text ?? '');
  const b = old.indexOf(AUTO_BEGIN);
  const e = old.indexOf(AUTO_END);
  if (b < 0 || e <= b) return old;
  return `${old.slice(0, b)}${old.slice(e + AUTO_END.length)}`.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
}

/** 用自动区块替换文件里的标记段；没有标记 → atTop 插到首个 --- 之后，否则追加末尾。 */
export function spliceAutoBlock(existing, block, opts = {}) {
  const old = String(existing ?? '');
  const b = old.indexOf(AUTO_BEGIN);
  const e = old.indexOf(AUTO_END);
  const payload = `${AUTO_BEGIN}\n${block}\n${AUTO_END}`;
  if (b >= 0 && e > b) {
    return old.slice(0, b) + payload + old.slice(e + AUTO_END.length);
  }
  if (opts.atTop) {
    // 插到文件头部的第一个分隔线之后（保留标题与导语在索引之上）
    const m = old.match(/\n---\n/);
    if (m && m.index !== undefined) {
      const cut = m.index + m[0].length;
      return `${old.slice(0, cut)}\n${payload}\n\n${old.slice(cut)}`;
    }
    const rest = old.replace(/^\s+/, '').replace(/\s+$/, '');
    return rest ? `${payload}\n\n${rest}\n` : `${payload}\n`;
  }
  const sep = old.trim() ? (old.endsWith('\n') ? '\n' : '\n\n') : '';
  return `${old}${sep}${payload}\n`;
}

/**
 * 渲染所有主题文件（幂等：内容相同不写盘）。
 * @param {{pitfalls:object[], docsRoot?:string, now:number, dryRun?:boolean}} opts
 * @returns {{files:{file:string, changed:boolean, entries:number}[], dir:string}}
 */
export function renderCategoryFiles(opts) {
  const docsRoot = opts.docsRoot ?? defaultDocsRoot();
  const dir = path.join(docsRoot, '坑库');
  const now = opts.now ?? Date.now();
  const host = hostTag(opts);
  const ranked = rankPitfalls(opts.pitfalls ?? [], now).filter((p) => isRecordable(p) && !p.excluded);
  const out = [];
  if (!opts.dryRun) ensureDir(dir);

  for (const category of CATEGORIES) {
    const list = ranked.filter((p) => (p.category ?? '其他') === category);
    // host 分文件：<主题>-<host>.md（旧名 <主题>.md 不再写、不再删 —— HOST_A 侧迁移说明见文档）
    const file = path.join(dir, `${category}-${host}.md`);
    const legacyFile = path.join(dir, `${category}.md`);
    const block = renderCategoryBlock(list, { category, now, host });
    let existing = readTextSafe(file);
    // 首次生成 host 文件：继承旧名单份文件里「自动区块之外」的手工内容（批注 / 手工条目），旧文件本身不动
    const seededFromLegacy = !existing && fs.existsSync(legacyFile);
    if (seededFromLegacy) existing = stripAutoBlock(readTextSafe(legacyFile));
    const header = existing.includes('#') ? '' : `# 坑库 · ${category}（自动维护 · 主机 ${host}）\n\n`;
    const next0 = spliceAutoBlock(existing || header, block);
    // §2.2 档级标记（`pitlibrary` 族 · `坑库\*-<host>.md`）：按**渲染后真实文本**定插入点（落 L2）
    const next = stampDocMark(next0, 'pitlibrary', insertAtFor(firstH1Index(next0)));
    const changed = next !== existing;
    if (!opts.dryRun && changed) writeTextAtomic(file, next, {});
    out.push({ file, changed, entries: list.length, seeds: list.filter(isSeedPitfall).length, category, host, seededFromLegacy });
  }
  return { files: out, dir, host };
}

/** 踩坑大全降级为索引：顶部插入自动索引段（原文完整保留在下方）。 */
export function renderPitfallIndex(opts) {
  const docsRoot = opts.docsRoot ?? defaultDocsRoot();
  const host = hostTag(opts);
  // host 分文件：踩坑大全-<host>.md（旧名 踩坑大全.md 不再写、不再删）
  const file = path.join(docsRoot, `踩坑大全-${host}.md`);
  const legacyFile = path.join(docsRoot, '踩坑大全.md');
  const now = opts.now ?? Date.now();
  const ranked = rankPitfalls(opts.pitfalls ?? [], now).filter((p) => isRecordable(p) && !p.excluded);
  // seed 降权（2026-09-15）：历史种子不进「高频坑 Top 5」（它们 count 恒为 0，不是高频），只统计条数 + 指路
  const seeds = ranked.filter(isSeedPitfall);
  const clustered = ranked.filter((p) => !isSeedPitfall(p));
  const top = clustered.filter((p) => !p.likelyFixed).slice(0, 5);
  const candidates = ranked.filter((p) => p.stage === 'candidate');

  const lines = [
    '## 🐟 坑库自动索引（dsh-butler P4 维护，原文在下方完整保留）',
    '',
    `> 主机：\`${host}\` ｜ 生成时间：${fmtTime(now)} ｜ 会话聚类（≥2 次）：${clustered.length} 条 ｜ 历史种子：${seeds.length} 条 ｜ 升级候选：${candidates.length} 个`,
    '',
    `- **分主题坑库（本机 ${host} 视图）**：${CATEGORIES.map((c) => `[\`坑库/${c}-${host}.md\`](./坑库/${c}-${host}.md)`).join(' ｜ ')}`,
    `- **跨机**：另一台机另存一份 \`坑库/<主题>-<对方主机>.md\` 与 \`踩坑大全-<对方主机>.md\`（host 分文件，互不覆盖；说明见 \`docs/tick产物host分文件-20260911.md\`）。`,
    `- **怎么读**：动手前按主题翻对应文件；开工跑记忆简报会自动带 Top 3。`,
    `- **权重**：\`score = 次数 × 0.5^(距末次踩坑天数/30)\` —— 反复踩的浮顶，30 天不踩的沉底标「疑似已修复」（不删）。`,
    ...(seeds.length ? [
      `- **历史种子（${seeds.length} 条）**：8/25 前无会话原料的历史文字坑（\`count\` 恒为 0）——**不进「高频坑 Top 5」、不生成升级候选**，只作查阅线索；明细见各主题文件末尾「🧬 历史种子」小节。`,
    ] : []),
    `- **覆盖不到什么**：只扫 \`tool/result\` 的 \`isError\` —— 主人手动救场类故障（守护鱼死 / GUI 卡死 / DSH 起不来）**永不入库**；「某主题 0 条」≠「该主题没坑」，说明见 \`坑库/README-${host}.md\`「已知边界」。`,
    '',
  ];
  if (top.length) {
    lines.push('### 高频坑 Top 5（自动）', '');
    top.forEach((p, i) => {
      lines.push(`${i + 1}. ${code(`${p.name}|${p.code}`)} — ${p.count} 次 / ${p.sessionCount ?? 0} 会话，score ${p.score}，末次 ${fmtDay(p.lastSeen)}`);
      lines.push(`   - ${code((usableSamples(p)[0]?.text ?? p.normText ?? '').replace(/\n/g, ' ').slice(0, 160))}`);
    });
    lines.push('');
  } else {
    lines.push('_暂无达到门槛的高频坑。_', '');
  }
  if (candidates.length) {
    const FORM_LABEL = { check: '①自动检查项（最优）', skill: '②内联技能', persona: '③persona 铁律' };
    lines.push('### 升级候选（≥3 次跨 ≥2 会话，需主人批准，永不自动改 persona / 技能）', '');
    for (const c of candidates.slice(0, 5)) {
      const form = FORM_LABEL[suggestForm(c).form] ?? suggestForm(c).form;
      lines.push(`- ${code((c.normText ?? `${c.name}|${c.code}`).replace(/\n/g, ' ').slice(0, 70))} — ${c.count} 次 / ${c.sessionCount} 会话 → 建议形态：${form}`);
      // 选项 3（2026-09-11 主人拍板 · 卡 0f1f44da 待议 C）：建议形态是启发式猜的、可能跑偏
      // （实测 AUDIT_NOT_PASSED 被猜成「路径存在性预检」，真实成因是没走 P5 审计流程）
      // → 同时给出「原始签名 + 样本片段」，让主人一眼看出发因，不依赖启发式判断。
      const sample = usableSamples(c)[0]?.text ?? '';
      lines.push(`    - 原始签名：${code(String(c.sigKey ?? `${c.name}|${c.code}`).replace(/\n/g, ' ').slice(0, 120))}`);
      if (sample) lines.push(`    - 样本片段：${code(String(sample).replace(/\n/g, ' ').slice(0, 140))}`);
    }
    if (candidates.length > 5) lines.push(`- …（共 ${candidates.length} 个候选，完整清单见面板「坑升级候选」（P4 候选池状态文件））`);
    lines.push('');
  }

  let existing = readTextSafe(file);
  // 首次生成 host 索引文件：继承旧名单份文件的正文（经典坑原文完整保留在下方）
  const seededFromLegacy = !existing && fs.existsSync(legacyFile);
  if (seededFromLegacy) existing = stripAutoBlock(readTextSafe(legacyFile));
  const rawExisting = existing;
  // 索引必须常驻文件顶部（首次可能被追加到末尾）→ 有标记先剥离，再按 atTop 重新插入
  const b = existing.indexOf(AUTO_BEGIN);
  const e = existing.indexOf(AUTO_END);
  if (b >= 0 && e > b) {
    existing = (existing.slice(0, b) + existing.slice(e + AUTO_END.length)).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
    // 2026-10-14（卡「收口尾段·四处收口」D3 · 渲染幂等真红）：档级标记行由下面的 stampDocMark
    //   重新盖上（幂等：前 5 行内原位替换，找不到才按 insertAtFor 插入）。若把它留在基底里，
    //   spliceAutoBlock 在「基底里没有 \n---\n 分隔线」的形态下走 else 分支 ⇒ auto block 被拼到
    //   标记**之上**、标记被挤到块下方 ⇒ stampDocMark 在前 5 行找不到标记 ⇒ 再插一个 ⇒ 每渲染一次
    //   +1 个标记行、文件永不幂等（实测空 docsRoot 连渲染两次：标记行 1→2、字节 2205→2253，且逐次增长）。
    //   故剥块后一并滤掉标记行 —— 渲染物里标记的唯一来源就是 stampDocMark。
    existing = existing.split('\n').filter((l) => !isDocMarkLine(l)).join('\n').replace(/\s+$/, '\n');
  }
  const next0 = spliceAutoBlock(existing, lines.join('\n'), { atTop: true });
  // §2.2 档级标记（`pitfall` 族 · `踩坑大全-<host>.md`）：插入点**优先用 tick 下传值**（返回值真参与拼接），
  //   未传则按渲染后真实 H1 定（host-c 实测 H1 索引 44 ⇒ 夹紧落 L5；host-a ⇒ L2）
  const markAt = Number.isInteger(opts.docMarkAt) ? opts.docMarkAt : insertAtFor(firstH1Index(next0));
  const next = stampDocMark(next0, 'pitfall', markAt);
  const changed = next !== rawExisting;
  if (!opts.dryRun && changed) writeTextAtomic(file, next, {});
  return { file, changed, entries: ranked.length, candidates: candidates.length, host, seededFromLegacy };
}

/** 坑库 README（边界 + 字段说明 + 自指豁免）。host 分文件：README-<host>.md。 */
export function renderReadme(opts) {
  const docsRoot = opts.docsRoot ?? defaultDocsRoot();
  const dir = path.join(docsRoot, '坑库');
  const host = hostTag(opts);
  const file = path.join(dir, `README-${host}.md`);
  const now = opts.now ?? Date.now();
  const raw = `# 坑库（dsh-butler P4 自动维护 · 主机 ${host}）

> 生成/维护：\`<pkg>/jobs/pitfall-tick.mjs\`（纯脚本 0 token）
> 数据源：\`~/.dsh/butler-pitfalls.json\`（跨机同步；两机各写各的 → 属"分叉类"，需按 A4 口径合并）｜ 扫描记账：状态目录下的坑扫描台账（本机）
> 生成时间：${fmtTime(now)} ｜ 主机短码：\`${host}\`

## host 分文件（2026-09-11 起，根治双机 depart 挡推）

两台机各跑 tick，渲染物含「生成时间 / 条目数」——同名文件必然分叉，谁最后 tick 谁覆盖谁。故本目录的
**所有渲染物一律带主机短码**（照 \`~/.dsh/butler-barewatch/<host>-ledger.jsonl\` 先例）：

| 产物 | 本机文件名 | 说明 |
|---|---|---|
| 分主题坑库 | \`坑库/<主题>-${host}.md\` | 6 个主题：${CATEGORIES.join(' / ')} |
| 索引 | \`踩坑大全-${host}.md\`（在 \`docs\\\`） | 顶部自动索引段 + 原文保留 |
| 本说明 | \`坑库/README-${host}.md\` | 本文件 |

另一台机的产物是 \`*-<对方主机>.md\`，两台并存、互不覆盖。

**旧名单份文件（\`坑库/<主题>.md\` / \`踩坑大全.md\` / \`坑库/README.md\`）已于 2026-09-14 全部清除**
（HOST_A 2026-09-12、HOST_C 2026-09-14 各一轮收口，见 \`<workspace>\\docs\\tick产物host分文件-20260911.md\` §8）——
本目录现在只有 \`*-<主机短码>.md\` 一种文件名，本版渲染器**只写 host 名、不写旧名**。保留的只有一条兜底：
若旧名单份文件意外出现（例如从旧备份恢复），**仅在首次**生成对应 host 文件时继承它「自动区块之外」的
手工内容，旧文件本身不写、不删。

## 这里是什么

DSH 会话日志（\`tool/result\` 的 \`isError:true\`）里真实翻过的车，按**错误签名**聚类后的坑库。
目的不是"记下来"，而是**消灭掉**：反复踩的坑 → 权重上浮 → ≥3 次跨 ≥2 会话 → 生成「升级候选」
（①做成自动检查项最优 ②内联进技能 ③铁律级才动 persona）。**永不自动改 persona / 技能**。

## 扫描范围（两棵树）

| 树 | 路径 | 说明 |
|---|---|---|
| 活跃 | \`~/.dsh\\sessions\\**\\session*.jsonl.zstd\` | 当前会话 |
| 归档 | \`~/.dsh\\_archived-sessions\\**\\session*.jsonl.zstd\` | 自动归档批次（富矿，持续增量） |

记账键 = **sessionId**（不按路径）：会话归档后文件路径变化不会触发重复全扫。

## 字段口径

- **count** = 同签名在扫描范围内的总出现次数（同会话内重复也计、跨会话累加）
- **score** = \`count × 0.5^(距末次踩坑天数 / 30)\`；30 天不再出现 → 标「疑似已修复」（降权沉底，**不删除**）
- **排除**（不入库）：用户取消/回合打断、read 探查型不存在、rg 无匹配、外部服务限流、工具权威语义拒绝
- **不排除**：权限拒绝（配置问题）、grep/glob 搜索路径不存在（路径假设错）、edit/write 未先读、old_string 不存在…

完整正反样本见 \`<pkg>/jobs/_test\\fixtures\\pitfall-exclude.json\`（唯一权威源，改口径先改 fixture）。

## 诚实边界（方案 §4「历史 seed」）

- 覆盖上限 = **现存会话文件的时间范围**；本机现存最老会话见下表。
- 8/25 前无会话原料的坑：从 \`踩坑大全.md\` + persona 血泪段 + 记忆坑类条目 **seed 导入**（标 \`source:seed\`，不计 count）。
- 更早历史（无记忆 / 无归档）**不追索** —— 只留在 docs / persona / 冷备里。
- **seed 的渲染口径（2026-09-15 起）**：seed 条目**不再混进主榜** —— 单独成组放在主题文件末尾
  （标 \`🧬 历史种子（非高频）\`、编号 \`S1…\`），也不进索引「高频坑 Top 5」、不生成升级候选。
  判读时别把 seed 当高频坑：它们 \`count\` 恒为 0，score 由固定基准权重衰减得出。

## 已知边界：这套库覆盖不到什么（2026-09-15 登记）

**数据源只有一条通道**：会话日志 \`tool/result\` 的 \`isError:true\`（agent 工具报错）。因此下面这些
**真实翻过的车永不入库**：

- **主人手动救场类故障**：守护鱼死 / 双守护鱼、GUI 卡死、DSH 起不来 —— 不经过 agent 工具调用
- **脚本自身日志里的失败**：脚本打印 ERROR 但会话里没有工具 \`isError\`
- **人判断类事件**：跨机挡推裁决、看板账本分叉 —— 是脚本输出 + 人决策，不是工具异常
- **非报错型认知坑**：例如「用会执行副作用的脚本去查数量」这类流程错误

**判读纪律（最容易读反的一条）**：某主题写着「本主题暂无达到门槛（≥2 次）的坑」或 0 条，
只能读作「**该主题在工具错误通道里没达到 2 次**」，**绝不能读作「该主题没坑」**。
反证：本机正是守护鱼的实际运行机，而「守护鱼」主题常年 0 条 —— 故障真实发生过，只是没从这条通道流过。

**手工登记通道**：上述故障请写进对应主题文件 \`<!-- butler-auto:begin -->\` **之外**的
「## 手动登记（日期）」小节（现象 / 判据·发现方式 / 处置 / 根因归属 四段式；范例见 \`坑库/同步-${host}.md\`），
渲染会原样保留块外内容。

> 取证与来由：\`<workspace>\\docs\\长期库大扫除-20260914\\skills-pitfalls-audit.md\` §B（P3 结构性盲区、
> P4/P8 seed 噪声、P6 README 过期）；本页这三项已于 2026-09-15 按该审计整改。

## 自指豁免（P5 写后审计必须豁免）

本目录（坑库）、\`docs\\管家报告\\\`、\`docs\\变更流水\\\` 的渲染视图、状态目录下的审计流水也是
**管家自身写入的路径**。P5 的写后审计必须豁免它们，否则 P4 自动写坑库会被自己判违规并回滚（死循环）。
豁免清单代码源：\`<pkg>/jobs/lib\\butler-write-paths.mjs\`。
`;
  // §2.2 档级标记（`pitlibrary` 族 · `坑库\README-<host>.md`）：按渲染后真实文本定插入点（落 L2）
  const text = stampDocMark(raw, 'pitlibrary', insertAtFor(firstH1Index(raw)));
  const existing = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();
  const changed = existing !== text;
  if (!opts.dryRun && changed) writeTextAtomic(file, text, {});
  return { file, changed, host };
}

/** 一次性渲染全部（主题文件 + 索引 + README）。 */
export function renderAll(opts) {
  const cats = renderCategoryFiles(opts);
  const idx = renderPitfallIndex(opts);
  const readme = renderReadme(opts);
  return { categories: cats.files, index: idx, readme, dir: cats.dir, host: cats.host };
}
