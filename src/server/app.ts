import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { APP_METADATA } from "../shared/app-metadata.ts";
import { createFoundationHttpApp } from "./adapters/http/app.ts";
import type { FoundationHttpDependencies } from "./adapters/http/app.ts";
import {
  createGitHubConnectorRoutes,
  type GitHubWebhookRouteDependencies,
} from "./adapters/http/routes/connectors-github.ts";
import {
  createGitHubIssueRoutes,
  type GitHubIssueRouteDependencies,
} from "./adapters/http/routes/github-issues.ts";
import { createGitHubPlanningRoutes } from "./adapters/http/routes/github-planning.ts";
import { createInboxRoutes } from "./adapters/http/routes/inbox.ts";

type AppOptions = {
  docsRoot?: string;
  githubIssues?: GitHubIssueRouteDependencies;
  githubPlanning?: Parameters<typeof createGitHubPlanningRoutes>[0];
  githubWebhooks?: GitHubWebhookRouteDependencies;
  inbox?: Parameters<typeof createInboxRoutes>[0];
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

  app.get("/readyz", (context) => {
    const readiness = dependencies?.readiness;
    const ready = readiness ? readiness.ready() : true;
    return ready
      ? context.json({
          apiVersion: APP_METADATA.apiVersion,
          service: APP_METADATA.packageName,
          status: "OK",
          version: APP_METADATA.version,
        })
      : context.json({ status: "NOT_READY" }, 503);
  });

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
  if (options.githubWebhooks) {
    app.route("/", createGitHubConnectorRoutes(options.githubWebhooks));
  }
  if (options.githubIssues) {
    app.route("/", createGitHubIssueRoutes(options.githubIssues));
  }
  if (options.githubPlanning) {
    app.route("/", createGitHubPlanningRoutes(options.githubPlanning));
  }
  if (options.inbox) app.route("/", createInboxRoutes(options.inbox));

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
