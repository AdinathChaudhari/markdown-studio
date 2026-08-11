#!/usr/bin/env python3
"""Drive markdown-studio.html in a real browser and assert it works.

    ~/.venvs/main/bin/python tests/browser_smoke.py
    ~/.venvs/main/bin/python tests/browser_smoke.py -v BrowserSmokeTest.test_math

Everything here is about the *built* file, opened over `file://` with no server,
because that is the only way the artefact is ever used. The unit tests under
`node --test tests/*.mjs` cover the two renderers in isolation; this covers the
things only a browser can answer — does MathML actually paint, does the theme
toggle change a computed colour, does anything push the page sideways.

Design notes worth not rediscovering:

* One browser for the whole class (launching Chromium is ~0.4 s), but a **fresh
  browser context per test**, because the app autosaves to `localStorage` and
  `file://` pages share one origin. Without the fresh context, whichever test
  ran first would decide the theme and mode every later test saw.
* `add_init_script` clears storage *before* the page's own script runs, so the
  app boots from the shipped default document rather than a previous test's
  buffer.
* Console messages and page errors are collected per page and asserted on in
  their own test, but also printed by every failure, since a page error usually
  explains whatever else went wrong.
* Zero-width MathML is the classic silent failure: a `<math>` element the
  browser cannot lay out is present in the DOM, has the right children, and
  paints nothing. Width is the only honest check.
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "markdown-studio.html"
URL = DIST.as_uri()

# Playwright decides the browser is missing if this points anywhere else, and
# then asks you to reinstall it. Pin it before importing, not after.
os.environ.setdefault(
    "PLAYWRIGHT_BROWSERS_PATH",
    str(Path.home() / "Library" / "Caches" / "ms-playwright"),
)

from playwright.sync_api import sync_playwright  # noqa: E402

WIDE = {"width": 1280, "height": 800}
NARROW = {"width": 700, "height": 900}

# The order src/app.js cycles: THEMES = ['light', 'dark', 'system'], starting
# from 'system'. Each entry is (data-theme, the word in #theme-label).
THEME_CYCLE = [
    ("system", "System"),
    ("light", "Light"),
    ("dark", "Dark"),
    ("system", "System"),
]

OVERFLOW_PROBE = """() => {
  const de = document.documentElement;
  const cw = de.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > cw + 1) {
      out.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) +
               (el.className && el.className.toString ?
                  '.' + el.className.toString().trim().split(/\\s+/).join('.') : '') +
               ' right=' + Math.round(r.right));
    }
  }
  return { scrollWidth: de.scrollWidth, clientWidth: cw, offenders: out.slice(0, 8) };
}"""


class BrowserSmokeTest(unittest.TestCase):
    """One browser, one fresh page per test, against the built file."""

    @classmethod
    def setUpClass(cls):
        if not DIST.exists():
            raise unittest.SkipTest(f"{DIST} not built — run build.py first")
        cls._pw = sync_playwright().start()
        cls._browser = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls._browser.close()
        cls._pw.stop()

    def setUp(self):
        self.messages = []   # (type, text) for every console message
        self.errors = []     # uncaught exceptions
        self.context = self._browser.new_context(viewport=dict(WIDE))
        self.page = self.context.new_page()
        self.page.on("console", lambda m: self.messages.append((m.type, m.text)))
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        # Runs before the app's script: a previous test must not leak its buffer.
        self.page.add_init_script("try { localStorage.clear(); } catch (e) {}")
        self.page.goto(URL)
        self.page.wait_for_function("!!window.__mdstudio")
        self.page.wait_for_timeout(400)  # let the first render and MathML settle

    def tearDown(self):
        self.context.close()

    # -- helpers -------------------------------------------------------

    def diagnostics(self):
        """Whatever the console said, appended to any failure message."""
        bits = []
        if self.errors:
            bits.append("page errors: " + " | ".join(self.errors))
        loud = [f"{t}: {x}" for t, x in self.messages]
        if loud:
            bits.append("console: " + " | ".join(loud[:10]))
        return ("\n" + "\n".join(bits)) if bits else ""

    def assert_no_overflow(self, label):
        got = self.page.evaluate(OVERFLOW_PROBE)
        self.assertLessEqual(
            got["scrollWidth"], got["clientWidth"],
            f"{label}: the page scrolls horizontally "
            f"({got['scrollWidth']} > {got['clientWidth']}); "
            f"widest elements: {got['offenders']}" + self.diagnostics(),
        )

    # -- the assertions ------------------------------------------------

    def test_no_page_errors_or_console_errors(self):
        self.assertEqual([], self.errors, "uncaught exceptions on load")
        loud = [(t, x) for t, x in self.messages if t in ("error", "warning")]
        self.assertEqual([], loud, f"console errors/warnings on load: {loud}")

    def test_default_document_loads(self):
        length = self.page.eval_on_selector("#editor", "e => e.value.length")
        self.assertGreater(
            length, 500,
            "#editor is empty or nearly so — window.DEFAULT_DOC did not reach it"
            + self.diagnostics(),
        )
        self.assertIn("Markdown Studio", self.page.eval_on_selector("#editor", "e => e.value"))

    def test_tables_render(self):
        n = self.page.eval_on_selector_all("#preview table.md-table", "els => els.length")
        self.assertGreaterEqual(n, 3, f"expected >= 3 table.md-table, found {n}" + self.diagnostics())

    def test_math_renders_with_non_zero_width(self):
        info = self.page.evaluate("""() => {
          const ms = [...document.querySelectorAll('#preview math')];
          return {
            count: ms.length,
            zero: ms.filter(m => m.getBoundingClientRect().width === 0)
                    .map(m => m.outerHTML.slice(0, 140)),
          };
        }""")
        self.assertGreaterEqual(
            info["count"], 8,
            f"expected >= 8 <math> elements, found {info['count']}" + self.diagnostics(),
        )
        self.assertEqual(
            [], info["zero"],
            "MathML present in the DOM but laid out to zero width (renders as "
            "nothing):\n" + "\n".join(info["zero"]) + self.diagnostics(),
        )

    def test_math_errors_degrade_visibly(self):
        """The deliberately malformed formula must be visible red source."""
        got = self.page.evaluate("""() => {
          const e = document.querySelector('#preview .md-math-error');
          if (!e) return null;
          return { text: e.textContent, title: e.getAttribute('title'),
                   width: e.getBoundingClientRect().width };
        }""")
        self.assertIsNotNone(got, "the demo's malformed formula produced no .md-math-error")
        self.assertGreater(got["width"], 0, "the math-error span has zero width")
        self.assertTrue(got["title"], "the math-error span carries no reason in its title")

    def test_theme_button_cycles_and_repaints(self):
        backgrounds = {}
        for expected_theme, expected_label in THEME_CYCLE:
            theme = self.page.evaluate("document.documentElement.dataset.theme")
            label = self.page.inner_text("#theme-label")
            self.assertEqual(expected_theme, theme, "data-theme out of step" + self.diagnostics())
            self.assertEqual(
                expected_label, label,
                f"#theme-label says {label!r} while data-theme is {theme!r}",
            )
            backgrounds[theme] = self.page.evaluate(
                "getComputedStyle(document.body).backgroundColor"
            )
            self.page.click("#btn-theme")
            self.page.wait_for_timeout(120)

        self.assertNotEqual(
            backgrounds["light"], backgrounds["dark"],
            "body background-color is identical in light and dark "
            f"({backgrounds['light']}) — the tokens are not being swapped",
        )

    def test_mode_buttons_switch_panes(self):
        cases = [("edit", True, False), ("split", True, True), ("read", False, True)]
        for mode, want_editor, want_preview in cases:
            self.page.click(f"#mode-{mode}")
            self.page.wait_for_timeout(150)
            self.assertEqual(mode, self.page.get_attribute("#app", "data-mode"))
            visible = self.page.evaluate("""(sel) => {
              const el = document.querySelector(sel);
              const r = el.getBoundingClientRect();
              return r.width > 1 && r.height > 1 &&
                     getComputedStyle(el).display !== 'none' &&
                     getComputedStyle(el).visibility !== 'hidden';
            }""", "#editor-pane")
            self.assertEqual(want_editor, visible, f"editor visibility wrong in {mode} mode")
            visible = self.page.evaluate("""(sel) => {
              const el = document.querySelector(sel);
              const r = el.getBoundingClientRect();
              return r.width > 1 && r.height > 1 &&
                     getComputedStyle(el).display !== 'none' &&
                     getComputedStyle(el).visibility !== 'hidden';
            }""", "#preview-pane")
            self.assertEqual(want_preview, visible, f"preview visibility wrong in {mode} mode")

    def test_typing_updates_the_preview(self):
        marker = "Smoke-test heading 4a7f"
        self.page.click("#mode-split")
        self.page.eval_on_selector("#editor", "e => { e.focus(); e.setSelectionRange(0, 0); }")
        self.page.keyboard.type("# " + marker + "\n\n")
        # The render is debounced ~120 ms; 500 ms is the contract's budget.
        self.page.wait_for_function(
            "text => document.querySelector('#preview').textContent.includes(text)",
            arg=marker, timeout=500,
        )
        self.assertIn(marker, self.page.inner_text("#toc"), "the outline did not follow the edit")

    def test_no_horizontal_page_scroll_wide(self):
        self.page.set_viewport_size(dict(WIDE))
        self.page.wait_for_timeout(250)
        for mode in ("edit", "split", "read"):
            self.page.click(f"#mode-{mode}")
            self.page.wait_for_timeout(150)
            self.assert_no_overflow(f"1280x800 / {mode}")

    def test_no_horizontal_page_scroll_narrow(self):
        self.page.set_viewport_size(dict(NARROW))
        self.page.wait_for_timeout(250)
        for mode in ("edit", "split", "read"):
            self.page.click(f"#mode-{mode}")
            self.page.wait_for_timeout(150)
            self.assert_no_overflow(f"700x900 / {mode}")

    def test_wide_table_scrolls_inside_its_own_frame(self):
        """The wide demo table must overflow its wrapper, not the page."""
        self.page.set_viewport_size(dict(NARROW))
        self.page.click("#mode-read")
        self.page.wait_for_timeout(250)
        got = self.page.evaluate("""() => {
          const wraps = [...document.querySelectorAll('#preview .md-table-wrap')];
          return wraps.map(w => ({
            scrolls: w.scrollWidth > w.clientWidth + 1,
            overflowX: getComputedStyle(w).overflowX,
          }));
        }""")
        self.assertTrue(got, "no .md-table-wrap in the preview")
        self.assertTrue(
            any(w["scrolls"] for w in got),
            f"no table wrapper actually scrolls at 700px: {got}",
        )
        for w in got:
            self.assertIn(w["overflowX"], ("auto", "scroll"),
                          f"table wrapper cannot scroll: overflow-x is {w['overflowX']}")

    def test_no_external_requests(self):
        """Nothing may leave the machine — the whole point of the artefact."""
        outbound = []
        self.page.on("request", lambda r: outbound.append(r.url))
        self.page.reload()
        self.page.wait_for_function("!!window.__mdstudio")
        self.page.wait_for_timeout(400)
        remote = [u for u in outbound if not u.startswith(("file://", "data:", "blob:"))]
        self.assertEqual([], remote, f"the page requested something remote: {remote}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
