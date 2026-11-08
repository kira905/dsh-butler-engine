// ============================================================
//  DSH / tools/lib/session-events.mjs
//  会话日志事件读取器具（零依赖 · 只读 · 解多帧 zstd）
//  ------------------------------------------------------------------
//  真源：docs\方案-三层角色工作方式与主线流水-V9.md §5.1 表「读日志器具」行
//        （导出面 / 实现要点 / 已知风险逐条对应该行；§2 E22 ① / §10.2 口径 α）
//
//  为什么必须自建（不按行抄现成件）：
//    · `zlib.zstdDecompressSync(整份)` **只解第一帧**，而且不报错 —— 1.8 MB 的档
//      只解出 189 B（"成功但什么都没读到"）。会话日志 = 上千个拼接的 zstd 帧。
//    · `tools\board-ops\session-tail.mjs` 会分帧，但它面向人：R-066 脱敏 +
//      每行截断 300 字 + CLI 参数解析 ⇒ 当库用会把正文脱成 `***`。
//
//  两条硬规矩：
//    ① 只读：不改、不搬、不归档、不写 ~\.dsh 下任何状态文件。
//    ② 零依赖：只用 node 内建 fs / path / os / zlib，不 import 任何业务模块
//       （因此会话日志名判据在本文件内附了一份**派生副本**，见 logGeneration()；
//         真源 = tools\lib\session-file-name.mjs，那边换代必须同批改这里）。
//
//  成本口径（§10.2 口径 α，2026-11-04 现测见交付报告 §3）：
//    进程内单份几十~几百 ms；**别拿 `session-tail` CLI 的秒级数来比**（含 node 冷启）。
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** zstd 帧魔数（小端 `28 b5 2f fd`）。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 会话日志文件名判据（读取侧）—— **派生副本**，真源 = tools\lib\session-file-name.mjs。
 * 认全世代：`session.jsonl.zstd`（旧，代际 0）/ `session.vN.jsonl.zstd`（任意 vN）。
 */
const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/** 非空环境变量取值（空串 / 纯空白 = 未设置）。 */
function envValue(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

/**
 * 解析 DSH home：显式参数 > $BUTLER_DSH_HOME > $DSH_HOME > ~/.dsh
 * （与 tools\lib\dsh-home.mjs#resolveDshHome 同口径，本文件内联以避免业务依赖；**不导出**，
 *  导出面只留规格里的两个函数）
 */
function resolveHome(configured) {
  if (configured) return path.resolve(configured);
  const override = envValue('BUTLER_DSH_HOME') ?? envValue('DSH_HOME');
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.dsh');
}

/** 剥掉 `session-` 前缀 ⇒ 裸 uuid（§5.1 `sid` 规范形：落盘一律裸 uuid）。 */
function bareSid(s) {
  return String(s).replace(/^session-/, '');
}

/** 目录名 → 形态：`session-<uuid>` / `<uuid>` / 其它。 */
function dirFormOf(name) {
  if (/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return 'session-prefixed';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return 'bare';
  return null;
}

/** 目录里「当前那份」会话日志：mtime 最新优先 → 平局取代际大者 → 再平局取名字典序小者。 */
function pickLogInDir(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const hits = [];
  for (const e of ents) {
    if (!e.isFile() || !SESSION_FILE_RE.test(e.name)) continue;
    const full = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const m = SESSION_FILE_RE.exec(e.name);
    hits.push({ file: full, gen: m[1] ? Number(m[1]) : 0, mtimeMs: Math.round(st.mtimeMs) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.gen - a.gen) || (a.file < b.file ? -1 : 1));
  return hits[0].file;
}

/**
 * 按 sid 找会话目录（**两形态都试**：原样未命中 ⇒ 补 / 去 `session-` 前缀再试一次）。
 * 只试 `sessions\<ws>\<dir>` 一层；两形态都在多工作区里找，先「原样」后「补/去前缀」。
 * @returns {{dir:string, dirForm:'session-prefixed'|'bare'}|null}
 */
function findSessionDir(sid, home) {
  const base = bareSid(sid);
  const given = String(sid);
  const forms = [given === base ? base : given, given === base ? 'session-' + base : base];
  const roots = [path.join(home, 'sessions')];
  let wss = [];
  for (const root of roots) {
    try { wss = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const form of forms) {
      for (const ws of wss) {
        if (!ws.isDirectory()) continue;
        const d = path.join(root, ws.name, form);
        let st;
        try { st = fs.statSync(d); } catch { continue; }
        if (st.isDirectory()) return { dir: d, dirForm: dirFormOf(form) || 'bare' };
      }
    }
  }
  return null;
}

/**
 * 读会话日志事件（多帧 zstd 逐帧解）。
 *
 * @param {string} sidOrFile  sid（带不带 `session-` 都行）/ 会话目录 / 日志文件绝对路径
 * @param {{lastN?:number, types?:string[]|string, home?:string}} [opts]
 * @returns {{file:string|null, frames:number, events:{type:string,seq:number,time:number,data:any}[],
 *            stats:{bytes:number,ms:number,frameFail:number,badLines:number}}}
 *
 * 实现要点（§5.1）：
 *   · 按 magic `28 b5 2f fd` 切帧 → 逐帧 `zstdDecompressSync`
 *   · **先按 `type` 预过滤、再 `JSON.parse`**（一份大档 275 条 `tool/call`，全解白花时间）
 *   · 某段解压失败 ⇒ **并进下一段重试一次**，仍失败才计 `frameFail`
 *   · **末帧解压失败 = 正在写 ⇒ 不计 `frameFail`**（只计非末段失败）
 *   · 只回 `lastN` 条（`0` / 不给 = 全给）
 */
export function readEvents(sidOrFile, opts = {}) {
  const t0 = process.hrtime.bigint();
  const lastN = Number.isFinite(opts.lastN) && opts.lastN > 0 ? Math.floor(opts.lastN) : 0;
  const typeFilter = opts.types == null ? null
    : (Array.isArray(opts.types) ? opts.types.map(String) : [String(opts.types)]);
  const typeSet = typeFilter && typeFilter.length ? new Set(typeFilter) : null;
  const home = resolveHome(opts.home);

  const out = { file: null, frames: 0, events: [], stats: { bytes: 0, ms: 0, frameFail: 0, badLines: 0 } };

  // ① 定位文件：文件路径 → 目录 → sid（两形态）
  let file = null;
  const s = String(sidOrFile == null ? '' : sidOrFile);
  if (s) {
    let st = null;
    try { st = fs.statSync(s); } catch { st = null; }
    if (st && st.isFile()) file = s;
    else if (st && st.isDirectory()) file = pickLogInDir(s);
    if (!file) {
      const looksLikePath = /[\\/]/.test(s) || /\.zstd$/.test(s);
      if (!looksLikePath) {
        const hit = findSessionDir(s, home);
        if (hit) file = pickLogInDir(hit.dir);
      }
    }
  }
  if (!file) {
    out.stats.ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return out;
  }
  out.file = file;

  let buf;
  try { buf = fs.readFileSync(file); } catch {
    out.stats.ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return out;
  }
  out.stats.bytes = buf.length;

  // ② 切帧：magic 的所有出现位置
  const starts = [];
  for (let i = 0; (i = buf.indexOf(MAGIC, i)) !== -1; i += 4) starts.push(i);
  out.frames = starts.length;
  if (!starts.length) {
    out.stats.ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return out;
  }

  const matched = [];
  const typeProbe = /"type"\s*:\s*"([^"]*)"/;

  const pushText = (text) => {
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      if (!raw) continue;
      // 先按 type 预过滤（正则扫一遍字符串就够，别为 275 条 tool/call 白付 JSON.parse）
      if (typeSet) {
        const m = typeProbe.exec(raw);
        if (!m || !typeSet.has(m[1])) continue;
      }
      let o;
      try { o = JSON.parse(raw); } catch { out.stats.badLines++; continue; }
      if (!o || typeof o !== 'object') { out.stats.badLines++; continue; }
      if (typeSet && !typeSet.has(o.type)) continue;            // 兜底：正则命中嵌套键时再校一次
      matched.push({ type: o.type, seq: o.seq, time: o.time, data: o.data });
    }
  };

  // ③ 逐帧解；失败先并进下一段重试一次，仍失败才计（末段失败 = 正在写，不计）
  //
  // ⚠️ 两条 2026-11-04 实测出来的硬事实（都是"静默"，跟 E22① 同族）：
  //    ① **截断的 zstd 帧不抛错**：只剩 magic 头的段、被切成两半的帧，`zstdDecompressSync`
  //       都可能返回 `length===0` 且 `code===undefined`（raw block 更狠：直接吐出半截内容）。
  //    ② **真日志每帧都以 `\n` 结尾**（现测 6 份 / 7,681 帧：endsWithNewline = 7681 / 7681、
  //       全部不带 Frame_Content_Size、解压 0 抛错）—— 写者按整行写、按行收尾。
  //    ⇒ 判据 = **抛错 / 解出 0 字节 / 不以 `\n` 收尾，都算"这一段没解完"**；
  //      解不完就先并进下一段重试一次（magic 可能偶然出现在压缩数据里，把一帧切成两段），
  //      重试不成才计 `frameFail`，且**末段不吃这个计数**（末段解不完 = 正在写，是常态）。
  const tryDecode = (s, e) => {
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(s, e));
      return out.length ? out.toString('utf8') : null;
    } catch {
      return null;
    }
  };
  const complete = (t) => t !== null && t.endsWith('\n');

  let i = 0;
  while (i < starts.length) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    let text = tryDecode(start, end);
    if (complete(text)) {
      i += 1;
    } else if (i + 1 < starts.length) {
      // 并进下一段重试一次（连续 subarray ⇒ 被误切掉的 magic 4 字节也在里面，能复原整帧）
      const end2 = i + 2 < starts.length ? starts[i + 2] : buf.length;
      const merged = tryDecode(start, end2);
      if (complete(merged)) {
        text = merged;
        i += 2;
      } else {
        text = merged !== null ? merged : text;               // 救不全也别把能解的那半截扔了
        if (i < starts.length - 1) out.stats.frameFail += 1;  // 只计非末段失败
        i += 1;                                               // 只跳过这段，下一段自己再试
      }
    } else {
      i += 1;                                                 // 末帧解不完 = 正在写 ⇒ 不计 frameFail
    }
    if (text) pushText(text);
  }

  out.events = lastN && matched.length > lastN ? matched.slice(-lastN) : matched;
  out.stats.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return out;
}

/**
 * 列「近 N 小时有写」的活跃会话（只扫目录 + 日志 mtime，**不走 session.list RPC**）。
 *
 * @param {{home?:string, withinHours?:number}} [opts]  withinHours 缺省 24；给 0/负数 = 不限
 * @returns {{sid:string, dirForm:'session-prefixed'|'bare', logFile:string, lastWriteMs:number,
 *            title:string|null}[]}
 *
 * `title` **只从日志里最后一条 `session/title` 事件取**（header 里根本没有 title）：
 * 取不到 / `frameFail>0` ⇒ `title:null`，**不拿 header / 目录名 / 文件名顶替**。
 */
export function listActiveSessions(opts = {}) {
  const home = resolveHome(opts.home);
  const withinHours = opts.withinHours == null ? 24 : Number(opts.withinHours);
  const nowMs = Date.now();
  const cutoffMs = withinHours > 0 ? nowMs - withinHours * 3600 * 1000 : -Infinity;
  const root = path.join(home, 'sessions');

  // ① 枚举会话目录：`sessions\<ws>\<会话目录>`（目录里有日志文件即算一个会话；不深入）
  const found = [];
  let wss = [];
  try { wss = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const ws of wss) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let sessions = [];
    try { sessions = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const sd of sessions) {
      if (!sd.isDirectory()) continue;
      const dir = path.join(wsDir, sd.name);
      const logFile = pickLogInDir(dir);
      if (!logFile) continue;
      let st;
      try { st = fs.statSync(logFile); } catch { continue; }
      if (st.mtimeMs < cutoffMs) continue;
      found.push({
        sid: bareSid(sd.name),
        dirForm: dirFormOf(sd.name) || 'bare',
        logFile,
        lastWriteMs: Math.round(st.mtimeMs),
        title: null,
      });
    }
  }

  // ② 先按 mtime 筛完候选，再逐个取标题（成本纪律：不许对全树无条件解析）
  found.sort((a, b) => b.lastWriteMs - a.lastWriteMs);
  for (const row of found) {
    const r = readEvents(row.logFile, { types: ['session/title'], lastN: 1, home });
    if (r.stats.frameFail > 0) continue;                     // 中间帧坏了 ⇒ 不当"文件干净"
    const ev = r.events && r.events[0];
    const t = ev && ev.data && ev.data.title;
    if (typeof t === 'string' && t.trim()) row.title = t;
  }
  return found;
}
