import type { DeviceCredentialProvider } from "./api-client.ts";

function bounded(value: string | undefined, minimum: number, maximum: number): value is string {
  return value !== undefined && value.length >= minimum && value.length <= maximum;
}

/**
 * Static proof material exists only for isolated compiled transport tests. Normal
 * CLI composition must supply a credential provider backed by the OS credential
 * store and a per-request DPoP signer; production never accepts this seam.
 */
export function createDeviceCredentialProvider(
  environment: Readonly<Record<string, string | undefined>>,
): DeviceCredentialProvider | undefined {
  if (environment.NODE_ENV !== "test") return undefined;
  const accessToken = environment.COLLAB_DEVICE_ACCESS_TOKEN;
  const proof = environment.COLLAB_DPOP_PROOF;
  const nonce = environment.COLLAB_DPOP_NONCE;
  if (!bounded(accessToken, 32, 512) || !bounded(proof, 1, 8_192) || !bounded(nonce, 1, 512))
    return undefined;
  return {
    async headers() {
      return {
        authorization: `DPoP ${accessToken}`,
        dpop: proof,
        "dpop-nonce": nonce,
      };
    },
  };
}
