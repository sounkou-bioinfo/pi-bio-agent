#!/usr/bin/env Rscript
# COMPUTE pillar with FILE OUTPUTS (#3): the VALUE return goes back as an Arrow table (out.arrow); the FILE
# outputs are written into the WORK DIR (cwd) and captured into CAS by the resolver — the nf-r-ipc/Nextflow
# split (values in the IPC, files content-addressed beside it). Arrow IPC via the lightweight nanoarrow.
suppressMessages(library(nanoarrow))
args <- commandArgs(trailingOnly = TRUE)            # the last two args are <in.arrow> <out.arrow>
in_path <- args[length(args) - 1]; out_path <- args[length(args)]
df <- tryCatch(as.data.frame(read_nanoarrow(in_path)),
               error = function(e) stop(paste("summarize.R: cannot read input:", conditionMessage(e))))

# 1) the VALUE return — a small summary table, back over Arrow IPC
write_nanoarrow(data.frame(n = nrow(df), mean_x = mean(df$x), status = "ok"), out_path)

# 2) FILE outputs — written to the cwd (the work dir), declared in the manifest, captured into CAS by the host
write.csv(df, "rows.csv", row.names = FALSE)        # a 'table' artifact (re-readable via read_csv over its CAS path)
writeLines(c(
  "<!doctype html>",
  "<html><head><meta charset='utf-8'><title>summarize report</title></head><body>",
  "<h1>summarize report</h1>",
  paste0("<p>rows: ", nrow(df), "</p>"),
  paste0("<p>mean_x: ", mean(df$x), "</p>"),
  "</body></html>"
), "report.html")                                  # an HTML report artifact
svg("plot.svg", width = 5, height = 3.2)
barplot(df$x, names.arg = seq_len(nrow(df)), col = "#2C7FB8", xlab = "row", ylab = "x", main = "Input values")
invisible(dev.off())
