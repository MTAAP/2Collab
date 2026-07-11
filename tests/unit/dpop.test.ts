import { expect, test } from "bun:test";
import { createDpopProof, dpopThumbprint, verifyDpopProof } from "../../src/shared/dpop.ts";

test("packaged device proof signs method, URL, nonce, sender key, and access token", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const proof = await createDpopProof({
    privateJwk,
    method: "POST",
    url: "https://collab.example/api/v1/runs",
    nonce: "nonce_1",
    accessToken: "device-access-token-with-at-least-thirty-two-bytes",
    issuedAt: 100,
    jti: "proof_1",
  });
  expect(await verifyDpopProof(proof)).toEqual({
    jti: "proof_1",
    method: "POST",
    uri: "https://collab.example/api/v1/runs",
    issuedAt: 100,
    nonce: "nonce_1",
    senderKeyThumbprint: dpopThumbprint(privateJwk),
    accessTokenHash: new Bun.CryptoHasher("sha256")
      .update("device-access-token-with-at-least-thirty-two-bytes")
      .digest("hex"),
  });
  const parts = proof.split(".");
  parts[1] = Buffer.from(JSON.stringify({ htm: "GET" })).toString("base64url");
  expect(verifyDpopProof(parts.join("."))).rejects.toThrow("DPOP_INVALID");
});
