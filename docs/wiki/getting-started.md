---
id: getting-started
title: Getting started
summary: Create a Project, open its first Project chat, and understand what Ponderosa runs on your computer.
section: Start here
order: 10
related: project-chat,agents-and-organization,runs-and-results
code: Project creation API|apps/server/src/app.ts;Project creation UI|apps/web/src/components/dialogs.tsx
assets: Workspace screenshot|docs/wiki/assets/workspace-map.png
---

Ponderosa is a self-hosted workbench for AI Agents that use your existing Codex or Claude subscription login. It does not ask for a provider API key. The server runs on your computer, starts provider runtimes as the host user, and keeps the canonical Project, communication, execution, and artifact records.

## Create a Project

A **Project** is the durable boundary for a source folder, Project chats, Agents, Runs, and Files & results. Choose **New project**, give it a recognizable name, select a validated host folder, and choose a default subscription-backed engine. Ponderosa creates the first Project chat in the same operation. Deleting the Project removes Ponderosa-owned state but never deletes the selected source folder.

![Annotated Ponderosa workspace screenshot](/api/wiki/assets/workspace-map.png)

## Start with Project chat

For ordinary work, open a Project chat and write naturally. A plain request becomes shared Project history and starts one fresh responsible Agent. You do not need to design an organization first. Add specialists later when parallel work, durable roles, or independent review would materially help.

## Know the boundary

Agents intentionally have the same host access as the account running Ponderosa. The file-browser API is narrower and stays inside registered Project paths, but an Agent's shell is not a pretend sandbox. Review instructions and automatic Triggers accordingly. Provider authentication remains in the provider's own login store and must never be copied into a Project or wiki page.
