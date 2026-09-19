# Workflow layout

`pipeline.ts` is the ordered sequence of steps and gates from
[article-workflow.md §1](../../../../../docs/article-workflow.md#1-at-a-glance) and nothing
else. Order lives here and there only — filenames carry no numbers, so inserting a step is
an edit, not a rename cascade.

| # | File | Spec |
|---|---|---|
| 1 | `steps/gates.ts` — entry gates | [§3 step 1](../../../../../docs/article-workflow.md#3-inside-the-run-step-by-step) |
| 2 | `steps/load-profile.ts` | §3 step 2 |
| 3a | `steps/search.ts` — snippet-only, one search | §3 step 3a |
| 3b | `steps/synthesize-candidates.ts` | §3 step 3b |
| 3c | `steps/score.ts` | §3 step 3c |
| 3d | `steps/research.ts` — user-topic runs only (after `search`) | §3 step 3d |
| 5 | `steps/angles.ts` → `gates/angle.ts` | §3 step 5, §4.3 |
| 7 | `steps/draft.ts` | §3 step 7 |
| 9 | `steps/save-draft.ts` | §3 step 9 |
| 14–16 | `steps/derive-x.ts`, `steps/derive-linkedin.ts`, `steps/translate.ts` *(still before review until the reorder phase)* | §3 steps 14–16 |
| 11 | `steps/hero-image.ts` | §3 step 11 |
| 12 | `steps/write-sanity-draft.ts` | §3 step 12 |
| 13 | `steps/notify.ts` → `gates/draft.ts` + `loops/revise.ts` | §3 step 13, §5 |
| 17 | `steps/publish.ts` | §3 step 17, §6 |
| 18 | `steps/record.ts` | §3 step 18 |

`steps/derive-channel.ts` is the shape the two channel steps share, including the one
corrective pass (its own step) when an answer runs over the channel limit.

Contracts: `steps/step.ts` (`defineStep`, `runStep`, retry policies), `gates/gate.ts`
(`defineGate`, `applyGate`), `gates/options.ts` (the one option shape), `context.ts`
(`RunContext`). Prompts: one file per LLM call in `prompts/`, each exporting a
`PROMPT_VERSION` and a pure builder; the `draft` prompt sets the cache breakpoint after its
stable prefix (design §6).

Invariants (spec §3): one billable call per `step.do`; every step input and output is a
zod schema, re-validated after Workflows deserialisation; emergency flags are re-read on
every step (fresh `createDb` per step); step outputs are ids and references, never bytes.
