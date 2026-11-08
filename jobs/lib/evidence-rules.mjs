// dsh-butler / lib/evidence-rules.mjs —— 证据校验规则表（共享）
//
// 方案 §4 P3「L1 自动动作（学习项④）：待验收自动预检」明确要求：
//   「复用 P5 写后审计同款规则引擎，只换触发点 —— P5 是「写入时」验，这里是「卡结算时」验；
//     规则表抽共享。」
//
// 本文件就是那张**共享规则表**：P3 证据预检（lib/evidence-precheck.mjs）直接消费它；
// P5 侧（rules/*.mjs 的 check(ctx) 契约）与本表通过 `runAuditRules()` 桥接 —— 同一份规则、
// 两个触发点（写入后 / 卡结算时）。
//
// 规则契约（与 rules/README.md 一致）：check(ctx) → { ok:true } | { ok:false, message } | finding[]
//   finding = { level:'block'|'warn'|'error', message, detail? }
//
// 设计口径：**只读 + 保守**。宁可漏报也不误报（方案「误报率 <5% 才放行」的 KPI 直接受影响）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 统一真源（pwsh 7 优先）：
//   360 企业版 EDR 只对 5.1（powershell.exe）弹「PowerShell 命令执行攻击」。
import { powerShellExe } from './powershell-exe.mjs';

export const EVIDENCE_RULES_VERSION = '0.1.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(HERE, '..', 'rules');

/** 单条检查命令的超时（规则预算 <2s/条；node --check 比 PS Parser 快）。 */
export const CHECK_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------- 基础检查器

/** 文件存在 + 非空（目录：存在即算，可选要求非空）。 */
export function checkPathExists(fullPath, opts = {}) {
  try {
    const st = fs.statSync(fullPath);
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(fullPath); } catch { /* 权限 */ }
      return { ok: true, kind: 'dir', bytes: null, entries: entries.length, detail: `目录存在（${entries.length} 项）` };
    }
    if (st.size === 0) return { ok: false, kind: 'file', bytes: 0, message: '文件存在但为 0 字节（空产物）' };
    return { ok: true, kind: 'file', bytes: st.size, detail: `文件存在（${st.size} B）` };
  } catch (e) {
    return { ok: false, kind: e?.code === 'ENOENT' ? 'missing' : 'error', message: `路径不存在或不可读：${e?.code ?? e?.message ?? e}` };
  }
}

/** node 语法检查（node --check；只读，不改文件）。 */
export function checkNodeSyntax(fullPath, opts = {}) {
  const r = spawnSync(process.execPath, ['--check', fullPath], {
    encoding: 'utf8', timeout: opts.timeoutMs ?? CHECK_TIMEOUT_MS, windowsHide: true,
  });
  if (r.error) return { ok: false, checker: 'node --check', message: `node --check 无法执行：${r.error.message}` };
  if (r.status === 0) return { ok: true, checker: 'node --check', detail: 'node --check 通过' };
  const err = String(r.stderr ?? '').split('\n').filter(Boolean).slice(0, 3).join(' / ');
  return { ok: false, checker: 'node --check', message: `node --check 失败（exit ${r.status}）：${err.slice(0, 300)}`, output: String(r.stderr ?? '').slice(0, 1000) };
}

/** PowerShell 语法检查（Parser；走 pwsh 7 → powershell 5.1 兜底）。 */
export function checkPowerShellSyntax(fullPath, opts = {}) {
  const exe = opts.pwshPath ?? resolvePwsh();
  if (!exe) return { ok: true, checker: 'ps-parser', skipped: true, detail: '未找到 PowerShell，跳过 PS 解析检查' };
  const script = `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile(${psQuote(fullPath)},[ref]$t,[ref]$e)|Out-Null;if($e -and $e.Count -gt 0){$e|ForEach-Object{$_.Message};exit 1}else{exit 0}`;
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: opts.timeoutMs ?? CHECK_TIMEOUT_MS, windowsHide: true,
  });
  if (r.error) return { ok: false, checker: 'ps-parser', message: `PowerShell 解析无法执行：${r.error.message}` };
  if (r.status === 0) return { ok: true, checker: 'ps-parser', detail: 'PS Parser 通过' };
  const msg = String(r.stdout ?? '').trim().split('\n').slice(0, 3).join(' / ');
  return { ok: false, checker: 'ps-parser', message: `PS Parser 报错：${msg.slice(0, 300)}`, output: msg.slice(0, 1000) };
}

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

let PWShCache = undefined;
/** 解析 PowerShell 可执行（统一真源 tools/lib/powershell-exe.mjs：pwsh 7 优先 → 5.1 兜底）。 */
export function resolvePwsh() {
  if (PWShCache !== undefined) return PWShCache;
  // 【2026-10-09 · 卡「360弹窗治本-pwsh7」】原候选只认 `<ProgramFiles>\PowerShell\7`（本机是
  //   WindowsApps 别名安装，该路径不存在）⇒ 统一走工具：既能选到 pwsh 7（含别名全路径形态），
  //   又保住 5.1 兜底（工具的返回值永不为空）。
  PWShCache = powerShellExe();
  return PWShCache;
}

/** 链接 / junction 校验（本机大量数据目录是 junction，断链=真故障）。 */
export function checkLink(fullPath, opts = {}) {
  try {
    const st = fs.lstatSync(fullPath);
    if (!st.isSymbolicLink()) return { ok: true, kind: 'not-a-link', detail: '普通文件/目录（非链接）' };
    let target = null;
    try { target = fs.readlinkSync(fullPath); } catch (e) { return { ok: false, kind: 'link', message: `链接不可读：${e?.message ?? e}` }; }
    const abs = path.isAbsolute(target) ? target : path.resolve(path.dirname(fullPath), target);
    const exists = fs.existsSync(abs);
    return exists
      ? { ok: true, kind: 'link', target: abs, detail: `链接目标存在：${abs}` }
      : { ok: false, kind: 'link', target: abs, message: `断链：目标不存在 ${abs}` };
  } catch (e) {
    return { ok: false, kind: 'error', message: `链接检查失败：${e?.code ?? e?.message ?? e}` };
  }
}

// ---------------------------------------------------------------- 规则表（按模式选检查器）

/**
 * 共享规则表：pattern → 检查器链。
 * 顺序敏感（先匹配先定检查方式）；每条 = 只读、幂等、无副作用。
 */
export const EVIDENCE_RULES = [
  {
    id: 'script-node',
    pattern: /\.(mjs|cjs|js)$/i,
    label: '改脚本类（Node）',
    budgetMs: 2000,
    check: (fullPath) => {
      const ex = checkPathExists(fullPath);
      if (!ex.ok) return { ok: false, checker: 'exists', message: ex.message };
      return checkNodeSyntax(fullPath);
    },
  },
  {
    id: 'script-powershell',
    pattern: /\.ps1$/i,
    label: '改脚本类（PowerShell）',
    budgetMs: 4000,
    check: (fullPath) => {
      const ex = checkPathExists(fullPath);
      if (!ex.ok) return { ok: false, checker: 'exists', message: ex.message };
      return checkPowerShellSyntax(fullPath);
    },
  },
  {
    id: 'cmd-batch',
    pattern: /\.(cmd|bat)$/i,
    label: '改脚本类（cmd/bat）',
    budgetMs: 1000,
    check: (fullPath) => {
      const ex = checkPathExists(fullPath);
      if (!ex.ok) return { ok: false, checker: 'exists', message: ex.message };
      // 铁律：.cmd/.bat 必须全 ASCII（中文在 cmd.exe 下按 GBK 解析会拆坏命令）
      let buf;
      try { buf = fs.readFileSync(fullPath); } catch (e) { return { ok: false, checker: 'ascii', message: `不可读：${e?.message ?? e}` }; }
      const nonAscii = buf.findIndex((b) => b > 0x7F);
      if (nonAscii >= 0) return { ok: false, checker: 'ascii', message: `存在非 ASCII 字节（offset ${nonAscii}）：.cmd/.bat 必须全 ASCII` };
      return { ok: true, checker: 'ascii', detail: '纯 ASCII（符合铁律）' };
    },
  },
  {
    id: 'json-like',
    pattern: /\.(json|jsonl)$/i,
    label: '结构化产物（JSON/JSONL）',
    budgetMs: 1000,
    check: (fullPath) => {
      const ex = checkPathExists(fullPath);
      if (!ex.ok) return { ok: false, checker: 'exists', message: ex.message };
      let text;
      try { text = fs.readFileSync(fullPath, 'utf8'); } catch (e) { return { ok: false, checker: 'json', message: `不可读：${e?.message ?? e}` }; }
      const lines = text.split('\n').filter((l) => l.trim());
      let bad = null; let n = 0;
      for (const l of lines) {
        n++;
        try { JSON.parse(l); } catch (e) { if (!bad) bad = { line: n, msg: e?.message ?? String(e) }; }
      }
      if (bad) return { ok: false, checker: 'json', message: `第 ${bad.line} 行不是合法 JSON：${bad.msg}` };
      return { ok: true, checker: 'json', detail: `${n} 行 JSON 全部合法` };
    },
  },
  {
    id: 'doc-md',
    pattern: /\.md$/i,
    label: '建档类（Markdown）',
    budgetMs: 1000,
    check: (fullPath) => {
      const ex = checkPathExists(fullPath);
      if (!ex.ok) return { ok: false, checker: 'exists', message: ex.message };
      return { ok: true, checker: 'exists', detail: ex.detail };
    },
  },
  {
    id: 'any-path',
    pattern: /.*/,
    label: '通用产物路径',
    budgetMs: 1000,
    fallback: true,
    check: (fullPath) => {
      const ex = checkPathExists(fullPath);
      if (!ex.ok) return { ok: false, checker: 'exists', message: ex.message };
      const lk = checkLink(fullPath);
      if (lk.kind === 'link' && !lk.ok) return lk;
      return { ok: true, checker: 'exists', detail: ex.detail };
    },
  },
];

/** 按路径挑选规则（无匹配 → fallback 通用路径检查）。 */
export function ruleForPath(fullPath) {
  const p = String(fullPath ?? '');
  for (const r of EVIDENCE_RULES) {
    if (r.fallback) continue;
    if (r.pattern.test(p)) return r;
  }
  return EVIDENCE_RULES.find((r) => r.fallback);
}

/** 跑单条路径的全部证据检查。 */
export function checkEvidencePath(fullPath, opts = {}) {
  const rule = ruleForPath(fullPath);
  const t0 = Date.now();
  let r;
  try {
    r = rule.check(fullPath, opts);
  } catch (e) {
    r = { ok: false, checker: rule.id, message: `检查器抛错：${e?.message ?? e}` };
  }
  return {
    path: fullPath, ruleId: rule.id, ruleLabel: rule.label,
    ok: r?.ok !== false, skipped: r?.skipped === true,
    checker: r?.checker ?? rule.id, message: r?.message ?? null, detail: r?.detail ?? null,
    output: r?.output ?? null, durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------- P5 规则桥接（同引擎）

/** 载入 P5 的 rules/*.mjs（与 butler-audit-cli 同一批文件）。 */
export function loadAuditRules(opts = {}) {
  const dir = opts.rulesDir ?? RULES_DIR;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== 'README.md'); } catch { return { rules: [], dir, error: 'rules-dir-missing' }; }
  for (const n of names.sort()) {
    const full = path.join(dir, n);
    try {
      const mod = requireCjs(full);
      const rule = mod?.default ?? mod;
      if (rule && typeof rule.check === 'function') out.push({ file: full, ...rule });
    } catch { /* 单条规则加载失败不影响其它 */ }
  }
  return { rules: out, dir };
}

// 规则文件是 ESM（.mjs）——用动态 import 需要异步；这里用 createRequire 兼容 CJS 语法的规则文件，
// 失败则由调用方走异步路径（runAuditRulesAsync）。实测当前 rules/*.mjs 是 ESM，生产路径用异步版。
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
function requireCjs(full) { return require_(full); }

/**
 * 跑 P5 同款规则（异步 import，支持 ESM 规则文件）。
 * @param {{target:string, text?:string|null, rules?:object[], rulesDir?:string}} opts
 * @returns {Promise<{ok:boolean, findings:object[], ran:number, errors:object[]}>}
 */
export async function runAuditRules(opts = {}) {
  const findings = [];
  const errors = [];
  let rules = opts.rules;
  if (!rules) {
    rules = [];
    const dir = opts.rulesDir ?? RULES_DIR;
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.mjs')); } catch { names = []; }
    for (const n of names.sort()) {
      try {
        const mod = await import(pathToFileUrl(path.join(dir, n)));
        const rule = mod?.default ?? mod;
        if (rule && typeof rule.check === 'function') rules.push(rule);
      } catch (e) { errors.push({ file: n, error: e?.message ?? String(e) }); }
    }
  }
  for (const rule of rules) {
    try {
      const r = rule.check({ target: opts.target, file: opts.target, text: opts.text, mode: opts.mode ?? 'evidence-precheck' });
      if (!r) continue;
      if (Array.isArray(r)) findings.push(...r.map((f) => ({ ruleId: rule.id, ...f })));
      else if (r.ok === false) findings.push({ ruleId: rule.id, level: rule.level ?? 'warn', message: r.message ?? '规则未通过' });
      else if (r.level && r.message) findings.push({ ruleId: rule.id, ...r });
    } catch (e) {
      errors.push({ ruleId: rule.id, error: e?.message ?? String(e) });
    }
  }
  const blocked = findings.filter((f) => f.level === 'block').length;
  return { ok: blocked === 0, findings, ran: rules.length, errors };
}

function pathToFileUrl(p) {
  const s = String(p).replace(/\\/g, '/');
  return s.startsWith('/') ? `file://${s}` : `file:///${s}`;
}

export const _internal = { psQuote, RULES_DIR };
