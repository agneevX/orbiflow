# Multi-arch server-only build:
# Build static SPA + server bundle natively on $BUILDPLATFORM for fast, reliable
# cross-architecture images (linux/amd64, linux/arm64, linux/arm/v7).
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html tsconfig.json vite.config.ts server.ts ./
COPY src ./src
COPY server ./server

RUN npm run build && \
  npx esbuild server.ts --bundle --platform=node --format=esm --packages=external --outfile=/app/server.mjs

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV ORBIFLOW_CONFIG_DIR=/config
ENV ORBIFLOW_CACHE_DIR=/config/cache
ENV ORBIFLOW_GEOIP_DIR=/config/geoip

COPY package.json ./
RUN node -e "const d = require('./package.json').dependencies; console.log(['express', 'ws', 'dotenv', 'maxmind'].map((k) => k + '@' + d[k]).join(' '));" \
  | xargs npm install --no-save --no-audit --no-fund && \
  rm -f package.json package-lock.json && \
  mkdir -p /config/cache /config/geoip

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.mjs ./server.mjs

EXPOSE 3000
VOLUME ["/config"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
