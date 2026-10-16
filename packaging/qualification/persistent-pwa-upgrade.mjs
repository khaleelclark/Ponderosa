import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";

const LEGACY_ASSET_MARKER = "ponderosa-legacy-upgrade-fixture";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function executable(pathname) {
  try {
    accessSync(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChromiumExecutable(
  configured = process.env.PONDEROSA_BROWSER_EXECUTABLE,
  home = process.env.HOME,
) {
  const applications = home ? path.join(home, "Applications") : undefined;
  const candidates = [
    configured?.trim() && path.isAbsolute(configured.trim()) ? configured.trim() : undefined,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    applications && path.join(applications, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    applications && path.join(applications, "Chromium.app", "Contents", "MacOS", "Chromium"),
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate) && executable(candidate));
}

export const findMacosChromiumExecutable = findChromiumExecutable;

export function documentAssetPaths(indexHtml) {
  const assets = new Set();
  for (const pattern of [
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu,
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/giu,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']stylesheet["'][^>]*>/giu,
  ]) {
    for (const match of indexHtml.matchAll(pattern)) {
      const url = new URL(match[1], "http://127.0.0.1");
      if (url.origin === "http://127.0.0.1") assets.add(url.pathname);
    }
  }
  return [...assets].sort();
}

export function webAssetPaths(webDist) {
  const assets = [];
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(pathname, relative);
      } else if (entry.isFile()) {
        assets.push(`/${relative.split(path.sep).map(encodeURIComponent).join("/")}`);
      }
    }
  };
  visit(webDist, "");
  return assets.sort();
}

class CdpConnection {
  constructor(input, output) {
    this.input = input;
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    input.on("error", (error) => this.fail(error));
    output.on("data", (chunk) => this.consume(chunk));
    output.on("error", (error) => this.fail(error));
    output.on("end", () => this.fail(new Error("qualification browser debugging pipe closed")));
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf(0);
      if (end < 0) return;
      const body = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      if (!body) continue;
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "browser command failed"));
      else pending.resolve(message.result ?? {});
    }
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`qualification browser command timed out: ${method}`));
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.input.write(`${JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    })}\0`);
    return result;
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function observeProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processGroupExists(processGroupId);
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function stopDetachedProcessGroup(
  processGroupId,
  requestGracefulClose = async () => undefined,
  timeoutMs = 5_000,
) {
  assert(Number.isSafeInteger(processGroupId) && processGroupId > 0,
    "qualification browser process-group id is unavailable");
  await requestGracefulClose().catch(() => undefined);
  if (await observeProcessGroupExit(processGroupId, timeoutMs)) return;
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await observeProcessGroupExit(processGroupId, timeoutMs)) return;
  signalProcessGroup(processGroupId, "SIGKILL");
  if (!(await observeProcessGroupExit(processGroupId, timeoutMs))) {
    throw new Error("qualification browser process group did not exit");
  }
}

export function combinedQualificationFailure(primaryError, cleanupErrors, message) {
  if (!primaryError && cleanupErrors.length === 0) return undefined;
  if (primaryError && cleanupErrors.length === 0) return primaryError;
  if (!primaryError && cleanupErrors.length === 1) return cleanupErrors[0];
  return new AggregateError(
    [...(primaryError ? [primaryError] : []), ...cleanupErrors],
    message,
  );
}

async function closeBrowserWithPrimary(browser, primaryError, message) {
  const cleanupErrors = [];
  try {
    await browser.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  const failure = combinedQualificationFailure(primaryError, cleanupErrors, message);
  if (failure) throw failure;
}

async function stopBrowser(child, connection) {
  if (!child.pid) {
    throw new Error("qualification browser process-group id is unavailable");
  }
  await stopDetachedProcessGroup(
    child.pid,
    () => connection.send("Browser.close"),
  );
}

async function stopSpawnedBrowser(child) {
  if (!child.pid) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    throw new Error("qualification browser process-group id is unavailable");
  }
  await stopDetachedProcessGroup(child.pid);
}

function browserLaunchFailure(error, launchError, cleanupErrors = []) {
  const detail = launchError.trim();
  const primary = detail
    ? new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`)
    : error instanceof Error ? error : new Error(String(error));
  const failure = combinedQualificationFailure(
    primary,
    cleanupErrors,
    "qualification browser startup and process-group cleanup failed",
  );
  return failure ?? primary;
}

async function ensureDebuggingPipes(child, launchError) {
  const input = child.stdio[3];
  const output = child.stdio[4];
  if (input && output) return { input, output };
  const cleanupErrors = [];
  try {
    await stopSpawnedBrowser(child);
  } catch (error) {
    cleanupErrors.push(error);
  }
  throw browserLaunchFailure(
    new Error("qualification browser debugging pipe is unavailable"),
    launchError,
    cleanupErrors,
  );
}

function createBrowserProcess(executablePath, profileDir) {
  return spawn(executablePath, [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-dev-shm-usage",
    "--disable-features=Translate,OptimizationHints",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
        .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
    ),
    detached: true,
  });
}

async function spawnBrowser(executablePath, profileDir) {
  const child = createBrowserProcess(executablePath, profileDir);
  let launchError = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    launchError = `${launchError}${chunk}`.slice(-4_000);
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
  } catch (error) {
    const cleanupErrors = [];
    try {
      await stopSpawnedBrowser(child);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw browserLaunchFailure(error, launchError, cleanupErrors);
  }
  const pipes = await ensureDebuggingPipes(child, launchError);
  return { child, launchError: () => launchError, ...pipes };
}

export async function openQualificationBrowser(executablePath, profileDir, launchBrowser = spawnBrowser) {
  const {
    child,
    input,
    output,
    launchError,
    close: closeNativeBrowser,
  } = await launchBrowser(executablePath, profileDir);
  const connection = new CdpConnection(input, output);
  const close = () => closeNativeBrowser ? closeNativeBrowser(connection) : stopBrowser(child, connection);
  try {
    const created = await connection.send("Target.createTarget", { url: "about:blank" });
    const targetId = String(created.targetId ?? "");
    if (!targetId) throw new Error("qualification browser did not create a target");
    const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = String(attached.sessionId ?? "");
    if (!sessionId) throw new Error("qualification browser did not attach to its target");
    await Promise.all([
      connection.send("Page.enable", {}, sessionId),
      connection.send("Runtime.enable", {}, sessionId),
    ]);
    const evaluate = async (expression) => {
      const result = await connection.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "qualification browser evaluation failed");
      }
      return result.result?.value;
    };
    return {
      async navigate(url) {
        await connection.send("Page.navigate", { url }, sessionId);
      },
      evaluate,
      async waitFor(expression, message, timeoutMs = 60_000) {
        const deadline = Date.now() + timeoutMs;
        let lastError;
        while (Date.now() < deadline) {
          try {
            if (await evaluate(expression)) return;
          } catch (error) {
            lastError = error;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
      },
      close,
    };
  } catch (error) {
    const cleanupErrors = [];
    try {
      await close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw browserLaunchFailure(error, launchError(), cleanupErrors);
  }
}

function legacyWorkerSource(port) {
  const cacheName = `workbox-precache-v2-http://127.0.0.1:${port}/`;
  return `const CACHE=${JSON.stringify(cacheName)},URLS=["/index.html","/old.js","/register-sw.js"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(URLS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>{const url=new URL(event.request.url);if(event.request.mode==="navigate"&&!url.pathname.startsWith("/__ponderosa_bootstrap")){event.respondWith(caches.match("/index.html"));return}if(URLS.includes(url.pathname))event.respondWith(caches.match(url.pathname))});`;
}

function legacyRegisterSource() {
  // Model the problematic installed shell: it registers for updates but has no
  // code capable of activating a replacement worker that reaches "waiting".
  return `navigator.serviceWorker.register("/sw.js");`;
}

export async function seedLegacyPwaProfile(port, profileDir, browserExecutable, browserFactory = openQualificationBrowser) {
  const server = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    const bodies = {
      "/": `<!doctype html><script src="/old.js"></script><script src="/register-sw.js"></script><main>${LEGACY_ASSET_MARKER}</main>`,
      "/index.html": `<!doctype html><script src="/old.js"></script><script src="/register-sw.js"></script><main>${LEGACY_ASSET_MARKER}</main>`,
      "/old.js": `globalThis.__PONDEROSA_ASSET_MARKER__=${JSON.stringify(LEGACY_ASSET_MARKER)};`,
      "/register-sw.js": legacyRegisterSource(),
      "/sw.js": legacyWorkerSource(port),
    };
    const body = bodies[pathname];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": pathname.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  let browser;
  let primaryError;
  try {
    browser = await browserFactory(browserExecutable, profileDir);
    await browser.navigate(`http://127.0.0.1:${port}/`);
    await browser.waitFor(
      `(async()=>navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js")&&globalThis.__PONDEROSA_ASSET_MARKER__===${JSON.stringify(LEGACY_ASSET_MARKER)}&&Boolean(await caches.match("/old.js")))()`,
      "legacy service worker did not take control of the persistent profile",
    );
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    } catch (error) {
      cleanupErrors.push(error);
    }
    const failure = combinedQualificationFailure(
      primaryError,
      cleanupErrors,
      "legacy PWA profile seeding and cleanup failed",
    );
    if (failure) throw failure;
  }
}

async function unauthenticatedUpdateSurface(baseUrl, webDist) {
  const assets = webAssetPaths(webDist);
  assert(assets.includes("/sw.js"), "installed web build omitted sw.js");
  for (const asset of assets) {
    const response = await fetch(`${baseUrl}${asset}`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(10_000),
    });
    assert(response.ok, `unauthenticated PWA asset ${asset} returned HTTP ${response.status}`);
  }
  const api = await fetch(`${baseUrl}/api/projects`, {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(10_000),
  });
  assert(api.status === 401, `unauthenticated API request returned HTTP ${api.status}`);
  return assets.length;
}

function currentAssetExpression(expectedAssets, requireAuthenticatedApi) {
  return `(async()=>{const expected=${JSON.stringify(expectedAssets)},loaded=[...document.scripts].map(script=>new URL(script.src,location.href).pathname).concat([...document.querySelectorAll('link[rel="stylesheet"]')].map(link=>new URL(link.href,location.href).pathname));const registration=await navigator.serviceWorker.getRegistration("/");const oldAsset=await caches.match("/old.js");const apiStatus=${requireAuthenticatedApi ? "await fetch('/api/engines').then(response=>response.status).catch(()=>0)" : "401"};return expected.every(asset=>loaded.includes(asset))&&registration?.active?.scriptURL.endsWith("/sw.js")&&!oldAsset&&apiStatus===${requireAuthenticatedApi ? "200" : "401"}})()`;
}

export async function qualifyPersistentPwaUpgrade({
  port,
  profileDir,
  webDist,
  bootstrapUrl,
  browserExecutable = findChromiumExecutable(),
  browserFactory = openQualificationBrowser,
}) {
  assert(browserExecutable, "PWA upgrade qualification requires an installed Chromium browser");
  const expectedAssets = documentAssetPaths(readFileSync(path.join(webDist, "index.html"), "utf8"));
  assert(expectedAssets.length > 0, "installed web index did not reference fingerprinted assets");
  const baseUrl = `http://127.0.0.1:${port}`;
  const publicAssetCount = await unauthenticatedUpdateSurface(baseUrl, webDist);
  let browser = await browserFactory(browserExecutable, profileDir);
  let primaryError;
  try {
    await browser.navigate(bootstrapUrl);
    await browser.waitFor(
      `location.pathname==="/"&&${currentAssetExpression(expectedAssets, true)}`,
      "service worker blocked browser bootstrap or the authenticated current build",
    );
  } catch (error) {
    primaryError = error;
  }
  await closeBrowserWithPrimary(
    browser,
    primaryError,
    "persistent PWA upgrade and browser cleanup failed",
  );

  browser = await browserFactory(browserExecutable, profileDir);
  primaryError = undefined;
  try {
    await browser.navigate(`${baseUrl}/`);
    await browser.waitFor(
      currentAssetExpression(expectedAssets, true),
      "persistent browser restart regressed to legacy assets or lost authentication",
    );
  } catch (error) {
    primaryError = error;
  }
  await closeBrowserWithPrimary(
    browser,
    primaryError,
    "persistent PWA restart and browser cleanup failed",
  );
  return {
    browserExecutable,
    publicAssetCount,
    expectedAssets,
  };
}
