---
id: triggers
title: Automations
summary: Attach schedules, signed webhooks, and folder watches to one Agent while preserving provenance and full-access warnings.
section: Automation
order: 60
related: agents-and-organization,runs-and-results,settings-and-auth
code: Automation service|apps/server/src/trigger-service.ts;Automation UI|apps/web/src/components/TriggersPane.tsx
---

An **Automation** is user-authored automatic work owned by exactly one Agent in one Project chat. Schedules, signed webhooks, and Project-folder watchers create durable Automation occurrences. Every occurrence is immutable, deduplicated, and auditable before it becomes a queued Activation.

## Expect full Agent authority

Automation Runs have the same host authority as their Agent. There is no observe-only or Project-only sandbox. Connect trusted senders, write narrow operator instructions, and review the prominent full-access warning. External payloads remain structurally separate untrusted data and never replace the operator's instructions.

## Preserve every occurrence

Compatible bursts from the same Automation may execute as one bounded batch, but Ponderosa retains each occurrence ID, payload hash, order, and provenance. Different Automations never coalesce into one Run. File watchers provide path and event metadata; they do not inject watched file contents automatically.

## Control automatic usage

An optional Automation Run budget limits root outside-activation Runs by period or lifetime. A batch costs one unit; delegated child work and Join resumptions do not. Exhausted occurrences remain queued instead of being discarded. Deleting or disabling the Automation stops new intake, and deleting its Agent removes pending automatic work while preserving completed evidence.
