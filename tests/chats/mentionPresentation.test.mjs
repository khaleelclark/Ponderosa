import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveAgentMentionBindings, recipientMentionIdentities } from '../../apps/server/src/mention-bindings.ts';
import { communicationMentionBindings } from '../../packages/agents/src/store-mention-bindings.ts';
import { messageProseTagTokens, resolveMessageMentionText } from '../../apps/web/src/components/chat/messageMentionPresentation.ts';
const { ChatMessageBody, communicationVisibleText, authoredAgentMentionForHandle } = await import('../../apps/web/src/components/chat/ChatMessages.tsx');
const { MutationNotificationProvider } = await import('../../apps/web/src/components/MutationNotifications.tsx');
const { providerCommandResultText } = await import('../../apps/web/src/providerCommandResult.ts');
const fullNativeGoal = { threadId:'native-thread', objective:'Start of objective\n'+'x'.repeat(2200)+'\nEND OF OBJECTIVE', status:'paused', tokenBudget:10000, tokensUsed:42, timeUsedSeconds:7, createdAt:1, updatedAt:2 };

const projectId = 'fbe0e9a6-8af1-55c3-9805-9d3daa984a1b';
const agentId = 'a6cc0309-455b-4e2f-88f3-d630ca060b1c';
const agent = { id: agentId, title: 'Build Coordinator', handle: 'Build-Coordinator', projectId };
const fragment = 'CY083Ht8uv2B1Ww4YmGJ9QdGfc6SS70+PX3+SY-ptcJHhZHa1';
const url = `https://wynnbuilder.github.io/builder/#${fragment}`;
const binding = handle => ({ projectId, agentId, handle, currentHandle: agent.handle, currentTitle: agent.title });
const visible = (text, mentions) => communicationVisibleText({ text, intent: 'user_dm', fromAgent: false, agentMentions: mentions });
const render = (text, mentions) => renderToStaticMarkup(React.createElement(MutationNotificationProvider, null, React.createElement(ChatMessageBody, {
  text, agentMentions: mentions, agentMentionForHandle: handle => authoredAgentMentionForHandle(handle, mentions),
  collapseLongMessage: false, onOpenAgent() {},
})));
const hrefs = html => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/gu)].map(match => match[1].replaceAll('&amp;', '&'));

test('an unopened Chat export menu does not prepare a lazy transcript', async () => {
  const {ChatOverflowMenu} = await import('../../apps/web/src/components/ChatOverflowMenu.tsx');
  let preparations = 0;
  const html = renderToStaticMarkup(React.createElement(MutationNotificationProvider, null,
    React.createElement(ChatOverflowMenu, {actions: [], transcriptFileName: 'owned.md', transcriptMarkdown: () => {preparations++; return '# Owned transcript\n';}})));
  assert.equal(preparations, 0);
  assert.match(html, /aria-label="Chat Actions"/u);
});

test('literal/no-tag messages skip Markdown parsing and a supplied tree is reused', async () => {
  const {createRequire} = await import('node:module');
  const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const {unified} = await import(webRequire.resolve('unified'));
  const {default:remarkParse} = await import(webRequire.resolve('remark-parse'));
  const {default:remarkGfm} = await import(webRequire.resolve('remark-gfm'));
  const processor = unified().use(remarkParse).use(remarkGfm);
  const prototype = Object.getPrototypeOf(processor), original = prototype.parse;
  let parses = 0;
  prototype.parse = function (...args) { parses++; return original.apply(this, args); };
  try {
    for (const text of ['Plain **Markdown**, λ😀, no tags.', '123', '"#Original-Builder"', '{"agent":"#Original-Builder"}']) {
      assert.deepEqual(messageProseTagTokens(text), [], text);
    }
    assert.equal(parses, 0, 'No rich parse for no-token text or literal JSON');
    const text = '| Task | Owner |\n| --- | --- |\n| ~~before~~ | #Original-Builder |\n\n`#literal` [link](https://example.com/#literal)';
    const expected = messageProseTagTokens(text);
    assert.deepEqual(expected.map(token => token.handle), ['Original-Builder']);
    assert.equal(parses, 1, 'Tagged GFM is parsed normally');
    const tree = processor.parse(text); parses = 0;
    assert.deepEqual(messageProseTagTokens(text, tree), expected);
    assert.equal(parses, 0, 'Existing parsed AST is traversed without parsing again');
    parses = 0;
    const ordinary = render('**Bold** ~~before~~ #unbound [local anchor](#history)', []);
    assert.equal(parses, 1, 'Only the normal rich renderer parses unbound prose/fragment handles');
    assert.match(ordinary, /<strong>Bold<\/strong>/u);
    assert.match(ordinary, /<del>before<\/del>/u);
    assert.ok(!ordinary.includes('Open agent'));
    parses = 0;
    assert.match(render('#Original-Builder', [binding('Original-Builder')]), /Open agent Build-Coordinator/u);
    assert.equal(parses, 2, 'Bound mention projection retains the full opaque-region parse');
    const renderOptions = props => renderToStaticMarkup(React.createElement(MutationNotificationProvider, null, React.createElement(ChatMessageBody, {collapseLongMessage: false, ...props})));
    for (const handle of ['user', 'pto', 'broadcast', 'everyone', 'new-agent', 'My-Operator']) {
      parses = 0;
      const html = renderOptions({text: '#'+handle, operatorHandle: 'My-Operator', onOpenBroadcast() {}});
      assert.equal(parses, 2, handle+' retains reserved/operator projection');
      if (handle === 'broadcast') assert.match(html, /Open originating broadcast/u);
    }
    parses = 0;
    const recipients = renderOptions({text: '`#Original-Builder`', agentMentions: [binding('Original-Builder')], collaborationRecipients: [{id: agentId, handle: 'Original-Builder', title: 'Builder', currentTitle: 'Builder', available: true}], onOpenAgent() {}});
    assert.equal(parses, 2, 'Canonical recipient prefix keeps full authored/opaque accounting');
    assert.match(recipients, /Open agent Original-Builder/u);
  } finally { prototype.parse = original; }
});

test('one unmatched nonnumeric token is never inferred from the DM recipient', () => {
  for (const text of [url, `${url}\n${url}`, '#unknown Please review', '#123 Please review']) {
    const mentions = resolveAgentMentionBindings(projectId, text, [agentId], [agent]);
    assert.deepEqual(mentions.map(mention => mention.handle), [agent.handle]);
    assert.ok(visible(text, mentions).endsWith(text));
  }
});

test('delivered single/multiple WynnBuilder hrefs survive even an already guessed binding', () => {
  const stale = [binding(fragment.split('+')[0])];
  for (const text of [url, `[Build](${url})`, `[First](${url})\n\n[Second](${url}&mode=2)`, `<${url}>`]) {
    const resolved = visible(text, stale);
    assert.ok(resolved.includes(url));
    const links = hrefs(render(resolved, stale));
    assert.deepEqual(links, text.includes('[Second]') ? [url, `${url}&mode=2`] : [url]);
    assert.ok(!links.some(link => link.includes('#Build-Coordinator')));
  }
});

test('known current/historical handles inside URL destinations remain literal', () => {
  const mentions = [binding('Original-Builder')];
  const text = '#Original-Builder review [site](https://example.com/#Original-Builder) and https://example.org/#Original-Builder';
  const resolved = visible(text, mentions);
  assert.match(resolved, /^#Build-Coordinator review/);
  assert.deepEqual(hrefs(render(resolved, mentions)), ['https://example.com/#Original-Builder', 'https://example.org/#Original-Builder']);
});

test('copy/source presentation preserves code, images, references, escaped tags and JSON data', () => {
  const mentions = [binding('Original-Builder')];
  const literals = [
    '`#Original-Builder`', '```json\n{"agent":"#Original-Builder"}\n```',
    '    #Original-Builder\n', '![#Original-Builder](https://example.com/#Original-Builder)',
    '[label][ref]\n\n[ref]: https://example.com/#Original-Builder "#Original-Builder"',
    '\\#Original-Builder', '{"agent":"#Original-Builder","nested":["#Original-Builder"]}',
    'Payload: {"agent":"#Original-Builder","nested":{"tag":"#Original-Builder"}}',
    '"#Original-Builder"', '<span data-agent="#Original-Builder"></span>',
  ];
  for (const literal of literals) assert.equal(resolveMessageMentionText(literal, mentions), literal, literal);
  const json = '{"agent":"#Original-Builder","nested":["#Original-Builder"]}';
  assert.ok(!render(json, mentions).includes('Build-Coordinator'));
  assert.match(render(literals[3], mentions), /src="https:\/\/example.com\/#Original-Builder"/u);
});

test('durable historical aliases and current mentions still resolve to the real stable recipient', () => {
  const identities = recipientMentionIdentities([agentId], [agent], { [agentId]: 'Original Builder' }, { [agentId]: 'Original-Builder' });
  const mentions = resolveAgentMentionBindings(projectId, '#Original-Builder and #Build-Coordinator', [agentId], identities);
  assert.ok(mentions.some(mention => mention.handle === 'Original-Builder' && mention.agentId === agentId));
  assert.equal(resolveMessageMentionText('#Original-Builder and #Build-Coordinator', mentions), '#Build-Coordinator and #Build-Coordinator');
  const durable = communicationMentionBindings('#Original-Builder', {
    eventId: 'renamed-message', projectId, intent: 'user_dm', audience: { kind: 'user_agent', agentId },
    identity: { senderLabel: 'User', recipientHandles: { [agentId]: 'Original-Builder' }, recipientLabels: { [agentId]: 'Original Builder' } },
  }, () => agent);
  assert.equal(resolveMessageMentionText('Hello #original-builder!', durable), 'Hello #Build-Coordinator!');
  const html = render('Hello #Original-Builder!', durable);
  assert.match(html, /#Build-Coordinator/u);
  assert.match(html, /Originally authored as #Original-Builder/u);
});

test('prose mentions stay clickable beside decoded entities and escapes without activating literal hashes', () => {
  const mentions = [binding('Original-Builder')];
  for (const text of [
    'Hi #Original-Builder, use A &amp; B',
    'Hi #Original-Builder, use \\*literal\\*',
    'A &amp; B: #Original-Builder',
    '\\#Original-Builder then #Original-Builder',
    '&#35;Original-Builder then #Original-Builder',
    '> A &amp; B\n> #Original-Builder',
  ]) {
    const html = render(resolveMessageMentionText(text, mentions), mentions);
    assert.equal([...html.matchAll(/aria-label="Open agent Build-Coordinator/gu)].length, 1, text);
  }
  const numeric = [binding('35')];
  assert.equal(resolveMessageMentionText('A &#35; B', numeric), 'A &#35; B');
  assert.ok(!render('A &#35; B', numeric).includes('Open agent Build-Coordinator'));
});

test('opaque Markdown cannot leak JSON scanner state into a later literal payload', () => {
  const mentions = [binding('Original-Builder')];
  const payload = 'Payload: {"agent":"#Original-Builder","url":"https://example.com/#Original-Builder","code":"`#Original-Builder`"}';
  for (const prefix of ['`{"`', '```json\n{"\n```', '<span data-prefix="{\'"></span>', '[example](https://example.com/ "{\\\"")']) {
    const text = `${prefix}\n\n${payload}\n\nNext: #Original-Builder`;
    const resolved = resolveMessageMentionText(text, mentions);
    assert.equal(resolved, `${prefix}\n\n${payload}\n\nNext: #Build-Coordinator`, prefix);
    const html = render(resolved, mentions);
    assert.equal([...html.matchAll(/aria-label="Open agent Build-Coordinator/gu)].length, 1, prefix);
  }
});

test('native browser: rendered href, Open-link actions and whole-message/code copy retain exact URLs', {
  skip: process.env.PONDEROSA_REGRESSION_MENTION_BROWSER !== '1', timeout: 120000,
}, async t => {
  const { createRequire } = await import('node:module');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const webRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url));
  const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const serverRequire = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const { createRsbuild } = webRequire('@rsbuild/core');
  const { pluginReact } = webRequire('@rsbuild/plugin-react');
  const { chromium } = serverRequire('playwright-core');
  await mkdir(path.join(webRoot, 'node_modules/.cache'), { recursive: true });
  const root = await mkdtemp(path.join(webRoot, 'node_modules/.cache/mention-browser-'));
  let browser, preview;
  t.after(async () => { await browser?.close(); await preview?.server.close(); await rm(root, { recursive: true, force: true }); });
  const payload = 'Payload: {"agent":"#Original-Builder"}';
  const text = `#Original-Builder review &amp; use \\*literal\\* [Build](${url})\n\n${url}&second=2\n\n\`\`\`text\n${url}\n\`\`\`\n\n\`{"\`\n\n${payload}`;
  const mentions = [binding('Original-Builder'), binding(fragment.split('+')[0])];
  await writeFile(path.join(root, 'entry.tsx'), `
    import React from 'react';
    import ${JSON.stringify(path.join(webRoot, 'src/global.css'))};
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { MainConversationTimeline } from ${JSON.stringify(path.join(webRoot, 'src/components/ConversationView.parts.tsx'))};
    import { ChatSurface } from ${JSON.stringify(path.join(webRoot, 'src/components/chat/ChatSurface.tsx'))};
    import { useConversationMessageFocusRefs, useConversationMessageFocusEffect, useConversationMessageFocusCleanup } from ${JSON.stringify(path.join(webRoot, 'src/components/useConversationMessageFocus.ts'))};
    import { unified } from ${JSON.stringify(webRequire.resolve('unified'))};
    import remarkParse from ${JSON.stringify(webRequire.resolve('remark-parse'))};
    import { ChatMessageBody, communicationVisibleText, authoredAgentMentionForHandle } from ${JSON.stringify(path.join(webRoot, 'src/components/chat/ChatMessages.tsx'))};
    import { ChatOverflowMenu } from ${JSON.stringify(path.join(webRoot, 'src/components/ChatOverflowMenu.tsx'))};
    import { CopyMessageButton } from ${JSON.stringify(path.join(webRoot, 'src/components/CopyMessageButton.tsx'))};
    import { MutationNotificationProvider } from ${JSON.stringify(path.join(webRoot, 'src/components/MutationNotifications.tsx'))};
    import { ProjectBrowserContext } from ${JSON.stringify(path.join(webRoot, 'src/components/ProjectBrowserContext.tsx'))};
    const mentions = ${JSON.stringify(mentions)};
    const text = communicationVisibleText({ text: ${JSON.stringify(text)}, intent: 'user_dm', fromAgent: false, agentMentions: mentions });
    window.transcriptPreparations = 0;
    const longText = Array.from({length: 90}, (_, i) => 'Long message paragraph '+i+' with retained words and original text.').join('\\n\\n')+'\\n\\nEND OF LONG SOURCE';
    const root = createRoot(document.getElementById('root')!);
    window.rerender = () => root.render(<MutationNotificationProvider><ProjectBrowserContext.Provider value={{ projectId: 'test', open(url) { window.openedInside = url; } }}>
      <ChatMessageBody text={text} agentMentions={mentions} agentMentionForHandle={handle => authoredAgentMentionForHandle(handle, mentions)} onOpenAgent={id => { window.openedAgent = id; }} collapseLongMessage={false} />
      <CopyMessageButton text={text} />
      <section aria-label="Long message wrapper check"><ChatMessageBody text={longText} /></section>
      <ChatOverflowMenu label="Transcript failure test" actions={[]} transcriptFileName="owned.md" transcriptMarkdown={() => { window.transcriptPreparations++; throw new Error('Controlled transcript formatting failed'); }} />
    </ProjectBrowserContext.Provider></MutationNotificationProvider>);
    window.rerender();

    const memoClient = new QueryClient({defaultOptions:{queries:{enabled:false,staleTime:Infinity}}});memoClient.setQueryData(['workspace-preferences'],{});
    const memoAgent = mentions[0].agentId, memoTitle = () => 'Fixture Agent', memoHandle = () => memoAgent, memoNoop = () => {};
    const memoText = '#Original-Builder **retained prose** [working file](./report.txt) [app](http://127.0.0.1:3000/)';
    function MarkdownMemoProbe(){
      const [state,setState] = React.useState({receipt:0,health:0,bindings:[{...mentions[0],available:true}],ownerAgent:memoAgent,ownerChat:'fixture-chat',activeRun:'fixture-run',navigation:0,step:0});
      window.patchMarkdownMemo = patch => flushSync(()=>setState(before=>({...before,...patch,step:before.step+1})));
      const message = React.useMemo(()=>({id:'memo-message',conversationId:state.ownerChat,role:'assistant',authorAgentId:state.ownerAgent,executionId:'fixture-run',communicationIntent:'broadcast',text:memoText,createdAt:'2026-10-20T12:00:00Z',agentMentions:state.bindings,...(state.receipt?{deliveryReceipts:[]}: {})}),[state.receipt,state.bindings,state.ownerAgent,state.ownerChat]);
      const timeline = React.useMemo(()=>[{kind:'message',id:'memo-message',at:message.createdAt,message}],[message]);
      const health = React.useMemo(()=>new Map([[memoAgent,{runtimeActivity:{executionId:state.activeRun}}]]),[state.activeRun,state.health]);
      const navigate = React.useCallback(id=>{window.memoOpened={id,revision:state.navigation};},[state.navigation]);
      const recipients = React.useMemo(()=>[{id:memoAgent,handle:'Original-Builder',title:'Builder',currentTitle:state.bindings[0].currentTitle,available:state.bindings[0].available}],[state.bindings]);
      React.useEffect(()=>{window.markdownMemoStep=state.step;},[state.step]);
      return <QueryClientProvider client={memoClient}><section aria-label="Memo timeline"><MainConversationTimeline mainTimeline={timeline} projectId="test" healthByAgentId={health} agentTitle={memoTitle} agentIdForHandle={memoHandle} onOpenAgent={navigate} mentionAgent={memoNoop} markCommunicationVisible={memoNoop} notifications={[]}/></section><section aria-label="Memo collaboration"><ChatMessageBody text="#Original-Builder" collaborationRecipients={recipients} agentMentions={state.bindings} onOpenAgent={navigate}/></section></QueryClientProvider>;
    }
    window.mountMarkdownMemo = () => {
      window.markdownParses=0;
      const prototype=Object.getPrototypeOf(unified().use(remarkParse)),parse=prototype.parse;
      prototype.parse=function(...args){window.markdownParses++;return parse.apply(this,args);};
      root.render(<MutationNotificationProvider><ProjectBrowserContext.Provider value={{projectId:'test',open(){}}}><MarkdownMemoProbe/></ProjectBrowserContext.Provider></MutationNotificationProvider>);
    };

    const transcriptRows = Array.from({length:100},(_,i)=>({kind:'message',id:'row-'+i,at:'2026-10-20T12:00:00Z',
      message:{id:'row-'+i,conversationId:'loading-chat',role:'user',text:'Row '+String(i).padStart(3,'0')+' **retained text** '+(i===99?longText:'short content.'),
      createdAt:'2026-10-20T12:00:00Z'}}));
    let loadingProbe = 0;
    window.holdTranscriptTasks = false;window.transcriptTasks=[];
    const nativePostTask=window.scheduler.postTask.bind(window.scheduler);
    window.scheduler.postTask=(callback,options={})=>{
      if(!window.holdTranscriptTasks||options.priority!=='background')return nativePostTask(callback,options);
      return new Promise((resolve,reject)=>{
        options.signal?.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')),{once:true});
        window.transcriptTasks.push({signal:options.signal,run:()=>{try{resolve(callback());}catch(error){reject(error);}}});
      });
    };
    window.runTranscriptBatch=()=>{const task=window.transcriptTasks.find(task=>!task.signal?.aborted);if(!task)throw Error('No pending transcript task');window.transcriptTasks.splice(window.transcriptTasks.indexOf(task),1);task.run();};
    function InitialTranscriptProbe({reveal,height,probe}){
      const [items,setItems]=React.useState([]),[showAll,setShowAll]=React.useState(reveal);
      const key='initial-transcript-'+probe;
      window.installTranscript=()=>flushSync(()=>setItems(transcriptRows));
      window.mutateTranscript=()=>flushSync(()=>setItems(before=>[{...transcriptRows[0],id:'added',message:{...transcriptRows[0].message,id:'added',text:'Added first row'}},...before]));
      window.focusTranscript=()=>flushSync(()=>setShowAll(true));
      window.transcriptData=items;
      const {focusedMessage,focusedMessageHighlightDisposer}=useConversationMessageFocusRefs();
      useConversationMessageFocusCleanup(focusedMessageHighlightDisposer);
      useConversationMessageFocusEffect({activeView:'main',collaborationMessages:[],collaborationQuery:{},conversationId:'loading-chat',
        detailQuery:{data:{messages:items.map(item=>item.message)}},focusedMessage,focusedMessageHighlightDisposer,
        focusMessageId:showAll&&items.length?'row-0':undefined,initialView:'main',messages:items.map(item=>item.message),
        setActiveView:memoNoop,setOlderCollaboration:memoNoop,setOlderMain:memoNoop});
      return <QueryClientProvider client={memoClient}><div data-transcript-probe={probe}><section aria-label="Loaded transcript copy"><input aria-label="Outside transcript editor" defaultValue="Retained editor draft" /><CopyMessageButton text={items.map(item=>item.message.text).join('\\n')}/></section>
        <div style={{height,width:'100%',minHeight:0}}><ChatSurface label="Initial transcript" layout="project" layoutKey={items.map(item=>item.id).join(':')}
          initialTranscript={{rowIds:items.map(item=>item.id),reveal:showAll}} follow={{kind:'latest',storageKey:key,onPositionChange(element,latest){window.transcriptPositions.push({key,latest,top:element.scrollTop,height:element.scrollHeight,rows:element.querySelectorAll('article').length});}}}
          history={{kind:'cursor',hasEarlier:true,loading:false,onLoadEarlier(){window.historySawComplete=document.querySelectorAll('article').length;}}}>
          {firstMountedIndex=><div data-loaded-transcript><MainConversationTimeline mainTimeline={items} firstMountedIndex={firstMountedIndex} projectId="test" healthByAgentId={new Map()} agentTitle={memoTitle} agentIdForHandle={memoHandle} onOpenAgent={memoNoop} mentionAgent={memoNoop} markCommunicationVisible={memoNoop} notifications={[]}/></div>}
        </ChatSurface></div></div></QueryClientProvider>;
    }
    window.mountInitialTranscript=({saved=false,reveal=false,height=1400}={})=>{
      loadingProbe++;window.transcriptTasks=[];window.transcriptPositions=[];
      const key='initial-transcript-'+loadingProbe;
      if(saved)localStorage.setItem(key,'0');else localStorage.removeItem(key);
      flushSync(()=>root.render(<MutationNotificationProvider><InitialTranscriptProbe key={loadingProbe} probe={loadingProbe} reveal={reveal} height={height}/></MutationNotificationProvider>));
    };
    window.initialTranscriptSnapshot=()=>{
      const container=document.querySelector('[data-transcript-probe="'+loadingProbe+'"] .chat-scroll-region'),rows=container.querySelector('[data-loaded-transcript]');
      const box=container.getBoundingClientRect(),articles=[...rows.querySelectorAll('article')];
      const visible=articles.find(node=>{const b=node.getBoundingClientRect();return b.bottom>box.top&&b.top<box.bottom;});
      return {busy:container.getAttribute('aria-busy'),count:articles.length,data:window.transcriptData.length,rowsHeight:rows.getBoundingClientRect().height,height:container.clientHeight,
        scrollTop:container.scrollTop,visible:visible?.id,visibleTop:visible?.getBoundingClientRect().top-box.top};
    };

  `);
  const rsbuild = await createRsbuild({ cwd: webRoot, rsbuildConfig: {
    plugins: [pluginReact()], source: { entry: { index: path.join(root, 'entry.tsx') } },
    output: { distPath: { root: path.join(root, 'dist') } },
    html: { templateContent: '<!doctype html><html><body><div id="root"></div></body></html>' },
    server: { host: '127.0.0.1', port: 38419, open: false },
  } });
  await rsbuild.build();
  preview = await rsbuild.preview();
  browser = await chromium.launch({ executablePath: process.env.PONDEROSA_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const origin = `http://127.0.0.1:${preview.port}`;
  const pageErrors = [];
  const openPage = async () => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    // External navigation is intercepted locally: tests do not visit WynnBuilder.
    await context.route('https://wynnbuilder.github.io/**', route => route.fulfill({ body: '<title>Captured destination</title>' }));
    const next = await context.newPage();
    next.on('pageerror', error => pageErrors.push(error.message));
    await next.goto(origin);
    return next;
  };
  let page = await openPage();
  assert.equal(await page.evaluate(() => window.transcriptPreparations), 0);
  for (const kind of ['Copy', 'Download']) {
    await page.getByRole('button', {name: 'Transcript failure test', exact: true}).click();
    await page.getByRole('menuitem', {name: kind, exact: true}).click();
    assert.equal(await page.evaluate(() => window.transcriptPreparations), kind === 'Copy' ? 0 : 1, 'Opening options does not format');
    await page.getByRole('menuitem', {name: 'Chat Transcript', exact: true}).click();
    const failure = page.getByRole('alert').filter({hasText: 'Controlled transcript formatting failed'});
    await failure.waitFor(); await failure.getByRole('button', {name: 'Close', exact: true}).click();
  }
  assert.equal(await page.evaluate(() => window.transcriptPreparations), 2);
  assert.deepEqual(pageErrors, [], 'Formatter errors stay in the existing visible notification owner');
  const longBody = page.getByRole('region', {name: 'Long message wrapper check'});
  const previewBody = longBody.locator(':scope > div > div').first();
  const geometry = () => previewBody.evaluate(e => {const s=getComputedStyle(e);return {height:e.getBoundingClientRect().height,maxHeight:s.maxHeight,overflow:s.overflow,mask:s.maskImage,webkitMask:s.webkitMaskImage};});
  const collapsed = await geometry();
  assert.equal(collapsed.maxHeight, '352px'); assert.equal(collapsed.overflow, 'hidden');
  assert.notEqual(collapsed.mask, 'none'); assert.equal(collapsed.webkitMask, collapsed.mask);
  assert.ok(collapsed.height <= 352);
  assert.ok(!(await longBody.textContent()).includes('END OF LONG SOURCE'));
  await longBody.getByRole('button', {name: 'Show Full Message', exact: true}).click();
  assert.equal(await longBody.getByRole('button', {name: 'Show Less', exact: true}).getAttribute('aria-expanded'), 'true');
  const expanded = await geometry();
  assert.equal(expanded.maxHeight, 'none'); assert.equal(expanded.overflow, 'visible'); assert.equal(expanded.mask, 'none');
  assert.ok(expanded.height > 352); assert.ok((await longBody.textContent()).includes('END OF LONG SOURCE'));
  await longBody.getByRole('button', {name: 'Show Less', exact: true}).click();
  assert.equal(await longBody.getByRole('button', {name: 'Show Full Message', exact: true}).getAttribute('aria-expanded'), 'false');
  assert.deepEqual(await geometry(), collapsed);

  await page.getByRole('button', { name: /^Open agent Build-Coordinator/u }).click();
  assert.equal(await page.evaluate(() => window.openedAgent), agentId);
  const links = page.locator('a[aria-label^="Open link to"]');
  assert.equal(await links.count(), 2);
  assert.equal(await links.nth(0).getAttribute('href'), url);
  assert.equal(await links.nth(1).getAttribute('href'), `${url}&second=2`);
  await links.nth(0).click();
  assert.equal(await page.evaluate(() => window.openedInside), url);
  await links.nth(0).click({ button: 'right' });
  const dialog = page.getByRole('dialog', { name: 'Open link' });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('link', { name: 'Open Externally' }).getAttribute('href'), url);
  await dialog.getByRole('button', { name: 'Open in Ponderosa' }).click();
  assert.equal(await page.evaluate(() => window.openedInside), url);
  await links.nth(1).click({ button: 'right' });
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('link', { name: 'Open Externally' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), `${url}&second=2`);
  assert.equal(await popup.title(), 'Captured destination', 'the popup navigation was fulfilled locally');
  await popup.close();
  await page.getByRole('button', { name: 'Copy whole message' }).click();
  const expectedCopy = visible(text, mentions);
  assert.ok(expectedCopy.includes(payload), 'copy preserves the later literal JSON payload');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedCopy);
  const feedback = page.getByRole('alert').filter({ hasText: /^Copied$/u });
  await feedback.waitFor();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Copy whole message' }).click();
  await page.waitForTimeout(1500);
  assert.equal(await feedback.isVisible(), true, 'a repeated copy receives a fresh shared dismissal timer');
  await feedback.waitFor({ state: 'hidden', timeout: 2200 });
  await page.evaluate(() => window.rerender());
  assert.equal(await feedback.isVisible(), false, 'rerendering does not recreate settled feedback');
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
  await feedback.waitFor();
  await feedback.waitFor({ state: 'hidden', timeout: 4000 });
  // Exercise the existing selection/execCommand clipboard fallback as well.
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('test fallback'); } }));
  await page.getByRole('button', { name: 'Copy whole message' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedCopy);
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.getByRole('button', { name: 'Copy whole message' }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Copy failed; select the message text instead' });
  await error.waitFor();
  await page.waitForTimeout(3300);
  assert.equal(await error.isVisible(), true, 'clipboard failures stay visible beyond the ordinary success timeout');
  await error.getByRole('button', { name: 'Close' }).click();
  await error.waitFor({ state: 'hidden' });

  // Count the real unified parser in the existing mounted browser harness.
  await page.evaluate(()=>window.mountMarkdownMemo());
  const memo = page.getByRole('region',{name:'Memo timeline',exact:true}), collaboration = page.getByRole('region',{name:'Memo collaboration',exact:true});
  await memo.getByRole('button',{name:/^Open agent Build-Coordinator/u}).waitFor();
  await page.waitForFunction(()=>window.markdownMemoStep===0);
  const settleMemo = () => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const parses = () => page.evaluate(()=>window.markdownParses);
  let step=0;
  const patchMemo = async patch => {await page.evaluate(value=>window.patchMarkdownMemo(value),patch);await page.waitForFunction(value=>window.markdownMemoStep===value,++step);await settleMemo();};
  await settleMemo();const initialParses=await parses();assert(initialParses>0);
  await patchMemo({receipt:1});assert.equal(await parses(),initialParses,'Receipt-only message updates must not reparse unchanged prose');
  await patchMemo({health:1});assert.equal(await parses(),initialParses,'Unrelated health updates must not reparse unchanged prose');
  t.diagnostic('Mounted parser calls: initial='+initialParses+', after receipt/health='+await parses());
  await memo.getByRole('button',{name:/^Open agent Build-Coordinator/u}).click();assert.equal((await page.evaluate(()=>window.memoOpened)).id,agentId);
  const previous=await parses();
  await patchMemo({bindings:[{...mentions[0],currentHandle:'Renamed-Builder',currentTitle:'Renamed Builder',available:true}]});
  assert((await parses())>previous,'A meaningful mention rename must re-render Markdown');
  await memo.getByRole('button',{name:/^Open agent Renamed-Builder/u}).waitFor();
  await patchMemo({navigation:1});await memo.getByRole('button',{name:/^Open agent Renamed-Builder/u}).click();
  assert.deepEqual(await page.evaluate(()=>window.memoOpened),{id:agentId,revision:1},'Navigation uses the current callback');
  await patchMemo({bindings:[{...mentions[0],currentHandle:'Renamed-Builder',currentTitle:'Renamed Builder',available:false}]});
  assert.equal(await collaboration.getByRole('button',{name:/^Open agent/u}).count(),0,'Unavailable collaboration bindings must not retain an old clickable target');
  const file = memo.getByRole('link',{name:'working file',exact:true});
  const beforeOwner=await file.getAttribute('href');assert(beforeOwner.includes(agentId));
  await patchMemo({ownerAgent:undefined,ownerChat:'next-chat'});
  const afterOwner=await file.getAttribute('href');assert.notEqual(afterOwner,beforeOwner);assert(afterOwner.includes('next-chat'));
  await patchMemo({ownerAgent:agentId,ownerChat:'fixture-chat',activeRun:'fixture-run'});
  const appLink=memo.getByRole('link',{name:'Open link to 127.0.0.1:3000',exact:true});
  await appLink.click();const appDialog=page.getByRole('dialog',{name:'Open link',exact:true});await appDialog.waitFor();
  assert.equal(await appDialog.getByRole('button',{name:'Open Live App Preview',exact:true}).count(),1);await appDialog.getByRole('button',{name:'Cancel',exact:true}).click();await appDialog.waitFor({state:'hidden'});
  await patchMemo({activeRun:undefined});await appLink.click();await appDialog.waitFor();
  assert.equal(await appDialog.getByRole('button',{name:'Open Live App Preview',exact:true}).count(),0,'A stopped or replaced Run must not retain its old preview grant');
  await appDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(pageErrors,[]);

  // Start the cold transcript phase without earlier dialog, focus, selection or clipboard state.
  await page.context().close();
  page = await openPage();
  // Real shared surface: fetched data stays complete during a finite cold mount.
  await page.evaluate(()=>{window.holdTranscriptTasks=true;window.mountInitialTranscript();});
  await page.evaluate(()=>{const region=document.querySelector('.chat-scroll-region');region.dispatchEvent(new Event('scroll'));window.installTranscript();});
  let initial=await page.evaluate(()=>window.initialTranscriptSnapshot());
  t.diagnostic('Cold transcript measured before background work: '+JSON.stringify(initial));
  assert.equal(initial.data,100);assert(initial.count>0&&initial.count<100,'empty/loading -> first response must actually progress');
  assert.equal(initial.busy,'true');assert(initial.rowsHeight>=initial.height,'actual mounted rows fill the viewport before paint');
  await page.getByRole('region',{name:'Loaded transcript copy'}).getByRole('button',{name:'Copy whole message'}).click();
  const allCopied=await page.evaluate(()=>navigator.clipboard.readText());
  assert.equal(allCopied,await page.evaluate(()=>window.transcriptData.map(item=>item.message.text).join('\n')),'all100 fetched entries remain exactly copyable while rows are pending');
  await page.waitForFunction(()=>window.transcriptTasks.some(task=>!task.signal?.aborted));
  await page.evaluate(()=>document.querySelector('#master-message-row-99 button[aria-expanded]').click());
  await settleMemo();
  assert.equal(await page.locator('#master-message-row-99 button[aria-expanded]').getAttribute('aria-expanded'),'true');
  await page.evaluate(()=>{const region=document.querySelector('.chat-scroll-region');region.scrollTop-=180;});
  await settleMemo();
  const anchor=await page.evaluate(()=>{window.retainedTranscriptNodes=[...document.querySelectorAll('[data-loaded-transcript] article')];return window.initialTranscriptSnapshot();});
  await page.evaluate(()=>window.runTranscriptBatch());
  const afterBatch=await page.evaluate(()=>window.initialTranscriptSnapshot());
  assert.equal(afterBatch.visible,anchor.visible);assert(Math.abs(afterBatch.visibleTop-anchor.visibleTop)<=1,'actual prepend preserves the reading anchor');
  t.diagnostic('Measured prepend anchor: '+JSON.stringify({before:anchor,after:afterBatch}));
  assert.equal(await page.evaluate(()=>window.retainedTranscriptNodes.every(node=>document.getElementById(node.id)===node)),true,'mounted row instances are never replaced');
  assert.equal(await page.locator('#master-message-row-99 button[aria-expanded]').getAttribute('aria-expanded'),'true','expanded body state survives prepends');
  await page.evaluate(()=>{window.holdTranscriptTasks=false;if(window.transcriptTasks.some(task=>!task.signal?.aborted))window.runTranscriptBatch();});
  await page.waitForFunction(()=>window.initialTranscriptSnapshot().busy===null);
  assert.equal((await page.evaluate(()=>window.initialTranscriptSnapshot())).count,100,'all rows finish automatically using the normal scheduler');
  assert.equal(await page.evaluate(()=>window.retainedTranscriptNodes.every(node=>document.getElementById(node.id)===node)),true);
  assert.equal(await page.getByRole('region',{name:'Initial transcript'}).getByRole('article').count(),100);
  assert.equal(await page.evaluate(()=>{getSelection().removeAllRanges();return window.find('Row 000');}),true,'native browser text finding sees completed rows');
  const selected=await page.evaluate(()=>{const region=document.querySelector('.chat-scroll-region'),range=document.createRange();range.selectNodeContents(region);getSelection().removeAllRanges();getSelection().addRange(range);return getSelection().toString();});
  assert(selected.includes('Row 000')&&selected.includes('Row 099'),'post-completion native selection includes the complete loaded transcript');
  await page.evaluate(()=>getSelection().removeAllRanges());

  // Native Find/selection are tested to completion above; restore starts a new navigation.
  await page.reload();
  await page.evaluate(()=>{window.holdTranscriptTasks=true;window.mountInitialTranscript({saved:true,height:620});window.installTranscript();});
  initial=await page.evaluate(()=>window.initialTranscriptSnapshot());
  t.diagnostic('Saved-zero restoration: '+JSON.stringify(await page.evaluate(()=>({snapshot:window.initialTranscriptSnapshot(),calls:window.transcriptPositions,surfaces:[...document.querySelectorAll('.chat-scroll-region')].map(node=>({probe:node.closest('[data-transcript-probe]')?.getAttribute('data-transcript-probe'),height:node.clientHeight,root:node.closest('#root')?.id}))}))));
  assert.equal(await page.locator('[data-transcript-probe]').count(),1,'one current fixture surface remains mounted');
  assert.equal(initial.count,100);assert.equal(initial.busy,null);assert.equal(initial.scrollTop,0,'a genuinely preexisting saved zero is restored exactly');
  await page.evaluate(()=>{
    window.navigationBottomWrites=[];window.navigationGuardSawNearBottom=false;
    const top=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop'),nativeTo=Element.prototype.scrollTo;
    window.restoreFocusInstrumentation=()=>{Object.defineProperty(Element.prototype,'scrollTop',top);Element.prototype.scrollTo=nativeTo;};
    Object.defineProperty(Element.prototype,'scrollTop',{...top,set(value){if(window.navigationCommandActive&&this.matches?.('.chat-scroll-region')&&value>=this.scrollHeight-this.clientHeight)window.navigationBottomWrites.push(value);top.set.call(this,value);}});
    Element.prototype.scrollTo=function(...args){
      if(this.matches?.('.chat-scroll-region')&&args[0]?.behavior==='smooth'){
        window.navigationCommandActive=true;
        const response=nativeTo.apply(this,args);
        // Reproduce the observed queued old-bottom delivery before resize.
        window.navigationGuardSawNearBottom=this.scrollHeight-this.clientHeight-this.scrollTop<=48;
        this.dispatchEvent(new Event('scroll'));
        return response;
      }
      return nativeTo.apply(this,args);
    };
    window.mountInitialTranscript({reveal:true,height:620});window.installTranscript();
  });
  initial=await page.evaluate(()=>window.initialTranscriptSnapshot());assert.equal(initial.count,100);assert.equal(initial.busy,null,'focused routes bypass partial DOM');
  assert.equal(await page.locator('[data-transcript-probe]').count(),1,'one live surface remains after changing focused scope');
  await page.locator('#master-message-row-0[data-notification-focus="true"]').waitFor();
  await page.waitForFunction(()=>{const node=document.getElementById('master-message-row-0'),root=node.closest('.chat-scroll-region'),a=node.getBoundingClientRect(),b=root.getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom;});
  assert.equal(await page.locator('#master-message-row-0').getAttribute('data-notification-focus'),'true','existing focus helper reaches and highlights the early loaded row');
  assert.equal(await page.evaluate(()=>window.navigationGuardSawNearBottom),true,'the known queued old-bottom event is actually exercised');
  assert.deepEqual(await page.evaluate(()=>window.navigationBottomWrites),[],'resize delivery must not overwrite explicit away-navigation with bottom');
  await page.evaluate(()=>{window.navigationCommandActive=false;window.restoreFocusInstrumentation();});

  await page.getByRole('button',{name:'Jump to latest message',exact:true}).click();
  await page.waitForFunction(()=>{const root=document.querySelector('.chat-scroll-region');return root.scrollHeight-root.clientHeight-root.scrollTop<=48;});
  await page.locator('#master-message-row-99 button[aria-expanded]').click();
  await settleMemo();
  assert.equal(await page.locator('#master-message-row-99 button[aria-expanded]').getAttribute('aria-expanded'),'true');
  await page.waitForFunction(()=>{const root=document.querySelector('.chat-scroll-region');return root.scrollHeight-root.clientHeight-root.scrollTop<=48;});


  await page.evaluate(()=>{window.mountInitialTranscript({height:620});window.installTranscript();});
  await page.waitForFunction(()=>window.transcriptTasks.some(task=>!task.signal?.aborted));
  await page.evaluate(()=>{document.querySelector('.chat-scroll-region').scrollTop-=120;});
  await settleMemo();const beforeMutation=await page.evaluate(()=>window.initialTranscriptSnapshot());
  await page.evaluate(()=>window.mutateTranscript());
  const afterMutation=await page.evaluate(()=>window.initialTranscriptSnapshot());
  assert.equal(afterMutation.count,101);assert.equal(afterMutation.busy,null);
  assert.equal(afterMutation.visible,beforeMutation.visible);assert(Math.abs(afterMutation.visibleTop-beforeMutation.visibleTop)<=1,'ID mutation full reveal preserves the existing real-height anchor');

  await page.evaluate(()=>{window.mountInitialTranscript({height:620});window.installTranscript();});
  assert.equal((await page.evaluate(()=>window.initialTranscriptSnapshot())).busy,'true');
  await page.getByRole('textbox',{name:'Outside transcript editor'}).focus();
  await page.keyboard.press('Control+a');
  assert.equal((await page.evaluate(()=>window.initialTranscriptSnapshot())).busy,'true','editable Select All does not force unrelated transcript work');
  assert.deepEqual(await page.getByRole('textbox',{name:'Outside transcript editor'}).evaluate(node=>[node.selectionStart,node.selectionEnd]),[0,'Retained editor draft'.length]);
  await page.keyboard.press('Control+f');
  initial=await page.evaluate(()=>window.initialTranscriptSnapshot());assert.equal(initial.count,100);assert.equal(initial.busy,null,'keyboard find reveals pending rows before browser default handling');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{window.mountInitialTranscript({height:620});window.installTranscript();});
  await page.getByRole('button',{name:/Earlier|older/i}).click();
  assert.equal(await page.evaluate(()=>window.historySawComplete),100,'earlier-history action sees all pending fetched rows first');

  await page.setViewportSize({width:412,height:823});
  const phoneInitial=await page.evaluate(()=>{window.holdTranscriptTasks=false;window.mountInitialTranscript({height:620});window.installTranscript();return window.initialTranscriptSnapshot();});
  assert.equal(phoneInitial.data,100);assert.equal(phoneInitial.busy,'true');assert(phoneInitial.count>0&&phoneInitial.count<100);
  assert(phoneInitial.rowsHeight>=phoneInitial.height&&phoneInitial.height<=823,'phone first viewport is filled with measured rows');
  assert.equal(await page.locator('#master-message-row-99').evaluate(node=>{const root=node.closest('.chat-scroll-region'),a=node.getBoundingClientRect(),b=root.getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom;}),true);
  await page.waitForFunction(()=>window.initialTranscriptSnapshot().busy===null);
  assert.deepEqual(await page.locator('[data-loaded-transcript] article').evaluateAll(nodes=>nodes.map(node=>node.id)),Array.from({length:100},(_,i)=>'master-message-row-'+i),'phone completion retains the full accessible DOM in original order');
  t.diagnostic('Phone412x823 initial measured suffix: '+JSON.stringify(phoneInitial));
  assert.deepEqual(pageErrors,[]);

});


test('Inbox keeps provider command output visible and uses shared feedback only for an acknowledgment', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  const source = await readFile(new URL('../../apps/web/src/components/InboxView.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let command;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'invokeCommand') command = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(command, 'the command callback exists');
  const output = [], notices = [], requests = [];
  let result = { message: 'Model: GPT-6.1\nContext: 20%\nUsage resets at 8 PM' };
  const scope = { providerCommandResultText, selectedAgentId: 'agent-1', setCommandResult: value => output.push(value), notify: value => notices.push(value),
    api: { invokeProviderCommand: async (...args) => { requests.push(args); return result; } } };
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(`globalThis.command = (${command.slice(command.indexOf('=') + 1)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, scope);
  await scope.command({ name: 'status' });
  assert.equal(output.at(-1), result.message, 'provider output remains owned by the durable inline result');
  assert.equal(notices.length, 0, 'status details are not expired as a success acknowledgment');
  result = {};
  await scope.command({ name: 'compact' });
  assert.equal(output.at(-1), undefined);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, '/compact Completed');
  assert.equal(notices[0].persistent, undefined, 'ordinary completion uses the shared default timeout');
  assert.deepEqual(requests.map(([agentId, input]) => [agentId, { ...input }]), [
    ['agent-1', { name: 'status' }], ['agent-1', { name: 'compact' }],
  ]);
  scope.api.invokeProviderCommand = async () => { throw new Error('Provider unavailable'); };
  await assert.rejects(scope.command({ name: 'compact' }), /Provider unavailable/);
  assert.equal(notices.length, 1, 'failures propagate to the existing command error owner');
  for (const outcome of ['failed', 'outcome_unknown']) {
    scope.api.invokeProviderCommand = async () => ({ outcome, message: 'Native completion is unconfirmed. Do not repeat.', goal: fullNativeGoal });
    await assert.rejects(scope.command({ name: 'compact' }), /unconfirmed.*Do not repeat/);
    assert.equal(notices.length, 1, 'Uncertain native work cannot become timed success feedback');
  }
  scope.api.invokeProviderCommand = async () => ({message:'truncated preview…',goal:fullNativeGoal});
  await scope.command({name:'goal'});
  assert.equal(output.at(-1), providerCommandResultText({goal:fullNativeGoal}));
  assert.ok(output.at(-1).startsWith(fullNativeGoal.objective+'\n'),'Inbox exposes the exact full native objective');
});

// Exercise the real remaining copy owners with a controlled clipboard/notifier.
// Their shared provider's timer and durable-error behavior is covered above.
test('Agent header transcript and import conversion prompt copy preserve bytes without changing message notices', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  for (const [file, variable] of [['AgentDetail.header.tsx', undefined], ['ImportAgentDialog.tsx', 'copyExternalPrompt']]) {
    const source = await readFile(new URL(`../../apps/web/src/components/${file}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback;
    const visit = node => {
      if (variable && ts.isVariableDeclaration(node) && node.name.getText(ast) === variable) callback = node.initializer.getText(ast);
      if (!variable && ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onSelect' && node.initializer.getText(ast).includes('copyText(transcriptMarkdown)')) callback = node.initializer.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(callback, `${file} retains its existing copy action`);
    const exact = '# Canonical transcript\n\n#Agent `literal` café 🌲\n\n{"text":"do not rewrite"}\n';
    const copied = [], notices = [];
    const scope = { transcriptMarkdown: exact, externalAgentImportPrompt: () => exact, Error,
      copyText: async text => { copied.push(text); }, notify: notice => notices.push(notice) };
    const copy = vm.runInNewContext(ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 }), scope);
    await copy();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(copied, [exact], file);
    assert.equal(notices.length, 1); assert.equal(notices[0].message, 'Copied');
    assert.equal(notices[0].persistent, undefined, 'success inherits the shared three-second timeout');
    scope.copyText = async () => { throw new Error('Clipboard denied'); };
    await copy();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notices.length, 2); assert.equal(notices[1].severity, 'error', 'failure uses the shared durable error path');
  }
});

test('Agent package copy retains deferred clipboard transfer and downloads have one shared acknowledgment', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  const source = await readFile(new URL('../../apps/web/src/components/useAgentPackageActions.ts', import.meta.url), 'utf8');
  const module = { exports: {} }, notices = [], requests = [], copied = [], links = [];
  const exact = '{"agent":"Original","content":"café 🌲\\nunchanged"}';
  let exportText = Promise.withResolvers();
  const anchor = { dataset: {}, style: {}, click() { links.push({ href: this.href, download: this.download, feedback: this.dataset.ponderosaDownloadFeedback }); }, remove() {} };
  const imports = { '../agent-package-clipboard':{AgentPackageDownloadRequired:class extends Error{}},'../api': { api: {
    exportAgentText: (...args) => { requests.push(args); return exportText.promise; },
    downloadAgentPackage: async (...args) => { requests.push(args); links.push({download:args[1]}); return {downloadUrl:'/api/package-exports/'+ 'a'.repeat(48)}; },
  } }, '../clipboard': { copyDeferredText: async pending => { assert.equal(pending, exportText.promise, 'Safari deferred clipboard receives the original export Promise'); copied.push(await pending); } },
    './MutationNotifications': { useMutationNotification: () => notice => notices.push(notice) },
    './AgentDetail.helpers': { portablePackageFileName: (title, organization, mode) => `${title}-${organization}-${mode}.json` } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Error, document: { createElement: () => anchor, body: { appendChild() {} } }, require: name => imports[name] });
  const actions = module.exports.useAgentPackageActions({ agentId: 'agent-a', title: 'Original' });
  const copying = actions.copyAgentPackage('full', true);
  assert.equal(notices.length, 0, 'an unconfirmed export is not acknowledged');
  exportText.resolve(exact); await copying;
  assert.deepEqual(copied, [exact]); assert.equal(notices[0].message, 'Copied'); assert.equal(notices[0].persistent, undefined);
  exportText = Promise.withResolvers(); const failure = actions.copyAgentPackage('template'); exportText.reject(Error('Export failed')); await failure;
  assert.equal(notices[1].severity, 'error'); assert.match(notices[1].message, /Export failed/);
  await actions.downloadAgentPackage('full', true);
  assert.deepEqual(links, [{ download: 'Original-true-full.json' }]);
  assert.equal(notices[2].message, 'Download started'); assert.equal(notices[2].persistent, undefined);
  assert.deepEqual(requests.map(args => args.map(value => Array.isArray(value) ? Array.from(value) : value)), [['agent-a', 'full', true, [], false, false, undefined, undefined], ['agent-a', 'template', false, [], false, false, undefined, undefined], ['agent-a', 'Original-true-full.json', 'full', true, [], false, false, undefined, undefined]]);
});

test('Agent provider commands keep meaningful output and errors in their existing owner', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  const source = await readFile(new URL('../../apps/web/src/components/useAgentProviderCommands.ts', import.meta.url), 'utf8');
  const module = { exports: {} }, output = [], notices = [], requests = [];
  let result = { message: 'Model: GPT-6.1\nUsage: 25%\nReset: tomorrow' };
  const api = { invokeProviderCommand: async (...args) => { requests.push(args); return result; } };
  const imports = { react: { useState: () => [undefined, () => {}] }, '@tanstack/react-query': { useQueryClient: () => ({}) },
    '../api': { api }, '../providerUsageQuery': {}, '../queryKeys': {}, '../providerCommandResult': { providerCommandResultText },
    './MutationNotifications': { useMutationNotification: () => notice => notices.push(notice) } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: name => imports[name] });
  const commands = module.exports.useAgentProviderCommands({ agentId: 'agent-a', engine: {}, onNotice: value => output.push(value) });
  await commands.invokeAgentCommand({ name: 'status' }, '');
  assert.equal(output.at(-1), result.message); assert.equal(notices.length, 0, 'status output remains visible rather than timed feedback');
  result = {}; await commands.invokeAgentCommand({ name: 'compact' }, '');
  assert.equal(output.length, 1, 'completion does not overwrite an existing meaningful result');
  assert.equal(notices[0].message, '/compact Invoked'); assert.equal(notices[0].persistent, undefined);
  api.invokeProviderCommand = async () => { throw Error('Provider command failed'); };
  await assert.rejects(commands.invokeAgentCommand({ name: 'compact' }, ''), /Provider command failed/);
  assert.equal(notices.length, 1, 'failures propagate to the existing command error owner');
  assert.deepEqual(requests.map(([agentId, input]) => [agentId, { ...input }]), [['agent-a', { name: 'status' }], ['agent-a', { name: 'compact' }]]);
  for (const outcome of ['failed', 'outcome_unknown']) {
    api.invokeProviderCommand = async () => ({ outcome, message: 'Native completion is unconfirmed. Do not repeat.', goal: fullNativeGoal });
    await assert.rejects(commands.invokeAgentCommand({ name: 'compact' }, ''), /unconfirmed.*Do not repeat/);
    assert.equal(notices.length, 1); assert.equal(output.length, 1);
  }
  api.invokeProviderCommand = async () => ({message:'truncated preview…',goal:fullNativeGoal});
  await commands.invokeAgentCommand({name:'goal'},'');
  assert.equal(output.at(-1),providerCommandResultText({goal:fullNativeGoal}));
  assert.ok(output.at(-1).startsWith(fullNativeGoal.objective+'\n'),'Agent detail exposes the exact full native objective');
});

test('Chat provider command acknowledgment does not overwrite retained provider output', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  const source = await readFile(new URL('../../apps/web/src/components/ConversationView.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('chat.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onCommand') callback = node.initializer.expression.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback);
  const output = [], notices = [], requests = [];
  let result = { message: 'Provider status: usage resets tomorrow' };
  const api = { invokeProviderCommand: async (...args) => { requests.push(args); return result; } };
  const scope = { api, providerCommandResultText, commandTargetAgent: { id: 'agent-a', title: 'Original' },
    setQueuedMessageNotice: value => output.push(value), notify: notice => notices.push(notice) };
  const command = vm.runInNewContext(ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 }), scope);
  await command({ name: 'status' }, ''); assert.equal(output[0], result.message); assert.equal(notices.length, 0);
  result = {}; await command({ name: 'compact' }, ''); assert.equal(output.length, 1);
  assert.equal(notices[0].message, '/compact Invoked'); assert.equal(notices[0].persistent, undefined);
  api.invokeProviderCommand = async () => { throw Error('Provider unavailable'); };
  await assert.rejects(command({ name: 'compact' }, ''), /Provider unavailable/);
  assert.equal(notices.length, 1); assert.deepEqual(requests.map(([id, input]) => [id, { ...input }]), [['agent-a', { name: 'status' }], ['agent-a', { name: 'compact' }]]);
  for (const outcome of ['failed', 'outcome_unknown']) {
    api.invokeProviderCommand = async () => ({ outcome, message: 'Native completion is unconfirmed. Do not repeat.', goal: fullNativeGoal });
    await assert.rejects(command({ name: 'compact' }, ''), /unconfirmed.*Do not repeat/);
    assert.equal(notices.length, 1); assert.equal(output.length, 1);
  }
  api.invokeProviderCommand = async () => ({message:'truncated preview…',goal:fullNativeGoal});
  await command({name:'goal'},'');
  assert.equal(output.at(-1),providerCommandResultText({goal:fullNativeGoal}));
  assert.ok(output.at(-1).startsWith(fullNativeGoal.objective+'\n'),'Chat exposes the exact full native objective');
});

test('a long native goal survives adapter, server projection and web result formatting', async () => {
  const {invokeCodexGoal} = await import('../../packages/engines/dist/codex-native-actions.js');
  const {projectProviderCommandResult} = await import('../../apps/server/dist/provider-success-projection.js');
  const objective = 'Original goal\n' + 'x'.repeat(30_000) + '\nFinal goal line';
  const goal = {...fullNativeGoal, objective};
  let calls = 0;
  const result = await invokeCodexGoal({async request(method, params) {
    calls++;assert.equal(method,'thread/goal/get');assert.equal(params.threadId,goal.threadId);return {goal};
  }}, goal.threadId, 'goal');
  assert.equal(calls,1);assert.ok(result.message.length < objective.length,'adapter preview is bounded');
  const projected = projectProviderCommandResult(result);
  assert.equal(projected.goal.objective,objective,'authorized structured response retains the complete goal');
  const visible = providerCommandResultText(projected);
  assert.ok(visible.startsWith(objective+'\n'),'web presents the full exact objective once');
  assert.equal(visible.split('Final goal line').length-1,1);
});

test('all native command result owners use a focusable bounded line-preserving view', async () => {
  const {readFile} = await import('node:fs/promises');
  const ts = await import('typescript');
  const {providerCommandResultSx} = await import('../../apps/web/src/providerCommandResult.ts');
  for (const [file, child] of [['InboxView.tsx','commandResult'],['ConversationView.tsx','queuedMessageNotice'],['AgentDetail.composer.tsx','queuedMessageNotice']]) {
    const source = await readFile(new URL(`../../apps/web/src/components/${file}`,import.meta.url),'utf8');
    const ast = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    let found;
    const visit=node=>{
      if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='Alert' &&
        node.children.some(item=>ts.isJsxExpression(item)&&item.expression?.getText(ast)===child)) found=node.openingElement;
      ts.forEachChild(node,visit);
    };
    visit(ast);assert.ok(found,`${file} owns its command result`);
    const attrs=found.attributes.properties;
    assert.ok(attrs.some(item=>ts.isJsxAttribute(item)&&item.name.getText(ast)==='tabIndex'&&item.initializer?.getText(ast)==='{0}'),`${file} is keyboard focusable`);
    assert.ok(attrs.some(item=>ts.isJsxAttribute(item)&&item.name.getText(ast)==='sx'&&item.initializer?.getText(ast)==='{providerCommandResultSx}'),`${file} uses shared result presentation`);
  }
  assert.equal(providerCommandResultSx.overflow,'auto');
  assert.equal(providerCommandResultSx.maxHeight,'min(40vh, 320px)');
  assert.equal(providerCommandResultSx['& .MuiAlert-message'].whiteSpace,'pre-wrap');
  assert.equal(providerCommandResultSx['& .MuiAlert-message'].overflowWrap,'anywhere');
});
