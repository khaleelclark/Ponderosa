import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("composer spacing policy", () => {
  it("does not add a top margin to the shared composer", () => {
    const globalCss = readFileSync(
      resolve(process.cwd(), "src/global.css"),
      "utf8",
    );
    const composerStyles = readFileSync(
      resolve(process.cwd(), "src/components/chat/Composer.styles.ts"),
      "utf8",
    );

    expect(globalCss).not.toMatch(
      /\.ponderosa-composer\s*\{[^}]*\bmargin(?:-top)?\s*:/su,
    );
    expect(composerStyles).not.toMatch(/\b(?:mt|marginTop)\s*:/u);
  });
});
