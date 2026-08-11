#!/usr/bin/env python3
"""Inline every source file into one self-contained markdown-studio.html.

No minifier, no bundler, no network. The order below is the contract in
CONTRACT.md; changing it changes runtime behaviour (app.js reads MD and TeX).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "markdown-studio.html"
GEN = ROOT / "tools" / "gen_default_doc.py"

CSS_ORDER = ["theme.css", "app.css", "markdown.css"]

# default_doc.js is generated from samples/demo.md and must precede app.js,
# which reads window.DEFAULT_DOC when localStorage holds no buffer.
JS_ORDER = ["markdown.js", "tex.js", "default_doc.js", "app.js"]

CSS_MARK = "/*__CSS__*/"
JS_MARK = "/*__JS__*/"


def _bundle(names: list[str]) -> str:
    parts = []
    for name in names:
        path = SRC / name
        if not path.exists():
            raise SystemExit(f"build: missing source file {path}")
        text = path.read_text(encoding="utf-8").rstrip()
        parts.append(f"/* ==== {name} ==== */\n{text}")
    return "\n\n".join(parts)


def regenerate_default_doc() -> None:
    """Rebuild src/default_doc.js from samples/demo.md before bundling.

    Loaded by path rather than imported as a package: `tools/` is a scripts
    directory, not a module tree, and adding an __init__.py to it would be
    inventing a package for one file.
    """
    if not GEN.exists():
        raise SystemExit(f"build: missing generator {GEN}")
    spec = importlib.util.spec_from_file_location("gen_default_doc", GEN)
    if spec is None or spec.loader is None:
        raise SystemExit(f"build: cannot load {GEN}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.generate(quiet=True)


def build() -> Path:
    regenerate_default_doc()
    tmpl = (SRC / "index.tmpl.html").read_text(encoding="utf-8")
    for mark in (CSS_MARK, JS_MARK):
        if tmpl.count(mark) != 1:
            raise SystemExit(f"build: template must contain exactly one {mark}")

    css = _bundle(CSS_ORDER)
    js = _bundle(JS_ORDER)

    # A literal "</script>" anywhere in the JS would end the inline script tag.
    js = js.replace("</script>", "<\\/script>")

    html = tmpl.replace(CSS_MARK, css).replace(JS_MARK, js)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    return OUT


def main() -> int:
    out = build()
    kb = out.stat().st_size / 1024
    print(f"built {out} ({kb:.1f} KB, no external requests)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
