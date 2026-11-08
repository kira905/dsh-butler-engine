#!/usr/bin/env node
// dsh-butler / dsh-vanish-watch.mjs —— R-071 第③件：大量消失告警（5 分钟跌幅 > 阈值 ⇒ 告警）
//
// 为什么要有它（事故真源 `docs\事故-20261020-DSH数据被清-自查与补齐.md` §1/§4）：
//   2026-10-19 23:48:51 起，`~\.dsh` 与 `<workspace>` 一夜之间被删掉 4,000+ 件（会话/技能/归档/生图库/凭据），
//   **全程零告警** —— 删的过程持续 5 分多钟（23:48:51~23:54:12，85,744 次删除事件），
//   本来完全来得及喊停。第③道防线 = **按"件数断崖"报警**，与第①（进程审计）/ 第②（定时快照）互补。
//
// ⚠️ 与 `butler-watch-fs.mjs` 的分工（别混）：
//   · watch-fs 管 **A 层文件被改动**（内容 hash 变 ⇒ 跑规则 ⇒ 违规回滚/告警），**看不到"文件不见了"**：
//     清单是**现在枚举出来的**，被删的文件根本不在清单里 ⇒ 消失 = 静默。
//   · 本脚本管 **件数断崖**（只 readdir 数条目，不读内容、不 hash）—— 两件互不替代。
//
// 计数口径（**只读元数据**）：递归 `readdirSync(withFileTypes)`，**目录与文件各算 1 个条目**；
//   跳过 `node_modules` / `.git`（依赖与 VCS 件不算"用户数据"，且 npm 装删波动巨大）。
//   一个面一次遍历；面之间共享的根目录用本轮缓存，不重复扫。
//
// 面的口径（含合并项，理由是事故形态本身）：
//   sessions = `sessions` **+** `_archived-sessions` —— 会话被归档会从一个面搬到另一个面；
//     不合并 ⇒ 归档动作会天天误报"会话大量消失"（本卡 §2 实测：sessions 159 / 归档 5,705）。
//   其余 7 面单看。
//
// 触发：`跌幅% > 阈值`（默认 10%）且上次读数有效。判出后：
//   · level **恒为 error**（卡面口径）；`kind` 只作**标签**写进 message/detail：
//   · **首版 observe**：状态文件 `mode: 'observe'`（缺省）时**只记事件、不调 alert**；
//     置 `notify` 才真发。放行 = 改开关不改代码（`--set-mode notify`）。
//
// 「消失 vs 迁移」怎么判（**启发式，别当证明**）：本轮该面跌幅超阈时，看 `<workspace>\_archive` 的
//   **顶层是否多出新条目**（与上一轮的名字集合比）—— 多 = 本轮有东西被搬进归档（整理/收纳），标 `迁移`；
//   否则标 `消失`。⚠️ 它只能说明"本轮有归档动作"，**不能证明丢的那批就在归档里**，反过来也会误标
//   （新建一个备份目录同样算"多出新条目"）⇒ **所以它只改标签、绝不改级别**（两种都发 error），
//   人工看到 `迁移` 仍应抽查 `detail.newArchiveEntries` 里那几个新目录。
//
// 读不到某个面（根目录不存在）⇒ 记 `unknown`，**绝不按 0 处理**（否则恢复期目录临时不在 =
//   伪"跌 100%"误报）。unknown 不告警，只在事件/`--status` 里可见。
//
// 状态文件：`~/.dsh/butler-vanish-watch.json`
//   { schemaVersion, mode:'observe'|'notify', faces:{<name>:{count,at,unknown?}}, shadow:{archiveTop},
//     events:[最近 20], cooldowns:{<face>: ms}, lastRunAt }
//
// 用法：
//   node dsh-vanish-watch.mjs [--once|--loop] [--apply] [--notify|--observe] [--status] [--json]
//     [--threshold 10] [--cooldown 60] [--min-drop N] [--home <dir>] [--dir <dir>] [--state <file>]
//     [--face name=path[;path] ...] [--set-mode observe|notify]
//   · 缺省 **dry-run**：只算、只打印，不写状态、不发告警；`--apply` 才写。
//   · `--status` 只读现状（当前读数 / 上次读数 / 跌幅 / 冷却 / 模式），零写入。
//   · `--face` 出现 ≥1 次时**替换**默认 8 面表（夹具演练用；正常调度别传）。
// 退出码：0 正常（含"判出跌幅"）/ 1 自身失败 / 2 用法错误。**收尾一律 process.exitCode**（house rule）。
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { readJson, writeJsonAtomic } from '../src/dsh-butler/lib/store.mjs';

export const VANISH_WATCH_VERSION = '0.1.0';
export const VANISH_WATCH_SCHEMA = 1;
export const STATE_NAME = 'butler-vanish-watch.json';
export const DEFAULT_THRESHOLD_PCT = 10;
export const DEFAULT_COOLDOWN_MIN = 60;
export const MAX_EVENTS = 20;
/** 计数时跳过的目录名（依赖 / VCS，不算用户数据；npm 装删波动巨大） */
const SKIP_DIRS = new Set(['node_modules', '.git']);

const USAGE = [
  'dsh-vanish-watch —— R-071③ 大量消失告警（只读件数断崖；首版 observe）',
  '  node dsh-vanish-watch.mjs [--once|--loop] [--apply] [--notify|--observe] [--status] [--json]',
  '    [--threshold 10] [--cooldown 60] [--min-drop N] [--home <dir>] [--dir <dir>] [--state <file>]',
  '    [--face name=path[;path] ...] [--set-mode observe|notify]',
  '  缺省 dry-run（只算不写不发）；--apply 才写状态；--notify（或状态里 mode=notify）才真发告警。',
].join('\n');

function defaultDshHome() { return path.join(os.homedir(), '.dsh'); }
function defaultDshRoot() { return workspaceRoot(); }

/**
 * 默认 8 面表（**面的口径本身就是本卡的交付物**，见报告 §2）。
 * roots 可多个 = 合成一个面数（会话 + 归档）。
 */
export function buildDefaultFaces({ home, dshRoot }) {
  return [
    { name: 'sessions', label: '会话（含归档）', roots: [path.join(home, 'sessions'), path.join(home, '_archived-sessions')],
      note: '合并计数：归档搬走不算消失、真被删才算' },
    { name: 'skills', label: '自建技能', roots: [path.join(home, 'skills')], note: '少一件都该看一眼' },
    { name: 'agent-presets', label: 'persona 载体', roots: [path.join(home, '.agent-presets')], note: '件数极少，跌 1 件也超阈' },
    { name: 'imagegen', label: '生图库', roots: [path.join(home, 'dsh-imagegen')], note: '含 gallery/canvas/templates' },
    { name: 'attachments', label: '会话附件', roots: [path.join(home, 'attachments')], note: '只增不减' },
    { name: 'task-board', label: '看板账本', roots: [path.join(home, 'task-board')], note: '账本 + 归档批次' },
    { name: 'docs', label: `${dshRoot}\\docs`, roots: [path.join(dshRoot, 'docs')], note: '写得多、搬得也多；阈值最紧的一面' },
    { name: 'tools', label: `${dshRoot}\\tools`, roots: [path.join(dshRoot, 'tools')], note: '跳过 node_modules（实测 3,901 件由此而来）' },
  ];
}

/** 递归数条目（目录 + 文件各算 1；只 readdir/stat，不读内容）。 */
export function countEntries(root) {
  const stack = [root];
  let n = 0;
  let dirs = 0;
  let files = 0;
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 子目录读不到（权限/瞬时） → 不算条目、不炸
    }
    for (const e of ents) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      n++;
      if (e.isDirectory()) {
        dirs++;
        stack.push(path.join(dir, e.name));
      } else {
        files++;
      }
    }
  }
  return { count: n, dirs, files };
}

/** 数一个面：多根合并；全部根都不存在 ⇒ unknown（**不当 0**）。 */
export function countFace(face, cache) {
  let total = 0;
  let dirs = 0;
  let files = 0;
  let present = 0;
  const missing = [];
  for (const root of face.roots) {
    if (!fs.existsSync(root)) {
      missing.push(root);
      continue;
    }
    present++;
    let c = cache.get(root);
    if (!c) {
      c = countEntries(root);
      cache.set(root, c);
    }
    total += c.count;
    dirs += c.dirs;
    files += c.files;
  }
  return { count: total, dirs, files, present, missing, unknown: present === 0 };
}

/** `_archive` 顶层（只读一层）：「迁移 vs 消失」的廉价信号 = 本轮是否**有新/刚改动的顶层条目**。
 *  判据取 mtime > 上次运行时刻（目录 mtime 会因内部搬入而更新 ⇒ 老桶收新文件也算"有归档动作"）。
 *  @returns {{count:number, recent:string[]}|null}
 */
export function readArchiveTop(dshRoot, sinceMs = null) {
  const dir = path.join(dshRoot, '_archive');
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const recent = [];
  for (const e of ents) {
    if (!Number.isFinite(sinceMs)) continue;
    try {
      if (fs.statSync(path.join(dir, e.name)).mtimeMs > sinceMs) recent.push(e.name);
    } catch { /* 单个条目读不到不影响整轮 */ }
  }
  return { count: ents.length, recent };
}

function stateFileOf(name, home, override) {
  if (override) return path.resolve(override);
  return resolveStatePath(name, { home }).path;
}

function loadState(stateFile) {
  const base = {
    schemaVersion: VANISH_WATCH_SCHEMA, mode: 'observe', faces: {}, shadow: {},
    events: [], cooldowns: {}, lastRunAt: null,
  };
  try {
    const cur = readJson(stateFile, { defaultValue: null });
    if (cur && typeof cur === 'object') {
      return {
        ...base, ...cur,
        mode: cur.mode === 'notify' ? 'notify' : 'observe',
        faces: cur.faces ?? {},
        shadow: cur.shadow ?? {},
        events: Array.isArray(cur.events) ? cur.events : [],
        cooldowns: cur.cooldowns ?? {},
      };
    }
  } catch { /* 首次运行 / 状态坏 → 重建（可重建，非权威数据） */ }
  return base;
}

/**
 * 跑一轮（纯函数化便于夹具演练：now / home / dshRoot / faces / stateFile / dryRun 全可注入）。
 * @returns {{ok:boolean, mode:string, notify:boolean, dryRun:boolean, faces:Array, events:Array, alerted:number, errors:Array, stateFile:string}}
 */
export function runOnce(opts = {}) {
  const home = opts.home ?? defaultDshHome();
  const dshRoot = opts.dshRoot ?? defaultDshRoot();
  const stateFile = stateFileOf(STATE_NAME, home, opts.stateFile);
  const dryRun = opts.dryRun !== false;           // 缺省 dry-run（安全默认）
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD_PCT;
  const cooldownMs = (Number.isFinite(opts.cooldownMin) ? opts.cooldownMin : DEFAULT_COOLDOWN_MIN) * 60_000;
  const minDrop = Number.isFinite(opts.minDrop) ? opts.minDrop : 0;
  const now = opts.now ?? Date.now();
  const faces = Array.isArray(opts.faces) && opts.faces.length ? opts.faces : buildDefaultFaces({ home, dshRoot });
  const cache = new Map();

  const state = loadState(stateFile);
  // **observe 优先**：只有"状态里是 notify 或本轮显式 --notify"才真发；显式 --observe 压过状态。
  const mode = opts.mode === 'notify' ? 'notify' : opts.mode === 'observe' ? 'observe' : state.mode;
  const notify = mode === 'notify';

  // `_archive` 顶层：每次只 readdir 一层 + stat 顶层条目（毫秒级），本轮"迁移 vs 消失"的对照基准
  const archiveNow = readArchiveTop(dshRoot, Number.isFinite(state.lastRunAt) ? state.lastRunAt : null);
  const archiveTop = archiveNow ? archiveNow.count : null;
  const archiveNew = archiveNow ? archiveNow.recent : [];
  const result = {
    ok: true, mode, notify, dryRun, threshold, cooldownMin: cooldownMs / 60_000,
    faces: [], events: [], alerted: 0, errors: [], stateFile,
    archiveTop, archiveTopPrev: state.shadow?.archiveTop ?? null, archiveNew: archiveNew.slice(0, 10),
  };

  const nextFaces = { ...state.faces };
  const nextCooldowns = { ...state.cooldowns };
  const newEvents = [];

  for (const face of faces) {
    const c = countFace(face, cache);
    const prev = state.faces[face.name];
    const row = {
      name: face.name, label: face.label ?? face.name, roots: face.roots,
      count: c.unknown ? null : c.count, dirs: c.dirs, files: c.files,
      unknown: c.unknown, missing: c.missing,
      prevCount: Number.isFinite(prev?.count) ? prev.count : null,
      prevAt: prev?.at ?? null, dropPct: 0, drop: 0, fired: false, kind: null,
      event: null, skipped: null,
    };

    if (c.unknown) {
      // 读不到 ⇒ unknown：**不写 count、不比、不告警**（恢复期目录可能临时不在）
      row.skipped = 'unknown（根目录不存在：不按 0 处理、不告警）';
      // 只在"刚变成 unknown"那一次记事件，避免每 5 分钟刷同一条把真事件挤出 events
      if (prev?.unknown !== true) {
        newEvents.push({ at: now, face: face.name, kind: 'unknown', missing: c.missing, note: row.skipped });
      }
      nextFaces[face.name] = { count: Number.isFinite(prev?.count) ? prev.count : null, at: prev?.at ?? null, unknown: true, unknownSince: prev?.unknownSince ?? now };
      result.faces.push(row);
      continue;
    }

    if (Number.isFinite(prev?.count) && prev.count > 0) {
      const drop = prev.count - c.count;
      const dropPct = (drop / prev.count) * 100;
      row.drop = drop;
      row.dropPct = Math.round(dropPct * 100) / 100;
      if (drop > 0 && dropPct > threshold && drop >= minDrop) {
        row.fired = true;
      }
    }

    if (row.fired) {
      // 迁移 vs 消失：本轮 `_archive` 顶层是否**多出新条目**（廉价信号，限制见头部说明）
      //   ⚠️ 只改**标签**、**不改级别** —— 新建备份目录同样会命中"多出新条目"，
      //     启发式可能把"真删"误标成"迁移"⇒ 绝不能因此降级成 warn（那才是漏报风险）。
      const migrated = archiveNew.length > 0;
      row.kind = migrated ? '迁移' : '消失';
      const level = 'error';
      const lastAlertAt = state.cooldowns?.[face.name] ?? 0;
      const cooling = now - lastAlertAt < cooldownMs;
      const ev = {
        at: now, face: face.name, kind: row.kind, level,
        prevCount: prev?.count ?? null, count: c.count,
        drop: row.drop, dropPct: row.dropPct,
        prevAt: prev?.at ?? null, archiveTop: archiveTop ?? null, archiveTopPrev: state.shadow?.archiveTop ?? null,
        newArchiveEntries: archiveNew.slice(0, 5),
        cooldown: cooling, alerted: false,
      };
      if (cooling) {
        row.skipped = `冷却中（上次告警 ${Math.round((now - lastAlertAt) / 60_000)} 分钟前 < ${cooldownMs / 60_000} 分钟）`;
      } else if (!notify) {
        row.skipped = 'observe 档：只记事件、不调 alert（放行 = --set-mode notify）';
      } else if (dryRun) {
        row.skipped = 'dry-run：不调 alert（加 --apply 才发）';
      } else {
        const r = alert({
          level,
          source: 'vanish-watch',
          message: `${face.label ?? face.name} 件数断崖：${prev?.count} → ${c.count}（跌 ${row.dropPct}%，判定「${row.kind}」）`,
          detail: {
            face: face.name, lastCount: prev?.count ?? null, count: c.count,
            dropPct: row.dropPct, lastAt: prev?.at ?? null,
            kind: row.kind, thresholdPct: threshold,
            archiveTop: archiveTop ?? null, archiveTopPrev: state.shadow?.archiveTop ?? null,
            newArchiveEntries: archiveNew.slice(0, 5),
            roots: face.roots,
          },
        }, { home, silent: true });
        ev.alerted = true;
        ev.alertOk = r.ok !== false;
        if (r.ok === false) result.errors.push({ face: face.name, error: `alert 写盘失败：${r.error ?? 'unknown'}` });
        nextCooldowns[face.name] = now;
        result.alerted++;
      }
      row.event = ev;
      newEvents.push(ev);
    } else if (row.prevCount === null) {
      row.skipped = '首次读数：建基线（不比）';
    } else if (row.drop <= 0) {
      row.skipped = '未减';
    } else {
      row.skipped = `跌幅 ${row.dropPct}% ≤ 阈值 ${threshold}%`;
    }

    nextFaces[face.name] = { count: c.count, at: now };
    result.faces.push(row);
  }

  // 本轮 `_archive` 顶层读数（每轮都刷新；判迁移时与它比的是**上一轮**的值）
  const archiveTopNow = Number.isFinite(archiveTop) ? archiveTop : (state.shadow?.archiveTop ?? null);

  const mergedEvents = [...state.events, ...newEvents].slice(-MAX_EVENTS);
  result.events = newEvents;

  if (!dryRun) {
    const next = {
      schemaVersion: VANISH_WATCH_SCHEMA,
      mode,
      faces: nextFaces,
      // shadow 只存"上一轮 _archive 顶层条目数"（8 面读数在 faces 里；**别把名字集合写进状态**——
      // 上一版存 2000 个名字把状态撑到 83 KB，白耗写盘）
      shadow: Number.isFinite(archiveTopNow) ? { archiveTop: archiveTopNow } : {},
      events: mergedEvents,
      cooldowns: nextCooldowns,
      lastRunAt: now,
    };
    try {
      writeJsonAtomic(stateFile, next);
    } catch (e) {
      result.ok = false;
      result.errors.push({ face: '(state)', error: `状态写盘失败：${e?.message ?? e}` });
    }
  }

  return result;
}

/** `--status`：只读现状（当前读数 / 上次读数 / 跌幅 / 冷却 / 模式），零写入。 */
export function statusOnce(opts = {}) {
  const home = opts.home ?? defaultDshHome();
  const dshRoot = opts.dshRoot ?? defaultDshRoot();
  const stateFile = stateFileOf(STATE_NAME, home, opts.stateFile);
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD_PCT;
  const state = loadState(stateFile);
  const cache = new Map();
  const faces = Array.isArray(opts.faces) && opts.faces.length ? opts.faces : buildDefaultFaces({ home, dshRoot });
  const rows = faces.map((face) => {
    const c = countFace(face, cache);
    const prev = state.faces[face.name];
    const dropPct = Number.isFinite(prev?.count) && prev.count > 0
      ? Math.round(((prev.count - (c.unknown ? prev.count : c.count)) / prev.count) * 10000) / 100 : 0;
    return {
      name: face.name, label: face.label ?? face.name,
      count: c.unknown ? null : c.count, unknown: c.unknown, missing: c.missing,
      prevCount: Number.isFinite(prev?.count) ? prev.count : null,
      prevAt: prev?.at ?? null, dropPct,
      lastAlertAt: state.cooldowns?.[face.name] ?? null,
    };
  });
  return {
    stateFile, mode: state.mode, lastRunAt: state.lastRunAt,
    threshold, archiveTop: state.shadow?.archiveTop ?? null,
    archiveTopNow: (readArchiveTop(dshRoot)?.count ?? null),
    events: state.events.slice(-5), rows,
  };
}

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function printRound(r) {
  console.log(`[vanish-watch] ${fmtTs(Date.now())} · 模式=${r.mode}${r.notify ? '（真发）' : '（observe：只记不发）'} · ${r.dryRun ? 'dry-run（不写状态）' : 'apply'} · 阈值 ${r.threshold}%`);
  for (const f of r.faces) {
    const cur = f.unknown ? 'unknown' : f.count;
    console.log(
      `  ${(f.name + '').padEnd(15)} 本次 ${String(cur).padStart(6)}  上次 ${String(f.prevCount ?? '-').padStart(6)}`
      + `  跌 ${String(f.dropPct).padStart(6)}%  ${f.fired ? '🔴 ' + f.kind : '✅'}`
      + (f.skipped ? `  · ${f.skipped}` : ''),
    );
    if (f.missing?.length) console.log(`     缺：${f.missing.join(' ; ')}`);
  }
  console.log(`  汇总：判出 ${r.faces.filter((f) => f.fired).length} 面 / 真发告警 ${r.alerted} 条 / 状态文件 ${r.stateFile}`);
  for (const e of r.errors) console.log(`  ! ${e.face}：${e.error}`);
}

function printStatus(s) {
  console.log(`[vanish-watch --status] 只读 · 状态文件 ${s.stateFile}`);
  console.log(`  模式=${s.mode} · 上次运行=${fmtTs(s.lastRunAt)} · 阈值 ${s.threshold}% · _archive 顶层 上次=${s.archiveTop ?? '-'} / 现在=${s.archiveTopNow ?? '-'}`);
  console.log('');
  console.log('  面               本次读数   上次读数   跌幅%    上次读数时间          上次告警');
  for (const r of s.rows) {
    console.log(
      '  ' + r.name.padEnd(16),
      String(r.unknown ? 'unknown' : r.count).padStart(7),
      String(r.prevCount ?? '-').padStart(9),
      String(r.dropPct).padStart(7),
      ('  ' + fmtTs(r.prevAt)).padEnd(22),
      fmtTs(r.lastAlertAt),
    );
    if (r.missing?.length) console.log(`     缺：${r.missing.join(' ; ')}`);
  }
  if (s.events.length) {
    console.log('');
    console.log('  最近事件（最多 5 条）：');
    for (const e of s.events) {
      console.log(`   - ${fmtTs(e.at)} ${e.face} ${e.kind ?? ''} ${e.prevCount ?? '-'} → ${e.count ?? '-'}（${e.dropPct ?? '-'}%）${e.alerted ? ' 已告警' : ' 未告警'}`);
    }
  }
}

function parseFaces(argv, i) {
  const spec = argv[i];
  const eq = spec.indexOf('=');
  if (eq <= 0) throw new Error(`--face 需要 name=path[;path]：${spec}`);
  const name = spec.slice(0, eq).trim();
  const roots = spec.slice(eq + 1).split(';').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p));
  if (!name || !roots.length) throw new Error(`--face 参数不完整：${spec}`);
  return { name, label: name, roots, note: 'cli 注入（夹具/排障）' };
}

function isMainEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = {
    once: false, loop: false, apply: false, status: false, json: false,
    mode: null, threshold: null, cooldownMin: null, minDrop: null,
    home: null, dshRoot: null, stateFile: null, faces: [], setMode: null, intervalMs: 300_000,
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--once') opt.once = true;
      else if (a === '--loop') opt.loop = true;
      else if (a === '--apply') opt.apply = true;
      else if (a === '--dry-run') opt.apply = false;
      else if (a === '--status') opt.status = true;
      else if (a === '--json') opt.json = true;
      else if (a === '--notify') opt.mode = 'notify';
      else if (a === '--observe') opt.mode = 'observe';
      else if (a === '--threshold') opt.threshold = Number(argv[++i]);
      else if (a === '--cooldown') opt.cooldownMin = Number(argv[++i]);
      else if (a === '--min-drop') opt.minDrop = Number(argv[++i]);
      else if (a === '--home') opt.home = argv[++i];
      else if (a === '--dir') opt.dshRoot = argv[++i];
      else if (a === '--state') opt.stateFile = argv[++i];
      else if (a === '--interval') opt.intervalMs = Number(argv[++i]) * 1000;
      else if (a === '--face') { i++; opt.faces.push(parseFaces(argv, i)); }
      else if (a === '--set-mode') opt.setMode = argv[++i];
      else if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
      else throw new Error(`未知参数：${a}`);
    }
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return 2;
  }
  for (const k of ['threshold', 'cooldownMin', 'minDrop']) {
    if (opt[k] !== null && !Number.isFinite(opt[k])) {
      console.error(`--${k === 'cooldownMin' ? 'cooldown' : k === 'minDrop' ? 'min-drop' : k} 需要数字`);
      return 2;
    }
  }
  if (opt.setMode && !['observe', 'notify'].includes(opt.setMode)) {
    console.error('--set-mode 只认 observe|notify');
    return 2;
  }

  const base = {
    home: opt.home ? path.resolve(opt.home) : undefined,
    dshRoot: opt.dshRoot ? path.resolve(opt.dshRoot) : undefined,
    stateFile: opt.stateFile ?? undefined,
    faces: opt.faces,
    threshold: opt.threshold ?? undefined,
    cooldownMin: opt.cooldownMin ?? undefined,
    minDrop: opt.minDrop ?? undefined,
  };

  // 放行/关回开关（只改状态文件的 mode 字段，不改代码）
  if (opt.setMode) {
    const home = base.home ?? defaultDshHome();
    const stateFile = stateFileOf(STATE_NAME, home, base.stateFile);
    const st = loadState(stateFile);
    if (opt.apply !== true) {
      console.log(`[vanish-watch] dry-run：将把 ${stateFile} 的 mode 改为 ${opt.setMode}（加 --apply 真改）`);
      return 0;
    }
    st.mode = opt.setMode;
    try {
      writeJsonAtomic(stateFile, { ...st, schemaVersion: VANISH_WATCH_SCHEMA });
    } catch (e) {
      console.error(`[vanish-watch] 改 mode 失败：${e?.message ?? e}`);
      return 1;
    }
    console.log(`[vanish-watch] mode → ${opt.setMode}（${stateFile}）`);
    return 0;
  }

  if (opt.status) {
    const s = statusOnce(base);
    if (opt.json) process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    else printStatus(s);
    return 0;
  }

  const runOpts = { ...base, mode: opt.mode ?? undefined, dryRun: opt.apply !== true, now: Date.now() };
  if (!opt.loop) {
    const r = runOnce(runOpts);
    if (opt.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else printRound(r);
    return r.ok ? 0 : 1;
  }
  // 常驻模式（可选；生产走 tickd 5 分钟一次性，用不到）
  for (;;) {
    const r = runOnce({ ...runOpts, now: Date.now() });
    if (opt.json) process.stdout.write(JSON.stringify(r) + '\n');
    else printRound(r);
    await new Promise((res) => setTimeout(res, Math.max(30_000, opt.intervalMs)));
  }
}

if (isMainEntry()) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`dsh-vanish-watch 失败：${e?.stack ?? e?.message ?? e}`);
    process.exitCode = 1;
  });
}
