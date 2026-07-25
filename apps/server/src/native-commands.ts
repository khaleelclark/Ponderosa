import type {
  EngineCommand,
  RuntimeCommandResult,
  RuntimeSession,
  TokenUsageMetric,
  TokenUsageSummaryDto,
} from "@ponderosa/core";

export const NATIVE_COMMANDS: EngineCommand[] = [
  {
    name: "status",
    description: "Show provider session, model, context, and available rate-limit status",
    source: "ponderosa",
    acceptsArguments: false,
    insertText: "/status",
    status: "available",
    invocation: "runtime",
  },
  {
    name: "usage",
    description: "Show token usage recorded by Ponderosa",
    source: "ponderosa",
    acceptsArguments: false,
    insertText: "/usage",
    status: "available",
    invocation: "runtime",
  },
  {
    name: "context",
    description: "Show current provider-session context occupancy",
    source: "ponderosa",
    acceptsArguments: false,
    insertText: "/context",
    status: "available",
    invocation: "runtime",
  },
];

const NATIVE_COMMAND_NAMES = new Set(NATIVE_COMMANDS.map((command) => command.name));

export function isNativeCommand(name: string): boolean {
  return NATIVE_COMMAND_NAMES.has(name);
}

/** Native descriptors lead the list, while an exact provider-advertised name
 * remains authoritative if a provider ever supplies one. */
export function mergeNativeCommands(providerCommands: EngineCommand[]): EngineCommand[] {
  const providerNames = new Set(providerCommands.map((command) => command.name));
  return [
    ...NATIVE_COMMANDS.filter((command) => !providerNames.has(command.name)),
    ...providerCommands,
  ];
}

export interface NativeCommandContext {
  providerName: string;
  session: RuntimeSession;
  model?: string;
  usage: TokenUsageSummaryDto;
  usageSubject: string;
}

function formatContextUsage(
  usage: ReturnType<NonNullable<RuntimeSession["contextUsage"]>>,
): string {
  if (!usage) return "Context: occupancy is not available from this provider session.";
  if (usage.windowTokens === undefined) {
    return `Context: ${usage.usedTokens.toLocaleString()} tokens used; provider window size not reported.`;
  }
  const percentage = Math.min(100, (usage.usedTokens / usage.windowTokens) * 100);
  return `Context: ${usage.usedTokens.toLocaleString()} / ${usage.windowTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%).`;
}

const USAGE_METRICS: Array<[TokenUsageMetric, string]> = [
  ["inputTokens", "Input tokens"],
  ["cachedInputTokens", "Cached input tokens"],
  ["cacheWriteInputTokens", "Cache-write input tokens"],
  ["outputTokens", "Output tokens"],
  ["reasoningOutputTokens", "Reasoning output tokens"],
  ["totalTokens", "Total tokens"],
];

function formatRecordedUsage(
  usage: TokenUsageSummaryDto,
  subject: string,
): string {
  const lines = [
    `Ponderosa recorded usage for ${subject}`,
    `Finalized Runs: ${usage.finalizedRuns.toLocaleString()} · reported: ${usage.reportedRuns.toLocaleString()} · unreported: ${usage.unreportedRuns.toLocaleString()}`,
  ];
  for (const [metric, label] of USAGE_METRICS) {
    if (usage.metricAvailability[metric] !== "available") continue;
    const value = usage[metric];
    if (value !== undefined) lines.push(`${label}: ${value.toLocaleString()}`);
  }
  lines.push("These are provider-reported tokens recorded by Ponderosa, not subscription quota.");
  return lines.join("\n");
}

export async function invokeNativeCommand(
  name: string,
  ctx: NativeCommandContext,
  argumentsText?: string,
): Promise<RuntimeCommandResult> {
  if (!isNativeCommand(name)) throw new Error(`unsupported Ponderosa command: /${name}`);
  if (argumentsText?.trim()) throw new Error(`/${name} does not accept arguments`);
  if (name === "usage") {
    return { message: formatRecordedUsage(ctx.usage, ctx.usageSubject) };
  }

  const contextLine = formatContextUsage(ctx.session.contextUsage?.());
  if (name === "context") {
    return {
      message: `${contextLine}\nThis counts everything occupying the provider's context window, including cached content.`,
    };
  }

  const rateLimits = ctx.session.rateLimitStatus
    ? await ctx.session.rateLimitStatus()
    : [];
  return {
    message: [
      `Provider: ${ctx.providerName}`,
      `Session: ${ctx.session.engineAgentId}`,
      `Model: ${ctx.model || "provider default"}`,
      contextLine,
      ...rateLimits.map((line) => `Rate limit: ${line}`),
    ].join("\n"),
  };
}
