#!/bin/bash
# Build a universal, ad-hoc-signed app and package it as macos/build/MarkdownStudio-<version>.dmg.
# Usage: macos/package_dmg.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/build.sh" --universal

APP="$HERE/build/Markdown Studio.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$HERE/Info.plist")"
DMG="$HERE/build/MarkdownStudio-$VERSION.dmg"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Markdown Studio.app"   # ditto keeps the signature intact
ln -s /Applications "$STAGE/Applications"

rm -f "$DMG"
hdiutil create -volname "Markdown Studio" -srcfolder "$STAGE" -format UDZO -ov "$DMG" >/dev/null

echo "$DMG"
shasum -a 256 "$DMG"
