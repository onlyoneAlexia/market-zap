# ── Stage 1: Install dependencies ──────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/engine/package.json services/engine/

RUN npm ci --workspace=packages/shared --workspace=services/engine

# ── Stage 2: Copy all source ──────────────────────────────────────
FROM deps AS final

# Install starkli for keystore decryption
RUN apk add --no-cache curl bash && \
    curl https://get.starkli.sh | bash && \
    /root/.starkli/bin/starkliup && \
    ln -s /root/.starkli/bin/starkli /usr/local/bin/starkli

ENV NODE_ENV=production

# Copy all source (tsx runs TypeScript directly — no build step needed)
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY services/engine/ services/engine/

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

# tsx is already installed as a devDependency of the engine
CMD ["npx", "tsx", "services/engine/src/index.ts"]
