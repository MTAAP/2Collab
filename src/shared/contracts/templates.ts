import { z } from "zod";
import type { MemberActor } from "./actors.ts";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const VariableSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: z.enum(["STRING", "NUMBER", "BOOLEAN"]),
    required: z.boolean(),
  })
  .strict();

export const TeamRunTemplateDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).optional(),
    projectId: IdentifierSchema.optional(),
    coreInstructions: z.string().min(1).max(16_000),
    variables: z.array(VariableSchema).max(64),
    resultKeys: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
      .min(1)
      .max(32),
    repositoryMode: z.enum(["MUTATING", "INSPECT_ONLY"]),
    minimumAssurance: z.enum(["ADVISORY", "ENFORCED"]),
    contextRecipeId: IdentifierSchema.optional(),
    gateSets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(32),
    maximumAttempts: z.number().int().positive(),
    absoluteDeadlineMs: z.number().int().positive().finite(),
  })
  .strict()
  .superRefine((value, context) => {
    const variables = new Set<string>();
    for (const [index, variable] of value.variables.entries()) {
      if (variables.has(variable.key)) {
        context.addIssue({
          code: "custom",
          path: ["variables", index, "key"],
          message: "Variable keys must be unique.",
        });
      }
      variables.add(variable.key);
    }
    if (new Set(value.resultKeys).size !== value.resultKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["resultKeys"],
        message: "Result keys must be unique.",
      });
    }
  });

export type TeamRunTemplateDraft = Readonly<{
  name: string;
  description?: string;
  projectId?: string;
  coreInstructions: string;
  variables: readonly Readonly<{
    key: string;
    type: "STRING" | "NUMBER" | "BOOLEAN";
    required: boolean;
  }>[];
  resultKeys: readonly string[];
  repositoryMode: "MUTATING" | "INSPECT_ONLY";
  minimumAssurance: "ADVISORY" | "ENFORCED";
  contextRecipeId?: string;
  gateSets: readonly string[];
  maximumAttempts: number;
  absoluteDeadlineMs: number;
}>;
export type TeamRunTemplateVersion = Readonly<{
  id: string;
  templateKey: string;
  version: number;
  definition: TeamRunTemplateDraft;
  semanticHash: string;
}>;

export type PublishRunTemplate = Readonly<{
  idempotencyKey: string;
  actorMemberId: string;
  templateKey: string;
  expectedVersion: number;
  definition: TeamRunTemplateDraft;
}>;

export type PersonalWorkflowBinding = Readonly<{
  personalRunPresetId: string;
  expectedVersion: number;
  repository: Readonly<{
    repositoryId: string;
    intendedBranch?: string;
  }>;
}>;

export type PersonalWorkflowPreset = Readonly<{
  id: string;
  ownerMemberId: string;
  version: number;
  workflowTemplateVersionId: string;
  bindings: Readonly<Record<string, PersonalWorkflowBinding>>;
  createdAt: number;
}>;

export type BindWorkflowPreset = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  preset: PersonalWorkflowPreset;
}>;
