#!/usr/bin/env bash
# Flutter web dev on Chrome with a PINNED port: a stable origin means SecureStore /
# localStorage persist across restarts. Do not run `flutter run -d chrome` without --web-port.
set -euo pipefail
cd "$(dirname "$0")/../apps/mobile"
exec flutter run -d chrome --web-port "${WEB_PORT:-8090}"
