# syntax=docker/dockerfile:1.7
#
# The calendar-sync extension's server (extensions/calendar-sync/README.md). Build from the repository root:
#   docker build -f extensions/calendar-sync/Dockerfile -t bines-calendar-sync .
# or with the compose file: docker compose -f docker-compose.prod.yml --profile calendar-sync up -d

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=9.15.9

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app

# ---- manifests: only package.json files + lockfile (cached dependency layer) --------------------------------------
FROM base AS manifests
COPY . .
RUN find . -type f \
      ! -name package.json ! -name pnpm-lock.yaml ! -name pnpm-workspace.yaml ! -name .npmrc \
      -delete \
 && find . -type d -empty -delete

# ---- build: the server bundle and the pages ----------------------------------------------------------------------
FROM base AS build
COPY --from=manifests /app ./
# No cache mount: Railway accepts only mounts whose id carries its service id, so one plain install builds anywhere.
RUN pnpm install --frozen-lockfile --filter "@bines/ext-calendar-sync..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ext-sdk packages/ext-sdk
COPY extensions/calendar-sync extensions/calendar-sync
RUN pnpm --filter @bines/ext-calendar-sync build \
 && pnpm --filter @bines/ext-calendar-sync deploy --prod /out

# ---- runtime: the bundle + its only runtime dependency (pg) ------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3990
WORKDIR /srv
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/extensions/calendar-sync/package.json ./
COPY --from=build /app/extensions/calendar-sync/dist ./dist
USER node
EXPOSE 3990
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3990)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
