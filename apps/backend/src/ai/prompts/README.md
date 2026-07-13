# Prompt templates

Composed templates per design §6 — stable blocks first for prompt caching:

```
system = EDITORIAL_RULES + VOICE + AUDIENCE + GUARDRAILS + FEW_SHOT   (cached prefix)
user   = TOPIC_BRIEF (volatile)
```

One module per task type: `interview` · `discovery` · `research` · `scoring` · `angles`
· `article` · `shorten_x` · `translate` · `image` · `refine`.

Changes to files in this folder trigger the golden-set regression in CI (NFR-16.1).
