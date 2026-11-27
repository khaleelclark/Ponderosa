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

## Workflow variables

A workflow variable is a named value you set once and reuse in steps, such as a report title or a folder path. A run uses the saved values it started with. **Run once** input is separate and supplies the starting input for that particular run.

### Where to find and edit them

- Remove **Workflow variables** from the Trigger settings footer. Open the existing right-side variables inspector from **Workflow Actions → Workflow variables**. Use **Workflow variables** and **Add variable** in the UI. Give the name field and button enough room at the narrowest inspector width.
- Lead with **Set a value once and reuse it in this workflow.** Give one working example. Add a text variable named `report_title` with the default `Weekly team update`. In an Agent Task, write `Draft a report titled “{{parameter:report_title}}”.` The Agent receives **Draft a report titled “Weekly team update”.**
- Explain the two places a user edits variables. In the Workflow inspector, define the name, type, and optional default, then publish the workflow changes. In **Settings → Workflow Variables**, edit the saved values for the published workflow. Link to that Settings section from the inspector when it is available. Use the existing publication and save flows, and keep existing draft edits recoverable when navigating between them.
- Put name-format rules in validation or field help. Use plain labels such as **Text**, **Number**, **Yes/No**, and **File or folder path**. A path is a location, and a step must open it to read its contents. Keep engine-managed secrets separate from values that can be inserted into steps.

### Where variables work

| Step or field | How to use a variable |
| --- | --- |
| **Agent Task → Instructions** and **Approval → Review Prompt** | Insert the reference into the text. The run fills in its saved value. |
| **Condition → Input Equals** | Use the reference as the value to compare with the incoming text. |
| **Connection → Explicit Input** | Insert the reference into the text passed to the next step. This is also how to send a variable in a **Notification**, which sends its incoming input. |
| **Script** | Read the values from `JSON.parse(process.env.PONDEROSA_PARAMETERS ?? '{}')`. A Script’s **Working Directory** can reference a folder variable. |

Put **Insert variable** next to supported text fields when the workflow has variables. Insert the existing `{{parameter:name}}` reference at the cursor and keep the user in the field. For Script source, show a copyable example in the existing help. Keep advanced trigger configuration out of the primary picker unless the specific field supports a reference end to end. Reuse the existing variable definitions, saved-values editor, and runtime substitution.

### Acceptance checks

- From Canvas or Outline, find variables from Workflow Actions, create the example at phone and narrow desktop widths, and insert it into an Agent Task or Approval. Verify the picker returns focus to the field and the run resolves the value.
- Save a changed value in Settings and start another run. Verify the new run uses the new value and the earlier run keeps its original value. Check that manually entering run input still works independently.
- Verify available variable choices match each field’s support. Test a missing required value and a Script consuming a number or boolean. Engine-managed secrets remain out of the insertion list and Script parameters.

## Leaving a workflow with unsaved changes

When someone tries to open another workflow while editing, show a compact, centered **Unsaved changes** dialog. Keep the current workflow visible behind it. Name the current workflow and the requested destination when both names are available. Put all three choices together where the user can see them on desktop and phone.

| Action | Behavior |
| --- | --- |
| **Stay here** | Dismiss the dialog, keep all edits, and return focus to the open editor or the control that initiated navigation. Escape has the same effect before a save or discard begins. |
| **Save and switch** | Use the existing review and publication flow. Make clear that saving here publishes the workflow. Switch to the requested workflow only after the save is confirmed. If validation fails, review is canceled, or the save is unconfirmed, stay on the current workflow with its edits and show the next step. If saving is blocked, explain what needs fixing, such as **Add your first step before publishing**. |
| **Discard changes and switch** | Restore the last saved workflow state through the existing discard flow, then open the requested workflow. If the discard cannot be confirmed, keep the current editor and show the error. |

- Use the shared [confirmation dialog](../apps/web/src/components/ConfirmationDialogs.tsx) as a modal and reuse the current [workflow leave guard](../apps/web/src/components/branches/BranchNavigation.tsx). The modal replaces the **Unsaved Changes** inspector pane. Give **Stay here** initial focus, trap focus inside the dialog, and keep background navigation inactive while it is open. Show progress while a save or discard is pending and prevent duplicate submissions.
- Trigger the dialog when navigation would leave a dirty workflow or discard its editor changes. Keep clean workflow switching and draft-preserving tab switches immediate. Preserve browser Back and Forward guard behavior. Capture the requested destination when the dialog opens so rapid clicks or late responses cannot switch to the wrong workflow.

### Acceptance checks

- Edit a step and click another workflow. Verify the dialog is centered, all three actions are visible without scrolling on a phone, and **Stay here** or Escape keeps the editor, draft, and URL.
- Verify **Save and switch** opens the existing review, switches exactly once after a confirmed save, and stays on the current workflow on validation failure, cancellation, or an uncertain response. Verify **Discard changes and switch** opens the intended workflow after a confirmed discard and leaves the last published version intact.
- Verify a clean switch has no prompt. Exercise browser Back and Forward and a second navigation attempt while the modal is open. Extend the [existing leave-guard tests](../tests/branches/editing-navigation.test.mjs).

## Execution settings help

Add short help beside each control in **Settings → Execution Controls**. Use the existing tooltip styling and a small, labeled help target. Show the same text on hover, keyboard focus, or tap. Keep the value, field label, and validation feedback readable at narrow widths. Opening help leaves the field value unchanged and does not toggle a setting.

| Control | Tooltip |
| --- | --- |
| **Automatic Execution Budget / Limit** | Caps how many automatic runs and calls from other workflows can start in each budget period. Run once is exempt. |
| **Concurrent Executions** | How many runs of this workflow can do work at the same time. Additional runs wait for room. |
| **Temporary Agents Per Execution** | How many temporary Agents one run can create, including Agents created by a temporary team. |
| **Maximum Paths** | How many paths a single run can create in total, including the starting path, parallel paths, and paths for For Each items. |
| **Maximum Step Invocations** | How many step visits one run can make across all its paths. Visiting the same step again in a loop uses another visit. |
| **Pause Automatic Runs When Speaker Role Is Removed** | If this workflow’s designated Speaker Agent loses that role, pause new automatic runs. |
| **Failure Handling** | Choose what to do when a step fails and hasn’t set its own behavior. |
| **Nested Branch Depth** | How many workflows can be called in a chain beneath this one. A direct call is one level. |
| **Loop Iterations** | How many times a run can follow a loop-back connection in total, including loops in workflows it calls. |
| **Graph Traversals** | How many times a run can visit steps and routing points in total, including revisits and work in workflows it calls. |

Keep **How this budget works** for the detailed budget explanation. Keep the difference between publishing **Execution policy** edits and saving **Local limits** visible in the panel.

### Acceptance checks

- Read every tooltip with a mouse and keyboard, then tap its help target at phone width. Verify help can be dismissed, the settings stay editable, and opening help does not change any setting.
- Check that the copy distinguishes runs, paths, step visits, and routing visits. Verify the budget copy describes workflow calls and the manual-run exemption.
