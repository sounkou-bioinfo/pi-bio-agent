#!/usr/bin/env Rscript
# The COMPUTE pillar of the coloc flagship: read the HARMONIZED locus bundle from PI_ARROW_IN (Arrow IPC), run
# colocalization (coloc.abf — Giambartolomei 2014), write the posteriors PP.H0..PP.H4 back to PI_ARROW_OUT. This
# is a thing SQL is poor at (per-SNP approximate Bayes factors + the H0-H4 posterior combination), so it runs
# OUT-OF-PROCESS in R; the DATA contract stays SQL/Arrow. Uses the real `coloc` package when present, else a
# faithful inline implementation of the SAME algorithm (Wakefield ABF) so the example is portable.
suppressMessages(library(arrow))

df <- as.data.frame(read_ipc_stream(Sys.getenv("PI_ARROW_IN")))

if (requireNamespace("coloc", quietly = TRUE)) {
  d1 <- list(beta = df$beta_gwas, varbeta = df$varbeta_gwas, snp = df$snp, type = "quant", sdY = 1)
  d2 <- list(beta = df$beta_eqtl, varbeta = df$varbeta_eqtl, snp = df$snp, type = "quant", sdY = 1)
  s <- suppressMessages(coloc::coloc.abf(d1, d2))$summary
  pp <- c(s[["PP.H0.abf"]], s[["PP.H1.abf"]], s[["PP.H2.abf"]], s[["PP.H3.abf"]], s[["PP.H4.abf"]])
  engine <- "coloc::coloc.abf"
} else {
  # faithful inline coloc.abf: per-SNP Wakefield log-ABF, then the standard H0-H4 posterior combination.
  labf <- function(beta, vb, W = 0.15^2) { z <- beta / sqrt(vb); r <- W / (W + vb); 0.5 * (log(1 - r) + r * z * z) }
  logsum <- function(x) { m <- max(x); m + log(sum(exp(x - m))) }
  ldiff <- function(a, b) { a + log1p(-exp(b - a)) }              # log(exp(a) - exp(b)), a > b
  l1 <- labf(df$beta_gwas, df$varbeta_gwas); l2 <- labf(df$beta_eqtl, df$varbeta_eqtl)
  p1 <- 1e-4; p2 <- 1e-4; p12 <- 1e-5
  lH0 <- 0                                                         # null in both
  lH1 <- log(p1) + logsum(l1)                                      # causal in trait1 only
  lH2 <- log(p2) + logsum(l2)                                      # causal in trait2 only
  lH3 <- log(p1) + log(p2) + ldiff(logsum(l1) + logsum(l2), logsum(l1 + l2)) # both, DIFFERENT snps
  lH4 <- log(p12) + logsum(l1 + l2)                               # both, SAME snp (colocalization)
  lse <- logsum(c(lH0, lH1, lH2, lH3, lH4))
  pp <- exp(c(lH0, lH1, lH2, lH3, lH4) - lse)
  engine <- "inline-abf"
}

out <- data.frame(
  hypothesis = c("PP.H0", "PP.H1", "PP.H2", "PP.H3", "PP.H4"),
  posterior = pp, nsnps = nrow(df), engine = engine
)
write_ipc_stream(out, Sys.getenv("PI_ARROW_OUT"))
