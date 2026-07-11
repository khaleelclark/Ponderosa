import { describe, expect, it } from "vitest";
import { isCompactViewport } from "../src/responsive";

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
});
