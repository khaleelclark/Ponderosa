import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import * as engineState from "../../apps/engine-desktop/dist/engine-state.js";

const require = createRequire(new URL("../../apps/engine-desktop/package.json", import.meta.url));
const ts = require("typescript");
const filename = fileURLToPath(new URL("../../apps/engine-desktop/src/main.ts", import.meta.url));
const source = ts.transpileModule(readFileSync(filename, "utf8").replaceAll("import.meta.url", JSON.stringify(pathToFileURL(filename).href)), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const settle = async () => { for (let i = 0; i < 32; i++) await tick(); };

async function desktop({ activeRuns = 0, stopFails = false, destroyDuringStop = false, deferReady = false } = {}) {
  let running = false, quits = 0, stops = 0;
  const windows = [], dialogs = [], handlers = new Map();
  const state = { schemaVersion: 2, generation: "11111111-1111-4111-8111-111111111111", controlToken: "fixture", pid: 123,
    port: 1234, host: "127.0.0.1", startedAt: "2026-01-01T00:00:00Z", dataDir: "/fixture/data", installRoot: "/fixture", version: "0.1.1", commit: "fixture", channel: "beta" };
  class Window extends EventEmitter {
    destroyed = false;
    webContents = { destroyed: false, isDestroyed() { return this.destroyed; }, send() {
      if (this.destroyed) throw new Error("Object has been destroyed");
    } };
    constructor() { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    removeMenu() {} loadFile() {} show() {} focus() {} hide() {}
    destroy() { this.destroyed = true; this.webContents.destroyed = true; this.emit("closed"); }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), setName() {},
    quit() {
      let prevented = false;
      app.emit("before-quit", { preventDefault() { prevented = true; } });
      if (!prevented) { quits++; windows.at(-1).destroy(); }
    },
  });
  const child = Object.assign(new EventEmitter(), {
    connected: true, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    send(message, callback) {
      assert.equal(message.type, "ponderosa-engine-stop");
      stops++; callback?.();
      queueMicrotask(() => {
        running = false; child.connected = false; child.exitCode = stopFails ? 1 : 0;
        if (destroyDuringStop) windows.at(-1).destroy();
        child.emit("exit", child.exitCode);
      });
    },
  });
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} }
  const electron = { app, BrowserWindow: Window, Tray, clipboard: { writeText() {} },
    dialog: { async showMessageBox(...args) { dialogs.push(args.at(-1)); return { response: 0 }; } },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    shell: { async openExternal() {} } };
  const mockProcess = Object.assign(new EventEmitter(), { argv: ["node", "desktop"], pid: 100,
    env: { PONDEROSA_INSTALL_ROOT: "/fixture", PONDEROSA_LAUNCHER_DATA_DIR: "/fixture/data" } });
  const modules = {
    electron, "node:child_process": { spawn() {
      running = true;
      if (!deferReady) queueMicrotask(() => child.emit("message", { type: "ponderosa-engine-ready" }));
      return child;
    } },
    "node:fs/promises": { async readFile(name) {
      if (name.endsWith("instance.json") && !running) throw new Error("absent fixture state");
      return JSON.stringify(state);
    } }, "./engine-state.js": engineState,
  };
  vm.runInNewContext(source, { exports: {}, require: name => modules[name] ?? require(name), process: mockProcess,
    Buffer, AbortSignal, setTimeout, clearTimeout, console,
    async fetch(url) {
      const body = url.endsWith("/api/ready") ? { status: "ready", canAcceptWork: true, checks: {} } : url.endsWith("/bootstrap") ? { token: "fixture" }
        : url.includes("/logs") ? { text: "", stream: "server" } : { ...state, activeRunCount: activeRuns };
      return { ok: true, status: 200, async json() { return body; } };
    } }, { filename });
  await settle();
  assert.equal((await handlers.get("engine:snapshot")()).state, "running");
  return { app, child, windows, dialogs, handlers, counts: () => ({ stops, quits }) };
}

test("Windows session ending permits OS termination without starting late cleanup or showing dialogs", async () => {
  const fixture = await desktop({ activeRuns: 1, stopFails: true });
  let prevented = false;
  fixture.windows[0].emit("query-session-end", { preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, false);
  fixture.windows[0].emit("session-end");
  fixture.app.quit();
  await settle();
  assert.deepEqual(fixture.counts(), { stops: 0, quits: 1 });
  assert.deepEqual(fixture.dialogs, []);
});

test("a Windows shutdown query canceled before session end retains ordinary Quit guards", async () => {
  const fixture = await desktop({ activeRuns: 1 });
  fixture.windows[0].emit("query-session-end", { preventDefault() { assert.fail("shutdown query vetoed"); } });
  fixture.app.quit();
  await settle();
  assert.deepEqual(fixture.counts(), { stops: 0, quits: 0 });
  assert.equal(fixture.dialogs[0].title, "Quit Ponderosa Engine?");
});

test("ordinary Quit still lets users cancel active work shutdown", async () => {
  const fixture = await desktop({ activeRuns: 1 });
  assert.equal(await fixture.handlers.get("engine:quit")(), false);
  assert.deepEqual(fixture.counts(), { stops: 0, quits: 0 });
  assert.equal(fixture.dialogs[0].title, "Quit Ponderosa Engine?");
});

test("shutdown requested before the supervisor listens is delivered after its ready acknowledgement", async () => {
  const fixture = await desktop({ deferReady: true });
  const quitting = fixture.handlers.get("engine:quit")();
  await settle();
  assert.deepEqual(fixture.counts(), { stops: 0, quits: 0 });
  fixture.child.emit("message", { type: "ponderosa-engine-ready" });
  assert.equal(await quitting, true);
  assert.deepEqual(fixture.counts(), { stops: 1, quits: 1 });
});

test("a fenced reboot-required response lets Windows perform the required reboot", async () => {
  const fixture = await desktop();
  fixture.child.emit("message", { type: "ponderosa-engine-reboot-required" });
  let prevented = false;
  fixture.windows[0].emit("query-session-end", { preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, false);
  assert.deepEqual(fixture.counts(), { stops: 0, quits: 0 });
});

test("an exit before accepting shutdown never becomes a successful Quit", async () => {
  const fixture = await desktop({ deferReady: true });
  const quitting = fixture.handlers.get("engine:quit")();
  await settle();
  fixture.child.exitCode = 0;
  fixture.child.connected = false;
  fixture.child.emit("exit", 0);
  assert.equal(await quitting, false);
  assert.deepEqual(fixture.counts(), { stops: 0, quits: 0 });
});

test("late child-exit callbacks tolerate a destroyed desktop window", async () => {
  const fixture = await desktop({ destroyDuringStop: true });
  assert.equal(await fixture.handlers.get("engine:quit")(), true);
  await settle();
  assert.deepEqual(fixture.counts(), { stops: 1, quits: 1 });
});

test("ordinary shutdown failure keeps cleanup incomplete and does not claim a successful quit", async () => {
  const fixture = await desktop({ stopFails: true });
  assert.equal(await fixture.handlers.get("engine:quit")(), false);
  await settle();
  assert.deepEqual(fixture.counts(), { stops: 1, quits: 0 });
  assert.equal((await fixture.handlers.get("engine:snapshot")()).state, "cleanup_incomplete");
  assert.equal(fixture.dialogs[0].title, "Ponderosa Engine is still running");
});

test('truncated log label describes returned bytes rather than full file size', () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {dataset:{},setAttribute(key,value){this[key]=value;},addEventListener(){}});
    return elements.get(id);
  };
  const renderer = ts.transpileModule(readFileSync(new URL('../../apps/engine-desktop/src/renderer.ts',import.meta.url),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS},
  }).outputText.replace('void refresh();','');
  const context = vm.createContext({exports:{},document:{getElementById:element,body:{dataset:{}}},window:{setInterval(){}},console});
  vm.runInContext(renderer,context);
  context.sample={state:'running',detail:'Fixture',logs:{server:{text:'é'.repeat(512),totalBytes:1048576,returnedBytes:1024,truncated:true}}};
  vm.runInContext('render(sample)',context);
  assert.equal(element('log-output')['aria-label'],'server log, latest 1.0 KiB shown');
});
