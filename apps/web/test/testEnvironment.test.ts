import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("web command environments", () => {
  it("runs tests deterministically without weakening production build qualification", () => {
    expect(process.env.NODE_ENV).toBe("test");
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.test).toBe("NODE_ENV=test vitest run");
    expect(packageJson.scripts.build).toBe("NODE_ENV=production rsbuild build");
  });
});
// @vitest-environment node
