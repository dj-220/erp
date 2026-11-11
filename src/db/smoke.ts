/** Quick check that a file-backed database persists across restarts: `npx tsx src/db/smoke.ts` */
import { rmSync } from "node:fs";
import { openDb } from "./client";
import { companies } from "./schema";
import { createCompany } from "../server/company";

const dir = ".data/smoke-pg";
rmSync(dir, { recursive: true, force: true });

const first = await openDb({ dataDir: dir });
await createCompany(first.db, { legalName: "Smoke Co", stateCode: "27", owner: { email: "s@smoke.example", name: "S" } });
await first.client.close();

const second = await openDb({ dataDir: dir }); // re-opens and re-runs migrations (must be a no-op)
const rows = await second.db.select().from(companies);
console.log(`after restart: ${rows.length} company -> ${rows[0]?.legalName}`);
await second.client.close();
rmSync(dir, { recursive: true, force: true });
