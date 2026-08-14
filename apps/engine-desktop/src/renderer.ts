interface LogTail {
  text: string;
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
}

interface EngineSnapshot {
  state: "starting" | "running" | "reachable" | "degraded" | "stopping" | "cleanup_incomplete" | "stopped" | "error";
  detail: string;
  pid?: number;
  version?: string;
  revision?: string;
  channel?: string;
  startedAt?: string;
  dataDir?: string;
  acceptingDurableIntake?: boolean;
  leasingRuns?: boolean;
  activeRunCount: number;
  logs: { server: LogTail; error: LogTail };
}

interface PonderosaEngineBridge {
  snapshot(): Promise<EngineSnapshot>;
  openPonderosa(): Promise<void>;
  restart(): Promise<void>;
  quit(): Promise<boolean>;
  copyLogs(text: string): Promise<void>;
}

declare global {
  interface Window {
    ponderosaEngine: PonderosaEngineBridge;
  }
}

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Engine UI element: ${id}`);
  return element as T;
};

const stateDot = byId<HTMLSpanElement>("state-dot");
const stateLabel = byId<HTMLSpanElement>("state-label");
const detail = byId<HTMLParagraphElement>("detail");
const version = byId<HTMLElement>("version");
const revision = byId<HTMLElement>("revision");
const uptime = byId<HTMLElement>("uptime");
const processId = byId<HTMLElement>("process");
const intake = byId<HTMLElement>("intake");
const agents = byId<HTMLElement>("agents");
const dataDir = byId<HTMLElement>("data-dir");
const logOutput = byId<HTMLPreElement>("log-output");
const openButton = byId<HTMLButtonElement>("open");
const restartButton = byId<HTMLButtonElement>("restart");
const quitButton = byId<HTMLButtonElement>("quit");
const refreshButton = byId<HTMLButtonElement>("refresh");
const copyButton = byId<HTMLButtonElement>("copy");
const serverButton = byId<HTMLButtonElement>("server-log");
const errorButton = byId<HTMLButtonElement>("error-log");

let selectedLog: "server" | "error" = "server";
let latest: EngineSnapshot | undefined;
let busy = false;

function formatDuration(startedAt: string | undefined): string {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

function render(snapshot: EngineSnapshot): void {
  latest = snapshot;
  document.body.dataset.state = snapshot.state;
  stateDot.className = `state-dot ${snapshot.state}`;
  stateLabel.textContent = snapshot.state === "running"
    ? "Running"
    : snapshot.state === "reachable"
      ? "Reachable"
      : snapshot.state === "degraded"
        ? "Degraded"
        : snapshot.state === "stopping"
          ? "Stopping"
          : snapshot.state === "cleanup_incomplete"
            ? "Cleanup incomplete"
    : snapshot.state === "starting"
      ? "Starting"
      : snapshot.state === "error"
        ? "Needs attention"
        : "Stopped";
  detail.textContent = snapshot.detail;
  version.textContent = snapshot.version
    ? `${snapshot.version}${snapshot.channel ? ` · ${snapshot.channel}` : ""}`
    : "—";
  revision.textContent = snapshot.revision?.slice(0, 12) ?? "—";
  uptime.textContent = formatDuration(snapshot.startedAt);
  processId.textContent = snapshot.pid ? String(snapshot.pid) : "—";
  intake.textContent = snapshot.acceptingDurableIntake === undefined
    ? "Unavailable"
    : snapshot.acceptingDurableIntake
      ? snapshot.leasingRuns ? "Ready" : "Paused"
      : "Blocked";
  agents.textContent = snapshot.activeRunCount
    ? `${snapshot.activeRunCount} active`
    : "None active";
  dataDir.textContent = snapshot.dataDir ?? "—";
  const selected = snapshot.logs[selectedLog];
  logOutput.textContent = selected.text ||
    (["running", "reachable", "degraded"].includes(snapshot.state) ? "No log output yet." : snapshot.detail);
  const totalKiB = (selected.totalBytes / 1024).toFixed(1);
  logOutput.setAttribute(
    "aria-label",
    `${selectedLog} log${selected.truncated ? `, latest ${totalKiB} KiB shown` : ""}`,
  );
  openButton.disabled = !["running", "reachable", "degraded"].includes(snapshot.state) || busy;
  restartButton.disabled = ["starting", "stopping"].includes(snapshot.state) || busy;
  quitButton.disabled = busy;
}

async function refresh(): Promise<void> {
  try {
    render(await window.ponderosaEngine.snapshot());
  } catch (error) {
    detail.textContent = error instanceof Error ? error.message : "Engine status is unavailable.";
  }
}

async function act(action: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  if (latest) render(latest);
  try {
    await action();
  } finally {
    busy = false;
    await refresh();
  }
}

openButton.addEventListener("click", () => void act(() => window.ponderosaEngine.openPonderosa()));
restartButton.addEventListener("click", () => void act(() => window.ponderosaEngine.restart()));
quitButton.addEventListener("click", () => void act(() => window.ponderosaEngine.quit()));
refreshButton.addEventListener("click", () => void refresh());
copyButton.addEventListener("click", () => {
  const text = latest?.logs[selectedLog].text ?? "";
  void window.ponderosaEngine.copyLogs(text);
  copyButton.textContent = "Copied";
  window.setTimeout(() => { copyButton.textContent = "Copy"; }, 1_200);
});
serverButton.addEventListener("click", () => {
  selectedLog = "server";
  serverButton.dataset.selected = "true";
  errorButton.dataset.selected = "false";
  if (latest) render(latest);
});
errorButton.addEventListener("click", () => {
  selectedLog = "error";
  serverButton.dataset.selected = "false";
  errorButton.dataset.selected = "true";
  if (latest) render(latest);
});

void refresh();
window.setInterval(() => void refresh(), 2_000);

export {};
