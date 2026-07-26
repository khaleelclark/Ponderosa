import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { projectBrowserAdapter } from "../src/components/browser/browserAdapters";
import { consumeProjectBrowserRequest } from "../src/components/ProjectBrowserContext";

describe("persistent Project browser surfaces", () => {
  it("adapts Project endpoints without weakening the control epoch fence", async () => {
    const projectControl = vi.spyOn(api, "setProjectBrowserControl").mockResolvedValue({} as never);
    await projectBrowserAdapter("project / 1").setControl({ owner: "agent", agentId: "agent-1" }, 17);
    expect(projectControl).toHaveBeenCalledWith("project / 1", { owner: "agent", agentId: "agent-1", expectedControlEpoch: 17 });
  });

  it("consumes link-open requests so remounting cannot replay stale navigation", () => {
    const request = { requestId: 7, url: "https://example.com/review" };
    const consumed = consumeProjectBrowserRequest(request, 7);
    expect(consumed).toBeUndefined();
    expect(consumeProjectBrowserRequest(consumed, 7)).toBeUndefined();
    expect(consumeProjectBrowserRequest(request, 6)).toBe(request);
  });
});
