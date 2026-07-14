import { createHash, randomUUID } from "node:crypto";

const encoder = new TextEncoder();
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));
const encode = (value: Uint8Array | string) =>
  Buffer.from(typeof value === "string" ? encoder.encode(value) : value).toString("base64url");

function publicJwk(value: JsonWebKey): JsonWebKey {
  return { kty: value.kty, crv: value.crv, x: value.x, y: value.y };
}

export function dpopThumbprint(jwk: JsonWebKey): string {
  const value = publicJwk(jwk);
  return createHash("sha256")
    .update(JSON.stringify({ crv: value.crv, kty: value.kty, x: value.x, y: value.y }))
    .digest("base64url");
}

export async function createDpopProof(
  input: Readonly<{
    privateJwk: JsonWebKey;
    method: string;
    url: string;
    nonce: string;
    accessToken: string;
    issuedAt?: number;
    jti?: string;
  }>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    input.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = encode(
    JSON.stringify({ alg: "ES256", typ: "dpop+jwt", jwk: publicJwk(input.privateJwk) }),
  );
  const payload = encode(
    JSON.stringify({
      jti: input.jti ?? randomUUID().replaceAll("-", ""),
      htm: input.method.toUpperCase(),
      htu: input.url,
      iat: input.issuedAt ?? Math.floor(Date.now() / 1_000),
      nonce: input.nonce,
      ath: createHash("sha256").update(input.accessToken).digest("hex"),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${encode(new Uint8Array(signature))}`;
}

export async function verifyDpopProof(proof: string): Promise<
  Readonly<{
    jti: string;
    method: string;
    uri: string;
    issuedAt: number;
    nonce: string;
    senderKeyThumbprint: string;
    accessTokenHash: string;
  }>
> {
  const parts = proof.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0))
    throw new Error("DPOP_INVALID");
  const header = JSON.parse(Buffer.from(parts[0] as string, "base64url").toString("utf8")) as {
    alg?: string;
    typ?: string;
    jwk?: JsonWebKey;
  };
  const payload = JSON.parse(
    Buffer.from(parts[1] as string, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  if (header.alg !== "ES256" || header.typ !== "dpop+jwt" || !header.jwk)
    throw new Error("DPOP_INVALID");
  const key = await crypto.subtle.importKey(
    "jwk",
    header.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decode(parts[2] as string),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new Error("DPOP_INVALID");
  return {
    jti: String(payload.jti ?? ""),
    method: String(payload.htm ?? ""),
    uri: String(payload.htu ?? ""),
    issuedAt: Number(payload.iat),
    nonce: String(payload.nonce ?? ""),
    senderKeyThumbprint: dpopThumbprint(header.jwk),
    accessTokenHash: String(payload.ath ?? ""),
  };
}
