/** Browser-only syntax preview. The server proves host-native destinations and authority. */
export function portablePathChoice(value:string):{path:string;key:string;root:boolean}|undefined{
 if(typeof value!=='string'||!value||/[\x00-\x1f\x7f]/.test(value)||/^[\\/]{2}[?.](?:[\\/]|$)/.test(value))return;
 const windows=/^[A-Za-z]:[\\/]/.test(value)||/^[\\/]{2}/.test(value),name=windows?value.replace(/\\/g,'/').replace(/^([a-z]):/,(_,drive:string)=>drive.toUpperCase()+':'):value;
 let prefix:string,tail:string;
 const drive=/^[A-Z]:\//.exec(name),unc=/^\/\/[^/]+\/[^/]+(?:\/|$)/.exec(name);
 if(drive){prefix=drive[0];tail=name.slice(prefix.length);}
 else if(unc){if(unc[0].slice(2).replace(/\/$/,'').split('/').some(part=>part==='.'||part==='..'))return;prefix=unc[0].replace(/\/?$/,'/');tail=name.slice(unc[0].length);}
 else if(name.startsWith('/')&&!name.startsWith('//')&&!name.includes('\\')){prefix='/';tail=name.slice(1);}
 else return;
 if(tail&&tail.split('/').some(part=>!part||part==='.'||part==='..')||windows&&name.slice(drive?2:0).includes(':'))return;
 const path=prefix+tail;return {path,key:windows?path.toLowerCase():path,root:!tail};
}
export function sourcePathChoice(value:string):boolean{return portablePathChoice(value)?.path===value;}
/** Normalize separators while typing, without resolving or discarding entered components. */
export function sourcePathInput(value:string):string{return /^[A-Za-z]:[\\/]|^[\\/]{2}/.test(value)?value.replace(/\\/g,'/').replace(/^([a-z]):/,(_,drive:string)=>drive.toUpperCase()+':'):value;}
export function destinationChoiceKey(value:string):string|undefined{return portablePathChoice(value)?.key;}
