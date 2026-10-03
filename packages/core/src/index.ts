// @ponderosa/core — the shared contracts imported by BOTH apps/web and apps/server
// (AGENTS.md: don't duplicate these per app). This barrel is intentionally pure and
// JSON-serializable: it re-exports only types/DTOs. The Node-only config and logger
// are separate subpath entry points (`@ponderosa/core/config`, `.../logger`) so the
// browser bundle never pulls in node built-ins.

export * from "./events.js";
export * from "./adapter.js";
export * from "./dto.js";
export * from "./sse.js";
export * from "./communication.js";
export * from "./managed-tools.js";
export * from "./text-policy.js";
export * from "./coordination-v3.js";
export * from "./file-activity.js";
export * from "./provider-failure-summary.js";
export * from "./agent-handles.js";
export * from "./provider-connection-url.js";
export * from "./tool-failure.js";
export * from "./outcome-cause.js";
export * from "./markdown-preview.js";
export * from "./dto/local-browser.js";
export * from "./collaboration-presentation.js";
