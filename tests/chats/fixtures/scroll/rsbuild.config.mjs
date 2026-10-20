// node apps/web/node_modules/@rsbuild/core/bin/rsbuild.js dev --config tests/chats/fixtures/scroll/rsbuild.config.mjs
// Keep Safari foreground; hidden documents pause frames. Replay, then compare observer operations and frame timings.
import { fileURLToPath } from "node:url";
import base from "../composer/rsbuild.config.mjs";
export default { ...base, source: { entry: { index: fileURLToPath(new URL("./entry.tsx", import.meta.url)) } },
  output: { distPath: { root: fileURLToPath(new URL("../../../../apps/web/node_modules/.cache/scroll-regression", import.meta.url)) } },
  html: { title: "Native chat scroll regression" }, server: { host: "127.0.0.1", port: 4198, strictPort: true, open: false } };
