import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("persistent Project browser surfaces", () => {
  it("makes the Project browser globally reachable and keeps link choice explicit", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
    expect(app).toContain('aria-label="Open Project browser"');
    expect(app).toContain("ProjectBrowserContext.Provider");
    expect(panes).toContain("projectBrowser.open(link.url.href)");
    expect(panes).toContain("Open in Ponderosa");
    expect(panes).toContain("Open externally");
  });

  it("keeps operator control explicit and lends it only through an active-agent selector", () => {
    const dialog = readFileSync(new URL("../src/components/ProjectBrowserDialog.tsx", import.meta.url), "utf8");
    expect(dialog).toContain("Give {agent.title} control");
    expect(dialog).toContain('owner: "agent"');
    expect(dialog).toContain("Take control back");
    expect(dialog).toContain("Start an agent Run to make it available");
  });
});
