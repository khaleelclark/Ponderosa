import type { RuntimeSession, RuntimeSteerResult, RuntimeTurnInput } from "@ponderosa/core";
import { isProxy } from "node:util/types";
import { isProviderRuntimeBoundaryError } from "./provider-session-facade.js";
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
      if (isProxy(cursor)) throw new Error("Provider returned invalid structured data.");
      const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
      if (descriptor) {
        if (!("value" in descriptor)) throw new Error("Provider returned invalid structured data.");
        return descriptor.value;
      }
      cursor = Object.getPrototypeOf(cursor);
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
  } catch (error) {
    if (isProviderRuntimeBoundaryError(error)) throw error;
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
  } catch (error) {
    if (isProviderRuntimeBoundaryError(error)) throw error;
    throw new Error("Provider returned invalid structured data.");
  }
  return projectProviderContextUsage(value);
}
