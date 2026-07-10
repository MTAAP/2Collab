import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path/posix";

type Layer = "SHARED" | "DOMAIN" | "MODULE" | "ADAPTER" | "ENTRYPOINT";

export type ImportDecision = Readonly<{
  allowed: boolean;
  importer: string;
  target?: string;
  reason?: string;
}>;

function sourceLayer(path: string): Layer {
  if (path.startsWith("src/shared/")) return "SHARED";
  if (path.startsWith("src/domain/")) return "DOMAIN";
  if (path.startsWith("src/server/adapters/") || path.startsWith("src/runner/adapters/")) {
    return "ADAPTER";
  }
  if (
    path.startsWith("src/cli/") ||
    path.startsWith("src/web/") ||
    path === "src/server/app.ts" ||
    path === "src/server/index.ts"
  ) {
    return "ENTRYPOINT";
  }
  return "MODULE";
}

function entrypointFamily(path: string): "CLI" | "WEB" | "SERVER" | undefined {
  if (path.startsWith("src/cli/")) return "CLI";
  if (path.startsWith("src/web/")) return "WEB";
  if (path === "src/server/app.ts" || path === "src/server/index.ts") return "SERVER";
  return undefined;
}

function resolveTarget(importer: string, specifier: string): string | undefined {
  if (specifier.startsWith("@shared/")) return `src/shared/${specifier.slice("@shared/".length)}`;
  if (specifier.startsWith("@/")) return `src/web/${specifier.slice(2)}`;
  if (!specifier.startsWith(".")) return undefined;
  return normalize(join(dirname(importer), specifier));
}

export function validateImportEdge(importer: string, specifier: string): ImportDecision {
  const target = resolveTarget(importer, specifier);
  if (!target?.startsWith("src/")) return { allowed: true, importer, target };

  const source = sourceLayer(importer);
  const destination = sourceLayer(target);
  const ranks: Readonly<Record<Layer, number>> = {
    SHARED: 0,
    DOMAIN: 1,
    MODULE: 2,
    ADAPTER: 3,
    ENTRYPOINT: 4,
  };

  if (source === "ADAPTER" && destination === "ADAPTER") {
    return { allowed: false, importer, target, reason: "ADAPTER_TO_ADAPTER" };
  }
  if (source === "ADAPTER" && destination === "ENTRYPOINT") {
    return { allowed: false, importer, target, reason: "ADAPTER_TO_ENTRYPOINT" };
  }
  if (source === "ENTRYPOINT" && destination === "ENTRYPOINT") {
    const allowed = entrypointFamily(importer) === entrypointFamily(target);
    return { allowed, importer, target, reason: allowed ? undefined : "ENTRYPOINT_TO_ENTRYPOINT" };
  }
  if (ranks[destination] > ranks[source]) {
    return {
      allowed: false,
      importer,
      target,
      reason: `${source}_OUTWARD_TO_${destination}`,
    };
  }
  return { allowed: true, importer, target };
}

function importSpecifiers(source: string): readonly string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:from|import\s*\(|require\s*\()\s*["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

export async function scanSourceImports(root: string): Promise<readonly ImportDecision[]> {
  const violations: ImportDecision[] = [];
  for (const name of await readdir(root, { recursive: true })) {
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    const importer = `${root}/${name}`;
    const source = await readFile(importer, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const decision = validateImportEdge(importer, specifier);
      if (!decision.allowed) violations.push(decision);
    }
  }
  return violations;
}
