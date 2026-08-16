---
id: troubleshooting
title: Troubleshooting and recovery
summary: Diagnose queued work, provider denial, uncertain steering, cleanup barriers, and missing context from canonical evidence.
section: Operations
order: 80
related: settings-and-auth,runs-and-results,documentation-references
code: Health projection|apps/server/src/agent-health.ts;Shutdown policy|apps/server/src/shutdown.ts
---

Start with the status Ponderosa owns rather than guessing from a quiet provider process. Agent status comes from authoritative Runs, actionable Activations, open Joins, and waiting Requests. Activity and Runs explain why work is queued, running, waiting, completed, failed, or cancelled.

## Work remains queued

Check global leasing, configured concurrency, engine availability, Automation budgets, and whether an earlier FIFO user turn owns the next boundary. A provider-confirmed entitlement denial deliberately prevents new leases without dropping queued work. A waiting Join is not a hung Run; it becomes actionable when its immutable condition changes.

## Steering is unconfirmed

A steer is delivered only after provider acknowledgement. If transport becomes uncertain, Ponderosa preserves that evidence, waits through a bounded grace period, then fences only the original Run and creates linked audit-first recovery work. Historical uncertain injections remain inert and are never replayed automatically.

## Cleanup is pending

Provider and browser cleanup succeed only after the complete process group is observed gone. Failed close attempts remain in retryable teardown state, block unsafe replacement or Project deletion, and create an operational notification. A committed Agent deletion is not rolled back merely because cleanup continues.

## Context seems incomplete

Inspect the Run's provider-input manifest. It distinguishes exact submitted text from evidence retained in a continued provider session. Older bounded history, artifacts, Team identities, and product documentation are explicit on-demand references; retrieve only the source the current task needs.
