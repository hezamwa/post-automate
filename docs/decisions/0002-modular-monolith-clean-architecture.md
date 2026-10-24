# 0002. Modular monolith with Clean Architecture and DDD

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

The brief splits the product into bounded contexts: Creators, Catalog, Authoring, Publishing, AI Gateway and Observability. It also asks for features that can change inside one module without ripple effects. Two creators don't justify running separate services.

## Decision

- **One deployable:** a C# / ASP.NET Core application on .NET 10, the `WaleedAlHezam.PostAutomate` solution.
- **Modules:** each module has six projects:

  | Project | Holds | References |
  | --- | --- | --- |
  | `<Module>.Domain` | aggregates, value objects, typed ids | SharedKernel |
  | `<Module>.Contracts` | the module's public surface: commands, queries, integration events | SharedKernel |
  | `<Module>.Application` | use cases and the ports Infrastructure implements | its Domain and Contracts, BuildingBlocks.Application |
  | `<Module>.Infrastructure` | provider-neutral persistence and external clients | its Application, BuildingBlocks.Infrastructure |
  | `<Module>.Infrastructure.PostgreSql` | engine-specific code and migrations ([0004](0004-database.md)) | its Infrastructure, BuildingBlocks.Infrastructure.PostgreSql |
  | `<Module>.Presentation` | HTTP endpoints and SSE streams | its Application |

- **Module boundaries:** a module may reference another module's `Contracts` only. It refers to the other module's records by plain `Guid`.
- **SharedKernel:** pure C# with no package references. It holds `Entity`, `AggregateRoot`, the typed-id base, domain events, `Result`, and the value objects at least two modules share with the same meaning.
- **BuildingBlocks.Application and BuildingBlocks.Infrastructure:** technical plumbing only, not business concepts.
- **Host:** the composition root. It references every Presentation project and the provider projects.
- **Enforcement:** `ArchitectureTests` will enforce these rules at build time. The project exists; the tests are not written yet.

## Consequences

- Dependencies point inward to the domain, and the project references make that visible.
- A module can later move into its own service with little change, because modules share no internals and no foreign keys.
- More projects to manage. Central package management and shared build properties keep each project file small.
