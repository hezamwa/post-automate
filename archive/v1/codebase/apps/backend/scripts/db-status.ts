// Pre-deploy status of the database in .dev.vars (or DATABASE_URL): which host, which
// migrations are applied, and what is in flight — printed WITHOUT credentials. Run before
// migrating production so a parked Workflow instance is a known, not a surprise.
//   pnpm tsx scripts/db-status.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

export function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const raw = readFileSync(join(here, "..", ".dev.vars"), "utf8");
  const line = raw.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not set (env or .dev.vars)");
  return line.slice("DATABASE_URL=".length).trim();
}

export function describeUrl(url: string): string {
  const u = new URL(url);
  return `${u.username}@${u.hostname}${u.pathname}`;
}

async function main() {
  const url = loadDatabaseUrl();
  console.log(`database: ${describeUrl(url)}`);
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const migrations = await sql`select id, hash, created_at from drizzle.__drizzle_migrations order by created_at`.catch(() => []);
    console.log(`applied migrations: ${migrations.length}`);
    const [runs] = await sql`select count(*)::int as n from pipeline_runs where state in ('discovering','scoring','drafting','pending_approval','publishing') and workflow_instance_id is not null`;
    const [drafts] = await sql`select count(*)::int as n from drafts where status in ('pending_approval','revising')`;
    const [scheduled] = await sql`select count(*)::int as n from drafts where status = 'scheduled'`;
    const [users] = await sql`select count(*)::int as n from users`;
    const [routes] = await sql`select count(*)::int as n from ai_routes where user_id is null and task_type = 'article'`;
    console.log(`users: ${users!.n} · in-flight runs with an instance: ${runs!.n} · undecided drafts: ${drafts!.n} · scheduled drafts: ${scheduled!.n} · global article route rows: ${routes!.n}`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
