# `@efpnode/ensnode-plugin-efp`

ENSIndexer plugin that indexes the **Ethereum Follow Protocol** (EFP) so a
single ENSNode process can serve both ENS and EFP data out of one
Postgres database.

The plugin's source tree mirrors the layout of the existing ENSIndexer
plugins (`registrars`, `tokenscope`, …) so dropping it into an ENSNode
checkout is mechanical — see [`src/dropin/README.md`](./src/dropin/README.md).

## What it indexes

EFP has three onchain contracts:

| Contract          | Chain(s)                         |
|-------------------|----------------------------------|
| `ListRegistry`    | Base                             |
| `AccountMetadata` | Base                             |
| `ListRecords`     | Base, Optimism, Ethereum mainnet |

Plus two value-add subscriptions added by this plugin:

| Surface                                              | Source                                |
|------------------------------------------------------|---------------------------------------|
| Offline `ListStorageLocation` (HTTPS-backed lists)   | new `locationType == 2` LSL payload   |
| `eth.efp.list` ENS text record                        | any resolver on chain 1               |

The plugin listens for these events:

- `ListRegistry.Transfer` — list NFT mint/transfer.
- `ListRegistry.UpdateListStorageLocation` — list points at a (chain,
  contract, slot) tuple holding its records. The plugin decodes the
  payload, supporting both `locationType=1` (onchain) and a new
  `locationType=2` (offline / HTTPS). It also drains any pending
  list-metadata staged before this event was seen.
- `AccountMetadata.UpdateAccountMetadata` — `(address, key) → value`
  upsert (today only `primary-list` is used).
- `ListRecords.ListOp` — opcode-dispatched add/remove of records and
  tags. Address-type records (`recordType === 1`) are truncated to
  exactly 20 bytes, matching the api-v2 reference behaviour for users
  who appended junk after the address.
- `ListRecords.UpdateListMetadata` — updates `user`/`manager` on the
  matching list NFT, or stages the value into
  `efp_pending_list_metadata` if the list NFT row isn't known yet.
- `Resolver.TextChanged` — only for `indexedKey == keccak256("eth.efp.list")`;
  writes to `efp_ens_list_pointers`.

## Tables

All tables live under the ENSDb abstract schema and are prefixed `efp_`:

| Table                       | Purpose                                                                  |
|-----------------------------|--------------------------------------------------------------------------|
| `efp_lists`                 | One row per list NFT, with owner / user / manager.                       |
| `efp_list_records`          | All records currently in each list (onchain OR offline).                 |
| `efp_list_record_tags`      | Many-to-many between records and string tags.                            |
| `efp_account_metadata`      | Most recent value per `(address, key)`.                                  |
| `efp_pending_list_metadata` | Race-condition staging area.                                             |
| `efp_offline_lists`         | Bookkeeping for HTTPS-backed lists (URL, ETag, next sync, failure count).|
| `efp_ens_list_pointers`     | Cross-correlation: ENS namehash → EFP list NFT.                          |

Schemas and indexes are defined in [`src/schema.ts`](./src/schema.ts).
The first five tables are 1:1 ports of the api-v2 reference tables;
`efp_offline_lists` and `efp_ens_list_pointers` are added by this plugin.

## Offline list storage location (`locationType = 2`)

EFP's onchain `ListStorageLocation` only covers EVM-onchain backends in
the upstream contracts (`locationType = 1`). This plugin extends the
encoding with a second `locationType` so a list owner can publish their
records at an HTTP(S) URL instead, indexed on an interval.

Wire format (extension):

```
listStorageLocation := version (1)            // == 0x01
                     | locationType (1)       // == 0x02
                     | chainId (32)           // big-endian uint256, == 0 for unbound
                     | urlHash (32)           // keccak256(utf8(url))
                     | url (variable, UTF-8)  // tail
```

Response format (HTTPS, `Content-Type: application/json`):

```jsonc
{
  "version": 1,
  "tokenId": "1234",
  "records": [
    {
      "version": 1,
      "recordType": 1,
      "data": "0xae20540...",
      "tags": ["close-friend"]
    }
  ],
  "metadata": { "user": "0x...", "manager": "0x..." }
}
```

The records are stored under the deterministic offline slot
`slot = keccak256("efp-offline" || tokenId)` with `chain_id = 0` and
`contract_address = 0x000…000`, so downstream consumers join the same
`efp_list_records` table whether the list is onchain or offline.

The `OfflineListSyncer` (`src/offline/syncer.ts`) polls
`efp_offline_lists` on an interval, validates each row's
`keccak256(url) == urlHash` invariant, issues a conditional GET, parses
the payload, and reconciles records & tags atomically. Failures
exponentially back off from 10 s to 30 min. The syncer is
framework-free: it takes an `EFPStore`, a `fetch`, and a `clock`, so it
can be deployed as a sidecar process next to ENSIndexer or run inline
inside any other Node/Bun/Deno process.

See [`docs/RESEARCH.md`](../../docs/RESEARCH.md) §5 for the design
rationale (chain-agnostic listings, integrity hash, payload schema).

## ENS text record cross-correlation

When an ENS name's resolver sets a text record under the key
`eth.efp.list`, that value points at the list NFT the owner wants
associated with that ENS name. The plugin upserts a row into
`efp_ens_list_pointers` keyed by `(chain_id, resolver, node, ens_key)`
so consumers can join against ENSNode's `subgraph_domain` / `domain`
tables on the `node` column.

Accepted values:

- A decimal token id (`"1234"`) — interpreted on the default EFP
  `ListRegistry` (Base, chain id 8453).
- A CAIP-19 asset identifier
  (`"eip155:8453/erc721:0x0E68…4e08/1234"`) — explicit chain id,
  contract address, and token id. Lets future EFP registries on other
  chains coexist without an ABI break.

The handler also deletes the pointer when the text record is set to an
empty string or to an unparseable value, matching the ENS convention.

The `indexedKey` topic on `TextChanged` lets Ponder pre-filter at the
RPC level to `keccak256("eth.efp.list")`, so we never receive
unrelated text-record events.

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

7. (Optional) Run the OfflineListSyncer as a sidecar process pointing
   at the same ENSDb database — see `src/offline/syncer.ts`.
```

See [`src/dropin/README.md`](./src/dropin/README.md) for the line-by-line
commentary on why a few imports inside `dropin/*.ts` use
`@ts-expect-error` until the files are moved into ENSIndexer.

## Verification

```sh
pnpm install
pnpm --filter @efpnode/ensnode-plugin-efp test       # 72 unit tests
pnpm --filter @efpnode/ensnode-plugin-efp typecheck  # tsc --noEmit
pnpm --filter @efpnode/example-standalone-ponder smoke       # live RPC backfill
pnpm --filter @efpnode/example-standalone-ponder exec tsx scripts/offline-demo.ts  # offline syncer e2e
```

A recent smoke run over ~20,000 blocks per chain near tip produced two
list NFTs, fourteen address records, and two `primary-list` account
metadata rows — all from real onchain activity. The offline demo seeded
a synthetic offline list and verified the syncer reconciles 3 records,
1 tag, and user+manager metadata end-to-end with the URL-hash check,
JSON validation, and metadata override paths all exercised.
