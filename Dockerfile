FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && npm ci \
    && npm_config_build_from_source=true npm rebuild better-sqlite3 \
    && node -e "require('better-sqlite3')" \
    && rm -rf /var/lib/apt/lists/*

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build \
    && npm run licenses:generate \
    && npm run licenses:verify

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HOME=/tmp
ENV COFORGE_CONFIG_DIR=/var/lib/coforge
WORKDIR /app
RUN groupadd --gid 10001 coforge \
    && useradd --no-create-home --uid 10001 --gid 10001 --shell /usr/sbin/nologin coforge \
    && mkdir -p /var/lib/coforge \
    && chown coforge:coforge /var/lib/coforge \
    && rm -rf /var/lib/apt/lists/* /tmp/*
COPY --from=builder --chown=root:root /app/.next/standalone ./
COPY --from=builder --chown=root:root /app/.next/static ./.next/static
COPY --from=builder --chown=root:root /app/data/coal-demo.db ./data/coal-demo.db
COPY --from=builder --chown=root:root /app/LICENSE /app/NOTICE ./licenses/
COPY --from=builder --chown=root:root /app/artifacts/licenses/third-party ./licenses/third-party
COPY --from=builder --chown=root:root /app/scripts/container-healthcheck.js ./container-healthcheck.js
USER coforge
EXPOSE 3000
VOLUME ["/var/lib/coforge"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "/app/container-healthcheck.js"]
CMD ["node", "server.js"]
