# 0001. Repository layout and V1 archive

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

V2 is a rebuild ([design brief](../design-brief.md)). The V1 code and docs are still useful as reference, especially the parts the brief says to copy (Sanity field mapping, Markdown-to-rich-text conversion, X and LinkedIn OAuth, discovery logic, hero image).

## Decision

- Keep the same repository. V1 lives unchanged in `archive/v1/codebase` and `archive/v1/docs`.
- V2 is organised by deployable:

  ```
  codebase/
    backend/   C# modular monolith (API + jobs)
    admin/     web admin for configuration and monitoring
    mobile/    Flutter app for creators
    deploy/    infrastructure and deployment files
  docs/
    design-brief.md
    decisions/
  ```

- The web admin is named `admin`, not `frontend`, because the mobile app is a frontend too.
- Names follow each platform's conventions:
  - .NET: PascalCase projects under the root namespace `WaleedAlHezam.PostAutomate`.
  - Dart: the package is `post_automate`.
  - iOS: a reverse-DNS bundle id.

## Consequences

- One clone holds V1 for reference and V2 for work.
- CI runs the V1 checks from `archive/v1/codebase` until a V2 pipeline replaces them.
