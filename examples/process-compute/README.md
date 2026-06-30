# Example: out-of-process compute (R `lm` over Arrow IPC) — the COMPUTE pillar

The compute pillar as a manifest: a DuckDB table is handed to an **out-of-process** computation (here R) over
**Arrow IPC**, and the result is handed back as a table — under the same resolver / receipt / fail-closed model
as every other resource. This is the COMPUTE half of the two-pillar bet (the NETWORK half is `ducknng_ncurl` /
the chunked VEP fanout); together they are what makes the coloc flagship (colocalization in R) expressible.

```
points (file_scan)  --SELECT x,y-->  Arrow IPC file  -->  Rscript ./compute.R <in> <out>  -->  Arrow IPC file  -->  lm_fit table
                       DuckDB COPY (FORMAT arrow)            in/out paths = the last two argv       read_arrow()
```

## The skill is data, not code

```json
{ "id": "lm_fit", "resolver": "process.compute",
  "params": { "table": "lm_fit", "inputSql": "SELECT x, y FROM points",
              "command": ["Rscript", "./compute.R"], "timeoutMs": 60000 } }
```

The `process.compute` resolver does the marshalling — `COPY (inputSql) TO in.arrow (FORMAT arrow)`, run the
command with the **in/out Arrow paths appended as the last two argv entries** (not env vars — argv is explicit
and never inherited down a process tree), `read_arrow(out.arrow)` back into `table` — so the **data contract
stays in SQL + Arrow**. The script is the only domain code, and it is a tiny, language-agnostic contract: *read
the input path, write the output path (the last two args)*. The same generic resolver runs any R / Python / Go /
shell tool — point a new manifest at a new `command`, **zero new TypeScript**. The `command` is an **argv array,
never a shell string** (no shell to inject into), and a `./script` reference is resolved relative to the manifest.

`compute.R` fits an ordinary-least-squares regression (`lm`) — a thing SQL is poor at — and returns the
coefficients + R²:

```r
args <- commandArgs(trailingOnly = TRUE)          # the last two args are <in.arrow> <out.arrow>
df  <- as.data.frame(read_nanoarrow(args[length(args) - 1]))
out <- tryCatch(                                  # errors-as-values: a degenerate fit -> status="error", not a crash
  { fit <- lm(y ~ x, data = df)
    data.frame(n = nrow(df), slope = coef(fit)["x"], intercept = coef(fit)["(Intercept)"],
               r_squared = summary(fit)$r.squared, status = "ok") },
  error = function(e) data.frame(n = nrow(df), slope = NA, intercept = NA, r_squared = NA,
                                 status = paste0("error: ", conditionMessage(e))))
write_nanoarrow(out, args[length(args)])
```

## Why out-of-process (not FFI)

A computation that crashes, OOMs, or hangs is contained in the **child** — it cannot take down the agent. The
runner kills the child on `timeoutMs` or on the run's `AbortSignal`. The exchange is typed columnar Arrow IPC
(via the `nanoarrow` DuckDB extension on the DuckDB side, the lightweight `nanoarrow` package on the R side —
DuckDB writes the Arrow IPC **stream** format, so R uses `read_nanoarrow`/`write_nanoarrow`), not text parsing.

## Running it — compute is the host's opt-in

Spawning a process is a **capability the host grants by composition**, exactly like network: the host injects a
`ProcessRunner` (`nodeProcessRunner()`), and without it the `process.compute` resource **fails closed** (the
agent can never spawn a process on its own). The host also provisions the Arrow codec (`INSTALL nanoarrow FROM
community`). A non-zero exit, a timeout, or a clean exit that wrote **no** output file all throw — the run
records the failure, never a silent empty table.

**Scope (do not over-trust it):** binding a `ProcessRunner` grants the agent's manifests the ability to run the
commands they declare. It is *not* a sandbox — enforce real isolation (a restricted user, a container,
seccomp, resource limits) at the **host** boundary, and only inject a runner for manifests you trust to name
safe commands.

`test/process-compute-example.test.ts` runs this manifest end to end through the host with a **real spawned
Rscript** (no mock) and asserts the fitted slope ≈ 2, intercept ≈ 1, R² > 0.99 over `data/points.csv` (which is
≈ `y = 2x + 1`), plus the fail-closed-without-a-runner path.
