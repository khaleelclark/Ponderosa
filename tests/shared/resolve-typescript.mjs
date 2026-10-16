import { registerHooks } from 'node:module';

// Node's built-in TypeScript transform executes the real modules. Source uses
// bundler-style .js specifiers; map only missing relative imports inside web/src.
const source = new URL('../../apps/web/src/', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL?.startsWith(source) && /^\.\.?\/.+\.js$/u.test(specifier)) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    throw error;
  }
} });
