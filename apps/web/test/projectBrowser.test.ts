import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("persistent Project browser surfaces", () => {
  it("makes the Project browser globally reachable and keeps link choice explicit", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
    expect(app).toContain('aria-label="Open Project browser"');
    expect(app).toContain("ProjectBrowserContext.Provider");
    expect(app).toContain('openWorkspaceRoute({ kind: "browser"');
    expect(app).not.toContain("projectBrowserOpen");
    expect(panes).toContain("projectBrowser.open(link.url.href)");
    expect(panes).toContain("Open in Ponderosa");
    expect(panes).toContain("Open externally");
  });

  it("shows run browser activity only after a real session exists and routes it to a workspace tab", () => {
    const panel = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");
    const shell = readFileSync(new URL("../src/components/ProjectShell.tsx", import.meta.url), "utf8");
    expect(panel).toContain('if (!runId || !session || missing || session.status === "closed") {');
    expect(panel).toContain("This Run’s interactive browser is no longer active.");
    expect(panel).toContain(": null;");
    expect(panel).toContain("Interactive browser in use");
    expect(panel).toContain("Open tab");
    expect(shell).toContain('kind: "browser"');
  });

  it("keeps operator control explicit and lends it only through an active-agent selector", () => {
    const dialog = readFileSync(new URL("../src/components/ProjectBrowserDialog.tsx", import.meta.url), "utf8");
    expect(dialog).toContain("Give {agent.title} control");
    expect(dialog).toContain('owner: "agent"');
    expect(dialog).toContain("Take control back");
    expect(dialog).toContain("Start an agent Run to make it available");
  });
});
