# Pinecone on a Branch

Open `/branches?tab=pinecone` to install a new assistant. Its texting surface is
`/branches?branch=<installation-id>&tab=pinecone`. Existing Dev Pinecones are
separate installations; this preset does not convert or change them.

Installation uses the existing reviewed Branch package flow. Choose a dedicated
existing working directory and a subscription-backed provider. The preset enables
an interval trigger every ten minutes, as requested. Work requires the host and
Ponderosa to remain online; browser push additionally requires the user's existing
notification permission and supported deployment. The canonical inbox still
records notifications when browser push is unavailable.

Pinecone is the sole human-facing spokesperson. Scout researches a narrow question
even without changed inputs; Findings Reviewer verifies evidence and relevance.
The Branch runs one discovery execution at a time. Each check is bounded to four
external searches and six narrow context reads. Useful, nonurgent opportunities
are eligible. Quiet checks retain their question and reason in a bounded local
coverage artifact. Verified findings pass through a distinct-claim gate, a short
spokesperson delivery, and the existing canonical notify Action. Announcement
receipts are written after that Action succeeds. Failed delivery is not silently
marked announced. Malformed result JSON fails the execution visibly.

Texting uses the existing Agent communication endpoint and live SSE projection.
Only human DMs and spokesperson-authored human communications appear as bubbles;
worker collaboration and ordinary tool output remain in Details. Message drafts
and uncertain submission identities survive reloads; retries reuse the same
delivery identity. The Branch-owned Agent and Chat are checked before enabling
interaction. Decisions reuse the existing Decision surface.

Pause discovery disables automatic trigger intake. Already accepted work may
finish; manual Check now and direct conversation remain available. Activity opens
canonical executions, including failures and waits. Details opens the existing
Branch Chat, its files, organization, runtime controls and provider configuration.
Discovery focus is an installation parameter. Pinecone may maintain an explicit
shared brief containing authorized interests and dismissals; DMs do not silently
become worker context.

This is a thin UI and portable preset: no new scheduler, provider integration,
communication store, database schema or Pinecone-profile ownership exception.
Source work is on `codex/pinecone-branch-overlay-20261011`, based on the researched
Branches/Pinecone preview `191111a`. That preview's dependencies must be reviewed
and integrated independently before this stack can merge into master. Existing
held Pine services are not modified by this implementation.
