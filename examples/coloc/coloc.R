#!/usr/bin/env Rscript
# Read the harmonized multi-tissue locus bundle from the input Arrow
# path (Arrow IPC), run colocalization (coloc.abf — Giambartolomei 2014) PER TISSUE, write the posteriors
# PP.H0..PP.H4 per tissue to the OUTPUT Arrow path. The in/out paths are the LAST TWO command-line ARGUMENTS
# (argv, not env vars). This is a thing SQL is poor at (per-SNP approximate Bayes
# factors + the H0-H4 posterior combination), so it runs OUT-OF-PROCESS in R; the DATA contract stays SQL/Arrow.
# Per-tissue grouping IS the partition+map fan-out. Uses the real `coloc` package when present, else a faithful
# inline implementation of the SAME algorithm (Wakefield ABF) so the example is portable.
# Arrow IPC via nanoarrow (the LIGHTWEIGHT reader/writer — same codec the DuckDB `nanoarrow` extension uses for
# COPY ... TO / read_arrow — not the heavy `arrow` package).
#
# ERROR MODEL (errors as values, not a happy-path crash): a PER-TISSUE failure (coloc errors on one group) is a
# VALUE — that tissue's row carries status="error: <msg>" and NA posteriors, so the agent branches in SQL
# (`WHERE status='ok'`); the job still succeeds for the other tissues. Only a CATASTROPHIC failure (can't read
# the input, can't write the output) is a crash → non-zero exit → the resolver fails the run closed WITH a
# receipt. Reading the input is wrapped so a malformed bundle is a clean crash, not a partial write.
suppressMessages(library(nanoarrow))

args <- commandArgs(trailingOnly = TRUE)            # the LAST TWO args are <in.arrow> <out.arrow>
in_path <- args[length(args) - 1]; out_path <- args[length(args)]
df <- tryCatch(as.data.frame(read_nanoarrow(in_path)),
               error = function(e) stop(paste("coloc.R: cannot read input Arrow bundle:", conditionMessage(e))))
have_coloc <- requireNamespace("coloc", quietly = TRUE)

# faithful inline coloc.abf: per-SNP Wakefield log-ABF + the standard H0-H4 posterior combination.
labf <- function(beta, vb, W = 0.15^2) { z <- beta / sqrt(vb); r <- W / (W + vb); 0.5 * (log(1 - r) + r * z * z) }
logsum <- function(x) { m <- max(x); m + log(sum(exp(x - m))) }
ldiff <- function(a, b) { a + log1p(-exp(b - a)) }              # log(exp(a) - exp(b)), a > b

pp_for <- function(d) {
  if (have_coloc) {
    d1 <- list(beta = d$beta_gwas, varbeta = d$varbeta_gwas, snp = d$snp, type = "quant", sdY = 1)
    d2 <- list(beta = d$beta_eqtl, varbeta = d$varbeta_eqtl, snp = d$snp, type = "quant", sdY = 1)
    s <- suppressMessages(coloc::coloc.abf(d1, d2))$summary
    return(c(s[["PP.H0.abf"]], s[["PP.H1.abf"]], s[["PP.H2.abf"]], s[["PP.H3.abf"]], s[["PP.H4.abf"]]))
  }
  l1 <- labf(d$beta_gwas, d$varbeta_gwas); l2 <- labf(d$beta_eqtl, d$varbeta_eqtl)
  p1 <- 1e-4; p2 <- 1e-4; p12 <- 1e-5
  lH0 <- 0; lH1 <- log(p1) + logsum(l1); lH2 <- log(p2) + logsum(l2)
  lH3 <- log(p1) + log(p2) + ldiff(logsum(l1) + logsum(l2), logsum(l1 + l2))
  lH4 <- log(p12) + logsum(l1 + l2)
  lse <- logsum(c(lH0, lH1, lH2, lH3, lH4))
  exp(c(lH0, lH1, lH2, lH3, lH4) - lse)
}

engine <- if (have_coloc) "coloc::coloc.abf" else "inline-abf"
hyp <- c("PP.H0", "PP.H1", "PP.H2", "PP.H3", "PP.H4")
row_for <- function(tissue, posterior, nsnps, status) {
  data.frame(tissue = tissue, hypothesis = hyp, posterior = posterior, nsnps = nsnps, status = status, engine = engine)
}
groups <- split(df, df$tissue)
parts <- if (length(groups) == 0) {
  list(row_for(NA_character_, NA_real_, 0L, "error: empty input (no harmonized SNPs)")) # an analytical null, as a VALUE
} else lapply(groups, function(d) {
  # per-tissue error-as-value: a failed coloc on one tissue does NOT crash the whole job
  tryCatch(row_for(d$tissue[1], pp_for(d), nrow(d), "ok"),
           error = function(e) row_for(d$tissue[1], NA_real_, nrow(d), paste0("error: ", conditionMessage(e))))
})
write_nanoarrow(do.call(rbind, parts), out_path)
