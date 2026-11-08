/** Assistant can return to an exact Core view; only same-origin app paths qualify. */
export function assistantReturnPath(value:string|null|undefined):string|undefined {
 if(!value?.startsWith('/')||value.startsWith('//'))return undefined;
 try{
  const target=new URL(value,'http://ponderosa.invalid');
  if(target.origin!=='http://ponderosa.invalid'||/^\/(?:assistant|apps|branches)(?:\/|$)/.test(target.pathname))return undefined;
  return target.pathname+target.search+target.hash;
 }catch{return undefined;}
}

/** Legacy global-role bookmarks enter the same main workspace as Assistant navigation. */
export function integratedAssistantPath(pathname:string,search:string):string|undefined {
 if(pathname!=='/assistant')return undefined;
 const source=new URLSearchParams(search),target=new URLSearchParams({assistant:'1'});
 const returnTo=assistantReturnPath(source.get('returnTo'));
 if(returnTo)target.set('returnTo',returnTo);
 return `/branches?${target}`;
}
