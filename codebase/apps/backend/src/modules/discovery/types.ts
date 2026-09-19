import { z } from "zod";

// Discovery domain shapes (AR-10.2). Zod first: steps validate their inputs and outputs
// against these, prompts type their structured outputs from them.

/** What a topic looks like once found — by discovery or by targeted research (FR-5.4/5.8). */
export const topicBriefSchema = z.object({
  title: z.string(),
  summary: z.string(),
  whyItMatters: z.string(),
  sourceUrls: z.array(z.string()),
});
export type TopicBrief = z.infer<typeof topicBriefSchema>;

/** A brief that has been persisted to topic_candidates (DR-9.3). */
export const candidateRefSchema = topicBriefSchema.extend({ id: z.string().uuid() });
export type CandidateRef = z.infer<typeof candidateRefSchema>;

/** Search results fetched by the web_search route, injected instead of the model searching. */
export const fetchedResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  publishedDate: z.string().optional(),
});
export type FetchedResult = z.infer<typeof fetchedResultSchema>;
