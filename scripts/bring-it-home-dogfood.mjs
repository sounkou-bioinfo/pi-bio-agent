#!/usr/bin/env node
import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";

import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import {
  createBioObservationSchema,
  materializeBioEdgesAsOf,
  observationAsOfKey,
  recordObservation,
  recordObservationLink,
} from "../dist/duckdb/observations.js";
import { materializeGraphProjectionProfile } from "../dist/duckdb/graph-projection.js";
import { ducknngHttpProfileReceiptFromInfo } from "../dist/duckdb/http-profiles.js";
import { recordHostEvent } from "../dist/hosts/host-events.js";
import {
  jobStepCheckpointKey,
  readJobStepCheckpoint,
  runJobStepWithCheckpoint,
} from "../dist/hosts/job-store.js";

const NOW = "2026-07-06T12:00:00.000Z";
const LATER = "2026-07-06T12:00:05.000Z";
const REPLAY_DIGEST = `sha256:${"1".repeat(64)}`;

const instance = await DuckDBInstance.create(":memory:");
const raw = await instance.connect();
const conn = duckdbNodeConn(raw);

function asNumber(value) {
  return Number(value ?? 0);
}

try {
  await createBioObservationSchema(conn);

  const hostEvent = await recordHostEvent(conn, {
    subjectId: "session:dogfood",
    kind: "workbench.input.steer",
    recordedAt: NOW,
    source: "bring-it-home-dogfood",
    digest: `sha256:${"2".repeat(64)}`,
    value: {
      payload_digest: `sha256:${"3".repeat(64)}`,
      delivery: "mid_turn",
      redacted: true,
    },
    links: [
      { predicate: "affects", objectId: "turn:dogfood:review", attrs: { reason: "user_steer" } },
      { predicate: "context_sent_to", objectId: "model_call:dogfood:review" },
    ],
  });
  assert.equal(hostEvent.linkObservationIds.length, 2);

  await recordObservationLink(conn, {
    subjectId: "workflow:dogfood:step:report",
    predicate: "depends_on",
    objectId: "workflow:dogfood:step:score",
    recordedAt: NOW,
    source: "bring-it-home-dogfood",
  });
  await recordObservationLink(conn, {
    subjectId: "workflow:dogfood:step:score",
    predicate: "depends_on",
    objectId: "workflow:dogfood:step:extract",
    recordedAt: NOW,
    source: "bring-it-home-dogfood",
  });

  let extractExecutions = 0;
  const firstExtract = await runJobStepWithCheckpoint(conn, {
    runId: "dogfood-workflow",
    stepId: "extract/variants",
    recordedAt: "2026-07-06T12:00:01.000Z",
    source: "bring-it-home-dogfood",
    replayDigest: REPLAY_DIGEST,
    attempt: 1,
    run: () => {
      extractExecutions += 1;
      return { rows: 5, artifact_uri: "cas:sha256:variants-fixture" };
    },
  });
  const resumedExtract = await runJobStepWithCheckpoint(conn, {
    runId: "dogfood-workflow",
    stepId: "extract/variants",
    recordedAt: "2026-07-06T12:00:02.000Z",
    source: "bring-it-home-dogfood",
    replayDigest: REPLAY_DIGEST,
    attempt: 2,
    run: () => {
      extractExecutions += 1;
      return { rows: 99 };
    },
  });
  assert.equal(firstExtract.reused, false);
  assert.equal(resumedExtract.reused, true);
  assert.equal(extractExecutions, 1);
  assert.deepEqual(resumedExtract.value, { rows: 5, artifact_uri: "cas:sha256:variants-fixture" });

  const scored = await runJobStepWithCheckpoint(conn, {
    runId: "dogfood-workflow",
    stepId: "score/high-impact",
    recordedAt: "2026-07-06T12:00:03.000Z",
    source: "bring-it-home-dogfood",
    replayDigest: REPLAY_DIGEST,
    attempt: 1,
    run: () => ({ candidates: 2, upstream_checkpoint: jobStepCheckpointKey("dogfood-workflow", "extract/variants") }),
  });
  assert.equal(scored.reused, false);
  assert.equal((await readJobStepCheckpoint(conn, "dogfood-workflow", "score/high-impact"))?.value.candidates, 2);

  const profileReceipt = ducknngHttpProfileReceiptFromInfo({
    profileId: "clinvar-read-dogfood",
    scheme: "https",
    host: "api.example.test",
    port: 443,
    hasPort: true,
    pathPrefix: "/v1/clinvar",
    method: "GET",
    tlsRequired: true,
    authHeaderNamesJson: "[\"Authorization\"]",
    version: 1n,
    createdMs: 1783283000000n,
    updatedMs: 1783283060000n,
    expiresAtMs: 1783286600000n,
    allowSubjectsJson: "[\"case:alpha\",\"case:beta\"]",
  });
  assert.match(profileReceipt.policyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(profileReceipt), /Bearer|token|secret|case:alpha|case:beta/i);
  await recordObservation(conn, {
    statementKey: `ducknng-profile:${profileReceipt.profileId}`,
    subjectId: `ducknng-profile:${profileReceipt.profileId}`,
    predicate: "ducknng_http_profile_receipt",
    value: profileReceipt,
    recordedAt: NOW,
    source: "bring-it-home-dogfood",
    digest: profileReceipt.policyDigest,
  });

  await conn.run(`
    CREATE TABLE external_kg_raw(subject TEXT, predicate TEXT, object TEXT);
    INSERT INTO external_kg_raw VALUES
      ('MONDO:0004766', 'rdfs:subClassOf', 'MONDO:0004784'),
      ('MONDO:0004784', 'rdfs:subClassOf', 'MONDO:0004979'),
      ('HP:0001250', 'biolink:related_to', 'MONDO:0004766');
  `);
  const externalProjection = await materializeGraphProjectionProfile(conn, {
    schema: "pi-bio.graph_projection_profile.v1",
    id: "dogfood-external-kg",
    title: "Dogfood external KG projection",
    source: { kind: "external_kg", table: "external_kg_raw" },
    columns: { from: "subject", predicate: "predicate", to: "object" },
    closure: { source: "local_cte", transitivePredicates: ["rdfs:subClassOf"] },
    target: { edgesTable: "dogfood_external_edges", closureTable: "dogfood_external_entailed" },
    provenance: [{ source: "scripts/bring-it-home-dogfood.mjs", deid: "not_applicable" }],
  });
  assert.equal(externalProjection.edgeCount, 3);
  assert.equal(externalProjection.closureCount, 3);

  await materializeBioEdgesAsOf(conn, LATER);
  const internalProjection = await materializeGraphProjectionProfile(conn, {
    schema: "pi-bio.graph_projection_profile.v1",
    id: "dogfood-internal-observation-graph",
    title: "Dogfood internal observation graph projection",
    source: { kind: "observations", table: "bio_edges_as_of" },
    columns: { from: "from_id", predicate: "predicate", to: "to_id", attrs: "attrs", trust: "trust" },
    closure: { source: "local_cte", transitivePredicates: ["depends_on"] },
    target: {
      edgesTable: "dogfood_internal_edges",
      closureTable: "dogfood_internal_entailed",
      temporal: { kind: "as_of", asOf: LATER },
    },
    provenance: [{ source: "bio_observations", deid: "unknown" }],
  });
  assert.equal(internalProjection.edgeCount, 4);
  assert.equal(internalProjection.closureCount, 3);

  const reportDeps = await conn.all(`
    SELECT to_id FROM dogfood_internal_entailed
    WHERE from_id = 'workflow:dogfood:step:report' AND predicate = 'depends_on'
    ORDER BY to_id
  `);
  assert.deepEqual(reportDeps.map((r) => r.to_id), [
    "workflow:dogfood:step:extract",
    "workflow:dogfood:step:score",
  ]);

  const checkpointRow = await observationAsOfKey(
    conn,
    jobStepCheckpointKey("dogfood-workflow", "extract/variants"),
    "9999-12-31T23:59:59.999Z",
  );
  assert.ok(checkpointRow);

  const counts = await conn.all(`
    SELECT predicate, count(*) AS n
    FROM bio_observations
    GROUP BY predicate
    ORDER BY predicate
  `);
  const summary = {
    dogfood: "bring-it-home",
    hostEventLinks: hostEvent.linkObservationIds.length,
    jobStepExecutions: { extract: extractExecutions, extractReused: resumedExtract.reused },
    checkpointKey: checkpointRow.statement_key,
    ducknngProfileReceipt: {
      profileId: profileReceipt.profileId,
      policyDigest: profileReceipt.policyDigest,
      subjectRestriction: profileReceipt.subjectRestriction,
    },
    externalProjection,
    internalProjection,
    observationCounts: Object.fromEntries(counts.map((r) => [r.predicate, asNumber(r.n)])),
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  raw.closeSync?.();
  instance.closeSync?.();
}
