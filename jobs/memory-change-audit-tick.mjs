#!/usr/bin/env node
/**
 * memory-change-audit-tick.mjs —— tickd 薄包装：每天跑一次记忆留痕体检（**只读**）
 *
 * 为什么要有它（方案 §12.5 / §13.2⑤ 的硬要求）：
 *   假撤回（台账说删了、条目还在）的发现机制 **没有定时器** —— 不挂 job 就只剩"人想起来跑"这一种，
 *   而"体检没跑"正是这条链**唯一**的静默失效态（§13.2⑤ 已认）。所以第 4 期 B+ 把它挂成 tickd job。
 *
 * 只做三件事：① 调 `tools\memory-db-tools\memory-change-audit.mjs --all` ② 原样透传 stdout/stderr
 * ③ 原样透传退出码（0 全绿 / 3 有红项 —— **红项算 failure，就是要被日报的 job 段看见**）。
 *
 * 关掉：`node <pkg>\jobs\butler-autonomy-cli.mjs job off memory-change-audit --reason "…"`
 *      （只改开关不改代码；`defaultWhenUnset:'off'` ⇒ 换机/对端默认不跑）
 */
import { spawnSync } from "node:child_process";
import { workspaceRoot } from './lib/ws-root.mjs';
import path from "node:path";
import fs from "node:fs";

const DSH = process.env.DSH_ROOT && process.env.DSH_ROOT.trim().length > 0 ? process.env.DSH_ROOT.trim() : workspaceRoot();
// 被体检的脚本本体属于宿主自建的工具集（本包不带）⇒ 允许用环境变量直接指过去。
const AUDIT = process.env.DSH_MEMORY_AUDIT_SCRIPT
  ? path.resolve(process.env.DSH_MEMORY_AUDIT_SCRIPT)
  : path.join(DSH, "tools", "memory-db-tools", "memory-change-audit.mjs");
/** 老 26 行的基线（C1 判据；2026-11-05 开工现钉，老账不得再变）。 */
const LEGACY_SHA16 = "9556CB9BD7D12654";

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('memory-change-audit-tick.mjs —— 记忆留痕体检的 tickd 薄包装（只读）');
  console.log('');
  console.log('用法：');
  console.log('  node memory-change-audit-tick.mjs        # 跑一轮体检，原样透传退出码');
  console.log('  node memory-change-audit-tick.mjs --help # 就本页');
  console.log('');
  console.log(`被调脚本：${AUDIT}`);
  console.log('  · 可用环境变量 DSH_MEMORY_AUDIT_SCRIPT 指向你自己的那份');
  console.log('  · 默认 = <数据区根>/tools/memory-db-tools/memory-change-audit.mjs（本包不附带）');
  console.log('退出码：0 全绿 / 3 有红项（红项算 failure，就是要被日报的 job 段看见）/ 4 被调脚本不在位（让路）');
  process.exit(0);
}

if (!fs.existsSync(AUDIT)) {
  // 容错口径：被调脚本属于宿主自建工具集，不在位 = "没装这件东西"，不是本 job 坏了。
  //   ⚠️ **不能复用 rc=3**：3 在本 job 里是"有红项"的**失败**语义，混用会把红项降格成让路。
  //   ⇒ 单独用 4，并在 JOBS 里声明 benignExitCodes:[4]（见 butler-tickd.mjs）。
  console.error(`[memory-change-audit] 被调脚本不在位：${AUDIT}`);
  console.error('[memory-change-audit] 用 DSH_MEMORY_AUDIT_SCRIPT 指向你自己的那份；本轮记让路。');
  process.exit(4);
}

console.log(`[memory-change-audit] ${new Date().toISOString()} 起跑 · ${AUDIT}`);
const r = spawnSync(process.execPath, [AUDIT, "--all", "--expect-legacy-sha16", LEGACY_SHA16], {
	encoding: "utf8",
	timeout: 120_000,
	windowsHide: true
});
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
const code = typeof r.status === "number" ? r.status : 1;
if (r.error) console.error(`[memory-change-audit] 调用失败：${r.error.message}`);
console.log(`[memory-change-audit] 退出码 ${code}（0 全绿 / 3 有红项 ⇒ 人工处置见上，**不许往台账补行**）`);
process.exit(code);
