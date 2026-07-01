import { createHash } from "node:crypto";

// C1 — the REPRODUCIBILITY substrate: environment IDENTITY + a REPLAY seed. Data-first, NO execution (no
// micromamba restore, no container run, no `pip freeze` shell-out) — that is C2/host territory. Two ideas:
//
//   1. EnvDescriptor — a RUNTIME-AGNOSTIC fingerprint of an environment, built from LAYERS. A container image, a
//      conda/micromamba lock, an renv lock, a bare executable, a DuckDB+extensions set, a system module are all
//      just LAYERS — none is privileged (the substrate is not a container framework). `unknown` is a valid,
//      EXPLICIT descriptor: the receipt must never pretend an env is pinned when it isn't.
//   2. EnvironmentAttestation — declared (the reproduction CONTRACT) + observed (what actually RAN) + a drift
//      STATUS. One `env_digest` cannot both promise and attest; the envelope keeps them honest.
//
// Plus RunReplaySpec: the ACTUAL replay inputs (manifest snapshot, SQL/params, process params, env attestation) —
// NOT just digests. A digest-only receipt cannot drive reproduce(); C1 seeds the bundle C2 will execute.

export const ENV_DESCRIPTOR_SCHEMA = "pi-bio.env_descriptor.v1" as const;
export const ENV_ATTESTATION_SCHEMA = "pi-bio.environment_attestation.v1" as const;
export const RUN_REPLAY_SPEC_SCHEMA = "pi-bio.run_replay_spec.v1" as const;

/** One facet of an environment. Containers/conda/micromamba/renv/modules are all just layers — none is the root. */
export type EnvLayer =
  | { kind: "platform"; os?: string; arch?: string; kernel?: string }
  | { kind: "executable"; name: string; path?: string; version?: string; digest?: string }
  | { kind: "package_lock"; manager: string; path?: string; digest: string }
  | { kind: "package_snapshot"; manager: string; packages: Array<{ name: string; version?: string; build?: string; channel?: string; digest?: string }> }
  | { kind: "container_image"; image?: string; digest?: string }
  | { kind: "duckdb"; version?: string; extensions?: Array<{ name: string; version?: string; source?: string }> }
  | { kind: "module"; name: string; version?: string };

export const ENV_LAYER_KINDS = ["platform", "executable", "package_lock", "package_snapshot", "container_image", "duckdb", "module"] as const;

export interface EnvDescriptor {
  schema: typeof ENV_DESCRIPTOR_SCHEMA;
  /** `unknown` = explicitly no meaningful env captured (layers empty). `composite` = one or more layers below. */
  kind: "unknown" | "composite";
  layers: EnvLayer[];
  /** human annotations — NOT part of identity (excluded from the digest), like observation attrs. */
  notes?: string[];
}

/** An explicit "we don't know the environment" — a first-class, stable value (never a fake pin). */
export const unknownEnvDescriptor = (notes?: string[]): EnvDescriptor => ({ schema: ENV_DESCRIPTOR_SCHEMA, kind: "unknown", layers: [], ...(notes ? { notes } : {}) });

/** A descriptor is MEANINGFUL for attestation only if it actually captured something (composite + ≥1 layer). */
export const isMeaningfulEnv = (e: EnvDescriptor | undefined): e is EnvDescriptor => !!e && e.kind === "composite" && e.layers.length > 0;

// ── canonicalization + digest ────────────────────────────────────────────────────────────────────────────────
// Deterministic JSON: object keys sorted, undefined-valued keys dropped, and arrays whose order is NOT semantic
// (layers; packages within a snapshot; extensions within a duckdb layer) pre-SORTED so reordering can't change the
// digest. `notes` are excluded (annotation, not identity). There is deliberately no free-form key/value layer, so a
// raw process.env dump is not even representable — it can't leak into a fingerprint.

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

function normalizeLayer(l: EnvLayer): EnvLayer {
  // sort by the UNAMBIGUOUS canonical string, never a delimiter-joined key. A raw-NUL/space join both risk the
  // delimiter-ambiguity latent-bug class (`{name:"x",version:"a b"}` vs `{name:"x a",version:"b"}` collide) AND a
  // NUL literal makes the source a binary blob. stableStringify is injective here, so reordering can't move the digest.
  if (l.kind === "package_snapshot") return { ...l, packages: [...l.packages].sort((a, b) => cmpKey(stableStringify(a), stableStringify(b))) };
  if (l.kind === "duckdb" && l.extensions) return { ...l, extensions: [...l.extensions].sort((a, b) => cmpKey(stableStringify(a), stableStringify(b))) };
  return l;
}
const cmpKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical, digest-ready serialization of a descriptor (notes excluded, arrays order-normalized). */
export function canonicalEnvDescriptor(env: EnvDescriptor): string {
  const layers = env.layers.map(normalizeLayer).sort((a, b) => cmpKey(stableStringify(a), stableStringify(b)));
  return stableStringify({ schema: env.schema, kind: env.kind, layers });
}

export function envDigest(env: EnvDescriptor): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalEnvDescriptor(env)).digest("hex")}`;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/; // digest-shaped fields are sha256-first (matches the CAS + receipt digests)

/** Structural validation of UNTRUSTED input (a manifest may supply `params.environment`) — returns the list of
 *  problems (empty = valid). A boundary helper, so it takes `unknown` and fails loud with structured errors rather
 *  than throwing on a bad shape. Fields named `digest` must be `sha256:<64 hex>` (fail closed, not "banana"). */
export function validateEnvDescriptor(input: unknown): string[] {
  const errs: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return ["env descriptor must be an object"];
  const env = input as { schema?: unknown; kind?: unknown; layers?: unknown };
  if (env.schema !== ENV_DESCRIPTOR_SCHEMA) errs.push(`env descriptor schema must be '${ENV_DESCRIPTOR_SCHEMA}'`);
  if (env.kind !== "unknown" && env.kind !== "composite") errs.push("env descriptor kind must be 'unknown' or 'composite'");
  if (!Array.isArray(env.layers)) { errs.push("env descriptor layers must be an array"); return errs; }
  if (env.kind === "unknown" && env.layers.length > 0) errs.push("an 'unknown' env descriptor must have no layers (use 'composite' when layers are present)");
  if (env.kind === "composite" && env.layers.length === 0) errs.push("a 'composite' env descriptor must have at least one layer (use 'unknown' for no info)");
  const digest = (v: unknown, label: string, required: boolean): void => {
    if (v === undefined || v === null) { if (required) errs.push(`${label} is required`); return; }
    if (typeof v !== "string" || !SHA256.test(v)) errs.push(`${label} must be 'sha256:<64 hex>'`);
  };
  (env.layers as unknown[]).forEach((lu, i) => {
    if (typeof lu !== "object" || lu === null) { errs.push(`layers[${i}] must be an object`); return; }
    const l = lu as Record<string, unknown>;
    if (!ENV_LAYER_KINDS.includes(l.kind as (typeof ENV_LAYER_KINDS)[number])) { errs.push(`layers[${i}]: unknown layer kind '${String(l.kind)}'`); return; }
    if (l.kind === "executable") { if (!l.name) errs.push(`layers[${i}] (executable): name is required`); digest(l.digest, `layers[${i}] (executable).digest`, false); }
    if (l.kind === "package_lock") { if (!l.manager) errs.push(`layers[${i}] (package_lock): manager is required`); digest(l.digest, `layers[${i}] (package_lock).digest`, true); }
    if (l.kind === "package_snapshot") {
      if (!l.manager) errs.push(`layers[${i}] (package_snapshot): manager is required`);
      if (!Array.isArray(l.packages)) errs.push(`layers[${i}] (package_snapshot): packages must be an array`);
      else (l.packages as unknown[]).forEach((pu, j) => {
        const p = (pu ?? {}) as Record<string, unknown>;
        if (!p.name) errs.push(`layers[${i}].packages[${j}]: name is required`);
        digest(p.digest, `layers[${i}].packages[${j}].digest`, false);
      });
    }
    if (l.kind === "container_image") digest(l.digest, `layers[${i}] (container_image).digest`, false);
    if (l.kind === "module" && !l.name) errs.push(`layers[${i}] (module): name is required`);
  });
  return errs;
}

// ── attestation (declared vs observed) ───────────────────────────────────────────────────────────────────────

export type EnvSide = { descriptor: EnvDescriptor; digest: string; source: string };

export interface EnvironmentAttestation {
  schema: typeof ENV_ATTESTATION_SCHEMA;
  /** the reproduction CONTRACT — what a replay intends to recreate (from the manifest / replay spec). */
  declared?: EnvSide;
  /** what ACTUALLY ran — the host's observation (a ProcessRunner probe / a host provider). */
  observed?: EnvSide;
  status: "matched" | "drift" | "declared_only" | "observed_only" | "unknown";
  notes?: string[];
}

const side = (d: { descriptor: EnvDescriptor; source: string } | undefined): EnvSide | undefined =>
  d ? { descriptor: d.descriptor, digest: envDigest(d.descriptor), source: d.source } : undefined;

/** Combine a declared descriptor (intent) and an observed one (fact) into an attestation with a drift STATUS. A
 *  descriptor that isn't MEANINGFUL (unknown / no layers) does not count toward the status — so an observed-but-
 *  unknown probe against a declared pin is `declared_only`, not a false `matched`/`drift`. */
export function attestEnvironment(
  declared: { descriptor: EnvDescriptor; source: string } | undefined,
  observed: { descriptor: EnvDescriptor; source: string } | undefined,
  notes?: string[],
): EnvironmentAttestation {
  const d = side(declared);
  const o = side(observed);
  const dm = isMeaningfulEnv(declared?.descriptor);
  const om = isMeaningfulEnv(observed?.descriptor);
  const status: EnvironmentAttestation["status"] =
    dm && om ? (d!.digest === o!.digest ? "matched" : "drift")
      : dm ? "declared_only"
        : om ? "observed_only"
          : "unknown";
  return { schema: ENV_ATTESTATION_SCHEMA, ...(d ? { declared: d } : {}), ...(o ? { observed: o } : {}), status, ...(notes ? { notes } : {}) };
}

// ── replay seed ──────────────────────────────────────────────────────────────────────────────────────────────
// The bundle C2's reproduce() will execute. It must carry the ACTUAL inputs, not just digest pointers. For paths
// resolved on THIS host (process.compute `./script.R` → an absolute path), keep BOTH the authored manifest snapshot
// (portable intent) and the resolved execution facts (what actually ran) — see run-store's path resolution.

/** A stable digest over any JSON value (canonical key order). Used for `sourceReceiptDigests` — a fixed handle
 *  over the receipts a run actually produced, so reproduce() can pin them. */
export function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

/** The env attestation SUMMARY carried in a replay spec — status + digests only (the full EnvironmentAttestation
 *  lives in receipts.json). Kept a summary so replaySpecDigest stays order-stable (embedding full descriptors
 *  would make the replay digest sensitive to layer/package order unless re-canonicalized). */
export interface EnvAttestationSummary {
  status: EnvironmentAttestation["status"];
  declaredDigest?: string;
  observedDigest?: string;
}

export interface RunReplaySpec {
  schema: typeof RUN_REPLAY_SPEC_SCHEMA;
  runId: string;
  kind: "query" | "operation" | "process.compute";
  /** the AUTHORED manifest (portable replay intent) + its digest; snapshot is the manifest JSON as written. */
  manifest?: { digest: string; snapshot: unknown; path?: string };
  operationId?: string;
  sql?: string;
  params?: unknown[];
  resources?: string[];
  bindings?: Record<string, unknown>;
  duckdbInitSql?: string[];
  duckdbConfigDigest?: string;
  /** the RESOLVED process execution facts (what actually ran on this host). */
  process?: { resourceId?: string; table?: string; command?: readonly string[]; inputSql?: string; resultTable?: "arrow" | "artifacts"; outputs?: Array<{ name: string; path: string; kind?: string }> };
  /** env SUMMARY (status + digests); the full attestation is in receipts.json. Enriched AFTER the run resolves. */
  environment?: EnvAttestationSummary;
  /** stable digests of the receipts this run produced — reproduce()'s pin on the exact provenance it should match. */
  sourceReceiptDigests?: string[];
}

/** sha256 over the canonicalized replay spec — a single handle for the whole replayable bundle. */
export function replaySpecDigest(spec: RunReplaySpec): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableStringify(spec)).digest("hex")}`;
}
