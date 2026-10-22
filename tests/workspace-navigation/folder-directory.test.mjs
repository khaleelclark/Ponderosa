import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const serverRequire = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const agentsRequire = createRequire(new URL('../../packages/agents/package.json', import.meta.url));
const Fastify = serverRequire('fastify'), Database = agentsRequire('better-sqlite3');
const { registerWorkspaceDirectoryRoutes } = await import('../../apps/server/dist/routes/workspace-directory.js');

function fixture(count = 60) {
  const sqlite = new Database(':memory:');
  // Real SQL execution; minimal empty tables only for unrelated count subqueries.
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, label TEXT, host_path TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, branch_id TEXT);
    CREATE TABLE conversation_deletion_receipts (conversation_id TEXT PRIMARY KEY, project_id TEXT, branch_id TEXT, canonical_deletion_completed INTEGER);
    CREATE TABLE project_deletion_pending (project_id TEXT);
    CREATE TABLE agent_deletion_pending (agent_id TEXT);
    CREATE TABLE branch_installation_resources (local_id TEXT, state TEXT);
    CREATE TABLE branches (id TEXT, deleting INTEGER);
    CREATE TABLE collection_generations (name TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    CREATE TABLE agent_conversation_memberships (agent_id TEXT, conversation_id TEXT);
    CREATE TABLE agents (id TEXT, project_id TEXT, conversation_id TEXT, deleted_at TEXT);
    CREATE TABLE agent_creation_operation_members (agent_id TEXT, operation_id TEXT);
    CREATE TABLE agent_creation_operations (id TEXT, status TEXT);
    CREATE TABLE scheduler_runs (agent_id TEXT, status TEXT);
    CREATE TABLE context_rollovers (agent_id TEXT, state TEXT);
    INSERT INTO collection_generations VALUES ('projects',1),('conversations',1);
  `);
  const projects = new Map(), conversations = new Map(), conversationReads = [];
  const project = (id, label) => {
    const value = { id, label, hostPath: '/fixture/' + id, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z' };
    projects.set(id, value);
    sqlite.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(id, label, value.hostPath, value.createdAt, value.updatedAt);
    return value;
  };
  const a = project('project-a', 'Owning Project'), b = project('project-b', 'Outside Project');
  const chat = (id, owner, title, index) => {
    const value = { id, projectId: owner.id, title, defaultEngine: 'codex', instructions: 's'.repeat(8192), createdAt: '2026-10-19T00:00:00.000Z', updatedAt: new Date(Date.UTC(2026,9,19,0,0,index)).toISOString() };
    conversations.set(id, value);
    sqlite.prepare('INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, owner.id, title, value.createdAt, value.updatedAt);
    return value;
  };
  const rows = Array.from({length:count}, (_,i) => chat('chat-' + String(i).padStart(3,'0'), a, i === 37 ? 'Z Needle 100% under_score café 東京' : 'A Chat ' + String(i).padStart(3,'0'), i));
  const outside = chat('outside-chat', b, 'Z Needle outside', 61);
  sqlite.prepare('INSERT INTO conversation_deletion_receipts(conversation_id) VALUES (?)').run(rows[59].id);
  const folder = { id: 'saved-folder', name: 'Complete folder', expanded: true, starred: true,
    conversationIds: [...rows.slice(30).map(row => row.id), outside.id] };
  let preferences = { projectSort:'last_used', projectOrder:[], starredProjectIds:[], chatSort:'alphabetical', chatOrder:[],
    starredResourceIds:['conversation:' + rows[31].id], chatFolders:[folder] };
  const app = Fastify();
  registerWorkspaceDirectoryRoutes(app, {
    store: { sqlite, getProject:id => projects.get(id), getConversation:id => { conversationReads.push(id); return conversations.get(id); }, getAgent:() => undefined },
    workspace: { getPreferences:() => preferences },
    agentHealth() { throw Error('Folder summaries must not load Agent health'); },
    projectDisplayPath: value => value,
  });
  const request = async (query = {}) => {
    const response = await app.inject({ method:'GET', url:'/api/workspace/directory/conversation?' + new URLSearchParams({folders:'true',...query}) });
    return { status:response.statusCode, body:response.json() };
  };
  const read = async query => { const response=await request(query); assert.equal(response.status,200,JSON.stringify(response.body)); return response.body; };
  return { app, sqlite, rows, outside, folder, request, read, conversationReads,
    preferences:() => preferences, change:patch => { preferences={...preferences,...patch}; },
    close:async () => { await app.close(); sqlite.close(); } };
}
const ids = rows => rows.map(row => row.conversation.id);
const folderIds = page => ids(page.folderItems ?? []);

test('UI001 complete saved folder supplement precedes general continuation and preserves page bound', async t => {
  const f=fixture(); t.after(f.close);
  const page=await f.read({limit:'25'});
  assert.equal(page.items.length,25);
  assert.equal(page.starredItems.length,1);
  assert.equal(page.total,60); // 60 Project A +1 outside -1 deletion tombstone.
  assert.equal(page.history.hasMore,true); assert.ok(page.history.cursor);
  const expected=[...f.rows.slice(30,59).map(row=>row.id),f.outside.id].sort();
  assert.deepEqual(folderIds(page).sort(),expected,'Off-page members must exist before next-page fetch');
  assert.equal(folderIds(page).length,new Set(folderIds(page)).size);
  assert.ok(folderIds(page).includes(f.rows[31].id),'Starred folder member remains available');
  assert.ok(!folderIds(page).includes(f.rows[59].id),'Deletion tombstone excluded');
  const first=ids(page.items), all=[...first];
  let cursor=page.history.cursor;
  while(cursor) {
    const next=await f.read({limit:'25',cursor});
    assert.ok(next.items.length<=25); assert.deepEqual(next.folderItems ?? [],[],'Supplement belongs to initial page');
    all.push(...ids(next.items)); cursor=next.history.cursor;
  }
  assert.equal(all.length,59,'General pages omit only the one star, not folder members');
  assert.equal(all.length,new Set(all).size,'General cursor rows never duplicate');
  const sidebar=new Map([...page.folderItems,...page.starredItems,...page.items].map(item=>[item.conversation.id,item]));
  assert.equal([...sidebar.values()].filter(item=>item.conversation.id===f.rows[31].id).length,1,'Shared star/page/folder rows dedup by exact ID');
});

test('UI001 supplemental rows obey same project/conversation/literal search filters and summary omission', async t => {
  const f=fixture(); t.after(f.close);
  const scoped=await f.read({projectId:'project-a',limit:'25'});
  assert.ok(!folderIds(scoped).includes(f.outside.id)); assert.equal(folderIds(scoped).length,29);
  const exact=await f.read({projectId:'project-a',conversationId:f.rows[37].id});
  assert.deepEqual(folderIds(exact),[f.rows[37].id]);
  for(const search of ['100%','under_score','café 東京','  NEEDLE  ']) {
    const page=await f.read({projectId:'project-a',search});
    assert.deepEqual(folderIds(page),[f.rows[37].id]); assert.deepEqual(ids(page.items),[f.rows[37].id]);
  }
  assert.deepEqual(folderIds(await f.read({search:'no-such-fixture-term'})),[]);
  const summary=await f.read({summary:'true'});
  assert.deepEqual(summary.folderItems ?? [],[]); assert.deepEqual(summary.items,[]);
});

test('UI001 membership churn invalidates continuation with409 and fresh initial supplement', async t => {
  const f=fixture(); t.after(f.close);
  const first=await f.read({limit:'25'});
  f.change({chatFolders:[{...f.folder,conversationIds:[f.rows[29].id,...f.folder.conversationIds]}]});
  const stale=await f.request({limit:'25',cursor:first.history.cursor});
  assert.equal(stale.status,409,'Ordinary membership churn must use client transparent stale-cursor restart, not400');
  assert.equal(stale.body.code,'stale_collection_cursor');
  const fresh=await f.read({limit:'25'});
  assert.ok(folderIds(fresh).includes(f.rows[29].id));
  const wrongQuery=await f.request({limit:'25',search:'Needle',cursor:fresh.history.cursor});
  assert.equal(wrongQuery.status,400,'Cross-query cursor remains invalid');
});

test('UI001 folder presentation changes keep a valid general continuation', async t => {
  const f=fixture(); t.after(f.close);
  const first=await f.read({limit:'25'});
  f.change({chatFolders:[{...f.folder,name:'Renamed',expanded:false,starred:false,conversationIds:[...f.folder.conversationIds].reverse()}]});
  assert.equal((await f.request({limit:'25',cursor:first.history.cursor})).status,200,'Same membership set must not invalidate ordinary page ordering');
});

test('saved folder supplement is deduplicated and portable across bounded SQLite bindings', async t => {
  const f=fixture(1200); t.after(f.close);
  f.change({ chatFolders: [f.folder, { ...f.folder, id:'duplicate-members', conversationIds:[f.rows[31].id,'missing-chat'] }] });
  // Enforce the conservative SQLite host-parameter ceiling, independent of
  // this machine's larger compile-time limit. A single 1,171-ID query must fail.
  const prepare=f.sqlite.prepare.bind(f.sqlite);
  f.sqlite.prepare=sql => {
    const statement=prepare(sql), all=statement.all.bind(statement);
    statement.all=(...args) => { assert.ok(args.length<=999, 'Directory SQL must not assume a larger host parameter ceiling'); return all(...args); };
    return statement;
  };
  const page=await f.read({limit:'25'});
  assert.equal(page.items.length,25);
  const expected=[...f.rows.slice(30).filter(row=>row.id!==f.rows[59].id).map(row=>row.id),f.outside.id].sort();
  assert.deepEqual(folderIds(page).sort(),expected);
});


test('folder summaries omit instructions and never read each off-page conversation document', async t => {
  const f=fixture(260); t.after(f.close);
  const page=await f.read({limit:'25'});
  assert.equal(f.conversationReads.length,26,'Only25 general rows +1 star may use full conversation hydration');
  assert.ok(page.items.every(item=>item.conversation.instructions.length===8192));
  assert.ok(page.folderItems.length>200);
  for(const item of page.folderItems) {
    assert.deepEqual(Object.keys(item.conversation).sort(),['createdAt','id','projectId','title','updatedAt']);
    assert.equal(item.conversation.createdAt,'2026-10-19T00:00:00.000Z');
  }
  assert.ok(JSON.stringify(page.folderItems).length<150000,'Supplement must stay metadata-sized despite large instructions');
});


test('ordinary directory consumers do not load folder supplements or stale on membership changes', async t => {
  const f=fixture(); t.after(f.close);
  const first=await f.read({limit:'25',folders:'false'});
  assert.equal(first.folderItems,undefined);
  assert.equal(f.conversationReads.length,26);
  f.change({chatFolders:[{...f.folder,conversationIds:[]}]});
  assert.equal((await f.request({limit:'25',folders:'false',cursor:first.history.cursor})).status,200);
  assert.equal((await f.request({limit:'25',cursor:first.history.cursor})).status,400,'Folder projection is a distinct cursor scope');
});


test('folder activity reuses the same canonical member traversal for per-Chat badges', async t => {
  const f=fixture(260); t.after(f.close);
  const response=await f.app.inject({method:'POST',url:'/api/workspace/directory/activity',payload:{conversationIds:['chat-000'],chatFolders:[{id:'folder',conversationIds:[...f.rows.slice(30).map(row=>row.id),'missing-chat']}]}});
  assert.equal(response.statusCode,200,response.body);
  const result=response.json();
  assert.equal(Object.keys(result.conversations).length,232);
  assert.equal(result.conversations['chat-037'].unknownCount,0);
  assert.equal(result.conversations['missing-chat'].unknownCount,1);
  assert.equal(result.conversations['chat-059'].unknownCount,1,'Deleted Chat remains unknown, never invented idle');
  assert.equal(result.chatFolders.folder.unknownCount,2);
});

test('folder unread projections reuse canonical identity-deduped per-Chat counts', async () => {
  const { WorkspaceStore }=await import('../../packages/agents/dist/index.js');
  const notification=(id,patch={})=>({id,kind:'broadcasts',status:'open',projectId:'project',conversationId:'member',...patch});
  const messages=[notification('ordinary'),notification('important',{kind:'direct_responses'}),notification('multi',{kind:'everyone',conversationIds:['member','other']}),notification('read',{readAt:'now'}),notification('private-blocked'),notification('collab',{kind:'collaboration'}),notification('outside',{conversationId:'outside'}),notification('action',{kind:'operational',conversationId:undefined,conversationIds:['member']})];
  const owner={notifications:new Map(messages.map(item=>[item.id,item])),notificationAllowed:item=>item.id!=='private-blocked'};
  const body={projectIds:[],conversationIds:[],chatFolders:[{id:'folder',conversationIds:['member','other']}]};
  const result=WorkspaceStore.prototype.notificationProjection.call(owner,body);
  assert.deepEqual(result.conversations.member,{importantCount:2,ordinaryCount:1,totalCount:3});
  assert.deepEqual(result.conversations.other,{importantCount:1,ordinaryCount:0,totalCount:1});
  assert.deepEqual(result.chatFolders.folder,{importantCount:2,ordinaryCount:1,totalCount:3},'Multi-destination identity counts once for the folder');
  assert.equal(result.conversations.outside,undefined);
});
