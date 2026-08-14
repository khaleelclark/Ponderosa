import { describe, expect, it } from "vitest";
import { ContextUsageObservationGate } from "./codex-app-server.js";

describe("Codex native compact context observation", () => {
  it("does not accept the command response before the later usage notification", async () => {
    const gate = new ContextUsageObservationGate();
    const beforeCommand = gate.currentVersion();
    let settled = false;
    const observed = gate.waitAfter(beforeCommand, 1_000).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    gate.observe();
    await observed;
    expect(settled).toBe(true);
    expect(gate.currentVersion()).toBe(beforeCommand + 1);
  });
});
