// Apply drizzle/*.sql through the journal (NFR-16.2 — never hand-written SQL against a
// live database). Same source of truth as `drizzle-kit migrate`, but reads DATABASE_URL
// from .dev.vars like the seed script does, so the connection string never has to be
// pasted on a command line.
//   pnpm tsx scripts/migrate.ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { describeUrl, loadDatabaseUrl } from "./db-status";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = loadDatabaseUrl();
  console.log(`migrating: ${describeUrl(url)}`);
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await migrate(drizzle(sql), { migrationsFolder: join(here, "..", "drizzle") });
    const rows = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    console.log(`done — ${rows[0]!.n} migrations recorded`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
