import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceStore } from "../dist/index.js";
import { normalizeSpeechPreferences, validSpeechPreferences } from "@ponderosa/core";

test("retired voice fields cannot survive preference replay or later writes", () => {
  const root = mkdtempSync(join(tmpdir(),"browser-speech-"));
  try {
    const store = new WorkspaceStore(root);
    const speech = {speed:1.1,engine:"retired-provider",engineExplicit:true,kokoroVoice:"voice_2",localVoiceSuggestion:"accepted"};
    store.append({type:"preferences_updated",preferences:{...store.getPreferences(),speech}});
    assert.deepEqual(store.getPreferences().speech,{speed:1.1});
    const reopened = new WorkspaceStore(root);
    assert.deepEqual(reopened.getPreferences().speech,{speed:1.1});
    assert.deepEqual(reopened.updatePreferences({speech}).speech,{speed:1.1});
    assert.equal(validSpeechPreferences(speech),false);
    assert.equal(validSpeechPreferences({speed:1}),true);
    assert.deepEqual(normalizeSpeechPreferences({speed:Infinity}),{speed:1});
  } finally {rmSync(root,{recursive:true,force:true});}
});
