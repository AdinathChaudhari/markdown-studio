#!/usr/bin/env python3
"""Does the MathML `src/tex.js` emits actually PAINT?

    ~/.venvs/main/bin/python tests/mathml_render.py
    ~/.venvs/main/bin/python tests/mathml_render.py -v MathMLRenderTest

`tests/test_tex.mjs` proves the markup has the right shape. It cannot prove the
browser can lay that markup out, and that is the failure mode that matters here:
a `<math>` element with perfect children, present in the DOM, painting a box of
zero width. MathML Core dropped several MathML 3 elements and attributes
(`menclose`, `linebreak`, negative `mspace` widths, `columnspacing`), so markup
that reads correctly can be silently ignored by the engine. Width and height are
the only honest check.

This is deliberately NOT a test of `markdown-studio.html` — `tests/
browser_smoke.py` owns the built artefact. Here the page is a throwaway
containing `src/tex.js` and nothing else: no app CSS, no markdown renderer, no
`localStorage`. If a formula paints here, it paints because of MathML, not
because a stylesheet propped it up.

Two conventions worth not rediscovering:

* `PLAYWRIGHT_BROWSERS_PATH` must be pinned **before** `playwright` is imported,
  or it decides Chromium is missing and asks you to reinstall it.
* Geometry, not markup, is the assertion. "Is there an `<mfrac>`" is answered in
  the node tests; here the question is "is the fraction TALLER than its
  numerator", which only a real layout can answer.

`KnownRenderGapsTest` at the bottom holds the four cases where valid markup
painted nothing at all in Chromium. Each was an `expectedFailure` carrying its
measured numbers; all four were fixed in tex.js on 2026-08-10 and the decorators
dropped, which is the documented signal — an unexpected success fails the run.
The docstrings keep the before/after numbers so a regression reads as a return
to a known-bad state rather than as a fresh mystery.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEX_JS = ROOT / "src" / "tex.js"

os.environ.setdefault(
    "PLAYWRIGHT_BROWSERS_PATH",
    str(Path.home() / "Library" / "Caches" / "ms-playwright"),
)

from playwright.sync_api import sync_playwright  # noqa: E402

VIEWPORT = {"width": 1100, "height": 900}

# (name, tex, display). Real formulas, in the shapes people actually write:
# every structural construct the contract names appears at least once, and each
# uses only commands tex.js claims to support, so `md-tex-unknown` anywhere in
# this corpus is a bug rather than a limitation.
FORMULAS: list[tuple[str, str, bool]] = [
    ("euler",        r"e^{i\pi} + 1 = 0", False),
    ("gaussian",     r"\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}", True),
    ("basel",        r"\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}", True),
    ("heat",         r"\frac{\partial u}{\partial t} = \alpha \nabla^2 u", True),
    ("eigen",        r"\mathbf{A}\mathbf{x} = \lambda \mathbf{x}", False),
    ("pmatrix_inv",  r"\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}^{-1}", True),
    ("bmatrix_dots", r"\begin{bmatrix} a_{11} & \cdots & a_{1n} \\ "
                     r"\vdots & \ddots & \vdots \\ "
                     r"a_{m1} & \cdots & a_{mn} \end{bmatrix}", True),
    ("cases",        r"f(x) = \begin{cases} x^2 & x \ge 0 \\ "
                     r"-x^2 & x < 0 \end{cases}", True),
    ("aligned",      r"\begin{aligned} (a+b)^2 &= a^2 + 2ab + b^2 \\ "
                     r"&= b^2 + 2ab + a^2 \end{aligned}", True),
    ("array_spec",   r"\begin{array}{c|cc} & 0 & 1 \\ \hline "
                     r"0 & 0 & 1 \end{array}", True),
    ("vmatrix",      r"\begin{vmatrix} \alpha & \beta \\ "
                     r"\gamma & \delta \end{vmatrix}", True),
    ("norm",         r"\left\| \vec{v} \right\|_2 = \sqrt{\sum_i v_i^2}", True),
    ("braket",       r"\left\langle \psi \middle| \phi \right\rangle", False),
    ("ceil_floor",   r"\left\lceil \frac{n}{2} \right\rceil + "
                     r"\left\lfloor \frac{n}{2} \right\rfloor = n", True),
    ("derivative",   r"\lim_{h \to 0} \frac{f(x+h) - f(x)}{h}", True),
    ("bayes",        r"P(A \mid B) = \frac{P(B \mid A)\,P(A)}{P(B)}", True),
    ("nll",          r"\mathcal{L}(\theta) = -\frac{1}{N}"
                     r"\sum_{i=1}^{N} \log p_\theta(y_i)", True),
    ("binomial",     r"\binom{n}{k} = \frac{n!}{k!\,(n-k)!}", True),
    ("cuberoot",     r"\sqrt[3]{x^2 + y^2}", False),
    ("de_morgan",    r"\overline{A \cup B} = \overline{A} \cap \overline{B}", False),
    ("epsilon_delta", r"\forall \varepsilon > 0\ \exists \delta > 0 : "
                      r"|x - a| < \delta \Rightarrow |f(x) - f(a)| < \varepsilon", True),
    ("gamma_fn",     r"\Gamma(z) = \int_0^\infty t^{z-1} e^{-t}\,\mathrm{d}t", True),
    ("regression",  r"\hat{y} = \mathbf{w}^\top \mathbf{x} + b", False),
    ("variance",     r"\operatorname{Var}(X) = \operatorname{E}[X^2] - "
                     r"(\operatorname{E}[X])^2", True),
    ("supremum",     r"\max_{x \in \mathcal{X}} f(x) \le \sup_x f(x)", True),
    ("second_deriv", r"f''(x) + \omega^2 f(x) = 0", False),
    ("underbrace",   r"\underbrace{a + \cdots + a}_{n\text{ times}} = na", True),
    ("colour",       r"\color{crimson}{\Delta} = b^2 - 4ac", False),
    ("spacing",      r"a\,b\:c\;d\quad e\qquad f", False),
    ("greek_zoo",    r"\theta\ \vartheta\ \Theta\ \varphi\ \Phi\ \varSigma", False),
]

# One page, built once. Every test reads geometry off it, so nothing here
# mutates the DOM after setUpClass beyond appending its own probe nodes.
PAGE = """<!doctype html>
<meta charset="utf-8">
<title>tex.js render probe</title>
<style>
  /* No app CSS on purpose: a formula must paint on its own. A predictable
     font-size is the only thing set, so the measured numbers mean something. */
  html { font-size: 16px; }
  body { margin: 0; padding: 16px; font-family: serif; }
  #stage > div { margin: 0; padding: 0; }
</style>
<body>
<div id="stage"></div>
<script>
%s
</script>
"""

# --------------------------------------------------------------------------- #
# browser-side helpers, injected once and reused by every test                 #
# --------------------------------------------------------------------------- #

HELPERS = """() => {
  const stage = document.getElementById('stage');

  /* Render one formula into its own div and return the <math> box plus every
   * glyph-bearing leaf inside it. `mphantom` is skipped: painting nothing is
   * the whole point of a phantom. */
  window.__render = (tex, display) => {
    const host = document.createElement('div');
    host.innerHTML = window.TeX.toMathML(tex, display);
    stage.appendChild(host);
    const math = host.querySelector('math');
    const err = host.querySelector('.md-math-error');
    const unknown = host.querySelector('.md-tex-unknown');
    const out = {
      html: host.innerHTML,
      hasMath: !!math,
      error: err ? err.textContent : null,
      unknown: unknown ? unknown.textContent : null,
      leaves: []
    };
    if (math) {
      const r = math.getBoundingClientRect();
      out.width = r.width;
      out.height = r.height;
      out.display = getComputedStyle(math).display;
      out.tagCount = math.querySelectorAll('*').length;
      for (const el of math.querySelectorAll('mi, mn, mo, mtext')) {
        if (!el.textContent.trim()) continue;
        if (el.closest('mphantom')) continue;
        const b = el.getBoundingClientRect();
        out.leaves.push({
          tag: el.tagName.toLowerCase(),
          text: el.textContent,
          width: b.width,
          height: b.height
        });
      }
    }
    host.remove();
    return out;
  };

  /* Just the box, for the comparative geometry tests. */
  window.__box = (tex, display) => {
    const o = window.__render(tex, display);
    return { w: o.width || 0, h: o.height || 0, hasMath: o.hasMath };
  };
  return true;
}"""


class _Browser(unittest.TestCase):
    """Shared Chromium + probe page. Subclasses get `self.render` / `self.box`."""

    @classmethod
    def setUpClass(cls) -> None:
        if not TEX_JS.exists():                     # pragma: no cover
            raise unittest.SkipTest(f"missing {TEX_JS}")
        src = TEX_JS.read_text(encoding="utf-8")
        if "</script" in src:                       # pragma: no cover
            raise AssertionError("src/tex.js cannot be inlined into a <script>")
        cls._tmp = tempfile.TemporaryDirectory()
        page = Path(cls._tmp.name) / "tex_probe.html"
        page.write_text(PAGE % src, encoding="utf-8")

        cls._pw = sync_playwright().start()
        cls._browser = cls._pw.chromium.launch()
        cls.page = cls._browser.new_page(viewport=VIEWPORT)
        cls.console: list[str] = []
        cls.page.on("console", lambda m: cls.console.append(f"{m.type}: {m.text}")
                    if m.type in ("error", "warning") else None)
        cls.page.on("pageerror", lambda e: cls.console.append(f"pageerror: {e}"))
        cls.page.goto(page.as_uri())
        assert cls.page.evaluate("() => typeof window.TeX === 'object'"), (
            "src/tex.js did not assign window.TeX in the browser"
        )
        cls.page.evaluate(HELPERS)

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls._browser.close()
            cls._pw.stop()
        finally:
            cls._tmp.cleanup()

    # -- conveniences -------------------------------------------------------
    def render(self, tex: str, display: bool) -> dict:
        return self.page.evaluate("([t, d]) => window.__render(t, d)", [tex, display])

    def box(self, tex: str, display: bool = False) -> dict:
        return self.page.evaluate("([t, d]) => window.__box(t, d)", [tex, display])


class MathMLRenderTest(_Browser):
    """The corpus: every formula must become a painted <math>."""

    def test_every_formula_produces_a_math_element(self) -> None:
        for name, tex, display in FORMULAS:
            with self.subTest(formula=name):
                out = self.render(tex, display)
                self.assertIsNone(out["error"], f"{name}: md-math-error for {tex!r}")
                self.assertTrue(out["hasMath"], f"{name}: no <math> for {tex!r}")
                self.assertGreater(out["tagCount"], 0, f"{name}: empty <math>")

    def test_every_formula_paints_a_non_empty_box(self) -> None:
        """Width and height both > 0 — the check zero-width MathML fails."""
        for name, tex, display in FORMULAS:
            with self.subTest(formula=name):
                out = self.render(tex, display)
                self.assertGreater(out["width"], 0,
                                   f"{name} painted no width: {out['html'][:160]}")
                self.assertGreater(out["height"], 0,
                                   f"{name} painted no height: {out['html'][:160]}")

    def test_no_well_formed_formula_reports_an_error(self) -> None:
        for name, tex, display in FORMULAS:
            with self.subTest(formula=name):
                self.assertIsNone(self.render(tex, display)["error"], name)

    def test_no_formula_hits_an_unsupported_command(self) -> None:
        """Every command in the corpus is one tex.js claims to support."""
        for name, tex, display in FORMULAS:
            with self.subTest(formula=name):
                self.assertIsNone(self.render(tex, display)["unknown"],
                                  f"{name}: {tex!r} degraded to md-tex-unknown")

    def test_every_glyph_paints(self) -> None:
        """Every mi/mn/mo/mtext with text in it must have a non-zero box.

        This is where a bad code point shows up: `<mo></mo>` around a character
        the engine cannot lay out is invisible to any markup assertion.
        """
        for name, tex, display in FORMULAS:
            with self.subTest(formula=name):
                out = self.render(tex, display)
                self.assertGreater(len(out["leaves"]), 0, f"{name}: no glyphs")
                dead = [leaf for leaf in out["leaves"]
                        if leaf["width"] <= 0 or leaf["height"] <= 0]
                self.assertEqual(dead, [], f"{name}: invisible glyphs {dead}")

    def test_the_whole_corpus_paints_in_the_other_mode_too(self) -> None:
        """Flipping display must not blank a formula (limits move, nothing else)."""
        for name, tex, display in FORMULAS:
            with self.subTest(formula=name):
                out = self.render(tex, not display)
                self.assertIsNone(out["error"], name)
                self.assertGreater(out["width"], 0, name)
                self.assertGreater(out["height"], 0, name)

    def test_no_console_errors(self) -> None:
        for _name, tex, display in FORMULAS:
            self.render(tex, display)
        self.assertEqual(self.console, [])


class LayoutGeometryTest(_Browser):
    """Markup is not layout. These assert the engine really built the box."""

    def test_display_attribute_reaches_the_computed_style(self) -> None:
        # Chromium reports `block math` for display="block" and plain `math`
        # for inline — so the discriminator is the presence of "block".
        block = self.render(r"\frac12", True)["display"]
        inline = self.render(r"\frac12", False)["display"]
        self.assertIn("math", block)
        self.assertIn("math", inline)
        self.assertIn("block", block)
        self.assertNotIn("block", inline)

    def test_a_fraction_stacks(self) -> None:
        """Taller than the same two glyphs side by side, and narrower."""
        frac = self.box(r"\frac{a}{b}")
        flat = self.box(r"ab")
        self.assertGreater(frac["h"], flat["h"] * 1.25,
                           f"mfrac did not stack: {frac} vs {flat}")
        self.assertLess(frac["w"], flat["w"],
                        f"mfrac is as wide as the flat form: {frac} vs {flat}")

    def test_a_radical_draws_its_sign_and_its_index(self) -> None:
        bare = self.box(r"x")
        root = self.box(r"\sqrt{x}")
        cube = self.box(r"\sqrt[3]{x}")
        self.assertGreater(root["w"], bare["w"], "no radical sign was drawn")
        self.assertGreater(root["h"], bare["h"], "no radical overbar was drawn")
        self.assertGreater(cube["w"], root["w"], "the [3] index was not drawn")

    def test_a_superscript_raises_and_widens(self) -> None:
        plain = self.box(r"x")
        sup = self.box(r"x^2")
        self.assertGreater(sup["w"], plain["w"])
        self.assertGreater(sup["h"], plain["h"], "msup did not raise the exponent")

    def test_display_limits_sit_above_and_below(self) -> None:
        """The contract's display-vs-inline limit rule, measured."""
        block = self.box(r"\sum_{i=1}^{n} i", True)
        inline = self.box(r"\sum_{i=1}^{n} i", False)
        self.assertGreater(block["h"], inline["h"] * 1.3,
                           f"munderover is no taller than msubsup: {block} vs {inline}")

    def test_integral_limits_stay_beside_the_sign_in_display_mode(self) -> None:
        r"""Beside, not above — measured against a \sum, which does go above.

        Widths are useless here: a display <math> is a block and fills its
        container, so both forms measure the container. Height is the signal.
        """
        wide = self.box(r"\int_{0}^{1} x", False)
        narrow = self.box(r"\int x", False)
        self.assertGreater(wide["w"], narrow["w"], "the limits were not drawn")

        integral = self.box(r"\int_{0}^{1} x", True)
        summation = self.box(r"\sum_{0}^{1} x", True)
        self.assertLess(integral["h"], summation["h"],
                        "\\int limits appear to have gone above/below")

    def test_a_matrix_makes_rows(self) -> None:
        one = self.box(r"\begin{pmatrix} a & b \end{pmatrix}", True)
        two = self.box(r"\begin{pmatrix} a & b \\ c & d \end{pmatrix}", True)
        self.assertGreater(two["h"], one["h"] * 1.5, "the second mtr added no height")

    def test_a_fence_stretches_around_a_fraction(self) -> None:
        # Inline, so the width means something: a display <math> is a block and
        # always measures its container.
        stretched = self.box(r"\left(\frac{a}{b}\right)", False)
        inner = self.box(r"\frac{a}{b}", False)
        self.assertGreaterEqual(stretched["h"], inner["h"],
                                "the fence shrank the fraction")
        self.assertGreater(stretched["w"], inner["w"],
                           "the fence characters painted nothing")

    def test_text_keeps_its_space(self) -> None:
        gap = self.box(r"\text{a b}")
        nogap = self.box(r"\text{ab}")
        self.assertGreater(gap["w"], nogap["w"], "\\text lost its space")

    def test_quad_widens_the_gap(self) -> None:
        self.assertGreater(self.box(r"a\quad b")["w"], self.box(r"a b")["w"])
        self.assertGreater(self.box(r"a\qquad b")["w"], self.box(r"a\quad b")["w"])

    def test_accents_add_height_over_the_base(self) -> None:
        for cmd in (r"\hat", r"\vec", r"\bar", r"\tilde", r"\overline",
                    r"\overrightarrow"):
            with self.subTest(accent=cmd):
                acc = self.box(cmd + "{x}")
                self.assertGreater(acc["h"], self.box("x")["h"],
                                   f"{cmd} painted no accent")

    def test_a_wide_accent_spans_the_whole_base(self) -> None:
        wide = self.box(r"\overrightarrow{ABCD}")
        self.assertGreater(wide["w"], self.box(r"\overrightarrow{A}")["w"])

    def test_an_unknown_command_is_visible_rather_than_blank(self) -> None:
        out = self.render(r"a + \nosuchmacro + b", False)
        self.assertIsNone(out["error"])
        self.assertEqual(out["unknown"], "\\nosuchmacro")
        self.assertGreater(out["width"], self.box("a + b")["w"],
                           "the unknown-command marker occupies no space")

    def test_a_malformed_formula_shows_its_source(self) -> None:
        out = self.render(r"\frac{1}{2", False)
        self.assertFalse(out["hasMath"])
        self.assertEqual(out["error"], r"\frac{1}{2")


class KnownRenderGapsTest(_Browser):
    """Contract features whose markup is valid and whose painting is not.

    Each of these is a reported defect in `src/tex.js`. They are written as the
    assertion the contract implies, and marked expectedFailure with the measured
    numbers, so fixing tex.js turns them into an unexpected success — which
    unittest counts as a failed run and is the prompt to drop the decorator.
    """

    def test_negative_thin_space_narrows_the_gap(self) -> None:
        r"""`\!` must actually pull the two atoms together.

        FIXED 2026-08-10. MathML Core takes no negative length in `width`, so
        the old `<mspace width="-0.16667em">` was discarded outright and `a\!b`
        measured 17.19px, exactly as wide as `ab`. tex.js now carries the
        pull-back in CSS (`width="0em" style="margin-left:-0.16667em"`), which
        Chromium honours: 14.53px.
        """
        self.assertLess(self.box(r"a\!b")["w"], self.box(r"ab")["w"])

    def test_row_break_outside_a_table_makes_two_lines(self) -> None:
        r"""`\\` must typeset on two lines.

        FIXED 2026-08-10. MathML Core dropped `linebreak`, so the old
        `<mspace linebreak="newline">` painted nothing: `a \\ b` was 11.05px
        tall, identical to `a b`, while a real two-row `\begin{gathered}` came
        out 32.88px. compile() now wraps a top-level run of row breaks in a
        one-column <mtable>, which is the same node every environment builds.
        """
        one_line = self.box(r"a b", True)
        two_lines = self.box(r"a \\ b", True)
        self.assertGreater(two_lines["h"], one_line["h"] * 1.5)

    def test_a_pasted_greek_letter_typesets_like_its_command(self) -> None:
        r"""A literal `π` must typeset like `\pi`.

        FIXED 2026-08-10. `charNode` classified on /[A-Za-z]/, so every
        non-ASCII letter fell through to the operator branch and picked up the
        operator dictionary's infix spacing: `2πr` measured 32.25px against
        24.75px for `2\pi r`. The letter test is now Unicode-aware (\p{L}),
        and both come out 24.75px.
        """
        self.assertAlmostEqual(self.box("2πr")["w"],
                               self.box(r"2\pi r")["w"], delta=1.0)

    def test_boxed_draws_a_box(self) -> None:
        r"""`\boxed{X}` must be visibly larger than a bare `X`.

        FIXED 2026-08-10. Both `\boxed` and `\cancel` emitted <menclose>,
        which MathML Core removed: Chromium laid the children out and painted no
        notation at all, so `\boxed{X}` measured 10.20 x 10.58 px — identical to
        a bare `X` — with border-width 0px. tex.js now emits an <mrow> carrying
        a CSS border (and a linear-gradient strike for `\cancel`), the same
        per-element-CSS route emitTable already takes for its column rules:
        20.20 x 17.36 px, border-width 1px.
        """
        boxed = self.box(r"\boxed{X}")
        bare = self.box(r"X")
        self.assertGreater(boxed["w"], bare["w"])
        self.assertGreater(boxed["h"], bare["h"])


def load_tests(loader, tests, pattern):  # noqa: D103  (unittest hook)
    suite = unittest.TestSuite()
    for cls in (MathMLRenderTest, LayoutGeometryTest, KnownRenderGapsTest):
        suite.addTests(loader.loadTestsFromTestCase(cls))
    return suite


if __name__ == "__main__":
    unittest.main(verbosity=2)
