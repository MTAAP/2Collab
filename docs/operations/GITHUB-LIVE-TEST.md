# GitHub live test prerequisites

The live GitHub journey is destructive and must use an explicitly approved disposable GitHub App
installation, repository, and organization-owned Project. A personal `gh` token is not an
acceptable substitute for the server-side App credential.

Before the journey, create owner-only regular files (`chmod 600`) containing the App private key
and webhook secret. Then set the following exact resource identities:

```text
COLLAB_LIVE_GITHUB=1
COLLAB_GITHUB_APPROVAL_ID=<bounded approval identifier>
COLLAB_GITHUB_APP_ID=<numeric App id>
COLLAB_GITHUB_INSTALLATION_ID=<numeric installation id>
COLLAB_GITHUB_PRIVATE_KEY_FILE=<absolute owner-only file>
COLLAB_GITHUB_WEBHOOK_SECRET_FILE=<absolute owner-only file>
COLLAB_GITHUB_REPOSITORY_ID=<numeric repository id>
COLLAB_GITHUB_REPOSITORY_NODE_ID=<repository node id>
COLLAB_GITHUB_REPOSITORY_OWNER=<owner login>
COLLAB_GITHUB_REPOSITORY_NAME=<repository name>
COLLAB_GITHUB_PROJECT_NODE_ID=<organization Project node id>
COLLAB_GITHUB_PROJECT_OWNER=<organization login>
```

Run `bun run github:live:preflight`. It requests an installation token restricted to the exact
repository and permissions, then performs read-only repository and Project identity checks. It
prints only safe resource identifiers; it never prints App, installation-token, or webhook-secret
material.

Do not run mutation or delivery journeys until this preflight passes and the GitHub App webhook is
configured for `/api/v1/connectors/github/<connector-id>/webhooks` on the test deployment.
