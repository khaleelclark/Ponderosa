# PR #605 follow-up: Chat-folder notification indicators

Base for this follow-up: `5f196ff898d6ec98290ddd061653dd9cfd94fda9`.
This is an additional change after the previously approved heads; earlier approval does not cover this diff or the Decision-recipient follow-up.
Do not merge or deploy without renewed authorization and review.

## Behavior

- Chat folder headings display aggregate notification indicators whether collapsed or expanded, matching child Chat rows: a red important-unread count and an ordinary-unread dot. The folder's Chat count remains separate. Counts are accessible and not hover-only.
- The existing server notification projection calculates exact counts using canonical notification identities, not the loaded sidebar directory or the bounded notification-feed page. A notice projected into two Chats in the same folder counts once.
- Folder membership supplies presentation scopes only. It does not change notification ownership, permissions, routing, read/dismiss behavior, or runtime work. Project-level operational notices with Chat navigation destinations remain Project-level.
- Muting, read/dismiss state and historical acknowledgement rules use the same existing canonical projection logic as child Chats.
- The query key includes normalized folder IDs and membership, not expansion/star/order preferences. Moving a Chat recalculates both folders; expansion does not trigger another count fetch. Loading/failure are unknown rather than false-zero states.

## Bounds

The optional projection request field `chatFolders` accepts at most 200 unique groups and 10,000 total member IDs per request (matching the existing overall preference membership ceiling). Folder membership is never split across pages, so deduplication remains exact. The sidebar batches groups and existing resource IDs with at most two requests per projection fetch and stops scheduling remaining pages on failure or cancellation. Initial folder fetching waits for the first visible Chat-directory page (or its error), preventing a superseded empty-directory batch. No Chat collection or polling was added.

## Verification

The isolated browser fixture uses the real `WorkspaceSidebar`/`ChatFolders`, the real notification projection HTTP handler and real stores. Chat-directory responses and preference persistence are controlled fixtures; read/dismiss mutations are applied directly to the disposable store followed by normal query invalidation. This is not a live managed-Agent or physical-phone qualification.

- Before the fix, the fixture reproduced a Newleaf unread badge disappearing from view when Apps collapsed at 320, 390 and 1440px.
- `apps/server/test/chat-folder-notifications.test.mjs` verifies exact counts beyond the notification-feed page, shared-notice deduplication, muted/read/dismissed notices, membership changes, reopening, canonical Chat ownership, legacy requests and admission boundaries.
- `apps/web/test/chat-folder-notifications-browser.check.mjs` covers collapsed/expanded headings, unread update and action indicators, unloaded members, updates after read/dismiss/new notices, moving membership, search, hover/keyboard behavior and narrow-layout containment.
- A 401-folder case verifies three bounded pages, at most two in flight, no count refetch on expansion, stopping further pages on failure, and honest loading/initial-query failure states.

Run with Node 24, `PONDEROSA_PLAYWRIGHT_PATH` set to Playwright and `PONDEROSA_CHROMIUM_PATH` set to Chrome. Use `PONDEROSA_BROWSER_TYPE=webkit` for the local WebKit fixture. Build server/core/agents first. Full `pnpm verify` and `git diff --check` are required before handoff.
