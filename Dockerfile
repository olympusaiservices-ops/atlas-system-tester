# ── Build stage: compile the web SPA and the server ──────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build

# Install all workspace deps (root drives the `server` and `web` workspaces).
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

# Build both workspaces.
COPY . .
RUN npm run build:web && npm run build:server

# ── Runtime stage: minimal image serving the API + static SPA ─────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    VERIFY_WEB_DIR=/app/web/dist \
    VERIFY_DATA_DIR=/data/atlas-verify

# Production-only dependencies for the server (fastify, @fastify/static, jose).
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev --no-workspaces --no-package-lock

# Built artifacts.
COPY --from=builder /build/server/dist ./server/dist
COPY --from=builder /build/web/dist ./web/dist
COPY VERSION ./VERSION

# Run as non-root; the data dir is a mounted volume.
RUN mkdir -p /data/atlas-verify \
 && addgroup -S atlas && adduser -S atlas -G atlas \
 && chown -R atlas:atlas /app /data/atlas-verify
USER atlas

EXPOSE 8080

CMD ["node", "server/dist/main.js"]
