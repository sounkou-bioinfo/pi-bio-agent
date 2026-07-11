

# NNG pair topology — proposer↔verifier duo (evidence)

`scripts/nng-pair.mjs` is a **pattern** — the **pair** NNG topology (1:1
bidirectional) as a reusable *proposer↔verifier* **generic** pattern.
Two **separate OS processes** each hold a pair socket over ipc; the
proposer offers a variant pathogenicity call and the verifier (an
adversarial ACMG-ish critic) refutes-or-accepts in a tight
back-and-forth until they converge. This is the 1:1 debate channel —
distinct from survey’s fan-out and blackboard’s broadcast.

It runs over ducknng’s SQL socket layer — `open_socket('pair')` →
`listen`/`dial_socket` → `send_socket_raw` / `recv_socket_raw_aio` +
`aio_collect` — the same convention as ducknng’s own
`ducknng_socket_protocols.test`.

Run: `npm run pattern:nng-pair`

## Recorded run (2026-07-02)

    === NNG pair topology: a proposer↔verifier duo converges 1:1 (two SEPARATE processes) ===
      [verifier pid 602449] pair socket listening
      [proposer pid 602516] round 1: proposing call=pathogenic conf=0.9
      [verifier] round 1: proposal call=pathogenic evidence=[PVS1] -> REFINE (one criterion can't reach pathogenic — add a second (e.g. PM2 rarity))
      [proposer pid 602516] round 2: proposing call=likely_pathogenic conf=0.7
      [verifier] round 2: proposal call=likely_pathogenic evidence=[PVS1,PM2] -> ACCEPT (PVS1 (LoF) + PM2 (rare) supports likely_pathogenic)
      [proposer] verifier ACCEPTED 'likely_pathogenic' — converged in 2 round(s)
    PROVED: a 1:1 pair channel carried an adversarial propose→refute→refine loop to convergence

The verdict rule is a deterministic stand-in for the semantic judgment a
critic sub-agent (or a second model provider) would make — so the demo
is reproducible. One of the family of topology demos alongside
`pipeline-fanout` (push/pull), `blackboard-shared` (pub/sub), and
`nng-job-runner` (req/rep worker). All NNG protocols are reachable the
same way (verified: a bus round-trip probes clean); each is a thin use
of the one socket convention, not a new abstraction.
