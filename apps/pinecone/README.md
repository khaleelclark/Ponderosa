# Pinecone consumer application

This is an independent product build and entry point. It mounts the consumer
conversation directly and uses the existing Branches engine through its API.
It does not mount BranchesView, BranchPinecone, or a candidate-preview tab.
The legacy V4 adapter shares conversation components; it owns its own advanced
navigation. The Pinecone product exposes no Branches navigation.

V5 keeps Branch 49005cab-f4d3-4b38-a468-bf153624e4f4 and the existing bound
spokesperson, Project and Chat. The product neither installs a new experiment
nor creates a conversation/history store. Existing V3/V4 routes remain on their
previous bundle. The approved Pine entry is /pinecone at the existing exposure.

The composer displays the exact pending ordinary question it is answering.
A reply records that Decision UUID and text in the saved outgoing attempt;
retries retain the destination. Sending a new message is an explicit choice.
Approval and runtime-connection decisions are never inferred from chat prose.
The preview proxy allows only the existing V5 speaker's matching ordinary
text/choice responses; approval scopes, runtime actions and other owners fail
closed. No new connection, permission, listener or authentication mode is added.

Build with the pinned Node 24/pnpm runtime and the frozen offline lockfile:

    pnpm --filter @ponderosa/core build
    pnpm --filter @ponderosa/pinecone test
    pnpm --filter @ponderosa/pinecone typecheck
    pnpm --filter @ponderosa/web typecheck
    pnpm --filter @ponderosa/pinecone build

The deployment wrapper and static/decision guards live in
experiments/pinecone-shadow/pine-v5-service.mjs and pinecone-product-proxy.ts.
Only the experiment service is cut over after a canonical deployment drain and
backup. The old service script/bundle remain available for rollback; SQLite
and append-only histories are retained. Rollback does not restore an old DB over
new user activity. Browser QA belongs in the coordinator's cloud browser;
physical voice/audio and HTTPS remain separate, unclaimed qualifications.
