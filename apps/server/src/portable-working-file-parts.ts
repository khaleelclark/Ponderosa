import {createHash} from 'node:crypto';
import {AGENT_PACKAGE_ARTIFACT_MAX_BYTES,MAX_WORKING_FILE_PARTS,type PortableWorkingFileDto} from '@ponderosa/core';

/** Verify ordered decoded originals before any destination mutation. The
 * caller resolves the exact ref order from the already validated manifest. */
export function verifyPortableWorkingFileParts(file:PortableWorkingFileDto,orderedParts:readonly Buffer[]):{sha256:string;byteLength:number}{
 const expected=file.parts;
 if(expected&&(expected.schema!=='ponderosa.working-file-parts.v1'||!Array.isArray(expected.refs)||expected.refs.length<2
  ||expected.refs.length>MAX_WORKING_FILE_PARTS||expected.refs[0]!==file.artifactRef||new Set(expected.refs).size!==expected.refs.length
  ||!Number.isSafeInteger(expected.byteLength)||expected.byteLength<=64*1024*1024||expected.byteLength>AGENT_PACKAGE_ARTIFACT_MAX_BYTES
  ||typeof expected.sha256!=='string'||!/^[a-f0-9]{64}$/.test(expected.sha256)))throw Error('Invalid working-file parts manifest');
 if(orderedParts.length!==(expected?.refs.length??1))throw Error('Working-file original parts are missing');
 const hash=createHash('sha256');let byteLength=0;
 for(const bytes of orderedParts){
  if(!Buffer.isBuffer(bytes)||bytes.length>64*1024*1024||expected&&bytes.length===0)throw Error('Invalid decoded working-file part');
  byteLength+=bytes.length;
  if(byteLength>AGENT_PACKAGE_ARTIFACT_MAX_BYTES)throw Error('Working-file parts exceed decoded package limit');
  hash.update(bytes);
 }
 const sha256=hash.digest('hex');
 if(expected&&(byteLength!==expected.byteLength||sha256!==expected.sha256))throw Error('Working-file original length or SHA-256 differs');
 return {sha256,byteLength};
}
