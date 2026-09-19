# Prompt blocks

Shared, profile-derived blocks (design §6 "Prompt composition"), stable-first so a
`cache_control` breakpoint after them is meaningful:

```
system = EDITORIAL_RULES + VOICE + AUDIENCE + GUARDRAILS + FEW_SHOT   (cached prefix)
user   = TOPIC_BRIEF (volatile)
```

The builders that assemble a full call — one file per LLM prompt, each exporting a
`PROMPT_VERSION` and a pure `build…(input) => PromptSpec` — live in
[`src/workflows/prompts/`](../../workflows/prompts/). `spec.ts` here defines `PromptSpec`
and `toChatRequest`, the shape the router consumes.

Changes to prompt files trigger the golden-set regression in CI (NFR-16.1).
