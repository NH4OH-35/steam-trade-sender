# Steam Trade Sender

**Queue single-item CS2 trades between your own Steam accounts and build your trade history.**

Steam Trade Sender includes the **Steam Transfer Desk** local dashboard. It creates real trade offers, not simulated trades or edits to profile statistics. Steam decides how profile counters update; an increase is not guaranteed. This project is unofficial and is not affiliated with Valve.

A Windows-friendly local dashboard for moving CS2 items between two Steam accounts you own. Select items and send one item per offer, in either direction. The recipient automatically accepts only the exact offers recorded by this app, with the correct sender and item and nothing requested in return. Other offers are untouched.

## Features

- Two independent account sessions with Steam QR login or password and Steam Guard code.
- Searchable CS2 inventory with item thumbnails, trade-lock checks, and bulk selection.
- One selected item per offer, with up to five outstanding app-created offers.
- Verified receiving-account auto-accept; outgoing phone confirmations remain manual by default.
- Pause, clear, reconcile, and recover transfers without silently retrying uncertain sends.
- Persistent local history, downloadable redacted activity logs, and rate-limit backoff.

## Quick start

Requires Node.js 22 or newer. Download and extract the repository, or clone it:

```powershell
git clone https://github.com/NH4OH-35/steam-trade-sender.git
cd steam-trade-sender
npm ci
npm start
```

Open **http://127.0.0.1:3177**. On Windows, you can instead double-click **Start Steam Trader.cmd**; it installs dependencies if needed and opens the dashboard. Keep its terminal open. Sign in to both accounts, verify their SteamIDs, select items, review, and explicitly start the queue.

**Important:** Five-second polling is not guaranteed to be accepted by Steam. If you see HTTP 429 or a rate-limit warning, pause the queue, stop repeated manual refreshes, and wait. Do not run multiple copies or use this to bypass Steam restrictions. Do not expose the local server to the internet. See [SECURITY.md](SECURITY.md) before entering account credentials or enabling optional confirmations.

## Start

1. Install Node.js 22 LTS or newer from https://nodejs.org if needed.
2. Double-click **Start Steam Trader.cmd**. The first run installs dependencies. The terminal shows startup progress and opens the browser after the server is ready. Keep that terminal open while using the app.
3. Choose **Sign in with Steam QR** for Main. Scan the code with Steam Guard in the Steam mobile app and approve using your main account. Repeat for Alt using the other account's phone. No password or manually entered login code is needed for QR sign-in. QR attempts expire after two minutes; generate a new code if needed. Verify both SteamIDs before creating trades. You can alternatively expand password sign-in and enter the account's current Steam Guard code; phone approval alone does not complete that separate password flow. This is an independent community app using third-party Steam libraries, not a Valve product or Steam-hosted login page.
4. Verify the displayed SteamIDs belong to your intended accounts. Choose Main → Alt or Alt → Main, then load inventory.
5. Select items or select all visible tradable items. Review the items, create the queue, then press **Start / resume queue**.
6. Main-account sends require confirmation on its phone. Alt-account sends also require phone confirmation unless you explicitly enable optional Alt → Main auto-confirmation below. The recipient accepts the matching offer through its own logged-in session. If Steam also requires receiver phone confirmation, complete it there.
7. Keep the terminal and app open. The queue fills up to five outstanding app-created offers without waiting for acceptance of each one. Offers awaiting phone confirmation also occupy a slot. Every five seconds it checks existing offers, accepts verified incoming offers, and refills available slots. New queues begin paused. Closing the browser does not stop the server; use Pause or stop the terminal.

The Steam desktop client does not need to be open. Logging in through this app creates separate Steam sessions. Existing restrictions, CAPTCHA, account limitations, Family View, or additional Steam verification may prevent login or trading. CAPTCHA and Family View unlocking are not implemented. Open Steam directly to resolve account restrictions.

## Return items

This app does not schedule return trades. When Steam makes the items tradable again, switch direction, reload the receiving account's inventory, select them, and start another queue. Received CS2 items are trade protected for seven days; other restrictions may apply. The inventory's tradable flag controls selection. There is no cooldown bypass and no guarantee about how Steam increments any profile trade statistic.

Steam references:
- https://help.steampowered.com/en/faqs/view/365F-4BEE-2AE2-7BDD
- https://help.steampowered.com/en/faqs/view/451E-96B3-D194-50FC

## Optional Alt → Main auto-confirmation

This feature is off by default. Sign into both accounts, verify their SteamIDs, and pause the queue. Expand **Alt → Main: outgoing auto-confirmation**, enter the alt authenticator’s existing base64 `identity_secret`, acknowledge the setting, and enable it for this session. The secret is not the five-character Steam Guard login code and cannot be obtained from a QR login. This app does not extract phone data, enroll a new authenticator, or remove or transfer your existing authenticator. If you do not already have the secret from your own authenticator backup, leave this feature off and use the phone.

The secret stays in process memory, is never returned in app state or written to logs, and is forgotten on sign-out, account replacement, disabling the feature, or server restart. It grants the program confirmation authority for the alt account, so only enter it into your trusted local app. Never enter your main authenticator secret. Changing either account requires enabling the setting again. Browser password managers and operating-system memory handling are outside this app's control.

Only recorded, pending Alt → Main offers are eligible. The app checks the offer ID, sender, recipient, exact single item and amount, and that nothing is requested in return. It then selects only the Trade-type mobile confirmation with the exact offer ID. It does not confirm manual offers, unknown offers, Market listings, Main → Alt sends, or receiver confirmations. Eligible confirmations are attempted at most once every ten seconds across the alt account to reduce confirmation-endpoint load. If the confirmation has not appeared yet, the app waits; if a confirmation fails, the queue pauses for review, or backs off for detected rate limits. A confirmed send is recorded separately from the eventual acceptance/completion of the trade.

**Disable and forget secret** pauses the queue and clears the secret. An already-submitted network operation may finish. Main-account outgoing offers always keep manual phone confirmation.

## Pause, restart, and errors

Pause stops future sends and automatic accepts; a network operation already in progress may finish. Clear unsent removes queued items and pauses, leaving existing offers on Steam. Already-sent offers must be accepted, declined, or canceled on Steam. The app never cancels trades or reverses completed trades.

**Clear transfer queue** pauses the queue, stops unsent items, and removes every row from the active queue. Unresolved sent offers and uncertain sends move into **Tracked unresolved Steam offers**; they are not canceled or forgotten. Full history stays in `data/queue.json` and the activity log. If a network operation is in progress, the queue pauses first and asks you to retry clearing after the operation finishes.

Tracked unresolved offers reserve their exact sending-account SteamID, app, inventory context, and asset ID. They still count toward the five outstanding slots, and their items are disabled in inventory as **Already tracked in Steam offers**. You can create a fresh queue using other items, even if tracked unresolved offers remain. New batches never automatically accept or confirm these archived offers. An uncertain send in the active queue still blocks that queue until resolved or moved to tracking with **Clear transfer queue**.

Use **Check Steam status** to pause and reconcile saved offers without sending, accepting, confirming, or canceling trades. It reports how many offers were checked, resolved, linked, or remain unresolved. Check [Steam sent offers](https://steamcommunity.com/my/tradeoffers/sent/) while signed in to the recorded sender. Finish or cancel any open offers in Steam, then check status again; the status checker releases reserved items and slots only after verifying a terminal result. For an uncertain send, automatic linking requires the exact item and recipient, the app's unique message marker for that send attempt, and an offer timestamp within 60 seconds before or after its saved `attemptedAt` time. Older records without that marker or timestamp require **Link sent offer**, or must stay tracked while you trade other items.

If you already canceled an uncertain offer in Steam and its saved row has no offer ID, pause the queue and choose **I canceled this offer** on that exact row. Confirm the displayed item, asset ID, and sender. This is a local correction based on your confirmation: the app cannot verify cancellation without an offer ID. It marks the record as user-reported canceled, releases the item reservation and outstanding slot, and keeps its history. It does not cancel, send, accept, confirm, or retry any Steam offer. No Steam login is required for this correction; the queue must be paused with no operation in progress. Reload inventory afterward. If you are unsure whether the offer is still active, leave it tracked or use **Link sent offer**.

Status checks and linking find the sending account by its recorded SteamID, even if you signed into the two accounts in opposite dashboard slots. Rows show their actual sender and recipient SteamIDs and the matching current Main/Alt labels. Resuming an active queue still requires the original accounts in their original slots; status recovery does not relax that sending check.

Queue and offer IDs are saved in `data/queue.json`. After restarting, sign in to the same accounts in the same slots, inspect the queue, then resume. If a send timed out or the app closed while sending, it marks the transfer **uncertain**, pauses, and will not retry the item. Check Steam's sent offers and use **Link sent offer** to attach the exact offer ID. The app verifies the sender, recipient, and item before accepting it. If no offer was created, leave the queue paused until you have verified Steam's state. There is deliberately no automatic retry for an uncertain send; the explicit local cancellation correction is available only for a no-ID record you confirm is no longer active. Keep the queue file for recovery and do not edit it while the app runs.

Declined, canceled, expired, invalid, reversed, and held trades pause the queue for review. Trades in escrow are not treated as completed. After resolving the problem, Resume advances to remaining queued items. For an accept that requires confirmation, confirm on the receiver's phone or finish it in Steam; the app waits and does not repeatedly accept it.

## Five-second checks and rate limits

The app normally performs one bulk sent-offer check per active sending account every five seconds, rather than checking each of the five offers separately. Additional requests are needed for inventory, sends, recipient verification, and acceptance. The library's additional automatic offer polling is disabled. Inventory and recipient trade tokens are reused within each refill cycle, and the browser refreshes local status every five seconds without rebuilding unchanged queue rows. Browser status refreshes do not themselves contact Steam.

Valve's published Web API allowance is 100,000 calls per day: https://steamcommunity.com/dev/apiterms. One bulk check every five seconds is 17,280 checks per day for a continuously active sender, before additional requests. This is not a guarantee that every Steam endpoint permits this request rate. Detected HTTP 429 and rate-limit errors during checks or preparation trigger automatic backoff, starting at 30 seconds and doubling up to five minutes, honoring longer Retry-After values when provided. The normal interval returns after a successful cycle. An uncertain send always pauses for manual recovery, including a failed send response reporting a rate limit; the app never blindly resends it.

The cap covers offers tracked by this app. Offers you create elsewhere are not included. Steam can impose its own trade-offer restrictions.

## Saved history and activity log

All queue history is retained in `data/queue.json`; adding new batches no longer drops older records. `data/activity.jsonl` is an append-only activity log with UTC timestamps, account connection events, inventory-load counts, control actions, poll cycles, rate-limit backoff, and every saved transfer-state change. Transfer records include the direction, SteamIDs, item name and asset ID, offer ID, confirmation/acceptance state, and outcome. Errors record their operation category rather than raw authentication responses. On upgrade, existing queue records are imported into the log; earlier event timestamps cannot be reconstructed.

Use **Download activity log** in the queue toolbar to export it. Logs and history survive restarts. They intentionally exclude passwords, Steam Guard codes, login/refresh tokens, cookies, and QR challenges or images. Login sessions are still memory-only. Logs have no automatic deletion or rotation, so disk usage grows over time. Existing offers remain on Steam while the server is stopped; sign back into the same accounts and explicitly Resume to reconcile them.

## Local data and access

The server binds only to `127.0.0.1:3177`, checks Host/Origin, blocks cross-site requests, and requires a per-process request token for changes. Use exactly `http://127.0.0.1:3177`. Do not expose the server through a tunnel or port forward. Other software with access to your Windows session can access a local app.

Passwords, Steam Guard codes, cookies, Steam login tokens, and the optional alt `identity_secret` are kept in process memory by the app; library disk caches are disabled. Browser password managers and operating-system memory handling are outside this app's control. Queue history contains SteamIDs, item identifiers, and offer IDs, without passwords, authenticator secrets, or authentication tokens. Sign out or close the terminal to end the local sessions.

## Development and verification

`npm ci` installs pinned dependencies. `npm test` exercises queue sequencing, restart recovery, and strict recipient acceptance checks using fake accounts. `npm start` starts the local server. Live login, inventory access, trade creation, mobile confirmations, profile-counter behavior, and Steam compatibility require testing with your own accounts. Start with one low-value item. No live trades were made during development.

Code is organized by responsibility:

- `server.js` wires the runtime, worker timer, and shutdown handling; `http-app.js` defines local HTTP routes and request checks.
- `accounts.js` handles Steam login sessions, inventory, and the Steam library calls.
- `trader.js` manages saved queue state, checks outstanding offers, and fills open sending slots.
- `trade-rules.js` contains account roles, offer states, and exact item/offer checks; `retry-policy.js` handles rate-limit detection and delay calculation.
- `activity-log.js` projects only allowed fields into the activity log; `alt-confirmation.js` holds the optional, disabled-by-default alt confirmation setting.
- `public/` contains the browser controls and styles, without a build step.

Tests use fake accounts and temporary data directories. They do not sign into Steam, create live trades, or modify your saved queue or logs. Refactoring keeps the existing HTTP endpoints and queue-file format compatible. Restart the app when you are ready to load code changes; restarting requires signing in again, and saved queues remain paused until resumed.

Built on the maintainers' Steam libraries: https://github.com/DoctorMcKay/node-steam-user and https://github.com/DoctorMcKay/node-steam-tradeoffer-manager. These are unofficial integrations and Steam changes may require updates.
