#!/usr/bin/env Rscript
# The COMPUTE-pillar contract: read the input table from the INPUT Arrow path, compute, write the result to the
# OUTPUT Arrow path. The two paths are the LAST TWO command-line ARGUMENTS (argv, not env vars). Out-of-process —
# DuckDB handed us a typed columnar table, we hand one back. Arrow IPC via nanoarrow (the LIGHTWEIGHT codec, same
# one the DuckDB `nanoarrow` extension uses — not the heavy `arrow` package). This does a thing SQL is poor at:
# fit an ordinary least-squares regression (lm) and return its coefficients + R^2.
suppressMessages(library(nanoarrow))

args <- commandArgs(trailingOnly = TRUE)            # the LAST TWO args are <in.arrow> <out.arrow>
in_path <- args[length(args) - 1]; out_path <- args[length(args)]
# CATASTROPHIC failure (can't read the input) is a crash -> non-zero exit -> the resolver fails the run closed.
df <- tryCatch(as.data.frame(read_nanoarrow(in_path)),
               error = function(e) stop(paste("compute.R: cannot read input Arrow table:", conditionMessage(e))))
# The COMPUTE failure itself is a VALUE: a degenerate fit returns a row with status="error: <msg>" + NA coefs,
# never a crash, so the agent branches in SQL (`WHERE status='ok'`).
out <- tryCatch({
  fit <- lm(y ~ x, data = df)
  data.frame(n = nrow(df), slope = unname(coef(fit)["x"]), intercept = unname(coef(fit)["(Intercept)"]),
             r_squared = summary(fit)$r.squared, status = "ok")
}, error = function(e) data.frame(n = nrow(df), slope = NA_real_, intercept = NA_real_, r_squared = NA_real_,
                                  status = paste0("error: ", conditionMessage(e))))
write_nanoarrow(out, out_path)
