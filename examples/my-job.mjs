// 最小作业样例：被调度器 spawn 时，工作目录 = 调度表里那一行的 dir。
// 退出码约定：0 成功 / 3 本轮无事可做（良性）/ 其它失败。
const now = new Date().toISOString();
console.log(`[my-job] hello @ ${now}`);
process.exitCode = 0;
