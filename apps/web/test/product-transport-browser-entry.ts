import {realApi} from '../src/api/real';
(window as any).apiProbe=async(ids:any)=>{
 const capture=async(name:string,call:()=>Promise<unknown>)=>{try{return {name,ok:true,value:await call()}}catch(error:any){return {name,ok:false,status:error.status,message:error.message}}};
 return Promise.all([
  capture('Branch Project JSON',()=>realApi.getProject(ids.projectId)),
  capture('Branch Chat JSON',()=>realApi.getConversation(ids.chatId)),
  capture('Branch members collection',()=>realApi.listConversationMembersPage(ids.chatId)),
  capture('Dev Project from Branches',()=>realApi.getProject(ids.devProjectId)),
 ]);
};

const capture=async(call:()=>Promise<unknown>)=>{try{return {ok:true,value:await call()}}catch(error:any){return {ok:false,status:error.status}}};
(window as any).cacheProbe=async({chatId,projectId}:any)=>{
 history.replaceState({},'', '/branches');
 const branch=capture(()=>realApi.listConversationMembersPage(chatId));
 const branchJson=capture(()=>realApi.getProject(projectId));
 const duplicate=capture(()=>realApi.getProject(projectId));
 history.replaceState({},'', '/');
 const dev=capture(()=>realApi.listConversationMembersPage(chatId));
 const devJson=capture(()=>realApi.getProject(projectId));
 return Promise.all([branch,dev,branchJson,devJson,duplicate]);
};
(window as any).directProbe=async({projectId,agentId}:any)=>{
 history.replaceState({},'', '/branches');
 return {exportUrl:realApi.agentExportDownloadUrl(agentId,'template'),frame:await capture(()=>realApi.getBrowserFrame(projectId,agentId,'absent-run'))};
};
