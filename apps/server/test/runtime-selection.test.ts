import { describe, expect, it } from "vitest";
import {
  communicationV3Prompt,
  providerDynamicTools,
  providerSessionContractHash,
  providerToolContractHash,
} from "../src/runtime-selection.js";

describe("runtime communication contract", () => {
  it("distinguishes Ponderosa replies from provider-native messaging", () => {
    const prompt = communicationV3Prompt().join("\n");

    expect(prompt).toContain("only ponderosa_message creates the canonical reply");
    expect(prompt).toContain(
      "Never substitute a generic or provider-native SendMessage tool",
    );
  });

  it("limits passive next-run information to the message delivery mode", () => {
    const prompt = communicationV3Prompt().join("\n");

    expect(prompt).toContain("ponderosa_message({delivery:\"next_run\",text,recipientAgentIds})");
    expect(prompt).toContain("no chat message, Activation, Run, Request, Join, reply obligation, or acknowledgement");
    expect(prompt).not.toContain("ponderosa_signal");
    expect(prompt).not.toContain("Signal");
    expect(prompt).not.toContain("ponderosa_docs");
    expect(prompt).not.toContain("ponderosa_rollover");
    expect(providerDynamicTools().map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["ponderosa_docs", "ponderosa_rollover"]),
    );
  });

  it.each([
    { context: false, result: false, expected: [] },
    { context: false, result: true, expected: ["ponderosa_result"] },
    { context: true, result: false, expected: ["ponderosa_context"] },
    { context: true, result: true, expected: ["ponderosa_result", "ponderosa_context"] },
  ])("exposes only retrievable conditional tools for $expected", ({ context, result, expected }) => {
    const tools = providerDynamicTools({ context, result });
    const conditional = tools.map((tool) => tool.name)
      .filter((name) => name === "ponderosa_result" || name === "ponderosa_context");
    const prompt = communicationV3Prompt({ context, result }).join("\n");

    expect(conditional).toEqual(expected);
    expect(prompt.includes("ponderosa_result")).toBe(result);
    expect(prompt.includes("ponderosa_context")).toBe(context);
  });

  it("changes session compatibility across false→true→false availability without accumulating churn", () => {
    const contract = (result: boolean) => {
      const availability = { context: false, result };
      const tools = providerDynamicTools(availability);
      return providerSessionContractHash(
        "codex",
        "test-model",
        "low",
        providerToolContractHash(tools, communicationV3Prompt(availability)),
      );
    };

    const ordinaryBefore = contract(false);
    const withResult = contract(true);
    const ordinaryAfter = contract(false);
    expect(withResult).not.toBe(ordinaryBefore);
    expect(ordinaryAfter).toBe(ordinaryBefore);
  });

  it("locks the documented ordinary-Run schema and prompt byte reduction", () => {
    const serializedTools = (availability: { context: boolean; result: boolean }) =>
      JSON.stringify(providerDynamicTools(availability).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })));
    const prompt = (availability: { context: boolean; result: boolean }) =>
      communicationV3Prompt(availability).join("\n");
    const all = { context: true, result: true };
    const ordinary = { context: false, result: false };

    expect({
      allSchemaBytes: Buffer.byteLength(serializedTools(all)),
      ordinarySchemaBytes: Buffer.byteLength(serializedTools(ordinary)),
      allPromptBytes: Buffer.byteLength(prompt(all)),
      ordinaryPromptBytes: Buffer.byteLength(prompt(ordinary)),
    }).toEqual({
      allSchemaBytes: 20_427,
      ordinarySchemaBytes: 18_182,
      allPromptBytes: 3_089,
      ordinaryPromptBytes: 2_710,
    });
  });
});
