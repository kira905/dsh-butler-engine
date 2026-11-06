// dsh-butler / lib/tickd-fail-trace.mjs —— tickd 子进程**失败原因留痕**（2026-10-10 · 冲刺600）
//
// 为什么存在（背景，出处：docs/ §2.2 / §5）：
//   `board-line-archive` 全历史 4 次 `exit-1`，但 tickd 用 `stdio:'ignore'` spawn 子进程、
//   `lastError` 只写 `exit code 1` ⇒ **子进程报什么错一个字都没留**，那次定性只能靠
//   "同一秒别的 job 也在 fetch failed" 这种旁证反推。本模块把非 0 退出时的子进程输出**尾部**
//   落盘，补上这条证据链：下次同类失败，一眼能看到 `fetch failed` 还是别的。
//
// 边界（卡红线）：**只加留痕，判定语义一字不改** ——
//   ok / exit-N / deferred / failures / lastStatus 的计算全在 butler-tickd.mjs 里原样保留；
//   本模块只负责 ① 内存尾部捕获 ② 有界落盘 ③ 给 lastError 追加一行摘要（首行 `exit code N` 不动）。
//
// ⚠️ 管道必须**并发读取**（本模块 + tickd 接线共同保证，本卡最容易翻车的一点）：
//   stdio 从 'ignore' 改成 'pipe' 后，子进程的 stdout/stderr 写进 OS 管道缓冲（Windows 默认
//   几十 KB）。若父进程不读，子进程会**阻塞在 write 上永不退出** ⇒ tickd 的 'exit' 回调永不
//   触发 ⇒ job 永远 `running:true`、锁不释放、之后每一轮都被跳过（**静默停摆**，比丢日志严重得多）。
//   故 tickd 在 spawn 的**同一个 tick 内同步**调用 attachTail()（事件驱动、不阻塞、不 await），
//   TailBuffer.push() 只做差量内存保留（无 I/O）。
//   实测对照见 `_test/test-tickd-fail-trace.mjs` ⑥ 段：同一个往两流各写 4 MB 的脚本，
//   **不挂读取** ⇒ 3 秒后仍未退出；**挂读取** ⇒ 正常 exit 1 且尾部完整。
//
// 落点（与 tickd 的既有约定同源）：`<DSH_TICKD_DIR>\last-error\<jobId>.log`
//   每 job **一个文件、覆盖写**（排障时直接看最近一次失败，不用翻历史）+
//   每段只留尾部 N KB + 目录文件数上限（超出按 mtime 删最旧）⇒ 三重有界，日志不会无限长。
import fs from 'node:fs';
import path from 'node:path';
// ── R-065 删除/搬移三件套（锁6 · 批 E2 · 2026-10-19）──────────────────────────
//  语义：① reparse point 拒删 ② 白名单拒跑 ③ dry-run 是**函数内第一道门** ④ 作用域点明（file）。
//  判据本体全在共享件（本文件不复制判据、只传参数）；共享件是 tools\lib 本地件，不是主包依赖。
import { gateDestructive } from '../../lib/production-guard.mjs';

/** 唯一删口（R-065）：dry-run 是本函数**第一条**可执行语句；被拒 ⇒ 返回 false（调用方按「没删」处理）。 */
function removeGuarded(target, { whitelist, reason = null, dryRun = false, allowReparse = false, op = '删文件' } = {}) {
  if (dryRun === true) return false;
  const g = gateDestructive({
    targets: [{ path: target, label: reason }], whitelist, op, scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return false;
  try { fs.rmSync(target, { force: true }); return true; } catch { return false; }
}

/** 唯一搬移口（R-065）：同卷 rename 的**原子替换**语义。dry-run 同样是第一条可执行语句。 */
function renameGuarded(from, to, { whitelist, reason = null, dryRun = false, allowReparse = false } = {}) {
  if (dryRun === true) return { ok: true, dryRun: true, code: 'dry-run', reason: 'dry-run（零动作）' };
  const g = gateDestructive({
    targets: [{ path: from, label: 'src' }, { path: to, label: 'dst' }], whitelist, op: '搬移', scope: ['file'], requires: ['file'],
    dryRun: false, allowProduction: true, allowReparse, ledgerBypass: false, reason,
  });
  if (!g.ok) return { ok: false, code: g.code, reason: g.reason };
  try { fs.renameSync(from, to); return { ok: true, code: null, reason: g.reason }; }
  catch (e) { return { ok: false, code: 'fs-error', reason: String(e?.message ?? e) }; }
}


export const FAIL_TRACE_VERSION = '0.1.0';

/** 每流落盘尾部上限（默认 8 KB）—— 只留尾巴，头部的"正常输出"没诊断价值。 */
export const DEFAULT_TAIL_BYTES = 8 * 1024;
/** 每流内存捕获上限（默认 64 KB）：只为"尾部"留量，超出的头部直接丢（不落盘、不缓存）。 */
export const DEFAULT_CAPTURE_BYTES = 64 * 1024;
/** 留痕目录文件数上限（默认 40；超出按 mtime 删最旧）—— 轮转，防目录无限长。 */
export const DEFAULT_MAX_FILES = 40;
/** lastError 摘要行单行长度上限。 */
export const SUMMARY_MAX_CHARS = 160;

function posInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}

/**
 * 留痕配置（env 可覆盖：单测用小值、运维可调参；**缺省即生产口径**）。
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveTraceConfig(env = process.env) {
  return {
    tailBytes: posInt(env?.DSH_TICKD_TRACE_TAIL_BYTES, DEFAULT_TAIL_BYTES),
    captureBytes: posInt(env?.DSH_TICKD_TRACE_CAPTURE_BYTES, DEFAULT_CAPTURE_BYTES),
    maxFiles: posInt(env?.DSH_TICKD_TRACE_MAX_FILES, DEFAULT_MAX_FILES),
  };
}

/**
 * 留痕目录：默认 `stateDir\last-error`，可用 `DSH_TICKD_TRACE_DIR` 整体覆盖（单测隔离用）。
 * @param {string} stateDir tickd 状态目录（= `<DSH_TICKD_DIR>`）
 * @param {Record<string,string|undefined>} [env]
 */
export function traceDirFor(stateDir, env = process.env) {
  const override = String(env?.DSH_TICKD_TRACE_DIR ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(stateDir, 'last-error');
}

/** 每 job 一个文件名（清洗非法字符—— job id 来自注册表，但文件名不许出目录）。 */
export function traceFileName(jobId) {
  const safe = String(jobId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `${safe || 'unknown'}.log`;
}

/**
 * 该退出码该不该留痕：**非 0 一律留**（含 benign 让路 —— 让路也是非 0 退出，同样可能带诊断输出）。
 * ⚠️ 本函数**不参与任何判定**，只决定"写不写留痕文件"；它变了也不会影响 lastStatus/failures。
 */
export function shouldTraceExit(code) {
  const n = Number(code);
  return Number.isFinite(n) && n !== 0;
}

/**
 * 内存尾部缓冲：只保留最后 `limit` 字节（超出丢头部），push 为差量摊销（chunk 粒度）。
 * 为什么要它而不是"攒全部再截尾"：常驻 tickd 里 job 输出可能很大，攒全量等于把
 * 子进程的输出全驻留内存（长跑 job 会吃光内存）；只留尾部则内存上限 = limit 恒定。
 */
export class TailBuffer {
  constructor(limit = DEFAULT_CAPTURE_BYTES) {
    this.limit = posInt(limit, DEFAULT_CAPTURE_BYTES);
    /** @type {Buffer[]} */ this.chunks = [];
    this.bytes = 0;        // 当前驻留字节数
    this.totalBytes = 0;   // 累计收到的字节数（= 子进程真实写出量）
  }

  push(chunk) {
    if (chunk === null || chunk === undefined) return;
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (!b.length) return;
    this.totalBytes += b.length;
    if (b.length >= this.limit) {          // 单个 chunk 就超限 ⇒ 只留它自己的尾巴
      this.chunks = [Buffer.from(b.subarray(b.length - this.limit))];
      this.bytes = this.limit;
      return;
    }
    this.chunks.push(b);
    this.bytes += b.length;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const overflow = this.bytes - this.limit;
      const head = this.chunks[0];
      if (head.length <= overflow) { this.chunks.shift(); this.bytes -= head.length; }
      else { this.chunks[0] = head.subarray(overflow); this.bytes -= overflow; }
    }
  }

  /** 当前驻留内容（可能不足 limit —— 那就是子进程写得少）。 */
  toBuffer() { return this.chunks.length ? Buffer.concat(this.chunks) : Buffer.alloc(0); }
  text() { return this.toBuffer().toString('utf8'); }
}

/**
 * 把子进程的输出流接到 TailBuffer 上 —— **必须在 spawn 之后立刻调用**（并发读取，见文件头）。
 * 返回 detach 函数（幂等）；流错误被吞掉（留痕失败绝不能把常驻 tickd 带崩）。
 * @param {import('node:stream').Readable|null} stream
 * @param {TailBuffer} tail
 */
export function attachTail(stream, tail) {
  if (!stream || typeof stream.on !== 'function') return () => {};
  const onData = (chunk) => { try { tail.push(chunk); } catch { /* 留痕失败不影响调度 */ } };
  stream.on('data', onData);
  stream.on('error', () => { /* 子进程流错误只影响留痕，绝不冒泡成 unhandled 'error' */ });
  return () => { try { stream.off('data', onData); } catch { /* ignore */ } };
}

/**
 * 按 UTF-8 **字节**取字符串尾部，并保证不把多字节字符切成半个（切点回退到字符边界）。
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{text:string, bytes:number, truncated:boolean}}
 */
export function utf8Tail(text, maxBytes) {
  const s = String(text ?? '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, bytes: buf.length, truncated: false };
  let start = buf.length - maxBytes;
  // 回退到合法字符起点：continuation 字节形如 10xxxxxx
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString('utf8'), bytes: buf.length - start, truncated: true };
}

/** 首个"有意义"的行（跳空行/纯空白）；都空则返回 ''。 */
export function firstMeaningfulLine(text, max = SUMMARY_MAX_CHARS) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line.length > max ? `${line.slice(0, max)}…` : line;
  }
  return '';
}

/**
 * 摘要选取（给 `lastError` 第二行用）：
 *   默认取尾部**首个**有意义行 —— Node 的崩溃输出里首行通常就是错误标题（如 `fetch failed`）；
 *   ⚠️ 但若首行是"尾部截断切出来的残片"（长度顶到上限），它对排障毫无价值，改用尾部**最后**
 *   一个有意义行 —— 截尾的语义本来就是"留最后发生的事"。
 *   实战暴露：夹具 `bigfail`（20KB 单行 + 结尾 marker）用"只取首行"时摘要是 160 个 `H`（无用）。
 */
export function summaryLineFor(text, truncated = false) {
  const first = firstMeaningfulLine(text);
  if (!first) return '';
  if (truncated && first.length > SUMMARY_MAX_CHARS) {
    const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const last = lines[lines.length - 1] ?? '';
    if (last && last !== first) return last.length > SUMMARY_MAX_CHARS ? `${last.slice(0, SUMMARY_MAX_CHARS)}…` : last;
  }
  return first;
}

/**
 * 渲染留痕正文（纯函数，单测直接断言）。
 * @returns {string}
 */
export function renderTrace({
  jobId, label = null, code = null, status = null, benign = false, durationMs = null,
  via = null, pid = null, startedAt = null, at = new Date().toISOString(),
  stdoutText = '', stderrText = '',
  stdoutTotal = 0, stderrTotal = 0, stdoutKept = 0, stderrKept = 0,
  tailBytes = DEFAULT_TAIL_BYTES, env = process.env,
} = {}) {
  const B = (n) => `${Number(n ?? 0)} B`;
  const cut = (total, kept) => (Number(total) > Number(kept) ? `${B(total)}（本段只留尾部 ${B(kept)}；头部 ${B(Number(total) - Number(kept))} 未留）`
    : `${B(total)}（全留）`);
  const L = [];
  L.push('# tickd 子进程失败留痕 —— 每次失败**覆盖写**；只留输出尾部，不是完整输出');
  L.push(`# 生成 ${at} ｜ 口径 lib/tickd-fail-trace.mjs v${FAIL_TRACE_VERSION} ｜ **只加留痕，判定语义不变**`);
  L.push(`job        : ${jobId ?? 'unknown'}`);
  if (label) L.push(`label      : ${label}`);
  L.push(`exit       : ${code === null ? 'null（非 exit 收尾：error/信号）' : code}`);
  if (status) L.push(`status     : ${status}`);
  L.push(`benign     : ${benign ? 'yes（让路/未完成）' : 'no'}`);
  if (durationMs !== null) L.push(`duration   : ${durationMs}ms`);
  if (via) L.push(`via        : ${via}`);
  if (pid) L.push(`pid        : ${pid}`);
  if (startedAt) L.push(`startedAt  : ${startedAt}`);
  L.push(`at         : ${at}`);
  L.push(`stdout     : ${cut(stdoutTotal, stdoutKept)}`);
  L.push(`stderr     : ${cut(stderrTotal, stderrKept)}`);
  L.push(`段上限     : 每流尾部 ${B(tailBytes)}（env DSH_TICKD_TRACE_TAIL_BYTES 可调）`);
  L.push(`留痕开关   : 非 0 退出即写；0 退出**不写**（shouldTraceExit）`);
  L.push(`--- stderr（尾部）---`);
  L.push(stderrText.replace(/\s+$/, '') || '(空)');
  L.push(`--- stdout（尾部）---`);
  L.push(stdoutText.replace(/\s+$/, '') || '(空)');
  L.push('');
  void env;
  return L.join('\n');
}

/**
 * 目录轮转：文件数超上限时按 mtime 删最旧（`keep` 排除本次刚写的那个）。
 * @returns {{removed:string[], kept:number, error:string|null}}
 */
export function rotateTraces(dir, { maxFiles = DEFAULT_MAX_FILES, keep = null } = {}) {
  const out = { removed: [], kept: 0, error: null };
  let entries;
  try { entries = fs.readdirSync(dir).filter((n) => n.endsWith('.log')); } catch (e) { out.error = String(e?.message ?? e); return out; }
  const keepFull = keep ? path.resolve(keep) : null;
  const files = [];
  for (const n of entries) {
    const full = path.resolve(dir, n);
    try { files.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch { /* 忽略读不到的文件 */ }
  }
  files.sort((a, b) => a.mtime - b.mtime);   // 旧 → 新
  // ⚠️ keep（本次刚写的那个）**直接不进候选**；早先写法是"最旧的就是 keep 就 break"——
  //   那会让**整轮轮转失效**（单测 ⑤ 实测抓到：45 个文件、keep=最旧 ⇒ 一个都没删，目录照样无限长）。
  const victims = keepFull ? files.filter((f) => f.full !== keepFull) : files;
  const over = Math.max(0, files.length - maxFiles);
  for (const v of victims.slice(0, over)) {
    try { if (removeGuarded(v.full, { whitelist: [dir], reason: '失败留痕目录轮转' })) out.removed.push(v.full); } catch { /* 删不掉不影响主流程 */ }
  }
  out.kept = files.length - out.removed.length;
  return out;
}

/**
 * 落盘一次失败留痕（**唯一的写盘入口**）。任何异常都被吞成 `{ok:false}`——
 *   留痕是诊断的附属品，**绝不允许**因为写盘失败影响调度结算（既有红线）。
 *
 * @param {object} o
 * @param {string} o.jobId
 * @param {number|null} o.code 退出码
 * @param {string} o.dir 留痕目录（`traceDirFor()` 给）
 * @param {TailBuffer} [o.stdoutTail] @param {TailBuffer} [o.stderrTail]
 * @param {string} [o.stdoutText] @param {string} [o.stderrText] 直接给正文（单测用；与 *Tail 二选一）
 * @returns {{ok:boolean, path:string|null, bytes:number, tailBytes:number, stdoutBytes:number, stderrBytes:number,
 *            truncated:{stdout:boolean,stderr:boolean}, summary:string, error:string|null, rotated:object|null}}
 */
export function writeExitTrace(o = {}) {
  const empty = { ok: false, path: null, bytes: 0, tailBytes: 0, stdoutBytes: 0, stderrBytes: 0, truncated: { stdout: false, stderr: false }, summary: '', error: null, rotated: null };
  const cfg = resolveTraceConfig(o.env ?? process.env);
  const tailBytes = posInt(o.tailBytes, cfg.tailBytes);
  const maxFiles = posInt(o.maxFiles, cfg.maxFiles);
  try {
    if (!o.dir) return { ...empty, error: 'no-dir' };
    fs.mkdirSync(o.dir, { recursive: true });
    const stdoutRaw = o.stdoutText !== undefined ? String(o.stdoutText) : (o.stdoutTail ? o.stdoutTail.text() : '');
    const stderrRaw = o.stderrText !== undefined ? String(o.stderrText) : (o.stderrTail ? o.stderrTail.text() : '');
    const so = utf8Tail(stdoutRaw, tailBytes);
    const se = utf8Tail(stderrRaw, tailBytes);
    const stdoutTotal = o.stdoutTail ? o.stdoutTail.totalBytes : Buffer.byteLength(stdoutRaw, 'utf8');
    const stderrTotal = o.stderrTail ? o.stderrTail.totalBytes : Buffer.byteLength(stderrRaw, 'utf8');
    const text = renderTrace({
      jobId: o.jobId, label: o.label ?? null, code: o.code ?? null, status: o.status ?? null,
      benign: o.benign === true, durationMs: o.durationMs ?? null, via: o.via ?? null,
      pid: o.pid ?? null, startedAt: o.startedAt ?? null, at: o.at ?? new Date().toISOString(),
      stdoutText: so.text, stderrText: se.text,
      stdoutTotal, stderrTotal, stdoutKept: so.bytes, stderrKept: se.bytes, tailBytes,
      env: o.env ?? process.env,
    });
    const file = path.join(o.dir, traceFileName(o.jobId));
    fs.writeFileSync(file, text, 'utf8');
    const rotated = rotateTraces(o.dir, { maxFiles, keep: file });
    // 摘要（给 lastError 第二行用）：优先 stderr 首个有意义行（截断残片除外，见 summaryLineFor），
    //   退化到 stdout；再退化到"无输出"。
    const line = summaryLineFor(se.text, se.truncated) || summaryLineFor(so.text, so.truncated);
    const summary = line || '(子进程无输出)';
    return {
      ok: true, path: file, bytes: Buffer.byteLength(text, 'utf8'), tailBytes,
      stdoutBytes: stdoutTotal, stderrBytes: stderrTotal,
      truncated: { stdout: so.truncated, stderr: se.truncated },
      summary, error: null, rotated,
    };
  } catch (e) {
    return { ...empty, error: String(e?.message ?? e) };
  }
}

/**
 * `lastError` 的第二行（**首行 `exit code N` 保持原样**）——留痕位置 + 一句摘要。
 * ⚠️ 只返回一行文本；调用方负责拼在既有文案后面（benign 文案走 benignExitError，不走这里）。
 */
export function traceSummaryLine(trace) {
  if (!trace?.ok) return '';
  const rel = String(trace.path ?? '');
  return `· 子进程输出已留痕：${rel}（stderr 尾部首行：${trace.summary}）`;
}
