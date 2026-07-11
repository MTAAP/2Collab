import { describe, expect, test } from "bun:test";
import { validateFoundationMatrix } from "../../../scripts/verify-evidence.ts";
import { localFoundationMatrix } from "../../evidence/foundation-matrix.ts";

describe("Foundation proof registry", () => {
  test("covers canonical FND-001 through FND-019 with exact executable tests", async () => {
    const result = await validateFoundationMatrix(localFoundationMatrix);
    expect(result).toEqual({ requirementCount: 19, obligationCount: expect.any(Number) });
    expect(result.obligationCount).toBeGreaterThanOrEqual(19);
  });
});
