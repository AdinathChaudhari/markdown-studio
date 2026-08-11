/* markdown.js — window.MD
 *
 * A hand-written CommonMark-core + GFM renderer with first-class support for
 * GFM tables and TeX math. Zero dependencies; no DOM access; pure string in,
 * string out, deterministic (same input -> byte-identical output).
 *
 * Pipeline, in order:
 *   1. normalise      line endings, tabs, NULs, optional YAML front matter
 *   2. math extraction  BEFORE anything else, masked against code
 *   3. definitions    link references + footnote definitions lifted out
 *   4. block pass     fence / html / heading / hr / quote / list / table /
 *                     indented code / paragraph, recursing into containers
 *   5. inline pass    escapes, code spans, autolinks, links, images, a real
 *                     delimiter-run emphasis algorithm, strike, mark, breaks
 *   6. math substitution — opts.math(tex, display) at the very end
 *
 * DELIBERATELY NOT SUPPORTED (out of scope, and it degrades to literal text
 * rather than failing):
 *   - the full CommonMark HTML-block taxonomy (types 1..7). A block-level tag
 *     runs to the next blank line; <script>/<style>/<pre>/<!--…--> run to their
 *     close. Attribute values containing ">" will cut a tag short.
 *   - link reference definitions that do not begin a block, multi-line
 *     destinations, and titles more than one line below the destination.
 *   - image-inside-link alt reconstruction beyond a simple text strip. (A
 *     link inside a link label IS suppressed, CommonMark-style: the inner-most
 *     definition wins and the outer brackets stay literal.)
 *   - entity *validation*: any well-formed-looking &name; / &#nn; / &#xNN; is
 *     passed through as written, not resolved against the HTML5 entity table.
 *   - CommonMark's exact tab-stop semantics inside partially consumed markers
 *     (tabs are expanded to 4-column stops up front instead).
 *   - definition lists, abbreviations, admonitions, [[wikilinks]], emoji
 *     shortcodes, and any other non-GFM extension.
 *   - YAML front matter is stripped, not rendered.
 *   - `~` fences are inline-inert: "~~~" in a paragraph is literal text.
 */
(function () {
  'use strict';

  var VERSION = '1';

  /* ------------------------------------------------------------------ *
   * escaping / small helpers
   * ------------------------------------------------------------------ */

  var HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return HTML_ESC[c]; });
  }

  var ATTR_ESC = escapeHtml;

  function unescapeHtml(s) {
    return String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  var PUNCT_RE = /[!-\/:-@\[-`{-~]/;

  function isAsciiPunct(c) { return !!c && PUNCT_RE.test(c); }

  function isPunctChar(c) {
    if (!c) return false;
    if (isAsciiPunct(c)) return true;
    return /[¡-¿‐-‧‰-⁞、-〃〈-】！-／]/.test(c);
  }

  function isWsChar(c) { return !c || c === ' ' || c === '\t' || c === '\n' || c === '\u000b' || c === '\f' || c === '\r'; }

  function isBlank(line) { return !/[^ \t]/.test(line); }

  function indentOf(line) {
    var i = 0;
    while (i < line.length && line.charAt(i) === ' ') i++;
    return i;
  }

  function rep(s, n) { return n > 0 ? new Array(n + 1).join(s) : ''; }

  /* ------------------------------------------------------------------ *
   * block-level regexes
   * ------------------------------------------------------------------ */

  var RE_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
  var RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*?))?[ \t]*$/;
  var RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  var RE_BQ = /^ {0,3}>/;
  var RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
  var RE_HTML_TAG_LINE = /^ {0,3}(?:<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>|<!--|<\?|<![A-Za-z]|<!\[CDATA\[)/;
  var RE_HTML_RAW_OPEN = /^ {0,3}<(script|style|pre|textarea)\b/i;
  var RE_LIST_BULLET = /^( {0,3})([-+*])([ \t]+|$)/;
  var RE_LIST_ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
  var MATH_TOKEN_RE = /\u0000MATH(\d+)\u0000/g;
  /* Sticky, and deliberately only the plain-tag alternative of inline()'s HTML
   * matcher: comments / PIs / CDATA are masked by codeMask's line pass, so
   * this can never lazily scan a whole document hunting for a `-->`. */
  var RE_TAG_MASK = /<\/?[a-zA-Z][a-zA-Z0-9\-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:\-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/y;

  /* ------------------------------------------------------------------ *
   * 1. normalisation
   * ------------------------------------------------------------------ */

  function expandTabs(line) {
    if (line.indexOf('\t') < 0) return line;
    var out = '';
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '\t') {
        var pad = 4 - (out.length % 4);
        out += rep(' ', pad);
      } else out += c;
    }
    return out;
  }

  function normalise(src) {
    var s = String(src == null ? '' : src);
    /* A leading BOM would make the first `#` non-initial and silently demote
     * the document's only h1 to a paragraph. Blob.text() and FileReader strip
     * it, but clipboardData.getData('text/plain') does not, so a pasted file
     * arrives here with it still attached. */
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/\u0000/g, '\ufffd');
    var lines = s.split('\n');
    for (var i = 0; i < lines.length; i++) lines[i] = expandTabs(lines[i]);
    return lines.join('\n');
  }

  function stripFrontMatter(src) {
    if (src.slice(0, 4) !== '---\n') return src;
    var lines = src.split('\n');
    var limit = Math.min(lines.length, 200);
    var sawPair = false;
    for (var i = 1; i < limit; i++) {
      var l = lines[i];
      if (l === '---' || l === '...') {
        return sawPair ? lines.slice(i + 1).join('\n') : src;
      }
      if (isBlank(l)) continue;
      if (/^\s*#/.test(l)) continue;
      if (/^\s*[-A-Za-z_][\w.\- ]*\s*:(\s|$)/.test(l)) { sawPair = true; continue; }
      if (/^\s+/.test(l) || /^\s*-\s/.test(l)) continue;
      return src;
    }
    return src;
  }

  /* ------------------------------------------------------------------ *
   * 2. math extraction
   * ------------------------------------------------------------------ */

  /* Mark every character that lives inside code — fenced blocks, indented
   * code blocks and inline code spans — so no math delimiter is ever seen
   * inside one, plus the two places raw HTML makes a `$` literal: a raw-text
   * block (<pre>/<script>/<style>/<textarea>, and comments) and the inside of
   * a tag, where a substituted token would inject markup into an attribute
   * value. Conservative on purpose: when in doubt a character is NOT code,
   * because a missed mask only means math where a dollar was meant. */
  function codeMask(src) {
    var n = src.length;
    var mask = new Uint8Array(n);
    var lines = src.split('\n');
    var offsets = [];
    var pos = 0, i;
    for (i = 0; i < lines.length; i++) { offsets.push(pos); pos += lines[i].length + 1; }

    var fence = null;
    var rawHtml = null;
    var inList = false;
    var prevBlank = true;

    function markLine(idx) {
      var start = offsets[idx];
      var end = start + lines[idx].length;
      for (var k = start; k < end; k++) mask[k] = 1;
    }

    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      var blank = isBlank(line);
      var m;
      /* A raw-text HTML block reaches parseHtmlBlock verbatim, so its body is
       * never markdown — `export P=$HOME/$USER` inside <pre> is shell, not a
       * formula. Same span parseHtmlBlock consumes, same close test. */
      if (rawHtml) {
        markLine(i);
        if (rawHtml.test(line)) rawHtml = null;
        prevBlank = blank;
        continue;
      }
      if (fence) {
        markLine(i);
        m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (m && m[1].charAt(0) === fence.ch && m[1].length >= fence.len) fence = null;
        prevBlank = blank;
        continue;
      }
      m = RE_FENCE.exec(line);
      if (m && !(m[2].charAt(0) === '`' && m[3].indexOf('`') >= 0)) {
        fence = { ch: m[2].charAt(0), len: m[2].length };
        markLine(i);
        prevBlank = blank;
        continue;
      }
      m = RE_HTML_RAW_OPEN.exec(line);
      if (m) {
        var closeRe = new RegExp('</' + m[1] + '\\s*>', 'i');
        markLine(i);
        if (!closeRe.test(line)) rawHtml = closeRe;
        prevBlank = blank;
        continue;
      }
      if (/^ {0,3}<!--/.test(line)) {
        markLine(i);
        if (line.indexOf('-->') < 0) rawHtml = /-->/;
        prevBlank = blank;
        continue;
      }
      if (!blank) {
        if (matchItemStart(line)) inList = true;
        else if (indentOf(line) === 0 && prevBlank) inList = false;
      }
      if (!blank && !inList && indentOf(line) >= 4 && (prevBlank || mask[offsets[i - 1] || 0])) {
        markLine(i);
      }
      prevBlank = blank;
    }

    /* inline code spans, across the unmasked regions */
    i = 0;
    while (i < n) {
      if (mask[i] || src.charAt(i) !== '`') { i++; continue; }
      var k = 1;
      while (i + k < n && src.charAt(i + k) === '`' && !mask[i + k]) k++;
      var p = i + k, found = -1;
      while (p < n) {
        if (mask[p]) { p++; continue; }
        if (src.charAt(p) === '`') {
          var q = p;
          while (q < n && src.charAt(q) === '`' && !mask[q]) q++;
          if (q - p === k) { found = p; break; }
          p = q;
        } else p++;
      }
      if (found < 0) { i += k; continue; }
      for (var j = i; j < found + k; j++) mask[j] = 1;
      i = found + k;
    }

    /* HTML tags, across what is left. A token substituted inside an attribute
     * value does not merely read wrong: `title="<code class="md-math-raw">…`
     * makes the browser invent an attribute and spill the rest as text. */
    i = 0;
    while (i < n) {
      if (mask[i] || src.charAt(i) !== '<') { i++; continue; }
      RE_TAG_MASK.lastIndex = i;
      var tm = RE_TAG_MASK.exec(src);
      if (!tm) { i++; continue; }
      var stop = i + tm[0].length;
      for (var t = i; t < stop; t++) mask[t] = 1;
      i = stop;
    }
    return mask;
  }

  function pushMath(state, tex, display, raw) {
    var idx = state.math.length;
    /* Display math is routinely written on its own lines inside the
     * delimiters; hand the renderer the formula, not the layout. */
    if (display) tex = tex.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
    state.math.push({ tex: tex, display: display, raw: raw });
    return '\u0000MATH' + idx + '\u0000';
  }

  /* `\(` / `\[` are also the CommonMark escapes for a literal bracket, so a
   * body of nothing but backslashes and space is treated as escapes, not as an
   * empty formula — otherwise `\(\)` and `\[\\\]` vanish into a math span. */
  function isMathBody(body) {
    return /[^\\\s]/.test(body);
  }

  /* A line the math scan may not cross into. Deliberately wider than
   * isBlockStart, which predates GFM tables: a stray `$` on one line and a
   * `($y)` in a table cell below it were enough to swallow the whole table. */
  function stopsMath(line) {
    if (isBlockStart(line)) return true;
    if (/^ {0,3}\|/.test(line)) return true;
    return RE_SETEXT.test(line);
  }

  function extractMath(src, state) {
    var mask = codeMask(src);
    var n = src.length;
    var out = [];
    var i = 0;

    /* Bounds. An unmatched delimiter used to scan to end of document, which
     * both swallowed every heading after it into one math span and made the
     * scan O(occurrences x length) — 1.1 s for a single keystroke on an 80 KB
     * document. TeX itself forbids a blank line inside math, so a blank line
     * is the hard ceiling for a display delimiter, and an inline one stops at
     * the first line that opens a new block as well. */
    var mlines = src.split('\n');
    var paraEnds = [];
    var blockEnds = [];
    var mpos = 0, li;
    for (li = 0; li < mlines.length; li++) {
      if (li > 0) {
        if (isBlank(mlines[li])) paraEnds.push(mpos - 1);
        else if (stopsMath(mlines[li])) blockEnds.push(mpos - 1);
      }
      mpos += mlines[li].length + 1;
    }

    /* first boundary at or after `from`; n when there is none */
    function ceilingIn(arr, from) {
      var lo = 0, hi = arr.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (arr[mid] < from) lo = mid + 1; else hi = mid;
      }
      return lo < arr.length ? arr[lo] : n;
    }

    function displayLimit(from) { return ceilingIn(paraEnds, from); }

    function inlineLimit(from) {
      var a = ceilingIn(paraEnds, from);
      var b = ceilingIn(blockEnds, from);
      return a < b ? a : b;
    }

    /* Every unmasked position of each closing delimiter, indexed once. The old
     * indexOf-per-attempt scanned the whole tail even when the answer was
     * "nowhere", which is where the quadratic came from. */
    var occ = Object.create(null);
    function occurrences(needle) {
      var list = occ[needle];
      if (list) return list;
      list = [];
      var p = 0;
      while (p >= 0 && p <= n - needle.length) {
        p = src.indexOf(needle, p);
        if (p < 0) break;
        if (!mask[p]) list.push(p);
        p += 1;
      }
      occ[needle] = list;
      return list;
    }

    /* The first unmasked `needle` at or after `from` that ends at or before
     * `limit`; -1 when the block holds none. */
    function findUnmasked(needle, from, limit) {
      var list = occurrences(needle);
      var lo = 0, hi = list.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (list[mid] < from) lo = mid + 1; else hi = mid;
      }
      if (lo >= list.length) return -1;
      var p = list[lo];
      return p + needle.length <= limit ? p : -1;
    }

    while (i < n) {
      if (mask[i]) { out.push(src.charAt(i)); i++; continue; }
      var c = src.charAt(i);

      if (c === '\\') {
        var nx = src.charAt(i + 1);
        if (nx === '(') {
          var e = findUnmasked('\\)', i + 2, inlineLimit(i + 2));
          if (e > 0 && isMathBody(src.slice(i + 2, e))) {
            out.push(pushMath(state, src.slice(i + 2, e), false, src.slice(i, e + 2)));
            i = e + 2; continue;
          }
        } else if (nx === '[') {
          var e2 = findUnmasked('\\]', i + 2, displayLimit(i + 2));
          if (e2 > 0 && isMathBody(src.slice(i + 2, e2))) {
            out.push(pushMath(state, src.slice(i + 2, e2), true, src.slice(i, e2 + 2)));
            i = e2 + 2; continue;
          }
        }
        out.push(c);
        if (i + 1 < n) out.push(nx);
        i += 2;
        continue;
      }

      if (c === '$') {
        if (src.charAt(i + 1) === '$') {
          var d = findUnmasked('$$', i + 2, displayLimit(i + 2));
          if (d > 0) {
            var body = src.slice(i + 2, d);
            if (isMathBody(body)) {
              out.push(pushMath(state, body, true, src.slice(i, d + 2)));
              i = d + 2; continue;
            }
          }
          out.push('$$'); i += 2; continue;
        }
        var after = src.charAt(i + 1);
        if (after && !isWsChar(after)) {
          var lim = inlineLimit(i + 1);
          var p = i + 1, close = -1;
          while (p < lim) {
            var pc = src.charAt(p);
            if (mask[p]) { p++; continue; }
            if (pc === '\\') { p += 2; continue; }
            if (pc === '$') {
              var prev = src.charAt(p - 1);
              var nxt = src.charAt(p + 1);
              if (!isWsChar(prev) && !/[0-9]/.test(nxt) && p > i + 1) { close = p; }
              break;
            }
            p++;
          }
          if (close > 0 && isMathBody(src.slice(i + 1, close))) {
            out.push(pushMath(state, src.slice(i + 1, close), false, src.slice(i, close + 1)));
            i = close + 1; continue;
          }
        }
        out.push('$'); i++; continue;
      }

      out.push(c); i++;
    }
    return out.join('');
  }

  function restoreMathRaw(text, state) {
    if (text.indexOf('\u0000') < 0) return text;
    return text.replace(MATH_TOKEN_RE, function (all, d) {
      var m = state.math[+d];
      return m ? m.raw : all;
    });
  }

  function restoreMathTex(text, state) {
    if (text.indexOf('\u0000') < 0) return text;
    return text.replace(MATH_TOKEN_RE, function (all, d) {
      var m = state.math[+d];
      return m ? m.tex : all;
    });
  }

  function defaultMath(tex, display) {
    return '<code class="md-math-raw">' + escapeHtml(display ? '$$' + tex + '$$' : '$' + tex + '$') + '</code>';
  }

  function substituteMath(html, state) {
    var fn = state.mathFn;
    return html.replace(MATH_TOKEN_RE, function (all, d) {
      var m = state.math[+d];
      if (!m) return '';
      if (!fn) return defaultMath(m.tex, m.display);
      try {
        var r = fn(m.tex, m.display);
        return r == null ? defaultMath(m.tex, m.display) : String(r);
      } catch (e) {
        return defaultMath(m.tex, m.display);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 3. reference + footnote definitions
   * ------------------------------------------------------------------ */

  function normLabel(s) {
    return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function unescapePunct(s) {
    return String(s).replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
  }

  function parseDefTail(rest) {
    /* "<dest> 'title'" or "dest \"title\"" -> {dest, title} | null */
    var s = rest.trim();
    if (!s) return null;
    var dest = '', p = 0;
    if (s.charAt(0) === '<') {
      var e = s.indexOf('>');
      if (e < 0) return null;
      dest = s.slice(1, e);
      p = e + 1;
    } else {
      while (p < s.length && !/\s/.test(s.charAt(p))) {
        if (s.charAt(p) === '\\') p++;
        p++;
      }
      dest = s.slice(0, p);
    }
    if (!dest) return null;
    var restTitle = s.slice(p).trim();
    var title = null;
    if (restTitle) {
      var tm = /^"([\s\S]*)"$|^'([\s\S]*)'$|^\(([\s\S]*)\)$/.exec(restTitle);
      if (!tm) return null;
      title = tm[1] !== undefined ? tm[1] : (tm[2] !== undefined ? tm[2] : tm[3]);
    }
    return { dest: unescapePunct(dest), title: title === null ? null : unescapePunct(title) };
  }

  function extractDefinitions(lines, state) {
    var out = [];
    var fence = null;
    var prevWasBlankOrDef = true;
    var rawHtml = null;
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var m;
      /* A raw-text HTML block is emitted verbatim by parseHtmlBlock, so a
       * `[b]: /c` inside <pre> is content, not a definition. Without this the
       * line was registered as a reference and dropped from the document —
       * silently, and only when a blank line preceded it. */
      if (rawHtml) {
        out.push(line);
        if (rawHtml.test(line)) rawHtml = null;
        i++; prevWasBlankOrDef = false;
        continue;
      }
      if (fence) {
        out.push(line);
        m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (m && m[1].charAt(0) === fence.ch && m[1].length >= fence.len) fence = null;
        i++; prevWasBlankOrDef = false;
        continue;
      }
      m = RE_FENCE.exec(line);
      if (m && !(m[2].charAt(0) === '`' && m[3].indexOf('`') >= 0)) {
        fence = { ch: m[2].charAt(0), len: m[2].length };
        out.push(line); i++; prevWasBlankOrDef = false;
        continue;
      }
      m = RE_HTML_RAW_OPEN.exec(line);
      if (m) {
        var closeRe = new RegExp('</' + m[1] + '\\s*>', 'i');
        if (!closeRe.test(line)) rawHtml = closeRe;
        out.push(line); i++; prevWasBlankOrDef = false;
        continue;
      }
      if (/^ {0,3}<!--/.test(line)) {
        if (line.indexOf('-->') < 0) rawHtml = /-->/;
        out.push(line); i++; prevWasBlankOrDef = false;
        continue;
      }

      /* footnote definition */
      var fm = /^ {0,3}\[\^([^\]\s][^\]]*)\]:[ \t]?([\s\S]*)$/.exec(line);
      if (fm && prevWasBlankOrDef) {
        var label = normLabel(fm[1]);
        var body = [fm[2]];
        i++;
        while (i < lines.length) {
          var nl = lines[i];
          if (isBlank(nl)) {
            /* keep only if indented content follows */
            var k = i;
            while (k < lines.length && isBlank(lines[k])) k++;
            if (k < lines.length && indentOf(lines[k]) >= 4) {
              while (i < k) { body.push(''); i++; }
              continue;
            }
            break;
          }
          if (indentOf(nl) >= 4) { body.push(nl.slice(4)); i++; continue; }
          if (/^ {0,3}\[\^[^\]]+\]:/.test(nl)) break;
          if (isBlockStart(nl)) break;
          body.push(nl.replace(/^ +/, '')); i++;
        }
        if (!Object.prototype.hasOwnProperty.call(state.fnDefs, label)) state.fnDefs[label] = body;
        prevWasBlankOrDef = true;
        continue;
      }

      /* link reference definition */
      var rm = /^ {0,3}\[([^\^\]][^\]]*|[^\]])\]:[ \t]*([\s\S]*)$/.exec(line);
      if (rm && prevWasBlankOrDef) {
        var tail = rm[2];
        var parsed = parseDefTail(tail);
        var consumed = 1;
        if (parsed === null && tail.trim() && i + 1 < lines.length) {
          var joined = parseDefTail(tail + ' ' + lines[i + 1].trim());
          if (joined) { parsed = joined; consumed = 2; }
        }
        if (parsed) {
          var key = normLabel(rm[1]);
          if (key && !Object.prototype.hasOwnProperty.call(state.refs, key)) state.refs[key] = parsed;
          i += consumed;
          prevWasBlankOrDef = true;
          continue;
        }
      }

      out.push(line);
      prevWasBlankOrDef = isBlank(line);
      i++;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * list-item helpers (needed by codeMask, hence defined here)
   * ------------------------------------------------------------------ */

  function matchItemStart(line) {
    var m = RE_LIST_BULLET.exec(line);
    var ordered = false, num = 1, delim = '.', bullet = null, markerLen;
    if (m) {
      bullet = m[2];
      markerLen = 1;
    } else {
      m = RE_LIST_ORDERED.exec(line);
      if (!m) return null;
      ordered = true;
      num = parseInt(m[2], 10);
      delim = m[3];
      markerLen = m[2].length + 1;
    }
    var indent = m[1].length;
    var rest = line.slice(indent + markerLen);
    var pad;
    if (!/[^ ]/.test(rest)) pad = 1;
    else {
      var sp = /^ */.exec(rest)[0].length;
      if (sp === 0) return null;
      pad = sp > 4 ? 1 : sp;
    }
    return {
      indent: indent, markerLen: markerLen, pad: pad, ordered: ordered,
      num: num, delim: delim, bullet: bullet,
      contentIndent: indent + markerLen + pad,
      blankFirst: !/[^ ]/.test(rest)
    };
  }

  function isBlockStart(line) {
    if (isBlank(line)) return false;
    if (RE_HR.test(line)) return true;
    if (RE_FENCE.test(line)) return true;
    if (RE_ATX.test(line)) return true;
    if (RE_BQ.test(line)) return true;
    if (RE_HTML_TAG_LINE.test(line)) return true;
    var it = matchItemStart(line);
    if (it && !it.blankFirst) return true;
    return false;
  }

  function interruptsParagraph(lines, i) {
    var line = lines[i];
    if (RE_HR.test(line)) return true;
    if (RE_FENCE.test(line)) return true;
    if (RE_ATX.test(line)) return true;
    if (RE_BQ.test(line)) return true;
    if (RE_HTML_TAG_LINE.test(line)) return true;
    if (tableAt(lines, i)) return true;
    var it = matchItemStart(line);
    if (it && !it.blankFirst && (!it.ordered || it.num === 1)) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * GFM tables
   * ------------------------------------------------------------------ */

  function splitRow(line) {
    var s = line.trim();
    var n = s.length;
    var cells = [];
    var buf = '';
    var i = 0;
    if (s.charAt(0) === '|') i = 1;
    while (i < n) {
      var c = s.charAt(i);
      if (c === '\\') {
        var nx = s.charAt(i + 1);
        if (nx === '|') { buf += '|'; i += 2; continue; }
        buf += c;
        if (i + 1 < n) buf += nx;
        i += 2;
        continue;
      }
      if (c === '`') {
        var k = 1;
        while (s.charAt(i + k) === '`') k++;
        var p = i + k, found = -1;
        while (p < n) {
          if (s.charAt(p) === '`') {
            var q = p;
            while (s.charAt(q) === '`') q++;
            if (q - p === k) { found = p; break; }
            p = q;
          } else p++;
        }
        if (found >= 0) {
          /* GFM resolves \| before code spans are parsed, so `\|` in a cell is
           * a code span holding a literal pipe. */
          buf += s.slice(i, found + k).replace(/\\\|/g, '|');
          i = found + k;
          continue;
        }
        buf += rep('`', k); i += k; continue;
      }
      if (c === '|') { cells.push(buf); buf = ''; i++; continue; }
      buf += c; i++;
    }
    if (/[^ ]/.test(buf) || s.charAt(n - 1) !== '|' || cells.length === 0) cells.push(buf);
    for (var j = 0; j < cells.length; j++) cells[j] = cells[j].trim();
    return cells;
  }

  function hasUnescapedPipe(line) {
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '\\') { i++; continue; }
      if (c === '|') return true;
    }
    return false;
  }

  function tableAt(lines, i) {
    if (i + 1 >= lines.length) return null;
    var head = lines[i], delim = lines[i + 1];
    if (isBlank(head) || isBlank(delim)) return null;
    if (indentOf(head) >= 4 || indentOf(delim) >= 4) return null;
    if (!hasUnescapedPipe(head) && !hasUnescapedPipe(delim)) return null;
    if (!/^[ \t|:\-]+$/.test(delim)) return null;
    var dcells = splitRow(delim);
    if (!dcells.length) return null;
    for (var k = 0; k < dcells.length; k++) {
      if (!/^:?-+:?$/.test(dcells[k])) return null;
    }
    var hcells = splitRow(head);
    if (hcells.length !== dcells.length) return null;
    var align = dcells.map(function (c) {
      var l = c.charAt(0) === ':';
      var r = c.charAt(c.length - 1) === ':';
      if (l && r) return 'center';
      if (r) return 'right';
      if (l) return 'left';
      return null;
    });
    return { head: hcells, align: align, cols: hcells.length };
  }

  function alignAttr(a) { return a ? ' style="text-align:' + a + '"' : ''; }

  function renderTable(lines, i, state) {
    var t = tableAt(lines, i);
    var j = i + 2;
    var rows = [];
    while (j < lines.length) {
      var line = lines[j];
      if (isBlank(line)) break;
      if (RE_FENCE.test(line) || RE_ATX.test(line) || RE_HR.test(line) || RE_BQ.test(line)) break;
      if (!hasUnescapedPipe(line)) break;
      rows.push(splitRow(line));
      j++;
    }
    var out = ['<div class="md-table-wrap">\n<table class="md-table">\n<thead>\n<tr>'];
    for (var c = 0; c < t.cols; c++) {
      out.push('\n<th' + alignAttr(t.align[c]) + '>' + inline(t.head[c], state) + '</th>');
    }
    out.push('\n</tr>\n</thead>\n');
    if (rows.length) {
      out.push('<tbody>\n');
      for (var r = 0; r < rows.length; r++) {
        out.push('<tr>');
        for (var cc = 0; cc < t.cols; cc++) {
          var cell = rows[r][cc] === undefined ? '' : rows[r][cc];
          out.push('\n<td' + alignAttr(t.align[cc]) + '>' + inline(cell, state) + '</td>');
        }
        out.push('\n</tr>\n');
      }
      out.push('</tbody>\n');
    }
    out.push('</table>\n</div>\n');
    return { html: out.join(''), next: j };
  }

  /* ------------------------------------------------------------------ *
   * URLs
   * ------------------------------------------------------------------ */

  function sanitizeUrl(url) {
    var raw = String(url == null ? '' : url);
    var probe = raw.replace(/[\u0000-\u0020\u007f]+/g, '')
      .replace(/&#[xX]([0-9a-fA-F]+);?/g, function (_, h) {
        var n = parseInt(h, 16);
        return n >= 0 && n < 0x110000 ? String.fromCharCode(n) : '';
      })
      .replace(/&#(\d+);?/g, function (_, d) {
        var n = parseInt(d, 10);
        return n >= 0 && n < 0x110000 ? String.fromCharCode(n) : '';
      })
      .toLowerCase();
    if (/^(javascript|vbscript):/.test(probe)) return '';
    if (/^data:/.test(probe) && !/^data:image\//.test(probe)) return '';
    return raw.trim().replace(/ /g, '%20');
  }

  /* ------------------------------------------------------------------ *
   * 5. inline pass
   * ------------------------------------------------------------------ */

  function flanking(before, after, ch) {
    var bWs = isWsChar(before), aWs = isWsChar(after);
    var bP = isPunctChar(before), aP = isPunctChar(after);
    var left = !aWs && (!aP || bWs || bP);
    var right = !bWs && (!bP || aWs || aP);
    if (ch === '_') {
      return { open: left && (!right || bP), close: right && (!left || aP) };
    }
    return { open: left, close: right };
  }

  function useCount(ch, o, c) {
    if (ch === '=') return (o.n >= 2 && c.n >= 2) ? 2 : 0;
    if (ch === '~') return Math.min(o.n, c.n, 2);
    return (o.n >= 2 && c.n >= 2) ? 2 : 1;
  }

  function tagFor(ch, use) {
    if (ch === '=') return 'mark';
    if (ch === '~') return 'del';
    return use === 2 ? 'strong' : 'em';
  }

  function processEmphasis(nodes) {
    var ci = 0;
    var guard = 0;
    while (ci < nodes.length) {
      if (++guard > 200000) break;
      var closer = nodes[ci];
      if (!(closer.t === 'd' && closer.close && closer.n > 0)) { ci++; continue; }
      var oi = -1;
      for (var j = ci - 1; j >= 0; j--) {
        var o = nodes[j];
        if (o.t !== 'd' || o.ch !== closer.ch || !o.open || o.n <= 0) continue;
        if (closer.ch === '*' || closer.ch === '_') {
          var odd = (closer.open || o.close) &&
            ((closer.orig + o.orig) % 3 === 0) &&
            !(closer.orig % 3 === 0 && o.orig % 3 === 0);
          if (odd) continue;
        }
        oi = j; break;
      }
      if (oi < 0) { ci++; continue; }
      var opener = nodes[oi];
      var use = useCount(closer.ch, opener, closer);
      if (use <= 0) { ci++; continue; }
      var kids = nodes.slice(oi + 1, ci);
      opener.n -= use;
      closer.n -= use;
      var grp = { t: 'g', tag: tagFor(closer.ch, use), kids: kids };
      nodes.splice(oi + 1, ci - oi - 1, grp);
      ci = oi + 2;
      if (closer.n === 0) nodes.splice(ci, 1);
      if (opener.n === 0) { nodes.splice(oi, 1); ci--; }
    }
    return nodes;
  }

  function renderNodes(nodes) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (nd.t === 'h') out += nd.s;
      else if (nd.t === 'd') { if (nd.n > 0) out += escapeHtml(rep(nd.ch, nd.n)); }
      else if (nd.t === 'g') out += '<' + nd.tag + '>' + renderNodes(nd.kids) + '</' + nd.tag + '>';
    }
    return out;
  }

  function findClosingBracket(s, start) {
    var depth = 1, i = start, n = s.length;
    while (i < n) {
      var c = s.charAt(i);
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        var k = 1;
        while (s.charAt(i + k) === '`') k++;
        var p = i + k, found = -1;
        while (p < n) {
          if (s.charAt(p) === '`') {
            var q = p;
            while (s.charAt(q) === '`') q++;
            if (q - p === k) { found = p; break; }
            p = q;
          } else p++;
        }
        if (found >= 0) { i = found + k; continue; }
        i += k; continue;
      }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return i; }
      i++;
    }
    return -1;
  }

  function parseDestTitle(s, j) {
    var n = s.length;
    var p = j + 1;
    while (p < n && /[ \t\n]/.test(s.charAt(p))) p++;
    var dest = '';
    if (s.charAt(p) === '<') {
      var e = p + 1;
      while (e < n && s.charAt(e) !== '>' && s.charAt(e) !== '\n') {
        if (s.charAt(e) === '\\') e++;
        e++;
      }
      if (s.charAt(e) !== '>') return null;
      dest = s.slice(p + 1, e);
      p = e + 1;
    } else {
      var depth = 0, start = p;
      while (p < n) {
        var ch = s.charAt(p);
        if (ch === '\\') { p += 2; continue; }
        if (/[ \t\n]/.test(ch)) break;
        if (ch === '(') { depth++; p++; continue; }
        if (ch === ')') { if (depth === 0) break; depth--; p++; continue; }
        p++;
      }
      dest = s.slice(start, p);
    }
    while (p < n && /[ \t\n]/.test(s.charAt(p))) p++;
    var title = null;
    var tc = s.charAt(p);
    if (tc === '"' || tc === "'" || tc === '(') {
      var endc = tc === '(' ? ')' : tc;
      var te = p + 1;
      while (te < n && s.charAt(te) !== endc) {
        if (s.charAt(te) === '\\') te++;
        te++;
      }
      if (te >= n) return null;
      title = s.slice(p + 1, te);
      p = te + 1;
      while (p < n && /[ \t\n]/.test(s.charAt(p))) p++;
    }
    if (s.charAt(p) !== ')') return null;
    return { dest: unescapePunct(dest), title: title === null ? null : unescapePunct(title), end: p + 1 };
  }

  function plainOf(md, state) {
    var stripped = String(md).replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    var html = inline(stripped, state, true);
    var text = html.replace(/<[^>]*>/g, '');
    text = unescapeHtml(text);
    text = restoreMathTex(text, state);
    return text.replace(/\s+/g, ' ').trim();
  }

  var AUTOLINK_BOUNDARY = /[\s*_~(\[]/;

  function trimAutolink(url) {
    /* Counted once, then kept in step. `[^\s<]+` lets a single token be
     * arbitrarily long, and re-scanning the whole URL per stripped character
     * made this O(n²): 4 s for a URL trailing 20,000 `)`. */
    var opens = 0, closes = 0, ci;
    for (ci = 0; ci < url.length; ci++) {
      var cc = url.charAt(ci);
      if (cc === '(') opens++;
      else if (cc === ')') closes++;
    }
    var changed = true;
    while (changed && url.length) {
      changed = false;
      var last = url.charAt(url.length - 1);
      if ('?!.,:;*_~\'"'.indexOf(last) >= 0) { url = url.slice(0, -1); changed = true; continue; }
      if (last === ')') {
        if (closes > opens) { url = url.slice(0, -1); closes--; changed = true; continue; }
      }
      var ent = /&[a-zA-Z0-9]+;$/.exec(url);
      if (ent) { url = url.slice(0, url.length - ent[0].length); changed = true; continue; }
    }
    return url;
  }

  function inline(src, state, quiet) {
    var s = String(src == null ? '' : src);
    var n = s.length;
    var nodes = [];
    var pending = '';
    var i = 0;

    function flush() {
      if (pending) { nodes.push({ t: 'h', s: escapeHtml(pending) }); pending = ''; }
    }
    function pushHtml(html) { flush(); nodes.push({ t: 'h', s: html }); }

    while (i < n) {
      var c = s.charAt(i);

      /* backslash escapes + backslash hard break */
      if (c === '\\') {
        var nx = s.charAt(i + 1);
        if (nx === '\n') {
          pending = pending.replace(/[ \t]+$/, '');
          pushHtml('<br>\n');
          i += 2;
          while (i < n && s.charAt(i) === ' ') i++;
          continue;
        }
        if (nx && isAsciiPunct(nx)) { pending += nx; i += 2; continue; }
        pending += '\\'; i++; continue;
      }

      /* code spans */
      if (c === '`') {
        var k = 1;
        while (s.charAt(i + k) === '`') k++;
        var open = i + k, p = open, found = -1;
        while (p < n) {
          if (s.charAt(p) === '`') {
            var q = p;
            while (s.charAt(q) === '`') q++;
            if (q - p === k) { found = p; break; }
            p = q;
          } else p++;
        }
        if (found < 0) { pending += rep('`', k); i += k; continue; }
        var content = s.slice(open, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charAt(0) === ' ' &&
            content.charAt(content.length - 1) === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        pushHtml('<code>' + escapeHtml(restoreMathRaw(content, state)) + '</code>');
        i = found + k;
        continue;
      }

      /* line ends + hard breaks */
      if (c === '\n') {
        var hard = /  +$/.test(pending);
        pending = pending.replace(/[ \t]+$/, '');
        flush();
        nodes.push({ t: 'h', s: hard ? '<br>\n' : '\n' });
        i++;
        while (i < n && s.charAt(i) === ' ') i++;
        continue;
      }

      /* entities pass through, bare & is escaped */
      if (c === '&') {
        var em = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/.exec(s.slice(i));
        if (em) { pushHtml(em[0]); i += em[0].length; continue; }
        pending += '&'; i++; continue;
      }

      /* autolinks and raw inline HTML */
      if (c === '<') {
        var rest = s.slice(i);
        var m;
        if ((m = /^<([a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^<>\u0000-\u0020]*)>/.exec(rest))) {
          var href = sanitizeUrl(m[1]);
          state.sawLink = true;
          pushHtml('<a href="' + ATTR_ESC(href) + '">' + escapeHtml(m[1]) + '</a>');
          i += m[0].length; continue;
        }
        if ((m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest))) {
          state.sawLink = true;
          pushHtml('<a href="mailto:' + ATTR_ESC(m[1]) + '">' + escapeHtml(m[1]) + '</a>');
          i += m[0].length; continue;
        }
        if ((m = /^<!--[\s\S]*?-->/.exec(rest)) ||
            (m = /^<\?[\s\S]*?\?>/.exec(rest)) ||
            (m = /^<![A-Za-z][^>]*>/.exec(rest)) ||
            (m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(rest))) {
          pushHtml(m[0]); i += m[0].length; continue;
        }
        if ((m = /^<\/?[a-zA-Z][a-zA-Z0-9\-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:\-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.exec(rest))) {
          pushHtml(m[0]); i += m[0].length; continue;
        }
        pending += '<'; i++; continue;
      }

      /* bare email autolink (GFM) */
      if (c === '@' && !state.inLink) {
        var ml = /(?:^|[\s*_~(\[])([A-Za-z0-9._%+\-]+)$/.exec(pending);
        var md = /^@([A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)+)/.exec(s.slice(i));
        if (ml && md) {
          var local = ml[1];
          var domain = md[1].replace(/[.\-_]+$/, '');
          if (domain) {
            pending = pending.slice(0, pending.length - local.length);
            var addr = local + '@' + domain;
            pushHtml('<a href="mailto:' + ATTR_ESC(addr) + '">' + escapeHtml(addr) + '</a>');
            i += 1 + domain.length;
            continue;
          }
        }
        pending += '@'; i++; continue;
      }

      /* bare URL autolink (GFM) */
      if ((c === 'h' || c === 'H' || c === 'w' || c === 'W') && !state.inLink) {
        var prevCh = i > 0 ? s.charAt(i - 1) : '\n';
        if (i === 0 || AUTOLINK_BOUNDARY.test(prevCh)) {
          var am = /^(?:https?:\/\/|www\.)[^\s<]+/i.exec(s.slice(i));
          if (am) {
            var url = trimAutolink(am[0]);
            if (url.length > 6 && /\.[a-zA-Z]{2,}/.test(url)) {
              var target = /^www\./i.test(url) ? 'http://' + url : url;
              pushHtml('<a href="' + ATTR_ESC(sanitizeUrl(target)) + '">' + escapeHtml(url) + '</a>');
              i += url.length;
              continue;
            }
          }
        }
      }

      /* links, images, footnote references */
      if (c === '[' || (c === '!' && s.charAt(i + 1) === '[')) {
        var isImg = c === '!';
        var lb = i + (isImg ? 2 : 1);
        var close = findClosingBracket(s, lb);
        if (close < 0) { pending += c; i++; continue; }
        var label = s.slice(lb, close);

        if (!isImg && label.charAt(0) === '^' && s.charAt(close + 1) !== '(' && s.charAt(close + 1) !== '[') {
          var fl = normLabel(label.slice(1));
          if (fl && Object.prototype.hasOwnProperty.call(state.fnDefs, fl)) {
            pushHtml(footnoteRef(fl, state, quiet));
            i = close + 1;
            continue;
          }
        }

        var j2 = close + 1;
        var dest = null, title = null, matched = false, end = -1;
        if (s.charAt(j2) === '(') {
          var dt = parseDestTitle(s, j2);
          if (dt) { dest = dt.dest; title = dt.title; end = dt.end; matched = true; }
        }
        if (!matched && s.charAt(j2) === '[') {
          var rc = findClosingBracket(s, j2 + 1);
          if (rc >= 0) {
            var refName = s.slice(j2 + 1, rc);
            var key = normLabel(refName || label);
            if (Object.prototype.hasOwnProperty.call(state.refs, key)) {
              dest = state.refs[key].dest; title = state.refs[key].title;
              end = rc + 1; matched = true;
            }
          }
        }
        if (!matched && s.charAt(j2) !== '(' && s.charAt(j2) !== '[') {
          var skey = normLabel(label);
          if (Object.prototype.hasOwnProperty.call(state.refs, skey)) {
            dest = state.refs[skey].dest; title = state.refs[skey].title;
            end = close + 1; matched = true;
          }
        }

        if (matched) {
          /* CommonMark forbids a link inside a link and lets the inner-most
           * definition win, so a label carrying one of its own leaves the
           * outer brackets literal. Probed quietly first: emitting the outer
           * <a> anyway produced markup the browser un-nests into two sibling
           * anchors, turning text nobody linked into a live link. */
          if (!isImg && (label.indexOf('[') >= 0 || label.indexOf('<') >= 0)) {
            var wasIn0 = state.inLink, wasSaw0 = state.sawLink;
            state.inLink = true;
            state.sawLink = false;
            inline(label, state, true);
            var nested = state.sawLink;
            state.inLink = wasIn0;
            state.sawLink = wasSaw0;
            if (nested) { pending += c; i++; continue; }
          }
          var href2 = ATTR_ESC(sanitizeUrl(restoreMathRaw(dest || '', state)));
          var titleAttr = title ? ' title="' + ATTR_ESC(restoreMathRaw(title, state)) + '"' : '';
          if (isImg) {
            pushHtml('<img src="' + href2 + '" alt="' + ATTR_ESC(plainOf(label, state)) + '"' + titleAttr + '>');
          } else {
            var wasIn = state.inLink;
            state.inLink = true;
            var innerHtml = inline(label, state, quiet);
            state.inLink = wasIn;
            state.sawLink = true;
            pushHtml('<a href="' + href2 + '"' + titleAttr + '>' + innerHtml + '</a>');
          }
          i = end;
          continue;
        }
        pending += c; i++; continue;
      }

      /* emphasis-family delimiter runs */
      if (c === '*' || c === '_' || c === '~' || c === '=') {
        var run = 1;
        while (s.charAt(i + run) === c) run++;
        if ((c === '~' || c === '=') && (run > 2 || (c === '=' && run < 2))) {
          pending += rep(c, run); i += run; continue;
        }
        var before = i > 0 ? s.charAt(i - 1) : '\n';
        var afterCh = i + run < n ? s.charAt(i + run) : '\n';
        var fl2 = flanking(before, afterCh, c);
        if (!fl2.open && !fl2.close) { pending += rep(c, run); i += run; continue; }
        flush();
        nodes.push({ t: 'd', ch: c, n: run, orig: run, open: fl2.open, close: fl2.close });
        i += run;
        continue;
      }

      pending += c;
      i++;
    }
    flush();
    return renderNodes(processEmphasis(nodes));
  }

  /* ------------------------------------------------------------------ *
   * footnotes
   * ------------------------------------------------------------------ */

  function footnoteRef(label, state, quiet) {
    var idx = state.fnOrder.indexOf(label);
    if (idx < 0) {
      if (quiet) idx = state.fnOrder.length;
      else { state.fnOrder.push(label); idx = state.fnOrder.length - 1; }
    }
    var num = idx + 1;
    var count = 1;
    if (!quiet) {
      state.fnRefCount[label] = (state.fnRefCount[label] || 0) + 1;
      count = state.fnRefCount[label];
    }
    var refId = 'fnref-' + num + (count > 1 ? '-' + count : '');
    return '<sup class="md-fnref"><a href="#fn-' + num + '" id="' + refId + '">' + num + '</a></sup>';
  }

  function renderFootnotes(state) {
    if (!state.fnOrder.length) return '';
    var out = ['<section class="md-footnotes">\n<hr>\n<ol>\n'];
    for (var i = 0; i < state.fnOrder.length; i++) {
      var label = state.fnOrder[i];
      var num = i + 1;
      var body = state.fnDefs[label] || [''];
      var html = parseBlocks(body.slice(), state, false);
      var refs = state.fnRefCount[label] || 1;
      var back = '';
      for (var r = 1; r <= refs; r++) {
        back += ' <a href="#fnref-' + num + (r > 1 ? '-' + r : '') + '" class="md-fnback">↩' +
          (refs > 1 ? '<sup>' + r + '</sup>' : '') + '</a>';
      }
      html = html.replace(/\s*$/, '');
      if (/<\/p>$/.test(html)) html = html.slice(0, -4) + back + '</p>';
      else html += back;
      out.push('<li id="fn-' + num + '">\n' + html + '\n</li>\n');
    }
    out.push('</ol>\n</section>\n');
    return out.join('');
  }

  /* ------------------------------------------------------------------ *
   * headings
   * ------------------------------------------------------------------ */

  function slugify(text, state) {
    var base = String(text).toLowerCase()
      .replace(/[‘’“”'"`´]/g, '')
      .replace(/[^a-z0-9À-￿ \-_]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!base) base = 'section';
    if (!Object.prototype.hasOwnProperty.call(state.slugs, base)) {
      state.slugs[base] = 0;
      return base;
    }
    state.slugs[base] += 1;
    return base + '-' + state.slugs[base];
  }

  function renderHeading(level, raw, state) {
    var text = raw == null ? '' : raw;
    var plain = plainOf(text, state);
    var id = slugify(plain, state);
    state.headings.push({ level: level, text: plain, id: id });
    var out = Math.min(6, Math.max(1, level + state.baseHeading - 1));
    var body = inline(text, state);
    return '<h' + out + ' id="' + ATTR_ESC(id) + '">' + body +
      '<a class="md-anchor" href="#' + ATTR_ESC(id) + '" aria-label="Permalink">#</a>' +
      '</h' + out + '>\n';
  }

  /* ------------------------------------------------------------------ *
   * 4. block pass
   * ------------------------------------------------------------------ */

  function renderParagraph(text, state, tight) {
    var body = text.replace(/^\n+|\n+$/g, '');
    if (!body) return '';
    var solo = /^\u0000MATH(\d+)\u0000$/.exec(body.trim());
    if (solo) {
      var m = state.math[+solo[1]];
      if (m && m.display) return '<div class="md-math-block">' + body.trim() + '</div>\n';
    }
    var html = inline(body, state);
    return tight ? html + '\n' : '<p>' + html + '</p>\n';
  }

  function parseFence(lines, i, state) {
    var m = RE_FENCE.exec(lines[i]);
    var ch = m[2].charAt(0), len = m[2].length, indent = m[1].length;
    var info = m[3].trim();
    var body = [];
    var j = i + 1;
    while (j < lines.length) {
      var line = lines[j];
      var cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (cm && cm[1].charAt(0) === ch && cm[1].length >= len) { j++; break; }
      var strip = 0;
      while (strip < indent && line.charAt(strip) === ' ') strip++;
      body.push(line.slice(strip));
      j++;
    }
    var lang = info.split(/\s+/)[0] || '';
    var cls = lang ? ' class="language-' + ATTR_ESC(unescapePunct(lang)) + '"' : '';
    var code = escapeHtml(restoreMathRaw(body.join('\n'), state));
    if (code) code += '\n';
    return { html: '<pre><code' + cls + '>' + code + '</code></pre>\n', next: j };
  }

  function parseHtmlBlock(lines, i) {
    var out = [];
    var j = i;
    var rawOpen = RE_HTML_RAW_OPEN.exec(lines[i]);
    if (rawOpen) {
      var closeRe = new RegExp('</' + rawOpen[1] + '\\s*>', 'i');
      while (j < lines.length) {
        out.push(lines[j]);
        if (closeRe.test(lines[j])) { j++; break; }
        j++;
      }
      return { html: out.join('\n') + '\n', next: j };
    }
    if (/^ {0,3}<!--/.test(lines[i])) {
      while (j < lines.length) {
        out.push(lines[j]);
        if (lines[j].indexOf('-->') >= 0) { j++; break; }
        j++;
      }
      return { html: out.join('\n') + '\n', next: j };
    }
    while (j < lines.length && !isBlank(lines[j])) { out.push(lines[j]); j++; }
    return { html: out.join('\n') + '\n', next: j };
  }

  function parseIndentedCode(lines, i, state) {
    var body = [];
    var j = i;
    var pendingBlanks = [];
    while (j < lines.length) {
      var line = lines[j];
      if (isBlank(line)) { pendingBlanks.push(''); j++; continue; }
      if (indentOf(line) >= 4) {
        while (pendingBlanks.length) body.push(pendingBlanks.shift());
        body.push(line.slice(4));
        j++;
        continue;
      }
      break;
    }
    j -= pendingBlanks.length;
    var code = escapeHtml(restoreMathRaw(body.join('\n'), state));
    return { html: '<pre><code>' + code + '\n</code></pre>\n', next: j };
  }

  function parseBlockquote(lines, i, state) {
    var body = [];
    var j = i;
    var prevBlank = true;
    while (j < lines.length) {
      var line = lines[j];
      if (RE_BQ.test(line)) {
        body.push(line.replace(/^ {0,3}> ?/, ''));
        prevBlank = isBlank(body[body.length - 1]);
        j++;
        continue;
      }
      if (isBlank(line)) break;
      if (prevBlank || isBlockStart(line)) break;
      body.push(line.replace(/^ +/, ''));
      j++;
    }
    return { html: '<blockquote>\n' + parseBlocks(body, state, false) + '</blockquote>\n', next: j };
  }

  function parseList(lines, i, state) {
    var first = matchItemStart(lines[i]);
    var ordered = first.ordered;
    var items = [];
    var loose = false;
    var anyTask = false;
    var j = i;

    while (j < lines.length) {
      if (RE_HR.test(lines[j])) break;
      var it = matchItemStart(lines[j]);
      if (!it) break;
      if (it.ordered !== ordered) break;
      if (ordered ? it.delim !== first.delim : it.bullet !== first.bullet) break;
      if (it.indent > first.indent + 3) break;

      var contentIndent = it.contentIndent;
      var itemLines = [];
      var head = lines[j].slice(Math.min(contentIndent, lines[j].length));
      itemLines.push(head);
      j++;
      var blanks = [];
      while (j < lines.length) {
        var line = lines[j];
        if (isBlank(line)) { blanks.push(''); j++; continue; }
        var ind = indentOf(line);
        if (ind >= contentIndent) {
          while (blanks.length) itemLines.push(blanks.shift());
          itemLines.push(line.slice(contentIndent));
          j++;
          continue;
        }
        if (blanks.length) break;
        if (matchItemStart(line) || isBlockStart(line)) break;
        itemLines.push(line.replace(/^ +/, ''));
        j++;
      }
      var sawTrailingBlank = blanks.length > 0;

      while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
      for (var b = 1; b < itemLines.length; b++) {
        if (isBlank(itemLines[b])) { loose = true; break; }
      }

      var task = null;
      var tm = /^\[([ xX])\][ \t]+/.exec(itemLines[0] || '');
      if (tm) {
        task = tm[1] !== ' ';
        anyTask = true;
        itemLines[0] = itemLines[0].slice(tm[0].length);
      }
      items.push({ lines: itemLines, task: task });

      if (sawTrailingBlank) {
        var more = j < lines.length && !RE_HR.test(lines[j]) && matchItemStart(lines[j]);
        if (more && more.ordered === ordered &&
            (ordered ? more.delim === first.delim : more.bullet === first.bullet)) {
          loose = true;
        } else break;
      }
    }

    var out = [];
    var tag = ordered ? 'ol' : 'ul';
    var attrs = '';
    if (ordered && first.num !== 1) attrs += ' start="' + first.num + '"';
    if (anyTask) attrs += ' class="contains-task-list"';
    out.push('<' + tag + attrs + '>\n');
    for (var k = 0; k < items.length; k++) {
      var item = items[k];
      var html = parseBlocks(item.lines, state, !loose);
      if (item.task !== null) {
        var box = '<input class="task-list-item-checkbox" type="checkbox" disabled' +
          (item.task ? ' checked' : '') + '> ';
        if (/^<p>/.test(html)) html = '<p>' + box + html.slice(3);
        else html = box + html;
      }
      var liClass = item.task !== null ? ' class="task-list-item"' : '';
      html = html.replace(/\n+$/, '');
      if (html.indexOf('\n') >= 0 || /^</.test(html)) {
        out.push('<li' + liClass + '>\n' + html + '\n</li>\n');
      } else {
        out.push('<li' + liClass + '>' + html + '</li>\n');
      }
    }
    out.push('</' + tag + '>\n');
    return { html: out.join(''), next: j };
  }

  function parseBlocks(lines, state, tight) {
    var out = [];
    var i = 0;
    var guard = 0;
    while (i < lines.length) {
      if (++guard > 500000) break;
      var line = lines[i];

      if (isBlank(line)) { i++; continue; }

      if (RE_FENCE.test(line)) {
        var fm = RE_FENCE.exec(line);
        if (!(fm[2].charAt(0) === '`' && fm[3].indexOf('`') >= 0)) {
          var f = parseFence(lines, i, state);
          out.push(f.html); i = f.next; continue;
        }
      }

      if (RE_HR.test(line)) { out.push('<hr>\n'); i++; continue; }

      var am = RE_ATX.exec(line);
      if (am) {
        var text = am[2] === undefined ? '' : am[2];
        text = text.replace(/(^|[ \t])#+[ \t]*$/, '');
        out.push(renderHeading(am[1].length, text.trim(), state));
        i++;
        continue;
      }

      if (RE_BQ.test(line)) {
        var bq = parseBlockquote(lines, i, state);
        out.push(bq.html); i = bq.next; continue;
      }

      var it0 = matchItemStart(line);
      if (it0) {
        var ls = parseList(lines, i, state);
        if (ls.next > i) { out.push(ls.html); i = ls.next; continue; }
      }

      if (tableAt(lines, i)) {
        var tb = renderTable(lines, i, state);
        out.push(tb.html); i = tb.next; continue;
      }

      if (RE_HTML_TAG_LINE.test(line)) {
        var hb = parseHtmlBlock(lines, i);
        out.push(hb.html); i = hb.next; continue;
      }

      if (indentOf(line) >= 4) {
        var ic = parseIndentedCode(lines, i, state);
        if (ic.next > i) { out.push(ic.html); i = ic.next; continue; }
      }

      /* paragraph, with setext heading detection */
      var para = [];
      var heading = 0;
      while (i < lines.length && !isBlank(lines[i])) {
        if (para.length) {
          var sm = RE_SETEXT.exec(lines[i]);
          if (sm) { heading = sm[1].charAt(0) === '=' ? 1 : 2; i++; break; }
          if (interruptsParagraph(lines, i)) break;
        }
        para.push(lines[i].replace(/^ {0,3}/, ''));
        i++;
      }
      var joined = para.join('\n').replace(/[ \t]+$/, '');
      if (heading) out.push(renderHeading(heading, joined.trim(), state));
      else out.push(renderParagraph(joined, state, tight));
    }
    return out.join('');
  }

  /* ------------------------------------------------------------------ *
   * public API
   * ------------------------------------------------------------------ */

  function newState(opts) {
    opts = opts || {};
    var base = parseInt(opts.baseHeadingLevel, 10);
    if (!(base >= 1 && base <= 6)) base = 1;
    return {
      math: [],
      refs: {},
      fnDefs: {},
      fnOrder: [],
      fnRefCount: {},
      slugs: {},
      headings: [],
      inLink: false,
      sawLink: false,
      baseHeading: base,
      mathFn: typeof opts.math === 'function' ? opts.math : null
    };
  }

  function build(src, opts) {
    var state = newState(opts);
    var text = stripFrontMatter(normalise(src));
    text = extractMath(text, state);
    var lines = extractDefinitions(text.split('\n'), state);
    var html = parseBlocks(lines, state, false);
    html += renderFootnotes(state);
    html = substituteMath(html, state);
    return { html: html, state: state };
  }

  function render(src, opts) {
    try {
      return build(src, opts).html;
    } catch (e) {
      /* The fallback must not throw either: an argument whose toString throws
       * escaped straight out of this handler. */
      var raw = '';
      try { raw = src == null ? '' : String(src); } catch (coerce) { raw = ''; }
      return '<pre class="md-error">' + escapeHtml(raw) + '</pre>\n';
    }
  }

  function outline(src) {
    try {
      return build(src, null).state.headings.map(function (h) {
        return { level: h.level, text: h.text, id: h.id };
      });
    } catch (e) {
      return [];
    }
  }

  var MD = {
    VERSION: VERSION,
    render: render,
    outline: outline
  };

  var g = typeof window !== 'undefined' ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this);
  g.MD = MD;
})();
