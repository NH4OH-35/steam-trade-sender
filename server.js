const path = require('node:path');
const { Account } = require('./accounts');
const { Trader } = require('./trader');
const { ActivityLog } = require('./activity-log');
const { AltConfirmation } = require('./alt-confirmation');
const { ACCOUNT_SLOTS, POLL_INTERVAL } = require('./trade-rules');
const { createHttpApp } = require('./http-app');

const port = Number(process.env.PORT || 3177);
const address = `127.0.0.1:${port}`;
const origin = `http://${address}`;
const dataDirectory = process.env.TRADER_DATA_DIR || path.join(__dirname, 'data');
const logger = new ActivityLog(path.join(dataDirectory, 'activity.jsonl'));
const accounts = Object.fromEntries(ACCOUNT_SLOTS.map(slot => [slot, new Account(slot, { logger })]));
const altConfirmation = new AltConfirmation(accounts, logger);
const trader = new Trader(accounts, path.join(dataDirectory, 'queue.json'), { logger, altConfirmation });
const { app, isMutationBusy } = createHttpApp({ accounts, trader, altConfirmation, logger, address, origin });

async function pollTrader() {
  if (isMutationBusy()) return;
  try {
    await trader.tick();
  } catch {
    trader.running = false;
    trader.error = 'Could not save queue or activity log. Check available disk space and restart.';
  }
}

function openBrowser() {
  const browser = require('node:child_process').spawn('explorer.exe', [origin], {
    windowsHide: true,
    stdio: 'ignore'
  });
  browser.on('error', () => console.log(`Open ${origin} in your browser.`));
}

const timer = setInterval(() => void pollTrader(), POLL_INTERVAL);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Steam Trader is ready: ${origin}\nKeep this window open. Press Ctrl+C to stop. No transfers start until you press Start queue.`);
  logger.write('server_started');
  if (process.platform === 'win32' && process.argv.includes('--open')) openBrowser();
});

server.on('error', error => {
  console.error(`Cannot start: ${error.message}`);
  clearInterval(timer);
  process.exitCode = 1;
});

function shutdown() {
  trader.pause();
  altConfirmation.disable();
  clearInterval(timer);
  for (const account of Object.values(accounts)) account.logout();
  logger.write('server_stopped');
  server.close();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
