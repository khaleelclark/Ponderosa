// Deferred source fixtures; no execution authorized.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {consoleResultValid,recordingArtifactValid,recordingCommandValid,recordingDataValid,recordingStatusValid} from '../../apps/web/src/components/browser/browserObservation.ts';
const status={id:'recording',pageId:'page',startedAt:'2026-11-01T00:00:00Z'};
const artifact={artifactId:'artifact',artifactRef:'ponderosa://artifact/artifact',path:'browser/artifact.recording.json',mediaType:'application/json',frames:2,reason:'explicit_stop',downloadUrl:'/api/projects/project/artifacts/artifact/download'};
const data={...status,format:'ponderosa.browser-recording.v1',endedAt:'2026-11-01T00:00:01Z',reason:'explicit_stop',frames:[{atMs:0,jpeg:'/9j/AAAA'},{atMs:900,jpeg:'/9j/BBBB'}]};
test('managed receipt and exact timestamped JPEG frame projection refuse foreign evidence',()=>{
 assert.ok(recordingStatusValid(status));assert.ok(recordingArtifactValid(artifact,'project'));assert.ok(recordingDataValid(data,status,artifact));
 for(const patch of [{downloadUrl:'https://foreign.test/recording'},{downloadUrl:'/api/projects/other/artifacts/artifact/download'},{downloadUrl:'/api/projects/project/artifacts/other/download'},{mediaType:'video/mp4'},{frames:0},{frames:121},{reason:'invented'}])assert.equal(recordingArtifactValid({...artifact,...patch},'project'),false);
 for(const patch of [{id:'other'},{pageId:'other'},{format:'video/mp4'},{reason:'page_closed'},{startedAt:'2026-11-01T00:00:01Z'},{endedAt:'invalid'},{frames:[]},{frames:[{atMs:900,jpeg:'/9j/AAAA'},{atMs:0,jpeg:'/9j/BBBB'}]},{frames:[{atMs:0,jpeg:'https://remote.test/a'},{atMs:60001,jpeg:'/9j/BBBB'}]}])assert.equal(recordingDataValid({...data,...patch},status,artifact),false);
});
test('console pagination stays on the selected page/filter and exposes eviction without clearing',()=>{
 const entry={sequence:12,at:status.startedAt,pageId:'page',level:'error',text:'<script>is plain text</script>'},result={entries:[entry],next:20,truncated:true};
 assert.ok(consoleResultValid(result,'page',10,'error'));assert.ok(consoleResultValid({entries:[],next:20,truncated:false},'page',20));
 for(const value of [{...result,next:11},{...result,entries:[entry,entry]},{...result,entries:[{...entry,pageId:'other'}]},{...result,entries:[{...entry,text:'x'.repeat(4001)}]},{...result,truncated:'false'}])assert.equal(consoleResultValid(value,'page',10,'error'),false);
 assert.equal(consoleResultValid(result,'page',10,'warning'),false);
});
test('saved commands retain exact original session and epoch, never inferred ownership',()=>{
 const context={sessionId:'session',expectedControlEpoch:7};
 assert.ok(recordingCommandValid({context,operation:'start',pageId:'page',previousRecordingId:'old'}));assert.ok(recordingCommandValid({context,operation:'stop',recordingId:'original'}));
 for(const value of [null,{}, {context:{...context,expectedControlEpoch:-1},operation:'start',pageId:'page'},{context,operation:'stop',recordingId:''},{context,operation:'start',pageId:'page',previousRecordingId:12}])assert.equal(recordingCommandValid(value),false);
});

test('shared recording binds exact destination and independent managed artifact ID',()=>{
 const destination={projectId:'actual-project',conversationId:'actual-chat'};
 const shared={artifactId:'artifact-uuid',artifactRef:'ponderosa://artifact/artifact-uuid',path:'browser/artifact-uuid.recording.json',mediaType:'application/json',frames:1,reason:'explicit_stop',downloadUrl:'/api/projects/actual-project/artifacts/artifact-uuid/download',destination};
 assert.ok(recordingArtifactValid(shared,destination.projectId,destination));
 assert.equal(recordingArtifactValid(shared,'other-project',destination),false);
 assert.equal(recordingArtifactValid({...shared,destination:{...destination,conversationId:'other-chat'}},destination.projectId,destination),false);
 assert.equal(recordingArtifactValid({...shared,destination:undefined},destination.projectId,destination),false);
 assert.ok(recordingCommandValid({context:{sessionId:'session',expectedControlEpoch:2,destination:{conversationId:destination.conversationId}},destinationEvidence:destination,operation:'start',pageId:'page'}));
 assert.equal(recordingCommandValid({context:{sessionId:'session',expectedControlEpoch:2,destination:{conversationId:'redirect'}},destinationEvidence:destination,operation:'start',pageId:'page'}),false);
});
