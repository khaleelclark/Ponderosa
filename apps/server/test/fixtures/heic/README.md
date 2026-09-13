# HEIC upload fixtures

`colors.heic` and `rotated.heic` are synthetic 64×48 quadrant images generated
by `generate.c` using libheif 1.21.2 and x265. They contain no user photographs.
The rotated fixture uses HEIF's native orientation 6 (90° clockwise).

To regenerate with libheif development headers and an HEVC encoder installed:

```sh
cc generate.c $(pkg-config --cflags --libs libheif) -o /tmp/generate-heic
/tmp/generate-heic colors.heic 1
/tmp/generate-heic rotated.heic 6
```

Only fixture generation needs the native encoder. Product uploads use pinned
`libheif-js` 1.23.2 (LGPL-3.0, including its packaged license/source references)
in isolated workers; no host codec installation or browser decoder is needed.

Scope: primary HEVC still images in `.heic`/`.heif` containers. Sequences are
rejected. Original bytes remain downloadable; display and agent input use the
existing bounded PNG rendition (up to 2048px). On browsers without native HEIC
rendering, the unsent attachment falls back to its filename rather than a broken
image; the sent message uses the PNG preview. Existing 8MiB upload/preview and
64-million-pixel limits remain. Two concurrent decoders, at most 18 queued, and
a 15-second per-decode timeout bound decoder work. Worker JS heap limits are
not a hard OS limit on WASM/native memory.

Verification: real encoded fixtures, orientation/pixels, MIME and extension
agreement, truncated/trailing bytes, dimension limit, concurrent uploads,
durable draft ownership/download, and prepared draft-to-asset promotion.
Physical iPhone Photos/Files picker and HDR/Live Photo variants are not claimed
as tested. No real provider runs or user projects were used.
