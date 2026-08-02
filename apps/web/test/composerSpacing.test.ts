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

  it("keeps the responding pill in the chat overlay without reserving composer height", () => {
    const conversationView = readFileSync(
      resolve(process.cwd(), "src/components/ConversationView.tsx"),
      "utf8",
    );
    const composerStart = conversationView.indexOf(
      'className="mobile-chat-chrome mobile-chat-composer"',
    );
    const composerEnd = conversationView.indexOf("<Composer", composerStart);

    expect(composerStart).toBeGreaterThan(-1);
    expect(composerEnd).toBeGreaterThan(composerStart);
    expect(conversationView.slice(0, composerStart)).toMatch(
      /activeView === "main" && !agentWorkOpen[\s\S]*?position: "absolute",[\s\S]*?insetInline: 0,[\s\S]*?bottom: 2,[\s\S]*?<MasterRespondingIndicator/u,
    );

    const composerChrome = conversationView.slice(composerStart, composerEnd);
    expect(composerChrome).not.toContain("MasterRespondingIndicator");
    expect(composerChrome).not.toMatch(/\bheight:\s*28\b/u);
  });
});
