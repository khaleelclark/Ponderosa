# Managed local read-aloud — private Pine release

The optional Linux x64 package is qualified on Pine. Windows and macOS **hosting** remain disabled; browsers on those systems can connect to Pine and play its generated audio. Only Chromium's actual media path has been instrumented in this release; physical-device/browser qualification is not implied.

## Operation

Open Settings → Local voices → Install local voices. Installation is explicit: Play never installs or downloads models. Browser/system speech remains available before installation and as an explicit fallback after a local playback failure. Successful installation selects Kokoro unless the operator explicitly selected browser speech.

Three approved voices: Willow (`af_heart`, speaker 3, US), Cedar (`am_michael`, speaker 16, US), and Hazel (`bf_emma`, speaker 21, GB). Each uses the matching English lexicon. Preview controls, speed 0.75–1.25, and messages share one playback owner. Dictation is unchanged.

The workspace preference writer and workspace stream remain authoritative for preferences. Installation status comes from verified files and runtime readiness, not preferences. First-use suggestions are claimed once on the server across connected clients.

## Private package distribution

The source-controlled Linux manifest pins 375 files totaling 416,671,025 bytes (about 397.4 MiB). Ponderosa's repository is private. The server does not gain GitHub credentials: the deployment operator retrieves the private `speech-kokoro-linux-x64-1` release and stages its files under:

```
PONDEROSA_SPEECH_PACKAGE_DIRECTORY/
  speech-kokoro-linux-x64-1/
    <sha256>-<filename>
    manifest.json
```

This is a separate deployment-owned package mirror, not part of the base application bundle or any Project. Settings verifies every file while installing into `dataDir/local-speech/`. Removing voices deletes installed voice/runtime files and generated audio, while retaining the package mirror for reinstall. An administrator may delete the mirror after uninstall if it is no longer needed. Settings explains this distinction.

`package-runtime.mjs VERIFIED-STAGING NEW-OUTPUT PLATFORM VERSION` prepares a new immutable candidate and refuses to overwrite an existing output. It does not publish anything. The source-controlled manifest and all staged file digests must match the release artifact.

Full upstream notices are installed under `notices/` and are viewable through the authenticated notices route before installation. The private release includes source inputs and the native worker build definition. No license change to the rest of Ponderosa is made. This private Pine deployment is not approval for public redistribution; public distribution and additional host platforms require their own license/source-obligation and platform review.

## Runtime bounds and isolation

- Private binary stdin/stdout protocol; no message text in arguments, diagnostics, filenames, or operational logs.
- Linux bubblewrap with a private network/PID namespace and no home/Project/credential mounts; no unsandboxed fallback.
- Native address-space limit 2 GiB, core dumps disabled, two synthesis threads.
- One active job, two queued jobs; interactive segments precede prefetch. Queue, startup, and segment deadlines are 15 seconds. Installation has a 20-minute overall deadline.
- Segments: at most 200 codepoints / 800 UTF-8 bytes. Playback: at most 20,000 codepoints. PCM output: at most 2,880,000 bytes per segment.
- One prefetched segment per browser. Stop aborts work and releases audio URLs; replacement and hidden surfaces stop obsolete playback. Only explicit navigation from the upgrade suggestion may hand playback to Settings.
- Memory-only LRU audio cache: 32 MiB, 128 entries, 30-minute lifetime. No canonical messages or Project artifacts are created.
- Atomic activation with verified staging and synced files/directories on Linux. Failed repair preserves the old verified version. Known old manifests can remain usable while an explicit update is offered.

## Verification

- Workspace typechecks, production build, ten focused server checks, and deterministic Chromium lifecycle checks.
- Exact 375-file private package: clean install, cancel/retry, offline synthesis, cache reuse/clearing, server restart, corrupt-package repair rollback, removal/reinstall, all three voices at both speed endpoints.
- Clean install on Pine: 2,176 ms. Cache replay: 0.43 ms in the service check (not audible latency).
- Exact native package under its Linux sandbox and 2 GiB limit: cold startup 1,096–1,149 ms; short preview generation 1,769–2,039 ms; cancellation passed for all three voices.
- Real Chromium HTMLAudio check exercises actual install routes, verified notices, HTTP WAV playback, pause/resume/completion, cached replay, hidden-surface stop, and absence of third-party browser requests. See PR #499 for its measured playback-start time and final build evidence.

Pine's tested CPU is Ryzen 5 5500 with 30 GiB RAM. These results do not establish a universal minimum-host recommendation. Windows/macOS native packaging and signing, physical-device media behavior, and broader hardware/upgrade qualification remain separate work.

Focused checks after building:

```sh
node --test apps/server/test/speech.test.mjs
PONDEROSA_PLAYWRIGHT_PATH=/path/to/playwright/index.mjs \
PONDEROSA_CHROMIUM_PATH=/path/to/chrome \
node apps/web/test/speech-browser.check.mjs
PONDEROSA_SPEECH_PACKAGE_DIRECTORY=/path/to/disposable/mirror \
PONDEROSA_PLAYWRIGHT_PATH=/path/to/playwright/index.mjs \
PONDEROSA_CHROMIUM_PATH=/path/to/chrome \
node apps/web/test/speech-native-browser.check.mjs
```

## Pinned inputs

| Archive | SHA-256 |
| --- | --- |
| sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2 | c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4 |
| kokoro-multi-lang-v1_0.tar.bz2 | c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298 |
| espeak-ng-ed530aa113046142eb5115cf2fc9157854d0ffe1.zip | e4e262cbe34f7fe21f91f1ba3397f2728e1f30eafbae7853f2b753a9ed13f0dd |
| piper-phonemize-f3ff95afc03640bc1399e113e83361192a2fafb4.zip | d9cca4e2bdc7d6dd8dffb96a4668283dbd3f77a9c194a3e530c1e8eba9406a5d |

Runtime/model archives come from the pinned `k2-fsa/sherpa-onnx` release tags `v1.13.8` and `tts-models`. Native source dependencies and build inputs are recorded in the accompanying source archive. Do not substitute an unpinned `latest` download.
