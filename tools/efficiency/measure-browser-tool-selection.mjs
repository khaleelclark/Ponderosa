#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { PONDEROSA_BROWSER_TOOLS } from "../../packages/core/dist/index.js";
import { CodexAdapter } from "../../packages/engines/dist/index.js";

const fixtures = JSON.parse(await readFile(new URL("./browser-tool-selection-fixtures.json", import.meta.url), "utf8"));
const modelArgument = process.argv.find(argument => argument.startsWith("--model="));
const model = modelArgument?.slice("--model=".length) || "gpt-5.4-mini";
const limitArgument = process.argv.find(argument => argument.startsWith("--limit="));
const fixtureArgument = process.argv.find(argument => argument.startsWith("--fixture="));
const requestedFixture = fixtureArgument?.slice("--fixture=".length);
const selectedFixtures = requestedFixture
  ? fixtures.filter(fixture => fixture.id === requestedFixture)
  : limitArgument
  ? fixtures.slice(0, Number(limitArgument.slice("--limit=".length)))
  : fixtures;
if (requestedFixture && selectedFixtures.length !== 1) {
  throw new Error(`unknown fixture: ${requestedFixture}`);
}
const surfaceArgument = process.argv.find(argument => argument.startsWith("--surface="));
const surface = surfaceArgument?.slice("--surface=".length) || "consolidated";
if (surface !== "legacy" && surface !== "consolidated") {
  throw new Error("--surface must be legacy or consolidated");
}

// The qualified baseline is the exact production registry surface. Do not copy
// descriptions or schemas into this harness: drift would invalidate selection
// comparisons without changing the tools that an Adapter actually receives.
const legacyTools = PONDEROSA_BROWSER_TOOLS;

// Deliberately benchmark-only. The provider surface retains the qualified
// legacy tools unless this candidate proves equal or better selection.
const consolidatedTool = {
  name: "ponderosa_browser",
  description: "Control the browser authorized for this exact Run. open creates or reuses the private Run browser, or the persistent Project browser explicitly lent by the operator. navigate and act fail while the operator has control; take_control returns input to the Agent. inspect returns a bounded semantic snapshot. screenshot creates a Run-scoped PNG artifact. close closes a private browser, or returns a lent Project browser to the operator without closing it. Navigation accepts only http(s) URLs, and fill text is never copied into the activity summary.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: { type: "string", enum: ["open", "navigate", "inspect", "act", "screenshot", "take_control", "close"] },
      url: { type: "string", minLength: 1, maxLength: 2048 },
      action: { type: "string", enum: ["click", "fill", "key"] },
      selector: { type: "string", minLength: 1, maxLength: 500 },
      text: { type: "string" },
      key: { type: "string", minLength: 1, maxLength: 40 },
    },
    allOf: [
      {
        if: { properties: { operation: { const: "navigate" } }, required: ["operation"] },
        then: { required: ["url"] },
      },
      {
        if: { properties: { operation: { const: "act" } }, required: ["operation"] },
        then: { required: ["action"] },
      },
    ],
  },
};

export async function selection(adapter, tools, surfaceFixtures) {
  const controller = new AbortController();
  const calls = [];
  const session = await adapter.openSession({
    agentId: `tool-selection-${Math.random().toString(16).slice(2)}`,
    cwd: process.cwd(),
    history: [],
    systemPrompt: "This is a browser tool-selection fixture. Call exactly one provided Ponderosa browser tool that satisfies the request, then stop. Do not use shell commands, provider-native tools, or prose instead of the Ponderosa tool.",
    model,
    effort: "low",
    dynamicTools: tools,
    handleDynamicToolCall: async selected => {
      calls.push(selected);
      return {
        success: true,
        text: calls.length < surfaceFixtures.length
          ? `Fixture ${calls.length} recorded. Continue with fixture ${calls.length + 1}.`
          : "All fixtures recorded. Stop now.",
      };
    },
    onRuntimeSpawned: () => undefined,
    onRuntimeRootExit: () => undefined,
    signal: controller.signal,
  });
  const prompt = [
    "Complete every numbered fixture in order. Call exactly one provided Ponderosa browser tool per fixture. After each tool result, immediately continue to the next fixture.",
    ...surfaceFixtures.map((fixture, index) => `${index + 1}. ${fixture.prompt}`),
  ].join("\n");
  await session.startTurn({
    prompt,
    kind: "user",
    effort: "low",
    model,
  });
  for await (const event of session.events) {
    if (event.type === "turn_done" || event.type === "error") break;
  }
  return { calls, controller, session };
}

async function main() {
  process.stderr.write(`surface ${surface}\n`);
  const adapter = new CodexAdapter({ sandboxMode: "read-only" });
  const selected = await selection(
    adapter,
    surface === "legacy" ? legacyTools : [consolidatedTool],
    selectedFixtures,
  );
  const results = [];
  for (const [index, fixture] of selectedFixtures.entries()) {
    const call = selected.calls[index];
    const correct = surface === "legacy"
      ? call?.name === `ponderosa_browser_${fixture.operation}`
        && (!fixture.action || call.arguments?.action === fixture.action)
      : call?.name === consolidatedTool.name
        && call.arguments?.operation === fixture.operation
        && (!fixture.action || call.arguments?.action === fixture.action);
    results.push({
      id: fixture.id,
      correct,
      call,
    });
  }
  process.stdout.write(`${JSON.stringify({
    model,
    surface,
    fixtureCount: selectedFixtures.length,
    accuracy: results.filter(result => result.correct).length / results.length,
    results,
  }, null, 2)}\n`);
  selected.controller.abort();
  void selected.session.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
