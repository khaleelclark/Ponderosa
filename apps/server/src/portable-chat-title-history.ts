/** Only passive new Chat title metadata uses this existing package budget. */
import {AGENT_PACKAGE_MAX_BYTES,agentPackageJsonUtf8Bytes,portableChatTitleHistoryError,type PortableChatTitleChangeDto} from '@ponderosa/core';
import {stableJson} from '@ponderosa/agents';
import {redactKnownDiagnosticValues} from './working-copy-diagnostic.js';
import {redactProviderDiagnostic} from './provider-failure-event.js';
export function mergeChatTitleHistory(...groups:readonly (readonly PortableChatTitleChangeDto[]|undefined)[]):PortableChatTitleChangeDto[]{
 const result=new Map<string,PortableChatTitleChangeDto>();let bytes=2;
 const safe=(text:string)=>redactKnownDiagnosticValues(redactProviderDiagnostic(redactKnownDiagnosticValues(text)));
 for(const group of groups){if(!group)continue;const error=portableChatTitleHistoryError(group);if(error)throw Error(error);
  for(const row of group){const item={...row,change:{...row.change,previousTitle:safe(row.change.previousTitle),title:safe(row.change.title)}};
   const key=JSON.stringify([row.sourceInstanceId,row.projectId,row.conversationId,row.eventId]),prior=result.get(key);
   if(prior&&stableJson(prior)!==stableJson(item))throw Error('Retained Chat title history identity differs');
   if(!prior){bytes+=agentPackageJsonUtf8Bytes(item,AGENT_PACKAGE_MAX_BYTES)+(result.size?1:0);if(bytes>AGENT_PACKAGE_MAX_BYTES)throw Object.assign(Error('Selected Chat title history exceeds the existing package budget; no records were omitted'),{statusCode:413});result.set(key,item);}
  }
 }
 const rows=[...result.values()];agentPackageJsonUtf8Bytes(rows,AGENT_PACKAGE_MAX_BYTES);return rows;
}
