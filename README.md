# erp (working title)

India-specific ERP for small and mid-size manufacturers. TypeScript end to end.

Status: milestones 1-6 done. Master data and India GST rules; inventory with a stock ledger and valuation;
shortage planning; sales (orders, delivery, GST invoices, credit and debit notes, an orders board); purchasing
(requests, orders, approval limits with escalation, goods receipt); money (supplier bills with a three-way
match, payments and receipts, payables and receivables ageing); and now login with roles, an HTTP API for
every feature, a combined dashboard, Excel and Tally exports, and a web app. See
[docs/SPEC.md](docs/SPEC.md) for exactly what exists, what does not, and what comes next.

## Run it

Needs Node 22 or newer. No database install is required in development.

```bash
npm install
npm test
npm run typecheck
```

### See it working

```bash
npm run build:web
npm run demo
```

Open <http://localhost:3000> and sign in as the owner, `rajiv@sunrise.example`. The other demo people (purchase,
accountant, sales, stores, viewer) and the shared demo password are in `src/demo/seed.ts`; sign in as different
people to see how roles change what is shown. The demo database lives in `.data/demo`; delete that folder to start over.

### Run it for real

```bash
npm run build:web
npm start
```

Settings come from the environment:

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DATA_DIR` | Where the database is kept (default `.data/pg`) |
| `ALLOW_SIGNUP` | `true` lets anyone create a company and an owner login (default off) |
| `SECURE_COOKIES` | `true` when served over HTTPS |
| `TRUST_PROXY` | `true` when behind a reverse proxy you control (so the client address can be read) |
| `ALLOWED_ORIGINS` | Extra origins allowed to make changes, comma separated (for a separate dev server) |
| `SEED_DEMO` | `true` fills an *empty* database with the demo company |

With sign-up off (the default), people are added by an owner under *People and settings*. To create the very
first company, start once with `ALLOW_SIGNUP=true`: the sign-in page then offers *Create a company*. Turn it off
again afterwards, because while it is on anyone who can reach the server can create a company.

For web development, `npm start` (or `npm run demo`) in one terminal and `npm run dev:web` in another, then open
<http://localhost:5173>; the dev server forwards `/api` to port 3000.

## Things to know before relying on it

- The Tally XML export has not been imported into a real TallyPrime yet. Try it on a test company first.
- GST rates, the MSME payment limit and other statutory figures are data to be confirmed by a chartered accountant.
- You can enter everything in the web app (customers, items, orders, deliveries, invoices, purchasing, bills,
  payments, stock). Customers, suppliers and items cannot be edited after you save them yet, so check them before saving.
- Stop the server with Ctrl+C. Ending it any other way can leave the file database unable to open; if that
  happens to the demo, delete `.data/demo`.
