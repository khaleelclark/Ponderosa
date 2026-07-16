import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isCompactViewport } from "../src/responsive";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.tsx", import.meta.url), "utf8");

describe("responsive compact controls", () => {
  it.each([
    [320, 568],
    [360, 800],
    [390, 844],
    [430, 932],
  ])("uses compact controls at %ipx phone width", (width, height) => {
    expect(isCompactViewport({ width, height })).toBe(true);
  });

  it.each([
    [768, 1024],
    [820, 1180],
    [1440, 900],
  ])("keeps controls expanded with %ix%i of usable space", (width, height) => {
    expect(isCompactViewport({ width, height })).toBe(false);
  });

  it.each([
    [667, 375],
    [844, 390],
    [1024, 600],
  ])("uses compact controls for short landscape viewport %ix%i", (width, height) => {
    expect(isCompactViewport({ width, height })).toBe(true);
  });

  it("uses the same accessible list navigation in the phone drawer and desktop shell", () => {
    expect(app.match(/<WorkspaceSidebar/g)).toHaveLength(2);
    expect(app).toContain('width: "min(88vw, 360px)"');
    expect(sidebar).toContain('aria-label="Recent chats across projects"');
    expect(sidebar).toContain('aria-label="View all agents across projects"');
    expect(sidebar).not.toContain("maxHeight: \"34%\"");
  });
});
