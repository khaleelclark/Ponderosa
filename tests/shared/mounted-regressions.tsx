import * as workingFolder from '../chats/working-folder-change-mounted.tsx';
import * as executionActions from '../branches/execution-actions-mounted.tsx';
import * as expertJobs from '../branches/expert-job-handling-mounted.tsx';
// Maintained browser entry. Each case runs in a fresh owned browser context.
import * as fixture0 from '../chats/branch-disclosure-review-mounted.tsx';
import * as fixture1 from '../chats/branch-foreign-continuation-mounted.tsx';
import * as fixture2 from '../chats/branch-generation-history-mounted.tsx';
import * as fixture3 from '../chats/branch-generation-one-mounted.tsx';
import * as fixture4 from '../chats/branch-group-review-mounted.tsx';
import * as fixture5 from '../chats/branch-history-review-mounted.tsx';
import * as fixture6 from '../chats/branch-package-export-mounted.tsx';
import * as fixture7 from '../chats/branch-resource-review-mounted.tsx';
import * as fixture8 from '../chats/branch-runtime-package-mounted.tsx';
import * as fixture9 from '../chats/browser-observation-mounted.tsx';
import * as fixture10 from '../chats/context-recovery-mounted.tsx';
import * as fixture11 from '../chats/group-capture-abandonment-mounted.tsx';
import * as fixture12 from '../chats/group-journal-audit-mounted.tsx';
import * as fixture13 from '../chats/import-live-root-mounted.tsx';
import * as fixture14 from '../chats/lifecycle-discovery-mounted.tsx';
import * as fixture15 from '../chats/lifecycle-review-mounted.tsx';
import * as fixture16 from '../chats/memory-preserve-unknown-mounted.tsx';
import * as fixture17 from '../chats/native-history-ui-mounted.tsx';
import * as fixture18 from '../chats/native-tasks-ui-mounted.tsx';
import * as fixture19 from '../chats/post-import-access-mounted.tsx';
import * as fixture20 from '../chats/request-reply-preview-mounted.tsx';
import * as fixture21 from '../speech/voice-message-recording-mounted.tsx';
import * as fixture22 from '../chats/import-recovery-mounted.tsx';
import * as fixture23 from '../chats/duplicate-destination-mounted.tsx';
import * as fixture24 from '../chats/import-destination-recovery-mounted.tsx';
import * as fixture25 from '../chats/reviewed-continuation-mounted.tsx';

import * as queuedTray from '../chats/queued-tray-mounted.tsx';

type Regression=()=>void|Promise<void>;
const cases=new Map<string,Regression>();
for(const fixture of [workingFolder,queuedTray,executionActions,expertJobs,fixture0,fixture1,fixture2,fixture3,fixture4,fixture5,fixture6,fixture7,fixture8,fixture9,fixture10,fixture11,fixture12,fixture13,fixture14,fixture15,fixture16,fixture17,fixture18,fixture19,fixture20,fixture21,fixture22,fixture23,fixture24,fixture25]){
 for(const [name,value] of Object.entries(fixture)){
  if(typeof value!=='function')continue;
  if(cases.has(name))throw new Error('Duplicate mounted regression: '+name);
  cases.set(name,value as Regression);
 }
}
let started=false;
declare global{interface Window{ponderosaMountedRegression:{list():string[];run(name:string):Promise<void>}}}
window.ponderosaMountedRegression={
 list:()=>[...cases.keys()].sort(),
 async run(name:string){
  if(started)throw new Error('Use a fresh browser context for each mounted regression');
  const regression=cases.get(name);if(!regression)throw new Error('Unknown mounted regression: '+name);
  started=true;await regression();
 },
};
