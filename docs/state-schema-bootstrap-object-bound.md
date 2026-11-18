# State schema bootstrap object bound

Source-only diagnosis at base `173387ca5cd4645289a2ec1760ff531f2b62d1eb`.
The supplied recording receipt/log records two AgentStore bootstrap failures.
Both stacks point to emitted state-schema-signature.js line 77: the guard
immediately after sqlite_master population, before object reads/table flags or
actual-versus-expected schema comparison. Source and emitted object limits are
536. expectedContract constructs the canonical schema plus _state_generation,
so an undersized bound rejects the expected schema itself.

Static DDL accounting from the previous 532-object generated contract:

| Extension | Added sqlite_master objects |
| --- | ---: |
| 0035 recovery progress (ALTER only) | 0 |
| 0036 cut restorations | 7 |
| 0037 destination admissions/members | 9 |
| 0038 destination retirements | 6 |
| 0039 destination group Chats | 4 |
| 0040 lifecycle commits | 4 |
| 0041 native task stops | 3 |
| Total added | 33 |

Counts include automatic PRIMARY KEY/UNIQUE indexes and triggers. The native
stops table also appears in the baseline; its IF NOT EXISTS extension adds no
second copy. History schema extraction into compaction-history-schema.ts moves
existing declarations without adding objects. Thus initialization is 564 objects,
565 with generation. These are source-derived counts, not fresh SQLite results.

Increase only the fixed object envelope from 536 to 568 (three slots above the
current generated contract). Byte, row, column, statement and work budgets remain
unchanged. Object declarations, strict/table flags, index metadata and complete
expected/actual signature comparison remain unchanged. No admission bypass,
schema mutation, migration or production database access is introduced.

Deferred fixture source pins 568 accepted/569 refused, preserves oversized-SQL
refusal and real index-contract mismatch refusal, updates the CRLF canonical
count, and adds clean AgentStore bootstrap/reopen with an exact 565-object
assertion. None was executed. Delivery must compose/rebuild in its authorized
disposable environment, run these fixtures, then rerun the recording acceptance
command. This patch removes the demonstrated object-count prerequisite only;
subsequent failures or other budget ceilings are not ruled out.
