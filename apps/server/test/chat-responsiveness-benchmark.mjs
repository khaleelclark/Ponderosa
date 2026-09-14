import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
const {projects,dataDir}=JSON.parse(readFileSync('/tmp/ponderosa-perf-sandbox.json','utf8'));
if(!dataDir.startsWith('/tmp/ponderosa-directory-perf-'))throw Error('Not disposable');
const chat=projects[0].conversations[0].id,origin='http://127.0.0.1:21843';
const width=2048,height=1536,pixels=Buffer.alloc(width*height*3);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
 const i=(y*width+x)*3;pixels[i]=(x*255/width+y*15/height)%256;pixels[i+1]=(y*255/height+x*35/width)%256;pixels[i+2]=((x^y)%128)+64;
}
const image=await sharp(pixels,{raw:{width,height,channels:3}}).jpeg({quality:90}).toBuffer();
const result={bytes:image.length,uploadMs:[],sendMs:[],phases:[]};
for(let i=0;i<3;i++){
 const t=performance.now();const res=await fetch(`${origin}/api/conversations/${chat}/draft-attachments`,{method:'POST',headers:{'content-type':'application/octet-stream','x-ponderosa-media-type':'image/jpeg','x-ponderosa-filename':'synthetic.jpg','x-ponderosa-draft-owner':'diagnostic'},body:image});
 const body=await res.json();if(!res.ok)throw Error(JSON.stringify(body));result.uploadMs.push(performance.now()-t);
 await fetch(`${origin}/api/conversations/${chat}/draft-attachments/${body.id}?ownerId=diagnostic`,{method:'DELETE'});
}
for(let i=0;i<30;i++){
 const t=performance.now();const res=await fetch(`${origin}/api/conversations/${chat}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'#broadcast Disposable timing sample '+i+' '+('bounded history '.repeat(200)),idempotencyKey:randomUUID()})});
 if(!res.ok)throw Error(await res.text());await res.arrayBuffer();result.sendMs.push(performance.now()-t);result.phases.push(res.headers.get('server-timing'));
}
console.log(JSON.stringify(result));
