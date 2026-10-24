// From repository root: node apps/web/node_modules/@rsbuild/core/bin/rsbuild.js dev --config tests/chats/fixtures/composer/rsbuild.config.mjs
// Open the printed loopback URL; repeat ?mode=authored/default/required, &change=validity and &theme=light.
// Add &caretRepair to reproduce focus repair during native input: Inspect must
// retain "thanks" and the first input's native caret offset (control: "hankst").
// At the same viewport compare ?text=, ?text=hello, and ?text=%23Bryce-Canyon%20hello.
// Inspect must report equal single-line editor/paragraph heights; wrapped lines must still grow.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const web = fileURLToPath(new URL('../../../../apps/web/', import.meta.url));
const require = createRequire(web + 'package.json');
const { pluginReact } = require('@rsbuild/plugin-react');
export default { plugins: [pluginReact()], source: { entry: { index: fileURLToPath(new URL('./entry.tsx', import.meta.url)) } },
  tools: { rspack: { resolve: { modules: [web + 'node_modules', 'node_modules'], extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } } } },
  output: { distPath: { root: web + 'node_modules/.cache/composer-regression' } },
  html: { title: 'Composer native-input regression' }, server: { host: '127.0.0.1', port: 4195, strictPort: true, open: false } };
