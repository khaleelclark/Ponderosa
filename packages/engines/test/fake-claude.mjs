#!/usr/bin/env node
// A fake `claude` for adapter tests: emits deterministic stream-json per mode.
const mode = process.argv[2] ?? "seed";
const w = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (mode === "seed") {
  w({ type: "system", subtype: "init", session_id: "claude-sess-1", cwd: process.cwd(), tools: ["Bash", "Write"] });
  w({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  w({ type: "assistant", message: { model: "claude-opus-4-8", content: [{ type: "text", text: "on it" }] } });
  w({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }] } });
  w({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false }] } });
  w({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
  w({ type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 7, output_tokens: 3 } });
  process.exit(0);
} else if (mode === "hang") {
  w({ type: "system", subtype: "init", session_id: "claude-sess-hang", cwd: process.cwd() });
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write("claude: not authenticated\n");
  process.exit(1);
}
