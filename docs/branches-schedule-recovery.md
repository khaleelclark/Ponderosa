# Scheduled catch-up

Schedule polling records one durable occurrence per due time, with the original
scheduled timestamp and the evaluation timestamp. Queue-every-run schedules admit
one execution per occurrence. Explicit run-latest and update-current policies
retain their existing overlap behavior and inspection trail.

Each poll accepts at most 100 occurrences per schedule to keep polling responsive.
The durable cursor remains at the next unaccepted time, even while it is overdue;
subsequent polls continue the backlog. A failed acceptance does not advance its
cursor. Restart and backward clock changes do not replay accepted due times.

Cron still uses Croner's configured timezone semantics: the repeated fall-back
local time fires once; a nonexistent spring local time retains the elapsed
hour offset (02:30 becomes 03:30). This change does not redefine DST policy.
