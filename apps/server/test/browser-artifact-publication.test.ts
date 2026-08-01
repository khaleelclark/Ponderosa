import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserSessionManager,
  type BrowserDriver,
  type BrowserScope,
} from "../src/browser-session-manager.js";
import { createBrowserAuthority } from "../src/browser-authority.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function fakeDriver(): BrowserDriver {
  const page = { url: "https://example.test/", title: "Example" };
  return {
    pageInfo: async () => page,
    navigate: async () => page,
    inspect: async () => "Example page",
    click: async () => page,
    fill: async () => page,
    key: async () => page,
    pointer: async () => page,
    type: async () => page,
    scroll: async () => page,
    capture: async () => Buffer.from("managed screenshot bytes"),
    close: async () => undefined,
  };
}

describe("BrowserSessionManager screenshot publication", () => {
  it("returns an attachable reference only after the managed artifact event commits", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ponderosa-browser-artifact-"));
    temporaryDirectories.push(dataDir);
    const scope: BrowserScope = {
      projectId: "project-1",
      agentId: "agent-1",
      runId: "run-1",
      conversationId: "conversation-1",
    };
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    let publicationEntered!: () => void;
    const enteredPublication = new Promise<void>((resolve) => { publicationEntered = resolve; });
    let publishedArtifactId: string | undefined;
    const manager = new BrowserSessionManager(
      dataDir,
      async () => fakeDriver(),
      async (_eventScope, event) => {
        if (event.type !== "browser_screenshot") return;
        publishedArtifactId = event.artifactId;
        publicationEntered();
        await publicationGate;
      },
    );

    await manager.open(scope);
    let completed = false;
    const capture = manager.captureArtifact(scope).then((result) => {
      completed = true;
      return result;
    });
    await enteredPublication;

    expect(publishedArtifactId).toBeTruthy();
    expect(completed).toBe(false);
    releasePublication();
    const result = await capture;
    expect(result.artifactId).toBe(publishedArtifactId);
    expect(result.artifactRef).toBe(`ponderosa://artifact/${publishedArtifactId}`);
    await manager.close(scope);
  });

  it("rejects capture when the authoritative Run disappeared before screenshot publication", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ponderosa-browser-artifact-stale-run-"));
    temporaryDirectories.push(dataDir);
    const authority = createBrowserAuthority({
      dataDir,
      driverFactory: async () => fakeDriver(),
      store: {} as never,
      activeRuns: new Map(),
      publish: () => undefined,
      logWarn: () => undefined,
      persistRuntimeEvent: async () => {
        throw new Error("stale screenshot must not reach persistence");
      },
    });
    const scope: BrowserScope = {
      projectId: "project-1",
      agentId: "agent-1",
      runId: "run-1",
      conversationId: "conversation-1",
    };

    await authority.browserSessions.open(scope);
    await expect(authority.browserSessions.captureArtifact(scope)).rejects.toThrow(
      "screenshot lost exact Run authority before publication",
    );
    await authority.browserSessions.close(scope);
  });
});
