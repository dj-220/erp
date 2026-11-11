/** First row of a result that must have one (e.g. after INSERT ... RETURNING). */
export function one<T>(rows: readonly T[], what = "row"): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected a ${what} but the query returned nothing`);
  return row;
}
