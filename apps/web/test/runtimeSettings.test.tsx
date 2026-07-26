// @vitest-environment node

import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { parseAgentRunConcurrencyLimit, RuntimeSettings } from "../src/components/RuntimeSettings";

describe("RuntimeSettings", () => {
  it("accepts only the server-supported whole-number range", () => {
    expect(parseAgentRunConcurrencyLimit("1")).toBe(1);
    expect(parseAgentRunConcurrencyLimit("64")).toBe(64);
    for (const value of ["", "0", "65", "1.5", "many"]) {
      expect(parseAgentRunConcurrencyLimit(value)).toBeUndefined();
    }
  });

  it("explains live scheduler behavior and keeps technical safety caps system-owned", () => {
    const view = create(<RuntimeSettings value="8" onChange={vi.fn()} />);
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain("Maximum concurrent Agent Runs");
    expect(rendered).toContain("Active Runs finish normally");
    expect(rendered).toContain("queued work keeps its scheduler order");
    expect(rendered).toContain("safety limits remain system-managed");
    view.unmount();
  });
});
