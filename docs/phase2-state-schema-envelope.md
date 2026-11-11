# Phase 2 schema admission envelope

Migration 0043 adds compact export pool claims, slot hashes, reader leases and
an issuance receipt to the existing SQLite authority; exported payload bytes
are held separately. The current schema contains 596 objects including the
state generation table. Its fixed ceiling is 601 objects. Ordinary row,
column, byte, statement and work budgets remain unchanged; exact expected
schema signatures and state-generation admission checks remain in place.

The regression pins 601 objects as accepted, a 602nd as refused, and the real
initialized schema at 596. Exact 0042 predecessor admission permits its
additive upgrade. Tests also preserve nonempty searchable FTS content while
copying SQLite-managed indexes through the virtual table interface.

No production migration, service restart or state rewrite is performed by
this source change.
