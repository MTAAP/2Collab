import { installProductionRunnerInfrastructure } from "../../src/server/adapters/wss/production-bootstrap.ts";

const denied = {
  ok: false as const,
  error: { code: "AUTHORITY_FACT_UNAVAILABLE", message: "Unavailable.", retry: "REFRESH" as const },
};

installProductionRunnerInfrastructure({
  defaultSecurityDigest: "0".repeat(64),
  runnerKeyProof: {
    async verifyNewKey(input) {
      return input.proof === `new:${input.keyId}`
        ? { ok: true, value: { keyThumbprint: `thumb_${input.keyId}` } }
        : {
            ok: false,
            error: { code: "RUNNER_KEY_PROOF_INVALID", message: "Invalid.", retry: "NEVER" },
          };
    },
    async verifyPossession(input) {
      return input.proof === `possession:${input.keyThumbprint}`
        ? { ok: true, value: { verified: true as const } }
        : {
            ok: false,
            error: { code: "RUNNER_KEY_PROOF_INVALID", message: "Invalid.", retry: "NEVER" },
          };
    },
  },
  runnerRequestProof: {
    async verify(input) {
      const jti = /^dpop:([A-Za-z0-9_-]{1,128})$/.exec(input.proof)?.[1];
      return jti
        ? { ok: true, value: { jti, issuedAt: input.now } }
        : {
            ok: false,
            error: { code: "RUNNER_DPOP_INVALID", message: "Invalid.", retry: "NEVER" },
          };
    },
  },
  authorityFacts: { preview: async () => denied, refresh: async () => denied },
  runConfiguration: { resolve: async () => denied },
  permitCodec: {
    sign: async () => "p".repeat(64),
    verify: async () => ({
      ok: false,
      error: { code: "PERMIT_INVALID", message: "Invalid.", retry: "NEVER" },
    }),
  },
  acceptGateEvent: async () => ({ ok: true, value: { accepted: true } }),
});
