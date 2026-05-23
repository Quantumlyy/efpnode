# syntax=docker/dockerfile:1.7
#
# Production image for the `@efpnode/example-standalone-ponder` indexer.
# Runs `ponder start` from inside the monorepo so the workspace dep
# `@efpnode/ensnode-plugin-efp` resolves to the same source the tests cover.
#
# Required runtime env vars:
#   DATABASE_URL          — Postgres connection string (Railway provides this).
#   PONDER_RPC_URL_1      — Ethereum mainnet RPC (default baked into config).
#   PONDER_RPC_URL_10     — Optimism RPC.
#   PONDER_RPC_URL_8453   — Base RPC.
#   PORT                  — HTTP port (Railway injects this).
#   DATABASE_SCHEMA       — optional Postgres schema (default: ponder picks).

FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ensnode-plugin-efp/package.json packages/ensnode-plugin-efp/package.json
COPY examples/standalone-ponder/package.json examples/standalone-ponder/package.json

RUN pnpm install --frozen-lockfile

COPY packages/ensnode-plugin-efp packages/ensnode-plugin-efp
COPY examples/standalone-ponder examples/standalone-ponder

WORKDIR /app/examples/standalone-ponder

ENV NODE_ENV=production
EXPOSE 42069

CMD ["sh", "-c", "pnpm exec ponder start --port ${PORT:-42069} --hostname 0.0.0.0"]
