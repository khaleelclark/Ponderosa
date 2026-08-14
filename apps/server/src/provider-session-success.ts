import type { RuntimeSession, RuntimeSteerResult, RuntimeTurnInput } from "@ponderosa/core";
import {
  projectProviderContextUsage,
  projectProviderSessionIdentifier,
  projectProviderSteerResult,
  type ProjectedProviderContextUsage,
} from "./provider-success-projection.js";

function descriptorValue(value: unknown, property: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new Error("Provider returned invalid structured data.");
  }
  try {
    let cursor: object | null = value as object;
    for (let depth = 0; cursor && depth < 8; depth += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(cursor, property);
      if (descriptor) {
        if (!("value" in descriptor)) throw new Error("Provider returned invalid structured data.");
        return descriptor.value;
      }
      cursor = Reflect.getPrototypeOf(cursor);
    }
  } catch {
    throw new Error("Provider returned invalid structured data.");
  }
  return undefined;
}

/** Invoke steering through a data-method descriptor and project its acknowledgement. */
export async function invokeProviderSteer(
  session: RuntimeSession,
  input: RuntimeTurnInput,
): Promise<RuntimeSteerResult> {
  const method = descriptorValue(session, "steer");
  if (typeof method !== "function") throw new Error("Provider returned invalid structured data.");
  let result: unknown;
  try {
    result = await Reflect.apply(method, session, [input]);
  } catch {
    throw new Error("Provider steering failed.");
  }
  return projectProviderSteerResult(result);
}

/** Read a provider session identifier without invoking accessors or proxy getters. */
export function readProviderSessionIdentifier(session: RuntimeSession): string {
  return projectProviderSessionIdentifier(descriptorValue(session, "engineAgentId"));
}

/** Invoke and project contextUsage without trusting accessors or returned objects. */
export function readProviderContextUsage(
  session: RuntimeSession | undefined,
): ProjectedProviderContextUsage | undefined {
  if (!session) return undefined;
  const method = descriptorValue(session, "contextUsage");
  if (method === undefined) return undefined;
  if (typeof method !== "function") throw new Error("Provider returned invalid structured data.");
  let value: unknown;
  try {
    value = Reflect.apply(method, session, []);
  } catch {
    throw new Error("Provider returned invalid structured data.");
  }
  return projectProviderContextUsage(value);
}
