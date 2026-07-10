# 2Collab Repository Seed Manifest

| Field | Value |
|---|---|
| Package version | `0.1.0` |
| Creation date | `2026-07-10` |
| Target repository | `MTAAP/2Collab` |
| Visibility | Public |
| License | MIT |
| Archive name | `2Collab-repository-seed-2026-07-10.tar.gz` |
| Archive epoch | `1783641600` |

## Purpose

This source package is an implementation-ready repository foundation. It contains the reviewed canonical Product Spec, 14 approved UX mockups, derived architecture and security guidance, accepted repository decisions, a requirement-level acceptance matrix, four executable phase plans, a standalone agent handoff, and a green two-artifact technical baseline.

Copying the package contents into an empty repository produces the intended repository root. No path depends on the source checkout.

## Selected Stack

All package versions are pinned exactly in `package.json` and `bun.lock`.

| Component | Version or contract |
|---|---|
| Bun | `1.3.10` minimum and package manager |
| TypeScript | `7.0.2` |
| Hono | `4.12.29` |
| React and React DOM | `19.2.7` |
| Vite | `8.1.4` |
| Tailwind CSS | `4.3.2` |
| shadcn/ui | Source-owned Radix components, new-york style |
| React Flow | `@xyflow/react` `12.11.2` |
| Zod | `4.4.3` |
| Persistence | Built-in `bun:sqlite` for v1 product implementation |
| Formatting and lint | Biome `2.5.3` |
| Browser testing | Playwright `1.61.1` |

## Source Artifact Hashes

The Product Spec is a byte-for-byte package-time copy of the reviewed canonical source. The PNGs are the 14 active approved mockups.

```text
156973a10cb89d33edae891526f4ac5fb494d9322ddafc0428f9097a15bd89cf  docs/product/PRODUCT-SPEC.md
87487bb3e3c511f4761eb5e96b55f4ca774804a31818b89dc5ad70babb3928d7  docs/ux/mockups/00-product-map.png
a4461639f24af185189b8874e58c7c2c879285b19c3d7276d03b41a057b40dca  docs/ux/mockups/01-command-center.png
b00a5fad93d53eb9e98bcd5043d5cd86fb21b00e147c6e23fd424ef4004d1d85  docs/ux/mockups/02-personal-inbox.png
ea90911f2e91c5f38f5d44e419442747cc7d889054ca7eb08af1825b79bc2b1f  docs/ux/mockups/03-github-work-hub.png
a6387229d96df4065586bd6935284dd494e8a1d8cc02df61a0f2fe3a37091307  docs/ux/mockups/04-github-issue-detail.png
84ae45120412308843978a58c0b7953e9bb55cd2252c66153ac111aefb7d5d59  docs/ux/mockups/05-outline-knowledge-workspace.png
b58cac8e900c1408d2643992622db64861b1b90ceaefdb01ffa89ec8a9ebb1bc  docs/ux/mockups/06-new-run-composer.png
ba4c92a42a80f3dbcccf3ea6f70be219c99796696fa50a4f8d2d4469346635da  docs/ux/mockups/07-live-agent-run.png
8e39a84c970055dc01c4bf7d92f8658d4e89b658254354954eb8ba6300b052e8  docs/ux/mockups/08-workflow-library.png
6d9349712d53ae75a946396a1128c4645df32be9c851b4e8bdc086a5c960d50f  docs/ux/mockups/09-workflow-studio-hybrid.png
ee9e20f2c76665a2e177d503cbc48545a05ba3178b8a64b6a7ff8956f6c34aa6  docs/ux/mockups/10-runner-fleet.png
66c1a1feb07d8f9ad6c31fcb3cd563dd1f0389b762946ac46a5e7aff99714e15  docs/ux/mockups/11-integrations.png
cc3e0c95a9c807575e8c6cf4cff9b90b0a9bcf08e387ced18b74f885aa6075a8  docs/ux/mockups/12-team-auth-settings.png
6f7d78059ddd51e0a785e491cfd8c4ef386d46b6590eb2f717cdbaaed2144c7e  docs/ux/mockups/13-first-run-setup.png
```

`MANIFEST.sha256` covers every regular shipped file except itself in bytewise lexical path order. Its verification tool rejects extra files, missing files, symlinks, non-portable names, and case-colliding paths.

## Verification Contract

Run from the repository root:

```bash
bun ci
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e:run
bun run audit:public
bun run manifest:verify
docker compose config --quiet
docker build -t 2collab-seed:verify .
```

The browser test starts the built production Hono server, proves the static React fallback, and requests the allowlisted `/docs/START-HERE.md` route. Container verification must additionally boot the image with a strong ephemeral `SESSION_SECRET`, poll `/healthz`, verify its JSON contract, and remove the container.

The host-specific `dist/collab` executable proves the build contract but is not shipped in the source archive. Release automation must compile separate platform and architecture artifacts.

## Archive Contract

The deterministic archive is created from the verified manifest inventory with fixed file order, `0644` file mode, UID/GID zero, `root` owner/group labels, the recorded epoch, USTAR headers, and a gzip header without a filename or timestamp. The build creates the archive twice after source-mtime perturbation and requires identical SHA-256 output. A sibling `.sha256` records the transport artifact hash.

The archive contains repository files at its root. It contains no parent directory, absolute path, symlink, device, build output, dependency directory, database, test report, credential, environment file, or host-built executable.

## Intentional Omissions

This seed does not implement passkeys, membership, SQLite schemas, migrations, backups, runners, WebSocket control, Execution Authority, MCP, GitHub, Outline, workflow execution, product screens, data migration, hosted deployment, or legacy API compatibility. Those behaviors begin test-first in the four phase plans.

Creating the public GitHub repository, pushing this package, configuring connectors, publishing releases, and deploying are separate externally authorized operations.
