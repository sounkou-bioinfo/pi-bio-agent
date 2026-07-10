# pi-bio-workbench

`pi-bio-workbench` is an API-first scientific workbench built on `pi-bio-agent`. Applications own domain
resources, evidence relations, review policy, reports, and user-facing contracts. The substrate owns manifests,
DuckDB execution, durable checkpoints, receipts, replay, CAS, and the observation graph.

The first binding is clinical genomics. It exercises two rare-disease traversal directions over the same declared
case data:

- **Direct:** assess observed variants, retaining candidates, abstentions, and evidence conflicts.
- **Inverted:** start from observed HPO terms, derive gene/disease hypotheses, and inspect all case variants in each
  supported gene without collapsing them to one arbitrary row.

Both lanes close into the `case_evidence` relation. Reanalysis compares the shared `variant_assessment` relation
with prior state. The evidence packet contains review-bearing rows rather than every routine exclusion; the complete
relations remain available to SQL in the per-analysis DuckDB file. The SDK and CLI return that host path for local
inspection; the HTTP contract does not expose it.

This is evidence routing, not a complete clinical classification kernel. It does not claim ACMG/AMP classification,
causal diagnosis, or clinical validity beyond the declared fixture data.

## Run the binding

```sh
npm install
npm run check
npm run demo:clinical
```

One analysis executes two recorded scientific operations and a packet step. Reusing its analysis id resumes from
the durable step checkpoints:

```sh
node dist/cli.js run examples/clinical-genomics CASE-RD-001 analysis-demo
node dist/cli.js run examples/clinical-genomics CASE-RD-001 analysis-demo
```

The second invocation reports zero executed steps and three reused steps. Scientific result, receipt, replay, and
run-object bytes live in CAS; checkpoints carry only their references. Reusing an analysis id after a declared input
file changes fails closed because the task replay digest pins those input bytes.

## Run the API

```sh
npm run serve -- examples/clinical-genomics 8787
```

```sh
curl -sS http://localhost:8787/v1/clinical-analyses \
  -H 'content-type: application/json' \
  -d '{"caseId":"CASE-RD-001"}'
```

The same Zod route schemas validate requests and generate the OpenAPI 3.1 document at
`http://localhost:8787/openapi.json`. The server fixes the clinical workspace at startup; clients cannot submit a
host path in the request, and host store paths are not part of the response contract.

The app depends on the sibling substrate through `"pi-bio-agent": "file:../pi-bio-agent"`. It consumes substrate
APIs directly and does not vendor or reimplement them.
