# ---- build stage ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- serve stage: zero-dependency node runtime, no node_modules ----
# docker/serve.mjs serves dist/ (SPA + immutable asset caching) and delegates
# the /api/autoperf/* endpoints to server/api.ts using only node built-ins
# (node 24 runs the .ts module natively via type stripping).
FROM node:24-alpine
WORKDIR /app

COPY docker/serve.mjs ./docker/serve.mjs
COPY server/api.ts ./server/api.ts
COPY --from=build /app/dist ./dist

ENV AUTO_PERF_LOG_DIR=/data/auto_perf_logs
EXPOSE 4173
CMD ["node", "docker/serve.mjs"]
