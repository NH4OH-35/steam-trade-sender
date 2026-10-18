const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const QRCode = require('qrcode');
const SteamTotp = require('steam-totp');
const { transferMessage } = require('./trade-rules');

const ITEM_IMAGE_BASE = 'https://community.steamstatic.com/economy/image/';

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
}

function inventoryItem(item) {
  return {
    appid: 730,
    contextid: '2',
    assetid: String(item.assetid || item.id),
    name: item.market_hash_name || item.name || 'Unnamed item',
    tradable: item.tradable === true || item.tradable === 1,
    icon: item.icon_url ? `${ITEM_IMAGE_BASE}${item.icon_url}/256fx256f` : '',
    details: (item.owner_descriptions || [])
      .map(description => description.value)
      .join(' ')
      .replace(/<[^>]*>/g, '')
  };
}

class Account {
  constructor(slot, options = {}) {
    this.slot = slot;
    this.ready = false;
    this.steamId = '';
    this.status = 'Signed out';
    this.client = null;
    this.guard = null;
    this.qrSession = null;
    this.qrImage = '';
    this.logger = options.logger;
    this.confirmationKeys = options.confirmationKeys || SteamTotp;
    this.createQrSession = options.createQrSession || (() => new LoginSession(EAuthTokenPlatformType.SteamClient));
    this.encodeQr = options.encodeQr || (url => QRCode.toDataURL(url, { width: 256, margin: 4, errorCorrectionLevel: 'M' }));
  }

  login(username, password) {
    this.logout();
    this.status = 'Signing in; a Steam Guard login code may be required';
    this.log('password_login_started');
    this.connect({ accountName: username, password });
  }

  async loginWithQR() {
    this.logout();
    this.status = 'Creating Steam QR sign-in…';
    this.log('qr_login_started');
    const session = this.createQrSession();
    this.qrSession = session;
    session.loginTimeout = 120000;
    this.watchQrSession(session);
    try {
      const { qrChallengeUrl } = await session.startWithQR();
      if (this.qrSession !== session) return;
      const image = await this.encodeQr(qrChallengeUrl);
      if (this.qrSession !== session) return;
      this.qrImage = image;
      this.status = 'Scan with the Steam mobile app, then approve for this account.';
    } catch {
      if (this.qrSession !== session) return;
      this.failQrLogin(session, 'Could not create Steam QR sign-in. Try again.');
      throw new Error(this.status);
    }
  }

  watchQrSession(session) {
    session.on('error', () => this.failQrLogin(session, 'Steam QR sign-in failed. Generate a new code to retry.'));
    session.on('timeout', () => this.failQrLogin(session, 'QR sign-in expired. Generate a new code.'));
    session.on('remoteInteraction', () => {
      if (this.qrSession === session) this.status = 'Scanned. Approve sign-in in Steam on your phone.';
    });
    session.once('authenticated', () => this.completeQrLogin(session));
  }

  failQrLogin(session, message) {
    if (this.qrSession !== session) return;
    this.qrSession = null;
    this.qrImage = '';
    session.cancelLoginAttempt();
    this.status = message;
    this.log('qr_login_stopped');
  }

  completeQrLogin(session) {
    if (this.qrSession !== session) return;
    this.qrSession = null;
    this.qrImage = '';
    this.status = 'Phone approval received. Connecting to Steam…';
    this.log('qr_login_approved');
    try {
      this.connect({ refreshToken: session.refreshToken });
    } catch {
      this.status = 'Steam connection failed. Generate a new QR code to retry.';
    }
  }

  connect(logonDetails) {
    const client = new SteamUser({ dataDirectory: null, autoRelogin: false, enablePicsCache: false });
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({
      community,
      language: 'en',
      useAccessToken: true,
      dataDirectory: null,
      savePollData: false,
      pollInterval: -1,
      minimumPollInterval: 5000
    });
    manager.doPoll = () => {};
    this.client = client;
    this.manager = manager;
    this.community = community;
    this.confirmationTimeOffset = undefined;
    this.lastConfirmationTime = 0;
    this.watchConnection(client, manager, community);
    try {
      client.logOn(logonDetails);
    } catch (error) {
      this.status = `Login failed: ${error.message}`;
      throw error;
    }
  }

  watchConnection(client, manager, community) {
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      if (this.client !== client) return;
      this.guard = callback;
      this.log('login_code_requested');
      const instruction = domain
        ? 'Enter the email login code'
        : 'Enter the current Steam Guard code; phone approval alone does not complete this login';
      this.status = `${lastCodeWrong ? 'Incorrect code. Wait for a new code. ' : ''}${instruction}`;
    });
    client.on('webSession', async (sessionId, cookies) => {
      if (this.client !== client) return;
      try {
        await call(manager, 'setCookies', cookies);
        if (this.client !== client) return;
        this.steamId = client.steamID.getSteamID64();
        this.ready = true;
        this.status = 'Connected';
        this.guard = null;
        this.log('account_connected', { steamId: this.steamId });
      } catch (error) {
        if (this.client !== client) return;
        this.ready = false;
        this.status = `Steam web login failed: ${error.message}`;
        this.log('web_login_failed');
      }
    });
    client.on('error', error => {
      if (this.client !== client) return;
      this.ready = false;
      this.guard = null;
      this.status = `Login/connection error: ${error.message}`;
      this.log('account_error', { errorCode: Number(error.eresult) || null });
    });
    client.on('disconnected', () => {
      if (this.client !== client) return;
      this.ready = false;
      this.status = 'Disconnected; sign in again';
      this.log('account_disconnected');
    });
    const renew = () => this.refreshWebSession(client);
    manager.on('sessionExpired', renew);
    community.on('sessionExpired', renew);
  }

  refreshWebSession(client) {
    if (this.client !== client) return;
    this.ready = false;
    this.status = 'Refreshing Steam session';
    this.log('session_refresh_started');
    try {
      client.webLogOn();
    } catch {
      this.status = 'Session expired; sign in again';
    }
  }

  logout() {
    if (this.client || this.qrSession) this.log('account_signed_out', { steamId: this.steamId });
    const qrSession = this.qrSession;
    this.qrSession = null;
    this.qrImage = '';
    if (qrSession) qrSession.cancelLoginAttempt();
    const client = this.client;
    this.client = null;
    this.guard = null;
    this.ready = false;
    this.steamId = '';
    this.status = 'Signed out';
    if (this.manager) this.manager.shutdown();
    if (client) client.logOff();
    this.community = null;
    this.confirmationTimeOffset = undefined;
  }

  async inventory() {
    if (!this.ready) throw new Error('Account is not connected.');
    const items = await call(this.manager, 'getInventoryContents', 730, '2', false);
    this.log('inventory_loaded', { count: items.length });
    return items.map(inventoryItem);
  }

  getOffer(id) {
    return call(this.manager, 'getOffer', id);
  }

  async sentOffers(records) {
    const oldest = Math.min(...records.map(record => Date.parse(record.created) || Date.now()));
    const offers = await call(this.manager, 'getOffers', TradeOfferManager.EOfferFilter.All, new Date(oldest - 60000));
    return new Map(offers.map(offer => [String(offer.id), offer]));
  }
  offerToken() {
    return call(this.manager, 'getOfferToken');
  }

  accept(offer) {
    return call(offer, 'accept', true);
  }

  async confirmOffer(identitySecret, offerId, authorized) {
    if (this.slot !== 'alt' || !this.ready || !this.community) throw new Error('Alt account is not connected.');
    const community = this.community;
    const allowed = () => this.community === community && this.ready && authorized();
    if (!allowed()) return false;
    if (this.confirmationTimeOffset === undefined) {
      const offset = await call(this.confirmationKeys, 'getTimeOffset');
      if (!allowed()) return false;
      this.confirmationTimeOffset = offset;
    }
    const listTime = this.confirmationKeys.time(this.confirmationTimeOffset);
    const listKey = this.confirmationKeys.getConfirmationKey(identitySecret, listTime, 'list');
    const confirmations = await call(community, 'getConfirmations', listTime, { tag: 'list', key: listKey });
    if (!allowed()) return false;
    const confirmation = confirmations.find(candidate =>
      candidate.type === SteamCommunity.ConfirmationType.Trade && String(candidate.creator) === offerId
    );
    if (!confirmation) return false;
    const confirmTime = Math.max(
      this.confirmationKeys.time(this.confirmationTimeOffset),
      (this.lastConfirmationTime || 0) + 1
    );
    const confirmKey = this.confirmationKeys.getConfirmationKey(identitySecret, confirmTime, 'accept');
    this.lastConfirmationTime = confirmTime;
    if (!allowed()) return false;
    await call(confirmation, 'respond', confirmTime, { tag: 'accept', key: confirmKey }, true);
    return true;
  }

  log(event, details = {}) {
    this.logger?.write(event, { slot: this.slot, ...details });
  }

  async send(receiverId, token, item, transferKey) {
    const offer = this.manager.createOffer(receiverId, token);
    offer.addMyItem({ ...item, amount: 1 });
    offer.setMessage(transferMessage(transferKey));
    const status = await call(offer, 'send');
    if (!offer.id) throw new Error('Steam returned no offer ID');
    return { id: String(offer.id), status };
  }

  publicState() {
    return {
      slot: this.slot,
      ready: this.ready,
      steamId: this.steamId,
      status: this.status,
      needsCode: Boolean(this.guard),
      qrPending: Boolean(this.qrSession),
      qrImage: this.qrImage
    };
  }
}

module.exports = { Account };
