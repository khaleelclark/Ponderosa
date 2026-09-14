import { readFileSync } from "node:fs";

export function validProcessId(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

export function processIsAlive(pid, probe = value => process.kill(value, 0)) {
  // PID 0 addresses our own process group; it is never a published daemon PID.
  if (!validProcessId(pid)) return false;
  try { probe(pid); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

export async function readPublishedProcessState(pathname, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(pathname, "utf8"));
      if (validProcessId(state?.pid)) return state;
    } catch { /* A launch may be publishing its state atomically. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  // Do not include raw state or JSON parse errors: state can contain control tokens.
  throw new Error(`Timed out waiting for a published process identity at ${pathname}`);
}
