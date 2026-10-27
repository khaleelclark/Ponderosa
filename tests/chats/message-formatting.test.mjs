import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseRichMessageBlock, RICH_MESSAGE_FORMAT_INSTRUCTIONS } from '@ponderosa/core';
const { ChatMessageBody, collapsedLongMessagePreview } = await import('../../apps/web/src/components/chat/ChatMessages.tsx');
const { MutationNotificationProvider } = await import('../../apps/web/src/components/MutationNotifications.tsx');
const render = (text, props = {}) => renderToStaticMarkup(React.createElement(MutationNotificationProvider, null, React.createElement(ChatMessageBody, { text, collapseLongMessage: false, ...props })));
const metric = { version: 1, type: 'metrics', items: [{ label: 'Physical RAM', value: '16', unit: 'GB' }] };
const fence = (block, closer = '```') => '```ponderosa\n' + JSON.stringify(block) + '\n' + closer;
const richCount = html => [...html.matchAll(/data-ponderosa-rich=/g)].length;
const { chatMarkdownUrlTransform } = await import('../../apps/web/src/components/chat/chatMarkdownLink.ts');
const { setStandaloneProductScope } = await import('../../apps/web/src/api/productScope.ts');

test('Branches artifact links retain their current product route and download feedback', () => {
  setStandaloneProductScope('branches');
  try {
    const href = '/api/branches/engine/projects/branch-project/artifacts/import_123/download';
    for (const link of ['ponderosa://artifact/import_123', href]) {
      const html = render(`[Download](${link})`, { projectId: 'branch-project' });
      assert.ok(html.includes(`href="${href}"`));
      assert.match(html, /download=""/);
    }
  } finally { setStandaloneProductScope(undefined); }
});

test('existing artifact Markdown links rerender as project-authorized downloads with their authored labels', () => {
  for (const id of ['import_2cde92a47c35500d7e7868c7889cc74ac7f59e957f00d70f', 'agent:run:1:0', 'a', 'a'.repeat(256)]) {
    const url = `/api/projects/current-project/artifacts/${encodeURIComponent(id)}/download`;
    const text = `[Download **report**](ponderosa://artifact/${id})`;
    for (let reload = 0; reload < 2; reload++) {
      const html = render(text, { projectId: 'current-project' });
      assert.ok(html.includes(`href="${url}"`));
      assert.match(html, /download=""/);
      assert.match(html, />Download <strong>report<\/strong><\/a>/);
      assert.doesNotMatch(html, /href="ponderosa:/);
    }
    assert.doesNotMatch(render(text), /<a\b/);
    assert.equal(chatMarkdownUrlTransform(`ponderosa://artifact/${id}`, 'src', 'current-project'), '');
  }
});

test('artifact link support does not admit malformed references or other custom protocols', () => {
  const invalid = ['ponderosa://artifact/', 'ponderosa://artifact/.', 'ponderosa://artifact/..',
    'ponderosa://artifact/a/b', 'ponderosa://artifact/a?project=foreign', 'ponderosa://artifact/a#fragment',
    'ponderosa://user@artifact/a', 'ponderosa://artifact:80/a', 'ponderosa://artifact/%2e%2e',
    'ponderosa://artifact/a%2fb', 'ponderosa://artifact/a%5cb', 'ponderosa://artifact/a%00',
    'ponderosa://artifact/a\\b', 'ponderosa://artifact/a\n', 'ponderosa://artifact/' + 'a'.repeat(257),
    'ponderosa://other/a', 'javascript:alert(1)', 'data:text/html,evil', 'file:///etc/passwd'];
  for (const href of invalid) assert.equal(chatMarkdownUrlTransform(href, 'href', 'project'), '', JSON.stringify(href));
  for (const href of invalid.filter(href => !/[\n\\]/u.test(href))) {
    assert.doesNotMatch(render(`[Keep label](<${href}>)`, { projectId: 'project' }), /<a\b/, href);
  }
  assert.doesNotMatch(render('![Image](ponderosa://artifact/image)', { projectId: 'project' }), /(?:src|href)="[^\"]*artifacts\//);
  assert.doesNotMatch(render('`[literal](ponderosa://artifact/a)`', { projectId: 'project' }), /<a\b/);
});

test('returned download URLs and existing HTTPS, workspace and project-file links remain intact', () => {
  const returned = '/api/projects/project/artifacts/import_123/download';
  const download = render(`[Checksum](${returned})`, { projectId: 'project' });
  assert.ok(download.includes(`href="${returned}"`));
  assert.match(download, /download=""/);
  assert.match(render('[Website](https://example.com/file)'), /href="https:\/\/example.com\/file"/);
  assert.match(render('[Mail](mailto:operator@example.com)'), /href="mailto:operator@example.com"/);
  const workspace = render('[Report](report.md)', { projectId: 'project', fileScope: { conversationId: 'chat' } });
  assert.ok(workspace.includes('/projects/project/files/view?path=report.md&amp;conversationId=chat'));
  const reference = '[Report](ponderosa://project-file/project/artifact?historical=Report.md)';
  assert.ok(render(reference, { projectId: 'project' }).includes('/projects/project?view=files&amp;artifact=artifact'));
  assert.doesNotMatch(render(reference, { projectId: 'foreign' }), /<a\b/);
});

test('all five provider contract examples are accepted without rewriting values', () => {
  const examples = [...RICH_MESSAGE_FORMAT_INSTRUCTIONS.matchAll(/```ponderosa\n([^]*?)\n```/g)];
  assert.equal(examples.length, 5);
  for (const [, source] of examples) {
    assert.deepEqual(parseRichMessageBlock(source), JSON.parse(source));
    assert.equal(richCount(render('```ponderosa\n' + source + '\n```')), 1);
  }
});

test('bounded decoder rejects malformed, unsupported, hostile and dishonest displays', () => {
  const meter = { version: 1, type: 'meters', items: [{ label: 'Readiness', value: 18, min: 0, max: 25, unit: 'checks' }] };
  const line = { version: 1, type: 'line', title: 'Trend', unit: 'checks', points: [{ label: 'Mon', value: -2 }, { label: 'Tue', value: 4 }] };
  const invalid = [null, [], {}, { ...metric, version: 2 }, { ...metric, html: '<script/>' },
    { ...metric, items: [] }, { ...metric, items: Array(13).fill(metric.items[0]) },
    { ...metric, items: [{ ...metric.items[0], value: 16 }] },
    { ...metric, items: [{ ...metric.items[0], label: 'x'.repeat(161) }] },
    { ...metric, items: [{ ...metric.items[0], url: 'https://example.com' }] },
    { ...meter, items: [{ ...meter.items[0], value: 26 }] },
    { ...meter, items: [{ ...meter.items[0], max: 0 }] },
    { ...meter, items: [{ ...meter.items[0], min: -1e308, max: 1e308 }] },
    { ...line, type: 'bar' }, { ...line, points: Array(49).fill(line.points[0]) },
    { ...line, points: [{ label: 'A', value: -1e308 }, { label: 'B', value: 1e308 }] },
    { version: 1, type: 'statuses', items: [{ label: 'Pressure', value: 'Low', tone: { toString: 'positive' } }] }];
  for (const block of invalid) assert.equal(parseRichMessageBlock(JSON.stringify(block)), undefined, JSON.stringify(block));
  assert.deepEqual(parseRichMessageBlock(JSON.stringify(metric).padEnd(32768, ' ')), metric);
  for (const source of ['{', JSON.stringify(metric).padEnd(32769, ' '), JSON.stringify(line).replace('-2', '1e999')]) assert.equal(parseRichMessageBlock(source), undefined);
  assert.deepEqual(parseRichMessageBlock(JSON.stringify(meter)), meter);
  assert.deepEqual(parseRichMessageBlock(JSON.stringify(line)), line);
  assert.deepEqual(parseRichMessageBlock(JSON.stringify({ ...line, points: [{ label: 'A', value: 0 }] })).points, [{ label: 'A', value: 0 }]);
});

test('rich rendering requires a complete matching fence; fallback remains copyable source', () => {
  for (const newline of ['\n', '\r\n', '\r']) assert.equal(richCount(render(fence(metric).replaceAll('\n', newline))), 1);
  for (const source of [fence(metric, ''), fence(metric, '~~'), fence(metric).replace('```ponderosa', '````ponderosa'),
    fence({ ...metric, version: 2 }), fence(metric).replace('ponderosa', 'ponderosa extra'), '```ponderosa\n{\n```']) {
    const html = render(source);
    assert.equal(richCount(html), 0, source);
    assert.match(html, /Copy code/);
  }
  assert.equal(richCount(render(Array(9).fill(fence(metric)).join('\n\n'))), 8);
  assert.match(render(Array(9).fill(fence(metric)).join('\n\n')), /Copy code/);
  assert.equal(richCount(render('> ' + fence(metric).replaceAll('\n', '\n> '))), 1);
});

test('authored prose breaks survive without turning parser separators into blank rows', () => {
  const html = render('First line\nSecond line\n\nNew paragraph\n\n\n\nAfter three blank lines.\n\nTail');
  assert.equal([...html.matchAll(/<br\s*\/?\s*>/g)].length, 1);
  assert.equal([...html.matchAll(/data-authored-blank-lines="2"/g)].length, 1);
  assert.ok(!render('Alpha\n\nBeta').includes('data-authored-blank-lines'));
  assert.equal([...render('Alpha  \nBeta\\\nGamma').matchAll(/<br\s*\/?\s*>/g)].length, 2);
  const opaque = render('`one\ntwo`\n\n```text\ncode\n\n\n\nkeeps\n```');
  assert.ok(!opaque.includes('data-authored-blank-lines'));
  assert.ok(opaque.includes('code\n\n\n\nkeeps'));
  const reference = render('Alpha\n\n[ref]: https://example.com\n\n[Link][ref]');
  assert.ok(!reference.includes('data-authored-blank-lines'));
  assert.match(reference, /href="https:\/\/example.com"/);
  const table = render('| Date | Cash |\n| --- | ---: |\n| Now | $3,500 |');
  assert.match(table, /scope="col"/);
  assert.match(table, /text-align:right/);
  assert.match(table, /role="region" tabindex="0"/);
});

test('rich labels remain inert text and line values have a keyboard-accessible table', () => {
  const block = { version: 1, type: 'line', title: '<script>Trend</script>', unit: 'checks', points: [{ label: '<img onerror=alert(1)>', value: 0 }] };
  const html = render(fence(block));
  assert.equal(richCount(html), 1);
  assert.ok(!html.includes('<script>') && !html.includes('<img '));
  assert.match(html, /&lt;script&gt;Trend&lt;\/script&gt;/);
  assert.match(html, /role="region" tabindex="0"/);
  assert.match(html, /aria-label="&lt;script&gt;Trend&lt;\/script&gt; data"/);
  assert.ok(!/\b(?:NaN|Infinity)\b/.test(html));
});

test('collapsed previews never promote a cut or hidden rich fence', () => {
  const hidden = 'prose\n'.repeat(73) + fence(metric);
  assert.equal(richCount(render(hidden, { collapseLongMessage: true })), 0);
  assert.equal(richCount(render(hidden)), 1);
  const cut = 'x'.repeat(3150) + '\n\n' + fence({ ...metric, title: 'x'.repeat(100) }) + '\n' + 'tail'.repeat(1000);
  assert.equal(richCount(render(collapsedLongMessagePreview(cut))), 0);
  assert.equal(richCount(render(cut)), 1);
});
