// dsh-butler / lib/handoff-collect-verdict.mjs —— 采集失败归因判定（纯函数，可单测）
//
// 【2026-10-14 · 拍板「R5-Q2」· 真源 = 内部交付报告 §8-R6】
//
// 背景：`ps1()`（handoff.mjs）自 2026-10-14 起已把子进程输出**重定向到日志文件**（§8-R1，治 M-2 根因），
//   但「超时」本身在编排层仍只有一种表达（`timedOut: true`）——**无法自动区分**两种截然不同的形态：
//     · 形态甲（本库叫 **M-2 家族**）：「活其实已经干完了，调用却不返回」（长命孙进程持有 stdout 句柄）
//       ⇒ 白等到 timeout，是**空转**；产物已落、提交已产生。
//     · 形态乙：目标脚本**真的没跑完**（如 `git add` 逐文件加密 + 本机 EDR 挂钩的累计开销 > 预算）
//       ⇒ 是**预算不足/真慢**。
//   2026-10-14 那次 600s 超时，为了判清到底是甲还是乙，只能靠外围物证（采集台账 mtime / index 状态 /
//   reflog / fsck / pack 对象）人工反推，成本极高（见 R5 报告 §3/§4）。本模块把这个判定**自动化**。
//
// 判据（只读、零副作用）：采集前后各取一次该仓的 HEAD ——
//   · 超时 && HEAD 已前进 ⇒ `timeout-but-done`      （活干完了 = 形态甲/M-2）
//   · 超时 && HEAD 未变   ⇒ `timeout-incomplete`    （真没干完 = 形态乙）
//   · 非超时失败          ⇒ `rc-failed`             （脚本自己报错退出；本函数不判形态）
//   · 超时但取不到 HEAD   ⇒ `timeout-unknown`       （仓不存在/git 失败 ⇒ **不猜**，如实记未知）
//
// ⚠️ 边界（写死，防误读）：
//   ① 本模块**只做判定、不做 IO**（两次 HEAD 由调用方注入）⇒ 全部边界可被单测覆盖；
//   ② `timeout-but-done` **不等于"没有问题"**：它只说明「该仓的提交已产生」，采集本身仍按失败处理
//      （仍记 warn + deferred）——因为超时被杀时脚本的后续步骤（如 pull/推送）确实没跑；
//   ③ 判定**不改变 fail-open 语义**：无论哪种形态都不阻断关机。
//
// 单测：`tools/dsh-butler/_test/test-handoff-collect-verdict.mjs`（夹具直测，不碰生产）。

/** 形态常量（调用方与测试共用，避免字符串各写一份）。 */
export const COLLECT_VERDICT = {
  /** 非超时失败：脚本自己以非零码退出（本模块不判它是 M-2 还是真错）。 */
  RC_FAILED: 'rc-failed',
  /** 超时但它其实已经干完了（HEAD 已前进）= 本库 M-2 家族形态。 */
  TIMEOUT_BUT_DONE: 'timeout-but-done',
  /** 超时且 HEAD 未变 = 真没干完（预算不足 / 真慢）。 */
  TIMEOUT_INCOMPLETE: 'timeout-incomplete',
  /** 超时但取不到前后 HEAD（仓不存在 / git 调用失败）⇒ 不猜。 */
  TIMEOUT_UNKNOWN: 'timeout-unknown',
};

const ALL = new Set(Object.values(COLLECT_VERDICT));

function normHead(h) {
  if (typeof h !== 'string') return null;
  const t = h.trim().toLowerCase();
  return t ? t : null;
}

/**
 * 采集失败归因（纯函数）。
 * @param {{timedOut?:unknown, headBefore?:string|null, headAfter?:string|null}} input
 * @returns {'rc-failed'|'timeout-but-done'|'timeout-incomplete'|'timeout-unknown'}
 */
export function classifyCollectFailure(input = {}) {
  const timedOut = input.timedOut === true;
  if (!timedOut) return COLLECT_VERDICT.RC_FAILED;
  const b = normHead(input.headBefore);
  const a = normHead(input.headAfter);
  if (!b || !a) return COLLECT_VERDICT.TIMEOUT_UNKNOWN;
  return b === a ? COLLECT_VERDICT.TIMEOUT_INCOMPLETE : COLLECT_VERDICT.TIMEOUT_BUT_DONE;
}

/** 形态 → 一句人话（进日志 / 交接单 deferred 与 alerts 文案，口径统一在这里）。 */
export function describeVerdict(verdict) {
  switch (verdict) {
    case COLLECT_VERDICT.TIMEOUT_BUT_DONE:
      return '（超时但该仓提交已产生 = 空转形态/M-2：活干完了、调用没返回）';
    case COLLECT_VERDICT.TIMEOUT_INCOMPLETE:
      return '（超时且该仓提交未产生 = 预算不足/真慢）';
    case COLLECT_VERDICT.TIMEOUT_UNKNOWN:
      return '（超时，但前后 HEAD 取不到 ⇒ 形态未知，未做猜测）';
    case COLLECT_VERDICT.RC_FAILED:
      return '（非超时失败：脚本自身非零退出）';
    default:
      return '';
  }
}

/** 是否是「已干完」那一支（调用方可能要据此升级告警级别）。 */
export function isTimeoutButDone(verdict) {
  return verdict === COLLECT_VERDICT.TIMEOUT_BUT_DONE;
}

/** 合法形态值集合（测试/面板做白名单校验用）。 */
export function isKnownVerdict(v) {
  return ALL.has(v);
}

export default { classifyCollectFailure, describeVerdict, COLLECT_VERDICT, isTimeoutButDone, isKnownVerdict };
