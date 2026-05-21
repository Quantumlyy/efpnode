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
   verbatim.
3. Load `src/index.ts`, which calls `ponder.on(...)` for all five EFP
   events (`Transfer`, `UpdateListStorageLocation`,
   `UpdateAccountMetadata`, `ListOp`, `UpdateListMetadata`).
4. Set up its HTTP API at `http://localhost:42069`.
5. Start the backfill against the three configured chains.

If the schema, ABIs, or event names disagreed with the plugin source,
Ponder would error during step 1-3. Successful boot means the plugin's
public surface is internally consistent and will work the same way under
ENSIndexer (which routes the same handler registrations through its
`addOnchainEventListener` wrapper).

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
```

…with all five known EFP event types correctly handled: `Transfer`
created the list rows, `UpdateListStorageLocation` set the storage
location chain id, `UpdateListMetadata` populated the `user` and
`manager` columns via the pending-metadata drain, `ListOp` (opcode 1)
inserted the address-type records, and `UpdateAccountMetadata` stored
the `primary-list` pointer for each minter.

## Typecheck only

```sh
pnpm typecheck
```

A successful `tsc --noEmit` is itself a meaningful verification — Ponder
0.16's contract typings are precise enough that mismatched event names
or argument shapes are a compile error.
