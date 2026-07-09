#!/usr/bin/env bash
set -euo pipefail

# Provision the reviewed ducknng sibling commit that supplies the transport capabilities exercised here.
# The resulting `.duckdb_extension` is UNSIGNED, so the host loads it with `allow_unsigned_extensions = true`
# (host-owned duckdbConfig) — see docs/refinments.md (the signing flip).
#
# Resolution order (first that verifies wins):
#   1. $DUCKNNG_EXT_PREBUILT  — a .duckdb_extension you already built (escape hatch / CI cache).
#   2. an already-provisioned ext at the output path (idempotent; re-run with --force to refresh).
#   3. build the pinned owned commit from a ducknng checkout ($DUCKNNG_DIR, default .pi/src/ducknng).
# Verification requires retry, subject-scoped HTTP profiles, upload, TLS, and RPC; a stale binary falls through.
#
# Usage:  scripts/provision-ducknng-owned.sh [--force]
# Env:    DUCKNNG_DIR (checkout to build from), DUCKNNG_EXT_PREBUILT (skip to verify), DUCKNNG_OUT (output dir).

REPO="sounkou-bioinfo/ducknng"
DUCKNNG_COMMIT="${DUCKNNG_COMMIT:-395ed5cc88a90e2e6a6d1cd58d9943e0be85374c}"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${DUCKNNG_OUT:-$HERE/.pi/ducknng}"
mkdir -p "$OUT_DIR"

# --- target DuckDB version from the pinned @duckdb/node-api (e.g. "1.5.2-r.2" -> "1.5.2") ---
DUCKDB_VER="$(node -e 'process.stdout.write(require("@duckdb/node-api/package.json").version.replace(/-.*$/,""))')"
# DuckDB derives the extension's init symbol from the file BASENAME, so it must stay `ducknng.duckdb_extension`;
# version the DIRECTORY instead.
EXT_OUT="$OUT_DIR/duckdb-${DUCKDB_VER}/ducknng.duckdb_extension"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  PLATFORM="linux_amd64" ;;
  Linux-aarch64) PLATFORM="linux_arm64" ;;
  Darwin-arm64)  PLATFORM="osx_arm64" ;;
  Darwin-x86_64) PLATFORM="osx_amd64" ;;
  *) PLATFORM="unknown" ;;
esac
echo "==> target: DuckDB ${DUCKDB_VER}, platform ${PLATFORM}, ducknng ${DUCKNNG_COMMIT}"

place() { mkdir -p "$(dirname "$EXT_OUT")"; cp -f "$1" "$EXT_OUT"; echo "==> provisioned: $EXT_OUT"; }

provisioned() {
  if [ "$FORCE" = "0" ] && [ -f "$EXT_OUT" ]; then echo "==> already provisioned (use --force to refresh): $EXT_OUT"; return 0; fi
  return 1
}

from_prebuilt() {
  [ -n "${DUCKNNG_EXT_PREBUILT:-}" ] || return 1
  [ -f "$DUCKNNG_EXT_PREBUILT" ] || { echo "!! DUCKNNG_EXT_PREBUILT set but not a file: $DUCKNNG_EXT_PREBUILT" >&2; return 1; }
  echo "==> using DUCKNNG_EXT_PREBUILT"; place "$DUCKNNG_EXT_PREBUILT"
}

from_source() {
  local dir="${DUCKNNG_DIR:-$HERE/.pi/src/ducknng}"
  if [ ! -d "$dir/.git" ]; then
    echo "==> cloning ${REPO} -> $dir"; git clone "https://github.com/${REPO}.git" "$dir"
  fi
  echo "==> building pinned commit ${DUCKNNG_COMMIT} in $dir"
  ( cd "$dir"
    git fetch --quiet origin "$DUCKNNG_COMMIT"
    git checkout --quiet --detach "$DUCKNNG_COMMIT"
    git submodule update --init --recursive --quiet
    make configure >/dev/null
    make release -j"$(nproc 2>/dev/null || echo 2)" )
  place "$dir/build/release/ducknng.duckdb_extension"
}

verify() {
  echo "==> verifying ${EXT_OUT}"
  node --input-type=module -e "
    import { DuckDBInstance } from '@duckdb/node-api';
    const c = await (await DuckDBInstance.create(':memory:', { allow_unsigned_extensions: 'true' })).connect();
    await c.run(\"LOAD '${EXT_OUT}'\");
    const sql = \"SELECT function_name, stability, array_length(parameter_types) AS arity FROM duckdb_functions() WHERE function_name IN ('ducknng__ncurl_row','ducknng_register_http_profile','ducknng_upload_table','ducknng_self_signed_tls_config','ducknng_start_server','ducknng_query_rpc','ducknng_get_rpc_manifest','ducknng_set_service_peer_allowlist')\";
    const rows = (await c.runAndReadAll(sql)).getRowObjects();
    const names = new Set(rows.map((row) => String(row.function_name)));
    const retry = rows.find((row) => row.function_name === 'ducknng__ncurl_row');
    if (!retry || retry.stability !== 'VOLATILE') { console.error('!! ducknng__ncurl_row not VOLATILE — this build lacks the retry backport'); process.exit(1); }
    if (!rows.some((row) => row.function_name === 'ducknng_register_http_profile' && Number(row.arity) === 11)) { console.error('!! ducknng HTTP profiles lack the allow-subjects overload'); process.exit(1); }
    const required = ['ducknng_upload_table','ducknng_self_signed_tls_config','ducknng_start_server','ducknng_query_rpc','ducknng_get_rpc_manifest','ducknng_set_service_peer_allowlist'];
    const missing = required.filter((name) => !names.has(name));
    if (missing.length) { console.error('!! owned ducknng build lacks required functions:', missing.join(', ')); process.exit(1); }
    console.log('==> OK: retry, subject-scoped HTTP profiles, upload, TLS, and RPC functions are present');
  "
}

if provisioned && verify; then
  :
elif from_prebuilt && verify; then
  :
else
  from_source
  verify
fi
cat <<EOF

Load it in pi-bio-agent (host-owned config — the build is unsigned):
  duckdbConfig: { allow_unsigned_extensions: "true" }
  duckdbInitSql: ["LOAD '${EXT_OUT}'"]
Then probe duckdb_functions() for ducknng__ncurl_row to enable the recursive-CTE retry path.
EOF
