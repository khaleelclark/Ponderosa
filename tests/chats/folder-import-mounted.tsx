import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from '../../apps/web/src/components/chat/Composer';
import { DecisionResponseDialog } from '../../apps/web/src/components/decisions/DecisionResponseDialog';
import { MutationNotificationProvider } from '../../apps/web/src/components/MutationNotifications';
import { queryKeys } from '../../apps/web/src/queryKeys';
import { useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { DEFAULT_ASSET_LIMITS } from '@ponderosa/core';
import { api } from '../../apps/web/src/api';
import { createPonderosaTheme } from '../../apps/web/src/theme';
import { composerAttachmentReducer } from '../../apps/web/src/components/chat/composerUtils';
import { useComposerDraftAttachments } from '../../apps/web/src/components/chat/useComposerDraftAttachments';
import { useFolderImports } from '../../apps/web/src/components/chat/useFolderImports';
import { FolderImportReview } from '../../apps/web/src/components/chat/FolderImportReview';

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(read: () => boolean, message: string) { const end = performance.now() + 5000; while (performance.now() < end) { if (read()) return; await settle(); } throw Error(message); }
const file = (name: string, read?: (yes: (file: File) => void) => void) => ({ name, isFile: true, isDirectory: false, file: read ?? ((yes: (file: File) => void) => yes(new File([name], name))) } as FileSystemFileEntry);
const folder = (name: string, entries: FileSystemEntry[]) => ({ name, isDirectory: true, isFile: false, createReader() { let done = false; return { readEntries(yes: (entries: FileSystemEntry[]) => void) { yes(done ? [] : entries); done = true; } }; } } as FileSystemDirectoryEntry);
function button(text: string) { const result = [...document.querySelectorAll('button')].find(item => item.textContent === text); assert(result, 'Button exists: ' + text); result.click(); }

export async function folderImportReviewUploadMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const original = { upload: api.uploadDraftAttachment, remove: api.deleteDraftAttachment };
  let probe: { imports: ReturnType<typeof useFolderImports>; uploads: ReturnType<typeof useComposerDraftAttachments>; files: File[] };
  const requests: { file: File; resolve: (value: any) => void }[] = [], deleted: string[] = [];
  api.uploadDraftAttachment = async (_scope, _owner, file) => new Promise(resolve => requests.push({ file, resolve }));
  api.deleteDraftAttachment = async (_scope, _owner, id) => { deleted.push(id); };
  function Probe({ scope = 'chat:fixture', enabled = true }: { scope?: string; enabled?: boolean }) {
    const [attachments, dispatch] = useReducer(composerAttachmentReducer, { files: [] });
    const uploads = useComposerDraftAttachments({ files: attachments.files, dispatch, assetLimits: DEFAULT_ASSET_LIMITS, conversationDraftId: scope, draftOwnerId: 'fixture-owner', onEdit() {}, onBeforeClear() {} });
    const imports = useFolderImports({ scope, enabled, files: attachments.files, limits: DEFAULT_ASSET_LIMITS, addFiles: uploads.addFiles, replaceFile: uploads.replaceFile, removeFile: uploads.removeFile });
    probe = { imports, uploads, files: attachments.files };
    return <FolderImportReview imports={imports} files={attachments.files} disabled={!enabled} />;
  }
  const render = async (props = {}) => { flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline /><Probe {...props} /></ThemeProvider>)); await settle(); };
  try {
    await render();
    const source = folder('project', [file('source.ts'), file('design.key'), folder('node_modules', [file('private')])]);
    await probe!.imports.importFiles([source]); await until(() => requests.length === 1 && probe!.files.length === 1 && host.textContent?.includes('Items Excluded') === true, 'Initial archive and report render while upload begins');
    const old = probe!.files[0];
    assert(host.textContent?.includes('Items Excluded') && !host.querySelector('.MuiAlert-standardError'), 'Partial import has compact report, no red error');
    button('Review Excluded Items'); await settle();
    assert(document.body.textContent?.includes('project/design.key') && document.body.textContent?.includes('1 excluded folders'), 'Review names exact file and directory count');
    button('Close'); await settle(); button('Review Excluded Items'); await settle();
    const checkbox = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]:not(:disabled)')!;
    checkbox.click(); await settle(); button('Include Selected Items');
    await until(() => probe!.files.length === 1 && probe!.files[0] !== old, 'Rebuild replaces exact archive');
    const replacement = probe!.files[0];
    await until(() => requests.length === 2, 'One replacement upload');
    requests[0].resolve({ id: 'old', name: old.name }); await until(() => deleted.includes('old'), 'Late removed upload is cleaned');
    assert(!probe!.uploads.attachmentIds.current.has(old), 'Stale archive never reenters durable map');
    requests[1].resolve({ id: 'replacement', name: replacement.name }); await settle();
    const other = new File(['other draft'], 'other.txt', { type: 'text/plain' });
    probe!.uploads.addFiles([other]); await until(() => requests.length === 3, 'Unrelated file uses existing queue');
    requests[2].resolve({ id: 'other', name: other.name }); await settle();
    let finish: ((value: File) => void) | undefined;
    const held = folder('second', [file('safe'), file('credentials.md', yes => { finish = yes; })]);
    await probe!.imports.importFiles([held]); await settle();
    const second = probe!.files.find(item => item.name === 'second.zip')!;
    await until(() => requests.length === 4, 'Second root upload begins');
    requests[3].resolve({ id: 'second', name: second.name }); await settle();
    const report = probe!.imports.reports.find(item => item.file === second)!;
    const pending = probe!.imports.include(report, ['second/credentials.md']); await until(() => Boolean(finish), 'Held reviewed entry begins reading');
    probe!.imports.remove(report); await settle(); finish!(new File(['late'], 'credentials.md')); await pending; await settle();
    assert(probe!.files.length === 2 && probe!.files.includes(other) && probe!.files.includes(replacement), 'Remove during rebuild keeps other exact files and never resurrects target');
    assert(requests.length === 4 && probe!.uploads.attachmentIds.current.get(other) === 'other', 'No stale upload or reset of other completed uploads');
  } finally { root.unmount(); host.remove(); api.uploadDraftAttachment = original.upload; api.deleteDraftAttachment = original.remove; }
}

export async function folderImportCancellationMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let probe: ReturnType<typeof useFolderImports>, attached: File[] = [];
  function Probe({ scope = 'first', destination = 'question-a', enabled = true, cancellationKey = 'answered' }) {
    probe = useFolderImports({ scope, destination, cancellationKey, enabled, files: [], limits: DEFAULT_ASSET_LIMITS, addFiles(files) { attached.push(...files); }, replaceFile() { throw Error('Unexpected replacement'); }, removeFile() {} });
    return <FolderImportReview imports={probe} files={[]} disabled={!enabled} />;
  }
  const render = async (props = {}) => { flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('dark')}><CssBaseline /><Probe {...props} /></ThemeProvider>)); await settle(); };
  try {
    await render(); await probe!.importFiles([folder('only', [file('.env')])]); await settle();
    assert(document.querySelector('[role="dialog"]') && document.body.textContent?.includes('No files are attached yet'), 'All-excluded opens actionable review');
    button('Close'); await settle(); button('Review Excluded Items'); await settle();
    assert(document.body.textContent?.includes('only/.env'), 'Dismiss and reopen retains excluded name');
    button('Remove Folder'); await settle(); assert(!host.textContent?.includes('Items Excluded'), 'Removing unattached root removes its local report');
    for (const changes of [{ scope: 'next' }, { destination: 'question-b' }, { cancellationKey: 'skipped' }, { enabled: false }]) {
      await render(); let finish: ((file: File) => void) | undefined;
      const pending = probe!.importFiles([folder('held', [file('slow', yes => { finish = yes; })])]);
      await until(() => Boolean(finish), 'Delayed read starts'); await render(changes); await render();
      finish!(new File(['late exact bytes'], 'slow')); await pending; await settle();
      assert(attached.length === 0 && !probe!.preparing, 'Changed destination, question disposition or close/reopen cancels old generation');
    }
    await render(); let finish: ((file: File) => void) | undefined;
    const pending = probe!.importFiles([folder('unmount', [file('slow', yes => { finish = yes; })])]); await until(() => Boolean(finish), 'Unmount read starts');
    root.unmount(); finish!(new File(['late'], 'slow')); await pending;
    assert(attached.length === 0, 'Unmount prevents attachment delivery');
  } finally { if (host.childNodes.length) root.unmount(); host.remove(); }
}

export async function folderImportComposerPickerDropMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.assetLimits.all, DEFAULT_ASSET_LIMITS);
  const sent: File[][] = [];
  const binding = { projectId: 'fixture', agentId: 'fixture-agent', handle: 'Fixture', currentHandle: 'Fixture', currentTitle: 'Fixture Agent' };
  try {
    flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline /><QueryClientProvider client={client}><MutationNotificationProvider>
      <Composer disabled={false} running={false} allowUnmentionedSend destinationMode="project-chat" defaultDestination={{ handle: binding.handle, binding, selectionKey: binding.agentId }} mentionHandles={[binding.handle]} mentionBindings={[binding]} onSend={(_text, files) => { sent.push([...files]); throw Error('Controlled submit failure'); }} />
    </MutationNotificationProvider></QueryClientProvider></ThemeProvider>)); await settle();
    const transfer = new DataTransfer();
    for (const name of ['.gitignore', '.env.example', 'design.key']) {
      const item = new File(['exact ' + name], name); Object.defineProperty(item, 'webkitRelativePath', { value: 'picker/' + name }); transfer.items.add(item);
    }
    const picker = host.querySelector<HTMLInputElement>('[aria-label="Choose Folder"]')!;
    picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => host.textContent?.includes('picker.zip') === true && host.textContent?.includes('Items Excluded') === true, 'Real composer folder picker attaches archive with compact report');
    const editor = host.querySelector<HTMLElement>('[aria-label="Message"]')!;
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => folder('dropped', [file('Dockerfile'), file('.env')]) }], files: [] } });
    editor.dispatchEvent(drop);
    await until(() => host.textContent?.includes('dropped.zip') === true, 'Real composer drop uses same importer');
    const relative = new File(['template'], '.env.example'); Object.defineProperty(relative, 'webkitRelativePath', { value: 'fallback/.env.example' });
    const omitted = new File(['documentation'], 'credentials.md'); Object.defineProperty(omitted, 'webkitRelativePath', { value: 'fallback/credentials.md' });
    const fallback = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(fallback, 'dataTransfer', { value: { types: ['Files'], items: [relative, omitted].map(item => ({ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => item })), files: [relative, omitted] } });
    editor.dispatchEvent(fallback); await until(() => host.textContent?.includes('fallback.zip') === true, 'Relative-path File fallback still uses folder classification');
    assert(!host.textContent?.includes('credentials.md'), 'Fallback exclusions remain local review details, not ordinary attachments');
    const direct = new DataTransfer(); direct.items.add(new File(['Deliberately selected fixture environment'], '.env'));
    const directInput = host.querySelector<HTMLInputElement>('[aria-label="Choose Files"]')!;
    directInput.files = direct.files; directInput.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => host.textContent?.includes('Individual files are attached as selected') === true, 'Direct credential-named selection remains usable with an honest advisory');
    assert(host.querySelectorAll('button').length > 0 && !host.querySelector('.MuiAlert-standardError'), 'Successful partial imports do not become send errors');
    host.querySelector<HTMLButtonElement>('[aria-label="Send Message"]')!.click();
    await until(() => host.textContent?.includes('Controlled submit failure') === true, 'Failed submit uses existing error path');
    assert(sent.length === 1 && sent[0].map(file => file.name).join() === 'picker.zip,dropped.zip,fallback.zip,.env', 'Both import methods enter the existing submission once');
    assert(host.textContent?.includes('picker.zip') && host.textContent?.includes('dropped.zip') && host.textContent?.includes('Items Excluded'), 'Failed send retains archive files and local review explanations');
  } finally { root.unmount(); client.clear(); host.remove(); }
}

export async function folderImportDecisionOwnerMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.assetLimits.all, DEFAULT_ASSET_LIMITS);
  const originals = { get: api.getConversationDraft, put: api.putConversationDraft, upload: api.uploadDraftAttachment };
  const uploaded: File[] = [], writes: unknown[] = [];
  const decision = { id: 'fixture-decision', agentId: 'fixture-agent', question: 'Attach Project Evidence', mode: 'text' as const, status: 'pending' as const, options: [], allowOther: true,
    questions: ['first', 'second'].map(id => ({ id, mode: 'text' as const, question: id, options: [], allowOther: true })) };
  api.getConversationDraft = async (conversationId, ownerId) => ({ conversationId, ownerId, revision: 0, text: '', attachmentIds: [], attachments: [], updatedAt: '2026-11-10T00:00:00Z' });
  api.putConversationDraft = async (scope, draft) => { writes.push(draft); return { ...draft, conversationId: scope, revision: 1, updatedAt: '2026-11-10T00:00:00Z' }; };
  api.uploadDraftAttachment = async (scope, owner, file) => { uploaded.push(file); return { id: 'asset-' + uploaded.length, conversationId: scope, ownerId: owner, name: file.name } as any; };
  const render = async (open = true) => { flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('dark')}><CssBaseline /><QueryClientProvider client={client}>
    <DecisionResponseDialog decision={decision} open={open} onClose={() => {}} onRespond={() => {}} />
  </QueryClientProvider></ThemeProvider>)); await settle(); };
  try {
    await render(); await until(() => !document.querySelector<HTMLButtonElement>('button')?.disabled && Boolean(document.querySelector('[aria-label="Choose Folder"]')), 'Decision draft loads');
    const transfer = new DataTransfer();
    for (const name of ['.github/build.yml', 'credentials.md']) { const item = new File(['exact ' + name], name.split('/').at(-1)); Object.defineProperty(item, 'webkitRelativePath', { value: 'decision/' + name }); transfer.items.add(item); }
    const picker = document.querySelector<HTMLInputElement>('[aria-label="Choose Folder"]')!; picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => uploaded.length === 1 && document.body.textContent?.includes('Items Excluded') === true, 'Decision folder picker reports omissions quietly');
    button('Review Excluded Items'); await settle();
    assert(document.body.textContent?.includes('decision/credentials.md'), 'Decision review preserves exact relative name');
    document.querySelector<HTMLInputElement>('[data-folder-import-review] input[type="checkbox"]:not(:disabled)')!.click(); await settle(); button('Include Selected Items');
    await until(() => uploaded.length === 2, 'Decision review rebuilds through existing queue'); button('Close'); await settle();
    button('Next'); await settle();
    assert(!document.body.textContent?.includes('decision.zip'), 'Folder stays owned by first question'); button('Back'); await settle();
    assert(document.body.textContent?.includes('decision.zip') && document.body.textContent?.includes('Import Details'), 'Returning to question retains archive and reviewed names');
    button('Next'); await settle();
    const allTransfer = new DataTransfer(), env = new File(['private'], '.env');
    Object.defineProperty(env, 'webkitRelativePath', { value: 'all/.env' }); allTransfer.items.add(env);
    const secondPicker = document.querySelector<HTMLInputElement>('[aria-label="Choose Folder"]')!;
    secondPicker.files = allTransfer.files; secondPicker.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => Boolean(document.querySelector('[data-folder-import-review]')), 'All-excluded Decision opens review');
    button('Close'); await settle(); button('Skip This Question'); await settle(); button('Review Excluded Items'); await settle();
    assert(document.querySelector<HTMLInputElement>('[data-folder-import-review] input[type="checkbox"]')!.disabled, 'Skipped answer disables new inclusion');
    assert([...document.querySelectorAll('button')].find(item => item.textContent === 'Include Selected Items')!.disabled && uploaded.length === 2, 'Review never silently converts Skip into an answer');
    button('Close'); await settle(); button('Answer Instead'); await settle(); button('Review Excluded Items'); await settle(); button('Remove Folder'); await settle();
    button('Back'); await settle();
    let finish: ((file: File) => void) | undefined;
    const target = document.querySelector('textarea')!;
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => folder('late', [file('held', yes => { finish = yes; })]) }], files: [] } }); target.dispatchEvent(drop);
    await until(() => Boolean(finish), 'Decision delayed read starts'); await render(false); await render(true); finish!(new File(['late'], 'held'));
    await settle(); await settle(); assert(uploaded.length === 2, 'Close/reopen never delivers stale folder');
    assert(!JSON.stringify(writes).includes('credentials.md'), 'Excluded/review metadata is never persisted with draft save');
  } finally { root.unmount(); client.clear(); host.remove(); api.getConversationDraft = originals.get; api.putConversationDraft = originals.put; api.uploadDraftAttachment = originals.upload; }
}

export async function folderImportChangedSourceMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let probe: ReturnType<typeof useFolderImports>, files: File[] = [];
  function Probe() {
    const [attachments, dispatch] = useReducer(composerAttachmentReducer, { files: [] });
    const uploads = useComposerDraftAttachments({ files: attachments.files, dispatch, assetLimits: DEFAULT_ASSET_LIMITS, draftOwnerId: 'fixture', onEdit() {}, onBeforeClear() {} });
    probe = useFolderImports({ scope: 'fixture', enabled: true, files: attachments.files, addFiles: uploads.addFiles, replaceFile: uploads.replaceFile, removeFile: uploads.removeFile });
    files = attachments.files;
    return <FolderImportReview imports={probe} files={files} disabled={false} />;
  }
  try {
    flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline /><Probe /></ThemeProvider>)); await settle();
    const safe = file('safe'), key = file('design.key'), children = [safe, key];
    await probe!.importFiles([folder('mutable', children)]); await until(() => files.length === 1 && probe!.reports.length === 1, 'Initial project and report render');
    const original = files[0], report = probe!.reports[0];
    probe!.review(report.id); await settle();
    children.splice(0, 1);
    await probe!.include(report, ['mutable/design.key']); await settle();
    assert(files.length === 1 && files[0] === original && probe!.error?.includes('mutable/safe') && probe!.reports[0].included.length === 0, 'A disappearing original member fails the rebuild without truncating the old archive');
    assert(document.querySelector('[data-folder-import-review] [role="alert"]')?.textContent?.includes('mutable/safe'), 'Rebuild failure is visible inside its open review dialog');
    children.splice(0, 1, safe);
    await probe!.include(report, ['mutable/design.key']); await settle();
    assert(files[0] === original && probe!.error?.includes('mutable/design.key') && probe!.reports[0].included.length === 0, 'A missing review item is never falsely marked Included');
  } finally { root.unmount(); host.remove(); }
}

export async function folderImportRetainedDraftMountedRegression(): Promise<void> {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let probe: { imports: ReturnType<typeof useFolderImports>; uploads: ReturnType<typeof useComposerDraftAttachments>; files: File[] };
  let retainedAttachmentIds: string[] = [];
  const key = (scope: string) => 'ponderosa.folder-imports.v1.owned-retention-' + scope;
  function Probe({ scope, ready }: { scope: string; ready: boolean }) {
    const [attachments, dispatch] = useReducer(composerAttachmentReducer, { files: [] });
    const uploads = useComposerDraftAttachments({ files: attachments.files, dispatch, assetLimits: DEFAULT_ASSET_LIMITS, draftOwnerId: 'owned-retention', onEdit() {}, onBeforeClear() {} });
    const imports = useFolderImports({ scope, storageKey: key(scope), ready, retainedAttachmentIds, enabled: ready, files: attachments.files,
      attachmentIds: uploads.attachmentIds.current, attachmentVersion: uploads.attachmentVersion,
      addFiles: uploads.addFiles, replaceFile: uploads.replaceFile, removeFile: uploads.removeFile });
    probe = { imports, uploads, files: attachments.files };
    return <FolderImportReview imports={imports} files={attachments.files} disabled={!ready} />;
  }
  const render = async (scope: string, ready = true) => { flushSync(() => root.render(<ThemeProvider theme={createPonderosaTheme('dark')}><CssBaseline /><Probe key={scope} scope={scope} ready={ready} /></ThemeProvider>)); await settle(); };
  try {
    await render('A');
    await probe!.imports.importFiles([folder('project', [file('safe', yes => yes(new File(['source bytes stay transient'], 'safe'))), file('design.key')])]);
    await until(() => probe!.files.length === 1, 'Initial archive enters draft');
    const original = probe!.files[0]; probe!.uploads.replaceSnapshot([{ file: original, attachmentId: 'exact-archive-A' }]);
    await until(() => JSON.parse(localStorage.getItem(key('A')) ?? '{}').reports?.[0]?.archiveId === 'exact-archive-A', 'Metadata follows durable archive identity');
    const stored = localStorage.getItem(key('A'))!;
    assert(!stored.includes('source bytes stay transient') && !Object.hasOwn(JSON.parse(stored).reports[0], 'input') && !Object.hasOwn(JSON.parse(stored).reports[0], 'file'), 'Neither source contents nor handles/File objects are stored');
    await render('B'); assert(probe!.imports.reports.length === 0, 'A report never leaks into a different draft');
    await render('A', false);
    assert(probe!.imports.reports.length === 1 && probe!.imports.reports[0].archiveId === 'exact-archive-A' && !probe!.imports.reports[0].file, 'Remount retains metadata while attachment hydration is pending');
    assert(localStorage.getItem(key('A')) !== null, 'Initial empty hydration does not erase report');
    retainedAttachmentIds = ['exact-archive-A']; await render('A');
    assert(probe!.imports.reports.length === 1 && localStorage.getItem(key('A')) !== null, 'Failed download retains metadata while exact canonical attachment is still staged');
    const restored = new File([original], original.name, { type: original.type });
    probe!.uploads.replaceSnapshot([{ file: restored, attachmentId: 'exact-archive-A' }]); await settle(); retainedAttachmentIds = []; await render('A');
    await until(() => probe!.imports.reports[0]?.file === restored, 'New File object rebinds by exact archive ID');
    assert(probe!.imports.reports[0].input.length === 0 && restored !== original, 'Restored review honestly requires source reselection');
    button('Review Excluded Items'); await settle();
    const dialog = document.querySelector<HTMLElement>('[data-folder-import-review]')!;
    assert(dialog.textContent?.includes('project/design.key') && dialog.textContent?.includes('Select the original folder again'), 'Retained names/reasons remain actionable');
    dialog.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)')!.click(); await settle();
    const input = dialog.querySelector<HTMLInputElement>('[aria-label="Reselect Folder"]')!; input.click = () => {};
    button('Select Folder Again');
    const selection = new DataTransfer();
    for (const name of ['safe', 'design.key']) { const item = new File([name], name); Object.defineProperty(item, 'webkitRelativePath', { value: 'project/' + name }); selection.items.add(item); }
    input.files = selection.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => probe!.files.length === 1 && probe!.files[0] !== restored && probe!.imports.reports[0]?.included.includes('project/design.key') === true, 'Reselected source replaces only the exact restored archive');
    button('Close'); await settle(); probe!.uploads.removeFile(0);
    await until(() => probe!.imports.reports.length === 0 && localStorage.getItem(key('A')) === null, 'Actual attachment removal clears retained metadata');
    // Same filename/bytes with a different durable identity must not inherit the report.
    localStorage.setItem(key('A'), stored); await render('B'); await render('A', false);
    probe!.uploads.replaceSnapshot([{ file: restored, attachmentId: 'different-archive' }]); await settle(); await render('A');
    await until(() => probe!.imports.reports.length === 0, 'Unmatched canonical archive ID prunes stale report without binding another file');
    assert(probe!.files[0] === restored, 'Pruning metadata never deletes unrelated draft data');
    await render('pending'); await probe!.imports.importFiles([folder('only', [file('.env')])]); await settle(); button('Close'); await render('B'); await render('pending');
    assert(probe!.imports.reports[0]?.excluded[0]?.path === 'only/.env' && probe!.imports.reports[0].input.length === 0, 'All-excluded local selection retains metadata across remount without storing source');
    probe!.imports.remove(probe!.imports.reports[0]); await settle();
    localStorage.setItem(key('invalid'), JSON.stringify({ version: 1, reports: [{ id: 'bad', name: '../escape', excluded: [], included: [], paths: [], fileCount: 0 }] }));
    await render('invalid'); assert(probe!.imports.reports.length === 0, 'Malformed/unbounded local metadata is not trusted as import state');
  } finally { root.unmount(); host.remove(); for (const scope of ['A','B','pending','invalid']) localStorage.removeItem(key(scope)); }
}
