# Multi-arch slim server image (~75 MB):
# Stage 1 compiles the static SPA, bundles & minifies server.mjs, and prepares
# minimal pure-JS production dependencies on $BUILDPLATFORM (no QEMU npm overhead).
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html tsconfig.json vite.config.ts server.ts ./
COPY src ./src
COPY server ./server

RUN npm run build && \
  npx esbuild server.ts --bundle --platform=node --format=esm --minify --packages=external --outfile=/app/server.mjs && \
  mkdir -p /prod-deps && \
  node -e "const d = require('./package.json').dependencies; const fs = require('fs'); fs.writeFileSync('/prod-deps/package.json', JSON.stringify({ private: true, dependencies: { express: d.express, ws: d.ws, ssh2: d.ssh2 } }));" && \
  npm --prefix /prod-deps install --omit=dev --omit=optional --no-audit --no-fund --no-package-lock && \
  find /prod-deps/node_modules -type f \( -name "*.md" -o -name "*.markdown" -o -name "*.map" -o -name "*.ts" -o -name "LICENSE*" -o -name "CHANGELOG*" -o -name "HISTORY*" \) -delete && \
  find /prod-deps/node_modules -type d \( -name "test" -o -name "tests" -o -name "examples" -o -name "doc" -o -name "docs" \) -prune -exec rm -rf {} +

# Stage 2: Minimal Alpine runtime with nodejs only (no npm, corepack, yarn, or build toolchain)
FROM alpine:3.21 AS runner
WORKDIR /app

ENV PUID=1000
ENV PGID=1000
ENV TZ=UTC
ENV NODE_ENV=production

RUN apk add --no-cache nodejs su-exec tzdata && \
  addgroup -g 1000 -S orbiflow && \
  adduser -u 1000 -S -D -H -h /config -s /sbin/nologin -G orbiflow orbiflow && \
  mkdir -p /config/cache && \
  chown -R orbiflow:orbiflow /config

COPY --from=builder /prod-deps/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.mjs ./server.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
  chmod 0755 /usr/local/bin/docker-entrypoint.sh && \
  chmod -R a+rX /app

EXPOSE 3000
VOLUME ["/config"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
