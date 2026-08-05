import { describe, expect, it } from "vitest";
import { communicationV3Prompt } from "../src/runtime-selection.js";

describe("runtime communication contract", () => {
  it("distinguishes Ponderosa replies from provider-native messaging", () => {
    const prompt = communicationV3Prompt().join("\n");

    expect(prompt).toContain("only ponderosa_message creates the canonical reply");
    expect(prompt).toContain(
      "Never substitute a generic or provider-native SendMessage tool",
    );
  });
});
