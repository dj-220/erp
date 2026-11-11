import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { numberSeries } from "../db/schema";
import { financialYearOf } from "../domain/fy";
import { DEFAULT_SERIAL_PADDING, DOC_TYPES, type DocType, formatDocNumber } from "../domain/numbering";
import { one } from "./util";

/**
 * Hand out the next document number for (company, document type, financial year).
 *
 * It takes a Tx on purpose: the number must be claimed in the same transaction that saves the
 * document. If that transaction rolls back, the counter rolls back too, so numbers stay
 * consecutive with no gaps, which the GST rules require for invoices. The UPDATE locks the
 * series row, so two users issuing at once are serialised and never get the same number.
 */
export async function allocateDocNumber(
  tx: Tx,
  args: { companyId: string; docType: DocType; date: string },
): Promise<string> {
  const fy = financialYearOf(args.date);
  await tx
    .insert(numberSeries)
    .values({
      companyId: args.companyId,
      docType: args.docType,
      fy: fy.label,
      prefix: DOC_TYPES[args.docType].prefix,
      padding: DEFAULT_SERIAL_PADDING,
    })
    .onConflictDoNothing();

  const row = one(
    await tx
      .update(numberSeries)
      .set({ nextSerial: sql`${numberSeries.nextSerial} + 1` })
      .where(
        and(
          eq(numberSeries.companyId, args.companyId),
          eq(numberSeries.docType, args.docType),
          eq(numberSeries.fy, fy.label),
        ),
      )
      .returning({ next: numberSeries.nextSerial, prefix: numberSeries.prefix, padding: numberSeries.padding }),
    "number series row",
  );

  return formatDocNumber({
    docType: args.docType,
    prefix: row.prefix,
    fyShort: fy.short,
    serial: row.next - 1,
    padding: row.padding,
  });
}
