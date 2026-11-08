// dsh-butler / lib/audit-cli.mjs —— butler-audit-cli 核心（骨架）
//
// 来源：方案 §5.1 组件清单 —— butler-audit-cli = 「审计工具统一入口 + 发凭证」。
// 本轮（卡 [0] 骨架）只交付**统一入口 + 两种入参**；具体审计规则由 [2b] P5 填进 rules/。
//
// 两种入参（契约，P5 不改）：
//   --staged <file>         待审文件（git 暂存 / 落盘候选）：读字节算 sha256 + 文本给规则
//   --content-hash <sha256> 直接给内容哈希（上游/CI 提供）：只做格式校验 + 规则匹配
//
// 输出：默认人类可读摘要；--json 输出单行 JSON（机器可测）。退出码：
//   0 pass / 1 命中 block 规则 / 2 用法错误 / 3 输入无效（文件不存在、哈希非法）
//
// 规则目录 rules/*.mjs：export default { id, description, level:'block'|'warn', check(ctx) }
//   ctx = { mode, file, sha256, bytes, text, meta }
//   check 返回 { ok:true } | { ok:false, message } | finding | finding[]
//   规则自身抛错 → 记为 level 'error' 的 finding（CLI 不崩）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RULES_DIR, butlerPaths, dshHome, newRunId } from '../../src/dsh-butler/lib/paths.mjs';
import { appendAudit } from '../../src/dsh-butler/lib/audit.mjs';
import { judgeForce } from './audit-token.mjs';
import { classifyActor } from './session-header.mjs';

export const VERSION = '0.1.0';
export const EXIT = { PASS: 0, BLOCK: 1, USAGE: 2, INPUT: 3 };
const DEFAULT_MAX_BYTES = 1024 * 1024;

export const USAGE = [
  'butler-audit-cli —— 管家审计工具统一入口（P5：内容审计 + 发凭证）',
  '',
  '用法：',
  '  node butler-audit-cli.mjs --staged <file> [--target <目标路径>] [--pass] [--json] [--no-audit]',
  '  node butler-audit-cli.mjs --content-hash <sha256> [--target <目标路径>] [--pass]',
  '  node butler-audit-cli.mjs --self-check | --version | --help',
  '',
  '保护区写入标准流程（persona / 技能 / 核心启动链）：',
  '  1) 待写入内容落临时文件 <tmp>\\butler-audit-stage\\<name>',
  '  2) --staged <临时文件> --target "<目标路径>" --pass   ← 审计通过即向 host 发凭证（TTL 10 分钟）',
  '  3) 用 write 工具把同一份内容写到目标路径（工具自身原子发布 + 走 A 层门）',
  '',
  '逃生舱：',
  '  --force "<原因>" --actor-session <会话id>   仅主会话 / 面板可用；subagent 一律拒绝',
  '',
  '退出码：0 通过 / 1 拦截 / 2 用法错误 / 3 输入无效',
].join('\n');

/** 解析 argv（手写，无依赖）。 */
export function parseArgs(argv) {
  const out = {
    staged: null, contentHash: null, json: false, audit: true, selfCheck: false, help: false, version: false,
    maxBytes: DEFAULT_MAX_BYTES,
    target: null, pass: false, force: null, actorSession: null, host: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`参数 ${a} 缺少值`);
      return v;
    };
    switch (a) {
      case '--staged': out.staged = need(); break;
      case '--content-hash': out.contentHash = need(); break;
      case '--target': out.target = need(); break;
      case '--pass': out.pass = true; break;
      case '--force': out.force = need(); break;
      case '--actor-session': out.actorSession = need(); break;
      case '--host': out.host = need(); break;
      case '--json': out.json = true; break;
      case '--no-audit': out.audit = false; break;
      case '--self-check': out.selfCheck = true; break;
      case '--max-bytes': out.maxBytes = Number(need()); break;
      case '--help': case '-h': out.help = true; break;
      case '--version': case '-v': out.version = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return out;
}

export function isValidSha256(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s.trim());
}

/** 加载 rules/*.mjs（骨架期目录不存在/为空 → 0 条）。 */
export function loadRules(rulesDir = RULES_DIR) {
  const rules = [];
  if (!fs.existsSync(rulesDir)) return rules;
  for (const name of fs.readdirSync(rulesDir).filter((n) => n.endsWith('.mjs')).sort()) {
    const full = path.join(rulesDir, name);
    rules.push({ id: path.basename(name, '.mjs'), file: full, loader: () => import(pathToFileUrlCached(full)) });
  }
  return rules;
}

function pathToFileUrlCached(full) {
  const url = new URL(`file://${full.replace(/\\/g, '/')}`);
  url.searchParams.set('t', String(fs.statSync(full).mtimeMs));
  return url.href;
}

/** 构造审计输入。 */
export function buildInput(args) {
  if (args.staged && args.contentHash) throw new Error('--staged 与 --content-hash 不能同时使用');
  const maxBytes = Number.isFinite(args.maxBytes) ? Number(args.maxBytes) : DEFAULT_MAX_BYTES;
  if (args.staged) {
    const file = path.resolve(args.staged);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, error: `文件不存在或不是普通文件：${file}` };
    const buf = fs.readFileSync(file);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const text = buf.length <= maxBytes ? buf.toString('utf8') : null;
    return {
      ok: true,
      input: {
        mode: 'staged', file, bytes: buf.length, sha256, text,
        truncated: text === null,
        meta: { basename: path.basename(file), ext: path.extname(file).toLowerCase(), mtime: fs.statSync(file).mtime.toISOString() },
      },
    };
  }
  if (args.contentHash) {
    const h = String(args.contentHash).trim().toLowerCase();
    if (!isValidSha256(h)) return { ok: false, error: `--content-hash 必须是 64 位十六进制 sha256：${args.contentHash}` };
    return { ok: true, input: { mode: 'content-hash', file: null, bytes: null, sha256: h, text: null, truncated: false, meta: {} } };
  }
  throw new Error('必须提供 --staged <file> 或 --content-hash <sha256>');
}

function normalizeFindings(rule, raw) {
  if (!raw || raw === true) return [];
  if (raw === false) return [{ rule: rule.id, level: rule.level ?? 'warn', message: '规则返回 false' }];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.ok === true && !item.message) continue;
    out.push({
      rule: rule.id,
      level: item.level ?? rule.level ?? 'warn',
      message: item.message ?? (item.ok === false ? '命中（无说明）' : '未命名发现'),
      detail: item.detail ?? null,
    });
  }
  return out;
}

/**
 * 跑一次审计。
 * @param {{staged?:string, contentHash?:string, json?:boolean, audit?:boolean, maxBytes?:number}} args
 * @param {{home?:string, rulesDir?:string, runId?:string}} [opts]
 */
export async function runAudit(args, opts = {}) {
  const home = opts.home ?? dshHome();
  const runId = opts.runId ?? newRunId('audit');
  let parsed;
  try {
    parsed = buildInput(args);
  } catch (e) {
    return { exitCode: EXIT.USAGE, result: { ok: false, tool: 'butler-audit-cli', version: VERSION, runId, error: e.message, verdict: 'usage-error', usage: USAGE } };
  }
  if (!parsed.ok) return { exitCode: EXIT.INPUT, result: { ok: false, tool: 'butler-audit-cli', version: VERSION, runId, error: parsed.error, verdict: 'invalid-input' } };

  const input = parsed.input;
  // P5：规则上下文扩展（target = 凭证绑定的目标路径；baselineText = 目标文件当前内容，用于大改比对）
  const target = typeof args.target === 'string' && args.target.trim() ? args.target.trim() : null;
  const baselineText = readBaseline(target, args.maxBytes);
  const rules = loadRules(opts.rulesDir);
  const findings = [];
  for (const r of rules) {
    let rule = { id: r.id, level: 'warn' };
    try {
      const mod = await r.loader();
      const def = mod?.default ?? mod?.rule ?? null;
      if (!def || typeof def.check !== 'function') {
        findings.push({ rule: r.id, level: 'error', message: '规则模块必须 default 导出 { id, check(ctx) }', detail: r.file });
        continue;
      }
      rule = { id: def.id ?? r.id, level: def.level ?? 'warn' };
      findings.push(...normalizeFindings(rule, await def.check({ ...input, target, baselineText })));
    } catch (e) {
      findings.push({ rule: r.id, level: 'error', message: `规则执行失败：${e?.message ?? e}`, detail: r.file });
    }
  }

  const blocked = findings.some((f) => f.level === 'block' || f.level === 'error');
  const verdict = findings.length === 0 ? 'pass' : (blocked ? 'block' : 'warn');
  const result = {
    ok: !blocked,
    tool: 'butler-audit-cli',
    version: VERSION,
    runId,
    at: new Date().toISOString(),
    input: {
      mode: input.mode,
      file: input.file,
      sha256: input.sha256,
      bytes: input.bytes,
      truncated: input.truncated,
      meta: input.meta,
    },
    rulesLoaded: rules.length,
    verdict,
    findings,
    note: rules.length === 0 ? '骨架：审计规则未实现（由卡 [2b] P5 填 rules/*.mjs）' : null,
  };
  // ---- P5：发凭证（--pass）----
  if (args.pass) {
    result.pass = await issuePass({ args, input, target, blocked, verdict, runId, host: opts.host, fetchImpl: opts.fetch });
  }
  if (args.audit !== false) {
    appendAudit({
      type: 'audit-cli',
      runId,
      mode: input.mode,
      file: input.file ? path.basename(input.file) : null,
      target,
      sha256: input.sha256,
      verdict,
      rulesLoaded: rules.length,
      findings: findings.length,
      pass: result.pass ? { ok: result.pass.ok, code: result.pass.code ?? null, forced: result.pass.forced === true } : null,
    }, { home, silent: true });
  }
  const forced = result.pass?.ok === true && result.pass?.forced === true;
  return { exitCode: blocked && !forced ? EXIT.BLOCK : EXIT.PASS, result };
}

/** 读目标文件当前内容（规则的大改比对 baseline）。 */
function readBaseline(target, maxBytes) {
  if (!target) return null;
  try {
    const buf = fs.readFileSync(target);
    return buf.length <= (maxBytes ?? DEFAULT_MAX_BYTES) ? buf.toString('utf8') : null;
  } catch {
    return null;
  }
}

/**
 * 向 host 发凭证（POST /api/dsh-butler/audit-pass）。
 * 身份 / force 权限由 **host** 侧最终判定（CLI 侧只做显然性检查），避免被伪造。
 */
async function issuePass({ args, input, target, blocked, verdict, runId, host, fetchImpl }) {
  if (!target) return { ok: false, code: 'PASS_NEEDS_TARGET', message: '--pass 必须同时给 --target <目标路径>（凭证绑定目标路径）' };
  const forceReason = typeof args.force === 'string' && args.force.trim() ? args.force.trim().slice(0, 200) : null;
  if (forceReason && !args.actorSession) {
    return { ok: false, code: 'FORCE_NO_ACTOR', message: '--force 必须同时给 --actor-session <会话id>（无法判定身份时 fail-closed 拒绝）' };
  }
  if (blocked && !forceReason) {
    return { ok: false, code: 'PASS_BLOCKED', message: '审计未通过（存在 block 级发现），未发凭证' };
  }
  const base = (host ?? args.host ?? 'http://localhost:3080').replace(/\/+$/, '');
  const payload = {
    path: target,
    contentHash: input.sha256,
    runId,
    verdict,
    forceReason,
    actorSession: args.actorSession ?? null,
  };
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, code: 'PASS_NO_FETCH', message: '当前 Node 无 fetch，无法发凭证' };
  const url = `${base}/api/dsh-butler/audit-pass`;
  const headers = { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' };
  try {
    // ── 【施工卡 ①-3 · P-6】C⁺ 服务端强制：`/audit-pass` 现要求**一次性确认令牌** ──
    //   本 CLI 是程序化调用方 ⇒ 同一流程两步（**不许**为了省事在服务端开后门）：
    //   ① POST {mode:'confirm'} 取令牌（服务端签发 + 审计 `panel-confirm-issued`）
    //   ② 带 confirmToken 提交（服务端一次性消费；用过/过期/不带 = 403 + 审计拒绝）
    //   ⚠️ 安全目标如实：防误触/重复提交，**不防**本机恶意进程（webserver 零鉴权，①包 §3.6-1）。
    //   ⚠️ 2026-09-18 修复：与本机**运行中**的 host 对齐。实测该 host 的口径是——
    //      缺 path → 400 `missing-path`；只给 path → 400 `bad-content-hash`；
    //      **path + contentHash 齐全 → 直接签发凭证**（响应带 pathKey/expiresAt/ttlMs，**没有** token 字段）。
    //      而源码版 host（`dsh-butler-panel\lib\index.js:666`）走两步式（先发 token、再带 confirmToken 提交）
    //      ⇒ 本函数两者都支持：响应里没有 token 但带 pathKey，即"凭证已生效"，直接成功返回、不再发第二步。
    const tokRes = await doFetch(url, { method: 'POST', headers,
                                        body: JSON.stringify({ mode: 'confirm', path: target, contentHash: input.sha256 }) });
    const tok = await tokRes.json().catch(() => null);
    if (tokRes.ok && tok?.ok !== false && tok?.pathKey && !tok?.token) {
      return { ok: true, pathKey: tok.pathKey, expiresAt: tok.expiresAt, ttlMs: tok.ttlMs,
               forced: tok.forced === true, host: base };
    }
    if (!tokRes.ok || tok?.ok === false || !tok?.token) {
      return {
        ok: false,
        code: tok?.code ?? `CONFIRM_ISSUE_HTTP_${tokRes.status}`,
        message: tok?.error ?? `host 未签发确认令牌（HTTP ${tokRes.status}）⇒ 未发凭证`,
      };
    }
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, confirmToken: tok.token }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.ok === false) {
      return { ok: false, code: j?.code ?? `HTTP_${res.status}`, message: j?.error ?? j?.message ?? `host 拒绝发凭证（HTTP ${res.status}）` };
    }
    return { ok: true, pathKey: j.pathKey, expiresAt: j.expiresAt, ttlMs: j.ttlMs, forced: j.forced === true, host: base };
  } catch (e) {
    return { ok: false, code: 'PASS_HOST_UNREACHABLE', message: `无法连接 host（${base}）：${e?.message ?? e}。DSH 未运行时无法发凭证。` };
  }
}

/** CLI 主入口（返回 {exitCode, result}，由包装脚本决定 process.exit）。 */
export async function main(argv, opts = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    return { exitCode: EXIT.USAGE, result: { ok: false, tool: 'butler-audit-cli', version: VERSION, error: e.message, usage: USAGE } };
  }
  if (args.help) return { exitCode: EXIT.PASS, result: { ok: true, tool: 'butler-audit-cli', version: VERSION, usage: USAGE } };
  if (args.version) return { exitCode: EXIT.PASS, result: { ok: true, tool: 'butler-audit-cli', version: VERSION } };
  if (args.selfCheck) {
    return {
      exitCode: EXIT.PASS,
      result: {
        ok: true, tool: 'butler-audit-cli', version: VERSION, selfCheck: true,
        rulesDir: opts.rulesDir ?? RULES_DIR, rulesLoaded: loadRules(opts.rulesDir).length,
        auditDir: butlerPaths(opts.home).auditDir,
      },
    };
  }
  return runAudit(args, opts);
}

/** 人类可读摘要（--json 之外）。 */
export function formatResult(result) {
  const lines = [];
  if (!result || typeof result !== 'object') return String(result);
  if (result.error) {
    lines.push(`❌ ${result.error}`);
    if (result.usage) lines.push(result.usage);
    return lines.join('\n');
  }
  if (result.usage) { lines.push(result.usage); return lines.join('\n'); }
  if (result.selfCheck) {
    lines.push(`✅ self-check：rulesDir=${result.rulesDir} rulesLoaded=${result.rulesLoaded} auditDir=${result.auditDir}`);
    return lines.join('\n');
  }
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const mark = result.verdict === 'pass' ? '✅' : (result.verdict === 'warn' ? '🟡' : '⛔');
  lines.push(`${mark} verdict=${result.verdict}  rules=${result.rulesLoaded ?? '?'}  findings=${findings.length}  runId=${result.runId}`);
  if (result.input) lines.push(`   input: mode=${result.input.mode} file=${result.input.file ?? '-'} sha256=${result.input.sha256 ?? '-'} bytes=${result.input.bytes ?? '-'}`);
  for (const f of findings) lines.push(`   - [${f.level}] ${f.rule}: ${f.message}`);
  if (result.pass) lines.push(`   凭证：${result.pass.ok ? `✅ 已发放（${result.pass.pathKey}，${Math.round((result.pass.ttlMs ?? 0) / 60000)} 分钟有效${result.pass.forced ? '，force' : ''}）` : `❌ ${result.pass.code}：${result.pass.message}`}`);
  if (result.note) lines.push(`   note: ${result.note}`);
  return lines.join('\n');
}
