# Phase 2 schema admission envelope

The complete current SQLite schema now contains 579 objects including the state
generation table (166 tables, 356 indexes, 57 triggers). The former fixed ceiling
of 568 rejected a freshly initialized legitimate database before AgentStore could
start. The schema object ceiling is now a fixed 584. Ordinary row, column, byte,
statement and work budgets remain unchanged; exact expected-schema signature and
state-generation admission checks remain in place.

The existing schema regression independently pins 584 objects as accepted and a
585th as refused, and pins the real initialized current schema at 579 objects.
Its existing CRLF/generation and changed-index checks continue to distinguish
line-ending normalization from a foreign schema. No production database migration,
service restart or state rewrite is part of this capacity correction.

Diagnosis used one focused Agent lookup regression against Node 24.16.0 and the
already-built integration output. Its retained disposable database was opened
read-only to confirm the object count. Focused re-execution and the consolidated
suite remain with the integration owner after this source change is merged.
