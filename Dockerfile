# ── Stage 1: deps (production) ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

# Install production deps + generate Prisma client
RUN npm ci --omit=dev && \
    npx prisma generate

# ── Stage 2: migrate (includes prisma CLI devDep) ─────────────────────────────
FROM node:20-bookworm-slim AS migrate
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

# Install all deps (including devDeps for prisma CLI)
RUN npm ci && \
    npx prisma generate

CMD ["npx", "prisma", "migrate", "deploy"]

# ── Stage 3: production image ──────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy production node_modules (includes generated @prisma/client)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma

# Copy application source
COPY src ./src
COPY package.json ./

# Non-root user for security
RUN groupadd --system app && useradd --system --gid app app
USER app

EXPOSE 3000

CMD ["node", "src/server.js"]
