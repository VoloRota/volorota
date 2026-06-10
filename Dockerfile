# VoloRota — self-hosted church volunteer scheduler
# Single-container image; all persistent state lives under /data (mount a volume).

FROM oven/bun:1-slim AS base

WORKDIR /app

# ---- dependencies ----
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- final image ----
FROM base AS runner

# Non-root user for least-privilege execution
RUN groupadd --system --gid 1001 volorota && \
    useradd  --system --uid 1001 --gid volorota --no-create-home volorota

WORKDIR /app

# Copy installed production deps from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY package.json ./
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

# Create /data owned by app user BEFORE declaring it as a VOLUME.
# Docker copies this directory's ownership into new anonymous volumes,
# so the non-root user can write the SQLite file.
RUN mkdir -p /data && chown volorota:volorota /data

# Persistent data directory — mount a host volume here
VOLUME /data

# Default env vars (override at runtime)
ENV VOLOROTA_DB=/data/volorota.db
ENV VOLOROTA_PORT=3000

EXPOSE 3000

USER volorota

CMD ["bun", "run", "src/index.ts"]
