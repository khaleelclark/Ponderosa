# Code/reply lifecycle regression

Run from `apps/web` with Node 24:

```sh
pnpm exec rsbuild dev --config test/code-reply-lifecycle/rsbuild.config.ts
PLAYWRIGHT_PACKAGE=/path/to/package.json CHROMIUM_PATH=/path/to/chromium node test/code-reply-lifecycle/browser.mjs
```

The fixture uses the real message renderer and Composer on loopback port 21847. API calls are intercepted; no real messages, drafts, Projects, or providers are used. Stop the fixture server afterward.

## Findings and qualification

Base: `bf39bf764c0050443345211da321ea5a8187ab5c`.

On the base, four parent rerenders produced eight code subtree replacements, alternating between 90.65625px plain fallback and 94.6875px highlighted content. A pending roster displayed an unavailable recipient, and a reply arriving while a draft was nonempty was consumed before it could autofill.

After this change:

- Four parent rerenders produce zero code subtree replacements and no fallback/height churn.
- A pending roster retains the authored chip and prevents sends until current identities can be validated.
- A ready roster that no longer contains the recipient still displays unavailable and blocks sending.
- A reply deferred by a nonempty draft autofills after that draft is sent.
- All 12 existing `test/reply-destination/browser.mjs` scenarios pass, including rename/handle reuse, unavailable recipients, durable draft reload, and a reply preceding acknowledgement.
- All 181 web checks, web typecheck, and full production build pass.

The Project chat now uses its existing Project Agent query for recipient bindings rather than the paginated message projection's Agent subset. No new roster store is introduced. Only successfully applied auto-destinations are marked consumed; user-authored content is not replaced. Code block component identity and the default lazy loader are stable across parent renders. Styling is unchanged.

These are isolated component/browser checks, not a live provider round trip. The exact historical event ordering in the reported screenshot was not captured.
