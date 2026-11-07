// dsh-butler / lib/alert-template.mjs —— 告警**四段式模板**的唯一校验器（2026-10-10 · 冲刺600 · 补可观测 B3）
//
// 为什么存在（缺口 gap-1-12）：
//   v2 方案 §3.7.6 定死「告警可执行性模板 = 现象 / 影响 / 建议动作 / 依据，**缺任一段视为不合格告警**」，
//   生产里也确实有几处按它写文案（`lib\tickd-health.mjs` 的 M4/M5、`lib\tickd-metrics.mjs` 的越界告警、
//   `lib\queue-watch.mjs` 的建议动作段），但**没有任何校验器** —— 全靠写的人自觉。谁漏了一段，
//   没人知道；"四段式"就成了文档里的一句话，不是可执行的判据。
//   本模块 = 把这句话变成**能自动跑**的判据（纯函数），出口处据此「缺段 ⇒ 降级为 info + 留痕」。
//
// 口径三条（防止这套判据自己变成拍脑袋）：
//   ① **段标记以全角冒号为准**：`现象：` `影响：` `建议动作：` `依据：`；兼容半角 `:`，
//      也兼容 `｜现象：` 这种用竖线串起来的写法（本库既有文案就是这种）。
//   ② **两种告警形态分开对待**（见 `gateAlertTemplates` 的 mode）：
//      · `family`（默认）= 文本里**已经用了段标记**（⇒ 自称四段式）却缺段 ⇒ 降级。
//        一条段标记都没有的"一句话短告警"（桌宠 push 那类）**不降级** —— 否则会把全部 P2 告警
//        降成报告项，等于用"格式合规"把告警能力掐了（那是改能力，不是补观测）。
//      · `strict` = 任何不齐都降级（想把短告警也一并管住时用；**只由单轮参数传，不落配置**）。
//      · `off`    = 只统计不降级（灰度/排障用）。
//   ③ **本模块零副作用**：不读文件、不写文件、不报错；留痕由出口（`watch-notify.mjs`）负责写审计。
//   ④ **「标题式现象段」算现象段**（2026-10-10 现场发现，**不是放宽**，是如实对齐既有合格文案）：
//      生产 `lib\tickd-health.mjs:382` 的 M4/M5 镜像告警首段写的是 **`镜像停摆：对端连续 N 轮不可达…`**
//      —— 它**就是现象段**（回答"出了什么事"），只是没用 `现象：` 这三个字当标记。若按字面判"缺现象"，
//      会把一条**本来合格的真告警**降级 ⇒ 用格式判据掐掉告警能力。
//      ⇒ 判据：首段形如 `标题：…`（标题 ≤12 字、非四段名）**且**其余三段里已出现 ≥2 段时，
//        认可该首段为现象段（`symptomStyle='headline'`）；只有 ≤1 段时不认（否则 `短标题：正文`
//        这种一句话告警会被误判成"自称四段式"而遭降级）。
//      ⚠️ 口径差异**显式记账**（`symptomStyle` + 报告统计条数），不许偷偷放过；
//        是否要求把它们统一改成 `现象：` 字面 → 见交付报告「待拍板」。
//
// ⚠️ 铁律（B3 卡要点）：模式只走**单轮参数**，绝不写进任何持久配置；`--json` 时日志只落文件不上 stdout。

export const ALERT_TEMPLATE_VERSION = '0.1.0';

/** 四段（顺序即模板顺序，报告里照这个顺序展示）。 */
export const ALERT_SECTIONS = Object.freeze(['现象', '影响', '建议动作', '依据']);

/** 口径出处（报告/文档引用时照抄，别凭记忆转述）。 */
export const ALERT_TEMPLATE_SOURCE = 'docs/ §3.7.6（告警可执行性模板：现象/影响/建议动作/依据）';

/** 校验模式取值域（默认 `family` —— 见文件头 ②）。 */
export const TEMPLATE_GATE_MODES = Object.freeze(['off', 'family', 'strict']);

const SECTION_MARK_RE = /(?:^|[｜|\s·])(现象|影响|建议动作|依据)\s*[:：]/g;

/** 「标题式现象段」：首部 `标题：…`（标题 ≤12 字且不含竖线）。见文件头 ④。 */
const HEADLINE_RE = /^[^｜|\s][^｜|]{0,11}[:：]/;

/**
 * 解析四段：能认出哪些段、顺序如何、每段内容是什么。
 * @param {string} text
 * @returns {{present:string[], order:string[], missing:string[], sections:Record<string,string>,
 *            family:boolean, symptomStyle:'marked'|'headline'|null}}
 */
export function parseAlertSections(text) {
  const t = String(text ?? '');
  const hits = [];
  SECTION_MARK_RE.lastIndex = 0;
  let m;
  while ((m = SECTION_MARK_RE.exec(t)) !== null) {
    // 命中位置往后跳到段名本身（正则可能吃了前导分隔符）
    const nameAt = m.index + m[0].indexOf(m[1]);
    hits.push({ name: m[1], at: nameAt, end: m.index + m[0].length });
  }
  const sections = {};
  for (let i = 0; i < hits.length; i++) {
    const from = hits[i].end;
    const to = i + 1 < hits.length ? hits[i + 1].at : t.length;
    const body = t.slice(from, to).replace(/^[｜|\s]+/, '').replace(/[｜|\s]+$/, '').trim();
    // 同名段重复出现 ⇒ 保留最长的那段（防"截断占位"覆盖真内容）
    const prev = sections[hits[i].name];
    if (prev === undefined || body.length > prev.length) sections[hits[i].name] = body;
  }
  let present = ALERT_SECTIONS.filter((s) => Object.prototype.hasOwnProperty.call(sections, s));
  // —— 标题式现象段（文件头 ④）——
  let symptomStyle = present.includes('现象') ? 'marked' : null;
  if (!present.includes('现象')) {
    const others = ALERT_SECTIONS.filter((s) => s !== '现象' && present.includes(s));
    const head = HEADLINE_RE.exec(t);
    if (head && others.length >= 2) {
      const cut = t.search(/[｜|]/);
      const headSeg = (cut === -1 ? t : t.slice(0, cut)).trim();
      const colon = headSeg.search(/[:：]/);
      sections['现象'] = headSeg.slice(colon + 1).trim();
      present = ALERT_SECTIONS.filter((s) => Object.prototype.hasOwnProperty.call(sections, s));
      symptomStyle = 'headline';
    }
  }
  return {
    present,
    order: hits.map((h) => h.name),
    missing: ALERT_SECTIONS.filter((s) => !present.includes(s)),
    sections,
    family: present.length > 0,
    symptomStyle,
  };
}

/**
 * 校验一条告警文案。
 * @param {string} text
 * @returns {{family:boolean, present:string[], missing:string[], ok:boolean, sections:object, symptomStyle:string|null}}
 */
export function checkAlertTemplate(text) {
  const p = parseAlertSections(text);
  return { family: p.family, present: p.present, missing: p.missing, ok: p.missing.length === 0, sections: p.sections, symptomStyle: p.symptomStyle };
}

/** 模式归一（不认识的值 ⇒ `family`，**默认永远是最保守的那条**）。 */
export function normalizeTemplateGateMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return TEMPLATE_GATE_MODES.includes(m) ? m : 'family';
}

/**
 * 出口闸：把一批 push 项分成「照常推」与「降级为 info」两拨。
 *
 * 判据（mode=family，默认）：
 *   · 文案四段齐 ⇒ 照常推（且计入 passed）；
 *   · 文案**用了段标记但缺段** ⇒ 降级（`level` 改写为 `'info'`，附 `downgrade{}` 说明缺哪段）；
 *   · 文案一个段标记都没有（短告警）⇒ 照常推，但计入 `shortAlert`（可观测"有多少告警还不是四段式"）。
 *
 * @param {Array} items push 列表（每项至少有 detail 或 message）
 * @param {{mode?:string}} [opts] mode 来自**单轮参数**，不读配置
 */
export function gateAlertTemplates(items, opts = {}) {
  const mode = normalizeTemplateGateMode(opts.mode);
  const list = Array.isArray(items) ? items : [];
  const keep = [];
  const downgraded = [];
  const passed = [];
  const shortAlerts = [];
  if (mode === 'off') {
    return { mode, checked: list.length, keep: [...list], downgraded, passed, shortAlerts, downgradedCount: 0 };
  }
  for (const it of list) {
    const text = it?.detail ?? it?.message ?? '';
    const v = checkAlertTemplate(text);
    if (v.ok && v.family) { keep.push(it); passed.push(it); continue; }
    if (!v.family) {
      // 短告警：family 模式不降级；strict 模式才降级
      shortAlerts.push(it);
      if (mode === 'strict') {
        downgraded.push({ ...it, level: 'info', downgrade: { reason: 'alert-template-incomplete', missing: v.missing, present: v.present, mode } });
      } else {
        keep.push(it);
      }
      continue;
    }
    downgraded.push({ ...it, level: 'info', downgrade: { reason: 'alert-template-incomplete', missing: v.missing, present: v.present, mode } });
  }
  return { mode, checked: list.length, keep, downgraded, passed, shortAlerts, downgradedCount: downgraded.length };
}

/** 只读自检（报告/CLI 用）：模式域 + 口径出处。 */
export function alertTemplateSelfCheck() {
  return {
    version: ALERT_TEMPLATE_VERSION,
    sections: [...ALERT_SECTIONS],
    modes: [...TEMPLATE_GATE_MODES],
    defaultMode: 'family',
    source: ALERT_TEMPLATE_SOURCE,
    ok: ALERT_SECTIONS.length === 4 && TEMPLATE_GATE_MODES.includes('family'),
  };
}
