import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_METADATA } from "@shared/app-metadata";

export function App() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl items-center px-6 py-16 lg:px-10">
      <section className="flex w-full flex-col gap-10 rounded-3xl border bg-card p-8 text-card-foreground shadow-sm sm:p-12 lg:p-16">
        <div className="flex max-w-3xl flex-col gap-6">
          <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CheckCircle2Icon aria-hidden="true" />
            Repository foundation ready
          </p>
          <div className="flex flex-col gap-4">
            <h1 className="text-5xl font-semibold tracking-tight sm:text-7xl">
              {APP_METADATA.name}
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
              A self-hosted coordination surface for small developer teams and the trusted agent
              runtimes already running on their machines.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Button asChild size="lg">
            <a href="/docs/START-HERE.md">
              Start implementing
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">
            API {APP_METADATA.apiVersion} · seed {APP_METADATA.version}
          </p>
        </div>
      </section>
    </main>
  );
}
