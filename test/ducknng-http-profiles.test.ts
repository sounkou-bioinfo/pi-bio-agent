import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SqlConn } from "../src/core/ports.js";
import {
  DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA,
  ducknngHttpProfileReceiptFromInfo,
  refreshDucknngHttpProfile,
  type DucknngHttpProfileInfo,
} from "../src/duckdb/http-profiles.js";

class FakeDucknngProfileConn implements SqlConn {
  readonly sqlSeen: string[] = [];
  readonly authValuesSeen: string[] = [];
  private readonly profiles = new Map<string, {
    profile_id: string;
    scheme: string;
    host: string;
    port: number | null;
    has_port: boolean;
    path_prefix: string;
    method: string;
    tls_required: boolean;
    auth_header_names_json: string;
    version: bigint;
    created_ms: bigint;
    updated_ms: bigint;
    expires_at_ms: bigint;
    allow_subjects_json: string | null;
  }>();
  private nowMs = 1783283000000n;

  constructor(private readonly supportsSubjectProfiles = true) {}

  async run(): Promise<void> {
    throw new Error("FakeDucknngProfileConn.run is not used by this test");
  }

  async all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    this.sqlSeen.push(sql);
    if (sql.includes("duckdb_functions()")) return [{ n: this.supportsSubjectProfiles ? 1n : 0n }] as T[];
    if (sql.includes("ducknng_list_http_profiles()")) return [...this.profiles.values()].map((row) => ({ ...row })) as T[];
    if (sql.includes("ducknng_register_http_profile")) {
      if (!params || params.length < 9) throw new Error("ducknng_register_http_profile fake received too few params");
      const profileId = String(params[0]);
      const existing = this.profiles.get(profileId);
      const createdMs = existing?.created_ms ?? this.tick();
      const updatedMs = existing ? this.tick() : createdMs;
      const expiresAtMs = params.length >= 10 ? BigInt(params[9] as number | bigint) : 0n;
      const allowSubjectsJson = params.length >= 11 ? String(params[10]) : null;
      this.authValuesSeen.push(String(params[8]));
      this.profiles.set(profileId, {
        profile_id: profileId,
        scheme: String(params[1]),
        host: String(params[2]),
        port: params[3] == null ? null : Number(params[3]),
        has_port: params[3] != null,
        path_prefix: String(params[4]),
        method: String(params[5]),
        tls_required: Boolean(params[6]),
        auth_header_names_json: JSON.stringify([String(params[7])]),
        version: (existing?.version ?? 0n) + 1n,
        created_ms: createdMs,
        updated_ms: updatedMs,
        expires_at_ms: expiresAtMs,
        allow_subjects_json: allowSubjectsJson,
      });
      return [{ ok: true }] as T[];
    }
    throw new Error(`FakeDucknngProfileConn does not implement SQL: ${sql}`);
  }

  private tick(): bigint {
    this.nowMs += 1000n;
    return this.nowMs;
  }

  profileRow(profileId: string): { allow_subjects_json: string | null } | undefined {
    const row = this.profiles.get(profileId);
    return row ? { allow_subjects_json: row.allow_subjects_json } : undefined;
  }
}

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
      allowSubjectsJson: "[\"case:beta\",\"case:alpha\",\"case:alpha\"]",
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
    assert.equal(receipt.subjectRestriction.digest, ducknngHttpProfileReceiptFromInfo({ ...info, allowSubjectsJson: "[\"case:alpha\",\"case:beta\"]" }).subjectRestriction.digest);
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

  test("refresh commissions and rotates profiles through upserted secret-free receipts", async () => {
    const conn = new FakeDucknngProfileConn();
    const first = await refreshDucknngHttpProfile(conn, {
      profileId: "clinvar-read",
      scheme: "https",
      host: "api.example.test",
      port: 443,
      pathPrefix: "/v1/clinvar",
      method: "GET",
      tlsRequired: true,
      authHeaderName: "Authorization",
      authHeaderValue: "Bearer secret-one",
      expiresAtMs: 1783286600000,
      allowSubjects: ["case:beta", "case:alpha", "case:alpha"],
    });

    assert.equal(first.created, true);
    assert.equal(first.receiptChanged, true);
    assert.equal(first.previous, undefined);
    assert.equal(first.current.version, "1");
    assert.equal(first.current.scope.host, "api.example.test");
    assert.equal(first.current.subjectRestriction.restricted, true);
    assert.equal(first.current.subjectRestriction.count, 2);
    assert.deepEqual(conn.profileRow("clinvar-read"), { allow_subjects_json: "[\"case:alpha\",\"case:beta\"]" });
    assert.deepEqual(conn.authValuesSeen, ["Bearer secret-one"]);

    const second = await refreshDucknngHttpProfile(conn, {
      profileId: "clinvar-read",
      scheme: "https",
      host: "api.example.test",
      port: 443,
      pathPrefix: "/v1/clinvar",
      method: "GET",
      tlsRequired: true,
      authHeaderName: "Authorization",
      authHeaderValue: "Bearer secret-two",
      expiresAtMs: 1783287200000,
      allowSubjects: ["case:alpha", "case:beta"],
    });

    assert.equal(second.created, false);
    assert.equal(second.receiptChanged, true);
    assert.equal(second.previous?.policyDigest, first.current.policyDigest);
    assert.equal(second.current.version, "2");
    assert.equal(second.current.createdMs, first.current.createdMs);
    assert.notEqual(second.current.updatedMs, first.current.updatedMs);
    assert.notEqual(second.current.expiresAtMs, first.current.expiresAtMs);
    assert.notEqual(second.current.policyDigest, first.current.policyDigest);
    assert.deepEqual(conn.authValuesSeen, ["Bearer secret-one", "Bearer secret-two"]);

    const serialized = JSON.stringify(second);
    assert.doesNotMatch(serialized, /secret-one|secret-two|Bearer|case:alpha|case:beta/i);
    assert.doesNotMatch(conn.sqlSeen.join("\n"), /secret-one|secret-two|Bearer/i);
  });

  test("refresh preserves the allowSubjects extension gate", async () => {
    const conn = new FakeDucknngProfileConn(false);
    await assert.rejects(
      () => refreshDucknngHttpProfile(conn, {
        profileId: "clinvar-read",
        scheme: "https",
        host: "api.example.test",
        port: 443,
        pathPrefix: "/v1/clinvar",
        method: "GET",
        tlsRequired: true,
        authHeaderName: "Authorization",
        authHeaderValue: "Bearer secret-one",
        allowSubjects: ["case:alpha"],
      }),
      /allowSubjects requires ducknng_register_http_profile/,
    );
    assert.equal(conn.authValuesSeen.length, 0);
  });
});
