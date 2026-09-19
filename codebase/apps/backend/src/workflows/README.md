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
| 3c | `steps/score.ts` → `gates/topic.ts` (pick · free text → `research` · auto) | §3 step 3c, §4.3 |
| 3d | `steps/research.ts` — user-topic runs only (after `search`) | §3 step 3d |
| 4 | `steps/fetch-sources.ts` — full content for the chosen topic only, once per run | §3 step 4 |
| 5 | `steps/angles.ts` → `gates/angle.ts` (pick · free text = a fourth angle · auto) | §3 step 5, §4.3 |
| 6 | `steps/outline.ts` → `gates/outline.ts` (approve · edit sections · free text regenerates) | §3 step 6, §4.3 |
| 7–8 | `steps/draft.ts` → `steps/quality-check.ts` (`loops/quality.ts`: fail → one automatic revise, then proceed with the findings) | §3 steps 7–8 |
| 9 | `steps/save-draft.ts` | §3 step 9 |
| 10 | `steps/image-concepts.ts` → `gates/image.ts` (concept · "no hero image" · custom) | §3 step 10, §4.3 |
| 11 | `steps/hero-image.ts` — the chosen concept; declined when none | §3 step 11 |
| 12 | `steps/write-sanity-draft.ts` | §3 step 12 |
| 13 | `steps/notify.ts` → `gates/draft.ts` + `loops/revise.ts` | §3 step 13, §5 |
| — | `gates/derivatives.ts` — on the approve payload, no pause; ticked kinds → drafts.channels | §4.1 |
| 14–16 | `steps/derive-x.ts`, `steps/derive-linkedin.ts`, `steps/translate.ts` — after approval, from the final markdown, only the ticked channels (`loops/derivatives.ts`; reused on re-approval unless edited) | §3 steps 14–16 |
| — | `gates/publish.ts` — now · next slot · hold (back to the draft gate), derivative texts shown, edits ride along | §4.3, §5 |
| 17 | `steps/publish.ts` | §3 step 17, §6 |
| 18 | `steps/record.ts` | §3 step 18 |

`steps/derive-channel.ts` is the shape the two channel steps share, including the one
corrective pass (its own step) when an answer runs over the channel limit. `direct.ts`
runs approve → derivatives → publish inline for a draft whose instance is gone (spec §5.1),
with the same step definitions.

Contracts: `steps/step.ts` (`defineStep`, `runStep`, retry policies), `gates/gate.ts`
(`defineGate`, `applyGate`, `resolveGate` — spec §4.2: auto takes the recommendation; ask
waits 2 minutes, pushes, 3 days, reminds, 27 days, then abandons the run; `gates/wait.ts`
holds the wait chain, `gates/registry.ts` the answerable gates for the API), `gates/options.ts`
(the one option shape), `context.ts`
(`RunContext`). Prompts: one file per LLM call in `prompts/`, each exporting a
`PROMPT_VERSION` and a pure builder; the `draft` prompt sets the cache breakpoint after its
stable prefix (design §6).

Invariants (spec §3): one billable call per `step.do`; every step input and output is a
zod schema, re-validated after Workflows deserialisation; emergency flags are re-read on
every step (fresh `createDb` per step); step outputs are ids and references, never bytes.
