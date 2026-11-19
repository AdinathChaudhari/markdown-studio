#!/usr/bin/env python3
"""Native-bridge branch of markdown-studio.html, driven without the macOS app.

    ~/.venvs/main/bin/python build.py     # build first
    ~/.venvs/main/bin/python tests/test_native_bridge.py

The other suites never enter the `NATIVE` branches of src/app.js, because a plain
browser has no `window.webkit.messageHandlers.mdstudio`. This one installs a shim
for it with `add_init_script` (it runs before any page script, and `NATIVE` is
read once at load) and records every posted message into `window.__posts`.

It asserts the contract in CONTRACT.md "Native bridge": Save only posts
`{type:'save'}` and never produces a download; `native.load` sets the editor and
renders; `native.getText` returns the exact editor text; the `mod` shortcuts are
left to the native menu.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "markdown-studio.html"
URL = DIST.as_uri()

os.environ.setdefault(
    "PLAYWRIGHT_BROWSERS_PATH",
    str(Path.home() / "Library" / "Caches" / "ms-playwright"),
)

from playwright.sync_api import sync_playwright

SHIM = """
window.__posts = [];
window.webkit = { messageHandlers: { mdstudio: {
  postMessage: function (m) { window.__posts.push(JSON.parse(JSON.stringify(m))); }
} } };
"""


class NativeBridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        b = subprocess.run([sys.executable, str(ROOT / "build.py")], capture_output=True, text=True)
        if b.returncode != 0 or not DIST.exists():
            raise unittest.SkipTest("build failed:\n%s\n%s" % (b.stdout, b.stderr))
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()

    def setUp(self):
        self.ctx = self.browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        self.ctx.add_init_script(SHIM)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.downloads = []
        self.page.on("download", lambda d: self.downloads.append(d.suggested_filename))
        self.page.goto(URL)
        self.page.wait_for_function("window.__mdstudio && window.__mdstudio.native")

    def tearDown(self):
        self.ctx.close()
        self.assertEqual(self.errors, [], "page errors")

    def posts(self):
        return self.page.evaluate("window.__posts")

    def test_ready_is_posted_once_with_version(self):
        ready = [m for m in self.posts() if m["type"] == "ready"]
        self.assertEqual(ready, [{"type": "ready", "v": 1}])

    def test_save_button_posts_save_and_never_downloads(self):
        self.page.evaluate("window.__posts.length = 0")
        self.page.click("#btn-save")
        self.page.wait_for_timeout(600)   # a download or picker, if any, would have started
        self.assertEqual(self.posts(), [{"type": "save"}])
        self.assertEqual(self.downloads, [])

    def test_cmd_s_is_left_to_native_menu(self):
        self.page.click("#editor")
        self.page.evaluate("window.__posts.length = 0")
        self.page.keyboard.press("Meta+s")
        self.page.keyboard.press("Control+s")
        self.page.wait_for_timeout(300)
        self.assertEqual([m for m in self.posts() if m["type"] == "save"], [])
        self.assertEqual(self.downloads, [])

    def test_load_sets_editor_and_renders(self):
        ok = self.page.evaluate(
            "window.__mdstudio.native.load('# Hello\\r\\n\\r\\nline two\\r\\n\\r\\n$x^2$', 'note.md')"
        )
        self.assertIs(ok, True)
        self.assertEqual(self.page.input_value("#editor"), "# Hello\n\nline two\n\n$x^2$")
        self.assertTrue(self.page.inner_text("#preview h1").startswith("Hello"))
        self.assertEqual(self.page.locator("#preview math").count(), 1)
        st = self.page.evaluate("window.__mdstudio.getState()")
        self.assertEqual(st["name"], "note.md")
        self.assertFalse(st["dirty"])

    def test_load_refuses_nul(self):
        ok = self.page.evaluate("window.__mdstudio.native.load('abc\\u0000def', 'bin.md')")
        self.assertIs(ok, False)

    def test_get_text_is_exact(self):
        text = "  lead\n\ttab  \n\né中\U0001F600 no trailing newline"
        self.page.evaluate("t => window.__mdstudio.native.load(t, 'x.md')", text)
        self.assertEqual(self.page.evaluate("window.__mdstudio.native.getText()"), text)

    def test_mod_shortcuts_are_not_handled_by_js(self):
        self.page.evaluate("window.__mdstudio.native.load('word', 'a.md')")
        self.page.click("#editor")
        self.page.keyboard.press("Control+a")
        mode = self.page.evaluate("document.getElementById('app').dataset.mode")
        theme = self.page.evaluate("document.documentElement.dataset.theme")
        # A document-level listener sees whether JS preventDefault()ed the chord.
        self.page.evaluate(
            "window.__prevented = []; document.addEventListener('keydown', function (e) {"
            " setTimeout(function () { window.__prevented.push([e.key, e.defaultPrevented]); }, 0); });"
        )
        for chord in ("Meta+b", "Control+b", "Meta+i", "Meta+k", "Meta+\\", "Meta+/", "Meta+Shift+o"):
            self.page.keyboard.press(chord)
        self.page.wait_for_timeout(200)
        self.assertEqual(self.page.input_value("#editor"), "word")   # no ** wrapping
        self.assertEqual(self.page.evaluate("document.getElementById('app').dataset.mode"), mode)
        self.assertEqual(self.page.evaluate("document.documentElement.dataset.theme"), theme)
        self.assertTrue(all(not p for _, p in self.page.evaluate("window.__prevented")))

    def test_js_still_owns_tab(self):
        self.page.evaluate("window.__mdstudio.native.load('x', 'a.md')")
        self.page.click("#editor")
        self.page.keyboard.press("Tab")
        self.assertNotEqual(self.page.input_value("#editor"), "x")


if __name__ == "__main__":
    unittest.main(verbosity=2)
