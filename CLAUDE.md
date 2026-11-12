# Notes for working in this repo

India-only ERP for SME manufacturers (working title "erp"). Read `docs/SPEC.md` first; keep it in
sync with the code.

## Commands

- `npm test` - all tests (domain + database; the database tests use in-memory Postgres via PGlite)
- `npm run typecheck`
- `npm run db:generate` - after editing `src/db/schema.ts`, generates the next migration in `drizzle/`.
  For hand-written SQL (triggers, functions) use `npx drizzle-kit generate --custom --name=<name>`.
  Never edit a generated migration that has already been committed.
- `npx tsx src/db/smoke.ts` - checks a file-backed database survives a restart
- `npm run build:web` then `npm start` - the API and the web app on one address (port 3000, data in `.data/pg`)
- `npm run demo` - same, on `.data/demo`, filled the first time with a demo company (people and password in
  `src/demo/seed.ts`). Delete `.data/demo` to reset it. `npm run dev:web` is the Vite dev server (proxies `/api`).

## Stack

TypeScript only. Drizzle ORM on Postgres (PGlite in development, a hosted Postgres in production,
same SQL). zod at boundaries. big.js for decimals. vitest. Hono for the HTTP API (`src/api`); Vite + React
for the web app (`web/`, hash routes, no UI library). exceljs for Excel.

## Rules that must not be broken

- Money is integer paise (`src/domain/money.ts`). Never do arithmetic on floating-point rupees.
- Every business table has `company_id`; child tables use composite foreign keys with it.
- Services run inside `db.transaction` and write an audit entry in the same transaction.
- Document numbers come from `allocateDocNumber(tx, ...)` inside the transaction that saves the document.
- Business rules go in `src/domain` as pure functions with tests; throw `DomainError` with a code
  for anything a user can cause. Tests assert the error code.
- Do not copy code from Odoo (LGPL-3), ERPNext (GPL) or any product's site. Use them for ideas only.
- GST slabs and statutory limits are data to be confirmed by a chartered accountant, not facts.
- API routes are declared with `define(method, path, action, handler)` in `src/api/routes.ts`; `action` is a key of
  `PERMISSIONS` in `src/domain/permissions.ts`. The company and the person come from the session, never from the
  request body. Add the permission, the route, the web check (`can(...)`) and a test together.
- Passwords and tokens: never log or audit them; only a hash of a session token is stored.
- Web UI: money and quantities arrive as paise / decimal text and are formatted, never calculated, in `web/`.
- Do not commit or push unless the owner asks.

## Layout

- `src/domain` - pure rules (money, GSTIN, GST tax, financial year, document numbers, states)
- `src/db` - schema, client, defaults; `drizzle/` holds migrations
- `src/server` - services (company, parties, items, boms, numbering, audit, inventory, stock-queries,
  sales, sales-queries, invoicing)
- Purchasing (`purchasing`, `purchase-requests`, `approvals`, `purchase-queries`, `members`): received and
  ordered quantities are derived from stock moves / order lines, never stored. Approval rules live in
  `src/domain/approval.ts`; always lock the purchase order before its approval request.
- Bills and payments (`bills`, `payments`, `bill-queries`, `ledger-queries`): the three-way match is the pure
  function `threeWayMatch` in `src/domain/matching.ts`; outstanding balances are always derived (total less
  allocations less credit notes), never stored. Lock the purchase order before the bill. Payments are facts:
  reverse, never edit.
- Sales: delivered and invoiced quantities are derived from stock moves / invoice lines linked to an
  order line, never stored. Confirmed orders and posted invoices are immutable (database triggers);
  correct with a credit/debit note. Service functions take a `Transactor`, so one can call another
  inside its transaction (nested calls become savepoints).
- Stock: on-hand is always derived from done `stock_moves`; never store a balance. Posted stock
  documents are immutable (database triggers); fix mistakes with a new document.
- Factory floor (`plant`, rules in `src/domain/plant.ts`): each plant area is a stock location; stock per area,
  WIP and scrap are derived from `stock_moves`. Move material with `movePlantStock` (a transfer document), never by
  writing a quantity. Location names are internal; show the area name.
- Login and people (`auth`, `passwords`, `team`, `company-settings`), `lists` (paged lists for the API),
  `dashboard` (one query set for the home page, filtered by role), `exports` (Excel workbook, Tally XML; exported
  documents are recorded append-only).
- `src/api` - Hono app: `app.ts` (sessions, CSRF/Origin check, headers, rate limits), `routes.ts` (every business
  route), `http.ts` (error mapping, limiter), `server.ts` (serves `web/dist` too).
- `web/` - Vite + React app: `src/pages/*` (Dashboard, Lists, Approvals, Bills, Stock, Ageing, Exports, Team,
  Account; entry and detail pages in Masters, SalesDocs, PurchaseDocs, MoneyDocs, StockDocs), `forms.tsx` (fields,
  line grid, dialog, lookups), `ui.tsx`, `charts.tsx`, `styles.css` (tokens for light and dark). Routes with
  parameters (`/sales/orders/:id`) are listed in `App.tsx`; a page that needs a new right must also be added to
  `PERMISSIONS`. Forms send numbers as text and let the server validate and calculate.
- `src/demo` - demo company seed and the `npm run demo` runner.
- `docs/SPEC.md` - scope, decisions, build order
