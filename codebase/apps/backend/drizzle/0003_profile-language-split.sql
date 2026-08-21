ALTER TABLE "profiles" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- v1 → v2 backfill (design §4 "Schema evolution", DR-9.15): the `language` enum splits
-- into `primaryLanguage` + opt-in `translation` (FR-3.7, FR-3.13). The old value cannot
-- be carried over mechanically — "bilingual" never said which language was primary — so
-- the answers are hard-coded per the 2026-08-21 decision: both known creators, keyed by
-- their documented Sanity projects (design §8), write in English with translation off.
-- Any row that decision does not cover fails the migration loudly instead of being
-- guessed at — including rows of a user added after the decision was taken, and rows
-- whose payload does not carry the v1 shape this backfill expects.
DO $$
DECLARE
  orphan record;
BEGIN
  UPDATE profiles p
  SET payload = (p.payload - 'language')
        || jsonb_build_object(
             'primaryLanguage', 'en',
             'translation', jsonb_build_object('enabled', false)),
      schema_version = 2
  FROM users u
  WHERE u.id = p.user_id
    AND u.sanity_project_id IN ('r9zdt0s0', '5gz3ngjs')
    AND p.schema_version = 1
    AND p.payload ? 'language';

  SELECT p.id, p.user_id INTO orphan FROM profiles p WHERE p.schema_version = 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'profiles v1->v2 backfill: no primaryLanguage decision for profile % (user %) — decide it explicitly before migrating (design §4, DR-9.15)',
      orphan.id, orphan.user_id;
  END IF;
END $$;
