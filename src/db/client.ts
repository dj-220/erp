import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Open a database and bring it up to the latest migration.
 * PGlite is real Postgres running inside Node, so development needs no install.
 * Pass `dataDir` for a persistent database (e.g. ".data/pg"), or omit it for in-memory.
 * Production swaps this for a hosted Postgres connection; the schema and SQL are the same.
 */
export async function openDb(options: { dataDir?: string } = {}) {
  // PGlite will not create missing parent folders itself.
  if (options.dataDir) mkdirSync(dirname(options.dataDir), { recursive: true });
  const client = new PGlite(options.dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

export type Db = Awaited<ReturnType<typeof openDb>>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the database itself or a transaction. */
export type Executor = Db | Tx;
/**
 * Anything that can open a transaction: the database, or a transaction that is already open
 * (the new one then becomes a savepoint inside it). This is how one operation, such as
 * delivering an order, can create and post a stock document and still be all-or-nothing.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Postgres SQLSTATE of a failed query, however the driver wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
