#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
function numericOption(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`);
  return value;
}
function percentileSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] * 100) / 100;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

const repoRoot = resolve(import.meta.dirname, "../..");
const fixtureDir = resolve(option("fixture", resolve(repoRoot, ".high-cardinality-fixture")));
const metadataPath = resolve(option("metadata", resolve(fixtureDir, "fixture.json")));
const workDir = resolve(option("work-dir", resolve(repoRoot, ".high-cardinality-work")));
const outputPath = resolve(option("output", resolve(repoRoot, "high-cardinality-results.json")));
const port = numericOption("port", 9886);
const baseUrl = `http://127.0.0.1:${port}`;
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));

rmSync(workDir, { recursive: true, force: true });
cpSync(fixtureDir, workDir, { recursive: true });
let serverOutput = "";
const server = spawn(process.execPath, ["apps/server/dist/main.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    PONDEROSA_DATA_DIR: workDir,
    PONDEROSA_HOST: "127.0.0.1",
    PONDEROSA_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });
let stopped = false;
async function stopServer() {
  if (stopped) return;
  stopped = true;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => server.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void stopServer().finally(() => process.exit(130)); });
}

async function timed(path, init) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.arrayBuffer();
  return {
    ms: performance.now() - startedAt,
    status: response.status,
    bytes: body.byteLength,
    nextCursor: response.headers.get("x-next-cursor"),
    totalCount: response.headers.get("x-total-count"),
  };
}
async function repeated(count, action) {
  const results = [];
  for (let index = 0; index < count; index += 1) results.push(await action(index));
  return {
    timing: percentileSummary(results.map((result) => result.ms)),
    statuses: results.map((result) => result.status),
  };
}
function sql(query) {
  return execFileSync("sqlite3", [resolve(workDir, "ponderosa.db"), query], { encoding: "utf8" }).trim();
}

try {
  const startupStartedAt = performance.now();
  let healthMs;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        healthMs = performance.now() - startupStartedAt;
        break;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (healthMs === undefined) throw new Error(`server did not become healthy\n${serverOutput}`);

  const health = await repeated(20, () => timed("/api/health"));
  const ready = await repeated(20, () => timed("/api/ready"));
  const projectId = metadata.projectId;
  const conversationId = metadata.conversationId;
  const pages = {
    projects: await timed("/api/projects?limit=25"),
    conversations: await timed(`/api/projects/${projectId}/conversations?limit=25`),
    agents: await timed(`/api/projects/${projectId}/agents?limit=25`),
    triggers: await timed(`/api/triggers?projectId=${projectId}&limit=25`),
    directoryProjects: await timed("/api/workspace/directory/project?limit=25"),
    directoryConversations: await timed(`/api/workspace/directory/conversation?projectId=${projectId}&limit=25`),
    directoryAgents: await timed(`/api/workspace/directory/agent?projectId=${projectId}&limit=25`),
    directoryTriggers: await timed(`/api/workspace/directory/trigger?projectId=${projectId}&limit=25`),
  };

  const agentIds = metadata.agentIds.slice(0, 20);
  const triggerResults = await Promise.all(agentIds.map((agentId, index) => timed(
    `/api/agents/${agentId}/triggers`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        name: `benchmark-trigger-${index}`,
        instructions: "Disabled high-cardinality qualification trigger.",
        sourceKind: "webhook",
        sourceConfig: { replayWindowSeconds: 60 },
        enabled: false,
      }),
    },
  )));
  const passiveResults = await Promise.all(Array.from({ length: 20 }, (_, index) => timed(
    `/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `benchmark passive broadcast ${index}`,
        recipientAgentIds: [],
        activeRunDelivery: "queue",
      }),
    },
  )));
  const mixedResults = await Promise.all(Array.from({ length: 30 }, (_, index) => {
    if (index % 3 === 0) return timed("/api/ready");
    if (index % 3 === 1) return timed(`/api/workspace/directory/agent?projectId=${projectId}&limit=25`);
    return timed(`/api/conversations/${conversationId}?limit=100`);
  }));

  const statusText = readFileSync(`/proc/${server.pid}/status`, "utf8");
  const rssMatch = statusText.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  const result = {
    recordedAt: new Date().toISOString(),
    hardware: {
      cpu: cpus()[0]?.model,
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    fixture: {
      projects: Number(sql("select count(*) from projects")),
      conversations: Number(sql("select count(*) from conversations")),
      agents: Number(sql("select count(*) from agents where deleted_at is null")),
      triggers: Number(sql("select count(*) from trigger_definitions")),
    },
    startup: {
      healthMs: Math.round(healthMs * 100) / 100,
      profile: serverOutput.split("\n").filter((line) =>
        line.includes("store startup") || line.includes("lifecycle readiness"),
      ),
    },
    health: health.timing,
    ready: ready.timing,
    triggerMutation: {
      timing: percentileSummary(triggerResults.map((result) => result.ms)),
      statuses: triggerResults.map((result) => result.status),
    },
    passiveMessages: {
      timing: percentileSummary(passiveResults.map((result) => result.ms)),
      statuses: passiveResults.map((result) => result.status),
    },
    mixed: {
      timing: percentileSummary(mixedResults.map((result) => result.ms)),
      statuses: mixedResults.map((result) => result.status),
    },
    payloads: pages,
    authority: {
      activations: Number(sql("select count(*) from agent_activations")),
      runs: Number(sql("select count(*) from scheduler_runs")),
    },
    rssBytes: rssMatch ? Number(rssMatch[1]) * 1024 : null,
  };
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await stopServer();
}
