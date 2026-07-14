# Outline Migration and Authority Integration

This branch deliberately does not add migrations `0007` through `0009` or update the migration catalog around their absence. The integration branch must first land the canonical GitHub migrations, then append `0010_outline.sql`, `0011_outline_grants.sql`, and `0012_outline_proposals.sql` with their verifiers and backup/restore invalidation.

`OutlineMemberMutationAuthorityPort` and the server-internal grant authorization seam must be bound to the existing `ConnectorAuthority` and `ExecutionAuthority` composition. They are inward ports, not permission engines. No production adapter may authorize a write by implementing policy independently.
