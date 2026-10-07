#!/usr/bin/env node
// Local disposable transport only: no provider, profile or network access.
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: 'disposable-thread' } } });
  else if (frame.method === 'turn/start') {
    await writeFile(process.env.PONDEROSA_SEED_CAPTURE, JSON.stringify(frame.params));
    send({ id: frame.id, result: { turn: { id: 'disposable-turn' } } });
    setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: 'disposable-turn', status: 'completed' } } }), 10);
  } else if (frame.id !== undefined) send({ id: frame.id, result: {} });
}
