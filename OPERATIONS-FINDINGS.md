# Ponderosa Next operations findings

This append-only experiment ledger records product and operating friction observed while using Ponderosa. `Confirmed` means the behavior was observed directly by the operator or Product Lead; it does not mean the root cause or fix has been reviewed.

## 2026-08-24T05:00:00Z — UI-001 — New Chat promise conflicts with no-Agent send failure

- Severity: High
- Classification: Defect
- Confirmed: Yes — operator reproduction on the isolated `:20443` service; Product Lead source inspection confirmed the empty state promises that sending starts the first Agent. A fresh no-Agent-state recheck is required immediately before the fix because the Product Lead's first live attempt was contaminated by the adjacent New Agent toggle described in UI-002.
- Reproduction:
  1. Open a Project with zero active Agents and its initial `New Chat`.
  2. Observe: “Send a request to start your first agent — its completed answer returns here.”
  3. Enter a request and press Send without selecting an Agent.
  4. Send fails with “There are no active Agents to notify”; the draft remains intact.
- Impact: The primary first-run path contradicts its own guidance and blocks a new user at the moment they expect Ponderosa to start working.
- Recommended fix: Make the advertised first-send path atomically create the first managed Agent and opening Request, or change the empty-state/composer interaction to require and visibly guide Agent creation before Send. Preserve the draft on every failed path. Resolve the product choice within the existing reviewed managed-Agent creation contract, not with a second assignment mechanism.
- Owner: UI Integration, with server contract inspection as read-only evidence; escalate before changing creation semantics beyond the reviewed contract.

## 2026-08-24T05:00:00Z — UI-002 — Prominent New Agent control does not open Agent creation

- Severity: High
- Classification: Defect (interaction and state visibility)
- Confirmed: Yes — operator reproduction and Product Lead live reproduction on `:20443`.
- Reproduction:
  1. Open a new Chat with no Agents.
  2. Click the prominent `New Agent` control beside the composer.
  3. The URL does not change and no Agent-creation dialog or destination is presented. The control silently toggles composer intent; in the Product Lead exercise, no visible semantic snapshot changed.
  4. Enter and send a draft. The latent selection creates an Agent and starts its first Run, demonstrating that the click changed consequential state without making the next action clear.
  5. By contrast, open Chat settings and choose `Create Agent`; that path opens the expected creation flow.
- Impact: A creation-looking control appears inert, hides consequential send behavior, and makes safe reproduction difficult. It can cause users to create/start an Agent unintentionally.
- Recommended fix: Give the prominent control one explicit, visible outcome consistent with its label. Prefer opening the existing Create Agent flow; if inline first-Agent intent is retained, label it as a send destination/mode, expose selected state and consequence accessibly, scope it to the current Chat, and never let it leak across Projects.
- Owner: UI Integration.

## 2026-08-24T05:00:00Z — OPS-001 — Project workspace opened without the designated checkout

- Severity: Low
- Classification: Operational defect
- Confirmed: Yes — Product Lead reproduced at run start.
- Reproduction: Start the managed Run with the Project workspace as cwd; `pwd` resolves to the run workspace, but it is empty and is not a Git repository. The actual checkout is `/home/phoenix/ponderosa-project-rail-runtime/source`.
- Impact: Baseline verification initially fails and an Agent could wrongly conclude that source is missing.
- Recommended fix: Register or expose the authoritative checkout as the Project workspace root and include it in the run's structured filesystem context.
- Owner: Ponderosa Engine/runtime.

## 2026-08-24T05:00:00Z — OPS-002 — Common Project Chat reply required an undocumented explicit intent

- Severity: Low
- Classification: Operational defect
- Confirmed: Yes — Product Lead reproduced while publishing the required pre-implementation plan.
- Reproduction: In a Project Chat manager request with a stated inferred Project reply, call the common `ponderosa_message({text})` form. The capability rejects it with “this Run has no unambiguous reply route”; retrying with explicit `intent: "broadcast"` succeeds.
- Impact: The documented common path fails in a normal top-level Project Chat and costs an avoidable recovery attempt.
- Recommended fix: Make the active capability expose one canonical reply route for this activation, or have the prompt explicitly require the resolved intent from the outset.
- Owner: Ponderosa communication capability/runtime.
