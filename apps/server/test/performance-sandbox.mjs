// Disposable, loopback-only qualification server. Never accepts an existing data root.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentStore, WorkspaceStore } from '@ponderosa/agents';
import { createServer } from '../dist/app.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'ponderosa-directory-perf-'));
const store = new AgentStore(dataDir);
const workspace = new WorkspaceStore(dataDir);
const projects = [];
for (let p = 0; p < 3; p++) {
  const hostPath = path.join(dataDir, `source-${p}`);
  mkdirSync(hostPath);
  const project = store.createProject({ label: `Perf Project ${p}`, hostPath, defaultEngine: 'codex' });
  const conversations = Array.from({ length: 3 }, (_, c) => store.createConversation(project.id, { title: `Perf Chat ${c}` }));
  const agents = Array.from({ length: 12 }, (_, a) => store.createAgent(project.id, { title: `Perf Agent ${String(a).padStart(2, '0')}`, engine: 'codex', conversationId: conversations[a % 3].id }));
  projects.push({ ...project, conversations, agents });
}
const decision = process.env.PERF_QUALIFY === '1' ? workspace.createDecision({ projectId:projects[0].id, conversationId:projects[0].conversations[0].id, agentId:projects[0].agents[0].id, question:'Continue disposable qualification?',options:[],mode:'text',allowOther:true,idempotencyKey:'qualification' }) : undefined;
const app = createServer({ dataDir, store, engines: [], webDist: path.resolve('apps/web/dist'), logger: false, buildRevision: process.env.PERF_LABEL ?? 'baseline' });
await app.listen({ host: '127.0.0.1', port: 21843 });
writeFileSync('/tmp/ponderosa-perf-sandbox.json', JSON.stringify({ dataDir, projects, decision, pid: process.pid }));
console.log(JSON.stringify({ dataDir, pid: process.pid, url: 'http://127.0.0.1:21843' }));
process.on('SIGTERM', async () => { app.prepareForShutdown(); await app.close(); process.exit(0); });
