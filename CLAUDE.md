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

## Stack

TypeScript only. Drizzle ORM on Postgres (PGlite in development, a hosted Postgres in production,
same SQL). zod at boundaries. big.js for decimals. vitest. A Next.js frontend comes later.

## Rules that must not be broken

- Money is integer paise (`src/domain/money.ts`). Never do arithmetic on floating-point rupees.
- Every business table has `company_id`; child tables use composite foreign keys with it.
- Services run inside `db.transaction` and write an audit entry in the same transaction.
- Document numbers come from `allocateDocNumber(tx, ...)` inside the transaction that saves the document.
- Business rules go in `src/domain` as pure functions with tests; throw `DomainError` with a code
  for anything a user can cause. Tests assert the error code.
- Do not copy code from Odoo (LGPL-3), ERPNext (GPL) or any product's site. Use them for ideas only.
- GST slabs and statutory limits are data to be confirmed by a chartered accountant, not facts.
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
- `docs/SPEC.md` - scope, decisions, build order
