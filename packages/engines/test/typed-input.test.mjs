// Deferred: run with node --test after the coordinated product build is authorized.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codexTurnContent, claudeTurnContent } from '../dist/typed-input.js';

function fixture(action) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ponderosa-typed-input-'));
  try {
    const file = (name, mediaType, data) => {
      const localPath = path.join(dir, name);
      const body = Buffer.from(data);
      writeFileSync(localPath, body, { mode: 0o600 });
      return { id: name, kind: 'attachment', attachmentOwnerId: 'current-chat',
        source: { kind: 'communication', id: 'current-message' },
        original: { localPath, mediaType, byteLength: body.length,
          sha256: createHash('sha256').update(body).digest('hex') } };
    };
    action(file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('same selected image is native Codex localImage and Claude base64, without media bytes in descriptors', () => fixture(file => {
  const image = file('image.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1cAAAAASUVORK5CYII=', 'base64'));
  const input = { prompt: 'describe', kind: 'user_message', inputFiles: [image] };
  assert.deepEqual(codexTurnContent(input)[1], { type: 'localImage', path: image.original.localPath });
  const native = claudeTurnContent(input)[1];
  assert.equal(native.type, 'image');
  assert.equal(native.source.media_type, 'image/png');
  assert.equal(Buffer.from(native.source.data, 'base64').length, image.original.byteLength);
  assert.equal(JSON.stringify(image).includes(native.source.data), false);
}));

test('PDF is a Claude document; Codex PDF and both audio paths explicitly retain the original', () => fixture(file => {
  const pdf = file('file.pdf', 'application/pdf', '%PDF-1.4\n%%EOF');
  const audio = file('voice.ogg', 'audio/ogg', 'OggS original recording');
  const input = files => ({ prompt: 'review', kind: 'user_message', inputFiles: files });
  assert.equal(claudeTurnContent(input([pdf]))[1].type, 'document');
  assert.equal(codexTurnContent(input([pdf])).length, 1);
  assert.equal(pdf.original.mediaType, 'application/pdf');
  for (const serializer of [codexTurnContent, claudeTurnContent]) {
    const prompt = `Original file reference: ${JSON.stringify(audio)}`;
    const content = serializer({ ...input([audio]), prompt });
    assert.deepEqual(content.map(block => block.type), ['text']);
    assert.equal(content[0].text, prompt);
    assert.ok(content[0].text.includes(audio.original.localPath));
    assert.ok(content[0].text.includes(audio.original.sha256));
  }
}));

test('derived image retains verified original and uses its own representation digest', () => fixture(file => {
  const original = file('photo.heic', 'image/heic', 'original');
  const preview = file('preview.png', 'image/png', 'derived');
  original.image = preview.original;
  const input = { prompt: 'review', kind: 'user_message', inputFiles: [original] };
  assert.equal(codexTurnContent(input)[1].path, preview.original.localPath);
  writeFileSync(original.original.localPath, 'tampered');
  for (const serializer of [codexTurnContent, claudeTurnContent]) assert.throws(() => serializer(input), /changed after admission/);
}));

test('missing provenance and excessive file budget refuse before native payload construction', () => fixture(file => {
  const image = file('image.png', 'image/png', 'original');
  const input = { prompt: 'review', kind: 'user_message', inputFiles: [image] };
  image.source.id = '';
  assert.throws(() => codexTurnContent(input), /provenance/);
  image.source.id = 'current-message';
  image.original.byteLength = 161 * 1024 * 1024;
  assert.throws(() => claudeTurnContent(input), /budget/);
}));
