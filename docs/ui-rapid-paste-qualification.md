# Rapid paste and call-label qualification

The shared composer must not insert a late reply destination after the user starts
interacting with the next draft. In particular, Select All/Delete followed by a
native paste must retain the exact pasted body. Existing and explicitly selected
routing tokens remain authored content. Lexical pending state, rather than the
update-listener cache, owns synchronous canonical-text reads.

`tests/chats/composer-pending-read.test.mjs` runs the actual getter against a queued
Lexical update and checks continuation-seeding rules after interaction. The cached
getter negative control returns an empty string for a nonempty queued document.

After sequential builds, run:

```sh
node --experimental-transform-types --import ./tests/shared/resolve-typescript.mjs --test tests/chats/composer-pending-read.test.mjs
QUALIFICATION_DIRECTORY=/tmp/ponderosa-rapid-evidence node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/webkit-rapid-paste.mjs
```

The browser harness uses a disposable real API, controlled providers, the existing
Docker image `unified-native-runtime:driver-2.1.0` with `--pull=never`, WebKitGTK
MiniBrowser and native GTK clipboard delivery. It installs nothing. It covers
Core, Branches, `/assistant` and the designated `/apps/:id` URL in both themes.
Four alternating LF/CRLF messages per route retain Unicode, an internal blank
line and a Shift+Enter tail. The next clipboard is prepared before send. There is
no post-send settlement timer or screenshot between send and the next paste;
only the submitted draft's retirement and editor availability are awaited.
Accepted delivery drains after the entire rapid sequence, before navigating away.

The oracle separately checks native payload versus trusted browser paste event,
exact draft and Shift+Enter result, exact accepted request and canonical message,
and canonical recipient IDs. WebKit may normalize CRLF to LF before the application
paste listener: that difference is retained rather than reported as raw equality.
Unexpected editor nodes fail the oracle; routing prefixes are never stripped from
a pasted draft to make equality pass. Canonical routing prefixes are checked
explicitly against the intended surface, separately from the exact authored body.

The narrow Branches call dialog check types locally without starting a call. It
captures label geometry immediately and after CSS animations finish. The light
negative control crossed the first text line during label shrink; settled light
and dark geometry was clear. Keeping `Your next turn` permanently floated avoids
that first-input transition. Both immediate and settled geometry must be clear.
No voice transport, microphone permission or real-provider call is inferred.

This is bounded WebKitGTK evidence, not Safari/iOS, a phone keyboard qualification,
a performance benchmark, a full dialog/viewport matrix or a no-flicker verdict.
Failed runs and original run9 evidence remain in the batch's external report.
