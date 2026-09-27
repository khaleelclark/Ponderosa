import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { processGroupAlive, runtimeProcessIdentity, terminateProcessGroup } from "@ponderosa/engines";
import { ApprovedChromeConnection } from "./approved-chrome-connection.js";
import { ChromeCdpDriver, spawnHostedDisplay, type BrowserDriver, type BrowserDriverFactory, type BrowserDriverLaunchOptions, type BrowserPagesInfo } from "./chrome-cdp-driver.js";

export async function createNativeHostedBrowser(executable: string, profileDir: string, onConsole: Parameters<BrowserDriverFactory>[1], publish: Parameters<BrowserDriverFactory>[2], onPageEvent: Parameters<BrowserDriverFactory>[3], launch: BrowserDriverLaunchOptions): Promise<BrowserDriver> {
  if (process.platform !== "linux") throw new Error("Native hosted desktop controls are available on Linux only; use the in-app browser on this host.");
  const wait = (milliseconds: number) => new Promise<void>((resolve, reject) => {
    if (launch.signal?.aborted) { reject(new Error("browser launch cancelled")); return; }
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(timer); cleanup(); reject(new Error("browser launch cancelled")); };
    const cleanup = () => launch.signal?.removeEventListener("abort", cancel);
    function finish() { cleanup(); resolve(); }
    launch.signal?.addEventListener("abort", cancel, { once: true });
  });
  launch.signal?.throwIfAborted();
  if (!existsSync("/usr/bin/Xvfb") || !existsSync("/usr/bin/x11vnc")) throw new Error("Manual hosted browsing requires Xvfb and x11vnc on this host.");
  const root = await fs.mkdtemp(path.join(tmpdir(), "ponderosa-desktop-"));
  const socketPath = path.join(root, "desktop.sock");
  const readOnlySocketPath = path.join(root, "desktop-view.sock");
  const children: ChildProcess[] = [];
  const authority = {};
  let published = false, closed = false, revision = 0;
  let state: "manual" | "connecting" | "automation" = "manual";
  let connection: ApprovedChromeConnection | undefined, driver: ChromeCdpDriver | undefined;
  let approval: AbortController | undefined;
  let connectionFailure: string | undefined;
  let pages: BrowserPagesInfo = { activePageId: "manual", pages: [{ pageId: "manual", url: "about:blank", title: "Manual browser", active: true, isNew: false, closable: false }] };
  let display: Awaited<ReturnType<typeof spawnHostedDisplay>> | undefined;
  const pause = async () => {
    revision++; state = "manual";
    const previousApproval = approval; approval = undefined; previousApproval?.abort();
    const previousDriver = driver, previousConnection = connection;
    driver = undefined; connection = undefined;
    previousDriver?.detachMechanics(); previousConnection?.disconnect();
  };
  const close = async () => {
    closed = true; await pause();
    const results = await Promise.allSettled(children.map(child => terminateProcessGroup(child, { label: "native browser", termGraceMs: 2000, killConfirmationMs: 2000 })));
    if (results.some(result => result.status === "rejected") || children.some(child => processGroupAlive(child))) throw new Error("Native browser process cleanup could not be confirmed.");
    if (display) await fs.rm(display.reservationPath, { force: true });
    await fs.rm(root, { recursive: true, force: true });
    if (!launch.retainProfile) await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  };
  const track = (child: ChildProcess, complete = false) => {
    children.push(child);
    publish?.({ terminationAuthority: authority, processIdentity: runtimeProcessIdentity(child), isAlive: () => children.some(child => processGroupAlive(child)), close }, { complete, coversReturnedDriver: complete });
    if (publish) published = true;
  };
  try {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    display = await spawnHostedDisplay("/usr/bin/Xvfb", value => { display = value; track(value.child); return published; }, { width: 2560, height: 2560 }, launch.signal);
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
    const chrome = spawn(executable, [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", ...(launch.connectOnOpen ? ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"] : []), "--force-device-scale-factor=2", "--window-size=1280,720", "--window-position=0,0", launch.initialUrl ?? "about:blank"], { env: { ...env, DISPLAY: display.display }, stdio: "ignore", detached: true });
    track(chrome);
    const run = promisify(execFile);
    const displayEnv = { ...env, DISPLAY: display.display };
    let windowId = "";
    const windowDeadline = Date.now() + 10_000;
    while (!windowId) {
      launch.signal?.throwIfAborted();
      const result = await run("/usr/bin/xdotool", ["search", "--onlyvisible", "--class", "google-chrome"], { env: displayEnv, timeout: 1000 }).catch(() => undefined);
      windowId = result?.stdout.trim().split(/\s+/)[0] ?? "";
      if (!/^\d+$/.test(windowId)) windowId = "";
      if (Date.now() > windowDeadline) throw new Error("Native browser window did not appear.");
      if (!windowId) await wait(50);
    }
    // Capture the screen region occupied by Chrome, including native menus and
    // permission dialogs, rather than only its drawable or the whole desktop.
    const vncArgs = ["-display", display.display, "-sid", windowId, "-rfbport", "0", "-nopw", "-forever", "-shared", "-nosel", "-noxdamage", "-quiet"];
    const vnc = spawn("/usr/bin/x11vnc", [...vncArgs, "-unixsock", socketPath], { env: displayEnv, stdio: "ignore", detached: true });
    const viewer = spawn("/usr/bin/x11vnc", [...vncArgs, "-viewonly", "-unixsock", readOnlySocketPath], { env: displayEnv, stdio: "ignore", detached: true });
    track(viewer);
    let spawnFailed = false;
    chrome.on("error", () => { spawnFailed = true; }); vnc.on("error", () => { spawnFailed = true; }); viewer.on("error", () => { spawnFailed = true; });
    track(vnc, true);
    const deadline = Date.now() + 5000;
    while (!existsSync(socketPath) || !existsSync(readOnlySocketPath)) {
      launch.signal?.throwIfAborted();
      if (spawnFailed || !processGroupAlive(vnc) || !processGroupAlive(chrome) || Date.now() > deadline) throw new Error("Manual browser display failed to start.");
      await wait(25);
    }
    launch.signal?.throwIfAborted();
    await fs.chmod(socketPath, 0o600);
    await fs.chmod(readOnlySocketPath, 0o600);
    if (launch.connectOnOpen) {
      const endpointDeadline = Date.now() + 5_000;
      while (!existsSync(path.join(profileDir, "DevToolsActivePort"))) {
        launch.signal?.throwIfAborted();
        if (!processGroupAlive(chrome) || Date.now() > endpointDeadline) throw new Error("Ponderosa could not connect to its new browser. No replacement was opened.");
        await wait(50);
      }
      const connected = await ApprovedChromeConnection.connect(profileDir, { signal: launch.signal, approvalTimeoutMs: 5_000 });
      let attached: ChromeCdpDriver | undefined;
      try {
        attached = await ChromeCdpDriver.attachOwned(chrome, display, connected, profileDir, onConsole, onPageEvent, authority);
        launch.signal?.throwIfAborted();
        pages = await attached.pages();
        launch.signal?.throwIfAborted();
        connection = connected; driver = attached; state = "automation"; revision++;
        connected.onClose(() => { if (connection === connected && !closed) { connectionFailure = connected.failureReason(); void pause(); } });
      } catch (error) { attached?.detachMechanics(); connected.disconnect(); throw error; }
    }
    const own: Partial<BrowserDriver> = {
      terminationAuthority: authority, processIdentity: runtimeProcessIdentity(chrome),
      isAlive: () => processGroupAlive(chrome) && processGroupAlive(vnc) && processGroupAlive(viewer) && Boolean(display && processGroupAlive(display.child)), close,
      manualState: () => state,
      manualSocket: (readOnly = false) => { if (closed) throw new Error("Browser display is closed."); return readOnly ? readOnlySocketPath : socketPath; },
      resizeDesktop: async size => {
        if (closed || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 320 || size.width > 1280 || size.height < 200 || size.height > 1280) throw new Error("Invalid browser display size.");
        await run("/usr/bin/xdotool", ["windowsize", "--sync", windowId, String(size.width * 2), String(size.height * 2)], { env: displayEnv, timeout: 5000 });
      },
      controlRevision: () => revision,
      pauseAutomation: pause,
      openLink: async url => {
        if (closed || state === "connecting" || !processGroupAlive(chrome)) throw new Error("Browser is not ready to open a link.");
        if (state === "automation" && driver) { await driver.newPage(); await driver.navigate(url); return; }
        if (!existsSync("/usr/bin/xdotool")) throw new Error("Opening links in the native browser requires xdotool on the host.");
        const run = promisify(execFile);
        const options = { env: { ...env, DISPLAY: display!.display }, timeout: 5000 };
        await run("/usr/bin/xdotool", ["key", "--clearmodifiers", "ctrl+t"], options);
        await new Promise(resolve => setTimeout(resolve, 150));
        await run("/usr/bin/xdotool", ["type", "--clearmodifiers", "--delay", "0", "--", url], options);
        await run("/usr/bin/xdotool", ["key", "--clearmodifiers", "Return"], options);
      },
      resumeAutomation: async () => {
        if (closed || state !== "manual") throw new Error("Manual browser state changed.");
        state = "connecting"; revision++;
        const controller = new AbortController(); approval = controller;
        let connected: ApprovedChromeConnection | undefined;
        try {
          connected = await ApprovedChromeConnection.connect(profileDir, { signal: controller.signal });
          if (closed || controller.signal.aborted) throw new Error("Browser resume cancelled.");
          connection = connected;
          const attached = await ChromeCdpDriver.attachOwned(chrome, display!, connected, profileDir, onConsole, onPageEvent, authority);
          if (closed || controller.signal.aborted) { attached.detachMechanics(); throw new Error("Browser resume cancelled."); }
          const nextPages = await attached.pages();
          if (closed || controller.signal.aborted) { attached.detachMechanics(); throw new Error("Browser resume cancelled."); }
          driver = attached; pages = nextPages;
          connectionFailure = undefined;
          state = "automation"; revision++;
          connected.onClose(() => { if (connection === connected && !closed) { connectionFailure = connected!.failureReason(); void pause(); } });
        } catch (error) { connected?.disconnect(); if (approval === controller) await pause(); throw error; }
        finally { if (approval === controller) approval = undefined; }
      },
      pages: async () => { if (state === "automation" && driver) pages = await driver.pages(); return pages; },
      cancelPendingFileChooser: async reason => { if (driver) await driver.cancelPendingFileChooser(reason); },
      viewport: pageId => driver?.viewport(pageId) ?? { width: 1280, height: 720 },
    };
    return new Proxy(own as BrowserDriver, { get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (typeof key !== "string" || key === "then" || key === "paused") return undefined;
      if (["activity", "resizeViewport", "newPage"].includes(key) && (!driver || typeof Reflect.get(driver, key) !== "function")) return undefined;
      return (...args: unknown[]) => {
        if (closed || state !== "automation" || !driver) throw new Error("Browser is in manual mode. Resume automation explicitly before agent actions.");
        const method = Reflect.get(driver, key);
        if (typeof method !== "function") throw new Error("Browser operation is unavailable.");
        const result = method.apply(driver, args);
        return result instanceof Promise ? result.catch((error: unknown) => { throw connectionFailure ? new Error(connectionFailure) : error; }) : result;
      };
    } });
  } catch (error) { if (!published) await close(); throw error; }
}
