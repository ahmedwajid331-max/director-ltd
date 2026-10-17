// Side-effect import. Put it FIRST in any test/script that writes to the database:
//   import "../support/require-scratch-db";
// It throws before any PrismaClient is created if DATABASE_URL is not an
// explicitly isolated scratch/test database (see scratch-db-guard.ts).
import { assertScratchDatabase } from "./scratch-db-guard";

const target = assertScratchDatabase();
console.log(`[safety] scratch database confirmed: ${target}`);
