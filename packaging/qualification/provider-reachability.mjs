const MAX_EVIDENCE_AGE_MS = 5 * 60_000;

function failureCategory(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError"
    ? "timeout"
    : "connection_failure";
}

function sanitizedCategory(value) {
  return typeof value === "string" && /^[a-z_]{1,48}$/u.test(value)
    ? value
    : "unverified";
}

function httpFailureCategory(status) {
  if (status === 401) return "authentication";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_failure";
  return "invalid_response";
}

export function isFreshProviderEvidence(engine, expectedRevision, nowMs = Date.now()) {
  const observedMs = Date.parse(engine?.availabilityObservedAt ?? "");
  return typeof expectedRevision === "string" && expectedRevision.length > 0 &&
    engine?.servingBuildRevision === expectedRevision &&
    engine?.availabilityBuildRevision === expectedRevision &&
    typeof engine?.servingInstanceId === "string" && engine.servingInstanceId.length > 0 &&
    engine?.availabilityInstanceId === engine.servingInstanceId &&
    engine?.authentication === "authenticated" &&
    engine?.enabled !== false &&
    engine?.intakeReady === true &&
    engine?.reachability === "reachable" &&
    ["operator_probe", "provider_run"].includes(engine?.availabilitySource) &&
    Number.isFinite(observedMs) &&
    observedMs >= nowMs - MAX_EVIDENCE_AGE_MS &&
    observedMs <= nowMs + 30_000;
}

/** An explicit, bounded, tool-free recheck where the provider supplies one.
 * A provider without a recheck can qualify only with recent successful Run
 * evidence. Login and scheduler intake alone never establish reachability. */
export async function qualifyProviderReachability({ baseUrl, cookie, expectedRevision, fetchImpl = fetch, now = Date.now }) {
  let engines;
  try {
    const response = await fetchImpl(`${baseUrl}/api/engines`, {
      headers: { cookie },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        passed: false,
        evidence: [],
        discoveryFailureCategory: httpFailureCategory(response.status),
      };
    }
    engines = await response.json();
    if (!Array.isArray(engines)) throw new Error("invalid engine discovery response");
  } catch (error) {
    return { passed: false, evidence: [], discoveryFailureCategory: failureCategory(error) };
  }

  const evidence = await Promise.all(engines.map(async (engine) => {
    const kind = typeof engine?.id === "string" ? engine.id : "unknown";
    let current = engine;
    let probeFailureCategory;
    if (engine?.authentication === "authenticated" && engine?.enabled !== false &&
        typeof engine.id === "string") {
      try {
        const response = await fetchImpl(
          `${baseUrl}/api/engines/${encodeURIComponent(engine.id)}/recheck`,
          { method: "POST", headers: { cookie }, signal: AbortSignal.timeout(75_000) },
        );
        if (!response.ok) probeFailureCategory = httpFailureCategory(response.status);
        else current = await response.json();
      } catch (error) {
        probeFailureCategory = failureCategory(error);
      }
    }
    const checkedAt = new Date(now()).toISOString();
    const reachable = !probeFailureCategory && isFreshProviderEvidence(current, expectedRevision, now());
    return {
      providerKind: kind,
      checkedAt,
      reachability: probeFailureCategory ? "unverified" : current?.reachability ?? "unverified",
      observedAt: current?.availabilityObservedAt ?? null,
      source: current?.availabilitySource ?? null,
      buildRevision: current?.availabilityBuildRevision ?? null,
      instanceId: current?.availabilityInstanceId ?? null,
      servingBuildRevision: current?.servingBuildRevision ?? null,
      servingInstanceId: current?.servingInstanceId ?? null,
      failureCategory: reachable ? null : probeFailureCategory ??
        sanitizedCategory(current?.availabilityCategory),
      qualified: reachable,
    };
  }));
  return { passed: evidence.some((entry) => entry.qualified), evidence };
}
