export function recordingMimeType(supported:(mime:string)=>boolean):string|undefined {
 return ['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(supported);
}
export function recordingExtension(mime:string):string {
 return mime==='audio/mp4'?'m4a':mime==='audio/ogg'?'ogg':mime==='audio/webm'?'webm':'audio';
}
