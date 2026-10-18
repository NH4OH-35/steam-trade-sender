const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Trader, safeIncoming } = require('./trader');
const { AltConfirmation } = require('./alt-confirmation');
const { transferMessage } = require('./trade-rules');

const item = { appid: 730, contextid: '2', assetid: '100', name: 'Test sticker', tradable: true };
const second = { ...item, assetid: '101' };
const third = { ...item, assetid: '102' };
const fourth = { ...item, assetid: '103' };
const fifth = { ...item, assetid: '104' };
const sixth = { ...item, assetid: '105' };
const allItems = [item, second, third, fourth, fifth, sixth];
const allAssetIds = allItems.map(asset => asset.assetid);

function setup(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-trader-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sent = [];
  const accepted = [];
  let outgoingState = 9;
  const individualStates = new Map();
  const main = {
    ready: true, steamId: '76561198000000001',
    inventory: async () => allItems,
    send: async (receiverId, token, asset) => {
      sent.push({ receiverId, asset });
      return { id: String(1000 + sent.length), status: 'pending' };
    },
    getOffer: async id => ({ id, state: individualStates.get(id) || outgoingState, isOurOffer: true, partner: { getSteamID64: () => alt.steamId }, itemsToGive: [sent[Number(id) - 1001]?.asset || item], itemsToReceive: [] }),
    sentOffers: async records => new Map(await Promise.all(records.map(async record => [record.offerId, await main.getOffer(record.offerId)])))
  };
  const alt = {
    ready: true, steamId: '76561198000000002',
    offerToken: async () => 'test-token',
    getOffer: async id => ({ id, state: 2, isOurOffer: false, partner: { getSteamID64: () => main.steamId }, itemsToGive: [], itemsToReceive: [sent[Number(id) - 1001].asset] }),
    sentOffers: async records => new Map(await Promise.all(records.map(async record => [record.offerId, await alt.getOffer(record.offerId)]))),
    accept: async offer => { accepted.push(offer.id); return 'accepted'; }
  };
  const filename = path.join(directory, 'queue.json');
  const accounts = { main, alt };
  const trader = new Trader(accounts, filename);
  return { trader, accounts, filename, sent, accepted, setState: (value, id) => { if (id) individualStates.set(id, value); else outgoingState = value; } };
}

function reconciliationSetup(context, assets = [item]) {
  const fixture = setup(context);
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  fixture.trader.now = () => now;
  fixture.trader.add('main', assets, assets.map(asset => asset.assetid));
  for (const record of fixture.trader.records) {
    record.status = 'uncertain';
    record.created = new Date(now - 120000).toISOString();
    record.attemptedAt = new Date(now - 30000).toISOString();
  }
  fixture.trader.save();
  const actions = [];
  for (const [slot, account] of Object.entries(fixture.accounts)) {
    for (const operation of ['send', 'accept', 'confirmOffer']) {
      account[operation] = async () => { actions.push(`${slot}:${operation}`); throw new Error('Unexpected trade mutation'); };
    }
  }
  fixture.trader.altConfirmation = {
    enabled: () => true,
    confirm: async () => { actions.push('auto-confirm'); throw new Error('Unexpected automatic confirmation'); }
  };
  return { ...fixture, now, actions };
}

function recoveryOffer(record, changes = {}) {
  return {
    id: record.offerId || '900',
    state: 9,
    isOurOffer: true,
    partner: { getSteamID64: () => record.receiverId },
    itemsToGive: [record.item],
    itemsToReceive: [],
    created: new Date(record.attemptedAt || record.created),
    message: transferMessage(record.key),
    ...changes
  };
}

function returnRecoveryOffers(account, offers) {
  const byId = new Map(offers.map(offer => [String(offer.id), offer]));
  account.sentOffers = async () => byId;
  account.getOffer = async id => {
    if (!byId.has(id)) throw new Error('Steam offer unavailable');
    return byId.get(id);
  };
}

test('fills five outstanding slots, waits at the cap, and refills a completed slot', async context => {
  const fixture = setup(context);
  const { trader, sent, accepted } = fixture;
  trader.add('main', allItems, allAssetIds);
  assert.equal(trader.running, false);
  await trader.tick();
  assert.equal(sent.length, 0);
  trader.resume();
  await trader.tick();
  await trader.tick();
  assert.equal(sent.length, 5);
  assert.equal(trader.records[5].status, 'queued');
  assert.equal(accepted.length, 0);
  fixture.setState(2);
  await trader.tick();
  await trader.tick();
  assert.deepEqual(accepted, ['1001', '1002', '1003', '1004', '1005']);
  assert.equal(sent.length, 5);
  fixture.setState(3, '1002');
  await trader.tick();
  assert.equal(trader.records[1].status, 'completed');
  await trader.tick();
  assert.equal(sent.length, 6);
  assert.equal(trader.records.filter(record => record.status === 'sent').length, 5);
});

test('incoming acceptance rejects changed items, wrong accounts and outgoing demands', () => {
  const record = { offerId: '42', senderId: 'sender', receiverId: 'receiver', item };
  const offer = { id: '42', state: 2, isOurOffer: false, partner: { getSteamID64: () => 'sender' }, itemsToGive: [], itemsToReceive: [item] };
  assert.equal(safeIncoming(offer, record, 'receiver'), true);
  for (const change of [
    { id: '43' }, { state: 9 }, { isOurOffer: true },
    { partner: { getSteamID64: () => 'stranger' } }, { itemsToGive: [item] },
    { itemsToReceive: [second] }, { itemsToReceive: [item, second] },
    { itemsToReceive: [{ ...item, amount: 2 }] },
    { itemsToReceive: [{ ...item, appid: 440 }] },
    { itemsToReceive: [{ ...item, contextid: '3' }] }
  ]) assert.equal(safeIncoming({ ...offer, ...change }, record, 'receiver'), false);
  assert.equal(safeIncoming(offer, record, 'stranger'), false);
});

test('failed verification pauses without accepting or sending another item', async context => {
  const { trader, accounts, sent, accepted, setState } = setup(context);
  trader.add('main', [item, second], ['100', '101']);
  trader.resume();
  await trader.tick();
  setState(2);
  accounts.alt.getOffer = async id => ({ id, state: 2, isOurOffer: false, partner: { getSteamID64: () => 'stranger' }, itemsToGive: [], itemsToReceive: [item] });
  await trader.tick();
  assert.equal(trader.running, false);
  assert.match(trader.error, /verification/);
  assert.equal(sent.length, 2);
  assert.equal(accepted.length, 0);
});

test('uncertain sends persist and cannot be retried on restart', async context => {
  const { trader, accounts, filename } = setup(context);
  accounts.main.send = async () => { throw new Error('timeout'); };
  trader.add('main', [item], ['100']);
  trader.resume();
  await trader.tick();
  assert.equal(trader.records[0].status, 'uncertain');
  const restored = new Trader(accounts, filename);
  assert.equal(restored.running, false);
  assert.throws(() => restored.resume(), /uncertain/);
  await restored.recover(restored.records[0].key, '900');
  assert.equal(restored.records[0].offerId, '900');
  assert.equal(restored.records[0].status, 'sent');
});

test('crash during a send becomes uncertain and wrong recovery offers are rejected', async context => {
  const { trader, accounts, filename } = setup(context);
  trader.add('main', [item], ['100']);
  trader.records[0].status = 'sending';
  trader.save();
  const restored = new Trader(accounts, filename);
  assert.equal(restored.records[0].status, 'uncertain');
  accounts.main.getOffer = async id => ({ id, state: 2, isOurOffer: true, partner: { getSteamID64: () => accounts.alt.steamId }, itemsToGive: [second], itemsToReceive: [] });
  await assert.rejects(restored.recover(restored.records[0].key, '42'), /does not match/);
});

test('reconciliation pauses and reads exact known offer states without performing trades', async context => {
  const { trader, accounts, filename, now, actions } = reconciliationSetup(context, allItems);
  const states = [3, 6, 9, 2];
  for (const [index, state] of states.entries()) {
    trader.records[index].status = 'sent';
    trader.records[index].offerId = String(1001 + index);
  }
  trader.records[4].status = 'queued';
  trader.records[5].status = 'completed';
  trader.records[5].archived = true;
  const queued = structuredClone(trader.records[4]);
  returnRecoveryOffers(accounts.main, states.map((state, index) => recoveryOffer(trader.records[index], { state })));
  trader.running = true;
  await trader.reconcile();
  assert.equal(trader.running, false);
  assert.equal(trader.busy, false);
  assert.deepEqual(trader.records.map(record => record.status), ['completed', 'stopped', 'sent', 'sent', 'queued', 'completed']);
  assert.deepEqual(trader.records[4], queued);
  assert.match(trader.records[0].state, /Accepted/);
  assert.match(trader.records[1].state, /Canceled/);
  assert.equal(trader.nextPollAt, now + 5000);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), trader.records);
  assert.deepEqual(actions, []);
});

test('reconciliation finds the actual sender by SteamID after account slots are swapped', async context => {
  const { trader, accounts, actions } = reconciliationSetup(context);
  const record = trader.records[0];
  record.status = 'sent';
  record.offerId = '42';
  const sender = accounts.main;
  const receiver = accounts.alt;
  [accounts.main, accounts.alt] = [receiver, sender];
  returnRecoveryOffers(sender, [recoveryOffer(record, { state: 3 })]);
  let wrongAccountReads = 0;
  receiver.getOffer = receiver.sentOffers = async () => { wrongAccountReads++; throw new Error('Wrong account queried'); };
  await trader.reconcile();
  assert.equal(record.status, 'completed');
  assert.equal(record.senderSlot, 'main');
  assert.equal(wrongAccountReads, 0);
  assert.deepEqual(actions, []);
});

test('reconciliation refuses a busy operation after pausing and performs no Steam requests', async context => {
  const { trader, accounts, filename } = reconciliationSetup(context);
  let reads = 0;
  accounts.main.getOffer = accounts.main.sentOffers = async () => { reads++; return new Map(); };
  const saved = fs.readFileSync(filename, 'utf8');
  trader.running = true;
  trader.busy = true;
  await assert.rejects(trader.reconcile(), /wait|busy|operation/i);
  assert.equal(trader.running, false);
  assert.equal(reads, 0);
  assert.equal(fs.readFileSync(filename, 'utf8'), saved);
});

test('uncertain reconciliation uses one sender search and links only unique exact offers', async context => {
  const { trader, accounts, actions } = reconciliationSetup(context, [item, second]);
  const offers = [
    recoveryOffer(trader.records[0], { id: '900' }),
    recoveryOffer(trader.records[1], { id: '901', state: 3 }),
    recoveryOffer(trader.records[0], { id: '902', partner: { getSteamID64: () => 'wrong-recipient' } })
  ];
  returnRecoveryOffers(accounts.main, offers);
  let searches = 0;
  accounts.main.sentOffers = async records => {
    searches++;
    assert.equal(records.length, 2);
    return new Map(offers.map(offer => [offer.id, offer]));
  };
  const summary = await trader.reconcile();
  assert.equal(searches, 1);
  assert.equal(summary.linked, 2);
  assert.deepEqual(trader.records.map(record => [record.offerId, record.status]), [['900', 'sent'], ['901', 'completed']]);
  assert.deepEqual(actions, []);
});

test('uncertain reconciliation never reuses an offer ID already tracked in history', async context => {
  const { trader, accounts, actions } = reconciliationSetup(context);
  const record = trader.records[0];
  trader.records.unshift({ ...record, key: 'old-completed', status: 'completed', offerId: '900', archived: true });
  returnRecoveryOffers(accounts.main, [recoveryOffer(record, { id: '900' })]);
  const summary = await trader.reconcile();
  assert.equal(summary.unresolved, 1);
  assert.equal(record.status, 'uncertain');
  assert.equal(record.offerId, null);
  assert.match(record.state, /offer|match|review|uncertain/i);
  assert.deepEqual(actions, []);
});

test('zero or ambiguous recovery matches remain uncertain with review guidance', async context => {
  for (const count of [0, 2]) {
    const { trader, accounts, actions } = reconciliationSetup(context);
    const record = trader.records[0];
    returnRecoveryOffers(accounts.main, Array.from({ length: count }, (_, index) => recoveryOffer(record, { id: String(900 + index) })));
    const summary = await trader.reconcile();
    assert.equal(summary.unresolved, 1);
    assert.equal(record.status, 'uncertain');
    assert.equal(record.offerId, null);
    assert.match(record.state, /offer|match|review|uncertain/i);
    assert.deepEqual(actions, []);
  }
});

test('uncertain matching requires correlation and valid creation times within the recorded attempt window', async context => {
  const cases = [
    { label: 'attempt lower boundary', offset: -90000, matched: true },
    { label: 'before attempt window', offset: -90001, matched: false },
    { label: 'attempt upper boundary', offset: 30000, matched: true },
    { label: 'after attempt window', offset: 30001, matched: false },
    { label: 'current-time upper boundary', attemptOffset: 30000, offset: 60000, matched: true },
    { label: 'beyond current-time upper boundary', attemptOffset: 30000, offset: 60001, matched: false },
    { label: 'missing creation time', missing: true, matched: false },
    { label: 'invalid creation time', invalid: true, matched: false },
    { label: 'legacy missing attempt timestamp', legacy: true, offset: -30000, matched: false },
    { label: 'invalid attempt timestamp', invalidAttempt: true, offset: -30000, matched: false },
    { label: 'wrong correlation message', message: 'Two-account item transfer (another-transfer)', offset: -30000, matched: false },
    { label: 'legacy uncorrelated message', message: 'Two-account item transfer', offset: -30000, matched: false }
  ];
  for (const scenario of cases) {
    const { trader, accounts, now } = reconciliationSetup(context);
    const record = trader.records[0];
    if (scenario.legacy) delete record.attemptedAt;
    if (scenario.invalidAttempt) record.attemptedAt = 'not-a-date';
    if (scenario.attemptOffset !== undefined) record.attemptedAt = new Date(now + scenario.attemptOffset).toISOString();
    const created = scenario.missing ? undefined : scenario.invalid ? new Date(NaN) : new Date(now + scenario.offset);
    const changes = { created };
    if (scenario.message !== undefined) changes.message = scenario.message;
    returnRecoveryOffers(accounts.main, [recoveryOffer(record, changes)]);
    await trader.reconcile();
    assert.equal(record.status, scenario.matched ? 'sent' : 'uncertain', scenario.label);
    assert.equal(record.offerId, scenario.matched ? '900' : null, scenario.label);
  }
});

test('known recovery offers with a wrong recipient or item are rejected without a false completion', async context => {
  for (const changes of [
    { partner: { getSteamID64: () => 'wrong-recipient' } },
    { itemsToGive: [second] },
    { itemsToReceive: [second] },
    { isOurOffer: false }
  ]) {
    const { trader, accounts, actions } = reconciliationSetup(context);
    const record = trader.records[0];
    record.status = 'sent';
    record.offerId = '42';
    returnRecoveryOffers(accounts.main, [recoveryOffer(record, { state: 3, ...changes })]);
    await assert.rejects(trader.reconcile(), /offer|match|verif|check|reconcil/i);
    assert.equal(record.status, 'sent');
    assert.equal(record.offerId, '42');
    assert.notEqual(trader.error, '');
    assert.equal(trader.busy, false);
    assert.deepEqual(actions, []);
  }
});

test('a partial reconciliation failure preserves successful updates and retains an error', async context => {
  const { trader, accounts, filename, actions } = reconciliationSetup(context, [item, second]);
  for (const [index, record] of trader.records.entries()) {
    record.status = 'sent';
    record.offerId = String(42 + index);
  }
  returnRecoveryOffers(accounts.main, [recoveryOffer(trader.records[0], { state: 3 })]);
  await assert.rejects(trader.reconcile(), /offer|check|reconcil|Steam/i);
  assert.equal(trader.records[0].status, 'completed');
  assert.equal(trader.records[1].status, 'sent');
  assert.notEqual(trader.error, '');
  assert.equal(trader.busy, false);
  assert.equal(trader.running, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), trader.records);
  assert.deepEqual(actions, []);
});

test('reconciliation honors rate-limit backoff and prevents repeated manual checks', async context => {
  const { trader, accounts, now: initialTime } = reconciliationSetup(context);
  let now = initialTime;
  trader.now = () => now;
  let checks = 0;
  accounts.main.sentOffers = async () => {
    checks++;
    const error = new Error('HTTP error 429');
    error.response = { headers: { 'retry-after': '60' } };
    throw error;
  };
  await assert.rejects(trader.reconcile());
  assert.equal(trader.nextPollAt, now + 60000);
  await assert.rejects(trader.reconcile());
  assert.equal(checks, 1);
  now = trader.nextPollAt;
  const record = trader.records[0];
  accounts.main.sentOffers = async () => {
    checks++;
    return new Map([['900', recoveryOffer(record)]]);
  };
  await trader.reconcile();
  assert.equal(record.status, 'sent');
  assert.equal(checks, 2);
  assert.equal(trader.nextPollAt, now + 5000);
  await assert.rejects(trader.reconcile());
  assert.equal(checks, 2);
});

test('manual recovery checks legacy offers by exact ID after swapped logins and records terminal states', async context => {
  for (const [state, status] of [[3, 'completed'], [6, 'stopped'], [9, 'sent']]) {
    const { trader, accounts, filename, actions } = reconciliationSetup(context);
    const record = trader.records[0];
    delete record.attemptedAt;
    const sender = accounts.main;
    [accounts.main, accounts.alt] = [accounts.alt, sender];
    returnRecoveryOffers(sender, [recoveryOffer(record, {
      id: '900', state, message: 'Two-account item transfer', created: new Date('2020-01-01T00:00:00.000Z')
    })]);
    await trader.recover(record.key, '900');
    assert.equal(record.offerId, '900');
    assert.equal(record.status, status);
    assert.equal(record.senderSlot, 'main');
    assert.notEqual(record.state, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), trader.records);
    assert.deepEqual(actions, []);
  }
});

test('manual recovery refuses offer IDs already linked to another transfer before contacting Steam', async context => {
  const { trader, accounts, actions } = reconciliationSetup(context);
  const record = trader.records[0];
  trader.records.unshift({ ...record, key: 'linked-history', status: 'completed', offerId: '900', archived: true });
  let reads = 0;
  accounts.main.getOffer = async () => { reads++; throw new Error('Unexpected Steam request'); };
  await assert.rejects(trader.recover(record.key, '900'), /already|linked/i);
  assert.equal(reads, 0);
  assert.equal(record.status, 'uncertain');
  assert.equal(record.offerId, null);
  assert.deepEqual(actions, []);
});

test('user-reported cancellation releases only an orphan reservation and persists its audit history without Steam access', context => {
  const { trader, accounts, filename, now, actions } = reconciliationSetup(context, [item, second, third]);
  const [target, otherUncertain, knownOffer] = trader.records;
  otherUncertain.archived = true;
  knownOffer.status = 'sent';
  knownOffer.offerId = '77';
  knownOffer.archived = true;
  trader.error = 'Uncertain send';
  trader.save();
  const untouched = structuredClone(trader.records.slice(1));
  for (const account of Object.values(accounts)) {
    account.ready = false;
    for (const operation of ['getOffer', 'sentOffers', 'cancel']) {
      account[operation] = async () => { actions.push(operation); throw new Error('Unexpected Steam request'); };
    }
  }
  assert.deepEqual(trader.resolveCanceled(target.key, true), { released: 1, unresolved: 2 });
  assert.equal(target.status, 'stopped');
  assert.equal(target.archived, true);
  assert.equal(target.offerId, null);
  assert.equal(target.state, 'Canceled on Steam (reported by you; not verified by app)');
  assert.equal(target.resolution, 'user_reported_canceled');
  assert.equal(target.resolvedAt, new Date(now).toISOString());
  assert.equal(trader.error, '');
  assert.deepEqual(trader.records.slice(1), untouched);
  assert.equal(trader.reservedCount(), 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), trader.records);
  const logFilename = path.join(path.dirname(filename), 'activity.jsonl');
  const saved = fs.readFileSync(filename, 'utf8');
  const log = fs.readFileSync(logFilename, 'utf8');
  const resolution = log.trim().split('\n').map(line => JSON.parse(line))
    .find(entry => entry.event === 'transfer_resolved_by_user');
  assert.equal(resolution.record.key, target.key);
  assert.equal(resolution.record.resolution, 'user_reported_canceled');
  assert.equal(resolution.record.resolvedAt, target.resolvedAt);
  assert.throws(() => trader.resolveCanceled(target.key, true), /uncertain|offer/i);
  assert.equal(fs.readFileSync(filename, 'utf8'), saved);
  assert.equal(fs.readFileSync(logFilename, 'utf8'), log);
  assert.deepEqual(actions, []);
  for (const account of Object.values(accounts)) account.ready = true;
  assert.throws(() => trader.add('main', [second], ['101']), /unresolved|reserved|offer/i);
  trader.add('main', [item], ['100']);
  assert.equal(trader.records.at(-1).status, 'queued');
  assert.equal(trader.records.at(-1).item.assetid, '100');
});

test('reported cancellation requires acknowledgment and an uncertain record without any known offer ID', context => {
  const cases = [
    { acknowledged: undefined }, { acknowledged: false }, { acknowledged: 'true' },
    { key: 'missing', acknowledged: true },
    ...['queued', 'sent', 'sending', 'completed', 'stopped'].map(status => ({ status, acknowledged: true })),
    { offerId: '77', acknowledged: true }
  ];
  for (const scenario of cases) {
    const { trader, filename } = reconciliationSetup(context);
    const record = trader.records[0];
    if (scenario.status) record.status = scenario.status;
    if (scenario.offerId) record.offerId = scenario.offerId;
    trader.save();
    const saved = fs.readFileSync(filename, 'utf8');
    const before = structuredClone(trader.records);
    assert.throws(() => trader.resolveCanceled(scenario.key || record.key, scenario.acknowledged));
    assert.deepEqual(trader.records, before);
    assert.equal(fs.readFileSync(filename, 'utf8'), saved);
  }
});

test('reported cancellation refuses running or busy work and preserves another active uncertain error', context => {
  for (const flag of ['running', 'busy']) {
    const { trader, filename } = reconciliationSetup(context);
    const saved = fs.readFileSync(filename, 'utf8');
    trader[flag] = true;
    assert.throws(() => trader.resolveCanceled(trader.records[0].key, true), /pause|wait|operation/i);
    assert.equal(trader[flag], true);
    assert.equal(trader.records[0].status, 'uncertain');
    assert.equal(fs.readFileSync(filename, 'utf8'), saved);
  }
  const { trader } = reconciliationSetup(context, [item, second]);
  trader.error = 'Another uncertain send needs review';
  const other = structuredClone(trader.records[1]);
  trader.resolveCanceled(trader.records[0].key, true);
  assert.equal(trader.error, 'Another uncertain send needs review');
  assert.deepEqual(trader.records[1], other);
});

test('pause during preparation prevents sending and clear leaves existing offers intact', async context => {
  const { trader, accounts, sent } = setup(context);
  trader.add('main', allItems, allAssetIds);
  accounts.main.inventory = async () => { trader.pause(); return [item, second]; };
  trader.resume();
  await trader.tick();
  assert.equal(sent.length, 0);
  accounts.main.inventory = async () => allItems;
  trader.resume();
  await trader.tick();
  trader.clear();
  assert.equal(trader.records[0].status, 'sent');
  assert.equal(trader.records[1].status, 'sent');
  assert.equal(trader.records.filter(record => record.status === 'sent').length, 5);
  assert.equal(trader.records[5].status, 'skipped');
  assert.equal(trader.running, false);
});

test('clear queue archives all rows, preserves live transfers, and persists archival across restart', context => {
  const { trader, accounts, filename } = setup(context);
  trader.add('main', [item], ['100']);
  const template = trader.records[0];
  const statuses = ['queued', 'skipped', 'completed', 'stopped', 'sent', 'sending', 'uncertain'];
  trader.records = statuses.map((status, index) => ({
    ...template, key: `record-${status}`, status, offerId: index > 1 ? String(1000 + index) : null
  }));
  trader.save();
  const liveTransfers = structuredClone(trader.records.slice(4)).map(record => ({ ...record, archived: true }));
  trader.running = true;
  trader.clearQueue();
  assert.equal(trader.running, false);
  assert.equal(trader.records.length, statuses.length);
  assert.deepEqual(trader.records.map(record => record.status), [
    'skipped', 'skipped', 'completed', 'stopped', 'sent', 'sending', 'uncertain'
  ]);
  assert.deepEqual(trader.records.slice(4), liveTransfers);
  assert.equal(trader.records.every(record => record.archived), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), trader.records);
  const log = fs.readFileSync(path.join(path.dirname(filename), 'activity.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.find(entry => entry.event === 'queue_cleared').count, statuses.length);
  assert.deepEqual(log.filter(entry => entry.event === 'transfer_updated' && entry.record.archived)
    .map(entry => entry.record.key), statuses.map(status => `record-${status}`));
  const restored = new Trader(accounts, filename);
  assert.equal(restored.running, false);
  assert.equal(restored.records.length, statuses.length);
  assert.deepEqual(restored.records.slice(0, 4), trader.records.slice(0, 4));
  assert.deepEqual(restored.records.slice(4).map(record => ({
    status: record.status, offerId: record.offerId, archived: Boolean(record.archived)
  })), [
    { status: 'sent', offerId: '1004', archived: true },
    { status: 'uncertain', offerId: '1005', archived: true },
    { status: 'uncertain', offerId: '1006', archived: true }
  ]);
});

test('clear queue pauses but refuses to archive while an operation is busy', context => {
  const { trader, filename } = setup(context);
  trader.add('main', allItems, allAssetIds);
  const before = structuredClone(trader.records);
  const savedBefore = fs.readFileSync(filename, 'utf8');
  trader.running = true;
  trader.busy = true;
  assert.throws(() => trader.clearQueue(), /wait|operation|finish/i);
  assert.equal(trader.running, false);
  assert.deepEqual(trader.records, before);
  assert.equal(fs.readFileSync(filename, 'utf8'), savedBefore);
  const log = fs.readFileSync(path.join(path.dirname(filename), 'activity.jsonl'), 'utf8');
  assert.equal(log.includes('queue_cleared'), false);
});

test('clearing detaches unresolved sends, permits other items, and reserves their exact assets', context => {
  for (const status of ['sent', 'sending', 'uncertain']) {
    const { trader } = setup(context);
    trader.add('main', [item, second], ['100', '101']);
    trader.records[0].status = status;
    trader.records[0].offerId = '1001';
    trader.save();
    trader.clearQueue();
    assert.equal(trader.records[0].status, status);
    assert.equal(trader.records[0].offerId, '1001');
    assert.equal(trader.records[0].archived, true);
    assert.equal(trader.records[1].status, 'skipped');
    assert.equal(trader.records[1].archived, true);
    assert.throws(() => trader.add('main', [item], ['100']), /item|offer|reserved/i);
    trader.add('main', [third], ['102']);
    assert.equal(trader.records.at(-1).status, 'queued');
    assert.equal(Boolean(trader.records.at(-1).archived), false);
    trader.resume();
    assert.equal(trader.running, true);
  }
});

test('detached sent offers occupy capacity and are checked without accepting them', async context => {
  const { trader, sent, accepted, setState } = setup(context);
  trader.add('main', allItems, allAssetIds);
  trader.resume();
  await trader.tick();
  trader.clearQueue();
  trader.add('main', [sixth], ['105']);
  trader.resume();
  setState(2);
  await trader.tick();
  assert.equal(sent.length, 5);
  assert.equal(trader.records.at(-1).status, 'queued');
  assert.equal(accepted.length, 0);
  setState(3, '1002');
  await trader.tick();
  assert.equal(trader.records[1].status, 'completed');
  assert.equal(sent.length, 6);
  assert.equal(trader.records.filter(record => record.status === 'sent').length, 5);
  assert.equal(accepted.length, 0);
});

test('detached sending and uncertain records reserve capacity for new batches', async context => {
  for (const status of ['sending', 'uncertain']) {
    const { trader, sent } = setup(context);
    trader.add('main', [item], ['100']);
    trader.records[0].status = status;
    trader.save();
    trader.clearQueue();
    const available = allItems.slice(1);
    trader.add('main', available, available.map(asset => asset.assetid));
    trader.resume();
    await trader.tick();
    assert.equal(trader.running, true);
    assert.equal(sent.length, 4);
    assert.equal(trader.reservedCount(), 5);
    assert.equal(trader.records.at(-1).status, 'queued');
  }
});

test('detached alt offers never trigger automatic confirmation or acceptance', async context => {
  const { trader, accounts } = setup(context);
  let state = 9;
  const actions = [];
  accounts.alt.inventory = async () => [item];
  accounts.main.offerToken = async () => 'main-token';
  accounts.alt.send = async () => ({ id: '77', status: 'pending' });
  accounts.alt.getOffer = async id => ({
    id, state, isOurOffer: true, partner: { getSteamID64: () => accounts.main.steamId },
    itemsToGive: [item], itemsToReceive: []
  });
  accounts.main.accept = async () => { actions.push('accept'); };
  trader.altConfirmation = {
    enabled: () => true,
    confirm: async () => { actions.push('confirm'); return true; }
  };
  trader.add('alt', [item], ['100']);
  trader.resume();
  await trader.tick();
  trader.clearQueue();
  trader.resume();
  await trader.tick();
  state = 2;
  trader.resume();
  await trader.tick();
  assert.equal(trader.records[0].status, 'sent');
  assert.equal(trader.records[0].archived, true);
  assert.deepEqual(actions, []);
});

test('clearing history repeatedly is idempotent and allows a new queue when no offers remain', context => {
  const { trader, filename } = setup(context);
  trader.add('main', allItems, allAssetIds);
  trader.records[0].status = 'completed';
  trader.records[1].status = 'stopped';
  trader.records[2].status = 'skipped';
  trader.save();
  trader.clearQueue();
  const archived = structuredClone(trader.records);
  const saved = fs.readFileSync(filename, 'utf8');
  const logFilename = path.join(path.dirname(filename), 'activity.jsonl');
  const transferUpdates = () => fs.readFileSync(logFilename, 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'transfer_updated');
  const updates = transferUpdates();
  trader.clearQueue();
  assert.deepEqual(trader.records, archived);
  assert.equal(fs.readFileSync(filename, 'utf8'), saved);
  assert.deepEqual(transferUpdates(), updates);
  trader.add('main', [item], ['100']);
  assert.deepEqual(trader.records.slice(0, archived.length), archived);
  assert.equal(trader.records.length, archived.length + 1);
  assert.equal(trader.records.at(-1).status, 'queued');
  assert.equal(Boolean(trader.records.at(-1).archived), false);
});

test('locked items, duplicates, same-account pairing and changed identities are rejected', context => {
  const { trader, accounts } = setup(context);
  assert.throws(() => trader.add('main', [{ ...item, tradable: false }], ['100']), /tradable/);
  assert.throws(() => trader.add('main', [item], ['100', '100']), /unique/);
  trader.add('main', [item], ['100']);
  accounts.alt.steamId = accounts.main.steamId;
  assert.throws(() => trader.resume(), /different/);
  accounts.alt.steamId = '76561198000000003';
  assert.throws(() => trader.resume(), /same main and alt/);
});

test('receiving phone confirmation waits without accepting repeatedly', async context => {
  const { trader, accounts, accepted, setState } = setup(context);
  accounts.alt.accept = async offer => { accepted.push(offer.id); return 'pending'; };
  trader.add('main', [item], ['100']);
  trader.resume();
  await trader.tick();
  setState(2);
  await trader.tick();
  assert.match(trader.records[0].state, /Receiver phone/);
  await trader.tick();
  assert.equal(accepted.length, 1);
  assert.equal(trader.records[0].status, 'sent');
});

test('held and declined trades pause before the next item', async context => {
  for (const state of [7, 11]) {
    const { trader, sent, setState } = setup(context);
    trader.add('main', [item, second], ['100', '101']);
    trader.resume();
    await trader.tick();
    setState(state);
    await trader.tick();
    await trader.tick();
    assert.equal(trader.running, false);
    assert.equal(sent.length, 2);
    assert.equal(trader.records[0].status, 'stopped');
  }
});

test('alt to main uses the main token and accepts with the main account', async context => {
  const { trader, accounts } = setup(context);
  const events = [];
  let state = 9;
  accounts.alt.inventory = async () => [item];
  accounts.main.offerToken = async () => 'main-token';
  accounts.alt.send = async (receiver, token) => {
    events.push(['send', receiver, token]);
    return { id: '77', status: 'pending' };
  };
  accounts.alt.getOffer = async () => ({ state });
  accounts.main.getOffer = async id => ({ id, state: 2, isOurOffer: false, partner: { getSteamID64: () => accounts.alt.steamId }, itemsToGive: [], itemsToReceive: [item] });
  accounts.main.accept = async offer => { events.push(['accept', offer.id]); return 'accepted'; };
  trader.add('alt', [item], ['100']);
  trader.resume();
  await trader.tick();
  state = 2;
  await trader.tick();
  state = 3;
  await trader.tick();
  assert.deepEqual(events, [['send', accounts.main.steamId, 'main-token'], ['accept', '77']]);
  assert.equal(trader.records[0].status, 'completed');
});

test('rate limits back off exponentially, honor Retry-After, and recover automatically', async context => {
  const { trader, accounts, sent, filename } = setup(context);
  let now = 1000000;
  trader.now = () => now;
  trader.add('main', allItems, allAssetIds);
  trader.resume();
  await trader.tick();
  let polls = 0;
  const original = accounts.main.sentOffers;
  accounts.main.sentOffers = async () => {
    polls++;
    const error = new Error('HTTP error 429');
    error.response = { headers: { 'retry-after': '60' } };
    throw error;
  };
  await trader.tick();
  assert.equal(trader.running, true);
  assert.equal(trader.nextPollAt, now + 60000);
  await trader.tick();
  assert.equal(polls, 1);
  now += 60000;
  await trader.tick();
  assert.equal(trader.nextPollAt, now + 120000);
  now += 120000;
  accounts.main.sentOffers = original;
  await trader.tick();
  assert.equal(trader.error, '');
  assert.equal(trader.nextPollAt, 0);
  assert.equal(sent.length, 5);
  const log = fs.readFileSync(path.join(path.dirname(filename), 'activity.jsonl'), 'utf8');
  assert.match(log, /rate_limit_backoff/);
  assert.match(log, /rate_limit_recovered/);
});

test('a rate-limited send remains uncertain and is never automatically resent', async context => {
  const { trader, accounts } = setup(context);
  let sends = 0;
  accounts.main.send = async () => { sends++; throw new Error('HTTP error 429'); };
  trader.add('main', allItems, ['100', '101']);
  trader.resume();
  await trader.tick();
  await trader.tick();
  assert.equal(sends, 1);
  assert.equal(trader.running, false);
  assert.equal(trader.records[0].status, 'uncertain');
  assert.equal(trader.records[1].status, 'queued');
});

test('only one bulk sender check is needed for five waiting offers', async context => {
  const { trader, accounts } = setup(context);
  trader.add('main', allItems, allAssetIds);
  trader.resume();
  await trader.tick();
  let bulkChecks = 0;
  let inventoryLoads = 0;
  accounts.main.inventory = async () => { inventoryLoads++; return allItems; };
  accounts.main.getOffer = async () => { throw new Error('Unexpected per-offer request'); };
  accounts.main.sentOffers = async records => {
    bulkChecks++;
    return new Map(records.map(record => [record.offerId, { state: 9 }]));
  };
  await trader.tick();
  assert.equal(bulkChecks, 1);
  assert.equal(inventoryLoads, 0);
  assert.equal(trader.records.filter(record => record.status === 'sent').length, 5);
  assert.equal(trader.records[5].status, 'queued');
  assert.equal(trader.running, true);
});

test('five outstanding offers survive restart and are not sent again', async context => {
  const { trader, accounts, filename, sent } = setup(context);
  trader.add('main', allItems, allAssetIds);
  trader.resume();
  await trader.tick();
  const restored = new Trader(accounts, filename);
  assert.equal(restored.records.filter(record => record.status === 'sent').length, 5);
  assert.equal(restored.records[5].status, 'queued');
  assert.equal(restored.running, false);
  restored.resume();
  await restored.tick();
  assert.equal(sent.length, 5);
});

test('overlapping ticks cannot send more than five offers', async context => {
  const { trader, accounts, sent } = setup(context);
  trader.add('main', allItems, allAssetIds);
  const original = accounts.main.send;
  let finish;
  accounts.main.send = async (...args) => {
    if (!finish) await new Promise(resolve => { finish = resolve; });
    return original(...args);
  };
  trader.resume();
  const firstTick = trader.tick();
  await new Promise(resolve => setImmediate(resolve));
  await trader.tick();
  assert.equal(trader.busy, true);
  finish();
  await firstTick;
  assert.equal(sent.length, 5);
  assert.equal(trader.records[5].status, 'queued');
});

test('adding a new batch preserves history beyond the former 2,000-record limit', context => {
  const { trader } = setup(context);
  trader.records = Array.from({ length: 2005 }, (_, index) => ({ key: `old-${index}`, status: 'completed', item }));
  trader.add('main', [item], ['100']);
  assert.equal(trader.records.length, 2006);
  assert.equal(trader.records[0].key, 'old-0');
});

test('Alt send is auto-confirmed once, then accepted normally, and saved without the secret', async context => {
  const { trader, accounts, filename } = setup(context);
  let outgoingState = 9;
  const confirmed = [];
  const accepted = [];
  accounts.alt.inventory = async () => [item];
  accounts.main.offerToken = async () => 'main-token';
  accounts.alt.send = async () => ({ id: '77', status: 'pending' });
  accounts.alt.getOffer = async id => ({ id, state: outgoingState, isOurOffer: true, partner: { getSteamID64: () => accounts.main.steamId }, itemsToGive: [item], itemsToReceive: [] });
  accounts.main.getOffer = async id => ({ id, state: 2, isOurOffer: false, partner: { getSteamID64: () => accounts.alt.steamId }, itemsToGive: [], itemsToReceive: [item] });
  accounts.main.accept = async offer => { accepted.push(offer.id); return 'accepted'; };
  accounts.alt.confirmOffer = async (secret, id, authorized) => { assert.equal(authorized(), true); confirmed.push(id); return true; };
  const secret = Buffer.alloc(20, 7).toString('base64');
  trader.altConfirmation = new AltConfirmation(accounts, trader.logger);
  trader.altConfirmation.enable('alt', secret, { main: accounts.main.steamId, alt: accounts.alt.steamId });
  trader.add('alt', [item], ['100']);
  trader.resume();
  await trader.tick();
  await trader.tick();
  await trader.tick();
  assert.deepEqual(confirmed, ['77']);
  assert.equal(trader.records[0].autoConfirmed, true);
  assert.equal(accepted.length, 0);
  outgoingState = 2;
  await trader.tick();
  assert.deepEqual(accepted, ['77']);
  outgoingState = 3;
  await trader.tick();
  assert.equal(trader.records[0].status, 'completed');
  assert.equal(fs.readFileSync(filename, 'utf8').includes(secret), false);
  assert.equal(fs.readFileSync(path.join(path.dirname(filename), 'activity.jsonl'), 'utf8').includes(secret), false);
});

test('enabled alt auto-confirmation never runs for Main to Alt transfers', async context => {
  const { trader, accounts } = setup(context);
  let confirmations = 0;
  accounts.alt.confirmOffer = async () => { confirmations++; return true; };
  trader.altConfirmation = new AltConfirmation(accounts, trader.logger);
  trader.altConfirmation.enable('alt', Buffer.alloc(20, 7).toString('base64'), { main: accounts.main.steamId, alt: accounts.alt.steamId });
  trader.add('main', [item], ['100']);
  trader.resume();
  await trader.tick();
  await trader.tick();
  assert.equal(confirmations, 0);
  assert.equal(trader.records[0].autoConfirmed, undefined);
  assert.equal(trader.records[0].state, 'Phone confirmation required');
});
