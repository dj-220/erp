import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { openDb } from "../db/client";
import { todayIST } from "../domain/fy";
import { ensureDefaultPlantAreas } from "../server/plant";
import { createApp } from "./app";

/**
 * Starts the API, and the web app if it has been built (`npm run build:web`).
 *
 * Settings come from the environment:
 *   PORT              port to listen on (default 3000)
 *   DATA_DIR          where the database lives (default .data/pg)
 *   ALLOW_SIGNUP      "true" lets anyone create a company and owner login (default off)
 *   SECURE_COOKIES    "true" when served over HTTPS (default off)
 *   ALLOWED_ORIGINS   comma-separated extra origins allowed to make changes (e.g. a dev server)
 *   TRUST_PROXY       "true" when behind a reverse proxy you control
 *   SEED_DEMO         "true" fills an EMPTY database with the demo company
 */
async function main() {
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  const { db } = await openDb({ dataDir: env.DATA_DIR ?? ".data/pg" });

  if (env.SEED_DEMO === "true") {
    const { companies } = await import("../db/schema");
    const { seedDemo, DEMO_COMPANY } = await import("../demo/seed");
    if ((await db.select({ id: companies.id }).from(companies).limit(1)).length === 0) {
      await seedDemo(db, todayIST());
      console.log(`Filled the empty database with the demo company "${DEMO_COMPANY}".`);
    }
  }

  // Databases from before plant areas existed get the standard floor once.
  const floors = await ensureDefaultPlantAreas(db);
  if (floors > 0) console.log(`Added the standard plant layout to ${floors} compan${floors === 1 ? "y" : "ies"}.`);

  const app = createApp(db, {
    allowSignup: env.ALLOW_SIGNUP === "true",
    secureCookies: env.SECURE_COOKIES === "true",
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === "true",
  });

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  if (existsSync(webRoot)) {
    const readIndex = () => readFileSync(join(webRoot, "index.html"), "utf8");
    // In production the page is read once; elsewhere it is re-read so a rebuild shows up without a restart.
    const cached = env.NODE_ENV === "production" ? readIndex() : null;
    app.use("/assets/*", serveStatic({ root: "./web/dist" }));
    // Any other page is the single-page app; it decides what to show.
    app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(cached ?? readIndex())));
  }

  serve({ fetch: app.fetch, port }, (info) => console.log(`ERP listening on http://localhost:${info.port}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
