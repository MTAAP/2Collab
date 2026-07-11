import { readFile } from "node:fs/promises";
import { validateOutlineEvidence } from "../tests/evidence/outline-matrix.ts";
const path = process.argv[3];
if (process.argv[2] !== "validate" || !path) {
  console.error("usage: bun run outline:evidence validate <json>");
  process.exit(2);
}
const rows = JSON.parse(await readFile(path, "utf8"));
const result = validateOutlineEvidence(rows);
console.log(JSON.stringify(result, null, 2));
process.exit(result.valid ? 0 : 1);
