# Scenario: first Agent

1. Run `ponderosa doctor`; resolve every failure.
2. Create a Project using `projects/disposable-test-app`.
3. In its first Project chat, ask:

   > Read verification-input.txt, follow it exactly, and report the created file.

4. Confirm that response streaming is visible and `verification-output.txt`
   contains the expected marker.
5. Open Files & Results and confirm the file has Agent and Run provenance.

Expected: one request starts one Agent Run, the file is created once, and no
provider credential or repository setup is requested.
