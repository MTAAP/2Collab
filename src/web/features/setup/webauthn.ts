function decode(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
  return bytes.buffer;
}

function encode(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function registrationOptions(
  options: Record<string, unknown>,
): PublicKeyCredentialCreationOptions {
  const publicKey = structuredClone(options) as unknown as PublicKeyCredentialCreationOptions & {
    challenge: string | ArrayBuffer;
    user: PublicKeyCredentialUserEntity & { id: string | ArrayBuffer };
  };
  if (typeof publicKey.challenge === "string") publicKey.challenge = decode(publicKey.challenge);
  if (typeof publicKey.user.id === "string") publicKey.user.id = decode(publicKey.user.id);
  publicKey.excludeCredentials = publicKey.excludeCredentials?.map((credential) => ({
    ...credential,
    id: typeof credential.id === "string" ? decode(credential.id) : credential.id,
  }));
  return publicKey;
}

export function authenticationOptions(
  options: Record<string, unknown>,
): PublicKeyCredentialRequestOptions {
  const publicKey = structuredClone(options) as unknown as PublicKeyCredentialRequestOptions & {
    challenge: string | ArrayBuffer;
  };
  if (typeof publicKey.challenge === "string") publicKey.challenge = decode(publicKey.challenge);
  publicKey.allowCredentials = publicKey.allowCredentials?.map((credential) => ({
    ...credential,
    id: typeof credential.id === "string" ? decode(credential.id) : credential.id,
  }));
  return publicKey;
}

export function serializeCredential(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: encode(response.attestationObject),
      clientDataJSON: encode(response.clientDataJSON),
      transports: response.getTransports?.() ?? [],
    },
  };
}

export function serializeAuthenticationCredential(
  credential: PublicKeyCredential,
): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: encode(response.authenticatorData),
      clientDataJSON: encode(response.clientDataJSON),
      signature: encode(response.signature),
      userHandle: response.userHandle ? encode(response.userHandle) : null,
    },
  };
}
