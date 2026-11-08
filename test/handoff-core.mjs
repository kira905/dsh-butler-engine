// 交接核心 + 宿主环境口径的自检（纯函数 + 临时目录，不碰真实状态）
//
// 覆盖 0.3.0 新增/改动里最容易悄悄坏掉的两块：
//   ① host-config：环境变量优先级、兜底、机器别名表（含坏 JSON 的回落）
//   ② handoff-core：锚点解析、绝对路径拒绝、清单展开、分发对偶门的四种判定
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-handoff-test-'));
let pass = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); return; }
  console.log(`FAIL ${name} ${detail}`);
  process.exitCode = 1;
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// ── ① host-config ────────────────────────────────────────────────────────────
// 逐条现设 / 现删环境变量（module 内的常量是加载时求值，所以每个场景都重新 import）
const loadCfg = async () => import('../src/lib/host-config.mjs?t=' + Math.random());

{
  delete process.env.BUTLER_DSH_ROOT;
  delete process.env.DSH_WORKSPACE;
  const cfg = await loadCfg();
  const root = cfg.dshRoot();
  ok('dshRoot 有兜底且非空', typeof root === 'string' && root.length > 0, root);
  ok('dshRoot 是绝对路径', path.isAbsolute(root), root);
  eq('peerAlias 未配置 ⇒ null', cfg.peerAlias(), null);
  eq('peerHome 未配置 ⇒ null', cfg.peerHome(), null);
  eq('selfBase 有兜底', cfg.selfBase(), 'http://127.0.0.1:3080');
  ok('selfHost 非空', cfg.selfHost().length > 0);
}

{
  process.env.BUTLER_DSH_ROOT = path.join(TMP, 'ws-root');
  process.env.BUTLER_REPO_ROOT = path.join(TMP, 'repos');
  process.env.BUTLER_PEER = 'peer-a';
  const cfg = await loadCfg();
  eq('BUTLER_DSH_ROOT 生效', cfg.dshRoot(), path.resolve(path.join(TMP, 'ws-root')));
  eq('BUTLER_REPO_ROOT 生效', cfg.repoRoot(), path.resolve(path.join(TMP, 'repos')));
  eq('BUTLER_PEER 生效', cfg.peerAlias(), 'peer-a');
  delete process.env.BUTLER_DSH_ROOT;
  delete process.env.BUTLER_REPO_ROOT;
  delete process.env.BUTLER_PEER;
}

{
  // 空白值一律视为未设置（历史坑：'   ' 是 truthy，会跳过下一级）
  process.env.BUTLER_DSH_ROOT = '   ';
  const cfg = await loadCfg();
  ok('空白 BUTLER_DSH_ROOT 视为未设置（不落到 cwd）', path.isAbsolute(cfg.dshRoot()) && cfg.dshRoot() !== path.parse(cfg.dshRoot()).root, cfg.dshRoot());
  delete process.env.BUTLER_DSH_ROOT;
}

{
  // 机器别名表：坏 JSON 不抛、回落到单机表；好 JSON 按键归一（小写 + 键自己也进别名）
  process.env.BUTLER_MACHINE_ALIASES = '{ 这不是 json';
  const cfgBad = await loadCfg();
  const bad = cfgBad.machineAliases();
  eq('坏 JSON ⇒ 只有本机一台', Object.keys(bad).length, 1);
  eq('坏 JSON ⇒ configured=true（配过但解析失败，调用方要能看出来）', cfgBad.machineAliasesConfigured(), true);

  process.env.BUTLER_MACHINE_ALIASES = JSON.stringify({ 'host-a': ['Alpha', 'a-1'], 'host-b': [] });
  const cfgGood = await loadCfg();
  const good = cfgGood.machineAliases();
  eq('好 JSON ⇒ 两个键', Object.keys(good).sort(), ['host-a', 'host-b']);
  ok('别名小写归一且含键本身', good['host-a'].includes('alpha') && good['host-a'].includes('host-a'), JSON.stringify(good['host-a']));
  ok('空别名表只剩键本身', JSON.stringify(good['host-b']) === JSON.stringify(['host-b']), JSON.stringify(good['host-b']));
  delete process.env.BUTLER_MACHINE_ALIASES;
}

// ── ② handoff-core ──────────────────────────────────────────────────────────
const core = await import('../src/dsh-butler/lib/handoff-core.mjs');

{
  const ctx = { dshHome: path.join(TMP, 'home'), dshRoot: path.join(TMP, 'ws') };
  eq('anchorRoot(dsh)', core.anchorRoot('dsh', ctx), ctx.dshHome);
  eq('anchorRoot(ws)', core.anchorRoot('ws', ctx), ctx.dshRoot);
  eq('anchorRoot(未知锚点) ⇒ null', core.anchorRoot('nope', ctx), null);
  eq('ANCHORS 只有 dsh/ws', core.ANCHORS, ['dsh', 'ws']);
}

{
  // 绝对路径检测：交接单写盘前必须挡住
  const bad = core.findAbsolutePaths({ a: 'x', b: { c: 'D:\\secret\\path.txt' } });
  ok('绝对路径能被检出来', bad.length >= 1, JSON.stringify(bad));
  const clean = core.findAbsolutePaths({ a: 'dsh/skills/x.md', b: { c: 'ws:tools/lib/a.mjs' } });
  eq('锚点 + 相对路径不算绝对路径', clean.length, 0);

  const rec = core.emptyRecord('unit-test-host', '2026-01-01T00:00:00.000Z');
  const v = core.assertWritableRecord(rec);
  ok('空交接单能过写盘校验', v.ok === true, JSON.stringify(v.errors));

  const dirty = { ...rec, note: 'D:\\leak\\x' };
  const v2 = core.assertWritableRecord(dirty);
  ok('带绝对路径的交接单被拒', v2.ok === false, JSON.stringify(v2.errors));
}

{
  // 清单展开：dir 条目按 rel 递归、坏锚点报错、skip 规则生效
  const ws = path.join(TMP, 'ws2');
  fs.mkdirSync(path.join(ws, 'tools', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'tools', '_tmp'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'tools', 'lib', 'a.mjs'), 'a');
  fs.writeFileSync(path.join(ws, 'tools', 'lib', 'b.mjs.bak'), 'b');
  fs.writeFileSync(path.join(ws, 'tools', '_tmp', 'c.mjs'), 'c');

  const files = core.listFilesRecursive(path.join(ws, 'tools'));
  ok('listFilesRecursive 收录 a.mjs', files.includes('lib/a.mjs'), JSON.stringify(files));
  ok('跳过 .bak 文件', !files.some((f) => f.endsWith('.bak')), JSON.stringify(files));
  ok('跳过 _tmp 目录', !files.some((f) => f.startsWith('_tmp/')), JSON.stringify(files));

  const ctx = { dshHome: path.join(TMP, 'home'), dshRoot: ws, workDirs: { 'dsh-workspace': ws } };
  const exp = core.expandManifestEntry({ key: 'ws:tools/lib', repo: 'dsh-workspace', repoPath: 'tools/lib', anchor: 'ws', rel: 'tools/lib', type: 'dir', enabled: true }, ctx);
  ok('expandManifestEntry(dir) 展开出 a.mjs', JSON.stringify(exp).includes('lib/a.mjs'), JSON.stringify(exp).slice(0, 200));
  ok('展开出的 key 是 <锚点>:<生产相对路径>', (exp.files?.[0]?.key ?? '').startsWith('ws:tools/lib/'), JSON.stringify(exp.files?.[0]));
  const dis = core.expandManifestEntry({ key: 'ws:x', anchor: 'ws', rel: 'x', type: 'dir', enabled: false }, ctx);
  ok('enabled:false 的条目不展开（进 disabled）', dis.disabled === true && dis.files.length === 0);
  const badAnchor = core.expandManifestEntry({ key: 'zz:x', anchor: 'zz', rel: 'x', type: 'file' }, ctx);
  ok('未知锚点报错而不是静默', Boolean(badAnchor.error), JSON.stringify(badAnchor));
}

{
  // 分发对偶门（T3）：六种判定的真文件夹具（仓内源 + 生产目标都在临时目录里）
  const srcDir = path.join(TMP, 'src');
  const dstDir = path.join(TMP, 'dst');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(dstDir, { recursive: true });
  const src = path.join(srcDir, 'a.mjs');
  const dst = path.join(dstDir, 'a.mjs');
  fs.writeFileSync(src, 'content-1');
  const items = (dstPath) => [{ key: 'ws:a.mjs', src, dst: dstPath, repoPath: 'a.mjs' }];

  let r = core.planDispatch(items(dst), {});
  eq('目标不存在 ⇒ applied（新增，无覆盖风险）', r.plan[0].action, 'applied');

  fs.writeFileSync(dst, 'content-1');
  r = core.planDispatch(items(dst), {});
  eq('与仓内一致 ⇒ unchanged', r.plan[0].action, 'unchanged');

  fs.writeFileSync(dst, 'other-content');
  r = core.planDispatch(items(dst), {});
  eq('无基线且内容不同 ⇒ skipped-unrecorded（拒绝覆盖）', r.plan[0].action, 'skipped-unrecorded');
  ok('skipped-unrecorded 会出告警', r.alerts.some((a) => a.code === 'unrecorded'), JSON.stringify(r.alerts));

  const curSha = core.hashFile(dst).sha256;
  r = core.planDispatch(items(dst), { 'ws:a.mjs': { sha256: curSha } });
  eq('有基线且基线 == 当前 ⇒ applied（本机没改过）', r.plan[0].action, 'applied');

  r = core.planDispatch(items(dst), { 'ws:a.mjs': { sha256: 'deadbeefdeadbeef' } });
  eq('有基线但基线 != 当前 ⇒ skipped-diverged', r.plan[0].action, 'skipped-diverged');
  ok('skipped-diverged 会出告警', r.alerts.some((a) => a.code === 'diverged'), JSON.stringify(r.alerts));

  r = core.planDispatch(items(dst), { 'ws:a.mjs': { sha256: 'deadbeefdeadbeef' } }, { confirmDiverged: true });
  eq('--confirm-diverged ⇒ applied（人工确认覆盖）', r.plan[0].action, 'applied');

  r = core.planDispatch([{ key: 'ws:gone.mjs', src: path.join(srcDir, 'gone.mjs'), dst: path.join(dstDir, 'gone.mjs'), repoPath: 'gone.mjs' }], {});
  eq('仓内源不存在 ⇒ skipped-missing-src', r.plan[0].action, 'skipped-missing-src');
}

{
  // 版本身份 & 主机名（不依赖机器真名）
  eq('HANDOFF_CORE_VERSION', core.HANDOFF_CORE_VERSION, '0.1.0');
  eq('currentHost 认 DSH_HANDOFF_HOST', core.currentHost({ DSH_HANDOFF_HOST: 'MIXED-CASE' }), 'mixed-case');
  ok('currentHost 空环境也有值（不抛）', typeof core.currentHost({}) === 'string');
  ok('schema 文件随包存在', fs.existsSync(core.HANDOFF_SCHEMA_FILE), core.HANDOFF_SCHEMA_FILE);
  ok('分发清单随包存在', fs.existsSync(core.HANDOFF_MANIFEST_FILE), core.HANDOFF_MANIFEST_FILE);
  ok('清单能被解析且有条目', (core.loadManifest()?.entries ?? []).length > 0);
  ok('schema 能被解析', Boolean(core.loadSchema()));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 条通过`);
