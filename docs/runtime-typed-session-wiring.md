# Typed session input wiring

This additive patch depends on typed modality commit a3173869d (core inputFiles contracts and engines typed-input.ts). Compose that dependency and G1/G4 bf54bc0e163e4a405e52eb47550e3785d69638d2 before this patch. G2/G3 Codex and G8 Claude changes require ordinary hunk composition; this patch replaces no methods.

Codex startTurn and steer serialize admitted inputFiles through codexTurnContent. Claude startTurn and steer forward them to writeInput and claudeTurnContent. Rendered seed prompt text remains unchanged. Native /compact passes no files. The shared serializers revalidate bytes and determine native image/document support; unsupported formats retain the host prompt descriptor.

Claude replay-user-messages remains necessary for exact compact UUID acknowledgement and accepted-input observations. Before sending any user frame, reject serialized input above 3 MiB, leaving 1 MiB headroom under the existing 4 MiB receive-record limit. This is an input budget, not a new large-record parser or a guarantee about arbitrary provider-added envelope size. Larger native media is explicitly unsupported here; no raw-media logging is added. Existing bounded receive failure behavior remains.

Source inspection only. No tests, builds, types, Node, provider or browser execution. Installed compatibility and complete modality parity remain unqualified.
