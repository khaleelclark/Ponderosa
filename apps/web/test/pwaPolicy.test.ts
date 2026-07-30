import { describe, expect, it } from "vitest";
import { pwaNavigationFallbackAllowed } from "../src/pwa-policy";

describe("PWA navigation fallback", () => {
  it("never intercepts authenticated APIs or launcher bootstrap routes", () => {
    for (const pathname of [
      "/api",
      "/api?probe=1",
      "/api/projects",
      "/__ponderosa_bootstrap",
      "/__ponderosa_bootstrap?probe=1",
      "/__ponderosa_bootstrap/more",
      "/__ponderosa_bootstrap.js",
      "/__ponderosa_bootstrap.js?probe=1",
    ]) {
      expect(pwaNavigationFallbackAllowed(pathname), pathname).toBe(false);
    }
  });

  it("continues to serve the application shell for ordinary UI routes", () => {
    for (const pathname of [
      "/",
      "/api-lookalike?probe=1",
      "/agents/current",
      "/projects/current/work",
    ]) {
      expect(pwaNavigationFallbackAllowed(pathname), pathname).toBe(true);
    }
  });
});
