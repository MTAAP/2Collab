# 2Collab

2Collab is a self-hosted coordination surface for solo developers and 1-3 person teams working with local coding agents. The shared service coordinates work, authority, evidence, and integrations; trusted developer machines execute agent runtimes locally.

This repository contains substantial local implementations of Foundation, GitHub coordination, Outline collaboration, and bounded automation. It is not yet a production-complete v1: local tests and fixture journeys are implementation proof, while the two-machine/seven-day Foundation observation and provider-backed GitHub, Outline, and real-PR automation exits remain external acceptance obligations.

## Start here

Read these documents in order:

1. [Documentation entry point](docs/START-HERE.md)
2. [Decision precedence](docs/DECISION-PRECEDENCE.md)
3. [Canonical Product Spec](docs/product/PRODUCT-SPEC.md)
4. [System architecture](docs/architecture/SYSTEM-ARCHITECTURE.md)
5. [Domain model](docs/architecture/DOMAIN-MODEL.md)
6. [Execution authority](docs/architecture/EXECUTION-AUTHORITY.md)
7. [Security model](docs/security/SECURITY-MODEL.md)
8. [UX foundation and mockups](docs/ux/README.md)
9. [Acceptance matrix](docs/acceptance/ACCEPTANCE-MATRIX.md)
10. [Master implementation plan](docs/plans/00-MASTER-IMPLEMENTATION-PLAN.md)
11. [Implementation handoff](agent_docs/IMPLEMENT.md)

The [Product Spec](docs/product/PRODUCT-SPEC.md) is canonical. Derived guidance, plans, ADRs, mockups, and code must not silently override it.

## Repository shape

- `src/server` contains the import-safe Hono service, coordination modules, connector adapters, authority enforcement, and durable workflow services.
- `src/cli` contains the local `collab` command entry point.
- `src/shared` contains stable cross-entry-point types and metadata.
- `src/web` contains the React application and source-owned shadcn/ui components.
- `docs` contains the canonical specification, derived architecture, accepted decisions, UX evidence, acceptance criteria, and implementation plans.
- `tests` contains unit, integration, protocol, runner, drill, and browser journeys. Passing fixtures never promote a live acceptance row.
- `scripts` contains portable Bun-based contributor and release checks.

## Prerequisites

- Bun 1.3.10
- Docker with Compose v2 for the container path
- Chromium installed through Playwright for browser verification

## Local development

```bash
bun ci
bun run dev
```

The web development server binds to `127.0.0.1`. The coordination server also defaults to loopback in development.

Useful checks:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e
bun run audit:public
```

`bun run build:cli` produces a binary for the current operating system and architecture. Do not treat that host-native output as a portable release artifact.

Evidence validators are available through `bun run evidence:verify`, `bun run github:evidence:validate`, `bun run outline:evidence:validate`, and `bun run automation:evidence:validate`. Live promotion additionally requires a clean, exact-revision evidence envelope with artifact, lockfile, manifest, report, and reviewer provenance.

## Container development

The exact configuration gate is self-contained and does not require secrets:

```bash
docker compose config --quiet
```

Before starting the container, copy the example environment, replace the session secret with at least 32 random characters, and create the configured secret files. Empty/default configuration values make inspection possible but remain invalid at runtime:

```bash
cp .env.example .env
docker compose up --build
```

Compose publishes the service on `127.0.0.1:3210` by default and stores future service state in the `collab-data` named volume. Set `COLLAB_BIND_HOST` deliberately if an ingress design requires another bind address. Tailscale Serve and Cloudflare Tunnel can normally reach the loopback default without exposing the port on every host interface.

Check the service:

```bash
curl --fail http://127.0.0.1:3210/healthz
```

## Security boundary

Native and Orca runners execute as their machine owner. Unless a future execution adapter provides enforceable isolation, repository restrictions are `ADVISORY`, not a sandbox guarantee. The server never receives developer git credentials, arbitrary executable commands, interactive terminal traffic, or durable raw agent transcripts.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before changing behavior. Contributions should be test-first, narrowly scoped, and backed by exact verification evidence.

## License

2Collab is available under the [MIT License](LICENSE).
