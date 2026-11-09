// dsh-butler / lib/entities.mjs —— P7「会照应」实体索引（卡 [8]）
//
// 契约来源：docs\大管家v2方案-从只读到真管家-20260909.md §4 P7（行 884-904）
//   · 实体关联索引 %USERPROFILE%\.dsh\butler-entities.json：规范化实体表 + 别名归一
//   · 首建即全量，六路源：monitor-registry CI 名 / 方案各 P 标题 / 看板卡标题 /
//     docs\*.md 文件名 / _archive 顶层目录名 / 记忆库标题
//   · v2.4 补：_archive 目录名剥离时间戳 / 纯 hash / 纯日期段，只留语义名
//   · v2.2 补：IDF 过滤 —— 出现于 >10% 载体的实体不触发耦合提示（只用于索引）
//
// 设计要点（为什么这么做）：
//   1. **纯文本、0 token、无 Agent**：实体发现是确定性的字符串/字符级统计，不调模型。
//   2. **词表自举**（无手工词典）：候选词从语料自身挖掘 —— 枚举「标题类文本」的
//      中英文子串（2..8 字符），按**出现在多少个不同载体**计频，≥bootstrapMinCarriers 的
//      才进词表。中文无空格，「出现载体数」是比出现次数更稳的信号（同一标题里的
//      n-gram 碎片彼此不重复计数）。
//   3. **误报压制三件套**：词表门槛 + 停用词/泛化词（报告/方案/文档…）+ IDF 阈值
//      （>10% 载体 → 只索引不提示）。spike A4 实测误报率门槛 ≤20%，超了降级为
//      「只做卡 ↔ 方案单类匹配」（见 docs\P7会照应-使用与验收-20260912.md）。
//   4. **状态文件只走 butler-store**：readJson/updateJson/writeJsonAtomic/acquireTickLock，
//      禁止自己 JSON.parse(readFileSync) 后写回（底座契约）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { butlerPaths, dshHome } from '../../src/dsh-butler/lib/paths.mjs';
import { resolveStatePath } from '../../src/dsh-butler/lib/state-paths.mjs';
import { readJson, updateJson, writeTextAtomic } from '../../src/dsh-butler/lib/store.mjs';
import { writeStateText } from '../../src/dsh-butler/lib/dual-write.mjs';
// 泛词 / 碎片黑名单独立成文件（lib/entity-stopwords.mjs）：它是会反复微调的表，
// 单独放便于审查"为什么这个词被拉黑"（spike A4 与使用中沉淀）。
import { GENERIC_WORDS, isFragment } from './entity-stopwords.mjs';

/** 组件版本（"我的版本 ⊆ 产品版本"，见 lib/version.mjs）。 */
export const COMPONENT_NAME = 'butler-entities';
export const COMPONENT_VERSION = '0.1.0';
export const ENTITIES_SCHEMA = 1;
/**
 * 索引"统计字段版本"：改动 byEntity / 实体记录字段结构或判据口径时 +1 → 强制重建索引。
 * （为什么需要它：corpusHash 只反映载体内容；改了统计口径但语料没变时，
 *   旧索引会被当"未变化"复用 → 新字段缺失、判据静默失效。2026-09-12 实测踩过。）
 * ⚠️ **2026-10-10（卡「冲刺600·I域P6P7两项」）2 → 3**：`lib/entity-stopwords.mjs` 增补 4 个英文泛词
 *  （done / event / events / source，均取自生产真跑读数）。词表属**统计口径**而语料 hash 不变 ⇒
 *  不 +1 的话新黑名单**永不生效**（旧索引的 highFreq / blacklisted 被原样复用）。证据见
 *  `docs\交付报告-冲刺600-I域P6P7两项-20261010.md`。
 * ⚠️ **2026-10-11（卡「冲刺600·I域·P7索引残片治理」）6 → 7**：`normalizeKey` 增「剥前导点」
 *  （消 `.dsh` 这类前导点残键）。属**统计口径**而语料 hash 不变 ⇒ 不 +1 则旧索引被原样复用、
 *  修复**永不生效**。
 *  ⚠️ 同卡**停手未落**：`CJK_DELIM_RE` 补中文引号「」『』 一事，经隔离实测**副作用超预期**
 *  （消 2 个垃圾键但**新增 56 个键**、耦合提示 85→95 条），按卡面 §2.1 判据停手待主人拍板。
 *  实测数据与逐项对照：`docs\交付报告-冲刺600-P7索引残片治理-20261011.md`。
 * ⚠️ **2026-10-21（V3.0.0 功能面 G 段 · R-035）7 → 8**：两处**统计口径**变更 ⇒ 必须 +1，否则旧索引
 *  被原样复用、修复永不生效：
 *   (1) `segmentsOf` 的「英文 / 数字 token」路径加了**混排准入判据**：含 CJK 的 token 必须带
 *       「字母开头、≥2 字符的拉丁前缀」才允许入词 —— 旧写法无条件 `seg.split(/[._-]+/)` + 整段入词，
 *       于是 `2026.9封口` 产出 `9封口`/`2026.9封口`、`「建卡」与『核实』后的进度` 整段成了实体键
 *       （全是"混排整段当英文 token"的假实体）。真混排名 `v3功能面`/`v2.9封口`/`r060隔离闸` 不受影响。
 *       ⚠️ 只动这一条判据：CJK 起头段的 `refineCJK(整段)` 口径**不动**（动它 = 全库键大改名，
 *       与 2026-10-11「CJK_DELIM_RE 补引号」停手结论同源）。
 *   (2) `readMemoryTitles` 的 80 字切点从「硬切」改为「按词边界收敛」（修 `process`→`pro`、
 *       `sessions`→`ses`、`tools`→`too` 这类半词残片）。
 *  实测增量与耦合提示对照见交付报告 `docs\交付报告-V3功能面-G段-R035实体抽取质量-20261021.md` §3。
 */
export const ENTITIES_INDEX_REV = 8;

/** IDF 阈值（方案 v2.2）：出现于 >idfRatio 载体的实体不触发耦合提示，只用于索引。
 *  注意：方案 v2.2 写作「>10%（约 >24 处）」，那是按 14 卡 + 38 文档 + 187 记忆的规模估的；
 *  2026-09-12 实测语料已翻倍（116 卡 + 92 docs + 327 _archive + 401 记忆 ≈ 945 载体），
 *  10% = 95 处 → 实测只有 4 个实体被过滤，IDF 形同失效（spike A4 第一轮。
 *  故收紧为 **5%** 并配 minHighFreq 地板（见 HIGH_FREQ_MIN）。
 *  ⚠️ **订正（2026-10-10 · 卡「冲刺600·补核心库」gap-2-17）**：上面原写「故取 8%」与代码
 *  `IDF_RATIO = 0.05` **不一致**（注释漂移），已按现值订正为 **0.05**。同日二次实测（生产索引
 *  `~/.dsh/butler-entities.json`：carriers=4053 / entities=658 / builtAt=1791564534312）：
 *    · ratio=0.05 ⇒ idfLimit = max(8, ceil(4053×0.05)) = **203** ⇒ highFreq（只索引不提示）= **10**；
 *    · ratio=0.10 ⇒ idfLimit = **406** ⇒ highFreq = **3**；差额 7 个实体 = butler / panel / deploy /
 *      doc / sess / pane / 大管家（n=230~311）—— 全是泛词或中英子串枚举碎片，**本就不该触发耦合提示**。
 *  ⇒ **判定：维持 0.05**（比方案原口径更严 = 提示更干净，且是 2026-09-12 实测后的主动收紧，非漂移）；
 *    方案 §4 P7（L944）的「>10%」以**就地订正注**对齐，不改方案原文。
 *  🔁 **同日三次复测（2026-10-10 · 卡「冲刺600·I域P6P7两项」· **同一语料快照** A/B 对照，
 *    脚本 `_tmp\p7-idf\compare-idf.mjs`，只读不落盘）**：语料 4372 载体 ⇒
 *      · ratio=0.05 ⇒ idfLimit 219 / highFreq 14；
 *      · ratio=0.10 ⇒ idfLimit 438 / highFreq 3；
 *      · **耦合候选 70 → 70（一条不增不减）；脱管候选 4 → 6（多出 doc / docs 两个 kind 名）**。
 *    成因：耦合侧另有 `lib/reconcile.mjs#couplingCandidates` 的 maxRatio(0.03 ≈ 131 处) 更严 ⇒
 *    IDF 对耦合**无额外约束力**（改不改都一个样）；脱管侧只认 highFreq ⇒ 0.10 会把
 *    219<n≤438 的伞形词（deploy/sess/butler/doc/冲刺/大管家/冲刺600/docs/pane/panel/复核）
 *    放回提示池 ⇒ **「调回 0.10 降噪」方向是反的（净增噪）**。
 *    ⇒ 阈值项结论 = **维持 0.05、无需改动**；噪音真源是**词表漏词**（见 entity-stopwords.mjs）。 */
export const IDF_RATIO = 0.05;
/** 高频地板：载体数 ≥ 此值且占比 ≥ idfRatio 才算高频（小语料下防止误杀）。 */
export const HIGH_FREQ_MIN = 8;
/** 词表自举门槛：候选词须出现在 ≥N 个不同载体。 */
export const BOOTSTRAP_MIN_CARRIERS = 3;
/** 中英文子串枚举长度范围。 */
const MIN_LEN = 2;
const MAX_LEN = 8;

export const SOURCE_KINDS = ['board', 'plan', 'docs', 'archive', 'memory', 'monitor'];
/** 核心载体（"职责型"）：卡 / 方案节 / 文档。耦合提示必须落在核心载体上才有统筹价值。 */
export const CORE_KINDS = ['board', 'plan', 'docs'];

/**
 * DSH 根（工作区树：含 `docs/`、`tools/`、`_archive/`）。
 * 优先级：`DSH_BUTLER_DSH_ROOT`（显式指定；单测与多工作区用）> `~/DSH`（缺省推导）。
 * 为什么不再写死盘符：发布包硬编码作者机器的绝对路径，会让干净机器上的「三件套缺项」扫描
 *   静默扫空 —— 不报错、只是永远没有结果，比报错更难查。
 */
export function dshRoot() {
  const explicit = String(process.env.DSH_BUTLER_DSH_ROOT ?? '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), 'DSH');
}

export function entitiesPath(home = dshHome()) {
  return resolveStatePath('butler-entities.json', { home }).path;
}

// ---------------------------------------------------------------- 停用词 / 泛化词
//
// 两类都要剔：
//   · 结构词（的/和/与/在…）—— 出现在任何中文里；
//   · 泛化词（方案/报告/文档/测试/设计/验收…）—— 是"文体"不是"实体"，跨载体高频但无指向性。
// 泛化词只做**整串相等**剔除（不整段剔），否则「方案审核规程」这类真名会被连坐。
const STOP_TOKENS = new Set([
  // 结构 / 虚词
  '一个', '这个', '那个', '什么', '怎么', '为什么', '因为', '所以', '如果', '但是', '不过', '而且', '就是',
  '可以', '不能', '不是', '是否', '已经', '还是', '然后', '目前', '现在', '之前', '之后', '同时', '另外',
  '我们', '你们', '他们', '自己', '大家', '全部', '所有', '每个', '其中', '以及', '并且', '或者', '其中',
  '问题', '情况', '结果', '原因', '方式', '时候', '地方', '东西', '内容', '部分', '相关', '需要', '使用',
  '进行', '出现', '发现', '知道', '看到', '看到', '没有', '一起', '一样', '一定', '可能', '应该', '必须',
  // 文体 / 泛化（无指向性）
  '方案', '文档', '报告', '设计', '测试', '验收', '清单', '规范', '说明', '手册', '指南', '记录', '流程',
  '步骤', '结论', '摘要', '目录', '索引', '使用', '以及', '相关', '系列', '详情', '细节', '版本', '更新',
  '问题', '分析', '评估', '复盘', '总结', '通知', '提醒', '建议', '规则', '约定', '铁律', '机制', '功能',
  '确认', '实现', '开发', '交付', '执行', '运行', '状态', '检查', '排查', '修复', '改动', '变更', '字段',
  '需要', '支持', '一个', '两个', '三件套', '一条', '一步', '首次', '手动', '自动', '默认', '当前',
  '本机', '双机', '跨机', '后续', '前置', '收尾', '开工', '前', '后'
]);


/** 纯噪音形态：时间戳 / hash / 纯数字 / 纯日期 / 时间。 */
const NOISE_RE = [
  /^\d+$/,                        // 纯数字
  /^[0-9a-f]{6,}$/,               // 疑似 hash / 十六进制段
  /^\d{4}-\d{2}-\d{2}$/,          // 日期
  /^\d{2}-?\d{2}$/,               // 时刻 / 短日期
  /^\d{4}s?$/,                    // 年份
  /^\d+[kKmM]b?$/i,
  /^v\d+$/,                       // 纯主版本（v2 / v5）—— 噪声重，版本实体用 v2.4 这种带小版本形态
  /^\d+\.\d+(\.\d+)?$/,           // 纯版本号（0.1.5 / 1.2）—— 单机内随处可见，无指向性
  /^[a-z]{1,2}\d{1,2}$/i,         // 短代号（a1 / t2 之类噪音）→ 由词表门槛兜（真代号会被 6 位规则救）
  /^[\u3000-\u303f\uff00-\uffef]+$/, // 纯标点
];

/** 允许的最小实体长度（归一化后）。 */
const MIN_ENTITY_LEN = 2;

// ---------------------------------------------------------------- 归一化

/** 文件名后缀 / 日期段剥离（路径形式归一化的核心：同一文件的各种写法 → 一个实体）。 */
const FILE_EXT_RE = /\.(md|json|jsonl|mjs|cjs|js|ps1|cmd|bat|vbs|yaml|yml|txt|png|jpg|csv|log|db|ts|tsx|py)$/i;
const DATE_TAIL_RE = [
  /-\d{8}(-\d{4,6})?$/,
  /-\d{4}-\d{2}-\d{2}([tT]\d{2}-\d{2}-\d{2})?$/,
  /-\d{4}-\d{2}-\d{2}[tT]\d{6,}$/,
  /-\d{6}$/,
  /-v?\d+\.\d+\.\d+$/,
];

/**
 * 路径形式 → 语义名：取 basename、剥扩展名与日期尾巴，再走通用归一化。
 * `docs\guard2-设计方案-20260907.md` → `guard2-设计方案`
 */
export function normalizePathLike(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  s = base.replace(FILE_EXT_RE, '');
  for (const re of DATE_TAIL_RE) s = s.replace(re, '');
  return s;
}

/**
 * 通用归一化（别名 / 大小写 / 分隔符 / 路径形式）。
 * 返回显示用规范键：小写、去空白、分隔符收敛为 '-'。
 */
export function normalizeKey(input) {
  let s = normalizePathLike(input);
  if (!s) return '';
  s = s.toLowerCase();
  s = s.replace(/[_\s\u00a0]+/g, '-');
  s = s.replace(/[—–－]+/g, '-');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  // 全角 → 半角（数字 / 字母 / 括号 / 冒号），中文标点保留
  s = s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[·、]+/g, '');
  // 剥前导点（2026-10-11 · 卡「冲刺600·I域·P7索引残片治理」）：
  //   路径写法（`~/.dsh`、以 `.` 开头的目录名）归一化后残留 `.dsh` —— `FILE_EXT_RE` 管的是
  //   **后缀**扩展名，不吃前导点。只剥**前导**点：串中间的 `.` 是语义的一部分
  //   （`v2.9.x` / `a.mjs`），一律不动。放在归一化最后一步：全角句点 `．` 经上面
  //   全角→半角折叠后也会变成点，必须在这之后剥。
  s = s.replace(/^\.+/, '');
  return s;
}

/**
 * 别名表：把同一事物的多种写法收敛到规范键。
 * 判据：**同一实体在本生态里被稳定地用两种以上写法称呼**才登记；不确定的宁可不登记
 * （多登记会把两个真实体合并 → 耦合提示张冠李戴）。
 * 键 = 归一化写法，值 = 规范键。
 */
const ALIASES = new Map(Object.entries({
  '守护鱼': 'guard2',
  'dsh-guard': 'guard2',
  'guard-ctl': 'guard2',
  'guard-core': 'guard2',
  'guard-mjs': 'guard2',
  'butler-tickd': 'tickd',
  'tickd-mjs': 'tickd',
  'butler-locks': 'locks',
  'butler-store': 'store',
  'butler-scheduler': 'scheduler',
  'task-board-local': 'task-board',
  'dsh-task-board-local': 'task-board',
  'task-board-local-store': 'task-board',
  'entity-json': 'entities',
  'butler-entities': 'entities',
  'butler-reconcile': 'reconcile',
  'reconcile-mjs': 'reconcile',
  'imagegen': 'dsh-imagegen',
  'dsh-imagegen-plugin': 'dsh-imagegen',
}));

/** 应用别名（幂等）。 */
export function canonKey(key) {
  const k = String(key ?? '');
  return ALIASES.get(k) ?? k;
}

/** 别名/归一化的对外单入口：任意写法 → 规范键（单测入口）。 */
export function canonicalize(input) {
  return canonKey(normalizeKey(input));
}

/** 是否噪音候选（时间戳 / hash / 纯数字 / 单字泛词）。 */
export function isNoiseToken(key) {
  const k = String(key ?? '');
  if (!k || k.length < MIN_ENTITY_LEN) return true;
  if (STOP_TOKENS.has(k)) return true;
  if (GENERIC_WORDS.has(k)) return true;
  if (isFragment(k)) return true;
  // 复合词里的泛词尾巴（如「本体实测」「第一判定」）：整串剔不掉，就退回尾巴形态再判
  if (k.length > MAX_LEN) {
    const noTail = k.replace(/[\u4e00-\u9fff]$/, '');
    if (noTail !== k && (STOP_TOKENS.has(noTail) || GENERIC_WORDS.has(noTail))) return true;
  }
  for (const re of NOISE_RE) if (re.test(k)) return true;
  // 首尾都是 '-' 的碎片（枚举切出来的残渣）
  if (/^-|-$/.test(k)) return true;
  // 全英文 1~2 字符（a / ab）：太泛，除非是已知别名
  if (/^[a-z]{1,2}$/.test(k) && !ALIASES.has(k)) return true;
  return false;
}

// ---------------------------------------------------------------- 子串枚举（自举用）

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const isCJK = (ch) => CJK_RE.test(ch);
/** 词段起止的虚词（分词边界）：以这些字开头的词段几乎必是碎片 → 从该字之后重新起段。 */
const CJK_BOUNDARY = '的了在与我或及把被从向对为是有也都不还让给而并且但则因以其此各每均只才若把';
const CJK_DELIM_RE = /[\s\u3000,，、。;；:：!！?？()（）\[\]【】{}<>《》"'`|/\\·—–\-_+*#~^%=&@$①②③④⑤⑥⑦⑧⑨⑩]+/;
/** 混排 token 准入用的「拉丁前缀」：字母开头、≥2 字符（`v3` / `v2.9` / `r060` / `dsh`）。 */
const MIXED_LATIN_PREFIX_RE = /^[A-Za-z][A-Za-z0-9]+/;
/** 混排 token 准入：纯拉丁/数字直接过；含 CJK 的必须带上述拉丁前缀（见 segmentsOf 内注释）。 */
const isMixedTokenOk = (t) => !CJK_RE.test(t) || MIXED_LATIN_PREFIX_RE.test(t);

/**
 * 把一个词段切成更细的边界段（中文按虚词边界，英文保持 token）。
 * 例：「P6会望风-使用与验收」→ cjk「会望风」/「使用」/「验收」。
 */
function refineCJK(seg) {
  const out = [];
  let cur = '';
  for (const ch of seg) {
    if (CJK_BOUNDARY.includes(ch) && cur.length >= 2) { out.push(cur); cur = ''; continue; }
    if (CJK_BOUNDARY.includes(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 提取"词段"（结构化候选实体）。
 *
 * **为什么用词段而不是 n-gram 字符枚举**（2026-09-12 spike A4 实测教训）：
 * 字符级 n-gram（2..8 长度全切）会从词中间切出大量碎片（「使用与验收」「可并行」「任务看」），
 * 它们是"标题里出现过的东西"，不是实体 —— 第一轮抽查 20 条误报率 ~50%，
 * 靠黑名单只能补救不能根治。词段是**按标点 + 中文虚词切出来的完整词组**，
 * 天然带边界，「guard2」「会照应」「跨机同步」「tickd」这类真实体才切得出来。
 */
export function segmentsOf(text) {
  const s = String(text ?? '');
  const raw = s.split(CJK_DELIM_RE).filter(Boolean);
  const out = new Set();
  for (const seg of raw) {
    if (isCJK(seg[0])) {
      // 中文串：按虚词再切
      for (const piece of refineCJK(seg)) {
        if (piece.length >= 2) out.add(piece);
      }
    }
    // 混排串（中英混）逐字符扫一遍，分出 cjk / latin 两类
    if (!isCJK(seg[0])) {
      let i = 0;
      while (i < seg.length) {
        if (isCJK(seg[i])) {
          let j = i;
          while (j < seg.length && isCJK(seg[j])) j++;
          for (const piece of refineCJK(seg.slice(i, j))) if (piece.length >= 2) out.add(piece);
          i = j;
        } else i++;
      }
    }
    // 英文 / 数字 token：整段 + 按连接符子词（≥3 字符）
    // ⚠️ **R-035 准入判据（2026-10-21）**：含 CJK 的混排 token 只有带「字母开头、≥2 字符的拉丁前缀」
    //    才允许入词 —— `v3功能面` / `v2.9封口` / `r060隔离闸` / `p3叫醒目标绑定` 是真名；
    //    `9封口`（`v2.9封口` 被 split 切一半）/ `x冲刺600`（`v2.9.x冲刺600` 的残段）/
    //    `2026.9封口`（纯数字前缀）/ `「建卡」与『核实』后的进度`（无拉丁前缀）都是假实体。
    //    纯拉丁/数字 token 不受影响（旧行为不变）。
    for (const part of seg.split(/[._-]+/)) {
      if (part.length >= 3 && isMixedTokenOk(part)) out.add(part);
    }
    if (seg.length >= 3 && isMixedTokenOk(seg)) out.add(seg);
  }
  const norm = new Set();
  for (const c of out) {
    const k = canonKey(normalizeKey(c));
    if (!isNoiseToken(k)) norm.add(k);
    // 中文：≥2 字（虚词边界已保证是完整词组）；英文：≥3 字符
    //   英文用「≥3 字符」而不是「含数字」：实测项目词（tickd/modlens/deepseek/persona/guard2）
    //   多为纯字母，硬性要求数字会误杀；反而 super-deep/character/unique 类长词靠黑名单剔。
  }
  return norm;
}

/** 兼容旧名（词段口径）。 */
export const enumerateCandidates = segmentsOf;

/**
 * 词表自举：候选词 → 出现在多少个不同载体。
 *
 * 门槛（bootstrapMinCarriers）：跨载体重复是"它是个真名词"的最强无监督证据 ——
 * 一次性描述、单卡内部行话都不会跨载体出现。中文词段额外要求长度 ≥3
 * （2 字词段太泛：状态/写入/回滚/看板…）。
 */
export function bootstrapVocabulary(carriers, opts = {}) {
  const bootMin = opts.bootstrapMinCarriers ?? BOOTSTRAP_MIN_CARRIERS;
  const byWord = new Map();
  carriers.forEach((c, idx) => {
    for (const w of segmentsOf(c.title)) {
      // 中文 2 字词段只在 ≥2 处出现且两处都是"标题词"时才收（这里统一按 bootMin 收，泛词由黑名单管）
      let set = byWord.get(w);
      if (!set) { set = new Set(); byWord.set(w, set); }
      set.add(idx);
    }
  });
  const out = new Map();
  for (const [w, set] of byWord) if (set.size >= bootMin) out.set(w, set.size);
  return out;
}

// ---------------------------------------------------------------- 文本匹配
//
// 为什么不用朴素 includes：词表里的英文键含 '-'，而正文里可能写成 `guard2` / `dsh-guard.ps1`
// / `butler-reconcile.mjs`（带扩展名、不同分隔符）。这里对文本做**同口径归一化**后，
// 用"最长优先 + 首 2 字符锚点"的切片匹配：
//   · 归一化把大小写/分隔符差异抹平；
//   · 锚点（前 2 字符）用 indexOf 预筛，避免每个词都全串扫描。

/**
 * 归一化整段文本（**提取用**）。
 *
 * ⚠️ 关键差异（2026-09-12 实测踩坑）：这里**不能**沿用 normalizeKey —— 那个函数把
 * 所有空白转成 `-`，于是 `everywhere 批量卡` 变成 `everywhere-批量卡`，词尾紧跟 `-`，
 * 词表里的 `everywhere` 就永远匹配不上（除非实体正好在行尾）。
 * 结果表现为"索引里只剩不带空格的中文词"，英文实体整片消失。
 * 正确做法：只做大小写/全角/标点归一，**空格一律转 `\u0001` 分隔符**（保留"词边界"语义）。
 */
export function normalizeText(text) {
  const s = String(text ?? '').replace(/[\r\n\t]+/g, ' \u0001 ');
  const folded = s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase();
  return folded.replace(/[\s\u00a0\u3000]+/g, '\u0001').replace(/[—–－]+/g, '-');
}

/**
 * 从文本里提取命中的词表实体。
 * 词表键的归一化口径（normalizeKey：空白 → `-`）在文本侧要**等价还原**才能匹配：
 *   · 词表 'e2e-guard2' 在文本里写作 `e2e guard2` 或 `e2e/guard2` 都要命中；
 *   · 词表 'guard2' 在文本里是 `guard2-回滚测试` 也要命中（后缀边界 `-` 不算粘连）。
 * 所以匹配时把归一化文本里的分隔符（空格/\u0001//,`-_`）也**额外**当作 `-` 试一次。
 * @param {string|string[]} text
 * @param {Set<string>|Map<string,number>} vocab 归一化词表
 * @returns {Map<string, number>} 实体 → 命中次数
 */
export function extractEntities(text, vocab) {
  const has = (k) => vocab.has(k);
  const raw = normalizeText(Array.isArray(text) ? text.join(' \u0001 ') : text);
  if (!raw) return new Map();
  // 文本侧变体：把分隔符统一成 '-'（与词表 normalizeKey 同口径）
  const dashed = raw.replace(/[\u0001/_.,、。:：;；()（）\[\]【】]/g, '-').replace(/-{2,}/g, '-');
  const counts = new Map();
  for (const key of vocab.keys()) {
    const len = key.length;
    if (len < MIN_ENTITY_LEN) continue;
    // 锚点预筛：前 2 字符都不出现 → 整词不可能命中（词表上千条时的关键优化）
    const anchor = key.slice(0, 2);
    if (!raw.includes(anchor) && !dashed.includes(anchor)) continue;
    let first = -1;
    // 两个变体可能在同一位置同时命中（raw 与 dashed 在非分隔符处一致）→ 取最早位置，天然去重
    for (const hay of [raw, dashed]) {
      const i = hay.indexOf(key);
      if (i >= 0 && (first < 0 || i < first)) first = i;
    }
    if (first >= 0) counts.set(key, first);
  }
  return counts;
}

/** 提取（数组文本版本，供载体使用）：去重后返回实体集合。 */
export function entitiesOf(text, vocab) {
  return new Set(extractEntities(text, vocab).keys());
}

// ---------------------------------------------------------------- 载体收集（六路源）

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * _archive 目录名清洗：剥离时间戳 / 纯 hash / 纯日期段，只留语义名。
 * `guard-rollback-restore-20260907-094021` → `guard-rollback-restore`
 * `taskboard-line-20260910` → `taskboard-line`
 * `_tmp-archive-20260908` → `_tmp-archive`
 */
export function cleanArchiveName(name) {
  let s = String(name ?? '').trim();
  if (!s) return '';
  s = s.replace(/^_+/, '');
  // 反复剥离尾巴上的时间戳 / 日期 / hash / 版本段（ISO 正则必须在短日期之前，否则 T10 残留）
  for (let round = 0; round < 6; round++) {
    const before = s;
    s = s.replace(/[-_.]\d{4}-\d{2}-\d{2}[tT]\d{2}-\d{2}-\d{2}$/g, '');
    s = s.replace(/[-_.]?\d{8}[-_.]?\d{4,6}?$/g, '');
    s = s.replace(/[-_.]?\d{4}-\d{2}-\d{2}([-_.]?\d{4,6})?$/g, '');
    s = s.replace(/[-_.]?\d{8}$/g, '');
    s = s.replace(/[-_.]?\d{6}$/g, '');
    s = s.replace(/[-_.]?\d{4}$/g, '');
    s = s.replace(/[-_.]?v?\d+(\.\d+)+$/g, '');
    s = s.replace(/[-_.]?[0-9a-f]{7,}$/g, '');
    s = s.replace(/[-_.]+$/g, '');
    if (s === before) break;
  }
  return s.replace(/[-_.]+$/, '');
}

/** 载体对象的统一构造。 */
function carrier(kind, id, title, extra = {}) {
  return { kind, id, title: String(title ?? '').trim(), text: String(extra.text ?? title ?? ''), ...extra, hash: '' };
}

/**
 * 六路源采集（只读；任何一路失败降级为空，不抛）。
 * @param {{home?:string, dshRoot?:string, board?:object[], now?:number, includeArchive?:boolean}} opts
 * @returns {{carriers:object[], errors:object[]}}
 */
export function collectCarriers(opts = {}) {
  const home = opts.home ?? dshHome();
  const root = opts.dshRoot ?? dshRoot();
  const now = opts.now ?? Date.now();
  const errors = [];
  const out = [];

  const safe = (kind, fn) => {
    try { fn(); } catch (e) { errors.push({ kind, error: String(e?.message ?? e) }); }
  };

  // ① monitor-registry 的 CI 名
  safe('monitor', () => {
    const f = resolveStatePath('butler-monitor-registry.json', { home }).path;
    const j = opts.monitor ?? readJsonSafe(f, null);
    const items = Array.isArray(j?.items) ? j.items : Array.isArray(j?.cis) ? j.cis : Array.isArray(j) ? j : [];
    for (const it of items) {
      const name = it?.name ?? it?.id ?? it?.ci ?? null;
      if (name) out.push(carrier('monitor', `monitor:${name}`, name, { text: `${name} ${it?.note ?? ''}`, path: f }));
    }
  });

  // ② 方案各 P 标题（方案文档的 `### Pn · 会X（…）` 节标题）
  safe('plan', () => {
    const files = (opts.planFiles) ?? listPlans(root);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^#{2,4}\s*(?:\*\*)?\s*(P\d+(?:\.\d+)?)\s*[·:：\-—]\s*(.+?)(?:\*\*)?\s*$/.exec(lines[i]);
        if (!m) continue;
        const head = `${m[1]} ${m[2]}`.replace(/[*`]/g, '').trim();
        out.push(carrier('plan', `plan:${path.basename(file)}#${m[1]}`, head, { text: head, path: file, line: i + 1 }));
      }
    }
  });

  // ③ 看板卡标题（含描述：卡描述里常写入口文档/关联卡）
  safe('board', () => {
    let tasks = opts.board ?? null;
    if (!tasks) {
      const j = readJsonSafe(path.join(home, 'task-board', 'ledger-v2.json'), null);
      tasks = Array.isArray(j?.tasks) ? j.tasks : [];
    }
    for (const t of tasks) {
      if (!t?.title) continue;
      const id = `board:${t.id ?? sha1(t.title)}`;
      out.push(carrier('board', id, t.title, {
        text: [t.title, t.description ?? ''].join(' \u0001 '),
        status: t.status ?? null,
        archived: Boolean(t.archivedAt),
        updatedAt: Number(t.updatedAt ?? 0) || null,
        path: path.join(home, 'task-board', 'ledger-v2.json'),
      }));
    }
  });

  // ④ docs\*.md 文件名（标题=文件名语义名；正文=文件一级标题，供标题/正文分层统计）
  safe('docs', () => {
    const dir = path.join(root, 'docs');
    const names = (opts.docs ?? null) ?? (() => {
      try { return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')); } catch { return []; }
    })();
    for (const n of names) {
      const stem = cleanArchiveName(String(n).replace(/\.md$/i, ''));
      const full = path.join(dir, n);
      let head = '';
      if (opts.docs === undefined) {
        try { head = fs.readFileSync(full, 'utf8').slice(0, 4000).split(/\r?\n/).filter((l) => l.startsWith('#')).join(' '); } catch { /* 读失败只用文件名 */ }
      }
      out.push(carrier('docs', `docs:${n}`, stem, { text: head, path: full }));
    }
  });

  // ⑤ _archive 顶层目录名（剥离时间戳/hash/日期）
  if (opts.includeArchive !== false) {
    safe('archive', () => {
      const dir = path.join(root, '_archive');
      const names = opts.archive ?? (() => {
        try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
      })();
      for (const name of names) {
        const clean = cleanArchiveName(String(name));
        if (!clean || isNoiseToken(canonKey(normalizeKey(clean)))) continue;
        out.push(carrier('archive', `archive:${name}`, clean, { text: clean, path: path.join(dir, name) }));
      }
    });
  }

  // ⑥ 记忆库标题（memory.db 第一行；只读打开，失败降级）
  safe('memory', () => {
    const mem = opts.memories ?? readMemoryTitles(home);
    for (const m of mem) {
      out.push(carrier('memory', `memory:${m.id}`, m.title, { text: m.title, path: path.join(home, 'memory', 'memory.db') }));
    }
  });

  for (const c of out) c.hash = sha1(`${c.kind}|${c.title}|${c.text}`.slice(0, 4000));
  return { carriers: out, errors, collectedAt: now };
}

/** 方案文档清单（主方案 + 大管家系列设计文档）。 */
export function listPlans(root = dshRoot()) {
  const dir = path.join(root, 'docs');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^大管家.*\.md$/.test(n) || /^P\d.*会.*\.md$/.test(n))
    .map((n) => path.join(dir, n));
}

/** 记忆标题长度上限（与 tools\memory-db-tools\list-memory-summary.mjs 同为 80 字）。 */
export const MEMORY_TITLE_MAX = 80;

/**
 * 标题截断的「安全边界」：比 `CJK_DELIM_RE` 多认中文引号「」『』 ——
 * 只用于**截断器**（不参与分词），让标题不会停成 `…主线「` 这种半截引号。
 */
const TITLE_BOUNDARY_RE = /[\s\u3000,，、。;；:：!！?？()（）\[\]【】{}<>《》"'`|/\\·—–\-_+*#~^%=&@$①②③④⑤⑥⑦⑧⑨⑩「」『』]+/;

/**
 * 按「词边界」截断 —— R-035 修「硬切造半词残片」。
 *
 * 为什么不能硬 `slice(0,80)`：记忆标题是索引的**词表来源**，切在词中间会直接造出假实体键。实测：
 * `…入口收尾用 process.exitCode` → `pro`、`…/session.list` → `ses`、`<root>\tools` → `too`；
 * 这些 3 字键再靠子串匹配放大，成了最脏的高频键（`ses`/`too` 曾占 highFreq 两席）。
 *
 * 判据：切点落在词中间（前后都非分隔符、且同为 CJK 或同为非 CJK）就向左回退到最近的边界 ——
 * 分隔符 / 中英交界。回退超过 maxRetreat（默认 20）说明整段是连写长词（罕见），放弃回退、保持原上限：
 * 宁可留一条超长标题，也不把标题削得过短导致该载体匹配不到任何实体。
 */
export function truncateAtWordBoundary(s, max = MEMORY_TITLE_MAX, maxRetreat = 8) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  const isSep = (ch) => ch === undefined || TITLE_BOUNDARY_RE.test(ch);
  const floor = Math.max(1, max - maxRetreat);
  let cut = max;
  while (cut > floor) {
    const prev = str[cut - 1];
    const next = str[cut];
    if (isSep(prev) || isSep(next) || isCJK(prev) !== isCJK(next)) break;
    cut -= 1;
  }
  if (cut <= floor) cut = max;
  // 尾巴上不留「孤立开引号 / 开括号」：`…主线「` 这类键没有指向性，剥掉再返回
  return str.slice(0, cut).replace(/[「『（《【\[(]+$/, '').replace(/\s+$/, '');
}

/** 读记忆库标题（第一行、按词边界收敛到 MEMORY_TITLE_MAX 字）。 */
export function readMemoryTitles(home = dshHome()) {
  const dbFile = path.join(home, 'memory', 'memory.db');
  if (!fs.existsSync(dbFile)) return [];
  const out = [];
  try {
    // 动态 import：node:sqlite 在旧版 node 不存在时降级（不炸整个对账）
    const { DatabaseSync } = require_sqlite();
    if (!DatabaseSync) return [];
    const db = new DatabaseSync(dbFile.replaceAll('\\', '/'), { readOnly: true });
    const rows = db.prepare('SELECT id, text FROM memories ORDER BY id').all();
    for (const r of rows) {
      const first = truncateAtWordBoundary(String(r.text ?? '').split('\n')[0], MEMORY_TITLE_MAX);
      if (first) out.push({ id: r.id, title: first });
    }
    db.close();
  } catch {
    return out;
  }
  return out;
}

let _sqlite;
/** node:sqlite 惰性 require（模块不存在 → null，对账器降级为「记忆源不可用」）。 */
function require_sqlite() {
  if (_sqlite === undefined) {
    try { _sqlite = createRequire(import.meta.url)('node:sqlite'); } catch { _sqlite = null; }
  }
  return _sqlite;
}

// ---------------------------------------------------------------- 索引构建

/**
 * 构建实体索引（全量重建；幂等）。
 * @param {{home?:string, dshRoot?:string, now?:number, board?:object[], memories?:object[], planFiles?:string[],
 *          includeArchive?:boolean, idfRatio?:number, bootstrapMinCarriers?:number}} [opts]
 * @returns {object} 索引对象（尚未落盘）
 */
export function buildIndex(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const idfRatio = opts.idfRatio ?? IDF_RATIO;
  const bootMin = opts.bootstrapMinCarriers ?? BOOTSTRAP_MIN_CARRIERS;
  const collected = opts._carriers ? { carriers: opts._carriers, errors: opts._errors ?? [] } : collectCarriers(opts);
  const { carriers, errors } = collected;

  // —— 词表自举：标题类载体（卡/方案/docs/归档/记忆/CI 名都算标题类；board 用标题不用描述）
  const boot = bootstrapVocabulary(carriers.map((c) => ({ title: c.title })));
  const vocab = new Map();
  for (const [w, n] of boot) if (n >= bootMin) vocab.set(w, n);

  // —— 逐载体提取实体。
  //    标题命中(title) 与 正文/描述命中(text) **分开统计**：标题是"这条载体在讲什么"，
  //    描述往往只是顺带提到 —— 只有标题命中才配当"同实体"的强证据（精度锚点）。
  const totalCarriers = carriers.length;
  const byEntity = new Map();
  const newRec = (e) => ({ key: e, total: 0, titleTotal: 0, kinds: {}, kindsTitle: {}, liveBoardTitle: 0, carriers: [] });
  for (const c of carriers) {
    const titleHits = entitiesOf(c.title, vocab);
    const textHits = entitiesOf([c.title, c.text], vocab);
    // 在途卡（未归档）：脱管任务只看"还有人管的卡"，归档卡是历史不算"在做"
    const live = c.kind === 'board' && !c.archived;
    for (const e of titleHits) {
      if (!byEntity.has(e)) byEntity.set(e, newRec(e));
      const rec = byEntity.get(e);
      rec.kindsTitle[c.kind] = (rec.kindsTitle[c.kind] ?? 0) + 1;
      if (live) rec.liveBoardTitle += 1;
    }
    for (const e of textHits) {
      if (!byEntity.has(e)) byEntity.set(e, newRec(e));
      const rec = byEntity.get(e);
      rec.total += 1;
      rec.kinds[c.kind] = (rec.kinds[c.kind] ?? 0) + 1;
      rec.carriers.push(c.id);
      if (titleHits.has(e)) rec.titleTotal += 1;
    }
  }

  // —— IDF + 高频地板 + 泛词黑名单：命中任一 → highFreq（**只索引不提示**）
  //    黑名单同样走 highFreq 通道而不是从索引里删掉：索引要留全量（--card 单卡对账 / 人工排查
  //    都要能看到"这卡提到了插件"），但提示层必须干净。
  const idfLimit = Math.max(HIGH_FREQ_MIN, Math.ceil(totalCarriers * idfRatio));
  const entities = {};
  let highFreq = 0;
  let blacklisted = 0;
  // ⚠️ **死字段（2026-10-11 实测取证 · 卡「冲刺600·I域·P7索引残片治理」）**：本计数**恒为 0**，
  //   **不可**当作"黑名单生效"的证据（面板/日报若引用它会误导）。
  //   成因：`GENERIC_WORDS` 里的词在**词表自举阶段**就被 `isNoiseToken()` 剔除
  //   （见 `segmentsOf` 末尾的 `if (!isNoiseToken(k))` 过滤）⇒ 它们**永不可能成为实体键**
  //   ⇒ 下面 `GENERIC_WORDS.has(key)` 恒 false ⇒ `blacklisted` 恒 0。
  //   证据：生产索引 blacklisted=0；隔离实测（4638 载体）下 GENERIC_WORDS 448 词命中实体键数 = 0。
  //   处置（**待主人拍板**，本卡不给选项结论）：删字段 / 改成"被黑名单拦下的候选数" / 保持原样。
  //   报告：docs\交付报告-冲刺600-P7索引残片治理-20261011.md
  const SAMPLE_PER_KIND = 20;
  const order = ['board', 'plan', 'docs', 'archive', 'memory', 'monitor'];
  for (const [key, rec] of byEntity) {
    const n = rec.carriers.length;
    const core = CORE_KINDS.reduce((acc, k) => acc + (rec.kinds[k] ?? 0), 0);
    const coreTitle = CORE_KINDS.reduce((acc, k) => acc + (rec.kindsTitle[k] ?? 0), 0);
    const black = GENERIC_WORDS.has(key);
    const high = black || n > idfLimit;
    if (black) blacklisted += 1;
    if (high) highFreq += 1;
    // sample 必须**按载体类型各留几条**：只 time 序截断前 40 会让 board/docs 被
    // 大量 memory/archive 命中挤出（实测：卡明明命中却显示"(无卡)"）→ 判据与展示都失真。
    const byKind = { board: [], plan: [], docs: [], archive: [], memory: [], monitor: [] };
    const cmapKind = new Map(carriers.map((c) => [c.id, c.kind]));
    for (const id of rec.carriers) {
      const k = cmapKind.get(id);
      if (k && byKind[k].length < SAMPLE_PER_KIND) byKind[k].push(id);
    }
    const sample = order.flatMap((k) => byKind[k]);
    entities[key] = {
      key,
      display: displayOf(key),
      carriers: n,
      total: rec.total,
      /** 标题命中数（本载体"在讲这个"的强证据） */
      titleTotal: rec.titleTotal,
      /** 核心载体数（卡 / 方案节 / 文档）——耦合提示的门槛看这个，不看 archive/memory 数量 */
      core,
      /** 核心载体里"标题命中"的数 —— 精度锚点，抗泛词撞车 */
      coreTitle,
      /** 在途卡（未归档）里"标题命中"的数 —— 脱管任务的门槛看这个 */
      liveBoardTitle: rec.liveBoardTitle,
      kinds: rec.kinds,
      kindsTitle: rec.kindsTitle,
      highFreq: high,
      blacklisted: black,
      sample,
    };
  }

  const corpusHash = sha1(carriers.map((c) => `${c.id}:${c.hash}`).sort().join('\n'));
  return {
    schemaVersion: ENTITIES_SCHEMA,
    indexRev: ENTITIES_INDEX_REV,
    builtAt: now,
    corpusHash,
    counts: {
      carriers: totalCarriers,
      byKind: SOURCE_KINDS.reduce((acc, k) => { acc[k] = carriers.filter((c) => c.kind === k).length; return acc; }, {}),
      entities: Object.keys(entities).length,
      highFreq,
      blacklisted,
      vocab: vocab.size,
    },
    params: { idfRatio, idfLimit, bootstrapMinCarriers: bootMin },
    errors,
    entities,
    /** 载体明细（**不落盘**：ensureIndex 写盘前剔除；仅供本轮对账 / spike 复用）。 */
    _carriers: carriers,
  };
}

/** 实体的展示名：优先保留语料里的常见写法（英文保持原样，中文原样）。 */
function displayOf(key) {
  return key;
}

/**
 * 读取索引（不重建）。schemaVersion 不符 → 抛 SchemaMismatchError（调用方跳过 + 告警）。
 */
export function readIndex(opts = {}) {
  const home = opts.home ?? dshHome();
  return readJson(entitiesPath(home), { schemaVersion: ENTITIES_SCHEMA, defaultValue: null, home });
}

/**
 * 增量校验：语料指纹变化则重建并落盘；否则复用。
 * 指纹 = 载体 id+内容 hash 的聚合 sha1（不读全文即可判断，成本 ≈ 采集本身）。
 * @returns {{index:object, rebuilt:boolean, changed?:boolean, prevHash?:string, errors:object[]}}
 */
export function ensureIndex(opts = {}) {
  const home = opts.home ?? dshHome();
  const now = opts.now ?? Date.now();
  const prev = (() => { try { return readIndex({ home }); } catch { return null; } })();
  const { carriers, errors } = collectCarriers(opts);
  const corpusHash = sha1(carriers.map((c) => `${c.id}:${c.hash}`).sort().join('\n'));
  const withCarriers = (idx) => (idx ? { ...idx, _carriers: carriers, errors: idx.errors ?? errors } : idx);
  if (prev && prev.corpusHash === corpusHash && Number(prev.indexRev ?? 0) === ENTITIES_INDEX_REV && !opts.force) {
    return { index: withCarriers(prev), rebuilt: false, changed: false, prevHash: corpusHash, errors };
  }
  const index = buildIndex({ ...opts, home, now, _carriers: carriers, _errors: errors });
  if (opts.dryRun !== true) {
    const { _carriers, ...persisted } = index;
    const dw = writeStateText('butler-entities.json', JSON.stringify(persisted, null, 2) + '\n', {
      home, write: (p, t) => writeTextAtomic(p, t),
    });
    if (!dw.ok) throw new Error('双写失败（' + (dw.kind ?? 'unknown') + '）：' + (dw.failures?.[0]?.error ?? 'unknown'));
  }
  return { index, rebuilt: true, changed: Boolean(prev), prevHash: corpusHash, errors };
}

/** tick 入口：用 tick 互斥锁包住重建（并发触发只跑一个）。 */
export function rebuildIndexWithLock(opts = {}) {
  // 延迟 import，避免与 store 的循环依赖疑虑
  // eslint-disable-next-line
  return import('../../src/dsh-butler/lib/store.mjs').then(({ acquireTickLock }) => {
    const home = opts.home ?? dshHome();
    const lock = acquireTickLock('butler-reconcile-index', { ttlMs: 300_000, home });
    if (!lock.ok) return { ok: false, reason: lock.reason, skipped: true };
    try {
      const r = ensureIndex(opts);
      return { ok: true, ...r };
    } finally {
      lock.release();
    }
  });
}

/** 索引摘要（CLI --status / 日报用）。 */
export function summarizeIndex(index) {
  if (!index) return { ok: false, reason: '索引不存在（跑 butler-reconcile.mjs --rebuild）' };
  return {
    ok: true,
    builtAt: index.builtAt ?? null,
    builtAtLabel: index.builtAt ? new Date(index.builtAt).toLocaleString('zh-CN') : '—',
    counts: index.counts ?? {},
    params: index.params ?? {},
    errors: index.errors ?? [],
  };
}

export { ALIASES, STOP_TOKENS };
