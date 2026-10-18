import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
const ts = createRequire(new URL('../../apps/web/package.json', import.meta.url))('typescript');

// Execute the real TSX view using the existing TypeScript dependency and Node
// loader, without a browser shim or a second implementation of its feedback.
const source = new URL('../../apps/web/src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (/^@mui\/material\/(utils|styles)$/.test(specifier)) return next(specifier.replace('/material/', '/material/node/') + '/index.js', context);
    try { return next(specifier, context); }
    catch (error) {
      if (!context.parentURL?.startsWith(source) || !specifier.startsWith('.') ||
          !['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error.code)) throw error;
      const base = specifier.replace(/\.js$/, '');
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        const url = new URL(base + suffix, context.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, context);
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (!url.startsWith(source) || !/\.tsx?$/.test(url)) return next(url, context);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      fileName: fileURLToPath(url),
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText };
  },
});
