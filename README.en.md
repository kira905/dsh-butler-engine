# dsh-butler-engine · a resident tick scheduler for agent ops

> **What it is** — The scheduling half of a long-running agent ops loop, on its own: a resident
> scheduler (interval / daily / weekly / time-window jobs), single-instance locks per job, an autonomy
> switch matrix (who may act on their own, with `by` / `why` on every change) and a hash-chained audit log.
> Zero runtime dependencies.
>
> **What it is not** — It ships **no job scripts**. All 78 jobs in the table stay **off** until you
> explicitly enable one (otherwise a fresh install would spawn dozens of missing-script failures within
> minutes). No reports, no dashboard, and **no alerting channels** (those are deliberately not part of
> this release).

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
