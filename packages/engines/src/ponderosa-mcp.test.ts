import { describe, expect, it } from "vitest";
import { PONDEROSA_RUNTIME_TOOLS } from "@ponderosa/core";
import { enabledPonderosaMcpTools, PONDEROSA_MCP_TOOLS } from "./ponderosa-mcp.js";

describe("provider-managed tool contract parity", () => {
  it("derives every Claude MCP contract from the exact Codex dynamic-tool contract", () => {
    expect(PONDEROSA_MCP_TOOLS).toEqual(PONDEROSA_RUNTIME_TOOLS.map((tool) => ({
      name: tool.name.replace(/^ponderosa_/, ""),
      description: tool.description,
      inputSchema: tool.inputSchema,
    })));
  });

  it("filters Claude's advertised MCP tools with the exact Run allowlist", () => {
    const enabled = enabledPonderosaMcpTools(new Set(["message", "result"]));
    expect(enabled.map((tool) => tool.name)).toEqual(["result", "message"]);
    expect(enabled.map((tool) => tool.name)).not.toContain("context");
  });

  it("exposes the same immediate/next_run message schema to Codex and Claude", () => {
    const codex = PONDEROSA_RUNTIME_TOOLS.find(({ name }) => name === "ponderosa_message");
    const claude = PONDEROSA_MCP_TOOLS.find(({ name }) => name === "message");

    expect(codex).toBeDefined();
    expect(claude).toEqual({
      name: "message",
      description: codex!.description,
      inputSchema: codex!.inputSchema,
    });
    const schema = codex!.inputSchema as {
      oneOf?: unknown[];
      properties?: Record<string, unknown>;
    };
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.properties).toHaveProperty("delivery");
    expect(JSON.stringify(schema)).not.toContain('"wake"');
    expect(PONDEROSA_RUNTIME_TOOLS.map(({ name }) => name)).not.toContain("ponderosa_signal");
    expect(PONDEROSA_MCP_TOOLS.map(({ name }) => name)).not.toContain("signal");
    expect(PONDEROSA_RUNTIME_TOOLS.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["ponderosa_docs", "ponderosa_rollover"]),
    );
    expect(PONDEROSA_MCP_TOOLS.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["docs", "rollover"]),
    );
  });
});
