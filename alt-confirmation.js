const { OFFER_STATE, safeOutgoing } = require('./trade-rules');
const { rateLimited } = require('./retry-policy');

const ACCOUNT_ATTEMPT_INTERVAL = 10000;
const OFFER_ATTEMPT_INTERVAL = 30000;

class AltConfirmation {
  constructor(accounts, logger, options = {}) {
    this.accounts = accounts;
    this.logger = logger;
    this.now = options.now || Date.now;
    this.credentials = null;
    this.nextAttemptAt = 0;
    this.offerAttempts = new Map();
  }

  enable(slot, identitySecret, identities) {
    if (slot !== 'alt') {
      throw new Error('Automatic outgoing confirmations are available only for Alt → Main.');
    }
    const { main, alt } = this.accounts;
    if (!main.ready || !alt.ready || !main.steamId || !alt.steamId || main.steamId === alt.steamId) {
      throw new Error('Connect two different accounts first.');
    }
    if (identities?.main !== main.steamId || identities?.alt !== alt.steamId) {
      throw new Error('Accounts changed. Refresh and verify the SteamIDs again.');
    }
    const secret = typeof identitySecret === 'string' ? identitySecret.trim() : '';
    if (!/^[A-Za-z0-9+/]{27}=$/.test(secret) || Buffer.from(secret, 'base64').length !== 20) {
      throw new Error('Enter the alt authenticator’s base64 identity_secret, not its five-character Steam Guard code.');
    }
    this.credentials = { identitySecret: secret, senderId: alt.steamId, receiverId: main.steamId };
    this.nextAttemptAt = 0;
    this.offerAttempts.clear();
    this.logger.write('alt_autoconfirm_enabled', { slot: 'alt', steamId: alt.steamId });
  }

  disable() {
    if (this.credentials) this.logger.write('alt_autoconfirm_disabled', { slot: 'alt' });
    this.credentials = null;
    this.nextAttemptAt = 0;
    this.offerAttempts.clear();
  }

  enabled() {
    if (this.credentials && (this.accounts.alt.steamId !== this.credentials.senderId
      || this.accounts.main.steamId !== this.credentials.receiverId)) {
      this.disable();
    }
    return Boolean(this.credentials);
  }

  async confirm(record, offer, isRunning) {
    if (!this.enabled() || !isRunning() || this.now() < this.nextAttemptAt
      || this.now() < (this.offerAttempts.get(record.offerId) || 0)) {
      return false;
    }
    const credentials = this.credentials;
    const { alt, main } = this.accounts;
    if (record.senderSlot !== 'alt' || record.status !== 'sent' || !record.offerId
      || record.senderId !== credentials.senderId || record.receiverId !== credentials.receiverId
      || !alt.ready || !main.ready || offer.state !== OFFER_STATE.NeedsConfirmation || !safeOutgoing(offer, record)) {
      throw new Error('Alt auto-confirmation stopped: offer does not match the approved Alt → Main transfer.');
    }
    this.nextAttemptAt = this.now() + ACCOUNT_ATTEMPT_INTERVAL;
    this.offerAttempts.set(record.offerId, this.now() + OFFER_ATTEMPT_INTERVAL);
    const authorized = () => this.credentials === credentials && this.enabled() && alt.ready && main.ready && isRunning();
    try {
      const confirmed = await alt.confirmOffer(credentials.identitySecret, record.offerId, authorized);
      this.logger.write(confirmed ? 'alt_offer_auto_confirmed' : 'alt_confirmation_waiting', { record });
      return confirmed;
    } catch (error) {
      this.logger.write('alt_confirmation_failed', { record });
      const failure = new Error('Alt auto-confirmation failed. The offer remains recorded; review it on your phone or disable auto-confirmation before resuming.');
      if (rateLimited(error)) failure.statusCode = 429;
      throw failure;
    }
  }

  publicState() {
    return { enabled: this.enabled() };
  }
}

module.exports = { AltConfirmation };
