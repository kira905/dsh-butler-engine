#!/usr/bin/env node
// 命令行入口（npm bin）。真正的引擎在 src/dsh-butler/butler-tickd.mjs；
// 这里只负责"由本文件启动时也跑 main"，让 node bin/butler-tickd.mjs 与 node src/... 行为一致。
import { runMain } from '../src/dsh-butler/butler-tickd.mjs';

const code = await runMain();
process.exit(typeof code === 'number' ? code : 0);
