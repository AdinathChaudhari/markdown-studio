#!/usr/bin/env python3
"""UX / interaction verification for markdown-studio.html.

    ~/.venvs/main/bin/python tests/test_ui.py
    ~/.venvs/main/bin/python tests/test_ui.py -v UITest.test_05_editing_tab_enter_bold_undo

This drives the *built* single file over `file://` with Playwright and asks the
questions a user would ask, not the questions a code reader would. Nothing here
inspects `src/`; every assertion is about observed behaviour — bounding boxes,
computed colours, what survives a reload, whether undo puts the text back.

Design notes worth not rediscovering:

* One Chromium for the whole class (launching is ~0.4 s), but a **fresh browser
  context per test**. The app autosaves to `localStorage` and every `file://`
  page shares one origin, so without the fresh context whichever test ran first
  would decide the theme, mode and buffer that every later test saw. A fresh
  context starts with empty storage, which is exactly the cold-start state.
* Persistence tests reload *inside* one context on purpose — that is the only
  way to prove the autosave round trip. They must therefore never assume the
  cold-start defaults after the first reload.
* `window.print()` is stubbed by `add_init_script` so the print binding is
  observable; nothing else about the page is patched.
* Contrast is computed against the nearest **opaque** ancestor background, with
  any translucent layers in between composited in order. Reading
  `background-color` off the element alone reports `rgba(0,0,0,0)` for almost
  everything and silently passes.
* MathML that the browser cannot lay out is present in the DOM, has the right
  children and paints nothing. Width is the only honest check.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "markdown-studio.html"
ARTIFACTS = Path(__file__).resolve().parent / "artifacts"

# Playwright decides the browser is missing if this points anywhere else, and
# then asks you to reinstall it. Pin it before importing, not after.
os.environ.setdefault(
    "PLAYWRIGHT_BROWSERS_PATH",
    str(Path.home() / "Library" / "Caches" / "ms-playwright"),
)

from playwright.sync_api import Error as PWError  # noqa: E402
from playwright.sync_api import TimeoutError as PWTimeout  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

WIDE = {"width": 1280, "height": 800}
LAPTOP = {"width": 1024, "height": 768}
TABLET = {"width": 820, "height": 1180}
PHONE = {"width": 480, "height": 900}

VIEWPORTS = [("1280x800", WIDE), ("1024x768", LAPTOP), ("820x1180", TABLET), ("480x900", PHONE)]

# src/app.js cycles THEMES = ['light', 'dark', 'system'] and boots on 'system'.
THEME_CYCLE = ["light", "dark", "system"]
MODE_CYCLE = ["edit", "split", "read"]

MOD = "Meta" if sys.platform == "darwin" else "Control"

STUB_PRINT = "window.__printCalls = 0; window.print = function () { window.__printCalls++; };"

# ---------------------------------------------------------------------------
# In-page probes
# ---------------------------------------------------------------------------

JS_SLIM_STATE = """() => {
  const s = window.__mdstudio.getState();
  return {
    name: s.name, dirty: s.dirty, mode: s.mode, theme: s.theme, ratio: s.ratio,
    outlineOpen: s.outlineOpen, missing: s.missing || [], storage: s.storage,
    error: s.error || null, len: (s.text || '').length,
    headings: (s.headings || []).map(h => ({ level: h.level, text: h.text, id: h.id })),
  };
}"""

# Nearest opaque background, compositing every translucent layer above it.
JS_CONTRAST = """(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const parse = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(',').map(v => parseFloat(v));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const layers = [];
  let n = el, opaque = null;
  while (n) {
    const c = parse(getComputedStyle(n).backgroundColor);
    if (c && c[3] > 0) {
      if (c[3] >= 0.999) { opaque = c; break; }
      layers.push(c);
    }
    n = n.parentElement;
  }
  if (!opaque) opaque = [255, 255, 255, 1];
  let bg = opaque;
  for (let i = layers.length - 1; i >= 0; i--) {
    const t = layers[i], a = t[3];
    bg = [t[0] * a + bg[0] * (1 - a), t[1] * a + bg[1] * (1 - a), t[2] * a + bg[2] * (1 - a), 1];
  }
  const fg = parse(cs.color) || [0, 0, 0, 1];
  // A translucent foreground sits on top of that same background.
  const fa = fg[3];
  const flat = [fg[0] * fa + bg[0] * (1 - fa), fg[1] * fa + bg[1] * (1 - fa), fg[2] * fa + bg[2] * (1 - fa)];
  const r = el.getBoundingClientRect();
  return {
    fg: flat, bg: [bg[0], bg[1], bg[2]],
    fontSize: parseFloat(cs.fontSize), weight: String(cs.fontWeight),
    visible: r.width > 0 && r.height > 0,
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 48),
  };
}"""

JS_PAGE_OVERFLOW = """() => {
  const de = document.documentElement, b = document.body;
  const widest = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > de.clientWidth + 2) {
      widest.push({ id: el.id || null, cls: el.className && el.className.toString().slice(0, 40),
                    tag: el.tagName.toLowerCase(), right: Math.round(r.right) });
    }
  }
  return {
    docScroll: de.scrollWidth, docClient: de.clientWidth,
    bodyScroll: b.scrollWidth, bodyClient: b.clientWidth,
    offenders: widest.slice(0, 6),
  };
}"""

JS_TOOLBAR = """() => {
  const tb = document.getElementById('toolbar');
  const r = tb.getBoundingClientRect();
  const btns = [...tb.querySelectorAll('button')].map(b => {
    const br = b.getBoundingClientRect();
    return { id: b.id, x: br.x, y: br.y, w: br.width, h: br.height, right: br.right, bottom: br.bottom,
             visible: br.width > 0 && br.height > 0 };
  });
  const panes = document.getElementById('panes').getBoundingClientRect();
  return {
    scrollWidth: tb.scrollWidth, clientWidth: tb.clientWidth,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right },
    panesTop: panes.top, buttons: btns,
  };
}"""

JS_PANE_BOXES = """() => {
  const box = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { w: r.width, h: r.height, display: cs.display, visibility: cs.visibility };
  };
  return {
    mode: document.getElementById('app').dataset.mode,
    editor: box('editor-pane'), preview: box('preview-pane'),
    gutter: box('gutter'), outline: box('outline'),
  };
}"""

# The survey reports the *effective* background — the nearest opaque ancestor
# with translucent layers composited in — because #preview is deliberately a
# transparent <article> on a painted pane. Reading its own background-color
# gives rgba(0,0,0,0) in both themes and would fail a theme that works.
JS_THEME_SURVEY = (
    """() => {
  const paint = %s;
  const out = {};
  for (const sel of ['body', '#toolbar', '#preview', '#editor', '#statusbar']) {
    const el = document.querySelector(sel);
    if (!el) { out[sel] = null; continue; }
    const cs = getComputedStyle(el);
    const p = paint(sel);
    out[sel] = {
      color: cs.color, ownBackground: cs.backgroundColor,
      background: p ? 'rgb(' + p.bg.map(Math.round).join(', ') + ')' : null,
      flatColor: p ? 'rgb(' + p.fg.map(Math.round).join(', ') + ')' : null,
      border: cs.borderBottomColor,
    };
  }
  out._theme = document.documentElement.dataset.theme;
  out._resolved = document.documentElement.dataset.themeResolved || null;
  out._label = (document.getElementById('theme-label') || {}).textContent || null;
  return out;
}"""
    % JS_CONTRAST
)

JS_DROP_FILE = """(payload) => {
  const dt = new DataTransfer();
  dt.items.add(new File([payload.text], payload.name, { type: 'text/markdown' }));
  const mk = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
  window.dispatchEvent(mk('dragover'));
  window.dispatchEvent(mk('drop'));
  return true;
}"""

WIDE_TABLE = "\n".join(
    [
        "# Wide",
        "",
        "| " + " | ".join("column heading number %02d" % i for i in range(1, 26)) + " |",
        "| " + " | ".join("---" for _ in range(25)) + " |",
        "| " + " | ".join("cell value %02d" % i for i in range(1, 26)) + " |",
        "",
    ]
)

LONG_EQUATION = (
    "# Long\n\n$$\n"
    + " + ".join(r"\alpha_{%d} \beta_{%d} \gamma_{%d}" % (i, i, i) for i in range(1, 40))
    + "\n$$\n"
)


# ---------------------------------------------------------------------------
# Colour maths
# ---------------------------------------------------------------------------


def _srgb_channel(v: float) -> float:
    c = v / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb) -> float:
    r, g, b = (_srgb_channel(float(x)) for x in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(fg, bg) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def _rgb(css: str):
    m = re.findall(r"-?[\d.]+", css or "")
    return [float(x) for x in m[:3]] or [0.0, 0.0, 0.0]


def hexof(rgb) -> str:
    return "#%02x%02x%02x" % tuple(int(round(max(0.0, min(255.0, float(c))))) for c in rgb[:3])


# ---------------------------------------------------------------------------
# Session plumbing
# ---------------------------------------------------------------------------


class Session:
    """One browser context + page, with its console and page errors collected."""

    def __init__(self, ctx, page):
        self.ctx = ctx
        self.page = page
        self.console: list[str] = []
        self.errors: list[str] = []
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.on(
            "console",
            lambda m: self.console.append("%s: %s" % (m.type, m.text))
            if m.type in ("error", "warning")
            else None,
        )

    # -- lifecycle ------------------------------------------------------
    def goto(self):
        self.page.goto(DIST.as_uri())
        self.boot()
        return self

    def reload(self):
        self.page.reload()
        self.boot()
        return self

    def boot(self):
        self.page.wait_for_function(
            "() => !!(window.__mdstudio && window.__mdstudio.getState)", timeout=10_000
        )
        # One render tick past the 120 ms debounce, plus MathML layout.
        self.page.wait_for_timeout(350)
        return self

    # -- shortcuts ------------------------------------------------------
    def state(self) -> dict:
        return self.page.evaluate(JS_SLIM_STATE)

    def theme(self) -> str:
        return self.page.evaluate("() => document.documentElement.dataset.theme")

    def label(self) -> str:
        return self.page.inner_text("#theme-label")

    def mode(self) -> str:
        return self.page.get_attribute("#app", "data-mode")

    def storage(self, key: str):
        return self.page.evaluate(
            "(k) => { try { return localStorage.getItem('mdstudio.' + k); } catch (e) { return 'THREW'; } }",
            key,
        )

    def set_text(self, text: str, name=None):
        self.page.evaluate(
            "(a) => window.__mdstudio.setText(a.t, a.n)", {"t": text, "n": name}
        )
        self.page.wait_for_timeout(250)

    def type_fresh(self, text: str):
        """Replace the buffer by typing, so the native undo stack is real."""
        self.page.click("#editor")
        self.page.keyboard.press(MOD + "+a")
        self.page.keyboard.type(text)
        self.page.wait_for_timeout(250)

    def editor_value(self) -> str:
        return self.page.eval_on_selector("#editor", "el => el.value")

    def preview_text(self) -> str:
        return self.page.inner_text("#preview")


class UITest(unittest.TestCase):
    """Every test gets a clean context; the browser is launched once."""

    @classmethod
    def setUpClass(cls):
        build = subprocess.run(
            [sys.executable, str(ROOT / "build.py")], capture_output=True, text=True
        )
        if build.returncode != 0:
            raise unittest.SkipTest(
                "build.py failed, so there is nothing to drive:\n%s\n%s"
                % (build.stdout, build.stderr)
            )
        if not DIST.exists():
            raise unittest.SkipTest("no markdown-studio.html after build")
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.close()
        finally:
            cls._pw.stop()

    def setUp(self):
        self._sessions: list[Session] = []

    def tearDown(self):
        for s in self._sessions:
            try:
                s.ctx.close()
            except Exception:
                pass

    # -- helpers --------------------------------------------------------
    def session(self, viewport=None, color_scheme=None, stub_print=True) -> Session:
        kw = {"viewport": dict(viewport or WIDE), "accept_downloads": True}
        if color_scheme is not None:
            kw["color_scheme"] = color_scheme
        ctx = self.browser.new_context(**kw)
        if stub_print:
            ctx.add_init_script(STUB_PRINT)
        page = ctx.new_page()
        s = Session(ctx, page)
        self._sessions.append(s)
        return s

    def app(self, **kw) -> Session:
        return self.session(**kw).goto()

    def assert_clean(self, s: Session, where: str):
        self.assertEqual([], s.errors, "page errors during %s" % where)
        bad = [c for c in s.console if c.startswith("error")]
        self.assertEqual([], bad, "console errors during %s (all: %s)" % (where, s.console))

    def set_theme(self, s: Session, want: str):
        for _ in range(len(THEME_CYCLE) + 1):
            if s.theme() == want:
                return
            s.page.click("#btn-theme")
            s.page.wait_for_timeout(120)
        self.fail("could not reach theme %r (stuck at %r)" % (want, s.theme()))

    # ==================================================================
    # 1. Cold load
    # ==================================================================
    def test_01_cold_load_is_clean_and_painted(self):
        s = self.app()
        self.assert_clean(s, "cold load")

        st = s.state()
        self.assertIsNone(st["error"], "app fell into its start() catch: %r" % st["error"])
        self.assertEqual([], st["missing"], "a renderer is missing on a clean build")
        self.assertGreater(st["len"], 200, "editor is empty on a cold start")
        self.assertTrue(st["storage"], "localStorage unusable, so nothing will persist")

        # Editor really holds the text the state claims.
        self.assertGreater(len(s.editor_value()), 200)

        painted = s.page.evaluate(
            """() => {
              const pv = document.getElementById('preview');
              const r = pv.getBoundingClientRect();
              const tables = [...pv.querySelectorAll('table')].map(t => t.getBoundingClientRect().width);
              const maths = [...pv.querySelectorAll('math')].map(m => m.getBoundingClientRect().width);
              const codes = pv.querySelectorAll('pre code').length;
              return { children: pv.children.length, w: r.width, h: r.height,
                       tables, maths, codes,
                       rawMath: pv.querySelectorAll('.md-math-raw').length,
                       text: (pv.textContent || '').length };
            }"""
        )
        self.assertGreater(painted["children"], 10, "preview did not render")
        self.assertGreater(painted["w"], 100)
        self.assertGreater(painted["text"], 200)
        self.assertGreater(len(painted["tables"]), 0, "no table rendered from the demo document")
        self.assertTrue(
            all(w > 50 for w in painted["tables"]),
            "a rendered table has no width: %s" % painted["tables"],
        )
        self.assertGreater(len(painted["maths"]), 0, "no MathML rendered from the demo document")
        self.assertEqual(
            0, painted["rawMath"], "math fell back to .md-math-raw, so TeX never ran"
        )
        zero = [w for w in painted["maths"] if w <= 1]
        self.assertEqual(
            [], zero, "%d of %d <math> elements paint zero width" % (len(zero), len(painted["maths"]))
        )

    # ==================================================================
    # 2. Theme
    # ==================================================================
    def test_02a_theme_cycle_label_and_colours(self):
        s = self.app()
        self.assertEqual("system", s.theme(), "cold start is not the system theme")

        seen = []
        for _ in range(4):
            t = s.theme()
            self.assertEqual(
                t,
                s.label().strip().lower(),
                "#theme-label %r does not match data-theme %r" % (s.label(), t),
            )
            seen.append(t)
            s.page.click("#btn-theme")
            s.page.wait_for_timeout(140)
        self.assertEqual(
            ["system", "light", "dark", "system"], seen, "theme cycle is not light/dark/system"
        )
        self.assert_clean(s, "theme cycling")

        self.set_theme(s, "light")
        light = s.page.evaluate(JS_THEME_SURVEY)
        self.set_theme(s, "dark")
        dark = s.page.evaluate(JS_THEME_SURVEY)

        for sel in ("body", "#toolbar", "#preview", "#editor", "#statusbar"):
            self.assertIsNotNone(light[sel], "%s missing" % sel)
            self.assertNotEqual(
                light[sel]["background"],
                dark[sel]["background"],
                "%s effective background does not change between light and dark "
                "(%s; own background-color %s)"
                % (sel, light[sel]["background"], light[sel]["ownBackground"]),
            )
            self.assertNotEqual(
                light[sel]["color"],
                dark[sel]["color"],
                "%s text colour does not change between light and dark (%s)"
                % (sel, light[sel]["color"]),
            )
            # And the pair is genuinely a light/dark inversion, not two tints.
            lum_light = luminance(_rgb(light[sel]["background"]))
            lum_dark = luminance(_rgb(dark[sel]["background"]))
            self.assertGreater(
                lum_light,
                lum_dark,
                "%s is not darker in the dark theme (light %.3f vs dark %.3f)"
                % (sel, lum_light, lum_dark),
            )

    def test_02b_theme_survives_reload(self):
        s = self.app()
        self.set_theme(s, "dark")
        s.page.wait_for_timeout(600)  # SAVE_DEBOUNCE is 400 ms
        self.assertEqual("dark", s.storage("theme"), "theme not written to localStorage")
        s.reload()
        self.assertEqual("dark", s.theme(), "theme did not survive a reload")
        self.assertEqual("dark", s.label().strip().lower())
        self.assert_clean(s, "theme reload")

    def test_02c_system_follows_prefers_colour_scheme(self):
        dark_ctx = self.app(color_scheme="dark")
        self.assertEqual("system", dark_ctx.theme())
        surveyed = dark_ctx.page.evaluate(JS_THEME_SURVEY)
        self.assertEqual(
            "dark",
            surveyed["_resolved"],
            "theme=system did not resolve to dark under prefers-color-scheme: dark",
        )
        dark_bg = surveyed["body"]["background"]

        light_ctx = self.app(color_scheme="light")
        light_survey = light_ctx.page.evaluate(JS_THEME_SURVEY)
        self.assertEqual("light", light_survey["_resolved"])
        self.assertNotEqual(
            dark_bg,
            light_survey["body"]["background"],
            "system theme paints the same background under both OS schemes",
        )

        # An explicit choice must beat the OS preference.
        self.set_theme(dark_ctx, "light")
        forced = dark_ctx.page.evaluate(JS_THEME_SURVEY)
        self.assertEqual("light", forced["_resolved"])
        self.assertEqual(
            light_survey["body"]["background"],
            forced["body"]["background"],
            "data-theme=light does not override prefers-color-scheme: dark",
        )

        # `system` must follow a *live* OS change, not only the one at load.
        live = self.app(color_scheme="light")
        self.assertEqual("light", live.page.evaluate(JS_THEME_SURVEY)["_resolved"])
        before_bg = live.page.evaluate(JS_THEME_SURVEY)["body"]["background"]
        live.page.emulate_media(color_scheme="dark")
        live.page.wait_for_timeout(300)
        after = live.page.evaluate(JS_THEME_SURVEY)
        self.assertEqual(
            "dark",
            after["_resolved"],
            "theme=system did not follow a live prefers-color-scheme change",
        )
        self.assertNotEqual(
            before_bg,
            after["body"]["background"],
            "a live OS scheme change repainted nothing",
        )
        self.assert_clean(dark_ctx, "forced light under dark OS")
        self.assert_clean(live, "live scheme change")

    # ==================================================================
    # 3. Contrast
    # ==================================================================
    #  selector, human name, minimum ratio
    CONTRAST_TARGETS = [
        ("#preview p", "body text", 4.5),
        # `p > a` on purpose: `p a` first matches the footnote back-reference,
        # an 11px link inside a <sup>, which is not body copy.
        ("#preview p > a[href]", "link in body text", 4.5),
        ("#preview li", "list item text", 4.5),
        ("#preview th", "table header text", 4.5),
        ("#preview td", "table cell text", 4.5),
        ("#preview pre code", "code block text", 4.5),
        ("#btn-open", "toolbar button label", 4.5),
        ("#status-name", "status bar filename", 4.5),
        ("#status-stats", "status bar dim text", 3.0),
        ("#preview blockquote", "blockquote dim text", 3.0),
        ("#preview .md-anchor", "heading anchor", 3.0),
        ("#toc .toc-link", "outline entry", 3.0),
    ]

    def test_03_contrast_in_both_themes(self):
        s = self.app()
        s.page.click("#btn-outline")  # so the outline entries are measurable
        s.page.wait_for_timeout(200)
        problems = []
        measured = []
        for theme in ("light", "dark"):
            self.set_theme(s, theme)
            s.page.wait_for_timeout(120)
            for sel, name, floor in self.CONTRAST_TARGETS:
                got = s.page.evaluate(JS_CONTRAST, sel)
                if got is None:
                    problems.append("%s: no element matches %s" % (theme, sel))
                    continue
                if not got["visible"]:
                    continue  # legitimately hidden at this size (e.g. hover-only anchor)
                ratio = contrast(got["fg"], got["bg"])
                measured.append(
                    "%-5s %-22s %5.2f  fg %s on %s  %.1fpx"
                    % (theme, name, ratio, hexof(got["fg"]), hexof(got["bg"]), got["fontSize"])
                )
                if ratio + 1e-9 < floor:
                    problems.append(
                        "%s theme: %s (%s) is %.2f:1, below %.1f — %s on %s at %.1fpx"
                        % (
                            theme,
                            name,
                            sel,
                            ratio,
                            floor,
                            hexof(got["fg"]),
                            hexof(got["bg"]),
                            got["fontSize"],
                        )
                    )
        print("\n" + "\n".join(measured))
        self.assertEqual([], problems, "contrast failures:\n  " + "\n  ".join(problems))

    # ==================================================================
    # 4. Modes
    # ==================================================================
    EXPECT = {
        "edit": {"editor": True, "preview": False, "gutter": False},
        "split": {"editor": True, "preview": True, "gutter": True},
        "read": {"editor": False, "preview": True, "gutter": False},
    }

    def _assert_panes(self, s: Session, mode: str):
        boxes = s.page.evaluate(JS_PANE_BOXES)
        self.assertEqual(mode, boxes["mode"], "data-mode is %r, expected %r" % (boxes["mode"], mode))
        for key, should_show in self.EXPECT[mode].items():
            box = boxes[key]
            shown = bool(box) and box["w"] > 1 and box["h"] > 1 and box["display"] != "none"
            self.assertEqual(
                should_show,
                shown,
                "in %s mode #%s is %s (box=%s)"
                % (mode, key, "visible" if shown else "not visible", box),
            )

    def test_04a_each_mode_button_shows_the_right_panes(self):
        s = self.app()
        for mode in ("edit", "read", "split", "read", "edit"):
            s.page.click("#mode-%s" % mode)
            s.page.wait_for_timeout(160)
            self._assert_panes(s, mode)
            self.assertEqual(
                "true",
                s.page.get_attribute("#mode-%s" % mode, "aria-pressed"),
                "#mode-%s is not aria-pressed while active" % mode,
            )
        self.assert_clean(s, "mode switching")

    def test_04b_mode_survives_reload(self):
        s = self.app()
        s.page.click("#mode-read")
        s.page.wait_for_timeout(600)
        self.assertEqual("read", s.storage("mode"))
        s.reload()
        self.assertEqual("read", s.mode(), "mode did not survive a reload")
        self._assert_panes(s, "read")
        self.assert_clean(s, "mode reload")

    def test_04c_mode_cycle_shortcut(self):
        s = self.app()
        s.page.click("#mode-edit")
        s.page.wait_for_timeout(120)
        got = []
        for _ in range(4):
            got.append(s.mode())
            s.page.keyboard.press(MOD + "+\\")
            s.page.wait_for_timeout(140)
        self.assertEqual(["edit", "split", "read", "edit"], got, "%s+\\ does not cycle modes" % MOD)

    # ==================================================================
    # 5. Editing
    # ==================================================================
    def test_05a_typing_updates_the_preview(self):
        s = self.app()
        s.set_text("# start\n", "typing.md")
        s.page.click("#editor")
        s.page.keyboard.press(MOD + "+a")
        s.page.keyboard.type("| a | b |\n")
        s.page.keyboard.type("| --- | --: |\n")
        s.page.keyboard.type("| 1 | 2 |\n\n")
        s.page.keyboard.type("Half is $\\frac{1}{2}$ exactly.\n")
        s.page.wait_for_timeout(500)

        got = s.page.evaluate(
            """() => {
              const pv = document.getElementById('preview');
              const t = pv.querySelector('table');
              const m = pv.querySelector('math');
              const frac = pv.querySelector('mfrac');
              return {
                tables: pv.querySelectorAll('table').length,
                tableW: t ? t.getBoundingClientRect().width : 0,
                cells: t ? [...t.querySelectorAll('td')].map(c => c.textContent) : [],
                align: t ? [...t.querySelectorAll('th')].map(c => c.style.textAlign) : [],
                maths: pv.querySelectorAll('math').length,
                mathW: m ? m.getBoundingClientRect().width : 0,
                frac: !!frac, raw: pv.querySelectorAll('.md-math-raw').length,
                err: pv.querySelectorAll('.md-math-error').length,
                text: pv.textContent,
              };
            }"""
        )
        self.assertEqual(1, got["tables"], "typed table did not render")
        self.assertGreater(got["tableW"], 20, "typed table rendered with no width")
        self.assertEqual(["1", "2"], got["cells"])
        self.assertEqual("right", got["align"][1], "the `--:` alignment row was ignored")
        self.assertEqual(1, got["maths"], "typed $\\frac{1}{2}$ produced no <math>")
        self.assertTrue(got["frac"], "no <mfrac> for \\frac{1}{2}")
        self.assertEqual(0, got["err"], "typed \\frac{1}{2} rendered as a math error")
        self.assertGreater(got["mathW"], 3, "typed formula paints zero width")
        self.assertIn("exactly", got["text"])
        self.assert_clean(s, "typing a table and a formula")

    def test_05b_tab_indents_and_keeps_focus(self):
        s = self.app()
        s.type_fresh("alpha")
        s.page.keyboard.press("Home")
        s.page.keyboard.press("Tab")
        s.page.wait_for_timeout(120)
        self.assertEqual(
            "editor",
            s.page.evaluate("() => document.activeElement.id"),
            "Tab moved focus out of the textarea instead of indenting",
        )
        self.assertEqual("  alpha", s.editor_value(), "Tab did not insert two spaces")

        s.page.keyboard.press("Shift+Tab")
        s.page.wait_for_timeout(120)
        self.assertEqual("alpha", s.editor_value(), "Shift+Tab did not outdent")
        self.assertEqual("editor", s.page.evaluate("() => document.activeElement.id"))

    def test_05c_enter_continues_a_list(self):
        s = self.app()
        s.type_fresh("- item")
        s.page.keyboard.press("End")
        s.page.keyboard.press("Enter")
        s.page.wait_for_timeout(150)
        self.assertEqual(
            "- item\n- ", s.editor_value(), "Enter after `- item` did not continue the list"
        )
        # A second Enter on an empty item ends the list rather than growing it.
        s.page.keyboard.press("Enter")
        s.page.wait_for_timeout(150)
        self.assertNotIn(
            "- \n- ", s.editor_value(), "Enter on an empty list item kept adding markers"
        )

        s.type_fresh("1. first")
        s.page.keyboard.press("End")
        s.page.keyboard.press("Enter")
        s.page.wait_for_timeout(150)
        self.assertEqual(
            "1. first\n2. ", s.editor_value(), "Enter did not continue an ordered list"
        )

        s.type_fresh("> quoted")
        s.page.keyboard.press("End")
        s.page.keyboard.press("Enter")
        s.page.wait_for_timeout(150)
        self.assertEqual(
            "> quoted\n> ", s.editor_value(), "Enter did not continue a blockquote"
        )

    def test_05d_bold_italic_link_wrap_the_selection(self):
        s = self.app()
        for keys, want, why in (
            ("b", "**word**", "bold"),
            ("i", "*word*", "italic"),
        ):
            s.type_fresh("word")
            s.page.keyboard.press(MOD + "+a")
            s.page.keyboard.press(MOD + "+" + keys)
            s.page.wait_for_timeout(150)
            self.assertEqual(
                want, s.editor_value(), "%s+%s did not %s the selection" % (MOD, keys, why)
            )

        s.type_fresh("word")
        s.page.keyboard.press(MOD + "+a")
        s.page.keyboard.press(MOD + "+k")
        s.page.wait_for_timeout(150)
        self.assertRegex(
            s.editor_value(),
            r"^\[word\]\(.*\)$",
            "%s+K did not turn the selection into a link" % MOD,
        )

    def test_05e_undo_after_tab_and_after_bold(self):
        s = self.app()

        s.type_fresh("alpha")
        before = s.editor_value()
        s.page.keyboard.press("Home")
        s.page.keyboard.press("Tab")
        s.page.wait_for_timeout(150)
        self.assertNotEqual(before, s.editor_value())
        s.page.keyboard.press(MOD + "+z")
        s.page.wait_for_timeout(200)
        self.assertEqual(
            before, s.editor_value(), "undo after Tab did not restore the previous text"
        )

        s.type_fresh("word")
        before = s.editor_value()
        s.page.keyboard.press(MOD + "+a")
        s.page.keyboard.press(MOD + "+b")
        s.page.wait_for_timeout(150)
        self.assertEqual("**word**", s.editor_value())
        s.page.keyboard.press(MOD + "+z")
        s.page.wait_for_timeout(200)
        self.assertEqual(
            before,
            s.editor_value(),
            "undo after %s+B did not restore the previous text" % MOD,
        )

        # ...and the preview follows the undo, not just the textarea.
        s.page.wait_for_timeout(250)
        self.assertNotIn("**", s.preview_text())
        self.assert_clean(s, "undo")

    def test_05f_multiline_tab_indents_the_block(self):
        s = self.app()
        s.type_fresh("one\ntwo")
        s.page.keyboard.press(MOD + "+a")
        s.page.keyboard.press("Tab")
        s.page.wait_for_timeout(150)
        self.assertEqual("  one\n  two", s.editor_value(), "Tab did not indent the selected block")
        s.page.keyboard.press(MOD + "+z")
        s.page.wait_for_timeout(200)
        self.assertEqual(
            "one\ntwo", s.editor_value(), "undo after a block indent did not restore the text"
        )

    # ==================================================================
    # 6. Persistence
    # ==================================================================
    def test_06_buffer_mode_theme_and_ratio_all_come_back(self):
        s = self.app()
        marker = "# persisted heading\n\nsentinel-9f3a text.\n"
        s.type_fresh(marker)

        self.set_theme(s, "dark")

        # Move the split with the gutter's own keyboard affordance.
        s.page.focus("#gutter")
        for _ in range(5):
            s.page.keyboard.press("ArrowLeft")
        s.page.wait_for_timeout(120)
        ratio_before = s.state()["ratio"]
        self.assertLess(ratio_before, 0.49, "ArrowLeft on the gutter did not narrow the editor")

        s.page.click("#btn-outline")
        s.page.wait_for_timeout(120)
        s.page.click("#mode-read")
        s.page.wait_for_timeout(700)

        s.reload()
        st = s.state()
        self.assertIn("sentinel-9f3a", s.editor_value(), "the buffer did not survive a reload")
        self.assertEqual("read", st["mode"], "mode did not survive a reload")
        self.assertEqual("dark", st["theme"], "theme did not survive a reload")
        self.assertAlmostEqual(
            ratio_before, st["ratio"], places=2, msg="split ratio did not survive a reload"
        )
        self.assertTrue(st["outlineOpen"], "outline open state did not survive a reload")
        self.assertIn("persisted heading", s.preview_text(), "preview did not re-render the buffer")
        self.assert_clean(s, "persistence reload")

        # ...and a wiped store cold-starts clean rather than blank or broken.
        # The clear has to run in the *next* document, before the app's own
        # script: navigating away fires `pagehide`, whose persistNow() would
        # otherwise write the buffer straight back over a clear done here.
        s.ctx.add_init_script("try { localStorage.clear(); } catch (e) {}")
        s.reload()
        cold = s.state()
        self.assertNotIn("sentinel-9f3a", s.editor_value(), "cleared storage still restored the buffer")
        self.assertGreater(cold["len"], 200, "cold start after a clear left an empty editor")
        self.assertEqual("split", cold["mode"], "cold start mode is not split")
        self.assertEqual("system", cold["theme"], "cold start theme is not system")
        self.assertAlmostEqual(0.5, cold["ratio"], places=2)
        self.assert_clean(s, "cold start after clearing storage")

    def test_06b_dirty_marker_and_filename(self):
        s = self.app()
        s.set_text("# clean\n", "opened.md")
        self.assertEqual("opened.md", s.page.inner_text("#status-name").strip())
        s.page.click("#editor")
        s.page.keyboard.type("x")
        s.page.wait_for_timeout(250)
        name = s.page.inner_text("#status-name")
        self.assertIn("opened.md", name)
        self.assertIn("•", name, "#status-name shows no dirty marker after an edit")

    # ==================================================================
    # 7. Layout
    # ==================================================================
    def test_07a_no_horizontal_page_scroll_at_any_size(self):
        problems = []
        for name, vp in VIEWPORTS:
            s = self.app(viewport=vp)
            for mode in ("split", "read", "edit"):
                s.page.click("#mode-%s" % mode)
                s.page.wait_for_timeout(200)
                o = s.page.evaluate(JS_PAGE_OVERFLOW)
                if o["docScroll"] > o["docClient"] + 1:
                    problems.append(
                        "%s %s: documentElement scrollWidth %d > clientWidth %d; offenders %s"
                        % (name, mode, o["docScroll"], o["docClient"], o["offenders"])
                    )
                if o["bodyScroll"] > o["bodyClient"] + 1:
                    problems.append(
                        "%s %s: body scrollWidth %d > clientWidth %d"
                        % (name, mode, o["bodyScroll"], o["bodyClient"])
                    )
            self.assert_clean(s, "layout at %s" % name)
        self.assertEqual([], problems, "horizontal page scroll:\n  " + "\n  ".join(problems))

    def test_07b_toolbar_does_not_overflow_or_overlap(self):
        problems = []
        for name, vp in VIEWPORTS:
            s = self.app(viewport=vp)
            tb = s.page.evaluate(JS_TOOLBAR)
            if tb["scrollWidth"] > tb["clientWidth"] + 1:
                hidden = [
                    b["id"]
                    for b in tb["buttons"]
                    if b["right"] > tb["rect"]["right"] + 1 or b["x"] < tb["rect"]["x"] - 1
                ]
                scrollbar = s.page.evaluate(
                    "() => getComputedStyle(document.getElementById('toolbar')).scrollbarWidth"
                )
                problems.append(
                    "%s: #toolbar needs %dpx in %dpx, so %d control(s) sit off-screen "
                    "(%s) behind a horizontal scroll with scrollbar-width:%s — no visible "
                    "affordance says they are there"
                    % (
                        name,
                        tb["scrollWidth"],
                        tb["clientWidth"],
                        len(hidden),
                        ", ".join("#" + h for h in hidden) or "(none)",
                        scrollbar,
                    )
                )
            for b in tb["buttons"]:
                if not b["visible"]:
                    continue
                if b["bottom"] > tb["rect"]["bottom"] + 1 or b["y"] < tb["rect"]["y"] - 1:
                    problems.append(
                        "%s: #%s escapes the toolbar vertically (%.0f..%.0f vs %.0f..%.0f)"
                        % (
                            name,
                            b["id"],
                            b["y"],
                            b["bottom"],
                            tb["rect"]["y"],
                            tb["rect"]["bottom"],
                        )
                    )
                if b["bottom"] > tb["panesTop"] + 1:
                    problems.append(
                        "%s: #%s overlaps the panes (bottom %.0f > panes top %.0f)"
                        % (name, b["id"], b["bottom"], tb["panesTop"])
                    )
            # No two visible buttons on the same row may overlap.
            vis = [b for b in tb["buttons"] if b["visible"]]
            for i in range(len(vis)):
                for j in range(i + 1, len(vis)):
                    a, c = vis[i], vis[j]
                    if a["y"] < c["bottom"] - 1 and c["y"] < a["bottom"] - 1:
                        if a["x"] < c["right"] - 1 and c["x"] < a["right"] - 1:
                            problems.append(
                                "%s: #%s and #%s overlap" % (name, a["id"], c["id"])
                            )
        self.assertEqual([], problems, "toolbar layout:\n  " + "\n  ".join(problems))

    def test_07c_wide_table_scrolls_inside_its_wrap(self):
        problems = []
        for name, vp in VIEWPORTS:
            s = self.app(viewport=vp)
            s.set_text(WIDE_TABLE, "wide.md")
            s.page.click("#mode-read")
            s.page.wait_for_timeout(300)
            got = s.page.evaluate(
                """() => {
                  const w = document.querySelector('#preview .md-table-wrap');
                  if (!w) return null;
                  const cs = getComputedStyle(w);
                  return { scrollWidth: w.scrollWidth, clientWidth: w.clientWidth,
                           overflowX: cs.overflowX,
                           tableW: w.querySelector('table').scrollWidth };
                }"""
            )
            if got is None:
                problems.append("%s: a GFM table did not render inside .md-table-wrap" % name)
                continue
            if got["overflowX"] not in ("auto", "scroll"):
                problems.append(
                    "%s: .md-table-wrap overflow-x is %r, so a wide table cannot scroll"
                    % (name, got["overflowX"])
                )
            if got["scrollWidth"] <= got["clientWidth"] + 1:
                problems.append(
                    "%s: a 25-column table did not become scrollable (%d in %d) — it was squeezed instead"
                    % (name, got["scrollWidth"], got["clientWidth"])
                )
            o = s.page.evaluate(JS_PAGE_OVERFLOW)
            if o["docScroll"] > o["docClient"] + 1:
                problems.append(
                    "%s: the wide table pushed the page sideways (%d > %d), offenders %s"
                    % (name, o["docScroll"], o["docClient"], o["offenders"])
                )
        self.assertEqual([], problems, "wide table:\n  " + "\n  ".join(problems))

    def test_07d_long_equation_scrolls_inside_its_box(self):
        problems = []
        for name, vp in VIEWPORTS:
            s = self.app(viewport=vp)
            s.set_text(LONG_EQUATION, "long.md")
            s.page.click("#mode-read")
            s.page.wait_for_timeout(350)
            got = s.page.evaluate(
                """() => {
                  const b = document.querySelector('#preview .md-math-block');
                  if (!b) return null;
                  const cs = getComputedStyle(b);
                  const m = b.querySelector('math');
                  return { scrollWidth: b.scrollWidth, clientWidth: b.clientWidth,
                           overflowX: cs.overflowX,
                           mathW: m ? m.getBoundingClientRect().width : 0,
                           mathScroll: m ? m.scrollWidth : 0 };
                }"""
            )
            if got is None:
                problems.append("%s: a $$…$$ block did not render inside .md-math-block" % name)
                continue
            if got["overflowX"] not in ("auto", "scroll"):
                problems.append(
                    "%s: .md-math-block overflow-x is %r" % (name, got["overflowX"])
                )
            if got["scrollWidth"] <= got["clientWidth"] + 1:
                problems.append(
                    "%s: a 39-term display equation did not become scrollable "
                    "(%d in %d, math width %.0f) — it was wrapped or clipped instead"
                    % (name, got["scrollWidth"], got["clientWidth"], got["mathW"])
                )
            o = s.page.evaluate(JS_PAGE_OVERFLOW)
            if o["docScroll"] > o["docClient"] + 1:
                problems.append(
                    "%s: the long equation pushed the page sideways (%d > %d), offenders %s"
                    % (name, o["docScroll"], o["docClient"], o["offenders"])
                )
        self.assertEqual([], problems, "long equation:\n  " + "\n  ".join(problems))

    def test_07e_tap_targets(self):
        """WCAG 2.2 AA wants 24x24 CSS px minimum; touch guidance wants 44.

        Failing at 24 and printing the rest keeps this honest: a 30px toolbar
        button is legal and still fiddly on a phone.
        """
        s = self.app(viewport=PHONE)
        sizes = s.page.evaluate(
            """() => [...document.querySelectorAll('#toolbar button')].map(b => {
                 const r = b.getBoundingClientRect();
                 return { id: b.id, w: Math.round(r.width), h: Math.round(r.height) };
               })"""
        )
        print("\ntap targets at 480x900:")
        for t in sizes:
            print("  %-12s %3dx%-3d %s" % (t["id"], t["w"], t["h"], "" if t["h"] >= 44 else "< 44"))
        tiny = [t for t in sizes if t["w"] < 24 or t["h"] < 24]
        self.assertEqual([], tiny, "toolbar controls below the 24x24 WCAG 2.2 minimum: %s" % tiny)

    # ==================================================================
    # 8. Outline
    # ==================================================================
    def test_08_outline_toggles_matches_headings_and_scrolls(self):
        s = self.app()
        self.assertTrue(
            s.page.evaluate("() => document.getElementById('outline').hidden"),
            "the outline is open on a cold start",
        )
        s.page.click("#btn-outline")
        s.page.wait_for_timeout(200)
        box = s.page.evaluate(
            "() => { const r = document.getElementById('outline').getBoundingClientRect();"
            " return { w: r.width, h: r.height }; }"
        )
        self.assertGreater(box["w"], 40, "#btn-outline did not reveal a visible outline")
        self.assertGreater(box["h"], 40)

        pair = s.page.evaluate(
            """() => {
              const norm = (t) => (t || '').replace(/\\s+/g, ' ').replace(/#\\s*$/, '').trim();
              const heads = [...document.querySelectorAll('#preview h1,#preview h2,#preview h3,#preview h4,#preview h5,#preview h6')]
                .map(h => { const c = h.cloneNode(true);
                            c.querySelectorAll('.md-anchor').forEach(a => a.remove());
                            return norm(c.textContent); });
              const links = [...document.querySelectorAll('#toc a')].map(a => norm(a.textContent));
              const targets = [...document.querySelectorAll('#toc a')].map(a => a.getAttribute('href') || a.dataset.heading || '');
              const ids = [...document.querySelectorAll('#preview [id]')].map(e => e.id);
              return { heads, links, targets, ids };
            }"""
        )
        self.assertGreater(len(pair["heads"]), 5, "the demo document has no headings to outline")
        self.assertEqual(
            pair["heads"],
            pair["links"],
            "outline entries do not match the rendered headings\n  headings: %s\n  outline:  %s"
            % (pair["heads"], pair["links"]),
        )
        dangling = [
            t
            for t in pair["targets"]
            if t and t.lstrip("#") and t.lstrip("#") not in pair["ids"]
        ]
        self.assertEqual([], dangling, "outline entries point at ids that do not exist: %s" % dangling)

        before = s.page.evaluate("() => document.getElementById('preview-pane').scrollTop")
        links = s.page.query_selector_all("#toc a")
        s.page.evaluate(
            "() => { const l = document.querySelectorAll('#toc a'); l[l.length - 1].scrollIntoView(); }"
        )
        links[-1].click()
        s.page.wait_for_timeout(600)
        after = s.page.evaluate("() => document.getElementById('preview-pane').scrollTop")
        self.assertGreater(
            after,
            before + 20,
            "clicking the last outline entry did not scroll the preview (%s -> %s)"
            % (before, after),
        )

        # Informational: an entry clipped by the sidebar with no tooltip is
        # unreadable. Printed rather than failed — it is polish, not a defect.
        clipped = s.page.evaluate(
            """() => [...document.querySelectorAll('#toc a')]
                 .filter(a => a.scrollWidth > a.clientWidth + 1)
                 .map(a => ({ text: a.textContent.trim(), title: a.getAttribute('title') }))"""
        )
        if clipped:
            print(
                "\n%d outline entries are visually clipped; %d of those carry a title tooltip"
                % (len(clipped), sum(1 for c in clipped if c["title"]))
            )
            for c in clipped[:4]:
                print("  %-40s title=%r" % (c["text"][:40], c["title"]))

        s.page.click("#btn-outline")
        s.page.wait_for_timeout(200)
        self.assertTrue(
            s.page.evaluate("() => document.getElementById('outline').hidden"),
            "#btn-outline did not close the outline again",
        )
        self.assert_clean(s, "outline")

    # ==================================================================
    # 9. Keyboard / help sheet
    # ==================================================================
    def test_09a_help_dialog_opens_and_escape_closes_it(self):
        s = self.app()
        self.assertFalse(s.page.evaluate("() => document.getElementById('help').open"))
        s.page.click("#btn-help")
        s.page.wait_for_timeout(250)
        self.assertTrue(
            s.page.evaluate("() => document.getElementById('help').open"),
            "#btn-help did not open #help",
        )
        box = s.page.evaluate(
            "() => { const r = document.getElementById('help').getBoundingClientRect();"
            " return { w: r.width, h: r.height }; }"
        )
        self.assertGreater(box["w"], 100, "#help opened with no painted box")
        self.assertGreater(
            s.page.evaluate("() => document.querySelectorAll('#help-table tr').length"),
            4,
            "the help sheet lists no shortcuts",
        )
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(250)
        self.assertFalse(
            s.page.evaluate("() => document.getElementById('help').open"),
            "Escape did not close #help",
        )

        # `?` opens it too, but only when the editor is not focused.
        s.page.evaluate("() => document.getElementById('editor').blur()")
        s.page.click("#preview")
        s.page.keyboard.press("?")
        s.page.wait_for_timeout(250)
        self.assertTrue(
            s.page.evaluate("() => document.getElementById('help').open"),
            "`?` outside the editor did not open the help sheet",
        )
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(150)
        s.page.click("#editor")
        s.page.keyboard.press("?")
        s.page.wait_for_timeout(200)
        self.assertFalse(
            s.page.evaluate("() => document.getElementById('help').open"),
            "`?` typed in the editor opened the help sheet instead of typing a question mark",
        )
        self.assert_clean(s, "help dialog")

    def test_09b_every_row_in_the_help_sheet_is_actually_bound(self):
        s = self.app()
        s.page.click("#btn-help")
        s.page.wait_for_timeout(200)
        rows = s.page.evaluate(
            """() => [...document.querySelectorAll('#help-table tr')].map(tr => ({
                 keys: (tr.querySelector('kbd') || tr.querySelector('th')).textContent.trim(),
                 label: (tr.querySelector('td') || {}).textContent || '' }))"""
        )
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(150)
        self.assertGreater(len(rows), 4)
        print("\nhelp sheet rows:")
        for r in rows:
            print("  %-12s %s" % (r["keys"], r["label"]))

        confirmed: dict[str, str] = {}
        unconfirmed: list[str] = []
        problems: list[str] = []

        def note(keys, how):
            confirmed[keys] = how

        # --- mode cycle -------------------------------------------------
        s.page.click("#mode-edit")
        s.page.wait_for_timeout(120)
        s.page.keyboard.press(MOD + "+\\")
        s.page.wait_for_timeout(150)
        if s.mode() == "split":
            note("\\", "mode edit -> split")
        else:
            problems.append("%s+\\ did not cycle the mode (still %s)" % (MOD, s.mode()))

        # --- theme cycle ------------------------------------------------
        was = s.theme()
        s.page.keyboard.press(MOD + "+/")
        s.page.wait_for_timeout(150)
        if s.theme() != was:
            note("/", "theme %s -> %s" % (was, s.theme()))
        else:
            problems.append("%s+/ did not cycle the theme (still %s)" % (MOD, was))

        # --- outline ----------------------------------------------------
        was_open = s.page.evaluate("() => !document.getElementById('outline').hidden")
        s.page.keyboard.press(MOD + "+Shift+o")
        s.page.wait_for_timeout(150)
        now_open = s.page.evaluate("() => !document.getElementById('outline').hidden")
        if now_open != was_open:
            note("O (shift)", "outline toggled")
        else:
            problems.append("%s+Shift+O did not toggle the outline" % MOD)

        # --- bold / italic / link --------------------------------------
        for key, want in (("b", "**word**"), ("i", "*word*")):
            s.type_fresh("word")
            s.page.keyboard.press(MOD + "+a")
            s.page.keyboard.press(MOD + "+" + key)
            s.page.wait_for_timeout(150)
            if s.editor_value() == want:
                note(key.upper(), "wrapped selection")
            else:
                problems.append(
                    "%s+%s produced %r, expected %r" % (MOD, key.upper(), s.editor_value(), want)
                )
        s.type_fresh("word")
        s.page.keyboard.press(MOD + "+a")
        s.page.keyboard.press(MOD + "+k")
        s.page.wait_for_timeout(150)
        if re.match(r"^\[word\]\(.*\)$", s.editor_value()):
            note("K", "link wrap")
        else:
            problems.append("%s+K produced %r" % (MOD, s.editor_value()))

        # --- print ------------------------------------------------------
        s.page.keyboard.press(MOD + "+p")
        s.page.wait_for_timeout(200)
        calls = s.page.evaluate("() => window.__printCalls || 0")
        if calls >= 1:
            note("P", "window.print() called")
        else:
            problems.append("%s+P did not call window.print()" % MOD)

        # --- open (file dialog) ----------------------------------------
        try:
            with s.page.expect_file_chooser(timeout=3000):
                s.page.keyboard.press(MOD + "+o")
            note("O", "file chooser opened")
        except PWTimeout:
            problems.append("%s+O did not open a file chooser" % MOD)

        # --- save -------------------------------------------------------
        s.type_fresh("# saved\n")
        try:
            with s.page.expect_download(timeout=4000) as dl:
                s.page.keyboard.press(MOD + "+s")
            name = dl.value.suggested_filename
            note("S", "download offered as %r" % name)
        except (PWTimeout, PWError) as exc:
            problems.append(
                "%s+S produced no download and no #status-msg (msg=%r) — see "
                "test_09c for the isolation: a plain blob download from this same "
                "file:// page works, so the app is losing it. (%s)"
                % (MOD, s.page.inner_text("#status-msg"), type(exc).__name__)
            )

        # --- Tab / Shift-Tab / Enter / Esc ------------------------------
        s.type_fresh("alpha")
        s.page.keyboard.press("Home")
        s.page.keyboard.press("Tab")
        s.page.wait_for_timeout(120)
        if s.editor_value() == "  alpha":
            note("Tab", "indent")
        else:
            problems.append("Tab produced %r" % s.editor_value())
        s.page.keyboard.press("Shift+Tab")
        s.page.wait_for_timeout(120)
        if s.editor_value() == "alpha":
            note("Tab (shift)", "outdent")
        else:
            problems.append("Shift+Tab produced %r" % s.editor_value())

        s.type_fresh("- item")
        s.page.keyboard.press("End")
        s.page.keyboard.press("Enter")
        s.page.wait_for_timeout(150)
        if s.editor_value() == "- item\n- ":
            note("Enter", "list continuation")
        else:
            problems.append("Enter produced %r" % s.editor_value())

        s.page.click("#btn-help")
        s.page.wait_for_timeout(200)
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(200)
        if not s.page.evaluate("() => document.getElementById('help').open"):
            note("Esc", "closes the dialog")
        else:
            problems.append("Escape did not close #help")

        s.page.evaluate("() => document.getElementById('editor').blur()")
        s.page.click("#preview")
        s.page.keyboard.press("?")
        s.page.wait_for_timeout(200)
        if s.page.evaluate("() => document.getElementById('help').open"):
            note("?", "opens help")
        else:
            problems.append("`?` did not open the help sheet")
        s.page.keyboard.press("Escape")

        # Match every printed row to something observed.
        for r in rows:
            keys = r["keys"]
            tail = keys.split()[-1] if keys.split() else keys
            hit = any(
                k == keys or k == tail or (k.lower() in keys.lower()) for k in confirmed
            )
            if not hit:
                unconfirmed.append("%s — %s (not observable from a test)" % (keys, r["label"].strip()))

        if unconfirmed:
            print("\nunconfirmed help rows:\n  " + "\n  ".join(unconfirmed))
        self.assertEqual(
            [], problems, "help sheet rows that are not bound:\n  " + "\n  ".join(problems)
        )

    def test_09c_save_actually_produces_a_file(self):
        """Isolate the Save path: browser refusal, or the app swallowing it?

        A plain `<a download>` on a blob URL is attempted first from the very
        same `file://` page. If that download arrives and the app's own Save
        does not, the loss is the app's.
        """
        s = self.app()
        raw_ok = True
        try:
            with s.page.expect_download(timeout=4000):
                s.page.evaluate(
                    """() => {
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(new Blob(['probe'], { type: 'text/plain' }));
                      a.download = 'probe.txt';
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                    }"""
                )
        except (PWTimeout, PWError):
            raw_ok = False

        s.set_text("# save me\n\nbody\n", "keepme.md")
        s.page.click("#editor")
        s.page.keyboard.type("x")
        s.page.wait_for_timeout(200)

        saved = None
        try:
            with s.page.expect_download(timeout=5000) as dl:
                s.page.click("#btn-save")
            saved = dl.value
        except (PWTimeout, PWError):
            saved = None

        msg = s.page.inner_text("#status-msg").strip()
        if saved is None:
            self.assertFalse(
                raw_ok,
                "#btn-save produced no file and no message (#status-msg=%r), while a "
                "plain blob download from the same file:// page succeeded — Save is "
                "silently doing nothing. On file:// Chromium rejects "
                "showSaveFilePicker with AbortError, which saveFile() treats as "
                "'user cancelled' and returns without ever reaching downloadBlob." % msg,
            )
            self.skipTest("this browser blocks downloads from file:// entirely")

        self.assertEqual(
            "keepme.md",
            saved.suggested_filename,
            "Save did not keep the opened filename",
        )
        body = Path(saved.path()).read_text(encoding="utf-8")
        self.assertIn("save me", body, "the saved file does not contain the buffer")
        self.assertTrue(body.endswith("x") or "x" in body.splitlines()[-1])
        s.page.wait_for_timeout(200)
        self.assertNotIn(
            "•", s.page.inner_text("#status-name"), "a successful save left the document dirty"
        )

    def test_09d_keyboard_can_leave_the_editor(self):
        """WCAG 2.1.2 (Level A): no keyboard trap.

        Tab must insert spaces — that is the contract — but a keyboard-only
        user still has to be able to get *out*. Tab is consumed, Shift-Tab is
        consumed even when there is no indent to remove, and Escape is not
        wired, so `#gutter` and every link in the preview become unreachable
        once focus lands in the textarea.
        """
        s = self.app()
        s.set_text("plain line with no indent\n", "trap.md")
        s.page.click("#editor")
        s.page.keyboard.press("Home")
        before = s.editor_value()

        tried = []
        for keys in ("Shift+Tab", "Escape", "Tab", "Escape", "Shift+Tab"):
            s.page.keyboard.press(keys)
            s.page.wait_for_timeout(90)
            where = s.page.evaluate("() => document.activeElement.id")
            tried.append("%s -> #%s" % (keys, where))
            if where != "editor":
                return  # an escape hatch exists; nothing to report

        after_focusable = s.page.evaluate(
            """() => {
              const all = [...document.querySelectorAll('a[href],button,textarea,[tabindex]')]
                .filter(e => e.offsetParent !== null || e.id === 'editor');
              const i = all.findIndex(e => e.id === 'editor');
              return all.slice(i + 1, i + 4).map(e => e.id || e.tagName);
            }"""
        )
        self.fail(
            "focus is trapped in #editor: %s (buffer unchanged: %s). Unreachable "
            "focus targets after it: %s. The help sheet lists no way out either."
            % ("; ".join(tried), before == s.editor_value(), after_focusable)
        )

    # ==================================================================
    # 10. Drag and drop
    # ==================================================================
    def test_10_drop_a_markdown_file(self):
        s = self.app()
        text = "# dropped title\n\nDropped body with a $x^2$ formula.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n"
        s.page.evaluate(JS_DROP_FILE, {"text": text, "name": "dropped-doc.md"})
        try:
            s.page.wait_for_function(
                "() => document.getElementById('editor').value.indexOf('dropped title') >= 0",
                timeout=4000,
            )
        except PWTimeout:
            self.fail(
                "a synthetic file drop did not load into the editor (editor still %r...)"
                % s.editor_value()[:60]
            )
        s.page.wait_for_timeout(350)
        self.assertIn("dropped title", s.editor_value())
        self.assertIn(
            "dropped-doc.md",
            s.page.inner_text("#status-name"),
            "#status-name did not update to the dropped filename",
        )
        self.assertIn("dropped title", s.preview_text(), "the dropped document did not render")
        self.assertGreater(
            s.page.evaluate("() => document.querySelectorAll('#preview math').length"),
            0,
            "the dropped document's math did not render",
        )
        self.assertTrue(
            s.page.evaluate("() => document.getElementById('drop').hidden"),
            "the drop overlay stayed up after the drop completed",
        )
        self.assert_clean(s, "drag and drop")

    def test_10b_dragover_shows_the_overlay(self):
        s = self.app()
        s.page.evaluate(
            """() => {
              const dt = new DataTransfer();
              dt.items.add(new File(['x'], 'x.md', { type: 'text/markdown' }));
              window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
            }"""
        )
        s.page.wait_for_timeout(80)
        self.assertFalse(
            s.page.evaluate("() => document.getElementById('drop').hidden"),
            "dragging a file over the window showed no drop affordance",
        )

    # ==================================================================
    # Stretchy fences
    # ==================================================================
    def test_matrix_fences_stretch_to_their_content(self):
        """`\\left(` around a pmatrix must grow to the matrix's height.

        This is a font capability, not a markup one: stretching needs a face
        carrying an OpenType MATH table with glyph size variants. With none
        resolved, a 2-row pmatrix rendered with 13.8px parentheses beside a
        38.5px matrix — valid MathML that reads as broken typesetting. The
        `--math` token in theme.css names the faces because the generic `math`
        keyword alone did not resolve to an installed math font in Chromium.
        """
        s = self.app()
        s.page.click("#mode-read")
        s.page.wait_for_timeout(300)
        s.page.eval_on_selector("#preview math mtable", "e => e.scrollIntoView()")
        s.page.wait_for_timeout(400)
        got = s.page.evaluate(
            """() => {
              const t = document.querySelector('#preview math mtable');
              if (!t) return null;
              const row = t.closest('mrow') || t.parentElement;
              const fences = [...row.querySelectorAll(':scope > mo')]
                .filter(o => '()[]{}'.includes(o.textContent.trim()));
              return {
                table: t.getBoundingClientRect().height,
                fences: fences.map(f => f.getBoundingClientRect().height),
              };
            }"""
        )
        self.assertIsNotNone(got, "the demo document rendered no mtable")
        self.assertTrue(got["fences"], "the matrix rendered without fence operators")
        self.assertGreater(got["table"], 20, "mtable did not lay out")
        for h in got["fences"]:
            self.assertGreaterEqual(
                h,
                got["table"] * 0.8,
                "fence is %.1fpx against a %.1fpx matrix — not stretching; is "
                "var(--math) still applied to `math` in markdown.css?"
                % (h, got["table"]),
            )

    # ==================================================================
    # Cold-load caret position
    # ==================================================================
    def test_cold_load_starts_at_the_top_of_the_document(self):
        """A cold load must put the caret at offset 0, not at the end.

        Assigning `editor.value` leaves the caret at the END of the buffer, and
        the boot code guarded its `setSelectionRange` with `if (restored.caret)`
        — falsy at 0. Nothing was visibly wrong until focus first reached the
        editor, at which point the browser scrolled the caret into view and threw
        the reader to the last line of an 11k-character document. Pressing the
        documented ⌘\\ mode shortcut twice was enough to do it.
        """
        s = self.app()
        self.assertEqual(
            s.page.evaluate("() => document.getElementById('editor').selectionStart"),
            0,
            "cold load left the caret somewhere other than offset 0",
        )

        def scrolls():
            return s.page.evaluate(
                "() => [document.getElementById('preview-pane').scrollTop,"
                " document.getElementById('editor').scrollTop]"
            )

        self.assertEqual(scrolls(), [0, 0], "cold load did not start at the top")

        # Focus arriving in the editor must not move the view. Cycle mode with
        # the keyboard, which is how a user reaches this.
        for _ in range(3):
            s.page.keyboard.press(MOD + "+\\")
            s.page.wait_for_timeout(250)
            self.assertEqual(
                scrolls(), [0, 0], "a mode cycle scrolled the document away from the top"
            )

        # A synthetic click on the already-active mode button is the other route
        # in: it leaves focus on <body>, so setMode's refocus fires.
        s.page.evaluate("() => document.getElementById('mode-split').click()")
        s.page.wait_for_timeout(300)
        self.assertEqual(
            scrolls(), [0, 0], "re-clicking the active mode button jumped the panes"
        )

    def test_opening_a_file_starts_at_its_first_line(self):
        """setText must reset BOTH panes, not only the preview."""
        s = self.app()
        s.page.evaluate(
            "() => { document.getElementById('editor').scrollTop = 4000;"
            " document.getElementById('preview-pane').scrollTop = 4000; }"
        )
        s.page.wait_for_timeout(200)
        s.set_text("# Fresh\n\n" + "\n\n".join("Body %d." % i for i in range(400)),
                   "fresh.md")
        s.page.wait_for_timeout(300)
        self.assertEqual(
            s.page.evaluate(
                "() => [document.getElementById('preview-pane').scrollTop,"
                " document.getElementById('editor').scrollTop]"
            ),
            [0, 0],
            "a newly opened document did not start at its first line",
        )

    # ==================================================================
    # Screenshots for the next phase
    # ==================================================================
    def test_99_screenshots(self):
        s = self.app()
        self.set_theme(s, "light")
        s.page.wait_for_timeout(250)
        s.page.screenshot(path=str(ARTIFACTS / "light.png"))

        self.set_theme(s, "dark")
        s.page.wait_for_timeout(250)
        s.page.screenshot(path=str(ARTIFACTS / "dark.png"))

        self.set_theme(s, "light")
        s.page.click("#btn-outline")
        s.page.click("#mode-read")
        s.page.wait_for_timeout(300)
        s.page.screenshot(path=str(ARTIFACTS / "read-mode.png"))

        m = self.app(viewport=PHONE)
        m.page.wait_for_timeout(300)
        m.page.screenshot(path=str(ARTIFACTS / "mobile.png"), full_page=False)

        for f in ("light.png", "dark.png", "read-mode.png", "mobile.png"):
            self.assertTrue((ARTIFACTS / f).exists(), "missing screenshot %s" % f)


if __name__ == "__main__":
    unittest.main(verbosity=2)
