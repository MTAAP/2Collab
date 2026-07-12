import { createPublicKey, generateKeyPair as generateKeyPairNode, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Result } from "../../../shared/contracts/result.ts";
import type { RunnerKeyProofPort, RunnerRequestProofPort } from "./contract.ts";

export type RunnerAlgorithm = "Ed25519" | "RS256";

export interface RunnerKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeySpki: Buffer;
  keyThumbprint: string;
  algorithm: RunnerAlgorithm;
}

export interface RunnerProofPayload {
  jti: string;
  htm: string;
  htu: string;
  iat: number;
  nonce: string;
  ath: string;
}

export interface RunnerRequestProofInput {
  jti: string;
  method: "GET";
  uri: string;
  iat: number;
  nonce: string;
  accessTokenHash: string;
}

interface DecodedCompactJws {
  publicKey: KeyObject;
  algorithm: RunnerAlgorithm;
  keyThumbprint: string;
  payload: RunnerProofPayload;
  signed: string;
  signature: Buffer;
}

function keyFailure<T>(): Result<T> {
  return {
    ok: false,
    error: {
      code: "RUNNER_KEY_PROOF_INVALID",
      message: "Runner key proof is invalid.",
      retry: "NEVER",
    },
  };
}

function requestFailure<T>(): Result<T> {
  return {
    ok: false,
    error: {
      code: "RUNNER_DPOP_INVALID",
      message: "Runner request proof is invalid.",
      retry: "NEVER",
    },
  };
}

function computeKeyThumbprint(publicKeySpki: Buffer): string {
  const hash = new Bun.CryptoHasher("sha256").update(publicKeySpki).digest();
  return Buffer.from(hash).toString("hex");
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signingAlgorithm(algorithm: RunnerAlgorithm): "sha256" | undefined {
  return algorithm === "RS256" ? "sha256" : undefined;
}

function generateKeyPair(
  type: "ed25519" | "rsa",
  options: object,
): Promise<{ publicKey: string; privateKey: string }> {
  return new Promise((resolve, reject) => {
    (
      generateKeyPairNode as unknown as (
        type: string,
        options: object,
        callback: (err: Error | null, publicKey: string, privateKey: string) => void,
      ) => void
    )(type, options, (err, publicKey, privateKey) => {
      if (err) {
        reject(err);
      } else {
        resolve({ publicKey, privateKey });
      }
    });
  });
}

function decodeCompactJws(proof: string): DecodedCompactJws | null {
  const parts = proof.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  try {
    const headerJson = Buffer.from(headerB64, "base64url").toString("utf8");
    const header = JSON.parse(headerJson) as unknown;
    if (typeof header !== "object" || header === null) return null;

    const { alg, typ, keyThumbprint, spki } = header as Record<string, unknown>;
    if (
      typeof alg !== "string" ||
      typeof typ !== "string" ||
      typeof keyThumbprint !== "string" ||
      typeof spki !== "string"
    ) {
      return null;
    }
    if (typ !== "dpop+jwt") return null;
    if (alg !== "Ed25519" && alg !== "RS256") return null;

    const spkiBytes = Buffer.from(spki, "base64url");
    const publicKey = createPublicKey({ key: spkiBytes, format: "der", type: "spki" });
    const computedThumbprint = computeKeyThumbprint(spkiBytes);
    if (computedThumbprint !== keyThumbprint) return null;

    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as unknown;
    if (typeof payload !== "object" || payload === null) return null;

    const { jti, htm, htu, iat, nonce, ath } = payload as Record<string, unknown>;
    if (
      typeof jti !== "string" ||
      typeof htm !== "string" ||
      typeof htu !== "string" ||
      typeof iat !== "number" ||
      typeof nonce !== "string" ||
      typeof ath !== "string"
    ) {
      return null;
    }

    const signature = Buffer.from(signatureB64, "base64url");
    const signed = `${headerB64}.${payloadB64}`;

    return {
      publicKey,
      algorithm: alg as RunnerAlgorithm,
      keyThumbprint,
      payload: { jti, htm, htu, iat, nonce, ath },
      signed,
      signature,
    };
  } catch {
    return null;
  }
}

function createProof(keyPair: RunnerKeyPair, payload: RunnerProofPayload): string {
  const header = JSON.stringify({
    alg: keyPair.algorithm,
    typ: "dpop+jwt",
    keyThumbprint: keyPair.keyThumbprint,
    spki: keyPair.publicKeySpki.toString("base64url"),
  });
  const payloadJson = JSON.stringify(payload);
  const encodedHeader = base64Url(header);
  const encodedPayload = base64Url(payloadJson);
  const signed = `${encodedHeader}.${encodedPayload}`;
  const algorithm = signingAlgorithm(keyPair.algorithm);
  const signature = sign(algorithm, Buffer.from(signed, "utf8"), keyPair.privateKeyPem);
  return `${signed}.${signature.toString("base64url")}`;
}

export function createRunnerKeyProofPort(): RunnerKeyProofPort {
  return {
    async verifyNewKey(input) {
      const decoded = decodeCompactJws(input.proof);
      if (!decoded) return keyFailure();

      const algorithm = signingAlgorithm(decoded.algorithm);
      const valid = verify(
        algorithm,
        Buffer.from(decoded.signed, "utf8"),
        decoded.publicKey,
        decoded.signature,
      );
      if (!valid) return keyFailure();

      return { ok: true, value: { keyThumbprint: decoded.keyThumbprint } };
    },

    async verifyPossession(input) {
      const decoded = decodeCompactJws(input.proof);
      if (!decoded) return keyFailure();
      if (decoded.keyThumbprint !== input.keyThumbprint) return keyFailure();

      const algorithm = signingAlgorithm(decoded.algorithm);
      const valid = verify(
        algorithm,
        Buffer.from(decoded.signed, "utf8"),
        decoded.publicKey,
        decoded.signature,
      );
      if (!valid) return keyFailure();

      return { ok: true, value: { verified: true } };
    },
  };
}

export function createRunnerRequestProofPort(): RunnerRequestProofPort {
  return {
    async verify(input) {
      const decoded = decodeCompactJws(input.proof);
      if (!decoded) return requestFailure();
      if (decoded.keyThumbprint !== input.keyThumbprint) return requestFailure();
      if (decoded.payload.htm !== input.method) return requestFailure();
      if (decoded.payload.htu !== input.uri) return requestFailure();
      if (decoded.payload.nonce !== input.nonce) return requestFailure();
      if (decoded.payload.ath !== input.accessTokenHash) return requestFailure();
      if (Math.abs(input.now - decoded.payload.iat) > 300) return requestFailure();

      const algorithm = signingAlgorithm(decoded.algorithm);
      const valid = verify(
        algorithm,
        Buffer.from(decoded.signed, "utf8"),
        decoded.publicKey,
        decoded.signature,
      );
      if (!valid) return requestFailure();

      return { ok: true, value: { jti: decoded.payload.jti, issuedAt: decoded.payload.iat } };
    },
  };
}

export async function generateRunnerKeyPair(): Promise<RunnerKeyPair> {
  const keyEncoding = {
    publicKeyEncoding: { type: "spki" as const, format: "pem" as const },
    privateKeyEncoding: { type: "pkcs8" as const, format: "pem" as const },
  };

  try {
    const { publicKey, privateKey } = await generateKeyPair("ed25519", keyEncoding);
    const publicKeyPem = publicKey;
    const privateKeyPem = privateKey;
    const publicKeySpki = createPublicKey(publicKeyPem).export({
      type: "spki",
      format: "der",
    }) as Buffer;
    const keyThumbprint = computeKeyThumbprint(publicKeySpki);
    return { publicKeyPem, privateKeyPem, publicKeySpki, keyThumbprint, algorithm: "Ed25519" };
  } catch {
    const { publicKey, privateKey } = await generateKeyPair("rsa", {
      ...keyEncoding,
      modulusLength: 2048,
    });
    const publicKeyPem = publicKey;
    const privateKeyPem = privateKey;
    const publicKeySpki = createPublicKey(publicKeyPem).export({
      type: "spki",
      format: "der",
    }) as Buffer;
    const keyThumbprint = computeKeyThumbprint(publicKeySpki);
    return { publicKeyPem, privateKeyPem, publicKeySpki, keyThumbprint, algorithm: "RS256" };
  }
}

export interface RunnerCryptography {
  runnerKeyProof: RunnerKeyProofPort;
  runnerRequestProof: RunnerRequestProofPort;
  generateKeyPair: () => Promise<RunnerKeyPair>;
  signRunnerKeyProof: (keyPair: RunnerKeyPair, payload: RunnerProofPayload) => string;
  signRunnerRequestProof: (keyPair: RunnerKeyPair, input: RunnerRequestProofInput) => string;
}

export function createRunnerCryptography(): RunnerCryptography {
  return {
    runnerKeyProof: createRunnerKeyProofPort(),
    runnerRequestProof: createRunnerRequestProofPort(),
    generateKeyPair: generateRunnerKeyPair,
    signRunnerKeyProof: signRunnerKeyProof,
    signRunnerRequestProof: signRunnerRequestProof,
  };
}

export function signRunnerKeyProof(keyPair: RunnerKeyPair, payload: RunnerProofPayload): string {
  return createProof(keyPair, payload);
}

export function signRunnerRequestProof(
  keyPair: RunnerKeyPair,
  input: RunnerRequestProofInput,
): string {
  const payload: RunnerProofPayload = {
    jti: input.jti,
    htm: input.method,
    htu: input.uri,
    iat: input.iat,
    nonce: input.nonce,
    ath: input.accessTokenHash,
  };
  return createProof(keyPair, payload);
}
