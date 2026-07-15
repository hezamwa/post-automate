# Sanity Studio schema (drop-in copies)

The Studios live in the sites' repo, not here (design §1). Copy into **each** site's Studio:

1. `post.ts` → the site's schema folder; register `post` in the schema index.
2. `author.ts` → only if the site has no `author` document type yet.
3. Deploy the Studio as usual in that repo.

Do this for **both** projects — Waleed (`r9zdt0s0`) and Afnan (`5gz3ngjs`).
The pipeline creates `drafts.post-…` documents and publishes them on approval; the
`author` reference is matched via each profile's `identity.sanityAuthorId` (FR-3.1),
so note each site's author document ID for the profile seed.

Keep these files in sync with docs/design.md §8 — they are the source the copies come from.
