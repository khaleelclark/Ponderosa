# Ponderosa 0.1.0-beta.11 — release candidate

Beta 11 brings the experimental Chat workflow and reliability fixes into the
main development line. This document describes a candidate; installer evidence
must be checked before distribution. Continuous voice conversation is not part
of this release.

## Changes since the published Beta 9

- Chats own their Agents; Project-owned Automations target an explicit Chat and
  Agent. Agents can share a working folder or use a separate Git copy.
- More compact mobile navigation and composing, clearer message typography,
  restored Project Chat dictation, HEIC photo uploads, and attachment browsing.
- More reliable replies, mentions, draft handling, message delivery, Stop retry
  identities, and retained views during temporary refresh failures.
- Browser/system read-aloud. The optional hosted-voice integration from this
  historical release has been removed in the current experimental branch.
- Upgrade history reads tolerate deleted pre-Chat-ownership Agent records without
  assigning synthetic Chats or relaxing validation for live Agents.

## Upgrade and qualification

Use the packaged Node 24 runtime. Drain active work and retain a coherent backup
of Ponderosa-owned state before upgrading. Preserve selected Project folders.
The final dev upgrade qualification preserved 68 Projects, 81 Chats, and 471
Agent identities. All historical Agent lookups completed; eight legacy tombstones
intentionally have no current DTO. The earlier failed-upgrade rehearsal used a
different snapshot (67 Projects, 79 Chats, 470 Agent identities).

The final release tree at `566475063f0004898436c3b022b3f126ca6c9814` passed
471 checks (3 core, 73 agents, 182 web, 213 server), typechecks, native compilation,
and production builds on Pine/Linux. Installer build success is not native OS qualification. Each
candidate must retain its exact source commit, checksum, platform metadata,
and installed-artifact evidence. The [final native installer jobs](https://github.com/khaleelclark/Ponderosa/actions/runs/34820441234)
passed for Linux, macOS, and Windows at that head, with matching recorded metadata
and checksum sidecars. Their installed qualification reports still say
`releaseQualified: false`: exact-commit target filesystem evidence, authenticated
Codex/Claude discovery and execution on real macOS, and installed-artifact
qualification on Windows 11 remain gates. Hosted Windows Server evidence does
not qualify Windows 11. Unsigned packages remain private candidates.

Physical iOS/Android audio behavior requires real-device qualification. Talk in
the later experimental branch remains turn-based, using browser speech only.
