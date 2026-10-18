const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ActivityLog } = require('./activity-log');

const {
  MAX_OUTSTANDING,
  POLL_INTERVAL,
  OFFER_STATE,
  oppositeSlot,
  offerStateLabel,
  transferMessage,
  isTerminalState,
  sameItem,
  safeIncoming,
  safeOutgoing
} = require('./trade-rules');
const { rateLimited, retryDelay } = require('./retry-policy');

const RESERVED_STATUSES = new Set(['sent', 'sending', 'uncertain']);

class Trader {
  constructor(accounts, filename, options = {}) {
    this.accounts = accounts;
    this.filename = filename;
    this.running = false;
    this.busy = false;
    this.error = '';
    this.now = options.now || Date.now;
    this.logger = options.logger || new ActivityLog(path.join(path.dirname(filename), 'activity.jsonl'));
    this.altConfirmation = options.altConfirmation;
    this.nextPollAt = 0;
    this.backoffMs = 0;
    this.savedRecords = new Map();
    this.records = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
    if (!Array.isArray(this.records)) throw new Error('Invalid queue file. Restore a valid backup.');
    for (const record of this.records) {
      if (record.status === 'sending') record.status = 'uncertain';
    }
    this.save();
    this.logger.write('queue_loaded', { count: this.records.length });
  }

  save() {
    const serialized = JSON.stringify(this.records, null, 2);
    if (serialized === this.lastSaved) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(this.filename + '.tmp', serialized, { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
    for (const record of this.records) {
      const value = JSON.stringify(record);
      if (this.savedRecords.get(record.key) !== value) {
        this.logger.write('transfer_updated', { record });
        this.savedRecords.set(record.key, value);
      }
    }
    this.lastSaved = serialized;
  }

  pair() {
    const [main, alt] = [this.accounts.main, this.accounts.alt];
    if (!main.ready || !alt.ready) throw new Error('Sign in to both accounts first.');
    if (main.steamId === alt.steamId) throw new Error('Use two different Steam accounts.');
    return [main, alt];
  }

  accountsFor(slot) {
    return { sender: this.accounts[slot], receiver: this.accounts[oppositeSlot(slot)] };
  }

  recordAccounts(record, message = 'Account mismatch.') {
    const accounts = this.accountsFor(record.senderSlot);
    if (accounts.sender.steamId !== record.senderId || accounts.receiver.steamId !== record.receiverId) {
      throw new Error(message);
    }
    return accounts;
  }

  recordedIdentities(record) {
    const sender = Object.values(this.accounts).find(account => account.ready && account.steamId === record.senderId);
    const receiver = Object.values(this.accounts).find(account => account.ready && account.steamId === record.receiverId);
    if (!sender || !receiver || sender === receiver) {
      throw new Error('Sign in to both SteamIDs shown on the tracked offer before checking it.');
    }
    return { sender, receiver };
  }

  outstanding() {
    return this.records.filter(record => record.status === 'sent');
  }

  hasUncertainSend() {
    return this.records.some(record => !record.archived && ['sending', 'uncertain'].includes(record.status));
  }

  reservedCount() {
    return this.records.filter(record => RESERVED_STATUSES.has(record.status)).length;
  }

  add(senderSlot, inventory, assetIds) {
    this.pair();
    if (this.busy || this.running || this.records.some(record => !record.archived && ['queued', 'sending', 'uncertain', 'sent'].includes(record.status))) {
      throw new Error('Clear the current queue before creating another batch. Unresolved Steam offers will stay tracked separately.');
    }
    const { sender, receiver } = this.accountsFor(senderSlot);
    if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 1000 || new Set(assetIds).size !== assetIds.length) {
      throw new Error('Select between 1 and 1,000 unique items.');
    }
    const selected = assetIds.map(assetId => {
      const item = inventory.find(candidate => candidate.assetid === assetId && candidate.tradable);
      if (!item) throw new Error('An item is no longer tradable. Reload inventory.');
      if (this.records.some(record => RESERVED_STATUSES.has(record.status)
        && record.senderId === sender.steamId && sameItem(item, record.item))) {
        throw new Error('A selected item is already in an unresolved Steam offer. Check Steam status, then reload inventory and choose other items.');
      }
      return item;
    });
    this.records = this.records.concat(selected.map(item => ({
      key: crypto.randomUUID(), senderSlot, senderId: sender.steamId, receiverId: receiver.steamId,
      item: { appid: item.appid, contextid: item.contextid, assetid: item.assetid, name: item.name },
      status: 'queued', offerId: null, state: null, created: new Date().toISOString()
    })));
    this.error = '';
    this.save();
    this.logger.write('queue_created', { slot: senderSlot, count: selected.length });
  }

  resume() {
    this.pair();
    if (this.hasUncertainSend()) throw new Error('Resolve the uncertain send using Check Steam status or Link sent offer, or clear this queue to trade other items.');
    for (const record of this.records.filter(candidate => !candidate.archived && ['queued', 'sent'].includes(candidate.status))) {
      this.recordAccounts(record, 'Sign in to the same main and alt accounts used to create this queue.');
    }
    this.error = '';
    this.running = true;
    this.logger.write('queue_resumed');
  }

  pause() {
    if (this.running) this.logger.write('queue_paused');
    this.running = false;
  }

  clear() {
    this.pause();
    for (const record of this.records) if (record.status === 'queued') record.status = 'skipped';
    this.save();
  }

  clearQueue() {
    this.pause();
    if (this.busy) {
      throw new Error('Queue paused. Wait for the current operation to finish, then clear the transfer queue again.');
    }
    let count = 0;
    for (const record of this.records) {
      if (record.archived) continue;
      if (record.status === 'queued') record.status = 'skipped';
      record.archived = true;
      count++;
    }
    this.error = '';
    this.save();
    this.logger.write('queue_cleared', { count });
    return { cleared: count, unresolved: this.reservedCount() };
  }

  async recover(key, offerId) {
    if (this.busy || this.running) throw new Error('Pause and wait for the current operation first.');
    this.pair();
    const record = this.records.find(candidate => candidate.key === key && candidate.status === 'uncertain');
    if (!record || !/^\d+$/.test(offerId)) throw new Error('Enter the matching sent offer ID from Steam.');
    if (this.records.some(candidate => candidate !== record && String(candidate.offerId) === offerId)) {
      throw new Error('That Steam offer is already linked to another transfer.');
    }
    const { sender } = this.recordedIdentities(record);
    const offer = await sender.getOffer(offerId);
    if (!safeOutgoing(offer, record, offerId)) {
      throw new Error('This offer does not match the queued transfer.');
    }
    record.offerId = String(offer.id);
    this.updateCheckedState(record, offer);
    this.save();
  }

  resolveCanceled(key, acknowledged) {
    if (this.running || this.busy) throw new Error('Pause and wait for the current operation first.');
    if (acknowledged !== true) throw new Error('Confirm that you canceled this offer on Steam and it is no longer active.');
    const record = this.records.find(candidate => candidate.key === key);
    if (!record || record.status !== 'uncertain' || record.offerId) {
      throw new Error('Only an uncertain send without an offer ID can be resolved this way. Use Check Steam status for known offers.');
    }
    record.status = 'stopped';
    record.archived = true;
    record.state = 'Canceled on Steam (reported by you; not verified by app)';
    record.resolution = 'user_reported_canceled';
    record.resolvedAt = new Date(this.now()).toISOString();
    if (!this.hasUncertainSend()) this.error = '';
    this.save();
    this.logger.write('transfer_resolved_by_user', { record });
    return { released: 1, unresolved: this.reservedCount() };
  }

  updateCheckedState(record, offer) {
    record.state = offerStateLabel(offer.state);
    record.status = isTerminalState(offer.state)
      ? offer.state === OFFER_STATE.Accepted ? 'completed' : 'stopped'
      : 'sent';
  }

  recoveryCandidates(record, offers) {
    const attempted = Date.parse(record.attemptedAt);
    if (!Number.isFinite(attempted)) return [];
    const knownIds = new Set(this.records.filter(candidate => candidate.offerId).map(candidate => String(candidate.offerId)));
    return [...offers.values()].filter(offer => {
      const created = offer.created instanceof Date ? offer.created.getTime() : Date.parse(offer.created);
      return /^\d+$/.test(String(offer.id)) && !knownIds.has(String(offer.id))
        && Number.isFinite(created) && created >= attempted - 60000 && created <= Math.min(attempted + 60000, this.now() + 60000)
        && offer.message === transferMessage(record.key)
        && safeOutgoing(offer, record, String(offer.id));
    });
  }

  async reconcile() {
    this.pause();
    if (this.busy) throw new Error('Wait for the current operation to finish, then check Steam status again.');
    if (this.now() < this.nextPollAt) throw new Error(`Wait until ${new Date(this.nextPollAt).toLocaleTimeString()} before checking Steam again.`);
    this.pair();
    this.busy = true;
    const summary = { checked: 0, resolved: 0, linked: 0, unresolved: 0 };
    let failure;
    try {
      const pending = this.records.filter(record => RESERVED_STATUSES.has(record.status));
      for (const senderId of new Set(pending.map(record => record.senderId))) {
        const records = pending.filter(record => record.senderId === senderId);
        try {
          const { sender } = this.recordedIdentities(records[0]);
          const offers = await sender.sentOffers(records);
          for (const record of records) {
            try {
              this.recordedIdentities(record);
              let offer;
              if (record.offerId) {
                offer = offers.get(String(record.offerId)) || await sender.getOffer(record.offerId);
                if (!safeOutgoing(offer, record)) throw new Error('Tracked offer failed recipient/item verification.');
              } else {
                const candidates = this.recoveryCandidates(record, offers);
                if (candidates.length !== 1) {
                  record.state = candidates.length
                    ? 'Multiple matching sent offers. Check Steam and link the exact offer ID.'
                    : record.attemptedAt
                      ? 'No matching offer found yet. Check Steam sent offers or keep this item reserved and trade other items.'
                      : 'Legacy send has no recorded attempt time. Link its exact Steam offer ID, or keep this item reserved and trade other items.';
                  summary.checked++;
                  continue;
                }
                offer = await sender.getOffer(String(candidates[0].id));
                if (!safeOutgoing(offer, record, String(candidates[0].id))) throw new Error('Recovered offer failed recipient/item verification.');
                record.offerId = String(offer.id);
                summary.linked++;
              }
              this.updateCheckedState(record, offer);
              summary.checked++;
              if (!RESERVED_STATUSES.has(record.status)) summary.resolved++;
            } catch (error) {
              failure = error;
              if (rateLimited(error)) break;
            }
          }
        } catch (error) {
          failure = error;
        }
        this.save();
        if (failure && rateLimited(failure)) break;
      }
      summary.unresolved = this.reservedCount();
      this.logger.write('steam_status_checked', { count: summary.checked });
      if (failure) {
        this.handleCycleError(rateLimited(failure) ? failure : new Error('Some Steam offers could not be checked or verified. Unresolved items remain protected. Retry after checking both account SteamIDs.'), true);
        throw new Error(this.error);
      }
      this.error = '';
      this.backoffMs = 0;
      this.nextPollAt = this.now() + POLL_INTERVAL;
      this.save();
      return summary;
    } finally {
      this.busy = false;
    }
  }

  async loadSentOffers(outstanding) {
    const offers = new Map();
    for (const senderId of new Set(outstanding.map(record => record.senderId))) {
      const records = outstanding.filter(record => record.senderId === senderId);
      const { sender } = this.recordedIdentities(records[0]);
      const results = await sender.sentOffers(records);
      for (const [id, offer] of results) offers.set(`${senderId}:${id}`, offer);
    }
    return offers;
  }

  async acceptIncoming(record, receiver) {
    const incoming = await receiver.getOffer(record.offerId);
    if (!safeIncoming(incoming, record, receiver.steamId)) {
      throw new Error('Incoming offer failed sender/item verification.');
    }
    if (!this.running) return;
    const status = await receiver.accept(incoming);
    record.acceptRequested = true;
    record.state = status === 'pending'
      ? 'Receiver phone confirmation required'
      : `Receiver accepted (${status}); checking Steam`;
  }

  async checkOffer(record, outgoing, receiver) {
    const awaitingAcceptance = record.acceptRequested && outgoing.state === OFFER_STATE.Active;
    const awaitingConfirmation = record.autoConfirmed && outgoing.state === OFFER_STATE.NeedsConfirmation;
    if (!awaitingAcceptance && !awaitingConfirmation) record.state = offerStateLabel(outgoing.state);

    if (isTerminalState(outgoing.state)) {
      record.status = outgoing.state === OFFER_STATE.Accepted ? 'completed' : 'stopped';
      if (outgoing.state !== OFFER_STATE.Accepted) {
        throw new Error(`Offer ${record.offerId}: ${record.state}. Review it on Steam before resuming.`);
      }
    } else if (outgoing.state === OFFER_STATE.NeedsConfirmation && record.senderSlot === 'alt'
      && this.altConfirmation?.enabled() && !record.autoConfirmed && this.running) {
      if (await this.altConfirmation.confirm(record, outgoing, () => this.running)) {
        record.autoConfirmed = true;
        record.state = 'Alt send auto-confirmed; waiting for Steam';
      }
    } else if (outgoing.state === OFFER_STATE.Active && this.running && !record.acceptRequested) {
      await this.acceptIncoming(record, receiver);
    }
  }

  async checkOutstanding(outstanding) {
    const offers = await this.loadSentOffers(outstanding);
    for (const record of outstanding) {
      if (!this.running) break;
      const { sender, receiver } = record.archived ? this.recordedIdentities(record) : this.recordAccounts(record);
      const outgoing = offers.get(`${record.senderId}:${record.offerId}`) || await sender.getOffer(record.offerId);
      if (record.archived) {
        if (!safeOutgoing(outgoing, record)) throw new Error('Tracked offer failed recipient/item verification.');
        this.updateCheckedState(record, outgoing);
      } else {
        await this.checkOffer(record, outgoing, receiver);
      }
      this.save();
    }
  }

  async sendRecord(record, sender, receiver, token) {
    record.status = 'sending';
    record.attemptedAt = new Date(this.now()).toISOString();
    this.save();
    try {
      const result = await sender.send(receiver.steamId, token, record.item, record.key);
      record.offerId = result.id;
      record.status = 'sent';
      record.state = result.status === 'pending' ? 'Phone confirmation required' : 'Sent; waiting for Steam';
      this.save();
    } catch (error) {
      record.status = 'uncertain';
      this.save();
      throw new Error(`Send response uncertain: ${error.message}. Check Steam sent offers; do not resend the same item.`);
    }
  }

  async fillOpenSlots() {
    const inventories = new Map();
    const tokens = new Map();
    while (this.running && this.reservedCount() < MAX_OUTSTANDING) {
      const record = this.records.find(candidate => !candidate.archived && candidate.status === 'queued');
      if (!record) break;
      const { sender, receiver } = this.recordAccounts(record);
      if (!inventories.has(record.senderSlot)) inventories.set(record.senderSlot, await sender.inventory());
      const inventory = inventories.get(record.senderSlot);
      if (!inventory.some(item => item.tradable && sameItem(item, record.item))) {
        throw new Error('Queued item is missing or trade locked. Refresh inventory and clear unsent items.');
      }
      if (!tokens.has(record.receiverId)) tokens.set(record.receiverId, await receiver.offerToken());
      if (!this.running) return false;
      await this.sendRecord(record, sender, receiver, tokens.get(record.receiverId));
    }
    return true;
  }

  handleCycleError(error, readOnly = false) {
    const uncertain = this.hasUncertainSend();
    if (rateLimited(error) && (!uncertain || readOnly)) {
      this.backoffMs = retryDelay(error, this.backoffMs, this.now());
      this.nextPollAt = this.now() + this.backoffMs;
      this.error = `Steam rate-limited a request. Retrying after ${new Date(this.nextPollAt).toLocaleTimeString()}.`;
      this.logger.write('rate_limit_backoff', { delayMs: this.backoffMs });
    } else {
      this.error = error.message;
      this.running = false;
      this.logger.write('queue_error', { reason: uncertain ? 'uncertain_send' : 'operation_failed' });
    }
    this.save();
  }

  async tick() {
    if (!this.running || this.busy || this.now() < this.nextPollAt) return;
    this.busy = true;
    try {
      this.pair();
      if (this.hasUncertainSend()) {
        throw new Error('Uncertain send. Check your Steam sent offers before continuing.');
      }
      const outstanding = this.outstanding();
      this.logger.write('poll_started', { count: outstanding.length });
      await this.checkOutstanding(outstanding);
      if (!await this.fillOpenSlots()) return;
      if (!this.records.some(record => !record.archived && ['queued', 'sent'].includes(record.status))) {
        this.running = false;
        this.logger.write('queue_finished');
      }
      if (this.backoffMs) this.logger.write('rate_limit_recovered');
      this.backoffMs = 0;
      this.nextPollAt = 0;
      this.error = '';
      this.logger.write('poll_completed', { count: this.outstanding().length });
    } catch (error) {
      this.handleCycleError(error);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Trader, safeIncoming, sameItem, rateLimited, MAX_OUTSTANDING, POLL_INTERVAL };
