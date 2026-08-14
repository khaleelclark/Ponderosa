import assert from "node:assert/strict";
import test from "node:test";
import { PONDEROSA_BROWSER_TOOLS } from "../../packages/core/dist/index.js";
import { selection } from "./measure-browser-tool-selection.mjs";

test("passes the canonical production browser definitions to the Adapter", async () => {
  let receivedTools;
  const session = {
    async startTurn() {},
    events: (async function* () {
      yield { type: "turn_done" };
    })(),
    async close() {},
  };
  const adapter = {
    async openSession(options) {
      receivedTools = options.dynamicTools;
      return session;
    },
  };

  const selected = await selection(
    adapter,
    PONDEROSA_BROWSER_TOOLS,
    [{ prompt: "Inspect the current page." }],
  );

  assert.strictEqual(receivedTools, PONDEROSA_BROWSER_TOOLS);
  assert.deepEqual(
    receivedTools.map(tool => tool.name),
    [
      "ponderosa_browser_open",
      "ponderosa_browser_navigate",
      "ponderosa_browser_inspect",
      "ponderosa_browser_act",
      "ponderosa_browser_screenshot",
      "ponderosa_browser_take_control",
      "ponderosa_browser_close",
    ],
  );
  selected.controller.abort();
  await selected.session.close();
});
