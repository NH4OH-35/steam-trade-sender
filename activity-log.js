const fs = require('node:fs');
const path = require('node:path');

const DETAIL_FIELDS = ['slot', 'steamId', 'action', 'count', 'running', 'reason', 'delayMs', 'errorCode'];
const TRANSFER_FIELDS = [
  'key', 'senderSlot', 'senderId', 'receiverId', 'item', 'status', 'offerId',
  'state', 'created', 'attemptedAt', 'acceptRequested', 'autoConfirmed', 'archived',
  'resolution', 'resolvedAt'
];
const ITEM_FIELDS = ['appid', 'contextid', 'assetid', 'name'];

function selectFields(source, fields) {
  const selected = {};
  for (const field of fields) {
    if (source[field] !== undefined) selected[field] = source[field];
  }
  return selected;
}

function transferData(record) {
  const data = selectFields(record, TRANSFER_FIELDS);
  if (record.item !== undefined) data.item = selectFields(record.item, ITEM_FIELDS);
  return data;
}

class ActivityLog {
  constructor(filename) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  write(event, details = {}) {
    const entry = { time: new Date().toISOString(), event, ...selectFields(details, DETAIL_FIELDS) };
    if (details.record) entry.record = transferData(details.record);
    fs.appendFileSync(this.filename, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
}

module.exports = { ActivityLog };
