// 依赖闭包（profiles/node_modules）链接指向扫描 —— 只读、零依赖、可跨机
//
// 用途（2026-09-13 卡）：把「闭包指向检查」变成不靠人记的只读体检项。
//
// 背景：<home>/profiles/node_modules 是 junction 指向盘外宿主目录（HOST_A:
// <offsync>\profiles-node_modules），宿主目录里每个包又是指向 **生产全局 npm 主包
// 自带依赖** 的 junction。测试/金丝雀 home 若与生产共用这套闭包，未来版主包的
// healProfilesModuleFallback 会按自己主包位置改写共享链接 ⇒ 生产重启即加载错版本包。
// 实测事故：2026-09-11，414 个链接被改指金丝雀闭包（0.1.5-rc.2 无 installSettingsSection）
// → dshmarket / imagegen / task-board-local 启动崩。
//
// 干净态判据（技能 dsh-test-env §8 现成口径，勿另造）：
//   **全部链接指向 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\*`；
//     出现指向 DSH-test* / canary 者即为污染。**
import { existsSync, lstatSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import { workspaceRoot } from './ws-root.mjs';
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 污染特征：路径段以 DSH-test 开头，或路径中出现 canary。 */
export const POLLUTION_PATTERNS = [
  { id: 'test-root', re: /(^|[\\/])DSH-test[^\\/]*/i },
  { id: 'canary', re: /canary/i },
]

export function isPollutedTarget(target) {
  if (typeof target !== 'string' || target === '') return false
  return POLLUTION_PATTERNS.some((p) => p.re.test(target))
}

function norm(p) {
  return String(p).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * 默认链接层 = DSH home 的 profiles/node_modules。
 * 覆写优先级：$DSH_PROFILES_HOME（显式指向链接层本体）> BUTLER_DSH_HOME / DSH_HOME（远程/测试 home）
 *            > ~/.dsh（生产默认）。
 * ★2026-09-14 环境边界修复：原先只认 DSH_PROFILES_HOME，测试/金丝雀实例里跑本模块的调用方
 *   （日报「🏗 结构健康」段、closure-check、repair-closure-links）会去体检**生产闭包**。
 *   不设环境变量时结果与改造前逐字节一致。
 */
export function defaultLinkRoot() {
  const explicit = process.env.DSH_PROFILES_HOME
  if (explicit && explicit.trim() !== '') return resolve(explicit.trim())
  const home = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME
  if (home && home.trim() !== '') return join(resolve(home.trim()), 'profiles', 'node_modules')
  return join(homedir(), '.dsh', 'profiles', 'node_modules')
}

/** 默认正确闭包根 = 全局 npm 安装的 @deepseek-ai/dsh 自带 node_modules。 */
export function defaultSourceRoot() {
  const appdata = process.env.APPDATA
  if (appdata && appdata.trim() !== '') return join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
  return null
}

/**
 * 收集链接层下所有 junction（含 @scope 一层；不穿透到包内部）。
 * 返回 [{ rel, full, target, targetExists, resolved }]
 */
export function collectLinks(linkRoot, { maxDepth = 2 } = {}) {
  const out = []
  const walk = (dir, prefix, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        let target = ''
        try {
          target = readlinkSync(full)
        } catch {
          /* ignore */
        }
        let resolved = ''
        try {
          resolved = realpathSync(full)
        } catch {
          resolved = ''
        }
        out.push({
          rel: prefix + entry.name,
          full,
          target,
          targetExists: target !== '' && existsSync(full),
          resolved,
        })
      } else if (st.isDirectory() && entry.name.startsWith('@') && depth < maxDepth) {
        walk(full, prefix + entry.name + '/', depth + 1)
      }
    }
  }
  walk(linkRoot, '', 0)
  return out
}

/**
 * 扫描并分类。level: ok | warn | danger
 *   danger = 存在指向 DSH-test* / canary 的链接（生产可能加载错版本包）
 *   warn   = 无污染但有断链（目标不存在）
 */
export function scanClosureLinks({ linkRoot = defaultLinkRoot(), sourceRoot = defaultSourceRoot() } = {}) {
  const result = {
    ok: false,
    reason: null,
    linkRoot,
    sourceRoot,
    physicalRoot: null,
    total: 0,
    matched: 0,
    polluted: [],
    broken: [],
    other: [],
    level: 'ok',
  }
  if (!linkRoot || !existsSync(linkRoot)) {
    result.reason = 'link-root-missing'
    result.level = 'warn'
    return result
  }
  if (!sourceRoot) {
    result.reason = 'source-root-unresolved'
    result.level = 'warn'
    return result
  }
  try {
    result.physicalRoot = realpathSync(linkRoot)
  } catch {
    result.physicalRoot = linkRoot
  }

  const links = collectLinks(linkRoot)
  result.total = links.length
  const src = norm(sourceRoot) + sep
  for (const link of links) {
    if (isPollutedTarget(link.target)) {
      result.polluted.push(link)
      continue
    }
    if (norm(link.target).startsWith(src)) {
      result.matched += 1
      continue
    }
    if (!link.targetExists) result.broken.push(link)
    else result.other.push(link)
  }

  result.level = result.polluted.length > 0 ? 'danger' : result.broken.length > 0 ? 'warn' : 'ok'
  result.ok = true
  return result
}

/** [rel, target] 形态的紧凑样例，供日报/面板渲染。 */
export function pollutionSamples(scan, n = 5) {
  return scan.polluted.slice(0, n).map((l) => ({ rel: l.rel, target: l.target, targetExists: l.targetExists }))
}

export function formatScanLine(scan) {
  if (!scan.ok) return `闭包指向检查：无法扫描（${scan.reason || 'unknown'}）`
  if (scan.level === 'danger') {
    return `闭包指向：**${scan.polluted.length}** 个链接指向测试/金丝雀闭包（应为 0）`
  }
  if (scan.level === 'warn') {
    return `闭包指向：干净，但 ${scan.broken.length} 个链接目标不存在（断链）`
  }
  return `闭包指向：干净（${scan.total} 个链接全部指向生产闭包）`
}

// ---------------------------------------------------------------------------
//  归因 + 修法（2026-09-14 补 · 卡「闭包闸」B 段）
//  只生成「哪台实例干的、怎么修」的措辞 —— **判定口径仍是上面那一套，勿在此另造**。
// ---------------------------------------------------------------------------

/** 污染目标 → 归属实例计数：canary（金丝雀）/ test（测试实例）/ other。 */
export function attributePollution(links = []) {
  const out = { canary: 0, test: 0, other: 0, samples: { canary: null, test: null, other: null } }
  for (const l of links) {
    const t = String(l?.target || '')
    const kind = /canary/i.test(t)
      ? 'canary'
      : /(^|[\\/])DSH-test[^\\/]*/i.test(t) ? 'test' : 'other'
    out[kind] += 1
    if (!out.samples[kind]) out.samples[kind] = { rel: l.rel, target: t }
  }
  return out
}

/** 归因结论一行（人读；无污染返回空串）。 */
export function formatAttributionLine(scan) {
  if (!scan || !Array.isArray(scan.polluted) || scan.polluted.length === 0) return ''
  const a = attributePollution(scan.polluted)
  const bits = []
  if (a.canary) bits.push(`${a.canary} 个指向【金丝雀实例的包】（路径含 canary，典型 = <测试根>-canary\\dsh-pkg\\node_modules\\*）`)
  if (a.test) bits.push(`${a.test} 个指向【测试实例的包】（路径含 DSH-test*）`)
  if (a.other) bits.push(`${a.other} 个指向其他测试路径`)
  return `归因：${bits.join('；')} ⇒ 肇事者 = 跑过未来版主包的测试/金丝雀实例（它的 healProfilesModuleFallback 按自己主包位置改写了共享闭包）。`
}

/**
 * 生产工具链侧修法入口（2026-09-14 批次 11 补）。
 * **与 `tools\dsh-butler\lib\auto-heal.mjs` 的 `POINTER_ENTRY_DECL['closure']` 同名同口径**（同一份修法，
 * 一处声明给 auto-heal 当执行入口、一处在体检/启动哨兵里给人读的处置提示）。
 */
export const TOOLS_REPAIR_SCRIPTS = [
  {
    script: 'repair-closure-links.mjs',
    label: '生产工具链修法脚本（tools\\repair-closure-links.mjs：把指向测试/金丝雀的链接重建为**生产闭包**指向；生产闭包无同名包则只删链接、不造物）',
  },
]

/**
 * 本机修法脚本探测（存在性判定，兼容 HOST_C / HOST_A 两套）。
 * 顺序 = ① 生产工具链侧（随仓3同步、跨机同口径 → **优先**）→ ② 测试根自带脚本 → ③ 盘外脚本。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{toolsRoot?:string}} [opts]
 */
export function repairCommands(env = process.env, opts = {}) {
  const out = []
  const seen = new Set()
  const toolsRoot = opts.toolsRoot ?? env.DSH_TOOLS_DIR ?? path.join(workspaceRoot(), 'tools')
  for (const t of TOOLS_REPAIR_SCRIPTS) {
    const p = join(String(toolsRoot), t.script)
    if (existsSync(p) && !seen.has(p.toLowerCase())) {
      seen.add(p.toLowerCase())
      out.push({ path: p, host: 'tools', label: t.label })
    }
  }
  // 候选测试根：HOST_A 2026-09-14 起 = <offsync>\DSH-test（H: 是搬家前旧位置，保留兼容）；HOST_C = F:
  const testRoots = [env.DSH_TEST_ROOT, env.DSH_CANARY_ROOT].filter(Boolean)
  for (const r of testRoots) {
    const p = join(String(r), 'scripts', 'repair-shared-modules.mjs')
    if (seen.has(p.toLowerCase())) continue
    seen.add(p.toLowerCase())
    if (existsSync(p) && !out.some((x) => x.path.toLowerCase() === p.toLowerCase())) {
      out.push({ path: p, host: 'test-root', label: '测试根修法脚本（把指向金丝雀/测试的链接改回全局 npm 主包依赖）' })
    }
  }
  const offsync = env.DSH_LINK_REPAIR_CLI ? path.resolve(env.DSH_LINK_REPAIR_CLI) : null
  if (existsSync(offsync)) out.push({ path: offsync, host: 'offsync', label: '盘外修法脚本（清理指向金丝雀闭包的链接）' })
  return out
}

/** 本体检（closure-check.mjs）路径 —— 与本库同在 <DSH>\tools 下，跨机同口径。 */
export function checkerPath() {
  return fileURLToPath(new URL('../closure-check.mjs', import.meta.url))
}

/** 处置段（多行，供 CLI / 启动哨兵打印；无污染返回空数组）。 */
export function formatRepairLines(scan, env = process.env) {
  if (!scan || !Array.isArray(scan.polluted) || scan.polluted.length === 0) return []
  const lines = ['处置（先只读确认，再执行）：']
  const cmds = repairCommands(env)
  if (cmds.length === 0) {
    lines.push('  · 未探测到本机修法脚本 → 按 docs 档案里的手工重建步骤处理（把污染链接改回全局 npm 主包自依赖）')
  }
  for (const c of cmds) {
    lines.push(`  · ${c.label}`)
    lines.push(`      node "${c.path}"            # DRY-RUN，先看计划`)
    lines.push(`      node "${c.path}" --apply    # 执行（自动留回滚清单）`)
  }
  lines.push(`  · 复核：node "${checkerPath()}"   # 期望退出码 0`)
  lines.push('  · 预防：测试/金丝雀 home 的 profiles\\node_modules 必须是【实体目录】，')
  lines.push('    不得是指向生产共享宿主 <offsync>\\profiles-node_modules 的 junction（启动闸已硬拦，见 closure-gate.mjs）')
  return lines
}
