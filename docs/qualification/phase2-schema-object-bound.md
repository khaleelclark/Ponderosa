# Fixed schema metadata bound regression

Historical boundary evidence below applies before explicit context-recovery receipts.
The current ceiling is **536**: initialization has 531 objects, and the generation
marker makes 532. The maintained test now pins 536 accepted, 537 refused, and the
complete 532-object current-state contract. This explicit schema expansion leaves
byte/row/work limits unchanged and requires independent review with the receipt
migration. It does not qualify older populated-state upgrades.

The prior runtime object ceiling was **528**, introduced by the approved pause
lineage (`4f4622b9a516a52993898600d07b7820600357c8`) when the initialized
canonical schema grew to 513 objects. Recovery receipts subsequently added
one table and three SQLite autoindexes. At integration
`52bc72f9544c52736ed077934e7dc941e25c4fbc`, initialization has 517 objects;
the current-state generation marker brings a complete database to **518**.
The existing ceiling therefore has ten objects of headroom. This correction
changes no runtime budget, schema, admission or signature implementation.

The historical maintained line-ending regression pinned the boundary independently of the
runtime constant: 528 small real SQLite tables must produce a complete signature,
while a 529th must be refused. It also retains the oversized declaration refusal,
literal/identifier/comment line-ending checks, successful complete current-state
admission without rewriting SQL or generation, and changed-index refusal. The
current-state test asserts the measured 518-object contract; future schema growth
requires review rather than silently deriving a new permitted bound.

Run after existing runtime packages are built:

```sh
node --import ./tests/shared/workspace-resolution.mjs --test tests/installation-release/schema-line-endings.test.mjs
```

This bounded check is not a full configured suite or release verdict. The prior
integration tooling failure and unstarted engines remain historical evidence;
a later approved integrated run must establish the configured suite result.
