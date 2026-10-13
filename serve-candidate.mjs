import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const root=new URL('./candidate-web-dist/',import.meta.url).pathname;
const candidates=new Map([['49005cab-f4d3-4b38-a468-bf153624e4f4','v5'],['592f4798-cd48-445a-91f2-9f9a86b1c135','v3']]);
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const qualification=url.pathname.match(/^\/api\/(?:branches\/engine\/)?pinecone-candidate\/([^/]+)\/runtime$/);
 if(req.method==='GET'&&qualification&&candidates.has(qualification[1])){
  try{const file=new URL('../candidates/'+candidates.get(qualification[1])+'/pinecone-runtime-capability.json',import.meta.url);const s=await stat(file);if(s.size>8192)throw Error();const q=JSON.parse(await readFile(file,'utf8'));res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({model:q.model,effort:q.effort,supported:q.supported,verifiedAt:q.verifiedAt,error:q.error}));}catch{res.writeHead(503);res.end('Model qualification evidence unavailable')}
  return;
 }
 if(url.pathname.startsWith('/api/')){
  if(req.method!=='GET'){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'This shadow preview does not permit outbound communication or activation.'}));return;}
  const upstream=http.request({hostname:'192.168.1.147',port:18793,path:req.url,method:req.method,headers:{...req.headers,host:'192.168.1.147:18793'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Candidate API unavailable')});req.pipe(upstream);res.on('close',()=>{if(!res.writableEnded)upstream.destroy()});return;
 }
 try{
  let name=decodeURIComponent(url.pathname);if(name==='/'||name==='/branches')name='/index.html';
  const file=path.resolve(root,'.'+name);if(!file.startsWith(root))throw Error();
  await stat(file);const body=await readFile(file);const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)]??'application/octet-stream';
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);
 }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(18795,'0.0.0.0',()=>console.log('Pinecone candidate UI listening on 18795; baseline untouched.'));
