import type {DecisionDto} from '@ponderosa/core';

export type PineconeReplyAttempt={text:string;key:string;rejected?:true;decisionId?:string};
export function pendingPineconeDecision(decisions:readonly DecisionDto[],agentId:string):DecisionDto|undefined{
  return decisions.filter(d=>d.agentId===agentId&&d.status==='pending'&&d.blocking&&!d.runtimeAction&&!d.approvalScope&&(d.mode==='text'||d.mode==='choice'))
    .slice().sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];
}
export function preparePineconeReply(text:string,key:string,decision?:Pick<DecisionDto,'id'|'mode'|'allowOther'>):PineconeReplyAttempt{
  if(decision?.mode==='choice'&&!decision.allowOther)throw Error('Choose an offered option for this question.');
  return {text:text.trim(),key,...(decision?{decisionId:decision.id}:{})};
}
/** The immutable UI destination owns routing. Prose never selects a recipient or grants approval. */
export async function deliverPineconeReply<T>(
  attempt:PineconeReplyAttempt,
  sendMessage:(attempt:PineconeReplyAttempt)=>Promise<T>,
  respondDecision:(id:string,response:{text:string})=>Promise<unknown>,
):Promise<T|{queued:true;decisionAnswered:true}>{
  if(!attempt.decisionId)return sendMessage(attempt);
  await respondDecision(attempt.decisionId,{text:attempt.text});
  return {queued:true,decisionAnswered:true};
}
