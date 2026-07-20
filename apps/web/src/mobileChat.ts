export function mobileOperationalStatus(state: string): string {
  if (["completed", "satisfied", "applied", "processed", "delivered", "recovered"].includes(state)) return "✅ Processed";
  if (["leased", "running", "activated", "recovering"].includes(state)) return "🔄 Active";
  if (["open", "pending", "queued", "waiting"].includes(state)) return "⏳ Waiting";
  if (["failed", "blocked", "cancelled", "expired", "outcome_unknown"].includes(state)) return "⚠️ Needs attention";
  return `• ${state.replaceAll("_", " ")}`;
}

/** Keep desktop composers stable while reclaiming scarce phone viewport space. */
export function shouldHideMobileComposer(mobileViewport: boolean, nearBottom: boolean): boolean {
  return mobileViewport && !nearBottom;
}
