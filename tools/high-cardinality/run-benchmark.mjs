#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, homedir, tmpdir, totalmem } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const FIXTURE_SENTINEL = ".ponderosa-high-cardinality-fixture.json";
const WORK_SENTINEL = ".ponderosa-high-cardinality-work.json";

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
function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function parseSentinel(path, kind) {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value?.kind === kind && value?.version === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}
function assertSafeFixture(fixtureDir, repoRoot) {
  const protectedPaths = [
    resolve(homedir()),
    resolve(repoRoot),
    resolve(homedir(), ".ponderosa"),
    ...(process.env.PONDEROSA_DATA_DIR
      ? [resolve(process.env.PONDEROSA_DATA_DIR)]
      : []),
  ];
  if (fixtureDir === "/") throw new Error("refusing to use filesystem root as a fixture");
  if (fixtureDir === resolve(homedir()) || fixtureDir === resolve(repoRoot)) {
    throw new Error(`refusing to use protected fixture directory: ${fixtureDir}`);
  }
  for (const protectedPath of protectedPaths.slice(2)) {
    if (
      fixtureDir === protectedPath ||
      isInside(fixtureDir, protectedPath) ||
      isInside(protectedPath, fixtureDir)
    ) {
      throw new Error(`fixture overlaps Ponderosa data directory: ${fixtureDir}`);
    }
  }
  if (!parseSentinel(resolve(fixtureDir, FIXTURE_SENTINEL), "ponderosa-high-cardinality-fixture")) {
    throw new Error(`fixture sentinel is missing or invalid: ${fixtureDir}`);
  }
}
function safeRemoveWorkDir(workDir, runId) {
  const tempRoot = resolve(tmpdir());
  if (!isInside(tempRoot, workDir)) {
    throw new Error(`refusing to clean work directory outside OS temp: ${workDir}`);
  }
  const sentinel = parseSentinel(
    resolve(workDir, WORK_SENTINEL),
    "ponderosa-high-cardinality-work",
  );
  if (!sentinel || sentinel.runId !== runId) {
    throw new Error(`refusing to clean unowned work directory: ${workDir}`);
  }
  rmSync(workDir, { recursive: true, force: true });
}
function assertStatuses(results, expected, label) {
  const unexpected = results.filter((result) => result.status !== expected);
  if (unexpected.length) {
    throw new Error(`${label} returned unexpected statuses: ${unexpected.map(result => result.status).join(", ")}`);
  }
}
const repoRoot = resolve(import.meta.dirname, "../..");
if (process.argv.some(argument => argument.startsWith("--work-dir="))) {
  throw new Error("--work-dir is not supported; benchmark workspaces are owned temporary directories");
}
const fixtureDir = resolve(option("fixture", resolve(repoRoot, ".high-cardinality-fixture")));
const metadataPath = resolve(option("metadata", resolve(fixtureDir, "fixture.json")));
const outputPath = resolve(option("output", resolve(repoRoot, "high-cardinality-results.json")));
const port = numericOption("port", 9886);
const baseUrl = `http://127.0.0.1:${port}`;
const keepWorkDir = process.argv.includes("--keep-work-dir");
const runId = randomUUID();

assertSafeFixture(fixtureDir, repoRoot);
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const workDir = mkdtempSync(resolve(tmpdir(), "ponderosa-high-cardinality-"));
cpSync(fixtureDir, workDir, { recursive: true });
writeFileSync(resolve(workDir, WORK_SENTINEL), `${JSON.stringify({
  kind: "ponderosa-high-cardinality-work",
  version: 1,
  runId,
  fixtureDir,
  createdAt: new Date().toISOString(),
})}
`);

let activeServer;
const serverProfiles = [];
function startServer() {
  let output = "";
  const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
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
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  activeServer = { child, output: () => output };
  return activeServer;
}
async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => server.child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
  serverProfiles.push(...server.output().split("\n").filter((line) =>
    line.includes("store startup") || line.includes("lifecycle readiness"),
  ));
  if (activeServer === server) activeServer = undefined;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stopServer(activeServer)
      .finally(() => {
        if (!keepWorkDir) safeRemoveWorkDir(workDir, runId);
        process.exit(130);
      });
  });
}
async function waitFor(path, attempts = 600) {
  const startedAt = performance.now();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`);
      if (response.ok) return performance.now() - startedAt;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`server did not satisfy ${path}
${activeServer?.output() ?? ""}`);
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
function communicationEventCount() {
  const eventPath = resolve(
    workDir,
    "projects",
    metadata.projectId,
    "communication-events.jsonl",
  );
  if (!existsSync(eventPath)) return 0;
  return readFileSync(eventPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((count, line) => {
      const event = JSON.parse(line);
      return count + (event.conversationId === metadata.conversationId ? 1 : 0);
    }, 0);
}
function authorityCounts() {
  return {
    projects: Number(sql("select count(*) from projects")),
    conversations: Number(sql("select count(*) from conversations")),
    agents: Number(sql("select count(*) from agents where deleted_at is null")),
    triggers: Number(sql("select count(*) from trigger_definitions")),
    messages: communicationEventCount(),
    activations: Number(sql("select count(*) from agent_activations")),
    runs: Number(sql("select count(*) from scheduler_runs")),
  };
}
function assertCounts(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`${label} expected ${key}=${value}, received ${actual[key]}`);
    }
  }
}

try {
  const firstServer = startServer();
  const healthMs = await waitFor("/api/health");
  await waitFor("/api/ready");
  const initialCounts = authorityCounts();
  assertCounts(initialCounts, {
    projects: metadata.counts.projects,
    conversations: metadata.counts.totalChats,
    agents: metadata.counts.agents,
    triggers: metadata.counts.triggers,
    messages: metadata.counts.messages,
    activations: 0,
    runs: 0,
  }, "pristine fixture");

  const health = await repeated(20, () => timed("/api/health"));
  const ready = await repeated(20, () => timed("/api/ready"));
  assertStatuses(health.statuses.map((status) => ({ status })), 200, "health");
  assertStatuses(ready.statuses.map((status) => ({ status })), 200, "readiness");
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
  assertStatuses(Object.values(pages), 200, "bounded reads");

  const agentIds = metadata.agentIds.slice(0, 20);
  if (agentIds.length !== 20) throw new Error("fixture must provide 20 benchmark Agent IDs");
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
  assertStatuses(triggerResults, 201, "Trigger mutations");

  const passiveBodies = Array.from({ length: 20 }, (_, index) => ({
    text: `benchmark passive broadcast ${index}`,
    recipientAgentIds: [],
    activeRunDelivery: "queue",
    idempotencyKey: `high-cardinality-passive-${index}`,
  }));
  const passiveResults = await Promise.all(passiveBodies.map((body) => timed(
    `/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )));
  assertStatuses(passiveResults, 200, "passive messages");
  const replayResult = await timed(
    `/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passiveBodies[0]),
    },
  );
  if (replayResult.status !== 200) throw new Error(`idempotent replay returned ${replayResult.status}`);
  const conflictResult = await timed(
    `/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...passiveBodies[0], text: "changed payload" }),
    },
  );
  if (conflictResult.status !== 409) throw new Error(`changed idempotency payload returned ${conflictResult.status}`);

  const mixedResults = await Promise.all(Array.from({ length: 30 }, (_, index) => {
    if (index % 3 === 0) return timed("/api/ready");
    if (index % 3 === 1) return timed(`/api/workspace/directory/agent?projectId=${projectId}&limit=25`);
    return timed(`/api/conversations/${conversationId}?limit=100`);
  }));
  assertStatuses(mixedResults, 200, "mixed workload");

  const afterWorkload = authorityCounts();
  const expectedFinal = {
    projects: metadata.counts.projects,
    conversations: metadata.counts.totalChats,
    agents: metadata.counts.agents,
    triggers: metadata.counts.triggers + 20,
    messages: metadata.counts.messages + 20,
    activations: 0,
    runs: 0,
  };
  assertCounts(afterWorkload, expectedFinal, "post-workload authority");

  const statusText = readFileSync(`/proc/${firstServer.child.pid}/status`, "utf8");
  const rssMatch = statusText.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  await stopServer(firstServer);

  const restartServer = startServer();
  const restartHealthMs = await waitFor("/api/health");
  await waitFor("/api/ready");
  const afterRestart = authorityCounts();
  assertCounts(afterRestart, expectedFinal, "restart authority");
  await stopServer(restartServer);

  const result = {
    recordedAt: new Date().toISOString(),
    hardware: {
      cpu: cpus()[0]?.model,
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    fixture: metadata.counts,
    workDir: keepWorkDir ? workDir : undefined,
    startup: {
      healthMs: Math.round(healthMs * 100) / 100,
      restartHealthMs: Math.round(restartHealthMs * 100) / 100,
      profile: serverProfiles,
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
      replayStatus: replayResult.status,
      conflictStatus: conflictResult.status,
    },
    mixed: {
      timing: percentileSummary(mixedResults.map((result) => result.ms)),
      statuses: mixedResults.map((result) => result.status),
    },
    payloads: pages,
    counts: { initial: initialCounts, afterWorkload, afterRestart },
    authority: {
      activations: afterRestart.activations,
      runs: afterRestart.runs,
    },
    rssBytes: rssMatch ? Number(rssMatch[1]) * 1024 : null,
  };
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}
`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
} finally {
  await stopServer(activeServer);
  if (!keepWorkDir) safeRemoveWorkDir(workDir, runId);
}
