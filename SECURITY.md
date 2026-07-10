# Security Policy

## Reporting a vulnerability

Do not report suspected vulnerabilities through a public issue, discussion, pull request, agent transcript, or shared run log.

Use a [private GitHub security advisory](https://github.com/MTAAP/2Collab/security/advisories/new). Include:

- the affected version or full commit SHA;
- the smallest safe reproduction;
- the expected and observed security boundary;
- impact and preconditions;
- suggested remediation when known; and
- whether any real credentials or third-party systems were involved.

Remove production credentials, personal information, proprietary source, and unrelated logs. If demonstration data is necessary, use a purpose-created disposable environment.

## Supported state

This repository is an implementation foundation and has not declared a production-ready release. Security fixes target the current `main` branch until versioned support windows are published. The absence of a production-ready claim does not reduce the importance of private vulnerability reporting.

## Security boundaries

The canonical boundaries are defined in the [Product Spec](docs/product/PRODUCT-SPEC.md) and [Security Model](docs/security/SECURITY-MODEL.md). In particular:

- trusted Native and Orca processes normally provide `ADVISORY`, not sandbox-enforced, repository assurance;
- developer git, agent, and local tool credentials remain on the runner machine;
- interactive terminal traffic and transcripts remain local;
- the server accepts typed allowlisted runner operations rather than remote shell commands;
- GitHub and Outline remain authoritative for their source state and permissions; and
- cancellation or credential revocation is not proof that arbitrary code on an unreachable trusted host stopped.

Reports that demonstrate a boundary violation, privilege escalation, credential exposure, source overwrite, authorization bypass, cross-project disclosure, archive traversal, or unsafe runner command path are especially useful.

## Coordinated disclosure

Please allow maintainers to investigate and prepare a fix before public disclosure. Maintainers will communicate status through the private advisory and will credit reporters when requested and appropriate.

