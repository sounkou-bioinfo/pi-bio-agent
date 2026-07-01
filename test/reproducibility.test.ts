import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type EnvDescriptor, type EnvLayer,
  ENV_DESCRIPTOR_SCHEMA, unknownEnvDescriptor, canonicalEnvDescriptor, envDigest, validateEnvDescriptor, attestEnvironment,
} from "../src/core/reproducibility.js";

// C1a: the pure reproducibility data shapes. Runtime-agnostic (containers/conda/renv/modules are just layers),
// deterministic digest, explicit `unknown`, and an honest declared-vs-observed attestation.
const env = (layers: EnvLayer[], notes?: string[]): EnvDescriptor => ({ schema: ENV_DESCRIPTOR_SCHEMA, kind: "composite", layers, ...(notes ? { notes } : {}) });

const platform: EnvLayer = { kind: "platform", os: "linux", arch: "x64" };
const rscript: EnvLayer = { kind: "executable", name: "Rscript", version: "4.4.0" };
const conda: EnvLayer = { kind: "package_lock", manager: "micromamba", path: "env.yml", digest: "sha256:" + "a".repeat(64) };

describe("C1a EnvDescriptor: canonicalization + digest", () => {
  test("layer order is not semantic — reordering layers yields the SAME digest", () => {
    assert.equal(envDigest(env([platform, rscript, conda])), envDigest(env([conda, platform, rscript])));
  });

  test("package order within a snapshot is not semantic — same digest", () => {
    const a = env([{ kind: "package_snapshot", manager: "renv", packages: [{ name: "coloc", version: "5.2.3" }, { name: "data.table", version: "1.15.0" }] }]);
    const b = env([{ kind: "package_snapshot", manager: "renv", packages: [{ name: "data.table", version: "1.15.0" }, { name: "coloc", version: "5.2.3" }] }]);
    assert.equal(envDigest(a), envDigest(b));
  });

  test("duckdb extension order is not semantic — same digest", () => {
    const a = env([{ kind: "duckdb", version: "1.1.0", extensions: [{ name: "nanoarrow" }, { name: "ducknng" }] }]);
    const b = env([{ kind: "duckdb", version: "1.1.0", extensions: [{ name: "ducknng" }, { name: "nanoarrow" }] }]);
    assert.equal(envDigest(a), envDigest(b));
  });

  test("two DIFFERENT packages that would collide under a delimiter-join still normalize by order (no digest leak)", () => {
    // {name:"x",version:"a b"} and {name:"x a",version:"b"} join to the same key under a space/NUL delimiter;
    // sorting by the canonical string keeps them distinct, so reordering them cannot change the digest.
    const a = env([{ kind: "package_snapshot", manager: "renv", packages: [{ name: "x", version: "a b" }, { name: "x a", version: "b" }] }]);
    const b = env([{ kind: "package_snapshot", manager: "renv", packages: [{ name: "x a", version: "b" }, { name: "x", version: "a b" }] }]);
    assert.equal(envDigest(a), envDigest(b));
  });

  test("a package version bump CHANGES the digest (it's real identity)", () => {
    const a = env([{ kind: "package_snapshot", manager: "renv", packages: [{ name: "coloc", version: "5.2.3" }] }]);
    const b = env([{ kind: "package_snapshot", manager: "renv", packages: [{ name: "coloc", version: "5.2.4" }] }]);
    assert.notEqual(envDigest(a), envDigest(b));
  });

  test("notes are annotation, not identity — same digest with/without notes", () => {
    assert.equal(envDigest(env([rscript], ["ran on CI"])), envDigest(env([rscript])));
  });

  test("unknown is explicit and STABLE (two unknowns share one digest) and distinct from any composite", () => {
    assert.equal(envDigest(unknownEnvDescriptor()), envDigest(unknownEnvDescriptor(["no probe"])));
    assert.notEqual(envDigest(unknownEnvDescriptor()), envDigest(env([platform])));
    assert.match(envDigest(unknownEnvDescriptor()), /^sha256:[0-9a-f]{64}$/);
  });

  test("canonical serialization is deterministic across key/whitespace differences", () => {
    assert.equal(canonicalEnvDescriptor(env([rscript, platform])), canonicalEnvDescriptor(env([platform, rscript])));
  });
});

describe("C1a validateEnvDescriptor", () => {
  test("a well-formed composite and a well-formed unknown validate clean", () => {
    assert.deepEqual(validateEnvDescriptor(env([platform, rscript, conda])), []);
    assert.deepEqual(validateEnvDescriptor(unknownEnvDescriptor()), []);
  });
  test("catches: bad schema, empty composite, unknown-with-layers, missing required layer fields", () => {
    assert.ok(validateEnvDescriptor({ schema: "nope", kind: "composite", layers: [platform] }).some((e) => /schema/.test(e)));
    assert.ok(validateEnvDescriptor({ schema: ENV_DESCRIPTOR_SCHEMA, kind: "composite", layers: [] }).some((e) => /at least one layer/.test(e)));
    assert.ok(validateEnvDescriptor({ schema: ENV_DESCRIPTOR_SCHEMA, kind: "unknown", layers: [platform] }).some((e) => /no layers/.test(e)));
    assert.ok(validateEnvDescriptor(env([{ kind: "executable", name: "" } as EnvLayer])).some((e) => /executable.*name/.test(e)));
    assert.ok(validateEnvDescriptor(env([{ kind: "package_lock", manager: "conda", digest: "" } as EnvLayer])).some((e) => /package_lock/.test(e)));
    assert.ok(validateEnvDescriptor(env([{ kind: "bogus" } as unknown as EnvLayer])).some((e) => /unknown layer kind/.test(e)));
  });
  test("takes UNKNOWN input (untrusted manifest data) without throwing", () => {
    assert.deepEqual(validateEnvDescriptor(null).length > 0, true);
    assert.deepEqual(validateEnvDescriptor("not an object").length > 0, true);
    assert.deepEqual(validateEnvDescriptor([]).length > 0, true);
    assert.ok(validateEnvDescriptor({ schema: ENV_DESCRIPTOR_SCHEMA, kind: "composite", layers: ["oops"] }).some((e) => /must be an object/.test(e)));
  });
  test("digest-shaped fields must be sha256:<64 hex> (fail closed, not 'banana')", () => {
    const good = "sha256:" + "a".repeat(64);
    assert.ok(validateEnvDescriptor(env([{ kind: "package_lock", manager: "conda", digest: "banana" } as EnvLayer])).some((e) => /package_lock.*digest.*sha256/.test(e)));
    assert.deepEqual(validateEnvDescriptor(env([{ kind: "package_lock", manager: "conda", digest: good } as EnvLayer])), []);
    assert.ok(validateEnvDescriptor(env([{ kind: "container_image", digest: "nope" } as EnvLayer])).some((e) => /container_image.*digest.*sha256/.test(e)));
    assert.ok(validateEnvDescriptor(env([{ kind: "package_snapshot", manager: "renv", packages: [{ name: "coloc", digest: "xx" }] } as EnvLayer])).some((e) => /packages\[0\].digest.*sha256/.test(e)));
  });
});

describe("C1a attestEnvironment (declared vs observed drift status)", () => {
  const declared = { descriptor: env([rscript, conda]), source: "manifest" };
  const same = { descriptor: env([conda, rscript]), source: "process_runner" }; // reordered -> same digest
  const different = { descriptor: env([rscript]), source: "process_runner" };

  test("declared == observed -> matched", () => {
    const a = attestEnvironment(declared, same);
    assert.equal(a.status, "matched");
    assert.equal(a.declared!.digest, a.observed!.digest);
  });
  test("declared != observed -> drift", () => {
    assert.equal(attestEnvironment(declared, different).status, "drift");
  });
  test("declared only -> declared_only; observed only -> observed_only", () => {
    assert.equal(attestEnvironment(declared, undefined).status, "declared_only");
    assert.equal(attestEnvironment(undefined, different).status, "observed_only");
  });
  test("neither meaningful -> unknown; an unknown observed against a declared pin stays declared_only (no false match)", () => {
    assert.equal(attestEnvironment(undefined, undefined).status, "unknown");
    assert.equal(attestEnvironment({ descriptor: unknownEnvDescriptor(), source: "manifest" }, { descriptor: unknownEnvDescriptor(), source: "process_runner" }).status, "unknown");
    const a = attestEnvironment(declared, { descriptor: unknownEnvDescriptor(), source: "process_runner" });
    assert.equal(a.status, "declared_only");
    assert.ok(a.observed, "the unknown observation is still RECORDED (honest), it just doesn't count toward status");
  });
});
