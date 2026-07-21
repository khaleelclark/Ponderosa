import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Wiki app integration", () => {
  it("mounts the Wiki view for the global wiki route", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.tsx", import.meta.url), "utf8");
    const wiki = readFileSync(new URL("../src/components/WikiView.tsx", import.meta.url), "utf8");
    expect(app).toContain('import { WikiView } from "./components/WikiView"');
    expect(app).toContain('route.kind === "wiki" ? (');
    expect(app).toContain("<WikiView articleId={route.articleId} navigate={navigateWorkspace} />");
    expect(sidebar).toContain('aria-label="Wiki navigation"');
    expect(wiki).not.toContain('component="nav" aria-label="Wiki navigation"');
  });
});
