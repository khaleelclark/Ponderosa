import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Ponderosa branding", () => {
  it("uses the supplied Rounded marks across navigation, themes, and install surfaces", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.tsx", import.meta.url), "utf8");
    const build = readFileSync(new URL("../rsbuild.config.ts", import.meta.url), "utf8");

    expect(existsSync(new URL("../public/icons/app-icon.png", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../public/icons/app-icon-inverted.png", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../public/icons/maskable-icon.png", import.meta.url))).toBe(true);
    expect(app).toContain('/icons/app-icon.png');
    expect(app).toContain('/icons/app-icon-inverted.png');
    expect(sidebar).toContain('/icons/app-icon.png');
    expect(app).toContain('colorMode === "light"');
    expect(build).toContain('/icons/app-icon.png');
    expect(build).toContain('/icons/maskable-icon.png');
    expect(`${app}${sidebar}${build}`).not.toContain('/icons/icon.svg');
  });
});
// @vitest-environment node
