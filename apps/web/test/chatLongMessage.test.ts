import { describe, expect, it } from "vitest";
import { collapsedLongMessagePreview } from "../src/components/chat/ChatMessages";

describe("collapsed long Chat messages", () => {
  it("bounds Markdown input without changing the complete source", () => {
    const source = Array.from({ length: 90 }, (_, index) =>
      `line-${index}-${"x".repeat(120)}`
    ).join("\n");
    const preview = collapsedLongMessagePreview(source);

    expect([...preview].length).toBeLessThanOrEqual(3_205);
    expect(preview).toContain("line-0-");
    expect(preview).not.toContain("line-89-");
    expect(preview.endsWith("…")).toBe(true);
    expect(source).toContain("line-89-");
  });

  it("leaves ordinary messages exact", () => {
    expect(collapsedLongMessagePreview("small message")).toBe("small message");
  });
});
