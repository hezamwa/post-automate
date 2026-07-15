// Drizzle schema — design §3. Every user-owned table carries user_id (FR-2.3).
// Sanity is the source of truth for content; this DB owns pipeline state (§9 of requirements).
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const profileStatus = pgEnum("profile_status", ["draft", "active", "superseded"]);
export const onboardingStatus = pgEnum("onboarding_status", ["active", "confirmed", "abandoned"]);
export const runTrigger = pgEnum("run_trigger", ["cron", "manual", "user_topic"]);
export const runState = pgEnum("run_state", [
  "discovering",
  "scoring",
  "drafting",
  "pending_approval",
  "publishing",
  "published",
  "skipped",
  "rejected",
  "expired",
  "failed",
]);
export const candidateSource = pgEnum("candidate_source", ["discovered", "user"]);
export const draftStatus = pgEnum("draft_status", [
  "pending_approval",
  "revising",
  "scheduled",
  "rejected",
  "expired",
  "published",
  "retracted",
]);
export const rejectionCategory = pgEnum("rejection_category", ["quality", "changed_mind", "other"]);
export const publishMode = pgEnum("publish_mode", ["now", "next_slot"]);
export const healthStatus = pgEnum("health_status", [
  "ok",
  "auth_error",
  "quota",
  "rate_limited",
  "model_not_found",
  "timeout",
  "provider_error",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  fcmToken: text("fcm_token"),
  role: userRole("role").notNull().default("user"), // FR-2.5
  // Each creator publishes to their own Sanity project (FR-8.5, OD-10 revised);
  // the Worker resolves the token secret as SANITY_TOKEN_<PROJECTID>
  sanityProjectId: text("sanity_project_id"),
  sanityDataset: text("sanity_dataset").notNull().default("production"),
  // Per-user approval flag (FR-7.1); the medical user must stay false (FR-7.2 — app invariant + seed)
  autoPublish: boolean("auto_publish").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only profile versions (FR-3.10)
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    version: integer("version").notNull(),
    status: profileStatus("status").notNull().default("draft"),
    payload: jsonb("payload").notNull(), // validated against @post-automate/shared profileSchema (§4)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("profiles_user_version").on(t.userId, t.version)],
);

export const onboardingSessions = pgTable("onboarding_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  status: onboardingStatus("status").notNull().default("active"),
  transcript: jsonb("transcript").notNull().default([]),
  partialProfile: jsonb("partial_profile").notNull().default({}),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  // OD-7: purged by the daily dispatcher 30 days after confirmation (DR-9.2)
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  workflowInstanceId: text("workflow_instance_id"),
  profileVersion: integer("profile_version").notNull(),
  trigger: runTrigger("trigger").notNull().default("cron"), // FR-5.8
  userTopic: jsonb("user_topic"), // {title, notes?, links?} for user_topic runs
  state: runState("state").notNull().default("discovering"), // DR-9.4
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// All candidates per run, with scores and rejection reasons (DR-9.3)
export const topicCandidates = pgTable("topic_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => pipelineRuns.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  source: candidateSource("source").notNull().default("discovered"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  sourceUrls: jsonb("source_urls").notNull().default([]),
  score: numeric("score"),
  rejectionReason: text("rejection_reason"),
  selected: boolean("selected").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const drafts = pgTable("drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => pipelineRuns.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  topicId: uuid("topic_id").references(() => topicCandidates.id),
  angle: jsonb("angle"),
  // Editing source-of-truth + diff base until publish; purged on publish/reject/expiry (DR-9.11)
  markdown: text("markdown"),
  sanityDocumentId: text("sanity_document_id"), // after publish: the only copy (DR-9.6)
  status: draftStatus("status").notNull().default("pending_approval"),
  rejectionCategory: rejectionCategory("rejection_category"), // FR-7.8
  publishMode: publishMode("publish_mode"), // FR-7.5
  publishAt: timestamp("publish_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Revision instructions feed profile refinement like edit diffs (FR-7.9, DR-9.12)
export const draftRevisions = pgTable("draft_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id").notNull().references(() => drafts.id),
  revisionNo: integer("revision_no").notNull(), // 1..3
  instructions: text("instructions").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const editDiffs = pgTable("edit_diffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id").notNull().references(() => drafts.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  diff: text("diff").notNull(), // unified diff (FR-6.9, DR-9.5)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-call metering (FR-15.7). user_id NULL = system calls (e.g. health canaries).
export const spendLedger = pgTable("spend_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  runId: uuid("run_id").references(() => pipelineRuns.id),
  taskType: text("task_type").notNull(), // TaskType from @post-automate/shared
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  units: jsonb("units").notNull(), // {inputTokens?, outputTokens?, searches?, images?, seconds?}
  estCostUsd: numeric("est_cost_usd").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Routing config: global default (user_id NULL) + per-user overrides; versioned (FR-15.3, DR-9.8)
export const aiRoutes = pgTable(
  "ai_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id), // NULL = global default
    taskType: text("task_type").notNull(),
    priority: integer("priority").notNull().default(0), // 0 = primary, 1+ = fallbacks (FR-15.6)
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    params: jsonb("params").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_routes_user_task_priority").on(t.userId, t.taskType, t.priority)],
);

// Health-check history with human-readable messages (FR-15.5, DR-9.9)
export const aiHealthChecks = pgTable("ai_health_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  routeId: uuid("route_id").notNull().references(() => aiRoutes.id),
  status: healthStatus("status").notNull(),
  latencyMs: integer("latency_ms"),
  message: text("message").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-user caps (FR-15.8, DR-9.10); global cap lives in app config (FR-15.10)
export const userLimits = pgTable("user_limits", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  monthlyCapUsd: numeric("monthly_cap_usd").notNull().default("10"),
  maxRunsPerDay: integer("max_runs_per_day").notNull().default(2),
  maxReqPerMin: integer("max_req_per_min").notNull().default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
