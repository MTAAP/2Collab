import { z } from "zod";
import type { Sha256 } from "./ids.ts";
import { IdentifierSchema, Sha256Schema } from "./ids.ts";

export type EffectiveRunConfigurationRef = Readonly<{
  configurationId: string;
  version: number;
  digest: Sha256;
}>;

export const EffectiveRunConfigurationRefSchema = z
  .object({
    configurationId: IdentifierSchema,
    version: z.number().int().positive(),
    digest: Sha256Schema,
  })
  .strict();
