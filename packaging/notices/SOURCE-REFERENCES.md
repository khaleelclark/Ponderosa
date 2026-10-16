# Third-party source references

Third-party components retain their respective licenses. The notice collection does not license Ponderosa's original code. These private candidate packages are not cleared for public release by the presence of notices alone.

## Fonts

Inter uses the SIL Open Font License 1.1; its complete notice is in the browser notice collection. PDF.js's Foxit fonts and Adobe CMaps retain the notices copied with their assets.

The four Liberation Sans TTF files supplied by PDF.js 6.3.289 are byte-identical to Debian's `fonts-liberation 1.07.4-11` package. They use the Liberation license with GPLv2 and the Liberation font exception, not the OFL license for Liberation 2.x. The corrected `LICENSE_LIBERATION` is included in the browser notice collection and beside the font assets.

Matching editable font sources, Debian patches and build rules accompany the browser distribution under `notices/sources/liberation/`: `fonts-liberation_1.07.4.orig.tar.gz`, `fonts-liberation_1.07.4-11.debian.tar.xz` and the `.dsc` source descriptor. Archive checksums match the `.dsc`; its OpenPGP signature and a reproducible rebuild were not verified. The binary provenance is [Debian's versioned package](https://deb.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_1.07.4-11_all.deb). Preserve all upstream notices and exceptions when redistributing these fonts; they are not relicensed by Ponderosa's first-party license.

## MPL components

Preferred source archives accompany the browser distribution under `notices/sources/mpl/`:

- noVNC 1.5.0: [source revision 7fcf9dcfe0cc5b14e3841a4429dc091a6ffca861](https://github.com/novnc/noVNC/tree/7fcf9dcfe0cc5b14e3841a4429dc091a6ffca861). The browser bundles the published npm distribution. Ponderosa has not changed the upstream package files.
- web-push 3.6.7: [source revision 8d9ba1b33bfe0d73ccf3606c59ead4287f50e3b8](https://github.com/web-push-libs/web-push/tree/8d9ba1b33bfe0d73ccf3606c59ead4287f50e3b8). Preferred JavaScript is also supplied in the installed engine dependency. The source archive accompanies this candidate for convenience.

MPL-covered files remain under MPL 2.0. Notices do not impose MPL on unrelated original application files.

## Native and WASM libraries: distribution review remains open

Engine package notices preserve the sharp, libvips and libheif-js license texts. `notices/native/` supplies additional versioned upstream source license references. Some texts apply to source-only utilities or documentation; their inclusion does not establish that those components are linked. This is not a complete native bill of materials.

- libheif-js 1.23.2: [wrapper source](https://github.com/catdad-experiments/libheif-js/tree/6ca00b818c0ff51cb2a5c75b9ce97d708083335a), [WASM build recipe](https://github.com/catdad-experiments/libheif-emscripten/tree/dd5a19b878149437a5a427f6e1afa8bac624a714), [libheif source](https://github.com/strukturag/libheif/tree/ac1cb05c39008f01525c991ff8b88f84ddf70fd2), [libde265 1.0.15](https://github.com/strukturag/libde265/releases/tag/v1.0.15).
- sharp libvips 1.3.4: [pinned POSIX packaging recipe](https://github.com/lovell/sharp-libvips/tree/ebb95f8add54eee8bed840e3fb587e4cbec857d7). Versioned source candidates and patches have been retrieved for review. The library versions are checked when collecting notices.
- Windows sharp 0.35.5: [libvips 8.18.7 MXE build release](https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.7). Windows uses this separate build route; a POSIX recipe alone is insufficient.

Before public distribution, confirm complete corresponding sources and build inputs for the actual linked libraries, including transitive Rust dependencies, and the applicable LGPL replacement/relinking and installation requirements for the native and embedded WASM combinations. Qualified review remains necessary for this determination. Upstream links alone and a collection of candidate archives are not an adopted source offer or proof of compliance.

## Node and Electron

The full Node license is copied from the checksummed target archive into `runtime/LICENSE`, with its hash in the build manifest. It includes embedded-component notices. Electron and Chromium texts come from the exact target distribution and are retained inside the desktop application's resources. Preserve the complete texts. [Node source](https://github.com/nodejs/node/tree/v24.16.0) and [Electron source](https://github.com/electron/electron/tree/v43.5.0) are starting references; embedded source-sensitive components also belong in final distribution review.
