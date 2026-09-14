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
- Optional local Kokoro read-aloud on the private Pine/Linux host, with Willow,
  Cedar, and Hazel voices. Browser/system read-aloud remains available without
  installing the optional package.
- Interrupted local-voice installation now reconciles leftover managed files,
  preserves the active version, and exposes retryable repair when cleanup fails.
- Upgrade history reads tolerate deleted pre-Chat-ownership Agent records without
  assigning synthetic Chats or relaxing validation for live Agents.

## Upgrade and qualification

Use the packaged Node 24 runtime. Drain active work and retain a coherent backup
of Ponderosa-owned state before upgrading. Preserve selected Project folders.
The dev upgrade preserved 67 Projects, 79 Chats, and 470 Agent identities; the
legacy-history fix was verified against that snapshot and a regression fixture.

The integrated source passed 467 checks, typechecks, and production builds on
Pine/Linux. Installer build success is not native OS qualification. Each
candidate must retain its exact source commit, checksum, platform metadata,
and installed-artifact evidence. Windows 11 and native adversarial filesystem
qualification remain release gates; unsigned packages remain private candidates.

Local Kokoro hosting is currently qualified only for the private Pine/Linux
setup. Physical iOS/Android audio behavior and native macOS/Windows local voice
hosting are not claimed. Dictation and read-aloud are separate controls, not a
phone-like voice conversation.
