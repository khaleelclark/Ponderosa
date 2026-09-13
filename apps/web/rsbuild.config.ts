import { defineConfig } from "@rsbuild/core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginPWA } from "rsbuild-plugin-pwa";
import { PWA_NAVIGATION_DENYLIST } from "./src/pwa-policy";

export default defineConfig({
  plugins: [
    pluginReact(),
    pluginPWA({
      htmlTags: {
        themeColor: true,
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
          background_color: "#faf6f3",
          theme_color: "#20382b",
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
        include: ["**/*.{js,css,html,webmanifest,svg,png}"],
        workboxOptions: {
          cleanupOutdatedCaches: true,
          navigateFallback: "/index.html",
          navigateFallbackDenylist: PWA_NAVIGATION_DENYLIST,
          importScripts: ["/push-handler.js"],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          runtimeCaching: [],
        },
      },
    }),
  ],
  source: {
    entry: {
      index: "./src/index.tsx",
    },
  },
  html: {
    template: "./index.html",
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
