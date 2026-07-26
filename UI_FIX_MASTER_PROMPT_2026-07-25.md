# Ponderosa UI Fix Series — Master Implementation Prompt

You are a coding agent working in the Ponderosa repository. You have no other context; this document is self-contained. It defines seven pull requests, in order, that fix user-experience defects confirmed by a 2026-07-25 production review and ratified by a cross-reviewer. Behavior specifications here are final — do not redesign, do not expand scope.

## What Ponderosa is (minimum context)

Ponderosa is a self-hosted web workbench (React + MUI + Rsbuild in `apps/web`, Fastify server in `apps/server`, shared types in `packages/core`) where a human operator runs organizations of AI agents through Codex/Claude subscriptions. Key vocabulary:

- **Project** — a workspace. **Chat** — a project conversation surface with subtabs Chat / Team Chat / Agents. **Agent** — a persistent worker with its own detail page (Chat / Activity / Triggers / Files & Results / Settings). **Run** — one scheduled execution. **Decision** — a blocking question from an agent that the operator answers by choosing an option. **All Messages** (`/messages`) — cross-project feed of everything sent to or from the operator.
- Sending an untargeted message in a Chat **starts a brand-new agent**. Typing `#Agent-Handle` targets an existing agent. **This is intentional product design.**
- The operator's internal routing handle is `#pto`. Agents' handles are derived from their titles (`#Cape-Cod`).

## Ground rules (non-negotiable)

1. Read `AGENTS.md` at the repo root before any change and follow it. In particular: never commit to `master`; one branch + PR per work item below; report exact head commits and verification performed.
2. **Line numbers in this document are approximate** (the repo moves fast). Locate code by the symbol names given, with grep. If a named symbol does not exist, stop and report — do not improvise a replacement.
3. **Product contracts you must not violate, even if a change seems helpful:**
   - Untargeted Chat messages start a fresh agent. Never reroute them to a previous agent.
   - Never infer a message's target agent from prose content.
   - UI views are projections of canonical server state. Never fabricate chat messages client-side; anything appearing in a conversation timeline must come from the server's canonical record.
   - Handles (`#Cape-Cod`, `#pto`) must remain present in *copied* message text. Display-layer changes only.
   - Do not add providers, API keys, WebSockets, SSR, or new state stores.
4. Verification baseline for every PR: `pnpm --filter @ponderosa/core build && pnpm --filter @ponderosa/agents build && pnpm --filter @ponderosa/engines build && pnpm --filter server build && pnpm --filter web build` (or the repo's equivalent scripts), plus TypeScript typecheck and the manual checks listed per PR. Screenshot desktop (1440×900) and mobile (390×844) for any visual change.
5. Ordering: **PR-1 → PR-7 in sequence.** PR-2 and PR-5 and PR-6 touch only `apps/web` and may run in parallel with each other, but never two writers on the same file. PR-1, PR-3, and PR-7 each touch `apps/server/src/app.ts` — those three must be strictly serial.

---

## PR-1 · Inline Decisions in the conversation + correct attention copy

**Problem observed in production:** when an agent creates a Decision, the originating Chat shows only prose ("Please answer the Decision to choose Option A or Option B"). The actionable card (options + "Review Work Details") exists only in the notification inbox. The inbox header says "You're all caught up" even while an urgent Decision pends. After answering, the chosen option never appears in the conversation — the transcript shows the agent's confirmation of an answer the reader never saw.

**Desired behavior:**
- The Decision card renders inline in the originating Chat timeline (and in All Messages) at its message position, using the existing card component, actionable in place.
- Answering from any surface resolves it everywhere (state is already server-canonical).
- The chosen option appears in the conversation as an operator-authored message, sourced from the server's canonical record — the global-search index already shows `#user You chose Option A.`, so the record exists; render it, do not invent it.
- Any header/summary ("You're all caught up") must not display while an unresolved Decision or urgent item exists; show e.g. "1 item needs your decision".

**Where the code is:**
- Card + actions: `apps/web/src/components/decisions/DecisionCard.tsx`, `DecisionActions.tsx`, `DecisionResponseDialog.tsx`; answer flow hook `apps/web/src/hooks/useDecisionResponse.ts`; inbox rendering `apps/web/src/components/AttentionSurface.tsx` and `NotificationPanel.tsx`.
- Conversation rendering: `apps/web/src/components/chat/ChatMessages.tsx`, `ConversationView.tsx`; All Messages feed: `apps/web/src/components/AllChatView.tsx`.
- "Caught up" strings: `NotificationPanel.tsx` (unreadCount ternary, ~line 231) and `GlobalChatSearch.tsx` (~line 314).
- Server: find how decision state reaches conversations — grep `decision` in `apps/server/src/app.ts` and `packages/core/src/dto.ts` (`WorkspaceNotificationDto` has `kind: "decision"`). If the conversation payload does not currently include pending-decision data, extend the existing conversation DTO/endpoint; do not create a parallel fetch path.

**Steps:** (a) surface pending/resolved Decision data in the conversation message stream (server first if needed); (b) render `DecisionCard` inline in `ChatMessages` for those entries, wired to `useDecisionResponse`; (c) render the resolved choice as an operator message from canonical data; (d) fix both "caught up" strings to account for unresolved decisions/urgent items; (e) keep the inbox card working unchanged.

**Invariants:** one Decision = one card everywhere, always consistent; answering twice is impossible (respect existing idempotency); no client-fabricated messages.
**Acceptance:** create a Decision via a test agent ("Use Ponderosa's Decision capability to ask me to choose between Option A and Option B"); card visible and answerable in Chat, Messages, and inbox; answer echoes as an operator message; agent continues; "caught up" never shows while it pends.

---

## PR-2 · Clearable reply target in All Messages

**Problem:** on `/messages`, selecting an agent message and clicking its Mention action opens a bottom composer targeting that agent ("Message Cape Cod"). There is no way to clear the target: Escape does nothing, re-clicking Mention does nothing, no ×. The target persists even after sending. Misdirected-send risk.

**Where:** `apps/web/src/components/AllChatView.tsx` — target state is `selected` / `selected.directMessageAgent` (~line 157). Mention buttons carry aria-label `Mention <Agent>`.

**Steps:** (a) render the current target as a visible chip above the composer with an × that clears `selected` and hides/disables the composer; (b) Escape (when composer focused or panel active) clears it; (c) clicking the same message's Mention action again toggles it off; (d) selecting a different agent's Mention switches the chip.

**Invariants:** clearing must not discard typed draft text silently — keep the draft if the user re-targets; user-authored messages still expose no Mention action.
**Acceptance:** select → chip appears; ×, Escape, and re-click each clear it; switching targets re-labels chip and placeholder; send still works and the reply arrives in-feed.

---

## PR-3 · Read-on-view for ordinary message notifications

**Problem:** reading a message in All Messages leaves its notification unread; the bell badge stays stale, training users to ignore it.

**Scope rule (ratified):** only **ordinary message** notifications become read on view. Decisions, blockers, and operational issues stay unread until actually resolved — viewing is not acting.

**Where:** server endpoints exist: `POST /api/notifications/read` (all) and `POST /api/conversations/:id/notifications/read` (per-conversation) in `apps/server/src/app.ts` (~13091, ~13110); client wrappers in `apps/web/src/api/real.ts` (`markAllNotificationsRead`, `clearConversationNotifications`). Notification kinds live in `packages/core/src/dto.ts` (`WorkspaceNotificationDto.kind`, includes `"decision"`, `"operational"`). Grep `notificationKindForCommunication` in `app.ts` for kind derivation.

**Steps:** (a) add a kind-scoped read path — either a body/query filter on the existing endpoints or a narrow new endpoint that marks only message-kind notifications for given message/conversation ids (prefer extending the existing conversation-scoped endpoint with a kind filter); (b) in the All Messages view and in Chat, when a message is actually rendered in the viewport (IntersectionObserver or the existing visibility tracking if present — grep `notifications/read` callers), call it for the corresponding messages; (c) badge count updates via the existing notifications query invalidation.

**Invariants:** decision/operational/blocker notifications must be provably unaffected (test both kinds); no read-marking from background tabs or prefetch.
**Acceptance:** with an unread message notification, opening `/messages` and seeing the message clears it (badge decrements); a pending Decision notification survives viewing and clears only when answered.

---

## PR-4 · Explicit New-Agent vs existing-Agent composer destination

**Problem:** the composer's only hint about the fresh-agent contract is one line of placeholder microcopy. In production, a follow-up was answered by a brand-new agent saying "I have no previous reply to repeat," two messages under the reply it denied. The contract is intentional; its communication is the defect.

**Ratified design — implement exactly this, nothing else:**
- A persistent **"New Agent"** destination chip on the Chat composer whenever the message has no `#target`.
- After an agent responds in the chat, a visible **"Continue with <Agent>"** affordance; selecting it replaces the New Agent chip with a removable `#<Agent-Handle>` chip (equivalent to typing the handle).
- Helper state near the send button always reads either **"A new Agent will respond"** or **"<Agent> will receive this."**
- Typing `#handle` manually keeps working and drives the same chip state. Removing the chip reverts to New Agent.
- **Never infer the target from prose. Do not change routing behavior at all** — this PR is presentation + one-click convenience for an existing mechanism.

**Where:** `apps/web/src/components/chat/Composer.tsx` (~840 lines), `composerContracts.ts`, `composerUtils.ts`, mention/autocomplete logic in `apps/web/src/mentions.ts`; last-responder identity is available from the conversation messages already rendered (agent-authored messages carry the agent id — grep the message DTO in `packages/core/src/dto.ts`).

**Invariants:** the chip must round-trip with typed text (typing `#Cape-Cod` shows the chip; deleting the chip removes the handle from the outgoing message); `#broadcast`/`#everyone` keep current behavior; Agent-detail and Messages composers (which are always targeted) show their fixed recipient in the helper state but get no New Agent chip.
**Acceptance:** fresh chat shows "New Agent" chip + "A new Agent will respond"; after a reply, "Continue with X" appears; selecting it targets X (verified by the reply coming from X); removing the chip reverts; prose like "reply to Cape Cod please" with no `#` still goes to a new agent.

---

## PR-5 · Non-Git "Review All" opens the recorded changed-file view

**Problem:** Agent Activity shows "1 changed file +2 −0 · Review All", but for Projects on the default **Private Empty Workspace** (not a git repo) the Review All button opens `/projects/:id/reviews/:agentId` which renders "0 changes — This working folder is not a Git repository." The inline expander on the same Activity row correctly lists the change with Preview/Download — the data exists; the button targets the wrong surface.

**Where:** the button is the `onViewAll` prop rendered in `apps/web/src/components/activity/ActivityPane.tsx` (~line 174); its destination is wired by the callers — grep `onViewAll` in `apps/web/src/components/AgentDetail.tsx` and `ProjectShell.tsx`. The git review surface is `apps/web/src/components/files/WorkspaceReviewPane.tsx`; the recorded changed-files data is what the inline expander and the agent `changedFiles` history stream render (grep `getChangedFilePage` / `changed-file` in `apps/web/src/api/real.ts`).

**Steps:** (a) determine git-ness of the project workspace from existing data (the review pane already knows — grep the "not a Git repository" string for the flag/endpoint it uses; expose that check to the caller rather than duplicating it); (b) when non-git, route Review All to the recorded changed-files view for that agent/run (the surface behind the inline expander), preserving run scoping; (c) when git, keep current behavior exactly.

**Invariants:** no change to git-backed projects; the changed-files data source stays the canonical recorded file events (do not read the filesystem directly).
**Acceptance:** in a Private-Empty-Workspace project, have an agent create one file; Review All lands on a view showing that file with its +N −N and preview; in a git-backed project (e.g. any existing production project), behavior is unchanged.

---

## PR-6 · Resource-named workspace tabs + notification navigation opens a new tab

**Problem A:** workspace tabs show generic view names — every open project reads "Project Overview" (only the aria-label contains the project name). Two open projects are visually indistinguishable.
**Problem B:** clicking a notification navigates the *active* tab away to the target chat, destroying the user's current context instead of opening a background/new tab.

**Where:** tab model in `apps/web/src/workspaceTabs.ts` (tabs already support an optional `title`, see `renameWorkspaceTab`, ~line 153; restore/serialize logic caps at 80 chars); tab labels render in `apps/web/src/components/WorkspaceTabs.tsx`; notification click-through handler lives in `apps/web/src/App.tsx` (grep the notification-panel `onNavigate`/selection wiring); background-open already exists as `openWorkspaceTabInBackground` in `workspaceTabs.ts`.

**Steps:** (a) when a tab's route resolves to a named resource (project, chat, agent), set the tab `title` to the resource name — hook wherever the aria-label already gets "… in Devoria" so both stay in sync; singleton views (Home, All Messages, Wiki, Settings) keep their view names; (b) route notification clicks through the existing new-tab/background-open path (or push the current route to history so Back restores it — prefer the new-tab path since it exists); (c) keep tab titles stable across reload via the existing serialization.

**Invariants:** tab persistence format stays backward-compatible with stored sessions (the restore parser validates `title` already — do not change the schema); renamed-by-user tabs (via `renameWorkspaceTab`) are never overwritten by auto-titles.
**Acceptance:** open two projects → tabs show the two project names; click a notification while on a chat tab → the chat tab survives and the target opens in its own tab; reload → titles persist.

---

## PR-7 · Cleanup batch (naming, Team Chat noise, routing display, wiki, deep links, mobile timestamps, a11y)

Seven small, independent items — one branch, reviewable commits per item.

1. **Agent name pool curation.** `apps/web/src/agent-names.json` (423 entries, loaded by `apps/web/src/parkNames.ts`, which states the JSON is the customization point). Remove memorials, residences, and multi-word institutional names (e.g. "Medgar and Myrlie Evers Home", "Thomas Jefferson Memorial", "Lincoln Memorial"); keep short, neutral nature/place names (Cape Cod, Saratoga). Target ≥150 remaining names; no other logic changes.
2. **Chat title generation.** Server-side: `conciseConversationTitle` (~`app.ts:1708`) and `semanticConversationTitle` (~`app.ts:1726`, used at ~`:3049`). Current output is stopword-stripped keyword mash ("User Sorry Patrick Previous"). Change to: derive from the operator's *request* text (not the agent's answer), keep articles/natural word order, cap at ~5 words / 48 chars ("Fix sidebar collapse", "Two bullet points about this Project"). Also drop or truncate the `Recent: <title>` suffix in project rows (grep `Recent:` in `apps/web/src/components/WorkspaceOverview.tsx`).
3. **Team Chat lifecycle noise.** In the Team Chat feed, consecutive duplicate lifecycle events render repeatedly (observed: "received every result it was waiting for" ×3; queued/finished pairs for every micro-run). Find the renderer by grepping the literal string `has work queued` / `received every result` (client component or server projection). Collapse: exact-duplicate adjacent events into one row with a ×N counter; queued→finished pairs for the same run under one per-run disclosure row. **Do not remove any event from the underlying data — display-layer collapse only; operational visibility must remain.**
4. **Routing-prefix display.** Agent replies render a literal leading `#pto ` (and agent audit chat shows `#broadcast - `). User messages already chip-render handles. Extend the same chip/label treatment to the *leading route token* of agent-authored messages (grep the message text renderer in `apps/web/src/components/chat/ChatMessages.tsx` / `ChatMessageFrame.tsx` for how user-side `#` chips are produced). **Copied text must still include the handles; in-body handles stay highlighted and untouched.**
5. **Wiki naming.** `docs/wiki/all-chat.md`: retitle "All Chat" → "All Messages" (heading + nav label + any intra-wiki references; grep `All Chat` across `docs/wiki/`). Do not rename URLs/ids unless the wiki index requires it.
6. **Chat deep links prefer the Chat subtab.** Navigating to `/projects/:id/chats/:id` currently restores the last-open subtab (e.g. Agents), hiding the conversation. Grep the chat-subtab persistence (likely `chatState.ts` or per-chat state in `ProjectShell.tsx`/`ConversationView.tsx`): on *URL-driven* navigation (fresh load or external link), default to the Chat subtab; in-app tab switching keeps remembered state.
7. **Mobile timestamps + a11y labels.** `apps/web/src/components/MessageTimestamp.tsx` already supports `mobileTimestampRevealed` — wire tap-to-reveal in the mobile message frame (grep `mobileTimestampRevealed` callers; likely `ChatMessageFrame.tsx`) so tapping a message toggles its timestamp. Also dedupe the two `aria-label="Primary navigation"` navs (rail vs drawer — grep in `App.tsx`/`WorkspaceSidebar.tsx`); rename the drawer one "Primary navigation drawer".

**Acceptance for the batch:** new agents draw from the curated pool; a fresh chat titled from a request reads naturally; the two-specialist scenario renders ≤ half its previous Team Chat rows with nothing lost behind disclosures; agent replies show a route chip instead of literal `#pto` while copy still includes it; wiki nav says All Messages; a pasted chat URL opens on the conversation; tapping a mobile message reveals its time; screen reader announces distinct nav landmarks.

---

## Definition of done for the series

- Seven merged PRs, each with: branch name, base/head commits, verification output, before/after screenshots for visual changes.
- No behavior change to: message routing, run scheduling, provider handling, canonical storage, or anything in a file this document did not name (helper extraction within named files is fine).
- If any specification here conflicts with what you find in the code, stop and report the conflict instead of choosing.
