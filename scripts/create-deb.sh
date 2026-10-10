#!/usr/bin/env bash
# Backward-compatible entry point for the native Ubuntu/Debian build.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bash "$SCRIPT_DIR/build-linux.sh" --format deb "$@"
