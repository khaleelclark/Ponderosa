/** Identify bounded recording containers without decoding or executing their payload. */
export function recordingMediaType(body: Buffer): 'audio/webm' | 'audio/ogg' | 'audio/mp4' | undefined {
  if (body.length < 16) return;
  if (body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const header = body.subarray(0, Math.min(body.length, 65536));
    if (header.includes(Buffer.from([0x42,0x82,0x84,0x77,0x65,0x62,0x6d])) && !header.includes(Buffer.from('V_')) && header.includes(Buffer.from('A_OPUS'))
        && header.includes(Buffer.from('OpusHead'))) return 'audio/webm';
    return;
  }
  if (body.subarray(0, 4).toString('ascii') === 'OggS') {
    let offset = 0, first = true;
    while (offset < body.length) {
      if (offset + 27 > body.length || body.toString('ascii', offset, offset + 4) !== 'OggS' || body[offset + 4] !== 0) return;
      const segments = body[offset + 26]!;
      if (offset + 27 + segments > body.length) return;
      const start = offset + 27 + segments;
      let length = 0;
      for (let index = 0; index < segments; index++) length += body[offset + 27 + index]!;
      if (start + length > body.length || (first && (length < 19 || body.toString('ascii', start, start + 8) !== 'OpusHead'))) return;
      first = false;
      offset = start + length;
    }
    return first ? undefined : 'audio/ogg';
  }
  if (body.toString('ascii', 4, 8) === 'ftyp') {
    let offset = 0, metadata = false, media = false;
    while (offset < body.length) {
      if (offset + 8 > body.length) return;
      let size = body.readUInt32BE(offset), header = 8;
      const type = body.toString('ascii', offset + 4, offset + 8);
      if (size === 1) {
        if (offset + 16 > body.length) return;
        const extended = body.readBigUInt64BE(offset + 8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return;
        size = Number(extended); header = 16;
      } else if (size === 0) size = body.length - offset;
      if (size < header || offset + size > body.length) return;
      if (offset === 0 && size < header + 8) return;
      if (type === 'moov') {
        const box = body.subarray(offset + header, offset + size);
        metadata = box.includes(Buffer.from('soun')) && !box.includes(Buffer.from('vide'))
          && (box.includes(Buffer.from('mp4a')) || box.includes(Buffer.from('Opus')));
      }
      if (type === 'mdat') media = size > header;
      offset += size;
    }
    if (metadata && media) return 'audio/mp4';
  }
}
