import { z } from "zod";
import { createDb } from "../../db/client";
import { discoveryQuery, searchSnippets } from "../../modules/discovery";
import { fetchedResultSchema } from "../../modules/discovery/types";
import { profileOf } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 3a: snippet-only search — titles and summaries, never full pages. The
// cheapest call in the run. No query = the profile's interests (scheduled/manual runs);
// a user-topic run searches its own title. null results = no web_search route or the
// route failed, and the next step lets the model search for itself (FR-5.4).
export const search = defineStep({
  name: "search",
  input: z.object({ query: z.string().min(1).optional() }),
  output: z.object({ results: z.array(fetchedResultSchema).nullable() }),
  bills: "web_search",
  retries: RETRY.ai,
  run: async (ctx, { query }) => ({
    results: await searchSnippets(ctx.env, createDb(ctx.env), ctx, query ?? discoveryQuery(profileOf(ctx))),
  }),
});
