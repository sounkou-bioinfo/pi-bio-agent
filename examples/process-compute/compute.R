#!/usr/bin/env Rscript
# The COMPUTE-pillar contract: read the input table from PI_ARROW_IN (Arrow IPC), compute, write the result to
# PI_ARROW_OUT (Arrow IPC). Out-of-process — DuckDB handed us a typed columnar table, we hand one back. This does
# a thing SQL is poor at: fit an ordinary least-squares regression (lm) and return its coefficients + R^2.
suppressMessages(library(arrow))

df <- as.data.frame(read_ipc_stream(Sys.getenv("PI_ARROW_IN")))
fit <- lm(y ~ x, data = df)
out <- data.frame(
  n = nrow(df),
  slope = unname(coef(fit)["x"]),
  intercept = unname(coef(fit)["(Intercept)"]),
  r_squared = summary(fit)$r.squared
)
write_ipc_stream(out, Sys.getenv("PI_ARROW_OUT"))
