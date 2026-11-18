# Public feature implementation requirements

Root owns this backend lane on `phase2/root-public-features-f9f`, based on
`f9f964ff50dc064d21e3e06cf1055858037ba9ac`. This is a finite source checklist for
Bible #10/#12/#16/#30/#32 and the Output/Assistant/Inbox Build requirements. It is
not a whole-Bible verdict. Runtime continuation, provider adapters, portability
carriers and web components remain with their respective owners.

| Required behavior | Current source disposition | Remaining action |
| --- | --- | --- |
| Discover all currently authorized workspace Chats and Agents | `routes/agent-workspace.ts` and the shared `managed-tools.ts` declaration now provide an independently usable per-Chat Agent cursor, stable ID ordering and explicit continuation metadata, preserving current visibility and pending/custody exclusions. | Independent review; execution remains deferred. |
| Relay the accepted task without changing authored text | The shared workspace input validator now preserves task whitespace while retaining nonempty/byte validation and identifier normalization. The existing receipt, relay and tracked Request consume that same text. | Independent review; execution deferred. |
| Let an outside application read large Join results | `BranchesClient.resultBundle` now reaches the existing execution-scoped public route and returns exact content/hash. No arbitrary input substitution or new runtime authority. | Independent review; execution deferred. |
| Expose existing Output and Assistant controls to public clients | `designateOutput` and `configureAssistant` now call the existing server controls; `moveSpeaker`, schedule, status and Agent settings already have public paths. | Independent review; execution and web acceptance deferred. |
| Explicitly export nonsecret parameter values | The public client's existing export call now accepts `includeValues:true`, preserving default omission, file selections and server secret rules. | Independent review; recreation/round-trip execution deferred. |
| Publish graphs, loops, conditions, routes, fork/Join/Map and Call subgraphs through public interfaces | `BranchDefinition`, the existing publisher/store and `BranchesClient` expose these operations. This trace established no new independent graph-publisher omission. | Runtime owner completes its separate retained-value/continuation checklist. Comparator execution remains required. |
| Preserve application state and declared reductions | `branch-definition.ts` and `branch-shared-state.ts` provide bounded JSON channels and sum/append/replace folds; public shared-state GET and client already exist. | Parallel settlement order differs from comparator supersteps. Arbitrary reducer callbacks, message-ID edits and implicit cross-Call state are not established by these source paths; full parity is unqualified. |
| Expose human gates, current output streams, configured tools/memory and multi-agent execution | Existing public gate, Agent/workspace streams, managed Agent bindings and unified local-memory tool catalog remain in use. No new engine or grant layer is needed for these named operations. | Native capability completeness, interruption/reconnect behavior and comparative runtime qualification remain separate. |
| Automatically create Assistant; preserve one speaker, editable workflow/model and configurable ten-minute checks | `output-agent-apps.ts`, existing routes and `routes/agent-workspace.ts` retain durable setup, collision review, current authority, report cursor and notification paths. No new independent backend omission was established in this trace. | Actual fresh setup, model changes, scheduled reports, notification behavior and recovery remain unqualified. |
| Provide Output/Assistant chat, attachments, voice/calls and everyday settings; rename Inbox | Shared web/native components and existing Inbox public paths are owned by the UI/native lanes. Root does not substitute documentation or a new backend shell for their required behavior. | Integrate their reviewed releases and then perform combined validation. Visual/streaming/call latency and blind judging remain open. |

Only source reading, implementation and Git metadata/hash/whitespace checks are
permitted in this tranche. No tests, test preparation, fixtures, build, typecheck,
product/native/provider/browser/database execution or deployment ran for this
candidate. Existing test descriptions in older guides are historical evidence,
not validation of these changes. Missing saved proof and unknown external effects
remain held; public read/control wrappers do not create missing evidence.
