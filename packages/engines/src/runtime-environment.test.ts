import { describe, expect, it } from "vitest";
import { runtimeEnvironment } from "./runtime-environment.js";

describe("runtimeEnvironment", () => {
  it("removes launcher credentials even when an adapter override supplies them", () => {
    const environment = runtimeEnvironment({
      PONDEROSA_LAUNCHER_CONTROL_TOKEN: "host-only",
      PONDEROSA_RUNTIME_TEST_VALUE: "visible",
    });

    expect(environment.PONDEROSA_LAUNCHER_CONTROL_TOKEN).toBeUndefined();
    expect(environment.PONDEROSA_RUNTIME_TEST_VALUE).toBe("visible");
  });
});
