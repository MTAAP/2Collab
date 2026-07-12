import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Result } from "../../../shared/contracts/result.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_SECRET_BYTES = 512;
const MAX_RESPONSE_BYTES = 4 * 1024;

export type EmailOtpTransport = Readonly<{
  sendSignInOtp(input: Readonly<{ to: string; otp: string }>): Promise<Result<undefined>>;
}>;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function failure(code = "EMAIL_DELIVERY_FAILED"): Result<never> {
  return {
    ok: false,
    error: { code, message: "Email delivery failed.", retry: "REFRESH" },
  };
}

export function readResendApiKeyFile(path: string): Result<string> {
  try {
    const requested = resolve(path);
    const metadata = lstatSync(requested);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size < 20 ||
      metadata.size > MAX_SECRET_BYTES
    )
      return failure("EMAIL_DELIVERY_CONFIGURATION_INVALID");
    const value = readFileSync(requested, "utf8").trim();
    if (!/^re_[A-Za-z0-9_-]{16,252}$/.test(value))
      return failure("EMAIL_DELIVERY_CONFIGURATION_INVALID");
    return { ok: true, value };
  } catch {
    return failure("EMAIL_DELIVERY_CONFIGURATION_INVALID");
  }
}

export function createResendEmailOtpTransport(
  input: Readonly<{
    apiKey: string;
    from: string;
    fetcher?: Fetcher;
  }>,
): EmailOtpTransport {
  if (!/^re_[A-Za-z0-9_-]{16,252}$/.test(input.apiKey) || !z.email().safeParse(input.from).success)
    throw new Error("EMAIL_DELIVERY_CONFIGURATION_INVALID");
  const fetcher = input.fetcher ?? fetch;
  return {
    async sendSignInOtp(request) {
      if (!z.email().safeParse(request.to).success || !/^\d{6}$/.test(request.otp))
        return failure();
      try {
        const response = await fetcher(RESEND_ENDPOINT, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: input.from,
            to: [request.to],
            subject: "Your 2Collab sign-in code",
            text: `Your 2Collab sign-in code is ${request.otp}. It expires in five minutes.`,
          }),
        });
        const declared = response.headers.get("content-length");
        if (
          response.status < 200 ||
          response.status >= 300 ||
          (declared !== null && Number(declared) > MAX_RESPONSE_BYTES)
        )
          return failure();
        const body = await response.text();
        if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) return failure();
        return { ok: true, value: undefined };
      } catch {
        return failure();
      }
    },
  };
}
