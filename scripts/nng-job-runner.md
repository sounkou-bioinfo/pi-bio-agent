# JobRunner NNG compute profile (dogfood)

`node scripts/nng-job-runner.mjs` — the native, language-agnostic distributed-compute backend for the L1
`JobRunner`, over ducknng RPC (the alternative to an SSH-SLURM / Modal backend).

A **separate worker process** executes a job and reports each phase (`running` → `succeeded`) by running a
`recordObservation`-shaped `INSERT` over `ducknng_run_rpc` against the coordinator's shared DuckDB. The
coordinator reads the job's status straight out of the **same `job:<runId>:status` slot** with the unchanged L1
`observationAsOfKey`. The job-store code does not change — only dispatch + the worker are new, and the worker is
**any language that speaks NNG**: node here, R via `nanonext`/`mirai`, Python via `pynng`.

Why it matters: a long-running bio job (a whole-VCF VEP annotation, an alignment, a cohort regression) can run on
a worker pool over NNG push/pull, and its status flows back into the temporal ledger as SQL — the same substrate
Phase 4 governance and C2 reproduceRun() use. Compute distribution is a topology (`push`/`pull`), not a new system.
