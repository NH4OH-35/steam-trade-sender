const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Account } = require('./accounts');

function fixture() {
  const sessions = [];
  const account = new Account('main', {
    createQrSession: () => {
      const session = new EventEmitter();
      session.startWithQR = async () => ({ qrChallengeUrl: 'https://s.team/q/test' });
      session.cancelLoginAttempt = () => { session.canceled = true; };
      session.refreshToken = 'private-test-refresh-token';
      sessions.push(session);
      return session;
    },
    encodeQr: async () => 'data:image/png;base64,test'
  });
  const logins = [];
  account.connect = details => { logins.push(details); };
  return { account, sessions, logins };
}

test('QR approval connects using a refresh token without exposing it in public state', async () => {
  const { account, sessions, logins } = fixture();
  await account.loginWithQR();
  assert.equal(account.publicState().qrPending, true);
  assert.match(account.publicState().qrImage, /^data:image\/png/);
  assert.equal(account.publicState().needsCode, false);
  assert.equal(sessions[0].loginTimeout, 120000);
  sessions[0].emit('remoteInteraction');
  assert.match(account.status, /Approve/);
  sessions[0].emit('authenticated');
  assert.deepEqual(logins, [{ refreshToken: 'private-test-refresh-token' }]);
  assert.equal(account.publicState().qrPending, false);
  assert.equal(account.publicState().qrImage, '');
  assert.equal(JSON.stringify(account.publicState()).includes('private-test-refresh-token'), false);
});

test('logout and QR replacement cancel old sessions and ignore late approvals', async () => {
  const { account, sessions, logins } = fixture();
  await account.loginWithQR();
  await account.loginWithQR();
  assert.equal(sessions[0].canceled, true);
  sessions[0].emit('authenticated');
  assert.equal(logins.length, 0);
  assert.equal(account.publicState().qrPending, true);
  account.logout();
  sessions[1].emit('authenticated');
  assert.equal(logins.length, 0);
  assert.equal(sessions[1].canceled, true);
  assert.equal(account.publicState().qrImage, '');
});

test('expiration and network errors remove the QR and allow retry', async () => {
  const { account, sessions } = fixture();
  await account.loginWithQR();
  sessions[0].emit('timeout');
  assert.equal(account.publicState().qrPending, false);
  assert.equal(account.publicState().qrImage, '');
  assert.match(account.status, /expired/);
  await account.loginWithQR();
  sessions[1].emit('error', new Error('network failed'));
  assert.match(account.status, /failed/);
  assert.equal(account.publicState().qrImage, '');
});

test('failed QR creation cleans up instead of leaving an active attempt', async () => {
  const { account, sessions } = fixture();
  const factory = account.createQrSession;
  account.createQrSession = () => {
    const session = factory();
    session.startWithQR = async () => { throw new Error('offline'); };
    return session;
  };
  await assert.rejects(account.loginWithQR(), /Could not create/);
  assert.equal(account.publicState().qrPending, false);
  assert.equal(sessions[0].canceled, true);
});

test('logout while QR encoding is pending cannot restore a canceled QR', async () => {
  const { account } = fixture();
  let finishEncoding;
  account.encodeQr = () => new Promise(resolve => { finishEncoding = resolve; });
  const pending = account.loginWithQR();
  await new Promise(resolve => setImmediate(resolve));
  account.logout();
  finishEncoding('data:image/png;base64,stale');
  await pending;
  assert.equal(account.publicState().qrImage, '');
  assert.equal(account.status, 'Signed out');
});

test('sent offers use one bulk request with a cutoff covering tracked transfers', async () => {
  const { account } = fixture();
  let requests = 0;
  account.manager = { getOffers: (filter, cutoff, callback) => {
    requests++;
    assert.equal(filter, 3);
    assert.equal(cutoff.toISOString(), '2026-10-16T09:59:00.000Z');
    callback(null, [{ id: '100', state: 9 }, { id: '101', state: 3 }], []);
  } };
  const result = await account.sentOffers([{ created: '2026-10-16T10:00:00.000Z' }, { created: '2026-10-16T11:00:00.000Z' }]);
  assert.equal(requests, 1);
  assert.equal(result.get('100').state, 9);
  assert.equal(result.get('101').state, 3);
});

test('inventory thumbnails use the current Steam CDN with a bounded image size', async () => {
  const account = new Account('alt');
  account.ready = true;
  account.manager = {
    getInventoryContents: (appid, contextid, tradableOnly, callback) => callback(null, [
      { assetid: '100', name: 'Sticker', tradable: true, icon_url: 'steam-image-hash' },
      { assetid: '101', name: 'Item without an image', tradable: false }
    ])
  };
  const inventory = await account.inventory();
  assert.equal(inventory[0].icon, 'https://community.steamstatic.com/economy/image/steam-image-hash/256fx256f');
  assert.equal(inventory[0].tradable, true);
  assert.equal(inventory[1].icon, '');
});

test('new sends include a per-transfer recovery marker without requesting recipient items', async () => {
  const account = new Account('main');
  const item = { appid: 730, contextid: '2', assetid: '100' };
  const events = [];
  account.manager = {
    createOffer: (receiverId, token) => {
      events.push({ receiverId, token });
      return {
        id: '900',
        addMyItem: asset => events.push(asset),
        setMessage: message => events.push(message),
        send: callback => callback(null, 'pending')
      };
    }
  };
  const result = await account.send('receiver', 'test-token', item, 'record-key');
  assert.deepEqual(result, { id: '900', status: 'pending' });
  assert.deepEqual(events, [
    { receiverId: 'receiver', token: 'test-token' },
    { ...item, amount: 1 },
    'Two-account item transfer (record-key)'
  ]);
});

function confirmationAccount() {
  const responses = [];
  const keys = {
    getTimeOffset: callback => callback(null, 0), time: () => 100,
    getConfirmationKey: (secret, time, tag) => `${tag}-${time}`
  };
  const account = new Account('alt', { confirmationKeys: keys });
  account.ready = true;
  account.steamId = '76561198000000002';
  const confirmation = (type, creator) => ({ type, creator, respond: (time, key, accept, callback) => { responses.push({ type, creator, accept, time }); callback(null); } });
  account.community = { getConfirmations: (time, key, callback) => callback(null, [confirmation(3, '77'), confirmation(2, '88'), confirmation(2, '77')]) };
  return { account, responses };
}

test('specific confirmation ignores Market listings and unrelated trades, even with matching creator IDs', async () => {
  const { account, responses } = confirmationAccount();
  assert.equal(await account.confirmOffer('test-secret', '77', () => true), true);
  assert.deepEqual(responses, [{ type: 2, creator: '77', accept: true, time: 100 }]);
  assert.equal(await account.confirmOffer('test-secret', '77', () => true), true);
  assert.equal(responses[1].time, 101);
});

test('a missing confirmation waits without accepting anything else', async () => {
  const { account, responses } = confirmationAccount();
  assert.equal(await account.confirmOffer('test-secret', '99', () => true), false);
  assert.equal(responses.length, 0);
});

test('main account confirmation and authorization revoked during confirmation lookup are blocked', async () => {
  const { account, responses } = confirmationAccount();
  account.slot = 'main';
  await assert.rejects(account.confirmOffer('test-secret', '77', () => true), /Alt account/);
  account.slot = 'alt';
  let allowed = true;
  const original = account.community.getConfirmations;
  account.community.getConfirmations = (...args) => { allowed = false; original(...args); };
  assert.equal(await account.confirmOffer('test-secret', '77', () => allowed), false);
  assert.equal(responses.length, 0);
});
