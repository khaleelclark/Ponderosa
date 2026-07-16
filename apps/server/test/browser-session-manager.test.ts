import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import {
  BrowserSessionError,
  BrowserSessionManager,
  validateBrowserUrl,
  type BrowserDriver,
  type BrowserScope,
} from "../src/browser-session-manager.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");

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
