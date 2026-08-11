/* tests/test_tex.mjs — window.TeX.toMathML, tested for STRUCTURE.
 *
 *   cd markdown-studio && node --test tests/
 *
 * Two rules this file lives by.
 *
 * 1. **Never assert on whitespace or attribute order.** Everything goes through
 *    `parseML`, a ~40-line tag matcher that turns the emitted string into a
 *    tree, and the assertions are then about shape ("an mfrac whose first child
 *    is an mn reading 1"), text, and single attributes. A formatting change in
 *    tex.js must not turn this file red; a structural change must.
 *
 * 2. **A test never pins a defect as if it were correct.** Where tex.js emits
 *    markup that is valid but paints wrong (see tests/mathml_render.py, whose
 *    three `expectedFailure` cases carry the details), the assertion here is
 *    deliberately the weaker true one — "the command was consumed and produced
 *    an mspace", not "the mspace has this exact width" — with a comment saying
 *    why. That keeps the suite honest in both directions: green today, and
 *    still green after the render bug is fixed.
 *
 * `parseML` doubles as the well-formedness oracle: it throws on a mismatched or
 * unclosed tag, so the fuzz test at the bottom is just "parse 4000 random
 * inputs' output". That is the one property no amount of hand-written cases
 * gets you — malformed markup out of an unusual token sequence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobals } from './load.mjs';

const { TeX } = loadGlobals();

/* ===================================================================== *
 * a DOM-free MathML reader                                              *
 * ===================================================================== */

const TAG_RE = /<(\/)?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/)?>/g;
const ATTR_RE = /([a-zA-Z][\w:-]*)\s*=\s*"([^"]*)"/g;

function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) out[m[1]] = decode(m[2]);
  return out;
}

/** Parse a markup string into {tag, attrs, kids, text}. Throws when the tags
 *  do not nest — which is exactly the invariant the fuzz test wants. */
function parseML(src) {
  const root = { tag: '#doc', attrs: {}, kids: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const between = src.slice(last, m.index);
    if (between) top().text += decode(between);
    last = m.index + m[0].length;
    const closing = m[1];
    const tag = m[2];
    if (closing) {
      const open = stack.pop();
      if (!open || open.tag !== tag) {
        throw new Error('mismatched </' + tag + '> (open was ' +
          (open ? open.tag : 'nothing') + ')');
      }
      continue;
    }
    const node = { tag, attrs: parseAttrs(m[3]), kids: [], text: '' };
    top().kids.push(node);
    if (!m[4]) stack.push(node);
  }
  const tail = src.slice(last);
  if (tail) top().text += decode(tail);
  if (stack.length !== 1) {
    throw new Error('unclosed ' + stack.slice(1).map((n) => n.tag).join(','));
  }
  const stray = src.replace(TAG_RE, '');
  if (/[<>]/.test(stray)) throw new Error('unescaped angle bracket in text');
  return root;
}

/** Every descendant in document order, the node itself first. */
function walk(node, out) {
  out = out || [];
  out.push(node);
  for (const k of node.kids) walk(k, out);
  return out;
}

const findAll = (node, tag) => walk(node).filter((n) => n !== node && n.tag === tag);
const find = (node, tag) => findAll(node, tag)[0];
const count = (node, tag) => findAll(node, tag).length;

/** All text under a node, tags dropped. */
function deepText(node) {
  return walk(node).map((n) => n.text).join('');
}

/** Nested tag signature: `msup(mi mn)`. No text, no attributes. */
function shape(node) {
  if (!node.kids.length) return node.tag;
  return node.tag + '(' + node.kids.map(shape).join(' ') + ')';
}

/** Nested signature with leaf text: `mfrac(mn"1" mn"2")`. */
function sig(node) {
  if (!node.kids.length) return node.tag + (node.text ? '"' + node.text + '"' : '');
  return node.tag + '(' + node.kids.map(sig).join(' ') + ')';
}

/* Compile and return the <math> root, asserting it is markup and not the
 * error fallback. Every positive test funnels through this. */
function math(tex, display) {
  const out = TeX.toMathML(tex, display);
  assert.equal(typeof out, 'string', 'toMathML must return a string');
  assert.ok(!/md-math-error/.test(out),
    'unexpected md-math-error for ' + JSON.stringify(tex) + ': ' + out);
  const doc = parseML(out);
  assert.equal(doc.kids.length, 1, 'exactly one root element for ' + JSON.stringify(tex));
  assert.equal(doc.kids[0].tag, 'math', 'root must be <math> for ' + JSON.stringify(tex));
  return doc.kids[0];
}

/** The <math> element's children, i.e. the formula's top-level row. */
const body = (tex, display) => math(tex, display).kids;

/** Compile and return the raw string, expecting the error fallback. */
function errorOf(tex, display) {
  const out = TeX.toMathML(tex, display);
  assert.equal(typeof out, 'string');
  assert.match(out, /^<span class="md-math-error"/,
    'expected md-math-error for ' + JSON.stringify(tex) + ', got ' + out.slice(0, 120));
  assert.ok(!/<math/.test(out), 'error fallback must not contain <math>');
  const span = parseML(out).kids[0];
  assert.equal(span.tag, 'span');
  assert.ok(span.attrs.title && span.attrs.title.length > 0, 'error span needs a title');
  return span;
}

/* ===================================================================== *
 * the module surface                                                    *
 * ===================================================================== */

test('module surface', () => {
  assert.equal(TeX.VERSION, '1');
  assert.equal(typeof TeX.toMathML, 'function');
  assert.deepEqual(Object.keys(TeX).sort(), ['VERSION', 'toMathML']);
});

test('display flag drives the root attribute and nothing else', () => {
  const inline = math('x', false);
  const block = math('x', true);
  assert.equal(inline.attrs.display, 'inline');
  assert.equal(block.attrs.display, 'block');
  assert.equal(inline.attrs.xmlns, 'http://www.w3.org/1998/Math/MathML');
  assert.equal(block.attrs.xmlns, 'http://www.w3.org/1998/Math/MathML');
  /* same content either way */
  assert.equal(shape(inline), shape(block));
  /* a missing/false-y flag is inline */
  assert.equal(math('x').attrs.display, 'inline');
  assert.equal(math('x', 0).attrs.display, 'inline');
  assert.equal(math('x', 1).attrs.display, 'block');
});

/* ===================================================================== *
 * numbers and identifiers                                               *
 * ===================================================================== */

test('a run of digits is one mn', () => {
  assert.equal(sig(math('12', false)), 'math(mn"12")');
  assert.equal(sig(math('2026', false)), 'math(mn"2026")');
  assert.equal(count(math('1234', false), 'mn'), 1);
});

test('a decimal point stays inside the mn', () => {
  assert.equal(sig(math('3.14', false)), 'math(mn"3.14")');
  assert.equal(sig(math('.5', false)), 'math(mn".5")');
  assert.equal(sig(math('0.007', false)), 'math(mn"0.007")');
});

test('a trailing dot is not swallowed into the number', () => {
  /* "1." at the end of a formula is punctuation, not part of the numeral */
  const k = body('1.', false);
  assert.equal(k[0].tag, 'mn');
  assert.equal(k[0].text, '1');
  assert.equal(k[1].tag, 'mo');
  assert.equal(k[1].text, '.');
});

test('a comma breaks the number', () => {
  assert.equal(sig(math('1,000', false)), 'math(mn"1" mo"," mn"000")');
});

test('single letters are mi, and each letter is its own mi', () => {
  assert.equal(sig(math('x', false)), 'math(mi"x")');
  assert.equal(sig(math('xy', false)), 'math(mi"x" mi"y")');
  assert.equal(count(math('abc', false), 'mi'), 3);
  /* no mathvariant on a plain variable: MathML italicises a one-char mi by
   * default, and asserting the attribute away is what keeps it that way */
  assert.equal(math('x', false).kids[0].attrs.mathvariant, undefined);
  assert.deepEqual(math('x', false).kids[0].attrs, {});
});

test('arithmetic operators land in mo', () => {
  assert.equal(sig(math('a+b', false)), 'math(mi"a" mo"+" mi"b")');
  assert.equal(sig(math('a=b', false)), 'math(mi"a" mo"=" mi"b")');
  /* ASCII hyphen becomes U+2212 MINUS SIGN */
  assert.equal(sig(math('a-b', false)), 'math(mi"a" mo"−" mi"b")');
  assert.equal(sig(math('a*b', false)), 'math(mi"a" mo"∗" mi"b")');
});

test('multi-letter function names are upright and spaced', () => {
  const k = body('\\sin x', false);
  assert.equal(k[0].tag, 'mi');
  assert.equal(k[0].text, 'sin');
  assert.equal(k[0].attrs.mathvariant, 'normal');
  assert.equal(k[1].tag, 'mspace');
  assert.equal(k[2].text, 'x');
});

test('every contract function name is one upright mi', () => {
  const names = ['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'arg', 'det',
    'dim', 'deg', 'gcd'];
  for (const n of names) {
    const m = math('\\' + n, false);
    const el = m.kids[0];
    assert.equal(el.tag, 'mi', '\\' + n + ' should be an mi');
    assert.equal(el.text, n, '\\' + n + ' text');
    assert.equal(el.attrs.mathvariant, 'normal', '\\' + n + ' must be upright');
  }
});

test('operatorname makes an upright mi from arbitrary text', () => {
  const m = math('\\operatorname{argmax} x', false);
  const el = m.kids[0];
  assert.equal(el.tag, 'mi');
  assert.equal(el.text, 'argmax');
  assert.equal(el.attrs.mathvariant, 'normal');
  assert.equal(count(m, 'mspace'), 1, 'thin space before the argument');
});

/* ===================================================================== *
 * fractions and binomials                                               *
 * ===================================================================== */

test('frac makes an mfrac, numerator first', () => {
  assert.equal(sig(math('\\frac{1}{2}', false)), 'math(mfrac(mn"1" mn"2"))');
  const f = find(math('\\frac{a+b}{c}', false), 'mfrac');
  assert.equal(shape(f), 'mfrac(mrow(mi mo mi) mi)');
  assert.equal(deepText(f.kids[0]), 'a+b');
  assert.equal(deepText(f.kids[1]), 'c');
  assert.equal(f.attrs.linethickness, undefined, 'frac keeps its rule');
});

test('implicit single-token arguments: \\frac12', () => {
  assert.equal(sig(math('\\frac12', false)), 'math(mfrac(mn"1" mn"2"))');
  assert.equal(sig(math('\\frac ab', false)), 'math(mfrac(mi"a" mi"b"))');
  /* a command counts as one token too */
  assert.equal(sig(math('\\frac\\alpha\\beta', false)),
    'math(mfrac(mi"α" mi"β"))');
  /* and a multi-digit implicit argument is still one digit, as in TeX */
  assert.equal(sig(math('\\frac12 3', false)), 'math(mfrac(mn"1" mn"2") mn"3")');
});

test('dfrac and tfrac wrap the same mfrac in an mstyle', () => {
  const d = math('\\dfrac{a}{b}', false).kids[0];
  assert.equal(d.tag, 'mstyle');
  assert.equal(d.attrs.displaystyle, 'true');
  assert.equal(shape(find(d, 'mfrac')), 'mfrac(mi mi)');

  const t = math('\\tfrac{a}{b}', true).kids[0];
  assert.equal(t.tag, 'mstyle');
  assert.equal(t.attrs.displaystyle, 'false');
  assert.equal(shape(find(t, 'mfrac')), 'mfrac(mi mi)');
});

test('binom is a rule-less mfrac inside round fences', () => {
  const m = math('\\binom{n}{k}', false);
  const f = find(m, 'mfrac');
  assert.equal(f.attrs.linethickness, '0');
  assert.equal(sig(f), 'mfrac(mi"n" mi"k")');
  const fences = findAll(m, 'mo').filter((o) => o.attrs.fence === 'true');
  assert.equal(fences.length, 2);
  assert.equal(fences[0].text, '(');
  assert.equal(fences[1].text, ')');
  assert.equal(fences[0].attrs.form, 'prefix');
  assert.equal(fences[1].attrs.form, 'postfix');
});

/* ===================================================================== *
 * radicals                                                              *
 * ===================================================================== */

test('sqrt without an index is an msqrt', () => {
  assert.equal(sig(math('\\sqrt{x}', false)), 'math(msqrt(mi"x"))');
  assert.equal(sig(math('\\sqrt x', false)), 'math(msqrt(mi"x"))');
  assert.equal(shape(find(math('\\sqrt{a+b}', false), 'msqrt')), 'msqrt(mi mo mi)');
  /* an empty [] is not an index */
  assert.equal(sig(math('\\sqrt[]{x}', false)), 'math(msqrt(mi"x"))');
});

test('sqrt with an index is an mroot, radicand before index', () => {
  assert.equal(sig(math('\\sqrt[3]{x}', false)), 'math(mroot(mi"x" mn"3"))');
  const r = find(math('\\sqrt[n+1]{x^2}', false), 'mroot');
  assert.equal(shape(r), 'mroot(msup(mi mn) mrow(mi mo mn))');
  assert.equal(deepText(r.kids[1]), 'n+1');
});

/* ===================================================================== *
 * scripts                                                               *
 * ===================================================================== */

test('sup, sub and both', () => {
  assert.equal(sig(math('x^2', false)), 'math(msup(mi"x" mn"2"))');
  assert.equal(sig(math('x_i', false)), 'math(msub(mi"x" mi"i"))');
  /* msubsup is base, sub, sup — in that order, whichever order TeX gave */
  assert.equal(sig(math('x_i^2', false)), 'math(msubsup(mi"x" mi"i" mn"2"))');
  assert.equal(sig(math('x^2_i', false)), 'math(msubsup(mi"x" mi"i" mn"2"))');
  assert.equal(sig(math('x^{2}_{1}', false)), 'math(msubsup(mi"x" mn"1" mn"2"))');
});

test('braced scripts group, unbraced take one token', () => {
  assert.equal(shape(math('x^{ab}', false)), 'math(msup(mi mrow(mi mi)))');
  assert.equal(shape(math('x^ab', false)), 'math(msup(mi mi) mi)');
  assert.equal(sig(math('x^{10}', false)), 'math(msup(mi"x" mn"10"))');
  assert.equal(shape(math('x^10', false)), 'math(msup(mi mn) mn)');
});

test('nested superscripts nest msup', () => {
  assert.equal(sig(math('x^{y^z}', false)), 'math(msup(mi"x" msup(mi"y" mi"z")))');
  assert.equal(shape(math('e^{x^{2^n}}', false)),
    'math(msup(mi msup(mi msup(mn mi))))');
  assert.equal(shape(math('x_{i_j}', false)), 'math(msub(mi msub(mi mi)))');
});

test('a script on a fraction scripts the whole fraction', () => {
  assert.equal(shape(math('\\frac{1}{2}^2', false)), 'math(msup(mfrac(mn mn) mn))');
});

test('primes become an msup of prime characters', () => {
  assert.equal(sig(math("f'", false)), 'math(msup(mi"f" mo"′"))');
  assert.equal(sig(math("f''", false)), 'math(msup(mi"f" mo"″"))');
  assert.equal(sig(math("f'''", false)), 'math(msup(mi"f" mo"‴"))');
  assert.equal(sig(math("f''''", false)), 'math(msup(mi"f" mo"⁗"))');
});

test('a prime binds tighter than an explicit exponent', () => {
  const s = math("x''^2", false).kids[0];
  assert.equal(s.tag, 'msup');
  assert.equal(deepText(s.kids[0]), 'x');
  assert.equal(deepText(s.kids[1]), '″2', 'prime then exponent, in that order');
});

test('a prime coexists with a subscript', () => {
  const s = math("y_1'", false).kids[0];
  assert.equal(s.tag, 'msubsup');
  assert.equal(deepText(s.kids[1]), '1');
  assert.equal(deepText(s.kids[2]), '′');
});

/* ===================================================================== *
 * big operators and limits                                              *
 * ===================================================================== */

test('sum takes limits under/over in display, beside inline', () => {
  const d = math('\\sum_{i=1}^n i', true).kids[0];
  assert.equal(d.tag, 'munderover');
  assert.equal(d.kids[0].text, '∑');
  assert.equal(deepText(d.kids[1]), 'i=1', 'under is the lower limit');
  assert.equal(deepText(d.kids[2]), 'n', 'over is the upper limit');

  const i = math('\\sum_{i=1}^n i', false).kids[0];
  assert.equal(i.tag, 'msubsup');
  assert.equal(deepText(i.kids[1]), 'i=1');
  assert.equal(deepText(i.kids[2]), 'n');
});

test('prod behaves like sum', () => {
  assert.equal(math('\\prod_{k}^{n} k', true).kids[0].tag, 'munderover');
  assert.equal(math('\\prod_{k}^{n} k', false).kids[0].tag, 'msubsup');
  assert.equal(find(math('\\prod_k k', true), 'mo').text, '∏');
});

test('a single limit gives munder or mover in display', () => {
  assert.equal(math('\\sum_{i} i', true).kids[0].tag, 'munder');
  assert.equal(math('\\sum^{n} i', true).kids[0].tag, 'mover');
  assert.equal(math('\\sum_{i} i', false).kids[0].tag, 'msub');
  assert.equal(math('\\sum^{n} i', false).kids[0].tag, 'msup');
});

test('lim and friends take limits under the name in display', () => {
  const d = math('\\lim_{x \\to 0} f', true).kids[0];
  assert.equal(d.tag, 'munder');
  assert.equal(d.kids[0].text, 'lim');
  assert.equal(deepText(d.kids[1]), 'x→0');
  assert.equal(math('\\lim_{x \\to 0} f', false).kids[0].tag, 'msub');

  /* \liminf's label carries a real U+2009 THIN SPACE, not an ASCII one */
  for (const [cmd, label] of [['liminf', 'lim inf'], ['limsup', 'lim sup'],
    ['max', 'max'], ['min', 'min'], ['inf', 'inf'], ['sup', 'sup']]) {
    const m = math('\\' + cmd + '_x f', true);
    assert.equal(m.kids[0].tag, 'munder', '\\' + cmd + ' in display');
    assert.equal(m.kids[0].kids[0].text, label, '\\' + cmd + ' label');
    assert.equal(math('\\' + cmd + '_x f', false).kids[0].tag, 'msub',
      '\\' + cmd + ' inline');
  }
});

test('integral limits sit beside the sign even in display mode', () => {
  const d = math('\\int_0^1 x', true).kids[0];
  assert.equal(d.tag, 'msubsup');
  assert.equal(d.kids[0].text, '∫');
  assert.equal(d.kids[0].attrs.movablelimits, 'false');
  assert.equal(math('\\int_0^1 x', false).kids[0].tag, 'msubsup');
  assert.equal(math('\\iint_D f', true).kids[0].tag, 'msub');
  assert.equal(find(math('\\iint_D f', true), 'mo').text, '∬');
  assert.equal(find(math('\\iiint_D f', true), 'mo').text, '∭');
  assert.equal(find(math('\\oint_C f', true), 'mo').text, '∮');
});

test('\\limits and \\nolimits override the mode', () => {
  assert.equal(math('\\int\\limits_0^1 x', true).kids[0].tag, 'munderover');
  assert.equal(math('\\int\\limits_0^1 x', false).kids[0].tag, 'munderover');
  assert.equal(math('\\sum\\nolimits_0^1 x', true).kids[0].tag, 'msubsup');
});

test('a big operator is marked largeop', () => {
  const o = find(math('\\sum_i i', true), 'mo');
  assert.equal(o.attrs.largeop, 'true');
  assert.equal(o.attrs.symmetric, 'true');
});

/* ===================================================================== *
 * \left … \right                                                        *
 * ===================================================================== */

function fencePair(tex) {
  const m = math(tex, true);
  const fences = findAll(m, 'mo').filter((o) => o.attrs.fence === 'true');
  return fences.map((f) => f.text + ':' + f.attrs.form + ':' + f.attrs.stretchy);
}

test('every supported \\left…\\right delimiter stretches', () => {
  assert.deepEqual(fencePair('\\left( a \\right)'),
    ['(:prefix:true', '):postfix:true']);
  assert.deepEqual(fencePair('\\left[ a \\right]'),
    ['[:prefix:true', ']:postfix:true']);
  assert.deepEqual(fencePair('\\left\\{ a \\right\\}'),
    ['{:prefix:true', '}:postfix:true']);
  assert.deepEqual(fencePair('\\left| a \\right|'),
    ['|:prefix:true', '|:postfix:true']);
  assert.deepEqual(fencePair('\\left\\| a \\right\\|'),
    ['‖:prefix:true', '‖:postfix:true']);
  assert.deepEqual(fencePair('\\left\\langle a \\right\\rangle'),
    ['⟨:prefix:true', '⟩:postfix:true']);
  assert.deepEqual(fencePair('\\left\\lceil a \\right\\rceil'),
    ['⌈:prefix:true', '⌉:postfix:true']);
  assert.deepEqual(fencePair('\\left\\lfloor a \\right\\rfloor'),
    ['⌊:prefix:true', '⌋:postfix:true']);
});

test('a "." delimiter is invisible, not a dot', () => {
  assert.deepEqual(fencePair('\\left. a \\right|'), ['|:postfix:true']);
  assert.deepEqual(fencePair('\\left( a \\right.'), ['(:prefix:true']);
  assert.deepEqual(fencePair('\\left. a \\right.'), []);
  assert.ok(!/\./.test(deepText(math('\\left. a \\right.', true))),
    'no literal dot should reach the output');
});

test('the fenced body is a single mrow with the content between the fences', () => {
  const m = math('\\left( \\frac{a}{b} \\right)', true);
  assert.equal(m.kids.length, 1);
  const r = m.kids[0];
  assert.equal(r.tag, 'mrow');
  assert.equal(shape(r), 'mrow(mo mfrac(mi mi) mo)');
});

test('\\middle produces a stretchy fence inside the row', () => {
  const m = math('\\left( a \\middle| b \\right)', true);
  const mid = findAll(m, 'mo').filter((o) => o.attrs.form === undefined &&
    o.attrs.fence === 'true');
  assert.equal(mid.length, 1);
  assert.equal(mid[0].text, '|');
  assert.equal(mid[0].attrs.stretchy, 'true');
});

test('unfenced brackets are non-stretchy', () => {
  const o = math('(x)', false).kids[0];
  assert.equal(o.tag, 'mo');
  assert.equal(o.attrs.stretchy, 'false');
});

/* ===================================================================== *
 * environments                                                          *
 * ===================================================================== */

function tableOf(tex, display) {
  const m = math(tex, display === undefined ? true : display);
  const t = find(m, 'mtable');
  assert.ok(t, 'expected an mtable for ' + JSON.stringify(tex));
  return t;
}

const grid = (t) => t.kids.map((tr) => tr.kids.map((td) => deepText(td)));

test('every matrix environment builds rows and columns', () => {
  const t = tableOf('\\begin{matrix} a & b \\\\ c & d \\end{matrix}');
  assert.equal(count(t, 'mtr'), 2);
  assert.deepEqual(grid(t), [['a', 'b'], ['c', 'd']]);
  assert.equal(t.kids[0].kids.length, 2, 'two mtd per row');
});

test('the bracketed matrix variants carry the right fences', () => {
  const expect = {
    matrix: [],
    pmatrix: ['(', ')'],
    bmatrix: ['[', ']'],
    Bmatrix: ['{', '}'],
    vmatrix: ['|', '|'],
    Vmatrix: ['‖', '‖']
  };
  for (const env of Object.keys(expect)) {
    const tex = '\\begin{' + env + '} a & b \\\\ c & d \\end{' + env + '}';
    const m = math(tex, true);
    const fences = findAll(m, 'mo')
      .filter((o) => o.attrs.fence === 'true')
      .map((o) => o.text);
    assert.deepEqual(fences, expect[env], env + ' fences');
    assert.deepEqual(grid(find(m, 'mtable')), [['a', 'b'], ['c', 'd']], env + ' cells');
  }
});

test('smallmatrix typesets a script size down', () => {
  const t = tableOf('\\begin{smallmatrix} a & b \\end{smallmatrix}');
  assert.equal(t.attrs.displaystyle, 'false');
  assert.equal(t.attrs.scriptlevel, '1');
});

test('cases gets a left brace, no right brace, and left-aligned cells', () => {
  const tex = '\\begin{cases} x^2 & x \\ge 0 \\\\ -x^2 & x < 0 \\end{cases}';
  const m = math(tex, true);
  const fences = findAll(m, 'mo').filter((o) => o.attrs.fence === 'true');
  assert.equal(fences.length, 1);
  assert.equal(fences[0].text, '{');
  assert.equal(fences[0].attrs.form, 'prefix');
  const t = find(m, 'mtable');
  assert.equal(count(t, 'mtr'), 2);
  for (const td of findAll(t, 'mtd')) {
    assert.equal(td.attrs.columnalign, 'left');
    assert.match(td.attrs.style || '', /text-align:left/);
  }
  assert.deepEqual(grid(t), [['x2', 'x≥0'], ['−x2', 'x<0']]);
});

test('aligned alternates right- and left-aligned columns', () => {
  const t = tableOf('\\begin{aligned} a &= b \\\\ cd &= e \\end{aligned}');
  const first = t.kids[0].kids;
  assert.equal(first[0].attrs.columnalign, 'right');
  assert.equal(first[1].attrs.columnalign, 'left');
  assert.match(first[0].attrs.style, /justify-items:end/);
  assert.match(first[1].attrs.style, /text-align:left/);
  assert.deepEqual(grid(t), [['a', '=b'], ['cd', '=e']]);
  /* display style is restated on the table, or an aligned block shrinks */
  assert.equal(t.attrs.displaystyle, 'true');
});

test('array reads its column spec for alignment and rules', () => {
  const t = tableOf('\\begin{array}{c|lr} 1 & 2 & 3 \\\\ 4 & 5 & 6 \\end{array}');
  const cells = t.kids[0].kids;
  assert.equal(cells.length, 3);
  assert.equal(cells[0].attrs.columnalign, undefined, 'c is the default, no attribute');
  assert.equal(cells[1].attrs.columnalign, 'left');
  assert.equal(cells[2].attrs.columnalign, 'right');
  assert.match(cells[1].attrs.style, /border-left:1px solid/);
  assert.ok(!/border-left/.test(cells[0].attrs.style || ''));
  assert.ok(!/border-left/.test(cells[2].attrs.style || ''));
  assert.deepEqual(grid(t), [['1', '2', '3'], ['4', '5', '6']]);
});

test('array draws outer rules from a |c|c| spec', () => {
  const t = tableOf('\\begin{array}{|c|c|} a & b \\end{array}');
  const cells = t.kids[0].kids;
  assert.match(cells[0].attrs.style, /border-left:1px solid/);
  assert.match(cells[1].attrs.style, /border-left:1px solid/);
  assert.match(cells[1].attrs.style, /border-right:1px solid/);
});

test('array with no spec still tabulates', () => {
  assert.deepEqual(grid(tableOf('\\begin{array}{} 1 & 2 \\end{array}')), [['1', '2']]);
});

test('ragged rows are padded to the widest row', () => {
  const t = tableOf('\\begin{matrix} a & b & c \\\\ d \\end{matrix}');
  assert.equal(t.kids[0].kids.length, 3);
  assert.equal(t.kids[1].kids.length, 3, 'short row padded with empty cells');
  assert.deepEqual(grid(t), [['a', 'b', 'c'], ['d', '', '']]);
});

test('a trailing \\\\ does not add an empty row', () => {
  const t = tableOf('\\begin{matrix} a \\\\ b \\\\ \\end{matrix}');
  assert.equal(count(t, 'mtr'), 2);
});

test('\\\\[dim] row spacing is accepted and dropped', () => {
  const t = tableOf('\\begin{matrix} a \\\\[1em] b \\end{matrix}');
  assert.equal(count(t, 'mtr'), 2);
  assert.deepEqual(grid(t), [['a'], ['b']]);
});

test('gathered and split are tables too', () => {
  assert.deepEqual(grid(tableOf('\\begin{gathered} a \\\\ b \\end{gathered}')),
    [['a'], ['b']]);
  assert.deepEqual(grid(tableOf('\\begin{split} a &= b \\end{split}')), [['a', '=b']]);
});

test('an environment nests inside \\left…\\right', () => {
  const m = math('\\left[\\begin{matrix} a \\end{matrix}\\right]', true);
  assert.equal(shape(m), 'math(mrow(mo mtable(mtr(mtd(mi))) mo))');
});

test('\\hline is accepted and produces no cell content', () => {
  const t = tableOf('\\begin{array}{c} \\hline a \\end{array}');
  assert.deepEqual(grid(t), [['a']]);
});

/* ===================================================================== *
 * \text                                                                 *
 * ===================================================================== */

test('text becomes an mtext and keeps its spaces', () => {
  const t = find(math('\\text{a b}', false), 'mtext');
  assert.equal(t.text, 'a b', 'the gap must be a non-breaking space');
  assert.equal(find(math('\\text{  }', false), 'mtext').text, '  ');
  assert.equal(find(math('\\text{}', false), 'mtext').text, '');
});

test('text does not parse its content as math', () => {
  const m = math('\\text{x^2 + a_1}', false);
  assert.equal(count(m, 'msup'), 0);
  assert.equal(count(m, 'msub'), 0);
  assert.equal(count(m, 'mi'), 0);
  assert.equal(find(m, 'mtext').text, 'x^2 + a_1');
});

test('text styling variants each set a style, not a mathvariant', () => {
  assert.equal(find(math('\\text{a}', false), 'mtext').attrs.style, undefined);
  assert.match(find(math('\\textbf{a}', false), 'mtext').attrs.style, /font-weight:bold/);
  assert.match(find(math('\\textit{a}', false), 'mtext').attrs.style, /font-style:italic/);
  assert.match(find(math('\\texttt{a}', false), 'mtext').attrs.style, /monospace/);
  assert.match(find(math('\\textsf{a}', false), 'mtext').attrs.style, /sans-serif/);
});

test('text mixes with maths around it', () => {
  const k = body('2\\text{ apples}', false);
  assert.equal(k[0].tag, 'mn');
  assert.equal(k[1].tag, 'mtext');
  assert.equal(k[1].text, ' apples');
});

/* ===================================================================== *
 * mathvariants                                                          *
 * ===================================================================== */

test('each mathvariant command sets the attribute', () => {
  const cases = [
    ['\\mathrm{d}', 'normal'],
    ['\\mathbf{v}', 'bold'],
    ['\\mathit{f}', 'italic'],
    ['\\mathbb{R}', 'double-struck'],
    ['\\mathcal{L}', 'script'],
    ['\\mathsf{A}', 'sans-serif'],
    ['\\mathtt{x}', 'monospace']
  ];
  for (const [tex, variant] of cases) {
    const el = math(tex, false).kids[0];
    assert.equal(el.tag, 'mi', tex + ' is an mi');
    assert.equal(el.attrs.mathvariant, variant, tex + ' mathvariant');
  }
});

test('mathvariant also transforms the character, for engines that ignore it', () => {
  /* MathML Core only honours mathvariant="normal", so the code point has to
   * carry the style. Both are emitted; they cannot disagree. */
  assert.equal(find(math('\\mathbb{R}', false), 'mi').text, 'ℝ');
  assert.equal(find(math('\\mathbb{Z}', false), 'mi').text, 'ℤ');
  assert.equal(find(math('\\mathcal{L}', false), 'mi').text, 'ℒ');
  assert.equal(find(math('\\mathbf{v}', false), 'mi').text,
    String.fromCodePoint(0x1D42F));
  /* \mathrm is the exception: upright is the attribute's own job */
  assert.equal(find(math('\\mathrm{d}', false), 'mi').text, 'd');
});

test('a variant applies to every letter of its argument', () => {
  const m = math('\\mathbf{ab}', false);
  const letters = findAll(m, 'mi');
  assert.equal(letters.length, 2);
  for (const l of letters) assert.equal(l.attrs.mathvariant, 'bold');
});

test('a variant survives a script', () => {
  const s = math('\\mathbb{R}^n', false).kids[0];
  assert.equal(s.tag, 'msup');
  assert.equal(s.kids[0].attrs.mathvariant, 'double-struck');
  assert.equal(s.kids[1].attrs.mathvariant, undefined);
});

/* ===================================================================== *
 * accents                                                               *
 * ===================================================================== */

test('accents are an mover over the base, base first', () => {
  const cases = [
    ['\\hat{a}', 'ˆ', 'false'],
    ['\\bar{a}', '¯', 'false'],
    ['\\vec{a}', '→', 'false'],
    ['\\tilde{a}', '˜', 'false'],
    ['\\dot{a}', '˙', 'false'],
    ['\\ddot{a}', '¨', 'false'],
    ['\\overline{a}', '‾', 'true'],
    ['\\overrightarrow{a}', '→', 'true']
  ];
  for (const [tex, ch, stretchy] of cases) {
    const el = math(tex, false).kids[0];
    assert.equal(el.tag, 'mover', tex + ' is an mover');
    assert.equal(el.attrs.accent, 'true', tex + ' accent flag');
    assert.equal(el.kids[0].text, 'a', tex + ' base comes first');
    assert.equal(el.kids[1].tag, 'mo', tex + ' accent is an mo');
    assert.equal(el.kids[1].text, ch, tex + ' accent character');
    assert.equal(el.kids[1].attrs.stretchy, stretchy, tex + ' stretchiness');
  }
});

test('underline and underbrace go below the base', () => {
  const u = math('\\underline{a}', false).kids[0];
  assert.equal(u.tag, 'munder');
  assert.equal(u.attrs.accentunder, 'true');
  assert.equal(u.kids[0].text, 'a');
  const b = math('\\underbrace{a}', false).kids[0];
  assert.equal(b.tag, 'munder');
  assert.equal(b.kids[1].text, '⏟');
});

test('a wide accent stretches over a multi-token base', () => {
  const el = math('\\overrightarrow{AB}', false).kids[0];
  assert.equal(shape(el), 'mover(mrow(mi mi) mo)');
  assert.equal(deepText(el.kids[0]), 'AB');
  assert.equal(el.kids[1].attrs.stretchy, 'true');
});

test('accents nest', () => {
  assert.equal(shape(math('\\dot{\\vec{x}}', false)), 'math(mover(mover(mi mo) mo))');
  assert.equal(shape(math('\\overline{\\overline{z}}', false)),
    'math(mover(mover(mi mo) mo))');
});

test('overset and underset stack an arbitrary label', () => {
  const o = math('\\overset{a}{b}', false).kids[0];
  assert.equal(o.tag, 'mover');
  assert.equal(o.kids[0].text, 'b', 'base first');
  assert.equal(o.kids[1].text, 'a');
  const u = math('\\underset{a}{b}', false).kids[0];
  assert.equal(u.tag, 'munder');
  assert.equal(u.kids[0].text, 'b');
});

/* ===================================================================== *
 * spacing                                                               *
 * ===================================================================== */

test('every spacing command becomes one mspace', () => {
  /* Widths are asserted for the positive ones only. `\!` emits a NEGATIVE
   * width, which MathML Core rejects and Chromium therefore ignores — see
   * tests/mathml_render.py::test_negative_thin_space_actually_narrows_the_gap,
   * an expectedFailure that documents it. Asserting only "one mspace, not an
   * unknown command" here keeps this test valid whichever way that is fixed. */
  const widths = {
    '\\,': '0.16667em',
    '\\:': '0.22222em',
    '\\;': '0.27778em',
    '\\quad': '1em',
    '\\qquad': '2em',
    '\\ ': '0.25em',
    '~': '0.25em',
    '\\enspace': '0.5em'
  };
  for (const cmd of Object.keys(widths)) {
    /* the trailing space keeps `\quad`+`b` from lexing as one control word */
    const m = math('a' + cmd + ' b', false);
    assert.equal(shape(m), 'math(mi mspace mi)', cmd + ' shape');
    assert.equal(find(m, 'mspace').attrs.width, widths[cmd], cmd + ' width');
  }
  const bang = math('a\\! b', false);
  assert.equal(shape(bang), 'math(mi mspace mi)', '\\! makes an mspace');
  assert.equal(count(bang, 'mtext'), 0, '\\! must not degrade to unknown text');
});

test('hspace parses a TeX dimension', () => {
  assert.equal(find(math('\\hspace{2em}x', false), 'mspace').attrs.width, '2em');
  assert.equal(find(math('\\hspace{1.5em}x', false), 'mspace').attrs.width, '1.5em');
  assert.equal(find(math('\\hspace{18mu}x', false), 'mspace').attrs.width, '1em');
});

test('a literal space between tokens is not an mspace', () => {
  assert.equal(shape(math('a b', false)), 'math(mi mi)');
  assert.equal(shape(math('a   b', false)), 'math(mi mi)');
});

test('\\\\ outside a table records a row break', () => {
  /* The emitted form today is <mspace linebreak="newline"/>, which MathML Core
   * dropped — Chromium paints no break at all (see mathml_render.py's
   * expectedFailure). The assertion is therefore "a break is represented",
   * which an mtable-based fix also satisfies. */
  const out = TeX.toMathML('a \\\\ b', true);
  assert.ok(!/md-math-error/.test(out));
  assert.match(out, /<mspace[^>]*linebreak="newline"|<mtable/);
  const m = parseML(out).kids[0];
  assert.equal(deepText(m).replace(/\s/g, ''), 'ab', 'both sides survive');
});

test('\\phantom occupies space without painting', () => {
  assert.equal(shape(math('\\phantom{x}', false)), 'math(mphantom(mi))');
  assert.equal(shape(math('\\hphantom{x}', false)), 'math(mpadded(mphantom(mi)))');
  assert.equal(find(math('\\hphantom{x}', false), 'mpadded').attrs.height, '0');
  assert.equal(find(math('\\vphantom{x}', false), 'mpadded').attrs.width, '0');
});

/* ===================================================================== *
 * Greek                                                                 *
 * ===================================================================== */

test('lower-case Greek is an italic mi', () => {
  const map = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
    epsilon: 'ϵ', zeta: 'ζ', eta: 'η', theta: 'θ',
    iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
    nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
    sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
    chi: 'χ', psi: 'ψ', omega: 'ω'
  };
  for (const name of Object.keys(map)) {
    const el = math('\\' + name, false).kids[0];
    assert.equal(el.tag, 'mi', '\\' + name + ' is an mi');
    assert.equal(el.text, map[name], '\\' + name + ' character');
    assert.equal(el.attrs.mathvariant, undefined, '\\' + name + ' stays italic');
  }
});

test('upper-case Greek is an upright mi', () => {
  const map = {
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
    Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
    Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
  };
  for (const name of Object.keys(map)) {
    const el = math('\\' + name, false).kids[0];
    assert.equal(el.tag, 'mi', '\\' + name + ' is an mi');
    assert.equal(el.text, map[name], '\\' + name + ' character');
    assert.equal(el.attrs.mathvariant, 'normal', '\\' + name + ' is upright');
  }
});

test('the \\var… variants exist, lower and upper', () => {
  const lower = {
    varepsilon: 'ε', vartheta: 'ϑ', varkappa: 'ϰ',
    varpi: 'ϖ', varrho: 'ϱ', varsigma: 'ς', varphi: 'φ'
  };
  for (const name of Object.keys(lower)) {
    const el = math('\\' + name, false).kids[0];
    assert.equal(el.text, lower[name], '\\' + name);
    assert.equal(el.tag, 'mi');
  }
  /* \varGamma is the ITALIC upper case — same glyph as \Gamma, no upright flag */
  const vg = math('\\varGamma', false).kids[0];
  assert.equal(vg.text, 'Γ');
  assert.equal(vg.attrs.mathvariant, undefined);
  assert.equal(math('\\Gamma', false).kids[0].attrs.mathvariant, 'normal');
});

/* ===================================================================== *
 * the relation / operator symbol list                                   *
 * ===================================================================== */

test('every relation and operator in the contract emits its character', () => {
  const asMo = {
    le: '≤', ge: '≥', ne: '≠', neq: '≠',
    approx: '≈', equiv: '≡', times: '×', div: '÷',
    pm: '±', cdot: '⋅', to: '→', leftarrow: '←',
    Rightarrow: '⇒', iff: '⟺', propto: '∝',
    forall: '∀', exists: '∃', in: '∈', notin: '∉',
    subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩',
    ll: '≪', gg: '≫', sim: '∼', simeq: '≃'
  };
  for (const name of Object.keys(asMo)) {
    const el = math('a \\' + name + ' b', false).kids[1];
    assert.equal(el.tag, 'mo', '\\' + name + ' is an operator');
    assert.equal(el.text, asMo[name], '\\' + name + ' character');
  }
});

test('the letterlike symbols are identifiers, not operators', () => {
  const asMi = {
    infty: '∞', partial: '∂', nabla: '∇', emptyset: '∅'
  };
  for (const name of Object.keys(asMi)) {
    const el = math('\\' + name, false).kids[0];
    assert.equal(el.tag, 'mi', '\\' + name + ' is an identifier');
    assert.equal(el.text, asMi[name], '\\' + name + ' character');
    assert.equal(el.attrs.mathvariant, 'normal');
  }
});

test('a pasted Unicode letter survives into the output', () => {
  /* tex.js classifies on /[A-Za-z]/, so `π` typed literally lands in an <mo>
   * and picks up operator spacing — reported, and pinned as an expectedFailure
   * in tests/mathml_render.py. Only the invariant that holds either way is
   * asserted here: the character arrives, and the formula is not a failure. */
  for (const tex of ['α+β', '2πr', 'é', 'Δx']) {
    const m = math(tex, false);
    for (const ch of tex.replace(/[+0-9]/g, '')) {
      assert.ok(deepText(m).includes(ch), tex + ' lost ' + ch);
    }
  }
  assert.equal(deepText(math('2πr', false)), '2πr');
});

test('ASCII relations are escaped, not emitted raw', () => {
  const out = TeX.toMathML('a < b > c', false);
  assert.match(out, /<mo>&lt;<\/mo>/);
  assert.match(out, /<mo>&gt;<\/mo>/);
  const m = parseML(out).kids[0];
  assert.equal(deepText(m), 'a<b>c');
});

test('escaped TeX specials survive as literal characters', () => {
  assert.equal(deepText(math('\\%\\$\\#\\_', false)), '%$#_');
  assert.equal(deepText(math('\\{x\\}', false)), '{x}');
  const amp = TeX.toMathML('\\&', false);
  assert.match(amp, /<mo>&amp;<\/mo>/);
  assert.equal(deepText(parseML(amp).kids[0]), '&');
});

/* ===================================================================== *
 * colour                                                                *
 * ===================================================================== */

test('\\color and \\textcolor are accepted as mathcolor', () => {
  const c = math('\\color{red}{x}', false).kids[0];
  assert.equal(c.tag, 'mstyle');
  assert.equal(c.attrs.mathcolor, 'red');
  assert.equal(deepText(c), 'x');
  const t = math('\\textcolor{#ff8800}{y}', false).kids[0];
  assert.equal(t.attrs.mathcolor, '#ff8800');
  /* the body is still parsed as maths */
  assert.equal(shape(math('\\color{blue}{\\frac12}', false)),
    'math(mstyle(mfrac(mn mn)))');
});

test('a colour that cannot be a CSS colour is dropped, not injected', () => {
  const out = TeX.toMathML('\\color{"><script>}{x}', false);
  assert.ok(!/<script/.test(out), 'no markup may escape from a colour argument');
  assert.ok(!/md-math-error/.test(out));
  assert.equal(deepText(parseML(out).kids[0]), 'x');
});

/* ===================================================================== *
 * unknown commands degrade, they do not kill the formula                *
 * ===================================================================== */

test('an unknown command becomes md-tex-unknown and the rest still parses', () => {
  const out = TeX.toMathML('a + \\nosuchmacro + b', false);
  assert.ok(!/md-math-error/.test(out), 'an unknown command is not a parse failure');
  const m = parseML(out).kids[0];
  const unknown = findAll(m, 'mtext').filter((n) => n.attrs.class === 'md-tex-unknown');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].text, '\\nosuchmacro');
  assert.equal(count(m, 'mi'), 2, 'a and b survive');
  assert.equal(count(m, 'mo'), 2, 'both + signs survive');
});

test('an unknown command inside a structure keeps the structure', () => {
  const m = math('\\frac{\\wat}{2}', false);
  assert.equal(shape(m), 'math(mfrac(mtext mn))');
  assert.equal(find(m, 'mtext').attrs.class, 'md-tex-unknown');
  const t = tableOf('\\begin{matrix} \\bogus & b \\end{matrix}');
  assert.deepEqual(grid(t), [['\\bogus', 'b']]);
});

test('an unknown environment degrades to a table rather than failing', () => {
  const out = TeX.toMathML('\\begin{whatever} a \\\\ b \\end{whatever}', true);
  assert.ok(!/md-math-error/.test(out));
  assert.equal(count(parseML(out).kids[0], 'mtr'), 2);
});

test('ignorable commands vanish silently', () => {
  assert.equal(sig(math('\\label{eq:1}x', false)), 'math(mi"x")');
  assert.equal(sig(math('\\tag{3}x', false)), 'math(mi"x")');
  assert.equal(sig(math('\\notag x', false)), 'math(mi"x")');
  assert.equal(sig(math('x%a comment\n', false)), 'math(mi"x")');
});

/* ===================================================================== *
 * structural failures                                                   *
 * ===================================================================== */

test('an unbalanced brace yields the error span', () => {
  assert.match(errorOf('{a', false).attrs.title, /brace/i);
  assert.match(errorOf('a}', false).attrs.title, /brace/i);
  assert.match(errorOf('\\frac{{a}{b}', false).attrs.title, /brace/i);
  assert.equal(errorOf('{a', false).text, '{a', 'the source is shown verbatim');
});

test('an unterminated or mismatched environment yields the error span', () => {
  assert.match(errorOf('\\begin{matrix} a', true).attrs.title, /unterminated/i);
  assert.match(errorOf('\\begin{matrix} a \\end{pmatrix}', true).attrs.title,
    /matrix/);
  assert.match(errorOf('\\end{matrix}', true).attrs.title, /begin/);
});

test('an unmatched \\left or \\right yields the error span', () => {
  assert.match(errorOf('\\left( a', true).attrs.title, /\\right/);
  assert.match(errorOf('a \\right)', true).attrs.title, /\\left/);
  assert.match(errorOf('\\left\\nonsense a \\right)', true).attrs.title, /delimiter/);
  assert.match(errorOf('\\left', true).attrs.title, /delimiter/);
});

test('a missing argument yields the error span', () => {
  for (const tex of ['x^', 'x_', '\\frac{a}', '\\text', '\\sqrt', '\\color{red}',
    '\\begin']) {
    const span = errorOf(tex, false);
    assert.ok(span.attrs.title.length > 0, tex + ' needs a message');
  }
});

test('the error span escapes the source it shows', () => {
  const out = TeX.toMathML('{<img src=x onerror=alert(1)>', false);
  assert.match(out, /^<span class="md-math-error"/);
  assert.ok(!/<img/.test(out), 'the source must not become live markup');
  assert.match(out, /&lt;img/);
  const span = parseML(out).kids[0];
  assert.equal(span.text, '{<img src=x onerror=alert(1)>');
});

test('a quote in the failure message cannot break out of the title attribute', () => {
  const out = TeX.toMathML('\\begin{a"b} x', false);
  assert.equal(typeof out, 'string');
  const doc = parseML(out);            /* throws if the attribute broke the tag */
  assert.equal(doc.kids.length, 1);
});

/* ===================================================================== *
 * never throws                                                          *
 * ===================================================================== */

test('degenerate input returns markup instead of throwing', () => {
  /* Empty input is not a parse failure — an empty <math> is the honest answer —
   * so this asserts the invariant that holds either way. */
  for (const tex of ['', '   ', '\n\t ', '%only a comment']) {
    const out = TeX.toMathML(tex, false);
    assert.equal(typeof out, 'string');
    assert.ok(/^<math|^<span class="md-math-error"/.test(out),
      JSON.stringify(tex) + ' -> ' + out);
    assert.doesNotThrow(() => parseML(out));
  }
});

test('null and undefined are treated as empty', () => {
  for (const v of [null, undefined]) {
    const out = TeX.toMathML(v, false);
    assert.equal(typeof out, 'string');
    assert.doesNotThrow(() => parseML(out));
  }
});

test('a lone backslash does not throw', () => {
  /* tex.js renders it as a literal `\` rather than flagging the formula. That
   * is a judgement call, not a contract breach, so only "never throws and the
   * output is parseable" is asserted. */
  const out = TeX.toMathML('\\', false);
  assert.equal(typeof out, 'string');
  assert.doesNotThrow(() => parseML(out));
  assert.doesNotThrow(() => TeX.toMathML('a \\ ', false));
  assert.doesNotThrow(() => TeX.toMathML('\\\\\\', false));
});

test('10k characters of junk return a string, quickly', () => {
  const junks = [
    'x'.repeat(10000),
    '1'.repeat(10000),
    '\\foo '.repeat(2000),
    '&'.repeat(10000),
    '^'.repeat(10000),
    '{'.repeat(5000),
    '}'.repeat(5000),
    '\\frac{'.repeat(2000),
    '\\left('.repeat(2000),
    '\\begin{matrix}'.repeat(500),
    '\\sqrt['.repeat(2000),
    "'".repeat(10000),
    '\\'.repeat(10000),
    'éα中'.repeat(3000)
  ];
  for (const junk of junks) {
    const t0 = Date.now();
    let out;
    assert.doesNotThrow(() => { out = TeX.toMathML(junk, false); },
      'junk starting ' + JSON.stringify(junk.slice(0, 12)));
    assert.equal(typeof out, 'string');
    assert.doesNotThrow(() => parseML(out), 'well-formed output for junk');
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, JSON.stringify(junk.slice(0, 12)) + ' took ' + ms + 'ms');
  }
});

test('deep nesting is reported, not crashed', () => {
  /* Deep enough to exhaust the recursive-descent stack. Whatever happens, it
   * must arrive as the error span, not as a thrown RangeError. */
  const deep = '{'.repeat(20000) + 'x' + '}'.repeat(20000);
  let out;
  assert.doesNotThrow(() => { out = TeX.toMathML(deep, false); });
  assert.ok(/^<math|^<span class="md-math-error"/.test(out));
  assert.doesNotThrow(() => parseML(out));
});

/* ===================================================================== *
 * determinism and well-formedness                                       *
 * ===================================================================== */

test('the same input compiles byte-identically', () => {
  const samples = [
    '\\frac{1}{2}', '\\sum_{i=1}^n i', '\\begin{cases}a&b\\\\c&d\\end{cases}',
    '\\left(\\frac{x}{y}\\right)', '{a', '\\text{hi there}'
  ];
  for (const s of samples) {
    assert.equal(TeX.toMathML(s, true), TeX.toMathML(s, true), s + ' display');
    assert.equal(TeX.toMathML(s, false), TeX.toMathML(s, false), s + ' inline');
  }
});

test('real-world formulas compile without the error fallback', () => {
  const corpus = [
    'e^{i\\pi} + 1 = 0',
    '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
    '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}',
    '\\frac{\\partial u}{\\partial t} = \\alpha \\nabla^2 u',
    '\\mathbf{A}\\mathbf{x} = \\lambda \\mathbf{x}',
    '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}^{-1}',
    'f(x) = \\begin{cases} x^2 & x \\ge 0 \\\\ -x^2 & x < 0 \\end{cases}',
    '\\begin{aligned} (a+b)^2 &= a^2 + 2ab + b^2 \\\\ &= b^2 + 2ab + a^2 \\end{aligned}',
    '\\left\\| \\vec{v} \\right\\|_2 = \\sqrt{\\sum_i v_i^2}',
    '\\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}',
    'P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}',
    '\\mathcal{L}(\\theta) = -\\frac{1}{N}\\sum_{i=1}^{N} \\log p_\\theta(y_i)',
    '\\binom{n}{k} = \\frac{n!}{k!\\,(n-k)!}',
    '\\overline{A \\cup B} = \\overline{A} \\cap \\overline{B}',
    '\\Gamma(z) = \\int_0^\\infty t^{z-1} e^{-t}\\,\\mathrm{d}t',
    '\\begin{array}{c|cc} & 0 & 1 \\\\ \\hline 0 & 0 & 1 \\end{array}',
    '\\max_{x \\in \\mathcal{X}} f(x) \\le \\sup_x f(x)',
    '\\hat{y} = \\mathbf{w}^\\top \\mathbf{x} + b',
    '\\left\\langle \\psi \\middle| \\phi \\right\\rangle',
    '\\text{Var}(X) = E[X^2] - (E[X])^2'
  ];
  for (const tex of corpus) {
    for (const display of [true, false]) {
      const out = TeX.toMathML(tex, display);
      assert.ok(!/md-math-error/.test(out), tex + ' -> ' + out.slice(0, 120));
      assert.ok(!/md-tex-unknown/.test(out),
        tex + ' uses only supported commands, but got md-tex-unknown');
      assert.doesNotThrow(() => parseML(out), tex);
    }
  }
});

test('fuzzed token soup never throws and never emits malformed markup', () => {
  const PIECES = ['{', '}', '^', '_', '&', '\\\\', '\\frac', '\\sqrt', '[3]',
    '\\left(', '\\right)', '\\begin{matrix}', '\\end{matrix}', '\\begin{cases}',
    '\\end{pmatrix}', '\\begin{array}', '{cc}', 'a', '1', '.', '\\alpha',
    '\\sum', '\\int', '\\text{hi}', '\\foo', '~', '\\,', '\\!', '\\vec',
    '\\color{red}', '\\mathbb', "'", '|', '\\|', '\\langle', '\\middle|',
    '%c\n', '\\limits', '\\nolimits', '\\operatorname{f}', '\\hspace{1em}',
    '<', '>', '&amp;', '"'];
  let seed = 20260810;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let errors = 0;
  for (let i = 0; i < 4000; i++) {
    let tex = '';
    const k = 1 + rand(9);
    for (let j = 0; j < k; j++) tex += PIECES[rand(PIECES.length)];
    let out;
    assert.doesNotThrow(() => { out = TeX.toMathML(tex, i % 2 === 0); },
      'threw on ' + JSON.stringify(tex));
    assert.equal(typeof out, 'string', JSON.stringify(tex));
    if (/md-math-error/.test(out)) errors++;
    /* parseML throws on a mismatched tag, an unclosed tag, or a raw < or >
     * outside a tag — the three ways a string-building emitter goes wrong. */
    assert.doesNotThrow(() => parseML(out),
      'malformed markup for ' + JSON.stringify(tex) + ': ' + out.slice(0, 160));
  }
  assert.ok(errors > 0, 'the fuzz corpus should include some genuine failures');
  assert.ok(errors < 4000, 'the fuzz corpus should also include some successes');
});
