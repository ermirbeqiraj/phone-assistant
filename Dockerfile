# bookworm-slim (glibc), NOT alpine: onnxruntime-node ships glibc-only prebuilt
# binaries (no musl build), so the native VAD addon won't load on alpine.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
# Install prod deps WITHOUT auto-running build scripts, then explicitly rebuild
# onnxruntime-node to fetch its native binary. We can't rely on the auto postinstall:
# CI's pnpm (v11, unpinned via corepack) hard-errors on ignored build scripts
# (ERR_PNPM_IGNORED_BUILDS) even with the package allow-listed in a v9 lockfile.
# --ignore-scripts skips that gate; `pnpm rebuild` then forces the one binary we need.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
 && pnpm rebuild onnxruntime-node
COPY --from=builder /app/dist ./dist
COPY persona.json ./
COPY assets ./assets
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
