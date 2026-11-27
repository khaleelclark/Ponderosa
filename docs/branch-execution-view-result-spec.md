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

## Step picker and removal

- Remove the static Notification alert from **Step Settings**. In the step picker, give **Notification** a short tooltip such as **Sends the step’s input to Ponderosa Notifications and subscribed devices.** Show it on hover and keyboard focus. Use brief descriptions at the point of choosing a step, and keep picker items usable on touch. Describe only what the step does. Keep alerts for errors or conditions that need the user’s attention.
- Allow **Remove step** when it is the only step. An empty draft is a normal editor state. Clear its entry and any connections to the removed step, close the step inspector, and return to **Add your first step** in the active Canvas or Outline. Preserve the workflow’s trigger and other draft settings. Use the existing undo and redo behavior.
- Block saving or publishing a workflow until it contains a valid first step. Put **Add your first step** near the blocked action and route it to the existing picker. Apply the same rule to **Review changes**, **Publish to run**, and **Save and Leave**. Keep the server’s publication validation. An empty draft of an already published workflow leaves the currently published version and its runs intact.
- Reuse the shared removal logic and the existing empty-draft state. Preserve the checks for required steps in Conditions, parallel paths, and For Each groups. Removing a step edits the draft graph and does not remove an Agent, a Chat, or saved run history.

## Right-click quick actions

- In **Canvas** and **Outline**, right-click an editable step to open its quick actions. Offer **Edit step**, the existing add actions for that step or path, and **Remove step** when it is allowed. Reuse the Outline action menu and the same edit, insertion, and removal handlers in both views.
- In the **Workflows** list, right-click a workflow row for quick actions scoped to that row. Start with **Rename**, **Star** or **Unstar**, and **View runs** for a published workflow. Reuse the existing sidebar row’s context-menu hook, shared menu components, routing, and leave guard. Opening the menu leaves the current selection in place.
- Keep quick actions available from a visible overflow button and support the context-menu key or Shift+F10. Use the same actions and availability for right-click, keyboard, and touch, and restore focus to the opener on dismissal.

### Acceptance checks

- Choose **Notification** from the picker. Verify the brief help is available there and the step inspector has no static alert. Remove it as the only step in Canvas and Outline, undo and redo the edit, then add a different first step.
- Try the save and publish entry points with zero steps. Verify each leads back to adding a first step or explains what is required, and that a previously published workflow keeps its published version. Verify existing graph safety checks still apply to a step required by another node.
- Right-click a step in Canvas and Outline. Verify the actions target that step, including removal of the only step. Right-click an unselected workflow and verify Rename and View runs target the clicked row. Check the keyboard and touch entry points and focus return.
