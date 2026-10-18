const ACCOUNT_SLOTS = Object.freeze(['main', 'alt']);
const MAX_OUTSTANDING = 5;
const POLL_INTERVAL = 5000;

const OFFER_STATE = Object.freeze({
  Active: 2,
  Accepted: 3,
  Expired: 5,
  Canceled: 6,
  Declined: 7,
  InvalidItems: 8,
  NeedsConfirmation: 9,
  CanceledBySecondFactor: 10,
  InEscrow: 11,
  Reversed: 12
});

const stateLabels = new Map([
  [OFFER_STATE.Active, 'Active'],
  [OFFER_STATE.Accepted, 'Accepted'],
  [OFFER_STATE.Expired, 'Expired'],
  [OFFER_STATE.Canceled, 'Canceled'],
  [OFFER_STATE.Declined, 'Declined'],
  [OFFER_STATE.InvalidItems, 'Invalid items'],
  [OFFER_STATE.NeedsConfirmation, 'Phone confirmation required'],
  [OFFER_STATE.CanceledBySecondFactor, 'Canceled by second factor'],
  [OFFER_STATE.InEscrow, 'In escrow'],
  [OFFER_STATE.Reversed, 'Reversed']
]);

const terminalStates = new Set([
  OFFER_STATE.Accepted,
  OFFER_STATE.Expired,
  OFFER_STATE.Canceled,
  OFFER_STATE.Declined,
  OFFER_STATE.InvalidItems,
  OFFER_STATE.CanceledBySecondFactor,
  OFFER_STATE.InEscrow,
  OFFER_STATE.Reversed
]);

function oppositeSlot(slot) {
  if (!ACCOUNT_SLOTS.includes(slot)) throw new Error('Invalid account.');
  return slot === 'main' ? 'alt' : 'main';
}

function offerStateLabel(state) {
  return stateLabels.get(state) || `Steam state ${state}`;
}

function transferMessage(key) {
  return key ? `Two-account item transfer (${key})` : 'Two-account item transfer';
}

function isTerminalState(state) {
  return terminalStates.has(state);
}

function sameItem(item, expected) {
  return String(item.appid) === String(expected.appid)
    && String(item.contextid) === String(expected.contextid)
    && String(item.assetid || item.id) === String(expected.assetid)
    && Number(item.amount || 1) === 1;
}

function safeIncoming(offer, record, receiverId) {
  return String(offer.id) === record.offerId
    && offer.isOurOffer === false
    && offer.partner.getSteamID64() === record.senderId
    && receiverId === record.receiverId
    && offer.state === OFFER_STATE.Active
    && offer.itemsToGive.length === 0
    && offer.itemsToReceive.length === 1
    && sameItem(offer.itemsToReceive[0], record.item);
}

function safeOutgoing(offer, record, offerId = record.offerId) {
  return String(offer.id) === offerId
    && offer.isOurOffer === true
    && offer.partner.getSteamID64() === record.receiverId
    && offer.itemsToGive.length === 1
    && offer.itemsToReceive.length === 0
    && sameItem(offer.itemsToGive[0], record.item);
}

module.exports = {
  ACCOUNT_SLOTS,
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
};
