#!/usr/bin/env node
/**
 * ============================================================================
 *  failure-classify.mjs —— H-9「失败五类 → 自动变教训 → 接技能草稿管线」
 *  ----------------------------------------------------------------------------
 *  口径真源（逐条现查，禁凭印象）：
 *    · `docs/` §1.6 H-9 行 + 「拍板注」
 *      （2026-10-22 17:28 主人原话「就这样吧」：五类 = 卡 failed / 卡被 reject /
 *        环境性（对齐 benignExitCodes ⇒ 不计失败）/ 缺件·缺目录 / 事故登记；**不细分**）
 *    · `docs/` H-9 行
 *    · 草稿管线口径 = 卡 `3d2e430f` 交付的 `docs/`
 *      （frontmatter 只两键 / 四段 / 每行带来源 / 素材不足不生成 / 硬闸拒写技能目录）
 *
 *  【只读承诺】零写库、零改配置、零重启；**不写 `%USERPROFILE%\.dsh` 下任何状态文件**；
 *    不碰 memory.db / persona / 技能库；看板只发一条 `GET /api/task-board/state`
 *    （**不带头** = Host 的 scope=all，含归档卡）。
 *    唯一的写面 = `--drafts <目录> --apply` 生成草稿（硬闸只许落在 `<butler-root>\_archive\` 或
 *    `os.tmpdir()` 下；任何落在技能目录的写入直接拒跑）。
 *
 *  【五类判据（互斥 · 证据优先序）】
 *    ③ 环境性      ← ①退出码 ∈ 该 job 声明的 benignExitCodes（码表见 ENV_EXIT_TABLE，逐条带行号）
 *                     ②证据里出现网络/通道/资源占用/外部阻塞类错误（TRANSPORT / fetch failed /
 *                       ECONN* / ETIMEDOUT / EBUSY / 对端不可达 / 外部阻塞）
 *    ④ 缺件·缺目录 ← 证据里出现 ENOENT / 找不到路径 / 文件不存在 / 目录不存在 / 缺件
 *    ⑤ 事故登记    ← `docs/`（文件名日期落在窗口内）
 *    ② 卡被 reject ← description 里的 `[打回 <时间>] <备注>` 段
 *    ① 卡 failed   ← executions[].result === 'failed'
 *    ⚠️ 前两类（③④）压过后三轮：一条「因缺件被打回」的卡算 ④，不算 ②；
 *       一条「因外部阻塞被打回」的算 ③，不算 ② —— 这样"真失败"才不会被环境噪音注水。
 *
 *  【教训草稿纪律】模板填空「X 步 ⇒ 撞上 Y ⇒ 下次先 Z」；**Y 必须是证据原文摘录**；
 *    Z 只允许取「证据里真出现的补做要求」或本器具按类目预置的**流程动作**（不是编造事实）；
 *    填不满 ⇒ 写 `证据不足，不定教训`（并在草稿索引里单列"只登记不生成"）。
 *
 *  用法：
 *    node <butler-root>\tools\dsh-butler\failure-classify.mjs --days 30 [--json] [--out <file>]
 *    node ... --days 30 --drafts <butler-root>\_archive\v3face-h9-drafts-<日期> --apply
 *    node ... --help
 *    夹具/隔离（全部脱开生产）：
 *    node ... --session-roots <目录>[,...] --board-file <json> --docs-dir <目录> \
 *             --tickd-state <json> --alert-file <path> --report-dir <目录> --until <ISO>
 *
 *  退出码：0 正常 / 2 用法错或输入读不到
 * ============================================================================
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { rankSessionFilesInDir, isSessionFileName } from '../lib/session-file-name.mjs';
import { scanZstdFrames } from '../lib/zstd-frames.mjs';
import { createLedgerApi } from './lib/ledger-api.mjs';
import { resolveDshHome } from '../lib/dsh-home.mjs';
import { resultIsError, defaultSessionRoots } from './process-score.mjs';

export const CLASSIFY_VERSION = '1.0.0';
export const DEFINITION_VERSION = '2026-10-23-拍板定稿（五类 · 不细分）';

const DAY = 86_400_000;
const DSH = process.env.BUTLER_ROOT || path.join(os.homedir(), 'dsh');
const SELF_REL = 'tools\\dsh-butler\\failure-classify.mjs';

// ---------------------------------------------------------------------------
// 一、五类定义（器具常量 · 报告各抄一份）
// ---------------------------------------------------------------------------
export const CLASSES = Object.freeze([
  { id: 'card-failed', label: '① 卡 failed', countsAsFailure: true },
  { id: 'card-rejected', label: '② 卡被 reject', countsAsFailure: true },
  { id: 'environmental', label: '③ 环境性（不计失败）', countsAsFailure: false },
  { id: 'missing-file', label: '④ 缺件/缺目录', countsAsFailure: true },
  { id: 'incident', label: '⑤ 事故登记', countsAsFailure: true },
]);

const CLASS_LABEL = Object.fromEntries(CLASSES.map((c) => [c.id, c.label]));

// ---------------------------------------------------------------------------
// 二、环境性码表 —— **benignExitCodes 逐条抄录**（真源见每行 file:line）
//    ⚠️ 本表是抄录，不是唯一真源：`_test\test-failure-classify.mjs` 有一条
//       「源码漂移断言」—— 拿 `butler-tickd.mjs` 源码里的声明逐条比对，任何一条对不上就红。
// ---------------------------------------------------------------------------
export const ENV_EXIT_TABLE = Object.freeze([
  // ⚠️ 订正注（2026-10-23 · 主线「操作者<mainline>」卡① 执行会话）：整表**行号已全部重算**（原 12 条行号
  //   全部过期 —— `_test\test-failure-classify.mjs` ③ 的「行号也要对得上」12 条全红，属**既有红**，
  //   改动前对照 = 用新 job 加入前的源码行号复算同样红）。
  //   同轮补齐两条漏登记：`memory-hit-collect`（2026-10-23 加的 job，声明了 [3] 但表里没有）、
  //   `preset-drift`（本卡新增，声明 [4]）。
  // ⚠️ 订正注（2026-10-29 · N3 卡「家人日程提醒一期」执行会话）：上一条「现 14 条」**已过期**。
  //   实读源码 **19 条**声明、本表只有 14 条 ⇒ 缺 5 条（`band-sentinel` / `memory-sync-leaf` /
  //   `relay-keepalive` / `text-sync-direct` / `notify-docsync`）、且 12 条行号全部过期
  //   （2026-10-23 之后又加了多个 job，行号整体后移）。两条既有红因此常红：
  //   `_test\test-failure-classify.mjs` ③「条数相等」「逐条一致（码+行号）」、以及
  //   `_test\test-tickd-benign-exit.mjs`「声明让路退出码的 job 都在白名单内」。
  //   本卡同批：**补齐 5 条 + 全部行号按源码重算 + 新增 `family-remind`（声明 [3]）**
  //   ⇒ 现「源码声明条数 == 表条数 == 20」。行号**逐条等于该 job 声明行**（`benignExitCodes:` 所在行），
  //   断言口径见 `test-failure-classify.mjs` ③（`srcLines[row.line-1]` 必须含 `benignExitCodes`）。
  //   🔴 维护口诀：`butler-tickd.mjs` 里**加/删行**都会把带行号的 job 往后推 ⇒ 必须同批重算本表，
  //   否则上面三条断言必红（这就是本次既有红的成因）。
  //   【2026-10-29 · 卡「V3功能面·tickd 三件收口」】**同批重算过一次**（照上面那句口诀办）：
  //     `butler-tickd.mjs` 新增 job `tickd-inspect-15m`（15 分钟档，插在 `text-sync-direct` 之后）
  //     + `text-sync-direct` 的 args 注释加了 D5 订正段（+10 行）⇒ 两个带行号的 job 后移：
  //     `text-sync-direct` 1336 → **1346**、`notify-docsync` 1378 → **1437**（其余 18 条行号不动）。
  //     ⚠️ 新 job **刻意不登记本表**：它**没声明** `benignExitCodes`（rc=1/2 都算真异常 ⇒ 不许当让路），
  //       本表只收"有让路码"的 job —— 登记了等于给"永远绿"开口子。
  //     复跑 `_test\test-failure-classify.mjs`：改前 33 绿 / 1 红，改后 **34 绿 / 0 红**。
  //   ⚠️ 订正注（2026-11-04 · 卡 **V31-039**「坑库真源缺失闸」执行会话）：**全表行号按源码重算 + 补登 3 条**
  //     ⇒ 现「源码声明条数 == 表条数 == **24**」（上一条「20」已过期）。三件事同一批做完：
  //     ① 本卡新增 `pitfall`（codes `[5]`，拒渲染码；`benignExitCodes` 与 `args` 同行 ⇒ 行号 310，零行位移）；
  //     ② **补登 3 条漏登记**：`mood-broadcast`(262) / `router-guard`(287) / `memory-sync-life`(841) —— 它们
  //        都声明了 `benignExitCodes:[3]` 却没进表（这是本表"手抄副本"病根的第 N 次复发，见上面几条历史）；
  //     ③ **17 条行号过期全部重算**（2026-10-29 之后 `butler-tickd.mjs` 又加过 job，行号整体后移）。
  //     ⚠️ 改前**既有红**（不是本卡造成的，同一套判据跑本卡改前副本 `_archive\v31-039-*\*.bak` 逐值相同）：
  //        缺口 3 条 / 行号过期 17 条；改后两套夹具（`test-failure-classify` ③ 与 `test-tickd-benign-exit` ②）
  //        转绿。判据复跑命令与读数见交付报告 `docs/` §五。
  //     ⚠️ 补登 3 条只改**分类口径**、不改任何 job 行为：tickd 侧早就按 benign 记 `deferred`（`isRealFailureStatus`
  //        不含 deferred）⇒ 这些 job 根本不会产出"失败事件"，本表对它们只在历史/边角事件上生效。
  { job: 'family-remind', codes: [3], label: '未初始化（events/relations 缺失 / 数据目录不可写）⇒ 本轮让路（开闸未就绪 4 不在此列）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 213 },
  { job: 'memory-hit-collect', codes: [3], label: '日志缺失 / hits 目录不可写 / 上轮未释放 ⇒ 本轮让路', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 239 },
  // 【V31-039 · 2026-11-04】`pitfall`（P4 坑库 · 30 分钟档）：让路码 = **5**（不是 3）——
  //   语义是「真源不可用 ⇒ 拒渲染」，与"对端不可达 / 锁被占 / 冷盘不在"那类让路**刻意分开**：
  //   退出码本身要当判据用（`lastExitCode===5` 一眼看出是这道闸，不是网络问题）。
  //   码表条数 20 → 21；本行行号 = 声明行（`benignExitCodes` 与 `args` 同一行，加行会让其余 18 条行号后移）。
  { job: 'mood-broadcast', codes: [3], label: 'state 读不到/读不懂（心情插件未初始化）⇒ 本轮让路；exit 9 污染 state 不在此列', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 262 },
  { job: 'router-guard', codes: [3], label: 'workspace.json 与 prefs 两处都读不到（环境未就绪）⇒ 本轮让路', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 287 },
  { job: 'pitfall', codes: [5], label: '坑库真源缺失/读不出/0 条目 ⇒ 拒渲染（不写空壳、已告警）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 310 },
  { job: 'secretary-drift', codes: [3], label: '对端不可达（隧道关 / 对端离线）⇒ 本轮让路', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 411 },
  { job: 'preset-drift', codes: [3], label: '对端不可达（隧道关 / 对端离线）⇒ 本轮让路；真漂移 exit 1 照红', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 432 },
  { job: 'band-sentinel', codes: [3, 4], label: '号段异常(3) / 取数失败 fail-closed(4) ⇒ 有结论地跑完，不记失败', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 478 },
  { job: 'coldbackup', codes: [3], label: '冷盘（H:）不可达 ⇒ 本轮让路', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 503 },
  { job: 'hot', codes: [3], label: '交接锁被占 / 双开嫌疑 / 推前安全门拦截', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 528 },
  { job: 'text-sync', codes: [3], label: '锁被占 / 工作树脏 / 远端分叉 / 通道不通 / 超集挡推', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 548 },
  { job: 'memory-snapshot', codes: [3], label: '交接锁被占 / 仓1 未 unlock / 推前安全门拦截', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 563 },
  { job: 'session-mirror', codes: [3], label: '对端（<peer>）不可达 → 本轮让路', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 595 },
  { job: 'mirror-audit', codes: [3], label: '对端（<peer>）不可达 → 本轮让路', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 618 },
  { job: 'arrive-b', codes: [3], label: 'Host 未就绪 / 双开嫌疑 / 无对端快照 / 交接锁被占', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 711 },
  { job: 'memory-vectors', codes: [3], label: '宿主未声明 / 记忆库不存在 / 引擎入口缺失 ⇒ 安全跳过（不建库、不报红）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 765 },
  { job: 'memory-sync', codes: [3], label: '对端不可达 / 角色未声明 / inbox 无快照 ⇒ 安全跳过（家网恢复自动收敛）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 798 },
  { job: 'memory-sync-life', codes: [3], label: '对端（<peer> 生活实例）不可达/无通道 ⇒ 本轮让路（她那边开机/进网后自动收敛）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 841 },
  { job: 'memory-sync-leaf', codes: [3], label: '对端不可达 ⇒ 安全跳过（对端进网后自动收敛）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 866 },
  { job: 'secretary-sync', codes: [3, 6], label: '对端不可达 / 上一轮仍在跑 ⇒ 本轮让路', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 891 },
  { job: 'upgrade-watch', codes: [3], label: '本地基线缺失（未跑过采集/无 packages 基线）⇒ 安全跳过（不计 failures）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 1184 },
  { job: 'relay-keepalive', codes: [3], label: '端到端探针外部阻塞（<peer> 关机 / 不在家网 / VPS 转发断）⇒ 本轮让路', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 1419 },
  { job: 'text-sync-direct', codes: [3], label: '通道不通 / 对端不可达 / 锁被占 ⇒ 本轮让路（物理常态）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 1466 },
  { job: 'notify-docsync', codes: [3], label: 'tickd state 读不到或坏 ⇒ 本轮不判定（让路）', file: 'tools\\dsh-butler\\butler-tickd.mjs', line: 1557 },
]);

export function benignCodesFor(jobId) {
  const row = ENV_EXIT_TABLE.find((r) => r.job === jobId);
  return row ? row.codes : null;
}

// ---------------------------------------------------------------------------
// 三、证据词表（每条都给"为什么它算这一类"的一句话）
// ---------------------------------------------------------------------------
export const ENV_PATTERNS = Object.freeze([
  { re: /DeepSeek Messages transport failed|"?code"?\s*:\s*"TRANSPORT"/i, kind: '网络传输失败（TRANSPORT）' },
  { re: /fetch failed/i, kind: '网络请求失败（fetch failed）' },
  { re: /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i, kind: '网络错误码（ETIMEDOUT/ECONN*）' },
  { re: /EBUSY: resource busy or locked/i, kind: '文件被占用（并发写同一文件）' },
  { re: /对端不可达|隧道未开|隧道关|kex reset|Connection refused/i, kind: '对端/隧道不可达' },
  { re: /外部阻塞/, kind: '证据明写"外部阻塞"' },
  { re: /DSH restart or killed daemon/i, kind: 'DSH 重启打断（环境语义）' },
  { re: /killed daemon|daemon killed/i, kind: '守护进程被杀（环境语义）' },
]);

export const MISSING_PATTERNS = Object.freeze([
  { re: /ENOENT/i, kind: 'ENOENT（路径不存在）' },
  { re: /找不到路径|系统找不到指定的文件/, kind: '系统报"找不到路径"' },
  { re: /No such file or directory/i, kind: 'No such file or directory' },
  { re: /does not exist|not exist/i, kind: 'does not exist' },
  { re: /文件不存在|目录不存在|交付报告不存在/, kind: '文件/目录/交付物不存在' },
  { re: /缺件|缺目录|目录没建/, kind: '缺件 / 缺目录' },
]);

function firstMatch(patterns, text) {
  if (!text) return null;
  for (const p of patterns) {
    const m = String(text).match(p.re);
    if (m) return { kind: p.kind, hit: m[0] };
  }
  return null;
}

export function clip(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// 四、分类（纯函数 · 夹具直接调这个）
// ---------------------------------------------------------------------------
/**
 * 判一条事件属于哪一类。
 * @param {{text:string, kind:'execution'|'reject'|'incident', exitCode?:number|null, jobId?:string|null}} ev
 * @returns {{classId:string, marker:string, markerBasis:string}}
 */
export function classifyOne(ev) {
  const text = String(ev.text ?? '');
  // ⑤ 事故登记：只从 docs 进（文档正文里出现"缺件/网络"等字样**不得**改判）
  if (ev.kind === 'incident') {
    return { classId: 'incident', marker: 'docs/（窗口内）', markerBasis: 'doc-file' };
  }
  // ③-a 退出码 ∈ 该 job 声明的 benignExitCodes
  if (Number.isInteger(ev.exitCode) && ev.jobId) {
    const codes = benignCodesFor(ev.jobId);
    if (codes && codes.includes(ev.exitCode)) {
      return { classId: 'environmental', marker: `exit ${ev.exitCode} ∈ ${ev.jobId}.benignExitCodes=[${codes.join(',')}]`, markerBasis: 'benign-table' };
    }
  }
  // ④ 缺件 / 缺目录（压过环境性：缺件本身就是可修的画面，不该混进"让路"）
  const miss = firstMatch(MISSING_PATTERNS, text);
  if (miss) return { classId: 'missing-file', marker: miss.kind, markerBasis: 'text-pattern' };
  // ③-b 环境性文本证据
  const env = firstMatch(ENV_PATTERNS, text);
  if (env) return { classId: 'environmental', marker: env.kind, markerBasis: 'text-pattern' };
  // ② / ① 按来源定型
  if (ev.kind === 'reject') return { classId: 'card-rejected', marker: 'description 的 [打回 …] 段', markerBasis: 'reject-note' };
  return { classId: 'card-failed', marker: 'executions[].result=failed', markerBasis: 'execution-result' };
}

// ---------------------------------------------------------------------------
// 五、会话日志索引与尾部证据（复用 process-score 的解码器）
// ---------------------------------------------------------------------------
export function indexSessionDirs(roots) {
  const map = new Map();
  const walk = (d, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    let hasFile = false;
    for (const e of ents) if (e.isFile() && isSessionFileName(e.name)) hasFile = true;
    if (hasFile) map.set(path.basename(d).toLowerCase(), d);
    for (const e of ents) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return map;
}

export function findSessionDir(index, sessionId) {
  if (!sessionId) return null;
  const key = String(sessionId).toLowerCase();
  for (const [k, v] of index) if (k === key || k.includes(key) || key.includes(k)) return v;
  return null;
}

/**
 * 解一份会话日志的**全量事件**（多帧 zstd 逐帧解；坏帧丢弃，绝不猜）。
 * ⚠️ 为什么不用 `process-score.mjs#decodeSessionEvents`：那个解码器只留
 *   `tool/call` / `tool/result` / `type:session` 三类行（它算过程四数用），
 *   **`turn/end` 会被过滤掉** —— 而失败归因最需要的正是 turn/end 的 error。
 *   共用件仍复用：`scanZstdFrames`（分帧）、`rankSessionFilesInDir`（选代际）、
 *   `resultIsError`（两世代错误形状）、`defaultSessionRoots`（根目录口径）。
 */
export function decodeSessionFull(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  const events = [];
  let badFrames = 0;
  for (const f of frames) {
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'); } catch { badFrames++; continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o && typeof o.type === 'string') events.push(o);
    }
  }
  return { events, badFrames, frames: frames.length };
}

function messageText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (typeof msg.text === 'string') return msg.text;
  if (Array.isArray(msg.content)) {
    const parts = [];
    for (const b of msg.content) {
      if (!b) continue;
      if (typeof b.text === 'string') parts.push(b.text);
      else if (Array.isArray(b.content)) for (const c of b.content) if (c && typeof c.text === 'string') parts.push(c.text);
    }
    if (parts.length) return parts.join(' ');
  }
  try { return JSON.stringify(msg); } catch { return ''; }
}

/**
 * 用一个会话目录给出「尾部证据」。
 * @returns {{found:boolean, file?:string, events?:number, toolErrors?:number,
 *            turnEndError?:string, lastToolError?:string, cwd?:string}}
 */
export function sessionEvidence(dir) {
  if (!dir) return { found: false };
  const files = rankSessionFilesInDir(dir);
  if (!files.length) return { found: false };
  let best = null;
  for (const f of files) {
    const dec = decodeSessionFull(f.file);
    if (!best || dec.events.length > best.dec.events.length) best = { f, dec };
  }
  if (!best || !best.dec.events.length) return { found: false };
  let turnEndError = null;
  let lastToolError = null;
  let toolErrors = 0;
  let cwd = null;
  for (const e of best.dec.events) {
    if (e.type === 'session') cwd = e.data?.cwd ?? cwd;
    if (e.type === 'tool/result') {
      const msg = e.data?.message;
      if (resultIsError(msg)) {
        toolErrors += 1;
        lastToolError = clip(messageText(msg), 160);
      }
    }
    if (e.type === 'turn/end') {
      const err = e.data?.reason?.error;
      if (err) turnEndError = `${err.message ?? ''}${err.code ? ` (${err.code})` : ''}`.trim();
      else if (e.data?.reason?.kind) turnEndError = `turn/end reason=${e.data.reason.kind}`;
    }
  }
  return {
    found: true,
    file: path.basename(best.f.file),
    bytes: best.f.bytes,
    events: best.dec.events.length,
    toolErrors,
    turnEndError: turnEndError ? clip(turnEndError, 120) : null,
    lastToolError: lastToolError ? clip(lastToolError, 120) : null,
    cwd,
  };
}

// ---------------------------------------------------------------------------
// 六、看板 / 事故 两类事件的采集
// ---------------------------------------------------------------------------
/** 账本里的行号（证据要能点到源文件）。找不到返回 null。 */
export function lineOf(raw, needle) {
  if (!raw || !needle) return null;
  const idx = raw.indexOf(needle);
  if (idx < 0) return null;
  let line = 1;
  for (let i = 0; i < idx; i++) if (raw.charCodeAt(i) === 10) line++;
  return line;
}

/** 解析 description 里的 `[打回 <时间>] <备注>` 段（Host 侧追加形态，见 host-ledger.ts:730）。 */
export function parseRejectNotes(description) {
  const text = String(description ?? '');
  const out = [];
  const re = /\[打回 ([^\]]+)\]\s*([\s\S]*?)(?=\n\n\[打回 |$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const stamp = m[1].trim();
    const note = m[2].trim();
    out.push({ stamp, note, atMs: parseZhDate(stamp) });
  }
  return out;
}

export function parseZhDate(s) {
  const m = String(s).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/**
 * 看板事件：失败的执行 + 打回备注（窗口内）。
 * @param {any[]} tasks
 */
export function collectBoardEvents(tasks, { sinceMs, untilMs, ledgerRaw = null } = {}) {
  const events = [];
  const inWin = (t) => Number.isFinite(t) && t >= sinceMs && t <= untilMs;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const execs = Array.isArray(task.executions) ? task.executions : [];
    execs.forEach((e, i) => {
      if (!e || e.result !== 'failed') return;
      const at = Number.isFinite(e.startedAt) ? e.startedAt : null;
      if (!inWin(at)) return;
      events.push({
        kind: 'execution',
        cardId: task.id,
        cardTitle: task.title ?? '',
        cardStatus: task.status ?? '',
        sessionId: e.sessionId ?? null,
        atMs: at,
        errorText: e.error ?? '',
        execIndex: i,
        execId: e.id ?? null,
        ledgerLine: ledgerRaw && e.id ? lineOf(ledgerRaw, `"id": "${e.id}"`) : null,
      });
    });
    const notes = parseRejectNotes(task.description);
    for (const n of notes) {
      if (!inWin(n.atMs)) continue;
      events.push({
        kind: 'reject',
        cardId: task.id,
        cardTitle: task.title ?? '',
        cardStatus: task.status ?? '',
        sessionId: null,
        atMs: n.atMs,
        note: n.note,
        stamp: n.stamp,
        ledgerLine: ledgerRaw ? lineOf(ledgerRaw, `[打回 ${n.stamp}]`) : null,
      });
    }
  }
  events.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  return events;
}

/**
 * 事故登记：`docs/`，日期取自**文件名**（YYYYMMDD），窗口内才算。
 * 证据取标题行 + 「一句话」段落（若存在）。
 */
export function collectIncidents(docsDir, { sinceMs, untilMs } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(docsDir); } catch { return out; }
  for (const name of names) {
    if (!/^事故-[^.]+\.md$/.test(name)) continue;
    const dm = name.match(/(20\d{6})/);
    let atMs = null;
    if (dm) {
      atMs = new Date(Number(dm[1].slice(0, 4)), Number(dm[1].slice(4, 6)) - 1, Number(dm[1].slice(6, 8))).getTime();
    } else {
      try { atMs = fs.statSync(path.join(docsDir, name)).mtimeMs; } catch { atMs = null; }
    }
    if (!(Number.isFinite(atMs) && atMs >= sinceMs && atMs <= untilMs)) continue;
    let lines = [];
    try { lines = fs.readFileSync(path.join(docsDir, name), 'utf8').split(/\r?\n/); } catch { continue; }
    const titleLine = lines.findIndex((l) => /^#\s/.test(l));
    const title = (titleLine >= 0 ? lines[titleLine] : name).replace(/^#\s*/, '').trim();
    // 「一句话」= `- **一句话**：…` 或 `## 0. 一句话` 后面的第一段
    let oneLiner = null;
    let oneLinerLine = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^-\s*\*\*一句话\*\*[：:]\s*(.+)$/);
      if (m) { oneLiner = m[1].trim(); oneLinerLine = i + 1; break; }
    }
    if (!oneLiner) {
      for (let i = 0; i < lines.length; i++) {
        if (/^##\s*0?[.、]?\s*一句话/.test(lines[i])) {
          for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (!t || t === '---') continue;
            oneLiner = t; oneLinerLine = j + 1; break;
          }
          break;
        }
      }
    }
    // 根因 / 教训段（用来给「下次先 Z」找**文档原文**）
    let lessonBasis = null;
    let lessonLine = null;
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^#{2,3}\s*(.*(教训|根因|处置|改进).*)$/);
      if (!h) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].replace(/^[-*\d.、\s]+/, '').trim();
        if (!t || t === '---' || /^#{1,3}\s/.test(lines[j])) continue;
        lessonBasis = t; lessonLine = j + 1; break;
      }
      if (lessonBasis) break;
    }
    out.push({
      kind: 'incident',
      cardId: null,
      cardTitle: title,
      cardStatus: null,
      sessionId: null,
      atMs,
      fileName: name,
      titleLine: titleLine >= 0 ? titleLine + 1 : 1,
      oneLiner, oneLinerLine,
      lessonBasis, lessonLine,
      absolutePath: path.join(docsDir, name),
    });
  }
  out.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  return out;
}

// ---------------------------------------------------------------------------
// 七、教训草稿（模板填空 · 事实只取证据原文）
// ---------------------------------------------------------------------------
const Z_BY_CLASS = Object.freeze({
  'missing-file': '收尾交付前先跑一条存在性断言（文件路径 + 非空）再报完成',
  environmental: '先探通道/重试一次，并把这类记成"让路"、不算失败',
  'card-rejected': '按打回备注逐条补做，别重做已过部分',
  'card-failed': '先留证再重试（把错误原文/输出尾部留住）',
});

/**
 * 预置动作表（**按错误族**给"下次先 Z"，不是事实推断；报告里单列，人审可改）。
 * 只放"错误原文已经把该做什么说清楚"的族；说不清的族一律不给 Z ⇒ 证据不足。
 */
export const FIX_HINTS = Object.freeze([
  { re: /ensure daemon is running/i, hint: '先把浏览器 daemon 起起来（启动脚本里设了 BSK_AUTO_START=0 的场景要显式起），再重试该动作' },
  { re: /Cannot read properties of undefined/i, hint: '解构/链式取字段前先判空（先把读数读回来再取值）' },
  { re: /buildLayer|ffmpeg|filter_complex/i, hint: '先单独跑一层滤镜到 1 帧看报错，再拼进整条链' },
  { re: /EACCES|EPERM/i, hint: '先查目标路径的权限与占用（文件在别处被锁/在保护区里）' },
  { re: /SyntaxError|Unexpected token/i, hint: '改完立刻跑语法检查（node --check）再往下走' },
]);

export function hintFor(text) {
  if (!text) return null;
  for (const h of FIX_HINTS) if (h.re.test(String(text))) return h.hint;
  return null;
}

/** 环境性类里按 marker 细分"下次先 Z"（EBUSY 不是通道问题，别一概"探通道"）。 */
export function envHint(marker) {
  const m = String(marker ?? '');
  if (/文件被占用|EBUSY/.test(m)) return '先确认没有别处正在写同一文件（双开/并发会话），再重试';
  if (/对端|隧道/.test(m)) return '先探通道（对端在线 / 隧道已起）再重试，并记为让路';
  if (/外部阻塞/.test(m)) return '先等外部条件解除（把它写成待办与续做条件），别反复重跑烧额度';
  return null;
}

/** 从打回备注里挑出"补做要求"原句（打回备注常直接写请只补什么）。 */
export function pickDirective(note) {
  if (!note) return null;
  const stripLead = (s) => s.replace(/^【[^】]*】\s*/, '').trim();
  const parts = String(note).split(/[\n。；]/).map((s) => stripLead(s.trim())).filter(Boolean);
  // 一轮：以动作要求**开头**的句子（最像"要我补什么"）
  for (const p of parts) if (/^(请只补|只补|续做条件|补做要求|须先|必须先|请先)/.test(p)) return p;
  // 二轮：句中出现动作要求词的（避开"补做时先读本段"这类元描述）
  for (const p of parts) if (/请只补|续做条件|只补这一件|请补|需补/.test(p)) return p;
  return null;
}

/**
 * 造一条教训（**硬上限 200 字**）。返回 {lesson, basis}；
 *   basis: evidence（Y/Z 都来自证据原文）/ hint-table（Z 取预置动作表）/ process-rule（Z 取类目流程动作）/ none（证据不足）
 * @param {{classId:string, y:string|null, zCandidate?:string|null, basis?:string}} p
 */
export function buildLesson({ classId, y, zCandidate = null, basis = null }) {
  const yText = clip(y, 84);
  if (!yText) return { lesson: '证据不足，不定教训', basis: 'none' };
  const z = zCandidate ? clip(zCandidate, 84) : (Z_BY_CLASS[classId] ?? null);
  if (!z) return { lesson: '证据不足，不定教训', basis: 'none' };
  const lesson = `X 步（${stepOf(classId)}）⇒ 撞上「${yText}」⇒ 下次先 ${z}`;
  return { lesson: clip(lesson, 200), basis: basis ?? (zCandidate ? 'evidence' : 'process-rule') };
}

function stepOf(classId) {
  switch (classId) {
    case 'missing-file': return '收尾交付';
    case 'environmental': return '推进/验收';
    case 'card-rejected': return '交付后等验收';
    case 'incident': return '事故登记';
    default: return '执行';
  }
}

// ---------------------------------------------------------------------------
// 八、分类全流程
// ---------------------------------------------------------------------------
export function classifyAll({ tasks, sessionIndex, incidents, ledgerRaw, sinceMs, untilMs }) {
  const events = collectBoardEvents(tasks, { sinceMs, untilMs, ledgerRaw });
  const items = [];

  for (const ev of events) {
    let se = { found: false };
    if (ev.kind === 'execution' && sessionIndex) {
      se = sessionEvidence(findSessionDir(sessionIndex, ev.sessionId));
    }
    // 主证据 = turn/end 的 error（这一轮到底为什么结束）；备注/账本 error 次之；工具错误最后
    const primary = se.turnEndError || ev.note || ev.errorText || se.lastToolError || '';
    const secondary = [se.lastToolError, ev.errorText, ev.note].filter((t) => t && t !== primary).join(' ｜ ');
    const evidenceText = [primary, secondary].filter(Boolean).join(' ｜ ');

    let cls = classifyOne({ kind: ev.kind, text: primary });
    // 次证据只补"缺件/缺目录"这一类（工具报 ENOENT 是真的缺件），**不**用次证据判环境性（会把噪音放大）
    if (cls.classId === 'card-failed' || cls.classId === 'card-rejected') {
      const miss = firstMatch(MISSING_PATTERNS, secondary);
      if (miss) cls = { classId: 'missing-file', marker: miss.kind, markerBasis: 'text-pattern(secondary)' };
    }
    const lesson = andLessonFor(ev, cls, { ...se, primary, evidenceText });
    items.push(makeItem({ ev, cls, se, lesson, evidenceText }));
  }

  for (const inc of incidents) {
    const cls = classifyOne({ kind: 'incident', text: inc.oneLiner ?? '' });
    const lesson = buildLesson({
      classId: 'incident',
      y: inc.oneLiner || null,
      zCandidate: inc.lessonBasis ? `按该档根因复核：${inc.lessonBasis}` : null,
      basis: inc.lessonBasis ? 'evidence' : null,
    });
    items.push(makeItem({
      ev: {
        kind: 'incident', cardId: null, cardTitle: inc.cardTitle, cardStatus: null, sessionId: null,
        atMs: inc.atMs, ledgerLine: inc.oneLinerLine ?? inc.titleLine,
      },
      cls,
      se: { found: false },
      lesson,
      evidenceText: [inc.cardTitle, inc.oneLiner].filter(Boolean).join(' ｜ '),
      evidenceRef: `docs\\${inc.fileName}:${inc.oneLinerLine ?? inc.titleLine}`,
    }));
  }

  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return items;
}

function andLessonFor(ev, cls, ctx) {
  const { primary } = ctx;
  switch (cls.classId) {
    case 'missing-file': {
      // Z 优先取证据里真出现的补做要求（打回备注常直接写"请只补 …"）
      const z = pickDirective(ev.note);
      return buildLesson({ classId: cls.classId, y: ev.note || primary || cls.marker, zCandidate: z });
    }
    case 'environmental': {
      const z = envHint(cls.marker);
      return buildLesson({ classId: cls.classId, y: primary || cls.marker, zCandidate: z, basis: z ? 'hint-table' : null });
    }
    case 'card-rejected': {
      const z = pickDirective(ev.note);
      return buildLesson({ classId: cls.classId, y: ev.note || '打回（无备注）', zCandidate: z });
    }
    default: {
      // 卡 failed：有具体错误原文 + 有对应错误族的预置动作才给教训；否则只登记
      const y = primary || null;
      const hint = hintFor(y);
      if (!hint) return { lesson: '证据不足，不定教训', basis: 'none' };
      return buildLesson({ classId: 'card-failed', y, zCandidate: hint, basis: 'hint-table' });
    }
  }
}

function makeItem({ ev, cls, se, lesson, evidenceText, evidenceRef = null }) {
  const taskRef = ev.cardId
    ? `~/.dsh/task-board/ledger-v2.json${ev.ledgerLine ? `:${ev.ledgerLine}` : ''} · task ${String(ev.cardId).slice(0, 8)}${Number.isInteger(ev.execIndex) ? ` · executions[${ev.execIndex}]` : ''}`
    : null;
  const sessionRef = se.found ? `会话日志 ${se.file}（${se.events} 事件）` : null;
  return {
    cardId: ev.cardId,
    cardTitle: ev.cardTitle,
    cardStatus: ev.cardStatus,
    sessionId: ev.sessionId,
    at: Number.isFinite(ev.atMs) ? new Date(ev.atMs).toISOString() : null,
    atLocal: Number.isFinite(ev.atMs) ? new Date(ev.atMs + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' +08:00' : null,
    class: cls.classId,
    classLabel: CLASS_LABEL[cls.classId],
    countsAsFailure: CLASSES.find((c) => c.id === cls.classId)?.countsAsFailure ?? true,
    source: ev.kind,
    marker: cls.marker,
    markerBasis: cls.markerBasis,
    evidenceRef: evidenceRef ?? [taskRef, sessionRef].filter(Boolean).join(' · '),
    evidenceSnippet: clip(evidenceText || cls.marker, 120),
    sessionLog: se.found ? { found: true, file: se.file, events: se.events, toolErrors: se.toolErrors, turnEndError: se.turnEndError } : { found: false },
    lesson: lesson.lesson,
    lessonBasis: lesson.basis,
    rejectNote: ev.kind === 'reject' ? clip(ev.note, 400) : null,
  };
}

// ---------------------------------------------------------------------------
// 九、tickd 让路读数（环境性的"另一面"：累计让路次数 —— 窗口切不开，如实登记）
// ---------------------------------------------------------------------------
export function readTickdState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ok: true, file, state: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, file, reason: String(err?.message ?? err).slice(0, 160) };
  }
}

export function envDeferrals(tickd) {
  if (!tickd?.ok) return { rows: [], note: `tickd state 读不到：${tickd?.reason ?? 'n/a'}` };
  const jobs = tickd.state?.jobs ?? {};
  const rows = [];
  for (const [jobId, j] of Object.entries(jobs)) {
    const n = Number(j?.benignExits ?? 0);
    if (!n) continue;
    const codes = benignCodesFor(jobId);
    rows.push({
      jobId,
      benignExits: n,
      consecutiveBenign: Number(j?.consecutiveBenign ?? 0),
      lastBenignAt: j?.lastBenignAt ?? null,
      lastStatus: j?.lastStatus ?? null,
      lastExitCode: j?.lastExitCode ?? null,
      declaredCodes: codes,
      declared: !!codes,
    });
  }
  rows.sort((a, b) => b.benignExits - a.benignExits);
  return {
    rows,
    note: `计数是 tickd 状态文件的**累计值**（state.startedAt=${tickd.state?.startedAt ?? '?'}），窗口（--days）切不开；只作"环境性还有多少"的量级参照，不进五类计数。`,
  };
}

// ---------------------------------------------------------------------------
// 十、重复报对照（只读 alert 日志 + 日报；**不改告警逻辑**）
// ---------------------------------------------------------------------------
export function compareReports(items, { alertFile, reportDir, sinceMs, untilMs, envRows = [] } = {}) {
  const alertHits = [];
  const alertPath = alertFile ?? path.join(os.homedir(), '.dsh', 'butler-alert.log');
  let alertLines = [];
  try { alertLines = fs.readFileSync(alertPath, 'utf8').split(/\r?\n/); } catch { alertLines = []; }
  const alerts = [];
  alertLines.forEach((l, i) => {
    if (!l.trim()) return;
    let o; try { o = JSON.parse(l); } catch { return; }
    const t = Date.parse(o.at);
    if (!(Number.isFinite(t) && t >= sinceMs && t <= untilMs)) return;
    alerts.push({ line: i + 1, at: o.at, t, source: o.source, level: o.level, message: String(o.message ?? '') });
  });
  for (const it of items) {
    const keys = [];
    if (it.cardId) keys.push(String(it.cardId).slice(0, 8));
    if (it.sessionId) keys.push(String(it.sessionId).slice(0, 16));
    const hits = [];
    for (const a of alerts) {
      if (keys.some((k) => a.message.includes(k))) hits.push({ line: a.line, at: a.at, source: a.source, message: clip(a.message, 100) });
    }
    if (hits.length) alertHits.push({ item: `${it.classLabel} ${it.cardId ? it.cardId.slice(0, 8) : it.cardTitle}`, hits });
  }

  // 日报：tick 健康段里被记成 🔴 的 job（若该 job 声明的退出码全是 benign ⇒ 假失败重复报）
  const reportHits = [];
  const repDir = reportDir ?? path.join(DSH, 'docs', 'reports');
  let repFiles = [];
  try { repFiles = fs.readdirSync(repDir).filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(f)); } catch { repFiles = []; }
  const benignJobs = new Set(ENV_EXIT_TABLE.map((r) => r.job));
  for (const f of repFiles) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(repDir, f), 'utf8').split(/\r?\n/); } catch { continue; }
    lines.forEach((l, i) => {
      if (!/^-\s*🔴\s*job\s+`([^`]+)`/.test(l)) return;
      const job = l.match(/^-\s*🔴\s*job\s+`([^`]+)`/)[1];
      if (!benignJobs.has(job)) return;
      // 只算"该行自报的最后错误其实是让路码"的形态
      if (!/exit code 3|exit-3|不计失败/.test(l)) return;
      reportHits.push({
        file: f, line: i + 1, job,
        message: clip(l.replace(/^-\s*/, ''), 140),
      });
    });
  }

  return {
    alertFile: alertPath,
    alertEntriesInWindow: alerts.length,
    alertHits,
    reportDir: repDir,
    reportFalseFailureLines: reportHits,
    envRowsSeen: envRows.map((r) => `${r.jobId}=${r.benignExits}`),
    note: '本段只做对照：**不改告警/日报逻辑**。告警日志不改口径、日报行不动。',
  };
}

// ---------------------------------------------------------------------------
// 十一、草稿生成（口径照 draft-forge：frontmatter 两键 / 四段 / 每行带来源 / 硬闸）
// ---------------------------------------------------------------------------
const DRAFT_THEMES = Object.freeze([
  { classId: 'missing-file', name: 'fail-missing-file', title: '缺件 / 缺目录类失败', desc: '失败分类器（H-9）沉淀的「缺件·缺目录」教训：收尾交付前先验产物存在，别把缺件当质量打回' },
  { classId: 'environmental', name: 'fail-environmental', title: '环境性失败（让路，不计失败）', desc: '失败分类器（H-9）沉淀的「环境性」教训：网络/通道/资源占用类错误先探通道再重试，并记让路而不是失败' },
  { classId: 'card-rejected', name: 'fail-rejected', title: '被打回（reject）类失败', desc: '失败分类器（H-9）沉淀的「打回」教训：按打回备注逐条补做，别重做已过部分' },
  { classId: 'incident', name: 'fail-incident', title: '事故登记类失败', desc: '失败分类器（H-9）沉淀的「事故登记」教训：事故档里的一句话与根因，转成下次开跑前的自检' },
  { classId: 'card-failed', name: 'fail-unclassified', title: '未归因的卡 failed（只登记）', desc: '失败分类器（H-9）登记位：卡 failed 但证据不足，只登记、不定教训，等会话日志或复现补证' },
]);

const SKILL_DIRS = [
  path.join(os.homedir(), '.dsh', 'skills'),
  path.join(DSH, 'skills'),
];

export function assertDraftDir(dir) {
  const abs = path.resolve(dir);
  const norm = abs.toLowerCase().replace(/[\\/]+$/, '');
  for (const s of SKILL_DIRS) {
    const sn = s.toLowerCase();
    if (norm === sn || norm.startsWith(`${sn}${path.sep}`) || norm.startsWith(`${sn}/`)) {
      throw new Error(`拒绝写入技能目录（硬闸）：${abs}`);
    }
  }
  const okRoots = [
    path.join(DSH, '_archive').toLowerCase(),
    path.resolve(os.tmpdir()).toLowerCase(),
    path.resolve(DSH, '_tmp').toLowerCase(),
  ];
  if (!okRoots.some((r) => norm === r || norm.startsWith(`${r}${path.sep}`))) {
    throw new Error(`草稿只许落在 ${DSH}\\_archive\\、${DSH}\\_tmp\\ 或 os.tmpdir() 下（实收：${abs}）`);
  }
  return abs;
}

/** 草稿里的短来源（长证据链只留在"出处一览"） */
function shortRef(i) {
  if (i.source === 'incident') return i.evidenceRef.replace(/^docs\\/, '');
  const id = i.cardId ? String(i.cardId).slice(0, 8) : '事故档';
  const parts = [`task ${id}`];
  if (i.sessionLog?.found) parts.push(`会话日志 ${i.sessionLog.file}`);
  return parts.join(' · ');
}

/** 「什么时候用」的人话（按判据来源换说法；技术 marker 只留在「判据」段） */
const USE_HINT = Object.freeze({
  'reject-note': '交付后被验收方打回（卡面出现「[打回 …]」备注）',
  'execution-result': '执行会话以「turn ended with an error」收尾、卡落 failed',
  'benign-table': 'job 报出的是已声明的让路码（不是真失败）',
  'doc-file': '事故档里登记过的真事故',
});

function uniqBy(arr, keyFn) {
  const map = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!map.has(k)) map.set(k, { key: k, items: [], count: 0 });
    const g = map.get(k);
    g.items.push(x); g.count += 1;
  }
  return [...map.values()];
}

export function renderDraft(theme, items, meta) {
  const rows = items.filter((i) => i.class === theme.classId);
  const withLesson = rows.filter((i) => i.lesson && i.lesson !== '证据不足，不定教训');
  const L = [];
  L.push('---');
  L.push(`name: ${theme.name}`);
  L.push(`description: "${theme.desc}"`);
  L.push('---');
  L.push('');
  L.push(`# ${theme.title}（草稿 · 待主人审）`);
  L.push('');
  L.push(`> 自动生成（${meta.date} · H-9 · \`${SELF_REL}\`）—— **未装进 \`~/.dsh/skills/\`**，等主人点头；要装 = 主人一句话 + 过技能规范。`);
  L.push(`> 素材：窗口 ${meta.days} 天内本类失败 **${rows.length} 条**（其中有可执行教训 ${withLesson.length} 条）；**逐行带来源**（`+"`task <id8>` / 文档行号 / 会话日志名"+`），全量指针见文末「出处一览」。`);
  L.push('> 事实纪律：Y（撞上什么）一律照抄证据；Z（下次先做什么）只取「证据里真出现的补做要求」或按类目/错误族预置的动作（预置动作不是事实，人审可改）；填不满写「证据不足，不定教训」。');
  L.push('');
  L.push('## 什么时候用');
  L.push('');
  if (!rows.length) L.push('（本窗口无本类失败）');
  for (const g of uniqBy(rows, (i) => i.marker).slice(0, 8)) {
    const hint = USE_HINT[g.items[0].markerBasis];
    const head = hint ?? `撞上「${clip(g.key, 70)}」这类局面`;
    L.push(`- ${head}（${g.count} 条 · 例：${clip(g.items[0].cardTitle || '事故档', 40)}；来源：${shortRef(g.items[0])}）`);
  }
  L.push('');
  L.push('## 步骤');
  L.push('');
  if (!withLesson.length) {
    L.push('（素材是失败记录，**没有现成命令可抄**；本类本窗口无可执行教训 ⇒ 不生成步骤）');
  } else {
    for (const g of uniqBy(withLesson, (i) => i.lesson).slice(0, 8)) {
      L.push(`- ${g.key}${g.count > 1 ? `（同型 ${g.count} 条）` : ''}（来源：${shortRef(g.items[0])}）`);
    }
  }
  L.push('');
  L.push('## 判据');
  L.push('');
  if (!rows.length) L.push('（无）');
  for (const g of uniqBy(rows, (i) => `${i.marker} ⇒ ${i.classLabel}`).slice(0, 8)) {
    L.push(`- ${g.key}（${g.count} 条；来源：${shortRef(g.items[0])}）`);
  }
  L.push('');
  L.push('## 坑');
  L.push('');
  if (!rows.length) L.push('（无）');
  for (const g of uniqBy(rows, (i) => clip(i.evidenceSnippet, 100)).slice(0, 8)) {
    L.push(`- ${g.key}（来源：${shortRef(g.items[0])}）`);
  }
  L.push('');
  L.push('## 出处一览（机器读）');
  L.push('');
  for (const i of rows) L.push(`- ${i.evidenceRef}${i.evidenceSnippet ? ` ｜ ${clip(i.evidenceSnippet, 100)}` : ''}`);
  L.push('');
  return L.join('\n');
}

export function writeDrafts({ items, outDir, apply, meta }) {
  const dir = assertDraftDir(outDir);
  const files = [];
  const skipped = [];
  for (const theme of DRAFT_THEMES) {
    const rows = items.filter((i) => i.class === theme.classId);
    if (!rows.length) { skipped.push({ theme: theme.name, why: '本窗口 0 条' }); continue; }
    const text = renderDraft(theme, items, meta);
    files.push({ theme: theme.name, file: path.join(dir, `skill-${theme.name}.md`), text });
  }
  // 索引
  const idx = [];
  idx.push('# 草稿索引（H-9 failure-classify 自动生成）');
  idx.push('');
  idx.push(`> 生成时间：${meta.date} · 窗口 ${meta.days} 天 · 器具：\`${SELF_REL}\`（\`--apply\` 才写）`);
  idx.push('> 纪律：**只写本目录**；`~\\.dsh\\skills\\` 零写入（器具内硬闸）；证据不足的只登记不生成步骤。');
  idx.push('');
  idx.push('## 1. 已生成');
  idx.push('');
  idx.push('| # | 草稿 | 类目 | 条目数 | 有可执行教训 |');
  idx.push('|---|---|---|---|---|');
  let n = 0;
  for (const f of files) {
    const theme = DRAFT_THEMES.find((t) => t.name === f.theme);
    const rows = items.filter((i) => i.class === theme.classId);
    idx.push(`| ${++n} | \`skill-${f.theme}.md\` | ${CLASS_LABEL[theme.classId]} | ${rows.length} | ${rows.filter((i) => i.lesson !== '证据不足，不定教训').length} |`);
  }
  idx.push('');
  idx.push('## 2. 只登记（未生成 / 证据不足）');
  idx.push('');
  idx.push('| 类目 | 缺什么 |');
  idx.push('|---|---|');
  for (const s of skipped) idx.push(`| ${s.theme} | ${s.why} |`);
  for (const i of items.filter((x) => x.lesson === '证据不足，不定教训')) {
    idx.push(`| ${i.classLabel} | ${i.cardId ? i.cardId.slice(0, 8) : clip(i.cardTitle, 40)}：证据不足 ⇒ 只登记（${clip(i.evidenceSnippet, 60)}） |`);
  }
  idx.push('');
  idx.push('## 3. 失败条目 → 草稿映射');
  idx.push('');
  idx.push('| 时间 | 来源 | 类目 | 卡 / 事故 | 证据 | 教训 |');
  idx.push('|---|---|---|---|---|---|');
  for (const i of items) {
    idx.push(`| ${i.atLocal ?? '-'} | ${i.source} | ${i.classLabel} | ${i.cardId ? i.cardId.slice(0, 8) : clip(i.cardTitle, 30)} | \`${i.evidenceRef}\` | ${clip(i.lesson, 80)} |`);
  }
  idx.push('');
  const indexFile = path.join(dir, 'drafts-index.md');
  if (apply) {
    fs.mkdirSync(dir, { recursive: true });
    // 只清本器具上一轮产物（`skill-fail-*.md`），别的文件一律不碰
    for (const f of fs.readdirSync(dir)) {
      if (/^skill-fail-.*\.md$/.test(f)) fs.unlinkSync(path.join(dir, f));
    }
    for (const f of files) fs.writeFileSync(f.file, f.text, 'utf8');
    fs.writeFileSync(indexFile, idx.join('\n'), 'utf8');
  }
  return { dir, files, indexFile, indexText: idx.join('\n'), skipped, applied: !!apply };
}

// ---------------------------------------------------------------------------
// 十二、分析主流程
// ---------------------------------------------------------------------------
function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

export async function analyze(opts = {}) {
  const untilMs = Number.isFinite(opts.untilMs) ? opts.untilMs : Date.now();
  const days = Number.isFinite(opts.days) ? opts.days : 30;
  const sinceMs = untilMs - days * DAY;
  const home = opts.home ?? resolveDshHome();

  // ① 看板（全量 = 不带头）
  let board = { ok: false, tasks: [], reason: null, raw: null, source: null };
  if (opts.boardFile) {
    try {
      const raw = fs.readFileSync(opts.boardFile, 'utf8');
      const j = safeJson(raw);
      const tasks = Array.isArray(j) ? j : (Array.isArray(j?.tasks) ? j.tasks : null);
      if (tasks) board = { ok: true, tasks, raw, source: opts.boardFile, reason: null };
      else board.reason = 'board-file 里没有 tasks[]';
    } catch (err) {
      board.reason = `board-file 读不到：${String(err?.message ?? err).slice(0, 120)}`;
    }
  } else {
    try {
      const api = createLedgerApi({ baseUrl: opts.boardUrl ?? 'http://localhost:3080' });
      const st = await api.readState();           // scope=all（不带头）
      if (st.ok) {
        board = { ok: true, tasks: st.tasks, raw: null, source: `${opts.boardUrl ?? 'http://localhost:3080'}/api/task-board/state (scope=all)`, reason: null };
      } else board.reason = `${st.kind}/${st.code}`;
    } catch (err) {
      board.reason = `board-error: ${String(err?.message ?? err).slice(0, 120)}`;
    }
  }

  // ② 会话日志索引（只索引目录，不预解码）
  const roots = (opts.sessionRoots?.length ? opts.sessionRoots : defaultSessionRoots(home, { includeArchive: true }));
  const index = indexSessionDirs(roots);

  // ③ 事故登记（docs）
  const docsDir = opts.docsDir ?? path.join(DSH, 'docs');
  const incidents = collectIncidents(docsDir, { sinceMs, untilMs });

  // ④ tickd 让路读数
  const tickdFile = opts.tickdStateFile ?? path.join(os.tmpdir(), 'dsh-butler-tickd', 'state.json');
  const tickd = readTickdState(tickdFile);
  const deferrals = envDeferrals(tickd);

  // ⑤ 分类
  const items = classifyAll({ tasks: board.tasks, sessionIndex: index, incidents, ledgerRaw: board.raw, sinceMs, untilMs });

  // ⑤-b 窗口内的执行结果分布（只作透明对照：interrupted / succeeded 都不进五类）
  const execResults = {};
  for (const t of board.tasks) {
    for (const e of t.executions ?? []) {
      if (!Number.isFinite(e?.startedAt) || e.startedAt < sinceMs || e.startedAt > untilMs) continue;
      const k = e.result ?? 'undefined';
      execResults[k] = (execResults[k] ?? 0) + 1;
    }
  }

  // ⑥ 计数
  const counts = {};
  for (const c of CLASSES) counts[c.id] = items.filter((i) => i.class === c.id).length;
  const total = items.length;
  const falseFailures = counts.environmental;
  const realFailures = total - falseFailures;

  // ⑦ 重复报对照
  const dup = compareReports(items, {
    alertFile: opts.alertFile,
    reportDir: opts.reportDir,
    sinceMs,
    untilMs,
    envRows: deferrals.rows,
  });

  return {
    version: CLASSIFY_VERSION,
    definitionVersion: DEFINITION_VERSION,
    generatedAt: new Date(untilMs).toISOString(),
    window: { days, sinceMs, untilMs, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    inputs: {
      board: { ok: board.ok, source: board.source, cards: board.tasks.length, reason: board.reason, executionResults: execResults },
      sessions: { roots, dirs: index.size },
      incidents: { docsDir, files: incidents.length },
      tickd: { file: tickdFile, ok: tickd.ok, reason: tickd.reason ?? null, startedAt: tickd.state?.startedAt ?? null },
      alertFile: dup.alertFile,
      reportDir: dup.reportDir,
    },
    classes: CLASSES,
    benignExitTable: ENV_EXIT_TABLE,
    counts: { byClass: counts, total, falseFailures, realFailures },
    items,
    envDeferrals: deferrals,
    dup,
  };
}

// ---------------------------------------------------------------------------
// 十三、渲染
// ---------------------------------------------------------------------------
export function renderText(res) {
  const L = [];
  const loc = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + ' +08' : '-');
  L.push(`H-9 失败五类分类 · 窗口 ${res.window.days} 天（${loc(res.window.since)} ~ ${loc(res.window.until)}）`);
  L.push(`口径：${res.definitionVersion} · 器具 v${res.version}`);
  L.push('');
  L.push(`输入：看板 ${res.inputs.board.ok ? `${res.inputs.board.cards} 卡（${res.inputs.board.source}）` : `读不到（${res.inputs.board.reason}）`}`);
  L.push(`      会话日志索引 ${res.inputs.sessions.dirs} 个目录 · 事故档 ${res.inputs.incidents.files} 份 · tickd state ${res.inputs.tickd.ok ? 'ok' : '读不到'}`);
  L.push('');
  L.push('五类计数：');
  for (const c of res.classes) {
    const n = res.counts.byClass[c.id] ?? 0;
    L.push(`  ${c.label.padEnd(22, ' ')} ${String(n).padStart(3, ' ')} 条${c.countsAsFailure ? '' : '（不计失败）'}`);
  }
  L.push(`  合计 ${res.counts.total} 条失败形记录 ⇒ 环境性 ${res.counts.falseFailures} 条 ⇒ **真失败 ${res.counts.realFailures} 条**`);
  L.push('');
  L.push('逐条：');
  for (const i of res.items) {
    L.push(`  [${i.classLabel}] ${i.atLocal ?? '-'} · ${i.cardId ? i.cardId.slice(0, 8) : '事故档'} · ${clip(i.cardTitle, 40)}`);
    L.push(`      证据：${i.evidenceRef}`);
    L.push(`            ${clip(i.evidenceSnippet, 110)}`);
    L.push(`      教训：${i.lesson}`);
  }
  L.push('');
  L.push(`环境性让路读数（tickd 累计）：${res.envDeferrals.rows.length ? res.envDeferrals.rows.map((r) => `${r.jobId}=${r.benignExits}`).join(' · ') : '无'}`);
  L.push(`  ${res.envDeferrals.note}`);
  L.push('');
  L.push('重复报对照：');
  L.push(`  alert 日志窗口内 ${res.dup.alertEntriesInWindow} 条；命中本器具条目 ${res.dup.alertHits.length} 组`);
  for (const h of res.dup.alertHits) L.push(`    · ${h.item} ← ${h.hits.map((x) => `L${x.line}`).join(',')}`);
  L.push(`  日报里"被记成 🔴 但错误其实是让路码"的行：${res.dup.reportFalseFailureLines.length} 条`);
  for (const r of res.dup.reportFalseFailureLines.slice(0, 8)) L.push(`    · ${r.file}:${r.line} \`${r.job}\` ${clip(r.message, 90)}`);
  L.push(`  ${res.dup.note}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 十四、CLI
// ---------------------------------------------------------------------------
const USAGE = `H-9 失败五类分类器（只读 · 零生产写入）

用法：
  node <butler-root>\\tools\\dsh-butler\\failure-classify.mjs --days 30 [--json] [--out <file>]
  node ... --days 30 --drafts <目录> --apply      # 生成技能草稿（只许 _archive / _tmp / os.tmpdir）
  node ... --help

参数：
  --days <N>            窗口天数（默认 30）
  --until <ISO>         窗口右端点（默认现在）
  --json                stdout 出 JSON（默认出人话）
  --out <file>          把结果写文件（.json 出 JSON，其它后缀出人话 + JSON 块不写）
  --drafts <dir>        草稿落点（默认 <butler-root>\\_archive\\v3face-h9-drafts-<日期>）
  --apply               真写草稿（默认 dry-run）
  隔离/夹具：
  --board-file <json>   用文件当看板（tasks[] 或裸数组）
  --session-roots <a,b> 会话日志根（默认 home\\sessions + home\\_archived-sessions）
  --docs-dir <dir>      事故档目录（默认 <butler-root>\\docs）
  --tickd-state <json>  tickd state（默认 %TEMP%\\dsh-butler-tickd\\state.json）
  --alert-file <path>   alert 日志（默认 ~\\.dsh\\butler-alert.log）
  --report-dir <dir>    日报目录（默认 <butler-root>\\docs\\reports）
  --board-url <url>     看板 API（默认 http://localhost:3080）

退出码：0 正常 / 2 用法错或输入读不到
`;

function parseArgv(argv) {
  const o = { days: 30, untilMs: Date.now(), json: false, out: null, drafts: null, apply: false, sessionRoots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--days') o.days = Number(next());
    else if (a === '--until') { const t = Date.parse(next()); if (Number.isFinite(t)) o.untilMs = t; }
    else if (a === '--json') o.json = true;
    else if (a === '--out') o.out = next();
    else if (a === '--drafts') o.drafts = next();
    else if (a === '--apply') o.apply = true;
    else if (a === '--board-file') o.boardFile = next();
    else if (a === '--board-url') o.boardUrl = next();
    else if (a === '--session-roots') o.sessionRoots = String(next() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--docs-dir') o.docsDir = next();
    else if (a === '--tickd-state') o.tickdStateFile = next();
    else if (a === '--alert-file') o.alertFile = next();
    else if (a === '--report-dir') o.reportDir = next();
    else { o.unknown = a; }
  }
  return o;
}

async function runCli(argv) {
  const o = parseArgv(argv);
  if (o.help) { console.log(USAGE); return 0; }
  if (o.unknown) { console.error(`不认识的参数：${o.unknown}\n${USAGE}`); return 2; }
  if (!Number.isFinite(o.days) || o.days <= 0) { console.error('--days 必须是正数'); return 2; }

  const res = await analyze(o);
  if (o.drafts) {
    const date = new Date(o.untilMs + 8 * 3600e3).toISOString().slice(0, 10);
    const out = writeDrafts({ items: res.items, outDir: o.drafts, apply: o.apply, meta: { date, days: res.window.days } });
    res.drafts = { dir: out.dir, files: out.files.map((f) => path.basename(f.file)), index: path.basename(out.indexFile), applied: out.applied, skipped: out.skipped };
    console.log(`[drafts] ${out.applied ? '已写' : 'dry-run（加 --apply 才写）'} ${out.files.length} 份 + drafts-index.md -> ${out.dir}`);
  }

  const text = renderText(res);
  if (o.json) {
    const payload = JSON.stringify(res, null, 2);
    if (o.out) fs.writeFileSync(o.out, payload, 'utf8');
    console.log(payload);
  } else {
    console.log(text);
    if (o.out) {
      const body = o.out.toLowerCase().endsWith('.json') ? JSON.stringify(res, null, 2) : `${text}\n\n<!-- JSON -->\n\n\`\`\`json\n${JSON.stringify(res, null, 2)}\n\`\`\`\n`;
      fs.writeFileSync(o.out, body, 'utf8');
      console.log(`\n[out] ${o.out}`);
    }
  }
  return 0;
}

// junction 下 import.meta.url 是物理路径、argv[1] 是逻辑路径 ⇒ 双方 realpath 再比
function isMain() {
  const a = process.argv[1];
  if (!a) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return fs.realpathSync(path.resolve(a)) === self;
  } catch { return false; }
}

if (isMain()) {
  runCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('failure-classify 失败：' + (err?.stack ?? err)); process.exitCode = 2; });
}
