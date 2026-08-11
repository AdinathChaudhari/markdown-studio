# markdown-studio

A markdown viewer / reader / editor that ships as **one** HTML file:
`markdown-studio.html`. Tables, LaTeX and a light/dark toggle, with zero
runtime dependencies.

- `README.md` — what it is and how to run it.
- `CONTRACT.md` — the frozen seams between the source files. Read it before
  touching anything under `src/`; the split exists so several authors never edit
  one file, and every id, signature and token name in it is load-bearing.

## Layout and the build order

`src/theme.css` (tokens) + `app.css` (chrome) + `markdown.css` (rendered
typography) → `/*__CSS__*/`. `src/markdown.js` (`window.MD`) + `tex.js`
(`window.TeX`) + `default_doc.js` (`window.DEFAULT_DOC`) + `app.js`
(`window.__mdstudio`) → `/*__JS__*/`. `build.py` does the inlining and nothing
else — no minifier, no bundler.

**The JS order is behaviour, not style.** `app.js` reads all three of the other
globals at boot, so it comes last. Each file is an IIFE assigning exactly one
global; they are concatenated into a single classic `<script>`, so ES module
syntax anywhere breaks the whole page.

**The build output sits at the repo root, not in `dist/`.** It is the deliverable
and the thing a visitor is looking for, so it is the first file in the listing and
one click from a raw download. `build.py`'s `OUT` and the `DIST` constant in
`tests/browser_smoke.py` and `tests/test_ui.py` all point there — change one and
you must change all three, or the browser suites silently skip.

`src/default_doc.js` is **generated** from `samples/demo.md` by
`tools/gen_default_doc.py`, which `build.py` calls on every run. Never hand-edit
it — edit the markdown. The demo doubles as the visual test fixture, which is why
it exercises every feature including three tables and a deliberately malformed
formula.

## Hard rules

- **No external anything, ever.** No CDN, no web font, no `fetch`, no
  `@import`, no remote image. The artefact must render from `file://` with the
  network off. Proven, not assumed: `tests/browser_smoke.py` and the confirm
  pass load the page with every non-`file://` request aborted and assert the
  tables and all 16 formulas still paint. Zero requests are even attempted.
- **URL rewriting and escaping happen at render time.** `MD.render` escapes
  every text node and attribute and neutralises `javascript:`/`vbscript:`/
  non-image `data:` targets. Raw HTML is passed through deliberately — this is a
  reader for the user's own files — so do not describe it as sanitised.
- **`TeX.toMathML` never throws.** Its top level is wrapped; a structural
  failure returns the `md-math-error` span. An unknown command is *not* a
  failure: it becomes `md-tex-unknown` and the rest of the formula compiles. One
  typo must not blank a page.
- **`MD.render` is deterministic** — same input, byte-identical output. The slug
  counter, reference map and footnote list all reset per call. There is a test
  that renders twice and diffs.

## Traps that cost real time

1. **Extract math before anything else, and mask it against code.** `$a_1 * b$`
   loses its underscore and asterisk to the emphasis pass otherwise. Math is
   lifted to placeholder tokens in step 2 of the pipeline and substituted back at
   the very end. The placeholders must never be substituted inside raw-text HTML
   blocks or a tag interior, and a `$` inside a code span or fence is never math.
   `$5 and $10` must stay a price, not a formula.
2. **An unbalanced `$$`, `\[` or `\(` used to swallow the rest of the
   document.** Display math is capped at the paragraph (TeX forbids a blank line
   inside math) and inline math also at the next line that opens a block. Bounded
   by paragraph *only*, deliberately: bounding display math by table rows would
   break `$$\n|x| = y\n$$`.
3. **MathML that is valid and paints nothing is the signature failure here.**
   String assertions cannot see it. `tests/mathml_render.py` converts ~25 real
   formulas in a browser and asserts every `math` element has a non-zero box.
   Never call a TeX change verified on the strength of the node suite alone.
4. **Stretchy fences are a font capability.** Without a face carrying an
   OpenType MATH table, `\left(` around a 2-row `pmatrix` renders at 13.8px
   beside a 38.5px matrix — measured. The `--math` token in `theme.css` names
   `STIX Two Math` / `Cambria Math` / `Latin Modern Math` explicitly because the
   generic CSS `math` keyword alone did **not** resolve to an installed maths
   font in Chromium. macOS ships `STIXTwoMath.otf` in
   `/System/Library/Fonts/Supplemental`, so this costs nothing and downloads
   nothing. Pinned by
   `test_ui.py::test_matrix_fences_stretch_to_their_content`.
5. **Every colour is defined three times or it is broken in one theme.** Bare
   `:root` for light, then `@media (prefers-color-scheme: dark)` guarded with
   `:root:not([data-theme="light"])`, then `:root[data-theme="dark"]` so the
   in-page toggle wins in both directions. A colour whose only definition sits
   inside a media query cannot be overridden by the button.
6. **Never reassign `editor.value` for an edit** — it wipes the native undo
   stack. `editRange` uses `execCommand('insertText')` with `setRangeText` as the
   fallback. `setText` is the single exception and the one place `.value` is
   assigned, because loading a document is *meant* to reset history.
7. **Always place the caret at boot; never `if (restored.caret)`.** Assigning
   `editor.value` leaves the caret at the END of the buffer, and a caret of 0 is
   falsy — so a cold load skipped the branch and the first time focus reached the
   editor (⌘\ twice, or any `setMode` refocus) the browser scrolled the caret
   into view and threw the reader to the last line of an 11k-character document.
   The scroll must be reset with it: moving the caret alone does not pull an
   unfocused textarea back up. `setText` resets **both** panes, not just the
   preview. Pinned by two tests in `test_ui.py`.
8. **Every `localStorage` access goes through the guarded helper.** A `file://`
   page can have storage disabled, and an unguarded read at boot takes the whole
   app down before the editor ever appears. The failure is reported in the status
   bar instead. A quota failure is sticky and distinguishes "too large" from
   "disabled".
9. **`showSaveFilePicker` is never asked from a `file:` page**, and a rejection
   arriving in under 250 ms is treated as the environment refusing rather than
   the user cancelling. Two guards, because either alone is guessable — and a
   cancel reported as an error is worse than no picker at all.
10. **`_signal`-style focus reclaim in `setMode` is disarmed until `booted`.** A
    cold load must leave focus where the browser put it so the Tab walk starts at
    the toolbar.
11. **The scroll-sync guard is a driver + timed lockout, not a boolean.** A
    boolean you forget to clear silently kills syncing after the first scroll.
12. **`node --test tests/` does not work.** The files are `test_*.mjs`, which
    does not match node's own test-file patterns, so node treats the path as a
    script and dies with `MODULE_NOT_FOUND`. Always pass the glob:
    `node --test tests/*.mjs`.

## Tests

281, no network, no credentials, ~75 s.

```sh
~/.venvs/main/bin/python build.py     # always build before the browser suites
node --test tests/*.mjs                           # 212
~/.venvs/main/bin/python tests/browser_smoke.py   #  12
~/.venvs/main/bin/python tests/mathml_render.py   #  25
~/.venvs/main/bin/python tests/test_ui.py         #  32
```

`tests/load.mjs` exports `loadGlobals()`, which runs `src/markdown.js` and
`src/tex.js` in a `node:vm` context with a `window` shim — that is how the
browser globals are tested under node with no bundler.

The three Python suites drive the built file over `file://` in Chromium and
write `tests/artifacts/`. `PLAYWRIGHT_BROWSERS_PATH` must resolve to
`~/Library/Caches/ms-playwright`, which it does by default here.

`tests/mathml_render.py` once carried four `@unittest.expectedFailure`
decorators for known engine gaps. Its convention — stated in the module
docstring — is that an *unexpected success* fails the run, and that this is the
signal to delete the decorator, not the test. All four gaps were fixed and all
four decorators are gone; only the prose describing them remains. Each of those
tests records the before and after measurement in its docstring, so a regression
reads as a return to a known-bad number rather than a bare assertion failure. If
you add a decorator back, keep that convention.

**Verify the rendered page by driving it, not by reading the markup.** A table
that lost its alignment, a formula that paints as a zero-width box and a
colour that fails contrast all look fine in the HTML.
