# Multi-stage build (works on both AMD64 and Oracle ARM64 Ampere)
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.ui.json vite.config.ts ./
COPY src ./src
COPY ui ./ui
COPY data ./data

RUN npm run ui:build

FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist-ui ./dist-ui
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/data ./data

USER node

EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "src/server.ts"]
