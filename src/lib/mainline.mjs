// tools/lib/mainline.mjs —— 主线名归一化（**唯一处**）
//
// 口径真源：`docs/`
//   §4.2 L225「`mainline` 比较口径（K-5 收口 —— 不许留给实现期）」· §5.1「函数（v11 新增）」· §10 D12。
//
// 为什么必须有它（缺了会静默失效，且是**两个闸门同时**失效）：
//   闸门 2（同主线两次接力间隔 ≥ 20 分钟）与闸门 3（同主线连续失败 ≥2 次 ⇒ 停招 + 🔴 报警）
//   **都按主线名的字符串比**；而主线名是 agent 手写的自由文本 ⇒ 一个尾随空格、一个全角冒号
//   就足以让它变成"另一条主线"。**闸门 3 是唯一的"失败即停 + 🔴"拦截**，它静默失效 = 接力会
//   在一条反复失败的主线上无限重试，而没人被叫醒。
//
// 口径（写死，实现只按这一条，不留选择）：
//   ① 去首尾空白（**并去掉首尾冒号** —— 口径推论见 `normalizeMainline()` 内注释）
//   ② 全角冒号 `：` → 半角 `:`（含内部冒号）
//   ③ 连续空白折叠为**单空格**（`/\s+/` 含全角空格 U+3000、换行、制表）
//   ④ **大小写敏感**（**不做**大小写折叠 —— 避免把两条真不同的主线合并）
//   ⑤ 长度上限 **60 字符**（超限 ⇒ 交接档校验判**不合格**、不开新会话、退出码 **5**）
//
// 落点理由（方案**未写死** ⇒ 本卡自决，交付报告登记「选择理由 + 将来接线点」）：
//   · 放 `tools\lib\` 而非 `tools\dsh-butler\lib\`：用它的 `tools\session-relay.mjs`（阶段 1 主卡）
//     在 `tools\` 根，与 `tools\lib\` **同侧**（import 路径最短、无跨线依赖）；
//     `tools\dsh-butler\lib\` 是 butler 线内部 lib，而 session-relay **不是 butler 件**
//     （方案 §5.1 把它登记为 `tools/session-relay.mjs`）。
//   · `tools\lib\` 已是既有跨线共享件落点（host-adapter.mjs / closure-links.mjs /
//     repo-superset.mjs / imagegen-backup-root.mjs / rollback-points-root.mjs 等）。
//   · **将来接线点**（阶段 1 主卡）：`tools\session-relay.mjs` 的**闸门 2 / 闸门 3 判定与统计口径**
//     一律 import 本模块的 `normalizeMainline()` —— 方案 §4.2 ③ 要求"只走它一处"。
//   · 本卡只交付函数与单测；**闸门接线在阶段 1**（交接档校验的超限分支 = 那里的 `exit 5`）。
//
// 零依赖、纯函数（可被单测直接 import；不读写任何文件）。

/** 主线名长度上限（**字符** = Unicode 码点；超限 ⇒ 交接档校验判不合格、退出码 5）。 */
export const MAINLINE_MAX_CHARS = 60;

/**
 * 主线名归一化（**闸门 2 / 3 与统计口径只走这一处**）。
 *
 * 幂等：`normalizeMainline(normalizeMainline(x)) === normalizeMainline(x)`。
 * 非字符串入参：`null` / `undefined` ⇒ `''`；其余走 `String()`（数字/对象不抛错，但不保证有意义）。
 *
 * @param {unknown} s
 * @returns {string} 归一化后的主线名（可能为空串 —— 空串表示"取不到主线名"，由调用方 fail-closed 处置）
 */
export function normalizeMainline(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/：/g, ':')     // ② 全角冒号 → 半角（唯一允许的字符级归一）
    .replace(/\s+/g, ' ')    // ③ 连续空白 → 单空格（含 U+3000 / \n / \t）
    // ① 去首尾空白，**并去掉首尾冒号** ——
    //   口径来源与推论（⚠️ 如实登记，见交付报告「待复核」一节）：方案 §4.2 L225 只写了两条
    //   （trim 空白 + `：`→`:`），照字面实现则 `'A：'` → `'A:'` ≠ `'A'`，**无法满足**方案 §12 回归项表
    //   「主线名归一（K-5）」那条的逐字断言 —— `A` / `A `（尾随空格）/ `A：`（全角冒号）
    //   ⇒ **同一主线、被同一闸门计数**。⇒ 本实现在"去首尾空白"这一步**把首尾冒号一并去掉**，
    //   以满足该回归项（两条口径的唯一可同时成立解）。
    //   代价如实：若真有两条主线分别叫 `A` 与 `A:`，会被合并成同一条（判据只会更保守/更早停招）；
    //   内部冒号一律保留（`A: B` 与 `A:B` 仍是两条，只有**首尾**冒号被去掉）。
    .replace(/^[\s:]+|[\s:]+$/g, '');
}

/**
 * 主线名是否在长度上限内（按**归一化后**的值计）。
 * @param {unknown} s
 */
export function isMainlineWithinLimit(s) {
  return [...normalizeMainline(s)].length <= MAINLINE_MAX_CHARS;
}

/**
 * 交接档校验用的主线名判定（结构契约的一部分 · §4.2）。
 *
 * `exitCode` 口径：方案 §4.2 写「超限 ⇒ 交接档校验判**不合格**、不开新会话，**退出码 5**」
 * （§9 退出码表：5 = 需人工）。本函数只**给出**该码，**不自己退出**（不替调用方做 I/O 决策）。
 *
 * @param {unknown} s
 * @returns {{ok:boolean, reason:'ok'|'empty'|'too-long', normalized:string, chars:number, exitCode:number}}
 */
export function checkMainline(s) {
  const normalized = normalizeMainline(s);
  const chars = [...normalized].length;
  if (chars === 0) return { ok: false, reason: 'empty', normalized, chars, exitCode: 5 };
  if (chars > MAINLINE_MAX_CHARS) return { ok: false, reason: 'too-long', normalized, chars, exitCode: 5 };
  return { ok: true, reason: 'ok', normalized, chars, exitCode: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// 族键（family key） —— 闸门 2「速率闸」专用，2026-09-29 新增（改动 2）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么需要它（实测取证 · 卡「改动 2+3+4」）：
//   闸门键原本 = `normalizeMainline()` 后的**整串主线名**。生产审计台账 `2026-09.jsonl`
//   实测：`session-relay` 事件 119 行 / **78 个唯一主线键**，其中
//     · 「整夜推进-第2棒」…「整夜推进-第26棒」 = **一条主线占 25 个键**
//     · 「文档纪律与看板瘦身-第11棒」…「-第14棒」/「管家站1执行与拍板移交-20260929-第16棒」…
//   而这几棒的**实际间隔**是 6~8 分钟（例：09-27 16:05:43 第9棒 → 16:12:23 第10棒 = 6m40s）——
//   **远小于当时的 20 分钟闸门**。⇒ 结论：**改个棒号就换了一个闸门键，速率闸形同不存在**
//   （历史 52/99 跳就是这么绕过去的；G7）。15 分钟若不修这一条，**永远不会生效**。
//
// 口径（只做一件事：**从尾部剥掉「棒号 / 日期」后缀**）：
//   · 剥的是**尾部**连续形态，可**反复剥**（`…-20260929-第16棒` ⇒ 先剥「第16棒」再剥「-20260929」）；
//   · **内部**出现的「棒」/数字一律不动（`adapter档B切换-接手验收` 不受影响）；
//   · 剥到**空串** ⇒ **回落原值**（防某条主线真就叫 `-2` 时把自己剥没 ⇒ fail-safe）；
//   · 幂等：`mainlineFamily(mainlineFamily(x)) === mainlineFamily(x)`；
//   · **不改 `normalizeMainline()` 的口径**（那是闸门 3 / 统计口径的唯一源，本层只在它上面加一层）。
//
// ⚠️ 已知代价（卡面已登记，可选键 `sessionRelay.rateGateKey='exact'` 一键切回整串比对）：
//   两条**真不同**的主线若只差一个尾部数字/日期，会被并成同一族 ⇒ 判据**更保守**
//   （更早被速率闸挡住，不会漏放）。
const SEP = '[\\s\\-—–_·.．]';

/** 族键剥离规则（**按数组顺序反复应用直到不再变化**；只锚定行尾）。 */
export const MAINLINE_FAMILY_RULES = Object.freeze([
  // ① 「第N棒」（可带分隔符 / 括号 / 空白）：`整夜推进-第2棒` ⇒ `整夜推进`
  { id: 'round-cn', re: new RegExp(`^(.*?)${SEP}*[(（]?\\s*第\\s*\\d{1,4}\\s*棒\\s*[)）]?\\s*$`) },
  // ② 「棒N」/「第N」(无「棒」字)：`X-棒3`、`X-第3` ⇒ `X`
  { id: 'round-cn2', re: new RegExp(`^(.*?)${SEP}*[(（]?\\s*(?:棒|第)\\s*\\d{1,4}\\s*[)）]?\\s*$`) },
  // ③ 「RoundN」/「R#N」/「r N」：`X-R3`、`X-round4` ⇒ `X`
  { id: 'round-en', re: new RegExp(`^(.*?)${SEP}*[(（]?\\s*(?:round|Round|ROUND|R|r)\\s*#?\\s*\\d{1,4}\\s*[)）]?\\s*$`) },
  // ④ 括号里的纯数字：`X(2)`、`X（3）` ⇒ `X`
  { id: 'round-paren', re: new RegExp(`^(.*?)${SEP}*[(（]\\s*\\d{1,3}\\s*[)）]\\s*$`) },
  // ⑤ 尾部纯数字（**1~3 位**；4 位留给日期/时间戳，避免吃掉 `-1540`）：`X-2`、`X_3` ⇒ `X`
  //    ⚠️ `guard`：剥掉的头**不能以数字结尾** —— 否则版本号会被逐段吃掉
  //    （实测踩到：`受控升级主包0.1.5-20260922-1650` ⇒ 剥日期后 `受控升级主包0.1.5`，
  //      若再被 ⑤ 吃一次会变 `受控升级主包0.1` ⇒ `受控升级主包0`，**把版本号当成棒号**）。
  { id: 'round-num', re: new RegExp(`^(.*?)${SEP}+\\d{1,3}$`), guard: (head) => !/\d$/.test(head) },
  // ⑥ 尾部日期（YYYYMMDD，可再带 `-HHMM`/`-N` 时间戳）：`X-20260928`、`X-20260922-1540` ⇒ `X`
  { id: 'date', re: new RegExp(`^(.*?)${SEP}+(?:19|20)\\d{6}(?:${SEP}+\\d{1,4})?$`) },
]);

/** 反复剥离的轮数上限（防规则互咬成死循环；实测最长形态只需 2 轮）。 */
export const MAINLINE_FAMILY_MAX_ROUNDS = 8;

/**
 * 族键剥离明细（可观测 · 供单测/报告取证）。
 * @param {unknown} s
 * @returns {{family:string, stripped:string[], rounds:number, fellBack:boolean, normalized:string}}
 */
export function mainlineFamilyDetail(s) {
  const normalized = normalizeMainline(s);
  let cur = normalized;
  const stripped = [];
  let rounds = 0;
  for (; rounds < MAINLINE_FAMILY_MAX_ROUNDS; rounds++) {
    let hit = null;
    for (const rule of MAINLINE_FAMILY_RULES) {
      const m = rule.re.exec(cur);
      if (!m) continue;
      const head = String(m[1] ?? '').trim();
      if (!head) continue;              // 剥到空 ⇒ 本规则不采用（换下一条规则试）
      if (rule.guard && !rule.guard(head)) continue;  // 规则自带护栏（见 ⑤ 的版本号护栏）
      hit = { rule: rule.id, head };
      break;
    }
    if (!hit) break;
    stripped.push(`${hit.rule}:${cur.slice(hit.head.length)}`);
    cur = hit.head;
  }
  const fellBack = cur.length === 0;
  return {
    normalized,
    family: fellBack ? normalized : normalizeMainline(cur),
    stripped,
    rounds,
    fellBack,
  };
}

/**
 * 闸门 2 用的**族键**（剥掉尾部棒号/日期后缀）。非字符串/空 ⇒ `''`（与 `normalizeMainline` 一致）。
 * @param {unknown} s
 * @returns {string}
 */
export function mainlineFamily(s) {
  return mainlineFamilyDetail(s).family;
}

/**
 * 闸门键计算（**闸门 2 的唯一入口** · 改动 2 引入）。
 * @param {unknown} s
 * @param {'family'|'exact'} [keyMode] `family`（缺省，剥棒号）| `exact`（整串比对 = 改动前行为）
 * @returns {string}
 */
export function mainlineGateKey(s, keyMode = 'family') {
  if (String(keyMode) === 'exact') return normalizeMainline(s);
  return mainlineFamily(s);
}
