# Pinecone standalone product

This build opens the existing V4 conversation at `/`. It uses Branch
`0356095a-8d73-4249-b39d-883b978ae119`, Project
`bc94178c-d588-5d5b-a0f6-d409fe773606`, and Chat
`1982c3cc-702b-5f2b-aab9-76abe3f5c277`. The existing binding selects the
spokesperson; the UI checks that the Agent is an active persistent member of
that Branch. It creates no installation, Agent, conversation, or history store.

The root entry explicitly selects the existing Branches API namespace. Ordinary
Ponderosa routes retain their existing namespace. Optional advanced navigation
loads the existing Branches workspace on the same origin, rather than the old
Mac LAN address. Existing V3/V5 comparison URLs retain their previous surface.

The conversation keeps the original V4 appearance, idempotent sends, delivery
receipts, and draft recovery. Earlier messages now load in place from canonical
history pages, with overlapping pages deduplicated and reading position retained.
Connection and loading failures offer retry without replacing loaded conversation
data. The call button binds the existing native browser call surface to the same
spokesperson and Chat; opening or closing the surface sends nothing.

## Build and checks

Use Node 24 and the repository's pinned pnpm version. In a fresh worktree:

```sh
pnpm install --offline --frozen-lockfile
pnpm --filter @ponderosa/core build
pnpm --filter @ponderosa/native-host build
pnpm -r --filter @ponderosa/engines --filter @ponderosa/agents build
pnpm --filter @ponderosa/web typecheck
pnpm --filter @ponderosa/web build:pinecone
```

The standalone output is `apps/web/dist/pinecone`. The existing
`build-candidate.mjs` uses the same configuration and retains its
`PINECONE_UI_DIST` output override. Building does not deploy or restart anything.

```sh
node --test experiments/pinecone-shadow/standalone.test.mjs
PONDEROSA_PLAYWRIGHT_PATH=/path/to/existing/playwright/index.mjs \
PONDEROSA_CHROMIUM_PATH=/path/to/existing/chromium \
pnpm --filter @ponderosa/web test:pinecone
```

The browser check serves only the built static files on a temporary loopback
port and intercepts every API request. It checks six screen sizes, keyboard
overlay layout, earlier-history retry and scroll anchoring, empty/error/retry
states, separate repeated sends, uncertain-send reload/retry identity, retained
drafts, and call open/end without a send. Its messages and receipts are synthetic.
It performs zero real provider calls or live application writes. It does not
prove real-provider chat, SSE recovery, memory retrieval, or audible voice.

`standalone-live-readonly.check.mjs` separately checks the built root entry
against an explicitly selected already-running `PINECONE_READONLY_BACKEND`.
It serves static files on a temporary loopback port, forwards only GET/HEAD,
blocks every write, and verifies that an actual existing canonical reply ID
renders in the V4 conversation. It never sends a message or starts a call.

## Acceptance still required

Pinecone launch requires **both memory and working voice calls**. This change is
a reviewable product slice and does not establish launch readiness.

- The existing memory controls/semantic work needs verified integration and
  cross-session retrieval, correction, forgetting, stale-result suppression, and
  scope-isolation qualification. No alternate memory layer is introduced here.
- The native call surface still needs the separately audited streaming/prompt
  repair integration and actual ordering, cancellation, fallback, final-message,
  and latency qualification. The prior 120-second no-reply result is not success.
- The approved tailnet entry uses HTTP. Existing browser microphone code requires
  a secure context. No HTTPS endpoint, permission, authentication, or exposure
  changes are made here.
- The existing private preview proxy accepts only its current scoped chat/check/
  trigger mutations. Its policy rejects the native call's multi-agent DM path
  and memory commands. A deployment must receive a reviewed, precisely scoped
  integration decision; a visible call button does not change this restriction.
- Live provider tests require the coordinator's reserved identities and message/
  call counts. Physical microphone/audio and mobile keyboard checks remain open.

The V4 texting document records historical deployment evidence. Its paused
schedule descriptions are historical: read-only verification on 2026-10-16 found
V4 enabled at 600,000 ms with the correct shared assistant workspace. This source
change does not alter V3/V4/V5 schedules, prompts, configuration, or canonical
data, and does not replay any failed or outcome-unknown work.
