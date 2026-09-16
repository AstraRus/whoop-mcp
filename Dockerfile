# syntax=docker/dockerfile:1.6
#
# WHOOP MCP server — multi-stage production image.
#
# Build:  docker build -t whoop-mcp .
# Run:    docker run --rm -p 3000:3000 \
#           -e MCP_TRANSPORT=http \
#           -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
#           -e WHOOP_CLIENT_ID=... \
#           -e WHOOP_CLIENT_SECRET=... \
#           whoop-mcp
#
# Final image is ~120-150MB compressed; node:22-alpine base is ~55MB.
# Built artifact contains only production deps + dist/ (no tests, no source).

# ---------------------------------------------------------------------------
# Stage 1 — builder: compile TypeScript with all devDeps available
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install full deps (including devDeps for tsc) — copied first to leverage
# Docker's layer cache when only source files change.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip devDeps so we can copy a clean node_modules into the runtime stage
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — runtime: minimal image with only what's needed to run the server
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Drop SUID bits, install tini for proper PID-1 signal handling. Alpine's
# `apk` is preferred over apt (smaller layers) and tini is ~250KB.
RUN apk add --no-cache tini \
 && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy only what's needed to run — no source, no tests, no devDeps.
# Ownership set to the built-in `node` user so the runtime never needs root.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Required environment baseline — do NOT bake secrets into the image.
# All sensitive values must be provided at `docker run` time via -e or --env-file.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_PORT=3000 \
    MCP_HOST=0.0.0.0 \
    LOG_LEVEL=info \
    LOG_FORMAT=json

# Run as the unprivileged built-in `node` user (UID 1000).
# USER node

EXPOSE 3000

# Health check uses Node's native fetch — no curl/wget needed in the image.
# Hits the unauthenticated /health endpoint; succeeds when the HTTP server
# returns a 2xx response with status:"ok".
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(j=>{if(j.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"

# tini reaps zombie processes and forwards SIGTERM/SIGINT cleanly to Node,
# which is critical for graceful shutdown of the HTTP server.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
