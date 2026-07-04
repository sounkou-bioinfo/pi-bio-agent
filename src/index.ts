// The library (SDK) entry point — the substrate as an importable package. A host embeds pi-bio-agent by importing
// the core contracts + validators, the DuckDB adapters/resolvers, and the host run-store/CAS/governance helpers,
// then injecting its own effect ports (SqlConn, ComputeRunner, CasStore, fetch). Nothing here is Pi-specific;
// the Pi coding-agent extension is one consumer of exactly these exports.
//
//   import { runBioQueryFromManifest } from "pi-bio-agent";        // the whole surface
//   import { validateBioManifest } from "pi-bio-agent/core";       // core contracts only
//   import { duckdbNodeConn } from "pi-bio-agent/duckdb";          // DuckDB adapters
//   import { fsCasStore } from "pi-bio-agent/hosts";               // host helpers

export * from "./core/index.js";
export * from "./duckdb/index.js";
export * from "./hosts/index.js";
