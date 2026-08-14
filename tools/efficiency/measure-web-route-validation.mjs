export function validateOfflineSnapshot({
  expectedUrl,
  expectedRouteKind,
  snapshot,
  timedOut,
}) {
  const expected = new URL(expectedUrl);
  const failures = [];
  if (timedOut) failures.push("route readiness timed out");
  if (!snapshot.controlled) failures.push("service worker does not control the offline page");
  if (snapshot.pathname !== expected.pathname) {
    failures.push(`pathname ${JSON.stringify(snapshot.pathname)} does not match ${JSON.stringify(expected.pathname)}`);
  }
  if (snapshot.routeKind !== expectedRouteKind) {
    failures.push(`route marker ${JSON.stringify(snapshot.routeKind)} does not match ${JSON.stringify(expectedRouteKind)}`);
  }
  let markerPathname;
  try {
    markerPathname = snapshot.routePath
      ? new URL(snapshot.routePath, expected.origin).pathname
      : undefined;
  } catch {
    markerPathname = undefined;
  }
  if (markerPathname !== expected.pathname) {
    failures.push(`route-path marker ${JSON.stringify(snapshot.routePath)} does not resolve to ${JSON.stringify(expected.pathname)}`);
  }
  if (snapshot.errorBoundary) failures.push("workspace error boundary is rendered");
  if (snapshot.routeChunkError) failures.push("route chunk error recovery is rendered");
  if (!snapshot.routeContentPresent) failures.push("route content marker is absent");
  if (!snapshot.routeText?.trim()) failures.push("marked route content is blank");
  if (failures.length) {
    throw new Error(`offline route qualification failed: ${failures.join("; ")}`);
  }
}
