import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { APP_METADATA } from "../shared/app-metadata.ts";
import { createFoundationHttpApp } from "./adapters/http/app.ts";
import type { FoundationHttpDependencies } from "./adapters/http/app.ts";

type AppOptions = {
  docsRoot?: string;
  webRoot?: string;
};

type ErrorBody = {
  error: {
    code: "INTERNAL_ERROR" | "NOT_FOUND";
    message: string;
  };
};

function errorBody(code: ErrorBody["error"]["code"], message: string): ErrorBody {
  return { error: { code, message } };
}

export function createApp(
  dependencies?: FoundationHttpDependencies,
  options: AppOptions = {},
): Hono {
  const app = new Hono();

  app.get("/healthz", (context) =>
    context.json({
      apiVersion: APP_METADATA.apiVersion,
      service: APP_METADATA.packageName,
      status: "OK",
      version: APP_METADATA.version,
    }),
  );

  app.get("/api/v1", (context) =>
    context.json({
      apiVersion: APP_METADATA.apiVersion,
      service: APP_METADATA.packageName,
      version: APP_METADATA.version,
    }),
  );

  if (dependencies) {
    app.route("/", createFoundationHttpApp(dependencies));
  }

  app.all("/api/*", (context) =>
    context.json(errorBody("NOT_FOUND", "The requested API resource does not exist."), 404),
  );

  if (options.docsRoot) {
    app.get(
      "/docs/START-HERE.md",
      serveStatic({
        mimes: { md: "text/markdown; charset=utf-8" },
        path: "START-HERE.md",
        root: options.docsRoot,
      }),
    );
  }

  app.all("/docs/*", (context) =>
    context.json(errorBody("NOT_FOUND", "The requested public document does not exist."), 404),
  );

  if (options.webRoot) {
    app.use("*", serveStatic({ root: options.webRoot }));
    app.get("*", serveStatic({ path: "index.html", root: options.webRoot }));
  }

  app.notFound((context) =>
    context.json(errorBody("NOT_FOUND", "The requested resource does not exist."), 404),
  );

  app.onError((_error, context) =>
    context.json(errorBody("INTERNAL_ERROR", "The server could not complete the request."), 500),
  );

  return app;
}
