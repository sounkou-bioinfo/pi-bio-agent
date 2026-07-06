import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA,
  ducknngHttpProfileReceiptFromInfo,
  type DucknngHttpProfileInfo,
} from "../src/duckdb/http-profiles.js";

describe("ducknng HTTP profile receipts", () => {
  test("project list output into a stable, secret-free receipt", () => {
    const info: DucknngHttpProfileInfo = {
      profileId: "clinvar-read",
      scheme: "https",
      host: "api.example.test",
      port: 443,
      hasPort: true,
      pathPrefix: "/v1/clinvar",
      method: "GET",
      tlsRequired: true,
      authHeaderNamesJson: "[\"Authorization\"]",
      version: 7n,
      createdMs: 1783283000000n,
      updatedMs: 1783283060000n,
      expiresAtMs: 1783286600000n,
      allowSubjectsJson: "[\"case:alpha\",\"case:beta\"]",
    };

    const receipt = ducknngHttpProfileReceiptFromInfo(info);
    assert.equal(receipt.schema, DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA);
    assert.deepEqual(receipt.scope, {
      scheme: "https",
      host: "api.example.test",
      port: 443,
      pathPrefix: "/v1/clinvar",
      method: "GET",
      tlsRequired: true,
    });
    assert.deepEqual(receipt.authHeaderNames, ["Authorization"]);
    assert.equal(receipt.version, "7");
    assert.equal(receipt.expiresAtMs, "1783286600000");
    assert.equal(receipt.subjectRestriction.restricted, true);
    assert.equal(receipt.subjectRestriction.count, 2);
    assert.match(receipt.subjectRestriction.digest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.match(receipt.policyDigest, /^sha256:[0-9a-f]{64}$/);

    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /Bearer|token|secret|case:alpha|case:beta/i);
  });

  test("omits default ports and absent subject restrictions from the receipt", () => {
    const receipt = ducknngHttpProfileReceiptFromInfo({
      profileId: "public-ish",
      scheme: "https",
      host: "api.example.test",
      port: null,
      hasPort: false,
      pathPrefix: "/",
      method: "*",
      tlsRequired: false,
      authHeaderNamesJson: "[\"X-Api-Key\"]",
      version: 1n,
      createdMs: 1783283000000n,
      updatedMs: 1783283000000n,
      expiresAtMs: 0n,
      allowSubjectsJson: null,
    });

    assert.equal(receipt.scope.port, null);
    assert.equal(receipt.expiresAtMs, null);
    assert.deepEqual(receipt.subjectRestriction, { restricted: false, count: 0 });
  });
});
