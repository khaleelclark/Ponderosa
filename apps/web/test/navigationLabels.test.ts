import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("launch navigation labels", () => {
  it("uses Title Case for representative tabs, buttons, and action-menu labels", () => {
    const sources = [
      readSource("../src/App.tsx"),
      readSource("../src/components/AgentDetail.tsx"),
      readSource("../src/components/AgentsTab.tsx"),
      readSource("../src/components/WorkspaceOverview.tsx"),
      readSource("../src/components/WorkspaceSidebar.tsx"),
      readSource("../src/components/WorkspaceTabs.tsx"),
      readSource("../src/components/panes.tsx"),
    ].join("\n");

    for (const label of [
      "New Project",
      "Work Log",
      "Files & Results",
      "Stop All",
      "Open in New Ponderosa Tab",
      "Project Browser",
      "Project Overview",
      "Rename Tab",
      "Close Other Tabs",
      "Show Exact Provider Input",
    ]) expect(sources).toContain(label);

    for (const retiredLabel of [
      ">New project<",
      'label: "Work log"',
      'label: "Files & results"',
      ">Stop all<",
      ">Open in new Ponderosa tab<",
      ">Project browser<",
      ">Project overview<",
      ">Close other tabs<",
    ]) expect(sources).not.toContain(retiredLabel);
  });

  it("does not reintroduce Home as a route or navigation destination", () => {
    const routing = readSource("../src/routing.ts");
    const sidebar = readSource("../src/components/WorkspaceSidebar.tsx");
    expect(routing).not.toContain('| { kind: "home" }');
    expect(sidebar).not.toContain('label="Home"');
  });
});
