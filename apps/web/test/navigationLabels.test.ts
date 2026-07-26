import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("launch navigation labels", () => {
  it("uses Title Case for representative tabs, buttons, and action-menu labels", () => {
    const sources = [
      readSource("../src/App.tsx"),
      readSource("../src/components/AgentDetail.tsx"),
      readSource("../src/components/AgentsTab.tsx"),
      readSource("../src/components/ProjectOverview.tsx"),
      readSource("../src/components/WorkspaceOverview.tsx"),
      readSource("../src/components/WorkspaceSidebar.tsx"),
      readSource("../src/components/WorkspaceTabs.tsx"),
    ].join("\n");

    for (const label of [
      "New Project",
      "Files & Results",
      "Stop All",
      "Interactive Browser",
      "Project Overview",
      "Rename Tab",
      "Close Other Tabs",
    ]) expect(sources).toContain(label);

    for (const retiredLabel of [
      ">New project<",
      'label: "Work log"',
      'label: "Files & results"',
      ">Stop all<",
      ">Open in new Ponderosa tab<",
      ">Interactive browser<",
      ">Project overview<",
      ">Close other tabs<",
    ]) expect(sources).not.toContain(retiredLabel);
  });

  it("keeps Home and Messages as distinct destinations", () => {
    const routing = readSource("../src/routing.ts");
    const sidebar = readSource("../src/components/WorkspaceSidebar.tsx");
    expect(routing).toContain('| { kind: "home" }');
    expect(routing).toContain('| { kind: "allChat" }');
    expect(sidebar).toContain('label="Home"');
  });
});
