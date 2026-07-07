import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeBioEdgesAsOf } from "../src/duckdb/observations.js";
import type { SqlConn } from "../src/core/ports.js";
import { collectGarbage } from "../src/hosts/gc.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { recordArtifactReference } from "../src/hosts/artifacts.js";
import { dropCasRefs, recordCasObject } from "../src/hosts/cas-metadata.js";

const T0 = "2026-07-06T10:00:00.000Z";

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function conn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

function sha256(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("CAS artifact observations", () => {
  test("records a run-produced artifact as intrinsic CAS fact plus graph edge", async () => {
    const dir = await tmp("pi-bio-artifact-obs-");
    const cas = fsCasStore(join(dir, "cas"));
    const c = await conn();
    const bytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><circle cx='4' cy='4' r='4'/></svg>");
    const digest = sha256(bytes);
    await cas.put({ algorithm: "sha256", digest: digest.slice("sha256:".length) }, bytes);

    const first = await recordArtifactReference(c, {
      artifact: {
        digest,
        mediaType: "image/svg+xml",
        semanticRole: "figure",
        sizeBytes: bytes.length,
      },
      subjectId: "run:figure-1",
      predicate: "produces",
      recordedAt: T0,
      source: "artifact-test",
      attrs: {
        producer_run: "run:figure-1",
        source_digest: `sha256:${"a".repeat(64)}`,
        plotting_system: "R/ggplot2",
      },
    });
    const second = await recordArtifactReference(c, {
      artifact: {
        digest,
        mediaType: "image/svg+xml",
        semanticRole: "figure",
        sizeBytes: bytes.length,
      },
      subjectId: "run:figure-1",
      predicate: "produces",
      recordedAt: T0,
      source: "artifact-test",
      attrs: {
        producer_run: "run:figure-1",
        source_digest: `sha256:${"a".repeat(64)}`,
        plotting_system: "R/ggplot2",
      },
    });
    assert.deepEqual(second, first, "same artifact reference is idempotent");

    const facts = await c.all<{ subject_id: string; value_json: string; attrs: string | null; n: bigint }>(
      `SELECT subject_id, value_json::VARCHAR AS value_json, attrs::VARCHAR AS attrs, count(*) OVER () AS n
       FROM bio_observations
       WHERE predicate = 'artifact'`,
    );
    assert.equal(facts.length, 1);
    assert.equal(Number(facts[0]!.n), 1);
    assert.equal(facts[0]!.subject_id, first.casUri);
    assert.deepEqual(JSON.parse(facts[0]!.value_json) as unknown, {
      digest,
      uri: first.casUri,
      media_type: "image/svg+xml",
      semantic_role: "figure",
      size_bytes: bytes.length,
    });

    await materializeBioEdgesAsOf(c, "2026-07-06T10:00:01.000Z");
    const edges = await c.all<{ from_id: string; predicate: string; to_id: string; attrs: string }>(
      `SELECT from_id, predicate, to_id, attrs::VARCHAR AS attrs
       FROM bio_edges_as_of
       WHERE from_id = 'run:figure-1'`,
    );
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.predicate, "produces");
    assert.equal(edges[0]!.to_id, first.casUri);
    assert.deepEqual(JSON.parse(edges[0]!.attrs) as unknown, {
      producer_run: "run:figure-1",
      source_digest: `sha256:${"a".repeat(64)}`,
      plotting_system: "R/ggplot2",
      media_type: "image/svg+xml",
      semantic_role: "figure",
    });
  });

  test("artifact facts root CAS bytes during ledger-aware GC", async () => {
    const dir = await tmp("pi-bio-artifact-gc-");
    const casRoot = join(dir, "cas");
    const cas = fsCasStore(casRoot);
    const c = await conn();
    const keptBytes = Buffer.from("kept figure");
    const sweptBytes = Buffer.from("stray bytes");
    const kept = sha256(keptBytes);
    const swept = sha256(sweptBytes);
    await cas.put({ algorithm: "sha256", digest: kept.slice("sha256:".length) }, keptBytes);
    await cas.put({ algorithm: "sha256", digest: swept.slice("sha256:".length) }, sweptBytes);
    await recordArtifactReference(c, {
      artifact: { digest: kept, mediaType: "text/plain", semanticRole: "report", sizeBytes: keptBytes.length },
      subjectId: "run:report-1",
      predicate: "produces",
      recordedAt: T0,
      source: "artifact-test",
      attrs: { producer_run: "run:report-1" },
    });

    const gc = await collectGarbage(dir, { casRoot, store: c });
    assert.deepEqual(gc.casSwept, [`sha256/${swept.slice("sha256:".length)}`]);
    assert.equal(await cas.has({ algorithm: "sha256", digest: kept.slice("sha256:".length) }), true);
    assert.equal(await cas.has({ algorithm: "sha256", digest: swept.slice("sha256:".length) }), false);
  });

  test("artifact references can register shared CAS metadata roots", async () => {
    const dir = await tmp("pi-bio-artifact-meta-");
    const casRoot = join(dir, "cas");
    const cas = fsCasStore(casRoot);
    const c = await conn();
    const keptBytes = Buffer.from("shared figure");
    const sweptBytes = Buffer.from("shared stray");
    const kept = sha256(keptBytes);
    const swept = sha256(sweptBytes);
    const keptAddress = { algorithm: "sha256" as const, digest: kept.slice("sha256:".length) };
    const sweptAddress = { algorithm: "sha256" as const, digest: swept.slice("sha256:".length) };
    await cas.put(keptAddress, keptBytes);
    await cas.put(sweptAddress, sweptBytes);

    await recordArtifactReference(c, {
      artifact: { digest: kept, mediaType: "text/plain", semanticRole: "report", sizeBytes: keptBytes.length },
      subjectId: "run:report-1",
      predicate: "produces",
      recordedAt: T0,
      source: "artifact-test",
      attrs: { producer_run: "run:report-1" },
      casMetadata: { conn: c, nowMs: 1000 },
    });
    await recordCasObject(c, sweptAddress, sweptBytes.length, 1000);

    await collectGarbage(dir, { casMode: "shared", metadata: { conn: c, cas, cutoffMs: 2000, graceMs: 0 }, minAgeMs: 1 });
    assert.equal(await cas.has(keptAddress), true, "artifact metadata ref protects shared CAS bytes");
    assert.equal(await cas.has(sweptAddress), false, "unreferenced shared CAS bytes are swept");

    await dropCasRefs(c, `cas:${kept}`);
    await collectGarbage(dir, { casMode: "shared", metadata: { conn: c, cas, cutoffMs: 2000, graceMs: 0 }, minAgeMs: 1 });
    assert.equal(await cas.has(keptAddress), false, "dropping the artifact metadata ref releases its bytes");
  });
});
