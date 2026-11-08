// 批7 判据：作业入口的三级解析（jobs/ → BUTLER_JOBS_DIR → job.dir → skipped-missing-src）
// 只读 + 只在临时目录里写；不碰真实 ~/.dsh、不 spawn 任何作业。
// 判据四条（含阴性对照）：
//   ① 包内 jobs/ 命中，source='jobs'
//   ② 宿主目录命中（env 给了），source='host-dir'；且同名时它排在 jobs/ 之后
//   ③ 内核位置命中，source='pkg-dir'
//   ④ 都不在 ⇒ ok:false，runJob 侧记 skipped-missing-src（不进失败计分）
//   ⑤ 阴性对照：`job.dir` 里有个同名文件、但脚本名写错一个字母 ⇒ 仍然 ok:false（不许瞎中）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-job-resolve-'));
const HOSTDIR = path.join(TMP, 'host-jobs');
const PKGDIR = path.join(TMP, 'pkg-dir');
fs.mkdirSync(HOSTDIR, { recursive: true });
fs.mkdirSync(PKGDIR, { recursive: true });

let pass = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); return; }
  console.log(`FAIL ${name} ${detail}`);
  process.exitCode = 1;
};

const url = (rel) => new URL(`file://${path.join(PKG, rel).replace(/\\/g, '/')}`).href;
const T = await import(url('src/dsh-butler/butler-tickd.mjs'));

ok('JOBS_DIR 指向包内 jobs/', /[\\/]jobs$/.test(T.JOBS_DIR), T.JOBS_DIR);
ok('JOBS_DIR 真的存在', fs.existsSync(T.JOBS_DIR), T.JOBS_DIR);
ok('JOBS_DIR_ENV 口径名', T.JOBS_DIR_ENV === 'BUTLER_JOBS_DIR', String(T.JOBS_DIR_ENV));

// ① 包内 jobs/ 命中（挑一个实际随包带的脚本）
const shipped = fs.readdirSync(T.JOBS_DIR).filter((f) => f.endsWith('.mjs')).sort();
ok('jobs/ 里有随包作业脚本', shipped.length >= 20, `实得 ${shipped.length}`);
{
  const r = T.resolveJobEntry({ script: shipped[0], dir: PKGDIR }, {});
  ok('① jobs/ 命中且 source=jobs', r.ok === true && r.source === 'jobs' && path.resolve(r.entry) === path.resolve(path.join(T.JOBS_DIR, shipped[0])), JSON.stringify(r));
}

// ② 宿主目录：jobs/ 里没有的名字，env 指过去才命中
const hostOnly = 'b7-host-only.mjs';
fs.writeFileSync(path.join(HOSTDIR, hostOnly), '// host copy\n', 'utf8');
{
  const r0 = T.resolveJobEntry({ script: hostOnly, dir: PKGDIR }, {});
  ok('② env 未给 ⇒ 不命中（阴性对照）', r0.ok === false && r0.reason === 'missing', JSON.stringify(r0));
  const r = T.resolveJobEntry({ script: hostOnly, dir: PKGDIR }, { [T.JOBS_DIR_ENV]: HOSTDIR });
  ok('② env 给了 ⇒ source=host-dir', r.ok === true && r.source === 'host-dir' && path.resolve(r.entry) === path.resolve(path.join(HOSTDIR, hostOnly)), JSON.stringify(r));
  const tried = (r0.tried ?? []).map((p) => path.resolve(p));
  ok('② 试过的落点里含 jobs/ 与 pkg-dir（顺序可核）',
    tried.includes(path.resolve(path.join(T.JOBS_DIR, hostOnly))) && tried.includes(path.resolve(path.join(PKGDIR, hostOnly))), JSON.stringify(tried));
}

// ②b 同名优先：jobs/ 与宿主目录同名时，jobs/ 先命中
{
  const both = shipped[0];
  fs.writeFileSync(path.join(HOSTDIR, both), '// host shadow copy\n', 'utf8');
  const r = T.resolveJobEntry({ script: both, dir: PKGDIR }, { [T.JOBS_DIR_ENV]: HOSTDIR });
  ok('②b 同名时 jobs/ 优先（不被宿主目录顶掉）', r.ok === true && r.source === 'jobs', JSON.stringify(r));
}

// ③ 内核位置：job.dir
const pkgOnly = 'b7-pkg-only.mjs';
fs.writeFileSync(path.join(PKGDIR, pkgOnly), '// core copy\n', 'utf8');
{
  const r = T.resolveJobEntry({ script: pkgOnly, dir: PKGDIR }, {});
  ok('③ job.dir 命中 ⇒ source=pkg-dir', r.ok === true && r.source === 'pkg-dir' && path.resolve(r.entry) === path.resolve(path.join(PKGDIR, pkgOnly)), JSON.stringify(r));
}

// ④ 都没有 ⇒ missing（不含 spawn）
{
  const r = T.resolveJobEntry({ script: 'b7-nobody-has-this.mjs', dir: PKGDIR }, {});
  ok('④ 找不到 ⇒ ok:false / reason=missing', r.ok === false && r.reason === 'missing', JSON.stringify(r));
}
{
  const r = T.resolveJobEntry({}, {});
  ok('④ 空 script ⇒ reason=empty-script', r.ok === false && r.reason === 'empty-script', JSON.stringify(r));
}

// ⑤ 阴性对照：同名差一个字母 ⇒ 不许中
{
  const r = T.resolveJobEntry({ script: 'b7-pkg-onl.mjs', dir: PKGDIR }, {});
  ok('⑤ 阴性对照（差一个字母）⇒ 不命中', r.ok === false, JSON.stringify(r));
}

// ⑥ 绝对路径照用
{
  const abs = path.join(PKGDIR, pkgOnly);
  const r = T.resolveJobEntry({ script: abs }, {});
  ok('⑥ 绝对路径 ⇒ source=absolute', r.ok === true && r.source === 'absolute', JSON.stringify(r));
  const r2 = T.resolveJobEntry({ script: path.join(PKGDIR, 'nope.mjs') }, {});
  ok('⑥ 绝对路径不存在 ⇒ 不命中', r2.ok === false, JSON.stringify(r2));
}

// ⑦ skipped-missing-src 必须被健康判据当「让路」，不许当失败
{
  const H = await import(url('src/dsh-butler/lib/tickd-health.mjs'));
  ok('⑦ BENIGN_STATUSES 含 skipped-missing-src', H.BENIGN_STATUSES.includes('skipped-missing-src'), JSON.stringify(H.BENIGN_STATUSES));
  ok('⑦ BENIGN_STATUSES 仍含 locked/busy/deferred',
    ['locked', 'busy', 'deferred'].every((s) => H.BENIGN_STATUSES.includes(s)), JSON.stringify(H.BENIGN_STATUSES));
}

// ⑧ JOBS 表里每条作业都能被解析成「有 / 没有」两种确定状态（不许抛）
{
  let threw = 0; let withSrc = 0;
  for (const j of T.JOBS) {
    try { const r = T.resolveJobEntry(j, {}); if (r.ok) withSrc++; } catch { threw++; }
  }
  ok('⑧ JOBS 全表解析不抛', threw === 0, `抛了 ${threw} 条`);
  ok('⑧ 至少 20 条作业能解析到脚本', withSrc >= 20, `实得 ${withSrc} / ${T.JOBS.length}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 条通过`);
