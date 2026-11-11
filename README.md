# erp (working title)

India-specific ERP for small and mid-size manufacturers. TypeScript end to end.

Status: milestones 1-5 done (foundations, master data, India GST rules, inventory with stock
ledger and valuation, shortage planning, sales: orders, delivery, GST invoices, credit/debit notes
and an orders board, purchasing: requests, orders, approval limits with escalation, goods receipt,
and money: supplier bills with a three-way match, payments and receipts, payables and receivables
ageing). See
[docs/SPEC.md](docs/SPEC.md) for what exists and what comes next.

## Run it

Needs Node 22 or newer. No database install is required in development.

```bash
npm install
npm test
npm run typecheck
```
