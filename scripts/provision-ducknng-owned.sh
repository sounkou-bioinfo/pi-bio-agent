#!/usr/bin/env bash
set -euo pipefail

# Provision an OWNED ducknng build for pi-bio-agent — the per-DuckDB-version backport that the community build
# does NOT carry (community-extensions does no backports). The build with the volatile-scalar `ncurl` fix
# (`ducknng__ncurl_row`, recursive-CTE retry that re-fires per iteration) lives on `release/duckdb-<ver>` and is
# published as the tag `v0.1.1+duckdb<ver>`. The resulting `.duckdb_extension` is UNSIGNED, so the host loads it
# with `allow_unsigned_extensions = true` (host-owned duckdbConfig) — see docs/refinments.md (the signing flip).
#
# Resolution order (first that works wins):
#   1. $DUCKNNG_EXT_PREBUILT  — a .duckdb_extension you already built (escape hatch / CI cache).
#   2. an already-provisioned ext at the output path (idempotent; re-run with --force to refresh).
#   3. `gh release download v0.1.1+duckdb<ver>` from the ducknng repo (the tagged binary, when published).
#   4. build `release/duckdb-<ver>` from a ducknng checkout ($DUCKNNG_DIR, default ~/ducknng or a fresh clone).
# It then VERIFIES the result loads and exposes `ducknng__ncurl_row` as VOLATILE, and prints the LOAD recipe.
#
# Usage:  scripts/provision-ducknng-owned.sh [--force]
# Env:    DUCKNNG_DIR (checkout to build from), DUCKNNG_EXT_PREBUILT (skip to verify), DUCKNNG_OUT (output dir).

REPO="sounkou-bioinfo/ducknng"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${DUCKNNG_OUT:-$HERE/.pi/ducknng}"
mkdir -p "$OUT_DIR"

# --- target DuckDB version from the pinned @duckdb/node-api (e.g. "1.5.2-r.2" -> "1.5.2") ---
DUCKDB_VER="$(node -e 'process.stdout.write(require("@duckdb/node-api/package.json").version.replace(/-.*$/,""))')"
TAG="v0.1.1+duckdb${DUCKDB_VER}"
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
echo "==> target: DuckDB ${DUCKDB_VER}, platform ${PLATFORM}, tag ${TAG}"

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

from_release() {
  command -v gh >/dev/null 2>&1 || { echo "==> gh not available; skipping release download"; return 1; }
  local tmp; tmp="$(mktemp -d)"
  echo "==> trying release asset ${TAG} (${PLATFORM})"
  if gh release download "$TAG" --repo "$REPO" --pattern "*${PLATFORM}*ducknng*.duckdb_extension" --dir "$tmp" 2>/dev/null; then
    local f; f="$(find "$tmp" -name '*.duckdb_extension' | head -1)"
    [ -n "$f" ] && { place "$f"; rm -rf "$tmp"; return 0; }
  fi
  rm -rf "$tmp"; echo "==> no published asset for ${TAG} yet (the binary-release workflow may not have run)"; return 1
}

from_source() {
  local dir="${DUCKNNG_DIR:-$HOME/ducknng}"
  if [ ! -d "$dir/.git" ]; then
    echo "==> cloning ${REPO} -> $dir"; git clone "https://github.com/${REPO}.git" "$dir"
  fi
  echo "==> building release/duckdb-${DUCKDB_VER} in $dir"
  ( cd "$dir"
    git fetch --quiet origin "release/duckdb-${DUCKDB_VER}"
    git checkout --quiet "release/duckdb-${DUCKDB_VER}" 2>/dev/null || git checkout --quiet -b "release/duckdb-${DUCKDB_VER}" "origin/release/duckdb-${DUCKDB_VER}"
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
    const r = (await c.runAndReadAll(\"SELECT function_type, stability FROM duckdb_functions() WHERE function_name='ducknng__ncurl_row'\")).getRows();
    if (!r.length || r[0][1] !== 'VOLATILE') { console.error('!! ducknng__ncurl_row not VOLATILE — this build lacks the backport'); process.exit(1); }
    console.log('==> OK: ducknng__ncurl_row is', r[0][1], '(recursive-CTE retry available)');
  "
}

provisioned || from_prebuilt || from_release || from_source
verify
cat <<EOF

Load it in pi-bio-agent (host-owned config — the build is unsigned):
  duckdbConfig: { allow_unsigned_extensions: "true" }
  duckdbInitSql: ["LOAD '${EXT_OUT}'"]
Then probe duckdb_functions() for ducknng__ncurl_row to enable the recursive-CTE retry path.
EOF
