import { describe, expect, it } from "vitest";
import { contextRolloverHandoffValidationError } from "./routes/provider-run-executor.js";

const PRODUCTION_HANDOFF = `
Objective: Implement a contained fix for false context-rollover failures and misleading duplicate coordination notifications, while leaving draft PR #399 unchanged.

Completed work: Diagnosed rollover 454f4886-d462-42ed-a13d-9180d5125e9b and Run b96d1028-0668-4a3e-bf07-6d4b32b62f43 using canonical SQLite and event records. The emitted handoff had 253 words, all seven required labels, an absolute worktree path, GitHub URLs, PR references, and commit SHAs. It failed solely because the existing validator requires a literal reference noun even when the handoff contains concrete identifiers. The duplicate attention notification was traced separately to the operational coordination reconciler.

Unfinished work: No implementation, branch, worktree, commit, push, or GitHub PR exists for this correction. The proposed fix should recognize actual identifiers, report precise validation failures, suppress generic coordination notifications for rollover activations, correctly target the dedicated notification, and reconcile stale duplicates.

Blockers: Independent review will be required before readiness or merge. No product decision is required for the contained correction.

Exact next action: Work in /home/phoenix/ponderosa/worktrees/context-rollover-notifications, implement focused regressions using this production handoff, run focused tests and pnpm verify, commit coherent slices, push, and open a draft PR.

Verified facts: Reference identifiers include PR #399, branch fix/mobile-agent-lifecycle-performance, head 525ae2d273bbf40f7e04194cf81b7bcd512ecefa, and https://github.com/khaleelclark/Ponderosa/pull/399. The existing worktrees were clean. No code or GitHub state changed during diagnosis.

Assumptions: PR #399 remains draft and unchanged, Patrick has not authorized merging it, and no other Agent owns the proposed rollover-fix branch.
`;

describe("context rollover handoff validation", () => {
  it("accepts the production handoff with concrete identifiers", () => {
    expect(contextRolloverHandoffValidationError(PRODUCTION_HANDOFF))
      .toBeUndefined();
  });

  it("reports the missing contract element precisely", () => {
    const withoutReference = PRODUCTION_HANDOFF
      .replaceAll(/https?:\/\/\S+/gu, "the repository")
      .replaceAll(/\/?home\/phoenix\/\S+/gu, "the working directory")
      .replaceAll(/\b(?:PR\s*)?#?\d+\b/giu, "the pull request")
      .replaceAll(/\b[0-9a-f]{7,40}\b/giu, "the revision")
      .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "the record");
    expect(contextRolloverHandoffValidationError(withoutReference))
      .toContain("concrete file, path, artifact, PR, URL, commit, or reference identifier");
  });

  it("reports missing section labels instead of a provider-ended fallback", () => {
    expect(contextRolloverHandoffValidationError(
      PRODUCTION_HANDOFF.replace("Assumptions:", "Notes:"),
    )).toContain("assumptions:");
  });
});
