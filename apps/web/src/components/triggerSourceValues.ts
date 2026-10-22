export function splitTriggerGlobText(value:string):string[]{
  return value.split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
}
