import { z } from "zod";
import { createDb } from "../../db/client";
import { getActiveProfile } from "../../modules/profiles";
import { pinnedProfileSchema } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 2: pins the ACTIVE profile version for the whole run, gate settings included.
export const loadProfile = defineStep({
  name: "load-profile",
  input: z.object({}),
  output: pinnedProfileSchema,
  retries: RETRY.io,
  run: async (ctx) => getActiveProfile(createDb(ctx.env), ctx.userId),
});
