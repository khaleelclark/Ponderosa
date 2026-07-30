import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  documentAssetPaths,
  findMacosChromiumExecutable,
  qualifyPersistentPwaUpgrade,
  seedLegacyPwaProfile,
  webAssetPaths,
} from "./persistent-pwa-upgrade.mjs";

test("derives the exact document and public update surfaces portably", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-pwa-surface-"));
  try {
    mkdirSync(path.join(root, "static", "js"), { recursive: true });
    mkdirSync(path.join(root, "static", "css"), { recursive: true });
    writeFileSync(path.join(root, "sw.js"), "fixture");
    writeFileSync(path.join(root, "static", "js", "new.123.js"), "fixture");
    writeFileSync(path.join(root, "static", "css", "new.456.css"), "fixture");
    const html = `<script defer src="/static/js/new.123.js"></script>
<link href="/static/css/new.456.css" rel="stylesheet">`;

    assert.deepEqual(documentAssetPaths(html), [
      "/static/css/new.456.css",
      "/static/js/new.123.js",
    ]);
    assert.deepEqual(webAssetPaths(root), [
      "/static/css/new.456.css",
      "/static/js/new.123.js",
      "/sw.js",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const testBrowser = process.platform === "darwin"
  ? findMacosChromiumExecutable()
  : [
      process.env.PONDEROSA_BROWSER_EXECUTABLE,
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
    ].find((candidate) =>
      candidate && path.isAbsolute(candidate) && existsSync(candidate)
    );

test("replaces a controlling legacy worker in one persistent profile", {
  skip: !testBrowser,
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-pwa-upgrade-"));
  const webDist = path.join(root, "web");
  const profileDir = path.join(root, "profile");
  const port = await availablePort();
  mkdirSync(path.join(webDist, "static", "js"), { recursive: true });
  mkdirSync(path.join(webDist, "static", "css"), { recursive: true });
  writeFileSync(
    path.join(webDist, "index.html"),
    '<script src="/register-sw.js"></script><script src="/static/js/current.123.js"></script><link rel="stylesheet" href="/static/css/current.456.css"><main>current</main>',
  );
  writeFileSync(
    path.join(webDist, "register-sw.js"),
    "navigator.serviceWorker.register('/sw.js');",
  );
  writeFileSync(path.join(webDist, "static", "js", "current.123.js"), "globalThis.__CURRENT_BUILD__=true;");
  writeFileSync(path.join(webDist, "static", "css", "current.456.css"), "body{color:green}");
  writeFileSync(path.join(webDist, "sw.js"), `const CACHE="current-test",URLS=["/index.html","/register-sw.js","/static/js/current.123.js","/static/css/current.456.css"];
self.addEventListener("install",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(key=>caches.delete(key)))).then(()=>caches.open(CACHE)).then(cache=>cache.addAll(URLS))));
self.addEventListener("message",event=>{if(event.data?.type==="SKIP_WAITING")self.skipWaiting()});
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>{const pathname=new URL(event.request.url).pathname;if(event.request.mode==="navigate"&&!pathname.startsWith("/api")&&!pathname.startsWith("/__ponderosa_bootstrap"))event.respondWith(caches.match("/index.html"));});`);
  const publicAssets = new Set(webAssetPaths(webDist));

  let server;
  try {
    await seedLegacyPwaProfile(port, profileDir, testBrowser);
    server = createHttpServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname === "/api/projects") {
        response.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
        return;
      }
      if (url.pathname === "/api/engines") {
        const authenticated = request.headers.cookie?.includes("session=ok");
        response.writeHead(authenticated ? 200 : 401, { "content-type": "application/json" })
          .end(authenticated ? "[]" : '{"error":"unauthorized"}');
        return;
      }
      if (url.pathname === "/api/launcher/session-exchange" && request.method === "POST") {
        response.writeHead(204, {
          "set-cookie": "session=ok; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600",
        }).end();
        return;
      }
      if (url.pathname === "/__ponderosa_bootstrap") {
        response.writeHead(200, { "content-type": "text/html" }).end(
          '<script src="/__ponderosa_bootstrap.js"></script>',
        );
        return;
      }
      if (url.pathname === "/__ponderosa_bootstrap.js") {
        response.writeHead(200, { "content-type": "text/javascript" }).end(
          'fetch("/api/launcher/session-exchange",{method:"POST"}).then(()=>location.replace("/"));',
        );
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(401).end();
        return;
      }
      if (!publicAssets.has(url.pathname)) {
        response.writeHead(404).end();
        return;
      }
      const relative = decodeURIComponent(url.pathname.slice(1));
      const pathname = path.join(webDist, relative);
      response.writeHead(200, {
        "content-type": url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : "text/html",
      }).end(readFileSync(pathname));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });

    const result = await qualifyPersistentPwaUpgrade({
      port,
      profileDir,
      webDist,
      bootstrapUrl: `http://127.0.0.1:${port}/__ponderosa_bootstrap#fixture`,
      browserExecutable: testBrowser,
    });
    assert.deepEqual(result.expectedAssets, [
      "/register-sw.js",
      "/static/css/current.456.css",
      "/static/js/current.123.js",
    ]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
