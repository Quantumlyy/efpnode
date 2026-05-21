# `@efpnode/ensnode-plugin-efp`

ENSIndexer plugin that indexes the **Ethereum Follow Protocol** (EFP) so a
single ENSNode process can serve both ENS and EFP data out of one
Postgres database.

The plugin's source tree mirrors the layout of the existing ENSIndexer
plugins (`registrars`, `tokenscope`, …) so dropping it into an ENSNode
checkout is mechanical — see [`src/dropin/README.md`](./src/dropin/README.md).

## What it indexes

EFP has three onchain contracts:

| Contract        | Chain(s)                       |
|-----------------|--------------------------------|
| `ListRegistry`  | Base                            |
| `AccountMetadata` | Base                          |
| `ListRecords`   | Base, Optimism, Ethereum mainnet |

The plugin listens for these events:

- `ListRegistry.Transfer` — list NFT mint/transfer.
- `ListRegistry.UpdateListStorageLocation` — list points at a (chain,
  contract, slot) tuple holding its records; the plugin also drains any
  pending list-metadata staged before this event was seen.
- `AccountMetadata.UpdateAccountMetadata` — `(address, key) → value`
  upsert (today only `primary-list` is used).
- `ListRecords.ListOp` — opcode-dispatched add/remove of records and
  tags. Address-type records (`recordType === 1`) are truncated to
  exactly 20 bytes, matching the api-v2 reference behaviour for users
  who appended junk after the address.
- `ListRecords.UpdateListMetadata` — updates `user`/`manager` on the
  matching list NFT, or stages the value into
  `efp_pending_list_metadata` if the list NFT row isn't known yet.

## Tables

All tables live under the ENSDb abstract schema and are prefixed `efp_`:

| Table                       | Purpose                                            |
|-----------------------------|----------------------------------------------------|
| `efp_lists`                 | One row per list NFT, with owner / user / manager. |
| `efp_list_records`          | All records currently in each list.                |
| `efp_list_record_tags`      | Many-to-many between records and string tags.      |
| `efp_account_metadata`      | Most recent value per `(address, key)`.            |
| `efp_pending_list_metadata` | Race-condition staging area.                       |

Schemas and indexes are defined in [`src/schema.ts`](./src/schema.ts)
and are a 1:1 port of the api-v2 reference tables.

## Adoption inside an ENSNode checkout

The minimum integration is:

```
1. Add `EFP = "efp"` to `PluginName` in
   `packages/ensnode-sdk/src/ensindexer/config/types.ts`.

2. Drop `packages/ensnode-plugin-efp/src/` (this folder) into
   `apps/ensindexer/src/plugins/efp/`, moving `src/dropin/*.ts`
   one level up so they sit next to `plugin.ts`/`event-handlers.ts`.

3. Copy `src/schema.ts` to
   `packages/ensdb-sdk/src/ensindexer-abstract/efp.schema.ts` and
   re-export it from the abstract schema's `index.ts`.

4. Add the plugin's default export to `ALL_PLUGINS` in
   `apps/ensindexer/src/plugins/index.ts`.

5. In `apps/ensindexer/ponder/src/register-handlers.ts`:

       import attach_EFPHandlers from "@/plugins/efp/event-handlers";

       if (config.plugins.includes(PluginName.EFP)) {
         attach_EFPHandlers();
       }

6. Run ENSIndexer with `PLUGINS=subgraph,efp` and RPC env vars for
   chains 1, 10, and 8453.
```

See [`src/dropin/README.md`](./src/dropin/README.md) for the line-by-line
commentary on why a few imports inside `dropin/*.ts` use
`@ts-expect-error` until the files are moved into ENSIndexer.

## Verification

```sh
pnpm install
pnpm --filter @efpnode/ensnode-plugin-efp test       # 30 unit tests
pnpm --filter @efpnode/ensnode-plugin-efp typecheck  # tsc --noEmit
pnpm --filter @efpnode/example-standalone-ponder smoke   # live RPC backfill
```

A recent smoke run over ~20,000 blocks per chain near tip produced two
list NFTs, fourteen address records, and two `primary-list` account
metadata rows — all from real onchain activity, with every code path
exercised end-to-end. See [`examples/standalone-ponder/README.md`](../../examples/standalone-ponder/README.md).
