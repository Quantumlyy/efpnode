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
      abis.ts                #  ABIs for ListRegistry / AccountMetadata / ListRecords / Resolver
      constants.ts           #  Addresses, deploy blocks, opcode/recordtype enums
      schema.ts              #  Abstract ENSDb schema (efp_lists, efp_list_records, …)
      lib/parse-list-op.ts                    #  ListOp.op and tag payload decoders
      lib/parse-list-storage-location.ts      #  Tagged-union decoder (locationType 1+2)
      lib/parse-efp-list-text-record.ts       #  ENS text-record value decoder
      lib/offline-slot.ts                     #  Deterministic offline slot formula
      handlers/store.ts            #  EFPStore interface used by every handler
      handlers/ponder-store.ts     #  Ponder/Drizzle-backed EFPStore
      handlers/ListRegistry.ts
      handlers/AccountMetadata.ts
      handlers/ListRecords.ts
      handlers/Resolver.ts         #  eth.efp.list TextChanged handler
      offline/payload.ts           #  Strict JSON-payload validator
      offline/syncer.ts            #  OfflineListSyncer (fetch + reconcile)
      dropin/                      #  ENSIndexer-only entry points
    test/                          #  72 vitest tests
examples/
  standalone-ponder/         #  Runs the plugin against plain Ponder (PGlite)
    scripts/smoke-test.ts          #  Live-RPC backfill over a narrow window
    scripts/inspect-db.ts          #  Read-only row-count + sample reporter
    scripts/offline-sync.ts        #  Long-running OfflineListSyncer driver
    scripts/offline-demo.ts        #  End-to-end syncer demo against a local HTTP server
docs/
  RESEARCH.md                #  Design notes and findings
```

## Capabilities

- Indexes all EFP onchain state — ListRegistry (Base), AccountMetadata
  (Base), and ListRecords on Base / Optimism / Ethereum mainnet — into
  the standard `efp_*` schema.
- Supports an **offline (`locationType = 2`) ListStorageLocation**
  extension: a list NFT can point at an HTTPS URL serving its records,
  and the bundled `OfflineListSyncer` polls those URLs on an interval,
  validates the URL hash committed onchain, applies conditional-GET
  caching, and reconciles records & tags into the same
  `efp_list_records` table.
- Indexes a well-known ENS text record (`eth.efp.list`, configurable)
  into `efp_ens_list_pointers` so consumers can answer "which EFP list
  does `vitalik.eth` claim?" with a single join.

## Status

Working proof of concept. The plugin:

- compiles cleanly under `tsc --noEmit` (strict, `noUncheckedIndexedAccess`)
- passes 72 unit tests covering parsers, every handler path, the
  offline payload validator, and the syncer's full state machine
  (conditional GET, URL-hash recompute, exponential backoff, content-type
  / size guardrails)
- has been run against live Base / Optimism / Ethereum mainnet via the
  standalone Ponder example and verified to index real EFP events into
  the expected `efp_*` tables
- has had its offline-syncer pipeline verified end-to-end against a
  local HTTP server (`scripts/offline-demo.ts`) writing through the
  same PGlite database

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
pnpm --filter @efpnode/example-standalone-ponder exec tsx scripts/offline-demo.ts
```
