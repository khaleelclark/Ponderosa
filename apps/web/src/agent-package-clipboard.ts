/** Large full exports use the existing download path without constructing one
 * browser string or placing a partial document on the clipboard. */
export class AgentPackageDownloadRequired extends Error {
 readonly preparedExport?:{downloadUrl:string;expiresAt:string;byteLength:number};
 constructor(preparedExport?:{downloadUrl:string;expiresAt:string;byteLength:number},options?:ErrorOptions){
  super('Use Download for the complete Agent package; clipboard transfer could not complete.',options);
  this.preparedExport=preparedExport;
 }
}
export async function readAgentPackageClipboard(response:Response,maximum=8*1024*1024):Promise<string>{
 if(Number(response.headers.get('Content-Length'))>maximum){await response.body?.cancel();throw new AgentPackageDownloadRequired();}
 const reader=response.body?.getReader();if(!reader)throw new Error('The Agent package response was empty.');
 const decoder=new TextDecoder('utf-8',{fatal:true});const pieces:string[]=[];let bytes=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>maximum)throw new AgentPackageDownloadRequired();pieces.push(decoder.decode(chunk.value,{stream:true}));}pieces.push(decoder.decode());return pieces.join('');}
 catch(error){await reader.cancel().catch(()=>undefined);throw error;}
 finally{reader.releaseLock();}
}
