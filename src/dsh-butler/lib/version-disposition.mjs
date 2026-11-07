// dsh-butler / lib/version-disposition.mjs —— 版本不匹配「四步处置」编排（**步骤 3 / 4 的自动触发点**）
//
// 真源口径 = 方案 §5.1「不匹配处置 4 步」：① 跳过 ② 独立通道告警 ③ 按宪法自修复 ④ 降档联动。
//   · 步骤 1「跳过」= `lib/version.mjs#checkComponent` 四因 → `action:'skip'` + 各入口 `if (!gate.run) return`（**已在产**）；
//   · 步骤 2「独立通道告警」= `gateComponent` 内 `alert({source:'butler-version:<name>'})`（**已在产**，不依赖面板/日报）；
//   · **步骤 3「按宪法自修复」在生产只有"建议"、无自动触发点**（主档 A 域 L167 缺口原话）；
//   · **步骤 4「降档联动」在生产只有 `suggestDegradeOnMismatch()` 建议函数、无自动触发点**；且 `lib/version.mjs:278`
//     有明文设计选择：「只给建议、**不自动执行** —— 自动降档 = 改自治行为，归操作者」。
//
// 【本模块补的是什么】步骤 3 / 4 的**自动触发点**（= 谁在什么时候自动把这两步跑起来），**不是**取消
//   `version.mjs` 那个设计选择：
//     · 自动触发点 = 周期自检（tickd 侧）**自动**调用本模块 ⇒ **自动**产出「修复请求」与「降档请求」，
//       并**自动**落审计台账（`~/.dsh/butler-audit/<月>.jsonl`，type = `version-disposition`）+ 独立通道告警；
//     · **动手**（重部署组件 / 真降档）**仍归人 / 卡** —— 重部署要走 `deploy.mjs`（含重启，须窗口），
//       降档要改自治行为（归操作者）。本模块**零开关、零写入自治状态**：`autoExecute` 恒为 `false`，
//       且把这件事做成**可断言字段**（而不是一句注释）。
//
// ⚠️ 为什么不在本模块自动降档：① 改自治行为属操作者（version.mjs:278 既有口径）；② 自动重启 = 断服务风险；
//   ③ §11 红线「操作者不给自己扩权」——新增一个"自动降档"通路就是扩权。⇒ 本版如实记 `degradeRequested`
//   + `autoExecute:false`，把「要不要开自动执行」列为**待操作者拍板**（见交付报告）。
//
// 去重：同一「不匹配签名」（组件名排序）在冷却窗内只写一次台账/告警 —— 周期自检不得刷屏。
import fs from 'node:fs';
import { appendAudit, tailAudit } from './audit.mjs';
import { alert } from './alert.mjs';
import { selfCheck, suggestDegradeOnMismatch, PRODUCT_VERSION } from './version.mjs';
import { dshHome, butlerPaths } from './paths.mjs';

export const VERSION_DISPOSITION_VERSION = '0.1.0';

/** 同签名的重复告警冷却（毫秒）—— 与 `lib/alert.mjs` 的"正常态零噪音"口径一致。 */
export const DISPOSITION_COOLDOWN_MS = 30 * 60_000;

/** 不匹配签名 = 组件名排序（用于冷却去重；换组件 ⇒ 视为新事件）。 */
export function mismatchSignature(rows) {
  return (rows ?? []).map((r) => r.name).sort().join('|');
}

/**
 * 步骤 3 的**修复计划**（纯函数：只出计划，不执行 —— 执行含重启、须窗口）。
 * @param {Array<{name:string, myVersion:string, registered:string, file?:string}>} rows
 */
export function buildRepairPlan(rows) {
  const targets = (rows ?? []).map((r) => {
    const isPanel = /panel/i.test(r.name);
    return {
      component: r.name,
      entityVersion: r.myVersion ?? null,
      registeredVersion: r.registered ?? null,
      productFile: r.file ?? null,
      // 两条候选路径（人/卡按真实漂移方向选其一；本模块**不选**、不执行）
      candidates: [
        {
          id: 'realign-entity',
          meaning: '实体落后/超前于产品登记 ⇒ 重新铺实体（**含重启，须维护窗口**）',
          command: isPanel ? 'node <tools-root>\\dsh-butler-panel\\deploy.mjs --no-restart' : 'node <tools-root>\\dsh-butler\\deploy.mjs',
          risk: isPanel ? '面板侧无重启（前端硬刷新即生效）' : '核心侧含重启 dsh ⇒ **必须走停机窗口**（带外外援口径）',
        },
        {
          id: 'realign-declaration',
          meaning: '实体才是真值（产品登记过期）⇒ 刷新产品登记（`lib/version.mjs#writeProductVersion({home})`），**不改行为、无重启**',
          command: 'human-or-card → lib/version.mjs#writeProductVersion({ home })（**不是** CLI；由人/卡显式调用）',
          risk: '只改声明、不动实体 ⇒ 低风险；但会**掩盖真漂移**，须先判明谁是真源',
        },
      ],
    };
  });
  return {
    step: 3,
    title: '按宪法自修复',
    autoTriggered: true,       // ← 本模块被周期自检调用即触发（不等于自动执行）
    autoExecute: false,        // ← 铁律：重部署含重启 ⇒ 执行归人/卡（须窗口）
    executableBy: rows?.length ? ['owner-panel', 'main-session', 'card-session'] : [],
    targets,
    note: '自动触发点 = 周期自检调用本模块并落台账/告警；**执行**保留给人与卡（重部署含重启，走维护窗口口径）。',
  };
}

/**
 * 跑一次「四步处置」。默认 dry-run（`apply:false` ⇒ 只返回计划、零写入）。
 *
 * @param {{home?:string, apply?:boolean, now?:number, cooldownMs?:number,
 *          auditFn?:Function, alertFn?:Function, selfCheckFn?:Function, suggestFn?:Function}} [opts]
 * @returns {object} 处置结论（含四步各自状态 + 是否真写台账）
 */
export function runVersionDisposition(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const home = opts.home ?? dshHome();
  const apply = opts.apply === true;
  const cooldownMs = Number(opts.cooldownMs ?? DISPOSITION_COOLDOWN_MS);
  const scFn = typeof opts.selfCheckFn === 'function' ? opts.selfCheckFn : selfCheck;
  const auditFn = typeof opts.auditFn === 'function' ? opts.auditFn : appendAudit;
  const alertFn = typeof opts.alertFn === 'function' ? opts.alertFn : alert;
  const sugFn = typeof opts.suggestFn === 'function' ? opts.suggestFn : suggestDegradeOnMismatch;

  const sc = scFn({ home });
  const rows = sc.mismatchRows ?? [];
  const signature = mismatchSignature(rows);
  const at = new Date(now).toISOString();

  const out = {
    at, kind: 'version-disposition', version: VERSION_DISPOSITION_VERSION,
    source: 'tools/dsh-butler/lib/version-disposition.mjs',
    productVersion: PRODUCT_VERSION,
    home,
    mismatchCount: rows.length,
    signature,
    steps: {
      1: { name: '跳过', status: 'in-production', where: 'lib/version.mjs#checkComponent → action:"skip" + 各入口 if(!gate.run) return' },
      2: { name: '独立通道告警', status: 'in-production', where: 'lib/version.mjs#gateComponent → alert({source:"butler-version:<name>"})' },
      3: { name: '按宪法自修复', status: rows.length ? 'auto-triggered (request-only)' : 'no-object', plan: rows.length ? buildRepairPlan(rows) : null },
      4: { name: '降档联动', status: rows.length ? 'auto-triggered (request-only)' : 'no-object', request: null },
    },
    acted: false,
    apply,
    auditFile: null,
    alertWritten: false,
    reason: null,
  };

  if (!rows.length) {
    out.reason = '无版本不匹配 ⇒ 四步里 1、2、3、4 全无对象（正常态零噪音）';
    return out;
  }

  // 步骤 4 的**请求体**（suggestDegradeOnMismatch 是既有唯一判据源；本模块不重写判据）
  const sug = sugFn({ home });
  out.steps[4].request = {
    suggested: sug.suggested === true,
    level: sug.level ?? null,
    components: sug.components ?? [],
    why: sug.why ?? null,
    // ↓↓ 本模块**不执行**降档（改自治行为归操作者）—— 写成可断言字段，不做口头承诺
    autoExecute: false,
    executableBy: ['owner-panel', 'main-session'],
    gate: 'lib/version.mjs:278 既有设计选择「只给建议、不自动执行」；本版不新增自动降档通路（§11 不给自己扩权）',
  };

  // 冷却去重：读审计尾部找同签名（读失败 ⇒ 不拦，按"没冷却"处理但记 warning）
  try {
    const tail = tailAudit(200, { home }) ?? [];
    const prev = tail.filter((e) => e && e.kind === 'version-disposition' && e.signature === signature)
      .map((e) => ({ e, t: Date.parse(e.at ?? '') }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => b.t - a.t)[0];
    if (prev && (now - prev.t) < cooldownMs) {
      out.reason = `同签名（${signature}）在冷却窗内（上次 ${prev.e.at}，剩 ${Math.round((cooldownMs - (now - prev.t)) / 60_000)} 分钟）⇒ 只算不落`;
      return out;
    }
  } catch (e) {
    out.cooldownError = String(e?.message ?? e);
  }

  if (!apply) {
    out.reason = 'dry-run（缺省零写入；需要 { apply: true } 才落台账/告警）';
    return out;
  }

  // ── 落台账（步骤 3 / 4 的"自动触发"留痕；真源 = 审计链，已登记状态文件面，零新文件）──────
  const entry = {
    kind: 'version-disposition',
    version: VERSION_DISPOSITION_VERSION,
    signature,
    mismatchCount: rows.length,
    components: rows.map((r) => ({ name: r.name, entity: r.myVersion, registered: r.registered })),
    repairRequest: {
      autoTriggered: true, autoExecute: false,
      targets: out.steps[3].plan.targets.map((t) => ({ component: t.component, entity: t.entityVersion, registered: t.registeredVersion, candidates: t.candidates.map((c) => c.id) })),
    },
    degradeRequest: {
      autoTriggered: true, autoExecute: false,
      suggested: out.steps[4].request.suggested, level: out.steps[4].request.level, components: out.steps[4].request.components,
    },
  };
  const a = auditFn(entry, { home });
  out.auditFile = a?.file ?? null;
  out.acted = a?.ok === true;

  try {
    const r = alertFn({
      level: 'error',
      source: 'butler-version:disposition',
      message: `组件版本不匹配 ${rows.length} 项：已自动登记修复请求 + 降档请求（**均未自动执行**）——${rows.map((x) => `${x.name}(实体 ${x.myVersion}/登记 ${x.registered})`).join('；')}`,
      detail: { signature, repairRequest: entry.repairRequest, degradeRequest: entry.degradeRequest },
    }, { home, silent: true });
    out.alertWritten = r?.ok === true;
  } catch (e) {
    out.alertError = String(e?.message ?? e);
  }

  out.reason = `已落台账（${out.auditFile ?? '?'}）：修复请求 + 降档请求均已登记；**执行仍未做**（重部署须窗口 / 降档归操作者）`;
  return out;
}

/** 台账文件路径（供报告/测试引用；只读）。 */
export function dispositionAuditPath(opts = {}) {
  const p = butlerPaths(opts.home ?? dshHome());
  return p.auditDir;
}

/** 主档 / 报告用的一行摘要。 */
export function dispositionLine(dispo) {
  if (!dispo) return '版本不匹配处置：_（未跑）_';
  const s3 = dispo.steps?.[3]?.status ?? '?';
  const s4 = dispo.steps?.[4]?.status ?? '?';
  return `版本不匹配处置：不匹配 **${dispo.mismatchCount}** 项 · 步骤3 ${s3} · 步骤4 ${s4} · 落台账 ${dispo.acted ? '✅' : '—'}${dispo.reason ? `（${dispo.reason}）` : ''}`;
}

// ---------------------------------------------------------------- 自检（--self-check）
if (process.argv.includes('--self-check')) {
  const t = (name, cond, extra = '') => console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` · ${extra}` : ''}`);
  const clean = { mismatchRows: [], mismatchCount: 0, ok: true };
  const dirty = { mismatchRows: [{ name: 'butler-x', myVersion: '0.1.0', registered: '0.2.0', file: 'f' }], mismatchCount: 1, ok: false };
  const sugDirty = () => ({ suggested: true, level: 'degraded', why: 'fixture', components: ['butler-x'] });
  const r0 = runVersionDisposition({ selfCheckFn: () => clean, apply: false });
  t('无不匹配 ⇒ 四步无对象且零写入', r0.acted === false && r0.reason.includes('无版本不匹配'));
  const r1 = runVersionDisposition({ selfCheckFn: () => dirty, suggestFn: sugDirty, apply: false });
  t('有匹配但 dry-run ⇒ 不写台账', r1.acted === false && r1.steps[3].plan.targets.length === 1 && r1.steps[4].request.suggested === true);
  let wrote = 0; let alerted = 0;
  const r2 = runVersionDisposition({ selfCheckFn: () => dirty, suggestFn: sugDirty, apply: true, auditFn: () => { wrote++; return { ok: true, file: 'fixture' }; }, alertFn: () => { alerted++; return { ok: true }; } });
  t('apply ⇒ 台账 + 告警各一次', wrote === 1 && alerted === 1 && r2.acted === true);
  t('步骤 3 计划含两条候选且不自动执行', r2.steps[3].plan.autoTriggered === true && r2.steps[3].plan.autoExecute === false && r2.steps[3].plan.targets[0].candidates.length === 2);
  t('步骤 4 请求 autoExecute 恒 false', r2.steps[4].request.autoExecute === false);
  t('签名 = 组件名排序', mismatchSignature(dirty.mismatchRows) === 'butler-x');
  // dry-run 不得因"要不要落台账"去读审计 / 写任何东西：注入会爆的 auditFn，dry-run 下必须不被调用
  const r3 = runVersionDisposition({ selfCheckFn: () => dirty, apply: false, auditFn: () => { throw new Error('dry-run 不该写台账'); }, alertFn: () => { throw new Error('dry-run 不该告警'); } });
  t('dry-run 零写入（不碰台账/告警）', r3.acted === false && r3.reason.includes('dry-run'));
  t('步骤 3/4 只有 apply 时才置 acted', r1.acted === false && r2.acted === true);
}
