import { z } from "zod";
import { GateError } from "../../ai/gates";
import { NoRouteError } from "../../ai/router";
import { createDb } from "../../db/client";
import { fetchSources } from "../../modules/discovery";
import { defineStep, RETRY } from "./step";

// Spec §3 step 4: full content for the CHOSEN topic only — one deep fetch instead of ten
// shallow ones, persisted to `sources` so a retried draft never refetches. No route, or a
// failed fetch, is not fatal: the draft grounds on the brief's summary and the reason is
// kept. A user-topic run also fetches the creator's own links (FR-5.8).
export const fetchSourcesStep = defineStep({
  name: "fetch-sources",
  input: z.object({ urls: z.array(z.string()) }),
  output: z.object({ fetched: z.number().int().min(0), skipped: z.string().optional() }),
  bills: "web_search",
  retries: RETRY.ai,
  run: async (ctx, { urls }) => {
    try {
      return await fetchSources(ctx.env, createDb(ctx.env), ctx, [...(ctx.userTopic?.links ?? []), ...urls]);
    } catch (e) {
      if (e instanceof GateError) throw e;
      const skipped = e instanceof NoRouteError ? "no web_search route — the draft grounds on the topic brief only" : e instanceof Error ? e.message.slice(0, 300) : "unknown error";
      console.warn("fetch-sources skipped:", skipped);
      return { fetched: 0, skipped };
    }
  },
});
