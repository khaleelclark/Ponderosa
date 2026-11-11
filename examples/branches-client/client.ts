/** Outside application: uses only the documented Branches HTTP interface. */
const [command, id, occurrenceKey, ...input] = process.argv.slice(2);
const base = new URL(process.env.PONDEROSA_URL ?? 'http://127.0.0.1:3000');
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('PONDEROSA_URL must use HTTP or HTTPS');

async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return JSON.parse(text);
}

try {
  if (!id || !['start', 'status', 'result'].includes(command ?? '')) {
    throw new Error('Usage: client.ts start BRANCH_ID OCCURRENCE_KEY INPUT | status EXECUTION_ID | result EXECUTION_ID');
  }
  const encoded = encodeURIComponent(id);
  if (command === 'start') {
    if (!occurrenceKey || !input.length) throw new Error('start requires a stable occurrence key and input');
    // Keep this key when recovering an uncertain response; a new key starts new work.
    console.log(JSON.stringify(await request(`/api/branches/${encoded}/executions`, {
      occurrenceKey, input: input.join(' '),
    }), null, 2));
  } else {
    console.log(JSON.stringify(await request(`/api/branch-executions/${encoded}${command === 'result' ? '/result' : ''}`), null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
export {};
