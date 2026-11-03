import { answerClaudeNativeQuestions } from "./native-questions.js";
import { ClaudeReplayFraming } from "./claude-replay-framing.js";
import { claudeTurnContent } from "./typed-input.js";
import { ClaudeControls } from "./claude-controls.js";
import { requestNativeApproval } from "./native-approvals.js";
import { ClaudeFileHistory } from "./claude-file-history.js";
import { ClaudeTaskStop } from "./claude-task-stop.js";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeNativeCompaction } from "./claude-native-compaction.js";
import { ClaudeTaskLifetime } from "./claude-task-lifetime.js";
import { StderrTail } from "./stderr-tail.js";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AgentEvent,
  EngineCapabilities,
  EngineModelOption,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  RuntimeCommandResult,
  RuntimeContextUsage,
  RuntimeSteerResult,
  RuntimeTurnInput,
} from "@ponderosa/core";
import { spawnContainedCli } from "./contained-spawn.js";
import { claudeStreamEventMapper } from "./claude-stream-events.js";
import { ClaudeContextUsage } from "./claude-context-usage.js";
import { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError } from "./jsonl.js";
import { processGroupAlive, runtimeProcessIdentity, terminateProcessGroup } from "./process-termination.js";
import type { NativeProcessTreeAuthority } from "./process-termination.js";
import { claudeBillingEnvironment } from "./runtime-environment.js";
import { renderSeedPrompt } from "./seed-history.js";
import { normalizeClaudeInitCapabilities } from "./capabilities.js";
import { normalizeClaudeProviderModels } from "./claude-models.js";
import { encodeSessionTools } from "./ponderosa-mcp-contract.js";

interface ClaudeStreamSessionOptions extends OpenRuntimeSessionOptions {
  bin: string;
  permissionMode: string;
  killGraceMs: number;
}

export function claudeCapabilityRestrictionArgs(
  restrictions: OpenRuntimeSessionOptions["capabilityRestrictions"],
): string[] {
  if (!restrictions) return [];
  const disallowed = new Set<string>();
  if (restrictions.filesystemWriteRestricted) {
    // Claude's Bash tool can write files just as readily as its editor tools.
    // Claude does not expose a trustworthy read-only shell mode, so the
    // deny-only capability must remove Bash rather than claim partial safety.
    disallowed.add("Bash");
    disallowed.add("PowerShell");
    disallowed.add("Write");
    disallowed.add("Edit");
    disallowed.add("NotebookEdit");
  }
  for (const connectorName of restrictions.restrictedConnectorNames) {
    const normalized = connectorName.replace(/[^\p{L}\p{N}_-]/gu, "_");
    disallowed.add(`mcp__${normalized}`);
  }
  return disallowed.size ? ["--disallowedTools", [...disallowed].sort().join(",")] : [];
}

export class ClaudeStreamSession implements RuntimeSession {
  private replayFraming?: ClaudeReplayFraming;
  readonly engineAgentId: string;
  readonly events: AsyncIterable<AgentEvent>;
  private readonly child: ChildProcess;
  private readonly fileHistory: ClaudeFileHistory;
  private historyActive = false;
  private reportDrainedRootExit?: () => void;
  private terminalEvent?: Extract<AgentEvent, {type:"error"}>;
  private nativeCommand?: ClaudeNativeCompaction;
  private readonly taskLifetime: ClaudeTaskLifetime;
  private readonly taskStop: ClaudeTaskStop;
  private nativeUsage?: RuntimeContextUsage;
  private usageInvalidated = false;
  private sessionInitialization?: unknown;
  private initialized = false;
  private nativeCompactAdvertised = false;
  private initializationReady!: () => void;
  private readonly initialization = new Promise<void>(resolve => { this.initializationReady = resolve; });
  private readonly controls = new ClaudeControls(frame => this.writeFrame(frame), () => this.engineAgentId);
  private activeInputId?: string;
  private selectedModel?: string;
  private readonly approvals = new Map<string, AbortController>();
  private readonly seenApprovalIds = new Set<string>();
  private liveControlActive = false;
  private active = false;
  private closed = false;
  private readonly stderrTail = new StderrTail();
  private closePromise?: Promise<void>;
  private readonly seedHistory: OpenRuntimeSessionOptions["history"];
  private capabilitiesSnapshot?: EngineCapabilities;
  private providerModels?: EngineModelOption[];
  private claudeCodeVersion?: string;
  private readonly modelInitializationRequestId = `ponderosa-models-${randomUUID()}`;
  private readonly contextObservations: ClaudeContextUsage;
  private readonly nativeAuthority?: NativeProcessTreeAuthority;
  readonly processIdentity;

  constructor(private readonly opts: ClaudeStreamSessionOptions) {
    if (!opts.onRuntimeSpawned) {
      throw new Error("persistent runtime opening requires a spawn-time termination registrar");
    }
    this.selectedModel = opts.model;
    this.seedHistory = opts.resumeSessionId || opts.transcriptFork ? [] : [...opts.history];
    this.engineAgentId = opts.transcriptFork?.newSessionId ?? opts.resumeSessionId ?? randomUUID();
    this.fileHistory = new ClaudeFileHistory(this.engineAgentId, frame => this.writeFrame(frame), opts.fileCheckpointTracking === true);
    this.taskLifetime = new ClaudeTaskLifetime(this.engineAgentId);
    this.taskStop = new ClaudeTaskStop(this.engineAgentId);
    this.contextObservations = new ClaudeContextUsage(this.engineAgentId);
    const ponderosaMcp = opts.dynamicTools?.length && opts.environment?.PONDEROSA_AGENT_MESSAGE_URL && opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN
      ? JSON.stringify({
          mcpServers: {
            ponderosa: {
              type: "stdio",
              command: process.execPath,
              args: [fileURLToPath(new URL("./ponderosa-mcp.js", import.meta.url))],
              env: {
                PONDEROSA_AGENT_TOOL_DEFINITIONS: encodeSessionTools(opts.dynamicTools),
                PONDEROSA_AGENT_TOOL_NAMES: opts.environment.PONDEROSA_AGENT_TOOL_NAMES ?? JSON.stringify(opts.dynamicTools.map(tool => tool.name)),
              },
            },
          },
        })
      : undefined;
    const restrictionArgs=claudeCapabilityRestrictionArgs(opts.capabilityRestrictions);
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--include-partial-messages",
      "--permission-mode", opts.permissionMode,
      ...(opts.handleElicitation ? ["--permission-prompt-tool", "stdio"] : []),
      ...(opts.systemPrompt ? ["--append-system-prompt", opts.systemPrompt] : []),
      ...(ponderosaMcp ? ["--mcp-config", ponderosaMcp] : []),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.effort ? ["--effort", opts.effort] : []),
      ...(opts.transcriptFork
        ? ["--resume",opts.transcriptFork.sourceSessionId,"--fork-session","--session-id",this.engineAgentId,"--resume-session-at",opts.transcriptFork.throughId]
        : opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : ["--session-id", this.engineAgentId]),
      // Native questions use the same human form and exact callback lifetime.
      ...restrictionArgs,
    ];
    opts.assertHistoryCurrent?.();
    const environment = { ...claudeBillingEnvironment(opts.environment, opts.expectedBillingMode), CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: opts.fileCheckpointTracking === true ? "true" : "false" };
    const contained = spawnContainedCli({
      bin: opts.bin,
      args,
      cwd: opts.cwd,
      env: environment,
      stdin: "pipe",
    });
    this.child = contained.child;
    this.nativeAuthority = contained.authority;
    this.processIdentity = contained.authority ? undefined : runtimeProcessIdentity(this.child);
    opts.onRuntimeSpawned(this);
    let rootExitReported = false;
    let postExitDrainTimer: NodeJS.Timeout | undefined;
    let rootExit: { exitCode?: number | null; signal?: string | null } | undefined;
    const reportRootExit = () => {
      if (rootExitReported || !rootExit) return;
      rootExitReported = true;
      if (postExitDrainTimer) clearTimeout(postExitDrainTimer);
      opts.onRuntimeRootExit?.({ ...rootExit, stderr: this.stderrTail.text(),
        ...(this.terminalEvent ? { terminalEvent: this.terminalEvent } : {}) });
    };
    const observeRootExit = (code?: number | null, signal?: NodeJS.Signals | null) => {
      if (rootExit) return;
      rootExit = { exitCode: code, signal };
      // Revoke tool authority immediately. Only generic settlement waits for
      // the existing bounded stdout drain: a typed error may still be in the pipe.
      opts.onRuntimeRootExit?.({ ...rootExit, outputDraining: true });
      postExitDrainTimer = setTimeout(() => {
        this.child.stdout?.destroy();
        reportRootExit();
      }, 1000);
    };
    this.reportDrainedRootExit = reportRootExit;
    this.child.once("error", () => observeRootExit());
    this.child.once("exit", observeRootExit);
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail.append(chunk);
    });
    opts.signal.addEventListener("abort", () => { void this.close().catch(() => undefined); });
    this.child.stdin?.write(`${JSON.stringify({
      type: "control_request",
      request_id: this.modelInitializationRequestId,
      request: { subtype: "initialize", hooks: { Stop: [{ hookCallbackIds: [this.taskLifetime.stopCallbackId] }] }, sdkMcpServers: [], perTaskStopAffordance: true },
    })}\n`);
    // One stdout reader serves both ordinary turns and idle native commands.
    // Backpressure bounds normal event buffering; native receipts never enter it.
    const output = new PassThrough({ objectMode: true, highWaterMark: 64 });
    output.on("error", () => undefined);
    this.events = { [Symbol.asyncIterator]: () =>
      output.iterator({ destroyOnReturn: false }) as AsyncIterator<AgentEvent> };
    void this.readEvents(output);
  }

  private async readEvents(output: PassThrough): Promise<void> {
    try {
      for await (const event of this.eventStream()) {
        if (!output.write(event)) await once(output, "drain");
      }
      output.end();
    } catch (error) {
      output.destroy(error instanceof Error ? error : new Error("Claude stream failed"));
      void this.close().catch(() => undefined);
    } finally {
      this.fileHistory.close();
      this.nativeCommand?.fail();
      this.controls.close();
      this.cancelApprovals();
      this.initializationReady();
    }
  }

  async startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }> {
    input.assertCurrent?.();
    if (this.closed || this.active || this.taskLifetime.ownsRun || this.nativeCommand && !this.nativeCommand.succeeded) throw new Error("Claude has active or uncertain native work");
    if (this.historyActive || this.fileHistory.uncertain) throw new Error("Native file history is active or uncertain");
    if (this.liveControlActive || this.controls.uncertain) throw new Error("Claude native control is active or uncertain");
    if (input.nativeAction) throw new Error("This native turn action is unsupported by Claude");
    if (input.effort && input.effort !== this.opts.effort) throw new Error("Claude effort change requires reopening the retained session");
    const turnId = input.clientMessageId ?? randomUUID();
    const prompt = this.opts.resumeSessionId || this.opts.transcriptFork
      ? input.prompt
      : renderSeedPrompt(this.seedHistory, input.prompt);
    let frame = this.inputFrame(prompt, turnId, input.inputFiles);
    if (input.model && input.model !== this.selectedModel) {
      await this.setLiveModel(input.model);
      input.assertCurrent?.();
      frame = this.inputFrame(prompt, turnId, input.inputFiles);
    }
    input.assertCurrent?.();
    // Validation and any asynchronous model acknowledgement precede lifetime changes.
    this.nativeCommand = undefined;
    this.nativeUsage = undefined;
    this.terminalEvent = undefined;
    this.fileHistory.beginTurn();
    this.taskLifetime.beginTurn();
    this.contextObservations.beginTurn(turnId);
    this.active = true;
    this.activeInputId = turnId;
    try {
      await this.writeInputFrame(frame);
      this.seedHistory.splice(0);
    } catch (error) {
      this.active = false;
      this.contextObservations.endTurn();
      throw error;
    }
    return { turnId };
  }

  async nativeHistory() { return this.fileHistory.catalog(); }

  async rewindFiles(messageId: string, dryRun: boolean) {
    if (this.closed || this.active || this.taskLifetime.ownsRun || this.liveControlActive || this.controls.uncertain || this.nativeCommand && !this.nativeCommand.succeeded || this.historyActive) throw new Error("Native session is busy");
    this.historyActive = true;
    try { return await this.fileHistory.rewind(messageId,dryRun); }
    finally { this.historyActive = false; }
  }

  async capabilities(): Promise<EngineCapabilities> {
    if (!this.initialized && !this.closed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.initialization, new Promise<void>(resolve => {
          timer = setTimeout(resolve, 5_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    const nativeControls = ["native-model", "native-context-usage", ...(this.opts.handleElicitation ? ["native-permission-mode"] : [])].map(name => ({
      name, description: name === "native-model" ? "Set the retained native model" : name === "native-context-usage" ? "Read current native context occupancy" : "Set human-selected native permission mode",
      source: "adapter-implemented" as const, acceptsArguments: name !== "native-context-usage", insertText: `/${name}`,
      invocation: "runtime" as const, status: "available" as const,
    })).filter(control => !this.capabilitiesSnapshot?.commands.some(command => command.name === control.name && (command.source === "skill" || command.source === "plugin")));
    if (this.capabilitiesSnapshot) return { ...this.capabilitiesSnapshot, commands: [
      ...this.capabilitiesSnapshot.commands.filter(command => !nativeControls.some(control => control.name === command.name)), ...nativeControls] };
    return {
      steering: true,
      persistentSessions: true,
      sessionId: this.engineAgentId,
      ...(this.opts.model ? {
        selectedModel: this.opts.model,
        model: this.opts.model,
      } : {}),
      commands: this.initialized && this.nativeCompactAdvertised && this.opts.resumeSessionId ? [{
        name: "compact", description: "Compact retained Claude context with verified native receipts",
        source: "adapter-implemented", acceptsArguments: false, insertText: "/compact",
        invocation: "runtime", status: "available",
      }, ...nativeControls] : nativeControls,
      mcpServers: [],
      composerCapabilities: [],
    };
  }

  contextUsage(): RuntimeContextUsage | undefined {
    if (this.nativeCommand && !this.nativeCommand.succeeded) return undefined;
    return this.nativeUsage ?? (this.usageInvalidated ? undefined : this.contextObservations.contextUsage());
  }

  async invokeCommand(name: string, argumentsText?: string): Promise<RuntimeCommandResult> {
    if (this.historyActive || this.fileHistory.uncertain) throw new Error("Native history active or uncertain");
    if (name === "native-context-usage") {
      if (argumentsText?.trim() || this.closed || this.liveControlActive || this.nativeCommand && !this.nativeCommand.succeeded) throw new Error("Claude context control unavailable");
      this.liveControlActive = true;
      try {
        const raw = await this.controls.request({ subtype: "get_context_usage" });
        const usage = raw as {totalTokens?:unknown;rawMaxTokens?:unknown;model?:unknown} | undefined;
        if (!usage || typeof usage.totalTokens !== "number" || typeof usage.rawMaxTokens !== "number" ||
            !Number.isSafeInteger(usage.totalTokens) || !Number.isSafeInteger(usage.rawMaxTokens) ||
            usage.totalTokens < 0 || usage.totalTokens > 2_147_483_647 || usage.rawMaxTokens <= 0 || usage.rawMaxTokens > 2_147_483_647 ||
            typeof usage.model !== "string" || !usage.model.trim()) throw new Error("Invalid native occupancy");
        this.nativeUsage = { usedTokens: usage.totalTokens as number, windowTokens: usage.rawMaxTokens as number, providerSessionGeneration: this.engineAgentId };
        this.usageInvalidated = false;
        return { outcome: "completed", contextUsage: this.nativeUsage };
      } finally { this.liveControlActive = false; }
    }
    if (name === "native-model" || name === "native-permission-mode") {
      if (this.closed || this.liveControlActive || this.nativeCommand && !this.nativeCommand.succeeded) throw new Error("Claude native work is active or uncertain");
      if (name === "native-model") await this.setLiveModel(argumentsText ?? "");
      else {
        if (!["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "auto"].includes(argumentsText ?? "")) throw new Error("Invalid Claude permission mode");
        if (!this.opts.handleElicitation) throw new Error("Human permission callback is unavailable");
        this.liveControlActive = true;
        try { await this.controls.request({ subtype: "set_permission_mode", mode: argumentsText }); }
        finally { this.liveControlActive = false; }
      }
      return { outcome: "completed", message: "Native control acknowledged; this does not settle source work or confirm process termination." };
    }
    if (this.liveControlActive || this.controls.uncertain) throw new Error("Claude control is active or uncertain");
    if (name !== "compact" || argumentsText?.trim()) throw new Error("Claude native compact accepts no arguments");
    if (this.closed || this.active || this.taskLifetime.ownsRun || this.nativeCommand && !this.nativeCommand.succeeded) {
      throw new Error("Claude has active or uncertain native work; do not repeat compaction");
    }
    this.terminalEvent = undefined;
    const command = new ClaudeNativeCompaction(this.engineAgentId, randomUUID());
    this.nativeCommand = command;
    if (this.sessionInitialization) command.observe(this.sessionInitialization);
    this.nativeUsage = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unknown = (): RuntimeCommandResult => ({ outcome: "outcome_unknown",
      message: "Native compaction or fresh occupancy is unconfirmed. Do not repeat the command; source work remains held." });
    const perform = async (): Promise<RuntimeCommandResult> => {
      await this.initialization;
      if (this.closed || command.cancelled || !this.initialized || !this.nativeCompactAdvertised ||
          !this.sessionInitialization ||
          this.capabilitiesSnapshot?.commands.some(candidate => candidate.name === "compact" && candidate.invocation !== "runtime")) {
        command.fail(); return unknown();
      }
      command.inputSent = true;
      // Documented built-in command dispatch, not a source Run or prose prompt.
      await this.writeInput("/compact", command.commandId);
      if (!await command.completion || this.closed || command.cancelled) return unknown();
      const requestId = `ponderosa-context-${randomUUID()}`;
      if (!command.requestUsage(requestId)) return unknown();
      await this.writeFrame({ type: "control_request", request_id: requestId,
        request: { subtype: "get_context_usage" } });
      const usage = await command.usage;
      if (!usage || this.closed || command.cancelled) return unknown();
      this.nativeUsage = usage;
      return { outcome: "completed", contextUsage: usage };
    };
    try {
      return await Promise.race([perform(), new Promise<RuntimeCommandResult>(resolve => {
        timer = setTimeout(() => { command.fail(); resolve(unknown()); }, 45_000);
      })]);
    } catch {
      command.fail(); return unknown();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async steer(input: RuntimeTurnInput): Promise<RuntimeSteerResult> {
    input.assertCurrent?.();
    if (input.nativeAction) return { status: "not_steerable", reason: "Native actions require a supported scheduler-owned turn" };
    if (this.liveControlActive || this.controls.uncertain) throw new Error("Claude native control is active or uncertain");
    if (input.model && input.model !== this.selectedModel) throw new Error("Change model at a turn boundary");
    if (input.effort && input.effort !== this.opts.effort) throw new Error("Claude effort change requires reopening the retained session");
    if (this.closed || this.historyActive || this.fileHistory.uncertain || this.nativeCommand || !this.active) return { status: "not_active" };
    const turnId = input.clientMessageId ?? randomUUID();
    const frame = this.inputFrame(input.prompt, turnId, input.inputFiles);
    input.assertCurrent?.();
    this.contextObservations.submit(turnId);
    await this.writeInputFrame(frame);
    return { status: "accepted", turnId };
  }

  async listNativeTasks() {
    if (this.closed || !this.active || !this.taskLifetime.ownsRun) throw new Error("No live native task Run");
    return this.taskLifetime.inventory();
  }

  async stopNativeTask(taskKey: string) {
    if (this.closed || !this.active || !this.taskLifetime.ownsRun) throw new Error("No live native task Run");
    const task = this.taskLifetime.requireTask(taskKey);
    return this.taskStop.stop(task.taskId, frame => this.writeFrame(frame));
  }

  async interrupt(): Promise<void> {
    this.cancelApprovals();
    if (this.nativeCommand?.succeeded) this.nativeCommand = undefined;
    else this.nativeCommand?.fail();
    if (this.closed) return;
    // Acknowledgement is not observed process drain; authoritative Stop still closes.
    await this.controls.request({ subtype: "interrupt" });
  }

  private async setLiveModel(model: string): Promise<void> {
    if (!model.trim() || model.length > 200 || /[\u0000-\u001f]/u.test(model)) throw new Error("Invalid Claude model");
    if (this.active || this.liveControlActive || this.closed || this.nativeCommand && !this.nativeCommand.succeeded) throw new Error("Change model at an idle boundary");
    this.liveControlActive = true;
    try {
      await this.controls.request({ subtype: "set_model", model });
      this.selectedModel = model;
      this.usageInvalidated = true;
      this.nativeUsage = undefined;
      // Require a fresh provider init before compaction; do not fabricate model evidence.
      this.sessionInitialization = undefined;
      if (this.capabilitiesSnapshot) this.capabilitiesSnapshot = { ...this.capabilitiesSnapshot, selectedModel: model, model: undefined };
      this.opts.onCapabilitiesChanged?.();
    } finally { this.liveControlActive = false; }
  }

  private cancelApprovals(): void {
    for (const controller of this.approvals.values()) controller.abort();
    this.approvals.clear();
  }

  private handleNativeRequest(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const frame = raw as {type?: unknown; request_id?: unknown; session_id?: unknown; request?: Record<string, unknown>};
    if (frame.type === "control_cancel_request" && typeof frame.request_id === "string") {
      this.approvals.get(frame.request_id)?.abort(); return true;
    }
    if (frame.type !== "control_request") return false;
    if (typeof frame.request_id !== "string" || !frame.request_id || frame.request_id.length > 200) return true;
    const requestId = frame.request_id, request = frame.request;
    if (this.seenApprovalIds.has(requestId)) return true;
    if (this.seenApprovalIds.size >= 10_000 || this.approvals.size >= 32) {
      void this.close().catch(() => undefined); return true;
    }
    this.seenApprovalIds.add(requestId);
    const controller = new AbortController();
    this.approvals.set(requestId, controller);
    const turnId = this.activeInputId;
    void (async () => {
      let allowed = false;
      let updatedInput = request?.input;
      try {
        if (request?.subtype === "can_use_tool" && typeof request.tool_name === "string" &&
            request.input && typeof request.input === "object" &&
            !Array.isArray(request.input) && this.active && turnId && !this.nativeCommand &&
            (frame.session_id === undefined || frame.session_id === this.engineAgentId)) {
          const callbackOptions = { ...this.opts, signal: AbortSignal.any([this.opts.signal, controller.signal]) };
          const identity = { requestId, sessionId: this.engineAgentId, turnId, kind: "tool" as const };
          if (request.tool_name === "AskUserQuestion") {
            updatedInput = await answerClaudeNativeQuestions(callbackOptions, { ...identity, kind: "question" }, request.input);
            allowed = updatedInput !== undefined;
          } else allowed = await requestNativeApproval(callbackOptions, identity, request);
        }
        if (controller.signal.aborted || this.closed) return;
        if (request?.subtype !== "can_use_tool") {
          await this.writeFrame({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "Unsupported native callback" } });
          return;
        }
        allowed = allowed && this.active && this.activeInputId === turnId && !this.nativeCommand;
        await this.writeFrame({ type: "control_response", response: { subtype: "success", request_id: requestId,
          response: allowed ? { behavior: "allow", updatedInput }
            : { behavior: "deny", message: "Human approval absent, refused, restricted or expired" } } });
      } catch { void this.close().catch(() => undefined); }
      finally { this.approvals.delete(requestId); }
    })();
    return true;
  }

  isAlive(): boolean {
    return this.nativeAuthority?.isAlive() ?? processGroupAlive(this.child);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.fileHistory.close();
    this.controls.close();
    this.cancelApprovals();
    this.taskStop.close();
    this.nativeCommand?.fail();
    this.initializationReady();
    this.child.stdin?.end();
    const attempt = terminateProcessGroup(this.child, {
      label: "Claude runtime",
      termGraceMs: this.opts.killGraceMs,
    }, this.nativeAuthority);
    const shared = attempt.catch((error) => {
      if (this.closePromise === shared) this.closePromise = undefined;
      throw error;
    });
    this.closePromise = shared;
    return shared;
  }

  private inputFrame(prompt: string, id: string, inputFiles?: RuntimeTurnInput["inputFiles"]) {
    return {
      type: "user",
      uuid: id,
      session_id: this.engineAgentId,
      message: { role: "user", content: claudeTurnContent({ prompt, kind: "user_message", inputFiles }) },
    };
  }

  private writeInput(prompt: string, id: string, inputFiles?: RuntimeTurnInput["inputFiles"]): Promise<void> {
    return this.writeInputFrame(this.inputFrame(prompt, id, inputFiles));
  }

  private async writeInputFrame(frame: ReturnType<ClaudeStreamSession["inputFrame"]>): Promise<void> {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) throw new Error("Claude runtime is unavailable");
    const media = frame.message.content.some(block => block.type === "image" || block.type === "document");
    if (media) this.mediaReplayFraming().expect(frame.uuid, frame.message, Buffer.byteLength(JSON.stringify(frame), "utf8"));
    try { await this.writeFrame(frame); }
    catch (error) { this.replayFraming?.forget(frame.uuid); throw error; }
  }

  private mediaReplayFraming(): ClaudeReplayFraming {
    return this.replayFraming ??= new ClaudeReplayFraming(this.engineAgentId);
  }

  private async writeFrame(frame: unknown): Promise<void> {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) throw new Error("Claude runtime is unavailable");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin!.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  private async *eventStream(): AsyncIterable<AgentEvent> {
    const stdout = this.child.stdout;
    if (!stdout) {
      yield { type: "error", message: "Claude runtime stdout is unavailable" };
      return;
    }
    const map = claudeStreamEventMapper();
    try {
      for await (const raw of this.mediaReplayFraming().parse(stdout as AsyncIterable<Buffer>)) {
        if (this.taskStop.observe(raw)) continue;
        if (this.fileHistory.observe(raw)) continue;
        if (this.controls.observe(raw)) continue;
        const stopHook = this.taskLifetime.stopHook(raw);
        if (stopHook) {
          for (const event of stopHook.events) yield event;
          await this.writeFrame({ type: "control_response", response: {
            subtype: "success", request_id: stopHook.requestId, response: {},
          } });
          continue;
        }
        if (this.handleNativeRequest(raw)) continue;
        this.captureModelInitialization(raw);
        const capabilities = normalizeClaudeInitCapabilities(raw, this.selectedModel);
        if (capabilities && capabilities.sessionId !== this.engineAgentId) throw new Error("Claude session changed");
        if (capabilities?.sessionId === this.engineAgentId) this.sessionInitialization = raw;
        if (capabilities) {
          this.claudeCodeVersion = raw && typeof raw === "object" &&
            typeof (raw as { claude_code_version?: unknown }).claude_code_version === "string"
            ? (raw as { claude_code_version: string }).claude_code_version
            : this.claudeCodeVersion;
          this.capabilitiesSnapshot = {
            ...capabilities,
            ...(this.liveModelCatalog() ? { modelCatalog: this.liveModelCatalog() } : {}),
          };
          this.opts.onCapabilitiesChanged?.();
        }
        if (this.nativeCommand) {
          this.nativeCommand.observe(raw);
          if (capabilities) map(raw, { cwd: this.opts.cwd });
          // Native command output is not ordinary Agent work or publication.
          continue;
        }
        const observation = this.contextObservations.observe(raw);
        if (observation) { this.usageInvalidated = false; yield observation; }
        const lifetimeEvents = this.taskLifetime.observe(raw);
        const projected = map(raw, { cwd: this.opts.cwd }).flatMap(event => this.taskLifetime.project(event, raw));
        for (const event of [...lifetimeEvents, ...projected]) {
          if(event.type==='error')this.terminalEvent=event;
          if (event.type === "turn_done" || event.type === "error") {
            this.active = false;
            this.activeInputId = undefined;
            this.cancelApprovals();
            this.contextObservations.endTurn();
          }
          if (event.type === "error" && (event.code === "quota_exhausted" || this.taskLifetime.ownsRun)) {
            // A terminal failure cannot leave accepted native work running
            // after its managed Run loses authority. Quota failures likewise
            // drain the provider's own retry watchdog before host recovery.
            const closing=this.close();
            // The caller may stop advancing this iterator at the error. Begin
            // owned teardown, deliver the cause now, and let close() remain the
            // shared observed-termination promise used by the runtime owner.
            void closing.catch(()=>undefined);
            yield event;
            await closing;
            return;
          }
          yield event;
        }
      }
    } catch (error) {
      if (!(error instanceof JsonlRecordLimitError)) throw error;
      this.active = false;
      yield {
        type: "error",
        message: `Claude stream JSONL record exceeded the ${JSONL_MAX_RECORD_BYTES / (1024 * 1024)} MiB limit`,
      };
      await this.close();
      return;
    } finally {
      // Parser completion, not the stream close event, proves buffered JSONL
      // was consumed. The root timer remains the bounded fallback.
      this.taskStop.close();
      this.reportDrainedRootExit?.();
    }
    if (!this.closed) {
      yield { type: "error", message: `Claude stream stopped${this.stderrTail.text().trim() ? `: ${this.stderrTail.text().trim()}` : ""}` };
    }
  }

  private captureModelInitialization(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const envelope = raw as {
      type?: unknown;
      response?: {
        subtype?: unknown;
        request_id?: unknown;
        response?: { models?: unknown; commands?: unknown };
      };
    };
    if (envelope.type !== "control_response" ||
        envelope.response?.subtype !== "success" ||
        envelope.response.request_id !== this.modelInitializationRequestId) return;
    this.initialized = true;
    const commands = envelope.response.response?.commands;
    this.nativeCompactAdvertised = Array.isArray(commands) && commands.some(command =>
      command !== null && typeof command === "object" && (command as {name?:unknown}).name === "compact");
    this.initializationReady();
    try {
      this.providerModels = normalizeClaudeProviderModels(envelope.response.response?.models);
    } catch {
      // Catalog capture is best-effort on the live Run path. Discovery has its
      // own strict probe and must not turn a provider shape change into a Run
      // failure.
      return;
    }
    const modelCatalog = this.liveModelCatalog();
    if (this.capabilitiesSnapshot && modelCatalog) {
      this.capabilitiesSnapshot = { ...this.capabilitiesSnapshot, modelCatalog };
    }
    this.opts.onCapabilitiesChanged?.();
  }

  private liveModelCatalog() {
    if (!this.providerModels || !this.claudeCodeVersion) return undefined;
    return {
      models: this.providerModels,
      cliVersion: this.claudeCodeVersion,
      configurationKey: "live-session",
    };
  }
}
