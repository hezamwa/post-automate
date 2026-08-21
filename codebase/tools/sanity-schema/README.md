# Sanity Studio schemas — live in the site repos, not here

On 2026-07-16 the pipeline fields were added **directly to each site's Studio source**
(both repos are local on this machine); the drop-in copies that used to live here are gone.

| Site | Studio schema file | Blog type |
|---|---|---|
| waleedalhezam.sa | `codebase/studio/schemaTypes/postType.ts` | `post` |
| afnanalmass.sa | `web/src/sanity/schemaTypes/blogPost.ts` | `blogPost` (fields grouped under "AI Pipeline") |

Fields added to both types:
`aiDisclosure` (boolean) · `xVersion` (text) · `linkedinVersion` (text) ·
`generationMeta { provider, model, promptVersion, pipelineRunId, sourceUrls[] }` (readOnly).

After any Studio-source change, from each studio directory with a logged-in Sanity CLI:

```sh
npx sanity schema deploy   # robot tokens can't do this — needs your CLI login
```

…and redeploy the Studio itself per that repo's process so editors see the new fields.

The pipeline's per-site field mapping (slug/excerpt/alt/date/blogType obligations,
translation strategy per site) is documented in `docs/design.md` §8 and implemented in
`apps/backend/src/modules/publishing/`.
