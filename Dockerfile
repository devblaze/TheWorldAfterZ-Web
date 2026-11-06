# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 LAUNCHER_DIR=/launcher
# Prisma CLI for `migrate deploy` at start (the standalone bundle only has the client).
RUN npm install -g prisma@6.19.3 && npm cache clean --force
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app && mkdir -p /launcher && chown app:app /launcher
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
# standalone server.js serves public/ only if it sits next to it (screenshots, next/image sources).
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/scripts ./scripts
USER app
EXPOSE 3000
CMD ["sh", "-c", "prisma migrate deploy && exec node server.js"]
