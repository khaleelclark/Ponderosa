# Synchronous communication reconciliation metadata reads

Base: `fbfdcb6f60c811ab076cb8709825f5951d2c8bcc`. Branch: `codex/reconcile-chat-reads-20261106`.

The controlled 10k-history/20-worker diagnostic at `/tmp/p2qcpu-c974pu5w` recorded three 3.1–3.3 second event-loop pauses during 14 real canonical queued admissions. About 9.27 seconds of the 12.6 second Node profile had the product reconciliation timer on its ancestor stack: roughly 6.14 seconds in projection authorization and 3.07 seconds in canonical-event Chat checks. These repeatedly loaded the same Chat metadata. This is sampled stack attribution, not host CPU utilization. The later first queue GET took 39.9 ms end to end and 9.2 ms from actual HTTP arrival to finish; its earlier 3.2 second wait did not recur at that exact phase.

The fix shares the existing authoritative Chat lookup only within one synchronous reconciliation pass, including missing results. Canonical filtering and existing projection authorization use that reader; all independent calls retain the original live reader. Every event, projection, report check, Agent/recipient rule and timer remains in place. The local map cannot survive an await or later call.

Focused validation:

- Owned agents build/assets and server build passed (TypeScript checked).
- Two real AgentStore regressions passed: 32 to 416 canonical rows require one catalog read per distinct Chat; reopening existing data preserves the report; later deletion fences, missing-room rechecks and independent projections remain current. Private recipient/foreign-room rules and later Agent removal retain their existing behavior.
- One existing passive canonical Collaboration/report regression passed, with zero failures or skips.
- Logs: `/tmp/p2reconcile-rtv16vms`. The first privacy fixture omitted its required audience userId and was rejected before append; corrected fixture logs and the original failure are retained. The final deletion oracle captures the actual communicationEventId and proves its projection exists before fencing, then disappears.

Diagnostic writes used normal Fastify/canonical admission via app.inject; measured GET used actual HTTP. Native inspector, observer and concurrent Team Chat capture overhead are recorded, so these timings are diagnostic only. The diagnostic canceled all 30 exact requests, closed its listener/browser/inspector and observed all 21 known PIDs/groups absent (`drain.json`). No production or retained database was opened. No new LCP or full-load qualification pass is claimed; the separate generic queue lookup candidate is not part of this change.
