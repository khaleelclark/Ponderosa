# FAST0.2 portable browser loader correction

This bounded stage follows clean released UX/API head
`9afdf1f2cbf21effa5372c693af99bf3fd599925`, preserving 821 -> e759 -> ad3d ->
UX ancestry. PR623 remains draft. Writer qualification does not establish native
platform, provider, security or whole-integration approval.

Both voice recovery and the inherited request-storm runner convert the default
createRequire.resolve filename with pathToFileURL(...).href before dynamic import.
The explicit PONDEROSA_PLAYWRIGHT_PATH override remains verbatim and short-circuits
resolution. Chromium namespace fallback and frozen dependency/pins remain.
Output creation and module loading are inside cleanup scope; absent output after
mkdtemp failure is guarded, and module failure removes any created directory.
No browser harness phases, timeout, thresholds, caches or security options changed.

Native-beta invokes the mandatory recovery runner without a module override.
The inherited storm runner is invoked by Verify on Ubuntu, and is not currently
an additional native-beta browser step. Its identical default-resolution and early
cleanup cause is corrected narrowly, without broad harness refactoring or claiming
native storm execution. No workflow dispatch or new native proof was performed.

The checked-in six-test regression extracts the default import expression from
both actual runners. It simulates Windows standard-library filename conversion
for a real drive-qualified resolved pathname, checks the file URL, demonstrates
that the old native filename is rejected by Node24's ESM loader, loads the actual
frozen dependency using the new expression, and tests a data-URL explicit override.
Separate disposable child processes prove missing-module output cleanup and
mkdtemp failure preservation without launching Chromium. All6pass on Linux.
Against immutable reviewed e759, expected-behavior tests fail4/6 for the two loader
and two cleanup causes; both explicit-override controls still pass. This is source
and Node loader proof; actual Windows/macOS execution remains UNTESTED.

The prior CI evidence document now accurately states that frozen Playwright1.63
sets chromiumSandbox:false by default and adds --no-sandbox even for args:[].
Actual child spawn arguments with empty explicit args were independently observed
again in this stage's disposable oracle, then root exit and group absence checked.
The old immutable published CI handoff's claim that non-Linux jobs retain sandboxing
is expressly CORRECTED by this handoff/document; the old artifact is preserved.
No launch option, host security/helper setup, provider profile or platform policy
was changed. Disposable synthetic Chromium evidence is not native security proof.

The original synthetic latency interval remains fetch-to-headers, all query samples
remain recorded, cache:no-store/body validation and deterministic identical-URL
barrier stay unchanged. The current oracle passes with no-store, rejects forced
old cache policy with503, and rejects corrupt bodies after retaining header samples.
The required11-file regular/nonempty guard, all28runtime recovery tests, both
speech/voice suites and active Verify/recovery/native workflows are preserved.
Final recovery passes28/28runtime tests and both browser suites. The single unchanged complete storm FAILED at APIp95 287.1ms (strict<250ms),1603samples,queuep95 251.6ms,request-to-headersp95 3.8ms;overlap oracle passed. No rerun or waiver. Full pnpm verify passes exit0:1604total/1596passed/8existing skips/0failed or canceled;types,production builds,bundle budgets pass. Exact-head CI results
are recorded in the standalone handoff, with all commands/exits/failures. The direct inherited Action verifier lacked GH_TOKEN; that failure is retained. Its unchanged verifier with an actual read-only gh callback verified all6exact commit objects using the existing authorized profile, without extracting a token or changing authentication.

The prior ad3d strict APIp95<250ms failure at exactly250ms remains retained and is
not waived or reclassified by this portability stage. No retry-until-green or
threshold increase. Exact-final-head independent whole runtime/UX and CI delta
review, completed required checks and separately tracked latency disposition remain
required. Windows/macOS installed/native/ABI/artifact/checksum/provider/physical
voice/keyboard/PWA/rollback/production-scale gates, version0.2.0/notes and final
source/release approvals remain OPEN and unqualified. No merge/tag/release/deploy,
new dependencies/global installs/live subscription/operator data/delegation/user
contact or optional memory/Wildfire/Grok integration.
