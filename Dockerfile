# syntax=docker/dockerfile:1
# Danjocord — imagem única, multi-stage:
#   dev     → ambiente de desenvolvimento (compose watch; roda `pnpm dev`)
#   runtime → imagem de produção enxuta (a que vai para o ghcr e o cluster)
#
# node:22-slim (glibc) de propósito: os binários pré-compilados do
# better-sqlite3 — e, a partir do M3, do worker do mediasoup — são glibc;
# alpine/musl forçaria compilar do zero.

FROM node:22-slim AS base
RUN npm install -g pnpm@11.22.0
WORKDIR /app

# ---- deps: só manifestos, para a camada de install cachear bem ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN pnpm install --frozen-lockfile

# ---- dev: código completo + watch (usado pelo docker-compose.yml) ----
FROM deps AS dev
ENV DANJOCORD_DEV_AUTH=1
COPY . .
RUN pnpm --filter @danjocord/protocol build
EXPOSE 8080 5173
CMD ["pnpm", "dev"]

# ---- build: compila protocol + server + client ----
FROM deps AS build
COPY . .
# VITE_API_BASE vazio: em produção o cliente é servido pela MESMA origem do
# backend (static-client.ts) — chamadas relativas, sem CORS. O default
# localhost:8080 é só para o vite dev server.
ENV VITE_API_BASE=""
RUN pnpm --filter @danjocord/protocol build \
 && pnpm --filter @danjocord/server build \
 && pnpm --filter @danjocord/client build

# ---- prod-deps: node_modules só de produção (instalação limpa) ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod

# ---- runtime: o que o cluster roda ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
# scripts/ entra pela CLI de allowlist (node scripts/allowlist.ts — doc §5)
COPY --from=build /app/apps/server/scripts ./apps/server/scripts
# build do vite → cliente estático servido pelo próprio server (static-client.ts)
COPY --from=build /app/apps/client/dist ./apps/server/client-dist
WORKDIR /app/apps/server
RUN mkdir -p data && chown -R node:node data
USER node
EXPOSE 8080 40000/udp 40000/tcp
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
