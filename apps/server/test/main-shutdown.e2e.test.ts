import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

async function unusedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production entrypoint shutdown", () => {
  it.runIf(process.platform !== "win32")("closes live event streams before awaiting Fastify shutdown", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-main-stream-shutdown-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const repoDir = path.join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, "README.md"), "# stream shutdown test\n");
    const port = await unusedPort();
    const entrypoint = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    const server = spawn(process.execPath, [entrypoint], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PONDEROSA_DATA_DIR: dataDir,
        PONDEROSA_BROWSE_ROOTS: repoDir,
        PONDEROSA_HOST: "127.0.0.1",
        PONDEROSA_PORT: String(port),
      },
    });
    children.push(server);
    let diagnostics = "";
    server.stdout?.on("data", (chunk) => { diagnostics += chunk.toString(); });
    server.stderr?.on("data", (chunk) => { diagnostics += chunk.toString(); });
    const base = `http://127.0.0.1:${port}`;

    await vi.waitFor(async () => {
      const response = await fetch(`${base}/api/health`).catch(() => undefined);
      expect(response?.status, diagnostics).toBe(200);
    }, { timeout: 8_000, interval: 25 });

    const stream = await fetch(`${base}/api/workspace/stream`);
    expect(stream.status, diagnostics).toBe(200);
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk.value)).toContain("workspace_status");

    server.kill("SIGTERM");
    await vi.waitFor(() => expect(server.exitCode, diagnostics).toBe(0), { timeout: 4_000, interval: 25 });
    await expect(reader!.read()).resolves.toMatchObject({ done: true });
  }, 10_000);

  it.runIf(process.platform !== "win32")("awaits a stubborn provider and descendant after SIGTERM", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-main-shutdown-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    const pidFile = path.join(root, "provider-pids.json");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(repoDir, "README.md"), "# shutdown test\n");
    const fakeProvider = fileURLToPath(new URL("../../../packages/engines/test/fake-codex-app-server.mjs", import.meta.url));
    const codexWrapper = path.join(binDir, "codex");
    writeFileSync(codexWrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeProvider}" "$@"\n`);
    chmodSync(codexWrapper, 0o755);
    const port = await unusedPort();
    const entrypoint = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    const server = spawn(process.execPath, [entrypoint], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PONDEROSA_DATA_DIR: dataDir,
        PONDEROSA_BROWSE_ROOTS: repoDir,
        PONDEROSA_HOST: "127.0.0.1",
        PONDEROSA_PORT: String(port),
        PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS: "1",
        PONDEROSA_TEST_IGNORE_SIGTERM: "1",
        PONDEROSA_TEST_DESCENDANT_PID_FILE: pidFile,
      },
    });
    children.push(server);
    let diagnostics = "";
    server.stdout?.on("data", (chunk) => { diagnostics += chunk.toString(); });
    server.stderr?.on("data", (chunk) => { diagnostics += chunk.toString(); });
    const base = `http://127.0.0.1:${port}`;

    await vi.waitFor(async () => {
      const response = await fetch(`${base}/api/health`).catch(() => undefined);
      expect(response?.status, diagnostics).toBe(200);
    }, { timeout: 8_000, interval: 25 });
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Shutdown", hostPath: repoDir, defaultEngine: "codex" }),
    });
    const projectBody = await projectResponse.text();
    expect(projectResponse.status, `${diagnostics}\n${projectBody}`).toBe(200);
    const project = JSON.parse(projectBody) as { id: string };
    expect(project?.id).toBeTruthy();
    const agentResponse = await fetch(`${base}/api/projects/${project!.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Stubborn", engine: "codex" }),
    });
    expect(agentResponse.status, diagnostics).toBe(200);
    const agent = await agentResponse.json() as { id: string };
    const messageResponse = await fetch(`${base}/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Keep the provider active" }),
    });
    expect(messageResponse.status, diagnostics).toBe(202);
    await vi.waitFor(() => expect(existsSync(pidFile), diagnostics).toBe(true), { timeout: 8_000, interval: 25 });
    const provider = JSON.parse(readFileSync(pidFile, "utf8")) as { providerPid: number; descendantPid: number };
    expect(processAlive(provider.providerPid)).toBe(true);
    expect(processAlive(provider.descendantPid)).toBe(true);

    server.kill("SIGTERM");
    await sleep(100);
    expect(server.exitCode, diagnostics).toBeNull();
    expect(processAlive(provider.providerPid)).toBe(true);
    expect(processAlive(provider.descendantPid)).toBe(true);

    await vi.waitFor(() => expect(server.exitCode, diagnostics).not.toBeNull(), { timeout: 8_000, interval: 25 });
    await vi.waitFor(() => {
      expect(processAlive(provider.providerPid)).toBe(false);
      expect(processAlive(provider.descendantPid)).toBe(false);
    }, { timeout: 2_000, interval: 25 });
    expect(server.exitCode, diagnostics).toBe(0);
  }, 15_000);
});
