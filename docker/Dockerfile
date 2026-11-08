# syntax=docker/dockerfile:1.7
#
# Self-hosting image (docs/SELF-HOSTING.md): api + web (SPA served by the api) + worker in ONE image.
#   default command  -> standalone mode: everything in one process, zero configuration (n8n-style)
#                       docker run -it --rm -p 3000:3000 -v bines_data:/data <image>   then open http://localhost:3000
#                       embedded database, files and generated secrets in /data; DATABASE_URL / S3_* switch to the
#                       real services. The browser asks for the owner account on first visit.
#   api only         -> docker run <image> node dist/index.js   (the compose setup: Postgres, MinIO, separate worker)
#   worker          -> docker run <image> node /app/apps/worker/dist/index.js
#   release          -> docker run <image> sh -c "node dist/migrate.js && node dist/seed.js"   (migrate + seed, idempotent)
#
# Build from the repository root:  docker build -f docker/Dockerfile -t bines-os .
# It lives in docker/ (not the root) on purpose: a root Dockerfile would make Railway switch away from Railpack.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=9.15.9

# ---- base: Node + pnpm -------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app

# ---- manifests: only package.json files + lockfile, so dependency layers stay cached across code changes ----------
FROM base AS manifests
COPY . .
RUN find . -type f \
      ! -name package.json ! -name pnpm-lock.yaml ! -name pnpm-workspace.yaml ! -name .npmrc \
      -delete \
 && find . -type d -empty -delete

# ---- build: every dependency, then the three apps ----------------------------------------------------------------
FROM base AS build
COPY --from=manifests /app ./
# Only what the three shipped apps build with: the integrations (n8n / Make apps) and extensions are not part of the
# image, and the n8n SDK pulls a native module (isolated-vm) that would need a compiler here.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter "@bines/web..." --filter "@bines/api..." --filter "@bines/worker..."
COPY . .
# Optional, baked into the SPA at build time (error monitoring of the browser app). Empty = off.
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
RUN pnpm --filter @bines/web --filter @bines/api --filter @bines/worker build

# ---- prod-deps: runtime dependencies of the api and the worker only ----------------------------------------------
FROM base AS prod-deps
COPY --from=manifests /app ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --prod --filter "@bines/api..." --filter "@bines/worker..." \
 && find node_modules -name '*.map' -type f -delete \
 && cd node_modules/.pnpm \
 && rm -rf vitest@* @vitest+* vite@* rolldown@* @rolldown+* lightningcss* happy-dom@* drizzle-kit@* esbuild@* @esbuild+* \
      @esbuild-kit+* tsx@*
# Lean runtime: dependencies' source maps are never read (ours, in dist/, are kept for error reports), and the test /
# build tools above only arrive as optional peers of better-auth (its test helpers and CLI), never imported at runtime.

# ---- runtime -----------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# TRUST_PROXY=none (S-73): the image may be reached directly, so X-Forwarded-For is not believed unless the install
# says how many proxies sit in front (compose: PROXY_HOPS; `-e TRUST_PROXY=1` behind one reverse proxy). Railway
# builds with railpack, not this file, and keeps the code default (edge — its edge replaces the header).
ENV NODE_ENV=production \
    API_PORT=3000 \
    TRUST_PROXY=none \
    DATA_DIR=/data
WORKDIR /app
# The repository layout is kept (apps/api, apps/web/dist, seed/...): the api finds the SPA, the migrations and the
# seed data by relative paths, exactly as in development. Files stay owned by root and read-only for the app user.
COPY --from=prod-deps /app ./
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/api/assets apps/api/assets
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/seed seed

# Standalone mode keeps everything here (db/, files/, secrets.json); a new named volume starts owned by `node`.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/standalone.js"]
