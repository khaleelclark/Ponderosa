/** Assistant can return to an exact Core view; only same-origin app paths qualify. */
export function assistantReturnPath(value:string|null|undefined):string|undefined {
 if(!value?.startsWith('/')||value.startsWith('//'))return undefined;
 try{
  const target=new URL(value,'http://ponderosa.invalid');
  if(target.origin!=='http://ponderosa.invalid'||/^\/(?:assistant|apps|branches)(?:\/|$)/.test(target.pathname))return undefined;
  return target.pathname+target.search+target.hash;
 }catch{return undefined;}
}

/** Old Branches Assistant bookmarks enter the Core workspace before its queries start. */
export function integratedAssistantPath(pathname:string,search:string):string|undefined {
 if(pathname!=='/branches'||new URLSearchParams(search).get('assistant')!=='1')return undefined;
 const returnTo=assistantReturnPath(new URLSearchParams(search).get('returnTo'));
 return `/assistant${returnTo?`?returnTo=${encodeURIComponent(returnTo)}`:''}`;
}
