# Payment List

Secure Node.js application for viewing and exporting ArmSoft Corporate API account statements.

## Local setup

1. Install Node.js 18 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and configure the values.
4. Run `npm start`.

The browser authenticates with a server-verified Google ID token and then a six-digit TOTP code. A new TOTP enrollment is stored only after its first successful code verification. Bank credentials and access tokens remain server-side.

## Required production configuration

```env
NODE_ENV=production
PUBLIC_ORIGIN=https://payment-lits.duckdns.org
BANK_API_BASE_URL=https://bank.example.am/OnlineBanking/CorporateApi
BANK_ACCESS_KEY=...
BANK_APPLICATION_NAME=payment-list
GOOGLE_CLIENT_ID=...
GOOGLE_ALLOWED_EMAILS=user1@example.com,user2@example.com
AUTH_ENCRYPTION_SECRET=<at-least-32-random-characters>
HOST=127.0.0.1
PORT=3000
```

The server connects directly to the bank API. HTTP proxy and SSH jump-host settings are intentionally unsupported.

## API

- `GET /api/health`
- `GET /api/accounts`
- `GET /api/accounts/:accountNumber/transactions?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`
- `GET /api/accounts/:accountNumber/transactions.xlsx?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`

Dates are strict calendar dates. `dateTo` includes the full final UTC day, and a request may cover at most 366 days.

## Verification

```bash
npm test
npm audit --omit=dev
```

Production deployment should terminate TLS at a reverse proxy, forward only to the localhost listener, preserve the `data/` directory between releases, and run the Node process under a process manager.
