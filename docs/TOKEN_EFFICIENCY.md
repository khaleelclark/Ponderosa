# Token-efficient organizations

Ponderosa should preserve the useful part of an organization—durable specialist identity, direct communication, and reusable domain knowledge—without paying for organizational structure on every turn.

## Measurement contract

Optimization starts with provider-measured usage, not estimates derived from visible text:

- Store input, cached-input, cache-write, output, reasoning, and total tokens independently when the provider exposes them.
- Store the engine, requested model, and effort on every run so usage remains attributable after agent settings change.
- Prefer absolute provider thread totals and derive a run delta from the prior absolute checkpoint. If a resumed Codex thread does not replay that baseline, derive the Run aggregate only from complete, deduplicated per-request checkpoints that reconcile exactly. Preserve those snapshots as pricing detail, but never add them to an available absolute thread total.
- Mark unreported runs and unknown price profiles explicitly. Never silently price unknown usage at zero.
- Display cost only as a dated, projected API-equivalent list-price estimate. Subscription usage, provider discounts, tool fees, and infrastructure cost are different things.

Cost is the primary user-facing efficiency metric. Raw total-token volume is
diagnostic evidence, not the headline, because different models and token classes
have materially different prices. Ponderosa prices each finalized run using the
model recorded on that run, normalizing provider input into four mutually
exclusive billable classes:

- uncached input = total input minus cached reads minus cache writes;
- cached input reads;
- cache-write input; and
- output (including any reasoning tokens already counted by the provider as output).

Costs are summed by token class and by pricing model before agent, project, or
overall totals are displayed. Price tiers defined by provider-request context
size are applied to each reconciled provider request, not to a run aggregate.
When an aggregate could cross a request-level tier but its request detail is
unavailable, exclude it from projected cost instead of guessing. Never apply one
blended rate to an aggregate containing multiple models, and never charge cached
or cache-write tokens again as uncached input.

This PR implements that contract for the usage Ponderosa currently receives. The price catalog is code-reviewed and dated rather than fetched during a request, so historical totals do not change unexpectedly when a provider edits its pricing page.

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
3. Add per-agent and per-project token/cost budgets with warnings and hard opt-in limits.
4. Benchmark organizations by quality-adjusted cost and latency across multiple tasks, not by raw token totals from one run.

Avoid heuristic wake suppression, text-inferred scope, mutable shared blackboards, auctions, or secretly replacing an organization with one agent. Those approaches sacrifice auditability or the organizational capability being measured.
