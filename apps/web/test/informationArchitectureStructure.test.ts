import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("workspace information architecture", () => {
  it("uses the detailed roster for global and Project-filtered Agents", () => {
    const workspace = read("../src/components/WorkspaceResourceViews.tsx");
    expect(workspace).toContain("<AgentsTab");
    expect(workspace).toContain('<MenuItem value="">All Projects</MenuItem>');
    expect(workspace).toContain('useEffect(() => setProjectId(filterProjectId ?? ""), [filterProjectId]);');
    expect(workspace).not.toContain('gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))"');
    expect(workspace).toContain('selectionAllowed={Boolean(projectId)}');
    expect(workspace).toContain('onReorder={sort === "custom"');
  });

  it("keeps Agent actions in the vertical overflow menu", () => {
    const roster = read("../src/components/AgentsTab.tsx");
    for (const label of ["Stop All", "Select Agents", "Import Agent or Organization", "New Agent"]) {
      expect(roster).toContain(label);
    }
    expect(roster).toContain('aria-label="Agent actions"');
  });

  it("keeps command logs out of Files & Results", () => {
    const panes = read("../src/components/panes.tsx");
    expect(panes).toContain('artifacts.filter((artifact) => artifact.kind !== "log")');
    expect(panes).toContain("command output is available in Activity");
  });
});
