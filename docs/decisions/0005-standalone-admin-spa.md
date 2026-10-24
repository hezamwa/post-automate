# 0005. Standalone admin SPA

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

The admin is used to configure the system and monitor it: routes, spend, activity, errors, creators and limits. One option was Blazor WebAssembly inside the backend solution, sharing C# contract types.

## Decision

- The admin is a standalone single-page app in its own project at `codebase/admin`, outside the backend solution.
- It talks to the backend only through the HTTP API, using a client generated from the backend's OpenAPI document. The mobile app uses the same approach.
- **Open:** its framework and its hosting ([0003](0003-oracle-cloud-hosting.md)).

## Consequences

- The backend's OpenAPI document is the contract for both clients, so it must be complete and stable.
- The admin can be built, tested and deployed on its own.
- There are no shared C# types. The generated client keeps the admin in step with the API.
