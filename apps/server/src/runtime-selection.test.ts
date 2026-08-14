import { describe, expect, it } from "vitest";
import {
  PONDEROSA_BROWSER_TOOLS,
  PONDEROSA_RUNTIME_TOOLS,
} from "@ponderosa/core";
import { communicationV3Prompt, providerDynamicTools } from "./runtime-selection.js";

describe("provider tool surface", () => {
  it("retains the separately qualified browser capabilities", () => {
    const tools = providerDynamicTools();
    expect(tools.filter(tool => tool.name.includes("browser"))).toEqual(
      PONDEROSA_BROWSER_TOOLS,
    );
    expect(tools.some(tool => tool.name === "ponderosa_browser")).toBe(false);
    expect(PONDEROSA_RUNTIME_TOOLS).toEqual(tools);
    expect(PONDEROSA_BROWSER_TOOLS.map(tool => tool.name)).toEqual([
      "ponderosa_browser_open",
      "ponderosa_browser_navigate",
      "ponderosa_browser_inspect",
      "ponderosa_browser_act",
      "ponderosa_browser_screenshot",
      "ponderosa_browser_take_control",
      "ponderosa_browser_close",
    ]);
  });

  it("keeps provider policy concise and leaves operation detail in schemas", () => {
    const prompt = communicationV3Prompt().join("\n");
    expect(prompt).not.toContain("A new Request is ordinary next-Run work");
    expect(prompt).not.toContain("cancel the exact original outbound Request");
    expect(prompt).toContain("Common reply: ponderosa_message({text})");
  });
});
