import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, readlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import Database from "better-sqlite3";
import test from "node:test";
import { auditChatOwnership } from "../dist/chat-ownership-audit.js";

function fixture(run) {
  const root=mkdtempSync(join(tmpdir(),"ponderosa-chat-audit-")), path=join(root,"audit.db");
  const db=new Database(path);
  db.exec(`CREATE TABLE projects(id TEXT); CREATE TABLE conversations(id TEXT,project_id TEXT);
    CREATE TABLE agents(id TEXT,project_id TEXT,conversation_id TEXT,manager_agent_id TEXT,deleted_at TEXT);
    CREATE TABLE coordination_requests(id TEXT,requester_agent_id TEXT,recipient_agent_id TEXT);
    CREATE TABLE managed_artifact_projection(artifact_id TEXT,project_id TEXT,artifact_json TEXT,owner_kind TEXT,owner_id TEXT);
    CREATE TABLE chat_search_messages(project_id TEXT,communication_event_id TEXT,conversation_id TEXT);
    CREATE TABLE agent_presets(id TEXT);
    INSERT INTO projects VALUES ('P'); INSERT INTO conversations VALUES ('C1','P'),('C2','P');
    INSERT INTO agents VALUES ('A','P','C1',NULL,NULL),('B','P','C1','A',NULL),('D','P','C2',NULL,NULL);
    INSERT INTO coordination_requests VALUES ('R','A','B');
    INSERT INTO managed_artifact_projection VALUES ('F','P','{"originAgentId":"B"}','project','P');`);
  try { run(db,path); } finally { db.close(); rmSync(root,{recursive:true,force:true}); }
}

test("ownership preflight preserves same-chat organizations without writing the database",()=>fixture((db,path)=>{
  const before=readFileSync(path);
  const report=auditChatOwnership(path);
  assert.deepEqual(report.findings,[]);
  assert.equal(report.counts.chats,2);
  assert.equal(report.migrationImplemented,false);
  assert.deepEqual(readFileSync(path),before);
}));
test("preflight reports cross-chat relationships and orphaned artifacts rather than guessing ownership",()=>fixture((db,path)=>{
  db.exec("UPDATE agents SET manager_agent_id='A' WHERE id='D'; UPDATE coordination_requests SET recipient_agent_id='D'; DELETE FROM managed_artifact_projection;");
  db.prepare("INSERT INTO managed_artifact_projection VALUES (?,?,?,?,?)").run('orphan','P',JSON.stringify({originAgentId:'missing'}),'project','P');
  const report=auditChatOwnership(path);
  assert.deepEqual(report.findings.map(f=>f.code),['cross_chat_hierarchy','cross_chat_request','artifact_without_resolvable_chat']);
  assert.equal(report.findings[2].examples[0].artifactId,'orphan');
}));
test("malformed artifact metadata and live agents without chat ownership fail closed",()=>fixture((db,path)=>{
  db.exec("UPDATE agents SET conversation_id=NULL WHERE id='D'; UPDATE managed_artifact_projection SET artifact_json='invalid';");
  assert.deepEqual(auditChatOwnership(path).findings.map(f=>f.code),['live_agent_without_valid_chat','artifact_without_resolvable_chat']);
}));
test("opening a missing database never creates it",()=>{
  const root=mkdtempSync(join(tmpdir(),"ponderosa-chat-audit-missing-")), path=join(root,"missing.db");
  try { assert.throws(()=>auditChatOwnership(path)); assert.equal(existsSync(path),false); }
  finally { rmSync(root,{recursive:true,force:true}); }
});
test("inventory rejects a named pipe without waiting for a writer",{skip:process.platform==='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),"ponderosa-chat-audit-fifo-")), path=join(root,"input.db");
  try {
    execFileSync('mkfifo',[path]);
    const module=new URL('../dist/chat-ownership-audit.js',import.meta.url).href;
    execFileSync(process.execPath,['--input-type=module','-e',
      `import assert from 'node:assert/strict';import {auditChatOwnership} from ${JSON.stringify(module)};assert.throws(()=>auditChatOwnership(${JSON.stringify(path)},{inventory:true}),/regular offline SQLite export/);`],{timeout:3000});
    assert.deepEqual(readdirSync(root),['input.db']);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("inventory rejects WAL inputs without creating, deleting or changing database sidecars",()=>fixture((db,path)=>{
  db.pragma('journal_mode = WAL');
  db.exec("INSERT INTO projects VALUES ('committed-in-wal')");
  const manifest=()=>readdirSync(join(path,'..')).sort().map(name=>[name,readFileSync(join(path,'..',name))]);
  const before=manifest();
  assert.throws(()=>auditChatOwnership(path,{inventory:true}),/WAL input is not opened/);
  assert.deepEqual(manifest(),before,'committed WAL and shared-memory bytes are untouched');
  db.close();
  const closed=manifest();
  assert.throws(()=>auditChatOwnership(path,{inventory:true}),/WAL input is not opened/);
  assert.deepEqual(manifest(),closed,'closed WAL-mode database does not acquire new sidecars');
}));
test("inventory rejects dangling sidecar symlinks without following or changing them",{skip:process.platform==='win32'},()=>fixture((db,path)=>{
  const before=readFileSync(path);
  for(const suffix of ['-wal','-shm','-journal']) {
    const sidecar=path+suffix,target=path+'.missing';symlinkSync(target,sidecar);
    const names=readdirSync(join(path,'..')).sort();
    assert.throws(()=>auditChatOwnership(path,{inventory:true}),/without sidecars/);
    assert.deepEqual(readFileSync(path),before);
    assert.deepEqual(readdirSync(join(path,'..')).sort(),names);
    assert.equal(readlinkSync(sidecar),target);assert.equal(existsSync(target),false);
    unlinkSync(sidecar);
  }
}));
for (const change of ['pathname', 'ancestor', '-wal', '-shm', '-journal']) {
  test(`inventory rejects ${change} replacement at descriptor closure without opening or writing input SQLite`, () => fixture((db, originalPath) => {
    const root = join(originalPath, '..'), input = join(root, 'input'), replacement = join(root, 'replacement');
    fs.mkdirSync(input); fs.mkdirSync(replacement);
    const path = join(input, 'audit.db');
    fs.copyFileSync(originalPath, path);
    const walPath = join(replacement, 'audit.db');
    fs.copyFileSync(originalPath, walPath);
    const wal = new Database(walPath); wal.pragma('journal_mode = WAL'); wal.close();
    const manifest = () => fs.readdirSync(input).sort().map(name => [name, fs.readFileSync(join(input, name))]);
    const source = fs.statSync(path), close = fs.closeSync;
    let changed = false, expected, error;
    fs.closeSync = fd => {
      const stat = fs.fstatSync(fd);
      close(fd);
      if (changed || stat.ino !== source.ino || stat.dev !== source.dev) return;
      changed = true;
      if (change === 'pathname') { fs.renameSync(path, path + '.original'); fs.renameSync(walPath, path); }
      else if (change === 'ancestor') { fs.renameSync(input, input + '.original'); fs.renameSync(replacement, input); }
      else fs.writeFileSync(path + change, 'disposable sidecar');
      expected = manifest();
    };
    syncBuiltinESMExports();
    try { auditChatOwnership(path, { inventory: true }); } catch (failure) { error = failure; }
    finally { fs.closeSync = close; syncBuiltinESMExports(); }
    assert(changed, 'race hook must reach the validated source descriptor');
    assert.deepEqual(manifest(), expected, 'audit never creates, deletes or changes input-side files');
    assert.match(String(error), /input changed|without sidecars/, 'changed source must be rejected, not inventoried');
  }));
}
test('inventory rejects same-inode mutation during bounded copy and removes private staging', () => fixture((db, path) => {
  const read = fs.readSync;
  let changed = false, error;
  const before = fs.readdirSync(tmpdir()).filter(name => name.startsWith('ponderosa-audit-')).sort();
  fs.readSync = (...args) => {
    const count = read(...args);
    if (!changed && args[3] > 20) { changed = true; db.exec("INSERT INTO projects VALUES ('changed-during-copy')"); }
    return count;
  };
  syncBuiltinESMExports();
  try { auditChatOwnership(path, { inventory: true }); } catch (failure) { error = failure; }
  finally { fs.readSync = read; syncBuiltinESMExports(); }
  assert(changed);
  assert.match(String(error), /input changed/);
  assert.deepEqual(fs.readdirSync(tmpdir()).filter(name => name.startsWith('ponderosa-audit-')).sort(), before);
}));
test('inventory inspects only a private snapshot and removes it on success and SQLite failure', () => fixture((db, path) => {
  const pragma = Database.prototype.pragma, opened = [];
  Database.prototype.pragma = function (...args) { opened.push(this.name); return pragma.apply(this, args); };
  try {
    const before = fs.readFileSync(path);
    assert.equal(auditChatOwnership(path, { inventory: true }).counts.chats, 2);
    assert.equal(opened.length, 1); assert.notEqual(opened[0], path);
    assert.equal(fs.existsSync(opened[0]), false, 'private snapshot is removed after inspection');
    assert.deepEqual(fs.readFileSync(path), before);
    db.exec('DROP TABLE projects');
    assert.throws(() => auditChatOwnership(path, { inventory: true }), /no such table/);
    assert.equal(opened.length, 2); assert.equal(fs.existsSync(opened[1]), false, 'query failure removes private snapshot too');
  } finally { Database.prototype.pragma = pragma; }
}));
test("optional migration inventory enumerates all sibling Chat identities and scoped tables without selecting an owner or writing",()=>fixture((db,path)=>{
  db.exec("CREATE TABLE extra_authority(id TEXT PRIMARY KEY,project_id TEXT,conversation_id TEXT); INSERT INTO extra_authority VALUES ('receipt','P','C2'); INSERT INTO projects VALUES ('empty');");
  const before=readFileSync(path), schemaBefore=db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  assert.equal(auditChatOwnership(path).inventory,undefined);
  const inventory=auditChatOwnership(path,{inventory:true}).inventory;
  assert.equal(inventory.status,'inventory_only'); assert.equal(inventory.migrationImplemented,false);
  assert.deepEqual(inventory.scopes,[{legacyScopeId:'P',chatIds:['C1','C2'],cardinality:'multiple'},{legacyScopeId:'empty',chatIds:[],cardinality:'empty'}]);
  assert.deepEqual(inventory.nonSingletonScopeIds,['P','empty']);
  assert.deepEqual(inventory.tables.find(table=>table.name==='extra_authority'),{name:'extra_authority',rows:1,primaryKey:['id'],scopeColumns:['project_id','conversation_id']});
  assert.match(inventory.schemaHash,/^[a-f0-9]{64}$/);assert.ok(inventory.requiredBeforeTransform.includes('companion_databases_and_browser_ownership'));
  assert.equal(inventory.schemaHash,auditChatOwnership(path,{inventory:true}).inventory.schemaHash);
  assert.deepEqual(readFileSync(path),before);assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(),schemaBefore);
}));
test("inventory distinguishes measured single-Chat scopes without substituting the legacy ID for the stable Chat ID",()=>fixture((db,path)=>{
  db.exec("DELETE FROM conversations WHERE id='C2'; UPDATE agents SET deleted_at='historical' WHERE id='D';");
  const {inventory}=auditChatOwnership(path,{inventory:true});
  assert.deepEqual(inventory.scopes,[{legacyScopeId:'P',chatIds:['C1'],cardinality:'single'}]);
  assert.deepEqual(inventory.nonSingletonScopeIds,[]);
  assert.equal(inventory.status,'inventory_only','even a single child does not qualify resource ownership or migration');
}));
test("inventory includes valid sqlite-like names, quoted identifiers and generated scope columns",()=>fixture((db,path)=>{
  db.exec(`CREATE TABLE sqliteXauthority(id TEXT PRIMARY KEY,source TEXT,project_id TEXT GENERATED ALWAYS AS (source) STORED,conversation_id TEXT GENERATED ALWAYS AS ('C1') VIRTUAL);
    INSERT INTO sqliteXauthority(id,source) VALUES ('owned','P');
    CREATE TABLE "quoted\"\"authority"("odd\"\"id" TEXT PRIMARY KEY,chat_id TEXT);
    INSERT INTO "quoted\"\"authority" VALUES ('exact','C1');`);
  const before=readFileSync(path), inventory=auditChatOwnership(path,{inventory:true}).inventory;
  assert.deepEqual(inventory.tables.find(table=>table.name==='sqliteXauthority'),{name:'sqliteXauthority',rows:1,primaryKey:['id'],scopeColumns:['project_id','conversation_id']});
  assert.deepEqual(inventory.tables.find(table=>table.name==='quoted"authority'),{name:'quoted"authority',rows:1,primaryKey:['odd"id'],scopeColumns:['chat_id']});
  const hash=inventory.schemaHash;db.exec('CREATE TABLE sqliteYauthority(id TEXT)');
  assert.notEqual(auditChatOwnership(path,{inventory:true}).inventory.schemaHash,hash,'valid sqlite-like schema contributes to fingerprint');
  // Only the explicit fixture CREATE changed bytes; each audit itself is read-only.
  assert.ok(before.length);const after=readFileSync(path);auditChatOwnership(path,{inventory:true});assert.deepEqual(readFileSync(path),after);
}));
test("human-authored documents resolve through communication ownership, not a fictitious agent",()=>fixture((db,path)=>{
  db.exec(`UPDATE managed_artifact_projection SET artifact_json='{"originAgentId":"local-operator"}',owner_kind='communication',owner_id='message';
    INSERT INTO chat_search_messages VALUES ('P','message','C1'),('P','message','C1');`);
  assert.deepEqual(auditChatOwnership(path).findings,[]);
  assert.equal(auditChatOwnership(path).canonicalJournalVerificationRequired,true);
  db.exec("INSERT INTO chat_search_messages VALUES ('P','message','C2');");
  assert.equal(auditChatOwnership(path).findings[0].code,'artifact_without_resolvable_chat');
}));
