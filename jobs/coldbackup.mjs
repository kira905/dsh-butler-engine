#!/usr/bin/env node
/**
 * coldbackup.mjs —— 冷备作业（**一个 job 按序跑完"整套冷备"**）
 *
 * 出处：主人 2026-10-13 16:12 拍板 #12/#13（逐字见 `docs\交接-愿景实体核查-20261013.md` §6b）：
 *   「改成每周一和周五各 1 次冷备，时间中午 13 点，遇到周一周五非工作日（冷盘不可达）就跳过」
 *   + 「同意加 `benignExitCodes:[3]`」。
 *   归并前 = 三个 tickd job（`imagegen` 每小时索引快照 / `imagegen-full` 每周图片镜像 /
 *   `rollback-offsite` 工作日回滚点打包）—— 三套调度、三种频率、三个开关，冷盘不可达时各自刷红。
 *   归并后 = **一个 job `coldbackup`**（MON+FRI 13:00），内部**按序**跑。
 *
 * 🔧 **2026-10-27 变三件**（主人 11:20 令「仓退役、同步走长租隧道、拆钩子」；方案
 *   `docs\方案-仓退役与隧道常驻-20261027.md` §3 批1 的 1-3 格，已过审 plan-gate）：
 *   仓1 停采后 `~\.dsh` 的配置 / 预设 / 技能 / 账本 / 记忆库就没有异地副本了 ——
 *   既有两件都盖不住（`snapshot` job 的对端镜像硬排除凭据、只留 6 份/72h；`rollback-points-offsite`
 *   管的是"回滚点"不是"配置整包"）⇒ 加第 ② 件 `config-snapshot.mjs`（能逐文件 sha256 校验、能原样灌回）。
 *   ⚠️ **本件不是"第三条冷备链"**：它就是这条链的第三格，凭据排除 / fail-closed 自查 / rc=3 让路 /
 *   保留策略全部沿用既有铁律（方案 §7「不新造第三条链」）。
 *   ⚠️ tickd JOBS 里那条 `coldbackup` 的 `label` 至今仍写「回滚点 + 生图」（`butler-tickd.mjs` L400/L416）——
 *   改它必须重启 tickd 才生效，**不在 1-3 这张卡的范围**（卡面红线：只动 coldbackup.mjs + 新件 + 单测），
 *   已登记为待续项；真源以本文件为准。
 *
 * 步骤（顺序是口径的一部分，别调换）：
 *   ① 回滚点打包：`rollback-points-offsite.mjs --backup --prune`   （冷盘 = 解析器口径，禁写死盘符）
 *   ② 关键配置整包：`config-snapshot.mjs --snapshot`                （`<盘根>\dsh-config-snapshot\<YYYYMMDD-HHmm>\`）
 *   ③ 生图索引快照 + 图片镜像：`imagegen-backup.mjs --snapshot --with-images`
 *   为什么 ② 在 ③ 之前（而不是接在尾巴上）：仓退役后配置整包是**唯一**的异地副本，而生图镜像是最慢的一件
 *   （图像增量 + 大 I/O）。万一半路盘被拔/时间不够，宁可少一天生图镜像，也别缺那份配置整包。
 *
 * 退出码（tickd 侧的记账语义直接吃它）：
 *   0 = 三件都成功（含"无变化"）
 *   3 = **冷盘不可达**（各件脚本自己的让路码；tickd 据 JOBS 的 `benignExitCodes:[3]` 记 `deferred`、
 *       **不涨 failures**）——「非工作日冷盘不在 ⇒ 跳过」就是这条路
 *   1 = 有**真失败**（任一件返回 {0,3} 以外的码）
 *   ⚠️ 真失败优先：①失败(1) + ②让路(3) ⇒ 整体 1（**不许**把真失败降级成"让路"）
 *
 * 三条行为口径：
 *   ① **按序串行、互不阻断**：前一件跑完才起后一件；前一件失败**不跳过**后一件
 *      （三件写的是冷盘上三个互不相干的目录，各自独立成败 —— 少备一样不如三样都试一次）。
 *   ② **后一件失败不影响前一件已完成的成果**：三件各写各的目录、无共享暂存区、不共享"提交点"；
 *      前件返回时它的字节**已经落盘**（脚本内部逐文件 sha 校验），后件再失败也动不到它。
 *   ③ **失败可见（不静默）**：每件逐条打印 `exit code / 耗时 / 结论`，最后一段汇总 +
 *      真失败时明确指出去哪看（tickd `state.json#jobs.coldbackup.lastError` / tickd 日志 /
 *      非 0 退出的输出尾部留痕 `<tmp>\dsh-butler-tickd\traces\`）。
 *
 * 用法：
 *   node coldbackup.mjs                     # 跑全套（三件按序）
 *   node coldbackup.mjs --only rollback     # 只跑 ①（夹具/排障用）
 *   node coldbackup.mjs --only config       # 只跑 ②（配置整包 · 本卡真跑验收走这条）
 *   node coldbackup.mjs --only imagegen     # 只跑 ③
 *   node coldbackup.mjs --only rollback,config   # 逗号可组合
 *   node coldbackup.mjs --dry-run           # 只打印将做什么，不 spawn（零写入）
 *   node coldbackup.mjs --help
 *
 * 冷盘根怎么定：**本脚本不管**（不传 --target、不吞环境变量）—— 三件脚本各自有唯一解析口径
 *   （回滚点/配置整包 = `tools/lib/rollback-points-root.mjs`；生图 = `tools/lib/imagegen-backup-root.mjs`：
 *   `--target` > 环境变量 > 主机名默认）。本脚本原样继承 process.env ⇒ 设
 *   `ROLLBACK_POINTS_ROOT` / `IMAGEGEN_BACKUP_ROOT` 即可把三件一起改道（夹具就这么喂"盘不可达"）。
 * 安全铁律：本脚本**只读自己的参数**，不碰任何数据文件；写入一律发生在三个子脚本内部（源目录只读）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))       // …\tools\dsh-butler
const TOOLS = path.resolve(HERE, '..')                          // …\tools

/** 冷盘不可达 = 三件脚本共同声明的让路码（也是 JOBS 里 benignExitCodes 的取值）。 */
export const EXIT_DRIVE_UNAVAILABLE = 3

/** 作业步骤表（顺序 = 执行顺序；改顺序要连带改 tickd JOBS 注释与交付报告）。 */
export const STEPS = [
  {
    id: 'rollback',
    label: '① 回滚点打包（冷盘异地化 + 按策略清理）',
    script: path.join(TOOLS, 'rollback-points-offsite.mjs'),
    args: ['--backup', '--prune'],
    dir: TOOLS,
  },
  {
    // 2026-10-27 1-3（仓退役方案批1）：配置整包 —— 仓1 停采后 `~\.dsh` 唯一的异地副本。
    // 排在 ①（回滚点）之后、③（生图镜像）之前：③ 最慢且已有独立索引链，时间不够时宁可少它。
    id: 'config',
    label: '② 关键配置整包（冷盘 · 可逐文件 sha256 回灌）',
    script: path.join(HERE, 'config-snapshot.mjs'),
    args: ['--snapshot'],
    dir: HERE,
  },
  {
    id: 'imagegen',
    label: '③ 生图索引快照 + 图片镜像（冷盘）',
    script: path.join(TOOLS, 'imagegen-backup.mjs'),
    args: ['--snapshot', '--with-images'],
    dir: TOOLS,
  },
]

/**
 * 聚合多件退出码 → 作业整体退出码（**纯函数**，单测/夹具直接调）。
 * 规则：任一真失败 ⇒ 1；否则任一"盘不可达" ⇒ 3；否则 0。
 * @param {Array<number|null>} codes 每件退出码（null = 未能执行/被信号杀，按真失败处理）
 * @returns {{code:number, failed:number[], deferred:number[], ok:number[]}}
 */
export function aggregateExitCodes(codes) {
  const failed = [], deferred = [], ok = []
  for (const c of codes) {
    if (c === 0) ok.push(c)
    else if (c === EXIT_DRIVE_UNAVAILABLE) deferred.push(c)
    else failed.push(c)                 // 含 null / undefined / 其它非 0
  }
  const code = failed.length ? 1 : (deferred.length ? EXIT_DRIVE_UNAVAILABLE : 0)
  return { code, failed, deferred, ok }
}

/**
 * 按序跑作业。
 * @param {{dryRun?:boolean, only?:string[]|null, log?:(s:string)=>void, env?:object, spawn?:Function}} opts
 *   dryRun 缺省 false（这是**作业本体**：tickd 就是要它真跑）；`--dry-run` 由 CLI 传 true。
 * @returns {{code:number, results:Array<{id:string, label:string, rc:number|null, ms:number}>}}
 */
export function runColdBackup(opts = {}) {
  const dryRun = opts.dryRun === true
  const log = opts.log ?? ((s) => console.log(s))
  const only = opts.only && opts.only.length ? new Set(opts.only) : null
  const spawn = opts.spawn ?? spawnSync
  const env = opts.env ?? process.env
  const steps = STEPS.filter((s) => !only || only.has(s.id))
  if (!steps.length) { log('[coldbackup] 没有匹配的步骤（--only 传了什么？合法值：rollback / config / imagegen）'); return { code: 2, results: [] } }

  const results = []
  log(`[coldbackup] 冷备作业开始（${steps.length} 件，按序串行；冷盘根由各子脚本自己解析）${dryRun ? ' · DRY-RUN' : ''}`)
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]
    log(`[coldbackup] ── 第 ${i + 1}/${steps.length} 件 · ${st.label}`)
    log(`[coldbackup]    ${path.basename(st.script)} ${st.args.join(' ')}`)
    if (dryRun) { results.push({ id: st.id, label: st.label, rc: null, ms: 0 }); continue }
    const t0 = Date.now()
    // stdio 继承：子脚本输出直接进 tickd 的管道（tickd 非 0 退出时会把它作为"输出尾部"留痕）
    const r = spawn(process.execPath, [st.script, ...st.args], { stdio: 'inherit', cwd: st.dir, env, windowsHide: true })
    const ms = Date.now() - t0
    const rc = r?.status ?? null
    results.push({ id: st.id, label: st.label, rc, ms })
    const verdict = rc === 0 ? '成功'
      : rc === EXIT_DRIVE_UNAVAILABLE ? '让路（冷盘不可达 ⇒ 本件跳过，不计失败）'
        : `真失败（exit ${rc ?? 'null（未正常退出/被信号杀）'}）`
    log(`[coldbackup]    ↳ ${st.id}: exit ${rc ?? 'null'} · ${(ms / 1000).toFixed(1)}s · ${verdict}`)
    log(`[coldbackup]    已完成的部分不受后续步骤影响（各写各的冷盘目录，无共享提交点）`)
  }

  const agg = aggregateExitCodes(results.map((r) => r.rc))
  if (dryRun) { log('[coldbackup] DRY-RUN 结束（未执行任何步骤）'); return { code: 0, results } }

  log('[coldbackup] ── 汇总')
  for (const r of results) log(`[coldbackup]    ${r.id.padEnd(9)} exit ${String(r.rc).padEnd(4)} ${(r.ms / 1000).toFixed(1)}s`)
  if (agg.code === 0) log('[coldbackup] 结论：✅ 三件都成功（含"无变化"）')
  else if (agg.code === EXIT_DRIVE_UNAVAILABLE) {
    log('[coldbackup] 结论：🧊 冷盘不可达 ⇒ 本轮整体让路（tickd 记 deferred、**不计失败**）')
    log('[coldbackup]    盘在单位/外接带走时属常态；盘一回来下一轮自动正常跑，无需人工干预。')
  } else {
    const bad = results.filter((r) => r.rc !== 0 && r.rc !== EXIT_DRIVE_UNAVAILABLE)
    log(`[coldbackup] 结论：🔴 真失败 ${bad.length} 件 —— ${bad.map((b) => `${b.id}=exit ${b.rc}`).join(' / ')}`)
    log('[coldbackup]    去哪看：tickd state.json#jobs.coldbackup.lastError · tickd 日志 ·')
    log('[coldbackup]    输出尾部留痕（<tmp>\\dsh-butler-tickd\\traces\\coldbackup-*.log）')
  }
  return { code: agg.code, results }
}

// ---------------------------------------------------------------- CLI
const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node coldbackup.mjs [--only rollback|config|imagegen] [--dry-run]')
    console.log('  ① rollback = 回滚点打包 · ② config = 关键配置整包 · ③ imagegen = 生图索引/镜像')
    console.log('  三件按序串行、互不阻断；冷盘不可达 ⇒ 整体 rc=3（tickd 记 deferred、不涨 failures）')
    process.exitCode = 0
  } else {
    const onlyIdx = argv.indexOf('--only')
    const only = onlyIdx >= 0 && argv[onlyIdx + 1] ? String(argv[onlyIdx + 1]).split(',').map((s) => s.trim()).filter(Boolean) : null
    const res = runColdBackup({ dryRun: argv.includes('--dry-run'), only })
    process.exitCode = res.code
  }
}
