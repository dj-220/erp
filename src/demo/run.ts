/**
 * `npm run demo`: start the app on a separate database that is filled with the demo company the
 * first time. Delete `.data/demo` to start the demo again from scratch.
 */
process.env.SEED_DEMO = "true";
process.env.DATA_DIR ??= ".data/demo";

import("../api/server").catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
