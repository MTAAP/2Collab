# oven/bun:1.3.10 multi-platform manifest resolved 2026-07-10.
FROM oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY biome.json components.json index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY docs ./docs

RUN bun run build:web && bun run build:server

# Keep the runtime on the same reviewed Bun release and manifest digest.
FROM oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    DATA_DIR=/data

WORKDIR /app

RUN mkdir -p /data && chown bun:bun /data

COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/docs ./docs

USER bun

EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3210/healthz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "dist/server/index.js"]

