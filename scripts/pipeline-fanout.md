

# Pipeline (push/pull) topology — evidence

`scripts/pipeline-fanout.mjs` is a **dogfood** of the **pipeline** (nng
push/pull) topology — a **bounded work pool**.
`runPipeline(tasks, worker, concurrency)` runs at most `concurrency`
lanes pulling from a shared cursor, so N tasks drain through a fixed
pool and results come back **in task order** even though they complete
out of order. This is exactly the shape of chunked, rate-limited
annotation: split a whole VCF into batches and push them through a pool
of ≤ K in-flight requests — the role `src/duckdb/ncurl-fanout.ts` plays
for the per-round `ncurl_aio` fanout. Here each “request” is a
deterministic local variant-chunk classification (same rare/high-
impact + abstention rule as the SQL operation, in JS), so the run is
network-free and the concurrency **cap is checked, not asserted**.

Run: `npm run build && node scripts/pipeline-fanout.mjs`

## Recorded run (2026-06-30, timings representative)

    === PIPELINE (push/pull) topology: 9 chunks through a pool of 3 lanes ===

    per-chunk results (returned IN TASK ORDER, regardless of completion order):
      chunk-0   included=0  abstained=2
      chunk-1   included=0  abstained=1
      chunk-2   included=1  abstained=1
      ...
      chunk-8   included=0  abstained=2

    totals: included=2  abstained=12  (across 9 chunks)
    max lanes ever in flight: 3  (cap = 3)
    completion order (work-stealing, NOT task order): chunk-2, chunk-1, chunk-0, chunk-3, chunk-5, chunk-4, chunk-8, chunk-7, chunk-6
    wall time: ~124ms  (serial would be ~225ms; the pool overlaps them)

    cap-respected invariant: HELD; results-in-task-order: HELD

**What it proves:** 9 tasks drained through exactly 3 lanes —
`max lanes ever in flight` never exceeded the cap — faster than serial
(the lanes overlap the per-chunk latency), and the completion order
(`chunk-2, chunk-1, chunk-0, …`) is genuinely scrambled by work-stealing
while `runPipeline` still reassembles results **in task order**. That is
the push/pull work-pool a rate-limited whole-VCF annotation fanout
needs: bound K in-flight requests, let fast chunks pull the next,
`UNION` the results in order. The same abstention discipline as the
classification operation rides along (12 unknown-frequency variants
abstained, only 2 defensibly `included`), showing the topology is
orthogonal to the per-task logic — a scaffold choice, not an executor
change.
