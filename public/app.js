const element = id => document.getElementById(id);
const unresolvedStatuses = new Set(['sent', 'sending', 'uncertain']);
let state;
let inventory = [];
const selected = new Set();
let reservedItems = new Set();
let inventorySlot = null;
let inventorySteamId = null;
let reviewSelection = null;
let toastTimer;
let loading = false;
let refreshing = false;
let reconciling = false;
let renderedRecords = '';
let renderedReservations = '';

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function message(text) {
  const toast = element('message');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 9000);
}

async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Token': state?.token || ''
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

function action(name, body = {}) {
  return api(`/api/${name}`, body).then(refresh).catch(error => message(error.message));
}

function createPasswordLogin(slot) {
  const form = node('form');
  form.id = `${slot}-login`;

  const username = node('input');
  username.placeholder = 'Steam account name';
  username.autocomplete = 'off';
  username.required = true;
  username.setAttribute('aria-label', `${slot} account name`);

  const password = node('input');
  password.type = 'password';
  password.placeholder = 'Password';
  password.autocomplete = 'off';
  password.required = true;
  password.setAttribute('aria-label', `${slot} password`);

  const login = node('button', 'Sign in');
  form.append(username, password, login);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    login.disabled = true;
    const secret = password.value;
    password.value = '';
    await action('login', { slot, username: username.value, password: secret });
    login.disabled = false;
  });
  return form;
}

function createGuardLogin(slot) {
  const guardForm = node('form');
  guardForm.id = `${slot}-guard`;
  guardForm.hidden = true;

  const code = node('input');
  code.placeholder = 'Steam Guard / email code';
  code.setAttribute('aria-label', `${slot} login code`);
  code.autocomplete = 'one-time-code';
  code.required = true;
  guardForm.append(code, node('button', 'Submit login code'));
  guardForm.addEventListener('submit', async event => {
    event.preventDefault();
    const value = code.value;
    code.value = '';
    await action('guard', { slot, code: value });
  });
  return guardForm;
}

function createAccountCard(slot) {
  const card = node('article', undefined, 'account');
  const status = node('p', 'Signed out', 'status');
  status.id = `${slot}-status`;
  const steamId = node('p', '', 'steamid');
  steamId.id = `${slot}-id`;

  const qrButton = node('button', 'Sign in with Steam QR');
  qrButton.id = `${slot}-qr-button`;
  qrButton.addEventListener('click', async () => {
    qrButton.disabled = true;
    await action('qr', { slot });
    qrButton.disabled = false;
  });

  const qrPanel = node('div', undefined, 'qr-panel');
  qrPanel.id = `${slot}-qr-panel`;
  qrPanel.hidden = true;
  const qrImage = node('img');
  qrImage.id = `${slot}-qr-image`;
  qrImage.alt = `Steam sign-in QR code for the ${slot} account`;
  qrImage.width = 256;
  qrImage.height = 256;
  qrPanel.append(
    qrImage,
    node('p', 'Scan using Steam Guard on the phone for this account, then approve. Never share this sign-in QR code.')
  );

  const passwordOption = node('details');
  passwordOption.id = `${slot}-password-option`;
  passwordOption.append(
    node('summary', 'Or sign in with a password and code'),
    createPasswordLogin(slot)
  );

  const logout = node('button', 'Sign out / reset login', 'secondary');
  logout.addEventListener('click', () => action('logout', { slot }));
  card.append(
    node('h2', slot === 'main' ? 'Main account' : 'Alt account'),
    status,
    steamId,
    qrButton,
    qrPanel,
    passwordOption,
    createGuardLogin(slot),
    logout
  );
  return card;
}

function renderAccount(account) {
  const { slot } = account;
  element(`${slot}-status`).textContent = account.status;
  element(`${slot}-id`).textContent = account.steamId ? `SteamID: ${account.steamId}` : '';
  element(`${slot}-login`).hidden = account.ready || account.needsCode;
  element(`${slot}-password-option`).hidden = account.ready || account.needsCode || account.qrPending;
  element(`${slot}-guard`).hidden = !account.needsCode;

  const qrButton = element(`${slot}-qr-button`);
  qrButton.hidden = account.ready;
  qrButton.textContent = account.qrPending ? 'Generate a new QR code' : 'Sign in with Steam QR';
  element(`${slot}-qr-panel`).hidden = !account.qrImage;
  const picture = element(`${slot}-qr-image`);
  if (account.qrImage) {
    if (picture.getAttribute('src') !== account.qrImage) picture.src = account.qrImage;
  } else {
    picture.removeAttribute('src');
  }
}

function renderQueueStatus() {
  const outstanding = state.records.filter(record => unresolvedStatuses.has(record.status)).length;
  element('queue-status').textContent = state.running ? 'Running' : 'Paused';
  element('outstanding').textContent = `${outstanding} / ${state.maxOutstanding} outstanding`;
  element('queue-error').textContent = state.error;
  element('queue-error').hidden = !state.error;
  element('reconcile').disabled = state.busy || reconciling;

  const recordsKey = JSON.stringify([state.records, accountIdentities(), state.running, state.busy]);
  if (recordsKey !== renderedRecords) {
    renderRecords();
    renderedRecords = recordsKey;
  }
}

function renderAltConfirmation() {
  const enabled = state.altAutoConfirmation.enabled;
  const accountsReady = state.accounts.every(account => account.ready);
  element('alt-confirmation-status').textContent = enabled ? 'Enabled for this session' : 'Off';
  element('alt-confirmation-form').hidden = enabled;
  element('disable-alt-confirmation').hidden = !enabled;
  element('enable-alt-confirmation').disabled = state.running || state.busy || !accountsReady;
  element('alt-confirmation-accounts').textContent = accountsReady
    ? state.accounts.map(account => `${account.slot}: ${account.steamId}`).join(' → verify both accounts · ')
    : 'Connect both accounts and pause the queue to configure.';
}

function accountIdentities() {
  return Object.fromEntries(state.accounts.map(account => [account.slot, account.steamId]));
}

function reservationKey(steamId, item) {
  return JSON.stringify([steamId, item.appid, item.contextid, item.assetid].map(String));
}

function updateReservations() {
  const reservations = state.records
    .filter(record => unresolvedStatuses.has(record.status))
    .map(record => reservationKey(record.senderId, record.item));
  const reservationsKey = JSON.stringify([...new Set(reservations)].sort());
  if (reservationsKey === renderedReservations) return;
  reservedItems = new Set(reservations);
  renderedReservations = reservationsKey;
  renderInventory();
}

function selectableItem(item) {
  return item.tradable && !reservedItems.has(reservationKey(inventorySteamId, item));
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('/api/state');
    element('connection').textContent = 'Local connection';
    state.accounts.forEach(renderAccount);
    const sendingAccount = state.accounts.find(account => account.slot === inventorySlot);
    if (inventorySlot && sendingAccount?.steamId !== inventorySteamId) resetInventory();
    updateReservations();
    renderQueueStatus();
    renderAltConfirmation();
  } catch {
    element('connection').textContent = 'App offline — restart the program';
  } finally {
    refreshing = false;
  }
}

function resetInventory() {
  inventory = [];
  selected.clear();
  inventorySlot = null;
  inventorySteamId = null;
  renderInventory();
}

function visibleInventory() {
  const query = element('search').value.toLowerCase().trim();
  return inventory.filter(item => item.name.toLowerCase().includes(query));
}

function renderInventory() {
  for (const item of inventory) {
    if (!selectableItem(item)) selected.delete(item.assetid);
  }
  const container = element('inventory');
  container.replaceChildren();
  const visible = visibleInventory();
  if (!visible.length) {
    container.append(node('p', inventorySlot ? 'No matching items in this inventory.' : 'Load the sending account inventory.', 'muted'));
  }
  for (const item of visible) {
    const reserved = reservedItems.has(reservationKey(inventorySteamId, item));
    const selectable = selectableItem(item);
    const label = node('label', undefined, `item${selectable ? '' : ' locked'}`);
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = !selectable;
    checkbox.checked = selected.has(item.assetid);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selected.add(item.assetid);
      } else {
        selected.delete(item.assetid);
      }
      updateCount();
    });
    label.append(checkbox);
    if (item.icon) {
      const picture = node('img');
      picture.alt = '';
      picture.loading = 'lazy';
      picture.addEventListener('error', () => {
        picture.replaceWith(node('span', 'Image unavailable', 'item-image-fallback'));
      }, { once: true });
      picture.src = item.icon;
      label.append(picture);
    }
    label.append(
      node('span', item.name, 'item-name'),
      node('span', reserved ? 'Already tracked in Steam offers' : item.tradable ? 'Tradable' : 'Locked / not tradable', 'item-meta'),
      node('span', `Asset ${item.assetid}`, 'item-meta')
    );
    label.title = item.details;
    container.append(label);
  }
  updateCount();
}

function updateCount() {
  element('count').textContent = `${selected.size} selected · ${selected.size} separate offers`;
}

function renderRecords() {
  const container = element('records');
  container.replaceChildren();
  const records = state.records.filter(record => !record.archived);
  if (!records.length) container.append(node('p', 'No queued transfers to show.', 'muted'));
  for (const record of records.reverse()) {
    container.append(createRecordRow(record));
  }

  const tracked = state.records.filter(record => record.archived && unresolvedStatuses.has(record.status));
  element('tracked-section').hidden = !tracked.length;
  element('tracked-count').textContent = `${tracked.length} unresolved`;
  element('tracked-records').replaceChildren(...tracked.reverse().map(createRecordRow));
}

function accountLabel(steamId) {
  const account = state.accounts.find(candidate => candidate.steamId === steamId);
  if (!account) return `SteamID ${steamId}`;
  return `${account.slot === 'main' ? 'Main' : 'Alt'} (${steamId})`;
}

function createRecordRow(record) {
  const row = node('div', undefined, 'record');
  const description = node('div', record.item.name);
  description.append(
    node('small', `${accountLabel(record.senderId)} → ${accountLabel(record.receiverId)}`),
    node('small', `Asset ${record.item.assetid}`)
  );
  const progress = node('div', record.status);
  if (record.state) progress.append(node('small', record.state));
  row.append(description, progress);
  if (record.offerId) {
    const link = node('a', `Offer #${record.offerId} ↗`);
    link.href = `https://steamcommunity.com/tradeoffer/${record.offerId}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    row.append(link);
  } else if (record.status === 'uncertain') {
    const controls = node('div', undefined, 'record-actions');
    const recover = node('button', 'Link sent offer', 'secondary');
    recover.disabled = state.running || state.busy;
    recover.addEventListener('click', () => {
      const offerId = window.prompt('Check Steam → Inventory → Trade offers → Sent offers. Paste the exact offer ID for this item. If none is visible, leave it tracked and check again later.');
      if (offerId) void action('recover', { key: record.key, offerId: offerId.trim() });
    });
    const canceled = node('button', 'I canceled this offer', 'secondary');
    canceled.disabled = state.running || state.busy;
    canceled.addEventListener('click', async () => {
      if (state.running || state.busy) return;
      const confirmed = window.confirm(`You confirm that the offer for "${record.item.name}" (asset ${record.item.assetid}, sender ${accountLabel(record.senderId)}) is canceled and no longer active on Steam. This app cannot verify it without an offer ID. This releases the item reservation and keeps history. It does not cancel, send, or retry anything. Continue?`);
      if (!confirmed) return;

      recover.disabled = true;
      canceled.disabled = true;
      try {
        await api('/api/resolve-canceled', { key: record.key, acknowledged: true });
        await refresh();
        message('Marked canceled based on your confirmation. Item reservation released; history kept. Reload inventory.');
      } catch (error) {
        await refresh();
        message(error.message);
      } finally {
        recover.disabled = state.running || state.busy;
        canceled.disabled = state.running || state.busy;
      }
    });
    controls.append(recover, canceled);
    row.append(controls);
  }
  return row;
}

element('load').addEventListener('click', async () => {
  if (loading) return;
  loading = true;
  element('load').disabled = true;
  const slot = element('direction').value;
  const steamId = state?.accounts.find(account => account.slot === slot)?.steamId;
  try {
    const items = await api(`/api/inventory/${slot}`);
    if (element('direction').value !== slot) return;
    inventory = items;
    inventorySlot = slot;
    inventorySteamId = steamId;
    selected.clear();
    renderInventory();
  } catch (error) {
    message(error.message);
  } finally {
    loading = false;
    element('load').disabled = false;
  }
});
element('direction').addEventListener('change', resetInventory);
element('search').addEventListener('input', renderInventory);
element('select').addEventListener('click', () => {
  visibleInventory().filter(selectableItem).forEach(item => selected.add(item.assetid));
  renderInventory();
});
element('deselect').addEventListener('click', () => {
  selected.clear();
  renderInventory();
});
element('queue').addEventListener('click', () => {
  if (!selected.size || inventorySlot !== element('direction').value) return message('Load inventory and select tradable items first.');
  if (!state?.accounts.every(account => account.ready)) return message('Connect both accounts first.');
  reviewSelection = {
    slot: inventorySlot,
    assetIds: [...selected],
    identities: accountIdentities()
  };
  element('review-summary').textContent = `${selected.size} items → ${selected.size} separate offers. Direction: ${inventorySlot === 'main' ? 'Main → Alt' : 'Alt → Main'}.`;
  element('review-accounts').textContent = state.accounts.map(account => `${account.slot}: ${account.steamId}`).join(' / ');
  const items = inventory.filter(item => selected.has(item.assetid));
  element('review-items').replaceChildren(...items.map(item => node('li', `${item.name} — asset ${item.assetid}`)));
  element('review').showModal();
});
element('cancel').addEventListener('click', () => element('review').close());
element('confirm').addEventListener('click', async () => {
  element('confirm').disabled = true;
  try {
    await api('/api/queue', reviewSelection);
    element('review').close();
    selected.clear();
    renderInventory();
    await refresh();
    message('Queue ready. Verify the accounts and press Start / resume.');
  } catch (error) {
    message(error.message);
  } finally {
    element('confirm').disabled = false;
  }
});
element('resume').addEventListener('click', () => action('resume'));
element('pause').addEventListener('click', () => action('pause'));
element('clear').addEventListener('click', () => {
  if (window.confirm('Remove unsent items and pause? Existing Steam offers remain open.')) void action('clear');
});
element('clear-queue').addEventListener('click', async () => {
  const confirmed = window.confirm('Clear the transfer queue and pause? Unsent items will be stopped. Unresolved Steam offers move to a separate tracked section and are not canceled, automatically accepted, or confirmed. Their items and outstanding slots stay reserved. Full history and activity logs are kept.');
  if (!confirmed) return;

  element('clear-queue').disabled = true;
  try {
    const { result } = await api('/api/clear-queue', {});
    await refresh();
    message(`Queue cleared and paused. ${result.unresolved} unresolved Steam offers remain tracked, not canceled. You can queue other items. History and logs are kept.`);
  } catch (error) {
    await refresh();
    message(error.message);
  } finally {
    element('clear-queue').disabled = false;
  }
});
element('reconcile').addEventListener('click', async () => {
  if (state?.running && !window.confirm('Pause the queue and check Steam status? This only checks existing offers; it does not send, accept, confirm, or cancel trades.')) return;

  reconciling = true;
  element('reconcile').disabled = true;
  element('reconcile-result').hidden = true;
  try {
    const { result } = await api('/api/reconcile', {});
    await refresh();
    element('reconcile-result').textContent = `Queue paused. Checked ${result.checked} offers: ${result.resolved} resolved, ${result.linked} linked, ${result.unresolved} still unresolved. No trades were sent, accepted, confirmed, or canceled.`;
    element('reconcile-result').hidden = false;
  } catch (error) {
    await refresh();
    message(error.message);
  } finally {
    reconciling = false;
    element('reconcile').disabled = Boolean(state?.busy);
  }
});
element('alt-confirmation-form').addEventListener('submit', async event => {
  event.preventDefault();
  const secret = element('alt-identity-secret').value;
  element('alt-identity-secret').value = '';
  try {
    await api('/api/alt-confirmation', {
      slot: 'alt',
      enabled: true,
      acknowledged: element('alt-confirmation-consent').checked,
      identitySecret: secret,
      identities: accountIdentities()
    });
    element('alt-confirmation-consent').checked = false;
    await refresh();
    message('Alt → Main auto-confirmation enabled for this session. Main sends still require your phone.');
  } catch (error) {
    message(error.message);
  }
});
element('disable-alt-confirmation').addEventListener('click', () => action('alt-confirmation', { enabled: false }));

for (const slot of ['main', 'alt']) {
  element('accounts').append(createAccountCard(slot));
}

void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 5000);
