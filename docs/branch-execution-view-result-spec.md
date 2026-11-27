# Make View result useful in Workflow Executions

Target [PR #111](https://github.com/khaleelclark/Ponderosa/pull/111).

On Dev, the completed **Today’s Trail or Town?** run has one step. Its output is already visible in **Results**. Clicking **View result** beside the step focuses that same block and moves the page slightly. The step name already opens **Step Details**.

## Expected behavior

- **Step output shown as the run result.** Show the output once in **Results** and omit **View result** from that step row. Keep the step name and status as the existing entry to **Step Details**.
- **Distinct step output.** Keep **View result** on the row. Jump to that step’s exact result under **Results**, including when the output is beyond the initially visible list of step outputs. Move keyboard focus to the destination and visibly highlight it, even when it is already in view. Keep long output and file links usable through their existing controls.
- **From Step Details.** Use **Back to Results** when the step shares the main run result. Close the tray and focus the result after the main run view is visible again. For distinct output, keep **View result** and use the same result navigation as the step row.
- **Technical output.** Keep raw output and attempt evidence in **Step Details**. A step that only has technical evidence should have no **View result** shortcut.

## Implementation notes

Reuse the result targeting and tray navigation in [ExecutionPanel](../apps/web/src/components/branches/ExecutionPanel.tsx). Use the existing `resultInRun` marker or the existing equality check when both outputs are complete to identify shared output. Keep result selection tied to the exact step invocation or published file. Matching truncated previews alone cannot establish that two outputs are the same.

## Acceptance checks

- Open the **Today’s Trail or Town?** run or a one-step fixture with identical run and step output. **Results** appears once, the row has no redundant button, and selecting the step still opens its details.
- On desktop and phone, **Back to Results** closes Step Details and lands on the visible main result. A distinct step’s **View result** lands on the right output with a visible highlight and keyboard focus, including when several steps have similar output.
- Cover an output beyond the initial display limit and a technical-only step. Extend the [existing execution results qualification](../tests/branches/execution-results-qualification.mjs) for the changed behavior.
