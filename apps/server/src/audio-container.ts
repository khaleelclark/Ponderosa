type EbmlElement = { id: number; start: number; end: number; unknown: boolean };
function ebmlElement(body: Buffer, offset: number, end: number): EbmlElement | undefined {
  const read = (at: number, identifier: boolean) => {
    const first = body[at];
    if (!first) return;
    let width = 1, mask = 0x80;
    while (!(first & mask)) { width++; mask >>= 1; }
    if (width > (identifier ? 4 : 8) || at + width > end) return;
    let value = BigInt(identifier ? first : first & (mask - 1));
    let unknown = !identifier && (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < width; i++) {
      value = value * 256n + BigInt(body[at + i]!);
      unknown = unknown && body[at + i] === 255;
    }
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) return;
    return { width, value: Number(value), unknown };
  };
  const id = read(offset, true);
  if (!id) return;
  const size = read(offset + id.width, false);
  if (!size) return;
  const start = offset + id.width + size.width;
  const finish = size.unknown ? end : start + size.value;
  if (finish > end || finish < start) return;
  return { id: id.value, start, end: finish, unknown: size.unknown };
}

/** Inspect TrackEntry metadata, never byte patterns inside compressed clusters. */
function isOpusWebm(body: Buffer): boolean {
  const header = ebmlElement(body, 0, body.length);
  if (!header || header.id !== 0x1a45dfa3 || header.unknown || header.end > 65536) return false;
  let webm = false;
  for (let p = header.start; p < header.end;) {
    const e = ebmlElement(body, p, header.end);
    if (!e || e.unknown) return false;
    if (e.id === 0x4282) webm = body.subarray(e.start, e.end).equals(Buffer.from('webm'));
    p = e.end;
  }
  if (!webm) return false;
  const segment = ebmlElement(body, header.end, body.length);
  if (!segment || segment.id !== 0x18538067) return false;
  let tracks = 0, media = false;
  for (let p = segment.start; p < segment.end;) {
    const e = ebmlElement(body, p, segment.end);
    if (!e || (e.unknown && e.id !== 0x1f43b675)) return false;
    if (e.id === 0x1f43b675) {
      if (!tracks || e.end === e.start) return false;
      media = true; // An unknown-size native Cluster owns the remaining opaque payload.
    }
    if (e.id === 0x1654ae6b) {
      if (tracks || e.end > 65536) return false;
      for (let q = e.start; q < e.end;) {
        const entry = ebmlElement(body, q, e.end);
        if (!entry || entry.unknown) return false;
        if (entry.id === 0xae) {
          let audio = false, opus = false, privateHeader = false;
          for (let s = entry.start; s < entry.end;) {
            const field = ebmlElement(body, s, entry.end);
            if (!field || field.unknown) return false;
            if (field.id === 0x83) {
              if (audio || field.end - field.start !== 1 || body[field.start] !== 2) return false;
              audio = true;
            }
            if (field.id === 0x86) {
              if (opus || !body.subarray(field.start, field.end).equals(Buffer.from('A_OPUS'))) return false;
              opus = true;
            }
            if (field.id === 0x63a2) {
              if (privateHeader || field.end - field.start < 19 || !body.subarray(field.start, field.start + 8).equals(Buffer.from('OpusHead'))) return false;
              privateHeader = true;
            }
            s = field.end;
          }
          if (!audio || !opus || !privateHeader) return false;
          tracks++;
        }
        q = entry.end;
      }
      if (!tracks) return false;
    }
    p = e.end;
  }
  return tracks > 0 && media;
}

/** Identify bounded recording containers without decoding or executing their payload. */
export function recordingMediaType(body: Buffer): 'audio/webm' | 'audio/ogg' | 'audio/mp4' | undefined {
  if (body.length < 16) return;
  if (body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return isOpusWebm(body) ? 'audio/webm' : undefined;
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
