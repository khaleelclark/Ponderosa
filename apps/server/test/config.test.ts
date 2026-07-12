import { describe, expect, it } from "vitest";
import { loadConfig } from "@ponderosa/core/config";

describe("V1 server configuration", () => {
  it("has one canonical communication mode regardless of retired migration flags", () => {
    const config = loadConfig({
      HOME: "/tmp",
      PONDEROSA_COMMUNICATION_MODE: "off",
      PONDEROSA_COMMUNICATION_READ_MODE: "legacy",
      PONDEROSA_LEGACY_ROUTING: "accept",
    } as NodeJS.ProcessEnv);
    expect(config).not.toHaveProperty("communicationMode");
    expect(config).not.toHaveProperty("communicationReadMode");
    expect(config).not.toHaveProperty("legacyRoutingMode");
  });
});
