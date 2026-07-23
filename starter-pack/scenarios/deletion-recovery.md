# Scenario: restart and deletion recovery

1. Complete the first-Agent scenario.
2. Stop Ponderosa with `ponderosa stop`.
3. Start it again with `ponderosa open`.
4. Confirm the Project, communication, Run, and output are still present.
5. Delete the disposable Project in Ponderosa.
6. Confirm the source folder remains on disk.
7. Launch Ponderosa twice concurrently.

Expected: the second launch opens the healthy existing instance, canonical state
survives restart, Project deletion never deletes the source folder, and no stale
lock or duplicate daemon remains.
