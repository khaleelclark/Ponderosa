import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginPWA } from "rsbuild-plugin-pwa";

export default defineConfig({
  plugins: [
    pluginReact(),
    pluginPWA({
      htmlTags: {
        themeColor: true,
        icon: [
          { href: "/icons/icon.svg", type: "image/svg+xml", sizes: "any" },
          { href: "/icons/maskable-icon.svg", type: "image/svg+xml", sizes: "any" },
        ],
        appleTouchIcon: {
          href: "/icons/maskable-icon.svg",
          sizes: "any",
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
          orientation: "portrait",
          background_color: "#f6f7f4",
          theme_color: "#245c53",
          icons: [
            {
              src: "/icons/icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
            {
              src: "/icons/maskable-icon.svg",
              sizes: "any",
              type: "image/svg+xml",
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
          autoReloadPage: true,
        },
      },
      sw: {
        mode: "generateSw",
        includeWebAppManifestIcons: true,
        include: ["**/*.{js,css,html,webmanifest,svg}"],
        workboxOptions: {
          cleanupOutdatedCaches: true,
          navigateFallback: "/index.html",
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
    title: "Ponderosa",
    meta: {
      viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
      description: "Self-hosted coding-agent workbench",
    },
  },
  server: {
    port: 3000,
  },
});
