ALTER TABLE "ai_models" ADD COLUMN "cached_input_per_mtok_usd" numeric;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "cache_write_per_mtok_usd" numeric;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
-- Prompt caching (design §6, spec §3 step 7): the article prompt now sets a cache_control
-- breakpoint after its stable prefix, so cached reads and writes must be priced or the
-- ledger over-counts (spec §9). Anthropic's published discounts: reads at 10% of the
-- input price, 5-minute cache writes at 125%. Only rows still unpriced are touched;
-- an admin-entered price wins. Verify against the current price list when adding models.
UPDATE "ai_models" SET
  "cached_input_per_mtok_usd" = "input_per_mtok_usd" * 0.1,
  "cache_write_per_mtok_usd" = "input_per_mtok_usd" * 1.25
WHERE "provider" = 'anthropic'
  AND "input_per_mtok_usd" IS NOT NULL
  AND "cached_input_per_mtok_usd" IS NULL;
