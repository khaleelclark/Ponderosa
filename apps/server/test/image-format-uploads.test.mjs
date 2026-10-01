import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import Fastify from "fastify";
import { WorkspaceStore } from "@ponderosa/agents";
import { AssetStore, prepareAssetUpload } from "../dist/assets.js";
import { validMotionVideo } from "../dist/image-containers.js";
import { hasSamsungImageTrailer, hasXmpMotionPhoto } from "../dist/jpeg-container.js";
import { runtimeAttachmentName } from "../dist/routes/agent-run-preparation.js";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";
import { registerBodyParsers } from "../dist/server-request-hooks.js";
import { DraftService, registerDraftRoutes } from "../dist/routes/drafts.js";

// Synthetic 16x16 blue AVC clip, generated with ffmpeg; no user media.
const video = Buffer.from("AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC5G1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHndHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABg21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAMgAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAS5taW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADuc3RibAAAAKJzdHNkAAAAAAAAAAEAAACSYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARRMYXZjNjMuMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAABj//wAAACxhdmNDAULACv/hABVnQsAK2nsBEAAAAwAQAAADAyDxImoBAARozg/IAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDAAAAB4bW9vZgAAABBtZmhkAAAAAAAAAAEAAABgdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADCAAAAgAAAAJvAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAIHRydW4AAAIFAAAAAgAAAIACAAAAAAACbwAAAAkAAAKAbWRhdAAAAlQGBf//UNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAgYW5hbHlzZT0wOjAgbWU9ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9MCB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmM9Y3JmIG1idHJlZT0wIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTAAgAAAABNliIQ6EYoAAjFxwABDyjgACAXgAAAABUGaICaUAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAMIAQEBAAAAEG1mcm8AAAAAAAAAQw==", "base64");
const image = sharp({create:{width:24,height:32,channels:3,background:"#123456"}});
const jpeg = await image.clone().jpeg().toBuffer();
const png = await image.clone().png().toBuffer();
const gif = await image.clone().gif().toBuffer();
const avif = await image.clone().avif().toBuffer();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function sef(primary, fields, prefix = Buffer.alloc(0)) {
 const blocks = fields.map(([type,name,value])=>{
  const header=Buffer.alloc(8), key=Buffer.from(name);
  header.writeUInt16LE(type,2);header.writeUInt32LE(key.length,4);
  return Buffer.concat([header,key,value]);
 });
 const directory=Buffer.alloc(12+fields.length*12);
 directory.write("SEFH");directory.writeUInt32LE(107,4);directory.writeUInt32LE(fields.length,8);
 let back=blocks.reduce((sum,b)=>sum+b.length,0);
 blocks.forEach((b,i)=>{b.copy(directory,12+12*i,0,4);directory.writeUInt32LE(back,16+12*i);directory.writeUInt32LE(b.length,20+12*i);back-=b.length;});
 const footer=Buffer.alloc(8);footer.writeUInt32LE(directory.length);footer.write("SEFT",4);
 return Buffer.concat([primary,prefix,...blocks,directory,footer]);
}
const screenshotPng=sef(png,[[0x0c51,"Samsung_Capture_Info",Buffer.from("Screenshot")],[0x0da1,"Captured_App_Info",Buffer.from("example.browser")]]);
const samsungMotion=sef(jpeg,[[0x0a30,"MotionPhoto_Data",video],[0x0a31,"MotionPhoto_Version",Buffer.from("1")],[0x0a01,"Image_UTC_Data",Buffer.from("1750000000000")]]);
const reference=Buffer.alloc(12);reference.write("mpv2");reference.writeUInt32BE(jpeg.length,4);reference.writeUInt32BE(video.length,8);
const samsungMotionV2=sef(jpeg,[[0x0a30,"MotionPhoto_Data",reference]],video);
const camera="http://ns.google.com/photos/1.0/camera/";
const container="http://ns.google.com/photos/1.0/container/";
const item="http://ns.google.com/photos/1.0/container/item/";
const rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const modernXml=`<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${rdf}"><r:Description xmlns:cam="${camera}" xmlns:c="${container}" xmlns:i="${item}" cam:MotionPhoto="1" cam:MotionPhotoVersion="1"><c:Directory><r:Seq><r:li r:parseType="Resource"><c:Item i:Mime="image/jpeg" i:Semantic="Primary" i:Length="0"/></r:li><r:li r:parseType="Resource"><c:Item i:Mime="video/mp4" i:Semantic="MotionPhoto" i:Length="${video.length}"/></r:li></r:Seq></c:Directory></r:Description></r:RDF></x:xmpmeta>`;
const legacyXml=`<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="${rdf}"><r:Description xmlns:cam="${camera}" cam:MicroVideo="1" cam:MicroVideoVersion="1" cam:MicroVideoOffset="${video.length}"/></r:RDF></x:xmpmeta>`;
function xmpMotion(xml, trailer=video) {
 const payload=Buffer.from("http://ns.adobe.com/xap/1.0/\0"+xml);
 const header=Buffer.from([0xff,0xe1,0,0]);header.writeUInt16BE(payload.length+2,2);
 return Buffer.concat([jpeg.subarray(0,2),header,payload,jpeg.subarray(2),trailer]);
}
const modern=xmpMotion(modernXml), legacy=xmpMotion(legacyXml);
const formats=[
 ["photo.gif","image/gif",gif],
 ["photo.avif","image/avif",avif],
 ["Screenshot.png","image/png",screenshotPng],
 ["Motion.jpg","image/jpeg",samsungMotion],
 ["MotionV2.jpg","image/jpeg",samsungMotionV2],
 ["MotionXmp.jpg","image/jpeg",modern],
 ["MotionLegacy.jpg","image/jpeg",legacy],
];

test("GIF, AVIF, Samsung PNG and qualified Motion Photos preserve original bytes and bounded still previews",async()=>{
 assert.equal(validMotionVideo(video),true);
 assert.equal(hasSamsungImageTrailer(samsungMotion),true);
 assert.equal(hasSamsungImageTrailer(samsungMotionV2),true);
 assert.equal(hasXmpMotionPhoto(modern),true);
 assert.equal(hasXmpMotionPhoto(legacy),true);
 for(const [name,mediaType,body] of formats) for(const declaredType of [mediaType,undefined,"application/octet-stream"]){
  const prepared=await prepareAssetUpload({body,name,declaredType});
  assert.equal(prepared.mediaType,mediaType);assert.equal(prepared.sha256,hash(body));
  assert.equal(prepared.width,24);assert.equal(prepared.height,32);
  const preview=await sharp(prepared.preview).metadata();
  assert.equal(preview.format,"png");assert.equal(preview.width,24);assert.equal(preview.height,32);
  assert.ok(prepared.preview.length<=8*1024*1024);
 }
 for(const mediaType of ["image/gif","image/avif"]) assert.equal(runtimeAttachmentName({id:"asset",name:"photo."+mediaType.split("/")[1],mediaType}),"asset-photo.png");
});

test("animated GIF produces only the first still frame; excessive frame counts fail closed",async()=>{
 const descriptor=gif.indexOf(Buffer.from([0x21,0xf9,0x04]));
 assert.ok(descriptor>0);
 const frame=gif.subarray(descriptor,gif.length-1);
 const animated=Buffer.concat([gif.subarray(0,descriptor),frame,frame,Buffer.from([0x3b])]);
 assert.equal((await sharp(animated).metadata()).pages,2);
 const prepared=await prepareAssetUpload({body:animated,name:"animated.gif"});
 assert.deepEqual(prepared.preview,(await prepareAssetUpload({body:gif,name:"still.gif"})).preview);
 const excessive=Buffer.concat([gif.subarray(0,descriptor),...Array(513).fill(frame),Buffer.from([0x3b])]);
 await assert.rejects(prepareAssetUpload({body:excessive,name:"excessive.gif"}));
 const oversizedFrame=Buffer.from(gif);oversizedFrame.writeUInt16LE(65535,descriptor+8+5);
 await assert.rejects(prepareAssetUpload({body:oversizedFrame,name:"oversized-frame.gif"}));
 const comments=Buffer.concat([gif.subarray(0,-1),...Array(4096).fill(Buffer.from([0x21,0xfe,1,65,0])),Buffer.from([0x3b])]);
 await assert.rejects(prepareAssetUpload({body:comments,name:"too-many-blocks.gif"}));
});

test("new formats reject malformed containers, spoofing and unaccounted Motion Photo bytes",async()=>{
 for(const [name,mediaType,body] of formats){
  for(const bad of [body.subarray(0,-1),Buffer.concat([body,Buffer.from("hidden")])]){
   await assert.rejects(prepareAssetUpload({body:bad,name,declaredType:mediaType}),error=>error.statusCode===415,name);
  }
  await assert.rejects(prepareAssetUpload({body,name:"fake.txt",declaredType:mediaType}));
  await assert.rejects(prepareAssetUpload({body,name,declaredType:"application/x-executable"}));
 }
 const badReference=Buffer.from(reference);badReference.writeUInt32BE(jpeg.length+1,4);
 const cases=[
  sef(jpeg,[[0x0a30,"MotionPhoto_Data",badReference]],video),
  sef(jpeg,[[0x0a30,"MotionPhoto_Data",Buffer.from("arbitrary bytes")]]),
  sef(jpeg,[[0x0a31,"MotionPhoto_Version",Buffer.from("1")]]),
  sef(jpeg,[[0x0a30,"MotionPhoto_Data",video],[0x0a30,"MotionPhoto_Data",video]]),
  sef(Buffer.concat([jpeg,Buffer.from("gap")]),[[0x0a30,"MotionPhoto_Data",video]]),
  xmpMotion(modernXml.replace('i:Length="'+video.length+'"','i:Length="'+(video.length-1)+'"')),
  xmpMotion(modernXml.replace(camera,"https://example.invalid/camera/")),
  xmpMotion(modernXml.replace("video/mp4","application/x-executable")),
  xmpMotion(modernXml.replace("MotionPhotoVersion=\"1\"","MotionPhotoVersion=\"2\"")),
  xmpMotion(modernXml,Buffer.concat([Buffer.from("gap"),video])),
  xmpMotion('<!DOCTYPE x [<!ENTITY test "1">]>'+modernXml),
  xmpMotion(modernXml.replace('cam:MotionPhoto="1"','cam:MotionPhoto="&test;"')),
 ];
 for(const body of cases) await assert.rejects(prepareAssetUpload({body,name:"bad.jpg"}),error=>error.statusCode===415);
 const noVideo=Buffer.from(video);const handler=noVideo.indexOf(Buffer.from("vide"));noVideo.write("soun",handler);
 assert.equal(validMotionVideo(noVideo),false);
 const freeBox=Buffer.from([0,0,0,8,102,114,101,101]);
 await assert.rejects(prepareAssetUpload({body:Buffer.concat([avif,...Array(4096).fill(freeBox)]),name:"too-many-boxes.avif"}));
 for(let end=0;end<video.length;end++) assert.doesNotThrow(()=>validMotionVideo(video.subarray(0,end)));
});

test("new formats survive real Agent/Chat routes, drafts, prepared staging, reopening and scope fencing",async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),"ponderosa-image-formats-"));
 const assets=new AssetStore(dataDir,{portableFiles:true}),app=Fastify(),workspace=new WorkspaceStore(dataDir);
 t.after(async()=>{await app.close();assets.close();await rm(dataDir,{recursive:true,force:true});});
 const projectId=randomUUID(),agentId=randomUUID(),chatId=randomUUID(),otherChatId=randomUUID();
 const store={getAgent:id=>id===agentId?{id,projectId}:undefined,getConversation:id=>[chatId,otherChatId].includes(id)?{id,projectId}:undefined};
 registerBodyParsers(app);
 registerAttachmentRoutes(app,{store,assets,agentDeliveryLeases:new Map(),conversationDeliveryLeases:new Map(),
  conversationDeletionInProgress:()=>false,agentDeletionInProgress:()=>false,deletingAttachmentKeys:new Set(),reconcilingAssetAgentIds:new Set()});
 const drafts=new DraftService(dataDir,store,workspace,assets);
 registerDraftRoutes(app,drafts,workspace,8,()=>undefined);
 for(const [name,mediaType,body] of formats){
  for(const [ownerId,surface] of [[agentId,"agents"],[chatId,"conversations"]]){
   const upload=await app.inject({method:"POST",url:`/api/${surface}/${ownerId}/attachments`,headers:{"content-type":"application/x-ponderosa-attachment","x-ponderosa-filename":name,"x-ponderosa-media-type":mediaType},payload:body});
   assert.equal(upload.statusCode,201,upload.body);const asset=upload.json();
   assert.deepEqual((await app.inject({url:asset.downloadUrl})).rawPayload,body);
   assert.equal((await sharp((await app.inject({url:asset.previewUrl})).rawPayload).metadata()).format,"png");
   assert.equal((await app.inject({url:`/api/conversations/${otherChatId}/assets/${asset.id}/download`})).statusCode,404);
   await assets.associate(projectId,ownerId,[asset.id]);
   assert.equal(assets.authoritativeRuntimeAttachment(projectId,ownerId,asset.id)?.attachment.sha256,hash(body));
   assert.equal(assets.authoritativeRuntimeAttachment(randomUUID(),ownerId,asset.id),undefined);
   const reopened=new AssetStore(dataDir,{portableFiles:true});
   try{assert.deepEqual((await reopened.content(projectId,ownerId,asset.id,false))?.body,body);}finally{reopened.close();}
  }
  const upload=await app.inject({method:"POST",url:`/api/conversations/${chatId}/draft-attachments`,headers:{"content-type":"application/x-ponderosa-attachment","x-ponderosa-draft-owner":"browser-one","x-ponderosa-filename":name,"x-ponderosa-media-type":mediaType},payload:body});
  assert.equal(upload.statusCode,201,upload.body);const attachment=upload.json();
  assert.deepEqual((await app.inject({url:attachment.downloadUrl})).rawPayload,body);
  const prepared=await drafts.prepared(chatId,"browser-one",attachment.id);assert.ok(prepared);
  const staged=await assets.stage({projectId,agentId,body:prepared.body,prepared:prepared.prepared});
  assert.deepEqual((await assets.content(projectId,agentId,staged.id,false)).body,body);
 }
});

test("a real 200MP baseline JPEG gets a reduced, bounded preview; high-resolution progressive input remains rejected",async t=>{
 // Generate the compressible fixture in a separate process, so encoding memory
 // is not confused with the server preview's memory. No 600MB raw array in tests.
 const body=execFileSync(process.execPath,["--input-type=module","-e",`import sharp from "sharp";sharp.cache(false);const b=await sharp({create:{width:20000,height:10000,channels:3,background:"#2468ac"}}).jpeg({quality:60}).toBuffer();process.stdout.write(b);`],{cwd:new URL("..",import.meta.url),timeout:30000,maxBuffer:8*1024*1024});
 let peak=process.memoryUsage().rss;const baseline=peak;
 const timer=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),5);
 let prepared;
 try{prepared=await prepareAssetUpload({body,name:"200mp.jpg"});}finally{clearInterval(timer);}
 assert.equal(prepared.width,20000);assert.equal(prepared.height,10000);assert.equal(prepared.sha256,hash(body));
 assert.equal(runtimeAttachmentName({id:"asset",name:"200mp.jpg",mediaType:"image/jpeg",width:prepared.width,height:prepared.height}),"asset-200mp.png");
 const preview=await sharp(prepared.preview).metadata();assert.equal(preview.width,2048);assert.equal(preview.height,1024);
 t.diagnostic(`200MP preview RSS increase: ${Math.ceil((peak-baseline)/1024/1024)} MiB; original ${body.length} bytes`);
 assert.ok(peak-baseline<384*1024*1024,"preview must not allocate a full 600MB RGB frame");
 const oriented=await sharp(jpeg).withMetadata({orientation:6}).jpeg().toBuffer();
 const exifStart=oriented.indexOf(Buffer.from([0xff,0xe1]));assert.ok(exifStart>0);
 const exifEnd=exifStart+2+oriented.readUInt16BE(exifStart+2);
 const rotated=Buffer.concat([body.subarray(0,2),oriented.subarray(exifStart,exifEnd),body.subarray(2)]);
 const rotatedPreview=await sharp((await prepareAssetUpload({body:rotated,name:"rotated-200mp.jpg"})).preview).metadata();
 assert.equal(rotatedPreview.width,1024);assert.equal(rotatedPreview.height,2048);
 const malformed=Buffer.from(jpeg),smallSof=malformed.indexOf(Buffer.from([0xff,0xc0]));
 malformed.writeUInt16BE(10000,smallSof+5);malformed.writeUInt16BE(20000,smallSof+7);
 // Refer to absent Huffman tables: changing dimensions alone can be tolerated
 // by libjpeg's warning recovery and is not a reliable decoder-failure fixture.
 const scan=malformed.indexOf(Buffer.from([0xff,0xda]));assert.ok(scan>0);malformed[scan+6]=0x33;
 const concurrent=await Promise.allSettled([malformed,body,body].map(body=>prepareAssetUpload({body,name:"queued-200mp.jpg"})));
 assert.equal(concurrent[0].status,"rejected");assert.equal(concurrent[1].status,"fulfilled");assert.equal(concurrent[2].status,"fulfilled");
 const progressive=Buffer.from(body),sof=progressive.indexOf(Buffer.from([0xff,0xc0]));
 assert.ok(sof>0);progressive[sof+1]=0xc2;
 await assert.rejects(prepareAssetUpload({body:progressive,name:"progressive.jpg"}),/high-resolution progressive/u);
 const oversized=Buffer.from(body);oversized.writeUInt16BE(65535,sof+5);oversized.writeUInt16BE(65535,sof+7);
 await assert.rejects(prepareAssetUpload({body:oversized,name:"oversized.jpg"}));
 const dataDir=await mkdtemp(path.join(tmpdir(),"ponderosa-200mp-"));
 const assets=new AssetStore(dataDir,{portableFiles:true});
 try{
  const staged=await assets.stage({projectId:"project-a",agentId:"agent-a",body,prepared});
  assert.deepEqual((await assets.content("project-a","agent-a",staged.id,false))?.body,body);
 }finally{assets.close();await rm(dataDir,{recursive:true,force:true});}
});
