# Workflow layout

`pipeline.ts` is the ordered sequence of steps and gates from
[article-workflow.md §1](../../../../../docs/article-workflow.md#1-at-a-glance) and nothing
else. Order lives here and there only — filenames carry no numbers, so inserting a step is
an edit, not a rename cascade.

| # | File | Spec |
|---|---|---|
| 1 | `steps/gates.ts` — entry gates | [§3 step 1](../../../../../docs/article-workflow.md#3-inside-the-run-step-by-step) |
| 2 | `steps/load-profile.ts` | §3 step 2 |
| 3 | `steps/discover.ts` *(temporary, v1 — becomes `search` + `synthesize-candidates`)* | §3 steps 3a–3b |
| 3c | `steps/score.ts` | §3 step 3c |
| 3d | `steps/research.ts` — user-topic runs only | §3 step 3d |
| 5 | `steps/angles.ts` → `gates/angle.ts` | §3 step 5, §4.3 |
| 7 | `steps/draft.ts` | §3 step 7 |
| — | `steps/derivatives.ts` *(temporary, v1 — moves after approval as `derive-x`, `derive-linkedin`, `translate`)* | §3 steps 14–16 |
| 9 | `steps/save-draft.ts` | §3 step 9 |
| 11–12 | `steps/create-sanity-draft.ts` *(temporary, v1 — becomes `hero-image` + `write-sanity-draft`)* | §3 steps 11–12 |
| — | `steps/record-derivatives.ts` *(temporary, v1)* | DR-9.14 |
| 13 | `steps/notify.ts` → `gates/draft.ts` + `loops/revise.ts` | §3 step 13, §5 |
| 17 | `steps/publish.ts` | §3 step 17, §6 |
| 18 | `steps/record.ts` | §3 step 18 |

Contracts: `steps/step.ts` (`defineStep`, `runStep`, retry policies), `gates/gate.ts`
(`defineGate`, `applyGate`), `gates/options.ts` (the one option shape), `context.ts`
(`RunContext`). Prompts: one file per LLM call in `prompts/`, each exporting a
`PROMPT_VERSION` and a pure builder.

Invariants (spec §3): one billable call per `step.do`; every step input and output is a
zod schema, re-validated after Workflows deserialisation; emergency flags are re-read on
every step (fresh `createDb` per step); step outputs are ids and references, never bytes.
