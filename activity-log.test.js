const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ActivityLog } = require('./activity-log');

test('activity logs append across restarts and omit credential fields', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-log-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'activity.jsonl');
  const log = new ActivityLog(filename);
  log.write('account_connected', { steamId: '76561198000000001', password: 'secret-password', token: 'secret-token', code: 'ABCDE', qrImage: 'secret-qr', cookies: ['secret-cookie'] });
  new ActivityLog(filename).write('transfer_updated', { record: { key: 'item1', status: 'sent', offerId: '12', password: 'secret-password', item: { appid: 730, contextid: '2', assetid: '100', name: 'sticker', token: 'secret-token' } } });
  const text = fs.readFileSync(filename, 'utf8');
  const entries = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.equal(entries[1].record.offerId, '12');
  assert.equal(entries[1].record.item.assetid, '100');
  assert.equal(text.includes('secret-'), false);
  assert.equal(text.includes('ABCDE'), false);
});

test('user-reported cancellation keeps its unverified resolution and timestamp in the audit log', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-log-resolution-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'activity.jsonl');
  const record = {
    key: 'canceled-record', status: 'stopped', archived: true, offerId: null,
    senderId: 'sender', receiverId: 'receiver',
    state: 'Canceled on Steam (reported by you; not verified by app)',
    resolution: 'user_reported_canceled', resolvedAt: '2026-10-17T12:00:00.000Z',
    item: { appid: 730, contextid: '2', assetid: '100', name: 'Sticker' },
    token: 'private-token'
  };
  new ActivityLog(filename).write('transfer_resolved_by_user', { record });
  const entry = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(entry.event, 'transfer_resolved_by_user');
  assert.equal(entry.record.resolution, record.resolution);
  assert.equal(entry.record.resolvedAt, record.resolvedAt);
  assert.equal(entry.record.state, record.state);
  assert.equal(entry.record.item.assetid, '100');
  assert.equal(Object.hasOwn(entry.record, 'token'), false);
});
