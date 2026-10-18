# Security and account safety

This is an unofficial local application that can create real Steam trade offers. Review the code and dependencies before using it, and start with a low-value item. It is not a Valve-hosted login page or an independently audited security product.

## Keep control of your accounts

- Use only accounts you own. Verify both SteamIDs and every item before starting a queue.
- Prefer Steam QR login. Never share sign-in QR codes, passwords, Steam Guard codes, cookies, login tokens, or authenticator secrets.
- Outgoing confirmations are manual by default. The optional alt `identity_secret` grants confirmation authority to this program; leave it disabled unless you understand and accept that risk. Never enter your main account's authenticator secret.
- Bind the app only to localhost. Do not use tunnels, port forwarding, or shared/public hosting for the server.
- Pause before changing accounts. Closing the browser alone does not stop the server; stop its terminal to end the process and local sessions.

## Local files and publishing

`data/` contains account identifiers, item and offer IDs, queue history, backups, and activity logs. Keep it private even though logs intentionally omit authentication secrets. Passwords, login sessions, and optional confirmation credentials remain in process memory; browser, operating-system, and third-party dependency behavior are outside this guarantee.

The repository ignores local data, dependencies, environment files, common key files, and authenticator backups. An ignore file is not a substitute for reviewing files before uploading them. Never attach your real queue, logs, authenticator backups, or screenshots containing sign-in codes to a public issue.

## Rate limits and uncertain trades

Steam can rate-limit individual endpoints. A five-second interval and automatic backoff are not guarantees of safe request rates. If you receive HTTP 429, pause and wait instead of repeatedly retrying. Do not bypass trade locks, account restrictions, or rate limits.

After an uncertain send, inspect Steam before taking further action. Linking a known offer verifies its recipient and item. The **I canceled this offer** option is an explicit local correction based on your report, not a Steam-verified cancellation; use it only after confirming that the offer is no longer active.

## Reporting problems

Do not disclose account credentials or exploitable security details in public issues. Use a private reporting channel with the repository owner for security-sensitive reports. For ordinary bugs, provide a redacted description and reproduction using fake accounts or the automated test fixtures. The test suite does not require real Steam credentials or send real trades.
