const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

class Element {
  constructor(tag, registry) {
    this.tagName = tag;
    this.registry = registry;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.content = '';
  }

  set id(value) {
    this.registry.set(value, this);
  }

  get textContent() {
    return this.content + this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    this.content = String(value);
    this.children = [];
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.content = '';
    this.children = children;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async trigger(type) {
    for (const listener of this.listeners.get(type) || []) {
      await listener({ preventDefault() {} });
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

function initialState(overrides = {}) {
  return {
    token: 'test-token',
    running: false,
    busy: false,
    error: '',
    maxOutstanding: 5,
    altAutoConfirmation: { enabled: false },
    accounts: [
      { slot: 'main', steamId: 'sender-id', ready: true, status: 'Connected' },
      { slot: 'alt', steamId: 'receiver-id', ready: true, status: 'Connected' }
    ],
    records: [],
    ...overrides
  };
}

function item(assetid, overrides = {}) {
  return { appid: 730, contextid: '2', assetid, name: assetid, tradable: true, ...overrides };
}

function record(name, overrides = {}) {
  return {
    key: name,
    senderSlot: 'main',
    senderId: 'sender-id',
    receiverId: 'receiver-id',
    item: item(name),
    status: 'sent',
    offerId: `offer-${name}`,
    ...overrides
  };
}

async function frontendFixture(snapshot = initialState(), inventory = []) {
  const registry = new Map();
  for (const match of page.matchAll(/<([\w-]+)([^>]*\sid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1], registry);
    element.id = match[3];
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
  }
  registry.get('direction').value = 'main';

  let serverState = snapshot;
  const routes = new Map();
  const calls = [];
  const confirmations = [];
  let confirmResult = true;
  const context = vm.createContext({
    document: {
      hidden: false,
      getElementById: id => registry.get(id) || null,
      createElement: tag => new Element(tag, registry)
    },
    window: {
      confirm(text) {
        confirmations.push(text);
        return confirmResult;
      },
      prompt: () => null
    },
    async fetch(url, options = {}) {
      calls.push({ url, ...options });
      let response;
      if (routes.has(url)) response = await routes.get(url)(options);
      else if (url === '/api/state') response = serverState;
      else if (url === '/api/inventory/main') response = inventory;
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => JSON.parse(JSON.stringify(response)) };
    },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1
  });
  vm.runInContext(script, context, { filename: 'public/app.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registry.get('connection').textContent, 'Local connection');

  return {
    calls,
    confirmations,
    get: id => registry.get(id),
    click: id => registry.get(id).trigger('click'),
    respond: (url, handler) => routes.set(url, handler),
    setState(next) { serverState = next; },
    setConfirmation(value) { confirmResult = value; },
    refresh: () => vm.runInContext('refresh()', context)
  };
}

test('dashboard separates archived unresolved offers from the active queue', async () => {
  const snapshot = initialState({ records: [
    record('new-item', { status: 'queued', offerId: null }),
    record('active-unknown', { status: 'uncertain', offerId: null }),
    record('archived-pending', { archived: true }),
    record('archived-unknown', { archived: true, status: 'uncertain', offerId: null }),
    record('archived-finished', { archived: true, status: 'completed' })
  ] });
  const app = await frontendFixture(snapshot);
  assert.match(app.get('records').textContent, /new-item/);
  assert.match(app.get('records').textContent, /active-unknown/);
  assert.doesNotMatch(app.get('records').textContent, /archived-/);
  assert.match(app.get('tracked-records').textContent, /archived-pending/);
  assert.match(app.get('tracked-records').textContent, /archived-unknown/);
  assert.doesNotMatch(app.get('tracked-records').textContent, /archived-finished/);
  assert.equal(app.get('tracked-count').textContent, '2 unresolved');
  assert.equal(app.get('tracked-section').hidden, false);

  app.setState({ ...snapshot, records: snapshot.records.filter(saved => saved.archived) });
  await app.refresh();
  assert.equal(app.get('records').textContent, 'No queued transfers to show.');
});

test('dashboard direction labels follow SteamIDs when dashboard slots swap', async () => {
  const snapshot = initialState({ records: [record('pending', { archived: true })] });
  const app = await frontendFixture(snapshot);
  assert.match(app.get('tracked-records').textContent, /Main \(sender-id\) → Alt \(receiver-id\)/);

  app.setState({ ...snapshot, accounts: [
    { ...snapshot.accounts[0], steamId: 'receiver-id' },
    { ...snapshot.accounts[1], steamId: 'sender-id' }
  ] });
  await app.refresh();
  assert.match(app.get('tracked-records').textContent, /Alt \(sender-id\) → Main \(receiver-id\)/);
  assert.doesNotMatch(app.get('tracked-records').textContent, /Main \(sender-id\)/);
});

test('inventory reserves exact unresolved items and bulk selection prunes them', async () => {
  const items = [
    item('reserved-sent'), item('reserved-sending'), item('reserved-uncertain'),
    item('different-sender'), item('different-app'), item('different-context'),
    item('finished'), item('free'), item('locked', { tradable: false })
  ];
  const app = await frontendFixture(initialState(), items);
  await app.click('load');
  await app.click('select');
  assert.equal(app.get('count').textContent, '8 selected · 8 separate offers');

  app.setState(initialState({ records: [
    record('reserved-sent', { archived: true }),
    record('reserved-sending', { status: 'sending' }),
    record('reserved-uncertain', { archived: true, status: 'uncertain', offerId: null }),
    record('different-sender', { senderId: 'receiver-id' }),
    record('different-app', { item: item('different-app', { appid: 440 }) }),
    record('different-context', { item: item('different-context', { contextid: '1' }) }),
    record('finished', { status: 'completed' })
  ] }));
  await app.refresh();
  assert.equal(app.get('count').textContent, '5 selected · 5 separate offers');
  for (const assetid of ['reserved-sent', 'reserved-sending', 'reserved-uncertain']) {
    const card = app.get('inventory').children.find(child => child.textContent.startsWith(assetid));
    assert.equal(card.children[0].disabled, true);
    assert.equal(card.children[0].checked, false);
    assert.match(card.textContent, /Already tracked in Steam offers/);
  }
  for (const assetid of ['different-sender', 'different-app', 'different-context', 'finished', 'free']) {
    const card = app.get('inventory').children.find(child => child.textContent.startsWith(assetid));
    assert.equal(card.children[0].disabled, false);
    assert.equal(card.children[0].checked, true);
  }
  await app.click('deselect');
  await app.click('select');
  assert.equal(app.get('count').textContent, '5 selected · 5 separate offers');
});

test('clear queue reports the unresolved count returned by the server', async () => {
  const app = await frontendFixture(initialState());
  app.respond('/api/clear-queue', () => ({ ok: true, result: { cleared: 4, unresolved: 2 } }));
  await app.click('clear-queue');
  assert.match(app.get('message').textContent, /2 unresolved Steam offers remain tracked, not canceled/);
  assert.match(app.get('message').textContent, /You can queue other items/);
  assert.match(app.confirmations[0], /not canceled, automatically accepted, or confirmed/);
  assert.equal(app.get('clear-queue').disabled, false);
  const request = app.calls.find(call => call.url === '/api/clear-queue');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['X-App-Token'], 'test-token');
  assert.equal(request.body, '{}');
});

test('Steam status check pauses with consent and reports response counts without trading', async () => {
  const app = await frontendFixture(initialState({ running: true }));
  let finishCheck;
  app.respond('/api/reconcile', () => new Promise(resolve => { finishCheck = resolve; }));
  const pending = app.click('reconcile');
  assert.equal(app.get('reconcile').disabled, true);
  assert.match(app.confirmations[0], /Pause the queue and check Steam status/);
  app.setState(initialState());
  finishCheck({ ok: true, result: { checked: 5, resolved: 2, linked: 1, unresolved: 3 } });
  await pending;
  assert.equal(app.get('reconcile-result').hidden, false);
  assert.match(app.get('reconcile-result').textContent, /Checked 5 offers: 2 resolved, 1 linked, 3 still unresolved/);
  assert.match(app.get('reconcile-result').textContent, /No trades were sent, accepted, confirmed, or canceled/);
  assert.equal(app.get('queue-status').textContent, 'Paused');
  assert.equal(app.get('reconcile').disabled, false);
  assert.deepEqual(app.calls.filter(call => call.method === 'POST').map(call => call.url), ['/api/reconcile']);
});

test('declining the status check leaves a running queue untouched', async () => {
  const app = await frontendFixture(initialState({ running: true }));
  app.setConfirmation(false);
  await app.click('reconcile');
  assert.equal(app.get('queue-status').textContent, 'Running');
  assert.equal(app.calls.some(call => call.method === 'POST'), false);
});

test('no-ID cancellation requires confirmation and posts the exact saved key without login', async () => {
  const unknown = record('gamerlegion', { key: 'saved-unknown-key', status: 'uncertain', offerId: null, archived: true });
  const snapshot = initialState({
    records: [unknown],
    accounts: initialState().accounts.map(account => ({ ...account, steamId: null, ready: false, status: 'Signed out' }))
  });
  const app = await frontendFixture(snapshot);
  const controls = app.get('tracked-records').children[0].children[2];
  assert.equal(controls.className, 'record-actions');
  assert.deepEqual(controls.children.map(button => button.textContent), ['Link sent offer', 'I canceled this offer']);
  const [link, canceled] = controls.children;
  assert.equal(canceled.disabled, false);

  let finishCorrection;
  app.respond('/api/resolve-canceled', () => new Promise(resolve => { finishCorrection = resolve; }));
  const pending = canceled.trigger('click');
  assert.equal(link.disabled, true);
  assert.equal(canceled.disabled, true);
  assert.match(app.confirmations[0], /gamerlegion/);
  assert.match(app.confirmations[0], /asset gamerlegion, sender SteamID sender-id/);
  assert.match(app.confirmations[0], /cannot verify it without an offer ID/);
  assert.match(app.confirmations[0], /does not cancel, send, or retry anything/);
  app.setState({ ...snapshot, records: [{ ...unknown, status: 'stopped', state: 'Canceled (reported by user)' }] });
  finishCorrection({ ok: true });
  await pending;

  const requests = app.calls.filter(call => call.method === 'POST');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/resolve-canceled');
  assert.equal(requests[0].headers['X-App-Token'], 'test-token');
  assert.deepEqual(JSON.parse(requests[0].body), { key: 'saved-unknown-key', acknowledged: true });
  assert.equal(app.get('tracked-section').hidden, true);
  assert.equal(app.get('outstanding').textContent, '0 / 5 outstanding');
  assert.equal(app.get('message').textContent, 'Marked canceled based on your confirmation. Item reservation released; history kept. Reload inventory.');
});

test('declining a no-ID cancellation sends no request', async () => {
  const app = await frontendFixture(initialState({ records: [record('unknown', { status: 'uncertain', offerId: null })] }));
  app.setConfirmation(false);
  const controls = app.get('records').children[0].children[2];
  await controls.children[1].trigger('click');
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.calls.some(call => call.method === 'POST'), false);
  assert.equal(controls.children[0].disabled, false);
  assert.equal(controls.children[1].disabled, false);
});

test('no-ID recovery controls stay disabled while running or busy and update when paused', async () => {
  const snapshot = initialState({ running: true, records: [record('unknown', { status: 'uncertain', offerId: null })] });
  const app = await frontendFixture(snapshot);
  for (const activity of [{ running: true, busy: false }, { running: false, busy: true }]) {
    app.setState({ ...snapshot, ...activity });
    await app.refresh();
    const controls = app.get('records').children[0].children[2];
    assert.equal(controls.children[0].disabled, true);
    assert.equal(controls.children[1].disabled, true);
    await controls.children[1].trigger('click');
  }
  assert.equal(app.calls.some(call => call.method === 'POST'), false);
  assert.equal(app.confirmations.length, 0);

  app.setState({ ...snapshot, running: false, busy: false });
  await app.refresh();
  const controls = app.get('records').children[0].children[2];
  assert.equal(controls.children[0].disabled, false);
  assert.equal(controls.children[1].disabled, false);
});

test('offers with a known ID never expose the user-reported cancellation button', async () => {
  const app = await frontendFixture(initialState({ records: [
    record('known-pending'),
    record('known-uncertain', { status: 'uncertain', archived: true })
  ] }));
  for (const container of [app.get('records'), app.get('tracked-records')]) {
    const row = container.children[0];
    assert.equal(row.children[2].tagName, 'a');
    assert.doesNotMatch(row.textContent, /I canceled this offer/);
    assert.doesNotMatch(row.textContent, /Link sent offer/);
  }
});
