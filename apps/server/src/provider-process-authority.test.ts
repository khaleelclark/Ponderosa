import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { openDb } from "@ponderosa/agents";
import { recoveredRuntimeProcessHandle, runtimeProcessIdentity } from "@ponderosa/engines";
import { ProviderProcessAuthority } from "./provider-process-authority.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

function liveDetachedProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const identity = runtimeProcessIdentity(child);
  if (!identity) throw new Error("test child did not expose a process birth identity");
  child.unref();
  return {
    identity,
    handle: recoveredRuntimeProcessHandle(identity, {
      label: "qualification provider",
      termGraceMs: 500,
      killConfirmationMs: 500,
    }),
  };
}

describe("durable provider process authority", () => {
  linuxTest("recovers a crashed boot and qualifies cancellation plus Agent/Project deletion", async () => {
    const opened = openDb(":memory:");
    const cleanup = new Set<ReturnType<typeof liveDetachedProcess>["handle"]>();
    try {
      const crashed = liveDetachedProcess();
      cleanup.add(crashed.handle);
      new ProviderProcessAuthority(opened.client, "server:boot-a").register(crashed.handle, {
        purpose: "provider Run",
        projectId: "project-a",
        agentId: "agent-a",
        runId: "run-a",
      });
      const restarted = new ProviderProcessAuthority(opened.client, "server:boot-b");
      expect(await restarted.recoverPreviousWorkers()).toBe(1);
      expect(crashed.handle.isAlive()).toBe(false);

      const cancelled = liveDetachedProcess();
      cleanup.add(cancelled.handle);
      restarted.register(cancelled.handle, {
        purpose: "provider Run",
        projectId: "project-b",
        agentId: "agent-b",
        runId: "run-b",
      });
      expect(await restarted.terminateRun("run-b")).toBe(1);
      expect(cancelled.handle.isAlive()).toBe(false);

      const agentDeleted = liveDetachedProcess();
      cleanup.add(agentDeleted.handle);
      restarted.register(agentDeleted.handle, {
        purpose: "persistent provider runtime",
        projectId: "project-c",
        agentId: "agent-c",
        runId: "run-c",
      });
      expect(await restarted.terminateAgents(new Set(["agent-c"]), "Agent deletion qualification")).toBe(1);
      expect(agentDeleted.handle.isAlive()).toBe(false);

      const projectDeleted = liveDetachedProcess();
      cleanup.add(projectDeleted.handle);
      restarted.register(projectDeleted.handle, {
        purpose: "model discovery",
        projectId: "project-d",
      });
      expect(await restarted.terminateProject("project-d", "Project deletion qualification")).toBe(1);
      expect(projectDeleted.handle.isAlive()).toBe(false);
      expect(restarted.count()).toBe(0);
    } finally {
      await Promise.allSettled([...cleanup].map((handle) => handle.close()));
      opened.client.close();
    }
  });

  linuxTest("survives a SIGKILL crash and recovers from durable SQLite in a new process", async () => {
    const qualificationDir = await mkdtemp(join(tmpdir(), "ponderosa-provider-restart-"));
    const dbPath = join(qualificationDir, "authority.sqlite");
    const serverDir = fileURLToPath(new URL("..", import.meta.url));
    let cleanupHandle: ReturnType<typeof liveDetachedProcess>["handle"] | undefined;
    try {
      const crashedWorkerScript = `
        import { spawn } from "node:child_process";
        import { openDb } from "@ponderosa/agents";
        import { recoveredRuntimeProcessHandle, runtimeProcessIdentity } from "@ponderosa/engines";
        import { ProviderProcessAuthority } from "./dist/provider-process-authority.js";
        const opened = openDb(process.argv[1]);
        const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true, stdio: "ignore",
        });
        const identity = runtimeProcessIdentity(provider);
        if (!identity) throw new Error("provider identity unavailable");
        const handle = recoveredRuntimeProcessHandle(identity, {
          label: "crash qualification provider", termGraceMs: 500, killConfirmationMs: 500,
        });
        new ProviderProcessAuthority(opened.client, "server:boot-crashed").register(handle, {
          purpose: "provider Run", projectId: "project-crash", agentId: "agent-crash", runId: "run-crash",
        });
        provider.unref();
        process.stdout.write(JSON.stringify(identity) + "\\n");
        setInterval(() => {}, 1000);
      `;
      const crashedWorker = spawn(
        process.execPath,
        ["--input-type=module", "-e", crashedWorkerScript, dbPath],
        { cwd: serverDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      crashedWorker.stdout.setEncoding("utf8");
      crashedWorker.stderr.setEncoding("utf8");
      crashedWorker.stdout.on("data", chunk => { stdout += chunk; });
      crashedWorker.stderr.on("data", chunk => { stderr += chunk; });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`crashed worker did not become ready: ${stderr}`)), 10_000);
        const check = (): void => {
          if (!stdout.includes("\n")) return;
          clearTimeout(timeout);
          resolve();
        };
        crashedWorker.stdout.on("data", check);
        crashedWorker.once("exit", (code, signal) => {
          clearTimeout(timeout);
          reject(new Error(`crashed worker exited before qualification kill (${code ?? signal}): ${stderr}`));
        });
        check();
      });
      const identity = JSON.parse(stdout.trim()) as NonNullable<ReturnType<typeof runtimeProcessIdentity>>;
      cleanupHandle = recoveredRuntimeProcessHandle(identity, {
        label: "crash qualification cleanup",
        termGraceMs: 500,
        killConfirmationMs: 500,
      });
      expect(cleanupHandle.isAlive()).toBe(true);

      const crashedExit = once(crashedWorker, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
      process.kill(crashedWorker.pid!, "SIGKILL");
      const [, signal] = await crashedExit;
      expect(signal).toBe("SIGKILL");
      expect(cleanupHandle.isAlive()).toBe(true);

      const restartedWorkerScript = `
        import { openDb } from "@ponderosa/agents";
        import { ProviderProcessAuthority } from "./dist/provider-process-authority.js";
        const opened = openDb(process.argv[1]);
        const recovered = await new ProviderProcessAuthority(opened.client, "server:boot-restarted").recoverPreviousWorkers();
        process.stdout.write(String(recovered));
        opened.client.close();
      `;
      const restarted = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", restartedWorkerScript, dbPath],
        { cwd: serverDir, encoding: "utf8", timeout: 10_000 },
      );
      expect(restarted.status, restarted.stderr).toBe(0);
      expect(restarted.stdout).toBe("1");
      expect(cleanupHandle.isAlive()).toBe(false);

      const reopened = openDb(dbPath);
      try {
        expect(new ProviderProcessAuthority(reopened.client, "server:inspection").count()).toBe(0);
      } finally {
        reopened.client.close();
      }
    } finally {
      if (cleanupHandle?.isAlive()) await cleanupHandle.close();
      await rm(qualificationDir, { recursive: true, force: true });
    }
  }, 20_000);
});
