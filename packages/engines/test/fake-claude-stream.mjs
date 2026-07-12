import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let inputs = 0;

send({ type: "system", subtype: "init", session_id: "claude-stream-v1", cwd: process.cwd() });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  inputs += 1;
  if (inputs === 1) return;
  send({ type: "assistant", message: { content: [{ type: "text", text: "steered claude response" }] } });
  send({ type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 4, output_tokens: 2 } });
});

process.on("SIGTERM", () => process.exit(0));
