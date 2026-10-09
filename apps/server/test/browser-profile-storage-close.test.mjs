import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,chmodSync,readlinkSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {BrowserProfileAuthority,BrowserProfileError} from '../dist/browser-profile-authority.js';

const ownReaders=root=>readdirSync('/proc/self/fd').flatMap(fd=>{
  try{const target=readlinkSync(`/proc/self/fd/${fd}`);return target.startsWith(`${root}/`)?[{fd,target}]:[];}catch{return [];}
});

test('browser profile storage closes only after real launch ownership settles',async()=>{
  const root=mkdtempSync(join(tmpdir(),'bpc-'));chmodSync(root,0o700);
  const profiles=new BrowserProfileAuthority(root,{PONDEROSA_BROWSER_MAX_ACTIVE:'1'});
  const admitted=new AbortController(),cancelled=new AbortController(),promoted=new AbortController();
  let first,next,cancelOutcome,nextOutcome,primary;const secondary=[];
  console.log('PROFILE FIXTURE '+JSON.stringify({root,mode:0o700,realAuthority:true,browserLaunches:0}));
  const observe=phase=>{
    const state={phase,status:profiles.status(),readers:ownReaders(root)};
    console.log('PROFILE OWNERSHIP '+JSON.stringify(state));return state;
  };
  const closeDenied=phase=>{
    let error;try{profiles.close();}catch(failure){error=failure;}
    console.log('PROFILE CLOSE DENIED '+JSON.stringify({phase,name:error?.name??null,message:error?.message??null,statusCode:error?.statusCode??null}));
    assert.ok(error instanceof BrowserProfileError);assert.equal(error.statusCode,409);
    assert.match(error.message,/active or queued launch leases/);
  };
  try{
    const profile=profiles.createProfile('disposable-test','Preserved profile');
    let queuedOnlyObserved=false;
    first=await profiles.acquire('first',{profileMode:'trusted',profileId:profile.id,profileName:profile.name},admitted.signal,()=>{
      const state=observe('queued before admission');
      assert.equal(state.status.active,0);assert.equal(state.status.queued,1);
      closeDenied('queued only');queuedOnlyObserved=true;
    });
    assert.equal(queuedOnlyObserved,true);
    const queue=[];
    cancelOutcome=profiles.acquire('cancelled',{profileMode:'disposable'},cancelled.signal,(position,reason)=>queue.push({session:'cancelled',position,reason})).then(lease=>({lease}),error=>({error}));
    nextOutcome=profiles.acquire('promoted',{profileMode:'disposable'},promoted.signal,(position,reason)=>queue.push({session:'promoted',position,reason})).then(lease=>({lease}),error=>({error}));
    const queued=observe('active and queued');console.log('PROFILE QUEUE '+JSON.stringify(queue));
    assert.equal(queued.status.active,1);assert.equal(queued.status.queued,2);assert.ok(queued.readers.length>0);
    closeDenied('active and queued');
    cancelled.abort();const cancellation=await cancelOutcome;
    console.log('PROFILE CANCELLED '+JSON.stringify({message:cancellation.error?.message??null,status:profiles.status()}));
    assert.ok(cancellation.error instanceof BrowserProfileError);assert.match(cancellation.error.message,/cancelled/);assert.equal(cancellation.lease,undefined);
    closeDenied('active and remaining queued');
    first.release();first=undefined;
    const promotion=await nextOutcome;next=promotion.lease;
    console.log('PROFILE PROMOTED '+JSON.stringify({error:promotion.error?.message??null,lease:next?{profileMode:next.profileMode}:null,status:profiles.status()}));
    assert.equal(promotion.error,undefined);assert.ok(next);
    const active=observe('promoted lease');assert.equal(active.status.active,1);assert.equal(active.status.queued,0);
    closeDenied('active only');
    assert.deepEqual(profiles.getProfile('disposable-test',profile.id),profile,'denied close preserves catalog access');
    next.release();next.release();next=undefined;
    const settled=observe('settled before close');assert.equal(settled.status.active,0);assert.equal(settled.status.queued,0);assert.ok(settled.readers.length>0);
    profiles.close();profiles.close();
    const closed=observe('closed twice');assert.deepEqual(closed.readers,[]);
    const admission=await profiles.acquire('after-close',{profileMode:'disposable'},new AbortController().signal,()=>{}).then(lease=>({lease}),error=>({error}));
    console.log('PROFILE ADMISSION DENIED '+JSON.stringify({message:admission.error?.message??null,statusCode:admission.error?.statusCode??null,status:profiles.status()}));
    assert.ok(admission.error instanceof BrowserProfileError);assert.equal(admission.error.statusCode,409);assert.match(admission.error.message,/authority is closed/);assert.equal(admission.lease,undefined);
    console.log('PROFILE REGRESSION PASS '+JSON.stringify({browserLaunches:0,activeAndQueuedDenied:true,cancellationAwaited:true,promotionAwaited:true,settledReaders:closed.readers,repeatedClose:true,closedAdmissionDenied:true}));
  }catch(error){primary=error;console.log('PROFILE PRIMARY '+JSON.stringify({name:error.name,message:error.message,stack:error.stack}));}
  finally{
    // Cancel and await only this test's queue outcomes, then release its leases
    // through their public ownership API before normal storage closure.
    admitted.abort();cancelled.abort();promoted.abort();
    for(const outcome of [cancelOutcome,nextOutcome]){
      try{const result=await outcome;result?.lease?.release();}catch(error){secondary.push(error);}
    }
    first?.release();next?.release();
    try{profiles.close();}catch(error){secondary.push(error);}
    const readers=ownReaders(root),database=readFileSync(join(root,'browser-profile-authority.sqlite'));
    console.log('PROFILE SETTLED '+JSON.stringify({root,rootsPreserved:true,primary:primary?.message??null,secondary:secondary.map(error=>({name:error.name,message:error.message})),status:profiles.status(),remainingOwnReaders:readers,databaseBytes:database.length,databaseSha256:createHash('sha256').update(database).digest('hex')}));
    try{assert.deepEqual(readers,[]);}catch(error){secondary.push(error);}
    if(secondary.length)throw new AggregateError([...(primary?[primary]:[]),...secondary],'Browser profile regression or normal cleanup failed');
  }
  if(primary)throw primary;
});
