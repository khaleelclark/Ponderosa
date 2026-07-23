# Scenario: pause and resume

1. Ask Solo Control to wait for 60 seconds before creating `cancelled.txt`.
2. While it is running, stop that exact Run.
3. Confirm the Run ends and `cancelled.txt` is not created.
4. Send a new request to create `resumed.txt`.

Expected: cancellation targets only the observed Run, its provider process is
cleaned up, and the later request runs once without reviving cancelled work.
