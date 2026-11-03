# Phase 2 export staging

Large export bytes use one issued, held pool file. SQLite stores only small
claims, slot reservations, per-chunk hashes, reader leases and the pool
identity receipt. Pool slots are reserved and charged before writes, synced,
then read back and verified before a ticket is completed. Each chunk is read
into a private buffer and checked against its sealed hash before delivery.
Expired completed slots are reusable only while no durable reader holds them.
Unconfirmed claims, writes, reader leases, pool issuance and legacy files are
held; no automatic recovery replays uncertain work or deletes a filesystem name.

The pool is limited to 4 GiB logical size. Capacity charges the largest of its
durable full-slot high-water, observed file size and observed allocated blocks,
plus retained legacy staging. Free-space headroom is also checked. Legacy
staging is reobserved with bounded metadata reads; changed or unaccountable
records cause a refusal. Legacy downloads are verified against their original
manifest and checked chunk by chunk during delivery.

Issued handles prevent a replaced pool pathname from redirecting writes.
Another process running as the same user can still alter or hard-link the issued
inode. Hash checks catch changed bytes before they are emitted; identity and
size checks do not establish exclusive control over an uncooperative writer.
An uncertain issuance or reader cannot be cleared merely because time passed.
These changes do not perform a production migration or restart.
