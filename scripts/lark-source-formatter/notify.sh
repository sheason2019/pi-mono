#!/usr/bin/env bash
# lark-im source wrapper: pipe lark-cli events through the JSONRPC shim.
#
# Output is one JSON-RPC 2.0 notification per line (see
# packages/d-pi/src/sources/lark-im-shim.ts). The hub's source-validator
# parses each line and forwards only notifications to subscribed agents.
#
# Used by `d-pi create_source` as the source command:
#   command: sh
#   args:    ["/path/to/pi-mono-shallow/scripts/lark-source-formatter/notify.sh"]
#
# Paths are computed from this script's location so the wrapper works
# from any checkout (worktree, npm-link, /tmp/...-release, etc.). The
# shim is invoked via `tsx` from the workspace's node_modules — the
# repository installs `tsx` as a top-level devDependency, and the
# shim is TypeScript source so it needs the loader.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SHIM="${REPO_ROOT}/packages/d-pi/src/sources/lark-im-shim.ts"
TSX="${REPO_ROOT}/node_modules/.bin/tsx"

# Allow overriding the upstream lark-cli binary (tests use this to inject
# a mock that emits a known NDJSON line). Default: `lark-cli` on PATH.
LARK_CLI_BIN="${LARK_CLI_BIN:-lark-cli}"

if [[ ! -x "${TSX}" ]]; then
	echo "[notify.sh] tsx not found at ${TSX}; run 'npm install' at the repo root." >&2
	exit 1
fi
if [[ ! -f "${SHIM}" ]]; then
	echo "[notify.sh] shim not found at ${SHIM}; the d-pi sources dir is missing." >&2
	exit 1
fi

exec "${LARK_CLI_BIN}" event consume im.message.receive_v1 --as bot \
	| "${TSX}" "${SHIM}"