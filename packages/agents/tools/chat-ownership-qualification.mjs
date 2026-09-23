import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { auditChatOwnership, unresolvedArtifactOwnershipSql } from "../dist/chat-ownership-audit.js";
import { appendFsyncedJsonl } from "../dist/append-jsonl.js";
import { openManagedArtifactContent } from "../dist/managed-artifact-files.js";

const markerName = ".chat-ownership-snapshot.json";
const hash = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
const ignored = name => name === markerName || name === ".ponderosa-daemon.lock" || /(?:-wal|-shm)$/.test(name);
const database = name => /(?:\.db|\.sqlite)$/.test(name);
const quote = name => `"${name.replaceAll('"', '""')}"`;
function same(actual, expected, message) { if (json(actual)!==json(expected)) throw new Error(message); }

// Never follow source symlinks or open AgentStore on the input snapshot.
export function fileManifest(root) {
  const result = {};
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (ignored(name)) continue;
      const file = join(dir, name), key = relative(root, file), stat = lstatSync(file);
      if (stat.isSymbolicLink()) result[key] = `link:${readlinkSync(file)}`;
      else if (stat.isDirectory()) visit(file);
      else if (stat.isFile() && !(dir===root && database(name))) result[key] = hash(readFileSync(file));
    }
  }
  visit(root);
  return result;
}

export function databaseManifest(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only=ON");
    return db.transaction(() => {
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      const result = {};
      for (const {name, sql} of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
        const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column => quote(column.name));
        const digest = createHash("sha256").update(sql ?? "");
        let count = 0;
        for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${columns.join(",")}`).iterate()) {
          digest.update(json(row)).update("\n"); count++;
        }
        result[name] = {count, hash: digest.digest("hex")};
      }
      return result;
    })();
  } finally { db.close(); }
}

function databaseFiles(root) {
  return readdirSync(root).sort().filter(name=>database(name) && lstatSync(join(root,name)).isFile());
}
const dbManifests = root => Object.fromEntries(databaseFiles(root).map(file => [file, databaseManifest(join(root,file))]));
function copyState(source, destination) {
  assert.equal(existsSync(destination), false, "Output must be a new directory");
  cpSync(source,destination,{recursive:true,dereference:false,verbatimSymlinks:true,
    filter:file => !ignored(file.split("/").at(-1))});
  chmodSync(destination,0o700);
}

export async function captureSnapshot(source, destination, sourceRevision) {
  source=resolve(source); destination=resolve(destination);
  assert.ok(!destination.startsWith(`${source}/`) && source!==destination, "Snapshot must be outside live state");
  assert.equal(existsSync(destination),false,"Snapshot destination already exists");
  const files=fileManifest(source), databases=dbManifests(source);
  copyState(source,destination);
  for (const file of Object.keys(databases)) {
    // SQLite's backup API includes committed WAL state; raw database copying does not.
    const db=new Database(join(source,file),{readonly:true,fileMustExist:true});
    try { await db.backup(join(destination,file)); } finally {db.close();}
  }
  same(fileManifest(source),files,"Live files changed during capture; discard this unqualified copy and retry");
  same(dbManifests(source),databases,"Live databases changed during capture; retry without stopping dev");
  same(fileManifest(destination),files,"Snapshot file copy differs");
  same(dbManifests(destination),databases,"Snapshot database copy differs");
  const marker={version:1,capturedAt:new Date().toISOString(),sourceRevision,files,databases};
  writeFileSync(join(destination,markerName),json(marker),{flag:"wx",mode:0o600});
  return {snapshot:destination,sourceRevision,fileCount:Object.keys(files).length,manifestHash:hash(json(marker))};
}

const authoritativeTables = tables => Object.fromEntries(Object.entries(tables).filter(([name]) => /^(coordination_|scheduler_|activation_|agent_activations$|required_reply_|context_rollovers$|communication_v4_|provider_|runtime_|trigger_|continuation_handoffs$|agent_handle_reservations$|agent_creation_|agent_management_|.*_deletion_)/.test(name)));
function assertPreserved(before, after, allowChatMetadata=false) {
  const keep=entries=>Object.fromEntries(Object.entries(entries).filter(([file])=>!allowChatMetadata || !/^projects\/[^/]+\/conversations\/[^/]+\/conversation\.json$/.test(file)));
  same(keep(after),keep(before),"Canonical history, managed files, or source files changed");
}

async function recoverLegacyArtifacts(snapshot, migrated, baselineModule) {
  const db=new Database(join(snapshot,"ponderosa.db"),{readonly:true,fileMustExist:true});
  let items;
  try {
    items=db.prepare(unresolvedArtifactOwnershipSql).all().map(({artifactId,legacyProjectId})=>{
      const row=db.prepare("SELECT * FROM managed_artifact_projection WHERE project_id=? AND artifact_id=?").get(legacyProjectId,artifactId);
      const artifact=JSON.parse(row.artifact_json);
      const origin=db.prepare("SELECT * FROM agents WHERE id=? AND project_id=?").get(artifact.originAgentId,legacyProjectId);
      assert.ok(origin?.deleted_at && !origin.conversation_id && !artifact.legacyRecovery,"Only unresolved deleted-Agent artifacts may be recovered");
      return {projectId:legacyProjectId,artifactId,artifact,access:{owner_kind:row.owner_kind,owner_id:row.owner_id,audience_json:row.audience_json,sender_agent_id:row.sender_agent_id}};
    });
  } finally {db.close();}
  for(const item of items) {
    const content=await openManagedArtifactContent(snapshot,item.projectId,item.artifactId,item.artifact.size,item.artifact.sha256);
    assert.ok(content,"Recovered bytes must exist and match original provenance without following links");
    await content.close();
  }
  const {AgentStore:BaselineStore}=await import(pathToFileURL(resolve(baselineModule)).href);
  const store=new BaselineStore(migrated), groups=[];
  try {
    for(const projectId of [...new Set(items.map(item=>item.projectId))]) {
      const project=store.getProject(projectId);
      const chat=store.createConversation(projectId,{title:"Recovered Files",defaultEngine:project.defaultEngine});
      const agent=store.createAgent(projectId,{title:"Legacy Imports",engine:project.defaultEngine,conversationId:chat.id});
      store.updateAgent(agent.id,{archived:true});
      assert.equal(store.getAgent(agent.id).archived,true);
      groups.push({projectId,chatId:chat.id,custodianAgentId:agent.id});
    }
  } finally {store.close();}
  const at=new Date().toISOString();
  for(const group of groups) {
    const events=items.filter(item=>item.projectId===group.projectId).map(item=>({type:"legacy_custody",artifactId:item.artifactId,originAgentId:item.artifact.originAgentId,sha256:item.artifact.sha256,custodianAgentId:group.custodianAgentId,at}));
    appendFsyncedJsonl(join(migrated,"projects",group.projectId,"artifacts","artifacts.jsonl"),events);
  }
  // Verify the exact permitted transformation, not a blanket exclusion of journals.
  const before=fileManifest(snapshot),after=fileManifest(migrated);
  for(const [file,digest] of Object.entries(before)) {
    if(after[file]===digest) continue;
    const group=groups.find(group=>file.startsWith(`projects/${group.projectId}/`));
    assert.ok(group,`Recovery changed unrelated file: ${file}`);
    const oldBytes=readFileSync(join(snapshot,file)),newBytes=readFileSync(join(migrated,file));
    if(file===`projects/${group.projectId}/project.json`) {
      const old=JSON.parse(oldBytes),next=JSON.parse(newBytes);
      assert.equal(next.lastConversationId,group.chatId);
      same({...next,lastConversationId:old.lastConversationId,lastUsedAt:old.lastUsedAt},old,"Recovery changed Project configuration");
    } else if(file===`projects/${group.projectId}/artifacts/artifacts.jsonl`) {
      assert.ok(newBytes.subarray(0,oldBytes.length).equals(oldBytes),"Recovery rewrote artifact history");
      const added=newBytes.subarray(oldBytes.length).toString().trim().split("\n").map(line=>JSON.parse(line));
      same(added,items.filter(item=>item.projectId===group.projectId).map(item=>({type:"legacy_custody",artifactId:item.artifactId,originAgentId:item.artifact.originAgentId,sha256:item.artifact.sha256,custodianAgentId:group.custodianAgentId,at})),"Unexpected artifact journal additions");
    } else throw new Error(`Recovery changed existing history: ${file}`);
  }
  for(const file of Object.keys(after).filter(file=>!(file in before))) {
    assert.ok(groups.some(group=>file.startsWith(`projects/${group.projectId}/agents/${group.custodianAgentId}/`) || file.startsWith(`projects/${group.projectId}/conversations/${group.chatId}/`)),`Unexpected recovery file: ${file}`);
  }
  const authority=databaseManifest(join(migrated,"ponderosa.db")),original=databaseManifest(join(snapshot,"ponderosa.db"));
  // Only reservations for the new custodians may be added; existing authority is immutable.
  const runtime=tables=>Object.fromEntries(Object.entries(authoritativeTables(tables)).filter(([name])=>name!=="agent_handle_reservations"));
  same(runtime(authority),runtime(original),"Recovery changed runtime authority");
  const oldDb=new Database(join(snapshot,"ponderosa.db"),{readonly:true}),newDb=new Database(join(migrated,"ponderosa.db"),{readonly:true});
  try {
    const oldRows=oldDb.prepare("SELECT * FROM agent_handle_reservations ORDER BY project_id,normalized_handle").all();
    const newRows=newDb.prepare("SELECT * FROM agent_handle_reservations ORDER BY project_id,normalized_handle").all();
    same(newRows.filter(row=>!groups.some(group=>group.custodianAgentId===row.agent_id)),oldRows,"Existing handle reservations changed");
    assert.equal(newRows.length,oldRows.length+groups.length);
  }finally{oldDb.close();newDb.close();}
  return {groups,items,at};
}

export async function qualifySnapshot(snapshot, output, baselineModule, candidateRevision, recoverDeletedArtifacts=false) {
  snapshot=resolve(snapshot); output=resolve(output);
  assert.ok(output!==snapshot && !output.startsWith(`${snapshot}/`),"Qualification output must be separate");
  assert.equal(existsSync(output),false,"Qualification output already exists");
  mkdirSync(output,{recursive:true,mode:0o700});
  const report={version:1,status:"blocked",candidateRevision,sourceSnapshot:snapshot,checks:{},limitations:["Offline AgentStore rehearsal only; no provider execution or live-service cutover.","Promotion requires a fresh target snapshot, drained runtime, explicit operator authorization, and this gate passing."]};
  try {
    const marker=JSON.parse(readFileSync(join(snapshot,markerName),"utf8"));
    assert.equal(marker.version,1);
    report.sourceRevision=marker.sourceRevision;report.snapshotHash=hash(json(marker));
    same(fileManifest(snapshot),marker.files,"Snapshot files changed after capture");
    same(dbManifests(snapshot),marker.databases,"Snapshot databases changed after capture");
    report.checks.snapshotIntegrity=true;
    const audit=auditChatOwnership(join(snapshot,"ponderosa.db"));report.initialOwnership=audit;report.ownership=audit;
    if(audit.findings.length && (!recoverDeletedArtifacts || audit.findings.some(finding=>finding.code!=="artifact_without_resolvable_chat"))) throw new Error("Unresolved ownership findings block promotion");
    const migrated=join(output,"migrated");copyState(snapshot,migrated);
    // AgentStore can write canonical metadata. Refuse linked managed ancestry.
    for(const [file,value] of Object.entries(marker.files)) if(file.startsWith("projects/") && value.startsWith("link:")) throw new Error("Linked managed state is not qualified");
    const recovery=recoverDeletedArtifacts && audit.findings.length ? await recoverLegacyArtifacts(snapshot,migrated,baselineModule) : undefined;
    const migrationFiles=fileManifest(migrated),migrationDatabase=databaseManifest(join(migrated,"ponderosa.db"));
    const metadataBefore=new Map();
    for(const file of Object.keys(migrationFiles)) if(/^projects\/[^/]+\/(?:conversations\/[^/]+\/conversation|project)\.json$/.test(file)) metadataBefore.set(file,JSON.parse(readFileSync(join(migrated,file),"utf8")));
    if(recovery) report.recovery={approvedMode:"deleted-agent-custody",groups:recovery.groups,artifactCount:recovery.items.length,at:recovery.at};
    const {AgentStore}=await import("../dist/index.js");
    for(let pass=1;pass<=2;pass++) {
      const store=new AgentStore(migrated);
      try {
        assert.deepEqual(store.startupProfile().recoveryIssues,[],"Startup quarantined canonical data");
        for(const project of store.listProjects()) for(const chat of store.listConversations(project.id)) {
          const relativeFile=join("projects",project.id,"conversations",chat.id,"conversation.json");
          const canonical=JSON.parse(readFileSync(join(migrated,relativeFile),"utf8"));
          const before=metadataBefore.get(relativeFile);
          const parent=metadataBefore.get(join("projects",project.id,"project.json"));
          const inherits=!before.defaultEngine || before.defaultEngine===parent.defaultEngine;
          const expected=before.chatOwnershipVersion===1 ? before : {
            ...before,workingDirectory:before.workingDirectory??parent.hostPath,
            instructions:before.instructions??parent.instructions??"",
            defaultEngine:before.defaultEngine??parent.defaultEngine,
            defaultModel:before.defaultModel??(inherits?parent.defaultModel:undefined),
            defaultEffort:before.defaultEffort??(inherits?parent.defaultEffort:undefined),chatOwnershipVersion:1,
          };
          assert.deepEqual(canonical,JSON.parse(json(expected)),"Migrated Chat context differs from its canonical inheritance");
          assert.equal(canonical.chatOwnershipVersion,1);
          assert.ok(canonical.workingDirectory,"Chat must retain a working directory");
        }
        if(recovery) for(const item of recovery.items) {
          const actual=store.getProjectArtifact(item.projectId,item.artifactId);
          const group=recovery.groups.find(group=>group.projectId===item.projectId);
          assert.equal(actual.legacyRecovery.custodianAgentId,group.custodianAgentId);
          for(const [key,value] of Object.entries(item.artifact)) assert.deepEqual(actual[key],value,`Original artifact ${key} changed`);
          const row=store.sqlite.prepare("SELECT owner_kind,owner_id,audience_json,sender_agent_id FROM managed_artifact_projection WHERE project_id=? AND artifact_id=?").get(item.projectId,item.artifactId);
          assert.deepEqual(row,item.access,"Recovery widened artifact access");
          assert.equal(store.getAgent(group.custodianAgentId).archived,true);
        }
      } finally {store.close();}
      const after=auditChatOwnership(join(migrated,"ponderosa.db"));
      report.ownership=after;
      assert.deepEqual(after.findings,[]);assert.deepEqual(after.counts,{...audit.counts,chats:audit.counts.chats+(recovery?.groups.length??0),agents:audit.counts.agents+(recovery?.groups.length??0)},"Resource counts changed");
      report.checks.ownership=true;
      if(recovery) report.checks.recovery=true;
      assertPreserved(migrationFiles,fileManifest(migrated),true);
      assert.deepEqual(authoritativeTables(databaseManifest(join(migrated,"ponderosa.db"))),authoritativeTables(migrationDatabase),"Authoritative coordination/deletion state changed");
      if(pass===1) report.migratedManifest=fileManifest(migrated);
      else assert.deepEqual(fileManifest(migrated),report.migratedManifest,"Second startup is not idempotent");
      report.checks[pass===1?"migration":"restart"]=true;
    }
    // Rollback means restore the complete pre-migration snapshot, not merely downgrade the binary.
    const rollback=join(output,"rollback");copyState(snapshot,rollback);
    const {AgentStore:BaselineStore}=await import(pathToFileURL(resolve(baselineModule)).href);
    const oldStore=new BaselineStore(rollback);oldStore.close();
    assertPreserved(marker.files,fileManifest(rollback));
    assert.deepEqual(authoritativeTables(databaseManifest(join(rollback,"ponderosa.db"))),authoritativeTables(marker.databases["ponderosa.db"]));
    report.checks.rollbackRestore=true;
    assert.deepEqual(fileManifest(snapshot),marker.files,"Input snapshot was changed");
    assert.deepEqual(dbManifests(snapshot),marker.databases);
    delete report.migratedManifest;
    report.status="passed";
  } catch(error) { report.error=error.message; delete report.migratedManifest; }
  writeFileSync(join(output,"qualification.json"),JSON.stringify(report,null,2),{mode:0o600});
  return report;
}

export function assertQualification(report, candidateRevision, snapshot) {
  assert.equal(report.status,"passed","Migration qualification is blocked");
  assert.equal(report.candidateRevision,candidateRevision,"Qualification belongs to a different candidate revision");
  for(const check of ["snapshotIntegrity","ownership","migration","restart","rollbackRestore"]) assert.equal(report.checks[check],true,`Missing qualification: ${check}`);
  if(report.recovery) assert.equal(report.checks.recovery,true,"Missing recovery verification");
  const marker=JSON.parse(readFileSync(join(snapshot,markerName),"utf8"));
  assert.equal(report.snapshotHash,hash(json(marker)),"Qualification belongs to a different target snapshot");
  same(fileManifest(snapshot),marker.files,"Snapshot changed after qualification");
  same(dbManifests(snapshot),marker.databases,"Snapshot databases changed after qualification");
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [mode,source,output,extra,revision,recovery]=process.argv.slice(2);
  if(mode==="capture" && source && output && extra) console.log(JSON.stringify(await captureSnapshot(source,output,extra)));
  else if(mode==="verify" && source && output && extra && revision) {
    if(recovery && recovery!=="--recover-deleted-agent-artifacts") throw new Error("Unknown recovery option");
    const report=await qualifySnapshot(source,output,extra,revision,recovery==="--recover-deleted-agent-artifacts");
    console.log(JSON.stringify(report,null,2));if(report.status!=="passed")process.exitCode=2;
  } else if(mode==="gate" && source && output && extra) {
    assertQualification(JSON.parse(readFileSync(source,"utf8")),output,extra);
    console.log("Technical qualification passed for this candidate and snapshot. This does not authorize promotion.");
  } else throw new Error("Usage: capture <source-state> <new-snapshot> <source-revision> | verify <snapshot> <new-output> <baseline-agents-dist/index.js> <candidate-revision> | gate <qualification.json> <candidate-revision> <snapshot>");
}
