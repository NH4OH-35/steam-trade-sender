const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { ACCOUNT_SLOTS, MAX_OUTSTANDING, POLL_INTERVAL } = require('./trade-rules');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://community.steamstatic.com https://community.cloudflare.steamstatic.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'"
].join('; ');

function localRequests({ address, origin, token }) {
  return (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.set('X-Content-Type-Options', 'nosniff');
    response.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (request.headers.host !== address) {
      return response.status(403).json({ error: 'Use the local app address.' });
    }
    if (request.headers.origin && request.headers.origin !== origin) {
      return response.status(403).json({ error: 'Invalid origin.' });
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return response.status(403).json({ error: 'Cross-site request blocked.' });
    }
    if (request.path.startsWith('/api/') && request.method !== 'GET' && request.headers['x-app-token'] !== token) {
      return response.status(403).json({ error: 'Reload the app before continuing.' });
    }
    next();
  };
}

function accountFor(accounts, slot) {
  if (!Object.hasOwn(accounts, slot)) throw new Error('Invalid account.');
  return accounts[slot];
}

function requireIdle(trader, message) {
  if (trader.running || trader.busy) throw new Error(message);
}

function requireReviewedIdentities(accounts, identities) {
  if (!identities || Object.entries(accounts).some(([slot, account]) => identities[slot] !== account.steamId)) {
    throw new Error('Accounts changed since review. Reload inventory and review again.');
  }
}

function createActions({ accounts, trader, altConfirmation }) {
  function updateAltConfirmation(body) {
    if (body.enabled === false) {
      trader.pause();
      altConfirmation.disable();
      return;
    }
    if (body.enabled !== true || body.acknowledged !== true) {
      throw new Error('Acknowledge enabling Alt → Main confirmations first.');
    }
    requireIdle(trader, 'Pause the queue and wait for the current operation first.');
    altConfirmation.enable(body.slot, body.identitySecret, body.identities);
  }

  async function signInWithQr(body) {
    requireIdle(trader, 'Pause the queue and wait for the current operation before signing in.');
    altConfirmation.disable();
    await accountFor(accounts, body.slot).loginWithQR();
  }

  function signInWithPassword(body) {
    requireIdle(trader, 'Pause the queue and wait for the current operation before signing in.');
    if (typeof body.username !== 'string' || !body.username.trim() || body.username.length > 100
      || typeof body.password !== 'string' || !body.password || body.password.length > 256) {
      throw new Error('Enter your account name and password.');
    }
    altConfirmation.disable();
    accountFor(accounts, body.slot).login(body.username.trim(), body.password);
  }

  function submitGuardCode(body) {
    const account = accountFor(accounts, body.slot);
    if (!account.guard || typeof body.code !== 'string' || !/^[a-zA-Z0-9]{5,8}$/.test(body.code.trim())) {
      throw new Error('Enter a valid pending Steam Guard code.');
    }
    const callback = account.guard;
    account.guard = null;
    account.status = 'Checking Steam Guard code';
    callback(body.code.trim());
  }

  function signOut(body) {
    trader.pause();
    if (trader.busy) throw new Error('Wait for the current operation to finish, then sign out.');
    altConfirmation.disable();
    accountFor(accounts, body.slot).logout();
  }

  async function queueItems(body) {
    requireReviewedIdentities(accounts, body.identities);
    const inventory = await accountFor(accounts, body.slot).inventory();
    trader.add(body.slot, inventory, body.assetIds);
  }

  return {
    'alt-confirmation': updateAltConfirmation,
    qr: signInWithQr,
    login: signInWithPassword,
    guard: submitGuardCode,
    logout: signOut,
    queue: queueItems,
    resume: () => trader.resume(),
    pause: () => trader.pause(),
    clear: () => trader.clear(),
    'clear-queue': () => trader.clearQueue(),
    reconcile: () => trader.reconcile(),
    'resolve-canceled': body => trader.resolveCanceled(body.key, body.acknowledged),
    recover: body => trader.recover(body.key, body.offerId)
  };
}

function createHttpApp({ accounts, trader, altConfirmation, logger, address, origin, token = crypto.randomBytes(32).toString('hex') }) {
  const app = express();
  const actions = createActions({ accounts, trader, altConfirmation });
  let mutationBusy = false;

  app.use(localRequests({ address, origin, token }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/state', (request, response) => {
    response.json({
      token,
      accounts: Object.values(accounts).map(account => account.publicState()),
      running: trader.running,
      busy: trader.busy,
      error: trader.error,
      records: trader.records,
      maxOutstanding: MAX_OUTSTANDING,
      pollIntervalMs: POLL_INTERVAL,
      nextPollAt: trader.nextPollAt,
      altAutoConfirmation: altConfirmation.publicState()
    });
  });

  app.get('/api/logs', (request, response) => {
    response.download(logger.filename, 'steam-transfer-activity.jsonl');
  });

  app.get('/api/inventory/:slot', async (request, response, next) => {
    try {
      response.json(await accountFor(accounts, request.params.slot).inventory());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/:action', async (request, response, next) => {
    if (mutationBusy) return response.status(409).json({ error: 'Another operation is in progress.' });
    mutationBusy = true;
    try {
      const body = request.body || {};
      const action = request.params.action;
      const knownAction = Object.hasOwn(actions, action);
      logger.write('action_requested', {
        action: knownAction ? action : 'unknown',
        slot: ACCOUNT_SLOTS.includes(body.slot) ? body.slot : undefined
      });
      if (!knownAction) throw new Error('Unknown action.');
      const result = await actions[action](body);
      logger.write('action_completed');
      response.json(result === undefined ? { ok: true } : { ok: true, result });
    } catch (error) {
      try {
        logger.write('action_failed');
      } catch {}
      next(error);
    } finally {
      mutationBusy = false;
    }
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    response.status(400).json({ error: error.message || 'Request failed.' });
  });

  return { app, isMutationBusy: () => mutationBusy };
}

module.exports = { createHttpApp };
