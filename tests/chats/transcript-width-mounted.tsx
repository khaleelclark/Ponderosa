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
import { createPonderosaTheme, ponderosaSurfaceVariables } from '../../apps/web/src/theme';
import '../../apps/web/src/global.css';

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const wideReply = '## Grand Teton\n\n' + 'Grand Teton offers mountain views, lakes and trails. '.repeat(40) + '\n\n| Trail | Distance | Elevation | Time | Notes | Access | Conditions |\n| --- | --- | --- | --- | --- | --- | --- |\n| Cascade Canyon | Nine miles | Moderate gain | Half day | Lake and mountain views | Jenny Lake | Check current conditions |\n\n```ts\n' + 'grand_teton_'.repeat(160) + '\n```';

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
                <ChatSurface layout={layout} layoutKey="width-fixture" showOutgoingMessage initialTranscript={{ rowIds: ['incoming', 'short', 'long', 'incoming-short'], reveal: true }}>
                  <ChatMessageFrame message={{ id: 'incoming', author: { kind: 'agent', name: 'Agent' }, createdAt: '2026-11-09T00:00:00Z', body: <ChatMessageBody text={wideReply} />, attachments: [{ id: 'attachment', agentId: 'agent', name: 'contained.txt', mediaType: 'text/plain', size: 12, url: '#attachment' }] }} />
                  <ChatMessageFrame message={{ id: 'short', author: { kind: 'operator' }, createdAt: '2026-11-09T00:00:00Z', body: <ChatMessageBody text={refresh ? 'Refreshed short message' : 'Short message'} /> }} />
                  <ChatMessageFrame message={{ id: 'long', author: { kind: 'operator' }, createdAt: '2026-11-09T00:00:00Z', body: <ChatMessageBody text={'Long prose stays contained. '.repeat(40) + '\n\n```ts\n' + 'long_code_'.repeat(160) + '\n```'} /> }} />
                  <ChatMessageFrame message={{ id: 'incoming-short', author: { kind: 'agent', name: 'Agent' }, createdAt: '2026-11-09T00:00:00Z', body: <ChatMessageBody text="Short reply" /> }} />
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
    const incoming = host.querySelector('#incoming .chat-message-body')!.getBoundingClientRect();
    assert(Math.abs(incoming.right - bounds[0].right) <= 1, `${label}: long reply uses the lane after the avatar and gap`);
    assert(host.querySelector('#incoming-short .chat-message-body')!.getBoundingClientRect().width < bounds[0].width * .8, `${label}: short incoming reply stays content-sized`);
    const outgoing = host.querySelector('#short .chat-message-body')!.getBoundingClientRect();
    assert(Math.abs(outgoing.right - bounds[1].right) <= 1, `${label}: outgoing bubble stays at lane edge`);
    evidence.push({ label, viewport: innerWidth, composer: { left: box.left, right: box.right }, gutter, rows: bounds });
    await (window as unknown as { transcriptWidthCheckpoint?: (label: string) => Promise<void> }).transcriptWidthCheckpoint?.(label);
  };
  try {
    for (const [sidebar, narrow] of desktop ? [[0, false], [280, false], [0, true]] as const : [[0, false]] as const) {
      render('agent', false, sidebar, narrow);
      await settle();
      await measure(`regular/${sidebar}/${narrow}/history`, true);
      flushSync(() => begin!());
      await settle();
      assert(host.querySelector('[aria-label="Sending Message"]'), 'New outgoing presentation rendered');
      await measure(`regular/${sidebar}/${narrow}/new`, true);
      render('agent', false, sidebar, narrow, true);
      await settle();
      await measure(`regular/${sidebar}/${narrow}/refreshed`, true);
    }
    for (const [layout, assistant] of [['project', true], ['agent', true], ['agent', false], ['workspace', false]] as const) {
      render(layout, assistant, 0, false);
      await settle();
      await measure(`${layout}/assistant=${assistant}`, assistant || layout === 'agent');
    }
    (window as unknown as { transcriptWidthEvidence: unknown[] }).transcriptWidthEvidence = evidence;
  } finally {
    root.unmount(); client.clear(); host.remove();
  }
}

/** Actual rendered parity, including the scoped CSS which theme-only checks miss. */
export async function outputComposerStyleMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const binding = { projectId: 'style-project', agentId: 'style-assistant', handle: 'Assistant', currentHandle: 'Assistant', currentTitle: 'Assistant' };
  const evidence: unknown[] = [];
  const properties = ['backgroundColor', 'color', 'borderColor', 'borderWidth', 'borderRadius', 'boxShadow', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontSize', 'lineHeight'] as const;
  const style = (element: Element) => { const computed = getComputedStyle(element); return Object.fromEntries(properties.map(name => [name, computed[name]])); };
  // Animated ancestors can introduce native DOMRect noise below 1/100px.
  const pixels = (value: number) => Math.round(value * 100) / 100;
  let finish: (() => void) | undefined;
  try {
    for (const mode of ['light', 'dark'] as const) for (const state of ['empty', 'focused', 'typed', 'disabled', 'attachment', 'sending'] as const) {
      let standard: unknown;
      for (const output of [false, true]) {
        const label = `${mode}/${state}/output=${output}`;
        let sent = false;
        flushSync(() => root.render(
          <ThemeProvider theme={createPonderosaTheme(mode, output ? 'assistant' : 'standard')}><CssBaseline />
            <QueryClientProvider client={client}><MutationNotificationProvider>
              <ConversationChromeContext.Provider value={output ? { statusHost: null, callActionsHost: null } : undefined}>
                <Box data-assistant-conversation={output ? '' : undefined} sx={{ ...(output ? ponderosaSurfaceVariables(mode) : {}), width: 'min(1200px, 100%)', minWidth: 0 }}>
                  <ChatMessageFrame message={{ id: 'style-bubble', author: { kind: 'operator' }, createdAt: '2026-11-09T00:00:00Z', body: <ChatMessageBody text="A short reply with [a link](https://example.invalid) and `code`." /> }} />
                  <Composer key={label} disabled={state === 'disabled'} running={false}
                    destinationMode="fixed" defaultDestination={{ handle: binding.handle, binding, selectionKey: binding.agentId }}
                    placeholder={output ? 'Message Assistant directly' : undefined}
                    insertTextRequest={['typed', 'sending'].includes(state) ? { id: label, text: 'A controlled message' } : undefined}
                    onSend={() => { sent = true; return new Promise<void>(resolve => { finish = resolve; }); }} />
                </Box>
              </ConversationChromeContext.Provider>
            </MutationNotificationProvider></QueryClientProvider>
          </ThemeProvider>,
        ));
        await settle();
        const composer = host.querySelector<HTMLElement>('.ponderosa-composer')!;
        const editor = composer.querySelector<HTMLElement>('[aria-label="Message"]')!;
        assert(editor, `${label}: accessible Message editor`);
        assert(!composer.querySelector('[data-composer-mention="true"]'), `${label}: fixed recipient has no destination chip`);
        assert(!/Message Assistant directly|Reply To|New Agent/.test(composer.textContent ?? ''), `${label}: no direct-conversation hint or recipient switching`);
        if (output && state === 'empty') assert(!composer.textContent?.includes('Send a message'), `${label}: explicit empty placeholder`);
        if (state === 'focused') { editor.focus(); await settle(); }
        if (state === 'attachment') {
          const files = new DataTransfer(); files.items.add(new File(['contained attachment'], 'style.txt', { type: 'text/plain' }));
          const input = composer.querySelector<HTMLInputElement>('[aria-label="Choose Files"]')!;
          input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); await settle();
          assert(composer.textContent?.includes('style.txt'), `${label}: attachment is retained`);
        }
        if (state === 'sending') {
          const send = composer.querySelector<HTMLButtonElement>('[aria-label="Send Message"]')!;
          assert(send && !send.disabled, `${label}: typed fixed-recipient message can send`); send.click(); await settle();
          assert(sent, `${label}: send handler invoked`);
        }
        const bubble = host.querySelector('#style-bubble .chat-message-body')!;
        const snapshot = {
          surface: { ...style(composer), width: pixels(composer.getBoundingClientRect().width) },
          editor: style(editor), bubble: style(bubble), link: style(bubble.querySelector('a')!), code: style(bubble.querySelector('code')!),
          controls: [...composer.querySelectorAll<HTMLButtonElement>('button')].map(button => ({ label: button.getAttribute('aria-label'), disabled: button.disabled, ...style(button), width: pixels(button.getBoundingClientRect().width), height: pixels(button.getBoundingClientRect().height) })),
        };
        if (!output) standard = snapshot;
        else assert(JSON.stringify(snapshot) === JSON.stringify(standard), `${label}: standard rendered surface, editor, controls and outgoing prose match ${JSON.stringify({ standard, actual: snapshot })}`);
        evidence.push({ label, ...snapshot });
        await (window as unknown as { outputStyleCheckpoint?: (label: string) => Promise<void> }).outputStyleCheckpoint?.(label);
        if (finish) { finish(); finish = undefined; await settle(); }
      }
    }
    (window as unknown as { outputStyleEvidence: unknown[] }).outputStyleEvidence = evidence;
  } finally { finish?.(); root.unmount(); client.clear(); host.remove(); }
}
