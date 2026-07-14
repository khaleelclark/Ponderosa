# Token-efficient organizations

Ponderosa should preserve the useful part of an organization—durable specialist identity, direct communication, and reusable domain knowledge—without paying for organizational structure on every turn.

## Measurement contract

Optimization starts with provider-measured usage, not estimates derived from visible text:

- Store input, cached-input, cache-write, output, reasoning, and total tokens independently when the provider exposes them.
- Store the engine, requested model, and effort on every run so usage remains attributable after agent settings change.
- Prefer absolute provider thread totals and derive a run delta from the prior absolute checkpoint. Never add a per-request snapshot to an absolute thread total.
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

Per-run costs are summed by token class and by pricing model before agent,
project, or overall totals are displayed. Never apply one blended rate to an
aggregate containing multiple models, and never charge cached or cache-write
tokens again as uncached input.

This PR implements that contract for the usage Ponderosa currently receives. The price catalog is code-reviewed and dated rather than fetched during a request, so historical totals do not change unexpectedly when a provider edits its pricing page.

## Safe savings implemented now

A retained provider session already contains its organization envelope. Ponderosa therefore omits the full team directory and managed-agent creation instructions while the stable roster, roles, and reporting graph remain unchanged. New, restarted, evicted, rolled-over, or organization-changed sessions receive the complete envelope. Continuation turns still receive authoritative runtime identity, current manager relationship, a pointer to the live directory, new room context, the current request, and the required communication contract.

This reduces repeated input as the organization grows without changing delivery behavior or relying on rendered text heuristics.

## Durable waiting

An agent identity should be durable, while a provider turn is temporary and an OS process is an evictable cache:

`runnable -> running -> waiting(condition) -> runnable -> running -> idle`

Agents have an explicit, durable wait latch supporting:

- all expected reports;
- any response;
- quorum (`n` of `m`);
- deadline;
- immediate user or blocker override; and
- informational delivery without waking.

Registering a wait atomically includes the expected stable agent IDs, condition, optional deadline, and the current delivery watermark. Each inbound communication is persisted normally, but only the transition that satisfies the condition may claim the next execution. User/direct signals and managed-agent failures override the latch, and deadlines resume with the reports received so far.

This lets a manager park after delegating, accumulate three reports without running three times, and synthesize once. The latch is append-only and restart-safe; reporter identities are counted once after the registration watermark.

## Further strategies

After accounting and waiting are trustworthy:

1. Add prompt-segment manifests so the UI can attribute input to system policy, team directory, history, task, and artifacts.
2. Replace repeated large payloads with canonical artifacts plus targeted retrieval and stable references.
3. Make direct delivery to the actual consumer the default; managers synthesize and decide rather than relay routine messages.
4. Route bounded, verifiable work to cheaper models, with explicit escalation criteria and a capable model retaining outcome ownership.
5. Add per-agent and per-project token/cost budgets with warnings and hard opt-in limits.
6. Benchmark organizations by quality-adjusted cost and latency across multiple tasks, not by raw token totals from one run.

Avoid heuristic wake suppression, text-inferred scope, mutable shared blackboards, auctions, or secretly replacing an organization with one agent. Those approaches sacrifice auditability or the organizational capability being measured.
