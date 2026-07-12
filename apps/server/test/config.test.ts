import { describe, expect, it } from "vitest";
import { loadConfig } from "@ponderosa/core/config";

describe("communication migration configuration", () => {
  it("defaults production routing to explicit intents while leaving reads in shadow", () => {
    expect(loadConfig({ HOME: "/tmp" } as NodeJS.ProcessEnv)).toMatchObject({
      communicationMode: "shadow",
      communicationReadMode: "shadow",
      legacyRoutingMode: "reject",
      curatedContextEnabled: true,
    });
  });

  it("rejects authoritative reads when canonical capture is disabled", () => {
    expect(() => loadConfig({
      PONDEROSA_COMMUNICATION_MODE: "off",
      PONDEROSA_COMMUNICATION_READ_MODE: "authoritative",
    } as NodeJS.ProcessEnv)).toThrow("requires canonical communication capture");
  });
});
