import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {candidateMutationAllowed} from './preview-policy.mjs';
const root=new URL('./candidate-web-dist/',import.meta.url).pathname;
const candidates=new Map([['49005cab-f4d3-4b38-a468-bf153624e4f4','v5'],['592f4798-cd48-445a-91f2-9f9a86b1c135','v3']]);
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const qualification=url.pathname.match(/^\/api\/(?:branches\/engine\/)?pinecone-candidate\/([^/]+)\/runtime$/);
 if(req.method==='GET'&&qualification&&candidates.has(qualification[1])){
  try{const file=new URL('../candidates/'+candidates.get(qualification[1])+'/pinecone-runtime-capability.json',import.meta.url);const s=await stat(file);if(s.size>8192)throw Error();const q=JSON.parse(await readFile(file,'utf8'));res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({model:q.model,effort:q.effort,supported:q.supported,verifiedAt:q.verifiedAt,error:q.error,deliveryMode:q.deliveryMode??'shadow'}));}catch{res.writeHead(503);res.end('Model qualification evidence unavailable')}
  return;
 }
 if(url.pathname.startsWith('/api/')){
  let prepared;
  if(req.method!=='GET'){
   if(req.headers.origin&&req.headers.origin!==('http://'+req.headers.host)){res.writeHead(403);res.end('Cross-origin candidate mutation forbidden');return;}
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>9*1024*1024){res.writeHead(413);res.end('Message too large');return;}}
   let body,installations=[];try{body=JSON.parse(raw);for(const [id,v]of candidates){const q=JSON.parse(await readFile(new URL('../candidates/'+v+'/pinecone-runtime-capability.json',import.meta.url),'utf8'));installations.push({...q,branchId:id});}}catch{}
   if(!candidateMutationAllowed(req.method,url.pathname,body,installations)){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Only the activated candidate spokesperson, Check now, and schedule pause controls are available.'}));return;}
   const ownSpeaker=installations.find(i=>i.deliveryMode==='user-ui'&&i.supported===true&&url.pathname.endsWith('/agents/'+i.spokespersonId+'/messages'));
   prepared=ownSpeaker?JSON.stringify({...body,model:ownSpeaker.model,effort:ownSpeaker.effort}):raw;
  }
  const headers={...req.headers,host:req.headers.host??'192.168.1.147:18793'};if(prepared!==undefined){delete headers['transfer-encoding'];headers['content-length']=String(Buffer.byteLength(prepared));}
  const upstream=http.request({hostname:'192.168.1.147',port:18793,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Candidate API unavailable')});if(prepared!==undefined)upstream.end(prepared);else req.pipe(upstream);res.on('close',()=>{if(!res.writableEnded)upstream.destroy()});return;
 }
 try{
  let name=decodeURIComponent(url.pathname);if(name==='/'||name==='/branches')name='/index.html';
  const file=path.resolve(root,'.'+name);if(!file.startsWith(root))throw Error();
  await stat(file);const body=await readFile(file);const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)]??'application/octet-stream';
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);
 }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(18795,'0.0.0.0',()=>console.log('Pinecone candidate UI listening on 18795; baseline untouched.'));
