# syntax=docker/dockerfile:1.6

# ---------- 1. deps: install prod-only node_modules ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---------- 2. runtime: minimal image ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app

# Non-root user
RUN addgroup -S app && adduser -S app -G app

# dumb-init gives us PID 1 signal handling.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .

USER app
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
