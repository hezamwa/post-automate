import { defineConfig } from "vitest/config";

// Pure Zod schemas — no Worker runtime needed, so the default pool is correct here.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
