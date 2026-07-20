import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let inputs = 0;
if (process.env.PONDEROSA_TEST_IGNORE_SIGTERM === "1") setInterval(() => undefined, 1_000);

// Install the termination behavior before publishing the init handshake. Tests
// use that handshake as proof that the stubborn child is ready to be signaled.
process.on("SIGTERM", () => {
  if (process.env.PONDEROSA_TEST_IGNORE_SIGTERM === "1") return;
  process.exit(0);
});

const catalog = process.env.PONDEROSA_TEST_CLAUDE_CATALOG
  ? JSON.parse(process.env.PONDEROSA_TEST_CLAUDE_CATALOG)
  : {};
send({
  type: "system",
  subtype: "init",
  session_id: catalog.session_id ?? "claude-stream-v1",
  cwd: process.cwd(),
  model: catalog.model ?? "sonnet",
  slash_commands: catalog.slash_commands ?? [],
  skills: catalog.skills ?? [],
  plugins: catalog.plugins ?? [],
  tools: catalog.tools ?? [],
  mcp_servers: catalog.mcp_servers ?? [],
  claude_code_version: catalog.claude_code_version ?? "test",
});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  inputs += 1;
  const prompt = message.message?.content?.[0]?.text ?? "";
  if (prompt.includes("History marker")) {
    send({ type: "assistant", message: { content: [{ type: "text", text: prompt }] } });
    send({ type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 4, output_tokens: 2 } });
    return;
  }
  if (inputs === 1) return;
  send({ type: "assistant", message: { content: [{ type: "text", text: "steered claude response" }] } });
  send({ type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 4, output_tokens: 2 } });
});
