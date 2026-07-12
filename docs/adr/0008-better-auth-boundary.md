# ADR 0008: Embedded Better Auth boundary

**Status:** Accepted

**Canonical references:** [Authentication Architecture V1](../product/PRODUCT-SPEC.md#authentication-architecture-v1), [Local Passkey Authentication V1](../product/PRODUCT-SPEC.md#local-passkey-authentication-v1)

## Context

Collab's first Foundation implementation built WebAuthn ceremonies, browser sessions, CSRF proofs, OIDC transaction plumbing, and CLI device authorization directly. Live Tailnet dogfood exposed avoidable reverse-proxy URL and tab-local CSRF failure modes. Maintaining that protocol surface competes with Collab's coordination and execution work.

## Decision

Collab embeds exactly pinned Better Auth in the existing Hono/Bun server and SQLite database. Better Auth owns passkey ceremonies, browser-session persistence and revocation, trusted-origin enforcement, provider protocol plumbing, and RFC 8628 CLI device authorization. It remains an internal module in the single `collab-server` artifact, not a separate service.

Every Better Auth user is explicitly linked one-to-one to an immutable Collab Member. Passkey-only users use opaque internal email-shaped values. Email-OTP users may carry the normalized address they actually verified, but it is provider identity data and is never an automatic account-linking or membership key. Password authentication and implicit account linking are disabled.

Collab continues to own bootstrap, invitations, membership, roles, authority epochs, audit, recovery policy, runner identity and pairing, and Execution Authority. Every authenticated request revalidates the linked active Member and authority epoch. Browser and CLI-device sessions have distinct purposes and are rejected across modes.

Better Auth's passkey verification callbacks reject ceremonies that do not report user verification even if the library's underlying default is more permissive. Auth endpoints retain Better Auth's CSRF controls. Collab JSON mutations require a secure host-only SameSite cookie, the exact configured public origin, safe JSON content type, and same-origin Fetch Metadata; no JavaScript-held CSRF bearer is used.

The CLI uses Better Auth's RFC 8628 device flow with one exact client identifier and the closed general CLI scope `collab:cli`. Device codes are short-lived, one-time library records and the returned bearer session is purpose-tagged `CLI_DEVICE`, stored only in the OS credential store, and never accepted as browser or runner identity. The existing separately paired runner key, runner credential, short-lived runner-audience token, and WSS sender constraint remain unchanged.

Better Auth's email-OTP plugin provides the optional second LOCAL login method with implicit signup disabled, hashed codes, five-minute expiry, three attempts, and bounded issuance. Resend is a replaceable delivery adapter whose API key is read from a mounted secret file. Collab owns the registration policy and creates a bounded provisional auth user only after an active invitation or current allowlist authorizes the normalized address. Returning linked Members bypass registration policy but never the active Member or authority-epoch checks. Email equality never links accounts.

## Consequences

Existing pre-v1 browser sessions, passkeys, and CLI-device credentials become inert at migration. Coordination records and immutable Member IDs are preserved. An existing owner rebinds a Better Auth passkey through host-controlled recovery; a new deployment uses a bounded provisional auth identity that has no Collab authority until bootstrap commits.

The standard device plugin stores its random pending code in the auth database until consumption or expiry and issues a bearer session rather than Collab's former custom refresh family. The bounded lifetime, purpose separation, Keychain storage, immediate Member revalidation, TLS transport, and revocation behavior are the accepted v1 tradeoff for using the maintained RFC 8628 implementation.
