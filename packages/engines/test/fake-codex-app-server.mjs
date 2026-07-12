import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    return send({ id: message.id, result: { thread: { id: "codex-thread-v1" } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "codex-thread-v1", turn: { id: "turn-1", status: "inProgress" } } });
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: "turn-1" } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-v1", turnId: "turn-1", itemId: "m1", delta: "steered response" } });
    send({ method: "item/started", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "commandExecution", id: "c1", command: "git status", cwd: "/repo" } } });
    send({ method: "item/completed", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "commandExecution", id: "c1", command: "git status", cwd: "/repo", aggregatedOutput: "clean", exitCode: 0 } } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-v1", turn: { id: "turn-1", status: "completed", error: null } } });
    return;
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
