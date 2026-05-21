# Standalone Ponder example for `@efpnode/ensnode-plugin-efp`

This example runs the EFP plugin against plain Ponder, with an in-memory
PGlite database. Goal: prove the plugin's ABIs, contract coordinates,
schema, and event handlers compose into a valid Ponder app — so when the
same files land in an ENSNode checkout, ENSIndexer can register them with
no friction.

## What this verifies

When you run `ponder dev`, Ponder will:

1. Load `ponder.config.ts` and resolve every `EFP_CONTRACTS` address from
   the plugin's `constants.ts`.
2. Load `ponder.schema.ts`, which re-exports the plugin's abstract schema
   verbatim (seven tables, including the new `efp_offline_lists` and
   `efp_ens_list_pointers`).
3. Load `src/index.ts`, which calls `ponder.on(...)` for all six EFP
   events (`Transfer`, `UpdateListStorageLocation`,
   `UpdateAccountMetadata`, `ListOp`, `UpdateListMetadata`, and the
   ENS resolver `TextChanged` event pre-filtered by `indexedKey ==
   keccak256("eth.efp.list")`).
4. Set up its HTTP API at `http://localhost:42069`.
5. Start the backfill against the three configured chains.

If the schema, ABIs, or event names disagreed with the plugin source,
Ponder would error during step 1-3. Successful boot means the plugin's
public surface is internally consistent and will work the same way under
ENSIndexer (which routes the same handler registrations through its
`addOnchainEventListener` wrapper).

### Env vars

| Var                            | Purpose                                                                  |
|--------------------------------|--------------------------------------------------------------------------|
| `PONDER_RPC_URL_1`             | HTTPS RPC endpoint for Ethereum mainnet.                                 |
| `PONDER_RPC_URL_10`            | HTTPS RPC endpoint for Optimism.                                         |
| `PONDER_RPC_URL_8453`          | HTTPS RPC endpoint for Base.                                             |
| `DATABASE_SCHEMA`              | Postgres schema name (default: ponder's prompt; smoke uses `ponder_efp_smoke`). |
| `PONDER_RESOLVER_ADDRESSES`    | Comma-separated resolver addresses on chain 1 to watch for `TextChanged`. Defaults to the canonical ENS PublicResolver `0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63`. Set to `""` to opt out entirely. |

## Running

You need HTTP RPC endpoints for Base, Optimism, and Ethereum mainnet.
Public free endpoints work; private ones (Alchemy, Infura, …) work
faster.

```sh
pnpm install
PONDER_RPC_URL_1=https://ethereum-rpc.publicnode.com \
PONDER_RPC_URL_10=https://mainnet.optimism.io \
PONDER_RPC_URL_8453=https://mainnet.base.org \
DATABASE_SCHEMA=ponder_efp \
  pnpm dev
```

The default start blocks (in `@efpnode/ensnode-plugin-efp/constants`) are
the EFP deployment blocks, so a full backfill indexes ~25M Base blocks +
~32M Optimism blocks + ~1.4M Ethereum blocks.

## Smoke test (recommended)

`scripts/smoke-test.ts` runs `ponder dev` over a narrow recent-block
window (default 200 blocks per chain, override with `EFP_SMOKE_BLOCKS=`)
so you can confirm the plugin indexes real events without waiting for a
full backfill.

```sh
EFP_SMOKE_BLOCKS=20000 \
PONDER_RPC_URL_1=https://ethereum-rpc.publicnode.com \
PONDER_RPC_URL_10=https://mainnet.optimism.io \
PONDER_RPC_URL_8453=https://mainnet.base.org \
  pnpm smoke
```

After a couple of minutes Ctrl-C the smoke test and inspect the PGlite
database:

```sh
pnpm exec tsx scripts/inspect-db.ts
```

In a recent run against ~20k blocks per chain near tip, the inspector
found:

```
efp_lists                      2 rows
efp_list_records               14 rows
efp_list_record_tags           0 rows
efp_account_metadata           2 rows
efp_pending_list_metadata      0 rows
efp_offline_lists              0 rows
efp_ens_list_pointers          0 rows
```

…with all known EFP event types correctly handled: `Transfer` created
the list rows, `UpdateListStorageLocation` set the storage location
chain id (dispatching on `locationType`), `UpdateListMetadata` populated
the `user` and `manager` columns via the pending-metadata drain,
`ListOp` (opcode 1) inserted the address-type records, and
`UpdateAccountMetadata` stored the `primary-list` pointer for each
minter. The new tables (`efp_offline_lists`, `efp_ens_list_pointers`)
are empty because no list has set a `locationType=2` LSL on mainnet
(it's a freshly defined format) and no name has published the
`eth.efp.list` text record yet — both are exercised by the offline
demo below.

## Offline list demo

`scripts/offline-demo.ts` exercises the full offline-LSL pipeline end
to end without depending on a live `locationType=2` LSL onchain:

1. Starts a local HTTP server that serves a synthetic offline list
   payload.
2. Seeds `efp_lists` + `efp_offline_lists` with a synthetic token id
   that points at the local server.
3. Runs `OfflineListSyncer.runOnce()` against the standalone PGlite
   directory.
4. Reads back the resulting `efp_list_records`, `efp_list_record_tags`,
   and the `user` / `manager` columns on the list row.

```sh
# Run a smoke test first so the schema is migrated.
pnpm smoke
# Ctrl-C the smoke once it has indexed a few blocks, then:
pnpm exec tsx scripts/offline-demo.ts
```

Expected output (abbreviated):

```
seeded offline list token_id=999999 url=https://127.0.0.1:<port>/...
{"level":"info","msg":"syncer.list.ok","data":{"token_id":"999999","records":3,"tags":1}}
indexed records: [
  { record_data: '0xaaa…aaa' },
  { record_data: '0xbbb…bbb' },
  { record_data: '0xccc…ccc' }
]
indexed tags:    [ { tag: 'close-friend' } ]
list metadata:   [ { user: '0x111…111', manager: '0x222…222' } ]
```

## Offline syncer (long-running)

`scripts/offline-sync.ts` wraps `OfflineListSyncer` for production use:

```sh
# one batch then exit (useful from cron)
pnpm exec tsx scripts/offline-sync.ts

# loop, default 60s cadence
pnpm exec tsx scripts/offline-sync.ts --watch

# custom cadence + schema
pnpm exec tsx scripts/offline-sync.ts --watch --cadence-ms=30000 --schema=ponder_efp
```

## Typecheck only

```sh
pnpm typecheck
```

A successful `tsc --noEmit` is itself a meaningful verification — Ponder
0.16's contract typings are precise enough that mismatched event names
or argument shapes are a compile error.
