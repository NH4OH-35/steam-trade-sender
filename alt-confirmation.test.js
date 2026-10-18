const test = require('node:test');
const assert = require('node:assert/strict');
const { AltConfirmation } = require('./alt-confirmation');

const secret = Buffer.alloc(20, 7).toString('base64');
const item = { appid: 730, contextid: '2', assetid: '100', name: 'Test sticker' };

function fixture() {
  const events = [];
  const confirmations = [];
  const accounts = {
    main: { ready: true, steamId: '76561198000000001' },
    alt: { ready: true, steamId: '76561198000000002', confirmOffer: async (identitySecret, offerId, authorized) => {
      if (!authorized()) return false;
      confirmations.push({ identitySecret, offerId });
      return true;
    } }
  };
  let now = 100000;
  const service = new AltConfirmation(accounts, { write: (event, details) => events.push({ event, details }) }, { now: () => now });
  const identities = { main: accounts.main.steamId, alt: accounts.alt.steamId };
  const record = { key: 'queued-item', senderSlot: 'alt', senderId: identities.alt, receiverId: identities.main, status: 'sent', offerId: '77', item };
  const offer = { id: '77', state: 9, isOurOffer: true, partner: { getSteamID64: () => identities.main }, itemsToGive: [item], itemsToReceive: [] };
  return { accounts, service, identities, record, offer, events, confirmations, advance: milliseconds => { now += milliseconds; } };
}

test('auto-confirmation is off by default and only enables for the connected alt/main pair', () => {
  const { service, accounts, identities } = fixture();
  assert.equal(service.publicState().enabled, false);
  assert.throws(() => service.enable('main', secret, identities), /only for Alt/);
  assert.throws(() => service.enable('alt', 'ABCDE', identities), /identity_secret/);
  assert.throws(() => service.enable('alt', secret, { ...identities, main: 'wrong' }), /Accounts changed/);
  accounts.main.ready = false;
  assert.throws(() => service.enable('alt', secret, identities), /Connect two/);
});

test('only the verified queued Alt to Main offer is confirmed; secrets stay out of public state and logs', async () => {
  const { service, identities, record, offer, confirmations, events } = fixture();
  service.enable('alt', secret, identities);
  assert.equal(await service.confirm(record, offer, () => true), true);
  assert.deepEqual(confirmations, [{ identitySecret: secret, offerId: '77' }]);
  assert.deepEqual(service.publicState(), { enabled: true });
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(JSON.stringify(service.publicState()).includes(secret), false);
});

test('outgoing verification rejects main sends, other recipients, items, amounts, states, and requested items', async () => {
  for (const change of [
    { id: '78' }, { state: 2 }, { isOurOffer: false },
    { partner: { getSteamID64: () => 'stranger' } },
    { itemsToGive: [{ ...item, assetid: '200' }] },
    { itemsToGive: [{ ...item, amount: 2 }] },
    { itemsToGive: [item, item] }, { itemsToReceive: [item] }
  ]) {
    const { service, identities, record, offer, confirmations } = fixture();
    service.enable('alt', secret, identities);
    await assert.rejects(service.confirm(record, { ...offer, ...change }, () => true), /does not match/);
    assert.equal(confirmations.length, 0);
  }
  const { service, identities, record, offer, confirmations } = fixture();
  service.enable('alt', secret, identities);
  await assert.rejects(service.confirm({ ...record, senderSlot: 'main' }, offer, () => true), /does not match/);
  await assert.rejects(service.confirm({ ...record, status: 'queued' }, offer, () => true), /does not match/);
  assert.equal(confirmations.length, 0);
});

test('disable or changing either account forgets the secret and prevents confirmation', async () => {
  for (const slot of ['main', 'alt']) {
    const { service, accounts, identities, record, offer, confirmations } = fixture();
    service.enable('alt', secret, identities);
    accounts[slot].steamId = 'different';
    assert.equal(await service.confirm(record, offer, () => true), false);
    assert.equal(service.credentials, null);
    assert.equal(confirmations.length, 0);
  }
  const { service, identities } = fixture();
  service.enable('alt', secret, identities);
  service.disable();
  assert.equal(service.credentials, null);
});

test('confirmation checks are spaced and a missing first offer does not starve the next one', async () => {
  const { service, accounts, identities, record, offer, confirmations, advance } = fixture();
  accounts.alt.confirmOffer = async (identitySecret, offerId) => { confirmations.push(offerId); return false; };
  service.enable('alt', secret, identities);
  await service.confirm(record, offer, () => true);
  await service.confirm(record, offer, () => true);
  assert.deepEqual(confirmations, ['77']);
  advance(10000);
  await service.confirm(record, offer, () => true);
  await service.confirm({ ...record, offerId: '78' }, { ...offer, id: '78' }, () => true);
  assert.deepEqual(confirmations, ['77', '78']);
});

test('pause and disabling while a request is being prepared revoke authorization', async () => {
  const { service, accounts, identities, record, offer, confirmations } = fixture();
  service.enable('alt', secret, identities);
  assert.equal(await service.confirm(record, offer, () => false), false);
  accounts.alt.confirmOffer = async (identitySecret, offerId, authorized) => {
    service.disable();
    assert.equal(authorized(), false);
    return false;
  };
  assert.equal(await service.confirm(record, offer, () => true), false);
  assert.equal(confirmations.length, 0);
});

test('confirmation failures are sanitized and preserve rate-limit detection', async () => {
  const { service, accounts, identities, record, offer, events } = fixture();
  service.enable('alt', secret, identities);
  accounts.alt.confirmOffer = async () => { throw new Error(`HTTP 429 secret=${secret}`); };
  await assert.rejects(service.confirm(record, offer, () => true), error => error.statusCode === 429 && !error.message.includes(secret));
  assert.equal(JSON.stringify(events).includes(secret), false);
});
