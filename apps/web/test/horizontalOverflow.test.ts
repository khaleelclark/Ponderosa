import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalCss = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");
const projectShell = readFileSync(new URL("../src/components/ProjectShell.tsx", import.meta.url), "utf8");
const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");

describe("horizontal overflow containment", () => {
  it("constrains the app root and every responsive project shell to the viewport width", () => {
    expect(globalCss).toMatch(/#root\s*\{[^}]*overflow:\s*hidden;/s);
    expect(globalCss).toMatch(/html,\s*body,\s*#root\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);

    const constrainedShell = 'width: "100%", maxWidth: "100%", minHeight: 0, minWidth: 0, overflow: "hidden"';
    expect(projectShell.split(constrainedShell)).toHaveLength(4);
  });

  it("retains local horizontal scrolling for wide code, tables, and task output", () => {
    expect(panes).toContain('"& pre": { p: 1.25, overflowX: "auto"');
    expect(panes).toContain('"& table": { display: "block", maxWidth: "100%", overflowX: "auto"');
    expect(panes).toContain('data-testid="workspace-diff" sx={{ overflow: "auto", minWidth: 0');
  });
});
