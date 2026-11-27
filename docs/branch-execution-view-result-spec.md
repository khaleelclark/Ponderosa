# Branches UI follow-ups

Target [PR #111](https://github.com/khaleelclark/Ponderosa/pull/111).

## View result

On Dev, the completed **Today’s Trail or Town?** run has one step. Its output is already visible in **Results**. Clicking **View result** beside the step focuses that same block and moves the page slightly. The step name already opens **Step Details**.

### Expected behavior

- **Step output shown as the run result.** Show the output once in **Results** and omit **View result** from that step row. Keep the step name and status as the existing entry to **Step Details**.
- **Distinct step output.** Keep **View result** on the row. Jump to that step’s exact result under **Results**, including when the output is beyond the initially visible list of step outputs. Move keyboard focus to the destination and visibly highlight it, even when it is already in view. Keep long output and file links usable through their existing controls.
- **From Step Details.** Use **Back to Results** when the step shares the main run result. Close the tray and focus the result after the main run view is visible again. For distinct output, keep **View result** and use the same result navigation as the step row.
- **Technical output.** Keep raw output and attempt evidence in **Step Details**. A step that only has technical evidence should have no **View result** shortcut.

### Implementation notes

Reuse the result targeting and tray navigation in [ExecutionPanel](../apps/web/src/components/branches/ExecutionPanel.tsx). Use the existing `resultInRun` marker or the existing equality check when both outputs are complete to identify shared output. Keep result selection tied to the exact step invocation or published file. Matching truncated previews alone cannot establish that two outputs are the same.

### Acceptance checks

- Open the **Today’s Trail or Town?** run or a one-step fixture with identical run and step output. **Results** appears once, the row has no redundant button, and selecting the step still opens its details.
- On desktop and phone, **Back to Results** closes Step Details and lands on the visible main result. A distinct step’s **View result** lands on the right output with a visible highlight and keyboard focus, including when several steps have similar output.
- Cover an output beyond the initial display limit and a technical-only step. Extend the [existing execution results qualification](../tests/branches/execution-results-qualification.mjs) for the changed behavior.

## Run History filters

- Replace the single-select dropdown with one **Filter runs** control. Open a checklist of the existing run statuses and let users pick several before selecting **Apply**. For example, **Waiting** and **Failed** show runs in either status. **Clear all** returns to all runs. Summarize the applied selection as **All runs**, the single status, or **N statuses**.
- Give the filter its own full-width row in the history pane. Place **Trigger Events** below it as a separate secondary action. Keep both labels legible at the current desktop sidebar width and on a phone.
- Filter on the server before pagination. Reuse the effective status used by run chips and the stored outcome for finished runs. Keep one ordered, deduplicated result set and restart pagination when the selection changes. Save the selected statuses in the URL and continue to open links with a single `state` value.
- Keep the open run selected when filters change. If it does not match, say **This run is outside your filters** and keep it separate from matching rows. An older matching run outside the loaded page should not get that message. When there are no matches, show **No runs match these filters** with **Clear filters**.

## Trigger Events

Keep the label **Trigger Events**. This is where users check what happened when an automatic trigger fired, including cases where it did not create a new run. A completed manual run can appear in **Run History** while **Trigger Events** is empty.

- Replace the helper text with **See when a schedule was due, a webhook arrived, or a watched file changed, and what happened next.**
- For a manual-only workflow with an empty log, say **This workflow runs manually. Your manual runs are in Run History.** For a workflow with an automatic trigger and an empty log, say **No automatic trigger events recorded yet.**
- Lead with the source, time, and outcome. Use labels such as **Run created**, **Waiting for current run**, **Updated current run**, and **Combined with a later check** where the event data supports them. Use **Couldn’t start a run** with the reason for a confirmed start failure. Keep an unconfirmed update visibly uncertain. **View run** appears when there is a linked run and opens that run.
- Keep payloads, IDs, and delivery evidence under the existing details disclosure. Reuse the trigger audit and its pagination.

### Acceptance checks

- Select **Waiting** and **Failed** together and page through results. Verify both statuses appear in the same newest-first list and a refresh restores the selection. Open an older link with one status and verify it still works.
- Apply a filter that excludes the open run. The selected run stays open, the mismatch is clear, and clearing the filters restores the list. Verify that an older matching selection is distinguishable from one the filters exclude.
- Check the filter and Trigger Events controls at the narrow desktop pane width and at phone width. Verify labels fit, checklist options work with keyboard and touch, and **Apply** returns focus to the filter.
- Check the empty manual workflow from the screenshot, a scheduled event that created a run, and a held or combined schedule event. **View run** opens the linked run without creating a new one.

## Trigger settings layout

- Put the back arrow immediately to the left of **Trigger settings** in one header row. Give it a 44 px touch target, the accessible name **Back to workflow**, and a matching tooltip. Keep the title aligned with the arrow and allow it to wrap when space is tight. Use the shared [WorkflowInspectorPage](../apps/web/src/components/branches/WorkflowInspectorPage.tsx) header and preserve each inspector’s existing back destination and header actions.
- Under **How it starts**, use one full-width radio row per option in the existing order. Keep the radio and label aligned, make the full row clickable, and let long labels wrap within their row. The four choices stay in a single column at every inspector width.
  - **Manually with Run once**
  - **On a schedule**
  - **When a webhook arrives**
  - **When files change**
- Keep the right-side inspector and show the selected trigger’s settings below the radio group. Back returns to the Canvas or Outline where the inspector opened and restores focus to the trigger control. Draft edits stay available when the inspector is reopened.

### Acceptance checks

- Open Trigger settings at the narrowest and widest supported dock widths and at phone width. Verify the back arrow and title share one header, each option has its own row, and labels and controls never overlap or scroll horizontally.
- Select a trigger by tapping its label row and by using the keyboard. Verify that its settings appear below the choices. Return from both Canvas and Outline and check focus and draft retention. Extend the [existing inspector qualification](../tests/branches/workflow-inspector-qualification.mjs).
