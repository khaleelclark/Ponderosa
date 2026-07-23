# Scenario: Trigger

1. Import `organizations/scheduled-observer.json`.
2. Inspect the import preview and confirm its Trigger is disabled.
3. Change the schedule to a convenient future time.
4. Enable it explicitly and observe exactly one occurrence.
5. Disable and delete the Trigger.

Expected: imported automation never starts by itself, occurrence provenance is
visible, and disabling it prevents future work without deleting completed
results.
