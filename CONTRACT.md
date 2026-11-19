# markdown-studio — module contract

Single-page, single-file markdown viewer / reader / editor. **Zero dependencies at
runtime: no CDN, no external font, no npm package.** `build.py` inlines every
`src/*.css` and `src/*.js` into one `markdown-studio.html` that must work
opened straight from `file://` with no server and no network.

Because the shipped artefact is one file, the *sources* are split so several
authors never edit the same file. The seams below are frozen — implement to
them exactly.

## Build order (fixed)

CSS, concatenated in this order into `<!--__CSS__-->`:

1. `src/theme.css` — design tokens only, both themes
2. `src/app.css` — chrome: toolbar, panes, outline, status bar, dialogs
3. `src/markdown.css` — typography of rendered markdown inside `#preview`

JS, concatenated in this order into `<!--__JS__-->`:

1. `src/markdown.js` — defines `window.MD`
2. `src/tex.js` — defines `window.TeX`
3. `src/app.js` — the shell; may read `window.MD` and `window.TeX`

Each JS file wraps itself in an IIFE and assigns exactly one global. No
top-level `const` leaking, no ES module syntax (`import`/`export`) — the files
are concatenated into one classic `<script>`.

## `window.MD` (src/markdown.js)

```js
window.MD = {
  VERSION: '1',
  render(src, opts) -> String,   // markdown text -> HTML string
  outline(src) -> Array,         // [{level:1..6, text:String, id:String}]
}
```

`opts` (all optional):

| key | type | meaning |
| --- | --- | --- |
| `math` | `(tex, display) => String` | called for every math span; returns HTML. If absent, math is rendered as literal text in a `<code class="md-math-raw">`. |
| `baseHeadingLevel` | `Number` | default `1`; `#` maps to `h<baseHeadingLevel>` |

Required markdown coverage (CommonMark core + GFM):

- ATX headings `#`..`######` with slugged `id` and a `<a class="md-anchor">` link
- setext headings (`===`, `---`)
- paragraphs, hard breaks (two trailing spaces, and backslash)
- `*em*`, `**strong**`, `***both***`, `_`/`__` variants, `~~strike~~`,
  `` `code` `` (with the multi-backtick rule), `==mark==`
- fenced code blocks with ``` and ~~~, an info string that becomes
  `class="language-x"`, and indented (4-space) code blocks
- blockquotes, nested, lazy continuation
- ordered lists (any start number, `.` and `)`), unordered (`-`, `*`, `+`),
  nesting by indent, loose vs tight (`<p>` only when loose), GFM task list
  items `- [ ]` / `- [x]` -> a disabled checkbox
- thematic breaks `---`, `***`, `___`
- **GFM tables** — leading/trailing pipes optional, alignment row
  (`:--`, `:-:`, `--:`) -> `style="text-align:…"`, escaped `\|` inside cells,
  inline markdown inside cells, ragged rows padded/truncated to the header width
- links `[t](url "title")`, autolinks `<https://…>`, bare-URL GFM autolinks,
  reference links + definitions (`[t][ref]`, `[ref]: url`), images
  `![alt](src "title")`
- inline and block HTML passed through
- footnotes (`[^1]` + `[^1]: text`) rendering a linked footnote section
- backslash escapes for every ASCII punctuation char

Security: this is a local reader for the user's own files, so raw HTML is
**passed through** deliberately — but `javascript:`/`vbscript:`/`data:` (other
than `data:image/*`) URLs in link `href` and image `src` must be neutralised,
and text is HTML-escaped everywhere it is not markup.

Math must be extracted **before** any inline transformation so `$a_1 * b$`
keeps its underscore and asterisk. Recognised delimiters:

- inline: `$…$` (no space just inside, not `$ ` or a lone `$`), `\(…\)`
- display: `$$…$$` (own line or inline), `\[…\]`
- a `$` inside a code span/block is never math
- `\$` is a literal dollar

Determinism: two calls with the same input return byte-identical output; the
heading slugger resets per `render()`/`outline()` call and de-duplicates with
`-1`, `-2` suffixes.

## `window.TeX` (src/tex.js)

```js
window.TeX = {
  VERSION: '1',
  toMathML(tex, display) -> String,  // display: Boolean
}
```

Emits **MathML Core** — natively rendered by Safari, Chrome 109+ and Firefox,
so no KaTeX/MathJax and no web font are needed. Root element is
`<math display="block|inline">`. Never throws: on a parse failure return
`<span class="md-math-error" title="…">` wrapping the escaped source, so a
malformed formula degrades to visible red source instead of blanking the page.

Required TeX coverage:

- numbers, identifiers (single letters -> `<mi>`, multi-letter functions upright),
  operators, `+ - = < > \le \ge \ne \approx \equiv \times \div \pm \cdot \to
  \leftarrow \Rightarrow \iff \propto \infty \partial \nabla \forall \exists
  \in \notin \subset \subseteq \cup \cap \emptyset \neq \ll \gg \sim \simeq`
- Greek letters, lower and upper, plus `\var…` variants
- `^` and `_` including `{}` groups -> `msup`/`msub`/`msubsup`, and
  `\limits`-style under/over on big operators -> `munderover`
- `\frac`, `\dfrac`, `\tfrac`, `\binom`, `\sqrt` (with optional `[n]` index)
- `\sum \prod \int \iint \iiint \oint \lim \liminf \limsup \max \min \inf \sup`
  with limits above/below in display mode, beside in inline mode
- `\left…\right` with auto-stretched `(`, `[`, `\{`, `|`, `\|`, `\langle`,
  `\rangle`, `\lceil`, `\lfloor`, `.` (invisible)
- `\text{…}`, `\mathrm`, `\mathbf`, `\mathit`, `\mathbb`, `\mathcal`, `\mathsf`,
  `\mathtt`, `\operatorname{…}`
- function names `\sin \cos \tan \log \ln \exp \arg \det \dim \deg \gcd`, upright
- `\begin{matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|aligned|array}`
  … `\end{…}` with `&` columns and `\\` rows
- accents `\hat \bar \vec \tilde \dot \ddot \overline \underline \overrightarrow`
- spacing `\, \: \; \! \quad \qquad \ \ ~`, `\\` line break, `\phantom`
- `\color{…}{…}` is accepted and ignored (or applied via `mathcolor`)

## DOM contract (index.html — already written, do not restructure)

Ids `src/app.js` owns:

| id | element | role |
| --- | --- | --- |
| `#app` | div | root; carries `data-mode` |
| `#file-input` | input[type=file] | hidden; `.md,.markdown,.mdown,.txt` |
| `#btn-open` | button | triggers `#file-input` |
| `#btn-save` | button | download current text as its filename |
| `#btn-new` | button | blank document (confirm if dirty) |
| `#btn-copy` | button | copy rendered HTML to clipboard |
| `#btn-print` | button | `window.print()` |
| `#btn-outline` | button | toggle `#outline` |
| `#btn-theme` | button | light -> dark -> system -> light |
| `#theme-label` | span | current theme word |
| `#mode-edit` `#mode-split` `#mode-read` | button | view mode |
| `#panes` | div | pane container |
| `#editor` | textarea | the source |
| `#preview` | article | render target |
| `#outline` | nav | table of contents |
| `#toc` | ol | outline entries |
| `#status-name` | span | filename / `untitled.md` + `•` when dirty |
| `#status-stats` | span | words / chars / lines / reading time |
| `#status-msg` | span | transient messages |
| `#drop` | div | drag-and-drop overlay |
| `#help` | dialog | keyboard-shortcut sheet |
| `#btn-help` | button | opens `#help` |

Behaviour `src/app.js` must provide:

1. **Open** via button, drag-and-drop onto the window, and paste of a `.md` file.
2. **Save** via `Blob` + `<a download>`; keeps the opened filename, defaults to
   `untitled.md`. Also try `showSaveFilePicker` when present, falling back
   silently — `file://` in some browsers rejects it. In native mode (below) Save
   goes through the bridge and never through Blob or the picker.
3. **Live preview**, debounced ~120 ms, that never loses scroll position.
4. **Three modes** — edit only, split, read only — persisted.
5. **Theme**: `light` / `dark` / `system`, applied as `data-theme` on `<html>`,
   persisted in `localStorage`, and `system` follows
   `matchMedia('(prefers-color-scheme: dark)')` live.
6. **Autosave** the buffer + filename + mode + theme + scroll to `localStorage`
   (key prefix `mdstudio.`) and restore on load, so a reload loses nothing.
   Guard every `localStorage` access — `file://` pages can have it disabled.
7. **Scroll sync** in split mode, proportional, and re-entrancy-guarded so the
   two panes cannot ping-pong.
8. **Editor niceties**: Tab inserts two spaces (Shift-Tab outdents), Enter
   continues a list/blockquote, `Cmd/Ctrl-B`/`-I`/`-K` wrap the selection,
   `Cmd/Ctrl-S` saves, `Cmd/Ctrl-O` opens, `Cmd/Ctrl-P` prints,
   `Cmd/Ctrl-\` cycles mode, `Cmd/Ctrl-/` toggles theme, `?` opens help when
   the editor is not focused. Undo must keep working — mutate the textarea
   through `setRangeText` (or `execCommand('insertText')`) rather than
   reassigning `.value`.
9. **Outline** built from `MD.outline`, click scrolls the preview.
10. **Copy code button** on every rendered code block, and clickable heading
    anchors.
11. Everything degrades: if `MD` or `TeX` is missing, the app still shows the
    source and says so in `#status-msg` instead of throwing.

## Tokens (src/theme.css)

Define on `:root` (light), then override inside
`@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]) }` **and**
`:root[data-theme="dark"]`, so the in-page toggle wins in both directions. Never
give a colour its only definition inside a media query.

`--bg --bg-elev --bg-sunken --border --border-strong --text --text-dim
--accent --accent-weak --accent-text --danger --warn --ok --code-bg --code-text
--mark --shadow --sel`, plus `--sp-1..6` = 4/8/12/16/24/32 px and
`--fs-1..7` = 12/13.5/15/17/20/26/34 px, `--mono`, `--sans`, `--serif` font
stacks built only from system fonts, `--radius`, `--radius-lg`, `--maxw`.

## Native bridge (macOS app, optional)

Frozen v1. The macOS shell (`macos/`) hosts this same file in a WKWebView. All of
it is behind `NATIVE`; a plain browser never takes these branches.

### 1. Page origin and detection
- Native loads `mdstudio://app/index.html` through a WKURLSchemeHandler, never `loadFileURL`.
- `NATIVE = window.webkit.messageHandlers.mdstudio` (try/catch, must have a function
  `postMessage`), else `null`. No user-agent or protocol sniffing.

### 2. JS -> native
One handler `mdstudio`, plain `postMessage(obj)`, no reply, every object has a string `type`.
- `ready` `{v:1}`: once at the end of `boot()`; native replies with `load`.
- `dirty` `{dirty:Boolean}`: the only dirty source, sent on change of `state.dirty`.
- `open`, `new`, `save`, `print`: no payload.
- `copy` `{text}`; `theme` `{theme:'light'|'dark'|'system'}`.
Unknown types are ignored. JS wraps every post in try/catch.

### 3. Native -> JS (`window.__mdstudio.native`, exists only when `NATIVE`)
- `load(text, name)` -> Bool: normalises `\r\n?` to `\n`, sets name, dirty=false, renders synchronously; false if a NUL is in the first 4096 chars.
- `getText()` -> String: exact `editor.value`, remembered as `lastHanded`.
- `markSaved(name)` -> Bool (still dirty): clean only if `editor.value === lastHanded`, else re-posts `dirty:true`.
- `command(id)` -> Bool: `bold italic link mode-cycle mode-edit mode-split mode-read theme-cycle outline help copy-html demo`. While the help dialog is open every id except `help` returns false.
- `appendText(text)` -> String: appends via `editRange`; used by the selftest.

### 4. Save
Every save reaches native `Document.save`, which calls `getText()`, writes
`Data(text.utf8)` (no BOM, no added newline), then calls `markSaved`. JS never writes files in native mode.

### 5. Shortcut ownership
In native mode `onKeydown` skips every SHORTCUTS entry with `mod: true` (neither runs nor
preventDefaults it), so the native menu owns Cmd-N/O/W/S/P/Q/Z/X/C/V/A/F/G, B, I, K, \\, /,
Shift-O, 1/2/3 and Opt-C. JS keeps Tab, Shift-Tab, Enter, Esc and `?` in both modes.

### 6. Storage
Shared origin `mdstudio://app`. Native mode reads and writes only `mdstudio.mode`,
`.theme`, `.split`, `.outline`; never `doc`, `name`, `dirty`, `scroll`, `caret`. Boot state is an
empty editor named `Untitled`, clean; native then pushes content via `load`.

### 7. Bypasses
A File that still reaches JS `loadFile` loads into the current document, name unchanged,
dirty, with `Loaded contents of <name> (not linked to that file)`. Native serves
`mdstudio://app/<other>` from the document folder, image types only.

## Tests

`node --test tests/*.mjs`, plus `~/.venvs/main/bin/python tests/browser_smoke.py`
for the Playwright pass. `tests/load.mjs` exports `loadGlobals()`, which reads
the `src/*.js` files, runs them against a minimal `window` shim and returns
`{MD, TeX}` — that is how the browser globals get tested under node without a
bundler.
