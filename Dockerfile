# syntax=docker/dockerfile:1.7
#
# Production image: clones a pinned ENSNode tree, applies the EFP plugin
# integration (see scripts/integrate-into-ensnode.sh), installs deps, and
# runs ENSIndexer.
#
# Required runtime env vars (set on Railway):
#   DATABASE_URL                   — Postgres URL (Railway internal DNS works).
#   NAMESPACE                      — `mainnet` (EFP only has a mainnet deployment).
#   PLUGINS                        — comma-separated, e.g.
#                                      subgraph,basenames,protocol-acceleration,
#                                      registrars,tokenscope,efp
#   LABEL_SET_ID                   — `subgraph` for default ENS label resolution.
#   LABEL_SET_VERSION              — `0`.
#   DB_SCHEMA_VERSION              — `3`.
#   ENSINDEXER_SCHEMA_NAME         — Postgres schema for the Ponder app.
#   RPC_URL_<chainId>              — per-chain RPC. Required for every chain
#                                    the enabled PLUGINS touch.
#   PORT                           — HTTP port (Railway injects 8080).
#
# Convenience bridge: if legacy `PONDER_RPC_URL_<chainId>` is set from the
# previous standalone-ponder deploy and the canonical `RPC_URL_<chainId>` is
# not, we forward the value so re-keying isn't required.

FROM node:24-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

# ----- clone upstream ENSNode at a pinned tag ---------------------------------
ARG ENSNODE_REF=v1.15.1
RUN git clone --depth=1 --branch="$ENSNODE_REF" \
      https://github.com/namehash/ensnode.git /app
WORKDIR /app

# ----- apply EFP plugin integration ------------------------------------------
COPY packages/ensnode-plugin-efp/src/  /tmp/efp-plugin/src/
COPY scripts/integrate-into-ensnode.sh /tmp/integrate.sh
RUN bash /tmp/integrate.sh /app /tmp/efp-plugin/src

# ----- install --------------------------------------------------------------
# Note: Railway's builder rejects unprefixed `--mount=type=cache` ids, and the
# pnpm fetch cost on cold builds is acceptable here. Skip the cache mount.
RUN pnpm install --frozen-lockfile

# ----- runtime --------------------------------------------------------------
WORKDIR /app/apps/ensindexer
ENV NODE_ENV=production
EXPOSE 42069

CMD ["sh", "-c", "\
: \"${RPC_URL_1:=${PONDER_RPC_URL_1:-}}\"; \
: \"${RPC_URL_10:=${PONDER_RPC_URL_10:-}}\"; \
: \"${RPC_URL_8453:=${PONDER_RPC_URL_8453:-}}\"; \
export RPC_URL_1 RPC_URL_10 RPC_URL_8453; \
exec pnpm exec ponder --root ./ponder start \
  --schema \"${ENSINDEXER_SCHEMA_NAME:-ensindexer}\" \
  --port \"${PORT:-42069}\" \
  --hostname 0.0.0.0\
"]
