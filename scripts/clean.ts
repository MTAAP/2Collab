import { rm } from "node:fs/promises";

const generatedPaths = ["coverage", "dist", "playwright-report", "test-results"] as const;

await Promise.all(generatedPaths.map((path) => rm(path, { force: true, recursive: true })));
