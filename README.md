# efpnode

ENSNode plugin (and standalone reference) for indexing the **Ethereum Follow
Protocol** (EFP).

The goal is a single, unified ENS + EFP indexer: one ENSNode process, one
Postgres database, one set of RPC endpoints. EFP becomes just another
plugin you toggle on via the `PLUGINS` env variable.

## Layout

```
packages/
  ensnode-plugin-efp/        # The plugin (drop-in for apps/ensindexer/src/plugins/efp/)
    src/
      abis.ts                #  Event ABIs for ListRegistry / AccountMetadata / ListRecords
      constants.ts           #  Addresses, deploy blocks, opcode/recordtype enums
      schema.ts              #  Abstract ENSDb schema (efp_lists, efp_list_records, ...)
      lib/parse-list-op.ts   #  Pure-TS decoders for ListOp.op and tag payloads
      lib/parse-list-storage-location.ts
      handlers/store.ts      #  EFPStore interface used by every handler
      handlers/ponder-store.ts  # Ponder/Drizzle-backed EFPStore (works with context.ensDb)
      handlers/ListRegistry.ts
      handlers/AccountMetadata.ts
      handlers/ListRecords.ts
      dropin/                #  ENSIndexer-only entry points (plugin.ts + event-handlers.ts)
    test/                    #  30 vitest tests covering parsers + every handler path
examples/
  standalone-ponder/         # Runs the plugin against plain Ponder (PGlite) for verification
docs/
  RESEARCH.md                # Design notes and findings from auditing ENSNode + api-v2
```

## Status

Working proof of concept. The plugin:

- compiles cleanly under `tsc --noEmit` (strict, `noUncheckedIndexedAccess`)
- passes 30 unit tests covering every event path and the race-condition
  pending-metadata drain
- has been run against live Base / Optimism / Ethereum mainnet via the
  standalone Ponder example and verified to index real EFP events into the
  expected `efp_*` tables

See [`packages/ensnode-plugin-efp/README.md`](./packages/ensnode-plugin-efp/README.md)
for the adoption checklist inside an ENSNode checkout, and
[`docs/RESEARCH.md`](./docs/RESEARCH.md) for the design rationale.

## Quick start (standalone)

```sh
pnpm install
pnpm --filter @efpnode/ensnode-plugin-efp test
PONDER_RPC_URL_1=https://ethereum-rpc.publicnode.com \
PONDER_RPC_URL_10=https://mainnet.optimism.io \
PONDER_RPC_URL_8453=https://mainnet.base.org \
  pnpm --filter @efpnode/example-standalone-ponder smoke
pnpm --filter @efpnode/example-standalone-ponder exec tsx scripts/inspect-db.ts
```
