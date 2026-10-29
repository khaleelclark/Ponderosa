import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript');
import {readdir,readFile,writeFile} from 'node:fs/promises';
const rows=[];async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=dir+'/'+entry.name;if(entry.isDirectory())await scan(file);else if(file.endsWith('.tsx')){const source=await readFile(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);function visit(node){if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){const tag=node.tagName.getText(tree),attrs=node.attributes.properties.map(p=>p.getText(tree));if(['Composer','ComposerEditor','TextField','Input','OutlinedInput','InputBase','input','textarea','ContentEditable'].includes(tag)||attrs.some(a=>/^component=["']textarea/.test(a))){const line=tree.getLineAndCharacterOfPosition(node.getStart()).line+1;rows.push({file,line,tag,attributes:attrs});}}ts.forEachChild(node,visit);}visit(tree);}}}await scan('apps/web/src');const chatFiles=new Map([
 ['AgentCreateDialog.tsx','Agent initial task: Core create route and Branches embedded form'],
 ['AgentDetail.composer.tsx','Agent private Chat: Core, Branches, Assistant and output'],
 ['AllChatView.tsx','Global Inbox target-required reply'],
 ['ConversationView.tsx','Core and Branches shared Chat'],
 ['Composer.controls.tsx','Shared main editor'],
 ['ComposerEditor.tsx','Shared Lexical contenteditable'],
 ['Composer.tsx','Long pasted-text View or edit dialog'],
 ['QueuedMessageTray.tsx','Queue editing in shared Chat, Agent private Chat and Inbox'],
 ['DecisionResponseDialog.tsx','Single/grouped answers and alternatives in timeline, notification and execution callers'],
 ['RuntimeElicitationActions.tsx','Provider form and URL alternative response'],
 ['VoiceConversation.tsx','Expanded typed call turn in shared Chat, Agent private Chat, Inbox and standalone routes'],
]);
for(const row of rows){const name=row.file.split('/').at(-1),attrs=row.attributes.join(' ');let chat=chatFiles.has(name);
 if(name==='AgentCreateDialog.tsx')chat=attrs.includes('Initial message (optional)');
 if(name==='Composer.controls.tsx')chat=row.tag==='ComposerEditor';
 if(name==='VoiceConversation.tsx')chat=attrs.includes('Your next turn');
 if(name==='RuntimeElicitationActions.tsx')chat=attrs.includes('Tell the Agent what you want instead');
 row.classification=chat?'chat input or shared editor':'non-chat input';
 row.disposition=chat?chatFiles.get(name):row.file.includes('/browser/')?'Remote browser keyboard/control; not an authored Ponderosa message':attrs.includes('type="file"')?'Attachment/package file selector, not a text editor':'Settings, search, navigation, structured provider/workflow field or read-only preview; not chat composition';
}
await writeFile(process.argv[2]??'docs/ui-chat-input-census.json',JSON.stringify({scope:'All source JSX input declarations, classified by rendered purpose',declarations:rows},null,2)+'\n');console.log(rows.length+' source input declarations');for(const r of rows.filter(r=>r.tag==='Composer'||r.tag==='ComposerEditor'||r.tag==='ContentEditable'||r.attributes.some(a=>a==='multiline')))console.log(r.file+':'+r.line+' '+r.tag+' '+(r.attributes.find(a=>a.startsWith('label='))??''));
