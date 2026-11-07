// 批2 判据：通知注入点（默认 console + no-op / 注入后真发 / 同日同键去重 / 开关默认关）
// 只读 + 只在临时目录里写；不碰真实 ~/.dsh，不碰任何真实通道。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-notify-seam-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });

let pass = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); return; }
  console.log(`FAIL ${name} ${detail}`);
  process.exitCode = 1;
};

const url = (rel) => new URL(`file://${path.join(PKG, rel).replace(/\\/g, '/')}`).href;
const N = await import(url('src/dsh-butler/lib/notify.mjs'));
const STALL = await import(url('src/dsh-butler/stall-nudge.mjs'));

// ① 默认关：没配置文件 ⇒ 不开
ok('默认关（缺配置文件）', N.resolveAlertChannel({ home: HOME }).enabled === false);

// ② 缺省实现 = console + no-op：不注入时返回 no-channel，且 stderr 有一行
let captured = '';
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (s) => { captured += String(s); return true; };
let r1;
try {
  r1 = await N.notify({ level: 'warn', title: 't1', body: 'hello', channel: 'alert', home: HOME, alertChannel: 'on' });
} finally {
  process.stderr.write = origWrite;
}
ok('未注入 ⇒ 不假装发出（ok:false / no-channel）', r1.ok === false && r1.error === 'no-channel', JSON.stringify(r1));
ok('未注入 ⇒ 仍往 stderr 打一行（看得见）', /\[butler:notify\] warn t1/.test(captured), JSON.stringify(captured));

// ③ 注入后真发，参数形状对
const calls = [];
N.setNotifier((req) => { calls.push(req); return { ok: true, msgid: 'm-1' }; });
ok('setNotifier 记住注入', N.getNotifier() !== null && N.hasNotifier() === true);
const r2 = await N.notify({ level: 'alert', title: 't2', body: 'x', dedupeKey: 'k1', channel: 'alert', home: HOME, alertChannel: 'on' });
ok('注入后 ok:true + msgid 透传', r2.ok === true && r2.msgid === 'm-1', JSON.stringify(r2));
ok('注入收到的 request 字段齐', calls.length === 1 && calls[0].level === 'alert' && calls[0].title === 't2' && calls[0].dedupeKey === 'k1', JSON.stringify(calls[0]));

// ④ 同日同键只发一次
const before = calls.length;
const r3 = await N.notify({ level: 'alert', title: 't2', body: 'x', dedupeKey: 'k1', channel: 'alert', home: HOME, alertChannel: 'on' });
ok('同键二次 ⇒ deduped', r3.deduped === true && calls.length === before, JSON.stringify(r3));

// ⑤ 去重状态落盘（只在真发成功后写）
const dedupeFile = path.join(HOME, 'butler-notify-dedupe.json');
ok('去重状态落盘', fs.existsSync(dedupeFile) && fs.readFileSync(dedupeFile, 'utf8').includes('k1'));

// ⑥ 开关按配置文件生效（默认关 ⇒ 一个字节都不发）
fs.writeFileSync(path.join(HOME, 'butler-alert.json'), JSON.stringify({ channels: { alert: true } }), 'utf8');
ok('配置文件开 = 开', N.resolveAlertChannel({ home: HOME }).enabled === true);
const r4 = await N.notify({ level: 'info', title: 't3', body: 'y', channel: 'alert', home: HOME });
ok('配置开 ⇒ 真发', r4.ok === true);

// ⑦ sayAlert 形状对齐（调用点平移用）
const r5 = await N.sayAlert('一段正文', { home: HOME, dryRun: true });
ok('sayAlert dry-run 形状', r5.ok === false && r5.error === 'dry-run' && typeof r5.bytes === 'number' && r5.channelEnabled === true, JSON.stringify(r5));

// ⑧ stall-nudge 的发送腿走注入点
const r6 = await STALL.sendNudge({ text: '停滞提醒', home: HOME });
ok('stall-nudge 发送腿 ok', r6.ok === true && r6.serverId === 'm-1', JSON.stringify(r6));

N.setNotifier(null);
const r7 = await STALL.sendNudge({ text: '停滞提醒', home: HOME });
const alertLog = path.join(HOME, 'butler-alert.log');
ok('stall-nudge 无通道 ⇒ 失败且落告警日志', r7.ok === false && r7.error === 'no-channel' && fs.existsSync(alertLog), JSON.stringify(r7));

// ⑨ 六个入口都能正常吐用法（= bin/CLI 结构没断）
//    ⚠️ `steward-threads` 本来就没有 `--help` 分支（无参数/未知参数 ⇒ 打印用法 + rc 2，它自己的夹具就按这个锁的），
//      所以这里只要求"能跑起来 + 有用法可读"，不要求 rc=0。
const { spawnSync } = await import('node:child_process');
for (const entry of ['steward', 'steward-threads', 'steward-advice', 'failure-classify', 'progress-status', 'stall-nudge']) {
  const r = spawnSync(process.execPath, [path.join(PKG, 'src', 'dsh-butler', `${entry}.mjs`), '--help'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, BUTLER_DSH_HOME: HOME, BUTLER_ROOT: path.join(TMP, 'root'), BUTLER_DOCS_DIR: path.join(TMP, 'docs') },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const hasUsage = /用法|USAGE|--thread-new|--days|--json/.test(out);
  ok(`${entry} 能吐用法`, (r.status === 0 || r.status === 2) && hasUsage, `rc=${r.status} ${out.slice(0, 120)}`);
}

console.log(`\n${pass} 条通过`);
