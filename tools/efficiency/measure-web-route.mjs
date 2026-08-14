#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { validateOfflineSnapshot } from "./measure-web-route-validation.mjs";

const requireFromServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const WebSocket = requireFromServer("ws");

const url = process.argv[2];
const checkOffline = process.argv.includes("--offline-check");
const mobile = process.argv.includes("--mobile");
const routeKindArgument = process.argv.find(argument => argument.startsWith("--route-kind="));
const expectedRouteKind = routeKindArgument?.slice("--route-kind=".length);
const injectedStage = process.env.PONDEROSA_MEASURE_WEB_ROUTE_FAIL_AT;
if (!url || !/^https?:\/\//u.test(url)) {
  process.stderr.write("usage: node tools/efficiency/measure-web-route.mjs <http(s)-url> [--mobile] [--offline-check --route-kind=<kind>]\n");
  process.exit(2);
}
if (checkOffline && !expectedRouteKind) {
  process.stderr.write("--offline-check requires --route-kind=<expected route marker>\n");
  process.exit(2);
}

function injectedFailure(stage) {
  if (injectedStage === stage) {
    throw new Error(`injected ${stage} failure`);
  }
}

async function devtoolsPort(profile, chrome, startupError) {
  const file = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const spawnFailure = startupError();
    if (spawnFailure) throw spawnFailure;
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(`Chrome exited before DevTools opened (${chrome.exitCode ?? chrome.signalCode})`);
    }
    try {
      const [port] = (await readFile(file, "utf8")).trim().split("\n");
      if (port) return port;
    } catch { /* Chrome has not opened the endpoint yet. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Chrome DevTools endpoint did not open");
}

async function terminateChrome(chrome) {
  if (!chrome) return;
  const groupAlive = () => {
    if (process.platform === "win32" || !chrome.pid) return false;
    try {
      process.kill(-chrome.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const childAlive = () => chrome.exitCode === null && chrome.signalCode === null;
  const waitForExit = async timeoutMs => {
    const deadline = Date.now() + timeoutMs;
    while ((childAlive() || groupAlive()) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return !childAlive() && !groupAlive();
  };
  const signal = signalName => {
    if (process.platform !== "win32" && chrome.pid) {
      try {
        process.kill(-chrome.pid, signalName);
        return;
      } catch { /* Fall back to the directly observed child below. */ }
    }
    if (childAlive()) chrome.kill(signalName);
  };
  if (!childAlive() && !groupAlive()) return;
  signal("SIGTERM");
  if (await waitForExit(1_500)) return;
  signal("SIGKILL");
  await waitForExit(1_500);
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise(resolve => socket.once("close", resolve));
  if (socket.readyState === WebSocket.OPEN) socket.close();
  else socket.terminate();
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 500))]);
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

let requestId = 0;
const pending = new Map();
const eventWaiters = new Map();
const network = new Map();

function bindSocket(socket) {
  socket.on("message", raw => {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter?.timer);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
      return;
    }
    if (message.method === "Network.responseReceived" && message.params.type === "Script") {
      network.set(message.params.requestId, {
        url: message.params.response.url,
        transferBytes: 0,
        rawBytes: message.params.response.headers?.["content-length"] ?? 0,
      });
    }
    if (message.method === "Network.loadingFinished") {
      const record = network.get(message.params.requestId);
      if (record) record.transferBytes = message.params.encodedDataLength;
    }
    const waiters = eventWaiters.get(message.method);
    if (waiters?.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
  });
  const rejectPending = error => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    for (const waiters of eventWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    eventWaiters.clear();
  };
  socket.once("error", error => rejectPending(error));
  socket.once("close", () => rejectPending(new Error("Chrome DevTools socket closed")));
}

function send(socket, method, params = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timeoutMs = injectedStage === "protocol-command-timeout" && method === "Page.enable"
      ? 50
      : 10_000;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (injectedStage === "protocol-command-timeout" && method === "Page.enable") return;
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function event(method, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const waiters = eventWaiters.get(method) ?? [];
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs),
    };
    waiters.push(waiter);
    eventWaiters.set(method, waiters);
  });
}

async function navigateAndWaitForLoad(socket) {
  const loaded = event("Page.loadEventFired");
  const navigated = Promise.resolve().then(() => send(socket, "Page.navigate", { url }));
  const outcomes = await Promise.allSettled([loaded, navigated]);
  const failures = outcomes.filter(outcome => outcome.status === "rejected");
  if (failures.length === 1) throw failures[0].reason;
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map(failure => failure.reason),
      `Navigation failed (${failures.map(failure =>
        failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join("; ")})`,
    );
  }
}

async function measure(socket, label, cacheDisabled) {
  network.clear();
  await send(socket, "Network.setCacheDisabled", { cacheDisabled });
  await send(socket, "Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  await navigateAndWaitForLoad(socket);
  const navigation = await send(socket, "Runtime.evaluate", {
    expression: "JSON.stringify(performance.getEntriesByType('navigation')[0]?.toJSON() ?? {})",
    returnByValue: true,
  });
  const coverage = await send(socket, "Profiler.takePreciseCoverage");
  await send(socket, "Profiler.stopPreciseCoverage");
  const scripts = coverage.result.filter(script =>
    script.url.startsWith(new URL(url).origin) && script.url.includes(".js"));
  let loadedSourceBytes = 0;
  let coveredRangeBytes = 0;
  for (const script of scripts) {
    const scriptSource = await fetch(script.url).then(response => response.text());
    loadedSourceBytes += Buffer.byteLength(scriptSource);
    const covered = script.functions.flatMap(fn => fn.ranges)
      .filter(range => range.count > 0)
      .map(range => [range.startOffset, range.endOffset])
      .sort((left, right) => left[0] - right[0]);
    let end = 0;
    for (const [start, nextEnd] of covered) {
      if (nextEnd <= end) continue;
      coveredRangeBytes += nextEnd - Math.max(start, end);
      end = nextEnd;
    }
  }
  const resource = [...network.values()];
  return {
    label,
    navigation: JSON.parse(navigation.result.value),
    scriptRequests: resource,
    scriptTransferBytes: resource.reduce((sum, item) => sum + item.transferBytes, 0),
    loadedScriptSourceBytes: loadedSourceBytes,
    coveredScriptRangeBytes: coveredRangeBytes,
  };
}

async function run() {
  let profile;
  let chrome;
  let socket;
  try {
  profile = await mkdtemp(path.join(tmpdir(), "ponderosa-web-route-"));
  injectedFailure("after-profile");
  chrome = spawn(process.env.PONDEROSA_BROWSER_EXECUTABLE || "google-chrome-stable", [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "about:blank",
  ], { stdio: "ignore", detached: process.platform !== "win32" });
  let chromeStartupError;
  chrome.once("error", error => { chromeStartupError = error; });
  injectedFailure("after-spawn");
  const port = await devtoolsPort(profile, chrome, () => chromeStartupError);
  injectedFailure("after-devtools");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  }).then(response => {
    if (!response.ok) throw new Error(`Chrome target discovery failed (${response.status})`);
    return response.json();
  });
  const target = injectedStage === "missing-target"
    ? undefined
    : targets.find(candidate => candidate.type === "page");
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome page target is unavailable");
  injectedFailure("after-target");
  socket = new WebSocket(
    injectedStage === "socket-open-error"
      ? "ws://127.0.0.1:1"
      : target.webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    const timeoutMs = injectedStage === "socket-open-timeout" ? 50 : 5_000;
    const timer = setTimeout(() => reject(new Error("Chrome DevTools socket open timed out")), timeoutMs);
    socket.once("open", () => {
      if (injectedStage === "socket-open-timeout") return;
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
  bindSocket(socket);
  injectedFailure("after-socket");
  await Promise.all([
    send(socket, "Page.enable"),
    send(socket, "Network.enable"),
    send(socket, "Runtime.enable"),
    send(socket, "Profiler.enable"),
  ]);
  injectedFailure("measurement-timeout");
  if (mobile) {
    await send(socket, "Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
  }
  const cold = await measure(socket, "cold", true);
  const repeat = await measure(socket, "repeat", false);
  let offline;
  if (checkOffline) {
    const workerReady = await send(socket, "Runtime.evaluate", {
      expression: "Promise.race([navigator.serviceWorker.ready.then(() => true),new Promise(resolve=>setTimeout(()=>resolve(false),5000))])",
      awaitPromise: true,
      returnByValue: true,
    });
    if (!workerReady.result.value) throw new Error("service worker readiness timed out");
    await send(socket, "Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await navigateAndWaitForLoad(socket);
    let timedOut = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const ready = await send(socket, "Runtime.evaluate", {
        expression: "Boolean(document.querySelector('[data-workspace-route-content]')?.innerText.trim())&&!document.querySelector('[data-route-chunk-error]')",
        returnByValue: true,
      });
      if (ready.result.value) {
        timedOut = false;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const snapshot = await send(socket, "Runtime.evaluate", {
      expression: "(()=>{const route=document.querySelector('[data-workspace-route-content]');return JSON.stringify({pathname:location.pathname,controlled:Boolean(navigator.serviceWorker.controller),routeKind:route?.getAttribute('data-workspace-route-kind'),routePath:route?.getAttribute('data-workspace-route-path'),routeContentPresent:Boolean(route),errorBoundary:Boolean(document.querySelector('[data-workspace-error-boundary]')),routeChunkError:Boolean(document.querySelector('[data-route-chunk-error]')),routeText:route?.innerText.slice(0,500)??''})})()",
      returnByValue: true,
    });
    offline = JSON.parse(snapshot.result.value);
    validateOfflineSnapshot({
      expectedUrl: url,
      expectedRouteKind,
      snapshot: offline,
      timedOut,
    });
    await send(socket, "Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }
  process.stdout.write(`${JSON.stringify({ url, viewport: mobile ? "390x844@3" : "desktop", cold, repeat, ...(offline ? { offline } : {}) }, null, 2)}\n`);
  } finally {
    await closeSocket(socket);
    await terminateChrome(chrome);
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
}

run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
