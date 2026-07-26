import type { CoordinationJoinWakePolicy } from "@ponderosa/core";

function inspectorJson(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let rendered: string;
  try {
    rendered = JSON.stringify(JSON.parse(value));
  } catch {
    rendered = value;
  }
  return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}… (truncated in inspector)` : rendered;
}

function inspectorDetails(...values: Array<[string, unknown]>): Array<{ label: string; value: string }> {
  return values.flatMap(([label, value]) => value === undefined || value === null || value === ""
    ? []
    : [{ label, value: typeof value === "string" ? value : JSON.stringify(value) }]);
}

function inspectorWakePolicy(value: CoordinationJoinWakePolicy): string {
  return value === "each_result" ? "Each result" : "Final only";
}

export { inspectorDetails, inspectorJson, inspectorWakePolicy };
