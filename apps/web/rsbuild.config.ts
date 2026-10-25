import { defineConfig } from "@rsbuild/core";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { browserThemeBootstrap, THEME_BACKGROUNDS } from "./src/browserTheme";
import { createRequire } from "node:module";
import path from "node:path";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginPWA } from "rsbuild-plugin-pwa";
import { PWA_NAVIGATION_DENYLIST } from "./src/pwa-policy";
import { writeDependencyNotices } from "../../packaging/third-party-notices.mjs";
import { fileURLToPath } from "node:url";

const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const pwaRequire = createRequire(createRequire(import.meta.url).resolve("rsbuild-plugin-pwa"));
const workboxRequire = createRequire(pwaRequire.resolve("workbox-build/package.json"));
const browserNotices = writeDependencyNotices(
  [
    fileURLToPath(new URL("./package.json", import.meta.url)),
    ...["window", "core", "precaching", "routing", "strategies", "expiration", "cacheable-response"]
      .map(name => workboxRequire.resolve(`workbox-${name}/package.json`)),
  ],
  fileURLToPath(new URL("../../node_modules/.cache/ponderosa-browser-notices", import.meta.url)),
  // PDF.js's Node-only canvas dependency is not part of this browser build.
  // The PWA plugin is build tooling; retain its generated Workbox runtime below.
  ["@napi-rs/canvas", "rsbuild-plugin-pwa"],
);

const themeScript = browserThemeBootstrap();
const themeInitName = `theme-init.${createHash("sha256").update(themeScript).digest("hex").slice(0,12)}.js`;
const themeInitDirectory = fileURLToPath(new URL("../../node_modules/.cache/ponderosa-theme", import.meta.url));
mkdirSync(themeInitDirectory, { recursive: true });
writeFileSync(path.join(themeInitDirectory, themeInitName), themeScript);

export default defineConfig({
  plugins: [
    pluginReact(),
    pluginPWA({
      htmlTags: {
        icon: [
          { href: "/icons/app-icon.png", type: "image/png", sizes: "512x512" },
          { href: "/icons/maskable-icon.png", type: "image/png", sizes: "512x512" },
        ],
        appleTouchIcon: {
          href: "/icons/app-icon.png",
          sizes: "512x512",
        },
      },
      webAppManifest: {
        filename: "manifest.webmanifest",
        content: {
          name: "Ponderosa",
          short_name: "Ponderosa",
          description: "Self-hosted coding-agent workbench",
          start_url: "/",
          scope: "/",
          display: "standalone",
          orientation: "any",
          background_color: THEME_BACKGROUNDS.dark,
          theme_color: THEME_BACKGROUNDS.dark,
          icons: [
            {
              src: "/icons/app-icon.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/maskable-icon.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
      },
      registerSw: {
        type: "script",
        defer: true,
        features: {
          autoSkipWaiting: true,
          // Reloads are fenced by deployed build and browser tab in
          // serviceWorkerReload.ts. The generated unconditional handler can
          // turn repeated controller changes into a refresh loop.
          autoReloadPage: false,
        },
      },
      sw: {
        mode: "generateSw",
        includeWebAppManifestIcons: true,
        include: ["**/*.{js,css,html,webmanifest,svg,png}", "notices/**"],
        workboxOptions: {
          cleanupOutdatedCaches: true,
          navigateFallback: "/index.html",
          navigateFallbackDenylist: PWA_NAVIGATION_DENYLIST,
          importScripts: ["/push-handler.js"],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          // Keep the install transaction small. Lazy route chunks are immutable
          // and can be populated on demand instead of delaying first use.
          globIgnores: ["static/js/**", "static/pdfjs/**", "notices/sources/**"],
          runtimeCaching: [{
            urlPattern: /\/static\/js\//u,
            handler: "CacheFirst",
            options: {
              cacheName: "ponderosa-javascript",
              expiration: { maxEntries: 80, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          }],
        },
      },
    }),
  ],
  source: {
    // This is a browser build: prune Node-only dependency branches and their
    // build-machine import.meta.url paths (including PDF.js canvas loading).
    define: { "typeof process": JSON.stringify("undefined") },
    entry: {
      index: "./src/index.tsx",
    },
  },
  output: {
    copy: [
      { from: path.join(themeInitDirectory, themeInitName), to: themeInitName },
      { from: browserNotices, to: "notices" },
      { from: fileURLToPath(new URL("../../packaging/notices/font-source", import.meta.url)), to: "notices/sources/liberation" },
      { from: fileURLToPath(new URL("../../packaging/notices/mpl-source", import.meta.url)), to: "notices/sources/mpl" },
      { from: fileURLToPath(new URL("../../packaging/notices/SOURCE-REFERENCES.md", import.meta.url)), to: "notices/SOURCE-REFERENCES.md" },
      // PDF assets load lazily. Versioned paths prevent retained PWAs from
      // mixing the library with another font/decoder version.
      { from: path.join(pdfjsRoot, "cmaps"), to: "static/pdfjs/6.3.289/cmaps" },
      { from: path.join(pdfjsRoot, "standard_fonts"), to: "static/pdfjs/6.3.289/standard_fonts" },
      { from: path.join(pdfjsRoot, "wasm", "openjpeg_nowasm_fallback.js"), to: "static/pdfjs/6.3.289/decoders/openjpeg_nowasm_fallback.js" },
      { from: path.join(pdfjsRoot, "wasm", "jbig2_nowasm_fallback.js"), to: "static/pdfjs/6.3.289/decoders/jbig2_nowasm_fallback.js" },
      ...["LICENSE_JBIG2", "LICENSE_PDFJS_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_OPENJPEG"].map(name => ({
        from: path.join(pdfjsRoot, "wasm", name), to: `static/pdfjs/6.3.289/decoders/${name}`,
      })),
    ],
  },
  html: {
    template: "./index.html",
    templateParameters: { themeBackground: THEME_BACKGROUNDS.dark, themeInitPath: `/${themeInitName}` },
    title: "Ponderosa",
    meta: {
      viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
      description: "Self-hosted coding-agent workbench",
      // Precached HTML retains response headers. Refresh its revision whenever
      // server security hooks change, including otherwise server-only CSP fixes.
      "ponderosa-security-revision": createHash("sha256")
        .update(readFileSync(new URL("../server/src/server-request-hooks.ts", import.meta.url)))
        .digest("hex"),
    },
  },
  server: {
    port: 3000,
  },
});
