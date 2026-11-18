import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {recordingMimeType,recordingExtension} from '../../apps/web/src/components/speech/voiceRecording.ts';

test('voice attachments preserve the browser container and use matching file extensions',()=>{
 for(const [mime,extension] of [['audio/webm;codecs=opus','webm'],['audio/mp4','m4a'],['audio/ogg;codecs=opus','ogg']]){
  const selected=recordingMimeType(value=>value===mime);
  assert.equal(selected,mime);
  assert.equal(recordingExtension(selected.split(';')[0]),extension);
 }
 assert.equal(recordingMimeType(()=>false),undefined,'let the browser choose its native recording format');
 assert.equal(recordingExtension('application/octet-stream'),'audio','unknown containers are never mislabeled as a supported format');
});
