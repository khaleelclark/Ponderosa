import { useState, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { ComposerEditor, type ComposerEditorHandle } from '../../apps/web/src/components/chat/ComposerEditor';
import { Composer } from '../../apps/web/src/components/chat/Composer';
import { MutationNotificationProvider } from '../../apps/web/src/components/MutationNotifications';
import { QueuedMessageTray } from '../../apps/web/src/components/chat/QueuedMessageTray';
import { createPonderosaTheme } from '../../apps/web/src/theme';
import { isIOSDevice } from '../../apps/web/src/browserPlatform';
import type { QueuedConversationMessageDto } from '@ponderosa/core';

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(read: () => boolean, message: string) { const end = performance.now() + 5000; while (performance.now() < end) { if (read()) return; await settle(); } throw Error(message); }
const mobile = isIOSDevice() || /Android/i.test(navigator.userAgent);
async function key(editor: HTMLElement, ctrl: boolean, options: KeyboardEventInit = {}) {
  const native = (window as Window & { composerQueueNativeKey?: (key: string) => Promise<void> }).composerQueueNativeKey;
  if (native && !Object.keys(options).length) await native(ctrl ? 'Control+Enter' : 'Enter');
  else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: ctrl, keyCode: 13, bubbles: true, cancelable: true, ...options }));
  await settle();
}

export async function composerQueueEditorMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), ref = createRef<ComposerEditorHandle>();
  let queues = 0, sends = 0, selections = 0, epoch = 0;
  function Probe({ disabled = false, locked = false, available = true, eligible = true, menu = false }: { disabled?: boolean; locked?: boolean; available?: boolean; eligible?: boolean; menu?: boolean }) {
    const [text, setText] = useState('Keep this exact draft λ😀');
    return <ComposerEditor ref={ref} text={text} disabled={disabled} locked={locked} comboboxEnabled menuOpen={menu} listId="queue-suggestions" highlighted={0} attachmentsEnabled={false}
      menuSuggestions={[{ kind: 'mention', handle: 'Suggested' }]} mentionDescriptors={[]} mentionBindings={[]} canSend={!disabled && !locked && Boolean(text.trim())} canQueue={eligible}
      onTextChange={setText} onFiles={() => {}} onPastedText={() => {}} onPasteError={() => {}} onHighlightChange={() => {}} onSuppressMenu={() => {}}
      onApplySuggestion={() => selections++} onClearRequiredRecipient={() => {}} onSend={() => sends++} onQueue={available ? () => queues++ : undefined} />;
  }
  const render = async (options = {}) => {
    flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline /><Probe key={++epoch} {...options} /></ThemeProvider>)); await settle();
    ref.current!.focus(); const text = ref.current!.getCanonicalText(); ref.current!.setSelectionOffsets(text.length, text.length); await settle();
    return host.querySelector<HTMLElement>('[aria-label="Message"]')!;
  };
  try {
    for (const options of [{}, { menu: true }]) {
      const editor = await render(options), before = queues, draft = ref.current!.getCanonicalText(); await key(editor, true);
      assert(queues === before + 1 && sends === 0 && selections === 0, 'Ctrl+Enter queues once and never sends or selects');
      assert(ref.current!.getCanonicalText() === draft && !editor.textContent?.includes('\n'), 'Native Lexical and React do not insert a shortcut newline');
      await key(editor, true, { repeat: true }); assert(queues === before + 1, 'Repeat does not queue again');
    }
    for (const options of [{ available: false }, { eligible: false }, { disabled: true }, { locked: true }]) {
      const editor = await render(options), before = queues, draft = ref.current!.getCanonicalText(); await key(editor, true);
      assert(queues === before && sends === 0 && ref.current!.getCanonicalText() === draft, 'Unavailable/disabled queue retains draft without fallback');
    }
    let editor = await render(); await key(editor, true, { isComposing: true }); assert(sends === 0 && queues === 2, 'Native IME flag never submits');
    editor.dispatchEvent(new CompositionEvent('compositionstart', { data: 'あ', bubbles: true })); await settle();
    assert(ref.current!.isComposing(), 'Real Lexical composition state is active');
    await key(editor, true, { isComposing: false }); assert(sends === 0 && queues === 2, 'Lexical composition blocks even with false native IME flag');
    editor.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true })); await settle();
    editor = await render(); const draft = ref.current!.getCanonicalText(); await key(editor, false);
    assert(mobile ? sends === 0 : sends === 1 && ref.current!.getCanonicalText() === draft, 'Ordinary Enter keeps mobile non-submission / desktop Send; native mobile newline is qualified with trusted keys');
    editor = await render(); await key(editor, false, { shiftKey: true }); assert(mobile ? sends === 0 : ref.current!.getCanonicalText().endsWith('\n'), 'Shift+Enter never submits; desktop native handler keeps its newline');
  } finally { root.unmount(); host.remove(); }
}

export async function composerQueueSubmissionMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const binding = { projectId: 'synthetic', agentId: 'queue-agent', handle: 'Queue-Agent', currentHandle: 'Queue-Agent', currentTitle: 'Queue Agent' };
  let epoch = 0, failQueue = false, failSend = false;
  const queues: Array<{ text: string; files: File[]; recipients: string[]; retry: boolean }> = [], sends: string[] = [];
  const providerActions: string[] = [];
  function Probe({ busy, available = true, blocked = false, text = '#Queue-Agent Queued exact λ😀' }: { busy: boolean; available?: boolean; blocked?: boolean; text?: string }) {
    const [rows, setRows] = useState<QueuedConversationMessageDto[]>([]);
    return <><Composer disabled={false} submissionDisabled={blocked} running={busy} allowSendWhileRunning allowUnmentionedSend agentResponding={busy}
      destinationMode="project-chat" defaultDestination={{ handle: binding.handle, binding, selectionKey: binding.agentId }} mentionHandles={[binding.handle]} mentionBindings={[binding]}
      insertTextRequest={text ? { id: String(epoch), text } : undefined}
      commands={[{ name: 'status', description: 'Synthetic runtime action', invocation: 'runtime', status: 'available', source: 'adapter-implemented', acceptsArguments: true, insertText: '/status ' }, { name: 'prompt', description: 'Synthetic prompt command', invocation: 'prompt', status: 'available', source: 'adapter-implemented', acceptsArguments: true, insertText: '/prompt ' }]}
      onCommand={(command, args) => { providerActions.push(command.name + ':' + (args ?? '')); }}
      onSend={body => { sends.push(body); if (failSend) throw Error('Controlled Send failure'); }}
      onQueue={available ? (body, files, _ids, _owner, context) => {
        queues.push({ text: body, files: [...files], recipients: context?.mentionedAgents?.map(item => item.agentId) ?? [], retry: Boolean(context?.retryPreparedAttempt) });
        if (failQueue) throw Error('Controlled Queue failure');
        setRows(current => [...current, { deliveryId: 'delivery-' + queues.length, messageId: 'message-' + queues.length, conversationId: 'synthetic', targetAgentId: binding.agentId, position: current.length + 1, text: body, createdAt: '2026-11-09T00:00:00Z', status: 'queued' }]);
      } : undefined} />
      <QueuedMessageTray messages={rows} onSteer={() => {}} onEdit={() => {}} onDelete={() => {}} />
    </>;
  }
  const render = async (options: Parameters<typeof Probe>[0]) => {
    flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline /><QueryClientProvider client={client}><MutationNotificationProvider><Probe key={++epoch} {...options} /></MutationNotificationProvider></QueryClientProvider></ThemeProvider>)); await settle();
    if (options.text !== '') await until(() => host.querySelector<HTMLElement>('[aria-label="Message"]')?.textContent?.includes(options.text ?? 'Queued exact') === true, 'Draft insertion settles');
    const editor = host.querySelector<HTMLElement>('[aria-label="Message"]')!; editor.focus(); await settle(); return editor;
  };
  try {
    let editor = await render({ busy: false }); assert(!host.querySelector('[aria-label="Queue message"]'), 'Idle has no Queue button');
    await key(editor, true); await until(() => queues.length === 1, 'Idle shortcut invokes existing queue callback');
    await until(() => Boolean(host.querySelector('[aria-label="Queued messages"]')?.textContent?.includes('Queued exact')), 'Accepted queue appears in existing tray');
    assert(sends.length === 0 && queues[0].recipients.join() === binding.agentId, 'Shortcut retains designated recipient');
    editor = await render({ busy: true }); const files = new DataTransfer(); const file = new File(['attachment bytes'], 'queue-note.txt', { type: 'text/plain' }); files.items.add(file);
    const input = host.querySelector<HTMLInputElement>('[aria-label="Choose files"]')!; input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => host.textContent?.includes('queue-note.txt') === true, 'Attachment is visible');
    failQueue = true; await key(editor, true); await until(() => host.textContent?.includes('Controlled Queue failure') === true, 'Queue failure is surfaced');
    assert(queues.length === 2 && queues[1].files[0] === file && queues[1].recipients.join() === binding.agentId && sends.length === 0, 'Busy shortcut submits exact attachment/recipient through queue');
    assert(editor.textContent?.includes('Queued exact') && host.textContent?.includes('queue-note.txt'), 'Failed enqueue retains draft and attachment');
    failQueue = false; await key(editor, true); await until(() => queues.length === 3 && Boolean(host.querySelector('[aria-label="Queued messages"]')), 'Queue retry succeeds');
    assert(queues[2].retry && queues[2].text === queues[1].text && queues[2].files[0] === file, 'Retry preserves queue action and exact inputs');
    editor = await render({ busy: true, available: false }); const before = queues.length; await key(editor, true);
    assert(queues.length === before && sends.length === 0 && editor.textContent?.includes('Queued exact'), 'No queue callback retains eligible draft');
    for (const options of [{ busy: true, blocked: true }, { busy: true, text: '' }]) { editor = await render(options); await key(editor, true); assert(queues.length === before && sends.length === 0, 'Disabled/empty draft does not submit'); }
    editor = await render({ busy: true }); failSend = true;
    host.querySelector<HTMLButtonElement>('[aria-label="Steer active response"]')!.click(); await until(() => host.textContent?.includes('Controlled Send failure') === true, 'Frozen Send failure retained');
    const sent = sends.length; await key(editor, true); assert(sends.length === sent && queues.length === before && editor.textContent?.includes('Queued exact'), 'Ctrl+Enter cannot retry a frozen Send'); failSend = false;
    editor = await render({ busy: true }); host.querySelector<HTMLButtonElement>('[aria-label="Queue message"]')!.click(); await until(() => queues.length === before + 1, 'Existing Queue button remains functional');
    assert(queues.at(-1)!.text === queues[0].text, 'Button and shortcut use identical queue submission text');
    for (const text of ['#Queue-Agent /status', '/status with arguments']) {
      editor = await render({ busy: false, text }); const count = queues.length, sent = sends.length, actions = providerActions.length;
      await key(editor, true); await until(() => host.textContent?.includes('Provider actions cannot be queued') === true, 'Queue rejects a runtime action');
      assert(queues.length === count && sends.length === sent && providerActions.length === actions && editor.textContent?.includes('/status'), 'Ctrl+Enter retains runtime command without executing or accepting suggestions');
      host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(); await until(() => providerActions.length === actions + 1, 'Explicit Send still executes the provider action');
    }
    if (!mobile) {
      editor = await render({ busy: false, text: '#Queue-Agent /status' }); const actions = providerActions.length;
      await key(editor, false); assert(providerActions.length === actions && editor.textContent?.includes('/status'), 'Ordinary Enter first accepts the highlighted command');
      await key(editor, false); await until(() => providerActions.length === actions + 1, 'Ordinary Enter executes the selected runtime command once');
    }
    editor = await render({ busy: true, text: '#Queue-Agent /status' }); const actions = providerActions.length, count = queues.length;
    host.querySelector<HTMLButtonElement>('[aria-label="Queue message"]')!.click(); await until(() => host.textContent?.includes('Provider actions cannot be queued') === true, 'Queue button uses the same runtime-action validation');
    assert(providerActions.length === actions && queues.length === count, 'Queue never becomes a provider action');
    for (const text of ['#Queue-Agent /prompt with arguments', '#Queue-Agent /unknown literal']) {
      editor = await render({ busy: false, text }); const before = queues.length; await key(editor, true); await until(() => queues.length === before + 1, 'Prompt commands and unknown slash text retain ordinary queue semantics');
      assert(providerActions.length === actions, 'Queued authored text does not execute a provider action');
    }
    editor = await render({ busy: false, text: '#Queue-Agent /status' }); const attached = new DataTransfer(); attached.items.add(new File(['literal command attachment'], 'literal.txt', { type: 'text/plain' }));
    const attachmentInput = host.querySelector<HTMLInputElement>('[aria-label="Choose files"]')!; attachmentInput.files = attached.files; attachmentInput.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => host.textContent?.includes('literal.txt') === true, 'Command-like message attachment settles'); const before = queues.length;
    await key(editor, true); await until(() => queues.length === before + 1, 'Command-like text with attachment remains an authored queued message');
    assert(providerActions.length === actions && queues.at(-1)!.files[0].name === 'literal.txt', 'Attachment follows existing message semantics');
  } finally { root.unmount(); client.clear(); host.remove(); }
}
