#!/usr/bin/env node
// CLI harness (SPEC §15): run ONE turn against a project dir, pretty-print the
// streamed AgentEvents, and print the captured session id + resume command. This
// is how the riskiest chunk gets de-risked standalone, before any UI/server.
//
//   pnpm engines:try --cwd <dir> "<prompt>"
//   pnpm engines:try --cwd <dir> --resume <session-id> "<next prompt>"
//
// Ctrl-C cancels the run (AbortSignal → SIGTERM → SIGKILL), exercising cancel.

import type { AgentEvent, ChatMessage } from "@ponderosa/core";
import { CodexAdapter } from "./codex.js";

interface Args {
  cwd: string;
  prompt: string;
  resume?: string;
  model?: string;
  effort?: string;
}

function parseArgs(argv: string[]): Args {
  let cwd = process.cwd();
  let resume: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--cwd":
        cwd = argv[++i] ?? cwd;
        break;
      case "--resume":
        resume = argv[++i];
        break;
      case "--model":
        model = argv[++i];
        break;
      case "--effort":
        effort = argv[++i];
        break;
      default:
        if (a !== undefined) rest.push(a);
    }
  }

  const prompt = rest.join(" ").trim();
  if (prompt === "") {
    process.stderr.write(
      'usage: pnpm engines:try --cwd <dir> [--resume <id>] [--model m] [--effort e] "<prompt>"\n',
    );
    process.exit(2);
  }
  return { cwd, prompt, resume, model, effort };
}

// Small ANSI helpers (no dependency).
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

function printEvent(ev: AgentEvent): void {
  switch (ev.type) {
    case "session":
      process.stdout.write(c.dim(`● session ${ev.sessionId}\n`));
      break;
    case "text":
      process.stdout.write(c.green(`\n▸ ${ev.delta}\n`));
      break;
    case "reasoning":
      process.stdout.write(c.dim(`  (runOutput) ${ev.delta}\n`));
      break;
    case "command":
      process.stdout.write(c.cyan(`$ ${ev.command}`) + c.dim(`  [${ev.cwd}]\n`));
      break;
    case "tool_result": {
      const head = ev.output.split("\n").slice(0, 8).join("\n");
      const marker = ev.isError ? c.red("✗") : c.dim("↳");
      process.stdout.write(`${marker} ${c.dim(head)}\n`);
      break;
    }
    case "tool_call":
      process.stdout.write(c.magenta(`⚙ ${ev.name}(${JSON.stringify(ev.input)})\n`));
      break;
    case "file_change":
      process.stdout.write(c.yellow(`± ${ev.kind} ${ev.path}\n`));
      break;
    case "test_result":
      process.stdout.write(
        (ev.passed ? c.green("✓ tests passed") : c.red("✗ tests failed")) +
          ` ${ev.summary}\n`,
      );
      break;
    case "task_update":
      process.stdout.write(c.dim(`◔ task ${ev.taskId} → ${ev.status}\n`));
      break;
    case "turn_done":
      process.stdout.write(
        c.dim(`\n■ turn complete${ev.usage ? ` (${JSON.stringify(ev.usage)})` : ""}\n`),
      );
      break;
    case "error":
      process.stderr.write(c.red(`\n‼ error: ${ev.message}\n`));
      break;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const adapter = new CodexAdapter();
  const controller = new AbortController();

  process.on("SIGINT", () => {
    process.stderr.write(c.yellow("\n⨯ cancelling (SIGINT)…\n"));
    controller.abort();
  });

  process.stdout.write(
    c.bold(`Ponderosa engines:try — Codex\n`) +
      c.dim(`cwd: ${args.cwd}\n`) +
      c.dim(args.resume ? `resume: ${args.resume}\n` : `mode: seed (fresh session)\n`) +
      c.dim(`prompt: ${args.prompt}\n\n`),
  );

  let sessionId: string | undefined = args.resume;

  const history: ChatMessage[] = [];
  const stream = args.resume
    ? adapter.continue({
        agentId: "harness",
        cwd: args.cwd,
        prompt: args.prompt,
        resumeSessionId: args.resume,
        model: args.model,
        effort: args.effort,
        signal: controller.signal,
      })
    : adapter.seed({
        agentId: "harness",
        cwd: args.cwd,
        prompt: args.prompt,
        history,
        model: args.model,
        effort: args.effort,
        signal: controller.signal,
      });

  for await (const ev of stream) {
    if (ev.type === "session") sessionId = ev.sessionId;
    printEvent(ev);
  }

  process.stdout.write("\n" + c.bold("── session ──\n"));
  if (sessionId) {
    process.stdout.write(`session id: ${c.cyan(sessionId)}\n`);
    process.stdout.write(c.dim("resume with:\n"));
    process.stdout.write(`  codex exec resume ${sessionId} --json\n`);
    process.stdout.write(
      `  pnpm engines:try --cwd ${args.cwd} --resume ${sessionId} "<next prompt>"\n`,
    );
  } else {
    process.stdout.write(c.red("no session id captured (run may have failed)\n"));
  }
}

main().catch((err) => {
  process.stderr.write(c.red(`harness failed: ${String(err)}\n`));
  process.exit(1);
});
