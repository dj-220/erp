import { DomainError } from "./errors";
import type { Paise } from "./money";

/**
 * TallyPrime import files, built as accounting vouchers (party, sales or purchase, tax and
 * round-off ledgers). The shapes follow Tally's published XML import format, but they have NOT been
 * run against a real TallyPrime: import into a test company first. Everything here is pure; the
 * database reading lives in `src/server/tally.ts`.
 */

/** Ledger names the vouchers post to. They are created by the masters file. */
export const TALLY_LEDGERS = {
  sales: "Sales",
  salesReturns: "Sales Returns",
  purchase: "Purchase",
  roundOff: "Round Off",
  bank: "Bank Account",
  cash: "Cash",
  outputCgst: "Output CGST",
  outputSgst: "Output SGST",
  outputUtgst: "Output UTGST",
  outputIgst: "Output IGST",
  outputCess: "Output Cess",
  inputCgst: "Input CGST",
  inputSgst: "Input SGST",
  inputUtgst: "Input UTGST",
  inputIgst: "Input IGST",
  inputCess: "Input Cess",
} as const;

export type BillRefType = "New Ref" | "Agst Ref" | "Advance";

export interface Entry {
  ledger: string;
  /** Debit entries total the same as credit entries in every voucher. */
  debit: boolean;
  amountPaise: Paise;
  /** Bill-by-bill references on a party entry, so receipts and payments settle the right documents. */
  billRefs?: { name: string; type: BillRefType; amountPaise: Paise; creditDays?: number }[];
}

export type VoucherType = "Sales" | "Credit Note" | "Purchase" | "Payment" | "Receipt";

export interface Voucher {
  type: VoucherType;
  /** "YYYY-MM-DD" */
  date: string;
  number: string;
  party: string;
  narration: string;
  reference?: string;
  referenceDate?: string;
  entries: Entry[];
  /** Things the accountant should know about this voucher. */
  warnings: string[];
}

export interface TaxAmounts {
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  utgst: Paise;
  igst: Paise;
  cess: Paise;
  /** Total less taxable and tax; positive when the document total was rounded up. */
  roundOff: Paise;
  total: Paise;
}

/** Every voucher must balance exactly, or Tally refuses it. */
export function assertBalanced(voucher: Voucher): void {
  const debit = voucher.entries.filter((e) => e.debit).reduce((s, e) => s + e.amountPaise, 0);
  const credit = voucher.entries.filter((e) => !e.debit).reduce((s, e) => s + e.amountPaise, 0);
  if (debit !== credit) {
    throw new DomainError("UNBALANCED_VOUCHER", `${voucher.type} ${voucher.number}: debits ${debit} and credits ${credit} differ`);
  }
}

const named = (ledger: string, debit: boolean, amountPaise: Paise): Entry[] => (amountPaise === 0 ? [] : [{ ledger, debit, amountPaise: Math.abs(amountPaise) }]);

function taxEntries(t: TaxAmounts, debit: boolean, names: { cgst: string; sgst: string; utgst: string; igst: string; cess: string }): Entry[] {
  return [
    ...named(names.cgst, debit, t.cgst),
    ...named(names.sgst, debit, t.sgst),
    ...named(names.utgst, debit, t.utgst),
    ...named(names.igst, debit, t.igst),
    ...named(names.cess, debit, t.cess),
  ];
}

/** Round-off posts to the side that makes the voucher balance. */
function roundOffEntry(roundOff: Paise, whenPositiveIsDebit: boolean): Entry[] {
  if (roundOff === 0) return [];
  return [{ ledger: TALLY_LEDGERS.roundOff, debit: roundOff > 0 ? whenPositiveIsDebit : !whenPositiveIsDebit, amountPaise: Math.abs(roundOff) }];
}

export interface SalesDoc extends TaxAmounts {
  kind: "tax_invoice" | "credit_note" | "debit_note";
  number: string;
  date: string;
  partyLedger: string;
  creditDays: number;
  /** For credit and debit notes: the invoice they correct. */
  againstNumber?: string;
  reason?: string;
}

/**
 * A tax invoice or debit note becomes a Sales voucher (customer debited); a credit note becomes a
 * Credit Note voucher (customer credited, Sales Returns debited).
 */
export function salesVoucher(doc: SalesDoc): Voucher {
  const outputs = { cgst: TALLY_LEDGERS.outputCgst, sgst: TALLY_LEDGERS.outputSgst, utgst: TALLY_LEDGERS.outputUtgst, igst: TALLY_LEDGERS.outputIgst, cess: TALLY_LEDGERS.outputCess };
  const isCredit = doc.kind === "credit_note";
  const narration =
    doc.kind === "tax_invoice"
      ? `Tax invoice ${doc.number}`
      : `${doc.kind === "credit_note" ? "Credit" : "Debit"} note ${doc.number} against ${doc.againstNumber ?? "an invoice"}${doc.reason ? `: ${doc.reason}` : ""}`;
  const party: Entry = {
    ledger: doc.partyLedger,
    debit: !isCredit,
    amountPaise: doc.total,
    billRefs: [{ name: doc.number, type: "New Ref", amountPaise: doc.total, creditDays: doc.creditDays }],
  };
  const voucher: Voucher = {
    type: isCredit ? "Credit Note" : "Sales",
    date: doc.date,
    number: doc.number,
    party: doc.partyLedger,
    narration,
    reference: doc.number,
    referenceDate: doc.date,
    warnings: [],
    entries: [
      party,
      ...named(isCredit ? TALLY_LEDGERS.salesReturns : TALLY_LEDGERS.sales, isCredit, doc.taxable),
      ...taxEntries(doc, isCredit, outputs),
      // For a sale the customer pays the rounded total: round-off positive is income (credit).
      ...roundOffEntry(doc.roundOff, isCredit),
    ],
  };
  assertBalanced(voucher);
  return voucher;
}

export interface BillDoc extends TaxAmounts {
  number: string;
  date: string;
  supplierBillNo: string;
  partyLedger: string;
  creditDays: number;
}

/**
 * A supplier bill becomes a Purchase voucher (purchases and input tax debited, supplier credited).
 * If the bill's own printed total does not equal its parts (it was released from hold despite
 * that), the difference is put to Round Off and flagged, so that the voucher still balances.
 */
export function purchaseVoucher(doc: BillDoc): Voucher {
  const inputs = { cgst: TALLY_LEDGERS.inputCgst, sgst: TALLY_LEDGERS.inputSgst, utgst: TALLY_LEDGERS.inputUtgst, igst: TALLY_LEDGERS.inputIgst, cess: TALLY_LEDGERS.inputCess };
  const parts = doc.taxable + doc.cgst + doc.sgst + doc.utgst + doc.igst + doc.cess;
  const roundOff = doc.total - parts; // what makes the parts reach the printed total
  const warnings: string[] = [];
  if (roundOff !== doc.roundOff) {
    warnings.push(`Bill ${doc.supplierBillNo}: the printed total does not equal its parts; the difference of ${(roundOff - doc.roundOff) / 100} rupees is booked to ${TALLY_LEDGERS.roundOff}`);
  }
  const voucher: Voucher = {
    type: "Purchase",
    date: doc.date,
    number: doc.number,
    party: doc.partyLedger,
    narration: `Supplier bill ${doc.supplierBillNo}`,
    reference: doc.supplierBillNo,
    referenceDate: doc.date,
    warnings,
    entries: [
      ...named(TALLY_LEDGERS.purchase, true, doc.taxable),
      ...taxEntries(doc, true, inputs),
      // The buyer owes the printed total: round-off positive is an expense (debit).
      ...roundOffEntry(roundOff, true),
      {
        ledger: doc.partyLedger,
        debit: false,
        amountPaise: doc.total,
        billRefs: [{ name: doc.supplierBillNo, type: "New Ref", amountPaise: doc.total, creditDays: doc.creditDays }],
      },
    ],
  };
  assertBalanced(voucher);
  return voucher;
}

export interface PaymentDoc {
  direction: "paid" | "received";
  number: string;
  date: string;
  mode: string;
  partyLedger: string;
  amountPaise: Paise;
  reference?: string | null;
  /** The bills or invoices it settles, by the name Tally knows them by. */
  settles: { name: string; amountPaise: Paise }[];
}

/** Money out becomes a Payment voucher, money in a Receipt voucher; cash goes to Cash, everything else to the bank. */
export function paymentVoucher(doc: PaymentDoc): Voucher {
  const settled = doc.settles.reduce((s, a) => s + a.amountPaise, 0);
  const billRefs: NonNullable<Entry["billRefs"]> = doc.settles.map((a) => ({ name: a.name, type: "Agst Ref", amountPaise: a.amountPaise }));
  if (doc.amountPaise > settled) billRefs.push({ name: doc.number, type: "Advance", amountPaise: doc.amountPaise - settled });
  const paid = doc.direction === "paid";
  const money = doc.mode === "cash" ? TALLY_LEDGERS.cash : TALLY_LEDGERS.bank;
  const voucher: Voucher = {
    type: paid ? "Payment" : "Receipt",
    date: doc.date,
    number: doc.number,
    party: doc.partyLedger,
    narration: `${paid ? "Paid" : "Received"} by ${doc.mode}${doc.reference ? ` (${doc.reference})` : ""}`,
    warnings: [],
    entries: [
      { ledger: doc.partyLedger, debit: paid, amountPaise: doc.amountPaise, billRefs },
      { ledger: money, debit: !paid, amountPaise: doc.amountPaise },
    ],
  };
  assertBalanced(voucher);
  return voucher;
}

export interface LedgerMaster {
  name: string;
  parent: string;
  /** Bill-by-bill tracking, for customers and suppliers. */
  billwise?: boolean;
  gstin?: string | null;
  registrationType?: string;
  /** For GST ledgers: which head of tax. */
  dutyHead?: "Central Tax" | "State Tax" | "Integrated Tax" | "Cess";
}

/** The fixed ledgers the vouchers rely on. */
export function standardLedgers(): LedgerMaster[] {
  const gst = (name: string, dutyHead: NonNullable<LedgerMaster["dutyHead"]>): LedgerMaster => ({ name, parent: "Duties & Taxes", dutyHead });
  return [
    { name: TALLY_LEDGERS.sales, parent: "Sales Accounts" },
    { name: TALLY_LEDGERS.salesReturns, parent: "Sales Accounts" },
    { name: TALLY_LEDGERS.purchase, parent: "Purchase Accounts" },
    { name: TALLY_LEDGERS.roundOff, parent: "Indirect Expenses" },
    { name: TALLY_LEDGERS.bank, parent: "Bank Accounts" },
    { name: TALLY_LEDGERS.cash, parent: "Cash-in-Hand" },
    gst(TALLY_LEDGERS.outputCgst, "Central Tax"),
    gst(TALLY_LEDGERS.outputSgst, "State Tax"),
    gst(TALLY_LEDGERS.outputUtgst, "State Tax"),
    gst(TALLY_LEDGERS.outputIgst, "Integrated Tax"),
    gst(TALLY_LEDGERS.outputCess, "Cess"),
    gst(TALLY_LEDGERS.inputCgst, "Central Tax"),
    gst(TALLY_LEDGERS.inputSgst, "State Tax"),
    gst(TALLY_LEDGERS.inputUtgst, "State Tax"),
    gst(TALLY_LEDGERS.inputIgst, "Integrated Tax"),
    gst(TALLY_LEDGERS.inputCess, "Cess"),
  ];
}

/** Escape text for XML and drop characters XML cannot carry at all. */
export function xml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const tallyDate = (iso: string) => iso.replaceAll("-", "");
const rupees = (paise: Paise) => (Math.abs(paise) / 100).toFixed(2);
const signed = (paise: Paise, debit: boolean) => `${debit && paise !== 0 ? "-" : ""}${rupees(paise)}`;

function envelope(reportName: string, company: string, messages: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>${xml(reportName)}</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
${messages}   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
}

/** The ledger masters file: import this first, so the vouchers' ledgers exist. */
export function renderMastersXml(args: { company: string; ledgers: readonly LedgerMaster[] }): string {
  const body = args.ledgers
    .map((l) => {
      const lines = [
        `<NAME.LIST><NAME>${xml(l.name)}</NAME></NAME.LIST>`,
        `<PARENT>${xml(l.parent)}</PARENT>`,
        ...(l.billwise ? ["<ISBILLWISEON>Yes</ISBILLWISEON>"] : []),
        ...(l.dutyHead ? ["<TAXTYPE>GST</TAXTYPE>", `<GSTDUTYHEAD>${xml(l.dutyHead)}</GSTDUTYHEAD>`] : []),
        ...(l.registrationType ? [`<GSTREGISTRATIONTYPE>${xml(l.registrationType)}</GSTREGISTRATIONTYPE>`] : []),
        ...(l.gstin ? [`<PARTYGSTIN>${xml(l.gstin)}</PARTYGSTIN>`] : []),
      ];
      return `    <TALLYMESSAGE xmlns:UDF="TallyUDF">\n     <LEDGER NAME="${xml(l.name)}" ACTION="Create">\n${lines.map((x) => `      ${x}\n`).join("")}     </LEDGER>\n    </TALLYMESSAGE>\n`;
    })
    .join("");
  return envelope("All Masters", args.company, body);
}

/** The vouchers file. */
export function renderVouchersXml(args: { company: string; vouchers: readonly Voucher[] }): string {
  const body = args.vouchers
    .map((v) => {
      const entries = v.entries
        .map((e) => {
          const refs = (e.billRefs ?? [])
            .map(
              (r) =>
                `       <BILLALLOCATIONS.LIST>\n        <NAME>${xml(r.name)}</NAME>\n        <BILLTYPE>${r.type}</BILLTYPE>\n${r.creditDays ? `        <BILLCREDITPERIOD>${r.creditDays} Days</BILLCREDITPERIOD>\n` : ""}        <AMOUNT>${signed(r.amountPaise, e.debit)}</AMOUNT>\n       </BILLALLOCATIONS.LIST>\n`,
            )
            .join("");
          return `      <ALLLEDGERENTRIES.LIST>\n       <LEDGERNAME>${xml(e.ledger)}</LEDGERNAME>\n       <ISDEEMEDPOSITIVE>${e.debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>\n       <AMOUNT>${signed(e.amountPaise, e.debit)}</AMOUNT>\n${refs}      </ALLLEDGERENTRIES.LIST>\n`;
        })
        .join("");
      return `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="${xml(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${tallyDate(v.date)}</DATE>
      <VOUCHERTYPENAME>${xml(v.type)}</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${xml(v.number)}</VOUCHERNUMBER>
${v.reference ? `      <REFERENCE>${xml(v.reference)}</REFERENCE>\n` : ""}${v.referenceDate ? `      <REFERENCEDATE>${tallyDate(v.referenceDate)}</REFERENCEDATE>\n` : ""}      <PARTYLEDGERNAME>${xml(v.party)}</PARTYLEDGERNAME>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
      <NARRATION>${xml(v.narration)}</NARRATION>
${entries}     </VOUCHER>
    </TALLYMESSAGE>
`;
    })
    .join("");
  return envelope("Vouchers", args.company, body);
}
