/** Recovery command identity must survive reload; optional preference fallbacks cannot authorize it. */
export function readRecoveryKey(key:string):{key?:string;error?:string} {
 try {
  const value=localStorage.getItem(key);
  return value?{key:value}:{};
 } catch {
  return {error:'Saved recovery key is unavailable. Restore browser storage and reload before requesting recovery.'};
 }
}
export function writeRecoveryKey(key:string,value:string):void {
 try {
  localStorage.setItem(key,value);
  if(localStorage.getItem(key)!==value)throw Error('Recovery key readback differs');
 } catch {
  throw Error(value?'Recovery key could not be saved and verified. No recovery was requested.':'Dismissal returned, but its local key could not be cleared. Reload status before another action.');
 }
}
