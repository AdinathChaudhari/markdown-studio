/* tests/test_markdown.mjs — the markdown parser's contract, exercised.
 *
 *   cd markdown-studio && node --test "tests/*.mjs"
 *
 * (Quote the glob. `node --test tests/` resolves the directory as a module on
 * node 23 here and dies with MODULE_NOT_FOUND before any test runs.)
 *
 * Loaded through ./load.mjs, which evaluates src/markdown.js the way a browser
 * does (classic script, one global) inside a node:vm context. No DOM, no
 * network, no dependency.
 *
 * House style for this file:
 *  - Assert on *meaning*, not on whitespace. `render()` is free to put its
 *    newlines wherever it likes; a test that pins them tells you nothing when
 *    it breaks. So most assertions are `includes` / regexp over the emitted
 *    markup, and the few exact-output tests are the ones where the whole point
 *    is that nothing extra appears.
 *  - Every test names the markdown it feeds in, so a failure message is a
 *    repro.
 *  - Where CommonMark is genuinely ambiguous the comment says so and the test
 *    asserts the reader-friendly reading.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobals } from './load.mjs';

const { MD } = loadGlobals();

/* A math callback that records what it was handed and emits a marker easy to
 * assert on. `d` is stringified so a wrong flag is visible in the diff. */
function mathSpy() {
  const calls = [];
  const fn = (tex, display) => {
    calls.push({ tex, display });
    return `<M d="${display}">${tex}</M>`;
  };
  fn.calls = calls;
  return fn;
}

function withMath(src) {
  const math = mathSpy();
  return { html: MD.render(src, { math }), calls: math.calls, math };
}

/* outline() builds its objects inside the vm context, so their prototype is
 * that realm's Object.prototype and assert/strict's deepEqual refuses them as
 * "same structure, not reference-equal". Round-trip through JSON to compare
 * them as data, which is all the contract promises. */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/* Count non-overlapping occurrences of a literal. */
function count(hay, needle) {
  let n = 0, i = 0;
  for (;;) {
    const p = hay.indexOf(needle, i);
    if (p < 0) return n;
    n++; i = p + needle.length;
  }
}

/* The cells of the nth <tr>, tag included, so a test can assert on the
 * alignment style as well as the text. */
function rows(html) {
  return (html.match(/<tr>[\s\S]*?<\/tr>/g) || []).map((tr) =>
    (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/g) || [])
  );
}

function cellText(cell) {
  return cell.replace(/^<t[hd][^>]*>/, '').replace(/<\/t[hd]>$/, '');
}

/* ------------------------------------------------------------------ *
 * surface
 * ------------------------------------------------------------------ */

describe('module surface', () => {
  test('VERSION, render and outline exist with the contracted shapes', () => {
    assert.equal(MD.VERSION, '1');
    assert.equal(typeof MD.render, 'function');
    assert.equal(typeof MD.outline, 'function');
    assert.equal(typeof MD.render('x'), 'string');
    assert.ok(Array.isArray(MD.outline('# x')));
  });

  test('render works with no opts at all', () => {
    assert.match(MD.render('hello'), /<p>hello<\/p>/);
  });
});

/* ------------------------------------------------------------------ *
 * GFM tables — the first headline feature
 * ------------------------------------------------------------------ */

describe('tables', () => {
  test('plain pipe table, no outer pipes', () => {
    const html = MD.render('a | b\n--- | ---\n1 | 2');
    assert.match(html, /<table class="md-table">/);
    assert.match(html, /<thead>[\s\S]*<th>a<\/th>[\s\S]*<th>b<\/th>[\s\S]*<\/thead>/);
    assert.match(html, /<tbody>[\s\S]*<td>1<\/td>[\s\S]*<td>2<\/td>[\s\S]*<\/tbody>/);
    assert.ok(!html.includes('<p>a | b'), 'must not fall back to a paragraph');
  });

  test('the table is wrapped in .md-table-wrap', () => {
    const html = MD.render('| a |\n| - |\n| 1 |');
    assert.match(html, /<div class="md-table-wrap">\s*<table class="md-table">/);
    /* one wrapper, closed */
    assert.equal(count(html, 'md-table-wrap'), 1);
    assert.equal(count(html, '</table>'), 1);
    assert.equal(count(html, '</div>'), 1);
  });

  test('all three alignments reach both the th and the td', () => {
    const html = MD.render('| L | C | R |\n|:---|:---:|---:|\n| 1 | 2 | 3 |');
    const [head, body] = rows(html);
    assert.equal(head[0], '<th style="text-align:left">L</th>');
    assert.equal(head[1], '<th style="text-align:center">C</th>');
    assert.equal(head[2], '<th style="text-align:right">R</th>');
    assert.equal(body[0], '<td style="text-align:left">1</td>');
    assert.equal(body[1], '<td style="text-align:center">2</td>');
    assert.equal(body[2], '<td style="text-align:right">3</td>');
  });

  test('an unaligned column gets no style attribute at all', () => {
    const html = MD.render('| a | b |\n| --- | :-: |\n| 1 | 2 |');
    const [head] = rows(html);
    assert.equal(head[0], '<th>a</th>');
    assert.equal(head[1], '<th style="text-align:center">b</th>');
  });

  test('alignment survives without outer pipes and with padding spaces', () => {
    const html = MD.render('  a  |  b \n :--- | ---: \n 1 | 2 ');
    const [head] = rows(html);
    assert.equal(head[0], '<th style="text-align:left">a</th>');
    assert.equal(head[1], '<th style="text-align:right">b</th>');
  });

  test('a delimiter row whose cell count differs from the header is NOT a table', () => {
    const tooFew = MD.render('| a | b |\n| --- |\n| 1 | 2 |');
    assert.ok(!tooFew.includes('<table'), 'two headers, one delimiter cell');
    assert.match(tooFew, /<p>/);

    const tooMany = MD.render('| a | b |\n| --- | --- | --- |\n| 1 | 2 |');
    assert.ok(!tooMany.includes('<table'), 'two headers, three delimiter cells');

    const noPipes = MD.render('a|b|c\n-|-\n1|2|3');
    assert.ok(!noPipes.includes('<table'), 'same rule with the pipes bare');
  });

  test('a delimiter row with no dash is not a delimiter row', () => {
    const html = MD.render('| a |\n| : |\n| 1 |');
    assert.ok(!html.includes('<table'));
  });

  test('escaped \\| inside a cell stays one cell and renders a literal pipe', () => {
    const html = MD.render('| a | b |\n| --- | --- |\n| x \\| y | z |');
    const [head, body] = rows(html);
    assert.equal(head.length, 2);
    assert.equal(body.length, 2);
    assert.equal(cellText(body[0]), 'x | y');
    assert.equal(cellText(body[1]), 'z');
  });

  test('escaped \\| works in the header row too', () => {
    const html = MD.render('| a \\| b | c |\n| - | - |\n| 1 | 2 |');
    const [head] = rows(html);
    assert.equal(head.length, 2);
    assert.equal(cellText(head[0]), 'a | b');
  });

  test('a pipe inside a code span inside a cell does not split the cell', () => {
    const html = MD.render('| a | b |\n| --- | --- |\n| `x | y` | z |');
    const [, body] = rows(html);
    assert.equal(body.length, 2);
    assert.equal(cellText(body[0]), '<code>x | y</code>');
    assert.equal(cellText(body[1]), 'z');
  });

  test('the same holds for a multi-backtick code span', () => {
    const html = MD.render('| a | b |\n| --- | --- |\n| ``x | y`` | z |');
    const [, body] = rows(html);
    assert.equal(body.length, 2);
    assert.equal(cellText(body[0]), '<code>x | y</code>');
  });

  test('a ragged short row is padded to the header width', () => {
    const html = MD.render('| a | b | c |\n| - | - | - |\n| 1 |');
    const [, body] = rows(html);
    assert.equal(body.length, 3);
    assert.equal(cellText(body[0]), '1');
    assert.equal(cellText(body[1]), '');
    assert.equal(cellText(body[2]), '');
  });

  test('a ragged long row is truncated to the header width', () => {
    const html = MD.render('| a | b |\n| - | - |\n| 1 | 2 | 3 | 4 |');
    const [, body] = rows(html);
    assert.equal(body.length, 2);
    assert.equal(cellText(body[1]), '2');
    assert.ok(!html.includes('>3<'), 'the overflow cell is dropped, not appended');
  });

  test('inline markdown, links and images all work inside a cell', () => {
    const html = MD.render(
      '| **b** _i_ `c` ~~s~~ ==m== [l](http://e.com) ![i](p.png) |\n| - |\n| x |'
    );
    const [head] = rows(html);
    const t = cellText(head[0]);
    assert.match(t, /<strong>b<\/strong>/);
    assert.match(t, /<em>i<\/em>/);
    assert.match(t, /<code>c<\/code>/);
    assert.match(t, /<del>s<\/del>/);
    assert.match(t, /<mark>m<\/mark>/);
    assert.match(t, /<a href="http:\/\/e\.com">l<\/a>/);
    assert.match(t, /<img src="p\.png" alt="i">/);
  });

  test('an empty cell is an empty td, not a dropped column', () => {
    const html = MD.render('| a | b |\n| - | - |\n|  | z |');
    const [, body] = rows(html);
    assert.equal(body.length, 2);
    assert.equal(cellText(body[0]), '');
    assert.equal(cellText(body[1]), 'z');
  });

  test('an empty header cell is kept as an empty th', () => {
    const html = MD.render('| | b |\n| - | - |\n| 1 | 2 |');
    const [head] = rows(html);
    assert.equal(head.length, 2);
    assert.equal(cellText(head[0]), '');
  });

  test('a table interrupts a paragraph with no blank line between them', () => {
    const html = MD.render('text\n| a | b |\n| - | - |\n| 1 | 2 |');
    assert.match(html, /<p>text<\/p>/);
    assert.match(html, /<table class="md-table">/);
    assert.ok(!/<p>text\n\| a/.test(html), 'the pipes must not stay in the paragraph');
  });

  test('two tables back to back stay two tables', () => {
    const html = MD.render('|a|\n|-|\n|1|\n\n|b|\n|-|\n|2|');
    assert.equal(count(html, '<table class="md-table">'), 2);
    assert.equal(count(html, 'md-table-wrap'), 2);
    assert.equal(count(html, '</table>'), 2);
    assert.match(html, /<th>a<\/th>/);
    assert.match(html, /<th>b<\/th>/);
  });

  test('a header-only table renders a thead and no empty tbody', () => {
    const html = MD.render('| a | b |\n| - | - |');
    assert.match(html, /<thead>/);
    assert.ok(!html.includes('<tbody>'), 'no rows means no tbody');
  });

  test('a table nests inside a list item and inside a blockquote', () => {
    const inList = MD.render('- | a |\n  | - |\n  | 1 |');
    assert.match(inList, /<li>[\s\S]*<table class="md-table">[\s\S]*<\/li>/);

    const inQuote = MD.render('> | a | b |\n> | - | - |\n> | 1 | 2 |');
    assert.match(inQuote, /<blockquote>[\s\S]*<table class="md-table">[\s\S]*<\/blockquote>/);
  });

  test('a table may be indented up to three spaces but not four', () => {
    assert.match(MD.render('   | a |\n   | - |\n   | 1 |'), /<table class="md-table">/);
    const indented = MD.render('    | a |\n    | - |\n    | 1 |');
    assert.match(indented, /<pre><code>/, 'four spaces is an indented code block');
    assert.ok(!indented.includes('<table'));
  });

  test('a paragraph line after the last row ends the table', () => {
    /* GFM proper would read the bare line as a one-cell row. A reader of the
     * page is better served by a paragraph, so this asserts the friendlier
     * reading rather than the spec letter. */
    const html = MD.render('|a|\n|-|\n|1|\nprose after');
    assert.match(html, /<\/table>/);
    assert.match(html, /<p>prose after<\/p>/);
  });
});

/* ------------------------------------------------------------------ *
 * math extraction — the second headline feature
 * ------------------------------------------------------------------ */

describe('math extraction', () => {
  test('$x$ is inline math and the callback gets (tex, false)', () => {
    const { html, calls } = withMath('a $x$ b');
    assert.match(html, /<p>a <M d="false">x<\/M> b<\/p>/);
    assert.deepEqual(calls, [{ tex: 'x', display: false }]);
  });

  test('$$x$$ is display math and the callback gets (tex, true)', () => {
    const { html, calls } = withMath('$$x$$');
    assert.match(html, /<M d="true">x<\/M>/);
    assert.deepEqual(calls, [{ tex: 'x', display: true }]);
  });

  test('\\(x\\) is inline math', () => {
    const { html, calls } = withMath('a \\(x\\) b');
    assert.match(html, /<p>a <M d="false">x<\/M> b<\/p>/);
    assert.deepEqual(calls, [{ tex: 'x', display: false }]);
  });

  test('\\[x\\] is display math', () => {
    const { calls } = withMath('\\[x\\]');
    assert.deepEqual(calls, [{ tex: 'x', display: true }]);
  });

  test('_ * and | inside math survive completely untouched', () => {
    /* This is the whole reason math is extracted before inline parsing: the
     * underscore must not emphasise, the asterisk must not emphasise, and the
     * pipe must not be read as a table cell boundary. */
    const { html, calls } = withMath('$a_1 * b_2 | c$');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tex, 'a_1 * b_2 | c');
    assert.ok(!html.includes('<em>'), 'no emphasis inside math');
    assert.ok(!html.includes('<strong>'));
    assert.match(html, /<M d="false">a_1 \* b_2 \| c<\/M>/);
  });

  test('math keeps its backslashes and braces', () => {
    const { calls } = withMath('$\\frac{a_1}{b^2} \\\\ \\left| x \\right|$');
    assert.equal(calls[0].tex, '\\frac{a_1}{b^2} \\\\ \\left| x \\right|');
  });

  test('a pipe inside math inside a table cell does not split the cell', () => {
    const math = mathSpy();
    const html = MD.render('| a | b |\n| - | - |\n| $x_1|y$ | z |', { math });
    const [, body] = rows(html);
    assert.equal(body.length, 2, 'the math pipe must not create a third cell');
    assert.equal(cellText(body[0]), '<M d="false">x_1|y</M>');
    assert.equal(cellText(body[1]), 'z');
    assert.deepEqual(math.calls, [{ tex: 'x_1|y', display: false }]);
  });

  test('\\$ is a literal dollar and no math', () => {
    const { html, calls } = withMath('cost \\$5 today');
    assert.equal(calls.length, 0);
    assert.match(html, /<p>cost \$5 today<\/p>/);
    assert.ok(!html.includes('\\$'), 'the backslash is consumed');
  });

  test('a $ inside a code span is never math', () => {
    const { html, calls } = withMath('`$x$` and $y$');
    assert.equal(calls.length, 1, 'only the one outside the code span');
    assert.equal(calls[0].tex, 'y');
    assert.match(html, /<code>\$x\$<\/code>/);
  });

  test('a $ inside a fenced block is never math', () => {
    const { html, calls } = withMath('```\n$x$\n$$y$$\n```');
    assert.equal(calls.length, 0);
    assert.match(html, /<pre><code>\$x\$\n\$\$y\$\$\n<\/code><\/pre>/);
  });

  test('a $ inside an indented code block is never math', () => {
    const { html, calls } = withMath('    total = $x$\n');
    assert.equal(calls.length, 0);
    assert.match(html, /<pre><code>total = \$x\$/);
  });

  test('a bare price sentence is not math', () => {
    const { html, calls } = withMath('I paid $5 and $10 for it');
    assert.equal(calls.length, 0, JSON.stringify(calls));
    assert.match(html, /<p>I paid \$5 and \$10 for it<\/p>/);
  });

  test('a price range and a lone dollar are not math either', () => {
    assert.equal(withMath('between $100-$200 total').calls.length, 0);
    assert.equal(withMath('just a $ here').calls.length, 0);
    assert.equal(withMath('a $ x$ b').calls.length, 0, 'no space just inside');
    assert.equal(withMath('a $x $ b').calls.length, 0, 'no space just inside');
  });

  test('display math on its own line becomes a block, inline math does not', () => {
    const block = withMath('before\n\n$$\na = b\n$$\n\nafter');
    assert.match(block.html, /<div class="md-math-block"><M d="true">a = b<\/M><\/div>/);
    assert.deepEqual(block.calls, [{ tex: 'a = b', display: true }]);
    assert.match(block.html, /<p>before<\/p>/);
    assert.match(block.html, /<p>after<\/p>/);

    const inline = withMath('inline $a$ and display $$b$$ here');
    assert.match(inline.html, /^<p>/);
    assert.ok(!inline.html.includes('md-math-block'), 'mid-sentence stays inline');
    assert.deepEqual(inline.calls, [
      { tex: 'a', display: false },
      { tex: 'b', display: true }
    ]);
  });

  test('display math survives inside a blockquote and a list item', () => {
    assert.match(withMath('> $$a$$').html, /<blockquote>[\s\S]*md-math-block/);
    assert.match(withMath('- $$a$$').html, /<li>[\s\S]*md-math-block/);
  });

  test('unclosed math is left as literal text', () => {
    assert.equal(withMath('$x + y').calls.length, 0);
    assert.equal(withMath('$$x').calls.length, 0);
    assert.match(withMath('$x + y').html, /<p>\$x \+ y<\/p>/);
  });

  test('with no opts.math, math falls back to a md-math-raw code span', () => {
    const html = MD.render('z $c$ and $$d$$');
    assert.match(html, /<code class="md-math-raw">\$c\$<\/code>/);
    assert.match(html, /<code class="md-math-raw">\$\$d\$\$<\/code>/);
  });

  test('a math callback that returns null or throws degrades to md-math-raw', () => {
    assert.match(MD.render('x $a$', { math: () => null }), /md-math-raw/);
    assert.match(
      MD.render('y $b$', { math: () => { throw new Error('boom'); } }),
      /md-math-raw/
    );
  });

  test('math is extracted inside a heading and does not corrupt the slug', () => {
    const math = mathSpy();
    const html = MD.render('# Heading $x^2$ here', { math });
    assert.deepEqual(math.calls, [{ tex: 'x^2', display: false }]);
    assert.match(html, /<h1 id="heading-x2-here">/);
    assert.match(html, /<M d="false">x\^2<\/M>/);
  });

  test('two math spans in one paragraph keep their own tex and flags', () => {
    const { calls } = withMath('$a$ then \\[b\\] then \\(c\\) then $$d$$');
    assert.deepEqual(calls, [
      { tex: 'a', display: false },
      { tex: 'b', display: true },
      { tex: 'c', display: false },
      { tex: 'd', display: true }
    ]);
  });

  test('math next to emphasis markers does not leak the markers into tex', () => {
    const { calls, html } = withMath('*$a$* and **$b$**');
    assert.deepEqual(calls, [
      { tex: 'a', display: false },
      { tex: 'b', display: false }
    ]);
    assert.match(html, /<em><M d="false">a<\/M><\/em>/);
    assert.match(html, /<strong><M d="false">b<\/M><\/strong>/);
  });
});

/* ------------------------------------------------------------------ *
 * headings, slugs, outline
 * ------------------------------------------------------------------ */

describe('headings and slugs', () => {
  test('# .. ###### map to h1..h6 with a slug id and an md-anchor', () => {
    const html = MD.render('# One\n\n## Two\n\n###### Six');
    assert.match(html, /<h1 id="one">One<a class="md-anchor" href="#one"[^>]*>#<\/a><\/h1>/);
    assert.match(html, /<h2 id="two">/);
    assert.match(html, /<h6 id="six">/);
    assert.equal(count(html, 'class="md-anchor"'), 3);
  });

  test('duplicate headings get -1, -2 suffixes in document order', () => {
    const html = MD.render('# Dup\n\n# Dup\n\n# Dup');
    assert.match(html, /id="dup"/);
    assert.match(html, /id="dup-1"/);
    assert.match(html, /id="dup-2"/);
    const ids = (html.match(/id="[^"]*"/g) || []).filter((s) => s.startsWith('id="dup'));
    assert.deepEqual(ids, ['id="dup"', 'id="dup-1"', 'id="dup-2"']);
  });

  test('the slugger resets between calls', () => {
    const a = MD.render('# Dup');
    const b = MD.render('# Dup');
    assert.equal(a, b);
    assert.match(a, /id="dup"/);
  });

  test('setext headings work for both underlines', () => {
    const html = MD.render('Title\n=====\n\nSub\n---');
    assert.match(html, /<h1 id="title">Title/);
    assert.match(html, /<h2 id="sub">Sub/);
  });

  test('a setext h2 beats a thematic break for a one-line paragraph', () => {
    const html = MD.render('a\n---');
    assert.match(html, /<h2 id="a">a/);
    assert.ok(!html.includes('<hr>'));
  });

  test('inline markup inside a heading renders but is stripped from the slug', () => {
    const html = MD.render('## `code` and *em* and [l](u)');
    assert.match(html, /id="code-and-em-and-l"/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<em>em<\/em>/);
  });

  test('baseHeadingLevel shifts the whole ladder', () => {
    const html = MD.render('# a\n\n### c', { baseHeadingLevel: 3 });
    assert.match(html, /<h3 id="a">/);
    assert.match(html, /<h5 id="c">/);
    assert.ok(!html.includes('<h1'));
  });

  test('outline reports level, text and the same ids render emits', () => {
    const src = '# A\n\n## B b\n\n# A\n\nText\n\n### `c` deep';
    const out = MD.outline(src);
    assert.deepEqual(plain(out), [
      { level: 1, text: 'A', id: 'a' },
      { level: 2, text: 'B b', id: 'b-b' },
      { level: 1, text: 'A', id: 'a-1' },
      { level: 3, text: 'c deep', id: 'c-deep' }
    ]);
    const html = MD.render(src);
    for (const h of out) assert.ok(html.includes(`id="${h.id}"`), `render is missing ${h.id}`);
  });

  test('outline ignores a heading-looking line inside a code fence', () => {
    assert.deepEqual(plain(MD.outline('```\n# not a heading\n```\n\n# real')), [
      { level: 1, text: 'real', id: 'real' }
    ]);
  });

  test('outline levels are the source levels, not shifted', () => {
    assert.deepEqual(plain(MD.outline('### deep')), [{ level: 3, text: 'deep', id: 'deep' }]);
  });

  test('a closing hash sequence is not part of the text', () => {
    assert.match(MD.render('## Title ##'), /<h2 id="title">Title</);
  });

  test('a UTF-8 BOM before the first heading does not swallow it', () => {
    /* A .md written by a Windows editor starts with U+FEFF. `Blob.text()` and
     * `FileReader.readAsText` both strip it, so the Open path is safe — but a
     * paste (`clipboardData.getData('text/plain')`) and any direct call are
     * not, and `normalise()` should not care where the string came from. */
    const html = MD.render('﻿# Title\n\ntext');
    assert.match(html, /<h1 id="title">Title/);
    assert.deepEqual(plain(MD.outline('﻿# Title')), [{ level: 1, text: 'Title', id: 'title' }]);
  });
});

/* ------------------------------------------------------------------ *
 * inline
 * ------------------------------------------------------------------ */

describe('emphasis and inline spans', () => {
  test('***a* b** nests em inside strong', () => {
    assert.match(MD.render('***a* b**'), /<p><strong><em>a<\/em> b<\/strong><\/p>/);
  });

  test('**a *b* c** nests em inside strong', () => {
    assert.match(MD.render('**a *b* c**'), /<p><strong>a <em>b<\/em> c<\/strong><\/p>/);
  });

  test('*a **b** c* nests strong inside em, underscores too', () => {
    assert.match(MD.render('*a **b** c*'), /<em>a <strong>b<\/strong> c<\/em>/);
    assert.match(MD.render('_a __b__ c_'), /<em>a <strong>b<\/strong> c<\/em>/);
  });

  test('intra-word underscores do NOT emphasise', () => {
    const html = MD.render('snake_case_word and __dunder__ alone');
    assert.match(html, /snake_case_word/);
    assert.ok(!/snake<em>/.test(html));
    assert.match(html, /<strong>dunder<\/strong>/, 'a standalone run still works');
  });

  test('intra-word asterisks do emphasise (CommonMark)', () => {
    assert.match(MD.render('intra*word*star'), /intra<em>word<\/em>star/);
  });

  test('strike, mark and their nesting', () => {
    assert.match(MD.render('~~s~~ and ==m=='), /<del>s<\/del> and <mark>m<\/mark>/);
    assert.match(MD.render('~~a *b* c~~'), /<del>a <em>b<\/em> c<\/del>/);
    assert.match(MD.render('==a *b*=='), /<mark>a <em>b<\/em><\/mark>/);
  });

  test('code spans honour the multi-backtick rule', () => {
    const html = MD.render('``a `b` c`` and `` ` ``');
    assert.match(html, /<code>a `b` c<\/code>/);
    assert.match(html, /<code>`<\/code>/);
  });

  test('a code span escapes its HTML and collapses its newline', () => {
    assert.match(MD.render('`<b> & </b>`'), /<code>&lt;b&gt; &amp; &lt;\/b&gt;<\/code>/);
    assert.match(MD.render('`a\nb`'), /<code>a b<\/code>/);
  });

  test('hard breaks from two trailing spaces and from a backslash', () => {
    assert.match(MD.render('a  \nb'), /a<br>\s*b/);
    assert.match(MD.render('c\\\nd'), /c<br>\s*d/);
  });

  test('a soft line break inside a paragraph is not a <br>', () => {
    const html = MD.render('a\nb');
    assert.match(html, /<p>a\nb<\/p>/);
    assert.ok(!html.includes('<br>'));
  });

  test('backslash escapes every ASCII punctuation char', () => {
    const punct = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    const src = punct.split('').map((c) => '\\' + c).join('');
    const html = MD.render(src);
    assert.ok(!html.includes('<em>'), 'no emphasis survived: ' + html);
    assert.ok(!html.includes('<code>'));
    assert.ok(!html.includes('<strong>'));
    /* every char is present exactly once, HTML-escaped where it must be */
    const text = html.replace(/^<p>/, '').replace(/<\/p>\n?$/, '');
    const decoded = text
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    assert.equal(decoded, punct);
  });

  test('escaped markers stay literal', () => {
    assert.match(MD.render('\\*not em\\* \\_a\\_'), /<p>\*not em\* _a_<\/p>/);
    assert.match(MD.render('a \\| b'), /<p>a \| b<\/p>/);
  });
});

/* ------------------------------------------------------------------ *
 * code blocks
 * ------------------------------------------------------------------ */

describe('code blocks', () => {
  test('a backtick fence with an info string becomes language-x', () => {
    assert.match(MD.render('```js\nvar a=1;\n```'), /<pre><code class="language-js">var a=1;\n<\/code><\/pre>/);
  });

  test('a tilde fence works and takes an info string too', () => {
    assert.match(MD.render('~~~python\nx=1\n~~~'), /<pre><code class="language-python">x=1\n<\/code><\/pre>/);
  });

  test('only the first word of the info string becomes the class', () => {
    assert.match(MD.render('```js {highlight}\nx\n```'), /class="language-js"/);
  });

  test('the info string is attribute-escaped', () => {
    const html = MD.render('```x"><script>\nv\n```');
    assert.ok(!html.includes('"><script>'), 'quote must not break out of the attribute');
    assert.match(html, /class="language-x&quot;&gt;&lt;script&gt;"/);
  });

  test('a longer fence contains a shorter one verbatim', () => {
    assert.match(MD.render('````\n```\nx\n```\n````'), /<pre><code>```\nx\n```\n<\/code><\/pre>/);
    assert.match(MD.render('~~~\n```\nx\n```\n~~~'), /<pre><code>```\nx\n```\n<\/code><\/pre>/);
  });

  test('an unclosed fence still closes at end of document', () => {
    assert.match(MD.render('```js\nx'), /<pre><code class="language-js">x\n<\/code><\/pre>/);
  });

  test('a 4-space indented code block, HTML-escaped', () => {
    assert.match(MD.render('    code line\n    two'), /<pre><code>code line\ntwo\n<\/code><\/pre>/);
    assert.match(MD.render('    <b>x</b>'), /<pre><code>&lt;b&gt;x&lt;\/b&gt;\n<\/code><\/pre>/);
  });

  test('a fence never runs markdown or HTML inside it', () => {
    const html = MD.render('```\n**b** <script>alert(1)</script>\n```');
    assert.ok(!html.includes('<strong>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

/* ------------------------------------------------------------------ *
 * blockquotes and lists
 * ------------------------------------------------------------------ */

describe('blockquotes', () => {
  test('nested blockquotes nest', () => {
    const html = MD.render('> a\n>> b');
    assert.match(html, /<blockquote>[\s\S]*<p>a<\/p>[\s\S]*<blockquote>[\s\S]*<p>b<\/p>/);
    assert.equal(count(html, '<blockquote>'), 2);
    assert.equal(count(html, '</blockquote>'), 2);
  });

  test('lazy continuation joins an unprefixed line to the quoted paragraph', () => {
    const html = MD.render('> lazy\ncontinued');
    assert.match(html, /<blockquote>\s*<p>lazy\ncontinued<\/p>\s*<\/blockquote>/);
  });

  test('lazy continuation reaches into a nested quote', () => {
    assert.match(MD.render('>> a\nb'), /<p>a\nb<\/p>/);
  });

  test('a blockquote can hold a list and a list can hold a blockquote', () => {
    assert.match(MD.render('> - a\n> - b'), /<blockquote>\s*<ul>[\s\S]*<\/ul>\s*<\/blockquote>/);
    assert.match(MD.render('- > q'), /<li>\s*<blockquote>[\s\S]*<\/blockquote>\s*<\/li>/);
  });
});

describe('lists', () => {
  test('a tight list gets no <p> in its items', () => {
    const html = MD.render('- a\n- b');
    assert.match(html, /<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
    assert.ok(!html.includes('<p>'));
  });

  test('a loose list wraps each item in <p>', () => {
    const html = MD.render('- a\n\n- b');
    assert.equal(count(html, '<p>a</p>'), 1);
    assert.equal(count(html, '<p>b</p>'), 1);
  });

  test('an item with two paragraphs makes the whole list loose', () => {
    const html = MD.render('- a\n\n  b\n- c');
    assert.match(html, /<p>a<\/p>/);
    assert.match(html, /<p>b<\/p>/);
    assert.match(html, /<p>c<\/p>/, 'the sibling item goes loose too');
  });

  test('all three bullet characters start a list', () => {
    for (const m of ['-', '*', '+']) {
      assert.match(MD.render(m + ' item'), /<ul>\s*<li>item<\/li>\s*<\/ul>/, m);
    }
  });

  test('changing the bullet character starts a new list', () => {
    const html = MD.render('- a\n* b');
    assert.equal(count(html, '<ul>'), 2);
  });

  test('ordered lists honour the start number and both delimiters', () => {
    assert.match(MD.render('5. five\n6. six'), /<ol start="5">/);
    assert.match(MD.render('1) a\n2) b'), /<ol>\s*<li>a<\/li>/);
    assert.match(MD.render('0. a'), /<ol start="0">/);
    const one = MD.render('1. a');
    assert.match(one, /<ol>/);
    assert.ok(!one.includes('start='), 'start=1 is the default and is omitted');
  });

  test('lists nest by indent', () => {
    const html = MD.render('- a\n  - b\n    - c');
    assert.equal(count(html, '<ul>'), 3);
    assert.equal(count(html, '</ul>'), 3);
    assert.match(html, /a[\s\S]*<ul>[\s\S]*b[\s\S]*<ul>[\s\S]*<li>c<\/li>/);
  });

  test('a list marker with no following space is not a list', () => {
    const html = MD.render('-a\n1.b');
    assert.ok(!html.includes('<ul>'));
    assert.ok(!html.includes('<ol>'));
    assert.match(html, /<p>/);
  });

  test('task list items render a disabled checkbox, checked only for [x]', () => {
    const html = MD.render('- [ ] todo\n- [x] done');
    const inputs = html.match(/<input[^>]*>/g) || [];
    assert.equal(inputs.length, 2);
    assert.ok(inputs[0].includes('type="checkbox"'));
    assert.ok(inputs[0].includes('disabled'));
    assert.ok(!inputs[0].includes('checked'), 'unchecked item: ' + inputs[0]);
    assert.ok(inputs[1].includes('checked'), 'checked item: ' + inputs[1]);
    assert.match(html, /class="task-list-item"/);
  });

  test('task list items nest', () => {
    const html = MD.render('- [x] a\n  - [ ] b');
    assert.equal(count(html, '<input'), 2);
    assert.equal(count(html, '<ul'), 2);
  });
});

describe('thematic breaks', () => {
  test('---, *** and ___ all make an <hr>', () => {
    const html = MD.render('---\n\n***\n\n___');
    assert.equal(count(html, '<hr>'), 3);
  });
});

/* ------------------------------------------------------------------ *
 * links, images, footnotes, HTML
 * ------------------------------------------------------------------ */

describe('links and images', () => {
  test('inline link with a title, and an image with a title', () => {
    assert.match(MD.render('[t](http://e.com "Ti")'), /<a href="http:\/\/e\.com" title="Ti">t<\/a>/);
    assert.match(MD.render('![alt](/i.png "T")'), /<img src="\/i\.png" alt="alt" title="T">/);
  });

  test('reference links and definitions, including collapsed and shortcut forms', () => {
    const html = MD.render('[t][ref], [ref][] and [ref]\n\n[ref]: http://e.com "Ti"');
    assert.equal(count(html, 'href="http://e.com"'), 3);
    assert.match(html, /title="Ti"/);
    assert.ok(!html.includes('[ref]:'), 'the definition is consumed');
  });

  test('reference labels are case- and whitespace-insensitive', () => {
    assert.match(MD.render('[T][  REF ]\n\n[ref]: /u'), /<a href="\/u">T<\/a>/);
  });

  test('an undefined reference is left as literal text', () => {
    assert.match(MD.render('[t][nope]'), /<p>\[t\]\[nope\]<\/p>/);
  });

  test('angle autolinks for http and mail', () => {
    const html = MD.render('<https://e.com> and <a@b.com>');
    assert.match(html, /<a href="https:\/\/e\.com">https:\/\/e\.com<\/a>/);
    assert.match(html, /<a href="mailto:a@b\.com">a@b\.com<\/a>/);
  });

  test('bare-URL GFM autolinks, without eating the trailing punctuation', () => {
    const html = MD.render('see https://e.com/x?y=1. ok');
    assert.match(html, /<a href="https:\/\/e\.com\/x\?y=1">https:\/\/e\.com\/x\?y=1<\/a>\./);
    assert.match(MD.render('www.example.com here'), /<a href="http:\/\/www\.example\.com">/);
    assert.match(MD.render('mail a@b.com ok'), /<a href="mailto:a@b\.com">/);
  });

  test('an image inside a link works', () => {
    assert.match(
      MD.render('[![alt](i.png)](http://e.com)'),
      /<a href="http:\/\/e\.com"><img src="i\.png" alt="alt"><\/a>/
    );
  });

  test('a link inside a link never produces nested <a> elements', () => {
    /* Nested anchors are invalid HTML; the browser un-nests them and the
     * rendered page stops matching the markup the tests see. CommonMark
     * forbids links in links, so the outer brackets stay literal. */
    const html = MD.render('[a [b](c)](d)');
    assert.ok(
      !/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(html),
      'nested anchor in: ' + html
    );
  });
});

describe('footnotes', () => {
  test('a footnote reference and its definition link to each other', () => {
    const html = MD.render('Text[^1]\n\n[^1]: A note');
    assert.match(html, /<sup class="md-fnref"><a href="#fn-1" id="fnref-1">1<\/a><\/sup>/);
    assert.match(html, /<section class="md-footnotes">/);
    assert.match(html, /<li id="fn-1">[\s\S]*A note/);
    assert.match(html, /href="#fnref-1"/);
  });

  test('one footnote referenced twice gets two distinct back-references', () => {
    const html = MD.render('a[^x] b[^x]\n\n[^x]: note');
    assert.equal(count(html, 'href="#fn-1"'), 2);
    assert.match(html, /id="fnref-1"/);
    assert.match(html, /id="fnref-1-2"/);
    assert.equal(count(html, '<li id="fn-1">'), 1, 'still one footnote');
  });

  test('an unused definition renders no footnote section', () => {
    const html = MD.render('text\n\n[^u]: unused');
    assert.ok(!html.includes('md-footnotes'));
    assert.match(html, /<p>text<\/p>/);
  });
});

describe('raw HTML and security', () => {
  test('block and inline HTML pass through unescaped', () => {
    assert.match(MD.render('<div class="x">raw</div>'), /<div class="x">raw<\/div>/);
    assert.match(MD.render('in <b>line</b> html'), /in <b>line<\/b> html/);
    assert.match(MD.render('<!-- c -->\n\ntext'), /<!-- c -->/);
  });

  test('text is HTML-escaped where it is not markup', () => {
    assert.match(MD.render('5 < 6 & 7 > 3'), /<p>5 &lt; 6 &amp; 7 &gt; 3<\/p>/);
  });

  test('javascript:, vbscript: and non-image data: URLs are neutralised', () => {
    for (const url of [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:x',
      'data:text/html,<b>', '&#106;avascript:alert(1)'
    ]) {
      const html = MD.render(`[a](${url})`);
      assert.ok(!/href="[^"]*(?:javascript|vbscript|data:text)/i.test(html), url + ' -> ' + html);
    }
  });

  test('the same neutralisation applies to images, autolinks and reference links', () => {
    assert.ok(!/src="javascript/i.test(MD.render('![i](javascript:x)')));
    assert.ok(!/href="javascript/i.test(MD.render('<javascript:alert(1)>')));
    assert.ok(!/href="javascript/i.test(MD.render('[a][r]\n\n[r]: javascript:alert(1)')));
  });

  test('data:image/* is allowed through', () => {
    assert.match(
      MD.render('![ok](data:image/png;base64,AAA)'),
      /<img src="data:image\/png;base64,AAA" alt="ok">/
    );
  });

  test('a quote in a URL, alt or title cannot break out of its attribute', () => {
    for (const src of ['[a](u"onmouseover=x)', '![a" onerror="x](i.png)', '[a](u "t\\" x")']) {
      const html = MD.render(src);
      const attrs = html.match(/(?:href|src|alt|title)="[^"]*"/g) || [];
      for (const a of attrs) {
        assert.equal(count(a, '"'), 2, `attribute broke out in ${src}: ${html}`);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * whole-document properties
 * ------------------------------------------------------------------ */

describe('document-level behaviour', () => {
  const doc = [
    '# Title',
    '',
    'Text with $a_1$ math, **bold**, `code`, a [link](http://e.com) and a bare',
    'https://example.com/x url.',
    '',
    '| a | b |',
    '| :- | -: |',
    '| 1 | 2 |',
    '',
    '- [ ] task',
    '- [x] done',
    '',
    '> quoted',
    '',
    '```js',
    'var x = 1;',
    '```',
    '',
    'Footnote[^1]',
    '',
    '[^1]: the note'
  ].join('\n');

  test('two renders of the same source are byte-identical', () => {
    const math = mathSpy();
    const a = MD.render(doc, { math });
    const b = MD.render(doc, { math: mathSpy() });
    assert.equal(a, b);
    assert.equal(MD.render(doc), MD.render(doc));
    assert.equal(JSON.stringify(MD.outline(doc)), JSON.stringify(MD.outline(doc)));
  });

  test('CRLF input renders the same as LF input', () => {
    assert.equal(MD.render(doc.replace(/\n/g, '\r\n')), MD.render(doc));
  });

  test('YAML front matter is stripped, not rendered', () => {
    const html = MD.render('---\ntitle: x\n---\n\n# H');
    assert.match(html, /<h1 id="h">H/);
    assert.ok(!html.includes('title: x'));
  });

  test('a pile of malformed input never throws', () => {
    const bad = [
      '', '   ', '\n\n\n', '\t\t', '#', '#'.repeat(40) + 'x',
      '> ', '- ', '|', '||', '|-|', '| a |\n| - |\n|',
      '[', '](', '![', ']', '[a](', '![](', '[]:', '[^', '[^]:', '[^1]', '[a][b]',
      '*', '**', '***', '***a**b*', '__a_b__', '`', '```', '~~~', '~~',
      '$', '$$', '$$$', '$$\n', '\\', '\\(', '\\[', '\\$',
      '<', '<div', '<!--', '<script>x</script>', '&', '&#;', '&amp',
      '1.', '999999999999. x', '- [ ', '- - - - -', '> > > > > > x',
      '|:-:|', 'a\n=\n=', ' ', ' MATH0 ', '�',
      'x'.repeat(20000), '|a|\n'.repeat(500)
    ];
    for (const src of bad) {
      for (const opts of [undefined, { math: mathSpy() }, { baseHeadingLevel: 4 }]) {
        assert.doesNotThrow(() => MD.render(src, opts), 'render ' + JSON.stringify(src));
      }
      assert.doesNotThrow(() => MD.outline(src), 'outline ' + JSON.stringify(src));
      assert.equal(typeof MD.render(src), 'string');
    }
  });

  test('a literal math placeholder in the source cannot inject markup', () => {
    const html = MD.render(' MATH0  and $x$', { math: mathSpy() });
    assert.equal(count(html, '<M'), 1, 'only the real math span: ' + JSON.stringify(html));
  });

  test('the rendered document has balanced block containers', () => {
    const html = MD.render(doc, { math: mathSpy() });
    for (const tag of ['table', 'thead', 'tbody', 'tr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'p']) {
      assert.equal(
        count(html, `<${tag}>`) + count(html, `<${tag} `),
        count(html, `</${tag}>`),
        `unbalanced <${tag}>`
      );
    }
  });
});
