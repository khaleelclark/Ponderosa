# Reply destination durability regression

Run from `apps/web`, using the existing Playwright installation (no new dependency):

```sh
pnpm exec rsbuild dev -c test/reply-destination/rsbuild.config.ts
PLAYWRIGHT_PACKAGE=/path/to/package.json CHROMIUM_PATH=/path/to/chromium node test/reply-destination/browser.mjs
```

The fixture runs the actual Composer on loopback port 21845. All API calls are intercepted; durable draft reads/writes are emulated in memory with revision checks. No real Project, Agent, or message is created.

Twelve scenarios cover normal continuation, target loss/restoration, same/different Agent responses while typing, explicit mention insertion, local reload, unavailable recipient blocking, rename/handle reuse, durable reload, durable rename/handle reuse, and a response arriving before send acknowledgement. Submitted stable Agent IDs are asserted, not merely visible labels. A background response must not steal focus from another control.

Before the fix, target loss and local reload submitted plain text without mention bindings, and another Agent's response changed the submitted recipient. The new behavior retains the original token and binding; unavailable recipients fail closed through the existing validation.

The product change seeds a normal structural mention into an empty draft. It never rewrites a nonempty Project draft in response to a continuation update. Existing draft text/binding persistence and stale-recipient checks are reused. There is no new draft store, routing mode, or chip styling.

An old draft that already lost its target cannot safely have that recipient guessed retroactively; choose the recipient explicitly once for that draft.


Draft navigation regression (same fixture/server):

```sh
PLAYWRIGHT_PACKAGE=/path/to/package.json CHROMIUM_PATH=/path/to/chromium node test/reply-destination/draft-navigation-browser.mjs
```

This runs the actual Composer through edit → immediate Settings/unmount → return,
then verifies send → navigate → return cannot resurrect sent text. A competing
revision must keep the other browser's saved text and expose the existing draft
conflict recovery UI. All API calls are intercepted; no live data is changed.
The text recovery unit checks also cover identical visible text with changed
mention bindings and acknowledgements from an abandoned surface.

The delayed-empty-save case holds the response to an accepted empty autosave,
types new work, then reloads before acknowledgement or the next debounce. The
new text must remain in explicit conflict recovery against the accepted empty
draft. A newer empty revision alone does not prove that this later text was sent.
