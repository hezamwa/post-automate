// Seed script (run with: pnpm dlx tsx tools/seed.ts) — TODO(phase-1):
//   1. users: admin (you) + tech creator; medical creator arrives in Phase 2 (auto_publish
//      stays false for medical — FR-7.2)
//   2. profiles: hand-written tech profile validated against profileSchema (§4)
//   3. ai_routes: insert DEFAULT_ROUTES from apps/backend/src/ai/registry.ts (FR-15.3)
//   4. user_limits: defaults ($10/month, 2 runs/day — FR-15.8)
// Idempotent: upsert by natural keys, never duplicate (FR-2.1: users are data, not code).
export {};
