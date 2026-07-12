#!/usr/bin/env Rscript

suppressMessages(library(nanoarrow))
args <- commandArgs(trailingOnly = TRUE)
input_path <- args[length(args)]
rows <- tryCatch(
  as.data.frame(read_nanoarrow(input_path)),
  error = function(e) stop(paste("render-evidence-status.R: cannot read input:", conditionMessage(e)))
)

if (nrow(rows) == 0) stop("render-evidence-status.R: evidence relation is empty")

lanes <- c("direct", "inverted")
statuses <- sort(unique(rows$evidence_status))
counts <- matrix(0, nrow = length(lanes), ncol = length(statuses), dimnames = list(lanes, statuses))
for (i in seq_len(nrow(rows))) {
  counts[rows$lane[i], rows$evidence_status[i]] <- rows$n[i]
}

svg("evidence-status.svg", width = 9, height = 4.8, bg = "white")
par(mar = c(4.2, 14, 3.2, 1.2), family = "sans", las = 1)
barplot(
  counts,
  beside = TRUE,
  horiz = TRUE,
  names.arg = gsub("_", " ", statuses),
  col = c("#176b50", "#2b5fab"),
  border = NA,
  xlab = "Evidence rows",
  main = "Evidence status by traversal lane",
  legend.text = lanes,
  args.legend = list(x = "bottomright", bty = "n", inset = 0.01, horiz = TRUE)
)
grid(nx = NA, ny = NULL, col = "#d7ded9", lty = 1)
box(bty = "l", col = "#68726b")
invisible(dev.off())
