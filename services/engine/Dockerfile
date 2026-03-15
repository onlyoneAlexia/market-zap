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

# tsx handles extensionless ESM imports and .ts source loading
# (the project uses moduleResolution:"bundler" which omits .js extensions)
RUN npm install -g tsx

ENV NODE_ENV=production

# Copy root manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/engine/package.json services/engine/

# Install production deps only
RUN npm ci --workspace=packages/shared --workspace=services/engine --omit=dev

# Copy shared: dist (compiled) + src (for package.json exports that point to .ts)
COPY --from=build /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build /app/packages/shared/src/ packages/shared/src/

# Copy engine compiled output
COPY --from=build /app/services/engine/dist/ services/engine/dist/

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "--import", "tsx/esm", "services/engine/dist/index.js"]
