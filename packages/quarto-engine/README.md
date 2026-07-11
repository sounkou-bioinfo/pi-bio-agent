# pi-bio Quarto Engine

This package is a trusted Quarto execution engine for explicitly marked
`*.pi-bio` cells. Node/TypeScript cells run in one Node process per document,
so async code and values can be used across cells. Explicit `r`, `python`, and
`bash`/`sh` cells are delegated to host processes at their document position.
`console` output is captured, and `piBio.json()` / `piBio.markdown()` provide
structured document output.

The engine is an adapter over the `pi-bio-agent` SDK and CLI. It does not own
DuckDB execution, manifests, SQL validation, compute, CAS, receipts, or the
observation ledger. A cell that does scientific work imports or invokes those
existing surfaces with the host capabilities supplied to the rendering
process.

The generated worker is placed beside the rendered document. Relative ESM
imports therefore resolve from the document's directory, while bare imports
walk the normal `node_modules` ancestry. Install `pi-bio-agent` in the
document's project when a document imports the SDK; the engine package does not
smuggle its own dependency tree into an unrelated document. The example works
because this repository is the document project.

## Execution And Provenance

This engine is a Quarto host extension, not a second `pi-bio-agent` runtime.
Quarto calls it to execute explicitly marked cells and replace those cells with
rendered output. `piBio.json()` and `piBio.markdown()` are presentation
helpers; they do not create CAS objects, receipts, runs, or ledger
observations by themselves.

Scientific work must call the existing SDK/CLI surfaces. A manifest query or
operation run then owns its normal DuckDB result, receipt, replay, CAS, and
observation behavior. The rendered document is a readable view of that work,
not the evidence store. A cell that only prints a number is not a scientific
record.

Marked cells execute in document order. TypeScript/JavaScript cells share one
Node process for the document, so top-level bindings can be used by later
TypeScript/JavaScript cells. Use top-level `await` when a later cell depends on
asynchronous work. R, Python, and shell cells run as separate synchronous host
processes and do not share in-process variables. A failed cell, failed
subprocess, or immediately unhandled rejection aborts the render before later
marked cells run. A delayed unhandled rejection still fails the render, but
may occur after later synchronous code has run; asynchronous work that affects
document order must be awaited.

## Permissions And Containerization

The engine has no built-in permission system. Node cells run with the
filesystem, process, network, and credential access of the process running
Quarto. Treat a `.qmd` document and every imported module as trusted code.

For stronger isolation, put the rendering process behind a host boundary:

- use a Gondolin-style host adapter when the renderer should stay on the host
  while code execution is routed into a local micro-VM;
- run the whole Quarto render in Docker for a simple local container boundary;
- use a policy-controlled OpenShell sandbox when filesystem, process, network,
  credentials, or inference access needs an explicit policy.

The engine does not pretend to replace those controls. The same rule applies
to Pi extensions: trusted extension code is not a sandbox.

## Development

Quarto 1.9 or newer and Node 22.6 or newer are required. TypeScript cells use
Node's built-in type stripping; the engine does not add a second TypeScript
compiler or module resolver.

```sh
npm run check --workspace=packages/quarto-engine
```

The real render fixture is [examples/basic.qmd](examples/basic.qmd). The
authored engine is `src/pi-bio.ts`; `_extensions/pi-bio/pi-bio.js` is the
tracked Quarto installation artifact generated from it. `npm run check` builds
the artifact, verifies that it is unchanged, and renders the fixture. Edit the
TypeScript source, then run `npm run build` before committing the generated
artifact.

Use cells like these:

```{ts .pi-bio}
const rows = await loadRows();
piBio.json({ count: rows.length });
```

```{r .pi-bio}
cat("R output is captured here")
```

```{bash .pi-bio}
printf 'shell output is captured here\\n'
```

The `.pi-bio` class makes engine selection explicit and avoids claiming every
`js`, `ts`, `r`, or shell block in a document that another Quarto engine may
own. Cross-runtime state is explicit through files, manifests, SDK calls, or
CAS artifacts; it is not hidden in a shared process variable.

The engine is selected by Quarto's package-level extension mechanism. That
mechanism discovers trusted rendering code; it is not a registry of scientific
resolvers or a replacement for manifests, SQL, or host-injected ports.

Process cells use the host executables `Rscript`, `python3`, and `bash`, with a
120-second timeout and an 8 MiB combined stdout/stderr limit. A missing
executable, timeout, non-zero exit, or oversized response fails the render.
