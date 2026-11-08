// 冒烟：本包能不能装、能不能跑、默认是不是"一条都不动"。
// 只读 + 只在临时目录里写，不读也不写真实 ~/.dsh、不碰 %TEMP%\dsh-butler-tickd。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const BIN = path.join(PKG, 'bin', 'butler-tickd.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-engine-smoke-'));

// 隔离三件：状态目录（锁/心跳）、butler 状态根（配置/审计）、作业树根
const env = {
  ...process.env,
  DSH_TICKD_DIR: path.join(TMP, 'tickd'),
  BUTLER_DSH_HOME: path.join(TMP, 'home'),
  BUTLER_ROOT: path.join(TMP, 'root'),
};
delete env.BUTLER_JOBS_DEFAULT;

let pass = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); return; }
  console.log(`FAIL ${name} ${detail}`);
  process.exitCode = 1;
};
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60_000 });

// ① 每个模块都能被 import（= 没有语法错、没有断掉的相对导入）
//    ⚠️ `_direct/` 例外：那一组是**随主件 scp 到对端执行**的独立 CLI（`node <script> <job.json>`），
//    运行时入口就是顶层语句、不是被 import 的模块；对它们的保证改成 ①b 的语法检查。
const files = [];
const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (n.endsWith('.mjs')) files.push(p); } };
walk(path.join(PKG, 'src'));
const importable = files.filter((f) => !/[/\\]_direct[/\\]/.test(f));
let imported = 0;
const broken = [];
for (const f of importable) {
  try { await import(new URL(`file://${f.replace(/\\/g, '/')}`).href); imported++; } catch (e) { broken.push(`${path.relative(PKG, f)}: ${e.message}`); }
}
ok('每个 .mjs 都能 import', broken.length === 0, `(${imported}/${importable.length}) ${broken.join(' | ')}`);

// ①b `_direct/` 远程脚本：只保证语法可解析（用 --check 起子进程，不 import）
const directBad = [];
for (const f of files.filter((x) => /[/\\]_direct[/\\]/.test(x))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) directBad.push(`${path.relative(PKG, f)}: ${(r.stderr ?? '').slice(0, 120)}`);
}
ok('_direct/ 远程脚本语法可解析', directBad.length === 0, directBad.join(' | '));

// ② 公共入口的导出面
const api = await import(new URL('file://' + path.join(PKG, 'src', 'index.mjs').replace(/\\/g, '/')));
ok('公共入口导出 ≥ 30 个名字', Object.keys(api).length >= 30, `实得 ${Object.keys(api).length}`);
ok('调度表 JOBS 非空', Array.isArray(api.JOBS) && api.JOBS.length > 0, `实得 ${api.JOBS?.length}`);

// ③ --help / --list / --status 三条只读命令
const help = run(['--help']);
ok('--help 退出码 0', help.status === 0, `rc=${help.status} ${help.stderr?.slice(0, 200)}`);
ok('--help 打出用法', /用法/.test(help.stdout ?? ''));

const list = run(['--list']);
ok('--list 退出码 0', list.status === 0, `rc=${list.status}`);
const listLines = (list.stdout ?? '').split('\n').filter((l) => l.trim() && !/^调度表|^用法|^├|^└|^#/.test(l));
ok('--list 行数 = JOBS 条数', listLines.length === api.JOBS.length, `实得 ${listLines.length} / ${api.JOBS.length}`);

const st = run(['--status']);
ok('--status 退出码 0', st.status === 0, `rc=${st.status}`);
let status = null;
try { status = JSON.parse(st.stdout ?? ''); } catch { /* 留空由下一条断言报 */ }
ok('--status 输出是 JSON', status !== null, (st.stdout ?? '').slice(0, 120));
ok('--status 自带 jobs 段', status && typeof status === 'object' && 'switches' in status);

// ④ 默认"缺键即关"：全新 home 下一条 job 都不许跑
ok('全新 home ⇒ 全部 job 被拦', Array.isArray(status?.switches?.blocked) && status.switches.blocked.length === api.JOBS.length,
  `被拦 ${status?.switches?.blocked?.length} / 共 ${api.JOBS.length}`);
ok('声明默认：未声明 defaultWhenUnset 的 job 也按关', api.declaredJobDefault({ id: 'x' }) === false);

// ⑤ BUTLER_JOBS_DEFAULT=on 时恢复"缺键即开"（老语义可回退）
const onEnv = { ...env, BUTLER_JOBS_DEFAULT: 'on' };
const onRun = spawnSync(process.execPath, [BIN, '--status'], { env: onEnv, encoding: 'utf8', timeout: 60_000 });
let onStatus = null;
try { onStatus = JSON.parse(onRun.stdout ?? ''); } catch { /* ignore */ }
ok('BUTLER_JOBS_DEFAULT=on ⇒ 恢复缺键即开', onRun.status === 0 && onStatus?.switches?.blocked?.length < api.JOBS.length,
  `被拦 ${onStatus?.switches?.blocked?.length} / 共 ${api.JOBS.length}`);

// ⑥ 显式放行一条 job（写配置）⇒ 它变成"可跑"，其它仍然关
const home = env.BUTLER_DSH_HOME;
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'butler-autonomy.json'), JSON.stringify({
  schemaVersion: 1, jobs: { restart: { enabled: true, by: 'smoke', why: 'smoke test', since: new Date().toISOString() } },
}), 'utf8');
const sw = api.isTickJobEnabled('restart', { home });
ok('配置里显式 enabled=true ⇒ 该 job 放行', sw.enabled === true && sw.source === 'file', JSON.stringify(sw));
const swOther = api.isTickJobEnabled('queue', { home, defaultEnabled: api.declaredJobDefault({ id: 'queue' }) });
ok('同配置下其它 job 仍关', swOther.enabled === false, JSON.stringify(swOther));

// ⑦ --once 在没有到期任务时不该报错
const once = run(['--once']);
ok('--once 退出码 0', once.status === 0, `rc=${once.status} ${once.stderr?.slice(0, 200)}`);
ok('--once 不启动任何作业', /无到期任务|被开关拦下/.test(once.stdout ?? ''), (once.stdout ?? '').slice(0, 200));

// ⑧ 生产树零写入：真实 ~/.dsh 与 %TEMP%\dsh-butler-tickd 的 mtime 不该变
//    ⚠️ 若本机**正在跑一个真实的常驻调度器**，它会每分钟自己刷 state.json —— 那不是"本测试写的"。
//      判据因此分两步：mtime 变了 ⇒ 看 state.json 里的 pid 是否还活着（活着 = 是它写的，不是我们）。
const realState = path.join(process.env.TEMP || os.tmpdir(), 'dsh-butler-tickd', 'state.json');
const before = fs.existsSync(realState) ? fs.statSync(realState).mtimeMs : null;
run(['--status']);
const after = fs.existsSync(realState) ? fs.statSync(realState).mtimeMs : null;
let liveWriter = false;
if (before !== after) {
  try {
    const j = JSON.parse(fs.readFileSync(realState, 'utf8'));
    const pid = Number(j?.pid ?? j?.runnerPid ?? 0);
    if (pid > 0) { try { process.kill(pid, 0); liveWriter = true; } catch { /* 进程已死 ⇒ 不是它 */ } }
  } catch { /* 读不出来 ⇒ 不算它写的 */ }
}
ok('本测试未触碰真实 tickd 状态文件', before === after || liveWriter, `before=${before} after=${after} liveWriter=${liveWriter}`);

console.log(`\n${pass} 条通过${process.exitCode ? ' · 有失败' : ' · 全绿'}`);
fs.rmSync(TMP, { recursive: true, force: true });
