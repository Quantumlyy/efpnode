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

## 5. Verifying the plugin without forking ENSNode

`examples/standalone-ponder/` provides a minimal Ponder app that consumes the
plugin's ABIs, contract addresses, and event handlers directly. It uses a local
in-memory PGlite database and the public RPC of each chain, which lets us run
`ponder dev` against the live EFP contracts and confirm that:

- The schema migrates cleanly.
- Event handlers register for the expected `efp/<Contract>:<Event>` keys.
- `parseListOp` and `parseListStorageLocation` agree with the api-v2 reference.
