#!/usr/bin/env node
// dsh-butler / dsh-snapshot-tick.mjs —— R-071 第②件：定时快照 + 异地镜像自动化
//
// 为什么要有它（事故真源 `docs\事故-20261020-DSH数据被清-自查与补齐.md`）：
//   2026-10-19 23:48 起 `~\.dsh` 与 `<workspace>` 被删掉 4,000+ 件（会话 / 技能 / 归档 / 生图库 / 凭据），
//   当时**没有任何自动快照**，救命靠 PEER-HOST 上的会话镜像 + 卷影。第②道防线 = 每 30 分钟一份
//   增量快照 + 每日一次异地镜像，且**凭据一律不进包**。
//
// 口径（与手工快照 `_archive\snapshots\dshhome-20261020-0147\` 同一批路径，只多不多）：
//   home 下 7 个关键目录（sessions / skills / storages / task-board / memory / memory-vectors /
//   .agent-presets）+ home 顶层的全部**普通文件**（>16MB 的跳过并登记）。
//   **不纳入**：`_archived-sessions`（现 2.4 GB）· `attachments`（381 MB）· `profiles`（junction 丛林）
//     —— 体量决定（6 份 × 2.4 GB 会爆盘）。覆盖缺口写在交付报告「已知缺口」段，不藏着。
//
// 🔴 凭据（硬约束 1）：`.credentials.yaml` / `*credentials*` / `keys\` / `*.key` / `*.pem|pfx|p12` /
//   `id_rsa|id_ed25519` / `mailbox.key` —— 遍历时就排除（只记名字，绝不读内容）；
//   **快照写完再自查一遍**，命中即：删掉本次快照 + 告警 + rc=4（fail-closed）。
//   异地包同样在**本地**（tar -tzf）与**远端**（tar -tzf）各查一遍，命中即删包、rc≠0、绝不记为成功。
//
// 🔴 junction（硬约束 2）：遍历一律 `lstat`，遇 symlink/junction **不跟随、不复制**（记入 skipped）。
//
// 增量（硬约束 4）：与上一份（我们自己生成的、manifest 有效的最新一份）比 ——
//   · mtime+size 完全一致 且 文件类型"可硬链接" ⇒ `fs.linkSync`（同卷零拷贝）
//   · 否则 copyFileSync
//   **永不硬链接的类型**（可能被原地追加写的）：`.jsonl` / `.zstd` / `.log` / `.db(-wal|-shm)` / `.csv` / `.ndjson`
//   —— 硬链接共享 inode，源文件原地 append 会把**旧快照**一起改掉，这是必须规避的真实风险（rsync --link-dest 同款限制）。
//
// 保留（硬约束 3）：只清**我们自己生成的**份（manifest.generator === 'dsh-snapshot-tick'）；
//   手工件 / 无 manifest 的旧件**一律不碰**。删除一律走 `tools\safe-rm-tree.mjs`（先 plan 打印、再 apply）。
//
// 异地镜像：默认**每日一次**（state.lastMirroredDay ≠ 今天）或显式 `--push-now`。
//   打包 → 自查 → 经 `lib\peer-channel.mjs` 择路（lan 优先 → 隧道回落，公司有线网按需短租）→
//   scp 到 `PEER-HOST:<drive>\dsh-home-backup\` → **远端验包**（字节数 + tar -tzf 条目数 + 凭据自查）→ 才记成功。
//   任一步失败：state.lastError + alert + rc=5（**不许静默跳过**）。
//
// 🔴 tar 写法口径（2026-10-22 · 异地镜像连败 11 次的修复，报告 `docs\交付报告-V3功能面-快照镜像tar修复-20261022.md`）：
//   本机存在**两种** tar —— Windows 自带 `%SystemRoot%\System32\tar.exe`（bsdtar 3.8.9）与
//   Git for Windows 的 `<sysdrive>\Program Files\Git\usr\bin\tar.exe`（**GNU tar 1.35**）。PATH 里命中哪个取决于
//   启动者（tickd 子进程实测曾解析到 GNU tar）。两者的交集只有一种写法：**`-f` 给相对文件名 + `cwd`** ——
//   · GNU tar 把 `-f <sysdrive>\...` 当 rsh 远程主机 ⇒ `Cannot connect to C: resolve failed`、rc=2；
//   · bsdtar 不认 `--force-local` ⇒ 加开关只对 GNU 生效，不是通用解。
//   ⇒ 一律走 `resolveTarExe()` 解析可执行（System32 优先、不依赖 PATH 语义）+ `cwd` 传相对名。
//
// 远端保留（R-071⑤）：镜像成功（字节/条目/凭据三验都过）之后，才清远端旧包 ——
//   只删**本工具产出的** `dshhome-<8位日期>-<4位时刻>[-N].tgz`（名字正则严判）、**永远留最新一份**、
//   手工救命包 `dshhome-20261020-0147.tgz` **点名保护**；`--remote-keep`（默认 7，≈一周）·
//   `--no-remote-prune` 关掉。清单可疑（>10 个 / 一个不剩 / 把最新算进去）⇒ **拒动 rc=6**。
//   删除一律单文件 `ssh <别名> "del /q <路径>"`（**不用 /s 递归**），删完必须重新列目录核对。
//
// 状态文件：`<home>\butler-snapshot-tick.json`（小、可读；--home 夹具时跟着假 home 走，不污染真 home）
//
// 用法：
//   node dsh-snapshot-tick.mjs [--once] [--apply] [--push-now] [--status] [--json]
//     [--keep 6] [--hours 72] [--home <dir>] [--out <dir>] [--state <file>]
//     [--no-mirror] [--no-prune] [--no-tunnel-rent] [--push-host <ssh别名>] [--reason "<为什么>"]
//   缺省 **dry-run**：只规划、只打印（不建目录、不写状态、不打包）；`--apply` 才真写。
//   `--status` 只读（列最近几份 / 件数 / 字节 / 最老 / 镜像现状），零写入。
// 退出码：0 正常（含 dry-run）/ 1 自身失败 / 2 用法 / 3 快照失败 / 4 凭据混入（fail-closed）/ 5 异地镜像失败
//         / 6 远端保留未完成（拒动或删后复查不符；镜像本身已成功）。
// **收尾一律 process.exitCode**（house rule：禁 process.exit）。
import fs from 'node:fs';
import { workspaceRoot } from './lib/ws-root.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStatePath } from '../src/dsh-butler/lib/state-paths.mjs';
import { readJson, writeJsonAtomic } from '../src/dsh-butler/lib/store.mjs';
import { alert } from '../src/dsh-butler/lib/alert.mjs';
import { ensurePeerChannel, releasePeerChannel } from '../src/lib/peer-channel.mjs';
import { planRemove, applyRemove } from './ext/safe-rm-tree.mjs';

export const SNAPSHOT_TICK_VERSION = '0.1.0';
export const SNAPSHOT_TICK_SCHEMA = 1;
export const GENERATOR = 'dsh-snapshot-tick';
export const STATE_NAME = 'butler-snapshot-tick.json';
export const DEFAULT_KEEP = 6;
export const DEFAULT_HOURS = 72;
/** 远端保留份数（R-071⑤）：默认 7 ≈ 一周（每日一份镜像）。 */
export const DEFAULT_REMOTE_KEEP = 7;
/** 远端包名**严判**：只认本工具产出的 `dshhome-YYYYMMDD-HHmm(.tgz)`（同分钟补跑会带 `-2` 后缀）。 */
export const REMOTE_TGZ_RE = /^dshhome-(\d{8})-(\d{4})(?:-(\d+))?\.tgz$/;
/** 点名保护：事故当晚手工打的救命包（**任何 --remote-keep / 任何情况都不得删**）。 */
export const REMOTE_PROTECT = Object.freeze(['dshhome-20261020-0147.tgz']);
/** 单轮允许删除的硬上限：算出来超过这个数 ⇒ 判「清单可疑」⇒ 拒动（rc≠0）。 */
export const REMOTE_PRUNE_MAX = 10;
export const DEFAULT_OUT = path.join(process.env.DSH_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME || '.', 'dsh-workspace'), '_archive', 'snapshots');
export const DEFAULT_REMOTE_DIR = process.env.DSH_REMOTE_BACKUP_DIR || path.join(os.homedir(), 'dsh-home-backup');
export const MIRROR_HOSTS = Object.freeze(['peer-lan', 'peer-host']);   // lan 优先 → 隧道回落
export const MAX_HISTORY = 12;
export const TOP_LEVEL_MAX_BYTES = 16 * 1024 * 1024;

/** 快照白名单目录（与手工快照 dshhome-20261020-0147 同口径）。 */
export const INCLUDE_DIRS = Object.freeze([
  'sessions', 'skills', 'storages', 'task-board', 'memory', 'memory-vectors', '.agent-presets',
]);

/**
 * 递归跳过（依赖 / VCS / 家人日程数据）。
 *
 * `family-calendar`（2026-10-29 · N3 卡 · 真源 `docs\方案-家人日程提醒-分期一期-v13-20261029.md` §5 C6）：
 *   整目录**永不进**快照与配置整包 —— 里面是家人真实日程 + 亲属关系
 *   （`events.json` / `relations.json` / `reminded.jsonl` / `audit.jsonl` / `activation.json`），
 *   既不该进冷备与 `--keep` 回灌面，也不该出现在任何"配置整包"里。
 *   🔴 **一个改动点同时管两边**：`config-snapshot.mjs:297` 复用本件的 `collectSource`
 *   （同一函数 `config-snapshot.mjs:82` 以 `collectSnapshotSource` 导入）⇒ 这里加一条，
 *   快照与配置整包一起生效。**不要**另建排除名单：`config-snapshot.mjs:296-307` 是收集后按基名过滤，
 *   而 `collectSource` 只有 3 个参数、没有排除入参（插进去就是第三份死名单）。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'family-calendar']);

/** **永不硬链接**：可能被原地追加写 ⇒ 硬链会污染旧快照。 */
const HARD_LINK_UNSAFE = /\.(jsonl|ndjson|jsonl\.zstd|zstd|log|db|db-wal|db-shm|csv)$/i;

const CRED_FILE_RULES = Object.freeze([
  { rule: 'dot-credentials', test: (b) => /^\.credentials(\.[^.]*)?$/i.test(b) },
  { rule: 'credentials-in-name', test: (b) => /credentials?/i.test(b) },
  { rule: 'key-ext', test: (b) => /\.(key|pem|pfx|p12)$/i.test(b) },
  { rule: 'ssh-or-mailbox-key', test: (b) => /^(mailbox\.key|id_rsa.*|id_ed25519.*|known_hosts)$/i.test(b) },
]);
const CRED_DIR_RULE = /^keys?$/i;

const USAGE = [
  'dsh-snapshot-tick —— R-071② 定时增量快照 + 每日异地镜像（R-071⑤ 补远端保留）',
  '  node dsh-snapshot-tick.mjs [--once] [--apply] [--push-now] [--status] [--json]',
  '    [--keep 6] [--hours 72] [--home <dir>] [--out <dir>] [--state <file>]',
  '    [--no-mirror] [--no-prune] [--no-tunnel-rent] [--push-host <ssh别名>]',
  '    [--remote-keep 7] [--no-remote-prune] [--reason "<为什么>"]',
  '  缺省 dry-run（只规划不写）；--apply 才真写。--status 只读。',
  '  远端保留：镜像成功后只删本工具产出的 dshhome-<8位日期>-<4位时刻>[-N].tgz；',
  '    永远保留最新一份、手工件 dshhome-20261020-0147.tgz 点名保护；先打印清单再删。',
].join('\n');

// ────────────────────────────── 基础工具 ──────────────────────────────

function defaultHome() { return path.join(os.homedir(), '.dsh'); }

function stateFileOf(home, override) {
  if (override) return path.resolve(override);
  return resolveStatePath(STATE_NAME, { home }).path;
}

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function stampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `dshhome-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

/** 凭据判据（同一份规则用在：遍历排除 / 本地快照自查 / 异地包自查 / 远端包自查）。 */
export function credentialRuleOf(relPath) {
  const parts = String(relPath).split(/[\\/]+/).filter(Boolean);
  for (const p of parts.slice(0, -1)) if (CRED_DIR_RULE.test(p)) return { rule: 'key-dir', hit: `目录 ${p}` };
  const base = parts.length ? parts[parts.length - 1] : String(relPath);
  for (const r of CRED_FILE_RULES) if (r.test(base)) return { rule: r.rule, hit: base };
  return null;
}

/** 硬链接安全性（按扩展名）：不安全 ⇒ 本轮必复制。 */
export function hardLinkSafe(relPath) {
  return !HARD_LINK_UNSAFE.test(String(relPath));
}

function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }

/** 递归收集源文件（lstat；junction 不跟随；凭据/跳过目录登记后丢弃）。 */
export function collectSource({ home, includeDirs = INCLUDE_DIRS, topLevelMaxBytes = TOP_LEVEL_MAX_BYTES }) {
  const files = [];
  const excluded = [];
  const skipped = [];
  const missing = [];

  const addFile = (abs, rel) => {
    const st = lstatOrNull(abs);
    if (!st) { skipped.push({ rel, reason: 'lstat 失败（瞬时）' }); return; }
    files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
  };

  const pushSkip = (rel, reason) => skipped.push({ rel, reason });

  const visit = (abs, rel) => {
    const st = lstatOrNull(abs);
    if (!st) { pushSkip(rel, 'lstat 失败（瞬时）'); return; }
    if (st.isSymbolicLink()) { pushSkip(rel, 'junction/symbolic-link（不跟随）'); return; }
    const cred = credentialRuleOf(rel);
    if (cred) { excluded.push({ rel, ...cred }); return; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(abs))) { pushSkip(rel, `跳过目录（依赖 / VCS / 家人日程）：${path.basename(abs)}`); return; }
      let ents;
      try { ents = fs.readdirSync(abs); } catch (e) { pushSkip(rel, `readdir 失败：${e?.message ?? e}`); return; }
      for (const name of ents.sort()) visit(path.join(abs, name), `${rel}/${name}`);
      return;
    }
    if (!st.isFile()) { pushSkip(rel, '非普通文件（设备/管道等）'); return; }
    files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
  };

  // ① 顶层文件（不含目录）：这是 `.anonymous-user-id` 之类小件的来源
  let topEnts = [];
  try { topEnts = fs.readdirSync(home); } catch (e) {
    return { files, excluded, skipped, missing: [`${home}：${e?.message ?? e}`], fatal: `源根不可读：${home}` };
  }
  for (const name of topEnts.sort()) {
    const abs = path.join(home, name);
    const st = lstatOrNull(abs);
    if (!st) { pushSkip(name, 'lstat 失败（瞬时）'); continue; }
    if (st.isDirectory()) continue;                       // 目录只走白名单
    if (st.isSymbolicLink()) { pushSkip(name, 'junction/symbolic-link（不跟随）'); continue; }
    const cred = credentialRuleOf(name);
    if (cred) { excluded.push({ rel: name, ...cred }); continue; }
    if (!st.isFile()) { pushSkip(name, '非普通文件'); continue; }
    if (st.size > topLevelMaxBytes) { pushSkip(name, `顶层单文件 > ${fmtBytes(topLevelMaxBytes)}`); continue; }
    addFile(abs, name);
  }

  // ② 白名单目录
  for (const d of includeDirs) {
    const abs = path.join(home, d);
    if (!fs.existsSync(abs)) { missing.push(d); continue; }
    visit(abs, d);
  }

  return { files, excluded, skipped, missing };
}

/** out 下的份（按名字倒序 = 新到旧）。 */
export function listSnapshots(out) {
  let ents = [];
  try { ents = fs.readdirSync(out, { withFileTypes: true }); } catch { return []; }
  const rows = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (!/^dshhome-\d{8}-\d{4}(-\d+)?$/.test(e.name)) continue;
    const dir = path.join(out, e.name);
    const st = lstatOrNull(dir);
    const mf = readJson(path.join(dir, 'manifest.json'), { defaultValue: null });
    rows.push({
      name: e.name, dir,
      mtimeMs: st?.mtimeMs ?? 0,
      generator: mf?.generator ?? null,
      files: Number.isFinite(mf?.files) ? mf.files : null,
      bytes: Number.isFinite(mf?.bytes) ? mf.bytes : null,
      ok: mf ? mf.ok !== false : null,
      manual: !mf?.generator,
    });
  }
  rows.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return rows;
}

/** 上一份（我们自己生成、manifest 有效、且不是本轮）——硬链接的源。 */
function findPrev(rows, currentName) {
  return rows.find((r) => r.generator === GENERATOR && r.ok !== false && r.name !== currentName) ?? null;
}

/** 唯一名：`used`（state 里的已用名台账）也算占用 —— 被保留策略删掉的旧名**绝不复用**，
 *  否则同分钟补跑会生成"名字更小却更新"的份，按名排序的最新/最老判断就会错（2026-10-20 夹具演练实测踩到）。 */
function uniqueName(out, base, used = []) {
  const taken = new Set(Array.isArray(used) ? used : []);
  let name = base;
  let n = 1;
  while (fs.existsSync(path.join(out, name)) || taken.has(name)) { n++; name = `${base}-${n}`; }
  return name;
}

/** 决策：这一条是硬链接还是复制。 */
export function decideAction(entry, prevDir) {
  if (!hardLinkSafe(entry.rel)) return 'copy';
  if (!prevDir) return 'copy';
  const p = path.join(prevDir, entry.rel);
  const st = lstatOrNull(p);
  if (!st || !st.isFile()) return 'copy';
  if (st.size !== entry.size) return 'copy';
  if (Math.abs(st.mtimeMs - entry.mtimeMs) > 1) return 'copy';
  return 'link';
}

// ────────────────────────────── 一轮快照 ──────────────────────────────

export function runOnce(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const home = path.resolve(opts.home ?? defaultHome());
  const out = path.resolve(opts.out ?? DEFAULT_OUT);
  const keep = Number(opts.keep ?? DEFAULT_KEEP);
  const hours = Number(opts.hours ?? DEFAULT_HOURS);
  const dryRun = opts.dryRun !== false;
  const doPrune = opts.prune !== false;
  const doMirror = opts.mirror !== false;
  const pushNow = opts.pushNow === true;
  const stateFile = stateFileOf(home, opts.stateFile);
  const t0 = Date.now();
  const result = {
    ok: false, dryRun, home, out, stateFile, name: null, dir: null,
    files: 0, bytes: 0, newBytes: 0, copied: 0, linked: 0, dirs: 0,
    excluded: [], skipped: [], missing: [], credentialCheck: { ok: true, hits: [] },
    prev: null, prune: null, mirror: null, errors: [], elapsedMs: 0, now,
  };

  const src = collectSource({ home, includeDirs: opts.includeDirs ?? INCLUDE_DIRS });
  if (src.fatal) { result.errors.push(src.fatal); result.elapsedMs = Date.now() - t0; return result; }
  result.files = src.files.length;
  result.bytes = src.files.reduce((s, f) => s + f.size, 0);
  result.excluded = src.excluded;
  result.skipped = src.skipped;
  result.missing = src.missing;
  result.dirs = new Set(src.files.map((f) => path.dirname(f.rel))).size;

  const rows = listSnapshots(out);
  const usedNames = readJson(stateFile, { defaultValue: null })?.usedNames ?? [];
  const name = uniqueName(out, stampName(new Date(now)), usedNames);
  const prev = findPrev(rows, name);
  result.prev = prev?.name ?? null;
  result.name = name;
  result.dir = path.join(out, name);

  // 规划（dry-run 也走这一步，好让演练能打印"预计新写入多少字节"）
  const plan = src.files.map((f) => {
    const action = decideAction(f, prev?.dir ?? null);
    if (action === 'copy') { result.copied++; result.newBytes += f.size; } else result.linked++;
    return { ...f, action };
  });

  if (dryRun) {
    result.ok = true;
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // 落地
  try {
    fs.mkdirSync(result.dir, { recursive: true });
    for (const f of plan) {
      const dest = path.join(result.dir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (f.action === 'link') {
        try { fs.linkSync(path.join(prev.dir, f.rel), dest); continue; } catch {
          // 硬链接失败（跨卷 / 权限 / 目标在别卷）⇒ 回退复制
          fs.copyFileSync(f.abs, dest);
          result.linked--; result.copied++; result.newBytes += f.size;
          continue;
        }
      }
      fs.copyFileSync(f.abs, dest);
    }
  } catch (e) {
    result.errors.push(`复制阶段失败：${e?.message ?? e}`);
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // 凭据自查（写完再看一遍文件名 —— fail-closed）
  const hits = [];
  const stack = [result.dir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      const rel = path.relative(result.dir, abs).split(path.sep).join('/');
      if (e.isSymbolicLink()) { hits.push({ rel, rule: 'symlink-in-snapshot' }); continue; }
      const cred = credentialRuleOf(rel);
      if (cred) { hits.push({ rel, ...cred }); continue; }
      if (e.isDirectory()) stack.push(abs);
    }
  }
  result.credentialCheck = { ok: hits.length === 0, hits };
  if (hits.length) {
    // 绝不留下含凭据的快照
    const rm = planRemove(result.dir, { roots: [out, workspaceRoot()] });
    if (rm.ok) applyRemove(rm, { dryRun: false });
    result.errors.push(`凭据混入快照（${hits.map((h) => h.rel).join(', ')}）⇒ 已删除本次快照，fail-closed`);
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // manifest
  const manifest = {
    schemaVersion: SNAPSHOT_TICK_SCHEMA, generator: GENERATOR, version: SNAPSHOT_TICK_VERSION,
    ts: new Date(now).toISOString(), tsLocal: fmtTs(now), snapshot: name,
    sourceRoot: home, includeDirs: opts.includeDirs ?? INCLUDE_DIRS,
    files: result.files, bytes: result.bytes, newBytes: result.newBytes,
    copied: result.copied, linked: result.linked,
    prev: result.prev, excluded: result.excluded, skipped: result.skipped, missing: result.missing,
    credentialCheck: result.credentialCheck, ok: true, elapsedMs: Date.now() - t0,
    host: os.hostname(),
  };
  try { writeJsonAtomic(path.join(result.dir, 'manifest.json'), manifest); } catch (e) {
    result.errors.push(`写 manifest 失败：${e?.message ?? e}`);
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // 清理（只碰我们自己生成的份；先 plan 打印、再 apply）
  if (doPrune) result.prune = pruneSnapshots({ out, keep, hours, dryRun: false, protect: name, currentTs: now });

  result.ok = true;
  result.elapsedMs = Date.now() - t0;

  // 异地镜像（每日一次 / --push-now；失败后退避 60 分钟，见 shouldMirror）
  if (doMirror) {
    const judge = pushNow ? { due: true } : shouldMirror(stateFile, now);
    if (judge.due) {
      result.mirror = mirrorSnapshot({
        out, name, stateFile, now, dryRun: false,
        hosts: opts.pushHosts, allowRent: opts.allowRent !== false, log: opts.log,
        remoteKeep: opts.remoteKeep ?? DEFAULT_REMOTE_KEEP, remotePrune: opts.remotePrune !== false,
      });
    } else {
      result.mirror = { skipped: judge.reason, day: judge.day, sinceMin: judge.sinceMin };
    }
  }
  result.elapsedMs = Date.now() - t0;
  return result;
}

/** 每日一次判据 + **失败退避**：今天已成功 ⇒ 不再镜像；上次失败 60 分钟内 ⇒ 不重试
 *  （否则对端长期不可达时，每 30 分钟一轮都会探通道 + 报警，把真告警额度挤掉）。
 *  `--push-now` 绕过一切判据。 */
export const MIRROR_FAIL_COOLDOWN_MIN = 60;
export function shouldMirror(stateFile, now = Date.now(), cooldownMin = MIRROR_FAIL_COOLDOWN_MIN) {
  const st = readJson(stateFile, { defaultValue: null });
  const today = localDay(new Date(now));
  if (st?.lastMirroredDay === today) return { due: false, reason: 'already-mirrored-today', day: today };
  const failedAt = Date.parse(st?.lastMirrorFailedAt ?? '');
  if (Number.isFinite(failedAt) && now - failedAt < cooldownMin * 60_000) {
    return { due: false, reason: 'cooldown-after-failure', day: today, sinceMin: Math.round((now - failedAt) / 60_000) };
  }
  return { due: true };
}

/** 保留策略：keep 为硬上限；hours 为兜底（超龄的旧份即使没到 keep 上限也删，但永远保留最新一份）。 */
export function pruneSnapshots({ out, keep, hours, dryRun = true, protect = null, currentTs = Date.now() }) {
  const rows = listSnapshots(out);
  const ours = rows.filter((r) => r.generator === GENERATOR);
  const decisions = [];
  ours.forEach((r, idx) => {
    if (protect && r.name === protect) { decisions.push({ name: r.name, action: 'keep', why: '本轮刚生成' }); return; }
    const ageH = (currentTs - r.mtimeMs) / 3_600_000;
    if (idx === 0) { decisions.push({ name: r.name, action: 'keep', why: '最新一份' }); return; }
    if (idx >= keep) { decisions.push({ name: r.name, action: 'remove', why: `超出保留份数 ${keep}（第 ${idx + 1} 新）`, ageHours: Number(ageH.toFixed(1)) }); return; }
    if (ageH > hours) { decisions.push({ name: r.name, action: 'remove', why: `超龄 ${ageH.toFixed(1)}h > ${hours}h`, ageHours: Number(ageH.toFixed(1)) }); return; }
    decisions.push({ name: r.name, action: 'keep', why: '在保留窗口内', ageHours: Number(ageH.toFixed(1)) });
  });

  const removed = [];
  const refused = [];
  for (const d of decisions) {
    if (d.action !== 'remove') continue;
    const dir = path.join(out, d.name);
    const p = planRemove(dir, { roots: [out, workspaceRoot()] });
    if (!p.ok) { refused.push({ name: d.name, error: p.error }); continue; }
    const planned = { name: d.name, files: p.files.length, bytes: p.bytes, symlinks: p.symlinks.length, why: d.why };
    if (!dryRun) {
      const res = applyRemove(p, { dryRun: false });
      planned.deleted = res.errors.length === 0;
      planned.errors = res.errors.length ? res.errors.slice(0, 5) : undefined;
      removed.push(planned);
    } else {
      removed.push({ ...planned, dryRun: true });
    }
  }
  return { keep, hours, decisions, removed, refused, totalOurs: ours.length };
}

// ────────────────────────────── 异地镜像 ──────────────────────────────

function runCmd(cmd, args, { timeoutMs = 120_000, cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { rc: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), signal: r.signal ?? null };
}

// ── tar 可执行解析（2026-10-22 R-071 连败修复）────────────────────────────
// 🔴 环境事实：tickd 子进程继承的 PATH 里 `tar` 落到 `<sysdrive>\Program Files\Git\usr\bin\tar.exe`
//    = **GNU tar 1.35**（不是 Windows 自带的 bsdtar）。GNU tar 把 `-f <sysdrive>\...` 当 **rsh 远程主机**语法
//    ⇒ `tar (child): Cannot connect to C: resolve failed`、`Cannot write: Broken pipe`、rc=2。
//    而且 GNU tar 不吃「绝对路径」、bsdtar 不吃 `--force-local` ⇒ 唯一两种都吃的写法是
//    **cwd + 相对文件名**（两条路都实测过，见交付报告 docs\交付报告-V3功能面-快照镜像tar修复-20261022.md）。
/** Windows 自带 bsdtar；存在就优先用它（不依赖 PATH 语义），否则退回 PATH 的 `tar`。 */
export const SYSTEM_TAR = path.join(process.env.SystemRoot || process.env.WINDIR || '', 'System32', 'tar.exe');
let _tarExeLogged = false;
function resolveTarExe({ log = () => {} } = {}) {
  const exe = fs.existsSync(SYSTEM_TAR) ? SYSTEM_TAR : 'tar';
  if (!_tarExeLogged) {
    _tarExeLogged = true;
    log(`  tar 可执行：${exe}${exe === 'tar' ? '（System32 缺失 ⇒ 退回 PATH，注意 GNU tar 不吃 -f 绝对路径）' : ''}`);
  }
  return exe;
}

/** 列包：cwd + 相对文件名（绝对路径喂给 GNU tar 会被当远程主机）。 */
function tarList(tgz) {
  const cwd = path.dirname(tgz);
  const r = runCmd(resolveTarExe(), ['-tzf', path.basename(tgz)], { timeoutMs: 180_000, cwd });
  if (r.rc !== 0) return { ok: false, rc: r.rc, err: r.err || 'tar -tzf 失败', entries: [] };
  const entries = r.out.split(/\r?\n/).filter(Boolean);
  return { ok: true, entries };
}

/** 包内凭据自查（**同一条规则**，只数名字不读内容）。 */
export function scanEntriesForCredentials(entries) {
  const hits = [];
  for (const e of entries) {
    const cred = credentialRuleOf(e);
    if (cred) hits.push({ entry: e, ...cred });
  }
  return hits;
}

/** 探针：ensurePeerChannel 传进来的是 candidate 对象（{channel,target,via}），也兼容裸字符串。 */
function probeHost(candidate) {
  const target = typeof candidate === 'string' ? candidate : candidate?.target;
  if (!target) return { ok: false, err: 'probe 没拿到目标主机名' };
  const r = runCmd('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', target, 'hostname'], { timeoutMs: 20_000 });
  return {
    ok: r.rc === 0 && /host-c/i.test(r.out),
    err: r.rc === 0 ? `hostname=${r.out}` : (r.err || `rc=${r.rc}`),
    hostname: r.out,
  };
}

/** 择路（lan 优先 → 隧道回落 → 公司有线网按需短租）。**先探通道、再打包** ——
 *  通道不通时不必白打 77 MB 的包（外出/公司网下对端不可达是常态，2026-10-20 修）。 */
export function resolveChannel({ hosts, allowRent = true, dryRun = false, log = () => {}, probe = probeHost } = {}) {
  const list = Array.isArray(hosts) && hosts.length ? hosts : MIRROR_HOSTS;
  try {
    const ch = ensurePeerChannel({
      candidates: list.map((h) => ({ channel: h.endsWith('-lan') ? 'lan' : 'tunnel', target: h })),
      probe,
      owner: 'dsh-snapshot-tick',
      allowRent: allowRent !== false,
      dryRun,
      log,
    });
    if (!ch.ok) {
      return {
        ok: false, tried: ch.tried ?? [],
        error: `通道不通（试过 ${(ch.tried ?? []).map((t) => `${t.channel}:${t.err}`).join(' ; ') || '无候选'}）`
          + (ch.rent?.skipped ? ` · 短租=${ch.rent.skipped}` : ''),
      };
    }
    return { ok: true, lease: ch.lease ?? null, target: ch.target, channel: ch.channel, hostname: ch.hostname, tried: ch.tried ?? [] };
  } catch (e) {
    return { ok: false, tried: [], error: `择路异常：${e?.message ?? e}` };
  }
}

export function mirrorSnapshot(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const out = path.resolve(opts.out ?? DEFAULT_OUT);
  const name = opts.name;
  const dir = path.join(out, name);
  const hosts = Array.isArray(opts.hosts) && opts.hosts.length ? opts.hosts : MIRROR_HOSTS;
  const dryRun = opts.dryRun === true;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const stateFile = opts.stateFile;
  const remoteDir = opts.remoteDir ?? DEFAULT_REMOTE_DIR;
  const res = { ok: false, snapshot: name, tgz: null, bytes: null, remote: null, remoteBytes: null, entries: null, channel: null, tried: [], errors: [] };

  if (!fs.existsSync(dir)) { res.errors.push(`快照不存在：${dir}`); res.error = res.errors[0]; return res; }
  const tgzName = `${name}.tgz`;
  const tgz = path.join(os.tmpdir(), `snapshot-tick-${tgzName}`);
  res.tgz = tgz;

  if (dryRun) { res.ok = true; res.dryRun = true; res.note = `dry-run：将打包 ${name} → ${hosts[0]}:${remoteDir}/${tgzName}`; return res; }

  // ① 择路（**先探通道、再打包**：通道不通就不必白打 77 MB 的包）
  let lease = null;
  let target = null;
  {
    const ch = resolveChannel({ hosts, allowRent: opts.allowRent !== false, log, probe: opts.probe });
    res.tried = ch.tried ?? [];
    if (!ch.ok) { res.errors.push(ch.error); res.error = ch.error; return res; }
    lease = ch.lease ?? null;
    target = ch.target;
    res.channel = ch.channel;
    res.hostname = ch.hostname;
    log(`  通道 OK：${ch.channel} → ${ch.target}（hostname=${ch.hostname}）`);
  }

  /** 打包/自查阶段（还没 upload）的失败出口：归还短租 + 删临时包，别把租约和 77 MB 临时件留在生产。 */
  const fail = (msg) => {
    res.errors.push(msg);
    res.error = res.errors[0];
    cleanupTgz(tgz);
    try { releasePeerChannel(lease, { log }); } catch { /* 归还失败不掩盖主错误 */ }
    lease = null;
    return res;
  };

  // ② 打包（cwd + 相对文件名：GNU tar 与 bsdtar 都吃；见 resolveTarExe 注释）
  const tarExe = resolveTarExe({ log });
  const tar = runCmd(tarExe, ['-czf', path.basename(tgz), '-C', out, name], { timeoutMs: 600_000, cwd: path.dirname(tgz) });
  if (tar.rc !== 0) return fail(`打包失败 rc=${tar.rc}：${tar.err || tar.out}`);
  const st = lstatOrNull(tgz);
  res.bytes = st?.size ?? null;
  log(`  打包完成：${tgz}（${fmtBytes(res.bytes)}）`);

  // ③ 本地包自查（fail-closed：命中即删包，绝不外发）
  const listed = tarList(tgz);
  if (!listed.ok) return fail(`本地验包失败：${listed.err}`);
  const localHits = scanEntriesForCredentials(listed.entries);
  res.entries = listed.entries.length;
  if (localHits.length) {
    return fail(`本地包内命中凭据文件名（${localHits.map((h) => h.entry).join(', ')}）⇒ 已删包，fail-closed`);
  }

  try {
    // ④ 上传
    const up = runCmd('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', tgz, `${target}:${remoteDir}/${tgzName}`], { timeoutMs: 900_000 });
    if (up.rc !== 0) { res.errors.push(`scp 失败 rc=${up.rc}：${up.err || up.out}`); res.error = res.errors[0]; return finalize(); }
    log(`  上传完成：${target}:${remoteDir}/${tgzName}`);

    // ⑤ 远端验包：字节数
    const remotePath = `${remoteDir}/${tgzName}`;
    const sizeCmd = `powershell -NoProfile -Command "(Get-Item '${remotePath}').Length"`;
    const sizeR = runCmd('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, sizeCmd], { timeoutMs: 120_000 });
    const remoteBytes = Number((sizeR.out || '').replace(/[^\d]/g, ''));
    res.remoteBytes = Number.isFinite(remoteBytes) && remoteBytes > 0 ? remoteBytes : null;
    if (sizeR.rc !== 0 || !res.remoteBytes) {
      res.errors.push(`远端字节数读不到（rc=${sizeR.rc}）：${sizeR.err || sizeR.out}`);
      res.error = res.errors[0];
      return finalize();
    }
    if (res.remoteBytes !== res.bytes) {
      res.errors.push(`远端字节数不符：本地 ${res.bytes} vs 远端 ${res.remoteBytes}`);
      res.error = res.errors[0];
      return finalize();
    }

    // ⑥ 远端验包：能列出内容 + 再查一次凭据
    const listR = runCmd('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, `tar -tzf ${remotePath}`], { timeoutMs: 300_000 });
    if (listR.rc !== 0) { res.errors.push(`远端 tar -tzf 失败 rc=${listR.rc}：${listR.err || listR.out}`); res.error = res.errors[0]; return finalize(); }
    const remoteEntries = listR.out.split(/\r?\n/).filter(Boolean);
    res.remoteEntries = remoteEntries.length;
    const remoteHits = scanEntriesForCredentials(remoteEntries);
    if (remoteHits.length || remoteEntries.length === 0) {
      res.errors.push(remoteHits.length
        ? `远端包内命中凭据（${remoteHits.map((h) => h.entry).join(', ')}）⇒ 记为失败，fail-closed`
        : '远端包列不出内容（0 条）');
      res.error = res.errors[0];
      return finalize();
    }

    res.remote = `${target}:${remoteDir}/${tgzName}`;
    res.ok = true;

    // ⑦ 远端保留（R-071⑤）：镜像已经完整验过（字节 / 条目 / 凭据）才动远端其它包。
    //    只删本工具产出的（名字严判）、永远留最新一份、手工件点名保护；先打印清单再删。
    //    拒动 / 失败**不推翻"这次镜像成功"**（包确实上去了），但 res.ok 之外再挂错误 ⇒ main 返回 6 让人看见。
    if (opts.remotePrune !== false) {
      res.remotePrune = pruneRemote({
        target, remoteDir, keep: opts.remoteKeep ?? DEFAULT_REMOTE_KEEP,
        dryRun: false, log,
      });
      if (!res.remotePrune.ok) res.errors.push(`远端保留：${res.remotePrune.error}`);
    }
  } finally {
    // ⑦ 无论成败：删本地临时包（成功也要删，否则 <tmp> 里每天堆 77 MB）+ 归还短租（只关"本次由我开的"）
    cleanupTgz(tgz);
    try {
      const rel = releasePeerChannel(lease, { log });
      res.release = rel;
    } catch (e) { res.errors.push(`归还短租异常：${e?.message ?? e}`); }
  }

  function finalize() { return res; }
  // 🔴 必须显式返回：缺这一行时"镜像真跑成了"但调用方拿到 undefined ⇒ 状态不记账、
  //   打印缺行、失败也判不出来（2026-10-20 生产首跑实测踩到，rc 侥幸为 0）。
  return res;
}

// ───────────────────── 远端保留（R-071⑤：别让 PEER-HOST 无限长）─────────────────────
//
// 只动**本工具产出的** `dshhome-<8位日期>-<4位时刻>[-N].tgz`：
//   · 名字正则严判（`REMOTE_TGZ_RE`），别的文件一律不进候选；
//   · `dshhome-20261020-0147.tgz` = 事故当晚手工打的救命包 ⇒ **点名保护**（任何参数都不删）；
//   · **永远保留最新一份**（哪怕 --remote-keep 1）；
//   · 先 dry-run/打印清单，再真删；清单可疑（>10 个 / 一个不剩 / 把最新算了进去）⇒ **拒动 rc≠0**；
//   · 单文件 `del /q`（**绝不用 `/s` 递归**），删后必须重新列目录核对。

/** 远端包排序键：日期+时刻为主键，同分钟补跑的 `-N` 后缀按**数字**比（字典序会把 -10 排到 -2 前）。 */
function remoteTgzKey(name) {
  const m = REMOTE_TGZ_RE.exec(String(name ?? '').trim());
  if (!m) return null;
  return { base: `${m[1]}${m[2]}`, seq: m[3] ? Number(m[3]) : 1 };
}

function remoteTgzCmpDesc(a, b) {
  const ka = remoteTgzKey(a?.name);
  const kb = remoteTgzKey(b?.name);
  if (!ka || !kb) return 0;
  if (ka.base !== kb.base) return ka.base < kb.base ? 1 : -1;
  return kb.seq - ka.seq;
}

/** **纯函数**（不碰网络，夹具可直接跑）：给定远端清单算出该删哪些。
 *  规则：① 名字严判 ② 点名保护件永不进候选 ③ 永远留最新 ④ 留最近 keep 份 ⑤ 清单可疑 ⇒ refused。 */
export function planRemotePrune(entries, { keep = DEFAULT_REMOTE_KEEP, protect = REMOTE_PROTECT } = {}) {
  const keepN = Number(keep);
  const protectedSet = new Set(Array.isArray(protect) ? protect : []);
  const all = (Array.isArray(entries) ? entries : [])
    .map((e) => ({ name: String(e?.name ?? '').trim(), bytes: Number(e?.bytes) || 0 }))
    .filter((e) => REMOTE_TGZ_RE.test(e.name));
  const ours = all.filter((e) => !protectedSet.has(e.name)).sort(remoteTgzCmpDesc);
  const newest = ours[0]?.name ?? null;
  const effectiveKeep = Number.isFinite(keepN) && keepN >= 1 ? keepN : DEFAULT_REMOTE_KEEP;
  const keepList = ours.slice(0, effectiveKeep).map((x) => x.name);
  const keepSet = new Set([...keepList, ...(newest ? [newest] : [])]);
  const remove = ours.filter((e) => !keepSet.has(e.name));
  const remain = ours.length - remove.length;
  const freedBytes = remove.reduce((s, e) => s + e.bytes, 0);
  const refused = [];
  if (!Number.isFinite(keepN) || keepN < 1) refused.push('--remote-keep 需要 ≥1 的数字');
  if (remove.length > REMOTE_PRUNE_MAX) refused.push(`要删 ${remove.length} 个 > 单轮硬上限 ${REMOTE_PRUNE_MAX}（清单可疑）`);
  if (ours.length > 0 && remain < 1) refused.push('算完一个自建包都不剩');
  if (newest && remove.some((e) => e.name === newest)) refused.push('清单把最新一份算进了删除项');
  if (remove.some((e) => protectedSet.has(e.name))) refused.push('清单里出现点名保护的手工件');
  return {
    total: all.length, ours: ours.length, newest, keep: effectiveKeep, keepList,
    remove, freedBytes, remain,
    protectedPresent: [...protectedSet].filter((n) => all.some((e) => e.name === n)),
    refused: refused.length ? refused.join(' · ') : null,
  };
}

function winPath(p) { return String(p).replace(/\//g, '\\'); }

function sshRun(target, cmd, timeoutMs) {
  return runCmd('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, cmd], { timeoutMs });
}

/** 远端清单（只读；PS 5.1 可用的 `Get-ChildItem`，不碰 CIM —— 见技能 cross-host-ops §2.9）。 */
export function listRemoteTgz({ target, remoteDir = DEFAULT_REMOTE_DIR, ssh = sshRun } = {}) {
  const dirWin = winPath(remoteDir);
  const cmd = `powershell -NoProfile -Command "Get-ChildItem -File '${dirWin}\\*.tgz' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name + '|' + $_.Length }"`;
  const r = ssh(target, cmd, 120_000);
  if (r.rc !== 0) return { ok: false, rc: r.rc, error: `远端列目录失败 rc=${r.rc}：${r.err || r.out}`, entries: [] };
  const entries = [];
  for (const line of String(r.out).split(/\r?\n/)) {
    const t = line.trim();
    const i = t.lastIndexOf('|');
    if (i <= 0) continue;
    const name = t.slice(0, i).trim();
    if (!REMOTE_TGZ_RE.test(name)) continue;
    entries.push({ name, bytes: Number(t.slice(i + 1).replace(/[^\d]/g, '')) || 0 });
  }
  return { ok: true, entries };
}

/** 远端保留主流程：列 → plan → 打印 → 删 → 复查。返回 {ok, beforeOurs, afterOurs, removed, ...}。 */
export function pruneRemote({ target, remoteDir = DEFAULT_REMOTE_DIR, keep = DEFAULT_REMOTE_KEEP, dryRun = true, ssh = sshRun } = {}) {
  const before = listRemoteTgz({ target, remoteDir, ssh });
  if (!before.ok) return { ok: false, refused: true, error: before.error, before: [], after: [] };
  const plan = planRemotePrune(before.entries, { keep });
  console.log(`  远端保留：现有 ${before.entries.length} 个 tgz（自建 ${plan.ours} · 最新 ${plan.newest ?? '无'}）· keep=${plan.keep}`);
  for (const e of plan.remove) console.log(`   - 待删 ${e.name}（${fmtBytes(e.bytes)}）`);
  if (!plan.remove.length) console.log('   - 无需删除（份数在保留窗口内）');
  if (plan.refused) {
    console.log(`  远端保留：🔴 拒动 —— ${plan.refused}`);
    return { ok: false, refused: true, error: plan.refused, plan, before: before.entries, after: [] };
  }
  if (dryRun) {
    console.log(`  远端保留：dry-run（将删 ${plan.remove.length} 个 / ${fmtBytes(plan.freedBytes)}，删后剩 ${plan.remain} 份自建）`);
    return { ok: true, dryRun: true, plan, before: before.entries, after: before.entries, removed: [], freedBytes: 0, beforeOurs: plan.ours, afterOurs: plan.ours, protectedStillThere: true };
  }
  if (!plan.remove.length) {
    return { ok: true, plan, before: before.entries, after: before.entries, removed: [], freedBytes: 0, beforeOurs: plan.ours, afterOurs: plan.ours, protectedStillThere: true };
  }

  const removed = [];
  const failures = [];
  for (const e of plan.remove) {
    const pathWin = `${winPath(remoteDir)}\\${e.name}`;
    const r = ssh(target, `del /q "${pathWin}"`, 60_000);
    // ⚠️ cmd 的 del 对"文件不存在"也可能返回 0 ⇒ 成败只认**删后复查**，不认 rc 独自说话
    if (r.rc !== 0) failures.push(`${e.name}：rc=${r.rc} ${(r.err || r.out).slice(0, 200)}`);
    else removed.push({ name: e.name, bytes: e.bytes });
  }
  const after = listRemoteTgz({ target, remoteDir, ssh });
  if (!after.ok) {
    return { ok: false, error: `删后复查列目录失败：${after.error}`, plan, before: before.entries, after: [], removed, failures, beforeOurs: plan.ours };
  }
  const afterNames = new Set(after.entries.map((x) => x.name));
  const afterOursRows = after.entries.filter((e) => REMOTE_TGZ_RE.test(e.name) && !REMOTE_PROTECT.includes(e.name));
  const stillThere = plan.remove.filter((e) => afterNames.has(e.name)).map((e) => e.name);
  const newestAfter = plan.newest ? after.entries.find((e) => e.name === plan.newest) ?? null : null;
  const protectedMissing = plan.protectedPresent.filter((n) => !afterNames.has(n));
  const newestBefore = plan.newest ? before.entries.find((e) => e.name === plan.newest)?.bytes ?? 0 : 0;
  const problems = [];
  if (failures.length) problems.push(`删失败：${failures.join(' · ')}`);
  if (stillThere.length) problems.push(`该删的还在：${stillThere.join(', ')}`);
  if (protectedMissing.length) problems.push(`点名保护的没了：${protectedMissing.join(', ')}`);
  if (plan.newest && !newestAfter) problems.push(`最新那份不见了：${plan.newest}`);
  if (newestAfter && newestBefore && newestAfter.bytes !== newestBefore) problems.push(`最新那份字节变了：${newestBefore} → ${newestAfter.bytes}`);
  if (afterOursRows.length > plan.keep) problems.push(`删后自建份 ${afterOursRows.length} > keep ${plan.keep}`);
  if (afterOursRows.length < 1) problems.push('删后自建份 = 0（本该永远留最新一份）');
  const freedBytes = removed.reduce((s, e) => s + e.bytes, 0);
  console.log(`  远端保留：${problems.length ? '🔴' : '✅'} before ${plan.ours} → after ${afterOursRows.length} 份自建（删 ${removed.length} 个 / ${fmtBytes(freedBytes)}）`
    + (problems.length ? ` —— ${problems.join(' · ')}` : ' · 最新包字节不变 · 手工件仍在'));
  return {
    ok: problems.length === 0, error: problems.join(' · ') || null, plan,
    before: before.entries, after: after.entries, removed, failures, freedBytes,
    beforeOurs: plan.ours, afterOurs: afterOursRows.length,
    protectedStillThere: protectedMissing.length === 0,
  };
}

function cleanupTgz(tgz) {
  try { if (tgz && fs.existsSync(tgz)) fs.unlinkSync(tgz); } catch { /* 临时件删不掉不影响判定 */ }
}

// ────────────────────────────── 状态 / 打印 ──────────────────────────────

function loadState(stateFile) {
  const st = readJson(stateFile, { defaultValue: null });
  const base = {
    schemaVersion: SNAPSHOT_TICK_SCHEMA, lastRunAt: null, lastOkAt: null, lastError: null,
    lastSnapshot: null, lastMirroredDay: null, lastMirror: null, history: [], usedNames: [],
    totals: { runs: 0, failures: 0, mirrorRuns: 0, mirrorFailures: 0 },
  };
  return st && typeof st === 'object' ? { ...base, ...st } : base;
}

function saveRound(stateFile, result, mirror) {
  const st = loadState(stateFile);
  const now = Date.now();
  st.lastRunAt = new Date(now).toISOString();
  st.schemaVersion = SNAPSHOT_TICK_SCHEMA;
  st.totals = st.totals ?? { runs: 0, failures: 0, mirrorRuns: 0, mirrorFailures: 0 };
  st.totals.runs = (st.totals.runs ?? 0) + 1;
  if (!result.ok) {
    st.totals.failures = (st.totals.failures ?? 0) + 1;
    st.lastError = { at: st.lastRunAt, stage: 'snapshot', message: result.errors.join(' | ') || '未知名错误' };
  } else {
    st.lastOkAt = st.lastRunAt;
    st.lastSnapshot = {
      name: result.name, at: st.lastRunAt, files: result.files, bytes: result.bytes,
      newBytes: result.newBytes, copied: result.copied, linked: result.linked, elapsedMs: result.elapsedMs,
    };
    if (st.lastError?.stage === 'snapshot') st.lastError = null;
  }
  if (mirror && !mirror.skipped) {
    st.totals.mirrorRuns = (st.totals.mirrorRuns ?? 0) + 1;
    if (mirror.ok) {
      st.lastMirroredDay = localDay(new Date(now));
      st.lastMirrorFailedAt = null;
      st.lastMirror = {
        at: st.lastRunAt, snapshot: mirror.snapshot, bytes: mirror.bytes, remoteBytes: mirror.remoteBytes,
        remote: mirror.remote, entries: mirror.entries, channel: mirror.channel, remoteEntries: mirror.remoteEntries,
      };
      if (st.lastError?.stage === 'mirror') st.lastError = null;
    } else {
      st.totals.mirrorFailures = (st.totals.mirrorFailures ?? 0) + 1;
      st.lastMirrorFailedAt = st.lastRunAt;     // 退避起点（shouldMirror 用）
      st.lastError = { at: st.lastRunAt, stage: 'mirror', message: (mirror.errors ?? []).join(' | ') || '镜像失败' };
    }
  }
  st.history = [{ at: st.lastRunAt, name: result.name, ok: result.ok, files: result.files, bytes: result.bytes, newBytes: result.newBytes, mirrorOk: mirror && !mirror.skipped ? !!mirror.ok : null }, ...(st.history ?? [])].slice(0, MAX_HISTORY);
  // 已用名台账：被保留策略裁掉的旧名也记着，永不复用（见 uniqueName 注释）
  st.usedNames = [result.name, ...(Array.isArray(st.usedNames) ? st.usedNames : [])].filter(Boolean).slice(0, 200);
  try { writeJsonAtomic(stateFile, st); } catch (e) { result.errors.push(`写状态失败：${e?.message ?? e}`); }
  return st;
}

function printRound(r, { keep, hours } = {}) {
  console.log(`[snapshot-tick] ${fmtTs(r.now)} · ${r.dryRun ? 'dry-run（不写盘）' : 'apply'} · 源 ${r.home}`);
  console.log(`  快照名 ${r.name}${r.dryRun ? '（预计）' : ''} · 落点 ${r.dir}`);
  console.log(`  件数 ${r.files} · 逻辑 ${fmtBytes(r.bytes)} · 本轮新写入 ${fmtBytes(r.newBytes)}（复制 ${r.copied} / 硬链 ${r.linked}）`
    + ` · 上一份 ${r.prev ?? '无（首份全量）'}`);
  if (r.excluded.length) {
    console.log(`  排除 ${r.excluded.length} 项（凭据类，只记名字）：`);
    for (const e of r.excluded.slice(0, 10)) console.log(`   - ${e.rel}  [${e.rule}]`);
  }
  if (r.skipped.length) {
    console.log(`  跳过 ${r.skipped.length} 项：`);
    for (const s of r.skipped.slice(0, 8)) console.log(`   - ${s.rel}  (${s.reason})`);
  }
  if (r.missing.length) console.log(`  源根缺失：${r.missing.join(' / ')}`);
  console.log(`  凭据自查：${r.credentialCheck.ok ? '✅ 未命中' : '🔴 命中 ' + r.credentialCheck.hits.map((h) => h.rel).join(', ')}`);
  if (r.prune) {
    console.log(`  保留策略（keep=${keep ?? r.prune.keep} / hours=${hours ?? r.prune.hours}h）：共 ${r.prune.totalOurs} 份自建份`);
    for (const d of r.prune.decisions) console.log(`   - ${d.name} · ${d.action === 'remove' ? '删' : '留'} · ${d.why}`);
    for (const x of r.prune.removed) console.log(`     ↳ 已删 ${x.name}（${x.files} 件 / ${fmtBytes(x.bytes)}${x.deleted === false ? ' · 有错误' : ''}）`);
    for (const x of r.prune.refused) console.log(`     ↳ 拒删 ${x.name}：${x.error}`);
  }
  if (r.mirror) {
    if (r.mirror.skipped) console.log(`  异地镜像：跳过（${r.mirror.skipped}${r.mirror.day ? ' · ' + r.mirror.day : ''}）`);
    else if (r.mirror.ok) console.log(`  异地镜像：✅ ${r.mirror.remote}（本地 ${fmtBytes(r.mirror.bytes)} / 远端 ${fmtBytes(r.mirror.remoteBytes)} · ${r.mirror.remoteEntries} 条目 · 通道 ${r.mirror.channel}）`);
    else console.log(`  异地镜像：🔴 失败 —— ${(r.mirror.errors ?? []).join(' | ')}`);
    if (r.mirror.remotePrune && !r.mirror.remotePrune.ok) {
      console.log(`  远端保留：🔴 ${r.mirror.remotePrune.refused ? '拒动' : '失败'} —— ${r.mirror.remotePrune.error}`);
    }
  }
  console.log(`  耗时 ${r.elapsedMs} ms · ${r.ok ? '✅' : '🔴 ' + r.errors.join(' | ')}`);
}

function printStatus({ out, stateFile, keep, hours }) {
  const rows = listSnapshots(out);
  const st = loadState(stateFile);
  const ours = rows.filter((r) => r.generator === GENERATOR);
  console.log(`[snapshot-tick --status] 只读 · 快照根 ${out}`);
  console.log(`  共 ${rows.length} 份（自建 ${ours.length} · 手工/无 manifest ${rows.length - ours.length}）· 保留策略 keep=${keep} / hours=${hours}h`);
  console.log('');
  console.log('  份名                      件数      字节        本轮净增   生成时间             类型');
  for (const r of rows) {
    const mfPath = path.join(r.dir, 'manifest.json');
    const mf = readJson(mfPath, { defaultValue: null });
    console.log(
      '  ' + r.name.padEnd(24),
      String(r.files ?? '-').padStart(7),
      fmtBytes(r.bytes ?? 0).padStart(11),
      (mf?.newBytes !== undefined ? fmtBytes(mf.newBytes) : '-').padStart(10),
      ('  ' + fmtTs(r.mtimeMs)).padEnd(22),
      r.manual ? '手工/无 manifest（**本件不碰**）' : (r.ok === false ? '自建·校验失败' : '自建'),
    );
  }
  console.log('');
  console.log(`  状态文件 ${stateFile}`);
  console.log(`  上次运行 ${fmtTs(Date.parse(st.lastRunAt))} · 上次成功 ${fmtTs(Date.parse(st.lastOkAt))}`);
  if (st.lastSnapshot) console.log(`  上次快照 ${st.lastSnapshot.name} · ${st.lastSnapshot.files} 件 / ${fmtBytes(st.lastSnapshot.bytes)}（净增 ${fmtBytes(st.lastSnapshot.newBytes)} · ${st.lastSnapshot.elapsedMs} ms）`);
  console.log(`  每日镜像：lastMirroredDay=${st.lastMirroredDay ?? '从未'}（今天 ${localDay()} ⇒ ${st.lastMirroredDay === localDay() ? '今天已镜像' : '本轮到期'}）`);
  if (st.lastMirror) console.log(`  上次镜像 ${fmtTs(Date.parse(st.lastMirror.at))} · ${st.lastMirror.remote} · 本地 ${fmtBytes(st.lastMirror.bytes)} / 远端 ${fmtBytes(st.lastMirror.remoteBytes)} · 通道 ${st.lastMirror.channel}`);
  if (st.lastError) console.log(`  🔴 最近错误 ${st.lastError.at} [${{ snapshot: '快照', mirror: '镜像' }[st.lastError.stage] ?? st.lastError.stage}] ${st.lastError.message}`);
  console.log(`  累计：运行 ${st.totals?.runs ?? 0}（失败 ${st.totals?.failures ?? 0}）· 镜像 ${st.totals?.mirrorRuns ?? 0}（失败 ${st.totals?.mirrorFailures ?? 0}）`);
  if (rows.length) {
    const oldest = rows[rows.length - 1];
    console.log(`  最老一份 ${oldest.name}（${fmtTs(oldest.mtimeMs)}）· 最新 ${rows[0].name}`);
  }
}

// ────────────────────────────── CLI ──────────────────────────────

function isMainEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = {
    once: false, apply: false, status: false, json: false, pushNow: false,
    keep: null, hours: null, home: null, out: null, state: null,
    mirror: true, prune: true, allowRent: true, pushHost: null, reason: null,
    remoteKeep: null, remotePrune: true,
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--once') opt.once = true;
      else if (a === '--apply') opt.apply = true;
      else if (a === '--dry-run') opt.apply = false;
      else if (a === '--push-now') opt.pushNow = true;
      else if (a === '--status') opt.status = true;
      else if (a === '--json') opt.json = true;
      else if (a === '--keep') opt.keep = Number(argv[++i]);
      else if (a === '--hours') opt.hours = Number(argv[++i]);
      else if (a === '--home') opt.home = argv[++i];
      else if (a === '--out') opt.out = argv[++i];
      else if (a === '--state') opt.state = argv[++i];
      else if (a === '--no-mirror') opt.mirror = false;
      else if (a === '--no-prune') opt.prune = false;
      else if (a === '--no-tunnel-rent') opt.allowRent = false;
      else if (a === '--push-host') opt.pushHost = argv[++i];
      else if (a === '--remote-keep') opt.remoteKeep = Number(argv[++i]);
      else if (a === '--no-remote-prune') opt.remotePrune = false;
      else if (a === '--reason') opt.reason = argv[++i];
      else if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
      else throw new Error(`未知参数：${a}`);
    }
  } catch (e) {
    console.error(e.message); console.error(USAGE); return 2;
  }
  for (const [k, flag] of [['keep', 'keep'], ['hours', 'hours'], ['remoteKeep', 'remote-keep']]) {
    if (opt[k] !== null && (!Number.isFinite(opt[k]) || opt[k] < 1)) { console.error(`--${flag} 需要 ≥1 的数字`); return 2; }
  }
  const home = path.resolve(opt.home ?? defaultHome());
  const out = path.resolve(opt.out ?? DEFAULT_OUT);
  const stateFile = stateFileOf(home, opt.state);
  const keep = opt.keep ?? DEFAULT_KEEP;
  const hours = opt.hours ?? DEFAULT_HOURS;

  if (opt.status) {
    if (opt.json) {
      const rows = listSnapshots(out);
      process.stdout.write(JSON.stringify({ out, stateFile, keep, hours, snapshots: rows, state: loadState(stateFile) }, null, 2) + '\n');
    } else printStatus({ out, stateFile, keep, hours });
    return 0;
  }

  const hosts = opt.pushHost ? [opt.pushHost] : MIRROR_HOSTS;
  const runOpts = {
    home, out, keep, hours, dryRun: opt.apply !== true, prune: opt.prune, mirror: opt.mirror,
    pushNow: opt.pushNow, stateFile, pushHosts: hosts, allowRent: opt.allowRent, now: Date.now(),
    remoteKeep: opt.remoteKeep ?? DEFAULT_REMOTE_KEEP, remotePrune: opt.remotePrune,
    log: (m) => console.log(m),
  };

  const r = runOnce(runOpts);
  if (opt.apply) saveRound(stateFile, r, r.mirror);

  if (opt.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else printRound(r, { keep, hours });

  if (!r.ok) {
    const stage = r.errors.some((e) => /凭据/.test(e)) ? 'credential' : 'snapshot';
    alert({ level: 'error', source: 'snapshot-tick', message: `定时快照失败（${stage}）：${r.errors.join(' | ')}`, detail: { snapshot: r.name, home, out } }, { home });
    return stage === 'credential' ? 4 : 3;
  }
  if (r.mirror && !r.mirror.skipped && !r.mirror.ok) {
    alert({ level: 'error', source: 'snapshot-tick', message: `异地镜像失败：${(r.mirror.errors ?? []).join(' | ')}`, detail: { snapshot: r.name, tried: r.mirror.tried } }, { home });
    return 5;
  }
  // 镜像成功了、但远端保留没走完（拒动 / 复查不符）⇒ 单独一个码，别混进"镜像失败"
  if (r.mirror && !r.mirror.skipped && r.mirror.ok && r.mirror.remotePrune && !r.mirror.remotePrune.ok) {
    alert({ level: 'warn', source: 'snapshot-tick', message: `远端保留未完成：${r.mirror.remotePrune.error}`, detail: { snapshot: r.name } }, { home });
    return 6;
  }
  return 0;
}

if (isMainEntry()) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`dsh-snapshot-tick 失败：${e?.stack ?? e?.message ?? e}`);
    process.exitCode = 1;
  });
}
