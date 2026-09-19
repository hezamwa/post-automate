-- Retire the 'brave' provider (2026-09-18). It was a registry row and an adapter stub that
-- threw on every call: nothing ever dispatched to adapter.search, so no task could route to
-- it. Tavily replaces it as the search provider, on the two-step path that now exists
-- (router.runSearch → discovery injects results → chat model synthesises, FR-5.4/5.8).
--
-- Guarded rather than unconditional: 'brave' is gone from the PROVIDERS enum in this same
-- deploy, so a surviving route pointing at it would fail validation on every edit while
-- still being live in the routing table. If one exists, stop and let a human decide.
DO $$
DECLARE
  stray record;
BEGIN
  SELECT r.id, r.task_type, r.priority INTO stray
  FROM ai_routes r WHERE r.provider = 'brave' LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ai_routes still points at brave (route % for task %, priority %) — delete that route before removing the provider',
      stray.id, stray.task_type, stray.priority;
  END IF;

  -- Health history is a FK leaf on routes, not on models, so removing the model row leaves
  -- nothing dangling. spend_ledger records provider/model as plain text: past brave spend
  -- (there is none, it never ran) would be preserved either way.
  DELETE FROM ai_models WHERE provider = 'brave';
END $$;
