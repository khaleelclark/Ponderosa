# Integrated Assistant and shared conversation redesign

Owner: redesign_conversations, isolated `/tmp/p2-chat-redesign-20261108`, branch `redesign/integrated-assistant`, base `e45660b4d6e92e27b1ebeea53f74c4a9dbdb467d`.

Assistant now occupies the main Ponderosa workspace at `/branches?assistant=1`, with compact global navigation and an exact validated return to the current Core Chat. Core navigation places its dedicated speech/spark icon beside Inbox; the old extra Assistant row above normal dialogue is removed. The real React surface reuses the canonical designated Agent conversation without a frame, API scope flip, provider changes, or security-header changes. Standalone `/assistant` and `/apps/:agentId` remain supported. File links preserve canonical Branch/Chat/Agent ownership.

Direct conversation chrome shares a compact contact header, status, grounded composer, welcome state, readable prose and blue outgoing bubbles. Completed work receipts are omitted from simple direct replies; active work, failures, decisions and explicit audit focus retain their existing paths. Implicit recipient labels are omitted only for the verified fixed Agent; authored tags and other recipients remain visible.

## Verification

- Web typecheck and Rsbuild production build in the owner checkout.
- Three focused routing, safe-return, authored-file-owner and fixed-recipient presentation checks passed.
- `node --import ./tests/shared/workspace-resolution.mjs tests/branches/assistant-navigation-qualification.mjs` passed against a disposable real Fastify server, real security headers, owned synthetic data and inert provider.
- Desktop 1365×900 and phone-sized touch viewport 390×844: Assistant beside Inbox, 44px target, actual main-shell React, no Workflow or Agent audit tabs, exact Core return, separate Core/Assistant drafts after close/reopen, browser Back, grounded composer, readable phone title, no completed work receipt before a simple reply, no page/API errors during normal navigation. Deliberate synthetic refresh failures retain a compact Retry notice and expandable full cause.
- Continuous scene videos and actual-renderer screenshots: `/tmp/p2-chat-redesign-rendered-final4/`; `result.json` records outcomes. Earlier `/tmp/p2-chat-redesign-rendered*` captures are intermediate evidence and are not final acceptance.

## Reproduction and limits

Use Node 24.16.0 (`/opt/ponderosa-server/releases/0.1.0-beta.11-832f7cda/runtime/node`) and `QUALIFICATION_DIRECTORY=<owned path>`. Dependency metadata, native binding and dependency dist were copied from `/tmp/p2-dev-release-final-20261108-ul5v_1ys/repo`; no donor files were edited. Only web source was built here. The existing guarded call control has a shared header portal slot; Root coordinates its integration with the calls owner. The mounted check uses the normal-257 backend binaries under owned fixture state, not live private data or provider inference.

The inspected owner captures use baseline theme colors; root must validate the combined neutral/blue theme and speech/call changes. Chromium phone-size touch coverage does not qualify physical iPhone audio, Safari keyboard behavior, complete usability, or production deployment. Root owns final integration, independent visual review, consolidated checks and DEV deployment.
