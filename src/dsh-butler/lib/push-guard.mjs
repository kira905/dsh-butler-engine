// dsh-butler / lib/push-guard.mjs —— 热采「推前安全门」判定核心（2026-09-15 新建）
//
// 为什么需要（本卡背景）：
//   热采（30 分钟 tick）默认 push 到仓1/仓3，但**采集前不 pull、push 前无挡推门**。已复现的数据风险链：
//     ① 对端（另一台机）把新成果推到 Gitee：commit B（内容含本机生产没有的行）
//     ② 本机某次 -Pull / handoff --arrive 把 B 拉进工作副本（工作副本 = B）
//     ③ 本机生产仍是旧版 A（尚未分发）；热采采集：**用 A 覆盖工作副本的 B** → commit C（parent = B）
//     ④ push 是 B 的 fast-forward（git 不会拒绝）⇒ **远端 B 的内容被抹掉**
//   复现证据：内部夹具 fixtures/hot-collect-guard/（fixture + evidence/*.json）
//
// 判定口径（保守优先 · fail-closed）：
//   · **提交级（首选 A 项）**：远端 vs 本地提交图 + **本机上次确认的同步基准**（lastSyncedSha）
//     - 远端有本地没有的提交（本机落后）→ 挡
//     - 基准之后远端出现「非本机产生」的提交 → 挡（别人推了东西，本机不了解）
//     - 基准之后的远端提交全是本机产生的（记录滞后）→ 放行
//     - 远端 HEAD == 基准 → 放行（本机主导内容前进：**正常的新增/改写/删除都不误伤**）
//   · **无基准时**（首次运行 / 记录丢失）→ 先看远端尖端提交来源，再走**内容级兜底**（由调用方注入
//     contentProbe，复用 tools/lib/repo-superset.mjs 的既有判据，不另造一套）：远端/工作副本有生产没有的
//     内容 → 挡。
//   · **网络不可用**（fetch 失败）→ 不算"内容风险"：允许本地采集继续，但**禁止推送**（推不出去就没有抹除风险）。
//
// 与既有安全门的关系：
//   · `tools/lib/repo-superset.mjs`（dsh-backup-sync.ps1 -Push 的挡推门）= **内容级**判据，本模块在
//     "无基准"时复用它，不自造第二套；
//   · `tools/dsh-sync-merge.mjs` 的安全门 = "DSH 在跑不许 apply"，与推送无关，不冲突。
//   · 本模块只做**判定**（只读 git + 只读文件），不做任何写操作（唯一例外：`git fetch`，只更新远程跟踪 ref）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PUSH_GUARD_VERSION = '0.1.0';

/** 默认分支（三仓都是 master）。 */
export const DEFAULT_BRANCH = 'master';

/** 判定类别：hard=true 表示"内容可能被抹"（连本地采集都停）；false 表示"远端状态未知"（只停推送）。 */
export const BLOCK_CODES = {
  'remote-ahead': { hard: true, text: '远端有本机未同步的提交（本机落后）' },
  'remote-foreign-commits': { hard: true, text: '远端在本机同步基准之后出现了非本机提交' },
  'unknown-remote-tip': { hard: true, text: '远端尖端提交非本机产生且本机无同步基准' },
  'content-diverged': { hard: true, text: '工作副本里存在生产没有的内容（覆盖会抹掉）' },
  'baseline-unresolvable': { hard: true, text: '同步基准无法解析（失败安全）' },
  'rev-list-failed': { hard: true, text: '提交图枚举失败（失败安全）' },
  'content-probe-failed': { hard: true, text: '内容级兜底体检失败（失败安全）' },
  'fetch-failed': { hard: false, text: 'fetch 远端失败（远端状态未知）→ 只禁推送' },
  'remote-unresolved': { hard: false, text: '无法解析远端分支且 fetch 失败 → 只禁推送' },
  'bad-args': { hard: true, text: '参数不合法' },
};

// ---------------------------------------------------------------- 工具

/** 只读 git 封装（与 hot-collect 里的同形态；本模块不 import 它，避免循环依赖）。 */
export function git(dir, args, { timeout = 120_000 } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout ?? '').trim(),
    err: (r.stderr ?? '').trim(),
    timedOut: r.error?.code === 'ETIMEDOUT' || r.error?.code === 'ETIMEDOUT',
  };
}

/** 本机提交标记（host 大写；提交 message 形如 `20260915-1000 <HOST> hot-collect (auto)`）。 */
export function hostTagOf(host) { return String(host ?? '').trim().toUpperCase(); }

/**
 * 提交 message 是否由 `hostTag` 这台机产生。
 * 边界口径（防"本机名是对方名前缀"的误判）：
 *   · 前导不能是字母数字（`-` 允许：`20260915-1000 HOST-B ...` 是合法形态）
 *   · 后随不能是字母数字或 `-`（否则 `HOST` 会误配 `HOST-B`）
 * 大小写不敏感。
 */
export function messageFromHost(message, hostTag) {
  const tag = hostTagOf(hostTag);
  if (!tag) return false;
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}(?![\\w-])`, 'i').test(String(message ?? ''));
}

/** 解析 `git log --format=%H%x09%s` 输出为 [{sha, subject}]。 */
export function parseLogLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf('\t');
    if (i < 0) { out.push({ sha: line.trim(), subject: '' }); continue; }
    out.push({ sha: line.slice(0, i).trim(), subject: line.slice(i + 1).trim() });
  }
  return out;
}

function blockedRes(out, code, reason, extra = {}) {
  return { ...out, safe: false, status: 'blocked', code, hard: BLOCK_CODES[code]?.hard !== false, reason, ...extra };
}
function safeRes(out, basis, reason, status = 'safe') {
  return { ...out, safe: true, status, code: null, hard: false, basis, reason };
}

// ---------------------------------------------------------------- 判定核心

/**
 * 判定「现在把工作副本提交推上去 / 用生产覆盖工作副本」是否安全。
 *
 * @param {{
 *   dir:string,                       // 工作副本路径
 *   repo?:string,                     // 仓名（报告用）
 *   host:string,                      // 本机名（提交标记）
 *   branch?:string,                   // 默认 master
 *   remote?:string,                   // 默认 origin
 *   lastSyncedSha?:string|null,       // 本机上次确认的远端同步点
 *   fetch?:boolean,                   // 是否先 fetch（默认 true）
 *   timeoutMs?:number,
 *   contentProbe?:()=>object,         // 无基准时的内容级兜底（返回 {risky:boolean, files?:string[], reason?:string}）
 * }} opts
 * @returns {{safe:boolean,status:'safe'|'blocked'|'no-remote'|'no-repo',code:string|null,hard:boolean,reason:string,
 *   basis:string|null,repo:string,localSha:string|null,remoteSha:string|null,lastSyncedSha:string|null,
 *   remoteAhead:number,foreignCommits:{sha:string,subject:string}[],fetched:boolean,fetchError:string|null}}
 */
export function judgeSyncSafety(opts = {}) {
  const repo = opts.repo ?? path.basename(String(opts.dir ?? ''));
  const out = {
    repo, safe: true, status: 'safe', code: null, hard: false, reason: '', basis: null,
    localSha: null, remoteSha: null, lastSyncedSha: opts.lastSyncedSha ?? null,
    remoteAhead: 0, foreignCommits: [], fetched: false, fetchError: null,
  };

  const dir = opts.dir;
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) {
    return { ...out, status: 'no-repo', safe: true, reason: `工作副本不存在或不是 git 仓（${dir ?? '-'}）` };
  }
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const remote = opts.remote ?? 'origin';
  const hostTag = hostTagOf(opts.host);
  if (!hostTag) return blockedRes(out, 'bad-args', 'host 为空：无法判定提交来源（失败安全）');
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const remoteName = `${remote}/${branch}`;

  const local = git(dir, ['rev-parse', 'HEAD']);
  out.localSha = local.ok ? local.out : null;
  if (!out.localSha) {
    // 空工作副本（还没有任何提交）→ 覆盖不会抹掉远端内容
    return safeRes(out, 'empty-workcopy', '工作副本尚无提交（无内容可丢）', 'no-remote');
  }

  // 没配远端（本地夹具 / 未 -SetRemote）→ 无远端内容可丢，直接放行（且不发任何网络请求）
  const remoteUrl = git(dir, ['remote', 'get-url', remote]);
  if (!remoteUrl.ok || !remoteUrl.out) {
    return safeRes(out, 'no-remote', `${remote} 未配置（无远端内容可丢）`, 'no-remote');
  }

  if (opts.fetch !== false) {
    // 不带分支拉取（用仓自身 refspec）：远端是**空仓**（新建、首次推送前）时也不报错，
    //   报错才说明是网络/认证/refspec 层面的真问题。
    const f = git(dir, ['fetch', '--quiet', remote], { timeout: opts.timeoutMs ?? 120_000 });
    out.fetched = f.ok;
    if (!f.ok) {
      // 兜底区分：远端确实没有该分支（空仓/新分支）⇒ 无远端内容可丢，不算故障
      const lsr = git(dir, ['ls-remote', '--heads', remote, branch], { timeout: opts.timeoutMs ?? 120_000 });
      if (lsr.ok && !lsr.out) {
        return safeRes(out, 'no-remote', `远端没有 ${branch} 分支（空仓/首次推送前 ⇒ 无远端内容可丢）`, 'no-remote');
      }
      out.fetchError = (f.err || f.out || 'unknown').slice(0, 200);
    }
  }

  const refNow = git(dir, ['rev-parse', '--verify', '--quiet', remoteRef]);
  if (!refNow.ok) {
    if (out.fetchError) return blockedRes(out, 'remote-unresolved', `无法解析 ${remoteName} 且 fetch 失败：${out.fetchError}`);
    return safeRes(out, 'no-remote', `${remoteName} 不存在（无远端内容可丢）`, 'no-remote');
  }
  out.remoteSha = refNow.out;
  if (out.fetchError) return blockedRes(out, 'fetch-failed', `fetch ${remote} 失败（远端状态可能过期）：${out.fetchError}`);

  // ① 提交级：本机落后（远端有本地没有的提交）
  const cnt = git(dir, ['rev-list', '--count', `HEAD..${remoteName}`]);
  if (!cnt.ok) return blockedRes(out, 'rev-list-failed', `git rev-list HEAD..${remoteName} 失败（失败安全）`);
  out.remoteAhead = Number(cnt.out) || 0;
  if (out.remoteAhead > 0) {
    return blockedRes(out, 'remote-ahead', `远端有 ${out.remoteAhead} 个本机未同步的提交（本机落后：先 -Pull / 裁决再采）`);
  }

  // ② 有基准：只看"基准之后远端新增的提交是谁推的"
  if (out.lastSyncedSha) {
    if (out.remoteSha === out.lastSyncedSha) {
      return safeRes(out, 'last-synced-sha', '远端 HEAD = 本机上次确认的同步点 ⇒ 本机主导内容前进（新增/改写/删除均不拦）');
    }
    const lg = git(dir, ['log', '--format=%H%x09%s', `${out.lastSyncedSha}..${remoteName}`]);
    if (!lg.ok) {
      return blockedRes(out, 'baseline-unresolvable',
        `无法枚举 ${String(out.lastSyncedSha).slice(0, 8)}..${remoteName}（基准失效：远端可能被强推/重建，失败安全）`);
    }
    const commits = parseLogLines(lg.out);
    const foreign = commits.filter((c) => !messageFromHost(c.subject, hostTag));
    out.foreignCommits = foreign;
    if (foreign.length) {
      return blockedRes(out, 'remote-foreign-commits',
        `远端在本机同步基准之后有 ${foreign.length} 个非本机提交（别人推了东西，本机还没分发）`,
        { foreignCommits: foreign.slice(0, 20) });
    }
    return safeRes(out, 'self-commits-ahead', `基准之后远端 ${commits.length} 个提交全部由本机产生（记录滞后，安全）`);
  }

  // ③ 无基准：先看远端尖端提交来源
  const tip = git(dir, ['log', '-1', '--format=%H%x09%s', remoteName]);
  if (!tip.ok) return blockedRes(out, 'rev-list-failed', `git log ${remoteName} 失败（失败安全）`);
  const tipCommit = parseLogLines(tip.out)[0] ?? { sha: out.remoteSha, subject: '' };
  if (messageFromHost(tipCommit.subject, hostTag)) {
    return safeRes(out, 'tip-host', '远端尖端提交由本机产生（首次建立同步基准）');
  }

  // ④ 无基准 + 尖端非本机 → 内容级兜底（复用 repo-superset 判据；若已分发则放行，避免"接机后永久挡"）
  if (typeof opts.contentProbe === 'function') {
    let probe;
    try { probe = opts.contentProbe() ?? {}; } catch (e) {
      return blockedRes(out, 'content-probe-failed', `内容级兜底体检抛错：${String(e?.message ?? e).slice(0, 160)}`);
    }
    if (probe.risky === false) {
      return safeRes(out, 'content-superset',
        `远端尖端非本机提交，但内容级体检通过（工作副本无生产缺失的内容）${probe.reason ? `：${probe.reason}` : ''}`);
    }
    return blockedRes(out, 'content-diverged',
      `远端尖端非本机提交且内容级体检发现「工作副本有、生产没有」的内容${probe.files?.length ? `（${probe.files.length} 个文件）` : ''}` +
      `${probe.reason ? `：${probe.reason}` : ''}`,
      { contentFiles: (probe.files ?? []).slice(0, 20) });
  }

  return blockedRes(out, 'unknown-remote-tip', `远端尖端提交非本机产生（${tipCommit.subject.slice(0, 80)}）且无同步基准`);
}

/** 人类可读一行（CLI 报告用）。 */
export function formatGate(g) {
  if (!g) return '(未判定)';
  const icon = g.safe ? (g.status === 'no-remote' ? '⚪' : '🟢') : (g.hard ? '🔴' : '🟡');
  return `${icon} ${g.repo}: ${g.reason || g.status}${g.basis ? ` [basis=${g.basis}]` : ''}`;
}
