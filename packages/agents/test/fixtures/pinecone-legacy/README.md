# Frozen historical Pinecone migration schemas

The profile and admission upgrade tests previously invoked Git to read
9afdf1f2 and 0e7ee833. Those local development objects are not available in
ordinary CI checkouts. The tests now load these committed fresh-database SQL
snapshots, then seed the same ordinary/Pinecone records and run the current
migrator with all existing preservation and foreign-key assertions intact.

Each SQL snapshot was captured by the exact historical db.ts opener against
that commit's schema tree. Only its temporary schema-directory path changes.
The manifest records the source Git blob/tree IDs, SQL checksum, normalized
SQLite schema-graph checksum and default seed-row counts. The loader verifies
both checksums and foreign keys before the test adds data. No live database or
user records are included. Historical migration timestamps are fixture data.

To intentionally recapture, use a checkout containing both historical source
objects, build the agents package, and run capture.mjs in this directory.
Normal test runs require neither Git nor network access.
