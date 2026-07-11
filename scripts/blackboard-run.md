

# Blackboard (pub/sub) topology — evidence

`scripts/blackboard-run.mjs` is a **dogfood** of the **blackboard** (nng
pub/sub) topology — **decentralized, no coordinator**.
`runScaffoldOnBlackboard` launches *every* step at the same time
(`Promise.all` over all steps); a step that names upstream notes in its
access list **blocks on `awaitNote(slug)`** until those are published,
then runs and publishes its own (publish = post to the board, await =
subscribe). So the execution order is **not computed by a scheduler — it
emerges from the data dependencies**. Same `StudyWorker` contract as the
chain (`live-multi-agent`) and survey (`live-debate`) dogfoods; only the
topology differs. It is deterministic (canned workers, no LLM) so the
emergence is reproducible.

The DAG is a diamond: `extract -> {annotate, qc} -> classify`.
`annotate` and `qc` are independent (either order); `classify` waits for
**both**. No code anywhere computes that order — it falls out of the
access lists.

Run: `npm run build && node scripts/blackboard-run.mjs`

## Recorded run (2026-06-30)

    === BLACKBOARD (pub/sub) topology: all steps launched at once; order EMERGES from data deps ===

    publish order (as it happened on the board):
      +022ms  extract publishes
      +047ms  qc publishes <- [extract]
      +063ms  annotate publishes <- [extract]
      +073ms  classify publishes <- [annotate, qc]

    final notes (by id):
      extract    body=extract(root)
      annotate   body=annotate(extract)
      qc         body=qc(extract)
      classify   body=classify(annotate+qc)

    emergent-order invariant (extract first, classify last, no scheduler): HELD

**What it proves:** all four steps were launched simultaneously, yet
`extract` published first (both `annotate` and `qc` blocked on it), and
`classify` published **last** because it blocked on *both* `annotate`
and `qc` — with nothing computing a topological order. `qc` (a shorter
beat) published before `annotate` even though both depend only on
`extract`, showing the two truly ran concurrently and the board, not a
scheduler, sequenced them. This is stigmergic coordination: the order is
a *consequence* of the access lists (publish/subscribe over shared
memory). This is a deterministic coordination mechanism that a
multi-agent host may use; it is not Fugu’s learned orchestrator or
function-call memory. The deterministic mechanics also back the
chain/survey dogfoods — same executor, different scaffold.

> Shared-**write** variant: this demo’s board is in-process
> (`memoryBlackboard`). The same `Blackboard` interface backs a SQL
> board (`src/hosts/sql-blackboard.ts`, publish = `INSERT`, await = poll
> `SELECT`), which over **ducknng RPC** (see `blackboard-shared.md`)
> makes the board itself a cross-process shared write — the
> decentralized topology and shared writes composed.
