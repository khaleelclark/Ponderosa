import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const inventory = JSON.parse(readFileSync(new URL('./inventory.json', import.meta.url), 'utf8'));
const owners = new Map([...inventory.tests, ...inventory.helpers].map(entry => [new URL(entry.path, root).href, new URL(entry.moduleBase, root).href]));

// Keep each moved test's existing workspace dependency versions and ESM export
// conditions. This redirects resolution only; it installs no test dependencies.
registerHooks({
  resolve(specifier, context, next) {
    const owner = owners.get(context.parentURL);
    if (owner && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
      return next(specifier, { ...context, parentURL: owner });
    }
    return next(specifier, context);
  },
});
