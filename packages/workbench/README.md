# pi-bio-workbench

`pi-bio-workbench` is the first-party application package over `pi-bio-agent`. It is where domain relations, review
policy, evidence packets, APIs, and future UI surfaces are composed. The root package remains the policy-free
execution and evidence substrate.

The workbench includes [clinical genomics](examples/clinical-genomics/application.md) and the generic
[method-selection application](examples/method-selection/application.md). Their executable QMD files are the
application narratives and proofs; rendered Markdown is committed for ordinary readers.

## Package boundary

The workbench imports the public `pi-bio-agent` package. It does not import root `src/` internals or maintain a
second runner, ledger, CAS, graph, retry system, or workflow engine.

| Root substrate | Workbench application |
|---|---|
| manifests, resolvers, SQL validation | domain manifests and relations |
| query and operation runners | task composition and host policy |
| async compute and durable checkpoints | clinical step definitions |
| CAS, receipts, replay, observations | evidence packet and review queue |
| graph projection and foreign sources | phenotype and case-evidence semantics |
| public SDK and host ports | CLI, API, and future UI surfaces |

Applications are also the main abstraction pressure surface. A workbench workaround does not become a core feature
by convenience. The same motion must appear in another application or generic pattern, conflict with no stronger
existing primitive, and admit a smaller policy-free contract. The promoted primitive then returns through the public
package surface and the workbench workaround is deleted.

## Clinical application

The application has two traversal orders over the same declared case evidence:

- direct assessment starts from observed variants;
- inverted assessment starts from a case narrative, reviewed HPO assertions, Monarch disease/gene hypotheses,
  assembly-pinned intervals, indexed VCF reads, and bounded VEP annotation.

Both lanes close into `case_evidence`. Coverage states distinguish an unsearched hypothesis from completed search
with no supporting variant. Missing population frequency remains an abstention. The complete relations stay in the
analysis DuckDB; the review-bearing packet and checkpoints use CAS references.

This is evidence routing. It does not claim ACMG/AMP classification, diagnosis, or clinical validity.

## Run

```sh
npm install
npm run provision:ducknng --workspace=packages/workbench
npm run provision:duckhts --workspace=packages/workbench
npm run check:workbench
npm run application:clinical
npm run application:method-selection
```

The application QMD runs a hermetic local VEP-compatible endpoint, verifies transient retry, executes all eight
steps, resumes the same analysis from checkpoints, and renders a collapsed evidence summary.

The method-selection QMD studies a refreshable action relation, discovers the method with SQL under host constraints,
authors a manifest operation, runs it, validates and approves the candidate, writes the approved skill revision into the
same ledger, and walks the resulting graph. DuckDB remains the stateful work surface; external catalogs and optional
NNG/embedded kernels are application inputs. The path is deliberately model-light and can be driven by a skill-only
CLI host or a weaker agent: schema inspection and bounded SQL carry the scientific state instead of prompt context.

Run the package CLI directly when an application document is not needed:

```sh
npm run build:all
node packages/workbench/dist/cli.js run \
  packages/workbench/examples/clinical-genomics \
  CASE-RD-001 \
  analysis-demo
```

The default CLI composition uses recorded grounding and local graph/VCF fixtures but the configured VEP endpoint.
Embedded hosts inject model or human grounding ports, graph attachment, VCF identity, VEP endpoint/profile, network
admission, credentials, and extension provisioning.

## Live foreign graph

The same hypothesis operation can query Monarch's versioned DuckDB snapshot:

```sh
npm run pattern:monarch --workspace=packages/workbench
```

The host attaches the snapshot read-only. The manifest queries canonical `edges`, `nodes`, and `closure` tables; no
Monarch-specific resolver or denormalized graph copy is required. The output is a ranked hypothesis relation for
targeted search and review, not a diagnosis.

## API

```sh
npm run serve --workspace=packages/workbench -- \
  packages/workbench/examples/clinical-genomics \
  8787
```

Zod route schemas validate requests and generate OpenAPI 3.1. The server fixes its workspace at startup; callers do
not submit host paths, and host store paths are not part of the HTTP response contract.

## Checks

```sh
npm run check:workbench
npm run application:clinical
npm run benchmark:grounding --workspace=packages/workbench
```

The grounding benchmark tests retrieval-contract behavior with recorded proposals and reviews. It is not a
model-quality claim.
