# ── Stage 1: Install dependencies ──────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy root workspace manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/engine/package.json services/engine/

# Install all workspace deps (production + dev for build step)
RUN npm ci --workspace=packages/shared --workspace=services/engine

# ── Stage 2: Build shared → engine ────────────────────────────────
FROM deps AS build

# Copy source for shared package
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/

# Build shared first (engine depends on it)
RUN npm run build --workspace=packages/shared

# Copy engine source and build
COPY services/engine/ services/engine/
RUN npm run build --workspace=services/engine

# ── Stage 3: Production image ─────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install starkli for keystore decryption
RUN apk add --no-cache curl bash && \
    curl https://get.starkli.sh | bash && \
    /root/.starkli/bin/starkliup && \
    ln -s /root/.starkli/bin/starkli /usr/local/bin/starkli

ENV NODE_ENV=production

# Copy root manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/engine/package.json services/engine/

# Install production deps only
RUN npm ci --workspace=packages/shared --workspace=services/engine --omit=dev

# Copy built artifacts
COPY --from=build /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build /app/packages/shared/src/abis/ packages/shared/src/abis/
COPY --from=build /app/packages/shared/src/addresses/ packages/shared/src/addresses/
COPY --from=build /app/services/engine/dist/ services/engine/dist/

# Patch shared package.json exports to use compiled JS (not TS source)
# The original points to ./src/*.ts for bundlers, but Node.js needs ./dist/*.js
RUN sed -i 's|./src/index.ts|./dist/index.js|g; s|./src/types/index.ts|./dist/types/index.js|g' packages/shared/package.json

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "services/engine/dist/index.js"]
