// Structured credential fields only: free-form history retains its exact text.
const secretField = /^(?:authorization|password|passwd|credentials|secrets?|secretBindings|token|authToken|capabilityToken|messageCapability|bearerToken|signingSecret|vapidPrivateKey|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)$/i;
const providerSecretFields = new Set([
  'openaiapikey', 'openaiadminkey', 'openaiaccesstoken', 'openaiauthtoken',
  'anthropicapikey', 'anthropicauthtoken', 'claudecodeoauthtoken', 'codexapikey',
  'azureopenaiapikey', 'azureopenaiadtoken', 'geminiapikey', 'googleapikey',
  'googleapplicationcredentials', 'awsaccesskeyid', 'awssecretaccesskey', 'awssessiontoken',
  'ponderosavapidprivatekey',
]);
export const PORTABLE_SECRET_MAX_BYTES = 64 * 1024 * 1024;
export const PORTABLE_SECRET_MAX_DEPTH = 64;

export function isPortableSecretField(key:string):boolean {
  return secretField.test(key) || providerSecretFields.has(key.replace(/[_-]/g,'').toLowerCase());
}

/** Shared export scrub/import check. Every decoded string consumes the same
 * inspection budget; unchanged strings retain their original bytes. */
export function withoutPortableSecrets(value:unknown,maxBytes=PORTABLE_SECRET_MAX_BYTES):unknown {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new Error('Portable structured data byte limit is invalid');
  let remaining=Math.min(maxBytes,PORTABLE_SECRET_MAX_BYTES);
  const charge=(bytes:number)=>{
    remaining-=bytes;
    if(remaining<0)throw Object.assign(new Error('Portable structured data exceeds the inspection byte limit'),{statusCode:413});
  };
  const visit=(item:unknown,depth:number):unknown=>{
    if(depth>PORTABLE_SECRET_MAX_DEPTH)throw new Error('Portable structured data exceeds the supported nesting depth');
    charge(8);
    if(typeof item==='string'){
      charge(Buffer.byteLength(item));
      if(!/^[\s]*[\[{"]/.test(item))return item;
      let parsed:unknown;try{parsed=JSON.parse(item);}catch{return item;}
      const safe=visit(parsed,depth+1);
      return JSON.stringify(parsed)===JSON.stringify(safe)?item:JSON.stringify(safe);
    }
    if(Array.isArray(item))return item.map(child=>visit(child,depth+1));
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).flatMap(([key,child])=>{
      charge(Buffer.byteLength(key));
      return isPortableSecretField(key)?[]:[[key,visit(child,depth+1)]];
    }));
    return item;
  };
  return visit(value,0);
}

/** Validate metadata only; user-authored text remains outside this policy. */
export function assertPortableSecretsAbsent(value:unknown,label='Portable structured data'):void {
  if(JSON.stringify(withoutPortableSecrets(value))!==JSON.stringify(value))throw new Error(`${label} cannot contain known credential fields`);
}
