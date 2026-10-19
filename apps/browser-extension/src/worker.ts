import { applicationUrl, serverOrigin, AuthenticationRequired } from "./policy.js";
import { upload, clearUploads } from "./uploads.js";
import type { LocalBrowserCommand as Command } from "@ponderosa/core";
type Connection = { server: string; token: string; id: string; tabId: number; windowId: number; attached: number[]; paused: boolean; epoch: number; revoked?: boolean };
type Access = { readonly epoch: number; readonly deadline?: number; tabId: number };
let connection: Connection | undefined;
let stopping: Promise<void> | undefined;
let connecting = false;
const attaching = new Map<number, Promise<void>>();
const detaching = new Map<number, Promise<void>>();
let pausing: Promise<void> | undefined;
let resuming: Promise<void> | undefined;
async function pause(current: Connection): Promise<void> {
  if (connection !== current || current.revoked) return;
  if (pausing) return pausing;
  current.paused = true;
  current.epoch++;
  pausing = (async () => {
    await Promise.allSettled(attaching.values());
    await clearAgentCursors(current);
    for (const tabId of [...current.attached]) await detach(current, tabId);
    if (connection !== current || current.revoked) return;
    await api(current, `connections/${current.id}/state`, { paused: true, epoch: current.epoch });
    await chrome.storage.session.set({ connection: current });
    await chrome.action.setBadgeText({ text: "II" });
  })();
  try { await pausing; } catch (error) { revoke(current); throw error; } finally { pausing = undefined; }
}
async function resume(current: Connection): Promise<void> {
  if (pausing) await pausing;
  if (connection !== current || current.revoked) throw new Error("Disconnected");
  // Explicit popup action only. No commands from the paused epoch survive this transition.
  current.epoch++;
  current.paused = false;
  const access: Access = { epoch: current.epoch, tabId: current.tabId };
  try {
    await pages(current, access);
    access.tabId = current.tabId;
    await guard(current, access);
    check(current, access);
    await api(current, `connections/${current.id}/state`, { paused: false, epoch: current.epoch });
    check(current, access);
    await chrome.storage.session.set({ connection: current });
    check(current, access);
    await chrome.action.setBadgeText({ text: "ON" });
    check(current, access);
  } catch (error) { await pause(current); throw error; }
}
const api = async (current: Connection, path: string, body: unknown = {}) => {
  const response = await fetch(`${current.server}/api/local-browser/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${current.token}` },
    body: JSON.stringify(body), credentials: "omit", redirect: "error", signal: AbortSignal.timeout(14_000),
  });
  if (!response.ok) throw new Error("Ponderosa connection was lost. Reconnect the window to continue.");
  return response.json() as Promise<unknown>;
};
function stop(): Promise<void> {
  if (stopping) return stopping;
  const current = connection;
  if (!current) return Promise.resolve();
  current.revoked = true;
  stopping = (async () => { try {
    if (current) {
      await Promise.allSettled(attaching.values());
      await clearAgentCursors(current);
      const failures: unknown[] = [];
      for (const tabId of [...current.attached]) {
        try { await detach(current, tabId); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new Error("Could not confirm disconnection. Close the connected window to stop access.");
      await api(current, `connections/${current.id}/detached`).catch(() => {});
    }
    connection = undefined;
    await chrome.storage.session.remove("connection");
    await chrome.action.setBadgeText({ text: "" });
  } finally { stopping = undefined; } })();
  return stopping;
}
const revoke = (expected = connection) => {
  if (!expected || connection !== expected) return;
  void stop().catch(() => chrome.action.setBadgeText({ text: "!" }).catch(() => {}));
};
function check(current: Connection, access: Access): void {
  if (current.paused) throw new AuthenticationRequired("Browser access is paused. Resume in the extension.");
  if (connection !== current || current.revoked || current.epoch !== access.epoch || (access.deadline !== undefined && Date.now() >= access.deadline)) throw new Error("Connection or command expired");
}
const allowed = (url: string) => url === "about:blank" || Boolean(applicationUrl(url));
async function detach(current: Connection, tabId: number): Promise<void> {
  const pending = detaching.get(tabId);
  if (pending) return pending;
  // Keep ownership until Chrome confirms detachment. Pause/stop must await an
  // in-flight attempt rather than mistake its tab for an already detached one.
  const attempt = Promise.resolve().then(async () => {
    try { await chrome.debugger.detach({ tabId }); }
    catch (error) {
      if (!(error instanceof Error) || !/not attached|no tab|tab.*closed|target.*closed/i.test(error.message)) throw error;
    }
    current.attached = current.attached.filter(id => id !== tabId);
  });
  detaching.set(tabId, attempt);
  try { await attempt; } finally { detaching.delete(tabId); }
}
async function scopedTab(current: Connection, tabId: number, access: Access): Promise<ChromeTab> {
  check(current, access);
  const tab = await chrome.tabs.get(tabId);
  check(current, access);
  if (tab.windowId !== current.windowId || !tab.url || !allowed(tab.url)) throw new Error("Tab is outside the connected window or requires manual sign-in.");
  return tab;
}
const cdp = async (current: Connection, access: Access, method: string, params?: Record<string, unknown>) => {
  const tabId = access.tabId;
  await scopedTab(current, tabId, access);
  if (!current.attached.includes(tabId)) {
    check(current, access);
    const pending = chrome.debugger.attach({ tabId }, "1.3").then(() => { current.attached.push(tabId); });
    attaching.set(tabId, pending);
    try { await pending; } finally { attaching.delete(tabId); }
    check(current, access);
    await chrome.storage.session.set({ connection: current });
    await scopedTab(current, tabId, access);
  }
  check(current, access);
  const result = await chrome.debugger.sendCommand({ tabId }, method, params);
  check(current, access);
  return result;
};
async function pages(current: Connection, access: Access): Promise<unknown> {
  check(current, access);
  const candidates = await chrome.tabs.query({ windowId: current.windowId });
  check(current, access);
  const tabs = candidates.filter(tab => {
    if (!tab.url || tab.url.startsWith("chrome:") || tab.url.startsWith("edge:")) return false;
    return allowed(tab.url);
  });
  if (!tabs.length || tabs.length > 50) throw new Error("Connect a window with 1–50 application tabs.");
  if (!tabs.some(tab => tab.id === current.tabId)) current.tabId = tabs.find(tab => tab.active)?.id ?? tabs[0]!.id!;
  return { activePageId: String(current.tabId), pages: tabs.map(tab => ({ pageId: String(tab.id), url: tab.url, title: tab.title ?? "Untitled", active: tab.id === current.tabId, isNew: false, closable: tabs.length > 1 })) };
}

/** This fixed function, not code supplied by Ponderosa, is evaluated in the tab. */
function pageOperation(action: string, args: Record<string, unknown>): unknown {
  if (action === "clearAgentCursor") {
    document.querySelectorAll("[data-ponderosa-agent-cursor]").forEach(element => element.remove());
    return true;
  }
  if (document.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="current-password"],input[autocomplete="new-password"]')) return { blocked: true };
  if (action === "showAgentCursor") {
    const x = Number(args.x), y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    document.querySelectorAll("[data-ponderosa-agent-cursor]").forEach(element => element.remove());
    const marker = document.createElement("div");
    marker.dataset.ponderosaAgentCursor = "";
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2147483647;pointer-events:none;width:1px;height:1px;overflow:visible`;
    const tip = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    tip.setAttribute("viewBox", "0 0 22 28");
    tip.style.cssText = "position:absolute;left:-2px;top:-2px;width:22px;height:28px;overflow:visible;filter:drop-shadow(0 2px 3px #000a);pointer-events:none";
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", "M2 2v21l6-6 4 9 4-2-4-9h9z");
    arrow.setAttribute("fill", "#61bf83");
    arrow.setAttribute("stroke", "#fff");
    arrow.setAttribute("stroke-width", "2");
    tip.append(arrow);
    const label = document.createElement("div");
    label.style.cssText = "position:absolute;left:19px;top:14px;padding:2px 6px;border-radius:5px;background:#183a2b;color:#fff;font:600 12px system-ui;white-space:nowrap;box-shadow:0 2px 8px #0008;pointer-events:none";
    label.textContent = "Agent";
    marker.append(tip, label);
    document.documentElement.append(marker);
    setTimeout(() => marker.remove(), 2_500);
    return true;
  }
  if (action === "info") return { url: location.href, title: document.title, width: innerWidth, height: innerHeight };
  if (action === "guard") return { blocked: false };
  const selector = typeof args.selector === "string" && args.selector.length <= 2000 ? args.selector : undefined;
  if (action === "inspect") {
    const markers = [...document.querySelectorAll<HTMLElement>("[data-ponderosa-agent-cursor]")];
    markers.forEach(marker => marker.style.display = "none");
    try {
      const root = selector ? document.querySelector(selector) : document.body;
      if (!root) throw new Error("Element not found");
      const controls = [...root.querySelectorAll("input,textarea,select,button,a[href]")].slice(0, 60).map(element => {
        const input = element as HTMLInputElement;
        const label = element.getAttribute("aria-label") ?? element.getAttribute("placeholder") ?? element.textContent ?? "";
        const identity = element.id ? `#${CSS.escape(element.id)}` : input.name ? `${element.tagName.toLowerCase()}[name=${JSON.stringify(input.name)}]` : undefined;
        return { selector: identity, tag: element.tagName.toLowerCase(), label: label.slice(0, 200), type: input.type, ...(input.type !== "file" && input.type !== "hidden" && "value" in input ? { value: String(input.value).slice(0, 500) } : {}) };
      });
      return JSON.stringify({ url: location.origin + location.pathname, title: document.title, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, text: (root instanceof HTMLElement ? root.innerText : root.textContent ?? "").slice(0, 10_000), controls }).slice(0, 30_000);
    } finally { markers.forEach(marker => marker.style.removeProperty("display")); }
  }
  if (action === "point" || action === "focus" || action === "activePoint") {
    const element = action === "activePoint" ? document.activeElement : selector ? document.querySelector(selector) : undefined;
    if (!(element instanceof HTMLElement)) throw new Error("Element not found");
    if (action !== "activePoint") element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error("Element not visible");
    if (action === "focus") {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) || (element instanceof HTMLInputElement && ["file", "hidden", "password"].includes(element.type))) throw new Error("Field is not editable");
      element.focus();
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
      else { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  throw new Error("Unsupported page operation");
}
async function evaluate(current: Connection, access: Access, action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const value = await cdp(current, access, "Runtime.evaluate", { expression: `(${pageOperation.toString()})(${JSON.stringify(action)},${JSON.stringify(args)})`, returnByValue: true });
  if (value.exceptionDetails) throw new Error("Page operation failed");
  const result = (value.result as { value?: unknown } | undefined)?.value;
  if (result && typeof result === "object" && "blocked" in result && result.blocked === true) throw new AuthenticationRequired("Authentication requires manual control.");
  return result;
}
async function guard(current: Connection, access: Access): Promise<void> {
  if (connection !== current || current.revoked) throw new Error("Disconnected");
  await scopedTab(current, access.tabId, access);
  const result = await evaluate(current, access, "guard") as { blocked?: boolean } | undefined;
  if (!result || result.blocked) throw new AuthenticationRequired("Sign-in requires manual control. Browser access is paused.");
}
async function showAgentCursor(current: Connection, access: Access, x: number, y: number): Promise<void> {
  // A cosmetic marker must not turn a valid Agent action into a failed tool.
  // Authentication fencing still applies if a sign-in form appeared meanwhile.
  try { await evaluate(current, access, "showAgentCursor", { x, y }); }
  catch (error) { if (error instanceof AuthenticationRequired) throw error; }
}
async function clearAgentCursors(current: Connection): Promise<void> {
  const expression = `(${pageOperation.toString()})("clearAgentCursor",{})`;
  await Promise.allSettled(current.attached.map(tabId => chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression, returnByValue: true })));
}
async function execute(current: Connection, command: Command): Promise<unknown> {
  // Each command owns its original authority; Resume cannot refresh it.
  const access: Access = { epoch: command.connectionEpoch, deadline: command.expiresAt, tabId: current.tabId };
  const args = command.args;
  await pages(current, access);
  check(current, access);
  access.tabId = current.tabId;
  if (command.action === "pages") return pages(current, access);
  if (command.action === "newPage") {
    const tab = await chrome.tabs.create({ windowId: current.windowId, url: "about:blank", active: true });
    check(current, access);
    if (tab.id === undefined) throw new Error("Tab could not be created");
    current.tabId = tab.id;
    return pages(current, access);
  }
  if (command.action === "activatePage" || command.action === "closePage") {
    const tabId = Number(args.pageId);
    if (!Number.isSafeInteger(tabId)) throw new Error("Invalid tab");
    await scopedTab(current, tabId, access);
    check(current, access);
    if (command.action === "activatePage") {
      await chrome.tabs.update(tabId, { active: true }); check(current, access); current.tabId = tabId;
    } else {
      const state = await pages(current, access) as { pages: unknown[] };
      check(current, access);
      if (state.pages.length <= 1) throw new Error("Keep at least one connected tab open");
      if (current.attached.includes(tabId)) await detach(current, tabId);
      await scopedTab(current, tabId, access);
      check(current, access);
      await chrome.tabs.remove(tabId);
    }
    return pages(current, access);
  }
  if (args.pageId !== undefined) {
    const tabId = Number(args.pageId);
    if (!Number.isSafeInteger(tabId)) throw new Error("Invalid tab");
    await scopedTab(current, tabId, access);
    access.tabId = tabId;
  }
  await guard(current, access);
  if (command.action === "upload") {
    const pageId = String(access.tabId);
    const input = await upload((method, params) => cdp(current, access, method, params), pageId, args);
    await guard(current, access);
    return { ...(await evaluate(current, access, "info") as object), pageId, input };
  }
  if (command.action === "clearUploads") {
    await clearUploads((method, params) => cdp(current, access, method, params), String(access.tabId), typeof args.uploadId === "string" ? args.uploadId : undefined);
    return null;
  }
  if (command.action === "info" || command.action === "inspect") return evaluate(current, access, command.action, args);
  if (command.action === "capture") {
    await evaluate(current, access, "clearAgentCursor");
    const result = await cdp(current, access, "Page.captureScreenshot", { format: "png", fromSurface: true });
    await guard(current, access);
    return result.data;
  }
  if (command.action === "navigate") {
    if (typeof args.url !== "string" || !allowed(args.url)) throw new Error("Only application pages can be opened.");
    await cdp(current, access, "Page.navigate", { url: args.url }); return null;
  }
  if (command.action === "click" || command.action === "pointer") {
    const point = command.action === "click" ? await evaluate(current, access, "point", args) as { x: number; y: number } : { x: Number(args.x), y: Number(args.y) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) throw new Error("Invalid click");
    await guard(current, access);
    await showAgentCursor(current, access, point.x, point.y);
    await cdp(current, access, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await cdp(current, access, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    return null;
  }
  if (command.action === "type" || command.action === "fill") {
    if (typeof args.text !== "string" || args.text.length > 32_000) throw new Error("Text exceeds the local input limit");
    const point = command.action === "fill"
      ? await evaluate(current, access, "focus", args) as { x: number; y: number }
      : await evaluate(current, access, "activePoint").catch(error => { if (error instanceof AuthenticationRequired) throw error; return undefined; }) as { x: number; y: number } | undefined;
    await guard(current, access);
    if (point) await showAgentCursor(current, access, point.x, point.y);
    await cdp(current, access, "Input.insertText", { text: args.text }); return null;
  }
  if (command.action === "scroll") {
    if (![args.deltaX, args.deltaY].every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 4000)) throw new Error("Invalid scroll");
    await showAgentCursor(current, access, 100, 100);
    await cdp(current, access, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: args.deltaX, deltaY: args.deltaY }); return null;
  }
  if (command.action === "key") {
    const keys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 };
    let key = String(args.key), modifiers = 0;
    while (/^(Control|Meta|Alt|Shift)\+/.test(key)) {
      const prefix = key.slice(0, key.indexOf("+"));
      modifiers |= { Control: 2, Meta: 4, Alt: 1, Shift: 8 }[prefix] ?? 0;
      key = key.slice(prefix.length + 1);
    }
    if ((modifiers === 2 || modifiers === 4) && key.toLowerCase() === "a") {
      await cdp(current, access, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", commands: ["selectAll"] });
      await cdp(current, access, "Input.dispatchKeyEvent", { type: "keyUp", key: "a" }); return null;
    }
    if (["BrowserBack", "BrowserForward", "BrowserRefresh"].includes(key)) {
      if (key === "BrowserRefresh") { await cdp(current, access, "Page.reload"); return null; }
      const history = await cdp(current, access, "Page.getNavigationHistory") as { currentIndex: number; entries: { id: number; url: string }[] };
      const entry = history.entries[history.currentIndex + (key === "BrowserBack" ? -1 : 1)];
      if (!entry) return null;
      if (!allowed(entry.url)) throw new Error("Return to that site manually.");
      await cdp(current, access, "Page.navigateToHistoryEntry", { entryId: entry.id }); return null;
    }
    if (!(key in keys)) throw new Error("Use the local browser for this keyboard shortcut");
    await cdp(current, access, "Input.dispatchKeyEvent", { type: "rawKeyDown", key, modifiers, windowsVirtualKeyCode: keys[key] });
    await cdp(current, access, "Input.dispatchKeyEvent", { type: "keyUp", key, modifiers, windowsVirtualKeyCode: keys[key] }); return null;
  }
  throw new Error("Unsupported command");
}
async function loop(current: Connection): Promise<void> {
  try {
    while (connection === current && !current.revoked) {
      const command = await api(current, `connections/${current.id}/poll`) as Command | null;
      if (connection !== current || current.revoked) break;
      if (!command) continue;
      if (command.action === "disconnect") { await stop(); break; }
      if (current.paused || command.connectionEpoch !== current.epoch) continue;
      const epoch = current.epoch;
      let value: unknown, failed = false;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!Number.isFinite(command.expiresAt) || command.expiresAt <= Date.now()) throw new Error("Command expired");
        expiry = setTimeout(() => { if (!current.paused && current.epoch === epoch) revoke(current); }, Math.min(15_000, command.expiresAt - Date.now()));
        value = await execute(current, command);
      }
      catch (error) {
        if (error instanceof AuthenticationRequired || current.paused) { if (!current.paused) await pause(current); }
        else failed = true;
      }
      finally { clearTimeout(expiry); }
      if (connection !== current || current.revoked) break;
      if (current.paused || current.epoch !== epoch) continue;
      try { await api(current, `connections/${current.id}/result`, { id: command.id, value, failed }); }
      catch (error) { if (current.paused || current.epoch !== epoch) continue; throw error; }
      // Fail closed: no uncertain action is repeated or silently resumed.
      if (failed) { await stop(); break; }
    }
  } catch { if (connection === current) await stop(); }
}
async function connect(server: string, code: string): Promise<void> {
  if (connection || stopping) throw new Error("Disconnect the existing window first.");
  const origin = serverOrigin(server);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.windowId === undefined) throw new Error("Open the window you want to connect.");
  let paused = false;
  try { allowed(tab.url ?? ""); } catch { paused = true; }
  const probe: Connection = { server: origin, token: "", id: "", tabId: tab.id, windowId: tab.windowId, attached: [], paused, epoch: 0 };
  let current: Connection | undefined;
  try {
    const response = await fetch(`${origin}/api/local-browser/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, protocolVersion: 4, paused, url: paused ? "about:blank" : tab.url, title: paused ? "Local browser paused" : (tab.title ?? "Connected window").slice(0, 512) }), credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Pairing failed. Create a fresh code in Ponderosa.");
    const paired = await response.json() as { token: string; connection: { id: string } };
    current = { ...probe, token: paired.token, id: paired.connection.id };
    connection = current;
    await chrome.storage.session.set({ connection: current });
    await chrome.action.setBadgeBackgroundColor({ color: "#477a5b" });
    await chrome.action.setBadgeText({ text: paused ? "II" : "ON" });
    void loop(current).catch(() => revoke(current));
  } catch (error) {
    if (current) await stop(); else for (const id of [...probe.attached]) await detach(probe, id);
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/popup.html`)) return false;
  void (async () => {
    try {
      await initialized;
      if (message.action === "connect") {
        if (connecting) throw new Error("A connection is already being established.");
        connecting = true;
        try { await connect(String(message.server), String(message.code)); } finally { connecting = false; }
      }
      else if (message.action === "disconnect") await stop();
      else if (message.action === "pause" && connection) await pause(connection);
      else if (message.action === "resume" && connection) {
        if (resuming) await resuming;
        else { resuming = resume(connection); try { await resuming; } finally { resuming = undefined; } }
      }
      respond({ connected: Boolean(connection), paused: connection?.paused, revoked: connection?.revoked, error: connection?.revoked ? "Could not confirm disconnection. Close the connected window or retry disconnect." : connection && pausing ? "Pausing browser access. Wait for browser control to detach." : undefined, site: connection ? `window ${connection.windowId}` : undefined });
    } catch (error) { respond({ error: error instanceof Error ? error.message : "Connection failed" }); }
  })();
  return true;
});
chrome.tabs.onUpdated.addListener((id, changes) => {
  const current = connection;
  if (!current || !changes.url) return;
  void chrome.tabs.get(id).then(tab => {
    if (connection !== current || tab.windowId !== current.windowId) return;
    if (/^(chrome|edge):/.test(changes.url!)) {
      if (current.attached.includes(id)) void detach(current, id).catch(() => revoke(current));
      return;
    }
    try { allowed(changes.url!); } catch (error) { if (error instanceof AuthenticationRequired) void pause(current).catch(() => {}); }
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(id => { if (connection) connection.attached = connection.attached.filter(tabId => tabId !== id); });
chrome.tabs.onDetached.addListener((id, info) => { const current = connection; if (current && info.oldWindowId === current.windowId && current.attached.includes(id)) void detach(current, id).catch(() => revoke(current)); });
chrome.windows.onRemoved.addListener(id => { if (id === connection?.windowId) revoke(); });
chrome.debugger.onDetach.addListener(target => {
  const current = connection, tabId = target.tabId;
  if (!current || tabId === undefined || !current.attached.includes(tabId) || detaching.has(tabId)) return;
  void chrome.tabs.get(tabId).then(() => { if (connection === current && current.attached.includes(tabId)) revoke(); }).catch(() => {
    current.attached = current.attached.filter(id => id !== tabId);
  });
});
// Never silently restore authority after a worker/browser restart.
const initialized = chrome.storage.session.get("connection").then(async stored => {
  if (stored.connection) { connection = stored.connection as Connection; connection.attached ??= [connection.tabId]; await stop(); }
});
