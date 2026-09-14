import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const {projects}=JSON.parse(readFileSync('/tmp/ponderosa-perf-sandbox.json','utf8'));
const origin='http://127.0.0.1:21843', chat=projects[0].conversations[0].id;
const label=process.argv[2]??'baseline';
const results={};
for(const loaded of [false,true]) {
  let stop=false;
  const load=loaded?Promise.all([0,1].map(async()=>{while(!stop){await (await fetch(`${origin}/api/workspace/directory/agent?active=true`)).arrayBuffer();}})):Promise.resolve();
  const sends=[],uploads=[],phases=[];
  try {
    for(let i=0;i<12;i++) {
      let t=performance.now();const send=await fetch(`${origin}/api/conversations/${chat}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'#broadcast Disposable performance sample '+ 'x'.repeat(2048),idempotencyKey:randomUUID()})});
      const sendBody=await send.text();if(!send.ok)throw Error(`${send.status}: ${sendBody}`);sends.push(performance.now()-t);phases.push(send.headers.get('server-timing'));
      t=performance.now();const upload=await fetch(`${origin}/api/conversations/${chat}/draft-attachments`,{method:'POST',headers:{'content-type':'application/octet-stream','x-ponderosa-media-type':'text/plain','x-ponderosa-filename':'sample.txt','x-ponderosa-draft-owner':'perf-owner'},body:'sample text\n'.repeat(22000)});
      const body=await upload.json();if(!upload.ok)throw Error(JSON.stringify(body));uploads.push(performance.now()-t);
      const id=body.id??body.attachment?.id;if(!id)throw Error(JSON.stringify(body));
      const deleted=await fetch(`${origin}/api/conversations/${chat}/draft-attachments/${id}?ownerId=perf-owner`,{method:'DELETE'});if(!deleted.ok)throw Error(await deleted.text());
    }
  }finally{stop=true;await load;}
  const dist=a=>{a.sort((x,y)=>x-y);return{count:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)}};
  results[loaded?'concurrent-directory-load':'idle']={send:dist(sends),upload:dist(uploads),serverTiming:phases};
}
writeFileSync(`/tmp/ponderosa-perf-${label}-send-upload.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
