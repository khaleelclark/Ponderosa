// Explicit built-browser qualification: existing Chrome/playwright-core and built workspaces required.
// Controlled canonical API fixture; no provider inference. Run command is in docs/AGENT_PAUSE_RESUME.md.
import { fixture, until } from '../shared/fixture.mjs';
import { AgentStore, CoordinationV3Store } from '../../packages/agents/dist/index.js';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url)), out = process.env.PONDEROSA_PAUSE_UI_EVIDENCE;
assert(out, 'Set PONDEROSA_PAUSE_UI_EVIDENCE to an owned evidence directory');
await mkdir(out, { recursive: true });
const require = createRequire(root + '/apps/server/package.json'), { chromium } = require('playwright-core');
let store, browser, server;
const rows = [], requests = [];
const f = await fixture({ storeFactory: p => (store = new AgentStore(p)) });
try {
    const upstream = await f.listen();
    server = createServer(async (req, res) => { try {
        if (req.url.startsWith('/api/')) {
            const chunks = [];
            for await (const c of req)
                chunks.push(c);
            const body = Buffer.concat(chunks);
            const response = await fetch(upstream + req.url, { method: req.method, headers: { ...Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'accept-encoding'].includes(k))), host: new URL(upstream).host, ...(req.headers.origin ? { origin: upstream } : {}) }, ...(body.length ? { body } : {}) });
            if (req.method === 'POST')
                requests.push({ path: req.url, body: body.toString(), status: response.status });
            res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([k]) => !['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(k))));
            if (response.body) {
                const stream = Readable.fromWeb(response.body);
                stream.on('error', () => res.destroy());
                res.on('close', () => stream.destroy());
                stream.pipe(res);
            }
            else
                res.end();
            return;
        }
        if (['/sw.js', '/register-sw.js'].includes(req.url)) {
            res.writeHead(404);
            res.end();
            return;
        }
        const file = path.resolve(root + '/apps/web/dist', '.' + new URL(req.url, 'http://localhost').pathname);
        let bytes, target = file;
        try {
            bytes = await readFile(file);
        }
        catch {
            target = root + '/apps/web/dist/index.html';
            bytes = await readFile(target);
        }
        res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(target)] || 'application/octet-stream' });
        res.end(bytes);
    }
    catch (e) {
        res.writeHead(500);
        res.end(String(e));
    } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    await writeFile(out + '/fixture.json', JSON.stringify({ root: f.root, origin, upstream }, null, 2));
    browser = await chromium.launch({ executablePath: process.env.PONDEROSA_CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    for (const mobile of [false, true])
        for (const theme of ['light', 'dark']) {
            const cell = (mobile ? 'mobile' : 'desktop') + '-' + theme, row = { cell, checks: [], errors: [] };
            rows.push(row);
            const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 962 } });
            await context.addInitScript(t => localStorage.setItem('ponderosa-color-mode', t), theme);
            const page = await context.newPage();
            page.setDefaultTimeout(7000);
            page.on('pageerror', e => row.errors.push(e.message));
            const chat = await f.createChat('Pause UI ' + cell), agent = await f.createIdleAgent(chat, 'Pause reviewer ' + cell);
            await f.hold(agent.id);
            const coord = new CoordinationV3Store(store.sqlite);
            const run = coord.activeAgentRun(agent.id);
            row.agent = agent.id;
            row.originalRun = run.id;
            const initial = await f.detail(agent.id);
            row.access = initial.agent.access;
            const press = async (button) => mobile ? button.tap() : button.click();
            const assertHeld = async () => { await page.getByText(/^Paused(?: · Live)?$/, { exact: true }).waitFor(); await page.getByText(`${agent.title}'s work is paused`, { exact: true }).waitFor(); await page.getByText('Paused by you. This execution was interrupted; unfinished work is held until Resume. Stop ends the held work.', { exact: true }).waitFor(); await page.getByText('Cancelled', { exact: true }).waitFor(); assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run.id).status, 'cancelled'); };
            const snap = async (n) => { await page.screenshot({ path: out + '/' + cell + '-' + n + '.png' }); await writeFile(out + '/' + cell + '-' + n + '.html', await page.content()); await writeFile(out + '/' + cell + '-' + n + '.txt', await page.locator('body').innerText()); };
            try {
                await page.goto(origin + `/projects/${chat.projectId}/agents/${agent.id}`);
                if (mobile)
                    await page.getByRole('button', { name: 'Expand workspace header', exact: true }).tap();
                const pauseButton = page.getByRole('button', { name: 'Pause', exact: true });
                await pauseButton.waitFor();
                let tabs = 0;
                while (tabs++ < 160 && !await pauseButton.evaluate(e => e === document.activeElement))
                    await page.keyboard.press('Tab');
                assert(tabs < 160);
                await page.keyboard.press('Enter');
                await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
                row.pause = (await f.detail(agent.id)).coordinationV3.pause;
                assert.equal(row.pause.runId, run.id);
                await assertHeld();
                row.checks.push('keyboard Pause binds exact Run; visible hold and unchanged cancelled receipt');
                await snap('paused');
                await page.reload();
                if (mobile)
                    await page.getByRole('button', { name: 'Expand workspace header', exact: true }).tap();
                await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
                assert.equal((await f.detail(agent.id)).coordinationV3.pause.id, row.pause.id);
                assert((await f.detail(agent.id)).messages.some(m => m.text === 'Controlled held task'));
                await assertHeld();
                row.checks.push('reload keeps visible Paused hold, interrupted receipt and human history');
                f.plans.set(agent.id, [{ hold: true }]);
                await press(page.getByRole('button', { name: 'Resume', exact: true }));
                await until(() => { const r = coord.activeAgentRun(agent.id); return r && r.id !== run.id; }, 'new recovery run');
                await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
                row.resumedRun = coord.activeAgentRun(agent.id).id;
                row.checks.push('Resume acknowledged with fresh Run');
                const recoveryRun = coord.activeAgentRun(agent.id);
                coord.failRun({ runId: recoveryRun.id, fencingToken: recoveryRun.fencingToken, workerId: recoveryRun.leaseOwner, sameRunResumable: false, retryable: false, error: 'Controlled provider connection lost' });
                row.unknownReceipt = store.sqlite.prepare('SELECT state,error FROM agent_pause_recoveries WHERE run_id=?').get(recoveryRun.id);
                assert.equal(row.unknownReceipt.state, 'outcome_unknown');
                await page.reload();
                if (mobile)
                    await page.getByRole('button', { name: 'Expand workspace header', exact: true }).tap();
                await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
                await page.getByRole('alert').filter({ hasText: 'Controlled provider connection lost' }).waitFor();
                const response = page.waitForResponse(r => r.url().endsWith('/resume') && r.request().method() === 'POST');
                await press(page.getByRole('button', { name: 'Resume', exact: true }));
                const rejected = await response;
                row.retryRejection = { status: rejected.status(), body: await rejected.json() };
                assert.equal(row.retryRejection.status, 409);
                assert.match(row.retryRejection.body.error, /unknown outcome/);
                await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
                row.visibleAlerts = await page.getByRole('alert').allTextContents();
                assert(row.visibleAlerts.some(s => s.includes('Controlled provider connection lost')));
                assert(row.visibleAlerts.some(s => s.includes('Previous recovery submission has an unknown outcome; inspect it before any retry')));
                row.unknownDiagnosticVisible = true;
                await snap('unknown-after-retry');
                row.checks.push('canonical unknown outcome409 and inspect-before-retry remain visible alongside durable error');
                const stop = page.getByRole('button', { name: 'Stop', exact: true }).filter({ visible: true });
                await page.route('**/api/agents/' + agent.id + '/cancel', async (route) => { row.rejectedStopBody = route.request().postDataJSON(); await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled Stop rejection: observed Run changed' }) }); }, { times: 1 });
                await press(stop);
                await page.getByRole('alert').filter({ hasText: 'Stop failed. Controlled Stop rejection: observed Run changed' }).waitFor();
                row.stopAlerts = await page.getByRole('alert').allTextContents();
                assert(row.stopAlerts.some(s => s.includes('Controlled provider connection lost')));
                assert.equal(row.rejectedStopBody.targetRunId, (await f.detail(agent.id)).coordinationV3.pause.runId);
                assert((await f.detail(agent.id)).coordinationV3.pause);
                row.checks.push('Stop409 remains visible beside durable error; exact target and hold preserved');
                await snap('stop-rejected');
                await press(stop);
                await until(async () => !(await f.detail(agent.id)).coordinationV3.pause, 'Stop supersedes hold');
                await page.getByRole('button', { name: 'Resume', exact: true }).waitFor({ state: 'hidden' });
                row.stopped = await f.detail(agent.id);
                await snap('stopped');
                row.checks.push('Stop clears hold and Resume, history retained');
            }
            catch (e) {
                row.failure = e.stack;
                await snap('failure').catch(e => row.captureFailure = String(e));
            }
            finally {
                store.sqlite.exec('DROP TRIGGER IF EXISTS review_reject');
                await context.close();
                await writeFile(out + '/results.json', JSON.stringify({ rows, requests }, null, 2));
            }
        }
}
finally {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise(r => server ? server.close(r) : r());
    await f.dispose(false);
    await writeFile(out + '/results.json', JSON.stringify({ rows, requests }, null, 2));
}
assert(rows.length === 4 && rows.every(r => !r.failure && r.errors.length === 0), JSON.stringify(rows.map(r => ({ cell: r.cell, failure: r.failure, errors: r.errors }))));
console.log('PASS', rows.map(r => [r.cell, r.checks]));
