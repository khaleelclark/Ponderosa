# Pinecone v3/v5 experiment handoff — 2026-10-13

Outcome: the existing v5 candidate now uses **GPT-5.6 Sol/high**, explicitly approved by Patrick on 2026-10-13. One manual non-delivering validation completed through Scout, independent Reviewer and spokesperson; each actual provider Run was correlated to its exact validation Request and confirmed GPT-5.6 Sol/high. Both candidates remain paused, with recurring schedules disabled and outbound delivery disabled. V3 remains GPT-6.1 Sol/low and unchanged; its prior unsupported-model qualification remains held. The earlier GPT-6.1 blocker and fallback evidence are preserved below.

## Exact candidates

| | V3 test candidate | V5 candidate |
|---|---|---|
| UI | http://192.168.1.147:18795/branches?branch=592f4798-cd48-445a-91f2-9f9a86b1c135&tab=pinecone | http://192.168.1.147:18795/branches?branch=49005cab-f4d3-4b38-a468-bf153624e4f4&tab=pinecone |
| Branch | 592f4798-cd48-445a-91f2-9f9a86b1c135 | 49005cab-f4d3-4b38-a468-bf153624e4f4 |
| Configured AI stages | GPT-6.1 Sol / low, preserving original v3 settings | GPT-5.6 Sol / high for Scout, independent Reviewer and spokesperson/draft; explicitly user-approved |
| Final schedule | 12-hour interval configured, disabled | 10-minute interval configured, disabled |
| Admission | Branch disabled; all Agents observed idle | Branch disabled; all Agents observed idle |
| Delivery | Shadow only; no publication/Notify node | Shadow only; no publication/Notify node |
| Budget | 2 lifetime limit + 1 guard-only grant; 3 used | 2 lifetime limit + 2 one-execution grants; 3 charged automatic admissions; 1 unused allowance; manual validation separate |

The underlying Branch views are available at the same paths on port 18793. Port 18795 serves a built candidate frontend and a read-only proxy. All non-GET API requests receive 403 before forwarding, including messages and activation changes. The composer and discovery controls are disabled. This is an explicit preview restriction, not evidence that live conversation/delivery has been qualified.

## What changed

V3 now has an installed Branch and deterministic 12-hour research admission instead of only a manually executed local prototype. It starts research without incoming source changes, then passes results through independent review and an attention gate. The Scout follows the corrected question-selection and rotation principle. The 60/25/15 allocation remains experimental guidance; a full integrated weighted planner and personal-usefulness measurement remain unvalidated.

V5 clones v4's portable Branch topology, persistent roles, custom conversation UI, quiet path, deduplication and interruption budgets. Its Reviewer must separately assess freshness, novelty, active/settled status, verified applicability and blocking uncertainty. The deterministic gate refuses stale, known, dismissed, resolved or unverified findings; explicit feedback is bounded, normalized and rejects symlink files. Material changes require an explanation and changed evidence fingerprint. No household or jurisdictional circumstances are invented in the generic brief.

Shadow receipts write `delivered:false` and `communicationEventId:null`, with a distinct shadow ledger. They never add announced claims. V4's real publication contract (`requireUserCommunication`, exact Communication event validation before receipt) is retained in each candidate's `live-delivery-contract.json`, outside the deployed shadow graph. Restoring it requires an activation review; the candidate is not a live notification sender.

The UI gives proactive research, conversation and findings distinct surfaces, uses readable status language, hides the baseline's global notification badge in shadow mode, and preserves advanced evidence links. A canonical quiet result is displayed as a quiet completed check rather than a delivered finding. Cancelled/incomplete tests are shown truthfully.

## Bounded evaluation evidence

Both candidates received two initial automatic schedule admissions, then one script-only model-guard qualification admission, using one-shot test schedules. Their configured recurring intervals were restored disabled afterward.

- V3 first execution `75f692b6-e5cf-4498-adf5-7e7c76185925`: planner initiated research with no incoming user task. Startup initially failed; a supported retry completed public-source research under GPT-5.6 Sol/low. Independent review became `outcome_unknown`, so this exact candidate execution was cancelled. No review completion or quiet success is claimed.
- V3 second execution `c438e227-aad8-4d57-bcfc-f16839d42df9`: automatic admission succeeded; fresh GPT-6.1 Sol/low failed before successful research. Cancelled after preserving the uncertain outcome. Its planner reset was an explicit bounded retest, with prior state saved in evidence.
- V5 first execution `b141549b-9eef-4ea6-b76d-8bb6f0fca041`: startup initially failed; a supported retry completed research, independent review, gate and quiet outcome. Scout and Reviewer receipts record GPT-5.6 Sol/high, so this is **not** a GPT-6.1 comparison. The research concerned novelty gates and provenance receipts; the Reviewer kept it internal because novelty/benefit were not established. No personal utility claim is made.
- V5 second execution `a8ea4569-9105-4c8f-ab10-6bb0ea45ede8`: automatic admission succeeded; fresh GPT-6.1 Sol/high failed before successful research. Cancelled after preserving evidence.

Successful v5 Scout/Reviewer work used 193,294 / 233,853 input tokens, respectively. V3 Scout used 191,912. These observed costs do not establish efficiency improvement. Callback Runs are separately recorded in the audit and are not additional Branch discovery successes.

The runnable candidate suite contains 21 focused checks plus an aggregate invocation of the original 22-test v3 suite: all 43 individual checks pass. It covers autonomous admission/cooldown across processes, quiet coverage, stale and known facts, dismissals/resolutions, unknown applicability, uncertainty, normalization, feedback symlink rejection, explained material changes, duplicates across restart, interruption/topic budgets, malformed results, outbound graph absence, and truthful shadow receipts.

Web build and TypeScript checks pass. Safari desktop visual inspection and accessibility checks verified loading, completed/cancelled states and disabled controls. At 390×844 and 430×844, the accessibility tree retained the intended controls/content; Safari's responsive screenshot compositor was blank, so mobile visual layout remains incompletely qualified. No message was sent to test the composer.

Final audit: zero candidate assistant user DMs in canonical histories; empty announced ledgers; zero active candidate Agents; no delivery receipt claiming announcement. The candidate proxy rejects outbound writes with HTTP 403.

## Runtime blocker and approval review

An initial restriction configuration named absent MCP servers (`gmail`, `slack`, `google_drive`, `chunking`). Codex rejected it before work with `invalid transport in mcp_servers.gmail`. The verified actual configured names differ. A startup-only read-only probe submitted no AI turn and succeeded without those nonexistent overrides. Approval review first rejected replacing connector restrictions; after evidence demonstrated their absence and no new access, it approved removing only the invalid names. Native filesystem writes, helper creation, browser interaction, host file import, Branch calls and notifications remain restricted. No connectors were installed, credentials copied or permissions expanded.

The blocker is now verified precisely. `evidence/direct-gpt61-probe.json` records a single ephemeral, native read-only, tool-denied GPT-6.1 Sol/high inference probe. The provider accepted `thread/start` with model GPT-6.1 Sol and high reasoning, then rejected the first `turn/start` inference with HTTP 400 and the exact message: “The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.” The terminal turn failed with no items, model output, tools or outgoing messages. Thread creation alone is therefore not proof of inference support.

The silent substitution was separately reproduced against the actual served `concreteRuntimeSelection` helper: when the refreshed model catalog omits the configured GPT-6.1 model, it discards that layer and selects `adapter.defaultModel()`, GPT-5.6 Sol. The global cache read through the served adapter showed only the GPT-5.6 family after provider refresh. The model UI/cache can advertise a configured model before the provider has accepted actual inference. Evidence is in `fallback-reproduction.json` and `runtime-thread-model-probe.json`.

The isolated repair is an installed `model_guard` entry script in both candidate graphs. It requires bounded, nonsymlink, fresh qualification evidence matching the exact requested model and reasoning. Unsupported or stale evidence fails before any research, planner or managed AI Request. Each graph had one actual automatic guard-only qualification; v3 execution `6e3d18c7-5b2e-47ae-b268-d0f5608e8e0c` and v5 execution `1ac8b54d-d494-4678-aceb-e1981270cd99` failed exclusively at `model_guard`, with the exact unsupported-model reason in canonical Script stderr. There were no new model Runs. Recurrence and admission were then restored disabled.

The candidate UI serves read-only qualification metadata and explains that the subscription rejected the selected model. The updated build/typecheck and HTTP 200 checks pass. Final native browser automation stalled despite its requested timeout (one operation took about 8.6 minutes and another 19.9 minutes); further UI automation was stopped. A subsequent read-only check found that product scoping requested `/api/branches/engine/pinecone-candidate/:id/runtime` while the proxy handled only the unprefixed route. The candidate-only proxy now supports both paths. Three integration regression checks pass (both candidate IDs plus blocked writes), and the web build/typecheck pass. Safari accessibility verification after reload confirms the warning “This preview needs a supported model,” the selected-model subscription rejection, the promise that no substitute model runs, and disabled discovery/message controls. Pixel/mobile visual qualification remains limited as noted above.

Patrick resolved the v5 model choice by explicitly requesting GPT-5.6 Sol. Only v5 was changed; v3 still requires its own model/access decision before additional validation. No API-key integration, new sign-in, connector installation or credential copying was attempted.

Approval review also rejected a v4 export with `includeValues=true` because it could copy credentials. A credential-free template export without values succeeded; fresh explicit candidate parameters were supplied. No secret-bearing export was performed.

## Isolation, ownership and rollback

Writer: this delegated task, sole writer of a new local clone. Source: `/Users/patmi/Documents/Codex/2026-10-13/task-2/candidate-source`, branch `codex/pinecone-v3-v5-shadow-20261013`, base `81a49b911ba22f2a40ca622fa62f9d752fa2e253`. The local checkpoint includes the UI, preview helpers and portable guarded packages; its exact head is recorded in sibling `evidence/git-checkpoint.json`. No push, PR, release publication or merge occurred. A reviewed PR is required before product integration.

Candidate workspaces are sibling `candidates/v3` and `candidates/v5`, each with fresh brief, feedback and ledgers. Their packages and supported install/deploy receipts are preserved. No direct database writes occurred. Read-only database checks corroborated runtime and capability state. No personal memory or unrelated data was imported.

V4 retains Branch `0356095a-8d73-4249-b39d-883b978ae119`, definition `927d643b-3c97-46c7-89e8-d3092bbfc9ef`, binding revision `a98e04d8-197c-45da-a373-e3e73732e4eb`, and enabled ten-minute trigger. Its source, model settings and data were untouched. Existing Pine v1/v2 and original v3 preview were not changed. Read-only remote inspection used the existing ssh-pine connection.

Rollback is already a safe hold: both candidate Branches and triggers are disabled, accepted incomplete tests cancelled, and histories retained. Stop only the candidate UI PID recorded in sibling `evidence/candidate-ui.pid` to remove the preview server; do not target v4 PID 87824. Rebuilding/restarting this preview uses `node build-candidate.mjs` and `node serve-candidate.mjs` from this clone. It has no boot service.

Supporting records are in sibling `evidence/`, particularly `*-final-state.json`, `*-evaluated-detail.json`, `*-second-detail.json`, `final-audit.json`, `runtime-readonly-probe.json`, `deterministic-tests.log`, `web-typecheck.log`, `web-build.log` and `proxy-outbound-check.json`. Current manifests are in sibling `candidates/`; the generator refuses to overwrite existing installed manifests/feedback.

V5 model qualification is complete for the user-approved GPT-5.6 Sol/high choice. Broader usefulness/comparison evaluation and live activation remain separate decisions. V3 is still held under its unchanged GPT-6.1 selection; completing its independent review needs a separate supported-runtime choice. After that, Patrick still chooses activation, delivery and cadence. V3 remains at its exhausted three-automatic-admission budget. V5 has three charged automatic admissions and one separate manual model validation; the additional allowance granted for that validation was not charged by the manual path, so one automatic allowance remains unused while admission and recurrence are disabled. Further work still requires an explicit bounded scope and activation decision. No live activation or cadence choice has been inferred.


## Approved v5 GPT-5.6/high update — 2026-10-13 21:17 UTC

The same Branch, Chat, Agents, workspace and URL were retained. Supported Agent PATCH endpoints changed only v5's Scout, Reviewer and spokesperson to `gpt-5.6-sol` / `high`. The portable v5 manifest, Branch `requiredModel`/`requiredEffort` settings and exact-model qualification artifact were updated consistently. The guard source still rejects unsupported, mismatched or stale evidence; no silent model normalization was enabled.

A single explicit manual validation execution, `366bf2db-cd48-41d4-81cd-cfc26809dc0e`, used an immutable temporary validation definition with the exact-model guard and three non-delivering Agent stages. Its input and instructions prohibited research, browsing, email, filesystem changes, messages, notifications and delegation; each stage completed only its correlated Request. The regular v5 shadow definition was restored immediately after admission, and admission was held again while accepted work finished. The ten-minute trigger remained disabled throughout. One additional execution allowance was granted before validation. The application records the explicit manual validation separately and did not charge its automatic-admission budget: that counter remains 3, with policy limit 2 plus 2 supplemental allowances, leaving one unused automatic allowance. Admission and recurrence remain disabled; that allowance does not activate any work. Four total executions exist, including the one manual validation.

| Stage | Exact actual provider Run | Verified model/reasoning |
|---|---|---|
| Scout | d761ef51-919c-46c6-8a6e-edc044ad60a5 | gpt-5.6-sol / high, completed |
| Independent Reviewer | e1568398-115a-469a-95c6-eb719268e25e | gpt-5.6-sol / high, completed |
| Spokesperson/draft | f74a5a30-3a23-4bfe-80bb-57d279412572 | gpt-5.6-sol / high, completed |

The final receipt explicitly records `delivered:false`, `communicationEventId:null` and `outboundAuthorized:false`. Canonical tool-call/results correlate these Runs to the three exact validation Requests. The qualification artifact's timestamp is the actual final completed Run time, `2026-10-13T21:17:39.934Z`, rather than a fabricated current observation. All v5 Agents were observed idle afterward, with zero assistant user DMs and no announced claims.

Relevant guard checks pass, including refusal of unsupported models, model/effort mismatches and stale evidence, plus preservation of input for an exactly qualified model. The candidate suite reports 23 passing test methods, including its aggregate original-v3 suite. Three scoped-route integration checks pass; web build and TypeScript pass. This bounded test validates actual runtime selection and non-delivery, not research usefulness or a live delivery path.

Before/after API evidence and hashes confirm all v3 candidate files and model settings were unchanged. V4 retained its exact version, binding revision and enabled trigger. Existing v1/v2 and original v3 were never targeted. Credentials and security/capability policies were not changed.

Evidence: sibling `evidence/v5-gpt56-verified-receipts.json`, `v5-gpt56-validation-detail.json`, `v5-approved-model-change.json`, `v5-gpt56-final-preservation.json`, `v5-gpt56-guard-tests.log`, `v5-gpt56-route-tests.log`, `v5-gpt56-web-build.log` and `v5-gpt56-web-typecheck.log`. The preview URL is unchanged. Live recurrence, user messaging/delivery and broader prospective evaluation remain disabled.
