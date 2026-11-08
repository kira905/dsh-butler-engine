// dsh-butler / lib/handoff-clock.mjs —— 交接时钟门（§5.7 R3「对时校验」）
//
// 方案原文：合并前比对「本机墙钟 vs 远端最新提交时间」，偏差 > 120s → 账本与记忆库**拒绝合并** + 🔴 要求对时；
//          理由 = 久置不开机的机器时钟漂移会让旧版本静默"较新"胜出，是**无告警的数据丢失**。
//
// ⚠️ 口径必须写清，否则天天误报（第一版差点写成"本机现在 − 远端提交时间"——远端最后一次提交
//    可能是几小时前，那样"偏差"恒大于阈值、纯噪音）。
//
// ⚠️⚠️ **2026-09-15 13:16 生产实测：判据①的第一版口径（now − 本机自己最新提交的 git 时间，绝对值超 120s 即拒）
//    必然误拒** —— 现场 `selfSkewMs=316215`（>120s）→ A5b 整段 skipped；根因是 **Arrive 之前必然有一次
//    hot-collect 提交**（热采每 30 分钟一轮，本次 13:10:31 提交、Arrive 13:16 跑门 ⇒ 差值 316s 恒 > 120s），
//    即"正向大间隔"是**正常形态**、与"时钟漂移"无关。而本机真实钟经 gitee HTTP `Date` 实测 **偏差 0 秒**。
//    → 拍板 **A 档**（2026-09-15）：① 仅**负向偏差**（`now` 早于提交时刻且 |差| > 阈值，即本机钟**落后**/
//    被回拨）硬挡；正向大间隔只 🟡 告警；② **引入 HTTP Date 校准**：拿到权威时刻就按 |本机钟 − 权威时刻| > 阈值
//    硬挡（这才是 R3 想要的"本机钟可信度"判据）；取不到 ⇒ 回退 A 档（fail-open）。③ 对端 `peerSkewMs` 维持
//    |x| > 阈值硬挡（对端交接单 `finishedAt` vs 它被提交进仓的 `%ct`，与热采无关，没有正向误报问题）。
//    R3 保护据此保住：负向（本机钟慢/被回拨）+ 权威校准（任意方向大偏差）+ 对端三条都还在，被删掉的只有
//    "本机自己正常提交产生的大正间隔"这一条假阳性来源。
//
// 三条可比对的时间戳：
//    ① 本机自身：墙钟现在 vs **本机自己最新提交**的 git 时间（同机比较；A 档只挡负向）；
//    ①b 权威校准（新增·可选注入）：本机墙钟 vs **HTTP `Date` 响应头的权威时刻**（注入式，取不到则 null）；
//    ② 对端：仓内 `dsh/butler-handoff/<peer>.json` 的 `finishedAt`（**对端的墙钟**）
//       vs 该文件被提交进仓的时刻 `%ct`（**git 记录**）——两者的差才是对端时钟相对实际时刻的漂移。
//    取不到（对端没交接单 / 旧版无 finishedAt）→ `null`：**不判、不告警**。
//
// 本模块只做**判定**（纯函数 + 注入式 git / 取时刻），IO 由调用方（handoff.mjs）用既有 git() 封装提供 ——
// 这样单测可以不碰 git、不碰网络，直接喂数据，判定口径与生产**同源**（单一真相）。
export const CLOCK_SKEW_VERSION = '0.2.0';

/** 合并时钟门阈值（§5.7 R3）：偏差 > 120s → 拒绝合并（真正的拒绝动作在 H2 的合并器里接）。 */
export const CLOCK_SKEW_LIMIT_MS = 120_000;

/**
 * @param {{
 *   now?:number, limitMs?:number, host:string,
 *   gitLog:(dir:string, args:string[])=>string|null,      // 返回 stdout（trim 后）或 null
 *   repos:{name:string, dir:string}[],                     // 本机参与比较的仓
 *   readPeerRecord:(host:string)=>object|null,             // 读仓内对端交接单（返回 {host, record} 形态）
 *   fetchTimeMs?:()=>number|null                           // 权威时刻取数（HTTP Date，毫秒 epoch）；取不到/抛错 → null
 * }} input
 * @returns {{selfSkewMs:number|null, peerSkewMs:number|null, realSkewMs:number|null, peerHost:string|null,
 *            limitMs:number, ok:boolean|null, basis:'http-date'|'negative-only',
 *            skewDirection:'ahead'|'behind'|'ok'|null, warnings:string[], reason:string}}
 */
export function computeClockSkew(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const rawLimit = input.limitMs ?? CLOCK_SKEW_LIMIT_MS;
  // 阈值卫生：非有限或负数 → 回退默认（0 合法：表示"任何非零偏差都算超阈值"）
  const limitMs = (Number.isFinite(rawLimit) && rawLimit >= 0) ? rawLimit : CLOCK_SKEW_LIMIT_MS;
  const gitLog = input.gitLog;
  const host = String(input.host ?? '');
  const warnings = [];

  // ① 本机：墙钟现在 vs 本机最新提交时间
  let selfSkewMs = null;
  for (const r of input.repos ?? []) {
    if (!r?.dir) continue;
    const out = gitLog(r.dir, ['log', '-1', '--format=%ct', 'HEAD']);
    const sec = Number(String(out ?? '').trim());
    if (Number.isFinite(sec) && sec > 0) selfSkewMs = now - sec * 1000;
  }

  // ①b 权威时刻（HTTP Date 校准）：注入式；**一次调用只取一次**，取不到/抛错一律当 null（绝不抛给调用方）
  let realSkewMs = null;
  if (typeof input.fetchTimeMs === 'function') {
    let authorityMs = null;
    try {
      const v = input.fetchTimeMs();
      authorityMs = Number.isFinite(v) ? Number(v) : null;
    } catch { authorityMs = null; }
    if (authorityMs !== null && authorityMs > 0) realSkewMs = now - authorityMs;
  }

  // ② 对端：交接单 finishedAt（对端墙钟）vs 它被提交进仓的时间
  let peerSkewMs = null;
  let peerHost = null;
  const peer = input.readPeerRecord ? input.readPeerRecord(host) : null;
  if (peer?.record && peer?.repoDir && peer?.repoPath) {
    const finished = Date.parse(String(peer.record.finishedAt ?? ''));
    const ct = gitLog(peer.repoDir, ['log', '-1', '--format=%ct', 'origin/master', '--', peer.repoPath]);
    const ctSec = Number(String(ct ?? '').trim());
    if (Number.isFinite(finished) && Number.isFinite(ctSec) && ctSec > 0) {
      peerSkewMs = finished - ctSec * 1000;
      peerHost = peer.host ?? null;
    }
  }

  // ---- 判定（顺序即优先级，2026-09-15 A 档）
  const over = [];
  const basis = realSkewMs !== null ? 'http-date' : 'negative-only';
  if (realSkewMs !== null) {
    // ① 有权威时刻 → 以它为准，任意方向 |偏差| > 阈值都挡（这才是 R3 的真判据）
    if (Math.abs(realSkewMs) > limitMs) over.push(`本机（vs 权威时刻 ${s(realSkewMs)}）`);
  } else if (selfSkewMs !== null) {
    // ② 无权威时刻 → 回退 A 档：只挡**负向**（现在早于提交时刻 = 本机钟落后 / 被回拨）；
    //    正向大间隔（热采刚提交、久未提交等）只告警不挡 —— 见文件头 13:16 生产实测。
    if (selfSkewMs < -limitMs) over.push(`本机（负向 ${s(selfSkewMs)}，本机钟落后于自身提交时刻）`);
    else if (selfSkewMs > limitMs) warnings.push(`本机最新提交距现在 ${s(selfSkewMs)}（>阈值 ${s(limitMs)}）—— 正向间隔属正常形态（如热采刚提交过），按 A 档不挡、仅告警`);
  }
  // ③ 对端：与热采无关（对端交接单时间戳 vs 它被提交进仓的时刻），维持双向硬挡
  if (peerSkewMs !== null && Math.abs(peerSkewMs) > limitMs) over.push(`对端 ${peerHost ?? '-'}（${s(peerSkewMs)}）`);

  const have = realSkewMs !== null || selfSkewMs !== null || peerSkewMs !== null;
  const ok = have ? over.length === 0 : null;

  const dirBase = realSkewMs !== null ? realSkewMs : selfSkewMs;
  const skewDirection = dirBase === null ? null : (dirBase > 0 ? 'ahead' : dirBase < 0 ? 'behind' : 'ok');

  const s0 = (x) => (x === null ? '-' : s(x));
  const reason = ok === null
    ? '取不到可比时间戳（本机无仓 / 对端无交接单 / 无权威时刻）→ 不判（不告警）'
    : (ok
      ? `对时正常（判据 ${basis}）：本机 ${s0(selfSkewMs)} / 权威 ${s0(realSkewMs)} / 对端 ${peerHost ?? '-'} ${s0(peerSkewMs)}（阈值 ${s(limitMs)}）`
      : `偏差超阈值：${over.join('；')}（>${s(limitMs)}）→ 合并前要求人工对时`);
  // 注：warnings 只回给调用方（handoff.mjs 记 🟡 告警），本模块不产生 IO/告警副作用。
  return { selfSkewMs, peerSkewMs, realSkewMs, peerHost, limitMs, ok, basis, skewDirection, warnings, reason };
}

/** 毫秒 → 人类可读（秒，带符号；null → '-'）。 */
function s(x) {
  if (x === null || x === undefined) return '-';
  return `${Math.round(x / 1000)}s`;
}
