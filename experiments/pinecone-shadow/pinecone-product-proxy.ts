import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {DecisionDto} from '../../packages/core/src/index.js';

export const v5Identity={branchId:'49005cab-f4d3-4b38-a468-bf153624e4f4',agentId:'10649b5d-13f9-4533-84e8-1fcc166de2b8',projectId:'293e1bda-b1f0-5636-8a84-7432ff0d2f6a',conversationId:'89dfe892-a74c-526e-ae94-d84f3025d588'};
const headers={'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"};
export function pineconeDecisionResponseAllowed(decision:DecisionDto|undefined,body:unknown):boolean{
 if(!decision||!body||typeof body!=='object'||Array.isArray(body))return false;
 if(decision.agentId!==v5Identity.agentId||decision.projectId!==v5Identity.projectId||decision.conversationId!==v5Identity.conversationId)return false;
 if(decision.runtimeAction||decision.approvalScope||!['choice','text'].includes(decision.mode)||!['pending','resolved'].includes(decision.status))return false;
 const value=body as Record<string,unknown>;
 if(Object.keys(value).some(k=>!['optionId','text'].includes(k)))return false;
 if('optionId' in value&&typeof value.optionId!=='string'||'text' in value&&typeof value.text!=='string')return false;
 const option=typeof value.optionId==='string'?value.optionId.trim():undefined;
 const text=typeof value.text==='string'?value.text.trim():undefined;
 if(Boolean(option)===Boolean(text)||text&&text.length>10000)return false;
 if(option&&!decision.options.some(o=>o.id===option))return false;
 if(text&&decision.mode!=='text'&&!decision.allowOther)return false;
 if(decision.status==='resolved')return option?decision.response?.optionId===option:decision.response?.text===text;
 return true;
}
export async function servePineconeProduct(req:IncomingMessage,res:ServerResponse,dist:string):Promise<boolean>{
 const u=new URL(req.url??'/','http://pinecone.invalid');
 if(!['GET','HEAD'].includes(req.method??''))return false;
 const legacy=u.pathname==='/branches'&&u.searchParams.get('branch')===v5Identity.branchId&&u.searchParams.get('tab')==='pinecone';
 if(legacy||u.pathname==='/'&&!u.searchParams.has('branch')){
  res.writeHead(302,{...headers,location:'/pinecone','cache-control':'no-store'});res.end();return true;
 }
 let relative:string;
 if(u.pathname==='/pinecone'||u.pathname==='/pinecone/')relative='index.html';
 else if(u.pathname.startsWith('/pinecone/static/')||u.pathname==='/pinecone/version.json'){
  try{relative=decodeURIComponent(u.pathname.slice('/pinecone/'.length))}catch{res.writeHead(400,headers);res.end();return true}
 }else return false;
 const file=path.resolve(dist,relative);
 if(!file.startsWith(path.resolve(dist)+path.sep)||relative.includes('\\')||relative.includes('\0')){
  res.writeHead(404,headers);res.end();return true;
 }
 try{
  const data=await readFile(file);
  const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff'};
  res.writeHead(200,{...headers,'content-type':mime[path.extname(file)]??'application/octet-stream','cache-control':relative==='index.html'||relative==='version.json'?'no-store':'public, max-age=31536000, immutable'});
  res.end(req.method==='HEAD'?undefined:data);
 }catch{res.writeHead(404,headers);res.end('Pinecone asset unavailable')}
 return true;
}
