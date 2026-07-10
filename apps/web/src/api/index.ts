import { mockApi } from "./mock";
import { realApi } from "./real";
import type { PonderosaApi } from "./types";

function getApiMode(): "mock" | "real" {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const mode = env?.PUBLIC_PONDEROSA_API_MODE ?? env?.VITE_PONDEROSA_API_MODE;
  return mode === "mock" ? "mock" : "real";
}

const mode = getApiMode();

export const api: PonderosaApi = mode === "mock" ? mockApi : realApi;
