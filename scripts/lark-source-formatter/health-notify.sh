#!/usr/bin/env bash
# lark-health-check source wrapper: pipe health-check stdout through the
# JSONRPC shim. Each `[health-check] <ts> <service> <status> (bus_pid=...)`
# line becomes a JSON-RPC 2.0 notification with type=health.report.
#
# The companion script `scripts/lark-health-check/run.sh` does the actual
# health probe (calls `lark-cli auth status` etc.) and emits the
# `[health-check]` lines on stdout. We re-run it here and pipe its output.
#
# Used by `d-pi create_source` as the source command:
#   command: sh
#   args:    ["/path/to/pi-mono-shallow/scripts/lark-source-formatter/health-notify.sh"]
#
# Paths are computed from this script's location so the wrapper works
# from any checkout (worktree, npm-link, /tmp/...-release, etc.). The
# shim is invoked via `tsx` from the workspace's node_modules — the
# repository installs `tsx` as a top-level devDependency, and the
# shim is TypeScript source so it needs the loader.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HEALTH_SCRIPT_DEFAULT="${REPO_ROOT}/scripts/lark-health-check/run.sh"
SHIM="${REPO_ROOT}/packages/d-pi/src/sources/lark-health-shim.ts"
TSX="${REPO_ROOT}/node_modules/.bin/tsx"

# Allow overriding the health-check script (tests use this to inject a
# mock that emits a known [health-check] line). Default: the real script
# under scripts/lark-health-check/run.sh. Falls back to `cat` if the
# default script is missing (with a warning), so the wrapper remains
# invokable in minimal environments.
HEALTH_SCRIPT="${HEALTH_SCRIPT:-${HEALTH_SCRIPT_DEFAULT}}"

if [[ ! -x "${TSX}" ]]; then
	echo "[health-notify.sh] tsx not found at ${TSX}; run 'npm install' at the repo root." >&2
	exit 1
fi
if [[ ! -f "${SHIM}" ]]; then
	echo "[health-notify.sh] shim not found at ${SHIM}; the d-pi sources dir is missing." >&2
	exit 1
fi
if [[ ! -f "${HEALTH_SCRIPT}" ]]; then
	echo "[health-notify.sh] health-check script not found at ${HEALTH_SCRIPT}; will use 'cat' (will hang without input)." >&2
	HEALTH_SCRIPT="cat"
fi

exec sh "${HEALTH_SCRIPT}" \
	| "${TSX}" "${SHIM}"