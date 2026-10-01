import assert from "node:assert/strict";
import test from "node:test";
import { validAvif } from "../dist/image-containers.js";
import { prepareAssetUpload } from "../dist/assets.js";

function container(compatibleBrands, { major = "mif1", extended = false, padding = 0 } = {}) {
  const header = extended ? 16 : 8;
  const ftypSize = header + 8 + compatibleBrands * 4 + padding;
  const body = Buffer.alloc(ftypSize + 21);
  body.writeUInt32BE(extended ? 1 : ftypSize);
  body.write("ftyp", 4);
  if (extended) body.writeBigUInt64BE(BigInt(ftypSize), 8);
  body.write(major, header);
  for (let index = 0; index < compatibleBrands; index++) body.write("mif1", header + 8 + index * 4);
  if (compatibleBrands) body.write("avif", header + 8 + (compatibleBrands - 1) * 4);
  body.writeUInt32BE(12, ftypSize); body.write("meta", ftypSize + 4);
  body.writeUInt32BE(9, ftypSize + 12); body.write("mdat", ftypSize + 16);
  body[ftypSize + 20] = 1;
  return { body, header, ftypSize };
}

// Instrument only this buffer, not global Buffer methods or concurrent tests.
function observeBrandReads({ body, header, ftypSize }) {
  let reads = 0;
  const read = body.readUInt32BE, slice = body.subarray;
  const isBrand = offset => offset === header || offset >= header + 8 && offset < ftypSize;
  body.readUInt32BE = function(offset, ...args) {
    if (isBrand(offset)) reads++;
    return read.call(this, offset, ...args);
  };
  body.subarray = function(start, ...args) {
    if (isBrand(start)) reads++;
    return slice.call(this, start, ...args);
  };
  return () => reads;
}

test("AVIF brand scan supports major/compatible brands and the 64-brand boundary in both box headers", () => {
  for (const extended of [false, true]) {
    assert.equal(validAvif(container(0, { major: "avif", extended }).body), true);
    assert.equal(validAvif(container(0, { major: "avis", extended }).body), true);
    assert.equal(validAvif(container(1, { extended }).body), true);
    const fixture = container(64, { extended });
    const reads = observeBrandReads(fixture);
    assert.equal(validAvif(fixture.body), true);
    assert.equal(reads(), 65);
    assert.equal(validAvif(container(0, { extended }).body), false);
    assert.equal(validAvif(container(1, { extended, padding: 1 }).body), false);
  }
});

test("oversized AVIF ftyp boxes reject before reading any brands, including a supported major brand", () => {
  for (const count of [65, 5_000]) for (const extended of [false, true]) {
    const fixture = container(count, { major: "avif", extended });
    const reads = observeBrandReads(fixture);
    assert.equal(validAvif(fixture.body), false);
    assert.equal(reads(), 0, "oversized ftyp must be rejected before scanning or collecting brands");
  }
});

test("production attachment preparation rejects the 5,000-brand container without scanning its brands", async () => {
  const fixture = container(5_000);
  const reads = observeBrandReads(fixture);
  await assert.rejects(prepareAssetUpload({ body: fixture.body, name: "oversized.avif", declaredType: "image/avif" }), error => error.statusCode === 415);
  assert.equal(reads(), 0, "admission must reject before the decoder or an unbounded brand scan");
});
