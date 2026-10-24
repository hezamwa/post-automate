import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "../shared/env";
import * as schema from "./schema";

// One connection source of truth (AR-10.6): Hyperdrive binding in deployed envs,
// DATABASE_URL from .dev.vars locally. postgres.js with prepare:false — required
// behind Hyperdrive/pgbouncer-style pooling.
export function createDb(env: Env) {
  const url = env.DB?.connectionString ?? env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "No database configured — bind Hyperdrive (production) or set DATABASE_URL in .dev.vars (local dev)",
    );
  }
  const client = postgres(url, { max: 5, prepare: false, fetch_types: false });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
