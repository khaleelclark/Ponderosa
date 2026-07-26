# Ponderosa Production UI, Usability & Workflow Review — 2026-07-25

Deployed instance: `https://pine.tail8187ff.ts.net/` · server revision `fdf1eb1dfbe5e5a432afd715e269800f568b46d6` · reviewed 2026-07-25, ~07:40–08:30 AM (instance local time).
Method: live driving of the production UI via scripted Chromium (1440×900 desktop @2x and 390×844 mobile), with screenshots and DOM/network measurements. Evidence screenshots: `~/Desktop/ponderosa-ui-review-evidence-2026-07-25/` (referenced below as `NN-name.png`).
Companion document: the 2026-07-25 repository review (`ponderosa-review-2026-07-25.md`); this review evaluates only what users experience in production and does not repeat code findings.

---

## 1. Executive verdict

Ponderosa in production is **substantially better than its codebase's size suggests** and is close to demo-able for a patient early adopter. The core promise — an organization of agents doing real work behind a familiar chat — demonstrably works end to end: single-agent runs, targeted continuity, file creation with provenance, a manager fanning out to two specialists and reporting exactly once, and a Decision loop that resumes the agent after the human answers. Long production histories load fast with correct scroll anchoring, and the audit surfaces (Activity, Files & Results, Provider Activity) are genuinely strong.

The blocking problems are not reliability — they are **comprehension traps at the exact moment a casual user forms their mental model**:

1. **The composer does not communicate that an untargeted message starts a brand-new agent.** My follow-up was answered by a second agent claiming "I have no previous reply to repeat" — in the same conversation, two messages below the reply it denied having. The fresh-agent-per-untargeted-message behavior is the *intended product contract* (cross-review confirmed); the failure is that nothing at the moment of sending makes the destination unmistakable (§6, P1-1).
2. **Decisions are not actionable where they're asked.** The chat shows only agent prose; the actual Option A/B buttons live in the notification inbox, whose header simultaneously said "You're all caught up" (§6, P1-2).
3. **Naming everywhere is machine salad** — chats titled "User Sorry Patrick Previous…", an agent named "Medgar and Myrlie Evers Home" — which undercuts the "organization" feel more than any layout bug (§6, P2-4).

None of these require architecture work. All are UI/copy/defaults fixes.

## 2. Scope and environment

- Desktop viewport 1440×900 (screenshots @2x), mobile 390×844.
- All test runs used the **Codex** provider (per authorization); Claude surfaces were inspected read-only.
- Both providers reported Available; two existing schedule Triggers ("Hi", "2") observed, never fired or edited.
- No provider toggles changed, no production Projects/Chats/Agents/Triggers/files altered, no source code touched.
- Automation note: two anomalies flagged below (§13) occurred only under synthetic programmatic scrolling; each was retested with realistic input and is labeled accordingly.

## 3. Production records created during qualification

All qualification state is inside one clearly named Project and can be deleted as a unit (left in place per instructions):

| Record | Identifier / name |
|---|---|
| Project | **Fable Production UI Qualification — 2026-07-25** (`40c497a7-1336-4214-9d3d-14f2d6a99e9a`), Private Empty Workspace, Codex GPT-5.6-Sol Low |
| Chat | "Build Debug Test Review Software" (auto-renamed from "New Chat"; `48b21251-f822-441b-af90-cbc20d0c21aa`) |
| Agents (5) | Cape Cod (`45defa79-…`); Medgar and Myrlie Evers Home; Thomas Jefferson Memorial (manager); Result A Specialist; Result B Specialist (both delegated under the manager) |
| File | `QUALIFICATION_NOTE.md` (workspace `project-c14fad3f-…` + managed artifact `generated/24c0afaf-…`) |
| Decision | One ("choose Option A or Option B"), answered **Option A** via the notification inbox |
| Messages | ~8 operator messages, ~8 agent replies, incl. one sent through the All Messages composer |

**Unrelated production data changed:** exactly one item — the three pre-existing unread notifications (Lincoln Memorial, Ponderosa project) were marked read when I clicked one to verify click-through navigation (§8). The messages themselves were already-delivered copies; nothing was sent to, or altered in, any production Project. The Lincoln Memorial reply-target was selected in Messages during testing but **no message was ever sent to it**.

## 4. Tested-journey matrix

| # | Journey | Result |
|---|---|---|
| 1 | Navigation & orientation (spine, sidebar, collections, tabs, search, Wiki, Settings) | PASS with naming caveats |
| 2 | Messages (read, source labels, reply target, send, rendering, unread) | PASS core loop; 3 findings |
| 3 | Single-agent workflow (run start, streaming, status, worked-for, follow-up) | PASS except follow-up continuity trap (P1-1) |
| 4 | Files & results (creation, Activity, preview, diff, download, provenance) | PASS; one mixed signal (Review All on non-git) |
| 5 | Multi-agent (manager + 2 specialists, join, single report) | PASS — exemplary |
| 6 | Decision workflow | Functional; visibility gaps (P1-2) |
| 7 | Mature project (Minecraft AI Builder) long history | PASS |
| 8 | Notifications & attention | Mixed (read-marking, caught-up copy) |
| 9 | Provider & command surfaces (/status, skills, Settings, Provider Activity) | PASS; discovery gap for native commands |
| 10 | Mobile (390×844) | PASS; timestamps hidden |
| 11 | Performance & scaling on real data | PASS at current scale |

## 5. What worked well

Explicitly protect these behaviors during future changes:

- **The organizational core is real.** The manager task produced exactly the intended org: two specialists "Delegated under Thomas Jefferson Memorial" in a collapsible hierarchy (`30-org-hierarchy.png`), coordination visible in Team Chat, and **exactly one** final user-facing report ("RESULT-A RESULT-B") ~70 seconds after dispatch. No duplicate acknowledgments, no premature partials, no orphaned "still working" state.
- **Run lifecycle presentation.** "Started a Run for Cape Cod" → live "responding · 0:03" timer with a stop control → "Processed by Cape Cod" receipt → per-reply "Worked for 11s/16s/14s" chips (`16`, `24`).
- **Agent audit surfaces.** Chat / Activity / Triggers / Files & Results / Settings subtabs; Activity grouped by Run with event counts, durations, file paths, and inline "1 changed file +2 −0" expanders with Preview/Download (`25`, `28`). Files & Results shows provenance ("Created by Cape Cod · Generated from Run 9d90c16a · Project scope") with rendered markdown preview (`26`).
- **Decision resolution mechanics.** Options presented (incl. an automatic "Something Else" escape hatch), answer recorded, agent resumed and confirmed within ~1 minute, notification urgency flagged correctly (`34`).
- **Messages as a working surface.** True cross-project aggregation with "Project · Chat" source labels on every message; agent-only Mention targets (user messages correctly excluded); the full select → compose → agent-replies-in-feed loop works with a "Direct message sent to Cape Cod" receipt (`53`).
- **Long-history behavior.** The mature Minecraft AI Builder chat (100+ messages, ~24k px of content) opened in ~2s anchored to the newest message; "Load Older History" prepended ~2.7k px with **zero scroll jump**; rich markdown rendered cleanly throughout (`37`, `38`).
- **Provider Activity** (`52`): token usage with cache split, finalized-run counts, "Why Runs Started" cause breakdown, per-provider model lists, and honest caveats ("not subscription quota… not a cost estimate"; "reported for 809 of 880 finalized Runs"). This is the most trust-building screen in the product.
- **Honest failure copy.** `/status` in a fresh chat → "Message not sent. The active provider does not advertise /status." with the draft preserved (`41`).
- **Workspace frame consistency.** Home, Create New, Project, Chat, and Agent all share the identity-header + subtab frame; all four All-collections share the same header/toolbar/row pattern (`03`, `05`, `06`). The repo-review's intended model is visibly shipped.
- **Mobile adaptation** (`45`–`49`): drawer nav mirrors desktop, stat grid reflows 2×2, no horizontal overflow, "Processed by X" chips shorten to "Processed", drafts persist across viewport changes.

## 6. Severity-ranked findings

### P0 — none observed
Nothing destructive, unsafe, or unusable was found. No data loss, no crash, no stuck run, no unauthorized action.

### P1-1 · The composer does not communicate the fresh-agent-per-untargeted-message contract

- **Observed:** In the qualification chat, after Cape Cod answered, I sent "Follow-up: … repeat the first word of your previous reply." Ponderosa started a **new** agent ("Medgar and Myrlie Evers Home") which replied *"I have no previous reply to repeat."* — directly beneath the visible reply it denies (`19-hash-autocomplete.png` shows the sequence). Targeting `#Cape-Cod` afterwards produced the correct "Build." — continuity works, but only via the `#` convention.
- **Product-contract note (cross-review, accepted):** fresh-agent-on-untargeted-send is *intentional* — it is what keeps Chat an organizational surface rather than a single-assistant conversation. Untargeted follow-ups must **not** be silently rerouted to the last agent, and follow-up intent must never be inferred from prose. The defect is purely that the UI does not make the destination unmistakable before dispatch.
- **Repro:** New Project → New Chat → send any message → after the reply, send a follow-up without `#target`.
- **Surface:** `/projects/:id/chats/:id` composer; the only cue is one line of placeholder microcopy.
- **Impact:** first-session users experience "the AI forgot everything," compounded by a differently-named stranger answering; each untargeted follow-up also mints another agent (my chat accrued 5 agents from a 3-task session).
- **Severity: P1** — this is the moment the casual mental model breaks.
- **Agreed correction (destination visibility, not routing):**
  - show a persistent **"New Agent"** destination chip on the composer whenever the message is untargeted;
  - after an agent responds, offer a visible **"Continue with Cape Cod"** action; selecting it replaces the New Agent chip with a removable `#Cape-Cod` chip;
  - the send button's helper state always reads either **"A new Agent will respond"** or **"Cape Cod will receive this"**;
  - never infer the target from prose.

### P1-2 · Decisions are not actionable where they are asked, and "caught up" copy contradicts an urgent pending Decision

- **Observed:** Cape Cod's Decision produced only prose in the chat ("Please answer the Decision to choose Option A or Option B") — no card, no buttons (`32`, `33`). The actionable card (Option A / Option B / Something Else + "Review Work Details", "Urgent" chip) exists solely in the notification inbox (`34`), whose header simultaneously read **"You're all caught up."** After answering, the user's choice never appears as a message in the chat — only the agent's confirmation ("You chose Option A."), so the transcript shows an answer to an invisible question. (The choice *is* recorded — global search shows "#user You chose Option A." — it's just not rendered.)
- **Expected:** the Decision renders as an actionable card in the originating Chat (and Messages), resolves in place, and the chosen option appears as a user-authored message; the inbox header reflects pending urgent items.
- **Repro:** ask any agent to use the Decision capability; watch the chat vs. the bell.
- **Impact:** a user watching the conversation — the surface they were just using — sees a stalled agent and no way to act; on mobile especially, they may never find the inbox card. The blocker workflow's whole value is response latency.
- **Severity: P1.**
- **Smallest credible correction:** render the existing inbox Decision card component inline in the chat timeline at its message position (both surfaces already share the data); change the panel header to "1 item needs your decision" when unactioned urgent items exist; append the resolved choice as a user message. The card component already exists — this is placement, not new machinery.

### P1-3 · The Messages reply target cannot be cleared

- **Observed:** selecting Mention on an agent message opens the direct-message composer ("Message Cape Cod"). Escape does not clear it; clicking the Mention action again does not clear it; there is no ×/chip control (`11`). The target persists after sending. The only escapes are selecting a different agent or navigating away.
- **Expected (explicit spec item):** clearing the selected reply target works.
- **Repro:** `/messages` → click any agent message → Mention icon → press Escape / re-click Mention.
- **Impact:** users who selected the wrong agent can strand themselves; with the composer visible, a hurried message goes to the wrong recipient — in a product where messages start real provider runs.
- **Severity: P1** (misdirected-send risk), small fix.
- **Smallest credible correction:** render the target as a dismissible chip above the composer (× clears and hides the composer); make Escape clear it; make the Mention control toggle.

### P2-4 · Machine-generated naming reads as word salad across the entire workspace

- **Observed:** auto-titles — my chat became "Build Debug Test Review Software"; production chats include "User Sorry Patrick Previous …", "Done Team Built Independently Verified", "Ready Patrick Created Home Phoenix", "Patrick Phase Underway Created Eight" (`04`). Project rows append "Recent: <that title>", producing "Recent: User Assigned…" (`03`). Agent auto-names draw from a park/landmark pool that yields unwieldy or awkward picks — "Medgar and Myrlie Evers Home" (a civil-rights memorial) answering a debugging follow-up; "Thomas Jefferson Memorial" as a manager.
- **Impact:** every list (sidebar, collections, search, tabs, Messages) is full of titles that convey nothing and sometimes read as broken English. This is the single biggest reason the workspace feels like a machine's filing cabinet rather than an organization. (Directly relevant to the "does it feel like an organization?" question — the org *chart* does; the *names* don't.)
- **Severity: P2** (pervasive, recurring; not blocking).
- **Smallest credible correction:** (a) title generator: prefer the user's request intent over the agent's answer, allow stopwords/articles ("Fix sidebar collapse" not "Sidebar Collapse Fixed User"), cap at ~5 words; (b) curate the agent name pool to short, unambiguous nature/place names (Cape Cod, Saratoga are fine) and remove memorial/residence names; (c) drop the "Recent:" suffix from project rows or truncate to 3 words.

### P2-5 · Viewing a message does not mark its notification read

- **Observed:** I read all three Lincoln Memorial messages at length on `/messages`; the bell badge stayed at 3 and all three items remained bold-unread in the panel (`20`). Only clicking the notification itself cleared them.
- **Expected (spec item):** messages already viewed should not remain misleadingly unread.
- **Impact:** trains users to ignore the badge — fatal for a surface that also carries urgent Decisions (P1-2).
- **Severity: P2.**
- **Smallest credible correction (cross-review agreed):** when a message is rendered in the viewport of All Messages (or its chat), mark the corresponding *ordinary message* notification read. Decisions, blockers, and operational issues stay unread until actually resolved — viewing is not acting.

### P2-6 · "Review All" leads to an empty review for non-git workspaces while Activity advertises a diff

- **Observed:** Activity shows "1 changed file +2 −0 · Review All"; clicking Review All opens `/projects/:id/reviews/:agentId` showing "REVIEW · 0 changes — This working folder is not a Git repository." (`27`). The inline expander on the same row *does* show the change with Preview/Download (`28`) — the data exists; the surface picked can't show it. Private Empty Workspace is the **default** project type, so every new default project hits this.
- **Severity: P2.**
- **Smallest credible correction:** in non-git workspaces, point "Review All" at the run-scoped changed-files view (the inline expander's data) instead of the git review pane, or hide it and leave the expander.

### P2-7 · Team Chat lifecycle noise, including triplicated events

- **Observed:** the two-specialist task emitted ~20 lifecycle rows, including "Thomas Jefferson Memorial received every result it was waiting for" **three times**, plus queued/finished pairs for every micro-run (`31`).
- **Impact:** at production scale the signal (actual agent-to-agent messages, which appear correctly) drowns; repeated "finished"/"queued" oscillation reads like a malfunction.
- **Severity: P2.**
- **Smallest credible correction:** de-duplicate join-progress events into one row with a counter; collapse queued→finished pairs under a per-run disclosure; keep authored messages prominent. Collapse and de-duplicate only — the operational visibility itself must remain (cross-review).

### P2-8 · Workspace tabs carry generic titles, and notification clicks replace the active tab

- **Observed:** any project opens as a tab titled "Project Overview" (Devoria's tab: visible text "Project Overview"; only aria-label says "…in Devoria"). Two open projects are indistinguishable. Clicking a notification navigated my active qualification-chat tab away to the Ponderosa chat rather than opening a new tab (`21`).
- **Severity: P2.**
- **Smallest credible correction:** use the resource name as the visible tab label ("Devoria", falling back to view name for singletons); open notification targets via the existing background-tab path (or restore the replaced route in history).

### P2-9 · Routing artifacts leak into rendered chat text

- **Observed:** agent replies render prefixed "#pto" ("#pto Build.", "#pto ACKNOWLEDGED"); the agent audit chat renders "#broadcast - …" (`24`). Sent messages render "#Cape Cod" with a space while the typed handle is `#Cape-Cod`.
- **Impact:** cosmetic, but users see plumbing on every single agent message; new users will wonder what "#pto" means.
- **Severity: P2 (cosmetic, universal).**
- **Smallest credible correction (cross-review refined):** do **not** strip handles wholesale — handles are intentionally preserved in copied message text, and real Agent/user handles should stay visible and highlighted. The specific bug is that the *internal* `#pto` route leaks as literal leading text instead of being presented as a structured route (the way user messages already chip-render `#Cape-Cod`). Present the leading route as a chip/label; leave in-body handles untouched.

### P3-10 · Chat deep links restore the last-open subtab instead of the conversation
Navigating to a chat URL landed on its Agents subtab (my previous state), hiding the composer and messages. Surprising for shared/deep links; make the URL's implied view (Chat) win over remembered state.

### P3-11 · Wiki still calls the surface "All Chat"
Product says "All Messages" everywhere (`07`, sidebar, tab); wiki nav says "All Chat" (`43`). One rename in the wiki source; matches the repo-review naming finding, which is otherwise **no longer current** in the visible UI.

### P3-12 · Mobile chat omits timestamps entirely
Desktop shows full timestamps per message; mobile shows none (`47`, `48`). Cross-review: restore the previously intended **tap-to-reveal** behavior rather than adding always-visible stamps.

### P3-13 · Duplicate landmark labels
Two `<nav aria-label="Primary navigation">` elements (rail + drawer). Rename one ("Primary navigation (drawer)") for screen-reader disambiguation.

### P3-14 · Slash menu shows provider skills but not native commands
Typing `/` lists Codex `$skills` with verbose descriptions (`40`); `/status`/`/usage` are not in the menu, and their existence is discoverable only via the post-send error (`41`). Cross-review: the `/status` rejection is *honest* — the session genuinely didn't advertise it, and unsupported commands must not be hardcoded into the menu just to appear. The remaining (small) improvement: when a session *does* advertise commands, list them in the autocomplete alongside skills.

## 7. Messages findings

- Contains exactly operator-directed traffic: agent→user reports and user→agent sends; no Team-Chat/agent-to-agent traffic bled in during the multi-agent test (checked immediately after the join completed). ✔
- Source comprehension: every message carries "Project · Chat" labels; on mobile they wrap cleanly. ✔
- Reply target: selection works and targets the correct agent; **clearing does not work** (P1-3); user-authored messages expose no Mention action (verified across 4 agents' messages + own) ✔/✘
- Send loop: message sent from Messages produced the run, and the reply arrived inline in the feed with a delivery receipt. ✔
- Rendering: markdown, inline code, external links (PR link with icon), long messages, and `#handle` chips all render correctly (`07`, `09`); an artifact-backed file message rendered as a code chip + changed-file block in chat.
- Blockers/Decisions: **not** actionable from Messages itself — prose only; the actionable card is inbox-only (P1-2).
- Unread: see P2-5.

## 8. Single-Agent workflow findings

Timeline (all 2026-07-25): 7:55 send → run chip + live timer → 7:56 two-bullet reply, "Worked for 11s". Follow-up trap at 7:56 (P1-1); `#Cape-Cod` continuity correct at 7:58 ("Build.", 16s). Timestamps, status chips ("Idle · Live"), and Messages mirroring all correct. Notifications: agent replies to a present operator generated no notification spam. ✔ The status column in the chat's Agents tab showed "Idle" within seconds of dispatch — runs this short never visibly show "working" in the roster (fine at this duration; worth rechecking with long runs).

## 9. Multi-Agent workflow findings

Creation → hierarchy → fan-out → join → single report, all inside ~70s, with the exact expected shape (§5). The manager waited for both specialists (join events confirm), and partial completion was never surfaced to the user prematurely. The user can understand the outcome without diagnostics; the *process* is understandable from Team Chat despite the noise (P2-7). Requests/Join internals (fences, outbox) were invisible — as they should be. One oddity: specialists' roster rows read "Idle" throughout (runs too short to catch); the Team Chat feed is currently the only place the sequencing is legible.

## 10. Decision and notification findings

Decision: creation ~15s after ask; inbox card correct (urgent, three options incl. auto-"Something Else", work-details link); resolution immediate; agent continuation confirmed in ~1 min; state consistent across chat/search/inbox afterwards. Gaps: P1-2 (placement, caught-up copy, missing user-side echo in chat).
Notifications: grouped by project with per-group Clear All; All/Issues/Mentions tabs; click-through deep-links to the exact message with an amber highlight (`21`) — excellent. Read-marking gap: P2-5. Clicking one item cleared the whole badge (group marked read) — verify that's intended rather than per-item.

## 11. Desktop findings

Navigation model (spine → sidebar → tab strip → workplace) is coherent; the two-step rail (sidebar preview, then "View All X" for the collection workplace) is discoverable and consistent across all four sections. Collections share one visual system (search, sort incl. drag-to-custom-order, star, overflow, "N across Ponderosa" counts). Global search: filter chips + recent chats + transcript snippets; opened from the magnifier (`42`). Create New is a proper workplace with Project/Chat/Agent/Trigger subtabs. Tab strip: create/switch/close/background-open all work (P2-8 titles aside). Settings: General / AI Providers / Notifications / Provider Activity; provider cards state disable semantics precisely ("finish active Runs, then hold queued work"). Wiki is a real, versioned product guide. The repo-review's "technical" agent subtab is not present in production navigation (only reachable views: Chat/Activity/Triggers/Files & Results/Settings) — either removed or hidden; the audit story doesn't suffer for it.

## 12. Mobile findings (390×844)

Everything tested worked: drawer nav, header controls, chat readability, bottom composer with runtime selector, scroll-to-bottom FAB, inbox with actionable Decision buttons, Messages with wrapped source labels, no horizontal overflow anywhere visited, adequate touch targets. Gaps: timestamps hidden (P3-12); the workspace tab strip is absent on mobile — tab state is effectively desktop-only (acceptable, but switching devices loses the "open tabs" concept silently); keyboard-shortcut hints are (correctly) absent.

## 13. Performance and long-history findings

- Initial app load (cold-ish): interactive in ~2–3s over Tailscale.
- Mature chat open: ~2s to fully rendered, correctly bottom-anchored (`37`).
- Load Older: instant prepend, zero anchor jump (`38`).
- All Agents (87 agents, 8 projects): renders promptly; **29 API calls** on load — a `conversations`+`agents`+`agent-health` triple per project. Linear in project count; fine at 8, worth batching by ~30+.
- All Messages fresh load: 31 calls, same fan-out pattern, correctly anchored.
- Live updates: run chips/timers/status propagate within ~1s over SSE with no visible rerender jank.
- **Synthetic-only anomalies (direct observation, could not reproduce with realistic input):** force-scrolling *every* scrollable container to bottom simultaneously left All Messages with ~2,000px of phantom empty space below the last message (blank viewport at max scroll; `08`), and the console recorded 20+ `net::ERR_INSUFFICIENT_RESOURCES` request failures during that same storm. Realistic wheel-scrolling up and back down could not reproduce either (`51`, content bottom within 13px of viewport bottom). Treat as low-priority hardening: bound concurrent fetches triggered by fast scrolling, and re-clamp scroll anchor after bulk prepends. A handful of unexplained 404s also appear in the console over a long session — worth a pass with server logs.

## 14. Repository-review claims: confirmed / contradicted / no longer current / not observable

| Repo-review claim | Production verdict |
|---|---|
| Messages/All-Chat/All-Chats naming triangle | **Mostly no longer current** — UI consistently says "All Messages" (page, sidebar, tab) and "All Chats" (collection). Residue: wiki page "All Chat" (P3-11); route kinds remain internal. |
| Shared workspace-frame consistency incomplete | **Contradicted (in the good direction)** — frame + collection primitives are visibly uniform across Home/Create/Project/Chat/Agent and all four All-collections. |
| `ProjectArtifactsView` misnames the Project workplace | **Confirmed as designed** (Overview + Files & Results is the Project workplace) — purely internal; not user-visible. |
| Agent audit surface comprehensibility | **Confirmed good** — clear Chat/Activity/Files separation; raw JSON tool-result rows are technical but appropriately confined to Activity. |
| Provider activity presentation | **Confirmed strong** — honest caveats, cause breakdown, no invented cost figures. |
| Fresh-agent-per-message model (bounded context) | **Confirmed and user-visible as the P1-1 trap** — the repo review's "communication model" reads as implementation detail; in production it is the top UX risk. |
| Claude context-rollover gap; scheduler/app.ts monolith; migration runner; busy_timeout | **Not externally observable** — runtime behaved flawlessly during all qualification workflows. |
| Event-log O(N) reads / SSE replay cost | **Not observable at current scale** — mature chat interactions were fast. |
| Per-project query fan-out in collections | **Confirmed** — 3 calls/project on All Agents & Messages (29–31 calls @ 8 projects); harmless today. |
| Trigger/webhook safety posture | **Not exercised** (firing prohibited); definitions/UI render correctly. |

Implementation complexity as user-facing friction: **largely invisible** — the one place plumbing leaks is P2-9 (`#pto` prefixes) and the raw JSON in Activity. The runtime's complexity is well hidden; the friction that exists is naming, placement, and defaults.

## 15. Recommended smallest fixes (priority order — aligned with cross-review)

1. **Inline Decisions and correct attention copy** (P1-2): render the inbox Decision card in the originating Chat (and Messages), echo the answered choice as a user message, and never show "You're all caught up" while a Decision pends.
2. **Clearable Messages reply target** (P1-3): dismissible target chip, Escape clears, Mention toggles.
3. **Read-on-view for ordinary message notifications** (P2-5); Decisions/blockers/operational issues stay unread until resolved.
4. **Explicit New-Agent vs existing-Agent composer mode** (P1-1): persistent "New Agent" destination chip, "Continue with Cape Cod" action swapping in a removable `#Cape-Cod` chip, helper state naming the recipient. **Preserve the fresh-agent contract; never infer the target from prose.**
5. **Non-Git "Review All" correction** (P2-6): open Ponderosa's recorded changed-file view instead of an empty Git review.
6. **Resource-named workspace tabs + safer notification navigation** (P2-8): visible resource names in tab labels; notification click-through must not replace the active tab.
7. **Cleanup batch** (P2-4, P2-7, P2-9, P3s): curated agent-name pool + request-intent chat titles; collapse/de-duplicate Team Chat lifecycle rows *without removing operational visibility*; present the internal `#pto` route as a structured chip while keeping real handles highlighted and copyable; wiki "All Chat"→"All Messages"; chat deep links prefer the Chat subtab; mobile tap-to-reveal timestamps; dedupe nav aria-labels.

Explicitly **not** actionable now (per cross-review, matching my §13 labels): the synthetic-scroll anomaly and the per-project query fan-out — neither reproduced under normal usage; revisit only with real-usage evidence. Do not hardcode unadvertised slash commands.

## 16. Launch-readiness assessment

**Ready for supervised/beta use by operators who will learn the `#` convention; not yet ready for the "casual user opens a Project chat" promise.** The launch gate for that promise is items 1, 2, and 4 of §15 — the three moments a first-session user is guaranteed to hit (first blocker, first misdirected reply, first follow-up). Note the follow-up fix is *communication of the existing contract*, not a routing change: the fresh-agent model is intentional and stays. Everything else observed is polish. Reliability, run-lifecycle honesty, long-history behavior, audit surfaces, and mobile adaptation are already at or above launch bar. The runtime never once lost, duplicated, or misattributed work across ~15 runs, 5 agents, a join, and a Decision — the foundation deserves the UI fixes standing between it and a comprehensible first session.

## 17. Untested behavior and why

- **Trigger firing / webhook ingestion / filesystem events** — explicitly prohibited (existing production triggers; no synthetic firing safe).
- **Provider disable/enable, engine switching, global runtime config** — prohibited.
- **Claude-engine runs** — authorization covered Codex prompts; Claude inspected read-only (settings, an existing Claude chat's composer default).
- **Interactive Project Browser ("Open Browser")** — spawns host browser processes; avoided on production host.
- **Agent/Project deletion, archival, import/export, preset management** — destructive or org-mutating; out of scope.
- **Web push notifications** — requires OS-level permission on the reviewing machine; only in-app inbox tested.
- **Multi-week retention/pagination depth** (beyond one Load-Older page), **concurrent multi-operator use**, and **run cancellation mid-flight** (no long-running production-safe run available; runs completed in ≤70s) — would need dedicated staging exercises.
- `/usage` slash command (provider-advertised variant) — not advertised by the fresh Codex session tested; Provider Activity page covers the need.

## 18. Evidence appendix

Screenshots in `~/Desktop/ponderosa-ui-review-evidence-2026-07-25/` (desktop @2x unless noted). Key routes visited: `/`, `/messages`, `/projects`, `/chats`, `/agents`, `/triggers`, `/wiki`, `/settings/providers`, `/usage`, `/new?kind=project`, project/chat/agent/review routes for the qualification project (`40c497a7-…`) and Minecraft AI Builder (`2ffa3e75-…`).

| File | What it shows | ~Time |
|---|---|---|
| 01–06 | Home, sidebar sections, All Projects/Agents/Triggers collections | 07:40–07:45 |
| 07–11 | All Messages: feed, anchoring, selection, Mention→composer | 07:45–07:50 |
| 08/08b | Synthetic-scroll phantom-space anomaly (see §13) | 07:47 |
| 12–15 | Create New flow, provider select, project created | 07:52–07:55 |
| 16–19 | First run live, response, follow-up trap, `#` autocomplete | 07:55–07:58 |
| 20–21 | Notification panel; click-through deep link with highlight | 07:58 |
| 22–28 | File task: chat Agents tab, agent detail, Activity, Files & Results, empty git review, inline diff | 08:00–08:04 |
| 29–31 | Manager task, org hierarchy, Team Chat feed | 08:05–08:07 |
| 32–35 | Decision: chat prose, inbox card, resolution | 08:08–08:10 |
| 36–38 | Minecraft AI Builder project, mature chat, Load Older | 08:12–08:15 |
| 39–44 | Settings/providers, slash menu, /status error, global search, wiki, tab context menu | 08:15–08:20 |
| 45–50 | Mobile: home, drawer, chat top/bottom, Messages, notifications | 08:20–08:24 |
| 51–53 | Wheel-scroll retest, Provider Activity, Messages send loop | 08:24–08:27 |

*Direct observations are stated as such throughout; the only inferences are labeled (§13 synthetic-anomaly causation, §8 short-run status lag).*
