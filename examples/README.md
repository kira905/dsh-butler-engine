# 接一个自己的作业（最小例子）

三步：一个脚本、一行调度表、一次放行。

## ① 脚本

`examples/my-job.mjs` 就是一个普通 node 脚本：打印一行就退出。约定：退出码 0 = 成功，
3 = "本轮无事可做"（良性，不算失败），其它 = 失败（会进失败留痕）。

## ② 调度表里加一行

编辑 `src/dsh-butler/butler-tickd.mjs` 的 `JOBS`：

```js
{ id: 'my-job', label: '我的作业', intervalMs: 10 * 60_000, initialMs: 30_000,
  script: path.resolve('examples/my-job.mjs'), args: [], dir: HERE,
  benignExitCodes: [3] },
```

- `intervalMs` / `at:'HH:MM'` / `at:'MON HH:MM'` / `window:{from,to}` 四选一决定什么时候跑。
- `dir` 是子进程的工作目录；`script` 是相对 `dir` 的文件名或绝对路径。

## ③ 放行它（写配置，不写代码）

在 `<数据根>\butler-autonomy.json` 里加：

```json
{ "schemaVersion": 1, "jobs": { "my-job": { "enabled": true, "by": "me", "why": "第一次接线" } } }
```

然后 `butler-tickd --list` 确认那一行变成 🟢，`butler-tickd --once my-job` 跑一次看看。

> 别忘了在 `src/dsh-butler/lib/butler-locks.mjs` 的锁注册表里给它登记一把锁——
> 否则它就是一个不受单实例保护的触发器（同机两处触发会同时跑）。
