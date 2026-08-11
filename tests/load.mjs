/* tests/load.mjs — run the browser sources under node, without a bundler.
 *
 * src/markdown.js and src/tex.js are classic scripts: each is an IIFE that
 * assigns one global onto `window` (falling back to `globalThis`). There is no
 * `export`, so `import` cannot reach them. This loads them the way the browser
 * does — evaluate the text against a shared global object, then read the
 * globals off it — using node:vm so the test process's own globals stay clean.
 *
 *   import { loadGlobals } from './load.mjs';
 *   const { MD, TeX } = loadGlobals();
 *
 * The context is deliberately minimal: whatever the sources touch at load time
 * and nothing more. If a source starts needing `document`, it has stopped being
 * testable this way and that is worth finding out loudly rather than papering
 * over with a fake DOM.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC = join(HERE, '..', 'src');

/* markdown.js and tex.js are the two the contract names. default_doc.js is
 * optional — it only assigns a string — and is loaded when present so a test
 * can render the shipped default buffer. */
const FILES = ['markdown.js', 'tex.js'];
const OPTIONAL = ['default_doc.js'];

function read(name) {
  return readFileSync(join(SRC, name), 'utf8');
}

/**
 * Evaluate the browser sources in a fresh vm context.
 *
 * @param {{ extra?: string[] }} [opts] extra src/*.js filenames to load after
 *        the required ones, in order.
 * @returns {{ MD: object, TeX: object, DEFAULT_DOC: string|undefined,
 *             window: object, context: object }}
 */
export function loadGlobals(opts) {
  const extra = (opts && opts.extra) || [];

  /* The sources pick `window` first and `globalThis` second. Make them the
   * same object so it does not matter which one a file chose. */
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON
  };
  const context = createContext(sandbox);
  runInContext('globalThis.window = globalThis;', context, { filename: 'shim.js' });

  const names = FILES.slice();
  for (const name of OPTIONAL) {
    try {
      read(name);
      names.push(name);
    } catch {
      /* not generated yet — fine, DEFAULT_DOC comes back undefined */
    }
  }
  for (const name of extra) if (names.indexOf(name) < 0) names.push(name);

  for (const name of names) {
    runInContext(read(name), context, { filename: `src/${name}` });
  }

  const win = runInContext('window', context);
  if (!win.MD || typeof win.MD.render !== 'function') {
    throw new Error('src/markdown.js did not assign window.MD.render');
  }
  if (!win.TeX || typeof win.TeX.toMathML !== 'function') {
    throw new Error('src/tex.js did not assign window.TeX.toMathML');
  }

  return {
    MD: win.MD,
    TeX: win.TeX,
    DEFAULT_DOC: win.DEFAULT_DOC,
    window: win,
    context
  };
}

export default loadGlobals;
