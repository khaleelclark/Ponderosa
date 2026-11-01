# Owned UI qualification

This successor adds qualification tools, not product permission or admission changes.
`tests/shared/ui-load-fixture.mjs` creates disposable canonical Core/Branches data,
10,000 shared messages per product and 20 idle Agents. It verifies ordered seed
text hashes and configures concurrency20 through the normal human preferences
API. Passing an empty resource-observation option selects the real server sampler;
it does not use the shared fixture's synthetic8GiB default. Real host/ancestor
cgroup headroom and pressure must permit twenty under unchanged resource defaults.

Activation starts twenty controlled providers that repeatedly call the actual
workspace-projects tool and emit text progress every two seconds. Canonical
running Run IDs, live owned roots and advancing provider checkpoints are required;
queued Agents and holding inert children alone do not qualify. Lifecycle records
preserve samples and each checkpoint. Deactivation completes Runs, closes owned
roots and observes fixture cleanup. Synthetic seed text contains no user data.

`tests/workspace-navigation/active-load-qualification.mjs` defaults to a small proof:
one fresh context per Core/Branches x desktop/phone, four total. Phone uses360x640,
DPR1.75/mobile/touch and CDP4x CPU; desktop1365x768/DPR1. Raw in-page EventTiming and
LCP observers install before navigation. Interaction grouping is session-local;
pooled p75 uses nearest rank, never automation elapsed time or an average of
session percentiles. Unsupported/missing observations refuse success. Every
started session, errors, raw event entries, before/after progress and video remain.
This is an explicit fixed profile matching the proposed mobile settings; no
installed Lighthouse version or native iOS claim is implied.

Full mode would run eight fresh contexts per cell (32total), but must not run until
independent METHOD review is integrated. Its env requires a method-receipt path;
that alone is not approval. The proof driver measures typing, scrolling
and search; full mode additionally selects an Agent, renames and sends a short
message. That full interaction branch is unexecuted and observer completeness
conditions must be reconciled with that review before treating full mode as ready.
No full32pass or performance threshold pass follows from proof completion.

Execution (existing dependencies/builds only, owned offline sandbox):

- `node --import ./tests/shared/workspace-resolution.mjs --test tests/workspace-navigation/event-timing-observer.test.mjs`
- `PONDEROSA_LOAD_EVIDENCE=<owned> node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/active-load-qualification.mjs`
- `PONDEROSA_A11Y_EVIDENCE=<owned> AXE_CORE_PATH=<installed> node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/current-accessibility-matrix.mjs`

The accessibility driver uses four actual routes (Core/Branches/Assistant/output),
both themes and native browser100/200/400% zoom via installed Xvfb/xdotool. It
records actual DPR, CSS viewport/font, keyboard Tab/Enter send, browser CDP
composition and dispatched composing Enter guard, complete axe arrays, screenshots
and errors. CDP composition/dispatched keys do not certify a native OS IME. It
fails on critical axe findings and retains serious/moderate findings. Whole-page
width alone cannot certify all vertical content, overlap or reader comfort.

Reader feasibility requires checking PATH, OS package/runtime and session bus,
not assuming a physical-device blocker. Installed AT-SPI service executables
alone are not a reader. No software installation or borrowed browser/credentials
is authorized. Actual reader tasks and native IME remain separately qualified.
The broader committed `ui-acceptance-remaining.md` still names comparator/blind
panel and all output/Assistant build-list gates. Source/built output identity and
all normal cleanup exits must accompany any result.

`timing-observer-smoke.mjs` independently checks actual in-page timing capture on
the real unloaded app at the same4x mobile profile when active-load capacity is
refused. Its result explicitly records zero active Agents and is never load
acceptance. Set PONDEROSA_OBSERVER_EVIDENCE to an owned directory.

## Mounted landmark correction

The current four-surface matrix reproduced moderate missing-main/uncontained
content findings in Assistant/output and repeated named landmark regions for
inline Run receipts. Standalone output now owns one main landmark. Run receipts
are articles in both presentations, so a timeline of independent work records
does not flood landmark navigation with identically named regions. Their labels,
IDs, focus targets and activity controls remain. Targeted replay can set
PONDEROSA_A11Y_ZOOMS=1 and PONDEROSA_ASSERT_LANDMARK_REPAIR=1 to check all four
surfaces/themes against those exact axe rules and one-main semantics; that
eight-cell replay does not replace the retained native zoom matrix.
