# FusionWorkspace Dockerfile — multi-stage production build
# Base: node:22-alpine for minimal image size

# ---- Build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM node:22-alpine AS production
WORKDIR /app

# Runtime dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Built JS from builder
COPY --from=builder /app/dist ./dist/

# Config templates and scripts
COPY config/ ./config/
COPY scripts/ ./scripts/

# Non-root user
RUN addgroup -S fusion && adduser -S fusion -G fusion
RUN chown -R fusion:fusion /app
USER fusion

ENV NODE_ENV=production
ENV FUSION_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/start.js", "--config", "config/runtime.production.template.json"]
