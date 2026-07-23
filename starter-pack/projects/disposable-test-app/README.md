# Disposable Ponderosa verification Project

This folder exists only for the private-beta verification workflow.

The Agent should:

1. Read `verification-input.txt`.
2. Create `verification-output.txt` containing the requested marker.
3. Report the file through Ponderosa.
4. Allow the user to start and cancel one separate waiting Run.
5. Survive a Ponderosa restart with the created file and completed communication
   still visible.

The workflow must not install dependencies, contact an external service, change
another folder, or retain a Trigger.

Delete the Ponderosa Project after verification. Removing the Project must not
delete this source folder.
