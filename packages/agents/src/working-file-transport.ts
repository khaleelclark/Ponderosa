/** Host-only catalog association for one validated part of one working original. */
export interface WorkingFileTransportPart {
  schema:'ponderosa.working-file-part-owner.v1';
  operationId:string;
  filePath:string;
  fileByteLength:number;
  fileSha256:string;
  partIndex:number;
  partCount:number;
  artifactId:string;
}

type FileWithParts = {path:string;parts?:{schema:string;refs:string[];byteLength:number;sha256:string}};

/** Construct after portable validation and destination artifact ref remapping. */
export function makeWorkingFileTransportPart(file:FileWithParts,partIndex:number,operationId:string):WorkingFileTransportPart {
  const parts=file.parts;
  if(!parts||parts.schema!=='ponderosa.working-file-parts.v1'||!Array.isArray(parts.refs)||parts.refs.length<2
    ||!Number.isSafeInteger(partIndex)||partIndex<0||partIndex>=parts.refs.length
    ||typeof file.path!=='string'||!file.path||typeof operationId!=='string'||!operationId||operationId.length>200
    ||!Number.isSafeInteger(parts.byteLength)||parts.byteLength<=64*1024*1024
    ||typeof parts.sha256!=='string'||!/^[a-f0-9]{64}$/.test(parts.sha256)
    ||typeof parts.refs[partIndex]!=='string'||!parts.refs[partIndex])throw Error('Invalid working-file transport association');
  return {schema:'ponderosa.working-file-part-owner.v1',operationId,filePath:file.path,
    fileByteLength:parts.byteLength,fileSha256:parts.sha256,partIndex,partCount:parts.refs.length,artifactId:parts.refs[partIndex]!};
}

export function validWorkingFileTransportPart(value:WorkingFileTransportPart,artifactId:string):boolean {
  return !!value&&value.schema==='ponderosa.working-file-part-owner.v1'&&value.artifactId===artifactId
    &&typeof value.operationId==='string'&&!!value.operationId&&value.operationId.length<=200
    &&typeof value.filePath==='string'&&!!value.filePath
    &&Number.isSafeInteger(value.fileByteLength)&&value.fileByteLength>64*1024*1024
    &&typeof value.fileSha256==='string'&&/^[a-f0-9]{64}$/.test(value.fileSha256)
    &&Number.isSafeInteger(value.partIndex)&&Number.isSafeInteger(value.partCount)
    &&value.partCount>=2&&value.partIndex>=0&&value.partIndex<value.partCount;
}
