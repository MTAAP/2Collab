# Domain Modules

Product behavior begins here in Phase 1. Each module owns a coherent transaction or policy boundary and exposes a narrow typed interface to web, CLI, MCP, scheduler, and transport callers.

Do not add a generic service layer, connector-shaped domain objects, fake repositories, or placeholder classes. Create a module only with its first failing acceptance test and keep SQLite transaction details private to the module that owns the invariant.

The intended boundaries and dependency direction are defined in [`docs/architecture/SYSTEM-ARCHITECTURE.md`](../../docs/architecture/SYSTEM-ARCHITECTURE.md).
