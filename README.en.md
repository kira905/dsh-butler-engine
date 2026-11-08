# dsh-butler-engine · a resident tick scheduler for agent ops

> **What it is** — The scheduling half of a long-running agent ops loop, on its own: a resident
> scheduler (interval / daily / weekly / time-window jobs), single-instance locks per job, an autonomy
> switch matrix (who may act on their own, with `by` / `why` on every change) and a hash-chained audit log.
> Zero runtime dependencies.
>
> **What it is not** — It ships **no alerting channels** of its own: 0.2.0 adds a **notifier injection
> point** instead (see below). And although 0.4.0 bundles a set of job scripts, **every job stays off**
> until you explicitly enable it.

## 0.4.0 — `jobs/` (optional add-on)

Up to 0.3.x the job table listed 77 jobs while the package carried only 3 scripts — a fresh install
showed a full schedule with nothing runnable behind it. 0.4.0 bundles **30 scripts covering 41 jobs**
(full list and per-script environment variables in [`jobs/README.md`](jobs/README.md)).

**Still off by default** — a script being present only means "runnable", not "running".

Entry resolution, first hit wins:

| # | Source |
|---|---|
| ① | `<package>/jobs/` (bundled) |
| ② | env `BUTLER_JOBS_DIR` (your own script directory, absolute path) |
| ③ | `job.dir` (scripts the core carries) |
| ④ | none ⇒ `skipped-missing-src`: **not red**, no `failures`, no lock, no spawn |

`butler-tickd --list` marks each job `[jobs]` / `[host-dir]` / `[pkg-dir]` / `[missing-src]`.

**Two scripts are deliberately excluded**: `secretary-morning.mjs` (the morning-report chain needs data
collection *and* an external push channel — this package ships no channel implementation) and
`family-vectors-tick.mjs` (it moves family members' private memory data). The remaining 33 jobs belong to
"your own tree / upstream watch / channels / life side" and are not guessed on your behalf.

`jobs/` is an **optional add-on**: deleting the whole directory only turns those 41 jobs into
"script missing"; no core component is affected.

## 0.2.0 — report & patrol toolkit

Six read-first commands: `butler-steward` (daily report), `butler-steward-threads` (thread data plane),
`butler-steward-advice` (four-part advice), `butler-failure-classify` (five failure classes + drafts),
`butler-progress-status` (progress table), `butler-stall-nudge` (stalled-mainline nudges).
All default to read-only / dry-run.

### Notifier injection point

```js
import { notify, setNotifier } from '@kira905/dsh-butler-engine/notify';
setNotifier(async ({ level, title, body, dedupeKey }) => {
  await myChannel.send({ level, title, body });
  return { ok: true, msgid: 'x' };        // ok:true ⇒ delivered; false ⇒ caller treats it as retryable
});
await notify({ level: 'warn', title: 'job failed', body: '…', dedupeKey: 'job-1' });
```

With nothing injected it prints one line to stderr and returns `{ ok:false, error:'no-channel' }` —
visible, but never pretending it was delivered. The channel gate is **off by default**
(`<data root>/butler-alert.json#channels.alert`), and the same `dedupeKey` fires at most once per local day.

```powershell
npm i -g @kira905/dsh-butler-engine
butler-tickd --list      # read-only: the job table, with 🔴/🟢 per job
butler-tickd --status    # read-only: heartbeat + last result per job
butler-tickd             # resident loop (foreground); --ensure starts it in the background
```

Wiring your own job: add one entry to `JOBS` in `src/dsh-butler/butler-tickd.mjs`, then enable it in
`<data root>/butler-autonomy.json`:

```json
{ "schemaVersion": 1, "jobs": { "my-job": { "enabled": true, "by": "me", "why": "first wiring" } } }
```

State defaults to `%TEMP%\dsh-butler-tickd` (override with `DSH_TICKD_DIR`); config and audit live in
`~/.dsh` (override with `BUTLER_DSH_HOME`). Two instances on one machine must not share a state dir.

See [README.md](./README.md) (Chinese) for the full walkthrough, the state-file table and the known
limitations. License: AGPL-3.0-only.
