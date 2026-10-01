# syntax=docker/dockerfile:1

# ---- build: install deps, bundle the frontend, prune dev deps ----
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries for glibc/musl x64+arm64, so no install scripts are needed.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY web ./web
COPY server ./server
RUN npm run build && npm prune --omit=dev && mkdir -p /data/files

# ---- runtime: distroless (no shell, no package manager), non-root ----
FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY --from=build --chown=0:0 /app/package.json ./
COPY --from=build --chown=0:0 /app/node_modules ./node_modules
COPY --from=build --chown=0:0 /app/server ./server
COPY --from=build --chown=0:0 /app/dist ./dist
# Only the data volume is writable by the app user (65532).
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["server/index.js"]
