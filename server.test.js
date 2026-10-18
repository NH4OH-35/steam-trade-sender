const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpApp } = require('./http-app');

async function availablePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function httpFixture(context) {
  const port = await availablePort();
  const address = `127.0.0.1:${port}`;
  const origin = `http://${address}`;
  const events = [];
  const accounts = Object.fromEntries(['main', 'alt'].map(slot => [slot, {
    steamId: `${slot}-id`,
    publicState: () => ({ slot }),
    inventory: async () => []
  }]));
  const trader = {
    running: false,
    busy: false,
    error: '',
    records: [],
    nextPollAt: 0,
    pause() { this.running = false; },
    add() {}
  };
  const logger = { write: (event, details) => events.push({ event, details }) };
  const altConfirmation = { disable() {}, publicState: () => ({ enabled: false }) };
  const { app, isMutationBusy } = createHttpApp({
    accounts, trader, altConfirmation, logger, address, origin, token: 'test-token'
  });
  const server = await new Promise(resolve => {
    const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
  });
  context.after(() => new Promise(resolve => server.close(resolve)));
  const post = (action, body = {}) => fetch(`${origin}/api/${action}`, {
    method: 'POST',
    headers: { 'X-App-Token': 'test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { accounts, trader, logger, events, post, isMutationBusy, base: origin };
}

test('local server serves dashboard and enforces request token and origin', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-server-test-'));
  const port = await availablePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TRADER_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  context.after(async () => {
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on('data', data => { if (String(data).includes('Steam Trader is ready')) { clearTimeout(timeout); resolve(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Steam Transfer Desk/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy'), /img-src[^;]*https:\/\/community\.steamstatic\.com/);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.accounts.length, 2);
  assert.equal(state.running, false);
  assert.equal(state.maxOutstanding, 5);
  assert.equal(state.pollIntervalMs, 5000);
  assert.deepEqual(state.altAutoConfirmation, { enabled: false });
  const log = await fetch(base + '/api/logs');
  assert.equal(log.status, 200);
  assert.match(await log.text(), /server_started/);
  assert.equal((await fetch(base + '/api/pause', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/api/clear-queue', { method: 'POST' })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/state', { headers: { Host: 'example.com' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await fetch(base + '/api/pause', { method: 'POST', headers: { 'X-App-Token': state.token, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(base + '/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/api/pause', { method: 'POST', headers: { 'X-App-Token': state.token, Origin: base } })).status, 200);
  const resume = await fetch(base + '/api/resume', { method: 'POST', headers: { 'X-App-Token': state.token } });
  assert.equal(resume.status, 400);
  assert.match((await resume.json()).error, /Sign in/);
  const secret = Buffer.alloc(20, 7).toString('base64');
  const enable = await fetch(base + '/api/alt-confirmation', {
    method: 'POST', headers: { 'X-App-Token': state.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: 'main', enabled: true, acknowledged: true, identitySecret: secret })
  });
  assert.equal(enable.status, 400);
  assert.match((await enable.json()).error, /only for Alt/);
  const logsAfterRequest = await (await fetch(base + '/api/logs')).text();
  assert.equal(logsAfterRequest.includes(secret), false);
  const disable = await fetch(base + '/api/alt-confirmation', {
    method: 'POST', headers: { 'X-App-Token': state.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(disable.status, 200);
});

test('reviewed identities and the mutation lock protect asynchronous queue actions', async context => {
  const { accounts, post, isMutationBusy } = await httpFixture(context);
  let inventoryCalls = 0;
  let releaseInventory;
  let inventoryStarted;
  const started = new Promise(resolve => { inventoryStarted = resolve; });
  accounts.main.inventory = () => {
    inventoryCalls++;
    inventoryStarted();
    return new Promise(resolve => { releaseInventory = resolve; });
  };
  const stale = await post('queue', { slot: 'main', identities: { main: 'previous-id', alt: 'alt-id' } });
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /Accounts changed/);
  assert.equal(inventoryCalls, 0);
  const pending = post('queue', { slot: 'main', identities: { main: 'main-id', alt: 'alt-id' }, assetIds: [] });
  await started;
  assert.equal(isMutationBusy(), true);
  const conflict = await post('pause');
  assert.equal(conflict.status, 409);
  releaseInventory([]);
  assert.equal((await pending).status, 200);
  assert.equal(isMutationBusy(), false);
  assert.equal((await post('pause')).status, 200);
});

test('action lookup rejects inherited names and logs only action metadata', async context => {
  const { post, events } = await httpFixture(context);
  const response = await post('toString', { slot: 'main', password: 'secret-password', identitySecret: 'secret-identity' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Unknown action.');
  assert.deepEqual(events, [
    { event: 'action_requested', details: { action: 'unknown', slot: 'main' } },
    { event: 'action_failed', details: undefined }
  ]);
});

test('clear-queue delegates to the trader and state retains archived history', async context => {
  const { trader, post, events, base, isMutationBusy } = await httpFixture(context);
  trader.records = [
    { key: 'old', status: 'completed', archived: true },
    { key: 'pending', status: 'sent', offerId: '1001' }
  ];
  let calls = 0;
  trader.clearQueue = () => { calls++; return { cleared: 1, unresolved: 1 }; };
  const response = await post('clear-queue');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, result: { cleared: 1, unresolved: 1 } });
  assert.equal(calls, 1);
  assert.deepEqual(events, [
    { event: 'action_requested', details: { action: 'clear-queue', slot: undefined } },
    { event: 'action_completed', details: undefined }
  ]);
  const state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state.records, trader.records);
  trader.clearQueue = () => { throw new Error('Wait for the current operation to finish before clearing.'); };
  const busy = await post('clear-queue');
  assert.equal(busy.status, 400);
  assert.match((await busy.json()).error, /current operation/);
  assert.equal(isMutationBusy(), false);
});

test('Steam status checks return their summary and hold the mutation lock until completion', async context => {
  const { trader, post, isMutationBusy, base } = await httpFixture(context);
  let finish;
  let start;
  const started = new Promise(resolve => { start = resolve; });
  trader.reconcile = async () => {
    start();
    await new Promise(resolve => { finish = resolve; });
    return { checked: 2, resolved: 1, linked: 0, unresolved: 1 };
  };
  assert.equal((await fetch(base + '/api/reconcile', { method: 'POST' })).status, 403);
  const pending = post('reconcile');
  await started;
  assert.equal(isMutationBusy(), true);
  assert.equal((await post('clear-queue')).status, 409);
  assert.equal((await post('resolve-canceled', { key: 'orphan', acknowledged: true })).status, 409);
  finish();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, result: { checked: 2, resolved: 1, linked: 0, unresolved: 1 } });
  assert.equal(isMutationBusy(), false);
  trader.reconcile = async () => { throw new Error('Steam is unavailable.'); };
  assert.equal((await post('reconcile')).status, 400);
  assert.equal(isMutationBusy(), false);
});

test('reported cancellation requires the app token and delegates its key and acknowledgment', async context => {
  const { trader, post, base, events, isMutationBusy } = await httpFixture(context);
  const calls = [];
  trader.resolveCanceled = (key, acknowledged) => {
    calls.push({ key, acknowledged });
    return { released: 1, unresolved: 2 };
  };
  assert.equal((await fetch(base + '/api/resolve-canceled', { method: 'POST' })).status, 403);
  const response = await post('resolve-canceled', { key: 'orphan-key', acknowledged: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, result: { released: 1, unresolved: 2 } });
  assert.deepEqual(calls, [{ key: 'orphan-key', acknowledged: true }]);
  assert.equal(events[0].details.action, 'resolve-canceled');
  trader.resolveCanceled = () => { throw new Error('Only an uncertain send without an offer ID can be released.'); };
  const invalid = await post('resolve-canceled', { key: 'known-offer', acknowledged: true });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /without an offer ID/);
  assert.equal(isMutationBusy(), false);
});

test('logging failures return one error response and release the mutation lock', async context => {
  const { logger, post, isMutationBusy } = await httpFixture(context);
  logger.write = event => {
    if (event === 'action_completed' || event === 'action_failed') throw new Error('Log disk full');
  };
  const failed = await post('pause');
  assert.equal(failed.status, 400);
  assert.deepEqual(await failed.json(), { error: 'Log disk full' });
  assert.equal(isMutationBusy(), false);
  logger.write = () => {};
  const retry = await post('pause');
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { ok: true });
});
