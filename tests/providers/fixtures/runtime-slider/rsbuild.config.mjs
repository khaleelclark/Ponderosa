// node apps/web/node_modules/@rsbuild/core/bin/rsbuild.js dev --config tests/providers/fixtures/runtime-slider/rsbuild.config.mjs
// Use native Safari/Chromium input, drag across stops, then inspect touch geometry.
import { fileURLToPath } from "node:url";
import composer from "../../../chats/fixtures/composer/rsbuild.config.mjs";
export default { ...composer,
  source: { entry: { index: fileURLToPath(new URL("./entry.tsx", import.meta.url)) } },
  output: { distPath: { root: fileURLToPath(new URL("../../../../apps/web/node_modules/.cache/runtime-slider-regression", import.meta.url)) } },
  html: { title: "Native runtime slider regression" }, server: { host: "127.0.0.1", port: 4196, strictPort: true, open: false } };
