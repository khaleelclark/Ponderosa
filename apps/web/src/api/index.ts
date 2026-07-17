import { mockApi } from "./mock";
import { realApi } from "./real";
import type { PonderosaApi } from "./types";

function getApiMode(): "mock" | "real" {
  // Rsbuild only replaces statically-addressed import.meta.env fields. Keeping
  // this access explicit prevents mock development builds from silently
  // falling through to the real API client.
  const mode = import.meta.env.PUBLIC_PONDEROSA_API_MODE;
  return mode === "mock" ? "mock" : "real";
}

const mode = getApiMode();

export const api: PonderosaApi = mode === "mock" ? mockApi : realApi;
