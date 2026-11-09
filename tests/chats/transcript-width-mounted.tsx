// Real surface, rows and composer; synthetic history and presentation-only send.
import { Box, CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationChromeContext } from '../../apps/web/src/components/ConversationChromeContext';
import { MutationNotificationProvider } from '../../apps/web/src/components/MutationNotifications';
import { ChatSurface, type ChatSurfaceLayout } from '../../apps/web/src/components/chat/ChatSurface';
import { ChatMessageFrame } from '../../apps/web/src/components/chat/ChatMessageFrame';
import { ChatMessageBody } from '../../apps/web/src/components/chat/ChatMessages';
import { Composer } from '../../apps/web/src/components/chat/Composer';
import { OutgoingMessageProvider, useOutgoingMessage } from '../../apps/web/src/components/chat/OutgoingMessage';
import { createPonderosaTheme } from '../../apps/web/src/theme';
import '../../apps/web/src/global.css';

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

export async function transcriptWidthMountedRegression(): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const desktop = matchMedia('(min-width: 900px)').matches;
  let begin: (() => void) | undefined;
  function PendingControl() {
    const outgoing = useOutgoingMessage()!;
    begin = () => outgoing.begin('New short message', ['contained.txt']);
    return null;
  }
  const evidence: unknown[] = [];
  const render = (layout: ChatSurfaceLayout, assistant: boolean, sidebar: number, narrow: boolean, refresh = false) => {
    flushSync(() => root.render(
      <ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline />
        <QueryClientProvider client={client}><MutationNotificationProvider>
          <ConversationChromeContext.Provider value={assistant ? { statusHost: null, callActionsHost: null } : undefined}>
            <Box sx={{ width: narrow ? 'min(620px, 100%)' : `calc(100% - ${sidebar}px)`, ml: `${sidebar}px`, height: 820, display: 'grid', gridTemplateRows: 'minmax(0, 1fr) auto', minWidth: 0 }}>
              <OutgoingMessageProvider key={`${layout}:${assistant}:${sidebar}:${narrow}:${refresh}`}>
                <PendingControl />
                <ChatSurface layout={layout} layoutKey="width-fixture" showOutgoingMessage initialTranscript={{ rowIds: ['incoming', 'short', 'long'], reveal: true }}>
                  <ChatMessageFrame message={{ id: 'incoming', author: { kind: 'agent', name: 'Agent' }, createdAt: '2026-11-09T00:00:00Z', body: <ChatMessageBody text="Incoming reply" />, attachments: [{ id: 'attachment', agentId: 'agent', name: 'contained.txt', mediaType: 'text/plain', size: 12, url: '#attachment' }] }} />
                  <ChatMessageFrame message={{ id: 'short', author: { kind: 'operator' }, createdAt: '2026-11-09T00:00:00Z', body: <ChatMessageBody text={refresh ? 'Refreshed short message' : 'Short message'} /> }} />
                  <ChatMessageFrame message={{ id: 'long', author: { kind: 'operator' }, createdAt: '2026-11-09T00:00:00Z', body: <ChatMessageBody text={'Long prose stays contained. '.repeat(40) + '\n\n```ts\n' + 'long_code_'.repeat(160) + '\n```'} /> }} />
                </ChatSurface>
                <Composer disabled={false} running={false} onSend={() => { throw Error('Geometry check must not send'); }} />
              </OutgoingMessageProvider>
            </Box>
          </ConversationChromeContext.Provider>
        </MutationNotificationProvider></QueryClientProvider>
      </ThemeProvider>,
    ));
  };
  const measure = async (label: string, regular: boolean) => {
    const scroll = host.querySelector<HTMLElement>('.chat-scroll-region')!;
    const composer = host.querySelector<HTMLElement>('[data-composer-toolbar]')!.closest('[data-file-drag-active]')!;
    assert(composer, 'Real composer surface exists');
    const box = composer.getBoundingClientRect();
    const gutter = scroll.offsetWidth - scroll.clientWidth;
    const rows = [...host.querySelectorAll<HTMLElement>('.chat-message-frame')];
    const bounds = rows.map(row => {
      const rect = row.getBoundingClientRect();
      const body = row.querySelector<HTMLElement>('.chat-message-body')!.getBoundingClientRect();
      if (regular && desktop) {
        assert(Math.abs(rect.left - box.left) <= gutter + 1, `${label}/${row.id}: left edge ${rect.left} vs ${box.left}`);
        assert(Math.abs(rect.right - box.right) <= gutter + 1, `${label}/${row.id}: right edge ${rect.right} vs ${box.right}`);
      } else assert(rect.width <= 881, `${label}: retained 880px cap`);
      assert(body.left >= rect.left - 1 && body.right <= rect.right + 1, `${label}/${row.id}: contained body`);
      return { id: row.id, left: rect.left, right: rect.right, width: rect.width, bodyWidth: body.width };
    });
    const short = bounds.find(row => row.id === 'short')!;
    assert(short.bodyWidth < short.width * .8, `${label}: short bubble stays content-sized`);
    assert(scroll.scrollWidth <= scroll.clientWidth + 1, `${label}: no horizontal transcript overflow`);
    const avatar = host.querySelector('#incoming .MuiAvatar-root')!.getBoundingClientRect();
    assert(Math.abs(avatar.left - bounds[0].left) <= 1, `${label}: incoming avatar stays at lane edge`);
    const outgoing = host.querySelector('#short .chat-message-body')!.getBoundingClientRect();
    assert(Math.abs(outgoing.right - bounds[1].right) <= 1, `${label}: outgoing bubble stays at lane edge`);
    evidence.push({ label, viewport: innerWidth, composer: { left: box.left, right: box.right }, gutter, rows: bounds });
    await (window as unknown as { transcriptWidthCheckpoint?: (label: string) => Promise<void> }).transcriptWidthCheckpoint?.(label);
  };
  try {
    for (const [sidebar, narrow] of desktop ? [[0, false], [280, false], [0, true]] as const : [[0, false]] as const) {
      render('project', false, sidebar, narrow);
      await settle();
      await measure(`regular/${sidebar}/${narrow}/history`, true);
      flushSync(() => begin!());
      await settle();
      assert(host.querySelector('[aria-label="Sending message"]'), 'New outgoing presentation rendered');
      await measure(`regular/${sidebar}/${narrow}/new`, true);
      render('project', false, sidebar, narrow, true);
      await settle();
      await measure(`regular/${sidebar}/${narrow}/refreshed`, true);
    }
    for (const [layout, assistant] of [['project', true], ['agent', false], ['workspace', false]] as const) {
      render(layout, assistant, 0, false);
      await settle();
      await measure(`${layout}/assistant=${assistant}`, false);
    }
    (window as unknown as { transcriptWidthEvidence: unknown[] }).transcriptWidthEvidence = evidence;
  } finally {
    root.unmount(); client.clear(); host.remove();
  }
}
