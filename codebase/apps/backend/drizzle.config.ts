import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Set locally or in CI; never committed (NFR-11.2 / NFR-16.2)
    url: process.env.DATABASE_URL ?? "",
  },
});
