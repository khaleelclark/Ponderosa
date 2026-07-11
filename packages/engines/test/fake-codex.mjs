#!/usr/bin/env node
// A fake `codex` for adapter tests: emits deterministic JSONL per mode, so the
// adapter's spawn/stream/abort/exit handling can be tested without a real login.
const mode = process.argv[2] ?? "seed";
const w = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (mode === "seed") {
  w({ type: "thread.started", thread_id: "sess-123" });
  w({ type: "turn.started" });
  w({ type: "item.started", item: { id: "i0", type: "command_execution", command: "echo hi", status: "in_progress" } });
  w({ type: "item.completed", item: { id: "i0", type: "command_execution", command: "echo hi", aggregated_output: "hi\n", exit_code: 0, status: "completed" } });
  w({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } });
  w({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } });
  process.exit(0);
} else if (mode === "stdin") {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  w({ type: "thread.started", thread_id: "sess-stdin" });
  w({ type: "item.completed", item: { id: "i1", type: "agent_message", text: `stdin-bytes:${Buffer.byteLength(input)}` } });
  w({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
} else if (mode === "hang") {
  w({ type: "thread.started", thread_id: "sess-hang" });
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write("codex: not logged in\n");
  process.exit(1);
}
