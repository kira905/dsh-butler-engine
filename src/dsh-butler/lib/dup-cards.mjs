// dsh-butler / lib/dup-cards.mjs —— P3 L1 自动动作①：重复卡检测 + 合并（可逆）
//
// 方案：docs/ §4 P3「L1 首个自动动作：重复卡检测 + 合并」
//   - 检测：按「规范化标题」分组——规范 = trim + 全角/半角统一（保守：不做语义模糊、不删括号差异）
//   - 分级：同标题 **且** 同 description（sha256 相等）→ 确定重复（L1 直接合并）
//           同标题但 desc 不同 → 🟡 疑似重复（只通知不自动，必须人判）
//   - 合并动作（可逆）：保留**先建**卡（createdAt 更早；相等时取 id 字典序小者，保证确定性）
//     对后建卡：description 前插「⚠️ 与 <先建 id> 重复，管家已合并（<日期>），勿单独执行」
//     + 若带 schedule：**先把原值写进备注与审计行、再禁用（`set-schedule{enabled:false}`）**
//     → **不删卡**（删 = L3）
//
// ❗ 2026-09-13（P3 写路径改造 · 卡 S5·[6a-实施]）：**写意图一律表达为 Host 动作序列**
//   依据 docs/ §3/§5。写不再碰账本文件（Host 是权威：内存 document
//   末尾整份 commit，直写会被静默覆盖）：
//     W1 挂备注   → `{kind:'update', taskId, patch:{description}}`
//     W2 清定时   → `{kind:'set-schedule', taskId, patch:{enabled:false, cron}}`（Host 无「删除 schedule」
//                   语义，只能禁用；禁用后 cron 不再触发，且回滚只需 re-enable——比删除更优）
//     W3 回滚     → `update{description:原值}` + `set-schedule{enabled:true, cron:原cron}`（组合）
//   ⚠️ 2026-09-17（卡「P3 重复卡合并受控验收」· 定口径）：**`kind:'interactive'` 卡一律跳过合并**。
//     依据：interactive 卡禁 `set-schedule`（Host 报 `interactive task cannot be scheduled`），
//     「挂备注 + 清定时」这套合并语义对它天然不成立；在板活样本 `c569e476`（P9 H5）即此类。
//     落地位置 = `detectDuplicates()` 的 0b（desc 分桶前排除）+ ①c（进 `skipped` 留痕）——
//     排除后它既不进「确定重复」也不进「疑似重复」（不是待处理对象，不该刷通知）。
//     新增计数 `stats.interactiveSkipped`；单测 = `_test/test-auto.mjs` ③ 段 interactive 用例。
//   三个由此产生的形状/计数差异（如实登记，见 §3.1）：① schedule 对象保留（`enabled:false`）而非删除；
//   ② 改 N 张卡由「revision+1」变「revision+N」（一卡两个 action）；③ requestId 幂等只缓存成功 action
//   → 失败重试换新 requestId + 读回 state 判定（实现见 lib/ledger-api.mjs）。
//
// 本模块**纯函数 + dry-run**：
//   planDuplicateMerge()  只算不动（返回将执行的动作序列，供 dry-run 输出/面板/测试）
//   applyDuplicateMerge() 真写（必须显式传 apply 执行器；不传 → kind:'dry-run' 拒绝写）
// 任何调用方都不得绕过 butler-auto-actions.runAction 的闸门直接调 apply（本模块不自带闸门，
// 闸门在 lib/autonomy-actions.mjs —— 单一闸门入口，便于"四把开关全关"的整体审计）。
import crypto from 'node:crypto';

export const DUP_CARDS_VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// I14 · `maxAffected`（单批影响上限）—— 2026-09-19（卡：P3 重复卡合并补 I14 maxAffected 护栏）
//   依据：`docs/` §10 ② —— 该动作 2026-09-17 15:34 常开观察，
//   但「单次计划最多影响几张卡」当时**没有**语义护栏（每 tick 最多 4 个动作只是**调度节流**，
//   挡不住"一组里塞了 N 张卡"的爆炸半径）。主人拍板「②-2 先放行 + 另开卡补护栏」⇒ 本卡补。
//   与既有护栏的关系（全部保留，互不替代）：
//     · 动作前快照（失败即拒写）· 24h 同 `sigKey` 去重 · 单日上限 · 每 tick 动作数上限（调度节流）
//     · **maxAffected = 本动作自己的爆炸半径上限（被改动的卡数）** ← 本次新增
//   截断位置刻意选在「计划 → 执行」之间（`planDuplicateMerge` 产出即已截断；`applyDuplicateMerge`
//   再在**执行前**兜一刀）：执行中途绝不截 —— 保证不产生"某张卡只做了一半动作序列"的半成品。
// ---------------------------------------------------------------------------

/**
 * 单批影响上限（**被改动的卡数**，不是组数）。取值 4 的来源（2026-09-19 主人口径）：
 *   ① 与现行 `~/.dsh/butler-autonomy-limits.json` 的 `maxActionsPerTick`（现值 4）一致
 *      ⇒ tick 层已有的同值截断意味着落地当刻**不改变已放行行为**；
 *   ② 登记表 `lib\autonomy-actions.mjs` 的 `guard.maxAffected` 声明**已于 2026-09-27 对齐到 4**
 *      （主人拍板第 6 条①；依据 = `docs/` §315/§325：
 *      观察期零撞限 ⇒ 4 够用，**不放宽**到 10）—— 原声明 10（v2 方案 §3.6.5「合并卡 ≤10」）是**设计上限**，
 *      本常量取更保守的实现值；两侧**已不是"待对齐"状态**。
 *      防再漂（2026-09-27 新增）：`registry-audit` 的 A8 仍只验**声明齐备**（**不验数值**），
 *      另由 **A9「声明值 == 运行时常量」**机械比对（登记表 `lib\registry-audit.mjs` 的
 *      `RUNTIME_MAX_AFFECTED` 直接引用本常量）—— **任一改单边即判红**，改这里时别忘同步声明表。
 * 可调点 = 本常量 + 调用方 `opts.maxAffected` 覆盖（**不改限额文件、不改任何闸门开关**）。
 */
export const DUP_MAX_AFFECTED_DEFAULT = 4;

/** 解析 `maxAffected`（非负整数；非法/缺失 → 默认值）。fail-safe 方向 = 取默认值，**不是**"无上限"。 */
export function resolveMaxAffected(value) {
  if (value === undefined || value === null) return DUP_MAX_AFFECTED_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return DUP_MAX_AFFECTED_DEFAULT;
  return Math.max(0, Math.floor(n));
}

/**
 * 超上限被扣下时的统一措辞（**唯一来源**：计划层与执行层共用，避免两处文案漂移）。
 * 风格照抄既有 tick 层 defer：`超出单 tick 动作数上限（下一 tick 继续）`。
 * @param {number} maxAffected
 * @param {string} [note] 该组特有的补充说明（整组留批 / 单组超上限）
 */
export function deferReasonOverMaxAffected(maxAffected, note = '') {
  const base = `超出单批影响上限（maxAffected=${maxAffected}，下一批继续）`;
  return note ? `${base}·${note}` : base;
}

/**
 * I14 截断（**纯函数，计划层与执行层共用的唯一逻辑源**）。
 *
 * 口径 = **只按整组切，绝不把一组拆开**（组 = 同一 `keeper` 的合并批次）：
 *   · 能整组装下 → 处理；
 *   · 装不下（含"该组自身就 > 上限"）→ **整组**留到下一批 —— 该组**不消耗** 24h `sigKey` 去重键
 *     （去重只在真执行时记账）⇒ 下一个 tick 就能继续处理它。
 * 为什么**不做**"组内部分处理"（曾被实现，2026-09-19 实测后撤回）：
 *   `detectDuplicates` 的「已合并对」识别会把同组已挂备注的卡**连同 keeper 一起**排除（`liveMembers`）；
 *   于是"组内只剩 1 张未合并卡"时它落单 ⇒ 既不算确定重复、也无法再被处理 ⇒ **永久孤儿卡**（静默、最坏形态）。
 *   整组切 + 整组留批不会产生孤儿；代价是"单组卡数 > 上限"的组本批不动（会**每轮都被检出并 deferred**，
 *   在审计行里可见 —— 需提高上限或人工处理，见报告 §待拍板）。
 * 任何情形都**不突破上限**、也不切单卡的动作序列（不产生半成品）。
 *
 * @param {Array<{patches:object[], keeperId?:string, titleNorm?:string, descHash?:string}>} items 按处理顺序排列的组
 * @param {number} maxAffected
 * @returns {{cap:number, affected:number, selected:Array<{item:object, patches:object[]}>, deferred:object[]}}
 */
export function limitByMaxAffected(items, maxAffected) {
  const cap = resolveMaxAffected(maxAffected);
  const selected = [];
  const deferred = [];
  let affected = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const patches = Array.isArray(it?.patches) ? it.patches : [];
    const n = patches.length;
    if (!n) continue;
    const meta = { keeperId: it.keeperId ?? null, titleNorm: it.titleNorm ?? null, descHash: it.descHash ?? null };
    const ids = patches.map((p) => p.id);
    const room = cap - affected;
    if (n <= room) {
      selected.push({ item: it, patches });
      affected += n;
      continue;
    }
    const note = cap === 0
      ? '' // 上限=0 = 本批本就不动（不是"组太大"，不必解释拆分）
      : (n > cap
        ? `本组 ${n} 张 > 上限，不可拆分（拆分会让同组剩余卡永久无法再被检出）→ 需提高 maxAffected 或人工处理`
        : `本组 ${n} 张 > 本批剩余额度 ${room}，整组留到下一批（不消耗去重键）`);
    deferred.push({ ...meta, ids, partial: false, reason: deferReasonOverMaxAffected(cap, note) });
  }
  return { cap, affected, selected, deferred };
}

/** 合并标记前缀（幂等判据之一；也便于人工识别与一键还原）。 */
export const MERGE_MARK_PREFIX = '⚠️ 与 ';

/**
 * 规范化标题（保守口径，与方案逐字对齐：trim + 全角/半角统一）。
 * 刻意**不做**：大小写折叠、去括号、去标点、模糊匹配 —— 那些会误并（方案 §P3 反例）。
 * @param {unknown} title
 */
export function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  let s = title;
  // 1) 全角 ASCII（！-～ U+FF01-U+FF5E）→ 半角，覆盖全角括号/逗号/字母数字
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  // 2) 全角空格（U+3000）→ 半角空格
  s = s.replace(/\u3000/g, ' ');
  // 3) 各类空白（含 CR/LF/Tab/NBSP）折叠为单个半角空格
  s = s.replace(/[\s\u00A0]+/g, ' ');
  // 4) 去首尾空白
  return s.trim();
}

/** 描述规范化（与标题同口径；空/null → ''，保证"都没描述"也判定为重复）。 */
export function normalizeDescription(desc) {
  if (desc === null || desc === undefined) return '';
  return normalizeTitle(String(desc));
}

/** sha256（小写 hex）——确定性判据，不做任何"近似"。 */
export function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 卡的全量签名（标题 hash + desc hash）——方案里 `butler-auto-actions.json` 的去重键。 */
export function cardSign(card) {
  const hasTitle = typeof card?.title === 'string' && card.title.length > 0;
  const hasDesc = typeof card?.description === 'string' && card.description.length > 0;
  const titleNorm = normalizeTitle(card?.title);
  const descNorm = normalizeDescription(card?.description);
  return {
    titleNorm,
    descNorm,
    titleHash: hasTitle ? sha256(titleNorm) : '',
    descHash: hasDesc ? sha256(descNorm) : '',
    sigKey: `${hasTitle ? sha256(titleNorm).slice(0, 16) : 'no-title'}:${hasDesc ? sha256(descNorm).slice(0, 16) : 'no-desc'}`,
  };
}

/** 卡时间戳（数字优先；ISO 字符串兜底；缺失 → 0=最早）。 */
export function cardTime(card, field) {
  const v = card?.[field];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** 保留先建卡的确定性排序：createdAt 升序 → id 字典序（完全并列时）。 */
export function pickKeeper(cards) {
  return [...cards].sort((a, b) => {
    const ta = cardTime(a, 'createdAt');
    const tb = cardTime(b, 'createdAt');
    if (ta !== tb) return ta - tb;
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  })[0];
}

/**
 * 从合并备注里解析"被保留的先建卡 id"（幂等 / 去重判据）。
 * 备注形状：⚠️ 与 <keeperId> 重复，管家已合并（<YYYY-MM-DD>），勿单独执行
 * @param {unknown} description
 * @returns {string|null}
 */
export function mergeMarkKeeperId(description) {
  const d = typeof description === 'string' ? description : '';
  if (!d.startsWith(MERGE_MARK_PREFIX)) return null;
  const m = d.match(/^⚠️ 与 (\S+) 重复，管家已合并/);
  return m ? m[1] : null;
}

/**
 * 是否已被合并过（幂等判据）。
 * 判据① description 已带合并标记 + 指向同一 keeper；判据② auto 记录里已有 done 的同一 pair。
 */
export function isAlreadyMerged(card, keeperId) {
  const ref = mergeMarkKeeperId(card?.description);
  if (!ref) return false;
  return !keeperId || ref === String(keeperId);
}

/** 按规范化标题分组。 */
export function groupByTitle(cards) {
  const groups = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== 'object') continue;
    const titleNorm = normalizeTitle(card.title);
    const key = titleNorm || '(空标题)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  return groups;
}

/** 归档卡判据（与 `board-cleanup.mjs#isArchivedCard` 同口径：`archivedAt` 有值即归档）。 */
export function isArchivedCard(card) {
  const a = card?.archivedAt;
  return a !== undefined && a !== null && a !== '';
}

/**
 * 扫描账本，产出重复卡检测结果。
 *
 * ★K3（2026-09-24 · 看板瘦身/归档物理化 · 方案 §8 #11 · `L3-2`）：**归档卡不能当"不存在"**。
 *   物理归档之后归档卡住在 `task-board/archive/<batchId>/cards.json`；生产路径（`butler-auto-tick`
 *   的 api 分支）读的是 Host 的 `scope=all` 合并视图 ⇒ 归档卡**在 `ledger.tasks` 里**（带 `archivedAt`）。
 *   但它们多是 `done` ⇒ 会被下面的"只扫未终态卡"过滤掉 —— 于是**与归档卡同题的新在板卡会被判成
 *   "唯一卡"（没有重复），把重复开工这件事掩盖掉**。故这里**显式**做一层对照：
 *     · 归档卡**不参与** `certain`/`suspected`（它们只读、不可合并、也没有定时可清）；
 *     · 但对每张"检测面内的在板卡"，若同标题（`normalizeTitle` 口径）在归档卡里存在，
 *       就产出一条 `archivedTwins`（**只提示、零动作**）⇒ 统计进 `stats.archivedTwins`。
 *
 * @param {object} ledger 账本（含 tasks 数组；**可含归档卡**，本函数会自己分开）
 * @param {{now?:number, includeTerminal?:boolean, archivedTasks?:object[]}} [opts]
 *   includeTerminal 默认 false：只扫「未终态」卡（done/failed 不再动）
 *   archivedTasks：**显式**提供的归档卡（如"直读归档批次拿到的卡"）。缺省 = 从 `ledger.tasks`
 *     里按 `archivedAt` 自取（Host 合并视图的形态）。两者取并集、按 id 去重。
 * @returns {{
 *   scanned:number, groups:object[], certain:object[], suspected:object[],
 *   skipped:object[], archivedTwins:object[], stats:object
 * }}
 */
export function detectDuplicates(ledger, opts = {}) {
  const now = opts.now ?? Date.now();
  const includeTerminal = opts.includeTerminal === true;
  const terminal = new Set(['done', 'failed']);
  const all = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  // K3：先把**归档卡**与在板卡分开 —— 归档卡不参与合并判定（只读、无定时可清），
  //     只用来做"这张在板新卡是不是跟某张归档卡同题"的对照。
  const explicitArchived = Array.isArray(opts.archivedTasks) ? opts.archivedTasks : [];
  const archivedById = new Map();
  for (const c of [...all.filter(isArchivedCard), ...explicitArchived]) {
    if (!c || typeof c !== 'object') continue;
    const id = typeof c.id === 'string' && c.id !== '' ? c.id : null;
    if (id && !archivedById.has(id)) archivedById.set(id, c);
  }
  const boardAll = all.filter((c) => !isArchivedCard(c));
  const cards = includeTerminal ? boardAll : boardAll.filter((c) => !terminal.has(String(c?.status ?? '')));
  const archivedByTitle = groupByTitle([...archivedById.values()]);
  const groups = [];
  const certain = [];
  const suspected = [];
  const skipped = [];
  const mergedGroups = [];
  /** K3：检测面内的在板卡 ⊗ 归档卡「同题」对照（**只提示、零动作**；见本函数 JSDoc）。 */
  const archivedTwins = [];
  /** 累计：因 `kind:'interactive'` 被跳过合并的卡数（口径见 0b 注释）。 */
  let interactiveSkipped = 0;

  for (const card of cards) {
    const titleNorm = normalizeTitle(card?.title) || '(空标题)';
    const twins = archivedByTitle.get(titleNorm);
    if (!twins || twins.length === 0) continue;
    const stamp = (t) => (typeof t?.archivedAt === 'number' ? t.archivedAt : null) ?? cardTime(t, 'updatedAt') ?? 0;
    archivedTwins.push({
      titleNorm,
      boardId: String(card.id),
      boardTitle: card.title ?? '',
      boardStatus: String(card.status ?? ''),
      archivedIds: twins.map((t) => String(t.id)),
      archivedTitles: twins.map((t) => t.title ?? ''),
      latestArchivedAt: Math.max(0, ...twins.map(stamp)) || null,
      note: '与已归档卡同题 —— 不自动合并（归档卡只读、也不该复活）；若本机要跟进请先 restore 对应批次',
    });
  }

  for (const [titleNorm, members] of groupByTitle(cards)) {
    if (members.length < 2) continue;

    // 0) 已合并识别（**必须在 desc 分桶之前**）：合并=给后建卡 description 前插备注，
    //    因此组内 k1(原样) 与 k2(挂备注) 的 desc 必然不同 —— 若直接分桶，会把这张已合并的卡
    //    误报成 🟡「同标题不同 desc 疑似重复」，天天误报（误报率是裸跑期第一 KPI）。
    //    判据：备注里写的 keeperId 指向同组内的卡 → 该对视为"已合并"，两张都不再参与分桶。
    const mergedPairs = [];
    const mergedIds = new Set();
    for (const m of members) {
      const keeperRef = mergeMarkKeeperId(m?.description);
      if (!keeperRef) continue;
      const keeper = members.find((x) => String(x.id) === keeperRef);
      if (!keeper) continue;                                   // 指向组外的卡 → 不算已合并对
      mergedPairs.push({ keeperId: String(keeper.id), mergedId: String(m.id), titleNorm, descHash: cardSign(m).descHash });
      mergedIds.add(String(m.id));
      mergedIds.add(String(keeper.id));
    }
    const liveMembers = members.filter((m) => !mergedIds.has(String(m.id)));

    // 0b) **`kind:'interactive'` 卡一律跳过合并（2026-09-17 口径，主人改拍板后的受控验收交付）**：
    //     interactive 卡的定时字段天然不适用——Host 对它的 `set-schedule{enabled:true}` 直接报
    //     `interactive task cannot be scheduled` ⇒ 「挂备注 + 清定时」这套合并语义对它不成立
    //     （更根本的：interactive 只能由主人手动 run，何来"重复执行"要防）。
    //     位置刻意在 desc 分桶**之后**（用 byDesc 过滤，不破坏 keeper 判据 / 组结构）：
    //     排除后该卡既不进「确定重复」也不进「疑似重复」——它**不是**待处理对象，不该刷通知。
    //     与「已合并对」同类：进 `skipped`（可观测：为什么这张卡没人管） + `stats.interactiveSkipped`。
    const interactiveIds = new Set(
      liveMembers.filter((m) => String(m?.kind ?? '') === 'interactive').map((m) => String(m.id)),
    );

    // 组内按 description hash 再分组：同 desc 才是"确定重复"
    const byDesc = new Map();
    for (const m of liveMembers) {
      if (interactiveIds.has(String(m.id))) continue;
      const sign = cardSign(m);
      const key = sign.descHash || '(no-desc)';
      if (!byDesc.has(key)) byDesc.set(key, []);
      byDesc.get(key).push({ card: m, sign });
    }
    const descBuckets = [...byDesc.entries()];
    let certainInGroup = 0;
    let suspectedInGroup = 0;

    // ① 确定重复：同标题 + 同 desc（且该 bucket ≥2）
    for (const [descKey, bucket] of descBuckets) {
      if (descKey === '(no-desc)') continue; // 都没描述 → 不判"确定"（描述为空可能是两条真不同的活），走疑似
      if (bucket.length < 2) continue;
      const keeper = pickKeeper(bucket.map((b) => b.card));
      const keeperSign = cardSign(keeper);
      const dupes = bucket.filter((b) => String(b.card.id) !== String(keeper.id));
      const freshDupes = dupes.filter((b) => !isAlreadyMerged(b.card, keeper.id));
      const mergedAlready = dupes.filter((b) => isAlreadyMerged(b.card, keeper.id));
      certain.push({
        titleNorm,
        descHash: descKey,
        keeper: { id: String(keeper.id), title: keeper.title, createdAt: cardTime(keeper, 'createdAt') },
        duplicates: dupes.map((b) => ({
          id: String(b.card.id), title: b.card.title, status: b.card.status,
          createdAt: cardTime(b.card, 'createdAt'), updatedAt: cardTime(b.card, 'updatedAt'),
          schedule: b.card.schedule ?? null, hasSchedule: !!b.card.schedule,
        })),
        freshDuplicates: freshDupes.map((b) => String(b.card.id)),
        alreadyMergedDuplicates: mergedAlready.map((b) => String(b.card.id)),
        pairSig: sha256(`${String(keeper.id)}|${descKey}`),
        keeperTitleHash: keeperSign.titleHash,
        actionable: freshDupes.length > 0,
      });
      certainInGroup += freshDupes.length;
      if (!freshDupes.length && mergedAlready.length) {
        skipped.push({ titleNorm, reason: 'already-merged', ids: mergedAlready.map((b) => String(b.card.id)) });
        mergedGroups.push({
          titleNorm, descHash: descKey, keeperId: String(keeper.id),
          mergedIds: mergedAlready.map((b) => String(b.card.id)), pairSig: sha256(`${String(keeper.id)}|${descKey}`),
        });
      }
    }

    // ①b 由备注识别出的已合并对（其 desc 必然不同，不能进 ② 的疑似池）
    for (const mp of mergedPairs) {
      skipped.push({ titleNorm, reason: 'already-merged-mark', ids: [mp.mergedId] });
      mergedGroups.push({ titleNorm, descHash: mp.descHash, keeperId: mp.keeperId, mergedIds: [mp.mergedId], pairSig: sha256(`${mp.keeperId}|${mp.descHash}`) });
    }

    // ①c `kind:'interactive'` 卡：一律跳过合并（口径见上方 0b 注释）——留痕但不算待处理
    if (interactiveIds.size) {
      skipped.push({ titleNorm, reason: 'interactive-skipped', ids: [...interactiveIds] });
      interactiveSkipped += interactiveIds.size;
    }

    // ② 疑似重复：同标题但 desc 不同（跨 bucket）→ 只通知（已合并对已排除）
    if (descBuckets.length > 1 || (descBuckets.length === 1 && descBuckets[0][0] === '(no-desc)')) {
      suspected.push({
        titleNorm,
        ids: liveMembers.map((c) => String(c.id)),
        descHashes: liveMembers.map((c) => cardSign(c).descHash.slice(0, 12)),
        reason: descBuckets.length === 1 ? 'empty-description' : 'description-differs',
        titles: liveMembers.map((c) => c.title),
      });
      suspectedInGroup = liveMembers.length;
    }

    groups.push({
      titleNorm, count: members.length,
      ids: members.map((c) => String(c.id)),
      certainPairs: certainInGroup, suspected: suspectedInGroup > 0,
    });
  }

  return {
    scanned: cards.length,
    groups,
    certain,
    suspected,
    skipped,
    mergedGroups,
    archivedTwins,
    stats: {
      totalCards: all.length,
      scannedCards: cards.length,
      skippedTerminal: all.length - cards.length,
      certainGroups: certain.length,
      actionableGroups: certain.filter((c) => c.actionable).length,
      duplicateCards: certain.reduce((n, g) => n + g.duplicates.length, 0),
      suspectedGroups: suspected.length,
      alreadyMerged: skipped.filter((s) => s.reason === 'already-merged').length,
      alreadyMergedGroups: mergedGroups.length,
      /** `kind:'interactive'` 被跳过合并的卡数（只提示，不是待处理项；口径见 detectDuplicates 0b） */
      interactiveSkipped,
      /** K3：本次检测面里被分开的归档卡数（含 `ledger.tasks` 自取 + `opts.archivedTasks`） */
      archivedScanned: archivedById.size,
      /** K3：与归档卡同题的**在板**卡数（只提示；旧口径下这批卡会被当"唯一卡"而掩盖重复） */
      archivedTwinCards: archivedTwins.length,
      now,
    },
  };
}

/**
 * 卡 schedule 的合并目标态（纯函数）。
 * 口径（Host `applySetSchedule` 语义：`cron` 必须非空且合法，否则 `applied:false` → 400 `invalid schedule`）：
 *   - 无 schedule → 无需动作（`target:null, needsAction:false`）
 *   - 已是 disabled → 目标态已成立（`needsAction:false`，但 target 仍记录以便审计/回滚）
 *   - enabled 且 cron 合法 → 需 `set-schedule{enabled:false, cron}`（`needsAction:true`）
 *   - enabled 但 cron 缺失/非法 → **Host 无能为力**（无法禁用），返回 warning 如实上报（真账本恒有合法 cron）
 * @param {unknown} schedule
 * @returns {{has:boolean, enabled:boolean, cron:string|null, target:null|{enabled:false,cron:string}, needsAction:boolean, warning:string|null}}
 */
export function scheduleMergeTarget(schedule) {
  if (!schedule || typeof schedule !== 'object') {
    return { has: false, enabled: false, cron: null, target: null, needsAction: false, warning: null };
  }
  const enabled = schedule.enabled === true;
  const cronRaw = typeof schedule.cron === 'string' ? schedule.cron.trim() : '';
  const cron = cronRaw || null;
  if (!cron) {
    return {
      has: true, enabled, cron: null, target: null, needsAction: false,
      warning: enabled ? 'schedule 无合法 cron（Host 无法禁用，需人工处理）' : null,
    };
  }
  return { has: true, enabled, cron, target: { enabled: false, cron }, needsAction: enabled, warning: null };
}

/** 合并备注行（写进后建卡 description 前插，可人工一键删除还原）。 */
export function mergeNote(keeperId, when, extra = {}) {
  const day = new Date(when).toISOString().slice(0, 10);
  const lines = [`${MERGE_MARK_PREFIX}${keeperId} 重复，管家已合并（${day}），勿单独执行`];
  // 2026-09-13：原「整个 schedule 对象」改为**优先只记 cron 字符串**（回滚直接 re-enable，不必反解对象）；
  // 无 cron 时兜底记原值文本（兼容历史形状 / 非法形状的人工排查）。
  const cron = typeof extra.cron === 'string' && extra.cron.trim() ? extra.cron.trim() : null;
  const raw = extra.scheduleRaw;
  const text = cron ?? (raw === undefined || raw === null ? null : (typeof raw === 'string' ? raw : JSON.stringify(raw)));
  if (text) lines.push(`> 原定时（已禁用，回滚用）：${text}`);
  return lines.join('\n');
}

/** Host `description` 规整口径（`task-update.ts:90` 会 `trim()`）——幂等/对照一律按此判等。 */
export function normalizeWireDescription(text) {
  return String(text ?? '').trim();
}

/** 把卡上的 description 与目标值按 Host 规整口径判等。 */
export function sameWireDescription(current, target) {
  return normalizeWireDescription(current) === normalizeWireDescription(target);
}

/** 把备注插到 description 最前面（保留原文，绝不覆盖）。 */
export function prependNote(description, note) {
  const body = typeof description === 'string' ? description : '';
  return body ? `${note}\n\n${body}` : note;
}

/**
 * 构造单张「后建卡」的合并 patch（**写意图 = Host 动作序列**，纯函数）。
 * 动作顺序刻意固定为「先 update（挂备注，含原 cron 文本）→ 再 set-schedule（禁用）」：
 * 中间失败态 = 备注已挂、cron 未禁 = **卡片仍然完整可跑**（`isAlreadyMerged` 幂等下次继续）。
 * @param {{id:string, keeperId:string, card:object|undefined, now:number}} o
 */
export function buildMergePatch(o) {
  const id = String(o.id);
  const keeperId = String(o.keeperId);
  const card = o.card;
  const sched = scheduleMergeTarget(card?.schedule);
  const note = mergeNote(keeperId, o.now, { cron: sched.cron, scheduleRaw: card?.schedule ?? null });
  const targetDescription = normalizeWireDescription(prependNote(card?.description ?? '', note));
  const warnings = [];
  if (sched.warning) warnings.push(sched.warning);

  const actions = [{
    kind: 'update',
    taskId: id,
    patch: { description: targetDescription },
    expect: { description: targetDescription },
  }];
  if (sched.needsAction) {
    actions.push({
      kind: 'set-schedule',
      taskId: id,
      patch: { enabled: false, cron: sched.cron },
      expect: { scheduleEnabled: false },
    });
  }

  const restore = { id, description: card?.description ?? null, schedule: card?.schedule ?? null };
  return {
    id,
    from: { description: card?.description ?? null, schedule: card?.schedule ?? null },
    to: { description: targetDescription, schedule: sched.target },
    note,
    actions,
    warnings,
    scheduleCleared: sched.needsAction ? { enabled: false, cron: sched.cron } : null,
    scheduleDeferred: !sched.needsAction && sched.has ? { reason: sched.warning ?? 'already-disabled', target: sched.target } : null,
    rollback: { op: 'dup-cards-merge', id, keeperId, restore, actions: buildRollbackActions(restore) },
  };
}

/**
 * 由「还原态」构造回滚动作序列（P3-③ 同源改造：回滚也走 Host API）。
 *  - description → `update{description:原值}`
 *  - 原 schedule 当时是 enabled 的 → `set-schedule{enabled:true, cron:原 cron}`
 * @param {{id:string, description:unknown, schedule:unknown}} restore
 * @returns {object[]} 动作序列（0~2 个）
 */
export function buildRollbackActions(restore) {
  const id = restore?.id === undefined || restore?.id === null ? null : String(restore.id);
  if (!id) return [];
  const description = normalizeWireDescription(restore?.description);
  const actions = [{ kind: 'update', taskId: id, patch: { description }, expect: { description } }];
  const sched = restore?.schedule;
  const cron = sched && typeof sched === 'object' && typeof sched.cron === 'string' ? sched.cron.trim() : '';
  if (sched && typeof sched === 'object' && sched.enabled === true && cron) {
    actions.push({ kind: 'set-schedule', taskId: id, patch: { enabled: true, cron }, expect: { scheduleEnabled: true } });
  }
  return actions;
}

/** 目标态是否已在账本上成立（幂等预判；判据按 Host 的 description trim 口径）。 */
export function patchAlreadyApplied(card, patch) {
  if (!card) return true; // 卡不存在 → 无需动作（Host 会以 task not found 拒，别浪费一次往返）
  if (!sameWireDescription(card.description, patch?.to?.description)) return false;
  const target = patch?.to?.schedule;
  if (!target) return true;
  const cur = card.schedule;
  if (cur?.enabled === true) return false;
  const cron = typeof target.cron === 'string' ? target.cron.trim() : '';
  if (cron && String(cur?.cron ?? '').trim() !== cron) return false;
  return true;
}

/**
 * 生成合并计划（**只算不动**）。
 *
 * ★K3（2026-09-24）：透传 `detectDuplicates` 的 **`archivedTwins`**（"在板卡与归档卡同题"的对照）。
 *   它**不是待处理项**（不产任何 action —— 归档卡只读，且宿主不会接受对它的写入），
 *   只是让消费方（tick 日报 / dry-run 预览）看得见"这张新卡可能是重复开工"。
 *
 * I14 `maxAffected`（2026-09-19 新增）：计划阶段就按「被改动卡数」截断，超限部分进 `deferred`
 * （**不执行、不写账本**，下一轮 tick 重新检出后继续）。截断粒度 = **卡**（不切组内动作序列）：
 *   · 每张后建卡的合并都是**独立、原子、幂等**的（update 挂备注 → set-schedule 禁用，失败态安全）；
 *   · 若按"整组"扣下，组内卡数 > maxAffected 的组会**永远轮不到**（活锁）——卡粒度截断不会。
 * @param {object} ledger
 * @param {{now?:number, includeTerminal?:boolean, maxGroups?:number, maxAffected?:number}} [opts]
 *   maxAffected 缺省 = `DUP_MAX_AFFECTED_DEFAULT`（4）；`0` = 本批零动作（全部 deferred）。
 * @returns {{ok:boolean, kind:'dup-cards-merge', actions:object[], deferred:object[], suspected:object[],
 *            groups:object[], stats:object, reason?:string}}
 */
export function planDuplicateMerge(ledger, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAffected = resolveMaxAffected(opts.maxAffected);
  const det = detectDuplicates(ledger, opts);
  let groups = det.certain.filter((g) => g.actionable);
  if (Number.isFinite(opts.maxGroups)) groups = groups.slice(0, opts.maxGroups);

  const byId = new Map((ledger?.tasks ?? []).map((c) => [String(c.id), c]));
  // 由 patch 集合构造动作（形状与原实现逐字一致，只是抽出来给「截断后」复用）
  const makeAction = (g, keeperId, patches) => ({
    kind: 'dup-cards-merge',
    keeperId,
    keeperTitle: g.keeper.title,
    titleNorm: g.titleNorm,
    descHash: g.descHash,
    sigKey: `dup-merge:${sha256(`${keeperId}|${g.descHash}`).slice(0, 24)}`,
    scheduleCleared: patches.filter((p) => p.scheduleCleared).map((p) => ({ id: p.id, from: p.from.schedule, to: p.scheduleCleared })),
    patches,
  });

  // ★ I14 maxAffected：**计划 → 执行之间**截断（绝不执行中途截；逻辑源 = limitByMaxAffected，
  //   与 `applyDuplicateMerge` 的执行前兜底**同源**，避免两处口径漂移）
  const plannedGroups = groups.map((g) => {
    const keeperId = g.keeper.id;
    const dupes = g.duplicates.filter((d) => g.freshDuplicates.includes(d.id));
    return {
      item: g, keeperId, titleNorm: g.titleNorm, descHash: g.descHash,
      patches: dupes.map((d) => buildMergePatch({ id: d.id, keeperId, card: byId.get(d.id), now })),
    };
  });
  const limited = limitByMaxAffected(plannedGroups, maxAffected);
  // limitByMaxAffected 的 selected 元素 = `{ item: <传入的条目>, patches: 截断后 }` ⇒ 条目里的 `item` 才是原始组 g
  const actions = limited.selected.map(({ item: entry, patches }) => makeAction(entry.item, entry.keeperId, patches));
  /** 超 `maxAffected` 被扣下的（组,卡）——下一轮 tick 继续；本批**零写入**。 */
  const deferred = limited.deferred;

  const deferredCards = deferred.reduce((n, d) => n + d.ids.length, 0);
  return {
    ok: true,
    kind: 'dup-cards-merge',
    actions,
    deferred,
    suspected: det.suspected,
    groups: det.groups,
    mergedGroups: det.mergedGroups,
    /** K3：在板卡 ⊗ 归档卡 的「同题」对照（**只提示、零动作**；归档卡不可合并也不该复活）。 */
    archivedTwins: det.archivedTwins ?? [],
    /** 所有确定重复组都已在过去合并过 → 无可执行动作（幂等信号，比盯 reason 文案稳）。
     *  ⚠️ I14：全部 deferred（超上限）**不算** allMerged —— 那是"这批没做"，不是"已合并"。 */
    allMerged: actions.length === 0 && deferred.length === 0 && ((det.certain ?? []).length > 0 || (det.mergedGroups ?? []).length > 0),
    stats: {
      ...det.stats,
      maxAffected,
      plannedActions: actions.length,
      plannedPatches: actions.reduce((n, a) => n + a.patches.length, 0),
      /** I14 可观测性：因超上限被截断的**组数**（含被部分扣下的组） */
      deferredGroups: deferred.length,
      /** I14 可观测性：被扣下的**卡数**（= 下一批待处理） */
      deferredCards,
      /** I14 可观测性：本批是否发生截断 */
      truncated: deferred.length > 0,
    },
    reason: actions.length
      ? ''
      : (deferred.length
        ? `本批未处理任何卡：影响卡数超过单批上限（maxAffected=${maxAffected}），${deferredCards} 张已 deferred（下一批继续）`
        : (det.certain.length || (det.mergedGroups ?? []).length
          ? `确定重复 ${det.certain.length || (det.mergedGroups ?? []).length} 组已全部合并过（无待处理）`
          : (det.stats.suspectedGroups ? `仅发现 🟡 疑似重复 ${det.stats.suspectedGroups} 组（只通知，不自动）` : '未发现确定重复卡'))),
  };
}

/**
 * 可逆性校验（供恢复脚本/CLI/单测共用）：从审计行还原后建卡。
 * 2026-09-13 起同时产出**回滚动作序列**（`actions`，走 Host API）；`patches[].actions` 优先，
 * 旧审计行（只有 `rollback.restore`）由 `buildRollbackActions()` 现算——**新旧审计行都能回滚**。
 * @param {object} auditRow 审计行（kind:'dup-merge'）
 * @returns {{ok:boolean, patches:object[], actions:object[], reason?:string}}
 */
export function rollbackFromAuditRow(auditRow) {
  const patches = auditRow?.detail?.patches ?? auditRow?.patches ?? null;
  if (!Array.isArray(patches) || !patches.length) return { ok: false, patches: [], actions: [], reason: '审计行无 patches' };
  const out = [];
  const acts = [];
  for (const p of patches) {
    if (!p?.id || !p?.rollback?.restore) return { ok: false, patches: [], actions: [], reason: `patch ${p?.id ?? '?'} 缺 rollback.restore` };
    const restore = p.rollback.restore;
    out.push(restore);
    const seq = Array.isArray(p?.rollback?.actions) && p.rollback.actions.length ? p.rollback.actions : buildRollbackActions(restore);
    acts.push(...seq);
  }
  return { ok: true, patches: out, actions: acts };
}

/**
 * 真写合并（**必须显式传 apply 执行器**；异步——写走 Host API）。
 * @param {object} plan planDuplicateMerge 的结果
 * @param {{apply:(actions:object[], meta:object)=>Promise<object>, readState?:()=>Promise<{tasks:object[]}>,
 *          now?:number, maxAffected?:number}} opts
 *   apply  = 动作序列执行器（生产 = `lib/ledger-api.mjs` 的 `api.applySequence`）；
 *   readState = 读当前账本任务（幂等预判；生产 = `api.readState`）；
 *   maxAffected = I14 单批影响上限兜底（缺省取 `plan.stats.maxAffected`，再缺省取 `DUP_MAX_AFFECTED_DEFAULT`）。
 *   不传 apply → 返回 {ok:false, kind:'dry-run', reason:'只算不动'}（**绝不静默直写**）。
 *   I14：**执行前**再按卡边界兜一刀 —— 即便调用方绕过 `planDuplicateMerge` 直接构造超限 plan，
 *   也绝不超限写入；超限部分不执行，随 `deferred` 返回（下一轮继续）。
 */
export async function applyDuplicateMerge(plan, opts = {}) {
  const apply = opts.apply;
  if (typeof apply !== 'function') {
    return { ok: false, kind: 'dry-run', reason: '未提供 apply 执行器（dry-run：只算不动）', actions: plan?.actions ?? [] };
  }
  const actions = plan?.actions ?? [];
  if (!actions.length) return { ok: true, kind: 'noop', changed: 0, applied: [], deferred: [], steps: [], actions: [] };

  // ① 幂等预判：读回当前账本，目标态已成立的卡不动（避免"每天空转一次 update"）
  let pending = actions;
  if (typeof opts.readState === 'function') {
    let tasks = null;
    try {
      const pre = await opts.readState();
      tasks = Array.isArray(pre?.tasks) ? pre.tasks : (Array.isArray(pre) ? pre : null);
    } catch { tasks = null; }
    if (tasks) {
      const byId = new Map(tasks.map((c) => [String(c.id), c]));
      pending = [];
      for (const a of actions) {
        const fresh = a.patches.filter((p) => !patchAlreadyApplied(byId.get(String(p.id)), p));
        if (fresh.length) pending.push({ ...a, patches: fresh });
      }
      if (!pending.length) return { ok: true, kind: 'noop', changed: 0, applied: [], deferred: [], steps: [], actions: [] };
    }
  }

  // ② I14 maxAffected 兜底（幂等过滤**之后**、展平**之前**；口径与计划层**同源** = limitByMaxAffected）：
  //    即便调用方绕过 planDuplicateMerge 直接构造超限 plan，也绝不超限写入。
  const limited = limitByMaxAffected(
    pending.map((a) => ({ item: a, keeperId: a.keeperId, titleNorm: a.titleNorm, descHash: a.descHash, patches: a.patches })),
    opts.maxAffected ?? plan?.stats?.maxAffected,
  );
  const selected = limited.selected.map(({ item, patches }) => ({ ...item, patches }));
  const deferred = limited.deferred;
  if (!selected.length) {
    // 上限 = 0 或全部超限 → **零写入**（一次 action 都不发），如实返回 deferred
    return { ok: true, kind: 'noop', changed: 0, applied: [], deferred, truncated: deferred.length > 0, steps: [], actions: [] };
  }

  // ③ 展平为动作序列（卡顺序；每卡「update → set-schedule」，失败态安全）
  const seq = [];
  for (const a of selected) {
    for (const p of a.patches) for (const act of p.actions) seq.push(act);
  }

  const res = await apply(seq, { label: 'dup-merge', plan, actions: selected });
  const appliedCards = new Set((res?.appliedCards ?? []).map(String));
  const changed = Number(res?.changed ?? appliedCards.size);
  const applied = selected.map((a) => ({
    keeperId: a.keeperId,
    ids: a.patches.map((p) => p.id),
    scheduleCleared: a.patches.map((p) => p.scheduleCleared).filter(Boolean),
    scheduleDeferred: a.patches.map((p) => p.scheduleDeferred).filter(Boolean),
  }));

  return {
    ok: res?.ok !== false,
    kind: res?.ok === false ? (res?.kind ?? 'failed') : (changed > 0 ? 'applied' : 'noop'),
    changed,
    applied,
    /** I14：超上限未执行的（下一轮继续）；每个 id 的卡**零写入**（description/schedule 原样） */
    deferred,
    truncated: deferred.length > 0,
    steps: res?.steps ?? [],
    failedStep: res?.failedStep ?? null,
    error: res?.error ?? null,
    ledgerResult: res?.ok !== false,
    revision: res?.revision ?? null,
  };
}

// 2026-09-13：旧的 `applyDuplicateMerge(plan, {writer})`（直写账本文件）**已删除** ——
//   P3 写路径改走 Host API 后，`writer(fn)` 契约不再存在（唯一执行器 = ledger-api 的 applySequence）。
//   直写实现仍可在 lib/ledger-write.mjs（**仅测试/隔离用**）与 git 历史里找到。

