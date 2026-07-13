import { describe, expect, it } from "vitest";
import { summarizeActivityText } from "../src/components/panes";

describe("activity summaries", () => {
  it("collapses multiline output and bounds large payloads", () => {
    expect(summarizeActivityText("one\n  two\nthree", 80)).toBe("one two three");
    const summary = summarizeActivityText("x".repeat(1_000), 40);
    expect(summary).toHaveLength(40);
    expect(summary.endsWith("…")).toBe(true);
  });
});
