import { DomainError } from "./errors";

/**
 * Document types and their number prefixes. Documents the GST rules cover (invoices,
 * credit/debit notes, delivery challans) must have a consecutive serial of at most 16
 * characters, using only letters, digits, "-" and "/", unique within a financial year.
 */
export const DOC_TYPES = {
  sales_quote: { prefix: "QT", gst: false },
  sales_order: { prefix: "SO", gst: false },
  sales_invoice: { prefix: "INV", gst: true },
  credit_note: { prefix: "CN", gst: true },
  debit_note: { prefix: "DN", gst: true },
  delivery_challan: { prefix: "DC", gst: true },
  purchase_request: { prefix: "PR", gst: false },
  purchase_order: { prefix: "PO", gst: false },
  goods_receipt: { prefix: "GRN", gst: false },
  delivery: { prefix: "DEL", gst: false },
  stock_transfer: { prefix: "TRF", gst: false },
  purchase_bill: { prefix: "PB", gst: false },
  payment: { prefix: "PAY", gst: false },
  receipt: { prefix: "RCT", gst: false },
  stock_adjustment: { prefix: "ADJ", gst: false },
} as const;

export type DocType = keyof typeof DOC_TYPES;

export const DEFAULT_SERIAL_PADDING = 5;

export function isValidGstDocumentNumber(value: string): boolean {
  return /^[A-Za-z0-9/-]{1,16}$/.test(value);
}

/** e.g. INV/25-26/00001 */
export function formatDocNumber(args: {
  docType: DocType;
  prefix?: string;
  fyShort: string;
  serial: number;
  padding?: number;
}): string {
  const { docType, fyShort, serial } = args;
  if (!Number.isSafeInteger(serial) || serial < 1) {
    throw new DomainError("INVALID_SERIAL", "Serial must be a positive whole number");
  }
  const prefix = args.prefix ?? DOC_TYPES[docType].prefix;
  const number = `${prefix}/${fyShort}/${String(serial).padStart(args.padding ?? DEFAULT_SERIAL_PADDING, "0")}`;
  if (DOC_TYPES[docType].gst && !isValidGstDocumentNumber(number)) {
    throw new DomainError(
      "DOC_NUMBER_TOO_LONG",
      `${number} breaks the GST rule of at most 16 characters (letters, digits, "-" and "/"). Shorten the prefix.`,
    );
  }
  return number;
}
