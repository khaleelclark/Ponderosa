---
id: agents-and-organization
title: Agents and organizations
summary: Create durable Agent identities, reporting trees, and managed collaboration without introducing a second kind of worker.
section: Agents
order: 40
related: getting-started,communication-scopes,runs-and-results
code: Agent detail|apps/web/src/components/AgentDetail.tsx;Managed Agent capability|packages/core/src/managed-tools.ts
assets: Workspace map|docs/wiki/assets/workspace-map.svg
---

Ponderosa has one kind of **Agent**. A report or subagent is an ordinary Agent with a direct `Reports to` relationship, not a reduced runtime, hidden helper, or separate assignment system. The stable identity can participate in many Runs and provider sessions.

## Create only useful structure

Start with the responsible Agent created by a plain Project request. Add a specialist when it needs a durable role, separate context, direct accountability, or independently inspectable work. A user may create a top-level Agent or select an existing manager. An Agent creates visible reports through Ponderosa's managed-Agent capability; provider-native hidden helpers do not satisfy that operation.

## Reporting and communication differ

Reporting relationships define ownership, escalation, creation, and lifecycle. They are not routing walls. Agents may collaborate directly across branches with the smallest set of recipients who need the information. Results return to their requester or consumer; managers receive the outcomes and escalations they own.

## Inspect and change the tree

Agent Detail is the audit hub for Chat, Work log, Activity, Changed Files, Review, Runs, Files & results, and Triggers. Re-parenting and deletion preserve historical authorship and execution provenance. Deleting a manager recursively includes remaining descendants in one server-previewed atomic cascade. Promote or re-parent anything you want to keep before confirming deletion.
