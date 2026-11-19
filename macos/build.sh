#!/bin/bash
# Build "Markdown Studio.app" into macos/build/. Usage: macos/build.sh [--universal] [--selftest]
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

UNIVERSAL=0; SELFTEST=0
for a in "$@"; do
  case "$a" in
    --universal) UNIVERSAL=1 ;;
    --selftest) SELFTEST=1 ;;
    *) echo "unknown flag: $a (use --universal, --selftest)" >&2; exit 2 ;;
  esac
done

[ -n "$PY" ] && command -v "$PY" >/dev/null 2>&1 || { echo "no Python found (set PYTHON=/path/to/python)" >&2; exit 1; }
(cd "$ROOT" && "$PY" build.py)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

xcrun swift "$HERE/make_icon.swift" "$TMP/AppIcon.iconset"
iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

# Host architecture by default; --universal builds arm64 + x86_64 and lipo-merges them.
compile() { # $1 = arch, $2 = output
  xcrun swiftc -O -swift-version 5 -target "$1-apple-macos13.0" \
    -module-name MarkdownStudio -framework Cocoa -framework WebKit \
    "$HERE"/Sources/*.swift -o "$2"
}
if [ "$UNIVERSAL" = 1 ]; then
  compile arm64 "$TMP/exe-arm64"
  compile x86_64 "$TMP/exe-x86_64"
  lipo -create "$TMP/exe-arm64" "$TMP/exe-x86_64" -output "$EXE"
else
  compile "$(uname -m)" "$EXE"
fi

cp "$ROOT/markdown-studio.html" "$APP/Contents/Resources/markdown-studio.html"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"

codesign --force -s - "$APP"
"$LSREG" -f "$APP" || true
echo "$APP"

if [ "$SELFTEST" = 1 ]; then
  OUTDIR="$(mktemp -d)"
  set +e
  "$EXE" --selftest "$ROOT/samples/demo.md" "$OUTDIR/out.md"
  rc=$?
  set -e
  exit $rc
fi
