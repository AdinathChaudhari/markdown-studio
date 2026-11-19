# Markdown Studio for macOS

A thin AppKit shell around the system `WKWebView`, loading the single-file
`markdown-studio.html` bundled as a resource. One `NSDocument` (one window) per file.
No Electron, no packages. The app's own code makes no network requests; https images referenced by a document load like in a browser (`img-src https:`).

## Build and run

```sh
macos/build.sh              # -> macos/build/Markdown Studio.app (ad-hoc signed, git-ignored)
macos/build.sh --selftest   # also runs the headless open -> edit -> save check
open "macos/build/Markdown Studio.app"
```

`build.sh` runs `build.py` with `$PYTHON` if set, else `~/.venvs/main/bin/python` if it exists, else `python3`.

Headless check (needs a logged-in GUI session; prints one JSON line, exit 0/1):

```sh
"macos/build/Markdown Studio.app/Contents/MacOS/MarkdownStudio" --selftest in.md out.md
```

## Shortcuts (the native menu owns every one; app.js skips its own in the app)

| Keys | Action |
|---|---|
| ⌘N / ⌘O / ⌘W | New / Open / Close |
| ⌘S / ⇧⌘S | Save (same file) / Save As |
| ⌘P | Print |
| ⌘Z / ⇧⌘Z, ⌘X ⌘C ⌘V ⌘A | Undo, Redo, clipboard, Select All |
| ⌘F / ⌘G / ⇧⌘G | Find in Page (WKWebView searches the whole page, editor and preview), next, previous |
| ⌥⌘C | Copy rendered HTML |
| ⌘B ⌘I ⌘K | Bold, Italic, Link |
| ⌘1 ⌘2 ⌘3, ⌘\ | Editor / Split / Reader, cycle |
| ⇧⌘O, ⌘/ | Outline, cycle theme |

JS still owns Tab, Shift-Tab, Enter, Esc and `?`.

## Security

The page is served with a Content-Security-Policy whose `script-src` is the SHA-256 of the one inline script (computed in `SchemeHandler` from the bytes served), so raw HTML in a document (`onerror=`, injected `<script>`, `javascript:` links) cannot run or reach the native bridge. The message handler also accepts messages only from the top frame at `mdstudio://app`.

## Known limits

- Line endings: the dominant ending (CRLF, CR or LF) and a UTF-8 BOM are detected on read and restored on save; the editor itself works in LF. Mixed-ending files are saved with their dominant ending.
- If the editor fails to load a file, Save is refused ("not loaded") so the file is never overwritten with an empty document.
- `build.sh` builds for the host architecture (`uname -m`: arm64 or x86_64), not universal.
- No crash recovery: unsaved edits are lost if the app crashes. If only the web-content process dies, the page reloads and re-pushes the last saved text, silently discarding unsaved edits (preflight F4, not fixed).
- Theme/mode are read at window creation; other open windows repaint on reopen.
- Relative images resolve only from the document's folder and below (not `../`); untitled docs load none.
- Undo/Redo menu items call `document.execCommand` because WKWebView does not answer `undo:`/`redo:`.
- `lsregister` points LaunchServices at `macos/build/`; rebuild after moving it.
