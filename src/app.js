/* app.js — the editor shell.
 *
 * Owns every id listed in CONTRACT.md's DOM table. Reads window.MD and
 * window.TeX defensively: either may be missing (a broken build, a source file
 * that failed to parse) and the app still has to show the user their text.
 *
 * No imports, no exports, no dependencies. Assigns exactly one global:
 * window.__mdstudio = { render, setText, getState } — the test hook.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  var PREFIX = 'mdstudio.';
  var INDENT = '  ';
  var WPM = 220;
  var RENDER_DEBOUNCE = 120;
  var SAVE_DEBOUNCE = 400;
  var SYNC_LOCKOUT = 150; // ms one pane stays "the driver" after it moves

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ESCAPES[c];
    });
  }

  function group(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : (n > hi ? hi : n);
  }

  /* localStorage may be disabled outright on a file:// page, and touching it
   * can throw on *read* as well as write. Every access goes through these. */
  var storageBroken = false;

  function lsGet(key, fallback) {
    try {
      var v = window.localStorage.getItem(PREFIX + key);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      storageBroken = true;
      return fallback;
    }
  }

  /* A quota failure and a disabled store are the same `false` to the caller but
   * NOT the same thing to say out loud: "this page cannot use local storage" is
   * simply wrong for a 6 MB document on a page whose storage works fine. */
  var storageFull = false;

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(PREFIX + key, String(value));
      return true;
    } catch (e) {
      var name = (e && e.name) || '';
      if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
          (e && e.code === 22)) storageFull = true;
      else storageBroken = true;
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Element handles
   * ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  var app, editor, editorPane, preview, previewPane, panes, gutter, outline, toc;
  var fileInput, statusName, statusStats, statusMsg, drop, help, helpTable, themeLabel;
  var btnOpen, btnSave, btnNew, btnCopy, btnPrint, btnOutline, btnTheme, btnHelp;
  var modeEdit, modeSplit, modeRead;

  function grabElements() {
    app = $('app');
    editor = $('editor');
    editorPane = $('editor-pane');
    preview = $('preview');
    previewPane = $('preview-pane');
    panes = $('panes');
    gutter = $('gutter');
    outline = $('outline');
    toc = $('toc');
    fileInput = $('file-input');
    statusName = $('status-name');
    statusStats = $('status-stats');
    statusMsg = $('status-msg');
    drop = $('drop');
    help = $('help');
    helpTable = $('help-table');
    themeLabel = $('theme-label');
    btnOpen = $('btn-open');
    btnSave = $('btn-save');
    btnNew = $('btn-new');
    btnCopy = $('btn-copy');
    btnPrint = $('btn-print');
    btnOutline = $('btn-outline');
    btnTheme = $('btn-theme');
    btnHelp = $('btn-help');
    modeEdit = $('mode-edit');
    modeSplit = $('mode-split');
    modeRead = $('mode-read');
    if (!editor || !preview) throw new Error('missing #editor or #preview');
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  var MODES = ['edit', 'split', 'read'];
  var THEMES = ['light', 'dark', 'system'];

  var state = {
    name: 'untitled.md',
    dirty: false,
    mode: 'split',
    theme: 'system',
    ratio: 0.5,
    outlineOpen: false
  };

  var lastHtml = '';
  var lastOutline = [];
  var headingEls = [];
  var missingParts = [];

  var IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
    (navigator.platform || '') + ' ' + (navigator.userAgent || '')
  );
  var MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';
  var SHIFT_LABEL = IS_MAC ? '⇧' : 'Shift';

  /* ------------------------------------------------------------------ *
   * Status line
   * ------------------------------------------------------------------ */

  var msgTimer = 0;

  function say(text, kind, sticky) {
    if (!statusMsg) return;
    statusMsg.textContent = text || '';
    if (kind) statusMsg.setAttribute('data-kind', kind);
    else statusMsg.removeAttribute('data-kind');
    if (msgTimer) { clearTimeout(msgTimer); msgTimer = 0; }
    if (text && !sticky) {
      msgTimer = setTimeout(function () {
        statusMsg.textContent = '';
        statusMsg.removeAttribute('data-kind');
        msgTimer = 0;
      }, 4000);
    }
  }

  function paintName() {
    if (!statusName) return;
    statusName.textContent = state.name + (state.dirty ? ' •' : '');
    statusName.title = state.dirty ? state.name + ' (unsaved changes)' : state.name;
  }

  function setName(name) {
    state.name = (name && String(name).trim()) || 'untitled.md';
    paintName();
  }

  function setDirty(d) {
    state.dirty = !!d;
    paintName();
  }

  function statsOf(text) {
    var trimmed = text.replace(/^\s+|\s+$/g, '');
    var words = trimmed ? trimmed.split(/\s+/).length : 0;
    return {
      words: words,
      chars: text.length,
      lines: text === '' ? 0 : text.split('\n').length,
      minutes: words ? Math.max(1, Math.round(words / WPM)) : 0
    };
  }

  function updateStats() {
    if (!statusStats) return;
    var s = statsOf(editor.value);
    statusStats.textContent =
      group(s.words) + ' words · ' + group(s.chars) + ' chars · ' +
      group(s.lines) + ' lines · ' + (s.minutes ? s.minutes + ' min read' : '0 min read');
    statusStats.title = 'Reading time at ' + WPM + ' words per minute';
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function hasMD() {
    return !!(window.MD && typeof window.MD.render === 'function');
  }

  function mathRenderer(tex, display) {
    try {
      if (window.TeX && typeof window.TeX.toMathML === 'function') {
        var out = window.TeX.toMathML(tex, display);
        if (typeof out === 'string' && out) return out;
      }
    } catch (e) { /* fall through to the raw-code fallback */ }
    return '<code class="md-math-raw">' + escapeHtml(tex) + '</code>';
  }

  function plainHtml(src) {
    return '<pre class="md-fallback"><code>' + escapeHtml(src) + '</code></pre>';
  }

  function toHtml(src) {
    if (!hasMD()) return plainHtml(src);
    try {
      var html = window.MD.render(src, { math: mathRenderer, baseHeadingLevel: 1 });
      return typeof html === 'string' ? html : plainHtml(src);
    } catch (e) {
      say('Renderer failed: ' + (e && e.message ? e.message : e), 'error', true);
      return plainHtml(src);
    }
  }

  var muteSyncUntil = 0;

  /* One pass: build the whole string, assign innerHTML once, restore scroll. */
  function render() {
    var src = editor.value;
    var top = previewPane ? previewPane.scrollTop : 0;
    lastHtml = toHtml(src);
    preview.innerHTML = lastHtml;
    enhance();
    if (previewPane) {
      muteSyncUntil = now() + 120;
      previewPane.scrollTop = top;
    }
    buildOutline(src);
    updateStats();
  }

  var renderTimer = 0;

  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      renderTimer = 0;
      render();
    }, RENDER_DEBOUNCE);
  }

  function renderNow() {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
    render();
  }

  /* Post-render DOM work: copy buttons on code blocks, safe external links,
   * a cached heading list for the outline's active-item highlight. */
  function enhance() {
    var pres = preview.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      if (pre.parentNode && pre.parentNode.classList &&
          pre.parentNode.classList.contains('md-code-wrap')) continue;
      var wrap = document.createElement('div');
      wrap.className = 'md-code-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      var btn = document.createElement('button');
      btn.type = 'button';
      /* `md-copy` and not `md-copy-btn`: markdown.css reveals `.md-copy` on
       * :focus-visible and paints `.md-copy.is-done` green. Under the old name
       * the button was a keyboard-focusable control stuck at opacity 0 — 43
       * invisible tab stops in the shipped demo — and the confirmed state was
       * unreachable. */
      btn.className = 'md-copy';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code');
      wrap.appendChild(btn);
    }

    var links = preview.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var href = a.getAttribute('href') || '';
      if (/^(https?:)?\/\//i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    }

    headingEls = [];
    var hs = preview.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]');
    for (var k = 0; k < hs.length; k++) headingEls.push(hs[k]);
  }

  /* ------------------------------------------------------------------ *
   * Outline
   * ------------------------------------------------------------------ */

  function buildOutline(src) {
    lastOutline = [];
    if (window.MD && typeof window.MD.outline === 'function') {
      try {
        var got = window.MD.outline(src);
        if (got && got.length) lastOutline = got;
      } catch (e) { lastOutline = []; }
    }
    if (!toc) return;
    toc.textContent = '';

    if (!lastOutline.length) {
      var li = document.createElement('li');
      li.className = 'toc-empty';
      li.textContent = hasMD() ? 'No headings yet' : 'Outline unavailable';
      toc.appendChild(li);
      return;
    }

    /* Nest by level. Each stack frame owns the <li> it was created for; its
     * child <ol> is created lazily the first time a deeper heading arrives. */
    var stack = [{ level: 0, list: toc, li: null }];
    for (var i = 0; i < lastOutline.length; i++) {
      var h = lastOutline[i];
      var level = clamp(Number(h.level) || 1, 1, 6);
      while (stack.length > 1 && level <= stack[stack.length - 1].level) stack.pop();
      var top = stack[stack.length - 1];
      if (!top.list) {
        top.list = document.createElement('ol');
        top.list.className = 'toc-sub';
        top.li.appendChild(top.list);
      }
      var item = document.createElement('li');
      /* `lvl-N` plus `data-level`, which is what app.css's --indent ladder and
       * its level-1 weight rule key on. The old `toc-l N` matched none of it,
       * so every entry rendered flat at weight 400 and the whole ladder was
       * dead CSS. */
      item.className = 'toc-item lvl-' + level;
      item.setAttribute('data-level', String(level));
      var link = document.createElement('a');
      link.className = 'toc-link';
      link.href = '#' + (h.id || '');
      link.setAttribute('data-heading', h.id || '');
      var htext = h.text == null ? '' : String(h.text);
      link.textContent = htext;
      /* The entry is ellipsised at the sidebar's width, so the full heading has
       * to be readable some other way than by clicking it. */
      if (htext) link.title = htext;
      item.appendChild(link);
      top.list.appendChild(item);
      stack.push({ level: level, list: null, li: item });
    }
    /* Every <a> here is brand new, so the memoised id in highlightOutline no
     * longer marks anything — without this reset the active highlight died on
     * the first keystroke and only came back once you scrolled past a
     * *different* heading. */
    activeHeadingId = null;
    highlightOutline();
  }

  function headingById(id) {
    for (var i = 0; i < headingEls.length; i++) {
      if (headingEls[i].id === id) return headingEls[i];
    }
    return null;
  }

  function scrollPreviewTo(el) {
    if (!el || !previewPane) return;
    var r = el.getBoundingClientRect();
    var p = previewPane.getBoundingClientRect();
    muteSyncUntil = now() + 200;
    previewPane.scrollTop += (r.top - p.top) - 8;
  }

  function gotoHeading(id) {
    if (state.mode === 'edit') setMode('split');
    renderNow();
    var el = headingById(id);
    if (!el) { say('Heading not found', 'warn'); return; }
    scrollPreviewTo(el);
    /* scrollPreviewTo mutes the sync to stop the ping-pong, which also meant
     * nothing ever pushed the new position to the source pane: the outline
     * jumped the reader and left the editor behind at its old scrollTop. */
    if (state.mode === 'split' && editor && previewPane) {
      applyScrollRatio(editor, scrollRatio(previewPane));
    }
    highlightOutline();
  }

  var activeHeadingId = null;

  function highlightOutline() {
    if (!toc || !previewPane || !headingEls.length) return;
    var paneTop = previewPane.getBoundingClientRect().top;
    var current = headingEls[0].id;
    for (var i = 0; i < headingEls.length; i++) {
      if (headingEls[i].getBoundingClientRect().top - paneTop <= 8) current = headingEls[i].id;
      else break;
    }
    if (current === activeHeadingId) return;
    activeHeadingId = current;
    var links = toc.querySelectorAll('a[data-heading]');
    for (var j = 0; j < links.length; j++) {
      if (links[j].getAttribute('data-heading') === current) links[j].classList.add('is-active');
      else links[j].classList.remove('is-active');
    }
  }

  function setOutlineOpen(open) {
    state.outlineOpen = !!open;
    if (outline) outline.hidden = !state.outlineOpen;
    if (btnOutline) btnOutline.setAttribute('aria-pressed', state.outlineOpen ? 'true' : 'false');
    saveSoon();
  }

  /* ------------------------------------------------------------------ *
   * Modes and the split ratio
   * ------------------------------------------------------------------ */

  /* Where the caret was the last time the textarea was on screen. read mode
   * sets display:none on the pane, which blows focus away to <body>. */
  var lastCaret = 0;
  var booted = false;

  function focusEditor() {
    if (!editor) return;
    try {
      editor.focus();
      var at = clamp(lastCaret, 0, editor.value.length);
      editor.setSelectionRange(at, at);
    } catch (e) { /* ignore */ }
  }

  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) mode = 'split';
    var wasFocused = document.activeElement;
    if (editor && wasFocused === editor) lastCaret = editor.selectionStart || 0;
    state.mode = mode;
    if (app) app.setAttribute('data-mode', mode);
    var pairs = [[modeEdit, 'edit'], [modeSplit, 'split'], [modeRead, 'read']];
    for (var i = 0; i < pairs.length; i++) {
      var btn = pairs[i][0];
      if (!btn) continue;
      var on = pairs[i][1] === mode;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) btn.classList.add('is-active'); else btn.classList.remove('is-active');
    }
    if (gutter) {
      gutter.setAttribute('aria-hidden', mode === 'split' ? 'false' : 'true');
      gutter.tabIndex = mode === 'split' ? 0 : -1;
    }
    applySplit();
    /* Coming back from read mode, focus is sitting on <body> and nothing put it
     * back: edit mode looked like a full-window text editor that silently
     * discarded every keystroke. Only reclaimed from <body> or from the editor
     * itself, so clicking a toolbar button never has focus yanked off it, and
     * only after boot, so a cold load still starts its Tab walk at the
     * toolbar. */
    if (booted && mode !== 'read' &&
        (!wasFocused || wasFocused === document.body || wasFocused === editor)) {
      focusEditor();
    }
    saveSoon();
  }

  function cycleMode() {
    setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
  }

  function applySplit() {
    /* `fr`, not `%`. A percentage grid track resolves against the WHOLE grid
     * content box, which includes the outline column when it is open — so a
     * 0.572 ratio put the divider 133px right of the pointer, drifting further
     * the further you dragged. `fr` distributes only the space left after the
     * fixed outline column and the auto gutter, which is exactly the region the
     * ratio is measured over in wireGutter. */
    var lead = Math.round(state.ratio * 1000) / 10;
    var split = lead + 'fr';
    var rest = (Math.round((1 - state.ratio) * 1000) / 10) + 'fr';
    if (app) {
      app.style.setProperty('--split', split);
      app.style.setProperty('--split-rest', rest);
    }
    if (panes) {
      panes.style.setProperty('--split', split);
      panes.style.setProperty('--split-rest', rest);
    }
    if (gutter) {
      gutter.setAttribute('aria-valuemin', '15');
      gutter.setAttribute('aria-valuemax', '85');
      gutter.setAttribute('aria-valuenow', String(Math.round(state.ratio * 100)));
      gutter.setAttribute('aria-valuetext', Math.round(state.ratio * 100) + '% editor');
    }
  }

  function setRatio(r) {
    if (!isFinite(r)) return;
    state.ratio = clamp(r, 0.15, 0.85);
    applySplit();
    saveSoon();
  }

  function wireGutter() {
    if (!gutter) return;
    var geom = null;

    gutter.addEventListener('pointerdown', function (e) {
      if (state.mode !== 'split' || !editorPane || !previewPane) return;
      e.preventDefault();
      /* The ratio is a share of the space the two fr tracks divide, which is
       * everything between the panes MINUS the auto gutter track sitting
       * between them. Counting the gutter's own 11px in put the divider half a
       * gutter left of the pointer. */
      var left = editorPane.getBoundingClientRect().left;
      var right = previewPane.getBoundingClientRect().right;
      var gap = gutter.getBoundingClientRect().width || 0;
      geom = { left: left, width: Math.max(1, right - left - gap) };
      try { gutter.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      /* Both hooks are read by app.css: `#gutter[data-dragging]` thickens the
       * rule, `body.is-resizing` holds the col-resize cursor and kills text
       * selection for the length of the drag. */
      gutter.setAttribute('data-dragging', '');
      document.body.classList.add('is-resizing');
    });

    gutter.addEventListener('pointermove', function (e) {
      if (!geom) return;
      setRatio((e.clientX - geom.left) / geom.width);
    });

    function endDrag(e) {
      if (!geom) return;
      geom = null;
      try { gutter.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      gutter.removeAttribute('data-dragging');
      document.body.classList.remove('is-resizing');
      persistNow();
    }
    gutter.addEventListener('pointerup', endDrag);
    gutter.addEventListener('pointercancel', endDrag);

    gutter.addEventListener('dblclick', function () { setRatio(0.5); });

    gutter.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setRatio(state.ratio - step); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setRatio(state.ratio + step); }
      else if (e.key === 'Home') { e.preventDefault(); setRatio(0.15); }
      else if (e.key === 'End') { e.preventDefault(); setRatio(0.85); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRatio(0.5); }
    });
  }

  /* ------------------------------------------------------------------ *
   * Theme
   * ------------------------------------------------------------------ */

  var darkMq = null;

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    var resolved = state.theme;
    if (state.theme === 'system') {
      resolved = darkMq && darkMq.matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme-resolved', resolved);
    if (themeLabel) themeLabel.textContent = state.theme.charAt(0).toUpperCase() + state.theme.slice(1);
    if (btnTheme) {
      btnTheme.setAttribute('aria-label', 'Theme: ' + state.theme + ' (click to cycle)');
      btnTheme.setAttribute('data-theme-value', state.theme);
    }
  }

  function setTheme(theme) {
    state.theme = THEMES.indexOf(theme) < 0 ? 'system' : theme;
    applyTheme();
    saveSoon();
  }

  function cycleTheme() {
    setTheme(THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]);
  }

  function watchSystemTheme() {
    if (!window.matchMedia) return;
    try {
      darkMq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch (e) { darkMq = null; return; }
    var onChange = function () { if (state.theme === 'system') applyTheme(); };
    if (darkMq.addEventListener) darkMq.addEventListener('change', onChange);
    else if (darkMq.addListener) darkMq.addListener(onChange);
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  var saveTimer = 0;
  var reportedStorage = false;

  function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, SAVE_DEBOUNCE);
  }

  function persistNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    var ok = lsSet('doc', editor.value);
    lsSet('name', state.name);
    lsSet('dirty', state.dirty ? '1' : '0');
    lsSet('mode', state.mode);
    lsSet('theme', state.theme);
    lsSet('split', state.ratio);
    lsSet('outline', state.outlineOpen ? '1' : '0');
    lsSet('scroll', previewPane ? previewPane.scrollTop : 0);
    lsSet('caret', editor.selectionStart || 0);
    if (!ok && !reportedStorage) {
      reportedStorage = true;
      if (storageFull) {
        /* Sticky, and worded for what actually happened. A 4-second warning
         * that erased itself left the status line looking healthy while a
         * reload was quietly about to lose the whole document — and "this page
         * cannot use local storage" was false: storage works, the buffer is
         * too big for it. Name, mode, theme and scroll are all small enough to
         * have persisted above, so only the text is at risk. */
        var mb = Math.round((editor.value.length / 1048576) * 10) / 10;
        say('Too large to autosave (' + mb + ' MB) — a reload will lose this text. ' +
            'Save it with ' + MOD_LABEL + 'S.', 'warn', true);
      } else {
        say('Autosave is off (this page cannot use local storage).', 'warn', true);
      }
    } else if (ok && reportedStorage) {
      /* It fits again — stop claiming otherwise. */
      reportedStorage = false;
      storageFull = false;
      say('');
    }
  }

  function restore() {
    var theme = lsGet('theme', 'system');
    state.theme = THEMES.indexOf(theme) < 0 ? 'system' : theme;

    var mode = lsGet('mode', 'split');
    state.mode = MODES.indexOf(mode) < 0 ? 'split' : mode;

    var ratio = parseFloat(lsGet('split', '0.5'));
    state.ratio = isFinite(ratio) ? clamp(ratio, 0.15, 0.85) : 0.5;

    state.outlineOpen = lsGet('outline', '0') === '1';
    state.name = lsGet('name', 'untitled.md') || 'untitled.md';
    state.dirty = lsGet('dirty', '0') === '1';

    /* An autosaved buffer wins, even an empty one — the user may have emptied
     * it on purpose and would not thank us for putting the demo back. Only a
     * genuinely absent key falls through to the shipped document. */
    var doc = lsGet('doc', null);
    var fresh = typeof doc !== 'string';
    if (!fresh) editor.value = doc;
    else if (typeof window.DEFAULT_DOC === 'string' && window.DEFAULT_DOC) {
      editor.value = window.DEFAULT_DOC;
      if (lsGet('name', null) === null) state.name = 'demo.md';
      state.dirty = false;
    }

    return {
      scroll: parseFloat(lsGet('scroll', '0')) || 0,
      caret: parseInt(lsGet('caret', '0'), 10) || 0
    };
  }

  /* ------------------------------------------------------------------ *
   * Undo-safe editing primitives
   * ------------------------------------------------------------------ */

  /* Never reassign editor.value for an edit — that wipes the native undo
   * stack. execCommand keeps it; setRangeText is the fallback. */
  function editRange(start, end, text, selStart, selEnd) {
    if (state.mode === 'read') setMode('split');
    try { editor.focus(); } catch (e) { /* ignore */ }
    editor.setSelectionRange(start, end);
    var ok = false;
    try {
      ok = text === ''
        ? document.execCommand('delete')
        : document.execCommand('insertText', false, text);
    } catch (e) { ok = false; }
    if (!ok) {
      if (typeof editor.setRangeText === 'function') {
        editor.setRangeText(text, start, end, 'end');
      } else {
        var v = editor.value;
        editor.value = v.slice(0, start) + text + v.slice(end);
      }
    }
    if (selStart != null) {
      editor.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
    }
    markEdited();
  }

  function markEdited() {
    setDirty(true);
    scheduleRender();
    saveSoon();
  }

  /* ---- Tab / Shift-Tab ---------------------------------------------- */

  function outdentOne(line) {
    if (line.charAt(0) === '\t') return line.slice(1);
    if (line.slice(0, 2) === INDENT) return line.slice(2);
    if (line.charAt(0) === ' ') return line.slice(1);
    return line;
  }

  /* Returns true when the key was consumed (something was indented or
   * outdented). A false lets the keydown handler fall through to the browser,
   * which is the only escape hatch a Shift+Tab on an unindented line has. */
  function handleTab(shift) {
    var v = editor.value;
    var s = editor.selectionStart;
    var e = editor.selectionEnd;
    var spansLines = v.slice(s, e).indexOf('\n') >= 0;

    if (!spansLines) {
      if (!shift) { editRange(s, e, INDENT, s + INDENT.length); return true; }
      var ls = v.lastIndexOf('\n', s - 1) + 1;
      var head = v.slice(ls, ls + 2);
      var cut = 0;
      if (v.charAt(ls) === '\t') cut = 1;
      else if (head === INDENT) cut = 2;
      else if (v.charAt(ls) === ' ') cut = 1;
      if (!cut) return false;
      editRange(ls, ls + cut, '', Math.max(ls, s - cut), Math.max(ls, e - cut));
      return true;
    }

    var endAdj = (e > s && v.charAt(e - 1) === '\n') ? e - 1 : e;
    var blockStart = v.lastIndexOf('\n', s - 1) + 1;
    var blockEnd = v.indexOf('\n', endAdj);
    if (blockEnd === -1) blockEnd = v.length;

    var block = v.slice(blockStart, blockEnd);
    var out = block.split('\n').map(function (line) {
      if (shift) return outdentOne(line);
      return line === '' ? line : INDENT + line;
    }).join('\n');

    /* A plain Tab always claims the key even when the selection is all blank
     * lines; only Shift+Tab is allowed to fall through to focus movement. */
    if (out === block) return !shift;
    editRange(blockStart, blockEnd, out, blockStart, blockStart + out.length);
    return true;
  }

  /* ---- Enter: continue lists and blockquotes -------------------------- */

  var RE_UL = /^([ \t]*)([-*+])([ \t]+)(\[[ xX]\][ \t]+)?/;
  var RE_OL = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(\[[ xX]\][ \t]+)?/;
  var RE_BQ = /^([ \t]*)((?:>[ \t]?)+)/;

  function markerInfo(line) {
    var quote = '';
    var rest = line;
    var q = RE_BQ.exec(line);
    if (q) { quote = q[1] + q[2]; rest = line.slice(q[0].length); }

    var m = RE_UL.exec(rest);
    if (m) {
      return {
        kind: 'ul', quote: quote, indent: m[1], marker: m[2], space: m[3],
        task: !!m[4], len: quote.length + m[0].length
      };
    }
    m = RE_OL.exec(rest);
    if (m) {
      return {
        kind: 'ol', quote: quote, indent: m[1], num: parseInt(m[2], 10),
        delim: m[3], space: m[4], task: !!m[5], len: quote.length + m[0].length
      };
    }
    if (quote) return { kind: 'bq', quote: quote, indent: '', len: quote.length };
    return null;
  }

  function nextPrefix(info) {
    if (info.kind === 'ul') {
      return info.quote + info.indent + info.marker + info.space + (info.task ? '[ ] ' : '');
    }
    if (info.kind === 'ol') {
      return info.quote + info.indent + (info.num + 1) + info.delim + info.space +
        (info.task ? '[ ] ' : '');
    }
    return info.quote;
  }

  /* Rebuild the ordered-list lines that follow the caret's line so the numbers
   * stay consecutive after an insertion. Returns the text (each line prefixed
   * with its own '\n') and the absolute offset it replaces up to. */
  function renumberTail(v, from, info) {
    var out = [];
    var pos = from;
    var n = info.num + 2;
    var end = from;
    while (pos < v.length && v.charAt(pos) === '\n') {
      var s = pos + 1;
      var e = v.indexOf('\n', s);
      if (e === -1) e = v.length;
      var line = v.slice(s, e);
      var mi = markerInfo(line);
      if (mi && mi.kind === 'ol' && mi.quote === info.quote && mi.indent === info.indent) {
        out.push('\n' + mi.quote + mi.indent + n + mi.delim + mi.space + line.slice(mi.len));
        n += 1;
        end = e;
        pos = e;
        continue;
      }
      var lead = /^[ \t]*/.exec(line)[0].length;
      if (line.replace(/\s+$/, '') !== '' && lead > info.indent.length + info.quote.length) {
        out.push('\n' + line); // deeper sublist or a continuation line: keep verbatim
        end = e;
        pos = e;
        continue;
      }
      break;
    }
    return { end: end, text: out.join('') };
  }

  function handleEnter() {
    if (editor.selectionStart !== editor.selectionEnd) return false;
    var v = editor.value;
    var caret = editor.selectionStart;
    var ls = v.lastIndexOf('\n', caret - 1) + 1;
    var le = v.indexOf('\n', caret);
    if (le === -1) le = v.length;

    var line = v.slice(ls, le);
    var info = markerInfo(line);
    if (!info) return false;
    if (caret < ls + info.len) return false; // caret sits inside the marker itself

    var body = line.slice(info.len);
    if (body.replace(/\s+/g, '') === '') {
      editRange(ls, le, '', ls, ls); // empty item: drop the marker, don't continue
      return true;
    }

    var prefix = nextPrefix(info);
    var after = v.slice(caret, le);
    var replaceEnd = le;
    var tail = '';
    if (info.kind === 'ol') {
      var scan = renumberTail(v, le, info);
      replaceEnd = scan.end;
      tail = scan.text;
    }
    var caretAfter = caret + 1 + prefix.length;
    editRange(caret, replaceEnd, '\n' + prefix + after + tail, caretAfter);
    return true;
  }

  /* ---- Bold / italic / link ------------------------------------------ */

  function wrapSelection(before, after, placeholder) {
    var v = editor.value;
    var s = editor.selectionStart;
    var e = editor.selectionEnd;
    var sel = v.slice(s, e);
    var bl = before.length;
    var al = after.length;

    /* Toggling italic must not eat the outer pair of a **bold** run. */
    var bolded = before === '*' && sel.length >= 4 &&
      sel.slice(0, 2) === '**' && sel.slice(-2) === '**';

    if (!bolded && sel.length >= bl + al &&
        sel.slice(0, bl) === before && sel.slice(sel.length - al) === after) {
      var inner = sel.slice(bl, sel.length - al);
      editRange(s, e, inner, s, s + inner.length);
      return;
    }
    if (s >= bl && v.slice(s - bl, s) === before && v.slice(e, e + al) === after) {
      editRange(s - bl, e + al, sel, s - bl, s - bl + sel.length);
      return;
    }
    if (s === e) {
      var ph = placeholder || '';
      editRange(s, e, before + ph + after, s + bl, s + bl + ph.length);
      return;
    }
    editRange(s, e, before + sel + after, s + bl, s + bl + sel.length);
  }

  function toggleLink() {
    var v = editor.value;
    var s = editor.selectionStart;
    var e = editor.selectionEnd;
    var sel = v.slice(s, e);

    var m = /^\[([^\]]*)\]\(([^()\s]*)(?:\s+"[^"]*")?\)$/.exec(sel);
    if (m) { editRange(s, e, m[1], s, s + m[1].length); return; }

    if (s === e) { editRange(s, e, '[]()', s + 1, s + 1); return; }

    if (/^(https?:\/\/|mailto:|www\.)\S*$/i.test(sel)) {
      editRange(s, e, '[](' + sel + ')', s + 1, s + 1);
      return;
    }
    var text = '[' + sel + '](url)';
    editRange(s, e, text, s + sel.length + 3, s + sel.length + 6);
  }

  /* ------------------------------------------------------------------ *
   * Files: open, save, new
   * ------------------------------------------------------------------ */

  var TEXT_EXT = /\.(md|markdown|mdown|mkd|mdx|txt|text|rmd|qmd)$/i;
  var MAX_BYTES = 20 * 1024 * 1024;

  function looksTextual(file) {
    var type = (file.type || '').toLowerCase();
    if (TEXT_EXT.test(file.name || '')) return true;
    if (type.indexOf('text/') === 0) return true;
    if (type === 'application/json' || type === 'application/x-markdown') return true;
    return type === '';
  }

  function setText(text, name) {
    /* The one place editor.value is assigned: loading a document, not editing
     * one. Undo history is meant to reset here. */
    editor.value = text == null ? '' : String(text);
    if (name !== undefined && name !== null) {
      setName(name);
      setDirty(false);
    } else {
      setDirty(true);
    }
    try { editor.setSelectionRange(0, 0); } catch (e) { /* ignore */ }
    /* Both panes, not just the preview: a freshly opened file must start at its
     * first line even when the textarea was scrolled down reading the last one. */
    editor.scrollTop = 0;
    if (previewPane) previewPane.scrollTop = 0;
    renderNow();
    persistNow();
  }

  function acceptText(text, name) {
    /* An extension can lie. A NUL byte in the first few KB means binary, and
     * loading that would fill the editor with noise. */
    if (text.slice(0, 4096).indexOf('\u0000') >= 0) {
      say('"' + name + '" looks like a binary file — not loading it.', 'error');
      return;
    }
    setText(text.replace(/\r\n?/g, '\n'), name);
    say('Opened ' + name);
  }

  function loadFile(file) {
    if (!file) return;
    if (!looksTextual(file)) {
      say('"' + file.name + '" is not a text file — open a .md or .txt.', 'error');
      return;
    }
    if (file.size > MAX_BYTES) {
      say('"' + file.name + '" is too large (' + Math.round(file.size / 1048576) + ' MB).', 'error');
      return;
    }
    var name = file.name || 'untitled.md';
    var fail = function (err) {
      say('Could not read ' + name + (err && err.message ? ': ' + err.message : ''), 'error');
    };
    if (typeof file.text === 'function') {
      file.text().then(function (t) { acceptText(t, name); }, function () { readLegacy(file, name, fail); });
      return;
    }
    readLegacy(file, name, fail);
  }

  function readLegacy(file, name, fail) {
    try {
      var fr = new FileReader();
      fr.onload = function () { acceptText(String(fr.result || ''), name); };
      fr.onerror = function () { fail(fr.error); };
      fr.readAsText(file);
    } catch (e) { fail(e); }
  }

  function openFile() {
    if (fileInput) fileInput.click();
  }

  function newDocument() {
    if (state.dirty && editor.value !== '') {
      var ok = true;
      try { ok = window.confirm('Discard unsaved changes to ' + state.name + '?'); } catch (e) { ok = true; }
      if (!ok) return;
    }
    setText('', 'untitled.md');
    say('New document');
    try { editor.focus(); } catch (e) { /* ignore */ }
  }

  function currentFilename() {
    var n = (state.name || '').replace(/^\s+|\s+$/g, '') || 'untitled.md';
    if (!/\.[A-Za-z0-9]{1,8}$/.test(n)) n += '.md';
    return n;
  }

  function downloadBlob(blob, name) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 1000);
      setDirty(false);
      persistNow();
      say('Saved ' + name);
    } catch (e) {
      say('Could not save: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  function saveFile() {
    var name = currentFilename();
    var blob;
    try {
      blob = new Blob([editor.value], { type: 'text/markdown;charset=utf-8' });
    } catch (e) {
      say('Could not save: ' + (e && e.message ? e.message : e), 'error');
      return;
    }

    /* showSaveFilePicker is absent on file:// in Safari, and on a file:// page
     * Chromium *rejects* it with AbortError — the very error name a real user
     * cancel produces. Silent-on-cancel therefore swallowed the whole feature
     * on the one deployment target this artefact is built for: Save was a
     * button that did nothing, with no message and no console error. Two
     * guards, because either alone is guessable: never ask the picker from
     * file://, and treat a rejection that arrives faster than a human could
     * click Cancel as an environment refusal rather than a cancel. */
    var fileUrl = false;
    try { fileUrl = window.location.protocol === 'file:'; } catch (e) { fileUrl = false; }
    if (!fileUrl && typeof window.showSaveFilePicker === 'function') {
      var askedAt = Date.now();
      var picker;
      try {
        picker = window.showSaveFilePicker({
          suggestedName: name,
          types: [{
            description: 'Markdown',
            accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.txt'] }
          }]
        });
      } catch (e) { picker = null; }
      if (picker && typeof picker.then === 'function') {
        picker.then(function (handle) {
          return handle.createWritable().then(function (w) {
            return Promise.resolve(w.write(blob)).then(function () { return w.close(); });
          }).then(function () {
            setName(handle.name || name);
            setDirty(false);
            persistNow();
            say('Saved ' + currentFilename());
          });
        }).catch(function (err) {
          var tooFast = (Date.now() - askedAt) < 250;
          if (!tooFast && err && err.name === 'AbortError') return; // user cancelled
          downloadBlob(blob, name);
        });
        return;
      }
    }
    downloadBlob(blob, name);
  }

  /* ------------------------------------------------------------------ *
   * Clipboard
   * ------------------------------------------------------------------ */

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-2000px';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    var prev = document.activeElement;
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    if (prev && typeof prev.focus === 'function') {
      try { prev.focus(); } catch (e) { /* ignore */ }
    }
    return ok;
  }

  function copyText(text) {
    var p = null;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        p = navigator.clipboard.writeText(text);
      }
    } catch (e) { p = null; }
    if (!p || typeof p.then !== 'function') return Promise.resolve(legacyCopy(text));
    return p.then(function () { return true; }, function () { return legacyCopy(text); });
  }

  function copyHtml() {
    var html = lastHtml || preview.innerHTML;
    copyText(html).then(function (ok) {
      if (ok) say('Rendered HTML copied (' + group(html.length) + ' chars)');
      else say('Could not reach the clipboard — this browser blocks it here.', 'error');
    });
  }

  /* ------------------------------------------------------------------ *
   * Print
   * ------------------------------------------------------------------ */

  /* No `is-printing` class: app.css's @media print block already hides the
   * chrome and prints the reader in every mode, and a hook nothing styles is
   * only a trap for whoever reads the JS next. */
  function doPrint() {
    try { window.print(); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Scroll sync — one driver at a time, released by a timestamp
   * ------------------------------------------------------------------ */

  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  var driver = null;
  var driverUntil = 0;
  var syncRaf = 0;

  function scrollRatio(el) {
    var max = el.scrollHeight - el.clientHeight;
    return max > 0 ? el.scrollTop / max : 0;
  }

  function applyScrollRatio(el, r) {
    var max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = Math.round(r * max);
  }

  /* Whoever moved first owns the sync for SYNC_LOCKOUT ms; the pane we move in
   * response reports its own scroll event and is filtered out by that check.
   * The claim expires on a clock, so there is no flag left set by mistake. */
  function queueSync(who) {
    var t = now();
    if (t < muteSyncUntil) return;
    if (driver && driver !== who && t < driverUntil) return; // this pane is the passenger
    driver = who;
    driverUntil = t + SYNC_LOCKOUT;
    if (syncRaf) return;
    syncRaf = requestAnimationFrame(function () {
      syncRaf = 0;
      if (who === 'preview') { highlightOutline(); saveSoon(); }
      if (state.mode !== 'split' || !previewPane) return;
      driverUntil = now() + SYNC_LOCKOUT;
      if (who === 'editor') applyScrollRatio(previewPane, scrollRatio(editor));
      else applyScrollRatio(editor, scrollRatio(previewPane));
    });
  }

  /* ------------------------------------------------------------------ *
   * Drag and drop
   * ------------------------------------------------------------------ */

  function showDrop(on) {
    if (drop) drop.hidden = !on;
  }

  function eventHasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) {
      for (var i = 0; i < dt.types.length; i++) {
        if (dt.types[i] === 'Files') return true;
      }
      return false;
    }
    return true;
  }

  function wireDragDrop() {
    var hideTimer = 0;

    function ping() {
      showDrop(true);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { hideTimer = 0; showDrop(false); }, 300);
    }

    window.addEventListener('dragover', function (e) {
      if (!eventHasFiles(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ }
      ping();
    });

    window.addEventListener('dragleave', function (e) {
      if (e.relatedTarget) return;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
      showDrop(false);
    });

    window.addEventListener('drop', function (e) {
      if (!eventHasFiles(e)) return;
      e.preventDefault();
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
      showDrop(false);
      var files = e.dataTransfer.files;
      if (files && files.length) loadFile(files[0]);
    });

    document.addEventListener('paste', function (e) {
      var dt = e.clipboardData;
      if (!dt || !dt.files || !dt.files.length) return;
      var text = '';
      try { text = dt.getData('text/plain') || ''; } catch (err) { text = ''; }
      if (text) return; // a normal text paste that happens to carry a file too
      e.preventDefault();
      loadFile(dt.files[0]);
    });
  }

  /* ------------------------------------------------------------------ *
   * Keyboard
   * ------------------------------------------------------------------ */

  /* One table drives both the bindings and the help sheet, so the sheet
   * cannot drift. Entries without `run` are handled elsewhere (Tab/Enter in
   * the editor, Esc by <dialog>) and are listed for documentation. */
  var SHORTCUTS = [
    { mod: true, key: 'o', label: 'Open a markdown file', run: function () { openFile(); } },
    { mod: true, key: 's', label: 'Save', run: function () { saveFile(); } },
    { mod: true, key: 'p', label: 'Print / export PDF', run: function () { doPrint(); } },
    { mod: true, key: '\\', label: 'Cycle edit / split / read', run: function () { cycleMode(); } },
    { mod: true, key: '/', label: 'Cycle light / dark / system', run: function () { cycleTheme(); } },
    { mod: true, shift: true, key: 'o', label: 'Toggle the outline', run: function () { setOutlineOpen(!state.outlineOpen); } },
    { mod: true, key: 'b', label: 'Bold the selection', run: function () { wrapSelection('**', '**', 'bold'); } },
    { mod: true, key: 'i', label: 'Italicise the selection', run: function () { wrapSelection('*', '*', 'italic'); } },
    { mod: true, key: 'k', label: 'Link the selection', run: function () { toggleLink(); } },
    { key: '?', anyShift: true, noEditor: true, label: 'Show this help', run: function () { openHelp(); } },
    { display: 'Tab', label: 'Indent line(s) / insert two spaces' },
    { display: SHIFT_LABEL + ' Tab', label: 'Outdent line(s)' },
    { display: 'Enter', label: 'Continue a list, task or blockquote' },
    { display: 'Esc', label: 'Close this dialog' },
    { display: 'Esc ' + SHIFT_LABEL + ' Tab', label: 'Release Tab, then move focus out of the editor' }
  ];

  function keyLabel(sc) {
    if (sc.display) return sc.display;
    var parts = [];
    if (sc.mod) parts.push(MOD_LABEL);
    if (sc.shift) parts.push(SHIFT_LABEL);
    if (sc.alt) parts.push(IS_MAC ? '⌥' : 'Alt');
    var k = sc.key;
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join(IS_MAC ? ' ' : '+');
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
  }

  function matchesShortcut(sc, e, target) {
    if (!sc.run) return false;
    var mod = IS_MAC ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
    if (!!sc.mod !== !!mod) return false;
    if (!sc.anyShift && !!sc.shift !== !!e.shiftKey) return false;
    if (!!sc.alt !== !!e.altKey) return false;
    var key = e.key || '';
    if (key.toLowerCase() !== sc.key.toLowerCase()) return false;
    if (sc.noEditor && isTypingTarget(target)) return false;
    return true;
  }

  function helpIsOpen() {
    if (!help) return false;
    if (help.open) return true;
    try { return !!(help.matches && help.matches(':modal')); } catch (e) { return false; }
  }

  /* WCAG 2.1.2. Tab must keep inserting two spaces — that is contract item 8 —
   * and a keyboard-only user must still be able to leave the textarea. Escape
   * arms the release: the next Tab moves focus instead of indenting, and any
   * other key re-arms indentation, so the escape hatch costs nothing to anyone
   * typing. Shift+Tab on a line with nothing left to outdent is let through as
   * well, rather than being swallowed by a preventDefault that edited nothing. */
  var tabReleased = false;

  function onKeydown(e) {
    if (e.defaultPrevented) return;
    var target = e.target;

    /* A modal dialog owns the keyboard. A keydown inside <dialog> still bubbles
     * to document, so every shortcut used to fire behind the help sheet: ⌘\
     * switched mode, ⌘/ repainted the theme and ⌘S wrote a file — all behind a
     * sheet whose entire content is a list of those shortcuts. Escape stays
     * live because it is how the sheet closes. */
    if (e.key !== 'Escape' && helpIsOpen()) return;

    for (var i = 0; i < SHORTCUTS.length; i++) {
      if (matchesShortcut(SHORTCUTS[i], e, target)) {
        e.preventDefault();
        SHORTCUTS[i].run();
        return;
      }
    }

    if (e.key === 'Escape' && drop && !drop.hidden) { showDrop(false); return; }
    if (target !== editor) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') {
      if (!tabReleased) {
        tabReleased = true;
        say('Tab moves focus out of the editor now. Any other key resumes indenting.');
      }
      return;
    }
    if (e.key === 'Tab') {
      if (tabReleased) { tabReleased = false; return; }   // let the browser move focus
      if (handleTab(e.shiftKey)) e.preventDefault();
      return;
    }
    tabReleased = false;
    if (e.key === 'Enter' && !e.shiftKey) {
      if (handleEnter()) e.preventDefault();
    }
  }

  function buildHelpTable() {
    if (!helpTable) return;
    helpTable.textContent = '';
    var body = document.createElement('tbody');
    for (var i = 0; i < SHORTCUTS.length; i++) {
      var sc = SHORTCUTS[i];
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.scope = 'row';
      var kbd = document.createElement('kbd');
      kbd.textContent = keyLabel(sc);
      th.appendChild(kbd);
      var td = document.createElement('td');
      td.textContent = sc.label;
      tr.appendChild(th);
      tr.appendChild(td);
      body.appendChild(tr);
    }
    helpTable.appendChild(body);
  }

  function openHelp() {
    if (!help) return;
    try {
      if (typeof help.showModal === 'function') help.showModal();
      else help.setAttribute('open', '');
    } catch (e) {
      help.setAttribute('open', '');
    }
  }

  function closeHelp() {
    if (!help) return;
    try {
      if (typeof help.close === 'function') help.close();
      else help.removeAttribute('open');
    } catch (e) {
      help.removeAttribute('open');
    }
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function on(el, type, fn) {
    if (el) el.addEventListener(type, fn);
  }

  function wire() {
    on(btnOpen, 'click', function () { openFile(); });
    on(btnSave, 'click', function () { saveFile(); });
    on(btnNew, 'click', function () { newDocument(); });
    on(btnCopy, 'click', function () { copyHtml(); });
    on(btnPrint, 'click', function () { doPrint(); });
    on(btnOutline, 'click', function () { setOutlineOpen(!state.outlineOpen); });
    on(btnTheme, 'click', function () { cycleTheme(); });
    on(btnHelp, 'click', function () { openHelp(); });
    on(modeEdit, 'click', function () { setMode('edit'); });
    on(modeSplit, 'click', function () { setMode('split'); });
    on(modeRead, 'click', function () { setMode('read'); });

    on(fileInput, 'change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (f) loadFile(f);
      fileInput.value = '';
    });

    on(editor, 'input', function () { markEdited(); });
    on(editor, 'scroll', function () { queueSync('editor'); });
    /* read mode's display:none is allowed to reset the textarea's selection, so
     * the caret is remembered while the pane is still on screen. */
    on(editor, 'keyup', function () { lastCaret = editor.selectionStart || 0; });
    on(editor, 'click', function () { lastCaret = editor.selectionStart || 0; });
    on(previewPane, 'scroll', function () { queueSync('preview'); });

    on(toc, 'click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[data-heading]') : null;
      if (!a) return;
      e.preventDefault();
      gotoHeading(a.getAttribute('data-heading'));
    });

    on(preview, 'click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var copyBtn = t.closest('.md-copy');
      if (copyBtn) {
        e.preventDefault();
        var wrap = copyBtn.closest('.md-code-wrap');
        var code = wrap ? wrap.querySelector('pre') : null;
        var text = code ? code.textContent : '';
        copyText(text).then(function (ok) {
          copyBtn.textContent = ok ? 'Copied' : 'Failed';
          if (ok) copyBtn.classList.add('is-done');
          setTimeout(function () {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('is-done');
          }, 1200);
          say(ok ? 'Code block copied' : 'Could not reach the clipboard here.', ok ? '' : 'error');
        });
        return;
      }

      var link = t.closest('a[href^="#"]');
      if (link) {
        var id = decodeURIComponent((link.getAttribute('href') || '').slice(1));
        var el = headingById(id) || preview.querySelector('[id="' + id.replace(/"/g, '\\"') + '"]');
        if (el) {
          e.preventDefault();
          scrollPreviewTo(el);
          highlightOutline();
        }
      }
    });

    on(help, 'click', function (e) {
      if (e.target === help) { closeHelp(); return; }
      if (e.target && e.target.closest && e.target.closest('[data-close]')) closeHelp();
    });

    on(window, 'pagehide', function () { persistNow(); });
    on(document, 'visibilitychange', function () {
      if (document.visibilityState === 'hidden') persistNow();
    });

    document.addEventListener('keydown', onKeydown);

    wireGutter();
    wireDragDrop();
  }

  /* ------------------------------------------------------------------ *
   * Startup
   * ------------------------------------------------------------------ */

  function reportMissing() {
    missingParts = [];
    if (!hasMD()) missingParts.push('markdown renderer');
    if (!(window.TeX && typeof window.TeX.toMathML === 'function')) missingParts.push('math renderer');
    if (!missingParts.length) return;
    var msg = missingParts.join(' and ') + ' unavailable';
    msg += hasMD()
      ? ' — formulas show as plain code.'
      : ' — showing the source as plain text.';
    say(msg, 'warn', true);
  }

  function boot() {
    grabElements();

    window.__mdstudio = {
      render: renderNow,
      setText: setText,
      getState: getState
    };

    watchSystemTheme();
    var restored = restore();

    applyTheme();
    setMode(state.mode);
    setOutlineOpen(state.outlineOpen);
    paintName();
    buildHelpTable();
    wire();

    reportMissing();
    renderNow();

    if (previewPane && restored.scroll) {
      muteSyncUntil = now() + 200;
      previewPane.scrollTop = restored.scroll;
    }
    /* Always place the caret, never `if (restored.caret)`. Assigning
     * editor.value leaves the caret at the END of the buffer, and a caret of 0
     * is falsy — so a cold load skipped this branch and the first time focus
     * reached the editor (⌘\ twice, or any setMode refocus) the browser
     * scrolled the caret into view and threw the reader to the last line of the
     * document. Scroll has to be reset with it: the caret move alone does not
     * pull an unfocused textarea back up. */
    lastCaret = restored.caret || 0;
    try { editor.setSelectionRange(lastCaret, lastCaret); } catch (e) { /* ignore */ }
    if (!restored.caret && !restored.scroll) editor.scrollTop = 0;
    /* Everything above ran with setMode's refocus disarmed, so a cold load
     * leaves focus where the browser put it and the Tab walk still starts at
     * the toolbar. */
    booted = true;
    if (storageBroken && !reportedStorage) {
      reportedStorage = true;
      say('Local storage is unavailable here — your work is not being autosaved.', 'warn', true);
    }
  }

  function getState() {
    return {
      text: editor ? editor.value : '',
      name: state.name,
      dirty: state.dirty,
      mode: state.mode,
      theme: state.theme,
      ratio: state.ratio,
      outlineOpen: state.outlineOpen,
      html: lastHtml,
      headings: lastOutline.slice(),
      stats: statsOf(editor ? editor.value : ''),
      missing: missingParts.slice(),
      storage: !storageBroken
    };
  }

  function start() {
    try {
      boot();
    } catch (err) {
      /* Last resort: the shell failed, so at minimum show the text and say
       * why. Nothing below may assume any earlier step ran. */
      try {
        var ed = document.getElementById('editor');
        var pv = document.getElementById('preview');
        var msg = document.getElementById('status-msg');
        if (pv && ed) {
          pv.innerHTML = '<pre class="md-fallback"><code>' + escapeHtml(ed.value) + '</code></pre>';
        }
        if (msg) {
          msg.textContent = 'Editor failed to start: ' +
            (err && err.message ? err.message : String(err)) + ' — the source above is intact.';
          msg.setAttribute('data-kind', 'error');
        }
        if (!window.__mdstudio) {
          window.__mdstudio = {
            render: function () {},
            setText: function (t) { if (ed) ed.value = t == null ? '' : String(t); },
            getState: function () { return { text: ed ? ed.value : '', error: String(err) }; }
          };
        }
      } catch (e2) { /* nothing left to do */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
