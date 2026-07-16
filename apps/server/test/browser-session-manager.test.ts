import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import {
  BrowserSessionError,
  BrowserSessionManager,
  redactBrowserUrl,
  validateBrowserUrl,
  type BrowserDriver,
  type BrowserScope,
} from "../src/browser-session-manager.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeDriver(): BrowserDriver {
  let url = "about:blank";
  const info = () => ({ url, title: url === "about:blank" ? "Blank" : "Example" });
  return {
    pageInfo: async () => info(),
    navigate: async (next) => { url = next; return info(); },
    inspect: async () => JSON.stringify({ url, controls: [{ selector: "#go", text: "Go" }] }),
    click: async () => info(),
    fill: async () => info(),
    key: async () => info(),
    pointer: async () => info(),
    type: async () => info(),
    scroll: async () => info(),
    capture: async () => png,
    close: vi.fn(async () => undefined),
  };
}

describe("run-scoped browser sessions", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("fences ownership, rejects foreign scope, persists explicit screenshots, and tears down", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const events: AgentEvent[] = [];
    const manager = new BrowserSessionManager(dataDir, async () => fakeDriver(), (_scope, event) => events.push(event));
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run", conversationId: "chat" };

    const opened = await manager.open(scope, "https://example.com/start");
    expect(opened).toMatchObject({ status: "ready", controlOwner: "agent", controlEpoch: 1, url: "https://example.com/start" });
    await expect(manager.inspect({ ...scope, runId: "foreign" })).rejects.toMatchObject({ statusCode: 404 });

    const operator = await manager.setControl(scope, "operator", opened.controlEpoch);
    expect(operator).toMatchObject({ controlOwner: "operator", controlEpoch: 2 });
    await expect(manager.act(scope, { action: "click", selector: "#go" })).rejects.toThrow(/operator/);
    await expect(manager.operatorInput(scope, { kind: "click", x: 20, y: 30, expectedControlEpoch: 1 })).rejects.toThrow(/another tab/);
    await manager.operatorInput(scope, { kind: "click", x: 20, y: 30, expectedControlEpoch: 2 });

    await manager.setControl(scope, "agent", 2);
    const screenshot = await manager.captureArtifact(scope);
    expect(screenshot.path).toMatch(/^browser\//);
    expect(existsSync(path.join(dataDir, "projects/project/agents/agent/artifacts", screenshot.path))).toBe(true);
    expect(readFileSync(path.join(dataDir, "projects/project/agents/agent/artifacts", screenshot.path))).toEqual(png);
    expect(events).toContainEqual(expect.objectContaining({ type: "browser_screenshot", executionId: "run", path: screenshot.path }));

    await manager.closeRun(scope, "run_completed");
    expect(manager.get("agent")).toMatchObject({ status: "closed" });
    expect(events.at(-1)).toMatchObject({ type: "browser_session", status: "closed", reason: "run_completed" });
  });

  it("accepts only non-credentialed http(s) navigation", () => {
    expect(validateBrowserUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(() => validateBrowserUrl("file:///etc/passwd")).toThrow(BrowserSessionError);
    expect(() => validateBrowserUrl("https://user:secret@example.com")).toThrow(/credentialed/);
  });

  it("redacts credential-bearing current and redirect URLs before DTOs, audit, and snapshots", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const events: AgentEvent[] = [];
    let current = "about:blank";
    const navigations: string[] = [];
    const first = fakeDriver();
    first.navigate = async (url) => {
      navigations.push(url);
      current = "https://client.example/callback?code=oauth-code&state=oauth-state&safe=visible#access_token=fragment-token";
      return { url: current, title: `Signed in at ${current}` };
    };
    first.pageInfo = async () => ({ url: current, title: `Signed in at ${current}` });
    first.inspect = async () => JSON.stringify({ url: current, controls: [] });
    const second = fakeDriver();
    second.navigate = async (url) => { navigations.push(url); return { url, title: "Replayed" }; };
    const drivers = [first, second];
    const manager = new BrowserSessionManager(dataDir, async () => drivers.shift()!, (_scope, event) => events.push(event));
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run" };

    expect(redactBrowserUrl("https://example.com/path?access_token=top-secret&safe=value#id_token=fragment")).toEqual({
      url: "https://example.com/path?access_token=%5BREDACTED%5D&safe=value",
    });
    const opened = await manager.open(scope, "https://identity.example/authorize?client_id=public#prompt=login");
    expect(JSON.stringify(opened)).not.toContain("oauth-code");
    expect(opened.url).toContain("code=%5BREDACTED%5D");
    expect(opened.url).not.toContain("fragment-token");
    expect(await manager.inspect(scope)).not.toContain("oauth-state");
    expect(JSON.stringify(events)).not.toMatch(/oauth-code|oauth-state|fragment-token/);

    const reconnected = await manager.reconnect(scope);
    expect(reconnected.url).toBe("about:blank");
    expect(navigations).toEqual(["https://identity.example/authorize?client_id=public#prompt=login"]);
  });

  it("replays only a sanitized non-sensitive URL and never its fragment", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const navigations: string[] = [];
    const manager = new BrowserSessionManager(dataDir, async () => {
      const driver = fakeDriver();
      let current = "about:blank";
      driver.navigate = async (url) => { navigations.push(url); current = url; return { url, title: "Page" }; };
      driver.pageInfo = async () => ({ url: current, title: "Page" });
      return driver;
    }, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run" };

    expect((await manager.open(scope, "https://example.com/results?page=2#private-route")).url).toBe("https://example.com/results?page=2");
    await manager.reconnect(scope);
    expect(navigations).toEqual([
      "https://example.com/results?page=2#private-route",
      "https://example.com/results?page=2",
    ]);
  });

  it("shares concurrent opens and closes a late driver without orphaning it", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const factory = deferred<BrowserDriver>();
    const driver = fakeDriver();
    const create = vi.fn(async () => factory.promise);
    const manager = new BrowserSessionManager(dataDir, create, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run" };

    const first = manager.open(scope);
    const second = manager.open(scope);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    const rejected = expect(first).rejects.toThrow(/closed while it was opening/);
    await manager.close(scope, "run_completed");
    factory.resolve(driver);
    await rejected;
    expect(driver.close).toHaveBeenCalledTimes(1);
    expect(manager.get(scope.agentId)).toMatchObject({ status: "closed" });
  });

  it("serializes control transfer and fences queued work by control epoch", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const click = deferred<{ url: string; title: string }>();
    const started = deferred<void>();
    const driver = fakeDriver();
    driver.click = vi.fn(async () => { started.resolve(); return click.promise; });
    const events: AgentEvent[] = [];
    const manager = new BrowserSessionManager(dataDir, async () => driver, (_scope, event) => events.push(event));
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run" };
    await manager.open(scope);

    const inFlight = manager.act(scope, { action: "click", selector: "#first" });
    await started.promise;
    let transferred = false;
    const transfer = manager.setControl(scope, "operator", 1).then((value) => { transferred = true; return value; });
    const staleQueued = manager.act(scope, { action: "click", selector: "#stale" });
    await Promise.resolve();
    expect(transferred).toBe(false);
    click.resolve({ url: "https://example.com/after-agent", title: "After agent" });
    await expect(inFlight).resolves.toMatchObject({ controlOwner: "agent", url: "https://example.com/after-agent" });
    await expect(transfer).resolves.toMatchObject({ controlOwner: "operator", controlEpoch: 2 });
    await expect(staleQueued).rejects.toThrow(/controlled by the operator|another tab/);
    expect(driver.click).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "browser_action").map((event) => event.action)).toEqual(["click", "control"]);
  });

  it("rejects completion from an action fenced by teardown", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const click = deferred<{ url: string; title: string }>();
    const started = deferred<void>();
    const driver = fakeDriver();
    driver.click = vi.fn(async () => { started.resolve(); return click.promise; });
    const events: AgentEvent[] = [];
    const manager = new BrowserSessionManager(dataDir, async () => driver, (_scope, event) => events.push(event));
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run" };
    await manager.open(scope);

    const action = manager.act(scope, { action: "click", selector: "#late" });
    await started.promise;
    await manager.close(scope, "run_failed");
    click.resolve({ url: "https://example.com/too-late?code=secret", title: "Too late" });
    await expect(action).rejects.toThrow(/session changed/);
    expect(manager.get(scope.agentId)).toMatchObject({ status: "closed" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "browser_action", action: "click" }));
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it("coalesces multi-tab frames and reconnects the same owned session", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const captures: Array<ReturnType<typeof vi.fn>> = [];
    const drivers: BrowserDriver[] = [];
    const manager = new BrowserSessionManager(dataDir, async () => {
      const driver = fakeDriver();
      const capture = vi.fn(async () => png);
      driver.capture = capture;
      captures.push(capture);
      drivers.push(driver);
      return driver;
    }, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run", conversationId: "chat" };

    const opened = await manager.open(scope, "https://example.com/live");
    const [firstTab, secondTab] = await Promise.all([
      manager.captureFrame(scope),
      manager.captureFrame(scope),
    ]);
    expect(firstTab.revision).toBe(secondTab.revision);
    expect(captures[0]).toHaveBeenCalledTimes(1);

    const reconnected = await manager.reconnect(scope);
    expect(reconnected).toMatchObject({
      id: opened.id,
      status: "ready",
      controlOwner: "agent",
      controlEpoch: opened.controlEpoch + 1,
      url: "https://example.com/live",
    });
    expect(drivers).toHaveLength(2);
    expect(drivers[0]!.close).toHaveBeenCalledTimes(1);
  });
});
