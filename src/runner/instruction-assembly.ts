import { createHash } from "node:crypto";
import { ReferenceFirstBootstrapEnvelopeSchema } from "../shared/contracts/context.ts";
import {
  EffectiveInstructionEnvelopeSchema,
  type EffectiveInstructionLayers,
} from "../shared/contracts/presets.ts";
import type { Result } from "../shared/contracts/result.ts";

const MAX_EFFECTIVE_INSTRUCTION_BYTES = 64 * 1_024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

function labelledLayers(layers: EffectiveInstructionLayers): readonly string[] {
  return [
    ...(layers.teamCore ? ["## Team core", layers.teamCore] : []),
    "## Typed variables",
    canonical(layers.typedVariables),
    ...(layers.personalAddendum ? ["## Personal addendum", layers.personalAddendum] : []),
    "## This run",
    layers.runGoal,
    ...(layers.authoredRunInput ? ["## Authored run input", layers.authoredRunInput] : []),
  ];
}

export function assembleEffectiveInstructions(
  input: Readonly<{
    instructions: unknown;
    bootstrap: unknown;
  }>,
): Result<string> {
  const instructions = EffectiveInstructionEnvelopeSchema.safeParse(input.instructions);
  const bootstrap = ReferenceFirstBootstrapEnvelopeSchema.safeParse(input.bootstrap);
  if (!instructions.success || !bootstrap.success) {
    return failure("INSTRUCTION_ENVELOPE_INVALID", "Effective instructions are invalid.");
  }
  const contextEnvelopeDigest = sha256(bootstrap.data);
  const assemblyDigest = sha256({
    configurationDigest: instructions.data.configurationDigest,
    envelopeDigest: contextEnvelopeDigest,
    authoredRunInput: instructions.data.layers.authoredRunInput,
  });
  if (
    contextEnvelopeDigest !== instructions.data.contextEnvelopeDigest ||
    assemblyDigest !== instructions.data.assemblyDigest
  ) {
    return failure("INSTRUCTION_DIGEST_MISMATCH", "Effective instructions changed.");
  }
  const assembled = [
    ...labelledLayers(instructions.data.layers),
    "## Context references",
    canonical(bootstrap.data),
  ].join("\n\n");
  if (Buffer.byteLength(assembled, "utf8") > MAX_EFFECTIVE_INSTRUCTION_BYTES) {
    return failure("INSTRUCTION_ENVELOPE_TOO_LARGE", "Effective instructions are too large.");
  }
  return { ok: true, value: assembled };
}
