import assert from "node:assert/strict";
import test from "node:test";
import { runtimeSystemPrompt } from "../dist/prompts.js";

test("runtime completion contract requires checking named Project deliverables", () => {
  const prompt = runtimeSystemPrompt({ id: "agent-a", title: "Agent A", projectId: "project-a", managerAgentId: null }, "");
  assert.match(prompt, /explicitly required deliverable in the user's request and referenced briefs with the files actually present/);
  assert.match(prompt, /If any required deliverable is missing or unverified, report the remaining work instead of claiming completion/);
});
