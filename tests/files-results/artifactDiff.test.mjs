import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedPathDiff } from '../../apps/web/src/components/filePreview/artifactDiff.ts';

test('check 73: selected-file unified diff preserves complete hunks and does not display unrelated header paths', () => {
  const diff = 'diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1,2 +1,2 @@\n context\n-before 😀\n+after 😀\n';
  const preview = recordedPathDiff(diff, 'selected.txt');
  assert.ok(preview.includes('--- a/selected.txt')); assert.ok(preview.includes('+++ b/selected.txt'));
  assert.ok(preview.includes('-before 😀')); assert.ok(preview.includes('+after 😀')); assert.ok(!preview.includes('other.txt'));
  assert.equal(recordedPathDiff('@@ -1,2 +1,2 @@\n only one line', 'selected.txt'), undefined, 'Incomplete hunk claimed to be a readable diff');
});

// Execute the real owner, query cache and shared renderer. A cached text error
// must not prevent a byte reader (including DOCX) from loading its own URL.
await import('../shared/web-typescript-loader.mjs');
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { AgentArtifactPreview } = await import('../../apps/web/src/components/filePreview/ArtifactPreview.tsx');
const { FilePreview } = await import('../../apps/web/src/components/filePreview/FilePreview.tsx');
const { queryKeys } = await import('../../apps/web/src/queryKeys.ts');
function findPreview(node) {
  if (!React.isValidElement(node)) return;
  if (node.type === FilePreview) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findPreview(child); if (found) return found;
  }
}
for (const [extension, mediaType, label] of [
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document viewer'],
  ['pdf', 'application/pdf', 'PDF viewer'], ['png', 'image/png', undefined],
]) for (const state of ['error', 'fetching']) test(`${extension} byte preview ignores an unrelated ${state} text query`, t => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  const artifact = { id: 'owned-' + extension, kind: 'file', path: 'owned.' + extension, mediaType,
    previewUrl: '/api/owned/preview', downloadUrl: '/api/owned/download' };
  const key = queryKeys.projectArtifacts.agentContent('agent', artifact.id);
  client.getQueryCache().build(client, { queryKey: key }).setState(state === 'error'
    ? { status: 'error', error: new Error('Generic text endpoint refused bytes'), fetchStatus: 'idle' }
    : { status: 'pending', fetchStatus: 'fetching' });
  let preview;
  function Probe() {
    preview = findPreview(AgentArtifactPreview({ artifact, agentId: 'agent', agentTitle: 'Author', projectId: 'project' }));
    return null;
  }
  renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  assert.ok(preview);
  assert.equal(client.getQueryCache().find({ queryKey: key }).options.enabled, false);
  assert.equal(preview.props.error, false);
  assert.equal(preview.props.loading, false);
  const html = renderToStaticMarkup(preview);
  assert.doesNotMatch(html, /Preview is unavailable|Loading preview/);
  if (label) assert.match(html, new RegExp('Loading ' + label));
  else assert.match(html, /src="\/api\/owned\/preview"/);
  assert.match(html, /href="\/api\/owned\/download"/);
});
test('text artifact still discloses its content request failure and keeps download', t => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  const artifact = { id: 'text', kind: 'file', path: 'owned.txt', mediaType: 'text/plain', downloadUrl: '/api/owned/download' };
  client.getQueryCache().build(client, { queryKey: queryKeys.projectArtifacts.agentContent('agent', artifact.id) })
    .setState({ status: 'error', error: new Error('Unavailable'), fetchStatus: 'idle' });
  let preview;
  function Probe() { preview = findPreview(AgentArtifactPreview({ artifact, agentId: 'agent', agentTitle: 'Author', projectId: 'project' })); return null; }
  renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  assert.equal(preview.props.error, true);
  assert.match(renderToStaticMarkup(preview), /Preview is unavailable/);
});
for (const extension of ['docx', 'pdf', 'png', 'ttf']) test(`canonical recorded diff wins over ${extension} target format`, t => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  t.after(() => client.clear());
  const artifact = { id: 'saved-' + extension, kind: 'diff', path: 'owned.' + extension, mediaType: 'application/octet-stream', downloadUrl: '/api/saved/download' };
  client.setQueryData(queryKeys.projectArtifacts.agentContent('agent', artifact.id), {
    content: '--- a/owned\n+++ b/owned\n@@ -1 +1 @@\n-saved before\n+saved after\n', contentType: 'diff',
  });
  let preview;
  function Probe() { preview = findPreview(AgentArtifactPreview({ artifact, agentId: 'agent', agentTitle: 'Author', projectId: 'project' })); return null; }
  renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  assert.equal(client.getQueryCache().find({ queryKey: queryKeys.projectArtifacts.agentContent("agent", artifact.id) }).options.enabled, true);
  const html = renderToStaticMarkup(preview);
  assert.match(html, /data-preview-capability="diff"/);
  assert.match(html, /saved before/); assert.match(html, /saved after/);
  assert.doesNotMatch(html, /Loading Word document|Loading PDF viewer|<img /);
});
