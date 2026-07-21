# Token-efficient organizations

Ponderosa should preserve the useful part of an organization—durable specialist identity, direct communication, and reusable domain knowledge—without paying for organizational structure on every turn.

## Measurement contract

Optimization starts with provider-measured usage, not estimates derived from visible text:

- Store input, cached-input, cache-write, output, reasoning, and total tokens independently when the provider exposes them.
- Store the engine, requested model, and effort on every run so usage remains attributable after agent settings change.
- Prefer absolute provider thread totals and derive a run delta from the prior absolute checkpoint. If a resumed Codex thread does not replay that baseline, derive the Run aggregate only from complete, deduplicated per-request checkpoints that reconcile exactly. Never add reconciled request snapshots to an available absolute thread total.
- Mark unreported Runs and unavailable token classes explicitly. Never silently treat missing telemetry as zero usage.
- Preserve independent overall, Project, Agent, provider, model, and Chat attribution so controlled experiments can compare like with like.
- Report provider-request counts, aggregate Run duration, wake causes, and cache use alongside token totals. A high token total alone does not prove repeated work or inefficiency.

Ponderosa does not estimate monetary cost. Provider list prices, subscription
plans, discounts, tool fees, and infrastructure costs change independently, so a
derived dollar figure creates maintenance work and can be mistaken for a bill.
Operators can export the retained scoped telemetry and apply the pricing model
appropriate to a specific experiment when a cost comparison is needed.

## Safe savings implemented now

A retained provider session already contains its organization envelope. Ponderosa therefore omits the full team directory and managed-agent creation instructions while the stable roster, roles, and reporting graph remain unchanged. New, restarted, evicted, rolled-over, or organization-changed sessions receive the complete envelope. Continuation turns still receive authoritative runtime identity, current manager relationship, a pointer to the live directory, new room context, the current request, and the required communication contract.

This reduces repeated input as the organization grows without changing delivery behavior or relying on rendered text heuristics.

## Durable coordination and waiting

An agent identity should be durable, while a provider turn is temporary and an OS process is an evictable cache:

`runnable -> running -> waiting(condition) -> runnable -> running -> idle`

Communication V3 represents waiting with immutable correlated Requests and a
durable Join supporting:

- all expected reports;
- any response;
- quorum (`n` of `m`);
- deadline;
- immediate user or blocker override; and
- informational delivery without waking.

Creating coordination atomically records each stable recipient Request and an
optional `all`, `any`, or `quorum` Join. Request and Join deadlines are
independent. Recipient terminal updates are canonical handoffs. Common fan-out
uses `each_result`, which wakes the manager once for each newly available result
while preserving the open parent workflow; `final_only` is available when one
terminal synthesis is preferable. Human and urgent Activations do not cancel
open Joins. Explicit queued human turns remain FIFO one-per-Run boundaries,
while passive progress and duplicate audit copies do not wake a provider.

This lets a manager pipeline review or follow-up as workers finish without
losing the aggregate completion condition. SQLite owns the restart-safe
Request, Join, Activation, Run, lease, fence, and injection state; exact
provider input and structural wake cause remain inspectable from the Run.

## Further strategies

Implemented foundations now include exact provider-input manifests and
Project-owned stable artifacts with targeted retrieval. Further strategies are:

1. Make direct delivery to the actual consumer the default; managers synthesize and decide rather than relay routine messages.
2. Route bounded, verifiable work to cheaper models, with explicit escalation criteria and a capable model retaining outcome ownership.
3. Add explicit experiment budgets only where a durable unit has a clear owner and boundary; do not infer control from ambiguous token estimates.
4. Benchmark organizations by quality, scoped provider telemetry, and latency across multiple tasks, not by one raw token total.

Avoid heuristic wake suppression, text-inferred scope, mutable shared blackboards, auctions, or secretly replacing an organization with one agent. Those approaches sacrifice auditability or the organizational capability being measured.
