# ERP spec (v0.1) - working title "erp"

India-only ERP for small and mid-size manufacturers. This file is the contract between what is
built and what is planned. Update it in the same change as the code.

References studied: Odoo Community 20.0 (data model: `mrp`, `purchase`, `stock`, `account`,
`l10n_in*`; LGPL-3, used for design only, no code copied) and the public Kyros site (workflow
ideas: approvals enforced in code, 3-way bill match, order-risk board). Nothing here is copied
from either.

## Principles

1. **Money is integer paise.** Quantities and rates are decimals handled with big.js and rounded
   once, half away from zero. No floating-point rupees anywhere.
2. **A company is the isolation boundary.** One legal entity, one GSTIN. Every business row has
   `company_id`; children reference parents with composite foreign keys `(company_id, id)`, so the
   database refuses links across companies.
3. **Evidence is append-only.** `audit_log` rejects UPDATE/DELETE/TRUNCATE (trigger).
4. **Numbers have no gaps.** Document numbers are claimed inside the transaction that saves the
   document; a rollback gives the number back.
5. **Rules live in `src/domain` as pure functions** with tests. Services in `src/server` are thin.
6. **Rates and slabs are data.** GST slabs are a list in `src/domain/gst.ts` to be verified with
   a chartered accountant before go-live, not scattered through logic.
7. **AI proposes, a person confirms** (when agents arrive): approvals are data with per-person
   limits, and the commit step is code, not a prompt.

## Built (milestone 1: foundations + master data)

| Area | Tables | Notes |
|---|---|---|
| Tenancy and people | `companies`, `users`, `memberships` | Roles: owner, admin, accountant, purchase, sales, stores, viewer. `approval_limit_paise` per membership; owner unlimited in code. |
| Audit | `audit_log` | Append-only. Every service writes an entry in the same transaction. |
| Numbering | `number_series` | Per company, document type, financial year. `INV/25-26/00001`; GST documents capped at 16 chars. |
| Parties | `parties` | Customers and suppliers. GSTIN validated offline; state and PAN derived from it. MSME flag, credit days, Tally ledger name. |
| Items | `items`, `uoms` | HSN/SAC 4/6/8 digits, GST slab, GST unit codes, Tally item name, reorder levels. |
| Stock structure | `warehouses`, `locations` | Real shelves plus virtual locations (vendors, customers, production, adjustment, in transit) so every stock move is a balanced transfer. |
| Bill of materials | `boms`, `bom_lines` | Versioned; one active version; cycle detection; scrap percent. |

## Built (milestone 2: inventory)

| Area | Tables / code | Notes |
|---|---|---|
| Stock documents | `stock_documents` | Goods receipt, delivery, transfer, adjustment. Draft -> done or cancelled. Number is taken only when posted (`GRN/25-26/00001`), so cancelled drafts leave no gaps. |
| Stock ledger | `stock_moves` | One balanced transfer of qty from a location to a location, with its money value fixed at posting. On-hand is never stored: it is the sum of done moves. |
| Guards | triggers in `drizzle/0003` | A done or cancelled document and its moves cannot be updated or deleted, and no move can be added to a posted document. Corrections are new documents. |
| Primary location | `locations.is_primary` | Receipts and deliveries use the warehouse's explicit primary location unless a line names one. Never inferred from names. |
| Negative stock | `companies.allow_negative_stock` | Off by default (delivery refused). When on, the shortfall is valued at the item's purchase price. |

Rules (`src/domain/stock.ts`, `src/domain/planning.ts`, `src/server/inventory.ts`):

- **Valuation is weighted-average cost, company-wide per item.** Receipts are valued at their stated
  unit cost; stock leaving is valued at the current average; taking all of an item's stock takes
  exactly all of its value (no rounding residue). Moves between two stock locations do not change
  value. Each move stores its own `value_paise`, so every figure can be traced.
- **Posting is all-or-nothing** and serialised per company (row lock), so two users cannot spend the
  same stock. Lines of one document count against each other.
- **Stock counts** (`createStockCount`) turn counted quantities into an adjustment draft of the
  differences.
- **Reorder suggestions**: when on-hand plus incoming is at or below the item's reorder level,
  suggest the larger of the reorder quantity and the amount needed to reach the level.
- **Shortages** (`calculateShortages`): demand x active BOMs (multi-level, scrap, multi-unit output),
  using stock of finished and semi-finished goods first, then raw material, earliest need first;
  stock used for one demand is not reused for the next. Quantities round up to the unit's decimals.

Known limits of this milestone:

- No batch/lot tracking. Items marked batch-tracked are refused on stock documents rather than
  silently ignored.
- Incoming stock counts as available immediately; its arrival date is ignored in shortages.
- No reversal document yet; a wrong posting is corrected with an adjustment.
- No unit conversions (a stock item has one unit).
- Demand for shortages is supplied by the caller until sales orders exist.
- Valuation is company-wide, not per warehouse.

## Built (milestone 3: sales)

Flow: **order -> deliver -> invoice -> (credit / debit note)**. Draft orders double as quotations.

| Area | Tables / code | Notes |
|---|---|---|
| Orders | `sales_orders`, `sales_order_lines` | Draft -> confirmed (takes `SO/25-26/00001`) -> closed or cancelled. HSN, GST rate and price are copied onto the line. Confirmed orders are frozen by a database trigger; there is no amend, close it and raise a new one. |
| Delivery | `deliverSalesOrder` | Creates and posts a stock delivery in one transaction, so it is all-or-nothing. Delivered quantity is derived from stock moves linked to the order line, never stored. |
| Invoices | `sales_invoices`, `sales_invoice_lines` | Tax invoice, credit note and debit note. Amounts and the customer's details are copied on, and totals must add up (database check). Posting takes the legal number and freezes it (trigger). |
| Board | `getOrderRisks` | Per confirmed order: on time / at risk / late with the reason, and the value still to ship. |

Rules:

- **Goods are invoiced when they have been delivered; services up to the quantity ordered.** Drafts
  count as claims, so two drafts cannot bill the same goods; posting re-checks against posted invoices.
- **Place of supply is the ship-to state** (default: the customer's). Same state as the company: CGST + SGST
  (UTGST in a UT without a legislature); otherwise IGST. Tax is worked out per line; total rounded to the
  rupee with a separate round-off line.
- **Invoice numbers** come from one series per company, kind and financial year, gap-free (a refused
  post uses no number), at most 16 characters. As a safeguard, an invoice cannot be dated earlier than a
  lower-numbered one in the same series.
- **Credit and debit notes** must name a posted tax invoice and a reason, cannot pre-date it, keep its
  place of supply and each line's HSN and rate, and a credit note cannot return more than the line's
  original taxable value (posted and draft credits both count). Price-difference credits are allowed.
- **Orders board**: orders are served from stock earliest-promise-first. An order is at risk when the
  stock left after earlier-promised orders cannot cover what it still needs (finished goods first, then
  the BOM's materials); late once the promised date has passed.
- Sales to **SEZ units and overseas customers are refused** (`UNSUPPORTED_REGISTRATION`) rather than taxed
  wrongly. A company with **no GSTIN cannot issue tax invoices** (`COMPANY_NOT_REGISTERED`).

Known limits of this milestone:

- No separate quotation document, price lists, customer credit limits or order amendments.
- No exports (zero-rated supply), SEZ, reverse charge, TCS, e-invoice (IRN / QR) or e-way bill.
- No bill of supply (for composition dealers or unregistered sellers).
- Credit notes do not return goods to stock; record returned goods with a stock adjustment.
- Credit note time limits and input-tax-credit rules are not enforced.
- Place of supply for services is the ship-to state, which is not always correct under GST.
- Invoices before delivery (advances, bill-to-ship-to) are not supported for goods.
- Payments and receivables ageing come with the next milestone.

## Built (milestone 4: purchasing and approvals)

Flow: **request -> order -> approval -> (sent) -> goods receipt**. Bills and the 3-way match come next.

| Area | Tables / code | Notes |
|---|---|---|
| Requests | `purchase_requests`, `..._lines` | Draft -> submitted (`PR/25-26/00001`) -> closed or cancelled. Can be raised straight from a shortage calculation or from reorder levels. How much is ordered is derived from the order lines pointing at it. |
| Orders | `purchase_orders`, `..._lines` | Draft -> pending approval -> approved -> sent -> closed, or rejected / cancelled. Supplier details and amounts are copied on. Frozen once submitted (trigger); transitions are enforced in code and in the database. |
| Approvals | `approval_requests`, `src/domain/approval.ts` | Approval is data: who asked, the amount, who it waits on, who decided and why. Decided requests can never change and none can be deleted (trigger). |
| Receipt | `receivePurchaseOrder` | Creates and posts a stock goods receipt in one transaction, into the order's warehouse. Received quantity is derived from stock moves linked to the order line. |
| Planning | `openIncoming` | Approved and sent orders count as stock on order, with their expected date, in shortages, reorder suggestions and the orders board. |

Rules:

- **Approval amount is the order total including GST** (the cash being committed); one function to change if
  you prefer before-GST. Within the submitter's own limit, an order is approved on the spot and recorded as
  an automatic approval. Otherwise it is assigned to the next person up the chain: lowest sufficient limit
  first, owners last. Anyone with enough authority may decide it, not only the assignee.
- **Enforced in code**: the decider must belong to the company, must not be the requester, must have a limit that
  covers the amount (owners unlimited, viewers never), and must give a reason to reject. A request can be
  escalated up the chain by the assignee, the requester or an owner, and stops at the top. If nobody has enough
  authority, submission fails (`NO_APPROVER`) instead of waiting forever.
- **Tax on purchases**: supplier state vs. the receiving warehouse's state decides CGST + SGST or IGST. A
  composition or unregistered supplier is taxed at 0 whatever the item says. SEZ and overseas suppliers are
  refused (`UNSUPPORTED_REGISTRATION`).
- **Stock cost excludes GST**: goods are valued at the ordered price after discount; the tax is input credit.
- **No over-receipt**: you cannot receive more than was ordered. Cancel is blocked once goods have arrived
  (close instead). Cancelling a pending order withdraws its approval request.
- **Stock on order in planning**: only approved or sent orders count, and only if they arrive by the date the
  demand needs them. An order waiting for approval is not a commitment.
- Orders are locked in one fixed order (order, then approval) so a decision and a cancellation arriving at the
  same moment cannot deadlock.

Known limits of this milestone:

- Purchase lines are stocked goods only; services and job work are refused for now.
- No RFQ or supplier quote comparison, supplier price lists, or order amendments after submission.
- No tolerance for over-receipt, rejection of goods on receipt, or incoming quality check.
- Imports (customs, foreign currency), reverse charge and TDS are not modelled.
- Approval is single-step. Multi-step workflows (finance then owner) and delegation are not built.
- Bills, the 3-way match and payments are the next milestone; `billed` is not yet a state of an order.

## Built (milestone 5: bills, 3-way match, payments, ageing)

Flow: **supplier bill -> match -> (hold / release / reject) -> post -> pay**, and **invoice -> receipt**.

| Area | Tables / code | Notes |
|---|---|---|
| Bills | `purchase_bills`, `..._lines` | Recorded exactly as printed (including the totals and the supplier GSTIN, even if wrong). Draft -> held or matched -> posted, or rejected / cancelled. Posting takes our voucher number (`PB/25-26/00001`). Frozen once recorded; nothing changes after posting (triggers). |
| Match | `src/domain/matching.ts` | Pure function: the bill against the order and the goods received. |
| Payments | `payments`, `payment_allocations` | Money paid out (`PAY/...`) or received (`RCT/...`). A payment is a fact: never edited or deleted, only reversed with a reason. What it settles is recorded as allocations; the rest is an advance. |
| Ageing | `getPayablesAgeing`, `getReceivablesAgeing` | By party and document, in 0 / 1-30 / 31-60 / 61-90 / 90+ days past due, with advances and credit balances shown separately. |

The three-way match holds a bill, with every reason recorded, when any of these is true:

- the supplier GSTIN is missing (regular supplier), invalid, or not the supplier's on the order;
- billed quantity exceeds what was received and not already billed on other bills;
- billed price exceeds the ordered price (after discount) beyond the company's tolerance;
- the GST rate differs from the order's;
- the bill charges the wrong kind of tax (IGST where CGST + SGST is due, or the reverse), which would cost the
  buyer input tax credit, or the tax amounts differ from what is due;
- the bill's value exceeds what the goods received are worth at the ordered prices;
- the bill does not add up (lines vs. stated value, or total vs. its own parts);
- the same supplier's bill number is already recorded (refused outright, not just held).

Rules:

- **Tolerances are per company** (`bill_rate_tolerance_pct`, `bill_qty_tolerance_pct`, `bill_amount_tolerance_paise`),
  default 0 / 0 / Rs 1 (rounding only).
- **Release from hold** needs a person who did not enter the bill (an owner may release their own), whose approval
  limit covers the bill, and a reason; the original findings stay on record. **Reject** needs a reason and lets the
  supplier's corrected bill be entered under the same number. A bill released by a person is not re-matched at posting;
  one that matched on its own is, in case anything changed since.
- **Payments out are limited by the person's approval limit** (owners unlimited); receipts are not. Viewers cannot
  record anything. A payment can settle only posted bills (or posted invoices and debit notes), only of that party,
  never more than is outstanding, never more than the payment itself. Reversing needs the same authority as paying.
- **Receivables**: an invoice's balance is its total less posted credit notes against it less receipts. Debit notes are
  separate documents with their own due date. Credit beyond what an invoice was worth is shown as a credit balance.
- **Warnings (not blocks), figures kept as data** in `src/domain/ageing.ts`: cash paid to one supplier over Rs 10,000 in a
  day (Income-tax Act s.40A(3)); cash received of Rs 2,00,000 or more in a day (s.269ST); and for suppliers marked MSME,
  the 45-day payment limit (s.43B(h)). Confirm all of these with your chartered accountant.

Known limits of this milestone:

- Bills must be raised against a purchase order, so freight, services, expenses and job work have no bill path yet.
- No supplier credit or debit notes (purchase returns); a posted bill is final.
- No TDS on payments, no bank reconciliation, and no payment approval workflow (recording is the act of paying).
- No check of input tax credit against what suppliers have filed (GSTR-2B), which decides whether credit is claimable.
- Bills are entered by hand; reading a photo or PDF of a bill is a later feature.

### India rules implemented (`src/domain`)

- GSTIN: structure, state code and base-36 checksum (offline; does not prove the GSTIN is active).
- GST state codes including UTs without a legislature (UTGST instead of SGST) and legacy codes.
- Tax per line: intra-state splits CGST + SGST/UTGST evenly (each head rounded separately, so they
  always match); inter-state charges IGST; optional cess. Invoice total rounded to the rupee with a
  separate round-off amount.
- Financial year April-March; "today" taken in IST.
- Display in lakh/crore grouping.

## Built (milestone 6: login, API, dashboard, exports, web app)

**Login and permissions** (`src/server/auth.ts`, `passwords.ts`, `team.ts`, `src/domain/permissions.ts`)
- Passwords hashed with scrypt (parameters stored with the hash); at least 10 characters, not a
  well-known password, not the email. A person given a temporary password must change it first.
- Sessions last 12 hours; only a SHA-256 of the token is stored. The cookie is HttpOnly, SameSite=Lax
  (`erp_session`, Secure behind HTTPS). Changing the password signs out every other session.
- Five wrong passwords lock the account for 15 minutes. Login errors never say whether the email exists.
  A per-address rate limiter sits in front of login and sign-up.
- Roles: owner, admin, accountant, purchase, sales, stores, viewer. One table, `PERMISSIONS`, says which
  role may do which action; the API checks it on every route, the web app hides what a role cannot do,
  and the dashboard is filtered on the server so a role never receives figures it may not see.
  Only an owner can add or remove an owner; the last owner cannot be removed or demoted. An owner or admin
  can set a temporary password for a locked-out colleague (it ends their sessions and forces a change).

**API** (`src/api`, Hono; `app.ts` = auth and safety, `routes.ts` = every business route)
- Every feature is reachable over HTTP: company settings, team, parties, items, units, warehouses, BOMs;
  stock balances, valuation, reorder suggestions, shortages, stock documents and counts; sales orders
  (confirm, deliver, invoice, cancel, close), invoices and credit/debit notes; purchase requests (also from
  shortages and from reorder levels), purchase orders (submit, send, receive), approvals (decide,
  escalate); bills (submit, release, reject, post), payments (record, allocate, reverse); ageing reports,
  audit trail, dashboard, exports.
- The company and the person always come from the session, never from the request body. A client cannot
  attach order-line ids to a stock document. Cross-company ids return "not found".
- Writes must be JSON, within a size limit, and from an allowed origin (a CSRF guard on top of SameSite).
  Security headers include a strict Content-Security-Policy. Errors are `{ error: { code, message } }`.
- Lists are paged (`limit` up to 200, `offset`) and searchable where it makes sense.

**Dashboard** (`src/server/dashboard.ts`): one call, worked out from the same queries the pages use.
Order value at risk and the orders board; low stock (and stock value, for roles that may see money);
purchase orders waiting for approval (with whether *this* person may decide); bills on hold; receivables
and payables ageing with MSME breaches; this month and financial year to date; a six-month sales and
purchases trend; recent activity.

**Exports** (`src/server/exports.ts`, `src/domain/tally.ts`)
- Excel (`exceljs`): eleven sheets (parties, items, stock, valuation, sales orders, sales invoices, purchase
  orders, bills, payments, receivables, payables), money in rupees, real dates, a totals row, credit notes
  shown as negatives. Choose sheets or take all.
- Tally: two XML files, masters (ledgers, stock items) then vouchers (sales, credit and debit notes, purchase,
  payment, receipt). Preview first. Exporting vouchers records each document in `export_batches` /
  `exported_documents` (append-only), so a second export skips what was already sent; a payment reversed
  after export is flagged to be reversed in Tally by hand.
- **The XML has not been imported into a live TallyPrime.** Treat it as a draft mapping.

**Web app** (`web/`, Vite + React; served by the API from `web/dist` so there is one address)
- Sign in, create a company (when the server has sign-up on), change password, company switcher, light and dark
  mode, works at phone width.
- Dashboard (hero number, tiles, board, approvals, held bills, trend and ageing charts, each with a table
  view and keyboard-reachable tooltips).
- Lists: sales orders, invoices, purchase requests, purchase orders, stock movements, payments, customers
  and suppliers, items, audit trail (search, filters, paging).
- Actions: approve, reject or pass up an approval; submit, release, reject, post or cancel a bill;
  create a purchase request from reorder levels; stock on hand, reorder and value; who owes what, by party;
  Excel and Tally exports; people, roles, approval limits and company settings.
- Data entry at every level, each with a draft stage where the rules allow it: customers and suppliers, items,
  bills of materials; sales order (draft, confirm, partial delivery, invoice, post, credit and debit notes);
  purchase request, purchase order (from a request or on its own; submit, send, receive part or all), supplier
  bill (with the totals printed on the paper bill, matched and posted), payments and receipts applied to
  documents or held on account, reversals; stock movements (receipt, delivery, transfer, adjustment) and
  physical counts. Detail pages show lines, tax and what has been delivered, received and billed.
- Not yet in the browser: editing or deactivating a customer, supplier or item after creation (the API has no
  update route for them either), editing a draft document (cancel it and enter it again), and purchase returns.

**Demo data**: `npm run demo` starts the app on `.data/demo`, filled the first time with a small apparel
company (see `src/demo/seed.ts` for the people and the shared password). It has one late, one at-risk and
one on-time order, held and matched bills, approvals waiting, and payments.

## Built (milestone 7: the factory floor)

**Plant layout** (`src/domain/plant.ts`, `src/server/plant.ts`, table `plant_areas`)
- A company's floor is an ordered list of areas (work centres), stored as data: a store, the processes, quality
  check, finished goods, dispatch, and scrap / rework. New companies get a standard ten-area layout; older
  databases get it at start-up. Owners and admins add, rename, reorder and switch areas off.
- Each area IS a stock location. The receiving store is the warehouse's primary location, so goods received
  still land there. Nothing about an area holds a quantity: on-hand, work in progress and scrap are all worked
  out from posted `stock_moves`.
- Material moves between areas with an ordinary transfer document (`movePlantStock`): to the next stage by
  default, backwards for rework, or to a scrap area for rejects. The direction and the source of the entry
  (typed, spoken, scanned) are written to the audit entry. A move can be posted at once or left as a draft for
  the receiving area to confirm; drafts show as "coming in" and "going out" and reduce what is free to move.
- An area cannot be switched off while it holds stock or has a transfer waiting, and the receiving store cannot
  be switched off. "Next stage" skips switched-off areas and never chooses scrap.
- Permissions: `plant.read` (everyone), `plant.move` (owner, admin, stores, purchase), `plant.manage` (owner, admin).

**Web**: *Inventory by area* shows the floor as a flow, then one tab per area in floor order with stock by item,
what is waiting to be processed, transfers coming in and going out, recent movements and a "move to next stage"
button. *Plant layout* is the settings page. Deliveries now ask which area to ship from (dispatch, then finished
goods, by default).

Limits: moving material does not change what the item is. Turning raw material into a finished item (consuming a
bill of materials) is the production order in milestone 8.

## Next, in build order

Each step is finished and tested before the next starts.

1. ~~Inventory~~ - built (milestone 2). Sales orders will feed `calculateShortages`, and purchase
   orders will feed its `incoming`.
2. ~~Sales~~ - built (milestone 3). Payments against invoices come with step 4.
3. ~~Purchasing and approvals~~ - built (milestone 4).
4. ~~Bills, 3-way match, payments~~ - built (milestone 5).
5. ~~Dashboard, login, API and exports~~ - built (milestone 6).
6. ~~Web forms~~ - built: every document can be entered from the browser.
7. **Next**: edit and deactivate master data, edit drafts, import from Excel, print and PDF of invoices and
   purchase orders.

Document states (planned):
- Sales order: draft -> confirmed -> (partly) delivered -> invoiced -> closed | cancelled
- Purchase order: draft -> pending approval -> approved -> sent -> (partly) received -> billed -> closed | cancelled
- Supplier bill: draft -> matched | held -> approved -> paid

## Exports (version 1)

Built; see milestone 6. Not yet done: running a large export as a background job, a connector that pushes
to Tally by itself, and a check against a real Tally copy. Ledgers (parties, GST, round-off) must exist in
Tally first and the company name must equal `companies.tally_company_name`.

## Known gaps and open questions

- The Tally XML is untested against a real TallyPrime. Import into a test company first.
- No "forgot password" email link: an owner or admin sets a temporary password (People and settings), which
  the person must replace at next sign-in. That is refused for a login that also works in another company.
  No two-factor sign-in.
- Rate limiting is per process and in memory; run behind a proxy that limits too if more than one copy runs.
- Master data cannot be edited or deactivated yet, in the browser or the API. A wrong customer or item is fixed
  by creating the right one. Drafts cannot be edited, only cancelled and re-entered.
- No row-level security yet; isolation currently rests on composite foreign keys plus every service
  scoping by `company_id`. Add Postgres RLS before multi-tenant production.
- GST slabs (`GST_RATES_CURRENT`, `GST_RATES_LEGACY`) need confirming with a CA; rates change.
- Place of supply for services, reverse charge, TDS/TCS, e-invoice (IRN) and e-way bills are not
  modelled yet.
- Quantity unit conversions between units are not modelled.
