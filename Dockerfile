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

ENV PUID=1000
ENV PGID=1000
ENV TZ=UTC

RUN apk add --no-cache su-exec tzdata && \
  deluser --remove-home node 2>/dev/null || true && \
  delgroup node 2>/dev/null || true && \
  addgroup -g 1000 -S orbiflow && \
  adduser -u 1000 -S -D -H -h /app -s /sbin/nologin -G orbiflow orbiflow

COPY package.json ./
RUN node -e "const d = require('./package.json').dependencies; console.log(['express', 'ws', 'maxmind'].map((k) => k + '@' + d[k]).join(' '));" \
  | xargs npm install --no-save --no-audit --no-fund && \
  rm -f package.json package-lock.json && \
  mkdir -p /config/cache /config/geoip && \
  chown -R orbiflow:orbiflow /config

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.mjs ./server.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
VOLUME ["/config"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
