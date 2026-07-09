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
// Plus RunReplaySpec: the ACTUAL replay inputs (manifest snapshot, SQL/params, compute params, env attestation) —
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

export interface RenvLockEnvDescriptorOptions {
  /** Optional authored path to the lockfile. Recorded as annotation on the package_lock layer. */
  path?: string;
  /** Defaults to `renv`; overridable for hosts that use a compatible lockfile producer. */
  manager?: string;
  /** Human annotations. Excluded from identity like every EnvDescriptor note. */
  notes?: string[];
}

/** Convert an `renv.lock` JSON document into the generic EnvDescriptor shape.
 *
 * The exact lockfile bytes are pinned as a `package_lock` layer. The package records are also projected as a
 * `package_snapshot` layer so corpus/export queries can see package names and versions without reparsing the lock.
 * This helper does not restore packages, inspect an R library, or privilege Bioconductor; it is only a structured
 * adapter from a common R lockfile into the existing runtime-agnostic environment descriptor.
 */
export function envDescriptorFromRenvLock(lockText: string, opts: RenvLockEnvDescriptorOptions = {}): EnvDescriptor {
  if (typeof lockText !== "string" || lockText.length === 0) throw new Error("renv.lock text must be a non-empty string");
  const manager = opts.manager ?? "renv";
  if (typeof manager !== "string" || manager.length === 0 || /[\x00-\x1f\x7f]/.test(manager)) throw new Error("renv.lock manager must be a non-empty string without control characters");
  if (opts.path !== undefined && (typeof opts.path !== "string" || opts.path.length === 0 || /[\x00-\x1f\x7f]/.test(opts.path))) throw new Error("renv.lock path must be a non-empty string without control characters");

  let parsed: unknown;
  try { parsed = JSON.parse(lockText); } catch {
    throw new Error("renv.lock must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("renv.lock must be a JSON object");
  const lock = parsed as Record<string, unknown>;
  if (typeof lock.Packages !== "object" || lock.Packages === null || Array.isArray(lock.Packages)) throw new Error("renv.lock Packages must be an object");

  const packages = Object.entries(lock.Packages as Record<string, unknown>).map(([key, value]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`renv.lock package '${key}' must be an object`);
    const record = value as Record<string, unknown>;
    const packageName = record.Package ?? key;
    if (typeof packageName !== "string" || packageName.length === 0) throw new Error(`renv.lock package '${key}' Package must be a non-empty string when supplied`);
    if (typeof record.Version !== "string" || record.Version.length === 0) throw new Error(`renv.lock package '${key}' Version must be a non-empty string`);
    const source = record.Source;
    const repository = record.Repository;
    if (source !== undefined && typeof source !== "string") throw new Error(`renv.lock package '${key}' Source must be a string when supplied`);
    if (repository !== undefined && typeof repository !== "string") throw new Error(`renv.lock package '${key}' Repository must be a string when supplied`);
    return {
      name: packageName,
      version: record.Version,
      ...(source ? { build: source } : {}),
      ...(repository ? { channel: repository } : {}),
    };
  });

  const layers: EnvLayer[] = [
    { kind: "package_lock", manager, ...(opts.path ? { path: opts.path } : {}), digest: `sha256:${createHash("sha256").update(lockText).digest("hex")}` },
    { kind: "package_snapshot", manager, packages },
  ];

  if (lock.R !== undefined) {
    if (typeof lock.R !== "object" || lock.R === null || Array.isArray(lock.R)) throw new Error("renv.lock R must be an object when supplied");
    const r = lock.R as Record<string, unknown>;
    if (r.Version !== undefined) {
      if (typeof r.Version !== "string" || r.Version.length === 0) throw new Error("renv.lock R.Version must be a non-empty string when supplied");
      layers.push({ kind: "executable", name: "R", version: r.Version });
    }
  }

  if (lock.Bioconductor !== undefined) {
    if (typeof lock.Bioconductor !== "object" || lock.Bioconductor === null || Array.isArray(lock.Bioconductor)) throw new Error("renv.lock Bioconductor must be an object when supplied");
    const bioc = lock.Bioconductor as Record<string, unknown>;
    if (bioc.Version !== undefined) {
      if (typeof bioc.Version !== "string" || bioc.Version.length === 0) throw new Error("renv.lock Bioconductor.Version must be a non-empty string when supplied");
      layers.push({ kind: "module", name: "Bioconductor", version: bioc.Version });
    }
  }

  return { schema: ENV_DESCRIPTOR_SCHEMA, kind: "composite", layers, ...(opts.notes ? { notes: opts.notes } : {}) };
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
  /** what ACTUALLY ran — the host's observation (a ComputeRunner probe / a host provider). */
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
// resolved on THIS host (compute.run `./script.R` → an absolute path), keep BOTH the authored manifest snapshot
// (portable intent) and the resolved execution facts (what actually ran) — see run-store's path resolution.

/** A stable digest over any JSON value (canonical key order). */
export function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

/** The DETERMINISTIC content of a resolution receipt — WHAT was resolved and from where — excluding wall-clock
 *  fields (resolvedAt / retrievedAt) and free-text notes that legitimately differ every run. This is the digest
 *  `sourceReceiptDigests` stores and reproduce() compares: a faithful re-run of the same inputs yields the same
 *  content digest, so a mismatch is REAL drift (a changed resolver/params/source/result), not a clock difference. */
export interface ReceiptLike {
  resourceId: string;
  resolverId: string;
  resolverVersion: string;
  paramsDigest: string;
  sourceSnapshots: Array<{ source: string; version?: string }>;
  result: unknown;
  provenance: Array<{ source: string; digest?: string }>;
}
export function receiptContentDigest(r: ReceiptLike): `sha256:${string}` {
  return canonicalDigest({
    resourceId: r.resourceId, resolverId: r.resolverId, resolverVersion: r.resolverVersion, paramsDigest: r.paramsDigest,
    sourceSnapshots: r.sourceSnapshots.map((s) => ({ source: s.source, version: s.version ?? null })),
    result: r.result,
    provenance: r.provenance.map((p) => ({ source: p.source, digest: p.digest ?? null })),
  });
}

/** Environment identity carried in replay and receipt provenance: status + declared/observed digests. The authored
 *  descriptor remains in the manifest; an observed descriptor is host-owned and is not serialized here. */
export interface EnvAttestationSummary {
  status: EnvironmentAttestation["status"];
  declaredDigest?: string;
  observedDigest?: string;
}

/** Resolved execution facts for one compute.run resource. The environment belongs to the resource that used it;
 *  keeping them together prevents a multi-compute replay from accidentally certifying only the first process. */
export interface ComputeReplayResource {
  resourceId: string;
  table?: string;
  command?: readonly string[];
  inputSql?: string;
  resultTable?: "arrow" | "artifacts";
  outputs?: Array<{ name: string; path: string; kind?: string; mediaType?: string; semanticRole?: string; attrs?: Record<string, unknown> }>;
  /** Same status/digest evidence recorded by this resource's receipt. Added after resolution. */
  environment?: EnvAttestationSummary;
}

/** Terminal behavior pinned by a completed replay. Failed/cancelled runs use an error digest so replay can verify
 *  the same outcome without copying diagnostic text into the replay identity. */
export interface RunReplayOutcome {
  status: "succeeded" | "failed" | "cancelled";
  errorDigest?: `sha256:${string}`;
}

export interface HostCapabilityReceipt {
  schema: string;
  /** Optional policy digest from a secret-free receipt, e.g. a ducknng HTTP profile receipt. */
  policyDigest?: string;
}

const HOST_RECEIPT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA = "pi-bio.ducknng_http_profile_receipt.v1";
const DECIMAL_TEXT = /^(0|[1-9][0-9]*)$/;

function ducknngHttpProfileReceiptDigest(receipt: HostCapabilityReceipt): `sha256:${string}` {
  const r = receipt as unknown as Record<string, unknown>;
  const fail = (reason: string): never => { throw new Error(`ducknng HTTP profile receipt ${reason}`); };
  const topKeys = Object.keys(r).sort();
  const expectedTopKeys = ["authHeaderNames", "createdMs", "expiresAtMs", "policyDigest", "profileId", "schema", "scope", "subjectRestriction", "updatedMs", "version"].sort();
  if (JSON.stringify(topKeys) !== JSON.stringify(expectedTopKeys)) fail("must contain only its redacted policy fields");
  if (typeof r.profileId !== "string" || !r.profileId) fail("requires profileId");
  if (!r.scope || typeof r.scope !== "object" || Array.isArray(r.scope)) fail("requires scope object");
  const scope = r.scope as Record<string, unknown>;
  const scopeKeys = Object.keys(scope).sort();
  const expectedScopeKeys = ["host", "method", "pathPrefix", "port", "scheme", "tlsRequired"].sort();
  if (JSON.stringify(scopeKeys) !== JSON.stringify(expectedScopeKeys)) fail("scope must contain only scheme/host/port/pathPrefix/method/tlsRequired");
  if (typeof scope.scheme !== "string" || typeof scope.host !== "string" || typeof scope.pathPrefix !== "string" || typeof scope.method !== "string") fail("scope string fields are required");
  if (scope.port !== null && (typeof scope.port !== "number" || !Number.isInteger(scope.port) || scope.port < 1 || scope.port > 65535)) fail("scope.port must be null or a TCP port");
  if (typeof scope.tlsRequired !== "boolean") fail("scope.tlsRequired must be boolean");
  if (!Array.isArray(r.authHeaderNames) || r.authHeaderNames.some((x) => typeof x !== "string" || x.length === 0)) fail("authHeaderNames must be a string array");
  for (const key of ["version", "createdMs", "updatedMs"] as const) {
    if (typeof r[key] !== "string" || !DECIMAL_TEXT.test(r[key])) fail(`${key} must be decimal text`);
  }
  if (r.expiresAtMs !== null && (typeof r.expiresAtMs !== "string" || !DECIMAL_TEXT.test(r.expiresAtMs))) fail("expiresAtMs must be null or decimal text");
  if (!r.subjectRestriction || typeof r.subjectRestriction !== "object" || Array.isArray(r.subjectRestriction)) fail("requires subjectRestriction object");
  const restriction = r.subjectRestriction as Record<string, unknown>;
  const restrictionKeys = Object.keys(restriction).sort();
  const restricted = restriction.restricted === true;
  const expectedRestrictionKeys = restricted ? ["count", "digest", "restricted"].sort() : ["count", "restricted"].sort();
  if (JSON.stringify(restrictionKeys) !== JSON.stringify(expectedRestrictionKeys)) fail("subjectRestriction must be redacted to restricted/count/digest");
  if (typeof restriction.restricted !== "boolean") fail("subjectRestriction.restricted must be boolean");
  if (typeof restriction.count !== "number" || !Number.isInteger(restriction.count) || restriction.count < 0) fail("subjectRestriction.count must be a non-negative integer");
  const restrictionCount = restriction.count as number;
  if (restricted) {
    if (restrictionCount < 1) fail("restricted subject lists must have a positive count");
    if (typeof restriction.digest !== "string" || !HOST_RECEIPT_DIGEST.test(restriction.digest)) fail("subjectRestriction.digest must be sha256:<64 hex>");
  } else if (restrictionCount !== 0) {
    fail("unrestricted subjectRestriction count must be zero");
  }
  if (typeof r.policyDigest !== "string" || !HOST_RECEIPT_DIGEST.test(r.policyDigest)) fail("policyDigest must be sha256:<64 hex>");
  const body = {
    schema: DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA,
    profileId: r.profileId,
    scope: {
      scheme: scope.scheme,
      host: scope.host,
      port: scope.port,
      pathPrefix: scope.pathPrefix,
      method: scope.method,
      tlsRequired: scope.tlsRequired,
    },
    authHeaderNames: r.authHeaderNames,
    version: r.version,
    createdMs: r.createdMs,
    updatedMs: r.updatedMs,
    expiresAtMs: r.expiresAtMs,
    subjectRestriction: restricted
      ? { restricted: true, count: restrictionCount, digest: restriction.digest }
      : { restricted: false, count: 0 },
  };
  const digest = canonicalDigest(body);
  if (r.policyDigest !== digest) fail("policyDigest does not match the redacted receipt body");
  return digest;
}

export function hostCapabilityReceiptDigest(receipt: HostCapabilityReceipt): `sha256:${string}` {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("host capability receipt must be an object");
  if (typeof receipt.schema !== "string" || !receipt.schema.trim()) throw new Error("host capability receipt requires a schema string");
  if (receipt.schema === DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA) return ducknngHttpProfileReceiptDigest(receipt);
  if (receipt.policyDigest !== undefined) {
    if (typeof receipt.policyDigest !== "string" || !HOST_RECEIPT_DIGEST.test(receipt.policyDigest)) throw new Error("host capability receipt policyDigest must be sha256:<64 hex>");
    return receipt.policyDigest as `sha256:${string}`;
  }
  return canonicalDigest(receipt);
}

export function hostCapabilityReceiptDigests(receipts: readonly HostCapabilityReceipt[] | undefined): `sha256:${string}`[] {
  return (receipts ?? []).map(hostCapabilityReceiptDigest).sort();
}

export interface RunReplaySpec {
  schema: typeof RUN_REPLAY_SPEC_SCHEMA;
  runId: string;
  kind: "query" | "operation" | "compute.run";
  /** the AUTHORED manifest (portable replay intent) + its digest; snapshot is the manifest JSON as written. */
  manifest?: { digest: string; snapshot: unknown; path?: string };
  operationId?: string;
  sql?: string;
  params?: unknown[];
  resources?: string[];
  bindings?: Record<string, unknown>;
  /** DIGEST of the host's connection-init SQL — NOT the SQL itself. Init SQL is host-owned bootstrap that can carry
   *  secrets (`SET VARIABLE token='…'`, inline PEM), so persisting it verbatim would leak them into replay.json.
   *  reproduce requires the host to re-supply the same duckdbInitSql and verifies this digest, exactly like
   *  duckdbConfigDigest. */
  duckdbInitSqlDigest?: string;
  /** DIGEST of host-owned protected session bindings. Values are parameter-bound at runtime and never serialized
   *  into replay.json; reproduce requires the host to re-supply the same protected bindings and verifies this digest. */
  protectedSessionBindingsDigest?: string;
  /** DIGEST of additional host-declared protected session-variable names (for values set by init SQL/profiles).
   *  Names are pinned by digest so the ad-hoc query boundary is reproduced without serializing the declaration. */
  protectedSessionVariablesDigest?: string;
  duckdbConfigDigest?: string;
  /** RESOLVED compute facts in resource execution order. Each resource carries its own environment summary. */
  computeResources?: ComputeReplayResource[];
  /** Terminal outcome of the recorded execution. Absent only on a prospective job seed that has not run yet. */
  outcome?: RunReplayOutcome;
  /** stable digests of the receipts this run produced — reproduce()'s pin on the exact provenance it should match. */
  sourceReceiptDigests?: string[];
  /** stable digests of host-owned capability policy receipts (secret-free), e.g. a ducknng HTTP profile policy. */
  hostReceiptDigests?: string[];
  /** CAS digest of the run's RESULT rows — reproduce()'s pin on the OUTPUT content, so a re-run that yields a
   *  different result is caught (not just a changed source). "matches by content" means this, not only receipts. */
  resultDigest?: string;
}

/** sha256 over the canonicalized replay spec — a single handle for the whole replayable bundle. */
export function replaySpecDigest(spec: RunReplaySpec): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableStringify(spec)).digest("hex")}`;
}
