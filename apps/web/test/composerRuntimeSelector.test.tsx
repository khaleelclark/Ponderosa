import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComposerRuntimeSelector } from "../src/components/ComposerRuntimeSelector";

describe("composer runtime selector", () => {
  it("summarizes engine, model, and effort in one accessible control", () => {
    const html = renderToStaticMarkup(<ComposerRuntimeSelector
      engine="codex"
      engines={[{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }]}
      model="gpt-5.6-sol"
      models={[{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }]}
      effort="high"
      efforts={[{ id: "high", label: "High" }]}
      onEngineChange={vi.fn()}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
    />);

    expect(html).toContain('aria-label="Choose engine, model, and effort"');
    expect(html).toContain(">Codex</");
    expect(html).toContain(">GPT-5.6 Sol</");
    expect(html).toContain(">High</");
    expect(html).not.toContain("Speed");
  });
});
