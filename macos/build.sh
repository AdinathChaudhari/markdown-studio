#!/bin/bash
# Build "Markdown Studio.app" into macos/build/. Usage: macos/build.sh [--selftest]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# Python for build.py: $PYTHON if set, else ~/.venvs/main/bin/python if present, else python3.
if [ -n "${PYTHON:-}" ]; then PY="$PYTHON"
elif [ -x "$HOME/.venvs/main/bin/python" ]; then PY="$HOME/.venvs/main/bin/python"
else PY="$(command -v python3 || true)"; fi
APP="$HERE/build/Markdown Studio.app"
EXE="$APP/Contents/MacOS/MarkdownStudio"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ -n "$PY" ] && command -v "$PY" >/dev/null 2>&1 || { echo "no Python found (set PYTHON=/path/to/python)" >&2; exit 1; }
(cd "$ROOT" && "$PY" build.py)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

xcrun swift "$HERE/make_icon.swift" "$TMP/AppIcon.iconset"
iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

# Builds for the host architecture (arm64 or x86_64), not universal.
xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  -module-name MarkdownStudio -framework Cocoa -framework WebKit \
  "$HERE"/Sources/*.swift -o "$EXE"

cp "$ROOT/markdown-studio.html" "$APP/Contents/Resources/markdown-studio.html"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"

codesign --force -s - "$APP"
"$LSREG" -f "$APP" || true
echo "$APP"

if [ "${1:-}" = "--selftest" ]; then
  OUTDIR="$(mktemp -d)"
  set +e
  "$EXE" --selftest "$ROOT/samples/demo.md" "$OUTDIR/out.md"
  rc=$?
  set -e
  exit $rc
fi
