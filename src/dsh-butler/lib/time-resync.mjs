// dsh-butler / lib/time-resync.mjs —— 时钟门拒绝时的「一次自动校时」（P9 §17.2 T6 落地）
//
// 背景（T6 原文）：时钟门 fail-closed 会让账本 / 记忆库合并**被永久拒绝**，操作者只看到 🔴，
//   交接功能实际瘫痪。修法之一 = 拒绝时**尝试一次** `w32tm /resync`，把「机器自己能不能救回来」
//   试出来；试不动就**明确告诉操作者手动跑**，绝不许静默失败。
//
// 四条纪律（本卡硬要求）：
//   ① **默认不真跑**：`apply` 默认 false（dry-run）。交接器集成时也只有 `DSH_HANDOFF_RESYNC=1` 才真跑；
//   ② **先判断有没有权限**：`net session` 退出码为主判据（无编码依赖），`whoami /groups` 的
//      `S-1-5-32-544` 行为辅证 —— 没权限 ⇒ 不执行、返回 `no-admin` + 手动指引；
//   ③ **不许静默失败**：任何分支都返回结构化结果（含 `level` / `message` / `hint`），
//      调用方（交接器）把它写进 `alerts[]` + 日志；
//   ④ **纯/IО 分离**：判定（{@link planTimeResync}）是纯函数可单测；IO 全部走注入的 `deps.run`。
//
// ⚠️ 为什么不用 `Start-Process -Verb RunAs` 自动提权：DSH 的 pwsh 工具是**非交互**的，
//    弹不出 UAC（persona 铁律）→ 自动提权这条路不通，只能"试一次 + 给手动指引"。
import { spawnSync } from 'node:child_process';

export const TIME_RESYNC_VERSION = '0.1.0';

/** 真跑 `w32tm /resync` 需要管理员；这是**手动指引**文案（无权限时的兜底）。 */
export const MANUAL_HINT = '请以**管理员身份**打开 PowerShell 跑 `w32tm /resync`（校时需 Windows Time 服务在运行）。'
  + '已为你留档：本次拒绝的原因见本机交接单 alerts（code=merge-clock-gate）。';

/** 子进程超时（毫秒）。校时是"顺手试一次"，绝不能把 Arrive 预算吃掉。 */
export const RUN_TIMEOUT_MS = 20_000;
export const PROBE_TIMEOUT_MS = 8_000;

/** 默认 IO 实现（可注入替换：单测不碰真实系统命令）。 */
export function defaultDeps() {
  return {
    /** 跑一条命令 → {exitCode, stdout, stderr, error}（encoding=buffer，解码由解析器自己决定）。 */
    run(cmd, args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
      const r = spawnSync(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'buffer' });
      // 解码：先试 UTF-8；含替换字符说明是本地 ANSI（中文 Windows = GBK）→ 回退 GBK。
      // （实测：本机 w32tm 的报错是 GBK，直接 utf8 解码会变乱码，排障时看不到"服务尚未启动"。）
      const dec = (b) => {
        if (!b) return '';
        if (!Buffer.isBuffer(b)) return String(b);
        const u = b.toString('utf8');
        if (!u.includes('\uFFFD')) return u;
        try { return new TextDecoder('gbk').decode(b); } catch { return u; }
      };
      return {
        exitCode: typeof r.status === 'number' ? r.status : (r.error ? -1 : null),
        stdout: dec(r.stdout),
        stderr: dec(r.stderr) || (r.error ? String(r.error.message ?? r.error) : ''),
        error: r.error ? String(r.error.message ?? r.error) : null,
        timedOut: r.error?.code === 'ETIMEDOUT',
      };
    },
    platform: process.platform,
    now: () => Date.now(),
  };
}

/**
 * 判断当前进程是否有管理员权限（**纯解析**，输入是命令输出）。
 * 主判据 = `net session` 退出码：0 = 已提权；非 0（System error 5 / Access is denied）= 未提权。
 * 辅证 = `whoami /groups` 里的 `S-1-5-32-544`（Administrators）行**且**不带 deny-only 标记。
 * @param {{netSession?:{exitCode:number|null,stdout?:string,stderr?:string}|null, whoami?:string|null}} input
 * @returns {{admin:boolean|null, method:string, detail:string}}
 */
export function parseAdmin(input = {}) {
  const ns = input.netSession ?? null;
  if (ns && typeof ns.exitCode === 'number') {
    if (ns.exitCode === 0) return { admin: true, method: 'net-session', detail: 'net session 退出码 0（已提权）' };
    const blob = `${ns.stdout ?? ''}\n${ns.stderr ?? ''}`;
    if (/Access is denied|拒绝访问|System error 5|发生系统错误 5/i.test(blob) || ns.exitCode !== 0) {
      return { admin: false, method: 'net-session', detail: `net session 退出码 ${ns.exitCode}（未提权）` };
    }
  }
  const who = input.whoami ?? null;
  if (typeof who === 'string' && who.includes('S-1-5-32-544')) {
    // 命中 Administrators SID：若无 deny-only 标记 = 真在用管理员令牌
    const line = who.split(/\r?\n/).find((l) => l.includes('S-1-5-32-544')) ?? '';
    const denyOnly = /deny only|仅用于拒绝|只用于拒绝/i.test(line);
    return { admin: !denyOnly, method: 'whoami-groups', detail: denyOnly ? 'Administrators 组为 deny-only（未提权）' : 'Administrators 组已启用' };
  }
  return { admin: null, method: 'none', detail: '权限不可判（net session / whoami 都取不到）' };
}

/** 从 `w32tm /query /status` 输出里尽力取"上次成功同步时间"（只认时间戳，不依赖标签语言）。 */
export function parseLastSync(text) {
  if (typeof text !== 'string') return null;
  const m = /(\d{4}[/-]\d{1,2}[/-]\d{1,2}[ T]\d{1,2}:\d{2}:\d{2})/.exec(text);
  if (!m) return null;
  const t = Date.parse(m[1].replace(/\//g, '-'));
  return Number.isFinite(t) ? t : null;
}

/** `ERROR_SERVICE_NOT_ACTIVE`（0x80070426）—— Windows Time 服务没在跑（**实测本机就是这个**）。 */
export const ERR_SERVICE_NOT_ACTIVE = -2147023834;

/**
 * 解析 `w32tm /query /status` 的结果（纯函数）。
 * 识别"服务未启动"这一档：实测在某机上 `w32tm /query/status` 返回 0x80070426 +「服务尚未启动」
 * ⇒ 说明**在这台机器上 w32tm 校时本来就用不了**，必须先 `net start w32time`。
 * ⚠️ 无管理员权限时该查询同样可能失败 → 此时 `unknown=true`，**不据此判服务坏**（防误报）。
 * @returns {{ok:boolean|null, notRunning:boolean, unknown:boolean, note:string}}
 */
export function parseW32tmStatus(exitCode, stdout) {
  const blob = String(stdout ?? '');
  if (exitCode === 0) return { ok: true, notRunning: false, unknown: false, note: 'Windows Time 可查询' };
  if (exitCode === ERR_SERVICE_NOT_ACTIVE || /0x80070426/i.test(blob) || /服务尚未启动|has not been started/i.test(blob)) {
    return { ok: false, notRunning: true, unknown: false, note: 'Windows Time 服务未启动（0x80070426）' };
  }
  return {
    ok: null, notRunning: false, unknown: true,
    note: `w32tm /query/status 退出码 ${exitCode} —— 原因未识别（无管理员权限时该查询也可能被拒 → 不据此判服务坏）`,
  };
}

/**
 * 纯判定：这次该做什么？（**可单测，不含 IO**）
 * @param {{apply?:boolean, admin:boolean|null, serviceOk?:boolean|null, serviceNotRunning?:boolean, reason?:string|null}} input
 * @returns {{action:'run'|'dry-run'|'skip', command:string, why:string, hint:string|null, level:'info'|'warn'|'alert'}}
 */
export function planTimeResync(input = {}) {
  const apply = input.apply === true;
  const admin = input.admin ?? null;
  const cmd = 'w32tm /resync';
  const svcHint = input.serviceNotRunning === true
    ? '请以管理员身份跑 `net start w32time`（服务没起来时 `w32tm /resync` 必然失败，实测错误码 0x80070426），再跑 `w32tm /resync`。'
    : null;
  if (!apply) {
    return {
      action: 'dry-run', command: cmd, level: admin === false ? 'warn' : 'info',
      why: 'dry-run（默认不真跑：只有 DSH_HANDOFF_RESYNC=1 或 CLI --apply 才执行系统命令）',
      hint: admin === false ? (svcHint ? `${MANUAL_HINT} ${svcHint}` : MANUAL_HINT) : svcHint,
    };
  }
  if (admin !== true) {
    return {
      action: 'skip', command: cmd, level: 'warn',
      why: admin === false ? '无管理员权限 → 不执行（绝不静默失败，转人工）' : '权限不可判 → 保守不执行',
      hint: svcHint ? `${MANUAL_HINT} ${svcHint}` : MANUAL_HINT,
    };
  }
  if (input.serviceOk === false) {
    return {
      action: 'skip', command: cmd, level: 'warn',
      why: input.serviceNotRunning === true
        ? 'Windows Time 服务未启动（0x80070426）→ 先启服务再校时（有权限但服务没跑）'
        : 'Windows Time 不可用（w32tm /query/status 失败）→ 先排查服务',
      hint: svcHint ?? '请以管理员身份跑 `w32tm /query /status` 看原因，必要时 `net start w32time`，再 `w32tm /resync`。',
    };
  }
  return { action: 'run', command: cmd, level: 'info', why: '有管理员权限 → 执行一次校时', hint: null };
}

/**
 * 探测 + （可选）执行一次校时。**永不抛**（fail-open：它的失败不许影响交接主流程）。
 * @param {{apply?:boolean, deps?:object, reason?:string|null}} [opts]
 * @returns {{attempted:boolean, ok:boolean|null, dryRun:boolean, admin:boolean|null, adminMethod:string,
 *            serviceOk:boolean|null, action:string, command:string, why:string, level:'info'|'warn'|'alert',
 *            message:string, hint:string|null, exitCode:number|null, stdout:string, stderr:string,
 *            lastSyncAt:number|null, durationMs:number, version:string}}
 */
export function runTimeResync(opts = {}) {
  const deps = opts.deps ?? defaultDeps();
  const t0 = deps.now ? deps.now() : Date.now();
  const out = {
    attempted: false, ok: null, dryRun: opts.apply !== true,
    admin: null, adminMethod: 'none', serviceOk: null,
    serviceNote: '', serviceNotRunning: false,
    action: 'skip', command: 'w32tm /resync', why: '', level: 'info',
    message: '', hint: null, exitCode: null, stdout: '', stderr: '',
    lastSyncAt: null, durationMs: 0, version: TIME_RESYNC_VERSION,
  };
  try {
    if (deps.platform && deps.platform !== 'win32') {
      out.why = `非 Windows 平台（${deps.platform}）→ 不适用 w32tm`;
      out.level = 'warn';
      out.message = '自动校时不可用：仅 Windows 支持 w32tm';
      return out;
    }
    // ① 权限探测（无编码依赖的退出码为主）
    let ns = null;
    try { ns = deps.run('net', ['session'], { timeoutMs: PROBE_TIMEOUT_MS }); } catch { ns = null; }
    let who = null;
    try { who = deps.run('whoami', ['/groups'], { timeoutMs: PROBE_TIMEOUT_MS })?.stdout ?? null; } catch { who = null; }
    const adm = parseAdmin({ netSession: ns, whoami: who });
    out.admin = adm.admin; out.adminMethod = adm.method;

    // ② 服务探测（只读；识别"服务未启动"这一档 → 决定 hint 是"启服务"还是"手动校时"）
    let st = null;
    try { st = deps.run('w32tm', ['/query', '/status'], { timeoutMs: PROBE_TIMEOUT_MS }); } catch { st = null; }
    const svc = st ? parseW32tmStatus(st.exitCode, `${st.stdout ?? ''}${st.stderr ?? ''}`) : { ok: null, notRunning: false, unknown: true, note: 'w32tm 不可执行' };
    out.serviceOk = svc.ok;
    out.serviceNote = svc.note;
    out.serviceNotRunning = svc.notRunning;
    out.lastSyncAt = st ? parseLastSync(st.stdout) : null;

    // ③ 判定（纯函数）
    const plan = planTimeResync({
      apply: opts.apply === true, admin: adm.admin,
      serviceOk: out.serviceOk, serviceNotRunning: out.serviceNotRunning,
      reason: opts.reason ?? null,
    });
    out.action = plan.action; out.command = plan.command; out.why = plan.why; out.level = plan.level; out.hint = plan.hint;

    if (plan.action === 'run') {
      const r = deps.run('w32tm', ['/resync'], { timeoutMs: RUN_TIMEOUT_MS });
      out.attempted = true;
      out.exitCode = r.exitCode;
      out.stdout = String(r.stdout ?? '').slice(0, 800);
      out.stderr = String(r.stderr ?? '').slice(0, 800);
      out.ok = r.exitCode === 0;
      if (out.ok) {
        out.level = 'info';
        out.message = `时钟门拒绝后已自动校时一次：w32tm /resync 成功（${out.adminMethod}）`;
      } else {
        out.level = 'alert';
        out.message = `时钟门拒绝后自动校时**失败**（exit=${r.exitCode}）：${(out.stderr || out.stdout || '').trim().slice(0, 200) || '无输出'}`;
        out.hint = MANUAL_HINT;
      }
      // 复核
      try {
        const st2 = deps.run('w32tm', ['/query', '/status'], { timeoutMs: PROBE_TIMEOUT_MS });
        if (st2?.exitCode === 0) out.lastSyncAt = parseLastSync(st2.stdout) ?? out.lastSyncAt;
      } catch { /* 复核失败不影响结论 */ }
    } else if (plan.action === 'dry-run') {
      out.level = plan.level;
      const svcBit = out.serviceNotRunning ? '（⚠️ 且探测到 **Windows Time 服务未启动**，0x80070426 —— 光有权限也校不了时）' : '';
      out.message = adm.admin === false
        ? `时钟门拒绝：自动校时（dry-run）—— 本进程**无管理员权限**，未执行${svcBit}；${MANUAL_HINT}`
        : `时钟门拒绝：自动校时（dry-run）—— 未执行${svcBit}（默认不真跑；\`DSH_HANDOFF_RESYNC=1\` 才真跑）`;
    } else {
      out.message = `时钟门拒绝：自动校时未执行 —— ${plan.why}${plan.hint ? `；${plan.hint}` : ''}`;
    }
  } catch (e) {
    // 任何意外都不许冒泡：交接主流程优先
    out.ok = false;
    out.level = 'warn';
    out.message = `自动校时模块异常（已吞掉，不影响交接）：${String(e?.message ?? e).slice(0, 200)}`;
  }
  out.durationMs = (deps.now ? deps.now() : Date.now()) - t0;
  return out;
}

/** 交接器集成用的开关：默认 **off**（只探测 + 提示，不真跑）。 */
export function resyncEnabled(env = process.env) {
  const v = String(env.DSH_HANDOFF_RESYNC ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}
