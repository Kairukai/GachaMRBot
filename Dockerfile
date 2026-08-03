# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Copied separately so dependency layers cache independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini reaps zombies and forwards signals. ShardingManager spawns children, so
# without it a stopped container leaves orphaned shard processes behind.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Needed at runtime by src/migrate.ts.
COPY drizzle ./drizzle

# node-alpine ships an unprivileged `node` user; don't run the bot as root.
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node dist/src/migrate.js && node dist/src/index.js"]
