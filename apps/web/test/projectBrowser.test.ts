import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { projectBrowserAdapter, runBrowserAdapter } from "../src/components/browser/browserAdapters";
import { consumeProjectBrowserRequest } from "../src/components/ProjectBrowserContext";

describe("persistent Project browser surfaces", () => {
  it("adapts Project and Run endpoints without weakening the control epoch fence", async () => {
    const projectControl = vi.spyOn(api, "setProjectBrowserControl").mockResolvedValue({} as never);
    const runInput = vi.spyOn(api, "sendBrowserInput").mockResolvedValue({} as never);
    await projectBrowserAdapter("project / 1").setControl({ owner: "agent", agentId: "agent-1" }, 17);
    await runBrowserAdapter("project-1", "agent-1", "run-1").sendInput({ kind: "click", x: 10, y: 20 }, 23);
    expect(projectControl).toHaveBeenCalledWith("project / 1", { owner: "agent", agentId: "agent-1", expectedControlEpoch: 17 });
    expect(runInput).toHaveBeenCalledWith("project-1", "agent-1", "run-1", { kind: "click", x: 10, y: 20, expectedControlEpoch: 23 });
  });

  it("consumes link-open requests so remounting cannot replay stale navigation", () => {
    const request = { requestId: 7, url: "https://example.com/review" };
    const consumed = consumeProjectBrowserRequest(request, 7);
    expect(consumed).toBeUndefined();
    expect(consumeProjectBrowserRequest(consumed, 7)).toBeUndefined();
    expect(consumeProjectBrowserRequest(request, 6)).toBe(request);
  });
});
