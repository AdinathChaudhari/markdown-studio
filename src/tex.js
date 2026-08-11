/* ===========================================================================
 * tex.js — window.TeX
 *
 * A hand-written TeX-math -> MathML Core compiler. Tokenizer -> recursive
 * descent parser -> MathML string. No dependencies, no font, no layout work:
 * MathML Core is rendered natively by Safari, Chrome 109+ and Firefox, which is
 * the whole reason this project ships without KaTeX or MathJax.
 *
 *   window.TeX.toMathML(tex, display) -> String     // never throws
 *
 * ---------------------------------------------------------------------------
 * SUPPORTED
 * ---------------------------------------------------------------------------
 * structure   { }  ^  _  '  ''  ''' , \limits \nolimits, \\ (line break),
 *             & (column break), % comments
 * fractions   \frac \dfrac \tfrac \cfrac \binom \dbinom \tbinom \over-free
 * radicals    \sqrt \sqrt[n]
 * big ops     \sum \prod \coprod \int \iint \iiint \iiiint \oint \oiint
 *             \bigcup \bigcap \bigsqcup \bigvee \bigwedge \bigoplus \bigotimes
 *             \bigodot \biguplus
 *             \lim \liminf \limsup \max \min \inf \sup \argmax \argmin
 *             (under/over in display mode, beside inline; \int always beside)
 * functions   \sin \cos \tan \cot \sec \csc \arcsin \arccos \arctan \sinh
 *             \cosh \tanh \coth \log \ln \lg \exp \arg \det \dim \deg \gcd
 *             \hom \ker \Pr \operatorname{...} \bmod \pmod
 * fences      \left \middle \right with ( ) [ ] \{ \} | \| \langle \rangle
 *             \lceil \rceil \lfloor \rfloor \uparrow \downarrow / \backslash .
 * matrices    \begin{matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix
 *             |cases|dcases|aligned|align|align*|split|gathered|gather|array
 *             |subarray} ... \end{...}   ( array reads its {lcr|} spec )
 * text        \text \textrm \textbf \textit \texttt \textsf \emph \mbox
 * variants    \mathrm \mathbf \mathit \mathbb \mathcal \mathscr \mathfrak
 *             \mathsf \mathtt \boldsymbol \bm  and the scoped \rm \bf \it \sf
 *             \tt \cal forms
 * styles      \displaystyle \textstyle \scriptstyle \scriptscriptstyle (scoped)
 * accents     \hat \widehat \bar \overline \underline \vec \overrightarrow
 *             \overleftarrow \overleftrightarrow \tilde \widetilde \dot \ddot
 *             \dddot \check \breve \acute \grave \mathring \overbrace
 *             \underbrace \overset \underset \stackrel
 * spacing     \, \: \> \; \! \  ~ \quad \qquad \enspace \hspace{d} \mspace{d}
 *             \phantom \hphantom \vphantom \boxed \cancel
 * symbols     the full Greek alphabet (lower, upper, \var... variants) and the
 *             relation / operator / arrow / set / logic / letterlike tables
 *             below (several hundred names)
 * colour      \color{c}{...} and \textcolor{c}{...} -> mathcolor
 * ignored     \label \tag \notag \nonumber \nolimits* \hline \hdashline
 *             \! inside tables, \vspace
 *
 * ---------------------------------------------------------------------------
 * OUT OF SCOPE (deliberately)
 * ---------------------------------------------------------------------------
 * macro definition (\def \newcommand \let \renewcommand), \begin{equation} and
 * friends' numbering, \substack, \genfrac, \raisebox, \rule, \mathchoice,
 * \multicolumn, \hfill / alignment tabs beyond &, TeX dimensions in anything
 * but \hspace, font sizing (\tiny \Large ...), \require, chemistry/physics
 * packages, and anything that needs real glyph metrics. An unrecognised
 * command is NOT fatal: it is emitted as <mtext class="md-tex-unknown"> and
 * parsing continues. Only a structural failure (unbalanced braces, \left with
 * no \right, an unterminated environment) yields the contract's
 * <span class="md-math-error"> fallback.
 * =========================================================================== */

(function () {
  'use strict';

  var VERSION = '1';

  /* ------------------------------------------------------------------ *
   * escaping                                                            *
   * ------------------------------------------------------------------ */

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function TexError(msg) {
    this.name = 'TexError';
    this.message = msg;
  }
  TexError.prototype = Object.create(Error.prototype);
  TexError.prototype.constructor = TexError;

  function fail(msg) {
    throw new TexError(msg);
  }

  /* ------------------------------------------------------------------ *
   * symbol tables                                                       *
   * ------------------------------------------------------------------ */

  /* Greek — lower case renders italic (<mi>), upper case upright, exactly as
   * plain TeX does. \varGamma etc. give the italic upper-case forms. */
  var GREEK_LOWER = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
    epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    varkappa: 'ϰ', lambda: 'λ', mu: 'μ', nu: 'ν',
    xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
    rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς',
    tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ',
    chi: 'χ', psi: 'ψ', omega: 'ω', digamma: 'ϝ'
  };

  var GREEK_UPPER = {
    Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ',
    Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ',
    Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
    Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π',
    Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ',
    Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω'
  };

  /* Letterlike things that behave as identifiers, not operators. */
  var MI_SYMBOLS = {
    infty: '∞', partial: '∂', nabla: '∇',
    emptyset: '∅', varnothing: '∅', aleph: 'ℵ',
    beth: 'ℶ', gimel: 'ℷ', daleth: 'ℸ',
    hbar: 'ℏ', hslash: 'ℏ', ell: 'ℓ', wp: '℘',
    Re: 'ℜ', Im: 'ℑ', imath: 'ı', jmath: 'ȷ',
    angle: '∠', measuredangle: '∡', sphericalangle: '∢',
    triangle: '△', square: '□', blacksquare: '■',
    diamond: '⋄', Diamond: '◇', clubsuit: '♣',
    diamondsuit: '♢', heartsuit: '♡', spadesuit: '♠',
    flat: '♭', natural: '♮', sharp: '♯',
    degree: '°', prime: '′', backprime: '‵',
    complement: '∁', mho: '℧', circledS: 'Ⓢ',
    top: '⊤', bot: '⊥'
  };

  /* Everything else is an operator. The MathML operator dictionary supplies
   * spacing automatically, so these need no lspace/rspace of their own. */
  var MO_SYMBOLS = {
    /* relations */
    le: '≤', leq: '≤', leqslant: '⩽',
    ge: '≥', geq: '≥', geqslant: '⩾',
    ne: '≠', neq: '≠', equiv: '≡', nequiv: '≢',
    approx: '≈', approxeq: '≊', cong: '≅', ncong: '≇',
    sim: '∼', simeq: '≃', nsim: '≁', asymp: '≍',
    propto: '∝', doteq: '≐', triangleq: '≜',
    ll: '≪', gg: '≫', lll: '⋘', ggg: '⋙',
    prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰',
    nprec: '⊀', nsucc: '⊁',
    lesssim: '≲', gtrsim: '≳',
    perp: '⊥', parallel: '∥', nparallel: '∦', mid: '∣',
    nmid: '∤', vdash: '⊢', dashv: '⊣', models: '⊨',
    vDash: '⊨', Vdash: '⊩',
    nless: '≮', ngtr: '≯', nleq: '≰', ngeq: '≱',
    /* set theory */
    in: '∈', notin: '∉', ni: '∋', owns: '∋',
    subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
    subsetneq: '⊊', supsetneq: '⊋',
    nsubseteq: '⊈', nsupseteq: '⊉',
    sqsubset: '⊏', sqsupset: '⊐',
    sqsubseteq: '⊑', sqsupseteq: '⊒',
    cup: '∪', cap: '∩', uplus: '⊎',
    sqcup: '⊔', sqcap: '⊓',
    setminus: '∖', smallsetminus: '∖',
    /* logic */
    forall: '∀', exists: '∃', nexists: '∄',
    neg: '¬', lnot: '¬', land: '∧', wedge: '∧',
    lor: '∨', vee: '∨', therefore: '∴', because: '∵',
    /* binary operators */
    times: '×', div: '÷', pm: '±', mp: '∓',
    cdot: '⋅', centerdot: '·', ast: '∗', star: '⋆',
    circ: '∘', bullet: '∙', amalg: '⨿',
    oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘',
    odot: '⊙', boxplus: '⊞', boxtimes: '⊠',
    ltimes: '⋉', rtimes: '⋊', wr: '≀', bowtie: '⋈',
    dagger: '†', ddagger: '‡',
    triangleleft: '◁', triangleright: '▷',
    bigtriangleup: '△', bigtriangledown: '▽',
    /* arrows */
    to: '→', rightarrow: '→', gets: '←', leftarrow: '←',
    longrightarrow: '⟶', longleftarrow: '⟵',
    leftrightarrow: '↔', longleftrightarrow: '⟷',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
    Longrightarrow: '⟹', Longleftarrow: '⟸',
    Longleftrightarrow: '⟺',
    implies: '⟹', impliedby: '⟸', iff: '⟺',
    mapsto: '↦', longmapsto: '⟼',
    hookrightarrow: '↪', hookleftarrow: '↩',
    uparrow: '↑', downarrow: '↓', updownarrow: '↕',
    Uparrow: '⇑', Downarrow: '⇓', Updownarrow: '⇕',
    nearrow: '↗', searrow: '↘', swarrow: '↙', nwarrow: '↖',
    rightharpoonup: '⇀', rightharpoondown: '⇁',
    leftharpoonup: '↼', leftharpoondown: '↽',
    rightleftharpoons: '⇌', leftrightarrows: '⇆',
    nrightarrow: '↛', nleftarrow: '↚', nRightarrow: '⇏',
    /* punctuation / misc */
    ldots: '…', dots: '…', dotsc: '…', dotsb: '⋯',
    cdots: '⋯', vdots: '⋮', ddots: '⋱',
    colon: ':', semicolon: ';',
    lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
    langle: '⟨', rangle: '⟩',
    lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']',
    vert: '|', Vert: '‖', lvert: '|', rvert: '|',
    lVert: '‖', rVert: '‖',
    backslash: '\\', surd: '√',
    checkmark: '✓', dag: '†', ddag: '‡'
  };

  /* single-character control sequences that stand for themselves */
  var LITERAL_CMDS = {
    '{': '{', '}': '}', '$': '$', '%': '%', '&': '&', '#': '#', '_': '_',
    '|': '‖'
  };

  /* Big operators. `beside` forces msubsup even in display mode (integrals). */
  var BIG_OPS = {
    sum: { c: '∑' }, prod: { c: '∏' }, coprod: { c: '∐' },
    bigcup: { c: '⋃' }, bigcap: { c: '⋂' },
    bigsqcup: { c: '⨆' }, biguplus: { c: '⨄' },
    bigvee: { c: '⋁' }, bigwedge: { c: '⋀' },
    bigoplus: { c: '⨁' }, bigotimes: { c: '⨂' },
    bigodot: { c: '⨀' },
    int: { c: '∫', beside: true }, intop: { c: '∫', beside: true },
    iint: { c: '∬', beside: true }, iiint: { c: '∭', beside: true },
    iiiint: { c: '⨌', beside: true },
    idotsint: { c: '∫⋯∫', beside: true },
    oint: { c: '∮', beside: true }, oiint: { c: '∯', beside: true },
    oiiint: { c: '∰', beside: true }
  };

  /* Named operators that take limits under/over in display mode. */
  var LIMIT_OPS = {
    lim: 'lim', liminf: 'lim inf', limsup: 'lim sup',
    max: 'max', min: 'min', inf: 'inf', sup: 'sup',
    argmax: 'arg max', argmin: 'arg min',
    injlim: 'inj lim', projlim: 'proj lim',
    varlimsup: 'lim sup', varliminf: 'lim inf'
  };

  /* Upright function names; they get a thin space before their argument. */
  var FUNCTIONS = [
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
    'arcsin', 'arccos', 'arctan', 'arccot',
    'sinh', 'cosh', 'tanh', 'coth',
    'log', 'ln', 'lg', 'exp', 'arg', 'det', 'dim', 'deg', 'gcd', 'lcm',
    'hom', 'ker', 'Pr', 'sgn', 'erf'
  ];
  var FUNCTION_SET = {};
  (function () {
    for (var i = 0; i < FUNCTIONS.length; i++) FUNCTION_SET[FUNCTIONS[i]] = true;
  })();

  /* Accents: [character, stretchy, under?]
   *
   * The exact code points matter and were chosen by rendering them in Chromium
   * and WebKit rather than by reading the spec. Only some characters have the
   * horizontal glyph-variant construction a stretchy <mo> needs:
   *   - \widehat must be U+0302 (combining circumflex); U+005E does not stretch
   *     in Chromium at all, so \widehat{xyz} came out hatted over the y only.
   *   - \overline must be U+203E (OVERLINE); U+00AF (MACRON) stretches in
   *     WebKit but not in Chromium, which barred the first letter only.
   *   - \hat/\tilde use the modifier-letter forms (U+02C6/U+02DC): plain ASCII
   *     '^' renders as an oversized ∧ in WebKit.
   *   - \widetilde has no stretchy form either engine agrees on; U+007E is the
   *     best available (stretches in WebKit, centred in Chromium).
   */
  var ACCENTS = {
    hat: ['ˆ', false], widehat: ['̂', true],
    check: ['ˇ', false], widecheck: ['̌', true],
    tilde: ['˜', false], widetilde: ['~', true],
    acute: ['´', false], grave: ['`', false],
    breve: ['˘', false], mathring: ['˚', false],
    dot: ['˙', false], ddot: ['¨', false], dddot: ['˙˙˙', false],
    bar: ['¯', false], overline: ['‾', true],
    vec: ['→', false], overrightarrow: ['→', true],
    overleftarrow: ['←', true], overleftrightarrow: ['↔', true],
    overbrace: ['⏞', true],
    underline: ['_', true, 'under'],
    underbrace: ['⏟', true, 'under'],
    underrightarrow: ['→', true, 'under'],
    underleftarrow: ['←', true, 'under']
  };

  /* Fixed-width spacing commands, in em. */
  var SPACES = {
    ',': 0.16667, ':': 0.22222, '>': 0.22222, ';': 0.27778, '!': -0.16667,
    ' ': 0.25, thinspace: 0.16667, medspace: 0.22222, thickspace: 0.27778,
    negthinspace: -0.16667, negmedspace: -0.22222, negthickspace: -0.27778,
    enspace: 0.5, quad: 1, qquad: 2, nobreakspace: 0.25, space: 0.25
  };

  /* Delimiters usable after \left / \right / \middle. */
  var DELIM_CHARS = {
    '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '/': '/',
    '<': '⟨', '>': '⟩', '.': null
  };
  var DELIM_CMDS = {
    '{': '{', '}': '}', '|': '‖',
    lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']',
    langle: '⟨', rangle: '⟩',
    lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
    vert: '|', Vert: '‖', lvert: '|', rvert: '|',
    lVert: '‖', rVert: '‖',
    backslash: '\\', uparrow: '↑', downarrow: '↓',
    updownarrow: '↕', Uparrow: '⇑', Downarrow: '⇓',
    Updownarrow: '⇕', lgroup: '⟮', rgroup: '⟯'
  };

  /* Environments. */
  var ENVS = {
    matrix: { left: null, right: null, style: 'matrix' },
    'matrix*': { left: null, right: null, style: 'matrix' },
    pmatrix: { left: '(', right: ')', style: 'matrix' },
    bmatrix: { left: '[', right: ']', style: 'matrix' },
    Bmatrix: { left: '{', right: '}', style: 'matrix' },
    vmatrix: { left: '|', right: '|', style: 'matrix' },
    Vmatrix: { left: '‖', right: '‖', style: 'matrix' },
    smallmatrix: { left: null, right: null, style: 'matrix', small: true },
    cases: { left: '{', right: null, style: 'cases' },
    dcases: { left: '{', right: null, style: 'cases' },
    rcases: { left: null, right: '}', style: 'cases' },
    aligned: { left: null, right: null, style: 'aligned' },
    align: { left: null, right: null, style: 'aligned' },
    'align*': { left: null, right: null, style: 'aligned' },
    alignedat: { left: null, right: null, style: 'aligned' },
    split: { left: null, right: null, style: 'aligned' },
    eqnarray: { left: null, right: null, style: 'aligned' },
    'eqnarray*': { left: null, right: null, style: 'aligned' },
    gathered: { left: null, right: null, style: 'gathered' },
    gather: { left: null, right: null, style: 'gathered' },
    'gather*': { left: null, right: null, style: 'gathered' },
    subarray: { left: null, right: null, style: 'gathered' },
    array: { left: null, right: null, style: 'array' },
    darray: { left: null, right: null, style: 'array' }
  };

  /* Commands that are silently dropped, with the number of {}-args to eat. */
  var IGNORED = {
    label: 1, tag: 1, 'tag*': 1, notag: 0, nonumber: 0,
    hline: 0, hdashline: 0, noalign: 1, allowbreak: 0,
    displaylines: 0, mathstrut: 0, strut: 0, relax: 0
  };

  /* mathvariant selectors. */
  var VARIANT_CMDS = {
    mathrm: 'normal', mathnormal: null, mathit: 'italic', mathbf: 'bold',
    mathbb: 'double-struck', mathcal: 'script', mathscr: 'script',
    mathfrak: 'fraktur', mathsf: 'sans-serif', mathtt: 'monospace',
    boldsymbol: 'bold-italic', bm: 'bold-italic', pmb: 'bold',
    Bbb: 'double-struck', bold: 'bold', frak: 'fraktur'
  };

  /* Scoped (rest-of-group) font selectors, the old TeX spelling. */
  var SCOPED_VARIANTS = {
    rm: 'normal', bf: 'bold', it: 'italic', sf: 'sans-serif',
    tt: 'monospace', cal: 'script', frak: 'fraktur', bbb: 'double-struck'
  };

  /* Scoped style selectors. */
  var SCOPED_STYLES = {
    displaystyle: ' displaystyle="true" scriptlevel="0"',
    textstyle: ' displaystyle="false" scriptlevel="0"',
    scriptstyle: ' displaystyle="false" scriptlevel="1"',
    scriptscriptstyle: ' displaystyle="false" scriptlevel="2"'
  };

  /* Text-mode style commands -> inline CSS (mathvariant on <mtext> is not
   * reliable in MathML Core, plain CSS is). */
  var TEXT_STYLES = {
    text: '', textnormal: '', textrm: '', mbox: '', hbox: '',
    textbf: 'font-weight:bold', textit: 'font-style:italic',
    emph: 'font-style:italic', textsl: 'font-style:italic',
    texttt: 'font-family:monospace', textsf: 'font-family:sans-serif',
    textmd: 'font-weight:normal', textup: 'font-style:normal'
  };

  /* ------------------------------------------------------------------ *
   * unicode math-alphanumeric transform                                 *
   * ------------------------------------------------------------------ */

  var VARIANT_BASE = {
    'bold': { u: 0x1D400, l: 0x1D41A, d: 0x1D7CE },
    'italic': { u: 0x1D434, l: 0x1D44E, d: null },
    'bold-italic': { u: 0x1D468, l: 0x1D482, d: null },
    'script': { u: 0x1D49C, l: 0x1D4B6, d: null },
    'bold-script': { u: 0x1D4D0, l: 0x1D4EA, d: null },
    'fraktur': { u: 0x1D504, l: 0x1D51E, d: null },
    'bold-fraktur': { u: 0x1D56C, l: 0x1D586, d: null },
    'double-struck': { u: 0x1D538, l: 0x1D552, d: 0x1D7D8 },
    'sans-serif': { u: 0x1D5A0, l: 0x1D5BA, d: 0x1D7E2 },
    'bold-sans-serif': { u: 0x1D5D4, l: 0x1D5EE, d: 0x1D7EC },
    'sans-serif-italic': { u: 0x1D608, l: 0x1D622, d: null },
    'sans-serif-bold-italic': { u: 0x1D63C, l: 0x1D656, d: null },
    'monospace': { u: 0x1D670, l: 0x1D68A, d: 0x1D7F6 }
  };

  /* Reserved code points inside those blocks; the real glyph lives in the
   * Letterlike Symbols block instead. */
  var VARIANT_HOLES = {
    'italic:h': 'ℎ',
    'script:B': 'ℬ', 'script:E': 'ℰ', 'script:F': 'ℱ',
    'script:H': 'ℋ', 'script:I': 'ℐ', 'script:L': 'ℒ',
    'script:M': 'ℳ', 'script:R': 'ℛ',
    'script:e': 'ℯ', 'script:g': 'ℊ', 'script:o': 'ℴ',
    'fraktur:C': 'ℭ', 'fraktur:H': 'ℌ', 'fraktur:I': 'ℑ',
    'fraktur:R': 'ℜ', 'fraktur:Z': 'ℨ',
    'double-struck:C': 'ℂ', 'double-struck:H': 'ℍ',
    'double-struck:N': 'ℕ', 'double-struck:P': 'ℙ',
    'double-struck:Q': 'ℚ', 'double-struck:R': 'ℝ',
    'double-struck:Z': 'ℤ'
  };

  function fromCode(cp) {
    if (String.fromCodePoint) return String.fromCodePoint(cp);
    cp -= 0x10000;
    return String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
  }

  /* Emitting BOTH the transformed character and the mathvariant attribute is
   * deliberate: engines that implement the attribute re-transform a character
   * that is already outside A-Za-z0-9 to itself, so the two can never fight. */
  function variantChars(text, variant) {
    var base = VARIANT_BASE[variant];
    if (!base) return text;
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var hole = VARIANT_HOLES[variant + ':' + ch];
      if (hole) { out += hole; continue; }
      var code = text.charCodeAt(i);
      if (code >= 65 && code <= 90) out += fromCode(base.u + (code - 65));
      else if (code >= 97 && code <= 122) out += fromCode(base.l + (code - 97));
      else if (code >= 48 && code <= 57 && base.d) out += fromCode(base.d + (code - 48));
      else out += ch;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * tokenizer                                                           *
   * ------------------------------------------------------------------ */

  /* Token types: 'cmd' 'char' '{' '}' '^' '_' '&' 'nl' 'prime' 'eof' */

  function Lexer(src) {
    this.src = String(src == null ? '' : src);
    this.pos = 0;
    this.buf = [];
  }

  Lexer.prototype.tok = function (type, value, pos) {
    return { type: type, value: value, pos: pos };
  };

  Lexer.prototype.scan = function () {
    var src = this.src, n = src.length;
    /* skip whitespace and comments */
    for (;;) {
      while (this.pos < n && /[ \t\r\n]/.test(src.charAt(this.pos))) this.pos++;
      if (src.charAt(this.pos) === '%') {
        while (this.pos < n && src.charAt(this.pos) !== '\n') this.pos++;
        continue;
      }
      break;
    }
    var start = this.pos;
    if (start >= n) return this.tok('eof', null, start);
    var c = src.charAt(this.pos);

    if (c === '\\') {
      var rest = src.slice(this.pos + 1);
      var m = /^[a-zA-Z]+\*?/.exec(rest);
      if (m) {
        this.pos += 1 + m[0].length;
        /* a control word swallows the whitespace after it */
        while (this.pos < n && /[ \t]/.test(src.charAt(this.pos))) this.pos++;
        return this.tok('cmd', m[0], start);
      }
      var next = src.charAt(this.pos + 1);
      if (next === '') { this.pos++; return this.tok('char', '\\', start); }
      this.pos += 2;
      if (next === '\\') return this.tok('nl', '\\\\', start);
      return this.tok('cmd', next, start);
    }
    this.pos++;
    if (c === '{') return this.tok('{', '{', start);
    if (c === '}') return this.tok('}', '}', start);
    if (c === '^') return this.tok('^', '^', start);
    if (c === '_') return this.tok('_', '_', start);
    if (c === '&') return this.tok('&', '&', start);
    if (c === "'") return this.tok('prime', "'", start);
    if (c === '~') return this.tok('cmd', 'nobreakspace', start);
    return this.tok('char', c, start);
  };

  Lexer.prototype.next = function () {
    return this.buf.length ? this.buf.shift() : this.scan();
  };

  Lexer.prototype.peek = function () {
    if (!this.buf.length) this.buf.push(this.scan());
    return this.buf[0];
  };

  Lexer.prototype.unread = function (t) {
    this.buf.unshift(t);
  };

  /* Two-token lookahead, used only for "is this dot part of a number". */
  Lexer.prototype.peek2 = function () {
    var a = this.next(), b = this.next();
    this.unread(b);
    this.unread(a);
    return b;
  };

  /* Rewind the raw cursor to just before whatever is buffered, so raw
   * (verbatim) scanning can take over from token scanning. */
  Lexer.prototype.sync = function () {
    if (this.buf.length) {
      this.pos = this.buf[0].pos;
      this.buf.length = 0;
    }
  };

  Lexer.prototype.rawAtBrace = function () {
    this.sync();
    var i = this.pos, src = this.src;
    while (i < src.length && /[ \t\r\n]/.test(src.charAt(i))) i++;
    return src.charAt(i) === '{';
  };

  /* Read one {...} verbatim (balanced, escapes respected). Falls back to a
   * single character when the argument is not braced. */
  Lexer.prototype.readRawArg = function () {
    this.sync();
    var src = this.src, n = src.length, i = this.pos;
    while (i < n && /[ \t\r\n]/.test(src.charAt(i))) i++;
    if (i >= n) fail('missing argument');
    if (src.charAt(i) !== '{') {
      if (src.charAt(i) === '\\' && /[a-zA-Z]/.test(src.charAt(i + 1) || '')) {
        var m = /^\\([a-zA-Z]+)/.exec(src.slice(i));
        this.pos = i + m[0].length;
        return m[1];
      }
      this.pos = i + 1;
      return src.charAt(i);
    }
    i++;
    var depth = 1, out = '';
    for (; i < n; i++) {
      var c = src.charAt(i);
      if (c === '\\' && i + 1 < n) { out += c + src.charAt(i + 1); i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
      out += c;
    }
    if (depth !== 0) fail('unbalanced braces');
    this.pos = i;
    return out;
  };

  /* Skip an optional [...] argument if one is present. */
  Lexer.prototype.skipOptional = function () {
    this.sync();
    var src = this.src, i = this.pos;
    while (i < src.length && /[ \t]/.test(src.charAt(i))) i++;
    if (src.charAt(i) !== '[') return null;
    var j = src.indexOf(']', i);
    if (j < 0) return null;
    var body = src.slice(i + 1, j);
    this.pos = j + 1;
    return body;
  };

  function textUnescape(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c !== '\\') { out += c; continue; }
      var m = /^\\([a-zA-Z]+|[\s\S])/.exec(s.slice(i));
      if (!m) { out += c; continue; }
      var name = m[1];
      i += m[0].length - 1;
      if ('{}$%&_#'.indexOf(name) >= 0) out += name;
      else if (name === ' ' || name === ',' || name === ':' || name === ';') out += ' ';
      else if (name === 'quad') out += ' ';
      else if (name === 'qquad') out += '  ';
      else if (name === 'ldots' || name === 'dots') out += '…';
      else if (name === 'textbackslash') out += '\\';
      else if (name === ' ') out += ' ';
      else if (GREEK_LOWER[name]) out += GREEK_LOWER[name];
      else if (GREEK_UPPER[name]) out += GREEK_UPPER[name];
      else out += '\\' + name;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * node constructors                                                   *
   * ------------------------------------------------------------------ */

  function mi(text, variant) { return { t: 'mi', text: text, variant: variant || null }; }
  function mn(text, variant) { return { t: 'mn', text: text, variant: variant || null }; }
  function mo(text, attrs) { return { t: 'mo', text: text, attrs: attrs || '' }; }
  function mtext(text, style, cls) {
    return { t: 'mtext', text: text, style: style || '', cls: cls || '' };
  }
  function mspace(em) { return { t: 'mspace', em: em }; }
  function row(body) { return { t: 'row', body: body }; }
  /* An argument list that needs to be one node, without a pointless <mrow>. */
  function maybeRow(body) { return body.length === 1 ? body[0] : row(body); }

  function ctxWith(ctx, patch) {
    var out = { display: ctx.display, variant: ctx.variant };
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
    return out;
  }

  function emLen(x) {
    var v = Math.round(x * 100000) / 100000;
    return v + 'em';
  }

  /* Parse a TeX dimension into em (best effort; unknown -> 0). */
  function parseDimen(s) {
    var m = /^\s*([-+]?[0-9]*\.?[0-9]+)\s*(em|ex|pt|px|mu|cm|mm|in|bp|pc)?\s*$/.exec(String(s));
    if (!m) return 0;
    var v = parseFloat(m[1]);
    switch (m[2]) {
      case 'ex': return v * 0.5;
      case 'pt': return v / 10;
      case 'bp': return v / 10;
      case 'px': return v / 16;
      case 'mu': return v / 18;
      case 'cm': return v * 2.845;
      case 'mm': return v * 0.2845;
      case 'in': return v * 7.227;
      case 'pc': return v * 1.2;
      default: return v;
    }
  }

  function safeColor(s) {
    var v = String(s).trim();
    if (!/^[#A-Za-z0-9(),.%\s-]{1,64}$/.test(v)) return null;
    return v;
  }

  /* ------------------------------------------------------------------ *
   * parser                                                              *
   * ------------------------------------------------------------------ */

  var PRIME_CHARS = ['′', '″', '‴', '⁗'];

  function primeNode(count) {
    var s;
    if (count <= 4) s = PRIME_CHARS[count - 1];
    else {
      s = '';
      for (var i = 0; i < count; i++) s += '′';
    }
    return mo(s, ' lspace="0em" rspace="0em"');
  }

  function isDigit(ch) { return ch >= '0' && ch <= '9'; }

  /* Unicode-aware letter test for charNode. Built once and guarded: \p{L}
   * needs the `u` flag, and a build without it must still load rather than
   * throw a SyntaxError at parse time — hence the constructor. */
  var RE_LETTER = (function () {
    try { return new RegExp('\\p{L}', 'u'); } catch (e) { return /[A-Za-z]/; }
  })();

  /* Parse a list of atoms until `stop(token)` is true or EOF. Never consumes
   * the stopping token. Always consumes at least one token per iteration, so
   * it cannot spin. */
  function parseList(lex, ctx, stop) {
    var out = [];
    for (;;) {
      var t = lex.peek();
      if (t.type === 'eof') break;
      if (stop && stop(t)) break;

      /* scoped style / font commands swallow the rest of the current list */
      if (t.type === 'cmd' && SCOPED_STYLES[t.value]) {
        lex.next();
        out.push({ t: 'style', attrs: SCOPED_STYLES[t.value],
          body: parseList(lex, ctxWith(ctx, { display: t.value === 'displaystyle' }), stop) });
        break;
      }
      if (t.type === 'cmd' && Object.prototype.hasOwnProperty.call(SCOPED_VARIANTS, t.value)
          && !VARIANT_CMDS[t.value]) {
        lex.next();
        out.push(maybeRow(parseList(lex, ctxWith(ctx, { variant: SCOPED_VARIANTS[t.value] }), stop)));
        break;
      }

      var node = parseAtom(lex, ctx);
      if (node === null) continue;

      /* primes bind tighter than an explicit ^ */
      var primes = 0;
      while (lex.peek().type === 'prime') { lex.next(); primes++; }

      /* \log_2 n still wants the thin space, so remember it across scripting */
      var wantSpace = !!node.funcSpace;
      node = attachScripts(lex, ctx, node, primes);
      out.push(node);
      if (wantSpace && !atListEdge(lex.peek())) out.push(mspace(0.16667));
    }
    return out;
  }

  /* A trailing thin space before a group/row/cell boundary is just noise. */
  function atListEdge(t) {
    return t.type === 'eof' || t.type === '}' || t.type === '&' || t.type === 'nl';
  }

  function attachScripts(lex, ctx, base, primes) {
    var sub = null, sup = null, forceLimits = null;
    var sctx = ctxWith(ctx, { display: false });

    for (;;) {
      var t = lex.peek();
      if (t.type === 'cmd' && (t.value === 'limits' || t.value === 'nolimits')) {
        lex.next();
        forceLimits = t.value === 'limits';
        continue;
      }
      if (t.type === '^') {
        lex.next();
        var s = readArg(lex, sctx);
        sup = sup ? sup.concat(s) : s;
        continue;
      }
      if (t.type === '_') {
        lex.next();
        var b = readArg(lex, sctx);
        sub = sub ? sub.concat(b) : b;
        continue;
      }
      if (t.type === 'prime') { lex.next(); primes++; continue; }
      break;
    }

    if (primes > 0) {
      var p = primeNode(primes);
      sup = sup ? [p].concat(sup) : [p];
    }
    if (!sub && !sup) return base;

    var limits;
    if (forceLimits !== null) limits = forceLimits;
    else if (base.limitsDefault === 'never') limits = false;
    else if (base.limitsDefault === 'movable') limits = !!ctx.display;
    else limits = false;

    return { t: 'script', base: base, sub: sub, sup: sup, limits: limits };
  }

  /* One argument: a braced group, or a single atom. Returns an array. */
  function readArg(lex, ctx) {
    var t = lex.peek();
    if (t.type === 'eof') fail('missing argument');
    if (t.type === '{') {
      lex.next();
      var body = parseList(lex, ctx, function (x) { return x.type === '}'; });
      expectClose(lex);
      return body;
    }
    if (t.type === '}') fail('unbalanced braces');
    if (t.type === 'cmd') {
      lex.next();
      var node = parseCommand(lex, ctx, t.value);
      return node === null ? [] : [node];
    }
    if (t.type === 'char') {
      lex.next();
      return [charNode(t.value, ctx)];
    }
    /* ^ _ & \\ prime as an argument: treat as empty rather than exploding */
    lex.next();
    return [];
  }

  function expectClose(lex) {
    var t = lex.next();
    if (t.type !== '}') fail('unbalanced braces');
  }

  function charNode(c, ctx) {
    /* Any letter, not only ASCII: a `π` pasted straight into the source fell
     * past this into the mo branch below, picked up the operator dictionary's
     * infix spacing and lost the single-char mi's automatic italic — `$2πr$`
     * came out 7.5 px wider than `$2\pi r$`. The digit branch is untouched, so
     * a non-ASCII digit still lands in mn only through it. */
    if (RE_LETTER.test(c)) return mi(c, ctx.variant);
    if (isDigit(c)) return mn(c, ctx.variant);
    if (c === '-') return mo('−');
    if (c === '*') return mo('∗');
    if (c === "'") return mo('′');
    if (c === '(' || c === ')' || c === '[' || c === ']' || c === '|') {
      return mo(c, ' stretchy="false"');
    }
    if (c === ' ') return mspace(0.25);
    return mo(c);
  }

  function parseAtom(lex, ctx) {
    var t = lex.next();
    switch (t.type) {
      case '{': {
        var body = parseList(lex, ctx, function (x) { return x.type === '}'; });
        expectClose(lex);
        return row(body);
      }
      case '}':
        fail('unbalanced braces');
        break;
      case '&':
        return mo('&');
      case 'nl':
        lex.skipOptional();
        return { t: 'newline' };
      case 'prime':
        return mo('′');
      case '^':
      case '_':
        /* a script with no base: give it an empty one */
        lex.unread(t);
        return row([]);
      case 'char': {
        /* merge a run of digits (and an interior decimal point) into one <mn> */
        if (isDigit(t.value) || (t.value === '.' && isDigit(lex.peek().value || ''))) {
          var num = t.value;
          for (;;) {
            var p = lex.peek();
            if (p.type !== 'char') break;
            if (isDigit(p.value)) { num += p.value; lex.next(); continue; }
            if (p.value === '.' && lex.peek2().type === 'char' && isDigit(lex.peek2().value)) {
              num += p.value; lex.next(); continue;
            }
            break;
          }
          return mn(num, ctx.variant);
        }
        return charNode(t.value, ctx);
      }
      case 'cmd':
        return parseCommand(lex, ctx, t.value);
      default:
        return null;
    }
    return null;
  }

  function parseCommand(lex, ctx, name) {
    /* --- literals ------------------------------------------------- */
    if (Object.prototype.hasOwnProperty.call(LITERAL_CMDS, name)) {
      var lit = LITERAL_CMDS[name];
      if (name === '{' || name === '}') return mo(lit, ' stretchy="false"');
      if (name === '|') return mo(lit, ' stretchy="false"');
      return mo(lit);
    }

    /* --- spacing --------------------------------------------------- */
    if (Object.prototype.hasOwnProperty.call(SPACES, name)) return mspace(SPACES[name]);
    if (name === 'hspace' || name === 'mspace' || name === 'kern' || name === 'mkern') {
      var d = lex.readRawArg();
      return mspace(parseDimen(d));
    }
    if (name === 'vspace') { lex.readRawArg(); return null; }

    /* --- ignored --------------------------------------------------- */
    if (Object.prototype.hasOwnProperty.call(IGNORED, name)) {
      for (var i = 0; i < IGNORED[name]; i++) lex.readRawArg();
      return null;
    }

    /* --- text mode -------------------------------------------------- */
    if (Object.prototype.hasOwnProperty.call(TEXT_STYLES, name)) {
      var raw = lex.readRawArg();
      return mtext(textUnescape(raw), TEXT_STYLES[name]);
    }
    if (name === 'operatorname' || name === 'operatorname*') {
      var opn = textUnescape(lex.readRawArg());
      var node = mi(opn, 'normal');
      node.funcSpace = true;
      if (name === 'operatorname*') node.limitsDefault = 'movable';
      return node;
    }

    /* --- mathvariant ------------------------------------------------ */
    if (Object.prototype.hasOwnProperty.call(VARIANT_CMDS, name)) {
      var v = VARIANT_CMDS[name];
      return maybeRow(readArg(lex, ctxWith(ctx, { variant: v })));
    }

    /* --- colour ----------------------------------------------------- */
    if (name === 'color' || name === 'textcolor') {
      var col = safeColor(lex.readRawArg());
      var cbody = readArg(lex, ctx);
      if (!col) return row(cbody);
      return { t: 'style', attrs: ' mathcolor="' + escAttr(col) + '"', body: cbody };
    }

    /* --- fractions -------------------------------------------------- */
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      var fctx = ctxWith(ctx, { display: name === 'dfrac' || name === 'cfrac' });
      var num = readArg(lex, fctx), den = readArg(lex, fctx);
      var frac = { t: 'frac', num: num, den: den, thin: false };
      if (name === 'dfrac' || name === 'cfrac') {
        return { t: 'style', attrs: ' displaystyle="true" scriptlevel="0"', body: [frac] };
      }
      if (name === 'tfrac') {
        return { t: 'style', attrs: ' displaystyle="false" scriptlevel="0"', body: [frac] };
      }
      return frac;
    }
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom' || name === 'choose') {
      var bctx = ctxWith(ctx, { display: name === 'dbinom' });
      var bn = readArg(lex, bctx), bd = readArg(lex, bctx);
      var bf = { t: 'frac', num: bn, den: bd, thin: true };
      var fenced = { t: 'fence', left: '(', right: ')', body: [bf] };
      if (name === 'tbinom') {
        return { t: 'style', attrs: ' displaystyle="false" scriptlevel="0"', body: [fenced] };
      }
      return fenced;
    }
    if (name === 'over' || name === 'atop') {
      /* Not supported as the infix form; degrade to a visible marker. */
      return mtext('\\' + name, '', 'md-tex-unknown');
    }

    /* --- radicals ---------------------------------------------------- */
    if (name === 'sqrt') {
      var idx = null;
      lex.sync();
      var opt = lex.skipOptional();
      if (opt !== null && opt !== '') idx = parseSub(opt, ctxWith(ctx, { display: false }));
      var rad = readArg(lex, ctx);
      return { t: 'sqrt', body: rad, index: idx };
    }

    /* --- accents ------------------------------------------------------ */
    if (Object.prototype.hasOwnProperty.call(ACCENTS, name)) {
      var acc = ACCENTS[name];
      var abody = readArg(lex, ctx);
      var anode = {
        t: 'accent', body: abody, ch: acc[0], stretchy: acc[1],
        under: acc[2] === 'under'
      };
      /* `\underbrace{a+\cdots+a}_{n}` centres its label under the brace — that
       * is the whole idiom. Without a limitsDefault, attachScripts wrapped the
       * munder in an msub and the label landed clear of the brace's right edge.
       * Braces only: a `\bar x_i` really is a plain msub. `movable` follows
       * TeX, where \underbrace is a \mathop and so takes limits in display
       * style and side-set scripts inline. */
      if (name === 'underbrace' || name === 'overbrace') anode.limitsDefault = 'movable';
      return anode;
    }
    if (name === 'overset' || name === 'stackrel') {
      var over = readArg(lex, ctxWith(ctx, { display: false }));
      var obase = readArg(lex, ctx);
      return { t: 'overunder', base: obase, over: over, under: null };
    }
    if (name === 'underset') {
      var under = readArg(lex, ctxWith(ctx, { display: false }));
      var ubase = readArg(lex, ctx);
      return { t: 'overunder', base: ubase, over: null, under: under };
    }

    /* --- phantoms / boxes --------------------------------------------- */
    if (name === 'phantom') return { t: 'phantom', body: readArg(lex, ctx), mode: 'both' };
    if (name === 'hphantom') return { t: 'phantom', body: readArg(lex, ctx), mode: 'h' };
    if (name === 'vphantom') return { t: 'phantom', body: readArg(lex, ctx), mode: 'v' };
    if (name === 'smash') return { t: 'phantom', body: readArg(lex, ctx), mode: 'smash' };
    if (name === 'boxed' || name === 'fbox') {
      return { t: 'enclose', notation: 'box', body: readArg(lex, ctx) };
    }
    if (name === 'cancel') {
      return { t: 'enclose', notation: 'updiagonalstrike', body: readArg(lex, ctx) };
    }

    /* --- fences -------------------------------------------------------- */
    if (name === 'left') {
      var ld = readDelim(lex);
      var lbody = parseList(lex, ctx, function (x) {
        return x.type === 'cmd' && x.value === 'right';
      });
      var closer = lex.next();
      if (!(closer.type === 'cmd' && closer.value === 'right')) {
        fail('\\left without a matching \\right');
      }
      var rd = readDelim(lex);
      return { t: 'fence', left: ld, right: rd, body: lbody };
    }
    if (name === 'right') fail('\\right without a matching \\left');
    if (name === 'middle') {
      var md = readDelim(lex);
      return md === null ? null : mo(md, ' stretchy="true" fence="true"');
    }
    if (name === 'big' || name === 'bigl' || name === 'bigr' ||
        name === 'Big' || name === 'Bigl' || name === 'Bigr' ||
        name === 'bigg' || name === 'biggl' || name === 'biggr' ||
        name === 'Bigg' || name === 'Biggl' || name === 'Biggr') {
      var sizes = { big: 1.2, Big: 1.8, bigg: 2.4, Bigg: 3.0 };
      var key = name.replace(/[lr]$/, '');
      var bd2 = readDelim(lex);
      if (bd2 === null) return null;
      return mo(bd2, ' stretchy="true" minsize="' + sizes[key] + 'em" maxsize="' +
        sizes[key] + 'em"');
    }

    /* --- environments -------------------------------------------------- */
    if (name === 'begin') return parseEnvironment(lex, ctx);
    if (name === 'end') fail('\\end without a matching \\begin');

    /* --- big operators --------------------------------------------------- */
    if (Object.prototype.hasOwnProperty.call(BIG_OPS, name)) {
      var big = BIG_OPS[name];
      var bnode = mo(big.c, ' largeop="true" symmetric="true" stretchy="false"' +
        (big.beside ? ' movablelimits="false"' : ' movablelimits="true"'));
      bnode.limitsDefault = big.beside ? 'never' : 'movable';
      return bnode;
    }
    if (Object.prototype.hasOwnProperty.call(LIMIT_OPS, name)) {
      var lnode = mo(LIMIT_OPS[name], ' movablelimits="true"');
      lnode.limitsDefault = 'movable';
      return lnode;
    }
    if (name === 'bmod') return mo('mod', ' lspace="0.2222em" rspace="0.2222em"');
    if (name === 'mod') return mo('mod', ' lspace="0.4444em" rspace="0.3333em"');
    if (name === 'pmod') {
      var pm = readArg(lex, ctx);
      return row([
        mspace(0.4444), mo('(', ' stretchy="false"'), mi('mod', 'normal'),
        mspace(0.3333), maybeRow(pm), mo(')', ' stretchy="false"')
      ]);
    }

    /* --- function names -------------------------------------------------- */
    if (FUNCTION_SET[name]) {
      var fnode = mi(name, 'normal');
      fnode.funcSpace = true;
      return fnode;
    }

    /* --- symbols ---------------------------------------------------------- */
    if (Object.prototype.hasOwnProperty.call(GREEK_LOWER, name)) {
      return mi(GREEK_LOWER[name], ctx.variant);
    }
    if (Object.prototype.hasOwnProperty.call(GREEK_UPPER, name)) {
      return mi(GREEK_UPPER[name], ctx.variant || 'normal');
    }
    if (name.length > 3 && name.slice(0, 3) === 'var' &&
        Object.prototype.hasOwnProperty.call(GREEK_UPPER, name.slice(3))) {
      return mi(GREEK_UPPER[name.slice(3)], ctx.variant);
    }
    if (Object.prototype.hasOwnProperty.call(MI_SYMBOLS, name)) {
      return mi(MI_SYMBOLS[name], 'normal');
    }
    if (Object.prototype.hasOwnProperty.call(MO_SYMBOLS, name)) {
      var sym = MO_SYMBOLS[name];
      if (sym === '{' || sym === '}' || sym === '[' || sym === ']' ||
          sym === '|' || sym === '‖') {
        return mo(sym, ' stretchy="false"');
      }
      return mo(sym);
    }

    /* --- unknown: visible, but not fatal ----------------------------------- */
    return mtext('\\' + name, '', 'md-tex-unknown');
  }

  /* Parse a standalone snippet (used for \sqrt's optional index). */
  function parseSub(src, ctx) {
    var sub = new Lexer(src);
    return parseList(sub, ctx, null);
  }

  function readDelim(lex) {
    var t = lex.next();
    if (t.type === 'char') {
      if (Object.prototype.hasOwnProperty.call(DELIM_CHARS, t.value)) {
        return DELIM_CHARS[t.value];
      }
      fail('unknown delimiter "' + t.value + '"');
    }
    if (t.type === '{') return '{';
    if (t.type === 'cmd') {
      if (Object.prototype.hasOwnProperty.call(DELIM_CMDS, t.value)) {
        return DELIM_CMDS[t.value];
      }
      fail('unknown delimiter "\\' + t.value + '"');
    }
    fail('missing delimiter');
    return null;
  }

  /* ------------------------------------------------------------------ *
   * environments                                                        *
   * ------------------------------------------------------------------ */

  function parseEnvironment(lex, ctx) {
    var name = lex.readRawArg().trim();
    var def = Object.prototype.hasOwnProperty.call(ENVS, name)
      ? ENVS[name]
      : { left: null, right: null, style: 'gathered' };

    var spec = null;
    if (def.style === 'array' || name === 'alignedat') {
      if (lex.rawAtBrace()) spec = lex.readRawArg();
      else spec = '';
      if (name === 'alignedat') spec = null;
    }

    var cellCtx = def.style === 'matrix' || def.style === 'array'
      ? ctxWith(ctx, { display: false })
      : ctx;

    var rows = [], cells = [], closed = false;

    for (;;) {
      var cell = parseList(lex, cellCtx, function (x) {
        return x.type === '&' || x.type === 'nl' ||
          (x.type === 'cmd' && x.value === 'end');
      });
      cells.push(cell);
      var t = lex.peek();
      if (t.type === '&') { lex.next(); continue; }
      if (t.type === 'nl') {
        lex.next();
        lex.skipOptional();
        rows.push(cells);
        cells = [];
        continue;
      }
      if (t.type === 'cmd' && t.value === 'end') {
        lex.next();
        var endName = lex.readRawArg().trim();
        if (endName !== name) {
          fail('\\begin{' + name + '} closed by \\end{' + endName + '}');
        }
        rows.push(cells);
        closed = true;
        break;
      }
      /* EOF */
      fail('unterminated environment "' + name + '"');
    }
    if (!closed) fail('unterminated environment "' + name + '"');

    /* drop a trailing empty row left by a final \\ */
    if (rows.length > 1) {
      var last = rows[rows.length - 1];
      if (last.length === 1 && last[0].length === 0) rows.pop();
    }

    var table = {
      t: 'table', rows: rows, style: def.style, spec: spec, small: !!def.small,
      /* Carried to emitTable: <mtable> silently drops out of display style in
       * Chromium, so the markup has to restate whatever the parser decided for
       * the cells. Without it, an `aligned` row's \frac shrank and a \sum's
       * limits jumped to the side of the operator inside display maths. */
      display: !!cellCtx.display
    };
    if (def.left || def.right) {
      return { t: 'fence', left: def.left, right: def.right, body: [table] };
    }
    return table;
  }

  /* ------------------------------------------------------------------ *
   * emitter                                                             *
   * ------------------------------------------------------------------ */

  function emitList(nodes) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) out += emit(nodes[i]);
    return out;
  }

  /* Exactly one element, as msup/mfrac/... require. */
  function one(nodes) {
    if (!nodes || nodes.length === 0) return '<mrow></mrow>';
    if (nodes.length === 1) return emit(nodes[0]);
    return '<mrow>' + emitList(nodes) + '</mrow>';
  }

  function emit(node) {
    if (!node) return '';
    switch (node.t) {
      case 'mi': {
        var itext = node.variant ? variantChars(node.text, node.variant) : node.text;
        var iattr = node.variant ? ' mathvariant="' + escAttr(node.variant) + '"' : '';
        return '<mi' + iattr + '>' + esc(itext) + '</mi>';
      }
      case 'mn': {
        var ntext = node.variant ? variantChars(node.text, node.variant) : node.text;
        var nattr = node.variant && node.variant !== 'normal'
          ? ' mathvariant="' + escAttr(node.variant) + '"' : '';
        return '<mn' + nattr + '>' + esc(ntext) + '</mn>';
      }
      case 'mo':
        return '<mo' + (node.attrs || '') + '>' + esc(node.text) + '</mo>';
      case 'mtext': {
        var attrs = '';
        if (node.cls) attrs += ' class="' + escAttr(node.cls) + '"';
        if (node.style) attrs += ' style="' + escAttr(node.style) + '"';
        /* spaces become NBSP so \text{a b} keeps its gap */
        return '<mtext' + attrs + '>' + esc(node.text.replace(/ /g, ' ')) + '</mtext>';
      }
      case 'mspace':
        /* MathML Core's `width` takes no negative length, so `\!` and the
         * \neg…space family were discarded outright — measured, `a\!b` was
         * exactly as wide as `ab`. A CSS margin is honoured: 17.19px -> 14.53px
         * in Chromium. Same per-element-CSS route emitTable's column rules take. */
        if (node.em < 0) {
          return '<mspace width="0em" style="margin-left:' + emLen(node.em) + '"/>';
        }
        return '<mspace width="' + emLen(node.em) + '"/>';
      case 'newline':
        /* Only reachable inside a group or a fence now; compile() turns a
         * top-level run of these into a real <mtable>. MathML Core dropped
         * `linebreak`, so this paints nothing — kept as an inert placeholder
         * rather than dropping the node and losing the author's intent. */
        return '<mspace linebreak="newline"/>';
      case 'row':
        return '<mrow>' + emitList(node.body) + '</mrow>';
      case 'style':
        return '<mstyle' + node.attrs + '>' + emitList(node.body) + '</mstyle>';
      case 'frac': {
        var lt = node.thin ? ' linethickness="0"' : '';
        return '<mfrac' + lt + '>' + one(node.num) + one(node.den) + '</mfrac>';
      }
      case 'sqrt':
        if (node.index && node.index.length) {
          return '<mroot>' + one(node.body) + one(node.index) + '</mroot>';
        }
        return '<msqrt>' + emitList(node.body) + '</msqrt>';
      case 'accent': {
        var achar = '<mo stretchy="' + (node.stretchy ? 'true' : 'false') + '">' +
          esc(node.ch) + '</mo>';
        if (node.under) {
          return '<munder accentunder="true">' + one(node.body) + achar + '</munder>';
        }
        return '<mover accent="true">' + one(node.body) + achar + '</mover>';
      }
      case 'overunder': {
        if (node.over && node.under) {
          return '<munderover>' + one(node.base) + one(node.under) + one(node.over) +
            '</munderover>';
        }
        if (node.over) return '<mover>' + one(node.base) + one(node.over) + '</mover>';
        return '<munder>' + one(node.base) + one(node.under) + '</munder>';
      }
      case 'phantom': {
        var inner = '<mphantom>' + one(node.body) + '</mphantom>';
        if (node.mode === 'h') return '<mpadded height="0" depth="0">' + inner + '</mpadded>';
        if (node.mode === 'v') return '<mpadded width="0">' + inner + '</mpadded>';
        if (node.mode === 'smash') {
          return '<mpadded height="0" depth="0">' + one(node.body) + '</mpadded>';
        }
        return inner;
      }
      case 'enclose': {
        /* MathML Core removed <menclose>: Chromium laid the children out and
         * painted no frame and no strike at all, so `\boxed{X}` measured
         * byte-identical to a bare `X` and the markup claimed an emphasis the
         * reader never saw. CSS on an <mrow> is honoured — measured 20.20 x
         * 17.36px against 10.20 x 10.58, border-width 1px. */
        var boxed = node.notation === 'box';
        var estyle = boxed
          ? 'border:1px solid currentColor;padding:0.15em 0.25em;'
          : 'background-image:linear-gradient(to top right,transparent 45%,' +
            'currentColor 45%,currentColor 55%,transparent 55%);';
        return '<mrow class="' + (boxed ? 'md-tex-boxed' : 'md-tex-cancel') +
          '" style="' + escAttr(estyle) + '">' + one(node.body) + '</mrow>';
      }
      case 'script':
        return emitScript(node);
      case 'fence':
        return emitFence(node);
      case 'table':
        return emitTable(node);
      default:
        return '';
    }
  }

  function emitScript(node) {
    var base = emit(node.base);
    if (node.limits) {
      if (node.sub && node.sup) {
        return '<munderover>' + base + one(node.sub) + one(node.sup) + '</munderover>';
      }
      if (node.sub) return '<munder>' + base + one(node.sub) + '</munder>';
      return '<mover>' + base + one(node.sup) + '</mover>';
    }
    if (node.sub && node.sup) {
      return '<msubsup>' + base + one(node.sub) + one(node.sup) + '</msubsup>';
    }
    if (node.sub) return '<msub>' + base + one(node.sub) + '</msub>';
    return '<msup>' + base + one(node.sup) + '</msup>';
  }

  function emitFence(node) {
    var out = '<mrow>';
    if (node.left !== null && node.left !== undefined) {
      out += '<mo stretchy="true" fence="true" form="prefix">' + esc(node.left) + '</mo>';
    }
    out += emitList(node.body);
    if (node.right !== null && node.right !== undefined) {
      out += '<mo stretchy="true" fence="true" form="postfix">' + esc(node.right) + '</mo>';
    }
    return out + '</mrow>';
  }

  /* Column alignment, arrived at by measuring, not by reading the spec.
   *
   * Uncentring a cell takes an attribute AND a stylesheet declaration, and
   * which one does the work differs per engine. Measured in both (gap left of
   * the glyph vs gap right of it, in a cell widened by a longer row):
   *
   *   nothing                     centred in both
   *   columnalign on the MTABLE   ignored by both — this is the trap
   *   columnalign on the MTD      right in WebKit, ignored by Chromium
   *   text-align:left             left in both
   *   text-align:right            LEFT in Chromium (wrong way), right in WebKit
   *   text-align:-webkit-right    right in both, but WebKit then lets the cell
   *                               OVERFLOW its column by ~17px, so `\int_0^1 h
   *                               \,dt &\le 1` printed "dt" on top of the "≤"
   *   auto margins on a
   *     display:block math mrow   computed back to 0px by Chromium; centred
   *   direction:rtl               no effect in either
   *   justify-items:end           right in Chromium, ignored by WebKit
   *
   * So: `columnalign` per MTD carries WebKit and Firefox, `justify-items:end`
   * carries Chromium, and `text-align:left` is agreed by all three. Nothing
   * overflows. Never put the alignment on the <mtable> — it looks right in the
   * markup and is silently dropped by both engines that matter here. */
  function alignStyle(a) {
    if (a === 'right') return 'justify-items:end;';
    if (a === 'left') return 'text-align:left;';
    return '';
  }

  function emitTable(node) {
    var rows = node.rows, maxCols = 0, i, j;
    for (i = 0; i < rows.length; i++) if (rows[i].length > maxCols) maxCols = rows[i].length;
    if (maxCols === 0) maxCols = 1;

    /* `columnspacing`, `columnlines` and `rowspacing` are all gone from MathML
     * Core, so Chromium and WebKit ignore them: an `aligned` pair sat a full
     * 0.5em apart and an `array`'s {l|c} rule drew nothing. Per-cell CSS is
     * honoured by every engine, so the geometry rides on `style` and the legacy
     * attributes are left off entirely rather than doubling Firefox's lines. */
    var aligns = [], cellStyle = [], attrs = '';
    for (i = 0; i < maxCols; i++) cellStyle.push('');

    if (node.style === 'array') {
      var spec = String(node.spec || '');
      var rule = [], pending = 0, trailing = false;
      for (i = 0; i < spec.length; i++) {
        var ch = spec.charAt(i);
        if (ch === 'l' || ch === 'c' || ch === 'r') {
          rule.push(pending > 0);
          pending = 0;
          aligns.push(ch === 'l' ? 'left' : ch === 'r' ? 'right' : 'center');
        } else if (ch === '|' || ch === ':') {
          pending++;
        }
      }
      trailing = pending > 0 && aligns.length > 0;
      while (aligns.length < maxCols) { aligns.push('center'); rule.push(false); }
      for (j = 0; j < maxCols; j++) {
        if (rule[j]) cellStyle[j] += 'border-left:1px solid currentColor;';
      }
      if (trailing) cellStyle[maxCols - 1] += 'border-right:1px solid currentColor;';
    } else if (node.style === 'cases') {
      for (i = 0; i < maxCols; i++) {
        aligns.push('left');
        cellStyle[i] += i === 0 ? 'padding-left:0.3em;padding-right:0.8em;' : '';
      }
    } else if (node.style === 'aligned') {
      /* right/left pairs must touch, the way TeX's alignment tabs do */
      for (i = 0; i < maxCols; i++) {
        aligns.push(i % 2 === 0 ? 'right' : 'left');
        cellStyle[i] += i % 2 === 0 ? 'padding-right:0;' : 'padding-left:0;';
      }
    } else {
      for (i = 0; i < maxCols; i++) aligns.push('center');
    }

    var cellAttrs = [];
    for (j = 0; j < maxCols; j++) {
      cellStyle[j] += alignStyle(aligns[j]);
      cellAttrs.push(
        (aligns[j] === 'center' ? '' : ' columnalign="' + aligns[j] + '"') +
        (cellStyle[j] ? ' style="' + escAttr(cellStyle[j]) + '"' : '')
      );
    }

    /* MathML Core gives <mtable> no display-style inheritance: measured in
     * Chromium, an <mfrac> inside a bare <mtable> renders 25px tall against
     * 28px outside it, and a <munderover> \sum collapses its limits to the
     * side (25px vs 33px). Restate it, or every `aligned` block in display
     * maths quietly typesets a size smaller than the equations around it. */
    if (node.small) attrs += ' displaystyle="false" scriptlevel="1"';
    else if (node.display) attrs += ' displaystyle="true"';

    var out = '<mtable' + attrs + '>';
    for (i = 0; i < rows.length; i++) {
      out += '<mtr>';
      for (j = 0; j < maxCols; j++) {
        out += '<mtd' + cellAttrs[j] + '>' +
          (rows[i][j] ? emitList(rows[i][j]) : '') + '</mtd>';
      }
      out += '</mtr>';
    }
    return out + '</mtable>';
  }

  /* ------------------------------------------------------------------ *
   * public entry point                                                  *
   * ------------------------------------------------------------------ */

  /* `\\` at the top level, i.e. outside any \begin{…}. MathML Core dropped
   * <mspace linebreak>, so Chromium and WebKit painted `$$a \\ b$$` on one line
   * — 11.05px tall, identical to `a b` — and the author's break vanished with
   * no error and no marker. A one-column <mtable> is the only Core-supported
   * way to break a line, and it is the same node every environment already
   * builds: measured 32.88px for two rows. Centred, like \begin{gathered}. */
  function rowsAsTable(nodes, display) {
    var i, hasBreak = false;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i] && nodes[i].t === 'newline') { hasBreak = true; break; }
    }
    if (!hasBreak) return nodes;
    var rows = [[]];
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i] && nodes[i].t === 'newline') { rows.push([]); continue; }
      rows[rows.length - 1].push(nodes[i]);
    }
    /* a trailing `\\` means "end of the last row", not "an empty row after it" */
    if (rows.length > 1 && rows[rows.length - 1].length === 0) rows.pop();
    var cells = [];
    for (i = 0; i < rows.length; i++) cells.push([rows[i]]);
    return [{ t: 'table', rows: cells, style: 'gathered', spec: null,
              small: false, display: !!display }];
  }

  function compile(tex, display) {
    var lex = new Lexer(tex);
    var ctx = { display: !!display, variant: null };
    var nodes = parseList(lex, ctx, null);
    var t = lex.peek();
    if (t.type !== 'eof') {
      if (t.type === '}') fail('unbalanced braces');
      fail('unexpected "' + (t.value || t.type) + '"');
    }
    return emitList(rowsAsTable(nodes, display));
  }

  function errorSpan(tex, message) {
    return '<span class="md-math-error" title="' + escAttr(message) + '">' +
      esc(tex) + '</span>';
  }

  function toMathML(tex, display) {
    /* "Never throws" has to cover the coercion too: String() sitting outside
     * the try let an argument whose toString throws escape the guard. */
    var src = '';
    try {
      src = tex == null ? '' : String(tex);
    } catch (coerce) {
      return errorSpan('', 'could not read this formula');
    }
    try {
      var body = compile(src, display);
      return '<math xmlns="http://www.w3.org/1998/Math/MathML" display="' +
        (display ? 'block' : 'inline') + '">' + body + '</math>';
    } catch (err) {
      var msg = (err && err.message) ? String(err.message) : 'could not parse this formula';
      return errorSpan(src, msg);
    }
  }

  var TeX = {
    VERSION: VERSION,
    toMathML: toMathML
  };

  var root = (typeof window !== 'undefined')
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this);
  root.TeX = TeX;
})();
