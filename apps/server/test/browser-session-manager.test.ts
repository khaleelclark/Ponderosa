import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import {
  BrowserSessionError,
  BrowserSessionManager,
  chromeBrowserDriverFactory,
  initialBrowserTargetRequest,
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
    const artifactId = path.basename(screenshot.path, ".png");
    const managed = path.join(dataDir, "projects/project/artifacts/content", artifactId);
    expect(existsSync(managed)).toBe(true);
    expect(readFileSync(managed)).toEqual(png);
    expect(events).toContainEqual(expect.objectContaining({ type: "browser_screenshot", executionId: "run", path: screenshot.path }));

    await manager.closeRun(scope, "run_completed");
    expect(manager.get("agent")).toMatchObject({ status: "closed" });
    expect(events.at(-1)).toMatchObject({ type: "browser_session", status: "closed", reason: "run_completed" });
  });

  it("can open an operator-owned persistent surface without changing Run defaults", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const manager = new BrowserSessionManager(dataDir, async () => fakeDriver(), () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "project-browser:project", runId: "project:project" };

    expect(await manager.open(scope, "https://example.com", "operator")).toMatchObject({ controlOwner: "operator", url: "https://example.com/" });
    expect(await manager.open(scope, "https://example.com/next", "operator")).toMatchObject({ controlOwner: "operator", url: "https://example.com/next" });
  });

  it("retains a failed browser close handle for an exact cleanup retry", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const driver = fakeDriver();
    let failClose = true;
    driver.close = vi.fn(async () => {
      if (failClose) throw new Error("simulated browser close failure");
    });
    const manager = new BrowserSessionManager(dataDir, async () => driver, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "project-browser:project", runId: "project:project" };
    await manager.open(scope);

    await expect(manager.close(scope, "project_deleted")).rejects.toThrow(/simulated browser close failure/);
    expect(manager.get(scope.agentId)).toMatchObject({ status: "closed" });
    failClose = false;
    await expect(manager.close(scope, "project_deleted")).resolves.toMatchObject({ status: "closed" });
    expect(driver.close).toHaveBeenCalledTimes(2);
  });

  it("retains a spawn-time browser handle when readiness and its first cleanup fail", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    let failClose = true;
    const handle = {
      close: vi.fn(async () => {
        if (failClose) throw new Error("simulated spawn-handle close failure");
      }),
    };
    const manager = new BrowserSessionManager(dataDir, async (_sessionId, _onConsole, onSpawned) => {
      onSpawned?.(handle);
      throw new Error("simulated browser readiness failure");
    }, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "project-browser:project", runId: "project:project" };

    await expect(manager.open(scope)).rejects.toThrow(/browser readiness and cleanup failed/);
    expect(manager.authorityStatus()).toMatchObject({ pendingCleanup: 1, retainedFailures: 1 });
    failClose = false;
    await expect(manager.close(scope, "cleanup_retry")).resolves.toMatchObject({ status: "closed" });
    expect(handle.close).toHaveBeenCalledTimes(2);
    expect(manager.authorityStatus()).toMatchObject({ openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 });
  });

  it("refuses a replacement open until the original failed spawn handle is observed closed", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    let failOriginalClose = true;
    const originalHandle = {
      close: vi.fn(async () => {
        if (failOriginalClose) throw new Error("original browser process is still alive");
      }),
    };
    const replacement = fakeDriver();
    let factoryCalls = 0;
    const manager = new BrowserSessionManager(dataDir, async (_sessionId, _onConsole, onSpawned) => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        onSpawned?.(originalHandle);
        throw new Error("simulated readiness failure");
      }
      return replacement;
    }, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "project-browser:project", runId: "project:project" };

    await expect(manager.open(scope)).rejects.toThrow(/readiness and cleanup failed/);
    await expect(manager.open(scope)).rejects.toThrow(/original browser process is still alive/);
    expect(factoryCalls).toBe(1);
    expect(originalHandle.close).toHaveBeenCalledTimes(2);
    expect(manager.authorityStatus()).toMatchObject({
      openings: 0, active: 0, pendingCleanup: 1, retainedFailures: 1,
    });

    failOriginalClose = false;
    await expect(manager.open(scope)).resolves.toMatchObject({ status: "ready" });
    expect(factoryCalls).toBe(2);
    expect(originalHandle.close).toHaveBeenCalledTimes(3);
    expect(manager.authorityStatus()).toMatchObject({
      openings: 0, active: 1, pendingCleanup: 0, retainedFailures: 0,
    });
  });

  it("observes a handle published after close starts without awaiting unresolved readiness", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const factoryStarted = deferred<void>();
    const closeStarted = deferred<void>();
    const closeFinished = deferred<void>();
    let publish!: (handle: { close(): Promise<void> }) => void;
    const handle = {
      close: vi.fn(async () => {
        closeStarted.resolve();
        await closeFinished.promise;
      }),
    };
    const manager = new BrowserSessionManager(dataDir, async (_sessionId, _onConsole, onSpawned) => {
      publish = onSpawned!;
      factoryStarted.resolve();
      return new Promise<BrowserDriver>(() => undefined);
    }, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "project-browser:project", runId: "project:project" };

    void manager.open(scope);
    await factoryStarted.promise;
    const closing = manager.closeProject(scope.projectId, "project_deleted");
    await Promise.resolve();
    expect(manager.authorityStatus()).toMatchObject({ openings: 1, active: 0, retainedFailures: 0 });

    publish(handle);
    await closeStarted.promise;
    expect(manager.authorityStatus()).toMatchObject({ openings: 1, active: 0, pendingCleanup: 1 });
    closeFinished.resolve();
    await closing;

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(manager.get(scope.agentId)).toMatchObject({ status: "closed" });
    expect(manager.authorityStatus()).toEqual({ openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 });
  });

  it("retains a failed late handle and blocks replacement until retry observes shutdown", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const factoryStarted = deferred<void>();
    const retryClose = deferred<void>();
    let publish!: (handle: { close(): Promise<void> }) => void;
    let closeAttempts = 0;
    const handle = {
      close: vi.fn(async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("late browser process is still alive");
        await retryClose.promise;
      }),
    };
    const replacement = fakeDriver();
    let factoryCalls = 0;
    const manager = new BrowserSessionManager(dataDir, async (_sessionId, _onConsole, onSpawned) => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        publish = onSpawned!;
        factoryStarted.resolve();
        return new Promise<BrowserDriver>(() => undefined);
      }
      return replacement;
    }, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "project-browser:project", runId: "project:project" };

    void manager.open(scope);
    await factoryStarted.promise;
    const firstClose = manager.close(scope, "operator_closed");
    publish(handle);
    await expect(firstClose).rejects.toThrow(/late browser process is still alive/);
    expect(manager.authorityStatus()).toEqual({ openings: 0, active: 0, pendingCleanup: 1, retainedFailures: 1 });

    const replacing = manager.open(scope);
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(2));
    expect(factoryCalls).toBe(1);
    expect(manager.authorityStatus()).toMatchObject({ active: 0, pendingCleanup: 1, retainedFailures: 1 });
    retryClose.resolve();
    await expect(replacing).resolves.toMatchObject({ status: "ready" });

    expect(factoryCalls).toBe(2);
    expect(handle.close).toHaveBeenCalledTimes(2);
    expect(manager.authorityStatus()).toEqual({ openings: 0, active: 1, pendingCleanup: 0, retainedFailures: 0 });
  });

  it("coalesces concurrent replacement and close cleanup for a late failed handle", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const factoryStarted = deferred<void>();
    const retryClose = deferred<void>();
    let publish!: (handle: { close(): Promise<void> }) => void;
    let closeAttempts = 0;
    const handle = {
      close: vi.fn(async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("late close failed once");
        await retryClose.promise;
      }),
    };
    let factoryCalls = 0;
    const manager = new BrowserSessionManager(dataDir, async (_sessionId, _onConsole, onSpawned) => {
      factoryCalls += 1;
      publish = onSpawned!;
      factoryStarted.resolve();
      return new Promise<BrowserDriver>(() => undefined);
    }, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "project-browser:project", runId: "project:project" };

    void manager.open(scope);
    await factoryStarted.promise;
    const firstClose = manager.close(scope, "operator_closed");
    publish(handle);
    await expect(firstClose).rejects.toThrow(/late close failed once/);

    const replacing = manager.open(scope);
    const concurrentClose = manager.close(scope, "project_deleted");
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(2));
    expect(manager.authorityStatus()).toMatchObject({ active: 0, pendingCleanup: 1, retainedFailures: 1 });
    retryClose.resolve();

    await expect(replacing).rejects.toThrow(/changed while replacement cleanup was running/);
    await expect(concurrentClose).resolves.toMatchObject({ status: "closed" });
    expect(factoryCalls).toBe(1);
    expect(handle.close).toHaveBeenCalledTimes(2);
    expect(manager.authorityStatus()).toEqual({ openings: 0, active: 0, pendingCleanup: 0, retainedFailures: 0 });
  });

  it("accepts only non-credentialed http(s) navigation", () => {
    expect(validateBrowserUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(() => validateBrowserUrl("file:///etc/passwd")).toThrow(BrowserSessionError);
    expect(() => validateBrowserUrl("https://user:secret@example.com")).toThrow(/credentialed/);
  });

  it("rejects CDP startup when the browser exits without an unhandled pipe error", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const createDriver = chromeBrowserDriverFactory(dataDir, process.execPath);

    await expect(createDriver("exiting-browser", () => undefined)).rejects.toThrow();
  });

  it("creates a Chrome target without window-only position or size options", () => {
    expect(initialBrowserTargetRequest()).toEqual({ url: "about:blank" });
    expect(initialBrowserTargetRequest()).not.toHaveProperty("newWindow");
    expect(initialBrowserTargetRequest()).not.toHaveProperty("width");
    expect(initialBrowserTargetRequest()).not.toHaveProperty("height");
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

  it("strips redirect-introduced URL userinfo and never makes it reconnectable", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const events: AgentEvent[] = [];
    const navigations: string[] = [];
    const redirected = "https://redirect-user:redirect-password@example.com/account";
    const first = fakeDriver();
    first.navigate = async (url) => {
      navigations.push(url);
      return { url: redirected, title: `Account at ${redirected}` };
    };
    first.pageInfo = async () => ({ url: redirected, title: `Account at ${redirected}` });
    first.inspect = async () => JSON.stringify({ url: redirected, title: `Account at ${redirected}` });
    const second = fakeDriver();
    second.navigate = async (url) => { navigations.push(url); return { url, title: "Unexpected replay" }; };
    const drivers = [first, second];
    const manager = new BrowserSessionManager(dataDir, async () => drivers.shift()!, (_scope, event) => events.push(event));
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run" };

    const opened = await manager.open(scope, "https://example.com/start");
    expect(opened).toMatchObject({ url: "https://example.com/account", title: "Account at https://example.com/account" });
    expect(await manager.inspect(scope)).not.toMatch(/redirect-user|redirect-password/);
    expect(JSON.stringify(events)).not.toMatch(/redirect-user|redirect-password/);

    expect((await manager.reconnect(scope)).url).toBe("about:blank");
    expect(navigations).toEqual(["https://example.com/start"]);
  });

  it("recursively redacts inspect credentials while retaining harmless snapshot text", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-browser-"));
    roots.push(dataDir);
    const driver = fakeDriver();
    driver.pageInfo = async () => ({
      url: "https://example.com/dashboard",
      title: "Token pricing and authorization guide",
    });
    driver.inspect = async () => JSON.stringify({
      url: "https://files.example/download?X-Amz-Signature=signed-secret&part=1#fragment-secret",
      title: "OAuth code: title-secret",
      text: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature authorization=Bearer second.long.token access_token=body-secret&display=visible Token pricing remains visible.",
      controls: [
        { selector: "#refresh", text: "Refresh token: control-secret" },
        { selector: "#guide", text: "Authorization guide" },
      ],
      region: { description: "Safe docs https://example.com/docs?topic=tokenization", nested: ["client_secret=nested-secret"] },
    });
    const manager = new BrowserSessionManager(dataDir, async () => driver, () => undefined);
    const scope: BrowserScope = { projectId: "project", agentId: "agent", runId: "run" };

    await manager.open(scope);
    const snapshot = await manager.inspect(scope);
    expect(snapshot).not.toMatch(/signed-secret|fragment-secret|title-secret|body-secret|control-secret|nested-secret|eyJhbGci/);
    expect(snapshot).toContain("X-Amz-Signature=%5BREDACTED%5D");
    expect(snapshot).toContain("part=1");
    expect(snapshot).toContain("display=visible");
    expect(snapshot).toContain("Token pricing remains visible.");
    expect(snapshot).toContain("Authorization guide");
    expect(snapshot).toContain("https://example.com/docs?topic=tokenization");
    expect(snapshot).toContain('"selector": "#refresh"');
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
    const closing = manager.close(scope, "run_completed");
    let closeSettled = false;
    void closing.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    factory.resolve(driver);
    await rejected;
    await closing;
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
