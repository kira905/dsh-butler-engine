// 测试总入口（npm test）：目前就是冒烟一组，串行跑、任一失败即非 0 退出。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const suites = ['smoke.mjs', 'notify-seam.mjs', 'handoff-core.mjs'];
let failed = 0;
for (const s of suites) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [path.join(HERE, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} 组失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
