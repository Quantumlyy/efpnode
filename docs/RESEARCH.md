# Research: an ENSNode plugin for the Ethereum Follow Protocol (EFP)

This document captures the findings used to design `@efpnode/ensnode-plugin-efp` and
the design choices for letting ENSNode operators run a single unified node that also
indexes EFP.

Primary sources:

- ENSNode monorepo — <https://github.com/namehash/ensnode>
- "Creating a Plugin" docs — <https://ensnode.io/docs/services/ensindexer/contributing/creating-a-plugin>
- EFP api-v2 reference indexer — <https://github.com/ethereumfollowprotocol/api-v2>

## 1. ENSNode plugin model in one paragraph

ENSIndexer plugins are TypeScript modules under
`apps/ensindexer/src/plugins/<name>/` with two required entry points:

- `plugin.ts` — a default export from `createPlugin({ name, requiredDatasourceNames,
  allDatasourceNames, createPonderConfig })`. The `createPonderConfig(config)` function
  returns a Ponder `createConfig(...)` object describing the chains and contracts to
  index.
- `event-handlers.ts` — a default-exported function that, when called, registers
  Ponder event handlers via `addOnchainEventListener("<plugin>/<contract>:<event>", fn)`.

Activation is gated by:

1. Membership of the plugin name in the `PluginName` enum
   (`packages/ensnode-sdk/src/ensindexer/config/types.ts`).
2. Inclusion of the plugin's default export in `ALL_PLUGINS` in
   `apps/ensindexer/src/plugins/index.ts`.
3. Wiring of `event-handlers.ts` into
   `apps/ensindexer/ponder/src/register-handlers.ts`, guarded by
   `config.plugins.includes(PluginName.X)`.

The Ponder Schema is re-exported from `@ensnode/ensdb-sdk/ensindexer-abstract`
(`apps/ensindexer/ponder/ponder.schema.ts`). New tables for a plugin live in
`packages/ensdb-sdk/src/ensindexer-abstract/<plugin>.schema.ts` and are added to
the abstract schema barrel.

Plugins call `namespaceContract(pluginName, "ContractName")` to produce a unique
ponder contract key (e.g. `"efp/ListRecords"`), which keeps multiple plugins'
ABIs from colliding.

## 2. EFP onchain surface area

EFP's onchain state lives in three contracts (per `services/shared/src/config/index.ts`
of api-v2):

| Contract        | Chain               | Address                                       |
|-----------------|---------------------|-----------------------------------------------|
| ListRegistry    | Base (8453)         | `0x0E688f5DCa4a0a4729946ACbC44C792341714e08`  |
| AccountMetadata | Base (8453)         | `0x5289fE5daBC021D02FDDf23d4a4DF96F4E0F17EF`  |
| ListRecords     | Base (8453)         | `0x41Aa48Ef3c0446b46a5b1cc6337FF3d3716E2A33`  |
| ListRecords     | Optimism (10)       | `0x4Ca00413d850DcFa3516E14d21DAE2772F2aCb85`  |
| ListRecords     | Ethereum (1)        | `0x5289fE5daBC021D02FDDf23d4a4DF96F4E0F17EF`  |

Deployment block ranges used by the reference indexer:

| Chain    | Start block  |
|----------|--------------|
| Base     | `20180000`   |
| Optimism | `125792000`  |
| Mainnet  | `20820000`   |

### Relevant events

```solidity
// ListRegistry (ERC-721 + EFP extension)
event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
event UpdateListStorageLocation(uint256 indexed tokenId, bytes listStorageLocation);
event UpdateUser(uint256 indexed tokenId, address indexed user);
event UpdateManager(uint256 indexed tokenId, address indexed manager);

// AccountMetadata
event UpdateAccountMetadata(address indexed addr, string key, bytes value);

// ListRecords (deployed on Base, Optimism, Ethereum)
event ListOp(uint256 indexed slot, bytes op);
event UpdateListMetadata(uint256 indexed slot, string key, bytes value);
```

Notes:

- The slot is emitted as `uint256` (api-v2 zero-pads it to `bytes32` for storage).
- `op` is a packed structure: `version (1) | opcode (1) | data (variable)`.
- For address-record adds (`recordType == 1`), `data` is
  `version (1) | type (1) | address (20)`. Users sometimes append junk after the
  20-byte address; the api-v2 indexer truncates to 20 bytes, and we mirror that.
- List Storage Location: `version (1) | locationType (1) | chainId (32) |
  contractAddress (20) | slot (32)` — 86 bytes total.

### Opcodes

| Opcode | Meaning       |
|--------|---------------|
| 1      | Add record    |
| 2      | Remove record |
| 3      | Add tag       |
| 4      | Remove tag    |

The `UpdateListMetadata` event has two well-known keys today: `user` (delegated
user address) and `manager` (manager address). Both store a 20-byte address in
the `value` payload.

## 3. Design choices for the plugin

The plugin lives at `packages/ensnode-plugin-efp/`. It is shaped so its `src/`
tree can be dropped into `apps/ensindexer/src/plugins/efp/` in an ensindexer
checkout with no path changes, while still being installable as a workspace
package for the standalone Ponder example.

Key choices:

1. **Plugin name**: `efp` (would be added to `PluginName` enum upstream).
2. **No new ENS datasource entries**: EFP does not interact with ENS contracts
   and ENSNode's `DatasourceName` taxonomy is ENS-protocol-specific. The plugin
   therefore inlines its contract metadata under `src/constants.ts` and builds
   chain configs directly from the ensindexer-supplied `rpcConfigs`, mirroring
   how plugins like `tokenscope` build per-chain config. `requiredDatasourceNames`
   is intentionally an empty tuple so the plugin can run on any ENS namespace
   (mainnet only — Sepolia and devnet have no EFP deployment).
3. **Schema namespacing**: All tables are prefixed `efp_` to avoid collisions
   with existing ENSDb tables. The abstract schema file is provided at
   `src/schema.ts` and is intended to be added to
   `packages/ensdb-sdk/src/ensindexer-abstract/efp.schema.ts` (and re-exported
   from that package's index).
4. **Ponder contract keys**: All keys are produced by `namespaceContract("efp",
   "<Name>")` and resolve to e.g. `efp/ListRegistry`, `efp/AccountMetadata`,
   `efp/ListRecords`. ListRecords is a single multi-chain contract (one ABI,
   three deployments) which is how Ponder prefers to express the multi-chain
   case.
5. **ListOp parsing**: The packed binary format is parsed in pure-TS helpers
   (`src/lib/parse-list-op.ts`) that are unit-tested without a database. The
   handlers use viem typings and stay free of raw SQL.
6. **Race conditions**: The api-v2 indexer stages list metadata into
   `pending_list_metadata` when the corresponding list row has not yet been
   created (because metadata can land before the matching `UpdateListStorageLocation`).
   In Ponder we have the same risk because events from different chains are not
   guaranteed to interleave deterministically with respect to a single token. We
   reproduce the staging table (`efp_pending_list_metadata`) verbatim. When
   `UpdateListStorageLocation` runs we drain matching pending rows.

## 4. How this becomes a unified node

Operators who want a single process indexing ENS + EFP would:

1. Patch `PluginName` to add `EFP = "efp"` in `@ensnode/ensnode-sdk`.
2. Drop `packages/ensnode-plugin-efp/src/` into
   `apps/ensindexer/src/plugins/efp/`.
3. Drop `src/schema.ts` into
   `packages/ensdb-sdk/src/ensindexer-abstract/efp.schema.ts` and re-export it
   from that package's `index.ts`.
4. Register the plugin in `apps/ensindexer/src/plugins/index.ts` (`ALL_PLUGINS`).
5. Register handlers in `apps/ensindexer/ponder/src/register-handlers.ts` behind
   `config.plugins.includes(PluginName.EFP)`.
6. Run ENSIndexer with `PLUGINS=subgraph,efp` (or any combination including
   `efp`).

The drop-in files in `packages/ensnode-plugin-efp/src/` are deliberately
import-symmetric with the existing plugins so step 2-5 are mechanical.

## 5. Offline list storage location (`locationType = 2`)

EFP's onchain List Storage Location currently only covers EVM-onchain
backends (`locationType = 1`). The plugin extends the encoding with a second
`locationType` so a list owner can publish their records at an HTTP(S) URL
instead, and we index that URL on an interval. This reuses the existing
`UpdateListStorageLocation` event shape so a list can switch between onchain
and offline storage without any new contracts or events.

### Wire format

```
listStorageLocation := version (1)            // == 0x01
                     | locationType (1)       // == 0x02 (offline / HTTP)
                     | chainId (32)           // big-endian uint256, == 0 for unbound
                     | urlHash (32)           // keccak256(utf8(url)) — anchor for integrity
                     | url (variable, UTF-8)  // tail
```

Reasoning:

- The first four bytes still match `locationType == 1`'s prefix, so a
  generic decoder can read `version` and `locationType` consistently before
  dispatching.
- `chainId == 0` declares the list as "chain-agnostic" — the records are
  application-defined and aren't bound to any EVM chain id. A future
  evolution could encode a "primary chain hint" here for analytics.
- `urlHash` is a `keccak256(utf8(url))` digest committed onchain alongside
  the URL bytes. The syncer uses it to detect tampering by an attacker who
  controls a mid-path proxy or who deploys a different LSL than the one the
  user signed for: if `keccak256(url_bytes_from_chain) != urlHash`, the
  payload is rejected. This is cheap to verify and avoids a separate
  signature scheme.
- The URL is UTF-8 encoded and must use the `https://` scheme. The syncer
  refuses `http://`, `data:`, `file:`, etc.

### Response format

The URL must respond with `Content-Type: application/json` and a body
matching:

```jsonc
{
  "version": 1,                              // payload schema version
  "tokenId": "1234",                         // list NFT this payload claims
  "records": [
    {
      "version": 1,                          // record encoding version
      "recordType": 1,                       // 1 = address
      "data": "0xae20540...",
      "tags": ["close-friend"]               // optional
    }
  ],
  "metadata": {
    "user":    "0x...",                      // optional, overrides onchain
    "manager": "0x..."                       // optional, overrides onchain
  }
}
```

The syncer reconciles `efp_list_records` and `efp_list_record_tags` for the
list's deterministic offline slot
`slot = keccak256("efp-offline" || tokenId-as-uint256)`, with
`chain_id = 0` and `contract_address = 0x000…000`. This guarantees no clash
with onchain slots, lets the same `efp_list_records` table store both, and
means downstream readers join exactly as they do today
(`(chain_id, contract_address, slot, record)`).

### Sync schedule

`efp_offline_lists` tracks one row per offline list with:

- `token_id`, `url`, `url_hash`
- `etag` (HTTP ETag from the last successful fetch — sent as `If-None-Match`)
- `last_modified` (HTTP Last-Modified — sent as `If-Modified-Since`)
- `last_synced_at`, `last_synced_status`
  (`ok` / `not_modified` / `error_<reason>`)
- `next_sync_at` (when the syncer is allowed to try again)
- `consecutive_failures` (exponential backoff:
  `delay = min(base * 2^n, max)`)

The default cadence is every 10 minutes, with a 5-second per-list HTTP
timeout, a 2 MiB max body, and exponential backoff from 10 s to 30 min on
failure.

### Why offline lives next to the event handlers, not inside them

Ponder event handlers only run on EVM logs. Offline lists need:

- a periodic timer independent of the chain head
- outbound HTTP, which Ponder discourages from the indexing hot path
- the ability to operate even when the chain is fully caught up

The plugin therefore ships a standalone `OfflineListSyncer` class that
takes an `EFPStore` and a `fetch` implementation. The standalone Ponder
example runs it via `pnpm exec tsx scripts/offline-sync.ts`. In an
ENSIndexer deployment, the syncer is intended to be wired up as a sidecar
process by the operator — the ENSIndexer itself stays single-purpose.

## 6. ENS text record cross-correlation

When an ENS name's resolver sets a text record under the key
`eth.efp.list`, that value points at the list NFT the owner wants
associated with that ENS name. By indexing that text record we can answer
"what list does `vitalik.eth` use?" without out-of-band joins.

The plugin listens for `Resolver.TextChanged(node, indexedKey, key, value)`
events filtered to `indexedKey == keccak256("eth.efp.list")`. Because
`indexedKey` is an `indexed string` topic, viem / Ponder reduce the filter
to a single topic match — we never receive `TextChanged` events for other
keys.

Accepted value formats:

1. A decimal token id (`"1234"`) — interpreted as a list on the default EFP
   `ListRegistry` (Base, chain id 8453).
2. A CAIP-19 asset identifier
   (`"eip155:8453/erc721:0x0E68…4e08/1234"`) — explicit chain id, contract
   address, and token id. Lets future EFP registries (e.g. on other chains)
   coexist without an ABI break.

We store the parsed result in `efp_ens_list_pointers`:

```
(chain_id, resolver, node, ens_key, list_token_id, list_contract, list_chain_id)
```

with `node` being the ENS namehash so it joins directly against ENSNode's
`subgraph_domain` / `domain` tables when the `subgraph` plugin is enabled.

A pointer is upserted on each `TextChanged` event and deleted when the
value is empty (`""`), matching the ENS convention that an empty text
record is equivalent to an unset record.

## 7. Verifying the plugin without forking ENSNode

`examples/standalone-ponder/` provides a minimal Ponder app that consumes
the plugin's ABIs, contract addresses, and event handlers directly. It
uses a local in-memory PGlite database and the public RPC of each chain,
which lets us run `ponder dev` against the live EFP contracts and confirm
that:

- The schema migrates cleanly.
- Event handlers register for the expected `efp/<Contract>:<Event>` keys.
- `parseListOp` and `parseListStorageLocation` agree with the api-v2
  reference.
- The offline syncer reconciles `efp_list_records` against a payload
  served by a local mock HTTP server.
- The ENS text record handler upserts `efp_ens_list_pointers` rows.
