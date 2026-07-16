import type { BrowserSessionDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { browserControlLabel } from "../src/components/BrowserPanel";

const session: BrowserSessionDto = {
  id: "browser", projectId: "project", agentId: "agent", runId: "run",
  status: "ready", controlOwner: "agent", controlEpoch: 1, frameRevision: 0,
  openedAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z",
};

describe("interactive browser control ownership", () => {
  it("uses unambiguous operator-facing ownership labels", () => {
    expect(browserControlLabel(session)).toBe("Agent has control");
    expect(browserControlLabel({ ...session, controlOwner: "operator" })).toBe("You have control");
  });
});
